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
  applySidebarLayout,
  applyChatMultiSelect,
  applyMessageMetrics,
  sidebarChatRows,
  selectedSidebarChatRows,
  confirmAndCopySelectedSidebarChatTitles,
  updateSidebarLayout,
  startObserver,
  stopObserver,
  installStyle,
};

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const stored = api?.storage?.get?.(STORAGE_KEY, null);
    const enabled = normalizeToggleState(stored);
    const savedLayout = api?.storage?.get?.(LAYOUT_KEY, null);
    const state = {
      api,
      enabled,
      layout: {
        width: Math.min(420, Math.max(220, Number(savedLayout?.width) || 288)),
        density: ["compact", "comfortable"].includes(savedLayout?.density) ? savedLayout.density : "comfortable",
      },
      mounts: [],
      listeners: [],
      styles: [],
      settings: null,
      settingsRoot: null,
      disposed: false,
      observer: null,
      scanPending: null,
    };
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
    stopObserver(state);
    for (const id of TOGGLE_IDS) cleanupToggle(state, id, { keepEnabled: true });
    state.settings?.unregister?.();
    instances.delete(this);
  },

  _test: helpers,
  __test: helpers,
};

// One shared, rAF-debounced observer dispatches to every enabled behavior.
// It is disconnected when every improvement is off, so an idle tweak has no
// host-observation work to perform.
function startObserver(state) {
  if (state.disposed || state.observer || state.enabled.size === 0) return;
  const disposeHost = state.api?.react?.host?.observe?.(["projects", "assistant-turns", "composer", "command-menu", "settings-rows"], () => scheduleScanAll(state));
  state.observer = typeof disposeHost === "function" ? { disconnect: disposeHost } : null;
}

function stopObserver(state) {
  state?.observer?.disconnect?.();
  if (state) state.observer = null;
}

function stopObserverWhenIdle(state) {
  if (state?.enabled?.size === 0) stopObserver(state);
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
    startObserver(state);
  } else {
    cleanupToggle(state, id);
    stopObserverWhenIdle(state);
  }
  if (options.persist !== false) persistToggleState(state);
  if (state.settingsRoot?.isConnected !== false) renderSettings(state.settingsRoot, state);
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
  for (const row of sidebarChatRows()) {
    if (row.hasAttribute("data-tweaker-sidebar-chat-multiselect-ready")) continue;
    row.setAttribute("data-tweaker-sidebar-chat-multiselect-ready", "true");
    const onClick = (event) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation?.();
      row.toggleAttribute("data-tweaker-sidebar-chat-selected");
      removeSidebarChatSelectionToolbar(state);
    };
    const onContextMenu = (event) => {
      if (!row.hasAttribute("data-tweaker-sidebar-chat-selected")) return;
      event.preventDefault();
      event.stopPropagation?.();
      renderSidebarChatSelectionToolbar(state);
    };
    row.addEventListener("click", onClick);
    row.addEventListener("contextmenu", onContextMenu);
    state.listeners.push({ id: "chat-multi-select", target: row, type: "click", listener: onClick });
    state.listeners.push({ id: "chat-multi-select", target: row, type: "contextmenu", listener: onContextMenu });
    ownMount(state, "chat-multi-select", () => {
      row.removeAttribute("data-tweaker-sidebar-chat-multiselect-ready");
      row.removeAttribute("data-tweaker-sidebar-chat-selected");
    }, row);
  }
}

// Sidebar chats have stable native row markers, unlike assistant messages in
// the main transcript. Never infer chats from text or broad list-item scans.
function sidebarChatRows(doc = typeof document === "undefined" ? null : document) {
  const rows = new Set();
  const candidates = doc?.querySelectorAll?.("[data-app-action-sidebar-thread-id], [data-app-action-sidebar-thread-pinned='true']") || [];
  for (const candidate of candidates) {
    const row = closestSidebarChatRow(candidate);
    if (row) rows.add(row);
  }
  return [...rows];
}

function closestSidebarChatRow(candidate) {
  const row = candidate?.closest?.("[data-app-action-sidebar-thread-row], [role='listitem']") || candidate;
  const sidebar = row?.closest?.("aside, nav, [role='navigation']") || candidate?.closest?.("aside, nav, [role='navigation']");
  return sidebar ? row : null;
}

function selectedSidebarChatRows(doc = typeof document === "undefined" ? null : document) {
  return [...(doc?.querySelectorAll?.("[data-tweaker-sidebar-chat-selected]") || [])]
    .filter((row) => row.hasAttribute?.("data-tweaker-sidebar-chat-multiselect-ready"));
}

function renderSidebarChatSelectionToolbar(state) {
  removeSidebarChatSelectionToolbar(state);
  const selected = selectedSidebarChatRows();
  if (!selected.length) return;
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-tweaker-sidebar-chat-selection-toolbar", "true");
  toolbar.setAttribute("role", "toolbar");
  toolbar.className = "fixed bottom-6 left-1/2 z-[9999] flex -translate-x-1/2 gap-2 rounded-lg border border-token-border bg-token-main-surface-primary p-2 shadow-lg";
  const summary = document.createElement("span");
  summary.className = "self-center px-1 text-sm text-token-text-secondary";
  summary.textContent = `${selected.length} chat${selected.length === 1 ? "" : "s"} selected`;
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "rounded-md bg-token-foreground/5 px-3 py-1.5 text-sm text-token-text-primary"; copy.textContent = `Copy ${selected.length} title${selected.length === 1 ? "" : "s"}`;
  copy.addEventListener("click", () => { void confirmAndCopySelectedSidebarChatTitles(state); });
  const clear = document.createElement("button");
  clear.type = "button"; clear.className = copy.className; clear.textContent = "Clear";
  clear.addEventListener("click", () => { clearSelectedSidebarChatRows(state); });
  toolbar.append(summary, copy, clear); document.body.appendChild(toolbar);
  ownMount(state, "chat-multi-select", () => toolbar.remove(), toolbar);
}

