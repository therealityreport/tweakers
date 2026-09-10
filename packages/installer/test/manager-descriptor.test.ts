import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MANAGER_DESCRIPTOR_SCHEMA_VERSION,
  TWEAKERS_MANAGER_BUNDLE_NAME,
  TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT,
  TWEAKERS_MANAGER_LAUNCHER_NAME,
  TWEAKERS_MANAGER_SEAL_NAME,
  parseTweakersManagerDescriptor,
  parseTweakersManagerTargetSeal,
  publishTweakersManagerDescriptor,
  removeTweakersManagerDescriptor,
  validateTweakersManagerGeneration,
  type ManagerDescriptorDependencies,
} from "../src/manager-descriptor";
import { TWEAKERS_MANAGER_ID } from "../src/manager-contract";
import {
  REQUIRED_SEALED_MANAGER_SUPPORT_FILES,
  SEALED_MANAGER_SUPPORT_DIRECTORY,
} from "../src/manager-runtime-assets";
import { fingerprintManagerManagedRuntimeSource } from "../src/managed-runtime";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint";

const isDarwinUser = process.platform === "darwin" && typeof process.getuid === "function" && typeof process.getgid === "function";
const FIXED_NOW = "2026-08-27T23:00:00.000Z";

test("publishes a sealed immutable status manager generation before its descriptor", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    const first = publish(fixture);
    assert.equal(first.reusedGeneration, false);
    assert.equal(existsSync(fixture.descriptorFile), true);
    assert.equal(first.descriptor.schemaVersion, MANAGER_DESCRIPTOR_SCHEMA_VERSION);
    assert.equal(first.descriptor.managerId, TWEAKERS_MANAGER_ID);
    assert.equal(first.descriptor.executable, first.launcher);
    assert.equal(Object.hasOwn(first.descriptor, "args"), false);
    assert.equal(Object.hasOwn(first.descriptor, "environment"), false);
    assert.equal(Object.hasOwn(first.descriptor, "trust"), false);

    const seal = parseTweakersManagerTargetSeal(readFileSync(first.seal, "utf8"));
    assert.equal(seal.generationId, first.generationId);
    assert.equal(seal.nodePath, realpathSync(fixture.nodePath));
    assert.equal(lstatSync(first.generationRoot).mode & 0o7777, 0o700);
    assert.equal(lstatSync(first.launcher).mode & 0o7777, 0o500);
    assert.equal(lstatSync(first.bundle).mode & 0o7777, 0o400);
    assert.equal(lstatSync(first.runtime).mode & 0o7777, 0o700);
    assert.equal(lstatSync(first.managedRuntime).mode & 0o7777, 0o700);
    assert.equal(seal.managedRuntimeFingerprint, first.managedRuntime.split("/").at(-1));
    assert.equal(lstatSync(first.seal).mode & 0o7777, 0o400);
    assert.equal(lstatSync(fixture.descriptorFile).mode & 0o7777, 0o600);
    const second = publish(fixture);
    assert.equal(second.reusedGeneration, true, "content-addressed generation must never be rewritten");
    assert.equal(second.generationRoot, first.generationRoot);
  } finally {
    fixture.cleanup();
  }
});

test("generation validation rejects changed modes, symlinks, and unsafe ancestors", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    const published = publish(fixture);
    chmodSync(published.bundle, 0o600);
    assert.throws(() => publish(fixture), /mode 400/);
    chmodSync(published.bundle, 0o400);

    const savedBundle = `${published.bundle}.saved`;
    renameSync(published.bundle, savedBundle);
    symlinkSync(savedBundle, published.bundle);
    assert.throws(() => publish(fixture), /unexpected or missing files|non-symlink single-link regular file|real non-symlink/);
  } finally {
    fixture.cleanup();
  }
});

test("publisher fails closed on signing evidence and descriptor publication failure", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    assert.throws(
      () => publish(fixture, { verifyLauncherSignature: () => ({ authority: "wrong", designatedRequirement: "x" }) }),
      /unexpected identity/,
    );
    assert.equal(existsSync(fixture.descriptorFile), false);

    assert.throws(
      () => publish(fixture, { verifyLauncherSignature: () => ({ authority: "Tweakers Local Signing", designatedRequirement: 'identifier "other.launcher"' }) }),
      /unexpected identity/,
    );
    assert.equal(existsSync(fixture.descriptorFile), false);

    for (const requirement of [
      `prefix ${fixture.signing.designatedRequirement}`,
      `${fixture.signing.designatedRequirement} or identifier "attacker.launcher"`,
      `(${fixture.signing.designatedRequirement}) or anchor apple generic`,
      `${fixture.signing.designatedRequirement} and anchor apple`,
    ]) {
      assert.throws(
        () => publish(fixture, { verifyLauncherSignature: () => ({ authority: "Tweakers Local Signing", designatedRequirement: requirement }) }),
        /unexpected identity/,
      );
      assert.equal(existsSync(fixture.descriptorFile), false);
    }

    assert.throws(
      () => publish(fixture, { beforeDescriptorPublish: () => { throw new Error("injected before descriptor failure"); } }),
      /injected before descriptor failure/,
    );
    assert.equal(existsSync(fixture.descriptorFile), false, "descriptor must remain unpublished after a generation-stage failure");
    assert.equal(existsSync(join(fixture.userRoot, "managers", TWEAKERS_MANAGER_ID, "generations")), true);
  } finally {
    fixture.cleanup();
  }
});

