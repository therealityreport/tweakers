"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validateAnswers, validateAskInput } = require("../core");

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
