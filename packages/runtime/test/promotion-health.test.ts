import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  answerPromotionHealthRequest,
  authorizePromotionOriginalRenderer,
  authorizePromotionRenderer,
  canonicalPromotionOriginalRendererUrl,
  createPromotionOriginalRendererProofTracker,
  createPromotionRendererProtocolResponder,
  createPromotionRendererProofTracker,
  hasAuthenticatedSessionCookie,
  hasAuthenticatedCodexToken,
  PROMOTION_ORIGINAL_RENDERER_URL,
  PROMOTION_SURFACE_NAMES,
  promotionOriginalRendererLogUrl,
  promotionRendererAssetMimeType,
  promotionRendererAssetRoute,
  promotionRendererDocumentUrl,
  promotionRendererLoadRejection,
  readCodexAuth,
  validatePromotionRendererHandshake,
} from "../src/promotion-health";

const PASSING_RENDERER_PROOF = {
  capturedWindowCount: 1,
  canonicalWebContentsId: 71,
  canonicalUrl: `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123`,
  authorized: true,
  didFinishLoad: true,
  mounted: true,
  originalPreload: true,
  preloadFailed: false,
  loadFailed: false,
  rendererExited: false,
  cleanup: "pass" as const,
  failureReason: null,
};

test("original renderer authorization is exact, hidden, main-frame, and one-shot", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const context = {
    windowAlive: true,
    windowHidden: true,
    senderMatches: true,
    frameMatches: true,
    senderUrl: PROMOTION_ORIGINAL_RENDERER_URL,
    consumed: false,
  };
  const payload = { version: 1, url: PROMOTION_ORIGINAL_RENDERER_URL };
  assert.deepEqual(authorizePromotionOriginalRenderer(context, payload, nonce), {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url: PROMOTION_ORIGINAL_RENDERER_URL },
  });
  const queriedUrl = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123&initialRoute=%2Fsettings`;
  assert.deepEqual(authorizePromotionOriginalRenderer(
    { ...context, senderUrl: queriedUrl },
    { version: 1, url: queriedUrl },
    nonce,
  ), {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url: queriedUrl },
  });
  for (const override of [
    { windowAlive: false },
    { windowHidden: false },
    { senderMatches: false },
    { frameMatches: false },
    { senderUrl: `${PROMOTION_ORIGINAL_RENDERER_URL}?tweakerPromotionNonce=untrusted` },
    { senderUrl: "https://-/index.html?hostId=host-123" },
    { senderUrl: "app://-/other.html?hostId=host-123" },
    { senderUrl: `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123#fragment` },
    { consumed: true },
  ]) {
    assert.equal(authorizePromotionOriginalRenderer({ ...context, ...override }, payload, nonce).accepted, false);
  }
  for (const malformed of [
    null,
    { version: 1 },
    { ...payload, extra: true },
    { version: 2, url: PROMOTION_ORIGINAL_RENDERER_URL },
    { version: 1, url: `${PROMOTION_ORIGINAL_RENDERER_URL}?nonce=untrusted` },
  ]) {
    assert.equal(authorizePromotionOriginalRenderer(context, malformed, nonce).accepted, false);
  }
});

