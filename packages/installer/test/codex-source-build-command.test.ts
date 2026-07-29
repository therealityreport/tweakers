import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexSource,
  codexSourceTransactionPaths,
  freezeCodexSourceCandidate,
  prepareCodexSourceCandidate,
  type CodexSourceBuildEvidence,
  type CodexSourceCommandDependencies,
  type CodexSourceProductionDependencies,
} from "../src/commands/codex-source.ts";
import {
  codexDerivedLabel,
  writeCodexDerivedReceipt,
  type CodexDerivedReceipt,
  type CodexResolutionCheckpoint,
  type LockedDependencyEvidence,
} from "../src/codex-derived-receipt.ts";
import type { ManagedMcpStageEvidence } from "../src/managed-mcp-packages.ts";

const now = "2026-07-19T12:05:00.000Z";
const closesAt = "2026-07-19T12:10:00.000Z";
const bundledVersion = "0.145.0-alpha.18";
const commit = "a".repeat(40);

test("codex-source build is reachable, defaults to bundled, stages exact MCP evidence, and stops prepared", async () => {
  const fixture = createFixture();
  const events: string[] = [];
  let probedApp: string | undefined;
  let adapterDependencies: readonly LockedDependencyEvidence[] = [];
  try {
    const deps = dependencies(fixture.root, {
      events,
      onProbe: (app) => { probedApp = app; },
      onAdapterDependencies: (value) => { adapterDependencies = value; },
    });
    const result = await codexSource("build", buildOptions(fixture), deps);

    assert.equal(result?.kind, "codex-source-build");
    if (!result || result.kind !== "codex-source-build") return;
    assert.equal(result.status, "prepared");
    assert.equal(result.channel, "bundled");
    assert.equal(result.liveMutation, false);
    assert.equal(result.receipt, null);
    assert.equal(probedApp, "/Applications/ChatGPT.app");
    assert.deepEqual(events, ["parity", "stage", "adapter", "checkout", "build"]);
    assert.equal(adapterDependencies.length, 2);
    const state = JSON.parse(readFileSync(result.paths.candidateStateFile, "utf8")) as {
      evidence: { dependencies: readonly LockedDependencyEvidence[] };
      cycle: { checkpoints: Array<{ name: string }> };
    };
    assert.deepEqual(state.evidence.dependencies, adapterDependencies);
    assert.deepEqual(state.cycle.checkpoints.map((item) => item.name), ["R1", "R2"]);
    assert.deepEqual(
      adapterDependencies[0]?.contentDigests.map((item) => item.scope),
      [
        "managed MCP release lock",
        "managed MCP catalog file",
        "managed MCP catalog semantics",
        "managed MCP package lock",
        "managed MCP dependency graph",
        "managed MCP locked wrapper",
      ],
    );
    assert.equal(existsSync(result.paths.candidateStateFile), true);
    assert.equal(existsSync(result.paths.receiptFile), false);
    assert.equal(existsSync(join(fixture.root, "codex-source", "current-bundled.json")), false);
  } finally {
    fixture.remove();
  }
});

test("full fleet manifest solely owns Chrome and Playwright runtime package destinations", async () => {
  const fixture = createFixture();
  try {
    const deps = dependencies(fixture.root);
    assert.ok(deps.production);
    deps.production.prepareManagedMcpLifecycle = (input) => {
      assert.equal(input.seedPaths, undefined);
      assert.equal(input.runtimeRoot, join(fixture.root, "codex-source", "transactions", "tx-build", "prepared", "managed-runtime"));
      const manifest = JSON.parse(readFileSync(input.manifestFile, "utf8")) as {
        artifacts: Array<{
          id: string;
          kind: string;
          sourcePath: string;
          version: string;
          integrity: string;
          runtimeRelativePath: string;
        }>;
      };
      const staged = managedMcpEvidence(fixture.root).packages;
      const packageArtifacts = manifest.artifacts.filter((artifact) => artifact.kind === "package");
      assert.equal(packageArtifacts.length, 2);
      for (const pkg of staged) {
        const artifact = packageArtifacts.find((candidate) => candidate.id === pkg.packageDirectory);
        assert.ok(artifact);
        assert.equal(artifact.sourcePath, pkg.destination);
        assert.equal(artifact.version, pkg.version);
        assert.equal(artifact.integrity, pkg.integrity);
        assert.equal(artifact.runtimeRelativePath, `packages/${pkg.packageDirectory}/${pkg.version}`);
      }
      const destinations = packageArtifacts.map((artifact) => artifact.runtimeRelativePath);
      assert.equal(new Set(destinations).size, destinations.length);
      assert.equal(destinations.every((destination) => destination.startsWith("packages/")), true);
      throw new Error("fleet package handoff inspected");
    };

    await assert.rejects(() => codexSource("build", {
      ...buildOptions(fixture),
      fleetManifest: fixture.fleetManifest,
    }, deps), /fleet package handoff inspected/);
  } finally {
    fixture.remove();
  }
});

