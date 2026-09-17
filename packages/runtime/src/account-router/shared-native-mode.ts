import { persistentIdentityProposalFingerprint, matchesPersistentDirectoryIdentity, preparePersistentIdentityGeneration, journalAndPublishPersistentIdentityGeneration } from "./persistent-directory-identity";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { abortUnpublishedSharedSourceRebase, loadSharedAccountBase, loadSharedPluginsManifestV1, type AccountContinuityWriteEvidenceV1 } from "./account-continuity";
import { refreshNativeHistoryBindingAfterIdentityPublication, nativeHistoryBindingSafeV1, readAndPreflightNativeHistorySourceStaticV1, signNativeHistorySourceV1, type NativeHistoryDirectoryIdentityV1, type NativeHistorySourceBindingV1 } from "./native-history";
import { isOpaqueAccountId, isPlainRecord, type OpaqueAccountId } from "./types";

export const SHARED_NATIVE_MODE_FILE_V1 = "shared-native-mode.v1.json";
export const SHARED_NATIVE_MODE_TRANSITION_FILE_V1 = "shared-native-mode-transition.v1.json";
type Sha256 = `sha256:${string}`;
type Root = { path: string; identity: NativeHistoryDirectoryIdentityV1 };
export interface SharedNativeModeV1 {
  version: 1;
  kind: "account-router-shared-native-mode";
  sourceFingerprint: Sha256;
  sourceAccountId: OpaqueAccountId;
  nativeBase: Root;
  overlay: Root;
  resolverProtocol: "shared-native-overlay-v1";
  resolverBinarySha256: string;
  retiredCopyState: { priorSharedFingerprint: Sha256; priorPluginsFingerprint: Sha256; abortedRebaseFingerprint: Sha256 | null };
  signature: string;
}
export interface SharedNativeModeContextV1 { stateRoot: string; binding: NativeHistorySourceBindingV1; secret: Buffer }
export interface SharedNativeModePlanV1 {
  version: 1;
  kind: "account-router-shared-native-mode-transition";
  document: SharedNativeModeV1;
  rebaseDocumentFingerprint: Sha256 | null;
  signature: string;
}
type Blocked = { state: "blocked"; reason: string };
export type SharedNativeModeReadResultV1 = { state: "absent" } | Blocked | {
  state: "ready"; document: SharedNativeModeV1; fingerprint: Sha256;
  environment: { TWEAKERS_NATIVE_BASE_ROOT: string; TWEAKERS_OVERLAY_ROOT: string };
};
export type SharedNativeModePublishResultV1 = Blocked | { state: "published"; document: SharedNativeModeV1; fingerprint: Sha256; binding: NativeHistorySourceBindingV1 };
export interface PrepareSharedNativeModeInputV1 extends SharedNativeModeContextV1 {
  overlayPath: string; expectedSourceFingerprint: Sha256; expectedRebaseIntentFingerprint: Sha256 | null; resolverBinarySha256: string;
}
interface WriteInput extends SharedNativeModeContextV1 {
  accountWriteEvidence?: Readonly<Record<string, AccountContinuityWriteEvidenceV1>>;
  /** Existing-test interruption seam, never supplied by production callers. */
  faultAt?: "after_intent" | "after_abort" | "after_publication";
}
const REBASE_FILE = "shared-source-rebase-intent.v1.json";
const ACCOUNT_INTENTS = ["config-materialization-intent.v1.json", "plugin-projection-intent.v1.json", "native-initial-capture-intent.v1.json"];
const fail = (reason: string): never => { throw new Error(reason); };
const blocked = (error: unknown): Blocked => ({ state: "blocked", reason: error instanceof Error ? error.message : "shared native mode unavailable" });
const hash = (bytes: string | Buffer): Sha256 => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const bytes = (value: unknown): Buffer => Buffer.from(canonical(value) + "\n");
const fingerprint = (value: unknown): Sha256 => hash(bytes(value));
const sha = (value: unknown): value is Sha256 => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const exact = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).sort().join() === keys.sort().join();
function mac(value: unknown, secret: Buffer, domain: string): string {
  if (secret.length !== 32) return fail("invalid shared native signing key");
  return `hmac-sha256:${createHmac("sha256", secret).update(domain + "\0" + canonical(value)).digest("hex")}`;
}
function signed<T extends object>(value: T, secret: Buffer, domain: string): T & { signature: string } { return { ...value, signature: mac(value, secret, domain) }; }
function verify(value: Record<string, unknown>, secret: Buffer, domain: string): void {
  const { signature, ...unsigned } = value;
  const expected = mac(unsigned, secret, domain);
  if (typeof signature !== "string" || Buffer.byteLength(signature) !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail("invalid shared native signature");
}
function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directory(path: string, privateOnly = true): NativeHistoryDirectoryIdentityV1 {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) return fail("noncanonical shared native root");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & (privateOnly ? 0o7077 : 0o7022))) return fail("unsafe shared native root");
  return { device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o7777 };
}
function read(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o7077) || before.size < 1 || before.size > 4 * 1024 * 1024) return fail("unsafe shared native document");
    const result = readFileSync(fd); const after = fstatSync(fd); const current = lstatSync(path);
    if (result.length !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) return fail("shared native document changed");
    return result;
  } finally { closeSync(fd); }
}
function sync(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** An exclusive link publishes a complete fsynced file, never a partial final document. */
function publish(path: string, content: Buffer): void {
  const temp = join(dirname(path), `.shared-native-${randomBytes(16).toString("hex")}`);
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try { sync(temp); linkSync(temp, path); sync(dirname(path)); }
  finally { unlinkSync(temp); sync(dirname(path)); }
}
function overlap(a: string, b: string): boolean { return a === b || a.startsWith(b + "/") || b.startsWith(a + "/"); }
function contextSafe(context: SharedNativeModeContextV1): void {
  directory(context.stateRoot);
  if (context.binding.stateRoot !== context.stateRoot || !nativeHistoryBindingSafeV1(context.binding)) fail("native history binding changed");
  const { signature, ...source } = context.binding.source;
  if (signNativeHistorySourceV1(source, context.secret).signature !== signature) fail("native source signing key mismatch");
}
function noAccountRecovery(context: SharedNativeModeContextV1): void {
  for (const account of context.binding.accounts) {
    const root = join(context.stateRoot, "accounts", account.opaqueAccountId);
    if (present(root)) { directory(join(context.stateRoot, "accounts")); directory(root); }
    for (const name of ACCOUNT_INTENTS) if (present(join(root, name))) fail("unrelated account continuity recovery is pending");
  }
}
function sharedRoot(context: SharedNativeModeContextV1): string { const root = join(context.stateRoot, "shared-account-config"); directory(root); return root; }
function parseDocument(value: unknown, context: SharedNativeModeContextV1): SharedNativeModeV1 {
  if (!isPlainRecord(value) || !exact(value, ["version", "kind", "sourceFingerprint", "sourceAccountId", "nativeBase", "overlay", "resolverProtocol", "resolverBinarySha256", "retiredCopyState", "signature"])
    || value.version !== 1 || value.kind !== "account-router-shared-native-mode" || !sha(value.sourceFingerprint) || !isOpaqueAccountId(value.sourceAccountId)
    || value.resolverProtocol !== "shared-native-overlay-v1" || typeof value.resolverBinarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.resolverBinarySha256)) return fail("invalid shared native registration");
  verify(value, context.secret, "shared-native-mode:v1");
  for (const root of [value.nativeBase, value.overlay]) {
    if (!isPlainRecord(root) || !exact(root, ["path", "identity"]) || typeof root.path !== "string" || !isPlainRecord(root.identity)
      || !exact(root.identity, ["device", "inode", "uid", "mode"]) || !Object.values(root.identity).every((v) => Number.isSafeInteger(v) && (v as number) >= 0)) return fail("invalid shared native root identity");
  }
  const retired = value.retiredCopyState;
  if (!isPlainRecord(retired) || !exact(retired, ["priorSharedFingerprint", "priorPluginsFingerprint", "abortedRebaseFingerprint"]) || !sha(retired.priorSharedFingerprint) || !sha(retired.priorPluginsFingerprint) || !(retired.abortedRebaseFingerprint === null || sha(retired.abortedRebaseFingerprint))) return fail("invalid retired copy state");
  const document = value as unknown as SharedNativeModeV1;
  const original = context.binding.source.accounts.find((a) => a.opaqueAccountId === document.sourceAccountId);
  if (document.sourceFingerprint !== context.binding.sourceDocumentFingerprint || document.sourceAccountId !== context.binding.source.metadataAccountId || !original
    || document.nativeBase.path !== original.codexHome || canonical(document.nativeBase.identity) !== canonical(original.codexHomeIdentity)
    || !matchesPersistentDirectoryIdentity({ stateRoot: context.stateRoot, secret: context.secret, path: document.nativeBase.path, expected: document.nativeBase.identity, authorityFile: "native-history-source.v1.json", accountId: document.sourceAccountId })
    || !(present(join(context.stateRoot, SHARED_NATIVE_MODE_FILE_V1))
      ? matchesPersistentDirectoryIdentity({ stateRoot: context.stateRoot, secret: context.secret, path: document.overlay.path, expected: document.overlay.identity, authorityFile: SHARED_NATIVE_MODE_FILE_V1, accountId: document.sourceAccountId })
      : canonical(directory(document.overlay.path)) === canonical(document.overlay.identity))) return fail("shared native source or root changed");
  if (!document.overlay.path.startsWith(context.stateRoot + "/")
    || ["accounts", "shared-account-config"].some((name) => overlap(join(context.stateRoot, name), document.overlay.path))
    || context.binding.accounts.some((a) => [a.codexHome, a.sqliteHome].some((root) => overlap(root, document.overlay.path)))) return fail("shared overlay must be manager-owned and disjoint from history and continuity state");
  return document;
}
function parsePlan(value: unknown, context: SharedNativeModeContextV1): SharedNativeModePlanV1 {
  if (!isPlainRecord(value) || !exact(value, ["version", "kind", "document", "rebaseDocumentFingerprint", "signature"]) || value.version !== 1 || value.kind !== "account-router-shared-native-mode-transition"
    || !(value.rebaseDocumentFingerprint === null || sha(value.rebaseDocumentFingerprint))) return fail("invalid shared native transition");
  verify(value, context.secret, "shared-native-mode-transition:v1");
  const document = parseDocument(value.document, context);
  if ((value.rebaseDocumentFingerprint === null) !== (document.retiredCopyState.abortedRebaseFingerprint === null)) return fail("invalid shared native retirement proof");
  return value as unknown as SharedNativeModePlanV1;
}
function priorGlobals(context: SharedNativeModeContextV1, document: SharedNativeModeV1): void {
  sharedRoot(context);
  if (loadSharedAccountBase(context.stateRoot)?.fingerprint !== document.retiredCopyState.priorSharedFingerprint
    || loadSharedPluginsManifestV1(context.stateRoot)?.fingerprint !== document.retiredCopyState.priorPluginsFingerprint) fail("copy manifests were published or changed");
}
function archiveRebasePath(context: SharedNativeModeContextV1, digest: Sha256): string { return join(sharedRoot(context), `shared-source-rebase-aborted-${digest.slice(7)}.v1.json`); }

