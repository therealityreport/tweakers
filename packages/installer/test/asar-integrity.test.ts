import assert from "node:assert/strict";
import asar from "@electron/asar";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import test from "node:test";
import { cleanupTempTree, patchAsar } from "../src/asar";

async function createFixtureArchive(root: string): Promise<string> {
  const src = join(root, "src");
  const archive = join(root, "app.asar");
  mkdirSync(join(src, "webview"), { recursive: true });
  writeFileSync(join(src, "package.json"), JSON.stringify({ name: "fixture" }));
  writeFileSync(join(src, "webview", "index.html"), "tail-content\n".repeat(8_192));

  const output = await asar.createPackageWithOptions(src, archive, {
    globOptions: { dot: true },
  });
  await finished(output);
  return archive;
}

test("patchAsar waits for the package output stream before copying", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-asar-pack-finish-"));
  try {
    const archive = await createFixtureArchive(root);
    const completeArchive = readFileSync(archive);
    const packageOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    let packedPath = "";
    let copyCalled = false;
    let notifyPackStarted!: () => void;
    const packStarted = new Promise<void>((resolve) => {
      notifyPackStarted = resolve;
    });

    const patch = patchAsar(archive, () => {}, {
      createPackage: async (_src, dest) => {
        packedPath = dest;
        writeFileSync(dest, completeArchive.subarray(0, completeArchive.length - 13_998));
        notifyPackStarted();
        return packageOutput;
      },
      copyFile: (from, to) => {
        copyCalled = true;
        cpSync(from, to);
      },
    });

    await packStarted;
    assert.equal(copyCalled, false, "copy must not start while the pack stream is unfinished");

    writeFileSync(packedPath, completeArchive);
    packageOutput.end();
    await patch;

    assert.equal(copyCalled, true);
    assert.deepEqual(readFileSync(archive), completeArchive);
  } finally {
    await cleanupTempTree(root);
  }
});

test("patchAsar rejects a finished but truncated packed output before copying", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-asar-pack-integrity-"));
  try {
    const archive = await createFixtureArchive(root);
    const originalArchive = readFileSync(archive);
    let copyCalled = false;

    await assert.rejects(
      patchAsar(archive, () => {}, {
        createPackage: async (_src, dest) => {
          writeFileSync(dest, originalArchive.subarray(0, originalArchive.length - 13_998));
          const output = new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          });
          output.end();
          return output;
        },
        copyFile: () => {
          copyCalled = true;
        },
      }),
      /Incomplete ASAR archive.*expected EOF/,
    );

    assert.equal(copyCalled, false);
    assert.deepEqual(readFileSync(archive), originalArchive);
  } finally {
    await cleanupTempTree(root);
  }
});

test("patchAsar rejects a truncated staged copy without replacing the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-asar-stage-integrity-"));
  try {
    const archive = await createFixtureArchive(root);
    const originalArchive = readFileSync(archive);
    const stagingPath = `${archive}.tweaker-new`;

    await assert.rejects(
      patchAsar(archive, () => {}, {
        copyFile: (from, to) => {
          const packed = readFileSync(from);
          writeFileSync(to, packed.subarray(0, packed.length - 13_998));
        },
      }),
      /Incomplete ASAR archive.*expected EOF/,
    );

    assert.deepEqual(readFileSync(archive), originalArchive);
    assert.equal(existsSync(stagingPath), false);
  } finally {
    await cleanupTempTree(root);
  }
});
