/**
 * Runs the renderer matchers against the real installed ChatGPT bundle.
 *
 * Until this existed, no test had ever fed a patcher actual renderer bytes —
 * every fixture was written by the same person who wrote the pattern, so a
 * matcher could pin a minified identifier and stay green forever while being
 * one desktop update away from breaking every mode switch. That is exactly how
 * 2026-08-10 happened.
 *
 * No vendor bytes are committed: `origin` is public. The bundle is resolved at
 * run time and the suite skips when it is absent (CI, fresh clones).
 */
import assert from "node:assert/strict";
import { extractFile, listPackage } from "@electron/asar";
import { existsSync } from "node:fs";
import test from "node:test";
import { patchCodexInactiveThreadRetentionSource } from "../src/codex-inactive-thread-retention";
import { patchCodexModelSelectionSource } from "../src/codex-model-selection";
import { RendererPatchDeclined } from "../src/renderer-patch-outcome";

const LIVE_ASAR = "/Applications/ChatGPT.app/Contents/Resources/app.asar";
const available = existsSync(LIVE_ASAR);

function rendererSources(): Array<{ path: string; source: string }> {
  return listPackage(LIVE_ASAR)
    .filter((entry) => /^[/\\]webview[/\\]assets[/\\]app-initial-[^/\\]*\.js$/.test(entry))
    .map((entry) => {
      const relativePath = entry.replace(/^[/\\]/, "");
      return { path: relativePath, source: extractFile(LIVE_ASAR, relativePath).toString("utf8") };
    });
}

test("the live renderer still exposes an app-initial bundle", { skip: !available }, () => {
  const sources = rendererSources();
  assert.ok(sources.length > 0, "no app-initial-*.js found in the installed bundle");
});

test("the inactive-thread retention policy resolves in the live bundle", { skip: !available }, () => {
  const outcomes = rendererSources().map(({ path, source }) => {
    try {
      return { path, patch: patchCodexInactiveThreadRetentionSource(source), error: null as unknown };
    } catch (error) {
      return { path, patch: null, error };
    }
  });

  const failed = outcomes.filter((outcome) => outcome.error);
  assert.equal(
    failed.length,
    0,
    `patcher refused the live bundle: ${failed
      .map((f) => `${f.path}: ${(f.error as Error).message}`)
      .join("; ")}`,
  );

  const matched = outcomes.filter((outcome) => outcome.patch);
  assert.equal(matched.length, 1, "expected exactly one renderer asset to carry the retention policy");

  const patch = matched[0]?.patch;
  assert.ok(patch);
  // The installed app may already be patched (Tweakers mode) or pristine
  // (ChatGPT mode); both are healthy, a refusal is not.
  assert.ok(
    patch.strategy === "telemetry-key-discovery" || patch.strategy === "already-patched",
    `unexpected strategy ${patch.strategy}`,
  );
});

test("the retention patch is idempotent against the live bundle", { skip: !available }, () => {
  const carrier = rendererSources()
    .map(({ source }) => ({ source, patch: patchCodexInactiveThreadRetentionSource(source) }))
    .find((candidate) => candidate.patch);
  assert.ok(carrier?.patch);

  const once = carrier.patch.changed ? carrier.patch.source : carrier.source;
  const again = patchCodexInactiveThreadRetentionSource(once);
  assert.ok(again);
  assert.equal(again.changed, false);
  assert.equal(again.strategy, "already-patched");
});

test("the model selector never refuses the live bundle outright", { skip: !available }, () => {
  // not-applicable is acceptable here (the selector may live in a lazily
  // imported chunk this test does not walk); a decline or a hard throw is not.
  for (const { path, source } of rendererSources()) {
    try {
      patchCodexModelSelectionSource(source);
    } catch (error) {
      if (error instanceof RendererPatchDeclined) {
        assert.fail(`model selector declined the live bundle in ${path}: ${error.message}`);
      }
      throw error;
    }
  }
});