test("codex-source build derives and enforces the current same-channel downgrade and identity floor", async () => {
  for (const scenario of [
    { currentVersion: "0.145.0-alpha.19", currentCommit: "b".repeat(40), expected: /downgrade refused/ },
    { currentVersion: bundledVersion, currentCommit: "b".repeat(40), expected: /identity drift/ },
  ]) {
    const fixture = createFixture();
    let checkoutCalled = false;
    try {
      const current = currentReceipt(scenario.currentVersion, scenario.currentCommit);
      const authoritativeReceipt = join(fixture.root, "codex-source", "receipts", "tx-current.json");
      writeCodexDerivedReceipt(authoritativeReceipt, current);
      const deps = dependencies(fixture.root, {
        checkout: () => { checkoutCalled = true; },
      });
      await assert.rejects(() => codexSource("build", buildOptions(fixture), deps), scenario.expected);
      assert.equal(checkoutCalled, false);
      assert.equal(existsSync(join(fixture.root, "codex-source", "receipts", "tx-build.json")), false);
    } finally {
      fixture.remove();
    }
  }
});

test("prepared build binds the repository-owned runner and cannot advance without real candidate/canary evidence", async () => {
  const fixture = createFixture();
  try {
    const deps = dependencies(fixture.root);
    const built = await codexSource("build", buildOptions(fixture), deps);
    assert.equal(built?.kind, "codex-source-build");
    const paths = codexSourceTransactionPaths(fixture.root, "tx-build");
    const state = JSON.parse(readFileSync(paths.candidateStateFile, "utf8")) as {
      evidence?: { trustedCanaryRunner?: { sourcePath?: string; sha256?: string } };
    };
    assert.match(state.evidence?.trustedCanaryRunner?.sourcePath ?? "", /managed-mcp-canary-runner\.ts$/);
    assert.match(state.evidence?.trustedCanaryRunner?.sha256 ?? "", /^[a-f0-9]{64}$/);
    for (const evidence of ["", "{}", JSON.stringify({ status: "passed" })]) {
      writeFileSync(fixture.canaryEvidence, evidence);
      await assert.rejects(() => codexSource("canary-pass", {
        transactionId: "tx-build",
        canaryEvidence: fixture.canaryEvidence,
      }, deps), /source-derived canary candidate must exist/i);
    }
    await assert.rejects(() => codexSource("freeze", {
      transactionId: "tx-build",
      restartWindowOpensAt: "2026-07-19T12:00:00.000Z",
      restartWindowClosesAt: closesAt,
    }, deps), /validated isolated canary sidecar must exist/i);
    assert.equal(existsSync(join(fixture.root, "codex-source", "receipts", "tx-build.json")), false);
  } finally {
    fixture.remove();
  }
});

test("40 GiB preflight fails before managed staging, checkout, build, or candidate writes", async () => {
  const fixture = createFixture();
  const events: string[] = [];
  try {
    const deps = dependencies(fixture.root, { events });
    deps.availableBytes = () => 39n * 1024n * 1024n * 1024n;
    await assert.rejects(() => codexSource("build", buildOptions(fixture), deps), /requires 42949672960 bytes.*available/);
    assert.deepEqual(events, ["parity"]);
    assert.equal(existsSync(codexSourceTransactionPaths(fixture.root, "tx-build").candidateStateFile), false);
  } finally {
    fixture.remove();
  }
});

test("CLI-shaped kebab-case source options reach the same prepared build path", async () => {
  const fixture = createFixture();
  try {
    const result = await codexSource("build", {
      "frontend-source-app": fixture.frontend,
      "patch-series": fixture.patch,
      "chrome-plugin-root": fixture.chrome,
      "playwright-plugin-root": fixture.playwright,
      "transaction-id": "tx-kebab",
    }, dependencies(fixture.root));
    assert.equal(result?.kind, "codex-source-build");
    if (result?.kind === "codex-source-build") {
      assert.equal(result.transactionId, "tx-kebab");
      assert.equal(result.status, "prepared");
    }
  } finally {
    fixture.remove();
  }
});

