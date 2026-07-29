import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reconcileAdoptedMcpLifecycle,
  repairMcpLifecycle,
} from "../src/commands/mcp-lifecycle";
import { inspectMcpLifecycleHealth } from "../src/mcp-lifecycle-health";
import {
  MCP_LIFECYCLE_LABELS,
  defaultMcpLifecycleSourceRoot,
  installMcpLifecyclePackage,
  readMcpLifecycleManifest,
} from "../src/mcp-lifecycle-install";

test("deep lifecycle health verifies installed assets and defers stale or terminating reloads", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    installMcpLifecyclePackage({
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      targetHome: home,
      temporaryRoot: home,
      labelInstances: () => 0,
    });
    const healthy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 1,
    });

    assert.equal(healthy.checks.filter((item) => item.id.startsWith("asset:")).every((item) => item.status === "ok"), true);
    assert.equal(healthy.preview.changedAssets.length, 0);
    assert.equal(healthy.preview.reloadEligible, true);
    assert.deepEqual(healthy.preview.labels, MCP_LIFECYCLE_LABELS);
    assert.match(healthy.checks.find((item) => item.id === "compatibility-labels")?.detail ?? "", /rename deferred/i);

    writeLifecycleStatus(home, now, "terminating");
    const terminating = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 1,
    });
    assert.equal(terminating.preview.reloadEligible, false);
    assert.match(terminating.preview.reloadDeferredReason ?? "", /terminating/i);

    writeLifecycleStatus(home, new Date(now.getTime() - 181_000), "observed");
    const stale = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 1,
    });
    assert.equal(stale.preview.reloadEligible, false);
    assert.match(stale.preview.reloadDeferredReason ?? "", /stale|timestamp/i);
  });
});

test("managed lifecycle repair is idempotent and proves exact-one labels", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    const counts = new Map(MCP_LIFECYCLE_LABELS.map((label) => [label, 0]));
    let reloads = 0;
    const receipts: object[] = [];
    const labelInstances = (label: string): number => counts.get(label as typeof MCP_LIFECYCLE_LABELS[number]) ?? 0;
    const reload = (_home: string, labels: readonly string[]): void => {
      reloads += 1;
      for (const label of labels) counts.set(label as typeof MCP_LIFECYCLE_LABELS[number], 1);
    };
    const report = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances,
    });
    const inspect = () => inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath: join(userRoot, "mcp-lifecycle-managed.json"),
      deep: true,
    }, {
      now: () => now,
      labelInstances,
    });
    const first = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      report,
    }, {
      labelInstances,
      reload,
      inspect,
      now: () => now,
      writeReceipt: (path, value) => {
        receipts.push(value);
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      },
    });

    assert.equal(first.status, "installed");
    assert.equal(reloads, 1);
    assert.equal(receipts.length, 1);
    assert.equal(MCP_LIFECYCLE_LABELS.every((label) => labelInstances(label) === 1), true);
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(managedReceiptPath, JSON.stringify(receipts[0]), { mode: 0o600 });
    chmodSync(managedReceiptPath, 0o600);
    const managedProof = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelInstances,
    });
    assert.equal(
      managedProof.checks.find((item) => item.id === "managed-proof")?.status,
      "ok",
    );

    const secondReport = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelInstances,
    });
    const second = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      report: secondReport,
    }, {
      labelInstances,
      reload,
      inspect,
      now: () => now,
      writeReceipt: (path, value) => {
        receipts.push(value);
        writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
      },
    });

    assert.equal(second.status, "unchanged");
    assert.equal(reloads, 1);
    assert.equal(receipts.length, 2);

    const tamperedReceipt = {
      ...(receipts[0] as Record<string, unknown>),
      policyVersion: "unexpected",
    };
    writeFileSync(managedReceiptPath, JSON.stringify(tamperedReceipt));
    const incompatible = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelInstances,
    });
    assert.equal(
      incompatible.checks.find((item) => item.id === "managed-proof")?.status,
      "error",
    );
    const blocked = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      report: incompatible,
    }, {
      install: () => assert.fail("incompatible managed proof must block repair"),
      inspect,
      labelInstances,
      reload,
    });
    assert.equal(blocked.status, "deferred");
    assert.match(blocked.reason ?? "", /does not match/i);
  });
});

test("reload eligibility is re-read immediately before activation", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    const healthy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 0,
    });
    writeLifecycleStatus(home, now, "terminating");
    const terminating = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 0,
    });
    const reports = [healthy, terminating];
    let reloads = 0;

    assert.throws(() => repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      report: healthy,
    }, {
      inspect: () => reports.shift() ?? terminating,
      labelInstances: () => 0,
      reload: () => {
        reloads += 1;
      },
    }), /reload deferred|terminating/i);

    assert.equal(reloads, 0);
  });
});

