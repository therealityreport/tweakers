"use strict";

const STORAGE_KEY = "enabledImprovements";
const LAYOUT_KEY = "sidebarLayout";
const STORAGE_VERSION = 3;
const TOGGLE_IDS = Object.freeze([
  "sidebar-layout",
  "chat-multi-select",
  "slash-menu-improvements",
  "message-metrics",
]);
const OWNERSHIP = Object.freeze(Object.fromEntries(TOGGLE_IDS.map((id) => [id, "ui-improvements"])));
const instances = new WeakMap();

const helpers = {
  STORAGE_KEY,
  TOGGLE_IDS,
  toggleIds: TOGGLE_IDS,
  toggles: TOGGLE_IDS,
  OWNERSHIP,
  ownership: OWNERSHIP,
  normalizeToggleState,
  cleanupToggle,
  teardownToggle: cleanupToggle,
  cleanup: cleanupToggle,
  setToggleEnabled,
  pruneDetached,
  countMessageWords,
  installStyle,
};

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const stored = api?.storage?.get?.(STORAGE_KEY, null);
    const enabled = normalizeToggleState(stored);
    const savedLayout = api?.storage?.get?.(LAYOUT_KEY, null);
    const state = { api, enabled, layout: { width: Math.min(420, Math.max(220, Number(savedLayout?.width) || 288)), density: ["compact", "comfortable"].includes(savedLayout?.density) ? savedLayout.density : "comfortable" }, mounts: [], listeners: [], styles: [], settings: null, disposed: false, observer: null, scanPending: null };
    instances.set(this, state);
    if (stored?.version !== STORAGE_VERSION) persistToggleState(state);
    state.settings = api?.settings?.registerPage?.({
      id: "ui-improvements",
      title: "UI Improvements",
      description: "Four useful interface improvements, each independently switchable.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m10 2 1.2 4.1L15 5l-2.1 3.5L17 10l-4.1 1.5L15 15l-3.8-1.1L10 18l-1.2-4.1L5 15l2.1-3.5L3 10l4.1-1.5L5 5l3.8 1.1L10 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
      render(root) { renderSettings(root, state); },
    }) || null;
    for (const id of TOGGLE_IDS) if (enabled.has(id)) activateToggle(state, id);
    startObserver(state);
  },

  stop() {
    const state = instances.get(this);
    if (!state) return;
    state.disposed = true;
    if (state.scanPending != null) {
      window.cancelAnimationFrame?.(state.scanPending);
      window.clearTimeout?.(state.scanPending);
      state.scanPending = null;
    }
    state.observer?.disconnect?.();
    state.observer = null;
    for (const id of TOGGLE_IDS) cleanupToggle(state, id, { keepEnabled: true });
    state.settings?.unregister?.();
    instances.delete(this);
  },

  _test: helpers,
  __test: helpers,
};

// One shared, rAF-debounced observer dispatches to every enabled behavior.
// (Previously each toggle installed its own document-wide observer, so N
// enabled toggles meant N full-document scans per mutation.)
function startObserver(state) {
  if (state.disposed) return;
  const disposeHost = state.api?.react?.host?.observe?.(["projects", "assistant-turns", "composer", "command-menu", "settings-rows"], () => scheduleScanAll(state));
  state.observer = disposeHost ? { disconnect: disposeHost } : null;
}

function scheduleScanAll(state) {
  if (state.disposed || state.scanPending != null) return;
  const raf = window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 16));
  state.scanPending = raf(() => {
    state.scanPending = null;
    scanAll(state);
  });
}

function scanAll(state) {
  if (state.disposed) return;
  pruneDetached(state);
  for (const id of TOGGLE_IDS) if (state.enabled.has(id)) scanBehavior(state, id);
}

