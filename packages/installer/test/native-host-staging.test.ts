import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveStagedSwapNativeHostEvidence,
  resolveStagedSwapNativeHost,
  stageNativeHostInsideApp,
  stagedNativeHostPath,
  verifyNativeHostMatchesApp,
  verifyStagedNativeHostForApp,
} from "../src/commands/install";
import type { SignatureInfo } from "../src/codesign";

function signature(teamIdentifier: string | null, authority = "Tweakers Local Signing"): SignatureInfo {
  return {
    ok: true,
    adHoc: false,
    teamIdentifier,
    authority: [authority],
    output: "fixture",
  };
}

test("native host is copied to the deterministic candidate resource path before signing", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-native-stage-"));
  try {
    const app = join(root, "candidate.app");
    const runtime = join(root, "runtime");
    mkdirSync(join(runtime, "native"), { recursive: true });
    writeFileSync(join(runtime, "native", "tweaker_native_host.node"), "signed-host-bytes");

    const staged = stageNativeHostInsideApp(app, runtime);

    assert.equal(staged, join(app, "Contents", "Resources", "tweakers", "native", "tweaker_native_host.node"));
    assert.equal(staged, stagedNativeHostPath(app));
    assert.equal(readFileSync(staged, "utf8"), "signed-host-bytes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate build stages the app native host before its final signing call", () => {
  const source = readFileSync(join(process.cwd(), "packages", "installer", "src", "commands", "install.ts"), "utf8");
  const stageIndex = source.indexOf("stageNativeHostInsideApp(codex.appRoot, paths.runtime)");
  const signIndex = source.indexOf("signCodexApp(codex.appRoot", stageIndex);
  const verifyIndex = source.indexOf("verifyStagedNativeHostForApp(codex.appRoot)", signIndex);
  assert.ok(stageIndex >= 0, "candidate staging call must exist");
  assert.ok(signIndex > stageIndex, "native host must be inside the candidate before final signing");
  assert.ok(verifyIndex > signIndex, "signed host identity must be verified after final signing");
});

test("swap resolution uses an app-staged host and has no repo/runtime fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-native-swap-"));
  try {
    const incoming = join(root, "incoming-Contents");
    const live = join(root, "ChatGPT.app", "Contents");
    const host = join(incoming, "Resources", "tweakers", "native", "tweaker_native_host.node");
    mkdirSync(join(host, ".."), { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(host, "host");
    assert.equal(resolveStagedSwapNativeHost(incoming, live), host);
    rmSync(host);
    assert.throws(
      () => resolveStagedSwapNativeHost(incoming, live),
      /No signed staged native host.*refusing repo\/runtime dlopen fallback/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("swap verification binds a staged host to the candidate payload that contains it", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-native-swap-identity-"));
  try {
    const candidateApp = join(root, "candidate.app");
    const liveApp = join(root, "ChatGPT.app");
    const candidateContents = join(candidateApp, "Contents");
    const live = join(liveApp, "Contents");
    const host = join(candidateContents, "Resources", "tweakers", "native", "tweaker_native_host.node");
    mkdirSync(join(host, ".."), { recursive: true });
    mkdirSync(live, { recursive: true });
    writeFileSync(host, "host");

    const resolved = resolveStagedSwapNativeHostEvidence(candidateContents, live);
    assert.equal(resolved.hostPath, host);
    assert.equal(resolved.containingAppRoot, candidateApp);
    assert.doesNotThrow(() => verifyNativeHostMatchesApp(resolved.containingAppRoot, resolved.hostPath, {
      verify: () => ({ ok: true, output: "ok" }),
      signature: (path) => signature(path === liveApp ? "2DC432GLL2" : null),
      designatedRequirement: () => 'designated => certificate leaf = H"abcdef"',
    }));

    const source = readFileSync(join(process.cwd(), "packages", "installer", "src", "commands", "install.ts"), "utf8");
    assert.match(
      source,
      /prepareAtomicSwapDirectories\(sourceContents, destinationContents\)/,
      "the default swap must verify against the signed source/destination payloads, not the bare incoming copy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate verification requires strict matching Team IDs", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-native-signature-"));
  try {
    const app = join(root, "candidate.app");
    const host = stagedNativeHostPath(app);
    mkdirSync(join(host, ".."), { recursive: true });
    writeFileSync(host, "host");
    const verify = () => ({ ok: true, output: "ok" });
    const matching = () => signature("TEAM123");
    assert.equal(verifyStagedNativeHostForApp(app, { verify, signature: matching }), host);

    assert.throws(() => verifyNativeHostMatchesApp(app, host, {
      verify,
      signature: (path) => signature(path === app ? "APPTEAM" : "HOSTTEAM"),
    }), /Team ID does not match/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("teamless local candidates require the exact same signing authority", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-native-local-signature-"));
  try {
    const app = join(root, "candidate.app");
    const host = stagedNativeHostPath(app);
    mkdirSync(join(host, ".."), { recursive: true });
    writeFileSync(host, "host");
    const verify = () => ({ ok: true, output: "ok" });

    assert.doesNotThrow(() => verifyNativeHostMatchesApp(app, host, {
      verify,
      signature: () => signature(null),
      designatedRequirement: () => 'designated => certificate leaf = H"abcdef"',
    }));
    assert.throws(() => verifyNativeHostMatchesApp(app, host, {
      verify,
      signature: (path) => signature(null, path === app ? "Local A" : "Local B"),
      designatedRequirement: () => 'designated => certificate leaf = H"abcdef"',
    }), /does not share the candidate's local signing identity/);
    assert.throws(() => verifyNativeHostMatchesApp(app, host, {
      verify,
      signature: () => signature(null),
      designatedRequirement: (path) => `designated => certificate leaf = H"${path === app ? "aaaa" : "bbbb"}"`,
    }), /does not share the candidate's exact local signing certificate/);
    assert.equal(existsSync(host), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
