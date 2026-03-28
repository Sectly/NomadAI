const fs = require('fs');
const path = require('path');

const OPEN_DIR  = path.resolve(__dirname, '../../open');
const GOALS_FILE = path.join(OPEN_DIR, 'goals.json');
const HINTS_FILE = path.join(OPEN_DIR, 'hints.json');

let _broadcast = null;

function setBroadcast(fn) {
  _broadcast = fn;
}

function loadGoals() {
  try { return JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8')); } catch (_) { return []; }
}

function saveGoals(goals) {
  fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2));
}

async function Emit({ type, data }) {
  if (_broadcast) _broadcast({ type, data });
  return { ok: true, result: 'emitted' };
}

async function SetGoal({ goal, priority = 'normal' }) {
  const goals = loadGoals();
  const entry = { goal, priority, createdAt: new Date().toISOString() };
  goals.push(entry);
  saveGoals(goals);
  return { ok: true, result: entry };
}

async function GetGoal() {
  return { ok: true, result: loadGoals() };
}

async function DeleteGoal({ index }) {
  const goals = loadGoals();
  const i = Number(index);
  if (isNaN(i) || i < 0 || i >= goals.length) {
    return { ok: false, error: `Index ${index} out of range (${goals.length} goals)` };
  }
  const removed = goals.splice(i, 1)[0];
  saveGoals(goals);
  return { ok: true, result: removed };
}

async function ClearGoals() {
  saveGoals([]);
  return { ok: true, result: 'All goals cleared' };
}

// ── Hint tools ────────────────────────────────────────────────────────────────
function loadHints() {
  try {
    const h = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch (_) { return []; }
}
function saveHints(hints) {
  fs.writeFileSync(HINTS_FILE, JSON.stringify(hints, null, 2));
}
function updateHint(id, patch) {
  const hints = loadHints();
  const idx = hints.findIndex(h => h.id === id);
  if (idx === -1) return { ok: false, error: `Hint not found: ${id}` };
  Object.assign(hints[idx], patch);
  saveHints(hints);
  return { ok: true, result: hints[idx] };
}

async function RequestHint({ message = '' }) {
  const entry = {
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    message: message.trim() || '(no message)',
    timestamp: new Date().toISOString(),
    type: 'request',
  };
  if (_broadcast) _broadcast({ type: 'hint_request', data: entry });
  // Log to hints file so the observer can see it alongside sent hints
  const hints = loadHints();
  hints.push({ ...entry, seen: true, status: 'request' });
  try { saveHints(hints); } catch (_) {}
  return { ok: true, result: 'Request sent to observer. A response may or may not come.' };
}

async function ListHints({ seen } = {}) {
  const hints = loadHints();
  const filtered = seen === undefined ? hints : hints.filter(h => h.seen === seen);
  return { ok: true, result: filtered };
}

async function HintRead({ id, response } = {}) {
  if (!id) return { ok: false, error: 'id is required' };
  const patch = { seen: true };
  if (response !== undefined && response !== '') patch.response = response;
  else patch.response = '...';
  patch.respondedAt = new Date().toISOString();
  const r = updateHint(id, patch);
  if (r.ok && _broadcast) _broadcast({ type: 'hint_response', data: { id, status: 'read', response: patch.response } });
  return r;
}

async function HintAccept({ id, response = '' }) {
  if (!id) return { ok: false, error: 'id is required' };
  const r = updateHint(id, { seen: true, status: 'accepted', response, respondedAt: new Date().toISOString() });
  if (r.ok && _broadcast) _broadcast({ type: 'hint_response', data: { id, status: 'accepted', response } });
  return r;
}

async function HintReject({ id, response = '' }) {
  if (!id) return { ok: false, error: 'id is required' };
  const r = updateHint(id, { seen: true, status: 'rejected', response, respondedAt: new Date().toISOString() });
  if (r.ok && _broadcast) _broadcast({ type: 'hint_response', data: { id, status: 'rejected', response } });
  return r;
}

// ── Token limit tools ──────────────────────────────────────────────────────────
async function SetTokenLimit({ preset }) {
  const llmBridge = require('../core/llmBridge');
  if (!preset) return { ok: false, error: 'preset is required (low | normal | high)' };
  const ok = llmBridge.setTokenPreset(preset);
  if (!ok) return { ok: false, error: `Unknown preset "${preset}" — use low, normal, or high` };
  const state = llmBridge.getTokenPreset();
  if (_broadcast) _broadcast({ type: 'token_limit', data: state });
  const msg = preset === 'normal'
    ? `Token limit set to normal (${state.numPredict}) — no auto-reset`
    : `Token limit set to ${preset} (${state.numPredict} tokens) — resets to normal in ${state.turnsLeft} turns`;
  return { ok: true, result: msg };
}

async function GetTokenLimit() {
  const llmBridge = require('../core/llmBridge');
  return { ok: true, result: llmBridge.getTokenPreset() };
}

async function SetMood({ mood }) {
  if (_broadcast) _broadcast({ type: 'mood', data: { mood } });
  return { ok: true, result: mood };
}

async function Sleep({ ms }) {
  await new Promise((r) => setTimeout(r, ms));
  return { ok: true, result: `Slept ${ms}ms` };
}

async function SleepUntil({ iso }) {
  const target = new Date(iso).getTime();
  if (isNaN(target)) return { ok: false, error: `Invalid ISO timestamp: ${iso}` };
  const ms = target - Date.now();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  return { ok: true, result: `Resumed at ${new Date().toISOString()}` };
}

async function Introspect() {
  const dispatcher = require('../core/toolDispatcher');
  const memMod = require('./memory');
  const ltResult = await memMod.MemoryRead({ key: '_episodic_summary' });
  const modulesResult = await require('./modules').ListModules();

  return {
    ok: true,
    result: {
      tools: dispatcher.listTools().length,
      loadedModules: modulesResult.result,
      memorySummary: ltResult.result,
      uptime: process.uptime(),
    },
  };
}

async function SelfReport() {
  const introspect = await Introspect();
  const report = `NomadAI status at ${new Date().toISOString()}: uptime=${Math.floor(introspect.result.uptime)}s, tools=${introspect.result.tools}, modules=${introspect.result.loadedModules.length}`;
  if (_broadcast) _broadcast({ type: 'self_report', data: report });
  return { ok: true, result: report };
}

module.exports = { Emit, SetGoal, GetGoal, DeleteGoal, ClearGoals, SetTokenLimit, GetTokenLimit, SetMood, Sleep, SleepUntil, Introspect, SelfReport, RequestHint, ListHints, HintRead, HintAccept, HintReject, setBroadcast };
