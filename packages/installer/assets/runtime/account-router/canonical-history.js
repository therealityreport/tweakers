"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanonicalHistoryStoreV1 = exports.CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 = exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1 = exports.CANONICAL_HISTORY_MAX_BYTES_V1 = exports.CANONICAL_HISTORY_VERSION_V1 = exports.CANONICAL_HISTORY_JOURNAL_FILE_V1 = exports.CANONICAL_HISTORY_FILE_V1 = void 0;
exports.preflightCanonicalHistoryStore = preflightCanonicalHistoryStore;
exports.bootstrapCanonicalHistoryStoreV1 = bootstrapCanonicalHistoryStoreV1;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
/** Broker-owned, private logical transcript. It is not an account-home store. */
exports.CANONICAL_HISTORY_FILE_V1 = "canonical-history.v1.json";
exports.CANONICAL_HISTORY_JOURNAL_FILE_V1 = "canonical-history.v1.journal.jsonl";
exports.CANONICAL_HISTORY_VERSION_V1 = 1;
// This owner-private snapshot is compacted atomically. It is deliberately
// sized for ordinary long-lived use; a future journal must preserve these
// exact immutable records rather than evicting completed segments.
exports.CANONICAL_HISTORY_MAX_BYTES_V1 = 128 * 1024 * 1024;
// The write-ahead record contains the full snapshot plus its envelope. Keep
// the envelope separately bounded so every valid snapshot fits a recovery
// record. Migration preview measures the exact serialized record as well.
exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1 = exports.CANONICAL_HISTORY_MAX_BYTES_V1 + 1024;
exports.CANONICAL_HISTORY_MAX_CONVERSATIONS_V1 = 16_384;
const MAX_SEGMENTS_PER_CONVERSATION = 64;
const MAX_TURNS_PER_SEGMENT = 1_024;
const MAX_SERIALIZED_INPUT_BYTES = 24 * 1024;
const MAX_CONTINUITY_BYTES = 32 * 1024;
const MAX_PORTABLE_TRANSCRIPT_BYTES = 96 * 1024;
const MAX_PORTABLE_TRANSCRIPT_ITEMS = 256;
/**
 * Strict preflight for offline migration and startup guards. It is intentionally
 * read-only and does not create, repair, or migrate a history file.
 */
function preflightCanonicalHistoryStore(root) {
    const path = (0, node_path_1.join)(root, exports.CANONICAL_HISTORY_FILE_V1);
    if (!(0, node_fs_1.existsSync)(path)) {
        return { version: 1, fileName: exports.CANONICAL_HISTORY_FILE_V1, state: "missing", conversationCount: 0, segmentCount: 0 };
    }
    try {
        (0, state_store_1.assertPrivateRegularFile)(path, exports.CANONICAL_HISTORY_MAX_BYTES_V1);
        const raw = (0, node_fs_1.readFileSync)(path, "utf8");
        if (Buffer.byteLength(raw, "utf8") > exports.CANONICAL_HISTORY_MAX_BYTES_V1)
            throw new Error("oversized");
        const parsed = JSON.parse(raw);
        if (!isCanonicalHistoryDocument(parsed))
            throw new Error("invalid");
        return {
            version: 1,
            fileName: exports.CANONICAL_HISTORY_FILE_V1,
            state: "ready",
            conversationCount: parsed.conversations.length,
            segmentCount: parsed.conversations.reduce((count, conversation) => count + conversation.segments.length, 0),
        };
    }
    catch {
        return { version: 1, fileName: exports.CANONICAL_HISTORY_FILE_V1, state: "invalid", conversationCount: 0, segmentCount: 0 };
    }
}
/**
 * The only explicit empty-history bootstrap. Runtime loading deliberately
 * does not call this: V3 startup must distinguish a deliberately initialized
 * empty transcript from a missing migration artifact and fail closed for the
 * latter.
 */
function bootstrapCanonicalHistoryStoreV1(root) {
    (0, state_store_1.ensurePrivateDirectory)(root);
    const preflight = preflightCanonicalHistoryStore(root);
    if (preflight.state === "ready")
        return;
    if (preflight.state === "invalid")
        throw new Error("canonical history store is invalid");
    writeCanonicalHistorySnapshot(root, { version: exports.CANONICAL_HISTORY_VERSION_V1, conversations: [] });
}
/**
 * Canonical logical conversation storage. Provider native ids and serialized
 * input remain private to the broker root and never appear in projections.
 */
