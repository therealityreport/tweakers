import assert from "node:assert/strict";
import test from "node:test";
import {
  createPromotionRendererMountTracker,
  promotionRendererBindingArgument,
  promotionRendererNonce,
} from "../src/preload/promotion-renderer-mount";

test("promotion nonce is bound to the main-created exact renderer argument", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const exactUrl = `file:///private/tmp/Candidate%20App.app/Contents/Resources/app.asar/webview/index.html?tweakerPromotionNonce=${nonce}`;
  const siblingUrl = `file:///private/tmp/Sibling%20App.app/Contents/Resources/app.asar/webview/index.html?tweakerPromotionNonce=${nonce}`;
  const binding = promotionRendererBindingArgument(nonce, exactUrl);

  assert.equal(promotionRendererNonce(exactUrl, ["/candidate/ChatGPT Helper", binding]), nonce);
  assert.equal(promotionRendererNonce(siblingUrl, ["/candidate/ChatGPT Helper", binding]), null);
  assert.equal(promotionRendererNonce(exactUrl, ["/candidate/ChatGPT Helper"]), null);
  assert.equal(promotionRendererNonce(exactUrl, [binding, binding]), null);
  assert.equal(promotionRendererNonce(exactUrl, ["--tweaker-promotion-renderer-proof=%"]), null);
});

test("promotion renderer binding rejects a nonce not bound to its URL", () => {
  const nonce = "123e4567-e89b-42d3-a456-426614174000";
  const otherNonce = "123e4567-e89b-42d3-a456-426614174001";
  const url = `file:///candidate/app.asar/webview/index.html?tweakerPromotionNonce=${nonce}`;

  assert.throws(
    () => promotionRendererBindingArgument(otherNonce, url),
    /invalid promotion renderer URL binding/,
  );
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
