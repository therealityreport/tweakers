"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createRoundState, reduceRoundState } = require("../round-state");
const { SemanticEvent, createSemanticDom, findByText, flushDom } = require("./semantic-dom");

const SOURCE = fs.readFileSync(require.resolve("../index"), "utf8");
const NONCE = "renderer-nonce-1234";
const NONCE_FIELD = `__tweakers_carrier_nonce_${NONCE}`;
const CARRIER_OTHER_FIELD = `__tweakers_carrier_other_${NONCE}`;

test("owned renderer is semantic, reducer-driven, accessible, and submits exact restored values", async () => {
  const harness = rendererHarness();
  await harness.start();

  const card = harness.card();
  assert.ok(card, "owned card mounted next to the exact carrier");
  assert.equal(card.tagName, "FORM");
  assert.equal(card.getAttribute("aria-label"), "User Questions");
  assert.match(card.className, /border-token-border/);
  assert.match(card.className, /bg-token-bg-primary/);
  assert.match(card.className, /rounded-lg/);
  assert.equal(card.getAttribute("style"), null, "owned card uses Codex tokens instead of detached inline styling");
  assert.equal(harness.carrier.hidden, true);
  assert.equal(harness.carrier.inert, true);
  assert.equal(harness.document.activeElement.tagName, "H2");
  assert.deepEqual(harness.deliveryAcks, [{ version: 1, stage: "owned_mount", contentRedacted: true }]);
  assert.equal(harness.controller.mountFocused, true, "ack happened only after connected focus and paint");
  assert.equal(card.querySelector("fieldset").querySelector("legend").textContent, "Scanner setup");
  assert.equal(card.querySelectorAll('input[type="radio"]').length, 0, "test DOM intentionally matches by semantic input properties, not CSS internals");
  assert.equal(card.querySelectorAll("input")[0].type, "radio");

  const details = findByText(card, "button", "More details");
  assert.equal(details.getAttribute("aria-expanded"), "false");
  details.click();
  await flushDom();
  assert.equal(findByText(harness.card(), "button", "More details").getAttribute("aria-expanded"), "true");
  assert.match(harness.card().textContent, /What you give up/);

  harness.card().querySelectorAll("input").find((input) => input.value === "built_in").click();
  await flushDom();
  findByText(harness.card(), "button", "Next").click();
  await flushDom();
  harness.card().querySelectorAll("input").find((input) => input.value === "email").click();
  await flushDom();
  harness.card().querySelectorAll("input").find((input) => input.value === "__other__").click();
  await flushDom();
  const textarea = harness.card().querySelector("textarea");
  assert.ok(textarea, "Other reveals a labelled text field");
  textarea.value = "Weekly digest";
  textarea.dispatchEvent(new SemanticEvent("change"));
  await flushDom();

  findByText(harness.card(), "button", "Review").click();
  await flushDom();
  assert.match(harness.card().textContent, /These choices guide this task\. They are not permanent rules\./);
  assert.match(harness.card().textContent, /Email, Other: Weekly digest/);
  const editButtons = harness.card().querySelectorAll("button").filter((button) => button.textContent === "Edit");
  assert.equal(editButtons.length, 2);
  editButtons[0].click();
  await flushDom();
  assert.match(harness.card().textContent, /Question 1 of 2/);
  assert.equal(harness.card().querySelectorAll("input").find((input) => input.value === "built_in").checked, true);
  findByText(harness.card(), "button", "Next").click();
  await flushDom();
  findByText(harness.card(), "button", "Review").click();
  await flushDom();
  findByText(harness.card(), "button", "Back").click();
  await flushDom();
  assert.equal(harness.card().querySelectorAll("input").find((input) => input.value === "email").checked, true);
  assert.equal(harness.card().querySelectorAll("input").find((input) => input.value === "__other__").checked, true);
  assert.equal(harness.card().querySelector("textarea").value, "Weekly digest");

  findByText(harness.card(), "button", "Review").click();
  await flushDom();
  findByText(harness.card(), "button", "Submit").click();
  await flushDom();
  assert.equal(harness.controller.continued, 1);
  assert.equal(harness.carrier.hidden, false);
  assert.equal(harness.card(), null);
  assert.deepEqual(harness.controller.hostValues.get(NONCE_FIELD), { kind: "radio", option: "built_in" });
  assert.equal(harness.controller.hostValues.has("notifications:email"), false, "only the carrier question is mirrored to the hidden host form");
  assert.equal(harness.controller.hostValues.has("notifications__other_text"), false, "later answers stay in the owned round state");
  assert.equal(harness.actionPayloads.every((action) => Object.isFrozen(action)), true, "IPC receives immutable cloned actions");

  await harness.stop();
});

