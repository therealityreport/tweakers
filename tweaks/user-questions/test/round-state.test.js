"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateAskInput } = require("../core");
const { ROUND_PHASES, createRoundState, reduceRoundState } = require("../round-state");

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

function input() {
  const validation = validateAskInput(fixture("rich-ask.json").input);
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  return validation.value;
}

function apply(roundInput, state, action) {
  const result = reduceRoundState(roundInput, state, action);
  assert.equal(result.ok, true, result.errors?.join("\n"));
  return result.value;
}

test("freezes round phases and creates explicit unanswered state", () => {
  assert.deepEqual(Object.keys(require("../round-state")).sort(), [
    "ROUND_PHASES",
    "createRoundState",
    "reduceRoundState",
  ]);
  assert.deepEqual(ROUND_PHASES, ["claiming", "question", "review", "submitting", "cancelled", "submitted"]);
  assert.deepEqual(createRoundState(input()), {
    phase: "claiming",
    current_question_id: null,
    answers: {
      scanner_setup: { status: "unanswered", selected_option_ids: [], other_text: null },
      proof: { status: "unanswered", selected_option_ids: [], other_text: null },
    },
    other_selected_question_ids: [],
    expanded_detail_ids: [],
    validation_errors: {},
    revision: 0,
  });
});

test("claim, details, answer, Next, Back, review, edit, and submit preserve exact values", () => {
  const roundInput = input();
  let state = createRoundState(roundInput);
  state = apply(roundInput, state, { type: "claim", revision: 0 });
  state = apply(roundInput, state, {
    type: "details", revision: 1, question_id: "scanner_setup", option_id: "built_in", expanded: true,
  });
  state = apply(roundInput, state, {
    type: "answer", revision: 2, question_id: "scanner_setup", selected_option_ids: ["built_in"],
  });
  state = apply(roundInput, state, { type: "next", revision: 3 });
  state = apply(roundInput, state, {
    type: "answer", revision: 4, question_id: "proof", selected_option_ids: ["tests", "review"],
  });
  state = apply(roundInput, state, { type: "back", revision: 5 });
  assert.equal(state.current_question_id, "scanner_setup");
  assert.deepEqual(state.answers.scanner_setup.selected_option_ids, ["built_in"]);
  assert.deepEqual(state.answers.proof.selected_option_ids, ["tests", "review"]);
  assert.deepEqual(state.expanded_detail_ids, ["scanner_setup:built_in"]);
  state = apply(roundInput, state, { type: "next", revision: 6 });
  state = apply(roundInput, state, { type: "next", revision: 7 });
  assert.equal(state.phase, "review");
  state = apply(roundInput, state, { type: "edit", revision: 8, question_id: "scanner_setup" });
  state = apply(roundInput, state, {
    type: "answer", revision: 9, question_id: "scanner_setup", selected_option_ids: [],
  });
  state = apply(roundInput, state, {
    type: "other", revision: 10, question_id: "scanner_setup", other_text: "Use the existing external service",
  });
  state = apply(roundInput, state, { type: "review", revision: 11 });
  state = apply(roundInput, state, { type: "submit", revision: 12 });
  assert.equal(state.phase, "submitted");
  assert.deepEqual(state.answers.scanner_setup, {
    status: "answered",
    selected_option_ids: [],
    other_text: "Use the existing external service",
  });
  assert.equal(state.revision, 13);
});

test("Skip is explicit, clears prior values, and is allowed for required questions", () => {
  const roundInput = input();
  let state = apply(roundInput, createRoundState(roundInput), { type: "claim", revision: 0 });
  state = apply(roundInput, state, {
    type: "answer", revision: 1, question_id: "scanner_setup", selected_option_ids: ["built_in"],
  });
  state = apply(roundInput, state, { type: "skip", revision: 2 });
  assert.deepEqual(state.answers.scanner_setup, {
    status: "skipped",
    selected_option_ids: [],
    other_text: null,
  });
  state = apply(roundInput, state, { type: "next", revision: 3 });
  state = apply(roundInput, state, { type: "skip", revision: 4 });
  state = apply(roundInput, state, { type: "next", revision: 5 });
  assert.equal(state.phase, "review");
});

test("empty Other selection persists across Back/Next, blocks advance, and deselection clears text", () => {
  const roundInput = input();
  roundInput.questions[1].min_selections = 1;
  let state = apply(roundInput, createRoundState(roundInput), { type: "claim", revision: 0 });
  state = apply(roundInput, state, { type: "skip", revision: 1 });
  state = apply(roundInput, state, { type: "next", revision: 2 });
  state = apply(roundInput, state, {
    type: "other", revision: 3, question_id: "proof", selected: true, other_text: "",
  });
  assert.deepEqual(state.other_selected_question_ids, ["proof"]);
  assert.equal(state.answers.proof.other_text, null);
  state = apply(roundInput, state, { type: "next", revision: 4 });
  assert.equal(state.phase, "question");
  assert.equal(state.current_question_id, "proof");
  assert.equal(state.validation_errors.proof, "Enter an Other response before continuing.");

  state = apply(roundInput, state, { type: "back", revision: 5 });
  state = apply(roundInput, state, { type: "next", revision: 6 });
  assert.deepEqual(state.other_selected_question_ids, ["proof"]);
  assert.equal(state.answers.proof.other_text, null);
  state = apply(roundInput, state, {
    type: "other", revision: 7, question_id: "proof", selected: true, other_text: "Custom proof",
  });
  state = apply(roundInput, state, {
    type: "answer", revision: 8, question_id: "proof", selected_option_ids: ["tests"],
  });
  state = apply(roundInput, state, { type: "back", revision: 9 });
  state = apply(roundInput, state, { type: "next", revision: 10 });
  assert.deepEqual(state.other_selected_question_ids, ["proof"]);
  assert.equal(state.answers.proof.other_text, "Custom proof");

  state = apply(roundInput, state, {
    type: "other", revision: 11, question_id: "proof", selected: false, other_text: null,
  });
  assert.deepEqual(state.other_selected_question_ids, []);
  assert.equal(state.answers.proof.other_text, null);
  assert.deepEqual(state.answers.proof.selected_option_ids, ["tests"]);
});

