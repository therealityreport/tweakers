#!/usr/bin/env bash
set -euo pipefail

for command_name in tweaker tweakers codexplusplus codex-plusplus; do
  if command -v "$command_name" >/dev/null 2>&1; then
    exec "$command_name" update "$@"
  fi
done

echo "[!] tweaker is not installed in PATH; running the installer instead." >&2
exec bash -c "$(curl -fsSL https://raw.githubusercontent.com/therealityreport/tweakers/main/install.sh)"
