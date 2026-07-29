import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MANAGED_MCP_LIFECYCLE_FILE,
  MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
  assertManagedMcpPreparedRuntimeEvidence,
  installManagedMcpPreparedRuntime,
  mcpCatalogFingerprint,
  mcpSha256Fingerprint,
  prepareManagedMcpLifecycleRuntime,
  readAndVerifyManagedMcpLifecycleOverlay,
  type ManagedMcpConfigReconciliationPlan,
  type ManagedMcpFleetManifest,
  type ManagedMcpFleetManifestEntry,
} from "../src/managed-mcp-lifecycle.ts";
import {
  MANAGED_MCP_CUTOVER_SEQUENCE,
  finalizeManagedMcpRuntimeCutover,
  promoteManagedMcpRuntime,
  rollbackManagedMcpRuntime,
} from "../src/managed-mcp-cutover.ts";
import { writeWatcherPromotionReceipt, type WatcherPromotionReceipt } from "../src/watcher-promotion.ts";
import { managedMcpCanaryExpectedRoutes } from "../src/commands/codex-source.ts";

const now = "2026-07-20T04:00:00.000Z";

test("prepares the complete hybrid fleet overlay deterministically and binds exact artifacts", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareManagedMcpLifecycleRuntime({
      manifestFile: fixture.manifestFile,
      runtimeRoot: fixture.runtimeRoot,
      now: () => now,
    });
    assert.equal(prepared.overlayFile, join(fixture.runtimeRoot, MANAGED_MCP_LIFECYCLE_FILE));
    assert.equal(prepared.managedPackageRoot, join(fixture.runtimeRoot, "packages"));
    assert.equal(prepared.preparedAt, now);
    assert.equal(prepared.requiredCoverage.length, 20);
    assert.equal(prepared.artifacts.filter((artifact) => artifact.kind === "plugin-bundle").length, 14);
    assert.equal(prepared.artifacts.find((item) => item.kind === "package")?.integrity?.startsWith("sha512-"), true);
    const managedPackage = prepared.artifacts.find((item) => item.id === "playwright-mcp");
    assert.equal(managedPackage?.runtimeRelativePath, "packages/playwright-mcp/0.0.99");
    assert.equal(managedPackage?.destination, join(fixture.runtimeRoot, "packages/playwright-mcp/0.0.99"));
    assert.equal(existsSync(join(fixture.runtimeRoot, "packages/playwright-mcp/0.0.99/package.json")), true);
    for (const [relativeLink, target] of [
      ["packages/chrome-devtools-mcp/1.6.0/node_modules/.bin/chrome-devtools-mcp", "../chrome-devtools-mcp/cli.js"],
      ["packages/playwright-mcp/0.0.99/node_modules/.bin/playwright-mcp", "../@playwright/mcp/cli.js"],
    ] as const) {
      const copiedLink = join(fixture.runtimeRoot, relativeLink);
      assert.equal(lstatSync(copiedLink).isSymbolicLink(), true);
      assert.equal(readlinkSync(copiedLink), target);
    }
    assert.equal(readFileSync(join(fixture.runtimeRoot, "bin/pdfx-server.mjs"), "utf8"), "export {};\n");
    assert.equal(prepared.configReconciliation.feature.table, "features");
    assert.equal(prepared.configReconciliation.feature.key, "mcp_on_demand");
    assert.equal(prepared.configReconciliation.feature.value, true);
    assert.equal(prepared.configReconciliation.mutatesConfigDuringPreparation, false);
    assertManagedMcpPreparedRuntimeEvidence(prepared);
    const canaryRoutes = managedMcpCanaryExpectedRoutes(prepared);
    assert.equal(canaryRoutes.length, 20);
    assert.equal(canaryRoutes.every((route) => route.artifactSha256.length >= 1), true);
    assert.equal(canaryRoutes.every((route) => route.artifactSha256.every((digest) => /^[a-f0-9]{64}$/.test(digest))), true);

    const overlay = readAndVerifyManagedMcpLifecycleOverlay(prepared.overlayFile);
    assert.equal(overlay.fleetFingerprint, prepared.fleetFingerprint);
    assert.equal(overlay.entries.find((entry) => entry.server === "xcodebuildmcp")?.lifecycle, "task");
    assert.equal(overlay.entries.find((entry) => entry.server === "xcodebuildmcp")?.idleLeaseSec, 300);
    assert.equal(overlay.entries.find((entry) => entry.server === "pdfx")?.lifecycle, "call");
    assert.equal(overlay.entries.find((entry) => entry.server === "pdfx")?.idleLeaseSec, 0);
    assert.equal(overlay.entries.every((entry) => entry.catalog.path.startsWith(fixture.runtimeRoot)), true);

    const manifest = JSON.parse(readFileSync(fixture.manifestFile, "utf8")) as ManagedMcpFleetManifest;
    writeJson(fixture.manifestFile, { ...manifest, entries: [...manifest.entries].reverse() });
    const second = prepareManagedMcpLifecycleRuntime({
      manifestFile: fixture.manifestFile,
      runtimeRoot: fixture.runtimeRoot,
      now: () => now,
    });
    assert.equal(second.fleetFingerprint, prepared.fleetFingerprint);
    assert.equal(second.overlaySha256, prepared.overlaySha256);

    const canaryRuntime = installManagedMcpPreparedRuntime(
      second,
      join(fixture.root, "canary-home", "managed-runtime"),
      () => now,
    );
    const liveRuntime = installManagedMcpPreparedRuntime(
      second,
      join(fixture.root, "live-home", "managed-runtime"),
      () => now,
    );
    assert.equal(canaryRuntime.sourceFleetFingerprint, second.fleetFingerprint);
    assert.equal(liveRuntime.sourceFleetFingerprint, second.fleetFingerprint);
    assert.notEqual(canaryRuntime.fleetFingerprint, second.fleetFingerprint);
    assert.notEqual(liveRuntime.fleetFingerprint, canaryRuntime.fleetFingerprint);
    readAndVerifyManagedMcpLifecycleOverlay(canaryRuntime.overlayFile);
    readAndVerifyManagedMcpLifecycleOverlay(liveRuntime.overlayFile);
    const canaryPlaywrightCatalog = canaryRuntime.catalogs.find((catalog) => catalog.server === "playwright")!;
    const canaryCatalogText = readFileSync(canaryPlaywrightCatalog.path, "utf8");
    assert.equal(canaryCatalogText.includes(join(fixture.root, "artifacts", "playwright-package")), false);
    assert.equal(canaryCatalogText.includes(join(canaryRuntime.runtimeRoot, "packages/playwright-mcp/0.0.99")), true);
  } finally {
    fixture.remove();
  }
});

