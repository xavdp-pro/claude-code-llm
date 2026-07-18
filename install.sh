#!/usr/bin/env bash
# Bootstrap Claude Code + LiteLLM → Ollama Cloud / OpenRouter
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
WITH_SYSTEMD=0
WITH_BRIDGE=1

usage() {
  cat <<EOF
Usage: ./install.sh [--systemd] [--no-bridge]

  Installs Python venv (LiteLLM), npm deps (Claude Code CLI), and .env.
  Optional: systemd user units for litellm (+ bridge).

Options:
  --systemd    Enable and start systemd user services
  --no-bridge  Skip HTTP bridge (LiteLLM + Claude CLI only)
  -h, --help   Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --systemd) WITH_SYSTEMD=1; shift ;;
    --no-bridge) WITH_BRIDGE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  echo "[install] Created $ROOT/.env — set OLLAMA_API_KEY / OPENROUTER_API_KEY"
fi

# shellcheck disable=SC1091
source "$ROOT/.env"
if [[ -z "${CLAUDE_WS_BASE:-}" ]]; then
  CLAUDE_WS_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-llm/workspaces"
  # Persist default into .env if empty
  if grep -q '^CLAUDE_WS_BASE=$' "$ROOT/.env" 2>/dev/null || grep -q '^CLAUDE_WS_BASE=$' "$ROOT/.env"; then
    sed -i "s|^CLAUDE_WS_BASE=.*|CLAUDE_WS_BASE=$CLAUDE_WS_BASE|" "$ROOT/.env"
  elif ! grep -q '^CLAUDE_WS_BASE=' "$ROOT/.env"; then
    echo "CLAUDE_WS_BASE=$CLAUDE_WS_BASE" >>"$ROOT/.env"
  fi
fi
mkdir -p "$CLAUDE_WS_BASE" "${HOME}/.config/claude-bridge"

if [[ ! -x "$ROOT/.venv/bin/litellm" ]]; then
  echo "[install] Creating Python venv + LiteLLM..."
  python3 -m venv "$ROOT/.venv"
  "$ROOT/.venv/bin/pip" install -U pip wheel
  "$ROOT/.venv/bin/pip" install 'litellm[proxy]'
fi

if [[ ! -x "$ROOT/node_modules/.bin/claude" ]]; then
  echo "[install] Installing Claude Code CLI (npm)..."
  (cd "$ROOT" && npm install)
fi

chmod +x "$ROOT"/start-*.sh "$ROOT"/bin/*.sh "$ROOT"/scripts/*.sh 2>/dev/null || true

if [[ "$WITH_SYSTEMD" -eq 1 ]]; then
  mkdir -p "$UNIT_DIR"
  cat >"$UNIT_DIR/claude-litellm.service" <<EOF
[Unit]
Description=LiteLLM proxy for Claude Code (Anthropic → Ollama/OpenRouter)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/start-litellm.sh
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/bin:/bin:${HOME}/.local/bin

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now claude-litellm.service

  if [[ "$WITH_BRIDGE" -eq 1 ]]; then
    cat >"$UNIT_DIR/claude-bridge.service" <<EOF
[Unit]
Description=claude-bridge HTTP API (Claude Code headless)
After=network-online.target claude-litellm.service
Wants=network-online.target
Requires=claude-litellm.service

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/start-bridge.sh
Restart=on-failure
RestartSec=5
Environment=PATH=/usr/bin:/bin:${HOME}/.local/bin

[Install]
WantedBy=default.target
EOF
    systemctl --user enable --now claude-bridge.service
  fi

  echo "[install] systemd: claude-litellm$([ "$WITH_BRIDGE" -eq 1 ] && echo ' + claude-bridge') enabled"
fi

cat <<EOF

[install] Done.

Next:
  1. Edit keys:  nano $ROOT/.env
  2. Start:      $ROOT/start-litellm.sh
     (or full)   $ROOT/start-all.sh
  3. Wire a project:
     $ROOT/bin/use-in-project.sh /path/to/your/project
  4. Run Claude Code in that project:
     cd /path/to/your/project && claude
     # or: $ROOT/node_modules/.bin/claude

Models:  /model minimax-m3   /model or-qwen-coder   /model or-kimi-k2.7-code
Docs:    $ROOT/docs/MODELS.md
EOF
