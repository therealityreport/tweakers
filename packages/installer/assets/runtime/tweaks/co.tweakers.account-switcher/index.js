"use strict";

const IPC = "accounts";
const SERVICE_KEY = "__tweakersAccountServiceV1";
const HANDLER_KEY = "__tweakersAccountHandlerV1";
const MAX_AUTH_BYTES = 1024 * 1024;
const INTENT_TTL_MS = 30_000;
const PROJECTION_LIMITS = Object.freeze({
  maxBytes: 256 * 1024,
  maxAccounts: 64,
  maxEpochs: 512,
  maxQuotaSnapshots: 512,
});

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
      // Remove the IPC handler and reset the guard so a later start() re-registers
      // cleanly instead of leaking a handler bound to a disposed service.
      const unregister = globalThis[HANDLER_KEY];
      if (typeof unregister === "function") { try { unregister(); } catch {} }
      globalThis[HANDLER_KEY] = null;
    } else {
      cleanupRenderer();
    }
  },
  _test: {
    validateReferenceName, validateAuthObject, redact, createAccountService,
    stableRef, authPaths, displayLabelFromAuth, syncActiveSnapshot,
    accountMenuTargetFromCandidates, accountKeyFromAuth,
    readAccountProjection, writeAccountProjection, validateAccountProjection,
    PROJECTION_LIMITS,
  },
};

function startMain(api) {
  const service = createAccountService(api, { onSwitched: () => scheduleHostRestart(api) });
  globalThis[SERVICE_KEY] = service;
  if (!globalThis[HANDLER_KEY]) {
    const unregister = api.ipc.handle?.(IPC, (message) => {
      const active = globalThis[SERVICE_KEY];
      if (!active) return safeFailure("unavailable");
      return active.handle(message);
    });
    globalThis[HANDLER_KEY] = typeof unregister === "function" ? unregister : true;
  }
  api.log.info("Account switcher service ready");
}

function createAccountService(api, options = {}) {
  const deps = options.deps || nodeDeps();
  const paths = options.paths || authPaths(deps);
  const intents = new Map();
  const refs = new Map();
  let disposed = false;
  let queue = Promise.resolve();

  const enqueueIntent = (message) => {
    const task = () => executeIntent(deps, paths, refs, intents, message, options, api);
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const service = {
    handle(message) {
      if (disposed) return Promise.resolve(safeFailure("unavailable"));
      if (message?.action === "list") return service.list();
      if (message?.action === "prepare-switch") return service.prepareSwitch(message.ref);
      if (message?.action === "prepare-save") return service.prepareSave(message.name);
      if (message?.action === "switch") return service.switch(message.intent);
      if (message?.action === "save") return service.save(message.intent);
      return Promise.resolve(safeFailure("invalid-request"));
    },
    list() { return Promise.resolve(listAccounts(deps, paths, refs)); },
    prepareSwitch(ref) { return Promise.resolve(prepareIntent(deps, paths, refs, intents, "switch", ref)); },
    prepareSave(name) { return Promise.resolve(prepareIntent(deps, paths, refs, intents, "save", name)); },
    switch(intent) { return enqueueIntent({ action: "switch", intent }); },
    save(intent) { return enqueueIntent({ action: "save", intent }); },
    observeStartup() {
      if (disposed) return safeFailure("unavailable");
      try {
        reconcileStartupProjection(deps, paths);
        return { ok: true };
      } catch (error) {
        logProjectionFailure(api, "startup-observation-failed", error);
        return safeFailure("projection-unavailable");
      }
    },
    dispose() { disposed = true; stopSnapshotSync(); intents.clear(); refs.clear(); },
  };

  // Refresh tokens rotate on every renewal, so a saved snapshot goes stale
  // the moment the live session refreshes; restoring a stale snapshot trips
  // OAuth reuse detection and the server REVOKES the whole token family
  // (observed 2026-07-13). Keep the active account's snapshot in lockstep
  // with auth.json so switching back always presents current tokens.
  const stopSnapshotSync = startActiveSnapshotSync(deps, paths, api, () => disposed);
  service.observeStartup();
  return service;
}

function startActiveSnapshotSync(deps, paths, api, isDisposed) {
  const fs = deps.fs;
  if (typeof fs.watch !== "function") return () => {};
  let timer = null;
  let watcher = null;
  const sync = () => {
    timer = null;
    if (isDisposed()) return;
    try {
      syncActiveSnapshot(deps, paths);
    } catch (error) {
      api.log?.warn?.("active account snapshot sync failed", String(error?.code || error));
    }
  };
  try {
    // Watch the directory, not the file: auth.json is replaced atomically
    // (rename), which drops a direct file watch on some platforms.
    watcher = fs.watch(paths.codexDir, { persistent: false }, (_event, name) => {
      if (name && name !== "auth.json") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(sync, 1_000);
    });
  } catch (error) {
    api.log?.warn?.("active account snapshot sync unavailable", String(error?.code || error));
    return () => {};
  }
  // Also reconcile once at startup: the app may have rotated tokens while
  // this tweak was not running.
  timer = setTimeout(sync, 2_000);
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher?.close(); } catch { /* already closed */ }
  };
}

