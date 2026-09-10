import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertCodexNotRunning,
  assertOrdinaryInstallTargetNotDerived,
  copyCandidatePreimage,
  installMayRunWhileChatgptMode,
  prepareCodexForPatching,
  preflightWritableTargets,
  promoteVerifiedSignedBackup,
  resetCandidateUserRootForBuild,
  restoreSignedBackupSnapshot,
  snapshotSignedBackup,
  shouldBackupUnpatchedApp,
  shouldFlipElectronFuse,
} from "../src/commands/install";
import type { OpenReport } from "../src/commands/debug";
import type { CodexInstall } from "../src/platform";
import { writePlist } from "../src/plist";

test("ChatGPT mode admits only an explicit transition or receipt-bound prebuilt transaction", () => {
  assert.equal(installMayRunWhileChatgptMode({}), false);
  assert.equal(installMayRunWhileChatgptMode({ candidateOnly: true }), false);
  assert.equal(installMayRunWhileChatgptMode({ requirePreparedCandidate: true }), false);
  assert.equal(installMayRunWhileChatgptMode({ modeTransition: true }), true);
  assert.equal(installMayRunWhileChatgptMode({
    prebuiltCombinedCandidate: {} as never,
    candidateOnly: true,
  }), true);
  assert.equal(installMayRunWhileChatgptMode({
    prebuiltCombinedCandidate: {} as never,
    requirePreparedCandidate: true,
  }), true);
});

test("generic install paths reject the derived Tweakers app", () => {
  assert.doesNotThrow(() => assertOrdinaryInstallTargetNotDerived({
    appRoot: "/Applications/ChatGPT.app",
    appName: "ChatGPT",
    bundleId: "com.openai.codex",
    platform: "darwin",
  }));
  assert.throws(() => assertOrdinaryInstallTargetNotDerived({
    appRoot: "/Applications/Renamed Tweakers.app",
    appName: "Renamed Tweakers",
    bundleId: "com.therealityreport.tweakers",
    platform: "darwin",
  }), /generic install\/update path/);
  assert.throws(() => assertOrdinaryInstallTargetNotDerived({
    appRoot: "/Applications/Tweakers.app",
    appName: "ChatGPT",
    bundleId: "com.openai.codex",
    platform: "darwin",
  }), /refresh-variant/);
  assert.throws(() => assertOrdinaryInstallTargetNotDerived({
    appRoot: "/Applications/tWeAkErS.ApP",
    appName: "ChatGPT",
    bundleId: "com.openai.codex",
    platform: "darwin",
  }, { knownDerivedAppRoots: [] }), /refresh-variant/);
});

test("generic install guard rejects physical aliases and derived plist markers", () => {
  withTempDir((root) => {
    const renamedDerived = join(root, "Renamed Desktop.app");
    const alias = join(root, "ChatGPT.app");
    writeGuardApp(renamedDerived, { derivedMarker: false });
    symlinkSync(renamedDerived, alias);

    assert.throws(() => assertOrdinaryInstallTargetNotDerived({
      appRoot: alias,
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      platform: "darwin",
    }, {
      knownDerivedAppRoots: [renamedDerived],
      requireReadableMetadata: true,
    }), /exact physical path/);

    const markedDerived = join(root, "Desktop Copy.app");
    writeGuardApp(markedDerived, { derivedMarker: true });
    assert.throws(() => assertOrdinaryInstallTargetNotDerived({
      appRoot: markedDerived,
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      platform: "darwin",
    }, {
      knownDerivedAppRoots: [],
      requireReadableMetadata: true,
    }), /refresh-variant/);
  });
});

test("generic install guard rejects an ordinary app reached through a symlink alias", () => {
  withTempDir((root) => {
    const ordinary = join(root, "Ordinary.app");
    const alias = join(root, "ChatGPT.app");
    writeGuardApp(ordinary, { derivedMarker: false });
    symlinkSync(ordinary, alias);

    assert.throws(() => assertOrdinaryInstallTargetNotDerived({
      appRoot: alias,
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      platform: "darwin",
    }, {
      knownDerivedAppRoots: [],
      requireReadableMetadata: true,
    }), /exact physical path/);
  });
});

