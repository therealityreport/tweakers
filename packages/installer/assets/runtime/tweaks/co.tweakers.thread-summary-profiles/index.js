"use strict";

const OWNER = "co.tweakers.thread-summary-profiles";
const STYLE_ID = "tweaker-thread-summary-profiles-style";
const MOUNT_ATTR = "data-co-tweakers-thread-summary-profiles";
const GENERATION_ATTR = "data-profiles-generation";
const states = new WeakMap();

const helpers = {
  normalizeProfilesProjection,
  renderProfilesState,
  profileSignature,
  resolveProjectContext,
  resolveProjectIdentity,
  findSummaryPanels,
  normalizeRow,
  applyProjection,
  scan,
  getState: (instance) => states.get(instance),
};

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const state = {
      api,
      disposed: false,
      observer: null,
      pending: null,
      pendingKind: null,
      mounts: new Set(),
      mountState: new WeakMap(),
      nextGeneration: 0,
      listeners: [],
      style: installStyle(),
      page: null,
      pageRenders: new Set(),
    };
    states.set(this, state);
    const refresh = () => {
      for (const mount of state.mounts) {
        const record = state.mountState.get(mount);
        if (record) record.invalidated = true;
      }
      for (const page of state.pageRenders) page.refresh?.();
      schedule(state);
    };
    const disposeHost = api.react?.host?.observe?.(["thread-context", "projects"], refresh);
    state.observer = disposeHost ? { disconnect: disposeHost } : null;
    if (typeof window !== "undefined") {
      for (const type of ["popstate", "hashchange", "tweaker:projects-revision"]) {
        window.addEventListener?.(type, refresh);
        state.listeners.push(() => window.removeEventListener?.(type, refresh));
      }
    }
    state.page = api.settings?.registerPage?.({
      id: "thread-summary-profiles",
      title: "Thread Summary Profiles",
      description: "Read-only, sanitized connection profiles for the active thread project.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 3.5h12v13H4z" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h6M7 10h6M7 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render(root) { return renderProfilesPage(state, root); },
    });
    schedule(state);
  },

  stop() {
    const state = states.get(this);
    if (!state) return;
    state.disposed = true;
    if (state.pending != null) {
      cancelFrame(state.pending, state.pendingKind);
      state.pending = null;
      state.pendingKind = null;
    }
    state.observer?.disconnect();
    state.observer = null;
    for (const page of Array.from(state.pageRenders)) page.cleanup?.();
    state.pageRenders.clear();
    for (const mount of Array.from(state.mounts)) mount.remove?.();
    state.mounts.clear();
    for (const dispose of state.listeners.splice(0)) dispose();
    state.page?.unregister?.();
    state.style?.remove?.();
    states.delete(this);
  },

  _test: helpers,
  __test: helpers,
};

function normalizeProfilesProjection(response) {
  const revision = typeof response?.revision === "string"
    ? (response.revision ? response.revision.slice(0, 120) : "unknown")
    : (Number.isFinite(response?.revision) ? response.revision : "unknown");
  const project = isRecord(response?.project) ? response.project : {};
  const projectId = safeIdentifier(project.id || response?.projectId || "unknown-project");
  const rows = [];
  if (Array.isArray(response?.profiles)) {
    for (const profile of response.profiles) {
      const row = normalizeRow(profile);
      if (row) rows.push(row);
    }
  } else if (isRecord(project.connections)) {
    for (const [id, connection] of Object.entries(project.connections)) {
      const row = normalizeConnection(id, connection);
      if (row) rows.push(row);
    }
  }
  return { revision, projectId, rows: rows.slice(0, 7) };
}

