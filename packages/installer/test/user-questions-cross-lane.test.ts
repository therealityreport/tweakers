import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateTweakManifest } from "../../sdk/src/index";
import promotionHealth from "../../runtime/src/promotion-health";
import rendererStorage from "../../runtime/src/renderer-storage";
import { readDevSnapshotReceipt } from "../src/commands/dev-sync";
import {
  inspectUserQuestionsSource,
  LEGACY_USER_QUESTIONS_TWEAK_IDS,
  USER_QUESTIONS_FOLDER,
  USER_QUESTIONS_TWEAK_ID,
} from "../src/user-questions-source";

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const tweakRoot = join(repositoryRoot, "tweaks", USER_QUESTIONS_FOLDER);
const fixtureRoot = join(tweakRoot, "test", "fixtures");
const runtimeMcpSyncSource = readFileSync(join(repositoryRoot, "packages", "runtime", "src", "mcp-sync.ts"), "utf8");
const runtimeMcpReconciliationSource = readFileSync(join(repositoryRoot, "packages", "runtime", "src", "mcp-reconciliation.ts"), "utf8");
const runtimeMainSource = readFileSync(join(repositoryRoot, "packages", "runtime", "src", "main.ts"), "utf8");
const installerSource = readFileSync(join(repositoryRoot, "packages", "installer", "src", "commands", "install.ts"), "utf8");
const manifest = readJson(join(tweakRoot, "manifest.json"));
const tweakPackage = readJson(join(tweakRoot, "package.json"));
const lifecycle = require(join(tweakRoot, "index.js"));
const broker = require(join(tweakRoot, "broker-protocol.js"));
const core = require(join(tweakRoot, "core.js"));
const policy = require(join(tweakRoot, "policy-state.js"));
const { answerPromotionHealthRequest, PROMOTION_SURFACE_NAMES } = promotionHealth;
const { prepareRendererStorageMigration } = rendererStorage;

interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

test("canonical manifest, package, lifecycle, broker, and source proof stay at one enhancement-only identity", () => {
  const validation = validateTweakManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(manifest.id, USER_QUESTIONS_TWEAK_ID);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(tweakPackage.version, manifest.version);
  assert.equal(manifest.scope, "both");
  assert.deepEqual(broker.REQUIRED_BROKER_PERMISSIONS, ["ipc", "network"]);
  for (const permission of ["settings", "filesystem", ...broker.REQUIRED_BROKER_PERMISSIONS]) {
    assert.ok(manifest.permissions.includes(permission), `manifest is missing ${permission}`);
  }
  assert.equal(typeof lifecycle.start, "function");
  assert.equal(typeof lifecycle.stop, "function");
  assert.equal(Object.hasOwn(manifest, "mcp"), false);

  const proof = inspectUserQuestionsSource(tweakRoot);
  assert.equal(proof.id, manifest.id);
  assert.equal(proof.version, manifest.version);
  assert.match(proof.payloadHash, /^[a-f0-9]{64}$/);
  assert.match(proof.mainEntrypointHash, /^[a-f0-9]{64}$/);
  assert.match(proof.enhancementBrokerEntrypointHash, /^[a-f0-9]{64}$/);
  assert.match(proof.schemaEntrypointHash, /^[a-f0-9]{64}$/);
});

test("cutover removes every Tweakers-owned User Questions MCP registration and startup requirement", () => {
  assert.doesNotMatch(runtimeMcpSyncSource, /co-tweakers-user-questions/);
  assert.doesNotMatch(runtimeMcpReconciliationSource, /userQuestionsMcpReceiptMatchesEnabledState|observeUserQuestionsApprovalPolicy/);
  assert.doesNotMatch(runtimeMainSource, /userQuestionsMcpReady|canonical User Questions MCP reconciliation/);
  assert.doesNotMatch(installerSource, /userQuestionsStateConsistent|Canonical User Questions MCP source is missing/);
  assert.equal(Object.hasOwn(manifest, "mcp"), false);
});

