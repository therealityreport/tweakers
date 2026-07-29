import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";

const ROOT_ALIASES = [
  "TWEAKER_HOME",
  "TWEAKERS_HOME",
  "TWEAKERS_USER_ROOT",
  "TWEAKER_USER_ROOT",
  "CODEX_PLUSPLUS_USER_ROOT",
  "CODEX_PLUSPLUS_HOME",
];

test("script-test phase runs behind the disposable root preload", () => {
  assert.equal(process.env.TWEAKERS_TEST_ROOT_PRELOAD, "active");
  const fallbackRoot = process.env.TWEAKERS_TEST_FALLBACK_ROOT;
  assert.ok(fallbackRoot);
  assert.equal(existsSync(fallbackRoot), true);
  const relativeToTemp = relative(resolve(tmpdir()), resolve(fallbackRoot));
  assert.equal(isAbsolute(relativeToTemp), false);
  assert.equal(relativeToTemp === ".." || relativeToTemp.startsWith(`..${sep}`), false);
  assert.match(fallbackRoot, /tweakers-test-guard-/);
  assert.deepEqual(ROOT_ALIASES.filter((name) => process.env[name] !== undefined), []);
});

test("every package test phase names the disposable root preload", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const preload = "--import ./scripts/test-root-preload.mjs";
  assert.equal(pkg.scripts.test.split(preload).length - 1, 2);
  assert.match(pkg.scripts["test:user-questions"], /--import \.\/scripts\/test-root-preload\.mjs/);
  assert.match(pkg.scripts["test:tweaks"], /--import \.\/scripts\/test-root-preload\.mjs/);
});
