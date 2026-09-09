import assert from "node:assert/strict";
import asar from "@electron/asar";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHeaderHash } from "../src/asar.js";
import {
  assertResourceAsarIntegrity,
  setIntegrity,
} from "../src/integrity.js";
import { readPlist, writePlist } from "../src/plist.js";
import type { CodexInstall } from "../src/platform.js";

async function stageFixture(): Promise<{ root: string; install: CodexInstall }> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-integrity-"));
  const resourcesDir = join(root, "ChatGPT.app", "Contents", "Resources");
  const metaPath = join(root, "ChatGPT.app", "Contents", "Info.plist");
  mkdirSync(resourcesDir, { recursive: true });
  for (const name of ["app", "busy-bar"]) {
    const source = join(root, `${name}-source`);
    mkdirSync(source);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name, main: "main.js" }));
    writeFileSync(join(source, "main.js"), `module.exports = ${JSON.stringify(name)};\n`);
    await asar.createPackage(source, join(resourcesDir, `${name}.asar`));
  }
  const appHash = readHeaderHash(join(resourcesDir, "app.asar")).headerHash;
  writePlist(metaPath, {
    ElectronAsarIntegrity: {
      "Resources/app.asar": { algorithm: "SHA256", hash: appHash },
    },
  });
  return {
    root,
    install: {
      appRoot: join(root, "ChatGPT.app"),
      resourcesDir,
      asarPath: join(resourcesDir, "app.asar"),
      metaPath,
      electronBinary: "",
      executable: "",
      appName: "ChatGPT",
      bundleId: "com.openai.codex",
      channel: "stable",
      platform: "darwin",
    },
  };
}

test("macOS integrity publication covers every top-level ASAR archive", async () => {
  const fixture = await stageFixture();
  try {
    assert.throws(
      () => assertResourceAsarIntegrity(fixture.install),
      /ElectronAsarIntegrity does not match Resources\/busy-bar\.asar/,
    );

    const appHash = readHeaderHash(fixture.install.asarPath).headerHash;
    setIntegrity(fixture.install, appHash);
    assert.doesNotThrow(() => assertResourceAsarIntegrity(fixture.install));

    const plist = readPlist(fixture.install.metaPath!);
    const entries = plist.ElectronAsarIntegrity as Record<string, { algorithm: string; hash: string }>;
    assert.deepEqual(Object.keys(entries).sort(), ["Resources/app.asar", "Resources/busy-bar.asar"]);
    assert.deepEqual(entries["Resources/app.asar"], { algorithm: "SHA256", hash: appHash });
    assert.deepEqual(entries["Resources/busy-bar.asar"], {
      algorithm: "SHA256",
      hash: readHeaderHash(join(fixture.install.resourcesDir, "busy-bar.asar")).headerHash,
    });

    entries["Resources/busy-bar.asar"] = { algorithm: "SHA256", hash: "0".repeat(64) };
    writePlist(fixture.install.metaPath!, plist);
    assert.throws(
      () => assertResourceAsarIntegrity(fixture.install),
      /ElectronAsarIntegrity does not match Resources\/busy-bar\.asar/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("macOS integrity publication rejects a symlinked ASAR resource", { skip: process.platform === "win32" }, async () => {
  const fixture = await stageFixture();
  try {
    symlinkSync(join(fixture.install.resourcesDir, "busy-bar.asar"), join(fixture.install.resourcesDir, "linked.asar"));
    assert.throws(
      () => setIntegrity(fixture.install, readHeaderHash(fixture.install.asarPath).headerHash),
      /Refusing unsafe Electron ASAR resource: Resources\/linked\.asar/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
