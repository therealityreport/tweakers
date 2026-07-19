"use strict";

const OWNER = "co.tweakers.shadcn-codex-ui";
const STYLE_ID = "tweaker-shadcn-codex-ui-style";
const MOUNT_ATTR = "data-tweaker-rich-block-owner";
const ENABLED_KEY = "enabled";
const SUPPORTED_KINDS = Object.freeze(["heading", "text", "paragraph", "code", "list", "badge", "divider", "keyValue", "callout"]);
const states = new WeakMap();

const helpers = {
  parseRichPayload,
  reconcileRichBlock,
  collectRichBlockRoots,
  disposeRichBlockMount,
  renderBlock,
  SUPPORTED_KINDS,
};

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const state = {
      api,
      disposed: false,
      observer: null,
      pending: null,
      // Keyed by message element so a changed payload REPLACES the message's
      // mount instead of accumulating a stale one (the old Set leaked a mount
      // object per streamed payload update).
      mounts: new Map(),
      style: null,
      settings: null,
      enabled: api?.storage?.get?.(ENABLED_KEY, true) !== false,
    };
    states.set(this, state);
    state.style = installStyle();
    if (typeof api?.settings?.registerPage === "function") {
      state.settings = api.settings.registerPage({
        id: "shadcn-codex-ui",
        title: "Shadcn Codex UI",
        description: "Render supported rich blocks without replacing native messages.",
        iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 11 5 5 7-7M4 6l2-2m3 7 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        render(root) { renderSettings(root, state); },
      });
    }
    const disposeHost = api.react?.host?.observe?.(["assistant-turns"], () => schedule(state));
    state.observer = disposeHost ? { disconnect: disposeHost } : null;
    schedule(state);
  },

  stop() {
    const state = states.get(this);
    if (!state) return;
    state.disposed = true;
    if (state.pending != null) {
      cancelFrame(state.pending);
      state.pending = null;
    }
    state.observer?.disconnect();
    state.observer = null;
    disposeAllMounts(state);
    state.settings?.unregister?.();
    state.style?.remove?.();
    states.delete(this);
  },

  _test: helpers,
  __test: helpers,
};

function disposeAllMounts(state) {
  for (const mount of Array.from(state.mounts.values())) {
    disposeRichBlockMount(mount.message, mount);
  }
  state.mounts.clear();
}

function renderSettings(root, state) {
  if (!root) return;
  root.replaceChildren?.();
  root.className = "flex flex-col gap-2";
  const row = document.createElement("label");
  row.className = "flex items-center justify-between gap-4 rounded-lg border border-token-border p-3";
  const text = document.createElement("span");
  text.className = "text-sm text-token-text-primary";
  text.textContent = "Render rich blocks";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.checked = state.enabled;
  input.addEventListener("change", () => {
    state.enabled = input.checked;
    state.api?.storage?.set?.(ENABLED_KEY, state.enabled);
    if (!state.enabled) disposeAllMounts(state);
    else schedule(state);
  });
  row.append(text, input);
  const note = document.createElement("div");
  note.className = "text-token-text-secondary text-xs px-2";
  note.textContent = `Supported blocks: ${SUPPORTED_KINDS.join(", ")}. Only valid version 1 payloads render; native messages are never replaced.`;
  const status = document.createElement("div");
  status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const matches = state.api?.react?.host?.snapshot?.("assistant-turns")?.count || 0;
  status.textContent = `Live assistant surfaces detected: ${matches}. Active rich mounts: ${state.mounts.size}.`;
  const previewTitle = document.createElement("div");
  previewTitle.className = "pt-2 text-sm font-medium text-token-text-primary";
  previewTitle.textContent = "Block preview";
  const preview = document.createElement("div");
  preview.className = "tweaker-rich-blocks flex flex-col gap-2 rounded-lg border border-token-border p-3";
  renderBlocks(preview, [
    { kind: "heading", text: "Rich response" },
    { kind: "text", text: "Native message content remains intact." },
    { kind: "badge", text: "Preview" },
    { kind: "keyValue", key: "Status", value: "Ready" },
    { kind: "callout", title: "Bounded", text: "Only supported version 1 blocks render." },
  ]);
  root.append(row, note, status, previewTitle, preview);
}

