import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrapCanonicalHistoryStoreV1, CANONICAL_HISTORY_MAX_BYTES_V1, CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1, CANONICAL_HISTORY_MAX_CONVERSATIONS_V1, CanonicalHistoryStoreV1, preflightCanonicalHistoryStore } from "../../src/account-router/canonical-history";
import type { OpaqueAccountId, OpaqueConversationId, OpaqueRendererRef } from "../../src/account-router/types";

const secret = Buffer.alloc(32, 71);
const accountA = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const accountB = `ar_${"b".repeat(43)}` as OpaqueAccountId;
const renderer = `br_${"r".repeat(43)}` as OpaqueRendererRef;

function store(): CanonicalHistoryStoreV1 {
  const root = mkdtempSync(join(tmpdir(), "canonical-history-"));
  chmodSync(root, 0o700);
  bootstrapCanonicalHistoryStoreV1(root);
  return new CanonicalHistoryStoreV1(root, () => Date.parse("2026-09-02T12:00:00.000Z"), undefined, (native) => `lh_${createHmac("sha256", secret).update(native).digest("base64url")}`);
}

test("same native conversation returns A to B to A without losing title or committed turns", () => {
  const history = store();
  const owner = { ownerRendererRef: renderer, ownerLabel: "ChatGPT" };
  const conversationId = history.createConversation({ ...owner, opaqueAccountId: accountA, nativeThreadId: "same-native", title: "Keep this title" });
  history.beginTurn(conversationId, accountA, "same-native", renderer, "ChatGPT", { input: [] });
  history.markTurnDispatching(conversationId, accountA, "same-native");
  assert.throws(() => history.activateNativeWriter({ ...owner, conversationId, opaqueAccountId: accountB, nativeThreadId: "same-native" }), /idle/);
  history.commitTurn(conversationId, accountA, "same-native", "first-turn", [{ id: "answer", type: "agentMessage", text: "Preserve this answer" }]);
  history.activateNativeWriter({ ...owner, conversationId, opaqueAccountId: accountB, nativeThreadId: "same-native" });
  history.activateNativeWriter({ ...owner, conversationId, opaqueAccountId: accountA, nativeThreadId: "same-native" });
  assert.deepEqual(history.activeNativeThread(conversationId), { opaqueAccountId: accountA, nativeThreadId: "same-native" });
  assert.equal(history.rootNativeThreadId(conversationId), "same-native");
  assert.equal(history.orderedNativeSegments(conversationId)?.length, 2);
  const read = history.logicalRead(history.publicThreadId(conversationId)!);
  assert.equal(read?.turns.length, 1);
  assert.equal(read?.turns[0]?.items[0]?.text, "Preserve this answer");
  assert.equal(read?.title, "Keep this title");
  history.reconcileNativeWriter(conversationId, accountB, "same-native");
  assert.deepEqual(history.activeNativeThread(conversationId), { opaqueAccountId: accountB, nativeThreadId: "same-native" });
  assert.equal(history.orderedNativeSegments(conversationId)?.length, 2);
});

test("native read routes retain A to B to A order without exposing mutable transcript state", () => {
  const history = store();
  const owner = { ownerRendererRef: renderer, ownerLabel: "ChatGPT" };
  const conversationId = history.createConversation({ ...owner, opaqueAccountId: accountA, nativeThreadId: "native-a" });
  history.addSegment({ ...owner, conversationId, opaqueAccountId: accountB, nativeThreadId: "native-b" });
  history.addSegment({ ...owner, conversationId, opaqueAccountId: accountA, nativeThreadId: "native-a-return" });
  const routes = history.orderedNativeSegments(conversationId)!;
  assert.deepEqual(routes, [
    { opaqueAccountId: accountA, nativeThreadId: "native-a" },
    { opaqueAccountId: accountB, nativeThreadId: "native-b" },
    { opaqueAccountId: accountA, nativeThreadId: "native-a-return" },
  ]);
  assert.ok(Object.isFrozen(routes)); assert.ok(routes.every(Object.isFrozen));
  assert.equal(Reflect.set(routes[0]!, "nativeThreadId", "changed"), false);
  assert.equal(routes[0]!.nativeThreadId, "native-a");
  assert.equal(history.rootNativeThreadId(conversationId), "native-a");
  assert.equal(history.orderedNativeSegments(`lc_${"z".repeat(43)}` as OpaqueConversationId), null);
});