// Reconcile tracking against the live DOM: entries whose node has been detached
// by a host re-render are dropped so the arrays don't grow without bound.
function pruneDetached(state) {
  state.mounts = state.mounts.filter((entry) => !(entry?.node && entry.node.isConnected === false));
  state.listeners = state.listeners.filter((entry) => {
    if (entry?.target && entry.target.isConnected === false) {
      try { entry.target.removeEventListener?.(entry.type, entry.listener); } catch { /* detached */ }
      return false;
    }
    return true;
  });
}

function normalizeToggleState(raw) {
  const enabled = new Set(TOGGLE_IDS);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![1, 2, STORAGE_VERSION].includes(raw.version)) return enabled;
  for (const id of TOGGLE_IDS) {
    if (raw.enabled?.[id] === false) enabled.delete(id);
    else if (raw.enabled?.[id] === true) enabled.add(id);
  }
  return enabled;
}

function persistToggleState(state) {
  state.api?.storage?.set?.(STORAGE_KEY, {
    version: STORAGE_VERSION,
    enabled: Object.fromEntries(TOGGLE_IDS.map((id) => [id, state.enabled.has(id)])),
  });
}

function setToggleEnabled(state, id, enabled, options = {}) {
  if (!TOGGLE_IDS.includes(id)) return false;
  if (enabled) {
    state.enabled.add(id);
    activateToggle(state, id);
  } else {
    cleanupToggle(state, id);
  }
  if (options.persist !== false) persistToggleState(state);
  return state.enabled.has(id);
}

// Idempotent: installStyle is a no-op when a style for this id already exists,
// and scanBehavior is guarded per-node, so re-activating an already-active
// toggle can never create a duplicate style or observer.
function activateToggle(state, id) {
  try {
    installStyle(state, id);
    scanBehavior(state, id);
  } catch (error) {
    cleanupToggle(state, id);
    state.api?.log?.warn?.(`UI improvement ${id} failed to start`, String(error));
  }
}

function scanBehavior(state, id) {
  if (state.disposed || !state.enabled.has(id)) return;
  const behavior = BEHAVIORS[id];
  try { behavior?.(state); }
  catch (error) { state.api?.log?.warn?.(`UI improvement ${id} could not update`, String(error)); }
}

const BEHAVIORS = Object.freeze({
  "sidebar-layout": applySidebarLayout,
  "chat-multi-select": applyChatMultiSelect,
  "slash-menu-improvements": applySlashMenuImprovements,
  "message-metrics": applyMessageMetrics,
});

function applySidebarLayout(state) {
  const sidebars = [...new Set((state.api?.react?.host?.query?.("projects") || []).map((match) => match.element?.closest?.("aside, nav")).filter(Boolean))];
  for (const sidebar of sidebars) {
    if (sidebar.hasAttribute("data-tweaker-sidebar-layout")) continue;
    sidebar.setAttribute("data-tweaker-sidebar-layout", "true");
    sidebar.setAttribute("data-tweaker-sidebar-density", state.layout.density);
    sidebar.style.setProperty("--tweaker-sidebar-width", `${state.layout.width}px`);
    ownMount(state, "sidebar-layout", () => { sidebar.removeAttribute("data-tweaker-sidebar-layout"); sidebar.removeAttribute("data-tweaker-sidebar-density"); sidebar.style.removeProperty("--tweaker-sidebar-width"); }, sidebar);
  }
}

function applyChatMultiSelect(state) {
  const matches = state.api?.react?.host?.query?.("assistant-turns") || [];
  for (const message of matches.map((match) => match.element)) {
    if (message.hasAttribute("data-tweaker-multiselect-ready")) continue;
    message.setAttribute("data-tweaker-multiselect-ready", "true");
    const onClick = (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      message.toggleAttribute("data-tweaker-message-selected");
      renderSelectionToolbar(state);
    };
    message.addEventListener("click", onClick);
    state.listeners.push({ id: "chat-multi-select", target: message, type: "click", listener: onClick });
    ownMount(state, "chat-multi-select", () => {
      message.removeAttribute("data-tweaker-multiselect-ready");
      message.removeAttribute("data-tweaker-message-selected");
    }, message);
  }
}

