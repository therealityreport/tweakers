import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { packagedRuntimeAssetsRoot } from "./commands/install.js";
import { canonicalJson, isOpaqueAccountId, isCanonicalUtcTimestamp, ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT } from "./account-history-adoption.js";

const CONFIG_FILE = "account-router-config.json";
const SOURCE_FILE = "native-history-source.v1.json";
const MAX_PRIVATE_BYTES = 64 * 1024;
type Account = { opaqueAccountId: string; included: boolean; weight: number; capabilityFingerprint: string; label: string };
type Config = { schemaVersion: number; mode: string; policy: string | null; generation: number; protocolFingerprint: string; primaryOpaqueAccountId: string; accounts: Account[]; updatedAt: string; fingerprint: string };
type DirectoryIdentity = { device: number; inode: number; uid: number; mode: number };
type SourceAccount = { opaqueAccountId: string; codexHome: string; sqliteHome: string; codexHomeIdentity: DirectoryIdentity; sqliteHomeIdentity: DirectoryIdentity; authIdentityHmac: string };

export interface NativeHistorySetupInput {
  legacyRouterRoot: string;
  sourceCodexRoot: string;
  sourceSqliteRoot: string;
  secondaryCodexRoot?: string;
  secondarySqliteRoot?: string;
  globalRoot: string;
  appPaths: readonly string[];
  apply?: boolean;
}

export interface NativeHistorySetupDependencies {
  /** Test seam; production always performs the process census. */
  idle?: (roots: readonly string[], apps: readonly string[]) => boolean;
  now?: () => string;
  /** Test seam for the packaged, pure-verified initial persistent identity publication. */
  seedPersistentIdentities?: (stage: string) => void;
}

/** Test seam for the host-only writer census; normal setup uses the real host process table. */
export interface NativeHistorySetupIdleDependencies {
  spawn?: typeof spawnSync;
  uid?: () => number | undefined;
  selfPid?: number;
  /** Bounded diagnostic evidence only; never includes commands or native file paths. */
  onBlocked?: (evidence: { reason: string; pids: number[] }) => void;
}

/** Small explicit registration, not a history migration. All existing homes remain in place. */
export function setupNativeHistory(input: NativeHistorySetupInput, dependencies: NativeHistorySetupDependencies = {}) {
  const prepared = prepare(input, dependencies.now?.() ?? new Date().toISOString());
  try {
    const idle = dependencies.idle ?? nativeHistorySetupIdle;
    const roots = [...new Set(prepared.source.accounts.flatMap((a) => [a.codexHome, a.sqliteHome]))];
    const ready = idle(roots, input.appPaths);
    const result = {
      state: input.apply ? "registered" : "preview",
      mode: "in_place",
      accountCount: prepared.source.accounts.length,
      sourceAccountIndex: prepared.config.accounts.findIndex((a) => a.opaqueAccountId === prepared.sourceOwner),
      balancedTokens: true,
      copiesHistory: false,
      copiesCredentials: false,
      secondaryLiveHome: input.secondaryCodexRoot !== undefined,
      idle: ready,
      registrationFingerprint: prepared.fingerprint,
      coreMetadataBytes: Buffer.byteLength(JSON.stringify(prepared.config)) + Buffer.byteLength(JSON.stringify(prepared.source)) + 32,
    };
    if (!input.apply) return result;
    // Registration publishes only broker-owned metadata. A running native app
    // does not make that publication unsafe: no account-home bytes are changed.
    // Account-home materialization and native dispatch retain their own writer
    // gates. Revalidate identity inputs independently of the advisory census.
    const fresh = prepare(input, prepared.source.issuedAt);
    try {
      if (fresh.fingerprint !== prepared.fingerprint || !fresh.secret.equals(prepared.secret)) throw new Error("native-history setup inputs changed");
      const stage = join(dirname(input.globalRoot), `.native-history-registration-${randomUUID()}`);
      mkdirSync(stage, { mode: 0o700 });
      // A failed stage is retained for inspection; no source or recovery artifact is removed.
      privateWrite(join(stage, "control-secret.v1"), prepared.secret);
      privateWrite(join(stage, CONFIG_FILE), JSON.stringify(prepared.config) + "\n");
      privateWrite(join(stage, SOURCE_FILE), JSON.stringify(prepared.source) + "\n");
      if (process.platform === "darwin") {
        if (dependencies.seedPersistentIdentities) dependencies.seedPersistentIdentities(stage);
        else {
          const requireRuntime = createRequire(import.meta.url);
          const identities = requireRuntime(join(packagedRuntimeAssetsRoot(), "account-router", "persistent-directory-identity.js"));
          const history = requireRuntime(join(packagedRuntimeAssetsRoot(), "account-router", "native-history.js"));
          const proposal = identities.preparePersistentIdentityGeneration({ stateRoot: stage, secret: prepared.secret,
            verify: () => history.readAndPreflightNativeHistorySourceStaticV1(stage, prepared.config, prepared.secret).state === "ready" });
          identities.publishPersistentIdentityGeneration(stage, prepared.secret, proposal);
        }
      }
      privateWrite(join(stage, "canonical-history.v1.json"), JSON.stringify({ version: 1, conversations: [] }) + "\n");
      privateWrite(join(stage, "native-history-setup.v1.json"), JSON.stringify({ version: 1, registrationFingerprint: prepared.fingerprint, mode: "in_place", createdAt: prepared.source.issuedAt }) + "\n");
      syncDirectory(stage);
      const final = prepare(input, prepared.source.issuedAt);
      try {
        if (final.fingerprint !== prepared.fingerprint || !final.secret.equals(prepared.secret)) throw new Error("native-history setup changed before publication");
        // The absent destination and sibling stage are guarded by an exclusive publication reservation.
        const reservation = `${input.globalRoot}.native-setup-reservation`;
        mkdirSync(reservation, { mode: 0o700 });
        // The reservation is deliberately retained after publication and on a
        // late failure. Persist its directory entry before the destination
        // check so a crash cannot turn a consumed publication window into an
        // unmarked retry.
        syncDirectory(dirname(input.globalRoot));
        if (existsSync(input.globalRoot)) throw new Error("global broker root appeared before publication");
        renameSync(stage, input.globalRoot);
        syncDirectory(dirname(input.globalRoot));
      } finally { final.secret.fill(0); }
      return result;
    } finally { fresh.secret.fill(0); }
  } finally { prepared.secret.fill(0); }
}