test("zero-turn native bootstrap bindings stay routable but have no logical history projection across restart", () => {
  const history = store();
  const conversationId = history.createConversation({
    opaqueAccountId: accountA,
    nativeThreadId: "native-read-only",
    ownerRendererRef: renderer,
    ownerLabel: "Tweakers",
  });
  assert.equal(history.hasRecordedTurns(conversationId), false);
  assert.equal(history.project(conversationId, (account) => ({ accountId: account, label: "Account" })), null);
  assert.equal(history.conversationForNative(accountA, "native-read-only"), conversationId, "routing ownership remains bound");
  assert.deepEqual(history.activeNativeThread(conversationId), { opaqueAccountId: accountA, nativeThreadId: "native-read-only" });

  const reopened = reopen(history);
  assert.equal(reopened.hasRecordedTurns(conversationId), false);
  assert.equal(reopened.project(conversationId, (account) => ({ accountId: account, label: "Account" })), null);
  assert.equal(reopened.conversationForNative(accountA, "native-read-only"), conversationId, "restart retains the private native binding");
});

test("canonical store persists exact turn phases, committed portable transcript, and private native mapping", () => {
  const history = store();
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "thread-a", ownerRendererRef: renderer, ownerLabel: "ChatGPT", title: "Safe title" });
  const turnId = history.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "hello" }] });
  history.markTurnDispatching(conversationId, accountA, "thread-a");
  history.markTurnActive(conversationId, accountA, "thread-a");
  assert.equal(history.commitTurn(conversationId, accountA, "thread-a", "turn-native", [
    { id: "item-user", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    { id: "item-agent", type: "agentMessage", text: "world" },
    { id: "item-plan", type: "plan", text: "finish" },
  ]), turnId);
  const read = history.logicalRead(history.publicThreadId(conversationId)!);
  assert.equal(read?.turns.length, 1);
  assert.deepEqual(read?.turns[0]?.items.map((item) => item.kind), ["user", "assistant", "plan"]);
  assert.equal(history.publicTurnIdsForConversation(conversationId, ["turn-native", "item-agent"])?.get("item-agent"), turnId);
  const disk = readFileSync(history.path, "utf8");
  assert.match(disk, /"phase":"committed"/);
  assert.doesNotMatch(JSON.stringify(history.project(conversationId, (account) => ({ accountId: account, label: "Account" }))), /thread-a|turn-native/);
});

test("canonical store refuses unsafe completion items and keeps their segment explicitly incomplete", () => {
  const history = store();
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "thread-a", ownerRendererRef: renderer, ownerLabel: "ChatGPT" });
  history.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "hello" }] });
  history.markTurnDispatching(conversationId, accountA, "thread-a");
  assert.equal(history.commitTurn(conversationId, accountA, "thread-a", "turn-native", [
    { id: "unsafe", type: "agentMessage", text: "authorization: bearer secret" },
  ]), null);
  const projection = history.project(conversationId, (account) => ({ accountId: account, label: "Account" }));
  assert.equal(projection?.availability, "incomplete");
  assert.equal(projection?.historyWarning, "content_gap");
});

test("ordinary active work has no terminal history warning", () => {
  const history = store();
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "active-thread", ownerRendererRef: renderer, ownerLabel: "ChatGPT" });
  history.beginTurn(conversationId, accountA, "active-thread", renderer, "ChatGPT", { input: [{ type: "text", text: "working" }] });
  const projection = history.project(conversationId, (account) => ({ accountId: account, label: "Account" }));
  assert.equal(projection?.availability, "incomplete");
  assert.equal(projection?.historyWarning, null);
});

