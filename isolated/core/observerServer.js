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
  const parts = storedHash.split('$').filter(Boolean);
  if (parts.length < 3) return false;
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
      if (!absLs.startsWith(OPEN_DIR)) {
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
      if (!absCat.startsWith(OPEN_DIR)) {
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
function apiSnapshots() {
  try { const vm = require('./versionManager'); return vm.listSnapshots(); } catch (_) { return []; }
}
function apiThoughts(n = 50) {
  try { return fs.readFileSync(THOUGHTS_LOG, 'utf8').split('\n').filter(Boolean).slice(-n); } catch (_) { return []; }
}
function apiFiles(relPath = '') {
  const abs = relPath ? path.join(OPEN_DIR, relPath.replace(/^\/open\/?/, '')) : OPEN_DIR;
  if (!abs.startsWith(OPEN_DIR)) return { error: 'Access restricted to /open/' };
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
  if (!abs.startsWith(OPEN_DIR)) return { error: 'Access restricted to /open/' };
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { error: 'Is a directory' };
    if (st.size > 256 * 1024) return { error: `File too large (${(st.size/1024).toFixed(0)}kb)`, truncated: true };
    return { content: fs.readFileSync(abs, 'utf8'), size: st.size };
  } catch (e) { return { error: e.message }; }
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>NomadAI Observer</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d0d0d;color:#e0e0e0;font-family:monospace;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    #topbar{display:flex;align-items:center;gap:16px;padding:6px 14px;background:#111;border-bottom:1px solid #222;flex-shrink:0}
    #topbar h1{font-size:13px;color:#7ec8e3;letter-spacing:1px;font-weight:bold}
    #status{font-size:11px;color:#555;margin-left:auto}
    #status.connected{color:#a8ff78}
    #tabs{display:flex;gap:0;background:#111;border-bottom:1px solid #222;flex-shrink:0}
    .tab{padding:7px 18px;font-size:12px;cursor:pointer;color:#888;border-right:1px solid #1e1e1e;user-select:none}
    .tab:hover{color:#ccc}
    .tab.active{color:#7ec8e3;border-bottom:2px solid #7ec8e3}
    #content{flex:1;overflow:hidden;position:relative}
    .page{display:none;height:100%;overflow:hidden}
    .page.active{display:flex;gap:8px;padding:8px}
    /* Live page */
    .panel{flex:1;display:flex;flex-direction:column;min-width:0}
    .panel h3{font-size:11px;color:#7ec8e3;text-transform:uppercase;letter-spacing:1px;padding:4px 0;flex-shrink:0}
    .scroll{flex:1;overflow-y:auto;background:#111;border:1px solid #222;padding:6px;font-size:11px;line-height:1.7}
    .entry{border-bottom:1px solid #1a1a1a;padding:3px 0;word-break:break-all}
    .ts{color:#555;margin-right:6px}
    .etype{margin-right:6px;font-weight:bold}
    .thought .etype,.plan .etype{color:#7ec8e3}
    .tool_call .etype{color:#a8ff78}
    .tool_result .etype{color:#5c9e5c}
    .blocked_action .etype,.error .etype{color:#ff5e5e}
    .memory_update .etype,.module_load .etype,.module_unload .etype{color:#c792ea}
    .restart_request .etype{color:#f0a500}
    .boot .etype{color:#fff}
    /* Files page */
    #files-page{flex-direction:row}
    #file-tree{width:240px;flex-shrink:0;border:1px solid #222;overflow-y:auto;font-size:12px;background:#111}
    #file-tree .item{padding:3px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #file-tree .item:hover{background:#1a1a1a}
    #file-tree .item.dir{color:#7ec8e3}
    #file-tree .item.sel{background:#1e2e1e}
    #file-view{flex:1;display:flex;flex-direction:column;min-width:0}
    #file-view h3{font-size:11px;color:#7ec8e3;padding:4px 0;flex-shrink:0}
    #file-content{flex:1;overflow:auto;background:#111;border:1px solid #222;padding:8px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all}
    /* Data pages shared */
    .data-page{flex-direction:column;gap:0;padding:0}
    .data-scroll{flex:1;overflow-y:auto;padding:10px 14px;font-size:12px}
    .data-item{padding:6px 0;border-bottom:1px solid #1a1a1a}
    .key{color:#7ec8e3;font-weight:bold}
    .val{color:#e0e0e0;word-break:break-all}
    .meta{color:#555;font-size:11px}
    .badge{display:inline-block;padding:1px 7px;border-radius:3px;font-size:11px;margin-right:6px}
    .badge.high{background:#4a1515;color:#ff5e5e}
    .badge.normal{background:#1a2a1a;color:#a8ff78}
    .badge.low{background:#1a1a2a;color:#7ec8e3}
    .badge.pending{background:#2a2a0a;color:#f0a500}
    .badge.approved{background:#0a2a0a;color:#a8ff78}
    .badge.denied{background:#2a0a0a;color:#ff5e5e}
    .toolbar{padding:6px 10px;background:#111;border-bottom:1px solid #222;font-size:12px;color:#555;display:flex;gap:10px;align-items:center;flex-shrink:0}
    .toolbar button{background:#1a1a1a;border:1px solid #333;color:#ccc;padding:2px 10px;cursor:pointer;font-family:monospace;font-size:11px;border-radius:2px}
    .toolbar button:hover{background:#222}
    .breadcrumb{color:#7ec8e3;font-size:11px;padding:4px 8px;border-bottom:1px solid #1a1a1a;flex-shrink:0}
  </style>
</head>
<body>
  <div id="topbar">
    <h1>NomadAI Observer</h1>
    <span id="status">disconnected</span>
  </div>
  <div id="tabs">
    <div class="tab active" data-page="live">Live Events</div>
    <div class="tab" data-page="files">Files</div>
    <div class="tab" data-page="memory">Memory</div>
    <div class="tab" data-page="goals">Goals</div>
    <div class="tab" data-page="restarts">Restarts</div>
    <div class="tab" data-page="snapshots">Snapshots</div>
  </div>
  <div id="content">
    <!-- Live Events page -->
    <div class="page active" id="page-live">
      <div class="panel"><h3>Thoughts &amp; Plans</h3><div class="scroll" id="p-thoughts"></div></div>
      <div class="panel"><h3>Tools &amp; Actions</h3><div class="scroll" id="p-commands"></div></div>
      <div class="panel"><h3>Errors &amp; Alerts</h3><div class="scroll" id="p-alerts"></div></div>
    </div>
    <!-- Files page -->
    <div class="page" id="page-files">
      <div id="files-page" style="display:flex;width:100%;height:100%;gap:8px;padding:8px">
        <div id="file-tree"></div>
        <div id="file-view">
          <h3 id="file-path-label">Select a file</h3>
          <div id="file-content" style="color:#555">Click a file in the tree to view its contents.</div>
        </div>
      </div>
    </div>
    <!-- Memory page -->
    <div class="page data-page" id="page-memory">
      <div class="toolbar">Long-Term Memory <button onclick="loadMemory()">Refresh</button></div>
      <div class="data-scroll" id="mem-list"></div>
    </div>
    <!-- Goals page -->
    <div class="page data-page" id="page-goals">
      <div class="toolbar">Goals <button onclick="loadGoals()">Refresh</button></div>
      <div class="data-scroll" id="goals-list"></div>
    </div>
    <!-- Restarts page -->
    <div class="page data-page" id="page-restarts">
      <div class="toolbar">Restart History <button onclick="loadRestarts()">Refresh</button></div>
      <div class="data-scroll" id="restarts-list"></div>
    </div>
    <!-- Snapshots page -->
    <div class="page data-page" id="page-snapshots">
      <div class="toolbar">Snapshots <button onclick="loadSnapshots()">Refresh</button></div>
      <div class="data-scroll" id="snapshots-list"></div>
    </div>
  </div>
  <script>
  // ── Tab switching ──
  const tabs = document.querySelectorAll('.tab');
  const pages = document.querySelectorAll('.page');
  tabs.forEach(t => t.addEventListener('click', () => {
    tabs.forEach(x => x.classList.remove('active'));
    pages.forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('page-' + t.dataset.page).classList.add('active');
    const loaders = {files:loadFiles, memory:loadMemory, goals:loadGoals, restarts:loadRestarts, snapshots:loadSnapshots};
    if (loaders[t.dataset.page]) loaders[t.dataset.page]();
  }));

  // ── Live events ──
  const pThoughts = document.getElementById('p-thoughts');
  const pCommands = document.getElementById('p-commands');
  const pAlerts   = document.getElementById('p-alerts');
  const statusEl  = document.getElementById('status');
  const THOUGHT_TYPES = new Set(['thought','plan','boot']);
  const ALERT_TYPES   = new Set(['blocked_action','error','restart_request','shutdown']);
  function addEntry(panel, ev) {
    const el = document.createElement('div');
    el.className = 'entry ' + ev.type;
    const ts = new Date().toLocaleTimeString();
    const body = typeof ev.data === 'object' ? JSON.stringify(ev.data) : String(ev.data||'');
    el.innerHTML = '<span class="ts">'+ts+'</span><span class="etype">['+ev.type+']</span>'+esc(body);
    panel.appendChild(el);
    panel.scrollTop = panel.scrollHeight;
    if (panel.children.length > 500) panel.removeChild(panel.firstChild);
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const WS_TOKEN = '${WS_TOKEN}';
  function connect() {
    const url = 'ws://'+location.hostname+':${WS_PORT}' + (WS_TOKEN ? '?token='+encodeURIComponent(WS_TOKEN) : '');
    const ws = new WebSocket(url);
    ws.onopen  = () => { statusEl.textContent='connected'; statusEl.className='connected'; };
    ws.onclose = (e) => {
      statusEl.textContent = e.code === 4401 ? 'auth failed' : 'disconnected';
      statusEl.className='';
      if (e.code !== 4401) setTimeout(connect, 3000);
    };
    ws.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        if      (THOUGHT_TYPES.has(ev.type)) addEntry(pThoughts, ev);
        else if (ALERT_TYPES.has(ev.type))   addEntry(pAlerts, ev);
        else                                  addEntry(pCommands, ev);
      } catch(_) {}
    };
  }
  connect();

  // ── Files ──
  let fileNavPath = '';
  async function loadFiles(rel) {
    rel = rel !== undefined ? rel : fileNavPath;
    fileNavPath = rel;
    const r = await fetch('/api/files?path='+encodeURIComponent(rel||''));
    const data = await r.json();
    const tree = document.getElementById('file-tree');
    tree.innerHTML = '';
    if (data.error) { tree.innerHTML = '<div class="item" style="color:#ff5e5e">'+esc(data.error)+'</div>'; return; }
    const label = '/open/' + (rel ? (rel.startsWith('/') ? rel.slice(1) : rel) : '');
    const bc = document.createElement('div');
    bc.className='breadcrumb'; bc.textContent=label; tree.appendChild(bc);
    if (rel) {
      const up = document.createElement('div');
      up.className='item dir'; up.textContent='../';
      const parent = rel.replace(/\/?[^/]*\/?$/,'');
      up.onclick = () => loadFiles(parent);
      tree.appendChild(up);
    }
    for (const e of data) {
      const el = document.createElement('div');
      el.className = 'item' + (e.isDir ? ' dir' : '');
      el.textContent = e.isDir ? e.name+'/' : e.name + (e.size!=null?' ('+fmtSize(e.size)+')':'');
      const entryPath = (rel ? rel.replace(/\/$/,'')+'/' : '') + e.name;
      if (e.isDir) { el.onclick = () => loadFiles(entryPath); }
      else { el.onclick = () => loadFileContent(entryPath, e.name); }
      tree.appendChild(el);
    }
  }
  function fmtSize(b) { return b<1024?b+'b': b<1024*1024?(b/1024).toFixed(1)+'kb': (b/1024/1024).toFixed(2)+'mb'; }
  async function loadFileContent(relPath, name) {
    document.querySelectorAll('#file-tree .item').forEach(x=>x.classList.remove('sel'));
    document.getElementById('file-path-label').textContent = '/open/' + relPath;
    const fc = document.getElementById('file-content');
    fc.textContent = 'Loading...';
    const r = await fetch('/api/file?path='+encodeURIComponent(relPath));
    const data = await r.json();
    if (data.error) { fc.style.color='#ff5e5e'; fc.textContent=data.error; return; }
    fc.style.color='#e0e0e0';
    fc.textContent = data.content;
  }

  // ── Memory ──
  async function loadMemory() {
    const r = await fetch('/api/memory');
    const data = await r.json();
    const el = document.getElementById('mem-list');
    el.innerHTML = '';
    const keys = Object.keys(data);
    if (!keys.length) { el.innerHTML = '<div style="color:#555">No memory entries.</div>'; return; }
    for (const k of keys) {
      const v = data[k];
      const d = document.createElement('div'); d.className='data-item';
      const tags = (v.tags||[]).length ? '<span class="meta">tags: '+esc(v.tags.join(', '))+'</span> ' : '';
      const upd  = v.updatedAt ? '<span class="meta">'+esc(v.updatedAt)+'</span>' : '';
      d.innerHTML = '<span class="key">'+esc(k)+'</span><br><span class="val">'+esc(JSON.stringify(v.value))+'</span><br>'+tags+upd;
      el.appendChild(d);
    }
  }

  // ── Goals ──
  async function loadGoals() {
    const r = await fetch('/api/goals');
    const data = await r.json();
    const el = document.getElementById('goals-list');
    el.innerHTML = '';
    if (!data.length) { el.innerHTML = '<div style="color:#555">No goals.</div>'; return; }
    for (const g of data) {
      const d = document.createElement('div'); d.className='data-item';
      const pri = g.priority||'normal';
      d.innerHTML = '<span class="badge '+esc(pri)+'">'+esc(pri)+'</span><span class="val">'+esc(g.goal)+'</span><br><span class="meta">'+esc(g.createdAt||'')+'</span>';
      el.appendChild(d);
    }
  }

  // ── Restarts ──
  async function loadRestarts() {
    const r = await fetch('/api/restarts');
    const data = await r.json();
    const el = document.getElementById('restarts-list');
    el.innerHTML = '';
    if (!data.length) { el.innerHTML = '<div style="color:#555">No restart history.</div>'; return; }
    for (const rs of [...data].reverse()) {
      const d = document.createElement('div'); d.className='data-item';
      const st = rs.status||'pending';
      d.innerHTML = '<span class="badge '+esc(st)+'">'+esc(st)+'</span><span class="meta">'+esc(rs.timestamp||'')+'</span><br><span class="val">'+esc(rs.reason||'(no reason)')+'</span>'+(rs.outcome?'<br><span class="meta">outcome: '+esc(rs.outcome)+'</span>':'');
      el.appendChild(d);
    }
  }

  // ── Snapshots ──
  async function loadSnapshots() {
    const r = await fetch('/api/snapshots');
    const data = await r.json();
    const el = document.getElementById('snapshots-list');
    el.innerHTML = '';
    if (!data.length) { el.innerHTML = '<div style="color:#555">No snapshots.</div>'; return; }
    for (const s of [...data].reverse()) {
      const d = document.createElement('div'); d.className='data-item';
      d.innerHTML = '<span class="key">'+esc(s.id)+'</span> <span class="meta">'+esc(s.timestamp||'')+'</span>'+(s.label?'<br><span class="val">'+esc(s.label)+'</span>':'')+(s.note?'<br><span class="meta">'+esc(s.note)+'</span>':'');
      el.appendChild(d);
    }
  }
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
      return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
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

module.exports = { broadcast, start, stop };
