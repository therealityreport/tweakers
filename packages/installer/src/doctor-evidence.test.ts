import asar from "@electron/asar";
import assert from "node:assert/strict";
import { finished } from "node:stream/promises";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import plist from "plist";
import {
  collectDoctorSourceEvidence,
  compareDoctorSourceEvidence,
  setDoctorSourceEvidenceDependenciesForTest,
  type DoctorSourceEvidence,
} from "./doctor-evidence.js";
import { buildDoctorChangeReport, refreshDoctorChangeReportClassifications } from "./doctor-change-analysis.js";
import { doctorDigest } from "./doctor-store.js";
import { changeReportFingerprint } from "./doctor-adoption.js";
import { changelogEntryId, validateDoctorChangelog } from "./doctor-changelog.js";

interface FixtureOptions {
  backend?: string | null;
  schema?: Record<string, unknown>;
  asarFiles?: Record<string, string>;
  extraFiles?: Record<string, string>;
  symlink?: { path: string; target: string };
}

test("collector records complete deterministic inventories without scanning an installed app", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-complete-"));
  const restore = installFakeBackend();
  try {
    const app = await createFixture(root, "fixture.app", {
      asarFiles: {
        "package.json": JSON.stringify({ main: ".vite/build/main-A1b2C3d4.js" }),
        ".vite/build/main-A1b2C3d4.js": "require('./helper-B2c3D4e5.js')",
        ".vite/build/helper-B2c3D4e5.js": "module.exports = 1",
      },
      extraFiles: { "Contents/Resources/plain.txt": "plain" },
      symlink: { path: "Contents/Resources/plain-link", target: "plain.txt" },
    });
    const first = await collectDoctorSourceEvidence(app, join(root, "output-one"));
    const second = await collectDoctorSourceEvidence(app, join(root, "output-two"));

    assert.equal(first.complete, true);
    assert.equal(first.collectorVersion, 3);
    assert.equal(first.schemas.root, join(root, "output-one", "app-server-schema"));
    assert.equal(second.schemas.root, join(root, "output-two", "app-server-schema"));
    assert.equal(first.fingerprint, second.fingerprint, "output location must not affect the content fingerprint");
    assert.deepEqual(first.shippedFiles.map((entry) => entry.path), [...first.shippedFiles.map((entry) => entry.path)].sort());
    assert.ok(first.shippedFiles.some((entry) => entry.path === "Contents/Resources/plain.txt" && entry.kind === "file"));
    assert.ok(first.shippedFiles.some((entry) => entry.path === "Contents/Resources/plain-link" && entry.kind === "symlink"));
    assert.deepEqual(first.asar.members.map((entry) => entry.path), [
      ".vite/build/helper-B2c3D4e5.js",
      ".vite/build/main-A1b2C3d4.js",
      "package.json",
    ]);
    assert.equal(first.schemas.state, "complete");
    assert.equal(existsSync(join(root, "output-one", "app-server-schema", "v2", "ClientRequest.json")), true);
    const persisted = JSON.parse(readFileSync(join(root, "output-one", "doctor-source-evidence.json"), "utf8")) as DoctorSourceEvidence;
    assert.equal(persisted.fingerprint, first.fingerprint);
    const rejectExecution = setDoctorSourceEvidenceDependenciesForTest({run() { throw new Error("Unexpected backend execution for valid cached evidence"); }});
    try {
      assert.deepEqual(await collectDoctorSourceEvidence(app, join(root,"output-one")), first);
    } finally { rejectExecution(); }
    rmSync(join(root,"output-one","app-server-schema"),{recursive:true,force:true});
    const regenerated = await collectDoctorSourceEvidence(app,join(root,"output-one"));
    assert.equal(regenerated.fingerprint,first.fingerprint);
    assert.ok(existsSync(join(root,"output-one","app-server-schema","v2","ClientRequest.json")));
    writeFileSync(join(app,"Contents/Resources/plain.txt"),"changed");
    assert.notEqual((await collectDoctorSourceEvidence(app,join(root,"output-one"))).fingerprint,first.fingerprint);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("collector regenerates legacy or unbound schema caches without changing source identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-cache-upgrade-"));
  let generations = 0;
  const restore = setDoctorSourceEvidenceDependenciesForTest({
    run(command, args) {
      if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: `codex-cli ${readFileSync(command, "utf8").trim()}\n` };
      generations += 1;
      const schemaPath = join(args[4]!, "v2", "ClientRequest.json");
      mkdirSync(dirname(schemaPath), { recursive: true });
      writeFileSync(schemaPath, JSON.stringify({ type: "object", backend: readFileSync(command, "utf8").trim() }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const app = await createFixture(root, "fixture.app");
    const output = join(root, "output");
    const first = await collectDoctorSourceEvidence(app, output);
    const persistedPath = join(output, "doctor-source-evidence.json");
    const legacy = JSON.parse(readFileSync(persistedPath, "utf8")) as DoctorSourceEvidence;
    legacy.collectorVersion = 2;
    writeFileSync(persistedPath, JSON.stringify(legacy));
    const upgraded = await collectDoctorSourceEvidence(app, output);
    const unbound = JSON.parse(readFileSync(persistedPath, "utf8")) as DoctorSourceEvidence;
    delete unbound.schemas.root;
    writeFileSync(persistedPath, JSON.stringify(unbound));
    const rebound = await collectDoctorSourceEvidence(app, output);
    assert.equal(generations, 3);
    assert.equal(upgraded.fingerprint, first.fingerprint);
    assert.equal(rebound.fingerprint, first.fingerprint);
    assert.equal(rebound.schemas.root, join(output, "app-server-schema"));
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("collector rejects a preexisting schema-root symlink", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-schema-root-link-"));
  const restore = installFakeBackend();
  try {
    const app = await createFixture(root, "fixture.app");
    const output = join(root, "output");
    const schemaRoot = join(output, "app-server-schema");
    const external = join(root, "external-schema");
    mkdirSync(output, { recursive: true });
    mkdirSync(external, { recursive: true });
    symlinkSync(external, schemaRoot);
    await assert.rejects(() => collectDoctorSourceEvidence(app, output), (error) =>
      error instanceof Error && error.message === `Doctor output path must not be a symlink: ${schemaRoot}`);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("collector regenerates tampered same-size schema bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-schema-tamper-"));
  let generations = 0;
  const restore = setDoctorSourceEvidenceDependenciesForTest({
    run(command, args) {
      if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: `codex-cli ${readFileSync(command, "utf8").trim()}\n` };
      generations += 1;
      const schemaPath = join(args[4]!, "v2", "ClientRequest.json");
      mkdirSync(dirname(schemaPath), { recursive: true });
      writeFileSync(schemaPath, JSON.stringify({ type: "object", backend: readFileSync(command, "utf8").trim() }));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const app = await createFixture(root, "fixture.app", { backend: "backend-one" });
    const output = join(root, "output");
    const first = await collectDoctorSourceEvidence(app, output);
    const schemaPath = join(output, "app-server-schema", "v2", "ClientRequest.json");
    const expected = readFileSync(schemaPath, "utf8");
    writeFileSync(schemaPath, expected.replace("backend-one", "backend-Xne"));
    const regenerated = await collectDoctorSourceEvidence(app, output);
    assert.equal(generations, 2);
    assert.equal(regenerated.fingerprint, first.fingerprint);
    assert.equal(readFileSync(schemaPath, "utf8"), expected);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("collector records generator-emitted schema symlinks as invalid output", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-schema-link-output-"));
  const restore = setDoctorSourceEvidenceDependenciesForTest({
    run(command, args) {
      if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: `codex-cli ${readFileSync(command, "utf8").trim()}\n` };
      const schemaRoot = args[4]!;
      const target = join(schemaRoot, "target.json");
      mkdirSync(schemaRoot, { recursive: true });
      writeFileSync(target, "{}");
      symlinkSync("target.json", join(schemaRoot, "ClientRequest.json"));
      return { status: 0, stdout: "" };
    },
  });
  try {
    const app = await createFixture(root, "fixture.app");
    const evidence = await collectDoctorSourceEvidence(app, join(root, "output"));
    assert.equal(evidence.schemas.state, "invalid_output");
    assert.equal(evidence.schemas.problem, "Schema generator emitted symbolic links");
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("comparison maps a frontend-only change to renderer compatibility checks", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-frontend-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", {
      asarFiles: { "webview/assets/app-A1b2C3d4.js": "export const value = 1" },
    });
    const afterApp = await createFixture(root, "after.app", {
      asarFiles: { "webview/assets/app-A1b2C3d4.js": "export const value = 2" },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);

    const renderer = comparison.changes.find((change) => change.artifact === "asar_member");
    assert.equal(renderer?.path, "webview/assets/app-A1b2C3d4.js");
    assert.equal(renderer?.area, "frontend");
    assert.equal(renderer?.relevance, "relevant");
    assert.ok(comparison.requiredChecks.includes("frontend-patch-compatibility"));
    assert.equal(comparison.unresolvedEvidence.length, 0);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("unclassified ownership does not make a complete comparison incomplete", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-unclassified-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", {
      extraFiles: { "Contents/Resources/opaque/new-tool.data": "before" },
    });
    const afterApp = await createFixture(root, "after.app", {
      extraFiles: { "Contents/Resources/opaque/new-tool.data": "after" },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);

    const unclassified = comparison.changes.find((change) =>
      change.artifact === "shipped_file" && change.path === "Contents/Resources/opaque/new-tool.data");
    assert.equal(unclassified?.relevance, "unresolved");
    assert.equal(unclassified?.area, "unknown");
    assert.equal(unclassified?.tweakersOwnership, null);
    assert.equal(comparison.complete, true);
    assert.deepEqual(comparison.unresolvedEvidence, []);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparison distinguishes executable code, assets, locales, native modules, and metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-classification-"));
  const restore = installFakeBackend();
  const latestResources = {
    "Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/dist/launch.js": "helpers",
    "Contents/Resources/cua_node/bin/setup.ps1": "helpers",
    "Contents/Resources/cua_node/lib/node_modules/.bin/cua-repl": "helpers",
    "Contents/Resources/busy-bar.asar": "helpers",
    "Contents/Resources/artifact-template-picker/server.mjs": "helpers",
    "Contents/Resources/cua_node/manifest.json": "package_metadata",
    "Contents/Resources/cua_node/lib/node_modules/.pnpm/lock.yaml": "package_metadata",
    "Contents/Resources/owl-electron-app.json": "package_metadata",
    "Contents/Resources/THIRD_PARTY_NOTICES.txt": "packaging",
  };

  try {
    const beforeApp = await createFixture(root, "before.app", {
      asarFiles: {
        "webview/assets/app-A1b2C3d4.js": "export const value = 1",
        "webview/assets/logo.png": "image-one",
        "native-menu-locales/sv-SE.json": JSON.stringify({ quit: "Avsluta" }),
        "node_modules/example/prebuilds/darwin-arm64/example.node": "native-one",
      },
      extraFiles: {
        "Contents/Resources/codex_chronicle": "executable-one",
        "Contents/Resources/owl-app.ini": "channel=one",
        ...Object.fromEntries(Object.keys(latestResources).map(path => [path, `before ${path}`])),
      },
    });
    const afterApp = await createFixture(root, "after.app", {
      asarFiles: {
        "webview/assets/app-A1b2C3d4.js": "export const value = 2",
        "webview/assets/logo.png": "image-two",
        "native-menu-locales/sv-SE.json": JSON.stringify({ quit: "Stang" }),
        "node_modules/example/prebuilds/darwin-arm64/example.node": "native-two",
      },
      extraFiles: {
        "Contents/Resources/codex_chronicle": "executable-two",
        "Contents/Resources/owl-app.ini": "channel=two",
        ...Object.fromEntries(Object.keys(latestResources).map(path => [path, `after ${path}`])),
      },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const changes = compareDoctorSourceEvidence(before, after).changes;
    const classification = (path: string) => changes.find((change) => change.path === path);
    for (const [path, area] of Object.entries(latestResources)) {
      assert.equal(classification(path)?.area, area, path);
      assert.equal(classification(path)?.relevance, "relevant", path);
      assert.ok(classification(path)!.requiredChecks.length > 0, path);
    }

    assert.deepEqual(
      [classification("webview/assets/app-A1b2C3d4.js")?.area, classification("webview/assets/app-A1b2C3d4.js")?.requiredChecks],
      ["frontend", ["frontend-patch-compatibility"]],
    );
    assert.deepEqual(
      [classification("webview/assets/logo.png")?.area, classification("webview/assets/logo.png")?.requiredChecks],
      ["static_assets", ["static-asset-integrity"]],
    );
    assert.deepEqual(
      [classification("native-menu-locales/sv-SE.json")?.area, classification("native-menu-locales/sv-SE.json")?.requiredChecks],
      ["localization", ["localization-resource-compatibility"]],
    );
    assert.deepEqual(
      [classification("node_modules/example/prebuilds/darwin-arm64/example.node")?.area, classification("node_modules/example/prebuilds/darwin-arm64/example.node")?.requiredChecks],
      ["native_modules", ["native-module-abi-compatibility"]],
    );
    assert.deepEqual(
      [classification("Contents/Resources/codex_chronicle")?.area, classification("Contents/Resources/codex_chronicle")?.requiredChecks],
      ["desktop_executables", ["bundled-executable-compatibility"]],
    );
    assert.deepEqual(
      [classification("Contents/Resources/owl-app.ini")?.area, classification("Contents/Resources/owl-app.ini")?.requiredChecks],
      ["package_metadata", ["package-metadata-integrity"]],
    );
    for (const path of [
      "webview/assets/app-A1b2C3d4.js",
      "webview/assets/logo.png",
      "native-menu-locales/sv-SE.json",
      "node_modules/example/prebuilds/darwin-arm64/example.node",
      "Contents/Resources/codex_chronicle",
      "Contents/Resources/owl-app.ini",
    ]) assert.equal(classification(path)?.relevance, "relevant");
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("hash-like external references remain meaningful changes when absent from the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-external-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", {
      asarFiles: { "webview/index.html": '<script src="https://example.invalid/remote-A1b2C3d4.js"></script>' },
    });
    const afterApp = await createFixture(root, "after.app", {
      asarFiles: { "webview/index.html": '<script src="https://example.invalid/remote-E5f6G7h8.js"></script>' },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    assert.notEqual(before.asar.members[0]!.semanticSha256, after.asar.members[0]!.semanticSha256);
    const comparison = compareDoctorSourceEvidence(before, after);
    assert.equal(comparison.changes.find(change => change.path === "webview/index.html")?.relevance, "relevant");
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("comparison records backend and generated schema changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-backend-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { backend: "backend-one" });
    const afterApp = await createFixture(root, "after.app", { backend: "backend-two" });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);

    assert.ok(comparison.changes.some((change) => change.path === "Contents/Resources/codex" && change.area === "backend"));
    assert.ok(comparison.changes.some((change) => change.artifact === "schema" && change.area === "schema"));
    assert.ok(comparison.requiredChecks.includes("backend-version-and-app-server-compatibility"));
    assert.ok(comparison.requiredChecks.includes("generated-app-server-schema-compatibility"));
    assert.equal(comparison.backendSourceComparison.status, "not_attempted");
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "schema", implementationFingerprint: "implementation" });
    const schema = report.changes.find((change) => change.evidence.some((item) => item.artifact === "schema"));
    assert.equal(schema?.status, "observed");
    assert.equal(report.limitations.some((problem) => problem.includes("schema output root")), false);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparison reports byte-identical ASAR member renames explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-rename-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", {
      asarFiles: {
        "webview/index.html": "<script src=\"assets/chunk-A1b2C3d4.js\"></script>",
        "webview/assets/chunk-A1b2C3d4.js": "export const stable = true",
      },
    });
    const afterApp = await createFixture(root, "after.app", {
      asarFiles: {
        "webview/index.html": "<script src=\"assets/chunk-E5f6G7h8.js\"></script>",
        "webview/assets/chunk-E5f6G7h8.js": "export const stable = true",
      },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);

    assert.ok(comparison.renamedIdenticalArtifacts.some((rename) =>
      rename.artifact === "asar_member"
      && rename.fromPath === "webview/assets/chunk-A1b2C3d4.js"
      && rename.toPath === "webview/assets/chunk-E5f6G7h8.js"
      && rename.area === "frontend"));
    assert.equal(comparison.changes.some((change) => change.path.includes("chunk-")), false);
    assert.equal(comparison.changes.find((change) => change.path === "webview/index.html")?.semanticEquivalent, true);
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "job-normalized", implementationFingerprint: "implementation-normalized" });
    const normalized = report.changes.flatMap((change) => change.evidence).find((item) => item.path === "webview/index.html");
    assert.match(normalized?.detail ?? "", /does not establish behavioral equivalence/);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing backend and schema evidence blocks completeness", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-evidence-missing-"));
  const restore = installFakeBackend();
  try {
    const app = await createFixture(root, "missing.app", { backend: null });
    const evidence = await collectDoctorSourceEvidence(app, join(root, "output"));
    assert.equal(evidence.complete, false);
    assert.equal(evidence.backend.sha256, null);
    assert.equal(evidence.schemas.state, "missing_backend");
    assert.ok(evidence.unresolvedEvidence.some((problem) => problem.startsWith("backend-missing:")));
    assert.ok(evidence.unresolvedEvidence.some((problem) => problem.startsWith("schema-missing_backend:")));
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("change analysis groups extracted routes and links changed imports by report change ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-workflow-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/main.js": "import { helper } from './helper.js'; import { unused } from './accounts-extra.js'; import './side-effect.js'; const [,, optional] = [1,2,3]; const bridge = () => helper(); export const screen = () => router.get('/projects', bridge, 'before'); export const refreshed = false;",
      "webview/helper.js": "export const helper = () => log.info('before');",
      "webview/accounts-extra.js": "export const unused = () => router.get('/accounts', {label:'Old'});",
      "webview/side-effect.js": "router.get('/notifications', {label:'Old notice'});",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/main.js": "import { helper } from './helper.js'; import { unused } from './accounts-extra.js'; import './side-effect.js'; const [,, optional] = [1,2,3]; const bridge = () => helper(); export const screen = () => router.get('/projects', bridge, 'after'); export const refreshed = true;",
      "webview/helper.js": "export const helper = () => log.info('after');",
      "webview/accounts-extra.js": "export const unused = () => router.get('/accounts', {label:'New'});",
      "webview/side-effect.js": "router.get('/notifications', {label:'New notice'});",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "job-workflow", implementationFingerprint: "implementation-one" });

    const workflow = report.changes.find((change) => change.area === "workflow:/projects");
    const helper = report.changes.find((change) => change.evidence.some((item) => item.path === "webview/helper.js"));
    assert.ok(workflow);
    assert.ok(helper);
    assert.ok(!report.limitations.some(item => item.includes("indexing failed")));
    assert.equal(report.analysisVersion, 2);
    assert.equal(report.analysisImplementationVersion, 6);
    assert.deepEqual(workflow.reviewWork, {
      version: 1,
      kind: "behavior",
      reasonCode: "changed_behavior",
      question: "What changed in projects and workspaces navigation?",
    });
    assert.equal(helper.reviewWork?.kind, "evidence_needed");
    assert.equal(helper.reviewWork?.reasonCode, "unclassified_change");
    assert.match(workflow.before, /Extracted route references: \/projects/);
    assert.match(workflow.after, /Extracted exports: screen/);
    assert.ok(workflow.dependencies.includes(helper.id), "imports reached through unchanged local helpers remain dependencies");
    const sideEffect = report.changes.find(change => change.area === "workflow:/notifications")!;
    assert.ok(workflow.dependencies.includes(sideEffect.id), "side-effect imports remain dependencies");
    const unused = report.changes.find(change => change.area === "workflow:/accounts")!;
    assert.ok(unused);
    assert.ok(!workflow.dependencies.includes(unused.id), "an unused file import does not couple every syntax unit");
    const archive = report.changes.find((change) => change.evidence.some((item) => item.path === "Contents/Resources/app.asar"));
    assert.ok(archive?.technicalOnly);
    assert.ok(workflow.dependencies.includes(archive.id));
    assert.match(archive.evidence[0]!.detail, /member-level evidence/);
    assert.equal(workflow.status, "unknown", "a changed literal argument alone does not establish visible behavior");
    assert.equal(workflow.technicalOnly, false);
    assert.deepEqual(workflow.overrides, []);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis deduplicates related source units into one behavior question", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-questions-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/settings-panel.js": "export const panel = () => router.get('/settings', {label:'Theme', onChange:saveOld});",
      "webview/settings-row.js": "export const row = () => router.get('/settings', {label:'Appearance', onClick:openOld});",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/settings-panel.js": "export const panel = () => router.get('/settings', {label:'Color theme', onChange:saveNew});",
      "webview/settings-row.js": "export const row = () => router.get('/settings', {label:'Appearance settings', onClick:openNew});",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const report = await buildDoctorChangeReport({ before, after, comparison: compareDoctorSourceEvidence(before, after),
      jobId: "job-questions", implementationFingerprint: "implementation-questions" });
    const questions = report.changes.filter((change) => change.reviewWork?.kind === "behavior");

    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.reviewWork?.question, "What changed in settings navigation?");
    assert.deepEqual(questions[0]!.evidence.map((item) => item.path).sort(), ["webview/settings-panel.js", "webview/settings-row.js"]);
    assert.ok(questions[0]!.evidence.every((item) => item.beforeFocus && item.afterFocus));
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis does not infer a feature claim from a no-route export delta", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-export-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/feature.js": "export const oldFeature = true;",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/feature.js": "export const newFeature = true;",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "job-export", implementationFingerprint: "implementation-export" });
    const feature = report.changes.find((change) => change.evidence.some((item) => item.path === "webview/feature.js"));

    assert.equal(feature?.status, "unknown");
    assert.equal(feature?.technicalOnly, false);
    assert.equal(feature?.reviewWork?.kind, "evidence_needed");
    assert.equal(feature?.reviewWork?.reasonCode, "unclassified_change");
    assert.match(feature?.before ?? "", /Extracted exports: oldFeature/);
    assert.match(feature?.after ?? "", /Extracted exports: newFeature/);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis leaves parsable JavaScript body changes unknown when its extracted index is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-index-invisible-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/feature.js": "export function featureEnabled() { return false; }",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/feature.js": "export function featureEnabled() { return true; }",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "job-index-invisible", implementationFingerprint: "implementation-index-invisible" });
    const feature = report.changes.find((change) => change.evidence.some((item) => item.path === "webview/feature.js"));

    assert.equal(feature?.status, "unknown");
    assert.equal(feature?.technicalOnly, false);
    assert.equal(report.coverage.classified + report.coverage.unresolved, report.coverage.total);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis types unsupported JavaScript without inventing behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-unsupported-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: { "webview/broken.js": "export const value = ;" } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: { "webview/broken.js": "export const value = ???;" } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const report = await buildDoctorChangeReport({ before, after, comparison: compareDoctorSourceEvidence(before, after),
      jobId: "job-unsupported", implementationFingerprint: "implementation-unsupported" });
    const change = report.changes.find((item) => item.evidence.some((evidence) => evidence.path === "webview/broken.js"));

    assert.equal(change?.status, "unknown");
    assert.equal(change?.reviewWork?.kind, "evidence_needed");
    assert.equal(change?.reviewWork?.reasonCode, "unsupported_syntax");
    assert.equal(change?.evidence[0]?.beforeFocus, null);
    assert.equal(change?.evidence[0]?.afterFocus, null);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis conservatively pairs uniquely matching changed JavaScript paths without claiming equivalence", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-structural-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/old.js": "import { dep } from './dep.js'; export const page = () => router.get('/settings', dep);",
      "webview/dep.js": "export const dep = 1;",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/new.js": "import { dep } from './dep.js'; export const page = () => router.get('/settings', dep + 1);",
      "webview/dep.js": "export const dep = 1;",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);
    const report = await buildDoctorChangeReport({ before, after, comparison, jobId: "job-structural", implementationFingerprint: "implementation-two" });

    const matched = report.changes.flatMap((change) => change.evidence).find((item) => item.path === "webview/old.js -> webview/new.js");
    assert.ok(matched);
    assert.match(matched.detail, /does not establish behavioral equivalence/);
    assert.equal(report.coverage.classified + report.coverage.unresolved, report.coverage.total);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis keeps opaque binaries unknown, bounded, deterministic, and unverified", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-opaque-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", {
      extraFiles: { "Contents/Resources/opaque/tool.bin": "\u0000before", "Contents/Resources/opaque/readable.bin": "before text" },
      asarFiles: { "webview/logo.png": "\u0000before" },
    });
    const afterApp = await createFixture(root, "after.app", {
      extraFiles: { "Contents/Resources/opaque/tool.bin": "\u0000after", "Contents/Resources/opaque/readable.bin": "after text" },
      asarFiles: { "webview/logo.png": "\u0000after" },
    });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const comparison = compareDoctorSourceEvidence(before, after);
    const checkpointDirectory = join(realpathSync(root), "checkpoints");
    const input = { before, after, comparison, jobId: "job-opaque", implementationFingerprint: "implementation-three", checkpointDirectory };
    const first = await buildDoctorChangeReport(input);
    const checkpoint = join(checkpointDirectory, readdirSync(checkpointDirectory)[0]!);
    const checkpointInode = statSync(checkpoint).ino;
    const second = await buildDoctorChangeReport(input);
    const opaque = first.changes.find((change) => change.evidence.some((item) => item.path === "Contents/Resources/opaque/tool.bin"));
    const readable = first.changes.find((change) => change.evidence.some((item) => item.path === "Contents/Resources/opaque/readable.bin"));
    const binary = first.changes.find((change) => change.evidence.some((item) => item.path === "webview/logo.png"));

    assert.equal(opaque?.status, "unknown");
    assert.equal(binary?.status, "unknown");
    assert.equal(readable?.status, "unknown");
    assert.equal(opaque?.unknownPolicy, "acknowledgment");
    assert.equal(binary?.unknownPolicy, "blocking");
    assert.deepEqual(opaque?.reviewWork, { version: 1, kind: "observation_limit", reasonCode: "opaque_binary",
      question: "What observable behavior changed for Contents/Resources/opaque/tool.bin? Static inspection cannot interpret its opaque bytes." });
    assert.deepEqual(readable?.reviewWork, { version: 1, kind: "evidence_needed", reasonCode: "unclassified_change",
      question: "What behavior changed for Contents/Resources/opaque/readable.bin? The full source is hash-bound, but no supported behavior anchor was found." });
    assert.equal(readable?.unknownPolicy, "blocking");
    assert.equal(binary?.reviewWork?.kind, "observation_limit");
    assert.ok(first.changes.flatMap(change => change.evidence).every(evidence => evidence.kind === "static"));
    assert.equal(opaque?.technicalOnly, false);
    assert.deepEqual(opaque?.overrides, []);
    assert.equal(first.candidateFingerprint, null);
    assert.equal(first.coverage.classified + first.coverage.unresolved, first.coverage.total);
    assert.equal(first.fingerprint, second.fingerprint);
    const { fingerprint: _fingerprint, ...payload } = first;
    assert.equal(first.fingerprint, doctorDigest(payload));
    assert.ok(first.limitations.some((value) => value.includes("No exact GitHub revision")));
    assert.ok(first.limitations.some((value) => value.includes("No native application behavior")));
    assert.ok(first.limitations.some((value) => value.includes("Tweakers adaptation")));

    const retained = structuredClone(first);
    const retainedOpaque = retained.changes.find(change => change.id === opaque?.id)!;
    const retainedReadable = retained.changes.find(change => change.id === readable?.id)!;
    retainedOpaque.explanation = { summary: "Retained exact-evidence explanation.", evidenceReferences: [], sourceReferences: [] };
    retainedReadable.explanation = { summary: "The old classifier treated this as opaque.", evidenceReferences: [], sourceReferences: [] };
    retainedReadable.reviewWork = { version: 1, kind: "observation_limit", reasonCode: "opaque_binary",
      question: "Static inspection cannot interpret the old opaque classification." };
    retainedReadable.unknownPolicy = "acknowledgment";
    retainedReadable.overrides = [{ id: "stale-override", label: "Stale override",
      verificationFingerprint: `sha256:${"a".repeat(64)}` }];
    const removedDependency = { ...structuredClone(retainedOpaque), id: "removed-dependency", dependencies: [], overrides: [] };
    retained.changes.push(removedDependency);
    const modelBody = { method: "model" as const, category: "Changed" as const, title: "Readable behavior changed",
      workflow: "Opening the readable fixture", before: "The fixture showed before text.", after: "The fixture shows after text.",
      status: "inferred_from_code" as const, origin: "upstream" as const,
      evidenceReferences: [{ id: `${retainedReadable.id}:evidence:0`, sha256: doctorDigest(retainedReadable.evidence[0]!) }],
      limitations: ["Static fixture evidence only."], dependencies: [removedDependency.id], analysisGroupIds: [retainedReadable.id] };
    retained.changelog!.entries.push({ id: changelogEntryId(modelBody), ...modelBody });
    retained.reviewProgress = { version: 1, policy: "finish_automatically", stage: "ready",
      files: { total: 3, accounted: 3 }, questions: { total: 1, completed: 1, reused: 1 }, entries: 1, limitations: 1 };
    retained.changelog!.unresolved = retained.changelog!.unresolved.map(item => item.groupId === retainedOpaque.id
      ? { ...item, reason: "Retained unknown for the unchanged opaque evidence." }
      : item.groupId === retainedReadable.id ? { ...item, reason: "Old observation-only limitation." } : item);
    retained.fingerprint = changeReportFingerprint(retained) as `sha256:${string}`;

    const migrated = await refreshDoctorChangeReportClassifications({ report: retained, before, after, comparison, checkpointDirectory });
    const migratedOpaque = migrated.changes.find(change => change.id === opaque?.id)!;
    const migratedReadable = migrated.changes.find(change => change.id === readable?.id)!;
    assert.equal(migratedOpaque.explanation?.summary, "Retained exact-evidence explanation.");
    assert.equal(migratedOpaque.unknownPolicy, "acknowledgment");
    assert.equal(migrated.changelog!.unresolved.find(item => item.groupId === migratedOpaque.id)?.reason,
      "Retained unknown for the unchanged opaque evidence.");
    assert.equal(migratedReadable.explanation?.summary, "The old classifier treated this as opaque.");
    assert.equal(migratedReadable.reviewWork?.kind, "evidence_needed");
    assert.equal(migratedReadable.unknownPolicy, "blocking");
    assert.equal(migrated.changelog!.unresolved.find(item => item.groupId === migratedReadable.id)?.reason,
      migratedReadable.reviewWork?.question);
    assert.deepEqual(migratedReadable.overrides, []);
    assert.equal(migrated.changelog!.entries.some(entry => entry.title === modelBody.title), false,
      "an entry whose dependency group disappeared must be reviewed again instead of weakening its dependency claim");
    assert.equal(statSync(checkpoint).ino, checkpointInode, "classification refresh should reuse the raw version-6 checkpoint");
    assert.deepEqual(migrated.reviewProgress, retained.reviewProgress);
    assert.equal(migrated.fingerprint, changeReportFingerprint(migrated));
    assert.doesNotThrow(() => validateDoctorChangelog(migrated));
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

test("change analysis reuses valid deterministic checkpoints and replaces corrupted ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-change-analysis-checkpoint-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/feature.js": "export const feature = () => false;",
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/feature.js": "export const feature = () => true;",
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const checkpointDirectory = join(realpathSync(root), "checkpoints");
    const input = { before, after, comparison: compareDoctorSourceEvidence(before, after), jobId: "checkpoint",
      implementationFingerprint: "implementation", checkpointDirectory };
    const first = await buildDoctorChangeReport(input);
    const checkpoint = join(checkpointDirectory, readdirSync(checkpointDirectory)[0]!);
    const firstStat = statSync(checkpoint);
    const resumed = await buildDoctorChangeReport(input);
    assert.equal(resumed.fingerprint, first.fingerprint);
    assert.equal(statSync(checkpoint).ino, firstStat.ino, "a valid checkpoint should be read without replacement");
    writeFileSync(checkpoint, "{", { mode: 0o600 });
    const recovered = await buildDoctorChangeReport(input);
    assert.equal(recovered.fingerprint, first.fingerprint);
    const persisted = JSON.parse(readFileSync(checkpoint, "utf8")) as { analysisVersion?: number; fingerprint?: string };
    assert.equal(persisted.analysisVersion, 6);
    assert.match(persisted.fingerprint ?? "", /^sha256:[a-f0-9]{64}$/);
  } finally { restore(); rmSync(root, { recursive: true, force: true }); }
});

