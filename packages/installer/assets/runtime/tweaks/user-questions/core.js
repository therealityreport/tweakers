"use strict";

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const RESUME_TOKEN_RE = /^[a-zA-Z0-9._~-]{16,512}$/;
const HTML_RE = /<[^>]*>|[<>]/;

const CONTRACT_LIMITS = Object.freeze({
  ask_payload_bytes: 64 * 1024,
  questions: 6,
  options_per_question: 5,
  header_characters: 40,
  question_characters: 500,
  label_characters: 100,
  description_characters: 300,
  details_characters: 2000,
  tradeoff_items: 5,
  tradeoff_item_characters: 300,
  other_text_characters: 4000,
  resume_token_characters: 512,
});

const ANSWER_STATUSES = Object.freeze(["unanswered", "answered", "skipped"]);
const RESULT_STATUSES = Object.freeze(["submitted", "cancelled", "display_failed"]);
const FAILURE_STAGES = Object.freeze([
  "tool_discovery",
  "carrier_attach",
  "owned_mount",
  "generic_mount",
  "host_empty_response",
]);

const DECISION_GUIDANCE = Object.freeze({
  scope: "current_task",
  authority: "preference",
  semantics: "preference-not-policy",
  on_conflict: "Explain the conflict, the pros and cons, and what must be given up. Ask before materially changing the selected direction.",
});

const ASK_FIELDS = new Set(["round_id", "resume_token", "questions"]);
const QUESTION_FIELDS = new Set([
  "id", "header", "question", "selection_mode", "options", "allow_other",
  "required", "min_selections", "max_selections",
]);
const OPTION_FIELDS = new Set([
  "id", "label", "description", "details", "pros", "cons", "gives_up", "recommended",
]);
const ANSWER_FIELDS = new Set(["status", "selected_option_ids", "other_text"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAskInput(value) {
  const errors = [];
  if (!isRecord(value)) return { ok: false, errors: ["input must be an object"] };
  rejectUnsupportedFields(value, ASK_FIELDS, "input", errors);
  const payloadBytes = serializedBytes(value);
  if (payloadBytes === null) errors.push("input must be JSON serializable");
  else if (payloadBytes > CONTRACT_LIMITS.ask_payload_bytes) {
    errors.push(`input must be at most ${CONTRACT_LIMITS.ask_payload_bytes} UTF-8 bytes`);
  }
  const roundId = cleanId(value.round_id, "round_id", errors);
  const resumeToken = normalizeResumeToken(value.resume_token, "resume_token", errors);
  if (!Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > CONTRACT_LIMITS.questions) {
    errors.push(`questions must contain 1 to ${CONTRACT_LIMITS.questions} questions`);
  }
  const seenQuestions = new Set();
  const questions = Array.isArray(value.questions)
    ? value.questions.slice(0, CONTRACT_LIMITS.questions).map((question, index) => normalizeQuestion(question, index, seenQuestions, errors))
    : [];
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      round_id: roundId,
      ...(resumeToken ? { resume_token: resumeToken } : {}),
      questions,
    },
  };
}

