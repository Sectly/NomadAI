#!/usr/bin/env bash
set -euo pipefail

# Must be run as root / sudo
if [ "$(id -u)" -ne 0 ]; then
  echo "[error] Run with sudo: sudo ./setup.sh"
  exit 1
fi

# ── Verify OS ──────────────────────────────────────────────────────────────────
if [ ! -f /etc/os-release ]; then
  echo "[error] Cannot detect OS. This script supports Ubuntu 22.04/24.04 LTS and Debian 11/12."
  exit 1
fi

. /etc/os-release

case "${ID}" in
  ubuntu)
    case "${VERSION_CODENAME:-}" in
      jammy|noble) ;;  # 22.04, 24.04
      *)
        echo "[warn] Untested Ubuntu version: ${PRETTY_NAME}. Continuing anyway."
        ;;
    esac
    ;;
  debian)
    case "${VERSION_CODENAME:-}" in
      bullseye|bookworm|trixie) ;;  # 11, 12, 13
      *)
        echo "[warn] Untested Debian version: ${PRETTY_NAME}. Continuing anyway."
        ;;
    esac
    ;;
  *)
    echo "[error] Unsupported OS: ${PRETTY_NAME}. This script targets Debian/Ubuntu LTS."
    exit 1
    ;;
esac

echo "[os] Detected: ${PRETTY_NAME}"

NOMAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_MODEL="${LLM_MODEL:-llama3}"
NOMAD_USER="nomadai"
NOMAD_GROUP="nomadai"
NOMAD_HOME="/home/${NOMAD_USER}"
BUN_HOME="${NOMAD_HOME}/.bun"
BUN_BIN="${BUN_HOME}/bin/bun"
AUTH_FILE="${NOMAD_HOME}/.observer_auth"

# The human user who invoked sudo — this becomes the observer login
REAL_USER="${SUDO_USER:-}"
if [ -z "${REAL_USER}" ]; then
  echo "[error] Could not determine the invoking user (SUDO_USER is empty)."
  echo "        Run with: sudo ./setup.sh  (not as root directly)"
  exit 1
fi

echo "=============================="
echo "  NomadAI Setup"
echo "  OS    : ${PRETTY_NAME}"
echo "  Model : ${LLM_MODEL}"
echo "  Dir   : ${NOMAD_DIR}"
echo "=============================="

# ── System dependencies ────────────────────────────────────────────────────────
echo "[apt] Updating package list..."
apt-get update -qq

echo "[apt] Installing dependencies..."
apt-get install -y --no-install-recommends \
  curl \
  ca-certificates \
  tar \
  gzip \
  git \
  unzip \
  procps \
  lsof \
  ufw \
  logrotate \
  openssl

# ── Create dedicated system user ───────────────────────────────────────────────
if id "${NOMAD_USER}" &>/dev/null; then
  echo "[user] '${NOMAD_USER}' already exists (uid=$(id -u "${NOMAD_USER}"))"
else
  echo "[user] Creating system user '${NOMAD_USER}'..."
  adduser \
    --system \
    --group \
    --home "${NOMAD_HOME}" \
    --shell /bin/bash \
    --gecos "NomadAI agent" \
    "${NOMAD_USER}"
  echo "[user] Created '${NOMAD_USER}' (uid=$(id -u "${NOMAD_USER}"))"
fi

# Ensure home exists with correct ownership
mkdir -p "${NOMAD_HOME}"
chown "${NOMAD_USER}:${NOMAD_GROUP}" "${NOMAD_HOME}"
chmod 750 "${NOMAD_HOME}"

# ── Install Bun as nomadai ─────────────────────────────────────────────────────
if [ -x "${BUN_BIN}" ]; then
  BUN_VER=$(sudo -u "${NOMAD_USER}" "${BUN_BIN}" --version 2>/dev/null || echo "unknown")
  echo "[bun] Already installed for '${NOMAD_USER}': ${BUN_VER}"
else
  echo "[bun] Installing for user '${NOMAD_USER}'..."
  sudo -u "${NOMAD_USER}" \
    HOME="${NOMAD_HOME}" \
    bash -c 'curl -fsSL https://bun.sh/install | bash'
  BUN_VER=$(sudo -u "${NOMAD_USER}" "${BUN_BIN}" --version 2>/dev/null || echo "unknown")
  echo "[bun] Installed: ${BUN_VER}"
fi

# ── Install Ollama ─────────────────────────────────────────────────────────────
if command -v ollama &>/dev/null; then
  echo "[ollama] Already installed: $(ollama --version 2>/dev/null || echo 'unknown')"
