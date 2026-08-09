"use strict";

const {
  clone,
  safeFailure,
  safeId,
  safeText,
} = require("./common");
const {
  bindNativeProjectIdentities,
  normalizeWorkspacePath,
} = require("./state");

const MAX_INVENTORY_ROOTS = 8;
const MAX_INVENTORY_DEPTH = 4;
const MAX_INVENTORY_REPOS = 32;
const MAX_INVENTORY_DIRECTORIES = 2_048;
const MAX_INVENTORY_CONCURRENCY = 3;
const INVENTORY_TOTAL_TIMEOUT_MS = 20_000;
const INVENTORY_COMMAND_TIMEOUT_MS = 3_000;
const INVENTORY_CACHE_TTL_MS = 30_000;
const GITHUB_BRANCH_CACHE_TTL_MS = 60_000;
const INVENTORY_SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", ".cache", ".tmp", "tmp", "coverage", "vendor", ".venv", "venv", "__pycache__",
]);

function createInventoryCoordinator(options = {}) {
  const getState = typeof options.getState === "function" ? options.getState : () => null;
  const getNativeProjects = typeof options.getNativeProjects === "function" ? options.getNativeProjects : () => [];
  const notify = typeof options.notify === "function" ? options.notify : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const inventoryOptions = options.inventoryOptions || {};
  const cache = new Map();
  const active = new Map();

  function startJob(projectId, requestId, kind, run) {
    const existing = active.get(projectId);
    if (existing && existing.requestId === requestId && existing.kind === kind) return existing.promise;
    if (existing) existing.controller.abort("superseded");

    const controller = new AbortController();
    const job = { controller, requestId, kind, promise: null };
    const report = (progress) => {
      const payload = { projectId, requestId, ...progress };
      try { notify(payload); } catch {}
    };
    job.promise = Promise.resolve().then(() => run({ signal: controller.signal, requestId, report })).finally(() => {
      if (active.get(projectId) === job) active.delete(projectId);
    });
    active.set(projectId, job);
    return job.promise;
  }

  async function readLocalInventory(projectId, request, job, progressContext = {}) {
    const cached = cache.get(projectId);
    const current = now();
    if (request.refresh !== true && cached && current - cached.at < INVENTORY_CACHE_TTL_MS) {
      return { ...clone(cached.value), cached: true };
    }
    const value = await readProjectInventory(getState(), projectId, getNativeProjects(), {
      ...inventoryOptions,
      now,
      requestId: job.requestId,
      signal: job.signal,
      onProgress: progressContext.provider
        ? (progress) => job.report({ ...progress, provider: progressContext.provider })
        : job.report,
    });
    if (!job.signal.aborted && value?.ok && value.status !== "cancelled") {
      cache.set(projectId, { at: now(), value: clone(value) });
    }
    return value;
  }

  function get(projectId, request = {}) {
    const id = safeId(projectId);
    const requestId = safeRequestId(request.requestId);
    const existing = active.get(id);
    if (existing && existing.requestId === requestId && existing.kind === "inventory") return existing.promise;
    if (existing) existing.controller.abort("superseded");

    const cached = cache.get(id);
    const current = now();
    if (request.refresh !== true && cached && current - cached.at < INVENTORY_CACHE_TTL_MS) {
      return Promise.resolve({ ...clone(cached.value), cached: true });
    }
    return startJob(id, requestId, "inventory", (job) => readLocalInventory(id, request, job));
  }

  function refreshGitHub(projectId, request = {}, worker) {
    const id = safeId(projectId);
    const requestId = safeRequestId(request.requestId);
    const run = typeof worker === "function" ? worker : async () => safeFailure("github-refresh-unavailable");
    return startJob(id, requestId, "github", async (job) => {
      const local = await readLocalInventory(id, request, job, { provider: "github" });
      if (job.signal.aborted) return cancelledProviderResult(id, now, job.report);
      if (!local?.ok || local.status === "cancelled") return local;
      job.report({ status: "refreshing", phase: "github", provider: "github", completed: 0, total: null });
      const value = await run(local.repositories, {
        signal: job.signal,
        requestId,
        onProgress: job.report,
      });
      if (job.signal.aborted) return cancelledProviderResult(id, now, job.report);
      return value;
    });
  }

  function cancel(projectId, requestId) {
    const id = safeId(projectId);
    const activeJob = active.get(id);
    const expected = safeRequestId(requestId);
    if (!activeJob || (expected !== null && expected !== activeJob.requestId)) {
      return { ok: true, cancelled: false };
    }
    activeJob.controller.abort("cancelled");
    return { ok: true, cancelled: true, requestId: activeJob.requestId || null };
  }

  function clear() {
    for (const job of active.values()) job.controller.abort("cleared");
    active.clear();
    cache.clear();
  }

  function dispose() {
    for (const job of active.values()) job.controller.abort("disposed");
    active.clear();
    cache.clear();
  }

  return { get, refreshGitHub, cancel, clear, dispose };
}

