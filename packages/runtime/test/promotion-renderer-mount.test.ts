import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromotionRendererMountTracker,
  promotionRendererAuthorizationAttempt,
  promotionRendererAuthorizedNonce,
} from "../src/preload/promotion-renderer-mount";

test("promotion renderer requests authorization only for one exact candidate URL", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const exactUrl = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  assert.deepEqual(promotionRendererAuthorizationAttempt(exactUrl), {
    kind: "candidate",
    nonce,
    request: { version: 1, url: exactUrl },
  });
  assert.deepEqual(promotionRendererAuthorizationAttempt("app://-/index.html"), { kind: "ordinary" });
  assert.deepEqual(promotionRendererAuthorizationAttempt("https://chatgpt.com/"), { kind: "ordinary" });
});

test("reserved promotion query fails closed when its URL or nonce is spoofed", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  for (const url of [
    "app://-/index.html?tweakerPromotionNonce=spoof",
    `app://other/index.html?tweakerPromotionNonce=${nonce}`,
    `app://-/sibling.html?tweakerPromotionNonce=${nonce}`,
    `file:///candidate/index.html?tweakerPromotionNonce=${nonce}`,
    `app://-/index.html?tweakerPromotionNonce=${nonce}&other=1`,
    `app://-/index.html?tweakerPromotionNonce=${nonce}#fragment`,
  ]) {
    assert.equal(promotionRendererAuthorizationAttempt(url).kind, "invalid-candidate", url);
  }
});

test("promotion authorization response must exactly bind version, nonce, URL, and keys", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const url = `app://-/index.html?tweakerPromotionNonce=${nonce}`;
  const attempt = promotionRendererAuthorizationAttempt(url);
  const exact = JSON.stringify({ version: 1, nonce, url });
  assert.equal(promotionRendererAuthorizedNonce(attempt, exact), nonce);
  assert.equal(promotionRendererAuthorizedNonce(attempt, { version: 1, nonce, url }), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, null), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, ""), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, "null"), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, "[]"), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, "not-json"), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, "x".repeat(1_025)), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, JSON.stringify({ version: 2, nonce, url })), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, JSON.stringify({ version: 1, nonce: "123e4567-e89b-42d3-a456-426614174001", url })), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, JSON.stringify({ version: 1, nonce, url: `${url}&spoof=1` })), null);
  assert.equal(promotionRendererAuthorizedNonce(attempt, JSON.stringify({ version: 1, nonce, url, extra: true })), null);
  assert.equal(promotionRendererAuthorizedNonce({ kind: "ordinary" }, exact), null);
});

test("promotion renderer mount proves startup loader replacement with real content", () => {
  const tracker = createPromotionRendererMountTracker();

  assert.equal(tracker.observe({
    rootPresent: true,
    startupLoaderPresent: true,
    elementChildCount: 1,
  }), "waiting");
  assert.equal(tracker.observe({
    rootPresent: true,
    startupLoaderPresent: false,
    elementChildCount: 0,
  }), "waiting");
  assert.equal(tracker.observe({
    rootPresent: true,
    startupLoaderPresent: false,
    elementChildCount: 1,
  }), "mounted");
  assert.equal(tracker.result(), "mounted");
});

test("promotion renderer mount stays incomplete without the loader-to-content transition", () => {
  const tracker = createPromotionRendererMountTracker();

  assert.equal(tracker.observe({
    rootPresent: false,
    startupLoaderPresent: false,
    elementChildCount: 0,
  }), "waiting");
  assert.equal(tracker.observe({
    rootPresent: true,
    startupLoaderPresent: false,
    elementChildCount: 2,
  }), "waiting");
  assert.equal(tracker.result(), "waiting");
});