else
  echo "[ollama] Installing..."
  curl -fsSL https://ollama.com/install.sh | sh
  echo "[ollama] Installed: $(ollama --version 2>/dev/null || echo 'unknown')"
fi

# ── Enable and start Ollama systemd service ────────────────────────────────────
if systemctl list-unit-files ollama.service &>/dev/null 2>&1; then
  systemctl enable ollama
  systemctl start ollama || true
  echo "[ollama] systemd service enabled and started"
else
  echo "[ollama] No systemd unit found — starting manually..."
  ollama serve &>/tmp/ollama_setup.log &
  sleep 3
fi

# Wait for Ollama API
echo "[ollama] Waiting for API to be ready..."
for i in $(seq 1 20); do
  if curl -sf http://localhost:11434 &>/dev/null; then
    echo "[ollama] API ready"
    break
  fi
  sleep 1
  if [ "${i}" -eq 20 ]; then
    echo "[error] Ollama API did not become ready in time. Check: journalctl -u ollama"
    exit 1
  fi
done

# ── Pull LLM model ─────────────────────────────────────────────────────────────
echo "[ollama] Pulling model '${LLM_MODEL}' (this may take a while)..."
ollama pull "${LLM_MODEL}"
echo "[ollama] Model ready: ${LLM_MODEL}"

# ── Project directory ownership and permissions ────────────────────────────────
echo "[perms] Configuring directory permissions..."

# Grant nomadai traversal (execute-only) on every parent directory up to / so
# it can reach NOMAD_DIR even when the project lives inside a user's home dir.
_dir="${NOMAD_DIR}"
while [ "${_dir}" != "/" ]; do
  _dir="$(dirname "${_dir}")"
  chmod o+x "${_dir}" 2>/dev/null || true
done

# Project root: root owns everything by default
chown root:root "${NOMAD_DIR}"
chmod 755 "${NOMAD_DIR}"

# isolated/ — root:root, world-readable/executable but NOT writable by anyone except root
chown -R root:root "${NOMAD_DIR}/isolated"
find "${NOMAD_DIR}/isolated" -type d -exec chmod 755 {} \;
find "${NOMAD_DIR}/isolated" -type f -exec chmod 644 {} \;

# Read-only files at project root
for f in IDENTITY.md CLAUDE.md package.json; do
  [ -f "${NOMAD_DIR}/${f}" ] && chown root:root "${NOMAD_DIR}/${f}" && chmod 644 "${NOMAD_DIR}/${f}"
done

# open/ — nomadai owns it fully; others have no access
chown -R "${NOMAD_USER}:${NOMAD_GROUP}" "${NOMAD_DIR}/open"
find "${NOMAD_DIR}/open" -type d -exec chmod 750 {} \;
find "${NOMAD_DIR}/open" -type f -exec chmod 640 {} \;

# logs/ — nomadai owns, sudo user can read via group if desired
mkdir -p "${NOMAD_DIR}/logs"
chown -R "${NOMAD_USER}:${NOMAD_GROUP}" "${NOMAD_DIR}/logs"
chmod 750 "${NOMAD_DIR}/logs"

# setup.sh / start.sh / stop.sh — root only can write, others read+execute
chown root:root "${NOMAD_DIR}/setup.sh" "${NOMAD_DIR}/start.sh" "${NOMAD_DIR}/stop.sh"
chmod 755 "${NOMAD_DIR}/setup.sh" "${NOMAD_DIR}/start.sh" "${NOMAD_DIR}/stop.sh"

echo "[perms] Done"
printf "        %-20s %s\n" "isolated/"   "root:root      644/755   (nomadai: read-only)"
printf "        %-20s %s\n" "open/"       "${NOMAD_USER}:${NOMAD_GROUP}  640/750   (nomadai: full control)"
printf "        %-20s %s\n" "logs/"       "${NOMAD_USER}:${NOMAD_GROUP}  750"
printf "        %-20s %s\n" "setup/start" "root:root      755"

# ── Observer auth file ────────────────────────────────────────────────────────
# Extract the shadow hash for REAL_USER and store it where nomadai can read it.
# The agent uses this at runtime to verify the nc password via openssl passwd.
echo "[auth] Configuring observer auth for user '${REAL_USER}'..."

SHADOW_HASH=$(getent shadow "${REAL_USER}" 2>/dev/null | cut -d: -f2 || true)

