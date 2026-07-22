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
  createPromotionOriginalRendererDeadlineController,
  createPromotionOriginalRendererProofTracker,
  createPromotionRendererProtocolResponder,
  createPromotionRendererProofTracker,
  hasUniqueSandboxedPromotionRendererProcess,
  hasAuthenticatedSessionCookie,
  hasAuthenticatedCodexToken,
  PROMOTION_ORIGINAL_RENDERER_URL,
  PROMOTION_ORIGINAL_RENDERER_CLEANUP_BUDGET_MS,
  PROMOTION_ORIGINAL_RENDERER_COMPLETION_TIMEOUT_MS,
  PROMOTION_ORIGINAL_RENDERER_PRELOAD_TIMEOUT_MS,
  PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS,
  PROMOTION_HEALTH_REQUEST_MAX_AGE_MS,
  PROMOTION_SURFACE_NAMES,
  promotionOriginalRendererLogUrl,
  promotionRendererAssetMimeType,
  promotionRendererAssetRoute,
  promotionRendererDocumentUrl,
  promotionRendererLoadRejection,
  readCodexAuth,
  shouldFailPromotionOriginalRendererProvisionalLoad,
  validatePromotionOriginalRendererHandshake,
  validatePromotionOriginalRendererMountTimeout,
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
  const payload = {
    version: 1,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    rendererSandboxed: true,
  };
  assert.deepEqual(authorizePromotionOriginalRenderer(context, payload, nonce), {
    accepted: true,
    reason: "accepted",
    response: { version: 1, nonce, url: PROMOTION_ORIGINAL_RENDERER_URL },
  });
  const queriedUrl = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123&initialRoute=%2Fsettings`;
  assert.deepEqual(authorizePromotionOriginalRenderer(
    { ...context, senderUrl: queriedUrl },
    { version: 1, url: queriedUrl, rendererSandboxed: true },
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
    { ...payload, rendererSandboxed: false },
    { version: 1, url: PROMOTION_ORIGINAL_RENDERER_URL, rendererSandboxed: undefined },
    { ...payload, rendererSandboxed: "true" },
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

test("original renderer process proof requires one matching sandboxed OS metric", () => {
  assert.equal(hasUniqueSandboxedPromotionRendererProcess([
    { pid: 200, sandboxed: false },
    { pid: 201, sandboxed: true },
  ], 201), true);

  for (const [metrics, pid] of [
    [[], 201],
    [[{ pid: 201, sandboxed: true }, { pid: 201, sandboxed: true }], 201],
    [[{ pid: 201, sandboxed: true }, { pid: 201, sandboxed: false }], 201],
    [[{ pid: 201, sandboxed: false }], 201],
    [[{ pid: 201 }], 201],
    [[{ pid: 202, sandboxed: true }], 201],
    [[{ pid: 201, sandboxed: true }], 0],
    [[{ pid: 201, sandboxed: true }], -1],
    [[{ pid: 201, sandboxed: true }], 201.5],
    [[{ pid: 201, sandboxed: true }], "201"],
    [null, 201],
  ] as const) {
    assert.equal(hasUniqueSandboxedPromotionRendererProcess(metrics, pid), false);
  }
});

function fakeDeadlineClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    scheduler: {
      set(callback: () => void, timeoutMs: number): unknown {
        const id = nextId++;
        timers.set(id, { at: now + timeoutMs, callback });
        return id;
      },
      clear(handle: unknown): void {
        timers.delete(handle as number);
      },
    },
    advance(timeoutMs: number): void {
      const target = now + timeoutMs;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    timerCount(): number {
      return timers.size;
    },
  };
}

test("original renderer deadlines give a selection at 19.999s its full non-extendable completion phase", () => {
  const clock = fakeDeadlineClock();
  const timedOut: string[] = [];
  const deadline = createPromotionOriginalRendererDeadlineController({
    scheduler: clock.scheduler,
    onTimeout: (phase) => timedOut.push(phase),
  });

  clock.advance(PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS - 1);
  assert.deepEqual(timedOut, []);
  assert.equal(deadline.canonicalSelected(), true);
  assert.equal(deadline.phase(), "completion");
  clock.advance(PROMOTION_ORIGINAL_RENDERER_COMPLETION_TIMEOUT_MS - 1);
  assert.deepEqual(timedOut, []);
  assert.equal(deadline.canonicalSelected(), false, "repeated eligibility cannot rearm completion");
  clock.advance(1);
  assert.deepEqual(timedOut, ["completion"]);
  assert.equal(deadline.phase(), "settled");
  assert.equal(clock.timerCount(), 0);
});

test("original renderer startup fails without a window and settlement cancels each active phase once", () => {
  const startupClock = fakeDeadlineClock();
  const startupTimeouts: string[] = [];
  createPromotionOriginalRendererDeadlineController({
    scheduler: startupClock.scheduler,
    onTimeout: (phase) => startupTimeouts.push(phase),
  });
  startupClock.advance(PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS);
  assert.deepEqual(startupTimeouts, ["startup"]);

  const settledClock = fakeDeadlineClock();
  const settledTimeouts: string[] = [];
  const settled = createPromotionOriginalRendererDeadlineController({
    scheduler: settledClock.scheduler,
    onTimeout: (phase) => settledTimeouts.push(phase),
  });
  assert.equal(settled.canonicalSelected(), true);
  settled.settle();
  settled.settle();
  settledClock.advance(PROMOTION_ORIGINAL_RENDERER_COMPLETION_TIMEOUT_MS + 1);
  assert.deepEqual(settledTimeouts, []);
  assert.equal(settled.phase(), "settled");
  assert.equal(settledClock.timerCount(), 0);
});

test("only a canonical main-frame provisional failure poisons renderer health", () => {
  assert.equal(shouldFailPromotionOriginalRendererProvisionalLoad({
    isMainFrame: true,
    webContentsId: 71,
    canonicalWebContentsId: 71,
  }), true);
  assert.equal(shouldFailPromotionOriginalRendererProvisionalLoad({
    isMainFrame: false,
    webContentsId: 71,
    canonicalWebContentsId: 71,
  }), false);
  assert.equal(shouldFailPromotionOriginalRendererProvisionalLoad({
    isMainFrame: true,
    webContentsId: 72,
    canonicalWebContentsId: 71,
  }), false);
  assert.equal(shouldFailPromotionOriginalRendererProvisionalLoad({
    isMainFrame: true,
    webContentsId: 71,
    canonicalWebContentsId: null,
  }), false);

  const tracker = createPromotionOriginalRendererProofTracker("123e4567-e89b-42d3-a456-426614174000");
  tracker.eligibleWindow({
    webContentsId: 71,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    isDefaultSession: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  tracker.fail("canonical renderer provisional load failed", 71);
  assert.equal(tracker.complete(), true);
  assert.equal(tracker.summary().loadFailed, true);
  assert.equal(tracker.summary().failureReason, "canonical renderer provisional load failed");
});

test("promotion timeout ordering leaves preload and cleanup headroom inside the outer process cap", () => {
  const outerProcessTimeoutMs = 90_000;
  assert.ok(PROMOTION_ORIGINAL_RENDERER_COMPLETION_TIMEOUT_MS > PROMOTION_ORIGINAL_RENDERER_PRELOAD_TIMEOUT_MS);
  assert.ok(outerProcessTimeoutMs > (
    PROMOTION_ORIGINAL_RENDERER_STARTUP_TIMEOUT_MS
    + PROMOTION_ORIGINAL_RENDERER_COMPLETION_TIMEOUT_MS
    + PROMOTION_ORIGINAL_RENDERER_CLEANUP_BUDGET_MS
  ));
  assert.ok(PROMOTION_HEALTH_REQUEST_MAX_AGE_MS > outerProcessTimeoutMs);
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
    rendererSandboxed: true,
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

test("original renderer finish-only and mount-only observations never pass", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = PROMOTION_ORIGINAL_RENDERER_URL;
  const eligible = (tracker: ReturnType<typeof createPromotionOriginalRendererProofTracker>, id: number): void => {
    tracker.eligibleWindow({
      webContentsId: id,
      url,
      isDefaultSession: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      originalPreloadValid: true,
    });
    tracker.authorization(id);
  };

  const finishOnly = createPromotionOriginalRendererProofTracker(nonce);
  eligible(finishOnly, 92);
  finishOnly.didFinishLoad(92, url);
  finishOnly.cleanup(true);
  assert.equal(finishOnly.result().hostReady, "unknown");

  const mountOnly = createPromotionOriginalRendererProofTracker(nonce);
  eligible(mountOnly, 93);
  mountOnly.rendererHandshake({
    webContentsId: 93,
    nonce,
    url,
    lifecycle: "renderer-mounted",
    rendererSandboxed: true,
    rendererStorageSelfTest: "pass",
  });
  mountOnly.cleanup(true);
  assert.equal(mountOnly.result().hostReady, "unknown");
});

test("original renderer accepts an omitted sandbox default only with positive effective proof", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const tracker = createPromotionOriginalRendererProofTracker(nonce);
  tracker.eligibleWindow({
    webContentsId: 76,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    isDefaultSession: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  tracker.authorization(76);
  tracker.didFinishLoad(76, PROMOTION_ORIGINAL_RENDERER_URL);
  tracker.rendererHandshake({
    webContentsId: 76,
    nonce,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    lifecycle: "renderer-mounted",
    rendererSandboxed: true,
    rendererStorageSelfTest: "pass",
  });
  tracker.cleanup(true);

  assert.equal(tracker.result().hostReady, "pass");
});

test("original renderer rejects explicit sandbox disablement and a false effective proof", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const base = {
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    isDefaultSession: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  };
  const explicitlyDisabled = createPromotionOriginalRendererProofTracker(nonce);
  explicitlyDisabled.eligibleWindow({ webContentsId: 77, sandbox: false, ...base });
  explicitlyDisabled.cleanup(true);
  assert.equal(explicitlyDisabled.result().hostReady, "fail");
  assert.equal(explicitlyDisabled.summary().failureReason, "eligible renderer was not canonical and sandbox-safe");

  const ineffectiveDefault = createPromotionOriginalRendererProofTracker(nonce);
  ineffectiveDefault.eligibleWindow({ webContentsId: 78, ...base });
  ineffectiveDefault.authorization(78);
  ineffectiveDefault.didFinishLoad(78, PROMOTION_ORIGINAL_RENDERER_URL);
  ineffectiveDefault.rendererHandshake({
    webContentsId: 78,
    nonce,
    url: PROMOTION_ORIGINAL_RENDERER_URL,
    lifecycle: "renderer-mounted",
    rendererSandboxed: false,
    rendererStorageSelfTest: "pass",
  });
  ineffectiveDefault.cleanup(true);
  assert.equal(ineffectiveDefault.result().hostReady, "fail");
  assert.equal(ineffectiveDefault.summary().failureReason, "renderer was not effectively sandboxed");
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

test("original renderer handshake requires an exact boolean effective sandbox result", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123`;
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
    rendererSandboxed: true,
    rendererStorageSelfTest: "pass",
    lifecycle: "renderer-mounted",
    url,
  };

  assert.deepEqual(validatePromotionOriginalRendererHandshake(context, payload, nonce), {
    accepted: true,
    reason: "accepted",
    observation: payload,
  });
  assert.equal(validatePromotionOriginalRendererHandshake(
    context,
    { ...payload, rendererSandboxed: false },
    nonce,
  ).accepted, true, "a negative boolean is structurally valid so the tracker can fail closed immediately");
  for (const malformed of [
    { nonce, rendererStorageSelfTest: "pass", lifecycle: "renderer-mounted", url },
    { ...payload, rendererSandboxed: "true" },
    { ...payload, rendererSandboxed: true, extra: true },
  ]) {
    assert.equal(validatePromotionOriginalRendererHandshake(context, malformed, nonce).accepted, false);
  }
});