test("a linked-continuation receipt is content-free, restart-stable, and preserves a known gap after later success", () => {
  const history = store();
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "thread-a", ownerRendererRef: renderer, ownerLabel: "ChatGPT" });
  history.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "safe source" }] });
  history.markTurnDispatching(conversationId, accountA, "thread-a");
  history.markTurnActive(conversationId, accountA, "thread-a");
  assert.notEqual(history.commitTurn(conversationId, accountA, "thread-a", "safe-native-turn", [
    { id: "safe-user", type: "userMessage", content: [{ type: "text", text: "safe source" }] },
    { id: "safe-agent", type: "agentMessage", text: "safe completed output" },
  ]), null);

  const receipt = history.recordLinkedContinuationRequired(conversationId, accountA, "thread-a");
  const disk = readFileSync(history.path, "utf8");
  const record = JSON.parse(disk) as { conversations: Array<{ availability: string; segments: Array<{ turns: Array<{ turnId: string; state: string; phase: string; nativeTurnId: unknown; nativeItemIds: unknown; serializedInput: unknown; portableTranscript: unknown }> }> }> };
  const terminal = record.conversations[0]?.segments[0]?.turns.find((turn) => turn.turnId === receipt);
  assert.deepEqual(terminal && {
    state: terminal.state,
    phase: terminal.phase,
    nativeTurnId: terminal.nativeTurnId,
    nativeItemIds: terminal.nativeItemIds,
    serializedInput: terminal.serializedInput,
    portableTranscript: terminal.portableTranscript,
  }, {
    state: "incomplete",
    phase: "aborted",
    nativeTurnId: null,
    nativeItemIds: [],
    serializedInput: null,
    portableTranscript: null,
  });
  assert.equal(record.conversations[0]?.availability, "incomplete");
  assert.equal(history.logicalRead(history.publicThreadId(conversationId)!)?.turns.length, 1, "the receipt has no renderable transcript payload");
  assert.doesNotMatch(disk, /unsafe-account-local|image\.png|localImage/);

  const reopened = reopen(history);
  assert.equal(reopened.logicalRead(reopened.publicThreadId(conversationId)!)?.availability, "incomplete", "restart must retain the durable known gap");
  assert.equal(reopened.project(conversationId, (account) => ({ accountId: account, label: "Account" }))?.historyWarning, "content_gap");
  reopened.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "later safe turn" }] });
  reopened.markTurnDispatching(conversationId, accountA, "thread-a");
  reopened.markTurnActive(conversationId, accountA, "thread-a");
  assert.notEqual(reopened.commitTurn(conversationId, accountA, "thread-a", "later-native-turn", [
    { id: "later-user", type: "userMessage", content: [{ type: "text", text: "later safe turn" }] },
    { id: "later-agent", type: "agentMessage", text: "later safe output" },
  ]), null);
  assert.equal(reopened.logicalRead(reopened.publicThreadId(conversationId)!)?.availability, "incomplete", "a later successful turn must not hide the known gap");
  assert.equal(reopened.project(conversationId, (account) => ({ accountId: account, label: "Account" }))?.historyWarning, "content_gap");
});

test("restart recovery aborts pre-dispatch work and makes possibly-written turns terminally ambiguous", () => {
  const history = store();
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "thread-a", ownerRendererRef: renderer, ownerLabel: "ChatGPT" });
  history.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "prepared" }] });
  const restartedPrepared = new CanonicalHistoryStoreV1(history.root, () => Date.parse("2026-09-02T12:05:00.000Z"), undefined, (native) => `lh_${createHmac("sha256", secret).update(native).digest("base64url")}`);
  assert.deepEqual(restartedPrepared.recoverInFlightTurns(), { aborted: 1, ambiguous: 0 });
  let record = JSON.parse(readFileSync(history.path, "utf8")) as { conversations: Array<{ activeClient: unknown; availability: string; segments: Array<{ turns: Array<{ state: string; phase: string }> }> }> };
  assert.equal(record.conversations[0]?.activeClient, null);
  assert.equal(record.conversations[0]?.segments[0]?.turns[0]?.phase, "aborted");

  const reopened = new CanonicalHistoryStoreV1(history.root, () => Date.parse("2026-09-02T12:10:00.000Z"), undefined, (native) => `lh_${createHmac("sha256", secret).update(native).digest("base64url")}`);
  reopened.beginTurn(conversationId, accountA, "thread-a", renderer, "ChatGPT", { input: [{ type: "text", text: "possibly written" }] });
  reopened.markTurnDispatching(conversationId, accountA, "thread-a");
  const restartedDispatching = new CanonicalHistoryStoreV1(history.root, () => Date.parse("2026-09-02T12:15:00.000Z"), undefined, (native) => `lh_${createHmac("sha256", secret).update(native).digest("base64url")}`);
  assert.deepEqual(restartedDispatching.recoverInFlightTurns(), { aborted: 0, ambiguous: 1 });
  record = JSON.parse(readFileSync(history.path, "utf8")) as typeof record;
  assert.equal(record.conversations[0]?.availability, "ambiguous");
  assert.equal(record.conversations[0]?.segments[0]?.turns[1]?.phase, "ambiguous");
  assert.equal(restartedDispatching.project(conversationId, (account) => ({ accountId: account, label: "Account" }))?.historyWarning, "ambiguous");
});

test("canonical preflight rejects a tampered snapshot rather than silently creating a replacement", () => {
  const history = store();
  writeFileSync(history.path, "{bad", { mode: 0o600 });
  chmodSync(history.path, 0o600);
  assert.equal(preflightCanonicalHistoryStore(history.root).state, "invalid");
});

