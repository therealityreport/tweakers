"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { CARRIER_NONCE_PREFIX } = require("../broker-protocol");
const { createDraftStore } = require("../draft-store");
const { createMainBroker } = require("../main-broker");
const manifest = require("../manifest.json");
const { serializeToolResult } = require("../mcp-server");

const MODERN = "2025-11-25";
const LEGACY = "2025-06-18";
const TWEAK_ID = "co.tweakers.user-questions";
const ROUTE = Object.freeze({
  webContentsId: 73,
  hostId: "host-41",
  conversationId: "conversation-29",
});

test("modern MCP keeps generic fallback to one real question per form without carrier copy", async (t) => {
  const { child, messages, initialized } = await startServer(t);
  assert.equal(initialized.result.protocolVersion, MODERN);
  assert.equal(initialized.result.serverInfo.version, manifest.version);

  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tool = (await messages.next()).value.result.tools[0];
  assert.equal(tool.name, "ask");
  assert.match(tool.description, /single standard form/);
  assert.match(tool.description, /Cancellation and display failure are explicit terminal statuses/);
  assert.equal(tool.description.includes("request_user_input"), false);
  assert.equal(tool.inputSchema.properties.resume_token.type, "string");
  assert.deepEqual(tool.inputSchema.properties.questions.items.properties.options.items.properties.recommended, {
    type: "boolean",
    default: false,
  });

  sendAsk(child, 3, richRound());
  const form = (await messages.next()).value;
  assert.equal(form.method, "elicitation/create");
  assert.equal(form.params.mode, "form");
  assert.match(form.params.message, /Question 1 of 2/);
  const properties = form.params.requestedSchema.properties;
  assert.deepEqual(Object.keys(properties).sort(), ["delivery", "delivery__other_text"]);
  assert.equal(properties.delivery.type, "string");
  assert.deepEqual(properties.delivery.oneOf.slice(-2), [
    { const: "__skip__", title: "Skip this question" },
    { const: "__other__", title: "Other" },
  ]);
  assert.match(properties.delivery.description, /Details: This keeps scanning in the same workflow/);
  assert.match(properties.delivery.description, /Pros: Simpler day-to-day use/);
  assert.match(properties.delivery.description, /Cons: Adds maintenance inside the app/);
  assert.match(properties.delivery.description, /What you give up: Independent scanner upgrades/);
  assert.match(properties.delivery.oneOf[0].title, /\(Recommended\)$/);
  assertNoInternalCarrierCopy(form);

  accept(child, form, {
    delivery: "built_in",
  });
  const second = (await messages.next()).value;
  assert.equal(second.method, "elicitation/create");
  assert.match(second.params.message, /Question 2 of 2/);
  assert.deepEqual(Object.keys(second.params.requestedSchema.properties).sort(), ["proof", "proof__other_text"]);
  assert.equal(second.params.requestedSchema.properties.proof.type, "array");
  assertNoInternalCarrierCopy(second);
  accept(child, second, { proof: ["__skip__"] });
  const response = (await messages.next()).value;
  assert.equal(response.id, 3);
  assert.equal(response.result.isError, false);
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
  assert.deepEqual(response.result.structuredContent.answers, {
    delivery: { status: "answered", selected_option_ids: ["built_in"], other_text: null },
    proof: { status: "skipped", selected_option_ids: [], other_text: null },
  });
  assert.deepEqual(response.result.structuredContent.skipped_question_ids, ["proof"]);
  assert.equal(response.result.structuredContent.decision_guidance.semantics, "preference-not-policy");
  await assertConnectionAlive(child, messages, 4);
  await closeServer(child);
});

test("MCP serialization rejects an empty submitted result instead of returning success", () => {
  const response = serializeToolResult(richRound(), {
    status: "submitted",
    cancelled: false,
    answers: {},
  });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /needs at least [12] answers?/);
});

