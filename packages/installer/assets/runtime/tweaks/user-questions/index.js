"use strict";

const states = new WeakMap();
const CARRIER_NONCE_PREFIX = "__tweakers_carrier_nonce_";
const CARD_ATTRIBUTE = "data-tweaker-user-questions-card";
const NOTICE_ATTRIBUTE = "data-tweaker-user-questions-notice";
const STYLE_ATTRIBUTE = "data-tweaker-user-questions-style";
const MAX_FIBER_DEPTH = 128;
const NONCE_PATTERN = /^[A-Za-z0-9._~-]{8,128}$/;
const OTHER_VALUE = "__other__";
const SKIP_VALUE = "__skip__";
const CARRIER_OTHER_TEXT_PREFIX = "__tweakers_carrier_other_";

module.exports = {
  async start(api) {
    if (states.has(this)) return states.get(this)?.started;
    const state = { process: api?.process, cleanups: [], sessions: new Map(), started: null };
    states.set(this, state);
    state.started = api?.process === "main"
      ? startMain(api, state)
      : startRenderer(api, state);
    try {
      await state.started;
    } catch (error) {
      await cleanupState(state);
      states.delete(this);
      throw error;
    }
  },

  async stop() {
    const state = states.get(this);
    if (!state) return;
    states.delete(this);
    try { await state.started; } catch {}
    await cleanupState(state);
  },
};

async function startMain(api, state) {
  const { createMainBroker } = require("./main-broker");
  const { createPolicyCommandInterface } = require("./policy-state");
  if (!api?.ipc?.handleWithContext || !api?.ipc?.sendToRenderer) {
    throw new Error("User Questions requires contextual IPC and exact-renderer delivery");
  }
  const broker = createMainBroker({
    dataDir: api.fs.dataDir,
    tweakId: api.manifest.id,
    permissions: api.manifest.permissions,
    sendToRenderer: (webContentsId, channel, ...args) => (
      api.ipc.sendToRenderer(webContentsId, channel, ...args)
    ),
    onDiagnostic: (record) => api.log.debug("User Questions broker", record),
  });
  state.cleanups.push(() => broker.stop());
  await broker.start();

  const route = (context, hostId, conversationId) => ({
    webContentsId: context.sender.webContentsId,
    hostId,
    conversationId,
  });
  registerMainHandler(state, api, "claim", (context, nonce, hostId, conversationId) => (
    broker.claim(nonce, route(context, hostId, conversationId))
  ));
  registerMainHandler(state, api, "action", (context, token, hostId, conversationId, action) => (
    broker.request(token, route(context, hostId, conversationId), "round.action", action)
  ));
  registerMainHandler(state, api, "delivery", (context, token, hostId, conversationId, acknowledgement) => (
    broker.request(token, route(context, hostId, conversationId), "delivery.ack", acknowledgement)
  ));
  registerMainHandler(state, api, "release", (context, token, hostId, conversationId) => (
    broker.release(token, route(context, hostId, conversationId))
  ));

  const policy = createPolicyCommandInterface();
  registerMainHandler(state, api, "policy.status", () => policy.status());
  registerMainHandler(state, api, "policy.preview", (_context, profile) => sanitizePolicyPreview(policy.preview(profile)));
  registerMainHandler(state, api, "policy.apply", (_context, previewToken, profile) => (
    sanitizePolicyResult(policy.apply(previewToken, profile))
  ));
  registerMainHandler(state, api, "policy.restore", (_context, transactionId) => (
    sanitizePolicyResult(policy.restore(transactionId))
  ));
}

function registerMainHandler(state, api, channel, handler) {
  const cleanup = api.ipc.handleWithContext(channel, handler);
  if (typeof cleanup === "function") state.cleanups.push(cleanup);
}

function sanitizePolicyPreview(preview) {
  return {
    affectedFields: preview.affectedFields.map(({ name, count }) => ({ name, count })),
    affectedFieldCount: preview.affectedFieldCount,
    affectedTaskCount: preview.affectedTaskCount,
    sourceFingerprint: preview.sourceFingerprint,
    previewToken: preview.previewToken,
    profile: preview.profile,
  };
}

function sanitizePolicyResult(result) {
  return {
    status: result.status,
    changed: result.changed,
    transactionId: result.transactionId,
    restartRequired: result.restartRequired,
    restarted: result.restarted,
    profile: result.profile,
  };
}

async function startRenderer(api, state) {
  if (typeof document === "undefined") return;
  if (!api?.react?.getFiber || !api?.react?.host?.attachMcpFormCarrier || !api?.ipc?.invoke) {
    throw new Error("User Questions requires the semantic host adapter and renderer IPC");
  }
  state.api = api;
  state.style = installStyle();
  state.cleanups.push(() => state.style?.remove?.());
  state.settings = registerSettingsPage(api);
  if (state.settings?.unregister) state.cleanups.push(() => state.settings.unregister());

  const scan = () => void scanForCarriers(api, state);
  const unobserve = api.react.host.observe?.(["assistant-turns"], scan);
  if (typeof unobserve === "function") state.cleanups.push(unobserve);
  scan();
}

async function scanForCarriers(api, state) {
  if (state.scanning || state.stopped) return;
  state.scanning = true;
  try {
    for (const form of document.querySelectorAll?.("form") || []) {
      if (state.stopped || state.sessions.has(form)) continue;
      const nonces = discoverCarrierNonces(api, form);
      if (nonces.length !== 1) continue;
      const attached = api.react.host.attachMcpFormCarrier(nonces[0]);
      if (attached.status !== "attached" || attached.controller.form !== form) continue;
      await claimCarrier(api, state, nonces[0], attached);
    }
  } finally {
    state.scanning = false;
  }
}

