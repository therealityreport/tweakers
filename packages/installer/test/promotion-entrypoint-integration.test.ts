import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import {
  buildPromotionHealthExpectation,
  CANDIDATE_HEALTH_RECEIPT_REUSE_MS,
  fingerprintPromotionPath,
  promotionSurfaceRoots,
  readCandidatePromotionHealthExpectation,
  reuseCandidateHealthReceipt,
  spawnHiddenHealthProbe,
  stageCandidateCodexAuth,
  validateMainRendererAsarEntrypoint,
} from "../src/commands/install";
import { prepareDevSnapshot, rollbackDevSnapshot } from "../src/commands/dev-sync";
import { fingerprintPath } from "../src/user-questions-source";

function writeUserQuestions(root: string, version: string, marker: string): string {
  const tweak = join(root, "user-questions");
  mkdirSync(tweak, { recursive: true });
  writeFileSync(join(tweak, "manifest.json"), `${JSON.stringify({
    id: "co.tweakers.user-questions",
    name: "User Questions",
    version,
    githubRepo: "therealityreport/tweakers",
    scope: "both",
    permissions: ["settings", "filesystem", "ipc", "network"],
    mcp: { command: "node", args: ["mcp-server.js"] },
  }, null, 2)}\n`);
  writeFileSync(join(tweak, "index.js"), `module.exports = { start() {}, stop() {}, marker: ${JSON.stringify(marker)} };\n`);
  writeFileSync(join(tweak, "mcp-server.js"), "module.exports = { createMcpRuntime() {} };\n");
  writeFileSync(join(tweak, "broker-protocol.js"), "module.exports = { marker: 'broker' };\n");
  writeFileSync(join(tweak, "core.js"), "module.exports = { marker: 'schema' };\n");
  return tweak;
}

async function writeCandidateAsar(
  root: string,
  options: {
    rendererHtml?: string;
    rendererModule?: string;
  } = {},
): Promise<string> {
  const source = join(root, "asar-source");
  const archive = join(root, "app.asar");
  mkdirSync(join(source, ".vite", "build"), { recursive: true });
  mkdirSync(join(source, "webview", "assets"), { recursive: true });
  writeFileSync(join(source, "package.json"), `${JSON.stringify({
    name: "candidate-fixture",
    main: "tweaker-loader.cjs",
    __tweaker: {
      originalMain: ".vite/build/early-bootstrap.js",
      userRoot: join(root, "candidate-user"),
      loader: "tweaker-loader.cjs",
    },
  })}\n`);
  writeFileSync(join(source, "tweaker-loader.cjs"), "require('./.vite/build/early-bootstrap.js');\n");
  writeFileSync(join(source, ".vite", "build", "early-bootstrap.js"), "module.exports = true;\n");
  if (options.rendererHtml !== undefined) {
    writeFileSync(join(source, "webview", "index.html"), options.rendererHtml);
  }
  if (options.rendererModule !== undefined) {
    writeFileSync(join(source, "webview", "assets", "index.js"), options.rendererModule);
  }
  const stream = await asar.createPackage(source, archive);
  if (!(stream as NodeJS.WritableStream & { writableFinished?: boolean }).writableFinished) {
    await once(stream, "finish");
  }
  return archive;
}

const VALID_RENDERER_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"></head>
  <body><div id="root"></div><script type="module" src="./assets/index.js"></script></body>
