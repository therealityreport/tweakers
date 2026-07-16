import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import childProcessModule from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  buildCodexAppServerParentArgs,
  CODEX_APP_SERVER_PARENT_SOURCE,
  installCodexAppServerParent,
  isCodexAppServerSpawn,
  type MutableChildProcessModule,
  type SpawnFunction,
} from "../src/codex-app-server-parent";

test("matches only a normal Codex app-server launch", () => {
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server"]), true);
  assert.equal(isCodexAppServerSpawn("codex", ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"]), true);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["exec", "app-server"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["-c", "app-server", "exec"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["-c", "features.other=true", "app-server"]), false);

  assert.equal(isCodexAppServerSpawn("/usr/local/bin/node", ["app-server"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex-beta", ["app-server"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["exec"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server", "app-server"]), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server"], { shell: true }), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server"], { detached: true }), false);
  assert.equal(isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server"], { stdio: "ignore" }), false);
  assert.equal(
    isCodexAppServerSpawn("/usr/local/bin/codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe", "ipc"] }),
    false,
  );
});

test("rewrites only the target launch through bundled signed Node", () => {
  const calls: Array<{ command: string; args: unknown; options: unknown }> = [];
  const originalSpawn: SpawnFunction = (command, args, options) => {
    calls.push({ command, args, options });
    return {} as ChildProcess;
  };
  const childProcess: MutableChildProcessModule = { spawn: originalSpawn };
  const resourcesPath = "/Applications/ChatGPT.app/Contents/Resources";
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath,
    platform: "darwin",
    pathExists: () => true,
  });

  assert.equal(installation.installed, true);
  assert.equal(installation.reason, "installed");
  assert.equal(installation.bundledNodePath, join(resourcesPath, "cua_node", "bin", "node"));

  const targetOptions: SpawnOptions = {
    cwd: "/tmp",
    stdio: "pipe",
    env: { PATH: "/usr/bin", NODE_OPTIONS: "--require /tmp/untrusted-preload.cjs" },
  };
  childProcess.spawn("/Users/test/.local/bin/codex", ["-c", "features.code_mode_host=true", "app-server"], targetOptions);
  childProcess.spawn("/bin/echo", ["app-server"], { cwd: "/" });
  childProcess.spawn("/Users/test/.local/bin/codex", { cwd: "/tmp" });

  assert.deepEqual(calls[0], {
    command: join(resourcesPath, "cua_node", "bin", "node"),
    args: buildCodexAppServerParentArgs("/Users/test/.local/bin/codex", [
      "-c",
      "features.code_mode_host=true",
      "app-server",
    ]),
    options: { cwd: "/tmp", stdio: "pipe", env: { PATH: "/usr/bin" } },
  });
  assert.deepEqual(calls[1], {
    command: "/bin/echo",
    args: ["app-server"],
    options: { cwd: "/" },
  });
  assert.deepEqual(calls[2], {
    command: "/Users/test/.local/bin/codex",
    args: { cwd: "/tmp" },
    options: undefined,
  });

  installation.uninstall();
  assert.equal(childProcess.spawn, originalSpawn);
});

test("installation is idempotent and fails open without the signed Node", () => {
  const originalSpawn = (() => ({} as ChildProcess)) as SpawnFunction;
  const childProcess: MutableChildProcessModule = { spawn: originalSpawn };

  const missing = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/missing",
    platform: "darwin",
    pathExists: () => false,
  });
  assert.equal(missing.installed, false);
  assert.equal(missing.reason, "missing-bundled-node");
  assert.equal(childProcess.spawn, originalSpawn);

  const first = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/present",
    platform: "darwin",
    pathExists: () => true,
  });
  const installedSpawn = childProcess.spawn;
  const second = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/present",
    platform: "darwin",
    pathExists: () => true,
  });
  assert.equal(first.installed, true);
  assert.equal(second.installed, false);
  assert.equal(second.reason, "already-installed");
  assert.equal(childProcess.spawn, installedSpawn);
  second.uninstall();
  assert.equal(childProcess.spawn, installedSpawn, "a non-owning handle cannot uninstall the active hook");
  first.uninstall();
  assert.equal(childProcess.spawn, originalSpawn);
});

test("the Node child_process export can be installed and restored", () => {
  const childProcess = childProcessModule as unknown as MutableChildProcessModule;
  const originalSpawn = childProcess.spawn;
  const installation = installCodexAppServerParent({
    childProcess,
    resourcesPath: "/present",
    platform: "darwin",
    pathExists: () => true,
  });
  try {
    assert.equal(installation.installed, true);
    assert.notEqual(childProcess.spawn, originalSpawn);
  } finally {
    installation.uninstall();
  }
  assert.equal(childProcess.spawn, originalSpawn);
});

test("parent process transparently proxies stdio and child exit", async () => {
  const childSource = [
    'process.stdin.setEncoding("utf8")',
    'let input = ""',
    'process.stdin.on("data", (chunk) => { input += chunk })',
    'process.stdin.on("end", () => { process.stdout.write(input.toUpperCase()); process.stderr.write("proxy-stderr\\nnode-options=" + String(process.env.NODE_OPTIONS) + "\\n") })',
  ].join(";");
  const parent = spawn(process.execPath, [
    "-e",
    CODEX_APP_SERVER_PARENT_SOURCE,
    "--",
    process.execPath,
    "-e",
    childSource,
  ], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" } });

  let stdout = "";
  let stderr = "";
  parent.stdout?.setEncoding("utf8");
  parent.stderr?.setEncoding("utf8");
  parent.stdout?.on("data", (chunk) => { stdout += chunk; });
  parent.stderr?.on("data", (chunk) => { stderr += chunk; });
  parent.stdin?.end("browser-ready");

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(outcome, { code: 0, signal: null });
  assert.equal(stdout, "BROWSER-READY");
  assert.equal(stderr, "proxy-stderr\nnode-options=undefined\n");
});

test("parent process forwards termination signals to Codex", async () => {
  const childSource = [
    'process.on("SIGTERM", () => { process.stderr.write("term-forwarded\\n"); process.exit(42) })',
    'process.stdout.write("ready\\n")',
    "setInterval(() => {}, 1000)",
  ].join(";");
  const parent = spawn(process.execPath, [
    "-e",
    CODEX_APP_SERVER_PARENT_SOURCE,
    "--",
    process.execPath,
    "-e",
    childSource,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  parent.stderr?.setEncoding("utf8");
  parent.stderr?.on("data", (chunk) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    parent.once("error", reject);
    parent.stdout?.setEncoding("utf8");
    parent.stdout?.once("data", () => resolve());
  });
  parent.kill("SIGTERM");

  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    parent.once("error", reject);
    parent.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(outcome, { code: 42, signal: null });
  assert.equal(stderr, "term-forwarded\n");
});