test("original renderer mount timeout is exact, sandbox-bound, and one-shot", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `${PROMOTION_ORIGINAL_RENDERER_URL}?hostId=host-123`;
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
    rendererSandboxed: true,
    lifecycle: "renderer-mount-timeout",
    url,
  };

  assert.deepEqual(validatePromotionOriginalRendererMountTimeout(context, payload, nonce), {
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
    [{ handshakeConsumed: true }, "proof event already consumed"],
  ] as const) {
    assert.deepEqual(validatePromotionOriginalRendererMountTimeout(
      { ...context, ...override },
      payload,
      nonce,
    ), { accepted: false, reason, observation: null });
  }
  for (const malformed of [
    null,
    [],
    { ...payload, extra: true },
    { ...payload, nonce: "123e4567-e89b-42d3-a456-426614174001" },
    { ...payload, url: `${url}&spoof=1` },
    { ...payload, lifecycle: "renderer-mounted" },
    { ...payload, rendererSandboxed: false },
    { ...payload, rendererSandboxed: "true" },
  ]) {
    assert.equal(validatePromotionOriginalRendererMountTimeout(context, malformed, nonce).accepted, false);
  }

  const tracker = createPromotionOriginalRendererProofTracker(nonce);
  tracker.eligibleWindow({
    webContentsId: 91,
    url,
    isDefaultSession: true,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    originalPreloadValid: true,
  });
  tracker.authorization(91);
  tracker.fail("canonical renderer mount timed out", 91);
  tracker.didFinishLoad(91, url);
  tracker.rendererHandshake({
    webContentsId: 91,
    nonce,
    url,
    lifecycle: "renderer-mounted",
    rendererSandboxed: true,
    rendererStorageSelfTest: "pass",
  });
  tracker.cleanup(true);
  assert.equal(tracker.result().hostReady, "fail", "a valid timeout remains permanent after late success signals");
  assert.equal(tracker.summary().failureReason, "canonical renderer mount timed out");
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

test("promotion request freshness covers the bounded outer renderer probe but still expires", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-freshness-"));
  try {
    const health = join(root, "health");
    mkdirSync(health);
    const request = join(health, "request.json");
    const value = {
      schemaVersion: 1,
      requestedAt: "2026-07-10T12:00:00.000Z",
      app: { version: "1", build: "2", hash: "app-hash" },
      runtimeHash: "runtime-hash",
      requiredPermissions: [] as string[],
    };
    const probes = {
      authenticatedSession: () => "pass" as const,
      declaredPermission: () => "pass" as const,
    };
    writeFileSync(request, JSON.stringify(value), { mode: 0o600 });
    assert.equal(await answerPromotionHealthRequest(root, probes, {
      now: new Date("2026-07-10T12:01:30.000Z"),
      maxAgeMs: PROMOTION_HEALTH_REQUEST_MAX_AGE_MS,
    }), true);

    writeFileSync(request, JSON.stringify(value), { mode: 0o600 });
    assert.equal(await answerPromotionHealthRequest(root, probes, {
      now: new Date("2026-07-10T12:02:00.001Z"),
      maxAgeMs: PROMOTION_HEALTH_REQUEST_MAX_AGE_MS,
    }), false);
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
