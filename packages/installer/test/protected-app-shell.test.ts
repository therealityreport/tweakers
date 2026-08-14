import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  stageProtectedHealthLaunchGrant,
  writeProtectedAuthorityJsonAtomically,
} from "../src/commands/install";
import {
  createProtectedAppSignatureReceipt,
  isProtectedAppSignatureReceipt,
  verifyProtectedUiOffAbsence,
} from "../src/protected-app-shell";

const SHA = (character: string) => character.repeat(64);
const NOW = "2026-08-12T19:01:00.000Z";
const cjsRequire = createRequire(import.meta.url);

test("protected applied grant re-fingerprints one final app tree without candidate/final identity mixing", () => {
  const authorityRoot = mkdtempSync(join(tmpdir(), "tweaker-protected-final-grant-"));
  try {
    const finalAppRoot = join(authorityRoot, "final", "ChatGPT.app");
    const finalAsar = join(finalAppRoot, "Contents", "Resources", "app.asar");
    let captured: { file: string; value: any } | null = null;
    stageProtectedHealthLaunchGrant({
      candidate: { appRoot: finalAppRoot, asarPath: finalAsar } as never,
      authorityRoot,
      protectedShell: { transactionId: "protected-final-1", uiFeatures: "on" },
      acceptedBuildReceiptSha256: SHA("a"),
      now: new Date(NOW),
      dependencies: {
        requireBackend: () => undefined,
        readAsarEntry: (_asar, entry) => Buffer.from(entry === "protected-loader.cjs" ? "final-loader" : "final-metadata"),
        readAsarHeader: () => ({ headerHash: SHA("b") }),
        probeBackendVersion: () => "0.147.0-alpha.6.5",
        readSignature: () => ({ ok: true, output: "final-signature" }),
        fingerprintAppContents: (path) => {
          assert.equal(path, finalAppRoot);
          return SHA("c");
        },
        fingerprintFile: (path) => {
          assert.ok(path === finalAsar || path === join(finalAppRoot, "Contents", "Resources", "codex") || path === join(authorityRoot, "runtime", "main.js"));
          return path === finalAsar ? SHA("d") : path.endsWith("/runtime/main.js") ? SHA("f") : SHA("e");
        },
        writeAuthority: (file, value) => { captured = { file, value }; },
      },
    });
    assert.ok(captured);
    assert.equal(captured!.file, join(authorityRoot, "transactions", "protected", "protected-final-1", "launch-grant.json"));
    assert.deepEqual(captured!.value.identity, {
      appPath: finalAppRoot,
      appContentsSha256: SHA("c"),
      appAsarSha256: SHA("d"),
      asarHeaderSha256: SHA("b"),
      loaderPath: `${finalAsar}/protected-loader.cjs`,
      loaderSha256: createHash("sha256").update("final-loader").digest("hex"),
      metadataSha256: createHash("sha256").update("final-metadata").digest("hex"),
      runtimeMainPath: join(authorityRoot, "runtime", "main.js"),
      runtimeMainSha256: SHA("f"),
      backendPath: join(finalAppRoot, "Contents", "Resources", "codex"),
      backendSha256: SHA("e"),
      backendVersion: "0.147.0-alpha.6.5",
      backendArchitecture: "arm64",
      signatureReceiptSha256: createHash("sha256").update("final-signature").digest("hex"),
      policyDigest: createHash("sha256").update(JSON.stringify({ schemaVersion: 2, provider: "managed-turn-idle", uiFeatures: "on" })).digest("hex"),
    });
  } finally {
    rmSync(authorityRoot, { recursive: true, force: true });
  }
});

