"use strict";

const IPC = "projects";
const SERVICE_KEY = "__tweakersProjectsServiceV1";
const HANDLER_KEY = "__tweakersProjectsHandlerV1";
const CONNECTION_TYPES = ["github", "modal", "google", "chrome", "google-workspace", "supabase", "environment"];
const PROFILE_CONNECTION_TYPES = Object.freeze([
  "github",
  "modal",
  "google",
  "chrome",
  "google-workspace",
  "supabase",
  "environment",
]);
const PROFILE_API_VERSION = 1;
const MAX_NODES = 200;
const MAX_DEPTH = 8;
const PROJECT_COLOR_MENU_ATTR = "data-codexpp-project-color-menu";
const PROJECT_COLOR_STYLE_ID = "codexpp-project-colors";
const PROJECT_COLOR_DISPOSE = Symbol("projectColorDispose");
const PROJECT_COLOR_OPTIONS = Object.freeze([
  { id: "neutral", label: "Neutral", value: "#404040" },
  { id: "stone", label: "Stone", value: "#44403c" },
  { id: "zinc", label: "Zinc", value: "#3f3f46" },
  { id: "slate", label: "Slate", value: "#334155" },
  { id: "gray", label: "Gray", value: "#374151" },
  { id: "mauve", label: "Mauve", value: "#524959" },
  { id: "olive", label: "Olive", value: "#435147" },
  { id: "mist", label: "Mist", value: "#3d5155" },
  { id: "taupe", label: "Taupe", value: "#554b3e" },
  { id: "red", label: "Red", value: "#b91c1c" },
  { id: "orange", label: "Orange", value: "#c2410c" },
  { id: "amber", label: "Amber", value: "#b45309" },
  { id: "yellow", label: "Yellow", value: "#a16207" },
  { id: "lime", label: "Lime", value: "#4d7c0f" },
  { id: "green", label: "Green", value: "#15803d" },
  { id: "emerald", label: "Emerald", value: "#047857" },
  { id: "teal", label: "Teal", value: "#0f766e" },
  { id: "cyan", label: "Cyan", value: "#0e7490" },
  { id: "sky", label: "Sky", value: "#0369a1" },
  { id: "blue", label: "Blue", value: "#1d4ed8" },
  { id: "indigo", label: "Indigo", value: "#4338ca" },
  { id: "violet", label: "Violet", value: "#6d28d9" },
  { id: "purple", label: "Purple", value: "#7e22ce" },
  { id: "fuchsia", label: "Fuchsia", value: "#a21caf" },
  { id: "pink", label: "Pink", value: "#be185d" },
  { id: "rose", label: "Rose", value: "#be123c" },
]);
const PROJECT_OVERLAY_OPTIONS = Object.freeze(["off", "subtle", "medium", "strong"]);
const LEGACY_COLOR_KEYS = Object.freeze({ colors: "sidebar-project-backgrounds:colors", overlays: "sidebar-project-backgrounds:overlays" });

module.exports = {
  start(api) {
    if (api.process === "main") return startMain(api);
    return startRenderer(api);
  },
  stop() {
    if (typeof window === "undefined") {
      const service = globalThis[SERVICE_KEY];
      service?.dispose?.();
      if (globalThis[SERVICE_KEY] === service) globalThis[SERVICE_KEY] = null;
      const unregister = globalThis[HANDLER_KEY];
      if (typeof unregister === "function") { try { unregister(); } catch {} }
      globalThis[HANDLER_KEY] = null;
    }
    this._page?.unregister?.();
    this._page = null;
  },
  _test: {
    normalizeState,
    normalizeIcon,
    normalizeGitHubArgs,
    mergeLegacyAssignments,
    redact,
    normalizeWorkspacePath,
    revisionForState,
    readProfilesProjection,
    safeReference,
    normalizeChromeProfileReference,
    chromeProfileDisplayName,
    updateChromeProfileAssignment,
    createService,
    adapterProbePaths,
    titleCase,
    readFollowupPolicy,
    parseFollowupMarker,
    normalizeColor,
    projectColorForeground,
    normalizeOverlayIntensity,
    mergeLegacyProjectColors,
    injectProjectColorMenu,
    openProjectColorSubmenu,
    applyNativeProjectColors,
    removeProjectColorArtifacts,
    resolveProjectContext,
    findNativeProjectMenu,
  },
};

function startMain(api) {
  const service = createService(api);
  globalThis[SERVICE_KEY] = service;
  if (!globalThis[HANDLER_KEY]) {
    const unregister = api.ipc.handle?.(IPC, (message) => {
      const active = globalThis[SERVICE_KEY];
      if (!active) return safeFailure("unavailable");
      return active.handle(message);
    });
    globalThis[HANDLER_KEY] = typeof unregister === "function" ? unregister : true;
  }
  api.log.info("Projects service ready");
}

function createService(api) {
  const store = createSecureProjectStore(api.fs.dataDir);
  const loaded = store.read();
  const legacyMigration = createLegacyProjectColorMigration(api.fs.dataDir);
  const legacyColors = legacyMigration.isComplete() ? { found: false, preferences: {} } : readLegacyProjectColorPreferences(api.fs.dataDir);
  const imported = mergeLegacyProjectColors(loaded.state, legacyColors.preferences);
  const state = imported.state;
  if (imported.changed) store.write(state);
  if (legacyColors.found && state.nodes.some((node) => node.type === "project")) legacyMigration.complete();
  let storageStatus = loaded.status;
  const githubRefs = new Map();
  let disposed = false;
  let connectionsCache = null;
  let connectionsCacheAt = 0;
  const CONNECTIONS_TTL_MS = 30_000;

  // Detecting connections shells out to `gh` (network) and stats config files.
  // Cache the result briefly so opening/refreshing the Projects page does not
  // re-run a blocking probe on every `get`.
  async function getConnections(now, force) {
    if (!force && connectionsCache && now - connectionsCacheAt < CONNECTIONS_TTL_MS) return connectionsCache;
    connectionsCache = await detectConnections(githubRefs);
    connectionsCacheAt = now;
    return connectionsCache;
  }

  return {
    async handle(message) {
      if (disposed) return safeFailure("unavailable");
      try {
        switch (message?.action) {
          case "get": {
            // Re-normalize at the output boundary. If in-memory state is ever
            // corrupted, fail closed instead of reflecting raw connection data.
            const publicState = normalizeState(state);
            return {
              ok: true,
              state: clone(publicState),
              revision: revisionForState(publicState),
              storageStatus,
              connections: await getConnections(Date.now(), message?.refreshConnections === true),
            };
          }
          case "save": {
            const next = normalizeState(message.state);
            // Optimistic concurrency: reject a save built on a stale snapshot so
            // two windows can't silently clobber each other's edits.
            if (message.baseRevision !== undefined && message.baseRevision !== null && message.baseRevision !== revisionForState(state)) {
              return safeFailure("stale-revision");
            }
            store.write(next);
            replaceObject(state, next);
            storageStatus = "ok";
            const revision = revisionForState(state);
            api.ipc.send("revision", { revision });
            return { ok: true, state: clone(state), revision };
          }
          case "profiles.read":
            return readProfilesProjection(state, message);
          case "followup.policy.read":
            return readFollowupPolicyProjection(state, message);
          case "github.run":
            return runGitHubForProject(state, githubRefs, message.projectId, message.argv);
          case "migrate-legacy": {
            const next = mergeLegacyAssignments(state, message.legacy);
            store.write(next);
            replaceObject(state, next);
            storageStatus = "ok";
            const revision = revisionForState(state);
            api.ipc.send("revision", { revision });
            return { ok: true, state: clone(state), revision };
          }
          default:
            return safeFailure("invalid-request");
        }
      } catch (error) {
        return safeFailure(errorCode(error));
      }
    },
    getProjectProfiles(projectId) {
      const project = state.nodes.find((node) => node.type === "project" && node.id === projectId);
      return project ? clone(project.connections) : null;
    },
    runGitHub(projectId, argv) {
      return runGitHubForProject(state, githubRefs, projectId, argv);
    },
    dispose() {
      disposed = true;
      githubRefs.clear();
    },
  };
}

function readLegacyProjectColorPreferences(dataDir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(dataDir, "..", "..");
  const candidates = [
    path.join(root, "storage", "co.bennett.ui-improvements.json"),
    path.join(root, "storage", "ui-improvements.json"),
    path.join(root, "storage", "co.tweakers.ui-improvements.json"),
  ];
  for (const file of candidates) {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isRecord(value)) return { found: true, preferences: value };
    } catch {}
  }
  return { found: false, preferences: {} };
}