function syncActiveSnapshot(deps, paths) {
  const fs = deps.fs;
  const marker = readCurrentMarker(fs, paths.currentMarker);
  if (marker.status !== "ok" || !marker.value) return;
  const target = sourceFilePath(deps.path, paths.accountsDir, marker.value);
  let snapshot;
  try {
    snapshot = readSecureAuth(fs, target);
  } catch {
    return; // Snapshot missing/invalid: nothing safe to sync into.
  }
  const current = readSecureAuth(fs, paths.authFile);
  try {
    if (!current.bytes.length || current.hash === snapshot.hash) return;
    // Only propagate tokens for the SAME account; a manual re-login to a
    // different account must not overwrite another account's snapshot.
    const currentAccount = authAccountId(current.value);
    const snapshotAccount = authAccountId(snapshot.value);
    if (!currentAccount || currentAccount !== snapshotAccount) return;
    atomicWrite(deps, paths.accountsDir, target, current.bytes);
  } finally {
    current.bytes.fill(0);
    snapshot.bytes.fill(0);
  }
}

function authAccountId(value) {
  const id = value?.tokens?.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function listAccounts(deps, paths, refs) {
  try {
    refs.clear();
    ensureAccountsDirectory(deps.fs, paths.accountsDir, false);
    const current = readCurrentMarker(deps.fs, paths.currentMarker);
    let liveAccountId = null;
    try {
      const live = readSecureAuth(deps.fs, paths.authFile);
      try { liveAccountId = authAccountId(live.value); }
      finally { live.bytes.fill(0); }
    } catch {}
    const accounts = [];
    for (const entry of deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const name = entry.name.slice(0, -5);
      try {
        validateReferenceName(name);
        // Stable, deterministic ref for a filename. The renderer re-lists on
        // every DOM mutation; with random UUIDs a re-list invalidated the refs
        // already rendered on the buttons, so Switch failed with
        // "unknown-reference". A filename-derived hash stays valid across lists.
        const opaque = stableRef(entry.name);
        refs.set(opaque, entry.name);
        const auth = readSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, entry.name));
        const label = displayLabelFromAuth(auth.value, name);
        const savedAccountId = authAccountId(auth.value);
        auth.bytes.fill(0);
        accounts.push({
          ref: opaque,
          label,
          active: current.value === entry.name
            && Boolean(liveAccountId)
            && savedAccountId === liveAccountId,
        });
      } catch {}
    }
    accounts.sort((a, b) => a.label.localeCompare(b.label));
    const markerStatus = current.value && !accounts.some((item) => item.active)
      ? (accounts.some((item) => refs.get(item.ref) === current.value) ? "identity-mismatch" : "dangling-reference")
      : current.status;
    return redact({ ok: true, accounts, markerStatus });
  } catch {
    return safeFailure("account-list-unavailable");
  }
}

function prepareIntent(deps, paths, refs, intents, action, rawValue) {
  try {
    let target;
    if (action === "switch") {
      target = refs.get(rawValue);
      if (!target) throw coded("unknown-reference");
      const snapshot = readSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, target));
      pruneIntents(intents, deps.now());
      const intent = deps.randomUUID();
      intents.set(intent, { action, target, snapshot: { identity: snapshot.identity, hash: snapshot.hash }, expiresAt: deps.now() + INTENT_TTL_MS });
      return { ok: true, intent, confirmation: "Switch Codex to this saved session?" };
    } else {
      target = validateReferenceName(rawValue);
      if (deps.fs.existsSync(sourcePath(deps.path, paths.accountsDir, target))) throw coded("account-exists");
      readSecureAuth(deps.fs, paths.authFile);
    }
    pruneIntents(intents, deps.now());
    const intent = deps.randomUUID();
    intents.set(intent, { action, target, expiresAt: deps.now() + INTENT_TTL_MS });
    return { ok: true, intent, confirmation: action === "switch" ? "Switch Codex to this saved session?" : "Save the current Codex session under this name?" };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

async function executeIntent(deps, paths, refs, intents, message, options = {}, api) {
  const intent = intents.get(message.intent);
  intents.delete(message.intent);
  if (!intent || intent.action !== message.action || intent.expiresAt < deps.now()) return safeFailure("invalid-or-expired-intent");
  try {
    let switchBoundary = null;
    if (intent.action === "switch") switchBoundary = switchAccount(deps, paths, intent.target, intent.snapshot);
    else saveCurrent(deps, paths, intent.target);
    refs.clear();
    if (switchBoundary) {
      try {
        recordSwitchProjection(deps, paths, { ...switchBoundary, switchedAt: isoNow(deps) });
      } catch (error) {
        invalidateUnsafeProjection(deps, paths);
        logProjectionFailure(api, "projection-update-failed", error);
      }
    }
    const restartScheduled = intent.action === "switch" ? options.onSwitched?.() === true : false;
    return { ok: true, action: intent.action, restartScheduled };
  } catch (error) {
    return safeFailure(errorCode(error));
  }
}

function scheduleHostRestart(api) {
  try {
    const app = require("electron")?.app;
    if (!app?.relaunch || !app?.exit) throw new Error("Electron app lifecycle is unavailable");
    setTimeout(() => {
      try {
        app.relaunch();
        app.exit(0);
      } catch (error) {
        api.log.error("Account switch restart failed", String(error));
      }
    }, 150);
    api.log.info("Account switch complete; app restart scheduled");
    return true;
  } catch (error) {
    api.log.warn("Account switched, but app restart could not be scheduled", String(error));
    return false;
  }
}