test("canonical persistence supports valid snapshots beyond 2 MiB and reopens after a new committed turn", () => {
  const history = store();
  const conversationId = createCommittedLargeConversation(history, "thread-large");
  writePrivateCanonicalSnapshot(history, growCanonicalSnapshot(history, 3 * 1024 * 1024));
  const seedTurnCount = persistedTurnCount(history);

  const large = reopen(history);
  const turnId = large.beginTurn(conversationId, accountA, "thread-large", renderer, "ChatGPT", { input: [{ type: "text", text: "commit after 2 MiB" }] });
  large.markTurnDispatching(conversationId, accountA, "thread-large");
  large.markTurnActive(conversationId, accountA, "thread-large");
  assert.equal(large.commitTurn(conversationId, accountA, "thread-large", "turn-after-large", [
    { id: "after-large-user", type: "userMessage", content: [{ type: "text", text: "commit after 2 MiB" }] },
    { id: "after-large-agent", type: "agentMessage", text: "committed after a valid large snapshot" },
  ]), turnId);
  assert.equal(readFileSync(large.path).byteLength > 2 * 1024 * 1024, true);
  assert.equal(reopen(large).logicalRead(large.publicThreadId(conversationId)!)?.turns.length, seedTurnCount + 1);
});

test("an over-limit canonical mutation leaves the snapshot and journal untouched and reopenable", () => {
  const history = store();
  const conversationId = createCommittedLargeConversation(history, "thread-boundary");
  writePrivateCanonicalSnapshot(history, growCanonicalSnapshot(history, CANONICAL_HISTORY_MAX_BYTES_V1 - 100));
  const seedTurnCount = persistedTurnCount(history);
  const bounded = reopen(history);
  const beforeSnapshot = readFileSync(bounded.path);
  const beforeJournal = existsSync(bounded.journalPath) ? readFileSync(bounded.journalPath) : Buffer.alloc(0);
  assert.throws(
    () => bounded.beginTurn(conversationId, accountA, "thread-boundary", renderer, "ChatGPT", { input: [{ type: "text", text: "must not append" }] }),
    /canonical history exceeds bounded snapshot size/,
  );
  assert.deepEqual(readFileSync(bounded.path), beforeSnapshot, "oversized mutation must not replace the prior snapshot");
  assert.deepEqual(existsSync(bounded.journalPath) ? readFileSync(bounded.journalPath) : Buffer.alloc(0), beforeJournal, "oversized mutation must not append a recovery record");
  assert.equal(reopen(bounded).logicalRead(bounded.publicThreadId(conversationId)!)?.turns.length, seedTurnCount);
});

function reopen(history: CanonicalHistoryStoreV1): CanonicalHistoryStoreV1 {
  return new CanonicalHistoryStoreV1(history.root, () => Date.parse("2026-09-02T12:30:00.000Z"), undefined, (native) => `lh_${createHmac("sha256", secret).update(native).digest("base64url")}`);
}

function createCommittedLargeConversation(history: CanonicalHistoryStoreV1, nativeThreadId: string): OpaqueConversationId {
  const conversationId = history.createConversation({ opaqueAccountId: accountA, nativeThreadId, ownerRendererRef: renderer, ownerLabel: "ChatGPT" });
  history.beginTurn(conversationId, accountA, nativeThreadId, renderer, "ChatGPT", { input: [{ type: "text", text: "large seed" }] });
  history.markTurnDispatching(conversationId, accountA, nativeThreadId);
  history.markTurnActive(conversationId, accountA, nativeThreadId);
  assert.notEqual(history.commitTurn(conversationId, accountA, nativeThreadId, "large-native-turn", [
    { id: "large-user", type: "userMessage", content: [{ type: "text", text: "large seed" }] },
    { id: "large-agent", type: "agentMessage", text: "x".repeat(90_000) },
  ]), null);
  return conversationId;
}

