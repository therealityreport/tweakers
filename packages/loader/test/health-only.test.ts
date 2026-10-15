import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface LoaderResult {
  status: number | null;
  stderr: string;
  originalLoaded: boolean;
  backendBound: boolean;
  acceptanceBound: boolean;
  liveRuntimeLoaded: boolean;
  healthRuntimeLoaded: boolean;
  recovery: { title: string; message: string } | null;
  overlayNotice: { title: string; message: string; detail: string } | null;
}

function runLoader(environment: NodeJS.ProcessEnv): LoaderResult {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-loader-health-")));
  try {
    const app = join(root, "app");
    const liveUser = join(root, "live-user");
    const healthUser = join(root, "health-user");
    mkdirSync(app, { recursive: true });
    const resources = join(root, "resources");
    mkdirSync(resources);
    const cliLayout = environment.TWEAKERS_TEST_NEW_CLI_LAYOUT;
    const nestedBackend = join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
    if (cliLayout) {
      mkdirSync(join(resources, "codex-cli", "CodexCLI.app", "Contents", "MacOS"), { recursive: true });
      writeFileSync(nestedBackend, "stock");
      if (cliLayout === "1") writeFileSync(join(resources, "codex"), "registered");
      if (cliLayout === "unsafe-flat") symlinkSync(nestedBackend, join(resources, "codex"));
      if (cliLayout === "unsafe-nested") {
        const outside = join(root, "outside-backend");
        writeFileSync(outside, "outside");
        rmSync(nestedBackend);
        symlinkSync(outside, nestedBackend);
      }
      if (cliLayout === "dangling-nested" || cliLayout === "missing") {
        rmSync(nestedBackend);
        if (cliLayout === "dangling-nested") symlinkSync(join(root, "missing-outside-backend"), nestedBackend);
      }
    }
    else writeFileSync(join(resources, "codex"), "registered");
    mkdirSync(join(app, "node_modules", "electron"), { recursive: true });
    mkdirSync(join(liveUser, "runtime"), { recursive: true });
    mkdirSync(join(healthUser, "runtime"), { recursive: true });
    const acceptanceDirectory = join(liveUser, "acceptance", "12345678-1234-1234-1234-123456789abc");
    mkdirSync(join(liveUser, "acceptance"), { mode: 0o700 });
    mkdirSync(acceptanceDirectory, { mode: 0o700 });
    const acceptancePath = join(acceptanceDirectory, "config.json");
    writeFileSync(acceptancePath, "{}", { mode: 0o600 });
    cpSync(resolve("packages/loader/loader.cjs"), join(app, "loader.cjs"));
    writeFileSync(join(app, "package.json"), JSON.stringify({
      productName: environment.TWEAKERS_TEST_PRODUCT_NAME ?? "ChatGPT",
      __tweaker: { originalMain: "original.cjs", userRoot: liveUser },
    }));
    const expectedBackend = cliLayout === "nested" ? nestedBackend : join(resources, "codex");
    writeFileSync(join(app, "original.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "original-loaded"))}, "yes"); const binding=Object.getOwnPropertyDescriptor(globalThis,"__tweakersVerifiedBackendPathV1"); if(process.env.CODEX_CLI_PATH===${JSON.stringify(expectedBackend)} && binding?.value===process.env.CODEX_CLI_PATH && binding.writable===false && binding.configurable===false) require("node:fs").writeFileSync(${JSON.stringify(join(root, "backend-bound"))},"yes");`);
    writeFileSync(join(app, "node_modules", "electron", "index.js"), `
      const fs = require("node:fs");
      module.exports = {
        app: {
          setPath() {},
          isReady() { return false; },
          whenReady() { return Promise.resolve(); },
          exit(code) { process.exitCode = code; },
        },
        dialog: {
          showErrorBox(title, message) {
            fs.writeFileSync(${JSON.stringify(join(root, "recovery.json"))}, JSON.stringify({ title, message }));
          },
          showMessageBox(options) {
            fs.writeFileSync(${JSON.stringify(join(root, "overlay-notice.json"))}, JSON.stringify(options));
            return Promise.resolve({ response: 0 });
          },
        },
      };
    `);
    writeFileSync(join(liveUser, "runtime", "main.js"), `
      process.resourcesPath = ${JSON.stringify(resources)};
      if (process.env.TWEAKERS_TEST_THROW_LIVE_RUNTIME === "1") throw new Error("live runtime failed");
      if (process.env.TWEAKERS_ACCEPTANCE_CONFIG_FILE === ${JSON.stringify(acceptancePath)} && process.env.TWEAKERS_USER_ROOT === ${JSON.stringify(liveUser)}) require("node:fs").writeFileSync(${JSON.stringify(join(root, "acceptance-bound"))}, "yes");
      require("node:fs").writeFileSync(${JSON.stringify(join(root, "live-runtime-loaded"))}, "yes");
    `);
    writeFileSync(join(healthUser, "runtime", "main.js"), `
      if (process.env.TWEAKERS_TEST_THROW_HEALTH_RUNTIME === "1") throw new Error("health runtime failed");
      require("node:fs").writeFileSync(${JSON.stringify(join(root, "health-runtime-loaded"))}, "yes");
    `);

    const env = { ...process.env };
    delete env.TWEAKERS_HEALTH_CHECK_ONLY;
    delete env.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN;
    delete env.TWEAKERS_HEALTH_USER_ROOT;
    delete env.TWEAKERS_ACCEPTANCE_CONFIG_FILE;
    delete env.TWEAKERS_TEST_THROW_HEALTH_RUNTIME;
    delete env.TWEAKERS_TEST_THROW_LIVE_RUNTIME;
    Object.assign(env, environment);
    if (["<acceptance-config>", "<public-acceptance-config>", "<symlink-acceptance-config>"].includes(environment.TWEAKERS_ACCEPTANCE_CONFIG_FILE ?? "")) {
      env.TWEAKERS_ACCEPTANCE_CONFIG_FILE = acceptancePath;
      if (environment.TWEAKERS_ACCEPTANCE_CONFIG_FILE === "<public-acceptance-config>") chmodSync(acceptancePath, 0o644);
      if (environment.TWEAKERS_ACCEPTANCE_CONFIG_FILE === "<symlink-acceptance-config>") {
        rmSync(acceptancePath);
        symlinkSync(join(liveUser, "runtime", "main.js"), acceptancePath);
      }
    }
    if (environment.TWEAKERS_HEALTH_USER_ROOT === "<health-user>") {
      env.TWEAKERS_HEALTH_USER_ROOT = healthUser;
    } else if (environment.TWEAKERS_HEALTH_USER_ROOT === "<symlink-health-user>") {
      const linkedHealthUser = join(root, "linked-health-user");
      symlinkSync(healthUser, linkedHealthUser);
      env.TWEAKERS_HEALTH_USER_ROOT = linkedHealthUser;
    }
    const result = spawnSync(process.execPath, [join(app, "loader.cjs")], { env });
    const recoveryPath = join(root, "recovery.json");
    const overlayNoticePath = join(root, "overlay-notice.json");
    return {
      status: result.status,
      stderr: result.stderr.toString(),
      originalLoaded: existsSync(join(root, "original-loaded")),
      backendBound: existsSync(join(root, "backend-bound")),
      acceptanceBound: existsSync(join(root, "acceptance-bound")),
      liveRuntimeLoaded: existsSync(join(root, "live-runtime-loaded")),
      healthRuntimeLoaded: existsSync(join(root, "health-runtime-loaded")),
      recovery: existsSync(recoveryPath)
        ? JSON.parse(readFileSync(recoveryPath, "utf8")) as { title: string; message: string }
        : null,
      overlayNotice: existsSync(overlayNoticePath)
        ? JSON.parse(readFileSync(overlayNoticePath, "utf8")) as { title: string; message: string; detail: string }
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("normal loader starts the live runtime and original main", () => {
  const result = runLoader({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, true);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, true);
});

test("supplied-native nested-only backend reaches original main with an immutable backend binding", () => {
  const result = runLoader({ TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_TEST_NEW_CLI_LAYOUT: "nested" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.originalLoaded, true);
  assert.equal(result.backendBound, true);
  assert.equal(result.recovery, null);
});

test("nested backend binding rejects linked executables instead of starting original main", () => {
  for (const layout of ["unsafe-flat", "unsafe-nested", "dangling-nested", "missing"]) {
    const result = runLoader({ TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_TEST_NEW_CLI_LAYOUT: layout });
    assert.notEqual(result.status, 0);
    assert.equal(result.originalLoaded, false);
    assert.equal(result.backendBound, false);
    assert.match(result.stderr, /registered backend is unavailable/);
  }
});

test("acceptance settings are bound to packaged user root in one normal Tweakers launch", () => {
  const result = runLoader({ TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_ACCEPTANCE_CONFIG_FILE: "<acceptance-config>", TWEAKERS_USER_ROOT: "/caller-selected-root" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.acceptanceBound, true);
  assert.equal(result.originalLoaded, true);
});

test("acceptance override refuses native, health, public, symlink and outside-root launches", () => {
  for (const environment of [
    { TWEAKERS_ACCEPTANCE_CONFIG_FILE: "<acceptance-config>" },
    { TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_HEALTH_CHECK_ONLY: "1", TWEAKERS_HEALTH_USER_ROOT: "<health-user>", TWEAKERS_ACCEPTANCE_CONFIG_FILE: "<acceptance-config>" },
    ...["", "<public-acceptance-config>", "<symlink-acceptance-config>", "/tmp/config.json"].map(path => ({ TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_ACCEPTANCE_CONFIG_FILE: path })),
  ]) {
    const result = runLoader(environment);
    assert.notEqual(result.status, 0);
    assert.equal(result.originalLoaded, false);
    assert.equal(result.liveRuntimeLoaded, false);
    assert.equal(result.healthRuntimeLoaded, false);
  }
});

test("bare health loader starts the contained runtime without original main", () => {
  const result = runLoader({
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_USER_ROOT: "<health-user>",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, true);
  assert.equal(result.originalLoaded, false);
});

test("paired health flags start the contained runtime and original main", () => {
  const result = runLoader({
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: "<health-user>",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, true);
  assert.equal(result.originalLoaded, true);
});

test("paired health mode does not start original main when the contained runtime throws", () => {
  const result = runLoader({
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: "<health-user>",
    TWEAKERS_TEST_THROW_HEALTH_RUNTIME: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, false);
});

test("normal ChatGPT mode still starts original main when the live runtime throws", () => {
  const result = runLoader({ TWEAKERS_TEST_THROW_LIVE_RUNTIME: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, true);
  assert.equal(result.recovery, null);
  assert.equal(result.overlayNotice?.title, "Tweakers overlay unavailable");
  assert.match(result.overlayNotice?.message ?? "", /without Tweakers customizations/);
  assert.doesNotMatch(result.overlayNotice?.detail ?? "", /live runtime failed/);
});

test("independent Tweakers mode fails closed when the live runtime throws", () => {
  const result = runLoader({
    TWEAKERS_TEST_PRODUCT_NAME: "Tweakers",
    TWEAKERS_TEST_THROW_LIVE_RUNTIME: "1",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.originalLoaded, false);
  assert.match(result.stderr, /independent Tweakers launch refused/);
  assert.deepEqual(result.recovery?.title, "Tweakers failed to start");
  assert.match(result.recovery?.message ?? "", /ordinary ChatGPT interface was not opened/);
  assert.doesNotMatch(result.recovery?.message ?? "", /live runtime failed/);
  assert.equal(result.overlayNotice, null);
});

test("run-original flag without health mode fails closed", () => {
  const result = runLoader({ TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.originalLoaded, false);
});

test("paired health flags with a relative health root fail closed", () => {
  const result = runLoader({
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: "relative-health-root",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, false);
});

test("paired health flags with a symlinked health root fail closed", () => {
  const result = runLoader({
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: "<symlink-health-user>",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, false);
});


test("current-layout derived startup selects the registered backend before vendor imports", () => {
  const derived = runLoader({ TWEAKERS_TEST_PRODUCT_NAME: "Tweakers", TWEAKERS_TEST_NEW_CLI_LAYOUT: "1" });
  assert.equal(derived.status, 0, derived.stderr);
  assert.equal(derived.backendBound, true);
  const native = runLoader({ TWEAKERS_TEST_NEW_CLI_LAYOUT: "1" });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(native.backendBound, false);
});
