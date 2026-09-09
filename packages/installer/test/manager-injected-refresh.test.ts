import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseInjectedRefreshBinding } from "../src/manager-action-adapter";

const GENERATION_ID = "018f0d36-4c08-7a3e-9c1d-123456789aff";
const RECEIPT_DIGEST = "a".repeat(64);
const SOURCE_DIGEST = "b".repeat(64);
const SOURCE_REVISION = `sha256:${"c".repeat(64)}`;
const RUNTIME_FINGERPRINT = "d".repeat(64);
const SELECTION_REVISION = `sha256:${"e".repeat(64)}`;
const REGISTRY_REVISION = `sha256:${"f".repeat(64)}`;

function binding(): string {
  return [
    "injected-chatgpt-patch",
    "v1",
    GENERATION_ID,
    RECEIPT_DIGEST,
    SOURCE_DIGEST,
    SOURCE_REVISION,
    RUNTIME_FINGERPRINT,
    SELECTION_REVISION,
    REGISTRY_REVISION,
  ].join(":");
}

test("injected refresh parser accepts only the complete lower-case source, runtime, and environment binding", () => {
  assert.deepEqual(parseInjectedRefreshBinding(binding()), {
    sourceGenerationId: GENERATION_ID,
    sourceReceiptDigest: RECEIPT_DIGEST,
    sourceDigest: SOURCE_DIGEST,
    sourceRevision: SOURCE_REVISION,
    managerRuntimeFingerprint: RUNTIME_FINGERPRINT,
    selectionRevision: SELECTION_REVISION,
    registryRevision: REGISTRY_REVISION,
  });
  assert.throws(
    () => parseInjectedRefreshBinding(binding().replace(RUNTIME_FINGERPRINT, RUNTIME_FINGERPRINT.toUpperCase())),
    /exact versioned source\/runtime\/environment binding/,
  );
  assert.throws(
    () => parseInjectedRefreshBinding(`injected-chatgpt-patch:v1:${GENERATION_ID}:${RECEIPT_DIGEST}`),
    /exact versioned source\/runtime\/environment binding/,
  );
});

test("sealed injected refresh is receipt-bound to the registered artifact and coordinator proof, never to updater or live-candidate APIs", () => {
  const source = readFileSync(new URL("../src/manager-action-adapter.ts", import.meta.url), "utf8");
  const executor = source.slice(
    source.indexOf("function createSealedInjectedRefreshExecutor"),
    source.indexOf("function createSealedIndependentRefreshLifecycle"),
  );
  assert.match(executor, /const candidateSource = lease\.receipt\.artifact\.appPath/);
  assert.match(executor, /sealedCandidateSourceApp: candidateSource/);
  assert.match(executor, /createId: \(\) => execution\.operationId/);
  assert.match(executor, /coordinator\.prepare\(\{ current, requested \}\)/);
  assert.match(executor, /coordinator\.commit\(execution\.operationId, execution\.consumedAt\)/);
  assert.match(executor, /receipt\.newMainPid === receipt\.oldMainPid/);
  assert.doesNotMatch(executor, /createDesktopUpdateTransaction|Sparkle|requirePreparedCandidate|\binstall\(/);
  assert.doesNotMatch(executor, /sealedCandidateSourceApp: "\/Applications\/ChatGPT\.app"/);
});
