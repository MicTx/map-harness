#!/bin/sh
# Locate the target-specific native service for the shared startup flow.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=mac-arm64 ;;
  Darwin:x86_64) target=mac-x64 ;;
  Linux:aarch64) target=linux-arm64 ;;
  Linux:x86_64) target=linux-x64 ;;
  MINGW*:x86_64) target=win-x64 ;;
  *) echo "start-web: unsupported operating system or CPU." >&2; exit 86 ;;
esac
record=$(find "$root/$target" -name '*.json' -type f | head -n 1)
if [ -z "$record" ]; then
  echo "start-web: native build record is missing." >&2
  exit 87
fi
service=${record%.json}
if [ "$target" = win-x64 ]; then service="$service.exe"; fi
exec "$service" --web-onboarding "$@"
