const fs   = require('fs');
const path = require('path');

const BIND     = process.env.OBSERVER_BIND     || '127.0.0.1';
const UI_PORT  = Number(process.env.OBSERVER_UI_PORT) || 3000;
const WS_PORT  = Number(process.env.OBSERVER_WS_PORT) || 3001;
const NC_PORT  = Number(process.env.OBSERVER_NC_PORT) || 3002;
const WS_TOKEN = process.env.OBSERVER_WS_TOKEN || '';

// Auth file written by setup.sh: one line — "username:$6$salt$hash"
// Falls back to OBSERVER_USER/OBSERVER_PASS env vars if the file is absent
const AUTH_FILE = process.env.OBSERVER_AUTH_FILE || '/home/nomadai/.observer_auth';

const OPEN_DIR      = path.resolve(__dirname, '../../open');
const THOUGHTS_LOG  = path.join(OPEN_DIR, 'thoughts.log');
const GOALS_FILE    = path.join(OPEN_DIR, 'goals.json');
const LT_FILE       = path.join(OPEN_DIR, 'memory/longTerm.json');
const EP_FILE       = path.join(OPEN_DIR, 'memory/episodic.json');
const SNAPSHOTS_DIR = path.join(OPEN_DIR, 'snapshots');

// ── Auth config ───────────────────────────────────────────────────────────────
// Loaded once at start() — not hot-reloaded
let AUTH = null;

function loadAuth() {
  try {
    const line = fs.readFileSync(AUTH_FILE, 'utf8').trim();
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error('bad format');
    return { user: line.slice(0, colon), hash: line.slice(colon + 1) };
  } catch (_) {
    // Fallback to env vars — plaintext comparison only
    return {
      user: process.env.OBSERVER_USER || 'nomad',
      hash: null,
      plainPass: process.env.OBSERVER_PASS || 'nomad',
    };
  }
}

// Verify password against a Linux shadow hash ($6$... SHA-512 crypt)
// by spawning: openssl passwd -6 -salt <salt> <password>
// Returns a Promise<boolean>
async function verifyShadowHash(inputPass, storedHash) {
  // Parse: $id$[rounds=N$]salt$hash
  // parts after splitting on '$' with filter(Boolean): ['6', [rounds,] salt, hash]
  const parts = storedHash.split('$').filter(Boolean);
  if (parts.length < 3) return false;

  // Reconstruct the salt argument openssl expects (just the salt portion, no id/hash)
  let saltArg;
  if (parts[1].startsWith('rounds=')) {
    saltArg = `${parts[1]}$${parts[2]}`;
  } else {
    saltArg = parts[1];
  }

  const proc = Bun.spawn(
    ['openssl', 'passwd', '-6', '-salt', saltArg, inputPass],
    { stdout: 'pipe', stderr: 'pipe' }
  );

  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim() === storedHash;
}

