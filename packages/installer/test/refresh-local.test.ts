import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  cancelRefreshLocal,
  getLocalRefreshStatus,
  handoffRefreshLocalToLaunchd,
  hashRefreshSourceTree,
  hashTree,
  npmCommand,
  readAcceptedRefreshReceipt,
  refreshBindingMatches,
  writeAcceptedRefreshReceipt,
  preferredDesktopRefreshSource,
  refreshCliPath,
  registerDevelopmentCheckout,
  resolveExplicitDevelopmentRoot,
  resolveRefreshSelection,
  restoreModeCoordinatorMetadata,
  runRefreshWorkflow,
} from "../src/commands/refresh-local";
import { managedSourceRoot, writeDevelopmentProvenanceHash } from "../src/managed-runtime";
import { modeCoordinatorConfigFile, modeCoordinatorStatus } from "../src/switcher-setup";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../..", import.meta.url)));

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
    // Smart source selection needs the registered checkout even when
    // hash-current, so it must survive into the "current" status.
    assert.equal(current.developmentSourceRoot, source);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("smart refresh prefers a registered development checkout over the stable stage", () => {
  const status = (source: "development" | "stable" | "current", developmentSourceRoot: string | null) => ({
    available: false,
    source,
    phase: "idle" as const,
    developmentSourceRoot,
    detail: "",
    error: null,
    checkedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(preferredDesktopRefreshSource(status("development", "/repo")), "development");
  // A hash-current checkout wins over "current": without a newer published
  // release the stable path dead-ends with an empty stage.
  assert.equal(preferredDesktopRefreshSource(status("current", "/repo")), "development");
  // But when a newer published release is genuinely installable ("stable"),
  // the stable path is viable and must stay reachable even with a registered
  // checkout — otherwise coordinated updates can never take a release.
  assert.equal(preferredDesktopRefreshSource(status("stable", "/repo")), "stable");
  assert.equal(preferredDesktopRefreshSource(status("stable", null)), "stable");
  assert.equal(preferredDesktopRefreshSource(status("current", null)), "stable");
});

test("explicit development root overrides registration without changing config bytes", () => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-refresh-explicit-"));
  const configFile = join(userRoot, "config.json");
  const configBytes = "{\n  \"tweaker\": {\n    \"developmentSourceRoot\": \"/wrong/registered/root\"\n  },\n  \"coOwned\": \"preserve exactly\"\n}\n";
  try {
    writeFileSync(configFile, configBytes, { mode: 0o600 });
    const selection = resolveRefreshSelection(userRoot, {
      source: "development",
      developmentRoot: repositoryRoot,
    });
    assert.deepEqual(selection, {
      selected: "development",
      sourceRoot: repositoryRoot,
      developmentSourceRoot: repositoryRoot,
    });
    assert.equal(readFileSync(configFile, "utf8"), configBytes);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("explicit development root rejects relative, missing, invalid package, non-worktree, and wrong-source inputs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-refresh-source-validation-")));
  try {
    assert.throws(
      () => resolveExplicitDevelopmentRoot({ source: "development", developmentRoot: "relative/repo" }),
      /exact absolute path/,
    );
    assert.throws(
      () => resolveExplicitDevelopmentRoot({ source: "development", developmentRoot: join(root, "missing") }),
      /does not exist/,
    );

    const invalidPackage = join(root, "invalid-package");
    mkdirSync(join(invalidPackage, "packages", "installer"), { recursive: true });
    writeFileSync(join(invalidPackage, "package.json"), "{\"name\":\"not-tweakers\",\"workspaces\":[\"packages/*\"]}\n");
    writeFileSync(join(invalidPackage, "packages", "installer", "package.json"), "{\"name\":\"not-installer\"}\n");
    assert.throws(
      () => resolveExplicitDevelopmentRoot({ source: "development", developmentRoot: invalidPackage }),
      /not a Tweakers package root/,
    );

    const notWorktree = join(root, "not-worktree");
    mkdirSync(join(notWorktree, "packages", "installer"), { recursive: true });
    writeFileSync(join(notWorktree, "package.json"), "{\"name\":\"@therealityreport/tweakers\",\"workspaces\":[\"packages/*\"]}\n");
    writeFileSync(join(notWorktree, "packages", "installer", "package.json"), "{\"name\":\"@therealityreport/tweakers-installer\"}\n");
    assert.throws(
      () => resolveExplicitDevelopmentRoot({ source: "development", developmentRoot: notWorktree }),
      /not the root of a Tweakers Git worktree/,
    );

    for (const source of [undefined, "smart", "stable"] as const) {
      assert.throws(
        () => resolveExplicitDevelopmentRoot({ source, developmentRoot: repositoryRoot }),
        /valid only with --source development/,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh child failures capture output for the refresh-state and receipt error", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, /stdio: \["ignore", "pipe", "pipe"\]/);
  assert.match(source, /failed with \$\{detail\}\$\{tail \? `: \$\{tail\}` : ""\}/);
});

test("stable refresh stages a release separately and holds a promotable candidate", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, /refresh-stable-stage/);
  assert.match(source, /candidateOnlyReason: "coordinated-refresh"/);
  assert.match(source, /managedCliPath\(stableStageRoot\).*"repair"/s);
});

test("macOS refresh-local hands promotion to launchd before quitting the app", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, /handoffRefreshLocalToLaunchd\(paths\.root,/);
  assert.match(source, /TWEAKERS_REFRESH_LOCAL_DETACHED === "1"/);
  assert.match(source, /launchctl", \["submit", "-l", label/);
  assert.match(source, /com\.therealityreport\.tweakers\.refresh-local/);
  assert.match(source, /TWEAKERS_REFRESH_LOCAL_DETACHED=1/);
  assert.match(source, /quitCodex\(appRoot\);/);
  // Promotion must be gated on a proven-complete quit, not a best-effort one.
  assert.match(source, /isCodexMainProcessRunning\(appRoot\)/);
});

test("launchd handoff succeeds, falls back on submit failure, and prevents recursion", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-handoff-"));
  try {
    const calls: Array<{ command: string; args: string[] }> = [];
    const common = {
      platform: "darwin" as const,
      env: { PATH: "/opt/custom node/bin:/usr/bin" },
      argv: ["node", "/tmp/tweaker cli.js", "refresh-local", "--source", "development", "--development-root", "/tmp/isolated source root"],
      execPath: "/tmp/node binary",
      cwd: "/tmp/source root",
      now: () => 123,
    };
    assert.equal(handoffRefreshLocalToLaunchd(root, {
      ...common,
      submit: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
    }, {
      source: "development",
      developmentSourceRoot: "/tmp/isolated source root",
    }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "launchctl");
    assert.match(calls[0]?.args.join(" ") ?? "", /com\.therealityreport\.tweakers\.refresh-local\.[0-9]+\.123/);
    assert.match(calls[0]?.args.at(-1) ?? "", /TWEAKERS_REFRESH_LOCAL_DETACHED=1/);
    assert.match(calls[0]?.args.at(-1) ?? "", /PATH='\/opt\/custom node\/bin:\/usr\/bin'/);
    assert.match(calls[0]?.args.at(-1) ?? "", /'\/tmp\/node binary' '\/tmp\/tweaker cli\.js'/);
    assert.match(calls[0]?.args.at(-1) ?? "", /'--development-root' '\/tmp\/isolated source root'/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "refresh-state.json"), "utf8")), {
      available: false,
      source: "development",
      phase: "preparing",
      developmentSourceRoot: "/tmp/isolated source root",
      detail: "Local refresh handed off to launchd",
      error: null,
      checkedAt: JSON.parse(readFileSync(join(root, "refresh-state.json"), "utf8")).checkedAt,
    });
    const shell = calls[0]?.args.at(-1) ?? "";
    assert.match(shell, /trap cleanup_transient_launchd_job EXIT/);
    assert.match(shell, /launchctl remove 'com\.therealityreport\.tweakers\.refresh-local\.[0-9]+\.123'/);
    assert.match(shell, /launchctl bootout gui\/\$\(id -u\)\/'com\.therealityreport\.tweakers\.refresh-local\.[0-9]+\.123'/);
    assert.match(shell, /trap 'exit 143' TERM/);
    assert.doesNotMatch(shell, /\|\|\s*true/);

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

test("refresh launchd shell cleans its label and preserves a non-zero refresh exit", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-shell-"));
  try {
    const cleanupCalls = join(root, "cleanup.log");
    const launchctl = join(root, "launchctl");
    const worker = join(root, "worker");
    const cli = join(root, "cli.js");
    writeFileSync(
      launchctl,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CLEANUP_CALLS"\n[ "$1" = remove ] && exit 1\nexit 0\n`,
    );
    writeFileSync(worker, "#!/bin/sh\nexit 23\n");
    writeFileSync(cli, "// fixture\n");
    chmodSync(launchctl, 0o755);
    chmodSync(worker, 0o755);

    let shell = "";
    assert.equal(handoffRefreshLocalToLaunchd(root, {
      platform: "darwin",
      env: { PATH: `${root}:/usr/bin:/bin` },
      argv: ["node", cli, "refresh-local"],
      execPath: worker,
      cwd: root,
      now: () => 456,
      submit: (_command, args) => {
        shell = args.at(-1) ?? "";
        return { status: 0 };
      },
    }), true);

    const result = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        CLEANUP_CALLS: cleanupCalls,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 23);
    assert.deepEqual(readFileSync(cleanupCalls, "utf8").trim().split("\n"), [
      `remove com.therealityreport.tweakers.refresh-local.${process.pid}.456`,
      `bootout gui/${process.getuid?.() ?? 501}/com.therealityreport.tweakers.refresh-local.${process.pid}.456`,
    ]);

    writeFileSync(worker, "#!/bin/sh\nkill -TERM \"$PPID\"\nsleep 0.1\nexit 0\n");
    shell = "";
    assert.equal(handoffRefreshLocalToLaunchd(root, {
      platform: "darwin",
      env: { PATH: `${root}:/usr/bin:/bin` },
      argv: ["node", cli, "refresh-local"],
      execPath: worker,
      cwd: root,
      now: () => 457,
      submit: (_command, args) => {
        shell = args.at(-1) ?? "";
        return { status: 0 };
      },
    }), true);
    const interrupted = spawnSync("/bin/sh", ["-c", shell], {
      env: {
        ...process.env,
        PATH: `${root}:/usr/bin:/bin`,
        CLEANUP_CALLS: cleanupCalls,
      },
      encoding: "utf8",
    });
    assert.equal(interrupted.status, 143);
    assert.match(
      readFileSync(cleanupCalls, "utf8"),
      new RegExp(`remove com\\.therealityreport\\.tweakers\\.refresh-local\\.${process.pid}\\.457`),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm resolves next to the running node binary before falling back to PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-npm-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const execPath = join(bin, "node");
    // launchd jobs carry a minimal PATH without nvm/asdf/volta, but they spawn
    // the CLI with an absolute node path whose directory also holds npm.
    writeFileSync(join(bin, "npm"), "#!/bin/sh\n");
    assert.equal(npmCommand("darwin", execPath), join(bin, "npm"));
    // win32 layouts ship npm.cmd next to node.exe.
    writeFileSync(join(bin, "npm.cmd"), "@echo off\n");
    assert.equal(npmCommand("win32", execPath), join(bin, "npm.cmd"));
    // No sibling npm: keep the bare PATH lookup (current behavior).
    assert.equal(npmCommand("darwin", join(root, "elsewhere", "node")), "npm");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refresh promote restores restart-coordinator metadata in the live root", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-coordinator-"));
  const previous = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  try {
    assert.equal(modeCoordinatorStatus(root).configured, false);
    await restoreModeCoordinatorMetadata();
    assert.equal(existsSync(modeCoordinatorConfigFile(root)), true);
    assert.deepEqual(modeCoordinatorStatus(root), { configured: true, source: "coordinator" });
  } finally {
    if (previous === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("both promote branches restore coordinator metadata after the runtime install", () => {
  const source = readFileSync(new URL("../src/commands/refresh-local.ts", import.meta.url), "utf8");
  assert.match(source, new RegExp([
    /promote: async \(\) => \{/.source,
    /[\s\S]*?installManagedRuntime\(preparedStableSource, paths\.root\);/.source,
    /[\s\S]*?writeDevelopmentProvenanceHash\(managed, hashTree\(sourceRoot, false\)\);/.source,
    /[\s\S]*?\}\s*await restoreModeCoordinatorMetadata\(\);\s*\},/.source,
  ].join("")));
});

test("coordinator metadata restore never fails the refresh", async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await restoreModeCoordinatorMetadata(async () => ({ configured: false, reason: "disk full" }));
    await restoreModeCoordinatorMetadata(async () => { throw new Error("boom"); });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /disk full/);
  assert.match(warnings[1] ?? "", /boom/);
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

test("refresh cancel clears a stranded preparing state and its background job", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-cancel-"));
  try {
    writeFileSync(join(root, "refresh-state.json"), JSON.stringify({
      available: false,
      source: "development",
      phase: "preparing",
      developmentSourceRoot: "/tmp/checkout",
      detail: "Local refresh handed off to launchd",
      error: null,
      checkedAt: new Date().toISOString(),
    }));
    const removed: string[] = [];
    const killed: Array<[number, string]> = [];
    let alive = true;
    const result = cancelRefreshLocal(root, {}, {
      listLaunchdLabels: () => ["com.therealityreport.tweakers.refresh-local.123.456"],
      removeLaunchdJob: (label) => { removed.push(label); },
      readLockOwner: () => 9999,
      processAlive: () => alive,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        alive = false;
      },
      sleep: () => {},
      now: Date.now,
    });
    assert.equal(result.cancelled, true);
    assert.deepEqual(removed, ["com.therealityreport.tweakers.refresh-local.123.456"]);
    assert.deepEqual(killed, [[9999, "SIGTERM"]]);
    const state = JSON.parse(readFileSync(join(root, "refresh-state.json"), "utf8"));
    assert.equal(state.phase, "failed");
    assert.equal(state.error, "Cancelled by user");
    assert.equal(state.source, "development");
    assert.equal(state.developmentSourceRoot, "/tmp/checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh cancel refuses mid-promotion without force and is a no-op when idle", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-cancel-promote-"));
  try {
    writeFileSync(join(root, "refresh-state.json"), JSON.stringify({
      available: false,
      source: "development",
      phase: "promoting",
      developmentSourceRoot: null,
      detail: "Local refresh promoting",
      error: null,
      checkedAt: new Date().toISOString(),
    }));
    const inert = {
      listLaunchdLabels: () => [],
      removeLaunchdJob: () => {},
      readLockOwner: () => null,
      processAlive: () => false,
      kill: () => {},
      sleep: () => {},
      now: Date.now,
    };
    assert.throws(() => cancelRefreshLocal(root, {}, inert), /promoting/);
    const forced = cancelRefreshLocal(root, { force: true }, inert);
    assert.equal(forced.cancelled, true);

    const idleRoot = mkdtempSync(join(tmpdir(), "tweakers-refresh-cancel-idle-"));
    try {
      const result = cancelRefreshLocal(idleRoot, {}, inert);
      assert.equal(result.cancelled, false);
      assert.equal(existsSync(join(idleRoot, "refresh-state.json")), false);
    } finally {
      rmSync(idleRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hashRefreshSourceTree covers tweak sources the provenance hash deliberately excludes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-hash-"));
  try {
    mkdirSync(join(root, "packages", "installer", "assets", "runtime"), { recursive: true });
    mkdirSync(join(root, "tweaks", "co.example.tweak"), { recursive: true });
    writeFileSync(join(root, "packages", "installer", "assets", "runtime", "main.js"), "built");
    writeFileSync(join(root, "tweaks", "co.example.tweak", "index.js"), "before");
    writeFileSync(join(root, "src.ts"), "source");

    const before = hashRefreshSourceTree(root);
    const provenanceBefore = hashTree(root, false);
    writeFileSync(join(root, "tweaks", "co.example.tweak", "index.js"), "after");
    assert.notEqual(hashRefreshSourceTree(root), before, "a tweak-only edit must change the refresh hash");
    assert.equal(hashTree(root, false), provenanceBefore, "the provenance hash ignores tweak sources");

    // Build outputs must not self-invalidate the refresh hash.
    const afterTweakEdit = hashRefreshSourceTree(root);
    writeFileSync(join(root, "packages", "installer", "assets", "runtime", "main.js"), "rebuilt");
    assert.equal(hashRefreshSourceTree(root), afterTweakEdit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepted-refresh receipts round-trip, validate strictly, and match only exact bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-refresh-accepted-"));
  try {
    const binding = {
      sourceRoot: join(root, "checkout"),
      sourceRefreshHash: "a".repeat(64),
      appRoot: "/Applications/ChatGPT.app",
      appAsarHeaderHash: "b".repeat(64),
      runtimeFingerprintSha256: "c".repeat(64),
      managedProvenanceSha256: "d".repeat(64),
      toolchainKey: `${process.version}:${"e".repeat(64)}`,
    };
    assert.equal(readAcceptedRefreshReceipt(root), null);
    writeAcceptedRefreshReceipt(root, binding);
    const receipt = readAcceptedRefreshReceipt(root);
    assert.ok(receipt);
    assert.equal(receipt.kind, "refresh-accepted");
    assert.equal(refreshBindingMatches(receipt, binding), true);
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      assert.equal(
        refreshBindingMatches(receipt, { ...binding, [key]: "drifted" }),
        false,
        `a drifted ${key} must invalidate the gate`,
      );
    }

    // A receipt missing any bound field is rejected outright.
    writeFileSync(join(root, "refresh-accepted.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "refresh-accepted",
      sourceRoot: binding.sourceRoot,
    }), { mode: 0o600 });
    assert.equal(readAcceptedRefreshReceipt(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
