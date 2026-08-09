"use strict";

const {
  clone,
  coded,
  isRecord,
  safeId,
  safeText,
} = require("./common");

const CONNECTION_TYPES = Object.freeze([
  "github",
  "modal",
  "google",
  "chrome",
  "google-workspace",
  "supabase",
  "environment",
]);
const PROFILE_CONNECTION_TYPES = CONNECTION_TYPES;
const MAX_NODES = 200;
const MAX_DEPTH = 8;
const MAX_NATIVE_PROJECTS = 100;
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
  { id: "yellow", label: "Yellow", value: "#EFBF06" },
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
const LEGACY_COLOR_KEYS = Object.freeze({
  colors: "sidebar-project-backgrounds:colors",
  overlays: "sidebar-project-backgrounds:overlays",
});

function defaultState() {
  return { schemaVersion: 1, nodes: [] };
}

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
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readNativeLocalProjects(env = process.env) {
  const fs = require("node:fs");
  const path = require("node:path");
  try {
    const codexHome = typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim()
      ? env.CODEX_HOME.trim()
      : path.join(env.HOME || "", ".codex");
    if (!path.isAbsolute(codexHome)) return [];
    const file = path.join(codexHome, ".codex-global-state.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return [];
    return normalizeNativeLocalProjects(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
}

function normalizeNativeLocalProjects(value) {
  if (!isRecord(value) || !isRecord(value["local-projects"])) return [];
  const projects = [];
  for (const [key, candidate] of Object.entries(value["local-projects"])) {
    if (projects.length >= MAX_NATIVE_PROJECTS || !isRecord(candidate)) continue;
    try {
      const id = safeId(candidate.id || key);
      if (id !== key) continue;
      const name = safeText(candidate.name, 120);
      const rootPaths = uniquePaths(Array.isArray(candidate.rootPaths) ? candidate.rootPaths : []);
      if (!rootPaths.length) continue;
      projects.push({ id, name, rootPaths });
    } catch {}
  }
  const workspaceRootLabels = value["electron-workspace-root-labels"];
  if (!isRecord(workspaceRootLabels)) return projects;
  const projectsByName = new Map();
  for (const project of projects) {
    const matches = projectsByName.get(project.name) || [];
    matches.push(project);
    projectsByName.set(project.name, matches);
  }
  let aliasCount = 0;
  for (const [rootPath, label] of Object.entries(workspaceRootLabels)) {
    if (aliasCount >= MAX_NATIVE_PROJECTS * 8) break;
    aliasCount += 1;
    try {
      const matches = projectsByName.get(safeText(label, 120)) || [];
      if (matches.length !== 1) continue;
      const project = matches[0];
      const alias = normalizeWorkspacePath(rootPath);
      if (project.rootPaths.includes(alias)) continue;
      const aliases = project.rootPathAliases || [];
      if (aliases.length >= 8 || aliases.includes(alias)) continue;
      project.rootPathAliases = [...aliases, alias];
    } catch {}
  }
  return projects;
}

function uniquePaths(values) {
  return [...new Set(values.slice(0, 8).map((value) => {
    try { return normalizeWorkspacePath(value); } catch { return null; }
  }).filter(Boolean))];
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
  if (!patterns[type]?.test(value)) throw coded("invalid-reference");
  const opaqueValue = value.slice(value.indexOf(":") + 1);
  if (looksLikeSecret(opaqueValue)) throw coded("secret-reference-rejected");
  return value;
}

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

function bindNativeProjectIdentities(state, nativeProjects) {
  if (!state?.nodes) return state;
  const runtimeState = clone(state);
  const projectsByPath = new Map();
  for (const node of runtimeState.nodes) {
    delete node.nativeProjectIds;
    delete node.nativeProjectNames;
    delete node.nativeProjectPaths;
    if (node.type !== "project" || !node.projectPath) continue;
    const matches = projectsByPath.get(node.projectPath) || [];
    matches.push(node);
    projectsByPath.set(node.projectPath, matches);
  }
  for (const nativeProject of Array.isArray(nativeProjects) ? nativeProjects : []) {
    const matches = new Set();
    const identityPaths = [
      ...(Array.isArray(nativeProject?.rootPaths) ? nativeProject.rootPaths : []),
      ...(Array.isArray(nativeProject?.rootPathAliases) ? nativeProject.rootPathAliases : []),
    ];
    for (const rootPath of identityPaths) {
      for (const project of projectsByPath.get(rootPath) || []) matches.add(project);
    }
    if (matches.size !== 1) continue;
    const [project] = matches;
    project.nativeProjectIds = [...new Set([...(project.nativeProjectIds || []), nativeProject.id])];
    project.nativeProjectNames = [...new Set([...(project.nativeProjectNames || []), nativeProject.name])];
    project.nativeProjectPaths = [...new Set([
      ...(project.nativeProjectPaths || []),
      ...(Array.isArray(nativeProject.rootPaths) ? nativeProject.rootPaths : []),
    ])];
  }
  return runtimeState;
}

function projectNativeNames(project) {
  return [...new Set([project?.name, ...(Array.isArray(project?.nativeProjectNames) ? project.nativeProjectNames : [])]
    .filter((name) => typeof name === "string" && name.trim()))];
}

function projectForNativeIdentity(projects, label, identity) {
  if (identity) {
    const exact = projects.find((project) => project.id === identity || project.projectPath === identity
      || (Array.isArray(project.nativeProjectIds) && project.nativeProjectIds.includes(identity))
      || (Array.isArray(project.nativeProjectPaths) && project.nativeProjectPaths.includes(identity)));
    if (exact) return exact;
  }
  return projects.find((project) => projectNativeNames(project)
    .some((name) => label === name || label.startsWith(`${name} `) || label.startsWith(`${name} ·`)));
}

/**
 * Seed only a native project that has one unambiguous, normalized root path.
 * An unmatched or multi-root sidebar row becomes an explicitly unbound project
 * instead of pretending that a display label is a repository location.
 */
function seedProjectsFromNativeSurface(surfaceMatches, nativeProjects) {
  const native = Array.isArray(nativeProjects) ? nativeProjects : [];
  const nodes = [];
  const seenNative = new Set();
  const seenFallback = new Set();
  for (const [index, match] of (Array.isArray(surfaceMatches) ? surfaceMatches : []).entries()) {
    const candidate = nativeProjectForSurfaceMatch(match, native);
    if (candidate && seenNative.has(candidate.id)) continue;
    const name = candidate?.name || surfaceMatchLabel(match);
    if (!name || name.length > 80) continue;
    const fallbackKey = name.toLocaleLowerCase();
    if (!candidate && seenFallback.has(fallbackKey)) continue;
    const projectPath = candidate ? exactNativeProjectPath(candidate) : null;
    const id = candidate ? seededNativeProjectId(candidate.id, index) : seededNativeProjectId(name, index);
    nodes.push({
      id,
      type: "project",
      parentId: null,
      name,
      icon: { kind: "emoji", value: "📁" },
      colorMode: "auto",
      overlayIntensity: "medium",
      ...(projectPath ? { projectPath } : {}),
      connections: {},
    });
    if (candidate) seenNative.add(candidate.id);
    else seenFallback.add(fallbackKey);
  }
  return normalizeState({ schemaVersion: 1, nodes });
}

function nativeProjectForSurfaceMatch(match, nativeProjects) {
  const element = match?.element;
  const identities = [
    match?.id,
    element?.getAttribute?.("data-app-action-sidebar-project-id"),
    element?.getAttribute?.("data-workspace-path"),
    element?.getAttribute?.("data-project-path"),
  ].filter((value) => typeof value === "string" && value.trim());
  const direct = nativeProjects.filter((project) => identities.some((identity) => project.id === identity
    || project.rootPaths?.includes(identity) || project.rootPathAliases?.includes(identity)));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return null;
  const label = surfaceMatchLabel(match);
  const byName = nativeProjects.filter((project) => project.name === label);
  return byName.length === 1 ? byName[0] : null;
}

function surfaceMatchLabel(match) {
  const label = match?.label || match?.element?.getAttribute?.("data-project-name") || match?.element?.textContent || "";
  try { return safeText(String(label).replace(/\s+/g, " ").trim(), 80); } catch { return null; }
}

function exactNativeProjectPath(project) {
  const roots = uniquePaths(Array.isArray(project?.rootPaths) ? project.rootPaths : []);
  return roots.length === 1 ? roots[0] : null;
}

function seededNativeProjectId(identity, index) {
  let hash = 2166136261;
  for (const char of String(identity || "project")) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `project-native-${(hash >>> 0).toString(16)}-${index}`;
}

function looksLikeSecret(value) {
  return /^(?:sk-proj-|sk-[A-Za-z0-9]|gh[opsu]_|xox[baprs]-)/i.test(value)
    || /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/.test(value)
    || /^(?:bearer|basic)\s+/i.test(value);
}

module.exports = {
  CONNECTION_TYPES,
  PROFILE_CONNECTION_TYPES,
  PROJECT_COLOR_OPTIONS,
  PROJECT_OVERLAY_OPTIONS,
  LEGACY_COLOR_KEYS,
  defaultState,
  normalizeWorkspacePath,
  normalizeState,
  createSecureProjectStore,
  readNativeLocalProjects,
  normalizeNativeLocalProjects,
  readLegacyProjectColorPreferences,
  createLegacyProjectColorMigration,
  normalizeIcon,
  normalizeColor,
  normalizeColorMode,
  normalizeOverlayIntensity,
  autoColor,
  mergeLegacyProjectColors,
  safeReference,
  normalizeChromeProfileReference,
  chromeProfileDisplayName,
  updateChromeProfileAssignment,
  mergeLegacyAssignments,
  bindNativeProjectIdentities,
  projectNativeNames,
  projectForNativeIdentity,
  seedProjectsFromNativeSurface,
  exactNativeProjectPath,
};
