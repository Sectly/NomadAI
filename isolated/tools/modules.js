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

async function CallModule({ name, fn, args = {} }) {
  if (!name || typeof name !== 'string') return { ok: false, error: 'name is required' };
  if (!fn   || typeof fn   !== 'string') return { ok: false, error: 'fn is required' };

  if (!loadedModules.has(name)) return { ok: false, error: `Module not loaded: ${name}` };

  const { mod } = loadedModules.get(name);

  if (!mod || typeof mod[fn] !== 'function') {
    const exported = mod ? Object.keys(mod).filter(k => typeof mod[k] === 'function').join(', ') : '(none)';
    return { ok: false, error: `Function "${fn}" not found in module "${name}". Exported functions: ${exported || '(none)'}` };
  }

  // args must be a plain object — reject anything that could smuggle in dangerous values
  if (typeof args !== 'object' || Array.isArray(args) || args === null) {
    return { ok: false, error: 'args must be a plain object' };
  }

  try {
    const result = await Promise.resolve(mod[fn](args));
    return { ok: true, result: result ?? null };
  } catch (e) {
    return { ok: false, error: `${name}.${fn} threw: ${e.message}` };
  }
}

// Runs a module as a script in a fresh subprocess and returns its stdout/stderr.
// The module's top-level code executes; anything written to stdout/stderr is captured.
// Hard timeout: 45 seconds.
async function RunModule({ path: p }) {
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

module.exports = { TryLoadModule, TryUnloadModule, ReloadModule, TestModule, RunModule, ListModules, CallModule };
