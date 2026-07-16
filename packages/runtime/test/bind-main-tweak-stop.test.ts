import assert from "node:assert/strict";
import test from "node:test";
import { bindMainTweakStop } from "../src/tweak-lifecycle";

test("bindMainTweakStop preserves the tweak as `this` when the runtime calls stop() detached", () => {
  const tweak = {
    _instance: { cleaned: false },
    start(this: typeof tweak) {
      this._instance.cleaned = false;
    },
    stop(this: typeof tweak) {
      // Real tweaks read per-instance cleanup handles off `this`.
      this._instance.cleaned = true;
    },
  };

  const stored = { stop: bindMainTweakStop(tweak), storage: {} };
  // Runtime invokes it as t.stop() where t is the wrapper record — this is
  // exactly the detached call site that used to break `this`.
  stored.stop?.();

  assert.equal(tweak._instance.cleaned, true);
});

test("bindMainTweakStop tolerates a missing stop()", () => {
  assert.equal(bindMainTweakStop({ start() {} }), undefined);
  assert.equal(bindMainTweakStop(null), undefined);
  assert.equal(bindMainTweakStop(undefined), undefined);
});

test("without binding, a detached main stop() loses `this` (regression guard)", () => {
  const tweak = {
    marker: "tweak",
    stop(this: { marker?: string }) {
      return this.marker;
    },
  };
  const detached = { stop: tweak.stop };
  // The old behavior: `this` is the wrapper, not the tweak.
  assert.notEqual(detached.stop(), "tweak");
  // The bound behavior: `this` is the tweak.
  const bound = { stop: bindMainTweakStop(tweak) };
  assert.equal(bound.stop?.(), "tweak");
});
