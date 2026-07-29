"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  ANSWER_STATUSES,
  CONTRACT_LIMITS,
  DECISION_GUIDANCE,
  FAILURE_STAGES,
  RESULT_STATUSES,
  normalizeResult,
  serializeResult,
  validateAnswers,
  validateAnswerStates,
  validateAskInput,
} = require("../core");

function validInput(overrides = {}) {
  return {
    round_id: "setup-round-1",
    questions: [
      {
        id: "tracker",
        header: "Issue tracker",
        question: "Where should project work be tracked?",
        selection_mode: "single",
        options: [
          { id: "github", label: "GitHub Issues (Recommended)", description: "Keep work beside the code." },
          { id: "local", label: "Local files", description: "Keep work only on this computer." },
        ],
        allow_other: true,
      },
    ],
    ...overrides,
  };
}

test("accepts one to six questions with two to five choices", () => {
  const question = validInput().questions[0];
  const six = validInput({ questions: Array.from({ length: 6 }, (_, index) => ({ ...question, id: `question-${index}` })) });
  assert.equal(validateAskInput(six).ok, true);
  assert.equal(validateAskInput(validInput({ questions: [] })).ok, false);
  assert.equal(validateAskInput(validInput({ questions: Array(7).fill(question) })).ok, false);
});

test("rejects duplicate question and option identifiers", () => {
  const question = validInput().questions[0];
  const duplicateQuestions = validateAskInput(validInput({ questions: [question, question] }));
  assert.equal(duplicateQuestions.ok, false);
  assert.match(duplicateQuestions.errors.join(" "), /duplicates tracker/);
  const duplicateOptions = validateAskInput(validInput({ questions: [{ ...question, options: [question.options[0], question.options[0]] }] }));
  assert.equal(duplicateOptions.ok, false);
  assert.match(duplicateOptions.errors.join(" "), /duplicates github/);
});

test("validates single-select and Other answers", () => {
  const input = validateAskInput(validInput()).value;
  assert.equal(validateAnswers(input, { tracker: { selected_option_ids: ["github"], other_text: null } }).ok, true);
  assert.equal(validateAnswers(input, { tracker: { selected_option_ids: [], other_text: "Linear" } }).ok, true);
  assert.equal(validateAnswers(input, { tracker: { selected_option_ids: ["github"], other_text: "Linear" } }).ok, false);
});

test("enforces the multi-select minimum while allowing every possible choice", () => {
  const question = validInput().questions[0];
  const validation = validateAskInput(validInput({ questions: [{ ...question, selection_mode: "multiple", min_selections: 2, max_selections: 3 }] }));
  assert.equal(validation.ok, true);
  assert.equal(validation.value.questions[0].max_selections, 3);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github"], other_text: null } }).ok, false);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github", "local"], other_text: null } }).ok, true);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github", "local"], other_text: "Linear" } }).ok, true);
});

test("normalizes a lower multi-select maximum to every available choice", () => {
  const question = validInput().questions[0];
  const validation = validateAskInput(validInput({
    questions: [{ ...question, selection_mode: "multiple", max_selections: 1 }],
  }));
  assert.equal(validation.ok, true);
  assert.equal(validation.value.questions[0].max_selections, 3);
  assert.equal(validateAnswers(validation.value, {
    tracker: { selected_option_ids: ["github", "local"], other_text: "Linear" },
  }).ok, true);
});

test("optional questions can be skipped while still enforcing a minimum when answered", () => {
  const question = validInput().questions[0];
  const validation = validateAskInput(validInput({
    questions: [{
      ...question,
      selection_mode: "multiple",
      required: false,
      min_selections: 2,
      max_selections: 3,
    }],
  }));
  assert.equal(validation.ok, true);
  assert.equal(validation.value.questions[0].max_selections, 3);
  assert.equal(validateAnswers(validation.value, {}).ok, true);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github"], other_text: null } }).ok, false);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github", "local"], other_text: null } }).ok, true);
  assert.equal(validateAnswers(validation.value, { tracker: { selected_option_ids: ["github", "local"], other_text: "Linear" } }).ok, true);
});

test("rejects unknown choices and disallowed Other text", () => {
  const question = validInput().questions[0];
  const input = validateAskInput(validInput({ questions: [{ ...question, allow_other: false }] })).value;
  assert.equal(validateAnswers(input, { tracker: { selected_option_ids: ["missing"], other_text: null } }).ok, false);
  assert.equal(validateAnswers(input, { tracker: { selected_option_ids: [], other_text: "Linear" } }).ok, false);
});

