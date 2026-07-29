"use strict";

const { validateAnswerStates } = require("./core");

const ROUND_PHASES = Object.freeze([
  "claiming",
  "question",
  "review",
  "submitting",
  "cancelled",
  "submitted",
]);

const ACTION_FIELDS = Object.freeze({
  claim: new Set(["type", "revision"]),
  resume: new Set(["type", "revision", "draft"]),
  answer: new Set(["type", "revision", "question_id", "selected_option_ids"]),
  other: new Set(["type", "revision", "question_id", "other_text", "selected"]),
  details: new Set(["type", "revision", "question_id", "option_id", "expanded"]),
  back: new Set(["type", "revision"]),
  next: new Set(["type", "revision"]),
  skip: new Set(["type", "revision"]),
  review: new Set(["type", "revision"]),
  edit: new Set(["type", "revision", "question_id"]),
  submit: new Set(["type", "revision"]),
  cancel_save: new Set(["type", "revision"]),
  discard: new Set(["type", "revision"]),
});

const ROUND_STATE_FIELDS = new Set([
  "phase",
  "current_question_id",
  "answers",
  "other_selected_question_ids",
  "expanded_detail_ids",
  "validation_errors",
  "revision",
]);

function createRoundState(input) {
  const answers = {};
  for (const question of input.questions) {
    answers[question.id] = emptyAnswer();
  }
  return {
    phase: "claiming",
    current_question_id: null,
    answers,
    other_selected_question_ids: [],
    expanded_detail_ids: [],
    validation_errors: {},
    revision: 0,
  };
}

function reduceRoundState(input, state, action) {
  const stateValidation = validateStateShape(input, state);
  if (!stateValidation.ok) return stateValidation;
  if (!isRecord(action) || typeof action.type !== "string") {
    return failure("action must be an object with a type");
  }
  const allowedFields = ACTION_FIELDS[action.type];
  if (!allowedFields) return failure(`unknown action ${action.type}`);
  for (const key of Object.keys(action)) {
    if (!allowedFields.has(key)) return failure(`${action.type} action field ${key} is not supported`);
  }
  if (!Number.isInteger(action.revision) || action.revision !== state.revision) {
    return failure(`stale revision: expected ${state.revision}`);
  }

  const next = clone(state);
  if (!Array.isArray(next.other_selected_question_ids)) {
    next.other_selected_question_ids = input.questions
      .filter((question) => next.answers[question.id]?.other_text !== null)
      .map((question) => question.id);
  }
  const errors = transition(input, next, action);
  if (errors.length) return { ok: false, errors };
  next.revision = state.revision + 1;
  return { ok: true, value: next };
}

function transition(input, next, action) {
  switch (action.type) {
    case "claim":
      if (next.phase !== "claiming") return [`claim is not allowed during ${next.phase}`];
      next.phase = "question";
      next.current_question_id = input.questions[0].id;
      return [];

    case "resume":
      return resumeTransition(input, next, action);

    case "answer":
      return answerTransition(input, next, action);

    case "other":
      return otherTransition(input, next, action);

    case "details":
      return detailsTransition(input, next, action);

    case "back":
      return backTransition(input, next);

    case "next":
      return nextTransition(input, next);

    case "skip":
      return skipTransition(input, next);

    case "review":
      return reviewTransition(input, next);

    case "edit":
      return editTransition(input, next, action);

    case "submit":
      return submitTransition(input, next);

    case "cancel_save":
      if (next.phase !== "question" && next.phase !== "review") {
        return [`cancel_save is not allowed during ${next.phase}`];
      }
      next.phase = "cancelled";
      next.validation_errors = {};
      return [];

    case "discard":
      if (next.phase === "submitted" || next.phase === "submitting") {
        return [`discard is not allowed during ${next.phase}`];
      }
      Object.assign(next, createRoundState(input));
      return [];

    default:
      return [`unknown action ${action.type}`];
  }
}