function prepare(input: NativeHistorySetupInput, issuedAt: string) {
  for (const p of [input.legacyRouterRoot, input.sourceCodexRoot, input.sourceSqliteRoot]) directoryIdentity(p);
  if (!isAbsolute(input.globalRoot) || resolve(input.globalRoot) !== input.globalRoot || realpathSync(dirname(input.globalRoot)) !== dirname(input.globalRoot)) throw new Error("global broker parent must be canonical");
  directoryIdentity(dirname(input.globalRoot));
  if (existsSync(input.globalRoot) || existsSync(`${input.globalRoot}.native-setup-reservation`)) throw new Error("global broker destination already exists; inspect rather than overwrite");
  for (const app of input.appPaths) { directoryIdentity(app); if (!app.endsWith(".app")) throw new Error("expected exact desktop app bundle"); }
  if (input.appPaths.length !== 2 || new Set(input.appPaths).size !== 2 || input.appPaths.some((p) => !isAbsolute(p) || resolve(p) !== p)) throw new Error("two exact desktop app paths required");
  const secret = readPrivate(join(input.legacyRouterRoot, "control-secret.v1"));
  try {
    if (secret.length !== 32) throw new Error("invalid existing account control secret");
    const bytes = readPrivate(join(input.legacyRouterRoot, CONFIG_FILE));
    let legacy: Config;
    try { legacy = JSON.parse(bytes.toString("utf8")) as Config; } finally { bytes.fill(0); }
    validateLegacyConfig(legacy);
    const sourceOwner = opaqueAccount(secret, authId(input.sourceCodexRoot));
    if (!legacy.accounts.some((a) => a.opaqueAccountId === sourceOwner && a.included)) throw new Error("native Codex sign-in does not match an included saved account");
    if ((input.secondaryCodexRoot === undefined) !== (input.secondarySqliteRoot === undefined)) throw new Error("both secondary account roots are required together");
    if (input.secondaryCodexRoot !== undefined && input.secondarySqliteRoot !== undefined) {
      directoryIdentity(input.secondaryCodexRoot); directoryIdentity(input.secondarySqliteRoot);
      const secondaryOwner = opaqueAccount(secret, authId(input.secondaryCodexRoot));
      if (secondaryOwner === sourceOwner || !legacy.accounts.some((a) => a.opaqueAccountId === secondaryOwner && a.included)) throw new Error("secondary sign-in must match the other included saved account");
    }
    const accounts: SourceAccount[] = legacy.accounts.map((account) => {
      const savedRoot = join(input.legacyRouterRoot, "accounts", account.opaqueAccountId);
      const savedCodexHome = join(savedRoot, "codex-home");
      // Check BOTH existing saved identities, including the source owner's saved registration.
      if (opaqueAccount(secret, authId(savedCodexHome)) !== account.opaqueAccountId) throw new Error("saved account identity mismatch");
      const codexHome = account.opaqueAccountId === sourceOwner ? input.sourceCodexRoot : input.secondaryCodexRoot ?? savedCodexHome;
      const sqliteHome = account.opaqueAccountId === sourceOwner ? input.sourceSqliteRoot : input.secondarySqliteRoot ?? join(savedRoot, "sqlite-home");
      const raw = authId(codexHome);
      if (opaqueAccount(secret, raw) !== account.opaqueAccountId) throw new Error("selected account home identity mismatch");
      return { opaqueAccountId: account.opaqueAccountId, codexHome, sqliteHome, codexHomeIdentity: directoryIdentity(codexHome), sqliteHomeIdentity: directoryIdentity(sqliteHome), authIdentityHmac: hmac(secret, "account-router:native-history-auth:v1\0" + raw) };
    }).sort((a, b) => a.opaqueAccountId < b.opaqueAccountId ? -1 : a.opaqueAccountId > b.opaqueAccountId ? 1 : 0);
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i]!;
      for (const root of [a.codexHome, a.sqliteHome]) {
        if (overlap(root, input.globalRoot)) throw new Error("history and broker roots overlap");
        for (const b of accounts.slice(i + 1)) if ([b.codexHome, b.sqliteHome].some((other) => overlap(root, other))) throw new Error("account homes overlap");
      }
      if (a.codexHome !== a.sqliteHome && overlap(a.codexHome, a.sqliteHome)) throw new Error("nested account homes are unsupported");
    }
    const config: Config = { ...legacy, schemaVersion: 3, mode: "quota_aware", policy: "quota_aware_v2", generation: legacy.generation + 1, updatedAt: issuedAt };
    config.fingerprint = configFingerprint(config);
    const accountSetFingerprint = `sha256:${createHash("sha256").update(canonicalJson(accounts.map((a) => a.opaqueAccountId).sort())).digest("hex")}`;
    const unsigned = { version: 1, kind: "account-router-native-history-source", mode: "in_place", protocolFingerprint: config.protocolFingerprint, accountSetFingerprint, metadataAccountId: sourceOwner, accounts, issuedAt };
    const source = { ...unsigned, signature: hmac(secret, "account-router:native-history-source:v1\0" + canonicalJson(unsigned)) };
    const fingerprint = `sha256:${createHash("sha256").update(canonicalJson({ config, source })).digest("hex")}`;
    return { config, source, secret, sourceOwner, fingerprint };
  } catch (error) { secret.fill(0); throw error; }
}

