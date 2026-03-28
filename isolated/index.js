const fs = require('fs');
const path = require('path');

const llmBridge = require('./core/llmBridge');
const dispatcher = require('./core/toolDispatcher');
const observerServer = require('./core/observerServer');
const observerTools = require('./tools/observer');
const filesystemTools = require('./tools/filesystem');
const safety = require('./core/safetyValidator');
const vmController = require('./core/vmController');
const TOOL_REF = require('./tools/toolRef');

const OPEN_DIR = path.resolve(__dirname, '../open');
const IDENTITY_FILE = path.resolve(__dirname, '../IDENTITY.md');
const EP_FILE    = path.join(OPEN_DIR, 'memory/episodic.json');
const HINTS_FILE = path.join(OPEN_DIR, 'hints.json');

const MAX_EPISODIC = 50;

// Start observer servers (explicit — not on require)
observerServer.start();

// Register core PIDs so the safety validator can block kill attempts against them
safety.setCorePids(vmController.corePids);

// Wire observer broadcast into tools
observerTools.setBroadcast(observerServer.broadcast);
filesystemTools.setWatchBroadcast((event) => {
  observerServer.broadcast(event);
  // Surface file-watch events in the agent's episodic history so it can react
  appendEpisodic({ ts: new Date().toISOString(), tool: 'WatchPath:event', args: event.data, ok: true });
});

// Wire dispatcher with observer + episodic append
dispatcher.init(observerServer, appendEpisodic);

function appendEpisodic(entry) {
  let ep = [];
  try { ep = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); } catch (_) {}
  ep.push(entry);
  fs.writeFileSync(EP_FILE, JSON.stringify(ep, null, 2));
}

function loadIdentity() {
  try { return fs.readFileSync(IDENTITY_FILE, 'utf8'); } catch (_) { return '# Identity not found'; }
}

function loadPendingHints() {
  try {
    const hints = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8'));
    return Array.isArray(hints) ? hints.filter(h => !h.seen) : [];
  } catch (_) { return []; }
}

function markHintsSeen(ids) {
  try {
    const hints = JSON.parse(fs.readFileSync(HINTS_FILE, 'utf8'));
    if (!Array.isArray(hints)) return;
    for (const h of hints) { if (ids.includes(h.id)) h.seen = true; }
    fs.writeFileSync(HINTS_FILE, JSON.stringify(hints, null, 2));
  } catch (_) {}
}

function loadGoals() {
  try {
    const goals = JSON.parse(fs.readFileSync(path.join(OPEN_DIR, 'goals.json'), 'utf8'));
    return Array.isArray(goals) ? goals : [];
  } catch (_) { return []; }
}

function loadMemorySummary() {
  try {
    const lt = JSON.parse(fs.readFileSync(path.join(OPEN_DIR, 'memory/longTerm.json'), 'utf8'));
    const summary = lt['_episodic_summary'];
    if (!summary) return null;
    return typeof summary.value === 'string' ? summary.value : JSON.stringify(summary.value);
  } catch (_) { return null; }
}

function getRecentHistory(limit = 10) {
  try {
    const ep = JSON.parse(fs.readFileSync(EP_FILE, 'utf8'));
    return ep.slice(-limit);
  } catch (_) { return []; }
}

async function boot() {
  console.log('[NomadAI] Booting...');
  observerServer.broadcast({ type: 'boot', data: { timestamp: new Date().toISOString() } });

  // Check last restart
  const lastRestart = await dispatcher.dispatch('OSLastRestart', {});
  if (lastRestart.ok && lastRestart.result) {
    console.log('[NomadAI] Last restart:', lastRestart.result);
  }
}

// Full-fidelity result from the previous turn — replaces the last truncated history
// feedback so the LLM always sees the complete output of its most recent action.
let _pendingResult = null;

