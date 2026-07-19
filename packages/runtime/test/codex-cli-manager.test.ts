import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyManagedCodexCliLaneAtBootstrap,
  createCodexCliManager,
  deriveCodexCliPaths,
  mutateCodexFeature,
  validateArchiveEntries,
  type CodexCliManagerDependencies,
  type CodexCliRelease,
} from "../src/codex-cli-manager";

const RELEASE: CodexCliRelease = {
  version: "0.145.0-alpha.3",
  tag: "rust-v0.145.0-alpha.3",
  assetName: "codex-package-aarch64-apple-darwin.tar.gz",
  assetUrl: "https://github.com/openai/codex/releases/download/rust-v0.145.0-alpha.3/codex-package-aarch64-apple-darwin.tar.gz",
  digest: "a".repeat(64),
  architecture: "aarch64-apple-darwin",
};

test("derives every managed path under the Tweakers-owned root", () => {
  const paths = deriveCodexCliPaths("/Users/example");
  assert.equal(paths.root, "/Users/example/Library/Application Support/Tweakers/codex-cli");
  assert.equal(paths.state, join(paths.root, "state.json"));
  assert.equal(paths.releases, join(paths.root, "releases"));
  assert.equal(paths.staging, join(paths.root, "staging"));
});

test("managed Codex CLI follows the selected existing user root", () => {
  const activeRoot = "/Users/example/Library/Application Support/legacy-install";
  assert.equal(deriveCodexCliPaths("/Users/example", activeRoot).root, join(activeRoot, "codex-cli"));
});

test("archive validation rejects traversal, absolute paths, devices, and links", () => {
  assert.doesNotThrow(() => validateArchiveEntries([{ path: "package/codex", type: "file" }]));
  for (const entry of [
    { path: "../outside", type: "file" },
    { path: "/tmp/outside", type: "file" },
    { path: "package/link", type: "symlink" },
    { path: "package/device", type: "device" },
  ]) assert.throws(() => validateArchiveEntries([entry as never]), /unsafe archive/i);
});

test("install validates and atomically promotes current plus previous", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    assert.equal(manager.getState().current?.version, RELEASE.version);

    deps.resolveRelease = async () => ({ ...RELEASE, version: "0.145.0-alpha.4", tag: "rust-v0.145.0-alpha.4" });
    await manager.installBeta();
    const state = manager.getState();
    assert.equal(state.current?.version, "0.145.0-alpha.4");
    assert.equal(state.previous?.version, RELEASE.version);
    assert.equal(manager.getProgress().phase, "complete");
    assert.equal(existsSync(join(deriveCodexCliPaths(home).releases, `${RELEASE.version}-${RELEASE.architecture}`)), true);
  });
});

test("third install retains only current and previous", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    for (const suffix of ["3", "4", "5"]) {
      deps.resolveRelease = async () => ({ ...RELEASE, version: `0.145.0-alpha.${suffix}`, tag: `rust-v0.145.0-alpha.${suffix}` });
      await manager.installBeta();
    }
    assert.deepEqual(manager.listManagedVersions().sort(), ["0.145.0-alpha.4", "0.145.0-alpha.5"]);
  });
});

test("reinstalling the current version preserves the old current until the new state is durable", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    const oldCurrent = manager.getState().current!;
    await manager.installBeta();
    const state = manager.getState();
    assert.equal(state.current?.version, RELEASE.version);
    assert.equal(state.previous?.version, RELEASE.version);
    assert.notEqual(state.current?.relativeDirectory, oldCurrent.relativeDirectory);
    assert.equal(state.previous?.relativeDirectory, oldCurrent.relativeDirectory);
    assert.equal((await manager.validateCurrent()).valid, true);
  });
});

