#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


CODEX_HOME = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser()
CODEX_LIB = CODEX_HOME / "lib"
if str(CODEX_LIB) not in sys.path:
    sys.path.insert(0, str(CODEX_LIB))

try:
    from codex_mcp_lifecycle import SCHEMA_VERSION as LIFECYCLE_SCHEMA_VERSION
except ImportError as exc:  # Keep unrelated guard checks available during a partial install.
    LIFECYCLE_SCHEMA_VERSION = 2
    LIFECYCLE_IMPORT_ERROR: str | None = str(exc)
else:
    LIFECYCLE_IMPORT_ERROR = None
SUPPORTED_LIFECYCLE_SCHEMA_VERSIONS = {1, LIFECYCLE_SCHEMA_VERSION}

STATE_DB = Path(os.environ.get("CODEX_STATE_DB_PATH", str(CODEX_HOME / "state_5.sqlite"))).expanduser()
TMP_DIR = Path(os.environ.get("CODEX_GUARD_TMP_DIR", str(CODEX_HOME / "tmp"))).expanduser()
NOTIFY_SCRIPT = Path(
    os.environ.get("CODEX_ATTENTION_NOTIFY_SCRIPT", str(CODEX_HOME / "bin" / "codex-attention-notify.sh"))
).expanduser()
NOTIFY_STATE = TMP_DIR / "codex-mcp-guard-notify.json"
GUARD_STATUS = Path(
    os.environ.get(
        "CODEX_MCP_GUARD_STATUS_PATH",
        str(TMP_DIR / "codex-mcp-guard-status.json"),
    )
).expanduser()
LIFECYCLE_STATUS = Path(
    os.environ.get(
        "CODEX_MCP_LIFECYCLE_STATUS_PATH",
        str(TMP_DIR / "codex-mcp-lifecycle-status.json"),
    )
).expanduser()
TWEAKERS_USER_ROOT = Path(
    os.environ.get(
        "TWEAKERS_USER_ROOT",
        str(Path.home() / "Library" / "Application Support" / "codex-plusplus"),
    )
).expanduser()
WATCHER_HEALTH = Path(
    os.environ.get("TWEAKERS_WATCHER_HEALTH_PATH", str(TWEAKERS_USER_ROOT / "watcher-health.json"))
).expanduser()
WATCHER_HEALTH_LAST_KNOWN_GOOD = Path(
    os.environ.get(
        "TWEAKERS_WATCHER_HEALTH_LAST_KNOWN_GOOD_PATH",
        str(TWEAKERS_USER_ROOT / "watcher-health.last-known-good.json"),
    )
).expanduser()

WATCHER_HEALTH_SCHEMA = "tweakers.health.v1"
WATCHER_HEALTH_SCHEMA_VERSION = 1
REPAIR_WATCHER_LABEL = "com.therealityreport.tweakers.watcher"
REAPER_LABEL = "com.thomashulihan.codex-mcp-idle-reaper"
GUARD_LABEL = "com.thomashulihan.codex-mcp-guard"
MAX_WATCHER_TEXT_LENGTH = 512

PROJECT_THREAD_RETAIN_COUNT = int(os.environ.get("CODEX_GUARD_PROJECT_THREAD_RETAIN_COUNT", "10"))
PROJECT_THREAD_RETAIN_DAYS = int(os.environ.get("CODEX_GUARD_PROJECT_THREAD_RETAIN_DAYS", "8"))
CONTEXT7_WARN = int(os.environ.get("CODEX_GUARD_CONTEXT7_WARN", "6"))
CHROME_WARN = int(os.environ.get("CODEX_GUARD_CHROME_WARN", "3"))
DECODO_WARN = int(os.environ.get("CODEX_GUARD_DECODO_WARN", "4"))
COMPUTER_USE_WARN = int(os.environ.get("CODEX_GUARD_COMPUTER_USE_WARN", "2"))
COMPUTER_USE_CRITICAL = int(os.environ.get("CODEX_GUARD_COMPUTER_USE_CRITICAL", "20"))
SWAP_PRESSURE_PCT = int(os.environ.get("CODEX_GUARD_SWAP_PRESSURE_PCT", "50"))
HELPER_PRESSURE_COUNT = int(os.environ.get("CODEX_GUARD_HELPER_PRESSURE_COUNT", "300"))
PROJECTS_TWEAK_WARN = int(os.environ.get("CODEX_GUARD_PROJECTS_TWEAK_WARN", "2"))
PROJECT_CHROME_PROFILE_WARN = int(os.environ.get("CODEX_GUARD_PROJECT_CHROME_PROFILE_WARN", "2"))
NOTIFY_COOLDOWN_SEC = int(os.environ.get("CODEX_GUARD_NOTIFY_COOLDOWN_SEC", "3600"))
LIFECYCLE_STATUS_MAX_AGE_SEC = int(os.environ.get("CODEX_GUARD_LIFECYCLE_STATUS_MAX_AGE_SEC", "180"))
ORPHAN_MIN_AGE = int(os.environ.get("REAPER_ORPHAN_MIN_AGE", "120"))
NODE_REPL_ORPHAN_MIN_AGE = int(os.environ.get("REAPER_NODE_REPL_ORPHAN_MIN_AGE", "3600"))

PROTECT_SUBSTR = ("9422", "modal_ops_mcp.py")
MCP_SIGNATURES = (
    "./mcp/server.mjs",
    "./mcp/server.bundle.mjs",
    "server.cjs",
    "server.mjs",
    "context7-app-compat",
    "modal_ops_mcp.py",
    "xcodebuildmcp",
    "@playwright/mcp",
    "headroom mcp serve",
    "pdfx-cli",
    "/.bin/pdfx",
    "shadcn@4 mcp",
    "/.bin/shadcn mcp",
    "@decodo/mcp-server",
    "decodo-mcp",
    "@upstash/context7-mcp",
    "codex-context7-mcp.sh",
    "chrome-devtools-mcp",
    "scrapling mcp",
    "user-questions/mcp-server.js",
    "telemetry/watchdog/main.js",
)
SHELL_COMMS = ("zsh", "bash", "sh")
APP_SERVER_WORD = re.compile(r"(?:^|\s)app-server(?:\s|$)")


@dataclass(frozen=True)
class Proc:
    pid: int
    ppid: int
    rss_kib: int
    state: str
    age_seconds: int
    comm: str
    args: str


@dataclass(frozen=True)
class NotificationEvent:
    key: str
    title: str
    message: str
    once: bool = False


def log(message: str, quiet: bool = False) -> None:
    if not quiet:
        print(message, flush=True)