function createLegacyProjectColorMigration(dataDir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const marker = path.join(dataDir, ".legacy-project-colors-imported-v1");
  return {
    isComplete() {
      try {
        const stat = fs.lstatSync(marker);
        return stat.isFile() && !stat.isSymbolicLink();
      } catch { return false; }
    },
    complete() {
      try { fs.writeFileSync(marker, "imported\n", { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) { if (error?.code !== "EEXIST") throw error; }
    },
  };
}

function defaultState() {
  return { schemaVersion: 1, nodes: [] };
}

function createSecureProjectStore(dataDir) {
  const fs = require("node:fs");
  const path = require("node:path");
  const file = path.join(dataDir, "projects-v1.json");
  const lkg = path.join(dataDir, "projects-v1.lkg.json");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  return {
    read() {
      if (!fs.existsSync(file)) return { state: defaultState(), status: "empty" };
      try { return { state: normalizeState(readSecureJson(fs, file)), status: "ok" }; }
      catch {
        try { return { state: normalizeState(readSecureJson(fs, lkg)), status: "corrupt-using-last-known-good" }; }
        catch { return { state: defaultState(), status: "corrupt" }; }
      }
    },
    write(state) {
      const bytes = Buffer.from(JSON.stringify(normalizeState(state), null, 2));
      if (fs.existsSync(file)) atomicWrite(fs, dataDir, lkg, fs.readFileSync(file));
      atomicWrite(fs, dataDir, file, bytes);
    },
  };
}

function readSecureJson(fs, file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 512 * 1024) throw coded("invalid-storage");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function atomicWrite(fs, dir, target, bytes) {
  const { randomBytes } = require("node:crypto");
  const tmp = `${target}.tmp-${randomBytes(8).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function normalizeState(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.nodes)) throw coded("invalid-state");
  if (value.nodes.length > MAX_NODES) throw coded("state-too-large");
  const ids = new Set();
  const nodes = value.nodes.map((node) => normalizeNode(node, ids));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.parentId !== null) {
      const parent = byId.get(node.parentId);
      if (!parent || parent.type !== "group") throw coded("invalid-parent");
    }
    let depth = 0;
    let cursor = node;
    const seen = new Set([node.id]);
    while (cursor.parentId !== null) {
      if (seen.has(cursor.parentId)) throw coded("cyclic-parent");
      seen.add(cursor.parentId);
      cursor = byId.get(cursor.parentId);
      if (!cursor || ++depth > MAX_DEPTH) throw coded("invalid-depth");
    }
  }
  return { schemaVersion: 1, nodes };
}

function normalizeNode(node, ids) {
  if (!isRecord(node) || (node.type !== "group" && node.type !== "project")) throw coded("invalid-node");
  const id = safeId(node.id);
  if (ids.has(id)) throw coded("duplicate-id");
  ids.add(id);
  const hasExplicitColor = node.color !== undefined && node.color !== null && node.color !== "";
  const colorMode = node.type === "project" ? normalizeColorMode(node.colorMode, hasExplicitColor) : "manual";
  const autoIdentity = node.projectPath || id;
  const out = {
    id,
    type: node.type,
    parentId: node.parentId === null || node.parentId === undefined ? null : safeId(node.parentId),
    name: safeText(node.name, 80),
    icon: normalizeIcon(node.icon),
    color: colorMode === "auto" ? autoColor(autoIdentity) : normalizeColor(node.color),
    connections: {},
  };
  if (node.type === "project") {
    out.colorMode = colorMode;
    out.overlayIntensity = normalizeOverlayIntensity(node.overlayIntensity);
    if (node.projectPath !== undefined && node.projectPath !== null && node.projectPath !== "") {
      out.projectPath = normalizeWorkspacePath(node.projectPath);
    }
    if (!isRecord(node.connections)) throw coded("invalid-connections");
    if (node.githubRepo !== undefined && node.githubRepo !== null && node.githubRepo !== "") {
      if (typeof node.githubRepo !== "string" || !/^[a-zA-Z0-9._-]{1,80}\/[a-zA-Z0-9._-]{1,100}$/.test(node.githubRepo)) throw coded("invalid-github-repo");
      out.githubRepo = node.githubRepo;
    }
    for (const type of CONNECTION_TYPES) {
      const ref = node.connections[type];
      if (ref !== undefined && ref !== null && ref !== "") out.connections[type] = safeReference(type, ref);
    }
  }
  return out;
}

/**
 * Normalize the one piece of runtime identity Projects owns for consumers:
 * an exact workspace path. The path is used only to resolve a project node;
 * it is never included in the profile display projection.
 */
function normalizeWorkspacePath(value) {
  const path = require("node:path");
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw coded("invalid-workspace-path");
  }
  if (!path.isAbsolute(value)) throw coded("invalid-workspace-path");
  const normalized = path.normalize(value);
  if (normalized === "/" || normalized.length > 4096) return normalized;
  return normalized.replace(/[\\/]$/, "") || "/";
}

function revisionForState(state) {
  const { createHash } = require("node:crypto");
  // The normalized state has no secrets. A content revision lets a renderer
  // invalidate a summary without owning or observing assignment writes.
  return createHash("sha256").update(JSON.stringify(normalizeState(state))).digest("hex").slice(0, 32);
}

function readProfilesProjection(state, message = {}) {
  if (!isRecord(message) || message.action !== "profiles.read" || message.version !== PROFILE_API_VERSION) {
    return safeFailure("invalid-request");
  }
  const requestProject = isRecord(message.project) ? message.project : null;
  if (!requestProject) return safeFailure("invalid-request");

  let requestedId = null;
  if (requestProject.id !== undefined && requestProject.id !== null && requestProject.id !== "") {
    try { requestedId = safeId(requestProject.id); } catch { return safeFailure("invalid-project"); }
  }
  let requestedPath = null;
  if (requestProject.workspacePath !== undefined && requestProject.workspacePath !== null && requestProject.workspacePath !== "") {
    try { requestedPath = normalizeWorkspacePath(requestProject.workspacePath); } catch { return safeFailure("invalid-workspace-path"); }
  }
  if (!requestedId && !requestedPath) return safeFailure("invalid-project");

  const project = state.nodes.find((node) => {
    if (node.type !== "project") return false;
    if (requestedId && node.id !== requestedId) return false;
    return !requestedPath || node.projectPath === requestedPath;
  });
  if (!project) return safeFailure("unknown-project");

  const profiles = [];
  try {
    for (const type of PROFILE_CONNECTION_TYPES) {
      if (typeof project.connections?.[type] !== "string") continue;
      const value = safeReference(type, project.connections[type]);
      profiles.push({
        type,
        label: profileLabel(type),
        status: "configured",
        value,
        ...(type === "chrome" ? { displayValue: chromeProfileDisplayName(value) } : {}),
      });
    }
  } catch {
    return safeFailure("invalid-state");
  }

  return {
    ok: true,
    version: PROFILE_API_VERSION,
    revision: revisionForState(state),
    project: { id: project.id, name: project.name },
    profiles,
  };
}

function readFollowupPolicyProjection(state, message = {}) {
  if (!isRecord(message) || message.action !== "get" || !isRecord(message.project)) return safeFailure("invalid-request");
  let workspacePath;
  try { workspacePath = normalizeWorkspacePath(message.project.workspacePath); } catch { return safeFailure("invalid-workspace-path"); }
  const project = state.nodes.find((node) => node.type === "project" && node.projectPath === workspacePath
    && (message.project.id === undefined || node.id === message.project.id));
  if (!project) return safeFailure("unknown-project");
  return readFollowupPolicy(project.projectPath);
}

function readFollowupPolicy(workspacePath, options = {}) {
  const fs = options.fs || require("node:fs");
  const path = options.path || require("node:path");
  const maxFiles = options.maxFiles || 8;
  const maxBytes = options.maxBytes || 64 * 1024;
  try {
    const workspace = path.resolve(normalizeWorkspacePath(workspacePath));
    if (fs.realpathSync(workspace) !== workspace) return safeFailure("untrusted-workspace");
    const dirs = [];
    for (let cursor = workspace; ; cursor = path.dirname(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return safeFailure("untrusted-workspace");
      dirs.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      if (dirs.length > maxFiles) return safeFailure("policy-hierarchy-too-deep");
    }
    let policy = { schemaVersion: 1, enabled: true, exactItems: 5, exception: null };
    let count = 0;
    for (const dir of dirs.reverse()) {
      const file = path.join(dir, "AGENTS.md");
      if (!fs.existsSync(file)) continue;
      if (++count > maxFiles) return safeFailure("policy-file-limit");
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) return safeFailure("invalid-policy-file");
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let text;
      try { text = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
      const marker = parseFollowupMarker(text);
      if (marker === "disabled") policy = { schemaVersion: 1, enabled: false, exactItems: 5, exception: "disabled-by-applicable-agents" };
      if (marker === "exact-five") policy = { schemaVersion: 1, enabled: true, exactItems: 5, exception: null };
    }
    return policy;
  } catch { return safeFailure("policy-unavailable"); }
}

function parseFollowupMarker(text) {
  if (typeof text !== "string") return null;
  const matches = [...text.matchAll(/^<!--\s*codex-follow-up:\s*(exact-five|disabled)\s*-->\s*$/gmi)];
  return matches.length ? matches[matches.length - 1][1].toLowerCase() : null;
}

function profileLabel(type) {
  const labels = {
    github: "GitHub",
    modal: "Modal",
    google: "Google",
    chrome: "Chrome",
    "google-workspace": "Google Workspace",
    supabase: "Supabase",
    environment: "Environment",
  };
  return labels[type] || titleCase(type);
}

function normalizeIcon(icon) {
  if (!isRecord(icon)) return { kind: "emoji", value: "📁" };
  if (icon.kind === "emoji" && typeof icon.value === "string" && /^\p{Extended_Pictographic}(?:\uFE0F)?$/u.test(icon.value)) {
    return { kind: "emoji", value: icon.value };
  }
  if (icon.kind === "iconify" && typeof icon.value === "string" && /^[a-z0-9-]{1,40}:[a-z0-9-]{1,80}$/.test(icon.value)) {
    return { kind: "iconify", value: icon.value };
  }
  throw coded("invalid-icon");
}

function normalizeColor(value) {
  if (value === undefined || value === null || value === "") return "#6b7280";
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw coded("invalid-color");
  return value.toLowerCase();
}

function normalizeColorMode(value, hasExplicitColor = false) {
  if (value === "auto" || value === "manual") return value;
  return hasExplicitColor ? "manual" : "auto";
}

function normalizeOverlayIntensity(value) {
  const normalized = value === undefined || value === null || value === "" ? "medium" : String(value).toLowerCase();
  if (!PROJECT_OVERLAY_OPTIONS.includes(normalized)) throw coded("invalid-overlay-intensity");
  return normalized;
}

function autoColor(identity) {
  let hash = 2166136261;
  for (const char of String(identity || "project")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return PROJECT_COLOR_OPTIONS[(hash >>> 0) % PROJECT_COLOR_OPTIONS.length].value;
}

function projectColorKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function mergeLegacyProjectColors(state, legacy) {
  const normalized = normalizeState(state);
  const colors = isRecord(legacy?.[LEGACY_COLOR_KEYS.colors]) ? legacy[LEGACY_COLOR_KEYS.colors] : {};
  const overlays = isRecord(legacy?.[LEGACY_COLOR_KEYS.overlays]) ? legacy[LEGACY_COLOR_KEYS.overlays] : {};
  let changed = false;
  const nodes = normalized.nodes.map((node) => {
    if (node.type !== "project") return node;
    const keys = [projectColorKey(node.name), projectColorKey(node.projectPath)].filter(Boolean);
    const legacyColorId = keys.map((key) => colors[key]).find((value) => typeof value === "string");
    const legacyOverlay = keys.map((key) => overlays[key]).find((value) => typeof value === "string");
    let next = node;
    const option = PROJECT_COLOR_OPTIONS.find((item) => item.id === String(legacyColorId || "").toLowerCase());
    if (option && node.colorMode === "auto") {
      next = { ...next, colorMode: "manual", color: option.value };
      changed = true;
    }
    if (legacyOverlay && PROJECT_OVERLAY_OPTIONS.includes(String(legacyOverlay).toLowerCase()) && next.overlayIntensity === "medium") {
      next = { ...next, overlayIntensity: String(legacyOverlay).toLowerCase() };
      changed = true;
    }
    return next;
  });
  return { changed, state: { schemaVersion: 1, nodes } };
}

function safeReference(type, value) {
  if (typeof value !== "string" || value.length > 160 || /[\r\n\0]/.test(value)) throw coded("invalid-reference");
  if (/(?:token|cookie|secret|password|authorization)=/i.test(value) || /^\//.test(value) || /^~\//.test(value)) {
    throw coded("secret-reference-rejected");
  }
  const patterns = {
    github: /^gh:[a-f0-9]{24}$/,
    modal: /^modal:[a-zA-Z0-9._-]{1,80}$/,
    google: /^google:[a-zA-Z0-9._-]{1,80}$/,
    chrome: /^chrome:[a-zA-Z0-9._-]{1,80}$/,
    "google-workspace": /^google-workspace:[a-zA-Z0-9._-]{1,80}$/,
    supabase: /^supabase:[a-zA-Z0-9._-]{1,80}$/,
    environment: /^environment:[a-zA-Z0-9._-]{1,80}$/,
  };
  if (!patterns[type].test(value)) throw coded("invalid-reference");
  const opaqueValue = value.slice(value.indexOf(":") + 1);
  if (looksLikeSecret(opaqueValue)) throw coded("secret-reference-rejected");
  return value;
}

/**
 * Convert the friendly name shown in Chrome into a bounded, non-secret
 * reference. Casing is preserved for display; consumers should compare the
 * normalized suffix case-insensitively with Chrome's profile metadata.
 */
function normalizeChromeProfileReference(value) {
  if (typeof value !== "string" || value.length > 160 || /[\r\n\0]/.test(value)) throw coded("invalid-chrome-profile");
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-");
  if (!normalized || normalized.length > 80) throw coded("invalid-chrome-profile");
  return safeReference("chrome", `chrome:${normalized}`);
}

function chromeProfileDisplayName(reference) {
  const safe = safeReference("chrome", reference);
  const name = safe.slice("chrome:".length);
  if (name.toLowerCase() === "default") return "Default (legacy)";
  return name.replace(/[-_]+/g, " ");
}

function updateChromeProfileAssignment(state, projectId, rawName) {
  const id = safeId(projectId);
  const normalized = normalizeState(state);
  if (!normalized.nodes.some((node) => node.type === "project" && node.id === id)) throw coded("unknown-project");
  const trimmed = typeof rawName === "string" ? rawName.trim() : "";
  const reference = trimmed ? normalizeChromeProfileReference(trimmed) : null;
  const nodes = normalized.nodes.map((node) => {
    if (node.type !== "project" || node.id !== id) return node;
    const connections = { ...node.connections };
    if (reference) connections.chrome = reference;
    else delete connections.chrome;
    return { ...node, connections };
  });
  return { ...normalized, nodes };
}

function looksLikeSecret(value) {
  return /^(?:sk-proj-|sk-[A-Za-z0-9]|gh[opsu]_|xox[baprs]-)/i.test(value)
    || /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/.test(value)
    || /^(?:bearer|basic)\s+/i.test(value);
}

function spawnTextAsync(command, args, options = {}) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const maxBuffer = options.maxBuffer || 1024 * 1024;
    const done = (result) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve(result); };
    let child;
    try { child = spawn(command, args, { env: options.env }); }
    catch (error) { return void done({ status: null, error, stdout, stderr }); }
    if (options.timeout) timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done({ status: null, error: { code: "ETIMEDOUT" }, stdout, stderr }); }, options.timeout);
    child.on("error", (error) => done({ status: null, error, stdout, stderr }));
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) { try { child.kill("SIGKILL"); } catch {} done({ status: null, error: { code: "ENOBUFS" }, stdout, stderr }); }
    });
    child.stderr?.on("data", (chunk) => { if (stderr.length < maxBuffer) stderr += chunk; });
    child.on("close", (code) => done({ status: code, error: null, stdout, stderr }));
  });
}

function adapterProbePaths(home, join, platform) {
  // Per-platform default config locations. macOS uses ~/Library, Windows uses
  // %APPDATA%/%LOCALAPPDATA%, Linux uses XDG/~/.config.
  const appData = (typeof process !== "undefined" && process.env.APPDATA) || join(home, "AppData", "Roaming");
  const localAppData = (typeof process !== "undefined" && process.env.LOCALAPPDATA) || join(home, "AppData", "Local");
  const gcloudDir = platform === "win32" ? join(appData, "gcloud") : join(home, ".config", "gcloud");
  const chromeState = platform === "darwin"
    ? join(home, "Library", "Application Support", "Google", "Chrome", "Local State")
    : platform === "win32"
      ? join(localAppData, "Google", "Chrome", "User Data", "Local State")
      : join(home, ".config", "google-chrome", "Local State");
  return {
    modal: join(home, ".modal.toml"),
    gcloudDir,
    gcloudAdc: join(gcloudDir, "application_default_credentials.json"),
    chromeState,
    supabase: join(home, ".supabase"),
  };
}

async function detectConnections(githubRefs) {
  const { existsSync } = require("node:fs");
  const { createHash } = require("node:crypto");
  const { homedir, platform } = require("node:os");
  const { join } = require("node:path");
  const result = Object.fromEntries(CONNECTION_TYPES.map((type) => [type, { status: "unconfigured", refs: [] }]));
  const nextRefs = new Map();
  try {
    const gh = await spawnTextAsync("gh", ["auth", "status", "--json", "hosts"], { timeout: 5000, maxBuffer: 256 * 1024 });
    if (gh.error || gh.status !== 0) throw gh.error || new Error("gh-failed");
    const hosts = JSON.parse(gh.stdout).hosts || {};
    for (const [host, accounts] of Object.entries(hosts)) {
      for (const account of Array.isArray(accounts) ? accounts : []) {
        if (typeof account?.login !== "string" || account.state !== "success") continue;
        const id = `gh:${createHash("sha256").update(`${host}\0${account.login}`).digest("hex").slice(0, 24)}`;
        nextRefs.set(id, { host, login: account.login });
        result.github.refs.push({ id, label: maskLabel(account.login), active: account.active === true });
      }
    }
    result.github.status = result.github.refs.length ? "configured" : "unconfigured";
    githubRefs.clear();
    for (const [id, identity] of nextRefs) githubRefs.set(id, identity);
  } catch {
    result.github.status = "error";
    githubRefs.clear();
  }
  const home = homedir();
  const probe = adapterProbePaths(home, join, platform());
  const adapters = {
    modal: existsSync(probe.modal),
    google: existsSync(probe.gcloudDir),
    "google-workspace": existsSync(probe.gcloudAdc),
    supabase: existsSync(probe.supabase),
    environment: true,
  };
  for (const [type, configured] of Object.entries(adapters)) {
    result[type] = configured
      ? { status: "configured", refs: [{ id: `${type}:default`, label: type === "environment" ? "Local environment" : "Default local configuration" }] }
      : { status: "unconfigured", refs: [] };
  }
  // Chrome's Local State proves only that Chrome is installed. It cannot tell
  // us which named profile belongs to a project, so never offer a misleading
  // global `chrome:default` assignment.
  result.chrome = existsSync(probe.chromeState)
    ? { status: "available", refs: [] }
    : { status: "unconfigured", refs: [] };
  return redact(result);
}

async function runGitHubForProject(state, githubRefs, projectId, rawArgv) {
  const project = state.nodes.find((node) => node.type === "project" && node.id === projectId);
  if (!project) return safeFailure("unknown-project");
  if (!project.githubRepo) return safeFailure("github-repository-unconfigured");
  const identity = githubRefs.get(project.connections.github);
  if (!identity) return safeFailure("github-identity-unavailable");
  let argv;
  try { argv = normalizeGitHubArgs(rawArgv); } catch (error) { return safeFailure(errorCode(error)); }
  const baseEnv = { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", NO_COLOR: "1" };
  const tokenResult = await spawnTextAsync("gh", ["auth", "token", "--hostname", identity.host, "--user", identity.login], {
    timeout: 5000, maxBuffer: 32 * 1024, env: baseEnv,
  });
  if (tokenResult.status !== 0 || !tokenResult.stdout?.trim()) return safeFailure("github-token-unavailable");
  const token = tokenResult.stdout.trim();
  const env = {
    HOME: process.env.HOME || "",
    PATH: process.env.PATH || "/usr/bin:/bin",
    GH_TOKEN: token,
    GH_HOST: identity.host,
    GH_REPO: project.githubRepo,
    NO_COLOR: "1",
  };
  const result = await spawnTextAsync("gh", argv, { timeout: 15000, maxBuffer: 256 * 1024, env });
  env.GH_TOKEN = "";
  if (result.error) return safeFailure(result.error.code === "ETIMEDOUT" ? "github-timeout" : "github-command-failed");
  return redact({ ok: result.status === 0, code: result.status ?? 1, stdout: scrub(result.stdout, token), stderr: scrub(result.stderr, token) });
}

function normalizeGitHubArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 20) throw coded("invalid-github-command");
  const allowed = {
    repo: new Set(["list", "view"]), pr: new Set(["checks", "diff", "list", "status", "view"]),
    issue: new Set(["list", "status", "view"]), release: new Set(["list", "view"]),
    run: new Set(["list", "view", "watch"]), workflow: new Set(["list", "view"]),
  };
  const out = argv.map((arg) => {
    if (typeof arg !== "string" || arg.length > 200 || /[\0\r\n;&|`$<>]/.test(arg)) throw coded("invalid-github-command");
    return arg;
  });
  if (!allowed[out[0]]?.has(out[1])) throw coded("github-command-denied");
  if (out.some((arg) => ["--input", "--hostname", "--user", "--repo", "-R"].includes(arg))) throw coded("github-command-denied");
  return out;
}

