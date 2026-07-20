import assert from "node:assert/strict";
import test from "node:test";
import { resolveTerminalCodexBinary } from "../src/codex-terminal-cli.js";

test("Terminal CLI resolution prefers an explicit path, then the standalone shim", () => {
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
  }), "/Users/example/.local/bin/codex");
});

test("Terminal CLI resolution follows PATH after the standalone shim and excludes the desktop binary", () => {
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