function cancelledProviderResult(projectId, now, report) {
  const result = {
    ok: true,
    status: "cancelled",
    partial: true,
    projectId,
    remotes: [],
    refreshedAt: new Date(now()).toISOString(),
  };
  report({ status: "cancelled", phase: "github", provider: "github", completed: 0, total: 0, partial: true });
  return result;
}

function safeRequestId(value) {
  if (value === undefined || value === null || value === "") return null;
  try { return safeText(String(value), 120); } catch { return null; }
}

function projectInventoryRoots(state, projectId, nativeProjects) {
  const bound = bindNativeProjectIdentities(state, nativeProjects);
  const project = bound?.nodes?.find((node) => node.type === "project" && node.id === projectId);
  if (!project) return null;
  // Native aliases are display evidence, not a durable folder binding. Only a
  // normalized path that was saved on the project may start an inventory scan.
  // This keeps an ambiguous first-run project visibly repairable instead of
  // reporting repository data from an unpersisted candidate path.
  return {
    project,
    roots: project.projectPath ? [project.projectPath] : [],
  };
}

async function readProjectInventory(state, projectId, nativeProjects, options = {}) {
  const resolved = projectInventoryRoots(state, projectId, nativeProjects);
  if (!resolved) return safeFailure("unknown-project");
  if (!resolved.roots.length) return safeFailure("project-unbound");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const totalTimeout = positiveInteger(options.totalTimeoutMs, INVENTORY_TOTAL_TIMEOUT_MS);
  const deadline = startedAt + totalTimeout;
  const signal = options.signal;
  const report = progressReporter(options.onProgress, projectId, options.requestId);
  const isExpired = () => now() >= deadline;
  const isCancelled = () => signal?.aborted === true;
  report({ status: "scanning", phase: "discovering", completed: 0, total: null });

  const discovered = await discoverRepositoryPaths(resolved.roots, {
    ...options,
    deadline,
    isExpired,
    signal,
    onProgress: (progress) => report({ status: "scanning", phase: "discovering", ...progress }),
  });
  const errors = [...discovered.errors];
  const repositories = [];
  const seen = new Set();
  const roots = discovered.repositories;
  report({ status: "scanning", phase: "inspecting", completed: 0, total: roots.length });
  const inspected = await mapBounded(roots, positiveInteger(options.concurrency, MAX_INVENTORY_CONCURRENCY), async (root, index) => {
    if (isCancelled() || isExpired()) return { root, error: isCancelled() ? "inventory-cancelled" : "inventory-timeout" };
    const repo = await inspectRepository(root, {
      ...options,
      deadline,
      isExpired,
      signal,
    });
    report({ status: "scanning", phase: "inspecting", completed: index + 1, total: roots.length });
    return repo;
  }, { signal, isExpired });
  for (const repo of inspected) {
    if (!repo || seen.has(repo.root)) continue;
    seen.add(repo.root);
    repositories.push(repo);
    if (repo.error) errors.push({ root: repo.root, code: repo.error });
  }

  const detectedConnections = await detectProjectConnectionSignals(resolved.roots, repositories, {
    ...options,
    deadline,
    isExpired,
    signal,
  });
  const cancelled = isCancelled();
  const timedOut = isExpired();
  const partial = cancelled || timedOut || discovered.truncated || errors.length > 0;
  const status = cancelled ? "cancelled" : partial ? "partial" : "ready";
  const result = {
    ok: true,
    status,
    partial,
    projectId,
    roots: resolved.roots,
    repositories,
    detectedConnections,
    truncated: discovered.truncated || timedOut,
    errors: errors.slice(0, 64),
    progress: { phase: cancelled ? "cancelled" : "complete", completed: repositories.length, total: roots.length },
    refreshedAt: new Date(now()).toISOString(),
  };
  report({ status, ...result.progress, partial });
  return result;
}