test("rejects destination conflicts and unsafe artifact symlinks while preserving package bin links", () => {
  const fixture = createFixture();
  try {
    const manifest = JSON.parse(readFileSync(fixture.manifestFile, "utf8")) as ManagedMcpFleetManifest;
    writeJson(fixture.manifestFile, {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) => artifact.id === "playwright-mcp"
        ? { ...artifact, runtimeRelativePath: "../escape" }
        : artifact),
    });
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /unsafe artifact .* runtime path/i,
    );

    writeJson(fixture.manifestFile, manifest);
    assert.throws(() => prepareManagedMcpLifecycleRuntime({
      manifestFile: fixture.manifestFile,
      runtimeRoot: fixture.runtimeRoot,
      seedPaths: [{
        sourcePath: manifest.artifacts[0]!.sourcePath,
        destinationRelativePath: "packages/playwright-mcp/0.0.99",
      }],
    }), /destination .* overlaps/i);

    const packageSource = manifest.artifacts.find((artifact) => artifact.id === "playwright-mcp")!.sourcePath;
    symlinkSync(join(packageSource, "package.json"), join(packageSource, "package-link.json"));
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /package tree symlink .* must use a relative target/i,
    );
    rmSync(join(packageSource, "package-link.json"));

    writeFileSync(join(dirname(packageSource), "outside.js"), "outside\n");
    symlinkSync("../outside.js", join(packageSource, "package-link.json"));
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /package tree symlink .* escapes its root/i,
    );
    rmSync(join(packageSource, "package-link.json"));

    symlinkSync("missing.js", join(packageSource, "package-link.json"));
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /package tree symlink .* is broken/i,
    );
    rmSync(join(packageSource, "package-link.json"));

    const executable = manifest.artifacts.find((artifact) => artifact.id === "node-repl")!;
    const executableLink = join(dirname(executable.sourcePath), "node-repl-link");
    symlinkSync("node-repl", executableLink);
    writeJson(fixture.manifestFile, {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact) => artifact.id === executable.id
        ? { ...artifact, sourcePath: executableLink }
        : artifact),
    });
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /artifact node-repl cannot be a symlink/i,
    );
    writeJson(fixture.manifestFile, manifest);

    const prepared = prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot });
    writeFileSync(join(fixture.runtimeRoot, "bin/pdfx-server.mjs"), "drifted\n");
    assert.throws(() => assertManagedMcpPreparedRuntimeEvidence(prepared), /runtime tree drift|copied target drift/i);
  } finally {
    fixture.remove();
  }
});

