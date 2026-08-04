from __future__ import annotations

import importlib.util
import json
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


def guard_proc(
    pid: int,
    ppid: int,
    args: str,
    *,
    comm: str = "node",
    rss_kib: int = 1024,
    state: str = "S",
    age: int = 7200,
):
    return guard.Proc(pid, ppid, rss_kib, state, age, comm, args)


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
        gp = guard_proc(100, 50, args, comm="/Users/test/.local/bin/codex")
        rp = reaper_proc(100, 50, args, comm="/Users/test/.local/bin/codex")

        self.assertTrue(guard.is_codex_appserver(gp))
        self.assertTrue(reaper.is_codex_appserver(rp))

    def test_wrapper_text_is_not_mistaken_for_app_server(self):
        args = "node -e wrapper -- /Users/test/.local/bin/codex -c x=y app-server"
        gp = guard_proc(100, 50, args, comm="node")
        rp = reaper_proc(100, 50, args, comm="node")

        self.assertFalse(guard.is_codex_appserver(gp))
        self.assertFalse(reaper.is_codex_appserver(rp))

    def test_direct_chrome_runtime_is_recognized(self):
        args = (
            "/opt/node /tmp/runtime/node_modules/chrome-devtools-mcp/"
            "build/src/bin/chrome-devtools-mcp.js --headless=true"
        )
        gp = guard_proc(110, 100, args, comm="/opt/node")
        rp = reaper_proc(110, 100, args, comm="/opt/node")

        self.assertTrue(guard.is_chrome_devtools_mcp_root(gp.args))
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


class StatusCounterTests(unittest.TestCase):
    def fixture_for_guard(self):
        return {
            p.pid: p
            for p in (
                guard_proc(400, 50, "codex -c x=y app-server", comm="/opt/codex", rss_kib=50000),
                guard_proc(401, 400, "/opt/cua_node/bin/node_repl", comm="/opt/cua_node/bin/node_repl"),
                guard_proc(
                    402,
                    400,
                    "/opt/node /tmp/runtime/node_modules/chrome-devtools-mcp/"
                    "build/src/bin/chrome-devtools-mcp.js",
                    comm="/opt/node",
                ),
                guard_proc(403, 402, "<defunct>", comm="<defunct>", rss_kib=0, state="Z"),
                guard_proc(404, 400, "node context7-app-compat", rss_kib=2048),
                guard_proc(410, 1, "/opt/cua_node/bin/node_repl", comm="/opt/cua_node/bin/node_repl", age=4000),
            )
        }

    def test_guard_pressure_status_is_truthful_and_observation_only(self):
        counts, _warnings = guard.inspect_process_pressure(
            self.fixture_for_guard(), swap_usage_reader=lambda: None,
        )

        self.assertEqual(1, counts["loaded_task_stacks"])
        self.assertEqual(1, counts["chrome_zombies"])
        self.assertEqual(2, counts["node_repls"])
        self.assertEqual(5, counts["mcp_rss_mib"])
        self.assertEqual(1, counts["actionable_orphans"])
        self.assertEqual(1, counts["chrome_wrappers"])
        self.assertEqual(0, counts["would_kill"])
        self.assertEqual(0, counts["killed_pids"])