def load_processes() -> dict[int, Proc]:
    proc_table: dict[int, Proc] = {}
    base = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,rss=,stat=,etime=,comm="],
        check=True,
        capture_output=True,
        text=True,
    )
    argv = subprocess.run(
        ["ps", "-axo", "pid=,args="],
        check=True,
        capture_output=True,
        text=True,
    )
    args_by_pid: dict[int, str] = {}
    for raw_line in argv.stdout.splitlines():
        parts = raw_line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            args_by_pid[int(parts[0])] = parts[1]

    for raw_line in base.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        pid, ppid, rss_kib, state, age_text, comm = parts
        try:
            proc = Proc(
                pid=int(pid),
                ppid=int(ppid),
                rss_kib=int(rss_kib),
                state=state,
                age_seconds=parse_elapsed_seconds(age_text),
                comm=comm,
                args=args_by_pid.get(int(pid), comm),
            )
        except ValueError:
            continue
        proc_table[proc.pid] = proc
    return proc_table


def parse_elapsed_seconds(value: str) -> int:
    day_split = value.split("-", 1)
    days = 0
    clock = value
    if len(day_split) == 2:
        days = int(day_split[0])
        clock = day_split[1]
    parts = [int(part) for part in clock.split(":")]
    if len(parts) == 3:
        hours, minutes, seconds = parts
    elif len(parts) == 2:
        hours = 0
        minutes, seconds = parts
    else:
        hours = 0
        minutes = 0
        seconds = parts[0]
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def children_by_parent(proc_table: dict[int, Proc]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = defaultdict(list)
    for proc in proc_table.values():
        children[proc.ppid].append(proc.pid)
    return children


def descendants(root_pid: int, child_map: dict[int, list[int]]) -> list[int]:
    pending = [root_pid]
    seen: list[int] = []
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.append(pid)
        pending.extend(child_map.get(pid, []))
    return seen


def matching_root_processes(proc_table: dict[int, Proc], app_server_pid: int, mode: str) -> list[Proc]:
    matches: list[Proc] = []
    for proc in proc_table.values():
        if proc.ppid != app_server_pid:
            continue
        if mode == "context7" and (
            "@upstash/context7-mcp" in proc.args or "codex-context7-mcp.sh" in proc.args
        ):
            matches.append(proc)
        if mode == "chrome" and is_chrome_devtools_mcp_root(proc.args):
            matches.append(proc)
        if mode == "decodo" and "@decodo/mcp-server" in proc.args:
            matches.append(proc)
        if mode == "computer-use" and is_computer_use_helper(proc.args):
            matches.append(proc)
        if mode == "projects-tweak" and is_projects_tweak_mcp(proc.args):
            matches.append(proc)
        if mode == "project-chrome-profile" and is_project_chrome_profile_mcp(proc.args):
            matches.append(proc)
    if mode == "computer-use":
        return sorted(matches, key=lambda proc: proc.age_seconds)
    return sorted(matches, key=lambda proc: proc.pid, reverse=True)


def matching_processes(proc_table: dict[int, Proc], mode: str) -> list[Proc]:
    matches: list[Proc] = []
    for proc in proc_table.values():
        if mode == "computer-use" and is_computer_use_helper(proc.args):
            matches.append(proc)
    if mode == "computer-use":
        return sorted(matches, key=lambda proc: proc.age_seconds)
    return sorted(matches, key=lambda proc: proc.pid, reverse=True)


def is_computer_use_helper(args: str) -> bool:
    return (
        "/SkyComputerUseClient " in args
        or args.startswith("SkyComputerUseClient ")
        or "/com.openai.sky.CUAService.cli " in args
        or args.startswith("com.openai.sky.CUAService.cli ")
    )


def is_shell(proc: Proc) -> bool:
    return Path(proc.comm).name in SHELL_COMMS


def is_codex_appserver(proc: Proc) -> bool:
    """Match `codex [flags] app-server`, without matching wrapper text."""
    return Path(proc.comm).name == "codex" and APP_SERVER_WORD.search(proc.args) is not None


def is_node_repl(proc: Proc) -> bool:
    return Path(proc.comm).name == "node_repl" or "cua_node/bin/node_repl" in proc.args


def is_protected(proc: Proc) -> bool:
    return any(signature in proc.args for signature in PROTECT_SUBSTR)


def is_mcp_signature(proc: Proc) -> bool:
    return not is_shell(proc) and (
        is_node_repl(proc) or any(signature in proc.args for signature in MCP_SIGNATURES)
    )


def is_chrome_devtools_mcp_root(args: str) -> bool:
    stripped = args.strip()
    return (
        "codex-chrome-devtools-mcp-global.sh" in stripped
        or "chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js" in stripped
        or "chrome-devtools-mcp --browserUrl" in stripped
        or stripped.startswith("npm exec chrome-devtools-mcp")
        or "/.bin/chrome-devtools-mcp" in stripped
        or stripped == "chrome-devtools-mcp"
        or stripped.startswith("chrome-devtools-mcp ")
    )


def is_projects_tweak_mcp(args: str) -> bool:
    return "codex-plusplus/tweaks/co.thomashulihan.projects/mcp-server.js" in args


def is_project_chrome_profile_mcp(args: str) -> bool:
    return "codex-plusplus/tweaks/co.thomashulihan.project-chrome-profile/mcp-server.js" in args


def actionable_orphan_roots(proc_table: dict[int, Proc]) -> list[Proc]:
    roots: list[Proc] = []
    for proc in proc_table.values():
        if proc.ppid != 1 or is_protected(proc):
            continue
        if is_node_repl(proc):
            if proc.age_seconds >= NODE_REPL_ORPHAN_MIN_AGE:
                roots.append(proc)
        elif proc.age_seconds >= ORPHAN_MIN_AGE and (
            is_codex_appserver(proc) or is_mcp_signature(proc)
        ):
            roots.append(proc)
    return roots


def load_lifecycle_status(
    path: Path | None = None,
    *,
    now: float | None = None,
) -> tuple[dict[str, object] | None, str | None]:
    """Read the reaper-owned status without attempting an independent classification."""
    status_path = path or LIFECYCLE_STATUS
    if LIFECYCLE_IMPORT_ERROR is not None:
        return None, f"shared lifecycle module unavailable: {LIFECYCLE_IMPORT_ERROR}"
    try:
        payload = json.loads(status_path.read_text())
    except FileNotFoundError:
        return None, f"lifecycle status is missing: {status_path}"
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"lifecycle status is unreadable: {exc}"
    if not isinstance(payload, dict):
        return None, "lifecycle status root is not an object"
    if payload.get("schema_version") not in SUPPORTED_LIFECYCLE_SCHEMA_VERSIONS:
        return None, (
            "lifecycle status schema mismatch: "
            f"expected one of {sorted(SUPPORTED_LIFECYCLE_SCHEMA_VERSIONS)}, "
            f"got {payload.get('schema_version')!r}"
        )
    generated_at = payload.get("generated_at")
    if not isinstance(generated_at, (int, float)) or isinstance(generated_at, bool):
        return payload, "lifecycle status has an invalid generated_at"
    current_time = time.time() if now is None else now
    age = current_time - float(generated_at)
    if age < -5:
        return payload, "lifecycle status timestamp is in the future"
    if age > LIFECYCLE_STATUS_MAX_AGE_SEC:
        return payload, f"lifecycle status is stale ({int(age)}s old)"
    job = payload.get("job")
    if not isinstance(job, dict):
        return payload, "lifecycle status has no valid job object"
    if job.get("ok") is not True:
        error = job.get("error")
        detail = error if isinstance(error, str) and error else "unknown lifecycle job failure"
        return payload, f"lifecycle job failed: {detail}"
    if not isinstance(payload.get("counts"), dict) or not isinstance(payload.get("trees"), list):
        return payload, "lifecycle status is missing counts or trees"
    return payload, None


def apply_lifecycle_counts(counts: dict[str, int], lifecycle_status: dict[str, object]) -> None:
    """Use the supported lifecycle status as the source of lifecycle counters."""
    source = lifecycle_status.get("counts")
    if not isinstance(source, dict):
        return
    mapping = {
        "codex_app_servers": "app_servers",
        "node_repls": "node_repls",
        "mcp_rss_mib": "mcp_rss_mib",
        "actionable_orphans": "actionable_orphans",
        "would_kill": "would_kill",
    }
    for status_name, guard_name in mapping.items():
        value = source.get(status_name)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            counts[guard_name] = value
    counts["computer_use_helpers"] = _helper_count(
        lifecycle_status.get("helper_family_counts"),
        "computer_use",
    )


def _helper_count(families: object, family: str) -> int:
    if not isinstance(families, dict):
        return 0
    aliases = {
        "computer_use": ("computer_use", "computer-use", "computer_use_helpers"),
    }
    for key in aliases.get(family, (family,)):
        value = families.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return 0


def _failure_identity(value: object) -> str:
    text = value if isinstance(value, str) else repr(value)
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:12]


