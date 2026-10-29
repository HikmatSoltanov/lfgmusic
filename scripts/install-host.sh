#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
node -e "if (process.versions.node.split('.')[0] !== '24') throw new Error('Select Node.js 24 LTS in the hosting panel')"
npm ci --include=dev --no-fund
npm run init:env
npm run build
npm run doctor
echo 'Installation complete. Configure .env / hosting variables before starting. See HOSTING.md.'