test("matches the fixed Rust canonical declaration fingerprint vector", () => {
  assert.equal(mcpSha256Fingerprint({
    args: [],
    catalog_digest: `sha256:${"0".repeat(64)}`,
    command: "/opt/local/bin/headroom",
    cwd: null,
    environment_id: "local",
    explicit_env: {},
    inherited_env: [],
    inherited_env_policy: MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
    server_name: "headroom",
    source: { origin: "config" },
  }), "sha256:0150f22077f459046652f030f42d917b8c9840cf3c53d132f287c717eaa3a3bc");
});

test("fails closed when required coverage or a catalog digest is missing", () => {
  const fixture = createFixture();
  try {
    const manifest = JSON.parse(readFileSync(fixture.manifestFile, "utf8")) as ManagedMcpFleetManifest;
    writeJson(fixture.manifestFile, {
      ...manifest,
      entries: manifest.entries.filter((entry) => entry.server !== "dataAnalyticsWidgets"),
      enabledLocalStdioRouteCount: manifest.entries.length - 1,
    });
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot }),
      /missing promotion-required routes.*data-analytics/i,
    );
    assert.equal(existsSync(fixture.runtimeRoot), false);

    const restored = createFixture(join(fixture.root, "drift"));
    const driftManifest = JSON.parse(readFileSync(restored.manifestFile, "utf8")) as ManagedMcpFleetManifest;
    const source = driftManifest.entries[0]!.catalog.path;
    writeFileSync(source, "drifted\n");
    assert.throws(
      () => prepareManagedMcpLifecycleRuntime({ manifestFile: restored.manifestFile, runtimeRoot: restored.runtimeRoot }),
      /catalog digest drift/i,
    );
  } finally {
    fixture.remove();
  }
});

test("prepared evidence rejects overlay or runtime drift", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot });
    writeFileSync(join(fixture.runtimeRoot, "config-reconciliation.v1.json"), "{}\n");
    assert.throws(() => assertManagedMcpPreparedRuntimeEvidence(prepared), /runtime tree drift/i);
  } finally {
    fixture.remove();
  }
});

