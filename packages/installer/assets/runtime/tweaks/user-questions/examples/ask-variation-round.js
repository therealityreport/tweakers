"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const manifest = require("../manifest.json");

const PROTOCOL_VERSION = "2025-11-25";
const INITIALIZE_ID = 1;
const ASK_ID = 2;
const RESPONSE_TIMEOUT_MS = 5_000;
const CARRIER_PREFIX = "__tweakers_carrier_nonce_";
const input = JSON.parse(fs.readFileSync(path.join(__dirname, "variation-round.json"), "utf8"));
const scriptedContent = {
  improvements: ["faster", "accessible", "__other__"],
  improvements__other_text: "Clearer progress indicators",
  release_style: "preview",
  notifications: "__skip__",
  proof: ["automated_tests", "visual_check"],
};
const expectedResult = {
  round_id: input.round_id,
  status: "submitted",
  cancelled: false,
  cancel_reason: null,
  answers: {
    improvements: {
      status: "answered",
      selected_option_ids: ["faster", "accessible"],
      other_text: "Clearer progress indicators",
    },
    release_style: { status: "answered", selected_option_ids: ["preview"], other_text: null },
    notifications: { status: "skipped", selected_option_ids: [], other_text: null },
    proof: { status: "answered", selected_option_ids: ["automated_tests", "visual_check"], other_text: null },
  },
  skipped_question_ids: ["notifications"],
  decision_guidance: {
    scope: "current_task",
    authority: "preference",
    semantics: "preference-not-policy",
    on_conflict: "Explain the conflict, the pros and cons, and what must be given up. Ask before materially changing the selected direction.",
  },
  draft: { resumable: false, resume_token: null },
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
  let elicitationCount = 0;

  try {
    send(child, {
      jsonrpc: "2.0",
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "user-questions-rich-round-harness", version: "2.0.0" },
      },
    });

    const initialized = await nextMessage(messages, "initialize response");
    assert.equal(initialized.id, INITIALIZE_ID);
    assert.equal(initialized.error, undefined);
    assert.equal(initialized.result?.protocolVersion, PROTOCOL_VERSION);
    assert.equal(initialized.result?.serverInfo?.version, manifest.version);
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
        elicitationCount += 1;
        send(child, {
          jsonrpc: "2.0",
          id: message.id,
          result: { action: "accept", content: answerElicitation(message, elicitationCount - 1) },
        });
        continue;
      }

      assert.equal(message.id, ASK_ID, `unexpected server message: ${JSON.stringify(message)}`);
      assert.equal(message.error, undefined);
      assert.equal(message.result?.isError, false);
      assert.equal(elicitationCount, input.questions.length, "generic fallback should ask one question per form");
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

function answerElicitation(message, questionIndex) {
  assert.ok(message.id, "elicitation request is missing an id");
  assert.equal(message.params?.mode, "form");
  const question = input.questions[questionIndex];
  assert.ok(question, "generic fallback emitted too many question forms");
  assert.match(message.params.message, new RegExp(`Question ${questionIndex + 1} of ${input.questions.length}`));
  const schema = message.params.requestedSchema;
  const properties = schema?.properties;
  assert.ok(properties && typeof properties === "object" && !Array.isArray(properties));
  const expectedFields = [question.id];
  if (question.allow_other) expectedFields.push(`${question.id}__other_text`);
  assert.deepEqual(Object.keys(properties).sort(), expectedFields.sort(), "one host form must expose only its real question");
  assert.equal(properties[question.id].type, question.selection_mode === "multiple" ? "array" : "string");
  assert.match(properties[question.id].description, /Skip this question/);
  if (question.allow_other) assert.equal(properties[`${question.id}__other_text`].maxLength, 4000);
  if (questionIndex === 0) {
    assert.match(properties[question.id].description, /Details:/);
    assert.match(properties[question.id].description, /Pros:/);
    assert.match(properties[question.id].description, /Cons:/);
    assert.match(properties[question.id].description, /What you give up:/);
  }
  assert.ok(schema.required.includes(question.id), "generic form requires an explicit answer or Skip");
  const response = { [question.id]: scriptedContent[question.id] };
  if (question.allow_other && scriptedContent[`${question.id}__other_text`]) {
    response[`${question.id}__other_text`] = scriptedContent[`${question.id}__other_text`];
  }
  return response;
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