test("reinstalling the previous version atomically makes it current without invalidating rollback", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    deps.resolveRelease = async () => ({ ...RELEASE, version: "0.145.0-alpha.4", tag: "rust-v0.145.0-alpha.4" });
    await manager.installBeta();
    deps.resolveRelease = async () => ({ ...RELEASE });
    await manager.installBeta();
    const state = manager.getState();
    assert.equal(state.current?.version, RELEASE.version);
    assert.equal(state.previous?.version, "0.145.0-alpha.4");
    assert.notEqual(state.current?.relativeDirectory, `${RELEASE.version}-${RELEASE.architecture}`);
    assert.equal((await manager.validateCurrent()).valid, true);
    await manager.rollbackBeta();
    assert.equal(manager.getState().current?.version, "0.145.0-alpha.4");
  });
});

test("concurrent operation is rejected by the in-process mutex", async () => {
  await withFixture(async ({ home, deps }) => {
    let releaseDownload!: () => void;
    deps.download = async (_release, destination) => {
      await new Promise<void>((resolve) => { releaseDownload = resolve; });
      writeFileSync(destination, "archive");
      return { bytes: 7, digest: RELEASE.digest };
    };
    const manager = createCodexCliManager({ home, deps });
    const first = manager.installBeta();
    await waitUntil(() => manager.getProgress().phase === "downloading");
    await assert.rejects(manager.installBeta(), /already in progress/i);
    releaseDownload();
    await first;
  });
});

test("durable operation lock blocks a second manager and recovery clears an abandoned lock", async () => {
  await withFixture(async ({ home, deps }) => {
    const paths = deriveCodexCliPaths(home);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.lock, JSON.stringify({ operationId: "abandoned" }));
    const manager = createCodexCliManager({ home, deps });
    await assert.rejects(manager.installBeta(), /already in progress/i);
    manager.recover();
    assert.equal(existsSync(paths.lock), false);
    await manager.installBeta();
  });
});

test("digest, signature, version, and architecture failures leave state untouched and clean staging", async () => {
  for (const failure of ["digest", "signature", "version", "architecture"] as const) {
    await withFixture(async ({ home, deps }) => {
      if (failure === "digest") deps.download = async (_release, destination) => { writeFileSync(destination, "archive"); return { bytes: 7, digest: "b".repeat(64) }; };
      if (failure === "signature") deps.verifySignature = async () => false;
      if (failure === "version") deps.probeVersion = async () => "0.1.0";
      if (failure === "architecture") deps.probeArchitecture = async () => "x86_64-apple-darwin";
      const manager = createCodexCliManager({ home, deps });
      await assert.rejects(manager.installBeta(), new RegExp(failure, "i"));
      assert.equal(manager.getState().current, null);
      assert.deepEqual(manager.listStagingOperations(), []);
      assert.equal(manager.getProgress().phase, "failed");
    });
  }
});

test("promotion crash before state write preserves old state and recovers orphaned release", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    deps.resolveRelease = async () => ({ ...RELEASE, version: "0.145.0-alpha.4", tag: "rust-v0.145.0-alpha.4" });
    deps.onCrashPoint = (point) => { if (point === "after-release-rename") throw new Error("simulated crash"); };
    await assert.rejects(manager.installBeta(), /simulated crash/);
    assert.equal(manager.getState().current?.version, RELEASE.version);
    deps.onCrashPoint = undefined;
    manager.recover();
    assert.deepEqual(manager.listManagedVersions(), [RELEASE.version]);
  });
});

test("same-version rename and post-state crash points always leave current and previous valid", async () => {
  for (const point of ["after-release-rename", "after-state-write"] as const) {
    await withFixture(async ({ home, deps }) => {
      const manager = createCodexCliManager({ home, deps });
      await manager.installBeta();
      const before = manager.getState();
      deps.onCrashPoint = (candidate) => { if (candidate === point) throw new Error(`crash at ${point}`); };
      await assert.rejects(manager.installBeta(), /crash at/);
      const after = manager.getState();
      if (point === "after-release-rename") assert.deepEqual(after, before);
      else assert.notEqual(after.current?.relativeDirectory, before.current?.relativeDirectory);
      assert.equal((await manager.validateCurrent()).valid, true);
      deps.onCrashPoint = undefined;
      manager.recover();
      assert.equal((await manager.validateCurrent()).valid, true);
      if (manager.getState().previous) {
        await manager.rollbackBeta();
        assert.equal((await manager.validateCurrent()).valid, true);
      }
    });
  }
});