</html>
`;

const installSource = readFileSync(new URL("../src/commands/install.ts", import.meta.url), "utf8");

test("a rehydrated promotion reuses only a fresh, fully passing candidate health receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "candidate-receipt-reuse-"));
  const receipt = join(root, "health", "promotion.json");
  const expected = {
    app: { version: "1.0.0", build: "100", hash: "app-hash" },
    runtimeHash: "runtime-hash",
    requiredPermissions: ["accessibility"],
  };
  const observedAt = "2026-08-20T12:00:00.000Z";
  const write = (overrides: Record<string, unknown> = {}) => {
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(receipt, JSON.stringify({
      schemaVersion: 1,
      observedAt,
      app: expected.app,
      runtimeHash: expected.runtimeHash,
      hostReady: "pass",
      authenticatedSession: "pass",
      declaredPermissions: { accessibility: "pass" },
      ...overrides,
    }), { mode: 0o600 });
    chmodSync(receipt, 0o600);
  };
  try {
    const fresh = new Date("2026-08-20T12:05:00.000Z");
    write();
    const reused = reuseCandidateHealthReceipt(receipt, expected, { now: fresh });
    assert.ok(reused);
    assert.equal(reused.host, "pass");
    assert.match(reused.detail ?? "", /reused the candidate build's health receipt/);

    // Stale beyond the reuse bound: a live probe must run.
    assert.equal(
      reuseCandidateHealthReceipt(receipt, expected, { now: new Date("2026-08-20T12:15:00.001Z") }),
      null,
    );
    assert.equal(CANDIDATE_HEALTH_RECEIPT_REUSE_MS, 15 * 60_000);

    // A failed or unknown session never qualifies.
    write({ authenticatedSession: "fail" });
    assert.equal(reuseCandidateHealthReceipt(receipt, expected, { now: fresh }), null);

    // A drifted candidate fingerprint invalidates the receipt outright.
    write();
    assert.equal(
      reuseCandidateHealthReceipt(receipt, { ...expected, app: { ...expected.app, hash: "drifted" } }, { now: fresh }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a held candidate's expectation twin rehydrates across transactions only when explicitly allowed", () => {
  const root = mkdtempSync(join(tmpdir(), "expectation-rebind-"));
  const file = join(root, "health", "expectation.json");
  const hash = "a".repeat(64);
  const expectation = {
    schemaVersion: 2,
    app: { version: "26.818.22352", build: "6872", hash },
    requiredPermissions: [],
    surfaces: {
      app: { preimageHash: hash, afterHash: hash },
      runtime: { preimageHash: hash, afterHash: hash },
      tweakTree: { preimageHash: hash, afterHash: hash },
      tweakersConfig: { preimageHash: hash, afterHash: hash },
      codexConfig: { preimageHash: hash, afterHash: hash },
      namespaceData: { preimageHash: hash, afterHash: hash },
      mainStorage: { preimageHash: hash, afterHash: hash },
      policy: { preimageHash: hash, afterHash: hash },
    },
    userQuestions: { id: "co.tweakers.user-questions", version: "1.0.0", payloadHash: hash },
  };
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // repair built and held the candidate at 12:00; a NEW install transaction
    // adopting it starts at 12:30 (live failure 2026-08-20).
    writeFileSync(file, JSON.stringify({ ...expectation, requestedAt: "2026-08-20T12:00:00.000Z" }), { mode: 0o600 });
    chmodSync(file, 0o600);
    const bounds = {
      transactionCreatedAt: "2026-08-20T12:30:00.000Z",
      now: new Date("2026-08-20T12:35:00.000Z"),
      maxAgeMs: 24 * 60 * 60 * 1_000,
    };

    // Strict callers (same-record continuations) still reject the earlier twin.
    assert.equal(readCandidatePromotionHealthExpectation(file, bounds), null);
    // The adoption path accepts it; the caller re-binds via the candidate
    // app-fingerprint check immediately afterwards.
    const adopted = readCandidatePromotionHealthExpectation(file, { ...bounds, allowEarlierRequest: true });
    assert.ok(adopted);
    assert.equal(adopted.app.build, "6872");

    // The age bound still applies even with adoption allowed.
    assert.equal(
      readCandidatePromotionHealthExpectation(file, {
        ...bounds,
        allowEarlierRequest: true,
        now: new Date("2026-08-21T12:00:00.001Z"),
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("post-promotion health requires a clean probe exit before its receipt can be accepted", () => {
  const start = installSource.indexOf("openApp: (appRoot) => {");
  const end = installSource.indexOf("\n    },\n  });", start);
  assert.ok(start >= 0 && end > start);
  const openApp = installSource.slice(start, end);
  assert.match(openApp, /const launched = spawnAuthenticatedHiddenHealthProbe\(/);
  assert.match(openApp, /launched\.error \|\| launched\.status !== 0 \|\| launched\.signal !== null/);
  // A probe killed by the 170s spawnSync timeout and a probe that exited 3 are
  // the same refusal but very different bugs, and this throw is the only record
  // either one leaves: the probe answers inside a disposable root that is
  // deleted with it. The message must name which happened.
  assert.match(openApp, /throw new Error\(`Post-promotion \$\{formatHealthProbeLaunchFailure\(launched\)\}`\)/);
});

test("candidate authentication proof is private, contained, and removed after the one-shot probe", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-promotion-auth-"));
  try {
    const liveCodexHome = join(root, "live-codex");
    const candidateCodexHome = join(root, "candidate", "codex-home");
    mkdirSync(liveCodexHome, { recursive: true, mode: 0o700 });
    mkdirSync(candidateCodexHome, { recursive: true, mode: 0o700 });
    const liveAuth = join(liveCodexHome, "auth.json");
    const candidateAuth = join(candidateCodexHome, "auth.json");
    writeFileSync(liveAuth, JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "fixture-only" } }), { mode: 0o600 });
    chmodSync(liveAuth, 0o600);

    const cleanup = stageCandidateCodexAuth(liveCodexHome, candidateCodexHome);
    assert.equal(readFileSync(candidateAuth, "utf8"), readFileSync(liveAuth, "utf8"));
    assert.equal(lstatSync(candidateAuth).isSymbolicLink(), false);
    assert.equal(lstatSync(candidateAuth).mode & 0o777, 0o600);
    cleanup();
    assert.equal(existsSync(candidateAuth), false);

    const target = join(root, "unsafe-auth.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    rmSync(liveAuth);
    symlinkSync(target, liveAuth);
    assert.throws(() => stageCandidateCodexAuth(liveCodexHome, candidateCodexHome));
    assert.equal(existsSync(candidateAuth), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate health process receives only the contained Codex home opt-in", () => {
  let observed: SpawnSyncOptions | null = null;
  let probeRoot = "";
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-candidate-launch-"));
  const candidateCodexHome = join(userRoot, "codex-home");
  mkdirSync(candidateCodexHome, { mode: 0o700 });
  const fakeSpawn = ((_command: string, _args: readonly string[], options: SpawnSyncOptions) => {
    observed = options;
    probeRoot = options.env?.HOME ?? "";
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;
  try {
    spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      candidateCodexHome,
      spawn: fakeSpawn,
    });
    assert.equal(observed?.env?.TWEAKERS_CANDIDATE_MCP_RECONCILIATION, "1");
    assert.equal(observed?.env?.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN, "1");
    assert.equal(observed?.env?.HOME, probeRoot);
    assert.equal(observed?.env?.CODEX_HOME, join(probeRoot, "codex-home"));
    assert.equal(observed?.env?.TMPDIR, join(probeRoot, "tmp"));
    assert.equal(existsSync(probeRoot), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("candidate ASAR validation proves the original bootstrap and real main renderer", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-promotion-renderer-valid-"));
  try {
    const archive = await writeCandidateAsar(root, {
      rendererHtml: VALID_RENDERER_HTML,
      rendererModule: "document.documentElement.dataset.ready = 'true';\n",
    });
    assert.doesNotThrow(() => validateMainRendererAsarEntrypoint(archive));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate ASAR validation fails closed when the renderer would did-fail-load with ERR_FAILED", async (t) => {
  const cases = [
    {
      name: "missing webview index",
      rendererHtml: undefined,
      rendererModule: "export {};\n",
      error: /missing required entry: webview\/index\.html/,
    },
    {
      name: "truncated webview index",
      rendererHtml: "<!doctype html><html><head></head><body><div id=\"root\">",
      rendererModule: "export {};\n",
      error: /webview\/index\.html is corrupt or truncated/,
    },
    {
      name: "missing renderer module bootstrap",
      rendererHtml: VALID_RENDERER_HTML,
      rendererModule: undefined,
      error: /missing required entry: webview\/assets\/index\.js/,
    },
  ] as const;
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const root = mkdtempSync(join(tmpdir(), "tweaker-promotion-renderer-invalid-"));
      try {
        const archive = await writeCandidateAsar(root, fixture);
        // The fixture deliberately retains a valid Tweakers loader marker. A
        // health-only receipt must not be able to promote over this failure.
        assert.throws(() => validateMainRendererAsarEntrypoint(archive), fixture.error);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("promotion health binds the pending managed snapshot, not the old live User Questions tree", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-promotion-snapshot-"));
  try {
    const userRoot = join(root, "user");
    const liveTweaks = join(userRoot, "tweaks");
    const builtTweaks = join(root, "built", "tweaks");
    const runtimeRoot = join(userRoot, "runtime");
    const codexHome = join(root, "codex-home");
    mkdirSync(liveTweaks, { recursive: true });
    mkdirSync(builtTweaks, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(runtimeRoot, "main.js"), "// candidate runtime\n");
    writeFileSync(join(codexHome, ".codex-global-state.json"), `${JSON.stringify({
      "electron-openai-mcp-form-elicitations-enabled": false,
      "electron-persisted-atom-state": {
        "agent-mode-by-host-id": { local: "custom" },
        "heartbeat-thread-permissions-by-id": {},
      },
    })}\n`, { mode: 0o600 });
    chmodSync(join(codexHome, ".codex-global-state.json"), 0o600);

    const oldUserQuestions = writeUserQuestions(liveTweaks, "0.4.10", "old-live");
    const oldPayloadHash = fingerprintPath(oldUserQuestions).hash;
    writeUserQuestions(builtTweaks, "0.5.0", "candidate");
    const custom = join(liveTweaks, "personal-notes");
    mkdirSync(custom);
    writeFileSync(join(custom, "README.txt"), "preserve me\n");
    writeFileSync(join(liveTweaks, ".tweaker-dev-snapshot.json"), JSON.stringify({ folders: ["user-questions"] }));

    const pending = prepareDevSnapshot(builtTweaks, liveTweaks);
    assert.equal(pending.phase, "pending_acceptance");
    assert.equal(JSON.parse(readFileSync(join(liveTweaks, "user-questions", "manifest.json"), "utf8")).version, "0.5.0");
    assert.equal(readFileSync(join(custom, "README.txt"), "utf8"), "preserve me\n");

    const appHash = "a".repeat(64);
    const roots = promotionSurfaceRoots({
      appHash,
      runtimeRoot,
      tweaksRoot: liveTweaks,
      userRoot,
      tweakersConfigPath: join(userRoot, "config.json"),
      codexHome,
    });
    const expectation = buildPromotionHealthExpectation({
      app: { version: "1.0.0", build: "fixture", hash: appHash },
      before: roots,
      after: roots,
      requiredPermissions: [],
      userQuestionsRoot: join(liveTweaks, "user-questions"),
    });
    assert.equal(expectation.userQuestions.version, "0.5.0");
    assert.equal(expectation.userQuestions.payloadHash, fingerprintPath(join(liveTweaks, "user-questions")).hash);
    assert.notEqual(expectation.userQuestions.payloadHash, oldPayloadHash);
    assert.equal(expectation.surfaces.tweakTree.afterHash, fingerprintPromotionPath(liveTweaks));

    rollbackDevSnapshot(liveTweaks);
    assert.equal(JSON.parse(readFileSync(join(liveTweaks, "user-questions", "manifest.json"), "utf8")).version, "0.4.10");
    assert.equal(readFileSync(join(custom, "README.txt"), "utf8"), "preserve me\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
