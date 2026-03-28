#!/usr/bin/env bash
set -euo pipefail

# Must be run as root / sudo
if [ "$(id -u)" -ne 0 ]; then
  echo "[error] Run with sudo: sudo ./start.sh"
  exit 1
fi

# ── Verify OS ──────────────────────────────────────────────────────────────────
if [ -f /etc/os-release ]; then
  . /etc/os-release
  case "${ID}" in
    ubuntu|debian) ;;
    *) echo "[warn] Unsupported OS '${ID}'. Designed for Debian/Ubuntu LTS." ;;
  esac
fi

NOMAD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLM_MODEL="${LLM_MODEL:-llama3}"
LLM_URL="${LLM_URL:-http://localhost:11434/api/chat}"
NOMAD_USER="nomadai"
NOMAD_GROUP="nomadai"
NOMAD_HOME="/home/${NOMAD_USER}"
BUN_BIN="${NOMAD_HOME}/.bun/bin/bun"
LOG_DIR="${NOMAD_DIR}/logs"
OBSERVER_AUTH_FILE="${OBSERVER_AUTH_FILE:-${NOMAD_HOME}/.observer_auth}"
OBSERVER_BIND="${OBSERVER_BIND:-127.0.0.1}"

# Load WS token from file if not already set in env
WS_TOKEN_FILE="${NOMAD_HOME}/.observer_ws_token"
if [ -z "${OBSERVER_WS_TOKEN:-}" ] && [ -f "${WS_TOKEN_FILE}" ]; then
  OBSERVER_WS_TOKEN=$(cat "${WS_TOKEN_FILE}")
fi

# Parse flags
FOREGROUND=false
for arg in "$@"; do
  case "${arg}" in
    --foreground|-f) FOREGROUND=true ;;
    *) echo "[warn] Unknown argument: ${arg}" ;;
  esac
done

echo "=============================="
echo "  NomadAI Start"
[ "${FOREGROUND}" = true ] && echo "  Mode: foreground"
echo "=============================="

# ── Sanity checks ──────────────────────────────────────────────────────────────
if ! id "${NOMAD_USER}" &>/dev/null; then
  echo "[error] User '${NOMAD_USER}' not found. Run: sudo ./setup.sh"
  exit 1
fi

if [ ! -x "${BUN_BIN}" ]; then
  echo "[error] Bun not found at ${BUN_BIN}. Run: sudo ./setup.sh"
  exit 1
fi

if ! command -v ollama &>/dev/null; then
  echo "[error] ollama not found. Run: sudo ./setup.sh"
  exit 1
fi

# ── Security gate — verify permissions before launch ──────────────────────────
echo "[perms] Verifying security boundaries..."

# isolated/ must NOT be writable by nomadai
if sudo -u "${NOMAD_USER}" test -w "${NOMAD_DIR}/isolated" 2>/dev/null; then
  echo "[error] SECURITY VIOLATION: '${NOMAD_USER}' has write access to isolated/"
  echo "        Run: sudo ./setup.sh to restore correct permissions."
  exit 1
fi

# open/ must be writable by nomadai
if ! sudo -u "${NOMAD_USER}" test -w "${NOMAD_DIR}/open" 2>/dev/null; then
  echo "[warn] '${NOMAD_USER}' cannot write to open/ — fixing..."
  chown -R "${NOMAD_USER}:${NOMAD_GROUP}" "${NOMAD_DIR}/open"
  find "${NOMAD_DIR}/open" -type d -exec chmod 750 {} \;
  find "${NOMAD_DIR}/open" -type f -exec chmod 640 {} \;
fi

echo "[perms] OK — isolated/ is read-only, open/ is writable for '${NOMAD_USER}'"

# ── Ensure log dir ─────────────────────────────────────────────────────────────
mkdir -p "${LOG_DIR}"
chown "${NOMAD_USER}:${NOMAD_GROUP}" "${LOG_DIR}"
chmod 750 "${LOG_DIR}"

# ── Start Ollama if not running ────────────────────────────────────────────────
if systemctl is-active --quiet ollama 2>/dev/null; then
  echo "[ollama] systemd service running"
elif pgrep -x ollama &>/dev/null; then
  echo "[ollama] Running as process (pid $(pgrep -x ollama | head -1))"
else
  echo "[ollama] Starting ollama..."
  if systemctl list-unit-files ollama.service &>/dev/null 2>&1; then
    systemctl start ollama
  else
    # Fallback: run as the ollama user if it exists, otherwise root
    if id ollama &>/dev/null; then
      sudo -u ollama ollama serve >>"${LOG_DIR}/ollama.log" 2>&1 &
    else
      ollama serve >>"${LOG_DIR}/ollama.log" 2>&1 &
    fi
  fi

  echo "[ollama] Waiting for API..."
  for i in $(seq 1 20); do
    if curl -sf http://localhost:11434 &>/dev/null; then
      echo "[ollama] Ready"
      break
    fi
    sleep 1
    if [ "${i}" -eq 20 ]; then
      echo "[error] Ollama API did not become ready. Check: journalctl -u ollama"
      exit 1
    fi
  done