test("carrier discovery accepts a bounded deep host ancestry", async () => {
  const harness = rendererHarness({ fiberDepth: 48 });
  await harness.start();
  assert.ok(harness.card(), "the renderer reaches the identity-bearing carrier beyond the old 12-fiber limit");
  assert.equal(harness.carrier.hidden, true);
  await harness.stop();
});

test("owned submission mirrors a first-question Other answer through the non-visible carrier text field", async () => {
  const harness = rendererHarness();
  await harness.start();
  harness.card().querySelectorAll("input").find((input) => input.value === "__other__").click();
  await flushDom();
  const textarea = harness.card().querySelector("textarea");
  textarea.value = "Carrier-specific answer";
  textarea.dispatchEvent(new SemanticEvent("change"));
  await flushDom();
  findByText(harness.card(), "button", "Next").click();
  await flushDom();
  findByText(harness.card(), "button", "Skip").click();
  await flushDom();
  findByText(harness.card(), "button", "Submit").click();
  await flushDom();
  assert.deepEqual(harness.controller.hostValues.get(NONCE_FIELD), { kind: "radio", option: "__other__" });
  assert.deepEqual(harness.controller.hostValues.get(CARRIER_OTHER_FIELD), { kind: "text", value: "Carrier-specific answer" });
  await harness.stop();
});

test("Resume and Start over consume the explicit immutable draft view model", async () => {
  const resumable = rendererHarness({ draft: true });
  await resumable.start();
  assert.match(resumable.card().textContent, /Continue your saved answers/);
  findByText(resumable.card(), "button", "Resume").click();
  await flushDom();
  assert.equal(resumable.actionPayloads[0].type, "resume");
  assert.match(resumable.card().textContent, /Question 1 of 2/);
  await resumable.stop();

  const discard = rendererHarness({ draft: true });
  await discard.start();
  findByText(discard.card(), "button", "Start over").click();
  await flushDom();
  assert.deepEqual(discard.actionPayloads.slice(0, 2).map((action) => action.type), ["discard", "claim"]);
  assert.match(discard.card().textContent, /Question 1 of 2/);
  await discard.stop();
});

test("Skip, Escape, keyboard submit, route drift, and delivery failure stay distinct and recoverable", async () => {
  const skipped = rendererHarness();
  await skipped.start();
  findByText(skipped.card(), "button", "Skip").click();
  await flushDom();
  assert.deepEqual(skipped.actionPayloads.slice(-2).map((action) => action.type), ["skip", "next"]);
  skipped.card().dispatchEvent(new SemanticEvent("keydown", { key: "Escape" }));
  await flushDom();
  assert.equal(skipped.controller.cancelled, 1);
  assert.equal(skipped.carrier.hidden, false);
  await skipped.stop();

  const failed = rendererHarness({ failActionOnce: true });
  await failed.start();
  failed.card().querySelectorAll("input").find((input) => input.value === "built_in").click();
  await flushDom();
  assert.match(failed.card().textContent, /Questions need attention/);
  assert.ok(findByText(failed.card(), "button", "Retry"));
  assert.ok(findByText(failed.card(), "button", "Resume"));
  findByText(failed.card(), "button", "Retry").click();
  await flushDom();
  assert.match(failed.card().textContent, /Question 1 of 2/);
  assert.equal(failed.currentState.answers.scanner_setup.selected_option_ids[0], "built_in");

  failed.controller.current = false;
  findByText(failed.card(), "button", "Next").click();
  await flushDom();
  assert.match(failed.card().textContent, /Questions need attention/);
  assert.equal(failed.logs.some((entry) => entry.includes("route_invalidated")), true);
  await failed.stop();
});