function reportProgress(onProgress, payload) {
  try { onProgress?.(payload); } catch {}
}

function progressReporter(onProgress, projectId, requestId) {
  return (progress) => reportProgress(onProgress, { projectId, requestId: requestId || null, ...progress });
}

async function discoverRepositoryPaths(roots, options = {}) {
  const fs = asyncFs(options.fs);
  const path = options.path || require("node:path");
  const repositories = [];
  const seen = new Set();
  const queue = [];
  const errors = [];
  let truncated = false;
  let visitedDirectories = 0;
  const isCancelled = () => options.signal?.aborted === true;
  const isExpired = () => options.isExpired?.() === true || (options.deadline !== undefined && Date.now() >= options.deadline);
  for (const value of (Array.isArray(roots) ? roots : []).slice(0, MAX_INVENTORY_ROOTS)) {
    try {
      const root = path.resolve(normalizeWorkspacePath(value));
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      queue.push({ path: root, depth: 0 });
    } catch {}
  }

  while (queue.length && !isCancelled() && !isExpired()) {
    const remaining = MAX_INVENTORY_DIRECTORIES - visitedDirectories;
    if (remaining <= 0) { truncated = true; break; }
    const batch = queue.splice(0, Math.min(positiveInteger(options.discoveryConcurrency, MAX_INVENTORY_CONCURRENCY), remaining));
    visitedDirectories += batch.length;
    reportProgress(options.onProgress, { visitedDirectories, repositoryCount: repositories.length });
    const scanned = await Promise.all(batch.map((current) => scanDirectory(current, { fs, path, signal: options.signal, isExpired })));
    for (const result of scanned) {
      if (!result) continue;
      if (result.error) errors.push(result.error);
      if (!result.canonical || seen.has(result.canonical)) continue;
      seen.add(result.canonical);
      if (result.repository) {
        repositories.push(result.path);
        if (repositories.length >= MAX_INVENTORY_REPOS) {
          truncated = queue.length > 0 || scanned.some((item) => item?.children?.length);
          break;
        }
      }
      if (result.children?.length) queue.push(...result.children);
    }
    if (repositories.length >= MAX_INVENTORY_REPOS) break;
  }
  if (queue.length && (isCancelled() || isExpired())) truncated = true;
  return { repositories, truncated, errors, visitedDirectories };
}

async function scanDirectory(current, options) {
  if (options.signal?.aborted || options.isExpired?.()) return null;
  try {
    const stat = await options.fs.lstat(current.path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonical = await options.fs.realpath(current.path);
    let repository = false;
    try {
      const gitStat = await options.fs.lstat(options.path.join(current.path, ".git"));
      repository = !gitStat.isSymbolicLink() && (gitStat.isDirectory() || gitStat.isFile());
    } catch {}
    let children = [];
    if (current.depth < MAX_INVENTORY_DEPTH && !options.signal?.aborted && !options.isExpired?.()) {
      const entries = await options.fs.readdir(current.path, { withFileTypes: true });
      children = entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !INVENTORY_SKIP_DIRS.has(entry.name))
        .map((entry) => ({ path: options.path.join(current.path, entry.name), depth: current.depth + 1 }));
    }
    return { path: current.path, canonical, repository, children };
  } catch (error) {
    return { path: current.path, error: { root: current.path, code: inventoryErrorCode(error) } };
  }
}

