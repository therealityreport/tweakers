import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_LOCAL_SIGNING_IDENTITY,
  assertExactPortableEntitlements,
  assertOpenAIDeveloperIdSourceTrust,
  assertPortableEntitlements,
  codeSigningKeychainArgs,
  codeSigningCertificateLeafHash,
  codeSigningWalkRoots,
  containedSigningKeychainPath,
  createPkcs12Password,
  findExistingPreparedSigningIdentity,
  isLocallySignedWithIdentity,
  isMachOMagic,
  isInsideCodeSigningRoot,
  isCodeSigningTraversalDirectory,
  isNestedCodeBundle,
  machOAcceptsProcessEntitlements,
  parseCodeSigningIdentities,
  parseEmbeddedEntitlementsExtraction,
  portableNestedEntitlements,
  portableEntitlements,
  resolveSigningPosture,
  signatureInfo,
  signCandidateReceiptResourceBundle,
  signCodexApp,
  stableDesignatedRequirement,
  verifyCandidateReceiptResourceBundle,
  verifySignature,
  withRestoredUserKeychainPreferences,
  type SecurityCommandRunner,
} from "../src/codesign";
import { readPlist, writePlist } from "../src/plist";

test("parseCodeSigningIdentities extracts valid code signing identities", () => {
  const identities = parseCodeSigningIdentities(`
  1) ABCDEF1234567890ABCDEF1234567890ABCDEF12 "Tweakers Local Signing"
  2) 0123456789abcdef0123456789abcdef01234567 "Apple Development: Example"
     2 valid identities found
`);

  assert.deepEqual(identities, [
    {
      hash: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      name: "Tweakers Local Signing",
    },
    {
      hash: "0123456789abcdef0123456789abcdef01234567",
      name: "Apple Development: Example",
    },
  ]);
});

test("isInsideCodeSigningRoot rejects sibling and parent traversal paths", () => {
  const root = resolve("tmp", "tweaker-sign-root");

  assert.equal(isInsideCodeSigningRoot(root, join(root, "native.node")), true);
  assert.equal(isInsideCodeSigningRoot(root, join(root, "nested", "native.node")), true);
  assert.equal(isInsideCodeSigningRoot(root, join(root, "..", "outside.node")), false);
  assert.equal(isInsideCodeSigningRoot(root, join(`${root}-sibling`, "native.node")), false);
});

test("code signing traversal excludes dSYM debug payloads but keeps ordinary code directories", () => {
  assert.equal(isCodeSigningTraversalDirectory("pty.node.dSYM"), false);
  assert.equal(isCodeSigningTraversalDirectory("Codex Computer Use.app"), true);
  assert.equal(isCodeSigningTraversalDirectory("Frameworks"), true);
});