function renderSelectionToolbar(state) {
  document.querySelector("[data-tweaker-selection-toolbar]")?.remove();
  const selected = [...document.querySelectorAll("[data-tweaker-message-selected]")];
  if (!selected.length) return;
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-tweaker-selection-toolbar", "true");
  toolbar.className = "fixed bottom-6 left-1/2 z-[9999] flex -translate-x-1/2 gap-2 rounded-lg border border-token-border bg-token-main-surface-primary p-2 shadow-lg";
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "rounded-md bg-token-foreground/5 px-3 py-1.5 text-sm text-token-text-primary"; copy.textContent = `Copy ${selected.length}`;
  copy.addEventListener("click", () => void navigator.clipboard?.writeText(selected.map((node) => node.textContent || "").join("\n\n")));
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = copy.className; clear.textContent = "Clear";
  clear.addEventListener("click", () => { for (const node of selected) node.removeAttribute("data-tweaker-message-selected"); toolbar.remove(); });
  toolbar.append(copy, clear); document.body.appendChild(toolbar);
  ownMount(state, "chat-multi-select", () => toolbar.remove(), toolbar);
}

function applySlashMenuImprovements(state) {
  const matches = state.api?.react?.host?.query?.("command-menu") || [];
  for (const menu of matches.map((match) => match.element)) {
    if (menu.hasAttribute("data-tweaker-slash-navigation")) continue;
    menu.setAttribute("data-tweaker-slash-navigation", "true");
    const onKeydown = (event) => {
      if (event.key !== "Home" && event.key !== "End") return;
      const options = menu.querySelectorAll("[role='option'], [data-command-item]");
      const option = event.key === "Home" ? options[0] : options[options.length - 1];
      option?.focus?.();
      event.preventDefault();
    };
    menu.addEventListener("keydown", onKeydown);
    state.listeners.push({ id: "slash-menu-improvements", target: menu, type: "keydown", listener: onKeydown });
    ownMount(state, "slash-menu-improvements", () => menu.removeAttribute("data-tweaker-slash-navigation"), menu);
  }
}

function applyMessageMetrics(state) {
  const matches = state.api?.react?.host?.query?.("assistant-turns") || [];
  for (const message of matches.map((match) => match.element)) {
    if (message.querySelector("[data-tweaker-message-metrics]")) continue;
    const words = countMessageWords(message);
    if (!words) continue;
    const metrics = document.createElement("span");
    metrics.setAttribute("data-tweaker-message-metrics", "true");
    metrics.className = "text-token-text-secondary text-xs";
    metrics.textContent = `${words} word${words === 1 ? "" : "s"}`;
    message.appendChild(metrics);
    ownMount(state, "message-metrics", () => metrics.remove(), metrics);
  }
}

// Count words from the message's own text, excluding the metrics badge this
// tweak injected, so the count reflects the actual message.
function countMessageWords(message) {
  const clone = message.cloneNode?.(true);
  if (!clone) {
    const raw = String(message.textContent || "").trim();
    return raw ? raw.split(/\s+/).length : 0;
  }
  for (const injected of clone.querySelectorAll?.("[data-tweaker-message-metrics]") || []) {
    injected.remove();
  }
  const text = String(clone.textContent || "").trim();
  return text ? text.split(/\s+/).length : 0;
}

function ownMount(state, id, remove, node) { state.mounts.push({ id, remove, node }); }

const STYLE_CSS = Object.freeze({
  "chat-multi-select": "[data-tweaker-message-selected] { outline: 2px solid var(--color-token-focus-border, #3b82f6); outline-offset: 2px; }",
  "sidebar-layout": "[data-tweaker-sidebar-layout] { min-width: var(--tweaker-sidebar-width, 18rem); } [data-tweaker-sidebar-layout][data-tweaker-sidebar-density='compact'] [data-app-action-sidebar-project-id] { padding-block: .25rem; }",
});

