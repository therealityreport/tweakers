"use strict";

const IPC = "developer-tools";
const SERVICE = "__tweakersDeveloperToolsServiceV1";
const HANDLER = "__tweakersDeveloperToolsHandlerV1";
const SCHEMA_VERSION = 2;
const REPO = "https://github.com/openai/codex.git";
const SECRET = /(token|secret|password|credential|api[_-]?key|authorization|cookie)/i;
const BACKUP_HISTORY_LIMIT = 10;
const BACKUP_PREVIEW_BYTES = 12 * 1024;
const BACKUP_LABEL = "Configuration backup";
const BACKUP_ID = /^[a-f0-9]{32}$/;
const SOURCE_REPOSITORY_LIMIT = 1;
const SOURCE_FILE_LIMIT = 300;
const SOURCE_DIRECTORY_LIMIT = 120;
const SOURCE_ENTRY_LIMIT = 2_000;
const SOURCE_ENTRY_YIELD_INTERVAL = 32;
const SOURCE_FILE_BYTES_LIMIT = 64 * 1024;
const SOURCE_CAPABILITY_LIMIT = 400;
const SOURCE_SCAN_TOTAL_TIMEOUT_MS = 7_500;
const SOURCE_DISCOVERY_TOTAL_TIMEOUT_MS = 30_000;
const SOURCE_GIT_TIMEOUT_MS = 20_000;
const SOURCE_STATUS_TIMEOUT_MS = 3_000;
const SOURCE_JOB_HISTORY_LIMIT = 6;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

module.exports = {
  start(api) { return api.process === "main" ? startMain(api) : startRenderer(api); },
  stop() {
    if (typeof window === "undefined") {
      globalThis[SERVICE]?.dispose?.();
      globalThis[SERVICE] = null;
      const off = globalThis[HANDLER]; if (typeof off === "function") off();
      globalThis[HANDLER] = null;
    }
    this._page?.unregister?.(); this._page = null;
  },
  _test: {
    parseConfig,
    scanConfig,
    scanSourceBounded,
    mergeCapabilities,
    setTomlValue,
    redact,
    redactConfigPreview,
    createService,
    startMain,
  },
};

function startMain(api, dependencies) {
  const service = createService(api, dependencies);
  globalThis[SERVICE] = service;
  if (typeof api.ipc?.handleWithContext !== "function") {
    service.dispose();
    api.log.error("Developer Tools requires sender-validated IPC support");
    return;
  }
  if (!globalThis[HANDLER]) {
    globalThis[HANDLER] = api.ipc.handleWithContext(IPC, (context, message) => {
      if (!context?.sender || !Number.isSafeInteger(context.sender.webContentsId)) {
        return fail("unauthorized-sender");
      }
      return globalThis[SERVICE]?.handle(message, context) || fail("unavailable");
    });
  }
  api.log.info("Developer Tools service ready");
}