if [ -z "${SHADOW_HASH}" ] || [ "${SHADOW_HASH}" = "*" ] || [ "${SHADOW_HASH}" = "!" ] || [ "${SHADOW_HASH}" = "!!" ]; then
  echo "[auth] Cannot read shadow hash for '${REAL_USER}' (account may use a key-only login)."
  echo "[auth] Falling back to a generated password for the NC observer."
  GENERATED_PASS=$(openssl rand -base64 18 | tr -d '=/+' | head -c 20)
  GENERATED_HASH=$(openssl passwd -6 "${GENERATED_PASS}")
  printf '%s:%s\n' "${REAL_USER}" "${GENERATED_HASH}" > "${AUTH_FILE}"
  echo ""
  echo "  ┌─────────────────────────────────────────────┐"
  echo "  │  NC Observer password (generated)           │"
  echo "  │  User : ${REAL_USER}"
  echo "  │  Pass : ${GENERATED_PASS}"
  echo "  │  Save this — it will not be shown again.    │"
  echo "  └─────────────────────────────────────────────┘"
  echo ""
else
  printf '%s:%s\n' "${REAL_USER}" "${SHADOW_HASH}" > "${AUTH_FILE}"
  echo "[auth] Shadow hash stored for '${REAL_USER}' — use your sudo password to connect via nc."
fi

# Only nomadai may read it — root owns it so nomadai cannot overwrite it
chown root:"${NOMAD_GROUP}" "${AUTH_FILE}"
chmod 440 "${AUTH_FILE}"
echo "[auth] Auth file: ${AUTH_FILE} (root:${NOMAD_GROUP} 440)"

# ── WebSocket token ────────────────────────────────────────────────────────────
WS_TOKEN_FILE="${NOMAD_HOME}/.observer_ws_token"
if [ -f "${WS_TOKEN_FILE}" ]; then
  WS_TOKEN=$(cat "${WS_TOKEN_FILE}")
  echo "[auth] Existing WS token loaded from ${WS_TOKEN_FILE}"
else
  WS_TOKEN=$(openssl rand -base64 32 | tr -d '=/+\n' | head -c 40)
  printf '%s\n' "${WS_TOKEN}" > "${WS_TOKEN_FILE}"
  chown root:"${NOMAD_GROUP}" "${WS_TOKEN_FILE}"
  chmod 440 "${WS_TOKEN_FILE}"
  echo "[auth] Generated WS token → ${WS_TOKEN_FILE}"
fi

# ── Ensure open/ seed files exist ─────────────────────────────────────────────
# Run as root so we can traverse any parent path (e.g. /home/<user>/NomadAI),
# then fix ownership so nomadai owns everything under open/.
echo "[setup] Seeding open/ directory structure..."
mkdir -p \
  "${NOMAD_DIR}/open/memory" \
  "${NOMAD_DIR}/open/modules" \
  "${NOMAD_DIR}/open/snapshots"

[ -f "${NOMAD_DIR}/open/memory/longTerm.json" ]  || echo '{}' > "${NOMAD_DIR}/open/memory/longTerm.json"
[ -f "${NOMAD_DIR}/open/memory/episodic.json" ] || echo '[]' > "${NOMAD_DIR}/open/memory/episodic.json"
[ -f "${NOMAD_DIR}/open/goals.json" ]           || echo '[]' > "${NOMAD_DIR}/open/goals.json"
[ -f "${NOMAD_DIR}/open/restarts.json" ]        || echo '[]' > "${NOMAD_DIR}/open/restarts.json"

[ -f "${NOMAD_DIR}/open/thoughts.log" ] \
  || touch "${NOMAD_DIR}/open/thoughts.log"

# ── Install project dependencies as nomadai ────────────────────────────────────
cd "${NOMAD_DIR}"
if [ -f package.json ]; then
  echo "[bun] Installing project dependencies as '${NOMAD_USER}'..."
  # node_modules lives in NOMAD_DIR (root:root 755) so nomadai can't create it.
  # Pre-create and hand it off before running bun install.
  mkdir -p "${NOMAD_DIR}/node_modules"
  chown "${NOMAD_USER}:${NOMAD_GROUP}" "${NOMAD_DIR}/node_modules"
  sudo -u "${NOMAD_USER}" \
    HOME="${NOMAD_HOME}" \
    BUN_INSTALL="${BUN_HOME}" \
    "${BUN_BIN}" install
fi

# ── Systemd service ────────────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/nomadai.service"
echo "[systemd] Writing service: ${SERVICE_FILE}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=NomadAI Autonomous Agent
Documentation=file://${NOMAD_DIR}/IDENTITY.md
After=network-online.target ollama.service
Wants=network-online.target ollama.service

[Service]
Type=simple
User=${NOMAD_USER}
Group=${NOMAD_GROUP}
WorkingDirectory=${NOMAD_DIR}
ExecStart=${BUN_BIN} run isolated/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

