#!/usr/bin/env python3
"""Non-mutating MCP process-health observer.

The Guard is intentionally unable to inspect Codex task data or control a
process. It reads a process snapshot and the reaper's lifecycle status, then
publishes one bounded v3 status document below the lifecycle directory passed
by its launchd definition.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterable


PACKAGE_LIB = Path(__file__).resolve().parents[1] / "lib"
if str(PACKAGE_LIB) not in sys.path:
    sys.path.insert(0, str(PACKAGE_LIB))

try:
    import codex_mcp_lifecycle as lifecycle
except ImportError as exc:  # The v3 document reports this as unavailable.
    lifecycle = None  # type: ignore[assignment]
    LIFECYCLE_IMPORT_ERROR: str | None = str(exc)
else:
    LIFECYCLE_IMPORT_ERROR = None


STATUS_SCHEMA = "mcp-guard-status.v3"
STATUS_SCHEMA_VERSION = 3
# The Guard document is emitted by the current lifecycle package generation.
# Keep this explicit rather than inheriting the reaper's producer identity: the
# installed-candidate audit binds this observer to the shipped 0.6.0 package.
PRODUCER_VERSION = "0.6.0"
AUTHORITY = "observation-and-notification-only"
STATE_DIRECTORY_ENV = "CODEX_MCP_LIFECYCLE_STATE_DIR"
LIFECYCLE_STATUS_FILE = "codex-mcp-lifecycle-status.json"
GUARD_STATUS_FILE = "codex-mcp-guard-status.json"
WINDOW_FILE = "codex-mcp-guard-window.json"
NOTIFY_FILE = "codex-mcp-guard-notify.json"
LOG_FILE = "codex-mcp-guard.log"
OWNED_FILENAMES = frozenset({GUARD_STATUS_FILE, WINDOW_FILE, NOTIFY_FILE, LOG_FILE})
LIFECYCLE_STATUS_MAX_AGE_SECONDS = 180
PRESSURE_WINDOW_SCHEMA_VERSION = 1
PRESSURE_WINDOW_SIZE = 5
PRESSURE_WINDOW_MAX_GAP_SECONDS = 150
CPU_CORE_FRACTION_FLOOR = 0.5
RSS_GROWTH_MIB = 256
MEMORY_AVAILABLE_PERCENT_CEILING = 15.0
MEMORY_LOW_SAMPLE_COUNT = 3
MEMORY_RSS_RAM_FRACTION = 0.25
NOTIFICATION_COOLDOWN_SECONDS = 3600


def configured_state_directory(value: str | None = None) -> Path:
    """Return the explicit Guard-owned lifecycle directory, fail closed otherwise."""
    raw = value if value is not None else os.environ.get(STATE_DIRECTORY_ENV)
    if not raw:
        raise ValueError(f"{STATE_DIRECTORY_ENV} must be set by the Guard plist")
    directory = Path(raw).expanduser()
    if not directory.is_absolute():
        raise ValueError(f"{STATE_DIRECTORY_ENV} must be an absolute directory")
    return directory.resolve(strict=False)


def guard_owned_path(state_directory: Path, filename: str) -> Path:
    """Keep every Guard write inside the supplied state directory."""
    if filename not in OWNED_FILENAMES:
        raise ValueError(f"unsupported Guard state file: {filename}")
    root = state_directory.resolve(strict=False)
    target = (root / filename).resolve(strict=False)
    if target.parent != root:
        raise ValueError("Guard state path escapes the supplied lifecycle directory")
    return target


def _numeric(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _reason(code: str, detail: str) -> dict[str, str]:
    return {"code": code, "detail": detail[:240]}


def _read_json_object(path: Path) -> dict[str, object] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def read_lifecycle_status(
    state_directory: Path,
    *,
    now: float | None = None,
    read_json: Callable[[Path], dict[str, object] | None] = _read_json_object,
) -> tuple[dict[str, object] | None, list[dict[str, str]]]:
    """Read the reaper document and validate the shared schema/matcher proof."""
    if lifecycle is None:
        return None, [_reason("shared_classifier_unavailable", LIFECYCLE_IMPORT_ERROR or "import failed")]
    document = read_json(state_directory / LIFECYCLE_STATUS_FILE)
    if document is None:
        return None, [_reason("lifecycle_status_missing", "required lifecycle status is missing or invalid")]

    reasons: list[dict[str, str]] = []
    if document.get("schema_version") != lifecycle.SCHEMA_VERSION:
        reasons.append(_reason("lifecycle_schema_mismatch", "lifecycle schema version does not match"))
    if document.get("matcher_registry_version") != lifecycle.MATCHER_REGISTRY_VERSION:
        reasons.append(_reason("matcher_version_mismatch", "matcher registry version does not match"))
    generated_at = _numeric(document.get("generated_at"))
    current_time = time.time() if now is None else now
    if generated_at is None:
        reasons.append(_reason("lifecycle_timestamp_invalid", "lifecycle generated_at is invalid"))
    elif generated_at > current_time + 5:
        reasons.append(_reason("lifecycle_timestamp_future", "lifecycle generated_at is in the future"))
    elif current_time - generated_at > LIFECYCLE_STATUS_MAX_AGE_SECONDS:
        reasons.append(_reason("lifecycle_status_stale", "lifecycle status is stale"))
    job = document.get("job")
    if not isinstance(job, dict) or job.get("ok") is not True:
        reasons.append(_reason("lifecycle_status_invalid", "lifecycle job is not healthy"))
    if not isinstance(document.get("counts"), dict) or not isinstance(document.get("trees"), list):
        reasons.append(_reason("lifecycle_status_invalid", "lifecycle counts or trees are invalid"))
    return document, reasons


def collect_process_observation(snapshot: dict[int, Any]) -> dict[str, object]:
    """Project shared classifier output without maintaining Guard matchers."""
    if lifecycle is None:
        raise RuntimeError(LIFECYCLE_IMPORT_ERROR or "shared classifier unavailable")
    topology = lifecycle.classify_mcp_topology(snapshot)
    owner = topology.owner_identity
    return {
        "loaded_task_stacks": topology.loaded_task_stacks,
        "logical_instances": topology.logical_family_counts,
        "raw_processes": len(topology.raw_process_ids),
        "rss_mib": topology.raw_rss_kib // 1024,
        "raw_cpu_seconds": topology.raw_cpu_seconds,
        "ownership": topology.ownership_counts,
        "ui_owned_logical_helpers": topology.ui_owned_logical_helpers,
        "app_servers": topology.app_server_count,
        "owner": (
            {
                "pid": owner.pid,
                "birth": owner.birth,
                "executable": owner.executable,
            }
            if owner is not None else None
        ),
        "zombie_under_mcp_root": topology.zombie_under_mcp_root,
        "ambiguous_ownership": topology.ambiguous_ownership,
    }


def _snapshot_exception_types() -> tuple[type[BaseException], ...]:
    import subprocess
    return (OSError, RuntimeError, ValueError, subprocess.SubprocessError)


def load_observation_with_retry(
    process_loader: Callable[[], dict[int, Any]] | None = None,
    *,
    sleeper: Callable[[float], None] = time.sleep,
) -> tuple[dict[str, object] | None, list[dict[str, str]]]:
    """Retry one failed process snapshot exactly once before declaring unavailable."""
    if lifecycle is None:
        return None, [_reason("shared_classifier_unavailable", LIFECYCLE_IMPORT_ERROR or "import failed")]
    loader = process_loader or lifecycle.load_process_snapshot
    failures: list[str] = []
    for attempt in range(2):
        try:
            return collect_process_observation(loader()), []
        except _snapshot_exception_types() as exc:
            failures.append(str(exc) or exc.__class__.__name__)
            if attempt == 0:
                sleeper(0.25)
    return None, [_reason("process_snapshot_unavailable", failures[-1] if failures else "snapshot unavailable")]


def select_v3_state(
    *,
    unavailable_reasons: Iterable[dict[str, str]],
    alerts: Iterable[dict[str, object]],
    loaded_task_stacks: int,
    ui_owned_logical_helpers: int,
) -> tuple[str, str]:
    """Pure ordered selector: unavailable > warning > fan-out > healthy."""
    if tuple(unavailable_reasons):
        return "unavailable", "unavailable"
    if tuple(alerts):
        return "warning", "warning"
    if loaded_task_stacks > 0 and ui_owned_logical_helpers > 0:
        return "expected_fanout", "expected_fanout"
    return "healthy", "healthy"


def _nonnegative_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return value


def _logical_helper_total(value: object) -> int:
    if not isinstance(value, dict):
        return 0
    return sum(_nonnegative_int(count) for count in value.values())


def _window_owner(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    pid = value.get("pid")
    birth = value.get("birth")
    executable = value.get("executable")
    if (
        isinstance(pid, bool)
        or not isinstance(pid, int)
        or pid <= 1
        or not isinstance(birth, str)
        or not birth
        or not isinstance(executable, str)
        or not executable.startswith("/")
    ):
        return None
    return {"pid": pid, "birth": birth[:256], "executable": executable[:4096]}


def _exact_window_owner(value: object) -> dict[str, object] | None:
    """Return one persistable app-server identity, never a partial equivalent."""
    owner = _window_owner(value)
    return owner if owner is not None and value == owner else None


def _lifecycle_integrity_evidence(lifecycle_status: dict[str, object] | None) -> dict[str, bool]:
    """Extract only reaper status facts; never infer reaper authority."""
    trees = lifecycle_status.get("trees") if isinstance(lifecycle_status, dict) else None
    partial_reaper_failure = False
    if isinstance(trees, list):
        for tree in trees:
            if not isinstance(tree, dict):
                continue
            state = tree.get("state")
            last_action = tree.get("last_action")
            if state == "partial_failure" or (
                isinstance(last_action, str) and last_action.startswith("partial_failure")
            ):
                partial_reaper_failure = True
                break
    return {"partial_reaper_failure": partial_reaper_failure}


def _parse_vm_stat_available_bytes(value: str) -> int | None:
    page_match = re.search(r"page size of (\d+) bytes", value, flags=re.IGNORECASE)
    if page_match is None:
        return None
    try:
        page_size = int(page_match.group(1))
    except ValueError:
        return None
    pages: dict[str, int] = {}
    for name in ("free", "inactive", "speculative"):
        match = re.search(rf"Pages {name}:\s*(\d+)\.", value, flags=re.IGNORECASE)
        if match is None:
            continue
        try:
            pages[name] = int(match.group(1))
        except ValueError:
            return None
    if "free" not in pages:
        return None
    available_pages = sum(pages.values())
    return available_pages * page_size if available_pages >= 0 else None


def _parse_swap_context(value: str) -> dict[str, int] | None:
    units = {"m": 1.0, "g": 1024.0, "t": 1024.0 * 1024.0}
    parsed: dict[str, int] = {}
    for name in ("total", "used"):
        match = re.search(rf"\b{name}\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*([MGT])", value, flags=re.IGNORECASE)
        if match is None:
            continue
        try:
            parsed[f"{name}_mib"] = int(round(float(match.group(1)) * units[match.group(2).lower()]))
        except ValueError:
            return None
    return parsed if parsed else None


def load_system_memory_context(
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, object]:
    """Read bounded macOS memory context; absent telemetry never warns alone."""
    context: dict[str, object] = {"available": False, "swap": {"available": False}}
    try:
        physical = runner(["sysctl", "-n", "hw.memsize"], check=True, capture_output=True, text=True)
        vm_stat = runner(["vm_stat"], check=True, capture_output=True, text=True)
        physical_bytes = int(physical.stdout.strip())
        available_bytes = _parse_vm_stat_available_bytes(vm_stat.stdout)
        if physical_bytes > 0 and available_bytes is not None:
            context.update({
                "available": True,
                "physical_ram_mib": physical_bytes // (1024 * 1024),
                "available_mib": available_bytes // (1024 * 1024),
                "available_pct": (available_bytes * 100.0) / physical_bytes,
            })
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    try:
        swap = runner(["sysctl", "-n", "vm.swapusage"], check=True, capture_output=True, text=True)
        parsed_swap = _parse_swap_context(swap.stdout)
        if parsed_swap is not None:
            context["swap"] = {"available": True, **parsed_swap}
    except (OSError, subprocess.SubprocessError):
        pass
    return context


def _pressure_sample(
    observation: dict[str, object],
    lifecycle_status: dict[str, object] | None,
    memory: dict[str, object],
    *,
    captured_at: float,
) -> dict[str, object]:
    available_pct = _numeric(memory.get("available_pct"))
    physical_ram_mib = _numeric(memory.get("physical_ram_mib"))
    return {
        "captured_at": captured_at,
        "owner": _window_owner(observation.get("owner")),
        "loaded_task_stacks": _nonnegative_int(observation.get("loaded_task_stacks")),
        "logical_helpers": _logical_helper_total(observation.get("logical_instances")),
        "rss_mib": _nonnegative_int(observation.get("rss_mib")),
        "mcp_cpu_seconds": _numeric(observation.get("raw_cpu_seconds")),
        "lifecycle_integrity": {
            **_lifecycle_integrity_evidence(lifecycle_status),
            "zombie_under_mcp_root": observation.get("zombie_under_mcp_root") is True,
            "ambiguous_ownership": observation.get("ambiguous_ownership") is True,
        },
        "system_memory": {
            "available_pct": available_pct,
            "physical_ram_mib": physical_ram_mib,
        },
    }


def _valid_pressure_sample(value: object) -> bool:
    if not isinstance(value, dict):
        return False
    if set(value) != {
        "captured_at",
        "owner",
        "loaded_task_stacks",
        "logical_helpers",
        "rss_mib",
        "mcp_cpu_seconds",
        "lifecycle_integrity",
        "system_memory",
    }:
        return False
    if _numeric(value.get("captured_at")) is None:
        return False
    for name in ("loaded_task_stacks", "logical_helpers", "rss_mib"):
        if not isinstance(value.get(name), int) or isinstance(value.get(name), bool) or value[name] < 0:
            return False
    if value.get("mcp_cpu_seconds") is not None and _numeric(value.get("mcp_cpu_seconds")) is None:
        return False
    owner = value.get("owner")
    if owner is not None and _exact_window_owner(owner) is None:
        return False
    if isinstance(owner, dict) and set(owner) != {"pid", "birth", "executable"}:
        return False
    integrity = value.get("lifecycle_integrity")
    if not isinstance(integrity, dict) or set(integrity) != {
        "partial_reaper_failure", "zombie_under_mcp_root", "ambiguous_ownership",
    } or not all(isinstance(flag, bool) for flag in integrity.values()):
        return False
    memory = value.get("system_memory")
    if not isinstance(memory, dict) or set(memory) != {"available_pct", "physical_ram_mib"}:
        return False
    return all(memory.get(name) is None or _numeric(memory.get(name)) is not None for name in memory)


def load_pressure_window(state_directory: Path) -> tuple[list[dict[str, object]], bool]:
    """Load only a valid, bounded Guard-owned five-sample window."""
    window_path = guard_owned_path(state_directory, WINDOW_FILE)
    if not window_path.exists():
        return [], True
    document = _read_json_object(window_path)
    if document is None or document.get("schema_version") != PRESSURE_WINDOW_SCHEMA_VERSION:
        return [], False
    samples = document.get("samples")
    if not isinstance(samples, list) or len(samples) > PRESSURE_WINDOW_SIZE:
        return [], False
    if not all(_valid_pressure_sample(sample) for sample in samples):
        return [], False
    return [dict(sample) for sample in samples if isinstance(sample, dict)], True


def _window_reset_reason(previous: dict[str, object], current: dict[str, object]) -> str | None:
    if previous.get("owner") != current.get("owner"):
        return "owner_identity_changed"
    if previous.get("loaded_task_stacks") != current.get("loaded_task_stacks"):
        return "task_stack_count_changed"
    prior_cpu = _numeric(previous.get("mcp_cpu_seconds"))
    current_cpu = _numeric(current.get("mcp_cpu_seconds"))
    if prior_cpu is not None and current_cpu is not None and current_cpu < prior_cpu:
        return "cpu_counter_reset"
    previous_time = _numeric(previous.get("captured_at"))
    current_time = _numeric(current.get("captured_at"))
    if previous_time is None or current_time is None or current_time <= previous_time:
        return "sample_clock_reset"
    if current_time - previous_time > PRESSURE_WINDOW_MAX_GAP_SECONDS:
        return "sample_gap_exceeded"
    return None


def advance_pressure_window(
    prior_samples: list[dict[str, object]],
    current: dict[str, object],
    *,
    prior_valid: bool,
) -> tuple[list[dict[str, object]], str | None]:
    """Append exactly one safe sample or reset at the accepted boundaries."""
    # Every sustained predicate is scoped to one exact app-server identity.
    # Preserve this one observation for diagnostics, but never let an absent or
    # malformed owner accumulate into a resource-pressure window.
    if _exact_window_owner(current.get("owner")) is None:
        return [current], "owner_identity_unavailable"
    if not prior_valid:
        return [current], "invalid_window"
    if not prior_samples:
        return [current], "initial_sample"
    reset_reason = _window_reset_reason(prior_samples[-1], current)
    if reset_reason is not None:
        return [current], reset_reason
    return [*prior_samples, current][-PRESSURE_WINDOW_SIZE:], None


def _alert(alert_id: str, message: str, evidence: dict[str, object] | None = None) -> dict[str, object]:
    return {
        "id": alert_id,
        "kind": alert_id.split(":", 1)[0],
        "message": message,
        "evidence": evidence or {},
    }


def _retains_increase(values: list[float]) -> bool:
    return len(values) >= 3 and all(value > values[0] for value in values[-3:]) and values[-1] >= 0.95 * max(values)


def _three_consecutive_rises(values: list[float]) -> bool:
    return any(
        all(values[index + offset + 1] > values[index + offset] for offset in range(3))
        for index in range(max(0, len(values) - 3))
    )


def _stable_exact_owner(samples: list[dict[str, object]]) -> bool:
    if not samples:
        return False
    owner = _exact_window_owner(samples[0].get("owner"))
    return owner is not None and all(sample.get("owner") == owner for sample in samples)


def _stable_owner_and_stack(samples: list[dict[str, object]]) -> bool:
    if len(samples) != PRESSURE_WINDOW_SIZE or not _stable_exact_owner(samples):
        return False
    stacks = samples[0].get("loaded_task_stacks")
    return isinstance(stacks, int) and stacks > 0 and all(
        sample.get("loaded_task_stacks") == stacks
        for sample in samples
    )


def _cpu_window_summary(samples: list[dict[str, object]]) -> dict[str, object]:
    fractions: list[float] = []
    for previous, current in zip(samples, samples[1:]):
        prior_cpu = _numeric(previous.get("mcp_cpu_seconds"))
        current_cpu = _numeric(current.get("mcp_cpu_seconds"))
        prior_time = _numeric(previous.get("captured_at"))
        current_time = _numeric(current.get("captured_at"))
        if None in (prior_cpu, current_cpu, prior_time, current_time):
            return {"samples": len(samples), "available": False}
        elapsed = current_time - prior_time
        if elapsed <= 0 or current_cpu < prior_cpu:
            return {"samples": len(samples), "available": False}
        fractions.append((current_cpu - prior_cpu) / elapsed)
    return {
        "samples": len(samples),
        "available": bool(fractions),
        "core_fractions": fractions,
        "minimum_core_fraction": min(fractions) if fractions else None,
    }


def sustained_alerts(samples: list[dict[str, object]]) -> list[dict[str, object]]:
    """Evaluate only the accepted resource-impact predicates, never count limits."""
    if not samples:
        return []
    current = samples[-1]
    integrity = current.get("lifecycle_integrity")
    integrity = integrity if isinstance(integrity, dict) else {}
    alerts: list[dict[str, object]] = []
    if integrity.get("partial_reaper_failure") is True:
        alerts.append(_alert(
            "lifecycle_integrity:partial_reaper_failure",
            "The reaper reported a partial detached-tree failure; Guard did not signal any process.",
        ))
    if integrity.get("zombie_under_mcp_root") is True:
        alerts.append(_alert(
            "lifecycle_integrity:zombie_under_mcp_root",
            "An exact MCP root has a zombie descendant; Guard did not signal any process.",
        ))
    if len(samples) >= 2:
        previous_integrity = samples[-2].get("lifecycle_integrity")
        previous_integrity = previous_integrity if isinstance(previous_integrity, dict) else {}
        if (
            integrity.get("ambiguous_ownership") is True
            and previous_integrity.get("ambiguous_ownership") is True
        ):
            alerts.append(_alert(
                "lifecycle_integrity:ambiguous_ownership",
                "MCP ownership was ambiguous in two consecutive samples; Guard did not signal any process.",
            ))

    memory_samples = [
        sample for sample in samples
        if isinstance(sample.get("system_memory"), dict)
        and _numeric(sample["system_memory"].get("available_pct")) is not None
        and _numeric(sample["system_memory"].get("physical_ram_mib")) is not None
    ]
    current_memory = current.get("system_memory")
    if isinstance(current_memory, dict):
        physical_ram_mib = _numeric(current_memory.get("physical_ram_mib"))
        low_memory_samples = sum(
            1
            for sample in memory_samples
            if _numeric(sample["system_memory"].get("available_pct")) <= MEMORY_AVAILABLE_PERCENT_CEILING
        )
        if (
            _stable_exact_owner(samples)
            and
            physical_ram_mib is not None
            and low_memory_samples >= MEMORY_LOW_SAMPLE_COUNT
            and _nonnegative_int(current.get("rss_mib")) >= physical_ram_mib * MEMORY_RSS_RAM_FRACTION
        ):
            alerts.append(_alert(
                "system_memory_corroborated",
                "Low available system memory is corroborated by substantial MCP RSS.",
                {"low_memory_samples": low_memory_samples},
            ))

    if len(samples) != PRESSURE_WINDOW_SIZE:
        return alerts

    logical_values = [float(_nonnegative_int(sample.get("logical_helpers"))) for sample in samples]
    rss_values = [float(_nonnegative_int(sample.get("rss_mib"))) for sample in samples]
    logical_growth = (
        _stable_owner_and_stack(samples)
        and _three_consecutive_rises(logical_values)
        and logical_values[-1] >= logical_values[0] + 3
        and _retains_increase(logical_values)
    )
    rss_growth = (
        _stable_owner_and_stack(samples)
        and rss_values[-1] >= rss_values[0] + RSS_GROWTH_MIB
        and _retains_increase(rss_values)
    )
    if logical_growth or rss_growth:
        alerts.append(_alert(
            "stable_load_growth",
            "MCP load grew across a stable five-sample owner window.",
            {"logical_helper_growth": logical_growth, "rss_growth": rss_growth},
        ))

    cpu_window = _cpu_window_summary(samples)
    fractions = cpu_window.get("core_fractions")
    if (
        _stable_exact_owner(samples)
        and isinstance(fractions, list)
        and len(fractions) == PRESSURE_WINDOW_SIZE - 1
        and all(
        isinstance(value, (int, float)) and value >= CPU_CORE_FRACTION_FLOOR for value in fractions
        )
    ):
        alerts.append(_alert(
            "sustained_mcp_cpu",
            "MCP CPU remained at or above half of one core across the five-sample window.",
            {"minimum_core_fraction": cpu_window.get("minimum_core_fraction")},
        ))

    return alerts


def dedupe_alerts(alerts: Iterable[dict[str, object]]) -> list[dict[str, object]]:
    """Keep one stable notification/event record per alert ID."""
    deduplicated: list[dict[str, object]] = []
    seen: set[str] = set()
    for alert in alerts:
        alert_id = alert.get("id")
        if not isinstance(alert_id, str) or not alert_id or alert_id in seen:
            continue
        seen.add(alert_id)
        deduplicated.append(alert)
    return deduplicated


def lifecycle_alerts(lifecycle_status: dict[str, object] | None) -> list[dict[str, object]]:
    """Report reaper evidence while explicitly retaining no signal authority."""
    if lifecycle_status is None:
        return []
    trees = lifecycle_status.get("trees")
    if not isinstance(trees, list):
        return []
    alerts: list[dict[str, object]] = []
    for tree in trees:
        if not isinstance(tree, dict):
            continue
        if tree.get("ownership") != "detached":
            continue
        if tree.get("actionable") is True:
            alerts.append(_alert(
                "detached_actionable",
                "The reaper reported an actionable detached MCP tree; Guard did not signal it.",
            ))
        if tree.get("state") == "partial_failure":
            alerts.append(_alert(
                "detached_actionable:failed_signal_attempt",
                "The reaper reported a failed detached-tree signal attempt; Guard did not signal it.",
            ))
    return dedupe_alerts(alerts)


def build_guard_document(
    observation: dict[str, object] | None,
    lifecycle_status: dict[str, object] | None,
    unavailable_reasons: list[dict[str, str]],
    *,
    alerts: list[dict[str, object]] | None = None,
    sample_count: int = 1,
    reset_reason: str | None = "initial_sample",
    window_samples: list[dict[str, object]] | None = None,
    system_memory: dict[str, object] | None = None,
    generated_at: float | None = None,
) -> dict[str, object]:
    """Create the v3 observer document. This function has no I/O."""
    data = observation or {}
    active_alerts = dedupe_alerts(alerts or [])
    loaded_task_stacks = data.get("loaded_task_stacks", 0)
    ui_helpers = data.get("ui_owned_logical_helpers", 0)
    loaded_task_stacks = loaded_task_stacks if isinstance(loaded_task_stacks, int) else 0
    ui_helpers = ui_helpers if isinstance(ui_helpers, int) else 0
    state, producer = select_v3_state(
        unavailable_reasons=unavailable_reasons,
        alerts=active_alerts,
        loaded_task_stacks=loaded_task_stacks,
        ui_owned_logical_helpers=ui_helpers,
    )
    lifecycle_generated_at = lifecycle_status.get("generated_at") if lifecycle_status else None
    matcher_version = lifecycle_status.get("matcher_registry_version") if lifecycle_status else None
    expected_matcher = lifecycle.MATCHER_REGISTRY_VERSION if lifecycle is not None else None
    return {
        "schema": STATUS_SCHEMA,
        "schema_version": STATUS_SCHEMA_VERSION,
        "generated_at": time.time() if generated_at is None else generated_at,
        "producer_version": PRODUCER_VERSION,
        "authority": AUTHORITY,
        "mutationCapabilities": [],
        "taskDataAccess": "none",
        "state": state,
        "selected_producer": producer,
        "unavailable_reasons": unavailable_reasons,
        "alerts": active_alerts,
        "explanations": [
            "Guard observes process health and may notify; it does not control processes or access task data."
        ],
        "sample_count": max(0, sample_count),
        "reset_reason": reset_reason,
        "schema_versions": {
            "guard": STATUS_SCHEMA_VERSION,
            "lifecycle": lifecycle.SCHEMA_VERSION if lifecycle is not None else None,
        },
        "matcher": {
            "expected": expected_matcher,
            "observed": matcher_version,
            "freshness": "fresh" if not unavailable_reasons else "unavailable",
            "lifecycle_generated_at": lifecycle_generated_at,
        },
        "ownership": data.get("ownership", {}),
        "counts": {
            "loaded_task_stacks": loaded_task_stacks,
            "logical_instances": data.get("logical_instances", {}),
            "raw_processes": data.get("raw_processes", 0),
            "rss_mib": data.get("rss_mib", 0),
            "app_servers": data.get("app_servers", 0),
        },
        "cpu_window": _cpu_window_summary(window_samples or []),
        "system_memory": system_memory or {"available": False, "swap": {"available": False}},
        "job": {
            "ok": state != "unavailable",
            "mode": "observation",
            "error": unavailable_reasons[0]["detail"] if unavailable_reasons else None,
        },
    }


def write_guard_status(document: dict[str, object], state_directory: Path) -> Path:
    """Atomically write only the Guard's v3 status document."""
    status_path = guard_owned_path(state_directory, GUARD_STATUS_FILE)
    status_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{status_path.name}.", dir=status_path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, status_path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise
    return status_path


