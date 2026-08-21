import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { userPaths } from "../src/paths";
import {
  createEnvironmentSelection,
  createProtectedEnvironmentSelection,
  createEnvironmentProfileRegistry,
  defaultEnvironmentProfileRegistry,
  createRequestedEnvironmentSelection,
  inspectEnvironmentProfile,
  loadEnvironmentState,
  migrateLegacyEnvironmentFiles,
  migrateLegacyEnvironmentSelection,
  isEnvironmentSelectionHealthy,
  isNormalProtectedEnvironment,
  isPristineOpenAiRecoveryEnvironment,
  normalizeBackendLane,
  publishEnvironmentSnapshot,
  registerAlphaDesktopProfile,
  readEnvironmentSelection,
  recoverEnvironmentDocumentCommit,
  readEnvironmentProfileRegistry,
  validateOfficialEnvironmentProfile,
  validateEnvironmentSelection,
  writeEnvironmentProfileRegistry,
  type EnvironmentProfileRegistry,
} from "../src/environment-profile";

test("read-only profile inspection never executes a support-root Stable backend", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-inspection",
  });
  const profile = registry.profiles.stable;
  const current = createEnvironmentSelection({
    profile,
    appExperience: "tweakers",
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:00.000Z",
  });
  const versionReads: string[] = [];
  const evidence = inspectEnvironmentProfile(profile, current, {
    exists: () => true,
    validateOfficial: (selection) => ({
      selection,
      trust: {
        strictSignature: { ok: true, output: "valid" },
        signatureIdentity: {
          ok: true,
          adHoc: false,
          teamIdentifier: "2DC432GLL2",
          authority: ["Developer ID Application: OpenAI, L.L.C."],
          output: "valid",
        },
        gatekeeper: { ok: true, output: "accepted" },
        designatedRequirement: {
          ok: true,
          requirement: 'designated => identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"',
          output: "valid",
        },
      },
    }),
    readIdentity: () => ({ version: "26.715.1", build: "5484" }),
    readVersion: (path) => {
      versionReads.push(path);
      return "0.145.0";
    },
    fingerprintFile: (path) => path.startsWith(profile.patchedPayloadPath)
      ? "tampered-support-backend"
      : "trusted-official-backend",
    fingerprintApp: (path) => `app:${path}`,
  });

  assert.deepEqual(versionReads, [profile.officialBackendPath]);
  assert.equal(evidence.backendVersion, null);
  assert.equal(evidence.backendFingerprint, "tampered-support-backend");
});

test("profile registry records stable and alpha as exact desktop selections", () => {
  const registry: EnvironmentProfileRegistry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
  });

  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.selected, null);
  assert.equal(registry.lastKnownWorkingSelection, null);
  assert.equal(registry.profiles.stable.selectedDesktopPath, "/Applications/ChatGPT.app");
  assert.equal(registry.profiles.stable.selectedDesktopBundleId, "com.openai.codex");
  assert.equal(registry.profiles.alpha.selectedDesktopPath, "/Applications/ChatGPT (Beta).app");
  assert.equal(registry.profiles.alpha.selectedDesktopBundleId, "com.openai.codex.beta");
  assert.equal(registry.profiles.stable.available, false);
  assert.equal(registry.profiles.alpha.available, false);
});

test("production load preserves a registered exact Alpha path over the legacy default", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-alpha-path-"));
  try {
    const registeredPath = "/Users/test/Applications/OpenAI Beta.app";
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: registeredPath,
      environmentRoot: root,
      selected: null,
      alphaEvidence: {
        officialVersion: "26.717.1",
        officialBuild: "6001",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: 'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        officialBackendVersion: "0.145.0-alpha.3",
        officialBackendFingerprint: "alpha-official",
        backendVersion: "0.145.0-alpha.3",
        backendFingerprint: "alpha-managed",
        pristineBackupFingerprint: "alpha-pristine",
        patchedPayloadFingerprint: "alpha-patched",
      },
    });
    const registryFile = join(root, "environment-registry.json");
    writeEnvironmentProfileRegistry(registryFile, registry);
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "chatgpt" }));
    const loaded = loadEnvironmentState({
      legacyStateFile: join(root, "state.json"),
      registryFile,
      selectionFile: join(root, "environment-selection.json"),
      environmentRoot: root,
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    }, {
      inspectProfile: (profile) => ({
        officialVersion: profile.releaseProfile === "alpha" ? "26.717.1" : "26.707.1",
        officialBuild: profile.releaseProfile === "alpha" ? "6001" : "5900",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement: `designated => identifier "${profile.officialBundleId}" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`,
        signatureCheckedAt: "2026-07-17T02:00:00.000Z",
        officialBackendVersion: profile.releaseProfile === "alpha" ? "0.145.0-alpha.3" : "0.144.5",
        officialBackendFingerprint: profile.releaseProfile === "alpha" ? "alpha-official" : "stable-official",
        backendVersion: profile.releaseProfile === "alpha" ? "0.145.0-alpha.3" : "0.144.5",
        backendFingerprint: profile.releaseProfile === "alpha" ? "alpha-managed" : "stable-managed",
        pristineBackupFingerprint: "pristine",
        patchedPayloadFingerprint: "patched",
      }),
    });
    assert.equal(loaded.registry.profiles.alpha.officialPath, registeredPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registerAlphaDesktopProfile requires trusted Beta identity and prerelease bundled backend", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-register-alpha",
  });
  const selectedPath = "/Users/test/OpenAI Beta.app";
  const next = registerAlphaDesktopProfile(registry, selectedPath, {
    locateExact: (path) => ({ appRoot: path, bundleId: "com.openai.codex.beta" }),
    verifyStrictSignature: () => ({ ok: true, output: "strict" }),
    signatureIdentity: () => ({ ok: true, adHoc: false, teamIdentifier: "2DC432GLL2", authority: ["Developer ID Application: OpenAI, L.L.C."], output: "identity" }),
    assessGatekeeper: () => ({ ok: true, output: "accepted" }),
    designatedRequirement: () => ({ ok: true, output: "designated", requirement: 'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"' }),
    exists: () => true,
    readIdentity: () => ({ version: "26.717.1", build: "6001" }),
    readVersion: () => "0.145.0-alpha.3",
    fingerprintFile: () => "beta-backend",
    now: () => "2026-07-17T03:00:00.000Z",
  });
  assert.equal(next.profiles.alpha.officialPath, selectedPath);
  assert.equal(next.profiles.alpha.officialBackendVersion, "0.145.0-alpha.3");
  assert.equal(next.selected, registry.selected);
});

