#!/bin/sh
# Install map-harness dependencies (prebuilt release; no compilation).
# Usage: ./install.sh [--registry <url>]
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.19+ or 24+ is required: https://nodejs.org (mirror: https://npmmirror.com/mirrors/node/)" >&2
  exit 1
fi
exec node map/bin/setup.mjs "$@"