test("publisher restores the prior descriptor after an injected post-publication failure", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    publish(fixture);
    const priorDescriptor = readFileSync(fixture.descriptorFile, "utf8");
    assert.throws(
      () => publish(fixture, {
        now: () => "2026-08-28T00:00:00.000Z",
        afterDescriptorPublish: () => { throw new Error("injected post-publication failure"); },
      }),
      /injected post-publication failure/,
    );
    assert.equal(readFileSync(fixture.descriptorFile, "utf8"), priorDescriptor);
  } finally {
    fixture.cleanup();
  }
});

test("descriptor parser rejects duplicate keys and action-bearing schema expansion", () => {
  assert.throws(
    () => parseTweakersManagerDescriptor(`{"schemaVersion":1,"schemaVersion":1}`),
    /repeats key/,
  );
  assert.throws(
    () => parseTweakersManagerDescriptor(JSON.stringify({
      schemaVersion: 1,
      managerId: TWEAKERS_MANAGER_ID,
      displayName: "Tweakers",
      protocolVersion: 1,
      executable: "/fixed/launcher",
      publisher: TWEAKERS_MANAGER_ID,
      updatedAt: FIXED_NOW,
      arguments: ["status"],
    })),
    /unknown, missing, or duplicate schema keys/,
  );
});

test("descriptor removal disables discovery but preserves Menu Bar trust", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    publish(fixture);
    const trust = join(dirname(fixture.descriptorRoot), "manager-trust.json");
    writeFileSync(trust, '{"hostOwned":true}\n', "utf8");
    chmodSync(trust, 0o600);

    const removed = removeTweakersManagerDescriptor({
      userRoot: fixture.userRoot,
      descriptorRoot: fixture.descriptorRoot,
    });
    assert.equal(removed.removed, true);
    assert.equal(existsSync(fixture.descriptorFile), false);
    assert.equal(readFileSync(trust, "utf8"), '{"hostOwned":true}\n');
    assert.equal(removeTweakersManagerDescriptor({ userRoot: fixture.userRoot, descriptorRoot: fixture.descriptorRoot }).removed, false);
  } finally {
    fixture.cleanup();
  }
});

test("descriptor removal unlinks even a dangling hostile descriptor symlink without following it", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    publish(fixture);
    removeTweakersManagerDescriptor({ userRoot: fixture.userRoot, descriptorRoot: fixture.descriptorRoot });
    symlinkSync(join(fixture.root, "does-not-exist"), fixture.descriptorFile);
    const removed = removeTweakersManagerDescriptor({ userRoot: fixture.userRoot, descriptorRoot: fixture.descriptorRoot });
    assert.equal(removed.removed, true);
    assert.throws(() => lstatSync(fixture.descriptorFile), /ENOENT/);
  } finally {
    fixture.cleanup();
  }
});

test("descriptor removal refuses a symlinked descriptor directory instead of unlinking through it", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    publish(fixture);
    const redirectedRoot = join(fixture.root, "redirected-manager-descriptors");
    symlinkSync(fixture.descriptorRoot, redirectedRoot);
    assert.throws(
      () => removeTweakersManagerDescriptor({ userRoot: fixture.userRoot, descriptorRoot: redirectedRoot }),
      /real non-symlink directory|symlink/,
    );
    assert.equal(existsSync(fixture.descriptorFile), true, "unsafe removal must leave the real descriptor untouched");
  } finally {
    fixture.cleanup();
  }
});

