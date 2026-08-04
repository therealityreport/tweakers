#!/usr/bin/env python3
"""Pure process ownership and lifecycle state for Codex MCP cleanup.

This module never sends signals.  The reaper is the only signal owner; the
guard and Menu Bar consume the schema emitted here.
"""

from __future__ import annotations

import hashlib
import ctypes
import json
import math
import os
import re
import shlex
import subprocess
import tempfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Iterable


SCHEMA_VERSION = 2
STATE_SCHEMA_VERSION = 1
PRODUCER_VERSION = "0.4.0"
CLEANUP_POLICY_VERSION = "strict-detached-v4"
MATCHER_REGISTRY_VERSION = "mcp-family-descriptors-v4"
# Soft-blocker policy (strict-detached-v4): inside a *detached* tree, an
# unrecognized node/node_repl process -- or a node/npm/npx/python launcher
# whose arguments mention "mcp" -- is presumed to be an MCP helper that the
# dead UI can no longer retire.  Such a process blocks cleanup only while it
# accrues CPU; a CPU-idle soft blocker lets the 600-second countdown run.
# Live/ui_owned trees never reach the blocker branch and stay observation-only.
SOFT_BLOCKER_BASENAMES = {"node", "node_repl"}
SOFT_BLOCKER_LAUNCHER_BASENAMES = {"node", "npm", "npx", "python", "python3"}
SOFT_BLOCKER_LAUNCHER_PATTERN = re.compile(r"python3\.\d+")
# Minimum per-cycle CPU accrual (seconds) that proves a soft blocker is active.
SOFT_BLOCKER_CPU_DELTA = 0.5
LANE_MODES = {
    "detached_wrapper": "automatic",
    # Only a kernel-proven, direct app-server orphan can enter this lane.
    # Generic orphan observations remain explicitly observation-only below.
    "exact_standalone_app_server": "automatic",
    "standalone_orphan": "observation_only",
    "claude_idle": "observation_only",
}
PROC_PIDTBSDINFO = 3
PROC_PIDVNODEPATHINFO = 9
PROC_PIDPATHINFO_MAXSIZE = 4096
MAXPATHLEN = 1024

APP_SERVER_WORD = re.compile(r"(?:^|\s)app-server(?:\s|$)")
WRAPPER_MARKER = "Tweakers Codex parent:"
WRAPPER_NODE_SUFFIX = "/cua_node/bin/node"
ALLOWED_WRAPPER_PAIRS = {
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node":
        "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node":
        "/Applications/Codex.app/Contents/Resources/codex",
}
SWAP_TEXT_VNODE = re.compile(
    r"^/Applications/(ChatGPT|Codex)\.app\.tweakers-contents-swap/(.+)$"
)
SWAP_RUNTIME_SUFFIXES = {
    "Resources/codex",
    "Resources/codex-code-mode-host",
    "Resources/cua_node/bin/node_repl",
    "Resources/cua_node/bin/node",
    "SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    "Resources/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
}
ALLOWED_CODE_MODE_HOSTS = {
    "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host",
    "/Applications/Codex.app/Contents/Resources/codex-code-mode-host",
}
ALLOWED_NODE_REPL_PATHS = {
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
    "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl",
}
ALLOWED_COMPUTER_USE_PATHS = {
    "/Applications/ChatGPT.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    "/Applications/Codex.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    "/Applications/ChatGPT.app/Contents/Resources/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    "/Applications/Codex.app/Contents/Resources/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    str(Path.home() / ".codex" / "computer-use" / "Codex Computer Use.app" / "Contents" / "SharedSupport" / "SkyComputerUseClient.app" / "Contents" / "MacOS" / "SkyComputerUseClient"),
}
NPM_MCP_PACKAGES = {
    "@playwright/mcp", "@decodo/mcp-server", "pdfx-cli", "shadcn",
    "xcodebuildmcp", "next-devtools-mcp", "chrome-devtools-mcp",
    "@upstash/context7-mcp", "scrapling",
}

SHELL_NAMES = {"sh", "bash", "zsh", "fish", "dash"}
TRUSTED_LAUNCHER_DIRECTORIES = {
    Path("/bin"),
    Path("/usr/bin"),
    Path("/opt/homebrew/bin"),
    Path("/usr/local/bin"),
    Path.home() / ".local" / "bin",
    Path.home() / ".cargo" / "bin",
    Path("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin"),
    Path("/Applications/Codex.app/Contents/Resources/cua_node/bin"),
}
TRUSTED_LAUNCHER_ROOTS = {
    Path.home() / ".nvm" / "versions" / "node",
}
TRUSTED_SCRIPT_ROOTS = {
    Path.home() / ".codex" / "plugins" / "cache",
    Path.home() / ".codex" / "plugins",
    Path.home() / ".codex" / ".tmp" / "plugins",
    Path.home() / "Library" / "Application Support" / "codex-plusplus",
    Path.home() / ".nvm" / "versions" / "node",
    Path.home() / ".local" / "bin",
    Path.home() / ".local" / "share" / "uv" / "tools",
    Path("/opt/homebrew/lib/node_modules"),
    Path("/usr/local/lib/node_modules"),
}
TRUSTED_PLUGIN_CACHE_ROOTS = {
    Path.home() / ".codex" / "plugins" / "cache",
    Path.home() / ".codex" / ".tmp" / "plugins",
}
HOMEBREW_PYTHON_EXECUTABLE = re.compile(
    r"^/(?:opt/homebrew|usr/local)/Cellar/python@[^/]+/[^/]+/Frameworks/"
    r"Python\.framework/Versions/[^/]+/Resources/Python\.app/Contents/MacOS/Python$"
)
MCP_SIGNATURES = (
    "chrome-devtools-mcp",
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
    "modal_ops_mcp.py",
    "./mcp/server.mjs",
    "./mcp/server.bundle.mjs",
    "./mcp/server.cjs",
    "xcodebuildmcp",
    "next-devtools-mcp",
    "@playwright/mcp",
    "playwright-mcp",
    "headroom mcp serve",
    "user-questions/mcp-server.js",
    "gsd-pi/packages/mcp-server",
    "iconify-mcp.mjs",
    "react-doctor-mcp.mjs",
    "telemetry/watchdog/main.js",
    "skycomputeruseclient",
    "event-stream mcp",
    "node_repl",
)


class _ProcBSDInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


class _VInfoStat(ctypes.Structure):
    _fields_ = [
        ("vst_dev", ctypes.c_uint32),
        ("vst_mode", ctypes.c_uint16),
        ("vst_nlink", ctypes.c_uint16),
        ("vst_ino", ctypes.c_uint64),
        ("vst_uid", ctypes.c_uint32),
        ("vst_gid", ctypes.c_uint32),
        ("vst_atime", ctypes.c_int64),
        ("vst_atimensec", ctypes.c_int64),
        ("vst_mtime", ctypes.c_int64),
        ("vst_mtimensec", ctypes.c_int64),
        ("vst_ctime", ctypes.c_int64),
        ("vst_ctimensec", ctypes.c_int64),
        ("vst_birthtime", ctypes.c_int64),
        ("vst_birthtimensec", ctypes.c_int64),
        ("vst_size", ctypes.c_int64),
        ("vst_blocks", ctypes.c_int64),
        ("vst_blksize", ctypes.c_int32),
        ("vst_flags", ctypes.c_uint32),
        ("vst_gen", ctypes.c_uint32),
        ("vst_rdev", ctypes.c_uint32),
        ("vst_qspare", ctypes.c_int64 * 2),
    ]


