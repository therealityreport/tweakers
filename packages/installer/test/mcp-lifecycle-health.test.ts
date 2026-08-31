import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  reconcileAdoptedMcpLifecycle,
  repairMcpLifecycle,
} from "../src/commands/mcp-lifecycle";
import { inspectMcpLifecycleHealth } from "../src/mcp-lifecycle-health";
import {
  MCP_LIFECYCLE_GUARD_LABEL,
  MCP_LIFECYCLE_LABELS,
  MCP_LIFECYCLE_REAPER_LABEL,
  defaultMcpLifecycleSourceRoot,
  expectedMcpLifecycleLabelStates,
  installMcpLifecyclePackage,
  readMcpLifecycleManifest,
  verifyMcpLifecyclePackage,
  type McpLifecycleLabelState,
} from "../src/mcp-lifecycle-install";

const intentionallyDisabledGuard = (
  expected: readonly McpLifecycleLabelState[],
): readonly McpLifecycleLabelState[] => expected.map((state) => ({
  ...state,
  disabled: state.label === MCP_LIFECYCLE_GUARD_LABEL,
  loadedInstances: state.label === MCP_LIFECYCLE_REAPER_LABEL ? 1 as const : 0 as const,
}));

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
      labelStates: intentionallyDisabledGuard,
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
      labelStates: intentionallyDisabledGuard,
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
      labelStates: intentionallyDisabledGuard,
    });
    assert.equal(stale.preview.reloadEligible, false);
    assert.match(stale.preview.reloadDeferredReason ?? "", /stale|timestamp/i);
  });
});

test("repair preview preserves observed policy and path while declaring candidate plist identities", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const now = new Date("2026-07-23T22:00:00.000Z");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    installMcpLifecyclePackage({ sourceRoot, targetHome: home, temporaryRoot: home });
    writeLifecycleStatus(home, now, "observed");

    const candidateStates = expectedMcpLifecycleLabelStates(
      verifyMcpLifecyclePackage({ sourceRoot, targetHome: home }),
    );
    const oldStates = candidateStates.map((candidate) => {
      const oldPlist = Buffer.from(`old ${candidate.label} plist bytes`, "utf8");
      writeFileSync(candidate.plistPath, oldPlist);
      return {
        ...candidate,
        disabled: candidate.label === MCP_LIFECYCLE_GUARD_LABEL ? false : candidate.disabled,
        loadedInstances: candidate.label === MCP_LIFECYCLE_GUARD_LABEL ? 1 as const : candidate.loadedInstances,
        plistSha256: createHash("sha256").update(oldPlist).digest("hex"),
      };
    });

    const report = inspectMcpLifecycleHealth({
      targetHome: home,
      sourceRoot,
      backupRoot: join(root, "backup"),
      deep: true,
    }, {
      now: () => now,
      labelStates: (expected) => {
        assert.deepEqual(expected, candidateStates);
        return oldStates;
      },
    });

    for (const candidate of candidateStates) {
      const before = oldStates.find((state) => state.label === candidate.label);
      const transition = report.preview.labelTransitions.find((item) => item.label === candidate.label);
      assert.ok(before);
      assert.ok(transition);
      assert.deepEqual(transition.before, before);
      assert.notEqual(transition.before?.plistSha256, candidate.plistSha256);
      assert.notDeepEqual(transition.before, transition.intended);
      assert.equal(transition.intended?.plistSha256, candidate.plistSha256);
      assert.equal(transition.intended?.label, before.label);
      assert.equal(transition.intended?.disabled, before.disabled);
      assert.equal(transition.intended?.loadedInstances, before.loadedInstances);
      assert.equal(transition.intended?.plistPath, before.plistPath);
    }
  });
});