function createService(api, dependencies = {}) {
  const fs = dependencies.fs || require("node:fs");
  const fsPromises = dependencies.fsPromises || require("node:fs/promises");
  const path = dependencies.path || require("node:path");
  const os = dependencies.os || require("node:os");
  const crypto = dependencies.crypto || require("node:crypto");
  const cp = dependencies.cp || require("node:child_process");
  const now = dependencies.now || (() => Date.now());
  const dataDir = dependencies.dataDir || api.fs.dataDir;
  const configPath = dependencies.configPath || path.join(os.homedir(), ".codex", "config.toml");
  const modelPath = dependencies.modelPath || discoverModelPath(fs, path, configPath);
  const checkout = dependencies.checkout || path.join(dataDir, "openai-codex-source");
  const cachePath = dependencies.cachePath || path.join(dataDir, "snapshot.json");
  const backupDir = dependencies.backupDir || path.join(dataDir, "backups");
  const cached = readJson(fs, cachePath);
  let sourceCapabilities = Array.isArray(cached?.capabilities)
    ? cached.capabilities.filter((item) => item?.category === "Source Evidence")
    : [];
  let disposed = false;
  let activeSourceJobId = null;
  const sourceJobs = new Map();

  function revision(contents) { return crypto.createHash("sha256").update(contents).digest("hex").slice(0, 24); }
  function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } }
  function backupId() { return crypto.randomBytes(16).toString("hex"); }

  async function sourceStatus() {
    const exists = fs.existsSync(path.join(checkout, ".git"));
    let commit = null;
    if (exists) {
      try { commit = await runGit(cp, ["-C", checkout, "rev-parse", "HEAD"], { timeoutMs: SOURCE_STATUS_TIMEOUT_MS }); } catch {}
    }
    return {
      repository: REPO,
      path: checkout,
      exists,
      commit,
      scannerSchemaVersion: SCHEMA_VERSION,
      budgets: sourceBudgets(),
    };
  }

  async function snapshot() {
    const warnings = [];
    try {
      const config = readText(configPath);
      const caps = scanConfig(config, configPath);
      caps.push(...scanModels(readText(modelPath), modelPath));
      caps.push(...sourceCapabilities);
      caps.push(...runtimeCapabilities(api));
      const value = {
        schemaVersion: SCHEMA_VERSION,
        scannedAt: new Date(now()).toISOString(),
        revision: revision(config),
        stale: false,
        source: await sourceStatus(),
        sourceDiscovery: activeSourceJobId ? sourceJobSummary(sourceJobs.get(activeSourceJobId), false) : null,
        capabilities: mergeCapabilities(caps),
        warnings,
      };
      try {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(cachePath, JSON.stringify(value, null, 2), { mode: 0o600 });
        fs.chmodSync(cachePath, 0o600);
      } catch (error) {
        warnings.push(`Snapshot cache could not be updated: ${safeError(error)}`);
      }
      return value;
    } catch (error) {
      const cachedSnapshot = readJson(fs, cachePath);
      if (cachedSnapshot) return { ...cachedSnapshot, stale: true, warnings: [...(cachedSnapshot.warnings || []), `Refresh failed: ${safeError(error)}`] };
      throw error;
    }
  }

  function ensurePrivateBackupDirectory() {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const entry = fs.lstatSync(backupDir);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("backup directory is not a private directory");
    fs.chmodSync(backupDir, 0o700);
    const stat = fs.statSync(backupDir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error("backup directory privacy check failed");
  }

  function backupFile(id) {
    if (!isBackupId(id)) throw new Error("invalid-backup");
    const root = path.resolve(backupDir);
    const candidate = path.resolve(root, `${id}.json`);
    if (path.dirname(candidate) !== root || path.basename(candidate) !== `${id}.json`) throw new Error("invalid-backup");
    return candidate;
  }

  function ensurePrivateBackupFile(file) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("backup is not a regular file");
    fs.chmodSync(file, 0o600);
    if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error("backup file privacy check failed");
  }

  function writePrivateJson(file, value) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function backup(file, contents) {
    ensurePrivateBackupDirectory();
    const id = backupId();
    writePrivateJson(backupFile(id), { id, file, contents, createdAt: new Date(now()).toISOString(), label: BACKUP_LABEL });
    pruneBackups();
    return id;
  }

  function listBackupRecords() {
    ensurePrivateBackupDirectory();
    let entries = [];
    try { entries = fs.readdirSync(backupDir, { withFileTypes: true }); } catch { return []; }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -5);
      if (!isBackupId(id)) continue;
      const file = backupFile(id);
      let record = null;
      try {
        ensurePrivateBackupFile(file);
        record = readJson(fs, file);
      } catch { continue; }
      if (!isBackupRecord(record, id, configPath)) continue;
      records.push(record);
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  function backupList() {
    return listBackupRecords().map((record) => ({ id: record.id, label: BACKUP_LABEL, createdAt: record.createdAt }));
  }

  function pruneBackups() {
    const expired = listBackupRecords().slice(BACKUP_HISTORY_LIMIT);
    for (const record of expired) {
      try { fs.unlinkSync(backupFile(record.id)); } catch {}
    }
  }

  function findBackup(id) {
    if (!isBackupId(id)) return null;
    return listBackupRecords().find((record) => record.id === id) || null;
  }

  function previewBackup(id) {
    const record = findBackup(id);
    if (!record) return fail("invalid-backup");
    return { ok: true, backup: { id: record.id, label: BACKUP_LABEL, createdAt: record.createdAt, ...redactConfigPreview(record.contents) } };
  }

  function atomicWrite(file, contents) {
    const temporary = `${file}.developer-tools-${process.pid}.tmp`;
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  function mutate(message) {
    const current = readText(configPath); const currentRevision = revision(current);
    if (message.expectedRevision !== currentRevision) return fail("stale-revision");
    const cap = scanConfig(current, configPath).find((item) => item.id === message.id);
    if (!cap || cap.control.method !== "config") return fail("unsupported");
    if (cap.risk !== "ordinary" && message.confirmed !== true) return fail("confirmation-required");
    const next = setTomlValue(current, cap.control.section, cap.control.key, message.enabled);
    const backupIdValue = backup(configPath, current);
    try {
      atomicWrite(configPath, next);
      const parsed = parseConfig(readText(configPath));
      if (parsed[cap.control.section]?.[cap.control.key] !== message.enabled) throw new Error("write-validation-failed");
      return { ok: true, capability: scanConfig(next, configPath).find((item) => item.id === message.id), revision: revision(next), backupId: backupIdValue, restart: cap.restart };
    } catch (error) {
      atomicWrite(configPath, current);
      return fail("write-failed", safeError(error));
    }
  }

  function rollback(id, confirmed) {
    if (confirmed !== true) return fail("confirmation-required");
    const record = findBackup(id); if (!record) return fail("invalid-backup");
    const backupIdValue = backup(configPath, readText(configPath));
    try {
      atomicWrite(configPath, record.contents);
      return { ok: true, revision: revision(record.contents), backupId: backupIdValue };
    } catch (error) {
      return fail("write-failed", safeError(error));
    }
  }

  function deleteBackup(id, confirmed) {
    if (confirmed !== true) return fail("confirmation-required");
    const record = findBackup(id); if (!record) return fail("invalid-backup");
    try {
      fs.unlinkSync(backupFile(record.id));
      return { ok: true, deleted: record.id };
    } catch (error) {
      return fail("delete-failed", safeError(error));
    }
  }

  async function refreshSourceCheckout(job) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    job.progress = { ...job.progress, phase: "updating", repositoriesScanned: SOURCE_REPOSITORY_LIMIT };
    if (!fs.existsSync(path.join(checkout, ".git"))) {
      const staging = `${checkout}.staging-${job.id}`;
      try {
        await runGit(cp, ["clone", "--depth", "1", "--filter=blob:none", REPO, staging], { signal: job.controller.signal, timeoutMs: sourceJobTimeout(job) });
        if (job.controller.signal.aborted) throw abortError();
        fs.renameSync(staging, checkout);
      } catch (error) {
        try { await fsPromises.rm(staging, { recursive: true, force: true }); } catch {}
        throw error;
      }
      return;
    }
    await runGit(cp, ["-C", checkout, "fetch", "--depth", "1", "origin", "main"], { signal: job.controller.signal, timeoutMs: sourceJobTimeout(job) });
    if (job.controller.signal.aborted) throw abortError();
    await runGit(cp, ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"], { signal: job.controller.signal, timeoutMs: sourceJobTimeout(job) });
  }

  async function runSourceJob(job) {
    job.status = "running";
    job.startedAt = new Date(now()).toISOString();
    job.deadlineAt = Date.now() + SOURCE_DISCOVERY_TOTAL_TIMEOUT_MS;
    job.progress = { ...job.progress, phase: job.refreshSource ? "updating" : "scanning" };
    try {
      if (job.refreshSource) await refreshSourceCheckout(job);
      if (job.controller.signal.aborted) throw abortError();
      const result = await scanSourceBounded(fsPromises, path, checkout, {
        signal: job.controller.signal,
        fileLimit: SOURCE_FILE_LIMIT,
        directoryLimit: SOURCE_DIRECTORY_LIMIT,
        fileBytesLimit: SOURCE_FILE_BYTES_LIMIT,
        capabilityLimit: SOURCE_CAPABILITY_LIMIT,
        deadlineMs: Math.min(SOURCE_SCAN_TOTAL_TIMEOUT_MS, sourceJobTimeout(job)),
        onProgress: (progress) => {
          job.progress = { ...job.progress, ...progress, repositoriesScanned: SOURCE_REPOSITORY_LIMIT };
          job.capabilities = progress.capabilities;
        },
      });
      job.capabilities = result.capabilities;
      job.progress = { ...job.progress, ...result.progress, repositoriesScanned: SOURCE_REPOSITORY_LIMIT };
      job.warnings = result.warnings;
      job.result = result.status;
      job.status = result.status === "cancelled" ? "cancelled" : "completed";
      if (job.status === "completed") {
        sourceCapabilities = result.capabilities;
      }
    } catch (error) {
      if (isDiscoveryBudgetError(error)) {
        job.status = "completed";
        job.result = "budget-exhausted";
        job.warnings = [...job.warnings, "Source discovery reached its total time budget; partial results are shown."];
      } else if (isAbortError(error) || job.controller.signal.aborted) {
        job.status = "cancelled";
        job.result = "cancelled";
      } else {
        job.status = "failed";
        job.error = safeError(error);
      }
    } finally {
      job.finishedAt = new Date(now()).toISOString();
      if (activeSourceJobId === job.id) activeSourceJobId = null;
    }
  }

  function startSourceDiscovery(message) {
    if (!validStartSourceRequest(message)) return fail("invalid-request");
    const active = activeSourceJobId ? sourceJobs.get(activeSourceJobId) : null;
    if (active && ["queued", "running", "cancelling"].includes(active.status)) return fail("source-discovery-running", active.id);
    const job = {
      id: message.requestId,
      refreshSource: message.refreshSource,
      status: "queued",
      result: null,
      warnings: [],
      error: null,
      capabilities: [],
      controller: new AbortController(),
      createdAt: new Date(now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      deadlineAt: null,
      progress: {
        phase: "queued",
        repositoriesScanned: 0,
        repositoryLimit: SOURCE_REPOSITORY_LIMIT,
        directoriesScanned: 0,
        directoryLimit: SOURCE_DIRECTORY_LIMIT,
        entriesVisited: 0,
        entryLimit: SOURCE_ENTRY_LIMIT,
        filesScanned: 0,
        fileLimit: SOURCE_FILE_LIMIT,
        capabilityCount: 0,
        capabilityLimit: SOURCE_CAPABILITY_LIMIT,
        deadlineMs: SOURCE_SCAN_TOTAL_TIMEOUT_MS,
        jobDeadlineMs: SOURCE_DISCOVERY_TOTAL_TIMEOUT_MS,
      },
    };
    sourceJobs.set(job.id, job);
    activeSourceJobId = job.id;
    trimSourceJobs(sourceJobs, activeSourceJobId);
    void runSourceJob(job);
    return { ok: true, job: sourceJobSummary(job, true) };
  }

  function sourceJob(id) {
    if (!isRequestId(id)) return fail("invalid-request");
    const job = sourceJobs.get(id);
    return job ? { ok: true, job: sourceJobSummary(job, true) } : fail("unknown-source-discovery");
  }

  function cancelSourceDiscovery(id) {
    if (!isRequestId(id)) return fail("invalid-request");
    const job = sourceJobs.get(id);
    if (!job) return fail("unknown-source-discovery");
    if (["completed", "cancelled", "failed"].includes(job.status)) return { ok: true, job: sourceJobSummary(job, true) };
    job.status = "cancelling";
    job.progress = { ...job.progress, phase: "cancelling" };
    job.controller.abort();
    return { ok: true, job: sourceJobSummary(job, true) };
  }

  async function openSettings(context) {
    if (!context?.sender || !Number.isSafeInteger(context.sender.webContentsId)) return fail("unauthorized-sender");
    if (typeof api.codex?.settings?.open !== "function") return fail("settings-command-unavailable");
    try {
      return (await api.codex.settings.open(context.sender.webContentsId))
        ? { ok: true }
        : fail("settings-command-unavailable");
    } catch (error) {
      return fail("settings-command-unavailable", safeError(error));
    }
  }

  return {
    dispose() {
      disposed = true;
      for (const job of sourceJobs.values()) job.controller.abort();
    },
    async handle(message, context) {
      if (disposed) return fail("unavailable");
      try {
        if (exactRequest(message, "getSnapshot", [])) return { ok: true, snapshot: await snapshot() };
        if (exactRequest(message, "refresh", [])) return { ok: true, snapshot: await snapshot() };
        if (validSetCapabilityRequest(message)) return mutate(message);
        if (exactRequest(message, "listBackups", [])) return { ok: true, backups: backupList(), retentionLimit: BACKUP_HISTORY_LIMIT };
        if (validBackupRequest(message, "getBackupPreview", false)) return previewBackup(message.backupId);
        if (validBackupRequest(message, "rollback", true)) return rollback(message.backupId, message.confirmed);
        if (validBackupRequest(message, "deleteBackup", true)) return deleteBackup(message.backupId, message.confirmed);
        if (exactRequest(message, "getSourceStatus", [])) return { ok: true, source: await sourceStatus() };
        if (validStartSourceRequest(message)) return startSourceDiscovery(message);
        if (validSourceJobRequest(message, "getSourceDiscovery")) return sourceJob(message.requestId);
        if (validSourceJobRequest(message, "cancelSourceDiscovery")) return cancelSourceDiscovery(message.requestId);
        if (exactRequest(message, "openSettings", [])) return openSettings(context);
        return fail("invalid-request");
      } catch (error) { return fail("operation-failed", safeError(error)); }
    },
  };
}

function parseConfig(text) {
  const out = {}; let section = "root"; out.root = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const header = raw.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/); if (header) { section = header[1]; out[section] ||= {}; continue; }
    const pair = raw.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(true|false|"(?:[^"\\]|\\.)*"|-?\d+)\s*(?:#.*)?$/); if (!pair) continue;
    let value = pair[2]; if (value === "true" || value === "false") value = value === "true"; else if (/^-?\d+$/.test(value)) value = Number(value); else { try { value = JSON.parse(value); } catch {} }
    out[section][pair[1]] = value;
  }
  return out;
}

