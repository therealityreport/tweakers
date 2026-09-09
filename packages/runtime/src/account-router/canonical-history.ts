import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateRegularFile, ensurePrivateDirectory, writePrivateJsonAtomicBounded } from "./state-store";
import type {
  LogicalConversationProjectionV1,
  LogicalHistoryActiveClientV1,
  LogicalHistorySubscriptionV1,
  LogicalTurnProjectionV1,
  OpaqueAccountId,
  OpaqueConversationId,
  OpaqueRendererRef,
  OpaqueSegmentId,
  OpaqueTurnId,
} from "./types";
import {
  isOpaqueAccountId,
  isOpaqueConversationId,
  isOpaqueRendererRef,
  isOpaqueSegmentId,
  isOpaqueTurnId,
  isPlainRecord,
} from "./types";

/** Broker-owned, private logical transcript. It is not an account-home store. */
export const CANONICAL_HISTORY_FILE_V1 = "canonical-history.v1.json";
export const CANONICAL_HISTORY_JOURNAL_FILE_V1 = "canonical-history.v1.journal.jsonl";
export const CANONICAL_HISTORY_VERSION_V1 = 1 as const;

// This owner-private snapshot is compacted atomically. It is deliberately
// sized for ordinary long-lived use; a future journal must preserve these
// exact immutable records rather than evicting completed segments.
export const CANONICAL_HISTORY_MAX_BYTES_V1 = 128 * 1024 * 1024;
// The write-ahead record contains the full snapshot plus its envelope. Keep
// the envelope separately bounded so every valid snapshot fits a recovery
// record. Migration preview measures the exact serialized record as well.
export const CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1 = CANONICAL_HISTORY_MAX_BYTES_V1 + 1024;
export const CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 = 16_384;
const MAX_SEGMENTS_PER_CONVERSATION = 64;
const MAX_TURNS_PER_SEGMENT = 1_024;
const MAX_SERIALIZED_INPUT_BYTES = 24 * 1024;
const MAX_CONTINUITY_BYTES = 32 * 1024;
const MAX_PORTABLE_TRANSCRIPT_BYTES = 96 * 1024;
const MAX_PORTABLE_TRANSCRIPT_ITEMS = 256;

type LogicalState = "committed" | "active" | "incomplete" | "ambiguous";
type LogicalAvailability = "complete" | "partial" | "incomplete" | "ambiguous";
export type CanonicalTurnPhaseV1 = "prepared" | "dispatching" | "active" | "committed" | "aborted" | "ambiguous";

interface SerializedInputV1 {
  digest: `sha256:${string}`;
  text: string;
}

/** A deliberately portable, credential-free subset of a completed Turn.items. */
export interface PortableTranscriptItemV1 {
  kind: "user" | "assistant" | "plan" | "tool";
  text?: string;
  name?: string;
  result?: string;
}

interface PortableTranscriptV1 {
  digest: `sha256:${string}`;
  items: PortableTranscriptItemV1[];
}

interface PrivateTurnV1 {
  turnId: OpaqueTurnId;
  nativeTurnId: string | null;
  nativeItemIds: string[];
  state: LogicalState;
  phase: CanonicalTurnPhaseV1;
  startedAt: string;
  committedAt?: string;
  serializedInput: SerializedInputV1 | null;
  portableTranscript: PortableTranscriptV1 | null;
}

interface PrivateSegmentV1 {
  segmentId: OpaqueSegmentId;
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  state: LogicalState;
  createdAt: string;
  committedAt?: string;
  turns: PrivateTurnV1[];
}

interface ActiveClientV1 {
  clientId: OpaqueRendererRef;
  label: string;
}

interface PrivateConversationV1 {
  conversationId: OpaqueConversationId;
  /** Owner-private native id used only to rewrite the origin desktop's frames. */
  rootNativeThreadId: string;
  /** HMAC/sha-derived public alias; provider ids are never represented by it. */
  publicThreadId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  availability: LogicalAvailability;
  activeClient: ActiveClientV1 | null;
  segments: PrivateSegmentV1[];
}

interface CanonicalHistoryDocumentV1 {
  version: 1;
  conversations: PrivateConversationV1[];
}

interface CanonicalHistoryJournalRecordV1 {
  version: 1;
  digest: `sha256:${string}`;
  document: CanonicalHistoryDocumentV1;
}

export interface CanonicalHistoryPreflightV1 {
  version: 1;
  fileName: typeof CANONICAL_HISTORY_FILE_V1;
  state: "ready" | "missing" | "invalid";
  conversationCount: number;
  segmentCount: number;
}

export interface CanonicalHistorySubscriptionResolverV1 {
  (accountId: OpaqueAccountId): LogicalHistorySubscriptionV1 | null;
}

export interface CanonicalHistoryCreateInputV1 {
  opaqueAccountId: OpaqueAccountId;
  nativeThreadId: string;
  ownerRendererRef: OpaqueRendererRef;
  ownerLabel: string;
  title?: string | null;
}

export interface CanonicalHistorySegmentInputV1 extends CanonicalHistoryCreateInputV1 {
  conversationId: OpaqueConversationId;
}

export interface CanonicalContinuationContextV1 {
  digest: `sha256:${string}`;
  /** Owner-private, bounded context inserted into a supported turn/start additionalContext field. */
  text: string;
}

/**
 * Strict preflight for offline migration and startup guards. It is intentionally
 * read-only and does not create, repair, or migrate a history file.
 */