test("generation verifier rejects an unexpected owner without modifying the immutable generation", { skip: !isDarwinUser }, () => {
  const fixture = makeFixture();
  try {
    const published = publish(fixture);
    const seal = parseTweakersManagerTargetSeal(readFileSync(published.seal, "utf8"));
    assert.throws(
      () => validateTweakersManagerGeneration({
        generationRoot: published.generationRoot,
        paths: published.paths,
        owner: { uid: fixture.owner.uid + 1, gid: fixture.owner.gid },
        seal,
        signing: fixture.signing,
        node: { path: fixture.nodePath, sha256: seal.nodeSha256 },
      }),
      /unexpected owner|owner/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("promotion publishes only after live state finalization and uninstall removes discovery before cleanup", () => {
  const installSource = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");
  const finalized = installSource.indexOf("finalizePromotedModeState(paths.stateFile, paths.root);");
  const published = installSource.indexOf("publishTweakersManagerDescriptor({ userRoot: paths.root })");
  assert.ok(finalized >= 0 && published > finalized, "the descriptor must observe committed promoted state");

  const uninstallSource = readFileSync(new URL("../src/commands/uninstall.ts", import.meta.url), "utf8");
  const removed = uninstallSource.indexOf("removeTweakersManagerDescriptor({ userRoot: paths.root })");
  const cleanup = uninstallSource.indexOf("cleanupRuntimeAndState(paths);");
  assert.ok(removed >= 0 && cleanup > removed, "discovery must be disabled before Tweakers state cleanup");
  assert.equal(uninstallSource.includes("manager-trust"), false, "uninstall must never access host trust storage");
});

interface Fixture {
  root: string;
  userRoot: string;
  descriptorRoot: string;
  descriptorFile: string;
  launcher: string;
  bundle: string;
  runtime: string;
  managedRuntime: string;
  nodePath: string;
  owner: { uid: number; gid: number };
  signing: { authority: string; designatedRequirement: string };
  cleanup(): void;
}

function makeFixture(): Fixture {
  // The runtime validates every ancestor. A test directory below the current
  // home avoids `/tmp`'s intentionally world-writable ancestor while staying
  // fully disposable and uniquely prefixed.
  const root = mkdtempSync(join(homedir(), ".tweakers-manager-descriptor-test-"));
  chmodSync(root, 0o700);
  const userRoot = join(root, "Tweakers");
  const menuBarRoot = join(root, "Menu Bar");
  const descriptorRoot = join(menuBarRoot, "manager-descriptors");
  const assets = join(root, "assets");
  mkdirSync(userRoot, { mode: 0o700 });
  mkdirSync(assets, { mode: 0o700 });
  const launcher = join(assets, TWEAKERS_MANAGER_LAUNCHER_NAME);
  const bundle = join(assets, TWEAKERS_MANAGER_BUNDLE_NAME);
  const runtime = join(assets, "runtime");
  const managedRuntime = join(assets, "managed-runtime");
  writeFileSync(launcher, "fixed signed launcher fixture\n", "utf8");
  mkdirSync(runtime, { mode: 0o700 });
  writeFileSync(join(runtime, "main.js"), "module.exports = true;\n", "utf8");
  const support = join(runtime, SEALED_MANAGER_SUPPORT_DIRECTORY);
  for (const relativePath of REQUIRED_SEALED_MANAGER_SUPPORT_FILES) {
    const file = join(support, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `fixture ${relativePath}\n`, "utf8");
    if (relativePath.includes("Launcher") || relativePath.endsWith("Tweakers Swap Helper")) {
      chmodSync(file, 0o500);
    }
  }
  const runtimeEvidence = computeRuntimeFingerprint(runtime);
  writeFileSync(join(runtime, "runtime-fingerprint.json"), `${JSON.stringify({
    schemaVersion: 1,
    fingerprint: runtimeEvidence.fingerprint,
    fileCount: runtimeEvidence.fileCount,
  }, null, 2)}\n`, "utf8");
  mkdirSync(managedRuntime, { mode: 0o700 });
  writeFileSync(join(managedRuntime, "package.json"), '{"private":true}\n', "utf8");
  chmodSync(join(managedRuntime, "package.json"), 0o400);
  const managedRuntimeFingerprint = fingerprintManagerManagedRuntimeSource(managedRuntime);
  writeFileSync(join(managedRuntime, "managed-runtime-fingerprint.json"), `${JSON.stringify({
    schemaVersion: 1,
    fingerprint: managedRuntimeFingerprint,
    fileCount: 1,
  }, null, 2)}\n`, "utf8");
  writeFileSync(
    bundle,
    `export const fixture = true;\n//# TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1=${runtimeEvidence.fingerprint}\n//# TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1=${managedRuntimeFingerprint}\n`,
    "utf8",
  );
  chmodSync(launcher, 0o500);
  chmodSync(bundle, 0o400);
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  const nodePath = realNodePath();
  const signing = {
    authority: "Tweakers Local Signing",
    designatedRequirement: TWEAKERS_MANAGER_LAUNCHER_DESIGNATED_REQUIREMENT,
  };
  return {
    root,
    userRoot,
    descriptorRoot,
    descriptorFile: join(descriptorRoot, `${TWEAKERS_MANAGER_ID}.json`),
    launcher,
    bundle,
    runtime,
    managedRuntime,
    nodePath,
    owner,
    signing,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function publish(fixture: Fixture, dependencies: Partial<ManagerDescriptorDependencies> = {}) {
  return publishTweakersManagerDescriptor({
    userRoot: fixture.userRoot,
    descriptorRoot: fixture.descriptorRoot,
    assets: {
      launcher: fixture.launcher,
      bundle: fixture.bundle,
      runtime: fixture.runtime,
      managedRuntime: fixture.managedRuntime,
    },
    dependencies: {
      owner: () => fixture.owner,
      nodePath: () => fixture.nodePath,
      now: () => FIXED_NOW,
      verifyLauncherSignature: () => fixture.signing,
      ...dependencies,
    },
  });
}

function realNodePath(): string {
  // Resolve via fs through a direct `realpath` round trip made by publication;
  // process.execPath is already absolute on supported Node installations.
  return process.execPath;
}