test("an uncertain committed submit Retry completes once without a blank card or duplicate host Continue", async () => {
  const harness = rendererHarness({ failSubmitAfterCommitOnce: true });
  await harness.start();
  harness.card().querySelectorAll("input").find((input) => input.value === "built_in").click();
  await flushDom();
  findByText(harness.card(), "button", "Next").click();
  await flushDom();
  harness.card().querySelectorAll("input").find((input) => input.value === "email").click();
  await flushDom();
  findByText(harness.card(), "button", "Review").click();
  await flushDom();
  findByText(harness.card(), "button", "Submit").click();
  await flushDom();

  assert.equal(harness.currentState.phase, "submitted", "server commit survived the lost response");
  assert.match(harness.card().textContent, /Questions need attention/);
  assert.equal(harness.controller.continued, 0);
  const retry = findByText(harness.card(), "button", "Retry");
  retry.click();
  retry.click();
  await flushDom(16);

  assert.equal(harness.controller.continued, 1);
  assert.equal(harness.card(), null);
  assert.equal(harness.actionPayloads.filter((action) => action.type === "submit").length, 2);
  await harness.stop();
});

test("validation feedback persists across rerender, is announced, described, and focuses the invalid choice", async () => {
  const harness = rendererHarness();
  await harness.start();
  findByText(harness.card(), "button", "Next").click();
  await flushDom();

  let alert = harness.card().querySelector('[data-uq-validation=""]');
  assert.equal(alert.textContent, "Choose an answer or Skip before continuing.");
  assert.equal(alert.getAttribute("role"), "alert");
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  assert.equal(harness.card().querySelector('[data-uq-live=""]').textContent, alert.textContent);
  const invalidChoice = harness.card().querySelector('input[aria-invalid="true"]');
  assert.ok(invalidChoice);
  assert.equal(invalidChoice.getAttribute("aria-describedby"), "uq-error-scanner_setup");
  assert.strictEqual(harness.document.activeElement, invalidChoice);

  findByText(harness.card(), "button", "More details").click();
  await flushDom();
  alert = harness.card().querySelector('[data-uq-validation=""]');
  assert.equal(alert.textContent, "Choose an answer or Skip before continuing.", "validation survives an unrelated rerender");
  harness.card().querySelectorAll("input").find((input) => input.value === "built_in").click();
  await flushDom();
  assert.equal(harness.card().querySelector('[data-uq-validation=""]'), null);
  await harness.stop();
});

test("blank Other feedback remains visible and accessibly linked until corrected", async () => {
  const harness = rendererHarness();
  await harness.start();
  findByText(harness.card(), "button", "Skip").click();
  await flushDom();
  harness.card().querySelectorAll("input").find((input) => input.value === "__other__").click();
  await flushDom();
  findByText(harness.card(), "button", "Review").click();
  await flushDom();

  const alert = harness.card().querySelector('[data-uq-validation=""]');
  const textarea = harness.card().querySelector("textarea");
  assert.equal(alert.textContent, "Enter an Other response before continuing.");
  assert.equal(textarea.getAttribute("aria-invalid"), "true");
  assert.equal(textarea.getAttribute("aria-describedby"), "uq-error-notifications");
  assert.strictEqual(harness.document.activeElement, harness.card().querySelector('input[aria-invalid="true"]'));

  textarea.value = "Weekly digest";
  textarea.dispatchEvent(new SemanticEvent("change"));
  await flushDom();
  assert.equal(harness.card().querySelector('[data-uq-validation=""]'), null);
  await harness.stop();
});

