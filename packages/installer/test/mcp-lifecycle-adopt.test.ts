import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  adoptMcpLifecycle,
  mcpLifecycle,
  reconcileAdoptedMcpLifecycle,
  repairMcpLifecycle,
} from "../src/commands/mcp-lifecycle";
import type { McpLifecycleHealthReport } from "../src/mcp-lifecycle-health";
import {
  MCP_LIFECYCLE_LABELS,
  defaultMcpLifecycleSourceRoot,
  installMcpLifecyclePackage,
  verifyMcpLifecyclePackage,
} from "../src/mcp-lifecycle-install";
import { lifecycleLockFile } from "../src/lifecycle-lock";
import { acquireProcessLock } from "../src/process-lock";

const PREDECESSOR_DIGESTS = {
  "lifecycle-module": "ea11134783f411b3a88880f2eec61e4012cfa7c378ebf1f81f89d233c82ab81b",
  "idle-reaper": "2bbb4ce35ff8b7687a6c4d35f9014c4d8dcfcfeac27943955f5b1c28681ce107",
  guard: "4d152c788759395bde1296e8197fb91a8187d480e0192fa3aa7f0f155e3185ed",
  "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
  "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
};

const VERSION_030_DIGESTS = {
  "lifecycle-module": "6e3f830ffda5d476bebf4900f6d9add274d2a2893c0e1cf6b02c0f3f4b2eadb3",
  "idle-reaper": "963cf893e0832706662ad04d1d297c15ccc4e03358c70e1ca4522892e3f73999",
  guard: "b32d7583b43ef1c1119bba2dc3cc6a2a42c79e8a6cd404a5c26592f4d8f98c58",
  "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
  "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
};

const VERSION_031_DIGESTS = {
  "lifecycle-module": "90669677b9d694290c33ce4b18d6547a50afd464bce1d95367dbb28b3a7ba946",
  "idle-reaper": "963cf893e0832706662ad04d1d297c15ccc4e03358c70e1ca4522892e3f73999",
  guard: "59b0c1d7e78fe978f74734f0f231a4b4c80f1366dfcafd637e07abffc14617bb",
  "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
  "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
};

const VERSION_040_DIGESTS = {
  "lifecycle-module": "4021016ed4a6e9883377e5cf07c47111f069ea665ff50e2e35584ba3c20aae6f",
  "idle-reaper": "9cdca57a1c612be0dadd1e8b70e0cd068998815ca88b70bf5e2470573e34db8e",
  guard: "f10b9e98d117929c2b2d19b4a651fcdb60dcfd4760a78bfc482ae031a449b3a9",
  "idle-reaper-launch-agent": "181fde0af89fda70eddc4dba5a6a13e2057e0d5a534a60e9147bf875c8a6f1ac",
  "guard-launch-agent": "56c8127ff1b2adf539b2bff14df5c5dee2ae92481306c808366498353ddbb43c",
};

test("explicit adopt upgrades exactly the recognized v2 managed receipt", () => {
  withFixture((fixture) => {
    const result = adoptMcpLifecycle(fixture.input(), fixture.dependencies());
    assert.equal(result.status, "installed");
    assert.equal(fixture.reloads(), 1);
    const receipt = fixture.receipt();
    assert.equal(receipt.packageVersion, "0.4.1");
    assert.equal(receipt.policyVersion, "strict-detached-v4");
    assert.equal(receipt.matcherRegistryVersion, "mcp-family-descriptors-v4");
    assert.deepEqual(receipt.labels, MCP_LIFECYCLE_LABELS);
  });
});

test("explicit adopt upgrades exactly the recognized 0.3.0 managed receipt", () => {
  withFixture((fixture) => {
    fixture.writeReceipt({
      packageVersion: "0.3.0",
      lifecycleSchemaVersion: 2,
      policyVersion: "strict-detached-v3",
      matcherRegistryVersion: "mcp-family-descriptors-v2",
      assetDigests: VERSION_030_DIGESTS,
    });

    const result = adoptMcpLifecycle(fixture.input(), fixture.dependencies());

    assert.equal(result.status, "installed");
    assert.equal(fixture.receipt().packageVersion, "0.4.1");
    assert.equal(fixture.receipt().matcherRegistryVersion, "mcp-family-descriptors-v4");
  });
});