function discoverCarrierNonces(api, form) {
  const found = new Set();
  const seen = new Set();
  let fiber = api.react.getFiber(form);
  for (let depth = 0; fiber && depth < MAX_FIBER_DEPTH; depth += 1) {
    if (seen.has(fiber)) return [];
    seen.add(fiber);
    const props = record(fiber.memoizedProps);
    const elicitation = record(props?.elicitation);
    const schema = record(elicitation?.schema);
    const properties = record(schema?.properties);
    if (elicitation?.kind === "formElicitation" && schema?.type === "object" && properties) {
      for (const key of Object.keys(properties)) {
        if (!key.startsWith(CARRIER_NONCE_PREFIX)) continue;
        const nonce = key.slice(CARRIER_NONCE_PREFIX.length);
        if (NONCE_PATTERN.test(nonce)) found.add(nonce);
      }
    }
    fiber = fiber.return;
  }
  if (fiber) return [];
  return [...found];
}

async function claimCarrier(api, state, nonce, attached) {
  const { identity, controller } = attached;
  state.sessions.set(controller.form, { status: "claiming" });
  let session = null;
  try {
    const claim = await api.ipc.invoke("claim", nonce, identity.hostId, identity.conversationId);
    if (state.stopped) {
      state.sessions.delete(controller.form);
      if (claim?.status === "claimed" && claim.claimToken && claim.initial) {
        session = createSession(api, state, attached, claim);
        await releaseSession(session);
      }
      return;
    }
    if (claim?.status !== "claimed" || !claim.claimToken || !claim.initial) {
      throw new Error("claim rejected");
    }
    session = createSession(api, state, attached, claim);
    state.sessions.set(controller.form, session);
    if (!supportsOwnedForm(session.view.input, identity.schemaPropertyNames)) {
      session.deliveryOwner = "generic";
      session.formSnapshot = snapshotHostForm(controller.form);
      await acknowledgeVisibleGenericFallback(session);
      if (state.stopped) {
        await abandonStoppedSession(session);
        return;
      }
      await releaseSession(session);
      if (state.stopped) return;
      renderDeliveryNotice(controller.form, "This host form uses the compatible standard question layout.", () => {
        clearDeliveryNotices(controller.form);
      });
      return;
    }
    await mountSession(session);
  } catch (error) {
    if (state.stopped) {
      state.sessions.delete(controller.form);
      if (session) await abandonStoppedSession(session);
      return;
    }
    if (session?.deliveryOwner === "generic") {
      restoreHostForm(controller.form, session.formSnapshot);
      await releaseSession(session);
      if (state.stopped) return;
      api.log.warn("User Questions generic form was not visibly mounted; acknowledgement withheld", safeErrorCode(error));
    } else if (session) {
      state.sessions.set(controller.form, session);
      try {
        await acknowledgeVisibleGenericFallback(session);
      } catch (fallbackError) {
        api.log.warn("User Questions mount fallback was not visibly painted; acknowledgement withheld", safeErrorCode(fallbackError));
      }
      if (state.stopped) {
        await abandonStoppedSession(session);
        return;
      }
      renderMountRetry(session, "The enhanced question card could not open safely.");
    } else {
      state.sessions.delete(controller.form);
      restoreHostForm(controller.form, null);
      if (state.stopped) return;
      renderDeliveryNotice(controller.form, "Questions are still available in the standard form.", () => {
        clearDeliveryNotices(controller.form);
        void scanForCarriers(api, state);
      });
    }
    api.log.warn("User Questions owned card was not claimed; generic form preserved", safeErrorCode(error));
  }
}

function supportsOwnedForm(input, propertyNames) {
  const carrier = carrierFieldName(propertyNames);
  const firstQuestion = input.questions[0];
  if (!carrier || !firstQuestion) return false;
  const names = new Set(propertyNames);
  return !firstQuestion.allow_other || names.has(carrierOtherTextField(carrier));
}

function createSession(api, ownerState, attached, claim) {
  const initial = immutableClone(claim.initial);
  return {
    api,
    ownerState,
    controller: attached.controller,
    identity: attached.identity,
    claimToken: claim.claimToken,
    view: initial,
    card: null,
    formSnapshot: null,
    interacted: false,
    busy: false,
    closed: false,
    releaseAttempted: false,
    lastAction: null,
    initialDraftChoice: initial.draft?.resumable === true,
  };
}

async function mountSession(session) {
  const { controller } = session;
  if (session.ownerState.stopped) throw new Error("tweak_stopped");
  if (!controller.isCurrent()) throw new Error("carrier drifted before mount");
  clearDeliveryNotices(controller.form);
  session.returnFocus = document.activeElement;
  session.formSnapshot = hideHostForm(controller.form);
  const card = document.createElement("form");
  card.noValidate = true;
  card.setAttribute(CARD_ATTRIBUTE, "");
  card.setAttribute("aria-label", "User Questions");
  card.className = "border-token-border bg-token-bg-primary flex min-w-0 flex-col gap-4 rounded-lg border p-panel text-token-text-primary";
  card.addEventListener("submit", preventDefault);
  card.addEventListener("keydown", (event) => onCardKeydown(session, event));
  session.card = card;
  controller.taskCardAnchor.parentNode?.insertBefore?.(card, controller.taskCardAnchor);
  if (!card.isConnected) throw new Error("owned card did not connect");
  renderSession(session);
  const heading = card.querySelector('[data-uq-heading=""]');
  heading?.focus?.({ preventScroll: true });
  await survivePaint();
  if (session.ownerState.stopped) throw new Error("tweak_stopped");
  if (!card.isConnected || !controller.isCurrent() || document.activeElement !== heading) {
    failSession(session, "The enhanced question card could not open safely.", false);
    throw new Error("owned card failed mount acknowledgement gate");
  }
  try {
    const acknowledgement = controller.mountAcknowledgement("owned");
    await invokeSession(session, "delivery", acknowledgement);
    if (session.ownerState.stopped) throw new Error("tweak_stopped");
  } catch (error) {
    failSession(session, "The enhanced question card could not confirm delivery.", false);
    throw error;
  }
}

