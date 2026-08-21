import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import {
  ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES,
  routerControlSocketPath,
  startRouterControlSocket,
} from "../../src/account-router/control-socket";
import type { RedactedControlStatus } from "../../src/account-router/types";

const accountA = `ar_${"A".repeat(43)}` as const;
const secret = Buffer.alloc(32, 7);

function status(): RedactedControlStatus {
  return {
    schemaVersion: 1,
    mode: "balanced",
    protocolState: "supported",
    fairnessPrecision: "exact_completed_spend",
    accounts: [{ opaqueAccountId: accountA, label: "Account A", eligibility: "eligible", normalizedSpend: 0, assignedThreadCount: 0 }],
    restartRequired: false,
    degradedReason: null,
  };
}

function frame(requestId: string | number, capability = secret.toString("base64url")): string {
  return `${JSON.stringify({ version: 1, requestId, method: "status", secret: capability })}\n`;
}

function exchange(path: string, body: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("connect", () => socket.end(body));
    socket.once("end", () => resolvePromise(response));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNRESET" || error.code === "EPIPE") resolvePromise(response);
      else reject(error);
    });
  });
}

test("owner-private control socket authenticates and returns only redacted status", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-control-"));
  const control = await startRouterControlSocket({ root, secret, status });
  try {
    assert.equal(statSync(control.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(control.path)).mode & 0o777, 0o700);
    const response = JSON.parse(await exchange(control.path, frame(9))) as { version: number; requestId: number; status: RedactedControlStatus };
    assert.equal(response.version, 1);
    assert.equal(response.requestId, 9);
    assert.deepEqual(response.status, status());
    assert.equal(JSON.stringify(response).includes(secret.toString("base64url")), false);
    assert.equal(JSON.stringify(response).includes("accessToken"), false);
  } finally {
    await control.close();
  }
  assert.equal(existsSync(control.path), false);
});

test("control socket rejects wrong capability, malformed and replayed pipelined frames without an oracle", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-control-negative-"));
  const control = await startRouterControlSocket({ root, secret, status });
  try {
    const wrong = Buffer.alloc(32, 8).toString("base64url");
    assert.equal(await exchange(control.path, frame("wrong", wrong)), "");
    assert.equal(await exchange(control.path, "{not-json}\n"), "");
    assert.equal(await exchange(control.path, frame("same") + frame("same")), "");
    const response = JSON.parse(await exchange(control.path, frame("still-live"))) as { requestId: string };
    assert.equal(response.requestId, "still-live");
  } finally {
    await control.close();
  }
});

test("control socket bounds frames and cleanup removes only its exact endpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-control-bounds-"));
  const control = await startRouterControlSocket({ root, secret, status, maxFrameBytes: 512 });
  try {
    assert.equal(await exchange(control.path, "x".repeat(ACCOUNT_ROUTER_CONTROL_MAX_FRAME_BYTES + 1)), "");
    const response = JSON.parse(await exchange(control.path, frame("bounded"))) as { requestId: string };
    assert.equal(response.requestId, "bounded");
  } finally {
    await control.close();
  }
  assert.equal(existsSync(control.path), false);
  assert.equal(existsSync(root), true);
});

test("an active owner-private endpoint is never removed as stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-control-active-"));
  const first = await startRouterControlSocket({ root, secret, status });
  try {
    await assert.rejects(() => startRouterControlSocket({ root, secret, status }), /already active/);
    assert.equal(existsSync(first.path), true);
    assert.equal((JSON.parse(await exchange(first.path, frame("owner"))) as { requestId: string }).requestId, "owner");
  } finally {
    await first.close();
  }
});

test("a proven inactive exact owner-private socket is replaced safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "account-router-control-stale-"));
  const path = routerControlSocketPath(root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const source = [
    'const fs = require("node:fs")',
    'const net = require("node:net")',
    'const path = process.argv[1]',
    'net.createServer().listen(path, () => { fs.chmodSync(path, 0o600); process.stdout.write("ready\\n") })',
    'setInterval(() => {}, 1000)',
  ].join(";");
  const child = spawn(process.execPath, ["-e", source, path], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    await new Promise<void>((resolvePromise, reject) => {
      child.once("error", reject);
      child.stdout?.once("data", () => resolvePromise());
    });
    assert.equal(child.kill("SIGKILL"), true);
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    assert.equal(existsSync(path), true);
    const control = await startRouterControlSocket({ root, secret, status });
    try {
      assert.equal((JSON.parse(await exchange(control.path, frame("replacement"))) as { requestId: string }).requestId, "replacement");
    } finally {
      await control.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("the physical control endpoint remains within the portable Unix path bound", () => {
  const root = "/Users/example/Library/Application Support/codex-plusplus/tweak-data/co.tweakers.account-switcher";
  const path = routerControlSocketPath(root);
  assert.ok(Buffer.byteLength(path) <= 100);
  assert.match(path, /arc-/);
});