test("registry retains selected, last-known-working, and isolated per-channel artifacts", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
  });
  const selected = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "tweakers",
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:00.000Z",
  });
  const withSelection = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    selected,
    lastKnownWorkingSelection: selected,
  });

  assert.deepEqual(withSelection.selected, selected);
  assert.deepEqual(withSelection.lastKnownWorkingSelection, selected);
  assert.equal(withSelection.profiles.stable.officialPath, "/Applications/ChatGPT.app");
  assert.equal(withSelection.profiles.stable.officialBundleId, "com.openai.codex");
  assert.equal(withSelection.profiles.stable.backendChannel, "bundled");
  assert.equal(withSelection.profiles.alpha.backendChannel, "managed-alpha");
  assert.notEqual(withSelection.profiles.stable.backendPath, withSelection.profiles.alpha.backendPath);
  assert.notEqual(withSelection.profiles.stable.pristineBackupPath, withSelection.profiles.alpha.pristineBackupPath);
  assert.notEqual(withSelection.profiles.stable.patchedPayloadPath, withSelection.profiles.alpha.patchedPayloadPath);
});

test("valid side-by-side Alpha is available only with its own complete evidence", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    alphaEvidence: {
      officialVersion: "26.717.1",
      officialBuild: "6001",
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement:
        'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      signatureCheckedAt: "2026-07-17T02:00:00.000Z",
      officialBackendVersion: "0.145.0-alpha.3",
      officialBackendFingerprint: "alpha-official-backend-sha256",
      backendVersion: "0.145.0-alpha.3",
      backendFingerprint: "alpha-backend-sha256",
      pristineBackupFingerprint: "alpha-pristine-sha256",
      patchedPayloadFingerprint: "alpha-patched-sha256",
    },
  });

  assert.equal(registry.profiles.alpha.available, true);
  assert.deepEqual(registry.profiles.alpha.unavailableReasons, []);
  assert.equal(registry.profiles.alpha.availability.chatgpt.available, true);
  assert.equal(registry.profiles.alpha.availability.tweakers.available, true);
  assert.equal(registry.profiles.stable.available, false);
  assert.notEqual(registry.profiles.alpha.backendPath, registry.profiles.stable.backendPath);
});

test("registry rejects backend channel mismatches and shared channel artifacts", () => {
  assert.throws(() => createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    stableEvidence: { backendChannel: "managed-alpha" },
  }), /stable backend channel must be bundled/);

  assert.throws(() => createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    alphaEvidence: { backendPath: "/Applications/ChatGPT.app/Contents/Resources/codex" },
  }), /must remain inside its isolated environment channel/);
});

test("alpha remains unavailable until trust, version, and managed backend evidence all pass", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    alphaEvidence: {
      strictSignature: true,
      gatekeeper: true,
      designatedRequirement:
        'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      teamIdentifier: "2DC432GLL2",
      signatureCheckedAt: "2026-07-17T02:00:00.000Z",
      backendVersion: "0.145.0-alpha.3",
      backendFingerprint: null,
      officialVersion: "26.717.1",
      officialBuild: "6001",
      pristineBackupFingerprint: "pristine",
      patchedPayloadFingerprint: "patched",
    },
  });
  assert.equal(registry.profiles.alpha.availability.tweakers.available, false);
  assert.deepEqual(registry.profiles.alpha.availability.tweakers.unavailableReasons, ["Managed alpha backend is unavailable"]);
});

