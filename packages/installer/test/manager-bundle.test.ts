import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertTweakersManagerBundleMetafile, buildTweakersManagerBundle } from "../scripts/build-manager.mjs";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";

test("production manager bundle is standalone, status-only, and advertises no actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-bundle-"));
  const outfile = join(root, "manager.mjs");
  try {
    const built = await buildTweakersManagerBundle({ outfile, logLevel: "silent" });
    assert.equal(existsSync(outfile), true);
    const imports = Object.values(built.metafile.outputs).flatMap((output) => output.imports ?? []);
    assert.equal(imports.every((entry) => entry.external === true && entry.path.startsWith("node:")), true);
    const inputs = Object.keys(built.metafile.inputs ?? {});
    assert.equal(inputs.some((input) => /(?:^|\/)src\/manager-(?:action|operation|environment-action)/.test(input)), false);

    const bytes = readFileSync(outfile, "utf8");
    for (const forbidden of ["environment.cancel", "desktop-update.resume", "createSealedTweakersManagerActionAdapter"]) {
      assert.equal(bytes.includes(forbidden), false, `production bundle contains dormant action marker: ${forbidden}`);
    }

    const environment = {
      HOME: process.env.HOME ?? "",
      TWEAKER_HOME: join(root, "missing-status-root"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C",
    };
    const status = invoke(outfile, ["status", "--request-id", REQUEST_ID, "--json"], environment);
    assert.equal(status.status, 0, status.stderr);
    const response = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.equal(response.requestId, REQUEST_ID);
    assert.equal(response.managerId, "com.thomashulihan.tweakers");
    assert.deepEqual(response.actions, []);
    assert.equal(existsSync(environment.TWEAKER_HOME), false, "status must not create the missing user root");

    for (const argv of [
      ["prepare", "--request-id", REQUEST_ID, "--json"],
      ["execute", "--request-id", REQUEST_ID, "--json"],
      ["cancel", "--request-id", REQUEST_ID, "--json"],
      ["status", "--request-id", REQUEST_ID, "--json", "extra"],
    ]) {
      const rejected = invoke(outfile, argv, environment);
      assert.equal(rejected.status, 64, `${argv.join(" ")}: ${rejected.stderr}`);
      assert.equal((JSON.parse(rejected.stdout) as { error: { code: string } }).error.code,
        argv[0] === "status" ? "invalid_request" : "unsupported_action");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager bundle metafile rejects non-Node externals and dormant action inputs", () => {
  assert.throws(() => assertTweakersManagerBundleMetafile({
    outputs: { "/tmp/manager.mjs": { imports: [{ path: "kleur", external: true }] } },
  }, "/tmp/manager.mjs"), /forbidden non-Node external/);

  for (const input of [
    "/workspace/packages/installer/src/desktop-update-transaction.ts",
    "/workspace/packages/installer/src/manager-action-adapter.ts",
    "/workspace/packages/installer/src/manager-operation-store.ts",
  ]) {
    assert.throws(() => assertTweakersManagerBundleMetafile({
      inputs: { [input]: {} },
      outputs: { "/tmp/manager.mjs": { imports: [] } },
    }, "/tmp/manager.mjs"), /forbidden broad input/);
  }
});

function invoke(bundle: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env });
}
