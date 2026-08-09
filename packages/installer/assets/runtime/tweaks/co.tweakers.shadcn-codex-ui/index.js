"use strict";

const OWNER = "co.tweakers.shadcn-codex-ui";
const STYLE_ID = "tweaker-shadcn-codex-ui-style";
const MOUNT_ATTR = "data-co-tweakers-shadcn-codex-ui-rich-block-owner";
const ENABLED_KEY = "enabled";
const NORMALIZED_PAYLOADS = new WeakSet();
const RICH_BLOCK_MOUNTS = new WeakMap();
const INVALID_VALUE = Symbol("invalid-rich-block-value");

// Rich Blocks v1 is deliberately extensible. The built-in kinds below receive
// native-looking renderers; a valid unknown kind receives a safe text fallback.
// This lets a producer add a new v1 block without making older renderers blank.
const RICH_BLOCK_PROTOCOL = Object.freeze({
  version: 1,
  extensible: true,
  builtInKinds: Object.freeze(["heading", "text", "paragraph", "code", "list", "badge", "divider", "keyValue", "callout"]),
  bounds: Object.freeze({
    serializedBytes: 64 * 1024,
    normalizedBytes: 48 * 1024,
    blocks: 50,
    messageCandidates: 100,
    fieldsPerBlock: 20,
    fieldNameChars: 64,
    stringChars: 2000,
    arrayItems: 20,
    objectFields: 12,
    nesting: 3,
    keyValuePairs: 20,
    pairTextChars: 500,
  }),
});
const states = new WeakMap();

const helpers = {
  parseRichPayload,
  reconcileRichBlock,
  collectRichBlockRoots,
  mergeRichBlockRoots,
  disposeRichBlockMount,
  renderBlock,
  renderSettings,
  scan,
  getRichBlockMount: (message) => RICH_BLOCK_MOUNTS.get(message) || null,
  getState: (instance) => states.get(instance),
  RICH_BLOCK_PROTOCOL,
};

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const state = {
      api,
      disposed: false,
      observer: null,
      pending: null,
      // Keyed by message element so a streamed update replaces its prior mount.
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
        description: "Render bounded Rich Blocks v1 without replacing native messages.",
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
  for (const mount of Array.from(state.mounts.values())) disposeRichBlockMount(mount.message, mount);
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
  note.textContent = `Rich Blocks v${RICH_BLOCK_PROTOCOL.version} accepts safe extension kinds. Built-in renderers: ${RICH_BLOCK_PROTOCOL.builtInKinds.join(", ")}. Invalid or oversized payloads do not render.`;
  const status = document.createElement("div");
  status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const matches = state.api?.react?.host?.snapshot?.("assistant-turns")?.count || 0;
  status.textContent = `Reported assistant surfaces: ${matches}. Active rich mounts: ${state.mounts.size}.`;
  const previewTitle = document.createElement("div");
  previewTitle.className = "pt-2 text-sm font-medium text-token-text-primary";
  previewTitle.textContent = "Block preview";
  const preview = document.createElement("div");
  preview.className = "tweaker-rich-blocks flex flex-col gap-2 rounded-lg border border-token-border p-3";
  renderBlocks(preview, [
    { kind: "heading", text: "Rich response" },
    { kind: "text", text: "Native message content remains intact." },
    { kind: "badge", text: "Preview" },
    { kind: "keyValue", pairs: [{ key: "Status", value: "Ready" }] },
    { kind: "callout", title: "Bounded", text: "Only valid version 1 blocks render." },
  ]);
  root.append(row, note, status, previewTitle, preview);
}

function parseRichPayload(value) {
  let candidate = value;
  if (typeof value === "string") {
    if (!withinByteLimit(value, RICH_BLOCK_PROTOCOL.bounds.serializedBytes)) return null;
    try { candidate = JSON.parse(value); } catch { return null; }
  } else if (serializedWithinLimit(value, RICH_BLOCK_PROTOCOL.bounds.serializedBytes) == null) {
    return null;
  }
  if (!isRecord(candidate) || candidate.version !== RICH_BLOCK_PROTOCOL.version || !Array.isArray(candidate.blocks)) return null;
  if (candidate.blocks.length > RICH_BLOCK_PROTOCOL.bounds.blocks) return null;
  const blocks = candidate.blocks.map(normalizeBlock);
  if (blocks.some((block) => !block)) return null;
  const payload = { version: RICH_BLOCK_PROTOCOL.version, blocks };
  if (serializedWithinLimit(payload, RICH_BLOCK_PROTOCOL.bounds.normalizedBytes) == null) return null;
  NORMALIZED_PAYLOADS.add(payload);
  return payload;
}