def _tree_label(tree: dict[str, object]) -> str:
    tree_key = tree.get("tree_key")
    if isinstance(tree_key, str) and tree_key:
        return tree_key[:12]
    return "unknown tree"


def _blocker_summary(tree: dict[str, object]) -> str:
    blockers = tree.get("blockers")
    if not isinstance(blockers, list) or not blockers:
        return "active user work"
    summaries: list[str] = []
    for blocker in blockers[:2]:
        if not isinstance(blocker, dict):
            continue
        name = blocker.get("name")
        command = blocker.get("command_summary")
        if isinstance(name, str) and name:
            summaries.append(name[:80])
        elif isinstance(command, str) and command:
            summaries.append(command[:80])
    return ", ".join(summaries) or "active user work"


def lifecycle_notification_events(
    lifecycle_status: dict[str, object] | None,
    status_error: str | None = None,
) -> list[NotificationEvent]:
    events: list[NotificationEvent] = []
    if status_error:
        events.append(
            NotificationEvent(
                key=f"lifecycle:v{LIFECYCLE_SCHEMA_VERSION}:status:{_failure_identity(status_error)}",
                title="Codex MCP lifecycle status unavailable",
                message=status_error[:240],
            )
        )
    if lifecycle_status is None:
        return events

    trees = lifecycle_status.get("trees")
    if not isinstance(trees, list):
        return events
    for raw_tree in trees:
        if not isinstance(raw_tree, dict):
            continue
        tree: dict[str, object] = raw_tree
        ownership = tree.get("ownership")
        state = tree.get("state")
        if not isinstance(state, str) or not state:
            state = "unknown"
        key_state = "ambiguous" if ownership == "ambiguous" else state
        tree_key = tree.get("tree_key")
        if not isinstance(tree_key, str) or not tree_key:
            tree_key = f"missing-{_failure_identity(tree.get('root_identity'))}"
        key = f"lifecycle:v{LIFECYCLE_SCHEMA_VERSION}:{tree_key}:{key_state}"
        helper_count = _helper_count(tree.get("helper_family_counts"), "computer_use")
        helper_note = (
            f" It owns {helper_count} Computer Use helpers."
            if helper_count > COMPUTER_USE_WARN and ownership in {"detached", "ambiguous"}
            else ""
        )
        label = _tree_label(tree)

        if state == "partial_failure" or ownership == "ambiguous":
            error = tree.get("error")
            failure = error if isinstance(error, str) and error else "ownership or cleanup could not be verified"
            key += f":{_failure_identity(failure)}"
            title = "Codex MCP lifecycle failure" if state == "partial_failure" else "Ambiguous Codex MCP ownership"
            events.append(NotificationEvent(key, title, f"{label}: {failure[:220]}.{helper_note}"))
        elif ownership == "ui_owned":
            if helper_count <= COMPUTER_USE_WARN:
                continue
            severity = "critical" if helper_count >= COMPUTER_USE_CRITICAL else "warning"
            events.append(
                NotificationEvent(
                    key=(
                        f"lifecycle:v{LIFECYCLE_SCHEMA_VERSION}:"
                        f"{tree_key}:ui-pressure:{severity}"
                    ),
                    title=(
                        "Critical Codex MCP overpopulation"
                        if severity == "critical"
                        else "Codex MCP helper pressure"
                    ),
                    message=(
                        f"{label} is UI-owned and has {helper_count} Computer Use helpers. "
                        "The notification-only guard will not send process signals; "
                        "the owning Codex runtime must retire completed task runtimes."
                    ),
                )
            )
        elif ownership != "detached" and state != "verified_gone":
            continue
        elif state == "blocked_active_work":
            events.append(
                NotificationEvent(
                    key,
                    "Detached Codex runtime protected",
                    f"{label} is protected by {_blocker_summary(tree)}; cleanup countdown has not started.{helper_note}",
                )
            )
        elif state == "idle_pending":
            remaining = tree.get("remaining_seconds")
            countdown = f"{max(0, int(remaining))}s" if isinstance(remaining, (int, float)) else "the pending interval"
            events.append(
                NotificationEvent(
                    key,
                    "Detached Codex runtime idle",
                    f"{label} is idle; automatic cleanup in {countdown}.{helper_note}",
                )
            )
        elif state in {"eligible", "terminating"}:
            action = "is starting" if state == "eligible" else "is in progress"
            events.append(
                NotificationEvent(
                    key,
                    "Automatic Codex MCP cleanup",
                    f"{label} passed all safety checks; automatic cleanup {action}.{helper_note}",
                )
            )
        elif state == "verified_gone":
            families = tree.get("helper_family_counts")
            helpers = sum(
                value for value in families.values()
                if isinstance(families, dict) and isinstance(value, int) and not isinstance(value, bool) and value >= 0
            ) if isinstance(families, dict) else 0
            rss_kib = tree.get("rss_kib")
            rss_note = f", about {int(rss_kib) // 1024} MiB released" if isinstance(rss_kib, int) and rss_kib >= 0 else ""
            events.append(
                NotificationEvent(
                    key,
                    "Codex MCP cleanup complete",
                    f"{label} was verified gone ({helpers} helpers{rss_note}).",
                    once=True,
                )
            )
        else:
            events.append(
                NotificationEvent(
                    key,
                    "Detached Codex runtime detected",
                    f"{label} is detached in state {state}; lifecycle safeguards remain active.{helper_note}",
                )
            )
    return events