function renderSession(session) {
  const { card, view } = session;
  if (!card || session.closed) return;
  card.replaceChildren();
  const live = element("div", "sr-only", "");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("data-uq-live", "");
  card.append(live);

  if (session.failure) {
    renderFailure(session);
  } else if (session.initialDraftChoice) {
    renderDraftChoice(session);
  } else if (view.state.phase === "review") {
    renderReview(session);
  } else if (view.state.phase === "question") {
    renderQuestion(session);
  } else if (view.state.phase === "submitted") {
    renderSubmittedRecovery(session);
  }
}

function renderHeader(session, title, progressText) {
  const header = element("div", "flex min-w-0 items-start justify-between gap-3");
  const copy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  const progress = element("div", "text-sm text-token-text-secondary", progressText);
  const heading = element("h2", "text-base font-medium text-token-text-primary", title);
  heading.tabIndex = -1;
  heading.setAttribute("data-uq-heading", "");
  copy.append(progress, heading);
  const close = button("Close and save", "Close questions and save a resumable draft", () => closeAndSave(session));
  close.className = "rounded-md p-2 text-token-text-secondary hover:bg-token-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
  close.textContent = "×";
  header.append(copy, close);
  session.card.append(header);
}

function renderDraftChoice(session) {
  renderHeader(session, "Continue your saved answers?", "Saved question round");
  session.card.append(element("p", "text-sm text-token-text-secondary", "Resume exactly where you left off, or start over and discard only this saved round."));
  const actions = element("div", "flex flex-wrap justify-end gap-2");
  actions.append(
    actionButton("Start over", "secondary", async () => {
      session.initialDraftChoice = false;
      await sendAction(session, { type: "discard", revision: session.view.state.revision });
      if (session.view.state.phase === "claiming") {
        await sendAction(session, { type: "claim", revision: session.view.state.revision });
      }
    }),
    actionButton("Resume", "primary", async () => {
      session.initialDraftChoice = false;
      await sendAction(session, {
        type: "resume",
        revision: session.view.state.revision,
      });
      if (!session.failure) focusHeading(session);
    }),
  );
  session.card.append(actions);
}

function renderQuestion(session) {
  const { input, state } = session.view;
  const index = input.questions.findIndex((question) => question.id === state.current_question_id);
  const question = input.questions[index];
  if (!question) return failSession(session, "This question is no longer available.", session.interacted);
  renderHeader(session, question.question, `Question ${index + 1} of ${input.questions.length}`);
  const progress = element("div", "h-1 w-full overflow-hidden rounded-full bg-token-foreground/10");
  const bar = element("div", "h-full bg-token-charts-blue");
  bar.style.width = `${Math.round(((index + 1) / input.questions.length) * 100)}%`;
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-valuemin", "1");
  progress.setAttribute("aria-valuemax", String(input.questions.length));
  progress.setAttribute("aria-valuenow", String(index + 1));
  progress.append(bar);
  session.card.append(progress);

  const fieldset = element("fieldset", "flex min-w-0 flex-col gap-2");
  fieldset.append(element("legend", "sr-only", question.header));
  const answer = state.answers[question.id];
  for (const option of question.options) fieldset.append(renderOption(session, question, answer, option));
  if (question.allow_other) fieldset.append(renderOther(session, question, answer));
  const error = state.validation_errors?.[question.id];
  if (error) {
    const errorId = `uq-error-${safeDomId(question.id)}`;
    fieldset.setAttribute("aria-invalid", "true");
    fieldset.setAttribute("aria-describedby", errorId);
    for (const control of fieldset.querySelectorAll("input, textarea")) {
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", errorId);
    }
    const message = element("p", "text-sm text-token-charts-red", String(error));
    message.id = errorId;
    message.setAttribute("role", "alert");
    message.setAttribute("aria-live", "assertive");
    message.setAttribute("data-uq-validation", "");
    session.card.append(fieldset, message);
  } else {
    session.card.append(fieldset);
  }
  renderQuestionFooter(session, index);
}

function renderOption(session, question, answer, option) {
  const wrapper = element("div", "border-token-border flex min-w-0 flex-col rounded-lg border");
  const row = element("div", "flex min-w-0 items-start gap-3 p-3");
  const input = document.createElement("input");
  input.type = question.selection_mode === "multiple" ? "checkbox" : "radio";
  input.name = `uq-${question.id}`;
  input.value = option.id;
  input.checked = answer.selected_option_ids.includes(option.id);
  input.className = "mt-1 shrink-0 accent-token-charts-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
  input.addEventListener("change", () => chooseOption(session, question, answer, option.id, input.checked));
  const content = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  const label = element("label", "flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium text-token-text-primary");
  label.append(input, document.createTextNode(option.label));
  if (option.recommended) label.append(element("span", "rounded-full bg-token-charts-blue/10 px-2 py-0.5 text-sm text-token-charts-blue", "Recommended"));
  content.append(label, element("p", "text-sm text-token-text-secondary", option.description));
  if (optionHasDetails(option)) content.append(detailsDisclosure(session, question, option));
  row.append(content);
  wrapper.append(row);
  return wrapper;
}

function detailsDisclosure(session, question, option) {
  const key = `${question.id}:${option.id}`;
  const expanded = session.view.state.expanded_detail_ids.includes(key);
  const id = `uq-details-${safeDomId(question.id)}-${safeDomId(option.id)}`;
  const container = element("div", "flex min-w-0 flex-col gap-2");
  const disclosure = actionButton("More details", "link", () => sendAction(session, {
    type: "details",
    revision: session.view.state.revision,
    question_id: question.id,
    option_id: option.id,
    expanded: !expanded,
  }));
  disclosure.setAttribute("aria-expanded", String(expanded));
  disclosure.setAttribute("aria-controls", id);
  container.append(disclosure);
  if (expanded) {
    const details = element("div", "border-token-border flex min-w-0 flex-col gap-2 border-l pl-3 text-sm text-token-text-secondary");
    details.id = id;
    appendDetailSection(details, "Details", option.details ? [option.details] : []);
    appendDetailSection(details, "Pros", option.pros);
    appendDetailSection(details, "Cons", option.cons);
    appendDetailSection(details, "What you give up", option.gives_up);
    container.append(details);
  }
  return container;
}