test("generic fallback acknowledges only a visible painted form and withholds acknowledgement when suppressed", async () => {
  const visible = rendererHarness({ genericFallback: true });
  await visible.start();
  assert.equal(visible.card(), null);
  assert.equal(visible.carrier.hidden, false);
  assert.deepEqual(visible.deliveryAcks, [{ version: 1, stage: "generic_mount", contentRedacted: true }]);
  await visible.stop();

  const hidden = rendererHarness({ genericFallback: true, genericHidden: true });
  await hidden.start();
  assert.equal(hidden.card(), null);
  assert.equal(hidden.carrier.hidden, true);
  assert.deepEqual(hidden.deliveryAcks, [], "display timeout remains armed because no generic mount acknowledgement was sent");
  assert.equal(hidden.logs.some((entry) => entry.includes("acknowledgement withheld")), true);
  await hidden.stop();
});

test("pre-interaction mount failure restores the generic form and exposes Retry", async () => {
  const harness = rendererHarness({ failMountAck: true });
  await harness.start();
  assert.equal(harness.carrier.hidden, false);
  assert.equal(harness.carrier.inert, false);
  assert.equal(harness.card(), null);
  const notice = harness.document.querySelector("[data-tweaker-user-questions-notice]");
  assert.ok(notice);
  assert.match(notice.textContent, /standard form/);
  assert.ok(findByText(notice, "button", "Retry"));
  await harness.stop();
});

test("repeated start/stop is idempotent and removes styles, cards, subscriptions, and notices", async () => {
  const harness = rendererHarness();
  await Promise.all([harness.tweak.start(harness.api), harness.tweak.start(harness.api)]);
  await flushDom();
  assert.equal(harness.document.querySelectorAll("[data-tweaker-user-questions-card]").length, 1);
  assert.equal(harness.document.querySelectorAll("[data-tweaker-user-questions-style]").length, 1);
  await Promise.all([harness.tweak.stop(), harness.tweak.stop()]);
  assert.equal(harness.document.querySelectorAll("[data-tweaker-user-questions-card]").length, 0);
  assert.equal(harness.document.querySelectorAll("[data-tweaker-user-questions-style]").length, 0);
  assert.equal(harness.carrier.hidden, false);
  assert.equal(harness.unobserved, 1);
  assert.equal(harness.unregistered, 1);
});

test("stop during an in-flight carrier claim releases the claim without mounting stale UI", async () => {
  const harness = rendererHarness({ deferClaim: true });
  await harness.start();
  assert.equal(harness.card(), null);

  await harness.stop();
  harness.resolveClaim();
  await flushDom(16);

  assert.equal(harness.card(), null);
  assert.equal(harness.document.querySelector("[data-tweaker-user-questions-notice]"), null);
  assert.equal(harness.document.querySelector("[data-tweaker-user-questions-style]"), null);
  assert.equal(harness.carrier.hidden, false);
  assert.equal(harness.carrier.inert, false);
  assert.equal(harness.releaseCalls, 1);
  assert.deepEqual(harness.deliveryAcks, []);
});

test("stop during a deferred Retry mount cannot recreate a stale notice", async () => {
  const harness = rendererHarness({ failMountAckOnce: true, deferDelivery: true });
  await harness.start();
  const notice = harness.document.querySelector("[data-tweaker-user-questions-notice]");
  assert.ok(notice);

  findByText(notice, "button", "Retry").click();
  await flushDom();
  await harness.stop();
  harness.resolveDelivery();
  await flushDom(16);

  assert.equal(harness.card(), null);
  assert.equal(harness.document.querySelector("[data-tweaker-user-questions-notice]"), null);
  assert.equal(harness.document.querySelector("[data-tweaker-user-questions-style]"), null);
  assert.equal(harness.carrier.hidden, false);
  assert.equal(harness.releaseCalls, 1);
});

