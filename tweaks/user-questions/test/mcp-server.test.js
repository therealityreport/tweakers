"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const manifest = require("../manifest.json");

const MODERN_PROTOCOL_VERSION = "2025-11-25";
const LEGACY_PROTOCOL_VERSION = "2025-06-18";

test("MCP tool preserves its contract, returns one accepted answer, and stays connected", async (t) => {
  const { child, messages, initialized } = await startServer(t);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.protocolVersion, MODERN_PROTOCOL_VERSION);
  assert.equal(initialized.result.serverInfo.version, manifest.version);

  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tool = (await messages.next()).value.result.tools[0];
  assert.equal(tool.name, "ask");
  assert.match(tool.description, /one question at a time/);
  assert.match(tool.description, /current task remains visible/);
  assert.match(tool.description, /selecting Other reveals an inline text field/);
  assert.match(tool.description, /required follow-up only when the host does not return usable inline text/);
  assert.deepEqual(tool.inputSchema.required, ["round_id", "questions"]);
  assert.deepEqual(tool.inputSchema.properties.questions.items.required, ["id", "header", "question", "selection_mode", "options"]);

  sendAsk(child, 3, questionRound());
  const elicitation = (await messages.next()).value;
  assert.equal(elicitation.method, "elicitation/create");
  assert.equal(elicitation.params.mode, "form");
  assert.match(elicitation.params.message, /Question 1 of 1/);
  assert.deepEqual(Object.keys(elicitation.params.requestedSchema.properties), ["choice", "choice__other_text"]);
  assert.equal(elicitation.params.requestedSchema.properties.choice.type, "string");
  assert.equal(elicitation.params.requestedSchema.properties.choice.oneOf[0].const, "safe");
  assert.equal(elicitation.params.requestedSchema.properties.choice.oneOf[0].title, "Safe path (Recommended)");
  assert.equal(elicitation.params.requestedSchema.properties.choice.oneOf.at(-1).const, "__other__");
  assert.equal(elicitation.params.requestedSchema.properties.choice.oneOf.at(-1).title, "Other");
  assert.deepEqual(elicitation.params.requestedSchema.properties.choice__other_text, {
    type: "string",
    title: "Choice — Other response",
    description: "Select Other to show this field, then type your answer.",
    maxLength: 4000,
  });
  assert.deepEqual(elicitation.params.requestedSchema.required, ["choice"]);

  accept(child, elicitation, { choice: "safe", choice__other_text: "ignored because Other was not selected" });
  const result = (await messages.next()).value;
  assert.equal(result.id, 3);
  assert.deepEqual(result.result.structuredContent, {
    cancelled: false,
    cancel_reason: null,
    answers: { choice: { selected_option_ids: ["safe"], other_text: null } },
  });
  assert.equal(JSON.parse(result.result.content[0].text).answers.choice.selected_option_ids[0], "safe");

  await assertConnectionAlive(child, messages, 4);
  await closeServer(child);
});

