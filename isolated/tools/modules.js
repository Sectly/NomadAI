const path = require('path');
const fs   = require('fs');
const os   = require('os');

const OPEN_DIR = path.resolve(__dirname, '../../open');
const loadedModules = new Map();

function resolvePath(p) {
  if (p.startsWith('/open/')) return path.join(OPEN_DIR, p.slice(6));
  return p;
}

async function TryLoadModule({ path: p }) {
  if (!p) return { ok: false, error: 'path is required' };
  // Only allow loading from open/modules/ — no escaping to core or system paths
  if (!p.startsWith('/open/modules/')) {
    return { ok: false, error: 'TryLoadModule is restricted to /open/modules/' };
  }
  const real = resolvePath(p);

  // Auto-snapshot before loading so a bad module can be rolled back
  try {
    const vm = require('../core/versionManager');
    await vm.snapshot('pre-module-load');
  } catch (_) {}

  try {
    delete require.cache[require.resolve(real)];
    const mod = require(real);
    const name = path.basename(real, '.js');
    loadedModules.set(name, { path: real, mod, loadedAt: new Date().toISOString() });
    return { ok: true, result: { name, path: real } };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function TryUnloadModule({ name }) {
  if (!loadedModules.has(name)) return { ok: false, error: `Module not loaded: ${name}` };
  const { path: real } = loadedModules.get(name);
  delete require.cache[require.resolve(real)];
  loadedModules.delete(name);
  return { ok: true, result: `Unloaded: ${name}` };
}

async function ReloadModule({ name }) {
  if (!loadedModules.has(name)) return { ok: false, error: `Module not loaded: ${name}` };
  const { path: real } = loadedModules.get(name);
  await TryUnloadModule({ name });
  return TryLoadModule({ path: real });
}

// Spawn a fresh Bun subprocess to test the module in isolation.
// Avoids Bun Worker segfault bugs and stdout capture issues.
async function TestModule({ path: p }) {
  if (!p) return { ok: false, error: 'path is required' };
  const real = resolvePath(p);

  const harness = `
try {
  require(${JSON.stringify(real)});
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\\n');
}
`;

  const tmpFile = path.join(os.tmpdir(), `nomad_test_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, harness);

  try {
    const proc = Bun.spawn([process.execPath, 'run', tmpFile], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const result = await Promise.race([
      (async () => {
        const stdout = await new Response(proc.stdout).text();
        await proc.exited;
        return stdout.trim();
      })(),
      new Promise((resolve) => setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(''); }, 5000)),
    ]);

    fs.unlink(tmpFile, () => {});
    try {
      return JSON.parse(result);
    } catch (_) {
      return { ok: false, error: 'TestModule produced no output' };
    }
  } catch (e) {
    fs.unlink(tmpFile, () => {});
    return { ok: false, error: e.message };
  }
}

// Returns a description of a loaded module's exports:
// - functions with names, async flag, and extracted parameter names
// - non-function exports and their types
// - any meta/info object the module exposes as module.exports.meta (or .info / .describe)
async function InspectModule({ name }) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'name is required' };
  if (!loadedModules.has(name)) return { ok: false, error: `Module not loaded: ${name}` };

  const { mod, path: modPath, loadedAt } = loadedModules.get(name);

  const functions = [];
  const values    = [];

  for (const [key, val] of Object.entries(mod || {})) {
    if (key === '__esModule') continue;
    if (typeof val === 'function') {
      const isAsync = val.constructor?.name === 'AsyncFunction';
      let params = [];
      try {
        const src = val.toString();
        // match (a, b = 1, {c}) style param lists
        const m = src.match(/^(?:async\s+)?(?:function\s*\w*\s*)?\(([^)]*)\)/);
        if (m && m[1].trim()) {
          params = m[1].split(',').map(s => s.trim().replace(/\s*=.*$/, '').replace(/^\{.*\}$/, '{…}')).filter(Boolean);
        }
      } catch (_) {}
      functions.push({ name: key, isAsync, params });
    } else {
      const isObj = typeof val === 'object' && val !== null;
      values.push({ key, type: typeof val, value: isObj ? JSON.stringify(val) : val });
    }
  }

  // Honour a conventional meta export so modules can self-describe
  const meta = mod?.meta ?? mod?.info ?? mod?.describe ?? null;

  return { ok: true, result: { name, path: modPath, loadedAt, functions, values, meta } };
}

const CALL_TIMEOUT_MS = 60000;

async function CallModule({ name, fn, args = {} }) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'name is required' };
  if (!fn   || typeof fn   !== 'string') return { ok: false, error: 'fn is required' };

  if (!loadedModules.has(name)) {
    const loaded = [...loadedModules.keys()];
    return { ok: false, error: `Module not loaded: "${name}". Loaded modules: [${loaded.join(', ') || 'none'}]` };
  }

  const { mod } = loadedModules.get(name);

  if (!mod || typeof mod[fn] !== 'function') {
    const fns  = mod ? Object.keys(mod).filter(k => typeof mod[k] === 'function') : [];
    const vals = mod ? Object.keys(mod).filter(k => typeof mod[k] !== 'function' && k !== '__esModule') : [];
    return {
      ok: false,
      error: `Function "${fn}" not found in "${name}".`,
      result: { availableFunctions: fns, otherExports: vals },
    };
  }

  if (typeof args !== 'object' || Array.isArray(args) || args === null) {
    return { ok: false, error: 'args must be a plain object' };
  }

  let raw;
  try {
    raw = await Promise.race([
      Promise.resolve(mod[fn](args)),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error(`CallModule timed out after ${CALL_TIMEOUT_MS}ms`)), CALL_TIMEOUT_MS)
      ),
    ]);
  } catch (e) {
    return { ok: false, error: `${name}.${fn} threw: ${e.message}` };
  }

  // Ensure the result can be serialised before returning
  try {
    JSON.stringify(raw);
  } catch (_) {
    return { ok: true, result: String(raw), warning: 'Result was not JSON-serialisable — converted to string' };
  }

  return { ok: true, result: raw ?? null };
}

// Runs a module as a script in a fresh subprocess and returns its stdout/stderr.
// The module's top-level code executes; anything written to stdout/stderr is captured.
// Hard timeout: 45 seconds.
async function RunModule({ path: p, name }) {
  // Accept name as a convenience alias: name="example" → path="/open/modules/example.js"
  if (!p && name) p = `/open/modules/${name.replace(/\.js$/, '')}.js`;
  if (!p) return { ok: false, error: 'path or name is required' };
  if (!p.startsWith('/open/modules/')) {
    return { ok: false, error: 'RunModule is restricted to /open/modules/' };
  }
  const real = resolvePath(p);
  if (!fs.existsSync(real)) return { ok: false, error: `File not found: ${p}` };

  const TIMEOUT_MS = 45000;
  try {
    const proc = Bun.spawn([process.execPath, 'run', real], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch (_) {} }, TIMEOUT_MS);

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);

    return {
      ok: !timedOut && exitCode === 0,
      result: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode, timedOut },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function ListModules() {
  const result = [];
  for (const [name, info] of loadedModules.entries()) {
    result.push({ name, path: info.path, loadedAt: info.loadedAt });
  }
  return { ok: true, result };
}

module.exports = { TryLoadModule, TryUnloadModule, ReloadModule, TestModule, RunModule, InspectModule, ListModules, CallModule };
