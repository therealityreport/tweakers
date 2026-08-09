"use strict";

const { isRecord, safeFailure, safeId } = require("./common");
const {
  PROFILE_CONNECTION_TYPES,
  chromeProfileDisplayName,
  normalizeWorkspacePath,
  safeReference,
} = require("./state");

const PROFILE_API_VERSION = 1;

function revisionForState(state) {
  const { createHash } = require("node:crypto");
  const { normalizeState } = require("./state");
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
  } catch {
    return safeFailure("policy-unavailable");
  }
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
  return labels[type] || String(type);
}

module.exports = {
  PROFILE_API_VERSION,
  revisionForState,
  readProfilesProjection,
  readFollowupPolicyProjection,
  readFollowupPolicy,
  parseFollowupMarker,
  profileLabel,
};