function renderOther(session, question, answer) {
  const selected = session.view.state.other_selected_question_ids.includes(question.id);
  const wrapper = element("div", "border-token-border flex min-w-0 flex-col gap-2 rounded-lg border p-3");
  const label = element("label", "flex min-w-0 items-center gap-3 text-sm font-medium text-token-text-primary");
  const input = document.createElement("input");
  input.type = question.selection_mode === "multiple" ? "checkbox" : "radio";
  input.name = `uq-${question.id}`;
  input.value = OTHER_VALUE;
  input.checked = selected;
  input.className = "shrink-0 accent-token-charts-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
  input.addEventListener("change", () => chooseOther(session, question, input.checked));
  label.append(input, document.createTextNode("Other"));
  wrapper.append(label);
  if (selected) {
    const textLabel = element("label", "flex min-w-0 flex-col gap-1 text-sm text-token-text-primary", "Other response");
    const text = document.createElement("textarea");
    text.rows = 3;
    text.maxLength = 4000;
    text.value = answer.other_text || "";
    text.setAttribute("aria-required", "true");
    text.className = "border-token-border bg-token-bg-primary min-w-0 resize-y rounded-md border p-3 text-sm text-token-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
    text.addEventListener("change", () => sendAction(session, {
      type: "other",
      revision: session.view.state.revision,
      question_id: question.id,
      selected: true,
      other_text: text.value,
    }));
    textLabel.append(text);
    wrapper.append(textLabel);
  }
  return wrapper;
}

function renderQuestionFooter(session, index) {
  const count = session.view.input.questions.length;
  const footer = element("div", "flex flex-wrap items-center justify-between gap-2");
  const left = element("div", "flex flex-wrap gap-2");
  if (index > 0) left.append(actionButton("Back", "secondary", () => sendSimpleAction(session, "back")));
  left.append(actionButton("Skip", "secondary", async () => {
    await sendSimpleAction(session, "skip");
    if (!session.failure) await sendSimpleAction(session, "next");
  }));
  footer.append(left, actionButton(index === count - 1 ? "Review" : "Next", "primary", () => sendSimpleAction(session, "next")));
  session.card.append(footer);
}

function renderReview(session) {
  renderHeader(session, "Review your choices", "Ready to submit");
  session.card.append(element("p", "text-sm text-token-text-secondary", "These choices guide this task. They are not permanent rules."));
  const list = element("div", "border-token-border flex min-w-0 flex-col divide-y-[0.5px] divide-token-border rounded-lg border");
  for (const question of session.view.input.questions) {
    const answer = session.view.state.answers[question.id];
    const row = element("div", "flex min-w-0 items-start justify-between gap-3 p-3");
    const copy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
    copy.append(element("div", "text-sm font-medium text-token-text-primary", question.question));
    copy.append(element("div", "text-sm text-token-text-secondary", answerSummary(
      question,
      answer,
      session.view.state.other_selected_question_ids.includes(question.id),
    )));
    row.append(copy, actionButton("Edit", "link", () => sendAction(session, {
      type: "edit",
      revision: session.view.state.revision,
      question_id: question.id,
    })));
    list.append(row);
  }
  session.card.append(list);
  const footer = element("div", "flex flex-wrap justify-between gap-2");
  footer.append(actionButton("Back", "secondary", () => sendSimpleAction(session, "back")), actionButton("Submit", "primary", () => submitRound(session)));
  session.card.append(footer);
}

function renderFailure(session) {
  renderHeader(session, "Questions need attention", "Delivery interrupted");
  const message = element("p", "text-sm text-token-text-secondary", session.failure.message);
  message.setAttribute("role", "alert");
  session.card.append(message);
  const actions = element("div", "flex flex-wrap justify-end gap-2");
  if (session.interacted) actions.append(actionButton("Resume", "secondary", () => {
    session.failure = null;
    renderSession(session);
    focusHeading(session);
  }));
  actions.append(actionButton("Retry", "primary", () => retrySession(session)));
  session.card.append(actions);
}

function renderSubmittedRecovery(session) {
  session.hostSubmissionPending = true;
  renderHeader(session, "Your choices are saved", "Finishing delivery");
  const message = element("p", "text-sm text-token-text-secondary", "Retry to finish sending these choices to the current task.");
  message.setAttribute("role", "status");
  session.card.append(message, actionButton("Retry", "primary", () => retrySession(session)));
}

async function chooseOption(session, question, answer, optionId, checked) {
  let selected = [...answer.selected_option_ids];
  if (question.selection_mode === "single") selected = checked ? [optionId] : [];
  else if (checked && !selected.includes(optionId)) selected.push(optionId);
  else if (!checked) selected = selected.filter((id) => id !== optionId);
  if (question.selection_mode === "single" && session.view.state.other_selected_question_ids.includes(question.id)) {
    await sendAction(session, {
      type: "other",
      revision: session.view.state.revision,
      question_id: question.id,
      selected: false,
      other_text: null,
    });
  }
  if (!session.failure) await sendAction(session, {
    type: "answer",
    revision: session.view.state.revision,
    question_id: question.id,
    selected_option_ids: selected,
  });
}

async function chooseOther(session, question, checked) {
  if (checked && question.selection_mode === "single") {
    await sendAction(session, {
      type: "answer",
      revision: session.view.state.revision,
      question_id: question.id,
      selected_option_ids: [],
    });
  }
  if (!session.failure) await sendAction(session, {
    type: "other",
    revision: session.view.state.revision,
    question_id: question.id,
    selected: checked,
    other_text: checked ? "" : null,
  });
  if (checked && !session.failure) session.card.querySelector("textarea")?.focus?.();
}

function sendSimpleAction(session, type) {
  return sendAction(session, { type, revision: session.view.state.revision });
}

