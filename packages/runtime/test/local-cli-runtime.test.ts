import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeExecutableFromCliShim, resolveLocalCliRuntime } from "../src/local-cli-runtime";

test("CLI shim parser returns only the exact recorded Node executable", () => {
  assert.equal(
    nodeExecutableFromCliShim('#!/bin/sh\nexec "/opt/node/bin/node" "/runtime/cli.js" "$@"\n'),
    "/opt/node/bin/node",
  );
  assert.equal(nodeExecutableFromCliShim('#!/bin/sh\nnode /runtime/cli.js "$@"\n'), null);
});

test("local CLI runtime prefers the installation Node recorded by the shim", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-cli-runtime-"));
  try {
    const node = join(root, "node");
    const userRoot = join(root, "user");
    mkdirSync(join(userRoot, "bin"), { recursive: true });
    writeFileSync(node, "node");
    writeFileSync(
      join(userRoot, "bin", "tweaker"),
      `#!/bin/sh\nexec "${node}" "/managed/cli.js" "$@"\n`,
    );

    const resolved = resolveLocalCliRuntime({
      cli: "/development/cli.js",
      args: ["update-chatgpt", "--json"],
      userRoot,
      resourcesPath: join(root, "resources"),
      execPath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      env: { TWEAKERS_HOME: userRoot },
    });

    assert.equal(resolved.command, node);
    assert.deepEqual(resolved.args, ["/development/cli.js", "update-chatgpt", "--json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local CLI runtime retains bundled Node as a compatibility fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-cli-runtime-fallback-"));
  try {
    const bundled = join(root, "resources", "cua_node", "bin", "node");
    mkdirSync(join(root, "resources", "cua_node", "bin"), { recursive: true });
    writeFileSync(bundled, "node");
    const resolved = resolveLocalCliRuntime({
      cli: "/managed/cli.js",
      args: ["status"],
      userRoot: join(root, "missing-user"),
      resourcesPath: join(root, "resources"),
      execPath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      env: {},
    });
    assert.equal(resolved.command, bundled);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