test("long copy, narrow layout, zoom, reduced motion, and focus styles stay token-based and unclipped", async () => {
  const long = "Long plain-language explanation ".repeat(80);
  const harness = rendererHarness({ longCopy: long });
  harness.document.documentElement.style.zoom = "2";
  harness.document.body.style.inlineSize = "20rem";
  await harness.start();
  const card = harness.card();
  assert.match(card.textContent, /Long plain-language explanation/);
  assert.doesNotMatch(card.getAttribute("class") || "", /w-\[[0-9]+px\]/);
  const css = harness.document.querySelector("[data-tweaker-user-questions-style]").textContent;
  assert.match(css, /max-inline-size: 100%/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(card.textContent, /Recommended/);
  assert.match(card.querySelector("button").className, /focus-visible:ring-token-focus-border/);
  await harness.stop();
});

test("settings Preview, explicit Apply, persistent Restore, and redacted results use frozen T5 commands", async () => {
  const harness = rendererHarness({ restorable: true });
  await harness.start();
  const root = harness.document.createElement("section");
  harness.document.body.append(root);
  const cleanup = harness.page.render(root);
  await flushDom();
  assert.match(root.textContent, /Ordinary startup never changes policy/);
  assert.match(root.textContent, /previously applied policy change can be restored/);
  const profiles = root.querySelectorAll('[role="radio"]');
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].getAttribute("aria-checked"), "true");
  assert.match(profiles[0].textContent, /Maximum access/);
  profiles[1].click();
  assert.equal(profiles[1].getAttribute("aria-checked"), "true");
  assert.equal(findByText(root, "button", "Restore").hidden, false);
  const maximum = root.querySelectorAll('[role="radio"]').find((button) => button.textContent.includes("Maximum access"));
  assert.equal(maximum.getAttribute("aria-checked"), "false", "saved state is distinct from a Preview selection");
  assert.equal(findByText(root, "button", "Preview").disabled, true);
  maximum.click();
  await flushDom();
  assert.equal(maximum.getAttribute("aria-checked"), "true");
  assert.match(maximum.textContent, /Selected for preview/);
  findByText(root, "button", "Preview").click();
  await flushDom();
  assert.match(root.textContent, /Read-only Preview for Questions only: 2 field change/);
  assert.match(root.textContent, /source-fingerprint/);
  findByText(root, "button", "Apply previewed change").click();
  await flushDom();
  assert.match(root.textContent, /restart Codex later and verify a fresh task/);
  assert.doesNotMatch(root.textContent, /receipt|backup/i);
  findByText(root, "button", "Restore").click();
  await flushDom();
  assert.match(root.textContent, /No verified User Questions policy profile is saved/);
  assert.equal(findByText(root, "button", "Restore").hidden, true);
  cleanup();
  await harness.stop();
});

test("settings never present an overwritten Maximum access transaction as selected or saved", async () => {
  const harness = rendererHarness({
    policyStatus: {
      status: "overwritten",
      transactionId: "transaction-overwritten",
      profile: "maximum-access",
      targetCount: 83,
      appliedTargetCount: 0,
      beforeTargetCount: 83,
      otherTargetCount: 0,
      restartRequired: false,
      restarted: false,
    },
  });
  await harness.start();
  const root = harness.document.createElement("section");
  harness.document.body.append(root);
  const cleanup = harness.page.render(root);
  await flushDom();

  const maximum = root.querySelectorAll('[role="radio"]').find((button) => button.textContent.includes("Maximum access"));
  assert.equal(maximum.getAttribute("aria-checked"), "false");
  assert.doesNotMatch(maximum.textContent, /Saved for restart|Selected for preview/);
  assert.match(root.textContent, /Codex rewrote all 83 changed field/);
  assert.match(root.textContent, /It is not saved now/);
  assert.match(root.textContent, /restarting alone will not apply it/);
  assert.equal(findByText(root, "button", "Preview").disabled, true);

  maximum.click();
  await flushDom();
  assert.equal(maximum.getAttribute("aria-checked"), "true");
  assert.match(maximum.textContent, /Selected for preview/);
  assert.doesNotMatch(maximum.textContent, /Saved for restart/);
  cleanup();
  await harness.stop();
});