function switchAccount(deps, paths, filename, snapshot) {
  const fs = deps.fs;
  assertTrustedDirectory(fs, paths.codexDir);
  assertTrustedDirectory(fs, paths.accountsDir);
  const source = sourceFilePath(deps.path, paths.accountsDir, filename);
  const selected = readSecureAuth(fs, source);
  if (!snapshot || selected.identity !== snapshot.identity || selected.hash !== snapshot.hash) throw coded("source-changed");
  const current = readSecureAuth(fs, paths.authFile);
  let previousAccountKey = null;
  let accountKey = null;
  try { previousAccountKey = accountKeyFromAuth(current.value); } catch {}
  try { accountKey = accountKeyFromAuth(selected.value); } catch {}
  if (!current.bytes.length) throw coded("no-last-known-good");
  const revalidated = readSecureAuth(fs, source);
  if (selected.identity !== revalidated.identity || selected.hash !== revalidated.hash) throw coded("source-changed");
  const previousMarker = readOptionalSecureBytes(fs, paths.currentMarker, 256);
  const previousLkg = readOptionalSecureBytes(fs, paths.lkgFile, MAX_AUTH_BYTES);
  const active = readCurrentMarker(fs, paths.currentMarker);
  let activeSnapshotPath = null;
  let previousActiveSnapshot = null;
  let mutated = false;
  let completed = false;
  try {
    // Persist the session being left synchronously. The background watcher
    // handles normal token rotation, but this closes the last-second race
    // between a refresh-token write and the user clicking Switch.
    if (active.status === "ok" && active.value && active.value !== filename) {
      activeSnapshotPath = sourceFilePath(deps.path, paths.accountsDir, active.value);
      if (fs.existsSync(activeSnapshotPath)) {
        const savedActive = readSecureAuth(fs, activeSnapshotPath);
        try {
          const liveAccount = authAccountId(current.value);
          const savedAccount = authAccountId(savedActive.value);
          if (!liveAccount || liveAccount !== savedAccount) throw coded("active-account-mismatch");
          previousActiveSnapshot = Buffer.from(savedActive.bytes);
        } finally {
          savedActive.bytes.fill(0);
        }
        mutated = true;
        atomicWrite(deps, paths.accountsDir, activeSnapshotPath, current.bytes);
      } else {
        activeSnapshotPath = null;
      }
    }
    mutated = true;
    atomicWrite(deps, paths.codexDir, paths.authFile, revalidated.bytes);
    atomicWrite(deps, paths.codexDir, paths.currentMarker, Buffer.from(`${filename}\n`, "utf8"));
    // The fixed LKG rotates only after auth and marker are both durable.
    atomicWrite(deps, paths.codexDir, paths.lkgFile, current.bytes);
    completed = true;
  } catch (error) {
    if (mutated) {
      try {
        atomicWrite(deps, paths.codexDir, paths.authFile, current.bytes);
        restoreOptional(deps, paths.codexDir, paths.currentMarker, previousMarker);
        restoreOptional(deps, paths.codexDir, paths.lkgFile, previousLkg);
        if (activeSnapshotPath && previousActiveSnapshot) {
          atomicWrite(deps, paths.accountsDir, activeSnapshotPath, previousActiveSnapshot);
        }
      } catch { throw coded("rollback-failed"); }
    }
    throw coded(errorCode(error));
  } finally {
    current.bytes.fill(0); selected.bytes.fill(0); revalidated.bytes.fill(0);
    // Also zero the snapshots of prior on-disk state we read for rollback.
    if (Buffer.isBuffer(previousMarker)) previousMarker.fill(0);
    if (Buffer.isBuffer(previousLkg)) previousLkg.fill(0);
    if (Buffer.isBuffer(previousActiveSnapshot)) previousActiveSnapshot.fill(0);
  }
  if (!completed) throw coded("auth-write-failed");
  return {
    previousFilename: active.status === "ok" ? active.value : null,
    filename,
    previousAccountKey,
    accountKey,
  };
}

function saveCurrent(deps, paths, name) {
  assertTrustedDirectory(deps.fs, paths.codexDir);
  ensureAccountsDirectory(deps.fs, paths.accountsDir, true);
  assertTrustedDirectory(deps.fs, paths.accountsDir);
  const current = readSecureAuth(deps.fs, paths.authFile);
  try {
    const target = sourcePath(deps.path, paths.accountsDir, name);
    createExclusiveAtomic(deps, paths.accountsDir, target, current.bytes);
  } finally {
    current.bytes.fill(0);
  }
}

