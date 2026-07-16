#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { validateAnswers, validateAskInput } = require("./core");

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const OTHER_CHOICE_TITLE = "Other";
const INLINE_OTHER_HELP = "Select Other to show this field, then type your answer.";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]);
const pendingClientRequests = new Map();
const activeToolCalls = new Map();
let clientCapabilities = {};
let negotiatedProtocolVersion = LATEST_PROTOCOL_VERSION;
let buffer = "";
let shuttingDown = false;

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handleMessage(line);
  }
});

async function handleMessage(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }

  if (!message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
    const pending = takePendingClientRequest(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new Error(message.error.message || "Native question popup failed"));
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "notifications/cancelled") {
    const requestId = String(message.params?.requestId);
    const activeToolCall = activeToolCalls.get(requestId);
    if (activeToolCall) {
      cancelToolCall(activeToolCall);
      return;
    }
    const pending = takePendingClientRequest(requestId);
    if (pending) {
      pending.toolCall.cancelled = true;
      pending.resolve({ action: "cancel" });
    }
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  try {
    if (message.method === "initialize") {
      const requestedProtocolVersion = message.params?.protocolVersion;
      if (typeof requestedProtocolVersion !== "string" || requestedProtocolVersion.trim() === "") {
        return replyError(message.id, -32602, "invalid params: protocolVersion must be a non-empty string");
      }
      negotiatedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocolVersion)
        ? requestedProtocolVersion
        : LATEST_PROTOCOL_VERSION;
      clientCapabilities = message.params?.capabilities || {};
      return reply(message.id, {
        protocolVersion: negotiatedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "user-questions", version: "0.4.7" },
      });
    }
    if (message.method === "ping") return reply(message.id, {});
    if (message.method === "tools/list") return reply(message.id, { tools: [toolDefinition()] });
    if (message.method === "tools/call") {
      if (message.params?.name !== "ask") throw new Error("unknown tool");
      const validation = validateAskInput(message.params?.arguments);
      if (!validation.ok) return reply(message.id, toolError(validation.errors.join("; ")));
      if (!supportsFormElicitation(clientCapabilities)) {
        return reply(message.id, toolError("this Codex host does not support native form elicitation"));
      }
      const toolCallId = String(message.id);
      const toolCall = { cancelled: false, pendingRequestId: null };
      activeToolCalls.set(toolCallId, toolCall);
      try {
        const result = await elicitAnswers(validation.value, toolCall);
        return reply(message.id, toolResult(result));
      } finally {
        activeToolCalls.delete(toolCallId);
      }
    }
    return replyError(message.id, -32601, "method not found");
  } catch (error) {
    return reply(message.id, toolError(String(error.message || error)));
  }
}

async function elicitAnswers(input, toolCall) {
  const legacy = negotiatedProtocolVersion === LEGACY_PROTOCOL_VERSION;
  const answers = {};
  for (const [questionIndex, question] of input.questions.entries()) {
    const result = await requestClient(
      "elicitation/create",
      buildSelectionElicitation(question, questionIndex, input.questions.length, legacy),
      toolCall,
    );
    if (toolCall.cancelled || result?.action !== "accept") {
      return cancelledResult(toolCall.cancelled ? "cancel" : result?.action);
    }

    const content = resultContent(result);
    const values = legacy && question.selection_mode === "multiple"
      ? legacyMultiValues(content, question, questionIndex)
      : answerValues(content[question.id]);
    const choseOther = values.includes("__other__");
    let otherText = null;
    if (choseOther) {
      const field = otherTextField(question, questionIndex, legacy);
      otherText = normalizedOtherText(content[field]);
      if (!otherText) {
        const otherResult = await requestClient(
          "elicitation/create",
          buildOtherElicitation(question, questionIndex, input.questions.length, legacy),
          toolCall,
        );
        if (toolCall.cancelled || otherResult?.action !== "accept") {
          return cancelledResult(toolCall.cancelled ? "cancel" : otherResult?.action);
        }

        otherText = normalizedOtherText(resultContent(otherResult)[field]);
        if (!otherText) {
          throw new Error(`${question.id} Other answer must contain 1 to 4000 non-whitespace characters`);
        }
      }
    }
    answers[question.id] = {
      selected_option_ids: values.filter((value) => value !== "__other__"),
      other_text: otherText,
    };
  }
  if (toolCall.cancelled) return cancelledResult("cancel");
  const validation = validateAnswers(input, answers);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return { cancelled: false, cancel_reason: null, answers: validation.value };
}