function normalizeQuestion(value, index, seenQuestions, errors) {
  const prefix = `questions[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object`);
    return null;
  }
  rejectUnsupportedFields(value, QUESTION_FIELDS, prefix, errors);
  const id = cleanId(value.id, `${prefix}.id`, errors);
  if (id && seenQuestions.has(id)) errors.push(`${prefix}.id duplicates ${id}`);
  if (id) seenQuestions.add(id);
  const header = cleanText(value.header, `${prefix}.header`, 1, CONTRACT_LIMITS.header_characters, errors);
  const question = cleanText(value.question, `${prefix}.question`, 1, CONTRACT_LIMITS.question_characters, errors);
  const selectionMode = value.selection_mode === "multiple" ? "multiple" : value.selection_mode === "single" ? "single" : null;
  if (!selectionMode) errors.push(`${prefix}.selection_mode must be single or multiple`);
  if (!Array.isArray(value.options) || value.options.length < 2 || value.options.length > CONTRACT_LIMITS.options_per_question) {
    errors.push(`${prefix}.options must contain 2 to ${CONTRACT_LIMITS.options_per_question} choices`);
  }
  const seenOptions = new Set();
  const options = Array.isArray(value.options)
    ? value.options.slice(0, CONTRACT_LIMITS.options_per_question).map((option, optionIndex) => normalizeOption(option, prefix, optionIndex, seenOptions, errors))
    : [];
  const allowOther = booleanOrDefault(value.allow_other, true, `${prefix}.allow_other`, errors);
  const required = booleanOrDefault(value.required, true, `${prefix}.required`, errors);
  validateOptionalInteger(value.min_selections, `${prefix}.min_selections`, errors);
  validateOptionalInteger(value.max_selections, `${prefix}.max_selections`, errors);
  const defaultMin = required ? 1 : 0;
  const minSelections = integerOr(value.min_selections, defaultMin);
  const availableSelections = options.length + (allowOther ? 1 : 0);
  const maxSelections = selectionMode === "multiple"
    ? integerOr(value.max_selections, availableSelections)
    : integerOr(value.max_selections, 1);
  if (minSelections < 0 || minSelections > options.length + (allowOther ? 1 : 0)) errors.push(`${prefix}.min_selections is out of range`);
  if (maxSelections < 1 || maxSelections > options.length + (allowOther ? 1 : 0)) errors.push(`${prefix}.max_selections is out of range`);
  if (minSelections > maxSelections) errors.push(`${prefix}.min_selections cannot exceed max_selections`);
  if (selectionMode === "single" && (minSelections > 1 || maxSelections !== 1)) errors.push(`${prefix} single-select questions require max_selections 1`);
  return {
    id,
    header,
    question,
    selection_mode: selectionMode,
    options,
    allow_other: allowOther,
    required,
    min_selections: minSelections,
    max_selections: maxSelections,
  };
}

function normalizeOption(value, prefix, index, seen, errors) {
  const optionPrefix = `${prefix}.options[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${optionPrefix} must be an object`);
    return null;
  }
  rejectUnsupportedFields(value, OPTION_FIELDS, optionPrefix, errors);
  const id = cleanId(value.id, `${optionPrefix}.id`, errors);
  if (id && seen.has(id)) errors.push(`${optionPrefix}.id duplicates ${id}`);
  if (id) seen.add(id);
  if (value.recommended !== undefined && typeof value.recommended !== "boolean") {
    errors.push(`${optionPrefix}.recommended must be a boolean`);
  }
  return {
    id,
    label: cleanText(value.label, `${optionPrefix}.label`, 1, CONTRACT_LIMITS.label_characters, errors),
    description: cleanText(value.description, `${optionPrefix}.description`, 1, CONTRACT_LIMITS.description_characters, errors),
    details: optionalText(value.details, `${optionPrefix}.details`, CONTRACT_LIMITS.details_characters, errors),
    pros: cleanTextArray(value.pros, `${optionPrefix}.pros`, errors),
    cons: cleanTextArray(value.cons, `${optionPrefix}.cons`, errors),
    gives_up: cleanTextArray(value.gives_up, `${optionPrefix}.gives_up`, errors),
    recommended: value.recommended === true,
  };
}

// Compatibility API: accepted legacy callers receive the original answer shape.
function validateAnswers(input, answers) {
  const validation = validateAnswerStates(input, answers, { allow_unanswered: false });
  if (!validation.ok) return validation;
  const legacy = {};
  for (const question of input.questions) {
    const answer = validation.value[question.id];
    legacy[question.id] = {
      selected_option_ids: [...answer.selected_option_ids],
      other_text: answer.other_text,
    };
  }
  return { ok: true, value: legacy };
}

