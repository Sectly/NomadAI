const fs = require('fs');
const path = require('path');
const { snapshot } = require('./versionManager');
const { reboot } = require('./vmController');

const RESTARTS_FILE = path.resolve(__dirname, '../../open/restarts.json');
const COOLDOWN_MS = 60000;

function load() {
  if (!fs.existsSync(RESTARTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(RESTARTS_FILE, 'utf8'));
}

function save(entries) {
  fs.writeFileSync(RESTARTS_FILE, JSON.stringify(entries, null, 2));
}

function request(reason) {
  const entries = load();
  const id = `restart_${Date.now()}`;
  const entry = { id, reason, timestamp: new Date().toISOString(), status: 'pending' };
  entries.push(entry);
  save(entries);
  return { ok: true, result: entry };
}

function evaluate(requestId) {
  const entries = load();
  const idx = entries.findIndex((e) => e.id === requestId);
  if (idx === -1) return { ok: false, error: 'Request not found' };

  const entry = entries[idx];
  const now = Date.now();

  // Check cooldown
  const recent = entries
    .filter((e) => e.status === 'executed' && e.id !== requestId)
    .map((e) => new Date(e.timestamp).getTime())
    .sort((a, b) => b - a)[0];

  if (recent && now - recent < COOLDOWN_MS) {
    entry.status = 'denied';
    entry.reason_denied = 'Cooldown period not elapsed';
    entries[idx] = entry;
    save(entries);
    return { ok: true, result: entry };
  }

  entry.status = 'approved';
  entries[idx] = entry;
  save(entries);
  return { ok: true, result: entry };
}

async function execute(requestId) {
  const entries = load();
  const idx = entries.findIndex((e) => e.id === requestId);
  if (idx === -1) return { ok: false, error: 'Request not found' };

  const entry = entries[idx];
  if (entry.status !== 'approved') return { ok: false, error: 'Request not approved' };

  const snap = await snapshot('pre-restart');
  entry.snapshotId = snap.result?.id;
  entry.status = 'executed';
  entry.executedAt = new Date().toISOString();
  entries[idx] = entry;
  save(entries);

  await reboot();
  return { ok: true, result: entry };
}

function list() {
  return { ok: true, result: load() };
}

function last() {
  const entries = load();
  return { ok: true, result: entries[entries.length - 1] || null };
}

module.exports = { request, evaluate, execute, list, last };