Environment=LLM_MODEL=${LLM_MODEL}
Environment=LLM_URL=http://localhost:11434/api/chat
Environment=LLM_MOCK=false
Environment=HOME=${NOMAD_HOME}
Environment=BUN_INSTALL=${BUN_HOME}
Environment=PATH=${BUN_HOME}/bin:/usr/local/bin:/usr/bin:/bin
Environment=OBSERVER_AUTH_FILE=${AUTH_FILE}
Environment=OBSERVER_WS_TOKEN=${WS_TOKEN}
Environment=OBSERVER_BIND=${OBSERVER_BIND:-127.0.0.1}

# ── Privilege restrictions ──────────────────────────────────────
NoNewPrivileges=true
PrivateTmp=true

# Filesystem: everything read-only except explicitly allowed paths
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=${NOMAD_DIR}/isolated ${NOMAD_DIR}/IDENTITY.md ${NOMAD_DIR}/CLAUDE.md
ReadWritePaths=${NOMAD_DIR}/open ${NOMAD_DIR}/logs ${NOMAD_HOME}

# Deny access to sensitive system paths
InaccessiblePaths=/root /etc/shadow /etc/sudoers /boot /sys/firmware
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# ── Resource limits ─────────────────────────────────────────────
# Cap RAM to 2 GB — adjust up if using large models via tool calls
MemoryMax=2G
MemorySwapMax=512M
# Cap CPU to 80% of one core during normal operation
CPUQuota=80%
# Limit open file descriptors
LimitNOFILE=4096

# Network: allowed (agent may use Fetch/WebSearch tools)
# Uncomment to fully disable outbound network access:
# PrivateNetwork=true

StandardOutput=append:${NOMAD_DIR}/logs/agent.log
StandardError=append:${NOMAD_DIR}/logs/agent.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nomadai.service
echo "[systemd] nomadai.service enabled (auto-starts on boot)"

# ── UFW firewall ───────────────────────────────────────────────────────────────
if command -v ufw &>/dev/null; then
  echo "[ufw] Configuring firewall..."

  # Detect the host-only interface subnet (VirtualBox default: 192.168.56.0/24)
  # Allow override via OBSERVER_SUBNET env var
  OBSERVER_SUBNET="${OBSERVER_SUBNET:-192.168.56.0/24}"

  # Ensure SSH is allowed before enabling ufw (prevents lockout)
  ufw allow OpenSSH

  # Observer ports: only allow from host-only subnet, not the world
  ufw allow from "${OBSERVER_SUBNET}" to any port 3000 comment 'NomadAI observer UI'
  ufw allow from "${OBSERVER_SUBNET}" to any port 3001 comment 'NomadAI observer WS'
  ufw allow from "${OBSERVER_SUBNET}" to any port 3002 comment 'NomadAI observer NC'

  # Enable (non-interactive)
  ufw --force enable
  echo "[ufw] Enabled — observer ports open to ${OBSERVER_SUBNET} only"
  echo "[ufw] SSH access preserved"
else
  echo "[ufw] ufw not found — skipping firewall setup"
fi

# ── Logrotate ──────────────────────────────────────────────────────────────────
LOGROTATE_CONF="/etc/logrotate.d/nomadai"
echo "[logrotate] Writing config: ${LOGROTATE_CONF}"
cat > "${LOGROTATE_CONF}" <<EOF
${NOMAD_DIR}/logs/agent.log
${NOMAD_DIR}/open/thoughts.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
    su ${NOMAD_USER} ${NOMAD_GROUP}
}
EOF
echo "[logrotate] Logs rotated daily, 14 days retained, compressed"

echo ""
echo "=============================="
echo "  Setup complete!"
echo ""
echo "  Agent user  : ${NOMAD_USER} (uid=$(id -u "${NOMAD_USER}"))"
echo "  Bun         : ${BUN_VER}"
echo "  Model       : ${LLM_MODEL}"
echo "  Dir         : ${NOMAD_DIR}"
echo "  Bind        : ${OBSERVER_BIND:-127.0.0.1}"
echo "  WS token    : ${WS_TOKEN}"
echo ""
echo "  Start now   : sudo ./start.sh"
echo "  Foreground  : sudo ./start.sh --foreground"
echo "  Bind + fg   : sudo OBSERVER_BIND=192.168.56.101 ./start.sh --foreground"
echo "  On boot     : automatic via systemd"
echo "  Observer UI : http://${OBSERVER_BIND:-127.0.0.1}:3000"
echo "  NC stream   : nc ${OBSERVER_BIND:-127.0.0.1} 3002"
echo ""
echo "  To expose observer to host machine, re-run with:"
echo "    sudo OBSERVER_BIND=192.168.56.101 OBSERVER_SUBNET=192.168.56.0/24 ./setup.sh"
echo "=============================="
