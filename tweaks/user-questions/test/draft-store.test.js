"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DRAFT_DIRECTORY,
  DRAFT_TTL_MS,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  DraftStoreError,
  createDraftStore,
  inputFingerprint,
} = require("../draft-store");

const ROUTE_A = "route-binding-aaaaaaaaaaaaaaaa";
const ROUTE_B = "route-binding-bbbbbbbbbbbbbbbb";

test("drafts are private, task/input scoped, CAS protected, and tokens rotate only when resume commits", (t) => {
  const root = temporaryRoot(t);
  const dataDir = path.join(root, "data");
  const store = createDraftStore({ dataDir });
  const input = roundInput("round-a");
  const state = roundState(1);
  const saved = store.save({ taskRouteId: ROUTE_A, roundId: input.round_id, input, state, expectedRevision: 0 });
  assert.match(saved.resume_token, /^[A-Za-z0-9_-]{32,128}$/);
  const draftDir = path.join(dataDir, DRAFT_DIRECTORY);
  assert.equal(fs.statSync(draftDir).mode & 0o777, 0o700);
  const files = fs.readdirSync(draftDir);
  const recordName = files.find((name) => name.endsWith(".json"));
  assert.match(recordName, /^[a-f0-9]{64}\.json$/);
  assert.equal(fs.statSync(path.join(draftDir, recordName)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(draftDir, "install-secret")).mode & 0o777, 0o600);
  const disk = fs.readFileSync(path.join(draftDir, recordName), "utf8");
  assert.equal(disk.includes(saved.resume_token), false);
  assert.equal(disk.includes(ROUTE_A), false);

  const loaded = store.load({
    taskRouteId: ROUTE_A,
    roundId: input.round_id,
    input,
    resumeToken: saved.resume_token,
  });
  assert.deepEqual(loaded.state, state);
  assert.equal(loaded.resume_token, saved.resume_token);
  assert.deepEqual(
    store.load({ taskRouteId: ROUTE_A, roundId: input.round_id, input, resumeToken: saved.resume_token }).state,
    state,
    "an uncommitted display attempt must leave the caller's token usable",
  );
  const committed = store.commitResume({
    taskRouteId: ROUTE_A,
    roundId: input.round_id,
    input,
    resumeToken: saved.resume_token,
  });
  assert.notEqual(committed.resume_token, saved.resume_token);
  assert.throws(
    () => store.load({ taskRouteId: ROUTE_A, roundId: input.round_id, input, resumeToken: saved.resume_token }),
    (error) => error instanceof DraftStoreError && error.code === "resume_token_invalid",
  );
  assert.throws(
    () => store.save({
      taskRouteId: ROUTE_A,
      roundId: input.round_id,
      input,
      state: roundState(2),
      expectedRevision: 1,
      resumeToken: saved.resume_token,
    }),
    (error) => error instanceof DraftStoreError && error.code === "resume_token_invalid",
    "a stale display attempt cannot restore a token after rotation commits",
  );
  assert.throws(
    () => store.load({ taskRouteId: ROUTE_B, roundId: input.round_id, input, resumeToken: committed.resume_token }),
    (error) => error instanceof DraftStoreError && error.code === "draft_not_found",
  );
  assert.throws(
    () => store.save({
      taskRouteId: ROUTE_A,
      roundId: input.round_id,
      input,
      state: roundState(1),
      expectedRevision: 0,
      resumeToken: committed.resume_token,
    }),
    (error) => error instanceof DraftStoreError && error.code === "revision_conflict",
  );
  const updated = store.save({
    taskRouteId: ROUTE_A,
    roundId: input.round_id,
    input,
    state: roundState(2),
    expectedRevision: 1,
    resumeToken: committed.resume_token,
  });
  assert.equal(updated.revision, 2);
});

test("input fingerprint is canonical, ignores only resume_token, and changed input cannot cross", (t) => {
  const root = temporaryRoot(t);
  const store = createDraftStore({ dataDir: path.join(root, "data") });
  const input = roundInput("round-input");
  const reordered = {
    questions: input.questions,
    resume_token: "opaque_resume_token_123456",
    round_id: input.round_id,
  };
  assert.equal(inputFingerprint(input), inputFingerprint(reordered));
  const changed = structuredClone(input);
  changed.questions[0].question = "Changed question text";
  assert.notEqual(inputFingerprint(input), inputFingerprint(changed));
  const saved = store.save({ taskRouteId: ROUTE_A, roundId: input.round_id, input, state: roundState(1), expectedRevision: 0 });
  assert.throws(
    () => store.load({
      taskRouteId: ROUTE_A,
      roundId: input.round_id,
      input: changed,
      resumeToken: saved.resume_token,
    }),
    (error) => error instanceof DraftStoreError && error.code === "draft_not_found",
  );
});

