import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeLocalSigningIdentity, type SecurityCommandRunner } from "../src/codesign";
import { chooseRestorePlan, cleanupRuntimeAndState, purgeUserData } from "../src/commands/uninstall";

test("local signing identity removal clears trust before deleting the identity", () => {
  const calls: Array<[string, string[]]> = [];
  const run: SecurityCommandRunner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "find-certificate") {
      return {
        status: 0,
        stdout: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n",
        stderr: "",
      };
    }
    return { status: 0, stdout: "", stderr: "" };
  };

  removeLocalSigningIdentity({
    identityName: "Tweakers Local Signing",
    run,
    writeTempCert: () => "/tmp/fake-cert.pem",
  });

  assert.ok(
    calls.some(
      ([, args]) =>
        args[0] === "find-certificate" &&
        args[1] === "-c" &&
        args[2] === "Tweakers Local Signing",
    ),
  );
  const removeTrustCall = calls.find(([, args]) => args[0] === "remove-trusted-cert");
  assert.deepEqual(removeTrustCall?.[1], ["remove-trusted-cert", "/tmp/fake-cert.pem"]);
  assert.equal(removeTrustCall?.[1].includes("-d"), false);
  assert.deepEqual(
    calls.find(([, args]) => args[0] === "delete-identity")?.[1],
    ["delete-identity", "-c", "Tweakers Local Signing"],
  );
  assert.ok(
    calls.findIndex(([, args]) => args[0] === "remove-trusted-cert") <
      calls.findIndex(([, args]) => args[0] === "delete-identity"),
  );
  assert.ok(calls.every(([command]) => command === "security"));
});

test("local signing identity removal is idempotent when the identity is absent", () => {
  const calls: Array<[string, string[]]> = [];
  const run: SecurityCommandRunner = (command, args) => {
    calls.push([command, args]);
    if (args[0] === "find-certificate") {
      return { status: 1, stdout: "", stderr: "SecKeychainSearchCopyNext..." };
    }
    return { status: 1, stdout: "", stderr: "identity not found" };
  };

  assert.doesNotThrow(() =>
    removeLocalSigningIdentity({ run, writeTempCert: () => "/tmp/fake-cert.pem" }),
  );
  assert.equal(calls.some(([, args]) => args[0] === "remove-trusted-cert"), false);
  assert.deepEqual(
    calls.find(([, args]) => args[0] === "delete-identity")?.[1],
    ["delete-identity", "-c", "Tweakers Local Signing"],
  );
});

test("local signing identity removal never throws when the command runner throws", () => {
  const run: SecurityCommandRunner = () => {
    throw new Error("security unavailable");
  };

  assert.doesNotThrow(() =>
    removeLocalSigningIdentity({ run, writeTempCert: () => "/tmp/x.pem" }),
  );
});

test(
  "uninstall explains runtime cleanup permission failures",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "codexpp-uninstall-"));
    const runtime = join(root, "runtime");
    const stateFile = join(root, "state.json");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "loader.js"), "");
    writeFileSync(stateFile, "{}");
    chmodSync(runtime, 0o555);

    try {
      assert.throws(
        () => cleanupRuntimeAndState({ runtime, stateFile }),
        /previous sudo install or repair/,
      );
    } finally {
      chmodSync(runtime, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("uninstall skips app restore when the current app no longer looks patched", () => {
  const plan = chooseRestorePlan({
    state: {
      version: "0.1.7",
      installedAt: "2026-05-01T00:00:00.000Z",
      appRoot: "/Applications/Codex.app",
      originalAsarHash: "original",
      patchedAsarHash: "patched",
      codexVersion: "26.519.1",
      fuseFlipped: true,
      resigned: true,
      originalEntryPoint: "main.js",
      watcher: "launchd",
    },
    currentAsarHash: "new-official-build",
    currentCodexVersion: "26.520.1",
    hasPatchMarker: false,
    fullAppBackup: "/does/not/matter/Codex.app",
    partialAsarBackup: "/does/not/matter/app.asar",
  });

  assert.equal(plan.kind, "skip");
  assert.match(plan.reason, /does not appear/);
});

test("purge removes all Tweakers user data", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-uninstall-"));
  mkdirSync(join(root, "tweaks", "example"), { recursive: true });
  mkdirSync(join(root, "backup"), { recursive: true });
  writeFileSync(join(root, "config.json"), "{}");
  writeFileSync(join(root, "tweaks", "example", "manifest.json"), "{}");
  writeFileSync(join(root, "backup", "app.asar"), "");

  purgeUserData({ root });

  assert.equal(existsSync(root), false);
});

test("uninstall prefers a full app backup for a patched macOS app", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-uninstall-"));
  try {
    const backup = join(root, "Codex.app");
    mkdirSync(join(backup, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(backup, "Contents", "Info.plist"), "");
    writeFileSync(join(backup, "Contents", "Resources", "app.asar"), "");

    const plan = chooseRestorePlan({
      state: {
        version: "0.1.7",
        installedAt: "2026-05-01T00:00:00.000Z",
        appRoot: "/Applications/Codex.app",
        originalAsarHash: "original",
        patchedAsarHash: "patched",
        codexVersion: "26.519.1",
        fuseFlipped: true,
        resigned: true,
        originalEntryPoint: "main.js",
        watcher: "launchd",
      },
      currentAsarHash: "patched",
      currentCodexVersion: "26.519.1",
      hasPatchMarker: true,
      fullAppBackup: backup,
      partialAsarBackup: join(root, "app.asar"),
    });

    assert.deepEqual(plan, { kind: "full-app", backupPath: backup });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall refuses partial restore after a Codex version change", () => {
  const root = mkdtempSync(join(tmpdir(), "codexpp-uninstall-"));
  try {
    const partial = join(root, "app.asar");
    writeFileSync(partial, "");

    assert.throws(
      () =>
        chooseRestorePlan({
          state: {
            version: "0.1.7",
            installedAt: "2026-05-01T00:00:00.000Z",
            appRoot: "/Applications/Codex.app",
            originalAsarHash: "original",
            patchedAsarHash: "patched",
            codexVersion: "26.519.1",
            fuseFlipped: true,
            resigned: true,
            originalEntryPoint: "main.js",
            watcher: "launchd",
          },
          currentAsarHash: "patched",
          currentCodexVersion: "26.520.1",
          hasPatchMarker: true,
          fullAppBackup: null,
          partialAsarBackup: partial,
        }),
      /Codex changed since Tweakers was installed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