class CanonicalHistoryStoreV1 {
    root;
    now;
    random;
    publicThreadIdForNative;
    state;
    constructor(root, now = Date.now, random = node_crypto_1.randomBytes, publicThreadIdForNative) {
        this.root = root;
        this.now = now;
        this.random = random;
        this.publicThreadIdForNative = publicThreadIdForNative;
        (0, state_store_1.ensurePrivateDirectory)(root);
        const preflight = preflightCanonicalHistoryStore(root);
        if (preflight.state !== "ready") {
            throw new Error(`canonical history store is ${preflight.state}; use explicit bootstrap or repair migration`);
        }
        this.state = this.load();
    }
    get path() {
        return (0, node_path_1.join)(this.root, exports.CANONICAL_HISTORY_FILE_V1);
    }
    get journalPath() { return (0, node_path_1.join)(this.root, exports.CANONICAL_HISTORY_JOURNAL_FILE_V1); }
    conversationForNative(opaqueAccountId, nativeThreadId) {
        const found = this.findSegment(opaqueAccountId, nativeThreadId);
        return found?.conversation.conversationId ?? null;
    }
    conversationForPublicThreadId(publicThreadId) {
        return this.state.conversations.find((conversation) => conversation.publicThreadId === publicThreadId)?.conversationId ?? null;
    }
    hasConversations() { return this.state.conversations.length > 0; }
    publicThreadId(conversationId) {
        return this.findConversation(conversationId)?.publicThreadId ?? null;
    }
    /** One canonical conversation has one writer lease at a time. */
    hasActiveTurn(conversationId) {
        const conversation = this.findConversation(conversationId);
        return Boolean(conversation?.segments.some((segment) => segment.turns.some((turn) => turn.state === "active")));
    }
    /** Bootstrap bindings have no canonical turn evidence and stay out of history UI. */
    hasRecordedTurns(conversationId) {
        const conversation = this.findConversation(conversationId);
        return Boolean(conversation?.segments.some((segment) => segment.turns.length > 0));
    }
    /** Owner-private routing alias; callers must never send it through renderer IPC. */
    rootNativeThreadId(conversationId) {
        return this.findConversation(conversationId)?.rootNativeThreadId ?? null;
    }
    /** Owner-private, immutable physical read routes in conversation order; never renderer IPC. */
    orderedNativeSegments(conversationId) {
        const conversation = this.findConversation(conversationId);
        if (!conversation || conversation.segments.length > MAX_SEGMENTS_PER_CONVERSATION)
            return null;
        return Object.freeze(conversation.segments.map(({ opaqueAccountId, nativeThreadId }) => Object.freeze({ opaqueAccountId, nativeThreadId })));
    }
    /** Bounded physical binding used only by the runtime-owned native target bridge. */
    publicTurnIdsForNative(conversationId, opaqueAccountId, nativeThreadId, nativeTurnIds) {
        if (nativeTurnIds.length > 128 || nativeTurnIds.some((turnId) => !validNativeId(turnId)))
            return null;
        const binding = this.findSegment(opaqueAccountId, nativeThreadId);
        if (!binding || binding.conversation.conversationId !== conversationId || binding.conversation.availability === "ambiguous")
            return null;
        return this.publicTurnIdsForConversation(conversationId, nativeTurnIds);
    }
    /** Exact native turn/item identity lookup for the runtime-owned DOM bridge. */
    publicTurnIdsForConversation(conversationId, nativeTurnIds) {
        if (nativeTurnIds.length > 128 || nativeTurnIds.some((turnId) => !validNativeId(turnId)))
            return null;
        const conversation = this.findConversation(conversationId);
        if (!conversation || conversation.availability === "ambiguous")
            return null;
        const found = new Map();
        for (const nativeTurnId of nativeTurnIds) {
            const turn = conversation.segments.flatMap((segment) => segment.turns)
                .find((candidate) => candidate.state === "committed" && (candidate.nativeTurnId === nativeTurnId || candidate.nativeItemIds.includes(nativeTurnId)));
            if (!turn)
                return null;
            found.set(nativeTurnId, turn.turnId);
        }
        return found;
    }
    /** The active segment routes a desktop's stable public thread alias. */
    activeNativeThread(conversationId) {
        const conversation = this.findConversation(conversationId);
        if (!conversation)
            return null;
        const segment = conversation.segments.find((candidate) => candidate.state === "active")
            // A content-free linked-continuation receipt deliberately marks its
            // source segment incomplete. It is still the only safe physical route
            // for a later source-account turn; ambiguity remains unroutable.
            ?? [...conversation.segments].reverse().find((candidate) => candidate.state === "committed" || candidate.state === "incomplete")
            ?? null;
        return segment ? { opaqueAccountId: segment.opaqueAccountId, nativeThreadId: segment.nativeThreadId } : null;
    }
    createConversation(input) {
        assertCreateInput(input);
        if (this.findSegment(input.opaqueAccountId, input.nativeThreadId)) {
            throw new Error("canonical history native thread binding already exists");
        }
        let conversationId;
        do {
            conversationId = opaqueId("lc", this.random);
        } while (this.findConversation(conversationId));
        const createdAt = this.timestamp();
        this.mutate((state) => {
            if (state.conversations.length >= exports.CANONICAL_HISTORY_MAX_CONVERSATIONS_V1)
                throw new Error("canonical history conversation capacity reached");
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
    addSegment(input) {
        assertCreateInput(input);
        const conversation = this.findConversation(input.conversationId);
        if (!conversation)
            throw new Error("unknown canonical conversation");
        if (this.findSegment(input.opaqueAccountId, input.nativeThreadId))
            throw new Error("canonical history native thread binding already exists");
        let segmentId;
        do {
            segmentId = opaqueId("ls", this.random);
        } while (conversation.segments.some((segment) => segment.segmentId === segmentId));
        const createdAt = this.timestamp();
        this.mutate((state) => {
            const mutable = requireConversation(state, input.conversationId);
            if (mutable.segments.length >= MAX_SEGMENTS_PER_CONVERSATION)
                throw new Error("canonical history segment capacity reached");
            for (const segment of mutable.segments)
                if (segment.state === "active")
                    segment.state = "committed";
            mutable.segments.push({ ...this.newSegment(input, createdAt), segmentId });
            mutable.activeClient = { clientId: input.ownerRendererRef, label: input.ownerLabel };
            mutable.availability = "incomplete";
            mutable.updatedAt = createdAt;
        });
        return segmentId;
    }
    /** Reconcile an already-proved native writer without inventing a live desktop owner. */
    reconcileNativeWriter(conversationId, account, nativeThreadId) {
        if (!(0, types_1.isOpaqueAccountId)(account) || !validNativeId(nativeThreadId))
            throw new Error("invalid native writer");
        this.mutate((state) => {
            const conversation = requireConversation(state, conversationId);
            if (conversation.rootNativeThreadId !== nativeThreadId || conversation.segments.some((segment) => segment.turns.some((turn) => turn.state === "active" || turn.state === "ambiguous")))
                throw new Error("native writer is not idle");
            let target = conversation.segments.find((segment) => segment.opaqueAccountId === account && segment.nativeThreadId === nativeThreadId);
            if (!target) {
                if (conversation.segments.length >= MAX_SEGMENTS_PER_CONVERSATION)
                    throw new Error("native segment capacity reached");
                target = { segmentId: opaqueId("ls", this.random), opaqueAccountId: account, nativeThreadId, state: "active", createdAt: this.timestamp(), turns: [] };
                conversation.segments.push(target);
            }
            for (const segment of conversation.segments)
                if (segment !== target && segment.state === "active")
                    segment.state = "committed";
            target.state = "active";
            conversation.activeClient = null;
            conversation.updatedAt = this.timestamp();
        });
    }
    /** Native same-ID transfer preserves every prior turn and the visible conversation. */
    activateNativeWriter(input) {
        assertCreateInput(input);
        const conversation = this.findConversation(input.conversationId);
        if (!conversation || conversation.rootNativeThreadId !== input.nativeThreadId
            || conversation.segments.some((segment) => segment.turns.some((turn) => turn.state === "active" || turn.state === "ambiguous"))) {
            throw new Error("native writer transfer requires an idle proven conversation");
        }
        const existing = this.findSegment(input.opaqueAccountId, input.nativeThreadId);
        if (!existing) {
            this.addSegment(input);
            return;
        }
        this.mutate((state) => {
            const { conversation, segment } = requireSegment(state, input.conversationId, input.opaqueAccountId, input.nativeThreadId);
            for (const other of conversation.segments)
                if (other !== segment && other.state === "active")
                    other.state = "committed";
            segment.state = "active";
            conversation.activeClient = { clientId: input.ownerRendererRef, label: input.ownerLabel };
            conversation.updatedAt = this.timestamp();
        });
    }
    beginTurn(conversationId, opaqueAccountId, nativeThreadId, ownerRendererRef, ownerLabel, input) {
        const context = serializeInput(input);
        let turnId;
        do {
            turnId = opaqueId("lt", this.random);
        } while (this.hasTurn(turnId));
        const startedAt = this.timestamp();
        this.mutate((state) => {
            const { conversation, segment } = requireSegment(state, conversationId, opaqueAccountId, nativeThreadId);
            if (segment.turns.length >= MAX_TURNS_PER_SEGMENT)
                throw new Error("canonical history turn capacity reached");
            if (conversation.segments.some((candidate) => candidate !== segment && candidate.state === "active")) {
                throw new Error("canonical history refused concurrent segment writers");
            }
            if (segment.turns.some((turn) => turn.state === "active"))
                throw new Error("canonical history refused concurrent turn writers");
            segment.state = "active";
            segment.turns.push({ turnId, nativeTurnId: null, nativeItemIds: [], state: "active", phase: "prepared", startedAt, serializedInput: context, portableTranscript: null });
            conversation.activeClient = { clientId: ownerRendererRef, label: ownerLabel };
            conversation.availability = "incomplete";
            conversation.updatedAt = startedAt;
        });
        return turnId;
    }
    commitTurn(conversationId, opaqueAccountId, nativeThreadId, nativeTurnId, completedItems) {
        const committedAt = this.timestamp();
        let committed = null;
        this.mutate((state) => {
            const { conversation, segment } = requireSegment(state, conversationId, opaqueAccountId, nativeThreadId);
            const active = [...segment.turns].reverse().find((turn) => turn.state === "active") ?? null;
            if (!active)
                return;
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
    markIncomplete(conversationId, opaqueAccountId, nativeThreadId) {
        this.markTerminal(conversationId, opaqueAccountId, nativeThreadId, "incomplete");
    }
    /**
     * Preserve a known cross-subscription continuity gap without retaining the
     * rejected request, attachment, path, or provider-side target.  The record
     * belongs to the already-bound source segment and is terminal before any
     * destination child is acquired.
     */
    recordLinkedContinuationRequired(conversationId, opaqueAccountId, nativeThreadId) {
        let turnId;
        do {
            turnId = opaqueId("lt", this.random);
        } while (this.hasTurn(turnId));
        const at = this.timestamp();
        this.mutate((document) => {
            const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
            if (segment.turns.length >= MAX_TURNS_PER_SEGMENT)
                throw new Error("canonical history turn capacity reached");
            if (segment.turns.some((turn) => turn.state === "active"))
                throw new Error("canonical history refused terminal receipt during active turn");
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
    markTurnDispatching(conversationId, opaqueAccountId, nativeThreadId) {
        this.markTurnPhase(conversationId, opaqueAccountId, nativeThreadId, "dispatching");
    }
    markTurnActive(conversationId, opaqueAccountId, nativeThreadId) {
        this.markTurnPhase(conversationId, opaqueAccountId, nativeThreadId, "active");
    }
    markAmbiguous(conversationId, opaqueAccountId, nativeThreadId) {
        this.markTerminal(conversationId, opaqueAccountId, nativeThreadId, "ambiguous");
    }
    /**
     * A broker restart has no reliable child-write acknowledgement. A prepared
     * turn is proven not to have left the broker, while dispatching/active turns
     * may have reached a child. Settle those two classes differently and never
     * replay either one automatically.
     */
    recoverInFlightTurns() {
        let aborted = 0;
        let ambiguous = 0;
        const at = this.timestamp();
        this.mutate((document) => {
            for (const conversation of document.conversations) {
                let conversationChanged = false;
                for (const segment of conversation.segments) {
                    for (const turn of segment.turns) {
                        if (turn.state !== "active")
                            continue;
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
                if (!conversationChanged)
                    continue;
                conversation.activeClient = null;
                conversation.availability = availabilityFor(conversation);
                conversation.updatedAt = at;
            }
        });
        return { aborted, ambiguous };
    }
    continuityContext(conversationId) {
        const conversation = this.findConversation(conversationId);
        if (!conversation)
            return null;
        const entries = conversation.segments.flatMap((segment) => segment.turns)
            .filter((turn) => turn.state === "committed" && turn.serializedInput !== null && turn.portableTranscript !== null)
            .flatMap((turn) => [
            { role: "user", text: turn.serializedInput.text },
            ...turn.portableTranscript.items.flatMap((item) => portableText(item).map((text) => ({ role: item.kind, text }))),
        ]);
        if (entries.length === 0)
            return null;
        const fragments = [];
        let used = 0;
        for (const entry of entries.reverse()) {
            const fragment = `[${entry.role}]\n${entry.text}`;
            const bytes = Buffer.byteLength(fragment, "utf8");
            if (bytes > MAX_CONTINUITY_BYTES || used + bytes > MAX_CONTINUITY_BYTES)
                break;
            fragments.unshift(fragment);
            used += bytes;
        }
        if (fragments.length === 0)
            return null;
        const text = `Broker-owned logical conversation continuation. The typed committed blocks below are bounded portable context; do not assume access to native account history.\n\n${fragments.join("\n\n")}`;
        return { digest: digest(text), text };
    }
    project(conversationId, subscriptionFor) {
        const conversation = this.findConversation(conversationId);
        if (!conversation || !this.hasRecordedTurns(conversationId))
            return null;
        const segments = conversation.segments.map((segment) => {
            const subscription = subscriptionFor(segment.opaqueAccountId);
            if (!subscription)
                return null;
            return {
                segmentId: segment.segmentId,
                subscription,
                state: segment.state,
                ...(segment.committedAt ? { committedAt: segment.committedAt } : {}),
            };
        });
        if (segments.some((segment) => segment === null))
            return null;
        const activeSegment = conversation.segments.find((segment) => segment.state === "active") ?? null;
        const activeSubscription = activeSegment ? subscriptionFor(activeSegment.opaqueAccountId) : null;
        const activeClient = conversation.activeClient && activeSubscription
            ? { clientId: conversation.activeClient.clientId, label: conversation.activeClient.label, subscription: activeSubscription }
            : null;
        const historyWarning = warningFor(conversation);
        return {
            conversationId: conversation.conversationId,
            availability: conversation.availability,
            historyWarning,
            segments: segments,
            activeClient,
            peerBusy: activeClient !== null,
            updatedAt: conversation.updatedAt,
        };
    }
    projectCommittedTurn(conversationId, turnId, subscriptionFor) {
        const conversation = this.findConversation(conversationId);
        if (!conversation)
            return null;
        for (const segment of conversation.segments) {
            if (!segment.turns.some((turn) => turn.turnId === turnId && turn.state === "committed"))
                continue;
            const subscription = subscriptionFor(segment.opaqueAccountId);
            return subscription ? { turnId, subscription, state: "committed" } : null;
        }
        return null;
    }
    /** Private, completed-only canonical data for the reserved host history bridge. */
    portableTranscript(conversationId) {
        const conversation = this.findConversation(conversationId);
        if (!conversation || conversation.availability === "ambiguous")
            return null;
        const turns = [];
        for (const segment of conversation.segments) {
            for (const turn of segment.turns) {
                if (turn.state !== "committed" || !turn.portableTranscript)
                    continue;
                if (digest(JSON.stringify(turn.portableTranscript.items)) !== turn.portableTranscript.digest)
                    return null;
                turns.push({ turnId: turn.turnId, items: structuredClone(turn.portableTranscript.items) });
            }
        }
        return turns;
    }
    logicalList() {
        return this.state.conversations.map((conversation) => ({ conversationId: conversation.conversationId, publicThreadId: conversation.publicThreadId, title: conversation.title ?? "Shared conversation", availability: conversation.availability, updatedAt: conversation.updatedAt }))
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.publicThreadId.localeCompare(right.publicThreadId));
    }
    logicalRead(publicThreadId) {
        const conversationId = this.conversationForPublicThreadId(publicThreadId);
        if (!conversationId)
            return null;
        const conversation = this.findConversation(conversationId);
        if (!conversation)
            return null;
        // An ambiguous in-flight turn must not be recycled as continuation
        // context, but it must remain visible in canonical history. Read-only
        // projections can safely expose only already-committed portable turns;
        // `portableTranscript()` remains stricter for continuation dispatch.
        const turns = [];
        for (const segment of conversation.segments) {
            for (const turn of segment.turns) {
                if (turn.state !== "committed" || !turn.portableTranscript)
                    continue;
                if (digest(JSON.stringify(turn.portableTranscript.items)) !== turn.portableTranscript.digest)
                    continue;
                turns.push({ turnId: turn.turnId, items: structuredClone(turn.portableTranscript.items) });
            }
        }
        return { conversationId, publicThreadId: conversation.publicThreadId, title: conversation.title ?? "Shared conversation", availability: conversation.availability, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, turns };
    }
    markTerminal(conversationId, opaqueAccountId, nativeThreadId, state) {
        const at = this.timestamp();
        this.mutate((document) => {
            const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
            for (const turn of segment.turns)
                if (turn.state === "active") {
                    turn.state = state;
                    turn.phase = state === "ambiguous" ? "ambiguous" : "aborted";
                }
            segment.state = state;
            conversation.activeClient = null;
            conversation.availability = state === "ambiguous" ? "ambiguous" : availabilityFor(conversation);
            conversation.updatedAt = at;
        });
    }
    markTurnPhase(conversationId, opaqueAccountId, nativeThreadId, phase) {
        const at = this.timestamp();
        this.mutate((document) => {
            const { conversation, segment } = requireSegment(document, conversationId, opaqueAccountId, nativeThreadId);
            const turn = [...segment.turns].reverse().find((candidate) => candidate.state === "active");
            if (!turn || (phase === "active" && turn.phase !== "dispatching") || (phase === "dispatching" && turn.phase !== "prepared"))
                return;
            turn.phase = phase;
            conversation.updatedAt = at;
        });
    }
    newSegment(input, createdAt) {
        return {
            segmentId: opaqueId("ls", this.random),
            opaqueAccountId: input.opaqueAccountId,
            nativeThreadId: input.nativeThreadId,
            state: "active",
            createdAt,
            turns: [],
        };
    }
    findConversation(conversationId) {
        return this.state.conversations.find((conversation) => conversation.conversationId === conversationId) ?? null;
    }
    findSegment(opaqueAccountId, nativeThreadId) {
        for (const conversation of this.state.conversations) {
            const segment = conversation.segments.find((candidate) => candidate.opaqueAccountId === opaqueAccountId && candidate.nativeThreadId === nativeThreadId);
            if (segment)
                return { conversation, segment };
        }
        return null;
    }
    hasTurn(turnId) {
        return this.state.conversations.some((conversation) => conversation.segments.some((segment) => segment.turns.some((turn) => turn.turnId === turnId)));
    }
    mutate(mutator) {
        const next = structuredClone(this.state);
        mutator(next);
        if (!isCanonicalHistoryDocument(next))
            throw new Error("canonical history refused invalid state");
        // Write-ahead record: a process death between this append and snapshot
        // replacement recovers the exact next immutable document on next start.
        const record = { version: 1, digest: digest(JSON.stringify(next)), document: next };
        const snapshotBytes = canonicalJsonBytes(next);
        const journalBytes = canonicalJsonBytes(record);
        this.assertWritableSizes(snapshotBytes, journalBytes);
        (0, node_fs_1.appendFileSync)(this.journalPath, journalBytes, { mode: 0o600 });
        (0, node_fs_1.chmodSync)(this.journalPath, 0o600);
        writeCanonicalHistorySnapshot(this.root, next);
        (0, node_fs_1.writeFileSync)(this.journalPath, "", { mode: 0o600 });
        (0, node_fs_1.chmodSync)(this.journalPath, 0o600);
        this.state = next;
    }
    load() {
        if (!(0, node_fs_1.existsSync)(this.path)) {
            const initial = { version: 1, conversations: [] };
            writeCanonicalHistorySnapshot(this.root, initial);
            return initial;
        }
        (0, state_store_1.assertPrivateRegularFile)(this.path, exports.CANONICAL_HISTORY_MAX_BYTES_V1);
        const raw = (0, node_fs_1.readFileSync)(this.path, "utf8");
        if (Buffer.byteLength(raw, "utf8") > exports.CANONICAL_HISTORY_MAX_BYTES_V1)
            throw new Error("canonical history exceeds bounded size");
        const parsed = JSON.parse(raw);
        if (!isCanonicalHistoryDocument(parsed))
            throw new Error("canonical history failed strict validation");
        const recovered = this.recoverJournal(parsed);
        return recovered;
    }
    recoverJournal(snapshot) {
        if (!(0, node_fs_1.existsSync)(this.journalPath))
            return snapshot;
        try {
            (0, state_store_1.assertPrivateRegularFile)(this.journalPath, exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
            const lines = (0, node_fs_1.readFileSync)(this.journalPath, "utf8").trim().split("\n").filter(Boolean);
            if (lines.length === 0)
                return snapshot;
            const last = JSON.parse(lines.at(-1));
            if (!isJournalRecord(last))
                throw new Error("invalid canonical history journal");
            if (last.digest !== digest(JSON.stringify(last.document)))
                throw new Error("canonical history journal digest mismatch");
            writeCanonicalHistorySnapshot(this.root, last.document);
            (0, node_fs_1.writeFileSync)(this.journalPath, "", { mode: 0o600 });
            (0, node_fs_1.chmodSync)(this.journalPath, 0o600);
            return last.document;
        }
        catch {
            throw new Error("canonical history journal failed recovery");
        }
    }
    timestamp() {
        return new Date(this.now()).toISOString();
    }
    /** Reject size-invalid writes before a journal byte can affect recovery. */
    assertWritableSizes(snapshotBytes, journalBytes) {
        if (snapshotBytes.byteLength > exports.CANONICAL_HISTORY_MAX_BYTES_V1) {
            throw new Error("canonical history exceeds bounded snapshot size");
        }
        if (journalBytes.byteLength > exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1) {
            throw new Error("canonical history exceeds bounded journal size");
        }
        if (!(0, node_fs_1.existsSync)(this.journalPath))
            return;
        (0, state_store_1.assertPrivateRegularFile)(this.journalPath, exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1);
        const currentBytes = (0, node_fs_1.readFileSync)(this.journalPath).byteLength;
        if (currentBytes + journalBytes.byteLength > exports.CANONICAL_HISTORY_JOURNAL_MAX_BYTES_V1) {
            throw new Error("canonical history journal append exceeds its bound");
        }
    }
}
exports.CanonicalHistoryStoreV1 = CanonicalHistoryStoreV1;
function warningFor(conversation) {
    const turns = conversation.segments.flatMap((segment) => segment.turns);
    if (turns.some((turn) => turn.state === "ambiguous"))
        return "ambiguous";
    if (turns.some((turn) => turn.state === "incomplete"))
        return "content_gap";
    return null;
}
function canonicalJsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}
function writeCanonicalHistorySnapshot(root, value) {
    (0, state_store_1.writePrivateJsonAtomicBounded)(root, exports.CANONICAL_HISTORY_FILE_V1, value, exports.CANONICAL_HISTORY_MAX_BYTES_V1);
}
function requireConversation(document, conversationId) {
    const conversation = document.conversations.find((candidate) => candidate.conversationId === conversationId);
    if (!conversation)
        throw new Error("unknown canonical conversation");
    return conversation;
}
function requireSegment(document, conversationId, opaqueAccountId, nativeThreadId) {
    const conversation = requireConversation(document, conversationId);
    const segment = conversation.segments.find((candidate) => candidate.opaqueAccountId === opaqueAccountId && candidate.nativeThreadId === nativeThreadId);
    if (!segment)
        throw new Error("canonical history segment does not match conversation");
    return { conversation, segment };
}
function assertCreateInput(input) {
    if (!(0, types_1.isOpaqueAccountId)(input.opaqueAccountId) || !validNativeId(input.nativeThreadId)
        || !(0, types_1.isOpaqueRendererRef)(input.ownerRendererRef) || !isSafeLabel(input.ownerLabel)) {
        throw new Error("invalid canonical history binding");
    }
}
function serializeInput(params) {
    if (!(0, types_1.isPlainRecord)(params) || !Array.isArray(params.input) || params.input.length < 1 || params.input.length > 16)
        return null;
    const texts = [];
    for (const entry of params.input) {
        if (!(0, types_1.isPlainRecord)(entry) || (entry.type !== "text" && entry.type !== "input_text") || typeof entry.text !== "string")
            return null;
        if (entry.text.length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.text))
            return null;
        texts.push(entry.text);
    }
    const text = texts.join("\n");
    if (Buffer.byteLength(text, "utf8") > MAX_SERIALIZED_INPUT_BYTES)
        return null;
    return { digest: digest(text), text };
}
function availabilityFor(conversation) {
    if (conversation.segments.some((segment) => segment.state === "ambiguous" || segment.turns.some((turn) => turn.state === "ambiguous")))
        return "ambiguous";
    // Segment state may return to committed after a later safe turn. A terminal
    // receipt remains a known history gap and must keep the logical transcript
    // incomplete across that later success and across broker restart.
    if (conversation.segments.some((segment) => segment.state === "active" || segment.state === "incomplete" || segment.turns.some((turn) => turn.state === "incomplete")))
        return "incomplete";
    if (conversation.segments.some((segment) => segment.state !== "committed"))
        return "partial";
    return "complete";
}
function opaqueId(prefix, random) {
    return `${prefix}_${random(24).toString("base64url")}`;
}
function digest(value) {
    return `sha256:${(0, node_crypto_1.createHash)("sha256").update(value, "utf8").digest("hex")}`;
}
function validNativeId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function isSafeLabel(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeTitle(value) {
    return value === null || (typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value));
}
function isTimestamp(value) {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function isLogicalState(value) {
    return value === "committed" || value === "active" || value === "incomplete" || value === "ambiguous";
}
function isCanonicalHistoryDocument(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["conversations", "version"].join("\0")
        || value.version !== exports.CANONICAL_HISTORY_VERSION_V1 || !Array.isArray(value.conversations) || value.conversations.length > exports.CANONICAL_HISTORY_MAX_CONVERSATIONS_V1)
        return false;
    const nativeBindings = new Set();
    const ids = new Set();
    return value.conversations.every((conversation) => {
        if (!isPrivateConversation(conversation) || ids.has(conversation.conversationId))
            return false;
        ids.add(conversation.conversationId);
        for (const segment of conversation.segments) {
            const key = `${segment.opaqueAccountId}\0${segment.nativeThreadId}`;
            if (nativeBindings.has(key))
                return false;
            nativeBindings.add(key);
        }
        return true;
    });
}
function isJournalRecord(value) {
    return (0, types_1.isPlainRecord)(value) && Object.keys(value).sort().join("\0") === ["digest", "document", "version"].join("\0")
        && value.version === 1 && typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest)
        && isCanonicalHistoryDocument(value.document);
}
function isPrivateConversation(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["activeClient", "availability", "conversationId", "createdAt", "publicThreadId", "rootNativeThreadId", "segments", "title", "updatedAt"].join("\0")
        || !(0, types_1.isOpaqueConversationId)(value.conversationId) || !validNativeId(value.rootNativeThreadId) || !isPublicThreadId(value.publicThreadId) || !safeTitle(value.title) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)
        || !["complete", "partial", "incomplete", "ambiguous"].includes(String(value.availability))
        || !Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > MAX_SEGMENTS_PER_CONVERSATION)
        return false;
    if (value.activeClient !== null && (!(0, types_1.isPlainRecord)(value.activeClient) || Object.keys(value.activeClient).sort().join("\0") !== ["clientId", "label"].join("\0")
        || !(0, types_1.isOpaqueRendererRef)(value.activeClient.clientId) || !isSafeLabel(value.activeClient.label)))
        return false;
    if (!value.segments.every(isPrivateSegment))
        return false;
    return value.segments.filter((segment) => segment.state === "active").length <= 1;
}
function isPrivateSegment(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some((key) => !["segmentId", "opaqueAccountId", "nativeThreadId", "state", "createdAt", "committedAt", "turns"].includes(key))
        || !(0, types_1.isOpaqueSegmentId)(value.segmentId) || !(0, types_1.isOpaqueAccountId)(value.opaqueAccountId) || !validNativeId(value.nativeThreadId)
        || !isLogicalState(value.state) || !isTimestamp(value.createdAt)
        || (value.committedAt !== undefined && !isTimestamp(value.committedAt))
        || !Array.isArray(value.turns) || value.turns.length > MAX_TURNS_PER_SEGMENT || !value.turns.every(isPrivateTurn))
        return false;
    return value.turns.filter((turn) => turn.state === "active").length <= 1;
}
function isPrivateTurn(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some((key) => !["turnId", "nativeTurnId", "nativeItemIds", "state", "phase", "startedAt", "committedAt", "serializedInput", "portableTranscript"].includes(key))
        || !(0, types_1.isOpaqueTurnId)(value.turnId) || (value.nativeTurnId !== null && !validNativeId(value.nativeTurnId))
        || !Array.isArray(value.nativeItemIds) || value.nativeItemIds.length > MAX_PORTABLE_TRANSCRIPT_ITEMS || !value.nativeItemIds.every(validNativeId) || new Set(value.nativeItemIds).size !== value.nativeItemIds.length
        || !isLogicalState(value.state) || !isTurnPhase(value.phase) || !isTimestamp(value.startedAt)
        || (value.committedAt !== undefined && !isTimestamp(value.committedAt))
        || (value.portableTranscript !== null && !isPortableTranscript(value.portableTranscript)))
        return false;
    if (value.serializedInput === null)
        return true;
    return (0, types_1.isPlainRecord)(value.serializedInput) && Object.keys(value.serializedInput).sort().join("\0") === ["digest", "text"].join("\0")
        && typeof value.serializedInput.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.serializedInput.digest)
        && typeof value.serializedInput.text === "string" && Buffer.byteLength(value.serializedInput.text, "utf8") <= MAX_SERIALIZED_INPUT_BYTES
        && digest(value.serializedInput.text) === value.serializedInput.digest;
}
function isTurnPhase(value) { return value === "prepared" || value === "dispatching" || value === "active" || value === "committed" || value === "aborted" || value === "ambiguous"; }
function nativeItemIds(items) {
    if (!Array.isArray(items) || items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS)
        return [];
    const ids = items.map((item) => (0, types_1.isPlainRecord)(item) && validNativeId(item.id) ? item.id : null);
    return ids.every((id) => id !== null) && new Set(ids).size === ids.length ? ids : [];
}
function portableTranscriptFromItems(value) {
    if (!Array.isArray(value) || value.length > MAX_PORTABLE_TRANSCRIPT_ITEMS)
        return null;
    const items = [];
    for (const item of value) {
        const portable = portableItem(item);
        if (!portable)
            return null;
        items.push(portable);
    }
    const serialized = JSON.stringify(items);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PORTABLE_TRANSCRIPT_BYTES)
        return null;
    return { digest: digest(serialized), items };
}
function portableItem(value) {
    if (!(0, types_1.isPlainRecord)(value) || typeof value.type !== "string")
        return null;
    if (value.type === "userMessage") {
        if (!Array.isArray(value.content) || value.content.length > 32)
            return null;
        const text = value.content.map((entry) => (0, types_1.isPlainRecord)(entry) && entry.type === "text" && safePortableText(entry.text) ? entry.text : null);
        return text.every((entry) => entry !== null) ? { kind: "user", text: text.join("\n") } : null;
    }
    if (value.type === "agentMessage" && safePortableText(value.text))
        return { kind: "assistant", text: value.text };
    if (value.type === "plan" && safePortableText(value.text))
        return { kind: "plan", text: value.text };
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
function portableOutput(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value) || value.length > 32)
        return null;
    const text = value.map((entry) => (0, types_1.isPlainRecord)(entry) && entry.type === "input_text" && typeof entry.text === "string" ? entry.text : null);
    return text.every((entry) => entry !== null) ? text.join("\n") : null;
}
function portableText(item) {
    return [item.text, item.result].filter((value) => typeof value === "string");
}
function safePortableText(value) {
    return typeof value === "string" && value.length <= MAX_PORTABLE_TRANSCRIPT_BYTES
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
        && !/(?:\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|cookie|authorization)\b\s*[:=]|\bsk-[A-Za-z0-9_-]{12,}|BEGIN [A-Z ]+PRIVATE KEY)/i.test(value);
}
function redactedToolSummary(value) {
    if (!safePortableText(value) || Buffer.byteLength(value, "utf8") > 16 * 1024)
        return null;
    // Tool payloads commonly include local paths and opaque resource urls. Those
    // cannot be portable across accounts, so an item containing them is explicit
    // incomplete rather than copied with a misleading reference.
    if (/(?:^|[\s"'])(?:\/|~\/|file:|data:|blob:|https?:\/\/)/i.test(value))
        return null;
    return value;
}
function isPortableTranscript(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== ["digest", "items"].join("\0")
        || typeof value.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.digest)
        || !Array.isArray(value.items) || value.items.length > MAX_PORTABLE_TRANSCRIPT_ITEMS || !value.items.every(isPortableItem))
        return false;
    const serialized = JSON.stringify(value.items);
    return Buffer.byteLength(serialized, "utf8") <= MAX_PORTABLE_TRANSCRIPT_BYTES && digest(serialized) === value.digest;
}
function isPortableItem(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some((key) => !["kind", "text", "name", "result"].includes(key))
        || !["user", "assistant", "plan", "tool"].includes(String(value.kind)))
        return false;
    if (value.text !== undefined && !safePortableText(value.text))
        return false;
    if (value.result !== undefined && !safePortableText(value.result))
        return false;
    if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 160 || !safePortableText(value.name)))
        return false;
    return (value.kind === "user" || value.kind === "assistant" || value.kind === "plan") ? typeof value.text === "string"
        : value.kind === "tool" ? typeof value.name === "string" && typeof value.result === "string"
            : false;
}
function isPublicThreadId(value) {
    return typeof value === "string" && /^lh_[A-Za-z0-9_-]{16,128}$/.test(value);
}
//# sourceMappingURL=canonical-history.js.map