test("canary route extraction rejects drifted, duplicate, empty, and malformed Rust catalog artifacts", () => {
  const drift = createFixture();
  try {
    const prepared = prepareManagedMcpLifecycleRuntime({ manifestFile: drift.manifestFile, runtimeRoot: drift.runtimeRoot });
    const overlay = readAndVerifyManagedMcpLifecycleOverlay(prepared.overlayFile);
    const catalog = JSON.parse(readFileSync(overlay.entries[0]!.catalog.path, "utf8")) as { artifacts: Array<{ path: string }> };
    writeFileSync(catalog.artifacts[0]!.path, "artifact drift\n");
    assert.throws(() => managedMcpCanaryExpectedRoutes(prepared), /artifact digest drift/i);
  } finally {
    drift.remove();
  }

  for (const [label, mutate, expected] of [
    ["duplicate", (catalog: { artifacts: unknown[] }) => { catalog.artifacts.push(catalog.artifacts[0]); }, /duplicate artifact/i],
    ["empty", (catalog: { artifacts: unknown[] }) => { catalog.artifacts = []; }, /lacks receipt-bound artifacts/i],
    ["malformed", (catalog: { artifacts: unknown[] }) => { catalog.artifacts = [{ path: 7, sha256: "bad" }]; }, /artifact digest is invalid/i],
  ] as const) {
    const fixture = createFixture();
    try {
      const manifest = JSON.parse(readFileSync(fixture.manifestFile, "utf8")) as ManagedMcpFleetManifest;
      const entry = manifest.entries[0]!;
      const catalog = JSON.parse(readFileSync(entry.catalog.path, "utf8")) as { artifacts: unknown[] };
      mutate(catalog);
      const bytes = Buffer.from(`${JSON.stringify(catalog)}\n`);
      writeFileSync(entry.catalog.path, bytes);
      const updatedEntry = {
        ...entry,
        catalog: { ...entry.catalog, sha256: mcpDigest(bytes) },
        declarationFingerprint: mcpCatalogFingerprint({ server: entry.server, declaration: entry.declaration }, bytes),
      };
      writeJson(fixture.manifestFile, {
        ...manifest,
        entries: [updatedEntry, ...manifest.entries.slice(1)],
      });
      const prepared = prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot });
      assert.throws(() => managedMcpCanaryExpectedRoutes(prepared), expected, label);
    } finally {
      fixture.remove();
    }
  }
});