test("explicit adopt upgrades exactly the recognized 0.3.1 managed receipt", () => {
  withFixture((fixture) => {
    fixture.writeReceipt({
      packageVersion: "0.3.1",
      lifecycleSchemaVersion: 2,
      policyVersion: "strict-detached-v3",
      matcherRegistryVersion: "mcp-family-descriptors-v3",
      assetDigests: VERSION_031_DIGESTS,
    });

    const result = adoptMcpLifecycle(fixture.input(), fixture.dependencies());

    assert.equal(result.status, "installed");
    assert.equal(fixture.receipt().packageVersion, "0.4.1");
    assert.equal(fixture.receipt().policyVersion, "strict-detached-v4");
  });
});

test("explicit adopt upgrades exactly the recognized 0.4.0 managed receipt", () => {
  withFixture((fixture) => {
    fixture.writeReceipt({
      packageVersion: "0.4.0",
      lifecycleSchemaVersion: 2,
      policyVersion: "strict-detached-v4",
      matcherRegistryVersion: "mcp-family-descriptors-v4",
      assetDigests: VERSION_040_DIGESTS,
    });

    const result = adoptMcpLifecycle(fixture.input(), fixture.dependencies());

    assert.equal(result.status, "installed");
    assert.equal(fixture.receipt().packageVersion, "0.4.1");
    assert.equal(fixture.receipt().policyVersion, "strict-detached-v4");
  });
});

test("explicit adopt preview prerequisites reject absent, unsafe, and unrecognized prior receipts without mutation", () => {
  const cases: Array<{ name: string; mutate: (fixture: Fixture) => void }> = [
    { name: "absent", mutate: (fixture) => unlinkSync(fixture.receiptPath) },
    {
      name: "symlink",
      mutate: (fixture) => {
        const target = join(fixture.root, "receipt-target.json");
        renameSync(fixture.receiptPath, target);
        symlinkSync(target, fixture.receiptPath);
      },
    },
    {
      name: "nonregular",
      mutate: (fixture) => {
        unlinkSync(fixture.receiptPath);
        mkdirSync(fixture.receiptPath);
      },
    },
    {
      name: "hard linked",
      mutate: (fixture) => linkSync(fixture.receiptPath, join(fixture.root, "receipt-hardlink.json")),
    },
    { name: "wrong mode", mutate: (fixture) => chmodSync(fixture.receiptPath, 0o644) },
    {
      name: "semantic corruption",
      mutate: (fixture) => fixture.writeReceipt({ policyVersion: "strict-detached-v999" }),
    },
  ];
  for (const scenario of cases) {
    withFixture((fixture) => {
      const before = fixture.snapshot();
      scenario.mutate(fixture);
      const afterReceiptChange = fixture.snapshot();
      assert.throws(() => adoptMcpLifecycle(fixture.input(), fixture.dependencies()), /receipt|required|predecessor|managed/i, scenario.name);
      assert.equal(fixture.reloads(), 0, scenario.name);
      assert.deepEqual(fixture.assetSnapshot(), before.assets, scenario.name);
      // The only allowed difference is the caller's deliberately malformed
      // proof; adoption itself must not write a replacement receipt.
      assert.equal(fixture.receiptBytesOrNull(), afterReceiptChange.receipt, scenario.name);
    });
  }
});

test("explicit adopt rolls back assets and services when receipt publication fails", () => {
  withFixture((fixture) => {
    const before = fixture.snapshot();
    let writes = 0;
    assert.throws(() => adoptMcpLifecycle(fixture.input(), fixture.dependencies({
      writeReceipt: () => {
        writes += 1;
        throw new Error("simulated receipt writer failure");
      },
    })), /receipt writer failure/i);
    assert.equal(writes, 1);
    assert.deepEqual(fixture.snapshot().assets, before.assets);
    assert.equal(fixture.receiptBytesOrNull(), before.receipt);
    assert.equal(fixture.reloads(), 2, "activate then restore the prior labels");
  });
});

