import { createHmac } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  historyAdoptionIntentFingerprint,
  historyAdoptionPoolFingerprint,
  historyAdoptionThreadOwnersFingerprint,
  type HistoryAdoptionIntentV1,
  type HistoryAdoptionOwnersV1,
  type HistoryAdoptionReceiptV1,
} from "../../src/account-router/history-adoption";
import { createInitialRouterState } from "../../src/account-router/state-store";
import type { RouterConfigV2 } from "../../src/account-router/types";

const DATABASES = [
  "goals_1.sqlite", "logs_2.sqlite", "memories_1.sqlite", "queue_1.sqlite", "state_5.sqlite", "thread_history_1.sqlite",
] as const;
const HISTORIES = ["archived_sessions", "session_index.jsonl", "sessions"] as const;
const HASH_A = `sha256:${"a".repeat(64)}` as const;
const HASH_B = `sha256:${"b".repeat(64)}` as const;
const HASH_C = `sha256:${"c".repeat(64)}` as const;
const HASH_D = `sha256:${"d".repeat(64)}` as const;

export const ADOPTED_THREAD_ID = "11111111-1111-4111-8111-111111111111";

export function writePrivate(path: string, value: string | Buffer): void {
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function signHistoryDocument<T extends Record<string, unknown>>(payload: T, secret: Buffer): T & { hmac: `hmac-sha256:${string}` } {
  return {
    ...payload,
    hmac: `hmac-sha256:${createHmac("sha256", secret).update(canonicalJson(payload), "utf8").digest("hex")}`,
  };
}

export function publishHistoryAdoptionEvidence(input: {
  root: string;
  config: RouterConfigV2;
  secret: Buffer;
  threadIds?: readonly string[];
  adoptedAt?: string;
}): { intent: HistoryAdoptionIntentV1; owners: HistoryAdoptionOwnersV1; receipt: HistoryAdoptionReceiptV1 } {
  const threadIds = input.threadIds ?? [ADOPTED_THREAD_ID];
  const adoptedAt = input.adoptedAt ?? "2026-08-31T12:00:00.000Z";
  const owner = input.config.primaryOpaqueAccountId;
  const codexHome = join(input.root, "accounts", owner, "codex-home");
  const sqliteHome = join(input.root, "accounts", owner, "sqlite-home");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(sqliteHome, { recursive: true, mode: 0o700 });
  for (const name of DATABASES) writePrivate(join(sqliteHome, name), name);
  for (const name of HISTORIES) {
    const path = join(codexHome, name);
    if (name === "session_index.jsonl") writePrivate(path, "{}\n");
    else mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const state = createInitialRouterState(input.config);
  for (const threadId of threadIds) {
    state.threadOwners[threadId] = owner;
    state.ledger[owner].assignedThreadCount += 1;
  }
  writePrivate(join(input.root, "router-state.json"), JSON.stringify(state));
  const poolFingerprint = historyAdoptionPoolFingerprint(input.config.protocolFingerprint, input.config.accounts.map((account) => account.opaqueAccountId));
  const intent = signHistoryDocument({
    schemaVersion: 1 as const,
    kind: "account-router-history-adoption-intent" as const,
    protocolFingerprint: input.config.protocolFingerprint,
    poolFingerprint,
    configGeneration: input.config.generation,
    configFingerprint: input.config.fingerprint,
    legacyOwnerOpaqueAccountId: owner,
    createdAt: adoptedAt,
  }, input.secret) as HistoryAdoptionIntentV1;
  const ownersFingerprint = historyAdoptionThreadOwnersFingerprint(threadIds, owner);
  const owners = signHistoryDocument({
    schemaVersion: 1 as const,
    kind: "account-router-history-adoption-owners" as const,
    protocolFingerprint: input.config.protocolFingerprint,
    poolFingerprint,
    legacyOwnerOpaqueAccountId: owner,
    threadIds: [...threadIds],
    threadOwnersFingerprint: ownersFingerprint,
    adoptedAt,
  }, input.secret) as HistoryAdoptionOwnersV1;
  const receipt = signHistoryDocument({
    schemaVersion: 1 as const,
    kind: "account-router-history-adoption-receipt" as const,
    protocolFingerprint: input.config.protocolFingerprint,
    poolFingerprint,
    intentFingerprint: historyAdoptionIntentFingerprint(intent),
    legacyOwnerOpaqueAccountId: owner,
    sourceFingerprint: HASH_A,
    destinationFingerprint: HASH_B,
    databases: DATABASES.map((name) => ({ name, present: true, sha256: HASH_C, bytes: Buffer.byteLength(name), integrity: "ok" as const })),
    histories: [
      { name: "archived_sessions" as const, present: true, sha256: HASH_C, bytes: 0, fileCount: 0 },
      { name: "session_index.jsonl" as const, present: true, sha256: HASH_C, bytes: 3, fileCount: 1 },
      { name: "sessions" as const, present: true, sha256: HASH_C, bytes: 0, fileCount: 0 },
    ],
    importedThreadCount: threadIds.length,
    threadOwnersFingerprint: ownersFingerprint,
    backupFingerprint: HASH_D,
    adoptedAt,
  }, input.secret) as HistoryAdoptionReceiptV1;
  writePrivate(join(input.root, "history-adoption-intent.v1.json"), JSON.stringify(intent));
  writePrivate(join(input.root, "history-adoption-owners.v1.json"), JSON.stringify(owners));
  writePrivate(join(input.root, "history-adoption-receipt.v1.json"), JSON.stringify(receipt));
  return { intent, owners, receipt };
}
