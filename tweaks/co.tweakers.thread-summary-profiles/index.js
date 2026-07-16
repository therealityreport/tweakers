"use strict";

const OWNER = "co.tweakers.thread-summary-profiles";
const STYLE_ID = "codexpp-thread-summary-profiles-style";
const MOUNT_ATTR = "data-codexpp-thread-summary-profiles";
const states = new WeakMap();

const helpers = { normalizeProfilesProjection, renderProfilesState, profileSignature, panelContextSignature, findSummaryPanels, resolveProjectContext, normalizeRow };

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    const state = { api, disposed: false, observer: null, pending: null, mounts: new Set(), listeners: [], style: installStyle(), page: null };
    states.set(this, state);
    const disposeHost = api.react?.host?.observe?.(["thread-context", "projects"], () => schedule(state));
    state.observer = disposeHost ? { disconnect: disposeHost } : null;
    const refresh = () => {
      for (const mount of state.mounts) mount.removeAttribute?.("data-profiles-context");
      schedule(state);
    };
    for (const type of ["popstate", "hashchange", "codexpp:projects-revision"]) {
      window.addEventListener?.(type, refresh);
      state.listeners.push(() => window.removeEventListener?.(type, refresh));
    }
    state.page = api.settings?.registerPage?.({
      id: "thread-summary-profiles",
      title: "Thread Summary Profiles",
      description: "Read-only connection profiles for the active thread project.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 3.5h12v13H4z" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h6M7 10h6M7 13h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render(root) { return renderProfilesPage(state, root); },
    });
    schedule(state);
  },

  stop() {
    const state = states.get(this);
    if (!state) return;
    state.disposed = true;
    if (state.pending != null) { cancelFrame(state.pending, state.pendingKind); state.pending = null; state.pendingKind = null; }
    state.observer?.disconnect();
    state.observer = null;
    for (const mount of Array.from(state.mounts)) {
      if (typeof mount.remove === "function") mount.remove();
    }
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
  let disposed = false;
  const draw = async () => {
    if (disposed) return;
    root.replaceChildren();
    const context = state.api?.react?.host?.getActiveProject?.() || null;
    const status = document.createElement("div");
    status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
    const placements = state.api?.react?.host?.snapshot?.("thread-context")?.count || 0;
    status.textContent = context
      ? `Active project: ${context.name || context.id || "Detected project"}. Context surfaces: ${placements}.`
      : `No active project context detected. Context surfaces: ${placements}.`;
    root.appendChild(status);
    if (!context?.id && !context?.workspacePath) {
      const empty = document.createElement("div");
      root.appendChild(empty);
      paint(empty, renderProfilesState({ state: "empty" }));
      return;
    }
    const view = document.createElement("div");
    root.appendChild(view);
    paint(view, renderProfilesState({ state: "loading" }));
    try {
      const response = await state.api.ipc.invoke("profiles.read", { action: "profiles.read", version: 1, project: { id: context.id, workspacePath: context.workspacePath } });
      if (disposed) return;
      if (!response?.ok) return paint(view, renderProfilesState({ state: "error", error: response?.error?.message || "Projects unavailable" }));
      const projection = normalizeProfilesProjection(response);
      paint(view, projection.rows.length ? { state: "ready", rows: projection.rows } : { state: "empty" });
    } catch (error) {
      if (!disposed) paint(view, renderProfilesState({ state: "error", error: error?.message || "Profiles unavailable" }));
    }
  };
  void draw();
  return () => { disposed = true; root.replaceChildren(); };
}

function normalizeRow(profile) {
  if (!isRecord(profile)) return null;
  // A profile with no real type/id is malformed — drop it rather than letting
  // safeIdentifier's "unknown-project" fallback render as a bogus row.
  const rawId = firstNonEmptyString(profile.type, profile.id);
  if (!rawId) return null;
  const id = safeIdentifier(rawId);
  if (id === "unknown-project" && rawId.trim().toLowerCase() !== "unknown-project") return null;
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) return null;
  const label = safeDisplay(profile.label || titleCase(id), titleCase(id));
  const value = safeDisplay(profile.value || profile.detail || "Configured", "Configured");
  const status = ["configured", "unconfigured", "error"].includes(profile.status) ? profile.status : "configured";
  return { id, label, status, value };
}

function normalizeConnection(id, connection) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/i.test(id)) return null;
  if (!isRecord(connection)) return { id, label: titleCase(id), status: "configured", value: "Configured" };
  const candidate = connection.account || connection.profile || connection.label || connection.value;
  return {
    id,
    label: titleCase(id),
    status: "configured",
    value: titleCase(safeDisplay(candidate, "Configured")),
  };
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
      mount.className = "codexpp-thread-summary-profiles flex flex-col gap-2 pt-3";
      panel.appendChild(mount);
      state.mounts.add(mount);
    }
    const context = panelContextSignature(panel);
    if (mount.getAttribute?.("data-profiles-context") !== context) {
      mount.setAttribute?.("data-profiles-context", context);
      paint(mount, renderProfilesState({ state: "loading" }));
      void loadProfiles(state, panel, mount, context);
    }
  }
  for (const mount of Array.from(state.mounts)) {
    if (!mount.isConnected) { if (typeof mount.remove === "function") mount.remove(); state.mounts.delete(mount); }
  }
}

