import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  codexMainProcessObservationFromReport,
  observeCodexMainProcess,
  openCodex,
  quitCodexMainProcess,
  requestCodexNativeUpdate,
  setAlertExecFileSyncForTest,
  showPatchFailedAlert,
  showUpdateModePausedAlert,
} from "../src/alerts";

interface RecordedExecCall {
  command: string;
  args: readonly string[];
  options: unknown;
}

function installExecSpy(): { calls: RecordedExecCall[]; restore: () => void } {
  const calls: RecordedExecCall[] = [];
  const restore = setAlertExecFileSyncForTest(
    ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      return "button returned:Dismiss\n";
    }) as typeof execFileSync,
  );
  return { calls, restore };
}

function withEnv(values: Record<string, string | undefined>, callback: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function scriptFrom(call: RecordedExecCall): string {
  assert.equal(call.command, "osascript");
  assert.equal(call.args[0], "-e");
  assert.equal(typeof call.args[1], "string");
  return call.args[1];
}

test("watcher patch failure uses a non-blocking notification", () => {
  const { calls, restore } = installExecSpy();
  try {
    withEnv(
      { TWEAKER_WATCHER: "1", XPC_SERVICE_NAME: undefined },
      () => showPatchFailedAlert("window services hook point not found"),
    );

    assert.equal(calls.length, 1);
    const script = scriptFrom(calls[0]);
    assert.match(
      script,
      /display notification "Codex was updated, but Tweakers could not reapply itself automatically\." with title "Tweakers could not patch Codex"/,
    );
    assert.doesNotMatch(script, /display alert/);
    assert.doesNotMatch(script, /as critical/);
  } finally {
    restore();
  }
});

test("watcher app-management failure also uses a non-blocking notification", () => {
  const { calls, restore } = installExecSpy();
  try {
    withEnv(
      { TWEAKER_WATCHER: "1", XPC_SERVICE_NAME: undefined },
      () => showPatchFailedAlert("macOS App Management is blocking modification of /Applications/Codex.app."),
    );

    assert.equal(calls.length, 1);
    const script = scriptFrom(calls[0]);
    assert.match(
      script,
      /display notification "Run \\"tweaker repair\\" in your terminal\." with title "Tweakers needs app repair"/,
    );
    assert.doesNotMatch(script, /display alert/);
    assert.doesNotMatch(script, /as critical/);
  } finally {
    restore();
  }
});

test(
  "interactive patch failure keeps the blocking critical modal",
  { skip: process.platform !== "darwin" },
  () => {
    const { calls, restore } = installExecSpy();
    const errorMessage = "window services hook point not found";
    try {
      withEnv(
        { TWEAKER_WATCHER: undefined, XPC_SERVICE_NAME: undefined },
        () => showPatchFailedAlert(errorMessage),
      );

      assert.equal(calls.length, 1);
      const call = calls[0];
      const script = scriptFrom(call);
      assert.match(script, /display alert alertTitle message alertMessage/);
      assert.match(script, /set alertButtons to \{"Dismiss", "Report on GitHub"\}/);
      assert.match(script, /default button "Dismiss"/);
      assert.match(script, /as critical/);
      const options = call.options as { env?: Record<string, string | undefined> };
      assert.equal(options.env?.TWEAKER_ALERT_TITLE, "Tweakers could not patch Codex");
      assert.equal(
        options.env?.TWEAKER_ALERT_MESSAGE,
        "Codex was updated, but Tweakers could not reapply itself automatically.\n\n" +
          `${errorMessage}\n\n` +
          "Run tweaker repair from Terminal after Codex finishes updating, or report this failure on GitHub.",
      );
    } finally {
      restore();
    }
  },
);

test("environment readiness accepts a proved visible window even when it is inactive", () => {
  assert.deepEqual(codexMainProcessObservationFromReport({
    status: "inactive",
    pid: 71,
    relatedPids: [71],
    hasMainProcess: true,
    visibleWindow: true,
    openedAt: null,
    openedAtRaw: null,
    detail: "Main Codex process is running but not frontmost.",
  }), { pid: 71, visibleWindow: true });
  assert.deepEqual(codexMainProcessObservationFromReport({
    status: "open",
    pid: 72,
    relatedPids: [72],
    hasMainProcess: true,
    visibleWindow: true,
    openedAt: null,
    openedAtRaw: null,
    detail: "Main Codex process is frontmost.",
  }), { pid: 72, visibleWindow: true });

  assert.deepEqual(codexMainProcessObservationFromReport({
    status: "inactive",
    pid: 73,
    relatedPids: [73],
    hasMainProcess: true,
    visibleWindow: false,
    openedAt: null,
    openedAtRaw: null,
    detail: "Foreground state was not accessible.",
  }), { pid: 73, visibleWindow: false });
});

test("environment observation fails closed when the exact requested app disappears", () => {
  let reportCalls = 0;
  const observation = observeCodexMainProcess("/Applications/ChatGPT (Beta).app", {
    locateExact: () => {
      throw new Error("requested Beta app disappeared");
    },
    getReport: () => {
      reportCalls += 1;
      throw new Error("must not inspect another installed channel");
    },
  });

  assert.equal(observation, null);
  assert.equal(reportCalls, 0);
});

test("exact-main quit tries graceful termination, then only SIGTERM after a bounded wait", () => {
  const calls: string[] = [];
  const observations = [
    { pid: 91, visibleWindow: true },
    { pid: 91, visibleWindow: false },
  ];
  const exits = [false, true];

  quitCodexMainProcess("/Applications/ChatGPT.app", 91, {
    observe: () => observations.shift() ?? null,
    gracefulQuit: (path, pid) => { calls.push(`graceful:${path}:${pid}`); },
    waitForExit: (pid, timeoutMs) => {
      calls.push(`wait:${pid}:${timeoutMs}`);
      return exits.shift() ?? true;
    },
    signal: (pid, signal) => { calls.push(`signal:${pid}:${signal}`); },
  });

  assert.deepEqual(calls, [
    "graceful:/Applications/ChatGPT.app:91",
    "wait:91:8000",
    "signal:91:SIGTERM",
    "wait:91:3000",
  ]);
  assert.equal(calls.some((call) => call.includes("SIGKILL")), false);
});

test("exact-main quit refuses SIGTERM when the exact app path now resolves to another PID", () => {
  const calls: string[] = [];
  const observations = [
    { pid: 91, visibleWindow: true },
    { pid: 92, visibleWindow: true },
  ];
  assert.throws(() => quitCodexMainProcess("/Applications/ChatGPT.app", 91, {
    observe: () => observations.shift() ?? null,
    gracefulQuit: () => { calls.push("graceful"); },
    waitForExit: () => false,
    signal: (_pid, signal) => { calls.push(signal); },
  }), /expected main PID 91 is no longer current/);
  assert.deepEqual(calls, ["graceful"]);
});

test("native-update handoff names OpenAI ownership and gives the manual menu fallback", { skip: process.platform !== "darwin" }, () => {
  const { calls, restore } = installExecSpy();
  try {
    showUpdateModePausedAlert("/Applications/ChatGPT.app", "1.2.3");
    const options = calls.at(-1)?.options as { env?: Record<string, string | undefined> };
    const message = options.env?.TWEAKER_ALERT_MESSAGE ?? "";
    assert.match(message, /Pristine ChatGPT is active/);
    assert.match(message, /OpenAI's native updater owns the installation/);
    assert.match(message, /Current ChatGPT desktop: 1\.2\.3/);
    assert.match(message, /ChatGPT > Check for Updates\.\.\./);
    assert.doesNotMatch(message, /Current Codex|…|‚Ä¶|started|starting/);
  } finally {
    restore();
  }
});

/** Fake clock: each nowMs() call advances 1s, so a small deadlineMs bounds the
 * retry loop deterministically without real waiting. */
function fakeClock(): { nowMs: () => number; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    nowMs: () => (t += 1_000),
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

test("native-update handoff clicks the updater menu on the exact committed process", { skip: process.platform !== "darwin" }, async () => {
  const calls: RecordedExecCall[] = [];
  const requested = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    exec: ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      return "";
    }) as typeof execFileSync,
  });

  assert.deepEqual(requested, { ok: true });
  assert.equal(calls.length, 1);
  const script = scriptFrom(calls[0]);
  assert.match(script, /unix id is 91/);
  assert.match(script, /bundle identifier of targetProcess is not "com\.openai\.codex"/);
  assert.match(script, /"Update Available…", "Check for Updates…"/);
  assert.match(script, /click updateItem/);
});