function normalizeBlock(block) {
  if (!isRecord(block) || typeof block.kind !== "string") return null;
  const kind = block.kind.trim();
  const { bounds } = RICH_BLOCK_PROTOCOL;
  if (!kind || kind.length > bounds.fieldNameChars || Object.keys(block).length > bounds.fieldsPerBlock) return null;
  const out = { kind };
  if (kind === "keyValue") {
    const pairs = normalizePairs(block);
    if (!pairs) return null;
    out.pairs = pairs;
  }
  for (const [key, value] of Object.entries(block)) {
    if (key === "kind" || (kind === "keyValue" && (key === "pairs" || key === "key" || key === "value"))) continue;
    if (!isSafeFieldName(key)) return null;
    const normalized = normalizeValue(value, 0);
    if (normalized === INVALID_VALUE) return null;
    out[key] = normalized;
  }
  return out;
}

function normalizePairs(block) {
  const rawPairs = Array.isArray(block.pairs)
    ? block.pairs
    : (Object.prototype.hasOwnProperty.call(block, "key") || Object.prototype.hasOwnProperty.call(block, "value"))
      ? [{ key: block.key, value: block.value }]
      : [];
  if (rawPairs.length > RICH_BLOCK_PROTOCOL.bounds.keyValuePairs) return null;
  const pairs = [];
  for (const pair of rawPairs) {
    if (!isRecord(pair)) return null;
    const key = normalizePairText(pair.key);
    const value = normalizePairText(pair.value);
    if (key == null || value == null) return null;
    pairs.push({ key, value });
  }
  return pairs;
}

function normalizePairText(value) {
  if (!["string", "number", "boolean"].includes(typeof value) && value !== null) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return String(value ?? "").slice(0, RICH_BLOCK_PROTOCOL.bounds.pairTextChars);
}

function normalizeValue(value, depth) {
  const { bounds } = RICH_BLOCK_PROTOCOL;
  if (typeof value === "string") return value.slice(0, bounds.stringChars);
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_VALUE;
  if (depth >= bounds.nesting) return INVALID_VALUE;
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value.slice(0, bounds.arrayItems)) {
      const normalized = normalizeValue(item, depth + 1);
      if (normalized === INVALID_VALUE) return INVALID_VALUE;
      out.push(normalized);
    }
    return out;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > bounds.objectFields) return INVALID_VALUE;
    const out = {};
    for (const [key, item] of entries) {
      if (!isSafeFieldName(key)) return INVALID_VALUE;
      const normalized = normalizeValue(item, depth + 1);
      if (normalized === INVALID_VALUE) return INVALID_VALUE;
      out[key] = normalized;
    }
    return out;
  }
  return INVALID_VALUE;
}

function reconcileRichBlock(message, rawPayload) {
  if (!message || typeof message !== "object") return null;
  const payload = NORMALIZED_PAYLOADS.has(rawPayload) ? rawPayload : parseRichPayload(rawPayload);
  const previous = RICH_BLOCK_MOUNTS.get(message) || null;
  if (!payload) {
    if (previous?.owner === OWNER) disposeRichBlockMount(message, previous);
    return null;
  }
  // Never replace a mount owned by another adapter.
  if (previous && previous.owner !== OWNER) return null;
  const payloadHash = JSON.stringify(payload);
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
    RICH_BLOCK_MOUNTS.set(message, mount);
    return mount;
  }
  const mount = { owner: OWNER, messageId: message.id, payloadHash, payload, message };
  RICH_BLOCK_MOUNTS.set(message, mount);
  return mount;
}

function disposeRichBlockMount(message, mount) {
  if (!mount || mount.owner !== OWNER) return;
  mount.host?.remove?.();
  if (message && RICH_BLOCK_MOUNTS.get(message) === mount) RICH_BLOCK_MOUNTS.delete(message);
}