function validateAnswerStates(input, answers, options = {}) {
  const errors = [];
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, errors: ["input must be a validated ask input"] };
  }
  if (!isRecord(answers)) return { ok: false, errors: ["answers must be an object"] };
  const knownQuestions = new Set(input.questions.map((question) => question.id));
  for (const id of Object.keys(answers)) {
    if (!knownQuestions.has(id)) errors.push(`answers contains unknown question ${id}`);
  }
  const normalized = {};
  for (const question of input.questions) {
    const supplied = Object.prototype.hasOwnProperty.call(answers, question.id);
    const raw = supplied && isRecord(answers[question.id]) ? answers[question.id] : {};
    if (supplied && !isRecord(answers[question.id])) errors.push(`${question.id} answer must be an object`);
    rejectUnsupportedFields(raw, ANSWER_FIELDS, `${question.id} answer`, errors);
    const selected = normalizeSelectedIds(raw.selected_option_ids, question.id, errors);
    const allowed = new Set(question.options.map((option) => option.id));
    const invalid = selected.filter((id) => !allowed.has(id));
    if (invalid.length) errors.push(`${question.id} contains unknown choices: ${invalid.join(", ")}`);
    const otherText = normalizeOtherText(raw.other_text, question, errors);
    const count = selected.length + (otherText ? 1 : 0);
    const explicitStatus = raw.status;
    if (explicitStatus !== undefined && !ANSWER_STATUSES.includes(explicitStatus)) {
      errors.push(`${question.id} status must be unanswered, answered, or skipped`);
    }
    let status = ANSWER_STATUSES.includes(explicitStatus)
      ? explicitStatus
      : count > 0
        ? "answered"
        : (!question.required ? "skipped" : "unanswered");
    if (status === "skipped" && count > 0) errors.push(`${question.id} cannot be skipped with selected choices or Other text`);
    if (status === "unanswered" && count > 0) errors.push(`${question.id} cannot be unanswered with selected choices or Other text`);
    if (status === "answered") {
      if (count < question.min_selections) errors.push(`${question.id} needs at least ${question.min_selections} answer${question.min_selections === 1 ? "" : "s"}`);
      if (count > question.max_selections) errors.push(`${question.id} allows at most ${question.max_selections} answer${question.max_selections === 1 ? "" : "s"}`);
    }
    if (status === "unanswered" && options.allow_unanswered !== true) {
      errors.push(`${question.id} needs at least ${question.min_selections} answer${question.min_selections === 1 ? "" : "s"}`);
    }
    if (status !== "answered") {
      normalized[question.id] = { status, selected_option_ids: [], other_text: null };
    } else {
      normalized[question.id] = { status, selected_option_ids: selected, other_text: otherText };
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: normalized };
}

function normalizeResult(input, result) {
  if (!isRecord(input) || !Array.isArray(input.questions)) {
    return { ok: false, errors: ["input must be a validated ask input"] };
  }
  if (!isRecord(result)) return { ok: false, errors: ["result must be an object"] };
  const inferredStatus = result.status
    || (result.cancelled === false ? "submitted" : result.failure_stage ? "display_failed" : "cancelled");
  if (!RESULT_STATUSES.includes(inferredStatus)) {
    return { ok: false, errors: ["result status must be submitted, cancelled, or display_failed"] };
  }
  if (inferredStatus === "submitted") return normalizeSubmittedResult(input, result);
  if (inferredStatus === "display_failed") return normalizeDisplayFailedResult(input, result);
  return normalizeCancelledResult(input, result);
}

function normalizeSubmittedResult(input, result) {
  const validation = validateAnswerStates(input, result.answers, { allow_unanswered: false });
  if (!validation.ok) return validation;
  const skippedQuestionIds = input.questions
    .filter((question) => validation.value[question.id].status === "skipped")
    .map((question) => question.id);
  return {
    ok: true,
    value: {
      round_id: input.round_id,
      status: "submitted",
      cancelled: false,
      cancel_reason: null,
      answers: validation.value,
      skipped_question_ids: skippedQuestionIds,
      decision_guidance: decisionGuidance(),
      draft: { resumable: false, resume_token: null },
    },
  };
}

function normalizeCancelledResult(input, result) {
  if (result.answers !== undefined && (!isRecord(result.answers) || Object.keys(result.answers).length > 0)) {
    return { ok: false, errors: ["cancelled results must not include partial answers"] };
  }
  const errors = [];
  const cancelReason = cleanText(result.cancel_reason, "cancel_reason", 1, 200, errors, { allow_html: false });
  const tokenValue = result.resume_token !== undefined ? result.resume_token : result.draft?.resume_token;
  const resumeToken = normalizeResumeToken(tokenValue, "resume_token", errors);
  const resumable = result.resumable === true || result.draft?.resumable === true || Boolean(resumeToken);
  if (resumable && !resumeToken) errors.push("resumable cancelled results require a resume_token");
  if (!resumable && resumeToken) errors.push("resume_token requires a resumable cancelled result");
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      round_id: input.round_id,
      status: "cancelled",
      cancelled: true,
      cancel_reason: cancelReason,
      answers: {},
      skipped_question_ids: [],
      decision_guidance: decisionGuidance(),
      draft: { resumable, resume_token: resumeToken },
    },
  };
}

