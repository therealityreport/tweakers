import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { spawnHiddenHealthProbe } from "../src/commands/install";

interface RecordedSpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnSyncOptions;
}

test("health probe launch requests background/hidden", () => {
  const calls: RecordedSpawnCall[] = [];
  const executable = "/tmp/Codex.app/Contents/MacOS/Codex";
  const userRoot = "/tmp/tweakers-candidate-user";
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe(executable, userRoot, { spawn: fakeSpawn, platform: "darwin" });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, executable);
  assert.deepEqual(call.args, [
    `--user-data-dir=${join(userRoot, "electron-user-data")}`,
    "--use-mock-keychain",
  ]);
  assert.equal(call.options.env?.TWEAKERS_HEALTH_CHECK_ONLY, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_BACKGROUND, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_USER_ROOT, userRoot);
  assert.equal(call.options.stdio, "ignore");
});

test("non-macOS health probes do not receive the macOS mock Keychain switch", () => {
  const calls: RecordedSpawnCall[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe("/tmp/Codex", "/tmp/tweakers-candidate-user", {
    spawn: fakeSpawn,
    platform: "linux",
  });

  assert.deepEqual(calls[0]?.args, ["--user-data-dir=/tmp/tweakers-candidate-user/electron-user-data"]);
});
