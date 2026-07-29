import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  defaultMcpLifecycleSourceRoot,
  installMcpLifecyclePackage,
  type McpLifecycleCommandRunner,
  type McpLifecycleFilesystem,
} from "../src/mcp-lifecycle-install";

const NO_PLIST_LINT: McpLifecycleCommandRunner = {
  run: () => ({ available: false, status: null, stdout: "", stderr: "" }),
};

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-home-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function sourceCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-source-"));
  const destination = join(root, "mcp-lifecycle");
  cpSync(defaultMcpLifecycleSourceRoot(), destination, { recursive: true });
  return root;
}

function sourceAsset(home: string, relative: string): string {
  return join(home, ".codex", relative);
}

function launchAgent(home: string, name: string): string {
  return join(home, "Library", "LaunchAgents", name);
}

function readMode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("installs the canonical package into a temporary HOME and preserves reaper-owned files", () => {
  withTempHome((home) => {
    const state = sourceAsset(home, "tmp/codex-mcp-lifecycle-state.json");
    const status = sourceAsset(home, "tmp/codex-mcp-lifecycle-status.json");
    const actions = sourceAsset(home, "tmp/codex-mcp-lifecycle-actions.jsonl");
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, "{\"schema_version\":1,\"trees\":{}}\n");
    writeFileSync(status, "{\"schema_version\":1,\"trees\":[]}\n");
    writeFileSync(actions, "{\"state\":\"verified_gone\"}\n");

    const result = installMcpLifecyclePackage({
      targetHome: home,
      targetRoot: join(home, ".codex"),
      launchAgentsRoot: join(home, "Library", "LaunchAgents"),
      temporaryRoot: join(home, "transaction-scratch"),
      commands: NO_PLIST_LINT,
      labelInstances: () => 0,
    });

    assert.equal(result.status, "installed");
    assert.equal(result.changedAssetIds.length, 5);
    assert.match(readFileSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py"), "utf8"), /Pure process ownership/);
    assert.match(readFileSync(sourceAsset(home, "bin/codex-mcp-idle-reaper.py"), "utf8"), /children-first/);
    assert.match(readFileSync(sourceAsset(home, "bin/codex-mcp-guard.py"), "utf8"), /notification/i);
    assert.equal(readMode(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), 0o644);
    assert.equal(readMode(sourceAsset(home, "bin/codex-mcp-idle-reaper.py")), 0o755);
    assert.equal(readMode(sourceAsset(home, "bin/codex-mcp-guard.py")), 0o755);
    assert.match(
      readFileSync(launchAgent(home, "com.thomashulihan.codex-mcp-idle-reaper.plist"), "utf8"),
      new RegExp(home.replace(/[.*+?^()|[\]\\]/g, "\\$&") + "/.codex/bin/codex-mcp-idle-reaper.py"),
    );
    assert.match(
      readFileSync(launchAgent(home, "com.thomashulihan.codex-mcp-guard.plist"), "utf8"),
      new RegExp(home.replace(/[.*+?^()|[\]\\]/g, "\\$&") + "/.codex/bin/codex-mcp-guard.py"),
    );
    assert.equal(readFileSync(state, "utf8"), "{\"schema_version\":1,\"trees\":{}}\n");
    assert.equal(readFileSync(status, "utf8"), "{\"schema_version\":1,\"trees\":[]}\n");
    assert.equal(readFileSync(actions, "utf8"), "{\"state\":\"verified_gone\"}\n");

    const repeated = installMcpLifecyclePackage({ targetHome: home, commands: NO_PLIST_LINT });
    assert.equal(repeated.status, "unchanged");
  });
});