async function loop() {
  const identity = loadIdentity();
  const memorySummary = loadMemorySummary();
  const goals = loadGoals();
  const history = getRecentHistory();

  const systemPrompt = llmBridge.buildSystemPrompt(identity, memorySummary, TOOL_REF, goals);

  // Build messages from recent history
  const messages = [];
  for (const entry of history) {
    messages.push({
      role: 'assistant',
      content: JSON.stringify({ thought: '...', plan: '...', tool: entry.tool, args: entry.args }),
    });
    const feedback = { ok: entry.ok };
    if (entry.error)                feedback.error  = entry.error;
    if (entry.result !== undefined) feedback.result = entry.result;
    messages.push({ role: 'user', content: JSON.stringify(feedback) });
  }

  // Replace the last (potentially truncated) history feedback with the full-fidelity
  // result stored from the previous iteration, so the model sees complete output.
  if (_pendingResult !== null && messages.length >= 2) {
    messages[messages.length - 1] = { role: 'user', content: JSON.stringify(_pendingResult) };
    _pendingResult = null;
  } else {
    messages.push({ role: 'user', content: 'Continue.' });
  }

  // Inject any unseen observer hints as an optional nudge.
  // The agent is free to act on them, ignore them, or acknowledge and move on.
  const pendingHints = loadPendingHints();
  if (pendingHints.length) {
    const hintLines = pendingHints.map(h => `- "${h.text}"  (sent ${h.timestamp})`).join('\n');
    messages.push({
      role: 'user',
      content: `[Observer hints — you may act on these or ignore them entirely]\n${hintLines}`,
    });
    markHintsSeen(pendingHints.map(h => h.id));
  }

  console.log('[NomadAI] Calling LLM...');
  const llmResult = await llmBridge.call({ system: systemPrompt, messages });

  let action;
  if (!llmResult.ok) {
    console.warn('[NomadAI] LLM error:', llmResult.error);
    action = llmResult.fallback;
  } else {
    action = llmResult.result;
  }

  observerServer.broadcast({ type: 'thought', data: action.thought });
  observerServer.broadcast({ type: 'plan', data: action.plan });

  console.log(`[thought] ${action.thought}`);
  console.log(`[plan]    ${action.plan}`);
  console.log(`[tool]    ${action.tool}(${JSON.stringify(action.args)})`);

  const result = await dispatcher.dispatch(action.tool, action.args);

  // Persist full-fidelity result for the next loop iteration
  _pendingResult = { ok: result.ok };
  if (result.error)                _pendingResult.error  = result.error;
  if (result.result !== undefined) _pendingResult.result = result.result;

  console.log(`[result]  ok=${result.ok}`, result.error || '');

  // Auto-summarise episodic memory if getting long
  let ep = [];
  try { ep = JSON.parse(fs.readFileSync(EP_FILE, 'utf8')); } catch (_) {}
  if (ep.length >= MAX_EPISODIC) {
    await dispatcher.dispatch('MemorySummarise', {});
  }
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[NomadAI] ${signal} received — shutting down gracefully...`);

  try {
    console.log('[NomadAI] Taking snapshot before exit...');
    await dispatcher.dispatch('Snapshot', { label: `shutdown-${signal.toLowerCase()}` });
  } catch (err) {
    console.error('[NomadAI] Snapshot failed during shutdown:', err.message);
  }

  try {
    console.log('[NomadAI] Flushing episodic memory...');
    await dispatcher.dispatch('MemorySummarise', {});
  } catch (_) {}

  observerServer.broadcast({ type: 'shutdown', data: { signal, timestamp: new Date().toISOString() } });
  observerServer.stop();

  console.log('[NomadAI] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Global error guards — keep the process alive if an AI module or async
// callback throws outside the main loop. Log it and emit to observer.
process.on('uncaughtException', (err) => {
  console.error('[NomadAI] Uncaught exception:', err.message);
  try { observerServer.broadcast({ type: 'error', data: { kind: 'uncaught_exception', message: err.message } }); } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error('[NomadAI] Unhandled rejection:', msg);
  try { observerServer.broadcast({ type: 'error', data: { kind: 'unhandled_rejection', message: msg } }); } catch (_) {}
});

async function main() {
  try {
    await boot();
  } catch (err) {
    console.error('[NomadAI] Boot error (continuing anyway):', err.message);
  }

  let consecutiveErrors = 0;

  while (!shuttingDown) {
    try {
      await loop();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error('[NomadAI] Loop error:', err.message);
      // Exponential backoff capped at 30s so a persistent error doesn't spin-loop
      const backoff = Math.min(consecutiveErrors * 3000, 30_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

main().catch((err) => {
  console.error('[NomadAI] Fatal:', err);
  process.exit(1);
});