async function inspectRepository(root, options = {}) {
  const timeout = positiveInteger(options.commandTimeoutMs, INVENTORY_COMMAND_TIMEOUT_MS);
  const git = async (args) => {
    if (options.signal?.aborted) return cancelledCommand();
    const remaining = remainingMilliseconds(options.deadline, options.now);
    if (remaining !== null && remaining <= 0) return timedOutCommand();
    return gitText(root, args, {
      ...options,
      timeout: remaining === null ? timeout : Math.min(timeout, remaining),
    });
  };
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout?.trim()) return { root, error: commandErrorCode(top) };
  // Keep the process budget global: each repository uses one Git child at a
  // time, while mapBounded caps the number of repositories in flight.
  const head = await git(["rev-parse", "--short=12", "HEAD"]);
  const remotes = await git(["remote", "-v"]);
  const localBranches = await git(["for-each-ref", "--format=%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)", "refs/heads"]);
  const remoteBranches = await git(["for-each-ref", "--format=%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(HEAD)", "refs/remotes"]);
  const worktrees = await git(["worktree", "list", "--porcelain"]);
  const failed = [head, remotes, localBranches, remoteBranches, worktrees].find((result) => result.status !== 0);
  return {
    root: top.stdout.trim(),
    ...(failed ? { error: commandErrorCode(failed) } : {}),
    head: head.status === 0 ? head.stdout.trim() : null,
    remotes: remotes.status === 0 ? parseGitRemotes(remotes.stdout) : [],
    localBranches: localBranches.status === 0 ? parseGitBranches(localBranches.stdout) : [],
    remoteTrackingBranches: remoteBranches.status === 0 ? parseGitBranches(remoteBranches.stdout) : [],
    worktrees: worktrees.status === 0 ? parseGitWorktrees(worktrees.stdout) : [],
  };
}

function gitText(root, args, options = {}) {
  const runCommand = typeof options.runCommand === "function" ? options.runCommand : spawnTextAsync;
  return runCommand("git", ["-C", root, ...args], {
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
    signal: options.signal,
    env: { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", NO_COLOR: "1" },
  });
}

function parseGitRemotes(text) {
  const byName = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) continue;
    const existing = byName.get(match[1]) || { name: match[1], fetchUrl: null, pushUrl: null };
    existing[`${match[3]}Url`] = match[2];
    byName.set(match[1], existing);
  }
  return [...byName.values()];
}

function parseGitRemoteUrl(value) {
  const text = String(value || "").trim();
  let match = /^(?:git@|ssh:\/\/git@)([^/:]+)[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(text);
  if (!match) match = /^https?:\/\/([^/]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);
  if (!match) return null;
  return { host: match[1].toLowerCase(), slug: match[2].replace(/\.git$/i, "") };
}

function parseGitBranches(text) {
  return String(text || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [name = "", sha = "", upstream = "", head = ""] = line.split("\0");
    return { name, sha, upstream: upstream || null, current: head === "*" };
  }).filter((branch) => branch.name);
}