export function readSharedNativeModeV1(context: SharedNativeModeContextV1): SharedNativeModeReadResultV1 {
  try {
    directory(context.stateRoot);
    if (present(join(context.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1))) return blocked(new Error("shared native transition recovery is pending"));
    const path = join(context.stateRoot, SHARED_NATIVE_MODE_FILE_V1);
    if (!present(path)) return { state: "absent" };
    contextSafe(context); noAccountRecovery(context);
    if (present(join(context.stateRoot, "shared-account-config"))) sharedRoot(context);
    if (present(join(context.stateRoot, "shared-account-config", REBASE_FILE))) fail("shared source rebase recovery is pending");
    const content = read(path); const document = parseDocument(JSON.parse(content.toString("utf8")), context);
    return { state: "ready", document, fingerprint: hash(content), environment: { TWEAKERS_NATIVE_BASE_ROOT: document.nativeBase.path, TWEAKERS_OVERLAY_ROOT: document.overlay.path } };
  } catch (error) { return blocked(error); }
}

export function prepareSharedNativeModeV1(input: PrepareSharedNativeModeInputV1): { state: "prepared"; plan: SharedNativeModePlanV1; fingerprint: Sha256 } | Blocked {
  try {
    contextSafe(input); noAccountRecovery(input);
    if (present(join(input.stateRoot, SHARED_NATIVE_MODE_FILE_V1)) || present(join(input.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1))) fail("shared native registration or transition already exists");
    if (input.expectedSourceFingerprint !== input.binding.sourceDocumentFingerprint) fail("native source fingerprint changed");
    const shared = loadSharedAccountBase(input.stateRoot); const plugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!shared || !plugins) fail("copy manifests unavailable");
    const path = join(sharedRoot(input), REBASE_FILE);
    let rebaseDocumentFingerprint: Sha256 | null = null;
    if (input.expectedRebaseIntentFingerprint !== null) {
      if (!sha(input.expectedRebaseIntentFingerprint)) fail("invalid expected rebase fingerprint");
      const preview = abortUnpublishedSharedSourceRebase({ stateRoot: input.stateRoot, accounts: input.binding.accounts, expectedIntentFingerprint: input.expectedRebaseIntentFingerprint });
      if (preview.state !== "would_abort") fail(preview.reason ?? "expected rebase is unavailable");
      rebaseDocumentFingerprint = hash(read(path));
    } else if (present(path)) fail("unexpected shared source rebase");
    const original = input.binding.source.accounts.find((a) => a.opaqueAccountId === input.binding.source.metadataAccountId)!;
    const document: SharedNativeModeV1 = signed({ version: 1 as const, kind: "account-router-shared-native-mode" as const,
      sourceFingerprint: input.expectedSourceFingerprint, sourceAccountId: original.opaqueAccountId,
      nativeBase: { path: original.codexHome, identity: { ...original.codexHomeIdentity } }, overlay: { path: input.overlayPath, identity: directory(input.overlayPath) },
      resolverProtocol: "shared-native-overlay-v1" as const, resolverBinarySha256: input.resolverBinarySha256,
      retiredCopyState: { priorSharedFingerprint: shared!.fingerprint, priorPluginsFingerprint: plugins!.fingerprint, abortedRebaseFingerprint: input.expectedRebaseIntentFingerprint } }, input.secret, "shared-native-mode:v1");
    parseDocument(document, input);
    const plan = signed({ version: 1 as const, kind: "account-router-shared-native-mode-transition" as const, document, rebaseDocumentFingerprint }, input.secret, "shared-native-mode-transition:v1");
    return { state: "prepared", plan, fingerprint: fingerprint(plan) };
  } catch (error) { return blocked(error); }
}

