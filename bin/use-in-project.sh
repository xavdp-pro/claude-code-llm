#!/usr/bin/env bash
# Install Claude Code project settings that point at the local LiteLLM gateway.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-.}"
TARGET="$(cd "$TARGET" && pwd)"
DEST="$TARGET/.claude"
TEMPLATE="$ROOT/templates/claude-settings.project.json"

APP_USER="$(stat -c '%U' "$TARGET" 2>/dev/null || echo "")"
if [[ -n "$APP_USER" && "$(id -un)" != "$APP_USER" ]]; then
  echo "[use-in-project] Re-run as app user $APP_USER (turbinobash: avoid root-owned .claude)" >&2
  exec runuser -u "$APP_USER" -- env HOME="$TARGET" bash "$0" "$TARGET"
fi

mkdir -p "$DEST"
if [[ -f "$DEST/settings.json" ]]; then
  cp "$DEST/settings.json" "$DEST/settings.json.bak.$(date +%s)"
  echo "[use-in-project] Backed up existing settings.json"
fi
cp "$TEMPLATE" "$DEST/settings.json"
echo "[use-in-project] Wrote $DEST/settings.json"
echo "[use-in-project] Start the gateway: $ROOT/start-litellm.sh"
echo "[use-in-project] Then in this project: claude"
echo "[use-in-project] Switch model: /model minimax-m3  or  /model or-qwen-coder"