function validateLegacyConfig(config: Config): void {
  if (!config || Object.keys(config).some((key) => !["schemaVersion", "mode", "policy", "generation", "protocolFingerprint", "primaryOpaqueAccountId", "accounts", "updatedAt", "fingerprint"].includes(key)) || config.schemaVersion !== 2 || !["manual", "quota_aware"].includes(config.mode)
    || (config.mode === "manual" ? config.policy !== null : config.policy !== "quota_aware_v1") || !isCanonicalUtcTimestamp(config.updatedAt) || config.protocolFingerprint !== ACCOUNT_ROUTER_HISTORY_ADOPTION_PROTOCOL_FINGERPRINT
    || !Number.isSafeInteger(config.generation) || config.generation < 1 || !Number.isSafeInteger(config.generation + 1) || !Array.isArray(config.accounts) || config.accounts.length !== 2
    || new Set(config.accounts.map((a) => a?.opaqueAccountId)).size !== 2
    || !config.accounts.every((a) => a && Object.keys(a).every((key) => ["opaqueAccountId", "included", "weight", "capabilityFingerprint", "label"].includes(key)) && isOpaqueAccountId(a.opaqueAccountId) && a.included === true && safeLabel(a.label) && Number.isInteger(a.weight) && a.weight >= 1 && a.weight <= 100 && /^sha256:[a-f0-9]{64}$/.test(a.capabilityFingerprint))
    || !config.accounts.some((a) => a.opaqueAccountId === config.primaryOpaqueAccountId) || config.fingerprint !== configFingerprint(config)) throw new Error("expected valid two-account legacy configuration");
}