function finish(input: WriteInput, plan: SharedNativeModePlanV1, transitionFingerprint: Sha256): SharedNativeModePublishResultV1 {
  contextSafe(input); noAccountRecovery(input); parsePlan(plan, input); priorGlobals(input, plan.document);
  const transitionPath = join(input.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
  const finalPath = join(input.stateRoot, SHARED_NATIVE_MODE_FILE_V1);
  const finalBytes = bytes(plan.document);
  const assertTransition = (): void => {
    contextSafe(input); noAccountRecovery(input); parsePlan(plan, input); priorGlobals(input, plan.document);
    if (hash(read(transitionPath)) !== transitionFingerprint) fail("shared native transition changed");
    if (present(finalPath) && !read(finalPath).equals(finalBytes)) fail("conflicting shared native registration");
  };
  assertTransition();
  const rebasePath = join(sharedRoot(input), REBASE_FILE);
  const retired = plan.document.retiredCopyState.abortedRebaseFingerprint;
  if (retired !== null) {
    if (present(rebasePath)) {
      const rebaseBytes = read(rebasePath);
      if (hash(rebaseBytes) !== plan.rebaseDocumentFingerprint) fail("pending rebase document changed");
      const journal: unknown = JSON.parse(rebaseBytes.toString("utf8"));
      if (!isPlainRecord(journal) || !Array.isArray(journal.accounts)) fail("invalid pending rebase accounts");
      for (const entry of (journal as { accounts: unknown[] }).accounts) {
        if (!isPlainRecord(entry) || typeof entry.opaqueAccountId !== "string") fail("invalid pending rebase account");
        const evidence = input.accountWriteEvidence?.[(entry as { opaqueAccountId: string }).opaqueAccountId];
        if (!evidence?.accountChildAbsent || typeof evidence.nativeWriterCensus !== "function") fail("native copy retirement requires fresh writer evidence");
      }
      const result = abortUnpublishedSharedSourceRebase({ stateRoot: input.stateRoot, accounts: input.binding.accounts,
        expectedIntentFingerprint: retired, accountWriteEvidence: input.accountWriteEvidence, apply: true });
      if (result.state !== "aborted") fail(result.reason ?? "shared rebase could not be retired");
    }
    if (hash(read(archiveRebasePath(input, retired))) !== plan.rebaseDocumentFingerprint) fail("retired rebase evidence changed");
  }
  if (present(rebasePath)) fail("unexpected rebase recovery remains");
  if (input.faultAt === "after_abort") fail("injected shared native fault after abort");
  assertTransition();
  if (present(finalPath)) { if (!read(finalPath).equals(finalBytes)) fail("conflicting shared native registration"); }
  else publish(finalPath, finalBytes);
  if (input.faultAt === "after_publication") fail("injected shared native fault after publication");
  assertTransition();
  const archive = join(input.stateRoot, `shared-native-mode-transition-completed-${transitionFingerprint.slice(7)}.v1.json`);
  if (present(archive)) { if (hash(read(archive)) !== transitionFingerprint) fail("conflicting transition archive"); }
  else { linkSync(transitionPath, archive); sync(input.stateRoot); }
  assertTransition(); unlinkSync(transitionPath); sync(input.stateRoot);
  const result = readSharedNativeModeV1(input);
  if (result.state !== "ready" || result.fingerprint !== hash(finalBytes)) return fail("published shared native registration failed readback");
  if (process.platform === "darwin") {
    const proposal = preparePersistentIdentityGeneration({ stateRoot: input.stateRoot, secret: input.secret,
      verify: () => readSharedNativeModeV1(input).state === "ready" });
    journalAndPublishPersistentIdentityGeneration(input.stateRoot, input.secret, proposal);
    input.binding = refreshNativeHistoryBindingAfterIdentityPublication(input.binding, persistentIdentityProposalFingerprint(proposal));
  }
  return { state: "published", document: result.document, fingerprint: result.fingerprint, binding: input.binding };
}

export function publishSharedNativeModeV1(input: WriteInput & { plan: SharedNativeModePlanV1; expectedPlanFingerprint: Sha256 }): SharedNativeModePublishResultV1 {
  try {
    contextSafe(input); noAccountRecovery(input); const plan = parsePlan(input.plan, input);
    if (fingerprint(plan) !== input.expectedPlanFingerprint) fail("shared native plan changed");
    const transitionPath = join(input.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
    if (present(transitionPath)) fail("shared native transition requires explicit recovery");
    if (present(join(input.stateRoot, SHARED_NATIVE_MODE_FILE_V1))) {
      const current = readSharedNativeModeV1(input);
      if (current.state === "ready" && current.fingerprint === fingerprint(plan.document)) return { state: "published", document: current.document, fingerprint: current.fingerprint, binding: input.binding };
      fail("shared native registration already exists");
    }
    priorGlobals(input, plan.document);
    publish(transitionPath, bytes(plan));
    if (input.faultAt === "after_intent") fail("injected shared native fault after intent");
    return finish(input, plan, input.expectedPlanFingerprint);
  } catch (error) { return blocked(error); }
}

export function recoverSharedNativeModeV1(input: WriteInput & { expectedTransitionFingerprint: Sha256 }): SharedNativeModePublishResultV1 {
  try {
    contextSafe(input); noAccountRecovery(input);
    if (!sha(input.expectedTransitionFingerprint)) fail("invalid expected transition fingerprint");
    const path = join(input.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
    if (!present(path)) {
      const archive = join(input.stateRoot, `shared-native-mode-transition-completed-${input.expectedTransitionFingerprint.slice(7)}.v1.json`);
      const content = read(archive);
      if (hash(content) !== input.expectedTransitionFingerprint) fail("completed transition evidence changed");
      const plan = parsePlan(JSON.parse(content.toString("utf8")), input); const current = readSharedNativeModeV1(input);
      if (current.state !== "ready" || current.fingerprint !== fingerprint(plan.document)) return fail("completed transition registration changed");
      return { state: "published", document: current.document, fingerprint: current.fingerprint, binding: input.binding };
    }
    const content = read(path);
    if (hash(content) !== input.expectedTransitionFingerprint) fail("shared native recovery transaction changed");
    return finish(input, parsePlan(JSON.parse(content.toString("utf8")), input), input.expectedTransitionFingerprint);
  } catch (error) { return blocked(error); }
}

export interface SharedNativeResolverRepairBindingV1 {
  operationId: string;
  promotionId: string;
  journalSha256: string;
  priorRepairFingerprint: string | null;
  appFingerprintSha256: string;
  runtimeFingerprintSha256: string;
}

export interface SharedNativeResolverTransitionV1 {
  version: 1;
  kind: "account-router-shared-native-resolver-transition";
  binding: SharedNativeResolverRepairBindingV1;
  priorDocumentBytes: string;
  priorFingerprint: Sha256;
  document: SharedNativeModeV1;
  signature: string;
}

function parseResolverTransition(value: unknown, context: SharedNativeModeContextV1): SharedNativeResolverTransitionV1 {
  if (!isPlainRecord(value) || !exact(value, ["version", "kind", "binding", "priorDocumentBytes", "priorFingerprint", "document", "signature"])
    || value.version !== 1 || value.kind !== "account-router-shared-native-resolver-transition" || !sha(value.priorFingerprint)
    || typeof value.priorDocumentBytes !== "string" || hash(value.priorDocumentBytes) !== value.priorFingerprint
    || !isPlainRecord(value.binding) || !exact(value.binding, ["operationId", "promotionId", "journalSha256", "priorRepairFingerprint", "appFingerprintSha256", "runtimeFingerprintSha256"])) return fail("invalid shared native resolver transition");
  verify(value, context.secret, "shared-native-resolver-transition:v1");
  const binding = value.binding as unknown as SharedNativeResolverRepairBindingV1;
  for (const id of [binding.operationId, binding.promotionId]) if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) fail("invalid resolver repair identity");
  for (const digest of [binding.journalSha256, binding.appFingerprintSha256, binding.runtimeFingerprintSha256,
    ...(binding.priorRepairFingerprint === null ? [] : [binding.priorRepairFingerprint])]) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) fail("invalid resolver repair fingerprint");
  }
  const prior = parseDocument(JSON.parse(value.priorDocumentBytes), context);
  const next = parseDocument(value.document, context);
  const { signature: _oldSignature, resolverBinarySha256: _oldResolver, ...oldFields } = prior;
  const { signature: _newSignature, resolverBinarySha256: _newResolver, ...newFields } = next;
  if (canonical(oldFields) !== canonical(newFields) || prior.resolverBinarySha256 === next.resolverBinarySha256) fail("resolver transition must change only the resolver binary");
  return value as unknown as SharedNativeResolverTransitionV1;
}