test("nested bundle discovery excludes SwiftPM resource bundles without executables", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-resource-bundle-"));
  const resourceBundle = join(root, "Package_ComputerUse.bundle");
  const codeBundle = join(root, "Executable.bundle");
  try {
    mkdirSync(resourceBundle, { recursive: true });
    writePlist(join(resourceBundle, "Info.plist"), { CFBundleIdentifier: "com.example.resources" });
    mkdirSync(join(codeBundle, "Contents"), { recursive: true });
    writePlist(join(codeBundle, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.example.executable",
      CFBundleExecutable: "Executable",
    });
    assert.equal(isNestedCodeBundle(resourceBundle), false);
    assert.equal(isNestedCodeBundle(codeBundle), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Mach-O executable classification distinguishes processes from loadable bundles", { skip: process.platform !== "darwin" }, () => {
  assert.equal(machOAcceptsProcessEntitlements("/usr/bin/true"), true);
  assert.equal(machOAcceptsProcessEntitlements(process.execPath), true);
});

test("createPkcs12Password returns a non-empty command-safe password", () => {
  const password = createPkcs12Password();

  assert.match(password, /^[A-Za-z0-9_-]+$/);
  assert.ok(password.length >= 32);
});

test("local identity recognition accepts a named local certificate without an Apple TeamIdentifier", () => {
  const local = {
    ok: true,
    adHoc: false,
    teamIdentifier: null,
    authority: [DEFAULT_LOCAL_SIGNING_IDENTITY],
    output: "TeamIdentifier=not set",
  };
  assert.equal(isLocallySignedWithIdentity(local, DEFAULT_LOCAL_SIGNING_IDENTITY), true);
  assert.equal(isLocallySignedWithIdentity({ ...local, adHoc: true }, DEFAULT_LOCAL_SIGNING_IDENTITY), false);
  assert.equal(isLocallySignedWithIdentity({ ...local, authority: ["Other Local Signing"] }, DEFAULT_LOCAL_SIGNING_IDENTITY), false);
});

test("final entitlement audit rejects a source-derived entitlement drop or addition", () => {
  const expected = {
    "com.apple.security.automation.apple-events": true,
    "com.apple.security.cs.allow-jit": true,
  };
  assert.doesNotThrow(() => assertExactPortableEntitlements(expected, { ...expected }));
  assert.throws(
    () => assertExactPortableEntitlements(expected, { "com.apple.security.automation.apple-events": true }),
    /did not match the source-derived expected set/,
  );
  assert.throws(
    () => assertExactPortableEntitlements(expected, {
      ...expected,
      "com.apple.security.cs.allow-dyld-environment-variables": true,
    }),
    /did not match the source-derived expected set/,
  );
});

test("embedded entitlement extraction fails closed on command or malformed-output failure", () => {
  assert.equal(parseEmbeddedEntitlementsExtraction({ status: 0, stdout: "", stderr: "" }, "/tmp/unsigned"), null);
  assert.throws(
    () => parseEmbeddedEntitlementsExtraction({ status: 1, stdout: "", stderr: "code object is not signed" }, "/tmp/bad"),
    /Failed to extract embedded entitlements/,
  );
  assert.throws(
    () => parseEmbeddedEntitlementsExtraction({ status: 0, stdout: "not a plist", stderr: "" }, "/tmp/malformed"),
    /non-plist output/,
  );
});

test("Mach-O recognition includes all thin and FAT byte-order variants", () => {
  for (const magic of [
    0xfeedface,
    0xfeedfacf,
    0xcefaedfe,
    0xcffaedfe,
    0xcafebabe,
    0xbebafeca,
    0xcafebabf,
    0xbfbafeca,
  ]) {
    assert.equal(isMachOMagic(magic), true, magic.toString(16));
  }
  assert.equal(isMachOMagic(0x7f454c46), false, "ELF header");
});

test("an existing Tweakers local identity signs and passes the final audit", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS codesign is unavailable");
    return;
  }
  const identities = parseCodeSigningIdentities(String(
    spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout ?? "",
  ));
  const identity = identities.find((candidate) => candidate.name === DEFAULT_LOCAL_SIGNING_IDENTITY);
  if (!identity) {
    t.skip("Tweakers Local Signing identity is not already available");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "tweakers-local-sign-audit-"));
  try {
    const app = join(root, "Audit.app");
    const executable = join(app, "Contents", "MacOS", "Audit");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    copyFileSync("/usr/bin/true", executable);
    writePlist(join(app, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.therealityreport.tweakers.audit",
      CFBundleExecutable: "Audit",
    });
    const initialSignature = spawnSync("codesign", ["--force", "--sign", identity.hash, app], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(initialSignature.status, 0, String(initialSignature.stderr ?? "initial local signing failed"));

    const result = signCodexApp(app, {
      preparedIdentity: { ...identity, created: false },
      signingPosture: "strict",
    });
    assert.equal(result?.mode, "local-identity");
    assert.equal(result?.identity, DEFAULT_LOCAL_SIGNING_IDENTITY);
    assert.equal(verifySignature(app).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outer signing audits a pre-Electron wrapper against the final outer entitlement set", (t) => {
  const identity = findDisposableSigningIdentity(t);
  if (!identity) return;

  const root = mkdtempSync(join(tmpdir(), "tweakers-wrapper-signing-"));
  try {
    const app = join(root, "Tweakers.app");
    const wrapper = join(app, "Contents", "MacOS", "ChatGPT");
    const preservedElectron = join(app, "Contents", "MacOS", "Tweakers Electron");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    copyFileSync("/usr/bin/true", wrapper);
    copyFileSync("/usr/bin/true", preservedElectron);
    writePlist(join(app, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.therealityreport.tweakers.wrapper-audit",
      CFBundleExecutable: "ChatGPT",
      CFBundlePackageType: "APPL",
      TweakersOriginalExecutable: "Tweakers Electron",
    });
    const wrapperEntitlements = join(root, "wrapper.entitlements.plist");
    const originalEntitlements = join(root, "original.entitlements.plist");
    const sourceOuter = {
      "com.apple.security.automation.apple-events": true,
      "com.apple.security.cs.allow-jit": true,
    };
    writePlist(wrapperEntitlements, {
      "com.apple.security.cs.disable-library-validation": true,
    });
    writePlist(originalEntitlements, sourceOuter);
    signDisposableCode(wrapper, identity, wrapperEntitlements);
    signDisposableCode(preservedElectron, identity, originalEntitlements);

    const result = signCodexApp(app, {
      preparedIdentity: { ...identity, created: false },
      signingPosture: "contained",
    });
    assert.equal(result?.mode, "local-identity");
    const expectedOuter = portableEntitlements(sourceOuter, "contained");
    assertExactPortableEntitlements(expectedOuter, readDisposableEntitlements(app));
    assertExactPortableEntitlements(expectedOuter, readDisposableEntitlements(wrapper));
    assertExactPortableEntitlements(expectedOuter, readDisposableEntitlements(preservedElectron));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an existing Tweakers identity noninteractively signs a strict resource-only candidate receipt bundle", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS codesign is unavailable");
    return;
  }

  let identity: ReturnType<typeof findExistingPreparedSigningIdentity>;
  try {
    identity = findExistingPreparedSigningIdentity();
  } catch (error) {
    t.skip(`existing candidate signing identity unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "tweakers-candidate-receipt-sign-"));
  try {
    const bundle = join(root, "TweakersCandidateReceipt.bundle");
    const receipt = join(bundle, "Contents", "Resources", "variant-candidate-receipt.json");
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writePlist(join(bundle, "Contents", "Info.plist"), {
      CFBundleIdentifier: "co.tweakers.candidate-receipt",
      CFBundleName: "Tweakers Candidate Receipt",
      CFBundlePackageType: "BNDL",
      CFBundleVersion: "2",
    });
    writeFileSync(receipt, '{"kind":"fixture"}\n', { mode: 0o600 });

    signCandidateReceiptResourceBundle(bundle, identity);
    verifyCandidateReceiptResourceBundle(bundle, identity.hash);
    assert.equal(codeSigningCertificateLeafHash(bundle), identity.hash.toUpperCase());

    writeFileSync(receipt, '{"kind":"tampered"}\n', { mode: 0o600 });
    assert.throws(
      () => verifyCandidateReceiptResourceBundle(bundle, identity.hash),
      /failed strict verification/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function findDisposableSigningIdentity(t: { skip: (reason?: string) => void }): { hash: string; name: string } | null {
  if (process.platform !== "darwin") {
    t.skip("macOS codesign is unavailable");
    return null;
  }
  const identities = parseCodeSigningIdentities(String(
    spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).stdout ?? "",
  ));
  const identity = identities.find((candidate) => candidate.name === DEFAULT_LOCAL_SIGNING_IDENTITY);
  if (!identity) {
    t.skip("Tweakers Local Signing identity is not already available");
    return null;
  }
  return identity;
}

function signDisposableCode(
  target: string,
  identity: { hash: string; keychainPath?: string },
  entitlementsPath: string,
): void {
  const result = spawnSync("codesign", [
    "--force",
    "--sign",
    identity.hash,
    ...codeSigningKeychainArgs(identity),
    "--entitlements",
    entitlementsPath,
    target,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, `${target}: ${String(result.stderr ?? "codesign failed")}`);
}

function readDisposableEntitlements(target: string): Record<string, unknown> {
  const result = spawnSync("codesign", ["-d", "--entitlements", ":-", target], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const xml = parseEmbeddedEntitlementsExtraction(result, target);
  if (xml === null) return {};
  const root = mkdtempSync(join(tmpdir(), "tweakers-test-entitlements-"));
  const path = join(root, "embedded.plist");
  try {
    writeFileSync(path, xml, "utf8");
    return readPlist(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("source-shaped nested signing signs wrappers deepest-first with child-specific portable audits", (t) => {
  const identity = findDisposableSigningIdentity(t);
  if (!identity) return;

  const root = mkdtempSync(join(tmpdir(), "tweakers-nested-signing-"));
  const app = join(root, "Nested.app");
  const child = join(app, "Contents", "Helpers", "Child.app");
  const deep = join(child, "Contents", "Resources", "Deep.app");
  const targets = [
    {
      path: join(app, "Contents", "MacOS", "Nested"),
      entitlements: { "com.apple.security.automation.apple-events": true },
    },
    {
      path: app,
      entitlements: { "com.apple.security.automation.apple-events": true },
    },
    {
      path: join(child, "Contents", "MacOS", "Child"),
      entitlements: { "com.apple.security.cs.allow-jit": true },
    },
    {
      path: child,
      entitlements: { "com.apple.security.cs.allow-jit": true },
    },
    {
      path: join(deep, "Contents", "MacOS", "Deep"),
      entitlements: { "com.apple.security.cs.allow-unsigned-executable-memory": true },
    },
    {
      path: deep,
      entitlements: { "com.apple.security.cs.allow-unsigned-executable-memory": true },
    },
  ];

  try {
    for (const target of targets) {
      if (target.path.endsWith(".app")) continue;
      mkdirSync(join(target.path, ".."), { recursive: true });
      copyFileSync("/usr/bin/true", target.path);
    }
    writePlist(join(app, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.therealityreport.tweakers.nested",
      CFBundleExecutable: "Nested",
      CFBundlePackageType: "APPL",
    });
    writePlist(join(child, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.therealityreport.tweakers.nested.child",
      CFBundleExecutable: "Child",
      CFBundlePackageType: "APPL",
    });
    writePlist(join(deep, "Contents", "Info.plist"), {
      CFBundleIdentifier: "com.therealityreport.tweakers.nested.deep",
      CFBundleExecutable: "Deep",
      CFBundlePackageType: "APPL",
    });

    const entitlementFiles = new Map<string, string>();
    for (const [index, target] of targets.entries()) {
      const path = join(root, `${index}.entitlements.plist`);
      writePlist(path, target.entitlements);
      entitlementFiles.set(target.path, path);
    }

    // Establish a source-shaped tree with distinct child signatures before
    // exercising the production inside-out walk. Each wrapper is signed only
    // after its own executable and deeper child wrapper are valid.
    signDisposableCode(targets[4].path, identity, entitlementFiles.get(targets[4].path)!);
    signDisposableCode(deep, identity, entitlementFiles.get(deep)!);
    signDisposableCode(targets[2].path, identity, entitlementFiles.get(targets[2].path)!);
    signDisposableCode(child, identity, entitlementFiles.get(child)!);
    signDisposableCode(targets[0].path, identity, entitlementFiles.get(targets[0].path)!);
    signDisposableCode(app, identity, entitlementFiles.get(app)!);

    const result = signCodexApp(app, {
      preparedIdentity: { ...identity, created: false },
      signingPosture: "strict",
    });
    assert.equal(result?.mode, "local-identity");
    assert.equal(result?.identity, DEFAULT_LOCAL_SIGNING_IDENTITY);

    // A deep strict verification of the outer wrapper proves its nested seal
    // order; the per-target checks prove no residual foreign identity remains.
    assert.equal(verifySignature(app).ok, true);
    const auditedTargets = [targets[0], targets[1], targets[2], targets[3], targets[4], targets[5]];
    for (const target of auditedTargets) {
      assert.equal(verifySignature(target.path).ok, true, target.path);
      assert.equal(isLocallySignedWithIdentity(signatureInfo(target.path), DEFAULT_LOCAL_SIGNING_IDENTITY), true, target.path);
      assertExactPortableEntitlements(target.entitlements, readDisposableEntitlements(target.path));
    }
    assert.notDeepEqual(readDisposableEntitlements(child), readDisposableEntitlements(deep));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable signing preserves reviewed source entitlements and scopes the contained launch exception", () => {
  const original = {
    "com.apple.security.automation.apple-events": true,
    "com.apple.security.cs.disable-library-validation": true,
    "com.apple.security.device.audio-input": true,
    "com.apple.security.device.camera": true,
    "com.apple.security.files.user-selected.read-write": true,
    "com.apple.security.network.client": true,
    "com.apple.security.personal-information.addressbook": true,
    "com.apple.security.personal-information.calendars": true,
  };

  for (const posture of [undefined, "strict", "contained"] as const) {
    assert.deepEqual(portableEntitlements(original, posture), original);
  }
  assert.deepEqual(portableEntitlements({
    "com.apple.security.automation.apple-events": true,
  }, "contained"), {
    "com.apple.security.automation.apple-events": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
  assert.deepEqual(portableEntitlements({
    "com.apple.security.automation.apple-events": true,
  }, "strict"), {
    "com.apple.security.automation.apple-events": true,
  });
  assert.throws(
    () => portableEntitlements({ "com.apple.security.cs.disable-library-validation": false }, "contained"),
    /cannot override an explicit false library-validation entitlement/,
  );
  assert.deepEqual(portableEntitlements({
    "com.apple.security.automation.apple-events": true,
    "com.apple.application-identifier": "TEAM.com.openai.codex",
    "com.apple.developer.team-identifier": "TEAM",
    "com.apple.security.application-groups": ["TEAM.group"],
    "keychain-access-groups": ["TEAM.com.openai.codex"],
    "com.apple.developer.aps-environment": "production",
  }), {
    "com.apple.security.automation.apple-events": true,
  });
});

test("portable signing rejects team, application, keychain, and provisioning entitlements", () => {
  const rejected = [
    "com.apple.application-identifier",
    "com.apple.developer.team-identifier",
    "com.apple.security.application-groups",
    "keychain-access-groups",
    "com.apple.developer.aps-environment",
  ];
  for (const key of rejected) {
    assert.throws(
      () => assertPortableEntitlements({ [key]: key.endsWith("groups") ? ["TEAM.group"] : "TEAM.value" }),
      new RegExp(`Non-portable.*${key}`),
    );
  }
  assert.throws(
    () => assertPortableEntitlements({ "com.apple.developer.associated-domains": ["applinks:example.com"] }),
    /Unreviewed non-portable entitlement/,
  );
});

test("nested Electron helpers preserve the same exact portable entitlement set", () => {
  const original = {
    "com.apple.security.app-sandbox": false,
    "com.apple.security.cs.allow-jit": true,
  };
  assert.deepEqual(portableNestedEntitlements(original, "contained"), {
    ...original,
    "com.apple.security.cs.disable-library-validation": true,
  });
  assert.deepEqual(portableNestedEntitlements(original, "strict"), original);
  assert.deepEqual(portableNestedEntitlements({ "com.apple.application-identifier": "TEAM.helper" }), {});
  assert.throws(
    () => assertPortableEntitlements({ "com.apple.application-identifier": "TEAM.helper" }),
    /Non-portable/,
  );
});

test("OpenAI Developer ID source trust requires strict verification and Gatekeeper", () => {
  const evidence = {
    signature: {
      ok: true,
      adHoc: false,
      teamIdentifier: "2DC432GLL2",
      authority: ["Developer ID Application: OpenAI, L.L.C. (2DC432GLL2)"],
      output: "",
    },
    strictVerification: { ok: true, output: "strict valid" },
    gatekeeper: { ok: true, output: "accepted" },
  };
  assert.doesNotThrow(() => assertOpenAIDeveloperIdSourceTrust(evidence));
  assert.throws(
    () => assertOpenAIDeveloperIdSourceTrust({ ...evidence, strictVerification: { ok: false, output: "invalid" } }),
    /strict-valid, Gatekeeper-accepted OpenAI Developer ID signature/,
  );
  assert.throws(
    () => assertOpenAIDeveloperIdSourceTrust({ ...evidence, gatekeeper: { ok: false, output: "rejected" } }),
    /strict-valid, Gatekeeper-accepted OpenAI Developer ID signature/,
  );
  assert.throws(
    () => assertOpenAIDeveloperIdSourceTrust({
      ...evidence,
      signature: { ...evidence.signature, authority: ["Developer ID Application: Example (2DC432GLL2)"] },
    }),
    /strict-valid, Gatekeeper-accepted OpenAI Developer ID signature/,
  );
});

test("portable signing accepts the official or pinned local identity", () => {
  assert.equal(
    stableDesignatedRequirement(
      'designated => identifier "com.openai.codex" and anchor apple generic',
      "com.openai.codex",
      "ABCDEF",
    ),
    'designated => (identifier "com.openai.codex" and anchor apple generic) or (identifier "com.openai.codex" and certificate leaf = H"ABCDEF")',
  );
});

test("code signing walks the complete Contents tree, including Computer Use and loose resources", () => {
  assert.deepEqual(codeSigningWalkRoots("/Apps/Codex.app"), [
    "/Apps/Codex.app/Contents",
  ]);
});

test("resolveSigningPosture defaults to contained until strict is explicitly enabled", () => {
  assert.equal(resolveSigningPosture(undefined, {}), "contained");
  assert.equal(resolveSigningPosture(undefined, { TWEAKERS_SIGNING_MODE: "" }), "contained");
  assert.equal(resolveSigningPosture(undefined, { TWEAKERS_SIGNING_MODE: "contained" }), "contained");
  assert.equal(resolveSigningPosture(undefined, { TWEAKERS_SIGNING_MODE: "strict" }), "strict");
  assert.equal(resolveSigningPosture("strict", { TWEAKERS_SIGNING_MODE: "contained" }), "strict");
  assert.equal(resolveSigningPosture("contained", { TWEAKERS_SIGNING_MODE: "strict" }), "contained");
});

test("contained signing uses a dedicated non-login keychain", () => {
  const path = containedSigningKeychainPath({ HOME: "/Users/x" });

  assert.equal(path, "/Users/x/Library/Keychains/tweakers-signing.keychain-db");
  assert.ok(path.endsWith("tweakers-signing.keychain-db"));
  assert.ok(!path.includes("login.keychain"));
});

function mockUserKeychainPreferences(
  initialSearchList: string[],
  initialDefault: string | null,
): {
  calls: string[][];
  run: SecurityCommandRunner;
  state: { searchList: string[]; defaultKeychain: string | null };
} {
  const calls: string[][] = [];
  const state = {
    searchList: [...initialSearchList],
    defaultKeychain: initialDefault,
  };
  const run: SecurityCommandRunner = (command, args) => {
    assert.equal(command, "security");
    calls.push([...args]);
    if (args[0] === "list-keychains") {
      const setAt = args.indexOf("-s");
      if (setAt >= 0) state.searchList = args.slice(setAt + 1);
      return {
        status: 0,
        stdout: state.searchList.map((path) => `    "${path}"`).join("\n"),
        stderr: "",
      };
    }
    if (args[0] === "default-keychain") {
      const setAt = args.indexOf("-s");
      if (setAt >= 0) state.defaultKeychain = args[setAt + 1] ?? null;
      return {
        status: 0,
        stdout: state.defaultKeychain ? `"${state.defaultKeychain}"\n` : "",
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: `unexpected security command: ${args[0]}` };
  };
  return { calls, run, state };
}

test("contained signing restores and verifies user Keychain preferences after success", () => {
  const login = "/Users/x/Library/Keychains/login.keychain-db";
  const secondary = "/Users/x/Library/Keychains/secondary.keychain-db";
  const contained = "/Users/x/Library/Keychains/tweakers-signing.keychain-db";
  const mock = mockUserKeychainPreferences([login, secondary], login);

  const result = withRestoredUserKeychainPreferences(() => {
    mock.state.searchList = [login, secondary, contained];
    mock.state.defaultKeychain = contained;
    return "signed";
  }, { run: mock.run });

  assert.equal(result, "signed");
  assert.deepEqual(mock.state.searchList, [login, secondary]);
  assert.equal(mock.state.defaultKeychain, login);
  assert.ok(mock.calls.some((args) =>
    args[0] === "list-keychains" && args.includes("-s") && args.at(-1) === secondary));
  assert.ok(mock.calls.some((args) =>
    args[0] === "default-keychain" && args.includes("-s") && args.at(-1) === login));
});

test("contained signing restores exact default and duplicate search entries after failure", () => {
  const login = "/Users/x/Library/Keychains/login.keychain-db";
  const secondary = "/Users/x/Library/Keychains/secondary.keychain-db";
  const contained = "/Users/x/Library/Keychains/tweakers-signing.keychain-db";
  const originalSearchList = [login, secondary, login];
  const mock = mockUserKeychainPreferences(originalSearchList, secondary);

  assert.throws(
    () => withRestoredUserKeychainPreferences(() => {
      mock.state.searchList = [contained];
      mock.state.defaultKeychain = contained;
      throw new Error("candidate signing failed");
    }, { run: mock.run }),
    /candidate signing failed/,
  );

  assert.deepEqual(mock.state.searchList, originalSearchList);
  assert.equal(mock.state.defaultKeychain, secondary);
});

test("contained signing fails closed without mutating a null default", () => {
  const login = "/Users/x/Library/Keychains/login.keychain-db";
  const secondary = "/Users/x/Library/Keychains/secondary.keychain-db";
  const originalSearchList = [login, secondary, login];
  const mock = mockUserKeychainPreferences(originalSearchList, null);
  let actionCalled = false;

  assert.throws(
    () => withRestoredUserKeychainPreferences(() => {
      actionCalled = true;
    }, { run: mock.run }),
    /default keychain is null.*separate user authorization/,
  );

  assert.equal(actionCalled, false);
  assert.deepEqual(mock.state.searchList, originalSearchList);
  assert.equal(mock.state.defaultKeychain, null);
  assert.deepEqual(mock.calls.map((args) => args[0]), ["list-keychains", "default-keychain"]);
  assert.ok(mock.calls.every((args) => !args.includes("-s")));
});

test("contained signing identity is passed to codesign with an explicit keychain", () => {
  assert.deepEqual(codeSigningKeychainArgs({ keychainPath: "/tmp/contained.keychain-db" }), [
    "--keychain",
    "/tmp/contained.keychain-db",
  ]);
  assert.deepEqual(codeSigningKeychainArgs(undefined), []);
});
