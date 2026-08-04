#!/usr/bin/env python3
"""Hermetic verification for the canonical MCP lifecycle package.

This intentionally writes only inside temporary directories.  In particular,
the baseline suite imports package assets rather than ``~/.codex``.
"""
from __future__ import annotations

import hashlib
import json
import os
import plistlib
import py_compile
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = PACKAGE_ROOT / "manifest.json"
FROZEN_HOME = "/Users/thomashulihan"
EXPECTED_SCENARIOS = {
    "ui-owned",
    "exact-detached",
    "blocker",
    "pid-reuse",
    "corrupt-state",
    "action-receipt",
    "matcher-near-match",
    "soft-blocker-idle",
    "soft-blocker-active",
    "helper-churn",
    "legacy-state-compat",
}


def fail(message: str) -> None:
    raise AssertionError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_relative(value: str, *, label: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        fail(f"{label} is not a safe relative path: {value!r}")
    return candidate


def read_manifest() -> dict[str, Any]:
    value = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail("manifest root must be an object")
    return value


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema_version") != 1:
        fail("manifest schema_version must be 1")
    package = manifest.get("package")
    if package != {"name": "@therealityreport/tweakers-mcp-lifecycle", "version": "0.4.1"}:
        fail("manifest package identity/version changed")
    if (
        manifest.get("lifecycle_schema_version") != 2
        or manifest.get("policy_version") != "strict-detached-v4"
    ):
        fail("manifest lifecycle/policy schema changed")
    if manifest.get("matcher_registry_version") != "mcp-family-descriptors-v4":
        fail("manifest matcher registry version changed")
    expected_policy = {
        "detached_stable_grace_seconds": 600,
        "termination_order": "children-first-term",
        "term_grace_seconds": 5,
        "kill_scope": "same-identity-survivors",
        "automatic_signal_owner": "reaper",
        "guard_mode": "notification-only",
        "lane_modes": {
            "detached_wrapper": "automatic",
            "exact_standalone_app_server": "automatic",
            "standalone_orphan": "observation_only",
            "claude_idle": "observation_only",
        },
    }
    if manifest.get("policy") != expected_policy:
        fail("manifest policy no longer represents the frozen v2 safety policy")
    if manifest.get("preserved_runtime_files") != [
        "tmp/codex-mcp-idle-reaper-state.json",
        "tmp/codex-mcp-lifecycle-state.json",
        "tmp/codex-mcp-lifecycle-status.json",
        "tmp/codex-mcp-lifecycle-actions.jsonl",
        "tmp/codex-mcp-guard-notify.json",
        "tmp/codex-mcp-guard-status.json",
    ]:
        fail("manifest must explicitly preserve lifecycle state, status, and action receipts")

    assets = manifest.get("assets")
    if not isinstance(assets, list) or len(assets) != 5:
        fail("manifest must declare exactly five lifecycle assets")
    labels: list[str] = []
    destinations: set[str] = set()
    for asset in assets:
        if not isinstance(asset, dict):
            fail("manifest asset must be an object")
        source = asset.get("source")
        destination = asset.get("destination")
        mode = asset.get("mode")
        source_digest = asset.get("source_sha256")
        if not isinstance(source, str) or not isinstance(destination, str):
            fail("manifest asset source/destination must be strings")
        source_path = PACKAGE_ROOT / checked_relative(source, label="asset source")
        if not source_path.is_file():
            fail(f"manifest source is missing: {source}")
        if not destination.startswith("{{HOME}}/") or ".." in Path(destination.removeprefix("{{HOME}}/")).parts:
            fail(f"asset destination must be a portable safe HOME path: {destination!r}")
        if destination in destinations:
            fail(f"asset destination appears more than once: {destination}")
        destinations.add(destination)
        if not isinstance(mode, str) or not re.fullmatch(r"0[0-7]{3}", mode):
            fail(f"asset mode is invalid: {mode!r}")
        actual_mode = stat.S_IMODE(source_path.stat().st_mode)
        if actual_mode != int(mode, 8):
            fail(f"asset mode mismatch for {source}: expected {mode}, got {actual_mode:04o}")
        if not isinstance(source_digest, str) or sha256(source_path) != source_digest:
            fail(f"asset source digest mismatch for {source}")

        kind = asset.get("kind")
        if kind == "plist-template":
            template_digest = asset.get("template_sha256")
            if template_digest != source_digest:
                fail(f"template digest must equal source digest for {source}")
            raw = source_path.read_text(encoding="utf-8")
            if "{{HOME}}" not in raw or "{{" in raw.replace("{{HOME}}", ""):
                fail(f"template must use only the portable HOME token: {source}")
            rendered = raw.replace("{{HOME}}", FROZEN_HOME)
            if hashlib.sha256(rendered.encode("utf-8")).hexdigest() != asset.get("rendered_sha256"):
                fail(f"frozen rendered digest mismatch for {source}")
            if asset.get("rendered_home") != FROZEN_HOME:
                fail(f"rendered home proof is missing for {source}")
            label = asset.get("label")
            if not isinstance(label, str) or f"<string>{label}</string>" not in raw:
                fail(f"template label is missing or malformed for {source}")
            labels.append(label)
        elif kind != "file":
            fail(f"unknown asset kind {kind!r}")
    if sorted(labels) != [
        "com.thomashulihan.codex-mcp-guard",
        "com.thomashulihan.codex-mcp-idle-reaper",
    ] or len(labels) != len(set(labels)):
        fail("launchd labels must be exact and unique")

    tests = manifest.get("tests")
    if not isinstance(tests, dict) or tests.get("baseline_count") != 74:
        fail("manifest must declare the 74-test baseline")
    fixture = PACKAGE_ROOT / checked_relative(str(tests.get("fixtures", "")), label="fixture")
    fixture_payload = json.loads(fixture.read_text(encoding="utf-8"))
    scenarios = fixture_payload.get("scenarios") if isinstance(fixture_payload, dict) else None
    scenario_ids = {entry.get("id") for entry in scenarios if isinstance(entry, dict)} if isinstance(scenarios, list) else set()
    if scenario_ids != EXPECTED_SCENARIOS:
        fail("lifecycle fixture coverage is incomplete")


def compile_python_assets(manifest: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(prefix="mcp-lifecycle-compile-") as directory:
        output = Path(directory)
        for asset in manifest["assets"]:
            if asset["kind"] != "file":
                continue
            source = PACKAGE_ROOT / asset["source"]
            pyc = output / f"{asset['id']}.pyc"
            py_compile.compile(str(source), cfile=str(pyc), doraise=True)
            if not pyc.is_file():
                fail(f"py_compile did not create temporary bytecode for {source}")


def validate_plists_if_available(manifest: dict[str, Any]) -> None:
    plutil = shutil.which("plutil")
    with tempfile.TemporaryDirectory(prefix="mcp-lifecycle-plist-") as directory:
        for asset in manifest["assets"]:
            if asset["kind"] != "plist-template":
                continue
            rendered = (PACKAGE_ROOT / asset["source"]).read_text(encoding="utf-8").replace("{{HOME}}", FROZEN_HOME)
            parsed = plistlib.loads(rendered.encode("utf-8"))
            if parsed.get("Label") != asset["label"]:
                fail(f"plist label mismatch for {asset['id']}")
            if plutil:
                path = Path(directory) / f"{asset['id']}.plist"
                path.write_text(rendered, encoding="utf-8")
                result = subprocess.run([plutil, "-lint", str(path)], capture_output=True, text=True)
                if result.returncode != 0:
                    fail(f"plutil rejected {asset['id']}: {result.stderr or result.stdout}")


def run_baseline(manifest: dict[str, Any]) -> None:
    test_path = PACKAGE_ROOT / checked_relative(manifest["tests"]["path"], label="baseline test")
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(
        [sys.executable, "-B", str(test_path)],
        cwd=PACKAGE_ROOT,
        env=environment,
        capture_output=True,
        text=True,
    )
    combined = f"{result.stdout}\n{result.stderr}"
    if result.returncode != 0:
        raise RuntimeError(f"canonical lifecycle baseline failed:\n{combined}")
    expected = manifest["tests"]["baseline_count"]
    if not re.search(rf"Ran {expected} tests?", combined):
        raise RuntimeError(f"canonical lifecycle baseline did not run {expected} tests:\n{combined}")


def main() -> int:
    manifest = read_manifest()
    validate_manifest(manifest)
    compile_python_assets(manifest)
    validate_plists_if_available(manifest)
    run_baseline(manifest)
    print("mcp-lifecycle package validation passed (74 baseline tests; no live writes)")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"mcp-lifecycle package validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
