import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH,
  HEALTH_PROBE_PROCESS_TIMEOUT_MS,
  HEALTH_PROBE_ROOT_PREFIX,
  HEALTH_PROBE_TEMP_RELATIVE_PATH,
  HEALTH_PROBE_USER_DATA_RELATIVE_PATH,
  spawnAuthenticatedHiddenHealthProbe,
  spawnHiddenHealthProbe,
} from "../src/commands/install";

interface RecordedSpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnSyncOptions;
}

function retainedProbeRoots(userRoot: string): string[] {
  const healthRoot = join(userRoot, "health");
  return existsSync(healthRoot)
    ? readdirSync(healthRoot).filter((name) => name.startsWith(HEALTH_PROBE_ROOT_PREFIX))
    : [];
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
  const probeRoot = call.options.env?.HOME;
  assert.equal(typeof probeRoot, "string");
  assert.equal(join(userRoot, "health"), probeRoot!.slice(0, probeRoot!.lastIndexOf("/")));
  assert.equal(lstatSync(join(userRoot, "health")).mode & 0o777, 0o700);
  assert.equal(call.command, executable);
  assert.deepEqual(call.args, [
    `--user-data-dir=${join(probeRoot!, HEALTH_PROBE_USER_DATA_RELATIVE_PATH)}`,
    "--use-mock-keychain",
  ]);
  assert.equal(call.options.env?.TWEAKERS_HEALTH_CHECK_ONLY, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_BACKGROUND, "1");
  assert.equal(call.options.env?.TWEAKERS_HEALTH_USER_ROOT, userRoot);
  assert.equal(call.options.env?.TWEAKERS_CANDIDATE_MCP_RECONCILIATION, "1");
  assert.equal(call.options.env?.CODEX_HOME, join(probeRoot!, HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH));
  assert.equal(call.options.env?.TMPDIR, join(probeRoot!, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  assert.equal(call.options.stdio, "ignore");
  assert.equal(call.options.timeout, HEALTH_PROBE_PROCESS_TIMEOUT_MS);
  assert.equal(existsSync(probeRoot!), false);
  assert.deepEqual(retainedProbeRoots(userRoot), []);
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

  const probeRoot = calls[0]?.options.env?.HOME;
  assert.equal(typeof probeRoot, "string");
  assert.deepEqual(calls[0]?.args, [`--user-data-dir=${join(probeRoot!, HEALTH_PROBE_USER_DATA_RELATIVE_PATH)}`]);
  assert.equal(calls[0]?.options.env?.TMPDIR, join(probeRoot!, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  assert.equal(existsSync(probeRoot!), false);
});

test("candidate health probe passes only required runtime values and contained health variables", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-candidate-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const candidateCodexHome = `${userRoot}/codex-home-source`;
  mkdirSync(candidateCodexHome, { mode: 0o700 });
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

  const probeRoot = calls[0]?.options.env?.HOME;
  assert.equal(typeof probeRoot, "string");
  assert.deepEqual(calls[0]?.options.env, {
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    HOME: probeRoot,
    TMPDIR: join(probeRoot!, HEALTH_PROBE_TEMP_RELATIVE_PATH),
    USER: "operator",
    LOGNAME: "operator",
    __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0",
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: userRoot,
    TWEAKERS_HEALTH_BACKGROUND: "1",
    TWEAKERS_CANDIDATE_MCP_RECONCILIATION: "1",
    CODEX_HOME: join(probeRoot!, HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH),
  });
  assert.equal(existsSync(probeRoot!), false);
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

  const probeRoot = calls[0]?.options.env?.HOME;
  assert.equal(typeof probeRoot, "string");
  assert.deepEqual(calls[0]?.options.env, {
    PATH: "/usr/bin:/bin",
    HOME: probeRoot,
    TMPDIR: join(probeRoot!, HEALTH_PROBE_TEMP_RELATIVE_PATH),
    DISPLAY: ":0",
    XDG_RUNTIME_DIR: "/run/user/501",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/501/bus",
    TWEAKERS_HEALTH_CHECK_ONLY: "1",
    TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN: "1",
    TWEAKERS_HEALTH_USER_ROOT: userRoot,
    TWEAKERS_HEALTH_BACKGROUND: "1",
    TWEAKERS_CANDIDATE_MCP_RECONCILIATION: "1",
    CODEX_HOME: join(probeRoot!, HEALTH_PROBE_CODEX_HOME_RELATIVE_PATH),
  });
  assert.equal(existsSync(probeRoot!), false);
});

test("authenticated health probe stages mode-0600 auth only for the synchronous contained launch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-health-auth-"));
  const userRoot = join(root, "user");
  const liveCodexHome = join(root, "live-codex-home");
  mkdirSync(userRoot, { mode: 0o700 });
  mkdirSync(liveCodexHome, { mode: 0o700 });
  writeFileSync(join(liveCodexHome, "auth.json"), "{\"fixture\":true}\n", { mode: 0o600 });
  writeFileSync(join(liveCodexHome, "config.toml"), "model = \"fixture\"\n", { mode: 0o600 });
  writeFileSync(join(liveCodexHome, ".codex-global-state.json"), "{\"approval_policy\":\"never\"}\n", { mode: 0o600 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let observedAuth = false;
  let observedProbeRoot = "";
  const fakeSpawn = ((_command: string, _args: readonly string[], options: SpawnSyncOptions) => {
    const codexHome = options.env?.CODEX_HOME;
    assert.equal(typeof codexHome, "string");
    observedProbeRoot = options.env?.HOME ?? "";
    assert.equal(lstatSync(observedProbeRoot).mode & 0o777, 0o700);
    assert.equal(lstatSync(codexHome!).mode & 0o777, 0o700);
    assert.equal(lstatSync(options.env?.TMPDIR!).mode & 0o777, 0o700);
    const userDataRoot = (_args[0] as string).slice("--user-data-dir=".length);
    assert.equal(lstatSync(userDataRoot).mode & 0o777, 0o700);
    const auth = join(codexHome!, "auth.json");
    observedAuth = existsSync(auth);
    assert.equal(lstatSync(auth).mode & 0o777, 0o600);
    assert.equal(readFileSync(auth, "utf8"), "{\"fixture\":true}\n");
    assert.equal(readFileSync(join(codexHome!, "config.toml"), "utf8"), "model = \"fixture\"\n");
    assert.equal(
      readFileSync(join(codexHome!, ".codex-global-state.json"), "utf8"),
      "{\"approval_policy\":\"never\"}\n",
    );
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  spawnAuthenticatedHiddenHealthProbe("/private/tmp/Codex", userRoot, liveCodexHome, {
    spawn: fakeSpawn,
    platform: "darwin",
    environment: { HOME: "/Users/ambient", CODEX_HOME: "/Users/ambient/.codex" },
  });

  assert.equal(observedAuth, true);
  assert.equal(existsSync(observedProbeRoot), false);
  assert.deepEqual(retainedProbeRoots(userRoot), []);
});

test("Windows health probe replaces ambient TEMP and TMP with its contained mode-0700 directory", (t) => {
  const calls: RecordedSpawnCall[] = [];
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-windows-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  const observedProbeRoots: string[] = [];
  const observedTempModes: number[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: SpawnSyncOptions) => {
    calls.push({ command, args, options });
    observedProbeRoots.push(options.env?.USERPROFILE ?? "");
    observedTempModes.push(lstatSync(options.env?.TEMP!).mode & 0o777);
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

  spawnHiddenHealthProbe("C:\\Codex.exe", userRoot, {
    spawn: fakeSpawn,
    platform: "win32",
    environment: { TEMP: "C:\\ambient-two", TMP: "C:\\ambient-two" },
  });

  assert.equal(calls[0]?.options.env?.TEMP, join(observedProbeRoots[0]!, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  assert.equal(calls[0]?.options.env?.TMP, join(observedProbeRoots[0]!, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  assert.equal(calls[0]?.options.env?.TMPDIR, undefined);
  assert.equal(calls[0]?.options.env?.OPENAI_API_KEY, undefined);
  assert.equal(calls[0]?.options.env?.TWEAKER_HOME, undefined);
  assert.equal(calls[1]?.options.env?.TEMP, join(observedProbeRoots[1]!, HEALTH_PROBE_TEMP_RELATIVE_PATH));
  assert.notEqual(observedProbeRoots[0], observedProbeRoots[1]);
  assert.deepEqual(observedTempModes, [0o700, 0o700]);
  assert.equal(existsSync(observedProbeRoots[0]!), false);
  assert.equal(existsSync(observedProbeRoots[1]!), false);
  assert.deepEqual(retainedProbeRoots(userRoot), []);
});

test("health probe rejects a symlinked receipt directory before spawning", (t) => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "tweakers-health-outside-"));
  t.after(() => {
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  symlinkSync(outside, join(userRoot, "health"));
  let spawned = false;

  assert.throws(
    () => spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      spawn: (() => {
        spawned = true;
        return { status: 0 } as ReturnType<typeof spawnSync>;
      }) as typeof spawnSync,
      platform: "darwin",
    }),
    /Health probe receipt directory must be a real directory/,
  );
  assert.equal(spawned, false);
});

test("health probe rejects Codex homes outside the user root or through a symlink", (t) => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-codex-home-"));
  const outside = mkdtempSync(join(tmpdir(), "tweakers-health-codex-outside-"));
  t.after(() => {
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  let spawned = false;
  const fakeSpawn = (() => {
    spawned = true;
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;

  assert.throws(
    () => spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      candidateCodexHome: outside,
      spawn: fakeSpawn,
      platform: "darwin",
    }),
    /candidate Codex home must be contained by its user root/,
  );
  const linkedHome = join(userRoot, "linked-codex-home");
  symlinkSync(outside, linkedHome);
  assert.throws(
    () => spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      candidateCodexHome: linkedHome,
      spawn: fakeSpawn,
      platform: "darwin",
    }),
    /candidate Codex home must be a real directory/,
  );
  assert.equal(spawned, false);
});

test("health probe cleanup failure throws instead of retaining a disposable profile silently", (t) => {
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-health-cleanup-failure-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  let probeRoot = "";

  assert.throws(
    () => spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      spawn: ((_command: string, _args: readonly string[], options: SpawnSyncOptions) => {
        probeRoot = options.env?.HOME ?? "";
        return { status: 0 } as ReturnType<typeof spawnSync>;
      }) as typeof spawnSync,
      platform: "darwin",
      removeProbeRoot: () => undefined,
    }),
    /disposable root could not be removed/,
  );
  assert.equal(existsSync(probeRoot), true);
});