export function preflightCanonicalHistoryStore(root: string): CanonicalHistoryPreflightV1 {
  const path = join(root, CANONICAL_HISTORY_FILE_V1);
  if (!existsSync(path)) {
    return { version: 1, fileName: CANONICAL_HISTORY_FILE_V1, state: "missing", conversationCount: 0, segmentCount: 0 };
  }
  try {
    assertPrivateRegularFile(path, CANONICAL_HISTORY_MAX_BYTES_V1);
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > CANONICAL_HISTORY_MAX_BYTES_V1) throw new Error("oversized");
    const parsed = JSON.parse(raw) as unknown;
    if (!isCanonicalHistoryDocument(parsed)) throw new Error("invalid");
    return {
      version: 1,
      fileName: CANONICAL_HISTORY_FILE_V1,
      state: "ready",
      conversationCount: parsed.conversations.length,
      segmentCount: parsed.conversations.reduce((count, conversation) => count + conversation.segments.length, 0),
    };
  } catch {
    return { version: 1, fileName: CANONICAL_HISTORY_FILE_V1, state: "invalid", conversationCount: 0, segmentCount: 0 };
  }
}

/**
 * The only explicit empty-history bootstrap. Runtime loading deliberately
 * does not call this: V3 startup must distinguish a deliberately initialized
 * empty transcript from a missing migration artifact and fail closed for the
 * latter.
 */
export function bootstrapCanonicalHistoryStoreV1(root: string): void {
  ensurePrivateDirectory(root);
  const preflight = preflightCanonicalHistoryStore(root);
  if (preflight.state === "ready") return;
  if (preflight.state === "invalid") throw new Error("canonical history store is invalid");
  writeCanonicalHistorySnapshot(root, { version: CANONICAL_HISTORY_VERSION_V1, conversations: [] });
}

/**
 * Canonical logical conversation storage. Provider native ids and serialized
 * input remain private to the broker root and never appear in projections.
 */