function configFingerprint(c: Config): string {
  return `sha256:${createHash("sha256").update(canonicalJson({ schemaVersion: c.schemaVersion, mode: c.mode, policy: c.policy, generation: c.generation, protocolFingerprint: c.protocolFingerprint, primaryOpaqueAccountId: c.primaryOpaqueAccountId, accounts: c.accounts.map((a) => ({ opaqueAccountId: a.opaqueAccountId, included: a.included, weight: a.weight, capabilityFingerprint: a.capabilityFingerprint, label: a.label })) })).digest("hex")}`;
}
function hmac(secret: Buffer, value: string): string { return `hmac-sha256:${createHmac("sha256", secret).update(value).digest("hex")}`; }
function opaqueAccount(secret: Buffer, raw: string): string { return `ar_${createHmac("sha256", secret).update(`account-router:v1:${raw}`).digest("base64url")}`; }
function authId(root: string): string {
  const bytes = readPrivate(join(root, "auth.json"));
  try { const id: unknown = JSON.parse(bytes.toString("utf8"))?.tokens?.account_id; if (typeof id !== "string" || !id.length || id.length > 1024) throw new Error("invalid account identity"); return id; }
  finally { bytes.fill(0); }
}
function directoryIdentity(path: string): DirectoryIdentity {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("account directory must be canonical");
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o022)) throw new Error("unsafe account directory");
  return { device: s.dev, inode: s.ino, uid: s.uid, mode: s.mode & 0o7777 };
}
function readPrivate(path: string): Buffer {
  if (realpathSync(path) !== path) throw new Error("private input must be canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.size > MAX_PRIVATE_BYTES) throw new Error("unsafe private input");
    const bytes = readFileSync(fd); const after = fstatSync(fd); const current = lstatSync(path);
    if (before.size !== bytes.length || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev) { bytes.fill(0); throw new Error("private input changed"); }
    return bytes;
  } finally { closeSync(fd); }
}
function privateWrite(path: string, value: string | Buffer): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function overlap(a: string, b: string): boolean { const below = (x: string, y: string) => { const r = relative(x, y); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); }; return below(a, b) || below(b, a); }

/**
 * Observation-only final activation gate. It deliberately scopes process
 * evidence to the two participating app bundles and enrolled native roots:
 * a disjoint backend or a read-only metadata handle is not a history writer.
 * No observed process is stopped or signalled here.
 */