async function sendAction(session, action) {
  if (session.busy || session.closed) return false;
  const immutableAction = immutableClone(action);
  session.busy = true;
  session.lastAction = immutableAction;
  session.interacted = session.interacted || immutableAction.type !== "details";
  setBusy(session, true);
  try {
    const result = await invokeSession(session, "action", immutableAction);
    if (result?.state) session.view = immutableClone({
      ...session.view,
      state: result.state,
      delivery: result.delivery || session.view.delivery,
      draft: result.draft || session.view.draft,
    });
    session.failure = null;
    if (immutableAction.type === "submit" && result?.state?.phase === "submitted") {
      session.hostSubmissionPending = true;
      await completeHostSubmission(session);
      return true;
    }
    renderSession(session);
    const validationMessage = currentValidationMessage(session);
    if (!result?.ok) {
      announce(session, Array.isArray(result?.errors) ? result.errors.join(". ") : "That action could not be completed.");
    } else if (validationMessage && ["next", "review", "submit"].includes(immutableAction.type)) {
      announce(session, validationMessage);
      focusValidationControl(session);
    }
    return result?.ok === true;
  } catch (error) {
    failSession(session, "Your answers are saved, but the question service stopped responding.", true);
    session.api.log.warn("User Questions action delivery failed", safeErrorCode(error));
    return false;
  } finally {
    session.busy = false;
    setBusy(session, false);
  }
}

async function retrySession(session) {
  if (session.hostSubmissionPending) {
    session.failure = null;
    await completeHostSubmission(session);
    return;
  }
  const action = session.lastAction;
  session.failure = null;
  if (!action) {
    try {
      await invokeSession(session, "delivery", session.controller.mountAcknowledgement("owned"));
      renderSession(session);
    } catch {
      failSession(session, "Delivery still could not be confirmed. You can retry again.", session.interacted);
    }
    return;
  }
  await sendAction(session, action);
}

async function submitRound(session) {
  await sendSimpleAction(session, "submit");
}

async function completeHostSubmission(session) {
  if (session.hostSubmissionComplete) return;
  if (session.hostSubmissionPromise) return session.hostSubmissionPromise;
  const completion = (async () => {
    try {
      populateHostForm(session);
      restoreHostForm(session.controller.form, session.formSnapshot);
      session.controller.continueNormally();
      session.hostSubmissionComplete = true;
      session.hostSubmissionPending = false;
      session.card?.remove?.();
      await releaseSession(session);
    } catch (error) {
      failSession(session, "Your choices are saved. Retry to finish sending them.", true);
      session.api.log.warn("User Questions host submission failed", safeErrorCode(error));
    }
  })();
  session.hostSubmissionPromise = completion;
  try {
    return await completion;
  } finally {
    if (session.hostSubmissionPromise === completion) session.hostSubmissionPromise = null;
  }
}

function populateHostForm(session) {
  const names = new Set(session.identity.schemaPropertyNames);
  const carrier = carrierFieldName(session.identity.schemaPropertyNames);
  if (carrier) {
    const question = session.view.input.questions[0];
    if (!question) throw new Error("carrier question is missing");
    const answer = session.view.state.answers[question.id];
    if (!answer) throw new Error("carrier answer is missing");
    const values = answer.status === "skipped"
      ? [SKIP_VALUE]
      : [
          ...answer.selected_option_ids,
          ...(session.view.state.other_selected_question_ids.includes(question.id) ? [OTHER_VALUE] : []),
        ];
    if (question.selection_mode === "single") {
      session.controller.setRadio(carrier, values[0]);
    } else {
      const allValues = [...question.options.map((option) => option.id), SKIP_VALUE, ...(question.allow_other ? [OTHER_VALUE] : [])];
      for (const value of allValues) session.controller.setCheckbox(carrier, value, values.includes(value));
    }
    const otherField = carrierOtherTextField(carrier);
    if (question.allow_other && names.has(otherField)) {
      session.controller.setText(otherField, answer.other_text || "");
    }
    return;
  }
  for (const [index, question] of session.view.input.questions.entries()) {
    const answer = session.view.state.answers[question.id];
    const values = answer.status === "skipped"
      ? [SKIP_VALUE]
      : [
          ...answer.selected_option_ids,
          ...(session.view.state.other_selected_question_ids.includes(question.id) ? [OTHER_VALUE] : []),
        ];
    if (names.has(question.id)) {
      if (question.selection_mode === "single") session.controller.setRadio(question.id, values[0]);
      else {
        const allValues = [...question.options.map((option) => option.id), SKIP_VALUE, ...(question.allow_other ? [OTHER_VALUE] : [])];
        for (const value of allValues) session.controller.setCheckbox(question.id, value, values.includes(value));
      }
    } else {
      populateLegacyQuestion(session, names, question, index, values);
    }
    const otherField = names.has(`${question.id}__other_text`)
      ? `${question.id}__other_text`
      : `__uq_q${index}_other_text`;
    if (question.allow_other && names.has(otherField)) session.controller.setText(otherField, answer.other_text || "");
  }
}

function populateLegacyQuestion(session, names, question, index, values) {
  if (question.selection_mode === "single" && names.has(question.id)) {
    session.controller.setRadio(question.id, values[0]);
    return;
  }
  if (question.selection_mode !== "multiple") throw new Error("host form question field drifted");
  question.options.forEach((option, optionIndex) => {
    const field = `__uq_q${index}_option_${optionIndex}`;
    if (!names.has(field)) throw new Error("host form option field drifted");
    session.controller.setCheckbox(field, option.id, values.includes(option.id));
  });
  const skip = `__uq_q${index}_skip`;
  if (names.has(skip)) session.controller.setCheckbox(skip, SKIP_VALUE, values.includes(SKIP_VALUE));
  const other = `__uq_q${index}_other_selected`;
  if (names.has(other)) session.controller.setCheckbox(other, OTHER_VALUE, values.includes(OTHER_VALUE));
}

