import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveTerminalCodexBinary,
  terminalCodexPathFromShellOutput,
} from "../src/codex-terminal-cli.js";

test("Terminal CLI resolution prefers an explicit path, then PATH order", () => {
  const executable = new Set([
    "/chosen/codex",
    "/Users/example/.local/bin/codex",
    "/opt/homebrew/bin/codex",
  ]);
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    preferredPath: "/chosen/codex",
    pathValue: "/opt/homebrew/bin:/usr/local/bin",
    isExecutable: (path) => executable.has(path),
  }), "/chosen/codex");
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    pathValue: "/opt/homebrew/bin:/usr/local/bin",
    isExecutable: (path) => executable.has(path),
  }), "/opt/homebrew/bin/codex");
});

test("Terminal CLI resolution falls back to the standalone shim", () => {
  const standalone = "/Users/example/.local/bin/codex";
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    pathValue: "/usr/local/bin:/usr/bin",
    isExecutable: (path) => path === standalone,
  }), standalone);
});

test("Terminal CLI resolution trusts the login shell before an app's reduced PATH", () => {
  const loginShellPath = "/Users/example/.nvm/versions/node/v22/bin/codex";
  const executable = new Set([
    loginShellPath,
    "/Users/example/.local/bin/codex",
  ]);
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    loginShellPath,
    pathValue: "/usr/bin:/bin:/usr/sbin:/sbin",
    isExecutable: (path) => executable.has(path),
  }), loginShellPath);
});

test("login shell output accepts only an executable absolute path", () => {
  const selected = "/Users/example/.nvm/versions/node/v22/bin/codex";
  assert.equal(terminalCodexPathFromShellOutput(
    `shell startup message\n${selected}\n`,
    (path) => path === selected,
  ), selected);
  assert.equal(terminalCodexPathFromShellOutput("codex is an alias\n", () => true), null);
});

test("Terminal CLI resolution excludes the desktop binary", () => {
  const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const executable = new Set([desktop, "/opt/homebrew/bin/codex"]);
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    pathValue: "/Applications/ChatGPT.app/Contents/Resources:/opt/homebrew/bin",
    excludedPaths: [desktop],
    isExecutable: (path) => executable.has(path),
  }), "/opt/homebrew/bin/codex");
  assert.equal(resolveTerminalCodexBinary({
    home: "/Users/example",
    pathValue: "/usr/local/bin",
    isExecutable: () => false,
  }), null);
});