function installFakeBackend(): () => void {
  return setDoctorSourceEvidenceDependenciesForTest({
    run(command, args) {
      if (args.length === 1 && args[0] === "--version") {
        return { status: 0, stdout: `codex-cli ${readFileSync(command, "utf8").trim()}\n` };
      }
      assert.deepEqual(args.slice(0, 3), ["app-server", "generate-json-schema", "--experimental"]);
      assert.equal(args[3], "--out");
      const schemaRoot = args[4];
      assert.equal(typeof schemaRoot, "string");
      const schemaPath = join(schemaRoot!, "v2", "ClientRequest.json");
      mkdirSync(dirname(schemaPath), { recursive: true });
      writeFileSync(schemaPath, JSON.stringify({ type: "object", backend: readFileSync(command, "utf8").trim() }));
      return { status: 0, stdout: "" };
    },
  });
}

async function createFixture(root: string, name: string, options: FixtureOptions = {}): Promise<string> {
  const app = join(root, name);
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(contents, "Info.plist"), plist.build({
    CFBundleIdentifier: "com.openai.codex",
    CFBundleShortVersionString: "26.910.1",
    CFBundleVersion: "9001",
  }));
  if (options.backend !== null) {
    const backend = join(resources, "codex");
    writeFileSync(backend, options.backend ?? "backend-one");
    chmodSync(backend, 0o755);
  }
  for (const [path, contentsValue] of Object.entries(options.extraFiles ?? {})) {
    const destination = join(app, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contentsValue);
  }
  if (options.symlink) {
    const destination = join(app, ...options.symlink.path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(options.symlink.target, destination);
  }
  const asarSource = join(root, `${name}-asar-source`);
  for (const [path, contentsValue] of Object.entries(options.asarFiles ?? { "package.json": "{}" })) {
    const destination = join(asarSource, ...path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contentsValue);
  }
  const stream = await asar.createPackage(asarSource, join(resources, "app.asar"));
  await finished(stream);
  return app;
}

