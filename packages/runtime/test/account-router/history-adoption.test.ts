import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preflightRouterHomesDetail } from "../../src/account-router/app-server-mux";
import {
  historyAdoptionIntentFingerprint,
  parseHistoryAdoptionOwners,
  validateHistoryAdoptionEvidence,
} from "../../src/account-router/history-adoption";
import { routerConfigFingerprint } from "../../src/account-router/config";
import { createInitialRouterState } from "../../src/account-router/state-store";
import { ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT, type RouterConfigV2 } from "../../src/account-router/types";
import { ADOPTED_THREAD_ID, publishHistoryAdoptionEvidence, signHistoryDocument, writePrivate } from "./history-adoption-fixtures";

function opaque(secret: Buffer, raw: string): `ar_${string}` {
  return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`, "utf8").digest("base64url")}`;
}

function stagedV2(mode: "quota_aware" | "manual" = "quota_aware"): { root: string; secret: Buffer; config: RouterConfigV2 } {
  const root = mkdtempSync(join(tmpdir(), "account-router-history-adoption-"));
  const secret = Buffer.alloc(32, 42);
  const first = opaque(secret, "first");
  const second = opaque(secret, "second");
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    schemaVersion: 2,
    mode,
    policy: mode === "manual" ? null : "quota_aware_v1",
    generation: 4,
    protocolFingerprint: ACCOUNT_ROUTER_PROTOCOL_FINGERPRINT,
    primaryOpaqueAccountId: first,
    accounts: [
      { opaqueAccountId: first, included: true, weight: 1, capabilityFingerprint: `sha256:${"a".repeat(64)}`, label: "Account 1" },
      { opaqueAccountId: second, included: true, weight: 1, capabilityFingerprint: `sha256:${"b".repeat(64)}`, label: "Account 2" },
    ],
    updatedAt: "2026-08-31T12:00:00.000Z",
  };
  const config = { ...draft, fingerprint: routerConfigFingerprint(draft) };
  for (const [index, account] of config.accounts.entries()) {
    const codexHome = join(root, "accounts", account.opaqueAccountId, "codex-home");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "accounts", account.opaqueAccountId, "sqlite-home"), { recursive: true, mode: 0o700 });
    writePrivate(join(codexHome, "auth.json"), JSON.stringify({ tokens: { account_id: index === 0 ? "first" : "second" } }));
    writePrivate(join(codexHome, "config.toml"), "");
  }
  writePrivate(join(root, "control-secret.v1"), secret);
  return { root, secret, config };
}

function rawEvidence(root: string): { intent: Buffer; owners: Buffer; receipt: Buffer } {
  return {
    intent: readFileSync(join(root, "history-adoption-intent.v1.json")),
    owners: readFileSync(join(root, "history-adoption-owners.v1.json")),
    receipt: readFileSync(join(root, "history-adoption-receipt.v1.json")),
  };
}

function restagedV2(config: RouterConfigV2, options: { mode: "quota_aware" | "manual"; primaryOpaqueAccountId: RouterConfigV2["primaryOpaqueAccountId"] }): RouterConfigV2 {
  const draft: Omit<RouterConfigV2, "fingerprint"> = {
    ...config,
    mode: options.mode,
    policy: options.mode === "manual" ? null : "quota_aware_v1",
    generation: config.generation + 1,
    primaryOpaqueAccountId: options.primaryOpaqueAccountId,
    updatedAt: "2026-09-01T12:00:00.000Z",
  };
  return { ...draft, fingerprint: routerConfigFingerprint(draft) };
}

test("history adoption requires strict signed v2 evidence while allowing later ordinary owner growth", () => {
  const staged = stagedV2();
  publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
  const state = createInitialRouterState(staged.config);
  state.threadOwners[ADOPTED_THREAD_ID] = staged.config.primaryOpaqueAccountId;
  state.ledger[staged.config.primaryOpaqueAccountId].assignedThreadCount += 1;
  let result = validateHistoryAdoptionEvidence(staged.config, state, staged.secret, rawEvidence(staged.root));
  assert.equal(result.ok, true);
  state.threadOwners["22222222-2222-4222-8222-222222222222"] = staged.config.accounts[1].opaqueAccountId;
  state.ledger[staged.config.accounts[1].opaqueAccountId].assignedThreadCount += 1;
  result = validateHistoryAdoptionEvidence(staged.config, state, staged.secret, rawEvidence(staged.root));
  assert.equal(result.ok, true, "later non-historical routing growth does not change the signed imported subset");
});

