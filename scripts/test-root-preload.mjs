import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_ALIASES = [
  "TWEAKER_HOME",
  "TWEAKERS_HOME",
  "TWEAKERS_USER_ROOT",
  "TWEAKER_USER_ROOT",
  "CODEX_PLUSPLUS_USER_ROOT",
  "CODEX_PLUSPLUS_HOME",
];

for (const name of ROOT_ALIASES) delete process.env[name];

const fallbackRoot = mkdtempSync(join(tmpdir(), "tweakers-test-guard-"));
chmodSync(fallbackRoot, 0o700);
process.env.TWEAKERS_TEST_ROOT_PRELOAD = "active";
process.env.TWEAKERS_TEST_FALLBACK_ROOT = fallbackRoot;

process.once("exit", () => {
  rmSync(fallbackRoot, { recursive: true, force: true });
});