test("modern questions are elicited sequentially, aggregate answers, and accept inline Other text", async (t) => {
  const { child, messages } = await startServer(t);
  const input = sequentialRound();
  sendAsk(child, 2, input);

  const first = (await messages.next()).value;
  assert.match(first.params.message, /Question 1 of 3/);
  assert.deepEqual(Object.keys(first.params.requestedSchema.properties), ["choice", "choice__other_text"]);
  assert.equal(first.params.requestedSchema.properties.choice.type, "string");
  assert.equal(first.params.requestedSchema.properties.choice__other_text.type, "string");
  assert.equal(Object.hasOwn(first.params.requestedSchema, "required"), true);
  assert.equal(first.params.requestedSchema.required.includes("choice__other_text"), false);
  accept(child, first, { choice: "safe" });

  const second = (await messages.next()).value;
  assert.match(second.params.message, /Question 2 of 3/);
  assert.deepEqual(Object.keys(second.params.requestedSchema.properties), ["features", "features__other_text"]);
  const multi = second.params.requestedSchema.properties.features;
  assert.equal(multi.type, "array");
  assert.equal(multi.minItems, 1);
  assert.equal(multi.maxItems, 3);
  assert.equal(multi.items.anyOf[0].title, "One");
  assert.equal(multi.items.anyOf.at(-1).const, "__other__");
  assert.equal(multi.items.anyOf.at(-1).title, "Other");
  assert.deepEqual(second.params.requestedSchema.properties.features__other_text, {
    type: "string",
    title: "Features — Other response",
    description: "Select Other to show this field, then type your answer.",
    maxLength: 4000,
  });
  assert.equal(second.params.requestedSchema.required.includes("features__other_text"), false);
  accept(child, second, {
    features: ["one", "__other__"],
    features__other_text: "  A custom feature  ",
  });

  const third = (await messages.next()).value;
  assert.match(third.params.message, /Question 3 of 3/);
  assert.deepEqual(Object.keys(third.params.requestedSchema.properties), ["timing"]);
  assert.equal(Object.hasOwn(third.params.requestedSchema, "required"), false);
  accept(child, third, {});

  const result = (await messages.next()).value.result.structuredContent;
  assert.deepEqual(result, {
    cancelled: false,
    cancel_reason: null,
    answers: {
      choice: { selected_option_ids: ["safe"], other_text: null },
      features: { selected_option_ids: ["one"], other_text: "A custom feature" },
      timing: { selected_option_ids: [], other_text: null },
    },
  });
  await closeServer(child);
});

test("blank inline Other text uses the required fallback and still rejects a blank response", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, questionRound());
  const selection = (await messages.next()).value;
  accept(child, selection, { choice: "__other__", choice__other_text: "   " });

  const other = (await messages.next()).value;
  const field = other.params.requestedSchema.properties.choice__other_text;
  assert.deepEqual(other.params.requestedSchema.required, ["choice__other_text"]);
  assert.equal(field.minLength, 1);
  assert.equal(field.maxLength, 4000);
  accept(child, other, { choice__other_text: "   " });

  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Other answer must contain 1 to 4000 non-whitespace characters/);
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

for (const action of ["cancel", "decline"]) {
  test(`${action} at a later selection prompt aborts the entire round atomically`, async (t) => {
    const { child, messages } = await startServer(t);
    const input = twoQuestionRound();
    sendAsk(child, 2, input);
    const first = (await messages.next()).value;
    accept(child, first, { choice: "safe" });
    const second = (await messages.next()).value;
    respond(child, second, { action });

    assertNeutralCancellation((await messages.next()).value.result.structuredContent, action);
    await assertConnectionAlive(child, messages, 3);
    await closeServer(child);
  });

  test(`${action} at a conditional Other prompt aborts the entire round atomically`, async (t) => {
    const { child, messages } = await startServer(t);
    const input = twoQuestionRound();
    sendAsk(child, 2, input);
    const first = (await messages.next()).value;
    accept(child, first, { choice: "safe" });
    const second = (await messages.next()).value;
    accept(child, second, { follow_up: "__other__" });
    const other = (await messages.next()).value;
    respond(child, other, { action });

    assertNeutralCancellation((await messages.next()).value.result.structuredContent, action);
    await assertConnectionAlive(child, messages, 3);
    await closeServer(child);
  });
}

