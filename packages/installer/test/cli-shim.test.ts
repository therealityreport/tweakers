import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installCliShims } from "../src/cli-shim";
import { reconcileManagedCliShims } from "../src/managed-runtime";
import { shouldReconcileCliShims } from "../src/commands/install";

test("CLI shims expose unique aliases and target the managed runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-cli-shims-"));
  try {
    const shimDir = join(root, "user", "bin");
    const publicDir = join(root, "public-bin");
    const managedCli = join(root, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");
    mkdirSync(publicDir, { recursive: true });

    const result = installCliShims(shimDir, managedCli, {
      pathDir: publicDir,
      homebrew: false,
    });

    assert.deepEqual(result.commands, ["tweaker", "tweakers", "codexplusplus", "codex-plusplus"]);
    assert.equal(new Set(result.commands).size, result.commands.length);
    for (const command of result.commands) {
      const shim = process.platform === "win32" ? join(shimDir, `${command}.cmd`) : join(shimDir, command);
      const publicCommand = process.platform === "win32" ? join(publicDir, `${command}.cmd`) : join(publicDir, command);
      assert.equal(existsSync(shim), true);
      assert.match(readFileSync(shim, "utf8"), new RegExp(escapeRegExp(managedCli)));
      assert.equal(existsSync(publicCommand), true);
      if (process.platform !== "win32") assert.equal(lstatSync(publicCommand).isSymbolicLink(), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed shim reconciliation bootstraps the runtime before writing public commands", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-managed-shims-"));
  try {
    const sourceRoot = join(root, "source");
    const userRoot = join(root, "user");
    const shimDir = join(userRoot, "bin");
    const publicDir = join(root, "public-bin");
    const sourceCli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
    mkdirSync(join(sourceRoot, "packages", "installer", "dist"), { recursive: true });
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(sourceCli, "console.log('managed');\n", "utf8");

    const result = reconcileManagedCliShims(sourceRoot, userRoot, shimDir, {
      pathDir: publicDir,
      homebrew: false,
    });
    const managedCli = join(userRoot, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");

    assert.equal(existsSync(managedCli), true);
    assert.match(readFileSync(join(shimDir, "tweaker"), "utf8"), new RegExp(escapeRegExp(managedCli)));
    assert.equal(result.pathDir, publicDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal and held installs reconcile shims, candidate and disabled paths do not", () => {
  assert.equal(shouldReconcileCliShims("promoted", false), true);
  assert.equal(shouldReconcileCliShims("held", false), true);
  assert.equal(shouldReconcileCliShims("candidate-ready", true), false);
  assert.equal(shouldReconcileCliShims("held", false, false), false);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