test("exact message IDs produce cited wording changes without inventing features from bundle renames", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-wording-"));
  const restore = installFakeBackend();
  try {
    const beforeSource = 'export const a = {id:"composer.send",defaultMessage:"Send message"}; /* 😀 */ export const b = {id:"composer.stop",defaultMessage:"Stop"};';
    const afterSource = 'export const a = {id:"composer.send",defaultMessage:"Send"}; /* 😀 */ export const b = {id:"composer.stop",defaultMessage:"Stop response"};';
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/wording.js": beforeSource,
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/wording.js": afterSource,
    } });
    const before = await collectDoctorSourceEvidence(beforeApp, join(root, "before-output"));
    const after = await collectDoctorSourceEvidence(afterApp, join(root, "after-output"));
    const report = await buildDoctorChangeReport({ before, after, comparison: compareDoctorSourceEvidence(before, after), jobId: "wording", implementationFingerprint: "implementation" });
    const {validateDoctorChangelog} = await import("./doctor-changelog.js");
    assert.doesNotThrow(() => validateDoctorChangelog(report));
    assert.equal(report.changelog!.entries.length, 2);
    assert.ok(report.changelog!.entries.every(e => e.status === "inferred_from_code" && e.category === "Changed" && e.method === "deterministic_text"));
    const send = report.changelog!.entries.find((entry) => entry.before.includes("Send message"));
    assert.match(send?.after ?? "", /Send/);
    assert.notDeepEqual(report.changelog!.entries[0]!.analysisGroupIds, report.changelog!.entries[1]!.analysisGroupIds);
    const wordingEvidence = report.changelog!.entries.map((entry) => report.changes
      .find((change) => change.id === entry.analysisGroupIds[0])!.evidence[0]!);
    assert.ok(wordingEvidence.every((evidence) => evidence.beforeRange && evidence.afterRange));
    assert.ok(wordingEvidence.every((evidence) => evidence.beforeFocus && evidence.afterFocus));
    const beforeRanges = [...wordingEvidence].sort((left, right) => left.beforeRange!.offset - right.beforeRange!.offset);
    const afterRanges = [...wordingEvidence].sort((left, right) => left.afterRange!.offset - right.afterRange!.offset);
    assert.equal(beforeRanges[0]!.beforeRange!.offset, 0);
    assert.equal(afterRanges[0]!.afterRange!.offset, 0);
    assert.equal(beforeRanges[0]!.beforeRange!.offset + beforeRanges[0]!.beforeRange!.bytes, beforeRanges[1]!.beforeRange!.offset);
    assert.equal(afterRanges[0]!.afterRange!.offset + afterRanges[0]!.afterRange!.bytes, afterRanges[1]!.afterRange!.offset);
    assert.equal(beforeRanges[1]!.beforeRange!.offset, Buffer.byteLength(beforeSource.slice(0, beforeSource.indexOf("export const b"))));
    assert.equal(afterRanges[1]!.afterRange!.offset, Buffer.byteLength(afterSource.slice(0, afterSource.indexOf("export const b"))));
    assert.equal(beforeRanges[1]!.beforeRange!.offset + beforeRanges[1]!.beforeRange!.bytes, beforeRanges[1]!.beforeSourceBytes);
    assert.equal(afterRanges[1]!.afterRange!.offset + afterRanges[1]!.afterRange!.bytes, afterRanges[1]!.afterSourceBytes);
    for (const evidence of wordingEvidence) {
      const beforeFocus = evidence.beforeFocus!, afterFocus = evidence.afterFocus!;
      const beforeWitness = Buffer.from(beforeSource).subarray(beforeFocus.offset, beforeFocus.offset + beforeFocus.bytes);
      const afterWitness = Buffer.from(afterSource).subarray(afterFocus.offset, afterFocus.offset + afterFocus.bytes);
      assert.ok(beforeWitness.includes(Buffer.from("composer.")));
      assert.ok(afterWitness.includes(Buffer.from("composer.")));
      assert.ok(beforeFocus.offset >= evidence.beforeRange!.offset);
      assert.ok(beforeFocus.offset + beforeFocus.bytes <= evidence.beforeRange!.offset + evidence.beforeRange!.bytes);
      assert.ok(afterFocus.offset >= evidence.afterRange!.offset);
      assert.ok(afterFocus.offset + afterFocus.bytes <= evidence.afterRange!.offset + evidence.afterRange!.bytes);
    }
    const identical = await buildDoctorChangeReport({before, after:before, comparison:compareDoctorSourceEvidence(before,before), jobId:"same", implementationFingerprint:"implementation"});
    assert.deepEqual(identical.changelog!.entries, []);
  } finally { restore(); rmSync(root, {recursive:true,force:true}); }
});

 test("changed hashed UI bundles pair only with a unique name and independent stable anchors", async () => {
  const root = mkdtempSync(join(tmpdir(), "doctor-named-pairs-"));
  const restore = installFakeBackend();
  try {
    const beforeApp = await createFixture(root, "before.app", { asarFiles: {
      "webview/composer-11111111.js": 'export const a={id:"composer.send",defaultMessage:"Send message"}, b={id:"composer.stop",defaultMessage:"Stop"};',
      "webview/different-33333333.js": 'export const a={id:"unrelated.one",defaultMessage:"One"}, b={id:"unrelated.two",defaultMessage:"Two"};',
    } });
    const afterApp = await createFixture(root, "after.app", { asarFiles: {
      "webview/composer-22222222.js": 'export const x={id:"composer.send",defaultMessage:"Send"}, y={id:"composer.stop",defaultMessage:"Stop response"};',
      "webview/different-44444444.js": 'export const x={id:"new.one",defaultMessage:"New"}, y={id:"new.two",defaultMessage:"Other"};',
    } });
    const before=await collectDoctorSourceEvidence(beforeApp, join(root,"before")), after=await collectDoctorSourceEvidence(afterApp,join(root,"after"));
    const report=await buildDoctorChangeReport({before,after,comparison:compareDoctorSourceEvidence(before,after),jobId:"named",implementationFingerprint:"implementation"});
    assert.equal(report.changelog!.entries.length,2);
    const evidence=report.changes.flatMap(c=>c.evidence);
    assert.ok(evidence.some(e=>e.path==="webview/composer-11111111.js -> webview/composer-22222222.js"));
    assert.ok(!evidence.some(e=>e.path.includes("different-") && e.path.includes(" -> ")));
    assert.equal(report.coverage.classified+report.coverage.unresolved,report.coverage.total);
  } finally {restore();rmSync(root,{recursive:true,force:true});}
});

