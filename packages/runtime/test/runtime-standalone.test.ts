import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("standalone broker reserves and releases its socket without workspace dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-standalone-broker-"));
  try {
    const runtime = join(root, "runtime");
    cpSync(fileURLToPath(new URL("../dist", import.meta.url)), runtime, { recursive: true });
    const script = `const fs=require('node:fs'); const m=require(process.argv[1]);
      fs.mkdirSync(process.argv[2],{mode:0o700});
      m.reserveAccountsBrokerSocket({root:process.argv[2],secret:Buffer.alloc(32,7)})
        .then(async reservation=>{await reservation.close();process.stdout.write('released');})
        .catch(error=>{console.error(error);process.exitCode=1;});`;
    const result = spawnSync(process.execPath, ["-e", script, join(runtime, "account-router/broker-socket.js"), join(root, "broker")], {
      cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "released");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const [label, source] of [
  ["standalone", new URL("../dist", import.meta.url)],
  ["packaged", new URL("../../installer/assets/runtime", import.meta.url)],
] as const) test(`${label} broker entries and desktop TOML parser load without workspace dependencies`, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-standalone-entries-"));
  try {
    const runtime = join(root, "runtime");
    cpSync(fileURLToPath(source), runtime, {
      recursive: true, filter: path => !path.endsWith(".app"),
    });
    const script = `const path=require('node:path');
      for(const entry of ['broker-host','broker-app-server','desktop-app-tools'])
        require(path.join(process.argv[1],'account-router',entry+'.js'));
      const tools=require(path.join(process.argv[1],'account-router/desktop-app-tools.js'));
      const args=tools.stripDesktopAppToolsCliOverrides(['-c','mcp_servers.codex_app.enabled=true','app-server']);
      if(JSON.stringify(args)!==JSON.stringify(['app-server'])) throw new Error('desktop TOML parser unavailable');
      process.stdout.write('loaded');`;
    const result = spawnSync(process.execPath, ["-e", script, runtime], {
      cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "loaded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