test("atomic promotion requires watcher quiescence and rollback preserves displaced evidence", () => {
  const fixture = createFixture();
  try {
    const prepared = prepareManagedMcpLifecycleRuntime({ manifestFile: fixture.manifestFile, runtimeRoot: fixture.runtimeRoot });
    const active = join(fixture.root, "selected-codex-home", "managed-runtime");
    const rollback = join(fixture.root, "transaction", "rollback-managed-runtime");
    const receiptFile = join(fixture.root, "transaction", "managed-mcp-cutover.json");
    const watcherReceiptFile = join(fixture.root, "transaction", "watcher.json");
    mkdirSync(active, { recursive: true });
    writeFileSync(join(active, "previous.txt"), "previous\n");
    writeWatcherPromotionReceipt(watcherReceiptFile, watcherReceipt("tx-fleet", "resumed"));
    assert.throws(() => promoteManagedMcpRuntime({
      transactionId: "tx-fleet", prepared, activeRuntimeRoot: active, rollbackRuntimeRoot: rollback,
      receiptFile, watcherReceiptFile,
    }), /paused watcher/i);
    rmSync(watcherReceiptFile, { force: true });
    writeWatcherPromotionReceipt(watcherReceiptFile, watcherReceipt("tx-fleet", "paused"));

    const promoted = promoteManagedMcpRuntime({
      transactionId: "tx-fleet", prepared, activeRuntimeRoot: active, rollbackRuntimeRoot: rollback,
      receiptFile, watcherReceiptFile, now: () => now,
    });
    assert.equal(promoted.phase, "promoted");
    assert.equal(promoted.configApplied, false);
    assert.equal(promoted.watcherExpectedFingerprintUpdatePending, true);
    assert.equal(existsSync(join(active, MANAGED_MCP_LIFECYCLE_FILE)), true);
    const promotedArtifacts = JSON.parse(readFileSync(join(active, "fleet-artifacts.v1.json"), "utf8")) as {
      managedPackageRoot: string;
      artifacts: Array<{ id: string; destination: string | null }>;
    };
    assert.equal(promotedArtifacts.managedPackageRoot, join(active, "packages"));
    assert.equal(
      promotedArtifacts.artifacts.find((artifact) => artifact.id === "playwright-mcp")?.destination,
      join(active, "packages/playwright-mcp/0.0.99"),
    );
    assert.equal(readFileSync(join(rollback, "previous.txt"), "utf8"), "previous\n");

    writeWatcherPromotionReceipt(watcherReceiptFile, watcherReceipt("tx-fleet", "resumed"));
    const verificationFile = join(fixture.root, "transaction", "installed-verification.json");
    writeJson(verificationFile, { verified: true });
    const verified = finalizeManagedMcpRuntimeCutover(receiptFile, {
      installedVerificationFile: verificationFile,
      now: () => "2026-07-20T04:00:30.000Z",
    });
    assert.equal(verified.phase, "verified");
    assert.equal(verified.configApplied, true);
    assert.equal(verified.watcherExpectedFingerprintUpdatePending, false);
    assert.match(verified.installedVerificationSha256!, /^[a-f0-9]{64}$/);

    const rolledBack = rollbackManagedMcpRuntime(receiptFile, () => "2026-07-20T04:01:00.000Z");
    assert.equal(rolledBack.phase, "rolled-back");
    assert.equal(readFileSync(join(active, "previous.txt"), "utf8"), "previous\n");
    assert.equal(existsSync(rolledBack.displacedRuntimeRoot!), true);
    assert.deepEqual(MANAGED_MCP_CUTOVER_SEQUENCE.orderedSteps.slice(0, 2), [
      "pause-watcher-and-prove-quiesced",
      "promote-app-and-managed-runtime",
    ]);
  } finally {
    fixture.remove();
  }
});

interface Fixture {
  root: string;
  manifestFile: string;
  runtimeRoot: string;
  remove(): void;
}