test("protocol semantic comparison accepts optional additions and rejects consumed contract changes", async () => {
  const { compareDoctorProtocolShapes } = await import("./doctor-protocol.js");
  const old = { type: "object", properties: {id: {type: "string"}}, required: ["id"] };
  assert.deepEqual(compareDoctorProtocolShapes(old, {...old, properties: {...old.properties, label: {type: "string"}}}), []);
  assert.match(compareDoctorProtocolShapes(old, {...old, properties: {}}).join(), /removed field/);
  assert.match(compareDoctorProtocolShapes(old, {...old, properties: {id: {type: "number"}}}).join(), /changed type/);
  assert.match(compareDoctorProtocolShapes(old, {...old, required: ["id", "label"]}).join(), /newly required/);
  assert.match(compareDoctorProtocolShapes(old, {...old, required: []}, "response").join(), /no longer guaranteed/);
});

test("protocol evidence resolves hashed references and refuses missing, unknown, and modified schemas", async () => {
  const { collectDoctorProtocolCoverage } = await import("./doctor-protocol.js");
  const { createHash } = await import("node:crypto");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "doctor-protocol-")));
  try {
    const params = { type: "object", properties: {threadId: {type: "string"}}, required: ["threadId"] };
    const doc = {definitions: {Params: params}, oneOf: [{type: "object", properties: {method: {enum: ["turn/interrupt"]}, params: {$ref: "#/definitions/Params"}}}]};
    const documents: Record<string, unknown> = {"ClientRequest.json": doc, "TurnInterruptResponse.json": {type: "object"}};
    const files = Object.entries(documents).map(([path, value]) => {
      const raw = JSON.stringify(value); writeFileSync(join(root, path), raw);
      return {path, kind: "file" as const, bytes: Buffer.byteLength(raw), sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}` as const};
    });
    const evidence = {fingerprint: `sha256:${"a".repeat(64)}`, schemas: {state: "complete", root, files}} as unknown as DoctorSourceEvidence;
    const coverage = collectDoctorProtocolCoverage(evidence, evidence);
    assert.equal(coverage.interfaces.find(i => i.method === "turn/interrupt")?.status, "compatible");
    assert.equal(coverage.interfaces.find(i => i.method === "account/read")?.status, "unresolved");
    doc.definitions.Params = {...params, unevaluatedProperties: false} as typeof params;
    const raw = JSON.stringify(doc); writeFileSync(join(root, "ClientRequest.json"), raw);
    assert.match(collectDoctorProtocolCoverage(evidence, evidence).interfaces[0]!.reasons.join(), /digest changed/);
    files[0]!.sha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    assert.match(collectDoctorProtocolCoverage(evidence, evidence).interfaces.find(i => i.method === "turn/interrupt")!.reasons.join(), /Unsupported schema keyword/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("protocol inventory covers interpreted history, feature, and reply interfaces", async () => {
  const {DOCTOR_PROTOCOL_CONTRACTS, compareDoctorProtocolShapes} = await import("./doctor-protocol.js");
  for (const method of ["threadSection/list", "experimentalFeature/enablement/set", "serverRequest/resolved", "thread/turns/list", "thread/items/list"]) {
    assert.ok(DOCTOR_PROTOCOL_CONTRACTS.some(contract => contract.method === method), method);
  }
  for (const contract of DOCTOR_PROTOCOL_CONTRACTS.filter(item => item.direction === "server")) assert.ok(contract.response, contract.method);
  const before = {type: "object", properties: {threadId: {type: "string"}}, required: ["threadId"]};
  assert.match(compareDoctorProtocolShapes(before, {...before, required: []}, "response.params").join(), /no longer guaranteed/);
  assert.match(compareDoctorProtocolShapes(before, {...before, required: ["threadId", "decision"]}, "params.response").join(), /newly required/);
});
