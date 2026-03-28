const BLOCKED_COMMANDS = [
  'rm -rf /',
  'chmod -R 777 /',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
];

const BLOCKED_WRITE_PATHS = [
  '/isolated/',
  '/root/',
  '/etc/passwd',
  '/etc/shadow',
  '/boot/',
];

const BLOCKED_PACKAGES = [
  'forkbomb',
  'stress',
  'nethogs', // not destructive but keeping list extensible
];

let corePids = new Set();

function setCorePids(pids) {
  corePids = new Set(pids);
}

function validateCommand(command) {
  for (const pattern of BLOCKED_COMMANDS) {
    if (command.includes(pattern)) {
      return { safe: false, reason: `Blocked pattern: ${pattern}` };
    }
  }
  return { safe: true };
}

function validateWritePath(path) {
  for (const blocked of BLOCKED_WRITE_PATHS) {
    if (path.startsWith(blocked)) {
      return { safe: false, reason: `Write blocked to protected path: ${blocked}` };
    }
  }
  return { safe: true };
}

function validatePidKill(pid) {
  if (corePids.has(Number(pid))) {
    return { safe: false, reason: `Cannot kill core PID: ${pid}` };
  }
  return { safe: true };
}

function validatePackage(name) {
  if (BLOCKED_PACKAGES.includes(name.toLowerCase())) {
    return { safe: false, reason: `Package blocked: ${name}` };
  }
  return { safe: true };
}

module.exports = { validateCommand, validateWritePath, validatePidKill, validatePackage, setCorePids };
