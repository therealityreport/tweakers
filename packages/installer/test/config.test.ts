import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configFileIsTrusted, readConfigFile, updateConfigFile } from "../src/config.ts";

test("accepts a properly-owned 0o600 config", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-config-"));
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify({ trusted: true }));
  chmodSync(configFile, 0o600);

  assert.equal(configFileIsTrusted(configFile), true);
  assert.deepEqual(readConfigFile(configFile), { trusted: true });
});

test("rejects a group/other-writable config", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-config-"));
  const configFile = join(root, "config.json");
  writeFileSync(configFile, JSON.stringify({ trusted: false }));
  chmodSync(configFile, 0o666);

  assert.equal(configFileIsTrusted(configFile), false);
  assert.deepEqual(readConfigFile(configFile), {});
});

test("updateConfigFile writes 0o600", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-config-"));
  const configFile = join(root, "config.json");

  updateConfigFile(configFile, (config) => {
    config.written = true;
  });

  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.deepEqual(readConfigFile(configFile), { written: true });
});