test("notifications/cancelled at a selection prompt returns a neutral atomic cancellation", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, twoQuestionRound());
  const first = (await messages.next()).value;
  accept(child, first, { choice: "safe" });
  const second = (await messages.next()).value;
  notifyCancelled(child, second);

  assertNeutralCancellation((await messages.next()).value.result.structuredContent, "cancel");
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("notifications/cancelled at an Other prompt returns a neutral atomic cancellation", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, questionRound());
  const selection = (await messages.next()).value;
  accept(child, selection, { choice: "__other__" });
  const other = (await messages.next()).value;
  notifyCancelled(child, other);

  assertNeutralCancellation((await messages.next()).value.result.structuredContent, "cancel");
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("cancelling the root tools/call id during a selection prompt cancels its nested elicitation", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, twoQuestionRound());
  const selection = (await messages.next()).value;
  notifyCancelled(child, 2);

  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assertNeutralCancellation(result.result.structuredContent, "cancel");

  accept(child, selection, { choice: "safe" });
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("cancelling the root tools/call id during an Other prompt cancels its nested elicitation", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, questionRound());
  const selection = (await messages.next()).value;
  accept(child, selection, { choice: "__other__" });
  const other = (await messages.next()).value;
  notifyCancelled(child, 2);

  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assertNeutralCancellation(result.result.structuredContent, "cancel");

  accept(child, other, { choice__other_text: "Late response" });
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("root cancellation between accepted sequential steps prevents the next prompt", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, twoQuestionRound());
  const first = (await messages.next()).value;
  sendBatch(child, [
    { jsonrpc: "2.0", id: first.id, result: { action: "accept", content: { choice: "safe" } } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "Task cancelled" } },
  ]);

  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assertNeutralCancellation(result.result.structuredContent, "cancel");
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("legacy elicitation keeps primitive schemas while sequencing and accepts inline Other text", async (t) => {
  const { child, messages, initialized } = await startServer(t, {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { elicitation: {} },
  });
  assert.equal(initialized.result.protocolVersion, LEGACY_PROTOCOL_VERSION);
  const input = legacyRound();
  sendAsk(child, 2, input);

  const single = (await messages.next()).value;
  assert.equal(Object.hasOwn(single.params, "mode"), false);
  assert.match(single.params.message, /Question 1 of 2/);
  assert.deepEqual(Object.keys(single.params.requestedSchema.properties), ["choice", "__uq_q0_other_text"]);
  assert.deepEqual(single.params.requestedSchema.properties.choice.enum, ["safe", "fast", "__other__"]);
  assert.deepEqual(single.params.requestedSchema.properties.choice.enumNames, [
    "Safe path (Recommended)",
    "Fast path",
    "Other",
  ]);
  assert.equal(Object.hasOwn(single.params.requestedSchema.properties.choice, "oneOf"), false);
  assert.deepEqual(single.params.requestedSchema.properties.__uq_q0_other_text, {
    type: "string",
    title: "Choice — Other response",
    description: "Select Other to show this field, then type your answer.",
    maxLength: 4000,
  });
  assert.deepEqual(single.params.requestedSchema.required, ["choice"]);
  accept(child, single, { choice: "fast" });

  const multi = (await messages.next()).value;
  assert.equal(Object.hasOwn(multi.params, "mode"), false);
  assert.match(multi.params.message, /Question 2 of 2/);
  assert.deepEqual(Object.keys(multi.params.requestedSchema.properties), [
    "__uq_q1_o0",
    "__uq_q1_o1",
    "__uq_q1_other_selected",
    "__uq_q1_other_text",
  ]);
  assert.equal(multi.params.requestedSchema.properties.features, undefined);
  assert.equal(multi.params.requestedSchema.properties.__uq_q1_o0.type, "boolean");
  assert.equal(multi.params.requestedSchema.properties.__uq_q1_o0.title, "Features — One");
  assert.match(multi.params.requestedSchema.properties.__uq_q1_o0.description, /Use the first feature/);
  assert.equal(
    multi.params.requestedSchema.properties.__uq_q1_other_selected.title,
    "Features — Other",
  );
  assert.match(
    multi.params.requestedSchema.properties.__uq_q1_other_selected.description,
    /Select this to provide a different answer\./,
  );
  assert.deepEqual(multi.params.requestedSchema.properties.__uq_q1_other_text, {
    type: "string",
    title: "Features — Other response",
    description: "Select Other to show this field, then type your answer.",
    maxLength: 4000,
  });
  assert.equal(Object.values(multi.params.requestedSchema.properties).some((property) => property.type === "array"), false);
  assert.equal(Object.hasOwn(multi.params.requestedSchema, "required"), false);
  accept(child, multi, {
    __uq_q1_o1: true,
    __uq_q1_other_selected: true,
    __uq_q1_other_text: "  A custom feature  ",
  });

  assert.deepEqual((await messages.next()).value.result.structuredContent, {
    cancelled: false,
    cancel_reason: null,
    answers: {
      choice: { selected_option_ids: ["fast"], other_text: null },
      features: { selected_option_ids: ["two"], other_text: "A custom feature" },
    },
  });
  await closeServer(child);
});