def write_pressure_window(samples: list[dict[str, object]], state_directory: Path) -> Path:
    """Atomically persist the bounded, metadata-only pressure window."""
    window_path = guard_owned_path(state_directory, WINDOW_FILE)
    window_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{window_path.name}.", dir=window_path.parent)
    temporary_path = Path(temporary_name)
    document = {
        "schema_version": PRESSURE_WINDOW_SCHEMA_VERSION,
        "samples": samples[-PRESSURE_WINDOW_SIZE:],
    }
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, window_path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise
    return window_path


def load_notification_cooldown(state_directory: Path) -> dict[str, float]:
    """Read only the Guard-owned cooldown map; malformed state is discarded."""
    state = _read_json_object(guard_owned_path(state_directory, NOTIFY_FILE))
    if state is None:
        return {}
    return {
        key: float(value)
        for key, value in state.items()
        if isinstance(key, str) and _numeric(value) is not None
    }


def save_notification_cooldown(state: dict[str, float], state_directory: Path) -> Path:
    """Persist notification cooldown only below the supplied lifecycle directory."""
    path = guard_owned_path(state_directory, NOTIFY_FILE)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(state, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        temporary_path.unlink(missing_ok=True)
        raise
    return path


def maybe_notify(
    alert: dict[str, object],
    state_directory: Path,
    *,
    now: float | None = None,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Use the configured notification helper without acquiring process authority."""
    helper = os.environ.get("CODEX_MCP_GUARD_NOTIFY_HELPER")
    alert_id = alert.get("id")
    message = alert.get("message")
    if not helper or not isinstance(alert_id, str) or not isinstance(message, str):
        return "not_configured"
    timestamp = time.time() if now is None else now
    cooldown = load_notification_cooldown(state_directory)
    if timestamp - cooldown.get(alert_id, 0.0) < NOTIFICATION_COOLDOWN_SECONDS:
        return "cooldown"
    try:
        completed = runner([helper, "Codex MCP Guard", message], check=False, capture_output=True, text=True)
    except (OSError, subprocess.SubprocessError):
        return "failed"
    if completed.returncode != 0:
        return "failed"
    cooldown[alert_id] = timestamp
    save_notification_cooldown(cooldown, state_directory)
    return "sent"


def observe_once(
    state_directory: Path,
    *,
    now: float | None = None,
    process_loader: Callable[[], dict[int, Any]] | None = None,
    sleeper: Callable[[float], None] = time.sleep,
    system_memory_loader: Callable[[], dict[str, object]] = load_system_memory_context,
) -> dict[str, object]:
    """Read allowed inputs, advance safe evidence, and construct one v3 document."""
    checked_at = time.time() if now is None else now
    lifecycle_status, lifecycle_reasons = read_lifecycle_status(state_directory, now=checked_at)
    observation, snapshot_reasons = load_observation_with_retry(process_loader, sleeper=sleeper)
    unavailable_reasons = [*lifecycle_reasons, *snapshot_reasons]
    try:
        system_memory = system_memory_loader()
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
        system_memory = {"available": False, "swap": {"available": False}}
    if unavailable_reasons or observation is None:
        return build_guard_document(
            observation,
            lifecycle_status,
            unavailable_reasons,
            sample_count=0,
            reset_reason="unavailable_inputs",
            system_memory=system_memory,
            generated_at=checked_at,
        )

    prior_samples, prior_valid = load_pressure_window(state_directory)
    sample = _pressure_sample(observation, lifecycle_status, system_memory, captured_at=checked_at)
    samples, reset_reason = advance_pressure_window(prior_samples, sample, prior_valid=prior_valid)
    try:
        write_pressure_window(samples, state_directory)
    except OSError as exc:
        return build_guard_document(
            observation,
            lifecycle_status,
            [_reason("pressure_window_write_failed", type(exc).__name__)],
            sample_count=len(samples),
            reset_reason="pressure_window_write_failed",
            window_samples=samples,
            system_memory=system_memory,
            generated_at=checked_at,
        )
    alerts = dedupe_alerts([
        *lifecycle_alerts(lifecycle_status),
        *sustained_alerts(samples),
    ])
    return build_guard_document(
        observation,
        lifecycle_status,
        [],
        alerts=alerts,
        sample_count=len(samples),
        reset_reason=reset_reason,
        window_samples=samples,
        system_memory=system_memory,
        generated_at=checked_at,
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Observe MCP process health without remediation.")
    parser.add_argument(
        "--scope",
        choices=("process-only", "status"),
        default="process-only",
        help="Use process observation or print the non-mutating status result.",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress normal output.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        state_directory = configured_state_directory()
    except ValueError as exc:
        print(f"codex-mcp-guard: {exc}", file=sys.stderr, flush=True)
        return 2
    document = observe_once(state_directory)
    try:
        write_guard_status(document, state_directory)
    except OSError as exc:
        print(f"codex-mcp-guard: could not persist v3 status: {exc}", file=sys.stderr, flush=True)
        return 1
    for alert in dedupe_alerts(document["alerts"] if isinstance(document.get("alerts"), list) else []):
        if isinstance(alert, dict):
            maybe_notify(alert, state_directory)
    if args.scope == "status" or not args.quiet:
        print(json.dumps(document, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