test("native-update handoff refuses a process that is not the exact committed app", { skip: process.platform !== "darwin" }, async () => {
  const clock = fakeClock();
  let executed = false;
  const requested = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 92, visibleWindow: true }),
    exec: (() => {
      executed = true;
      return "";
    }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    deadlineMs: 1,
  });

  assert.equal(requested.ok, false);
  if (!requested.ok) assert.equal(requested.kind, "process_not_proven");
  assert.equal(executed, false);
});

test("native-update handoff includes localized labels and a structural app-menu fallback", { skip: process.platform !== "darwin" }, async () => {
  const calls: RecordedExecCall[] = [];
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    locale: () => "fr-FR",
    readLocaleMessages: () => ({
      "appHeader.installUpdate.confirmInstall": "Mettre à jour",
    }),
    exec: ((command: string, args: readonly string[], options: unknown) => {
      calls.push({ command, args, options });
      return "";
    }) as typeof execFileSync,
  });

  assert.deepEqual(result, { ok: true });
  const script = scriptFrom(calls[0]);
  assert.match(script, /"Mettre à jour"/);
  assert.match(script, /menu item 4 of appMenu/);
  assert.match(script, /name of beforeItem is missing value/);
  assert.match(script, /AXSeparator/);
  assert.match(script, /"Check for Updates…"/);
});