test("generic validation retains parsed values for exactly one bounded correction", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, richRound());
  const first = (await messages.next()).value;
  accept(child, first, {
    delivery: "__other__",
    delivery__other_text: "  ",
  });

  const correction = (await messages.next()).value;
  assert.match(correction.params.message, /Please correct this answer/);
  assert.deepEqual(correction.params.requestedSchema.properties.delivery.default, "__other__");
  assert.equal(Object.hasOwn(correction.params.requestedSchema.properties, "delivery__other_text"), true);
  assert.deepEqual(Object.keys(correction.params.requestedSchema.properties).sort(), ["delivery", "delivery__other_text"]);
  accept(child, correction, {
    delivery: "__other__",
    delivery__other_text: "Existing external scanner",
  });
  const second = (await messages.next()).value;
  assert.match(second.params.message, /Question 2 of 2/);
  accept(child, second, { proof: ["tests", "review"] });
  const result = (await messages.next()).value.result.structuredContent;
  assert.deepEqual(result.answers.delivery, {
    status: "answered",
    selected_option_ids: [],
    other_text: "Existing external scanner",
  });
  assert.deepEqual(result.answers.proof.selected_option_ids, ["tests", "review"]);
  await closeServer(child);
});

test("a second invalid correction fails once and never opens a third form", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, richRound());
  const first = (await messages.next()).value;
  accept(child, first, { delivery: "__other__", delivery__other_text: " " });
  const correction = (await messages.next()).value;
  accept(child, correction, { delivery: "__other__", delivery__other_text: " " });
  const result = (await messages.next()).value;
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /remain invalid after one correction/);
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("legacy MCP keeps one primitive question form at a time", async (t) => {
  const { child, messages, initialized } = await startServer(t, {
    protocolVersion: LEGACY,
    capabilities: { elicitation: {} },
  });
  assert.equal(initialized.result.protocolVersion, LEGACY);
  sendAsk(child, 2, richRound());
  const form = (await messages.next()).value;
  assert.equal(Object.hasOwn(form.params, "mode"), false);
  const properties = form.params.requestedSchema.properties;
  assert.deepEqual(properties.delivery.enum.slice(-2), ["__skip__", "__other__"]);
  assert.deepEqual(Object.keys(properties).sort(), ["__uq_q0_other_text", "delivery"]);
  assert.equal(JSON.stringify(form).includes("task-scoped marker"), false);
  accept(child, form, { delivery: "separate" });
  const second = (await messages.next()).value;
  const secondProperties = second.params.requestedSchema.properties;
  assert.equal(secondProperties.__uq_q1_o0.type, "boolean");
  assert.equal(secondProperties.__uq_q1_skip.type, "boolean");
  assert.equal(Object.values(secondProperties).some((property) => property.type === "array"), false);
  accept(child, second, {
    __uq_q1_o0: true,
    __uq_q1_o1: true,
  });
  const result = (await messages.next()).value.result.structuredContent;
  assert.deepEqual(result.answers.delivery.selected_option_ids, ["separate"]);
  assert.deepEqual(result.answers.proof.selected_option_ids, ["tests", "review"]);
  await closeServer(child);
});

test("explicit generic cancellation is final and reports the secure-binding limitation", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, richRound());
  const form = (await messages.next()).value;
  respond(child, form, { action: "cancel" });
  const result = (await messages.next()).value.result.structuredContent;
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.answers, {});
  assert.deepEqual(result.draft, { resumable: false, resume_token: null });
  assert.match(result.cancel_reason, /secure task binding unavailable/);
  await closeServer(child);
});

test("host empty/non-popup response is a content-free retryable delivery failure", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, richRound());
  const form = (await messages.next()).value;
  respond(child, form, { action: "accept", content: {} });
  const response = (await messages.next()).value.result;
  assert.deepEqual(response.structuredContent, {
    round_id: "rich-round",
    status: "display_failed",
    cancelled: true,
    cancel_reason: "question_ui_not_shown",
    answers: {},
    retryable: true,
    failure_stage: "host_empty_response",
  });
  assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
  await closeServer(child);
});

