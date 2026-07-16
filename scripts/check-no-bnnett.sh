#!/bin/sh
set -eu

if git grep -n 'b-nnett' -- . \
  ':(exclude)CHANGELOG.md' \
  ':(exclude)docs/releases/*' \
  ':(exclude)docs/research/*' \
  ':(exclude)scripts/check-no-bnnett.sh' >/dev/null; then
  echo "disallowed b-nnett distribution identity found" >&2
  exit 1
fi

echo "distribution identity is clean"