test("trusted official Beta enables ChatGPT Alpha while managed Alpha remains independently unavailable", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    alphaEvidence: {
      officialVersion: "26.717.1",
      officialBuild: "6001",
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement:
        'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      signatureCheckedAt: "2026-07-17T02:00:00.000Z",
      officialBackendVersion: "0.145.0-alpha.3",
      officialBackendFingerprint: "official-beta-backend-sha256",
      backendInstallable: false,
      patchedPayloadBuildable: true,
    },
  });

  assert.equal(registry.profiles.alpha.availability.chatgpt.available, true);
  assert.equal(registry.profiles.alpha.availability.tweakers.available, false);
  assert.deepEqual(
    registry.profiles.alpha.availability.tweakers.unavailableReasons,
    ["Managed alpha backend is unavailable"],
  );
});

test("Alpha rejects a trusted Beta desktop whose bundled or managed backend is on the stable channel", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    alphaEvidence: {
      officialVersion: "26.717.1",
      officialBuild: "6001",
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement:
        'designated => identifier "com.openai.codex.beta" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      signatureCheckedAt: "2026-07-17T02:00:00.000Z",
      officialBackendVersion: "0.145.0",
      officialBackendFingerprint: "stable-official-backend-sha256",
      backendVersion: "0.145.0",
      backendFingerprint: "stable-managed-backend-sha256",
      patchedPayloadFingerprint: "alpha-patched-sha256",
    },
  });

  assert.equal(registry.profiles.alpha.availability.chatgpt.available, false);
  assert.deepEqual(
    registry.profiles.alpha.availability.chatgpt.unavailableReasons,
    ["Official Beta bundled backend is not an Alpha release"],
  );
  assert.equal(registry.profiles.alpha.availability.tweakers.available, false);
  assert.deepEqual(
    registry.profiles.alpha.availability.tweakers.unavailableReasons,
    ["Managed alpha backend is not an Alpha release"],
  );
});

test("a buildable stable patched payload also makes its bundled backend preparable", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: "/tmp/tweaker-environments",
    stableEvidence: {
      officialVersion: "26.707.1",
      officialBuild: "5900",
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement:
        'designated => identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      signatureCheckedAt: "2026-07-17T02:00:00.000Z",
      officialBackendVersion: "0.145.0",
      officialBackendFingerprint: "stable-official-backend-sha256",
      patchedPayloadBuildable: true,
    },
  });

  assert.equal(registry.profiles.stable.backendInstallable, false);
  assert.equal(registry.profiles.stable.availability.tweakers.available, true);
  assert.deepEqual(registry.profiles.stable.availability.tweakers.unavailableReasons, []);
});

test("installer paths own profile, selection, and environment transaction receipts", () => {
  const previous = process.env.TWEAKER_HOME;
  process.env.TWEAKER_HOME = "/tmp/tweaker-environment-home";
  try {
    const paths = userPaths();
    assert.equal(paths.environmentRegistryFile, "/tmp/tweaker-environment-home/environment-registry.json");
    assert.equal(paths.environmentProfileFile, "/tmp/tweaker-environment-home/environment-registry.json");
    assert.equal(paths.legacyEnvironmentProfileFile, "/tmp/tweaker-environment-home/environment-profiles.json");
    assert.equal(paths.environmentSelectionFile, "/tmp/tweaker-environment-home/environment-selection.json");
    assert.equal(paths.environmentTransactionFile, "/tmp/tweaker-environment-home/transactions/environment.json");
    assert.equal(paths.environmentReceiptRoot, "/tmp/tweaker-environment-home/transactions/environment");
    assert.equal(paths.environmentLockFile, "/tmp/tweaker-environment-home/transactions/environment.lock");
    assert.equal(paths.environmentModeCacheRoot, "/tmp/tweaker-environment-home/environment-cache");
    assert.equal(paths.environmentModeCacheCurrentFile, "/tmp/tweaker-environment-home/environment-cache/current.json");
    assert.equal(paths.environmentModeCacheGenerationsRoot, "/tmp/tweaker-environment-home/environment-cache/generations");
    assert.equal(paths.environmentModeCachePreparationRoot, "/tmp/tweaker-environment-home/environment-cache/next");
    assert.equal(paths.environmentModeCacheLockFile, "/tmp/tweaker-environment-home/environment-cache/environment-mode-cache.lock");
  } finally {
    if (previous === undefined) delete process.env.TWEAKER_HOME;
    else process.env.TWEAKER_HOME = previous;
  }
});

test("legacy persisted mode migrates to the stable release profile", () => {
  const registry = defaultEnvironmentProfileRegistry();
  const migrated = migrateLegacyEnvironmentSelection(
    { mode: "tweakers" },
    registry,
    "2026-07-17T01:00:00.000Z",
  );

  assert.deepEqual(migrated, {
    selectedDesktopPath: "/Applications/ChatGPT.app",
    selectedDesktopBundleId: "com.openai.codex",
    appExperience: "tweakers",
    releaseProfile: "stable",
    backendLane: "bundled",
    uiFeatures: "on",
    mcpSafetyProvider: "managed-turn-idle",
    recoveryState: "normal-protected",
    migrationState: "migration-blocked",
    quarantineReason: null,
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:00.000Z",
  });
});

