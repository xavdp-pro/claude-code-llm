#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env"
LOG_DIR="$ROOT/log"
mkdir -p "$LOG_DIR"

PORT="${LITELLM_PORT:-4000}"
if ! curl -sf "http://127.0.0.1:${PORT}/health/liveliness" >/dev/null 2>&1; then
  echo "[start-all] Starting LiteLLM on :${PORT}..."
  nohup "$ROOT/start-litellm.sh" >"$LOG_DIR/litellm.log" 2>&1 &
  for _ in $(seq 1 45); do
    curl -sf "http://127.0.0.1:${PORT}/health/liveliness" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "[start-all] Starting claude-bridge..."
exec "$ROOT/start-bridge.sh"
