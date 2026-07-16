import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerPromotionHealthRequest, hasAuthenticatedSessionCookie, hasAuthenticatedCodexToken, readCodexAuth } from "../src/promotion-health";

test("session proof accepts only unexpired secure HTTP-only auth session cookies", () => {
  const valid = {
    name: "__Secure-authjs.session-token",
    domain: ".chatgpt.com",
    value: "opaque-session",
    secure: true,
    httpOnly: true,
    expirationDate: 2_000,
  };
  assert.equal(hasAuthenticatedSessionCookie([valid], 1_000_000), true);
  assert.equal(hasAuthenticatedSessionCookie([{ ...valid, name: "csrf-token" }], 1_000_000), false);
  assert.equal(hasAuthenticatedSessionCookie([{ ...valid, domain: ".example.com" }], 1_000_000), false);
  assert.equal(hasAuthenticatedSessionCookie([{ ...valid, secure: false }], 1_000_000), false);
  assert.equal(hasAuthenticatedSessionCookie([{ ...valid, expirationDate: 500 }], 1_000_000), false);
});

test("desktop session proof accepts a durable Codex account token, ignoring id_token expiry", () => {
  // Logged-in via ChatGPT account: durable refresh token present.
  assert.equal(hasAuthenticatedCodexToken({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", access_token: "at", id_token: "expired", account_id: "acct" } }), true);
  // access_token + account_id also proves an interactive session.
  assert.equal(hasAuthenticatedCodexToken({ tokens: { access_token: "at", account_id: "acct" } }), true);
  // API-key auth mode.
  assert.equal(hasAuthenticatedCodexToken({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live" }), true);
  // Logged out / empty.
  assert.equal(hasAuthenticatedCodexToken({ tokens: null, OPENAI_API_KEY: null }), false);
  assert.equal(hasAuthenticatedCodexToken({ tokens: { id_token: "only-id" } }), false);
  assert.equal(hasAuthenticatedCodexToken(null), false);
});

test("readCodexAuth reads auth.json from an explicit codex home and tolerates absence", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  try {
    assert.equal(readCodexAuth(home), null);
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt" } }));
    const auth = readCodexAuth(home);
    assert.equal(hasAuthenticatedCodexToken(auth), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("patched runtime answers a secure promotion request with mocked probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-health-"));
  try {
    const health = join(root, "health");
    mkdirSync(health);
    const request = join(health, "request.json");
    writeFileSync(request, JSON.stringify({
      schemaVersion: 1,
      requestedAt: "2026-07-10T12:00:00.000Z",
      app: { version: "1", build: "2", hash: "app-hash" },
      runtimeHash: "runtime-hash",
      requiredPermissions: ["accessibility"],
    }), { mode: 0o600 });
    chmodSync(request, 0o600);
    assert.equal(await answerPromotionHealthRequest(root, {
      authenticatedSession: () => "pass",
      declaredPermission: () => "pass",
    }, { now: new Date("2026-07-10T12:00:01.000Z") }), true);
    const receipt = join(health, "promotion.json");
    assert.equal(lstatSync(receipt).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), {
      schemaVersion: 1,
      observedAt: "2026-07-10T12:00:01.000Z",
      app: { version: "1", build: "2", hash: "app-hash" },
      runtimeHash: "runtime-hash",
      hostReady: "pass",
      authenticatedSession: "pass",
      declaredPermissions: { accessibility: "pass" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patched runtime rejects stale or insecure requests without probing", async () => {
  for (const mode of [0o600, 0o644]) {
    const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-health-"));
    try {
      const health = join(root, "health");
      mkdirSync(health);
      const request = join(health, "request.json");
      writeFileSync(request, JSON.stringify({
        schemaVersion: 1,
        requestedAt: "2026-07-10T11:00:00.000Z",
        app: { version: "1", build: "2", hash: "app-hash" },
        runtimeHash: "runtime-hash",
        requiredPermissions: [],
      }), { mode });
      chmodSync(request, mode);
      let probed = false;
      assert.equal(await answerPromotionHealthRequest(root, {
        authenticatedSession: () => { probed = true; return "pass"; },
        declaredPermission: () => "pass",
      }, { now: new Date("2026-07-10T12:00:00.000Z") }), false);
      assert.equal(probed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