test("an enabled Guard requires a complete fresh v3 heartbeat before repair can mutate", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    const guardStatusPath = join(home, ".codex", "tmp", "codex-mcp-guard-status.json");
    const lifecycleStatusPath = join(home, ".codex", "tmp", "codex-mcp-lifecycle-status.json");
    const lifecycleModulePath = join(home, ".codex", "lib", "codex_mcp_lifecycle.py");
    const enabledGuard = (expected: readonly McpLifecycleLabelState[]): readonly McpLifecycleLabelState[] => expected.map((state) => ({
      ...state,
      disabled: false,
      loadedInstances: 1 as const,
    }));

    mkdirSync(userRoot, { recursive: true });
    installMcpLifecyclePackage({ sourceRoot, targetHome: home, temporaryRoot: home });
    writeCurrentManagedReceipt({ sourceRoot, targetHome: home, receiptPath: managedReceiptPath, now });
    writeLifecycleStatus(home, now, "observed");
    writeFileSync(lifecycleModulePath, "drifted lifecycle module\n");

    const valid = inspectMcpLifecycleHealth({
      targetHome: home,
      sourceRoot,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, { now: () => now, labelStates: enabledGuard });
    assert.equal(valid.checks.find((item) => item.id === "status:guard")?.status, "ok");
    assert.equal(valid.preview.reloadEligible, true);

    const invalidFixtures: ReadonlyArray<readonly [string, () => void]> = [
      ["missing", () => rmSync(guardStatusPath)],
      ["legacy", () => writeFileSync(guardStatusPath, JSON.stringify({
        schema_version: 1,
        generated_at: now.getTime() / 1_000,
        job: { ok: true },
      }))],
      ["stale", () => writeGuardStatus(home, new Date(now.getTime() - 181_000))],
      ["future-numeric-timestamp", () => writeGuardStatus(home, now, {
        generated_at: now.getTime() / 1_000 + 60,
      })],
      ["ISO-timestamp", () => writeGuardStatus(home, now, { generated_at: now.toISOString() })],
      ["schema-only", () => writeFileSync(guardStatusPath, JSON.stringify({
        schema: "mcp-guard-status.v3",
        schema_version: 3,
      }))],
      ["job-only", () => writeGuardStatus(home, now, { job: { ok: true } })],
      ["producer", () => writeGuardStatus(home, now, { producer_version: "unexpected" })],
      ["authority", () => writeGuardStatus(home, now, { authority: "mutation-capable" })],
      ["task-data-access", () => writeGuardStatus(home, now, { taskDataAccess: "read" })],
      ["mutation-capabilities", () => writeGuardStatus(home, now, { mutationCapabilities: ["signal"] })],
      ["matcher", () => writeGuardStatus(home, now, { matcher: {
        expected: "unexpected",
        observed: "unexpected",
        freshness: "fresh",
        lifecycle_generated_at: now.getTime() / 1_000,
      } })],
      ["job-false", () => writeGuardStatus(home, now, { job: { ok: false, mode: "observation", error: "unavailable" } })],
      ["state-producer", () => writeGuardStatus(home, now, { selected_producer: "warning" })],
      ["reasons", () => writeGuardStatus(home, now, { unavailable_reasons: [{ code: "missing", detail: "x" }] })],
      ["alerts", () => writeGuardStatus(home, now, { alerts: [{
        id: "unexpected", kind: "unexpected", message: "x", evidence: {},
      }] })],
      ["sample-count", () => writeGuardStatus(home, now, { sample_count: 6 })],
      ["cpu-window", () => writeGuardStatus(home, now, { cpu_window: {
        samples: 1, available: true, core_fractions: [], minimum_core_fraction: 0,
      } })],
      ["system-memory", () => writeGuardStatus(home, now, { system_memory: {
        available: true, physical_ram_mib: 1, available_mib: 1, available_pct: 101, swap: { available: false },
      } })],
      ["forbidden-legacy-fields", () => writeGuardStatus(home, now, {
        task_data: "unexpected", archived_task: "unexpected", retention: "unexpected", spawn_edge: "unexpected",
      })],
      ["companion-schema", () => writeFileSync(lifecycleStatusPath, JSON.stringify({
        schema_version: 1,
        generated_at: now.getTime() / 1_000,
        matcher_registry_version: readMcpLifecycleManifest(sourceRoot).matcher_registry_version,
        job: { ok: true, mode: "automatic", error: null },
        counts: {},
        trees: [],
      }))],
      ["companion-matcher", () => writeFileSync(lifecycleStatusPath, JSON.stringify({
        schema_version: 2,
        generated_at: now.getTime() / 1_000,
        matcher_registry_version: "unexpected",
        job: { ok: true, mode: "automatic", error: null },
        counts: {},
        trees: [],
      }))],
      ["companion-counts-trees", () => writeFileSync(lifecycleStatusPath, JSON.stringify({
        schema_version: 2,
        generated_at: now.getTime() / 1_000,
        matcher_registry_version: readMcpLifecycleManifest(sourceRoot).matcher_registry_version,
        job: { ok: true, mode: "automatic", error: null },
        counts: [],
        trees: {},
      }))],
      ["malformed", () => writeGuardStatus(home, now, { counts: {} })],
    ];

    for (const [fixture, writeInvalidStatus] of invalidFixtures) {
      writeLifecycleStatus(home, now, "observed");
      writeInvalidStatus();
      const beforeAsset = readFileSync(lifecycleModulePath);
      const beforeReceipt = readFileSync(managedReceiptPath, "utf8");
      const report = inspectMcpLifecycleHealth({
        targetHome: home,
        sourceRoot,
        backupRoot: join(userRoot, "backup"),
        managedReceiptPath,
        deep: true,
      }, { now: () => now, labelStates: enabledGuard });
      let installs = 0;
      let receiptWrites = 0;
      let reloads = 0;

      assert.equal(report.checks.find((item) => item.id === "status:guard")?.status, "error", fixture);
      assert.equal(report.preview.reloadEligible, false, fixture);
      assert.match(report.preview.reloadDeferredReason ?? "", /Guard heartbeat problem/i, fixture);
      assert.ok(report.preview.changedAssets.length > 0, fixture);

      const result = repairMcpLifecycle({
        targetHome: home,
        userRoot,
        sourceRoot,
        report,
      }, {
        install: () => {
          installs += 1;
          assert.fail(`${fixture} Guard heartbeat must block installation`);
        },
        writeReceipt: () => {
          receiptWrites += 1;
          assert.fail(`${fixture} Guard heartbeat must block receipt publication`);
        },
        reload: () => {
          reloads += 1;
          assert.fail(`${fixture} Guard heartbeat must block reload`);
        },
      });

      assert.equal(result.status, "deferred", fixture);
      assert.match(result.reason ?? "", /Guard heartbeat problem/i, fixture);
      assert.equal(installs, 0, fixture);
      assert.equal(receiptWrites, 0, fixture);
      assert.equal(reloads, 0, fixture);
      assert.deepEqual(readFileSync(lifecycleModulePath), beforeAsset, fixture);
      assert.equal(readFileSync(managedReceiptPath, "utf8"), beforeReceipt, fixture);
    }
  });
});