test("schema-2 distinguishes normal protection, degraded pristine recovery, and a receipt-blocked legacy intent", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });
  const uiOff = createProtectedEnvironmentSelection({
    profile: registry.profiles.stable,
    uiFeatures: "off",
    requestedAt: "2026-08-12T19:00:00.000Z",
  });
  const legacyManaged = createEnvironmentSelection({
    profile: registry.profiles.alpha,
    appExperience: "tweakers",
    requestedAt: "2026-08-12T19:00:00.000Z",
    appliedAt: "2026-08-12T19:00:01.000Z",
  });
  const recovery = createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-08-12T19:00:00.000Z",
    appliedAt: "2026-08-12T19:00:01.000Z",
  });

  assert.equal(isNormalProtectedEnvironment(uiOff), true);
  assert.equal(uiOff.mcpSafetyProvider, "managed-turn-idle");
  assert.equal(uiOff.recoveryState, "normal-protected");
  assert.equal(uiOff.migrationState, "requested");
  assert.equal(isEnvironmentSelectionHealthy(uiOff), false);

  assert.equal(isNormalProtectedEnvironment(legacyManaged), true);
  assert.equal(legacyManaged.migrationState, "migration-blocked");
  assert.equal(isEnvironmentSelectionHealthy(legacyManaged), false);

  assert.equal(isPristineOpenAiRecoveryEnvironment(recovery), true);
  assert.equal(recovery.mcpSafetyProvider, "official-bundled-degraded");
  assert.equal(recovery.recoveryState, "pristine-openai-recovery");
  assert.equal(isEnvironmentSelectionHealthy(recovery), true);
});

test("profile registry persists and reads through its schema-versioned public API", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-profiles-"));
  const file = join(root, "environment-registry.json");
  try {
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    });
    writeEnvironmentProfileRegistry(file, registry);

    assert.deepEqual(readEnvironmentProfileRegistry(file), registry);
    assert.equal(existsSync(file), true);
    assert.deepEqual(readdirSync(root), ["environment-registry.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical registry read accepts the legacy profiles filename without rewriting old bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-registry-compat-"));
  const canonical = join(root, "environment-registry.json");
  const legacy = join(root, "environment-profiles.json");
  try {
    const registry = createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
      environmentRoot: root,
    });
    const legacyBytes = `${JSON.stringify(registry, null, 2)}\n`;
    writeFileSync(legacy, legacyBytes);
    assert.deepEqual(readEnvironmentProfileRegistry(canonical), registry);
    assert.equal(existsSync(canonical), false);
    assert.equal(readFileSync(legacy, "utf8"), legacyBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection validation proves exact bundle identity and every macOS trust gate", () => {
  const selection = createEnvironmentSelection({
    profile: createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    }).profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
  });
  const calls: string[] = [];

  const result = validateEnvironmentSelection(selection, {
    locateExact: (path) => {
      calls.push(`locate:${path}`);
      return { appRoot: path, bundleId: "com.openai.codex" };
    },
    verifyStrictSignature: (path) => {
      calls.push(`signature:${path}`);
      return { ok: true, output: "valid on disk" };
    },
    signatureIdentity: (path) => {
      calls.push(`identity:${path}`);
      return {
        ok: true,
        adHoc: false,
        teamIdentifier: "2DC432GLL2",
        authority: ["Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)"],
        output: "TeamIdentifier=2DC432GLL2",
      };
    },
    assessGatekeeper: (path) => {
      calls.push(`gatekeeper:${path}`);
      return { ok: true, output: "accepted" };
    },
    designatedRequirement: (path) => {
      calls.push(`requirement:${path}`);
      return {
        ok: true,
        requirement:
          'designated => identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
        output: "",
      };
    },
  });

  assert.equal(result.selection, selection);
  assert.deepEqual(calls, [
    "locate:/Applications/ChatGPT.app",
    "signature:/Applications/ChatGPT.app",
    "identity:/Applications/ChatGPT.app",
    "gatekeeper:/Applications/ChatGPT.app",
    "requirement:/Applications/ChatGPT.app",
  ]);
});

