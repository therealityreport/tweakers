import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  answerPromotionHealthRequest,
  createPromotionRendererProofTracker,
  hasAuthenticatedSessionCookie,
  hasAuthenticatedCodexToken,
  PROMOTION_SURFACE_NAMES,
  readCodexAuth,
} from "../src/promotion-health";

test("promotion renderer proof stays unknown when no BrowserWindow exists", () => {
  const tracker = createPromotionRendererProofTracker({
    nonce: "123e4567-e89b-42d3-a456-426614174000",
    url: "app://-/index.html?tweakerPromotionNonce=123e4567-e89b-42d3-a456-426614174000",
    preloadPath: "/candidate/runtime/preload.js",
  });

  assert.deepEqual(tracker.result(), {
    hostReady: "unknown",
    rendererStorageSelfTest: "unknown",
  });
});

test("promotion renderer proof permanently fails after did-fail-load including ERR_FAILED", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  const tracker = createPromotionRendererProofTracker({
    nonce,
    url,
    preloadPath: "/candidate/runtime/preload.js",
  });
  tracker.windowCreated({ webContentsId: 41, url, preloadPath: "/candidate/runtime/preload.js" });
  tracker.didFailLoad({ webContentsId: 41, errorCode: -2, errorDescription: "ERR_FAILED", url });
  tracker.didFinishLoad({ webContentsId: 41, url });
  tracker.rendererHandshake({
    webContentsId: 41,
    nonce,
    url,
    lifecycle: "renderer-mounted",
    rendererStorageSelfTest: "pass",
  });

  assert.deepEqual(tracker.result(), {
    hostReady: "fail",
    rendererStorageSelfTest: "fail",
  });
});

test("promotion renderer proof passes only after exact preload, load, and nonce handshake", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  const preloadPath = "/candidate/runtime/preload.js";
  const tracker = createPromotionRendererProofTracker({ nonce, url, preloadPath });
  tracker.windowCreated({ webContentsId: 42, url, preloadPath });
  tracker.rendererHandshake({
    webContentsId: 42,
    nonce,
    url,
    lifecycle: "renderer-mounted",
    rendererStorageSelfTest: "pass",
  });
  assert.equal(tracker.result().hostReady, "unknown");
  tracker.didFinishLoad({ webContentsId: 42, url });

  assert.deepEqual(tracker.result(), {
    hostReady: "pass",
    rendererStorageSelfTest: "pass",
  });
});

test("promotion renderer proof stays incomplete until an exact renderer-mounted handshake", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  const preloadPath = "/candidate/runtime/preload.js";
  const tracker = createPromotionRendererProofTracker({ nonce, url, preloadPath });
  tracker.windowCreated({ webContentsId: 44, url, preloadPath });
  tracker.didFinishLoad({ webContentsId: 44, url });

  assert.deepEqual(tracker.result(), {
    hostReady: "unknown",
    rendererStorageSelfTest: "unknown",
  });

  tracker.rendererHandshake({
    webContentsId: 44,
    nonce,
    url,
    lifecycle: "dom-content-loaded",
    rendererStorageSelfTest: "pass",
  });
  assert.deepEqual(tracker.result(), {
    hostReady: "fail",
    rendererStorageSelfTest: "fail",
  });
});

test("promotion renderer proof fails when its renderer process exits", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  const preloadPath = "/candidate/runtime/preload.js";
  const tracker = createPromotionRendererProofTracker({ nonce, url, preloadPath });
  tracker.windowCreated({ webContentsId: 43, url, preloadPath });
  tracker.renderProcessGone({ webContentsId: 43, reason: "crashed", exitCode: 9 });

  assert.deepEqual(tracker.result(), {
    hostReady: "fail",
    rendererStorageSelfTest: "fail",
  });
});

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

