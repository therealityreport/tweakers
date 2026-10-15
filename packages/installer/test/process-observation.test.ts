import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { observeExactTargetProcesses } from "../src/process-observation.js";

test("exact target observation includes helpers and detached reporters but excludes sibling apps and arguments", (context) => {
  const commands: unknown[][] = [];
  context.mock.method(childProcess, "spawnSync", (...args: unknown[]) => {
    commands.push(args);
    return { status: 0, stdout: [
      " 101 1 /Applications/Tweakers.app/Contents/MacOS/Tweakers --flag",
      " 102 101 /Applications/Tweakers.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      " 103 1 /Applications/Tweakers.app/Contents/Helpers/crashpad_handler",
      " 104 1 /Applications/Tweakers.app.old/Contents/MacOS/Tweakers",
      " 105 1 /bin/echo /Applications/Tweakers.app/Contents/MacOS/Tweakers",
      " malformed process line",
    ].join("\n") };
  });
  syncBuiltinESMExports();
  try {
    const observed = observeExactTargetProcesses("/Applications/../Applications/Tweakers.app");
    assert.deepEqual(observed.map(({ pid, ppid }) => ({ pid, ppid })), [
      { pid: 101, ppid: 1 }, { pid: 102, ppid: 101 }, { pid: 103, ppid: 1 },
    ]);
    assert.equal(observed[0]?.command, "/Applications/Tweakers.app/Contents/MacOS/Tweakers --flag");
    assert.deepEqual(commands, [["/bin/ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }]]);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("process census errors fail closed with the existing promotion diagnostic", (context) => {
  const result: { status: number | null; error?: Error; stdout?: string } = { status: 1 };
  context.mock.method(childProcess, "spawnSync", () => result);
  syncBuiltinESMExports();
  try {
    const diagnostic = /Unable to inspect the exact Tweakers target process before promotion\./;
    assert.throws(() => observeExactTargetProcesses("/Applications/Tweakers.app"), diagnostic);
    result.status = null;
    result.error = new Error("census failed");
    assert.throws(() => observeExactTargetProcesses("/Applications/Tweakers.app"), diagnostic);
    result.status = 0;
    delete result.error;
    assert.deepEqual(observeExactTargetProcesses("/Applications/Tweakers.app"), []);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
