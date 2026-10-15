import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER,
  MANAGER_RUNTIME_FINGERPRINT_MARKER,
  assertTweakersManagerBundleMetafile,
  buildTweakersManagerBundle,
  readPackagedManagedRuntimeFingerprint,
} from "../scripts/build-manager.mjs";
import { writeManagedRuntimeFingerprint } from "../scripts/copy-assets.mjs";

const REQUEST_ID = "018f0d36-4c08-7a3e-9c1d-123456789abc";

test("production manager bundle is standalone and exposes only fixed manager actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-bundle-"));
  const outfile = join(root, "manager.mjs");
  try {
    const built = await buildTweakersManagerBundle({
      outfile,
      runtimeFingerprint: "a".repeat(64),
      managedRuntimeFingerprint: "b".repeat(64),
      logLevel: "silent",
    });
    assert.equal(existsSync(outfile), true);
    const imports = Object.values(built.metafile.outputs).flatMap((output) => output.imports ?? []);
    assert.equal(imports.every((entry) => entry.external === true), true);
    const inputs = Object.keys(built.metafile.inputs ?? {});
    assert.equal(inputs.some((input) => /(?:^|\/)src\/cli\.ts$/.test(input)), false);

    const bytes = readFileSync(outfile, "utf8");
    assert.doesNotMatch(bytes, /[\t ]+$/m, "generated manager bundle must pass git diff --check");
    assert.match(bytes, new RegExp(`//# ${MANAGER_RUNTIME_FINGERPRINT_MARKER}=[a-f0-9]{64}\\n//# ${MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER}=[a-f0-9]{64}\\n$`));
    assert.equal(bytes.includes("refresh.full"), false, "the retired generic refresh action must not be bundled");

    const imported = await import(pathToFileURL(outfile).href);
    assert.equal(typeof imported.prepareNativeHistoryActivationContext, "function",
      "authorized activation preparation must survive bundle tree shaking");
    assert.equal(typeof imported.armNativeHistoryActivationLaunchAgent, "function");
    assert.equal(typeof imported.reserveClosedIndependentTweakersCutover, "function",
      "baseline maintenance must reuse the sealed production cutover guard");
    assert.equal(typeof imported.prepareManagedAccountContinuityPrelaunch, "function",
      "baseline maintenance must retain the sealed account continuity preflight");
    assert.equal(typeof imported.prepareDeferredTweakersVariantRefresh, "function",
      "baseline maintenance promotion must execute with sealed runtime assets");
    await assert.rejects(() => imported.prepareDeferredTweakersVariantRefresh({}),
      /requires a manager operation ID/);
    assert.equal(typeof imported.withLocalOperation, "function",
      "sealed promotion and its operator must share operation ownership");
    const operationRoot = join(root, "operator-ownership");
    const ownedResult = await imported.withLocalOperation("sealed operator regression", () =>
      imported.withLocalOperation("nested sealed refresh regression", async () => "same owner", operationRoot), operationRoot);
    assert.equal(ownedResult, "same owner");
    assert.equal(JSON.parse(readFileSync(join(operationRoot, "operation.json"), "utf8")).state, "completed");
    assert.throws(() => imported.prepareNativeHistoryActivationContext({
      operationId: REQUEST_ID, approvedAt: "not-an-approval-time",
    }), /approval time must be RFC3339/);

    const environment = {
      HOME: process.env.HOME ?? "",
      TWEAKER_HOME: join(root, "missing-status-root"),
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C",
    };
    const status = invoke(outfile, ["status", "--request-id", REQUEST_ID, "--json"], environment);
    assert.equal(status.status, 0, status.stderr);
    const response: unknown = JSON.parse(status.stdout);
    if (!isRecord(response)) assert.fail("manager status must return an object");
    assert.equal(response.requestId, REQUEST_ID);
    assert.equal(response.managerId, "com.thomashulihan.tweakers");
    const actions = response.actions;
    assert.equal(Array.isArray(actions), true);
    if (!Array.isArray(actions)) assert.fail("manager status must return an actions array");
    assert.equal(actions.every((action) => isUnavailableAction(action)), true);
    assert.deepEqual(
      actions.map((action) => action.actionId),
      ["refresh.injected", "refresh.independent"],
    );
    assert.equal(existsSync(environment.TWEAKER_HOME), false, "status must not create the missing user root");
    const operatorOnly = invoke(outfile, ["reserveClosedIndependentTweakersCutover", "--request-id", REQUEST_ID, "--json"], environment);
    assert.equal(operatorOnly.status, 64);
    assert.equal((JSON.parse(operatorOnly.stdout) as { error: { code: string } }).error.code, "unsupported_action",
      "the operator export must not add a public launcher command");
    const deferredOperatorOnly = invoke(outfile, ["prepareDeferredTweakersVariantRefresh", "--request-id", REQUEST_ID, "--json"], environment);
    assert.equal(deferredOperatorOnly.status, 64);
    assert.equal((JSON.parse(deferredOperatorOnly.stdout) as { error: { code: string } }).error.code, "unsupported_action",
      "sealed deferred refresh must remain unavailable as a public launcher command");
    const ownershipOperatorOnly = invoke(outfile, ["withLocalOperation", "--request-id", REQUEST_ID, "--json"], environment);
    assert.equal(ownershipOperatorOnly.status, 64);
    assert.equal((JSON.parse(ownershipOperatorOnly.stdout) as { error: { code: string } }).error.code, "unsupported_action");

    for (const argv of [
      ["prepare", "--request-id", REQUEST_ID, "--json"],
      ["execute", "--request-id", REQUEST_ID, "--json"],
      ["cancel", "--request-id", REQUEST_ID, "--json"],
      ["status", "--request-id", REQUEST_ID, "--json", "extra"],
    ]) {
      const rejected = invoke(outfile, argv, environment);
      assert.equal(rejected.status, 64, `${argv.join(" ")}: ${rejected.stderr}`);
      assert.equal((JSON.parse(rejected.stdout) as { error: { code: string } }).error.code, "invalid_request");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap manager bundle is explicitly unsealed and final builds stay strict", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-bootstrap-"));
  const outfile = join(root, "manager.mjs");
  try {
    await buildTweakersManagerBundle({
      outfile,
      runtimeFingerprint: "a".repeat(64),
      bootstrap: true,
      logLevel: "silent",
    });
    const bytes = readFileSync(outfile, "utf8");
    assert.match(bytes, new RegExp(`//# ${MANAGER_RUNTIME_FINGERPRINT_MARKER}=a{64}\\n$`));
    assert.doesNotMatch(bytes, new RegExp(`//# ${MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER}=`));

    await assert.rejects(
      () => buildTweakersManagerBundle({
        outfile,
        runtimeFingerprint: "a".repeat(64),
        managedRuntimeFingerprint: "not-a-fingerprint",
        logLevel: "silent",
      }),
      /requires one valid packaged managed-runtime fingerprint/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("final manager receipt binding rejects malformed and stale managed-runtime receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-manager-receipt-"));
  const managedRuntime = join(root, "managed-runtime");
  const receiptPath = join(managedRuntime, "managed-runtime-fingerprint.json");
  try {
    mkdirSync(managedRuntime, { recursive: true });
    assert.throws(() => readPackagedManagedRuntimeFingerprint(receiptPath), /could not read the packaged managed-runtime fingerprint/);
    writeFileSync(join(managedRuntime, "package.json"), "{}\n");
    const receipt = writeManagedRuntimeFingerprint(managedRuntime);
    assert.equal(readPackagedManagedRuntimeFingerprint(receiptPath), receipt.fingerprint);

    writeFileSync(join(managedRuntime, "package.json"), "{\"changed\":true}\n");
    assert.throws(() => readPackagedManagedRuntimeFingerprint(receiptPath), /fingerprint is stale/);

    writeFileSync(receiptPath, "{}\n");
    assert.throws(() => readPackagedManagedRuntimeFingerprint(receiptPath), /fingerprint is malformed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager bundle metafile rejects non-Node externals and the general installer CLI", () => {
  assert.throws(() => assertTweakersManagerBundleMetafile({
    outputs: { "/tmp/manager.mjs": { imports: [{ path: "kleur", external: true }] } },
  }, "/tmp/manager.mjs"), /forbidden non-Node external/);

  assert.throws(() => assertTweakersManagerBundleMetafile({
    inputs: { "/workspace/packages/installer/src/cli.ts": {} },
    outputs: { "/tmp/manager.mjs": { imports: [] } },
  }, "/tmp/manager.mjs"), /forbidden broad input/);
});

function invoke(bundle: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [bundle, ...args], { encoding: "utf8", env });
}

function isUnavailableAction(value: unknown): value is { actionId: string; available: false } {
  return isRecord(value)
    && typeof value.actionId === "string"
    && value.available === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
