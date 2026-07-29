"use strict";

const CHANNELS = Object.freeze({
  status: "browser-trust.status",
  preview: "browser-trust.preview",
  apply: "browser-trust.apply",
  restore: "browser-trust.restore",
});
const TRUST_STATES = new Set([
  "trusted",
  "disabled",
  "unsupported_projection",
  "policy_blocked",
  "identity_drift",
  "schema_drift",
  "profile_mismatch",
  "runtime_mismatch",
]);
const BLOCKING_STATES = new Set([
  "unsupported_projection",
  "policy_blocked",
  "identity_drift",
  "schema_drift",
  "target_drift",
  "profile_mismatch",
  "runtime_mismatch",
]);
const states = new WeakMap();

module.exports = {
  async start(api) {
    if (states.has(this)) return states.get(this).started;
    const state = { cleanups: [], started: null, stopped: false };
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
  if (typeof api?.ipc?.handleWithContext !== "function") {
    throw new Error("Browser Trust requires contextual IPC");
  }
  if (typeof api?.fs?.dataDir !== "string" || !api.fs.dataDir) {
    throw new Error("Browser Trust requires an isolated data directory");
  }

  const { createPolicyCommandInterface } = require("./policy-state");
  const policy = createPolicyCommandInterface({ dataDir: api.fs.dataDir });

  registerMainHandler(state, api, CHANNELS.status, async () => (
    sanitizePolicyResult(await policy.status())
  ));
  registerMainHandler(state, api, CHANNELS.preview, async () => (
    sanitizePreview(await policy.preview())
  ));
  registerMainHandler(state, api, CHANNELS.apply, async (_context, previewToken) => (
    sanitizePolicyResult(await policy.apply(previewToken))
  ));
  registerMainHandler(state, api, CHANNELS.restore, async (_context, transactionId) => (
    sanitizePolicyResult(await policy.restore(transactionId))
  ));
}

function registerMainHandler(state, api, channel, handler) {
  const cleanup = api.ipc.handleWithContext(channel, handler);
  if (typeof cleanup !== "function") {
    throw new Error(`Browser Trust could not own IPC handler ${channel}`);
  }
  state.cleanups.push(cleanup);
}

function sanitizePreview(value) {
  const source = record(value);
  const result = {
    status: safeCode(source.status) || "unsupported_projection",
    changed: source.changed === true,
    affectedFieldCount: safeCount(source.affectedFieldCount),
    affectedRoutes: Array.isArray(source.affectedRoutes)
      ? source.affectedRoutes.slice(0, 100).map(sanitizeAffectedRoute).filter(Boolean)
      : [],
    registryFingerprint: safeFingerprint(source.registryFingerprint),
    sourceFingerprint: safeFingerprint(source.sourceFingerprint),
    previewToken: safeOpaqueId(source.previewToken),
    restartRequired: source.restartRequired === true,
  };
  const errorCode = safeCode(source.errorCode);
  if (errorCode) result.errorCode = errorCode;
  return result;
}

function sanitizePolicyResult(value) {
  const source = record(value);
  const result = {
    status: safeCode(source.status) || "unsupported_projection",
    changed: source.changed === true,
    transactionId: safeOpaqueId(source.transactionId),
    restartRequired: source.restartRequired === true,
    restarted: false,
    registryFingerprint: safeFingerprint(source.registryFingerprint),
    routeStates: Array.isArray(source.routeStates)
      ? source.routeStates.slice(0, 100).map(sanitizeRouteState).filter(Boolean)
      : [],
  };
  const errorCode = safeCode(source.errorCode);
  if (errorCode) result.errorCode = errorCode;
  return result;
}

function sanitizeAffectedRoute(value) {
  const source = record(value);
  const routeId = safeRouteId(source.routeId);
  if (!routeId) return null;
  return {
    routeId,
    fieldCount: safeCount(source.fieldCount),
    state: safeTrustState(source.state),
  };
}

function sanitizeRouteState(value) {
  const source = record(value);
  const routeId = safeRouteId(source.routeId);
  if (!routeId) return null;
  return {
    routeId,
    state: safeTrustState(source.state),
  };
}

function safeTrustState(value) {
  return TRUST_STATES.has(value) ? value : "unsupported_projection";
}

function safeCode(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value)
    ? value
    : null;
}

function safeRouteId(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 160) return null;
  if (/[\u0000-\u001f\u007f\r\n]/.test(value) || /:\/\//.test(value)) return null;
  return value;
}

function safeFingerprint(value) {
  return typeof value === "string" && /^[a-z0-9._:-]{1,256}$/i.test(value)
    ? value
    : null;
}