class GuardPressureSignalTests(unittest.TestCase):
    """Machine-wide swap and helper-count pressure signals (notification-only)."""

    def fixture_with_helper_tree(self):
        return {
            p.pid: p
            for p in (
                guard_proc(400, 50, "codex -c x=y app-server", comm="/opt/codex"),
                guard_proc(
                    500,
                    400,
                    "/opt/node /tmp/runtime/node_modules/chrome-devtools-mcp/"
                    "build/src/bin/chrome-devtools-mcp.js",
                    comm="/opt/node",
                ),
                guard_proc(501, 500, "node helper-a"),
                guard_proc(502, 500, "node helper-b"),
                guard_proc(503, 502, "node helper-grandchild"),
            )
        }

    def test_read_swap_usage_parses_sysctl_and_handles_absence(self):
        def runner_for(stdout, returncode=0):
            def runner(argv, **_kwargs):
                self.assertEqual(["sysctl", "-n", "vm.swapusage"], argv)
                return mock.Mock(returncode=returncode, stdout=stdout, stderr="")

            return runner

        parsed = guard.read_swap_usage(
            runner_for("total = 2048.00M  used = 1017.12M  free = 1030.88M  (encrypted)\n")
        )
        self.assertIsNotNone(parsed)
        used_mib, total_mib = parsed
        self.assertAlmostEqual(1017.12, used_mib, places=2)
        self.assertAlmostEqual(2048.0, total_mib, places=2)

        scaled = guard.read_swap_usage(
            runner_for("vm.swapusage: total = 4.00G  used = 3.00G  free = 1.00G\n")
        )
        self.assertEqual((3072.0, 4096.0), scaled)

        self.assertIsNone(guard.read_swap_usage(runner_for("")))
        self.assertIsNone(guard.read_swap_usage(runner_for("no swap counters here")))
        self.assertIsNone(guard.read_swap_usage(runner_for("total = 0.00M  used = 0.00M  free = 0.00M")))
        self.assertIsNone(guard.read_swap_usage(runner_for("total = 2048.00M  used = 10.00M", returncode=1)))

        def missing_sysctl(_argv, **_kwargs):
            raise FileNotFoundError("sysctl not found")

        self.assertIsNone(guard.read_swap_usage(missing_sysctl))

    def test_swap_pressure_signal_reports_measured_values_above_threshold_only(self):
        table = self.fixture_with_helper_tree()

        counts, warnings = guard.inspect_process_pressure(
            table, swap_usage_reader=lambda: (1536.0, 2048.0),
        )
        self.assertEqual(1536, counts["swap_used_mib"])
        self.assertEqual(2048, counts["swap_total_mib"])
        self.assertEqual(75, counts["swap_used_pct"])
        swap_warnings = [w for w in warnings if w.startswith(f"{guard.SWAP_PRESSURE_SIGNAL_ID}:")]
        self.assertEqual(1, len(swap_warnings))
        self.assertIn("1536 MiB", swap_warnings[0])
        self.assertIn("2048 MiB", swap_warnings[0])
        self.assertIn("75%", swap_warnings[0])
        self.assertIn(f"{guard.SWAP_PRESSURE_PCT}% threshold", swap_warnings[0])

        _counts, at_threshold = guard.inspect_process_pressure(
            table, swap_usage_reader=lambda: (1024.0, 2048.0),
        )
        self.assertEqual(
            [], [w for w in at_threshold if w.startswith(f"{guard.SWAP_PRESSURE_SIGNAL_ID}:")]
        )

        absent_counts, absent = guard.inspect_process_pressure(
            table, swap_usage_reader=lambda: None,
        )
        self.assertNotIn("swap_used_pct", absent_counts)
        self.assertEqual(
            [], [w for w in absent if w.startswith(f"{guard.SWAP_PRESSURE_SIGNAL_ID}:")]
        )

    def test_helper_count_pressure_reuses_process_tree_accounting(self):
        table = self.fixture_with_helper_tree()

        with mock.patch.object(guard, "HELPER_PRESSURE_COUNT", 3):
            counts, warnings = guard.inspect_process_pressure(
                table, swap_usage_reader=lambda: None,
            )
        self.assertEqual(4, counts["mcp_helper_processes"])
        helper_warnings = [
            w for w in warnings if w.startswith(f"{guard.HELPER_PRESSURE_SIGNAL_ID}:")
        ]
        self.assertEqual(1, len(helper_warnings))
        self.assertIn("4 MCP helper processes", helper_warnings[0])
        self.assertIn("3-process threshold", helper_warnings[0])

        with mock.patch.object(guard, "HELPER_PRESSURE_COUNT", 4):
            _counts, at_threshold = guard.inspect_process_pressure(
                table, swap_usage_reader=lambda: None,
            )
        self.assertEqual(
            [], [w for w in at_threshold if w.startswith(f"{guard.HELPER_PRESSURE_SIGNAL_ID}:")]
        )

    def test_pressure_signals_reach_the_guard_status_heartbeat(self):
        with mock.patch.object(guard, "HELPER_PRESSURE_COUNT", 3):
            counts, warnings = guard.inspect_process_pressure(
                self.fixture_with_helper_tree(),
                swap_usage_reader=lambda: (1536.0, 2048.0),
            )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "guard-status.json"
            guard.write_guard_status(counts, warnings, None, path=path, generated_at=1_000)
            payload = json.loads(path.read_text())

        signal_ids = {signal.split(":", 1)[0] for signal in payload["pressure_signals"]}
        self.assertIn(guard.SWAP_PRESSURE_SIGNAL_ID, signal_ids)
        self.assertIn(guard.HELPER_PRESSURE_SIGNAL_ID, signal_ids)
        self.assertEqual(4, payload["counts"]["mcp_helper_processes"])
        self.assertEqual(75, payload["counts"]["swap_used_pct"])
        self.assertEqual("notification-only", payload["authority"])

    def test_pressure_thresholds_are_env_overridable(self):
        with mock.patch.dict(
            "os.environ",
            {
                "CODEX_GUARD_SWAP_PRESSURE_PCT": "90",
                "CODEX_GUARD_HELPER_PRESSURE_COUNT": "7",
            },
        ):
            override = load_script("codex_mcp_guard_env_override_under_test", "codex-mcp-guard.py")
        self.assertEqual(90, override.SWAP_PRESSURE_PCT)
        self.assertEqual(7, override.HELPER_PRESSURE_COUNT)