test("managed lifecycle repair is idempotent and proves exact-one labels", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    writeCurrentManagedReceipt({ sourceRoot, targetHome: home, receiptPath: managedReceiptPath, now });
    const counts = new Map(MCP_LIFECYCLE_LABELS.map((label) => [
      label,
      label === MCP_LIFECYCLE_REAPER_LABEL ? 1 : 0,
    ]));
    let reloads = 0;
    const receipts: object[] = [];
    const labelInstances = (label: string): number => counts.get(label as typeof MCP_LIFECYCLE_LABELS[number]) ?? 0;
    const labelStates = (expected: readonly McpLifecycleLabelState[]): readonly McpLifecycleLabelState[] => expected.map((state) => {
      const loadedInstances = labelInstances(state.label) as 0 | 1;
      return {
        ...state,
        disabled: state.label === MCP_LIFECYCLE_GUARD_LABEL ? loadedInstances === 0 : false,
        loadedInstances,
      };
    });
    const reload = (_home: string, labels: readonly string[]): void => {
      reloads += 1;
      for (const label of labels) counts.set(label as typeof MCP_LIFECYCLE_LABELS[number], 1);
    };
    const report = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates,
      labelInstances,
    });
    const inspect = () => inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates,
      labelInstances,
    });
    const first = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report,
    }, {
      labelStates,
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
    assert.equal(labelInstances(MCP_LIFECYCLE_REAPER_LABEL), 1);
    assert.equal(labelInstances(MCP_LIFECYCLE_GUARD_LABEL), 0);
    writeFileSync(managedReceiptPath, JSON.stringify(receipts[0]), { mode: 0o600 });
    chmodSync(managedReceiptPath, 0o600);
    const managedProof = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates,
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
      labelStates,
      labelInstances,
    });
    const second = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: secondReport,
    }, {
      labelStates,
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
      labelStates,
      labelInstances,
    });
    assert.equal(
      incompatible.checks.find((item) => item.id === "managed-proof")?.status,
      "error",
    );
    const blocked = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: incompatible,
    }, {
      install: () => assert.fail("incompatible managed proof must block repair"),
      inspect,
      labelStates,
      labelInstances,
      reload,
    });
    assert.equal(blocked.status, "deferred");
    assert.match(blocked.reason ?? "", /does not match/i);
  });
});