function resumeTransition(input, next, action) {
  if (next.phase !== "claiming" && next.phase !== "cancelled") {
    return [`resume is not allowed during ${next.phase}`];
  }
  if (action.draft !== undefined) {
    const draftValidation = validateStateShape(input, action.draft, { resumable: true });
    if (!draftValidation.ok) return draftValidation.errors;
    next.answers = clone(action.draft.answers);
    next.other_selected_question_ids = Array.isArray(action.draft.other_selected_question_ids)
      ? [...action.draft.other_selected_question_ids]
      : input.questions
          .filter((question) => action.draft.answers[question.id]?.other_text !== null)
          .map((question) => question.id);
    next.expanded_detail_ids = [...action.draft.expanded_detail_ids];
    next.validation_errors = {};
    next.current_question_id = action.draft.current_question_id;
    if (action.draft.phase === "review" || (action.draft.phase === "cancelled" && action.draft.current_question_id === null)) {
      next.phase = "review";
      next.current_question_id = null;
    } else {
      next.phase = "question";
      next.current_question_id ||= firstUnansweredQuestionId(input, next.answers) || input.questions[0].id;
    }
    return [];
  }
  if (next.phase !== "cancelled") return ["resume requires a saved draft"];
  if (next.current_question_id === null) next.phase = "review";
  else next.phase = "question";
  next.validation_errors = {};
  return [];
}

function answerTransition(input, next, action) {
  const question = activeQuestion(input, next, action.question_id, "answer");
  if (!question.ok) return question.errors;
  if (!Array.isArray(action.selected_option_ids)) return ["answer selected_option_ids must be an array"];
  const candidate = clone(next.answers);
  if (question.value.selection_mode === "single" && action.selected_option_ids.length > 0) {
    setOtherSelected(next, question.value.id, false);
    candidate[question.value.id].other_text = null;
  }
  candidate[question.value.id] = {
    ...candidate[question.value.id],
    status: action.selected_option_ids.length || candidate[question.value.id].other_text ? "answered" : "unanswered",
    selected_option_ids: [...action.selected_option_ids],
  };
  const validation = validateAnswerStates(input, candidate, { allow_unanswered: true });
  if (!validation.ok) return validation.errors;
  next.answers = validation.value;
  delete next.validation_errors[question.value.id];
  return [];
}

function otherTransition(input, next, action) {
  const question = activeQuestion(input, next, action.question_id, "other");
  if (!question.ok) return question.errors;
  if (!question.value.allow_other) return [`${question.value.id} does not allow Other input`];
  if (action.selected !== undefined && typeof action.selected !== "boolean") {
    return ["other selected must be a boolean"];
  }
  if (action.other_text !== undefined && action.other_text !== null && typeof action.other_text !== "string") {
    return ["other other_text must be a string or null"];
  }
  const selected = action.selected !== undefined
    ? action.selected
    : action.other_text !== null && action.other_text !== undefined;
  if (!selected && typeof action.other_text === "string" && action.other_text.trim() !== "") {
    return ["deselected Other input cannot include text"];
  }
  const normalizedText = selected && typeof action.other_text === "string" && action.other_text.trim() !== ""
    ? action.other_text
    : null;
  const candidate = clone(next.answers);
  const selectedOptionIds = selected && question.value.selection_mode === "single"
    ? []
    : candidate[question.value.id].selected_option_ids;
  candidate[question.value.id] = {
    ...candidate[question.value.id],
    status: normalizedText || selectedOptionIds.length ? "answered" : "unanswered",
    selected_option_ids: selectedOptionIds,
    other_text: normalizedText,
  };
  const validation = validateAnswerStates(input, candidate, { allow_unanswered: true });
  if (!validation.ok) return validation.errors;
  next.answers = validation.value;
  setOtherSelected(next, question.value.id, selected);
  delete next.validation_errors[question.value.id];
  return [];
}

function detailsTransition(input, next, action) {
  const question = activeQuestion(input, next, action.question_id, "details");
  if (!question.ok) return question.errors;
  if (typeof action.option_id !== "string" || !question.value.options.some((option) => option.id === action.option_id)) {
    return [`${question.value.id} contains unknown detail option ${String(action.option_id)}`];
  }
  if (typeof action.expanded !== "boolean") return ["details expanded must be a boolean"];
  const detailId = `${question.value.id}:${action.option_id}`;
  const expanded = new Set(next.expanded_detail_ids);
  if (action.expanded) expanded.add(detailId);
  else expanded.delete(detailId);
  next.expanded_detail_ids = [...expanded].sort();
  return [];
}

function backTransition(input, next) {
  if (next.phase === "review") {
    next.phase = "question";
    next.current_question_id = input.questions.at(-1).id;
    return [];
  }
  if (next.phase !== "question") return [`back is not allowed during ${next.phase}`];
  const index = questionIndex(input, next.current_question_id);
  if (index <= 0) return ["back is not available on the first question"];
  next.current_question_id = input.questions[index - 1].id;
  next.validation_errors = {};
  return [];
}