class _VnodeInfo(ctypes.Structure):
    _fields_ = [
        ("vi_stat", _VInfoStat),
        ("vi_type", ctypes.c_int),
        ("vi_pad", ctypes.c_int),
        ("vi_fsid", ctypes.c_int32 * 2),
    ]


class _VnodeInfoPath(ctypes.Structure):
    _fields_ = [("vip_vi", _VnodeInfo), ("vip_path", ctypes.c_char * MAXPATHLEN)]


class _ProcVnodePathInfo(ctypes.Structure):
    _fields_ = [("pvi_cdir", _VnodeInfoPath), ("pvi_rdir", _VnodeInfoPath)]


def _kernel_birth(pid: int) -> str:
    """Return the kernel process start time with microsecond precision."""
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        proc_pidinfo = libproc.proc_pidinfo
        proc_pidinfo.argtypes = [
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_uint64,
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        proc_pidinfo.restype = ctypes.c_int
        info = _ProcBSDInfo()
        size = ctypes.sizeof(info)
        received = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), size)
        if received != size or info.pbi_start_tvsec <= 0:
            return ""
        return f"{info.pbi_start_tvsec}.{info.pbi_start_tvusec:06d}"
    except (AttributeError, OSError, ValueError):
        return ""


def _kernel_executable_path(pid: int) -> str:
    """Return the kernel executable path instead of the lossy ``ps comm`` text."""
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        proc_pidpath = libproc.proc_pidpath
        proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc_pidpath.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
        received = proc_pidpath(pid, buffer, len(buffer))
        if received <= 0:
            return ""
        value = os.fsdecode(buffer.value)
        return value if value.startswith("/") else ""
    except (AttributeError, OSError, ValueError):
        return ""


def _approved_text_vnode_path(lines: Iterable[str]) -> str:
    """Return one exact, kernel-reported pre-promotion Codex text vnode."""
    candidates = []
    for line in lines:
        if not line.startswith("n"):
            continue
        value = line[1:]
        if _swap_vnode_current_path(value) is not None:
            candidates.append(value)
    return candidates[0] if len(candidates) == 1 else ""


