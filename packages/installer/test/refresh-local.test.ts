import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getLocalRefreshStatus, handoffRefreshLocalToLaunchd, hashTree, refreshCliPath, registerDevelopmentCheckout, runRefreshWorkflow } from "../src/commands/refresh-local";
import { managedSourceRoot, writeDevelopmentProvenanceHash } from "../src/managed-runtime";

test("smart refresh selects a changed registered development checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-"));
  try {
    const source = join(root, "repo");
    const user = join(root, "user");
    mkdirSync(join(source, "tweaks"), { recursive: true });
    mkdirSync(join(source, "packages", "installer", "dist"), { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(join(source, "package.json"), "{}\n");
    writeFileSync(join(source, "packages", "installer", "dist", "cli.js"), "cli\n");
    registerDevelopmentCheckout(join(user, "config.json"), source);

    const changed = getLocalRefreshStatus(user);
    assert.equal(changed.available, true);
    assert.equal(changed.source, "development");
    assert.equal(refreshCliPath(user, changed), join(source, "packages", "installer", "dist", "cli.js"));

    const managed = managedSourceRoot(user);
    mkdirSync(managed, { recursive: true });
    writeDevelopmentProvenanceHash(managed, hashTree(source, false));
    const current = getLocalRefreshStatus(user);
    assert.equal(current.available, false);
    assert.equal(current.source, "current");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stable refresh stages a release separately and holds a promotable candidate", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, /refresh-stable-stage/);
  assert.match(source, /candidateOnlyReason: "coordinated-refresh"/);
  assert.match(source, /managedCliPath\(stableStageRoot\).*"repair"/s);
});

test("macOS refresh-local hands promotion to launchd before quitting the app", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, /handoffRefreshLocalToLaunchd\(paths\.root\)/);
  assert.match(source, /TWEAKERS_REFRESH_LOCAL_DETACHED === "1"/);
  assert.match(source, /launchctl", \["submit", "-l", label/);
  assert.match(source, /com\.therealityreport\.tweakers\.refresh-local/);
  assert.match(source, /TWEAKERS_REFRESH_LOCAL_DETACHED=1/);
  assert.match(source, /quit: \(\) => quitCodex\(appRoot\)/);
});

test("launchd handoff succeeds, falls back on submit failure, and prevents recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-handoff-"));
  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const common = {
      platform: "darwin" as const,
      env: { PATH: "/opt/custom node/bin:/usr/bin" },
      argv: ["node", "/tmp/tweakers cli.js", "refresh-local", "--source", "development"],
      execPath: "/tmp/node binary",
      cwd: "/tmp/source root",
      now: () => 123,
    };
    assert.equal(handoffRefreshLocalToLaunchd(root, {
      ...common,
      submit: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "launchctl");
    assert.match(calls[0]?.args.join(" ") ?? "", /com\.therealityreport\.tweakers\.refresh-local\.[0-9]+\.123/);
    assert.match(calls[0]?.args.at(-1) ?? "", /TWEAKERS_REFRESH_LOCAL_DETACHED=1/);
    assert.match(calls[0]?.args.at(-1) ?? "", /PATH='\/opt\/custom node\/bin:\/usr\/bin'/);
    assert.match(calls[0]?.args.at(-1) ?? "", /'\/tmp\/node binary' '\/tmp\/tweakers cli\.js'/);
    assert.match(
      calls[0]?.args.at(-1) ?? "",
      /; launchctl remove 'com\.therealityreport\.tweakers\.refresh-local\.[0-9]+\.123'$/,
      "submitted job must unregister itself or launchd relaunches it forever",
    );

    assert.equal(handoffRefreshLocalToLaunchd(root, {
      ...common,
      submit: () => ({ status: 1 }),
    }), false);

    let recursiveSubmitCalled = false;
    assert.equal(handoffRefreshLocalToLaunchd(root, {
      ...common,
      env: { TWEAKERS_REFRESH_LOCAL_DETACHED: "1" },
      submit: () => { recursiveSubmitCalled = true; return { status: 0 }; },
    }), false);
    assert.equal(recursiveSubmitCalled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh validates before quitting and always reopens after promotion starts", async () => {
  const calls: string[] = [];
  await runRefreshWorkflow({
    prepare: () => calls.push("prepare"),
    quit: () => calls.push("quit"),
    promote: () => calls.push("promote"),
    reopen: () => calls.push("reopen"),
  });
  assert.deepEqual(calls, ["prepare", "quit", "promote", "reopen"]);

  const failedBeforeQuit: string[] = [];
  await assert.rejects(runRefreshWorkflow({
    prepare: () => { failedBeforeQuit.push("prepare"); throw new Error("invalid"); },
    quit: () => failedBeforeQuit.push("quit"),
    promote: () => failedBeforeQuit.push("promote"),
    reopen: () => failedBeforeQuit.push("reopen"),
  }), /invalid/);
  assert.deepEqual(failedBeforeQuit, ["prepare"]);

  const failedPromotion: string[] = [];
  await assert.rejects(runRefreshWorkflow({
    prepare: () => failedPromotion.push("prepare"),
    quit: () => failedPromotion.push("quit"),
    promote: () => { failedPromotion.push("promote"); throw new Error("rollback"); },
    reopen: () => failedPromotion.push("reopen"),
  }), /rollback/);
  assert.deepEqual(failedPromotion, ["prepare", "quit", "promote", "reopen"]);
});