function scanConfig(text, file) {
  const parsed = parseConfig(text); const out = [];
  for (const [section, values] of Object.entries(parsed)) for (const [key, value] of Object.entries(values)) {
    if (SECRET.test(key)) continue;
    const cliFeature = section === "features" || section.startsWith("features.");
    if (cliFeature) continue;
    const category = section.startsWith("tools") ? "Tools" : null;
    if (!category) continue;
    const toggle = typeof value === "boolean";
    out.push(capability({ id: stableId(section, key), name: title(key), category, configured: value, state: toggle ? (value ? "enabled" : "disabled") : "enabled", source: { kind: "config", path: file, detail: `[${section}] ${key}` }, control: toggle ? { method: "config", section, key } : { method: "unsupported" }, risk: /(sandbox|approval|danger|network|shell|exec)/i.test(key) ? "risky" : "ordinary", restart: "restart" }));
  }
  return out;
}

function scanModels(text, file) {
  if (!text || text.length > 20 * 1024 * 1024) return [];
  let json; try { json = JSON.parse(text); } catch { return []; }
  const models = Array.isArray(json) ? json : Array.isArray(json.models) ? json.models : [];
  return models.filter((m) => m && typeof m === "object" && !SECRET.test(JSON.stringify(Object.keys(m)))).map((m, i) => capability({ id: `model.${stableId("model", m.slug || m.id || m.name || i)}`, name: String(m.display_name || m.name || m.slug || m.id || `Model ${i + 1}`), category: "Models", configured: m.visibility ?? m.enabled ?? "available", state: m.enabled === false || m.visibility === "hidden" ? "hidden" : "enabled", source: { kind: "model-catalog", path: file, detail: String(m.slug || m.id || "catalog entry") }, control: { method: "unsupported" }, risk: "ordinary", restart: "new-task" }));
}

