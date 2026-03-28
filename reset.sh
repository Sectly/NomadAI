#!/usr/bin/env bash
# reset.sh — wipe all NomadAI runtime state and start fresh
# Tool cache is in-memory only and resets automatically on restart.

set -e
OPEN="$(cd "$(dirname "$0")/open" && pwd)"

echo "[reset] Resetting NomadAI state in: $OPEN"

# Memory
echo "{}" > "$OPEN/memory/longTerm.json"
echo "[]" > "$OPEN/memory/episodic.json"
echo "[reset] Memory cleared"

# Logs
> "$OPEN/thoughts.log"
echo "[reset] Thought log cleared"

# Goals, hints, restarts
echo "[]" > "$OPEN/goals.json"
echo "[]" > "$OPEN/hints.json"
echo "[]" > "$OPEN/restarts.json"
echo "[reset] Goals, hints, restarts cleared"

# Snapshots — delete all .tar.gz and .json files inside snapshots/
find "$OPEN/snapshots" -maxdepth 1 \( -name "*.tar.gz" -o -name "*.json" \) -delete 2>/dev/null || true
echo "[reset] Snapshots cleared"

# Modules — delete everything except example.js
find "$OPEN/modules" -maxdepth 1 -type f ! -name "example.js" -delete 2>/dev/null || true
echo "[reset] Modules cleared (example.js preserved)"

echo "[reset] Done. Start NomadAI fresh with: bun run isolated/index.js"
