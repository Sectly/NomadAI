/**
 * Example NomadAI module — open/modules/example.js
 *
 * Every module must follow this structure:
 *   - CommonJS (require / module.exports) — no ES module syntax
 *   - A `meta` object describing name, version, description
 *   - All top-level code must be safe to run on require() — no blocking I/O,
 *     no process.exit(), no infinite loops
 *   - Prefer built-in Node/Bun modules over npm packages
 *
 * Workflow to create a new module:
 *   1. Snapshot({})                          — save current state
 *   2. WriteFile({ path, content })          — write the module
 *   3. TestModule({ path })                  — verify it loads cleanly
 *   4. If ok=false → Rollback({})            — revert immediately
 *   5. If ok=true  → TryLoadModule({ path }) — activate it
 *   6. CommitNote({ snapshotId, message })   — describe what changed and why
 */

'use strict';

// Built-in modules only — no npm required
const os   = require('os');
const path = require('path');

const meta = {
  name: 'example',
  version: '1.0.0',
  description: 'Template demonstrating correct module structure. Safe to load/unload.',
};

// Module-level state — persists across calls within a session
let callCount = 0;

// Synchronous utility — always wrap in try/catch when calling from outside
function ping() {
  callCount += 1;
  return { pong: true, callCount, uptime: process.uptime() };
}

// Async utility — safe pattern for file or network work
async function sysinfo() {
  try {
    return {
      ok: true,
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      freemem: os.freemem(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { meta, ping, sysinfo };