export class CanonicalHistoryStoreV1 {
  private state: CanonicalHistoryDocumentV1;

  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly random: (size: number) => Buffer = randomBytes,
    private readonly publicThreadIdForNative: (nativeThreadId: string) => string,
  ) {
    ensurePrivateDirectory(root);
    const preflight = preflightCanonicalHistoryStore(root);
    if (preflight.state !== "ready") {
      throw new Error(`canonical history store is ${preflight.state}; use explicit bootstrap or repair migration`);
    }
    this.state = this.load();
  }

  get path(): string {
    return join(this.root, CANONICAL_HISTORY_FILE_V1);
  }

  get journalPath(): string { return join(this.root, CANONICAL_HISTORY_JOURNAL_FILE_V1); }

  conversationForNative(opaqueAccountId: OpaqueAccountId, nativeThreadId: string): OpaqueConversationId | null {
    const found = this.findSegment(opaqueAccountId, nativeThreadId);
    return found?.conversation.conversationId ?? null;
  }

  conversationForPublicThreadId(publicThreadId: string): OpaqueConversationId | null {
    return this.state.conversations.find((conversation) => conversation.publicThreadId === publicThreadId)?.conversationId ?? null;
  }

  hasConversations(): boolean { return this.state.conversations.length > 0; }

  publicThreadId(conversationId: OpaqueConversationId): string | null {
    return this.findConversation(conversationId)?.publicThreadId ?? null;
  }

  /** One canonical conversation has one writer lease at a time. */
  hasActiveTurn(conversationId: OpaqueConversationId): boolean {
    const conversation = this.findConversation(conversationId);
    return Boolean(conversation?.segments.some((segment) => segment.turns.some((turn) => turn.state === "active")));
  }

  /** Bootstrap bindings have no canonical turn evidence and stay out of history UI. */
  hasRecordedTurns(conversationId: OpaqueConversationId): boolean {
    const conversation = this.findConversation(conversationId);
    return Boolean(conversation?.segments.some((segment) => segment.turns.length > 0));
  }

  /** Owner-private routing alias; callers must never send it through renderer IPC. */
  rootNativeThreadId(conversationId: OpaqueConversationId): string | null {
    return this.findConversation(conversationId)?.rootNativeThreadId ?? null;
  }

  /** Owner-private, immutable physical read routes in conversation order; never renderer IPC. */
  orderedNativeSegments(conversationId: OpaqueConversationId): readonly Readonly<{ opaqueAccountId: OpaqueAccountId; nativeThreadId: string }>[] | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation || conversation.segments.length > MAX_SEGMENTS_PER_CONVERSATION) return null;
    return Object.freeze(conversation.segments.map(({ opaqueAccountId, nativeThreadId }) => Object.freeze({ opaqueAccountId, nativeThreadId })));
  }

  /** Bounded physical binding used only by the runtime-owned native target bridge. */
  publicTurnIdsForNative(
    conversationId: OpaqueConversationId,
    opaqueAccountId: OpaqueAccountId,
    nativeThreadId: string,
    nativeTurnIds: readonly string[],
  ): ReadonlyMap<string, OpaqueTurnId> | null {
    if (nativeTurnIds.length > 128 || nativeTurnIds.some((turnId) => !validNativeId(turnId))) return null;
    const binding = this.findSegment(opaqueAccountId, nativeThreadId);
    if (!binding || binding.conversation.conversationId !== conversationId || binding.conversation.availability === "ambiguous") return null;
    return this.publicTurnIdsForConversation(conversationId, nativeTurnIds);
  }

  /** Exact native turn/item identity lookup for the runtime-owned DOM bridge. */
  publicTurnIdsForConversation(conversationId: OpaqueConversationId, nativeTurnIds: readonly string[]): ReadonlyMap<string, OpaqueTurnId> | null {
    if (nativeTurnIds.length > 128 || nativeTurnIds.some((turnId) => !validNativeId(turnId))) return null;
    const conversation = this.findConversation(conversationId);
    if (!conversation || conversation.availability === "ambiguous") return null;
    const found = new Map<string, OpaqueTurnId>();
    for (const nativeTurnId of nativeTurnIds) {
      const turn = conversation.segments.flatMap((segment) => segment.turns)
        .find((candidate) => candidate.state === "committed" && (candidate.nativeTurnId === nativeTurnId || candidate.nativeItemIds.includes(nativeTurnId)));
      if (!turn) return null;
      found.set(nativeTurnId, turn.turnId);
    }
    return found;
  }

  /** The active segment routes a desktop's stable public thread alias. */
  activeNativeThread(conversationId: OpaqueConversationId): { opaqueAccountId: OpaqueAccountId; nativeThreadId: string } | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation) return null;
    const segment = conversation.segments.find((candidate) => candidate.state === "active")
      // A content-free linked-continuation receipt deliberately marks its
      // source segment incomplete. It is still the only safe physical route
      // for a later source-account turn; ambiguity remains unroutable.
      ?? [...conversation.segments].reverse().find((candidate) => candidate.state === "committed" || candidate.state === "incomplete")
      ?? null;
    return segment ? { opaqueAccountId: segment.opaqueAccountId, nativeThreadId: segment.nativeThreadId } : null;
  }

  createConversation(input: CanonicalHistoryCreateInputV1): OpaqueConversationId {
    assertCreateInput(input);
    if (this.findSegment(input.opaqueAccountId, input.nativeThreadId)) {
      throw new Error("canonical history native thread binding already exists");
    }
    let conversationId: OpaqueConversationId;
    do { conversationId = opaqueId("lc", this.random) as OpaqueConversationId; } while (this.findConversation(conversationId));
    const createdAt = this.timestamp();
    this.mutate((state) => {
      if (state.conversations.length >= CANONICAL_HISTORY_MAX_CONVERSATIONS_V1) throw new Error("canonical history conversation capacity reached");
      state.conversations.push({
        conversationId,
        rootNativeThreadId: input.nativeThreadId,
        publicThreadId: this.publicThreadIdForNative(input.nativeThreadId),
        title: safeTitle(input.title) ? input.title : null,
        createdAt,
        updatedAt: createdAt,
        availability: "incomplete",
        activeClient: { clientId: input.ownerRendererRef, label: input.ownerLabel },
        segments: [this.newSegment(input, createdAt)],
      });
    });
    return conversationId;
  }

  addSegment(input: CanonicalHistorySegmentInputV1): OpaqueSegmentId {
    assertCreateInput(input);
    const conversation = this.findConversation(input.conversationId);
    if (!conversation) throw new Error("unknown canonical conversation");
    if (this.findSegment(input.opaqueAccountId, input.nativeThreadId)) throw new Error("canonical history native thread binding already exists");
    let segmentId: OpaqueSegmentId;
    do { segmentId = opaqueId("ls", this.random) as OpaqueSegmentId; } while (conversation.segments.some((segment) => segment.segmentId === segmentId));
    const createdAt = this.timestamp();
    this.mutate((state) => {
      const mutable = requireConversation(state, input.conversationId);
      if (mutable.segments.length >= MAX_SEGMENTS_PER_CONVERSATION) throw new Error("canonical history segment capacity reached");
      for (const segment of mutable.segments) if (segment.state === "active") segment.state = "committed";
      mutable.segments.push({ ...this.newSegment(input, createdAt), segmentId });
      mutable.activeClient = { clientId: input.ownerRendererRef, label: input.ownerLabel };
      mutable.availability = "incomplete";
      mutable.updatedAt = createdAt;
    });
    return segmentId;
  }

  /** Reconcile an already-proved native writer without inventing a live desktop owner. */
  reconcileNativeWriter(conversationId: OpaqueConversationId, account: OpaqueAccountId, nativeThreadId: string): void {
    if (!isOpaqueAccountId(account) || !validNativeId(nativeThreadId)) throw new Error("invalid native writer");
    this.mutate((state) => {
      const conversation = requireConversation(state, conversationId);
      if (conversation.rootNativeThreadId !== nativeThreadId || conversation.segments.some((segment) => segment.turns.some((turn) => turn.state === "active" || turn.state === "ambiguous"))) throw new Error("native writer is not idle");
      let target = conversation.segments.find((segment) => segment.opaqueAccountId === account && segment.nativeThreadId === nativeThreadId);
      if (!target) {
        if (conversation.segments.length >= MAX_SEGMENTS_PER_CONVERSATION) throw new Error("native segment capacity reached");
        target = { segmentId: opaqueId("ls", this.random) as OpaqueSegmentId, opaqueAccountId: account, nativeThreadId, state: "active", createdAt: this.timestamp(), turns: [] };
        conversation.segments.push(target);
      }
      for (const segment of conversation.segments) if (segment !== target && segment.state === "active") segment.state = "committed";
      target.state = "active";
      conversation.activeClient = null;
      conversation.updatedAt = this.timestamp();
    });
  }

  /** Native same-ID transfer preserves every prior turn and the visible conversation. */
  activateNativeWriter(input: CanonicalHistorySegmentInputV1): void {
    assertCreateInput(input);
    const conversation = this.findConversation(input.conversationId);
    if (!conversation || conversation.rootNativeThreadId !== input.nativeThreadId
      || conversation.segments.some((segment) => segment.turns.some((turn) => turn.state === "active" || turn.state === "ambiguous"))) {
      throw new Error("native writer transfer requires an idle proven conversation");
    }
    const existing = this.findSegment(input.opaqueAccountId, input.nativeThreadId);
    if (!existing) { this.addSegment(input); return; }
    this.mutate((state) => {
      const { conversation, segment } = requireSegment(state, input.conversationId, input.opaqueAccountId, input.nativeThreadId);
      for (const other of conversation.segments) if (other !== segment && other.state === "active") other.state = "committed";
      segment.state = "active";
      conversation.activeClient = { clientId: input.ownerRendererRef, label: input.ownerLabel };
      conversation.updatedAt = this.timestamp();
    });
  }

  beginTurn(
    conversationId: OpaqueConversationId,
    opaqueAccountId: OpaqueAccountId,
    nativeThreadId: string,
    ownerRendererRef: OpaqueRendererRef,
    ownerLabel: string,
    input: unknown,
  ): OpaqueTurnId {
    const context = serializeInput(input);
    let turnId: OpaqueTurnId;
    do { turnId = opaqueId("lt", this.random) as OpaqueTurnId; } while (this.hasTurn(turnId));
    const startedAt = this.timestamp();
    this.mutate((state) => {
      const { conversation, segment } = requireSegment(state, conversationId, opaqueAccountId, nativeThreadId);
      if (segment.turns.length >= MAX_TURNS_PER_SEGMENT) throw new Error("canonical history turn capacity reached");
      if (conversation.segments.some((candidate) => candidate !== segment && candidate.state === "active")) {
        throw new Error("canonical history refused concurrent segment writers");
      }
      if (segment.turns.some((turn) => turn.state === "active")) throw new Error("canonical history refused concurrent turn writers");
      segment.state = "active";
      segment.turns.push({ turnId, nativeTurnId: null, nativeItemIds: [], state: "active", phase: "prepared", startedAt, serializedInput: context, portableTranscript: null });
      conversation.activeClient = { clientId: ownerRendererRef, label: ownerLabel };
      conversation.availability = "incomplete";
      conversation.updatedAt = startedAt;
    });
    return turnId;
  }

  commitTurn(
    conversationId: OpaqueConversationId,
    opaqueAccountId: OpaqueAccountId,
    nativeThreadId: string,
    nativeTurnId: string | null,
    completedItems: unknown,
  ): OpaqueTurnId | null {
    const committedAt = this.timestamp();
    let committed: OpaqueTurnId | null = null;
    this.mutate((state) => {
      const { conversation, segment } = requireSegment(state, conversationId, opaqueAccountId, nativeThreadId);
      const active = [...segment.turns].reverse().find((turn) => turn.state === "active") ?? null;
      if (!active) return;
      const portableTranscript = portableTranscriptFromItems(completedItems);
      if (!portableTranscript) {
        active.state = "incomplete";
        segment.state = "incomplete";
        conversation.activeClient = null;
        conversation.availability = availabilityFor(conversation);
        conversation.updatedAt = committedAt;
        return;
      }
      active.nativeTurnId = validNativeId(nativeTurnId) ? nativeTurnId : null;
      active.nativeItemIds = nativeItemIds(completedItems);
      active.portableTranscript = portableTranscript;
      active.state = "committed";
      active.phase = "committed";
      active.committedAt = committedAt;
      segment.state = "committed";
      segment.committedAt = committedAt;
      conversation.activeClient = null;
      conversation.availability = availabilityFor(conversation);
      conversation.updatedAt = committedAt;
      committed = active.turnId;
    });
    return committed;
  }

  markIncomplete(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void {
    this.markTerminal(conversationId, opaqueAccountId, nativeThreadId, "incomplete");
  }

  /**
   * Preserve a known cross-subscription continuity gap without retaining the
   * rejected request, attachment, path, or provider-side target.  The record
   * belongs to the already-bound source segment and is terminal before any
   * destination child is acquired.
   */
  recordLinkedContinuationRequired(
    conversationId: OpaqueConversationId,
    opaqueAccountId: OpaqueAccountId,
    nativeThreadId: string,
  ): OpaqueTurnId {
    let turnId: OpaqueTurnId;
    do { turnId = opaqueId("lt", this.random) as OpaqueTurnId; } while (this.hasTurn(turnId));
    const at = this.timestamp();
    this.mutate((document) => {
      const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
      if (segment.turns.length >= MAX_TURNS_PER_SEGMENT) throw new Error("canonical history turn capacity reached");
      if (segment.turns.some((turn) => turn.state === "active")) throw new Error("canonical history refused terminal receipt during active turn");
      segment.turns.push({
        turnId,
        nativeTurnId: null,
        nativeItemIds: [],
        state: "incomplete",
        phase: "aborted",
        startedAt: at,
        serializedInput: null,
        portableTranscript: null,
      });
      segment.state = "incomplete";
      conversation.activeClient = null;
      conversation.availability = availabilityFor(conversation);
      conversation.updatedAt = at;
    });
    return turnId;
  }

  markTurnDispatching(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void {
    this.markTurnPhase(conversationId, opaqueAccountId, nativeThreadId, "dispatching");
  }

  markTurnActive(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void {
    this.markTurnPhase(conversationId, opaqueAccountId, nativeThreadId, "active");
  }

  markAmbiguous(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string): void {
    this.markTerminal(conversationId, opaqueAccountId, nativeThreadId, "ambiguous");
  }

  /**
   * A broker restart has no reliable child-write acknowledgement. A prepared
   * turn is proven not to have left the broker, while dispatching/active turns
   * may have reached a child. Settle those two classes differently and never
   * replay either one automatically.
   */
  recoverInFlightTurns(): { aborted: number; ambiguous: number } {
    let aborted = 0;
    let ambiguous = 0;
    const at = this.timestamp();
    this.mutate((document) => {
      for (const conversation of document.conversations) {
        let conversationChanged = false;
        for (const segment of conversation.segments) {
          for (const turn of segment.turns) {
            if (turn.state !== "active") continue;
            if (turn.phase === "prepared") {
              turn.state = "incomplete";
              turn.phase = "aborted";
              segment.state = "incomplete";
              aborted += 1;
              conversationChanged = true;
              continue;
            }
            // A missing phase is rejected by validation. All remaining
            // active phases have crossed or may have crossed a child write.
            turn.state = "ambiguous";
            turn.phase = "ambiguous";
            segment.state = "ambiguous";
            ambiguous += 1;
            conversationChanged = true;
          }
        }
        if (!conversationChanged) continue;
        conversation.activeClient = null;
        conversation.availability = availabilityFor(conversation);
        conversation.updatedAt = at;
      }
    });
    return { aborted, ambiguous };
  }

  continuityContext(conversationId: OpaqueConversationId): CanonicalContinuationContextV1 | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation) return null;
    const entries = conversation.segments.flatMap((segment) => segment.turns)
      .filter((turn) => turn.state === "committed" && turn.serializedInput !== null && turn.portableTranscript !== null)
      .flatMap((turn) => [
        { role: "user", text: turn.serializedInput!.text },
        ...turn.portableTranscript!.items.flatMap((item) => portableText(item).map((text) => ({ role: item.kind, text }))),
      ]);
    if (entries.length === 0) return null;
    const fragments: string[] = [];
    let used = 0;
    for (const entry of entries.reverse()) {
      const fragment = `[${entry.role}]\n${entry.text}`;
      const bytes = Buffer.byteLength(fragment, "utf8");
      if (bytes > MAX_CONTINUITY_BYTES || used + bytes > MAX_CONTINUITY_BYTES) break;
      fragments.unshift(fragment);
      used += bytes;
    }
    if (fragments.length === 0) return null;
    const text = `Broker-owned logical conversation continuation. The typed committed blocks below are bounded portable context; do not assume access to native account history.\n\n${fragments.join("\n\n")}`;
    return { digest: digest(text), text };
  }

  project(conversationId: OpaqueConversationId, subscriptionFor: CanonicalHistorySubscriptionResolverV1): LogicalConversationProjectionV1 | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation || !this.hasRecordedTurns(conversationId)) return null;
    const segments = conversation.segments.map((segment) => {
      const subscription = subscriptionFor(segment.opaqueAccountId);
      if (!subscription) return null;
      return {
        segmentId: segment.segmentId,
        subscription,
        state: segment.state,
        ...(segment.committedAt ? { committedAt: segment.committedAt } : {}),
      };
    });
    if (segments.some((segment) => segment === null)) return null;
    const activeSegment = conversation.segments.find((segment) => segment.state === "active") ?? null;
    const activeSubscription = activeSegment ? subscriptionFor(activeSegment.opaqueAccountId) : null;
    const activeClient: LogicalHistoryActiveClientV1 | null = conversation.activeClient && activeSubscription
      ? { clientId: conversation.activeClient.clientId, label: conversation.activeClient.label, subscription: activeSubscription }
      : null;
    const historyWarning = warningFor(conversation);
    return {
      conversationId: conversation.conversationId,
      availability: conversation.availability,
      historyWarning,
      segments: segments as NonNullable<typeof segments[number]>[],
      activeClient,
      peerBusy: activeClient !== null,
      updatedAt: conversation.updatedAt,
    };
  }

  projectCommittedTurn(
    conversationId: OpaqueConversationId,
    turnId: OpaqueTurnId,
    subscriptionFor: CanonicalHistorySubscriptionResolverV1,
  ): LogicalTurnProjectionV1 | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation) return null;
    for (const segment of conversation.segments) {
      if (!segment.turns.some((turn) => turn.turnId === turnId && turn.state === "committed")) continue;
      const subscription = subscriptionFor(segment.opaqueAccountId);
      return subscription ? { turnId, subscription, state: "committed" } : null;
    }
    return null;
  }

  /** Private, completed-only canonical data for the reserved host history bridge. */
  portableTranscript(conversationId: OpaqueConversationId): ReadonlyArray<Readonly<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }>> | null {
    const conversation = this.findConversation(conversationId);
    if (!conversation || conversation.availability === "ambiguous") return null;
    const turns: Array<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }> = [];
    for (const segment of conversation.segments) {
      for (const turn of segment.turns) {
        if (turn.state !== "committed" || !turn.portableTranscript) continue;
        if (digest(JSON.stringify(turn.portableTranscript.items)) !== turn.portableTranscript.digest) return null;
        turns.push({ turnId: turn.turnId, items: structuredClone(turn.portableTranscript.items) });
      }
    }
    return turns;
  }

  logicalList(): ReadonlyArray<Readonly<{ conversationId: OpaqueConversationId; publicThreadId: string; title: string; availability: LogicalAvailability; updatedAt: string }>> {
    return this.state.conversations.map((conversation) => ({ conversationId: conversation.conversationId, publicThreadId: conversation.publicThreadId, title: conversation.title ?? "Shared conversation", availability: conversation.availability, updatedAt: conversation.updatedAt }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.publicThreadId.localeCompare(right.publicThreadId));
  }

  logicalRead(publicThreadId: string): Readonly<{ conversationId: OpaqueConversationId; publicThreadId: string; title: string; availability: LogicalAvailability; createdAt: string; updatedAt: string; turns: ReadonlyArray<Readonly<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }>> }> | null {
    const conversationId = this.conversationForPublicThreadId(publicThreadId);
    if (!conversationId) return null;
    const conversation = this.findConversation(conversationId);
    if (!conversation) return null;
    // An ambiguous in-flight turn must not be recycled as continuation
    // context, but it must remain visible in canonical history. Read-only
    // projections can safely expose only already-committed portable turns;
    // `portableTranscript()` remains stricter for continuation dispatch.
    const turns: Array<{ turnId: OpaqueTurnId; items: readonly PortableTranscriptItemV1[] }> = [];
    for (const segment of conversation.segments) {
      for (const turn of segment.turns) {
        if (turn.state !== "committed" || !turn.portableTranscript) continue;
        if (digest(JSON.stringify(turn.portableTranscript.items)) !== turn.portableTranscript.digest) continue;
        turns.push({ turnId: turn.turnId, items: structuredClone(turn.portableTranscript.items) });
      }
    }
    return { conversationId, publicThreadId: conversation.publicThreadId, title: conversation.title ?? "Shared conversation", availability: conversation.availability, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, turns };
  }

  private markTerminal(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string, state: "incomplete" | "ambiguous"): void {
    const at = this.timestamp();
    this.mutate((document) => {
      const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
      for (const turn of segment.turns) if (turn.state === "active") { turn.state = state; turn.phase = state === "ambiguous" ? "ambiguous" : "aborted"; }
      segment.state = state;
      conversation.activeClient = null;
      conversation.availability = state === "ambiguous" ? "ambiguous" : availabilityFor(conversation);
      conversation.updatedAt = at;
    });
  }

  private markTurnPhase(conversationId: OpaqueConversationId, opaqueAccountId: OpaqueAccountId, nativeThreadId: string, phase: "dispatching" | "active"): void {
    const at = this.timestamp();
    this.mutate((document) => {
      const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
      const turn = [...segment.turns].reverse().find((candidate) => candidate.state === "active");
      if (!turn || (phase === "active" && turn.phase !== "dispatching") || (phase === "dispatching" && turn.phase !== "prepared")) return;
      turn.phase = phase;
      conversation.updatedAt = at;
    });
  }

  private newSegment(input: CanonicalHistoryCreateInputV1, createdAt: string): PrivateSegmentV1 {
    return {
      segmentId: opaqueId("ls", this.random) as OpaqueSegmentId,
      opaqueAccountId: input.opaqueAccountId,
      nativeThreadId: input.nativeThreadId,
      state: "active",
      createdAt,
      turns: [],
    };
  }

  private findConversation(conversationId: OpaqueConversationId): PrivateConversationV1 | null {
    return this.state.conversations.find((conversation) => conversation.conversationId === conversationId) ?? null;
  }

  private findSegment(opaqueAccountId: OpaqueAccountId, nativeThreadId: string): { conversation: PrivateConversationV1; segment: PrivateSegmentV1 } | null {
    for (const conversation of this.state.conversations) {
      const segment = conversation.segments.find((candidate) => candidate.opaqueAccountId === opaqueAccountId && candidate.nativeThreadId === nativeThreadId);
      if (segment) return { conversation, segment };
    }
    return null;
  }

  private hasTurn(turnId: OpaqueTurnId): boolean {
    return this.state.conversations.some((conversation) => conversation.segments.some((segment) => segment.turns.some((turn) => turn.turnId === turnId)));
  }

  private mutate(mutator: (state: CanonicalHistoryDocumentV1) => void): void {
    const next = structuredClone(this.state);
    mutator(next);
    if (!isCanonicalHistoryDocument(next)) throw new Error("canonical history refused invalid state");
    // Write-ahead record: a process death between this append and snapshot
    // replacement recovers the exact next immutable document on next start.
    const record: CanonicalHistoryJournalRecordV1 = { version: 1, digest: digest(JSON.stringify(next)), document: next };
    const snapshotBytes = canonicalJsonBytes(next);
    const journalBytes = canonicalJsonBytes(record);
    this.assertWritableSizes(snapshotBytes, journalBytes);
    appendFileSync(this.journalPath, journalBytes, { mode: 0o600 });
    chmodSync(this.journalPath, 0o600);
    writeCanonicalHistorySnapshot(this.root, next);
    writeFileSync(this.journalPath, "", { mode: 0o600 });
    chmodSync(this.journalPath, 0o600);
    this.state = next;
  }

  private load(): CanonicalHistoryDocumentV1 {
    if (!existsSync(this.path)) {
      const initial: CanonicalHistoryDocumentV1 = { version: 1, conversations: [] };
      writeCanonicalHistorySnapshot(this.root, initial);
      return initial;
    }
    assertPrivateRegularFile(this.path, CANONICAL_HISTORY_MAX_BYTES_V1);
    const raw = readFileSync(this.path, "utf8");
    if (Buffer.byteLength(raw, "utf8") > CANONICAL_HISTORY_MAX_BYTES_V1) throw new Error("canonical history exceeds bounded size");
    const parsed = JSON.parse(raw) as unknown;
    if (!isCanonicalHistoryDocument(parsed)) throw new Error("canonical history failed strict validation");
    const recovered = this.recoverJournal(parsed);
    return recovered;
  }

  private recoverJournal(snapshot: CanonicalHistoryDocumentV1): CanonicalHistoryDocumentV1 {
    if (!existsSync(this.journalPath)) return snapshot;
    try {
      assertPrivateRegularFile(this.journalPath, CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
      const lines = readFileSync(this.journalPath, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length === 0) return snapshot;
      const last = JSON.parse(lines.at(-1)!) as unknown;
      if (!isJournalRecord(last)) throw new Error("invalid canonical history journal");
      if (last.digest !== digest(JSON.stringify(last.document))) throw new Error("canonical history journal digest mismatch");
      writeCanonicalHistorySnapshot(this.root, last.document);
      writeFileSync(this.journalPath, "", { mode: 0o600 });
      chmodSync(this.journalPath, 0o600);
      return last.document;
    } catch {
      throw new Error("canonical history journal failed recovery");
    }
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Reject size-invalid writes before a journal byte can affect recovery. */
  private assertWritableSizes(snapshotBytes: Buffer, journalBytes: Buffer): void {
    if (snapshotBytes.byteLength > CANONICAL_HISTORY_MAX_BYTES_V1) {
      throw new Error("canonical history exceeds bounded snapshot size");
    }
    if (journalBytes.byteLength > CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1) {
      throw new Error("canonical history exceeds bounded journal size");
    }
    if (!existsSync(this.journalPath)) return;
    assertPrivateRegularFile(this.journalPath, CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
    const currentBytes = readFileSync(this.journalPath).byteLength;
    if (currentBytes + journalBytes.byteLength > CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1) {
      throw new Error("canonical history journal append exceeds its bound");
    }
  }
}

function warningFor(conversation: PrivateConversationV1): "content_gap" | "ambiguous" | null {
  const turns = conversation.segments.flatMap((segment) => segment.turns);
  if (turns.some((turn) => turn.state === "ambiguous")) return "ambiguous";
  if (turns.some((turn) => turn.state === "incomplete")) return "content_gap";
  return null;
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function writeCanonicalHistorySnapshot(root: string, value: CanonicalHistoryDocumentV1): void {
  writePrivateJsonAtomicBounded(root, CANONICAL_HISTORY_FILE_V1, value, CANONICAL_HISTORY_MAX_BYTES_V1);
}

function requireConversation(document: CanonicalHistoryDocumentV1, conversationId: OpaqueConversationId): PrivateConversationV1 {
  const conversation = document.conversations.find((candidate) => candidate.conversationId === conversationId);
  if (!conversation) throw new Error("unknown canonical conversation");
  return conversation;
}

function requireSegment(
  document: CanonicalHistoryDocumentV1,
  conversationId: OpaqueConversationId,
  opaqueAccountId: OpaqueAccountId,
  nativeThreadId: string,
): { conversation: PrivateConversationV1; segment: PrivateSegmentV1 } {
  const conversation = requireConversation(document, conversationId);
  const segment = conversation.segments.find((candidate) => candidate.opaqueAccountId === opaqueAccountId && candidate.nativeThreadId === nativeThreadId);
  if (!segment) throw new Error("canonical history segment does not match conversation");
  return { conversation, segment };
}

function assertCreateInput(input: CanonicalHistoryCreateInputV1): void {
  if (!isOpaqueAccountId(input.opaqueAccountId) || !validNativeId(input.nativeThreadId)
    || !isOpaqueRendererRef(input.ownerRendererRef) || !isSafeLabel(input.ownerLabel)) {
    throw new Error("invalid canonical history binding");
  }
}

function serializeInput(params: unknown): SerializedInputV1 | null {
  if (!isPlainRecord(params) || !Array.isArray(params.input) || params.input.length < 1 || params.input.length > 16) return null;
  const texts: string[] = [];
  for (const entry of params.input) {
    if (!isPlainRecord(entry) || (entry.type !== "text" && entry.type !== "input_text") || typeof entry.text !== "string") return null;
    if (entry.text.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.text)) return null;
    texts.push(entry.text);
  }
  const text = texts.join("\n");
  if (Buffer.byteLength(text, "utf8") > MAX_SERIALIZED_INPUT_BYTES) return null;
  return { digest: digest(text), text };
}

function availabilityFor(conversation: PrivateConversationV1): LogicalAvailability {
  if (conversation.segments.some((segment) => segment.state === "ambiguous" || segment.turns.some((turn) => turn.state === "ambiguous"))) return "ambiguous";
  // Segment state may return to committed after a later safe turn. A terminal
  // receipt remains a known history gap and must keep the logical transcript
  // incomplete across that later success and across broker restart.
  if (conversation.segments.some((segment) => segment.state === "active" || segment.state === "incomplete" || segment.turns.some((turn) => turn.state === "incomplete"))) return "incomplete";
  if (conversation.segments.some((segment) => segment.state !== "committed")) return "partial";
  return "complete";
}

function opaqueId(prefix: "lc" | "ls" | "lt", random: (size: number) => Buffer): string {
  return `${prefix}_${random(24).toString("base64url")}`;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function validNativeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isSafeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeTitle(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value));
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isLogicalState(value: unknown): value is LogicalState {
  return value === "committed" || value === "active" || value === "incomplete" || value === "ambiguous";
}

function isCanonicalHistoryDocument(value: unknown): value is CanonicalHistoryDocumentV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["conversations", "version"].join("\0")
    || value.version !== CANONICAL_HISTORY_VERSION_V1 || !Array.isArray(value.conversations) || value.conversations.length > CANONICAL_HISTORY_MAX_CONVERSATIONS_V1) return false;
  const nativeBindings = new Set<string>();
  const ids = new Set<string>();
  return value.conversations.every((conversation) => {
    if (!isPrivateConversation(conversation) || ids.has(conversation.conversationId)) return false;
    ids.add(conversation.conversationId);
    for (const segment of conversation.segments) {
      const key = `${segment.opaqueAccountId}\0${segment.nativeThreadId}`;
      if (nativeBindings.has(key)) return false;
      nativeBindings.add(key);
    }
    return true;
  });
}

