import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

interface LoaderResult {
  status: number | null;
  stderr: string;
  originalLoaded: boolean;
  liveRuntimeLoaded: boolean;
  healthRuntimeLoaded: boolean;
}

function runLoader(environment: NodeJS.ProcessEnv): LoaderResult {
  const root = mkdtempSync(join(tmpdir(), "tweakers-loader-health-"));
  try {
    const app = join(root, "app");
    const liveUser = join(root, "live-user");
    const healthUser = join(root, "health-user");
    mkdirSync(app, { recursive: true });
    mkdirSync(join(liveUser, "runtime"), { recursive: true });
    mkdirSync(join(healthUser, "runtime"), { recursive: true });
    cpSync(resolve("packages/loader/loader.cjs"), join(app, "loader.cjs"));
    writeFileSync(join(app, "package.json"), JSON.stringify({
      __tweaker: { originalMain: "original.cjs", userRoot: liveUser },
    }));
    writeFileSync(join(app, "original.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "original-loaded"))}, "yes")`);
    writeFileSync(join(liveUser, "runtime", "main.js"), `
      if (process.env.TWEAKERS_TEST_THROW_LIVE_RUNTIME === "1") throw new Error("live runtime failed");
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
    delete env.TWEAKERS_TEST_THROW_HEALTH_RUNTIME;
    delete env.TWEAKERS_TEST_THROW_LIVE_RUNTIME;
    Object.assign(env, environment);
    if (environment.TWEAKERS_HEALTH_USER_ROOT === "<health-user>") {
      env.TWEAKERS_HEALTH_USER_ROOT = healthUser;
    } else if (environment.TWEAKERS_HEALTH_USER_ROOT === "<symlink-health-user>") {
      const linkedHealthUser = join(root, "linked-health-user");
      symlinkSync(healthUser, linkedHealthUser);
      env.TWEAKERS_HEALTH_USER_ROOT = linkedHealthUser;
    }
    const result = spawnSync(process.execPath, [join(app, "loader.cjs")], { env });
    return {
      status: result.status,
      stderr: result.stderr.toString(),
      originalLoaded: existsSync(join(root, "original-loaded")),
      liveRuntimeLoaded: existsSync(join(root, "live-runtime-loaded")),
      healthRuntimeLoaded: existsSync(join(root, "health-runtime-loaded")),
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

test("normal mode still starts original main when the live runtime throws", () => {
  const result = runLoader({ TWEAKERS_TEST_THROW_LIVE_RUNTIME: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.liveRuntimeLoaded, false);
  assert.equal(result.healthRuntimeLoaded, false);
  assert.equal(result.originalLoaded, true);
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
