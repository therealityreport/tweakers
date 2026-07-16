#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <private-donor-git-dir> <public-upstream-git-dir>" >&2
  exit 2
fi

destination=$(mktemp)
donor=$(mktemp)
upstream=$(mktemp)
donor_only=$(mktemp)
destination_raw=$(mktemp)
donor_raw=$(mktemp)
upstream_raw=$(mktemp)
trap 'rm -f "$destination" "$donor" "$upstream" "$donor_only" "$destination_raw" "$donor_raw" "$upstream_raw"' EXIT

donor_git_dir=$(cd "$1" && pwd -P)
upstream_git_dir=$(cd "$2" && pwd -P)
git --git-dir="$donor_git_dir" rev-parse --git-dir >/dev/null
git --git-dir="$upstream_git_dir" rev-parse --git-dir >/dev/null
git rev-list --all >"$destination_raw"
git --git-dir="$donor_git_dir" rev-list --all >"$donor_raw"
git --git-dir="$upstream_git_dir" rev-list --all >"$upstream_raw"
sort -u "$destination_raw" >"$destination"
sort -u "$donor_raw" >"$donor"
sort -u "$upstream_raw" >"$upstream"
comm -23 "$donor" "$upstream" >"$donor_only"

if comm -12 "$destination" "$donor_only" | grep -q .; then
  echo "private donor-only history is reachable from a destination ref" >&2
  exit 1
fi

echo "no private donor-only history is reachable"