function readSecureAuth(fs, file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > MAX_AUTH_BYTES) throw coded("invalid-auth-source");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) throw coded("invalid-auth-source");
    const value = JSON.parse(bytes.toString("utf8"));
    validateAuthObject(value);
    const { createHash } = require("node:crypto");
    return { bytes, value, hash: createHash("sha256").update(bytes).digest("hex"), identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
  } catch (error) {
    if (error?.code && String(error.code).startsWith("invalid-")) throw error;
    throw coded("invalid-auth-source");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readOptionalSecureBytes(fs, file, maxBytes) {
  if (!fs.existsSync(file)) return null;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw coded("invalid-existing-state");
  return fs.readFileSync(file);
}

function restoreOptional(deps, dir, file, bytes) {
  if (bytes) return atomicWrite(deps, dir, file, bytes);
  try { deps.fs.unlinkSync(file); fsyncDirectory(deps.fs, dir); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function validateAuthObject(value) {
  if (!isRecord(value) || typeof value.auth_mode !== "string") throw coded("invalid-auth-source");
  const hasApiKey = typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY.length > 0;
  const tokens = value.tokens;
  const hasTokens = isRecord(tokens) && [tokens.access_token, tokens.refresh_token, tokens.id_token].some((item) => typeof item === "string" && item.length > 0);
  if (!hasApiKey && !hasTokens) throw coded("invalid-auth-source");
  return true;
}

function atomicWrite(deps, dir, target, bytes) {
  const fs = deps.fs;
  const tmp = `${target}.tmp-${deps.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(fs, dir);
  } catch (error) {
    throw coded(errorCode(error) === "operation-failed" ? "auth-write-failed" : errorCode(error));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function createExclusiveAtomic(deps, dir, target, bytes) {
  const fs = deps.fs;
  const tmp = `${target}.tmp-${deps.randomUUID()}`;
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.linkSync(tmp, target);
    fs.unlinkSync(tmp);
    fs.chmodSync(target, 0o600);
    fsyncDirectory(fs, dir);
  } catch (error) {
    if (error?.code === "EEXIST") throw coded("account-exists");
    throw coded("auth-write-failed");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function fsyncDirectory(fs, dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureAccountsDirectory(fs, dir, create) {
  if (!fs.existsSync(dir)) {
    if (!create) throw coded("account-list-unavailable");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded("invalid-accounts-directory");
}

function assertTrustedDirectory(fs, dir) {
  const stat = fs.lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw coded("untrusted-auth-directory");
}

function readCurrentMarker(fs, file) {
  let fd;
  try {
    // Open with O_NOFOLLOW and fstat the fd (TOCTOU-safe), matching the rigor of
    // readSecureAuth rather than lstat-then-read.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 256) return { value: null, status: "invalid" };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const value = buffer.toString("utf8").trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(value)) return { value: null, status: "invalid" };
    return { value, status: "ok" };
  } catch (error) {
    return { value: null, status: error?.code === "ENOENT" ? "missing" : "invalid" };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateReferenceName(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) throw coded("invalid-reference");
  return value;
}

function sourcePath(path, dir, name) {
  const target = path.resolve(dir, `${validateReferenceName(name)}.json`);
  if (path.dirname(target) !== path.resolve(dir)) throw coded("invalid-reference");
  return target;
}

function sourceFilePath(path, dir, filename) {
  if (typeof filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(filename) || filename.endsWith(".json.json")) throw coded("invalid-reference");
  const target = path.resolve(dir, filename);
  if (path.dirname(target) !== path.resolve(dir)) throw coded("invalid-reference");
  return target;
}

function pruneIntents(intents, now) {
  for (const [id, intent] of intents) if (intent.expiresAt < now) intents.delete(id);
  while (intents.size >= 32) intents.delete(intents.keys().next().value);
}

function authPaths(deps) {
  // Honor CODEX_HOME (the runtime and Codex itself do); otherwise ~/.codex.
  const codexDir = deps.codexHome && deps.codexHome.trim()
    ? deps.path.resolve(deps.codexHome)
    : deps.path.join(deps.homedir(), ".codex");
  const projectionDir = deps.path.join(deps.homedir(), "Library", "Application Support", "codex-plusplus");
  return {
    codexDir,
    accountsDir: deps.path.join(codexDir, "auth_accounts"),
    authFile: deps.path.join(codexDir, "auth.json"),
    currentMarker: deps.path.join(codexDir, "current_account"),
    lkgFile: deps.path.join(codexDir, "auth.account-switcher-lkg.json"),
    projectionDir,
    projectionFile: deps.path.join(projectionDir, "account-analytics.v1.json"),
  };
}

function stableRef(filename) {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(String(filename)).digest("hex").slice(0, 32);
}

function nodeDeps() {
  const { randomUUID } = require("node:crypto");
  return {
    fs: require("node:fs"),
    path: require("node:path"),
    homedir: require("node:os").homedir,
    codexHome: typeof process !== "undefined" ? (process.env.CODEX_HOME || null) : null,
    randomUUID,
    now: Date.now,
  };
}

function projectionPaths(deps, paths) {
  if (paths.projectionDir && paths.projectionFile) return paths;
  const projectionDir = deps.path.join(deps.homedir(), "Library", "Application Support", "codex-plusplus");
  return { ...paths, projectionDir, projectionFile: deps.path.join(projectionDir, "account-analytics.v1.json") };
}

function accountKeyFromAuth(value) {
  const accountId = authAccountId(value);
  if (!accountId) throw coded("projection-identity-unavailable");
  return `acct_${stableRef(`openai-account:${accountId}`)}`;
}

function emptyAccountProjection() {
  return { version: 1, revision: 0, updatedAt: "1970-01-01T00:00:00.000Z", accounts: [], epochs: [], quotaSnapshots: [] };
}

function isoNow(deps) {
  const value = new Date(deps.now()).toISOString();
  if (!isIsoTimestamp(value)) throw coded("projection-invalid");
  return value;
}

function isIsoTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validAccountKey(value) { return typeof value === "string" && /^acct_[0-9a-f]{32}$/.test(value); }
function validLabel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}

function validateQuotaWindow(value) {
  if (!isRecord(value) || Object.keys(value).length > 16) throw coded("projection-invalid");
  const allowed = new Set(["usedPercent", "remainingPercent", "windowMinutes", "resetsAt", "limit", "remaining", "used"]);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) throw coded("projection-invalid");
    if (key === "resetsAt") {
      if (item !== null && !isIsoTimestamp(item)) throw coded("projection-invalid");
    } else if (item !== null && (typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
      throw coded("projection-invalid");
    }
  }
  return true;
}

function validateAccountProjection(value) {
  if (!hasExactKeys(value, ["version", "revision", "updatedAt", "accounts", "epochs", "quotaSnapshots"])) throw coded("projection-invalid");
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isIsoTimestamp(value.updatedAt)) throw coded("projection-invalid");
  if (!Array.isArray(value.accounts) || value.accounts.length > PROJECTION_LIMITS.maxAccounts) throw coded("projection-invalid");
  if (!Array.isArray(value.epochs) || value.epochs.length > PROJECTION_LIMITS.maxEpochs) throw coded("projection-invalid");
  if (!Array.isArray(value.quotaSnapshots) || value.quotaSnapshots.length > PROJECTION_LIMITS.maxQuotaSnapshots) throw coded("projection-invalid");
  const accountKeys = new Set();
  let activeCount = 0;
  for (const account of value.accounts) {
    if (!hasExactKeys(account, ["accountKey", "label", "active"]) || !validAccountKey(account.accountKey) || !validLabel(account.label) || typeof account.active !== "boolean") throw coded("projection-invalid");
    if (accountKeys.has(account.accountKey)) throw coded("projection-invalid");
    accountKeys.add(account.accountKey);
    if (account.active) activeCount += 1;
  }
  if (activeCount > 1) throw coded("projection-invalid");
  for (const epoch of value.epochs) {
    if (!hasExactKeys(epoch, ["accountKey", "startedAt", "endedAt", "source"]) || !validAccountKey(epoch.accountKey) || !isIsoTimestamp(epoch.startedAt)) throw coded("projection-invalid");
    if (!accountKeys.has(epoch.accountKey)) throw coded("projection-invalid");
    if (epoch.endedAt !== null && (!isIsoTimestamp(epoch.endedAt) || epoch.endedAt < epoch.startedAt)) throw coded("projection-invalid");
    if (!new Set(["confirmed-switch", "startup-observation"]).has(epoch.source)) throw coded("projection-invalid");
  }
  for (const snapshot of value.quotaSnapshots) {
    if (!hasExactKeys(snapshot, ["accountKey", "capturedAt", "planType", "primary", "secondary"])) throw coded("projection-invalid");
    if (!validAccountKey(snapshot.accountKey) || !isIsoTimestamp(snapshot.capturedAt) || typeof snapshot.planType !== "string" || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(snapshot.planType)) throw coded("projection-invalid");
    if (!accountKeys.has(snapshot.accountKey)) throw coded("projection-invalid");
    validateQuotaWindow(snapshot.primary);
    validateQuotaWindow(snapshot.secondary);
  }
  return true;
}

function assertTrustedProjectionDirectory(deps, dir, create) {
  const fs = deps.fs;
  const path = deps.path;
  const home = path.resolve(deps.homedir());
  const target = path.resolve(dir);
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw coded("projection-untrusted");
  let current = home;
  assertOwnedDirectory(fs, current);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) throw coded("projection-missing");
      fs.mkdirSync(current, { mode: 0o700 });
    }
    assertOwnedDirectory(fs, current);
  }
}

function assertOwnedDirectory(fs, dir) {
  const stat = fs.lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw coded("projection-untrusted");
}

function readAccountProjection(deps, rawPaths) {
  const paths = projectionPaths(deps, rawPaths);
  const initialStat = lstatIfPresent(deps.fs, paths.projectionFile);
  if (!initialStat) return emptyAccountProjection();
  if (initialStat.isSymbolicLink()) throw coded("projection-invalid");
  assertTrustedProjectionDirectory(deps, paths.projectionDir, false);
  let fd;
  try {
    fd = deps.fs.openSync(paths.projectionFile, deps.fs.constants.O_RDONLY | (deps.fs.constants.O_NOFOLLOW || 0));
    const stat = deps.fs.fstatSync(fd);
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > PROJECTION_LIMITS.maxBytes) throw coded("projection-invalid");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = deps.fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== bytes.length) throw coded("projection-invalid");
    const value = JSON.parse(bytes.toString("utf8"));
    validateAccountProjection(value);
    return value;
  } catch (error) {
    if (error?.code === "projection-invalid" || error?.code === "projection-untrusted") throw error;
    throw coded("projection-invalid");
  } finally {
    if (fd !== undefined) deps.fs.closeSync(fd);
  }
}

function writeAccountProjection(deps, rawPaths, value) {
  const paths = projectionPaths(deps, rawPaths);
  validateAccountProjection(value);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > PROJECTION_LIMITS.maxBytes) throw coded("projection-invalid");
  assertTrustedProjectionDirectory(deps, paths.projectionDir, true);
  {
    const stat = lstatIfPresent(deps.fs, paths.projectionFile);
    if (stat) {
      const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) throw coded("projection-invalid");
    }
  }
  const tmp = `${paths.projectionFile}.tmp-${deps.randomUUID()}`;
  let fd;
  try {
    fd = deps.fs.openSync(tmp, deps.fs.constants.O_CREAT | deps.fs.constants.O_EXCL | deps.fs.constants.O_WRONLY, 0o600);
    deps.fs.writeFileSync(fd, bytes);
    deps.fs.fsyncSync(fd);
    deps.fs.closeSync(fd); fd = undefined;
    deps.fs.renameSync(tmp, paths.projectionFile);
    deps.fs.chmodSync(paths.projectionFile, 0o600);
    fsyncDirectory(deps.fs, paths.projectionDir);
  } catch {
    throw coded("projection-write-failed");
  } finally {
    if (fd !== undefined) deps.fs.closeSync(fd);
    try { deps.fs.unlinkSync(tmp); } catch {}
    bytes.fill(0);
  }
}

function discoverProjectionAccounts(deps, paths) {
  ensureAccountsDirectory(deps.fs, paths.accountsDir, false);
  assertTrustedDirectory(deps.fs, paths.accountsDir);
  const marker = readCurrentMarker(deps.fs, paths.currentMarker);
  let liveAccountKey = null;
  try {
    const live = readSecureAuth(deps.fs, paths.authFile);
    try { liveAccountKey = accountKeyFromAuth(live.value); }
    finally { live.bytes.fill(0); }
  } catch {}
  const accountsByKey = new Map();
  for (const entry of deps.fs.readdirSync(paths.accountsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const saved = readSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, entry.name));
      let candidate;
      try {
        const accountKey = accountKeyFromAuth(saved.value);
        candidate = {
          accountKey,
          label: displayLabelFromAuth(saved.value, entry.name.slice(0, -5)),
          active: marker.status === "ok" && marker.value === entry.name && accountKey === liveAccountKey,
        };
      } finally {
        saved.bytes.fill(0);
      }
      const existing = accountsByKey.get(candidate.accountKey);
      if (!existing) {
        accountsByKey.set(candidate.accountKey, candidate);
      } else {
        existing.active = existing.active || candidate.active;
        if (candidate.active || (!existing.active && candidate.label.localeCompare(existing.label) < 0)) {
          existing.label = candidate.label;
        }
      }
    } catch {}
  }
  const accounts = [...accountsByKey.values()];
  accounts.sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label) || a.accountKey.localeCompare(b.accountKey));
  return { accounts };
}

function updateProjection(deps, paths, mutate) {
  const previous = readAccountProjection(deps, paths);
  const next = JSON.parse(JSON.stringify(previous));
  mutate(next);
  next.version = 1;
  next.revision = previous.revision + 1;
  next.updatedAt = isoNow(deps);
  const accountKeys = new Set(next.accounts.map((account) => account.accountKey));
  next.epochs = next.epochs.filter((epoch) => accountKeys.has(epoch.accountKey)).slice(-PROJECTION_LIMITS.maxEpochs);
  next.quotaSnapshots = next.quotaSnapshots.filter((snapshot) => accountKeys.has(snapshot.accountKey)).slice(-PROJECTION_LIMITS.maxQuotaSnapshots);
  validateAccountProjection(next);
  writeAccountProjection(deps, paths, next);
  return next;
}

function mergeProjectionAccounts(previous, discovered) {
  const currentKeys = new Set(discovered.map((account) => account.accountKey));
  const retained = previous.filter((account) => !currentKeys.has(account.accountKey)).map((account) => ({ ...account, active: false }));
  return [...discovered, ...retained]
    .slice(0, PROJECTION_LIMITS.maxAccounts)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label) || a.accountKey.localeCompare(b.accountKey));
}

function reconcileStartupProjection(deps, rawPaths) {
  const paths = projectionPaths(deps, rawPaths);
  const observedAt = isoNow(deps);
  const discovered = discoverProjectionAccounts(deps, paths);
  return updateProjection(deps, paths, (next) => {
    next.accounts = mergeProjectionAccounts(next.accounts, discovered.accounts);
    const active = discovered.accounts.find((account) => account.active);
    const retained = next.epochs.filter((epoch) => epoch.endedAt !== null || (active && epoch.accountKey === active.accountKey));
    const hasOpenActive = active && retained.some((epoch) => epoch.accountKey === active.accountKey && epoch.endedAt === null);
    next.epochs = retained;
    if (active && !hasOpenActive) next.epochs.push({ accountKey: active.accountKey, startedAt: observedAt, endedAt: null, source: "startup-observation" });
  });
}

function recordSwitchProjection(deps, rawPaths, boundary) {
  const paths = projectionPaths(deps, rawPaths);
  const discovered = discoverProjectionAccounts(deps, paths);
  const targetKey = boundary.accountKey;
  const previousKey = boundary.previousAccountKey;
  if (!targetKey || !discovered.accounts.some((account) => account.accountKey === targetKey)) {
    throw coded("projection-identity-unavailable");
  }
  return updateProjection(deps, paths, (next) => {
    next.accounts = mergeProjectionAccounts(next.accounts, discovered.accounts);
    next.epochs = next.epochs.flatMap((epoch) => {
      if (epoch.endedAt !== null) return [epoch];
      if (previousKey && epoch.accountKey === previousKey) return [{ ...epoch, endedAt: boundary.switchedAt }];
      return [];
    });
    next.epochs.push({ accountKey: targetKey, startedAt: boundary.switchedAt, endedAt: null, source: "confirmed-switch" });
  });
}

function invalidateUnsafeProjection(deps, rawPaths) {
  const paths = projectionPaths(deps, rawPaths);
  try {
    assertTrustedProjectionDirectory(deps, paths.projectionDir, false);
    const stat = lstatIfPresent(deps.fs, paths.projectionFile);
    if (!stat) return;
    const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) return;
    deps.fs.unlinkSync(paths.projectionFile);
    fsyncDirectory(deps.fs, paths.projectionDir);
  } catch { /* a rejected projection remains unreadable to a conforming consumer */ }
}

function lstatIfPresent(fs, file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function logProjectionFailure(api, operation, error) {
  const code = error?.code === "projection-invalid" || error?.code === "projection-untrusted" || error?.code === "projection-write-failed"
    ? error.code
    : "projection-unavailable";
  api?.log?.warn?.("account analytics projection unavailable", `${operation}:${code}`);
}

function startRenderer(api) {
  const state = { api, observer: null, disposed: false, timer: null, page: null };
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = { dispose: () => disposeRenderer(state) };
  const schedule = () => {
    if (state.disposed || state.timer) return;
    state.timer = window.setTimeout(() => { state.timer = null; void injectAccountMenus(state); }, 50);
  };
  const disposeHost = api.react?.host?.observe?.(["account-menu"], (snapshots) => { state.accountMenus = snapshots?.[0]?.matches?.map((match) => match.element) || []; schedule(); });
  const domObserver = new MutationObserver(schedule);
  domObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "aria-label", "data-testid", "open"] });
  state.observer = disposeHost ? { disconnect: disposeHost } : null;
  state.domObserver = domObserver;
  document.addEventListener("pointerdown", schedule, true);
  document.addEventListener("click", schedule, true);
  state.removePointer = () => document.removeEventListener("pointerdown", schedule, true);
  state.removeClick = () => document.removeEventListener("click", schedule, true);
  state.page = api.settings?.registerPage?.({
    id: "accounts",
    title: "Accounts",
    description: "Saved ChatGPT accounts available on this Mac.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="6.5" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M4 16c.7-3 2.7-4.5 6-4.5s5.3 1.5 6 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    render(root) { return renderAccountsPage(state, root); },
  });
  schedule();
}

function renderAccountsPage(state, root) {
  let disposed = false;
  root.textContent = "Loading accounts…";
  state.api.ipc.invoke(IPC, { action: "list" }).then((response) => {
    if (disposed) return;
    root.replaceChildren();
    if (!response?.ok) { root.textContent = "Accounts are unavailable."; return; }
    const card = document.createElement("div");
    card.className = "border-token-border divide-y-[0.5px] divide-token-border overflow-hidden rounded-lg border";
    for (const account of response.accounts) {
      const row = document.createElement("div");
      row.className = "flex items-center justify-between gap-4 p-3";
      const copy = document.createElement("div");
      copy.className = "min-w-0";
      copy.innerHTML = `<div class="truncate text-sm text-token-text-primary"></div><div class="text-sm text-token-text-secondary">${account.active ? "Current account" : "Saved account"}</div>`;
      copy.firstElementChild.textContent = account.label;
      row.append(copy, accountButton(state, account));
      card.append(row);
    }
    if (!response.accounts.length) card.textContent = "No saved accounts yet.";
    const status = document.createElement("div");
    status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
    status.textContent = response.accounts.some((account) => account.active) ? "Ready. The current account is marked below." : "No saved account matches the current session.";
    state.statusElement = status;
    const save = document.createElement("button");
    save.type = "button";
    save.className = "self-start rounded-md border border-token-border bg-token-foreground/5 px-3 py-2 text-sm text-token-text-primary";
    save.textContent = "Save Current";
    save.addEventListener("click", async () => {
      status.textContent = "Saving current account…";
      const saved = await saveCurrentFromMenu(state);
      if (!disposed) status.textContent = saved ? "Current account saved. Reopen this page to refresh the list." : "Save cancelled or unavailable; no success was recorded.";
    });
    root.append(status, save, card);
  }).catch(() => { if (!disposed) root.textContent = "Accounts are unavailable."; });
  return () => { disposed = true; root.replaceChildren(); };
}

async function injectAccountMenus(state) {
  const targetMenu = accountMenuTargetFromCandidates([
    ...(state.accountMenus || []),
    ...directAccountMenuCandidates(),
  ]);
  cleanupAccountSwitcherPanels(targetMenu);
  if (!targetMenu || hasDirectAccountSwitcherPanel(targetMenu)) return;
  // Only hit the main process when there is actually a menu to inject into —
  // dedupe BEFORE the IPC so re-scans of an already-injected menu don't trigger
  // a filesystem list on every DOM mutation.
  let response;
  try {
    response = await state.api.ipc.invoke(IPC, { action: "list" });
  } catch { return; }
  if (!response?.ok || state.disposed) return;
  cleanupAccountSwitcherPanels(targetMenu);
  if (hasDirectAccountSwitcherPanel(targetMenu)) return;
  const panel = document.createElement("div");
  panel.dataset.tweakersAccountSwitcher = "true";
  panel.className = "border-token-border my-1 border-t px-2 py-2";
  const title = document.createElement("div");
  title.className = "px-2 pb-1 text-xs font-medium text-token-text-secondary";
  title.textContent = "Switch ChatGPT account";
  panel.append(title);
  for (const account of response.accounts) panel.append(accountButton(state, account));
  const save = document.createElement("button");
  save.type = "button"; save.className = menuButtonClass(); save.textContent = "Save current session…";
  save.addEventListener("click", () => void saveCurrentFromMenu(state));
  panel.append(save);
  targetMenu.append(panel);
}

function accountButton(state, account) {
  const button = document.createElement("button");
  button.type = "button"; button.className = menuButtonClass();
  button.textContent = `${account.active ? "✓ " : ""}${account.label}`;
  button.disabled = account.active;
  button.addEventListener("click", async () => {
    try {
      if (state.statusElement) state.statusElement.textContent = `Preparing to switch to ${account.label}…`;
      const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-switch", ref: account.ref });
      if (!prepared?.ok) { alertFailure(state, "The account could not be switched safely.", prepared); return; }
      if (!window.confirm(prepared.confirmation)) return;
      const result = await state.api.ipc.invoke(IPC, { action: "switch", intent: prepared.intent });
      if (result?.ok) {
        if (state.statusElement) state.statusElement.textContent = `Switching to ${account.label}; ChatGPT will restart to finish.`;
        if (!result.restartScheduled) window.alert("The account was changed. Restart ChatGPT to finish switching.");
      } else {
        alertFailure(state, "The account could not be switched safely.", result);
      }
    } catch (error) {
      state.api?.log?.warn?.("account switch failed", String(error));
      window.alert("The account could not be switched safely.");
    }
  });
  return button;
}

async function saveCurrentFromMenu(state) {
  const name = window.prompt("Session name (letters, numbers, dots, dashes, or underscores)");
  if (!name) return false;
  try {
    const prepared = await state.api.ipc.invoke(IPC, { action: "prepare-save", name });
    if (!prepared?.ok) { alertFailure(state, "The session could not be saved safely.", prepared); return false; }
    if (!window.confirm(prepared.confirmation)) return false;
    const result = await state.api.ipc.invoke(IPC, { action: "save", intent: prepared.intent });
    if (!result?.ok) { alertFailure(state, "The session could not be saved safely.", result); return false; }
    return true;
  } catch (error) {
    state.api?.log?.warn?.("account save failed", String(error));
    window.alert("The session could not be saved safely.");
    return false;
  }
}

function alertFailure(state, message, response) {
  const code = response?.error?.code;
  state.api?.log?.warn?.(message, code || "unknown");
  window.alert(code ? `${message}\n(${code})` : message);
}

function cleanupRenderer() {
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = null;
}

function disposeRenderer(state) {
  if (state.disposed) return;
  state.disposed = true; state.observer?.disconnect(); state.domObserver?.disconnect(); state.removePointer?.(); state.removeClick?.();
  if (state.timer) clearTimeout(state.timer);
  state.page?.unregister?.();
  document.querySelectorAll("[data-tweakers-account-switcher]").forEach((node) => node.remove());
}

function menuButtonClass() { return "hover:bg-token-foreground/5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-token-text-primary disabled:opacity-60"; }
function directAccountMenuCandidates() {
  const target = accountMenuTargetFromCandidates(Array.from(document.querySelectorAll([
    '[role="menu"]',
    '[role="dialog"]',
    '[popover]',
    '[data-state="open"]',
    '[data-radix-popper-content-wrapper]',
    '[data-radix-popper-content-wrapper] > *',
  ].join(","))));
  return target ? [target] : [];
}
function accountMenuTargetFromCandidates(elements) {
  const candidates = uniqueElements(elements)
    .filter(isAccountMenuCandidate)
    .filter((element, _index, all) => !all.some((other) => other !== element && element.contains(other) && isAccountMenuCandidate(other)))
    .sort((a, b) => candidateScore(b) - candidateScore(a))
    .slice(0, 1);
  return candidates[0] || null;
}
function isAccountMenuCandidate(element) {
  const text = element?.textContent || "";
  if (!/log\s*out/i.test(text)) return false;
  if (!/settings|usage\s+remaining|account/i.test(text)) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width < 160 || rect.height < 120) return false;
  if (rect.width > Math.min(620, window.innerWidth) || rect.height > Math.min(900, window.innerHeight)) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  return true;
}
function candidateScore(element) {
  const text = element.textContent || "";
  let score = 0;
  if (/log\s*out/i.test(text)) score += 4;
  if (/settings/i.test(text)) score += 3;
  if (/usage\s+remaining/i.test(text)) score += 2;
  if (element.getAttribute("role") === "menu" || element.getAttribute("role") === "dialog") score += 2;
  if (element.matches?.("[popover], [data-state='open'], [data-radix-popper-content-wrapper] > *")) score += 1;
  if (element.querySelector?.("[data-tweakers-account-switcher]")) score -= 6;
  const rect = element.getBoundingClientRect?.();
  if (rect) score -= Math.max(0, Math.round((rect.width * rect.height) / 100000));
  return score;
}
function cleanupAccountSwitcherPanels(targetMenu) {
  const panels = Array.from(document.querySelectorAll("[data-tweakers-account-switcher]"));
  let kept = false;
  for (const panel of panels) {
    if (targetMenu && panel.parentElement === targetMenu && !kept) {
      kept = true;
      continue;
    }
    panel.remove();
  }
}
function hasDirectAccountSwitcherPanel(menu) {
  return Array.from(menu?.children || []).some((child) => child?.dataset?.tweakersAccountSwitcher === "true");
}
function uniqueElements(elements) { return [...new Set(elements)].filter(Boolean); }
function displayLabelFromAuth(value, fallback) {
  const directEmail = [value?.user?.email, value?.account?.email, value?.email]
    .find((item) => typeof item === "string" && item.trim());
  if (directEmail) {
    const label = directEmail.trim().slice(0, 120);
    if (validLabel(label)) return label;
  }
  const directName = [value?.user?.name, value?.account?.name, value?.name]
    .find((item) => typeof item === "string" && item.trim());
  const token = value?.tokens?.id_token;
  if (typeof token === "string") {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      const claim = [claims.email, claims.preferred_username, claims.name].find((item) => typeof item === "string" && item.trim());
      if (claim) {
        const label = claim.trim().slice(0, 120);
        if (validLabel(label)) return label;
      }
    } catch {}
  }
  if (directName) {
    const label = directName.trim().slice(0, 120);
    if (validLabel(label)) return label;
  }
  const fallbackLabel = String(fallback || "Saved account").slice(0, 120);
  return validLabel(fallbackLabel) ? fallbackLabel : "Saved account";
}
function safeFailure(code) { return { ok: false, error: { code, message: "The account request could not be completed safely." } }; }
function coded(code) { const error = new Error(code); error.code = code; return error; }
function errorCode(error) { return typeof error?.code === "string" && /^[a-z0-9-]+$/.test(error.code) ? error.code : "operation-failed"; }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!isRecord(value)) return typeof value === "string" ? value.replace(/(?:Bearer\s+\S+|(?:gh[opsu]|sk)-[A-Za-z0-9_-]+)/g, "[redacted]") : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = /token|cookie|secret|password|authorization|path|env|credential/i.test(key) ? "[redacted]" : redact(item);
  return out;
}