function mergeLegacyAssignments(projectState, legacy) {
  const next = normalizeState(projectState);
  if (!isRecord(legacy?.assignments)) return next;
  for (const node of next.nodes) {
    const ref = legacy.assignments[node.id];
    if (node.type === "project" && !node.connections.github && typeof ref === "string") {
      try { node.connections.github = safeReference("github", ref); } catch {}
    }
  }
  return next;
}

function startRenderer(api) {
  let latestState = null;
  let latestRevision = null;
  const apply = () => applyNativeProjectColors(api, latestState);
  const saveAppearance = async (projectId, choice) => {
    if (!latestState || !projectId) return;
    try {
      const nodes = latestState.nodes.map((node) => node.id === projectId ? { ...node, ...choice } : node);
      const response = await api.ipc.invoke(IPC, { action: "save", state: { ...latestState, nodes }, baseRevision: latestRevision });
      if (!response?.ok) { api.log?.warn?.("project appearance save failed", response?.error?.code || "unknown"); window.alert("Could not save the project color."); return; }
      latestState = response.state;
      latestRevision = response.revision;
      apply();
      window.dispatchEvent(new CustomEvent("codexpp:projects-color-change", { detail: { projectId } }));
    } catch (error) {
      api.log?.warn?.("project appearance save failed", String(error));
      window.alert("Could not save the project color.");
    }
  };
  const removeRevision = api.ipc.on("revision", (payload) => {
    if (typeof payload?.revision === "string" && /^[a-f0-9]{32}$/.test(payload.revision)) {
      window.dispatchEvent(new CustomEvent("codexpp:projects-revision", { detail: { revision: payload.revision } }));
    }
  });
  const handle = api.settings.registerPage({
    id: "projects",
    title: "Projects",
    description: "Organize the projects shown in your ChatGPT sidebar.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block shrink-0 align-middle" aria-hidden="true"><path d="M2.5 5.5h6l1.5 2h7.5v7.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    render(root) { return renderProjectsPage(api, root, (state, revision) => { latestState = state; latestRevision = revision; apply(); }); },
  });
  api.ipc.invoke(IPC, { action: "get" }).then((response) => {
    if (response?.ok) { latestState = response.state; latestRevision = response.revision; apply(); }
  }).catch(() => {});
  const removeHostObserver = api.react?.host?.observe?.(["projects"], apply);
  const removeColorControls = installProjectColorControls(api, () => latestState, saveAppearance);
  module.exports._page = { unregister() { removeRevision?.(); removeHostObserver?.(); removeColorControls?.(); removeProjectColorArtifacts(); handle.unregister?.(); } };
}