async function scanSourceBounded(fsPromises, path, root, options = {}) {
  const signal = options.signal;
  const fileLimit = boundedLimit(options.fileLimit, SOURCE_FILE_LIMIT, SOURCE_FILE_LIMIT);
  const directoryLimit = boundedLimit(options.directoryLimit, SOURCE_DIRECTORY_LIMIT, SOURCE_DIRECTORY_LIMIT);
  const entryLimit = boundedLimit(options.entryLimit, SOURCE_ENTRY_LIMIT, SOURCE_ENTRY_LIMIT);
  const entryYieldInterval = Math.max(1, Math.min(SOURCE_ENTRY_YIELD_INTERVAL, Math.floor(Number(options.entryYieldInterval) || SOURCE_ENTRY_YIELD_INTERVAL)));
  const fileBytesLimit = boundedLimit(options.fileBytesLimit, SOURCE_FILE_BYTES_LIMIT, SOURCE_FILE_BYTES_LIMIT);
  const capabilityLimit = boundedLimit(options.capabilityLimit, SOURCE_CAPABILITY_LIMIT, SOURCE_CAPABILITY_LIMIT);
  const deadlineMs = boundedLimit(options.deadlineMs, SOURCE_SCAN_TOTAL_TIMEOUT_MS, SOURCE_SCAN_TOTAL_TIMEOUT_MS);
  const deadline = Date.now() + deadlineMs;
  const queue = [root];
  const out = [];
  const warnings = [];
  let queuedDirectories = 1;
  let directoriesScanned = 0;
  let entriesVisited = 0;
  let filesScanned = 0;
  let resultLimitReached = false;
  let directoryLimitReached = false;

  const progress = (phase) => ({
    phase,
    directoriesScanned,
    directoryLimit,
    entriesVisited,
    entryLimit,
    filesScanned,
    fileLimit,
    capabilityCount: out.length,
    capabilityLimit,
    deadlineMs,
    capabilities: mergeCapabilities(out),
  });
  const emit = (phase) => { try { options.onProgress?.(progress(phase)); } catch {} };
  const finish = (status, extraWarnings = []) => ({ status, capabilities: mergeCapabilities(out), progress: progress(status), warnings: [...warnings, ...extraWarnings] });
  const cancelled = () => signal?.aborted === true;

  if (cancelled()) return finish("cancelled");
  emit("scanning");
  while (queue.length) {
    if (cancelled()) return finish("cancelled");
    if (Date.now() >= deadline) return finish("budget-exhausted", ["Source scan reached its total time budget; partial results are shown."]);
    if (directoriesScanned >= directoryLimit) return finish("budget-exhausted", ["Source scan reached its directory budget; partial results are shown."]);
    const dir = queue.shift();
    directoriesScanned += 1;
    let entries = [];
    try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (cancelled()) return finish("cancelled");
      if (Date.now() >= deadline) return finish("budget-exhausted", ["Source scan reached its total time budget; partial results are shown."]);
      if (entriesVisited >= entryLimit) return finish("budget-exhausted", ["Source scan reached its entry budget; partial results are shown."]);
      entriesVisited += 1;
      if (entriesVisited % entryYieldInterval === 0) {
        emit("scanning");
        await yieldToEventLoop();
        if (cancelled()) return finish("cancelled");
        if (Date.now() >= deadline) return finish("budget-exhausted", ["Source scan reached its total time budget; partial results are shown."]);
      }
      if ([".git", "target", "node_modules", "vendor"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (queuedDirectories < directoryLimit) { queue.push(full); queuedDirectories += 1; }
        else directoryLimitReached = true;
        continue;
      }
      if (!entry.isFile() || !/\.(rs|ts|tsx|js|json|toml)$/.test(entry.name)) continue;
      if (filesScanned >= fileLimit) return finish("budget-exhausted", ["Source scan reached its file budget; partial results are shown."]);
      let stat;
      try { stat = await fsPromises.stat(full); } catch { continue; }
      if (stat.size > fileBytesLimit) continue;
      let text = "";
      try { text = await fsPromises.readFile(full, "utf8"); } catch { continue; }
      filesScanned += 1;
      const relativePath = path.relative(root, full);
      const patterns = [/Feature::([A-Za-z0-9_]+)/g, /(?:feature|tool|experimental)[_-](?:flag[_-])?["']?([A-Za-z][A-Za-z0-9_-]{2,})/gi, /"(request_user_input|spawn_agent|send_message|wait_agent|update_plan)"/g];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
          if (out.length >= capabilityLimit) { resultLimitReached = true; break; }
          const name = match[1];
          out.push(capability({ id: `source.${stableId("source", name)}`, name: title(name), category: "Source Evidence", configured: null, state: "unsupported", source: { kind: "source", path: relativePath, detail: name }, control: { method: "unsupported" }, risk: "ordinary", restart: "unknown" }));
        }
        if (resultLimitReached) break;
      }
      if (resultLimitReached) return finish("budget-exhausted", ["Source scan reached its result budget; partial results are shown."]);
      emit("scanning");
      if (filesScanned % 8 === 0 && entriesVisited % entryYieldInterval !== 0) await yieldToEventLoop();
    }
    emit("scanning");
    await yieldToEventLoop();
  }
  if (directoryLimitReached) warnings.push("Source scan skipped directories beyond its directory budget.");
  return finish("completed");
}

