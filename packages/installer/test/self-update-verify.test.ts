import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseSha256Sums,
  sha256File,
  verifyChecksum,
} from "../src/commands/self-update.ts";

const assetName = "tweakers-v1.2.3.tar.gz";
const hash = "a".repeat(64);

test("parseSha256Sums parses shasum output", () => {
  const upperHash = hash.toUpperCase();
  const sums = parseSha256Sums(`${upperHash}  ${assetName}\n`);

  assert.equal(sums.get(assetName), hash);
});

test("verifyChecksum passes on match", () => {
  assert.doesNotThrow(() => verifyChecksum(hash, new Map([[assetName, hash]]), assetName));
});

test("verifyChecksum throws on mismatch", () => {
  assert.throws(
    () => verifyChecksum("d".repeat(64), new Map([[assetName, hash]]), assetName),
    /mismatch/i,
  );
});

test("verifyChecksum throws on missing entry", () => {
  assert.throws(() => verifyChecksum(hash, new Map(), assetName), /no entry/i);
});

test("sha256File matches crypto over a temp file and rejects a wrong sum", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-self-update-verify-"));
  try {
    const file = join(root, "source.tar.gz");
    const bytes = Buffer.from("verified release bytes");
    writeFileSync(file, bytes);
    const expected = createHash("sha256").update(bytes).digest("hex");

    const actual = await sha256File(file);
    assert.equal(actual, expected);
    assert.throws(
      () => verifyChecksum(actual, new Map([[assetName, "0".repeat(64)]]), assetName),
      /mismatch/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