SWAP_PRESSURE_SIGNAL_ID = "swap-pressure"
HELPER_PRESSURE_SIGNAL_ID = "mcp-helper-count-pressure"
_SWAP_USAGE_FIELD = re.compile(r"\b(total|used)\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)", re.IGNORECASE)
_SWAP_UNIT_MIB = {"": 1.0 / (1024.0 * 1024.0), "K": 1.0 / 1024.0, "M": 1.0, "G": 1024.0, "T": 1024.0 * 1024.0}


def read_swap_usage(runner=None) -> tuple[float, float] | None:
    """Return (used_mib, total_mib) parsed from `sysctl vm.swapusage`.

    Returns None whenever swap telemetry is unavailable: sysctl is missing,
    exits non-zero, times out, or prints something this parser does not
    recognize.  Absence must never fail the guard run.
    """
    run = runner or subprocess.run
    try:
        result = run(
            ["sysctl", "-n", "vm.swapusage"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if getattr(result, "returncode", 1) != 0:
        return None
    stdout = getattr(result, "stdout", None)
    if not isinstance(stdout, str) or not stdout.strip():
        return None
    fields: dict[str, float] = {}
    for name, quantity, unit in _SWAP_USAGE_FIELD.findall(stdout):
        try:
            fields[name.lower()] = float(quantity) * _SWAP_UNIT_MIB[unit.upper()]
        except (KeyError, ValueError):
            continue
    used = fields.get("used")
    total = fields.get("total")
    if used is None or total is None:
        return None
    if not math.isfinite(used) or not math.isfinite(total) or total <= 0 or used < 0:
        return None
    return used, total


def swap_pressure_signal(swap_usage: tuple[float, float] | None) -> str | None:
    """Format the swap pressure signal, or None when below threshold/unavailable."""
    if swap_usage is None:
        return None
    used_mib, total_mib = swap_usage
    used_pct = used_mib / total_mib * 100.0
    if used_pct <= SWAP_PRESSURE_PCT:
        return None
    return (
        f"{SWAP_PRESSURE_SIGNAL_ID}: swap used {used_mib:.0f} MiB of {total_mib:.0f} MiB "
        f"({used_pct:.0f}% > {SWAP_PRESSURE_PCT}% threshold)"
    )


def helper_count_pressure_signal(helper_process_count: int) -> str | None:
    """Format the MCP helper-count pressure signal, or None when below threshold."""
    if helper_process_count <= HELPER_PRESSURE_COUNT:
        return None
    return (
        f"{HELPER_PRESSURE_SIGNAL_ID}: {helper_process_count} MCP helper processes "
        f"exceed the {HELPER_PRESSURE_COUNT}-process threshold"
    )


def inspect_process_pressure(
    proc_table: dict[int, Proc],
    lifecycle_status: dict[str, object] | None = None,
    *,
    swap_usage_reader: Callable[[], tuple[float, float] | None] | None = None,
) -> tuple[dict[str, int], list[str]]:
    app_servers = sorted(
        proc.pid for proc in proc_table.values() if is_codex_appserver(proc)
    )
    live_app_servers = {
        proc.pid for proc in proc_table.values()
        if is_codex_appserver(proc) and proc.ppid != 1
    }
    node_repls = [proc for proc in proc_table.values() if is_node_repl(proc)]
    child_map = children_by_parent(proc_table)
    mcp_pids: set[int] = set()
    for proc in proc_table.values():
        if is_mcp_signature(proc):
            mcp_pids.update(descendants(proc.pid, child_map))
    chrome_zombies = sum(
        1 for proc in proc_table.values()
        if proc.state.startswith("Z")
        and proc.ppid in proc_table
        and is_chrome_devtools_mcp_root(proc_table[proc.ppid].args)
    )
    orphan_roots = actionable_orphan_roots(proc_table)
    counts = {
        "app_servers": len(app_servers),
        "loaded_task_stacks": sum(proc.ppid in live_app_servers for proc in node_repls),
        "chrome_zombies": chrome_zombies,
        "node_repls": len(node_repls),
        "mcp_helper_processes": len(mcp_pids),
        "mcp_rss_mib": sum(proc_table[pid].rss_kib for pid in mcp_pids if pid in proc_table) // 1024,
        "actionable_orphans": len(orphan_roots),
        "would_kill": 0,
        "context7_wrappers": 0,
        "context7_app_cache_removed": 0,
        "chrome_wrappers": 0,
        "decodo_wrappers": 0,
        "computer_use_helpers": 0,
        "projects_tweak_mcp": 0,
        "project_chrome_profile_mcp": 0,
        "killed_pids": 0,
    }
    warnings: list[str] = []

    # Machine-wide pressure signals come first so a death spiral is never
    # crowded out of the (truncated) notification by per-app wrapper noise.
    helper_signal = helper_count_pressure_signal(len(mcp_pids))
    if helper_signal is not None:
        warnings.append(helper_signal)
    swap_usage = (swap_usage_reader or read_swap_usage)()
    if swap_usage is not None:
        used_mib, total_mib = swap_usage
        counts["swap_used_mib"] = int(used_mib)
        counts["swap_total_mib"] = int(total_mib)
        counts["swap_used_pct"] = int(round(used_mib / total_mib * 100.0))
    swap_signal = swap_pressure_signal(swap_usage)
    if swap_signal is not None:
        warnings.append(swap_signal)

    for app_pid in app_servers:
        context7_roots = matching_root_processes(proc_table, app_pid, "context7")
        chrome_roots = matching_root_processes(proc_table, app_pid, "chrome")
        decodo_roots = matching_root_processes(proc_table, app_pid, "decodo")
        computer_use_roots = matching_root_processes(proc_table, app_pid, "computer-use")
        projects_tweak_roots = matching_root_processes(proc_table, app_pid, "projects-tweak")
        project_chrome_profile_roots = matching_root_processes(proc_table, app_pid, "project-chrome-profile")
        counts["context7_wrappers"] += len(context7_roots)
        counts["chrome_wrappers"] += len(chrome_roots)
        counts["decodo_wrappers"] += len(decodo_roots)
        counts["projects_tweak_mcp"] += len(projects_tweak_roots)
        counts["project_chrome_profile_mcp"] += len(project_chrome_profile_roots)

        if len(context7_roots) > CONTEXT7_WARN:
            warnings.append(f"Codex app-server {app_pid} has {len(context7_roots)} context7 wrappers")
        if len(chrome_roots) > CHROME_WARN:
            warnings.append(f"Codex app-server {app_pid} has {len(chrome_roots)} chrome-devtools wrappers")
        if len(decodo_roots) > DECODO_WARN:
            warnings.append(f"Codex app-server {app_pid} has {len(decodo_roots)} Decodo MCP wrappers")
        if lifecycle_status is None and len(computer_use_roots) > COMPUTER_USE_WARN:
            warnings.append(f"Codex app-server {app_pid} has {len(computer_use_roots)} Computer Use helpers")
        if len(projects_tweak_roots) > PROJECTS_TWEAK_WARN:
            warnings.append(f"Codex app-server {app_pid} has {len(projects_tweak_roots)} Projects tweak MCP servers")
        if len(project_chrome_profile_roots) > PROJECT_CHROME_PROFILE_WARN:
            warnings.append(
                f"Codex app-server {app_pid} has {len(project_chrome_profile_roots)} Project Chrome Profile MCP servers"
            )

    computer_use_roots = matching_processes(proc_table, "computer-use")
    counts["computer_use_helpers"] = len(computer_use_roots)
    if lifecycle_status is None and len(computer_use_roots) > COMPUTER_USE_WARN:
        warnings.append(f"Codex has {len(computer_use_roots)} Computer Use helpers")
    if lifecycle_status is not None:
        apply_lifecycle_counts(counts, lifecycle_status)
    return counts, warnings


def archive_stale_threads(quiet: bool, dry_run: bool) -> tuple[int, int]:
    if not STATE_DB.exists():
        return 0, 0

    cutoff_s = int(time.time() - PROJECT_THREAD_RETAIN_DAYS * 24 * 3600)
    now_s = int(time.time())
    archive_candidate_query = """
        WITH ranked_threads AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY COALESCE(NULLIF(cwd, ''), '(no project)')
                    ORDER BY COALESCE(updated_at, created_at, 0) DESC, id DESC
                ) AS project_rank
            FROM threads
            WHERE archived = 0
        )
        SELECT t.id
        FROM threads t
        JOIN ranked_threads r ON r.id = t.id
        WHERE t.archived = 0
          AND COALESCE(t.updated_at, t.created_at, 0) < ?
          AND r.project_rank > ?
    """
    with sqlite3.connect(STATE_DB) as conn:
        stale_count = conn.execute(
            f"SELECT COUNT(*) FROM ({archive_candidate_query})",
            (cutoff_s, PROJECT_THREAD_RETAIN_COUNT),
        ).fetchone()[0]
        open_edge_count = conn.execute("SELECT COUNT(*) FROM thread_spawn_edges WHERE status = 'open'").fetchone()[0]

        if dry_run or stale_count == 0:
            return stale_count, open_edge_count

        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            UPDATE threads
            SET archived = 1, archived_at = ?
            WHERE id IN (
                WITH ranked_threads AS (
                    SELECT
                        id,
                        row_number() OVER (
                            PARTITION BY COALESCE(NULLIF(cwd, ''), '(no project)')
                            ORDER BY COALESCE(updated_at, created_at, 0) DESC, id DESC
                        ) AS project_rank
                    FROM threads
                    WHERE archived = 0
                )
                SELECT t.id
                FROM threads t
                JOIN ranked_threads r ON r.id = t.id
                WHERE t.archived = 0
                  AND COALESCE(t.updated_at, t.created_at, 0) < ?
                  AND r.project_rank > ?
            )
            """,
            (now_s, cutoff_s, PROJECT_THREAD_RETAIN_COUNT),
        )
        conn.execute(
            """
            UPDATE thread_spawn_edges
            SET status = 'closed'
            WHERE status != 'closed'
              AND (
                child_thread_id IN (SELECT id FROM threads WHERE archived = 1)
                OR parent_thread_id IN (SELECT id FROM threads WHERE archived = 1)
              )
            """
        )
        conn.commit()
        log(
            "archived "
            f"{stale_count} stale threads outside the per-project retention window "
            f"(keep {PROJECT_THREAD_RETAIN_COUNT} newest or {PROJECT_THREAD_RETAIN_DAYS} days)",
            quiet,
        )
        return stale_count, open_edge_count


def load_notify_state(path: Path | None = None) -> dict[str, float]:
    state_path = path or NOTIFY_STATE
    if not state_path.exists():
        return {}
    try:
        payload = json.loads(state_path.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        str(key): float(value)
        for key, value in payload.items()
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    }


def save_notify_state(state: dict[str, float], path: Path | None = None) -> None:
    state_path = path or NOTIFY_STATE
    state_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{state_path.name}.", dir=state_path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(state, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, state_path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def write_guard_status(
    counts: dict[str, int],
    warnings: list[str],
    lifecycle_error: str | None,
    *,
    path: Path | None = None,
    generated_at: float | None = None,
) -> None:
    """Publish an atomic, notification-only heartbeat without cleanup authority."""
    status_path = path or GUARD_STATUS
    status_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "generated_at": time.time() if generated_at is None else generated_at,
        "producer_version": "0.3.1",
        "policy_version": "notification-only-v2",
        "authority": "notification-only",
        "job": {"ok": True, "mode": "observation", "error": None},
        "pressure_signals": sorted(set(warnings)),
        "lifecycle_status_error": _redact_local_path(lifecycle_error),
        "counts": {
            key: value for key, value in counts.items()
            if isinstance(value, int) and not isinstance(value, bool)
        },
    }
    fd, temporary_name = tempfile.mkstemp(prefix=f".{status_path.name}.", dir=status_path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, status_path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def _redact_local_path(value: str | None) -> str | None:
    if value is None:
        return None
    return _redact_watcher_text(value, Path.home())


def _redact_watcher_text(value: str | None, home_directory: Path) -> str | None:
    """Bound text surfaced in the read-only watcher snapshot.

    The snapshot is consumed by a separate Menu Bar process, so never publish
    a home path or credentials embedded in status errors.  This intentionally
    mirrors the TypeScript publisher's bounded redaction rules.
    """
    if value is None:
        return None
    redacted = str(value).replace(str(home_directory), "~")
    redacted = re.sub(r"/Users/[^/\s]+", "~", redacted)
    redacted = re.sub(
        r"(--(?:token|api[-_]?key|password)(?:=|\s+))\S+",
        r"\1[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )
    redacted = re.sub(r"\b(Bearer)\s+\S+", r"\1 [redacted]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b", "[redacted]", redacted)
    return redacted[:MAX_WATCHER_TEXT_LENGTH]


def _iso8601(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        if not math.isfinite(value) or value < 0:
            return None
        seconds = float(value)
    if isinstance(value, str):
        try:
            seconds = datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (TypeError, ValueError, OverflowError, OSError):
            return None
    elif not isinstance(value, (int, float)):
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (OverflowError, OSError, ValueError):
        return None


def _read_json_object(path: Path) -> dict[str, object] | None:
    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("non-finite JSON constant")),
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError, OverflowError):
        return None
    return payload if isinstance(payload, dict) else None


def _launchd_watcher_state(label: str) -> dict[str, object]:
    """Read launchd state only; this never starts, stops, or reloads a job."""
    target = f"gui/{os.getuid()}/{label}"
    try:
        result = subprocess.run(
            ["launchctl", "print", target],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"loaded": False, "running": False, "lastExitCode": None}
    if result.returncode != 0:
        return {"loaded": False, "running": False, "lastExitCode": None}
    output = result.stdout
    exit_match = re.search(r"last exit code\s*=\s*(-?\d+)", output, flags=re.IGNORECASE)
    return {
        "loaded": True,
        "running": bool(re.search(r"\bstate\s*=\s*running\b", output, flags=re.IGNORECASE)),
        "lastExitCode": int(exit_match.group(1)) if exit_match else None,
    }


def _watcher_freshness(
    *,
    checked_at: float,
    cadence_seconds: int,
    installed: bool,
    loaded: bool,
    last_run_at: str | None,
    status_schema_version: int | None,
    supported_status_schemas: set[int],
) -> tuple[str, str | None]:
    if not installed or not loaded:
        return "missing", None
    if status_schema_version is None or status_schema_version not in supported_status_schemas:
        return "unsupported", None
    if not last_run_at:
        return "unknown", None
    try:
        last_run = __import__("datetime").datetime.fromisoformat(last_run_at.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OverflowError):
        return "unknown", None
    if last_run > checked_at + 5:
        return "unknown", None
    next_expected = _iso8601(last_run + cadence_seconds)
    return ("fresh" if checked_at <= last_run + cadence_seconds * 3 else "stale"), next_expected


def _watcher_status(
    *,
    installed: bool,
    loaded: bool,
    last_exit_code: int | None,
    freshness: str,
    deferred_reason: str | None,
    error: str | None,
) -> str:
    if not installed or not loaded or error or (last_exit_code is not None and last_exit_code != 0):
        return "error"
    if freshness in {"unsupported", "stale"}:
        return "error"
    if freshness != "fresh" or deferred_reason:
        return "warn"
    return "ok"


def _watcher_status_document(
    path: Path,
    *,
    supported_schemas: set[int],
    fallback_policy_version: str,
    read_json: Callable[[Path], dict[str, object] | None],
    home_directory: Path,
) -> dict[str, object]:
    document = read_json(path)
    if document is None:
        return {
            "lastRunAt": None,
            "lastSuccessAt": None,
            "statusSchemaVersion": None,
            "policyVersion": fallback_policy_version,
            "error": _redact_watcher_text(f"status missing: {path}", home_directory),
        }
    schema = document.get("schema_version", document.get("schemaVersion"))
    schema_version = schema if isinstance(schema, int) and not isinstance(schema, bool) else None
    generated_at = _iso8601(document.get("generated_at", document.get("generatedAt")))
    job = document.get("job")
    job = job if isinstance(job, dict) else None
    job_ok = job.get("ok") if job else None
    policy = document.get("cleanup_policy_version", document.get("policyVersion"))
    policy_version = _redact_watcher_text(
        policy if isinstance(policy, str) and policy else fallback_policy_version,
        home_directory,
    )
    raw_error: str | None = None
    if schema_version is None:
        raw_error = "status schema missing or invalid"
    elif schema_version not in supported_schemas:
        raw_error = f"unsupported status schema: {schema_version}"
    elif generated_at is None:
        raw_error = "status timestamp missing or invalid"
    elif job is None or not isinstance(job_ok, bool):
        raw_error = "status job missing or invalid"
    elif job_ok is False:
        raw = job.get("error")
        raw_error = raw if isinstance(raw, str) and raw else "watcher reported an unhealthy run"
    return {
        "lastRunAt": generated_at,
        "lastSuccessAt": generated_at if job_ok is True else None,
        "statusSchemaVersion": schema_version,
        "policyVersion": policy_version,
        "error": _redact_watcher_text(raw_error, home_directory),
    }


def _repair_watcher_status(
    path: Path,
    *,
    home_directory: Path,
    read_json: Callable[[Path], dict[str, object] | None],
) -> dict[str, object]:
    state = read_json(path)
    if state is None:
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None,
            "error": _redact_watcher_text(f"repair state missing: {path}", home_directory),
        }
    state_schema = state.get("schemaVersion", state.get("schema_version"))
    if not isinstance(state_schema, int) or isinstance(state_schema, bool) or state_schema != 1:
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None,
            "error": "repair state schema missing or unsupported",
        }
    receipt = state.get("latestCompletedCycle")
    if not isinstance(receipt, dict):
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None, "error": "repair receipt missing or invalid",
        }
    receipt_schema = receipt.get("schemaVersion", receipt.get("schema_version"))
    if not isinstance(receipt_schema, int) or isinstance(receipt_schema, bool) or receipt_schema != 1:
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None, "error": "repair receipt schema missing or unsupported",
        }
    repair = receipt.get("repair")
    if not isinstance(repair, dict):
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None, "error": "repair receipt missing repair result",
        }
    completed_at = _iso8601(receipt.get("completedAt"))
    repair_status = repair.get("status")
    outcome = receipt.get("outcome")
    if (
        completed_at is None
        or repair_status not in {"succeeded", "failed", "skipped", "pending"}
        or outcome not in {"completed", "failed"}
    ):
        return {
            "lastRunAt": None, "lastSuccessAt": None, "statusSchemaVersion": None,
            "policyVersion": "v1", "deferredReason": None, "error": "repair receipt timing or status is invalid",
        }
    success = (
        repair_status == "succeeded" and outcome == "completed"
    ) or (repair_status == "skipped" and outcome == "completed")
    raw_deferred = repair.get("error") if repair_status == "pending" else None
    raw_error = (
        repair.get("error") if repair_status == "failed" and isinstance(repair.get("error"), str) and repair.get("error")
        else "repair failed" if repair_status == "failed"
        else "repair skipped without a completed cycle" if repair_status == "skipped" and outcome != "completed"
        else "repair succeeded without a completed cycle" if repair_status == "succeeded" and outcome != "completed"
        else None
    )
    return {
        "lastRunAt": completed_at,
        "lastSuccessAt": completed_at if success else None,
        "statusSchemaVersion": receipt_schema,
        "policyVersion": "v1",
        "deferredReason": _redact_watcher_text(raw_deferred if isinstance(raw_deferred, str) else (
            "repair-pending" if repair_status == "pending" else None
        ), home_directory),
        "error": _redact_watcher_text(raw_error if isinstance(raw_error, str) else None, home_directory),
    }


def build_watcher_health_snapshot(
    *,
    tweakers_root: Path | None = None,
    home_directory: Path | None = None,
    guard_status_path: Path | None = None,
    checked_at: float | None = None,
    path_exists: Callable[[Path], bool] | None = None,
    read_json: Callable[[Path], dict[str, object] | None] | None = None,
    launchd_state: Callable[[str], dict[str, object]] | None = None,
) -> dict[str, object]:
    """Build the Menu Bar snapshot with injectable, read-only dependencies."""
    home = (home_directory or Path.home()).expanduser()
    root = (tweakers_root or TWEAKERS_USER_ROOT).expanduser()
    now = time.time() if checked_at is None else checked_at
    exists = path_exists or Path.exists
    read_document = read_json or _read_json_object
    launchd = launchd_state or _launchd_watcher_state
    launch_agents = home / "Library" / "LaunchAgents"
    lifecycle_dir = home / ".codex" / "tmp"
    repair_state = _repair_watcher_status(
        root / "auto-repair-state.json", home_directory=home, read_json=read_document,
    )
    reaper_state = _watcher_status_document(
        lifecycle_dir / "codex-mcp-lifecycle-status.json",
        supported_schemas={1, 2},
        fallback_policy_version="v1",
        read_json=read_document,
        home_directory=home,
    )
    guard_state = _watcher_status_document(
        guard_status_path or GUARD_STATUS,
        supported_schemas={1},
        fallback_policy_version="v1",
        read_json=read_document,
        home_directory=home,
    )

    definitions = (
        {
            "id": "tweakers-repair",
            "purpose": "Repair Tweakers after app updates and managed-runtime drift.",
            "authority": "repair-only",
            "label": REPAIR_WATCHER_LABEL,
            "cadenceSeconds": 3600,
            "triggers": ["login", "app-asar-change", "hourly"],
            "statePath": root / "auto-repair-state.json",
            "receiptPath": root / "auto-repair-state.json",
            "recommendedAction": "Run Tweakers repair and verify the repair-watcher definition.",
            "status": repair_state,
            "supportedSchemas": {1},
        },
        {
            "id": "mcp-lifecycle-reaper",
            "purpose": "Classify MCP process trees and execute the strict local cleanup policy.",
            "authority": "automatic-process-signals",
            "label": REAPER_LABEL,
            "cadenceSeconds": 60,
            "triggers": ["login", "every-60-seconds"],
            "statePath": lifecycle_dir / "codex-mcp-lifecycle-state.json",
            "receiptPath": lifecycle_dir / "codex-mcp-lifecycle-actions.jsonl",
            "recommendedAction": "Run Tweakers lifecycle repair; do not start a second cleanup service.",
            "status": reaper_state,
            "supportedSchemas": {1, 2},
        },
        {
            "id": "mcp-pressure-guard",
            "purpose": "Observe MCP pressure and publish notification-only warnings.",
            "authority": "notification-only",
            "label": GUARD_LABEL,
            "cadenceSeconds": 60,
            "triggers": ["login", "every-60-seconds"],
            "statePath": lifecycle_dir / "codex-mcp-guard-notify.json",
            "receiptPath": None,
            "recommendedAction": "Run Tweakers lifecycle repair and verify the guard heartbeat.",
            "status": guard_state,
            "supportedSchemas": {1},
        },
    )
    watchers: list[dict[str, object]] = []
    for definition in definitions:
        label = str(definition["label"])
        service = launchd(label)
        installed_path = launch_agents / f"{label}.plist"
        installed = bool(exists(installed_path))
        loaded = service.get("loaded") is True
        running = service.get("running") is True
        exit_code = service.get("lastExitCode")
        exit_code = exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None
        status_data = definition["status"]
        assert isinstance(status_data, dict)
        last_run_at = status_data["lastRunAt"]
        assert last_run_at is None or isinstance(last_run_at, str)
        freshness, next_expected_at = _watcher_freshness(
            checked_at=now,
            cadence_seconds=int(definition["cadenceSeconds"]),
            installed=installed,
            loaded=loaded,
            last_run_at=last_run_at,
            status_schema_version=status_data["statusSchemaVersion"] if isinstance(status_data["statusSchemaVersion"], int) else None,
            supported_status_schemas=definition["supportedSchemas"],  # type: ignore[arg-type]
        )
        deferred = status_data.get("deferredReason")
        error = status_data.get("error")
        deferred = deferred if isinstance(deferred, str) else None
        error = error if isinstance(error, str) else None
        status = _watcher_status(
            installed=installed,
            loaded=loaded,
            last_exit_code=exit_code,
            freshness=freshness,
            deferred_reason=deferred,
            error=error,
        )
        state_path = definition["statePath"]
        receipt_path = definition["receiptPath"]
        watchers.append({
            "id": definition["id"],
            "purpose": definition["purpose"],
            "authority": definition["authority"],
            "platformKind": sys.platform,
            "label": label,
            "installedPath": _redact_watcher_text(str(installed_path), home),
            "cadenceSeconds": definition["cadenceSeconds"],
            "triggers": definition["triggers"],
            "installed": installed,
            "loaded": loaded,
            "running": running,
            "lastRunAt": last_run_at,
            "lastExitCode": exit_code,
            "lastSuccessAt": status_data["lastSuccessAt"],
            "nextExpectedAt": next_expected_at,
            "freshness": freshness,
            "status": status,
            "statusSchemaVersion": status_data["statusSchemaVersion"],
            "policyVersion": status_data["policyVersion"],
            "statePath": _redact_watcher_text(str(state_path), home) if state_path else None,
            "receiptPath": _redact_watcher_text(str(receipt_path), home) if receipt_path else None,
            "deferredReason": deferred,
            "error": error,
            "recommendedAction": None if status == "ok" else definition["recommendedAction"],
        })
    overall = "error" if any(entry["status"] == "error" for entry in watchers) else (
        "warn" if any(entry["status"] == "warn" for entry in watchers) else "ok"
    )
    return {
        "schema": WATCHER_HEALTH_SCHEMA,
        "schemaVersion": WATCHER_HEALTH_SCHEMA_VERSION,
        "checkedAt": _iso8601(now),
        "status": overall,
        "watchers": watchers,
    }


def _write_private_json_atomically(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise


def publish_watcher_health_snapshot(
    *,
    path: Path | None = None,
    last_known_good_path: Path | None = None,
    **build_kwargs: object,
) -> dict[str, object]:
    """Publish only evidence gathered by the independent watcher owners."""
    snapshot = build_watcher_health_snapshot(**build_kwargs)
    snapshot_path = path or WATCHER_HEALTH
    _write_private_json_atomically(snapshot_path, snapshot)
    watchers = snapshot.get("watchers")
    if isinstance(watchers, list) and len(watchers) == 3 and all(
        isinstance(entry, dict) and entry.get("status") == "ok" for entry in watchers
    ):
        _write_private_json_atomically(last_known_good_path or WATCHER_HEALTH_LAST_KNOWN_GOOD, snapshot)
    return snapshot


def maybe_notify(
    key: str,
    title: str,
    message: str,
    quiet: bool = False,
    *,
    no_notify: bool = False,
    once: bool = False,
    now: float | None = None,
    runner=None,
    state_path: Path | None = None,
    notify_script: Path | None = None,
) -> str:
    """Attempt a notification; `quiet` intentionally affects stdout only."""
    del quiet
    if no_notify:
        return "disabled"
    script = notify_script or NOTIFY_SCRIPT
    if not script.exists():
        print(f"codex-mcp-guard: notification helper is missing: {script}", file=sys.stderr, flush=True)
        return "failed"
    current_time = time.time() if now is None else now
    state = load_notify_state(state_path)
    if once and key in state:
        return "deduped"
    last_sent = state.get(key, 0)
    if current_time - last_sent < NOTIFY_COOLDOWN_SEC:
        return "cooldown"
    run_notification = runner or subprocess.run
    try:
        result = run_notification(
            [str(script), title, message],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as exc:
        print(f"codex-mcp-guard: notification helper failed: {exc}", file=sys.stderr, flush=True)
        return "failed"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "no error output").strip()
        print(
            f"codex-mcp-guard: notification helper exited {result.returncode}: {detail}",
            file=sys.stderr,
            flush=True,
        )
        return "failed"
    state[key] = current_time
    try:
        save_notify_state(state, state_path)
    except OSError as exc:
        print(f"codex-mcp-guard: could not persist notification state: {exc}", file=sys.stderr, flush=True)
        return "failed"
    return "sent"


def print_status(
    stale_threads: int,
    open_edges: int,
    counts: dict[str, int],
    warnings: list[str],
    lifecycle_status: dict[str, object] | None = None,
    lifecycle_error: str | None = None,
) -> None:
    print(f"stale_threads={stale_threads}")
    print(f"open_spawn_edges={open_edges}")
    print(f"codex_app_servers={counts['app_servers']}")
    print(f"loaded_task_stacks={counts['loaded_task_stacks']}")
    print(f"chrome_zombies={counts['chrome_zombies']}")
    print(f"node_repls={counts['node_repls']}")
    print(f"mcp_helper_processes={counts.get('mcp_helper_processes', 0)}")
    print(f"mcp_rss_mib={counts['mcp_rss_mib']}")
    if "swap_used_pct" in counts:
        print(
            f"swap_used_pct={counts['swap_used_pct']} "
            f"({counts.get('swap_used_mib', 0)}/{counts.get('swap_total_mib', 0)} MiB)"
        )
    print(f"actionable_orphans={counts['actionable_orphans']}")
    print(f"would_kill={counts['would_kill']}")
    print(f"context7_wrappers={counts['context7_wrappers']}")
    print(f"context7_app_cache_removed={counts.get('context7_app_cache_removed', 0)}")
    print(f"chrome_wrappers={counts['chrome_wrappers']}")
    print(f"decodo_wrappers={counts['decodo_wrappers']}")
    print(f"computer_use_helpers={counts['computer_use_helpers']}")
    print(f"projects_tweak_mcp={counts['projects_tweak_mcp']}")
    print(f"project_chrome_profile_mcp={counts['project_chrome_profile_mcp']}")
    print(f"killed_pids={counts['killed_pids']}")
    if lifecycle_error:
        print(f"lifecycle_status=unavailable: {lifecycle_error}")
    elif lifecycle_status is not None:
        job = lifecycle_status.get("job")
        mode = job.get("mode") if isinstance(job, dict) else None
        print(f"lifecycle_status=ok mode={mode or 'unknown'}")
        trees = lifecycle_status.get("trees")
        if isinstance(trees, list):
            for raw_tree in trees:
                if not isinstance(raw_tree, dict):
                    continue
                print(
                    "lifecycle_tree="
                    f"{_tree_label(raw_tree)} "
                    f"ownership={raw_tree.get('ownership', 'unknown')} "
                    f"state={raw_tree.get('state', 'unknown')} "
                    f"computer_use={_helper_count(raw_tree.get('helper_family_counts'), 'computer_use')}"
                )
    if warnings:
        print("warnings:")
        for warning in warnings:
            print(f"- {warning}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Archive stale Codex threads and report MCP subprocess pressure.")
    parser.add_argument(
        "--scope",
        choices=("all", "threads-only", "process-only", "status"),
        default="all",
        help="Which remediation steps to run.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Report actions without mutating state.")
    parser.add_argument("--quiet", action="store_true", help="Suppress non-status output.")
    parser.add_argument(
        "--no-notify",
        action="store_true",
        help="Explicitly disable macOS notifications (quiet mode does not disable them).",
    )
    return parser.parse_args()


def main(*, publisher: Callable[[], object] | None = None) -> int:
    args = parse_args()
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    stale_threads = 0
    open_edges = 0
    if args.scope in {"all", "threads-only", "status"}:
        stale_threads, open_edges = archive_stale_threads(args.quiet, args.dry_run or args.scope == "status")

    counts = {
        "app_servers": 0,
        "loaded_task_stacks": 0,
        "chrome_zombies": 0,
        "node_repls": 0,
        "mcp_helper_processes": 0,
        "mcp_rss_mib": 0,
        "actionable_orphans": 0,
        "would_kill": 0,
        "context7_wrappers": 0,
        "context7_app_cache_removed": 0,
        "chrome_wrappers": 0,
        "decodo_wrappers": 0,
        "computer_use_helpers": 0,
        "projects_tweak_mcp": 0,
        "project_chrome_profile_mcp": 0,
        "killed_pids": 0,
    }
    warnings: list[str] = []
    lifecycle_status: dict[str, object] | None = None
    lifecycle_error: str | None = None
    if args.scope in {"all", "process-only", "status"}:
        lifecycle_status, lifecycle_error = load_lifecycle_status()
        validated_status = lifecycle_status if lifecycle_error is None else None
        proc_table = load_processes()
        counts, warnings = inspect_process_pressure(proc_table, validated_status)

    if args.scope == "status" or not args.quiet:
        print_status(stale_threads, open_edges, counts, warnings, lifecycle_status, lifecycle_error)

    notification_failed = False
    if warnings:
        result = maybe_notify(
            "wrapper-pressure",
            "Codex MCP pressure",
            "; ".join(warnings[:2]),
            args.quiet,
            no_notify=args.no_notify,
        )
        notification_failed = result == "failed"
    validated_status = lifecycle_status if lifecycle_error is None else None
    lifecycle_events = lifecycle_notification_events(validated_status, lifecycle_error)
    for event in lifecycle_events:
        result = maybe_notify(
            event.key,
            event.title,
            event.message,
            args.quiet,
            no_notify=args.no_notify,
            once=event.once,
        )
        notification_failed = notification_failed or result == "failed"
    try:
        lifecycle_pressure = [
            event.message
            for event in lifecycle_events
            if ":ui-pressure:" in event.key
        ]
        write_guard_status(counts, [*warnings, *lifecycle_pressure], lifecycle_error)
    except OSError as exc:
        print(f"codex-mcp-guard: could not persist heartbeat: {exc}", file=sys.stderr, flush=True)
        return 1
    try:
        (publisher or publish_watcher_health_snapshot)()
    except Exception as exc:
        detail = _redact_watcher_text(str(exc), Path.home()) or "unknown publisher failure"
        print(f"codex-mcp-guard: watcher snapshot unavailable: {detail}", file=sys.stderr, flush=True)
    return 1 if notification_failed else 0


if __name__ == "__main__":
    sys.exit(main())