test("legacy Other without usable inline text keeps the required one-field fallback", async (t) => {
  const { child, messages } = await startServer(t, {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { elicitation: {} },
  });
  sendAsk(child, 2, { round_id: "legacy-other-fallback", questions: [featuresQuestion()] });

  const selection = (await messages.next()).value;
  accept(child, selection, { __uq_q0_o0: true, __uq_q0_other_selected: true, __uq_q0_other_text: "  " });

  const other = (await messages.next()).value;
  assert.equal(Object.hasOwn(other.params, "mode"), false);
  assert.equal(other.params.message, "Question 1 of 1: Enter the Other answer for “Features”.");
  assert.deepEqual(Object.keys(other.params.requestedSchema.properties), ["__uq_q0_other_text"]);
  assert.deepEqual(other.params.requestedSchema.required, ["__uq_q0_other_text"]);
  assert.equal(other.params.requestedSchema.properties.__uq_q0_other_text.minLength, 1);
  accept(child, other, { __uq_q0_other_text: "  Legacy fallback  " });

  assert.deepEqual((await messages.next()).value.result.structuredContent.answers.features, {
    selected_option_ids: ["one"],
    other_text: "Legacy fallback",
  });
  await closeServer(child);
});

test("legacy optional single and multi questions may both be accepted empty", async (t) => {
  const { child, messages } = await startServer(t, {
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    capabilities: { elicitation: {} },
  });
  const input = {
    round_id: "legacy-optional-round",
    questions: [
      { ...questionRound().questions[0], required: false, allow_other: false },
      { ...featuresQuestion(), required: false, allow_other: false, min_selections: 0, max_selections: 2 },
    ],
  };
  sendAsk(child, 2, input);
  const single = (await messages.next()).value;
  assert.equal(Object.hasOwn(single.params.requestedSchema, "required"), false);
  accept(child, single, {});
  const multi = (await messages.next()).value;
  assert.equal(Object.hasOwn(multi.params.requestedSchema, "required"), false);
  accept(child, multi, {});

  assert.deepEqual((await messages.next()).value.result.structuredContent.answers, {
    choice: { selected_option_ids: [], other_text: null },
    features: { selected_option_ids: [], other_text: null },
  });
  await closeServer(child);
});

test("MCP tool reports unavailable when the host lacks native elicitation", async (t) => {
  const { child, messages } = await startServer(t, { capabilities: {} });
  sendAsk(child, 2, questionRound());
  const result = (await messages.next()).value;
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /does not support native form elicitation/);
  await closeServer(child);
});

test("MCP tool rejects URL-only elicitation capability for form questions", async (t) => {
  const { child, messages } = await startServer(t, { capabilities: { elicitation: { url: {} } } });
  sendAsk(child, 2, questionRound());
  const result = (await messages.next()).value;
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /does not support native form elicitation/);
  await closeServer(child);
});

test("initialize negotiates unsupported versions to the latest supported protocol", async (t) => {
  const { child, initialized } = await startServer(t, { protocolVersion: "unsupported-protocol-version" });
  assert.equal(initialized.result.protocolVersion, MODERN_PROTOCOL_VERSION);
  assert.notEqual(initialized.result.protocolVersion, "unsupported-protocol-version");
  await closeServer(child);
});

test("initialize rejects missing and invalid protocolVersion params", async (t) => {
  const child = spawnMcpServer(t);
  const messages = jsonLines(child.stdout);
  const baseParams = {
    capabilities: { elicitation: { form: {} } },
    clientInfo: { name: "user-questions-test", version: "1.0.0" },
  };
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: baseParams });
  assert.equal((await messages.next()).value.error.code, -32602);
  send(child, { jsonrpc: "2.0", id: 2, method: "initialize", params: { ...baseParams, protocolVersion: 20250618 } });
  assert.equal((await messages.next()).value.error.code, -32602);
  await closeServer(child);
});