/** Prepare a signed resolver-only CAS without changing the installed registration. */
export function prepareSharedNativeResolverTransitionV1(input: SharedNativeModeContextV1 & {
  expectedRegistrationFingerprint: Sha256;
  resolverBinarySha256: string;
  repairBinding: SharedNativeResolverRepairBindingV1;
}): { state: "prepared"; plan: SharedNativeResolverTransitionV1; fingerprint: Sha256 } | Blocked {
  try {
    const current = readSharedNativeModeV1(input);
    if (current.state !== "ready" || current.fingerprint !== input.expectedRegistrationFingerprint) return fail("shared native resolver registration changed");
    const priorDocumentBytes = read(join(input.stateRoot, SHARED_NATIVE_MODE_FILE_V1)).toString("utf8");
    if (hash(priorDocumentBytes) !== current.fingerprint) fail("shared native resolver registration drift");
    const { signature: _signature, ...prior } = current.document;
    const document = signed({ ...prior, resolverBinarySha256: input.resolverBinarySha256 }, input.secret, "shared-native-mode:v1");
    const plan = signed({ version: 1 as const, kind: "account-router-shared-native-resolver-transition" as const,
      binding: input.repairBinding, priorDocumentBytes, priorFingerprint: current.fingerprint, document }, input.secret, "shared-native-resolver-transition:v1");
    parseResolverTransition(plan, input);
    return { state: "prepared", plan, fingerprint: fingerprint(plan) };
  } catch (error) { return blocked(error); }
}

