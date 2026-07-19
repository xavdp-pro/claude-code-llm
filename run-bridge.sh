#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
set -a
source "$ROOT/.env"
set +a
export HOME=/apps/helm-v2
export CLAUDE_WS_BASE="${CLAUDE_WS_BASE:-/apps/helm-v2/ws/claude}"
mkdir -p "$CLAUDE_WS_BASE"
export CLAUDE_BIN="$ROOT/node_modules/.bin/claude"
export PATH="$ROOT/node_modules/.bin:/apps/helm-v2/.local/bin:$PATH"
exec node "$ROOT/server.mjs"