test("missing form capability returns explicit normalized tool-discovery failure", async (t) => {
  const { child, messages } = await startServer(t, { capabilities: {} });
  sendAsk(child, 2, richRound());
  const response = (await messages.next()).value.result;
  assert.equal(response.isError, false);
  assert.equal(response.structuredContent.status, "display_failed");
  assert.equal(response.structuredContent.failure_stage, "tool_discovery");
  assert.equal(response.content[0].text.includes("request_user_input"), false);
  await closeServer(child);
});

test("unacknowledged no-popup timeout returns once and rejects a late host response", async (t) => {
  const { child, messages } = await startServer(t, {
    env: { ...process.env, USER_QUESTIONS_DISPLAY_TIMEOUT_MS: "60" },
  });
  sendAsk(child, 2, richRound());
  const form = (await messages.next()).value;
  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assert.equal(result.result.structuredContent.failure_stage, "generic_mount");
  accept(child, form, { delivery: "built_in", proof: ["tests", "review"] });
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("carrier attachment stays intermediate, times out, and rejects a late visible mount", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, {
    env: { ...harness.env, USER_QUESTIONS_DISPLAY_TIMEOUT_MS: "120" },
  });
  sendAsk(child, 2, oneQuestionRound());
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  const attached = await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "carrier_attach",
    contentRedacted: true,
  });
  assert.deepEqual(attached, {
    accepted: true,
    phase: "carrier_attached",
    contentRedacted: true,
  });

  const result = (await nextMessageWithin(messages, 1_000)).value;
  assert.equal(result.id, 2);
  assert.equal(result.result.structuredContent.status, "display_failed");
  assert.equal(result.result.structuredContent.failure_stage, "owned_mount");
  assert.equal(result.result.structuredContent.retryable, true);
  await waitForInactiveClaim(harness.broker, claim.claimToken, ROUTE);
  await assert.rejects(
    harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
      version: 1,
      stage: "owned_mount",
      contentRedacted: true,
    }),
    /claim_inactive/,
  );
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("a visible mount after carrier attachment disarms the display timeout", async (t) => {
  const harness = await startBrokerHarness(t);
  const displayTimeoutMs = 180;
  const { child, messages } = await startServer(t, {
    env: { ...harness.env, USER_QUESTIONS_DISPLAY_TIMEOUT_MS: String(displayTimeoutMs) },
  });
  sendAsk(child, 2, oneQuestionRound());
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "carrier_attach",
    contentRedacted: true,
  });
  const mounted = await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
  assert.equal(mounted.phase, "owned_mounted");

  const pendingResult = messages.next();
  const resolvedBeforeHost = await Promise.race([
    pendingResult.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), displayTimeoutMs + 80)),
  ]);
  assert.equal(resolvedBeforeHost, false, "a proven visible mount must keep waiting for the host response");
  accept(child, form, { [carrierField(form)]: "built_in" });
  const result = (await pendingResult).value.result.structuredContent;
  assert.equal(result.status, "submitted");
  assert.deepEqual(result.answers.delivery.selected_option_ids, ["built_in"]);
  await closeServer(child);
});

test("root cancellation resolves the single nested form and returns one final result", async (t) => {
  const { child, messages } = await startServer(t);
  sendAsk(child, 2, richRound());
  const form = (await messages.next()).value;
  notifyCancelled(child, 2);
  const result = (await messages.next()).value;
  assert.equal(result.id, 2);
  assert.equal(result.result.structuredContent.status, "cancelled");
  accept(child, form, { delivery: "built_in", proof: ["tests", "review"] });
  await assertConnectionAlive(child, messages, 3);
  await closeServer(child);
});