async function closeAndSave(session) {
  const cancelled = await sendSimpleAction(session, "cancel_save");
  if (!cancelled || session.view.state.phase !== "cancelled") return;
  try {
    restoreHostForm(session.controller.form, session.formSnapshot);
    session.card?.remove?.();
    session.controller.cancelNormally();
    restoreRequestFocus(session);
    await releaseSession(session);
  } catch (error) {
    failSession(session, "The draft is saved. Retry to close this question round.", true);
  }
}

function onCardKeydown(session, event) {
  if (event.key === "Escape" && !event.defaultPrevented) {
    event.preventDefault();
    void closeAndSave(session);
  } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.defaultPrevented) {
    event.preventDefault();
    if (session.view.state.phase === "review") void submitRound(session);
    else void sendSimpleAction(session, "next");
  }
}

function failSession(session, message, afterInteraction) {
  session.failure = { message };
  session.interacted = session.interacted || afterInteraction;
  if (!session.interacted) {
    restoreHostForm(session.controller.form, session.formSnapshot);
    session.card?.remove?.();
    renderMountRetry(session, message);
  } else {
    renderSession(session);
    announce(session, message);
  }
}

function renderMountRetry(session, message) {
  if (session.closed || session.ownerState.stopped) return;
  renderDeliveryNotice(session.controller.form, `${message} Use the standard form below or Retry.`, async () => {
    if (session.closed || session.ownerState.stopped) return;
    clearDeliveryNotices(session.controller.form);
    session.failure = null;
    try {
      await mountSession(session);
    } catch (error) {
      if (session.closed || session.ownerState.stopped) {
        await abandonStoppedSession(session);
        return;
      }
      try {
        await acknowledgeVisibleGenericFallback(session);
      } catch (fallbackError) {
        if (session.closed || session.ownerState.stopped) {
          await abandonStoppedSession(session);
          return;
        }
        session.api.log.warn("User Questions retry fallback was not visibly painted; acknowledgement withheld", safeErrorCode(fallbackError));
      }
      if (session.closed || session.ownerState.stopped) {
        await abandonStoppedSession(session);
        return;
      }
      renderMountRetry(session, "The enhanced question card still could not confirm delivery.");
      session.api.log.warn("User Questions mount retry failed", safeErrorCode(error));
    }
  });
}

async function acknowledgeVisibleGenericFallback(session) {
  if (session.ownerState.stopped) throw new Error("tweak_stopped");
  restoreHostForm(session.controller.form, session.formSnapshot);
  session.card?.remove?.();
  await survivePaint();
  if (session.ownerState.stopped) throw new Error("tweak_stopped");
  if (!session.controller.isCurrent()) throw new Error("generic carrier drifted before mount acknowledgement");
  const acknowledgement = session.controller.mountAcknowledgement("generic");
  if (!session.genericFallbackAcknowledged) {
    await invokeSession(session, "delivery", acknowledgement);
    session.genericFallbackAcknowledged = true;
  }
}

async function releaseSession(session) {
  if (session.releaseAttempted) return;
  session.releaseAttempted = true;
  session.closed = true;
  session.ownerState.sessions.delete(session.controller.form);
  try {
    await invokeSession(session, "release");
  } catch {}
}

async function abandonStoppedSession(session) {
  restoreHostForm(session.controller.form, session.formSnapshot);
  session.card?.remove?.();
  clearDeliveryNotices(session.controller.form);
  await releaseSession(session);
}

function invokeSession(session, channel, payload) {
  if (channel !== "release" && !session.controller.isCurrent()) {
    const error = new Error("route_invalidated");
    error.code = "route_invalidated";
    throw error;
  }
  const route = [session.claimToken, session.identity.hostId, session.identity.conversationId];
  if (payload !== undefined) route.push(payload);
  return session.api.ipc.invoke(channel, ...route);
}

function registerSettingsPage(api) {
  return api.settings?.registerPage?.({
    id: "user-questions",
    title: "User Questions",
    description: "Task-scoped preference questions with explicit, reversible policy compatibility controls.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 8a2 2 0 1 1 2.8 1.83c-.53.24-.8.62-.8 1.17M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    render(root) {
      return renderSettings(api, root);
    },
  });
}

