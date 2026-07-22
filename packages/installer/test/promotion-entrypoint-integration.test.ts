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
import { join } from "node:path";
import test from "node:test";
import asar from "@electron/asar";
import {
  buildPromotionHealthExpectation,
  fingerprintPromotionPath,
  promotionSurfaceRoots,
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
  const userRoot = mkdtempSync(join(tmpdir(), "tweakers-candidate-launch-"));
  const candidateCodexHome = join(userRoot, "codex-home");
  const fakeSpawn = ((_command: string, _args: readonly string[], options: SpawnSyncOptions) => {
    observed = options;
    return { status: 0 } as ReturnType<typeof spawnSync>;
  }) as typeof spawnSync;
  try {
    spawnHiddenHealthProbe("/private/tmp/Codex", userRoot, {
      candidateCodexHome,
      spawn: fakeSpawn,
    });
    assert.equal(observed?.env?.TWEAKERS_CANDIDATE_MCP_RECONCILIATION, "1");
    assert.equal(observed?.env?.CODEX_HOME, candidateCodexHome);
    assert.equal(observed?.env?.TMPDIR, join(userRoot, "health", "tmp"));
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
