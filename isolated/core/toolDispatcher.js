const path = require('path');
const safety = require('./safetyValidator');
const toolCache = require('./toolCache');

let observer = null;
let episodicAppend = null;

const toolModules = {
  filesystem: require('../tools/filesystem'),
  execution: require('../tools/execution'),
  modules: require('../tools/modules'),
  memory: require('../tools/memory'),
  systemInfo: require('../tools/systemInfo'),
  network: require('../tools/network'),
  versioning: require('../tools/versioning'),
  observer: require('../tools/observer'),
};

// Flat registry: ToolName -> handler fn
// Only register async functions whose names start with an uppercase letter —
// this excludes internal wiring helpers like setBroadcast, setWatchBroadcast.
const registry = {};
for (const mod of Object.values(toolModules)) {
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn === 'function' && /^[A-Z]/.test(name)) {
      registry[name] = fn;
    }
  }
}

// Tools that require safety validation
const EXECUTION_TOOLS = new Set(['Execute', 'InstallPackage', 'RemovePackage', 'KillProcess']);

function init(obs, appendEpisodic) {
  observer = obs;
  episodicAppend = appendEpisodic;
}

async function dispatch(toolName, args, ctx) {
  const handler = registry[toolName];
  if (!handler) {
    const result = { ok: false, error: `Unknown tool: ${toolName}` };
    _log(toolName, args, result);
    return result;
  }

  // Safety check for execution-class tools
  if (EXECUTION_TOOLS.has(toolName)) {
    let check = { safe: true };
    if (toolName === 'Execute') check = safety.validateCommand(args.command || '');
    if (toolName === 'KillProcess') check = safety.validatePidKill(args.pid);
    if (toolName === 'InstallPackage') check = safety.validatePackage(args.name || '');

    if (!check.safe) {
      const result = { ok: false, error: `Blocked: ${check.reason}` };
      if (observer) observer.broadcast({ type: 'blocked_action', data: { tool: toolName, args, reason: check.reason } });
      _log(toolName, args, result);
      return result;
    }
  }

  // Return cached result if available — skip episodic logging to avoid noise
  const cached = toolCache.get(toolName, args);
  if (cached !== null) {
    if (observer) observer.broadcast({ type: 'tool_result', data: { tool: toolName, ok: cached.ok, cached: true } });
    return cached;
  }

  if (observer) observer.broadcast({ type: 'tool_call', data: { tool: toolName, args } });

  let result;
  try {
    result = await handler(args, { ...(ctx || {}), listTools });
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  // Cache successful results
  if (result.ok) toolCache.set(toolName, args, result);

  if (observer) observer.broadcast({ type: 'tool_result', data: { tool: toolName, ok: result.ok } });
  _log(toolName, args, result);
  return result;
}

function _log(toolName, args, result) {
  if (!episodicAppend) return;
  const entry = { ts: new Date().toISOString(), tool: toolName, args, ok: result.ok };
  if (!result.ok && result.error) entry.error = result.error;
  if (result.result !== undefined) {
    const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
    if (raw.length <= 1500) {
      entry.result = result.result;
    } else {
      entry.result = raw.slice(0, 1500) + '…';
      entry.truncated = true;
    }
  }
  episodicAppend(entry);
}

function listTools() {
  return Object.keys(registry);
}

module.exports = { dispatch, init, listTools, toolCache };