test("generic install guard binds mutation rechecks to the same physical app directory", () => {
  withTempDir((root) => {
    const appRoot = join(root, "ChatGPT.app");
    const movedRoot = join(root, "Original ChatGPT.app");
    writeGuardApp(appRoot, { derivedMarker: false });
    const expected = assertOrdinaryInstallTargetNotDerived({
      appRoot,
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      platform: "darwin",
    }, {
      knownDerivedAppRoots: [],
      requireReadableMetadata: true,
    });
    assert.ok(expected);

    renameSync(appRoot, movedRoot);
    writeGuardApp(appRoot, { derivedMarker: false });
    assert.throws(() => assertOrdinaryInstallTargetNotDerived({
      appRoot,
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      platform: "darwin",
    }, {
      expectedPhysicalTarget: expected,
      knownDerivedAppRoots: [],
      requireReadableMetadata: true,
    }), /physical target changed/);
  });
});

test("candidate preimage copies preserve private directory permissions", () => {
  withTempDir((root) => {
    const source = join(root, "source");
    const nested = join(source, "private");
    const destination = join(root, "candidate", "copied");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "secret"), "secret");
    chmodSync(join(nested, "secret"), 0o600);
    chmodSync(nested, 0o700);
    chmodSync(source, 0o700);

    copyCandidatePreimage(source, destination);

    assert.equal(lstatSync(destination).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(destination, "private")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(destination, "private", "secret")).mode & 0o777, 0o600);
  });
});

test("install preflight checks Info.plist before patching", { skip: process.platform === "win32" }, () => {
  withTempDir((root) => {
    const resourcesDir = join(root, "Contents", "Resources");
    const frameworkDir = join(
      root,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
    );
    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(frameworkDir, { recursive: true });

    const asarPath = join(resourcesDir, "app.asar");
    const metaPath = join(root, "Contents", "Info.plist");
    const electronBinary = join(frameworkDir, "Electron Framework");
    writeFileSync(asarPath, "");
    writeFileSync(metaPath, "");
    writeFileSync(electronBinary, "");
    chmodSync(metaPath, 0o444);

    try {
      let error: unknown;
      assert.throws(
        () => {
          try {
            preflightWritableTargets(
              {
                resourcesDir,
                asarPath,
                metaPath,
                electronBinary,
                platform: "darwin",
              },
              { fuseFlip: true },
            );
          } catch (e) {
            error = e;
            throw e;
          }
        },
        /Cannot write to .*Info\.plist/,
      );
      assert.match(String(error), /tweaker repair/);
    } finally {
      chmodSync(metaPath, 0o644);
    }
  });
});

test("install preflight checks Electron Framework when fuse flip is enabled", { skip: process.platform === "win32" }, () => {
  withTempDir((root) => {
    const resourcesDir = join(root, "Contents", "Resources");
    const frameworkDir = join(
      root,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
    );
    mkdirSync(resourcesDir, { recursive: true });
    mkdirSync(frameworkDir, { recursive: true });

    const asarPath = join(resourcesDir, "app.asar");
    const metaPath = join(root, "Contents", "Info.plist");
    const electronBinary = join(frameworkDir, "Electron Framework");
    writeFileSync(asarPath, "");
    writeFileSync(metaPath, "");
    writeFileSync(electronBinary, "");
    chmodSync(electronBinary, 0o444);

    try {
      assert.throws(
        () =>
          preflightWritableTargets(
            {
              resourcesDir,
              asarPath,
              metaPath,
              electronBinary,
              platform: "darwin",
            },
            { fuseFlip: true },
          ),
        /Cannot write to .*Electron Framework/,
      );
    } finally {
      chmodSync(electronBinary, 0o644);
    }
  });
});

test("install refreshes full app backup only for unpatched apps", () => {
  assert.equal(
    shouldBackupUnpatchedApp({
      hasPatchMarker: false,
      signature: {
        ok: true,
        adHoc: false,
        teamIdentifier: "TEAM",
        authority: ["Developer ID Application"],
        output: "",
      },
    }),
    true,
  );

  assert.equal(
    shouldBackupUnpatchedApp({
      hasPatchMarker: true,
      signature: {
        ok: true,
        adHoc: false,
        teamIdentifier: "TEAM",
        authority: ["Developer ID Application"],
        output: "",
      },
    }),
    false,
  );

  assert.equal(
    shouldBackupUnpatchedApp({
      hasPatchMarker: false,
      signature: {
        ok: false,
        adHoc: false,
        teamIdentifier: null,
        authority: [],
        output: "invalid signature",
      },
    }),
    false,
  );
});