function nextTransition(input, next) {
  if (next.phase !== "question") return [`next is not allowed during ${next.phase}`];
  const current = next.answers[next.current_question_id];
  if (isOtherSelected(next, next.current_question_id) && !current?.other_text) {
    setValidationError(next, next.current_question_id, "Enter an Other response before continuing.");
    return [];
  }
  if (!current || current.status === "unanswered") {
    setValidationError(next, next.current_question_id, "Choose an answer or Skip before continuing.");
    return [];
  }
  const index = questionIndex(input, next.current_question_id);
  if (index < input.questions.length - 1) {
    next.current_question_id = input.questions[index + 1].id;
    next.validation_errors = {};
    return [];
  }
  return enterReview(input, next);
}

function skipTransition(input, next) {
  if (next.phase !== "question") return [`skip is not allowed during ${next.phase}`];
  next.answers[next.current_question_id] = {
    status: "skipped",
    selected_option_ids: [],
    other_text: null,
  };
  setOtherSelected(next, next.current_question_id, false);
  delete next.validation_errors[next.current_question_id];
  return [];
}

function reviewTransition(input, next) {
  if (next.phase !== "question") return [`review is not allowed during ${next.phase}`];
  return enterReview(input, next);
}

function enterReview(input, next) {
  const blankOther = next.other_selected_question_ids
    .find((questionId) => !next.answers[questionId]?.other_text);
  if (blankOther) {
    next.phase = "question";
    next.current_question_id = blankOther;
    setValidationError(next, blankOther, "Enter an Other response before continuing.");
    return [];
  }
  const validation = validateAnswerStates(input, next.answers, { allow_unanswered: false });
  if (!validation.ok) {
    const firstInvalidQuestion = setAnswerValidationErrors(input, next, validation.errors);
    if (!firstInvalidQuestion) return validation.errors;
    next.phase = "question";
    next.current_question_id = firstInvalidQuestion;
    return [];
  }
  next.answers = validation.value;
  next.phase = "review";
  next.current_question_id = null;
  next.validation_errors = {};
  return [];
}

function editTransition(input, next, action) {
  if (next.phase !== "review") return [`edit is not allowed during ${next.phase}`];
  if (questionIndex(input, action.question_id) < 0) return [`edit contains unknown question ${String(action.question_id)}`];
  next.phase = "question";
  next.current_question_id = action.question_id;
  next.validation_errors = {};
  return [];
}

function submitTransition(input, next) {
  if (next.phase !== "review") return [`submit is not allowed during ${next.phase}`];
  const validation = validateAnswerStates(input, next.answers, { allow_unanswered: false });
  if (!validation.ok) return validation.errors;
  next.answers = validation.value;
  next.phase = "submitted";
  next.current_question_id = null;
  next.validation_errors = {};
  return [];
}

function activeQuestion(input, state, questionId, actionName) {
  if (state.phase !== "question") return failure(`${actionName} is not allowed during ${state.phase}`);
  if (questionId !== state.current_question_id) return failure(`${actionName} must target the current question`);
  const question = input.questions.find((candidate) => candidate.id === questionId);
  return question ? { ok: true, value: question } : failure(`${actionName} contains unknown question ${String(questionId)}`);
}

