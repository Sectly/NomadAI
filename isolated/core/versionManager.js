const path = require('path');
const fs = require('fs');
const { exec } = require('./vmController');

const OPEN_DIR = path.resolve(__dirname, '../../open');
const SNAPSHOTS_DIR = path.join(OPEN_DIR, 'snapshots');

// Maximum number of snapshots to retain. Oldest are pruned automatically.
const MAX_SNAPSHOTS = 20;

function ensureSnapshotsDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

function metaPath(id) {
  return path.join(SNAPSHOTS_DIR, `${id}.json`);
}

async function snapshot(label = '') {
  ensureSnapshotsDir();
  const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tarPath = path.join(SNAPSHOTS_DIR, `${id}.tar.gz`);

  const result = await exec(`tar -czf "${tarPath}" -C "${OPEN_DIR}" --exclude=snapshots .`);
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr };
  }

  let sizeBytes = null;
  try { sizeBytes = fs.statSync(tarPath).size; } catch (_) {}
  const meta = { id, label, timestamp: new Date().toISOString(), note: '', sizeBytes };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

  // Prune oldest snapshots beyond MAX_SNAPSHOTS
  pruneSnapshots();

  return { ok: true, result: meta };
}

function pruneSnapshots() {
  const snapshots = listSnapshots(); // sorted oldest → newest
  const excess = snapshots.length - MAX_SNAPSHOTS;
  for (let i = 0; i < excess; i++) {
    const old = snapshots[i];
    try { fs.unlinkSync(path.join(SNAPSHOTS_DIR, `${old.id}.tar.gz`)); } catch (_) {}
    try { fs.unlinkSync(metaPath(old.id)); } catch (_) {}
  }
}

async function rollback(snapshotId) {
  ensureSnapshotsDir();
  const snapshots = listSnapshots();
  const meta = snapshotId
    ? snapshots.find((s) => s.id === snapshotId)
    : snapshots[snapshots.length - 1];

  if (!meta) return { ok: false, error: 'Snapshot not found' };

  const tarPath = path.join(SNAPSHOTS_DIR, `${meta.id}.tar.gz`);
  if (!fs.existsSync(tarPath)) return { ok: false, error: 'Snapshot archive missing' };

  // Clear open/ except snapshots, then extract
  const result = await exec(
    `find "${OPEN_DIR}" -mindepth 1 -not -path "${SNAPSHOTS_DIR}*" -delete && tar -xzf "${tarPath}" -C "${OPEN_DIR}"`
  );

  if (result.exitCode !== 0) return { ok: false, error: result.stderr };
  // Reset token preset so a restored state doesn't inherit an elevated limit
  try { require('./llmBridge').resetTokenPreset(); } catch (_) {}
  return { ok: true, result: meta };
}

function listSnapshots() {
  ensureSnapshotsDir();
  return fs
    .readdirSync(SNAPSHOTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SNAPSHOTS_DIR, f), 'utf8')))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function diff(fromId, toId) {
  const snapshots = listSnapshots();
  const from = snapshots.find((s) => s.id === fromId);
  if (!from) return { ok: false, error: 'fromId not found' };

  const fromTar = path.join(SNAPSHOTS_DIR, `${from.id}.tar.gz`);
  const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const tmpFrom = `/tmp/nomad_diff_from_${uniq}`;

  await exec(`mkdir -p "${tmpFrom}" && tar -xzf "${fromTar}" -C "${tmpFrom}"`);

  let toDir;
  let tmpTo;
  if (toId) {
    const to = snapshots.find((s) => s.id === toId);
    if (!to) return { ok: false, error: 'toId not found' };
    tmpTo = `/tmp/nomad_diff_to_${uniq}`;
    await exec(`mkdir -p "${tmpTo}" && tar -xzf "${path.join(SNAPSHOTS_DIR, to.id + '.tar.gz')}" -C "${tmpTo}"`);
    toDir = tmpTo;
  } else {
    toDir = OPEN_DIR;
  }

  const result = await exec(`diff -rq "${tmpFrom}" "${toDir}" 2>/dev/null || true`);
  await exec(`rm -rf "${tmpFrom}" ${tmpTo ? `"${tmpTo}"` : ''}`);
  return { ok: true, result: result.stdout };
}

function commitNote(snapshotId, message) {
  const mpath = metaPath(snapshotId);
  if (!fs.existsSync(mpath)) return { ok: false, error: 'Snapshot not found' };
  const meta = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  meta.note = message;
  fs.writeFileSync(mpath, JSON.stringify(meta, null, 2));
  return { ok: true, result: meta };
}

module.exports = { snapshot, rollback, listSnapshots, diff, commitNote, pruneSnapshots };
