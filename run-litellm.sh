#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
exec "$ROOT/.venv/bin/litellm" --config "$ROOT/litellm-config.yaml" --port "${LITELLM_PORT:-4330}" --host 127.0.0.1
