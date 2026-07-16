"use strict";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAskInput(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["input must be an object"] };
  const roundId = cleanId(value.round_id, "round_id", errors);
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 6) {
    errors.push("questions must contain 1 to 6 questions");
  }
  const seenQuestions = new Set();
  const questions = Array.isArray(value.questions)
    ? value.questions.slice(0, 6).map((question, index) => normalizeQuestion(question, index, seenQuestions, errors))
    : [];
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { round_id: roundId, questions } };
}

function normalizeQuestion(value, index, seenQuestions, errors) {
  const prefix = `questions[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }
  const id = cleanId(value.id, `${prefix}.id`, errors);
  if (id && seenQuestions.has(id)) errors.push(`${prefix}.id duplicates ${id}`);
  if (id) seenQuestions.add(id);
  const header = cleanText(value.header, `${prefix}.header`, 1, 40, errors);
  const question = cleanText(value.question, `${prefix}.question`, 1, 500, errors);
  const selectionMode = value.selection_mode === "multiple" ? "multiple" : value.selection_mode === "single" ? "single" : null;
  if (!selectionMode) errors.push(`${prefix}.selection_mode must be single or multiple`);
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > 5) {
    errors.push(`${prefix}.options must contain 2 to 5 choices`);
  }
  const seenOptions = new Set();
  const options = Array.isArray(value.options)
    ? value.options.slice(0, 5).map((option, optionIndex) => normalizeOption(option, prefix, optionIndex, seenOptions, errors))
    : [];
  const allowOther = value.allow_other !== false;
  const required = value.required !== false;
  const defaultMin = required ? 1 : 0;
  const minSelections = integerOr(value.min_selections, defaultMin);
  const maxSelections = selectionMode === "multiple"
    ? options.length + (allowOther ? 1 : 0)
    : integerOr(value.max_selections, 1);
  if (minSelections < 0 || minSelections > options.length + (allowOther ? 1 : 0)) errors.push(`${prefix}.min_selections is out of range`);
  if (maxSelections < 1 || maxSelections > options.length + (allowOther ? 1 : 0)) errors.push(`${prefix}.max_selections is out of range`);
  if (minSelections > maxSelections) errors.push(`${prefix}.min_selections cannot exceed max_selections`);
  if (selectionMode === "single" && (minSelections > 1 || maxSelections !== 1)) errors.push(`${prefix} single-select questions require max_selections 1`);
  return { id, header, question, selection_mode: selectionMode, options, allow_other: allowOther, required, min_selections: minSelections, max_selections: maxSelections };
}

function normalizeOption(value, prefix, index, seen, errors) {
  const optionPrefix = `${prefix}.options[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${optionPrefix} must be an object`);
    return null;
  }
  const id = cleanId(value.id, `${optionPrefix}.id`, errors);
  if (id && seen.has(id)) errors.push(`${optionPrefix}.id duplicates ${id}`);
  if (id) seen.add(id);
  return {
    id,
    label: cleanText(value.label, `${optionPrefix}.label`, 1, 100, errors),
    description: cleanText(value.description, `${optionPrefix}.description`, 1, 300, errors),
  };
}

function validateAnswers(input, answers) {
  const errors = [];
  if (!isRecord(answers)) return { ok: false, errors: ["answers must be an object"] };
  const normalized = {};
  for (const question of input.questions) {
    const answer = isRecord(answers[question.id]) ? answers[question.id] : {};
    const selected = Array.isArray(answer.selected_option_ids)
      ? [...new Set(answer.selected_option_ids.filter((id) => typeof id === "string"))]
      : [];
    const allowed = new Set(question.options.map((option) => option.id));
    const invalid = selected.filter((id) => !allowed.has(id));
    if (invalid.length) errors.push(`${question.id} contains unknown choices: ${invalid.join(", ")}`);
    const otherText = typeof answer.other_text === "string" ? answer.other_text.trim().slice(0, 4000) : "";
    if (otherText && !question.allow_other) errors.push(`${question.id} does not allow Other input`);
    const count = selected.length + (otherText ? 1 : 0);
    const skippedOptional = !question.required && count === 0;
    if (!skippedOptional && count < question.min_selections) errors.push(`${question.id} needs at least ${question.min_selections} answer${question.min_selections === 1 ? "" : "s"}`);
    if (count > question.max_selections) errors.push(`${question.id} allows at most ${question.max_selections} answer${question.max_selections === 1 ? "" : "s"}`);
    normalized[question.id] = { selected_option_ids: selected, other_text: otherText || null };
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: normalized };
}

function cleanId(value, label, errors) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    errors.push(`${label} must be a stable identifier using letters, numbers, dots, dashes, or underscores`);
    return "";
  }
  return value;
}

function cleanText(value, label, min, max, errors) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max) errors.push(`${label} must be ${min} to ${max} characters`);
  return text.slice(0, max);
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

module.exports = { validateAnswers, validateAskInput };
