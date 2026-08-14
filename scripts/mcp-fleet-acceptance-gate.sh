#!/bin/bash
# Compatibility wrapper for the canonical receipt adjudicator.
#
# This shell intentionally has no app path, expected backend digest, renderer
# inspection, process census, or signal authority.  Those facts are accepted
# only when the repository-owned canary receipt binds them to its candidate.
#
# Usage: mcp-fleet-acceptance-gate.sh <absolute-canonical-canary-evidence.json>
# Exit 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE, 64 = invalid invocation.
set -eu

if [[ "$#" -ne 1 || "$1" != /* ]]; then
  echo "usage: $0 <absolute-canonical-canary-evidence.json>" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
exec node --import tsx "$ROOT/packages/installer/src/managed-mcp-canary-adjudicator.ts" "$1"
