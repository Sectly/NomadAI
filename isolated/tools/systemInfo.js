const os = require('os');
const { exec } = require('../core/vmController');
const restartManager = require('../core/restartManager');

async function OSInfo() {
  const result = await exec('uname -a && cat /etc/os-release 2>/dev/null || true');
  return { ok: true, result: { raw: result.stdout, hostname: os.hostname(), arch: os.arch() } };
}

async function BunInfo() {
  const hasBun = typeof Bun !== 'undefined';
  return {
    ok: true,
    result: {
      version: hasBun ? Bun.version : 'not running under Bun',
      entryPath: process.argv[1],
      sector: 'isolated',
    },
  };
}

async function DiskUsage({ path: p = '/' }) {
  const result = await exec(`df -h "${p}" | tail -1`);
  return { ok: result.exitCode === 0, result: result.stdout };
}

async function MemUsage() {
  return {
    ok: true,
    result: {
      total: os.totalmem(),
      free: os.freemem(),
      used: os.totalmem() - os.freemem(),
    },
  };
}

async function CPUInfo() {
  const cpus = os.cpus();
  const loadResult = await exec("cat /proc/loadavg 2>/dev/null || echo 'n/a'");
  return {
    ok: true,
    result: {
      model: cpus[0]?.model || 'unknown',
      cores: cpus.length,
      load: loadResult.stdout,
    },
  };
}

async function NetworkInfo() {
  const ifaces = os.networkInterfaces();
  return { ok: true, result: ifaces };
}

async function Uptime() {
  const secs = os.uptime();
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return { ok: true, result: { seconds: secs, formatted: `${h}h ${m}m ${s}s` } };
}

async function TimeNow() {
  const now = new Date();
  return { ok: true, result: { iso: now.toISOString(), unix: Math.floor(now.getTime() / 1000) } };
}

async function CurrentTime() {
  const now = new Date();
  return { ok: true, result: { time: now.toLocaleTimeString(), iso: now.toISOString(), hours: now.getHours(), minutes: now.getMinutes(), seconds: now.getSeconds() } };
}

async function CurrentDate() {
  const now = new Date();
  return { ok: true, result: { date: now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), iso: now.toISOString().slice(0, 10), year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() } };
}

async function CorePing(args, ctx) {
  return {
    ok: true,
    result: {
      uptime: process.uptime(),
      toolCount: ctx && ctx.listTools ? ctx.listTools().length : 0,
      sandboxed: true,
    },
  };
}

async function OSRequestRestart({ reason }) {
  const req = restartManager.request(reason);
  const evaluated = restartManager.evaluate(req.result.id);
  if (evaluated.result.status === 'approved') {
    return restartManager.execute(evaluated.result.id);
  }
  return evaluated;
}

async function OSListRestarts() {
  return restartManager.list();
}

async function OSLastRestart() {
  return restartManager.last();
}

module.exports = {
  OSInfo, BunInfo, DiskUsage, MemUsage, CPUInfo, NetworkInfo,
  Uptime, TimeNow, CurrentTime, CurrentDate, CorePing, OSRequestRestart, OSListRestarts, OSLastRestart,
};
