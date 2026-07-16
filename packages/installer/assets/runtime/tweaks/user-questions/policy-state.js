"use strict";

const PERSISTED_ATOMS_KEY = "electron-persisted-atom-state";
const AGENT_MODES_KEY = "agent-mode-by-host-id";
const THREAD_PERMISSIONS_KEY = "heartbeat-thread-permissions-by-id";

function questionOnlyApprovalPolicy() {
  return {
    granular: {
      sandbox_approval: false,
      rules: false,
      skill_approval: false,
      request_permissions: false,
      mcp_elicitations: true,
    },
  };
}

function migrateGlobalState(value) {
  if (!isRecord(value)) return { changed: false, state: value, repairedThreads: 0 };

  let changed = false;
  let repairedThreads = 0;
  const state = { ...value };
  const originalAtoms = isRecord(value[PERSISTED_ATOMS_KEY]) ? value[PERSISTED_ATOMS_KEY] : {};
  const atoms = { ...originalAtoms };
  const originalModes = isRecord(originalAtoms[AGENT_MODES_KEY]) ? originalAtoms[AGENT_MODES_KEY] : {};
  if (originalModes.local !== "custom") {
    atoms[AGENT_MODES_KEY] = { ...originalModes, local: "custom" };
    changed = true;
  }

  const originalPermissions = isRecord(originalAtoms[THREAD_PERMISSIONS_KEY]) ? originalAtoms[THREAD_PERMISSIONS_KEY] : {};
  let permissions = originalPermissions;
  for (const [threadId, record] of Object.entries(originalPermissions)) {
    if (!isFullAccessNever(record)) continue;
    if (permissions === originalPermissions) permissions = { ...originalPermissions };
    permissions[threadId] = {
      ...record,
      activePermissionProfile: null,
      approvalPolicy: questionOnlyApprovalPolicy(),
      sandboxPolicy: { ...record.sandboxPolicy, type: "dangerFullAccess" },
    };
    repairedThreads += 1;
    changed = true;
  }
  if (permissions !== originalPermissions) atoms[THREAD_PERMISSIONS_KEY] = permissions;
  if (changed) state[PERSISTED_ATOMS_KEY] = atoms;
  return { changed, state: changed ? state : value, repairedThreads };
}

function repairGlobalStateFile(options = {}) {
  const deps = options.deps || nodeDeps();
  const codexHome = options.codexHome || deps.env.CODEX_HOME || deps.path.join(deps.homedir(), ".codex");
  const file = deps.path.join(codexHome, ".codex-global-state.json");
  if (!deps.fs.existsSync(file)) return { changed: false, reason: "missing", file, repairedThreads: 0 };

  let current;
  try {
    current = JSON.parse(deps.fs.readFileSync(file, "utf8"));
  } catch {
    return { changed: false, reason: "invalid", file, repairedThreads: 0 };
  }
  const migration = migrateGlobalState(current);
  if (!migration.changed) return { changed: false, reason: "current", file, repairedThreads: 0 };

  const mode = deps.fs.statSync(file).mode & 0o777;
  const backup = `${file}.before-user-questions-policy-0.4.3`;
  const temporary = `${file}.user-questions-${deps.pid}.tmp`;
  try {
    if (!deps.fs.existsSync(backup)) {
      deps.fs.copyFileSync(file, backup);
      deps.fs.chmodSync(backup, mode);
    }
    deps.fs.writeFileSync(temporary, `${JSON.stringify(migration.state, null, 2)}\n`, { mode });
    deps.fs.renameSync(temporary, file);
    deps.fs.chmodSync(file, mode);
  } catch (error) {
    try { deps.fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return { changed: true, reason: "repaired", file, backup, repairedThreads: migration.repairedThreads };
}

function isFullAccessNever(value) {
  if (!isRecord(value) || !isRecord(value.sandboxPolicy)) return false;
  if (value.sandboxPolicy.type !== "dangerFullAccess") return false;
  return value.approvalPolicy === "never" || value.activePermissionProfile?.id === ":danger-full-access";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodeDeps() {
  return {
    fs: require("node:fs"),
    path: require("node:path"),
    homedir: require("node:os").homedir,
    env: process.env,
    pid: process.pid,
  };
}

module.exports = { migrateGlobalState, questionOnlyApprovalPolicy, repairGlobalStateFile };