function runtimeCapabilities(api) { try { const info = api.codex?.runtime?.getCapabilities?.(); return info && typeof info.then !== "function" ? Object.entries(info).map(([key, value]) => capability({ id: `runtime.${stableId("runtime", key)}`, name: title(key), category: "Runtime", configured: !!value, state: value ? "enabled" : "unavailable", source: { kind: "runtime", path: "installed Codex", detail: key }, control: { method: "unsupported" }, risk: "ordinary", restart: "unknown" })) : []; } catch { return []; } }
function capability(x) { return { schemaVersion: SCHEMA_VERSION, description: "Discovered from current Codex configuration or source.", effectiveLayer: x.source.kind, sources: [x.source], compatibility: { status: "observed", evidence: x.source.detail }, ...x }; }
function mergeCapabilities(items) { const map = new Map(); for (const raw of items || []) { const item = redact(raw); const old = map.get(item.id); if (!old) map.set(item.id, item); else old.sources.push(...item.sources.filter((s) => !old.sources.some((x) => x.path === s.path && x.detail === s.detail))); } return [...map.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)); }
function setTomlValue(text, section, key, value) { const lines = String(text).split(/\r?\n/); let start = -1, end = lines.length; for (let i = 0; i < lines.length; i++) { const h = lines[i].match(/^\s*\[([^\]]+)\]/); if (!h) continue; if (start >= 0) { end = i; break; } if (h[1] === section) start = i; } if (start < 0) return `${text.replace(/\s*$/, "")}\n\n[${section}]\n${key} = ${value}\n`; const re = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=.*$`); for (let i = start + 1; i < end; i++) if (re.test(lines[i])) { const indent = lines[i].match(/^\s*/)[0]; lines[i] = `${indent}${key} = ${value}`; return lines.join("\n"); } lines.splice(end, 0, `${key} = ${value}`); return lines.join("\n"); }
function discoverModelPath(fs, path, configPath) { const parsed = parseConfig(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : ""); const configured = parsed.root?.model_catalog_json; return typeof configured === "string" ? configured : path.join(require("node:os").homedir(), ".codex", "models_cache.json"); }
function readJson(fs, file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function stableId(section, key) { return `${String(section).toLowerCase().replace(/[^a-z0-9]+/g, ".")}.${String(key).toLowerCase().replace(/[^a-z0-9]+/g, ".")}`.replace(/^\.|\.$/g, ""); }
function title(value) { return String(value).replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (!value || typeof value !== "object") return typeof value === "string" && SECRET.test(value) ? "[redacted]" : value; const out = {}; for (const [k, v] of Object.entries(value)) out[k] = SECRET.test(k) ? "[redacted]" : redact(v); return out; }
function redactConfigPreview(contents) { const lines = String(contents).split(/\r?\n/); let redacted = false; const preview = []; for (const line of lines) { const pair = line.match(/^(\s*)([^#=\s][^=]*?)(\s*=\s*)(.*)$/); if (pair && SECRET.test(pair[2].trim())) { preview.push(`${pair[1]}${pair[2]}${pair[3]}"[redacted]"`); redacted = true; } else preview.push(line); if (Buffer.byteLength(preview.join("\n"), "utf8") > BACKUP_PREVIEW_BYTES) return { preview: preview.join("\n").slice(0, BACKUP_PREVIEW_BYTES) + "\n…", redacted, truncated: true }; } return { preview: preview.join("\n"), redacted, truncated: false }; }
function safeError(error) { return String(error?.message || error || "unknown error").replace(/(?:gh[opsu]_[A-Za-z0-9_]+|Bearer\s+\S+)/g, "[redacted]").slice(0, 500); }
function fail(code, message) { return { ok: false, error: { code, message: message || code } }; }
function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isBackupId(value) { return typeof value === "string" && BACKUP_ID.test(value); }
function isRequestId(value) { return typeof value === "string" && REQUEST_ID.test(value); }
function isBackupRecord(value, id, configPath) { return value && typeof value === "object" && value.id === id && value.file === configPath && typeof value.contents === "string" && typeof value.createdAt === "string"; }
function exactRequest(value, action, fields) { if (!value || typeof value !== "object" || Array.isArray(value) || value.action !== action) return false; const keys = Object.keys(value).sort(); const expected = ["action", ...fields].sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
function validSetCapabilityRequest(value) { return exactRequest(value, "setCapability", ["id", "enabled", "expectedRevision", "confirmed"]) && typeof value.id === "string" && /^[a-z0-9._-]{1,128}$/i.test(value.id) && typeof value.enabled === "boolean" && typeof value.expectedRevision === "string" && /^[a-f0-9]{24}$/.test(value.expectedRevision) && typeof value.confirmed === "boolean"; }
function validBackupRequest(value, action, confirmationRequired) { const fields = confirmationRequired ? ["backupId", "confirmed"] : ["backupId"]; return exactRequest(value, action, fields) && isBackupId(value.backupId) && (!confirmationRequired || typeof value.confirmed === "boolean"); }
function validStartSourceRequest(value) { return exactRequest(value, "startSourceDiscovery", ["requestId", "refreshSource"]) && isRequestId(value.requestId) && typeof value.refreshSource === "boolean"; }
function validSourceJobRequest(value, action) { return exactRequest(value, action, ["requestId"]) && isRequestId(value.requestId); }
function boundedLimit(value, fallback, ceiling) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), ceiling) : fallback; }
function sourceBudgets() { return { repositories: SOURCE_REPOSITORY_LIMIT, directories: SOURCE_DIRECTORY_LIMIT, entries: SOURCE_ENTRY_LIMIT, files: SOURCE_FILE_LIMIT, bytesPerFile: SOURCE_FILE_BYTES_LIMIT, results: SOURCE_CAPABILITY_LIMIT, scanTotalMilliseconds: SOURCE_SCAN_TOTAL_TIMEOUT_MS, discoveryTotalMilliseconds: SOURCE_DISCOVERY_TOTAL_TIMEOUT_MS }; }
function abortError() { const error = new Error("source-discovery-cancelled"); error.code = "ABORT_ERR"; return error; }
function isAbortError(error) { return error?.code === "ABORT_ERR" || error?.message === "source-discovery-cancelled"; }
function discoveryBudgetError() { const error = new Error("source-discovery-budget-exhausted"); error.code = "SOURCE_BUDGET"; return error; }
function isDiscoveryBudgetError(error) { return error?.code === "SOURCE_BUDGET" || error?.message === "source-discovery-budget-exhausted"; }
function sourceJobTimeout(job) { const remaining = Math.min(SOURCE_GIT_TIMEOUT_MS, (job.deadlineAt || 0) - Date.now()); if (remaining <= 0) throw discoveryBudgetError(); return remaining; }
function yieldToEventLoop() { return new Promise((resolve) => setImmediate(resolve)); }
function runGit(cp, args, options = {}) { return new Promise((resolve, reject) => { if (options.signal?.aborted) { reject(abortError()); return; } let settled = false; let child; const settle = (callback, value) => { if (settled) return; settled = true; options.signal?.removeEventListener?.("abort", abort); callback(value); }; const abort = () => { try { child?.kill("SIGTERM"); } catch {} settle(reject, abortError()); }; child = cp.execFile("git", args, { encoding: "utf8", timeout: options.timeoutMs || SOURCE_GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => { if (error) { settle(reject, new Error(String(stderr || error.message || "git command failed").slice(0, 500))); return; } settle(resolve, String(stdout).trim()); }); options.signal?.addEventListener?.("abort", abort, { once: true }); }); }
function sourceJobSummary(job, includeCapabilities) { if (!job) return null; return { id: job.id, refreshSource: job.refreshSource, status: job.status, result: job.result, warnings: [...job.warnings], error: job.error, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, progress: { ...job.progress }, ...(includeCapabilities ? { capabilities: mergeCapabilities(job.capabilities) } : {}) }; }
function trimSourceJobs(jobs, activeId) { while (jobs.size > SOURCE_JOB_HISTORY_LIMIT) { const candidate = [...jobs.values()].filter((job) => job.id !== activeId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]; if (!candidate) return; jobs.delete(candidate.id); } }

function startRenderer(api) {
  module.exports._page = api.settings.registerPage({ id: "developer-tools", title: "Developer Tools", description: "Inspect Codex tools, models, runtime capabilities, source evidence, and protected configuration recovery.", iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M7 3h6l.5 3 2.5 1.5-1.5 2.5 1.5 2.5-2.5 1.5-.5 3H7l-.5-3L4 12.5 5.5 10 4 7.5 6.5 6 7 3Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.4"/></svg>', render(root) { return renderPage(api, root); } });
}

function renderPage(api, root) {
  let disposed = false, snapshot = null, query = "", category = "All", state = "All", sourceJob = null, sourcePoll = null;
  const recovery = { loading: true, items: [], error: null, preview: null };
  root.textContent = "Loading developer capabilities…";

  const clearSourcePoll = () => { if (sourcePoll) clearTimeout(sourcePoll); sourcePoll = null; };
  const load = async () => {
    try {
      const result = await api.ipc.invoke(IPC, { action: "getSnapshot" });
      if (disposed) return;
      if (!result?.ok) throw new Error(result?.error?.message || "snapshot unavailable");
      snapshot = result.snapshot;
      draw();
    } catch (error) { if (!disposed) root.textContent = `Developer Tools unavailable: ${error.message}`; }
  };
  const loadBackups = async () => {
    recovery.loading = true;
    try {
      const result = await api.ipc.invoke(IPC, { action: "listBackups" });
      if (!result?.ok) throw new Error(result?.error?.message || "backup history unavailable");
      recovery.items = result.backups || []; recovery.error = null;
      if (recovery.preview && !recovery.items.some((item) => item.id === recovery.preview.id)) recovery.preview = null;
    } catch (error) { recovery.error = error.message; } finally { recovery.loading = false; if (snapshot && !disposed) draw(); }
  };
  const pollSourceJob = () => {
    clearSourcePoll();
    if (disposed || !sourceJob || !["queued", "running", "cancelling"].includes(sourceJob.status)) return;
    sourcePoll = setTimeout(async () => {
      try {
        const result = await api.ipc.invoke(IPC, { action: "getSourceDiscovery", requestId: sourceJob.id });
        if (disposed || !result?.ok) return;
        sourceJob = result.job;
        draw();
        if (["queued", "running", "cancelling"].includes(sourceJob.status)) pollSourceJob();
        else await load();
      } catch (error) {
        if (!disposed) { sourceJob = { ...sourceJob, status: "failed", error: error.message }; draw(); }
      }
    }, 350);
  };
  const startSourceDiscovery = async () => {
    if (sourceJob && ["queued", "running", "cancelling"].includes(sourceJob.status)) return;
    const requestId = `source-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const result = await api.ipc.invoke(IPC, { action: "startSourceDiscovery", requestId, refreshSource: true });
      if (!result?.ok) throw new Error(result?.error?.message || "source discovery unavailable");
      sourceJob = result.job; draw(); pollSourceJob();
    } catch (error) { window.alert(`Could not refresh source evidence: ${error.message}`); }
  };
  const cancelSourceDiscovery = async () => {
    if (!sourceJob) return;
    try {
      const result = await api.ipc.invoke(IPC, { action: "cancelSourceDiscovery", requestId: sourceJob.id });
      if (!result?.ok) throw new Error(result?.error?.message || "source discovery unavailable");
      sourceJob = result.job; draw(); pollSourceJob();
    } catch (error) { window.alert(`Could not cancel source discovery: ${error.message}`); }
  };
  const showBackupPreview = async (item) => {
    try {
      const result = await api.ipc.invoke(IPC, { action: "getBackupPreview", backupId: item.id });
      if (!result?.ok) throw new Error(result?.error?.message || "preview unavailable");
      recovery.preview = result.backup; draw();
    } catch (error) { window.alert(`Could not preview this backup: ${error.message}`); }
  };
  const restoreBackup = async (item) => {
    if (!window.confirm(`Restore the backup from ${new Date(item.createdAt).toLocaleString()}? Your current configuration will be backed up first.`)) return;
    try {
      const result = await api.ipc.invoke(IPC, { action: "rollback", backupId: item.id, confirmed: true });
      if (!result?.ok) throw new Error(result?.error?.message || "restore unavailable");
      await Promise.all([load(), loadBackups()]);
    } catch (error) { window.alert(`Could not restore this backup: ${error.message}`); }
  };
  const deleteBackup = async (item) => {
    if (!window.confirm(`Delete the backup from ${new Date(item.createdAt).toLocaleString()}? This cannot be undone.`)) return;
    try {
      const result = await api.ipc.invoke(IPC, { action: "deleteBackup", backupId: item.id, confirmed: true });
      if (!result?.ok) throw new Error(result?.error?.message || "delete unavailable");
      await loadBackups();
    } catch (error) { window.alert(`Could not delete this backup: ${error.message}`); }
  };

  function draw() {
    if (!snapshot || disposed) return;
    root.textContent = "";
    const ownership = el("div", "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary");
    ownership.append(el("span", "min-w-0 flex-1", "Codex CLI feature flags are managed in native Settings. This page only manages supported non-secret tool configuration."));
    ownership.append(button("Open Settings", async () => { const result = await api.ipc.invoke(IPC, { action: "openSettings" }); if (!result?.ok) window.alert("Could not open native Settings from the application menu."); }));
    root.append(ownership);
    const toolbar = el("div", "flex flex-wrap items-center gap-2");
    const capabilities = mergeCapabilities([...(snapshot.capabilities || []), ...(sourceJob?.capabilities || [])]);
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Search tools and features"; search.value = query; search.className = "border-token-border bg-token-foreground/5 h-token-button-composer min-w-[240px] flex-1 rounded-md border px-3 text-sm text-token-text-primary"; search.addEventListener("input", () => { query = search.value; draw(); });
    const categorySelect = select(["All", ...new Set(capabilities.map((x) => x.category))], category, (value) => { category = value; draw(); });
    const stateSelect = select(["All", "enabled", "disabled", "hidden", "unavailable", "unsupported", "unknown"], state, (value) => { state = value; draw(); });
    const refresh = button("Refresh", () => { void load(); });
    const refreshingSource = !!sourceJob && ["queued", "running", "cancelling"].includes(sourceJob.status);
    const source = button(refreshingSource ? "Refreshing source…" : "Refresh source", () => { void startSourceDiscovery(); }, refreshingSource);
    toolbar.append(search, categorySelect, stateSelect, refresh, source); root.append(toolbar);
    if (snapshot.stale || snapshot.warnings?.length) root.append(el("div", "mt-3 rounded-md bg-token-charts-yellow/10 p-3 text-sm text-token-text-primary", snapshot.warnings?.join(" ") || "Showing cached inventory."));
    if (sourceJob) root.append(sourceDiscoveryStatus(sourceJob, cancelSourceDiscovery));
    const meta = el("div", "mt-3 text-sm text-token-text-secondary", `${capabilities.length} capabilities · scanned ${new Date(snapshot.scannedAt).toLocaleString()} · source ${snapshot.source.commit?.slice(0, 8) || "not downloaded"}`); root.append(meta);
    const list = capabilities.filter((item) => (!query || `${item.name} ${item.id} ${item.description}`.toLowerCase().includes(query.toLowerCase())) && (category === "All" || item.category === category) && (state === "All" || item.state === state));
    const groups = new Map(); for (const item of list) { if (!groups.has(item.category)) groups.set(item.category, []); groups.get(item.category).push(item); }
    for (const [name, items] of groups) { root.append(el("div", "mt-5 text-base font-medium text-token-text-primary", name)); const card = el("div", "border-token-border mt-2 flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border"); for (const item of items) card.append(capabilityRow(api, snapshot, item, async () => { await Promise.all([load(), loadBackups()]); })); root.append(card); }
    if (!list.length) root.append(el("div", "mt-6 text-sm text-token-text-secondary", "No capabilities match these filters."));
    root.append(recoverySection(recovery, showBackupPreview, restoreBackup, deleteBackup));
  }

  void load(); void loadBackups();
  return () => { disposed = true; clearSourcePoll(); root.textContent = ""; };
}

