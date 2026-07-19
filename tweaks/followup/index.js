"use strict";

const PANEL_ATTR = "data-tweaker-followup-panel";
const SOURCE_ATTR = "data-tweaker-followup-source";
const STYLE_ID = "tweaker-followup-style";
const MAX_ITEMS = 5;
const MESSAGE_SELECTOR = [
  '[data-message-author-role="assistant"]',
  '[data-role="assistant"]',
  '[data-author-role="assistant"]',
  ".group.flex.min-w-0.flex-col",
].join(", ");
const LOCKED_INSTRUCTION = "codex_follow_up payloads contain prompt and achieves fields";
const POLICY_CHANNEL = "policy";
const POLICY_KEY = "policySnapshot";
const DEFAULT_POLICY = Object.freeze({ schemaVersion: 1, enabled: true, exactItems: 5, exception: null });

const apiState = new WeakMap();

const helpers = {
  normalizePayload,
  parsePayload,
  dedupeItems,
  dedupePrompts: dedupeItems,
  normalizeItem,
  collectMessageRoots,
  findPayload,
  renderPanel,
  cleanup,
  insertPrompt,
  LOCKED_INSTRUCTION,
  normalizePolicySnapshot,
  policyAllowsPayload,
  currentProjectContext,
  pruneDetached,
  refreshPolicy,
};

module.exports = {
  start(api) {
    if (api?.process === "main") return startMain(api, this);
    if (typeof document === "undefined") return;
    const state = createState(api || {});
    apiState.set(this, state);
    installStyle();
    if (typeof api?.settings?.registerPage === "function") {
      state.settings = api.settings.registerPage({
        id: "followup",
        title: "Codex Follow-up",
        description: "Render locked, context-aware follow-up prompts under assistant messages.",
        iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 5.5h12v7H9l-3.5 3v-3H4z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 8.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
        render(root) { renderFollowupSettings(root, state); },
      });
    }
    const disposeHost = api.react?.host?.observe?.(["assistant-turns", "composer", "thread-context"], () => scheduleScan(state, []));
    state.observer = disposeHost ? { disconnect: disposeHost } : null;
    state.policy = { ...DEFAULT_POLICY, enabled: false, exception: "pending-main-snapshot" };
    refreshPolicy(state);
  },

  stop() {
    const state = apiState.get(this);
    if (!state) { this._mainPolicyDisposer?.(); this._mainPolicyDisposer = null; return; }
    cleanup(state);
    state.settings?.unregister?.();
    apiState.delete(this);
    document?.getElementById?.(STYLE_ID)?.remove?.();
  },

  _test: helpers,
  __test: helpers,
};

function createState(api) {
  return {
    api,
    observer: null,
    pending: null,
    disposed: false,
    roots: new WeakMap(),
    hidden: new Map(),
    panels: new Set(),
    settings: null,
    policy: { ...DEFAULT_POLICY, enabled: false, exception: "pending-main-snapshot" },
    policyContext: null,
    policyPending: false,
  };
}

function renderFollowupSettings(root, state) {
  root.replaceChildren();
  const status = document.createElement("div");
  status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const messages = state.api?.react?.host?.snapshot?.("assistant-turns")?.count || 0;
  const composer = state.api?.react?.host?.snapshot?.("composer")?.count || 0;
  status.textContent = `Policy: ${state.policy?.enabled ? "enabled" : "disabled"} · Structured producer payloads detected: ${state.panels.size} · Exact-five validation: enforced · Assistant surfaces: ${messages} · Composer surfaces: ${composer}.`;
  const note = document.createElement("div");
  note.className = "text-sm text-token-text-secondary";
  note.textContent = "Valid codex_follow_up payloads are attached to the matching assistant turn. Selecting a prompt fills the composer without sending it.";
  const previewTitle = document.createElement("div");
  previewTitle.className = "pt-2 text-sm font-medium text-token-text-primary";
  previewTitle.textContent = "Preview";
  const preview = renderPanel({ title: "Follow-up", items: Array.from({ length: 5 }, (_, index) => ({ prompt: `Suggested next step ${index + 1}`, achieves: ["Continues this task"] })) }, state.api);
  root.append(status, note, previewTitle, preview);
}

