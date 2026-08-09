"use strict";

const IPC = "accounts";
const SERVICE_KEY = "__tweakersAccountServiceV1";
const HANDLER_KEY = "__tweakersAccountHandlerV1";
const MAX_AUTH_BYTES = 1024 * 1024;
const INTENT_TTL_MS = 30_000;
// Kept inline so the only program, script, and arguments passed to the helper
// are fixed by this source. The inherited fd 3 is a descriptor for the already
// opened home root; no filesystem path crosses the process boundary.
const LEGACY_ANALYTICS_NEUTRALIZER = String.raw`import os

_root_fd = 3
_opened = []

def _trusted_directory(fd, uid):
    _stat = os.fstat(fd)
    return (
        (_stat.st_mode & 0o170000) == 0o040000
        and _stat.st_uid == uid
        and (_stat.st_mode & 0o022) == 0
    )

try:
    _uid = os.getuid()
    _directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    _file_flags = os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    _home_fd = os.open(".", _directory_flags, dir_fd=_root_fd)
    _opened.append(_home_fd)
    _current_fd = _home_fd
    if not _trusted_directory(_current_fd, _uid):
        raise OSError
    for _component in ("Library", "Application Support", "codex-plusplus"):
        _next_fd = os.open(_component, _directory_flags, dir_fd=_current_fd)
        _opened.append(_next_fd)
        _current_fd = _next_fd
        if not _trusted_directory(_current_fd, _uid):
            raise OSError
    _target_fd = os.open("account-analytics.v1.json", _file_flags, dir_fd=_current_fd)
    _opened.append(_target_fd)
    _target_stat = os.fstat(_target_fd)
    if (
        (_target_stat.st_mode & 0o170000) != 0o100000
        or _target_stat.st_uid != _uid
        or _target_stat.st_nlink != 1
        or (_target_stat.st_mode & 0o077) != 0
    ):
        raise OSError
    os.ftruncate(_target_fd, 0)
    os.fsync(_target_fd)
except BaseException:
    pass
finally:
    for _fd in reversed(_opened):
        try:
            os.close(_fd)
        except OSError:
            pass
`;

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
    cleanupLegacyAnalytics, accountMenuTargetFromCandidates, startRenderer, disposeRenderer,
  },
};

function startMain(api) {
  const deps = nodeDeps();
  const paths = authPaths(deps);
  cleanupLegacyAnalytics(deps);
  const service = createAccountService(api, { deps, paths, onSwitched: () => scheduleHostRestart(api) });
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
    dispose() { disposed = true; stopSnapshotSync(); intents.clear(); refs.clear(); },
  };

  // Refresh tokens rotate on every renewal, so a saved snapshot goes stale
  // the moment the live session refreshes; restoring a stale snapshot trips
  // OAuth reuse detection and the server REVOKES the whole token family
  // (observed 2026-07-13). Keep the active account's snapshot in lockstep
  // with auth.json so switching back always presents current tokens.
  const stopSnapshotSync = startActiveSnapshotSync(deps, paths, api, () => disposed);
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
  let readingSnapshot = true;
  try {
    return withSecureAuth(fs, target, (snapshot) => {
      readingSnapshot = false;
      return withSecureAuth(fs, paths.authFile, (current) => {
        if (!current.bytes.length || current.hash === snapshot.hash) return;
        // Only propagate tokens for the SAME account; a manual re-login to a
        // different account must not overwrite another account's snapshot.
        const currentAccount = authAccountId(current.value);
        const snapshotAccount = authAccountId(snapshot.value);
        if (!currentAccount || currentAccount !== snapshotAccount) return;
        atomicWrite(deps, paths.accountsDir, target, current.bytes);
      });
    });
  } catch (error) {
    if (readingSnapshot) return; // Snapshot missing/invalid: nothing safe to sync into.
    throw error;
  }
}