function parseGitWorktrees(text) {
  const worktrees = [];
  let current = null;
  for (const line of `${String(text || "").trimEnd()}\n\n`.split(/\r?\n/)) {
    if (!line) {
      if (current?.path) worktrees.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? true : line.slice(space + 1);
    if (key === "worktree") current = { path: value, branch: null, head: null, detached: false, locked: false, prunable: false };
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = String(value).replace(/^refs\/heads\//, "");
    else if (current && key === "detached") current.detached = true;
    else if (current && key === "locked") current.locked = value === true ? true : value;
    else if (current && key === "prunable") current.prunable = value === true ? true : value;
  }
  return worktrees;
}

async function detectProjectConnectionSignals(roots, repositories = [], options = {}) {
  const path = options.path || require("node:path");
  const signals = new Map();
  const add = (type, label, detail) => {
    const key = `${type}\0${label}\0${detail || ""}`;
    if (!signals.has(key)) signals.set(key, { type, label, detail: detail || null });
  };
  for (const repo of repositories) {
    for (const remote of repo.remotes || []) {
      const parsed = parseGitRemoteUrl(remote.fetchUrl || remote.pushUrl);
      if (parsed) add("github", remote.name, `${parsed.host}/${parsed.slug}`);
    }
  }
  const candidates = [...new Set([...(roots || []), ...repositories.map((repo) => repo.root)])].slice(0, MAX_INVENTORY_REPOS);
  const records = await mapBounded(candidates, positiveInteger(options.markerConcurrency, MAX_INVENTORY_CONCURRENCY), async (root) => {
    if (options.signal?.aborted || options.isExpired?.()) return [];
    return inspectConnectionMarkers(root, path, options);
  }, { signal: options.signal, isExpired: options.isExpired });
  for (const signalsForRoot of records) {
    if (!Array.isArray(signalsForRoot)) continue;
    for (const signal of signalsForRoot) add(signal.type, signal.label, signal.detail);
  }
  return [...signals.values()];
}

async function inspectConnectionMarkers(root, path, options) {
  const signals = [];
  const fs = asyncFs(options.fs);
  try {
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return signals;
  } catch {
    return signals;
  }
  const supabase = await readBoundedProjectFile(path.join(root, "supabase", "config.toml"), options);
  const projectId = supabase?.match(/^\s*project_id\s*=\s*["']([^"']{1,160})["']/m)?.[1];
  if (supabase !== null) signals.push({ type: "supabase", label: "Supabase", detail: projectId || "supabase/config.toml" });
  const vercelProject = await readBoundedProjectFile(path.join(root, ".vercel", "project.json"), options);
  if (vercelProject) {
    try {
      const value = JSON.parse(vercelProject);
      const detail = [value.orgId, value.projectId].filter((item) => typeof item === "string").join(" / ") || ".vercel/project.json";
      signals.push({ type: "vercel", label: "Vercel", detail });
    } catch { signals.push({ type: "vercel", label: "Vercel", detail: ".vercel/project.json" }); }
  } else if (await readBoundedProjectFile(path.join(root, "vercel.json"), options) !== null) {
    signals.push({ type: "vercel", label: "Vercel", detail: "vercel.json" });
  }
  let entries = [];
  try { entries = (await fs.readdir(root, { withFileTypes: true })).slice(0, 256); } catch {}
  for (const entry of entries.filter((item) => item.isFile() && /^modal[^/]*\.py$/i.test(item.name)).slice(0, 8)) {
    const text = await readBoundedProjectFile(path.join(root, entry.name), options);
    const appName = text?.match(/(?:modal\.)?App\(\s*["']([^"']{1,120})["']/)?.[1];
    if (text?.includes("modal.App") || /from\s+modal\s+import/.test(text)) signals.push({ type: "modal", label: "Modal", detail: appName || entry.name });
  }
  return signals;
}

async function readBoundedProjectFile(file, options = {}) {
  const fs = asyncFs(options.fs);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) return null;
    return await fs.readFile(file, "utf8");
  } catch { return null; }
}

async function refreshGitHubBranches(state, githubRefs, cache, projectId, repositories, options = {}) {
  const project = state.nodes.find((node) => node.type === "project" && node.id === projectId);
  if (!project) return safeFailure("unknown-project");
  const identity = githubRefs.get(project.connections.github);
  const remotes = collectGitHubRemotes(project, repositories);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const report = (progress) => reportProgress(options.onProgress, { provider: "github", ...progress });
  const cancelled = () => {
    const result = { ok: true, status: "cancelled", partial: true, remotes: [], refreshedAt: new Date(now()).toISOString() };
    report({ status: "cancelled", phase: "github", completed: 0, total: remotes.length, partial: true });
    return result;
  };
  if (!remotes.length) {
    const result = { ok: true, status: "ready", partial: false, remotes: [], refreshedAt: new Date(now()).toISOString() };
    report({ status: "ready", phase: "github", completed: 0, total: 0, partial: false });
    return result;
  }
  if (!identity) return safeFailure("github-identity-unavailable");
  if (options.signal?.aborted) return cancelled();
  const runCommand = typeof options.runCommand === "function" ? options.runCommand : spawnTextAsync;
  const totalTimeout = positiveInteger(options.totalTimeoutMs, INVENTORY_TOTAL_TIMEOUT_MS);
  const deadline = now() + totalTimeout;
  const baseEnv = { HOME: process.env.HOME || "", PATH: process.env.PATH || "/usr/bin:/bin", NO_COLOR: "1" };
  report({ status: "refreshing", phase: "github-auth", completed: 0, total: remotes.length });
  const tokenResult = await runCommand("gh", ["auth", "token", "--hostname", identity.host, "--user", identity.login], {
    timeout: Math.min(INVENTORY_COMMAND_TIMEOUT_MS, totalTimeout),
    maxBuffer: 32 * 1024,
    signal: options.signal,
    env: baseEnv,
  });
  if (options.signal?.aborted) {
    tokenResult.stdout = "";
    return cancelled();
  }
  if (tokenResult.status !== 0 || !tokenResult.stdout?.trim()) {
    tokenResult.stdout = "";
    return safeFailure("github-token-unavailable");
  }
  let token = tokenResult.stdout.trim();
  const isExpired = () => now() >= deadline;
  let completed = 0;
  try {
    const values = await mapBounded(remotes, positiveInteger(options.concurrency, MAX_INVENTORY_CONCURRENCY), async (remote) => {
      const remoteLabel = providerRemoteLabel(remote);
      report({ status: "refreshing", phase: "github", remote: remoteLabel, completed, total: remotes.length });
      let value;
      if (options.signal?.aborted) value = { ...remote, error: "github-refresh-cancelled", branches: [] };
      else if (remote.host !== identity.host) value = { ...remote, error: "github-identity-host-mismatch", branches: [] };
      else {
        const key = `${projectId}:${remote.host}:${remote.slug}`;
        const cached = cache.get(key);
        if (cached && now() - cached.at < GITHUB_BRANCH_CACHE_TTL_MS) value = { ...cached.value, cached: true };
        else if (isExpired()) value = { ...remote, error: "github-refresh-timeout", branches: [] };
        else {
          const remaining = Math.max(1, deadline - now());
          const env = { ...baseEnv, GH_TOKEN: token, GH_HOST: identity.host };
          let response;
          try {
            response = await runCommand("gh", ["api", "--paginate", "--slurp", `repos/${remote.slug}/branches`], {
              timeout: Math.min(INVENTORY_COMMAND_TIMEOUT_MS, remaining),
              maxBuffer: 1024 * 1024,
              signal: options.signal,
              env,
            });
          } catch (error) {
            response = { status: null, error, stdout: "", stderr: "" };
          } finally {
            env.GH_TOKEN = "";
          }
          value = parseGitHubBranches(remote, response, now);
          if (!value.error && !options.signal?.aborted) cache.set(key, { at: now(), value: clone(value) });
        }
      }
      completed += 1;
      report({ status: "refreshing", phase: "github", remote: remoteLabel, completed, total: remotes.length });
      return value;
    }, { signal: options.signal, isExpired });
    if (options.signal?.aborted) return cancelled();
    const partial = values.some((value) => value.error) || isExpired();
    const result = {
      ok: true,
      status: partial ? "partial" : "ready",
      partial,
      remotes: values,
      refreshedAt: new Date(now()).toISOString(),
    };
    report({ status: result.status, phase: "github", completed: values.length, total: remotes.length, partial });
    return result;
  } finally {
    tokenResult.stdout = "";
    token = "";
  }
}

function providerRemoteLabel(remote) {
  try { return safeText(`${remote.host}/${remote.slug}`, 360); }
  catch { return "remote"; }
}

function collectGitHubRemotes(project, repositories) {
  const byKey = new Map();
  for (const repo of repositories || []) {
    for (const remote of repo.remotes || []) {
      const parsed = parseGitRemoteUrl(remote.fetchUrl || remote.pushUrl);
      if (parsed) byKey.set(`${parsed.host}\0${parsed.slug}`, parsed);
    }
  }
  if (project.githubRepo) byKey.set(`github.com\0${project.githubRepo}`, { host: "github.com", slug: project.githubRepo });
  return [...byKey.values()];
}

function parseGitHubBranches(remote, response, now) {
  if (!response || response.status !== 0) {
    const error = response?.error?.code === "ABORT_ERR"
      ? "github-refresh-cancelled"
      : response?.error?.code === "ETIMEDOUT"
        ? "github-refresh-timeout"
        : "github-command-failed";
    return { ...remote, branches: [], error };
  }
  try {
    const pages = JSON.parse(response.stdout);
    const branches = (Array.isArray(pages) ? pages.flat() : []).slice(0, 500).map((branch) => {
      try {
        return {
          name: safeText(branch.name, 255),
          sha: typeof branch.commit?.sha === "string" ? branch.commit.sha.slice(0, 40) : null,
          protected: branch.protected === true,
        };
      } catch { return null; }
    }).filter(Boolean);
    return { ...remote, branches, refreshedAt: new Date(now()).toISOString() };
  } catch {
    return { ...remote, branches: [], error: "github-response-invalid" };
  }
}

async function mapBounded(items, concurrency, worker, options = {}) {
  const values = Array.isArray(items) ? items : [];
  const results = new Array(values.length);
  let cursor = 0;
  const count = Math.min(values.length, positiveInteger(concurrency, MAX_INVENTORY_CONCURRENCY));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      if (options.signal?.aborted || options.isExpired?.()) return;
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try { results[index] = await worker(values[index], index); }
      catch (error) { results[index] = { root: values[index], error: inventoryErrorCode(error) }; }
    }
  }));
  return results.filter(Boolean);
}