function renderProjectsPage(api, root, onState) {
  let disposed = false;
  root.textContent = "Loading projects…";
  const load = () => api.ipc.invoke(IPC, { action: "get" }).then((response) => {
    if (disposed) return;
    const names = response?.ok && response.state.nodes.length === 0
      ? [...new Set((api.react?.host?.query?.("projects") || []).map((match) => match.label || match.element?.textContent || "").map((name) => name.replace(/\s+/g, " ").trim()).filter(Boolean))]
      : [];
    if (names.length) {
      const nodes = names.map((name, index) => ({ id: nativeProjectId(name, index), type: "project", parentId: null, name, icon: { kind: "emoji", value: "📁" }, colorMode: "auto", overlayIntensity: "medium", connections: {} }));
      return api.ipc.invoke(IPC, { action: "save", state: { schemaVersion: 1, nodes }, baseRevision: response.revision }).then(load);
    }
    if (response?.ok) onState?.(response.state, response.revision);
    renderState(api, root, response, load);
  }).catch(() => { if (!disposed) root.textContent = "Projects are unavailable."; });
  const onColorChange = () => void load();
  window.addEventListener("codexpp:projects-color-change", onColorChange);
  void load();
  return () => { disposed = true; window.removeEventListener("codexpp:projects-color-change", onColorChange); root.textContent = ""; };
}

function renderState(api, root, response, reload) {
  root.textContent = "";
  if (!response?.ok) { root.textContent = "Projects are unavailable."; return; }
  const state = response.state;
  const revision = response.revision;
  const heading = element("div", "flex items-center justify-end gap-3");
  const actions = element("div", "flex gap-2");
  actions.append(button("Add group", () => addNode(api, state, "group", reload, revision)), button("Add project", () => addNode(api, state, "project", reload, revision)));
  heading.append(actions);
  root.append(heading, connectionCard(response.connections));
  const tree = element("div", "border-token-border mt-4 rounded-lg border");
  renderChildren(api, tree, state, null, response.connections, reload, 0, revision);
  if (!state.nodes.length) tree.append(element("div", "p-3 text-sm text-token-text-secondary", "No projects yet."));
  root.append(tree);
}

function connectionCard(connections) {
  const card = element("div", "border-token-border mt-4 grid grid-cols-1 divide-y-[0.5px] divide-token-border rounded-lg border");
  for (const type of CONNECTION_TYPES) {
    const row = element("div", "flex items-center justify-between gap-4 p-3");
    row.append(element("span", "text-sm text-token-text-primary", titleCase(type)));
    const status = connections[type]?.status || "error";
    const badge = element("span", "text-sm text-token-text-secondary", status);
    badge.setAttribute("aria-label", `${titleCase(type)} ${status}`);
    row.append(badge); card.append(row);
  }
  return card;
}

function renderChildren(api, root, state, parentId, connections, reload, depth, revision) {
  const siblings = state.nodes.filter((item) => item.parentId === parentId);
  for (const [siblingIndex, node] of siblings.entries()) {
    const row = element("div", "flex items-center gap-3 p-3");
    row.style.paddingLeft = `${12 + depth * 20}px`;
    const icon = element("span", "w-5 shrink-0 text-center", node.icon.kind === "emoji" ? node.icon.value : "◈");
    icon.style.color = node.color;
    icon.setAttribute("role", "img"); icon.setAttribute("aria-label", node.icon.kind === "emoji" ? "Project icon" : `Iconify ${node.icon.value}`);
    if (node.icon.kind === "iconify") { icon.classList.add("iconify"); icon.dataset.icon = node.icon.value; }
    row.append(icon, element("span", "min-w-0 flex-1 truncate text-sm text-token-text-primary", node.name));
    row.append(button("Edit", () => editNode(api, state, node, reload, revision)));
    const up = button("↑", () => moveNode(api, state, siblings, siblingIndex, -1, reload, revision));
    up.title = `Move ${node.name} up`; up.disabled = siblingIndex === 0;
    const down = button("↓", () => moveNode(api, state, siblings, siblingIndex, 1, reload, revision));
    down.title = `Move ${node.name} down`; down.disabled = siblingIndex === siblings.length - 1;
    row.append(up, down);
    if (node.type === "project") row.append(projectAppearanceControls(api, state, node, reload, revision));
    else {
      const color = document.createElement("input");
      color.type = "color"; color.value = node.color; color.title = `Color for ${node.name}`; color.setAttribute("aria-label", `Color for ${node.name}`);
      color.className = "h-7 w-7 cursor-pointer rounded-md border-0 bg-transparent p-0";
      color.addEventListener("change", () => updateProjectAppearance(api, state, node.id, { color: color.value }, revision, reload));
      row.append(color);
    }
    if (node.type === "project") {
      for (const type of CONNECTION_TYPES) {
        const control = button(connectionButtonLabel(node, type), () => assignConnection(api, state, node, type, connections[type]?.refs || [], reload, revision));
        if (type === "chrome") control.title = "Set, replace, or remove this project's Chrome profile";
        row.append(control);
      }
    }
    root.append(row);
    if (node.type === "group") renderChildren(api, root, state, node.id, connections, reload, depth + 1, revision);
  }
}