test("broker claim/action path persists before acknowledgement and serializes identically to fallback", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  sendAsk(child, 2, oneQuestionRound());
  const form = (await messages.next()).value;
  const nonce = carrierField(form).slice(CARRIER_NONCE_PREFIX.length);
  const claim = await harness.broker.claim(nonce, ROUTE);
  assert.equal(claim.status, "claimed");
  assert.equal(claim.initial.state.phase, "question");
  assert.deepEqual(claim.initial.draft, { status: "none", resumable: false, expires_at: null });
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 1);
  await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
  let action = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "answer",
    revision: 1,
    question_id: "delivery",
    selected_option_ids: ["built_in"],
  });
  assert.equal(action.ok, true);
  action = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "next",
    revision: 2,
  });
  assert.equal(action.state.phase, "review");
  action = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "submit",
    revision: 3,
  });
  assert.equal(action.state.phase, "submitted");
  accept(child, form, { [carrierField(form)]: "built_in" });
  const owned = (await messages.next()).value.result;
  assert.deepEqual(JSON.parse(owned.content[0].text), owned.structuredContent);
  assert.deepEqual(owned.structuredContent.answers.delivery, {
    status: "answered",
    selected_option_ids: ["built_in"],
    other_text: null,
  });
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 0);

  sendAsk(child, 3, oneQuestionRound());
  const fallbackForm = (await messages.next()).value;
  accept(child, fallbackForm, { [carrierField(fallbackForm)]: "built_in" });
  const fallback = (await messages.next()).value.result;
  assert.deepEqual(fallback.structuredContent, owned.structuredContent);
  assert.deepEqual(JSON.parse(fallback.content[0].text), JSON.parse(owned.content[0].text));
  await closeServer(child);
});

test("task-scoped cancellation saves an opaque draft, rotates token on resume, and rejects cross-route resume", async (t) => {
  const harness = await startBrokerHarness(t);
  const first = await startServer(t, { env: harness.env });
  sendAsk(first.child, 2, oneQuestionRound());
  const form = (await first.messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "answer",
    revision: 1,
    question_id: "delivery",
    selected_option_ids: ["built_in"],
  });
  respond(first.child, form, { action: "cancel" });
  const cancelled = (await first.messages.next()).value.result.structuredContent;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.draft.resumable, true);
  assert.match(cancelled.draft.resume_token, /^[A-Za-z0-9_-]{32,128}$/);

  sendAsk(first.child, 3, { ...oneQuestionRound(), resume_token: cancelled.draft.resume_token });
  const resumedForm = (await first.messages.next()).value;
  const resumedClaim = await harness.broker.claim(
    carrierField(resumedForm).slice(CARRIER_NONCE_PREFIX.length),
    ROUTE,
  );
  assert.deepEqual(resumedClaim.initial.state.answers.delivery.selected_option_ids, ["built_in"]);
  assert.equal(resumedClaim.initial.state.phase, "cancelled");
  assert.equal(resumedClaim.initial.state.revision, 3);
  assert.equal(resumedClaim.initial.draft.status, "available");
  assert.equal(resumedClaim.initial.draft.resumable, true);
  assert.equal(Number.isSafeInteger(resumedClaim.initial.draft.expires_at), true);
  assert.equal(JSON.stringify(resumedClaim.initial.draft).includes(cancelled.draft.resume_token), false);
  await harness.broker.request(resumedClaim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
  const resumed = await harness.broker.request(resumedClaim.claimToken, ROUTE, "round.action", {
    type: "resume",
    revision: 3,
  });
  assert.equal(resumed.state.phase, "question");
  assert.equal(resumed.state.revision, 4, "resume continues the persisted CAS revision");
  assert.equal(resumed.draft.status, "resumed");
  assert.equal(resumed.draft.resumable, false);
  assert.equal(Number.isSafeInteger(resumed.draft.expires_at), true);
  assert.equal(resumed.draft.expires_at >= resumedClaim.initial.draft.expires_at, true);
  respond(first.child, resumedForm, { action: "cancel" });
  const recancelled = (await first.messages.next()).value.result.structuredContent;
  assert.equal(recancelled.draft.resumable, true);
  assert.notEqual(recancelled.draft.resume_token, cancelled.draft.resume_token);
  await closeServer(first.child);

  const store = createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID });
  assert.throws(
    () => store.load({
      taskRouteId: "f".repeat(64),
      roundId: "owned-round",
      input: oneQuestionRound(),
      resumeToken: recancelled.draft.resume_token,
    }),
    /draft_not_found/,
  );
});