test("receipt disappearance, byte, and inode changes before promote or reload abort and restore installed assets", () => {
  const cases = [
    {
      name: "disappearance before promote",
      beforeInstallStep: (fixture: Fixture, step: string) => {
        if (step === "before-promote") unlinkSync(fixture.receiptPath);
      },
    },
    {
      name: "byte drift before promote",
      beforeInstallStep: (fixture: Fixture, step: string) => {
        if (step === "before-promote") fixture.writeReceipt({ adoptedAt: "2026-07-25T00:00:00.000Z" });
      },
    },
    {
      name: "inode drift before promote",
      beforeInstallStep: (fixture: Fixture, step: string) => {
        if (step === "before-promote") fixture.replaceReceiptWithIdenticalBytes();
      },
    },
    {
      name: "inode drift before reload",
      reload: (fixture: Fixture, beforeEach?: (label: string) => void) => {
        fixture.replaceReceiptWithIdenticalBytes();
        beforeEach?.(MCP_LIFECYCLE_LABELS[0]);
      },
    },
  ];
  for (const scenario of cases) {
    withFixture((fixture) => {
      const before = fixture.snapshot();
      const deps = fixture.dependencies({
        beforeInstallStep: scenario.beforeInstallStep ? (step) => scenario.beforeInstallStep?.(fixture, step) : undefined,
        reload: scenario.reload ? (_home, _labels, beforeEach) => {
          fixture.markReload();
          scenario.reload?.(fixture, beforeEach);
        } : undefined,
      });
      assert.throws(() => adoptMcpLifecycle(fixture.input(), deps), /receipt changed/i, scenario.name);
      assert.deepEqual(fixture.assetSnapshot(), before.assets, scenario.name);
      if (scenario.name.includes("inode")) {
        assert.equal(fixture.receiptBytesOrNull(), before.receipt, scenario.name);
      }
    });
  }
});

test("receipt identity and label/status proof are rechecked at the final commit point", () => {
  for (const kind of ["receipt", "label", "status"] as const) {
    withFixture((fixture) => {
      const before = fixture.snapshot();
      let labelReads = 0;
      const stale = {
        ...fixture.eligibleReport(),
        preview: {
          ...fixture.eligibleReport().preview,
          reloadEligible: false,
          reloadDeferredReason: "lifecycle status became stale",
        },
      };
      let inspections = 0;
      const deps = fixture.dependencies({
        inspect: () => {
          inspections += 1;
          return kind === "status" && inspections >= 3 ? stale : fixture.eligibleReport();
        },
        labelInstances: (label: string) => {
          labelReads += 1;
          if (kind === "receipt" && labelReads === 5) fixture.replaceReceiptWithIdenticalBytes();
          if (kind === "label" && labelReads === 5) return 0;
          return 1;
        },
        reload: (_home: string, labels: readonly string[], beforeEach?: (label: string) => void) => {
          for (const label of labels) beforeEach?.(label);
        },
      });
      assert.throws(() => adoptMcpLifecycle(fixture.input(), deps), /receipt changed|Expected exactly one|status became stale|reload deferred/i, kind);
      assert.deepEqual(fixture.assetSnapshot(), before.assets, kind);
      assert.equal(fixture.receiptBytesOrNull(), before.receipt, kind);
    });
  }
});

test("final receipt commit re-proves source and installed destinations", () => {
  for (const kind of ["source", "destination"] as const) {
    withFixture((fixture) => {
      const before = fixture.snapshot();
      let inspections = 0;
      const deps = fixture.dependencies({
        inspect: () => {
          inspections += 1;
          if (inspections === 2) {
            if (kind === "source") fixture.mutateCanonicalSource();
            else fixture.mutateInstalledDestination();
          }
          return fixture.eligibleReport();
        },
      });
      assert.throws(() => adoptMcpLifecycle(fixture.input(), deps), /proof failed|digest mismatch|asset/i, kind);
      assert.equal(fixture.receiptBytesOrNull(), before.receipt, kind);
    });
  }
});

