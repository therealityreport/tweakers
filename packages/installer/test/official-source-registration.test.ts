import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
  createEnvironmentProfileRegistry,
  createEnvironmentSelection,
  publishEnvironmentSnapshot,
  type EnvironmentProfileEvidenceInput,
} from "../src/environment-profile.js";
import {
  OFFICIAL_SOURCE_APP_NAME,
  officialSourcePaths,
  readRegisteredOfficialSourceStatusProjection,
  registerStableOfficialSource,
  sealOfficialSourceTree,
  type OfficialSourceObservation,
  type RegisteredOfficialSourceStatus,
} from "../src/official-source-registration.js";

const NOW = "2026-09-03T22:00:00.000Z";
const OPERATION_ID = "018f0d36-4c08-7a3e-9c1d-123456789abd";
const GENERATION_ID = "018f0d36-4c08-7a3e-9c1d-123456789abe";
const MANAGER = {
  state: "resolved" as const,
  path: "/private/Tweakers Manager Launcher",
  sha256: "a".repeat(64),
};

test("official-source tree seal accepts relative symlinks whose resolved targets stay inside the app root", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-seal-"));
  try {
    mkdirSync(join(root, "lib"));
    mkdirSync(join(root, "node-gyp-build"));
    writeFileSync(join(root, "node-gyp-build", "bin.js"), "module.exports = true;\n", "utf8");
    symlinkSync("../node-gyp-build/bin.js", join(root, "lib", "native.js"));

    assert.doesNotThrow(() => sealOfficialSourceTree(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source tree seal rejects absolute and lexical escaping symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-seal-"));
  try {
    symlinkSync("/tmp/tweakers-official-source-missing-target", join(root, "absolute.js"));
    assert.throws(() => sealOfficialSourceTree(root), /absolute symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const lexicalRoot = mkdtempSync(join(tmpdir(), "tweakers-official-source-seal-"));
  const lexicalOutside = mkdtempSync(join(tmpdir(), "tweakers-official-source-outside-"));
  try {
    writeFileSync(join(lexicalRoot, "inside.txt"), "inside\n", "utf8");
    const outsideLink = join(lexicalOutside, "back-inside");
    symlinkSync(join(lexicalRoot, "inside.txt"), outsideLink);
    mkdirSync(join(lexicalRoot, "links"));
    const escapingLink = join(lexicalRoot, "links", "lexical-escape.js");
    symlinkSync(relative(dirname(escapingLink), outsideLink), escapingLink);

    assert.throws(() => sealOfficialSourceTree(lexicalRoot), /escaping symlink/);
  } finally {
    rmSync(lexicalRoot, { recursive: true, force: true });
    rmSync(lexicalOutside, { recursive: true, force: true });
  }
});

test("official-source tree seal rejects symlink chains that resolve outside the app root", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-seal-"));
  const outside = mkdtempSync(join(tmpdir(), "tweakers-official-source-outside-"));
  try {
    writeFileSync(join(outside, "payload"), "outside\n", "utf8");
    symlinkSync(outside, join(root, "z-external"));
    symlinkSync("z-external/payload", join(root, "a-chain.js"));

    assert.throws(() => sealOfficialSourceTree(root), /symlink-chain escape/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("official-source registration atomically publishes one immutable generation, unchanged selection, and current pointer", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-"));
  try {
    const before = seedCanonicalEnvironment(root);
    const observation = fixtureObservation();
    const expectedSourceDigest = observationDigest(observation);
    const result = registerStableOfficialSource({
      root,
      operationId: OPERATION_ID,
      expectedSourceDigest,
      managerExecutable: MANAGER,
    }, fixtureDeps(observation));

    const paths = officialSourcePaths(root);
    const pointer = JSON.parse(readFileSync(paths.currentFile, "utf8")) as Record<string, unknown>;
    const receiptPath = join(paths.generationsRoot, GENERATION_ID, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
    const transaction = JSON.parse(readFileSync(paths.transactionFile, "utf8")) as Record<string, unknown>;

    assert.equal(result.generationId, GENERATION_ID);
    assert.equal(result.sourceDigest, expectedSourceDigest);
    assert.equal(pointer.generationId, GENERATION_ID);
    assert.equal(pointer.sourceDigest, expectedSourceDigest);
    assert.equal(pointer.appPath, join(paths.generationsRoot, GENERATION_ID, OFFICIAL_SOURCE_APP_NAME));
    assert.equal((receipt.manager as Record<string, unknown>).executableSha256, MANAGER.sha256);
    assert.equal(transaction.phase, "completed");
    assert.deepEqual(readFileSync(paths.environmentSelectionFile), before.selectionBytes, "registration must not alter the active environment selection");
    assert.notDeepEqual(readFileSync(paths.environmentRegistryFile), before.registryBytes, "fresh source evidence must be published with the unchanged selection");
    assert.equal(existsSync(join(paths.generationsRoot, GENERATION_ID, OFFICIAL_SOURCE_APP_NAME)), true);

    const metadataReads: string[] = [];
    const status = readRegisteredOfficialSourceStatusProjection(root, {
      observeMetadata(path) {
        metadataReads.push(path);
        const stat = path === "/Applications/ChatGPT.app"
          ? observation.rootIdentity
          : (() => {
              const value = lstatSync(path);
              return { dev: value.dev, ino: value.ino, ctimeMs: value.ctimeMs };
            })();
        return {
          appPath: path,
          physicalPath: path,
          rootIdentity: stat,
          bundleId: observation.bundleId,
          version: observation.version,
          build: observation.build,
          appAsarHeaderHash: observation.appAsarHeaderHash,
          marker: observation.marker,
        };
      },
    });
    assert.equal(status.state, "ready");
    assert.equal(status.sourceDigest, expectedSourceDigest);
    assert.equal(status.candidateDigest, expectedSourceDigest);
    assert.equal(
      status.revision,
      `sha256:${createHash("sha256").update(readFileSync(paths.currentFile)).digest("hex")}`,
      "the projected registered-source revision must use the manager sha256 revision contract",
    );
    assert.match(status.revision, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(metadataReads, [
      join(paths.generationsRoot, GENERATION_ID, OFFICIAL_SOURCE_APP_NAME),
      "/Applications/ChatGPT.app",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source registration rolls back the coupled environment publication when pointer publication cannot proceed", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-"));
  try {
    const before = seedCanonicalEnvironment(root);
    const observation = fixtureObservation();
    assert.throws(() => registerStableOfficialSource({
      root,
      operationId: OPERATION_ID,
      expectedSourceDigest: observationDigest(observation),
      managerExecutable: MANAGER,
    }, fixtureDeps(observation, (point) => {
      if (point === "official-source:environment-published") throw new Error("simulated pointer-precondition failure");
    })), /simulated pointer-precondition failure/);

    const paths = officialSourcePaths(root);
    const transaction = JSON.parse(readFileSync(paths.transactionFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(readFileSync(paths.environmentRegistryFile), before.registryBytes);
    assert.deepEqual(readFileSync(paths.environmentSelectionFile), before.selectionBytes);
    assert.equal(existsSync(paths.currentFile), false, "an unselected immutable generation must never become current after rollback");
    assert.equal(existsSync(join(paths.generationsRoot, GENERATION_ID, "receipt.json")), true, "failed immutable evidence is retained for audit");
    assert.equal(transaction.phase, "failed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source registration rejects a prepared digest mismatch before cloning", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-"));
  try {
    seedCanonicalEnvironment(root);
    const observation = fixtureObservation();
    let cloneCalls = 0;
    assert.throws(() => registerStableOfficialSource({
      root,
      operationId: OPERATION_ID,
      expectedSourceDigest: "9".repeat(64),
      managerExecutable: MANAGER,
    }, {
      ...fixtureDeps(observation),
      cloneApp(): void {
        cloneCalls += 1;
      },
    }), /changed after manager preparation/);

    const paths = officialSourcePaths(root);
    assert.equal(cloneCalls, 0);
    assert.equal(existsSync(paths.currentFile), false);
    assert.deepEqual(existsSync(paths.generationsRoot) ? readFileNames(paths.generationsRoot) : [], []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("official-source registration rejects a source change during cloning before publication", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-official-source-"));
  try {
    seedCanonicalEnvironment(root);
    const before = fixtureObservation();
    const after = {
      ...before,
      treeSeal: { ...before.treeSeal, sha256: "8".repeat(64) },
    };
    let observations = 0;
    assert.throws(() => registerStableOfficialSource({
      root,
      operationId: OPERATION_ID,
      expectedSourceDigest: observationDigest(before),
      managerExecutable: MANAGER,
    }, {
      ...fixtureDeps(before),
      observe: () => observations++ === 0 ? before : after,
    }), /changed while it was being cloned/);

    const paths = officialSourcePaths(root);
    const transaction = JSON.parse(readFileSync(paths.transactionFile, "utf8")) as Record<string, unknown>;
    assert.equal(observations, 2);
    assert.equal(existsSync(paths.currentFile), false);
    assert.equal(transaction.phase, "failed");
    assert.equal(existsSync(join(paths.generationsRoot, GENERATION_ID)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureDeps(
  source: OfficialSourceObservation,
  fault?: (point: string) => void,
) {
  return {
    now: () => NOW,
    id: () => GENERATION_ID,
    observe: () => source,
    cloneApp(_from: string, destination: string): void {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeFileSync(join(destination, "sealed-payload"), "fixture official source\n", "utf8");
    },
    observeClone(path: string): OfficialSourceObservation {
      const stat = lstatSync(path);
      return {
        ...source,
        appPath: path,
        physicalPath: path,
        rootIdentity: { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs },
      };
    },
    readRegistered(root: string): RegisteredOfficialSourceStatus {
      const paths = officialSourcePaths(root);
      if (!existsSync(paths.currentFile)) return missingRegisteredSource();
      const pointer = JSON.parse(readFileSync(paths.currentFile, "utf8")) as Record<string, unknown>;
      const generationId = String(pointer.generationId);
      const receiptBytes = readFileSync(join(paths.generationsRoot, generationId, "receipt.json"));
      return {
        state: "ready",
        generationId,
        receiptDigest: createHash("sha256").update(receiptBytes).digest("hex"),
        artifactPath: String(pointer.appPath),
        version: String(pointer.version),
        build: String(pointer.build),
        candidateDigest: observationDigest(source),
        sourceDigest: String(pointer.sourceDigest),
        revision: `sha256:${"f".repeat(64)}`,
        problem: null,
      };
    },
    ...(fault === undefined ? {} : { fault }),
  };
}

function readFileNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function fixtureObservation(): OfficialSourceObservation {
  return {
    appPath: "/Applications/ChatGPT.app",
    physicalPath: "/Applications/ChatGPT.app",
    rootIdentity: { dev: 1, ino: 2, ctimeMs: 3 },
    bundleId: "com.openai.codex",
    version: "26.901.20858",
    build: "7658",
    appAsarHeaderHash: "b".repeat(64),
    marker: "absent",
    treeSeal: { sha256: "c".repeat(64), entries: 1, bytes: "0" },
    trust: {
      strictSignature: true,
      gatekeeper: true,
      teamIdentifier: "2DC432GLL2",
      designatedRequirement: 'identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"',
      authorities: ["Developer ID Application: OpenAI (2DC432GLL2)"],
    },
  };
}

function seedCanonicalEnvironment(root: string): { registryBytes: Buffer; selectionBytes: Buffer } {
  const base = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: root,
    stableEvidence: trustedEvidence("stable"),
    alphaEvidence: trustedEvidence("alpha"),
  });
  const selection = createEnvironmentSelection({
    profile: base.profiles.stable,
    appExperience: "chatgpt",
    requestedAt: NOW,
    appliedAt: NOW,
  });
  const registry = createEnvironmentProfileRegistry({
    stableDesktopPath: "/Applications/ChatGPT.app",
    alphaDesktopPath: "/Applications/ChatGPT (Beta).app",
    environmentRoot: root,
    selected: selection,
    lastKnownWorkingSelection: selection,
    stableEvidence: trustedEvidence("stable"),
    alphaEvidence: trustedEvidence("alpha"),
  });
  const paths = officialSourcePaths(root);
  publishEnvironmentSnapshot(paths.environmentRegistryFile, paths.environmentSelectionFile, registry, selection);
  return {
    registryBytes: readFileSync(paths.environmentRegistryFile),
    selectionBytes: readFileSync(paths.environmentSelectionFile),
  };
}

function trustedEvidence(release: "stable" | "alpha"): EnvironmentProfileEvidenceInput {
  return {
    officialVersion: release === "stable" ? "26.901.20858" : "26.902.1",
    officialBuild: release === "stable" ? "7658" : "7659",
    strictSignature: true,
    gatekeeper: true,
    teamIdentifier: "2DC432GLL2",
    designatedRequirement: `identifier "${release === "stable" ? "com.openai.codex" : "com.openai.codex.beta"}" and certificate leaf[subject.OU] = "2DC432GLL2"`,
    signatureCheckedAt: NOW,
    officialBackendVersion: release === "stable" ? "0.145.0" : "0.145.0-alpha.1",
    officialBackendFingerprint: `${release}-official`,
    backendVersion: release === "stable" ? "0.145.0" : "0.145.0-alpha.1",
    backendFingerprint: `${release}-backend`,
    pristineBackupFingerprint: `${release}-pristine`,
    patchedPayloadFingerprint: `${release}-payload`,
    backendInstallable: release === "alpha",
    patchedPayloadBuildable: true,
  };
}

function missingRegisteredSource(): RegisteredOfficialSourceStatus {
  return {
    state: "missing",
    generationId: null,
    receiptDigest: null,
    artifactPath: null,
    version: null,
    build: null,
    candidateDigest: null,
    sourceDigest: null,
    revision: "missing",
    problem: null,
  };
}

function observationDigest(value: OfficialSourceObservation): string {
  // The production digest sorts nested keys too. Use an equivalent small
  // canonicalizer here so the manager binding remains exact in the fixture.
  return createHash("sha256").update(canonicalJson({
    bundleId: value.bundleId,
    version: value.version,
    build: value.build,
    appAsarHeaderHash: value.appAsarHeaderHash,
    marker: value.marker,
    treeSeal: value.treeSeal,
    trust: value.trust,
  })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