test("enhancement support preserves rich schema, generic terminal fixtures, and redaction without an embedded server", () => {
  const richFixture = readJson(join(fixtureRoot, "rich-ask.json"));
  const validation = core.validateAskInput(richFixture.input);
  assert.equal(validation.ok, true, validation.errors?.join("; "));
  assert.deepEqual(validation.value, richFixture.normalized);

  const submittedFixture = readJson(join(fixtureRoot, "submitted-result.json"));
  const submitted = core.serializeResult(validation.value, submittedFixture.result);
  assert.equal(submitted.ok, true);
  assert.deepEqual(submitted.value.structuredContent, submittedFixture.normalized);

  const displayFailed = readJson(join(fixtureRoot, "display-failed-result.json"));
  const hostEmpty = readJson(join(fixtureRoot, "host-empty-response-result.json"));
  const first = core.serializeResult(validation.value, displayFailed.result);
  const second = core.serializeResult(validation.value, hostEmpty.result);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first.value.structuredContent, displayFailed.normalized);
  assert.deepEqual(second.value.structuredContent, hostEmpty.normalized);
  assert.notEqual(first.value.structuredContent.failure_stage, second.value.structuredContent.failure_stage);
  for (const result of [first.value.structuredContent, second.value.structuredContent]) {
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes(richFixture.input.questions[0].question), false);
    assert.equal(encoded.includes(richFixture.input.questions[0].options[0].description), false);
    assert.deepEqual(result.answers, {});
    assert.equal(result.retryable, true);
  }
});

test("policy and Settings copy preserve explicit Preview/Apply/Restore with no automatic restart", () => {
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.defaultProfile, "maximum-access");
  assert.deepEqual(Object.keys(policy.POLICY_SETTINGS_VIEW_MODEL.profiles), ["maximum-access", "questions-only"]);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.commands.preview.readOnly, true);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.commands.apply.explicit, true);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.commands.apply.restartsApp, false);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.commands.restore.explicit, true);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.commands.restore.restartsApp, false);
  assert.equal(policy.POLICY_SETTINGS_VIEW_MODEL.restart.automatic, false);

  const rendererSource = readFileSync(join(tweakRoot, "index.js"), "utf8");
  assert.match(rendererSource, /Choose a profile for Preview\. A row is marked saved only after the current policy file is verified/);
  assert.match(rendererSource, /Existing tasks retain their loaded policy; a later Codex restart and fresh task are required/);
  assert.match(rendererSource, /Maximum access/);
  assert.match(rendererSource, /Questions only/);
  assert.doesNotMatch(rendererSource, /repairGlobalStateFile\s*\(/);
});

