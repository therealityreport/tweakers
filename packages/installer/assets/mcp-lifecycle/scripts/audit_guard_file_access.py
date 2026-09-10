#!/usr/bin/env python3
"""Fail-closed runtime audit for an installed process-only Guard candidate.

The helper runs the supplied candidate with deterministic process and lifecycle
fixtures.  It records candidate file access and rejects task-store access,
out-of-contract writes, SQLite imports, signals, and subprocess boundaries.
It is intentionally an isolated-test helper, not a lifecycle or activation
command.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


OWNED_FILENAMES = {
    "codex-mcp-guard-status.json",
    "codex-mcp-guard-window.json",
    "codex-mcp-guard-notify.json",
    "codex-mcp-guard.log",
}
FORBIDDEN_STORE_PATH_PARTS = {
    "state_5.sqlite",
    "state_5.sqlite-wal",
    "state_5.sqlite-shm",
    "history.jsonl",
    "session_index.jsonl",
    "thread_spawn_edges",
    "archived_sessions",
    "rollout_summaries",
    "threads",
    "sessions",
    "chats",
    "archives",
    "rollouts",
}
_STATIC_STORE_PATTERNS = tuple(
    rf"(?<![\w.-]){re.escape(part)}(?![\w.-])"
    for part in sorted(FORBIDDEN_STORE_PATH_PARTS)
)
STATIC_FORBIDDEN = (
    r"\bimport\s+sqlite3\b",
    r"\bsqlite3\.",
    r"\bSTATE_DB\b",
    r"archive_stale_threads",
    r"\b(?:PROJECT_THREAD_RETAIN|THREAD_RETAIN)[A-Z_]*\b",
    r"\b(?:SELECT|UPDATE|INSERT|DELETE)\b[\s\S]{0,240}\b(?:threads|thread_spawn_edges|sessions)\b",
    r"\bos\.kill\s*\(",
    r"\b(?:SIGTERM|SIGKILL|SIGINT)\b",
    r"\blaunchctl\b",
    *_STATIC_STORE_PATTERNS,
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Audit an installed Guard candidate using deterministic process and lifecycle fixtures."
    )
    parser.add_argument("--candidate", type=Path, required=True, help="Installed codex-mcp-guard.py path.")
    parser.add_argument("--state-dir", type=Path, required=True, help="Temporary Guard lifecycle state directory.")
    parser.add_argument(
        "--process-fixture",
        type=Path,
        required=True,
        help="JSON fixture with a processes array and optional system_memory object.",
    )
    parser.add_argument(
        "--lifecycle-fixture",
        type=Path,
        required=True,
        help="JSON lifecycle-status fixture copied into the temporary state directory before tracing.",
    )
    parser.add_argument("--now", type=float, default=1_000.0, help="Deterministic observation timestamp.")
    return parser.parse_args(argv)


def read_json_object(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON fixture: {path.name}: {type(exc).__name__}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"fixture root must be an object: {path.name}")
    return value


def static_violations(candidate: Path) -> list[str]:
    try:
        source = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return [f"candidate_unreadable:{type(exc).__name__}"]
    return [f"static_forbidden:{pattern}" for pattern in STATIC_FORBIDDEN if re.search(pattern, source)]


def _runner_source() -> str:
    """Return a self-contained child runner so tracing cannot touch the candidate API."""
    return r'''
import builtins
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
from pathlib import Path

candidate = Path(os.environ["MCP_GUARD_AUDIT_CANDIDATE"]).resolve()
state_dir = Path(os.environ["MCP_GUARD_AUDIT_STATE_DIR"]).resolve()
fixture = json.loads(Path(os.environ["MCP_GUARD_AUDIT_PROCESS_FIXTURE"]).read_text(encoding="utf-8"))
now = float(os.environ["MCP_GUARD_AUDIT_NOW"])
owned = {
    "codex-mcp-guard-status.json",
    "codex-mcp-guard-window.json",
    "codex-mcp-guard-notify.json",
    "codex-mcp-guard.log",
}
forbidden_parts = set(json.loads(os.environ["MCP_GUARD_AUDIT_FORBIDDEN_PATH_PARTS"]))
reads, writes, violations, signals, subprocesses = [], [], [], [], []

def normalized_path(value):
    try:
        return Path(value).expanduser().resolve(strict=False)
    except (TypeError, ValueError, OSError):
        return None

def has_forbidden_part(path):
    return any(part.lower() in forbidden_parts for part in path.parts)

def allowed_guard_write(path):
    try:
        relative = path.relative_to(state_dir)
    except ValueError:
        return False
    if len(relative.parts) != 1:
        return False
    name = relative.name
    return name in owned or any(name.startswith("." + item + ".") for item in owned)

def record_path(value, mode):
    # os.fdopen receives a descriptor already recorded by audited_os_open.
    if isinstance(value, int):
        return
    path = normalized_path(value)
    if path is None:
        violations.append("unresolvable_open_path")
        return
    writing = any(flag in mode for flag in ("w", "a", "x", "+"))
    if has_forbidden_part(path):
        violations.append("forbidden_store_open:" + path.name)
    if writing:
        writes.append(str(path))
        if not allowed_guard_write(path):
            violations.append("out_of_contract_write:" + path.name)
    else:
        reads.append(str(path))

original_open = builtins.open
original_io_open = io.open
original_os_open = os.open
original_import = builtins.__import__

def audited_open(file, mode="r", *args, **kwargs):
    record_path(file, str(mode))
    return original_open(file, mode, *args, **kwargs)

def audited_io_open(file, mode="r", *args, **kwargs):
    record_path(file, str(mode))
    return original_io_open(file, mode, *args, **kwargs)

def audited_os_open(file, flags, *args, **kwargs):
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC | os.O_EXCL
    record_path(file, "w" if flags & write_flags else "r")
    return original_os_open(file, flags, *args, **kwargs)

def audited_import(name, globals=None, locals=None, fromlist=(), level=0):
    if name == "sqlite3" or name.startswith("sqlite3."):
        violations.append("sqlite_import")
        raise ImportError("SQLite is forbidden in a process-only Guard candidate")
    return original_import(name, globals, locals, fromlist, level)

def blocked_kill(*args, **kwargs):
    signals.append("os.kill")
    violations.append("signal_attempt")
    raise RuntimeError("signal attempt blocked by Guard audit")

def blocked_subprocess(*args, **kwargs):
    subprocesses.append("subprocess")
    violations.append("subprocess_boundary")
    raise RuntimeError("subprocess boundary blocked by Guard audit")

builtins.open = audited_open
io.open = audited_io_open
os.open = audited_os_open
builtins.__import__ = audited_import
os.kill = blocked_kill
subprocess.run = blocked_subprocess
subprocess.Popen = blocked_subprocess
subprocess.call = blocked_subprocess
subprocess.check_call = blocked_subprocess
subprocess.check_output = blocked_subprocess

try:
    spec = importlib.util.spec_from_file_location("installed_guard_under_audit", candidate)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    process_records = fixture.get("processes")
    if not isinstance(process_records, list):
        raise ValueError("process fixture must contain a processes array")
    snapshot = {}
    for record in process_records:
        if not isinstance(record, dict):
            raise ValueError("each process fixture record must be an object")
        snapshot[record["pid"]] = module.lifecycle.ProcessInfo(**record)
    memory = fixture.get("system_memory")
    if not isinstance(memory, dict):
        memory = {"available": False, "swap": {"available": False}}
    document = module.observe_once(
        state_dir,
        now=now,
        process_loader=lambda: snapshot,
        sleeper=lambda _seconds: None,
        system_memory_loader=lambda: memory,
    )
    module.write_guard_status(document, state_dir)
    matcher = document.get("matcher")
    if not isinstance(matcher, dict):
        matcher = {}
    candidate_report = {
        "schemaVersion": document.get("schema_version"),
        "taskDataAccess": document.get("taskDataAccess"),
        "mutationCapabilities": document.get("mutationCapabilities"),
        "matcher": {
            "expected": matcher.get("expected"),
            "observed": matcher.get("observed"),
            "freshness": matcher.get("freshness"),
        },
        "producerVersion": document.get("producer_version"),
        "state": document.get("state"),
    }
    if document.get("taskDataAccess") != "none":
        violations.append("task_data_access_not_none")
    if document.get("mutationCapabilities") != []:
        violations.append("mutation_capabilities_not_empty")
except BaseException as exc:
    violations.append("candidate_runtime_error:" + type(exc).__name__)
finally:
    builtins.open = original_open
    io.open = original_io_open
    os.open = original_os_open
    builtins.__import__ = original_import

print(json.dumps({
    "candidate": candidate_report if "candidate_report" in globals() else None,
    "reads": sorted(set(reads)),
    "writes": sorted(set(writes)),
    "signals": signals,
    "subprocesses": subprocesses,
    "violations": sorted(set(violations)),
}, sort_keys=True))
sys.exit(1 if violations else 0)
'''


def run_runtime_audit(args: argparse.Namespace) -> tuple[int, dict[str, Any]]:
    candidate = args.candidate.expanduser().resolve(strict=False)
    state_dir = args.state_dir.expanduser().resolve(strict=False)
    fixture = args.process_fixture.expanduser().resolve(strict=False)
    lifecycle_fixture = args.lifecycle_fixture.expanduser().resolve(strict=False)
    if not candidate.is_file():
        return 1, {"violations": ["candidate_missing"]}
    try:
        process_document = read_json_object(fixture)
        lifecycle_document = read_json_object(lifecycle_fixture)
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        (state_dir / "codex-mcp-lifecycle-status.json").write_text(
            json.dumps(lifecycle_document, sort_keys=True), encoding="utf-8"
        )
    except (OSError, ValueError) as exc:
        return 1, {"violations": [f"fixture_setup_failed:{type(exc).__name__}"]}

    static = static_violations(candidate)
    if static:
        return 1, {"violations": static, "reads": [], "writes": [], "signals": [], "subprocesses": []}

    with tempfile.TemporaryDirectory(prefix="mcp-guard-audit-") as temporary:
        runner = Path(temporary) / "run-audit.py"
        runner.write_text(_runner_source(), encoding="utf-8")
        environment = {
            **os.environ,
            "MCP_GUARD_AUDIT_CANDIDATE": str(candidate),
            "MCP_GUARD_AUDIT_STATE_DIR": str(state_dir),
            "MCP_GUARD_AUDIT_PROCESS_FIXTURE": str(fixture),
            "MCP_GUARD_AUDIT_NOW": str(args.now),
            "MCP_GUARD_AUDIT_FORBIDDEN_PATH_PARTS": json.dumps(sorted(FORBIDDEN_STORE_PATH_PARTS)),
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        # Keep candidate evaluation independent of a caller's notification setup.
        environment.pop("CODEX_MCP_GUARD_NOTIFY_HELPER", None)
        completed = subprocess.run(
            [sys.executable, "-B", str(runner)],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
    try:
        report = json.loads(completed.stdout)
    except json.JSONDecodeError:
        report = {"violations": ["audit_runner_invalid_output"]}
    if not isinstance(report, dict):
        report = {"violations": ["audit_runner_invalid_report"]}
    return completed.returncode, report


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    code, report = run_runtime_audit(args)
    print(json.dumps(report, sort_keys=True))
    return 0 if code == 0 and not report.get("violations") else 1


if __name__ == "__main__":
    raise SystemExit(main())