test("unchanged assets publish only the upgraded receipt and preserve the prior proof on failure", () => {
  withFixture((fixture) => {
    // First upgrade produces current installed assets and receipt.
    adoptMcpLifecycle(fixture.input(), fixture.dependencies());
    const afterUpgrade = fixture.snapshot();
    const success = repairMcpLifecycle({ ...fixture.input(), report: fixture.eligibleReport("ok") }, fixture.dependencies());
    assert.equal(success.status, "unchanged");
    assert.deepEqual(fixture.assetSnapshot(), afterUpgrade.assets);
    assert.equal(fixture.reloads(), 1, "unchanged healthy assets must not reload services");

    const priorReceipt = fixture.receiptBytesOrNull();
    assert.throws(() => repairMcpLifecycle({ ...fixture.input(), report: fixture.eligibleReport("ok") }, fixture.dependencies({
      writeReceipt: () => { throw new Error("receipt-only failure"); },
    })), /receipt-only failure/);
    assert.deepEqual(fixture.assetSnapshot(), afterUpgrade.assets);
    assert.equal(fixture.receiptBytesOrNull(), priorReceipt);
  });
});

test("ordinary and automatic reconciliation refuse a stale managed proof before live mutation", () => {
  withFixture((fixture) => {
    fixture.writeReceipt({ policyVersion: "strict-detached-v999" });
    const report = fixture.eligibleReport("error");
    const deps = fixture.dependencies({
      install: () => assert.fail("stale proof must block install"),
    });
    const ordinary = repairMcpLifecycle({ ...fixture.input(), report }, deps);
    assert.equal(ordinary.status, "deferred");
    assert.equal(fixture.reloads(), 0);
    assert.throws(() => reconcileAdoptedMcpLifecycle(fixture.input(), deps), /receipt|proof/i);
    assert.equal(fixture.reloads(), 0);
  });
});

test("the explicit adopt command honors shared lifecycle-lock contention before it can mutate", async () => {
  await withFixtureAsync(async (fixture) => {
    const previousHome = process.env.TWEAKER_HOME;
    process.env.TWEAKER_HOME = fixture.root;
    const lock = acquireProcessLock(lifecycleLockFile(fixture.root));
    const before = fixture.snapshot();
    try {
      await assert.rejects(
        mcpLifecycle("adopt", { apply: true, source: fixture.input().sourceRoot }),
        /Another Tweakers lifecycle operation is active/i,
      );
      assert.deepEqual(fixture.snapshot(), before);
      assert.equal(fixture.reloads(), 0);
    } finally {
      lock.release();
      if (previousHome === undefined) delete process.env.TWEAKER_HOME;
      else process.env.TWEAKER_HOME = previousHome;
    }
  });
});

test("the explicit adopt command preview rejects an unrecognized predecessor before any apply", async () => {
  await withFixtureAsync(async (fixture) => {
    const previousHome = process.env.TWEAKER_HOME;
    process.env.TWEAKER_HOME = fixture.root;
    const before = fixture.snapshot();
    try {
      writeFileSync(fixture.receiptPath, `${JSON.stringify({
        ...fixture.receipt(), policyVersion: "strict-detached-v999",
      })}\n`, { mode: 0o600 });
      chmodSync(fixture.receiptPath, 0o600);
      await assert.rejects(
        mcpLifecycle("adopt", { source: fixture.input().sourceRoot }),
        /exact recognized predecessor/i,
      );
      assert.deepEqual(fixture.assetSnapshot(), before.assets);
    } finally {
      if (previousHome === undefined) delete process.env.TWEAKER_HOME;
      else process.env.TWEAKER_HOME = previousHome;
    }
  });
});

