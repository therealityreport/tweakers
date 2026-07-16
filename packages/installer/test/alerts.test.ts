import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { openCodex, setAlertExecFileSyncForTest, showPatchFailedAlert } from "../src/alerts";

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
      { CODEX_PLUSPLUS_WATCHER: "1", XPC_SERVICE_NAME: undefined },
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
      { CODEX_PLUSPLUS_WATCHER: "1", XPC_SERVICE_NAME: undefined },
      () => showPatchFailedAlert("macOS App Management is blocking modification of /Applications/Codex.app."),
    );

    assert.equal(calls.length, 1);
    const script = scriptFrom(calls[0]);
    assert.match(
      script,
      /display notification "Run \\"tweakers repair\\" in your terminal\." with title "Tweakers needs app repair"/,
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
        { CODEX_PLUSPLUS_WATCHER: undefined, XPC_SERVICE_NAME: undefined },
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
      assert.equal(options.env?.CODEXPP_ALERT_TITLE, "Tweakers could not patch Codex");
      assert.equal(
        options.env?.CODEXPP_ALERT_MESSAGE,
        "Codex was updated, but Tweakers could not reapply itself automatically.\n\n" +
          `${errorMessage}\n\n` +
          "Run tweakers repair from Terminal after Codex finishes updating, or report this failure on GitHub.",
      );
    } finally {
      restore();
    }
  },
);

test(
  "interactive app-management failure keeps the blocking critical modal",
  { skip: process.platform !== "darwin" },
  () => {
    const { calls, restore } = installExecSpy();
    try {
      withEnv(
        { CODEX_PLUSPLUS_WATCHER: undefined, XPC_SERVICE_NAME: undefined },
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
      assert.equal(options.env?.CODEXPP_ALERT_TITLE, "Tweakers needs app repair");
      assert.equal(options.env?.CODEXPP_ALERT_MESSAGE, 'Run "tweakers repair" in your terminal.');
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