test("control parity failure aborts before managed staging", async () => {
  const fixture = createFixture();
  const events: string[] = [];
  try {
    const deps = dependencies(fixture.root, { events, parityError: new Error("stale pristine backup") });
    await assert.rejects(() => codexSource("build", buildOptions(fixture), deps), /stale pristine backup/);
    assert.deepEqual(events, ["parity"]);
  } finally {
    fixture.remove();
  }
});

test("bundled control is re-probed at R2 and R3 instead of freezing a stale desktop backend", async () => {
  const fixture = createFixture();
  try {
    const versions = [bundledVersion, "0.145.0-alpha.24"];
    let probe = 0;
    let built = false;
    const changing = await prepareCodexSourceCandidate({
      channel: "bundled",
      bundledVersion,
      controlApp: "/Applications/ChatGPT.app",
      sourceRoot: join(fixture.root, "changing-source"),
      transactionId: "tx-changing-r2",
    }, {
      fetchJson: async (request) => {
        const tag = request.url.split("/tags/")[1];
        return { status: 200, data: release(tag ? decodeURIComponent(tag) : `rust-v${bundledVersion}`) };
      },
      resolveTag: async (tag) => ({ tag, refSha: commit, tagObjectShas: [], peeledCommit: commit }),
      fetchNpmVersions: async () => versions,
      checkoutSource: ({ peeledCommit }) => peeledCommit,
      verifySourceCommit: () => commit,
      buildSource: async () => {
        built = true;
        return buildEvidence([]);
      },
      probeBundledVersion: () => versions[Math.min(probe++, versions.length - 1)]!,
      now: () => now,
    });
    assert.equal(changing.status, "superseded");
    assert.equal(built, false);

    const constantDeps = dependencies(fixture.root);
    const prepared = await prepareCodexSourceCandidate({
      bundledVersion,
      controlApp: "/Applications/ChatGPT.app",
      sourceRoot: join(fixture.root, "r3-source"),
      transactionId: "tx-changing-r3",
    }, {
      fetchJson: constantDeps.fetchJson,
      resolveTag: constantDeps.resolveTag,
      fetchNpmVersions: constantDeps.fetchNpmVersions,
      checkoutSource: ({ peeledCommit }) => peeledCommit,
      verifySourceCommit: () => commit,
      buildSource: async () => buildEvidence([]),
      probeBundledVersion: () => bundledVersion,
      now: () => now,
    });
    assert.equal(prepared.status, "prepared");
    if (prepared.status !== "prepared") return;
    const frozen = await freezeCodexSourceCandidate({
      candidate: prepared.candidate,
      restartWindow: { opensAt: "2026-07-19T12:00:00.000Z", closesAt },
      watcher: {
        previousFingerprints: {}, promotedFingerprints: {}, pauseTokenDigest: null,
        expectedFingerprintUpdatedAt: null, rearmedAt: null, wasEnabled: false,
      },
      receiptFile: join(fixture.root, "codex-source", "receipts", "tx-changing-r3.json"),
    }, {
      fetchJson: async (request) => {
        const tag = request.url.split("/tags/")[1];
        return { status: 200, data: release(tag ? decodeURIComponent(tag) : "rust-v0.145.0-alpha.24") };
      },
      resolveTag: async (tag) => ({ tag, refSha: commit, tagObjectShas: [], peeledCommit: commit }),
      fetchNpmVersions: async () => versions,
      probeBundledVersion: () => "0.145.0-alpha.24",
      now: () => now,
    });
    assert.equal(frozen.status, "superseded");
  } finally {
    fixture.remove();
  }
});

test("build rejects external-volume inputs before production staging", async () => {
  const fixture = createFixture();
  let staged = false;
  try {
    const deps = dependencies(fixture.root, { onStage: () => { staged = true; } });
    await assert.rejects(() => codexSource("build", {
      ...buildOptions(fixture),
      frontendSourceApp: "/Volumes/HardDrive/ChatGPT.app",
    }, deps), /internal storage/);
    assert.equal(staged, false);
  } finally {
    fixture.remove();
  }
});