interface Fixture {
  root: string;
  receiptPath: string;
  input(): { targetHome: string; userRoot: string; sourceRoot: string; report: McpLifecycleHealthReport };
  dependencies(overrides?: Record<string, unknown>): Parameters<typeof adoptMcpLifecycle>[1];
  eligibleReport(proof?: "ok" | "error"): McpLifecycleHealthReport;
  receipt(): Record<string, unknown>;
  writeReceipt(patch: Record<string, unknown>): void;
  receiptBytesOrNull(): string | null;
  assetSnapshot(): Record<string, string>;
  snapshot(): { assets: Record<string, string>; receipt: string | null };
  replaceReceiptWithIdenticalBytes(): void;
  mutateCanonicalSource(): void;
  mutateInstalledDestination(): void;
  markReload(): void;
  reloads(): number;
}

function withFixture(run: (fixture: Fixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-adopt-"));
  const home = join(root, "home");
  const userRoot = join(root, "tweakers");
  const sourceRoot = join(root, "source");
  const receiptPath = join(userRoot, "mcp-lifecycle-managed.json");
  const counts = new Map(MCP_LIFECYCLE_LABELS.map((label) => [label, 0]));
  let reloadCount = 0;
  try {
    cpSync(defaultMcpLifecycleSourceRoot(), sourceRoot, { recursive: true });
    writeStatus(home);
    installMcpLifecyclePackage({ sourceRoot, targetHome: home, temporaryRoot: home, labelInstances: () => 0 });
    const assets = verifyMcpLifecyclePackage({ sourceRoot, targetHome: home }).assets;
    // A v2 installation differs from current immutable assets; this forces the
    // transaction through promotion, activation, and receipt publication.
    writeFileSync(assets[0].destinationPath, "v2 lifecycle module\n", { mode: assets[0].mode });
    mkdirSync(userRoot, { recursive: true });
    const writePrior = (patch: Record<string, unknown> = {}): void => {
      const receipt = {
        schemaVersion: 1,
        packageVersion: "0.2.1",
        lifecycleSchemaVersion: 2,
        policyVersion: "strict-detached-v2",
        matcherRegistryVersion: "mcp-family-descriptors-v1",
        labels: [...MCP_LIFECYCLE_LABELS],
        assetDigests: PREDECESSOR_DIGESTS,
        adoptedAt: "2026-07-24T00:00:00.000Z",
        compatibility: "current labels and paths preserved; rename deferred",
        ...patch,
      };
      writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      chmodSync(receiptPath, 0o600);
    };
    writePrior();
    const eligibleReport = (proof: "ok" | "error" = "error"): McpLifecycleHealthReport => ({
      schemaVersion: 1,
      checkedAt: "2026-07-24T00:00:00.000Z",
      status: proof === "ok" ? "ok" : "error",
      title: "test report",
      checks: [{
        id: "managed-proof",
        name: "Managed artifact proof",
        status: proof,
        detail: proof === "ok" ? "ok" : "stale managed proof",
        recommendedAction: null,
      }],
      preview: {
        sourceRoot,
        targetHome: home,
        changedAssets: [],
        labels: MCP_LIFECYCLE_LABELS,
        preservedRuntimeFiles: [],
        reloadEligible: true,
        reloadDeferredReason: null,
        reloadPlan: [],
        rollbackPlan: [],
      },
    });
    const fixture: Fixture = {
      root,
      receiptPath,
      input: () => ({ targetHome: home, userRoot, sourceRoot, report: eligibleReport() }),
      dependencies: (overrides = {}) => ({
        labelInstances: (label: string) => counts.get(label as typeof MCP_LIFECYCLE_LABELS[number]) ?? 0,
        reload: (_targetHome, labels, beforeEach) => {
          reloadCount += 1;
          for (const label of labels) {
            beforeEach?.(label);
            counts.set(label as typeof MCP_LIFECYCLE_LABELS[number], 1);
          }
        },
        inspect: () => eligibleReport("ok"),
        now: () => new Date("2026-07-24T00:00:00.000Z"),
        ...overrides,
      }) as Parameters<typeof adoptMcpLifecycle>[1],
      eligibleReport,
      receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>,
      writeReceipt: (patch) => {
        const current = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
        writeFileSync(receiptPath, `${JSON.stringify({ ...current, ...patch })}\n`, { mode: 0o600 });
        chmodSync(receiptPath, 0o600);
      },
      receiptBytesOrNull: () => existsSync(receiptPath) && lstatSync(receiptPath).isFile()
        ? readFileSync(receiptPath, "utf8")
        : null,
      assetSnapshot: () => Object.fromEntries(assets.map((asset) => [
        asset.asset.id,
        existsSync(asset.destinationPath) ? readFileSync(asset.destinationPath, "utf8") : "<missing>",
      ])),
      snapshot: () => ({ assets: fixture.assetSnapshot(), receipt: fixture.receiptBytesOrNull() }),
      replaceReceiptWithIdenticalBytes: () => {
        const replacement = join(root, `receipt-replacement-${Date.now()}.json`);
        writeFileSync(replacement, readFileSync(receiptPath), { mode: 0o600 });
        chmodSync(replacement, 0o600);
        renameSync(replacement, receiptPath);
      },
      mutateCanonicalSource: () => writeFileSync(join(sourceRoot, "assets", "lib", "codex_mcp_lifecycle.py"), "tampered\n"),
      mutateInstalledDestination: () => writeFileSync(assets[1].destinationPath, "tampered\n", { mode: assets[1].mode }),
      markReload: () => { reloadCount += 1; },
      reloads: () => reloadCount,
    };
    run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withFixtureAsync(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-adopt-"));
  const home = join(root, "home");
  const sourceRoot = join(root, "source");
  const receiptPath = join(root, "mcp-lifecycle-managed.json");
  try {
    cpSync(defaultMcpLifecycleSourceRoot(), sourceRoot, { recursive: true });
    mkdirSync(root, { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      packageVersion: "0.2.1",
      lifecycleSchemaVersion: 2,
      policyVersion: "strict-detached-v2",
      matcherRegistryVersion: "mcp-family-descriptors-v1",
      labels: [...MCP_LIFECYCLE_LABELS],
      assetDigests: PREDECESSOR_DIGESTS,
      adoptedAt: "2026-07-24T00:00:00.000Z",
      compatibility: "current labels and paths preserved; rename deferred",
    })}\n`, { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    const fixture: Fixture = {
      root,
      receiptPath,
      input: () => ({ targetHome: home, userRoot: root, sourceRoot, report: {
        schemaVersion: 1, checkedAt: "2026-07-24T00:00:00.000Z", status: "ok", title: "test", checks: [],
        preview: { sourceRoot, targetHome: home, changedAssets: [], labels: MCP_LIFECYCLE_LABELS, preservedRuntimeFiles: [], reloadEligible: true, reloadDeferredReason: null, reloadPlan: [], rollbackPlan: [] },
      } }),
      dependencies: () => ({}),
      eligibleReport: () => fixture.input().report,
      receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>,
      writeReceipt: () => {},
      receiptBytesOrNull: () => existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null,
      assetSnapshot: () => ({}),
      snapshot: () => ({ assets: {}, receipt: existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : null }),
      replaceReceiptWithIdenticalBytes: () => {}, mutateCanonicalSource: () => {}, mutateInstalledDestination: () => {}, markReload: () => {}, reloads: () => 0,
    };
    await run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeStatus(home: string): void {
  const directory = join(home, ".codex", "tmp");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "codex-mcp-lifecycle-status.json"), JSON.stringify({
    schema_version: 2,
    generated_at: Date.parse("2026-07-24T00:00:00.000Z") / 1_000,
    job: { ok: true, mode: "automatic", error: null },
    counts: { would_kill: 0 },
    trees: [{ tree_key: "tree-a", state: "observed" }],
  }));
  writeFileSync(join(directory, "codex-mcp-guard-status.json"), JSON.stringify({
    schema_version: 1,
    generated_at: Date.parse("2026-07-24T00:00:00.000Z") / 1_000,
    policy_version: "notification-only-v1",
    job: { ok: true, mode: "observation", error: null },
  }));
}