function isJournalRecord(value: unknown): value is CanonicalHistoryJournalRecordV1 {
  return isPlainRecord(value) && Object.keys(value).sort().join("\0") === ["digest", "document", "version"].join("\0")
    && value.version === 1 && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest)
    && isCanonicalHistoryDocument(value.document);
}

function isPrivateConversation(value: unknown): value is PrivateConversationV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["activeClient", "availability", "conversationId", "createdAt", "publicThreadId", "rootNativeThreadId", "segments", "title", "updatedAt"].join("\0")
    || !isOpaqueConversationId(value.conversationId) || !validNativeId(value.rootNativeThreadId) || !isPublicThreadId(value.publicThreadId) || !safeTitle(value.title) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
    || !["complete", "partial", "incomplete", "ambiguous"].includes(String(value.availability))
    || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > MAX_SEGMENTS_PER_CONVERSATION) return false;
  if (value.activeClient !== null && (!isPlainRecord(value.activeClient) || Object.keys(value.activeClient).sort().join("\0") !== ["clientId", "label"].join("\0")
    || !isOpaqueRendererRef(value.activeClient.clientId) || !isSafeLabel(value.activeClient.label))) return false;
  if (!value.segments.every(isPrivateSegment)) return false;
  return value.segments.filter((segment) => segment.state === "active").length <= 1;
}

