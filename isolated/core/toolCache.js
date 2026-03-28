// Tool result cache — avoids redundant re-calls for read-only tools.
// Entries expire after TTL (time) OR max turns, whichever comes first.

const CACHE_TTL_MS   = Number(process.env.TOOL_CACHE_TTL_MS)   || 5 * 60 * 1000; // 5 min
const CACHE_MAX_TURNS = Number(process.env.TOOL_CACHE_MAX_TURNS) || 20;

// Tools with side-effects or that must always be fresh — never cached
const NEVER_CACHE = new Set([
  'Sleep', 'SleepUntil',
  'WriteFile', 'AppendFile', 'DeleteFile', 'MoveFile', 'CopyFile', 'NewDir', 'DeleteDir', 'WatchPath',
  'Execute', 'KillProcess', 'SetEnv', 'InstallPackage', 'RemovePackage', 'Cron', 'CronCancel', 'Stdin',
  'TryLoadModule', 'TryUnloadModule', 'ReloadModule',
  'MemoryWrite', 'MemoryForget', 'MemorySummarise', 'ThoughtLog',
  'SetGoal', 'DeleteGoal', 'ClearGoals', 'SetMood', 'Emit',
  'Snapshot', 'Rollback', 'CommitNote', 'RestoreFile', 'PruneSnapshots',
  'OSRequestRestart', 'HintAccept', 'HintReject', 'HintRead', 'RequestHint',
  'SetTokenLimit',
]);

// key → { result, ts, turn }
const _cache = new Map();
let _turn = 0;

function _key(tool, args) {
  const a = args || {};
  const sorted = Object.keys(a).sort().reduce((o, k) => { o[k] = a[k]; return o; }, {});
  return tool + ':' + JSON.stringify(sorted);
}

function _expired(entry) {
  return (Date.now() - entry.ts) >= CACHE_TTL_MS || (_turn - entry.turn) >= CACHE_MAX_TURNS;
}

function tick() {
  _turn++;
  for (const [key, entry] of _cache) {
    if (_expired(entry)) _cache.delete(key);
  }
}

function get(tool, args) {
  if (NEVER_CACHE.has(tool)) return null;
  const entry = _cache.get(_key(tool, args));
  if (!entry) return null;
  if (_expired(entry)) { _cache.delete(_key(tool, args)); return null; }
  return entry.result;
}

function set(tool, args, result) {
  if (NEVER_CACHE.has(tool)) return;
  _cache.set(_key(tool, args), { result, ts: Date.now(), turn: _turn });
}

function clear(tool) {
  if (tool) {
    const prefix = tool + ':';
    for (const key of _cache.keys()) {
      if (key.startsWith(prefix)) _cache.delete(key);
    }
  } else {
    _cache.clear();
  }
}

function list() {
  const now = Date.now();
  const entries = [];
  for (const [key, entry] of _cache) {
    const colon = key.indexOf(':');
    const tool  = key.slice(0, colon);
    let args;
    try { args = JSON.parse(key.slice(colon + 1)); } catch (_) { args = {}; }
    entries.push({
      tool,
      args,
      ageMs: now - entry.ts,
      turnsAgo: _turn - entry.turn,
      expiresInMs: Math.max(0, CACHE_TTL_MS - (now - entry.ts)),
      expiresInTurns: Math.max(0, CACHE_MAX_TURNS - (_turn - entry.turn)),
    });
  }
  return entries;
}

function size() { return _cache.size; }

module.exports = { get, set, tick, clear, list, size, NEVER_CACHE, CACHE_TTL_MS, CACHE_MAX_TURNS };