test("resume mount timeouts leave the original token usable across repeated retries", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, {
    env: { ...harness.env, USER_QUESTIONS_DISPLAY_TIMEOUT_MS: "60" },
  });
  const token = await createCancelledRound(harness, child, messages, 2, { answer: "built_in" });
  const store = createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID });

  for (const id of [3, 4]) {
    sendAsk(child, id, { ...oneQuestionRound(), resume_token: token });
    const form = (await messages.next()).value;
    const claim = await harness.broker.claim(
      carrierField(form).slice(CARRIER_NONCE_PREFIX.length),
      ROUTE,
    );
    assert.equal(claim.initial.draft.status, "available");
    assert.deepEqual(claim.initial.state.answers.delivery.selected_option_ids, ["built_in"]);
    const failed = (await messages.next()).value.result.structuredContent;
    assert.equal(failed.status, "display_failed");
    assert.equal(failed.failure_stage, "owned_mount");
    assert.deepEqual(
      store.load({
        taskRouteId: claim.routeHash,
        roundId: "owned-round",
        input: claim.initial.input,
        resumeToken: token,
      }).state.answers.delivery.selected_option_ids,
      ["built_in"],
      "a failed display attempt must not consume the caller's token",
    );
  }
  sendAsk(child, 5, { ...oneQuestionRound(), resume_token: token });
  const unacknowledgedForm = (await messages.next()).value;
  const unacknowledgedClaim = await harness.broker.claim(
    carrierField(unacknowledgedForm).slice(CARRIER_NONCE_PREFIX.length),
    ROUTE,
  );
  await harness.broker.request(unacknowledgedClaim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "carrier_attach",
    contentRedacted: true,
  });
  respond(child, unacknowledgedForm, { action: "cancel" });
  const unacknowledgedCancellation = (await messages.next()).value.result.structuredContent;
  assert.equal(unacknowledgedCancellation.draft.resume_token, token);
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).load({
    taskRouteId: unacknowledgedClaim.routeHash,
    roundId: "owned-round",
    input: unacknowledgedClaim.initial.input,
    resumeToken: token,
  }).state.phase, "cancelled");
  await closeServer(child);
});

test("carrier-only resume never commits token rotation", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  const token = await createCancelledRound(harness, child, messages, 2, { answer: "built_in" });

  sendAsk(child, 3, { ...oneQuestionRound(), resume_token: token });
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "carrier_attach",
    contentRedacted: true,
  });
  const resumed = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "resume",
    revision: claim.initial.state.revision,
  });
  assert.equal(resumed.state.phase, "question");
  respond(child, form, { action: "cancel" });
  const cancelled = (await messages.next()).value.result.structuredContent;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.draft.resume_token, token);
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).load({
    taskRouteId: claim.routeHash,
    roundId: "owned-round",
    input: claim.initial.input,
    resumeToken: token,
  }).state.phase, "cancelled");
  await closeServer(child);
});

test("empty host response after owned submit preserves the last resumable state and token", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  const token = await createCancelledRound(harness, child, messages, 2, { answer: "built_in" });

  sendAsk(child, 3, { ...oneQuestionRound(), resume_token: token });
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
  const resumed = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "resume",
    revision: claim.initial.state.revision,
  });
  const reviewed = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "next",
    revision: resumed.state.revision,
  });
  const submitted = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "submit",
    revision: reviewed.state.revision,
  });
  assert.equal(submitted.state.phase, "submitted");
  accept(child, form, {});
  const failed = (await messages.next()).value.result.structuredContent;
  assert.equal(failed.status, "display_failed");
  assert.equal(failed.failure_stage, "host_empty_response");

  const loaded = createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).load({
    taskRouteId: claim.routeHash,
    roundId: "owned-round",
    input: claim.initial.input,
    resumeToken: token,
  });
  assert.equal(loaded.state.phase, "review");
  assert.equal(loaded.state.revision, reviewed.state.revision);
  assert.deepEqual(loaded.state.answers.delivery.selected_option_ids, ["built_in"]);
  await closeServer(child);
});