test("variation example covers multi-select, five choices, optional input, limits, and Other", () => {
  const fixturePath = path.join(__dirname, "../examples/variation-round.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const validation = validateAskInput(fixture);
  assert.equal(validation.ok, true, validation.errors?.join("\n"));

  const [improvements, releaseStyle, notifications, proof] = validation.value.questions;
  assert.equal(improvements.selection_mode, "multiple");
  assert.equal(improvements.options.length, 5);
  assert.equal(improvements.allow_other, true);
  assert.equal(improvements.max_selections, 6);
  assert.equal(releaseStyle.options.length, 4);
  assert.equal(releaseStyle.allow_other, true);
  assert.equal(notifications.required, false);
  assert.equal(notifications.min_selections, 0);
  assert.equal(proof.selection_mode, "multiple");
  assert.equal(proof.min_selections, 2);

  const accepted = validateAnswers(validation.value, {
    improvements: { selected_option_ids: ["faster", "accessible"], other_text: "Clearer progress indicators" },
    release_style: { selected_option_ids: [], other_text: "Ask before enabling it" },
    notifications: { selected_option_ids: [], other_text: null },
    proof: { selected_option_ids: ["automated_tests", "visual_check", "restart_check"], other_text: null }
  });
  assert.equal(accepted.ok, true, accepted.errors?.join("\n"));

  const everyAvailableChoice = validateAnswers(validation.value, {
    improvements: { selected_option_ids: ["faster", "simpler", "accessible", "safer", "customizable"], other_text: "A different improvement" },
    release_style: { selected_option_ids: ["preview"], other_text: null },
    notifications: { selected_option_ids: [], other_text: null },
    proof: { selected_option_ids: ["automated_tests", "visual_check", "restart_check", "fallback_check"], other_text: null }
  });
  assert.equal(everyAvailableChoice.ok, true, everyAvailableChoice.errors?.join("\n"));
});

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

function richInput() {
  const rich = fixture("rich-ask.json");
  const validation = validateAskInput(rich.input);
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  return validation.value;
}

test("freezes the additive public core exports and bounded contract constants", () => {
  assert.deepEqual(Object.keys(require("../core")).sort(), [
    "ANSWER_STATUSES",
    "CONTRACT_LIMITS",
    "DECISION_GUIDANCE",
    "FAILURE_STAGES",
    "RESULT_STATUSES",
    "normalizeResult",
    "serializeResult",
    "validateAnswerStates",
    "validateAnswers",
    "validateAskInput",
  ]);
  assert.deepEqual(ANSWER_STATUSES, ["unanswered", "answered", "skipped"]);
  assert.deepEqual(RESULT_STATUSES, ["submitted", "cancelled", "display_failed"]);
  assert.deepEqual(FAILURE_STAGES, ["tool_discovery", "carrier_attach", "owned_mount", "generic_mount", "host_empty_response"]);
  assert.equal(CONTRACT_LIMITS.ask_payload_bytes, 65536);
  assert.deepEqual(DECISION_GUIDANCE, {
    scope: "current_task",
    authority: "preference",
    semantics: "preference-not-policy",
    on_conflict: "Explain the conflict, the pros and cons, and what must be given up. Ask before materially changing the selected direction.",
  });
});

test("legacy and rich ask fixtures normalize exactly without inferring Recommended from label text", () => {
  for (const name of ["legacy-ask.json", "rich-ask.json"]) {
    const golden = fixture(name);
    const validation = validateAskInput(golden.input);
    assert.equal(validation.ok, true, validation.errors?.join("\n"));
    assert.deepEqual(validation.value, golden.normalized);
  }
  assert.equal(fixture("legacy-ask.json").normalized.questions[0].options[0].recommended, false);
  assert.equal(fixture("rich-ask.json").normalized.questions[0].options[0].recommended, true);
});

test("rejects unsupported, malformed, HTML, and oversized rich ask content", () => {
  const golden = fixture("rich-ask.json").input;
  const unsupported = structuredClone(golden);
  unsupported.questions[0].options[0].policy = "permanent";
  assert.match(validateAskInput(unsupported).errors.join(" "), /policy is not supported/);

  const malformed = structuredClone(golden);
  malformed.questions[0].options[0].recommended = "yes";
  assert.match(validateAskInput(malformed).errors.join(" "), /recommended must be a boolean/);

  const html = structuredClone(golden);
  html.questions[0].options[0].details = "<strong>Important</strong>";
  assert.match(validateAskInput(html).errors.join(" "), /plain text without HTML/);

  const oversized = structuredClone(golden);
  oversized.questions = Array.from({ length: 6 }, (_, questionIndex) => ({
    ...structuredClone(golden.questions[0]),
    id: `question_${questionIndex}`,
    options: Array.from({ length: 5 }, (_, optionIndex) => ({
      ...structuredClone(golden.questions[0].options[0]),
      id: `option_${optionIndex}`,
      details: "d".repeat(CONTRACT_LIMITS.details_characters),
      pros: Array(5).fill("p".repeat(CONTRACT_LIMITS.tradeoff_item_characters)),
      cons: Array(5).fill("c".repeat(CONTRACT_LIMITS.tradeoff_item_characters)),
      gives_up: Array(5).fill("g".repeat(CONTRACT_LIMITS.tradeoff_item_characters)),
    })),
  }));
  assert.match(validateAskInput(oversized).errors.join(" "), /at most 65536 UTF-8 bytes/);
});

test("freezes single, multiple, Other, and skipped answer-state fixtures", () => {
  const input = richInput();
  for (const name of ["single-answer.json", "multiple-answer.json", "other-answer.json", "skipped-answer.json"]) {
    const golden = fixture(name);
    const validation = validateAnswerStates(input, golden.answers);
    assert.equal(validation.ok, true, `${name}: ${validation.errors?.join("\n")}`);
    assert.deepEqual(validation.value, golden.normalized);
  }
});

test("legacy validateAnswers consumers keep their status-free answer shape", () => {
  const input = richInput();
  const golden = fixture("single-answer.json");
  const validation = validateAnswers(input, golden.answers);
  assert.equal(validation.ok, true, validation.errors?.join("\n"));
  assert.deepEqual(validation.value, {
    scanner_setup: { selected_option_ids: ["built_in"], other_text: null },
    proof: { selected_option_ids: [], other_text: null },
  });
});

test("rejects dangling and duplicate IDs, skipped selections, and blank Other text", () => {
  const input = richInput();
  assert.match(validateAnswerStates(input, {
    scanner_setup: { status: "answered", selected_option_ids: ["built_in", "built_in"], other_text: null },
    proof: { status: "skipped", selected_option_ids: [], other_text: null },
  }).errors.join(" "), /duplicate choice built_in/);
  assert.match(validateAnswerStates(input, {
    scanner_setup: { status: "answered", selected_option_ids: ["missing"], other_text: null },
    proof: { status: "skipped", selected_option_ids: [], other_text: null },
    dangling: { status: "skipped", selected_option_ids: [], other_text: null },
  }).errors.join(" "), /unknown question dangling.*unknown choices: missing/);
  assert.match(validateAnswerStates(input, {
    scanner_setup: { status: "skipped", selected_option_ids: ["built_in"], other_text: null },
    proof: { status: "skipped", selected_option_ids: [], other_text: null },
  }).errors.join(" "), /cannot be skipped with selected choices/);
  assert.match(validateAnswerStates(input, {
    scanner_setup: { status: "answered", selected_option_ids: [], other_text: "   " },
    proof: { status: "skipped", selected_option_ids: [], other_text: null },
  }).errors.join(" "), /Other answer must not be blank/);
});

test("submitted, cancelled draft, display-failed, and host-empty result fixtures normalize exactly", () => {
  const input = richInput();
  for (const name of [
    "submitted-result.json",
    "cancelled-draft-result.json",
    "display-failed-result.json",
    "host-empty-response-result.json",
  ]) {
    const golden = fixture(name);
    const validation = normalizeResult(input, golden.result);
    assert.equal(validation.ok, true, `${name}: ${validation.errors?.join("\n")}`);
    assert.deepEqual(validation.value, golden.normalized);
  }
});

test("owned and fallback serialization share one normalized golden result", () => {
  const input = richInput();
  const golden = fixture("submitted-result.json");
  const owned = serializeResult(input, golden.result);
  const fallback = serializeResult(input, structuredClone(golden.result));
  assert.equal(owned.ok, true, owned.errors?.join("\n"));
  assert.deepEqual(owned, fallback);
  assert.deepEqual(owned.value.structuredContent, golden.normalized);
  assert.deepEqual(JSON.parse(owned.value.text), golden.normalized);
});

test("terminal result normalization rejects partial cancellation and successful empty answers", () => {
  const input = richInput();
  assert.match(normalizeResult(input, {
    status: "cancelled",
    cancel_reason: "user_cancelled",
    answers: { scanner_setup: { selected_option_ids: ["built_in"], other_text: null } },
  }).errors.join(" "), /must not include partial answers/);
  assert.equal(normalizeResult(input, { status: "submitted", cancelled: false, answers: {} }).ok, false);
});