function isPrivateSegment(value: unknown): value is PrivateSegmentV1 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["segmentId", "opaqueAccountId", "nativeThreadId", "state", "createdAt", "committedAt", "turns"].includes(key))
    || !isOpaqueSegmentId(value.segmentId) || !isOpaqueAccountId(value.opaqueAccountId) || !validNativeId(value.nativeThreadId)
    || !isLogicalState(value.state) || !isTimestamp(value.createdAt)
    || (value.committedAt !== undefined && !isTimestamp(value.committedAt))
    || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS_PER_SEGMENT || !value.turns.every(isPrivateTurn)) return false;
  return value.turns.filter((turn) => turn.state === "active").length <= 1;
}

function isPrivateTurn(value: unknown): value is PrivateTurnV1 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["turnId", "nativeTurnId", "nativeItemIds", "state", "phase", "startedAt", "committedAt", "serializedInput", "portableTranscript"].includes(key))
    || !isOpaqueTurnId(value.turnId) || (value.nativeTurnId !== null && !validNativeId(value.nativeTurnId))
    || !Array.isArray(value.nativeItemIds) || value.nativeItemIds.length > MAX_PORTABLE_TRANSCRIPT_ITEMS || !value.nativeItemIds.every(validNativeId) || new Set(value.nativeItemIds).size !== value.nativeItemIds.length
    || !isLogicalState(value.state) || !isTurnPhase(value.phase) || !isTimestamp(value.startedAt)
    || (value.committedAt !== undefined && !isTimestamp(value.committedAt))
    || (value.portableTranscript !== null && !isPortableTranscript(value.portableTranscript))) return false;
  if (value.serializedInput === null) return true;
  return isPlainRecord(value.serializedInput) && Object.keys(value.serializedInput).sort().join("\0") === ["digest", "text"].join("\0")
    && typeof value.serializedInput.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.serializedInput.digest)
    && typeof value.serializedInput.text === "string" && Buffer.byteLength(value.serializedInput.text, "utf8") <= MAX_SERIALIZED_INPUT_BYTES
    && digest(value.serializedInput.text) === value.serializedInput.digest;
}