function renderProfilesPage(state, root) {
  const page = {
    disposed: false,
    generation: 0,
    identity: null,
    identityKey: "",
    root,
  };
  state.pageRenders.add(page);
  const draw = async () => {
    if (page.disposed || state.disposed) return;
    const identity = resolveProjectIdentity(state.api, null);
    const identityKey = privateIdentityKey(identity);
    const generation = ++state.nextGeneration;
    page.generation = generation;
    page.identity = identity;
    page.identityKey = identityKey;
    root.replaceChildren();
    const hostContext = state.api?.react?.host?.getActiveProject?.() || null;
    const status = document.createElement("div");
    status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
    const placements = state.api?.react?.host?.snapshot?.("thread-context")?.count || 0;
    const friendlyName = safeFriendlyName(hostContext?.name);
    status.textContent = identity
      ? `${friendlyName ? `Active project: ${friendlyName}. ` : "An active project context is available. "}Context surfaces: ${placements}.`
      : `No validated active project context detected. Context surfaces: ${placements}.`;
    root.appendChild(status);
    if (!identity) {
      const empty = document.createElement("div");
      root.appendChild(empty);
      paint(empty, renderProfilesState({ state: "empty" }));
      return;
    }
    const view = document.createElement("div");
    root.appendChild(view);
    paint(view, renderProfilesState({ state: "loading" }));
    try {
      const response = await state.api.ipc.invoke("profiles.read", { action: "profiles.read", version: 1, project: requestProject(identity) });
      if (!isCurrentPageLoad(state, page, generation, identityKey)) return;
      if (!response?.ok) return paint(view, renderProfilesState({ state: "error", error: response?.error?.message || "Projects unavailable" }));
      const projection = normalizeProfilesProjection(response);
      paint(view, renderProfilesState(projection.rows.length ? { state: "ready", rows: projection.rows } : { state: "empty" }));
    } catch (error) {
      if (isCurrentPageLoad(state, page, generation, identityKey)) {
        paint(view, renderProfilesState({ state: "error", error: error?.message || "Profiles unavailable" }));
      }
    }
  };
  page.refresh = () => { if (!page.disposed) void draw(); };
  page.cleanup = () => {
    if (page.disposed) return;
    page.disposed = true;
    page.generation = ++state.nextGeneration;
    page.identity = null;
    page.identityKey = "";
    state.pageRenders.delete(page);
    root.replaceChildren();
  };
  void draw();
  return page.cleanup;
}

function normalizeRow(profile) {
  if (!isRecord(profile)) return null;
  const rawId = firstNonEmptyString(profile.type, profile.id);
  if (!rawId) return null;
  const id = safeIdentifier(rawId);
  if (id === "unknown-project" && rawId.trim().toLowerCase() !== "unknown-project") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) return null;
  // The Projects provider owns the friendly account label. This renderer only
  // displays the safe, bounded projection and never looks up raw references.
  const label = safeDisplay(profile.label || titleCase(id), titleCase(id));
  const value = safeDisplay(profile.value || profile.detail || "Configured", "Configured");
  const status = ["configured", "unconfigured", "error"].includes(profile.status) ? profile.status : "configured";
  return { id, label, status, value };
}

function normalizeConnection(id, connection) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) return null;
  if (!isRecord(connection)) return { id, label: titleCase(id), status: "configured", value: "Configured" };
  const candidate = connection.account || connection.profile || connection.label || connection.value;
  return { id, label: titleCase(id), status: "configured", value: titleCase(safeDisplay(candidate, "Configured")) };
}

function renderProfilesState(state) {
  const current = state?.state || "loading";
  if (current === "loading") return { state: current, text: "Loading profiles…", hidden: false, rows: [] };
  if (current === "empty") return { state: current, text: "No profiles configured for this project.", hidden: false, rows: [] };
  if (current === "error") return { state: current, text: String(state?.error || "Profiles unavailable."), hidden: false, rows: [] };
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  return {
    state: "ready",
    text: rows.length ? rows.map((row) => `${row.label}: ${row.value}`).join("\n") : "No profiles configured for this project.",
    hidden: false,
    rows,
  };
}

function profileSignature(projection) {
  return JSON.stringify({
    revision: String(projection?.revision || ""),
    projectId: String(projection?.projectId || ""),
    rows: (Array.isArray(projection?.rows) ? projection.rows : []).map((row) => ({
      id: row?.id, label: row?.label, status: row?.status, value: row?.value,
    })),
  });
}

