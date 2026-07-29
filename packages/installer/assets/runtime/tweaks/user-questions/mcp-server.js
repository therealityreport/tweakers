#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const {
  CONTRACT_LIMITS,
  serializeResult,
  validateAnswerStates,
  validateAskInput,
} = require("./core");
const { createRoundState, reduceRoundState } = require("./round-state");
const {
  BrokerProtocolError,
  CARRIER_NONCE_PREFIX,
  connectBroker,
} = require("./broker-protocol");
const { DraftStoreError, createDraftStore, inputFingerprint } = require("./draft-store");
const { version: SERVER_VERSION } = require("./manifest.json");

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([LATEST_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]);
const SKIP_VALUE = "__skip__";
const OTHER_VALUE = "__other__";
const SKIP_TITLE = "Skip this question";
const OTHER_TITLE = "Other";
const DEFAULT_DISPLAY_TIMEOUT_MS = 5 * 60_000;
const BROKER_TIMEOUT_MS = 5_000;
const TWEAK_DATA_DIR_ENV = "TWEAKER_TWEAK_DATA_DIR";
const TWEAK_ID_ENV = "TWEAKER_TWEAK_ID";
const CARRIER_OTHER_TEXT_PREFIX = "__tweakers_carrier_other_";

function createMcpRuntime(options = {}) {
  const inputStream = options.input || process.stdin;
  const outputStream = options.output || process.stdout;
  const environment = options.env || process.env;
  const connect = options.connectBroker || connectBroker;
  const makeDraftStore = options.createDraftStore || createDraftStore;
  const pendingClientRequests = new Map();
  const activeToolCalls = new Map();
  let clientCapabilities = {};
  let negotiatedProtocolVersion = LATEST_PROTOCOL_VERSION;
  let buffer = "";
  let shuttingDown = false;

  inputStream.setEncoding("utf8");
  inputStream.on("data", (chunk) => {
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
      if (message.error) pending.reject(new Error(message.error.message || "Question form failed"));
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
          serverInfo: { name: "user-questions", version: SERVER_VERSION },
        });
      }
      if (message.method === "ping") return reply(message.id, {});
      if (message.method === "tools/list") return reply(message.id, { tools: [toolDefinition()] });
      if (message.method === "tools/call") {
        if (message.params?.name !== "ask") throw new Error("unknown tool");
        const validation = validateAskInput(message.params?.arguments);
        if (!validation.ok) return reply(message.id, toolError(validation.errors.join("; ")));
        const reservedError = validateReservedValues(validation.value);
        if (reservedError) return reply(message.id, toolError(reservedError));
        if (!supportsFormElicitation(clientCapabilities)) {
          return reply(message.id, serializeToolResult(validation.value, {
            status: "display_failed",
            failure_stage: "tool_discovery",
            answers: {},
          }));
        }
        const toolCallId = String(message.id);
        const toolCall = makeToolCall(environment);
        activeToolCalls.set(toolCallId, toolCall);
        try {
          const result = await elicitRound(validation.value, toolCall);
          return reply(message.id, result);
        } finally {
          clearDisplayTimer(toolCall);
          toolCall.broker?.close();
          activeToolCalls.delete(toolCallId);
        }
      }
      return replyError(message.id, -32601, "method not found");
    } catch (error) {
      return reply(message.id, toolError(publicToolError(error)));
    }
  }

  async function elicitRound(input, toolCall) {
    const legacy = negotiatedProtocolVersion === LEGACY_PROTOCOL_VERSION;
    let carrierField = null;
    if (!legacy) {
      const nonce = crypto.randomBytes(24).toString("base64url");
      await attachBroker(input, toolCall, nonce);
      if (toolCall.cancelled) return cancelledToolResult(input, toolCall, "cancel");
      // A nonce is a routing key, never a visible checkbox. The one host form
      // that carries it renders Question 1 itself; all ordinary fallback forms
      // use their real question IDs and remain strictly sequential.
      if (toolCall.broker) carrierField = `${CARRIER_NONCE_PREFIX}${nonce}`;
    }

    const answers = {};
    for (let questionIndex = 0; questionIndex < input.questions.length; questionIndex += 1) {
      const outcome = await elicitFallbackQuestion(input, questionIndex, legacy, toolCall, {
        field: questionIndex === 0 ? carrierField : null,
      });
      if (outcome.kind === "cancelled") return cancelledToolResult(input, toolCall, outcome.action);
      if (outcome.kind === "display_failed") {
        return serializeToolResult(input, {
          status: "display_failed",
          failure_stage: outcome.failureStage,
          answers: {},
        });
      }
      if (outcome.kind === "invalid") {
        return toolError(`question answers remain invalid after one correction: ${outcome.errors.join("; ")}`);
      }
      if (outcome.kind === "owned_submitted") {
        if (questionIndex !== 0 || toolCall.state?.phase !== "submitted") {
          return toolError("the owned question state was not available for submission");
        }
        const validation = validateAnswerStates(input, toolCall.state.answers, { allow_unanswered: false });
        if (!validation.ok) return toolError(`the owned question state was invalid: ${validation.errors.join("; ")}`);
        return finalizeSubmittedAnswers(input, toolCall, validation.value);
      }
      answers[input.questions[questionIndex].id] = outcome.answer;
    }
    const validation = validateAnswerStates(input, answers, { allow_unanswered: false });
    if (!validation.ok) return toolError(`question answers were invalid: ${validation.errors.join("; ")}`);
    return finalizeSubmittedAnswers(input, toolCall, validation.value);
  }

  async function elicitFallbackQuestion(input, questionIndex, legacy, toolCall, options = {}) {
    const field = typeof options.field === "string" ? options.field : null;
    let correction = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result;
      try {
        result = await requestClient(
          "elicitation/create",
          buildQuestionElicitation(input, questionIndex, legacy, { field, correction }),
          toolCall,
        );
      } catch {
        return { kind: "display_failed", failureStage: deliveryFailureStage(toolCall) };
      }
      if (toolCall.cancelled) return { kind: "cancelled", action: "cancel" };
      if (result?.deliveryTimedOut === true) {
        return { kind: "display_failed", failureStage: deliveryFailureStage(toolCall) };
      }
      if (result?.action === "cancel" || result?.action === "decline") {
        return { kind: "cancelled", action: result.action };
      }
      if (result?.action !== "accept") {
        return { kind: "display_failed", failureStage: "host_empty_response" };
      }

      const content = resultContent(result);
      if (!hasQuestionAnswerSignal(input, questionIndex, content, legacy, { field })) {
        return { kind: "display_failed", failureStage: "host_empty_response" };
      }
      if (questionIndex === 0 && field && toolCall.state?.phase === "submitted") {
        return { kind: "owned_submitted" };
      }
      markInteracted(toolCall);
      const parsed = parseQuestionFallbackAnswer(input, questionIndex, content, legacy, { field });
      if (parsed.ok) return { kind: "answered", answer: parsed.answer };
      if (attempt === 1) return { kind: "invalid", errors: parsed.errors };
      correction = { values: parsed.values, error: parsed.errors[0] };
    }
    return { kind: "invalid", errors: ["question correction failed"] };
  }

  function finalizeSubmittedAnswers(input, toolCall, answers) {
    if (toolCall.taskRouteId && toolCall.draftStore) {
      try {
        toolCall.draftStore.cleanupSubmitted(draftIdentity(input, toolCall));
      } catch {
        return toolError("submitted answers could not be finalized safely");
      }
    }
    return serializeToolResult(input, {
      status: "submitted",
      cancelled: false,
      answers,
    });
  }

  async function attachBroker(input, toolCall, nonce) {
    const dataDir = environment[TWEAK_DATA_DIR_ENV];
    const tweakId = environment[TWEAK_ID_ENV];
    if (typeof dataDir !== "string" || typeof tweakId !== "string") return;
    let broker;
    try {
      broker = await connect({ dataDir, tweakId, timeoutMs: BROKER_TIMEOUT_MS });
      toolCall.broker = broker;
      toolCall.draftStore = makeDraftStore({ dataDir, tweakId });
      broker.setRequestHandler((method, payload) => handleBrokerRequest(input, toolCall, method, payload));
      await broker.register(nonce, BROKER_TIMEOUT_MS);
      toolCall.delivery.phase = "accepted";
    } catch {
      broker?.close();
      toolCall.broker = null;
      toolCall.draftStore = null;
    }
  }

  async function handleBrokerRequest(input, toolCall, method, payload) {
    if (toolCall.terminal) throw new BrokerProtocolError("claim_inactive");
    if (method === "claimed") return handleClaim(input, toolCall, payload);
    if (method === "round.action") return handleRoundAction(input, toolCall, payload);
    if (method === "delivery.ack" || method === "delivery") return handleDeliveryAck(toolCall, payload);
    throw new BrokerProtocolError("method_unsupported");
  }

  function handleClaim(input, toolCall, payload) {
    if (!isRecord(payload) || !exactFields(payload, ["claimToken", "routeHash"])) {
      throw new BrokerProtocolError("payload_invalid");
    }
    if (typeof payload.routeHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.routeHash)) {
      throw new BrokerProtocolError("route_invalid");
    }
    if (typeof payload.claimToken !== "string" || !/^[a-f0-9]{64}$/.test(payload.claimToken)) {
      throw new BrokerProtocolError("claim_invalid");
    }
    if (toolCall.taskRouteId) throw new BrokerProtocolError("nonce_replayed");
    toolCall.taskRouteId = payload.routeHash;
    toolCall.delivery.phase = "carrier_attached";
    let state = createRoundState(input);
    if (input.resume_token) {
      try {
        const loaded = toolCall.draftStore.load({
          ...draftIdentity(input, toolCall),
          resumeToken: input.resume_token,
        });
        state = normalizeLoadedRoundState(input, loaded.state);
        toolCall.resumeToken = loaded.resume_token;
        toolCall.resumeCommitPending = true;
        toolCall.draftView = draftView("available", true, loaded.expires_at);
      } catch (error) {
        if (!(error instanceof DraftStoreError) || ![
          "draft_not_found", "draft_expired", "resume_token_invalid",
        ].includes(error.code)) throw new BrokerProtocolError("request_failed");
        toolCall.draftView = draftView("unavailable", false, null);
      }
    } else {
      const claimed = reduceRoundState(input, state, { type: "claim", revision: 0 });
      if (!claimed.ok) throw new BrokerProtocolError("request_failed");
      state = claimed.value;
      persistState(input, toolCall, state, 0);
    }
    toolCall.state = state;
    return viewModel(input, toolCall);
  }

  function handleRoundAction(input, toolCall, payload) {
    if (!toolCall.taskRouteId || !toolCall.state) throw new BrokerProtocolError("claim_inactive");
    const reduced = reduceRoundState(input, toolCall.state, payload);
    if (!reduced.ok) return deepFreeze({
      ok: false,
      errors: reduced.errors,
      state: structuredClone(toolCall.state),
      draft: structuredClone(toolCall.draftView),
    });
    const previousRevision = toolCall.state.revision;
    const next = reduced.value;
    try {
      if (payload.type === "discard") {
        toolCall.draftStore.discard(draftIdentity(input, toolCall));
        toolCall.resumeCommitPending = false;
        toolCall.draftView = draftView("discarded", false, null);
      } else if (next.phase === "submitted") {
        // Keep the last resumable state and token durable until the host form
        // returns real answers. An empty or failed host response must remain
        // retryable with the caller's existing token.
      } else {
        const saved = persistState(input, toolCall, next, previousRevision, {
          allowCreate: payload.type === "claim" && toolCall.draftView.status === "discarded",
        });
        if (payload.type === "resume") {
          toolCall.draftView = draftView("resumed", false, saved.expires_at);
        } else if (payload.type === "claim" && toolCall.draftView.status === "discarded") {
          toolCall.draftView = draftView("none", false, null);
        }
      }
    } catch {
      throw new BrokerProtocolError("request_failed");
    }
    toolCall.state = next;
    if (payload.type !== "details") markInteracted(toolCall);
    return deepFreeze({
      ok: true,
      state: structuredClone(next),
      delivery: deliverySnapshot(input, toolCall),
      draft: structuredClone(toolCall.draftView),
    });
  }

  function handleDeliveryAck(toolCall, payload) {
    if (!isDeliveryAcknowledgement(payload)) throw new BrokerProtocolError("payload_invalid");
    if (payload.stage === "carrier_attach") {
      toolCall.delivery.phase = "carrier_attached";
    } else {
      toolCall.delivery.phase = payload.stage === "owned_mount" ? "owned_mounted" : "generic_visible";
      toolCall.visibleDeliveryAcknowledged = true;
      toolCall.markDisplayed();
    }
    return { accepted: true, phase: toolCall.delivery.phase, contentRedacted: true };
  }

  function persistState(input, toolCall, state, expectedRevision, options = {}) {
    const saved = toolCall.draftStore.save({
      ...draftIdentity(input, toolCall),
      state,
      expectedRevision,
      ...(options.allowCreate === true ? { allowCreate: true } : {}),
      ...(toolCall.resumeToken ? { resumeToken: toolCall.resumeToken } : {}),
    });
    toolCall.resumeToken = saved.resume_token;
    return saved;
  }

  function cancelledToolResult(input, toolCall, action) {
    toolCall.terminal = true;
    const approvalBlocked = action === "decline";
    if (!toolCall.taskRouteId || !toolCall.draftStore || !toolCall.state) {
      return serializeToolResult(input, {
        status: "cancelled",
        cancel_reason: approvalBlocked
          ? "approval_blocked; secure task binding unavailable, so no cross-task draft was stored"
          : "user_cancelled; secure task binding unavailable, so no cross-task draft was stored",
        answers: {},
        draft: { resumable: false, resume_token: null },
      });
    }
    try {
      if (toolCall.state.phase === "question" || toolCall.state.phase === "review") {
        const cancelled = reduceRoundState(input, toolCall.state, {
          type: "cancel_save",
          revision: toolCall.state.revision,
        });
        if (!cancelled.ok) throw new Error("cancel transition failed");
        persistState(input, toolCall, cancelled.value, toolCall.state.revision);
        toolCall.state = cancelled.value;
      }
      if (!toolCall.resumeToken) throw new Error("missing resume token");
    } catch {
      return serializeToolResult(input, {
        status: "cancelled",
        cancel_reason: "user_cancelled; the task-scoped draft could not be saved",
        answers: {},
        draft: { resumable: false, resume_token: null },
      });
    }
    if (toolCall.resumeCommitPending && toolCall.visibleDeliveryAcknowledged) {
      try {
        const committed = toolCall.draftStore.commitResume({
          ...draftIdentity(input, toolCall),
          resumeToken: toolCall.resumeToken,
        });
        toolCall.resumeToken = committed.resume_token;
        toolCall.resumeCommitPending = false;
      } catch {
        return toolError("resumed draft token could not be committed safely");
      }
    }
    return serializeToolResult(input, {
      status: "cancelled",
      cancel_reason: approvalBlocked ? "approval_blocked" : "user_cancelled",
      answers: {},
      draft: { resumable: true, resume_token: toolCall.resumeToken },
    });
  }

  function requestClient(method, params, toolCall) {
    if (toolCall.cancelled) return Promise.resolve({ action: "cancel" });
    const id = `user-questions-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      toolCall.pendingRequestId = id;
      const entry = { resolve, reject, toolCall, timer: null };
      pendingClientRequests.set(id, entry);
      if (!toolCall.displayAcknowledged) {
        entry.timer = setTimeout(() => {
          const pending = takePendingClientRequest(id);
          if (pending) pending.resolve({ deliveryTimedOut: true });
        }, toolCall.displayTimeoutMs);
        entry.timer.unref?.();
        toolCall.displayTimerEntry = entry;
      }
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  function takePendingClientRequest(requestId) {
    const key = String(requestId);
    const pending = pendingClientRequests.get(key);
    if (!pending) return null;
    pendingClientRequests.delete(key);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.toolCall.displayTimerEntry === pending) pending.toolCall.displayTimerEntry = null;
    if (pending.toolCall.pendingRequestId === key) pending.toolCall.pendingRequestId = null;
    return pending;
  }

  function cancelToolCall(toolCall) {
    toolCall.cancelled = true;
    if (!toolCall.pendingRequestId) return;
    const pending = takePendingClientRequest(toolCall.pendingRequestId);
    if (pending) pending.resolve({ action: "cancel" });
  }

  function clearDisplayTimer(toolCall) {
    if (toolCall.displayTimerEntry?.timer) clearTimeout(toolCall.displayTimerEntry.timer);
    toolCall.displayTimerEntry = null;
  }

  function reply(id, result) { write({ jsonrpc: "2.0", id, result }); }
  function replyError(id, code, message) { write({ jsonrpc: "2.0", id, error: { code, message } }); }
  function write(message) { outputStream.write(`${JSON.stringify(message)}\n`); }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const toolCall of activeToolCalls.values()) {
      toolCall.cancelled = true;
      clearDisplayTimer(toolCall);
      toolCall.broker?.close();
      toolCall.pendingRequestId = null;
    }
    for (const pending of pendingClientRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("User Questions client disconnected"));
    }
    pendingClientRequests.clear();
    activeToolCalls.clear();
    if (options.exitOnShutdown !== false) process.exit(0);
  }

  inputStream.on("end", shutdown);
  inputStream.on("close", shutdown);
  inputStream.on("error", shutdown);
  if (options.installSignalHandlers !== false) {
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }
  return Object.freeze({ shutdown });
}

function makeToolCall(environment) {
  const displayTimeoutMs = boundedTimeout(environment.USER_QUESTIONS_DISPLAY_TIMEOUT_MS, DEFAULT_DISPLAY_TIMEOUT_MS);
  const toolCall = {
    broker: null,
    cancelled: false,
    delivery: { phase: "accepted" },
    displayAcknowledged: false,
    displayTimerEntry: null,
    displayTimeoutMs,
    draftStore: null,
    draftView: draftView("none", false, null),
    pendingRequestId: null,
    resumeToken: null,
    resumeCommitPending: false,
    state: null,
    taskRouteId: null,
    terminal: false,
    visibleDeliveryAcknowledged: false,
  };
  toolCall.markDisplayed = () => {
    toolCall.displayAcknowledged = true;
    if (toolCall.displayTimerEntry?.timer) clearTimeout(toolCall.displayTimerEntry.timer);
    if (toolCall.displayTimerEntry) toolCall.displayTimerEntry.timer = null;
  };
  return toolCall;
}

// Kept as an exported compatibility helper. A round carrier is deliberately
// only its first real question; callers must never emit a full round schema.
function buildRoundElicitation(input, legacy, carrierField, correction = null) {
  return buildQuestionElicitation(input, 0, legacy, {
    field: carrierField,
    correction,
  });
}

function buildQuestionElicitation(input, questionIndex, legacy, options = {}) {
  const question = input.questions[questionIndex];
  if (!question) throw new Error("question index is out of range");
  const properties = {};
  const required = [];
  const field = !legacy && typeof options.field === "string" && options.field
    ? options.field
    : question.id;
  const otherField = !legacy && field !== question.id
    ? carrierOtherTextField(field)
    : null;
  addQuestionProperties(
    properties,
    required,
    question,
    questionIndex,
    legacy,
    options.correction?.values || {},
    { field, otherField },
  );
  const progress = `Question ${questionIndex + 1} of ${input.questions.length}: ${question.question}`;
  return {
    ...(!legacy ? { mode: "form" } : {}),
    message: options.correction
      ? `${progress} Please correct this answer and continue. ${plainCorrection(options.correction.error)}`
      : `${progress} Choose Skip if you do not want to answer.`,
    requestedSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    },
  };
}

function addQuestionProperties(properties, required, question, questionIndex, legacy, prior = {}, fieldOptions = {}) {
  const choices = question.options.map((option) => ({
    const: option.id,
    title: option.recommended && !/\(Recommended\)/i.test(option.label)
      ? `${option.label} (Recommended)`
      : option.label,
  }));
  choices.push({ const: SKIP_VALUE, title: SKIP_TITLE });
  if (question.allow_other) choices.push({ const: OTHER_VALUE, title: OTHER_TITLE });
  const description = fallbackDescription(question);
  const priorValues = Array.isArray(prior.values) ? prior.values : [];
  const field = !legacy && typeof fieldOptions.field === "string" && fieldOptions.field
    ? fieldOptions.field
    : question.id;

  if (legacy && question.selection_mode === "multiple") {
    for (const [optionIndex, option] of question.options.entries()) {
      properties[legacyOptionField(questionIndex, optionIndex)] = {
        type: "boolean",
        title: `${question.header} — ${choices[optionIndex].title}`,
        description,
        default: priorValues.includes(option.id),
      };
    }
    properties[legacySkipField(questionIndex)] = {
      type: "boolean",
      title: `${question.header} — ${SKIP_TITLE}`,
      description,
      default: priorValues.includes(SKIP_VALUE),
    };
    if (question.allow_other) {
      properties[legacyOtherSelectedField(questionIndex)] = {
        type: "boolean",
        title: `${question.header} — ${OTHER_TITLE}`,
        description,
        default: priorValues.includes(OTHER_VALUE),
      };
    }
  } else if (legacy) {
    properties[question.id] = {
      type: "string",
      title: question.header,
      description,
      enum: choices.map((choice) => choice.const),
      enumNames: choices.map((choice) => choice.title),
      ...(priorValues.length ? { default: priorValues[0] } : {}),
    };
    required.push(question.id);
  } else {
    properties[field] = question.selection_mode === "multiple"
      ? {
          type: "array",
          title: question.header,
          description,
          minItems: 1,
          maxItems: question.options.length + (question.allow_other ? 1 : 0),
          items: { anyOf: choices },
          ...(priorValues.length ? { default: priorValues } : {}),
        }
      : {
          type: "string",
          title: question.header,
          description,
          oneOf: choices,
          ...(priorValues.length ? { default: priorValues[0] } : {}),
        };
    required.push(field);
  }
  if (question.allow_other) {
    const textField = !legacy && typeof fieldOptions.otherField === "string" && fieldOptions.otherField
      ? fieldOptions.otherField
      : otherTextField(question, questionIndex, legacy);
    properties[textField] = {
      type: "string",
      title: `${question.header} — Other response`,
      description: "If you selected Other for this question, type the answer here.",
      maxLength: CONTRACT_LIMITS.other_text_characters,
      ...(typeof prior.other_text === "string" && prior.other_text ? { default: prior.other_text } : {}),
    };
  }
}

function fallbackDescription(question) {
  const lines = [question.question];
  for (const option of question.options) {
    const parts = [`${displayOptionLabel(option)}: ${option.description}`];
    if (option.details) parts.push(`Details: ${option.details}`);
    if (option.pros.length) parts.push(`Pros: ${option.pros.join("; ")}`);
    if (option.cons.length) parts.push(`Cons: ${option.cons.join("; ")}`);
    if (option.gives_up.length) parts.push(`What you give up: ${option.gives_up.join("; ")}`);
    lines.push(parts.join(" "));
  }
  lines.push("Choose Skip this question by itself if you do not want to answer.");
  if (question.allow_other) lines.push("Choose Other and provide text in the matching Other response field.");
  return lines.join("\n");
}

function parseFallbackAnswers(input, content, legacy) {
  const answers = {};
  const values = {};
  const parseErrors = [];
  const allowedFields = new Set();
  for (const [questionIndex, question] of input.questions.entries()) {
    const parsed = parseQuestionFallbackAnswer(input, questionIndex, content, legacy);
    values[question.id] = parsed.values;
    answers[question.id] = parsed.answer;
    parseErrors.push(...parsed.errors);
    for (const field of parsed.allowedFields) allowedFields.add(field);
  }
  for (const field of Object.keys(content)) {
    if (!allowedFields.has(field) && !field.startsWith(CARRIER_NONCE_PREFIX)) {
      parseErrors.push(`host response contains unsupported field ${field.slice(0, 80)}`);
    }
  }
  const validation = validateAnswerStates(input, answers, { allow_unanswered: false });
  const errors = [...parseErrors, ...(validation.ok ? [] : validation.errors)];
  return errors.length
    ? { ok: false, errors: [...new Set(errors)], values, answers }
    : { ok: true, values, answers: validation.value };
}

function parseQuestionFallbackAnswer(input, questionIndex, content, legacy, options = {}) {
  const question = input.questions[questionIndex];
  if (!question) return {
    ok: false,
    errors: ["question index is out of range"],
    values: { values: [], other_text: null },
    answer: { status: "unanswered", selected_option_ids: [], other_text: null },
    allowedFields: new Set(),
  };
  const field = !legacy && typeof options.field === "string" && options.field
    ? options.field
    : question.id;
  const textField = !legacy && field !== question.id
    ? carrierOtherTextField(field)
    : otherTextField(question, questionIndex, legacy);
  const parseErrors = [];
  const allowedFields = new Set();
  let selectedValues;
  if (legacy && question.selection_mode === "multiple") {
    selectedValues = [];
    question.options.forEach((option, optionIndex) => {
      const optionField = legacyOptionField(questionIndex, optionIndex);
      allowedFields.add(optionField);
      if (content[optionField] === true) selectedValues.push(option.id);
      else if (content[optionField] !== undefined && content[optionField] !== false) {
        parseErrors.push(`${question.id}: choice values must be booleans`);
      }
    });
    const skipField = legacySkipField(questionIndex);
    allowedFields.add(skipField);
    if (content[skipField] === true) selectedValues.push(SKIP_VALUE);
    else if (content[skipField] !== undefined && content[skipField] !== false) {
      parseErrors.push(`${question.id}: Skip must be a boolean`);
    }
    if (question.allow_other) {
      const otherField = legacyOtherSelectedField(questionIndex);
      allowedFields.add(otherField);
      if (content[otherField] === true) selectedValues.push(OTHER_VALUE);
      else if (content[otherField] !== undefined && content[otherField] !== false) {
        parseErrors.push(`${question.id}: Other must be a boolean`);
      }
    }
  } else {
    allowedFields.add(field);
    const raw = content[field];
    if (
      raw !== undefined && typeof raw !== "string"
      && (!Array.isArray(raw) || raw.some((value) => typeof value !== "string"))
    ) parseErrors.push(`${question.id}: choice values must be strings`);
    if (Array.isArray(raw) && new Set(raw).size !== raw.length) {
      parseErrors.push(`${question.id}: choices must not repeat`);
    }
    selectedValues = answerValues(raw);
  }
  if (question.allow_other) allowedFields.add(textField);
  const otherSelected = selectedValues.includes(OTHER_VALUE);
  const skipped = selectedValues.includes(SKIP_VALUE);
  const otherText = otherSelected ? normalizedOtherText(content[textField]) : null;
  const values = {
    values: [...selectedValues],
    other_text: otherText || (typeof content[textField] === "string"
      ? content[textField].trim().slice(0, CONTRACT_LIMITS.other_text_characters)
      : null),
  };
  if (skipped && selectedValues.length !== 1) {
    parseErrors.push(`${question.id}: Skip this question must be selected alone`);
  }
  if (otherSelected && !otherText) {
    parseErrors.push(`${question.id}: Other requires a non-blank Other response`);
  }
  if (question.selection_mode === "single" && selectedValues.length > 1) {
    parseErrors.push(`${question.id}: choose exactly one answer`);
  }
  const selectedOptionIds = selectedValues.filter((value) => value !== SKIP_VALUE && value !== OTHER_VALUE);
  const answer = skipped && selectedValues.length === 1
    ? { status: "skipped", selected_option_ids: [], other_text: null }
    : selectedValues.length === 0
      ? { status: "unanswered", selected_option_ids: [], other_text: null }
      : { status: "answered", selected_option_ids: selectedOptionIds, other_text: otherText };
  const oneQuestionInput = { ...input, questions: [question] };
  const validation = validateAnswerStates(oneQuestionInput, { [question.id]: answer }, { allow_unanswered: false });
  const errors = [...parseErrors, ...(validation.ok ? [] : validation.errors)];
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    values,
    answer: validation.ok ? validation.value[question.id] : answer,
    allowedFields,
  };
}

function serializeToolResult(input, result) {
  const serialized = serializeResult(input, result);
  if (!serialized.ok) return toolError(serialized.errors.join("; "));
  return {
    content: [{ type: "text", text: serialized.value.text }],
    structuredContent: serialized.value.structuredContent,
    isError: false,
  };
}

function toolDefinition() {
  return {
    name: "ask",
    description: "Ask one task-scoped structured round of 1-6 questions in a single standard form. Prefer 4-6 currently answerable questions. Every question supports explicit Skip; Other is available when enabled. Rich plain-text details and tradeoffs remain available in both the enhanced and generic form paths. Submitted choices are current-task preferences, not permanent rules: explain conflicts and ask before materially changing direction. A submitted result must contain validated answers for every question. Cancellation and display failure are explicit terminal statuses, never defaults or empty success. Question and answer content is not written to diagnostic logs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["round_id", "questions"],
      properties: {
        round_id: { type: "string", description: "Stable identifier for this question round." },
        resume_token: { type: "string", description: "Opaque token returned by a cancelled task-scoped round." },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "header", "question", "selection_mode", "options"],
            properties: {
              id: { type: "string" },
              header: { type: "string" },
              question: { type: "string" },
              selection_mode: { type: "string", enum: ["single", "multiple"] },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "label", "description"],
                  properties: {
                    id: { type: "string" },
                    label: { type: "string" },
                    description: { type: "string" },
                    details: { type: "string" },
                    pros: { type: "array", maxItems: 5, items: { type: "string" } },
                    cons: { type: "array", maxItems: 5, items: { type: "string" } },
                    gives_up: { type: "array", maxItems: 5, items: { type: "string" } },
                    recommended: { type: "boolean", default: false },
                  },
                },
              },
              allow_other: { type: "boolean", default: true },
              required: { type: "boolean", default: true },
              min_selections: { type: "integer", minimum: 0, maximum: 6 },
              max_selections: { type: "integer", minimum: 1, maximum: 6 },
            },
          },
        },
      },
    },
  };
}

function toolError(message) {
  return {
    content: [{ type: "text", text: `User Questions unavailable: ${message}.` }],
    isError: true,
  };
}

function makeDelivery(roundId, phase) {
  return { phase, round_id: roundId, retryable: true };
}

function deliverySnapshot(input, toolCall) {
  return makeDelivery(input.round_id, toolCall.delivery.phase);
}

function viewModel(input, toolCall) {
  const rendererInput = structuredClone(input);
  delete rendererInput.resume_token;
  return deepFreeze({
    version: 1,
    input: rendererInput,
    state: structuredClone(toolCall.state),
    delivery: deliverySnapshot(input, toolCall),
    draft: structuredClone(toolCall.draftView),
  });
}

function draftView(status, resumable, expiresAt) {
  return Object.freeze({
    status,
    resumable,
    expires_at: Number.isSafeInteger(expiresAt) ? expiresAt : null,
  });
}

function normalizeLoadedRoundState(input, state) {
  const normalized = structuredClone(state);
  if (!Array.isArray(normalized.other_selected_question_ids)) {
    normalized.other_selected_question_ids = input.questions
      .filter((question) => normalized.answers?.[question.id]?.other_text !== null)
      .map((question) => question.id);
  }
  const probe = reduceRoundState(input, normalized, {
    type: "__validate_loaded_state__",
    revision: normalized.revision,
  });
  if (
    probe.ok
    || probe.errors?.length !== 1
    || probe.errors[0] !== "unknown action __validate_loaded_state__"
  ) throw new DraftStoreError("draft_corrupt");
  return normalized;
}

function draftIdentity(input, toolCall) {
  return {
    taskRouteId: toolCall.taskRouteId,
    roundId: input.round_id,
    input,
    inputFingerprint: inputFingerprint(input),
  };
}

function isDeliveryAcknowledgement(payload) {
  return isRecord(payload)
    && exactFields(payload, ["version", "stage", "contentRedacted"])
    && payload.version === 1
    && ["carrier_attach", "owned_mount", "generic_mount"].includes(payload.stage)
    && payload.contentRedacted === true;
}

function deliveryFailureStage(toolCall) {
  if (toolCall.delivery.phase === "carrier_attached") return "owned_mount";
  if (toolCall.delivery.phase === "owned_mounted") return "owned_mount";
  if (toolCall.delivery.phase === "generic_visible") return "generic_mount";
  return toolCall.broker ? "carrier_attach" : "generic_mount";
}

function markInteracted(toolCall) {
  if (toolCall.visibleDeliveryAcknowledged) toolCall.delivery.phase = "interacted";
}

function supportsFormElicitation(capabilities) {
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object" || Array.isArray(elicitation)) return false;
  return Object.keys(elicitation).length === 0
    || (elicitation.form !== null && typeof elicitation.form === "object" && !Array.isArray(elicitation.form));
}

function validateReservedValues(input) {
  for (const question of input.questions) {
    if (question.options.some((option) => option.id === SKIP_VALUE || option.id === OTHER_VALUE)) {
      return `${question.id} uses a reserved fallback choice identifier`;
    }
  }
  return null;
}

function hasQuestionAnswerSignal(input, questionIndex, content, legacy, options = {}) {
  const question = input.questions[questionIndex];
  if (!question) return false;
  const field = !legacy && typeof options.field === "string" && options.field
    ? options.field
    : question.id;
  if (Object.prototype.hasOwnProperty.call(content, field)) return true;
  const textField = !legacy && field !== question.id
    ? carrierOtherTextField(field)
    : otherTextField(question, questionIndex, legacy);
  if (question.allow_other && Object.prototype.hasOwnProperty.call(content, textField)) return true;
  if (!legacy || question.selection_mode !== "multiple") return false;
  return question.options.some((_, optionIndex) => Object.prototype.hasOwnProperty.call(content, legacyOptionField(questionIndex, optionIndex)))
    || Object.prototype.hasOwnProperty.call(content, legacySkipField(questionIndex))
    || (question.allow_other && Object.prototype.hasOwnProperty.call(content, legacyOtherSelectedField(questionIndex)));
}

function resultContent(result) {
  return isRecord(result?.content) ? result.content : {};
}

function answerValues(raw) {
  if (Array.isArray(raw)) return raw.filter((value) => typeof value === "string");
  return typeof raw === "string" ? [raw] : [];
}

function normalizedOtherText(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value && value.length <= CONTRACT_LIMITS.other_text_characters ? value : null;
}

function otherTextField(question, questionIndex, legacy) {
  return legacy ? `__uq_q${questionIndex}_other_text` : `${question.id}__other_text`;
}

function carrierOtherTextField(field) {
  if (!field.startsWith(CARRIER_NONCE_PREFIX)) return `${field}__other_text`;
  return `${CARRIER_OTHER_TEXT_PREFIX}${field.slice(CARRIER_NONCE_PREFIX.length)}`;
}

function legacyOptionField(questionIndex, optionIndex) { return `__uq_q${questionIndex}_o${optionIndex}`; }
function legacyOtherSelectedField(questionIndex) { return `__uq_q${questionIndex}_other_selected`; }
function legacySkipField(questionIndex) { return `__uq_q${questionIndex}_skip`; }

function displayOptionLabel(option) {
  return option.recommended && !/\(Recommended\)/i.test(option.label)
    ? `${option.label} (Recommended)`
    : option.label;
}

function plainCorrection(value) {
  const text = typeof value === "string" ? value.replace(/[<>]/g, "").trim() : "Check the selected values.";
  return text.slice(0, 300);
}

function boundedTimeout(value, fallback) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= 50 && parsed <= 10 * 60_000 ? parsed : fallback;
}

function exactFields(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function publicToolError(error) {
  if (error instanceof BrokerProtocolError) return `question delivery failed (${error.code})`;
  return String(error?.message || error).slice(0, 500);
}

if (require.main === module) createMcpRuntime();

module.exports = {
  LEGACY_PROTOCOL_VERSION,
  LATEST_PROTOCOL_VERSION,
  OTHER_VALUE,
  SKIP_VALUE,
  buildQuestionElicitation,
  buildRoundElicitation,
  createMcpRuntime,
  fallbackDescription,
  parseQuestionFallbackAnswer,
  parseFallbackAnswers,
  serializeToolResult,
  supportsFormElicitation,
  toolDefinition,
};