test("each candidate build discards stale candidate-user backup state before seeding the current pristine app", () => {
  withTempDir((root) => {
    const candidateUserRoot = join(root, "transactions", "candidate-user");
    const staleBackup = join(candidateUserRoot, "backup", "Codex.app", "version");
    mkdirSync(join(staleBackup, ".."), { recursive: true });
    writeFileSync(staleBackup, "5440");

    resetCandidateUserRootForBuild(candidateUserRoot);

    assert.equal(existsSync(candidateUserRoot), false);
    const source = readFileSync(join(process.cwd(), "packages", "installer", "src", "commands", "install.ts"), "utf8");
    const resetIndex = source.indexOf("resetCandidateUserRootForBuild(candidateUserRoot)");
    const buildIndex = source.indexOf("await installCandidateInPlace({", resetIndex);
    assert.ok(resetIndex >= 0, "candidate build must reset its private user root");
    assert.ok(buildIndex > resetIndex, "candidate-user reset must happen before the candidate installer reads its backup");
  });
});

test("signed backup promotion verifies staging and atomically replaces the live backup", () => {
  withTempDir((root) => {
    const candidate = join(root, "candidate-user", "backup", "Codex.app");
    const live = join(root, "live-user", "backup", "Codex.app");
    mkdirSync(candidate, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(candidate, "version"), "new");
    writeFileSync(join(live, "version"), "old");

    promoteVerifiedSignedBackup(candidate, live, {
      verifyDeveloperId: () => true,
      copyDirectory: (source, destination) => cpSync(source, destination, { recursive: true }),
    });

    assert.equal(readFileSync(join(live, "version"), "utf8"), "new");
    assert.equal(existsSync(`${live}.tweakers-previous-${process.pid}`), false);
  });
});

test("invalid candidate signed backup leaves the live backup untouched", () => {
  withTempDir((root) => {
    const candidate = join(root, "candidate-user", "backup", "Codex.app");
    const live = join(root, "live-user", "backup", "Codex.app");
    mkdirSync(candidate, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(candidate, "version"), "invalid");
    writeFileSync(join(live, "version"), "old");

    assert.throws(
      () => promoteVerifiedSignedBackup(candidate, live, {
        verifyDeveloperId: (path) => path !== candidate,
        copyDirectory: (source, destination) => cpSync(source, destination, { recursive: true }),
      }),
      /Developer ID/,
    );
    assert.equal(readFileSync(join(live, "version"), "utf8"), "old");
  });
});

test("signed backup copy and staged-signature failures preserve the live backup", () => {
  for (const failure of ["copy", "staged-signature"] as const) {
    withTempDir((root) => {
      const candidate = join(root, "candidate-user", "backup", "Codex.app");
      const live = join(root, "live-user", "backup", "Codex.app");
      mkdirSync(candidate, { recursive: true });
      mkdirSync(live, { recursive: true });
      writeFileSync(join(candidate, "version"), "new");
      writeFileSync(join(live, "version"), "old");

      assert.throws(() => promoteVerifiedSignedBackup(candidate, live, {
        verifyDeveloperId: (path) => failure !== "staged-signature" || !path.includes("tweakers-incoming"),
        copyDirectory: (source, destination) => {
          if (failure === "copy") throw new Error("injected copy failure");
          cpSync(source, destination, { recursive: true });
        },
      }), /copy failure|Developer ID verification/);
      assert.equal(readFileSync(join(live, "version"), "utf8"), "old");
    });
  }
});

test("signed backup rename failure restores the previous verified backup", () => {
  withTempDir((root) => {
    const candidate = join(root, "candidate-user", "backup", "Codex.app");
    const live = join(root, "live-user", "backup", "Codex.app");
    mkdirSync(candidate, { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(join(candidate, "version"), "new");
    writeFileSync(join(live, "version"), "old");

    assert.throws(
      () => promoteVerifiedSignedBackup(candidate, live, {
        verifyDeveloperId: () => true,
        copyDirectory: (source, destination) => cpSync(source, destination, { recursive: true }),
        renameDirectory: (source, destination) => {
          if (source.includes("tweakers-incoming")) throw new Error("injected rename failure");
          renameSync(source, destination);
        },
      }),
      /injected rename failure/,
    );
    assert.equal(readFileSync(join(live, "version"), "utf8"), "old");
  });
});

test("signed backup transaction snapshot restores prior presence or absence", () => {
  withTempDir((root) => {
    const live = join(root, "live-user", "backup", "Codex.app");
    const snapshot = join(root, "transaction", "last-known-good-backup");
    const marker = join(root, "transaction", "last-known-good-backup.json");
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "version"), "old");

    snapshotSignedBackup(live, snapshot, marker);
    writeFileSync(join(live, "version"), "new");
    restoreSignedBackupSnapshot(live, snapshot, marker);
    assert.equal(readFileSync(join(live, "version"), "utf8"), "old");

    rmSync(live, { recursive: true, force: true });
    snapshotSignedBackup(live, snapshot, marker);
    mkdirSync(live, { recursive: true });
    writeFileSync(join(live, "version"), "unexpected");
    restoreSignedBackupSnapshot(live, snapshot, marker);
    assert.equal(existsSync(live), false);
  });
});

