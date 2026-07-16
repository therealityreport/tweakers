import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("health-check-only loader starts the isolated runtime without requiring original main", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-loader-health-"));
  try {
    const app = join(root, "app");
    const user = join(root, "user");
    const runtime = join(user, "runtime");
    mkdirSync(app, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    cpSync(resolve("packages/loader/loader.cjs"), join(app, "loader.cjs"));
    writeFileSync(join(app, "package.json"), JSON.stringify({
      __codexpp: { originalMain: "original.cjs", userRoot: join(root, "live-user") },
    }));
    writeFileSync(join(app, "original.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "original-loaded"))}, "yes")`);
    writeFileSync(join(runtime, "main.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "runtime-loaded"))}, "yes")`);

    const result = spawnSync(process.execPath, [join(app, "loader.cjs")], {
      env: {
        ...process.env,
        TWEAKERS_HEALTH_CHECK_ONLY: "1",
        TWEAKERS_HEALTH_USER_ROOT: user,
      },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(existsSync(join(root, "runtime-loaded")), true);
    assert.equal(existsSync(join(root, "original-loaded")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