function createFixture(root = mkdtempSync(join(tmpdir(), "managed-mcp-lifecycle-"))): Fixture {
  mkdirSync(root, { recursive: true });
  const catalogs = join(root, "catalog-source");
  const packageRoot = join(root, "artifacts", "playwright-package");
  const chromePackageRoot = join(root, "artifacts", "chrome-package");
  const bundledHelper = join(root, "artifacts", "node-repl");
  const pluginEntrypoint = join(root, "artifacts", "pdfx-server.mjs");
  createPackageRuntimeFixture(
    packageRoot,
    "@playwright/mcp",
    "0.0.99",
    "playwright-mcp",
    "../@playwright/mcp/cli.js",
  );
  createPackageRuntimeFixture(
    chromePackageRoot,
    "chrome-devtools-mcp",
    "1.6.0",
    "chrome-devtools-mcp",
    "../chrome-devtools-mcp/cli.js",
  );
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(bundledHelper, "bundled-helper\n");
  writeFileSync(pluginEntrypoint, "export {};\n");

  const routeSpecs = [
    ["config", "playwright", "task"],
    ["config", "headroom", "call"],
    ["config", "node_repl", "task"],
    ["plugin:chrome-devtools@0.1.0", "chrome-devtools", "task"],
    ["plugin:infographic-docs@1.3.1", "infographic-preview-playwright", "task"],
    ["plugin:build-ios-apps@0.1.2", "xcodebuildmcp", "task"],
    ["plugin:pdfx@0.1.0", "pdfx", "call"],
    ["plugin:pdfx@0.1.0", "pdfx-apps", "call"],
    ["plugin:shadcn@0.3.0", "shadcn", "call"],
    ["plugin:shadcn@0.3.0", "shadcn-apps", "call"],
    ["plugin:shadcn@0.3.0", "iconify", "call"],
    ["plugin:react-doctor@0.1.0", "react-doctor", "call"],
    ["plugin:record-and-replay@1.0.1000451", "event-stream", "task"],
    ["plugin:computer-use@26.715.52143", "computer-use", "task"],
    ["plugin:sites@0.1.30", "sites-design-picker", "call"],
    ["plugin:codex-security@0.1.11", "codex-security", "call"],
    ["plugin:creative-production@0.1.25", "creative_production_mcp", "call"],
    ["plugin:data-analytics@0.2.8-13ceeea1f599", "dataAnalyticsWidgets", "call"],
    ["plugin:openai-developers@1.2.3", "openai-api-key-local-confirmation", "call"],
    ["plugin:decodo@0.1.0", "decodo", "call"],
  ] as const;
  const pluginArtifacts = [...new Map(routeSpecs.flatMap(([owner]) => {
    const match = /^plugin:([^@]+)@(.+)$/.exec(owner);
    return match ? [[match[1]!, { pluginId: match[1]!, version: match[2]! }] as const] : [];
  })).values()].map(({ pluginId, version }) => {
    const bundle = join(root, "artifacts", "plugin-bundles", pluginId);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, ".mcp.json"), `${JSON.stringify({ mcpServers: { fixture: {} } })}\n`);
    if (pluginId === "chrome-devtools") {
      mkdirSync(join(bundle, "bin"), { recursive: true });
      writeFileSync(join(bundle, "bin", "chrome-devtools-mcp-locked"), "#!/bin/sh\nexit 0\n");
    }
    return {
      id: `${pluginId}-plugin-bundle`,
      kind: "plugin-bundle" as const,
      sourcePath: bundle,
      version,
      integrity: null,
      runtimeRelativePath: `plugin-bundles/${pluginId}/${version}`,
    };
  });
  const entries: ManagedMcpFleetManifestEntry[] = routeSpecs.map(([owner, server, lifecycle], index) => {
    const catalog = join(catalogs, `${index}-${server}.json`);
    const command = server === "playwright"
      ? join(packageRoot, "node_modules", "@playwright", "mcp", "cli.js")
      : join(root, "artifacts", "route-binaries", `${index}-${server}`);
    if (server !== "playwright") {
      mkdirSync(dirname(command), { recursive: true });
      writeFileSync(command, `fixture executable ${owner}/${server}\n`);
    }
    const artifactDigest = createHash("sha256").update(readFileSync(command)).digest("hex");
    const bytes = Buffer.from(`${JSON.stringify({
      tools: [{ name: `${server}_tool` }],
      artifacts: [{ path: command, sha256: `sha256:${artifactDigest}` }],
    })}\n`);
    mkdirSync(catalogs, { recursive: true });
    writeFileSync(catalog, bytes);
    const declaration = {
      source: fingerprintSource(owner),
      environmentId: "local",
      command,
      args: [],
      cwd: null,
      explicitEnv: {},
      inheritedEnvPolicy: MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
      inheritedEnv: [],
    } as const;
    const catalogSha256 = mcpDigest(bytes);
    return {
      owner,
      server,
      declarationFingerprint: mcpCatalogFingerprint({ server, declaration }, bytes),
      lifecycle,
      idleLeaseSec: lifecycle === "task" ? 300 : 0,
      catalog: { path: catalog, sha256: catalogSha256 },
      required: true,
      declaration,
    };
  });
  const configReconciliation: ManagedMcpConfigReconciliationPlan = {
    schemaVersion: 1,
    feature: { table: "features", key: "mcp_on_demand", value: true },
    routes: [
      { owner: "config", server: "chrome-devtools", action: "archive-shadow", replacementOwner: "plugin:chrome-devtools@0.1.0", applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "computer-use", action: "archive-shadow", replacementOwner: "plugin:computer-use@26.715.52143", applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "playwright", action: "replace-floating", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "headroom", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
      { owner: "config", server: "node_repl", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
    ],
    applyOnlyDuringApprovedCutover: true,
    mutatesConfigDuringPreparation: false,
  };
  const manifest: ManagedMcpFleetManifest = {
    schemaVersion: 1,
    inventoryComplete: true,
    enabledLocalStdioRouteCount: entries.length,
    entries,
    artifacts: [
      ...pluginArtifacts,
      {
        id: "chrome-devtools-mcp",
        kind: "package",
        sourcePath: chromePackageRoot,
        version: "1.6.0",
        integrity: `sha512-${Buffer.from("fixture-chrome-package-integrity").toString("base64")}`,
        runtimeRelativePath: "packages/chrome-devtools-mcp/1.6.0",
      },
      {
        id: "playwright-mcp",
        kind: "package",
        sourcePath: packageRoot,
        version: "0.0.99",
        integrity: `sha512-${Buffer.from("fixture-package-integrity").toString("base64")}`,
        runtimeRelativePath: "packages/playwright-mcp/0.0.99",
      },
      { id: "node-repl", kind: "executable", sourcePath: bundledHelper, version: null, integrity: null, runtimeRelativePath: null },
      {
        id: "pdfx-entrypoint",
        kind: "plugin-entrypoint",
        sourcePath: pluginEntrypoint,
        version: "0.1.0",
        integrity: null,
        runtimeRelativePath: "bin/pdfx-server.mjs",
      },
    ],
    configReconciliation,
  };
  const manifestFile = join(root, "managed-mcp-fleet.v1.json");
  writeJson(manifestFile, manifest);
  return {
    root,
    manifestFile,
    runtimeRoot: join(root, "prepared", "managed-runtime"),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createPackageRuntimeFixture(
  root: string,
  packageName: string,
  version: string,
  binaryName: string,
  binaryTarget: string,
): void {
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  const binaryRoot = join(root, "node_modules", ".bin");
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(binaryRoot, { recursive: true });
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ private: true, dependencies: { [packageName]: version } })}\n`);
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: packageName, version })}\n`);
  writeFileSync(join(packageRoot, "cli.js"), "process.stdout.write('fixture');\n");
  symlinkSync(binaryTarget, join(binaryRoot, binaryName));
}