function capabilityRow(api, snapshot, item, reload) {
  const row = el("div", "flex items-start justify-between gap-4 p-3"); const left = el("div", "min-w-0 flex-1");
  const heading = el("div", "flex flex-wrap items-center gap-2"); heading.append(el("span", "text-sm text-token-text-primary", item.name), badge(item.state), badge(item.risk), badge(item.restart)); left.append(heading, el("div", "mt-1 text-sm text-token-text-secondary", `${item.id} · ${item.effectiveLayer}`));
  const details = document.createElement("details"); details.className = "mt-2 text-sm text-token-text-secondary"; const summary = document.createElement("summary"); summary.className = "cursor-pointer"; summary.textContent = "Evidence and sources"; details.append(summary); for (const source of item.sources) details.append(el("div", "mt-1 break-all", `${source.kind}: ${source.path} · ${source.detail}`)); left.append(details); row.append(left);
  if (item.control.method === "config" && typeof item.configured === "boolean") { const toggle = switchControl(item.configured, async (enabled, apply) => { if (item.risk !== "ordinary" && !window.confirm(`Change risky capability “${item.name}”? A backup will be created.`)) return apply(item.configured); toggle.disabled = true; const result = await api.ipc.invoke(IPC, { action: "setCapability", id: item.id, enabled, expectedRevision: snapshot.revision, confirmed: item.risk !== "ordinary" }); toggle.disabled = false; if (!result?.ok) { apply(item.configured); window.alert(`Could not update ${item.name}: ${result?.error?.message || "unknown error"}`); return; } if (result.restart === "restart") window.alert(`${item.name} changed. Restart Codex for it to take effect.`); await reload(); }); row.append(toggle); }
  else row.append(el("span", "shrink-0 text-sm text-token-text-secondary", "Read only")); return row;
}