test("disabled Guard remains intentionally unloaded through unchanged repair and inconsistent pairs defer", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    installMcpLifecyclePackage({ sourceRoot, targetHome: home, temporaryRoot: home });
    writeCurrentManagedReceipt({ sourceRoot, targetHome: home, receiptPath: managedReceiptPath, now });
    rmSync(join(home, ".codex", "tmp", "codex-mcp-guard-status.json"));

    const health = inspectMcpLifecycleHealth({
      targetHome: home,
      sourceRoot,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, { now: () => now, labelStates: intentionallyDisabledGuard });
    assert.equal(health.checks.find((item) => item.id === `job:${MCP_LIFECYCLE_GUARD_LABEL}`)?.status, "ok");
    assert.match(health.checks.find((item) => item.id === "status:guard")?.detail ?? "", /intentionally disabled/i);
    assert.equal(health.preview.reloadEligible, true);
    assert.equal(
      health.preview.labelTransitions.find((transition) => transition.label === MCP_LIFECYCLE_GUARD_LABEL)?.operation,
      "preserve-disabled-unloaded",
    );

    const reloaded: string[][] = [];
    const unchanged = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: health,
    }, {
      labelStates: intentionallyDisabledGuard,
      inspect: () => health,
      reload: (_targetHome, labels) => reloaded.push([...labels]),
      now: () => now,
    });
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(reloaded, [], "unchanged candidate never touches either launchd label");

    const inconsistent = (expected: readonly McpLifecycleLabelState[]) => intentionallyDisabledGuard(expected).map((state) => (
      state.label === MCP_LIFECYCLE_GUARD_LABEL
        ? { ...state, disabled: true, loadedInstances: 1 as const }
        : state
    ));
    const unsafe = inspectMcpLifecycleHealth({
      targetHome: home,
      sourceRoot,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, { now: () => now, labelStates: inconsistent });
    assert.equal(unsafe.preview.reloadEligible, false);
    assert.equal(unsafe.checks.find((item) => item.id === `job:${MCP_LIFECYCLE_GUARD_LABEL}`)?.status, "error");
    const deferred = repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: unsafe,
    }, {
      labelStates: inconsistent,
      reload: () => assert.fail("inconsistent Guard pair must not reach launchctl"),
    });
    assert.equal(deferred.status, "deferred");
  });
});

test("reload eligibility is re-read immediately before activation", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    writeCurrentManagedReceipt({ sourceRoot, targetHome: home, receiptPath: managedReceiptPath, now });
    const healthy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates: intentionallyDisabledGuard,
    });
    writeLifecycleStatus(home, now, "terminating");
    const terminating = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates: intentionallyDisabledGuard,
    });
    const reports = [healthy, terminating];
    let reloads = 0;

    assert.throws(() => repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: healthy,
    }, {
      inspect: () => reports.shift() ?? terminating,
      labelStates: intentionallyDisabledGuard,
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
    mkdirSync(userRoot, { recursive: true });
    writeLifecycleStatus(home, now, "observed");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const managedReceiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    writeCurrentManagedReceipt({ sourceRoot, targetHome: home, receiptPath: managedReceiptPath, now });
    const healthy = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates: intentionallyDisabledGuard,
    });
    writeLifecycleStatus(home, now, "terminating");
    const terminating = inspectMcpLifecycleHealth({
      targetHome: home,
      backupRoot: join(userRoot, "backup"),
      managedReceiptPath,
      deep: true,
    }, {
      now: () => now,
      labelStates: intentionallyDisabledGuard,
    });
    const reports = [healthy, healthy, terminating];
    let liveMutations = 0;
    let reloadCalls = 0;

    assert.throws(() => repairMcpLifecycle({
      targetHome: home,
      userRoot,
      sourceRoot,
      report: healthy,
    }, {
      inspect: () => reports.shift() ?? terminating,
      labelStates: intentionallyDisabledGuard,
      reload: (_targetHome, _labels, beforeEach) => {
        reloadCalls += 1;
        beforeEach?.("com.thomashulihan.codex-mcp-idle-reaper");
        liveMutations += 1;
      },
    }), /reload deferred|terminating/i);

    assert.equal(reloadCalls, 0);
    assert.equal(liveMutations, 0);
  });
});