test("main startup never imports or invokes repairGlobalStateFile and cleans broker/handlers", async () => {
  let brokerStarts = 0;
  let brokerStops = 0;
  let repairReads = 0;
  const removed = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require(specifier) {
      if (specifier === "./main-broker") return {
        createMainBroker() {
          return {
            async start() { brokerStarts += 1; },
            async stop() { brokerStops += 1; },
            claim() {}, request() {}, release() {},
          };
        },
      };
      if (specifier === "./policy-state") return {
        createPolicyCommandInterface() {
          return {
            status: () => ({ status: "none", transactionId: null }),
            preview: () => ({}), apply: () => ({}), restore: () => ({}),
          };
        },
        get repairGlobalStateFile() { repairReads += 1; throw new Error("must not read repair shim"); },
      };
      throw new Error(`unexpected import ${specifier}`);
    },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "user-questions/index.js" });
  const tweak = sandbox.module.exports;
  await tweak.start({
    process: "main",
    manifest: { id: "co.tweakers.user-questions", permissions: ["ipc", "network"] },
    fs: { dataDir: "/tmp/test-only-user-questions" },
    log: { debug() {} },
    ipc: {
      sendToRenderer() { return true; },
      handleWithContext(channel) { return () => removed.push(channel); },
    },
  });
  await tweak.stop();
  assert.equal(brokerStarts, 1);
  assert.equal(brokerStops, 1);
  assert.equal(repairReads, 0);
  assert.equal(removed.length, 8);
});