test("schema-v2 receipt proves every promoted surface and canonical User Questions health", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-health-v2-"));
  try {
    const health = join(root, "health");
    mkdirSync(health);
    const hashes = Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name, index) => [
      name,
      String((index + 1) % 10).repeat(64),
    ])) as Record<(typeof PROMOTION_SURFACE_NAMES)[number], string>;
    const surfaces = Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
      preimageHash: "0".repeat(64),
      afterHash: hashes[name],
    }]));
    const request = join(health, "request.json");
    writeFileSync(request, JSON.stringify({
      schemaVersion: 2,
      requestedAt: "2026-07-10T12:00:00.000Z",
      app: { version: "1", build: "2", hash: hashes.app },
      requiredPermissions: ["accessibility"],
      surfaces,
      userQuestions: {
        id: "co.tweakers.user-questions",
        version: "0.4.10",
        payloadHash: "f".repeat(64),
      },
    }), { mode: 0o600 });
    chmodSync(request, 0o600);
    const observedSurfaces: string[] = [];
    assert.equal(await answerPromotionHealthRequest(root, {
      authenticatedSession: () => "pass",
      declaredPermission: () => "pass",
      rendererReady: () => "pass",
      promotionSurface: (surface) => {
        observedSurfaces.push(surface);
        return hashes[surface];
      },
      userQuestionsHealth: () => ({
        id: "co.tweakers.user-questions",
        version: "0.4.10",
        payloadHash: "f".repeat(64),
        mainLifecycle: "pass",
        brokerSelfTest: "pass",
        schemaSelfTest: "pass",
        rendererStorageSelfTest: "pass",
        mcpConflictCount: 0,
      }),
    }, { now: new Date("2026-07-10T12:00:01.000Z") }), true);

    const receiptPath = join(health, "promotion.json");
    assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      schemaVersion: number;
      promotionReady: string;
      hostReady: string;
      surfaces: Record<string, { preimageHash: string; expectedHash: string; observedHash: string; status: string }>;
      userQuestions: Record<string, unknown>;
    };
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.hostReady, "pass");
    assert.equal(receipt.promotionReady, "pass");
    assert.deepEqual(observedSurfaces.sort(), [...PROMOTION_SURFACE_NAMES].sort());
    for (const name of PROMOTION_SURFACE_NAMES) {
      assert.deepEqual(receipt.surfaces[name], {
        preimageHash: "0".repeat(64),
        expectedHash: hashes[name],
        observedHash: hashes[name],
        status: "pass",
      });
    }
    assert.equal(receipt.userQuestions.identity, "pass");
    assert.equal(receipt.userQuestions.mainLifecycle, "pass");
    assert.equal(receipt.userQuestions.brokerSelfTest, "pass");
    assert.equal(receipt.userQuestions.schemaSelfTest, "pass");
    assert.equal(receipt.userQuestions.rendererStorageSelfTest, "pass");
    assert.equal(receipt.userQuestions.zeroMcpConflicts, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-v2 request fails closed on missing surfaces and absent injected probes", async () => {
  const makeRoot = (): { root: string; request: string } => {
    const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-health-v2-"));
    const health = join(root, "health");
    mkdirSync(health);
    return { root, request: join(health, "request.json") };
  };
  const base = {
    schemaVersion: 2,
    requestedAt: "2026-07-10T12:00:00.000Z",
    app: { version: "1", build: "2", hash: "a".repeat(64) },
    requiredPermissions: [],
    surfaces: Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
      preimageHash: "0".repeat(64),
      afterHash: name === "app" ? "a".repeat(64) : "b".repeat(64),
    }])),
    userQuestions: { id: "co.tweakers.user-questions", version: "0.4.10", payloadHash: "c".repeat(64) },
  };

  const incomplete = makeRoot();
  try {
    const missing = structuredClone(base) as typeof base;
    delete (missing.surfaces as Record<string, unknown>).policy;
    writeFileSync(incomplete.request, JSON.stringify(missing), { mode: 0o600 });
    chmodSync(incomplete.request, 0o600);
    let probed = false;
    assert.equal(await answerPromotionHealthRequest(incomplete.root, {
      authenticatedSession: () => { probed = true; return "pass"; },
      declaredPermission: () => "pass",
    }, { now: new Date("2026-07-10T12:00:01.000Z") }), false);
    assert.equal(probed, false);
  } finally {
    rmSync(incomplete.root, { recursive: true, force: true });
  }

  const noProbes = makeRoot();
  try {
    writeFileSync(noProbes.request, JSON.stringify(base), { mode: 0o600 });
    chmodSync(noProbes.request, 0o600);
    assert.equal(await answerPromotionHealthRequest(noProbes.root, {
      authenticatedSession: () => "pass",
      declaredPermission: () => "pass",
    }, { now: new Date("2026-07-10T12:00:01.000Z") }), true);
    const receipt = JSON.parse(readFileSync(join(noProbes.root, "health", "promotion.json"), "utf8")) as {
      promotionReady: string;
      hostReady: string;
      surfaces: Record<string, { status: string }>;
      userQuestions: { identity: string; zeroMcpConflicts: string };
    };
    assert.equal(receipt.promotionReady, "fail");
    assert.equal(receipt.hostReady, "unknown");
    assert.equal(receipt.surfaces.codexConfig?.status, "unknown");
    assert.equal(receipt.userQuestions.identity, "unknown");
    assert.equal(receipt.userQuestions.zeroMcpConflicts, "unknown");
  } finally {
    rmSync(noProbes.root, { recursive: true, force: true });
  }
});
