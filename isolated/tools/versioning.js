const versionManager = require('../core/versionManager');

async function Snapshot({ label = '' }) {
  return versionManager.snapshot(label);
}

async function Rollback({ snapshotId } = {}) {
  return versionManager.rollback(snapshotId);
}

async function ListSnapshots() {
  return { ok: true, result: versionManager.listSnapshots() };
}

async function DiffSnapshot({ fromId, toId }) {
  return versionManager.diff(fromId, toId);
}

async function CommitNote({ snapshotId, message }) {
  return versionManager.commitNote(snapshotId, message);
}

async function RestoreFile({ path: p, snapshotId }) {
  const snapshots = versionManager.listSnapshots();
  const snap = snapshotId
    ? snapshots.find((s) => s.id === snapshotId)
    : snapshots[snapshots.length - 1];

  if (!snap) return { ok: false, error: 'Snapshot not found' };

  const { exec } = require('../core/vmController');
  const OPEN_DIR = require('path').resolve(__dirname, '../../open');
  const SNAP_DIR = require('path').join(OPEN_DIR, 'snapshots');
  const tarPath = require('path').join(SNAP_DIR, `${snap.id}.tar.gz`);
  const tmp = `/tmp/nomad_restore_${Date.now()}`;

  // Strip leading /open/ from path for extraction
  const relPath = p.startsWith('/open/') ? p.slice(6) : p;

  const result = await exec(
    `mkdir -p "${tmp}" && tar -xzf "${tarPath}" -C "${tmp}" "./${relPath}" 2>/dev/null && cp "${tmp}/${relPath}" "${OPEN_DIR}/${relPath}"`
  );
  await exec(`rm -rf "${tmp}"`);

  return { ok: result.exitCode === 0, result: `Restored ${p} from ${snap.id}`, error: result.stderr || undefined };
}

async function PruneSnapshots() {
  versionManager.pruneSnapshots();
  return { ok: true, result: `Snapshots pruned — keeping latest ${20}` };
}

module.exports = { Snapshot, Rollback, ListSnapshots, DiffSnapshot, CommitNote, RestoreFile, PruneSnapshots };
