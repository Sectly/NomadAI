// Core PIDs that must never be killed
const corePids = new Set([process.pid]);

function getCorePids() {
  return corePids;
}

async function exec(command, timeout = 10000) {
  const proc = Bun.spawn(['bash', '-c', command], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Enforce timeout by racing against a timer
  const result = await Promise.race([
    (async () => {
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
    })(),
    new Promise((resolve) =>
      setTimeout(() => {
        try { proc.kill(); } catch (_) {}
        resolve({ stdout: '', stderr: 'Command timed out', exitCode: -1 });
      }, timeout)
    ),
  ]);

  return result;
}

async function isAlive() {
  const result = await exec('echo ok');
  return result.stdout === 'ok';
}

async function reboot() {
  setTimeout(() => process.exit(0), 500);
  return { ok: true };
}

module.exports = { exec, isAlive, reboot, getCorePids, corePids };
