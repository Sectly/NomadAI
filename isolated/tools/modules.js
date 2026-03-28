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

async function ListModules() {
  const result = [];
  for (const [name, info] of loadedModules.entries()) {
    result.push({ name, path: info.path, loadedAt: info.loadedAt });
  }
  return { ok: true, result };
}

module.exports = { TryLoadModule, TryUnloadModule, ReloadModule, TestModule, ListModules };
