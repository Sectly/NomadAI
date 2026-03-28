/**
 * Example NomadAI module — open/modules/example.js
 *
 * Every module must follow this structure:
 *   - CommonJS (require / module.exports) — no ES module syntax
 *   - A `meta` object describing name, version, description
 *   - All top-level code must be safe to run on require() — no blocking I/O,
 *     no process.exit(), no infinite loops
 *   - Prefer built-in Node/Bun modules over npm packages
 *   - Exported functions receive a single plain-object argument and should
 *     return a value (or a Promise). Errors should be caught internally.
 *
 * ── Full workflow to create and use a module ─────────────────────────────────
 *
 *  1. Snapshot({})
 *       Save current state before making changes.
 *
 *  2. WriteFile({ path: "/open/modules/mymodule.js", content: "..." })
 *       Write your module code.
 *
 *  3. TestModule({ path: "/open/modules/mymodule.js" })
 *       Verify it loads without errors in an isolated subprocess.
 *       If ok=false → Rollback({}) immediately, then fix and retry.
 *
 *  4. TryLoadModule({ path: "/open/modules/mymodule.js" })
 *       Load the module into the running agent. The module's top-level
 *       code runs now. Exports become callable via CallModule.
 *
 *  5. CallModule({ name: "mymodule", fn: "myFunction", args: { key: "value" } })
 *       Call an exported function by name. `name` is the filename without .js.
 *       `args` is a plain object passed as the first argument to the function.
 *       Returns: { ok: boolean, result: any, error?: string }
 *
 *       Examples using this file:
 *         CallModule({ name: "example", fn: "ping", args: {} })
 *         CallModule({ name: "example", fn: "sysinfo", args: {} })
 *
 *  6. CommitNote({ snapshotId: "<id>", message: "what changed and why" })
 *       Annotate the snapshot you took in step 1.
 *
 *  7. ListModules({})
 *       See all currently loaded modules.
 *
 *  8. TryUnloadModule({ name: "mymodule" })
 *       Unload when no longer needed.
 *
 * ── Notes ────────────────────────────────────────────────────────────────────
 *
 *  - CallModule passes args as the first argument: fn(args)
 *    Design your functions to accept a single object and destructure from it.
 *  - Modules run inside the main agent process. A crash in a module function
 *    is caught by CallModule and returned as ok=false, but side effects
 *    (setInterval, event listeners) run unguarded — clean them up on unload.
 *  - Only modules in /open/modules/ can be loaded.
 */

'use strict';

const os = require('os');

const meta = {
  name: 'example',
  version: '1.0.0',
  description: 'Template demonstrating correct module structure. Safe to load/unload.',
};

let callCount = 0;

// Called via: CallModule({ name: "example", fn: "ping", args: {} })
function ping() {
  callCount += 1;
  return { pong: true, callCount, uptime: process.uptime() };
}

// Called via: CallModule({ name: "example", fn: "sysinfo", args: {} })
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
