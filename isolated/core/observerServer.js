const fs   = require('fs');
const path = require('path');
const os   = require('os');

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
const SNAPSHOTS_DIR  = path.join(OPEN_DIR, 'snapshots');
const RESTARTS_FILE  = path.join(OPEN_DIR, 'restarts.json');
const HINTS_FILE     = path.join(OPEN_DIR, 'hints.json');

// ── ANSI color helpers ────────────────────────────────────────────────────────
const C = {
  reset  : '\x1b[0m',
  bold   : '\x1b[1m',
  dim    : '\x1b[2m',
  red    : '\x1b[31m',
  green  : '\x1b[32m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
  gray   : '\x1b[90m',
  white  : '\x1b[97m',
};

function col(color, text) { return `${C[color]}${text}${C.reset}`; }

// ── Auth config ───────────────────────────────────────────────────────────────
let AUTH = null;

function loadAuth() {
  try {
    const line = fs.readFileSync(AUTH_FILE, 'utf8').trim();
    const colon = line.indexOf(':');
    if (colon === -1) throw new Error('bad format');
    return { user: line.slice(0, colon), hash: line.slice(colon + 1) };
  } catch (_) {
    return {
      user: process.env.OBSERVER_USER || 'nomad',
      hash: null,
      plainPass: process.env.OBSERVER_PASS || 'nomad',
    };
  }
}

async function verifyShadowHash(inputPass, storedHash) {
  // Use python3 + ctypes to call the system libcrypt directly.
  // This handles all hash algorithms including yescrypt ($y$) used on
  // Debian 13 Trixie / Ubuntu 22.04+. openssl passwd -6 only does SHA-512
  // and cannot verify yescrypt hashes.
  const script = [
    'import ctypes,os',
    "p=os.environ.get('P','')",
    "h=os.environ.get('H','')",
    "done=False",
    "for n in ['libcrypt.so.2','libcrypt.so.1']:",
    "  try:",
    "    lib=ctypes.CDLL(n); lib.crypt.restype=ctypes.c_char_p",
    "    r=lib.crypt(p.encode(),h.encode()); print(r.decode() if r else ''); done=True; break",
    "  except: pass",
    "if not done: print('')",
  ].join('\n');

  const proc = Bun.spawn(
    ['python3', '-c', script],
    { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, P: inputPass, H: storedHash } }
  );
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output.trim() === storedHash;
}

async function checkPassword(inputUser, inputPass) {
  if (inputUser !== AUTH.user) return false;
  if (AUTH.hash) {
    try { return await verifyShadowHash(inputPass, AUTH.hash); } catch (_) { return false; }
  }
  return inputPass === AUTH.plainPass;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE = {
  MAX_ATTEMPTS : 5,
  WINDOW_MS    : 60_000,
  BLOCK_MS     : 5 * 60_000,
  DELAY_MS     : 1_000,
};

const ratemap = new Map();

function getRateEntry(ip) {
  if (!ratemap.has(ip)) ratemap.set(ip, { attempts: [], blockedUntil: 0 });
  return ratemap.get(ip);
}

function rateCheck(ip) {
  const now = Date.now();
  const entry = getRateEntry(ip);
  if (entry.blockedUntil > now) return { allowed: false, retryAfterMs: entry.blockedUntil - now };
  entry.attempts = entry.attempts.filter(a => now - a.ts < RATE.WINDOW_MS);
  if (entry.attempts.length >= RATE.MAX_ATTEMPTS) {
    entry.blockedUntil = now + RATE.BLOCK_MS;
    return { allowed: false, retryAfterMs: RATE.BLOCK_MS };
  }
  return { allowed: true, delayMs: entry.attempts.length * RATE.DELAY_MS };
}

function rateRecordFailure(ip) { getRateEntry(ip).attempts.push({ ts: Date.now() }); }
function rateRecordSuccess(ip) { ratemap.delete(ip); }

// ── Recent event buffer ───────────────────────────────────────────────────────
const EVENT_BUFFER_SIZE = 20;
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
const IDLE_TIMEOUT_MS = 10 * 60_000; // disconnect idle (non-streaming) sessions after 10 min

// ── Safe write helper ─────────────────────────────────────────────────────────
function ncWrite(sess, data) {
  try { sess.socket.write(data); } catch (_) {}
}

// ── Event formatting ──────────────────────────────────────────────────────────
const EVENT_COLORS = {
  thought        : 'cyan',
  plan           : 'cyan',
  tool_call      : 'green',
  tool_result    : 'green',
  blocked_action : 'red',
  error          : 'red',
  memory_update  : 'yellow',
  module_load    : 'yellow',
  module_unload  : 'yellow',
  boot           : 'white',
  shutdown       : 'gray',
};

function formatEvent(event) {
  const ts    = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const color = EVENT_COLORS[event.type] || 'white';
  const typ   = col(color, String(event.type).padEnd(14));
  let body    = typeof event.data === 'object'
    ? JSON.stringify(event.data)
    : String(event.data ?? '');
  if (body.length > 200) body = body.slice(0, 197) + '...';
  return `${col('gray', '[' + ts + ']')} [${typ}] ${body}\r\n`;
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
      sess.socket.write(line);
    } catch (_) {
      clearTimeout(sess.authTimer);
      clearTimeout(sess.idleTimer);
      ncSessions.delete(sock);
    }
  }
}