function renderSettings(api, root) {
  let active = true;
  let preview = null;
  let transactionId = null;
  let selectedProfile = "maximum-access";
  root.replaceChildren();
  const title = element("div", "flex h-toolbar items-center justify-between gap-2");
  const copy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  copy.append(element("div", "text-base font-medium text-token-text-primary", "MCP question forms for Full Access tasks"));
  copy.append(element("div", "text-sm text-token-text-secondary", "Choose a permission profile, preview its exact task-level changes, then apply explicitly. Ordinary startup never changes policy, and Apply or Restore never restarts Codex."));
  title.append(copy);
  const profileCard = element("div", "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border");
  profileCard.setAttribute("role", "radiogroup");
  profileCard.setAttribute("aria-label", "User Questions permission profile");
  const profileButtons = new Map();
  for (const profile of [
    {
      id: "maximum-access",
      label: "Maximum access",
      description: "Keeps Full Access capabilities and permits every approval category, including User Questions.",
    },
    {
      id: "questions-only",
      label: "Questions only",
      description: "Keeps Full Access capabilities but permits only User Questions; other approval categories are rejected.",
    },
  ]) {
    const button = element("button", "flex w-full items-center justify-between gap-4 p-3 text-left cursor-interaction");
    button.type = "button";
    button.setAttribute("role", "radio");
    const label = element("span", "flex min-w-0 flex-col gap-1");
    label.append(
      element("span", "text-sm text-token-text-primary", profile.label),
      element("span", "text-sm text-token-text-secondary", profile.description),
    );
    const marker = element("span", "text-sm text-token-text-secondary", "");
    button.append(label, marker);
    button.addEventListener("click", () => {
      selectedProfile = profile.id;
      preview = null;
      updateProfileButtons();
      applyButton.disabled = true;
      status.textContent = `${profile.label} selected. Run Preview to inspect its changes.`;
    });
    profileButtons.set(profile.id, { button, marker });
    profileCard.append(button);
  }
  const updateProfileButtons = () => {
    for (const [profile, control] of profileButtons) {
      const selected = profile === selectedProfile;
      control.button.setAttribute("aria-checked", String(selected));
      control.button.className = "flex w-full items-center justify-between gap-4 p-3 text-left cursor-interaction "
        + (selected ? "bg-token-foreground/5" : "hover:bg-token-foreground/5");
      control.marker.textContent = selected ? "Selected" : "";
    }
  };
  updateProfileButtons();
  const consequences = element("ul", "border-token-border flex list-disc flex-col gap-2 rounded-lg border p-panel pl-8 text-sm text-token-text-secondary");
  for (const text of [
    "Moves the local Codex mode to Custom.",
    "Enables MCP question forms for matching Full Access tasks.",
    "Existing tasks retain their loaded policy; a later Codex restart and fresh task are required before popup behavior can be verified.",
  ]) consequences.append(element("li", "", text));
  const status = element("div", "border-token-border rounded-lg border p-3 text-sm text-token-text-secondary", "Checking reversible policy status…");
  status.setAttribute("aria-live", "polite");
  const actions = element("div", "flex flex-wrap gap-2");
  const previewButton = actionButton("Preview", "secondary", async () => {
    await settingsCommand("policy.preview", [selectedProfile], (result) => {
      preview = result;
      status.textContent = previewSummary(result);
      applyButton.disabled = result.affectedFieldCount === 0;
    });
  });
  previewButton.disabled = true;
  const applyButton = actionButton("Apply previewed change", "primary", async () => {
    if (!preview?.previewToken) return;
    await settingsCommand("policy.apply", [preview.previewToken, selectedProfile], (result) => {
      transactionId = result.transactionId;
      preview = null;
      applyButton.disabled = true;
      restoreButton.hidden = !transactionId;
      status.textContent = policyResultSummary(applied, "applied");
    });
    if (result) await refreshPolicyStatus();
  });
  applyButton.disabled = true;
  const restoreButton = actionButton("Restore", "secondary", async () => {
    if (!transactionId) return;
    const result = await settingsCommand("policy.restore", [transactionId], (restored) => {
      transactionId = null;
      restoreButton.hidden = true;
      status.textContent = policyResultSummary(restored, "restored");
    });
    if (result) await refreshPolicyStatus();
  });
  restoreButton.hidden = true;
  actions.append(previewButton, applyButton, restoreButton);
  root.append(title, profileCard, consequences, status, actions);
  void settingsCommand("policy.status", [], (result) => {
    transactionId = result.status === "restorable" ? result.transactionId : null;
    restoreButton.hidden = !transactionId;
    status.textContent = transactionId
      ? "A previously applied policy change can be restored. Restore will preserve unrelated later edits and refuse if a targeted field drifted."
      : "No applied User Questions policy transaction is waiting to be restored.";
  });

  async function settingsCommand(channel, args, onSuccess) {
    setSettingsBusy(true);
    try {
      const result = await api.ipc.invoke(channel, ...args);
      if (active) onSuccess(result);
      return result;
    } catch (error) {
      if (active) status.textContent = `Could not complete this command: ${safeErrorCode(error)}.`;
      return null;
    } finally {
      if (active) setSettingsBusy(false);
    }
  }
  function setSettingsBusy(busy) {
    previewButton.disabled = busy || !selectedProfile;
    applyButton.disabled = busy || !preview?.previewToken || preview.affectedFieldCount === 0;
    restoreButton.disabled = busy;
  }
  return () => { active = false; };
}

function previewSummary(preview) {
  const fields = preview.affectedFields.map((field) => `${field.name} (${field.count})`).join(", ") || "none";
  const profile = preview.profile === "questions-only" ? "Questions only" : "Maximum access";
  return `Read-only Preview for ${profile}: ${preview.affectedFieldCount} field change(s) across ${preview.affectedTaskCount} matching task(s). Affected fields: ${fields}. Source fingerprint: ${preview.sourceFingerprint}.`;
}

function policyResultSummary(result, verb) {
  return `Policy ${verb}: ${result.status}. No restart was performed${result.restartRequired ? "; restart Codex later to use the change" : ""}.`;
}

function policyStatusSummary(result) {
  const profile = result.profile === "questions-only" ? "Questions only" : "Maximum access";
  if (result.status === "restorable") {
    return `${profile} is saved in the policy file across ${result.targetCount} verified field change(s). Existing tasks still retain their loaded policy; restart Codex later and verify a fresh task. Restore remains available.`;
  }
  if (result.status === "overwritten") {
    return `${profile} was applied, but Codex rewrote all ${result.beforeTargetCount || result.targetCount} changed field(s) from its running settings. It is not saved now, and restarting alone will not apply it. Restore remains available to close the old transaction.`;
  }
  if (result.status === "drifted") {
    return `The previous ${profile} transaction no longer matches current saved settings: ${result.appliedTargetCount} of ${result.targetCount} field(s) still match. The profile is not marked saved. Restore remains available and will refuse unsafe targeted drift.`;
  }
  if (result.status === "recovery-required") {
    return "The previous policy transaction requires recovery before another policy change. No profile is marked saved.";
  }
  return "No verified User Questions policy profile is saved. Select a profile and run Preview; a selection alone does not change policy.";
}

function renderDeliveryNotice(anchor, message, retry) {
  clearDeliveryNotices(anchor);
  const notice = element("div", "border-token-border flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm text-token-text-secondary");
  notice.setAttribute(NOTICE_ATTRIBUTE, "");
  notice.setAttribute("role", "status");
  notice.append(element("span", "min-w-0 flex-1", message), actionButton("Retry", "link", retry));
  anchor.parentNode?.insertBefore?.(notice, anchor);
}

function clearDeliveryNotices(anchor) {
  const parent = anchor?.parentNode;
  for (const notice of parent?.querySelectorAll?.(`[${NOTICE_ATTRIBUTE}]`) || []) notice.remove?.();
}

