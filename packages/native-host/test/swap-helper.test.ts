import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const helper = join(process.cwd(), "packages", "native-host", "dist", "Tweakers Swap Helper.app", "Contents", "MacOS", "Tweakers Swap Helper");

function identity(path: string): [string, string] {
  const stat = statSync(path, { bigint: true });
  return [stat.dev.toString(), stat.ino.toString()];
}

function invoke(first: string, second: string, firstIdentity = identity(first), secondIdentity = identity(second)) {
  return spawnSync(helper, ["--swap-directories", first, second, ...firstIdentity, ...secondIdentity], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("signed swap helper binds exact directory identities and swaps through held parent descriptors", {
  skip: process.platform !== "darwin" || !existsSync(helper),
}, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-swap-helper-identity-")));
  try {
    const incoming = join(root, "incoming");
    const appRoot = join(root, "ChatGPT.app");
    const contents = join(appRoot, "Contents");
    mkdirSync(incoming);
    mkdirSync(contents, { recursive: true });
    writeFileSync(join(incoming, "marker"), "incoming");
    writeFileSync(join(contents, "marker"), "outgoing");

    const success = invoke(incoming, contents);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(readFileSync(join(incoming, "marker"), "utf8"), "outgoing");
    assert.equal(readFileSync(join(contents, "marker"), "utf8"), "incoming");

    const incomingIdentity = identity(incoming);
    const contentsIdentity = identity(contents);
    const wrongContentsIdentity: [string, string] = [contentsIdentity[0], (BigInt(contentsIdentity[1]) + 1n).toString()];
    const rejected = invoke(incoming, contents, incomingIdentity, wrongContentsIdentity);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /exact physical directory identities/);
    assert.equal(readFileSync(join(incoming, "marker"), "utf8"), "outgoing");
    assert.equal(readFileSync(join(contents, "marker"), "utf8"), "incoming");

    const originalApp = join(root, "Original ChatGPT.app");
    const expectedContentsIdentity = identity(contents);
    renameSync(appRoot, originalApp);
    const replacementContents = join(appRoot, "Contents");
    mkdirSync(replacementContents, { recursive: true });
    writeFileSync(join(replacementContents, "marker"), "replacement");
    const replaced = invoke(incoming, replacementContents, identity(incoming), expectedContentsIdentity);
    assert.notEqual(replaced.status, 0);
    assert.equal(readFileSync(join(incoming, "marker"), "utf8"), "outgoing");
    assert.equal(readFileSync(join(replacementContents, "marker"), "utf8"), "replacement");
    assert.equal(readFileSync(join(originalApp, "Contents", "marker"), "utf8"), "incoming");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