// ── Welcome banner (shown after successful auth) ───────────────────────────────
function buildBanner() {
  const u   = process.uptime();
  const uFmt = `${Math.floor(u/3600)}h${Math.floor((u%3600)/60)}m${Math.floor(u%60)}s`;
  let memCount = 0, epCount = 0, goalCount = 0, snapCount = 0;
  try { memCount  = Object.keys(JSON.parse(fs.readFileSync(LT_FILE,  'utf8'))).length; } catch (_) {}
  try { epCount   = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')).length;               } catch (_) {}
  try { goalCount = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')).length;            } catch (_) {}
  try { snapCount = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).length; } catch (_) {}

  return (
    '\r\n' +
    col('cyan', col('bold', '  NomadAI Observer')) + `  ${col('gray', new Date().toLocaleString())}\r\n` +
    col('gray', '  ─────────────────────────────────────────') + '\r\n' +
    `  uptime    ${col('green', uFmt)}\r\n` +
    `  memory    ${col('yellow', String(memCount))} keys  |  episodic ${col('yellow', String(epCount))} entries\r\n` +
    `  goals     ${col('yellow', String(goalCount))}  |  snapshots ${col('yellow', String(snapCount))}\r\n` +
    col('gray', '  ─────────────────────────────────────────') + '\r\n' +
    `  Type ${col('cyan', 'help')} for commands, ${col('cyan', 'stream')} to go live.\r\n\r\n> `
  );
}

// ── NC command handler ─────────────────────────────────────────────────────────
const STREAM_TYPES = ['thought','plan','tool_call','tool_result','blocked_action','error','memory_update','module_load','module_unload','boot','shutdown'];

async function handleCommand(sess, raw) {
  const line = raw.trim();

  // Ping keepalive — client can send "ping" to prevent idle timeout
  if (line.toLowerCase() === 'ping') {
    sess.lastActivity = Date.now();
    ncWrite(sess, col('gray', 'pong') + '\r\n> ');
    return;
  }

  if (!line) { ncWrite(sess, '> '); return; }
  sess.lastActivity = Date.now();

  const [cmd, ...rest] = line.split(' ');
  const arg = rest.join(' ').trim();

  switch (cmd.toLowerCase()) {

    case 'stream': {
      sess.streaming = true;
      sess.filter = arg || null;
      const replay = arg
        ? recentEvents.filter(e => e.type.includes(arg))
        : recentEvents.slice();
      if (replay.length) {
        ncWrite(sess, col('gray', `[stream] ── last ${replay.length} buffered event(s) ──`) + '\r\n');
        for (const e of replay) ncWrite(sess, formatEvent(e));
        ncWrite(sess, col('gray', '[stream] ── live ──') + '\r\n');
      }
      const types = arg ? '' : `\r\n${col('gray', '  filter types: ' + STREAM_TYPES.join(', '))}`;
      ncWrite(sess,
        col('green', arg
          ? `[stream] Live (filter: ${arg}). Type "stop" to end.`
          : '[stream] Live (all events). Type "stop" to end.'
        ) + types + '\r\n'
      );
      break;
    }

    case 'stop':
      sess.streaming = false;
      sess.filter = null;
      ncWrite(sess, col('gray', '[stream] Stopped.') + '\r\n> ');
      break;

    case 'ping':
      ncWrite(sess, col('gray', 'pong') + '\r\n> ');
      break;

    case 'status': {
      const u = process.uptime();
      const uFmt = `${Math.floor(u/3600)}h${Math.floor((u%3600)/60)}m${Math.floor(u%60)}s`;
      let memCount = 0, snapCount = 0;
      try { memCount  = Object.keys(JSON.parse(fs.readFileSync(LT_FILE, 'utf8'))).length; } catch (_) {}
      try { snapCount = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json')).length; } catch (_) {}
      ncWrite(sess,
        `${col('cyan','[status]')} uptime=${col('green',uFmt)}  ws=${wsClients.size}  nc=${ncSessions.size}  memory_keys=${memCount}  snapshots=${snapCount}\r\n> `
      );
      break;
    }

    case 'stats': {
      let epCount = 0, goalCount = 0, memFree = 0, memTotal = 0;
      try { epCount   = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')).length;   } catch (_) {}
      try { goalCount = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')).length; } catch (_) {}
      memFree  = Math.round(os.freemem()  / 1024 / 1024);
      memTotal = Math.round(os.totalmem() / 1024 / 1024);
      const { exec } = require('./vmController');
      const disk = await exec('df -h / | tail -1').catch(() => ({ stdout: 'n/a' }));
      ncWrite(sess,
        `${col('cyan','[stats]')} episodic=${epCount} entries  goals=${goalCount}  ram=${memFree}/${memTotal}MB  disk: ${disk.stdout.trim()}\r\n> `
      );
      break;
    }

    case 'version': {
      const bunVer = typeof Bun !== 'undefined' ? Bun.version : 'unknown';
      const model  = process.env.LLM_MODEL || 'llama3';
      ncWrite(sess,
        `${col('cyan','[version]')} NomadAI  bun=${bunVer}  model=${model}  node=${process.version}\r\n> `
      );
      break;
    }

    case 'goals': {
      let goals = [];
      try { goals = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) {}

      if (arg.startsWith('add ') || (rest[0] === 'add' && rest.length > 1)) {
        // goals add <text> [priority]
        const addArgs = rest.slice(1);
        const priority = ['high','normal','low'].includes(addArgs[addArgs.length-1]) ? addArgs.pop() : 'normal';
        const goal = addArgs.join(' ').trim();
        if (!goal) { ncWrite(sess, col('red','[goals] Usage: goals add <text> [high|normal|low]') + '\r\n> '); break; }
        goals.push({ goal, priority, createdAt: new Date().toISOString() });
        try {
          fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2));
          ncWrite(sess, col('green',`[goals] Added [${priority}]: ${goal}`) + '\r\n> ');
        } catch (e) {
          ncWrite(sess, col('red',`[goals] Write failed: ${e.message}`) + '\r\n> ');
        }
        break;
      }

      if (arg === 'clear') {
        try {
          fs.writeFileSync(GOALS_FILE, '[]');
          ncWrite(sess, col('yellow','[goals] Cleared.') + '\r\n> ');
        } catch (e) {
          ncWrite(sess, col('red',`[goals] Write failed: ${e.message}`) + '\r\n> ');
        }
        break;
      }

      if (!goals.length) { ncWrite(sess, col('gray','[goals] (none)') + '\r\n> '); break; }
      for (const g of goals)
        ncWrite(sess, `${col('cyan','[goals]')} ${col('yellow','['+g.priority+']')} ${g.goal}  ${col('gray','('+g.createdAt+')')}\r\n`);
      ncWrite(sess, '> ');
      break;
    }

    case 'memory': {
      let lt = {};
      try { lt = JSON.parse(fs.readFileSync(LT_FILE, 'utf8')); } catch (_) {}

      if (arg.startsWith('delete ') || rest[0] === 'delete') {
        const key = rest.slice(1).join(' ').trim();
        if (!key) { ncWrite(sess, col('red','[memory] Usage: memory delete <key>') + '\r\n> '); break; }
        if (!(key in lt)) { ncWrite(sess, col('red',`[memory] Key not found: ${key}`) + '\r\n> '); break; }
        delete lt[key];
        try {
          fs.writeFileSync(LT_FILE, JSON.stringify(lt, null, 2));
          ncWrite(sess, col('yellow',`[memory] Deleted: ${key}`) + '\r\n> ');
        } catch (e) {
          ncWrite(sess, col('red',`[memory] Write failed: ${e.message}`) + '\r\n> ');
        }
        break;
      }

      if (!arg) {
        const keys = Object.keys(lt);
        if (!keys.length) { ncWrite(sess, col('gray','[memory] (empty)') + '\r\n> '); break; }
        for (const k of keys)
          ncWrite(sess, `${col('cyan','[memory]')} ${col('white',k)}  ${col('gray','updated: '+(lt[k].updatedAt||'?'))}\r\n`);
        ncWrite(sess, '> ');
        break;
      }

      const entry = lt[arg];
      if (!entry) { ncWrite(sess, col('red',`[memory] Key not found: ${arg}`) + '\r\n> '); break; }
      ncWrite(sess, `${col('cyan','[memory]')} ${col('white',arg)} = ${JSON.stringify(entry.value)}  ${col('gray','tags: '+(entry.tags||[]).join(', ')||'none')}\r\n> `);
      break;
    }

    case 'search': {
      if (!arg) { ncWrite(sess, col('red','[search] Usage: search <query>') + '\r\n> '); break; }
      let lt = {};
      try { lt = JSON.parse(fs.readFileSync(LT_FILE, 'utf8')); } catch (_) {}
      const q = arg.toLowerCase();
      const hits = Object.entries(lt).filter(([k, v]) =>
        (k + JSON.stringify(v.value) + (v.tags||[]).join(' ')).toLowerCase().includes(q)
      );
      if (!hits.length) { ncWrite(sess, col('gray',`[search] No results for: ${arg}`) + '\r\n> '); break; }
      for (const [k, v] of hits)
        ncWrite(sess, `${col('cyan','[search]')} ${col('white',k)} = ${JSON.stringify(v.value)}\r\n`);
      ncWrite(sess, '> ');
      break;
    }

    case 'modules': {
      let mods = [];
      try { mods = fs.readdirSync(path.join(OPEN_DIR, 'modules')).filter(f => f.endsWith('.js') && f !== 'example.js'); } catch (_) {}
      if (!mods.length) { ncWrite(sess, col('gray','[modules] (none written yet)') + '\r\n> '); break; }
      for (const m of mods) ncWrite(sess, `${col('cyan','[modules]')} ${m}\r\n`);
      ncWrite(sess, '> ');
      break;
    }

    case 'snapshot': {
      try {
        const vm = require('./versionManager');
        const result = await vm.snapshot('observer-manual');
        if (result.ok) {
          ncWrite(sess, col('green',`[snapshot] Created: ${result.result.id}`) + '\r\n> ');
        } else {
          ncWrite(sess, col('red',`[snapshot] Failed: ${result.error}`) + '\r\n> ');
        }
      } catch (e) {
        ncWrite(sess, col('red',`[snapshot] Error: ${e.message}`) + '\r\n> ');
      }
      break;
    }

    case 'snapshots': {
      const n = parseInt(arg) || 5;
      let snaps = [];
      try {
        const vm = require('./versionManager');
        snaps = vm.listSnapshots().slice(-n);
      } catch (_) {}
      if (!snaps.length) { ncWrite(sess, col('gray','[snapshots] (none)') + '\r\n> '); break; }
      for (const s of snaps) {
        const label = s.label ? col('yellow', ' '+s.label) : '';
        const note  = s.note  ? col('gray',   ' — '+s.note) : '';
        ncWrite(sess, `${col('cyan','[snap]')} ${s.id}${label}  ${col('gray',s.timestamp)}${note}\r\n`);
      }
      ncWrite(sess, '> ');
      break;
    }

    case 'rollback': {
      ncWrite(sess, col('yellow','[rollback] Rolling back open/ ...') + '\r\n');
      try {
        const vm = require('./versionManager');
        const result = await vm.rollback(arg || undefined);
        if (result.ok) {
          ncWrite(sess, col('green',`[rollback] Restored to: ${result.result.id} (${result.result.label||'unlabeled'})`) + '\r\n> ');
        } else {
          ncWrite(sess, col('red',`[rollback] Failed: ${result.error}`) + '\r\n> ');
        }
      } catch (e) {
        ncWrite(sess, col('red',`[rollback] Error: ${e.message}`) + '\r\n> ');
      }
      break;
    }

    case 'thoughts': {
      const n = parseInt(arg) || 20;
      let lines = [];
      try { lines = fs.readFileSync(THOUGHTS_LOG, 'utf8').split('\n').filter(Boolean); } catch (_) {}
      const tail = lines.slice(-n);
      if (!tail.length) { ncWrite(sess, col('gray','[thoughts] (empty)') + '\r\n> '); break; }
      for (const l of tail) ncWrite(sess, col('gray', l) + '\r\n');
      ncWrite(sess, '> ');
      break;
    }

    case 'history': {
      const n = parseInt(arg) || 10;
      let ep = [];
      try { ep = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); } catch (_) {}
      const tail = ep.slice(-n);
      if (!tail.length) { ncWrite(sess, col('gray','[history] (empty)') + '\r\n> '); break; }
      for (const e of tail) {
        const argsStr = Object.keys(e.args || {}).length ? ' ' + JSON.stringify(e.args) : '';
        const ok = e.ok ? col('green','ok=true') : col('red','ok=false');
        ncWrite(sess, `${col('gray',e.ts)}  ${col('cyan',e.tool)}${argsStr}  ${ok}\r\n`);
      }
      ncWrite(sess, '> ');
      break;
    }

    case 'who': {
      ncWrite(sess, `${col('cyan','[who]')} WebSocket clients: ${wsClients.size}\r\n`);
      let i = 1;
      for (const [, s] of ncSessions) {
        const state = s.authed ? (s.streaming ? col('green','streaming') : col('gray','idle')) : col('yellow','authenticating');
        ncWrite(sess, `${col('cyan','[who]')} NC #${i++}: ${s.remoteAddr}  [${state}]\r\n`);
      }
      ncWrite(sess, '> ');
      break;
    }

    case 'clear':
      ncWrite(sess, '\x1b[2J\x1b[H> ');
      break;

    case 'help':
      ncWrite(sess,
        '\r\n' + col('bold', 'Commands') + '\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  stream') + ' [filter]        Live event stream. Filter: thought, tool_call, error, ...\r\n' +
        col('cyan','  stop') + '                  Stop stream, return to prompt\r\n' +
        col('cyan','  ping') + '                  Keepalive check — responds with pong\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  status') + '                Agent uptime and connection counts\r\n' +
        col('cyan','  stats') + '                 Detailed: RAM, disk, episodic count, goal count\r\n' +
        col('cyan','  version') + '               Bun version, model name\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  goals') + '                 List current AI goals\r\n' +
        col('cyan','  goals add') + ' <text> [pri] Add a goal (priority: high|normal|low)\r\n' +
        col('cyan','  goals clear') + '           Clear all goals\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  memory') + ' [key]           List all memory keys, or read a specific key\r\n' +
        col('cyan','  memory delete') + ' <key>    Delete a memory key\r\n' +
        col('cyan','  search') + ' <query>         Search long-term memory\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  thoughts') + ' [n]            Last n thought log lines (default 20)\r\n' +
        col('cyan','  history') + ' [n]             Last n episodic tool calls (default 10)\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  modules') + '                List AI-written modules\r\n' +
        col('cyan','  snapshot') + '               Trigger a manual snapshot\r\n' +
        col('cyan','  snapshots') + ' [n]           List last n snapshots (default 5)\r\n' +
        col('cyan','  rollback') + ' [id]           Rollback open/ to a snapshot (latest if no id)\r\n' +
        col('cyan','  restarts') + ' [n]            Show last n restart requests (default 10)\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  ls') + ' [path]              List files in /open/ (or subdir)\r\n' +
        col('cyan','  cat') + ' <path>             Read a file in /open/\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  hint') + ' <message>          Send a hint to the AI (it may or may not act on it)\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  cache') + '                  List cached tool results\r\n' +
        col('cyan','  cache clear') + ' [tool]     Clear cache (all, or specific tool)\r\n' +
        col('cyan','  cache inject') + ' <tool> [args] [result]  Manually inject a cached result\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  time') + '                   Show current time\r\n' +
        col('cyan','  date') + '                   Show current date\r\n' +
        col('gray','  ──────────────────────────────────────────────────────────') + '\r\n' +
        col('cyan','  who') + '                    Show active observer connections\r\n' +
        col('cyan','  clear') + '                  Clear terminal screen\r\n' +
        col('cyan','  quit') + '                   Disconnect\r\n\r\n> '
      );
      break;

    case 'ls': {
      // Restrict browsing to /open/
      const relLs = arg || '';
      const absLs = relLs
        ? path.join(OPEN_DIR, relLs.replace(/^\/open\/?/, ''))
        : OPEN_DIR;
      if (absLs !== OPEN_DIR && !absLs.startsWith(OPEN_DIR + '/')) {
        ncWrite(sess, col('red', '[ls] Access restricted to /open/') + '\r\n> ');
        break;
      }
      try {
        const entries = fs.readdirSync(absLs, { withFileTypes: true });
        const display = absLs.replace(path.dirname(OPEN_DIR), '');
        ncWrite(sess, `${col('cyan','[ls]')} ${col('white', display)}\r\n`);
        for (const e of entries) {
          const isDir = e.isDirectory();
          const name  = isDir ? col('cyan', e.name + '/') : e.name;
          let size = '';
          try {
            const st = fs.statSync(path.join(absLs, e.name));
            size = isDir ? '' : col('gray', ` (${(st.size/1024).toFixed(1)}kb)`);
          } catch (_) {}
          ncWrite(sess, `  ${name}${size}\r\n`);
        }
        ncWrite(sess, '> ');
      } catch (e) {
        ncWrite(sess, col('red', `[ls] ${e.message}`) + '\r\n> ');
      }
      break;
    }

    case 'cat': {
      if (!arg) { ncWrite(sess, col('red', '[cat] Usage: cat <path>') + '\r\n> '); break; }
      const relCat = arg.replace(/^\/open\/?/, '');
      const absCat = path.join(OPEN_DIR, relCat);
      if (!absCat.startsWith(OPEN_DIR + '/')) {
        ncWrite(sess, col('red', '[cat] Access restricted to /open/') + '\r\n> ');
        break;
      }
      try {
        const st = fs.statSync(absCat);
        if (st.isDirectory()) { ncWrite(sess, col('red', '[cat] Is a directory — use ls') + '\r\n> '); break; }
        if (st.size > 64 * 1024) {
          ncWrite(sess, col('yellow', `[cat] File too large (${(st.size/1024).toFixed(1)}kb). Showing first 64kb.`) + '\r\n');
        }
        const content = fs.readFileSync(absCat, 'utf8').slice(0, 64 * 1024);
        ncWrite(sess, col('gray', '─── ' + arg + ' ───') + '\r\n');
        for (const line of content.split('\n')) ncWrite(sess, line + '\r\n');
        ncWrite(sess, col('gray', '─────────────────') + '\r\n> ');
      } catch (e) {
        ncWrite(sess, col('red', `[cat] ${e.message}`) + '\r\n> ');
      }
      break;
    }

    case 'restarts': {
      let rs = [];
      try { rs = JSON.parse(fs.readFileSync(RESTARTS_FILE, 'utf8')); } catch (_) {}
      const n = parseInt(arg) || 10;
      const tail = rs.slice(-n);
      if (!tail.length) { ncWrite(sess, col('gray','[restarts] (no restart history)') + '\r\n> '); break; }
      for (const r of tail) {
        const status = r.status === 'approved' ? col('green', r.status)
          : r.status === 'denied' ? col('red', r.status)
          : col('yellow', r.status || 'pending');
        ncWrite(sess, `${col('cyan','[restart]')} ${col('gray', r.timestamp||'?')}  ${status}  ${r.reason||'(no reason)'}\r\n`);
        if (r.outcome) ncWrite(sess, `    ${col('gray','outcome:')} ${r.outcome}\r\n`);
      }
      ncWrite(sess, '> ');
      break;
    }

    case 'time':
    case 'currenttime': {
      const now = new Date();
      ncWrite(sess, col('cyan', '[time] ') + now.toLocaleTimeString() + '  ' + col('gray', now.toISOString()) + '\r\n> ');
      break;
    }

    case 'date':
    case 'currentdate': {
      const now = new Date();
      ncWrite(sess, col('cyan', '[date] ') + now.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }) + '\r\n> ');
      break;
    }

    case 'cache': {
      const { toolCache } = require('./toolDispatcher');
      const parts = arg.split(' ');
      const sub = parts[0].toLowerCase();
      if (sub === 'clear') {
        const target = parts.slice(1).join(' ').trim() || undefined;
        toolCache.clear(target);
        ncWrite(sess, col('green', target ? `[cache] Cleared entries for: ${target}` : '[cache] Entire cache cleared') + '\r\n> ');
      } else if (sub === 'inject') {
        // cache inject <ToolName> <args-json> <result-json>
        const tool = parts[1];
        if (!tool) { ncWrite(sess, col('red', '[cache] Usage: cache inject <Tool> [args-json] [result-json]') + '\r\n> '); break; }
        let injArgs = {}, injResult = null;
        try { injArgs = JSON.parse(parts[2] || '{}'); } catch (_) { injArgs = {}; }
        try { injResult = JSON.parse(parts.slice(3).join(' ') || 'null'); } catch (_) { injResult = parts.slice(3).join(' ') || null; }
        toolCache.set(tool, injArgs, { ok: true, result: injResult });
        ncWrite(sess, col('green', `[cache] Injected result for ${tool}(${JSON.stringify(injArgs)})`) + '\r\n> ');
      } else {
        // list (default)
        const entries = toolCache.list();
        if (!entries.length) {
          ncWrite(sess, col('gray', '[cache] Empty — no cached results') + '\r\n> ');
        } else {
          ncWrite(sess, col('bold', `[cache] ${entries.length} entries  (TTL ${Math.round(toolCache.CACHE_TTL_MS/1000)}s / ${toolCache.CACHE_MAX_TURNS} turns)\r\n`));
          for (const e of entries) {
            const age = e.ageMs < 60000 ? `${Math.round(e.ageMs/1000)}s` : `${Math.round(e.ageMs/60000)}m`;
            const exp = `expires ${Math.round(e.expiresInMs/1000)}s / ${e.expiresInTurns} turns`;
            ncWrite(sess, `  ${col('cyan', e.tool.padEnd(20))}  age=${age}  ${col('gray', exp)}\r\n`);
          }
          ncWrite(sess, '> ');
        }
      }
      break;
    }

    case 'hint': {
      if (!arg) { ncWrite(sess, col('red', '[hint] Usage: hint <message>') + '\r\n> '); break; }
      const hr = submitHint(arg);
      if (hr.ok) {
        broadcast({ type: 'hint', data: { id: hr.result.id, text: hr.result.text, timestamp: hr.result.timestamp } });
        ncWrite(sess, col('green', `[hint] Sent: "${hr.result.text}"`) + '\r\n> ');
      } else {
        ncWrite(sess, col('red', `[hint] Failed: ${hr.error}`) + '\r\n> ');
      }
      break;
    }

    case 'quit':
    case 'exit':
      ncWrite(sess, 'Goodbye.\r\n');
      try { sess.socket.end(); } catch (_) {}
      break;

    default:
      ncWrite(sess, col('red',`[error] Unknown command: ${cmd}.`) + ' Type "help".\r\n> ');
  }
}

