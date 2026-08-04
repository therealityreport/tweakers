#!/usr/bin/env python3
"""
mcp-idle-reaper v2  (file keeps its v1 name: codex-mcp-idle-reaper.py)
======================================================================
Reaps only verified, launchd-owned detached Codex MCP trees.
Runs every 60s via launchd (com.thomashulihan.codex-mcp-idle-reaper).

Why (observed 2026-06-10)
-------------------------
* One shared `codex [flags] app-server` owns the MCP fleets for loaded tasks.
  Process age and global child counts do not prove that any one fleet is
  leaked, so children of a live app-server are observation-only.
* When Codex.app restarts, the signed Node wrapper and its app-server can
  survive as `launchd -> wrapper -> app-server` and keep MCP fleets headless.
* All direct app-server, orphan MCP, node_repl, live Codex-child, and Claude
  lanes are retained only for observation and compatibility reporting.

Rules (each 60s cycle)
----------------------
 1. detached-codex : an exact launchd-owned signed wrapper with one direct
                     app-server child is observed. Any hard non-MCP descendant
                     blocks cleanup; a soft blocker (node/node_repl, or a
                     node/npm/npx/python launcher mentioning "mcp") blocks only
                     while it accrues CPU vs the prior cycle's baseline
                     (strict-detached-v4). Once the same stable tree generation
                     has been free of active blockers for 600 seconds,
                     revalidate identities and terminate the detached tree
                     children-first.
    orphan-codex   : observation-only legacy lane.
    orphan-node_repl: observation-only legacy lane.
 2. orphan-mcp     : observation-only legacy lane.
 3. codex-children : observe only. A live transport can be restored only by
                     restarting its owning task/app, so count/age never kills it.
 4. claude-idle    : observation-only legacy lane.

Safety
------
* curated command signatures only; shell children of sessions are never
  matched even if their command text mentions an MCP name
* this script's own process ancestry is never killed
* the shared devtools Chrome (port 9422) is never killed
* only processes owned by the current uid
* each detached-tree signal requires an immediate fresh identity and descendant
  revalidation; status is published as terminating before the first SIGTERM

Ops
---
  status :  /usr/bin/python3 codex-mcp-idle-reaper.py --status
  test   :  /usr/bin/python3 codex-mcp-idle-reaper.py --dry-run
  off    :  launchctl bootout gui/$UID/com.thomashulihan.codex-mcp-idle-reaper
  on     :  launchctl bootstrap gui/$UID \
              ~/Library/LaunchAgents/com.thomashulihan.codex-mcp-idle-reaper.plist
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from collections import defaultdict
from dataclasses import dataclass, replace
from pathlib import Path

HOME = Path.home()
CODEX = Path(os.environ.get("CODEX_HOME", str(HOME / ".codex")))
TMP = CODEX / "tmp"
LIB = CODEX / "lib"
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))

from codex_mcp_lifecycle import (  # noqa: E402
    LANE_MODES,
    ProcessIdentity,
    ProcessInfo as LifecycleProcess,
    TreeClassification,
    active_blockers,
    advance_lifecycle_state,
    append_jsonl,
    atomic_read_json,
    atomic_write_json,
    build_status,
    children_index,
    classify_codex_trees,
    load_process_snapshot,
    subtree_ids,
)

ORPHAN_MIN_AGE = int(os.environ.get("REAPER_ORPHAN_MIN_AGE", "120"))
NODE_REPL_ORPHAN_MIN_AGE = int(os.environ.get("REAPER_NODE_REPL_ORPHAN_MIN_AGE", "3600"))
CLAUDE_IDLE_SECS = int(os.environ.get("REAPER_CLAUDE_IDLE_SECS", "900"))
CLAUDE_CPU_EPS = float(os.environ.get("REAPER_CLAUDE_CPU_EPS", "2.0"))
DETACHED_IDLE_SECS = int(os.environ.get("REAPER_DETACHED_IDLE_SECS", "600"))
TERM_GRACE_SECS = float(os.environ.get("REAPER_TERM_GRACE_SECS", "5"))
LOG = Path(os.environ.get("REAPER_LOG", str(TMP / "codex-mcp-idle-reaper.log")))
STATE = Path(os.environ.get("REAPER_STATE", str(TMP / "codex-mcp-idle-reaper-state.json")))
LIFECYCLE_STATE = Path(
    os.environ.get("REAPER_LIFECYCLE_STATE", str(TMP / "codex-mcp-lifecycle-state.json"))
)
LIFECYCLE_STATUS = Path(
    os.environ.get("REAPER_LIFECYCLE_STATUS", str(TMP / "codex-mcp-lifecycle-status.json"))
)
LIFECYCLE_ACTIONS = Path(
    os.environ.get("REAPER_LIFECYCLE_ACTIONS", str(TMP / "codex-mcp-lifecycle-actions.jsonl"))
)
# REAPER_PROTECT_NODE_REPL was removed: it only gated mark_tree, which no v2
# lane calls, and it must not interfere with the soft-blocker detached lane.

# Long-lived transports that Codex does not respawn after idle cleanup.
PROTECT_SUBSTR = ("9422", "modal_ops_mcp.py")

# Direct children of a Claude Code session process that count as MCP servers.
CLAUDE_SIGS = (
    "chrome-devtools-mcp",
    "@upstash/context7-mcp",
    "context7-mcp",
    "context7-app-compat",
    "shadcn@latest mcp",
    "shadcn@4 mcp",
    "/.bin/shadcn mcp",
    "scrapling mcp",
    "@wonderwhy-er/desktop-commander",
    "@decodo/mcp-server",
    "decodo-mcp",
    "pdfx-cli",
    "/.bin/pdfx",
    "codex-chrome-devtools-mcp-global.sh",
    "modal_ops_mcp.py",
    "./mcp/server.mjs",
    "./mcp/server.bundle.mjs",
    "server.cjs",
    "server.mjs",
    "xcodebuildmcp",
    "@playwright/mcp",
    "headroom mcp serve",
    "user-questions/mcp-server.js",
    "gsd-pi/packages/mcp-server",
)

# Standalone strays we may meet reparented to launchd (ppid 1).
ORPHAN_SIGS = CLAUDE_SIGS + (
    "telemetry/watchdog/main.js",
    "node_repl",
)

MCP_SIGS = tuple(dict.fromkeys(CLAUDE_SIGS + ORPHAN_SIGS))

# A session child whose executable is a shell is a running user command, never
# an MCP server -- even if its command text mentions one (e.g. a grep for
# "chrome-devtools-mcp" run through the Bash tool).
SHELL_COMMS = ("/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh")

ACTIVITY_FILES = [CODEX / "session_index.jsonl", CODEX / "state_5.sqlite-wal"]


@dataclass
class Proc:
    pid: int
    ppid: int
    rss: int        # KB
    state: str      # ps process state (Z means zombie)
    age: int        # seconds since start
    cpu: float      # cumulative CPU seconds
    comm: str       # executable path (no args)
    args: str       # full command line


def parse_elapsed(value: str) -> int:
    days, clock = 0, value
    if "-" in value:
        d, clock = value.split("-", 1)
        days = int(d)
    parts = clock.split(":")
    parts = [int(float(p)) for p in parts]
    while len(parts) < 3:
        parts.insert(0, 0)
    h, m, s = parts[-3:]
    return days * 86400 + h * 3600 + m * 60 + s


def parse_cputime(value: str) -> float:
    parts = value.split(":")
    total = float(parts[-1])
    mult = 60.0
    for p in reversed(parts[:-1]):
        total += int(p) * mult
        mult *= 60
    return total


def load_procs() -> dict[int, Proc]:
    uid = os.getuid()
    base = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,uid=,rss=,stat=,etime=,time=,comm="],
        capture_output=True, text=True,
    ).stdout
    argv = subprocess.run(
        ["ps", "-axo", "pid=,args="], capture_output=True, text=True
    ).stdout
    args_by_pid: dict[int, str] = {}
    for line in argv.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            args_by_pid[int(parts[0])] = parts[1]

    procs: dict[int, Proc] = {}
    for line in base.splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) < 8:
            continue
        try:
            pid, ppid, puid = int(parts[0]), int(parts[1]), int(parts[2])
            if puid != uid:
                continue
            procs[pid] = Proc(
                pid=pid, ppid=ppid, rss=int(parts[3]),
                state=parts[4], age=parse_elapsed(parts[5]), cpu=parse_cputime(parts[6]),
                comm=parts[7], args=args_by_pid.get(pid, parts[7]),
            )
        except ValueError:
            continue
    return procs


def is_protected(p: Proc) -> bool:
    return any(s in p.args for s in PROTECT_SUBSTR)


def is_codex_appserver(p: Proc) -> bool:
    return Path(p.comm).name == "codex" and any(
        token == "app-server" for token in p.args.split()
    )


def is_node_repl(p: Proc) -> bool:
    # Match the executable path, not a bare "/node_repl" substring of the full
    # command line: a substring match would classify unrelated processes that
    # merely mention a node_repl path in an argument (tail -f, editors,
    # wrapper scripts) as reapable transports.
    return p.comm.endswith("/node_repl") or "cua_node/bin/node_repl" in p.args


def is_claude_main(p: Proc) -> bool:
    # desktop-managed CLI: .../claude-code/<v>/claude.app/Contents/MacOS/claude
    # terminal CLI: a binary literally named claude (never the Claude.app GUI)
    return p.comm.endswith("/MacOS/claude") or p.comm == "claude" or (
        p.comm.endswith("/claude") and "Claude.app" not in p.comm
    )


def is_shell(p: Proc) -> bool:
    return p.comm in SHELL_COMMS or any(p.comm.endswith(s) for s in ("/zsh", "/bash", "/sh"))


def is_chrome_devtools_mcp_root(p: Proc) -> bool:
    stripped = p.args.strip()
    return (
        "codex-chrome-devtools-mcp-global.sh" in stripped
        or "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" in stripped
        or "chrome-devtools-mcp --browserUrl" in stripped
        or stripped.startswith("npm exec chrome-devtools-mcp")
        or "/.bin/chrome-devtools-mcp" in stripped
        or stripped == "chrome-devtools-mcp"
        or stripped.startswith("chrome-devtools-mcp ")
    )


def is_mcp_process(p: Proc) -> bool:
    return not is_shell(p) and not is_claude_main(p) and (
        is_node_repl(p) or any(signature in p.args for signature in MCP_SIGS)
    )


def matches_claude_sig(p: Proc) -> bool:
    """MCP-server test for a Claude session child, version-drift tolerant."""
    if any(s in p.args for s in CLAUDE_SIGS):
        return True
    # "npm exec shadcn@4.13.0 mcp" drifts past the pinned "shadcn@4 mcp" sig.
    a = p.args.rstrip()
    return "shadcn@" in a and a.endswith(" mcp")


def self_ancestry(procs: dict[int, Proc]) -> set[int]:
    out, pid = set(), os.getpid()
    while pid > 1 and pid in procs:
        out.add(pid)
        pid = procs[pid].ppid
    out.add(os.getpid())
    return out


def codex_idle_seconds() -> float:
    mtimes = []
    for f in ACTIVITY_FILES:
        try:
            mtimes.append(f.stat().st_mtime)
        except OSError:
            pass
    return time.time() - max(mtimes) if mtimes else float("inf")


def subtree(root: int, kids: dict[int, list[int]]) -> list[int]:
    seen, todo = [], [root]
    while todo:
        pid = todo.pop()
        if pid in seen:
            continue
        seen.append(pid)
        todo.extend(kids.get(pid, []))
    return seen


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state: dict) -> None:
    try:
        TMP.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state))
    except OSError:
        pass


class Reaper:
    def __init__(
        self,
        dry_run: bool = False,
        snapshot_provider=load_process_snapshot,
        clock=time.time,
        signal_sender=os.kill,
        sleeper=time.sleep,
        receipt_writer=None,
        lifecycle_state_writer=None,
        status_writer=None,
    ):
        self.dry = dry_run
        self.snapshot_provider = snapshot_provider
        self.clock = clock
        self.signal_sender = signal_sender
        self.sleeper = sleeper
        synthetic = snapshot_provider is not load_process_snapshot
        self.receipt_writer = receipt_writer or (
            (lambda _path, _payload: None) if synthetic else append_jsonl
        )
        self.lifecycle_state_writer = lifecycle_state_writer or (
            (lambda _path, _payload: None) if synthetic else atomic_write_json
        )
        self.status_writer = status_writer or (
            (lambda _path, _payload: None) if synthetic else atomic_write_json
        )
        self.procs = load_procs()
        self.kids: dict[int, list[int]] = defaultdict(list)
        for p in self.procs.values():
            self.kids[p.ppid].append(p.pid)
        self.protected = self_ancestry(self.procs)
        self.victims: dict[int, str] = {}   # pid -> rule tag
        self.actionable_orphans: set[int] = set()
        self.legacy_findings: dict[str, set[int]] = {
            "standalone_orphan": set(),
            "claude_idle": set(),
        }
        self.lifecycle_snapshot: dict[int, LifecycleProcess] = {}
        self.lifecycle_trees: list[TreeClassification] = []
        self.lifecycle_state: dict = {}
        self.detached_plans: dict[str, dict[int, ProcessIdentity]] = {}

    def mark_tree(self, root: int, tag: str) -> None:
        # Inert in v2: no lane calls this; the strict detached lane plans
        # identity-frozen victims in plan_detached_wrappers instead.
        for pid in subtree(root, self.kids):
            p = self.procs.get(pid)
            if p is None or pid in self.protected or is_protected(p):
                continue
            self.victims.setdefault(pid, tag)

    # -- rule 1 + 2: orphans ------------------------------------------------
    def reap_orphans(self) -> None:
        for p in self.procs.values():
            if p.ppid != 1 or p.age < ORPHAN_MIN_AGE or is_protected(p):
                continue
            if is_node_repl(p):
                if p.age >= NODE_REPL_ORPHAN_MIN_AGE:
                    self.legacy_findings["standalone_orphan"].add(p.pid)
                continue
            if not is_shell(p) and not is_codex_appserver(p) and not is_claude_main(p) and any(s in p.args for s in ORPHAN_SIGS):
                self.legacy_findings["standalone_orphan"].add(p.pid)

    def plan_detached_wrappers(self, prior_state: dict, state_valid: bool = True) -> dict:
        """Classify wrapper-owned app-servers and arm only verified idle trees."""
        self.lifecycle_snapshot = self.snapshot_provider()
        classified = classify_codex_trees(
            self.lifecycle_snapshot,
            uid=os.getuid(),
            orphan_min_age=ORPHAN_MIN_AGE,
        )
        self.lifecycle_trees, self.lifecycle_state = advance_lifecycle_state(
            classified,
            prior_state,
            self.clock(),
            idle_seconds=DETACHED_IDLE_SECS,
            state_valid=state_valid,
        )
        self.detached_plans = {}
        self.detached_generations: dict[str, str] = {}
        for tree in self.lifecycle_trees:
            if not tree.actionable or tree.state != "eligible":
                continue
            planned: dict[int, ProcessIdentity] = {}
            for pid in tree.process_ids:
                process = self.lifecycle_snapshot.get(pid)
                # An eligible tree is planned as one identity-frozen unit.
                # Omitting a descendant would leave an unowned survivor behind;
                # unknown or active work instead keeps the tree blocked.
                if process is None:
                    continue
                identity = process.identity
                if identity is None:
                    planned = {}
                    break
                planned[pid] = identity
            required = {
                tree.root_identity.pid if tree.root_identity else -1,
                tree.app_server_identity.pid if tree.app_server_identity else -1,
            }
            if not planned or not required.issubset(planned):
                continue
            self.detached_plans[tree.tree_key] = planned
            self.detached_generations[tree.tree_key] = tree.generation
            self.actionable_orphans.add(tree.root_identity.pid)
            for pid in planned:
                self.victims.setdefault(pid, "detached-app-server-tree")
        return self.lifecycle_state

    @staticmethod
    def _identity_matches(process: LifecycleProcess | None, expected: ProcessIdentity) -> bool:
        return process is not None and process.identity == expected

    def _revalidate_detached_plan(
        self, tree_key: str, planned: dict[int, ProcessIdentity]
    ) -> tuple[dict[int, LifecycleProcess] | None, str | None]:
        current = self.snapshot_provider()
        trees = classify_codex_trees(current, uid=os.getuid(), orphan_min_age=ORPHAN_MIN_AGE)
        match = next((tree for tree in trees if tree.tree_key == tree_key), None)
        if match is None:
            return None, "tree identity no longer exists"
        # Apply the same soft-blocker filter as advance_lifecycle_state: an
        # idle soft blocker must not cancel an armed kill at signal time, while
        # hard blockers and CPU-active (or baseline-less) soft blockers abort.
        prior_tree_state: dict = {}
        state_trees = self.lifecycle_state.get("trees") if isinstance(self.lifecycle_state, dict) else None
        if isinstance(state_trees, dict) and isinstance(state_trees.get(tree_key), dict):
            prior_tree_state = state_trees[tree_key]
        if (
            match.ownership != "detached"
            or match.error
            or active_blockers(match, prior_tree_state)
        ):
            return None, "tree is no longer an unblocked exact detached tree"
        if match.generation != self.detached_generations.get(tree_key):
            return None, "tree process generation changed before signal"
        for pid, identity in planned.items():
            if not self._identity_matches(current.get(pid), identity):
                return None, f"pid {pid} identity changed before signal"
        return current, None

    @staticmethod
    def _children_first_order(
        planned: dict[int, ProcessIdentity], snapshot: dict[int, LifecycleProcess]
    ) -> list[int]:
        planned_ids = set(planned)

        def depth(pid: int) -> int:
            value, current, seen = 0, pid, set()
            while current in snapshot and current not in seen:
                seen.add(current)
                parent = snapshot[current].ppid
                if parent not in planned_ids:
                    break
                value += 1
                current = parent
            return value

        return sorted(planned, key=lambda pid: (depth(pid), pid), reverse=True)

    def _record_tree_result(
        self, tree_key: str, state: str, pids: list[int], error: str | None = None
    ) -> None:
        timestamp = self.clock()
        action = {
            "action_id": hashlib.sha256(
                f"{tree_key}|{state}|{timestamp}".encode("utf-8", "replace")
            ).hexdigest()[:24],
            "timestamp": timestamp,
            "tree_key": tree_key,
            "state": state,
            "pids": pids,
            "error": error,
        }
        self.receipt_writer(LIFECYCLE_ACTIONS, action)
        action_summary = f"{state} at {int(action['timestamp'])}; signaled {len(pids)} process(es)"
        self.lifecycle_trees = [
            replace(
                tree,
                state=state,
                actionable=False,
                last_action=action_summary,
                last_verified_action_receipt=action["action_id"],
                error=error,
            )
            if tree.tree_key == tree_key else tree
            for tree in self.lifecycle_trees
        ]

    def _clear_tree_timer(self, tree_key: str) -> None:
        trees = self.lifecycle_state.get("trees")
        if isinstance(trees, dict):
            trees.pop(tree_key, None)
        self.lifecycle_state["last_now"] = self.clock()
        self.lifecycle_state_writer(LIFECYCLE_STATE, self.lifecycle_state)

    def _publish_terminating(self, tree_key: str) -> None:
        prior = self.lifecycle_trees
        self.lifecycle_trees = [
            replace(tree, state="terminating", actionable=False)
            if tree.tree_key == tree_key else tree
            for tree in self.lifecycle_trees
        ]
        try:
            self.status_writer(
                LIFECYCLE_STATUS,
                lifecycle_status_payload(self, "automatic"),
            )
        except Exception:
            self.lifecycle_trees = prior
            raise

    @staticmethod
    def _new_descendant_since(
        baseline: dict[int, LifecycleProcess],
        current: dict[int, LifecycleProcess],
        planned: dict[int, ProcessIdentity],
    ) -> LifecycleProcess | None:
        for process in current.values():
            baseline_process = baseline.get(process.pid)
            if baseline_process is not None and baseline_process.identity == process.identity:
                continue
            ancestor = process.ppid
            seen: set[int] = set()
            while ancestor > 1 and ancestor not in seen:
                if ancestor in planned:
                    return process
                seen.add(ancestor)
                parent = current.get(ancestor)
                if parent is None:
                    break
                ancestor = parent.ppid
        return None

    def execute_detached(self) -> tuple[int, dict[str, int]]:
        """Execute identity-frozen detached plans; return signaled count and tags."""
        if self.dry:
            return sum(len(plan) for plan in self.detached_plans.values()), {
                "detached-app-server-tree": sum(len(plan) for plan in self.detached_plans.values())
            }
        signaled = 0
        for tree_key, planned in list(self.detached_plans.items()):
            current, error = self._revalidate_detached_plan(tree_key, planned)
            if current is None:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(tree_key, "partial_failure", [], error)
                continue
            order = self._children_first_order(planned, current)
            sent: list[int] = []
            try:
                self._publish_terminating(tree_key)
            except Exception as exc:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(
                    tree_key,
                    "partial_failure",
                    [],
                    f"could not publish terminating status: {type(exc).__name__}",
                )
                continue
            abort_error: str | None = None
            for pid in order:
                live = self.snapshot_provider()
                if not self._identity_matches(live.get(pid), planned[pid]):
                    abort_error = f"pid {pid} identity changed immediately before TERM"
                    break
                new_descendant = self._new_descendant_since(current, live, planned)
                if new_descendant is not None:
                    abort_error = (
                        f"new descendant pid {new_descendant.pid} appeared immediately before TERM"
                    )
                    break
                try:
                    self.signal_sender(pid, signal.SIGTERM)
                    sent.append(pid)
                except (ProcessLookupError, PermissionError):
                    pass
            if abort_error is not None:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(tree_key, "partial_failure", sent, abort_error)
                continue
            self.sleeper(TERM_GRACE_SECS)
            survivors: list[int] = []
            refreshed = self.snapshot_provider()
            for pid, identity in planned.items():
                if self._identity_matches(refreshed.get(pid), identity):
                    survivors.append(pid)
            for pid in self._children_first_order(
                {pid: planned[pid] for pid in survivors}, refreshed
            ):
                live = self.snapshot_provider()
                if not self._identity_matches(live.get(pid), planned[pid]):
                    continue
                new_descendant = self._new_descendant_since(current, live, planned)
                if new_descendant is not None:
                    abort_error = (
                        f"new descendant pid {new_descendant.pid} appeared immediately before KILL"
                    )
                    break
                try:
                    self.signal_sender(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            if abort_error is not None:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(tree_key, "partial_failure", sent, abort_error)
                continue
            final = self.snapshot_provider()
            remaining = [
                pid for pid, identity in planned.items()
                if self._identity_matches(final.get(pid), identity)
            ]
            signaled += len(sent)
            if remaining:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(
                    tree_key,
                    "partial_failure",
                    sent,
                    f"same-identity survivors remain: {remaining}",
                )
            else:
                self._clear_tree_timer(tree_key)
                self._record_tree_result(tree_key, "verified_gone", sent)
        return signaled, {"detached-app-server-tree": signaled} if signaled else {}

    # -- rule 4: idle claude sessions -----------------------------------------
    def reap_claude_idle(self, state: dict) -> dict:
        now = time.time()
        sessions = [p for p in self.procs.values() if is_claude_main(p)]
        st = state.get("claude", {})
        new_st: dict[str, dict] = {}
        for p in sessions:
            key = str(p.pid)
            start = now - p.age
            prev = st.get(key)
            if prev and abs(prev.get("start", 0) - start) > 120:
                prev = None  # pid was reused by a different process
            tree = [self.procs[k] for k in subtree(p.pid, self.kids)
                    if k != p.pid and k in self.procs]
            tree_cpu = p.cpu + sum(k.cpu for k in tree)
            if prev is None:
                new_st[key] = {"start": start, "cpu": tree_cpu, "idle_since": now}
                continue
            idle_since = prev.get("idle_since", now)
            # An MCP child born after idle_since proves the session made a tool
            # call that respawned it: it is actively using its servers no matter
            # how little CPU the main process burns. Re-arm the idle window.
            respawned = any(
                (now - kp.age) > idle_since and matches_claude_sig(kp)
                for kp in tree
            )
            # Count CPU across the whole session subtree, not just the main
            # process: long tool calls burn CPU in the MCP child while the
            # session main waits cheaply.
            if tree_cpu - prev.get("cpu", 0.0) >= CLAUDE_CPU_EPS or respawned:
                idle_since = now  # session or its MCP servers did real work
            new_st[key] = {"start": start, "cpu": tree_cpu, "idle_since": idle_since}

            if p.pid in self.protected:
                continue
            if now - idle_since >= CLAUDE_IDLE_SECS:
                for kid in self.kids.get(p.pid, []):
                    kp = self.procs.get(kid)
                    if kp is None or is_shell(kp) or is_protected(kp):
                        continue
                    if matches_claude_sig(kp):
                        self.legacy_findings["claude_idle"].add(kid)
        state["claude"] = new_st
        return state

    # -- execution -------------------------------------------------------------
    def execute(self) -> tuple[int, int, dict[str, int]]:
        # Legacy standalone-orphan and Claude-idle findings are observation
        # only. Only the strict identity-frozen detached lane can signal.
        freed = sum(
            self.lifecycle_snapshot[pid].rss_kib
            for plan in self.detached_plans.values()
            for pid in plan
            if pid in self.lifecycle_snapshot
        )
        detached_count, detached_tags = self.execute_detached()
        return detached_count, freed, detached_tags


def rotate_log() -> None:
    try:
        if LOG.exists() and LOG.stat().st_size > 512 * 1024:
            LOG.replace(LOG.with_suffix(".log.1"))
    except OSError:
        pass


def log_line(msg: str) -> None:
    rotate_log()
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(LOG, "a") as fh:
            fh.write(msg + "\n")
    except OSError:
        pass
    if sys.stdout.isatty():
        print(msg, flush=True)


def status_counts(reaper: Reaper) -> dict[str, int]:
    if reaper.lifecycle_trees:
        live_appservers = {
            tree.app_server_identity.pid
            for tree in reaper.lifecycle_trees
            if tree.ownership == "ui_owned" and tree.app_server_identity
        }
    else:
        live_appservers = {
            p.pid for p in reaper.procs.values()
            if is_codex_appserver(p) and p.ppid != 1
        }
    mcp_pids: set[int] = set()
    for process in reaper.procs.values():
        if is_mcp_process(process):
            mcp_pids.update(subtree(process.pid, reaper.kids))
    return {
        "codex_app_servers": sum(1 for p in reaper.procs.values() if is_codex_appserver(p)),
        "loaded_task_stacks": sum(
            p.ppid in live_appservers for p in reaper.procs.values() if is_node_repl(p)
        ),
        "chrome_zombies": sum(
            1 for p in reaper.procs.values()
            if p.state.startswith("Z")
            and p.ppid in reaper.procs
            and is_chrome_devtools_mcp_root(reaper.procs[p.ppid])
        ),
        "node_repls": sum(1 for p in reaper.procs.values() if is_node_repl(p)),
        "mcp_rss_mib": sum(
            reaper.procs[pid].rss for pid in mcp_pids if pid in reaper.procs
        ) // 1024,
        "actionable_orphans": len(reaper.actionable_orphans),
        "observed_standalone_orphans": len(reaper.legacy_findings["standalone_orphan"]),
        "observed_claude_idle_roots": len(reaper.legacy_findings["claude_idle"]),
        "claude_sessions": sum(1 for p in reaper.procs.values() if is_claude_main(p)),
        "would_kill": len(reaper.victims),
    }


def lifecycle_status_payload(
    reaper: Reaper, mode: str, error: str | None = None
) -> dict:
    counts = status_counts(reaper)
    return build_status(
        reaper.lifecycle_trees,
        counts=counts,
        generated_at=reaper.clock(),
        job={"ok": error is None, "mode": mode, "error": error},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Reap verified orphan and idle Claude MCP processes.")
    ap.add_argument("--dry-run", action="store_true", help="report what would be killed")
    ap.add_argument("--status", action="store_true", help="print counts, kill nothing")
    ap.add_argument("--json", action="store_true", help="print the schema-versioned status as JSON")
    args = ap.parse_args()

    reaper = Reaper(dry_run=args.dry_run or args.status)
    idle = codex_idle_seconds()
    lifecycle_error: str | None = None
    lifecycle_prior, lifecycle_state_valid = atomic_read_json(LIFECYCLE_STATE)
    try:
        reaper.plan_detached_wrappers(lifecycle_prior, lifecycle_state_valid)
    except Exception as exc:
        lifecycle_error = f"lifecycle classification failed: {type(exc).__name__}: {exc}"

    # If lifecycle ownership cannot be proven, fail closed for every automatic
    # action rather than falling back to the older, less complete classifier.
    if lifecycle_error is None:
        reaper.reap_orphans()
    state = load_state()
    if lifecycle_error is None:
        state = reaper.reap_claude_idle(state)
    if not (args.dry_run or args.status):
        if lifecycle_error is None:
            save_state(state)
            atomic_write_json(LIFECYCLE_STATE, reaper.lifecycle_state)

    payload = lifecycle_status_payload(
        reaper,
        "status" if args.status else ("dry-run" if args.dry_run else "automatic"),
        lifecycle_error,
    )
    atomic_write_json(LIFECYCLE_STATUS, payload)

    if args.status:
        counts = payload["counts"]
        if args.json:
            print(json.dumps(payload, sort_keys=True))
            return 1 if lifecycle_error else 0
        for key in (
            "codex_app_servers",
            "loaded_task_stacks",
            "chrome_zombies",
            "node_repls",
            "mcp_rss_mib",
            "actionable_orphans",
            "observed_standalone_orphans",
            "observed_claude_idle_roots",
            "claude_sessions",
        ):
            print(f"{key}={counts[key]}")
        print(f"codex_idle={int(idle)}s mode=observe-only")
        for tree in payload["trees"]:
            blocker = tree["blockers"][0]["command_summary"] if tree["blockers"] else "none"
            print(
                f"tree={tree['tree_key']} ownership={tree['ownership']} state={tree['state']} "
                f"remaining={tree['remaining_seconds']} blocker={blocker}"
            )
        print(f"node_repl_orphan_min_age={NODE_REPL_ORPHAN_MIN_AGE}s")
        print(f"lane_modes={json.dumps(LANE_MODES, sort_keys=True)}")
        print(f"would_kill={counts['would_kill']}")
        for pid, tag in sorted(reaper.victims.items()):
            print(f"  {tag:24s} {pid:>6d}  {reaper.procs[pid].args[:90]}")
        return 1 if lifecycle_error else 0

    killed, freed, by_tag = reaper.execute()
    if not args.dry_run:
        atomic_write_json(
            LIFECYCLE_STATUS,
            lifecycle_status_payload(reaper, "automatic", lifecycle_error),
        )
    if args.json:
        print(json.dumps(lifecycle_status_payload(
            reaper,
            "dry-run" if args.dry_run else "automatic",
            lifecycle_error,
        ), sort_keys=True))
    if killed:
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        tags = ", ".join(f"{k}:{v}" for k, v in sorted(by_tag.items()))
        prefix = "[DRY] " if args.dry_run else ""
        msg = (f"{ts} {prefix}idle={int(idle)}s mode=strict-detached-only "
               f"killed={killed} freed~{freed // 1024}MB [{tags}]")
        log_line(msg)
        if args.dry_run:
            for pid, tag in sorted(reaper.victims.items()):
                print(f"  {tag:24s} {pid:>6d}  {reaper.procs[pid].args[:90]}")
    return 1 if lifecycle_error else 0


if __name__ == "__main__":
    sys.exit(main())