async function checkPassword(inputUser, inputPass) {
  if (inputUser !== AUTH.user) return false;

  if (AUTH.hash) {
    // System shadow hash — verify via openssl
    try {
      return await verifyShadowHash(inputPass, AUTH.hash);
    } catch (_) {
      return false;
    }
  }

  // Fallback plaintext (env-var mode)
  return inputPass === AUTH.plainPass;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Per remote IP: track failures within a sliding window
const RATE = {
  MAX_ATTEMPTS : 5,           // failures before block
  WINDOW_MS    : 60_000,      // sliding window
  BLOCK_MS     : 5 * 60_000,  // block duration after MAX_ATTEMPTS
  DELAY_MS     : 1_000,       // extra delay per failed attempt within window
};

// ip -> { attempts: [{ts}], blockedUntil: number }
const ratemap = new Map();

function getRateEntry(ip) {
  if (!ratemap.has(ip)) ratemap.set(ip, { attempts: [], blockedUntil: 0 });
  return ratemap.get(ip);
}

// Returns { allowed: boolean, retryAfterMs?: number, delayMs?: number }
function rateCheck(ip) {
  const now = Date.now();
  const entry = getRateEntry(ip);

  if (entry.blockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  }

  // Prune attempts outside window
  entry.attempts = entry.attempts.filter(a => now - a.ts < RATE.WINDOW_MS);

  if (entry.attempts.length >= RATE.MAX_ATTEMPTS) {
    entry.blockedUntil = now + RATE.BLOCK_MS;
    return { allowed: false, retryAfterMs: RATE.BLOCK_MS };
  }

  return { allowed: true, delayMs: entry.attempts.length * RATE.DELAY_MS };
}

function rateRecordFailure(ip) {
  const entry = getRateEntry(ip);
  entry.attempts.push({ ts: Date.now() });
}

function rateRecordSuccess(ip) {
  // Clear on successful auth
  ratemap.delete(ip);
}

// ── Recent event buffer (replayed to new stream subscribers) ─────────────────
const EVENT_BUFFER_SIZE = 10;
const recentEvents = [];

function bufferEvent(event) {
  recentEvents.push(event);
  if (recentEvents.length > EVENT_BUFFER_SIZE) recentEvents.shift();
}

// ── WebSocket clients ─────────────────────────────────────────────────────────
const wsClients = new Set();

// ── NC sessions ───────────────────────────────────────────────────────────────
const ncSessions = new Map();
const AUTH_TIMEOUT_MS = 30_000;

// ── Event formatting ──────────────────────────────────────────────────────────
function formatEvent(event) {
  const ts  = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const typ = String(event.type).padEnd(14);
  let body  = typeof event.data === 'object'
    ? JSON.stringify(event.data)
    : String(event.data ?? '');
  if (body.length > 200) body = body.slice(0, 197) + '...';
  return `[${ts}] [${typ}] ${body}\r\n`;
}

// ── Broadcast ─────────────────────────────────────────────────────────────────
function broadcast(event) {
  bufferEvent(event);

  const msg = JSON.stringify(event);
  for (const ws of wsClients) {
    try { ws.send(msg); } catch (_) {}
  }

  const line = formatEvent(event);
  for (const [sock, sess] of ncSessions) {
    if (!sess.authed || !sess.streaming) continue;
    if (sess.filter && !event.type.includes(sess.filter)) continue;
    try {
      ncWrite(sess,line);
    } catch (_) {
      // Socket died — clean up so it doesn't accumulate
      clearTimeout(sess.authTimer);
      ncSessions.delete(sock);
    }
  }
}

// Safe write helper — swallows errors so a dead socket doesn't throw
function ncWrite(sess, data) {
  try { ncWrite(sess,data); } catch (_) {}
}

// ── NC command handler ────────────────────────────────────────────────────────
async function handleCommand(sess, raw) {
  const line = raw.trim();
  if (!line) { ncWrite(sess,'> '); return; }

  const [cmd, ...rest] = line.split(' ');
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {

    case 'stream': {
      sess.streaming = true;
      sess.filter = arg || null;
      // Replay recent buffered events so the screen isn't blank on connect
      const replay = arg
        ? recentEvents.filter(e => e.type.includes(arg))
        : recentEvents.slice();
      if (replay.length) {
        ncWrite(sess,`[stream] --- last ${replay.length} buffered event(s) ---\r\n`);
        for (const e of replay) ncWrite(sess,formatEvent(e));
        ncWrite(sess,'[stream] --- live ---\r\n');
      }
      ncWrite(sess,
        arg
          ? `[stream] Live stream started (filter: ${arg}). Type "stop" to end.\r\n`
          : `[stream] Live stream started (all events). Type "stop" to end.\r\n`
      );
      break;
    }

    case 'stop':
      sess.streaming = false;
      sess.filter = null;
      ncWrite(sess,'[stream] Stopped.\r\n> ');
      break;

    case 'status': {
      const u = process.uptime();
      const h = Math.floor(u / 3600);
      const m = Math.floor((u % 3600) / 60);
      const s = Math.floor(u % 60);
      let memCount = 0;
      try { memCount = Object.keys(JSON.parse(fs.readFileSync(LT_FILE, 'utf8'))).length; } catch (_) {}
      let snapCount = 0;
      try { snapCount = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).length; } catch (_) {}
      ncWrite(sess,
        `[status] uptime=${h}h${m}m${s}s  ws=${wsClients.size}  nc=${ncSessions.size}  memory_keys=${memCount}  snapshots=${snapCount}\r\n> `
      );
      break;
    }

    case 'goals': {
      let goals = [];
      try { goals = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) {}
      if (!goals.length) { ncWrite(sess,'[goals] (none)\r\n> '); break; }
      for (const g of goals)
        ncWrite(sess,`[goals] [${g.priority}] ${g.goal}  (${g.createdAt})\r\n`);
      ncWrite(sess,'> ');
      break;
    }

    case 'memory': {
      let lt = {};
      try { lt = JSON.parse(fs.readFileSync(LT_FILE, 'utf8')); } catch (_) {}
      if (!arg) {
        // List all keys
        const keys = Object.keys(lt);
        if (!keys.length) { ncWrite(sess,'[memory] (empty)\r\n> '); break; }
        for (const k of keys)
          ncWrite(sess,`[memory] ${k}  (updated: ${lt[k].updatedAt || '?'})\r\n`);
        ncWrite(sess,'> ');
        break;
      }
      const entry = lt[arg];
      if (!entry) { ncWrite(sess,`[memory] Key not found: ${arg}\r\n> `); break; }
      ncWrite(sess,`[memory] ${arg} = ${JSON.stringify(entry.value)}  (tags: ${(entry.tags || []).join(', ') || 'none'})\r\n> `);
      break;
    }

    case 'modules': {
      // Read modules dir listing as a proxy — loaded state is in-process
      let mods = [];
      try { mods = fs.readdirSync(path.join(OPEN_DIR, 'modules')).filter(f => f.endsWith('.js') && f !== 'example.js'); } catch (_) {}
      if (!mods.length) { ncWrite(sess,'[modules] (none written yet)\r\n> '); break; }
      for (const m of mods) ncWrite(sess,`[modules] ${m}\r\n`);
      ncWrite(sess,'> ');
      break;
    }

    case 'snapshot': {
      // Trigger a snapshot via the versionManager directly
      try {
        const vm = require('../core/versionManager');
        const result = await vm.snapshot('observer-manual');
        if (result.ok) {
          ncWrite(sess,`[snapshot] Created: ${result.result.id}\r\n> `);
        } else {
          ncWrite(sess,`[snapshot] Failed: ${result.error}\r\n> `);
        }
      } catch (e) {
        ncWrite(sess,`[snapshot] Error: ${e.message}\r\n> `);
      }
      break;
    }

    case 'thoughts': {
      const n = parseInt(arg) || 20;
      let lines = [];
      try { lines = fs.readFileSync(THOUGHTS_LOG, 'utf8').split('\n').filter(Boolean); } catch (_) {}
      const tail = lines.slice(-n);
      if (!tail.length) { ncWrite(sess,'[thoughts] (empty)\r\n> '); break; }
      for (const l of tail) ncWrite(sess,l + '\r\n');
      ncWrite(sess,'> ');
      break;
    }

    case 'history': {
      const n = parseInt(arg) || 10;
      let ep = [];
      try { ep = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); } catch (_) {}
      const tail = ep.slice(-n);
      if (!tail.length) { ncWrite(sess,'[history] (empty)\r\n> '); break; }
      for (const e of tail) {
        const argsStr = Object.keys(e.args || {}).length ? ' ' + JSON.stringify(e.args) : '';
        ncWrite(sess,`[history] ${e.ts}  ${e.tool}${argsStr}  ok=${e.ok}\r\n`);
      }
      ncWrite(sess,'> ');
      break;
    }

    case 'who': {
      ncWrite(sess,`[who] WebSocket clients: ${wsClients.size}\r\n`);
      let i = 1;
      for (const [, s] of ncSessions) {
        const state = s.authed ? (s.streaming ? 'streaming' : 'idle') : 'authenticating';
        ncWrite(sess,`[who] NC #${i++}: ${s.remoteAddr}  [${state}]\r\n`);
      }
      ncWrite(sess,'> ');
      break;
    }

    case 'clear':
      ncWrite(sess,'\x1b[2J\x1b[H> ');
      break;

    case 'help':
      ncWrite(sess,
        '\r\nAvailable commands:\r\n' +
        '  stream [filter]   Live event stream. Optional type filter (e.g. "stream thought")\r\n' +
        '  stop              Stop stream, return to prompt\r\n' +
        '  status            Agent uptime, connections, memory and snapshot counts\r\n' +
        '  goals             Current AI goals\r\n' +
        '  memory [key]      List all memory keys, or read a specific key\r\n' +
        '  modules           List AI-written modules in open/modules/\r\n' +
        '  snapshot          Trigger a manual snapshot of open/\r\n' +
        '  thoughts [n]      Last n lines from thoughts.log (default 20)\r\n' +
        '  history [n]       Last n episodic tool calls (default 10)\r\n' +
        '  who               Show active observer connections\r\n' +
        '  clear             Clear the terminal screen\r\n' +
        '  quit              Disconnect\r\n\r\n> '
      );
      break;

    case 'quit':
    case 'exit':
      ncWrite(sess,'Goodbye.\r\n');
      try { sess.socket.end(); } catch (_) {}
      break;

    default:
      ncWrite(sess,`[error] Unknown command: ${cmd}. Type "help".\r\n> `);
  }
}