function watcherReceipt(transactionId: string, phase: WatcherPromotionReceipt["phase"]): WatcherPromotionReceipt {
  return {
    schemaVersion: 1,
    kind: "watcher-promotion",
    transactionId,
    phase,
    sourceAppRoot: "/Applications/ChatGPT.app",
    requestedAppRoot: "/Applications/ChatGPT.app",
    activeTargetAppRoot: phase === "resumed" ? "/Applications/ChatGPT.app" : null,
    sourceExpectedFingerprint: "a".repeat(64),
    targetExpectedFingerprint: phase === "resumed" ? "b".repeat(64) : null,
    snapshot: {
      schemaVersion: 1,
      kind: "watcher-promotion-snapshot",
      watcherKind: "none",
      configured: false,
      loaded: false,
      enabled: false,
      definitionPath: null,
      definitionDigest: null,
      capturedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    pausedAt: phase === "paused" ? now : null,
    resumedAt: phase === "resumed" ? now : null,
    error: null,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function mcpDigest(bytes: Buffer): string {
  return `sha256:${sha256(bytes)}`;
}

function fingerprintSource(owner: string) {
  if (owner === "config") return { origin: "config" as const };
  const match = /^plugin:([^@]+)@(.+)$/.exec(owner);
  if (!match) throw new Error(`Unsupported fixture owner ${owner}`);
  return { origin: "plugin" as const, plugin_id: match[1]!, plugin_version: match[2]! };
}
