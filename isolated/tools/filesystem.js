const fs = require('fs');
const path = require('path');
const safety = require('../core/safetyValidator');

const ALLOWED_READ = ['/open/', '/tmp/'];
const ALLOWED_WRITE = ['/open/'];

// In simulation, remap /open/ and /tmp/ to real paths
const OPEN_DIR = path.resolve(__dirname, '../../open');
const TMP_DIR = require('os').tmpdir();

function resolvePath(p) {
  if (p.startsWith('/open/')) return path.join(OPEN_DIR, p.slice(6));
  if (p.startsWith('/tmp/')) return path.join(TMP_DIR, p.slice(5));
  return p;
}

function isAllowedRead(p) {
  return p.startsWith('/open/') || p.startsWith('/tmp/');
}

function isAllowedWrite(p) {
  return p.startsWith('/open/');
}

async function ReadFile({ path: p, offset, limit }) {
  if (!isAllowedRead(p)) return { ok: false, error: `Read blocked: ${p}` };
  const real = resolvePath(p);
  try {
    const content = fs.readFileSync(real, 'utf8');
    if (offset !== undefined || limit !== undefined) {
      const lines = content.split('\n');
      const start = Number(offset) || 0;
      const slice = limit !== undefined ? lines.slice(start, start + Number(limit)) : lines.slice(start);
      return { ok: true, result: slice.join('\n'), totalLines: lines.length, offset: start };
    }
    return { ok: true, result: content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function AppendFile({ path: p, content }) {
  if (!isAllowedWrite(p)) return { ok: false, error: `Write blocked: ${p}` };
  const check = safety.validateWritePath(p);
  if (!check.safe) return { ok: false, error: check.reason };
  const real = resolvePath(p);
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.appendFileSync(real, content, 'utf8');
    return { ok: true, result: 'appended' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function WriteFile({ path: p, content }) {
  if (!isAllowedWrite(p)) return { ok: false, error: `Write blocked: ${p}` };
  const check = safety.validateWritePath(p);
  if (!check.safe) return { ok: false, error: check.reason };
  const real = resolvePath(p);
  try {
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, content, 'utf8');
    return { ok: true, result: 'written' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function DeleteFile({ path: p }) {
  if (!isAllowedWrite(p)) return { ok: false, error: `Delete blocked: ${p}` };
  const real = resolvePath(p);
  try {
    fs.unlinkSync(real);
    return { ok: true, result: 'deleted' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function MoveFile({ from, to }) {
  if (!isAllowedWrite(from) || !isAllowedWrite(to)) return { ok: false, error: 'Both paths must be in /open/' };
  try {
    fs.renameSync(resolvePath(from), resolvePath(to));
    return { ok: true, result: 'moved' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function CopyFile({ from, to }) {
  if (!isAllowedRead(from)) return { ok: false, error: `Read blocked: ${from}` };
  if (!isAllowedWrite(to))  return { ok: false, error: 'Destination must be in /open/' };
  try {
    fs.copyFileSync(resolvePath(from), resolvePath(to));
    return { ok: true, result: 'copied' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function CheckFile({ path: p }) {
  const real = resolvePath(p);
  try {
    const stat = fs.statSync(real);
    return { ok: true, result: { exists: true, size: stat.size, modified: stat.mtime } };
  } catch (_) {
    return { ok: true, result: { exists: false } };
  }
}

async function StatPath({ path: p }) {
  const real = resolvePath(p);
  try {
    const stat = fs.statSync(real);
    return { ok: true, result: stat };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function NewDir({ path: p }) {
  if (!isAllowedWrite(p)) return { ok: false, error: `NewDir blocked: ${p}` };
  try {
    fs.mkdirSync(resolvePath(p), { recursive: true });
    return { ok: true, result: 'created' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ReadDir({ path: p }) {
  const real = resolvePath(p);
  try {
    const entries = fs.readdirSync(real).map((name) => {
      const stat = fs.statSync(path.join(real, name));
      return { name, size: stat.size, modified: stat.mtime, isDir: stat.isDirectory() };
    });
    return { ok: true, result: entries };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function CheckDir({ path: p }) {
  const real = resolvePath(p);
  try {
    const entries = fs.readdirSync(real);
    return { ok: true, result: { exists: true, fileCount: entries.length } };
  } catch (_) {
    return { ok: true, result: { exists: false, fileCount: 0 } };
  }
}

async function DeleteDir({ path: p, recursive = false }) {
  if (!isAllowedWrite(p)) return { ok: false, error: `DeleteDir blocked: ${p}` };
  try {
    fs.rmSync(resolvePath(p), { recursive });
    return { ok: true, result: 'deleted' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function toVirtualPath(realAbs) {
  if (realAbs.startsWith(OPEN_DIR)) return '/open/' + realAbs.slice(OPEN_DIR.length + 1).replace(/\\/g, '/');
  if (realAbs.startsWith(TMP_DIR))  return '/tmp/'  + realAbs.slice(TMP_DIR.length  + 1).replace(/\\/g, '/');
  return realAbs;
}

async function GrepFiles({ path: p, pattern, recursive = false }) {
  const real = resolvePath(p);
  let re;
  try { re = new RegExp(pattern); } catch (e) { return { ok: false, error: `Invalid pattern: ${e.message}` }; }
  const results = [];
  function searchFile(abs) {
    try {
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (re.test(line)) results.push({ file: toVirtualPath(abs), line: i + 1, content: line });
      });
    } catch (_) {}
  }
  function searchDir(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isFile()) searchFile(abs);
      else if (e.isDirectory() && recursive) searchDir(abs);
    }
  }
  try {
    const stat = fs.statSync(real);
    if (stat.isDirectory()) searchDir(real);
    else searchFile(real);
    return { ok: true, result: results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ListFiles({ path: p, recursive = false }) {
  const real = resolvePath(p);
  const files = [];
  function collect(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isFile()) {
        const stat = fs.statSync(abs);
        files.push({ name: e.name, path: toVirtualPath(abs), absolutePath: abs, size: stat.size, modified: stat.mtime });
      } else if (e.isDirectory() && recursive) {
        collect(abs);
      }
    }
  }
  try {
    collect(real);
    return { ok: true, result: files };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ListDirs({ path: p }) {
  const real = resolvePath(p);
  try {
    const entries = fs.readdirSync(real, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const abs = path.join(real, e.name);
        return { name: e.name, path: toVirtualPath(abs), absolutePath: abs };
      });
    return { ok: true, result: dirs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// _broadcast is set by index.js after the observer is wired up
let _watchBroadcast = null;
function setWatchBroadcast(fn) { _watchBroadcast = fn; }

const _watchHandles = new Map();

async function WatchPath({ path: p, eventTypes = ['change'] }) {
  if (!isAllowedRead(p)) return { ok: false, error: `WatchPath blocked: ${p}` };
  const real = resolvePath(p);
  // Close any existing watcher for this path to prevent handle leaks
  if (_watchHandles.has(p)) {
    try { _watchHandles.get(p).close(); } catch (_) {}
    _watchHandles.delete(p);
  }
  try {
    const watcher = fs.watch(real, (event, filename) => {
      if (eventTypes.includes(event) && _watchBroadcast) {
        _watchBroadcast({ type: 'watch', data: { path: p, event, filename } });
      }
    });
    _watchHandles.set(p, watcher);
    return { ok: true, result: `Watching ${p}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ReadFile, AppendFile, WriteFile, DeleteFile, MoveFile, CopyFile,
  CheckFile, StatPath, NewDir, ReadDir, GrepFiles, ListFiles, ListDirs, CheckDir, DeleteDir, WatchPath,
  setWatchBroadcast,
};