test("install skips Electron fuse flipping when the framework binary is missing", () => {
  withTempDir((root) => {
    const electronBinary = join(root, "Electron Framework");
    assert.equal(shouldFlipElectronFuse({ electronBinary }, true), false);
    writeFileSync(electronBinary, "");
    assert.equal(shouldFlipElectronFuse({ electronBinary }, true), true);
    assert.equal(shouldFlipElectronFuse({ electronBinary }, false), false);
  });
});

test("install preflight allows patching when Codex is closed", () => {
  assert.doesNotThrow(() => {
    assertCodexNotRunning(fakeCodex(), {
      status: "closed",
      pid: null,
      relatedPids: [],
      openedAt: null,
      openedAtRaw: null,
      detail: null,
    });
  });
});

test("install preflight ignores helper-only Codex processes", () => {
  const helperOnly = {
    status: "background",
    pid: 123,
    relatedPids: [123, 456],
    hasMainProcess: false,
    openedAt: "2026-05-23T09:17:22.000Z",
    openedAtRaw: null,
    detail: "Only helper/background processes were found.",
  } satisfies OpenReport;

  assert.doesNotThrow(() => {
    assertCodexNotRunning(fakeCodex(), helperOnly);
  });

  assert.equal(
    prepareCodexForPatching(fakeCodex(), {
      getOpenReport: () => helperOnly,
    }),
    false,
  );
});

test("install preflight blocks patching while Codex is running", () => {
  assert.throws(
    () => {
      assertCodexNotRunning(fakeCodex(), {
        status: "inactive",
        pid: 123,
        relatedPids: [123, 456],
        openedAt: "2026-05-31T11:35:54.000Z",
        openedAtRaw: null,
        detail: "Main Codex process is running but not frontmost.",
      } satisfies OpenReport);
    },
    /Close Codex before patching[\s\S]*Changing the bundle underneath an active process/,
  );
});

test("install preflight never quits or prompts a running macOS Codex", () => {
  let reads = 0;
  assert.throws(
    () => {
      prepareCodexForPatching(fakeCodex(), {
        getOpenReport: () => {
          reads += 1;
          return {
          status: "inactive",
          pid: 123,
          relatedPids: [123],
          openedAt: "2026-05-31T11:35:54.000Z",
          openedAtRaw: null,
          detail: "Main Codex process is running but not frontmost.",
          };
        },
      });
    },
    /Close Codex before patching/,
  );
  assert.equal(reads, 1);
});

function withTempDir(fn: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweaker-install-preflight-")));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeGuardApp(appRoot: string, options: { derivedMarker: boolean }): void {
  const contents = join(appRoot, "Contents");
  mkdirSync(contents, { recursive: true });
  writePlist(join(contents, "Info.plist"), {
    CFBundleIdentifier: "com.openai.codex",
    CFBundleDisplayName: "ChatGPT",
    CFBundleName: "ChatGPT",
    LSEnvironment: options.derivedMarker ? { TWEAKERS_DERIVED_VARIANT: "1" } : {},
  });
}

function fakeCodex(): CodexInstall {
  return {
    appRoot: "/Applications/Codex.app",
    resourcesDir: "/Applications/Codex.app/Contents/Resources",
    asarPath: "/Applications/Codex.app/Contents/Resources/app.asar",
    metaPath: "/Applications/Codex.app/Contents/Info.plist",
    electronBinary: "/Applications/Codex.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    executable: "/Applications/Codex.app/Contents/MacOS/Codex",
    appName: "Codex",
    bundleId: "com.openai.codex",
    channel: "stable",
    platform: "darwin",
  };
}
