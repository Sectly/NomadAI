const { exec } = require('../core/vmController');
const os = require('os');

const cronJobs = new Map();

async function Execute({ command, cwd, timeout = 10000 }) {
  // cwd remapping
  if (cwd) {
    const OPEN_DIR = require('path').resolve(__dirname, '../../open');
    if (cwd.startsWith('/open/')) cwd = require('path').join(OPEN_DIR, cwd.slice(6));
  }
  const result = await exec(cwd ? `cd "${cwd}" && ${command}` : command, timeout);
  return { ok: result.exitCode === 0, result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } };
}

async function KillProcess({ pid }) {
  if (!/^\d+$/.test(String(pid))) return { ok: false, error: `Invalid pid: ${pid}` };
  const result = await exec(`kill -- ${pid}`);
  return { ok: result.exitCode === 0, result: result.stdout, error: result.stderr || undefined };
}

async function ListProcesses() {
  const result = await exec(`ps aux --no-header | awk '{print $1,$2,$3,$4,$11}'`);
  if (result.exitCode !== 0) return { ok: false, error: result.stderr };
  const processes = result.stdout.split('\n').filter(Boolean).map((line) => {
    const [user, pid, cpu, mem, ...nameParts] = line.split(' ');
    return { user, pid: Number(pid), cpu: parseFloat(cpu), mem: parseFloat(mem), name: nameParts.join(' ') };
  });
  return { ok: true, result: processes };
}

async function GetEnv({ key }) {
  if (key) return { ok: true, result: process.env[key] || null };
  return { ok: true, result: process.env };
}

async function SetEnv({ key, value }) {
  process.env[key] = value;
  return { ok: true, result: `${key}=${value}` };
}

async function InstallPackage({ name, manager = 'apt' }) {
  let cmd;
  if (manager === 'apt') cmd = `apt-get install -y ${name}`;
  else if (manager === 'npm') cmd = `npm install -g ${name}`;
  else return { ok: false, error: `Unknown manager: ${manager}` };
  const result = await exec(cmd, 60000);
  return { ok: result.exitCode === 0, result: result.stdout, error: result.stderr || undefined };
}

async function RemovePackage({ name, manager = 'apt' }) {
  let cmd;
  if (manager === 'apt') cmd = `apt-get remove -y ${name}`;
  else if (manager === 'npm') cmd = `npm uninstall -g ${name}`;
  else return { ok: false, error: `Unknown manager: ${manager}` };
  const result = await exec(cmd, 30000);
  return { ok: result.exitCode === 0, result: result.stdout };
}

async function ListPackages({ manager = 'apt' }) {
  let cmd;
  if (manager === 'apt') cmd = `dpkg --list | awk '{print $2, $3}'`;
  else if (manager === 'npm') cmd = `npm list -g --depth=0`;
  else return { ok: false, error: `Unknown manager: ${manager}` };
  const result = await exec(cmd);
  return { ok: result.exitCode === 0, result: result.stdout };
}

// Schedule a repeating command by interval.
// `schedule` is a human-readable duration string: "30s", "5m", "2h"
// Examples: Cron({ id: "heartbeat", schedule: "1m", command: "date >> /tmp/hb.log" })
async function Cron({ schedule, command, id }) {
  if (!id)       return { ok: false, error: 'id is required' };
  if (!command)  return { ok: false, error: 'command is required' };

  const str = String(schedule || '').trim().toLowerCase();
  let ms;
  if      (str.endsWith('ms')) ms = parseInt(str);
  else if (str.endsWith('s'))  ms = parseInt(str) * 1000;
  else if (str.endsWith('m'))  ms = parseInt(str) * 60_000;
  else if (str.endsWith('h'))  ms = parseInt(str) * 3_600_000;
  else                         ms = parseInt(str);   // bare number = ms

  if (!ms || ms < 1000) return { ok: false, error: `Invalid schedule "${schedule}". Use "30s", "5m", "2h", etc. Minimum 1s.` };

  if (cronJobs.has(id)) {
    clearInterval(cronJobs.get(id));
    cronJobs.delete(id);
  }

  const handle = setInterval(() => exec(command).catch(() => {}), ms);
  cronJobs.set(id, handle);
  return { ok: true, result: `Cron "${id}" scheduled every ${schedule} → ${command}` };
}

async function Stdin({ pid, input }) {
  if (!/^\d+$/.test(String(pid))) return { ok: false, error: `Invalid pid: ${pid}` };
  // Use printf and pass input via a here-string to avoid shell injection
  const proc = Bun.spawn(['bash', '-c', `printf '%s\n' "$INPUT" > /proc/${pid}/fd/0`], {
    env: { ...process.env, INPUT: String(input) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const exitCode = await Promise.race([
    proc.exited,
    new Promise((_, rej) => setTimeout(() => { try { proc.kill(); } catch (_) {} rej(new Error('Stdin timeout')); }, 5000)),
  ]).catch((e) => { return { timedOut: true, message: e.message }; });
  if (typeof exitCode === 'object' && exitCode?.timedOut) {
    return { ok: false, error: exitCode.message };
  }
  return { ok: exitCode === 0, result: exitCode === 0 ? 'sent' : 'failed' };
}

module.exports = {
  Execute, KillProcess, ListProcesses, GetEnv, SetEnv,
  InstallPackage, RemovePackage, ListPackages, Cron, Stdin,
};
