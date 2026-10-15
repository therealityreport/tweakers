import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  NATIVE_CODEX_BACKEND, NATIVE_CODE_MODE_HOST, NATIVE_CODEX_CLI_ROOT,
  captureOfficialBundledBackendClosure, assertOfficialBundledBackendClosure,
  assertOfficialBundledBackendSigningClosure, bindConsumedOfficialBundledBackendClosure,
  isPreservedOfficialBundledBackendPath, type NativeBundledBackendSignaturePort,
} from "../src/native-bundled-backend.js";
import { fingerprintVariantGeneration } from "../src/variant-generation.js";
import { resolveBundledCodexBackend } from "../src/platform.js";
import { verifySignature } from "../src/codesign.js";

const signatures: NativeBundledBackendSignaturePort = {
  certificate: () => "A".repeat(40),
  verify: () => ({ ok: true, output: "fixture original signature" }),
};

test("supplied Apple Developer ID executables are sealed using their real certificates without custom leaf requirements", {
  skip: process.platform !== "darwin" || !existsSync(join("/Applications/ChatGPT.app", NATIVE_CODEX_CLI_ROOT)),
}, () => {
  const app = "/Applications/ChatGPT.app";
  const closure = captureOfficialBundledBackendClosure(app)!;
  for (const executable of [closure.backend, closure.codeModeHost]) {
    assert.match(executable.certificateSha1, /^[A-F0-9]{40}$/);
    assert.equal(verifySignature(join(app, executable.relativePath), executable.certificateSha1).ok, true);
    assert.equal(verifySignature(join(app, executable.relativePath), "0".repeat(40)).ok, false);
  }
  assertOfficialBundledBackendClosure(app, closure);
});
function fixture(root: string): string {
  const app = join(root, "Source.app");
  for (const path of [NATIVE_CODEX_BACKEND, NATIVE_CODE_MODE_HOST]) {
    mkdirSync(dirname(join(app, path)), { recursive: true });
    writeFileSync(join(app, path), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4]));
    chmodSync(join(app, path), 0o755);
  }
  writeFileSync(join(app, NATIVE_CODEX_CLI_ROOT, "bin", "codex"), "#!/bin/sh\nexec ../CodexCLI.app/Contents/MacOS/codex\n");
  const resources = join(app, NATIVE_CODEX_CLI_ROOT, "CodexCLI.app", "Contents", "Resources");
  mkdirSync(resources);
  writeFileSync(join(resources, "helper-context.json"), "native helper context");
  symlinkSync("helper-context.json", join(resources, "context-link"));
  return app;
}

test("official supplied closure selects the Mach-O backend and preserves complete helper resources", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-closure-"));
  try {
    const source = fixture(root), candidate = join(root, "Candidate.app");
    writeFileSync(join(source, "Contents/Resources/codex"), "stale flat executable");
    const closure = captureOfficialBundledBackendClosure(source, signatures)!;
    assert.equal(closure.backend.relativePath, NATIVE_CODEX_BACKEND);
    assert.equal(closure.codeModeHost.relativePath, NATIVE_CODE_MODE_HOST);
    rmSync(join(source, "Contents/Resources/codex"));
    assert.equal(resolveBundledCodexBackend(source), join(source, NATIVE_CODEX_BACKEND));
    cpSync(source, candidate, { recursive: true, verbatimSymlinks: true });
    assertOfficialBundledBackendSigningClosure(candidate, closure, signatures);
    writeFileSync(join(candidate, NATIVE_CODEX_CLI_ROOT, "CodexCLI.app/Contents/Resources/helper-context.json"), "changed");
    assert.throws(() => assertOfficialBundledBackendSigningClosure(candidate, closure, signatures), /resource closure changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("official supplied closure refuses missing helper, script backend, and signature drift", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-closure-"));
  try {
    const source = fixture(root), closure = captureOfficialBundledBackendClosure(source, signatures)!;
    assert.throws(() => assertOfficialBundledBackendClosure(source, closure, { ...signatures, certificate: () => "B".repeat(40) }), /bytes or signature changed/);
    assert.throws(() => assertOfficialBundledBackendClosure(source, closure, { ...signatures, verify: () => ({ ok: false, output: "invalid" }) }), /signature is invalid/);
    renameSync(join(source, NATIVE_CODE_MODE_HOST), join(root, "missing-helper"));
    assert.throws(() => captureOfficialBundledBackendClosure(source, signatures), /ENOENT/);
    renameSync(join(root, "missing-helper"), join(source, NATIVE_CODE_MODE_HOST));
    writeFileSync(join(source, NATIVE_CODEX_BACKEND), "#!/bin/sh\nexit 0\n");
    assert.throws(() => captureOfficialBundledBackendClosure(source, signatures), /must be Mach-O/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unexpected source disappearance fails; authorized unchanged consumption follows only its exact candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-closure-"));
  try {
    const source = fixture(root), candidate = join(root, "Candidate.app");
    const closure = captureOfficialBundledBackendClosure(source, signatures)!;
    const fingerprint = fingerprintVariantGeneration(source);
    renameSync(source, candidate);
    assert.throws(() => assertOfficialBundledBackendSigningClosure(candidate, closure, signatures), /ENOENT/);
    const consumed = bindConsumedOfficialBundledBackendClosure(closure, candidate, fingerprint, signatures);
    assertOfficialBundledBackendSigningClosure(candidate, consumed, signatures);
    assert.throws(() => assertOfficialBundledBackendSigningClosure(join(root, "Other.app"), consumed, signatures), /another candidate/);
    writeFileSync(join(candidate, "changed-before-custody"), "drift");
    assert.throws(() => bindConsumedOfficialBundledBackendClosure(closure, candidate, fingerprint, signatures), /unchanged candidate/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native signing exclusion is bounded to the recorded subtree; historical flat layout keeps its existing path", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-closure-"));
  try {
    const source = fixture(root), closure = captureOfficialBundledBackendClosure(source, signatures)!;
    assert.equal(isPreservedOfficialBundledBackendPath(source, join(source, NATIVE_CODEX_BACKEND), closure), true);
    assert.equal(isPreservedOfficialBundledBackendPath(source, join(source, `${NATIVE_CODEX_CLI_ROOT}-other/tool`), closure), false);
    assert.equal(isPreservedOfficialBundledBackendPath(source, join(source, "Contents/MacOS/Main"), closure), false);
    assert.equal(isPreservedOfficialBundledBackendPath(source, join(source, NATIVE_CODEX_BACKEND)), false);
    rmSync(join(source, NATIVE_CODEX_CLI_ROOT), { recursive: true });
    writeFileSync(join(source, "Contents/Resources/codex"), "historical flat fixture");
    assert.equal(captureOfficialBundledBackendClosure(source, signatures), undefined);
    assert.equal(resolveBundledCodexBackend(source), join(source, "Contents/Resources/codex"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