interface Fixture {
  root: string;
  frontend: string;
  chrome: string;
  playwright: string;
  patch: string;
  fleetManifest: string;
  canaryEvidence: string;
  remove(): void;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "codex-source-build-command-"));
  const frontend = join(root, "pristine", "ChatGPT.app");
  const chrome = join(root, "plugins", "chrome");
  const playwright = join(root, "plugins", "playwright");
  const patch = join(root, "patches", "on-demand.patch");
  const fleetManifest = join(root, "fleet", "managed-mcp-fleet.v1.json");
  const canaryEvidence = join(root, "canary", "result.json");
  for (const directory of [frontend, chrome, playwright, join(root, "patches"), join(root, "fleet"), join(root, "canary")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(patch, "test patch\n");
  const packageEvidence = managedMcpEvidence(root).packages;
  writeFileSync(fleetManifest, `${JSON.stringify({
    schemaVersion: 1,
    artifacts: packageEvidence.map((pkg) => ({
      id: pkg.packageDirectory,
      kind: "package",
      sourcePath: pkg.destination,
      version: pkg.version,
      integrity: pkg.integrity,
      runtimeRelativePath: `packages/${pkg.packageDirectory}/${pkg.version}`,
    })),
  }, null, 2)}\n`);
  return {
    root,
    frontend,
    chrome,
    playwright,
    patch,
    fleetManifest,
    canaryEvidence,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function buildOptions(fixture: Fixture) {
  return {
    frontendSourceApp: fixture.frontend,
    patchSeries: fixture.patch,
    chromePluginRoot: fixture.chrome,
    playwrightPluginRoot: fixture.playwright,
    transactionId: "tx-build",
  };
}

function dependencies(
  root: string,
  hooks: {
    events?: string[];
    onProbe?: (app: string | undefined) => void;
    onStage?: () => void;
    onAdapterDependencies?: (value: readonly LockedDependencyEvidence[]) => void;
    checkout?: () => void;
    parityError?: Error;
  } = {},
): CodexSourceCommandDependencies {
  const production: CodexSourceProductionDependencies = {
    stageManagedMcpPackages: () => {
      hooks.events?.push("stage");
      hooks.onStage?.();
      return managedMcpEvidence(root);
    },
    createBuildAdapter: (input) => {
      hooks.events?.push("adapter");
      hooks.onAdapterDependencies?.(input.dependencies);
      return {
        paths: codexSourceTransactionPaths(input.transactionRoot, input.transactionId),
        checkoutSource: ({ peeledCommit }) => {
          hooks.events?.push("checkout");
          hooks.checkout?.();
          return peeledCommit;
        },
        verifySourceCommit: () => commit,
        buildSource: async () => {
          hooks.events?.push("build");
          return buildEvidence(input.dependencies);
        },
      };
    },
    prepareCandidate: prepareCodexSourceCandidate,
    freezeCandidate: async (input, deps) => {
      hooks.events?.push("freeze");
      return freezeCodexSourceCandidate(input, deps);
    },
    assertFrontendControlParity: () => {
      hooks.events?.push("parity");
      if (hooks.parityError) throw hooks.parityError;
    },
    transactionId: () => "tx-build",
  };
  return {
    root: () => root,
    probeBundledVersion: (app) => {
      hooks.onProbe?.(app);
      return bundledVersion;
    },
    fetchJson: async () => ({ status: 200, data: release() }),
    resolveTag: async (tag) => ({ tag, refSha: commit, tagObjectShas: [], peeledCommit: commit }),
    fetchNpmVersions: async () => [bundledVersion, "0.145.0-alpha.24"],
    now: () => now,
    print: () => {},
    production,
    availableBytes: () => 100n * 1024n * 1024n * 1024n,
  };
}

function managedMcpEvidence(root: string): ManagedMcpStageEvidence {
  return {
    schemaVersion: 1,
    managedRoot: join(root, "managed-mcp"),
    stagedAt: now,
    packages: [
      managedPackage("chrome-devtools-mcp", "1.6.0", "1", join(root, "bin", "chrome"), "chrome-devtools"),
      managedPackage("@playwright/mcp", "0.0.78", "2", join(root, "bin", "playwright"), "playwright-general"),
    ],
  };
}

function managedPackage(name: string, version: string, seed: string, command: string, routeId: string) {
  const hash = (scope: string) => createHash("sha256").update(`${seed}:${scope}`).digest("hex");
  const packageDirectory = name === "@playwright/mcp" ? "playwright-mcp" : name;
  return {
    name,
    version,
    integrity: `sha512-${Buffer.from(`${name}@${version}`).toString("base64")}`,
    packageDirectory,
    destination: join("/tmp", name, version),
    disposition: "staged" as const,
    lockFile: join("/tmp", `${name}.lock.json`),
    lockSha256: hash("lock"),
    catalogFile: join("/tmp", `${name}.catalog.json`),
    catalogFileSha256: hash("catalog-file"),
    catalogDigestSha256: hash("catalog"),
    packageLockSha256: hash("package-lock"),
    dependencyGraphDigestSha256: hash("dependency-graph"),
    wrapperSha256: hash("wrapper"),
    routes: [{
      routeId,
      owner: "plugin",
      profile: null,
      command,
      args: [],
      lifecycleScope: "task",
    }],
  };
}

function buildEvidence(dependencies: readonly LockedDependencyEvidence[]): CodexSourceBuildEvidence {
  const artifact = {
    source: "official GitHub tag commit",
    platform: "darwin",
    architecture: "arm64",
    version: bundledVersion,
    digests: [digest("derived candidate binary")],
    signature: null,
  };
  return {
    source: {
      repository: "openai/codex",
      checkoutCommit: commit,
      archiveDigest: null,
      treeDigest: digest("patched source tree"),
      patchSeriesDigest: digest("patch series"),
      toolchainDigests: [digest("rustc")],
      lockfileDigests: [digest("Cargo.lock")],
    },
    dependencies,
    frontendControl: {
      ...artifact,
      source: "currently installed desktop frontend at test time",
      version: "26.715.31925",
      bundleId: "com.openai.codex",
      build: "5551",
      embeddedBackendVersion: bundledVersion,
      embeddedBackendDigests: [digest("desktop bundled backend")],
    },
    controlBinary: { ...artifact, source: "currently installed desktop frontend bundled backend" },
    candidateBinary: artifact,
  };
}

function currentReceipt(version: string, peeledCommit: string): CodexDerivedReceipt {
  const checkpoint: CodexResolutionCheckpoint = {
    name: "R1",
    channel: "bundled",
    endpoint: `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`,
    resolvedTag: `rust-v${version}`,
    normalizedVersion: version,
    peeledCommit,
    checkedAt: now,
    etag: null,
    responseBodySha256: null,
    tagObjectShas: [],
  };
  const evidence = buildEvidence([]);
  return {
    schemaVersion: 2,
    kind: "codex-derived",
    transactionId: "tx-current",
    phase: "completed",
    channel: "bundled",
    version,
    label: codexDerivedLabel("bundled", version),
    resolution: {
      endpoint: checkpoint.endpoint,
      requestedApiVersion: "2022-11-28",
      resolvedTag: checkpoint.resolvedTag,
      normalizedVersion: version,
      peeledCommit,
      checkedAt: now,
      etag: null,
      responseBodySha256: null,
      tagObjectShas: [],
      checkpoints: (["R1", "R2", "R3"] as const).map((name) => ({ ...checkpoint, name })),
      restartWindow: { opensAt: "2026-07-19T12:00:00.000Z", closesAt },
      frozenAt: now,
    },
    source: { ...evidence.source, checkoutCommit: peeledCommit },
    dependencies: [],
    frontendControl: evidence.frontendControl,
    controlBinary: evidence.controlBinary,
    candidateBinary: { ...evidence.candidateBinary, version },
    canary: {
      schemaVersion: 1,
      kind: "codex-source-canary-reference",
      sidecarPath: "/Users/test/codex-source/canary-evidence.json",
      sidecarSha256: "c".repeat(64),
      candidatePath: "/Users/test/codex-source/codex",
      candidateSha256: "d".repeat(64),
      startedAt: now,
      completedAt: now,
    },
    watcher: {
      previousFingerprints: {},
      promotedFingerprints: {},
      pauseTokenDigest: null,
      expectedFingerprintUpdatedAt: null,
      rearmedAt: null,
      wasEnabled: true,
    },
    supersedes: null,
    supersededBy: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    promotedAt: now,
    soakCompletedAt: now,
    rolledBackAt: null,
  };
}

function release(tag: string = `rust-v${bundledVersion}`) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: true,
    published_at: now,
    html_url: `https://github.com/openai/codex/releases/tag/${tag}`,
  };
}

function digest(scope: string) {
  return { algorithm: "sha256" as const, value: createHash("sha256").update(scope).digest("hex"), scope };
}