function startMain(api, instance) {
  const read = () => normalizePolicySnapshot(api.storage.get(POLICY_KEY, DEFAULT_POLICY)) || { ...DEFAULT_POLICY };
  instance._mainPolicyDisposer = api.ipc.handle?.(POLICY_CHANNEL, (message) => {
    if (message?.action === "get") return read();
    if (message?.action === "configure") {
      const next = normalizePolicySnapshot(message.snapshot);
      if (!next) return { ...DEFAULT_POLICY };
      api.storage.set(POLICY_KEY, next);
      api.storage.flush?.();
      return next;
    }
    return { ...DEFAULT_POLICY, enabled: false, exception: "invalid-request" };
  });
}

function normalizePolicySnapshot(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (value.enabled === false) return { schemaVersion: 1, enabled: false, exactItems: 5, exception: "disabled-by-applicable-agents" };
  if (value.enabled !== true || value.exactItems !== 5) return null;
  return { schemaVersion: 1, enabled: true, exactItems: 5, exception: null };
}

function policyAllowsPayload(policy, payload) {
  const snapshot = normalizePolicySnapshot(policy);
  return Boolean(snapshot?.enabled && Array.isArray(payload?.items) && payload.items.length === snapshot.exactItems);
}

function currentProjectContext(root = document) {
  const node = root?.querySelector?.("[data-workspace-path]");
  const workspacePath = node?.getAttribute?.("data-workspace-path");
  const id = node?.getAttribute?.("data-project-id") || undefined;
  if (typeof workspacePath !== "string" || !workspacePath.startsWith("/") || workspacePath.length > 4096 || /[\0\r\n]/.test(workspacePath)) return null;
  return { workspacePath, ...(id && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(id) ? { id } : {}) };
}

function refreshPolicy(state) {
  const project = currentProjectContext();
  const signature = project ? `${project.id || ""}\0${project.workspacePath}` : null;
  if (!project || state.policyPending || signature === state.policyContext) return;
  state.policyPending = true;
  state.policyContext = signature;
  state.policy = { ...DEFAULT_POLICY, enabled: false, exception: "pending-main-snapshot" };
  state.api.ipc.invoke(POLICY_CHANNEL, { action: "get", project }).then((snapshot) => {
    state.policy = normalizePolicySnapshot(snapshot) || { ...DEFAULT_POLICY, enabled: false, exception: "policy-unavailable" };
    if (state.policy.enabled) scan(state); else cleanupPanels(state);
  }).catch((error) => {
    state.policy = { ...DEFAULT_POLICY, enabled: false, exception: "policy-unavailable" };
    // Clear the cached context so a transient failure does NOT permanently
    // disable follow-ups — the next mutation retries this project's policy.
    state.policyContext = null;
    state.api?.log?.debug?.("followup policy fetch failed", String(error));
  }).finally(() => { state.policyPending = false; });
}

function normalizePayload(value) {
  if (!isRecord(value) || value.codex_follow_up !== true || !Array.isArray(value.items)) return null;
  if (value.items.length !== MAX_ITEMS) return null;
  const items = [];
  for (const raw of value.items) {
    const item = normalizeItem(raw);
    if (!item) return null;
    items.push(item);
  }
  const unique = dedupeItems(items);
  // Require FIVE DISTINCT prompts. Previously a payload with a duplicate passed
  // the length===5 check, then dedupe shrank it below 5, and policyAllowsPayload
  // (which also requires exactly 5) silently rejected it at render time with no
  // signal. Rejecting here makes the contract explicit and fail-closed.
  if (unique.length !== MAX_ITEMS) return null;
  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim().slice(0, 100)
    : "Follow-up";
  return { codex_follow_up: true, title, items: unique };
}

