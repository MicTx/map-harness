#!/bin/sh
# Verify the independently selected native-manager checksum before running this package.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
expected=
manager_digest=
next=
for argument do
  if [ -n "$next" ]; then
    case "$next" in expected) expected=$argument ;; digest) manager_digest=$argument ;; esac
    next=
  else
    case "$argument" in
      --expected) [ -z "$expected" ] || exit 2; next=expected ;;
      --manager-sha256) [ -z "$manager_digest" ] || exit 2; next=digest ;;
    esac
  fi
done
if [ -n "$next" ] || [ -z "$expected" ] || [ ! -f "$expected" ] || [ -L "$expected" ]; then
  echo "install-map: supply --expected with an independently selected release identity file." >&2
  exit 2
fi
case "$manager_digest" in ''|*[!a-f0-9]*) echo "install-map: supply --manager-sha256 from the independently obtained release checksums." >&2; exit 2 ;; esac
[ "${#manager_digest}" = 64 ] || { echo "install-map: --manager-sha256 must contain 64 lowercase hexadecimal characters." >&2; exit 2; }
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=mac-arm64 ;;
  Darwin:x86_64) target=mac-x64 ;;
  Linux:aarch64|Linux:arm64) target=linux-arm64 ;;
  Linux:x86_64) target=linux-x64 ;;
  *) echo "install-map: unsupported operating system or CPU." >&2; exit 86 ;;
esac
[ ! -L "$root/$target" ] || { echo "install-map: native directory is linked." >&2; exit 87; }
service=
for candidate in "$root/$target"/map-harness-v*-"$target"; do
  if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
    [ -z "$service" ] || { echo "install-map: multiple native services are present; use a clean package." >&2; exit 87; }
    service=$candidate
  fi
done
if [ -z "$service" ] || [ ! -f "$service.json" ] || [ -L "$service.json" ]; then
  echo "install-map: the unique native service or its build record is missing." >&2
  exit 87
fi
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum -- "$service")
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 -- "$service")
else echo "install-map: install an OS SHA-256 utility before checking this package." >&2; exit 88
fi
actual=${actual%% *}
[ "$actual" = "$manager_digest" ] || { echo "install-map: native-manager checksum differs; no package code was executed." >&2; exit 89; }
exec "$service" manage install --package-root "$root" "$@"