function snapshotHostForm(form) {
  return {
    hidden: form.hidden,
    inert: form.inert,
    ariaHidden: form.getAttribute?.("aria-hidden"),
  };
}

function hideHostForm(form) {
  const snapshot = snapshotHostForm(form);
  form.hidden = true;
  form.inert = true;
  form.setAttribute?.("aria-hidden", "true");
  return snapshot;
}

function restoreHostForm(form, snapshot) {
  if (!form || !snapshot) return;
  form.hidden = snapshot.hidden;
  form.inert = snapshot.inert;
  if (snapshot.ariaHidden === null) form.removeAttribute?.("aria-hidden");
  else form.setAttribute?.("aria-hidden", snapshot.ariaHidden);
}

async function cleanupState(state) {
  if (state.stopped) return;
  state.stopped = true;
  for (const session of state.sessions.values()) {
    if (!session || session.status === "claiming") continue;
    restoreHostForm(session.controller.form, session.formSnapshot);
    session.card?.remove?.();
    restoreRequestFocus(session);
    clearDeliveryNotices(session.controller.form);
    await releaseSession(session);
  }
  state.sessions.clear();
  for (const cleanup of state.cleanups.reverse()) {
    try { await cleanup(); } catch {}
  }
  if (typeof document !== "undefined") {
    for (const card of document.querySelectorAll?.(`[${CARD_ATTRIBUTE}]`) || []) card.remove?.();
    for (const notice of document.querySelectorAll?.(`[${NOTICE_ATTRIBUTE}]`) || []) notice.remove?.();
  }
}

function installStyle() {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = `
[${CARD_ATTRIBUTE}] { max-inline-size: 100%; overflow-wrap: anywhere; }
[${CARD_ATTRIBUTE}] button, [${CARD_ATTRIBUTE}] input, [${CARD_ATTRIBUTE}] textarea { font: inherit; }
@media (prefers-reduced-motion: reduce) {
  [${CARD_ATTRIBUTE}] *, [${CARD_ATTRIBUTE}] *::before, [${CARD_ATTRIBUTE}] *::after {
    scroll-behavior: auto !important; transition-duration: 0.01ms !important; animation-duration: 0.01ms !important;
  }
}`;
  (document.head || document.documentElement)?.appendChild?.(style);
  return style;
}

function survivePaint() {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function focusHeading(session) {
  session.card?.querySelector?.('[data-uq-heading=""]')?.focus?.({ preventScroll: true });
}

function restoreRequestFocus(session) {
  if (session.returnFocus?.isConnected) session.returnFocus.focus?.({ preventScroll: true });
}

function setBusy(session, busy) {
  for (const control of session.card?.querySelectorAll?.("button, input, textarea") || []) control.disabled = busy;
  session.card?.setAttribute?.("aria-busy", String(busy));
}

function announce(session, message) {
  const live = session.card?.querySelector?.('[data-uq-live=""]');
  if (live) live.textContent = message;
}

function currentValidationMessage(session) {
  const questionId = session.view.state.current_question_id;
  return questionId ? session.view.state.validation_errors?.[questionId] || null : null;
}

function focusValidationControl(session) {
  session.card?.querySelector?.('[aria-invalid="true"] input, [aria-invalid="true"] textarea, input[aria-invalid="true"], textarea[aria-invalid="true"]')
    ?.focus?.({ preventScroll: true });
}

function answerSummary(question, answer, otherSelected) {
  if (answer.status === "skipped") return "Skipped";
  const labels = answer.selected_option_ids.map((id) => question.options.find((option) => option.id === id)?.label).filter(Boolean);
  if (otherSelected) {
    labels.push(answer.other_text ? `Other: ${answer.other_text}` : "Other");
  } else if (answer.other_text !== null) {
    labels.push(`Other: ${answer.other_text}`);
  }
  return labels.join(", ") || "Unanswered";
}

function appendDetailSection(root, heading, values) {
  if (!values?.length) return;
  const section = element("section", "flex min-w-0 flex-col gap-1");
  section.append(element("h3", "font-medium text-token-text-primary", heading));
  if (values.length === 1) section.append(element("p", "", values[0]));
  else {
    const list = element("ul", "list-disc pl-5");
    for (const value of values) list.append(element("li", "", value));
    section.append(list);
  }
  root.append(section);
}

function optionHasDetails(option) {
  return Boolean(option.details || option.pros?.length || option.cons?.length || option.gives_up?.length);
}

function actionButton(label, kind, onClick) {
  const control = button(label, label, onClick);
  control.className = kind === "primary"
    ? "h-token-button-composer rounded-md bg-token-text-primary px-3 text-sm font-medium text-token-bg-primary hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
    : kind === "link"
      ? "inline-flex items-center text-sm text-token-text-link-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
      : "border-token-border bg-token-foreground/5 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary hover:bg-token-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
  return control;
}

function button(text, ariaLabel, onClick) {
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = text;
  control.setAttribute("aria-label", ariaLabel);
  control.addEventListener("click", (event) => {
    event.preventDefault?.();
    void onClick?.();
  });
  return control;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className || "";
  if (text !== undefined) node.textContent = text;
  return node;
}

function preventDefault(event) { event.preventDefault(); }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
function safeDomId(value) { return String(value).replace(/[^A-Za-z0-9_-]/g, "-"); }
function safeErrorCode(error) { return String(error?.code || error?.message || "request_failed").slice(0, 160); }
function carrierFieldName(propertyNames) {
  const matches = [...propertyNames].filter((name) => name.startsWith(CARRIER_NONCE_PREFIX));
  return matches.length === 1 ? matches[0] : null;
}
function carrierOtherTextField(carrier) {
  return `${CARRIER_OTHER_TEXT_PREFIX}${carrier.slice(CARRIER_NONCE_PREFIX.length)}`;
}
function immutableClone(value) { return deepFreeze(typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value))); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