// ── Shared auth success handler ───────────────────────────────────────────────
function onAuthSuccess(sess, ip) {
  rateRecordSuccess(ip);
  sess.authed = true;
  sess.step = 'ready';
  sess.buf = '';
  sess.lastActivity = Date.now();
  clearTimeout(sess.authTimer);

  // Idle timeout — close sessions with no activity after IDLE_TIMEOUT_MS
  function resetIdle() {
    clearTimeout(sess.idleTimer);
    if (!sess.streaming) {
      sess.idleTimer = setTimeout(() => {
        ncWrite(sess, col('gray','\r\n[observer] Idle timeout — disconnected.') + '\r\n');
        try { sess.socket.end(); } catch (_) {}
      }, IDLE_TIMEOUT_MS);
    }
  }
  sess.resetIdle = resetIdle;
  resetIdle();

  ncWrite(sess, buildBanner());
}

// ── Auth state machine ─────────────────────────────────────────────────────────
async function handleAuthData(sess, chunk) {
  sess.buf = (sess.buf || '') + chunk.toString();
  const lines = sess.buf.split('\n');
  sess.buf = lines.pop();

  for (const raw of lines) {
    const val = raw.replace(/\r/g, '').trim();

    if (sess.step === 'user') {
      const colonIdx = val.indexOf(':');
      const hasInlinePass = colonIdx !== -1;
      sess.inputUser = hasInlinePass ? val.slice(0, colonIdx) : val;
      const inlinePass = hasInlinePass ? val.slice(colonIdx + 1) : null;

      if (hasInlinePass) {
        const ip    = sess.remoteAddr;
        const check = rateCheck(ip);
        if (!check.allowed) {
          const secs = Math.ceil(check.retryAfterMs / 1000);
          ncWrite(sess, col('red',`Authentication failed. Too many attempts — retry in ${secs}s.`) + '\r\n');
          try { sess.socket.end(); } catch (_) {}
          return;
        }
        if (check.delayMs > 0) await new Promise(r => setTimeout(r, check.delayMs));

        const ok = await checkPassword(sess.inputUser, inlinePass);
        if (ok) {
          onAuthSuccess(sess, ip);
        } else {
          rateRecordFailure(ip);
          const remaining = RATE.MAX_ATTEMPTS - getRateEntry(ip).attempts.length;
          if (remaining > 0) {
            ncWrite(sess, col('red',`Authentication failed. ${remaining} attempt(s) remaining.`) + '\r\nUsername: ');
            sess.step = 'user';
            sess.inputUser = '';
          } else {
            const secs = Math.ceil(RATE.BLOCK_MS / 1000);
            ncWrite(sess, col('red',`Authentication failed. Blocked for ${secs}s.`) + '\r\n');
            try { sess.socket.end(); } catch (_) {}
          }
        }
      } else {
        sess.step = 'pass';
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
      const ip    = sess.remoteAddr;
      const check = rateCheck(ip);

      if (!check.allowed) {
        const secs = Math.ceil(check.retryAfterMs / 1000);
        ncWrite(sess, col('red',`Authentication failed. Too many attempts — retry in ${secs}s.`) + '\r\n');
        try { sess.socket.end(); } catch (_) {}
        return;
      }

      if (check.delayMs > 0) await new Promise(r => setTimeout(r, check.delayMs));

      const ok = await checkPassword(sess.inputUser, val);

      if (ok) {
        onAuthSuccess(sess, ip);
      } else {
        rateRecordFailure(ip);
        const remaining = RATE.MAX_ATTEMPTS - getRateEntry(ip).attempts.length;
        if (remaining > 0) {
          ncWrite(sess, col('red',`Authentication failed. ${remaining} attempt(s) remaining.`) + '\r\nUsername: ');
          sess.step = 'user';
          sess.inputUser = '';
        } else {
          const secs = Math.ceil(RATE.BLOCK_MS / 1000);
          ncWrite(sess, col('red',`Authentication failed. Blocked for ${secs}s.`) + '\r\n');
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
          lastActivity: Date.now(),
          idleTimer: null,
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
          handleAuthData(sess, chunk).catch(() => {});
          return;
        }

        sess.lastActivity = Date.now();
        if (sess.resetIdle) sess.resetIdle();

        sess.buf = (sess.buf || '') + chunk.toString();
        const lines = sess.buf.split('\n');
        sess.buf = lines.pop();

        for (const raw of lines) {
          const line = raw.replace(/\r/g, '').trim();
          if (!line) continue;
          if (sess.streaming && line.toLowerCase() !== 'stop' && line.toLowerCase() !== 'ping') continue;
          handleCommand(sess, line).catch(() => {});
        }
      },

      close(socket) {
        const sess = ncSessions.get(socket);
        if (sess) {
          clearTimeout(sess.authTimer);
          clearTimeout(sess.idleTimer);
        }
        ncSessions.delete(socket);
      },

      error(socket) {
        const sess = ncSessions.get(socket);
        if (sess) {
          clearTimeout(sess.authTimer);
          clearTimeout(sess.idleTimer);
        }
        ncSessions.delete(socket);
      },
    },
  });
}