function rendererHarness(options = {}) {
  const dom = createSemanticDom();
  const sandbox = {
    document: dom.document,
    requestAnimationFrame: dom.requestAnimationFrame,
    structuredClone,
    setImmediate,
    clearImmediate,
    module: { exports: {} },
    exports: {},
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: "user-questions/index.js" });
  const tweak = sandbox.module.exports;
  const carrier = dom.document.createElement("form");
  carrier.hidden = Boolean(options.genericHidden);
  const genericButton = dom.document.createElement("button");
  genericButton.type = "submit";
  genericButton.textContent = "Continue standard form";
  carrier.append(genericButton);
  dom.document.body.append(carrier);

  const input = questionInput(options.longCopy);
  let currentState = options.draft ? draftState(input) : claimState(input);
  let draft = options.draft
    ? { status: "available", resumable: true, expires_at: Date.now() + 10_000 }
    : { status: "none", resumable: false, expires_at: null };
  let failAction = Boolean(options.failActionOnce);
  let failSubmit = Boolean(options.failSubmitAfterCommitOnce);
  let policyStatus = options.policyStatus || (options.restorable
    ? {
        status: "restorable",
        transactionId: "transaction-123",
        profile: "maximum-access",
        targetCount: 2,
        appliedTargetCount: 2,
        beforeTargetCount: 0,
        otherTargetCount: 0,
        restartRequired: true,
        restarted: false,
      }
    : { status: "none", transactionId: null, restartRequired: false, restarted: false });
  const actionPayloads = [];
  const deliveryAcks = [];
  const logs = [];
  const hostValues = new Map();
  let page;
  let unobserved = 0;
  let unregistered = 0;
  let releaseCalls = 0;
  let resolveDeferredClaim = null;
  let resolveDeferredDelivery = null;
  let mountAckFailures = options.failMountAck
    ? Number.POSITIVE_INFINITY
    : options.failMountAckOnce
      ? 1
      : 0;
  const controller = {
    form: carrier,
    taskCardAnchor: carrier,
    current: true,
    mountFocused: false,
    continued: 0,
    cancelled: 0,
    hostValues,
    isCurrent() { return this.current && carrier.isConnected; },
    mountAcknowledgement(owner = "owned") {
      this.mountFocused = carrier.previousSibling
        ? dom.document.activeElement?.tagName === "H2"
        : dom.document.activeElement?.tagName === "H2";
      if (mountAckFailures > 0) {
        mountAckFailures -= 1;
        throw Object.assign(new Error("mount_ack_failed"), { code: "owned_mount" });
      }
      if (owner === "generic" && carrier.hidden) throw Object.assign(new Error("generic_form_hidden"), { code: "generic_mount_hidden" });
      return { version: 1, stage: owner === "generic" ? "generic_mount" : "owned_mount", contentRedacted: true };
    },
    setRadio(field, option) { hostValues.set(field, { kind: "radio", option }); },
    setCheckbox(field, option, checked) { hostValues.set(`${field}:${option}`, { kind: "checkbox", checked }); },
    setText(field, value) { hostValues.set(field, { kind: "text", value }); },
    continueNormally() { this.continued += 1; },
    cancelNormally() { this.cancelled += 1; },
  };
  const identityFiber = {
    memoizedProps: {
      elicitation: {
        kind: "formElicitation",
        schema: { type: "object", properties: schemaProperties(input) },
      },
      requestId: "request-one",
      conversationId: "conversation-one",
      hostId: "host-one",
    },
    return: null,
  };
  let fiber = identityFiber;
  for (let depth = 0; depth < (options.fiberDepth || 0); depth += 1) {
    fiber = { memoizedProps: {}, return: fiber };
  }
  const api = {
    process: "renderer",
    log: { warn(...args) { logs.push(args.map(String).join(" ")); }, debug() {}, info() {}, error() {} },
    settings: {
      registerPage(definition) {
        page = definition;
        return { unregister() { unregistered += 1; } };
      },
    },
    react: {
      getFiber(node) { return node === carrier ? fiber : null; },
      host: {
        observe() { return () => { unobserved += 1; }; },
        attachMcpFormCarrier(nonce) {
          if (nonce !== NONCE || !controller.current) return { status: "declined", reason: "nonce_not_in_schema" };
          return {
            status: "attached",
            identity: {
              requestId: "request-one",
              conversationId: "conversation-one",
              hostId: "host-one",
              schemaPropertyNames: options.genericFallback
                ? [NONCE_FIELD]
                : Object.keys(schemaProperties(input)),
            },
            controller,
            acknowledgement: { version: 1, stage: "carrier_attach", contentRedacted: true },
          };
        },
      },
    },
    ipc: {
      async invoke(channel, ...args) {
        if (channel === "claim") {
          if (options.deferClaim) {
            return new Promise((resolve) => {
              resolveDeferredClaim = () => resolve(view("claim-token", input, currentState, draft));
            });
          }
          return view("claim-token", input, currentState, draft);
        }
        if (channel === "delivery") {
          deliveryAcks.push(args.at(-1));
          if (options.deferDelivery && args.at(-1)?.stage === "owned_mount") {
            return new Promise((resolve) => {
              resolveDeferredDelivery = () => resolve({ accepted: true });
            });
          }
          return { accepted: true };
        }
        if (channel === "release") { releaseCalls += 1; return true; }
        if (channel === "action") {
          const action = args.at(-1);
          actionPayloads.push(action);
          if (failAction || (failSubmit && action.type === "submit")) {
            failAction = false;
            if (action.type === "submit") failSubmit = false;
            // Model an ambiguous transport failure after the reducer committed.
            const reduced = reduceRoundState(input, currentState, action);
            if (reduced.ok) currentState = reduced.value;
            throw Object.assign(new Error("request_timeout"), { code: "request_timeout" });
          }
          const reduced = reduceRoundState(input, currentState, action);
          if (!reduced.ok) return { ok: false, errors: reduced.errors, state: currentState, draft };
          currentState = reduced.value;
          if (action.type === "resume") draft = { status: "resumed", resumable: false, expires_at: null };
          if (action.type === "discard") draft = { status: "discarded", resumable: false, expires_at: null };
          return { ok: true, state: currentState, draft, delivery: { phase: "interacted", round_id: input.round_id, retryable: true } };
        }
        if (channel === "policy.status") return structuredClone(policyStatus);
        if (channel === "policy.preview") return {
          affectedFields: [{ name: "approvalPolicy", count: 2 }],
          affectedFieldCount: 2,
          affectedTaskCount: 1,
          sourceFingerprint: "source-fingerprint",
          previewToken: "preview-token",
          profile: args[0],
        };
        if (channel === "policy.apply") return { status: "applied", changed: true, transactionId: "transaction-new", restartRequired: true, restarted: false, profile: args[1] };
        if (channel === "policy.restore") return { status: "restored", changed: true, transactionId: "transaction-new", restartRequired: true, restarted: false };
        throw new Error(`unexpected IPC ${channel}`);
      },
    },
  };
  return {
    ...dom,
    tweak,
    api,
    carrier,
    controller,
    actionPayloads,
    deliveryAcks,
    logs,
    get page() { return page; },
    get unobserved() { return unobserved; },
    get unregistered() { return unregistered; },
    get releaseCalls() { return releaseCalls; },
    get currentState() { return currentState; },
    card: () => dom.document.querySelector("[data-tweaker-user-questions-card]"),
    resolveClaim() {
      assert.ok(resolveDeferredClaim, "deferred claim was not pending");
      const resolve = resolveDeferredClaim;
      resolveDeferredClaim = null;
      resolve();
    },
    resolveDelivery() {
      assert.ok(resolveDeferredDelivery, "deferred delivery was not pending");
      const resolve = resolveDeferredDelivery;
      resolveDeferredDelivery = null;
      resolve();
    },
    async start() { await tweak.start(api); await flushDom(); },
    async stop() { await tweak.stop(); await flushDom(); },
  };
}