function sourceDiscoveryStatus(job, cancel) {
  const status = el("div", "mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary");
  const progress = job.progress || {};
  const detail = `${job.status === "completed" ? "Source discovery complete" : `Source discovery ${job.status}`} · ${progress.filesScanned || 0}/${progress.fileLimit || SOURCE_FILE_LIMIT} files · ${progress.directoriesScanned || 0}/${progress.directoryLimit || SOURCE_DIRECTORY_LIMIT} directories · ${progress.entriesVisited || 0}/${progress.entryLimit || SOURCE_ENTRY_LIMIT} entries · ${progress.capabilityCount || 0}/${progress.capabilityLimit || SOURCE_CAPABILITY_LIMIT} results`;
  status.append(el("span", "min-w-0 flex-1", job.error ? `Source discovery failed: ${job.error}` : detail));
  if (["queued", "running", "cancelling"].includes(job.status)) status.append(button("Cancel", () => { void cancel(); }));
  if (job.warnings?.length) status.append(el("span", "w-full text-xs", job.warnings.join(" ")));
  return status;
}

function recoverySection(recovery, preview, restore, remove) {
  const section = el("section", "mt-6 flex flex-col gap-2");
  section.append(el("div", "text-base font-medium text-token-text-primary", "Configuration recovery"));
  section.append(el("div", "text-sm text-token-text-secondary", `Each supported configuration change creates an owner-only backup. The newest ${BACKUP_HISTORY_LIMIT} backups are retained; previews redact credential-like values.`));
  const card = el("div", "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border");
  if (recovery.loading) card.append(el("div", "p-3 text-sm text-token-text-secondary", "Loading backup history…"));
  else if (recovery.error) card.append(el("div", "p-3 text-sm text-token-charts-red", `Backup history is unavailable: ${recovery.error}`));
  else if (!recovery.items.length) card.append(el("div", "p-3 text-sm text-token-text-secondary", "No configuration backups yet."));
  else for (const item of recovery.items) {
    const row = el("div", "flex flex-wrap items-center justify-between gap-3 p-3");
    row.append(el("div", "min-w-0 text-sm text-token-text-secondary", `${item.label || BACKUP_LABEL} · ${new Date(item.createdAt).toLocaleString()}`));
    const actions = el("div", "flex flex-wrap items-center gap-2");
    actions.append(button("Preview", () => { void preview(item); }), button("Restore", () => { void restore(item); }), button("Delete", () => { void remove(item); }));
    row.append(actions); card.append(row);
  }
  section.append(card);
  if (recovery.preview) {
    const previewCard = el("div", "border-token-border mt-1 rounded-lg border p-3");
    previewCard.append(el("div", "mb-2 text-sm text-token-text-primary", `Preview · ${new Date(recovery.preview.createdAt).toLocaleString()}${recovery.preview.truncated ? " · truncated" : ""}${recovery.preview.redacted ? " · credential-like values redacted" : ""}`));
    const text = document.createElement("pre"); text.className = "max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-token-text-secondary"; text.textContent = recovery.preview.preview; previewCard.append(text); section.append(previewCard);
  }
  return section;
}

