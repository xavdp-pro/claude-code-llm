#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env"

export OLLAMA_API_KEY
export OPENROUTER_API_KEY
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"

exec "$ROOT/.venv/bin/litellm" \
  --config "$ROOT/litellm-config.yaml" \
  --port "${LITELLM_PORT:-4000}" \
  --host "${LITELLM_BIND:-127.0.0.1}"