test("native-update handoff reports Automation denial with exact System Settings guidance", { skip: process.platform !== "darwin" }, async () => {
  const denied = Object.assign(new Error("osascript failed"), {
    stderr: "System Events got an error: Not authorized to send Apple events. (-1743)",
    status: 1,
  });
  const clock = fakeClock();
  let execCalls = 0;
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    readLocaleMessages: () => null,
    exec: (() => {
      execCalls += 1;
      throw denied;
    }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "automation_permission_denied");
  assert.match(result.message, /denied Automation access/i);
  assert.match(result.permissionGuidance ?? "", /System Settings > Privacy & Security > Automation/);
  assert.match(result.permissionGuidance ?? "", /control System Events/);
  assert.equal(execCalls, 1);
  assert.equal(clock.sleeps.length, 0);
});

test("native-update handoff reports a missing updater menu instead of swallowing it", { skip: process.platform !== "darwin" }, async () => {
  const missing = Object.assign(new Error("osascript failed"), {
    stderr: "execution error: TWEAKERS_MENU_NOT_FOUND (1708)",
    status: 1,
  });
  const clock = fakeClock();
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    readLocaleMessages: () => null,
    exec: (() => { throw missing; }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    deadlineMs: 1,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "menu_item_not_found");
});

test("native-update handoff retries until the menu appears after app launch", { skip: process.platform !== "darwin" }, async () => {
  const missing = Object.assign(new Error("osascript failed"), {
    stderr: "execution error: TWEAKERS_MENU_NOT_FOUND (1708)",
    status: 1,
  });
  const clock = fakeClock();
  let execCalls = 0;
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    readLocaleMessages: () => null,
    exec: (() => {
      execCalls += 1;
      if (execCalls < 3) throw missing;
      return "";
    }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    deadlineMs: 60_000,
    pollIntervalMs: 500,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(execCalls, 3);
  assert.deepEqual(clock.sleeps, [500, 500]);
});

test("native-update handoff stops retrying at the deadline and records the observed menu", { skip: process.platform !== "darwin" }, async () => {
  const missing = Object.assign(new Error("osascript failed"), {
    stderr: "execution error: TWEAKERS_MENU_NOT_FOUND (1708)",
    status: 1,
  });
  const clock = fakeClock();
  const attemptScripts: string[] = [];
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => ({ pid: 91, visibleWindow: true }),
    readLocaleMessages: () => null,
    exec: ((command: string, args: readonly string[]) => {
      const script = String(args[1]);
      if (script.includes("click updateItem")) {
        attemptScripts.push(script);
        throw missing;
      }
      return "|About ChatGPT| |Settings…|Log Out";
    }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    // deadline = first nowMs (1000) + 5000; each nowMs call advances 1s, so
    // the loop runs attempts at t=1s..5s and exits at t=6s: 5 attempts.
    deadlineMs: 5_000,
    pollIntervalMs: 2_000,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.kind, "menu_item_not_found");
  assert.equal(attemptScripts.length, 5);
  assert.equal(clock.sleeps.length, 4);
  assert.match(result.message, /ChatGPT's native update menu item could not be found\./);
  assert.match(result.message, /Observed app menu items: \|About ChatGPT\| \|Settings…\|Log Out/);
});

test("native-update handoff re-observes a hidden window on each retry", { skip: process.platform !== "darwin" }, async () => {
  const clock = fakeClock();
  let observations = 0;
  let executed = 0;
  const result = await requestCodexNativeUpdate("/Applications/ChatGPT.app", 91, {
    observe: () => {
      observations += 1;
      return { pid: 91, visibleWindow: observations > 1 };
    },
    readLocaleMessages: () => null,
    exec: (() => {
      executed += 1;
      return "";
    }) as typeof execFileSync,
    nowMs: clock.nowMs,
    sleep: clock.sleep,
    deadlineMs: 60_000,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(observations, 2);
  assert.equal(executed, 1);
  assert.equal(clock.sleeps.length, 1);
});

test(
  "interactive app-management failure keeps the blocking critical modal",
  { skip: process.platform !== "darwin" },
  () => {
    const { calls, restore } = installExecSpy();
    try {
      withEnv(
        { TWEAKER_WATCHER: undefined, XPC_SERVICE_NAME: undefined },
        () => showPatchFailedAlert("macOS App Management is blocking modification of /Applications/Codex.app."),
      );

      assert.equal(calls.length, 1);
      const call = calls[0];
      const script = scriptFrom(call);
      assert.match(script, /display alert alertTitle message alertMessage/);
      assert.match(script, /set alertButtons to \{"Dismiss", "Report Issue on GitHub"\}/);
      assert.match(script, /default button "Dismiss"/);
      assert.match(script, /as critical/);
      const options = call.options as { env?: Record<string, string | undefined> };
      assert.equal(options.env?.TWEAKER_ALERT_TITLE, "Tweakers needs app repair");
      assert.equal(options.env?.TWEAKER_ALERT_MESSAGE, 'Run "tweaker repair" in your terminal.');
    } finally {
      restore();
    }
  },
);

test(
  "reopen uses exactly one launch strategy",
  { skip: process.platform !== "darwin" },
  () => {
    const { calls, restore } = installExecSpy();
    const appRoot = "/tmp/Codex.app";
    try {
      openCodex(appRoot);

      const launchCalls = calls.filter((call) => call.command === "open");
      assert.equal(launchCalls.length, 1);
      const launchCall = launchCalls[0];
      assert.ok(launchCall);
      assert.deepEqual(launchCall.args, [appRoot]);
      assert.equal(calls.some((call) => call.command === "open" && call.args.includes("-b")), false);
      assert.equal(
        calls.some((call) => call.command === "osascript" && call.args.includes("to activate")),
        false,
      );

      const reconcileIndex = calls.findIndex(
        (call) => call.command.endsWith("Support/lsregister") && call.args[0] === "-f",
      );
      const openIndex = calls.findIndex((call) => call.command === "open");
      assert.notEqual(reconcileIndex, -1);
      assert.notEqual(openIndex, -1);
      assert.ok(reconcileIndex < openIndex);
    } finally {
      restore();
    }
  },
);