function projectAppearanceControls(api, state, project, reload, revision) {
  const details = document.createElement("details");
  details.className = "relative";
  const summary = element("summary", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 cursor-pointer rounded-md border px-2 py-1 text-sm text-token-text-primary", "Color");
  details.appendChild(summary);
  const panel = element("div", "border-token-border absolute right-0 z-50 mt-1 flex w-64 flex-col gap-2 rounded-lg border p-2 shadow-lg");
  panel.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  const palette = element("div", "grid grid-cols-7 gap-1");
  const auto = button("Auto", () => updateProjectAppearance(api, state, project.id, { colorMode: "auto", color: autoColor(project.projectPath || project.id) }, revision, reload));
  auto.title = "Auto project color";
  auto.setAttribute("aria-pressed", String(project.colorMode === "auto"));
  panel.appendChild(auto);
  for (const option of PROJECT_COLOR_OPTIONS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.title = option.label;
    swatch.setAttribute("aria-label", `${option.label} project color`);
    swatch.setAttribute("aria-pressed", String(project.colorMode === "manual" && project.color === option.value));
    swatch.className = "border-token-border size-7 rounded-md border";
    swatch.style.backgroundColor = option.value;
    swatch.addEventListener("click", () => updateProjectAppearance(api, state, project.id, { colorMode: "manual", color: option.value }, revision, reload));
    palette.appendChild(swatch);
  }
  panel.appendChild(palette);
  const custom = document.createElement("input");
  custom.type = "color";
  custom.value = project.color;
  custom.title = `Custom color for ${project.name}`;
  custom.setAttribute("aria-label", `Custom color for ${project.name}`);
  custom.className = "h-8 w-full cursor-pointer rounded-md border-0 bg-transparent";
  custom.addEventListener("change", () => updateProjectAppearance(api, state, project.id, { colorMode: "manual", color: custom.value }, revision, reload));
  panel.appendChild(custom);
  const overlays = element("div", "grid grid-cols-4 gap-1");
  overlays.setAttribute("aria-label", `Task tint for ${project.name}`);
  for (const intensity of PROJECT_OVERLAY_OPTIONS) {
    const control = button(titleCase(intensity), () => updateProjectAppearance(api, state, project.id, { overlayIntensity: intensity }, revision, reload));
    control.setAttribute("aria-pressed", String(project.overlayIntensity === intensity));
    overlays.appendChild(control);
  }
  panel.appendChild(overlays);
  details.appendChild(panel);
  return details;
}

function updateProjectAppearance(api, state, projectId, choice, revision, reload) {
  const nodes = state.nodes.map((item) => item.id === projectId ? { ...item, ...choice } : item);
  applySave(api, { ...state, nodes }, revision, reload);
}

// Central save path: sends the base revision for optimistic concurrency and
// surfaces failures (including a stale-revision conflict) instead of silently
// reloading an unchanged tree.
function applySave(api, nextState, baseRevision, reload) {
  api.ipc.invoke(IPC, { action: "save", state: nextState, baseRevision }).then((response) => {
    if (response?.ok) { reload(); return; }
    const code = response?.error?.code;
    if (code === "stale-revision") { window.alert("This project list changed in another window. Reloading the latest version."); reload(); return; }
    api?.log?.warn?.("projects save failed", code || "unknown");
    window.alert(code ? `Could not save changes (${code}).` : "Could not save changes.");
  }).catch((error) => {
    api?.log?.warn?.("projects save failed", String(error));
    window.alert("Could not save changes.");
  });
}

function addNode(api, state, type, reload, revision) {
  const name = window.prompt(type === "group" ? "Group name" : "Project name");
  if (!name) return;
  const parentId = window.prompt("Parent group ID (leave blank for top level)", "") || null;
  const rawIcon = window.prompt("Emoji or Iconify name (example: lucide:folder)", type === "group" ? "📁" : "📌") || "📁";
  const icon = rawIcon.includes(":") ? { kind: "iconify", value: rawIcon } : { kind: "emoji", value: rawIcon };
  const node = { id: makeId(type), type, parentId, name, icon, connections: {} };
  if (type === "project") {
    node.colorMode = "auto";
    node.overlayIntensity = "medium";
    node.projectPath = window.prompt("Local project path (optional)", "") || undefined;
    node.githubRepo = window.prompt("GitHub repository (owner/name, optional)", "") || undefined;
  } else node.color = "#6b7280";
  applySave(api, { ...state, nodes: [...state.nodes, node] }, revision, reload);
}

function editNode(api, state, node, reload, revision) {
  const name = window.prompt(`${titleCase(node.type)} name`, node.name);
  if (!name) return;
  const parentId = window.prompt("Parent group ID (leave blank for top level)", node.parentId || "") || null;
  const currentIcon = node.icon.kind === "emoji" ? node.icon.value : node.icon.value;
  const rawIcon = window.prompt("Emoji or Iconify name", currentIcon) || currentIcon;
  const icon = rawIcon.includes(":") ? { kind: "iconify", value: rawIcon } : { kind: "emoji", value: rawIcon };
  const updated = { ...node, name, parentId, icon };
  if (node.type === "project") {
    updated.projectPath = window.prompt("Local project path (optional)", node.projectPath || "") || undefined;
    updated.githubRepo = window.prompt("GitHub repository (owner/name, optional)", node.githubRepo || "") || undefined;
  }
  applySave(api, { ...state, nodes: state.nodes.map((item) => item.id === node.id ? updated : item) }, revision, reload);
}

function moveNode(api, state, siblings, index, offset, reload, revision) {
  const other = siblings[index + offset];
  const node = siblings[index];
  if (!node || !other) return;
  const nodes = [...state.nodes];
  const from = nodes.findIndex((item) => item.id === node.id);
  const to = nodes.findIndex((item) => item.id === other.id);
  [nodes[from], nodes[to]] = [nodes[to], nodes[from]];
  applySave(api, { ...state, nodes }, revision, reload);
}

function assignGitHub(api, state, project, refs, reload, revision) {
  if (!refs.length) { window.alert("No configured GitHub identities were found."); return; }
  const choices = refs.map((ref, index) => `${index + 1}. ${ref.label}${ref.active ? " (active)" : ""}`).join("\n");
  const selected = Number(window.prompt(`Choose a GitHub identity:\n${choices}`, "1")) - 1;
  if (!refs[selected]) return;
  const nodes = state.nodes.map((node) => node.id === project.id ? { ...node, connections: { ...node.connections, github: refs[selected].id } } : node);
  applySave(api, { ...state, nodes }, revision, reload);
}

function assignConnection(api, state, project, type, refs, reload, revision) {
  if (type === "chrome") return assignChromeProfile(api, state, project, reload, revision);
  if (type === "github") return assignGitHub(api, state, project, refs, reload, revision);
  if (!refs.length) { window.alert(`No configured ${titleCase(type)} references were found.`); return; }
  const choices = refs.map((ref, index) => `${index + 1}. ${ref.label}`).join("\n");
  const selected = Number(window.prompt(`Choose ${titleCase(type)}:\n${choices}`, "1")) - 1;
  if (!refs[selected]) return;
  const nodes = state.nodes.map((node) => node.id === project.id ? { ...node, connections: { ...node.connections, [type]: refs[selected].id } } : node);
  applySave(api, { ...state, nodes }, revision, reload);
}

function connectionButtonLabel(project, type) {
  if (type !== "chrome") return titleCase(type);
  const reference = project.connections?.chrome;
  return reference ? `Chrome: ${chromeProfileDisplayName(reference)}` : "Set Chrome profile";
}

function assignChromeProfile(api, state, project, reload, revision) {
  const reference = project.connections?.chrome;
  const current = reference ? chromeProfileDisplayName(reference).replace(/ \(legacy\)$/, "") : "";
  const answer = window.prompt(
    `Chrome profile for ${project.name}\nEnter the friendly profile name shown in Chrome (for example, TRR or THB). Leave blank to remove this assignment.`,
    current,
  );
  if (answer === null) return;
  try {
    applySave(api, updateChromeProfileAssignment(state, project.id, answer), revision, reload);
  } catch {
    window.alert("Enter a Chrome profile name with letters or numbers. Spaces and punctuation are normalized safely.");
  }
}

function element(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, action) { const node = element("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 rounded-md border px-2 py-1 text-sm text-token-text-primary", text); node.type = "button"; node.addEventListener("click", action); return node; }
function makeId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

function discoverNativeProjectNames() {
  const excluded = new Set(["New task", "Scheduled", "Plugins", "Sites", "Pull requests", "Chat", "Pinned", "Projects", "Tasks"]);
  const sidebars = [...document.querySelectorAll("aside, nav")].filter((node) => /\bProjects\b/.test(node.textContent || "") && /\bTasks\b/.test(node.textContent || "") && !/Search settings/i.test(node.textContent || ""));
  for (const sidebar of sidebars) {
    const labels = [...sidebar.querySelectorAll("div,span")];
    const start = labels.find((node) => node.textContent?.trim() === "Projects")?.getBoundingClientRect().top;
    const end = labels.find((node) => node.textContent?.trim() === "Tasks")?.getBoundingClientRect().top;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const names = [...sidebar.querySelectorAll("button,a,[role='button']")].filter((node) => {
      const top = node.getBoundingClientRect().top;
      return top > start && top < end && !!node.querySelector("svg");
    }).map((node) => (node.textContent || "").replace(/\s+/g, " ").trim()).filter((name) => name && name.length <= 80 && !excluded.has(name));
    if (names.length) return [...new Set(names)];
  }
  return [];
}

function nativeProjectId(name, index) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `project-native-${(hash >>> 0).toString(16)}-${index}`;
}