function parseRichPayload(value) {
  let candidate = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { return null; }
  }
  if (!isRecord(candidate) || candidate.version !== 1 || !Array.isArray(candidate.blocks)) return null;
  if (candidate.blocks.length > 100) return null;
  const blocks = candidate.blocks.map(normalizeBlock);
  if (blocks.some((block) => !block)) return null;
  return { version: 1, blocks };
}

function normalizeBlock(block) {
  if (!isRecord(block) || typeof block.kind !== "string" || !block.kind.trim() || block.kind.length > 80) return null;
  // Rich blocks are intentionally opaque to native content. Keep only a
  // bounded JSON-safe projection so payloads cannot smuggle DOM or callbacks.
  const out = { kind: block.kind.trim() };
  for (const [key, value] of Object.entries(block)) {
    if (key === "kind" || key.length > 80 || /^(?:html|script|on[a-z])/i.test(key)) continue;
    if (typeof value === "string") out[key] = value.slice(0, 2000);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (value === null) out[key] = null;
    else if (Array.isArray(value)) out[key] = value.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 500) : item);
  }
  return out;
}

function reconcileRichBlock(message, rawPayload) {
  if (!message || typeof message !== "object") return null;
  const payload = parseRichPayload(rawPayload);
  const previous = message.ownedMount;
  if (!payload) {
    if (previous?.owner === OWNER) disposeRichBlockMount(message, previous);
    return null;
  }
  // Never replace a mount owned by another adapter.
  if (previous && previous.owner !== OWNER) return null;
  const payloadHash = JSON.stringify(payload);
  // Reuse the existing mount only if it is unchanged AND still attached. If a
  // host re-render detached our <section>, fall through and re-anchor it.
  if (
    previous?.owner === OWNER &&
    previous.messageId === message.id &&
    previous.payloadHash === payloadHash &&
    (previous.host == null || previous.host.isConnected !== false)
  ) return previous;
  if (previous) disposeRichBlockMount(message, previous);
  if (isDomNode(message)) {
    const host = document.createElement("section");
    host.setAttribute(MOUNT_ATTR, OWNER);
    host.setAttribute("data-message-id", String(message.id || message.getAttribute?.("data-message-id") || ""));
    host.className = "tweaker-rich-blocks flex flex-col gap-2 pt-3";
    renderBlocks(host, payload.blocks);
    const content = message.querySelector?.("[data-message-content], [data-testid*=message-content], .markdown, [class*=markdown]") || message;
    content.appendChild(host);
    const mount = { owner: OWNER, messageId: message.id || message.getAttribute?.("data-message-id") || null, payloadHash, payload, host, message };
    message.ownedMount = mount;
    return mount;
  }
  const mount = { owner: OWNER, messageId: message.id, payloadHash, payload, message };
  message.ownedMount = mount;
  return mount;
}

function disposeRichBlockMount(message, mount) {
  if (!mount || mount.owner !== OWNER) return;
  mount.host?.remove?.();
  if (message && message.ownedMount === mount) message.ownedMount = null;
}

function collectRichBlockRoots(root) {
  if (Array.isArray(root)) return root.filter((item) => item?.kind === "message");
  const source = root || (typeof document !== "undefined" ? document : null);
  // Stable data-* hooks only; the old `.group.flex.min-w-0.flex-col` class chain
  // was coupled to Codex's Tailwind output and broke on any restyle.
  const nodes = Array.from(source?.querySelectorAll?.(
    '[data-message-author-role="assistant"], [data-role="assistant"], [data-message-id]',
  ) || []);
  return nodes.filter((node) => {
    const role = node.getAttribute?.("data-message-author-role") || node.getAttribute?.("data-role") || node.getAttribute?.("data-author-role");
    const kind = node.getAttribute?.("data-message-kind");
    return kind !== "composer" && kind !== "tool" && (!role || role.toLowerCase() === "assistant");
  });
}

function scan(state) {
  if (state.disposed) return;
  if (!state.enabled) { disposeAllMounts(state); return; }
  const hostMatches = state.api?.react?.host?.query?.("assistant-turns") || [];
  const roots = hostMatches.length ? hostMatches.map((match) => match.element) : collectRichBlockRoots(document);
  for (const message of roots) {
    const found = findPayload(message);
    const mount = reconcileRichBlock(message, found);
    if (mount?.host) state.mounts.set(message, mount); // replaces any prior mount for this message
    else if (!mount) state.mounts.delete(message);
  }
  // Drop mounts whose message OR injected host has left the DOM.
  for (const [message, mount] of Array.from(state.mounts)) {
    if (message?.isConnected === false || mount.host?.isConnected === false) {
      disposeRichBlockMount(mount.message, mount);
      state.mounts.delete(message);
    }
  }
}