test("corruption and insecure permissions are quarantined without exposing content", (t) => {
  const root = temporaryRoot(t);
  const dataDir = path.join(root, "data");
  const store = createDraftStore({ dataDir });
  const input = roundInput("round-corrupt");
  const saved = store.save({ taskRouteId: ROUTE_A, roundId: input.round_id, input, state: roundState(1), expectedRevision: 0 });
  const draftDir = path.join(dataDir, DRAFT_DIRECTORY);
  const filePath = path.join(draftDir, fs.readdirSync(draftDir).find((name) => name.endsWith(".json")));
  fs.writeFileSync(filePath, "{not-json", { mode: 0o600 });
  assert.throws(
    () => store.load({ taskRouteId: ROUTE_A, roundId: input.round_id, input, resumeToken: saved.resume_token }),
    (error) => error instanceof DraftStoreError && error.code === "draft_corrupt",
  );
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readdirSync(draftDir).some((name) => name.includes(".corrupt.")), true);

  const savedAgain = store.save({ taskRouteId: ROUTE_A, roundId: input.round_id, input, state: roundState(1), expectedRevision: 0 });
  const nextPath = path.join(draftDir, fs.readdirSync(draftDir).find((name) => name.endsWith(".json")));
  fs.chmodSync(nextPath, 0o644);
  assert.throws(
    () => store.load({ taskRouteId: ROUTE_A, roundId: input.round_id, input, resumeToken: savedAgain.resume_token }),
    (error) => error instanceof DraftStoreError && error.code === "draft_permissions_invalid",
  );
});

test("expiry and discard remove only the scoped record", (t) => {
  const root = temporaryRoot(t);
  let clock = 1_700_000_000_000;
  const store = createDraftStore({ dataDir: path.join(root, "data"), now: () => clock });
  const first = roundInput("round-first");
  const second = roundInput("round-second");
  const firstSaved = store.save({ taskRouteId: ROUTE_A, roundId: first.round_id, input: first, state: roundState(1), expectedRevision: 0 });
  store.save({ taskRouteId: ROUTE_A, roundId: second.round_id, input: second, state: roundState(1), expectedRevision: 0 });
  assert.equal(store.inspect().drafts, 2);
  assert.equal(store.discard({ taskRouteId: ROUTE_A, roundId: second.round_id, input: second }), true);
  assert.equal(store.inspect().drafts, 1);
  clock += DRAFT_TTL_MS + 1;
  assert.throws(
    () => store.load({ taskRouteId: ROUTE_A, roundId: first.round_id, input: first, resumeToken: firstSaved.resume_token }),
    (error) => error instanceof DraftStoreError && error.code === "draft_expired",
  );
  assert.equal(store.inspect().drafts, 0);
});

test("per-draft, count, and total retention limits are enforced", (t) => {
  const root = temporaryRoot(t);
  const store = createDraftStore({ dataDir: path.join(root, "data") });
  const tooLarge = roundInput("round-too-large");
  assert.throws(
    () => store.save({
      taskRouteId: ROUTE_A,
      roundId: tooLarge.round_id,
      input: tooLarge,
      state: { ...roundState(1), padding: "x".repeat(MAX_DRAFT_BYTES) },
      expectedRevision: 0,
    }),
    (error) => error instanceof DraftStoreError && error.code === "draft_oversize",
  );

  for (let index = 0; index < MAX_DRAFTS + 4; index += 1) {
    const input = roundInput(`round-count-${index}`);
    store.save({ taskRouteId: ROUTE_A, roundId: input.round_id, input, state: roundState(1), expectedRevision: 0 });
  }
  assert.equal(store.inspect().drafts <= MAX_DRAFTS, true);

  for (let index = 0; index < 12; index += 1) {
    const input = roundInput(`round-bytes-${index}`);
    store.save({
      taskRouteId: ROUTE_B,
      roundId: input.round_id,
      input,
      state: { ...roundState(1), padding: "y".repeat(190_000) },
      expectedRevision: 0,
    });
  }
  const snapshot = store.inspect();
  assert.equal(snapshot.drafts <= MAX_DRAFTS, true);
  assert.equal(snapshot.bytes <= MAX_TOTAL_BYTES, true);
});

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uq-draft-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function roundInput(roundId) {
  return {
    round_id: roundId,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Which path?",
      selection_mode: "single",
      options: [
        { id: "safe", label: "Safe", description: "Use safe." },
        { id: "fast", label: "Fast", description: "Use fast." },
      ],
      allow_other: true,
      required: true,
      min_selections: 1,
      max_selections: 1,
    }],
  };
}

function roundState(revision) {
  return {
    phase: "question",
    current_question_id: "choice",
    answers: { choice: { status: "unanswered", selected_option_ids: [], other_text: null } },
    expanded_detail_ids: [],
    validation_errors: {},
    revision,
  };
}
