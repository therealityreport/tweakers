"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DRAFT_STORE_VERSION = 1;
const DRAFT_DIRECTORY = "user-questions-drafts.v1";
const INSTALL_SECRET_FILE = "install-secret";
const MAX_DRAFT_BYTES = 256 * 1024;
const MAX_DRAFTS = 20;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ROUTE_RE = /^[A-Za-z0-9._~:-]{16,512}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

class DraftStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "DraftStoreError";
    this.code = code;
  }
}

function createDraftStore(options = {}) {
  const dataDir = requireAbsolutePath(options.dataDir);
  const tweakId = requireId(options.tweakId || "co.tweakers.user-questions", "tweak_id_invalid");
  const now = typeof options.now === "function" ? options.now : Date.now;
  const random = typeof options.randomBytes === "function" ? options.randomBytes : crypto.randomBytes;
  const root = path.join(dataDir, DRAFT_DIRECTORY);
  preparePrivateDirectory(dataDir);
  preparePrivateDirectory(root);
  const installSecret = loadOrCreateInstallSecret(root, random);

  function fingerprint(input) {
    return inputFingerprint(input);
  }

  function identity(params) {
    const taskRouteId = requireTaskRoute(params?.taskRouteId);
    const roundId = requireId(params?.roundId || params?.input?.round_id, "round_id_invalid");
    const inputHash = params?.inputFingerprint || fingerprint(params?.input);
    if (typeof inputHash !== "string" || !/^[a-f0-9]{64}$/.test(inputHash)) {
      throw new DraftStoreError("input_fingerprint_invalid");
    }
    const routeKey = hmacHex(installSecret, `route\0${taskRouteId}`);
    const draftKey = hmacHex(installSecret, `draft\0${routeKey}\0${roundId}\0${inputHash}`);
    return Object.freeze({ routeKey, draftKey, inputHash, filePath: path.join(root, `${draftKey}.json`) });
  }

  function save(params = {}) {
    const id = identity(params);
    const state = requireState(params.state);
    const expectedRevision = params.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new DraftStoreError("expected_revision_invalid");
    }
    if (state.revision !== expectedRevision + 1) throw new DraftStoreError("revision_invalid");
    const resumeToken = params.resumeToken === undefined
      ? newResumeToken(random)
      : requireResumeToken(params.resumeToken);
    return withDraftLock(id, () => {
      pruneExpiredAndCorrupt();
      const existing = readRecordIfPresent(id, { quarantine: true });
      if (existing) {
        if (existing.revision !== expectedRevision) throw new DraftStoreError("revision_conflict");
        if (params.resumeToken !== undefined) {
          const suppliedHash = hmacHex(installSecret, `token\0${resumeToken}`);
          if (!secureEqual(suppliedHash, existing.resume_token_hash)) {
            throw new DraftStoreError("resume_token_invalid");
          }
        }
      } else if (expectedRevision !== 0 && params.allowCreate !== true) {
        throw new DraftStoreError("revision_conflict");
      }
      const timestamp = nowInteger(now);
      const record = {
        version: DRAFT_STORE_VERSION,
        tweak_id: tweakId,
        draft_key: id.draftKey,
        route_key: id.routeKey,
        input_fingerprint: id.inputHash,
        revision: state.revision,
        updated_at: timestamp,
        expires_at: timestamp + DRAFT_TTL_MS,
        resume_token_hash: hmacHex(installSecret, `token\0${resumeToken}`),
        state: structuredClone(state),
      };
      writeRecord(id.filePath, record);
      enforceRetention(id.filePath);
      return Object.freeze({
        resume_token: resumeToken,
        revision: record.revision,
        expires_at: record.expires_at,
        input_fingerprint: id.inputHash,
      });
    });
  }

  function load(params = {}) {
    const id = identity(params);
    const resumeToken = requireResumeToken(params.resumeToken);
    return withDraftLock(id, () => {
      const record = readRecordIfPresent(id, { quarantine: true });
      if (!record) throw new DraftStoreError("draft_not_found");
      if (record.expires_at <= nowInteger(now)) {
        removeFileDurably(id.filePath);
        throw new DraftStoreError("draft_expired");
      }
      const suppliedHash = hmacHex(installSecret, `token\0${resumeToken}`);
      if (!secureEqual(suppliedHash, record.resume_token_hash)) {
        throw new DraftStoreError("resume_token_invalid");
      }
      // Loading is intentionally non-consuming. The caller must keep the
      // supplied token usable until it can return a successful terminal result
      // with the replacement token, otherwise a mount or host-display failure
      // would strand an otherwise valid draft.
      return Object.freeze({
        state: structuredClone(record.state),
        revision: record.revision,
        resume_token: resumeToken,
        expires_at: record.expires_at,
        input_fingerprint: id.inputHash,
      });
    });
  }

  function commitResume(params = {}) {
    const id = identity(params);
    const resumeToken = requireResumeToken(params.resumeToken);
    return withDraftLock(id, () => {
      const record = readRecordIfPresent(id, { quarantine: true });
      if (!record) throw new DraftStoreError("draft_not_found");
      if (record.expires_at <= nowInteger(now)) {
        removeFileDurably(id.filePath);
        throw new DraftStoreError("draft_expired");
      }
      const suppliedHash = hmacHex(installSecret, `token\0${resumeToken}`);
      if (!secureEqual(suppliedHash, record.resume_token_hash)) {
        throw new DraftStoreError("resume_token_invalid");
      }
      const nextToken = newResumeToken(random);
      const rotated = {
        ...record,
        updated_at: nowInteger(now),
        resume_token_hash: hmacHex(installSecret, `token\0${nextToken}`),
      };
      writeRecord(id.filePath, rotated);
      return Object.freeze({
        resume_token: nextToken,
        revision: record.revision,
        expires_at: record.expires_at,
        input_fingerprint: id.inputHash,
      });
    });
  }

  function discard(params = {}) {
    const id = identity(params);
    return withDraftLock(id, () => removeFileDurably(id.filePath));
  }

  function prune() {
    return pruneExpiredAndCorrupt();
  }

  function inspect() {
    const entries = listDraftEntries();
    return Object.freeze({ drafts: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.size, 0) });
  }

  function readRecordIfPresent(id, options = {}) {
    let stat;
    try { stat = fs.lstatSync(id.filePath); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new DraftStoreError("draft_read_failed");
    }
    try {
      assertPrivateFile(stat);
      if (stat.size > MAX_DRAFT_BYTES) throw new DraftStoreError("draft_oversize");
      const record = JSON.parse(fs.readFileSync(id.filePath, "utf8"));
      validateRecord(record, id, tweakId);
      return record;
    } catch (error) {
      if (options.quarantine === true) quarantine(id.filePath, random);
      if (error instanceof DraftStoreError) throw error;
      throw new DraftStoreError("draft_corrupt");
    }
  }

  function pruneExpiredAndCorrupt() {
    let removed = 0;
    for (const entry of listDraftEntries()) {
      try {
        assertPrivateFile(entry.stat);
        if (entry.size > MAX_DRAFT_BYTES) throw new DraftStoreError("draft_oversize");
        const parsed = JSON.parse(fs.readFileSync(entry.filePath, "utf8"));
        validateListedRecord(parsed, path.basename(entry.filePath, ".json"), tweakId);
        if (parsed.expires_at <= nowInteger(now)) {
          if (removeFileDurably(entry.filePath)) removed += 1;
        }
      } catch {
        quarantine(entry.filePath, random);
        removed += 1;
      }
    }
    return removed;
  }

  function enforceRetention(protectedPath) {
    const entries = listDraftEntries().sort((left, right) => left.mtimeMs - right.mtimeMs);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (count <= MAX_DRAFTS && total <= MAX_TOTAL_BYTES) break;
      if (entry.filePath === protectedPath) continue;
      if (removeFileDurably(entry.filePath)) {
        count -= 1;
        total -= entry.size;
      }
    }
    const protectedStat = fs.lstatSync(protectedPath);
    if (count > MAX_DRAFTS || total > MAX_TOTAL_BYTES || protectedStat.size > MAX_DRAFT_BYTES) {
      removeFileDurably(protectedPath);
      throw new DraftStoreError("draft_capacity");
    }
  }

  function listDraftEntries() {
    let names;
    try { names = fs.readdirSync(root); }
    catch { throw new DraftStoreError("draft_read_failed"); }
    const entries = [];
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const filePath = path.join(root, name);
      try {
        const stat = fs.lstatSync(filePath);
        entries.push({ filePath, stat, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    return entries;
  }

  return Object.freeze({
    save,
    load,
    commitResume,
    discard,
    cleanupSubmitted: discard,
    prune,
    inspect,
    fingerprint,
    taskRouteKey: (taskRouteId) => hmacHex(installSecret, `route\0${requireTaskRoute(taskRouteId)}`),
  });
}

function inputFingerprint(input) {
  if (!isRecord(input) || !Array.isArray(input.questions)) throw new DraftStoreError("input_invalid");
  const normalized = { ...input };
  delete normalized.resume_token;
  return crypto.createHash("sha256").update(stableStringify(normalized), "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function loadOrCreateInstallSecret(root, random) {
  const secretPath = path.join(root, INSTALL_SECRET_FILE);
  const existing = readInstallSecret(secretPath);
  if (existing) return existing;
  const secret = random(32);
  if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) throw new DraftStoreError("random_source_invalid");
  let descriptor;
  try {
    descriptor = fs.openSync(
      secretPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, Buffer.from(secret.toString("hex"), "utf8"));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fsyncDirectory(root);
    return Buffer.from(secret);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    if (error?.code === "EEXIST") {
      const raced = readInstallSecret(secretPath);
      if (raced) return raced;
    }
    if (error instanceof DraftStoreError) throw error;
    throw new DraftStoreError("install_secret_write_failed");
  }
}

function readInstallSecret(secretPath) {
  try {
    const stat = fs.lstatSync(secretPath);
    assertPrivateFile(stat);
    const value = fs.readFileSync(secretPath, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new DraftStoreError("install_secret_invalid");
    return Buffer.from(value, "hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function preparePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DraftStoreError("data_dir_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new DraftStoreError("data_dir_owner_invalid");
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function writeRecord(filePath, record) {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  if (bytes.byteLength > MAX_DRAFT_BYTES) throw new DraftStoreError("draft_oversize");
  atomicWrite(filePath, bytes);
}

function atomicWrite(filePath, bytes) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (error instanceof DraftStoreError) throw error;
    throw new DraftStoreError("draft_write_failed");
  }
}

function withDraftLock(id, operation) {
  const lockPath = `${id.filePath}.lock`;
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch {
    throw new DraftStoreError("revision_conflict");
  }
  try {
    return operation();
  } finally {
    try { fs.closeSync(descriptor); } catch {}
    try { fs.rmSync(lockPath, { force: true }); } catch {}
  }
}

function removeFileDurably(filePath) {
  try { fs.unlinkSync(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new DraftStoreError("draft_delete_failed");
  }
  fsyncDirectory(path.dirname(filePath));
  return true;
}

function quarantine(filePath, random) {
  try {
    const suffix = random(8).toString("hex");
    const destination = `${filePath}.corrupt.${Date.now()}.${suffix}`;
    fs.renameSync(filePath, destination);
    fs.chmodSync(destination, 0o600);
    fsyncDirectory(path.dirname(filePath));
  } catch {}
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateRecord(record, id, tweakId) {
  if (!isRecord(record)) throw new DraftStoreError("draft_corrupt");
  const expected = [
    "version", "tweak_id", "draft_key", "route_key", "input_fingerprint", "revision",
    "updated_at", "expires_at", "resume_token_hash", "state",
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DraftStoreError("draft_corrupt");
  }
  if (
    record.version !== DRAFT_STORE_VERSION || record.tweak_id !== tweakId || record.draft_key !== id.draftKey ||
    record.route_key !== id.routeKey || record.input_fingerprint !== id.inputHash ||
    !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !Number.isSafeInteger(record.updated_at) || !Number.isSafeInteger(record.expires_at) ||
    typeof record.resume_token_hash !== "string" || !/^[a-f0-9]{64}$/.test(record.resume_token_hash) ||
    !isRecord(record.state) || record.state.revision !== record.revision
  ) throw new DraftStoreError("draft_corrupt");
}

function validateListedRecord(record, draftKey, tweakId) {
  if (!isRecord(record)) throw new DraftStoreError("draft_corrupt");
  if (
    record.version !== DRAFT_STORE_VERSION || record.tweak_id !== tweakId ||
    record.draft_key !== draftKey || !/^[a-f0-9]{64}$/.test(record.route_key || "") ||
    !/^[a-f0-9]{64}$/.test(record.input_fingerprint || "") ||
    !Number.isSafeInteger(record.revision) || record.revision < 1 ||
    !Number.isSafeInteger(record.updated_at) || !Number.isSafeInteger(record.expires_at) ||
    typeof record.resume_token_hash !== "string" || !/^[a-f0-9]{64}$/.test(record.resume_token_hash) ||
    !isRecord(record.state) || record.state.revision !== record.revision
  ) throw new DraftStoreError("draft_corrupt");
}

function assertPrivateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DraftStoreError("draft_file_invalid");
  if ((stat.mode & 0o777) !== 0o600) throw new DraftStoreError("draft_permissions_invalid");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new DraftStoreError("draft_owner_invalid");
}

function requireAbsolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new DraftStoreError("data_dir_invalid");
  return path.resolve(value);
}

function requireId(value, code) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new DraftStoreError(code);
  return value;
}

function requireTaskRoute(value) {
  if (typeof value !== "string" || !ROUTE_RE.test(value)) throw new DraftStoreError("task_route_unavailable");
  return value;
}

function requireResumeToken(value) {
  if (typeof value !== "string" || !TOKEN_RE.test(value)) throw new DraftStoreError("resume_token_invalid");
  return value;
}

function requireState(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new DraftStoreError("state_invalid");
  }
  return value;
}

function newResumeToken(random) {
  const bytes = random(32);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 32) throw new DraftStoreError("random_source_invalid");
  return bytes.toString("base64url");
}

function hmacHex(secret, value) {
  return crypto.createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

function secureEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function nowInteger(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new DraftStoreError("clock_invalid");
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  DRAFT_DIRECTORY,
  DRAFT_STORE_VERSION,
  DRAFT_TTL_MS,
  MAX_DRAFT_BYTES,
  MAX_DRAFTS,
  MAX_TOTAL_BYTES,
  DraftStoreError,
  createDraftStore,
  inputFingerprint,
};