test("official profile trust fails closed for stale path, wrong bundle, wrong team, and invalid signature", () => {
  const selection = createEnvironmentSelection({
    profile: createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
      environmentRoot: "/tmp/tweaker-environments",
    }).profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
  });
  const trusted = {
    locateExact: (path: string) => ({ appRoot: path, bundleId: "com.openai.codex" as const }),
    verifyStrictSignature: () => ({ ok: true, output: "valid on disk" }),
    signatureIdentity: () => ({
      ok: true,
      adHoc: false,
      teamIdentifier: "2DC432GLL2",
      authority: ["Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)"],
      output: "TeamIdentifier=2DC432GLL2",
    }),
    assessGatekeeper: () => ({ ok: true, output: "accepted" }),
    designatedRequirement: () => ({
      ok: true,
      requirement:
        'designated => identifier "com.openai.codex" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"',
      output: "",
    }),
  };

  assert.throws(() => validateOfficialEnvironmentProfile(selection, {
    ...trusted,
    locateExact: () => { throw new Error("stale exact path"); },
  }), /stale exact path/);
  assert.throws(() => validateOfficialEnvironmentProfile(selection, {
    ...trusted,
    locateExact: (path) => ({ appRoot: path, bundleId: "com.openai.codex.beta" }),
  }), /bundle mismatch/);
  assert.throws(() => validateOfficialEnvironmentProfile(selection, {
    ...trusted,
    signatureIdentity: () => ({
      ok: true,
      adHoc: false,
      teamIdentifier: "WRONGTEAM",
      authority: ["Developer ID Application: Example"],
      output: "TeamIdentifier=WRONGTEAM",
    }),
  }), /not signed by OpenAI Team 2DC432GLL2/);
  assert.throws(() => validateOfficialEnvironmentProfile(selection, {
    ...trusted,
    verifyStrictSignature: () => ({ ok: false, output: "invalid signature" }),
  }), /strict signature verification failed/);
});

test("selection derives its backend lane from app experience and release profile", () => {
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
  });

  assert.equal(createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
  }).backendLane, "official-bundled");
  assert.equal(createEnvironmentSelection({
    profile: registry.profiles.alpha,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
  }).backendLane, "official-bundled");
  assert.equal(createEnvironmentSelection({
    profile: registry.profiles.stable,
    appExperience: "tweakers",
    requestedAt: "2026-07-17T01:00:00.000Z",
  }).backendLane, "bundled");
  assert.equal(createEnvironmentSelection({
    profile: registry.profiles.alpha,
    appExperience: "tweakers",
    requestedAt: "2026-07-17T01:00:00.000Z",
  }).backendLane, "managed-alpha");
});

test("alpha validation fails closed at its selected path", () => {
  const selection = createEnvironmentSelection({
    profile: createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    }).profiles.alpha,
    appExperience: "tweakers",
  });
  const located: string[] = [];

  assert.throws(
    () => validateEnvironmentSelection(selection, {
      locateExact: (path) => {
        located.push(path);
        throw new Error("missing alpha desktop");
      },
    }),
    /missing alpha desktop/,
  );
  assert.deepEqual(located, ["/Applications/ChatGPT (Beta).app"]);
});

test("legacy bundled and beta lane reads remain compatible", () => {
  assert.equal(normalizeBackendLane("bundled"), "bundled");
  assert.equal(normalizeBackendLane("beta"), "managed-alpha");
  assert.equal(normalizeBackendLane("official-bundled"), "official-bundled");
  assert.equal(normalizeBackendLane("managed-alpha"), "managed-alpha");
  assert.equal(normalizeBackendLane("unknown"), null);
});

