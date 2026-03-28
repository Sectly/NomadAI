const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Worker: Bun implements worker_threads, so this works under both runtimes
const { Worker } = require('worker_threads');

const OPEN_DIR = path.resolve(__dirname, '../../../open');
const loadedModules = new Map();

function resolvePath(p) {
  if (p.startsWith('/open/')) return path.join(OPEN_DIR, p.slice(6));
  return p;
}

async function TryLoadModule({ path: p }) {
  const real = resolvePath(p);
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

// Bun's Worker requires a real file path — write the test harness to a temp
// file, run it, then clean up. The worker posts { ok, error? } to stdout as JSON.
async function TestModule({ path: p }) {
  const real = resolvePath(p);

  const harness = `
const { workerData } = require('worker_threads');
try {
  require(workerData.target);
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\\n');
}
process.exit(0);
`;

  const tmpFile = path.join(os.tmpdir(), `nomad_test_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(tmpFile, harness);

  return new Promise((resolve) => {
    const worker = new Worker(tmpFile, { workerData: { target: real } });
    let output = '';

    worker.stdout?.on('data', (d) => { output += d.toString(); });
    worker.on('exit', () => {
      fs.unlink(tmpFile, () => {});
      try {
        resolve(JSON.parse(output.trim()));
      } catch (_) {
        resolve({ ok: false, error: 'Worker produced no output' });
      }
    });
    worker.on('error', (err) => {
      fs.unlink(tmpFile, () => {});
      resolve({ ok: false, error: err.message });
    });

    setTimeout(() => {
      worker.terminate();
      fs.unlink(tmpFile, () => {});
      resolve({ ok: false, error: 'TestModule timeout' });
    }, 5000);
  });
}

async function ListModules() {
  const result = [];
  for (const [name, info] of loadedModules.entries()) {
    result.push({ name, path: info.path, loadedAt: info.loadedAt });
  }
  return { ok: true, result };
}

module.exports = { TryLoadModule, TryUnloadModule, ReloadModule, TestModule, ListModules };
