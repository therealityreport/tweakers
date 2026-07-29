import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  codeSigningWalkRoots,
  containedSigningKeychainPath,
  createPkcs12Password,
  isInsideCodeSigningRoot,
  parseCodeSigningIdentities,
  portableEntitlements,
  resolveSigningPosture,
  stableDesignatedRequirement,
} from "../src/codesign";

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

test("createPkcs12Password returns a non-empty command-safe password", () => {
  const password = createPkcs12Password();

  assert.match(password, /^[A-Za-z0-9_-]+$/);
  assert.ok(password.length >= 32);
});

test("strict portable signing keeps privacy entitlements with library validation on", () => {
  const original = {
    "com.apple.security.automation.apple-events": true,
    "com.apple.application-identifier": "TEAM.com.openai.codex",
    "com.apple.developer.team-identifier": "TEAM",
    "com.apple.security.application-groups": ["TEAM.group"],
    "keychain-access-groups": ["TEAM.com.openai.codex"],
    "com.apple.developer.aps-environment": "production",
    "com.apple.security.cs.disable-library-validation": true,
  };
  const strictByDefault = portableEntitlements(original);
  const explicitStrict = portableEntitlements(original, "strict");

  for (const strict of [strictByDefault, explicitStrict]) {
    assert.deepEqual(strict, {
      "com.apple.security.automation.apple-events": true,
    });
    assert.ok(!("com.apple.security.cs.disable-library-validation" in strict));
  }
});

test("contained portable signing keeps library validation disabled", () => {
  assert.deepEqual(portableEntitlements({
    "com.apple.security.automation.apple-events": true,
    "com.apple.application-identifier": "TEAM.com.openai.codex",
    "com.apple.developer.aps-environment": "production",
  }, "contained"), {
    "com.apple.security.automation.apple-events": true,
    "com.apple.security.cs.disable-library-validation": true,
  });
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

test("code signing walks frameworks, unpacked modules, and the staged Tweakers native host", () => {
  assert.deepEqual(codeSigningWalkRoots("/Apps/Codex.app"), [
    "/Apps/Codex.app/Contents/Frameworks",
    "/Apps/Codex.app/Contents/Resources/app.asar.unpacked",
    "/Apps/Codex.app/Contents/Resources/tweakers/native",
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
