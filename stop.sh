#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "[error] Run with sudo: sudo ./stop.sh"
  exit 1
fi

NOMAD_USER="nomadai"

echo "=============================="
echo "  NomadAI Stop"
echo "=============================="

# ── Stop agent via systemd if available ───────────────────────────────────────
if systemctl list-unit-files nomadai.service &>/dev/null 2>&1; then
  if systemctl is-active --quiet nomadai.service; then
    echo "[agent] Stopping via systemd..."
    systemctl stop nomadai.service
    echo "[agent] Stopped"
  else
    echo "[agent] nomadai.service is not running"
  fi
else
  # Fallback: signal the process directly so it can shut down gracefully
  if pgrep -u "${NOMAD_USER}" -f "isolated/index.js" &>/dev/null; then
    echo "[agent] Sending SIGTERM to agent process..."
    pkill -u "${NOMAD_USER}" -SIGTERM -f "isolated/index.js" || true

    # Wait up to 15s for clean exit
    for i in $(seq 1 15); do
      if ! pgrep -u "${NOMAD_USER}" -f "isolated/index.js" &>/dev/null; then
        echo "[agent] Process exited cleanly"
        break
      fi
      sleep 1
      if [ "${i}" -eq 15 ]; then
        echo "[agent] Still running after 15s — sending SIGKILL"
        pkill -u "${NOMAD_USER}" -SIGKILL -f "isolated/index.js" || true
      fi
    done
  else
    echo "[agent] No running agent process found"
  fi
fi

# ── Optionally stop Ollama ─────────────────────────────────────────────────────
if [ "${1:-}" = "--with-ollama" ]; then
  if systemctl is-active --quiet ollama 2>/dev/null; then
    echo "[ollama] Stopping ollama service..."
    systemctl stop ollama
    echo "[ollama] Stopped"
  elif pgrep -x ollama &>/dev/null; then
    echo "[ollama] Sending SIGTERM to ollama..."
    pkill -SIGTERM -x ollama || true
    echo "[ollama] Stopped"
  else
    echo "[ollama] Not running"
  fi
fi

echo ""
echo "=============================="
echo "  NomadAI stopped"
echo "  Logs : $(dirname "${BASH_SOURCE[0]}")/logs/agent.log"
echo ""
echo "  Restart : sudo ./start.sh"
if [ "${1:-}" != "--with-ollama" ]; then
  echo "  Full stop (incl. ollama): sudo ./stop.sh --with-ollama"
fi
echo "=============================="