function growCanonicalSnapshot(history: CanonicalHistoryStoreV1, targetBytes: number): Record<string, unknown> {
  const document = JSON.parse(readFileSync(history.path, "utf8")) as Record<string, unknown>;
  const conversation = (document.conversations as Array<Record<string, unknown>>)[0]!;
  const segment = (conversation.segments as Array<Record<string, unknown>>)[0]!;
  const turns = segment.turns as Array<Record<string, unknown>>;
  const template = structuredClone(turns[0]!);
  let currentTurns = turns;
  let size = canonicalBytes(document);
  const full = cloneLargeTurn(template, 90_000);
  const fullBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  for (;;) {
    // Keep every segment within its real 1,024-turn bound, including a later
    // mutation, and calculate append sizes without repeatedly serializing 128 MiB.
    if (currentTurns.length >= 800) {
      const nextSegment = { ...segment, segmentId: `ls_${"s".repeat(42)}${(conversation.segments as unknown[]).length}`, nativeThreadId: `fixture-segment-${(conversation.segments as unknown[]).length}`, turns: [] };
      (conversation.segments as unknown[]).push(nextSegment);
      currentTurns = nextSegment.turns;
      size = canonicalBytes(document);
    }
    const comma = currentTurns.length === 0 ? 0 : 1;
    if (size + comma + fullBytes + 1000 < targetBytes) {
      currentTurns.push(full);
      size += comma + fullBytes;
      continue;
    }
    const final = cloneLargeTurn(template, 0);
    currentTurns.push(final);
    const fill = targetBytes - canonicalBytes(document);
    assert.ok(fill >= 0 && fill <= 96 * 1024, "final bounded transcript item must fit the portable-item limit");
    setPortableAssistantText(final, "x".repeat(fill));
    assert.equal(canonicalBytes(document), targetBytes, "test fixture should hit its exact private snapshot boundary");
    return document;
  }
}

function cloneLargeTurn(template: Record<string, unknown>, textLength: number): Record<string, unknown> {
  const turn = structuredClone(template);
  setPortableAssistantText(turn, "x".repeat(textLength));
  return turn;
}

function setPortableAssistantText(turn: Record<string, unknown>, text: string): void {
  const transcript = turn.portableTranscript as { digest: string; items: Array<Record<string, unknown>> };
  const assistant = transcript.items.find((item) => item.kind === "assistant");
  assert.ok(assistant);
  assistant.text = text;
  transcript.digest = `sha256:${createHash("sha256").update(JSON.stringify(transcript.items), "utf8").digest("hex")}`;
}

function writePrivateCanonicalSnapshot(history: CanonicalHistoryStoreV1, document: Record<string, unknown>): void {
  writeFileSync(history.path, `${JSON.stringify(document)}\n`, { mode: 0o600 });
  chmodSync(history.path, 0o600);
  if (existsSync(history.journalPath)) {
    writeFileSync(history.journalPath, "", { mode: 0o600 });
    chmodSync(history.journalPath, 0o600);
  }
}

function canonicalBytes(document: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(document)}\n`, "utf8");
}

function persistedTurnCount(history: CanonicalHistoryStoreV1): number {
  const document = JSON.parse(readFileSync(history.path, "utf8")) as { conversations: Array<{ segments: Array<{ turns: unknown[] }> }> };
  return document.conversations[0]?.segments.reduce((count, segment) => count + segment.turns.length, 0) ?? 0;
}


test("the canonical capacity preserves 16,384 independent conversations and refuses only the next creation", () => {
  const history = store();
  history.createConversation({ opaqueAccountId: accountA, nativeThreadId: "capacity-seed", ownerRendererRef: renderer, ownerLabel: "Tweakers" });
  const document = JSON.parse(readFileSync(history.path, "utf8"));
  const template = document.conversations[0];
  document.conversations = Array.from({ length: CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 }, (_, index) => {
    const suffix = createHash("sha256").update(String(index)).digest("base64url");
    return { ...template, conversationId: `lc_${suffix}`, publicThreadId: `lh_${suffix}`, rootNativeThreadId: `capacity-${index}`, segments: [{ ...template.segments[0], segmentId: `ls_${suffix}`, nativeThreadId: `capacity-${index}` }] };
  });
  writePrivateCanonicalSnapshot(history, document);
  const reopened = reopen(history);
  assert.equal(reopened.logicalList().length, CANONICAL_HISTORY_MAX_CONVERSATIONS_V1);
  assert.equal(reopened.conversationForNative(accountA, "capacity-16383"), document.conversations.at(-1).conversationId);
  const before = createHash("sha256").update(readFileSync(history.path)).digest("hex");
  assert.throws(() => reopened.createConversation({ opaqueAccountId: accountA, nativeThreadId: "capacity-overflow", ownerRendererRef: renderer, ownerLabel: "Tweakers" }), /conversation capacity reached/);
  assert.equal(createHash("sha256").update(readFileSync(history.path)).digest("hex"), before);
});

test("the exact fixed WAL envelope fits the declared snapshot headroom", () => {
  const document = { version: 1, conversations: [] };
  const record = { version: 1, digest: `sha256:${"f".repeat(64)}`, document };
  const envelopeBytes = canonicalBytes(record) - canonicalBytes(document);
  assert.ok(envelopeBytes > 0);
  assert.ok(CANONICAL_HISTORY_MAX_BYTES_V1 + envelopeBytes <= CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
});