function safeOpaqueId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function startRenderer(api, state) {
  if (typeof document === "undefined") return;
  if (typeof api?.ipc?.invoke !== "function" || typeof api?.settings?.registerPage !== "function") {
    throw new Error("Browser Trust requires renderer IPC and settings pages");
  }

  let disposeRender = null;
  const page = api.settings.registerPage({
    id: "browser-trust",
    title: "Browser Trust",
    description: "Explicit, reversible trust for exact browser inspection and built-in HTTP(S) browse routes.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.75 16 5v4.5c0 3.6-2.2 6.2-6 7.75-3.8-1.55-6-4.15-6-7.75V5l6-2.25Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="m7.5 10 1.6 1.6 3.4-3.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    render(root) {
      disposeRender?.();
      const cleanup = renderSettings(api, root);
      disposeRender = cleanup;
      return () => {
        cleanup();
        if (disposeRender === cleanup) disposeRender = null;
      };
    },
  });
  if (!page || typeof page.unregister !== "function") {
    throw new Error("Browser Trust could not register its settings page");
  }
  state.cleanups.push(() => {
    disposeRender?.();
    disposeRender = null;
    page.unregister();
  });
}

function renderSettings(api, root) {
  let active = true;
  let busy = false;
  let preview = null;
  let transactionId = null;

  const container = element("div", "flex flex-col gap-4");
  const titleRow = element("div", "flex h-toolbar items-center justify-between gap-2 px-0 py-0");
  const titleCopy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  titleCopy.append(
    element("div", "text-base font-medium text-token-text-primary", "Browser Trust"),
    element(
      "div",
      "text-sm text-token-text-secondary",
      "Choose whether exact browser inspection and built-in HTTP(S) browse requests can run without a prompt. Saved policy changes only when you click Apply; running Codex changes only after a later restart.",
    ),
  );
  titleRow.append(titleCopy);

  const boundaryCard = groupedCard();
  appendSettingRow(
    boundaryCard,
    "Prompt-free after Apply and restart",
    "Only exact registry routes for browser inspection and the built-in Browser's normal HTTP(S) browse/history projection.",
  );
  appendSettingRow(
    boundaryCard,
    "Eligible current projections",
    "Chrome DevTools exactly 1.6.0 and the built-in Browser's normal HTTP(S) browse/history route, when their registry identities and saved policy match.",
  );
  appendSettingRow(
    boundaryCard,
    "Infographic Playwright",
    "Remains prompted because its plugin transport uses @latest. An exact version pin is required before approval.",
  );
  appendSettingRow(
    boundaryCard,
    "Always gated",
    "Chrome DevTools and plugin navigation tools, mixed requests, writes, scripts, typing or input, downloads, uploads, and raw Full CDP.",
  );
  appendSettingRow(
    boundaryCard,
    "User Questions",
    "User Questions stays available and is not changed by Browser Trust.",
  );
  appendSettingRow(
    boundaryCard,
    "Unknown actions",
    "Unknown and future routes default to prompted.",
  );

  const operationTitle = sectionTitle(
    "Saved policy",
    "Preview is read-only. Apply and Restore are explicit, reversible actions. Neither action restarts Codex.",
  );
  const statusCard = element(
    "div",
    "border-token-border flex flex-col gap-3 rounded-lg border p-3",
  );
  statusCard.setAttribute("role", "status");
  statusCard.setAttribute("aria-live", "polite");
  const statusHeading = element(
    "div",
    "text-sm font-medium text-token-text-primary",
    "Checking current status…",
  );
  const statusBody = element(
    "div",
    "text-sm text-token-text-secondary",
    "This status check is read-only.",
  );
  const statusDetails = element("div", "flex flex-col gap-2");
  statusCard.append(statusHeading, statusBody, statusDetails);

  const actions = element("div", "flex flex-wrap gap-2");
  const previewButton = actionButton("Preview", "secondary", async () => {
    preview = null;
    syncButtons();
    await runCommand(CHANNELS.preview, [], (result) => {
      preview = result;
      renderResult("preview", result);
    });
  });
  const applyButton = actionButton("Apply", "primary", async () => {
    if (!canApply(preview)) return;
    const token = preview.previewToken;
    preview = null;
    syncButtons();
    await runCommand(CHANNELS.apply, [token], (result) => {
      if (result.changed === true && result.transactionId) {
        transactionId = result.transactionId;
      }
      renderResult("apply", result);
    });
  });
  const restoreButton = actionButton("Restore", "secondary", async () => {
    if (!transactionId) return;
    const restoreId = transactionId;
    await runCommand(CHANNELS.restore, [restoreId], (result) => {
      if (result.changed === true) transactionId = null;
      else if (result.transactionId) transactionId = result.transactionId;
      renderResult("restore", result);
    });
  });
  actions.append(previewButton, applyButton, restoreButton);

  const restartNote = element(
    "div",
    "text-sm text-token-text-secondary",
    "After a successful Apply or Restore, a later restart is required before the running Codex process changes. Browser Trust never restarts it automatically.",
  );

  container.append(
    titleRow,
    boundaryCard,
    operationTitle,
    statusCard,
    actions,
    restartNote,
  );
  root.replaceChildren(container);
  syncButtons();

  void runCommand(CHANNELS.status, [], (result) => {
    transactionId = result.transactionId || null;
    renderResult("status", result);
  });

  function renderResult(operation, result) {
    const codes = projectionCodes(result);
    const blocked = operation === "error"
      || codes.some((code) => BLOCKING_STATES.has(code));
    statusCard.className = blocked
      ? "flex flex-col gap-3 rounded-lg border border-token-charts-red/30 bg-token-charts-red/10 p-3"
      : "border-token-border flex flex-col gap-3 rounded-lg border p-3";
    statusHeading.className = blocked
      ? "text-sm font-medium text-token-charts-red"
      : "text-sm font-medium text-token-text-primary";
    const status = safeCode(result?.status) || "unsupported_projection";
    statusHeading.textContent = `${operationLabel(operation)}: ${status}`;
    statusBody.textContent = resultSummary(operation, result, codes);
    renderProjectionDetails(statusDetails, result);
    syncButtons();
  }

  async function runCommand(channel, args, onSuccess) {
    if (!active || busy) return;
    busy = true;
    statusCard.setAttribute("aria-busy", "true");
    syncButtons();
    try {
      const result = await api.ipc.invoke(channel, ...args);
      if (active) onSuccess(record(result));
    } catch (error) {
      if (active) {
        const errorCode = rendererErrorCode(error);
        renderResult("error", {
          status: errorCode,
          errorCode,
          changed: false,
          restartRequired: false,
          routeStates: [],
        });
      }
    } finally {
      if (active) {
        busy = false;
        statusCard.setAttribute("aria-busy", "false");
        syncButtons();
      }
    }
  }

  function syncButtons() {
    previewButton.disabled = busy;
    applyButton.disabled = busy || !canApply(preview);
    restoreButton.disabled = busy || !transactionId;
  }

  return () => {
    if (!active) return;
    active = false;
    if (container.parentNode === root) container.remove();
  };
}