// ── Auth state machine ─────────────────────────────────────────────────────────
async function handleAuthData(sess, chunk) {
  sess.buf = (sess.buf || '') + chunk.toString();
  const lines = sess.buf.split('\n');
  sess.buf = lines.pop();

  for (const raw of lines) {
    const val = raw.replace(/\r/g, '').trim();

    if (sess.step === 'user') {
      // Support "user:password" on the username line to skip the password prompt
      const colonIdx = val.indexOf(':');
      const hasInlinePass = colonIdx !== -1;
      sess.inputUser = hasInlinePass ? val.slice(0, colonIdx) : val;
      const inlinePass = hasInlinePass ? val.slice(colonIdx + 1) : null;

      if (hasInlinePass) {
        // Authenticate immediately with the inline password
        const ip    = sess.remoteAddr;
        const check = rateCheck(ip);
        if (!check.allowed) {
          const secs = Math.ceil(check.retryAfterMs / 1000);
          ncWrite(sess, `Authentication failed. Too many attempts — try again in ${secs}s.\r\n`);
          try { sess.socket.end(); } catch (_) {}
          return;
        }
        if (check.delayMs > 0) await new Promise(r => setTimeout(r, check.delayMs));

        const ok = await checkPassword(sess.inputUser, inlinePass);
        if (ok) {
          rateRecordSuccess(ip);
          sess.authed = true;
          sess.step = 'ready';
          sess.buf = '';
          clearTimeout(sess.authTimer);
          ncWrite(sess,
            `\r\nWelcome to NomadAI Observer  [${new Date().toLocaleString()}]\r\n` +
            'Type "help" for commands, "stream" to start live feed.\r\n\r\n> '
          );
        } else {
          rateRecordFailure(ip);
          const remaining = RATE.MAX_ATTEMPTS - getRateEntry(ip).attempts.length;
          if (remaining > 0) {
            ncWrite(sess, `Authentication failed. ${remaining} attempt(s) remaining.\r\nUsername: `);
            sess.step = 'user';
            sess.inputUser = '';
          } else {
            const secs = Math.ceil(RATE.BLOCK_MS / 1000);
            ncWrite(sess, `Authentication failed. Blocked for ${secs}s.\r\n`);
            try { sess.socket.end(); } catch (_) {}
          }
        }
      } else {
        // Normal flow — ask for password separately
        sess.step = 'pass';
        // Reset the auth timer so the full window is available for password entry
        clearTimeout(sess.authTimer);
        sess.authTimer = setTimeout(() => {
          if (!sess.authed) {
            try { sess.socket.write('Authentication timeout.\r\n'); } catch (_) {}
            try { sess.socket.end(); } catch (_) {}
          }
        }, AUTH_TIMEOUT_MS);
        ncWrite(sess, 'Password: ');
      }

    } else if (sess.step === 'pass') {
      // Rate-limit check before doing any password work
      const ip    = sess.remoteAddr;
      const check = rateCheck(ip);

      if (!check.allowed) {
        const secs = Math.ceil(check.retryAfterMs / 1000);
        ncWrite(sess,`Authentication failed. Too many attempts — try again in ${secs}s.\r\n`);
        try { sess.socket.end(); } catch (_) {}
        return;
      }

      // Progressive delay to slow brute force
      if (check.delayMs > 0) {
        await new Promise(r => setTimeout(r, check.delayMs));
      }

      const ok = await checkPassword(sess.inputUser, val);

      if (ok) {
        rateRecordSuccess(ip);
        sess.authed = true;
        sess.step = 'ready';
        sess.buf = '';
        clearTimeout(sess.authTimer);
        ncWrite(sess,
          `\r\nWelcome to NomadAI Observer  [${new Date().toLocaleString()}]\r\n` +
          'Type "help" for commands, "stream" to start live feed.\r\n\r\n> '
        );
      } else {
        rateRecordFailure(ip);
        const remaining = RATE.MAX_ATTEMPTS - getRateEntry(ip).attempts.length;
        if (remaining > 0) {
          ncWrite(sess,`Authentication failed. ${remaining} attempt(s) remaining.\r\n`);
          // Let them retry
          sess.step = 'user';
          sess.inputUser = '';
          ncWrite(sess,'Username: ');
        } else {
          const secs = Math.ceil(RATE.BLOCK_MS / 1000);
          ncWrite(sess,`Authentication failed. Blocked for ${secs}s.\r\n`);
          try { sess.socket.end(); } catch (_) {}
        }
      }
    }
  }
}