function scan(state) {
  if (state.disposed) return;
  const panels = findSummaryPanels(document);
  for (const panel of panels) {
    let mount = panel.querySelector?.(`[${MOUNT_ATTR}]`);
    if (!mount) {
      mount = document.createElement("section");
      mount.setAttribute(MOUNT_ATTR, OWNER);
      mount.className = "tweaker-thread-summary-profiles flex flex-col gap-2 pt-3";
      panel.appendChild(mount);
      state.mounts.add(mount);
    }
    const identity = resolveProjectIdentity(state.api, panel);
    let record = state.mountState.get(mount);
    const nextKey = privateIdentityKey(identity);
    if (!record || record.identityKey !== nextKey || record.invalidated) {
      const identityChanged = !record || record.identityKey !== nextKey;
      record = record || { generation: 0, identityKey: null, identity: null, profileSignature: null, invalidated: false };
      record.identityKey = nextKey;
      record.identity = identity; // private per-mount memory; never serialized into the DOM.
      record.invalidated = false;
      if (identityChanged) record.profileSignature = null;
      record.generation = ++state.nextGeneration;
      state.mountState.set(mount, record);
      mount.setAttribute(GENERATION_ATTR, String(record.generation));
      if (!identity) {
        paint(mount, renderProfilesState({ state: "empty" }));
        continue;
      }
      if (!record.profileSignature) paint(mount, renderProfilesState({ state: "loading" }));
      void loadProfiles(state, mount, record, record.generation);
    }
  }
  for (const mount of Array.from(state.mounts)) {
    if (!mount.isConnected) {
      mount.remove?.();
      state.mounts.delete(mount);
    }
  }
}

async function loadProfiles(state, mount, record, generation) {
  const invoke = state.api?.ipc?.invoke;
  if (typeof invoke !== "function" || state.disposed || !record.identity) {
    if (isCurrentLoad(state, mount, record, generation)) paint(mount, renderProfilesState({ state: "empty" }));
    return;
  }
  try {
    const response = await invoke.call(state.api.ipc, "profiles.read", { action: "profiles.read", version: 1, project: requestProject(record.identity) });
    if (!isCurrentLoad(state, mount, record, generation)) return;
    if (!response?.ok) {
      paint(mount, renderProfilesState({ state: "error", error: response?.error?.message || "Projects unavailable" }));
      return;
    }
    applyProjection(record, mount, normalizeProfilesProjection(response));
  } catch (error) {
    if (isCurrentLoad(state, mount, record, generation)) {
      paint(mount, renderProfilesState({ state: "error", error: error?.message || "Profiles unavailable" }));
    }
  }
}

function applyProjection(record, mount, projection) {
  const nextSignature = profileSignature(projection);
  if (record.profileSignature === nextSignature) return false;
  record.profileSignature = nextSignature;
  paint(mount, renderProfilesState(projection.rows.length ? { state: "ready", rows: projection.rows } : { state: "empty" }));
  return true;
}

function isCurrentLoad(state, mount, record, generation) {
  return !state.disposed
    && mount?.isConnected !== false
    && state.mountState.get(mount) === record
    && record.generation === generation;
}

function isCurrentPageLoad(state, page, generation, identityKey) {
  if (state.disposed || page.disposed || page.generation !== generation || page.identityKey !== identityKey) return false;
  return privateIdentityKey(resolveProjectIdentity(state.api, null)) === identityKey;
}

// A host context is usable only when it supplies an ID or workspace path. A
// name alone is presentation data, not project identity, so it falls back to
// the panel's nearest project context instead of issuing a broad stale read.
function resolveProjectIdentity(api, panel) {
  const hostIdentity = validateProjectContext(api?.react?.host?.getActiveProject?.());
  const panelIdentity = validateProjectContext(resolveProjectContext(panel));
  const project = hostIdentity || panelIdentity;
  if (!project) return null;
  return { ...project, route: privateRoute() };
}