function normalizeItem(value) {
  if (!isRecord(value) || typeof value.prompt !== "string") return null;
  const prompt = value.prompt.trim();
  if (!prompt || prompt.length > 1000 || !Array.isArray(value.achieves)) return null;
  const achieves = value.achieves
    .filter((entry) => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (achieves.length < 1) return null;
  return { prompt, achieves };
}

function dedupeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const prompt = typeof item?.prompt === "string" ? item.prompt.trim() : "";
    const key = prompt.replace(/\s+/g, " ").toLocaleLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function parsePayload(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  const text = source.trim();
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(text))) candidates.push(match[1].trim());
  candidates.push(text.replace(/^json\s*/i, "").trim());
  for (const candidate of candidates) {
    for (const json of jsonCandidates(candidate)) {
      try {
        const parsed = normalizePayload(JSON.parse(json));
        if (parsed) return parsed;
      } catch {
        // Malformed or partial assistant output is intentionally ignored.
      }
    }
  }
  return null;
}

function* jsonCandidates(value) {
  const text = String(value || "").trim();
  if (text.startsWith("{") && text.endsWith("}")) yield text;
  const start = text.indexOf("{");
  if (start < 0) return;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) {
      yield text.slice(start, index + 1);
      return;
    }
  }
}

function collectMessageRoots(root = document) {
  const all = Array.from(root?.querySelectorAll?.(MESSAGE_SELECTOR) || []);
  return all.filter((message) => {
    const role = message.getAttribute?.("data-message-author-role") || message.getAttribute?.("data-role") || message.getAttribute?.("data-author-role");
    return !role || role.toLowerCase() === "assistant";
  });
}

function findPayload(message) {
  if (!message?.querySelectorAll) return null;
  let last = null;
  for (const node of message.querySelectorAll("pre, code")) {
    const payload = parsePayload(node.textContent || "");
    if (payload) last = { payload, source: node.closest?.("pre") || node };
  }
  return last;
}

function scan(state, roots) {
  if (state.disposed || !state.policy?.enabled) return;
  pruneDetached(state);
  const hostMessages = state.api?.react?.host?.query?.("assistant-turns")?.map((match) => match.element) || [];
  const messages = roots?.length ? roots : hostMessages.length ? hostMessages : collectMessageRoots(document);
  for (const message of messages) reconcileMessage(state, message);
}

function reconcileMessage(state, message) {
  if (!message?.isConnected && message !== document.body) return;
  const found = findPayload(message);
  if (found && !policyAllowsPayload(state.policy, found.payload)) return;
  const previous = state.roots.get(message);
  if (!found) {
    if (previous?.panel) previous.panel.remove();
    if (previous?.source) restoreSource(state, previous.source);
    state.roots.delete(message);
    return;
  }
  const signature = `${found.payload.title}|${found.payload.items.map((item) => `${item.prompt}\u0000${item.achieves.join("\u0000")}`).join("\u0001")}`;
  if (previous?.signature === signature && previous.panel?.isConnected) return;
  if (previous?.panel) previous.panel.remove();
  if (previous?.source && previous.source !== found.source) restoreSource(state, previous.source);
  hideSource(state, found.source);
  const panel = renderPanel(found.payload, state.api);
  panel.setAttribute("data-followup-context", message.getAttribute?.("data-message-id") || "assistant-message");
  message.appendChild(panel);
  state.panels.add(panel);
  state.roots.set(message, { signature, panel, source: found.source });
}

function renderPanel(payload, api) {
  const panel = document.createElement("section");
  panel.setAttribute(PANEL_ATTR, "true");
  panel.className = "tweaker-followup-panel flex flex-col gap-2 pt-3";
  const heading = document.createElement("div");
  heading.className = "text-sm font-medium text-token-text-secondary";
  heading.textContent = payload.title;
  panel.appendChild(heading);
  const list = document.createElement("div");
  list.className = "flex flex-col gap-1";
  for (const item of payload.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tweaker-followup-row border-token-border text-token-text-primary hover:bg-token-foreground/5 rounded-md border px-3 py-2 text-left text-sm";
    button.setAttribute("data-followup-prompt", item.prompt);
    button.textContent = item.prompt;
    button.addEventListener("click", () => insertPrompt(item.prompt, api));
    if (item.achieves.length) {
      const outcomes = document.createElement("span");
      outcomes.className = "block text-token-text-secondary text-xs";
      outcomes.textContent = item.achieves.join(" · ");
      button.appendChild(outcomes);
    }
    list.appendChild(button);
  }
  panel.appendChild(list);
  return panel;
}