function switchControl(initial, onChange) { const btn = document.createElement("button"); btn.type = "button"; btn.setAttribute("role", "switch"); const pill = document.createElement("span"), knob = document.createElement("span"); knob.className = "h-4 w-4 rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform"; pill.append(knob); const apply = (on) => { btn.setAttribute("aria-checked", String(on)); btn.className = "inline-flex cursor-interaction items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"; pill.className = `relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors ${on ? "bg-token-charts-blue" : "bg-token-foreground/20"}`; knob.style.transform = on ? "translateX(14px)" : "translateX(2px)"; }; apply(initial); btn.append(pill); btn.addEventListener("click", () => onChange(btn.getAttribute("aria-checked") !== "true", apply)); return btn; }
function select(options, value, change) { const node = document.createElement("select"); node.className = "border-token-border bg-token-foreground/5 h-token-button-composer rounded-md border px-2 text-sm text-token-text-primary"; for (const option of options) { const el = document.createElement("option"); el.value = option; el.textContent = option; el.selected = option === value; node.append(el); } node.addEventListener("change", () => change(node.value)); return node; }
function button(text, action, disabled = false) { const node = el("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary", text); node.type = "button"; node.disabled = disabled; node.addEventListener("click", action); return node; }
function badge(text) { return el("span", "rounded-full bg-token-foreground/5 px-2 py-0.5 text-xs text-token-text-secondary", text); }
function el(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