function collectRichBlockRoots(root) {
  if (Array.isArray(root)) return root.filter((item) => item?.kind === "message");
  const source = root || (typeof document !== "undefined" ? document : null);
  const nodes = Array.from(source?.querySelectorAll?.(
    '[data-message-author-role="assistant"], [data-role="assistant"], [data-message-id]',
  ) || []);
  return nodes.filter((node) => {
    const role = node.getAttribute?.("data-message-author-role") || node.getAttribute?.("data-role") || node.getAttribute?.("data-author-role");
    const kind = node.getAttribute?.("data-message-kind");
    return kind !== "composer" && kind !== "tool" && (!role || role.toLowerCase() === "assistant");
  });
}

function mergeRichBlockRoots(hostRoots, nativeRoots) {
  const merged = new Map();
  for (const root of [...hostRoots, ...nativeRoots]) {
    if (!root) continue;
    const id = root.id || root.getAttribute?.("data-message-id");
    merged.set(id ? `id:${id}` : root, root);
  }
  return Array.from(merged.values()).slice(-RICH_BLOCK_PROTOCOL.bounds.messageCandidates);
}

function scan(state) {
  if (state.disposed) return;
  if (!state.enabled) { disposeAllMounts(state); return; }
  const hostRoots = (state.api?.react?.host?.query?.("assistant-turns") || []).map((match) => match?.element).filter(Boolean);
  // The host can return an early capped page. Merge it with native candidates,
  // deduplicate by message id, then retain the newest bounded window.
  const roots = mergeRichBlockRoots(hostRoots, collectRichBlockRoots(document));
  for (const message of roots) {
    const payload = findPayload(message); // Parsed once; reconcile reuses normalized payloads.
    const mount = reconcileRichBlock(message, payload);
    if (mount?.host) state.mounts.set(message, mount);
    else if (!mount) state.mounts.delete(message);
  }
  for (const [message, mount] of Array.from(state.mounts)) {
    if (message?.isConnected === false || mount.host?.isConnected === false) {
      disposeRichBlockMount(mount.message, mount);
      state.mounts.delete(message);
    }
  }
}

function findPayload(message) {
  const raw = message.getAttribute?.("data-rich-payload") || message.querySelector?.("[data-rich-payload]")?.getAttribute?.("data-rich-payload");
  if (raw) return parseRichPayload(raw);
  for (const node of Array.from(message.querySelectorAll?.("pre, code") || []).reverse()) {
    const payload = parseRichPayload(node.textContent || "");
    if (payload) return payload;
  }
  return null;
}

function renderBlocks(host, blocks) {
  for (const block of blocks || []) host.appendChild(renderBlock(block));
}

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
      const list = el("ul", "list-disc pl-5 text-sm text-token-text-secondary");
      for (const item of Array.isArray(block.items) ? block.items : []) list.appendChild(el("li", null, str(item)));
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
      for (const pair of Array.isArray(block.pairs) ? block.pairs : []) {
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
      wrap.className = "border-token-border rounded-md border px-3 py-2 text-sm text-token-text-primary";
      wrap.textContent = str(block.text) || kind || "block";
      return wrap;
  }
}

function installStyle() {
  const style = document.getElementById?.(STYLE_ID) || document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `[${MOUNT_ATTR}="${OWNER}"] { contain: layout style; }`;
  if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  return style;
}

function schedule(state) {
  if (state.disposed || state.pending != null) return;
  state.pending = requestFrame(() => { state.pending = null; scan(state); });
}

function requestFrame(callback) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") return window.requestAnimationFrame(callback);
  return typeof setTimeout === "function" ? setTimeout(callback, 16) : null;
}

function cancelFrame(id) {
  if (typeof window !== "undefined") window.cancelAnimationFrame?.(id);
  if (typeof clearTimeout === "function") clearTimeout(id);
}

function withinByteLimit(value, limit) { return byteLength(value) <= limit; }
function serializedWithinLimit(value, limit) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && withinByteLimit(serialized, limit) ? serialized : null;
  } catch { return null; }
}
function byteLength(value) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value).length;
  return encodeURIComponent(value).replace(/%[0-9A-F]{2}|./gi, "x").length;
}
function isSafeFieldName(key) {
  return typeof key === "string"
    && key.length > 0
    && key.length <= RICH_BLOCK_PROTOCOL.bounds.fieldNameChars
    && !/^(?:html|script|on[a-z]|__proto__|constructor|prototype)$/i.test(key);
}
function str(value) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function isDomNode(value) { return typeof Node !== "undefined" && value instanceof Node && typeof value.appendChild === "function"; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
