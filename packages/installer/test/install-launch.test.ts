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

  spawnHiddenHealthProbe(executable, userRoot, { spawn: fakeSpawn });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.command, executable);
  assert.deepEqual(call.args, [`--user-data-dir=${join(userRoot, "electron-user-data")}`]);
  assert.equal(call.options.env?.TWEAKERS_HEALTH_CHECK_ONLY, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_BACKGROUND, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_USER_ROOT, userRoot);
  assert.equal(call.options.stdio, "ignore");
});