test("initialized MCP server stays connected across its former idle window", async (t) => {
  const { child, messages } = await startServer(t, {
    env: { ...process.env, USER_QUESTIONS_IDLE_TIMEOUT_MS: "50" },
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await assertConnectionAlive(child, messages, 2);
  await closeServer(child);
});

test("each native elicitation waits for an explicit response before advancing", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, twoQuestionRound());
  const first = (await messages.next()).value;
  const pendingMessage = messages.next();
  const premature = await Promise.race([
    pendingMessage.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(premature, false);
  accept(child, first, { choice: "safe" });
  const second = (await pendingMessage).value;
  assert.match(second.params.message, /Question 2 of 2/);
  accept(child, second, { follow_up: "later" });
  assert.equal((await messages.next()).value.id, 2);
  await closeServer(child);
});

function questionRound() {
  return {
    round_id: "integration-round",
    questions: [{
      id: "choice", header: "Choice", question: "Which path should continue?", selection_mode: "single",
      options: [
        { id: "safe", label: "Safe path (Recommended)", description: "Use the lower-risk path." },
        { id: "fast", label: "Fast path", description: "Move faster with more risk." },
      ],
      allow_other: true,
    }],
  };
}

function featuresQuestion() {
  return {
    id: "features", header: "Features", question: "Which features?", selection_mode: "multiple",
    options: [
      { id: "one", label: "One", description: "Use the first feature." },
      { id: "two", label: "Two", description: "Use the second feature." },
    ],
    allow_other: true,
    required: true,
    min_selections: 1,
    max_selections: 3,
  };
}

function sequentialRound() {
  return {
    round_id: "sequential-round",
    questions: [
      questionRound().questions[0],
      featuresQuestion(),
      {
        id: "timing", header: "Timing", question: "When should this run?", selection_mode: "single",
        options: [
          { id: "now", label: "Now", description: "Run immediately." },
          { id: "later", label: "Later", description: "Wait until later." },
        ],
        allow_other: false,
        required: false,
      },
    ],
  };
}

function twoQuestionRound() {
  return {
    round_id: "two-question-round",
    questions: [
      questionRound().questions[0],
      {
        id: "follow_up", header: "Follow up", question: "What should happen next?", selection_mode: "single",
        options: [
          { id: "now", label: "Now", description: "Continue now." },
          { id: "later", label: "Later", description: "Continue later." },
        ],
        allow_other: true,
      },
    ],
  };
}

function legacyRound() {
  return {
    round_id: "legacy-round",
    questions: [questionRound().questions[0], featuresQuestion()],
  };
}

async function startServer(t, options = {}) {
  const child = spawnMcpServer(t, options.env);
  const messages = jsonLines(child.stdout);
  send(child, initializeMessage(
    1,
    options.protocolVersion || MODERN_PROTOCOL_VERSION,
    options.capabilities || { elicitation: { form: {} } },
  ));
  const initialized = (await messages.next()).value;
  return { child, messages, initialized };
}

function spawnMcpServer(t, env = process.env) {
  const child = spawn(process.execPath, [require.resolve("../mcp-server")], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  return child;
}

function initializeMessage(id, protocolVersion, capabilities) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities,
      clientInfo: { name: "user-questions-test", version: "1.0.0" },
    },
  };
}

function sendAsk(child, id, input) {
  send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask", arguments: input } });
}

function accept(child, elicitation, content) {
  respond(child, elicitation, { action: "accept", content });
}

function respond(child, elicitation, result) {
  send(child, { jsonrpc: "2.0", id: elicitation.id, result });
}

function notifyCancelled(child, request) {
  const requestId = typeof request === "object" ? request.id : request;
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, reason: "Escape pressed" },
  });
}

function assertNeutralCancellation(result, action) {
  assert.deepEqual(result, {
    cancelled: true,
    cancel_reason: action === "decline"
      ? "The question round was declined or blocked by the current approval policy"
      : "The question round was cancelled",
    answers: {},
  });
}

async function assertConnectionAlive(child, messages, id) {
  send(child, { jsonrpc: "2.0", id, method: "ping" });
  assert.equal((await messages.next()).value.id, id);
  assert.equal(child.exitCode, null);
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sendBatch(child, messages) {
  child.stdin.write(messages.map((message) => `${JSON.stringify(message)}\n`).join(""));
}

async function* jsonLines(stream) {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

async function closeServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error("MCP server did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