function questionInput(longCopy = "") {
  return {
    round_id: "round-one",
    questions: [
      {
        id: "scanner_setup",
        header: "Scanner setup",
        question: "How should scanning be delivered?",
        selection_mode: "single",
        required: true,
        allow_other: true,
        min_selections: 1,
        max_selections: 1,
        options: [
          {
            id: "built_in",
            label: "Built into the app",
            description: longCopy || "The app handles scanning without separate setup.",
            details: "Runs inside the existing application lifecycle.",
            pros: ["Simpler daily use"],
            cons: ["More app maintenance"],
            gives_up: ["Independent upgrades"],
            recommended: true,
          },
          { id: "service", label: "Separate service", description: "Run scanning independently.", details: null, pros: [], cons: [], gives_up: [], recommended: false },
        ],
      },
      {
        id: "notifications",
        header: "Notifications",
        question: "Which updates should be sent?",
        selection_mode: "multiple",
        required: true,
        allow_other: true,
        min_selections: 1,
        max_selections: 3,
        options: [
          { id: "email", label: "Email", description: "Send an email update.", details: null, pros: [], cons: [], gives_up: [], recommended: false },
          { id: "desktop", label: "Desktop", description: "Show a desktop alert.", details: null, pros: [], cons: [], gives_up: [], recommended: true },
        ],
      },
    ],
  };
}

function schemaProperties(input) {
  return {
    [NONCE_FIELD]: { type: "string" },
    [CARRIER_OTHER_FIELD]: { type: "string" },
  };
}

function claimState(input) {
  const result = reduceRoundState(input, createRoundState(input), { type: "claim", revision: 0 });
  assert.equal(result.ok, true);
  return result.value;
}

function draftState(input) {
  let state = claimState(input);
  state = reduceRoundState(input, state, { type: "answer", revision: state.revision, question_id: "scanner_setup", selected_option_ids: ["service"] }).value;
  state = reduceRoundState(input, state, { type: "cancel_save", revision: state.revision }).value;
  return state;
}

function view(token, input, state, draft) {
  return {
    status: "claimed",
    claimToken: token,
    initial: {
      version: 1,
      input: structuredClone(input),
      state: structuredClone(state),
      delivery: { phase: "carrier_attached", round_id: input.round_id, retryable: true },
      draft: structuredClone(draft),
    },
  };
}
