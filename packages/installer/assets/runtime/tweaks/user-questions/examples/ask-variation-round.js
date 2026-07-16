"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PROTOCOL_VERSION = "2025-11-25";
const INITIALIZE_ID = 1;
const ASK_ID = 2;
const RESPONSE_TIMEOUT_MS = 5_000;
const input = JSON.parse(fs.readFileSync(path.join(__dirname, "variation-round.json"), "utf8"));
const scriptedAnswers = {
  improvements: {
    selection: ["faster", "accessible", "__other__"],
    otherText: "Clearer progress indicators",
  },
  release_style: { selection: ["preview"], otherText: null },
  notifications: { selection: [], otherText: null },
  proof: { selection: ["automated_tests", "visual_check"], otherText: null },
};
const expectedResult = {
  cancelled: false,
  cancel_reason: null,
  answers: {
    improvements: {
      selected_option_ids: ["faster", "accessible"],
      other_text: "Clearer progress indicators",
    },
    release_style: { selected_option_ids: ["preview"], other_text: null },
    notifications: { selected_option_ids: [], other_text: null },
    proof: { selected_option_ids: ["automated_tests", "visual_check"], other_text: null },
  },
};

void run().catch((error) => {
  process.stderr.write(`User Questions protocol harness failed: ${error.stack || error}\n`);
  process.exitCode = 1;
});

async function run() {
  const child = spawn(process.execPath, [path.join(__dirname, "../mcp-server.js")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const messages = jsonLines(child.stdout);
  const state = { questionIndex: 0, elicitationCount: 0 };

  try {
    send(child, {
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "user-questions-variation-harness", version: "1.0.0" },
      },
    });

    const initialized = await nextMessage(messages, "initialize response");
    assert.equal(initialized.id, INITIALIZE_ID);
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result?.protocolVersion, PROTOCOL_VERSION);
    send(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    send(child, {
      jsonrpc: "2.0",
      id: ASK_ID,
      method: "tools/call",
      params: { name: "ask", arguments: input },
    });

    while (true) {
      const message = await nextMessage(messages, "elicitation or ask result");
      if (message.method === "elicitation/create") {
        const content = answerElicitation(message, state);
        state.elicitationCount += 1;
        send(child, {
          jsonrpc: "2.0",
          id: message.id,
          result: { action: "accept", content },
        });
        continue;
      }

      assert.equal(message.id, ASK_ID, `unexpected server message: ${JSON.stringify(message)}`);
      assert.equal(message.error, undefined);
      assert.equal(message.result?.isError, false);
      assert.equal(state.questionIndex, input.questions.length, "ask completed before every question was elicited");
      assert.equal(state.elicitationCount, input.questions.length, "inline Other unexpectedly required a second elicitation");
      assert.deepEqual(message.result?.structuredContent, expectedResult);
      assert.deepEqual(JSON.parse(message.result.content[0].text), expectedResult);
      process.stdout.write(`${JSON.stringify(message.result.structuredContent, null, 2)}\n`);
      break;
    }

    child.stdin.end();
    const exit = await waitForExit(child);
    assert.deepEqual(exit, { code: 0, signal: null }, stderr || "MCP server exited unsuccessfully");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function answerElicitation(message, state) {
  assert.ok(message.id, "elicitation request is missing an id");
  assert.equal(message.params?.mode, "form");
  const question = input.questions[state.questionIndex];
  assert.ok(question, "received an elicitation after the final question");
  assert.match(message.params.message, new RegExp(`Question ${state.questionIndex + 1} of ${input.questions.length}`));
  const properties = message.params.requestedSchema?.properties;
  assert.ok(properties && typeof properties === "object" && !Array.isArray(properties));
  const answer = scriptedAnswers[question.id];
  assert.ok(answer, `missing scripted answer for ${question.id}`);

  const otherField = `${question.id}__other_text`;
  assert.deepEqual(
    Object.keys(properties),
    question.allow_other ? [question.id, otherField] : [question.id],
  );
  if (question.selection_mode === "multiple") {
    assert.equal(properties[question.id].type, "array");
  } else {
    assert.equal(properties[question.id].type, "string");
  }
  if (question.allow_other) {
    assert.equal(properties[otherField].type, "string");
    assert.equal(properties[otherField].maxLength, 4000);
    assert.equal(message.params.requestedSchema.required?.includes(otherField) || false, false);
  }

  const choseOther = answer.selection.includes("__other__");
  state.questionIndex += 1;
  if (answer.selection.length === 0) return {};
  const content = {
    [question.id]: question.selection_mode === "multiple"
      ? answer.selection
      : answer.selection[0],
  };
  if (choseOther) {
    assert.ok(answer.otherText, `missing scripted Other text for ${question.id}`);
    content[otherField] = answer.otherText;
  }
  return content;
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
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
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function nextMessage(messages, label) {
  let timeout;
  const result = await Promise.race([
    messages.next(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), RESPONSE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeout));
  if (result.done) throw new Error(`MCP server closed before ${label}`);
  return result.value;
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => reject(new Error("MCP server did not exit after stdin closed")), RESPONSE_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