function normalizeDisplayFailedResult(input, result) {
  if (!FAILURE_STAGES.includes(result.failure_stage)) {
    return { ok: false, errors: [`failure_stage must be one of ${FAILURE_STAGES.join(", ")}`] };
  }
  if (result.answers !== undefined && (!isRecord(result.answers) || Object.keys(result.answers).length > 0)) {
    return { ok: false, errors: ["display_failed results must not include answers"] };
  }
  return {
    ok: true,
    value: {
      round_id: input.round_id,
      status: "display_failed",
      cancelled: true,
      cancel_reason: "question_ui_not_shown",
      answers: {},
      retryable: true,
      failure_stage: result.failure_stage,
    },
  };
}

function serializeResult(input, result) {
  const normalized = normalizeResult(input, result);
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    value: {
      structuredContent: normalized.value,
      text: JSON.stringify(normalized.value),
    },
  };
}

function decisionGuidance() {
  return { ...DECISION_GUIDANCE };
}

function normalizeSelectedIds(value, questionId, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${questionId} selected_option_ids must be an array`);
    return [];
  }
  const selected = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string") {
      errors.push(`${questionId} selected_option_ids must contain only identifiers`);
      continue;
    }
    if (seen.has(id)) errors.push(`${questionId} contains duplicate choice ${id}`);
    else {
      seen.add(id);
      selected.push(id);
    }
  }
  return selected;
}

function normalizeOtherText(value, question, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push(`${question.id} other_text must be a string or null`);
    return null;
  }
  const text = value.trim();
  if (!text) {
    errors.push(`${question.id} Other answer must not be blank`);
    return null;
  }
  if (text.length > CONTRACT_LIMITS.other_text_characters) {
    errors.push(`${question.id} Other answer must be at most ${CONTRACT_LIMITS.other_text_characters} characters`);
  }
  if (HTML_RE.test(text)) errors.push(`${question.id} Other answer must be plain text without HTML`);
  if (!question.allow_other) errors.push(`${question.id} does not allow Other input`);
  return text.slice(0, CONTRACT_LIMITS.other_text_characters);
}

function cleanId(value, label, errors) {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    errors.push(`${label} must be a stable identifier using letters, numbers, dots, dashes, or underscores`);
    return "";
  }
  return value;
}

function cleanText(value, label, min, max, errors, options = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max) errors.push(`${label} must be ${min} to ${max} characters`);
  if (text && options.allow_html !== true && HTML_RE.test(text)) errors.push(`${label} must be plain text without HTML`);
  return text.slice(0, max);
}

function optionalText(value, label, max, errors) {
  if (value === undefined || value === null) return null;
  return cleanText(value, label, 1, max, errors);
}

function cleanTextArray(value, label, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > CONTRACT_LIMITS.tradeoff_items) {
    errors.push(`${label} must be an array of at most ${CONTRACT_LIMITS.tradeoff_items} strings`);
    return [];
  }
  return value.map((item, index) => cleanText(
    item,
    `${label}[${index}]`,
    1,
    CONTRACT_LIMITS.tradeoff_item_characters,
    errors,
  ));
}

function normalizeResumeToken(value, label, errors) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !RESUME_TOKEN_RE.test(value)) {
    errors.push(`${label} must be an opaque 16 to ${CONTRACT_LIMITS.resume_token_characters} character token`);
    return null;
  }
  return value;
}

function rejectUnsupportedFields(value, allowed, label, errors) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not supported`);
  }
}

function booleanOrDefault(value, fallback, label, errors) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    errors.push(`${label} must be a boolean`);
    return fallback;
  }
  return value;
}

function validateOptionalInteger(value, label, errors) {
  if (value !== undefined && !Number.isInteger(value)) errors.push(`${label} must be an integer`);
}

function serializedBytes(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
  } catch {
    return null;
  }
}

function integerOr(value, fallback) {
  return Number.isInteger(value) ? value : fallback;
}

module.exports = {
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
};
