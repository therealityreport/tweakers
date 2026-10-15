#!/usr/bin/env bash
set -euo pipefail

REPO="${TWEAKER_REPO:-${CODEX_PLUSPLUS_REPO:-therealityreport/tweakers}}"
REF="${TWEAKER_REF:-${CODEX_PLUSPLUS_REF:-main}}"

fail() {
  echo "[!] $1" >&2
  echo "    Paste this error into Codex if you need help." >&2
  exit 1
}

require_command() {
  local cmd="$1"
  local message="$2"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "$message"
  fi
}

# Dependency restoration and local-operation records belong to the user.
if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && [ -f "${BASH_SOURCE[0]}" ]; then
    exec sudo -H -u "$SUDO_USER" /bin/bash "${BASH_SOURCE[0]}" "$@"
  fi
  fail "Run the installer as your login user without sudo."
fi

if [[ -n "${TWEAKER_SOURCE_DIR:-}" ]]; then
  INSTALL_DIR="$TWEAKER_SOURCE_DIR"
elif [[ -n "${CODEX_PLUSPLUS_SOURCE_DIR:-}" ]]; then
  INSTALL_DIR="$CODEX_PLUSPLUS_SOURCE_DIR"
elif [[ -d "$HOME/.codex-plusplus/source" && ! -d "$HOME/.tweaker/source" ]]; then
  INSTALL_DIR="$HOME/.codex-plusplus/source"
else
  INSTALL_DIR="$HOME/.tweaker/source"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js 22.13+ or 24+ is required but node was not found."
fi

if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit((major===22 && minor>=13)||major>=24 ? 0 : 1)'; then
  fail "Node.js 22.13+ or 24+ is required; found $(node -v)."
fi
require_command xcode-select "Xcode Command Line Tools are required; run xcode-select --install."
xcode-select -p >/dev/null 2>&1 || fail "Install Xcode Command Line Tools with xcode-select --install."
export ELECTRON_SKIP_BINARY_DOWNLOAD=1

require_command npm "npm is required to build tweaker from GitHub source."
require_command curl "curl is required to download tweaker from GitHub."
require_command tar "tar is required to unpack the tweaker download."

WORK="$(mktemp -d "${TMPDIR:-/tmp}/tweaker.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

ARCHIVE="$WORK/source.tar.gz"
EXTRACT="$WORK/extract"
NEXT="$WORK/source"

echo "Downloading tweaker from https://github.com/$REPO ($REF)..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$ARCHIVE" ||
  fail "Download failed from https://github.com/$REPO ($REF). Check the repo, branch, and network connection."
mkdir -p "$EXTRACT"
tar -xzf "$ARCHIVE" -C "$EXTRACT" --strip-components 1 ||
  fail "Could not unpack the tweaker download."
mv "$EXTRACT" "$NEXT"

echo "Installing dependencies..."
(
  cd "$NEXT"
  [ -f package-lock.json ] || fail "Downloaded source has no dependency lockfile."
  npm ci --workspaces --include-workspace-root || fail "Locked dependency restoration failed; the lockfile was preserved."

)

echo "Building tweaker..."
(
  cd "$NEXT"
  npm run build || fail "tweaker build failed."
)

mkdir -p "$(dirname "$INSTALL_DIR")"
rm -rf "$INSTALL_DIR.previous"
if [ -d "$INSTALL_DIR" ]; then
  mv "$INSTALL_DIR" "$INSTALL_DIR.previous"
fi
mv "$NEXT" "$INSTALL_DIR"

echo "Running installer..."
node "$INSTALL_DIR/packages/installer/dist/cli.js" install "$@" ||
  fail "tweaker installer failed."

echo
echo "tweaker source installed at: $INSTALL_DIR"