function buildSelectionElicitation(question, questionIndex, questionCount, legacy) {
  const properties = {};
  const required = [];
  const choices = question.options.map((option) => ({ const: option.id, title: option.label }));
  if (question.allow_other) choices.push({ const: "__other__", title: OTHER_CHOICE_TITLE });
  if (legacy && question.selection_mode === "multiple") {
    for (const [optionIndex, option] of question.options.entries()) {
      properties[legacyOptionField(questionIndex, optionIndex)] = {
        type: "boolean",
        title: `${question.header} — ${option.label}`,
        description: `${question.question} ${option.description}`,
        default: false,
      };
    }
    if (question.allow_other) {
      properties[legacyOtherSelectedField(questionIndex)] = {
        type: "boolean",
        title: `${question.header} — ${OTHER_CHOICE_TITLE}`,
        description: `${question.question} Select this to provide a different answer.`,
        default: false,
      };
    }
  } else if (legacy) {
    properties[question.id] = {
      type: "string",
      title: question.header,
      description: question.question,
      enum: choices.map((choice) => choice.const),
      enumNames: choices.map((choice) => choice.title),
    };
  } else {
    properties[question.id] = question.selection_mode === "multiple"
      ? {
          type: "array", title: question.header, description: question.question,
          minItems: question.min_selections, maxItems: question.max_selections,
          items: { anyOf: choices },
        }
      : {
          type: "string", title: question.header, description: question.question,
          oneOf: choices,
        };
  }
  if (question.allow_other) {
    properties[otherTextField(question, questionIndex, legacy)] = {
      type: "string",
      title: `${question.header} — Other response`,
      description: INLINE_OTHER_HELP,
      maxLength: 4000,
    };
  }
  if (question.required && !(legacy && question.selection_mode === "multiple")) required.push(question.id);
  return {
    ...(!legacy ? { mode: "form" } : {}),
    message: questionMessage(question, questionIndex, questionCount),
    requestedSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
  };
}

function buildOtherElicitation(question, questionIndex, questionCount, legacy) {
  const field = otherTextField(question, questionIndex, legacy);
  return {
    ...(!legacy ? { mode: "form" } : {}),
    message: questionMessage(question, questionIndex, questionCount, true),
    requestedSchema: {
      type: "object",
      properties: {
        [field]: {
          type: "string",
          title: `${question.header} — Other answer`,
          description: "Type your answer below, then press Continue. This text will be submitted as the Other response.",
          minLength: 1,
          maxLength: 4000,
        },
      },
      required: [field],
    },
  };
}

function questionMessage(question, questionIndex, questionCount, other = false) {
  const progress = `Question ${questionIndex + 1} of ${questionCount}`;
  return other
    ? `${progress}: Enter the Other answer for “${question.header}”.`
    : `${progress}: ${question.question}`;
}

function cancelledResult(action) {
  return {
    cancelled: true,
    cancel_reason: action === "decline"
      ? "The question round was declined or blocked by the current approval policy"
      : "The question round was cancelled",
    answers: {},
  };
}

function resultContent(result) {
  return result?.content && typeof result.content === "object" && !Array.isArray(result.content)
    ? result.content
    : {};
}

function answerValues(raw) {
  return Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
}

function normalizedOtherText(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= 4000 ? value : null;
}