function validateStateShape(input, state, options = {}) {
  const errors = [];
  if (!isRecord(state)) return failure("round state must be an object");
  for (const key of Object.keys(state)) {
    if (!ROUND_STATE_FIELDS.has(key)) errors.push(`round state field ${key} is not supported`);
  }
  if (!ROUND_PHASES.includes(state.phase)) errors.push("round state phase is invalid");
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push("round state revision must be a non-negative integer");
  if (!Array.isArray(state.expanded_detail_ids) || state.expanded_detail_ids.some((id) => typeof id !== "string")) {
    errors.push("expanded_detail_ids must be an array of strings");
  } else {
    const validDetails = new Set(input.questions.flatMap((question) => question.options.map((option) => `${question.id}:${option.id}`)));
    const seen = new Set();
    for (const id of state.expanded_detail_ids) {
      if (!validDetails.has(id)) errors.push(`expanded_detail_ids contains unknown detail ${id}`);
      if (seen.has(id)) errors.push(`expanded_detail_ids contains duplicate detail ${id}`);
      seen.add(id);
    }
  }
  if (state.other_selected_question_ids !== undefined) {
    if (
      !Array.isArray(state.other_selected_question_ids)
      || state.other_selected_question_ids.some((id) => typeof id !== "string")
    ) {
      errors.push("other_selected_question_ids must be an array of strings");
    } else {
      const seenOther = new Set();
      for (const questionId of state.other_selected_question_ids) {
        const question = input.questions.find((candidate) => candidate.id === questionId);
        if (!question || !question.allow_other) errors.push(`other_selected_question_ids contains invalid question ${questionId}`);
        if (seenOther.has(questionId)) errors.push(`other_selected_question_ids contains duplicate question ${questionId}`);
        seenOther.add(questionId);
      }
    }
  }
  if (!isRecord(state.validation_errors)) errors.push("validation_errors must be an object");
  else {
    const knownQuestions = new Set(input.questions.map((question) => question.id));
    for (const [questionId, message] of Object.entries(state.validation_errors)) {
      if (!knownQuestions.has(questionId)) errors.push(`validation_errors contains unknown question ${questionId}`);
      if (typeof message !== "string" || message.trim().length === 0 || message.length > 500) {
        errors.push(`validation_errors.${questionId} must be a non-empty message at most 500 characters`);
      }
    }
  }
  const answers = validateAnswerStates(input, state.answers, { allow_unanswered: true });
  if (!answers.ok) errors.push(...answers.errors);
  if (state.current_question_id !== null && questionIndex(input, state.current_question_id) < 0) {
    errors.push(`current_question_id contains unknown question ${String(state.current_question_id)}`);
  }
  if (state.phase === "question" && state.current_question_id === null) errors.push("question phase requires current_question_id");
  if (["claiming", "review", "submitting", "submitted"].includes(state.phase) && state.current_question_id !== null) {
    errors.push(`${state.phase} phase requires current_question_id null`);
  }
  if (options.resumable === true && !["question", "review", "cancelled"].includes(state.phase)) {
    errors.push(`draft phase ${state.phase} is not resumable`);
  }
  const selectedOther = Array.isArray(state.other_selected_question_ids)
    ? new Set(state.other_selected_question_ids)
    : null;
  if (selectedOther) {
    for (const question of input.questions) {
      if (state.answers?.[question.id]?.other_text !== null && !selectedOther.has(question.id)) {
        errors.push(`${question.id} Other text requires an explicit Other selection`);
      }
    }
    if (["review", "submitting", "submitted"].includes(state.phase)) {
      for (const questionId of selectedOther) {
        if (state.answers?.[questionId]?.status === "skipped") errors.push(`${questionId} cannot be skipped while Other is selected`);
        if (!state.answers?.[questionId]?.other_text) errors.push(`${questionId} Other answer must not be blank`);
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: state };
}

function isOtherSelected(state, questionId) {
  return Array.isArray(state.other_selected_question_ids)
    && state.other_selected_question_ids.includes(questionId);
}

function setOtherSelected(state, questionId, selected) {
  const values = new Set(Array.isArray(state.other_selected_question_ids) ? state.other_selected_question_ids : []);
  if (selected) values.add(questionId);
  else values.delete(questionId);
  state.other_selected_question_ids = [...values];
}

function setValidationError(state, questionId, message) {
  state.validation_errors = {
    ...state.validation_errors,
    [questionId]: message,
  };
}

function setAnswerValidationErrors(input, state, errors) {
  const byQuestion = {};
  for (const question of input.questions) {
    const matches = errors.filter((message) => message.startsWith(`${question.id} `));
    if (matches.length) byQuestion[question.id] = matches.join(". ");
  }
  state.validation_errors = byQuestion;
  return input.questions.find((question) => byQuestion[question.id])?.id || null;
}

function firstUnansweredQuestionId(input, answers) {
  return input.questions.find((question) => answers[question.id]?.status === "unanswered")?.id || null;
}

function questionIndex(input, questionId) {
  return input.questions.findIndex((question) => question.id === questionId);
}

function emptyAnswer() {
  return { status: "unanswered", selected_option_ids: [], other_text: null };
}

function failure(error) {
  return { ok: false, errors: [error] };
}

function clone(value) {
  return structuredClone(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  ROUND_PHASES,
  createRoundState,
  reduceRoundState,
};
