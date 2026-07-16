"use strict";

const states = new WeakMap();
const MCP_SERVER_NAME = "co-tweakers-user-questions";
const CHECKBOX_ATTRIBUTE = "data-codexpp-user-questions-checkbox";
const OTHER_FIELD_ATTRIBUTE = "data-codexpp-user-questions-other-field";
const OTHER_INPUT_ATTRIBUTE = "data-codexpp-user-questions-other-input";
const STYLE_ATTRIBUTE = "data-codexpp-user-questions-style";

module.exports = {
  start(api) {
    if (api?.process === "main") return startMain(api);
    if (typeof document === "undefined") return;
    const state = { observer: null, settings: null, style: null };
    states.set(this, state);
    state.style = installFormStyle();
    syncUserQuestionForms();
    if (typeof MutationObserver !== "undefined") {
      const target = document.body || document.documentElement;
      if (target) {
        state.observer = new MutationObserver(syncUserQuestionForms);
        state.observer.observe(target, {
          attributes: true,
          attributeFilter: ["aria-checked"],
          childList: true,
          subtree: true,
        });
      }
    }
    state.settings = api.settings?.registerPage?.({
      id: "user-questions",
      title: "User Questions",
      description: "Native structured questions shown one at a time, with conditional inline Other input and checkbox-style multi-select controls.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 8a2 2 0 1 1 2.8 1.83c-.53.24-.8.62-.8 1.17M10 14h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render(root) {
        root.replaceChildren();
        const status = document.createElement("div");
        status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
        status.textContent = "Question-only prompts use Codex's native Custom mode: command execution stays at Full Access while sandbox, rule, skill, and permission approval prompts stay off; only MCP question forms are allowed. Codex shows questions one at a time over the requesting task's composer, so the current task stays visible. Multi-select choices use rounded-square checkboxes, while single-choice options stay circular. An Other text field sits directly below the Other choice and becomes visible only while Other is selected. The task pauses until each answer is submitted or the round is cancelled. Choosing the Full Access preset later restores approval_policy = never and disables forms again.";
        root.append(status);
      },
    });
  },

  stop() {
    const state = states.get(this);
    state?.observer?.disconnect?.();
    if (typeof document !== "undefined") {
      restoreUserQuestionForms();
      state?.style?.remove?.();
    }
    state?.settings?.unregister?.();
    states.delete(this);
  },
};

function installFormStyle() {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "");
  style.textContent = `
button[role="checkbox"][aria-checked][${CHECKBOX_ATTRIBUTE}] > span[aria-hidden="true"] {
  border-radius: var(--radius-xs, 0.25rem) !important;
}
[${OTHER_FIELD_ATTRIBUTE}] {
  order: 99;
}
[${OTHER_FIELD_ATTRIBUTE}][hidden] {
  display: none !important;
}`;
  (document.head || document.documentElement)?.appendChild?.(style);
  return style;
}

function syncUserQuestionForms() {
  const forms = document.querySelectorAll?.("form") || [];
  for (const form of forms) {
    if (!isUserQuestionForm(form)) continue;
    for (const checkbox of form.querySelectorAll?.('button[role="checkbox"]') || []) {
      checkbox.setAttribute?.(CHECKBOX_ATTRIBUTE, "");
    }
    syncInlineOtherFields(form);
  }
}

function syncInlineOtherFields(form) {
  const controls = form.querySelectorAll?.('button[role="radio"], button[role="checkbox"]') || [];
  const otherControls = [...controls].filter(isOtherControl);
  const inputs = form.querySelectorAll?.('input[maxlength="4000"]') || [];
  const otherFields = [...inputs]
    .map((input) => ({ input, field: input.closest?.("label") }))
    .filter(({ field }) => isOtherField(field));
  if (otherControls.length === 0 || otherFields.length === 0) return;

  const unmatchedControls = new Set(otherControls);
  for (const { input, field } of otherFields) {
    const fieldHeader = otherFieldHeader(field);
    let otherControl = otherControls.find((control) => (
      unmatchedControls.has(control)
      && fieldHeader
      && otherControlHeader(control) === fieldHeader
    ));
    if (!otherControl && otherFields.length === 1 && otherControls.length === 1) {
      [otherControl] = otherControls;
    }
    if (!otherControl) continue;
    unmatchedControls.delete(otherControl);
    syncInlineOtherPair(otherControl, input, field);
  }
}

function syncInlineOtherPair(otherControl, input, field) {
  field.setAttribute?.(OTHER_FIELD_ATTRIBUTE, "");
  input.setAttribute?.(OTHER_INPUT_ATTRIBUTE, "");
  const selected = otherControl.getAttribute?.("aria-checked") === "true";
  if (selected) {
    field.hidden = false;
    field.removeAttribute?.("aria-hidden");
    input.required = true;
    input.setAttribute?.("aria-required", "true");
  } else {
    input.required = false;
    input.setAttribute?.("aria-required", "false");
    field.hidden = true;
    field.setAttribute?.("aria-hidden", "true");
  }
}

function isUserQuestionForm(form) {
  return (form?.textContent || "").includes(MCP_SERVER_NAME);
}

function isOtherControl(control) {
  const label = (control?.textContent || "").replace(/\s+/g, " ").trim();
  return /(?:^|—\s*)Other(?:\s*\([^)]*\))?$/.test(label);
}

function isOtherField(field) {
  const title = normalizedText(field?.firstElementChild?.textContent);
  return /—\s*Other(?: response)?$/.test(title);
}

function otherFieldHeader(field) {
  const title = normalizedText(field?.firstElementChild?.textContent);
  return title.match(/^(.*?)\s*—\s*Other(?: response)?$/)?.[1]?.trim() || "";
}

function otherControlHeader(control) {
  const legend = control?.closest?.("fieldset")?.querySelector?.("legend");
  const legendText = normalizedText(legend?.textContent);
  if (legendText) return legendText;
  const label = normalizedText(control?.textContent);
  return label.match(/^(.*?)\s*—\s*Other(?:\s*\([^)]*\))?$/)?.[1]?.trim() || "";
}

function normalizedText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function restoreUserQuestionForms() {
  for (const control of document.querySelectorAll?.(`[${CHECKBOX_ATTRIBUTE}]`) || []) {
    control.removeAttribute?.(CHECKBOX_ATTRIBUTE);
  }
  for (const field of document.querySelectorAll?.(`[${OTHER_FIELD_ATTRIBUTE}]`) || []) {
    field.hidden = false;
    field.removeAttribute?.("aria-hidden");
    field.removeAttribute?.(OTHER_FIELD_ATTRIBUTE);
  }
  for (const input of document.querySelectorAll?.(`[${OTHER_INPUT_ATTRIBUTE}]`) || []) {
    input.required = false;
    input.removeAttribute?.("aria-required");
    input.removeAttribute?.(OTHER_INPUT_ATTRIBUTE);
  }
}

function startMain(api) {
  try {
    const { repairGlobalStateFile } = require("./policy-state");
    const result = repairGlobalStateFile();
    if (result.changed) {
      api.log.info(`User Questions repaired the question-only approval policy; migrated ${result.repairedThreads} Full Access task record(s). Restart Codex to apply it.`);
    } else if (result.reason !== "current") {
      api.log.warn(`User Questions could not repair the question-only approval policy: ${result.reason}`);
    }
  } catch (error) {
    api.log.error("User Questions question-only approval policy repair failed", String(error?.message || error));
  }
}