test("visible acknowledged resume rotates once on terminal cancellation and rejects the old token", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  const token = await createCancelledRound(harness, child, messages, 2, { answer: "built_in" });

  sendAsk(child, 3, { ...oneQuestionRound(), resume_token: token });
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  await harness.broker.request(claim.claimToken, ROUTE, "delivery.ack", {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
  await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "resume",
    revision: claim.initial.state.revision,
  });
  respond(child, form, { action: "cancel" });
  const cancelled = (await messages.next()).value.result.structuredContent;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.draft.resumable, true);
  assert.notEqual(cancelled.draft.resume_token, token);

  const store = createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID });
  assert.throws(
    () => store.load({
      taskRouteId: claim.routeHash,
      roundId: "owned-round",
      input: claim.initial.input,
      resumeToken: token,
    }),
    /resume_token_invalid/,
  );
  assert.equal(store.load({
    taskRouteId: claim.routeHash,
    roundId: "owned-round",
    input: claim.initial.input,
    resumeToken: cancelled.draft.resume_token,
  }).state.phase, "cancelled");
  await closeServer(child);
});

test("valid saved drafts expose explicit Resume/Start-over state and Start over clears only that record", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  const token = await createCancelledRound(harness, child, messages, 2);

  sendAsk(child, 3, { ...oneQuestionRound(), resume_token: token });
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  assert.equal(claim.initial.state.phase, "cancelled");
  assert.deepEqual(claim.initial.draft, {
    status: "available",
    resumable: true,
    expires_at: claim.initial.draft.expires_at,
  });
  const discarded = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "discard",
    revision: claim.initial.state.revision,
  });
  assert.equal(discarded.state.phase, "claiming");
  assert.deepEqual(discarded.state.answers.delivery, {
    status: "unanswered",
    selected_option_ids: [],
    other_text: null,
  });
  assert.deepEqual(discarded.draft, { status: "discarded", resumable: false, expires_at: null });
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 0);

  const fresh = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "claim",
    revision: discarded.state.revision,
  });
  assert.equal(fresh.state.phase, "question");
  assert.deepEqual(fresh.draft, { status: "none", resumable: false, expires_at: null });
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 1);
  accept(child, form, { [carrierField(form)]: "separate" });
  assert.deepEqual((await messages.next()).value.result.structuredContent.answers.delivery.selected_option_ids, ["separate"]);
  await closeServer(child);
});

test("invalid or expired-style resume tokens expose unavailable state without saved answer leakage", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  await createCancelledRound(harness, child, messages, 2, { answer: "built_in" });

  sendAsk(child, 3, { ...oneQuestionRound(), resume_token: "A".repeat(43) });
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  assert.equal(claim.initial.state.phase, "claiming");
  assert.deepEqual(claim.initial.state.answers.delivery, {
    status: "unanswered",
    selected_option_ids: [],
    other_text: null,
  });
  assert.deepEqual(claim.initial.draft, { status: "unavailable", resumable: false, expires_at: null });
  assert.equal(JSON.stringify(claim.initial).includes("built_in"), true, "input option remains visible");
  assert.deepEqual(claim.initial.state.answers.delivery.selected_option_ids, [], "saved answer is not exposed");

  const discarded = await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
    type: "discard",
    revision: 0,
  });
  assert.deepEqual(discarded.draft, { status: "discarded", resumable: false, expires_at: null });
  respond(child, form, { action: "cancel" });
  assert.equal((await messages.next()).value.result.structuredContent.status, "cancelled");
  await closeServer(child);
});

