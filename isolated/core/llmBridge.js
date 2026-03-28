const LLM_URL     = process.env.LLM_URL     || 'http://localhost:11434/api/chat';
const LLM_MODEL   = process.env.LLM_MODEL   || 'llama3';
const LLM_MOCK    = process.env.LLM_MOCK    === 'true';
const LLM_TIMEOUT = Number(process.env.LLM_TIMEOUT_MS) || 120000; // 2 min default

const REQUIRED_FIELDS = ['thought', 'plan', 'tool', 'args'];

// ── Mock responses ─────────────────────────────────────────────────────────────
// Cycles through a realistic sequence so the full agent loop can be tested
// without Ollama. Each call advances the index.
const MOCK_SEQUENCE = [
  { thought: 'I just booted. Let me check the time and orient myself.', plan: 'Call TimeNow to get current timestamp.', tool: 'TimeNow', args: {} },
  { thought: 'Good. Let me check what OS I am running on.', plan: 'Call OSInfo to learn about my environment.', tool: 'OSInfo', args: {} },
  { thought: 'Now I will look at what is in my open/ sector.', plan: 'List the open/ directory.', tool: 'ReadDir', args: { path: '/open/' } },
  { thought: 'I should log this boot to my thought log.', plan: 'Write an entry to ThoughtLog.', tool: 'ThoughtLog', args: { entry: 'Booted successfully. Environment looks clean.' } },
  { thought: 'I have no goals yet. I should set one.', plan: 'Set an initial goal to explore my environment.', tool: 'SetGoal', args: { goal: 'Explore the open/ sector and understand my capabilities', priority: 'high' } },
  { thought: 'Let me check how much disk space I have available.', plan: 'Call DiskUsage on the root path.', tool: 'DiskUsage', args: { path: '/' } },
  { thought: 'I should check my long-term memory for anything from before.', plan: 'Search memory for any prior context.', tool: 'MemorySearch', args: { query: 'boot' } },
  { thought: 'Nothing in memory yet. I will record that I booted cleanly.', plan: 'Write a memory entry about this boot.', tool: 'MemoryWrite', args: { key: 'last_boot', value: new Date().toISOString(), tags: ['system'] } },
  { thought: 'I should take a snapshot before I start making changes.', plan: 'Call Snapshot to save current state.', tool: 'Snapshot', args: { label: 'initial-boot' } },
  { thought: 'Everything looks good. I will sleep briefly before my next action.', plan: 'Sleep for 3 seconds.', tool: 'Sleep', args: { ms: 3000 } },
];

let mockIndex = 0;

function mockCall() {
  const action = MOCK_SEQUENCE[mockIndex % MOCK_SEQUENCE.length];
  mockIndex++;
  return { ok: true, result: { ...action } };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function buildSystemPrompt(identity, memorySummary, toolRef, goals) {
  const goalSection = (Array.isArray(goals) && goals.length)
    ? '\n\n# Current Goals\n' + goals.map((g) => `- [${g.priority || 'normal'}] ${g.goal}`).join('\n')
    : '\n\n# Current Goals\n(none — consider setting one with SetGoal)';
  return [
    identity,
    goalSection,
    '\n\n# Memory Summary\n',
    memorySummary || '(no long-term memory yet)',
    '\n\n# Tool Reference\n',
    toolRef,
  ].join('');
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (_) {}
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) {}
  }
  return null;
}

function validate(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return REQUIRED_FIELDS.every((f) => f in obj);
}

// ── Main call ──────────────────────────────────────────────────────────────────
async function call({ system, messages }) {
  if (LLM_MOCK) return mockCall();

  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [{ role: 'system', content: system }, ...messages],
    stream: false,
  });

  let raw;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT);
    let res;
    try {
      res = await fetch(LLM_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json();
    raw = data?.message?.content || data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    return {
      ok: false,
      error: timedOut ? `LLM request timed out after ${LLM_TIMEOUT}ms` : `LLM request failed: ${err.message}`,
      fallback: { thought: timedOut ? 'LLM timed out' : 'LLM unreachable', plan: 'wait and retry', tool: 'Sleep', args: { ms: 5000 } },
    };
  }

  const parsed = extractJson(raw);
  if (!parsed || !validate(parsed)) {
    return {
      ok: false,
      error: 'Malformed LLM response',
      raw,
      fallback: { thought: 'Could not parse response', plan: 'sleep briefly', tool: 'Sleep', args: { ms: 3000 } },
    };
  }

  return { ok: true, result: parsed };
}

module.exports = { call, buildSystemPrompt };
