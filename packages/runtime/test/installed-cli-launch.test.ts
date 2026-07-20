import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildTransientLaunchdExitTrap,
  classifyInstalledCliCommand,
  DesktopUpdateLaunchSubmissionError,
  submitInstalledCliWithLaunchd,
} from "../src/installed-cli-launch";

test("installed CLI launch classification marks only desktop-update ownership commands as cutovers", () => {
  assert.deepEqual(classifyInstalledCliCommand(["update-chatgpt", "--json"]), {
    commandKind: "start",
    cutover: true,
  });
  assert.deepEqual(classifyInstalledCliCommand(["update-chatgpt-resume", "--json"]), {
    commandKind: "resume",
    cutover: true,
  });
  assert.deepEqual(classifyInstalledCliCommand(["update-chatgpt-reconcile", "--json"]), {
    commandKind: "reconcile",
    cutover: true,
  });
  assert.deepEqual(classifyInstalledCliCommand(["update-chatgpt-cancel", "--json"]), {
    commandKind: "cancel",
    cutover: false,
  });
  assert.deepEqual(classifyInstalledCliCommand(["refresh-local"]), {
    commandKind: "other",
    cutover: false,
  });
});

test("transient launchd EXIT trap removes or bootouts the label and preserves owner status", () => {
  const fixture = mkdtempSync(join(tmpdir(), "tweakers-launchd-trap-"));
  try {
    const calls = join(fixture, "calls.log");
    const launchctl = join(fixture, "launchctl");
    writeFileSync(
      launchctl,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\n[ "$1" = remove ] && exit 1\nexit 0\n`,
    );
    chmodSync(launchctl, 0o755);

    const script = `${buildTransientLaunchdExitTrap("com.test.job")}\nexit 37`;
    const result = spawnSync("/bin/sh", ["-c", script], {
      env: { ...process.env, PATH: `${fixture}:${process.env.PATH ?? ""}`, CALLS: calls },
      encoding: "utf8",
    });

    assert.equal(result.status, 37);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
      "remove com.test.job",
      `bootout gui/${process.getuid?.() ?? 501}/com.test.job`,
    ]);
    assert.doesNotMatch(script, /\|\|\s*true/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Darwin desktop-update cutovers submit correlated launchd jobs with bounded evidence", () => {
  const events: unknown[] = [];
  const submissions: Array<{ command: string; args: readonly string[]; maxBuffer: number }> = [];
  const submitted = submitInstalledCliWithLaunchd({
    classification: classifyInstalledCliCommand(["update-chatgpt-resume", "--json"]),
    label: "com.test.desktop-update.42",
    cwd: "/tmp/runtime root",
    command: "/tmp/node",
    args: ["/tmp/cli.js", "update-chatgpt-resume", "--json"],
    environment: {
      TWEAKERS_DESKTOP_UPDATE_JOB_LABEL: "com.test.desktop-update.42",
      TWEAKER_MANUAL_UPDATE: "1",
    },
  }, {
    submit: (command, args, options) => {
      submissions.push({ command, args, maxBuffer: options.maxBuffer });
      return { status: 0, stdout: "submitted\n", stderr: "" };
    },
    onEvent: (event) => events.push(event),
  });

  assert.equal(submitted, true);
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0]?.command, "launchctl");
  assert.equal(submissions[0]?.maxBuffer, 64 * 1024);
  const shell = submissions[0]?.args.at(-1) ?? "";
  assert.match(shell, /trap cleanup_transient_launchd_job EXIT/);
  assert.match(shell, /TWEAKERS_DESKTOP_UPDATE_JOB_LABEL='com\.test\.desktop-update\.42'/);
  assert.doesNotMatch(shell, /\|\|\s*true/);
  assert.deepEqual(events, [{
    event: "desktop-update-launch",
    commandKind: "resume",
    jobLabel: "com.test.desktop-update.42",
    submitResult: "submitted",
    status: 0,
  }]);
});

test("failed Darwin cutover submission throws without allowing detached fallback", () => {
  const events: unknown[] = [];
  const launchctlError = `launchd refused the request ${"x".repeat(80_000)}`;
  assert.throws(
    () => submitInstalledCliWithLaunchd({
      classification: classifyInstalledCliCommand(["update-chatgpt-reconcile", "--json"]),
      label: "com.test.desktop-update.43",
      cwd: "/tmp",
      command: "/tmp/node",
      args: ["/tmp/cli.js", "update-chatgpt-reconcile", "--json"],
      environment: { TWEAKERS_DESKTOP_UPDATE_JOB_LABEL: "com.test.desktop-update.43" },
    }, {
      submit: () => ({
        status: 5,
        stdout: "",
        stderr: launchctlError,
      }),
      onEvent: (event) => events.push(event),
    }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopUpdateLaunchSubmissionError);
      assert.equal(error.commandKind, "reconcile");
      assert.equal(error.jobLabel, "com.test.desktop-update.43");
      return true;
    },
  );
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: "desktop-update-launch",
    commandKind: "reconcile",
    jobLabel: "com.test.desktop-update.43",
    submitResult: "failed",
    status: 5,
    error: `${launchctlError.slice(0, 4_095)}…`,
  });
});

test("failed non-cutover submission retains the caller's detached fallback path", () => {
  const submitted = submitInstalledCliWithLaunchd({
    classification: classifyInstalledCliCommand(["watcher-run"]),
    label: "com.test.maintenance.44",
    cwd: "/tmp",
    command: "/tmp/node",
    args: ["/tmp/cli.js", "watcher-run"],
    environment: {},
  }, {
    submit: () => ({ status: 1, stderr: "unavailable" }),
  });

  assert.equal(submitted, false);
});

test("a thrown launchctl process error is recorded and normalized to the typed cutover failure", () => {
  const events: unknown[] = [];
  assert.throws(
    () => submitInstalledCliWithLaunchd({
      classification: classifyInstalledCliCommand(["update-chatgpt", "--json"]),
      label: "com.test.desktop-update.45",
      cwd: "/tmp",
      command: "/tmp/node",
      args: ["/tmp/cli.js", "update-chatgpt", "--json"],
      environment: {},
    }, {
      submit: () => {
        throw new Error("spawn unavailable");
      },
      onEvent: (event) => events.push(event),
    }),
    DesktopUpdateLaunchSubmissionError,
  );
  assert.deepEqual(events, [{
    event: "desktop-update-launch",
    commandKind: "start",
    jobLabel: "com.test.desktop-update.45",
    submitResult: "failed",
    status: null,
    error: "spawn unavailable",
  }]);
});
