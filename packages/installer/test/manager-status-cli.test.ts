import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveManagerExecutableIdentity as resolveActionManagerExecutableIdentity } from "../src/manager-cli";
import {
  resolveManagerExecutableIdentity,
  runTweakersManagerStatusCli,
} from "../src/manager-status-cli";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

test("status-only and action CLI entrypoints share the exact launcher identity resolver", () => {
  assert.equal(resolveManagerExecutableIdentity, resolveActionManagerExecutableIdentity);

  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-launcher-"));
  try {
    const bundle = join(root, "manager.mjs");
    const launcher = join(root, "Tweakers Manager Launcher");
    writeFileSync(bundle, "export {};\n", "utf8");
    writeFileSync(launcher, "launcher\n", "utf8");

    const identity = resolveManagerExecutableIdentity(bundle);
    assert.deepEqual(identity, resolveActionManagerExecutableIdentity(bundle));
    assert.equal(identity.state, "resolved");
    if (identity.state === "resolved") assert.equal(identity.path, realpathSync(launcher));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status-only CLI falls back when an injected error timestamp is parseable but not RFC3339", () => {
  const writes: string[] = [];
  const exit = runTweakersManagerStatusCli(["prepare", "--request-id", REQUEST_ID, "--json"], {
    now: () => "2026-08-27 23:00:00Z",
    write: (line) => writes.push(line),
  });

  assert.equal(exit, 64);
  assert.equal(writes.length, 1);
  const response = JSON.parse(writes[0] ?? "") as { generatedAt?: string; error?: { code?: string } };
  assert.equal(response.error?.code, "unsupported_action");
  assert.match(response.generatedAt ?? "", RFC3339);
  assert.notEqual(response.generatedAt, "2026-08-27 23:00:00Z");
});