function asyncFs(value) {
  if (value?.promises) return value.promises;
  return value || require("node:fs").promises;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function remainingMilliseconds(deadline, now = Date.now) {
  return Number.isFinite(deadline) ? deadline - now() : null;
}

function cancelledCommand() {
  return { status: null, error: { code: "ABORT_ERR" }, stdout: "", stderr: "" };
}

function timedOutCommand() {
  return { status: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
}

function commandErrorCode(result) {
  if (result?.error?.code === "ABORT_ERR") return "inventory-cancelled";
  if (result?.error?.code === "ETIMEDOUT") return "inventory-timeout";
  if (result?.error?.code === "ENOBUFS") return "inventory-output-limit";
  return "git-unavailable";
}

function inventoryErrorCode(error) {
  if (error?.code === "ABORT_ERR") return "inventory-cancelled";
  if (error?.code === "ETIMEDOUT") return "inventory-timeout";
  return "inventory-read-failed";
}

function spawnTextAsync(command, args, options = {}) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let child;
    const maxBuffer = options.maxBuffer || 1024 * 1024;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onAbort);
    };
    const done = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const kill = () => { try { child?.kill("SIGKILL"); } catch {} };
    const onAbort = () => { kill(); done(cancelledCommand()); };
    if (options.signal?.aborted) return void done(cancelledCommand());
    try { child = spawn(command, args, { env: options.env }); }
    catch (error) { return void done({ status: null, error, stdout, stderr }); }
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
    if (options.timeout) timer = setTimeout(() => { kill(); done(timedOutCommand()); }, options.timeout);
    child.on("error", (error) => done({ status: null, error, stdout, stderr }));
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) { kill(); done({ status: null, error: { code: "ENOBUFS" }, stdout, stderr }); }
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < maxBuffer) stderr += chunk;
    });
    child.on("close", (code) => done({ status: code, error: null, stdout, stderr }));
  });
}

module.exports = {
  MAX_INVENTORY_DEPTH,
  MAX_INVENTORY_REPOS,
  MAX_INVENTORY_CONCURRENCY,
  INVENTORY_TOTAL_TIMEOUT_MS,
  INVENTORY_COMMAND_TIMEOUT_MS,
  createInventoryCoordinator,
  projectInventoryRoots,
  discoverRepositoryPaths,
  inspectRepository,
  readProjectInventory,
  refreshGitHubBranches,
  parseGitRemotes,
  parseGitRemoteUrl,
  parseGitWorktrees,
  detectProjectConnectionSignals,
  mapBounded,
  spawnTextAsync,
};