test("first-label deferral performs no live mutation and triggers no rollback reload", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    writeLifecycleStatus(home, now, "observed");
    const healthy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 0,
    });
    writeLifecycleStatus(home, now, "terminating");
    const terminating = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 0,
    });
    const reports = [healthy, healthy, terminating];
    let liveMutations = 0;
    let reloadCalls = 0;

    assert.throws(() => repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot: defaultMcpLifecycleSourceRoot(),
      report: healthy,
    }, {
      inspect: () => reports.shift() ?? terminating,
      labelInstances: () => 0,
      reload: (_targetHome, _labels, beforeEach) => {
        reloadCalls += 1;
        beforeEach?.("com.thomashulihan.codex-mcp-idle-reaper");
        liveMutations += 1;
      },
    }), /reload deferred|terminating/i);

    assert.equal(reloadCalls, 1);
    assert.equal(liveMutations, 0);
  });
});

test("adopted reconciliation requires managed proof at the first live mutation", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const manifest = readMcpLifecycleManifest(sourceRoot);
    const receiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 1,
      packageVersion: manifest.package.version,
      lifecycleSchemaVersion: manifest.lifecycle_schema_version,
      policyVersion: manifest.policy_version,
      matcherRegistryVersion: manifest.matcher_registry_version,
      labels: MCP_LIFECYCLE_LABELS,
      assetDigests: Object.fromEntries(
        manifest.assets.map((asset) => [asset.id, asset.source_sha256]),
      ),
      adoptedAt: now.toISOString(),
      compatibility: "current labels and paths preserved; rename deferred",
    }), { mode: 0o600 });
    writeLifecycleStatus(home, now, "observed");
    const proofOk = inspectMcpLifecycleHealth({
      targetHome: home,
      sourceRoot,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath: receiptPath,
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 0,
    });
    assert.equal(
      proofOk.checks.find((item) => item.id === "managed-proof")?.status,
      "ok",
    );
    const proofMissing = {
      ...proofOk,
      checks: proofOk.checks.map((item) => item.id === "managed-proof"
        ? {
            ...item,
            status: "warn" as const,
            detail: "No managed-adoption receipt exists yet.",
          }
        : item),
    };
    const reports = [proofOk, proofOk, proofOk, proofMissing];
    let liveMutations = 0;
    let reloadCalls = 0;

    assert.throws(() => reconcileAdoptedMcpLifecycle({
      targetHome: home,
      userRoot,
    }, {
      inspect: () => reports.shift() ?? proofMissing,
      labelInstances: () => 0,
      reload: (_targetHome, _labels, beforeEach) => {
        reloadCalls += 1;
        beforeEach?.("com.thomashulihan.codex-mcp-idle-reaper");
        liveMutations += 1;
      },
    }), /reload deferred|managed-adoption receipt/i);

    assert.equal(reloadCalls, 1);
    assert.equal(liveMutations, 0);
  });
});

test("a lifecycle job cannot invoke managed reload", () => {
  assert.throws(() => repairMcpLifecycle({
    targetHome: "/tmp/unused-home",
    userRoot: "/tmp/unused-root",
  }, {
    lifecycleJob: "com.thomashulihan.codex-mcp-idle-reaper",
  }), /Refusing to reload MCP lifecycle jobs from inside/);
});

test("deep health preserves a privacy-safe legacy action receipt as a warning", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const now = new Date("2026-07-23T22:00:00.000Z");
    writeLifecycleStatus(home, now, "observed");
    const receiptPath = join(home, ".codex", "tmp", "codex-mcp-lifecycle-actions.jsonl");
    writeFileSync(receiptPath, `${JSON.stringify({
      timestamp: now.getTime() / 1_000,
      tree_key: "tree-a",
      state: "verified_gone",
      pids: [101, 102],
      error: null,
    })}\n`);

    const legacy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(root, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 1,
    });
    const legacyReceipt = legacy.checks.find((item) => item.id === "receipt");
    assert.equal(legacyReceipt?.status, "warn");
    assert.match(legacyReceipt?.detail ?? "", /privacy-safe legacy schema/i);

    writeFileSync(receiptPath, `${JSON.stringify({
      timestamp: now.getTime() / 1_000,
      tree_key: "tree-a",
      state: "verified_gone",
      pids: [101],
      error: null,
      raw_argv: "--token=secret",
    })}\n`);
    const unsafe = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(root, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelInstances: () => 1,
    });
    assert.equal(
      unsafe.checks.find((item) => item.id === "receipt")?.status,
      "error",
    );
  });
});

function writeLifecycleStatus(home: string, generatedAt: Date, state: string): void {
  const directory = join(home, ".codex", "tmp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "codex-mcp-lifecycle-status.json"), JSON.stringify({
    schema_version: 2,
    generated_at: generatedAt.getTime() / 1_000,
    job: { ok: true, mode: "automatic", error: null },
    counts: { would_kill: 0 },
    trees: [{ tree_key: "tree-a", state }],
  }));
  writeFileSync(join(directory, "codex-mcp-guard-status.json"), JSON.stringify({
    schema_version: 1,
    generated_at: generatedAt.getTime() / 1_000,
    policy_version: "notification-only-v1",
    job: { ok: true, mode: "observation", error: null },
  }));
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-health-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
