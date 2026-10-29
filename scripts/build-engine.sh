#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
"${MUSIC_MAVEN_BIN:-mvn}" -B -f audio-engine/pom.xml package
node scripts/update-engine-checksum.mjs
