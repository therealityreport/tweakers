#!/bin/bash
# Mechanical pass/fail gate for the turn-scoped MCP fleet fix.
#
# Written because the fix was twice declared working on evidence that did not
# prove it: unit tests that invoked the teardown directly, and a fresh-boot
# sample with no fleets to reclaim. This reads live evidence instead and
# refuses to answer "fixed" without it.
#
# Usage: mcp-fleet-acceptance-gate.sh <monitor.log>
#   monitor.log lines: <ts> stacks=<n> <rssMiB> cd=<n> teardowns=<n> skips=<n> activeRollouts2m=<n>
#
# Exit 0 = PASS, 1 = FAIL, 2 = INCONCLUSIVE (not enough evidence yet).
set -uo pipefail

LOG="${1:-}"
[[ -f "$LOG" ]] || { echo "usage: $0 <monitor.log>" >&2; exit 2; }

EXPECTED_BACKEND="6617b5272255f8dcf6edb8d087160aae2b8205cbba0df9f09a941f548799a037"
APP="/Applications/ChatGPT.app"

# --- Precondition: the fix must actually be installed. -----------------------
live_backend="$(shasum -a 256 "$APP/Contents/Resources/codex" 2>/dev/null | cut -d' ' -f1)"
if [[ "$live_backend" != "$EXPECTED_BACKEND" ]]; then
  echo "FAIL: live backend is not the fixed build"
  echo "  expected $EXPECTED_BACKEND"
  echo "  found    ${live_backend:-<missing>}"
  exit 1
fi

renderer_new=$(grep -acF 'zjn=60*1e3' "$APP/Contents/Resources/app.asar" 2>/dev/null | head -1)
renderer_old=$(grep -acF 'zjn=3600*1e3' "$APP/Contents/Resources/app.asar" 2>/dev/null | head -1)
renderer_new=${renderer_new:-0}
renderer_old=${renderer_old:-0}
if [[ "$renderer_new" -lt 1 || "$renderer_old" -ne 0 ]]; then
  echo "FAIL: renderer retention policy is not patched (new=$renderer_new old=$renderer_old)"
  exit 1
fi

# --- Evidence extraction ------------------------------------------------------
# Fields can land on wrapped lines, so pull each key independently.
# bash 3.2 on macOS has no mapfile; use a plain word list.
stacks=$(grep -oE 'stacks=[0-9]+' "$LOG" | cut -d= -f2)
teardowns_last=$(grep -oE 'teardowns=[0-9]+' "$LOG" | cut -d= -f2 | tail -1)
active_last=$(grep -oE 'activeRollouts2m=[0-9]+' "$LOG" | cut -d= -f2 | tail -1)
samples=$(printf '%s\n' "$stacks" | grep -c . )
teardowns_last=${teardowns_last:-0}
active_last=${active_last:-0}

if (( samples < 10 )); then
  echo "INCONCLUSIVE: only $samples samples; need >=10"
  exit 2
fi

# Reclamation can only be judged once work stops. Judging mid-workload would
# call a healthy system broken simply because its subagents are still running.
quiet=$(grep -c 'activeRollouts2m=0' "$LOG")
if (( quiet < 4 )); then
  echo "INCONCLUSIVE: only $quiet idle samples (need >=4 with activeRollouts2m=0)."
  echo "  Fleets are expected while subagents run; let the workload finish, then re-run."
  exit 2
fi

max=0; min=999; last=0
for s in $stacks; do
  (( s > max )) && max=$s
  (( s < min )) && min=$s
  last=$s
done

# Peak must be meaningful, otherwise there was nothing to reclaim and the run
# proves nothing -- this is precisely the fresh-boot false pass from before.
if (( max < 3 )); then
  echo "INCONCLUSIVE: peak was only $max fleets; run real subagent load before judging"
  exit 2
fi

echo "evidence: samples=$samples  peak=$max  min=$min  latest=$last  teardowns=$teardowns_last  activeRollouts=$active_last"

# --- Verdict ------------------------------------------------------------------
# PASS requires observed reclamation: fleets must fall materially below peak.
reclaimed=$(( max - min ))
verdict=0

if (( teardowns_last > 0 )); then
  echo "PASS signal: teardown fired $teardowns_last time(s) (info! line observed)"
else
  echo "note: teardown log line never observed"
fi

if (( reclaimed >= 2 )); then
  echo "PASS signal: fleets fell by $reclaimed from peak $max to $min"
else
  echo "FAIL signal: fleets never fell materially (peak $max, floor $min)"
  verdict=1
fi

# A high floor while idle is the exact production symptom we are chasing.
if (( active_last == 0 && last >= 3 )); then
  echo "FAIL signal: $last fleets still resident with no active rollouts"
  verdict=1
fi

if (( verdict == 0 )); then
  echo "VERDICT: PASS"
else
  echo "VERDICT: FAIL - fleets are not being reclaimed; do not report this fixed"
fi
exit "$verdict"
