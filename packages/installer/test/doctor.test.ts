import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctor } from "../src/commands/doctor";
import {
  createEnvironmentSelection,
  defaultEnvironmentProfileRegistry,
  writeEnvironmentProfileRegistry,
} from "../src/environment-profile";

/**
 * Doctor must surface selection/registry drift: the state that breaks every
 * environment command while the app itself stays healthy (2026-07-22 incident:
 * a manually finalized selection left the registry `selected` stale and only
 * `environment status` — not doctor — reported the failure).
 */
async function doctorOutput(root: string, options: Parameters<typeof doctor>[0] = {}): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  const originalHome = process.env.TWEAKERS_HOME;
  process.env.TWEAKERS_HOME = root;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    await doctor(options);
  } finally {
    console.log = original;
    if (originalHome === undefined) delete process.env.TWEAKERS_HOME;
    else process.env.TWEAKERS_HOME = originalHome;
    // doctor() flags failed checks via process.exitCode; the fixtures here
    // intentionally fail unrelated checks (missing app), so keep the test
    // process's own exit status clean.
    process.exitCode = 0;
  }
  return lines.join("\n");
}

test("doctor fails the environment consistency check when the selection drifts from the registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-drift-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "tweakers", appRoot: join(root, "missing.app") }));
    const registry = defaultEnvironmentProfileRegistry(root);
    registry.selected = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "chatgpt",
      requestedAt: "2026-07-22T15:57:00.000Z",
      appliedAt: "2026-07-22T15:57:00.000Z",
    });
    writeEnvironmentProfileRegistry(join(root, "environment-registry.json"), registry);
    const driftedSelection = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-22T16:18:00.000Z",
      appliedAt: "2026-07-22T16:18:00.000Z",
    });
    writeFileSync(join(root, "environment-selection.json"), `${JSON.stringify(driftedSelection)}\n`);

    const output = await doctorOutput(root);
    assert.match(output, /environment consistency/);
    assert.match(output, /does not match the profile registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor passes the environment consistency check when the pair agrees", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-consistent-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "tweakers", appRoot: join(root, "missing.app") }));
    const registry = defaultEnvironmentProfileRegistry(root);
    const selection = createEnvironmentSelection({
      profile: registry.profiles.stable,
      appExperience: "tweakers",
      requestedAt: "2026-07-22T16:18:00.000Z",
      appliedAt: "2026-07-22T16:18:00.000Z",
    });
    registry.selected = selection;
    registry.lastKnownWorkingSelection = selection;
    writeEnvironmentProfileRegistry(join(root, "environment-registry.json"), registry);
    writeFileSync(join(root, "environment-selection.json"), `${JSON.stringify(selection)}\n`);

    const output = await doctorOutput(root);
    assert.match(output, /environment consistency/);
    assert.match(output, /selection matches the profile registry/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctor reports the default-off sealed pair as unavailable without creating its cache root", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-doctor-cache-observe-"));
  try {
    writeFileSync(join(root, "state.json"), JSON.stringify({ mode: "chatgpt", appRoot: join(root, "missing.app") }));

    const output = await doctorOutput(root, { json: true });

    const report = JSON.parse(output) as { checks: Array<{ name: string; status: string; detail: string }> };
    const cacheCheck = report.checks.find((check) => check.name === "environment mode cache");
    assert.deepEqual(cacheCheck, {
      name: "environment mode cache",
      status: "ok",
      detail: "unavailable; no generation; no environment mode cache has been published",
    });
    assert.equal(existsSync(join(root, "environment-cache")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