test("same-version rename or state-write failure never deletes the durable current", async () => {
  for (const point of ["before-release-rename", "before-state-write"] as const) {
    await withFixture(async ({ home, deps }) => {
      const manager = createCodexCliManager({ home, deps });
      await manager.installBeta();
      const before = manager.getState();
      deps.onCrashPoint = (candidate) => { if (candidate === point) throw new Error(`failed at ${point}`); };
      await assert.rejects(manager.installBeta(), /failed at/);
      assert.deepEqual(manager.getState(), before);
      assert.equal((await manager.validateCurrent()).valid, true);
      deps.onCrashPoint = undefined;
      manager.recover();
      assert.deepEqual(manager.getState(), before);
      assert.equal((await manager.validateCurrent()).valid, true);
    });
  }
});

test("rollback swaps only after previous is revalidated", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    deps.resolveRelease = async () => ({ ...RELEASE, version: "0.145.0-alpha.4", tag: "rust-v0.145.0-alpha.4" });
    await manager.installBeta();
    await manager.rollbackBeta();
    assert.equal(manager.getState().current?.version, RELEASE.version);
    deps.verifySignature = async () => false;
    await assert.rejects(manager.rollbackBeta(), /signature/i);
    assert.equal(manager.getState().current?.version, RELEASE.version);
  });
});

test("committed managed receipt rejects binary-byte tampering", async () => {
  await withFixture(async ({ home, deps }) => {
    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    const binary = manager.getSelectedBinary();
    assert.ok(binary);
    writeFileSync(binary, "tampered", { flag: "a" });
    const validation = await manager.validateCurrent();
    assert.equal(validation.valid, false);
    assert.match(validation.error ?? "", /binary digest/i);
  });
});

test("bootstrap preserves unmanaged override, clears bundled, applies validated beta, and falls back safely", async () => {
  await withFixture(async ({ home, deps }) => {
    const emptyEnv: NodeJS.ProcessEnv = {};
    const absent = applyManagedCodexCliLaneAtBootstrap({ lane: undefined, home, env: emptyEnv });
    assert.equal(absent.userOverridePreserved, false);
    assert.equal(absent.effectiveLane, "bundled");
    const env: NodeJS.ProcessEnv = { CODEX_CLI_PATH: "/user/override" };
    const present = applyManagedCodexCliLaneAtBootstrap({ lane: undefined, home, env });
    assert.equal(present.userOverridePreserved, true);
    assert.equal(present.effectiveLane, "beta");
    assert.equal(env.CODEX_CLI_PATH, "/user/override");
    assert.equal(applyManagedCodexCliLaneAtBootstrap({ lane: "bundled", home, env }).effectiveLane, "bundled");
    assert.equal(env.CODEX_CLI_PATH, undefined);

    const isolated = "/tmp/tweaker-environments/alpha/backend/codex";
    const explicit = applyManagedCodexCliLaneAtBootstrap({
      lane: "beta",
      home,
      env,
      selectedManagedCli: {
        binaryPath: isolated,
        version: "0.145.0-alpha.3",
        fingerprint: "b".repeat(64),
      },
      validateSelectedManagedBinary: () => ({ valid: true }),
    });
    assert.equal(explicit.effectiveLane, "beta");
    assert.equal(explicit.binary, isolated);
    assert.equal(env.CODEX_CLI_PATH, isolated);

    const rejectedExplicit = applyManagedCodexCliLaneAtBootstrap({
      lane: "beta",
      home,
      env,
      selectedManagedCli: {
        binaryPath: isolated,
        version: "0.145.0-alpha.3",
        fingerprint: "b".repeat(64),
      },
      validateSelectedManagedBinary: () => ({ valid: false, error: "fingerprint mismatch" }),
    });
    assert.equal(rejectedExplicit.effectiveLane, "bundled");
    assert.equal(env.CODEX_CLI_PATH, undefined);

    const manager = createCodexCliManager({ home, deps });
    await manager.installBeta();
    const valid = applyManagedCodexCliLaneAtBootstrap({ lane: "beta", home, env, validateManagedBinary: () => ({ valid: true }) });
    assert.equal(valid.effectiveLane, "beta");
    assert.ok(env.CODEX_CLI_PATH?.startsWith(deriveCodexCliPaths(home).root));

    const failures: string[] = [];
    const invalid = applyManagedCodexCliLaneAtBootstrap({ lane: "beta", home, env, validateManagedBinary: () => ({ valid: false, error: "signature invalid at /secret/path" }), persistFailure: (message) => failures.push(message) });
    assert.equal(invalid.effectiveLane, "bundled");
    assert.equal(env.CODEX_CLI_PATH, undefined);
    assert.match(failures[0], /signature invalid/);
    assert.doesNotMatch(failures[0], /secret/);
  });
});