function authAccountId(value) {
  const id = value?.tokens?.account_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function listAccounts(deps, paths, refs) {
  try {
    refs.clear();
    const accountsDirectoryExists = deps.fs.existsSync(paths.accountsDir);
    if (accountsDirectoryExists) ensureAccountsDirectory(deps.fs, paths.accountsDir, false);
    const current = readCurrentMarker(deps.fs, paths.currentMarker);
    let liveAccountId = null;
    try {
      liveAccountId = withSecureAuth(deps.fs, paths.authFile, (live) => authAccountId(live.value));
    } catch {}
    const accounts = [];
    if (accountsDirectoryExists) {
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
          const account = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, entry.name), (auth) => ({
            ref: opaque,
            label: displayLabelFromAuth(auth.value, name),
            active: current.value === entry.name
              && Boolean(liveAccountId)
              && authAccountId(auth.value) === liveAccountId,
          }));
          refs.set(opaque, entry.name);
          accounts.push(account);
        } catch {}
      }
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
      const snapshot = withSecureAuth(deps.fs, sourceFilePath(deps.path, paths.accountsDir, target), (value) => ({
        identity: value.identity,
        hash: value.hash,
      }));
      pruneIntents(intents, deps.now());
      const intent = deps.randomUUID();
      intents.set(intent, { action, target, snapshot, expiresAt: deps.now() + INTENT_TTL_MS });
      return { ok: true, intent, confirmation: "Switch Codex to this saved session?" };
    } else {
      target = validateReferenceName(rawValue);
      if (deps.fs.existsSync(sourcePath(deps.path, paths.accountsDir, target))) throw coded("account-exists");
      withSecureAuth(deps.fs, paths.authFile, () => undefined);
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
    if (intent.action === "switch") switchAccount(deps, paths, intent.target, intent.snapshot);
    else saveCurrent(deps, paths, intent.target);
    refs.clear();
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
  return withSecureAuth(fs, source, (selected) => {
    if (!snapshot || selected.identity !== snapshot.identity || selected.hash !== snapshot.hash) throw coded("source-changed");
    return withSecureAuth(fs, paths.authFile, (current) => {
      if (!current.bytes.length) throw coded("no-last-known-good");
      return withSecureAuth(fs, source, (revalidated) => {
        if (selected.identity !== revalidated.identity || selected.hash !== revalidated.hash) throw coded("source-changed");
        return withOptionalSecureBytes(fs, paths.currentMarker, 256, (previousMarker) => (
          withOptionalSecureBytes(fs, paths.lkgFile, MAX_AUTH_BYTES, (previousLkg) => (
            commitSwitch(deps, paths, filename, current, revalidated, previousMarker, previousLkg)
          ))
        ));
      });
    });
  });
}

function commitSwitch(deps, paths, filename, current, revalidated, previousMarker, previousLkg) {
  const fs = deps.fs;
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
        previousActiveSnapshot = withSecureAuth(fs, activeSnapshotPath, (savedActive) => {
          const liveAccount = authAccountId(current.value);
          const savedAccount = authAccountId(savedActive.value);
          if (!liveAccount || liveAccount !== savedAccount) throw coded("active-account-mismatch");
          return Buffer.from(savedActive.bytes);
        });
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
    clearSecretBuffer(previousActiveSnapshot);
  }
  if (!completed) throw coded("auth-write-failed");
}

function saveCurrent(deps, paths, name) {
  assertTrustedDirectory(deps.fs, paths.codexDir);
  ensureAccountsDirectory(deps.fs, paths.accountsDir, true);
  assertTrustedDirectory(deps.fs, paths.accountsDir);
  return withSecureAuth(deps.fs, paths.authFile, (current) => {
    const target = sourcePath(deps.path, paths.accountsDir, name);
    createExclusiveAtomic(deps, paths.accountsDir, target, current.bytes);
  });
}

function withSecureAuth(fs, file, callback) {
  let snapshot;
  try {
    snapshot = readSecureAuth(fs, file);
    return callback(snapshot);
  } finally {
    clearSecretBuffer(snapshot?.bytes);
  }
}

function withOptionalSecureBytes(fs, file, maxBytes, callback) {
  let bytes;
  try {
    bytes = readOptionalSecureBytes(fs, file, maxBytes);
    return callback(bytes);
  } finally {
    clearSecretBuffer(bytes);
  }
}

function clearSecretBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function readSecureAuth(fs, file) {
  let fd;
  let bytes;
  let transferred = false;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > MAX_AUTH_BYTES) throw coded("invalid-auth-source");
    bytes = Buffer.alloc(stat.size);
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
    const snapshot = { bytes, value, hash: createHash("sha256").update(bytes).digest("hex"), identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` };
    fs.closeSync(fd);
    fd = undefined;
    transferred = true;
    return snapshot;
  } catch (error) {
    if (error?.code && String(error.code).startsWith("invalid-")) throw error;
    throw coded("invalid-auth-source");
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (!transferred) clearSecretBuffer(bytes);
    }
  }
}

function readOptionalSecureBytes(fs, file, maxBytes) {
  let bytes;
  let transferred = false;
  try {
    if (!fs.existsSync(file)) return null;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) throw coded("invalid-existing-state");
    bytes = fs.readFileSync(file);
    transferred = true;
    return bytes;
  } finally {
    if (!transferred) clearSecretBuffer(bytes);
  }
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
  return {
    codexDir,
    accountsDir: deps.path.join(codexDir, "auth_accounts"),
    authFile: deps.path.join(codexDir, "auth.json"),
    currentMarker: deps.path.join(codexDir, "current_account"),
    lkgFile: deps.path.join(codexDir, "auth.account-switcher-lkg.json"),
  };
}

function cleanupLegacyAnalytics(deps) {
  const fs = deps?.fs;
  const path = deps?.path;
  const spawnSync = deps?.spawnSync;
  const constants = fs?.constants;
  if (!fs || !path || typeof deps?.homedir !== "function" || typeof fs.openSync !== "function" || typeof fs.closeSync !== "function" || typeof spawnSync !== "function") return;
  if (!Number.isInteger(constants?.O_RDONLY) || !Number.isInteger(constants?.O_DIRECTORY) || !Number.isInteger(constants?.O_NOFOLLOW)) return;

  let homeDir;
  let homeFd;
  try {
    homeDir = path.resolve(deps.homedir());
    // Opening this root once binds the helper to a stable descriptor. The
    // helper traverses the fixed descendants fd-relatively with O_NOFOLLOW.
    homeFd = fs.openSync(homeDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    spawnSync("/usr/bin/python3", ["-I", "-S", "-c", LEGACY_ANALYTICS_NEUTRALIZER], {
      stdio: ["ignore", "ignore", "ignore", homeFd],
      timeout: 1_000,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
    });
  } catch {
    // This best-effort expiry is deliberately content-blind and nonfatal.
  } finally {
    try {
      if (Number.isInteger(homeFd)) fs.closeSync(homeFd);
    } catch {
      // Do not let an opaque close failure change startup behavior.
    }
  }
}

function stableRef(filename) {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(String(filename)).digest("hex").slice(0, 32);
}

function validLabel(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}

function nodeDeps() {
  const { randomUUID } = require("node:crypto");
  const { spawnSync } = require("node:child_process");
  return {
    fs: require("node:fs"),
    path: require("node:path"),
    homedir: require("node:os").homedir,
    codexHome: typeof process !== "undefined" ? (process.env.CODEX_HOME || null) : null,
    getuid: typeof process !== "undefined" && typeof process.getuid === "function" ? () => process.getuid() : null,
    spawnSync,
    randomUUID,
    now: Date.now,
  };
}

function startRenderer(api) {
  const state = { api, observer: null, disposed: false, timer: null, page: null, accountMenus: [] };
  globalThis.__tweakersAccountRendererV1?.dispose?.();
  globalThis.__tweakersAccountRendererV1 = { dispose: () => disposeRenderer(state) };
  const schedule = () => {
    if (state.disposed || state.timer) return;
    state.timer = window.setTimeout(() => { state.timer = null; void injectAccountMenus(state); }, 50);
  };
  const disposeHost = api.react?.host?.observe?.(["account-menu"], (snapshots) => {
    const accountMenu = snapshots?.find((snapshot) => snapshot?.kind === "account-menu");
    state.accountMenus = (accountMenu?.matches || [])
      .filter((match) => match?.kind === "account-menu" && match?.confidence === "high" && match.element)
      .map((match) => match.element);
    schedule();
  });
  state.observer = typeof disposeHost === "function" ? { disconnect: disposeHost } : null;
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
  const targetMenu = accountMenuTargetFromCandidates(state.accountMenus || []);
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
  const currentTarget = accountMenuTargetFromCandidates(state.accountMenus || []);
  if (currentTarget !== targetMenu) {
    cleanupAccountSwitcherPanels(currentTarget);
    return;
  }
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
  state.disposed = true; state.observer?.disconnect();
  if (state.timer) clearTimeout(state.timer);
  state.page?.unregister?.();
  document.querySelectorAll("[data-tweakers-account-switcher]").forEach((node) => node.remove());
}

function menuButtonClass() { return "hover:bg-token-foreground/5 flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm text-token-text-primary disabled:opacity-60"; }
function accountMenuTargetFromCandidates(elements) {
  const candidates = uniqueElements(elements)
    .filter(isAccountMenuCandidate)
    .filter((element, _index, all) => !all.some((other) => other !== element && element.contains(other) && isAccountMenuCandidate(other)));
  return candidates.length === 1 ? candidates[0] : null;
}
function isAccountMenuCandidate(element) {
  const role = element?.getAttribute?.("role");
  if (role !== "menu" && role !== "dialog") return false;
  const text = element?.textContent || "";
  if (!/log\s*out/i.test(text)) return false;
  if (!/settings|usage\s+remaining|account/i.test(text)) return false;
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width < 160 || rect.height < 120) return false;
  if (rect.width > Math.min(620, window.innerWidth) || rect.height > Math.min(900, window.innerHeight)) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) return false;
  return true;
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