test("protected authority grant writes sync the file and parent directory after rename", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-authority-write-"));
  try {
    const file = join(root, "transactions", "protected", "grant.json");
    const calls: string[] = [];
    writeProtectedAuthorityJsonAtomically(file, { bound: "final-applied-bytes" }, {
      open: (path, flags, mode) => {
        calls.push(`open:${path === dirname(file) ? "directory" : "file"}:${flags}`);
        return openSync(path, flags, mode);
      },
      fsync: (descriptor) => {
        calls.push("fsync");
        fsyncSync(descriptor);
      },
      rename: (source, destination) => {
        calls.push("rename");
        renameSync(source, destination);
      },
    });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { bound: "final-applied-bytes" });
    assert.deepEqual(calls.map((call) => call.split(":")[0]), ["open", "fsync", "rename", "open", "fsync"]);
    assert.match(calls[3]!, /directory:r$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("protected authority write reports parent-directory sync failure and removes its temporary file", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-authority-failure-"));
  try {
    const file = join(root, "transactions", "protected", "grant.json");
    let opens = 0;
    assert.throws(() => writeProtectedAuthorityJsonAtomically(file, { bound: "final-applied-bytes" }, {
      open: (path, flags, mode) => {
        opens += 1;
        return openSync(path, flags, mode);
      },
      fsync: (descriptor) => {
        if (opens === 2) throw new Error("injected parent-directory fsync failure");
        fsyncSync(descriptor);
      },
    }), /injected parent-directory fsync failure/);
    assert.equal(existsSync(file), true, "rename occurred but failed durability is surfaced to the transaction");
    assert.deepEqual(readdirSync(dirname(file)).filter((entry) => entry.includes(".tmp")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("UI-off shell permits only loader/metadata/main-rewrite deltas and no renderer hooks", () => {
  const pristine = [
    { path: "main.js", sha256: SHA("a"), kind: "file" as const },
    { path: "package.json", sha256: SHA("b"), kind: "file" as const },
  ];
  const uiOff = [
    { path: "main.js", sha256: SHA("a"), kind: "file" as const },
    { path: "package.json", sha256: SHA("c"), kind: "file" as const },
    { path: "protected-loader.cjs", sha256: SHA("d"), kind: "file" as const },
    { path: "tweakers-protected.json", sha256: SHA("e"), kind: "file" as const },
  ];
  const uiOn = [
    ...uiOff,
    { path: "tweakers/runtime/main.js", sha256: SHA("f"), kind: "file" as const },
  ];
  const receipt = verifyProtectedUiOffAbsence({
    pristine,
    uiOff,
    uiOn,
    trace: [
      {
        sequence: 1,
        kind: "module-load",
        originPath: "/candidate/protected-loader.cjs",
        target: "/candidate/protected-loader.cjs",
        sha256: SHA("d"),
      },
      {
        sequence: 2,
        kind: "module-load",
        originPath: "/candidate/protected-loader.cjs",
        target: "/candidate/main.js",
        sha256: SHA("a"),
      },
    ],
    protectedLoaderPath: "/candidate/protected-loader.cjs",
    openAiMainPath: "/candidate/main.js",
    transactionId: "protected-ui-off-1",
    attempt: 1,
    grantNonce: "protected-ui-off-nonce-0001",
    appliedPendingLaunchGrantSha256: SHA("0"),
    preflightReceiptSha256: SHA("1"),
    preflightIdentitySha256: SHA("2"),
    appAsarSha256: SHA("3"),
    pristinePackageJson: { main: "main.js", name: "codex", dependencies: { electron: "1" } },
    uiOffPackageJson: {
      main: "protected-loader.cjs", name: "codex", dependencies: { electron: "1" },
      __tweakersProtected: { originalMain: "main.js", uiFeatures: "off" },
    },
    checkedAt: NOW,
  });

  assert.equal(receipt.verdict, "PASS");
  assert.deepEqual(receipt.forbiddenFindings, []);
  assert.deepEqual(receipt.uiOffAllowedDelta, ["package.json", "protected-loader.cjs", "tweakers-protected.json"]);
});

test("UI-off shell fails closed for a renderer preload or BrowserWindow mutation", () => {
  const receipt = verifyProtectedUiOffAbsence({
    pristine: [{ path: "main.js", sha256: SHA("a"), kind: "file" }],
    uiOff: [
      { path: "main.js", sha256: SHA("a"), kind: "file" },
      { path: "preload/tweakers-renderer-preload.js", sha256: SHA("b"), kind: "file" },
    ],
    uiOn: [{ path: "main.js", sha256: SHA("a"), kind: "file" }],
    trace: [{
      sequence: 1,
      kind: "browser-window",
      originPath: "/candidate/protected-loader.cjs",
      target: "BrowserWindow",
      sha256: null,
    }],
    protectedLoaderPath: "/candidate/protected-loader.cjs",
    openAiMainPath: "/candidate/main.js",
    transactionId: "protected-ui-off-2",
    attempt: 1,
    grantNonce: "protected-ui-off-nonce-0002",
    appliedPendingLaunchGrantSha256: SHA("0"),
    preflightReceiptSha256: SHA("1"),
    preflightIdentitySha256: SHA("2"),
    appAsarSha256: SHA("3"),
    pristinePackageJson: { main: "main.js", name: "codex" },
    uiOffPackageJson: { main: "protected-loader.cjs", name: "tampered", __tweakersProtected: { originalMain: "main.js", uiFeatures: "off" } },
    checkedAt: NOW,
  });

  assert.equal(receipt.verdict, "FAIL");
  assert.ok(receipt.forbiddenFindings.some((finding) => finding.includes("tweakers-renderer-preload")));
  assert.ok(receipt.forbiddenFindings.some((finding) => finding.includes("browser-window")));
  assert.ok(receipt.forbiddenFindings.some((finding) => finding.includes("package-semantic:name")));
});

test("contained signing receipt binds every required signing and ASAR oracle", () => {
  const receipt = createProtectedAppSignatureReceipt({
    transactionId: "protected-sign-1",
    attempt: 1,
    grantNonce: "protected-sign-nonce-0001",
    appliedPendingLaunchGrantSha256: SHA("0"),
    preflightReceiptSha256: SHA("a"),
    preflightIdentitySha256: SHA("b"),
    sourceContentsSha256: SHA("1"),
    protectedContentsSha256: SHA("2"),
    signingPosture: "contained",
    signingMode: "local-identity",
    signingIdentity: "Tweakers Local Signing",
    certificateSha256: SHA("3"),
    identityCreated: false,
    keychainPath: "/private/tmp/tweakers-signing.keychain-db",
    keychainSha256: SHA("4"),
    loginKeychainPreferencesUnchanged: true,
    designatedRequirement: 'designated => identifier "com.openai.codex"',
    designatedRequirementSha256: SHA("5"),
    portableEntitlementsCanonical: JSON.stringify({ "com.apple.security.cs.disable-library-validation": true }),
    portableEntitlementsSha256: SHA("6"),
    removedEntitlementKeys: [
      "application-identifier",
      "com.apple.developer.team-identifier",
      "com.apple.security.application-groups",
      "keychain-access-groups",
      "com.apple.developer.aps-environment",
    ],
    appAsarSha256: SHA("7"),
    appAsarHeaderSha256: SHA("8"),
    infoPlistAsarIntegrity: { algorithm: "SHA256", path: "Resources/app.asar", hash: SHA("8") },
    nestedCode: [{
      path: "Contents/Resources/codex",
      sha256: SHA("9"),
      architecture: "arm64",
      signingIdentity: "Tweakers Local Signing",
      designatedRequirement: 'identifier "com.openai.codex"',
      entitlementSha256: SHA("a"),
    }],
    insideOutSigned: true,
    strictVerifyOutput: "codesign --verify --deep --strict: valid",
    displayReadbackOutput: "Authority=Developer ID Application",
    gatekeeperOutput: "accepted",
    createdAt: NOW,
    builderVersion: "tweakers 1.0.0",
    toolVersions: { codesign: "1", spctl: "1", electron: "41" },
    policyDigest: SHA("b"),
  });

  assert.equal(receipt.verdict, "PASS");
  assert.equal(isProtectedAppSignatureReceipt(receipt), true);
  assert.equal(isProtectedAppSignatureReceipt({ ...receipt, appAsarHeaderSha256: SHA("c") }), false);
});

test("canonical protected loader stops before original main on failed preflight", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-loader-"));
  const previous = process.env.CODEX_CLI_PATH;
  try {
    const authorityRoot = join(root, "authority");
    mkdirSync(authorityRoot);
    writeFileSync(join(authorityRoot, "grant.json"), JSON.stringify({ grant: true }));
    writeFileSync(join(root, "main.js"), "module.exports = 'original-main';\n");
    writeFileSync(join(root, "tweakers-protected.json"), JSON.stringify({
      grantFile: "grant.json",
      preflightReceiptFile: "receipt.json",
      authorityRoot,
      originalMain: "main.js",
      transactionId: "protected-loader-1",
      attempt: 1,
      backendVersion: "0.147.0-alpha.6.5",
    }));
    const loader = cjsRequire(resolve("packages/installer/assets/protected-loader.cjs")) as {
      bootstrapProtectedApp(options: Record<string, unknown>): unknown;
    };
    let loaded = false;
    assert.throws(() => loader.bootstrapProtectedApp({
      root,
      bootstrap: {
        runProtectedBootstrapPreflight: () => ({ verdict: "FAIL", reason: "grant-invalid" }),
        applyProtectedBootstrapEnvironment: () => ({ CODEX_CLI_PATH: "/official/bundled/codex" }),
      },
      loadMain: () => { loaded = true; },
    }), /preflight failed/);
    assert.equal(loaded, false);
    assert.notEqual(process.env.CODEX_CLI_PATH, "/official/bundled/codex");
  } finally {
    if (previous === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical protected loader arms the shared quarantine authority before OpenAI main", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-loader-quarantine-"));
  const previous = { ...process.env };
  try {
    const authorityRoot = join(root, "authority");
    mkdirSync(authorityRoot);
    writeFileSync(join(authorityRoot, "grant.json"), JSON.stringify({ grant: true }));
    writeFileSync(join(root, "main.js"), "module.exports = 'original-main';\n");
    writeFileSync(join(root, "tweakers-protected.json"), JSON.stringify({
      grantFile: "grant.json",
      preflightReceiptFile: "receipt.json",
      updateQuarantineFile: "quarantine.json",
      authorityRoot,
      originalMain: "main.js",
      transactionId: "protected-loader-quarantine-1",
      attempt: 1,
      backendVersion: "0.147.0-alpha.6.5",
    }));
    const loader = cjsRequire(resolve("packages/installer/assets/protected-loader.cjs")) as {
      bootstrapProtectedApp(options: Record<string, unknown>): unknown;
    };
    const armed: unknown[] = [];
    const order: string[] = [];
    loader.bootstrapProtectedApp({
      root,
      bootstrap: {
        runProtectedBootstrapPreflight: () => ({
          verdict: "PASS",
          receiptSha256: SHA("a"),
          emittedAt: NOW,
        }),
        applyProtectedBootstrapEnvironment: () => ({ CODEX_CLI_PATH: "/managed/codex" }),
        armProtectedUpdateQuarantine: (marker: unknown, write: (next: unknown) => void) => {
          armed.push(marker);
          write(marker);
          order.push("armed");
        },
      },
      loadMain: () => {
        order.push("main");
        return "loaded";
      },
    });
    assert.equal(armed.length, 1);
    assert.deepEqual(order, ["armed", "main"]);
    assert.deepEqual(armed[0], {
      transactionId: "protected-loader-quarantine-1",
      attempt: 1,
      preflightReceiptSha256: SHA("a"),
      armedAt: NOW,
      normalLaunchBlockedUntilFreshAuthority: true,
    });
    assert.equal(JSON.parse(readFileSync(join(authorityRoot, "quarantine.json"), "utf8")).preflightReceiptSha256, SHA("a"));
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical protected loader loads only the digest-bound reviewed runtime for UI-on after PASS", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-protected-loader-ui-on-"));
  const previous = { ...process.env };
  try {
    const authorityRoot = join(root, "authority");
    const runtimeRoot = join(authorityRoot, "runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const runtimeMain = join(runtimeRoot, "main.js");
    writeFileSync(runtimeMain, "globalThis.__protectedRuntimeLoads = (globalThis.__protectedRuntimeLoads || 0) + 1;\n");
    writeFileSync(join(authorityRoot, "grant.json"), JSON.stringify({ grant: true }));
    writeFileSync(join(root, "main.js"), "module.exports = 'original-main';\n");
    const runtimeSha = createHash("sha256").update(readFileSync(runtimeMain)).digest("hex");
    const baseMetadata = {
      grantFile: "grant.json", preflightReceiptFile: "receipt.json", updateQuarantineFile: "quarantine.json",
      authorityRoot, originalMain: "main.js", transactionId: "protected-loader-ui-on-1", attempt: 1,
      runtimeMain: "runtime/main.js", runtimeMainSha256: runtimeSha,
    };
    const loader = cjsRequire(resolve("packages/installer/assets/protected-loader.cjs")) as {
      bootstrapProtectedApp(options: Record<string, unknown>): unknown;
    };
    const bootstrap = {
      runProtectedBootstrapPreflight: () => ({ verdict: "PASS", receiptSha256: SHA("a"), emittedAt: NOW }),
      applyProtectedBootstrapEnvironment: () => ({ CODEX_CLI_PATH: "/managed/codex" }),
      armProtectedUpdateQuarantine: (_marker: unknown, write: (value: unknown) => void) => write({}),
    };
    (globalThis as { __protectedRuntimeLoads?: number }).__protectedRuntimeLoads = 0;
    writeFileSync(join(root, "tweakers-protected.json"), JSON.stringify({ ...baseMetadata, uiFeatures: "off" }));
    loader.bootstrapProtectedApp({ root, bootstrap, loadMain: () => undefined });
    assert.equal((globalThis as { __protectedRuntimeLoads?: number }).__protectedRuntimeLoads, 0);
    writeFileSync(join(root, "tweakers-protected.json"), JSON.stringify({ ...baseMetadata, uiFeatures: "on" }));
    loader.bootstrapProtectedApp({ root, bootstrap, loadMain: () => undefined });
    assert.equal((globalThis as { __protectedRuntimeLoads?: number }).__protectedRuntimeLoads, 1);
    writeFileSync(runtimeMain, "tampered\n");
    assert.throws(() => loader.bootstrapProtectedApp({ root, bootstrap, loadMain: () => undefined }), /runtime digest mismatch/);
  } finally {
    delete (globalThis as { __protectedRuntimeLoads?: number }).__protectedRuntimeLoads;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(root, { recursive: true, force: true });
  }
});
