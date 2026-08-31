from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


# Keep the baseline hermetic: package tests always import the staged canonical
# sources below this package, never a user's installed ~/.codex copy.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
BIN = PACKAGE_ROOT / "assets" / "bin"
LIB = PACKAGE_ROOT / "assets" / "lib"
if str(LIB) not in sys.path:
    sys.path.insert(0, str(LIB))

import codex_mcp_lifecycle as lifecycle


def load_script(module_name: str, filename: str):
    spec = importlib.util.spec_from_file_location(module_name, BIN / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


guard = load_script("codex_mcp_guard_under_test", "codex-mcp-guard.py")
reaper = load_script("codex_mcp_idle_reaper_under_test", "codex-mcp-idle-reaper.py")


def reaper_proc(
    pid: int,
    ppid: int,
    args: str,
    *,
    comm: str = "node",
    rss_kib: int = 1024,
    state: str = "S",
    age: int = 7200,
    cpu: float = 0.0,
):
    return reaper.Proc(pid, ppid, rss_kib, state, age, cpu, comm, args)


class AppServerMatchingTests(unittest.TestCase):
    def test_codex_flags_before_app_server_are_recognized(self):
        args = "/Users/test/.local/bin/codex -c features.code_mode_host=true app-server --analytics-default-enabled"
        rp = reaper_proc(100, 50, args, comm="/Users/test/.local/bin/codex")

        self.assertTrue(reaper.is_codex_appserver(rp))

    def test_wrapper_text_is_not_mistaken_for_app_server(self):
        args = "node -e wrapper -- /Users/test/.local/bin/codex -c x=y app-server"
        rp = reaper_proc(100, 50, args, comm="node")

        self.assertFalse(reaper.is_codex_appserver(rp))

    def test_direct_chrome_runtime_is_recognized(self):
        args = (
            "/opt/node /tmp/runtime/node_modules/chrome-devtools-mcp/"
            "build/src/bin/chrome-devtools-mcp.js --headless=true"
        )
        rp = reaper_proc(110, 100, args, comm="/opt/node")

        self.assertTrue(reaper.is_chrome_devtools_mcp_root(rp))


class ProcessSnapshotTests(unittest.TestCase):
    def test_kernel_executable_path_replaces_lossy_ps_comm(self):
        node = str(Path.home() / ".nvm" / "versions" / "node" / "v22.18.0" / "bin" / "node")

        def runner(command, **_kwargs):
            if command[-1].endswith("comm="):
                stdout = "99 1 501 1024 S 00:10 00:00:00 npm exec @playwr\\n"
            else:
                stdout = "99 npm exec @playwright/mcp@latest --headless\\n"
            return mock.Mock(stdout=stdout)

        with mock.patch.object(lifecycle, "_kernel_birth", return_value="birth-99"), mock.patch.object(
            lifecycle, "_kernel_executable_path", return_value=node,
        ):
            snapshot = lifecycle.load_process_snapshot(runner)

        self.assertEqual(node, snapshot[99].executable)
        self.assertEqual("playwright", lifecycle._mcp_descriptor(snapshot[99]).family)

    def test_missing_kernel_executable_path_does_not_trust_ps_comm(self):
        def runner(command, **_kwargs):
            if command[-1].endswith("comm="):
                stdout = "99 1 501 1024 S 00:10 00:00:00 /opt/homebrew/bin/node\\n"
            else:
                stdout = "99 node @playwright/mcp@latest --headless\\n"
            return mock.Mock(stdout=stdout)

        with mock.patch.object(lifecycle, "_kernel_birth", return_value="birth-99"), mock.patch.object(
            lifecycle, "_kernel_executable_path", return_value="",
        ):
            snapshot = lifecycle.load_process_snapshot(runner)

        self.assertEqual("", snapshot[99].executable)
        self.assertIsNone(lifecycle._mcp_descriptor(snapshot[99]))

    def test_missing_kernel_executable_path_rejects_spoofed_bundled_app_server_argv(self):
        codex = "/Applications/ChatGPT.app/Contents/Resources/codex"

        def runner(command, **_kwargs):
            if command[-1].endswith("comm="):
                stdout = "99 1 501 1024 S 00:10 00:00:00 /tmp/not-codex\n"
            else:
                stdout = f"99 {codex} -c features.code_mode_host=true app-server\n"
            return mock.Mock(stdout=stdout)

        with mock.patch.object(lifecycle, "_kernel_birth", return_value="birth-99"), mock.patch.object(
            lifecycle, "_kernel_executable_path", return_value="",
        ):
            snapshot = lifecycle.load_process_snapshot(runner)

        self.assertEqual("", snapshot[99].executable)
        self.assertFalse(lifecycle.is_exact_standalone_app_server(snapshot[99]))
        self.assertIsNone(snapshot[99].identity)

    def test_kernel_text_vnode_proves_only_the_exact_promoted_swap_runtime(self):
        codex = "/Applications/ChatGPT.app/Contents/Resources/codex"
        swap = "/Applications/ChatGPT.app.tweakers-contents-swap/Resources/codex"

        def runner(command, **_kwargs):
            if command[-1].endswith("comm="):
                stdout = "99 1 501 1024 S 00:10 00:00:00 codex\n"
            else:
                stdout = f"99 {codex} -c features.code_mode_host=true app-server --analytics-default-enabled\n"
            return mock.Mock(stdout=stdout)

        with mock.patch.object(lifecycle, "_kernel_birth", return_value="birth-99"), mock.patch.object(
            lifecycle, "_kernel_executable_path", return_value="",
        ):
            snapshot = lifecycle.load_process_snapshot(runner, text_vnode_provider=lambda _pid: swap)

        self.assertEqual(swap, snapshot[99].executable)
        self.assertTrue(lifecycle.is_exact_standalone_app_server(snapshot[99]))
        spoofed = lifecycle.ProcessInfo(
            **{**snapshot[99].__dict__, "args": "/Applications/Codex.app/Contents/Resources/codex "
               "-c features.code_mode_host=true app-server --analytics-default-enabled"}
        )
        self.assertFalse(lifecycle.is_exact_standalone_app_server(spoofed))
        code_mode_host = lifecycle.ProcessInfo(
            **{**snapshot[99].__dict__, "pid": 100,
               "executable": "/Applications/ChatGPT.app.tweakers-contents-swap/Resources/codex-code-mode-host",
               "args": "/Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host"}
        )
        self.assertTrue(lifecycle._is_runtime(code_mode_host))

    def test_proc_pidpath_takes_precedence_over_text_vnode_fallback(self):
        node = str(Path.home() / ".nvm" / "versions" / "node" / "v22.18.0" / "bin" / "node")

        def runner(command, **_kwargs):
            if command[-1].endswith("comm="):
                stdout = "99 1 501 1024 S 00:10 00:00:00 node\n"
            else:
                stdout = "99 npm exec @playwright/mcp@latest --headless\n"
            return mock.Mock(stdout=stdout)

        with mock.patch.object(lifecycle, "_kernel_birth", return_value="birth-99"), mock.patch.object(
            lifecycle, "_kernel_executable_path", return_value=node,
        ):
            snapshot = lifecycle.load_process_snapshot(
                runner,
                text_vnode_provider=lambda _pid: self.fail("text vnode fallback should not run"),
            )

        self.assertEqual(node, snapshot[99].executable)
        self.assertEqual("playwright", lifecycle._mcp_descriptor(snapshot[99]).family)

    def test_text_vnode_fallback_rejects_lsof_failure_multiple_and_spoof_paths(self):
        valid = "/Applications/ChatGPT.app.tweakers-contents-swap/Resources/codex"
        self.assertEqual(valid, lifecycle._approved_text_vnode_path(["p99", "ftxt", f"n{valid}"]))
        self.assertEqual("", lifecycle._approved_text_vnode_path([f"n{valid}", f"n{valid}"]))
        self.assertEqual("", lifecycle._approved_text_vnode_path(["n/tmp/not-codex"]))
        with mock.patch.object(lifecycle.subprocess, "run", side_effect=OSError("lsof unavailable")):
            self.assertEqual("", lifecycle._lsof_text_vnode_path(99))

    def test_swap_vnode_mapping_only_accepts_the_five_fixed_contents_runtimes(self):
        prefix = "/Applications/ChatGPT.app.tweakers-contents-swap/"
        expected = {
            "Resources/codex",
            "Resources/codex-code-mode-host",
            "Resources/cua_node/bin/node_repl",
            "Resources/cua_node/bin/node",
            "SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
            "Resources/Codex Computer Use.app/Contents/SharedSupport/"
            "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
        }
        for suffix in expected:
            self.assertEqual(
                f"/Applications/ChatGPT.app/Contents/{suffix}",
                lifecycle._swap_vnode_current_path(prefix + suffix),
            )
        self.assertIsNone(lifecycle._swap_vnode_current_path(prefix + "Resources/codex-near-match"))
        self.assertIsNone(lifecycle._swap_vnode_current_path(
            "/Applications/ChatGPT.app.tweakers-contents-swap-evil/Resources/codex"
        ))

    def test_swap_runtime_helpers_and_wrapper_require_same_app_current_argv(self):
        app = "ChatGPT"
        base = f"/Applications/{app}.app"
        swap = f"/Applications/{app}.app.tweakers-contents-swap"
        node_repl = lifecycle.ProcessInfo(
            pid=100, ppid=11, uid=501, rss_kib=1, state="S", age_seconds=900, cpu_seconds=0,
            executable=f"{swap}/Resources/cua_node/bin/node_repl",
            args=f"{base}/Contents/Resources/cua_node/bin/node_repl", birth="node-repl",
        )
        computer_use = lifecycle.ProcessInfo(
            pid=101, ppid=11, uid=501, rss_kib=1, state="S", age_seconds=900, cpu_seconds=0,
            executable=f"{swap}/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
            args=f"{base}/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient event-stream mcp",
            birth="computer-use",
        )
        self.assertTrue(lifecycle._is_runtime(node_repl))
        self.assertEqual("node_repl", lifecycle._mcp_descriptor(node_repl).family)
        self.assertEqual("computer_use", lifecycle._mcp_descriptor(computer_use).family)
        cross_app = lifecycle.ProcessInfo(
            **{**computer_use.__dict__, "args":
               "/Applications/Codex.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient event-stream mcp"}
        )
        extra_node_repl = lifecycle.ProcessInfo(
            **{**node_repl.__dict__, "args": f"{base}/Contents/Resources/cua_node/bin/node_repl extra"}
        )
        self.assertIsNone(lifecycle._mcp_descriptor(cross_app))
        self.assertFalse(lifecycle._is_exact_swap_node_repl(extra_node_repl))
        wrapper_command = (
            f"{base}/Contents/Resources/cua_node/bin/node -e Tweakers Codex parent: missing child command -- "
            f"{base}/Contents/Resources/codex -c features.code_mode_host=true app-server --analytics-default-enabled"
        )
        wrapper = lifecycle.ProcessInfo(
            pid=102, ppid=1, uid=501, rss_kib=1, state="S", age_seconds=900, cpu_seconds=0,
            executable=f"{swap}/Resources/cua_node/bin/node", args=wrapper_command, birth="wrapper",
        )
        self.assertTrue(lifecycle.looks_like_codex_wrapper(wrapper))
        wrong_wrapper = lifecycle.ProcessInfo(
            **{**wrapper.__dict__, "args": wrapper_command.replace(
                f"{base}/Contents/Resources/cua_node/bin/node", "node", 1,
            )}
        )
        self.assertFalse(lifecycle.looks_like_codex_wrapper(wrong_wrapper))


class ReaperSafetyTests(unittest.TestCase):
    def make_reaper(self, procs):
        with mock.patch.object(reaper, "load_procs", return_value={p.pid: p for p in procs}):
            return reaper.Reaper(dry_run=True)

    def test_old_and_over_count_live_stacks_are_never_targets(self):
        procs = [
            reaper_proc(
                100,
                50,
                "codex -c features.code_mode_host=true app-server --analytics-default-enabled",
                comm="/opt/codex",
                age=86400,
            ),
            reaper_proc(101, 100, "node context7-app-compat", age=86400),
            reaper_proc(102, 100, "npm exec chrome-devtools-mcp", comm="npm", age=86400),
            reaper_proc(103, 100, "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl", comm="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl", age=86400),
            reaper_proc(104, 100, "npm exec @decodo/mcp-server", comm="npm", age=86400),
            reaper_proc(105, 100, "node user-questions/mcp-server.js", age=86400),
        ]
        instance = self.make_reaper(procs)

        instance.reap_orphans()

        self.assertEqual({}, instance.victims)
        self.assertEqual(set(), instance.actionable_orphans)

    def test_unverified_legacy_orphans_remain_observed_but_never_targeted(self):
        procs = [
            reaper_proc(200, 1, "codex -c x=y app-server", comm="/opt/codex", age=500),
            reaper_proc(201, 200, "node context7-app-compat", age=500),
            reaper_proc(210, 1, "npm exec @decodo/mcp-server", comm="npm", age=500),
            reaper_proc(220, 1, "/opt/cua_node/bin/node_repl", comm="/opt/cua_node/bin/node_repl", age=4000),
        ]
        instance = self.make_reaper(procs)

        instance.reap_orphans()

        self.assertEqual({210, 220}, instance.legacy_findings["standalone_orphan"])
        self.assertEqual(set(), instance.actionable_orphans)
        self.assertEqual({}, instance.victims)

    def test_protected_long_lived_transports_are_not_targets(self):
        procs = [
            reaper_proc(300, 1, "python modal_ops_mcp.py", comm="python3", age=10000),
            reaper_proc(301, 1, "npm exec chrome-devtools-mcp --browserUrl http://127.0.0.1:9422", comm="npm", age=10000),
        ]
        instance = self.make_reaper(procs)

        instance.reap_orphans()

        self.assertEqual({}, instance.victims)
        self.assertEqual(set(), instance.actionable_orphans)

    def test_legacy_claude_lane_never_calls_the_signal_sender(self):
        procs = [
            reaper_proc(200, 1, "codex -c x=y app-server", comm="/opt/codex", age=500),
            reaper_proc(300, 1, "claude", comm="claude", age=1_000),
            reaper_proc(301, 300, "npm exec @upstash/context7-mcp", comm="npm", age=2_000),
        ]
        signals = []
        with mock.patch.object(reaper, "load_procs", return_value={p.pid: p for p in procs}):
            instance = reaper.Reaper(
                dry_run=False,
                signal_sender=lambda pid, sig: signals.append((pid, sig)),
                sleeper=lambda _seconds: None,
            )
        instance.reap_orphans()
        with mock.patch.object(reaper.time, "time", return_value=10_000):
            instance.reap_claude_idle({
                "claude": {
                    "300": {"start": 9_000, "cpu": 0.0, "idle_since": 9_000.0},
                },
            })
        killed, _freed, _tags = instance.execute()

        self.assertEqual(set(), instance.legacy_findings["standalone_orphan"])
        self.assertEqual({301}, instance.legacy_findings["claude_idle"])
        self.assertEqual(0, killed)
        self.assertEqual([], signals)


class GuardV3ObserverTests(unittest.TestCase):
    def lifecycle_document(self, generated_at=1_000):
        return {
            "schema_version": lifecycle.SCHEMA_VERSION,
            "generated_at": generated_at,
            "matcher_registry_version": lifecycle.MATCHER_REGISTRY_VERSION,
            "job": {"ok": True, "mode": "status", "error": None},
            "counts": {},
            "trees": [],
        }

    def test_v3_selector_has_exact_four_state_precedence(self):
        cases = [
            ({"unavailable_reasons": [{"code": "missing", "detail": "x"}], "alerts": [{"id": "a"}], "loaded_task_stacks": 1, "ui_owned_logical_helpers": 1}, ("unavailable", "unavailable")),
            ({"unavailable_reasons": [], "alerts": [{"id": "a"}], "loaded_task_stacks": 1, "ui_owned_logical_helpers": 1}, ("warning", "warning")),
            ({"unavailable_reasons": [], "alerts": [], "loaded_task_stacks": 1, "ui_owned_logical_helpers": 1}, ("expected_fanout", "expected_fanout")),
            ({"unavailable_reasons": [], "alerts": [], "loaded_task_stacks": 0, "ui_owned_logical_helpers": 1}, ("healthy", "healthy")),
        ]
        for arguments, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(expected, guard.select_v3_state(**arguments))

    def test_lifecycle_status_requires_current_schema_matcher_and_freshness(self):
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            path = state_directory / guard.LIFECYCLE_STATUS_FILE
            path.write_text(json.dumps(self.lifecycle_document()))
            document, reasons = guard.read_lifecycle_status(state_directory, now=1_100)
            self.assertIsNotNone(document)
            self.assertEqual([], reasons)

            stale = self.lifecycle_document(generated_at=1)
            path.write_text(json.dumps(stale))
            _document, stale_reasons = guard.read_lifecycle_status(state_directory, now=1_000)
            self.assertEqual("lifecycle_status_stale", stale_reasons[0]["code"])

            mismatch = self.lifecycle_document()
            mismatch["matcher_registry_version"] = "wrong"
            path.write_text(json.dumps(mismatch))
            _document, mismatch_reasons = guard.read_lifecycle_status(state_directory, now=1_100)
            self.assertIn("matcher_version_mismatch", [reason["code"] for reason in mismatch_reasons])

    def test_v3_document_declares_only_observation_authority_and_has_required_fields(self):
        document = guard.build_guard_document(
            {
                "loaded_task_stacks": 3,
                "ui_owned_logical_helpers": 2,
                "logical_instances": {"chrome": 2},
                "raw_processes": 4,
                "rss_mib": 12,
                "ownership": {"ui_owned": 1},
            },
            self.lifecycle_document(),
            [],
            generated_at=1_000,
        )
        self.assertEqual("mcp-guard-status.v3", document["schema"])
        self.assertEqual(3, document["schema_version"])
        self.assertEqual("observation-and-notification-only", document["authority"])
        self.assertEqual([], document["mutationCapabilities"])
        self.assertEqual("none", document["taskDataAccess"])
        self.assertEqual("expected_fanout", document["state"])
        self.assertEqual("expected_fanout", document["selected_producer"])
        self.assertIn("schema_versions", document)
        self.assertIn("matcher", document)
        self.assertIn("counts", document)
        self.assertIn("cpu_window", document)
        self.assertIn("system_memory", document)

    def test_actionable_detached_tree_is_a_warning_that_never_claims_signal_authority(self):
        lifecycle_status = self.lifecycle_document()
        lifecycle_status["trees"] = [{
            "tree_key": "detached-example",
            "ownership": "detached",
            "actionable": True,
        }]
        alerts = guard.lifecycle_alerts(lifecycle_status)
        document = guard.build_guard_document({}, lifecycle_status, [], alerts=alerts, generated_at=1_000)
        self.assertEqual("warning", document["state"])
        self.assertEqual("detached_actionable", document["alerts"][0]["kind"])
        self.assertIn("did not signal", document["alerts"][0]["message"])

    def test_guard_writes_only_its_bounded_state_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            document = guard.build_guard_document({}, self.lifecycle_document(), [], generated_at=1_000)
            path = guard.write_guard_status(document, state_directory)
            self.assertEqual((state_directory / guard.GUARD_STATUS_FILE).resolve(), path)
            self.assertEqual(0o600, path.stat().st_mode & 0o777)
            with self.assertRaises(ValueError):
                guard.guard_owned_path(state_directory, "outside.json")
            with self.assertRaises(ValueError):
                guard.configured_state_directory("relative")

    def test_snapshot_retry_is_bounded_and_records_unavailable_after_second_failure(self):
        attempts = []

        def unavailable():
            attempts.append("attempt")
            raise OSError("snapshot unavailable")

        observation, reasons = guard.load_observation_with_retry(unavailable, sleeper=lambda seconds: attempts.append(seconds))
        self.assertIsNone(observation)
        self.assertEqual(["attempt", 0.25, "attempt"], attempts)
        self.assertEqual("process_snapshot_unavailable", reasons[0]["code"])

    def test_default_process_only_and_status_are_non_mutating_and_removed_scopes_fail(self):
        self.assertEqual("process-only", guard.parse_args([]).scope)
        self.assertEqual("status", guard.parse_args(["--scope", "status"]).scope)
        for removed in ("all", "threads-only"):
            with self.subTest(scope=removed), self.assertRaises(SystemExit):
                guard.parse_args(["--scope", removed])

    def test_cooldown_is_a_guard_owned_notification_seam(self):
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            with mock.patch.dict("os.environ", {"CODEX_MCP_GUARD_NOTIFY_HELPER": "/tmp/notify"}, clear=False):
                sent = guard.maybe_notify(
                    {"id": "test-alert", "message": "observable warning"},
                    state_directory,
                    now=7_200,
                    runner=lambda *_args, **_kwargs: mock.Mock(returncode=0),
                )
                cooldown = guard.maybe_notify(
                    {"id": "test-alert", "message": "observable warning"},
                    state_directory,
                    now=7_201,
                    runner=lambda *_args, **_kwargs: mock.Mock(returncode=0),
                )
            self.assertEqual("sent", sent)
            self.assertEqual("cooldown", cooldown)
            self.assertTrue((state_directory / guard.NOTIFY_FILE).exists())


class GuardSustainedEvidenceTests(unittest.TestCase):
    uid = os.getuid()
    wrapper_executable = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
    codex_executable = "/Applications/ChatGPT.app/Contents/Resources/codex"
    node_repl_executable = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"
    computer_use_executable = (
        Path.home() / ".codex" / "computer-use" / "Codex Computer Use.app" / "Contents"
        / "SharedSupport" / "SkyComputerUseClient.app" / "Contents" / "MacOS" / "SkyComputerUseClient"
    )

    def proc(self, pid, ppid, executable, args, *, rss_kib=1024, cpu=0.0, state="S", birth=None, cwd=""):
        return lifecycle.ProcessInfo(
            pid=pid,
            ppid=ppid,
            uid=self.uid,
            rss_kib=rss_kib,
            state=state,
            age_seconds=900,
            cpu_seconds=cpu,
            executable=str(executable),
            args=args,
            birth=birth or f"birth-{pid}",
            cwd=cwd,
        )

    def ui_snapshot(self, *, task_stacks=1, helper_mode="event-stream", helper_child=False):
        ui = self.proc(2, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "ChatGPT")
        wrapper = self.proc(
            10,
            2,
            self.wrapper_executable,
            "node -e 'x' Tweakers Codex parent: fixture -- "
            f"{self.codex_executable} -c features.code_mode_host=true app-server",
        )
        app = self.proc(
            11,
            10,
            self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server",
        )
        repls = [
            self.proc(100 + index, 11, self.node_repl_executable, self.node_repl_executable)
            for index in range(task_stacks)
        ]
        helper = self.proc(
            300,
            11,
            self.computer_use_executable,
            f"{self.computer_use_executable} {helper_mode} mcp",
            rss_kib=2 * 1024,
            cpu=10.0,
        )
        descendants = [
            self.proc(301, 300, "/usr/bin/node", "node child.js", rss_kib=3 * 1024, cpu=5.0)
        ] if helper_child else []
        return {process.pid: process for process in [ui, wrapper, app, *repls, helper, *descendants]}

    def sample(
        self,
        captured_at,
        *,
        helpers=1,
        rss_mib=10,
        cpu_seconds=0.0,
        stacks=1,
        owner=True,
        ambiguous=False,
        partial=False,
        zombie=False,
        available_pct=50.0,
        physical_ram_mib=10_000,
    ):
        return {
            "captured_at": captured_at,
            "owner": {"pid": 11, "birth": "app-a", "executable": self.codex_executable} if owner else None,
            "loaded_task_stacks": stacks,
            "logical_helpers": helpers,
            "rss_mib": rss_mib,
            "mcp_cpu_seconds": cpu_seconds,
            "lifecycle_integrity": {
                "partial_reaper_failure": partial,
                "zombie_under_mcp_root": zombie,
                "ambiguous_ownership": ambiguous,
            },
            "system_memory": {
                "available_pct": available_pct,
                "physical_ram_mib": physical_ram_mib,
            },
        }

    def alert_ids(self, samples):
        return {alert["id"] for alert in guard.sustained_alerts(samples)}

    def test_shared_registry_covers_every_exact_computer_use_mode_without_substring_trust(self):
        descriptors = [
            lifecycle._mcp_descriptor(self.proc(
                20 + index,
                11,
                self.computer_use_executable,
                f"{self.computer_use_executable} {mode} mcp",
            ))
            for index, mode in enumerate(("event-stream", "messages", "computer-history"))
        ]
        self.assertEqual(
            [
                "app.computer-use.event-stream",
                "app.computer-use.messages",
                "app.computer-use.computer-history",
            ],
            [descriptor.identifier if descriptor else None for descriptor in descriptors],
        )
        negative = [
            self.proc(30, 11, self.computer_use_executable, f"{self.computer_use_executable} messages mcp --extra"),
            self.proc(31, 11, "/usr/bin/python3", "python3 report.py --note event-stream mcp"),
            self.proc(32, 11, "/tmp/SkyComputerUseClient", "/tmp/SkyComputerUseClient computer-history mcp"),
        ]
        self.assertEqual([None, None, None], [lifecycle._mcp_descriptor(process) for process in negative])

    def test_context7_compatibility_requires_its_declared_wrapper_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "context7" / "1.0.0"
            script = root / "dist" / "context7-app-compat-mcp.mjs"
            wrapper = root / "scripts" / "start-context7-mcp.sh"
            script.parent.mkdir(parents=True)
            wrapper.parent.mkdir()
            script.write_text("// fixture", encoding="utf-8")
            wrapper.write_text('exec node "$script_dir/context7-app-compat-mcp.mjs"\n', encoding="utf-8")
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": {
                "context7": {"type": "stdio", "command": "./scripts/start-context7-mcp.sh", "args": []},
            }}), encoding="utf-8")
            process = self.proc(40, 11, "/usr/bin/node", f"node {script}")
            with mock.patch.object(lifecycle, "TRUSTED_SCRIPT_ROOTS", {root}):
                descriptor = lifecycle._mcp_descriptor(process)
            self.assertEqual("context7", descriptor.family if descriptor else None)

            wrapper.write_text("node context7-app-compat-mcp.mjs\n", encoding="utf-8")
            with mock.patch.object(lifecycle, "TRUSTED_SCRIPT_ROOTS", {root}):
                self.assertIsNone(lifecycle._mcp_descriptor(process))
            with mock.patch.object(lifecycle, "TRUSTED_SCRIPT_ROOTS", {root}):
                self.assertIsNone(lifecycle._mcp_descriptor(self.proc(
                    41, 11, "/usr/bin/node", f"node {script} --note context7-app-compat-mcp.mjs",
                )))
            self.assertIsNone(lifecycle._mcp_descriptor(self.proc(
                42, 11, "/usr/bin/uvx", "uvx context7-mcp-untrusted",
            )))

    def test_topology_keeps_logical_roots_raw_descendants_rss_and_ownership_separate(self):
        snapshot = self.ui_snapshot(task_stacks=12, helper_child=True)
        topology = lifecycle.classify_mcp_topology(snapshot, uid=self.uid)
        self.assertEqual({"computer_use": 1}, topology.logical_family_counts)
        self.assertEqual(2, len(topology.raw_process_ids))
        self.assertEqual(5 * 1024, topology.raw_rss_kib)
        self.assertEqual(15.0, topology.raw_cpu_seconds)
        self.assertEqual({"ui_owned": 1}, topology.ownership_counts)
        self.assertEqual(12, topology.loaded_task_stacks)
        self.assertFalse(topology.zombie_under_mcp_root)
        observation = guard.collect_process_observation(snapshot)
        self.assertEqual({"computer_use": 1}, observation["logical_instances"])
        self.assertEqual(2, observation["raw_processes"])
        self.assertEqual(5, observation["rss_mib"])

    def test_twelve_stable_ui_task_stacks_are_expected_fanout_not_a_family_warning(self):
        snapshot = self.ui_snapshot(task_stacks=12)
        lifecycle_status = {
            "schema_version": lifecycle.SCHEMA_VERSION,
            "matcher_registry_version": lifecycle.MATCHER_REGISTRY_VERSION,
            "generated_at": 1_000,
            "job": {"ok": True},
            "counts": {},
            "trees": [],
        }
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            (state_directory / guard.LIFECYCLE_STATUS_FILE).write_text(json.dumps(lifecycle_status))
            document = None
            for index in range(5):
                lifecycle_status["generated_at"] = 1_000 + (index * 60)
                (state_directory / guard.LIFECYCLE_STATUS_FILE).write_text(json.dumps(lifecycle_status))
                document = guard.observe_once(
                    state_directory,
                    now=1_000 + (index * 60),
                    process_loader=lambda: snapshot,
                    sleeper=lambda _seconds: None,
                    system_memory_loader=lambda: {"available": False, "swap": {"available": False}},
                )
        self.assertIsNotNone(document)
        self.assertEqual("expected_fanout", document["state"])
        self.assertEqual([], document["alerts"])
        self.assertEqual(5, document["sample_count"])

    def test_stable_growth_requires_exact_five_sample_boundary_and_retention(self):
        samples = [
            self.sample(1_000 + index * 60, helpers=helpers, rss_mib=rss)
            for index, (helpers, rss) in enumerate(((1, 10), (2, 20), (3, 30), (4, 40), (4, 40)))
        ]
        self.assertNotIn("stable_load_growth", self.alert_ids(samples[:4]))
        self.assertIn("stable_load_growth", self.alert_ids(samples))
        dropped = [*samples[:-1], self.sample(1_240, helpers=1, rss_mib=1)]
        self.assertNotIn("stable_load_growth", self.alert_ids(dropped))

    def test_cpu_and_memory_need_their_exact_sustained_evidence(self):
        cpu_samples = [
            self.sample(1_000 + index * 60, cpu_seconds=index * 30.0)
            for index in range(5)
        ]
        self.assertIn("sustained_mcp_cpu", self.alert_ids(cpu_samples))
        below_cpu = [*cpu_samples[:-1], self.sample(1_240, cpu_seconds=119.0)]
        self.assertNotIn("sustained_mcp_cpu", self.alert_ids(below_cpu))

        memory_samples = [
            self.sample(2_000 + index * 60, rss_mib=2_500, available_pct=10.0)
            for index in range(3)
        ]
        self.assertNotIn("system_memory_corroborated", self.alert_ids(memory_samples[:2]))
        self.assertIn("system_memory_corroborated", self.alert_ids(memory_samples))
        swap_only = [
            self.sample(3_000 + index * 60, rss_mib=2_500, available_pct=30.0)
            for index in range(3)
        ]
        self.assertNotIn("system_memory_corroborated", self.alert_ids(swap_only))

    def test_sustained_resource_predicates_require_one_exact_owner(self):
        no_owner = [
            self.sample(
                4_000 + index * 60,
                owner=False,
                helpers=index + 1,
                rss_mib=2_500,
                cpu_seconds=index * 30.0,
                available_pct=10.0,
            )
            for index in range(5)
        ]
        window: list[dict[str, object]] = []
        for sample in no_owner:
            window, reason = guard.advance_pressure_window(window, sample, prior_valid=True)
            self.assertEqual("owner_identity_unavailable", reason)
            self.assertEqual([sample], window)
        self.assertEqual(
            set(),
            self.alert_ids(no_owner) & {
                "stable_load_growth",
                "sustained_mcp_cpu",
                "system_memory_corroborated",
            },
        )

        exact_owner = [
            self.sample(
                5_000 + index * 60,
                helpers=index + 1,
                rss_mib=2_500,
                cpu_seconds=index * 30.0,
                available_pct=10.0,
            )
            for index in range(5)
        ]
        window = []
        for index, sample in enumerate(exact_owner):
            window, reason = guard.advance_pressure_window(window, sample, prior_valid=True)
            self.assertEqual("initial_sample" if index == 0 else None, reason)
        self.assertEqual(exact_owner, window)
        self.assertTrue({
            "stable_load_growth",
            "sustained_mcp_cpu",
            "system_memory_corroborated",
        }.issubset(self.alert_ids(exact_owner)))

    def test_window_resets_on_owner_stack_counter_and_gap_boundaries(self):
        prior = self.sample(1_000, cpu_seconds=100.0)
        cases = [
            (self.sample(1_060, owner=False), "owner_identity_unavailable"),
            (self.sample(1_060, stacks=2), "task_stack_count_changed"),
            (self.sample(1_060, cpu_seconds=1.0), "cpu_counter_reset"),
            (self.sample(1_151, cpu_seconds=101.0), "sample_gap_exceeded"),
        ]
        for current, expected in cases:
            with self.subTest(expected=expected):
                samples, reason = guard.advance_pressure_window([prior], current, prior_valid=True)
                self.assertEqual(expected, reason)
                self.assertEqual([current], samples)

    def test_lifecycle_integrity_detached_recovery_and_dedup_are_explicit(self):
        partial = self.sample(1_000, partial=True)
        self.assertIn("lifecycle_integrity:partial_reaper_failure", self.alert_ids([partial]))
        ambiguous = [self.sample(1_000, ambiguous=True), self.sample(1_060, ambiguous=True)]
        self.assertIn("lifecycle_integrity:ambiguous_ownership", self.alert_ids(ambiguous))
        recovered = [ambiguous[-1], self.sample(1_120, ambiguous=False)]
        self.assertNotIn("lifecycle_integrity:ambiguous_ownership", self.alert_ids(recovered))
        detached = guard.lifecycle_alerts({"trees": [{
            "ownership": "detached", "actionable": True, "state": "partial_failure",
        }]})
        self.assertEqual(
            {"detached_actionable", "detached_actionable:failed_signal_attempt"},
            {alert["id"] for alert in detached},
        )
        self.assertEqual({"detached_actionable"}, {alert["kind"] for alert in detached})
        self.assertEqual(1, len(guard.dedupe_alerts([detached[0], detached[0]])))

    def test_window_persistence_contains_only_safe_observation_fields(self):
        sample = self.sample(1_000)
        with tempfile.TemporaryDirectory() as directory:
            state_directory = Path(directory)
            guard.write_pressure_window([sample], state_directory)
            loaded, valid = guard.load_pressure_window(state_directory)
            serialized = (state_directory / guard.WINDOW_FILE).read_text(encoding="utf-8")
            poisoned = dict(sample)
            poisoned["args"] = "must-not-persist"
            (state_directory / guard.WINDOW_FILE).write_text(json.dumps({
                "schema_version": guard.PRESSURE_WINDOW_SCHEMA_VERSION,
                "samples": [poisoned],
            }), encoding="utf-8")
            rejected, rejected_valid = guard.load_pressure_window(state_directory)
        self.assertTrue(valid)
        self.assertEqual([sample], loaded)
        self.assertNotIn("args", serialized)
        self.assertNotIn("title", serialized)
        self.assertNotIn("session", serialized)
        self.assertEqual([], rejected)
        self.assertFalse(rejected_valid)

    def test_installed_candidate_audit_fails_closed_for_static_task_store_authority(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "unsafe-guard.py"
            candidate.write_text("import sqlite3\n", encoding="utf-8")
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({}), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(audit),
                    "--candidate", str(candidate),
                    "--state-dir", str(root / "state"),
                    "--process-fixture", str(process_fixture),
                    "--lifecycle-fixture", str(lifecycle_fixture),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(1, completed.returncode)
        self.assertIn("static_forbidden", completed.stdout)

    def test_installed_candidate_audit_fails_closed_for_exact_codex_store_identifiers(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        identifiers = ("history.jsonl", "archived_sessions", "rollout_summaries")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({}), encoding="utf-8")
            for identifier in identifiers:
                with self.subTest(identifier=identifier):
                    candidate = root / f"unsafe-{identifier}.py"
                    candidate.write_text(
                        f'forbidden_store = "{identifier}"\n', encoding="utf-8"
                    )
                    completed = subprocess.run(
                        [
                            sys.executable,
                            "-B",
                            str(audit),
                            "--candidate", str(candidate),
                            "--state-dir", str(root / "state"),
                            "--process-fixture", str(process_fixture),
                            "--lifecycle-fixture", str(lifecycle_fixture),
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(1, completed.returncode)
                    self.assertIn("static_forbidden", completed.stdout)

    def test_candidate_audit_blocks_runtime_exact_codex_store_opens(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        identifiers = ("history.jsonl", "archived_sessions", "rollout_summaries")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for identifier in identifiers:
                (root / identifier).write_text("forbidden", encoding="utf-8")
            candidate = root / "candidate.py"
            candidate.write_text(
                (BIN / "codex-mcp-guard.py").read_text(encoding="utf-8")
                + '''\nfor _store_name in ("history" + ".jsonl", "archived" + "_sessions", "rollout" + "_summaries"):
    Path(os.environ["MCP_GUARD_AUDIT_STATE_DIR"]).parent.joinpath(_store_name).read_text(encoding="utf-8")
''',
                encoding="utf-8",
            )
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({}), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(audit),
                    "--candidate", str(candidate),
                    "--state-dir", str(root / "state"),
                    "--process-fixture", str(process_fixture),
                    "--lifecycle-fixture", str(lifecycle_fixture),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(1, completed.returncode)
        for identifier in identifiers:
            self.assertIn(f"forbidden_store_open:{identifier}", completed.stdout)

    def test_candidate_audit_clears_the_notification_helper_environment(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate.py"
            candidate.write_text(
                (BIN / "codex-mcp-guard.py").read_text(encoding="utf-8")
                + '''\nif os.environ.get("CODEX_MCP_GUARD_NOTIFY_HELPER"):
    subprocess.run(["unexpected-notification-helper"])
''',
                encoding="utf-8",
            )
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({}), encoding="utf-8")
            with mock.patch.dict(os.environ, {"CODEX_MCP_GUARD_NOTIFY_HELPER": "/tmp/unexpected"}, clear=False):
                completed = subprocess.run(
                    [
                        sys.executable,
                        "-B",
                        str(audit),
                        "--candidate", str(candidate),
                        "--state-dir", str(root / "state"),
                        "--process-fixture", str(process_fixture),
                        "--lifecycle-fixture", str(lifecycle_fixture),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
        self.assertEqual(0, completed.returncode, completed.stdout + completed.stderr)
        self.assertIn('"subprocesses": []', completed.stdout)

    def test_candidate_audit_accepts_the_staged_process_only_guard_with_fixture_inputs(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        candidate = BIN / "codex-mcp-guard.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({
                "schema_version": lifecycle.SCHEMA_VERSION,
                "matcher_registry_version": lifecycle.MATCHER_REGISTRY_VERSION,
                "generated_at": 1_000,
                "job": {"ok": True, "mode": "status", "error": None},
                "counts": {},
                "trees": [],
            }), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(audit),
                    "--candidate", str(candidate),
                    "--state-dir", str(root / "state"),
                    "--process-fixture", str(process_fixture),
                    "--lifecycle-fixture", str(lifecycle_fixture),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(0, completed.returncode, completed.stdout + completed.stderr)
        self.assertIn('"violations": []', completed.stdout)

    def test_candidate_audit_blocks_a_runtime_write_outside_guard_owned_state(self):
        audit = PACKAGE_ROOT / "scripts" / "audit_guard_file_access.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate.py"
            escaped_write = root / "outside-guard-state.json"
            candidate.write_text(
                (BIN / "codex-mcp-guard.py").read_text(encoding="utf-8")
                + f"\nPath({str(escaped_write)!r}).write_text('unexpected', encoding='utf-8')\n",
                encoding="utf-8",
            )
            process_fixture = root / "process.json"
            process_fixture.write_text(json.dumps({"processes": []}), encoding="utf-8")
            lifecycle_fixture = root / "lifecycle.json"
            lifecycle_fixture.write_text(json.dumps({}), encoding="utf-8")
            completed = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(audit),
                    "--candidate", str(candidate),
                    "--state-dir", str(root / "state"),
                    "--process-fixture", str(process_fixture),
                    "--lifecycle-fixture", str(lifecycle_fixture),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(1, completed.returncode)
        self.assertIn("out_of_contract_write", completed.stdout)


class SharedLifecycleTests(unittest.TestCase):
    uid = 501
    wrapper_executable = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
    codex_executable = "/Applications/ChatGPT.app/Contents/Resources/codex"

    def proc(self, pid, ppid, executable, args, *, birth=None, age=900, cpu=0.0, state="S", cwd=""):
        return lifecycle.ProcessInfo(
            pid=pid, ppid=ppid, uid=self.uid, rss_kib=1024, state=state,
            age_seconds=age, cpu_seconds=cpu, executable=executable, args=args,
            birth=birth or f"birth-{pid}", cwd=cwd,
        )

    def wrapper(self, ppid=1, *, birth="wrapper-a", age=900):
        return self.proc(
            10, ppid, self.wrapper_executable,
            "node -e require(\"node:child_process\"); Tweakers Codex parent: missing child command; "
            "NODE_OPTIONS=--enable-source-maps stdio: \"inherit\" -- "
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth=birth, age=age,
        )

    def app_server(self, *, birth="app-a"):
        return self.proc(
            11, 10, self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth=birth,
        )

    def classify(self, processes):
        return lifecycle.classify_codex_trees({proc.pid: proc for proc in processes}, uid=self.uid)

    def test_valid_ui_tree_and_many_mcp_helpers_are_observation_only(self):
        ui = self.proc(2, 1, "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", "ChatGPT")
        helpers = [
            self.proc(
                20 + index,
                11,
                "/Applications/ChatGPT.app/Contents/SharedSupport/"
                "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
                "SkyComputerUseClient event-stream mcp",
            )
            for index in range(30)
        ]
        tree = self.classify([ui, self.wrapper(ppid=2), self.app_server(), *helpers])[0]

        self.assertEqual("ui_owned", tree.ownership)
        updated, _state = lifecycle.advance_lifecycle_state([tree], {}, 2_000)
        self.assertEqual("observed", updated[0].state)
        self.assertFalse(updated[0].actionable)
        self.assertEqual(30, updated[0].helper_family_counts["computer_use"])
        status = updated[0].to_status()
        self.assertEqual("detached_wrapper", status["lifecycle_lane"])
        self.assertEqual("observation_only", status["lane_mode"])

    def test_gsd_pi_requires_the_exact_entrypoint_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "gsd-pi" / "packages" / "mcp-server" / "dist"
            root.mkdir(parents=True)
            entrypoint = root / "cli.js"
            entrypoint.write_text("// MCP entrypoint\n", encoding="utf-8")
            exact = self.proc(12, 11, "/usr/bin/node", f"node {entrypoint}")
            near_miss = self.proc(13, 11, "/usr/bin/node", f"node {root / 'cli-dev.js'}")
            tree = self.classify([self.wrapper(), self.app_server(), exact, near_miss])[0]

        self.assertEqual({"gsd_pi": 1}, tree.helper_family_counts)
        self.assertEqual([13], [blocker.identity.pid for blocker in tree.blockers])

    def test_exact_detached_and_wrapper_like_false_positive(self):
        detached = self.classify([self.wrapper(), self.app_server()])[0]
        self.assertEqual("detached", detached.ownership)
        self.assertIsNone(detached.error)

        false_wrapper = self.proc(
            30, 1, self.wrapper_executable,
            "node Tweakers Codex parent: missing child command -- codex app-server",
        )
        false_tree = self.classify([false_wrapper])[0]
        self.assertEqual("ambiguous", false_tree.ownership)
        self.assertFalse(false_tree.actionable)

        missing_child = self.wrapper()
        ambiguous = self.classify([missing_child])[0]
        self.assertEqual("ambiguous", ambiguous.ownership)
        self.assertIn("exactly one direct", ambiguous.error or "")

    def test_exact_swapped_wrapper_and_child_normalize_to_the_current_pair(self):
        current_wrapper = self.wrapper_executable
        current_child = self.codex_executable
        swap_prefix = "/Applications/ChatGPT.app.tweakers-contents-swap"
        wrapper = self.proc(
            50, 1, f"{swap_prefix}/Resources/cua_node/bin/node",
            f"{current_wrapper} -e Tweakers Codex parent: missing child command -- "
            f"{current_child} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth="swap-wrapper",
        )
        child = self.proc(
            51, 50, f"{swap_prefix}/Resources/codex",
            f"{current_child} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth="swap-child",
        )
        tree = self.classify([wrapper, child])[0]
        self.assertEqual("detached", tree.ownership)
        self.assertIsNone(tree.error)
        self.assertEqual({50, 51}, set(tree.process_ids))

        cross_app = lifecycle.ProcessInfo(
            **{**child.__dict__, "args":
               "/Applications/Codex.app/Contents/Resources/codex "
               "-c features.code_mode_host=true app-server --analytics-default-enabled"}
        )
        cross_tree = self.classify([wrapper, cross_app])[0]
        self.assertEqual("ambiguous", cross_tree.ownership)
        self.assertIn("exactly one direct", cross_tree.error or "")

        near_wrapper = lifecycle.ProcessInfo(
            **{**wrapper.__dict__, "executable": wrapper.executable + "-near"}
        )
        self.assertEqual([], self.classify([near_wrapper, child]))

    def test_allowed_wrapper_cannot_authorize_a_tmp_child_or_mismatched_tail(self):
        tmp_codex = "/tmp/codex"
        wrapper = self.wrapper()
        wrapper = lifecycle.ProcessInfo(
            **{**wrapper.__dict__, "args": wrapper.args.replace(self.codex_executable, tmp_codex)}
        )
        child = self.proc(
            11, 10, tmp_codex,
            f"{tmp_codex} -c features.code_mode_host=true app-server --analytics-default-enabled",
        )
        tree = self.classify([wrapper, child])[0]
        self.assertEqual("ambiguous", tree.ownership)
        self.assertFalse(tree.actionable)
        self.assertIn("exactly one direct", tree.error or "")

    def test_second_direct_app_server_makes_the_entire_wrapper_ambiguous(self):
        extra = self.proc(
            14, 10, self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth="app-extra",
        )
        tree = self.classify([self.wrapper(), self.app_server(), extra])[0]
        self.assertEqual("ambiguous", tree.ownership)
        self.assertIsNone(tree.app_server_identity)
        self.assertIn("exactly one direct", tree.error or "")

    def test_any_user_work_including_sleeping_zero_cpu_blocks(self):
        sleeping_work = self.proc(
            12, 11, "/usr/bin/python3", "python object_storage_inventory_reconcile.py --apply",
            cpu=0.0, state="S",
        )
        tree = self.classify([self.wrapper(), self.app_server(), sleeping_work])[0]
        updated, state = lifecycle.advance_lifecycle_state([tree], {}, 2_000)
        self.assertEqual("blocked_active_work", updated[0].state)
        self.assertFalse(updated[0].actionable)
        self.assertIsNone(updated[0].idle_since)
        self.assertEqual("python3 object_storage_inventory_reconcile.py", updated[0].blockers[0].command_summary)

        unblocked = self.classify([self.wrapper(), self.app_server()])
        at_start, state = lifecycle.advance_lifecycle_state(unblocked, state, 2_001)
        blocked_again = self.classify([self.wrapper(), self.app_server(), sleeping_work])
        blocked, state = lifecycle.advance_lifecycle_state(blocked_again, state, 2_200)
        restarted, state = lifecycle.advance_lifecycle_state(unblocked, state, 2_201)
        at_599, state = lifecycle.advance_lifecycle_state(unblocked, state, 2_800)
        at_600, _state = lifecycle.advance_lifecycle_state(unblocked, state, 2_801)
        self.assertEqual("idle_pending", at_start[0].state)
        self.assertEqual("blocked_active_work", blocked[0].state)
        self.assertIsNone(blocked[0].idle_since)
        self.assertEqual(2_201, restarted[0].idle_since)
        self.assertEqual("idle_pending", at_599[0].state)
        self.assertEqual(1, at_599[0].remaining_seconds)
        self.assertEqual("eligible", at_600[0].state)
        self.assertTrue(at_600[0].actionable)

    def test_tail_mentioning_node_repl_is_unknown_user_work_not_an_mcp(self):
        tail = self.proc(12, 11, "/usr/bin/tail", "tail -f /tmp/node_repl.log", cpu=0.0)
        tree = self.classify([self.wrapper(), self.app_server(), tail])[0]
        self.assertEqual("detached", tree.ownership)
        self.assertEqual(1, len(tree.blockers))
        self.assertEqual("tail", tree.blockers[0].name)
        self.assertEqual({}, tree.helper_family_counts)

    def test_user_python_and_node_mcp_words_later_in_args_stay_blockers(self):
        python_work = self.proc(12, 11, "/usr/bin/python3", "python3 app.py --note chrome-devtools-mcp")
        node_work = self.proc(13, 11, "/usr/bin/node", "node app.js --note context7-mcp")
        tree = self.classify([self.wrapper(), self.app_server(), python_work, node_work])[0]
        self.assertEqual({"python3", "node"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual({}, tree.helper_family_counts)

    def test_near_match_mcp_command_text_never_reclassifies_user_work(self):
        probes = [
            self.proc(12, 11, "/usr/bin/python3", "python3 report.py --note SkyComputerUseClient event-stream mcp"),
            self.proc(13, 11, "/tmp/node_repl", "/tmp/node_repl --user-job"),
            self.proc(14, 11, "/usr/bin/npm", "npm exec chrome-devtools-mcp-report"),
            self.proc(15, 11, "/usr/bin/uv", "uv run python app.py context7-mcp"),
        ]
        tree = self.classify([self.wrapper(), self.app_server(), *probes])[0]

        self.assertEqual({"python3", "node_repl", "npm", "uv"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual({}, tree.helper_family_counts)
        updated, _state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        self.assertEqual("blocked_active_work", updated[0].state)
        self.assertFalse(updated[0].actionable)
        self.assertEqual(4, len(tree.matcher_drift))
        self.assertNotIn("context7-mcp", json.dumps(tree.matcher_drift))

    def test_exact_family_descriptors_cover_supported_launchers(self):
        trusted_plugins = Path.home() / ".codex" / "plugins" / "cache" / "local-plugins"
        iconify = trusted_plugins / "iconify" / "1.0.0" / "iconify-mcp.mjs"
        modal = trusted_plugins / "modal" / "1.0.0" / "modal_ops_mcp.py"
        with mock.patch.object(lifecycle, "_trusted_script", side_effect=lambda value: Path(value)):
            descriptors = [
                lifecycle._mcp_descriptor(self.proc(
                    20, 11, "/usr/bin/npm", "npm exec chrome-devtools-mcp@0.14.0",
                )),
                lifecycle._mcp_descriptor(self.proc(
                    21, 11, "/usr/bin/npx", "npx @upstash/context7-mcp",
                )),
                lifecycle._mcp_descriptor(self.proc(
                    22, 11, "/usr/bin/uvx", "uvx context7-mcp@1.2.3",
                )),
                lifecycle._mcp_descriptor(self.proc(
                    23, 11, "/usr/bin/node", f"node {iconify}",
                )),
                lifecycle._mcp_descriptor(self.proc(
                    24, 11, "/usr/bin/python3", f"python3 {modal}",
                )),
            ]
        self.assertEqual(
            ["chrome_devtools", "context7", "context7", "iconify", "modal"],
            [descriptor.family if descriptor else None for descriptor in descriptors],
        )
        near_match = self.proc(
            25, 11, "/usr/bin/npm", "npm exec chrome-devtools-mcp-report",
        )
        self.assertIsNone(lifecycle._mcp_descriptor(near_match))

    def test_kernel_node_path_accepts_exact_npm_argv0_launcher(self):
        node = Path.home() / ".nvm" / "versions" / "node" / "v22.18.0" / "bin" / "node"
        descriptor = lifecycle._mcp_descriptor(self.proc(
            26,
            11,
            str(node),
            "npm exec @playwright/mcp@latest --headless",
        ))
        self.assertEqual("playwright", descriptor.family if descriptor else None)

    def test_current_computer_use_and_homebrew_python_launchers_are_exact_helpers(self):
        computer_use = (
            Path.home() / ".codex" / "computer-use" / "Codex Computer Use.app"
            / "Contents" / "SharedSupport" / "SkyComputerUseClient.app" / "Contents"
            / "MacOS" / "SkyComputerUseClient"
        )
        python = (
            "/opt/homebrew/Cellar/python@3.12/3.12.13_1/Frameworks/Python.framework/"
            "Versions/3.12/Resources/Python.app/Contents/MacOS/Python"
        )
        with mock.patch.object(lifecycle, "_trusted_script", side_effect=lambda value: Path(value)):
            descriptors = [
                lifecycle._mcp_descriptor(self.proc(
                    27, 11, str(computer_use), f"{computer_use} event-stream mcp",
                )),
                lifecycle._mcp_descriptor(self.proc(
                    28, 11, python, f"{python} {Path.home() / '.local/bin/headroom'} mcp serve",
                )),
            ]
        self.assertEqual(["computer_use", "headroom"], [item.family if item else None for item in descriptors])

    def test_project_local_modal_ops_requires_exact_configured_process(self):
        with tempfile.TemporaryDirectory() as temp:
            project = Path(temp) / "TRR"
            python = project / "TRR-Backend" / ".venv" / "bin" / "python"
            framework_python = Path(temp) / "homebrew" / "Python"
            script = project / "TRR-Backend" / "scripts" / "modal" / "modal_ops_mcp.py"
            python.parent.mkdir(parents=True)
            framework_python.parent.mkdir(parents=True)
            script.parent.mkdir(parents=True)
            framework_python.write_text("#!/bin/sh\n", encoding="utf-8")
            python.symlink_to(framework_python)
            script.write_text("# modal MCP\n", encoding="utf-8")
            config = project / ".codex" / "config.toml"
            config.parent.mkdir()
            config.write_text(
                "[mcp_servers.modal-ops]\n"
                f'command = "{python}"\n'
                f'args = ["{script}"]\n'
                'env = { MODAL_PROFILE = "admin" }\n',
                encoding="utf-8",
            )
            exact = self.proc(
                30, 11, str(framework_python), f"{framework_python} {script}", cwd=str(project),
            )
            other_python = project / "TRR-Backend" / ".venv" / "bin" / "python3"
            other_python.write_text("#!/bin/sh\n", encoding="utf-8")
            wrong_executable = self.proc(
                34, 11, str(other_python), f"{other_python} {script}", cwd=str(project),
            )
            wrong_cwd = self.proc(31, 11, str(python), f"{python} {script}", cwd=str(project / "other"))
            extra_arg = self.proc(32, 11, str(python), f"{python} {script} --unsafe", cwd=str(project))
            wrong_script = project / "TRR-Backend" / "scripts" / "modal" / "other.py"
            wrong_script.write_text("# not modal\n", encoding="utf-8")
            wrong_arg = self.proc(33, 11, str(python), f"{python} {wrong_script}", cwd=str(project))

            duplicate = config.read_text(encoding="utf-8") + (
                "\n[mcp_servers.modal-ops]\n"
                f'command = "{python}"\n'
                f'args = ["{script}"]\n'
            )
            self.assertEqual("modal", lifecycle._mcp_descriptor(exact).family)
            self.assertIsNone(lifecycle._mcp_descriptor(wrong_executable))
            self.assertIsNone(lifecycle._mcp_descriptor(wrong_cwd))
            self.assertIsNone(lifecycle._mcp_descriptor(extra_arg))
            self.assertIsNone(lifecycle._mcp_descriptor(wrong_arg))
            config.write_text(duplicate, encoding="utf-8")
            self.assertIsNone(lifecycle._mcp_descriptor(exact))

    def test_project_local_modal_ops_tolerates_symlinked_project_root_aliases(self):
        with tempfile.TemporaryDirectory() as temp:
            real_root = Path(temp) / "Development" / "Projects"
            project = real_root / "TRR"
            python = project / "TRR-Backend" / ".venv" / "bin" / "python"
            framework_python = Path(temp) / "homebrew" / "Python"
            script = project / "TRR-Backend" / "scripts" / "modal" / "modal_ops_mcp.py"
            python.parent.mkdir(parents=True)
            framework_python.parent.mkdir(parents=True)
            script.parent.mkdir(parents=True)
            framework_python.write_text("#!/bin/sh\n", encoding="utf-8")
            python.symlink_to(framework_python)
            script.write_text("# modal MCP\n", encoding="utf-8")
            alias_root = Path(temp) / "Projects"
            alias_root.symlink_to(real_root)
            aliased_python = alias_root / "TRR" / "TRR-Backend" / ".venv" / "bin" / "python"
            aliased_script = (
                alias_root / "TRR" / "TRR-Backend" / "scripts" / "modal" / "modal_ops_mcp.py"
            )
            config = project / ".codex" / "config.toml"
            config.parent.mkdir()
            config.write_text(
                "[mcp_servers.modal-ops]\n"
                f'command = "{aliased_python}"\n'
                f'args = ["{aliased_script}"]\n',
                encoding="utf-8",
            )
            exact = self.proc(
                35, 11, str(framework_python), f"{framework_python} {script}", cwd=str(project),
            )
            self.assertEqual("modal", lifecycle._mcp_descriptor(exact).family)

            outside_script = Path(temp) / "elsewhere" / "modal_ops_mcp.py"
            outside_script.parent.mkdir()
            outside_script.write_text("# rogue\n", encoding="utf-8")
            config.write_text(
                "[mcp_servers.modal-ops]\n"
                f'command = "{aliased_python}"\n'
                f'args = ["{outside_script}"]\n',
                encoding="utf-8",
            )
            self.assertIsNone(lifecycle._mcp_descriptor(exact))

            missing_parent = alias_root / "TRR" / "missing" / "modal_ops_mcp.py"
            config.write_text(
                "[mcp_servers.modal-ops]\n"
                f'command = "{aliased_python}"\n'
                f'args = ["{missing_parent}"]\n',
                encoding="utf-8",
            )
            self.assertIsNone(lifecycle._mcp_descriptor(exact))

    def test_homebrew_python_distribution_accepts_both_framework_launch_shapes(self):
        stub = (
            "/opt/homebrew/Cellar/python@3.11/3.11.15/Frameworks/Python.framework/"
            "Versions/3.11/Resources/Python.app/Contents/MacOS/Python"
        )
        shim = (
            "/opt/homebrew/Cellar/python@3.11/3.11.15/Frameworks/Python.framework/"
            "Versions/3.11/bin/python3.11"
        )
        self.assertIsNotNone(lifecycle.HOMEBREW_PYTHON_DISTRIBUTION.fullmatch(stub))
        self.assertIsNotNone(lifecycle.HOMEBREW_PYTHON_DISTRIBUTION.fullmatch(shim))
        # The stricter process-executable regex still admits only the app stub.
        self.assertIsNotNone(lifecycle.HOMEBREW_PYTHON_EXECUTABLE.fullmatch(stub))
        self.assertIsNone(lifecycle.HOMEBREW_PYTHON_EXECUTABLE.fullmatch(shim))
        for rejected in (
            "/opt/homebrew/Cellar/python@3.11/3.11.15/Frameworks/Python.framework/"
            "Versions/3.11/bin/idle3.11",
            "/opt/homebrew/bin/python3.11",
            "/usr/bin/python3",
            "/opt/homebrew/Cellar/python@3.11/3.11.15/Frameworks/Python.framework/"
            "Versions/3.11/bin/python3.11/extra",
        ):
            self.assertIsNone(lifecycle.HOMEBREW_PYTHON_DISTRIBUTION.fullmatch(rejected))

    def test_headroom_uv_tool_symlink_resolves_under_the_exact_trusted_root(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / "home"
            target = home / ".local" / "share" / "uv" / "tools" / "headroom-ai" / "bin" / "headroom"
            target.parent.mkdir(parents=True)
            target.write_text("#!/bin/sh\n", encoding="utf-8")
            launcher = home / ".local" / "bin" / "headroom"
            launcher.parent.mkdir(parents=True, exist_ok=True)
            launcher.symlink_to(target)
            python = (
                "/opt/homebrew/Cellar/python@3.12/3.12.13_1/Frameworks/Python.framework/"
                "Versions/3.12/Resources/Python.app/Contents/MacOS/Python"
            )
            helper = self.proc(29, 11, python, f"{python} {launcher} mcp serve")
            with mock.patch.object(lifecycle, "TRUSTED_SCRIPT_ROOTS", {
                home / ".local" / "bin", home / ".local" / "share" / "uv" / "tools",
            }):
                descriptor = lifecycle._mcp_descriptor(helper)

        self.assertEqual("headroom", descriptor.family if descriptor else None)

    def test_proven_mcp_root_suppresses_only_its_runtime_descendants(self):
        node = Path.home() / ".nvm" / "versions" / "node" / "v22.18.0" / "bin" / "node"
        root = self.proc(30, 11, str(node), "npm exec @playwright/mcp@latest --headless")
        child = self.proc(31, 30, str(node), "node /tmp/npm-cache/playwright-mcp --output-dir .playwright-mcp-output")
        unrelated = self.proc(32, 11, "/usr/bin/python3", "python3 work.py --note mcp")
        tree = self.classify([self.wrapper(), self.app_server(), root, child, unrelated])[0]
        self.assertEqual({"playwright": 1}, tree.helper_family_counts)
        self.assertEqual({"python3"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual(0, len(tree.matcher_drift))

    def test_exact_standalone_bundled_app_server_uses_the_detached_lifecycle_grace(self):
        standalone = self.proc(
            40,
            1,
            self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth="standalone-a",
        )
        tree = self.classify([standalone])[0]
        self.assertEqual("detached", tree.ownership)
        self.assertEqual(tree.root_identity, tree.app_server_identity)
        pending, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        eligible, _state = lifecycle.advance_lifecycle_state([tree], state, 1_600)
        self.assertEqual("idle_pending", pending[0].state)
        self.assertEqual("eligible", eligible[0].state)

    def test_standalone_app_server_plan_keeps_children_first_whole_tree_termination(self):
        standalone = self.proc(
            40,
            1,
            self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth="standalone-a",
        )
        repl = self.proc(
            41,
            40,
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
            "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
            birth="repl-a",
        )
        processes = {proc.pid: proc for proc in (standalone, repl)}
        tree = self.classify(processes.values())[0]
        _pending, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, state = lifecycle.advance_lifecycle_state([tree], state, 1_600)
        instance = reaper.Reaper(
            dry_run=True,
            snapshot_provider=lambda: processes,
            clock=lambda: 1_600,
            signal_sender=lambda *_args: self.fail("dry-run must not signal"),
            sleeper=lambda _seconds: self.fail("dry-run must not sleep"),
        )
        instance.plan_detached_wrappers(state)
        planned = instance.detached_plans[tree.tree_key]
        self.assertEqual({40, 41}, set(planned))
        self.assertEqual([41, 40], instance._children_first_order(planned, processes))

    def test_relative_mcp_script_remains_a_blocker_without_proven_path_evidence(self):
        relative = self.proc(41, 11, "/usr/bin/node", "node ./mcp/server.bundle.mjs --stdio")
        tree = self.classify([self.wrapper(), self.app_server(), relative])[0]
        self.assertEqual({"node"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual({}, tree.helper_family_counts)

    def test_arbitrary_compiler_mcp_text_remains_a_blocker_without_matcher_drift(self):
        compiler = self.proc(
            42,
            11,
            "/usr/bin/swift-driver",
            "swift-driver -module-name mcp-client /Users/test/project/Sources/main.swift",
        )
        tree = self.classify([self.wrapper(), self.app_server(), compiler])[0]
        self.assertEqual({"swift-driver"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual((), tree.matcher_drift)

    def test_launcher_and_script_impersonation_remain_user_work_blockers(self):
        probes = [
            self.proc(
                26, 11, "/usr/bin/node",
                "node /Users/test/private/iconify-mcp.mjs --apply",
            ),
            self.proc(
                27, 11, "/usr/bin/python3",
                "npm exec chrome-devtools-mcp",
            ),
            self.proc(
                28, 11, "/usr/bin/python3",
                "python3 /Users/test/private/modal_ops_mcp.py --apply",
            ),
            self.proc(
                29, 11, "/tmp/npm",
                "npm exec chrome-devtools-mcp",
            ),
        ]
        tree = self.classify([self.wrapper(), self.app_server(), *probes])[0]
        self.assertEqual({}, tree.helper_family_counts)
        self.assertEqual({26, 27, 28, 29}, {blocker.identity.pid for blocker in tree.blockers})
        self.assertEqual("detached", tree.ownership)

    def test_unquoted_sky_computer_use_space_path_is_a_real_helper(self):
        path = (
            "/Applications/ChatGPT.app/Contents/SharedSupport/"
            "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
        )
        helper = self.proc(12, 11, path, f"{path} event-stream mcp")
        tree = self.classify([self.wrapper(), self.app_server(), helper])[0]

        self.assertEqual((), tree.blockers)
        self.assertEqual({"computer_use": 1}, tree.helper_family_counts)

    def test_kernel_cwd_and_exact_plugin_manifest_authorize_relative_mcp_script(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / "cache"
            root = cache / "local-plugins" / "fixture" / "1.0.0"
            script = root / "mcp" / "server.bundle.mjs"
            script.parent.mkdir(parents=True)
            script.write_text("// fixture\n", encoding="utf-8")
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": {
                "fixture": {"command": "node", "cwd": ".", "args": ["./mcp/server.bundle.mjs"]},
            }}), encoding="utf-8")
            helper = self.proc(
                12, 11, "/opt/homebrew/bin/node", "node ./mcp/server.bundle.mjs",
                cwd=str(root),
            )
            with mock.patch.object(lifecycle, "TRUSTED_PLUGIN_CACHE_ROOTS", {cache}):
                tree = self.classify([self.wrapper(), self.app_server(), helper])[0]

        self.assertEqual((), tree.blockers)
        self.assertEqual({"other_mcp": 1}, tree.helper_family_counts)

    def test_relative_plugin_script_rejects_manifest_mismatch_and_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            cache = Path(temp) / "cache"
            root = cache / "local-plugins" / "fixture" / "1.0.0"
            root.mkdir(parents=True)
            outside = Path(temp) / "outside.mjs"
            outside.write_text("// outside\n", encoding="utf-8")
            (root / "escape.mjs").symlink_to(outside)
            (root / ".mcp.json").write_text(json.dumps({"mcpServers": {
                "fixture": {"command": "node", "cwd": ".", "args": ["./escape.mjs"]},
            }}), encoding="utf-8")
            helper = self.proc(12, 11, "/opt/homebrew/bin/node", "node ./escape.mjs", cwd=str(root))
            with mock.patch.object(lifecycle, "TRUSTED_PLUGIN_CACHE_ROOTS", {cache}):
                tree = self.classify([self.wrapper(), self.app_server(), helper])[0]

        self.assertEqual(1, len(tree.blockers))
        self.assertEqual(helper.pid, tree.blockers[0].identity.pid)

    def test_absolute_trusted_script_rejects_a_symlink_escape(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "trusted"
            root.mkdir()
            outside = Path(temp) / "outside.mjs"
            outside.write_text("// outside\n", encoding="utf-8")
            escaped = root / "mcp" / "server.bundle.mjs"
            escaped.parent.mkdir()
            escaped.symlink_to(outside)
            helper = self.proc(12, 11, "/opt/homebrew/bin/node", f"node {escaped}")
            with mock.patch.object(lifecycle, "TRUSTED_SCRIPT_ROOTS", {root}):
                tree = self.classify([self.wrapper(), self.app_server(), helper])[0]

        self.assertEqual(1, len(tree.blockers))
        self.assertEqual(helper.pid, tree.blockers[0].identity.pid)

    def test_unapproved_tmp_code_mode_host_and_shell_under_mcp_are_blockers(self):
        tmp_host = self.proc(12, 11, "/tmp/codex-code-mode-host", "codex-code-mode-host")
        ordinary_mcp = self.proc(13, 11, "/usr/bin/node", "node chrome-devtools-mcp")
        shell_child = self.proc(14, 13, "/bin/zsh", "zsh -c 'user command'")
        tree = self.classify([self.wrapper(), self.app_server(), tmp_host, ordinary_mcp, shell_child])[0]
        self.assertEqual({"codex-code-mode-host", "node", "zsh"}, {blocker.name for blocker in tree.blockers})
        self.assertEqual({}, tree.helper_family_counts)

    def test_tmp_codex_app_server_descendant_remains_active_work(self):
        tmp_codex = self.proc(
            12, 11, "/tmp/codex", "/tmp/codex app-server --not-a-bundled-runtime",
        )
        tree = self.classify([self.wrapper(), self.app_server(), tmp_codex])[0]

        self.assertEqual(["codex"], [blocker.name for blocker in tree.blockers])
        updated, _state = lifecycle.advance_lifecycle_state([tree], {}, 2_000)
        self.assertEqual("blocked_active_work", updated[0].state)

    def test_new_generation_pid_reuse_corrupt_state_and_clock_reversal_fail_closed(self):
        clean = self.classify([self.wrapper(), self.app_server()])
        first, state = lifecycle.advance_lifecycle_state(clean, {}, 1_000)
        self.assertEqual(1_000, first[0].idle_since)

        reused = self.classify([self.wrapper(birth="wrapper-new"), self.app_server()])
        reset, state = lifecycle.advance_lifecycle_state(reused, state, 1_500)
        self.assertEqual(1_500, reset[0].idle_since)
        self.assertFalse(reset[0].actionable)

        corrupt, _ = lifecycle.advance_lifecycle_state(clean, {"schema_version": 99, "trees": {}}, 2_000)
        backwards, _ = lifecycle.advance_lifecycle_state(clean, state, 1_400)
        self.assertEqual(2_000, corrupt[0].idle_since)
        self.assertEqual(1_400, backwards[0].idle_since)

    def test_nonfinite_or_negative_state_times_never_preserve_or_trigger_eligibility(self):
        clean = self.classify([self.wrapper(), self.app_server()])
        key = clean[0].tree_key
        base_tree = {"generation": clean[0].generation, "idle_since": 0}
        invalid_last_nows = (None, -1, float("nan"), float("inf"))
        for last_now in invalid_last_nows:
            prior = {"schema_version": 1, "last_now": last_now, "trees": {key: base_tree}}
            updated, _state = lifecycle.advance_lifecycle_state(clean, prior, 10_000)
            self.assertEqual("idle_pending", updated[0].state)
            self.assertEqual(10_000, updated[0].idle_since)
            self.assertFalse(updated[0].actionable)

        for idle_since in (-1, float("nan"), float("inf")):
            prior = {
                "schema_version": 1,
                "last_now": 10_000,
                "trees": {key: {"generation": clean[0].generation, "idle_since": idle_since}},
            }
            updated, _state = lifecycle.advance_lifecycle_state(clean, prior, 10_000)
            self.assertEqual("idle_pending", updated[0].state)
            self.assertEqual(10_000, updated[0].idle_since)
            self.assertFalse(updated[0].actionable)

    def test_status_redacts_raw_argv_and_reaper_dry_run_or_identity_drift_never_signals(self):
        processes = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(processes.values())[0]
        updated, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        updated, state = lifecycle.advance_lifecycle_state([tree], state, 1_600)
        status = lifecycle.build_status(updated, generated_at=1_600)
        encoded = json.dumps(status)
        self.assertNotIn("NODE_OPTIONS", encoded)
        self.assertNotIn("raw_argv", encoded)
        self.assertEqual(2, status["schema_version"])
        self.assertEqual("strict-detached-v5", status["cleanup_policy_version"])
        self.assertEqual(lifecycle.MATCHER_REGISTRY_VERSION, status["matcher_registry_version"])
        self.assertEqual("automatic", status["lane_modes"]["exact_standalone_app_server"])
        self.assertEqual("observation_only", status["lane_modes"]["standalone_orphan"])
        self.assertEqual("observation_only", status["lane_modes"]["claude_idle"])
        self.assertEqual("detached_wrapper", status["trees"][0]["lifecycle_lane"])
        self.assertEqual("automatic", status["trees"][0]["lane_mode"])

        signals = []
        snapshots = iter([processes, processes])
        instance = reaper.Reaper(
            dry_run=True,
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_600,
            signal_sender=lambda pid, sig: signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        instance.plan_detached_wrappers(state)
        count, tags = instance.execute_detached()
        self.assertEqual(2, count)
        self.assertEqual({"detached-app-server-tree": 2}, tags)
        self.assertEqual([], signals)

        drifted = dict(processes)
        drifted[11] = self.app_server(birth="app-reused")
        snapshots = iter([processes, drifted])
        instance = reaper.Reaper(
            dry_run=False,
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_600,
            signal_sender=lambda pid, sig: signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        instance.plan_detached_wrappers(state)
        count, _tags = instance.execute_detached()
        self.assertEqual(0, count)
        self.assertEqual([], signals)
        self.assertEqual("partial_failure", instance.lifecycle_trees[0].state)

    def test_proven_mcp_root_and_descendants_remain_in_the_whole_tree_plan(self):
        protected_root = self.proc(
            12, 11, "/usr/bin/npm",
            "npm exec chrome-devtools-mcp --browserUrl http://127.0.0.1:9422",
        )
        protected_child = self.proc(13, 12, "/usr/bin/node", "node chrome child")
        processes = {proc.pid: proc for proc in [self.wrapper(), self.app_server(), protected_root, protected_child]}
        tree = self.classify(processes.values())[0]
        _pending, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, state = lifecycle.advance_lifecycle_state([tree], state, 1_600)
        instance = reaper.Reaper(
            dry_run=True,
            snapshot_provider=lambda: processes,
            clock=lambda: 1_600,
            signal_sender=lambda *_args: self.fail("dry-run must not signal"),
            sleeper=lambda _seconds: self.fail("dry-run must not sleep"),
        )
        instance.plan_detached_wrappers(state)
        planned = instance.detached_plans[tree.tree_key]
        self.assertEqual({10, 11, 12, 13}, set(planned))

    def test_root_identity_change_aborts_before_terminating_or_signal(self):
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        reused = dict(clean)
        reused[10] = self.proc(
            10, 1, "/usr/bin/python3", "python3 /Users/test/private-work.py",
            birth="reused-wrapper",
        )
        snapshots = iter([clean, reused])
        events, signals = [], []
        instance = reaper.Reaper(
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_600,
            signal_sender=lambda pid, sig: (
                signals.append((pid, sig)),
                events.append(("signal", pid, sig)),
            ),
            sleeper=lambda _seconds: None,
            status_writer=lambda _path, payload: events.append(
                ("status", payload["trees"][0]["state"])
            ),
        )
        instance.plan_detached_wrappers(prior)
        signaled, _tags = instance.execute_detached()

        self.assertEqual(0, signaled)
        self.assertEqual([], signals)
        self.assertEqual([], events)
        self.assertEqual("partial_failure", instance.lifecycle_trees[0].state)
        self.assertIn("root or app-server identity changed", instance.lifecycle_trees[0].error or "")

    def test_recognized_mcp_spawned_after_planning_is_boundedly_adopted(self):
        # v5 adopts an exact MCP root that sprouts between plan and TERM so a
        # dying parent cannot leave that helper orphaned.
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        sprouted = dict(clean)
        sprouted[12] = self.proc(
            12, 11, "/usr/bin/npm",
            "npm exec chrome-devtools-mcp --browserUrl http://127.0.0.1:9422",
        )
        snapshots = iter([clean, sprouted, {}, {}])
        signals = []
        instance = reaper.Reaper(
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_600,
            signal_sender=lambda pid, sig: signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        instance.plan_detached_wrappers(prior)
        signaled, _tags = instance.execute_detached()

        self.assertEqual(3, signaled)
        self.assertEqual(
            [(12, reaper.signal.SIGTERM), (11, reaper.signal.SIGTERM), (10, reaper.signal.SIGTERM)],
            signals,
        )
        self.assertEqual("verified_gone", instance.lifecycle_trees[0].state)

    def test_changed_or_exited_non_root_pid_is_skipped_without_widening_the_plan(self):
        helper = self.proc(12, 11, "/usr/bin/npm", "npm exec chrome-devtools-mcp")
        before = {proc.pid: proc for proc in [self.wrapper(), self.app_server(), helper]}
        tree = self.classify(before.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        after = {pid: proc for pid, proc in before.items() if pid != helper.pid}
        receipts, signals = [], []
        instance = reaper.Reaper(
            snapshot_provider=iter([before, after, {}, {}]).__next__, clock=lambda: 1_600,
            signal_sender=lambda pid, sig: signals.append((pid, sig)), sleeper=lambda _seconds: None,
            receipt_writer=lambda _path, payload: receipts.append(payload),
        )
        instance.plan_detached_wrappers(prior)
        signaled, _tags = instance.execute_detached()

        self.assertEqual(2, signaled)
        self.assertEqual([(11, reaper.signal.SIGTERM), (10, reaper.signal.SIGTERM)], signals)
        self.assertEqual([12], receipts[0]["skipped_pids"])
        self.assertEqual("verified_gone", instance.lifecycle_trees[0].state)

    def test_same_identity_survivors_preserve_idle_since_for_bounded_retry(self):
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        writes, receipts = [], []
        instance = reaper.Reaper(
            snapshot_provider=lambda: clean, clock=lambda: 1_600,
            signal_sender=lambda _pid, _sig: None, sleeper=lambda _seconds: None,
            lifecycle_state_writer=lambda _path, payload: writes.append(json.loads(json.dumps(payload))),
            receipt_writer=lambda _path, payload: receipts.append(payload),
        )
        instance.plan_detached_wrappers(prior)
        signaled, _tags = instance.execute_detached()

        self.assertEqual(2, signaled)
        self.assertEqual("partial_failure", instance.lifecycle_trees[0].state)
        self.assertEqual(1_000, writes[-1]["trees"][tree.tree_key]["idle_since"])
        self.assertEqual(1, writes[-1]["trees"][tree.tree_key]["retry_attempts"])
        self.assertEqual(1_000, receipts[0]["retry_idle_since"])
        self.assertEqual(1, receipts[0]["retry_attempt"])

    def test_abort_clears_persisted_timer_and_next_clean_cycle_restarts_grace(self):
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        blocker = self.proc(12, 11, "/usr/bin/tail", "tail -f /tmp/node_repl.log")
        blocked = {**clean, blocker.pid: blocker}
        snapshots = iter([clean, blocked])
        written_states, receipts, signals = [], [], []
        with tempfile.TemporaryDirectory() as directory:
            temp_state = Path(directory) / "state.json"
            temp_receipt = Path(directory) / "receipt.jsonl"
            with mock.patch.object(reaper, "LIFECYCLE_STATE", temp_state), mock.patch.object(reaper, "LIFECYCLE_ACTIONS", temp_receipt):
                instance = reaper.Reaper(
                    snapshot_provider=lambda: next(snapshots), clock=lambda: 1_600,
                    signal_sender=lambda pid, sig: signals.append((pid, sig)), sleeper=lambda _seconds: None,
                    lifecycle_state_writer=lambda path, payload: written_states.append((path, json.loads(json.dumps(payload)))),
                    receipt_writer=lambda path, payload: receipts.append((path, payload)),
                )
                instance.plan_detached_wrappers(prior)
                signaled, _tags = instance.execute_detached()
                self.assertEqual(0, signaled)
                self.assertEqual([], signals)
                self.assertNotIn(tree.tree_key, written_states[-1][1]["trees"])
                self.assertEqual("partial_failure", instance.lifecycle_trees[0].state)
                self.assertFalse(temp_state.exists())
                self.assertFalse(temp_receipt.exists())

                next_instance = reaper.Reaper(
                    dry_run=True, snapshot_provider=lambda: clean, clock=lambda: 1_601,
                    signal_sender=lambda *_args: self.fail("must not signal"), sleeper=lambda _seconds: None,
                )
                restarted = next_instance.plan_detached_wrappers(written_states[-1][1])
                self.assertEqual(1_601, restarted["trees"][tree.tree_key]["idle_since"])

    def test_post_action_last_action_is_swift_compatible_string_and_injected_io_writes_nothing(self):
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        snapshots = iter([clean, clean, {}, {}])
        receipts, state_writes, status_writes, signals = [], [], [], []
        with tempfile.TemporaryDirectory() as directory:
            temp_state = Path(directory) / "state.json"
            temp_receipt = Path(directory) / "receipt.jsonl"
            with mock.patch.object(reaper, "LIFECYCLE_STATE", temp_state), mock.patch.object(reaper, "LIFECYCLE_ACTIONS", temp_receipt):
                instance = reaper.Reaper(
                    snapshot_provider=lambda: next(snapshots), clock=lambda: 1_600,
                    signal_sender=lambda pid, sig: signals.append((pid, sig)), sleeper=lambda _seconds: None,
                    lifecycle_state_writer=lambda path, payload: state_writes.append((path, payload)),
                    receipt_writer=lambda path, payload: receipts.append((path, payload)),
                    status_writer=lambda path, payload: status_writes.append((path, payload)),
                )
                instance.plan_detached_wrappers(prior)
                signaled, _tags = instance.execute_detached()
                self.assertEqual(2, signaled)
                self.assertEqual(2, len(signals))
                self.assertEqual("verified_gone", instance.lifecycle_trees[0].state)
                self.assertIsInstance(instance.lifecycle_trees[0].last_action, str)
                status_tree = lifecycle.build_status(instance.lifecycle_trees)["trees"][0]
                self.assertIsInstance(status_tree["last_action"], str)
                self.assertEqual(receipts[0][1]["action_id"], status_tree["last_verified_action_receipt"])
                self.assertEqual(1, len(receipts))
                self.assertEqual([temp_state], [path for path, _payload in state_writes])
                self.assertEqual("terminating", status_writes[0][1]["trees"][0]["state"])
                self.assertFalse(temp_state.exists())
                self.assertFalse(temp_receipt.exists())


class SoftBlockerLifecycleTests(unittest.TestCase):
    """strict-detached-v5: idle soft blockers stop starving the detached lane."""

    uid = 501
    wrapper_executable = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
    codex_executable = "/Applications/ChatGPT.app/Contents/Resources/codex"

    def proc(self, pid, ppid, executable, args, *, birth=None, age=900, cpu=0.0, state="S", cwd=""):
        return lifecycle.ProcessInfo(
            pid=pid, ppid=ppid, uid=self.uid, rss_kib=1024, state=state,
            age_seconds=age, cpu_seconds=cpu, executable=executable, args=args,
            birth=birth or f"birth-{pid}", cwd=cwd,
        )

    def wrapper(self, ppid=1, *, birth="wrapper-a", age=900):
        return self.proc(
            10, ppid, self.wrapper_executable,
            "node -e require(\"node:child_process\"); Tweakers Codex parent: missing child command; "
            "NODE_OPTIONS=--enable-source-maps stdio: \"inherit\" -- "
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth=birth, age=age,
        )

    def app_server(self, *, birth="app-a"):
        return self.proc(
            11, 10, self.codex_executable,
            f"{self.codex_executable} -c features.code_mode_host=true app-server --analytics-default-enabled",
            birth=birth,
        )

    def unrecognized_node_mcp(self, *, pid=12, cpu=42.0, birth=None):
        return self.proc(
            pid, 11, "/opt/homebrew/bin/node",
            "node /Users/test/gsd-pi/packages/mcp-server/dist/cli.js",
            cpu=cpu, birth=birth,
        )

    def classify(self, processes):
        return lifecycle.classify_codex_trees({proc.pid: proc for proc in processes}, uid=self.uid)

    def test_soft_classification_covers_node_and_mcp_launchers_only(self):
        probes = [
            self.unrecognized_node_mcp(pid=12),
            self.proc(13, 11, "/tmp/node_repl", "/tmp/node_repl --user-job"),
            self.proc(14, 11, "/usr/bin/python3", "python3 /Users/test/serve_mcp.py"),
            self.proc(15, 11, "/usr/bin/python3", "python3 build.py --release"),
            self.proc(16, 11, "/bin/zsh", "zsh -c 'make build'"),
        ]
        tree = self.classify([self.wrapper(), self.app_server(), *probes])[0]
        by_pid = {blocker.identity.pid: blocker for blocker in tree.blockers}

        self.assertEqual({12, 13, 14, 15, 16}, set(by_pid))
        self.assertTrue(by_pid[12].soft)   # unrecognized node MCP
        self.assertTrue(by_pid[13].soft)   # node_repl basename
        self.assertTrue(by_pid[14].soft)   # python launcher mentioning mcp
        self.assertFalse(by_pid[15].soft)  # python without mcp stays hard
        self.assertFalse(by_pid[16].soft)  # shells and builds stay hard
        self.assertEqual("/opt/homebrew/bin/node", by_pid[12].executable)
        self.assertEqual(42.0, by_pid[12].cpu_seconds)
        # The unrecognized-MCP drift cases still surface as matcher drift.
        self.assertEqual(2, len(tree.matcher_drift))
        self.assertEqual(
            {"node", "node_repl"},
            {drift.split(":", 1)[0] for drift in tree.matcher_drift},
        )

    def test_detached_tree_with_idle_unrecognized_node_mcp_counts_down_and_reaps(self):
        processes = {
            proc.pid: proc
            for proc in [self.wrapper(), self.app_server(), self.unrecognized_node_mcp()]
        }
        tree = self.classify(processes.values())[0]
        self.assertEqual("detached", tree.ownership)

        blocked, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        self.assertEqual("blocked_active_work", blocked[0].state)  # fail closed once

        pending, state = lifecycle.advance_lifecycle_state([tree], state, 1_060)
        self.assertEqual("idle_pending", pending[0].state)
        self.assertEqual(600, pending[0].remaining_seconds)

        eligible, state = lifecycle.advance_lifecycle_state([tree], state, 1_660)
        self.assertEqual("eligible", eligible[0].state)
        self.assertTrue(eligible[0].actionable)

        snapshots = iter([processes, processes, {}, {}])
        signals = []
        # Rewind to the persisted pre-eligibility state, as a real cycle would.
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _pending, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_060)
        instance = reaper.Reaper(
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_660,
            signal_sender=lambda pid, sig: signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        instance.plan_detached_wrappers(prior)
        signaled, tags = instance.execute_detached()

        self.assertEqual(3, signaled)
        self.assertEqual({"detached-app-server-tree": 3}, tags)
        self.assertEqual([(12, reaper.signal.SIGTERM), (11, reaper.signal.SIGTERM), (10, reaper.signal.SIGTERM)], signals)
        self.assertEqual("verified_gone", instance.lifecycle_trees[0].state)

    def test_cpu_accruing_zsh_build_remains_hard_blocked(self):
        def build(cpu):
            return self.proc(12, 11, "/bin/zsh", "zsh -c 'cargo build --release'", cpu=cpu)

        tree = self.classify([self.wrapper(), self.app_server(), build(10.0)])[0]
        blocked, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        self.assertEqual("blocked_active_work", blocked[0].state)

        later = self.classify([self.wrapper(), self.app_server(), build(24.0)])[0]
        still_blocked, _state = lifecycle.advance_lifecycle_state([later], state, 1_060)
        self.assertEqual("blocked_active_work", still_blocked[0].state)
        self.assertFalse(later.blockers[0].soft)

    def test_soft_blocker_with_cpu_movement_stays_blocked_until_it_settles(self):
        def snapshot(cpu):
            return [self.wrapper(), self.app_server(), self.unrecognized_node_mcp(cpu=cpu)]

        tree = self.classify(snapshot(10.0))[0]
        _blocked, state = lifecycle.advance_lifecycle_state([tree], {}, 1_000)

        moving = self.classify(snapshot(10.6))[0]
        blocked, state = lifecycle.advance_lifecycle_state([moving], state, 1_060)
        self.assertEqual("blocked_active_work", blocked[0].state)  # +0.6s >= 0.5s

        settled = self.classify(snapshot(10.6))[0]
        pending, state = lifecycle.advance_lifecycle_state([settled], state, 1_120)
        self.assertEqual("idle_pending", pending[0].state)
        self.assertEqual(1_120, pending[0].idle_since)

        drifting = self.classify(snapshot(10.9))[0]
        still_pending, _state = lifecycle.advance_lifecycle_state([drifting], state, 1_180)
        self.assertEqual("idle_pending", still_pending[0].state)  # +0.3s < 0.5s
        self.assertEqual(1_120, still_pending[0].idle_since)
        self.assertEqual(540, still_pending[0].remaining_seconds)

    def test_helper_pid_churn_does_not_reset_the_countdown(self):
        node = str(Path.home() / ".nvm" / "versions" / "node" / "v22.18.0" / "bin" / "node")

        def snapshot(root_pid, child_pid):
            return [
                self.wrapper(),
                self.app_server(),
                self.proc(root_pid, 11, node, "npm exec @playwright/mcp@latest --headless"),
                self.proc(child_pid, root_pid, node, "node /tmp/npm-cache/playwright-mcp --worker"),
            ]

        first = self.classify(snapshot(12, 13))[0]
        self.assertEqual((), first.blockers)
        pending, state = lifecycle.advance_lifecycle_state([first], {}, 1_000)
        self.assertEqual("idle_pending", pending[0].state)
        self.assertEqual(1_000, pending[0].idle_since)

        churned = self.classify(snapshot(24, 25))[0]
        self.assertEqual(first.generation, churned.generation)
        continued, state = lifecycle.advance_lifecycle_state([churned], state, 1_300)
        self.assertEqual("idle_pending", continued[0].state)
        self.assertEqual(1_000, continued[0].idle_since)
        self.assertEqual(300, continued[0].remaining_seconds)

        eligible, _state = lifecycle.advance_lifecycle_state([churned], state, 1_600)
        self.assertEqual("eligible", eligible[0].state)
        self.assertTrue(eligible[0].actionable)

    def test_revalidate_passes_with_idle_soft_blocker_and_aborts_with_an_active_one(self):
        idle = {
            proc.pid: proc
            for proc in [self.wrapper(), self.app_server(), self.unrecognized_node_mcp(cpu=42.0)]
        }
        active = {
            proc.pid: proc
            for proc in [self.wrapper(), self.app_server(), self.unrecognized_node_mcp(cpu=43.0)]
        }
        tree = self.classify(idle.values())[0]
        _blocked, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _pending, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_060)

        signals = []
        snapshots = iter([idle, idle, {}, {}])
        instance = reaper.Reaper(
            snapshot_provider=lambda: next(snapshots),
            clock=lambda: 1_660,
            signal_sender=lambda pid, sig: signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        instance.plan_detached_wrappers(prior)
        signaled, _tags = instance.execute_detached()
        self.assertEqual(3, signaled)
        self.assertEqual("verified_gone", instance.lifecycle_trees[0].state)

        abort_signals = []
        abort_snapshots = iter([idle, active])
        aborting = reaper.Reaper(
            snapshot_provider=lambda: next(abort_snapshots),
            clock=lambda: 1_660,
            signal_sender=lambda pid, sig: abort_signals.append((pid, sig)),
            sleeper=lambda _seconds: None,
        )
        aborting.plan_detached_wrappers(prior)
        signaled, _tags = aborting.execute_detached()
        self.assertEqual(0, signaled)
        self.assertEqual([], abort_signals)
        self.assertEqual("partial_failure", aborting.lifecycle_trees[0].state)
        self.assertIn("no longer an unblocked", aborting.lifecycle_trees[0].error or "")

    def test_old_state_file_without_baselines_loads_cleanly_and_fails_closed_once(self):
        tree = self.classify(
            [self.wrapper(), self.app_server(), self.unrecognized_node_mcp(cpu=42.0)]
        )[0]
        legacy = {
            "schema_version": 1,
            "last_now": 940,
            "trees": {
                tree.tree_key: {
                    "root_identity": tree.root_identity.to_json(),
                    "app_server_identity": tree.app_server_identity.to_json(),
                    "state": "idle_pending",
                    "generation": tree.generation,
                    "idle_since": 900,
                    "eligible_at": 1_500,
                }
            },
        }
        blocked, state = lifecycle.advance_lifecycle_state([tree], legacy, 1_000)
        self.assertEqual("blocked_active_work", blocked[0].state)
        self.assertEqual(1, state["schema_version"])
        baselines = state["trees"][tree.tree_key]["soft_blocker_baselines"]
        self.assertEqual({"12|birth-12": 42.0}, baselines)

        pending, _state = lifecycle.advance_lifecycle_state([tree], state, 1_060)
        self.assertEqual("idle_pending", pending[0].state)
        self.assertEqual(1_060, pending[0].idle_since)


if __name__ == "__main__":
    unittest.main()