// ── TCP server ─────────────────────────────────────────────────────────────────
let ncServer  = null;
let uiServer  = null;
let wsServer  = null;

function startNcServer() {
  ncServer = Bun.listen({
    hostname: BIND,
    port: NC_PORT,
    socket: {
      open(socket) {
        const remoteAddr = socket.remoteAddress || 'unknown';
        const check = rateCheck(remoteAddr);

        if (!check.allowed) {
          const secs = Math.ceil(check.retryAfterMs / 1000);
          try { socket.write(`Blocked. Too many failed attempts — try again in ${secs}s.\r\n`); } catch (_) {}
          try { socket.end(); } catch (_) {}
          return;
        }

        const sess = {
          socket,
          remoteAddr,
          authed: false,
          step: 'user',
          buf: '',
          streaming: false,
          filter: null,
          inputUser: '',
          authTimer: setTimeout(() => {
            if (!sess.authed) {
              try { socket.write('Authentication timeout.\r\n'); } catch (_) {}
              try { socket.end(); } catch (_) {}
            }
          }, AUTH_TIMEOUT_MS),
        };
        ncSessions.set(socket, sess);
        try { socket.write('Username: '); } catch (_) {}
      },

      data(socket, chunk) {
        const sess = ncSessions.get(socket);
        if (!sess) return;

        if (!sess.authed) {
          handleAuthData(sess, chunk);
          return;
        }

        sess.buf = (sess.buf || '') + chunk.toString();
        const lines = sess.buf.split('\n');
        sess.buf = lines.pop();

        for (const raw of lines) {
          const line = raw.replace(/\r/g, '').trim();
          if (!line) continue;
          if (sess.streaming && line.toLowerCase() !== 'stop') continue;
          handleCommand(sess, line).catch(() => {});
        }
      },

      close(socket) {
        const sess = ncSessions.get(socket);
        if (sess) clearTimeout(sess.authTimer);
        ncSessions.delete(socket);
      },

      error(socket) {
        ncSessions.delete(socket);
      },
    },
  });

}