test("selection reader upgrades the legacy beta lane on read", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-selection-"));
  const file = join(root, "environment-selection.json");
  try {
    writeFileSync(file, JSON.stringify({
      selectedDesktopPath: "/Applications/ChatGPT (Beta).app",
      selectedDesktopBundleId: "com.openai.codex.beta",
      appExperience: "tweakers",
      releaseProfile: "alpha",
      backendLane: "beta",
      requestedAt: "2026-07-17T01:00:00.000Z",
      appliedAt: null,
    }));
    const selection = readEnvironmentSelection(file);
    assert.equal(selection?.backendLane, "managed-alpha");
    assert.equal(selection?.uiFeatures, "on");
    assert.equal(selection?.mcpSafetyProvider, "managed-turn-idle");
    assert.equal(selection?.recoveryState, "normal-protected");
    assert.equal(selection?.migrationState, "migration-blocked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-2 reader refuses missing or mismatched legacy coupling instead of inferring normal protection", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-invalid-coupling-"));
  const file = join(root, "environment-selection.json");
  try {
    writeFileSync(file, JSON.stringify({
      selectedDesktopPath: "/Applications/ChatGPT.app",
      selectedDesktopBundleId: "com.openai.codex",
      appExperience: "chatgpt",
      releaseProfile: "stable",
      backendLane: "bundled",
      requestedAt: "2026-08-12T19:00:00.000Z",
      appliedAt: null,
    }));
    assert.throws(() => readEnvironmentSelection(file), /invalid/);

    writeFileSync(file, JSON.stringify({
      selectedDesktopPath: "/Applications/ChatGPT.app",
      selectedDesktopBundleId: "com.openai.codex",
      appExperience: "tweakers",
      releaseProfile: "stable",
      backendLane: "bundled",
      uiFeatures: "off",
      mcpSafetyProvider: "official-bundled-degraded",
      recoveryState: "normal-protected",
      migrationState: "verified",
      quarantineReason: null,
      requestedAt: "2026-08-12T19:00:00.000Z",
      appliedAt: null,
    }));
    assert.throws(() => readEnvironmentSelection(file), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry reader upgrades a schema-1 document in memory without rewriting its source bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-registry-v1-"));
  const file = join(root, "environment-registry.json");
  try {
    const current = createEnvironmentProfileRegistry({
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
      environmentRoot: root,
    });
    const legacy = {
      ...current,
      schemaVersion: 1,
      selected: {
        selectedDesktopPath: "/Applications/ChatGPT.app",
        selectedDesktopBundleId: "com.openai.codex",
        releaseProfile: "stable",
        appExperience: "tweakers",
        backendLane: "bundled",
        requestedAt: "2026-08-12T19:00:00.000Z",
        appliedAt: "2026-08-12T19:00:01.000Z",
      },
      lastKnownWorkingSelection: {
        selectedDesktopPath: "/Applications/ChatGPT.app",
        selectedDesktopBundleId: "com.openai.codex",
        releaseProfile: "stable",
        appExperience: "tweakers",
        backendLane: "bundled",
        requestedAt: "2026-08-12T19:00:00.000Z",
        appliedAt: "2026-08-12T19:00:01.000Z",
      },
    };
    const bytes = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(file, bytes);
    const migrated = readEnvironmentProfileRegistry(file)!;
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.selected?.migrationState, "migration-blocked");
    assert.equal(migrated.lastKnownWorkingSelection?.migrationState, "migration-blocked");
    assert.equal(readFileSync(file, "utf8"), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stable-only legacy migration is atomic, keeps legacy bytes, and leaves missing Alpha unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-migration-"));
  const legacyStateFile = join(root, "state.json");
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  const legacyBytes = '{"mode":"tweakers","unrelated":"preserve-me"}\n';
  try {
    writeFileSync(legacyStateFile, legacyBytes);
    const migrated = migrateLegacyEnvironmentFiles({
      legacyStateFile,
      registryFile,
      selectionFile,
      environmentRoot: root,
      now: "2026-07-17T01:00:00.000Z",
    });

    assert.equal(migrated.selection.releaseProfile, "stable");
    assert.equal(migrated.selection.appExperience, "tweakers");
    assert.equal(migrated.registry.profiles.alpha.available, false);
    assert.match(migrated.registry.profiles.alpha.unavailableReasons.join("\n"), /Alpha|alpha|not been verified/);
    assert.equal(readFileSync(legacyStateFile, "utf8"), legacyBytes);
    assert.deepEqual(readEnvironmentProfileRegistry(registryFile), migrated.registry);
    assert.deepEqual(readEnvironmentSelection(selectionFile), migrated.selection);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed legacy migration preserves every pre-existing byte and rejects partial registry data", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-migration-fail-"));
  const legacyStateFile = join(root, "state.json");
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  const legacyBytes = '{"mode":"chatgpt","token":"legacy-byte-proof"}\n';
  const registryBytes = '{"old":"registry"}\n';
  const selectionBytes = '{"old":"selection"}\n';
  try {
    writeFileSync(legacyStateFile, legacyBytes);
    writeFileSync(registryFile, registryBytes);
    writeFileSync(selectionFile, selectionBytes);
    assert.throws(() => migrateLegacyEnvironmentFiles({
      legacyStateFile,
      registryFile,
      selectionFile,
      environmentRoot: root,
      now: "2026-07-17T01:00:00.000Z",
    }, {
      beforeCommit: () => { throw new Error("injected migration failure"); },
    }), /injected migration failure/);

    assert.equal(readFileSync(legacyStateFile, "utf8"), legacyBytes);
    assert.equal(readFileSync(registryFile, "utf8"), registryBytes);
    assert.equal(readFileSync(selectionFile, "utf8"), selectionBytes);

    writeFileSync(registryFile, JSON.stringify({ schemaVersion: 1, profiles: { stable: {} } }));
    assert.throws(() => readEnvironmentProfileRegistry(registryFile), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishEnvironmentSnapshot journals a matching registry and selection as one pair", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-snapshot-"));
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  try {
    const base = defaultEnvironmentProfileRegistry(root);
    const selection = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-24T20:00:00.000Z",
      appliedAt: "2026-07-24T20:00:00.000Z",
    });
    const registry: EnvironmentProfileRegistry = {
      ...base,
      selected: selection,
      lastKnownWorkingSelection: selection,
    };

    publishEnvironmentSnapshot(registryFile, selectionFile, registry, selection);

    assert.deepEqual(readEnvironmentProfileRegistry(registryFile), registry);
    assert.deepEqual(readEnvironmentSelection(selectionFile), selection);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishEnvironmentSnapshot refuses a registry whose selected or last-known-working value differs", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-snapshot-mismatch-"));
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  try {
    const base = defaultEnvironmentProfileRegistry(root);
    const selection = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-24T20:00:00.000Z",
      appliedAt: "2026-07-24T20:00:00.000Z",
    });
    const other = createEnvironmentSelection({
      profile: base.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-24T20:01:00.000Z",
      appliedAt: "2026-07-24T20:01:00.000Z",
    });

    assert.throws(() => publishEnvironmentSnapshot(registryFile, selectionFile, {
      ...base,
      selected: other,
      lastKnownWorkingSelection: selection,
    }, selection), /selected value does not match/);
    assert.equal(existsSync(registryFile), false);
    assert.equal(existsSync(selectionFile), false);

    assert.throws(() => publishEnvironmentSnapshot(registryFile, selectionFile, {
      ...base,
      selected: selection,
      lastKnownWorkingSelection: other,
    }, selection), /last-known-working selection does not match/);
    assert.equal(existsSync(registryFile), false);
    assert.equal(existsSync(selectionFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup journal recovery completes a process crash between registry and selection promotion", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-crash-journal-"));
  const legacyStateFile = join(root, "state.json");
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  try {
    writeFileSync(legacyStateFile, '{"mode":"tweakers"}\n');
    const moduleUrl = pathToFileURL(resolve("packages/installer/src/environment-profile.ts")).href;
    const script = `
      const api = await import(${JSON.stringify(moduleUrl)});
      api.migrateLegacyEnvironmentFiles({
        legacyStateFile: ${JSON.stringify(legacyStateFile)},
        registryFile: ${JSON.stringify(registryFile)},
        selectionFile: ${JSON.stringify(selectionFile)},
        environmentRoot: ${JSON.stringify(root)},
        now: "2026-07-17T01:00:00.000Z"
      }, { afterRegistryCommit: () => process.exit(73) });
    `;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 73, crashed.stderr);
    assert.equal(existsSync(registryFile), true);
    assert.equal(existsSync(selectionFile), false);
    assert.equal(existsSync(join(root, "environment-state-commit.json")), true);

    assert.equal(recoverEnvironmentDocumentCommit(registryFile, selectionFile), true);
    const registry = readEnvironmentProfileRegistry(registryFile)!;
    const selection = readEnvironmentSelection(selectionFile)!;
    assert.deepEqual(registry.selected, selection);
    assert.equal(existsSync(join(root, "environment-state-commit.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup journal recovery removes a durable journal after both documents were promoted", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-crash-after-selection-"));
  const legacyStateFile = join(root, "state.json");
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  const journalFile = join(root, "environment-state-commit.json");
  try {
    writeFileSync(legacyStateFile, '{"mode":"tweakers"}\n');
    const moduleUrl = pathToFileURL(resolve("packages/installer/src/environment-profile.ts")).href;
    const script = `
      const api = await import(${JSON.stringify(moduleUrl)});
      api.migrateLegacyEnvironmentFiles({
        legacyStateFile: ${JSON.stringify(legacyStateFile)},
        registryFile: ${JSON.stringify(registryFile)},
        selectionFile: ${JSON.stringify(selectionFile)},
        environmentRoot: ${JSON.stringify(root)},
        now: "2026-07-17T01:00:00.000Z"
      }, { afterSelectionCommit: () => process.exit(74) });
    `;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(crashed.status, 74, crashed.stderr);
    assert.equal(existsSync(registryFile), true);
    assert.equal(existsSync(selectionFile), true);
    assert.equal(existsSync(journalFile), true);

    assert.equal(recoverEnvironmentDocumentCommit(registryFile, selectionFile), true);
    const registry = readEnvironmentProfileRegistry(registryFile)!;
    const selection = readEnvironmentSelection(selectionFile)!;
    assert.deepEqual(registry.selected, selection);
    assert.equal(existsSync(journalFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production load rejects a selection document without its matching registry", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-partial-selection-"));
  const base = defaultEnvironmentProfileRegistry(root);
  const selection = createEnvironmentSelection({
    profile: base.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: "2026-07-17T01:00:00.000Z",
    appliedAt: "2026-07-17T01:00:00.000Z",
  });
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "chatgpt" }));
    writeFileSync(join(root, "environment-selection.json"), `${JSON.stringify(selection)}\n`);
    assert.throws(() => loadEnvironmentState({
      legacyStateFile: join(root, "state.json"),
      registryFile: join(root, "environment-registry.json"),
      selectionFile: join(root, "environment-selection.json"),
      environmentRoot: root,
    }), /selection exists without its profile registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production load migrates legacy state in memory and constructs a requested selection without publishing it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-load-"));
  const legacyStateFile = join(root, "state.json");
  const registryFile = join(root, "environment-registry.json");
  const selectionFile = join(root, "environment-selection.json");
  try {
    writeFileSync(legacyStateFile, '{"mode":"tweakers"}\n');
    const loaded = loadEnvironmentState({
      legacyStateFile,
      registryFile,
      selectionFile,
      environmentRoot: root,
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
      now: "2026-07-17T01:00:00.000Z",
    }, {
      inspectProfile: (profile) => ({
        officialVersion: profile.releaseProfile === "stable" ? "26.707.1" : "26.717.1",
        officialBuild: profile.releaseProfile === "stable" ? "5900" : "6001",
        strictSignature: true,
        gatekeeper: true,
        teamIdentifier: "2DC432GLL2",
        designatedRequirement:
          `designated => identifier "${profile.officialBundleId}" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`,
        signatureCheckedAt: "2026-07-17T01:00:00.000Z",
        officialBackendVersion: profile.releaseProfile === "stable" ? "0.145.0" : "0.145.0-alpha.19",
        officialBackendFingerprint: `${profile.releaseProfile}-official-backend`,
        backendVersion: "0.145.0",
        backendFingerprint: `${profile.releaseProfile}-backend`,
        patchedPayloadFingerprint: `${profile.releaseProfile}-patched`,
      }),
    });

    assert.equal(loaded.migratedFromLegacy, true);
    assert.equal(loaded.current.releaseProfile, "stable");
    assert.equal(loaded.current.appExperience, "tweakers");
    assert.equal(existsSync(registryFile), false);
    assert.equal(existsSync(selectionFile), false);

    const requested = createRequestedEnvironmentSelection(
      loaded.registry,
      { appExperience: "chatgpt", releaseProfile: "alpha" },
      "2026-07-17T02:00:00.000Z",
    );
    assert.equal(requested.selectedDesktopPath, "/Applications/ChatGPT (Beta).app");
    assert.equal(requested.backendLane, "official-bundled");
    assert.equal(requested.appliedAt, null);
    assert.equal(existsSync(selectionFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production load keeps the managed backend target isolated while carrying preparation capabilities", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-capabilities-"));
  const legacyStateFile = join(root, "state.json");
  const isolatedBackend = join(root, "environments", "alpha", "backend", "codex");
  try {
    writeFileSync(legacyStateFile, JSON.stringify({ mode: "chatgpt" }));
    const loaded = loadEnvironmentState({
      legacyStateFile,
      registryFile: join(root, "environment-registry.json"),
      selectionFile: join(root, "environment-selection.json"),
      environmentRoot: root,
      stableDesktopPath: "/Applications/ChatGPT.app",
      alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
      now: "2026-07-17T01:00:00.000Z",
      alphaEvidence: {
        backendInstallable: true,
        patchedPayloadBuildable: true,
      },
    }, {
      inspectProfile: (profile) => {
        if (profile.releaseProfile === "alpha") {
          assert.equal(profile.backendPath, isolatedBackend);
          assert.equal(profile.backendInstallable, true);
          assert.equal(profile.patchedPayloadBuildable, true);
        }
        return {
          officialVersion: profile.releaseProfile === "stable" ? "26.707.1" : "26.717.1",
          officialBuild: profile.releaseProfile === "stable" ? "5900" : "6001",
          strictSignature: true,
          gatekeeper: true,
          teamIdentifier: "2DC432GLL2",
          designatedRequirement:
            `designated => identifier "${profile.officialBundleId}" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"`,
          signatureCheckedAt: "2026-07-17T01:00:00.000Z",
          officialBackendVersion: profile.releaseProfile === "stable" ? "0.145.0" : "0.145.0-alpha.19",
          officialBackendFingerprint: `${profile.releaseProfile}-official-backend`,
        };
      },
    });

    assert.equal(loaded.registry.profiles.alpha.availability.chatgpt.available, true);
    assert.equal(loaded.registry.profiles.alpha.availability.tweakers.available, true);
    const requested = createRequestedEnvironmentSelection(
      loaded.registry,
      { appExperience: "tweakers", releaseProfile: "alpha" },
      "2026-07-17T02:00:00.000Z",
    );
    assert.equal(requested.backendLane, "managed-alpha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status inspection never executes an untrusted isolated managed-Alpha binary", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-environment-untrusted-alpha-"));
  const stateFile = join(root, "state.json");
  const markerFile = join(root, "executed.txt");
  const backend = join(root, "environments", "alpha", "backend", "codex");
  try {
    mkdirSync(join(backend, ".."), { recursive: true });
    writeFileSync(backend, `#!/bin/sh\nprintf executed > ${JSON.stringify(markerFile)}\nprintf 'codex-cli 0.145.0-alpha.19\\n'\n`);
    chmodSync(backend, 0o755);
    writeFileSync(stateFile, JSON.stringify({ mode: "chatgpt" }));

    const loaded = loadEnvironmentState({
      legacyStateFile: stateFile,
      registryFile: join(root, "environment-registry.json"),
      selectionFile: join(root, "environment-selection.json"),
      environmentRoot: root,
      stableDesktopPath: join(root, "Applications", "ChatGPT.app"),
      alphaDesktopPath: join(root, "Applications", "ChatGPT (Beta).app"),
      alphaEvidence: { backendInstallable: true },
    });

    assert.equal(loaded.registry.profiles.alpha.backendVersion, null);
    assert.equal(loaded.registry.profiles.alpha.backendFingerprint, null);
    assert.equal(existsSync(markerFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
