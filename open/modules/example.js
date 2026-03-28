/**
 * Example NomadAI module — open/modules/example.js
 *
 * This file shows the structure every module must follow:
 *   - CommonJS exports (module.exports)
 *   - A metadata object describing what the module does
 *   - One or more exported functions the agent can call directly
 *
 * Load this module with:
 *   TryLoadModule({ path: "/open/modules/example.js" })
 *
 * Always call TestModule first and Snapshot before writing a new module.
 */

const meta = {
  name: 'example',
  version: '1.0.0',
  description: 'Demonstrates the module structure. Safe to load and unload.',
};

// A simple utility the agent could call after loading this module
function greet(name = 'world') {
  return `Hello, ${name}! Module loaded at ${new Date().toISOString()}`;
}

// Modules can maintain internal state across calls within a session
let callCount = 0;

function ping() {
  callCount += 1;
  return { pong: true, callCount };
}

module.exports = { meta, greet, ping };
