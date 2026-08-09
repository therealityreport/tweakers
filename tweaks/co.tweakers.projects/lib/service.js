"use strict";

const {
  clone,
  errorCode,
  maskLabel,
  redact,
  replaceObject,
  safeFailure,
  scrub,
} = require("./common");
const {
  CONNECTION_TYPES,
  createLegacyProjectColorMigration,
  createSecureProjectStore,
  mergeLegacyAssignments,
  mergeLegacyProjectColors,
  readLegacyProjectColorPreferences,
  readNativeLocalProjects,
} = require("./state");
const {
  revisionForState,
  readFollowupPolicyProjection,
  readProfilesProjection,
} = require("./policy");
const {
  createInventoryCoordinator,
  refreshGitHubBranches,
  spawnTextAsync,
} = require("./inventory");

function createProjectService(api, dependencies = {}) {
  const store = createSecureProjectStore(api.fs.dataDir);
  const loaded = store.read();
  const legacyMigration = createLegacyProjectColorMigration(api.fs.dataDir);
  const legacyColors = legacyMigration.isComplete()
    ? { found: false, preferences: {} }
    : readLegacyProjectColorPreferences(api.fs.dataDir);
  const imported = mergeLegacyProjectColors(loaded.state, legacyColors.preferences);
  const state = imported.state;
  if (imported.changed) store.write(state);
  if (legacyColors.found && state.nodes.some((node) => node.type === "project")) legacyMigration.complete();

  const now = typeof dependencies.now === "function" ? dependencies.now : Date.now;
  const readNative = typeof dependencies.readNativeLocalProjects === "function"
    ? dependencies.readNativeLocalProjects
    : readNativeLocalProjects;
  const githubRefs = dependencies.githubRefs instanceof Map ? dependencies.githubRefs : new Map();
  const githubBranchesCache = new Map();
  const inventory = createInventoryCoordinator({
    getState: () => state,
    getNativeProjects: readNative,
    now,
    inventoryOptions: dependencies.inventoryOptions,
    notify: (payload) => api.ipc.send?.("inventory.progress", payload),
  });
  let storageStatus = loaded.status;
  let disposed = false;
  let connectionsCache = null;
  let connectionsCacheAt = 0;
  const connectionsTtlMs = 30_000;
  const detect = typeof dependencies.detectConnections === "function" ? dependencies.detectConnections : detectConnections;

  async function getConnections(force) {
    if (!force && connectionsCache && now() - connectionsCacheAt < connectionsTtlMs) return connectionsCache;
    connectionsCache = await detect(githubRefs, {
      ...dependencies.connectionOptions,
      ...(typeof dependencies.runCommand === "function" ? { runCommand: dependencies.runCommand } : {}),
    });
    connectionsCacheAt = now();
    return connectionsCache;
  }

  function save(next) {
    store.write(next);
    replaceObject(state, next);
    inventory.clear();
    githubBranchesCache.clear();
    storageStatus = "ok";
    const revision = revisionForState(state);
    api.ipc.send?.("revision", { revision });
    return { ok: true, state: clone(state), revision };
  }

  return {
    async handle(message) {
      if (disposed) return safeFailure("unavailable");
      try {
        switch (message?.action) {
          case "get": {
            const publicState = require("./state").normalizeState(state);
            return {
              ok: true,
              state: clone(publicState),
              revision: revisionForState(publicState),
              storageStatus,
              nativeProjects: readNative(),
              connections: await getConnections(message?.refreshConnections === true),
            };
          }
          case "save": {
            const { normalizeState } = require("./state");
            const next = normalizeState(message.state);
            if (message.baseRevision !== undefined && message.baseRevision !== null && message.baseRevision !== revisionForState(state)) {
              return safeFailure("stale-revision");
            }
            return save(next);
          }
          case "profiles.read":
            return readProfilesProjection(state, message);
          case "followup.policy.read":
            return readFollowupPolicyProjection(state, message);
          case "github.run":
            return runGitHubForProject(state, githubRefs, message.projectId, message.argv, dependencies.runCommand);
          case "inventory.get":
            return clone(await inventory.get(message.projectId, { refresh: message.refresh === true, requestId: message.requestId }));
          case "inventory.cancel":
            return inventory.cancel(message.projectId, message.requestId);
          case "inventory.refresh-github": {
            const projectId = require("./common").safeId(message.projectId);
            return inventory.refreshGitHub(projectId, {
              refresh: message.refresh === true,
              requestId: message.requestId,
            }, (repositories, job) => refreshGitHubBranches(state, githubRefs, githubBranchesCache, projectId, repositories, {
              ...dependencies.inventoryOptions,
              now,
              runCommand: dependencies.runCommand,
              signal: job.signal,
              requestId: job.requestId,
              onProgress: job.onProgress,
            }));
          }
          case "migrate-legacy":
            return save(mergeLegacyAssignments(state, message.legacy));
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
      return runGitHubForProject(state, githubRefs, projectId, argv, dependencies.runCommand);
    },
    dispose() {
      disposed = true;
      githubRefs.clear();
      githubBranchesCache.clear();
      inventory.dispose();
    },
  };
}

function adapterProbePaths(home, join, platform) {
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

async function detectConnections(githubRefs, options = {}) {
  const fs = options.fs || require("node:fs");
  const { createHash } = require("node:crypto");
  const { homedir, platform } = require("node:os");
  const { join } = require("node:path");
  const runCommand = typeof options.runCommand === "function" ? options.runCommand : spawnTextAsync;
  const result = Object.fromEntries(CONNECTION_TYPES.map((type) => [type, { status: "unconfigured", refs: [] }]));
  const nextRefs = new Map();
  try {
    const gh = await runCommand("gh", ["auth", "status", "--json", "hosts"], { timeout: 5_000, maxBuffer: 256 * 1024 });
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
    modal: fs.existsSync(probe.modal),
    google: fs.existsSync(probe.gcloudDir),
    "google-workspace": fs.existsSync(probe.gcloudAdc),
    supabase: fs.existsSync(probe.supabase),
    environment: true,
  };
  for (const [type, configured] of Object.entries(adapters)) {
    result[type] = configured
      ? { status: "configured", refs: [{ id: `${type}:default`, label: type === "environment" ? "Local environment" : "Default local configuration" }] }
      : { status: "unconfigured", refs: [] };
  }
  result.chrome = fs.existsSync(probe.chromeState) ? { status: "available", refs: [] } : { status: "unconfigured", refs: [] };
  return redact(result);
}

async function runGitHubForProject(state, githubRefs, projectId, rawArgv, runner) {
  const project = state.nodes.find((node) => node.type === "project" && node.id === projectId);
  if (!project) return safeFailure("unknown-project");
  if (!project.githubRepo) return safeFailure("github-repository-unconfigured");
  const identity = githubRefs.get(project.connections.github);
  if (!identity) return safeFailure("github-identity-unavailable");
  let argv;
  try { argv = normalizeGitHubArgs(rawArgv); } catch (error) { return safeFailure(errorCode(error)); }
  const runCommand = typeof runner === "function" ? runner : spawnTextAsync;
  const baseEnv = { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", NO_COLOR: "1" };
  const tokenResult = await runCommand("gh", ["auth", "token", "--hostname", identity.host, "--user", identity.login], {
    timeout: 5_000,
    maxBuffer: 32 * 1024,
    env: baseEnv,
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
  const result = await runCommand("gh", argv, { timeout: 15_000, maxBuffer: 256 * 1024, env });
  env.GH_TOKEN = "";
  tokenResult.stdout = "";
  if (result.error) return safeFailure(result.error.code === "ETIMEDOUT" ? "github-timeout" : "github-command-failed");
  return redact({ ok: result.status === 0, code: result.status ?? 1, stdout: scrub(result.stdout, token), stderr: scrub(result.stderr, token) });
}

function normalizeGitHubArgs(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 20) throw require("./common").coded("invalid-github-command");
  const allowed = {
    repo: new Set(["list", "view"]), pr: new Set(["checks", "diff", "list", "status", "view"]),
    issue: new Set(["list", "status", "view"]), release: new Set(["list", "view"]),
    run: new Set(["list", "view", "watch"]), workflow: new Set(["list", "view"]),
  };
  const out = argv.map((arg) => {
    if (typeof arg !== "string" || arg.length > 200 || /[\0\r\n;&|`$<>]/.test(arg)) throw require("./common").coded("invalid-github-command");
    return arg;
  });
  if (!allowed[out[0]]?.has(out[1])) throw require("./common").coded("github-command-denied");
  if (out.some((arg) => ["--input", "--hostname", "--user", "--repo", "-R"].includes(arg))) throw require("./common").coded("github-command-denied");
  return out;
}

module.exports = {
  createProjectService,
  adapterProbePaths,
  detectConnections,
  normalizeGitHubArgs,
  runGitHubForProject,
};