function isTurnPhase(value: unknown): value is CanonicalTurnPhaseV1 { return value === "prepared" || value === "dispatching" || value === "active" || value === "committed" || value === "aborted" || value === "ambiguous"; }

function nativeItemIds(items: unknown): string[] {
  if (!Array.isArray(items) || items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS) return [];
  const ids = items.map((item) => isPlainRecord(item) && validNativeId(item.id) ? item.id : null);
  return ids.every((id) => id !== null) && new Set(ids).size === ids.length ? ids : [];
}

function portableTranscriptFromItems(value: unknown): PortableTranscriptV1 | null {
  if (!Array.isArray(value) || value.length > MAX_PORTABLE_TRANSCRIPT_ITEMS) return null;
  const items: PortableTranscriptItemV1[] = [];
  for (const item of value) {
    const portable = portableItem(item);
    if (!portable) return null;
    items.push(portable);
  }
  const serialized = JSON.stringify(items);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PORTABLE_TRANSCRIPT_BYTES) return null;
  return { digest: digest(serialized), items };
}

function portableItem(value: unknown): PortableTranscriptItemV1 | null {
  if (!isPlainRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "userMessage") {
    if (!Array.isArray(value.content) || value.content.length > 32) return null;
    const text = value.content.map((entry) => isPlainRecord(entry) && entry.type === "text" && safePortableText(entry.text) ? entry.text : null);
    return text.every((entry) => entry !== null) ? { kind: "user", text: text.join("\n") } : null;
  }
  if (value.type === "agentMessage" && safePortableText(value.text)) return { kind: "assistant", text: value.text };
  if (value.type === "plan" && safePortableText(value.text)) return { kind: "plan", text: value.text };
  if (value.type === "functionCallOutput" && typeof value.name === "string") {
    const result = portableOutput(value.output);
    const summary = result === null ? null : redactedToolSummary(result);
    return summary === null ? null : { kind: "tool", name: value.name, result: summary };
  }
  // Attachment/image references need broker-side inode/digest provenance which
  // this frame alone cannot prove. Fail closed rather than persisting a URL,
  // path, or a provider resource id as if it were portable.
  return null;
}