fi

# Verify model is present
if ! ollama list 2>/dev/null | grep -q "^${LLM_MODEL}"; then
  echo "[ollama] Model '${LLM_MODEL}' not found locally — pulling..."
  ollama pull "${LLM_MODEL}"
fi
echo "[ollama] Model '${LLM_MODEL}' available"

# ── Stop existing NomadAI processes owned by nomadai ──────────────────────────
if pgrep -u "${NOMAD_USER}" -f "isolated/index.js" &>/dev/null; then
  echo "[agent] Stopping existing agent (owned by '${NOMAD_USER}')..."
  pkill -u "${NOMAD_USER}" -f "isolated/index.js" || true
  sleep 2
fi

# ── Build the agent command ────────────────────────────────────────────────────
AGENT_ENV=(
  env -i
  HOME="${NOMAD_HOME}"
  BUN_INSTALL="${NOMAD_HOME}/.bun"
  PATH="${NOMAD_HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin"
  LLM_MODEL="${LLM_MODEL}"
  LLM_URL="${LLM_URL}"
  LLM_MOCK="${LLM_MOCK:-false}"
  NOMAD_DIR="${NOMAD_DIR}"
  OBSERVER_AUTH_FILE="${OBSERVER_AUTH_FILE}"
  OBSERVER_BIND="${OBSERVER_BIND}"
  OBSERVER_WS_TOKEN="${OBSERVER_WS_TOKEN:-}"
)

# ── Foreground mode ────────────────────────────────────────────────────────────
if [ "${FOREGROUND}" = true ]; then
  echo "[agent] Starting in foreground as '${NOMAD_USER}' (Ctrl+C to stop)..."
  echo ""
  exec sudo -u "${NOMAD_USER}" "${AGENT_ENV[@]}" "${BUN_BIN}" run "${NOMAD_DIR}/isolated/index.js"
fi

# ── Prefer systemd for background mode ────────────────────────────────────────
if systemctl list-unit-files nomadai.service &>/dev/null 2>&1; then
  echo "[agent] Starting via systemd..."
  systemctl start nomadai.service
  sleep 1

  if systemctl is-active --quiet nomadai.service; then
    AGENT_PID=$(systemctl show -p MainPID --value nomadai.service || echo "?")
    echo "[agent] Running via systemd (pid ${AGENT_PID})"
    echo ""
    echo "=============================="
    echo "  NomadAI is running"
    echo "  User        : ${NOMAD_USER}"
    echo "  Manager     : systemd (nomadai.service)"
    echo "  Observer UI : http://localhost:3000"
    echo "  Agent log   : ${LOG_DIR}/agent.log"
    echo ""
    echo "  Stop       : sudo ./stop.sh"
    echo "  Foreground : sudo ./start.sh --foreground"
    echo "  Status     : sudo systemctl status nomadai"
    echo "  Logs       : sudo journalctl -u nomadai -f"
    echo "             : sudo tail -f ${LOG_DIR}/agent.log"
    echo "  NC stream  : nc <host> 3002  (OS user + sudo password)"
    echo "=============================="
    exit 0
  else
    echo "[warn] systemd start failed — falling back to direct launch"
    journalctl -u nomadai --no-pager -n 20 || true
  fi
fi

# ── Direct background launch fallback (no systemd or service failed) ──────────
AGENT_LOG="${LOG_DIR}/agent.log"
echo "[agent] Starting directly as '${NOMAD_USER}'..."

sudo -u "${NOMAD_USER}" "${AGENT_ENV[@]}" \
  "${BUN_BIN}" run "${NOMAD_DIR}/isolated/index.js" \
  >>"${AGENT_LOG}" 2>&1 &

AGENT_PID=$!
disown "${AGENT_PID}"
echo "[agent] Running as '${NOMAD_USER}' (pid ${AGENT_PID})"

echo ""
echo "=============================="
echo "  NomadAI is running"
echo "  User        : ${NOMAD_USER}"
echo "  Observer UI : http://localhost:3000"
echo "  Agent log   : ${AGENT_LOG}"
echo ""
echo "  Stop       : sudo ./stop.sh"
echo "  Foreground : sudo ./start.sh --foreground"
echo "  Tail logs  : sudo tail -f ${AGENT_LOG}"
echo "  NC stream  : nc <host> 3002  (OS user + sudo password)"
echo "=============================="