class GuardLifecycleStatusTests(unittest.TestCase):
    def valid_status(
        self,
        *,
        generated_at=1_000,
        state="blocked_active_work",
        schema_version=1,
        ownership="detached",
        computer_use=27,
    ):
        return {
            "schema_version": schema_version,
            "generated_at": generated_at,
            "job": {"ok": True, "mode": "dry_run", "error": None},
            "counts": {
                "would_kill": 0,
                "detached_trees": 1 if ownership == "detached" else 0,
            },
            "helper_family_counts": {"computer_use": computer_use},
            "trees": [{
                "tree_key": "wrapper:10@birth-a/app:11@birth-b",
                "root_identity": {
                    "pid": 10,
                    "birth": "birth-a",
                    "executable": "/opt/codex-wrapper",
                    "command_shape": "codex-wrapper",
                },
                "app_server_identity": {
                    "pid": 11,
                    "birth": "birth-b",
                    "executable": "/opt/codex",
                    "command_shape": "codex app-server",
                },
                "ownership": ownership,
                "state": state,
                "actionable": False,
                "blockers": [{
                    "identity": {
                        "pid": 12,
                        "birth": "birth-c",
                        "executable": "/usr/bin/python3",
                        "command_shape": "python user command",
                    },
                    "name": "inventory reconcile",
                    "command_summary": "object_storage_inventory_reconcile.py --apply",
                }],
                "idle_since": None,
                "eligible_at": None,
                "remaining_seconds": None,
                "helper_family_counts": {"computer_use": computer_use},
                "rss_kib": 2048,
                "last_action": None,
                "error": None,
            }],
        }

    def write_status(self, payload):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / "status.json"
        path.write_text(json.dumps(payload))
        self.addCleanup(directory.cleanup)
        return path

    def test_guard_loads_current_schema_and_rejects_corrupt_or_stale_status(self):
        payload = self.valid_status()
        loaded, error = guard.load_lifecycle_status(self.write_status(payload), now=1_100)
        self.assertEqual(payload, loaded)
        self.assertIsNone(error)

        payload_v2 = self.valid_status(schema_version=2)
        loaded, error = guard.load_lifecycle_status(self.write_status(payload_v2), now=1_100)
        self.assertEqual(payload_v2, loaded)
        self.assertIsNone(error)

        corrupt = self.write_status({"schema_version": 99})
        loaded, error = guard.load_lifecycle_status(corrupt, now=1_100)
        self.assertIsNone(loaded)
        self.assertIn("schema mismatch", error or "")

        stale = self.valid_status(generated_at=1)
        loaded, error = guard.load_lifecycle_status(self.write_status(stale), now=10_000)
        self.assertEqual(stale, loaded)
        self.assertIn("stale", error or "")

    def test_guard_lifecycle_events_are_state_keyed_and_never_leak_raw_argv(self):
        payload = self.valid_status()
        payload["trees"][0]["blockers"][0]["raw_argv"] = "super-secret --token=do-not-display"
        events = guard.lifecycle_notification_events(payload)

        self.assertEqual(1, len(events))
        self.assertIn("blocked_active_work", events[0].key)
        self.assertIn("inventory reconcile", events[0].message)
        self.assertNotIn("super-secret", events[0].message)
        self.assertNotIn("super-secret", repr(events[0]))

        payload["trees"][0]["state"] = "idle_pending"
        changed = guard.lifecycle_notification_events(payload)
        self.assertNotEqual(events[0].key, changed[0].key)

    def test_ui_owned_pressure_escalates_without_claiming_cleanup_authority(self):
        below = self.valid_status(
            state="observed",
            ownership="ui_owned",
            computer_use=guard.COMPUTER_USE_WARN,
        )
        self.assertEqual([], guard.lifecycle_notification_events(below))

        warning = self.valid_status(
            state="observed",
            ownership="ui_owned",
            computer_use=guard.COMPUTER_USE_WARN + 1,
        )
        warning_events = guard.lifecycle_notification_events(warning)
        self.assertEqual(1, len(warning_events))
        self.assertIn("ui-pressure:warning", warning_events[0].key)

        critical = self.valid_status(
            state="observed",
            ownership="ui_owned",
            computer_use=guard.COMPUTER_USE_CRITICAL,
        )
        critical_events = guard.lifecycle_notification_events(critical)
        self.assertEqual(1, len(critical_events))
        self.assertIn("ui-pressure:critical", critical_events[0].key)
        self.assertNotEqual(warning_events[0].key, critical_events[0].key)
        self.assertIn("notification-only", critical_events[0].message)
        self.assertIn("will not send process signals", critical_events[0].message)
        self.assertNotIn("eligible", critical_events[0].message)

        critical["trees"][0]["state"] = "partial_failure"
        critical["trees"][0]["error"] = "classification failed"
        failure_events = guard.lifecycle_notification_events(critical)
        self.assertEqual(1, len(failure_events))
        self.assertEqual("Codex MCP lifecycle failure", failure_events[0].title)

    def test_valid_lifecycle_status_suppresses_duplicate_generic_computer_use_warning(self):
        proc_table = {
            proc.pid: proc
            for proc in (
                guard_proc(400, 50, "codex -c x=y app-server", comm="/opt/codex"),
                guard_proc(401, 400, "/opt/SkyComputerUseClient --stdio"),
                guard_proc(402, 400, "/opt/SkyComputerUseClient --stdio"),
                guard_proc(403, 400, "/opt/SkyComputerUseClient --stdio"),
            )
        }
        status = self.valid_status(
            state="observed",
            ownership="ui_owned",
            computer_use=3,
        )

        counts, warnings = guard.inspect_process_pressure(
            proc_table, status, swap_usage_reader=lambda: None,
        )

        self.assertEqual(3, counts["computer_use_helpers"])
        self.assertEqual([], warnings)

    def test_quiet_notifies_but_no_notify_and_cooldown_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "notifications.json"
            notify_script = Path(directory) / "notify"
            notify_script.write_text("#!/bin/sh\n")
            calls = []

            def runner(argv, **_kwargs):
                calls.append(argv)
                return mock.Mock(returncode=0, stdout="", stderr="")

            sent = guard.maybe_notify(
                "lifecycle:v1:tree:blocked_active_work",
                "Detached Codex runtime protected",
                "protected by user work",
                quiet=True,
                now=7_200,
                runner=runner,
                state_path=state_path,
                notify_script=notify_script,
            )
            self.assertEqual("sent", sent)
            self.assertEqual(1, len(calls))

            disabled = guard.maybe_notify(
                "another-key", "ignored", "ignored", no_notify=True,
                now=7_201, runner=runner, state_path=state_path, notify_script=notify_script,
            )
            self.assertEqual("disabled", disabled)
            self.assertEqual(1, len(calls))

            cooldown = guard.maybe_notify(
                "lifecycle:v1:tree:blocked_active_work", "same", "same",
                now=7_201, runner=runner, state_path=state_path, notify_script=notify_script,
            )
            self.assertEqual("cooldown", cooldown)
            self.assertEqual(1, len(calls))

            transition = guard.maybe_notify(
                "lifecycle:v1:tree:eligible", "eligible", "starting",
                now=7_201, runner=runner, state_path=state_path, notify_script=notify_script,
            )
            self.assertEqual("sent", transition)
            self.assertEqual(2, len(calls))

    def test_notification_failure_does_not_create_a_cooldown_record(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "notifications.json"
            notify_script = Path(directory) / "notify"
            notify_script.write_text("#!/bin/sh\n")
            outcome = guard.maybe_notify(
                "lifecycle:v1:tree:partial_failure", "failed", "inspect",
                now=7_200,
                runner=lambda *_args, **_kwargs: mock.Mock(returncode=1, stdout="", stderr="boom"),
                state_path=state_path,
                notify_script=notify_script,
            )
            self.assertEqual("failed", outcome)
            self.assertFalse(state_path.exists())

    def test_guard_heartbeat_is_atomic_notification_only_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "guard-status.json"
            guard.write_guard_status(
                {"app_servers": 1, "would_kill": 0},
                ["context7 pressure"],
                "status path /Users/example/private",
                path=path,
                generated_at=1_000,
            )
            payload = json.loads(path.read_text())

        self.assertEqual(1, payload["schema_version"])
        self.assertEqual("0.3.1", payload["producer_version"])
        self.assertEqual("notification-only-v2", payload["policy_version"])
        self.assertEqual("notification-only", payload["authority"])
        self.assertEqual("observation", payload["job"]["mode"])
        self.assertEqual(["context7 pressure"], payload["pressure_signals"])
        self.assertNotIn("/Users/example", payload["lifecycle_status_error"])
        self.assertNotIn("actionable", json.dumps(payload))
        redacted = guard._redact_watcher_text(
            "Bearer secret --token=hidden sk-proj-abcdefghijk /Users/example/private",
            Path("/Users/example"),
        )
        self.assertNotIn("secret", redacted)
        self.assertNotIn("hidden", redacted)
        self.assertNotIn("abcdefghijk", redacted)
        self.assertNotIn("/Users/example", redacted)

    def test_watcher_snapshot_has_three_private_entries_and_updates_last_known_good(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / "home"
            root = home / "Library" / "Application Support" / "codex-plusplus"
            agents = home / "Library" / "LaunchAgents"
            lifecycle_dir = home / ".codex" / "tmp"
            for label in (
                "com.therealityreport.tweakers.watcher",
                "com.thomashulihan.codex-mcp-idle-reaper",
                "com.thomashulihan.codex-mcp-guard",
            ):
                agents.mkdir(parents=True, exist_ok=True)
                (agents / f"{label}.plist").write_text("<plist />")
            root.mkdir(parents=True, exist_ok=True)
            lifecycle_dir.mkdir(parents=True, exist_ok=True)
            root.joinpath("auto-repair-state.json").write_text(json.dumps({
                "schemaVersion": 1,
                "latestCompletedCycle": {
                    "schemaVersion": 1,
                    "completedAt": "1970-01-01T00:16:40Z",
                    "outcome": "completed",
                    "repair": {"status": "succeeded", "error": None},
                },
            }))
            lifecycle_dir.joinpath("codex-mcp-lifecycle-status.json").write_text(json.dumps({
                "schema_version": 2,
                "generated_at": 1_000,
                "cleanup_policy_version": "strict-detached-v3",
                "job": {"ok": True, "error": None},
            }))
            guard_status = lifecycle_dir / "codex-mcp-guard-status.json"
            guard.write_guard_status({}, [], None, path=guard_status, generated_at=1_000)
            current = root / "watcher-health.json"
            last_known_good = root / "watcher-health.last-known-good.json"
            current.write_text("{}")
            current.chmod(0o644)

            snapshot = guard.publish_watcher_health_snapshot(
                path=current,
                last_known_good_path=last_known_good,
                tweakers_root=root,
                home_directory=home,
                guard_status_path=guard_status,
                checked_at=1_005,
                launchd_state=lambda _label: {"loaded": True, "running": False, "lastExitCode": 0},
            )

            self.assertEqual("tweakers.health.v1", snapshot["schema"])
            self.assertEqual(1, snapshot["schemaVersion"])
            self.assertEqual(
                ["tweakers-repair", "mcp-lifecycle-reaper", "mcp-pressure-guard"],
                [entry["id"] for entry in snapshot["watchers"]],
            )
            self.assertEqual("ok", snapshot["status"])
            self.assertTrue(all(entry["status"] == "ok" for entry in snapshot["watchers"]))
            self.assertTrue(all(entry["installedPath"].startswith("~") for entry in snapshot["watchers"]))
            self.assertEqual(0o600, current.stat().st_mode & 0o777)
            self.assertEqual(0o600, last_known_good.stat().st_mode & 0o777)
            original_last_known_good = last_known_good.read_text()
            root.joinpath("auto-repair-state.json").write_text(json.dumps({
                "schemaVersion": 1,
                "latestCompletedCycle": {
                    "schemaVersion": 1,
                    "completedAt": "1970-01-01T00:16:40Z",
                    "outcome": "failed",
                    "repair": {"status": "failed", "error": "/Users/test/private --token=hidden"},
                },
            }))
            failed = guard.publish_watcher_health_snapshot(
                path=current,
                last_known_good_path=last_known_good,
                tweakers_root=root,
                home_directory=home,
                guard_status_path=guard_status,
                checked_at=1_005,
                launchd_state=lambda _label: {"loaded": True, "running": False, "lastExitCode": 0},
            )
            repair = failed["watchers"][0]
            self.assertEqual("error", repair["status"])
            self.assertNotIn("/Users/test", repair["error"])
            self.assertNotIn("hidden", repair["error"])
            self.assertEqual(original_last_known_good, last_known_good.read_text())

    def test_watcher_snapshot_rejects_corrupt_or_schema_less_evidence_and_redacts_policy(self):
        self.assertIsNone(guard._iso8601(float("nan")))
        self.assertIsNone(guard._iso8601(float("inf")))
        self.assertIsNone(guard._iso8601("999999999999999999999999999999-01-01T00:00:00Z"))
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            non_utf8 = base / "non-utf8.json"
            non_utf8.write_bytes(b"\xff\xfe")
            self.assertIsNone(guard._read_json_object(non_utf8))
            missing_repair = guard._repair_watcher_status(
                base / "missing-repair.json", home_directory=base, read_json=guard._read_json_object,
            )
            self.assertIn("missing", missing_repair["error"])
            wrong_repair = base / "wrong-repair.json"
            wrong_repair.write_text(json.dumps({"schemaVersion": 99}))
            self.assertIn(
                "unsupported",
                guard._repair_watcher_status(
                    wrong_repair, home_directory=base, read_json=guard._read_json_object,
                )["error"],
            )

            home = base / "home"
            root = home / "Library" / "Application Support" / "codex-plusplus"
            agents = home / "Library" / "LaunchAgents"
            lifecycle_dir = home / ".codex" / "tmp"
            for label in (
                "com.therealityreport.tweakers.watcher",
                "com.thomashulihan.codex-mcp-idle-reaper",
                "com.thomashulihan.codex-mcp-guard",
            ):
                agents.mkdir(parents=True, exist_ok=True)
                (agents / f"{label}.plist").write_text("<plist />")
            root.mkdir(parents=True, exist_ok=True)
            lifecycle_dir.mkdir(parents=True, exist_ok=True)
            root.joinpath("auto-repair-state.json").write_text(json.dumps({
                "schemaVersion": 1,
                "latestCompletedCycle": {
                    "schemaVersion": 1,
                    "completedAt": "1970-01-01T00:16:40Z",
                    "outcome": "completed",
                    "repair": {"status": "succeeded", "error": None},
                },
            }))
            lifecycle_dir.joinpath("codex-mcp-lifecycle-status.json").write_text(json.dumps({
                "generated_at": 1_000,
                "policyVersion": f"{home}/private Bearer secret --token=hidden {('x' * 600)}",
                "job": {"ok": True, "error": None},
            }))
            guard_status = lifecycle_dir / "codex-mcp-guard-status.json"
            guard_status.write_text(json.dumps({
                "schema_version": 99,
                "generated_at": 1_000,
                "job": {"ok": True, "error": None},
            }))

            snapshot = guard.build_watcher_health_snapshot(
                tweakers_root=root,
                home_directory=home,
                guard_status_path=guard_status,
                checked_at=1_005,
                launchd_state=lambda _label: {"loaded": True, "running": False, "lastExitCode": 0},
            )

            reaper = snapshot["watchers"][1]
            pressure_guard = snapshot["watchers"][2]
            self.assertEqual("unsupported", reaper["freshness"])
            self.assertEqual("error", reaper["status"])
            self.assertEqual("error", pressure_guard["status"])
            rendered = json.dumps(snapshot)
            self.assertNotIn(str(home), rendered)
            self.assertNotIn("secret", rendered)
            self.assertNotIn("hidden", rendered)
            self.assertNotIn("x" * 513, rendered)

    def test_watcher_snapshot_failure_does_not_change_guard_exit_result(self):
        counts = {"app_servers": 0}
        args = mock.Mock(scope="process-only", quiet=True, dry_run=False, no_notify=True)
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(guard, "TMP_DIR", Path(directory)), \
             mock.patch.object(guard, "parse_args", return_value=args), \
             mock.patch.object(guard, "load_lifecycle_status", return_value=(None, None)), \
             mock.patch.object(guard, "load_processes", return_value={}), \
             mock.patch.object(guard, "inspect_process_pressure", return_value=(counts, [])), \
             mock.patch.object(guard, "write_guard_status") as heartbeat:
            result = guard.main(publisher=lambda: (_ for _ in ()).throw(OSError("/Users/test/private --token=hidden")))

        self.assertEqual(0, result)
        heartbeat.assert_called_once()

    def test_watcher_snapshot_is_degraded_without_status_evidence_and_preserves_last_known_good(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            home = base / "home"
            root = home / "Library" / "Application Support" / "codex-plusplus"
            root.mkdir(parents=True)
            current = root / "watcher-health.json"
            last_known_good = root / "watcher-health.last-known-good.json"
            sentinel = {"schema": "tweakers.health.v1", "status": "ok", "watchers": []}
            last_known_good.write_text(json.dumps(sentinel))

            snapshot = guard.publish_watcher_health_snapshot(
                path=current,
                last_known_good_path=last_known_good,
                tweakers_root=root,
                home_directory=home,
                checked_at=1_005,
                launchd_state=lambda _label: {"loaded": False, "running": False, "lastExitCode": None},
            )

            self.assertEqual("error", snapshot["status"])
            self.assertEqual(3, len(snapshot["watchers"]))
            self.assertTrue(all(entry["status"] == "error" for entry in snapshot["watchers"]))
            self.assertNotIn(str(home), json.dumps(snapshot))
            self.assertEqual(sentinel, json.loads(last_known_good.read_text()))

    def test_reaper_status_reports_targets_without_counting_live_stacks(self):
        procs = [
            reaper_proc(500, 50, "codex -c x=y app-server", comm="/opt/codex", rss_kib=50000),
            reaper_proc(501, 500, "/opt/cua_node/bin/node_repl", comm="/opt/cua_node/bin/node_repl"),
            reaper_proc(
                502,
                500,
                "/opt/node /tmp/runtime/node_modules/chrome-devtools-mcp/"
                "build/src/bin/chrome-devtools-mcp.js",
                comm="/opt/node",
            ),
            reaper_proc(503, 502, "<defunct>", comm="<defunct>", rss_kib=0, state="Z"),
            reaper_proc(504, 502, "node chrome-child", rss_kib=2048),
            reaper_proc(510, 1, "npm exec @decodo/mcp-server", comm="npm", age=500),
        ]
        with mock.patch.object(reaper, "load_procs", return_value={p.pid: p for p in procs}):
            instance = reaper.Reaper(dry_run=True)
        instance.reap_orphans()

        counts = reaper.status_counts(instance)

        self.assertEqual(1, counts["loaded_task_stacks"])
        self.assertEqual(1, counts["chrome_zombies"])
        self.assertEqual(1, counts["node_repls"])
        self.assertEqual(0, counts["actionable_orphans"])
        self.assertEqual(1, counts["observed_standalone_orphans"])
        self.assertEqual(0, counts["would_kill"])
        self.assertEqual(5, counts["mcp_rss_mib"])


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
        self.assertEqual("strict-detached-v4", status["cleanup_policy_version"])
        self.assertEqual("mcp-family-descriptors-v4", status["matcher_registry_version"])
        self.assertEqual("automatic", status["lane_modes"]["exact_standalone_app_server"])
        self.assertEqual("observation_only", status["lane_modes"]["standalone_orphan"])
        self.assertEqual("observation_only", status["lane_modes"]["claude_idle"])

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

    def test_each_signal_revalidates_identity_and_publishes_terminating_first(self):
        clean = {proc.pid: proc for proc in [self.wrapper(), self.app_server()]}
        tree = self.classify(clean.values())[0]
        _pending, prior = lifecycle.advance_lifecycle_state([tree], {}, 1_000)
        _eligible, prior = lifecycle.advance_lifecycle_state([tree], prior, 1_600)
        reused = dict(clean)
        reused[10] = self.proc(
            10, 1, "/usr/bin/python3", "python3 /Users/test/private-work.py",
            birth="reused-wrapper",
        )
        snapshots = iter([clean, clean, clean, reused])
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
        self.assertEqual([(11, reaper.signal.SIGTERM)], signals)
        self.assertEqual(("status", "terminating"), events[0])
        self.assertEqual("partial_failure", instance.lifecycle_trees[0].state)
        self.assertIn("immediately before TERM", instance.lifecycle_trees[0].error or "")

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
        snapshots = iter([clean, clean, clean, clean, {}, {}])
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
    """strict-detached-v4: idle soft blockers stop starving the detached lane."""

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

        snapshots = iter([processes] * 5 + [{}, {}])
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
        snapshots = iter([idle] * 5 + [{}, {}])
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