test("original renderer URL accepts exact production queries and rejects normalization ambiguity", () => {
  for (const url of [
    PROMOTION_ORIGINAL_RENDERER_URL,
    `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=123e4567-e89b-42d3-a456-426614174000`,
    `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123&initialRoute=%2Fsettings`,
  ]) assert.equal(canonicalPromotionOriginalRendererUrl(url), url);

  for (const url of [
    "https://-/index.html?hostId=host-123",
    "app://user@-/index.html?hostId=host-123",
    "app://-:123/index.html?hostId=host-123",
    "app://-/other.html?hostId=host-123",
    `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123#fragment`,
    `${PROMOTION_ORIGINAL_RENDERER_URL}?tweakerPromotionNonce=untrusted`,
    `${PROMOTION_ORIGINAL_RENDERER_URL}?code=secret-oauth-code`,
    `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123\nspoof=1`,
  ]) assert.equal(canonicalPromotionOriginalRendererUrl(url), null, url);

  const sensitiveRoute = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123&initialRoute=%2Foauth%3Fcode%3Dsecret-value`;
  const logged = promotionOriginalRendererLogUrl(sensitiveRoute);
  assert.equal(logged, `${PROMOTION_ORIGINAL_RENDERER_URL}?[hostId,initialRoute:redacted]`);
  assert.doesNotMatch(logged, /secret-value|oauth|host-123/);
});

test("original renderer proof requires safe exact window, auth, load, mount, and cleanup", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const originalUrl = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123`;
  const tracker = createPromotionOriginalRendererProofTracker(nonce);
  tracker.windowCaptured();
  tracker.eligibleWindow({
    webContentsId: 71,
    url: originalUrl,
    isDefaultSession: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  tracker.authorization(71);
  tracker.rendererHandshake({
    webContentsId: 71,
    nonce,
    url: originalUrl,
    lifecycle: "renderer-mounted",
    rendererStorageSelfTest: "pass",
  });
  assert.equal(tracker.result().hostReady, "unknown");
  tracker.didFinishLoad(71, originalUrl);
  assert.equal(tracker.complete(), true);
  assert.equal(tracker.result().hostReady, "unknown", "cleanup is a required final gate");
  tracker.cleanup(true);
  assert.deepEqual(tracker.result(), {
    hostReady: "pass",
    rendererStorageSelfTest: "pass",
    proofSummary: {
      capturedWindowCount: 1,
      canonicalWebContentsId: 71,
      canonicalUrl: originalUrl,
      authorized: true,
      didFinishLoad: true,
      mounted: true,
      originalPreload: true,
      preloadFailed: false,
      loadFailed: false,
      rendererExited: false,
      cleanup: "pass",
      failureReason: null,
    },
  });
});

test("original renderer proof permanently rejects unsafe, duplicate, replay, failure, and cleanup failure", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const unsafe = createPromotionOriginalRendererProofTracker(nonce);
  unsafe.eligibleWindow({
    webContentsId: 72,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    isDefaultSession: true,
    sandbox: false,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  unsafe.cleanup(true);
  assert.equal(unsafe.result().hostReady, "fail");

  const duplicate = createPromotionOriginalRendererProofTracker(nonce);
  const safe = (webContentsId: number) => ({
    webContentsId,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    isDefaultSession: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  duplicate.eligibleWindow(safe(73));
  duplicate.eligibleWindow(safe(74));
  duplicate.authorization(73);
  duplicate.authorization(73);
  duplicate.didFinishLoad(73, PROMOTION_ORIGINAL_RENDERER_URL);
  duplicate.fail("canonical renderer process exited", 73);
  duplicate.cleanup(false);
  assert.equal(duplicate.result().hostReady, "fail");
  assert.equal(duplicate.result().rendererStorageSelfTest, "fail");
  assert.equal(duplicate.summary().failureReason, "duplicate eligible renderer");

  const preloadFailure = createPromotionOriginalRendererProofTracker(nonce);
  preloadFailure.preloadError(75);
  preloadFailure.eligibleWindow({ ...safe(75), webContentsId: 75 });
  preloadFailure.cleanup(true);
  assert.equal(preloadFailure.result().hostReady, "fail");
  assert.equal(preloadFailure.summary().preloadFailed, true);
});

test("promotion renderer authorization rejects wrong sender, frame, URL, payload, and replay", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = promotionRendererDocumentUrl(nonce);
  const context = {
    windowAlive: true,
    senderMatches: true,
    frameMatches: true,
    senderUrl: url,
    expectedUrl: url,
    consumed: false,
  };
  const request = { version: 1, url };

  assert.deepEqual(authorizePromotionRenderer(context, request, nonce), {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url },
  });
  for (const [override, reason] of [
    [{ windowAlive: false }, "proof window unavailable"],
    [{ senderMatches: false }, "sender mismatch"],
    [{ frameMatches: false }, "frame mismatch"],
    [{ senderUrl: `${url}&spoof=1` }, "sender URL mismatch"],
    [{ consumed: true }, "authorization already consumed"],
  ] as const) {
    assert.deepEqual(authorizePromotionRenderer({ ...context, ...override }, request, nonce), {
      accepted: false,
      reason,
      response: null,
    });
  }
  for (const payload of [
    null,
    [],
    { version: 1 },
    { version: 1, url, extra: true },
    { version: 2, url },
    { version: 1, url: `${url}&spoof=1` },
  ]) {
    assert.equal(authorizePromotionRenderer(context, payload, nonce).accepted, false);
  }
  assert.equal(authorizePromotionRenderer(context, request, "not-a-uuid").accepted, false);
});

test("promotion renderer handshake rejects pre-auth, wrong context, malformed payload, and replay", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = promotionRendererDocumentUrl(nonce);
  const context = {
    windowAlive: true,
    senderMatches: true,
    frameMatches: true,
    senderUrl: url,
    expectedUrl: url,
    authorizationConsumed: true,
    handshakeConsumed: false,
  };
  const payload = {
    nonce,
    rendererStorageSelfTest: "pass",
    lifecycle: "renderer-mounted",
    url,
  };

  assert.deepEqual(validatePromotionRendererHandshake(context, payload, nonce), {
    accepted: true,
    reason: "accepted",
    observation: payload,
  });
  for (const [override, reason] of [
    [{ windowAlive: false }, "proof window unavailable"],
    [{ senderMatches: false }, "sender mismatch"],
    [{ frameMatches: false }, "frame mismatch"],
    [{ senderUrl: `${url}&spoof=1` }, "sender URL mismatch"],
    [{ authorizationConsumed: false }, "authorization required"],
    [{ handshakeConsumed: true }, "handshake already consumed"],
  ] as const) {
    assert.deepEqual(validatePromotionRendererHandshake({ ...context, ...override }, payload, nonce), {
      accepted: false,
      reason,
      observation: null,
    });
  }
  for (const malformed of [
    null,
    [],
    { ...payload, extra: true },
    { ...payload, nonce: "123e4567-e89b-42d3-a456-426614174001" },
    { ...payload, url: `${url}&spoof=1` },
    { ...payload, lifecycle: "dom-content-loaded" },
    { ...payload, rendererStorageSelfTest: "maybe" },
  ]) {
    assert.equal(validatePromotionRendererHandshake(context, malformed, nonce).accepted, false);
  }
});

test("promotion renderer URL selects the exact production origin document", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";

  assert.equal(
    promotionRendererDocumentUrl(nonce),
    `app://-/index.html?tweakerPromotionNonce=${nonce}`,
  );
});

test("promotion renderer routes decode once and stay below the webview root", () => {
  assert.equal(promotionRendererAssetRoute("app://-/index.html?cache=1"), "index.html");
  assert.equal(promotionRendererAssetRoute("app://-/assets/main%20bundle.js"), "assets/main bundle.js");

  for (const url of [
    "https://-/index.html",
    "app://other/index.html",
    "app://user@-/index.html",
    "app://-:99/index.html",
    "app://-/index.html#fragment",
    "app://-//index.html",
    "app://-/../outside.js",
    "app://-/%2e%2e/outside.js",
    "app://-/%252e%252e/outside.js",
    "app://-/assets/%2e%2e/outside.js",
    "app://-/assets/%252e%252e/outside.js",
    "app://-/assets\\outside.js",
    "app://-/assets/%5coutside.js",
    "app://-/assets/%255coutside.js",
    "app://-/assets/%00outside.js",
    "app://-/assets/%2500outside.js",
  ]) {
    assert.equal(promotionRendererAssetRoute(url), null, url);
  }
});

test("promotion renderer responder serves ASAR-aware bytes with explicit MIME and 404s", async () => {
  const reads: string[] = [];
  const responder = createPromotionRendererProtocolResponder(
    "/candidate/ChatGPT.app/Contents/Resources/app.asar/webview",
    (path) => {
      reads.push(path);
      if (path.endsWith("missing.js")) throw new Error("ENOENT");
      return Buffer.from(path.endsWith("index.html") ? "<!doctype html>" : "console.log('ok')");
    },
  );

  const html = responder({ url: "app://-/index.html?tweakerPromotionNonce=nonce" });
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await html.text(), "<!doctype html>");
  assert.equal(
    reads[0],
    "/candidate/ChatGPT.app/Contents/Resources/app.asar/webview/index.html",
  );

  const script = responder({ url: "app://-/assets/main.js" });
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await script.text(), "console.log('ok')");
  assert.equal(responder({ url: "app://-/assets/missing.js" }).status, 404);
  assert.equal(responder({ url: "app://-/%252e%252e/secret" }).status, 404);
});

