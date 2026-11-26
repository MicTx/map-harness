#!/bin/sh
# Managed uninstall entry; prefers the installed launcher's manage path without a system runtime.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
install_root=
next=
for argument do
  if [ -n "$next" ]; then
    [ -z "$install_root" ] || exit 2
    install_root=$argument
    next=
  elif [ "$argument" = "--install-root" ]; then
    [ -z "$install_root" ] || exit 2
    next=1
  fi
done
[ -z "$next" ] || { echo "uninstall-map: --install-root needs a value." >&2; exit 2; }
if [ -n "$install_root" ] && [ -f "$install_root/map-harness" ] && [ ! -L "$install_root/map-harness" ]; then
  exec "$install_root/map-harness" manage uninstall "$@"
fi
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=mac-arm64 ;;
  Darwin:x86_64) target=mac-x64 ;;
  Linux:aarch64|Linux:arm64) target=linux-arm64 ;;
  Linux:x86_64) target=linux-x64 ;;
  MINGW*:x86_64) target=win-x64 ;;
  *) echo "uninstall-map: unsupported operating system or CPU." >&2; exit 86 ;;
esac
[ ! -L "$root/$target" ] || { echo "uninstall-map: native directory is linked." >&2; exit 87; }
service=
for candidate in "$root/$target"/map-harness-v*-"$target" "$root/$target"/map-harness-v*-"$target".exe; do
  if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
    [ -z "$service" ] || { echo "uninstall-map: multiple native services are present; use a clean package." >&2; exit 87; }
    service=$candidate
  fi
done
if [ -z "$service" ] || [ ! -f "$service.json" ] || [ -L "$service.json" ]; then
  echo "uninstall-map: the unique native service or its build record is missing." >&2
  exit 87
fi
exec "$service" manage uninstall "$@"
