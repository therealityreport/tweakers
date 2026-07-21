import assert from "node:assert/strict";
import test from "node:test";
import { createPromotionRendererMountTracker } from "../src/preload/promotion-renderer-mount";

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
