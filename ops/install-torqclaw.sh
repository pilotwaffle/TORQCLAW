#!/usr/bin/env sh
set -eu
ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$ROOT_DIR"
if ! command -v node >/dev/null 2>&1; then
  echo "[TORQCLAW] Node.js is required. Install Node.js 20.9 or newer." >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a<20||(a===20&&b<9)?1:0)'
node ops/install.mjs
