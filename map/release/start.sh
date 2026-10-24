#!/bin/sh
# Start the map-harness Web service (loopback only).
# Usage: ./start.sh [--port <n>] [--no-open]
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules ]; then
  echo "Dependencies are missing; run ./install.sh first." >&2
  exit 1
fi
exec node map/bin/map-harness.mjs web "$@"