function injectProjectColorMenu(doc, nativeMenu, context, onSelect) {
  if (!doc?.createElement || !nativeMenu || nativeMenu.querySelector?.(`[${PROJECT_COLOR_MENU_ATTR}="trigger"]`)) return null;
  const nativeItems = [...new Set([
    ...(nativeMenu.querySelectorAll?.('[role="menuitem"]') || []),
    ...(nativeMenu.querySelectorAll?.("button") || []),
    ...(nativeMenu.querySelectorAll?.("[data-radix-collection-item]") || []),
  ])];
  const removeItem = nativeItems.find((item) => /^remove$/i.test(String(item.textContent || "").trim())) || null;
  const template = nativeItems[0];
  const trigger = doc.createElement("div");
  trigger.setAttribute("role", "menuitem");
  trigger.setAttribute("tabindex", "-1");
  trigger.setAttribute(PROJECT_COLOR_MENU_ATTR, "trigger");
  trigger.className = template?.className || "text-token-foreground rounded-lg px-2 py-2 text-sm flex items-center cursor-interaction";
  const label = doc.createElement("span");
  label.textContent = "Project color";
  label.className = "min-w-0 flex-1 truncate";
  const chevron = doc.createElement("span");
  chevron.textContent = "›";
  chevron.className = "text-token-text-secondary";
  trigger.append(label, chevron);
  const open = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    openProjectColorSubmenu(doc, trigger, context, onSelect);
  };
  trigger.addEventListener("click", open);
  trigger.addEventListener("pointerenter", open);
  trigger.addEventListener("focus", open);
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") open(event);
  });
  nativeMenu.insertBefore(trigger, removeItem);
  return trigger;
}

function openProjectColorSubmenu(doc, anchor, context, onSelect) {
  const previous = doc.body.querySelector?.(`[${PROJECT_COLOR_MENU_ATTR}="submenu"]`);
  if (typeof previous?.[PROJECT_COLOR_DISPOSE] === "function") previous[PROJECT_COLOR_DISPOSE]();
  else previous?.remove?.();
  const project = context?.project || {};
  const submenu = doc.createElement("div");
  submenu.setAttribute("role", "menu");
  submenu.setAttribute(PROJECT_COLOR_MENU_ATTR, "submenu");
  submenu.className = "fixed z-[10000] flex max-h-[70vh] min-w-[220px] flex-col overflow-y-auto rounded-xl border border-token-border p-1 shadow-lg";
  submenu.style?.setProperty?.("background-color", "var(--color-background-panel, var(--color-token-bg-fog))");
  const rect = anchor?.getBoundingClientRect?.();
  if (submenu.style?.setProperty) {
    const viewportHeight = Number(doc.defaultView?.innerHeight) || 800;
    const viewportWidth = Number(doc.defaultView?.innerWidth) || 1200;
    const maxHeight = Math.min(Math.max(160, Math.floor(viewportHeight * 0.7)), Math.max(96, viewportHeight - 16));
    const top = Math.max(8, Math.min(Number(rect?.top) || 8, viewportHeight - maxHeight - 8));
    const right = Number(rect?.right) || 8;
    const left = right + 220 <= viewportWidth - 8 ? right : Math.max(8, (Number(rect?.left) || right) - 220);
    submenu.style.setProperty("left", `${left}px`);
    submenu.style.setProperty("top", `${top}px`);
    submenu.style.setProperty("max-height", `${maxHeight}px`);
    submenu.style.setProperty("overflow-y", "auto");
    submenu.style.setProperty("overscroll-behavior", "contain");
    submenu.style.setProperty("scrollbar-gutter", "stable");
  }
  const title = doc.createElement("div");
  title.textContent = "Project color";
  title.className = "px-2 py-1 text-xs text-token-text-secondary";
  submenu.appendChild(title);
  const choices = [{ id: "auto", label: "Auto", value: autoColor(project.projectPath || project.id || project.name) }, ...PROJECT_COLOR_OPTIONS];
  let checkedItem = null;
  for (const option of choices) {
    const item = doc.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("data-color-id", option.id);
    item.setAttribute("aria-checked", String(option.id === "auto" ? project.colorMode === "auto" : project.colorMode !== "auto" && project.color === option.value));
    if (item.getAttribute("aria-checked") === "true") checkedItem = item;
    item.className = "flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-foreground/10";
    const swatch = doc.createElement("span");
    swatch.className = "size-3 shrink-0 rounded-full border border-token-border";
    swatch.style?.setProperty?.("background-color", option.value);
    const text = doc.createElement("span");
    text.textContent = option.label;
    text.className = "min-w-0 flex-1 truncate";
    const check = doc.createElement("span");
    check.textContent = item.getAttribute("aria-checked") === "true" ? "✓" : "";
    item.append(swatch, text, check);
    item.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onSelect?.(option.id === "auto" ? { colorMode: "auto", color: autoColor(project.projectPath || project.id || project.name) } : { colorMode: "manual", color: option.value });
      close();
    });
    submenu.appendChild(item);
  }
  const overlayTitle = doc.createElement("div");
  overlayTitle.textContent = "Task tint";
  overlayTitle.className = "mt-1 border-t border-token-border px-2 py-1 text-xs text-token-text-secondary";
  submenu.appendChild(overlayTitle);
  for (const intensity of PROJECT_OVERLAY_OPTIONS) {
    const item = doc.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("data-overlay-id", intensity);
    item.setAttribute("aria-checked", String(project.overlayIntensity === intensity));
    item.textContent = titleCase(intensity);
    item.className = "flex min-h-8 items-center rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-foreground/10";
    item.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onSelect?.({ overlayIntensity: intensity });
      close();
    });
    submenu.appendChild(item);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener?.("pointerdown", onOutside, true);
    doc.removeEventListener?.("keydown", onKeydown, true);
    submenu[PROJECT_COLOR_DISPOSE] = null;
    submenu.remove?.();
  };
  const onOutside = (event) => {
    if (submenu.contains?.(event.target) || anchor?.contains?.(event.target)) return;
    close();
  };
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  submenu[PROJECT_COLOR_DISPOSE] = close;
  doc.body.appendChild(submenu);
  checkedItem?.scrollIntoView?.({ block: "nearest" });
  doc.addEventListener?.("pointerdown", onOutside, true);
  doc.addEventListener?.("keydown", onKeydown, true);
  return submenu;
}

function installProjectColorControls(api, getState, saveAppearance) {
  if (typeof document === "undefined") return () => {};
  ensureProjectColorStyle();
  let pending = null;
  let requestId = 0;
  let menuObserver = null;
  let menuObserverTimer = null;
  const inject = (context, id) => {
    if (!pending || requestId !== id || pending !== context) return;
    const nativeMenu = findNativeProjectMenu(document, context);
    if (!nativeMenu) return;
    const trigger = injectProjectColorMenu(document, nativeMenu, context, async (choice) => {
      await saveAppearance?.(context.project.id, choice);
      nativeMenu.remove?.();
    });
    if (trigger) api.log?.info?.("Project color menu injected", { projectId: context.project.id, source: context.source });
  };
  const stopMenuObserver = () => {
    menuObserver?.disconnect?.();
    menuObserver = null;
    if (menuObserverTimer !== null) window.clearTimeout(menuObserverTimer);
    menuObserverTimer = null;
  };
  const seed = (event) => {
    const context = resolveProjectContext(api, getState?.(), event.target);
    if (!context) return;
    if (event.type !== "contextmenu") {
      const button = event.target?.closest?.('button, [role="button"]');
      if (!button || button === context.element || !context.container.contains(button)) return;
    }
    const anchor = event.target?.closest?.('button, [role="button"]') || context.container;
    const rect = anchor?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) ? event.clientX : (rect?.right || rect?.left || 0);
    const y = Number.isFinite(event.clientY) ? event.clientY : (rect?.top || 0);
    stopMenuObserver();
    pending = { ...context, x, y };
    const id = ++requestId;
    api.log?.info?.("Project color menu target resolved", { projectId: pending.project.id, source: pending.source, eventType: event.type });
    inject(pending, id);
    menuObserver = new MutationObserver(() => inject(pending, id));
    menuObserver.observe(document.body, { childList: true, subtree: true });
    menuObserverTimer = window.setTimeout(() => {
      if (requestId === id) pending = null;
      stopMenuObserver();
    }, 1500);
  };
  document.addEventListener("contextmenu", seed, true);
  document.addEventListener("pointerdown", seed, true);
  document.addEventListener("click", seed, true);
  return () => {
    document.removeEventListener("contextmenu", seed, true);
    document.removeEventListener("pointerdown", seed, true);
    document.removeEventListener("click", seed, true);
    stopMenuObserver();
    requestId += 1;
    pending = null;
    removeProjectColorArtifacts();
  };
}