export function nativeHistorySetupIdle(
  roots: readonly string[],
  apps: readonly string[],
  dependencies: NativeHistorySetupIdleDependencies = {},
): boolean {
  const spawn = dependencies.spawn ?? spawnSync;
  const uid = dependencies.uid?.() ?? process.getuid?.();
  const selfPid = dependencies.selfPid ?? process.pid;
  const blocked = (reason: string, pids: number[] = []): false => {
    dependencies.onBlocked?.({ reason, pids: [...new Set(pids)].slice(0, 16) });
    return false;
  };
  if (!validPid(selfPid) || typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) return blocked("invalid-census-identity");
  let processes: CensusProcess[];
  let observed: ReturnType<typeof spawnSync>;
  try {
    const ps = spawn("/bin/ps", ["-axo", "pid=,ppid=,comm=,command="], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!successfulCensusCommand(ps)) return blocked("process-census-failed");
    const parsed = parsePsRows(ps.stdout);
    if (!parsed) return blocked("process-census-invalid");
    const participants = parsed.filter((row) => row.pid !== selfPid && participatingAppProcess(row, apps));
    if (participants.length > 0) return blocked("participating-app-processes", participants.map((row) => row.pid));
    processes = parsed;
    // Do not use `lsof +D`: walking a large native history tree turns a
    // bounded offline gate into an unbounded recursive scan. One same-UID
    // machine-readable inventory can be component-filtered below sealed roots.
    observed = spawn("/usr/sbin/lsof", ["-nP", "-u", String(uid), "-Fpafn"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return blocked("census-command-threw");
  }
  if (!successfulCensusCommand(observed)) return blocked("open-file-census-failed");
  const opens = parseLsofOpenPaths(observed.stdout);
  if (!opens) return blocked("open-file-census-invalid");
  const processByPid = new Map(processes.map((row) => [row.pid, row]));
  const enrolledRoots = [...new Set(roots)];
  for (const entry of opens) {
    if (!enrolledRoots.some((root) => lsofPathBelowRoot(entry.path, root))) continue;
    // A PID that appeared only in lsof raced the process snapshot, so neither
    // its executable identity nor its access classification is complete.
    const process = processByPid.get(entry.pid);
    if (!process) return blocked("process-snapshot-raced", [entry.pid]);
    if (entry.pid === selfPid) continue;
    if (!nativeHistoryWriterPath(entry.path, enrolledRoots)) continue;
    // An external real app-server that is only reading a protected native
    // database/session/history resource can become a source writer between
    // the setup censuses. Its access to an ordinary plugin or definition file
    // proves no such contention, so it is deliberately outside this gate.
    if (entry.access === "w" || entry.access === "u"
      || (entry.access === "r" && isCodexAppServerCommand(process.comm, process.command))) return blocked("native-history-writer", [entry.pid]);
    // `a ` means lsof could not establish the access mode. It is not enough
    // to call a `cwd`, `txt`, or `mem` observation a writer, but an unknown
    // numeric descriptor on a protected native state/history resource could
    // be a live writer and therefore keeps offline setup fail-closed.
    if (entry.access === "" && numericLsofDescriptor(entry.descriptor)) return blocked("native-history-access-unknown", [entry.pid]);
  }
  return true;
}

type CensusProcess = { pid: number; ppid: number; comm: string; command: string };
type LsofOpenPath = { pid: number; descriptor: string; path: string; access: "" | "r" | "w" | "u" };

type CensusCommandResult = {
  error?: Error;
  signal?: NodeJS.Signals | null;
  status?: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function successfulCensusCommand(result: CensusCommandResult): result is CensusCommandResult & { stdout: string; stderr: string } {
  return !result.error && !result.signal && result.status === 0
    && typeof result.stdout === "string" && typeof result.stderr === "string" && result.stderr.trim() === "";
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parsePsRows(value: string): CensusProcess[] | null {
  const rows: CensusProcess[] = [];
  const seen = new Set<number>();
  for (const line of value.split("\n")) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
    if (!fields) return null;
    // Darwin's `comm` column has the fixed MAXCOMLEN width (16). It can
    // contain a space, so splitting the remaining line on whitespace would
    // shift `command` and make exact app-bundle attribution unreliable.
    const remainder = line.slice(fields[0].length);
    const separator = remainder.slice(16);
    const commandMatch = /^\s+(.+)$/.exec(separator);
    const comm = remainder.slice(0, 16).trimEnd();
    const pid = Number(fields[1]);
    const ppid = Number(fields[2]);
    if (!commandMatch || !validPid(pid) || !Number.isSafeInteger(ppid) || ppid < 0 || !comm || !commandMatch[1] || seen.has(pid)) return null;
    seen.add(pid);
    rows.push({ pid, ppid, comm, command: commandMatch[1] });
  }
  return rows.length > 0 ? rows : null;
}

function participatingAppProcess(process: CensusProcess, apps: readonly string[]): boolean {
  const command = process.command.trim();
  // `ps command` begins with the executable path. Requiring the bundle prefix
  // avoids treating a bridge or a shell argument that merely names an app as a
  // participating desktop process, while including its bundled helpers.
  return apps.some((app) => command.startsWith(`${app}/Contents/`));
}

function isCodexAppServerCommand(comm: string, command: string): boolean {
  // A Node bridge may carry `/path/codex app-server` in an argument. `comm`
  // names the actual executable (and Darwin truncates long paths), so use it
  // to distinguish that bridge from a real Codex binary whose bundle path
  // itself contains spaces such as `Tweakers ChatGPT.app`.
  const value = command.trim();
  const firstSpace = value.search(/\s/);
  if (firstSpace > 0 && basename(value.slice(0, firstSpace)) === "codex") {
    return hasExactArgument(value.slice(firstSpace).trimStart(), "app-server");
  }
  const commIsCodex = basename(comm) === "codex";
  const truncatedCommPrefix = Boolean(comm) && value.startsWith(comm) && !/\s/.test(value[comm.length] ?? "");
  if (!commIsCodex && !truncatedCommPrefix) return false;
  const executableMatch = /\/codex(?=\s)/.exec(value);
  if (!executableMatch || executableMatch.index <= 0) return false;
  // A long Node executable path can be truncated in `comm`, which otherwise
  // makes its later `/tmp/codex app-server` argument look like an executable.
  // An actual Node executable terminator before the candidate is decisive.
  const nodeExecutable = /\/(?:node|nodejs)(?=\s)/.exec(value);
  if (nodeExecutable && nodeExecutable.index < executableMatch.index) return false;
  const executableEnd = executableMatch.index + "/codex".length;
  return basename(value.slice(0, executableEnd)) === "codex" && hasExactArgument(value.slice(executableEnd).trimStart(), "app-server");
}

function hasExactArgument(value: string, expected: string): boolean {
  return value.split(/\s+/).includes(expected);
}

function parseLsofOpenPaths(value: string): LsofOpenPath[] | null {
  const result: LsofOpenPath[] = [];
  let currentPid: number | null = null;
  let haveFile = false;
  let descriptor = "";
  let access: LsofOpenPath["access"] | null = null;
  let haveName = false;
  for (const line of value.split("\n")) {
    if (line === "") continue;
    const field = line[0]!;
    const payload = line.slice(1);
    if (field === "p") {
      const pid = Number(payload);
      if (!validPid(pid) || (haveFile && (access === null || !haveName))) return null;
      currentPid = pid;
      haveFile = false;
      descriptor = "";
      access = null;
      haveName = false;
      continue;
    }
    if (field === "f") {
      if (currentPid === null || payload.length === 0 || (haveFile && (access === null || !haveName))) return null;
      haveFile = true;
      descriptor = payload;
      access = null;
      haveName = false;
      continue;
    }
    if (field === "a") {
      if (currentPid === null || !haveFile || access !== null) return null;
      const normalized = payload.trim();
      if (normalized !== "" && normalized !== "r" && normalized !== "w" && normalized !== "u") return null;
      access = normalized;
      continue;
    }
    if (field === "n") {
      if (currentPid === null || !haveFile || access === null || haveName) return null;
      haveName = true;
      if (payload.startsWith("/")) result.push({ pid: currentPid, descriptor, path: payload, access });
      continue;
    }
    return null;
  }
  return currentPid === null || !haveFile || access === null || !haveName ? null : result;
}

function numericLsofDescriptor(value: string): boolean {
  // lsof uses `cwd`, `txt`, and `mem` for non-regular observations. Numeric
  // descriptors may have a trailing mode marker (for example `12u`).
  return /^\d+[a-z]*$/i.test(value);
}

function lsofPathBelowRoot(value: string, root: string): boolean {
  const path = value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
  return path === root || path.startsWith(`${root}/`);
}

function nativeHistoryWriterPath(value: string, roots: readonly string[]): boolean {
  const path = value.endsWith(" (deleted)") ? value.slice(0, -" (deleted)".length) : value;
  for (const root of roots) {
    if (!lsofPathBelowRoot(path, root)) continue;
    const child = path === root ? "" : path.slice(root.length + 1);
    const base = child.split("/").at(-1) ?? "";
    if (/^state[^/]*\.sqlite(?:-(?:wal|shm))?$/i.test(base)) return true;
    if (/(?:^|\/)(?:sessions|archived_sessions)(?:\/|$)/i.test(child)) return true;
    if (/(?:^|\/)(?:history|rollout)[^/]*(?:\/|$)/i.test(child)) return true;
  }
  return false;
}

export interface NativeHistorySetupCliOptions { apply?: boolean; "dry-run"?: boolean; "legacy-router-root"?: string; "source-codex-root"?: string; "source-sqlite-root"?: string; "secondary-codex-root"?: string; "secondary-sqlite-root"?: string; "global-root"?: string; app?: string; "tweakers-app"?: string }
export function nativeHistorySetupCommand(options: NativeHistorySetupCliOptions): void {
  const required = (key: keyof NativeHistorySetupCliOptions): string => { const value = options[key]; if (typeof value !== "string" || !value) throw new Error(`--${key} is required`); return value; };
  const result = setupNativeHistory({ legacyRouterRoot: required("legacy-router-root"), sourceCodexRoot: required("source-codex-root"), sourceSqliteRoot: required("source-sqlite-root"), secondaryCodexRoot: options["secondary-codex-root"], secondarySqliteRoot: options["secondary-sqlite-root"], globalRoot: required("global-root"), appPaths: [required("app"), required("tweakers-app")], apply: options.apply === true && options["dry-run"] !== true });
  process.stdout.write(JSON.stringify(result) + "\n");
}

function safeLabel(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return value === normalized
    && !/[@/\\]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:\bBearer\s+\S+|\b(?:sk-(?:proj-)?|gh[oprsu]_|xox[baprs]-)[A-Za-z0-9_-]{8,}|(?:^|[\s;])(?:authorization|cookie|set-cookie|access_token|refresh_token|id_token)\s*[:=]|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/i.test(value);
}