function removeSidebarChatSelectionToolbar(state) {
  if (typeof document !== "undefined") document.querySelector?.("[data-tweaker-sidebar-chat-selection-toolbar]")?.remove?.();
  if (!Array.isArray(state?.mounts)) return;
  state.mounts = state.mounts.filter((entry) => {
    if (entry?.id !== "chat-multi-select" || entry?.node?.getAttribute?.("data-tweaker-sidebar-chat-selection-toolbar") !== "true") return true;
    entry.remove?.();
    return false;
  });
}

function clearSelectedSidebarChatRows(state, doc = typeof document === "undefined" ? null : document) {
  for (const row of selectedSidebarChatRows(doc)) row.removeAttribute("data-tweaker-sidebar-chat-selected");
  removeSidebarChatSelectionToolbar(state);
}

async function confirmAndCopySelectedSidebarChatTitles(state) {
  const titles = selectedSidebarChatRows().map((row) => String(row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240)).filter(Boolean);
  if (!titles.length) return false;
  const confirm = typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm.bind(window) : null;
  if (!confirm?.(`Copy the titles of ${titles.length} selected chat${titles.length === 1 ? "" : "s"} to the clipboard?`)) return false;
  try {
    const clipboard = typeof navigator === "undefined" ? null : navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(titles.join("\n"));
    removeSidebarChatSelectionToolbar(state);
    return true;
  } catch (error) {
    state?.api?.log?.warn?.("UI Improvements could not copy selected chat titles", String(error));
    return false;
  }
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
    let metrics = message.querySelector?.("[data-tweaker-message-metrics]") || null;
    const words = countMessageWords(message);
    if (!words) {
      metrics?.remove?.();
      continue;
    }
    if (!metrics) {
      metrics = document.createElement("span");
      metrics.setAttribute("data-tweaker-message-metrics", "true");
      metrics.className = "text-token-text-secondary text-xs";
      message.appendChild(metrics);
    }
    metrics.textContent = `${words} word${words === 1 ? "" : "s"}`;
    if (!state.mounts.some((entry) => entry.id === "message-metrics" && entry.node === metrics)) {
      ownMount(state, "message-metrics", () => metrics.remove(), metrics);
    }
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
  "chat-multi-select": "[data-tweaker-sidebar-chat-selected] { outline: 2px solid var(--color-token-focus-border); outline-offset: 2px; }",
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
  if (id === "chat-multi-select") removeSidebarChatSelectionToolbar(state);
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
  state.settingsRoot = root;
  root.replaceChildren();
  root.className = "flex flex-col gap-2";
  const status = document.createElement("div");
  status.className = "mb-2 rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
  const projects = state.api?.react?.host?.snapshot?.("projects")?.count || 0;
  const messages = state.api?.react?.host?.snapshot?.("assistant-turns")?.count || 0;
  const observerStatus = state.observer ? "Host observation is active." : "Host observation is idle while every improvement is off.";
  status.textContent = `Host snapshots: ${projects} project anchors · ${messages} assistant turns. Cmd/Ctrl-click native sidebar chat rows, then right-click a selected row to copy titles after confirmation. ${observerStatus}`;
  root.appendChild(status);
  const layout = document.createElement("div");
  layout.className = "mb-2 grid gap-3 rounded-lg border border-token-border p-3";
  const layoutEnabled = state.enabled.has("sidebar-layout");
  layout.toggleAttribute("data-tweaker-sidebar-layout-disabled", !layoutEnabled);
  const widthLabel = document.createElement("label");
  widthLabel.className = "flex items-center justify-between gap-4 text-sm text-token-text-primary";
  widthLabel.textContent = "Minimum sidebar width";
  const width = document.createElement("input");
  width.type = "range"; width.min = "220"; width.max = "420"; width.step = "4"; width.value = String(state.layout.width);
  width.className = "accent-token-foreground";
  width.disabled = !layoutEnabled;
  width.setAttribute("aria-label", "Minimum sidebar width");
  width.addEventListener("input", () => updateSidebarLayout(state, { width: Number(width.value) }));
  widthLabel.append(width);
  const densityLabel = document.createElement("label");
  densityLabel.className = widthLabel.className; densityLabel.textContent = "Sidebar density";
  const density = document.createElement("select");
  density.className = "rounded-md border border-token-border bg-token-main-surface-primary px-2 py-1 text-sm text-token-text-primary";
  for (const value of ["comfortable", "compact"]) { const option = document.createElement("option"); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); density.append(option); }
  density.value = state.layout.density;
  density.disabled = !layoutEnabled;
  density.setAttribute("aria-label", "Sidebar density");
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
  if (Number.isFinite(Number(patch?.width))) state.layout.width = Math.min(420, Math.max(220, Number(patch.width)));
  if (["compact", "comfortable"].includes(patch?.density)) state.layout.density = patch.density;
  state.api?.storage?.set?.(LAYOUT_KEY, state.layout);
  if (!state.enabled.has("sidebar-layout")) return false;
  const sidebars = typeof document === "undefined" ? [] : document.querySelectorAll("[data-tweaker-sidebar-layout]");
  for (const sidebar of sidebars) {
    sidebar.style.setProperty("--tweaker-sidebar-width", `${state.layout.width}px`);
    sidebar.setAttribute("data-tweaker-sidebar-density", state.layout.density);
  }
  return true;
}
