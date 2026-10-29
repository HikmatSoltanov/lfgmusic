#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ ! -f dist/src/index.js ]]; then
  echo 'Build missing. Run bash scripts/install-host.sh first.' >&2
  exit 1
fi
exec node dist/src/index.js