function resolveProjectContext(api, state, target) {
  if (!state?.nodes || !(target instanceof Element)) return null;
  const projects = state.nodes
    .filter((node) => node.type === "project")
    .sort((a, b) => b.name.length - a.name.length);
  const projectForLabel = (label, identity) => {
    if (identity) {
      const exact = projects.find((node) => node.id === identity || node.projectPath === identity);
      if (exact) return exact;
    }
    return projects.find((node) => label === node.name || label.startsWith(`${node.name} `) || label.startsWith(`${node.name} ·`));
  };
  const targetContainer = target.closest?.('[role="listitem"]');

  for (const match of api.react?.host?.query?.("projects") || []) {
    const element = match.element;
    if (!(element instanceof HTMLElement)) continue;
    const container = element.closest?.('[role="listitem"]') || element;
    if (!(element === target || element.contains(target) || target.contains?.(element) || (targetContainer && targetContainer === container))) continue;
    const identity = element.getAttribute?.("data-app-action-sidebar-project-id") || element.getAttribute?.("data-workspace-path") || element.getAttribute?.("data-project-path");
    const project = projectForLabel(projectLabelForRow(element), identity);
    if (project) return { project, element, container, source: "semantic" };
  }

  if (!(targetContainer instanceof HTMLElement)) return null;
  const projectAction = targetContainer.querySelector?.("[data-app-action-sidebar-project-id]");
  const donorRowShape = targetContainer.classList?.contains?.("group/cwd") || projectAction instanceof HTMLElement;
  if (!donorRowShape) return null;
  const label = projectLabelForRow(projectAction instanceof HTMLElement ? projectAction : targetContainer);
  const identity = projectAction?.getAttribute?.("data-app-action-sidebar-project-id") || targetContainer.getAttribute?.("data-workspace-path") || targetContainer.getAttribute?.("data-project-path");
  const project = projectForLabel(label, identity);
  if (!project) return null;
  return { project, element: projectAction instanceof HTMLElement ? projectAction : targetContainer, container: targetContainer, source: "live-row" };
}

function findNativeProjectMenu(doc, context = {}) {
  const menus = [...(doc?.querySelectorAll?.('[role="menu"]') || [])]
    .filter((menu) => menu.getAttribute?.("data-state") === "open" && !menu.hasAttribute?.(PROJECT_COLOR_MENU_ATTR))
    .filter((menu) => [...(menu.querySelectorAll?.('[role="menuitem"]') || [])]
      .some((item) => /^(?:remove|delete)$|remove from/i.test(String(item.textContent || "").trim())))
    .map((menu) => ({ menu, rect: menu.getBoundingClientRect?.() }))
    .filter(({ rect }) => rect && rect.width > 0 && rect.height > 0);
  const x = Number.isFinite(context.x) ? context.x : 0;
  const y = Number.isFinite(context.y) ? context.y : 0;
  return menus.sort((a, b) =>
    (Math.abs(a.rect.left - x) + Math.abs(a.rect.top - y)) -
    (Math.abs(b.rect.left - x) + Math.abs(b.rect.top - y)))[0]?.menu || null;
}

function ensureProjectColorStyle() {
  let style = document.getElementById(PROJECT_COLOR_STYLE_ID);
  if (style) return style;
  style = document.createElement("style");
  style.id = PROJECT_COLOR_STYLE_ID;
  style.textContent = `
    [data-codexpp-project-color-group] {
      --codexpp-project-task-tint: 10%;
      --codexpp-project-task-foreground: var(--codexpp-project-color);
      --codexpp-project-header-tint: 16%;
      --codexpp-project-header-foreground: color-mix(in srgb, var(--codexpp-project-color) 72%, var(--color-token-text-primary));
    }
    [data-codexpp-project-color-group][data-codexpp-project-overlay="off"] { --codexpp-project-task-tint: 0%; }
    [data-codexpp-project-color-group][data-codexpp-project-overlay="subtle"] { --codexpp-project-task-tint: 6%; }
    [data-codexpp-project-color-group][data-codexpp-project-overlay="medium"] { --codexpp-project-task-tint: 10%; }
    [data-codexpp-project-color-group][data-codexpp-project-overlay="strong"] { --codexpp-project-task-tint: 15%; }
    .electron-dark [data-codexpp-project-color-group] {
      --codexpp-project-task-foreground: color-mix(in srgb, var(--codexpp-project-color) 42%, white);
      --codexpp-project-header-tint: 24%;
      --codexpp-project-header-foreground: color-mix(in srgb, var(--codexpp-project-color) 45%, var(--color-token-text-primary));
    }
    .electron-dark [data-codexpp-project-color-group][data-codexpp-project-overlay="subtle"] { --codexpp-project-task-tint: 11%; }
    .electron-dark [data-codexpp-project-color-group][data-codexpp-project-overlay="medium"] { --codexpp-project-task-tint: 18%; }
    .electron-dark [data-codexpp-project-color-group][data-codexpp-project-overlay="strong"] { --codexpp-project-task-tint: 24%; }
    [data-codexpp-project-color-row] {
      width: 100%;
      border-radius: var(--radius-lg, 0.625rem) !important;
      background-color: var(--codexpp-project-color) !important;
      color: var(--codexpp-project-foreground) !important;
    }
    [data-codexpp-project-color-row]:hover {
      background-image: linear-gradient(rgb(255 255 255 / 8%), rgb(255 255 255 / 8%));
    }
    [data-codexpp-project-color-row][data-codexpp-project-selected="true"] {
      position: relative;
      background-color: var(--gray-1000) !important;
      color: var(--gray-0) !important;
    }
    [data-codexpp-project-color-row][data-codexpp-project-selected="true"] * {
      color: var(--gray-0) !important;
    }
    [data-codexpp-project-color-row][data-codexpp-project-selected="true"]::after {
      content: "";
      position: absolute;
      inset: 0;
      border: 2px solid var(--color-token-focus-border, var(--color-token-text-link-foreground));
      border-radius: inherit;
      pointer-events: none;
    }
    [data-codexpp-project-color-icon] { color: var(--codexpp-project-foreground) !important; }
    [data-codexpp-project-color-row][data-codexpp-project-selected="true"] [data-codexpp-project-color-icon] {
      color: var(--gray-0) !important;
    }
    [data-codexpp-project-color-title] {
      color: var(--codexpp-project-foreground) !important;
      font-weight: 700 !important;
      text-transform: uppercase !important;
    }
    [data-codexpp-project-color-row][data-codexpp-project-selected="true"] [data-codexpp-project-color-title] {
      color: var(--gray-0) !important;
    }
    [data-codexpp-project-color-task] {
      border-radius: var(--radius-lg, 0.625rem) !important;
      background-color: color-mix(in srgb, var(--codexpp-project-color) var(--codexpp-project-task-tint), transparent) !important;
    }
    [data-codexpp-project-color-task]:hover {
      background-image: linear-gradient(color-mix(in srgb, var(--color-token-list-hover-background, transparent) 70%, transparent), color-mix(in srgb, var(--color-token-list-hover-background, transparent) 70%, transparent));
    }
    [data-codexpp-project-task-label] {
      color: var(--codexpp-project-task-foreground) !important;
      font-weight: 400 !important;
    }
    [data-codexpp-project-color-task][data-codexpp-project-selected="true"] {
      background-color: var(--codexpp-project-color) !important;
      color: var(--codexpp-project-foreground) !important;
    }
    [data-codexpp-project-color-task][data-codexpp-project-selected="true"] [data-codexpp-project-task-label],
    [data-codexpp-project-color-task][data-codexpp-project-selected="true"] svg {
      color: var(--codexpp-project-foreground) !important;
    }
    [data-codexpp-project-show-more] {
      background: transparent !important;
      color: var(--codexpp-project-task-foreground) !important;
      font-weight: 600 !important;
    }
    [${PROJECT_COLOR_MENU_ATTR}="submenu"] { color-scheme: light dark; }
  `;
  document.head.appendChild(style);
  return style;
}

function applyNativeProjectColors(api, state) {
  if (!state?.nodes) return;
  clearNativeProjectColors();
  ensureProjectColorStyle();
  const projects = state.nodes.filter((node) => node.type === "project").sort((a, b) => b.name.length - a.name.length);
  const matches = nativeProjectMatches(api, projects);
  for (const match of matches) {
    const row = match.element;
    if (!(row instanceof HTMLElement)) continue;
    const label = projectLabelForRow(row);
    const identity = row.getAttribute?.("data-app-action-sidebar-project-id") || row.getAttribute?.("data-workspace-path") || row.getAttribute?.("data-project-path");
    const project = projects.find((candidate) => identity && (candidate.id === identity || candidate.projectPath === identity)) ||
      projects.find((candidate) => label === candidate.name || label.startsWith(`${candidate.name} ·`) || label.startsWith(`${candidate.name} `));
    if (!project) continue;
    const container = closestProjectContainer(row) || row;
    const header = projectHeaderForMatch(row, container, project);
    markProjectColorNode(container, "data-codexpp-project-color-group", project);
    markProjectColorNode(header, "data-codexpp-project-color-row", project);
    for (const icon of header.querySelectorAll?.("svg") || []) icon.setAttribute?.("data-codexpp-project-color-icon", "true");
    const title = [...(header.querySelectorAll?.("span") || [])].find((node) => String(node.textContent || "").trim() === project.name);
    title?.setAttribute?.("data-codexpp-project-color-title", "true");
    const hasSelectedTask = markProjectTaskRows(container, project, header);
    if (isNativeSelected(header) || hasNativeSelectionAttribute(container) || hasSelectedTask) header.setAttribute("data-codexpp-project-selected", "true");
  }
}

