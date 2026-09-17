import { matchesPersistentDirectoryIdentity, preparePersistentIdentityGeneration, journalAndPublishPersistentIdentityGeneration, PERSISTENT_IDENTITIES_JOURNAL } from "./persistent-directory-identity";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isPlainRecord, type OpaqueAccountId, type RouterConfig } from "./types";
import { nativeHistoryAuthIdentityHmacV1, parseNativeHistorySourceV1, readAndPreflightNativeHistorySourceStaticV1, type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceV1 } from "./native-history";

export const NATIVE_AUTH_BINDING_FILE_V1 = "native-auth-binding.v1.json";
type Entry = { opaqueAccountId: OpaqueAccountId; authHome: string; authHomeIdentity: NativeHistoryDirectoryIdentityV1; authIdentityHmac: string };
export interface NativeAuthBindingV1 { version: 1; kind: "account-router-native-auth-binding"; sourceFingerprint: string; accounts: Entry[]; signature: string }
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
/** Absence preserves legacy auth. Malformed or changed companions fail closed. */
export function readNativeAuthBindingV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): { document: NativeAuthBindingV1; fingerprint: string } | null {
  const binding = readNativeAuthBindingAuthorityV1(stateRoot, source, secret);
  for (const entry of binding?.document.accounts ?? []) proveIdentity(entry.authHome, entry, secret);
  return binding;
}

/** Recovery-only authority. Verifies signatures and paths, never claims credentials are valid. */
export function readNativeAuthBindingAuthorityV1(stateRoot: string, source: NativeHistorySourceV1, secret: Buffer): { document: NativeAuthBindingV1; fingerprint: string } | null {
  const path = join(stateRoot, NATIVE_AUTH_BINDING_FILE_V1);
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail(); }
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
    return { document: { ...unsigned, signature: value.signature as string }, fingerprint: digest(bytes) };
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
