#!/usr/bin/env bash
set -euo pipefail
exec runuser -u helm-v2 -- env HOME=/apps/helm-v2 bash /apps/helm-v2/bridge/claude/start-bridge.sh