function canApply(preview) {
  if (!preview || preview.changed !== true || !preview.previewToken) return false;
  if (!Number.isSafeInteger(preview.affectedFieldCount) || preview.affectedFieldCount < 1) return false;
  return !projectionCodes(preview).some((code) => BLOCKING_STATES.has(code));
}

function projectionCodes(result) {
  const codes = [];
  const status = safeCode(result?.status);
  const errorCode = safeCode(result?.errorCode);
  if (status) codes.push(status);
  if (errorCode) codes.push(errorCode);
  for (const route of result?.affectedRoutes || result?.routeStates || []) {
    const state = safeCode(route?.state);
    if (state) codes.push(state);
  }
  return codes;
}

function resultSummary(operation, result, codes) {
  if (codes.includes("unsupported_projection")) {
    return "This policy shape is not supported. Nothing was changed and browser requests remain prompted.";
  }
  if (codes.includes("identity_drift")) {
    return "Browser route identity changed after it was verified. Nothing was changed; run Preview again after the registry is corrected.";
  }
  if (codes.includes("schema_drift")) {
    return "The saved policy shape changed after it was verified. Nothing was changed; run Preview again.";
  }
  if (codes.includes("target_drift")) {
    return "A policy field changed after the transaction was recorded. Nothing was overwritten; review the current state before trying again.";
  }
  if (codes.includes("profile_mismatch")) {
    return "The active browser profile does not match the reviewed route identity. Nothing was changed; profile paths are not displayed.";
  }
  if (codes.includes("runtime_mismatch")) {
    return "The running Codex version does not match this trust registry. Nothing was changed and browser requests remain prompted.";
  }
  if (codes.includes("policy_blocked")) {
    return "The current policy blocks this trust change. Nothing was changed and browser requests remain prompted.";
  }
  const restart = result?.restartRequired === true
    ? " A later restart is required; no restart was performed."
    : " No restart was performed.";
  if (operation === "preview") {
    const count = safeCount(result?.affectedFieldCount);
    return `Read-only preview: ${count} saved policy field${count === 1 ? "" : "s"} would change.${restart}`;
  }
  if (operation === "apply") {
    return result?.changed === true
      ? `The previewed trust change was saved.${restart}`
      : `No saved policy fields changed.${restart}`;
  }
  if (operation === "restore") {
    return result?.changed === true
      ? `The Browser Trust transaction was restored without overwriting unrelated policy edits.${restart}`
      : `No saved policy fields were restored.${restart}`;
  }
  if (operation === "error") {
    return "The command failed safely. No policy content or error details were displayed.";
  }
  return result?.changed === true
    ? `A saved Browser Trust transaction is present.${restart}`
    : `Current Browser Trust state loaded.${restart}`;
}

