import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertElectronIntegrityDictionaryDigest, integrityDictionaryDigest, setElectronIntegrityDictionaryDigest } from "../src/electron-integrity-digest.js";
import { digestSentinel, integrityMachO, slotOffset, universalMachO } from "./fixtures/electron-integrity-macho.js";

const dictionary = {
  "Resources/busy-bar.asar": { algorithm: "SHA256", hash: "A".repeat(64) },
  "Resources/app.asar": { algorithm: "SHA256", hash: "b".repeat(64) },
};
const expected = createHash("sha256").update("Resources/app.asarSHA256" + "b".repeat(64) + "Resources/busy-bar.asarSHA256" + "A".repeat(64)).digest();

function withBinary(bytes: Buffer, fn: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweakers-integrity-digest-")), path = join(root, "framework");
  try { writeFileSync(path, bytes, { mode: 0o755 }); fn(path); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("dictionary digest follows Electron's sorted exact UTF-8 concatenation", () => {
  assert.deepEqual(integrityDictionaryDigest(dictionary), expected);
  assert.notDeepEqual(integrityDictionaryDigest({ ...dictionary, "Resources/busy-bar.asar": { algorithm: "SHA256", hash: "a".repeat(64) } }), expected);
  for (const value of [null, [], {}, { x: null }, { x: { algorithm: "MD5", hash: "a".repeat(64) } }, { x: { algorithm: "SHA256", hash: "wrong" } },
    { x: { algorithm: "SHA256", hash: "a".repeat(64), future: {} } }, { x: Object.create({ algorithm: "SHA256", hash: "a".repeat(64) }) },
    { x: Object.assign(Object.create({ algorithm: "SHA256", hash: "a".repeat(64) }), { "algorithm,hash": true }) }]) {
    assert.throws(() => integrityDictionaryDigest(value), /dictionary/);
  }
});

test("newer framework rejects a stale seal and updates exactly its digest before signing", () => {
  const before = integrityMachO();
  withBinary(before, path => {
    assert.throws(() => assertElectronIntegrityDictionaryDigest(path, dictionary), /does not match/);
    const inode = statSync(path).ino; chmodSync(path, 0o755);
    setElectronIntegrityDictionaryDigest(path, dictionary);
    const after = readFileSync(path);
    assert.deepEqual(after.subarray(0, slotOffset + 34), before.subarray(0, slotOffset + 34));
    assert.deepEqual(after.subarray(slotOffset + 66), before.subarray(slotOffset + 66));
    assert.deepEqual(after.subarray(slotOffset + 34, slotOffset + 66), expected);
    assert.equal(statSync(path).ino, inode); assert.equal(statSync(path).mode & 0o777, 0o755);
    assert.doesNotThrow(() => assertElectronIntegrityDictionaryDigest(path, dictionary));
    assert.throws(() => assertElectronIntegrityDictionaryDigest(path, { ...dictionary, "Resources/app.asar": { algorithm: "SHA256", hash: "c".repeat(64) } }), /does not match/);
  });
});

test("activates a known unused slot and retains every other byte", () => {
  const before = integrityMachO({ used: 0, version: 0 });
  withBinary(before, path => {
    assert.throws(() => assertElectronIntegrityDictionaryDigest(path, dictionary), /does not match/);
    setElectronIntegrityDictionaryDigest(path, dictionary);
    const after = readFileSync(path); assert.deepEqual(after.subarray(0, slotOffset + 32), before.subarray(0, slotOffset + 32));
    assert.equal(after[slotOffset + 32], 1); assert.equal(after[slotOffset + 33], 1);
    assert.deepEqual(after.subarray(slotOffset + 66), before.subarray(slotOffset + 66));
    assert.doesNotThrow(() => assertElectronIntegrityDictionaryDigest(path, dictionary));
  });
});

test("receipt-bound legacy verification accepts only a pristine unused slot", () => {
  const legacy = integrityMachO({ used: 0, version: 0 });
  withBinary(legacy, path => {
    assert.doesNotThrow(() => assertElectronIntegrityDictionaryDigest(path, dictionary, { allowLegacyUnusedSlot: true }));
    assert.deepEqual(readFileSync(path), legacy);
    assert.throws(() => assertElectronIntegrityDictionaryDigest(path, dictionary), /does not match/);
  });
  for (const invalid of [integrityMachO({ used: 0, version: 0, digest: Buffer.alloc(32, 1) }),
    integrityMachO(), integrityMachO({ used: 0, version: 1 })]) {
    withBinary(invalid, path => assert.throws(() => assertElectronIntegrityDictionaryDigest(path, dictionary,
      { allowLegacyUnusedSlot: true }), /does not match|slot version/));
  }
  withBinary(integrityMachO(), path => {
    setElectronIntegrityDictionaryDigest(path, dictionary);
    assert.throws(() => assertElectronIntegrityDictionaryDigest(path, { ...dictionary,
      "Resources/app.asar": { algorithm: "SHA256", hash: "c".repeat(64) } }, { allowLegacyUnusedSlot: true }), /does not match/);
  });
});

test("thin and universal Mach-O byte orders seal every architecture", () => {
  for (const little of [true, false]) for (const wide of [true, false]) {
    for (const bytes of [integrityMachO({ little, wide }), universalMachO([integrityMachO(), integrityMachO({ little: false, wide: false })], little, wide)]) {
      withBinary(bytes, path => { setElectronIntegrityDictionaryDigest(path, dictionary); assert.doesNotThrow(() => assertElectronIntegrityDictionaryDigest(path, dictionary)); });
    }
  }
});

test("older frameworks without a slot remain byte-for-byte unchanged", () => {
  const before = integrityMachO({ slot: false });
  withBinary(before, path => { setElectronIntegrityDictionaryDigest(path, dictionary); assert.doesNotThrow(() => assertElectronIntegrityDictionaryDigest(path, dictionary)); assert.deepEqual(readFileSync(path), before); });
});

test("malformed and ambiguous slots fail before any binary write", () => {
  const variants = [Buffer.alloc(2), Buffer.alloc(384), integrityMachO({ used: 1, version: 2 }), integrityMachO({ used: 0, version: 1 }), integrityMachO().subarray(0, 300)];
  const duplicate = integrityMachO(); digestSentinel.copy(duplicate, 330); variants.push(duplicate);
  const escaped = integrityMachO(); escaped.writeUInt32LE(330, 152); variants.push(escaped);
  const virtual = integrityMachO(); virtual.writeBigUInt64LE(0n, 136); variants.push(virtual);
  const zeroFill = integrityMachO(); zeroFill.writeUInt32LE(1, 168); variants.push(zeroFill);
  // A slot hidden inside an opaque load command must never be patched.
  const inCommands = integrityMachO(); inCommands.writeUInt32LE(2, 16); inCommands.writeUInt32LE(320, 20);
  inCommands.writeUInt32LE(0x77777777, 184); inCommands.writeUInt32LE(168, 188); variants.push(inCommands);
  const overlap = universalMachO([integrityMachO(), integrityMachO()]); overlap.writeUInt32BE(overlap.readUInt32BE(16), 36); variants.push(overlap);
  variants.push(universalMachO([integrityMachO(), integrityMachO({ slot: false })]));
  variants.push(universalMachO([integrityMachO(), integrityMachO({ used: 1, version: 7 })]));
  for (const before of variants) withBinary(before, path => {
    assert.throws(() => setElectronIntegrityDictionaryDigest(path, dictionary), /Mach-O|slot version/);
    assert.deepEqual(readFileSync(path), before);
  });
  assert.throws(() => assertElectronIntegrityDictionaryDigest("/nonexistent/tweakers-framework", dictionary), /ENOENT/);
});