// ── HTTP UI + WebSocket ───────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>NomadAI Observer</title>
  <style>
    body { background: #0d0d0d; color: #e0e0e0; font-family: monospace; display: flex; gap: 12px; padding: 12px; height: 100vh; box-sizing: border-box; margin: 0; }
    .panel { flex: 1; display: flex; flex-direction: column; }
    h3 { margin: 0 0 6px; color: #7ec8e3; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; }
    .scroll { flex: 1; overflow-y: auto; background: #111; border: 1px solid #222; padding: 8px; font-size: 12px; line-height: 1.6; }
    .entry { border-bottom: 1px solid #1a1a1a; padding: 4px 0; }
    .ts { color: #555; margin-right: 6px; }
    .type { color: #f0a500; margin-right: 6px; }
    .thought .type { color: #7ec8e3; }
    .tool_call .type { color: #a8ff78; }
    .blocked_action .type { color: #ff5e5e; }
    .error .type { color: #ff5e5e; font-weight: bold; }
    .memory_update .type { color: #c792ea; }
    #status { position: fixed; top: 8px; right: 12px; font-size: 11px; color: #555; }
    #status.connected { color: #a8ff78; }
  </style>
</head>
<body>
  <div id="status">disconnected</div>
  <div class="panel"><h3>Thought Stream</h3><div class="scroll" id="thoughts"></div></div>
  <div class="panel"><h3>Command Log</h3><div class="scroll" id="commands"></div></div>
  <div class="panel"><h3>Memory / State</h3><div class="scroll" id="memory"></div></div>
  <script>
    const thoughtPanel = document.getElementById('thoughts');
    const commandPanel = document.getElementById('commands');
    const memoryPanel  = document.getElementById('memory');
    const statusEl     = document.getElementById('status');
    const THOUGHT_TYPES = new Set(['thought','plan','boot']);
    const COMMAND_TYPES = new Set(['tool_call','tool_result','blocked_action','restart_request','error','shutdown']);
    const MEMORY_TYPES  = new Set(['memory_update','module_load','module_unload']);
    function addEntry(panel, event) {
      const el = document.createElement('div');
      el.className = 'entry ' + event.type;
      const ts = new Date().toLocaleTimeString();
      el.innerHTML = '<span class="ts">'+ts+'</span><span class="type">['+event.type+']</span>'+(typeof event.data==='object'?JSON.stringify(event.data):event.data);
      panel.appendChild(el);
      panel.scrollTop = panel.scrollHeight;
    }
    const WS_TOKEN = '${WS_TOKEN}';
    function connect() {
      const url = 'ws://'+location.hostname+':${WS_PORT}' + (WS_TOKEN ? '?token='+encodeURIComponent(WS_TOKEN) : '');
      const ws = new WebSocket(url);
      ws.onopen  = () => { statusEl.textContent='connected';    statusEl.className='connected'; };
      ws.onclose = (e) => {
        statusEl.textContent = e.code === 4401 ? 'auth failed' : 'disconnected';
        statusEl.className='';
        if (e.code !== 4401) setTimeout(connect,2000);
      };
      ws.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if      (THOUGHT_TYPES.has(ev.type)) addEntry(thoughtPanel,ev);
          else if (COMMAND_TYPES.has(ev.type)) addEntry(commandPanel,ev);
          else if (MEMORY_TYPES.has(ev.type))  addEntry(memoryPanel,ev);
          else                                  addEntry(commandPanel,ev);
        } catch(_) {}
      };
    }
    connect();
  </script>
</body>
</html>`;

function start() {
  if (uiServer && wsServer && ncServer) return;

  AUTH = loadAuth();

  uiServer = Bun.serve({
    hostname: BIND,
    port: UI_PORT,
    fetch(req) {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
    },
  });

  wsServer = Bun.serve({
    hostname: BIND,
    port: WS_PORT,
    fetch(req, server) {
      // Token auth: ?token=... in the upgrade request URL
      if (WS_TOKEN) {
        const url = new URL(req.url);
        if (url.searchParams.get('token') !== WS_TOKEN) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      if (server.upgrade(req)) return;
      return new Response('WebSocket endpoint', { status: 426 });
    },
    websocket: {
      open(ws)  { wsClients.add(ws); },
      close(ws) { wsClients.delete(ws); },
      message() {},
    },
  });

  startNcServer();

  const authMode = AUTH.hash ? 'system shadow auth' : 'env-var auth (fallback)';
  const wsAuth   = WS_TOKEN ? 'token auth' : 'NO AUTH — set OBSERVER_WS_TOKEN';
  console.log(`Observer UI:  http://${BIND}:${UI_PORT}`);
  console.log(`Observer WS:  ws://${BIND}:${WS_PORT}  [${wsAuth}]`);
  console.log(`Observer NC:  ${BIND}:${NC_PORT}  [${authMode}, rate-limited]`);
  if (!WS_TOKEN) console.warn('[observer] WARNING: OBSERVER_WS_TOKEN is not set — WebSocket is unauthenticated');
}

function stop() {
  if (uiServer) { uiServer.stop(); uiServer = null; }
  if (wsServer) { wsServer.stop(); wsServer = null; }
  if (ncServer) { ncServer.stop(); ncServer = null; }
  wsClients.clear();
  for (const [, sess] of ncSessions) {
    clearTimeout(sess.authTimer);
    try { sess.socket.end(); } catch (_) {}
  }
  ncSessions.clear();
}

if (require.main === module) {
  start();
}

module.exports = { broadcast, start, stop };