function legacyMultiValues(content, question, questionIndex) {
  const values = [];
  for (const [optionIndex, option] of question.options.entries()) {
    if (content[legacyOptionField(questionIndex, optionIndex)] === true) values.push(option.id);
  }
  if (question.allow_other && content[legacyOtherSelectedField(questionIndex)] === true) values.push("__other__");
  return values;
}

function supportsFormElicitation(capabilities) {
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) return false;
  return Object.keys(elicitation).length === 0
    || (elicitation.form !== null && typeof elicitation.form === "object" && !Array.isArray(elicitation.form));
}

function requestClient(method, params, toolCall) {
  if (toolCall.cancelled) return Promise.resolve({ action: "cancel" });
  const id = `user-questions-${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    toolCall.pendingRequestId = id;
    pendingClientRequests.set(id, { resolve, reject, toolCall });
    write({ jsonrpc: "2.0", id, method, params });
  });
}

function takePendingClientRequest(requestId) {
  const key = String(requestId);
  const pending = pendingClientRequests.get(key);
  if (!pending) return null;
  pendingClientRequests.delete(key);
  if (pending.toolCall.pendingRequestId === key) pending.toolCall.pendingRequestId = null;
  return pending;
}

function cancelToolCall(toolCall) {
  toolCall.cancelled = true;
  if (!toolCall.pendingRequestId) return;
  const pending = takePendingClientRequest(toolCall.pendingRequestId);
  if (pending) pending.resolve({ action: "cancel" });
}

function toolDefinition() {
  return {
    name: "ask",
    description: "Ask the user a native, task-scoped structured round of 1-6 questions, presented one question at a time so the current task remains visible. Prefer 4-6 currently answerable questions. Supports single choice and multi-select; selecting Other reveals an inline text field, with a required follow-up only when the host does not return usable inline text.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["round_id", "questions"],
      properties: {
        round_id: { type: "string", description: "Stable identifier for this question round." },
        questions: {
          type: "array", minItems: 1, maxItems: 6,
          items: {
            type: "object", additionalProperties: false,
            required: ["id", "header", "question", "selection_mode", "options"],
            properties: {
              id: { type: "string" }, header: { type: "string" }, question: { type: "string" },
              selection_mode: { type: "string", enum: ["single", "multiple"] },
              options: { type: "array", minItems: 2, maxItems: 5, items: { type: "object", additionalProperties: false, required: ["id", "label", "description"], properties: { id: { type: "string" }, label: { type: "string" }, description: { type: "string" } } } },
              allow_other: { type: "boolean", default: true }, required: { type: "boolean", default: true },
              min_selections: { type: "integer", minimum: 0, maximum: 6 },
              max_selections: { type: "integer", minimum: 1, maximum: 6, description: "Compatibility hint. Multi-select questions always allow every listed option plus Other when enabled." },
            },
          },
        },
      },
    },
  };
}

function toolResult(result) {
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false };
}
function toolError(message) {
  return { content: [{ type: "text", text: `User Questions unavailable: ${message}. Fall back to native request_user_input.` }], isError: true };
}
function otherField(id) { return `${id}__other_text`; }
function otherTextField(question, questionIndex, legacy) {
  return legacy ? `__uq_q${questionIndex}_other_text` : otherField(question.id);
}
function legacyOptionField(questionIndex, optionIndex) { return `__uq_q${questionIndex}_o${optionIndex}`; }
function legacyOtherSelectedField(questionIndex) { return `__uq_q${questionIndex}_other_selected`; }
function reply(id, result) { write({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { write({ jsonrpc: "2.0", id, error: { code, message } }); }
function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const toolCall of activeToolCalls.values()) {
    toolCall.cancelled = true;
    toolCall.pendingRequestId = null;
  }
  for (const pending of pendingClientRequests.values()) {
    pending.reject(new Error("User Questions client disconnected"));
  }
  pendingClientRequests.clear();
  activeToolCalls.clear();
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.on("error", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