test("promotion renderer MIME table covers document, code, and common assets", () => {
  assert.equal(promotionRendererAssetMimeType("index.html"), "text/html; charset=utf-8");
  assert.equal(promotionRendererAssetMimeType("main.js"), "text/javascript; charset=utf-8");
  assert.equal(promotionRendererAssetMimeType("main.css"), "text/css; charset=utf-8");
  assert.equal(promotionRendererAssetMimeType("font.woff2"), "font/woff2");
  assert.equal(promotionRendererAssetMimeType("image.png"), "image/png");
  assert.equal(promotionRendererAssetMimeType("module.wasm"), "application/wasm");
  assert.equal(promotionRendererAssetMimeType("asset.bin"), "application/octet-stream");
});

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

test("a rejected renderer load retains its requested URL and permanently fails the proof", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = promotionRendererDocumentUrl(nonce);
  const tracker = createPromotionRendererProofTracker({
    nonce,
    url,
    preloadPath: "/candidate/runtime/preload.js",
  });
  tracker.windowCreated({ webContentsId: 45, url, preloadPath: "/candidate/runtime/preload.js" });

  const rejection = promotionRendererLoadRejection(new Error("ERR_FAILED (-2) loading renderer"), url);
  assert.deepEqual(rejection, {
    errorCode: -2,
    errorDescription: "ERR_FAILED (-2) loading renderer",
    url,
  });
  tracker.didFailLoad({ webContentsId: 45, ...rejection });

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
      rendererProof: () => PASSING_RENDERER_PROOF,
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
      rendererProof: Record<string, unknown>;
      userQuestions: Record<string, unknown>;
    };
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.hostReady, "pass");
    assert.equal(receipt.promotionReady, "pass");
    assert.deepEqual(receipt.rendererProof, {
      ...PASSING_RENDERER_PROOF,
      canonicalUrl: PROMOTION_ORIGINAL_RENDERER_URL,
      queryKeys: ["hostId"],
    });
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