test("required-choice validation is a persisted reducer state until the answer is corrected", () => {
  const roundInput = input();
  let state = apply(roundInput, createRoundState(roundInput), { type: "claim", revision: 0 });
  state = apply(roundInput, state, { type: "next", revision: 1 });
  assert.equal(state.phase, "question");
  assert.equal(state.current_question_id, "scanner_setup");
  assert.deepEqual(state.validation_errors, {
    scanner_setup: "Choose an answer or Skip before continuing.",
  });
  assert.equal(state.revision, 2);

  state = apply(roundInput, state, {
    type: "details", revision: 2, question_id: "scanner_setup", option_id: "built_in", expanded: true,
  });
  assert.equal(state.validation_errors.scanner_setup, "Choose an answer or Skip before continuing.");
  state = apply(roundInput, state, {
    type: "answer", revision: 3, question_id: "scanner_setup", selected_option_ids: ["built_in"],
  });
  assert.deepEqual(state.validation_errors, {});
});

test("Other selection fails closed when the question disallows Other, including blank text", () => {
  const roundInput = input();
  roundInput.questions[0].allow_other = false;
  let state = apply(roundInput, createRoundState(roundInput), { type: "claim", revision: 0 });
  const result = reduceRoundState(roundInput, state, {
    type: "other",
    revision: 1,
    question_id: "scanner_setup",
    selected: true,
    other_text: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /does not allow Other input/);
  assert.deepEqual(state.other_selected_question_ids, []);
  assert.equal(state.answers.scanner_setup.other_text, null);
});

test("cancel-save, resume, imported resumed golden state, and discard are deterministic", () => {
  const roundInput = input();
  let state = apply(roundInput, createRoundState(roundInput), { type: "claim", revision: 0 });
  state = apply(roundInput, state, {
    type: "answer", revision: 1, question_id: "scanner_setup", selected_option_ids: ["built_in"],
  });
  state = apply(roundInput, state, { type: "next", revision: 2 });
  state = apply(roundInput, state, { type: "cancel_save", revision: 3 });
  assert.equal(state.phase, "cancelled");
  state = apply(roundInput, state, { type: "resume", revision: 4 });
  assert.equal(state.phase, "question");
  assert.equal(state.current_question_id, "proof");
  assert.deepEqual(state.answers.scanner_setup.selected_option_ids, ["built_in"]);

  const golden = fixture("resumed-state.json");
  const imported = apply(roundInput, createRoundState(roundInput), {
    type: "resume", revision: 0, draft: golden.draft,
  });
  assert.deepEqual(imported, golden.normalized);

  const discarded = apply(roundInput, imported, { type: "discard", revision: 1 });
  assert.equal(discarded.phase, "claiming");
  assert.equal(discarded.revision, 2);
  assert.deepEqual(discarded.answers.scanner_setup.selected_option_ids, []);
  assert.deepEqual(discarded.expanded_detail_ids, []);
});

test("the reducer is pure and deterministic for identical state and action", () => {
  const roundInput = input();
  const state = createRoundState(roundInput);
  const before = structuredClone(state);
  const action = { type: "claim", revision: 0 };
  const first = reduceRoundState(roundInput, state, action);
  const second = reduceRoundState(roundInput, state, action);
  assert.deepEqual(first, second);
  assert.deepEqual(state, before);
  assert.notEqual(first.value, state);
});

test("rejects stale revisions, unknown actions and fields, dangling IDs, blank Other, and skipped selections", () => {
  const roundInput = input();
  const claiming = createRoundState(roundInput);
  assert.match(reduceRoundState(roundInput, claiming, { type: "claim", revision: 1 }).errors.join(" "), /stale revision/);
  assert.match(reduceRoundState(roundInput, claiming, { type: "explode", revision: 0 }).errors.join(" "), /unknown action/);
  assert.match(reduceRoundState(roundInput, claiming, { type: "claim", revision: 0, extra: true }).errors.join(" "), /field extra is not supported/);

  const state = apply(roundInput, claiming, { type: "claim", revision: 0 });
  assert.match(reduceRoundState(roundInput, state, {
    type: "answer", revision: 1, question_id: "missing", selected_option_ids: ["built_in"],
  }).errors.join(" "), /must target the current question/);
  assert.match(reduceRoundState(roundInput, state, {
    type: "answer", revision: 1, question_id: "scanner_setup", selected_option_ids: ["missing"],
  }).errors.join(" "), /unknown choices/);
  assert.match(reduceRoundState(roundInput, state, {
    type: "other", revision: 1, question_id: "scanner_setup", selected: false, other_text: "conflict",
  }).errors.join(" "), /deselected Other input cannot include text/);

  const invalidState = structuredClone(state);
  invalidState.answers.scanner_setup = {
    status: "skipped",
    selected_option_ids: ["built_in"],
    other_text: null,
  };
  assert.match(reduceRoundState(roundInput, invalidState, { type: "next", revision: 1 }).errors.join(" "), /cannot be skipped with selected choices/);
});