test("adopted reconciliation rechecks managed proof before any live mutation", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const userRoot = join(root, "tweakers");
    const now = new Date("2026-07-23T22:00:00.000Z");
    const sourceRoot = defaultMcpLifecycleSourceRoot();
    const manifest = readMcpLifecycleManifest(sourceRoot);
    const receiptPath = join(userRoot, "mcp-lifecycle-managed.json");
    const receiptLabelStates = intentionallyDisabledGuard(
      expectedMcpLifecycleLabelStates(verifyMcpLifecyclePackage({ sourceRoot, targetHome: home })),
    );
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(receiptPath, JSON.stringify({
      schemaVersion: 2,
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
      labelTransitions: receiptLabelStates.map((before) => ({
        label: before.label,
        before,
        intended: before,
        observed: before,
        operationsAttempted: [before.label === MCP_LIFECYCLE_REAPER_LABEL
          ? "bootout-bootstrap-verify"
          : "preserve-disabled-unloaded"],
      })),
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
      labelStates: intentionallyDisabledGuard,
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
      labelStates: intentionallyDisabledGuard,
      reload: (_targetHome, _labels, beforeEach) => {
        reloadCalls += 1;
        beforeEach?.("com.thomashulihan.codex-mcp-idle-reaper");
        liveMutations += 1;
      },
    }), /reload deferred|managed-adoption receipt/i);

    assert.equal(reloadCalls, 0);
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
      labelStates: intentionallyDisabledGuard,
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
      labelStates: intentionallyDisabledGuard,
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
    matcher_registry_version: readMcpLifecycleManifest(defaultMcpLifecycleSourceRoot()).matcher_registry_version,
    job: { ok: true, mode: "automatic", error: null },
    counts: { would_kill: 0 },
    trees: [{ tree_key: "tree-a", state }],
  }));
  writeGuardStatus(home, generatedAt);
}

function writeGuardStatus(home: string, generatedAt: Date, patch: Record<string, unknown> = {}): void {
  const manifest = readMcpLifecycleManifest(defaultMcpLifecycleSourceRoot());
  writeFileSync(join(home, ".codex", "tmp", "codex-mcp-guard-status.json"), JSON.stringify({
    schema: "mcp-guard-status.v3",
    schema_version: 3,
    generated_at: generatedAt.getTime() / 1_000,
    producer_version: manifest.package.version,
    authority: "observation-and-notification-only",
    mutationCapabilities: [],
    taskDataAccess: "none",
    state: "healthy",
    selected_producer: "healthy",
    unavailable_reasons: [],
    alerts: [],
    explanations: ["Guard observes process health and may notify; it does not control processes or access task data."],
    sample_count: 1,
    reset_reason: "initial_sample",
    schema_versions: { guard: 3, lifecycle: 2 },
    matcher: {
      expected: manifest.matcher_registry_version,
      observed: manifest.matcher_registry_version,
      freshness: "fresh",
      lifecycle_generated_at: generatedAt.getTime() / 1_000,
    },
    ownership: {},
    counts: {
      loaded_task_stacks: 0,
      logical_instances: {},
      raw_processes: 0,
      rss_mib: 0,
      app_servers: 0,
    },
    cpu_window: { samples: 1, available: false },
    system_memory: { available: false, swap: { available: false } },
    job: { ok: true, mode: "observation", error: null },
    ...patch,
  }));
}

function writeCurrentManagedReceipt(input: {
  sourceRoot: string;
  targetHome: string;
  receiptPath: string;
  now: Date;
}): void {
  const verification = verifyMcpLifecyclePackage({
    sourceRoot: input.sourceRoot,
    targetHome: input.targetHome,
  });
  const states = intentionallyDisabledGuard(expectedMcpLifecycleLabelStates(verification));
  writeFileSync(input.receiptPath, JSON.stringify({
    schemaVersion: 2,
    packageVersion: verification.manifest.package.version,
    lifecycleSchemaVersion: verification.manifest.lifecycle_schema_version,
    policyVersion: verification.manifest.policy_version,
    matcherRegistryVersion: verification.manifest.matcher_registry_version,
    labels: MCP_LIFECYCLE_LABELS,
    assetDigests: Object.fromEntries(
      verification.manifest.assets.map((asset) => [asset.id, asset.source_sha256]),
    ),
    adoptedAt: input.now.toISOString(),
    compatibility: "current labels and paths preserved; rename deferred",
    labelTransitions: states.map((before) => ({
      label: before.label,
      before,
      intended: before,
      observed: before,
      operationsAttempted: [before.label === MCP_LIFECYCLE_REAPER_LABEL
        ? "bootout-bootstrap-verify"
        : "preserve-disabled-unloaded"],
    })),
  }), { mode: 0o600 });
  chmodSync(input.receiptPath, 0o600);
}

function withTempRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweakers-mcp-lifecycle-health-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