function renderProjectionDetails(root, result) {
  root.replaceChildren();
  const routes = Array.isArray(result?.affectedRoutes)
    ? result.affectedRoutes
    : Array.isArray(result?.routeStates)
      ? result.routeStates
      : [];
  for (const route of routes) {
    const routeId = safeRouteId(route?.routeId);
    if (!routeId) continue;
    const row = element("div", "border-token-border flex items-center justify-between gap-3 border-t pt-2");
    const copy = element("div", "flex min-w-0 flex-col gap-1");
    copy.append(element("div", "min-w-0 break-words text-sm text-token-text-primary", routeId));
    if (Number.isSafeInteger(route?.fieldCount)) {
      copy.append(element(
        "div",
        "text-xs text-token-text-secondary",
        `${safeCount(route.fieldCount)} saved policy field${safeCount(route.fieldCount) === 1 ? "" : "s"}`,
      ));
    }
    if (routeId === "infographic-preview-playwright" && route?.state === "unsupported_projection") {
      copy.append(element(
        "div",
        "text-xs text-token-text-secondary",
        "The plugin transport uses @latest; an exact version pin is required before this route can be trusted.",
      ));
    }
    const state = safeTrustState(route?.state);
    const badge = element("span", routeStateClass(state), state);
    row.append(copy, badge);
    root.append(row);
  }

  const fingerprints = [];
  const registry = safeFingerprint(result?.registryFingerprint);
  const source = safeFingerprint(result?.sourceFingerprint);
  if (registry) fingerprints.push(`Registry fingerprint: ${registry}`);
  if (source) fingerprints.push(`Source fingerprint: ${source}`);
  for (const text of fingerprints) {
    root.append(element("div", "break-all text-xs text-token-text-secondary", text));
  }
}

function routeStateClass(state) {
  return BLOCKING_STATES.has(state)
    ? "shrink-0 rounded-full bg-token-charts-red/10 px-2 py-0.5 text-xs text-token-charts-red"
    : "bg-token-foreground/5 shrink-0 rounded-full px-2 py-0.5 text-xs text-token-text-secondary";
}

function rendererErrorCode(error) {
  return safeCode(error?.code) || safeCode(error?.cause?.code) || "command_failed";
}

function operationLabel(operation) {
  return {
    status: "Current state",
    preview: "Preview",
    apply: "Apply",
    restore: "Restore",
    error: "Command",
  }[operation] || "Browser Trust";
}

function sectionTitle(title, subtitle) {
  const row = element("div", "flex h-toolbar items-center justify-between gap-2 px-0 py-0");
  const inner = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  inner.append(
    element("div", "text-base font-medium text-token-text-primary", title),
    element("div", "text-sm text-token-text-secondary", subtitle),
  );
  row.append(inner);
  return row;
}

function groupedCard() {
  const card = element(
    "div",
    "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border",
  );
  card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  return card;
}

function appendSettingRow(card, label, description) {
  const row = element("div", "flex items-center justify-between gap-4 p-3");
  const copy = element("div", "flex min-w-0 flex-col gap-1");
  copy.append(
    element("div", "min-w-0 text-sm text-token-text-primary", label),
    element("div", "min-w-0 text-sm text-token-text-secondary", description),
  );
  row.append(copy);
  card.append(row);
}

function actionButton(label, kind, onClick) {
  const button = element("button", "", label);
  button.type = "button";
  button.className = kind === "primary"
    ? "h-token-button-composer cursor-interaction rounded-md bg-token-text-primary px-3 text-sm font-medium text-token-bg-primary hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50"
    : "border-token-border bg-token-foreground/5 h-token-button-composer cursor-interaction rounded-md border px-3 text-sm text-token-text-primary hover:bg-token-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-not-allowed disabled:opacity-50";
  button.addEventListener("click", (event) => {
    event.preventDefault();
    void onClick();
  });
  return button;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function cleanupState(state) {
  if (state.stopped) return;
  state.stopped = true;
  for (const cleanup of state.cleanups.reverse()) {
    try { await cleanup(); } catch {}
  }
  state.cleanups.length = 0;
}
