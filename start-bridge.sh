#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env"

if [[ -z "${CLAUDE_WS_BASE:-}" ]]; then
  CLAUDE_WS_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-ollama/workspaces"
fi
mkdir -p "$CLAUDE_WS_BASE"

export ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_MODEL ANTHROPIC_SMALL_FAST_MODEL CLAUDE_VISION_MODEL
export CLAUDE_BRIDGE_PORT CLAUDE_BRIDGE_BIND CLAUDE_WS_BASE
export CLAUDE_BIN="$ROOT/node_modules/.bin/claude"

exec node "$ROOT/server.mjs"
