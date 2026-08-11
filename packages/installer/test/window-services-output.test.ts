/**
 * The window-services hook splices at an offset derived by scanning minified
 * source, and nothing downstream ever parses or executes OpenAI's main bundle
 * — `validateMainRendererAsarEntrypoint` reads entries and the renderer HTML,
 * never the main module. A desynced offset would therefore ship a
 * correctly-hashed, correctly-signed app that throws at boot, which is the
 * weakest point of the "never write what you cannot verify" invariant.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_WINDOW_SERVICES_KEY, patchCodexWindowServicesSource } from "../src/codex-window-services";
import { verifyWindowServicesOutput } from "../src/commands/install";

/** Mirrors the shape the service-factory fingerprint actually keys on. */
const ORIGINAL =
  "let M=FM({buildFlavor:a,allowDevtools:p,globalState:j.globalState," +
  "getGlobalStateForHost:j.getGlobalStateForHost,desktopRoot:j.desktopRoot," +
  "preloadPath:j.preloadPath,repoRoot:j.repoRoot,disposables:k})," +
  "N=e=>M.isTrustedIpcSender(e.sender);wD({buildFlavor:a,isTrustedIpcEvent:N})";

test("accepts a genuine pure insertion", () => {
  const patched = patchCodexWindowServicesSource(ORIGINAL, CODEX_WINDOW_SERVICES_KEY);
  assert.ok(patched, "fixture should be patchable");
  assert.equal(patched.changed, true);
  verifyWindowServicesOutput(ORIGINAL, patched.source, "main.js");
});

test("rejects output that modified existing bytes", () => {
  const patched = patchCodexWindowServicesSource(ORIGINAL, CODEX_WINDOW_SERVICES_KEY);
  assert.ok(patched);
  const tampered = patched.source.replace("buildFlavor:a", "buildFlavor:z");
  assert.throws(
    () => verifyWindowServicesOutput(ORIGINAL, tampered, "main.js"),
    /not a pure insertion/,
  );
});

test("rejects an unbalanced insertion", () => {
  const broken = `${ORIGINAL.slice(0, 10)}globalThis.${CODEX_WINDOW_SERVICES_KEY}=M(;${ORIGINAL.slice(10)}`;
  assert.throws(
    () => verifyWindowServicesOutput(ORIGINAL, broken, "main.js"),
    /not bracket-balanced/,
  );
});

test("rejects an insertion that never lands the marker", () => {
  const markerless = `${ORIGINAL.slice(0, 10)}globalThis.somethingElse=M;${ORIGINAL.slice(10)}`;
  assert.throws(
    () => verifyWindowServicesOutput(ORIGINAL, markerless, "main.js"),
    /marker is absent/,
  );
});

test("rejects an insertion that landed the marker twice", () => {
  const patched = patchCodexWindowServicesSource(ORIGINAL, CODEX_WINDOW_SERVICES_KEY);
  assert.ok(patched);
  const doubled = patched.source.replace(
    `globalThis.${CODEX_WINDOW_SERVICES_KEY}=M;`,
    `globalThis.${CODEX_WINDOW_SERVICES_KEY}=M;globalThis.${CODEX_WINDOW_SERVICES_KEY}=M;`,
  );
  assert.throws(
    () => verifyWindowServicesOutput(ORIGINAL, doubled, "main.js"),
    /assigned 2 times, expected exactly once/,
  );
});

test("rejects output that did not grow", () => {
  assert.throws(
    () => verifyWindowServicesOutput(ORIGINAL, ORIGINAL, "main.js"),
    /not longer than input/,
  );
});