function nativeProjectMatches(api, projects) {
  const matches = [...(api.react?.host?.query?.("projects") || [])];
  const seen = new Set(matches.map((match) => match?.element).filter(Boolean));
  const add = (element) => {
    if (!(element instanceof HTMLElement) || seen.has(element)) return;
    seen.add(element);
    matches.push({ element, source: "projects-fallback" });
  };
  for (const element of document.querySelectorAll?.('[data-app-action-sidebar-project-id], [data-workspace-path], [data-project-path]') || []) add(element);
  const represented = new Set();
  for (const match of matches) {
    const element = match?.element;
    const identity = element?.getAttribute?.("data-app-action-sidebar-project-id") || element?.getAttribute?.("data-workspace-path") || element?.getAttribute?.("data-project-path");
    const label = projectLabelForRow(element);
    for (const project of projects) {
      if ((identity && (project.id === identity || project.projectPath === identity)) || label === project.name) represented.add(project.id);
    }
  }
  if (projects.every((project) => represented.has(project.id))) return matches;
  const scope = projectNavigationScope(projects);
  for (const element of scope?.querySelectorAll?.('button, a, [role="button"]') || []) {
    if (!element.querySelector?.("svg")) continue;
    const label = projectLabelForRow(element);
    if (projects.some((project) => label === project.name)) add(element);
  }
  return matches;
}

function projectNavigationScope(projects) {
  const headings = [...(document.querySelectorAll?.("h1, h2, h3, div, span") || [])]
    .filter((element) => String(element.textContent || "").replace(/\s+/g, " ").trim() === "Projects");
  for (const heading of headings) {
    let cursor = heading.parentElement;
    while (cursor) {
      if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") {
        const labels = [...(cursor.querySelectorAll?.('button, a, [role="button"]') || [])].map(projectLabelForRow);
        if (projects.some((project) => labels.includes(project.name))) return cursor;
        break;
      }
      cursor = cursor.parentElement;
    }
  }
  return null;
}

function closestProjectContainer(row) {
  let cursor = row;
  let listItem = null;
  while (cursor) {
    if (cursor.classList?.contains?.("group/cwd")) return cursor;
    if (!listItem && cursor.getAttribute?.("role") === "listitem") listItem = cursor;
    if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") return listItem;
    cursor = cursor.parentElement;
  }
  return listItem;
}

function projectHeaderForMatch(row, container, project) {
  if (row !== container) return row;
  const pathAction = container.querySelector?.("[data-app-action-sidebar-project-id]");
  if (pathAction instanceof HTMLElement) return pathAction;
  return [...(container.querySelectorAll?.("button") || [])]
    .find((node) => projectLabelForRow(node) === project.name) || row;
}

function markProjectTaskRows(container, project, header) {
  let hasSelectedTask = false;
  const lists = [...(container.querySelectorAll?.('[role="list"]') || [])];
  for (const list of lists) {
    for (const task of list.querySelectorAll?.('[role="listitem"]') || []) {
      if (nearestRoleList(task) !== list) continue;
      markProjectColorNode(task, "data-codexpp-project-color-task", project);
      taskLabelForRow(task)?.setAttribute?.("data-codexpp-project-task-label", "true");
      if (isNativeSelected(task)) {
        task.setAttribute("data-codexpp-project-selected", "true");
        hasSelectedTask = true;
      }
    }
    const showMore = [...(list.querySelectorAll?.("button") || []), ...(list.querySelectorAll?.('[role="button"]') || [])]
      .find((node) => String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "show more");
    if (showMore) {
      markProjectColorNode(showMore, "data-codexpp-project-show-more", project);
    }
  }
  if (!lists.length && container.classList?.contains?.("group/cwd")) {
    for (const task of container.querySelectorAll?.('button, a, [role="button"]') || []) {
      if (task === header || header?.contains?.(task)) continue;
      const label = String(task.textContent || "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      if (label.toLowerCase() === "show more") {
        markProjectColorNode(task, "data-codexpp-project-show-more", project);
        continue;
      }
      markProjectColorNode(task, "data-codexpp-project-color-task", project);
      taskLabelForRow(task)?.setAttribute?.("data-codexpp-project-task-label", "true");
      if (isNativeSelected(task)) {
        task.setAttribute("data-codexpp-project-selected", "true");
        hasSelectedTask = true;
      }
    }
  }
  return hasSelectedTask;
}

function taskLabelForRow(task) {
  const interactive = [...(task.querySelectorAll?.('a, button, [role="button"]') || [])]
    .find((node) => String(node.textContent || "").trim() || [...(node.querySelectorAll?.("span") || [])].some((span) => String(span.textContent || "").trim()));
  const scope = interactive || task;
  const spans = [...(scope.querySelectorAll?.("span") || [])].filter(isTaskLabelCandidate);
  const accessibleName = String(scope.getAttribute?.("aria-label") || scope.getAttribute?.("title") || task.getAttribute?.("aria-label") || "").trim();
  const named = accessibleName && spans.find((node) => accessibleName.includes(String(node.textContent || "").trim()));
  const visuallyPrimary = spans.find((node) => /(?:^|\s)(?:truncate|line-clamp-\d+)(?:\s|$)/.test(String(node.className || "")));
  return named || visuallyPrimary || spans[0] || interactive || task;
}

function isTaskLabelCandidate(node) {
  if (!String(node.textContent || "").trim()) return false;
  if (node.getAttribute?.("aria-hidden") === "true" || node.getAttribute?.("role") === "status") return false;
  if (/^(?:badge|status|timestamp|time|metadata?)$/i.test(String(node.getAttribute?.("data-slot") || ""))) return false;
  if (/(?:^|[-_\s])(?:badge|status|timestamp|metadata?)(?:$|[-_\s])/.test(String(node.className || "").toLowerCase())) return false;
  return ![...(node.querySelectorAll?.("span") || [])].some((child) => String(child.textContent || "").trim());
}

function nearestRoleList(node) {
  let cursor = node?.parentElement;
  while (cursor) {
    if (cursor.getAttribute?.("role") === "list") return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

function isNativeSelected(node) {
  if (hasNativeSelectionAttribute(node)) return true;
  const descendants = [...(node?.querySelectorAll?.('[aria-current]') || []), ...(node?.querySelectorAll?.('[aria-selected="true"]') || []), ...(node?.querySelectorAll?.('[data-state="active"]') || [])];
  return descendants.some(hasNativeSelectionAttribute);
}

function hasNativeSelectionAttribute(element) {
  const current = element?.getAttribute?.("aria-current");
  return (current !== null && current !== "false") || element?.getAttribute?.("aria-selected") === "true" || element?.getAttribute?.("data-state") === "active";
}

function projectLabelForRow(row) {
  return (row?.getAttribute?.("data-project-name") || row?.getAttribute?.("aria-label") || row?.getAttribute?.("title") || row?.textContent || "").replace(/\s+/g, " ").trim();
}

function projectColorForeground(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color || "").trim());
  if (!match) return "var(--gray-0)";
  const channels = match[1].match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "var(--gray-1000)" : "var(--gray-0)";
}

function markProjectColorNode(node, attribute, project) {
  node.setAttribute(attribute, "true");
  node.setAttribute("data-codexpp-project-overlay", project.overlayIntensity || "medium");
  node.style.setProperty("--codexpp-project-color", project.color);
  node.style.setProperty("--codexpp-project-foreground", projectColorForeground(project.color));
}

function clearNativeProjectColors() {
  for (const node of document.querySelectorAll("[data-codexpp-project-color-group], [data-codexpp-project-color-row], [data-codexpp-project-color-task], [data-codexpp-project-show-more]")) {
    node.removeAttribute("data-codexpp-project-color-group");
    node.removeAttribute("data-codexpp-project-color-row");
    node.removeAttribute("data-codexpp-project-color-task");
    node.removeAttribute("data-codexpp-project-show-more");
    node.removeAttribute("data-codexpp-project-selected");
    node.removeAttribute("data-codexpp-project-overlay");
    node.style.removeProperty("--codexpp-project-color");
    node.style.removeProperty("--codexpp-project-foreground");
  }
  for (const node of document.querySelectorAll("[data-codexpp-project-color-icon], [data-codexpp-project-color-title], [data-codexpp-project-task-label]")) {
    node.removeAttribute("data-codexpp-project-color-icon");
    node.removeAttribute("data-codexpp-project-color-title");
    node.removeAttribute("data-codexpp-project-task-label");
  }
}

function removeProjectColorArtifacts() {
  if (typeof document === "undefined") return;
  clearNativeProjectColors();
  document.querySelectorAll(`[${PROJECT_COLOR_MENU_ATTR}]`).forEach((node) => {
    if (typeof node[PROJECT_COLOR_DISPOSE] === "function") node[PROJECT_COLOR_DISPOSE]();
    else node.remove();
  });
  document.getElementById(PROJECT_COLOR_STYLE_ID)?.remove();
}
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(" "); }
function maskLabel(value) { if (value.length <= 2) return "••"; return `${value.slice(0, 2)}…${value.slice(-1)}`; }
function scrub(value, secret) { return String(value || "").slice(0, 256 * 1024).split(secret).join("[redacted]"); }
function safeId(value) { if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw coded("invalid-id"); return value; }
function safeText(value, max) { if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw coded("invalid-text"); return value.trim(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function replaceObject(target, source) { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, source); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function coded(code) { const error = new Error(code); error.code = code; return error; }
function errorCode(error) { return typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code) ? error.code : "operation-failed"; }
function safeFailure(code) { return { ok: false, error: { code, message: "The request could not be completed safely." } }; }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return typeof value === "string" ? value.replace(/(?:gh[opsu]_[A-Za-z0-9_]+|Bearer\s+\S+)/g, "[redacted]") : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = /token|cookie|secret|password|authorization|path|env/i.test(key) ? "[redacted]" : redact(item);
  return out;
}
