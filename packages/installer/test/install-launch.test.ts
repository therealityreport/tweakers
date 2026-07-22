import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HEALTH_PROBE_TEMP_RELATIVE_PATH, spawnHiddenHealthProbe } from "../src/commands/install";

interface RecordedSpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnSyncOptions;
}

test("health probe launch requests background/hidden", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const executable = "/tmp/Codex.app/Contents/MacOS/Codex";
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-launch-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
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
  const containedTemp = join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH);
  assert.equal(call.options.env?.TMPDIR, containedTemp);
  assert.equal(lstatSync(containedTemp).mode & 0o777, 0o700);
  assert.equal(call.options.stdio, "ignore");
});

test("non-macOS health probes do not receive the macOS mock Keychain switch", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-linux-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe("/tmp/Codex", userRoot, {
    spawn: fakeSpawn,
    platform: "linux",
    environment: { TMPDIR: "/tmp/ambient-sentinel" },
  });

  assert.deepEqual(calls[0]?.args, [`--user-data-dir=${join(userRoot, "electron-user-data")}`]);
  assert.equal(calls[0]?.options.env?.TMPDIR, join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH));
});

test("candidate health probe passes only required runtime values and contained health variables", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-candidate-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const candidateCodexHome = `${userRoot}/codex-home`;
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
    candidateCodexHome,
    spawn: fakeSpawn,
    platform: "darwin",
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/Users/live-account",
      TMPDIR: "/private/tmp/live-session/",
      TEMP: "/private/tmp/ambient-temp",
      TMP: "/private/tmp/ambient-tmp",
      USER: "operator",
      LOGNAME: "operator",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
      OPENAI_API_KEY: "sentinel-openai-secret",
      AWS_SECRET_ACCESS_KEY: "sentinel-aws-secret",
      GITHUB_TOKEN: "sentinel-token",
      SSH_AUTH_SOCK: "/private/tmp/sentinel-auth-socket",
      NODE_OPTIONS: "--require=/private/tmp/sentinel-injection.cjs",
      TWEAKER_HOME: "/Users/live-account/.tweakers",
      TWEAKERS_HOME: "/Users/live-account/.tweakers",
      TWEAKER_USER_ROOT: "/Users/live-account/.tweakers",
      TWEAKERS_USER_ROOT: "/Users/live-account/.tweakers",
      CODEX_HOME: "/Users/live-account/.codex",
    },
  });

  assert.deepEqual(calls[0]?.options.env, {
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    HOME: userRoot,
    TMPDIR: join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH),
    USER: "operator",
    LOGNAME: "operator",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_USER_ROOT: userRoot,
    TWEAKERS_HEALTH_BACKGROUND: "1",
    TWEAKERS_CANDIDATE_MCP_RECONCILIATION: "1",
    CODEX_HOME: candidateCodexHome,
  });
});

test("post-promotion health probe excludes ambient credentials and Tweakers root aliases", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-live-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
    spawn: fakeSpawn,
    platform: "linux",
    environment: {
      PATH: "/usr/bin:/bin",
      HOME: "/home/operator",
      TMPDIR: "/tmp/ambient-sentinel",
      DISPLAY: ":0",
      XDG_RUNTIME_DIR: "/run/user/501",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
      CODEX_API_KEY: "sentinel-codex-secret",
      AUTH_TOKEN: "sentinel-auth-token",
      XAUTHORITY: "/home/operator/.Xauthority",
      KEYCHAIN_PASSWORD: "sentinel-keychain-secret",
      TWEAKERS_USER_ROOT: "/home/operator/.tweakers",
      CODEX_HOME: "/home/operator/.codex",
    },
  });

  assert.deepEqual(calls[0]?.options.env, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    TMPDIR: join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH),
    DISPLAY: ":0",
    XDG_RUNTIME_DIR: "/run/user/501",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_USER_ROOT: userRoot,
    TWEAKERS_HEALTH_BACKGROUND: "1",
  });
});

test("Windows health probe replaces ambient TEMP and TMP with its contained mode-0700 directory", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-windows-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const containedTemp = join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH);
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnHiddenHealthProbe("C:\\Codex.exe", userRoot, {
    spawn: fakeSpawn,
    platform: "win32",
    environment: {
      TEMP: "C:\\Users\\live\\Temp",
      TMP: "C:\\Users\\live\\Tmp",
      TMPDIR: "C:\\ambient-sentinel",
      USERPROFILE: "C:\\Users\\live",
      SystemRoot: "C:\\Windows",
      OPENAI_API_KEY: "sentinel-openai-secret",
      TWEAKER_HOME: "C:\\Users\\live\\.tweakers",
    },
  });

  chmodSync(containedTemp, 0o777);
  spawnHiddenHealthProbe("C:\\Codex.exe", userRoot, {
    spawn: fakeSpawn,
    platform: "win32",
    environment: { TEMP: "C:\\ambient-two", TMP: "C:\\ambient-two" },
  });

  assert.equal(calls[0]?.options.env?.TEMP, containedTemp);
  assert.equal(calls[0]?.options.env?.TMP, containedTemp);
  assert.equal(calls[0]?.options.env?.TMPDIR, undefined);
  assert.equal(calls[0]?.options.env?.OPENAI_API_KEY, undefined);
  assert.equal(calls[0]?.options.env?.TWEAKER_HOME, undefined);
  assert.equal(calls[1]?.options.env?.TEMP, containedTemp);
  assert.equal(lstatSync(containedTemp).mode & 0o777, 0o700);
});

test("health probe rejects a temp-directory symlink before spawning", (t) => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "tweakers-health-outside-"));
  t.after(() => {
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(userRoot, "health"), { mode: 0o700 });
  symlinkSync(outside, join(userRoot, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  let spawned = false;

  assert.throws(
    () => spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      spawn: (() => {
        spawned = true;
        return { status: 0 } as ReturnType<typeof spawnSync>;
      }) as typeof spawnSync,
      platform: "darwin",
    }),
    /Health probe temp directory must be a real directory/,
  );
  assert.equal(spawned, false);
});