function validateProjectContext(context) {
  const id = normalizeProjectId(context?.id || context?.projectId);
  const workspacePath = normalizeWorkspacePath(context?.workspacePath);
  return id || workspacePath ? { id, workspacePath } : null;
}

function resolveProjectContext(panel) {
  const host = panel?.closest?.("[data-project-id], [data-workspace-path]")
    || (panel?.getAttribute?.("data-project-id") || panel?.getAttribute?.("data-workspace-path") ? panel : null);
  return {
    projectId: host?.getAttribute?.("data-project-id") || "",
    workspacePath: host?.getAttribute?.("data-workspace-path") || "",
  };
}

function requestProject(identity) {
  return { id: identity.id || undefined, workspacePath: identity.workspacePath || undefined };
}

function privateIdentityKey(identity) {
  return identity ? JSON.stringify([identity.id, identity.workspacePath, identity.route]) : "";
}

function privateRoute() {
  if (typeof location === "undefined") return "";
  const route = `${location.pathname || ""}${location.search || ""}${location.hash || ""}`;
  return route.length <= 2048 && !/[\0\r\n]/.test(route) ? route : "";
}

function paint(mount, view) {
  mount.textContent = "";
  const heading = document.createElement("div");
  heading.className = "text-sm font-medium text-token-text-secondary";
  heading.textContent = "Profiles";
  mount.appendChild(heading);
  if (view.state === "ready") {
    for (const row of view.rows || []) {
      const item = document.createElement("div");
      item.className = "flex items-center justify-between gap-3 text-sm";
      const label = document.createElement("span"); label.className = "text-token-text-primary"; label.textContent = row.label;
      const value = document.createElement("span"); value.className = "text-token-text-secondary"; value.textContent = row.value;
      item.append(label, value); mount.appendChild(item);
    }
  } else {
    const message = document.createElement("div");
    message.className = "text-sm text-token-text-secondary";
    message.textContent = view.text;
    mount.appendChild(message);
  }
}

function findSummaryPanels(root) {
  const matched = Array.from(root?.querySelectorAll?.("[data-thread-summary], [data-summary-panel]") || []).filter((panel) => {
    if (panel.hasAttribute?.(MOUNT_ATTR)) return false;
    const text = String(panel.textContent || "");
    const markers = ["Environment", "Sources", "Progress", "Subagents"].filter((marker) => text.includes(marker));
    return markers.length >= 2;
  });
  return matched.filter((panel) => !matched.some((other) => other !== panel && panel.contains?.(other)));
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
  const useRaf = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function";
  state.pendingKind = useRaf ? "raf" : "timeout";
  const callback = () => { state.pending = null; state.pendingKind = null; scan(state); };
  state.pending = useRaf ? window.requestAnimationFrame(callback) : (typeof setTimeout === "function" ? setTimeout(callback, 16) : null);
}

function cancelFrame(id, kind) {
  if (kind === "raf") { if (typeof window !== "undefined") window.cancelAnimationFrame?.(id); return; }
  if (kind === "timeout") { if (typeof clearTimeout === "function") clearTimeout(id); return; }
  if (typeof window !== "undefined") window.cancelAnimationFrame?.(id);
  if (typeof clearTimeout === "function") clearTimeout(id);
}

function firstNonEmptyString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return null;
}
function normalizeProjectId(value) { return typeof value === "string" && value.trim().length <= 120 && !/[\\/\0\r\n]/.test(value) ? value.trim() : ""; }
function normalizeWorkspacePath(value) { return typeof value === "string" && value.trim().length <= 4096 && !/[\0\r\n]/.test(value) ? value.trim() : ""; }
function safeIdentifier(value) { return typeof value === "string" && value.length <= 120 && !/[\\/\0\r\n]/.test(value) ? value : "unknown-project"; }
function safeDisplay(value, fallback) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /(?:token|secret|password|bearer|workspace|private|authorization|[\\/]Users[\\/])/i.test(value)) return fallback;
  return value.trim();
}
function safeFriendlyName(value) { const safe = safeDisplay(value, ""); return safe || null; }
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
