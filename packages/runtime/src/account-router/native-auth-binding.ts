import { matchesPersistentDirectoryIdentity, preparePersistentIdentityGeneration, journalAndPublishPersistentIdentityGeneration, readPersistentIdentityGeneration, PERSISTENT_IDENTITIES_JOURNAL } from "./persistent-directory-identity";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isPlainRecord, type BrokerSafeProfileV1, type OpaqueAccountId, type RouterConfig } from "./types";
import { nativeHistoryAuthIdentityHmacV1, parseNativeHistorySourceV1, readAndPreflightNativeHistorySourceStaticV1, type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceV1 } from "./native-history";

export const NATIVE_AUTH_BINDING_FILE_V1 = "native-auth-binding.v1.json";
type Entry = { opaqueAccountId: OpaqueAccountId; authHome: string; authHomeIdentity: NativeHistoryDirectoryIdentityV1; authIdentityHmac: string };
export interface NativeAuthBindingV1 { version: 1; kind: "account-router-native-auth-binding"; sourceFingerprint: string; accounts: Entry[]; signature: string }
interface EffectiveNativeAuthBindingV1 { document: NativeAuthBindingV1; accounts: Entry[]; fingerprint: string }
const EXECUTION_HOME_RECEIPT = "native-execution-home.v1.json";
const executionReceiptFile = (account: OpaqueAccountId) => `accounts/${account}/native-execution-home.v1/${EXECUTION_HOME_RECEIPT}`;
const entryExists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};
export interface NativeExternalTokensV1 { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }
const fail = (): never => { throw new Error("native authentication binding unavailable"); };
const digest = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encode = (value: unknown): string => JSON.stringify(value);
function sameSignature(left: string, right: unknown): boolean {
  return typeof right === "string" && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
const signature = (value: unknown, secret: Buffer): string => `hmac-sha256:${createHmac("sha256", secret).update(`native-auth-binding:v1\0${encode(value)}`).digest("hex")}`;

/** Owner-only no-follow stable reads. Buffers returned here must never cross IPC to a renderer. */
export function readNativeAuthPrivateFileV1(path: string, maximum = 256 * 1024): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const a = fstatSync(fd);
    if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o7077) !== 0 || a.size < 1 || a.size > maximum) return fail();
    const bytes = Buffer.alloc(a.size);
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) return fail(); offset += count; }
    const b = fstatSync(fd); const c = lstatSync(path);
    if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs || c.dev !== a.dev || c.ino !== a.ino || c.isSymbolicLink()) { bytes.fill(0); return fail(); }
    return bytes;
  } catch { return fail(); } finally { if (fd !== undefined) closeSync(fd); }
}
function directory(path: string): NativeHistoryDirectoryIdentityV1 {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) return fail();
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7077) !== 0) return fail();
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`); }
function authHomeLocationSafe(home: string, stateRoot: string, account: OpaqueAccountId): boolean {
  if (!overlaps(home, stateRoot)) return true;
  if (home !== join(stateRoot, "accounts", account, "execution-home")) return false;
  directory(join(stateRoot, "accounts")); directory(join(stateRoot, "accounts", account));
  return true;
}
function parseAuth(home: string): Record<string, unknown> {
  const bytes = readNativeAuthPrivateFileV1(join(home, "auth.json"));
  try { const value: unknown = JSON.parse(bytes.toString("utf8")); if (!isPlainRecord(value) || !isPlainRecord(value.tokens)) return fail(); return value.tokens; }
  catch { return fail(); } finally { bytes.fill(0); }
}
function proveIdentity(home: string, entry: Pick<Entry, "opaqueAccountId" | "authIdentityHmac">, secret: Buffer): Record<string, unknown> {
  const tokens = parseAuth(home); const raw = tokens.account_id;
  if (typeof raw !== "string" || nativeHistoryAuthIdentityHmacV1(raw, secret) !== entry.authIdentityHmac
    || `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}` !== entry.opaqueAccountId) return fail();
  return tokens;
}
export function readNativeExternalTokensV1(home: string, entry: Pick<Entry, "opaqueAccountId" | "authIdentityHmac">, secret: Buffer): NativeExternalTokensV1 {
  const tokens = proveIdentity(home, entry, secret);
  if (typeof tokens.access_token !== "string" || !tokens.access_token || tokens.access_token.length > 128 * 1024 || /[\s\x00-\x1f]/.test(tokens.access_token)) return fail();
  return { accessToken: tokens.access_token, chatgptAccountId: tokens.account_id as string, chatgptPlanType: null };
}
/** Saved credential display facts grant no authentication or mutation authority. */
export function readNativeSavedProfileV1(home: string, entry: Pick<Entry, "opaqueAccountId" | "authIdentityHmac">, secret: Buffer): BrokerSafeProfileV1 | null {
  const tokens = proveIdentity(home, entry, secret);
  if (typeof tokens.id_token !== "string" || tokens.id_token.length > 128 * 1024) return null;
  const parts = tokens.id_token.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const bytes = Buffer.from(parts[1]!, "base64url");
  try {
    const claims: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isPlainRecord(claims) || !isPlainRecord(claims["https://api.openai.com/auth"])) return null;
    const auth = claims["https://api.openai.com/auth"];
    // Do not treat an arbitrary email claim beside a bound account_id as the
    // identity of that account. The stored token must name the same account.
    if (auth.chatgpt_account_id !== tokens.account_id) return null;
    const email = claims.email;
    if (typeof email !== "string" || email.length > 254 || /[\s\x00-\x1f\x7f]/.test(email)) return null;
    const parts = email.split("@");
    const local = parts[0], domain = parts[1]?.toLowerCase();
    if (parts.length !== 2 || !local || !domain || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local)
      || !/^(?=.{1,80}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(domain)) return null;
    const visible = local.slice(0, Math.min(3, local.length));
    const plan = typeof auth.chatgpt_plan_type === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : null;
    return { identifierMasked: `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`, plan, avatarUrl: null };
  } catch { return null; } finally { bytes.fill(0); }
}
/** Absence preserves legacy auth. Malformed or changed companions fail closed. */
export function readNativeAuthBindingV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): EffectiveNativeAuthBindingV1 | null {
  const binding = readNativeAuthBindingAuthorityV1(stateRoot, source, secret);
  for (const entry of binding?.accounts ?? []) proveIdentity(entry.authHome, entry, secret);
  return binding;
}

/** Recovery-only authority. Verifies signatures and paths, never claims credentials are valid. */
export function readNativeAuthBindingAuthorityV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): EffectiveNativeAuthBindingV1 | null {
  const path = join(stateRoot, NATIVE_AUTH_BINDING_FILE_V1);
  try { lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT"
      && !source.accounts.some(account => entryExists(join(stateRoot, executionReceiptFile(account.opaqueAccountId))))) return null;
    return fail();
  }
  directory(stateRoot);
  const bytes = readNativeAuthPrivateFileV1(path, 64 * 1024);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isPlainRecord(value) || Object.keys(value).sort().join() !== "accounts,kind,signature,sourceFingerprint,version" || value.version !== 1 || value.kind !== "account-router-native-auth-binding" || !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > source.accounts.length) return fail();
    const entries: Entry[] = [];
    for (const item of value.accounts) {
      if (!isPlainRecord(item) || Object.keys(item).sort().join() !== "authHome,authHomeIdentity,authIdentityHmac,opaqueAccountId" || typeof item.authHome !== "string") return fail();
      const original = source.accounts.find((a) => a.opaqueAccountId === item.opaqueAccountId);
      const identity = item.authHomeIdentity;
      if (!original || item.authIdentityHmac !== original.authIdentityHmac || !isPlainRecord(identity)
        || Object.keys(identity).sort().join() !== "device,inode,mode,uid"
        || ![identity.device, identity.inode, identity.uid, identity.mode].every((v) => Number.isSafeInteger(v) && (v as number) >= 0)
        || entries.some((entry) => entry.opaqueAccountId === original.opaqueAccountId)) return fail();
      entries.push({ opaqueAccountId: original.opaqueAccountId, authHome: item.authHome,
        authHomeIdentity: { device: identity.device as number, inode: identity.inode as number, uid: identity.uid as number, mode: identity.mode as number },
        authIdentityHmac: original.authIdentityHmac });
    }
    const unsigned = { version: 1 as const, kind: "account-router-native-auth-binding" as const, sourceFingerprint: value.sourceFingerprint as string, accounts: entries };
    // Verify the authority before opening any path named by the companion.
    if (secret.length !== 32 || !sameSignature(signature(unsigned, secret), value.signature)) return fail();
    const sourceBytes = readNativeAuthPrivateFileV1(join(stateRoot, "native-history-source.v1.json"), 64 * 1024);
    try { if (value.sourceFingerprint !== digest(sourceBytes)) return fail(); } finally { sourceBytes.fill(0); }
    for (const entry of entries) {
      if (!matchesPersistentDirectoryIdentity({ stateRoot, secret, path: entry.authHome, expected: entry.authHomeIdentity, authorityFile: NATIVE_AUTH_BINDING_FILE_V1, accountId: entry.opaqueAccountId })
        || source.accounts.some((a) => overlaps(entry.authHome, a.codexHome) || overlaps(entry.authHome, a.sqliteHome))
        || !authHomeLocationSafe(entry.authHome, stateRoot, entry.opaqueAccountId)
        || entries.some((other) => other !== entry && overlaps(other.authHome, entry.authHome))) return fail();
    }
    const baseFingerprint = digest(bytes), accounts = [...entries], receipts: string[] = [];
    for (const original of source.accounts) {
      const authorityFile = executionReceiptFile(original.opaqueAccountId), receiptPath = join(stateRoot, authorityFile);
      if (!entryExists(receiptPath)) continue;
      directory(join(stateRoot, "accounts", original.opaqueAccountId, "native-execution-home.v1"));
      const receiptBytes = readNativeAuthPrivateFileV1(receiptPath, 64 * 1024);
      try {
        const receipt: unknown = JSON.parse(receiptBytes.toString("utf8"));
        if (!isPlainRecord(receipt) || Object.keys(receipt).sort().join() !== "baseFingerprint,entry,kind,signature,sourceFingerprint,version"
          || receipt.version !== 1 || receipt.kind !== "account-router-native-execution-home" || receipt.baseFingerprint !== baseFingerprint
          || receipt.sourceFingerprint !== unsigned.sourceFingerprint || !isPlainRecord(receipt.entry)) return fail();
        const { signature: signed, ...body } = receipt;
        const expected = `hmac-sha256:${createHmac("sha256", secret).update(`native-execution-home:v1\0${encode(body)}`).digest("hex")}`;
        if (!sameSignature(expected, signed)) return fail();
        const entry = receipt.entry as unknown as Entry;
        if (Object.keys(entry).sort().join() !== "authHome,authHomeIdentity,authIdentityHmac,opaqueAccountId"
          || entry.opaqueAccountId !== original.opaqueAccountId || entry.authIdentityHmac !== original.authIdentityHmac
          || entry.authHome !== join(stateRoot, "accounts", original.opaqueAccountId, "execution-home")
          || accounts.some(account => account.opaqueAccountId === entry.opaqueAccountId || overlaps(account.authHome, entry.authHome))
          || source.accounts.some(account => overlaps(entry.authHome, account.codexHome) || overlaps(entry.authHome, account.sqliteHome))
          || !authHomeLocationSafe(entry.authHome, stateRoot, entry.opaqueAccountId)
          || !matchesPersistentDirectoryIdentity({ stateRoot, secret, path: entry.authHome, expected: entry.authHomeIdentity,
            authorityFile, accountId: entry.opaqueAccountId })) return fail();
        accounts.push(entry); receipts.push(digest(receiptBytes));
      } finally { receiptBytes.fill(0); }
    }
    return { document: { ...unsigned, signature: value.signature as string }, accounts,
      fingerprint: receipts.length ? digest(Buffer.from(encode([baseFingerprint, ...receipts]))) : baseFingerprint };
  } catch { return fail(); } finally { bytes.fill(0); }
}

export interface PreparedNativeAuthBindingV1 { readonly sourceFingerprint: string; readonly accounts: readonly { opaqueAccountId: OpaqueAccountId; authHome: string }[] }
const prepared = new WeakMap<PreparedNativeAuthBindingV1, { stateRoot: string; config: RouterConfig; secret: Buffer; bytes: Buffer; sourceFingerprint: string }>();
/** Offline-only preparation. No original credentials are read and no source document is rewritten. */
export function prepareNativeAuthBindingV1(input: { stateRoot: string; config: RouterConfig; secret: Buffer; expectedSourceFingerprint: string; accounts: readonly { opaqueAccountId: OpaqueAccountId; authHome: string }[] }): PreparedNativeAuthBindingV1 {
  directory(input.stateRoot);
  if (existsSync(join(input.stateRoot, PERSISTENT_IDENTITIES_JOURNAL))) return fail();
  try { lstatSync(join(input.stateRoot, NATIVE_AUTH_BINDING_FILE_V1)); return fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail(); }
  const bytes = readNativeAuthPrivateFileV1(join(input.stateRoot, "native-history-source.v1.json"), 64 * 1024);
  try {
    if (digest(bytes) !== input.expectedSourceFingerprint) return fail();
    const source = parseNativeHistorySourceV1(JSON.parse(bytes.toString("utf8")), input.config, input.secret);
    if (!source || !input.accounts.length || input.accounts.length > source.accounts.length) return fail();
    for (const account of source.accounts) {
      for (const [path, expected] of [[account.codexHome, account.codexHomeIdentity], [account.sqliteHome, account.sqliteHomeIdentity]] as const) {
        const stat = lstatSync(path);
        if (realpathSync(path) !== path || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0
          || !matchesPersistentDirectoryIdentity({ stateRoot: input.stateRoot, secret: input.secret, path, expected, authorityFile: "native-history-source.v1.json", accountId: account.opaqueAccountId })) return fail();
      }
    }
    const accounts = input.accounts.map((item) => {
      const original = source.accounts.find((a) => a.opaqueAccountId === item.opaqueAccountId);
      if (!original || input.accounts.filter((a) => a.opaqueAccountId === item.opaqueAccountId).length !== 1
        || !authHomeLocationSafe(item.authHome, input.stateRoot, original.opaqueAccountId) || source.accounts.some((a) => overlaps(item.authHome, a.codexHome) || overlaps(item.authHome, a.sqliteHome))
        || input.accounts.some((a) => a !== item && overlaps(item.authHome, a.authHome))) return fail();
      const entry = { opaqueAccountId: original.opaqueAccountId, authHome: item.authHome, authHomeIdentity: directory(item.authHome), authIdentityHmac: original.authIdentityHmac };
      readNativeExternalTokensV1(item.authHome, entry, input.secret); return entry;
    }).sort((a, b) => a.opaqueAccountId.localeCompare(b.opaqueAccountId));
    const unsigned = { version: 1 as const, kind: "account-router-native-auth-binding" as const, sourceFingerprint: digest(bytes), accounts };
    const result = Object.freeze({ sourceFingerprint: digest(bytes), accounts: accounts.map(({ opaqueAccountId, authHome }) => ({ opaqueAccountId, authHome })) });
    prepared.set(result, { stateRoot: input.stateRoot, config: input.config, secret: Buffer.from(input.secret), bytes: Buffer.from(`${encode({ ...unsigned, signature: signature(unsigned, input.secret) })}\n`), sourceFingerprint: digest(bytes) });
    return result;
  } finally { bytes.fill(0); }
}
/** One exclusive atomic publication. Existing evidence is never overwritten. Parent owns the offline writer census. */
export function publishPreparedNativeAuthBindingV1(value: PreparedNativeAuthBindingV1): void {
  const plan = prepared.get(value); if (!plan) return fail();
  const fresh = prepareNativeAuthBindingV1({ ...plan, expectedSourceFingerprint: plan.sourceFingerprint, accounts: value.accounts });
  const rechecked = prepared.get(fresh)!;
  if (!plan.bytes.equals(rechecked.bytes)) return fail();
  const target = join(plan.stateRoot, NATIVE_AUTH_BINDING_FILE_V1);
  const temporary = join(plan.stateRoot, `.native-auth-binding-${randomBytes(16).toString("hex")}`);
  writeFileSync(temporary, plan.bytes, { mode: 0o600, flag: "wx" });
  const fd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(temporary, target); } finally { unlinkSync(temporary); }
  const rootFd = openSync(plan.stateRoot, constants.O_RDONLY); try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
  try {
    if (process.platform === "darwin") {
      const proposal = preparePersistentIdentityGeneration({ stateRoot: plan.stateRoot, secret: plan.secret,
        verify: () => readAndPreflightNativeHistorySourceStaticV1(plan.stateRoot, plan.config, plan.secret).state === "ready" });
      journalAndPublishPersistentIdentityGeneration(plan.stateRoot, plan.secret, proposal);
    }
  } finally { plan.secret.fill(0); rechecked.secret.fill(0); prepared.delete(fresh); prepared.delete(value); }
}

/**
 * Called only by the elected broker before admitting children. Complete an
 * older partial migration without replacing its signed registration. Each
 * additional original account gets one immutable, account-specific receipt.
 */
export function ensureNativeExecutionHomesV1(input: {
  stateRoot: string; config: RouterConfig; secret: Buffer;
  authorizeCopy(account: OpaqueAccountId, destination: string): boolean;
}): void {
  const { stateRoot, config, secret } = input;
  if (existsSync(join(stateRoot, PERSISTENT_IDENTITIES_JOURNAL))) return fail();
  const initial = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
  if (initial.state !== "ready") return fail();
  const source = initial.binding.source, sourceFingerprint = initial.binding.sourceDocumentFingerprint;
  const prior = readNativeAuthBindingV1(stateRoot, source, secret);
  if (!prior) throw new Error("Stock account execution-home migration requires an existing signed auth binding");
  const missing = config.accounts.filter(account => account.included && !prior?.accounts.some(entry => entry.opaqueAccountId === account.opaqueAccountId));
  const staged: Array<{ opaqueAccountId: OpaqueAccountId; authHome: string }> = [];
  const authorized = () => missing.every(account => input.authorizeCopy(account.opaqueAccountId, join(stateRoot, "accounts", account.opaqueAccountId, "execution-home")));
  if (missing.length && !authorized()) throw new Error("Stock account execution-home migration requires its original account and destination to be idle");
  for (const account of missing) {
    const original = source.accounts.find(entry => entry.opaqueAccountId === account.opaqueAccountId);
    if (!original) throw new Error("Stock account execution-home migration requires an original signed account");
    readNativeExternalTokensV1(original.codexHome, original, secret);
    const home = join(stateRoot, "accounts", account.opaqueAccountId, "execution-home");
    for (const path of [join(stateRoot, "accounts"), join(stateRoot, "accounts", account.opaqueAccountId), home]) {
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      directory(path);
    }
    if (readdirSync(home).some(name => name !== "auth.json")) throw new Error("Unregistered execution-home contains data; retain it for recovery");
    const bytes = readNativeAuthPrivateFileV1(join(original.codexHome, "auth.json"));
    try {
      const target = join(home, "auth.json");
      if (existsSync(target)) {
        const stagedBytes = readNativeAuthPrivateFileV1(target);
        try { if (!bytes.equals(stagedBytes)) throw new Error("Unregistered execution-home authentication changed; retain it for recovery"); }
        finally { stagedBytes.fill(0); }
      } else {
        // Rename a complete directory, never an incomplete credential file.
        // POSIX refuses to replace a nonempty destination directory. The
        // elected broker owns publication; a raced auth file is preserved.
        const staging = join(stateRoot, "accounts", account.opaqueAccountId, `.execution-home-${randomBytes(16).toString("hex")}.staging`);
        mkdirSync(staging, { mode: 0o700 });
        const fd = openSync(join(staging, "auth.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        const stagingFd = openSync(staging, constants.O_RDONLY); try { fsyncSync(stagingFd); } finally { closeSync(stagingFd); }
        if (!authorized() || readdirSync(home).length) return fail();
        directory(home);
        renameSync(staging, home);
        const parentFd = openSync(join(stateRoot, "accounts", account.opaqueAccountId), constants.O_RDONLY);
        try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
      }
      readNativeExternalTokensV1(home, original, secret);
      const current = readNativeAuthPrivateFileV1(join(original.codexHome, "auth.json"));
      try { if (!bytes.equals(current) || !authorized()) return fail(); } finally { current.fill(0); }
      const fd = openSync(home, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); }
      staged.push({ opaqueAccountId: original.opaqueAccountId, authHome: home });
    } finally { bytes.fill(0); }
  }
  for (const account of staged) {
    const fresh = readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret);
    if (fresh.state !== "ready" || fresh.binding.sourceDocumentFingerprint !== sourceFingerprint
      || !authorized() || readNativeAuthBindingV1(stateRoot, source, secret)?.accounts.some(entry => entry.opaqueAccountId === account.opaqueAccountId)) return fail();
    const baseBytes = readNativeAuthPrivateFileV1(join(stateRoot, NATIVE_AUTH_BINDING_FILE_V1), 64 * 1024);
    try {
      // Bind the exact original document; it and every prior account remain intact.
      const original = source.accounts.find(entry => entry.opaqueAccountId === account.opaqueAccountId)!;
      const originalAuth = readNativeAuthPrivateFileV1(join(original.codexHome, "auth.json"));
      const copiedAuth = readNativeAuthPrivateFileV1(join(account.authHome, "auth.json"));
      try { if (!originalAuth.equals(copiedAuth)) return fail(); }
      finally { originalAuth.fill(0); copiedAuth.fill(0); }
      const entry: Entry = { ...account, authHomeIdentity: directory(account.authHome), authIdentityHmac: original.authIdentityHmac };
      const body = { version: 1, kind: "account-router-native-execution-home", sourceFingerprint, baseFingerprint: digest(baseBytes), entry };
      const signature = `hmac-sha256:${createHmac("sha256", secret).update(`native-execution-home:v1\0${encode(body)}`).digest("hex")}`;
      const receiptRoot = join(stateRoot, "accounts", account.opaqueAccountId, "native-execution-home.v1");
      const stagingRoot = `${receiptRoot}.${randomBytes(16).toString("hex")}.staging`;
      mkdirSync(stagingRoot, { mode: 0o700 });
      const temporary = join(stagingRoot, EXECUTION_HOME_RECEIPT);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, encode({ ...body, signature }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      const stagingFd = openSync(stagingRoot, constants.O_RDONLY); try { fsyncSync(stagingFd); } finally { closeSync(stagingFd); }
      if (entryExists(receiptRoot) || !authorized()) return fail();
      // A published nonempty receipt directory cannot be replaced by rename.
      // No hard-link window can strand a valid receipt with nlink === 2.
      renameSync(stagingRoot, receiptRoot);
      const rootFd = openSync(join(stateRoot, "accounts", account.opaqueAccountId), constants.O_RDONLY);
      try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
    } finally { baseBytes.fill(0); }
  }
  // An interrupted publication may have its immutable receipt but not its
  // persistent anchors. Exact-device validation remains required until sealed.
  const identities = readPersistentIdentityGeneration(stateRoot, secret);
  const unanchored = source.accounts.some(account => entryExists(join(stateRoot, executionReceiptFile(account.opaqueAccountId)))
    && !identities?.document.anchors.some(anchor => anchor.authorityFile === executionReceiptFile(account.opaqueAccountId)));
  if (process.platform === "darwin" && (staged.length || unanchored)) {
    const proposal = preparePersistentIdentityGeneration({ stateRoot, secret,
      verify: () => readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret).state === "ready" });
    journalAndPublishPersistentIdentityGeneration(stateRoot, secret, proposal);
  }
  if (readAndPreflightNativeHistorySourceStaticV1(stateRoot, config, secret).state !== "ready") return fail();
}