async function loadProfiles(state, panel, mount, context = panelContextSignature(panel)) {
  const invoke = state.api?.ipc?.invoke;
  if (typeof invoke !== "function" || state.disposed) {
    paint(mount, renderProfilesState({ state: "empty" }));
    return;
  }
  try {
    const activeProject = state.api?.react?.host?.getActiveProject?.() || null;
    const projectContext = activeProject ? { projectId: activeProject.id || "", workspacePath: activeProject.workspacePath || "" } : resolveProjectContext(panel);
    const project = {
      id: projectContext.projectId || undefined,
      workspacePath: projectContext.workspacePath || undefined,
    };
    const response = await invoke.call(state.api.ipc, "profiles.read", { action: "profiles.read", version: 1, project });
    if (state.disposed || !mount.isConnected || mount.getAttribute?.("data-profiles-context") !== context) return;
    if (!response?.ok) { paint(mount, renderProfilesState({ state: "error", error: response?.error?.message || "Projects unavailable" })); return; }
    const projection = normalizeProfilesProjection(response);
    paint(mount, renderProfilesState(projection.rows.length ? { state: "ready", rows: projection.rows } : { state: "empty" }));
    mount.setAttribute("data-profiles-signature", profileSignature(projection));
  } catch (error) {
    if (!state.disposed && mount.isConnected) paint(mount, renderProfilesState({ state: "error", error: error?.message || "Profiles unavailable" }));
  }
}

// The project id / workspace path live on the workspace ROOT, not on the
// summary panel. Walk up from the panel (then fall back to a document-level
// lookup) so per-project scoping actually resolves instead of always sending an
// empty project.
function resolveProjectContext(panel) {
  return {
    projectId: resolveScopedAttr(panel, "data-project-id"),
    workspacePath: resolveScopedAttr(panel, "data-workspace-path"),
  };
}

function resolveScopedAttr(panel, name) {
  // Prefer the nearest ancestor-or-self carrying the attribute (real DOM), then
  // the panel's own attribute, then any host in the document.
  const host = panel?.closest?.(`[${name}]`)
    || (typeof panel?.getAttribute === "function" && panel.getAttribute(name) ? panel : null)
    || (typeof document !== "undefined" ? document.querySelector?.(`[${name}]`) : null);
  return host?.getAttribute?.(name) || "";
}

function panelContextSignature(panel) {
  const context = resolveProjectContext(panel);
  return JSON.stringify({
    projectId: context.projectId,
    workspacePath: context.workspacePath,
    route: typeof location !== "undefined" ? `${location.pathname}${location.search}${location.hash}` : "",
  });
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
  const matched = Array.from(root?.querySelectorAll?.("[data-thread-summary], [data-summary-panel], aside, section") || []).filter((panel) => {
    if (panel.hasAttribute?.(MOUNT_ATTR)) return false;
    const text = String(panel.textContent || "");
    const markers = ["Environment", "Sources", "Progress", "Subagents"].filter((marker) => text.includes(marker));
    return markers.length >= 2;
  });
  // The text heuristic matches nested `aside`/`section` pairs, so keep only the
  // innermost — drop any panel that contains another matched panel — to avoid
  // injecting duplicate Profiles mounts into a parent and its child.
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
  const cb = () => { state.pending = null; state.pendingKind = null; scan(state); };
  state.pending = useRaf ? window.requestAnimationFrame(cb) : (typeof setTimeout === "function" ? setTimeout(cb, 16) : null);
}
function cancelFrame(id, kind) {
  // Cancel with the API that actually scheduled it.
  if (kind === "raf") { if (typeof window !== "undefined") window.cancelAnimationFrame?.(id); return; }
  if (kind === "timeout") { if (typeof clearTimeout === "function") clearTimeout(id); return; }
  // Unknown kind (defensive): try both.
  if (typeof window !== "undefined") window.cancelAnimationFrame?.(id);
  if (typeof clearTimeout === "function") clearTimeout(id);
}
function firstNonEmptyString(...values) {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return null;
}
function safeIdentifier(value) { return typeof value === "string" && value.length <= 120 && !/[\\/\0\r\n]/.test(value) ? value : "unknown-project"; }
function safeDisplay(value, fallback) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /(?:token|secret|password|bearer|workspace|private|authorization|[\\/]Users[\\/])/i.test(value)) return fallback;
  return value.trim();
}
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
