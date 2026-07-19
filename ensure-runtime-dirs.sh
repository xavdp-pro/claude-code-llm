#!/usr/bin/env bash
# Writable runtime dirs for Claude Code under a turbinobash app home (/apps/<app>).
# HOME is /apps/helm-v2 — claude creates $HOME/.claude/session-env at runtime.
set -euo pipefail

HOME="${HOME:-/apps/helm-v2}"
APP_USER="${APP_USER:-helm-v2}"
APP_GROUP="${APP_GROUP:-www-data}"

ensure_dir() {
  local d="$1"
  mkdir -p "$d"
  if [[ -d "$d" ]] && [[ "$(stat -c '%U' "$d")" != "$APP_USER" ]]; then
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      chown "$APP_USER:$APP_GROUP" "$d"
    else
      echo "[ensure-runtime-dirs] WARN: $d not owned by $APP_USER (run as root or tb app sudo/bulldozer helm-v2)" >&2
    fi
  fi
  chmod 2775 "$d" 2>/dev/null || chmod 775 "$d" 2>/dev/null || true
}

ensure_dir "$HOME/nosav"
ensure_dir "$HOME/nosav/claude"
ensure_dir "$HOME/.claude"
ensure_dir "$HOME/.claude/session-env"
ensure_dir "${CLAUDE_WS_BASE:-$HOME/ws/claude}"
ensure_dir "${XDG_CONFIG_HOME:-$HOME/.config}/claude-bridge"
