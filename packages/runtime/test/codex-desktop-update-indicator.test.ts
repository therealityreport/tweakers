import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopUpdateIndicatorIdentity,
  shouldShowDesktopUpdateIndicator,
} from "../src/preload/desktop-update-indicator-state";

test("fallback indicator is gated off only when the native ready sink is active", () => {
  const update = {
    status: "update-available",
    latest: { marketingVersion: "26.8", build: "2680" },
  };
  assert.equal(shouldShowDesktopUpdateIndicator(update), true);
  assert.equal(shouldShowDesktopUpdateIndicator({ ...update, nativeUpdateControlActive: false }), true);
  assert.equal(shouldShowDesktopUpdateIndicator({ ...update, nativeUpdateControlActive: true }), false);
  assert.equal(shouldShowDesktopUpdateIndicator({ ...update, status: "current" }), false);
  assert.equal(desktopUpdateIndicatorIdentity(update), "26.8:2680");
});
