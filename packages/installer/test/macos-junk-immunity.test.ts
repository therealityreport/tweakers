import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyDirectoryPreservingModes, isMacOsJunkName, sweepMacOsJunk } from "../src/fs-copy.js";
import { fingerprintDirectoryTree } from "../src/environment-transaction.js";
import { fingerprintAppContents } from "../src/environment-profile.js";
import { computeRuntimeFingerprint } from "../src/runtime-fingerprint.js";

function scratch(name: string): string {
  return mkdtempSync(join(tmpdir(), `${name}-`));
}

function seedTree(root: string): void {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "file.txt"), "alpha");
  writeFileSync(join(root, "nested", "inner.txt"), "beta");
}

test("junk policy is .DS_Store only", () => {
  assert.equal(isMacOsJunkName(".DS_Store"), true);
  assert.equal(isMacOsJunkName("._resource"), false);
  assert.equal(isMacOsJunkName(".localized"), false);
  assert.equal(isMacOsJunkName("DS_Store"), false);
});

test("fingerprintDirectoryTree ignores Finder .DS_Store contamination", () => {
  const root = scratch("fpt");
  seedTree(root);
  const clean = fingerprintDirectoryTree(root);
  writeFileSync(join(root, ".DS_Store"), "finder junk");
  writeFileSync(join(root, "nested", ".DS_Store"), "more junk");
  assert.equal(fingerprintDirectoryTree(root), clean);
  writeFileSync(join(root, "nested", "inner.txt"), "beta-changed");
  assert.notEqual(fingerprintDirectoryTree(root), clean);
});

test("fingerprintAppContents ignores Finder .DS_Store contamination", () => {
  const app = scratch("app");
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(app, "Contents", "Info.plist"), "plist");
  writeFileSync(join(app, "Contents", "Resources", "app.asar"), "asar");
  const clean = fingerprintAppContents(app);
  writeFileSync(join(app, "Contents", ".DS_Store"), "finder junk");
  writeFileSync(join(app, "Contents", "Resources", ".DS_Store"), "junk");
  assert.equal(fingerprintAppContents(app), clean);
});

test("computeRuntimeFingerprint ignores .DS_Store in hash and fileCount", () => {
  const root = scratch("rtfp");
  seedTree(root);
  const clean = computeRuntimeFingerprint(root);
  writeFileSync(join(root, ".DS_Store"), "finder junk");
  writeFileSync(join(root, "nested", ".DS_Store"), "junk");
  const contaminated = computeRuntimeFingerprint(root);
  assert.equal(contaminated.fingerprint, clean.fingerprint);
  assert.equal(contaminated.fileCount, clean.fileCount);
});

test("sweepMacOsJunk removes junk files, never follows symlinks, tolerates a missing root", () => {
  const outside = scratch("outside");
  writeFileSync(join(outside, ".DS_Store"), "must survive");
  const root = scratch("sweep");
  seedTree(root);
  writeFileSync(join(root, ".DS_Store"), "junk");
  writeFileSync(join(root, "nested", ".DS_Store"), "junk");
  symlinkSync(outside, join(root, "escape-link"));
  sweepMacOsJunk(root);
  assert.equal(existsSync(join(root, ".DS_Store")), false);
  assert.equal(existsSync(join(root, "nested", ".DS_Store")), false);
  assert.equal(readFileSync(join(root, "file.txt"), "utf8"), "alpha");
  assert.equal(existsSync(join(outside, ".DS_Store")), true, "sweep must not traverse symlinks");
  sweepMacOsJunk(join(root, "does-not-exist"));
});

test("copyDirectoryPreservingModes strips junk from the destination", () => {
  const source = scratch("copy-src");
  seedTree(source);
  writeFileSync(join(source, ".DS_Store"), "junk");
  writeFileSync(join(source, "nested", ".DS_Store"), "junk");
  const destination = join(scratch("copy-dst"), "copy");
  copyDirectoryPreservingModes(source, destination);
  assert.equal(existsSync(join(destination, ".DS_Store")), false);
  assert.equal(existsSync(join(destination, "nested", ".DS_Store")), false);
  assert.equal(readFileSync(join(destination, "nested", "inner.txt"), "utf8"), "beta");
  assert.equal(
    fingerprintDirectoryTree(destination),
    fingerprintDirectoryTree(source),
    "junk-excluding fingerprints of source and swept copy must agree",
  );
});