def _lsof_text_vnode_path(pid: int) -> str:
    """Conservative fallback when the kernel region API itself is unavailable."""
    try:
        completed = subprocess.run(
            ["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "txt", "-Fn"],
            check=False, capture_output=True, text=True, timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode not in (0, 1):
        return ""
    return _approved_text_vnode_path(completed.stdout.splitlines())


def _kernel_text_vnode_path(pid: int) -> str:
    """Read the main text vnode through libproc, never from process argv."""
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        proc_regionfilename = libproc.proc_regionfilename
        proc_regionfilename.argtypes = [
            ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_uint32,
        ]
        proc_regionfilename.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(PROC_PIDPATHINFO_MAXSIZE)
        received = proc_regionfilename(pid, 0, buffer, len(buffer))
        if received > 0:
            value = os.fsdecode(buffer.value)
            if _swap_vnode_current_path(value) is not None:
                return value
            return ""
    except (AttributeError, OSError, ValueError):
        pass
    return _lsof_text_vnode_path(pid)


def _kernel_cwd_path(pid: int) -> str:
    """Return the current directory from ``PROC_PIDVNODEPATHINFO`` only."""
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        proc_pidinfo = libproc.proc_pidinfo
        proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int,
        ]
        proc_pidinfo.restype = ctypes.c_int
        info = _ProcVnodePathInfo()
        size = ctypes.sizeof(info)
        received = proc_pidinfo(
            pid, PROC_PIDVNODEPATHINFO, 0, ctypes.byref(info), size,
        )
        if received != size:
            return ""
        value = os.fsdecode(bytes(info.pvi_cdir.vip_path).split(b"\\0", 1)[0])
        return value if value.startswith("/") else ""
    except (AttributeError, OSError, ValueError):
        return ""


def _elapsed_seconds(value: str) -> int:
    try:
        days, clock = (value.split("-", 1) if "-" in value else ("0", value))
        parts = [int(float(part)) for part in clock.split(":")]
        while len(parts) < 3:
            parts.insert(0, 0)
        hours, minutes, seconds = parts[-3:]
        return int(days) * 86400 + hours * 3600 + minutes * 60 + seconds
    except (TypeError, ValueError):
        return 0


def _cpu_seconds(value: str) -> float:
    try:
        parts = value.split(":")
        total = float(parts[-1])
        multiplier = 60.0
        for part in reversed(parts[:-1]):
            total += int(part) * multiplier
            multiplier *= 60
        return total
    except (TypeError, ValueError):
        return 0.0


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def _command_shape(executable: str, args: str) -> str:
    normalized = _normalized(args)
    digest = hashlib.sha256(normalized.encode("utf-8", "replace")).hexdigest()[:24]
    return f"{Path(executable).name}:{digest}"


def _command_summary(process: "ProcessInfo") -> str:
    """Return a bounded, non-secret summary rather than raw argv."""
    executable = Path(process.executable).name or process.executable
    lower = process.args.lower()
    if "object_storage_inventory_reconcile.py" in lower:
        return f"{executable} object_storage_inventory_reconcile.py"
    for token in (
        "node_repl", "skycomputeruseclient", "modal_ops_mcp.py",
        "chrome-devtools-mcp", "context7", "playwright-mcp", "decodo-mcp",
        "xcodebuildmcp", "shadcn", "pdfx", "headroom",
    ):
        if token in lower:
            return f"{executable} {token}"
    return executable


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    birth: str
    executable: str
    command_shape: str

    def to_json(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "birth": self.birth,
            "executable": self.executable,
            "command_shape": self.command_shape,
        }


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    ppid: int
    uid: int
    rss_kib: int
    state: str
    age_seconds: int
    cpu_seconds: float
    executable: str
    args: str
    birth: str
    cwd: str = ""

    @property
    def identity(self) -> ProcessIdentity | None:
        if self.pid <= 1 or not self.birth or not self.executable:
            return None
        return ProcessIdentity(
            pid=self.pid,
            birth=self.birth,
            executable=self.executable,
            command_shape=_command_shape(self.executable, self.args),
        )


@dataclass(frozen=True)
class MCPDescriptor:
    identifier: str
    family: str


@dataclass(frozen=True)
class Blocker:
    identity: ProcessIdentity | None
    name: str
    command_summary: str
    executable: str = ""
    cpu_seconds: float = 0.0
    # Computed at classification time from the full ProcessInfo (argv access);
    # a soft blocker defers to the per-cycle CPU baseline in active_blockers.
    soft: bool = False

    def to_json(self) -> dict[str, Any]:
        # Deliberately unchanged: the guard and Menu Bar consume this schema.
        return {
            "identity": self.identity.to_json() if self.identity else None,
            "name": self.name,
            "command_summary": self.command_summary,
        }


@dataclass(frozen=True)
class TreeClassification:
    tree_key: str
    root_identity: ProcessIdentity | None
    app_server_identity: ProcessIdentity | None
    ownership: str
    process_ids: tuple[int, ...]
    generation: str = ""
    blockers: tuple[Blocker, ...] = ()
    helper_family_counts: dict[str, int] = field(default_factory=dict)
    rss_kib: int = 0
    state: str = "observed"
    actionable: bool = False
    idle_since: float | None = None
    eligible_at: float | None = None
    remaining_seconds: int | None = None
    last_action: str | None = None
    last_verified_action_receipt: str | None = None
    matcher_drift: tuple[str, ...] = ()
    error: str | None = None

    def to_status(self) -> dict[str, Any]:
        return {
            "tree_key": self.tree_key,
            "root_identity": self.root_identity.to_json() if self.root_identity else None,
            "app_server_identity": self.app_server_identity.to_json() if self.app_server_identity else None,
            "ownership": self.ownership,
            "state": self.state,
            "actionable": self.actionable,
            "blockers": [blocker.to_json() for blocker in self.blockers],
            "idle_since": self.idle_since,
            "eligible_at": self.eligible_at,
            "remaining_seconds": self.remaining_seconds,
            "helper_family_counts": dict(self.helper_family_counts),
            "rss_kib": self.rss_kib,
            "last_action": self.last_action,
            "last_verified_action_receipt": self.last_verified_action_receipt,
            "matcher_drift": list(self.matcher_drift),
            "error": self.error,
        }


def load_process_snapshot(
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
    text_vnode_provider: Callable[[int], str] = _kernel_text_vnode_path,
) -> dict[int, ProcessInfo]:
    """Load one best-effort current-user process snapshot.

    macOS `proc_pidinfo(PROC_PIDTBSDINFO)` supplies a kernel start token with
    microsecond precision. Separate ps calls are joined by PID; any missing
    birth fails closed later.
    """
    base = runner(
        ["ps", "-axo", "pid=,ppid=,uid=,rss=,stat=,etime=,time=,comm="],
        check=True, capture_output=True, text=True,
    ).stdout
    argv = runner(
        ["ps", "-axo", "pid=,args="],
        check=True, capture_output=True, text=True,
    ).stdout

    args_by_pid: dict[int, str] = {}
    for line in argv.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isdigit():
            args_by_pid[int(parts[0])] = parts[1]
    snapshot: dict[int, ProcessInfo] = {}
    for line in base.splitlines():
        parts = line.strip().split(None, 7)
        if len(parts) != 8:
            continue
        try:
            pid, ppid, uid = int(parts[0]), int(parts[1]), int(parts[2])
            args = args_by_pid.get(pid, parts[7])
            executable = _kernel_executable_path(pid)
            if not executable:
                executable = text_vnode_provider(pid)
            snapshot[pid] = ProcessInfo(
                pid=pid,
                ppid=ppid,
                uid=uid,
                rss_kib=int(parts[3]),
                state=parts[4],
                age_seconds=_elapsed_seconds(parts[5]),
                cpu_seconds=_cpu_seconds(parts[6]),
                # ``ps comm`` and argv[0] can be spoofed or truncated on macOS;
                # an unavailable kernel path must remain untrusted.
                executable=executable,
                args=args,
                birth=_kernel_birth(pid),
                cwd=_kernel_cwd_path(pid),
            )
        except ValueError:
            continue
    return snapshot


def children_index(snapshot: dict[int, ProcessInfo]) -> dict[int, list[int]]:
    children: dict[int, list[int]] = defaultdict(list)
    for process in snapshot.values():
        children[process.ppid].append(process.pid)
    return children


def subtree_ids(root: int, children: dict[int, list[int]]) -> list[int]:
    found: list[int] = []
    pending = [root]
    seen: set[int] = set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        found.append(pid)
        pending.extend(children.get(pid, ()))
    return found


def is_codex_app_server(process: ProcessInfo) -> bool:
    current_path = _swap_vnode_current_path(process.executable) or process.executable
    return (
        current_path in set(ALLOWED_WRAPPER_PAIRS.values())
        and Path(process.executable).name == "codex"
        and bool(APP_SERVER_WORD.search(_normalized(process.args)))
    )


def is_exact_standalone_app_server(process: ProcessInfo) -> bool:
    """Match only a bundled Codex app-server that was reparented to launchd."""
    if process.ppid != 1:
        return False
    if not is_codex_app_server(process):
        return False
    try:
        argv0 = shlex.split(process.args)[0]
    except (IndexError, ValueError):
        return False
    if process.executable in set(ALLOWED_WRAPPER_PAIRS.values()):
        return argv0 == process.executable
    swap_current = _swap_vnode_current_path(process.executable)
    if swap_current is None or not swap_current.endswith("/Resources/codex"):
        return False
    return argv0 == swap_current


def _is_exact_swap_code_mode_host(process: ProcessInfo) -> bool:
    expected = _swap_vnode_current_path(process.executable)
    if expected is None or not expected.endswith("/Resources/codex-code-mode-host"):
        return False
    try:
        return shlex.split(process.args) == [expected]
    except ValueError:
        return False


def _swap_vnode_current_path(value: str) -> str | None:
    """Map an exact old-Contents text vnode to its same-app current runtime."""
    match = SWAP_TEXT_VNODE.fullmatch(value)
    if match is None or match.group(2) not in SWAP_RUNTIME_SUFFIXES:
        return None
    return f"/Applications/{match.group(1)}.app/Contents/{match.group(2)}"


def _is_exact_swap_node_repl(process: ProcessInfo) -> bool:
    expected = _swap_vnode_current_path(process.executable)
    if expected is None or not expected.endswith("/Resources/cua_node/bin/node_repl"):
        return False
    try:
        return shlex.split(process.args) == [expected]
    except ValueError:
        return False


def looks_like_codex_wrapper(process: ProcessInfo) -> bool:
    mapped_executable = _swap_vnode_current_path(process.executable)
    executable = mapped_executable or process.executable
    if mapped_executable is not None:
        try:
            if shlex.split(process.args)[0] != mapped_executable:
                return False
        except (IndexError, ValueError):
            return False
    return (
        executable in ALLOWED_WRAPPER_PAIRS
        and WRAPPER_MARKER in process.args
        and " -- " in _normalized(process.args)
        and bool(APP_SERVER_WORD.search(_normalized(process.args)))
    )


def _expected_wrapper_child(process: ProcessInfo) -> tuple[str, str] | None:
    if not looks_like_codex_wrapper(process):
        return None
    normalized = _normalized(process.args)
    try:
        child_command = normalized.rsplit(" -- ", 1)[1]
        child_executable = shlex.split(child_command)[0]
    except (IndexError, ValueError):
        return None
    expected_executable = ALLOWED_WRAPPER_PAIRS.get(
        _swap_vnode_current_path(process.executable) or process.executable
    )
    if child_executable != expected_executable:
        return None
    return child_executable, child_command


def _has_ui_owner(process: ProcessInfo, snapshot: dict[int, ProcessInfo]) -> bool:
    current = process.ppid
    seen: set[int] = set()
    while current > 1 and current not in seen:
        seen.add(current)
        parent = snapshot.get(current)
        if parent is None:
            return False
        haystack = f"{parent.executable} {parent.args}".lower()
        basename = Path(parent.executable).name.lower()
        if (
            "/applications/chatgpt.app/" in haystack
            or "/applications/codex.app/" in haystack
            or basename in {"chatgpt", "codex"} and not is_codex_app_server(parent)
        ):
            return True
        current = parent.ppid
    return False


def _is_shell(process: ProcessInfo) -> bool:
    return Path(process.executable).name.lower() in SHELL_NAMES


def _is_runtime(process: ProcessInfo) -> bool:
    return (
        is_codex_app_server(process)
        or looks_like_codex_wrapper(process)
        or process.executable in ALLOWED_CODE_MODE_HOSTS
        or process.executable in ALLOWED_NODE_REPL_PATHS
        or _is_exact_swap_code_mode_host(process)
        or _is_exact_swap_node_repl(process)
    )


def _exact_package_or_version(value: str, names: set[str]) -> bool:
    """Accept a package name or that exact name with one explicit version."""
    for name in names:
        if value == name:
            return True
        if value.startswith(name + "@"):
            version = value[len(name) + 1:]
            return bool(version) and bool(re.fullmatch(r"[0-9a-z._+~-]+", version))
    return False


def _lexical_absolute_path(value: str) -> Path | None:
    path = Path(value).expanduser()
    if not path.is_absolute():
        return None
    return Path(os.path.normpath(str(path)))


def _is_under(path: Path, roots: set[Path]) -> bool:
    return any(path == root or root in path.parents for root in roots)


def _is_trusted_launcher_path(executable: Path) -> bool:
    if executable.parent in TRUSTED_LAUNCHER_DIRECTORIES:
        return True
    if _is_under(executable, TRUSTED_LAUNCHER_ROOTS) and executable.parent.name == "bin":
        return True
    return bool(HOMEBREW_PYTHON_EXECUTABLE.fullmatch(str(executable)))


def _trusted_launcher(process: ProcessInfo, tokens: list[str], names: set[str]) -> str | None:
    """Return an exact launcher only when the kernel executable is trusted.

    ``npm`` and global Node CLIs commonly ``exec`` the Node binary, retaining
    their original name only in ``argv[0]``.  Accept that narrow, proven form;
    do not trust the display-only ``ps comm`` field.
    """
    if not tokens:
        return None
    executable = _lexical_absolute_path(process.executable)
    if executable is None:
        return None
    executable_name = executable.name.lower()
    argv_name = Path(tokens[0]).name.lower()
    if not _is_trusted_launcher_path(executable):
        return None
    if executable_name in names and argv_name == executable_name:
        return executable_name
    if executable_name == "node" and argv_name in names:
        return argv_name
    return None


def _trusted_script(value: str) -> Path | None:
    path = _lexical_absolute_path(value)
    if path is None:
        return None
    try:
        path = path.resolve(strict=True)
        roots = {root.resolve(strict=True) for root in TRUSTED_SCRIPT_ROOTS if root.exists()}
        plugin_dir = Path.home() / ".codex" / "plugins"
        if plugin_dir.is_dir():
            for candidate in plugin_dir.iterdir():
                if candidate.is_symlink() and (candidate / ".mcp.json").is_file():
                    roots.add(candidate.resolve(strict=True))
    except OSError:
        return None
    if not path.is_file() or not _is_under(path, roots):
        return None
    return path


def _approved_plugin_root(cwd: str) -> Path | None:
    """Find the manifest root for a kernel-derived plugin working directory."""
    cwd_path = _lexical_absolute_path(cwd)
    if cwd_path is None:
        return None
    try:
        cwd_path = cwd_path.resolve(strict=True)
        cache_roots = {
            root.resolve(strict=True) for root in TRUSTED_PLUGIN_CACHE_ROOTS if root.exists()
        }
    except OSError:
        return None
    if not _is_under(cwd_path, cache_roots):
        return None
    for candidate in (cwd_path, *cwd_path.parents):
        if not _is_under(candidate, cache_roots):
            break
        if (candidate / ".mcp.json").is_file():
            return candidate
    return None


def _declared_relative_script(process: ProcessInfo, tokens: list[str]) -> Path | None:
    """Resolve a relative script only when a plugin manifest declares this argv.

    The kernel CWD, resolved script, manifest location, and complete stdio
    command/argument vector must agree.  This deliberately does not accept an
    arbitrary ``node ./anything`` descendant merely because its CWD resembles
    a plugin cache.
    """
    if len(tokens) < 2 or Path(tokens[1]).is_absolute():
        return None
    root = _approved_plugin_root(process.cwd)
    cwd = _lexical_absolute_path(process.cwd)
    if root is None or cwd is None:
        return None
    try:
        cwd = cwd.resolve(strict=True)
        script = (cwd / tokens[1]).resolve(strict=True)
    except OSError:
        return None
    if not _is_under(script, {root}) or not script.is_file():
        return None
    try:
        document = json.loads((root / ".mcp.json").read_text(encoding="utf-8"))
        servers = document.get("mcpServers", {}) if isinstance(document, dict) else {}
    except (OSError, ValueError):
        return None
    if not isinstance(servers, dict):
        return None
    argv_name = Path(tokens[0]).name.lower()
    actual_args = tokens[1:]
    for server in servers.values():
        if not isinstance(server, dict) or server.get("type", "stdio") != "stdio":
            continue
        command = server.get("command")
        declared_args = server.get("args", [])
        declared_cwd = server.get("cwd", ".")
        if not isinstance(command, str) or not isinstance(declared_args, list) or not isinstance(declared_cwd, str):
            continue
        if not all(isinstance(value, str) for value in declared_args):
            continue
        try:
            expected_cwd = (root / declared_cwd).resolve(strict=True)
        except OSError:
            continue
        if expected_cwd != cwd or Path(command).name.lower() != argv_name:
            continue
        if actual_args == declared_args:
            return script
    return None


def _trusted_script_for_process(process: ProcessInfo, tokens: list[str]) -> Path | None:
    if len(tokens) < 2:
        return None
    direct = _trusted_script(tokens[1])
    if direct is not None:
        return direct
    # macOS `ps` does not quote an executable argument containing spaces.
    # Reconstruct only a single, existing absolute script path; arguments would
    # make the candidate fail the regular-file check instead of widening trust.
    parts = process.args.strip().split(None, 1)
    if len(parts) == 2:
        raw_tail = _trusted_script(parts[1])
        if raw_tail is not None:
            return raw_tail
    return _declared_relative_script(process, tokens)


def _modal_wrapper_descriptor(process: ProcessInfo, tokens: list[str]) -> MCPDescriptor | None:
    """Recognize the Modal wrapper only through its installed plugin contract."""
    if len(tokens) != 2 or not all(Path(value).is_absolute() for value in tokens):
        return None
    executable = _lexical_absolute_path(process.executable)
    if executable is None or executable != Path(tokens[0]):
        return None
    root = _approved_plugin_root(process.cwd)
    if root is None:
        return None
    wrapper = root / "scripts" / "start-mcp.sh"
    manifest = root / ".mcp.json"
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
        servers = document.get("mcpServers", {}) if isinstance(document, dict) else {}
        declares_wrapper = any(
            isinstance(server, dict)
            and server.get("type", "stdio") == "stdio"
            and server.get("command") == "./scripts/start-mcp.sh"
            and server.get("args", []) == []
            and server.get("cwd", ".") == "."
            for server in (servers.values() if isinstance(servers, dict) else ())
        )
        contents = wrapper.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    if not declares_wrapper or 'exec "$MODAL_PYTHON" "$MODAL_SCRIPT" "$@"' not in contents:
        return None
    python_match = re.search(r'MODAL_PYTHON="\$\{MODAL_OPS_PYTHON:-\$HOME/([^}]+)\}"', contents)
    script_match = re.search(r'MODAL_SCRIPT="\$\{MODAL_OPS_SCRIPT:-\$HOME/([^}]+)\}"', contents)
    if python_match is None or script_match is None:
        return None
    expected_python = Path.home() / python_match.group(1)
    expected_script = Path.home() / script_match.group(1)
    try:
        actual_python = executable.resolve(strict=True)
        configured_python = expected_python.resolve(strict=True)
        same_distribution = (
            HOMEBREW_PYTHON_EXECUTABLE.fullmatch(str(executable)) is not None
            and "/Cellar/" in str(actual_python)
            and "/Cellar/" in str(configured_python)
            and str(actual_python).split("/Cellar/", 1)[1].split("/Frameworks/", 1)[0]
            == str(configured_python).split("/Cellar/", 1)[1].split("/Frameworks/", 1)[0]
        )
        if actual_python != configured_python and not same_distribution:
            return None
        if Path(tokens[1]).resolve(strict=True) != expected_script.resolve(strict=True):
            return None
    except OSError:
        return None
    return MCPDescriptor("plugin.modal-wrapper", "modal")


def _project_modal_ops_config(process: ProcessInfo) -> tuple[str, list[str]] | None:
    """Read one deliberately-small project-local ``modal-ops`` declaration.

    The launchd job runs under macOS' system Python, which cannot be assumed to
    have ``tomllib``.  Rather than accepting a partial general TOML parser,
    recognize only the exact scalar/array forms this descriptor needs.  Any
    duplicate, malformed, multiline, or non-string declaration fails closed.
    """
    cwd = _lexical_absolute_path(process.cwd)
    if cwd is None:
        return None
    try:
        cwd = cwd.resolve(strict=True)
        if not cwd.is_dir():
            return None
        config = (cwd / ".codex" / "config.toml").resolve(strict=True)
        if not config.is_file() or not _is_under(config, {cwd}):
            return None
        text = config.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None
    if len(text) > 65_536:
        return None

    in_modal_section = False
    section_count = 0
    command: str | None = None
    args: list[str] | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            in_modal_section = line == "[mcp_servers.modal-ops]"
            if in_modal_section:
                section_count += 1
            continue
        if not in_modal_section:
            continue
        match = re.fullmatch(r"(command|args)\s*=\s*(.+)", line)
        if match is None:
            continue
        key, raw_value = match.groups()
        try:
            value = json.loads(raw_value)
        except ValueError:
            return None
        if key == "command":
            if command is not None or not isinstance(value, str):
                return None
            command = value
        else:
            if args is not None or not isinstance(value, list) or not all(
                isinstance(item, str) for item in value
            ):
                return None
            args = value
    if section_count != 1 or command is None or args is None:
        return None
    return command, args


def _project_modal_ops_descriptor(process: ProcessInfo, tokens: list[str]) -> MCPDescriptor | None:
    """Recognize only the configured project-local ``modal-ops`` process."""
    if len(tokens) != 2:
        return None
    configured = _project_modal_ops_config(process)
    if configured is None:
        return None
    command, declared_args = configured
    if len(declared_args) != 1:
        return None
    executable = _lexical_absolute_path(process.executable)
    argv_executable = _lexical_absolute_path(tokens[0])
    argv_script = _lexical_absolute_path(tokens[1])
    configured_executable = _lexical_absolute_path(command)
    configured_script = _lexical_absolute_path(declared_args[0])
    if None in (executable, argv_executable, argv_script, configured_executable, configured_script):
        return None
    if not re.fullmatch(r"python(?:3(?:\.\d+)?)?", configured_executable.name.lower()):
        return None
    cwd = _lexical_absolute_path(process.cwd)
    if cwd is None:
        return None
    # The declaration itself must remain project-owned.  A venv interpreter is
    # normally a symlink to Homebrew's framework executable, so enforce this on
    # the lexical configured paths before resolving symlinks.
    if not _is_under(configured_executable, {cwd}) or not _is_under(configured_script, {cwd}):
        return None
    try:
        cwd = cwd.resolve(strict=True)
        actual_executable = executable.resolve(strict=True)
        actual_argv_executable = argv_executable.resolve(strict=True)
        actual_argv_script = argv_script.resolve(strict=True)
        expected_executable = configured_executable.resolve(strict=True)
        expected_script = configured_script.resolve(strict=True)
    except OSError:
        return None
    if not expected_executable.is_file() or not expected_script.is_file() or not _is_under(expected_script, {cwd}):
        return None
    if (
        actual_executable != expected_executable
        or actual_argv_executable != expected_executable
        or actual_argv_script != expected_script
    ):
        return None
    return MCPDescriptor("project.modal-ops", "modal")


def _context7_wrapper_descriptor(process: ProcessInfo, tokens: list[str]) -> MCPDescriptor | None:
    """Recognize Context7's compat child through its exact installed wrapper."""
    if len(tokens) != 2 or _trusted_launcher(process, tokens, {"node"}) is None:
        return None
    script = _trusted_script_for_process(process, tokens)
    if script is None or script.name != "context7-app-compat-mcp.mjs":
        return None
    root = script.parents[1]
    wrapper = root / "scripts" / "start-context7-mcp.sh"
    try:
        document = json.loads((root / ".mcp.json").read_text(encoding="utf-8"))
        servers = document.get("mcpServers", {}) if isinstance(document, dict) else {}
        declared = any(
            isinstance(server, dict)
            and server.get("type", "stdio") == "stdio"
            and server.get("command") == "./scripts/start-context7-mcp.sh"
            and server.get("args", []) == []
            for server in (servers.values() if isinstance(servers, dict) else ())
        )
        contents = wrapper.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None
    if not declared or 'exec node "$script_dir/context7-app-compat-mcp.mjs"' not in contents:
        return None
    return MCPDescriptor("plugin.context7-wrapper", "context7")


def _mcp_descriptor(process: ProcessInfo) -> MCPDescriptor | None:
    try:
        tokens = shlex.split(process.args)
    except ValueError:
        return None
    lowered_tokens = [token.lower() for token in tokens]
    project_modal_descriptor = _project_modal_ops_descriptor(process, tokens)
    if project_modal_descriptor is not None:
        return project_modal_descriptor
    modal_descriptor = _modal_wrapper_descriptor(process, tokens)
    if modal_descriptor is not None:
        return modal_descriptor
    context7_descriptor = _context7_wrapper_descriptor(process, tokens)
    if context7_descriptor is not None:
        return context7_descriptor
    if _is_shell(process):
        if (
            _trusted_launcher(process, tokens, SHELL_NAMES)
            and len(tokens) == 2
            and Path(tokens[1]).name == "codex-chrome-devtools-mcp-global.sh"
            and _trusted_script(tokens[1]) is not None
        ):
            return MCPDescriptor("shell.chrome-devtools-global", "chrome_devtools")
        return None
    node_repl_executable = _swap_vnode_current_path(process.executable) or process.executable
    if node_repl_executable in ALLOWED_NODE_REPL_PATHS:
        if len(tokens) == 1 and tokens[0] == node_repl_executable:
            return MCPDescriptor("direct.node-repl", "node_repl")
        return None
    swap_computer_use = _swap_vnode_current_path(process.executable)
    computer_use_executable = swap_computer_use or process.executable
    if computer_use_executable in ALLOWED_COMPUTER_USE_PATHS:
        raw_args = process.args.strip()
        if raw_args.startswith(computer_use_executable + " "):
            tail_text = raw_args[len(computer_use_executable):].strip()
            try:
                command_tail = [token.lower() for token in shlex.split(tail_text)]
            except ValueError:
                return None
        elif lowered_tokens and Path(lowered_tokens[0]).name == "skycomputeruseclient":
            if swap_computer_use is not None:
                return None
            command_tail = lowered_tokens[1:]
        else:
            return None
        if command_tail == ["mcp"]:
            return MCPDescriptor("app.computer-use.mcp", "computer_use")
        if command_tail == ["event-stream", "mcp"]:
            return MCPDescriptor("app.computer-use.event-stream", "computer_use")
        return None
    npm_launcher = _trusted_launcher(process, tokens, {"npm", "npx"})
    if npm_launcher:
        package = ""
        if npm_launcher == "npm" and len(lowered_tokens) >= 3 and lowered_tokens[1] in {"exec", "x"}:
            package = lowered_tokens[2]
        elif npm_launcher == "npx" and len(lowered_tokens) >= 2:
            package = lowered_tokens[1]
        if not _exact_package_or_version(package, NPM_MCP_PACKAGES):
            return None
        package_name = next(
            name for name in sorted(NPM_MCP_PACKAGES, key=len, reverse=True)
            if package == name or package.startswith(name + "@")
        )
        family = {
            "chrome-devtools-mcp": "chrome_devtools",
            "@upstash/context7-mcp": "context7",
            "@playwright/mcp": "playwright",
            "@decodo/mcp-server": "decodo",
            "pdfx-cli": "pdfx",
            "shadcn": "shadcn",
            "xcodebuildmcp": "xcodebuild",
            "next-devtools-mcp": "next_devtools",
            "scrapling": "scrapling",
        }.get(package_name, "other_mcp")
        return MCPDescriptor(f"npm.{package_name}", family)
    if _trusted_launcher(process, tokens, {"chrome-devtools-mcp"}):
        if lowered_tokens == ["chrome-devtools-mcp"]:
            return MCPDescriptor("node.chrome-devtools-global", "chrome_devtools")
        return None
    if _trusted_launcher(process, tokens, {"node"}):
        if len(lowered_tokens) < 2:
            return None
        script = lowered_tokens[1]
        trusted_script = _trusted_script_for_process(process, tokens)
        if trusted_script is None:
            return None
        script_name = Path(script).name
        if str(trusted_script).lower().endswith(
            "/library/application support/codex-plusplus/tweaks/user-questions/mcp-server.js"
        ):
            return MCPDescriptor("node.user-questions", "user_questions")
        if script_name in {"server.mjs", "server.bundle.mjs", "server.cjs"}:
            if "/mcp/" in str(trusted_script).lower():
                return MCPDescriptor(f"node.mcp-script.{script_name}", "other_mcp")
            return None
        node_scripts = {
            "iconify-mcp.mjs": "iconify",
            "react-doctor-mcp.mjs": "react_doctor",
            "context7-app-compat-mcp.mjs": "context7",
            "chrome-devtools-mcp": "chrome_devtools",
            "playwright-mcp": "playwright",
            "decodo-mcp": "decodo",
            "next-devtools-mcp": "next_devtools",
            "xcodebuildmcp": "xcodebuild",
            "pdfx": "pdfx",
        }
        if script_name in node_scripts:
            return MCPDescriptor(f"node.{script_name}", node_scripts[script_name])
        if script_name == "mcp-server.js":
            if "/user-questions/" in script or "/tweaks/user-questions/" in script:
                return MCPDescriptor("node.user-questions", "user_questions")
            return None
        if script_name == "shadcn" and len(lowered_tokens) == 3 and lowered_tokens[2] == "mcp":
            return MCPDescriptor("node.shadcn", "shadcn")
        return None
    if _trusted_launcher(process, tokens, {"python", "python3", "python3.11", "python3.12"}):
        if len(lowered_tokens) < 2:
            return None
        trusted_script = _trusted_script_for_process(process, tokens)
        if trusted_script is None:
            return None
        script_name = trusted_script.name.lower()
        if script_name == "modal_ops_mcp.py":
            return MCPDescriptor("python.modal-ops", "modal")
        if script_name == "headroom" and lowered_tokens[2:] == ["mcp", "serve"]:
            return MCPDescriptor("python.headroom", "headroom")
        return None
    if _trusted_launcher(process, tokens, {"uv", "uvx"}):
        payload = lowered_tokens[1:]
        if payload[:1] == ["run"]:
            payload = payload[1:]
        if not payload:
            return None
        if _exact_package_or_version(payload[0], {"context7-mcp"}):
            return MCPDescriptor("uv.context7", "context7")
        if payload == ["scrapling", "mcp"]:
            return MCPDescriptor("uv.scrapling", "scrapling")
        if payload == ["headroom", "mcp", "serve"]:
            return MCPDescriptor("uv.headroom", "headroom")
        return None
    return None


def _is_mcp_root(process: ProcessInfo) -> bool:
    return _mcp_descriptor(process) is not None


def _helper_family(process: ProcessInfo) -> str:
    descriptor = _mcp_descriptor(process)
    return descriptor.family if descriptor else "other_mcp"


def _matcher_drift_summary(process: ProcessInfo) -> str | None:
    """Return a bounded hint only for a plausible, untrusted MCP launcher.

    A generic descendant may mention an MCP source file while compiling or
    running user work.  That remains a blocker, but it is not matcher drift.
    """
    try:
        tokens = shlex.split(process.args)
    except ValueError:
        return None
    if not tokens:
        return None
    launcher = Path(tokens[0]).name.lower()
    if launcher not in {
        "node", "node_repl", "npm", "npx", "python", "python3", "python3.11",
        "python3.12", "uv", "uvx", "skycomputeruseclient", "chrome-devtools-mcp",
    }:
        return None
    lower = process.args.lower()
    if not any(signature in lower for signature in MCP_SIGNATURES):
        return None
    executable = Path(process.executable).name or "unknown"
    return f"{executable}:{_command_shape(process.executable, process.args)}"


def _is_soft_blocker_process(process: ProcessInfo) -> bool:
    """Classify a blocker as soft using the kernel executable, never argv[0].

    Soft means: a node/node_repl executable, or a node/npm/npx/python launcher
    whose arguments mention "mcp" (the unrecognized-MCP drift case).  Matcher
    drift is still emitted for these; softness only changes how the lifecycle
    weighs the blocker.  Everything else (shells, builds, python without mcp)
    remains a hard blocker.
    """
    basename = Path(process.executable).name.lower()
    if basename in SOFT_BLOCKER_BASENAMES:
        return True
    if basename in SOFT_BLOCKER_LAUNCHER_BASENAMES or SOFT_BLOCKER_LAUNCHER_PATTERN.fullmatch(basename):
        return "mcp" in process.args.lower()
    return False


def _soft_blocker_key(blocker: Blocker) -> str | None:
    """Baseline key: kernel (pid, birth) identity, or None when unprovable."""
    if blocker.identity is None:
        return None
    return f"{blocker.identity.pid}|{blocker.identity.birth}"


def soft_blocker_baselines(tree: TreeClassification) -> dict[str, float]:
    """Current-cycle CPU baselines for every identity-proven soft blocker."""
    baselines: dict[str, float] = {}
    for blocker in tree.blockers:
        if not blocker.soft:
            continue
        key = _soft_blocker_key(blocker)
        if key is not None:
            baselines[key] = float(blocker.cpu_seconds)
    return baselines


def active_blockers(
    tree: TreeClassification, prior_tree_state: dict[str, Any] | None
) -> tuple[Blocker, ...]:
    """Return the blockers that must keep a detached tree blocked.

    Hard blockers always count.  A soft blocker counts only when its CPU time
    moved at least ``SOFT_BLOCKER_CPU_DELTA`` seconds since the prior cycle's
    baseline for the same kernel (pid, birth) identity -- or when no baseline
    exists yet, which fails closed for one cycle.  ``prior_tree_state`` is the
    per-tree entry from codex-mcp-lifecycle-state.json; old state files without
    baselines are tolerated (every soft blocker fails closed once).
    """
    baselines: dict[str, Any] = {}
    if isinstance(prior_tree_state, dict):
        raw = prior_tree_state.get("soft_blocker_baselines")
        if isinstance(raw, dict):
            baselines = raw
    active: list[Blocker] = []
    for blocker in tree.blockers:
        if not blocker.soft:
            active.append(blocker)
            continue
        key = _soft_blocker_key(blocker)
        prior_cpu = baselines.get(key) if key is not None else None
        if (
            not isinstance(prior_cpu, (int, float))
            or isinstance(prior_cpu, bool)
            or not math.isfinite(float(prior_cpu))
        ):
            active.append(blocker)  # fail closed: no proven baseline yet
        elif float(blocker.cpu_seconds) - float(prior_cpu) >= SOFT_BLOCKER_CPU_DELTA:
            active.append(blocker)
    return tuple(active)


def _tree_key(root: ProcessIdentity | None, app: ProcessIdentity | None, fallback_pid: int) -> str:
    if root and app:
        raw = f"{root.pid}|{root.birth}|{root.command_shape}|{app.pid}|{app.birth}|{app.command_shape}"
        return "codex:" + hashlib.sha256(raw.encode()).hexdigest()[:24]
    return f"ambiguous:{fallback_pid}"


def _classify_exact_tree(
    root: ProcessInfo,
    app_server: ProcessInfo,
    ids: tuple[int, ...],
    ownership: str,
    owned: dict[int, ProcessInfo],
    children: dict[int, list[int]],
) -> TreeClassification:
    """Classify one already-proven wrapper or standalone app-server tree."""
    root_identity = root.identity
    app_identity = app_server.identity
    mcp_roots = {pid for pid in ids if pid in owned and _is_mcp_root(owned[pid])}
    mcp_descendant_ids: set[int] = set()
    for mcp_root in mcp_roots:
        mcp_descendant_ids.update(subtree_ids(mcp_root, children))

    blockers: list[Blocker] = []
    matcher_drift: list[str] = []
    helper_counts: Counter[str] = Counter()
    identity_missing = root_identity is None or app_identity is None
    for pid in ids:
        process = owned.get(pid)
        if process is None or pid in {root.pid, app_server.pid}:
            continue
        if pid in mcp_descendant_ids:
            if pid in mcp_roots:
                helper_counts[_helper_family(process)] += 1
            if process.identity is None:
                identity_missing = True
            continue
        if _is_runtime(process):
            if process.identity is None:
                identity_missing = True
            continue
        blockers.append(Blocker(
            identity=process.identity,
            name=Path(process.executable).name or process.executable,
            command_summary=_command_summary(process),
            executable=process.executable,
            cpu_seconds=process.cpu_seconds,
            soft=_is_soft_blocker_process(process),
        ))
        drift = _matcher_drift_summary(process)
        if drift:
            matcher_drift.append(drift)

    error = None
    if identity_missing:
        error = "one or more tree processes lack stable birth identity"
        ownership = "ambiguous"
    # The generation keys on the tree's stable identity (wrapper/app-server)
    # only.  Including transient helper pids let MCP-descendant and soft-blocker
    # churn reset idle_since every cycle, so the 600s countdown never completed
    # on a busy detached tree.  Descendant changes are still caught at signal
    # time by per-pid identity revalidation and the new-descendant probe.
    generation_raw = "|".join(
        f"{identity.pid}:{identity.birth}:{identity.command_shape}"
        if identity is not None else "missing"
        for identity in (root_identity, app_identity)
    )
    return TreeClassification(
        tree_key=_tree_key(root_identity, app_identity, root.pid),
        root_identity=root_identity,
        app_server_identity=app_identity,
        ownership=ownership,
        process_ids=ids,
        generation=hashlib.sha256(generation_raw.encode()).hexdigest()[:24],
        blockers=tuple(blockers),
        helper_family_counts=dict(helper_counts),
        rss_kib=sum(owned[pid].rss_kib for pid in ids if pid in owned),
        state="observed" if ownership == "ui_owned" else "detached_candidate",
        matcher_drift=tuple(sorted(set(matcher_drift))),
        error=error,
    )


def classify_codex_trees(
    snapshot: dict[int, ProcessInfo],
    uid: int | None = None,
    orphan_min_age: int = 120,
) -> list[TreeClassification]:
    uid = os.getuid() if uid is None else uid
    owned = {pid: proc for pid, proc in snapshot.items() if proc.uid == uid}
    children = children_index(owned)
    classifications: list[TreeClassification] = []

    for wrapper in sorted(owned.values(), key=lambda item: item.pid):
        if not looks_like_codex_wrapper(wrapper):
            continue
        expected_child = _expected_wrapper_child(wrapper)
        all_app_children = [
            owned[pid] for pid in children.get(wrapper.pid, ())
            if pid in owned and is_codex_app_server(owned[pid])
        ]
        app_children = []
        if expected_child is not None:
            child_executable, child_command = expected_child
            app_children = [
                child for child in all_app_children
                if (_swap_vnode_current_path(child.executable) or child.executable) == child_executable
                and _normalized(child.args) == child_command
            ]
        root_identity = wrapper.identity
        if len(all_app_children) != 1 or len(app_children) != 1:
            classifications.append(TreeClassification(
                tree_key=_tree_key(root_identity, None, wrapper.pid),
                root_identity=root_identity,
                app_server_identity=None,
                ownership="ambiguous",
                process_ids=(wrapper.pid,),
                rss_kib=wrapper.rss_kib,
                state="detached_candidate",
                error="wrapper does not have exactly one direct Codex app-server child",
            ))
            continue

        app_server = app_children[0]
        ids = tuple(subtree_ids(wrapper.pid, children))
        if wrapper.ppid == 1 and wrapper.age_seconds >= orphan_min_age:
            ownership = "detached"
        elif _has_ui_owner(wrapper, owned):
            ownership = "ui_owned"
        else:
            ownership = "ambiguous"
        classifications.append(_classify_exact_tree(
            wrapper, app_server, ids, ownership, owned, children,
        ))
    for app_server in sorted(owned.values(), key=lambda item: item.pid):
        if not is_exact_standalone_app_server(app_server):
            continue
        ownership = "detached" if app_server.age_seconds >= orphan_min_age else "ambiguous"
        classifications.append(_classify_exact_tree(
            app_server,
            app_server,
            tuple(subtree_ids(app_server.pid, children)),
            ownership,
            owned,
            children,
        ))
    return classifications


def advance_lifecycle_state(
    classifications: Iterable[TreeClassification],
    prior_state: dict[str, Any] | None,
    now: float,
    idle_seconds: int = 600,
    state_valid: bool = True,
) -> tuple[list[TreeClassification], dict[str, Any]]:
    prior = prior_state if isinstance(prior_state, dict) else {}
    now_valid = isinstance(now, (int, float)) and math.isfinite(float(now)) and float(now) >= 0
    last_now = prior.get("last_now")
    valid = (
        state_valid
        and now_valid
        and prior.get("schema_version") == STATE_SCHEMA_VERSION
        and isinstance(prior.get("trees", {}), dict)
        and isinstance(last_now, (int, float))
        and math.isfinite(float(last_now))
        and 0 <= float(last_now) <= float(now)
    )
    prior_trees = prior.get("trees", {}) if valid else {}
    next_trees: dict[str, Any] = {}
    updated: list[TreeClassification] = []

    for tree in classifications:
        old = prior_trees.get(tree.tree_key, {}) if isinstance(prior_trees, dict) else {}
        idle_since: float | None = None
        eligible_at: float | None = None
        remaining: int | None = None
        actionable = False
        state = tree.state
        error = tree.error

        if tree.ownership == "ui_owned":
            # Live trees stay observation-only and never reach the blocker
            # branch; the soft-blocker lane below applies to detached trees only.
            state = "observed"
        elif tree.ownership != "detached" or tree.error:
            state = "detached_candidate"
        elif active_blockers(tree, old if isinstance(old, dict) else None):
            state = "blocked_active_work"
        elif not now_valid:
            state = "detached_candidate"
            error = "invalid lifecycle clock"
        else:
            old_idle = old.get("idle_since") if isinstance(old, dict) else None
            if (
                isinstance(old_idle, (int, float))
                and math.isfinite(float(old_idle))
                and isinstance(last_now, (int, float))
                and 0 <= float(old_idle) <= float(last_now) <= float(now)
                and old.get("generation") == tree.generation
            ):
                idle_since = float(old_idle)
            else:
                idle_since = float(now)
            eligible_at = idle_since + idle_seconds
            remaining = max(0, int(round(eligible_at - now)))
            if now >= eligible_at:
                state = "eligible"
                actionable = True
                remaining = 0
            else:
                state = "idle_pending"

        current = replace(
            tree,
            state=state,
            actionable=actionable,
            idle_since=idle_since,
            eligible_at=eligible_at,
            remaining_seconds=remaining,
            error=error,
        )
        updated.append(current)
        next_trees[tree.tree_key] = {
            "root_identity": tree.root_identity.to_json() if tree.root_identity else None,
            "app_server_identity": tree.app_server_identity.to_json() if tree.app_server_identity else None,
            "state": state,
            "generation": tree.generation,
            "idle_since": idle_since,
            "eligible_at": eligible_at,
            # Compatible schema extension: absent in old state files, in which
            # case every soft blocker fails closed for one cycle.
            "soft_blocker_baselines": soft_blocker_baselines(tree),
        }

    return updated, {
        "schema_version": STATE_SCHEMA_VERSION,
        "last_now": float(now) if now_valid else None,
        "trees": next_trees,
    }


def build_status(
    classifications: Iterable[TreeClassification],
    counts: dict[str, Any] | None = None,
    generated_at: float | None = None,
    job: dict[str, Any] | None = None,
    helper_family_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    trees = list(classifications)
    aggregate: Counter[str] = Counter(helper_family_counts or {})
    if not helper_family_counts:
        for tree in trees:
            aggregate.update(tree.helper_family_counts)
    base_counts = {
        "codex_app_servers": sum(1 for tree in trees if tree.app_server_identity),
        "ui_owned_trees": sum(tree.ownership == "ui_owned" for tree in trees),
        "detached_trees": sum(tree.ownership == "detached" for tree in trees),
        "ambiguous_trees": sum(tree.ownership == "ambiguous" for tree in trees),
        "blocked_trees": sum(tree.state == "blocked_active_work" for tree in trees),
        "idle_pending_trees": sum(tree.state == "idle_pending" for tree in trees),
        "eligible_trees": sum(tree.state == "eligible" for tree in trees),
        "actionable_orphans": sum(tree.actionable for tree in trees),
        "claude_sessions": 0,
        "node_repls": aggregate.get("node_repl", 0),
        "mcp_rss_mib": sum(tree.rss_kib for tree in trees) // 1024,
        "would_kill": 0,
    }
    base_counts.update(counts or {})
    matcher_drift = sorted({
        drift
        for tree in trees
        for drift in tree.matcher_drift
    })
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "producer_version": PRODUCER_VERSION,
        "cleanup_policy_version": CLEANUP_POLICY_VERSION,
        "matcher_registry_version": MATCHER_REGISTRY_VERSION,
        "lane_modes": dict(LANE_MODES),
        "pressure_signals": [],
        "matcher_drift": matcher_drift,
        "watcher_health_refs": [
            "mcp-lifecycle-reaper",
            "mcp-pressure-guard",
        ],
        "attribution_conflicts": [],
        "job": job or {"ok": True, "mode": "status", "error": None},
        "counts": base_counts,
        "helper_family_counts": dict(aggregate),
        "trees": [tree.to_status() for tree in trees],
    }


def atomic_read_json(path: Path | str) -> tuple[dict[str, Any], bool]:
    target = Path(path)
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        return (payload if isinstance(payload, dict) else {}), isinstance(payload, dict)
    except (OSError, json.JSONDecodeError, TypeError):
        return {}, False


def atomic_write_json(path: Path | str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=str(target.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def append_jsonl(path: Path | str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(target, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(target, 0o600)
