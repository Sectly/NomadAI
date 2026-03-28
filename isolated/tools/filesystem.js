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

async function ReadFile({ path: p }) {
  if (!isAllowedRead(p)) return { ok: false, error: `Read blocked: ${p}` };
  const real = resolvePath(p);
  try {
    const content = fs.readFileSync(real, 'utf8');
    return { ok: true, result: content };
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

// _broadcast is set by index.js after the observer is wired up
let _watchBroadcast = null;
function setWatchBroadcast(fn) { _watchBroadcast = fn; }

async function WatchPath({ path: p, eventTypes = ['change'] }) {
  if (!isAllowedRead(p)) return { ok: false, error: `WatchPath blocked: ${p}` };
  const real = resolvePath(p);
  try {
    fs.watch(real, (event, filename) => {
      if (eventTypes.includes(event) && _watchBroadcast) {
        _watchBroadcast({ type: 'watch', data: { path: p, event, filename } });
      }
    });
    return { ok: true, result: `Watching ${p}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  ReadFile, WriteFile, DeleteFile, MoveFile, CopyFile,
  CheckFile, StatPath, NewDir, ReadDir, CheckDir, DeleteDir, WatchPath,
  setWatchBroadcast,
};