function findPayload(message) {
  const raw = message.getAttribute?.("data-rich-payload") || message.querySelector?.("[data-rich-payload]")?.getAttribute?.("data-rich-payload");
  if (raw) return raw;
  for (const node of Array.from(message.querySelectorAll?.("pre, code") || []).reverse()) {
    if (parseRichPayload(node.textContent || "")) return node.textContent;
  }
  return null;
}

function renderBlocks(host, blocks) {
  for (const block of blocks) host.appendChild(renderBlock(block));
}

// Per-kind, shadcn-flavored rendering. Everything is set via textContent (the
// payload is already stripped of html/script/on* keys upstream), so no markup
// can be smuggled in through a block.
function renderBlock(block) {
  const kind = String(block?.kind || "").trim();
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };
  const wrap = document.createElement("div");
  wrap.setAttribute("data-rich-block-kind", kind || "unknown");

  switch (kind) {
    case "heading":
      wrap.className = "text-sm font-semibold text-token-text-primary";
      wrap.textContent = str(block.text);
      return wrap;
    case "text":
    case "paragraph":
      wrap.className = "text-sm leading-relaxed text-token-text-secondary";
      wrap.textContent = str(block.text);
      return wrap;
    case "code": {
      wrap.className = "border-token-border overflow-x-auto rounded-md border bg-token-foreground/5 p-3";
      const pre = el("pre", "font-mono text-xs text-token-text-primary whitespace-pre-wrap");
      pre.appendChild(el("code", null, str(block.code ?? block.text)));
      wrap.appendChild(pre);
      return wrap;
    }
    case "list": {
      wrap.className = "flex flex-col gap-1";
      const items = Array.isArray(block.items) ? block.items : [];
      const list = el("ul", "list-disc pl-5 text-sm text-token-text-secondary");
      for (const item of items) list.appendChild(el("li", null, str(item)));
      wrap.appendChild(list);
      return wrap;
    }
    case "badge":
      wrap.className = "inline-flex w-fit items-center rounded-full border border-token-border px-2 py-0.5 text-xs text-token-text-secondary";
      wrap.textContent = str(block.text ?? block.label);
      return wrap;
    case "divider":
      wrap.className = "border-token-border my-1 border-t";
      return wrap;
    case "keyValue": {
      wrap.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-md border";
      const pairs = Array.isArray(block.pairs) ? block.pairs : [];
      for (const pair of pairs) {
        const rowEl = el("div", "flex items-center justify-between gap-4 px-3 py-1.5 text-sm");
        rowEl.appendChild(el("span", "text-token-text-secondary", str(pair?.key)));
        rowEl.appendChild(el("span", "text-token-text-primary", str(pair?.value)));
        wrap.appendChild(rowEl);
      }
      return wrap;
    }
    case "callout": {
      wrap.className = "border-token-border rounded-md border bg-token-foreground/5 px-3 py-2";
      if (str(block.title)) wrap.appendChild(el("div", "text-sm font-medium text-token-text-primary", str(block.title)));
      if (str(block.text)) wrap.appendChild(el("div", "text-sm text-token-text-secondary", str(block.text)));
      return wrap;
    }
    default:
      // Unknown kind: show a labelled fallback rather than nothing.
      wrap.className = "border-token-border rounded-md border px-3 py-2 text-sm text-token-text-primary";
      wrap.textContent = str(block.text) || kind || "block";
      return wrap;
  }
}

function str(value) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function schedule(state) {
  if (state.disposed || state.pending != null) return;
  state.pending = requestFrame(() => { state.pending = null; scan(state); });
}

function installStyle() {
  const style = document.getElementById?.(STYLE_ID) || document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `[${MOUNT_ATTR}="${OWNER}"] { contain: layout style; }`;
  if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  return style;
}

function requestFrame(callback) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
  return typeof setTimeout === "function" ? setTimeout(callback, 16) : null;
}

function cancelFrame(id) {
  if (typeof window !== "undefined") window.cancelAnimationFrame?.(id);
  if (typeof clearTimeout === "function") clearTimeout(id);
}

function isDomNode(value) { return typeof Node !== "undefined" && value instanceof Node && typeof value.appendChild === "function"; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
