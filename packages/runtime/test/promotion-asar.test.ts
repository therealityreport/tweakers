import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import test from "node:test";
import asar from "@electron/asar";
import { hashRawAsarHeader, type RawAsarFileSystem } from "../src/promotion-asar";

async function createFixtureArchive(root: string): Promise<{ archive: string; expectedHash: string }> {
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  nodeFs.mkdirSync(join(source, "nested"), { recursive: true });
  nodeFs.writeFileSync(join(source, "package.json"), '{"name":"fixture","main":"index.js"}\n');
  nodeFs.writeFileSync(join(source, "index.js"), "module.exports = true;\n");
  nodeFs.writeFileSync(join(source, "nested", "unicode.txt"), "candidate ✓\n");
  const output = await asar.createPackage(source, archive);
  await finished(output);

  const raw = (asar as unknown as {
    getRawHeader(path: string): { headerString: string };
  }).getRawHeader(archive);
  return {
    archive,
    expectedHash: createHash("sha256").update(raw.headerString).digest("hex"),
  };
}

test("raw promotion ASAR hash matches Electron's decoded header string", async () => {
  const root = nodeFs.mkdtempSync(join(tmpdir(), "tweaker-promotion-asar-"));
  try {
    const { archive, expectedHash } = await createFixtureArchive(root);
    assert.equal(hashRawAsarHeader(archive), expectedHash);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("raw promotion ASAR hash completes across legal partial reads", async () => {
  const root = nodeFs.mkdtempSync(join(tmpdir(), "tweaker-promotion-asar-partial-read-"));
  try {
    const { archive, expectedHash } = await createFixtureArchive(root);
    let readCount = 0;
    const partialReadFileSystem: RawAsarFileSystem = {
      lstatSync: nodeFs.lstatSync,
      openSync: nodeFs.openSync,
      closeSync: nodeFs.closeSync,
      readSync: ((descriptor, buffer, offset, length, position) => {
        readCount += 1;
        return nodeFs.readSync(descriptor, buffer, offset, Math.min(length, 3), position);
      }) as typeof nodeFs.readSync,
    };

    assert.equal(hashRawAsarHeader(archive, partialReadFileSystem), expectedHash);
    assert.ok(readCount > 2, "fixture should require multiple legal short reads");
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("raw promotion ASAR hash rejects true EOF while reading the header", async () => {
  const root = nodeFs.mkdtempSync(join(tmpdir(), "tweaker-promotion-asar-truncated-read-"));
  try {
    const { archive } = await createFixtureArchive(root);
    const truncatingFileSystem: RawAsarFileSystem = {
      lstatSync: nodeFs.lstatSync,
      openSync: ((path, flags, mode) => {
        nodeFs.truncateSync(path, 12);
        return nodeFs.openSync(path, flags, mode);
      }) as typeof nodeFs.openSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
    };

    assert.throws(
      () => hashRawAsarHeader(archive, truncatingFileSystem),
      /promotion ASAR header is truncated/,
    );
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});

test("raw promotion ASAR hash rejects a directory", () => {
  const root = nodeFs.mkdtempSync(join(tmpdir(), "tweaker-promotion-asar-invalid-"));
  try {
    assert.throws(() => hashRawAsarHeader(root), /not a regular ASAR archive/);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
});