test("legacy migration and schema-v2 snapshot metadata preserve canonical identity without cleanup", () => {
  assert.equal(USER_QUESTIONS_TWEAK_ID, "co.tweakers.user-questions");
  assert.equal(LEGACY_USER_QUESTIONS_TWEAK_IDS.length, 1);
  assert.notEqual(LEGACY_USER_QUESTIONS_TWEAK_IDS[0], USER_QUESTIONS_TWEAK_ID);

  const legacyKey = `${["codex", "pp"].join("")}:storage:${LEGACY_USER_QUESTIONS_TWEAK_IDS[0]}`;
  const legacyValue = JSON.stringify({ draft: "preserved" });
  const values = new Map([[legacyKey, legacyValue]]);
  const storage: StorageLike = {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  const migration = prepareRendererStorageMigration(USER_QUESTIONS_TWEAK_ID, storage, "t8-renderer-migration");
  assert.equal(migration.status, "prepared");
  assert.equal(migration.holdPromotion, false);
  assert.equal(values.get(legacyKey), legacyValue);
  assert.equal(values.get(`tweaker:storage:${USER_QUESTIONS_TWEAK_ID}`), legacyValue);

  const root = mkdtempSync(join(tmpdir(), "user-questions-snapshot-parity-"));
  try {
    const liveTweaks = join(root, "tweaks");
    mkdirSync(liveTweaks, { recursive: true });
    const transactionId = "11111111-1111-1111-1111-111111111111";
    const proof = inspectUserQuestionsSource(tweakRoot);
    const receiptPath = join(liveTweaks, ".tweaker-dev-snapshot.json");
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 2,
      transactionId,
      phase: "pending_acceptance",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      sourcePayloadHash: proof.payloadHash,
      folders: [USER_QUESTIONS_FOLDER],
      folderProofs: [{
        folder: USER_QUESTIONS_FOLDER,
        id: proof.id,
        version: proof.version,
        hash: proof.payloadHash,
      }],
      surfaces: [{
        folder: USER_QUESTIONS_FOLDER,
        before: { kind: "missing", hash: "missing" },
        after: { kind: "directory", hash: proof.payloadHash },
        preimagePath: null,
      }],
      priorTreeRoot: join(liveTweaks, ".tweaker-dev-history", transactionId, "previous"),
      archivedLegacySnapshots: [],
    }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(receiptPath, 0o600);
    const receipt = readDevSnapshotReceipt(receiptPath);
    assert.equal(receipt?.schemaVersion, 2);
    assert.deepEqual(receipt?.folderProofs[0], {
      folder: USER_QUESTIONS_FOLDER,
      id: manifest.id,
      version: manifest.version,
      hash: proof.payloadHash,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-v2 promotion health binds the canonical source proof and all rollout surfaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "user-questions-health-parity-"));
  try {
    const health = join(root, "health");
    mkdirSync(health, { recursive: true });
    const proof = inspectUserQuestionsSource(tweakRoot);
    const hashes = Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name, index) => [
      name,
      String((index + 1) % 10).repeat(64),
    ])) as Record<string, string>;
    const requestPath = join(health, "request.json");
    writeFileSync(requestPath, JSON.stringify({
      schemaVersion: 2,
      requestedAt: "2026-07-20T12:00:00.000Z",
      app: { version: "candidate", build: "t8", hash: hashes.app },
      requiredPermissions: manifest.permissions,
      surfaces: Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name) => [name, {
        preimageHash: "0".repeat(64),
        afterHash: hashes[name],
      }])),
      userQuestions: { id: proof.id, version: proof.version, payloadHash: proof.payloadHash },
    }), { mode: 0o600 });
    chmodSync(requestPath, 0o600);

    const accepted = await answerPromotionHealthRequest(root, {
      authenticatedSession: () => "pass",
      declaredPermission: () => "pass",
      rendererReady: () => "pass",
      rendererProof: () => ({
        capturedWindowCount: 1,
        canonicalWebContentsId: 71,
        canonicalUrl: "app://-/index.html?hostId=host-123",
        authorized: true,
        didFinishLoad: true,
        mounted: true,
        originalPreload: true,
        preloadFailed: false,
        loadFailed: false,
        rendererExited: false,
        cleanup: "pass",
        failureReason: null,
      }),
      promotionSurface: (surface) => hashes[surface],
      userQuestionsHealth: () => ({
        id: proof.id,
        version: proof.version,
        payloadHash: proof.payloadHash,
        mainLifecycle: "pass",
        brokerSelfTest: "pass",
        schemaSelfTest: "pass",
        rendererStorageSelfTest: "pass",
        enhancementHandshake: "pass",
        genericFallback: "pass",
      }),
    }, { now: new Date("2026-07-20T12:00:01.000Z") });
    assert.equal(accepted, true);
    const receipt = readJson(join(health, "promotion.json"));
    assert.equal(receipt.schemaVersion, 2);
    assert.equal(receipt.hostReady, "pass");
    assert.equal(receipt.promotionReady, "pass");
    assert.equal(receipt.userQuestions.expected.id, manifest.id);
    assert.equal(receipt.userQuestions.expected.version, manifest.version);
    assert.equal(receipt.userQuestions.expected.payloadHash, proof.payloadHash);
    assert.equal(receipt.userQuestions.identity, "pass");
    assert.equal(receipt.userQuestions.enhancementHandshake, "pass");
    assert.equal(receipt.userQuestions.genericFallback, "pass");
    assert.deepEqual(Object.keys(receipt.surfaces).sort(), [...PROMOTION_SURFACE_NAMES].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}