test("concurrent claimed tasks keep nonce, route, state, result, and scoped cleanup isolated", async (t) => {
  const harness = await startBrokerHarness(t);
  const { child, messages } = await startServer(t, { env: harness.env });
  const secondRoute = { webContentsId: 74, hostId: "host-42", conversationId: "conversation-30" };
  sendAsk(child, 2, oneQuestionRound());
  sendAsk(child, 3, alternateOneQuestionRound());
  const firstSeen = (await messages.next()).value;
  const secondSeen = (await messages.next()).value;
  const deliveryForm = carrierProperty(firstSeen).title === "Delivery" ? firstSeen : secondSeen;
  const timingForm = carrierProperty(firstSeen).title === "Timing" ? firstSeen : secondSeen;
  const deliveryClaim = await harness.broker.claim(
    carrierField(deliveryForm).slice(CARRIER_NONCE_PREFIX.length),
    ROUTE,
  );
  const timingClaim = await harness.broker.claim(
    carrierField(timingForm).slice(CARRIER_NONCE_PREFIX.length),
    secondRoute,
  );
  assert.notEqual(deliveryClaim.claimToken, timingClaim.claimToken);
  assert.notEqual(deliveryClaim.routeHash, timingClaim.routeHash);
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 2);

  accept(child, deliveryForm, { [carrierField(deliveryForm)]: "built_in" });
  accept(child, timingForm, { [carrierField(timingForm)]: "later" });
  const firstResult = (await messages.next()).value;
  const secondResult = (await messages.next()).value;
  const byId = new Map([[firstResult.id, firstResult], [secondResult.id, secondResult]]);
  assert.deepEqual(byId.get(2).result.structuredContent.answers.delivery.selected_option_ids, ["built_in"]);
  assert.deepEqual(byId.get(3).result.structuredContent.answers.timing.selected_option_ids, ["later"]);
  assert.equal(createDraftStore({ dataDir: harness.dataDir, tweakId: TWEAK_ID }).inspect().drafts, 0);
  await closeServer(child);
});

test("initialize validation and unsupported-version negotiation remain compatible", async (t) => {
  const child = spawnServer(t);
  const messages = jsonLines(child.stdout);
  const params = { capabilities: { elicitation: { form: {} } }, clientInfo: { name: "test", version: "1" } };
  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params });
  assert.equal((await messages.next()).value.error.code, -32602);
  send(child, { jsonrpc: "2.0", id: 2, method: "initialize", params: { ...params, protocolVersion: "future" } });
  assert.equal((await messages.next()).value.result.protocolVersion, MODERN);
  await closeServer(child);
});

function richRound() {
  return {
    round_id: "rich-round",
    questions: [
      {
        id: "delivery",
        header: "Delivery",
        question: "How should scanning be delivered?",
        selection_mode: "single",
        allow_other: true,
        options: [
          {
            id: "built_in",
            label: "Built into the app",
            description: "The app handles scanning.",
            details: "This keeps scanning in the same workflow.",
            pros: ["Simpler day-to-day use"],
            cons: ["Adds maintenance inside the app"],
            gives_up: ["Independent scanner upgrades"],
            recommended: true,
          },
          { id: "separate", label: "Separate scanner", description: "Use a separately managed tool." },
        ],
      },
      {
        id: "proof",
        header: "Proof",
        question: "Which checks should prove the result?",
        selection_mode: "multiple",
        required: true,
        min_selections: 2,
        max_selections: 2,
        allow_other: true,
        options: [
          { id: "tests", label: "Automated tests", description: "Run focused tests." },
          { id: "review", label: "Manual review", description: "Inspect the result." },
        ],
      },
    ],
  };
}

function oneQuestionRound() {
  return { round_id: "owned-round", questions: [richRound().questions[0]] };
}