test("valid original adoption evidence accepts same-pool quota and manual restages", () => {
  const staged = stagedV2();
  publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
  const state = createInitialRouterState(staged.config);
  state.threadOwners[ADOPTED_THREAD_ID] = staged.config.primaryOpaqueAccountId;
  state.ledger[staged.config.primaryOpaqueAccountId].assignedThreadCount += 1;
  const raw = rawEvidence(staged.root);

  const quotaRestage = restagedV2(staged.config, {
    mode: "quota_aware",
    primaryOpaqueAccountId: staged.config.accounts[1].opaqueAccountId,
  });
  assert.equal(validateHistoryAdoptionEvidence(quotaRestage, state, staged.secret, raw).ok, true,
    "the immutable original intent stays valid after a same-pool quota restage");
  assert.deepEqual(preflightRouterHomesDetail(quotaRestage, staged.root), { ok: true });

  const manualRestage = restagedV2(quotaRestage, {
    mode: "manual",
    primaryOpaqueAccountId: staged.config.accounts[1].opaqueAccountId,
  });
  assert.notEqual(manualRestage.fingerprint, staged.config.fingerprint);
  assert.equal(validateHistoryAdoptionEvidence(manualRestage, state, staged.secret, raw).ok, true,
    "manual can change the primary without rewriting offline-adoption evidence");
  assert.deepEqual(preflightRouterHomesDetail(manualRestage, staged.root), { ok: true });

  const changedPool = {
    ...manualRestage,
    accounts: [manualRestage.accounts[0], { ...manualRestage.accounts[1], opaqueAccountId: `ar_${"z".repeat(43)}` }],
  } as RouterConfigV2;
  assert.deepEqual(validateHistoryAdoptionEvidence(changedPool, state, staged.secret, raw), {
    ok: false, reason: "history_adoption_config_mismatch",
  });
});

test("history adoption rejects HMAC tamper plus pool, owner, protocol, intent, timestamp, count, and fingerprint mismatches", () => {
  const staged = stagedV2();
  const evidence = publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
  const state = createInitialRouterState(staged.config);
  state.threadOwners[ADOPTED_THREAD_ID] = staged.config.primaryOpaqueAccountId;
  state.ledger[staged.config.primaryOpaqueAccountId].assignedThreadCount += 1;
  const raw = rawEvidence(staged.root);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, receipt: Buffer.alloc(0) }).ok, false);
  const hmacTampered = JSON.parse(raw.receipt.toString("utf8")) as Record<string, unknown>;
  hmacTampered.hmac = `hmac-sha256:${"f".repeat(64)}`;
  assert.deepEqual(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, receipt: Buffer.from(JSON.stringify(hmacTampered)) }), {
    ok: false, reason: "history_adoption_hmac_invalid",
  });

  const { hmac: _intentHmac, ...intentPayload } = evidence.intent;
  const wrongPool = signHistoryDocument({ ...intentPayload, poolFingerprint: `sha256:${"f".repeat(64)}` }, staged.secret);
  const wrongPoolBytes = Buffer.from(JSON.stringify(wrongPool));
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, intent: wrongPoolBytes }).ok, false);

  const wrongOwner = signHistoryDocument({ ...intentPayload, legacyOwnerOpaqueAccountId: staged.config.accounts[1].opaqueAccountId }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, intent: Buffer.from(JSON.stringify(wrongOwner)) }).ok, false);
  const wrongProtocol = signHistoryDocument({ ...intentPayload, protocolFingerprint: `sha256:${"f".repeat(64)}` }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, intent: Buffer.from(JSON.stringify(wrongProtocol)) }).ok, false);
  const wrongConfigFingerprint = signHistoryDocument({ ...intentPayload, configFingerprint: `sha256:${"f".repeat(64)}` }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, intent: Buffer.from(JSON.stringify(wrongConfigFingerprint)) }).ok, false);

  const { hmac: _receiptHmac, ...receiptPayload } = evidence.receipt;
  const wrongReceipt = signHistoryDocument({
    ...receiptPayload,
    intentFingerprint: `sha256:${"f".repeat(64)}`,
  }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, receipt: Buffer.from(JSON.stringify(wrongReceipt)) }).ok, false);

  const wrongCount = signHistoryDocument({ ...receiptPayload, importedThreadCount: receiptPayload.importedThreadCount + 1 }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, receipt: Buffer.from(JSON.stringify(wrongCount)) }).ok, false);
  const wrongOwnersFingerprint = signHistoryDocument({ ...receiptPayload, threadOwnersFingerprint: `sha256:${"f".repeat(64)}` }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, receipt: Buffer.from(JSON.stringify(wrongOwnersFingerprint)) }).ok, false);

  const { hmac: _ownersHmac, ...ownersPayload } = evidence.owners;
  const malformedOwners = signHistoryDocument({
    ...ownersPayload,
    threadIds: [ADOPTED_THREAD_ID, ADOPTED_THREAD_ID],
  }, staged.secret);
  assert.throws(() => parseHistoryAdoptionOwners(Buffer.from(JSON.stringify(malformedOwners))));
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, owners: Buffer.from(JSON.stringify(malformedOwners)) }).ok, false);
  const unsortedOwners = signHistoryDocument({
    ...ownersPayload,
    threadIds: ["22222222-2222-4222-8222-222222222222", ADOPTED_THREAD_ID],
  }, staged.secret);
  assert.throws(() => parseHistoryAdoptionOwners(Buffer.from(JSON.stringify(unsortedOwners))));
  const wrongAdoptedAt = signHistoryDocument({ ...ownersPayload, adoptedAt: "2026-08-31T12:00:01.000Z" }, staged.secret);
  assert.equal(validateHistoryAdoptionEvidence(staged.config, state, staged.secret, { ...raw, owners: Buffer.from(JSON.stringify(wrongAdoptedAt)) }).ok, false);
  assert.equal(historyAdoptionIntentFingerprint(evidence.intent), evidence.receipt.intentFingerprint);
});

