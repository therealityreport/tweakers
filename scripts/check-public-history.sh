#!/bin/sh
set -eu

patterns='Shad'"GPT\\.git|tweakers-legacy-shadgpt"

for ref in $(git for-each-ref --format='%(refname)' refs/heads refs/tags); do
  if git grep -I -n -E "$patterns" "$ref" -- . \
    ':(exclude)scripts/check-public-history.sh' >/dev/null; then
    echo "private donor repository reference found at $ref" >&2
    exit 1
  fi
done

echo "reachable public-history donor references are clean"