/**
 * Explicit phases let the installer keep launch blocked until app, runtime,
 * journal and readiness challenge have all reached the same generation.
 */
export function executeSharedNativeResolverTransitionV1(input: SharedNativeModeContextV1 & {
  plan: unknown; expectedPlanFingerprint: Sha256; action: "validate" | "begin" | "publish" | "finish";
}): { state: "validated" | "begun" | "published" | "finished"; binding: SharedNativeResolverRepairBindingV1;
  priorFingerprint: Sha256; fingerprint: Sha256; priorResolverBinarySha256: string; resolverBinarySha256: string } | Blocked {
  try {
    contextSafe(input); noAccountRecovery(input);
    const plan = parseResolverTransition(input.plan, input);
    if (fingerprint(plan) !== input.expectedPlanFingerprint) fail("shared native resolver plan changed");
    const modePath = join(input.stateRoot, SHARED_NATIVE_MODE_FILE_V1);
    const transitionPath = join(input.stateRoot, SHARED_NATIVE_MODE_TRANSITION_FILE_V1);
    const priorArchive = join(input.stateRoot, `shared-native-resolver-prior-${input.expectedPlanFingerprint.slice(7)}.json`);
    const completed = join(input.stateRoot, `shared-native-resolver-completed-${input.expectedPlanFingerprint.slice(7)}.json`);
    const finalBytes = bytes(plan.document);
    const currentBytes = read(modePath);
    const prior = parseDocument(JSON.parse(plan.priorDocumentBytes), input);
    if (hash(currentBytes) !== plan.priorFingerprint && !currentBytes.equals(finalBytes)) fail("shared native resolver CAS mismatch");
    if (present(transitionPath) && hash(read(transitionPath)) !== input.expectedPlanFingerprint) fail("another shared native transition owns publication");
    if (present(completed) && hash(read(completed)) !== input.expectedPlanFingerprint) fail("shared native completed resolver intent changed");
    const result = (state: "validated" | "begun" | "published" | "finished") => ({ state, binding: plan.binding,
      priorFingerprint: plan.priorFingerprint, fingerprint: hash(finalBytes),
      priorResolverBinarySha256: prior.resolverBinarySha256, resolverBinarySha256: plan.document.resolverBinarySha256 });
    if (input.action === "validate") return result("validated");
    if (present(completed) && !present(transitionPath)) {
      if (!currentBytes.equals(finalBytes) || !read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes))) fail("completed resolver transition changed");
      return result(input.action === "begin" ? "begun" : input.action === "publish" ? "published" : "finished");
    }
    if (input.action === "begin") {
      if (!present(transitionPath)) publish(transitionPath, bytes(plan));
      return result("begun");
    }
    if (!present(transitionPath)) fail("resolver transition has not acquired its launch blocker");
    if (input.action === "publish") {
      if (present(priorArchive)) {
        if (!read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes))) fail("retained resolver registration changed");
      } else publish(priorArchive, Buffer.from(plan.priorDocumentBytes));
      if (!currentBytes.equals(finalBytes)) {
        const temp = join(input.stateRoot, `.shared-native-resolver-${randomBytes(16).toString("hex")}`);
        writeFileSync(temp, finalBytes, { mode: 0o600, flag: "wx" });
        try {
          sync(temp);
          if (hash(read(modePath)) !== plan.priorFingerprint || hash(read(transitionPath)) !== input.expectedPlanFingerprint) fail("resolver CAS changed before publication");
          renameSync(temp, modePath); sync(input.stateRoot);
        } finally { if (present(temp)) { unlinkSync(temp); sync(input.stateRoot); } }
      }
      return result("published");
    }
    if (input.action !== "finish") fail("unknown resolver transition action");
    if (!read(modePath).equals(finalBytes) || !read(priorArchive).equals(Buffer.from(plan.priorDocumentBytes))) fail("resolver publication is incomplete");
    if (!present(completed)) { linkSync(transitionPath, completed); sync(input.stateRoot); }
    if (hash(read(transitionPath)) !== input.expectedPlanFingerprint) fail("resolver transition changed before completion");
    unlinkSync(transitionPath); sync(input.stateRoot);
    return result("finished");
  } catch (error) { return blocked(error); }
}

/** Installer port: load only the exact signed native binding and wipe the key after each phase. */
export function executeSharedNativeResolverTransitionAtRootV1(input: {
  stateRoot: string; plan: unknown; expectedPlanFingerprint: Sha256; action: "validate" | "begin" | "publish" | "finish";
}): ReturnType<typeof executeSharedNativeResolverTransitionV1> {
  let secret: Buffer | undefined;
  try {
    directory(input.stateRoot);
    secret = read(join(input.stateRoot, "control-secret.v1"));
    if (secret.length !== 32) fail("invalid shared native resolver signing key");
    const config = JSON.parse(read(join(input.stateRoot, "account-router-config.json")).toString("utf8"));
    const native = readAndPreflightNativeHistorySourceStaticV1(input.stateRoot, config, secret);
    if (native.state !== "ready") return fail("shared native resolver source binding unavailable");
    return executeSharedNativeResolverTransitionV1({ ...input, secret, binding: native.binding });
  } catch (error) { return blocked(error); }
  finally { secret?.fill(0); }
}