test("rejects a corrupt canonical source before it writes into the target HOME", () => {
  const fixture = sourceCopy();
  try {
    withTempHome((home) => {
      writeFileSync(join(fixture, "mcp-lifecycle", "assets", "lib", "codex_mcp_lifecycle.py"), "corrupt\n");
      assert.throws(
        () => installMcpLifecyclePackage({
          sourceRoot: join(fixture, "mcp-lifecycle"),
          targetHome: home,
          commands: NO_PLIST_LINT,
        }),
        /digest mismatch/,
      );
      assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a filesystem permission failure during staging does not promote an asset", () => {
  withTempHome((home) => {
    let activationRollbackCalls = 0;
    const failingFilesystem: McpLifecycleFilesystem = {
      exists: existsSync,
      read: (path) => readFileSync(path),
      write: () => { throw new Error("permission denied"); },
      mkdir: (path) => mkdirSync(path, { recursive: true }),
      chmod: chmodSync,
      rename: renameSync,
      remove: (path) => rmSync(path, { recursive: true, force: true }),
      mode: readMode,
      isFile: (path) => statSync(path).isFile(),
      makeTempDir: mkdtempSync,
    };
    assert.throws(
      () => installMcpLifecyclePackage({
        targetHome: home,
        filesystem: failingFilesystem,
        commands: NO_PLIST_LINT,
        afterRollback: () => {
          activationRollbackCalls += 1;
        },
      }),
      /install failed/,
    );
    assert.equal(activationRollbackCalls, 0);
    assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
  });
});

test("a plist validation failure is contained in staging and leaves no installed plist", () => {
  withTempHome((home) => {
    const failingLint: McpLifecycleCommandRunner = {
      run: () => ({ available: true, status: 1, stdout: "", stderr: "bad plist" }),
    };
    assert.throws(
      () => installMcpLifecyclePackage({ targetHome: home, commands: failingLint }),
      /plutil rejected/,
    );
    assert.equal(
      existsSync(launchAgent(home, "com.thomashulihan.codex-mcp-idle-reaper.plist")),
      false,
    );
  });
});

test("a duplicate launchd label defers without staging or changing the target", () => {
  withTempHome((home) => {
    const result = installMcpLifecyclePackage({
      targetHome: home,
      commands: NO_PLIST_LINT,
      labelInstances: () => 2,
    });
    assert.equal(result.status, "deferred");
    if (result.status === "deferred") {
      assert.match(result.reason, /exact-one ownership/);
    }
    assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
  });
});

test("exactly one existing label is accepted, while an active termination is deferred", () => {
  withTempHome((home) => {
    const accepted = installMcpLifecyclePackage({
      targetHome: home,
      commands: NO_PLIST_LINT,
      labelInstances: () => 1,
    });
    assert.equal(accepted.status, "installed");
  });
  withTempHome((home) => {
    const deferred = installMcpLifecyclePackage({
      targetHome: home,
      commands: NO_PLIST_LINT,
      activeTermination: () => ({ treeKey: "codex:active", detail: "same-identity TERM wait" }),
    });
    assert.equal(deferred.status, "deferred");
    if (deferred.status === "deferred") {
      assert.match(deferred.reason, /termination is active.*codex:active/);
    }
    assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
  });
});

test("a promotion failure rolls back already replaced assets and keeps runtime state intact", () => {
  withTempHome((home) => {
    const module = sourceAsset(home, "lib/codex_mcp_lifecycle.py");
    const state = sourceAsset(home, "tmp/codex-mcp-lifecycle-state.json");
    mkdirSync(dirname(module), { recursive: true });
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(module, "old canonical module\n", { mode: 0o644 });
    writeFileSync(state, "{\"schema_version\":1,\"trees\":{\"old\":{}}}\n");

    assert.throws(
      () => installMcpLifecyclePackage({
        targetHome: home,
        commands: NO_PLIST_LINT,
        beforeStep: (step, asset) => {
          if (step === "after-promote" && asset.asset.id === "idle-reaper") {
            throw new Error("forced promotion failure");
          }
        },
      }),
      /install failed/,
    );

    assert.equal(readFileSync(module, "utf8"), "old canonical module\n");
    assert.equal(readFileSync(state, "utf8"), "{\"schema_version\":1,\"trees\":{\"old\":{}}}\n");
    assert.equal(existsSync(sourceAsset(home, "bin/codex-mcp-idle-reaper.py")), false);
  });
});

test("an activation failure restores files before invoking activation rollback", () => {
  withTempHome((home) => {
    const rollbackHooks: string[] = [];
    assert.throws(() => installMcpLifecyclePackage({
      targetHome: home,
      commands: NO_PLIST_LINT,
      afterPromotion: (_assets, markActivationAttempted) => {
        markActivationAttempted();
        throw new Error("reload failed");
      },
      afterRollback: () => {
        rollbackHooks.push("restored");
      },
    }), /reload failed/);

    assert.deepEqual(rollbackHooks, ["restored"]);
    assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
    assert.equal(existsSync(launchAgent(home, "com.thomashulihan.codex-mcp-idle-reaper.plist")), false);
  });
});

test("a pre-activation deferral rolls files back without reloading prior jobs", () => {
  withTempHome((home) => {
    let rollbackActivations = 0;
    assert.throws(() => installMcpLifecyclePackage({
      targetHome: home,
      commands: NO_PLIST_LINT,
      afterPromotion: () => {
        throw new Error("lifecycle entered terminating state");
      },
      afterRollback: () => {
        rollbackActivations += 1;
      },
    }), /terminating state/);

    assert.equal(rollbackActivations, 0);
    assert.equal(existsSync(sourceAsset(home, "lib/codex_mcp_lifecycle.py")), false);
    assert.equal(existsSync(launchAgent(home, "com.thomashulihan.codex-mcp-idle-reaper.plist")), false);
  });
});