// ── HTTP UI + WebSocket ───────────────────────────────────────────────────────
function apiMemory() {
  try { return JSON.parse(fs.readFileSync(LT_FILE, 'utf8')); } catch (_) { return {}; }
}
function apiEpisodic(n = 20) {
  try { const a = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); return a.slice(-n); } catch (_) { return []; }
}
function apiGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) { return []; }
}
function apiRestarts() {
  try { return JSON.parse(fs.readFileSync(RESTARTS_FILE, 'utf8')); } catch (_) { return []; }
}
function apiHints() {
  try {
    const h = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch (_) { return []; }
}
// Called when the observer sends a hint — lets index.js cancel the RequestHint wait early
let _onHintReceived = null;
function setHintReceivedCallback(fn) { _onHintReceived = fn; }
function clearHintReceivedCallback()  { _onHintReceived = null; }

const MAX_HINTS = 500;
function submitHint(text) {
  if (!text || !text.trim()) return { ok: false, error: 'hint text is required' };
  let hints = apiHints();
  const entry = { id: `hint_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, text: text.trim(), timestamp: new Date().toISOString(), seen: false, status: 'pending' };
  // Notify index.js so it can cancel the 30s RequestHint wait early
  if (_onHintReceived) { try { _onHintReceived(); } catch (_) {} _onHintReceived = null; }
  hints.push(entry);
  if (hints.length > MAX_HINTS) hints = hints.slice(-MAX_HINTS);
  try {
    fs.writeFileSync(HINTS_FILE, JSON.stringify(hints, null, 2));
    return { ok: true, result: entry };
  } catch (e) { return { ok: false, error: e.message }; }
}
function apiSnapshots() {
  try { const vm = require('./versionManager'); return vm.listSnapshots(); } catch (_) { return []; }
}
function apiThoughts(n = 50) {
  try { return fs.readFileSync(THOUGHTS_LOG, 'utf8').split('\n').filter(Boolean).slice(-n); } catch (_) { return []; }
}
function apiFiles(relPath = '') {
  const abs = relPath ? path.join(OPEN_DIR, relPath.replace(/^\/open\/?/, '')) : OPEN_DIR;
  if (abs !== OPEN_DIR && !abs.startsWith(OPEN_DIR + '/')) return { error: 'Access restricted to /open/' };
  try {
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    return entries.map(e => {
      let size = null;
      try { if (!e.isDirectory()) size = fs.statSync(path.join(abs, e.name)).size; } catch (_) {}
      return { name: e.name, isDir: e.isDirectory(), size };
    });
  } catch (e) { return { error: e.message }; }
}
function apiFileRead(relPath) {
  if (!relPath) return { error: 'path required' };
  const abs = path.join(OPEN_DIR, relPath.replace(/^\/open\/?/, ''));
  if (!abs.startsWith(OPEN_DIR + '/')) return { error: 'Access restricted to /open/' };
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { error: 'Is a directory' };
    if (st.size > 256 * 1024) return { error: `File too large (${(st.size/1024).toFixed(0)}kb)`, truncated: true };
    return { content: fs.readFileSync(abs, 'utf8'), size: st.size };
  } catch (e) { return { error: e.message }; }
}

const HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, 'observer.html'), 'utf8');
function buildHTML() {
  return HTML_TEMPLATE
    .replace(/__WS_TOKEN__/g, JSON.stringify(WS_TOKEN))
    .replace(/__WS_PORT__/g, String(WS_PORT));
}


function start() {
  if (uiServer && wsServer && ncServer) return;

  AUTH = loadAuth();

  uiServer = Bun.serve({
    hostname: BIND,
    port: UI_PORT,
    fetch(req) {
      const url  = new URL(req.url);
      const json = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/api/memory')    return json(apiMemory());
      if (url.pathname === '/api/goals')     return json(apiGoals());
      if (url.pathname === '/api/restarts')  return json(apiRestarts());
      if (url.pathname === '/api/snapshots') return json(apiSnapshots());
      if (url.pathname === '/api/thoughts')  return json(apiThoughts(Number(url.searchParams.get('n')) || 50));
      if (url.pathname === '/api/history')   return json(apiEpisodic(Number(url.searchParams.get('n')) || 20));
      if (url.pathname === '/api/files')     return json(apiFiles(url.searchParams.get('path') || ''));
      if (url.pathname === '/api/file')      return json(apiFileRead(url.searchParams.get('path') || ''));
      if (url.pathname === '/api/hints')     return json(apiHints());
      if (url.pathname === '/api/hint' && req.method === 'POST') {
        return req.text().then(body => {
          let text = '';
          try { text = JSON.parse(body).text || ''; } catch (_) { text = body; }
          const r = submitHint(text);
          if (r.ok) broadcast({ type: 'hint', data: { id: r.result.id, text: r.result.text, timestamp: r.result.timestamp } });
          return json(r);
        });
      }
      return new Response(buildHTML(), { headers: { 'Content-Type': 'text/html' } });
    },
  });

  wsServer = Bun.serve({
    hostname: BIND,
    port: WS_PORT,
    fetch(req, server) {
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
    clearTimeout(sess.idleTimer);
    try { sess.socket.end(); } catch (_) {}
  }
  ncSessions.clear();
}

if (require.main === module) {
  start();
}

module.exports = { broadcast, start, stop, setHintReceivedCallback, clearHintReceivedCallback };