test("history adoption rejects missing state ownership and any conflicting pending owner", () => {
  const staged = stagedV2();
  publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
  const missing = createInitialRouterState(staged.config);
  let result = validateHistoryAdoptionEvidence(staged.config, missing, staged.secret, rawEvidence(staged.root));
  assert.deepEqual(result, { ok: false, reason: "history_adoption_state_mismatch" });
  missing.threadOwners[ADOPTED_THREAD_ID] = staged.config.primaryOpaqueAccountId;
  missing.pendingThreadOwners[ADOPTED_THREAD_ID] = staged.config.accounts[1].opaqueAccountId;
  result = validateHistoryAdoptionEvidence(staged.config, missing, staged.secret, rawEvidence(staged.root));
  assert.deepEqual(result, { ok: false, reason: "history_adoption_state_mismatch" });
});

test("preflight rejects every missing evidence artifact and owner-home shape mismatch before a child can spawn", () => {
  for (const missing of ["history-adoption-intent.v1.json", "history-adoption-owners.v1.json", "history-adoption-receipt.v1.json"] as const) {
    const staged = stagedV2();
    publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
    unlinkSync(join(staged.root, missing));
    assert.deepEqual(preflightRouterHomesDetail(staged.config, staged.root), { ok: false, reason: "history_adoption_required" });
  }
  const staged = stagedV2();
  publishHistoryAdoptionEvidence({ root: staged.root, config: staged.config, secret: staged.secret });
  writePrivate(join(staged.root, "accounts", staged.config.primaryOpaqueAccountId, "sqlite-home", "goals_1.sqlite"), "ordinary-post-adoption-state-growth");
  assert.deepEqual(preflightRouterHomesDetail(staged.config, staged.root), { ok: true }, "runtime validates private artifact shape without rehashing mutable live state");
  unlinkSync(join(staged.root, "accounts", staged.config.primaryOpaqueAccountId, "sqlite-home", "goals_1.sqlite"));
  assert.deepEqual(preflightRouterHomesDetail(staged.config, staged.root), { ok: false, reason: "history_adoption_artifact_mismatch" });
  writeFileSync(join(staged.root, "accounts", staged.config.primaryOpaqueAccountId, "sqlite-home", "goals_1.sqlite"), "goals_1.sqlite", { mode: 0o644 });
  chmodSync(join(staged.root, "accounts", staged.config.primaryOpaqueAccountId, "sqlite-home", "goals_1.sqlite"), 0o644);
  assert.deepEqual(preflightRouterHomesDetail(staged.config, staged.root), { ok: false, reason: "history_adoption_artifact_mismatch" });
});