function installStyle(state, id) {
  const css = STYLE_CSS[id];
  if (!css) return; // most toggles need no CSS; don't inject empty <style> nodes
  if (state.styles.some((entry) => entry.id === id)) return; // idempotent
  const style = document.createElement("style");
  style.setAttribute("data-tweaker-ui-improvement-style", id);
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  state.styles.push({ id, node: style });
}

function cleanupToggle(state, id, options = {}) {
  if (!state || !id) return state;
  state.mounts = removeEntries(state.mounts, id, (entry) => entry?.remove?.());
  state.listeners = removeEntries(state.listeners, id, (entry) => {
    entry?.target?.removeEventListener?.(entry.type, entry.listener);
    entry?.dispose?.();
  });
  state.styles = removeEntries(state.styles, id, (entry) => entry?.node?.remove?.());
  if (!options.keepEnabled) state.enabled?.delete?.(id);
  return state;
}

function removeEntries(entries, id, dispose) {
  if (!Array.isArray(entries)) return entries;
  const keep = [];
  for (const entry of entries) {
    if (entryId(entry) === id) dispose(entry);
    else keep.push(entry);
  }
  return keep;
}

function entryId(entry) {
  if (typeof entry === "string") return entry;
  return String(entry?.id ?? entry?.toggleId ?? entry?.owner ?? entry?.[0] ?? "");
}

function renderSettings(root, state) {
  if (!root) return;
  root.replaceChildren();
  root.className = "flex flex-col gap-2";
  const status = document.createElement("div");
  status.className = "mb-2 rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const projects = state.api?.react?.host?.snapshot?.("projects")?.count || 0;
  const messages = state.api?.react?.host?.snapshot?.("assistant-turns")?.count || 0;
  status.textContent = `Live targets: ${projects} projects · ${messages} assistant turns.`;
  root.appendChild(status);
  const layout = document.createElement("div");
  layout.className = "mb-2 grid gap-3 rounded-lg border border-token-border p-3";
  const widthLabel = document.createElement("label");
  widthLabel.className = "flex items-center justify-between gap-4 text-sm text-token-text-primary";
  widthLabel.textContent = "Sidebar width";
  const width = document.createElement("input");
  width.type = "range"; width.min = "220"; width.max = "420"; width.step = "4"; width.value = String(state.layout.width);
  width.className = "accent-token-foreground";
  width.addEventListener("input", () => updateSidebarLayout(state, { width: Number(width.value) }));
  widthLabel.append(width);
  const densityLabel = document.createElement("label");
  densityLabel.className = widthLabel.className; densityLabel.textContent = "Sidebar density";
  const density = document.createElement("select");
  density.className = "rounded-md border border-token-border bg-token-main-surface-primary px-2 py-1 text-sm text-token-text-primary";
  for (const value of ["comfortable", "compact"]) { const option = document.createElement("option"); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); density.append(option); }
  density.value = state.layout.density;
  density.addEventListener("change", () => updateSidebarLayout(state, { density: density.value }));
  densityLabel.append(density); layout.append(widthLabel, densityLabel); root.append(layout);
  const controls = document.createElement("div");
  controls.className = "divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border border-token-border";
  for (const id of TOGGLE_IDS) {
    const row = document.createElement("label");
    row.className = "flex items-center justify-between gap-4 p-2";
    const text = document.createElement("span");
    text.className = "text-sm text-token-text-primary";
    text.textContent = id.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = state.enabled.has(id);
    input.addEventListener("change", () => setToggleEnabled(state, id, input.checked));
    row.append(text, input);
    controls.appendChild(row);
  }
  root.appendChild(controls);
}

function updateSidebarLayout(state, patch) {
  Object.assign(state.layout, patch);
  state.api?.storage?.set?.(LAYOUT_KEY, state.layout);
  for (const sidebar of document.querySelectorAll("[data-tweaker-sidebar-layout]")) {
    sidebar.style.setProperty("--tweaker-sidebar-width", `${state.layout.width}px`);
    sidebar.setAttribute("data-tweaker-sidebar-density", state.layout.density);
  }
}