function portableOutput(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length > 32) return null;
  const text = value.map((entry) => isPlainRecord(entry) && entry.type === "input_text" && typeof entry.text === "string" ? entry.text : null);
  return text.every((entry) => entry !== null) ? text.join("\n") : null;
}

function portableText(item: PortableTranscriptItemV1): string[] {
  return [item.text, item.result].filter((value): value is string => typeof value === "string");
}

function safePortableText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PORTABLE_TRANSCRIPT_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    && !/(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|cookie|authorization)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|BEGIN [A-Z ]+PRIVATE KEY)/i.test(value);
}

function redactedToolSummary(value: string): string | null {
  if (!safePortableText(value) || Buffer.byteLength(value, "utf8") > 16 * 1024) return null;
  // Tool payloads commonly include local paths and opaque resource urls. Those
  // cannot be portable across accounts, so an item containing them is explicit
  // incomplete rather than copied with a misleading reference.
  if (/(?:^|[\s"'])(?:\/|~\/|file:|data:|blob:|https?:\/\/)/i.test(value)) return null;
  return value;
}

function isPortableTranscript(value: unknown): value is PortableTranscriptV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join("\0") !== ["digest", "items"].join("\0")
    || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)
    || !Array.isArray(value.items) || value.items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS || !value.items.every(isPortableItem)) return false;
  const serialized = JSON.stringify(value.items);
  return Buffer.byteLength(serialized, "utf8") <= MAX_PORTABLE_TRANSCRIPT_BYTES && digest(serialized) === value.digest;
}

function isPortableItem(value: unknown): value is PortableTranscriptItemV1 {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["kind", "text", "name", "result"].includes(key))
    || !["user", "assistant", "plan", "tool"].includes(String(value.kind))) return false;
  if (value.text !== undefined && !safePortableText(value.text)) return false;
  if (value.result !== undefined && !safePortableText(value.result)) return false;
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 160 || !safePortableText(value.name))) return false;
  return (value.kind === "user" || value.kind === "assistant" || value.kind === "plan") ? typeof value.text === "string"
    : value.kind === "tool" ? typeof value.name === "string" && typeof value.result === "string"
      : false;
}

function isPublicThreadId(value: unknown): value is string {
  return typeof value === "string" && /^lh_[A-Za-z0-9_-]{16,128}$/.test(value);
}