function alternateOneQuestionRound() {
  return {
    round_id: "alternate-round",
    questions: [{
      id: "timing",
      header: "Timing",
      question: "When should this happen?",
      selection_mode: "single",
      allow_other: false,
      options: [
        { id: "now", label: "Now", description: "Continue now." },
        { id: "later", label: "Later", description: "Continue later." },
      ],
    }],
  };
}

async function startBrokerHarness(t) {
  if (process.platform === "win32") return t.skip("Unix-domain broker contract");
  const root = mkdtempSync(join(tmpdir(), "uq-mcp-broker-"));
  const dataDir = join(root, "data");
  const broker = createMainBroker({
    dataDir,
    tweakId: TWEAK_ID,
    permissions: ["ipc", "network"],
    socketPath: join(root, "broker.sock"),
    requestTimeoutMs: 1_000,
    registrationTimeoutMs: 1_000,
    sendToRenderer: () => true,
  });
  await broker.start();
  t.after(async () => {
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    broker,
    dataDir,
    env: {
      ...process.env,
      TWEAKER_TWEAK_DATA_DIR: dataDir,
      TWEAKER_TWEAK_ID: TWEAK_ID,
      USER_QUESTIONS_DISPLAY_TIMEOUT_MS: "1000",
    },
  };
}

async function createCancelledRound(harness, child, messages, id, options = {}) {
  sendAsk(child, id, oneQuestionRound());
  const form = (await messages.next()).value;
  const claim = await harness.broker.claim(carrierField(form).slice(CARRIER_NONCE_PREFIX.length), ROUTE);
  if (options.answer) {
    await harness.broker.request(claim.claimToken, ROUTE, "round.action", {
      type: "answer",
      revision: claim.initial.state.revision,
      question_id: "delivery",
      selected_option_ids: [options.answer],
    });
  }
  respond(child, form, { action: "cancel" });
  const result = (await messages.next()).value.result.structuredContent;
  assert.equal(result.status, "cancelled");
  assert.equal(result.draft.resumable, true);
  return result.draft.resume_token;
}

async function startServer(t, options = {}) {
  const child = spawnServer(t, options.env);
  const messages = jsonLines(child.stdout);
  send(child, initializeMessage(
    1,
    options.protocolVersion || MODERN,
    options.capabilities === undefined ? { elicitation: { form: {} } } : options.capabilities,
  ));
  return { child, messages, initialized: (await messages.next()).value };
}

function spawnServer(t, env = process.env) {
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

function accept(child, form, content) {
  respond(child, form, { action: "accept", content });
}

function respond(child, request, result) {
  send(child, { jsonrpc: "2.0", id: request.id, result });
}

function notifyCancelled(child, requestId) {
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, reason: "Escape pressed" },
  });
}

function carrierField(form) {
  const fields = Object.keys(form.params.requestedSchema.properties)
    .filter((key) => key.startsWith(CARRIER_NONCE_PREFIX));
  assert.equal(fields.length, 1);
  return fields[0];
}

function carrierProperty(form) {
  return form.params.requestedSchema.properties[carrierField(form)];
}

function assertNoInternalCarrierCopy(form) {
  const emitted = JSON.stringify({
    message: form.params.message,
    requestedSchema: form.params.requestedSchema,
  });
  assert.equal(emitted.includes("Keep this question round attached to the current task"), false);
  assert.equal(emitted.includes("This task-scoped marker lets the enhanced question card attach safely"), false);
}

async function assertConnectionAlive(child, messages, id) {
  send(child, { jsonrpc: "2.0", id, method: "ping" });
  assert.equal((await messages.next()).value.id, id);
  assert.equal(child.exitCode, null);
}

function nextMessageWithin(messages, timeoutMs) {
  let timeout;
  return Promise.race([
    messages.next(),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`MCP response exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function waitForInactiveClaim(broker, claimToken, route, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (broker.observeRoute(claimToken, route)) {
    if (Date.now() >= deadline) throw new Error(`broker claim remained active after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
}

async function closeServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
}

function waitForExit(child, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    const timeout = setTimeout(() => reject(new Error("MCP server did not exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