function insertPrompt(prompt, api) {
  const text = String(prompt || "").trim();
  if (!text) return false;
  // The SDK exposes no composer/send bridge, so target the real Codex composer
  // in the DOM directly (most specific selector first) instead of grabbing the
  // first textarea anywhere on the page.
  const target = api?.react?.host?.query?.("composer")?.[0]?.element || findComposer();
  if (!target) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(target.constructor.prototype, "value")?.set;
    if (setter) setter.call(target, text); else target.value = text;
  } else {
    target.textContent = text;
  }
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus?.();
  return true;
}

function findComposer() {
  if (typeof document === "undefined") return null;
  const selectors = [
    "#prompt-textarea",
    '[data-testid="composer"] textarea',
    'form [contenteditable="true"]:not([aria-hidden="true"])',
    "textarea[data-testid]:not([disabled])",
    'textarea:not([disabled]):not([aria-hidden="true"])',
    '[contenteditable="true"]:not([aria-hidden="true"])',
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node && isRenderedNode(node)) return node;
  }
  return null;
}

function isRenderedNode(node) {
  if (typeof node.getClientRects !== "function") return true;
  try { return node.getClientRects().length > 0; } catch { return true; }
}

function pruneDetached(state) {
  // The hidden-source Map and panels Set are keyed by DOM nodes that a host
  // re-render can detach; drop those so they don't accumulate over a session.
  for (const source of [...state.hidden.keys()]) {
    if (source && source.isConnected === false) state.hidden.delete(source);
  }
  for (const panel of [...state.panels]) {
    if (panel && panel.isConnected === false) state.panels.delete(panel);
  }
}

function hideSource(state, source) {
  if (!source?.setAttribute || state.hidden.has(source)) return;
  state.hidden.set(source, {
    hidden: source.hidden,
    display: source.style?.getPropertyValue?.("display") || "",
    priority: source.style?.getPropertyPriority?.("display") || "",
  });
  source.setAttribute(SOURCE_ATTR, "true");
  source.hidden = true;
  source.style?.setProperty?.("display", "none", "important");
}

function restoreSource(state, source) {
  const original = state.hidden.get(source);
  if (!original) return;
  source.hidden = original.hidden;
  source.removeAttribute?.(SOURCE_ATTR);
  if (original.display) source.style?.setProperty?.("display", original.display, original.priority);
  else source.style?.removeProperty?.("display");
  state.hidden.delete(source);
}

function cleanup(state) {
  state.disposed = true;
  if (state.pending != null) {
    (window.clearTimeout || clearTimeout)(state.pending);
    state.pending = null;
  }
  state.observer?.disconnect?.();
  for (const panel of state.panels) panel.remove?.();
  state.panels.clear();
  for (const source of state.hidden.keys()) restoreSource(state, source);
  state.roots = new WeakMap();
}

function cleanupPanels(state) {
  for (const panel of state.panels) panel.remove?.();
  state.panels.clear();
  for (const source of state.hidden.keys()) restoreSource(state, source);
  state.roots = new WeakMap();
}

function scheduleScan(state, records) {
  if (state.disposed || state.pending != null) return;
  refreshPolicy(state);
  const roots = new Set();
  for (const record of records || []) {
    let node = record.target;
    while (node && node !== document.body && !matchesMessage(node)) node = node.parentElement;
    if (matchesMessage(node)) roots.add(node);
    for (const added of record.addedNodes || []) {
      for (const root of collectMessageRoots(added)) roots.add(root);
    }
  }
  state.pending = (window.setTimeout || setTimeout)(() => {
    state.pending = null;
    scan(state, roots.size ? Array.from(roots) : undefined);
  }, 50);
}

function matchesMessage(node) {
  return Boolean(node?.matches?.(MESSAGE_SELECTOR));
}

function installStyle() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `[${PANEL_ATTR}] { max-width: 48rem; } [${PANEL_ATTR}] button { cursor: pointer; }`;
  (document.head || document.documentElement).appendChild(style);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