test("feature mutation refreshes, exact-matches mutable entries, and executes without a shell", async () => {
  const calls: unknown[][] = [];
  const deps = {
    inventory: async () => [{ name: "responses_websockets", stage: "experimental" as const, enabled: false }],
    execFile: async (...args: unknown[]) => { calls.push(args); },
  };
  await mutateCodexFeature({ lane: "beta", name: "responses_websockets", enabled: true }, deps);
  assert.deepEqual(calls[0]?.slice(1, 3), [["features", "enable", "responses_websockets"], { timeout: 5_000, shell: false }]);
  await assert.rejects(mutateCodexFeature({ lane: "beta", name: "unknown", enabled: true }, deps), /not reported/i);
  deps.inventory = async () => [{ name: "old", stage: "deprecated" as const, enabled: true }];
  await assert.rejects(mutateCodexFeature({ lane: "beta", name: "old", enabled: false }, deps), /read-only/i);
});

async function withFixture(fn: (value: { home: string; deps: CodexCliManagerDependencies }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "codex-cli-manager-"));
  const deps: CodexCliManagerDependencies = {
    now: () => new Date("2026-07-13T12:00:00.000Z"),
    operationId: () => `op-${Math.random().toString(16).slice(2)}`,
    resolveRelease: async () => ({ ...RELEASE }),
    download: async (_release, destination) => { writeFileSync(destination, "archive"); return { bytes: 7, digest: RELEASE.digest }; },
    listArchive: async () => [{ path: "package/codex", type: "file" }],
    extractArchive: async (_archive, destination) => {
      const binary = join(destination, "package", "codex");
      mkdirSync(join(destination, "package"), { recursive: true });
      writeFileSync(binary, "binary"); chmodSync(binary, 0o755);
    },
    verifySignature: async () => true,
    probeVersion: async (binary) => JSON.parse(readFileSync(join(binary, "..", "..", "receipt-input.json"), "utf8")).version,
    probeArchitecture: async () => RELEASE.architecture,
  };
  // The fixture probe obtains the active release through a small hook replaced below.
  deps.extractArchive = async (_archive, destination) => {
    const binary = join(destination, "package", "codex");
    mkdirSync(join(destination, "package"), { recursive: true });
    writeFileSync(binary, "binary"); chmodSync(binary, 0o755);
    const release = await deps.resolveRelease();
    writeFileSync(join(destination, "receipt-input.json"), JSON.stringify(release));
  };
  try { await fn({ home, deps }); } finally { rmSync(home, { recursive: true, force: true }); }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}
