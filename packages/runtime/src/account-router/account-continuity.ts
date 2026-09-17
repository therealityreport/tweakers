/**
 * Account-local capability/configuration continuity.
 *
 * This module deliberately has no broker, pool, or lifecycle dependency.  The
 * broker owns the absent-child lease; this module only accepts an explicit
 * synchronous write proof when it has to materialize an account home.  That
 * keeps the pure merge rules testable and prevents a background reconciler
 * from ever writing a live home.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseTOML, type AST } from "toml-eslint-parser";
import { isOpaqueAccountId, type OpaqueAccountId } from "./types";

export type Sha256 = `sha256:${string}`;
export type ConfigFieldPath = readonly string[];
export type CapabilityRelativePath = string;

const VERSION = 1 as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_CAPABILITY_FILE_BYTES = 512 * 1024;
const MAX_CAPABILITY_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_CAPABILITY_FILES = 2_048;
const MAX_CAPABILITY_DEPTH = 16;
const ACCOUNT_CONFIG_DIRECTORY = "shared-account-config";
const CONFIG_OVERRIDES_FILE = "config-overrides.v1.json";
const CAPABILITY_OVERRIDES_FILE = "capability-overrides.v1.json";
const MATERIALIZATION_FILE = "config-materialization.v1.json";
const MATERIALIZATION_INTENT_FILE = "config-materialization-intent.v1.json";
const CAPTURE_RECEIPT_FILE = "config-capture-receipt.v1.json";
const CAPABILITY_CAPTURE_RECEIPT_FILE = "capability-capture-receipt.v1.json";
const NATIVE_CAPTURE_INTENT_FILE = "native-initial-capture-intent.v1.json";
const NATIVE_CAPTURE_RECEIPT_FILE = "native-initial-capture-receipt.v1.json";
const BASE_FILE = "base.v1.json";
const BASE_RECEIPT_FILE = "base-source-receipt.v1.json";
const CAPABILITY_GENERATIONS_DIRECTORY = "capability-generations";
const CAPABILITY_MANIFEST_FILE = "manifest.v1.json";
const PLUGIN_GENERATIONS_DIRECTORY = "plugin-generations";
const PLUGIN_MANIFEST_FILE = "plugins.v1.json";
const PLUGIN_GENERATION_MANIFEST_FILE = "manifest.v1.json";
const CAPABILITY_OVERRIDE_FILES_DIRECTORY = "capability-override-files";
const BOOTSTRAP_RECEIPT_FILE = "bootstrap-receipt.v1.json";
const SHARED_SOURCE_REBASE_INTENT_FILE = "shared-source-rebase-intent.v1.json";
const SHARED_SOURCE_REBASE_RECEIPT_FILE = "shared-source-rebase-receipt.v1.json";

/** TOML's scalar grammar, represented without JavaScript precision loss. */
export type TomlScalarV1 =
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "integer"; value: string }
  | { type: "float"; value: string }
  | { type: "datetime"; kind: "offset-date-time" | "local-date-time" | "local-date" | "local-time"; value: string };

export interface TomlArrayV1 {
  type: "array";
  values: readonly TomlDataValueV1[];
}

/** Inline tables stay a leaf for ownership: a local inline table overrides it whole. */
export interface TomlInlineTableV1 {
  type: "inline-table";
  entries: TomlTableV1;
}

/** TOML array-of-table sections are valid but remain an atomic local value. */
export interface TomlArrayTableV1 {
  type: "array-table";
  entries: readonly TomlTableV1[];
}

export type TomlDataValueV1 = TomlScalarV1 | TomlArrayV1 | TomlInlineTableV1 | TomlArrayTableV1;
export type TomlNodeV1 = TomlDataValueV1 | TomlTableV1;
export interface TomlTableV1 {
  readonly [key: string]: TomlNodeV1;
}

interface TomlSourceAssignmentV1 {
  readonly path: readonly (string | number)[];
  /** Entire key/value expression; deleting this range removes one assignment. */
  readonly range: readonly [number, number];
  readonly valueRange: readonly [number, number];
  /** The outermost inline-table assignment that owns a nested inline member. */
  readonly ownerPath: readonly (string | number)[];
}

interface TomlSourceTableV1 {
  readonly path: readonly (string | number)[];
  readonly kind: "standard" | "array";
  readonly range: readonly [number, number];
}

/**
 * A CST-backed document. `source` and source ranges let materialization keep
 * untouched account-local bytes, comments, and order rather than reserializing
 * the whole file.
 */
export interface LosslessTomlDocument {
  readonly version: 1;
  readonly source: string;
  readonly tree: TomlTableV1;
  readonly fingerprint: Sha256;
  readonly assignments: Readonly<Record<string, TomlSourceAssignmentV1>>;
  readonly tables: Readonly<Record<string, TomlSourceTableV1>>;
}

export interface AccountContinuitySchemaV1 {
  readonly version: 1;
  readonly schemaFingerprint: Sha256;
  /** Additional known top-level user-policy fields that are safe to inherit. */
  readonly sharedTopLevel?: readonly string[];
  /** Extra hard local roots supplied by an exact supported app schema. */
  readonly alwaysLocalTopLevel?: readonly string[];
}

const DEFAULT_SHARED_TOP_LEVEL = [
  "model",
  "personality",
  "service_tier",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "developer_instructions",
  "web_search",
  "notify",
  "sandbox_mode",
  "approval_policy",
] as const;

const DEFAULT_ALWAYS_LOCAL_TOP_LEVEL = [
  "cli_auth_credentials_store",
  "mcp_oauth_credentials_store",
] as const;

export const DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: AccountContinuitySchemaV1 = {
  version: VERSION,
  schemaFingerprint: sha256Json({
    version: VERSION,
    authorizationClassificationRevision: 2,
    sharedTopLevel: DEFAULT_SHARED_TOP_LEVEL,
    alwaysLocalTopLevel: DEFAULT_ALWAYS_LOCAL_TOP_LEVEL,
  }),
  sharedTopLevel: DEFAULT_SHARED_TOP_LEVEL,
  alwaysLocalTopLevel: DEFAULT_ALWAYS_LOCAL_TOP_LEVEL,
};

export interface ConfigOverrideSetV1 {
  readonly path: ConfigFieldPath;
  readonly op: "set";
  readonly value: TomlNodeV1;
}

export interface ConfigOverrideDeleteV1 {
  readonly path: ConfigFieldPath;
  readonly op: "delete";
}

export type ConfigOverrideOpV1 = ConfigOverrideSetV1 | ConfigOverrideDeleteV1;

export interface AccountConfigOverridesV1 {
  readonly version: 1;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly revision: number;
  readonly basedOnSharedGeneration: number;
  readonly operations: readonly ConfigOverrideOpV1[];
  readonly preservationFingerprint: Sha256;
  readonly fingerprint: Sha256;
}

export interface CapabilityFileV1 {
  readonly relativePath: CapabilityRelativePath;
  readonly bytes: Buffer;
  readonly fingerprint: Sha256;
  /** Files with credential-shaped paths stay in their home and never enter a base generation. */
  readonly scope: "shareable" | "local_only";
}

export interface CapabilityTreeSnapshotV1 {
  readonly version: 1;
  readonly root: string;
  readonly files: readonly CapabilityFileV1[];
  readonly fingerprint: Sha256;
}

export interface SharedCapabilityFileV1 {
  readonly relativePath: CapabilityRelativePath;
  readonly fingerprint: Sha256;
  /** Present for in-memory projection/loading; never encoded in the manifest JSON. */
  readonly bytes?: Buffer;
}

export interface SharedCapabilityManifestV1 {
  readonly version: 1;
  readonly generation: number;
  readonly files: readonly SharedCapabilityFileV1[];
  readonly fingerprint: Sha256;
  /** Runtime-only location of immutable generation bytes. */
  readonly root?: string;
}

export interface CapabilityOverrideSetV1 {
  readonly relativePath: CapabilityRelativePath;
  readonly op: "set";
  readonly fingerprint: Sha256;
  readonly payloadFile: string;
}

export interface CapabilityOverrideDeleteV1 {
  readonly relativePath: CapabilityRelativePath;
  readonly op: "delete";
}

export type CapabilityOverrideOpV1 = CapabilityOverrideSetV1 | CapabilityOverrideDeleteV1;

export interface AccountCapabilityOverridesV1 {
  readonly version: 1;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly revision: number;
  readonly basedOnSharedGeneration: number;
  readonly operations: readonly CapabilityOverrideOpV1[];
  readonly preservationFingerprint: Sha256;
  readonly fingerprint: Sha256;
  /** Runtime-only, account-private payload directory. */
  readonly payloadRoot?: string;
}

export interface SharedConfigBaseV1 {
  readonly version: 1;
  readonly generation: number;
  readonly schemaFingerprint: Sha256;
  readonly tree: TomlTableV1;
  readonly fingerprint: Sha256;
}

export interface SharedAccountBaseV1 {
  readonly version: 1;
  readonly config: SharedConfigBaseV1;
  readonly capabilities: SharedCapabilityManifestV1;
  readonly fingerprint: Sha256;
}

/** A narrow, read-only projection of the already-verified sealed plugin inventory. */
export interface SharedPluginsManifestV1 {
  readonly version: 1;
  readonly fingerprint: Sha256;
  readonly plugins: readonly SharedPluginInventoryEntryV1[];
  readonly generation?: number;
  /** Runtime-only immutable cache root. */
  readonly root?: string;
}

export interface SharedPluginInventoryEntryV1 {
  readonly id: string;
  readonly enabledByDefault?: boolean;
  readonly version?: string;
  readonly fingerprint?: Sha256;
  readonly fileCount?: number;
  readonly bytes?: number;
}

export interface ResolvedAccountConfigV1 {
  readonly state: "ready" | "blocked";
  readonly reason?: string;
  readonly tree?: TomlTableV1;
  readonly effectiveFingerprint?: Sha256;
  readonly inheritedPaths?: readonly ConfigFieldPath[];
  readonly pluginEnablement?: Readonly<Record<string, boolean>>;
  readonly preservationFingerprint?: Sha256;
}

export interface ResolvedCapabilityFileV1 {
  readonly relativePath: CapabilityRelativePath;
  readonly bytes: Buffer;
  readonly fingerprint: Sha256;
  readonly provenance: "shared" | "override" | "local_only";
}

export interface ResolvedAccountCapabilitiesV1 {
  readonly state: "ready" | "blocked";
  readonly reason?: string;
  readonly files?: readonly ResolvedCapabilityFileV1[];
  readonly effectiveFingerprint?: Sha256;
  readonly inheritedPaths?: readonly CapabilityRelativePath[];
  readonly preservationFingerprint?: Sha256;
}

export interface AccountContinuityAccountV1 {
  readonly opaqueAccountId: OpaqueAccountId;
  readonly codexHome: string;
  /** Account-private manager metadata, normally <stateRoot>/accounts/<id>. */
  readonly accountStateRoot?: string;
}

export interface AccountContinuityBootstrapInputV1 {
  readonly stateRoot: string;
  readonly primaryOpaqueAccountId: OpaqueAccountId;
  /** Supplies shared defaults independently of routing primary. Legacy callers default to primary. */
  readonly sharedSourceOpaqueAccountId?: OpaqueAccountId;
  readonly accounts: readonly AccountContinuityAccountV1[];
  readonly schema: AccountContinuitySchemaV1;
  /** The pure/default path writes nothing. */
  readonly apply?: boolean;
  readonly generation?: number;
  readonly now?: () => string;
}

export interface AccountContinuityBootstrapResultV1 {
  readonly state: "ready" | "blocked";
  readonly reason?: string;
  readonly shared?: SharedAccountBaseV1;
  readonly plugins?: SharedPluginsManifestV1;
  readonly configOverrides?: Readonly<Record<string, AccountConfigOverridesV1>>;
  readonly capabilityOverrides?: Readonly<Record<string, AccountCapabilityOverridesV1>>;
}

export interface AccountContinuitySharedSourceProvenanceV1 {
  readonly state: "ready" | "blocked";
  readonly reason?: string;
  readonly primaryOpaqueAccountId?: OpaqueAccountId;
  readonly sharedSourceOpaqueAccountId?: OpaqueAccountId;
  readonly legacy?: boolean;
  readonly sharedBaseFingerprint?: Sha256;
  readonly sharedPluginFingerprint?: Sha256;
}

export interface RebaseAccountContinuitySharedSourceInputV1 {
  readonly stateRoot: string;
  /** Routing identity is receipt provenance only and never selects shared data. */
  readonly primaryOpaqueAccountId: OpaqueAccountId;
  readonly sharedSourceOpaqueAccountId: OpaqueAccountId;
  readonly accounts: readonly AccountContinuityAccountV1[];
  readonly schema: AccountContinuitySchemaV1;
  readonly priorShared: SharedAccountBaseV1;
  readonly priorPlugins: SharedPluginsManifestV1;
  /** Required for every non-donor materialized account whose capture metadata is rebased. */
  readonly accountWriteEvidence?: Readonly<Record<string, AccountContinuityWriteEvidenceV1>>;
  readonly apply?: boolean;
  readonly now?: () => string;
  /** Focused-test seam. Production callers never set this. */
  readonly faultAt?: "after_intent" | "after_sidecars" | "during_plugins" | "after_plugins" | "after_shared";
}

export interface RebaseAccountContinuitySharedSourceResultV1 {
  readonly state: "ready" | "blocked";
  readonly reason?: string;
  readonly sharedSourceOpaqueAccountId?: OpaqueAccountId;
  readonly sharedGeneration?: number;
  readonly pluginGeneration?: number;
  readonly shared?: SharedAccountBaseV1;
  readonly plugins?: SharedPluginsManifestV1;
  readonly configOverrides?: Readonly<Record<string, AccountConfigOverridesV1>>;
  readonly capabilityOverrides?: Readonly<Record<string, AccountCapabilityOverridesV1>>;
}

export interface AbortUnpublishedSharedSourceRebaseInputV1 {
  readonly stateRoot: string;
  readonly accounts: readonly AccountContinuityAccountV1[];
  /** Exact operator-reviewed intent; this API never chooses a transaction. */
  readonly expectedIntentFingerprint: Sha256;
  readonly accountWriteEvidence?: Readonly<Record<string, AccountContinuityWriteEvidenceV1>>;
  readonly apply?: boolean;
  /** Focused-test seam. Production callers never set this. */
  readonly faultAt?: "after_sidecars";
}

export interface AbortUnpublishedSharedSourceRebaseResultV1 {
  readonly state: "would_abort" | "aborted" | "absent" | "blocked";
  readonly reason?: string;
  readonly archiveFile?: string;
}

/** Add one closed account to an already-published shared continuity base. */
export interface EnsureAccountContinuityEnrollmentInputV1 {
  readonly stateRoot: string;
  readonly account: AccountContinuityAccountV1;
  readonly schema: AccountContinuitySchemaV1;
  readonly writeEvidence?: AccountContinuityWriteEvidenceV1;
  /** The default derives a no-write candidate. */
  readonly apply?: boolean;
}

export interface EnsureAccountContinuityEnrollmentResultV1 {
  readonly state: "ready" | "would_enroll" | "blocked";
  readonly reason?: string;
  readonly shared?: SharedAccountBaseV1;
  readonly plugins?: SharedPluginsManifestV1;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
}

export interface AccountContinuityWriteEvidenceV1 {
  /** The host's same-account lease already proved this and holds through spawn. */
  readonly accountChildAbsent: boolean;
  /** Supply for native in-place homes only. It is called twice before a write. */
  readonly nativeWriterCensus?: () => "zero" | "running" | "unknown";
}

export interface AccountConfigPrepareInputV1 {
  readonly stateRoot: string;
  readonly account: AccountContinuityAccountV1;
  readonly shared: SharedAccountBaseV1;
  readonly schema: AccountContinuitySchemaV1;
  readonly plugins: SharedPluginsManifestV1;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
  readonly writeEvidence?: AccountContinuityWriteEvidenceV1;
  /** The pure/default path reports whether a write would be required. */
  readonly apply?: boolean;
  /** Focused-test seam. Production callers never set this. */
  readonly faultAt?: "after_intent" | "after_config" | "after_capabilities";
}

export interface AccountConfigMaterializationV1 {
  readonly version: 1;
  readonly state: "ready" | "would_write" | "blocked";
  readonly reason?: string;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly sharedGeneration?: number;
  readonly configOverridesFingerprint?: Sha256;
  readonly capabilityOverridesFingerprint?: Sha256;
  readonly configArtifactFingerprint?: Sha256;
  readonly capabilityArtifactFingerprint?: Sha256;
  readonly effectiveConfigFingerprint?: Sha256;
  readonly effectiveCapabilityFingerprint?: Sha256;
  readonly expectedConfig?: TomlTableV1;
  readonly expectedCapabilities?: readonly ResolvedCapabilityFileV1[];
  readonly inheritedConfigPaths?: readonly ConfigFieldPath[];
  readonly inheritedCapabilityPaths?: readonly CapabilityRelativePath[];
  readonly written: boolean;
}

/** The caller owns the signed native_external enrollment and its binding. */
export interface AccountNativeBaselineInputV1 extends AccountConfigPrepareInputV1 {
  readonly nativeHomeIdentity: { readonly device: number; readonly inode: number };
  readonly nativeBindingPreflight: () => boolean;
}

export interface AccountNativeCaptureInputV1 extends AccountNativeBaselineInputV1 {
  /** Focused-test seam; production callers never set this. */
  readonly captureFaultAt?: "after_intent" | "after_config" | "after_capabilities";
}

export interface AccountNativeCaptureResultV1 {
  readonly state: "unchanged" | "captured" | "blocked";
  readonly reason?: string;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
}

export interface AccountConfigCaptureInputV1 {
  readonly stateRoot: string;
  readonly account: AccountContinuityAccountV1;
  readonly shared: SharedAccountBaseV1;
  readonly schema: AccountContinuitySchemaV1;
  readonly materialization: AccountConfigMaterializationV1;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly primary?: boolean;
  readonly apply?: boolean;
}

export interface AccountConfigCaptureResultV1 {
  readonly state: "captured" | "blocked";
  readonly reason?: string;
  readonly overrides?: AccountConfigOverridesV1;
  readonly proposedSharedBase?: SharedConfigBaseV1;
}

export interface AccountCapabilityCaptureInputV1 {
  readonly stateRoot: string;
  readonly account: AccountContinuityAccountV1;
  readonly shared: SharedAccountBaseV1;
  readonly materialization: AccountConfigMaterializationV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
  readonly primary?: boolean;
  readonly apply?: boolean;
}

export interface AccountCapabilityCaptureResultV1 {
  readonly state: "captured" | "blocked";
  readonly reason?: string;
  readonly overrides?: AccountCapabilityOverridesV1;
  readonly proposedSharedCapabilities?: CapabilityTreeSnapshotV1;
}

/**
 * A primary-only post-exit publication request. The caller obtains
 * `proposedConfig` and `proposedCapabilities` from the two capture calls for
 * the same closed child, then publishes them together while that child's
 * account lease is still held.
 */
export interface PublishPrimarySharedBaseInputV1 {
  readonly stateRoot: string;
  readonly prior: SharedAccountBaseV1;
  readonly proposedConfig: SharedConfigBaseV1;
  readonly proposedCapabilities: CapabilityTreeSnapshotV1;
  readonly schema: AccountContinuitySchemaV1;
  /** The default validates the candidate and reports whether publication is required. */
  readonly apply?: boolean;
}

export interface PublishPrimarySharedBaseResultV1 {
  readonly state: "published" | "would_publish" | "blocked";
  readonly reason?: string;
  readonly shared?: SharedAccountBaseV1;
}

/**
 * Imports edits made while no broker child owns the account home. This is for
 * official/native app changes observed at the pre-spawn boundary; it never
 * writes config.toml or capability roots.
 */
export interface IdleAccountChangesCaptureInputV1 {
  readonly stateRoot: string;
  readonly account: AccountContinuityAccountV1;
  readonly shared: SharedAccountBaseV1;
  readonly schema: AccountContinuitySchemaV1;
  readonly plugins: SharedPluginsManifestV1;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
  readonly primary?: boolean;
  readonly writeEvidence: AccountContinuityWriteEvidenceV1;
  readonly apply?: boolean;
}

export interface IdleAccountChangesCaptureResultV1 {
  readonly state: "captured" | "unchanged" | "blocked";
  readonly reason?: string;
  readonly configOverrides?: AccountConfigOverridesV1;
  readonly capabilityOverrides?: AccountCapabilityOverridesV1;
  readonly proposedSharedConfig?: SharedConfigBaseV1;
  readonly proposedSharedCapabilities?: CapabilityTreeSnapshotV1;
}

/**
 * The host uses this list to select one account before dispatch.  This module
 * never reroutes a request or fans it out.
 */
export const ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1 = new Set([
  "config/batchWrite",
  "config/mcpServer/reload",
  "config/value/write",
  "experimentalFeature/enablement/set",
  "skills/config/write",
  "skills/extraRoots/set",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade",
] as const);

export const ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1 = "mcpServer/oauth/login" as const;

export function isAccountScopedCapabilityMutationV1(method: string): boolean {
  return ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1.has(method as never);
}

function sha256(bytes: Buffer | string): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Json(value: unknown): Sha256 {
  return sha256(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (!isRecord(value)) throw new Error("account continuity refuses a non-serializable value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path);
}

function decodePathKey(key: string): readonly (string | number)[] {
  const parsed = JSON.parse(key) as unknown;
  if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string" && !Number.isInteger(part))) throw new Error("invalid account continuity path key");
  return parsed as readonly (string | number)[];
}

function configPathKey(path: ConfigFieldPath): string {
  if (path.length === 0 || path.some((part) => typeof part !== "string" || part.length === 0)) throw new Error("invalid account continuity config path");
  return pathKey(path);
}

function capabilityPathKey(path: string): string {
  if (!isSafeCapabilityRelativePath(path)) throw new Error("unsafe account continuity capability path");
  return path;
}

function isTomlScalar(value: unknown): value is TomlScalarV1 {
  const record = isRecord(value) ? value : undefined;
  return record !== undefined && typeof record.type === "string" && ["string", "boolean", "integer", "float", "datetime"].includes(record.type);
}

function isTomlArray(value: unknown): value is TomlArrayV1 {
  const record = isRecord(value) ? value : undefined;
  return record !== undefined && record.type === "array" && Array.isArray(record.values);
}

function isTomlInlineTable(value: unknown): value is TomlInlineTableV1 {
  const record = isRecord(value) ? value : undefined;
  return record !== undefined && record.type === "inline-table" && isRecord(record.entries);
}

function isTomlArrayTable(value: unknown): value is TomlArrayTableV1 {
  const record = isRecord(value) ? value : undefined;
  return record !== undefined && record.type === "array-table" && Array.isArray(record.entries);
}

function isTomlDataValue(value: unknown): value is TomlDataValueV1 {
  return isTomlScalar(value) || isTomlArray(value) || isTomlInlineTable(value) || isTomlArrayTable(value);
}

function isTomlTable(value: unknown): value is TomlTableV1 {
  return value !== undefined && isRecord(value) && !isTomlDataValue(value);
}

function compareToml(left: TomlNodeV1 | undefined, right: TomlNodeV1 | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return stableJson(left) === stableJson(right);
}

function renderTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function renderTomlPath(path: readonly string[]): string {
  return path.map(renderTomlKey).join(".");
}

function renderTomlValue(value: TomlDataValueV1): string {
  switch (value.type) {
    case "string": return JSON.stringify(value.value);
    case "boolean": return value.value ? "true" : "false";
    case "integer": return value.value;
    case "float": return value.value;
    case "datetime": return value.value;
    case "array": return `[${value.values.map(renderTomlValue).join(", ")}]`;
    case "inline-table": return `{ ${Object.keys(value.entries).sort().map((key) => {
      const child = value.entries[key]!;
      if (!isTomlDataValue(child)) throw new Error("inline TOML table cannot contain a standard table");
      return `${renderTomlKey(key)} = ${renderTomlValue(child)}`;
    }).join(", ")} }`;
    case "array-table": throw new Error("array-table values cannot appear on a TOML assignment");
  }
}

function astKeyPath(key: AST.TOMLKey): readonly string[] {
  return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}

function astValue(value: AST.TOMLContentNode): TomlDataValueV1 {
  if (value.type === "TOMLArray") return { type: "array", values: value.elements.map(astValue) };
  if (value.type === "TOMLInlineTable") {
    const entries: Record<string, TomlNodeV1> = {};
    for (const entry of value.body) assignTomlNode(entries, astKeyPath(entry.key), astValue(entry.value));
    return { type: "inline-table", entries };
  }
  switch (value.kind) {
    case "string": return { type: "string", value: value.value };
    case "boolean": return { type: "boolean", value: value.value };
    case "integer": return { type: "integer", value: value.bigint.toString(10) };
    case "float": {
      if (!Number.isFinite(value.value)) throw new Error("account continuity rejects non-finite TOML floats");
      return { type: "float", value: value.number.replace(/_/g, "") };
    }
    case "offset-date-time":
    case "local-date-time":
    case "local-date":
    case "local-time": return { type: "datetime", kind: value.kind, value: value.datetime };
    default: throw new Error("account continuity rejects an unsupported TOML value");
  }
}

function ensureTomlTableAt(root: Record<string, TomlNodeV1>, path: readonly (string | number)[]): Record<string, TomlNodeV1> {
  let current: Record<string, TomlNodeV1> = root;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index]!;
    if (typeof part !== "string") throw new Error("TOML table path unexpectedly entered an array table");
    const existing = current[part];
    if (existing === undefined) {
      const next: Record<string, TomlNodeV1> = {};
      current[part] = next;
      current = next;
      continue;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  return current;
}

function assignTomlNode(root: Record<string, TomlNodeV1>, path: readonly (string | number)[], value: TomlNodeV1): void {
  if (path.length === 0) throw new Error("empty TOML path");
  let current: Record<string, TomlNodeV1> = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]!;
    const nextPart = path[index + 1]!;
    if (typeof part !== "string") throw new Error("TOML key path may not start with an array index");
    let existing = current[part];
    if (typeof nextPart === "number") {
      if (existing === undefined) {
        existing = { type: "array-table", entries: [] };
        current[part] = existing;
      }
      if (!isTomlArrayTable(existing) || !existing.entries[nextPart]) throw new Error("invalid TOML array-table path");
      current = existing.entries[nextPart]! as Record<string, TomlNodeV1>;
      index += 1;
      continue;
    }
    if (existing === undefined) {
      existing = {};
      current[part] = existing;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  const terminal = path.at(-1)!;
  if (typeof terminal !== "string" || current[terminal] !== undefined) throw new Error("duplicate TOML key");
  current[terminal] = value;
}

function assignTomlTable(root: Record<string, TomlNodeV1>, tablePath: readonly (string | number)[], kind: "standard" | "array"): Record<string, TomlNodeV1> {
  if (tablePath.length === 0) throw new Error("empty TOML table path");
  let current: Record<string, TomlNodeV1> = root;
  for (let index = 0; index < tablePath.length; index += 1) {
    const part = tablePath[index]!;
    const nextPart = tablePath[index + 1]!;
    if (typeof part !== "string") throw new Error("invalid TOML array table parent");
    if (index === tablePath.length - 1) {
      if (kind !== "standard") throw new Error("invalid TOML array table path");
      const existing = current[part];
      if (existing === undefined) {
        const next: Record<string, TomlNodeV1> = {};
        current[part] = next;
        return next;
      }
      if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
      return existing;
    }
    let existing = current[part];
    if (typeof nextPart === "number") {
      if (existing === undefined) {
        existing = { type: "array-table", entries: [] };
        current[part] = existing;
      }
      if (!isTomlArrayTable(existing)) throw new Error("TOML table/key collision");
      const entries = existing.entries as TomlTableV1[];
      if (index + 1 === tablePath.length - 1 && kind === "array") {
        if (entries.length !== nextPart) throw new Error("invalid TOML array table order");
        const next: Record<string, TomlNodeV1> = {};
        entries.push(next);
        return next;
      }
      const selected = entries[nextPart];
      if (!selected) throw new Error("invalid TOML array table path");
      current = selected as Record<string, TomlNodeV1>;
      index += 1;
      continue;
    }
    if (existing === undefined) {
      existing = {};
      current[part] = existing;
    }
    if (!isTomlTable(existing)) throw new Error("TOML table/key collision");
    current = existing;
  }
  throw new Error("invalid TOML table path");
}

function collectInlineAssignments(
  value: AST.TOMLContentNode,
  path: readonly (string | number)[],
  ownerPath: readonly (string | number)[],
  output: Record<string, TomlSourceAssignmentV1>,
): void {
  if (value.type !== "TOMLInlineTable") return;
  for (const entry of value.body) {
    const childPath = [...path, ...astKeyPath(entry.key)];
    output[pathKey(childPath)] = {
      path: childPath,
      range: [entry.range[0], entry.range[1]],
      valueRange: [entry.value.range[0], entry.value.range[1]],
      ownerPath,
    };
    collectInlineAssignments(entry.value, childPath, ownerPath, output);
  }
}

/** Parse TOML 1.0 through a CST parser, preserving source bytes and layout ranges. */
export function parseLosslessTomlDocument(source: string): LosslessTomlDocument {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES) throw new Error("account continuity config exceeds its bounded size");
  let ast: AST.TOMLProgram;
  try {
    ast = parseTOML(source, { tomlVersion: "1.0.0" });
  } catch (error) {
    throw new Error(`account continuity rejected invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tree: Record<string, TomlNodeV1> = {};
  const assignments: Record<string, TomlSourceAssignmentV1> = {};
  const tables: Record<string, TomlSourceTableV1> = {};
  const body = ast.body[0]?.body ?? [];
  for (const node of body) {
    if (node.type === "TOMLKeyValue") {
      const path = astKeyPath(node.key);
      assignTomlNode(tree, path, astValue(node.value));
      assignments[pathKey(path)] = { path, range: [node.range[0], node.range[1]], valueRange: [node.value.range[0], node.value.range[1]], ownerPath: path };
      collectInlineAssignments(node.value, path, path, assignments);
      continue;
    }
    const tablePath = node.resolvedKey;
    const table = assignTomlTable(tree, tablePath, node.kind);
    tables[pathKey(tablePath)] = { path: tablePath, kind: node.kind, range: [node.range[0], node.range[1]] };
    for (const entry of node.body) {
      const path = [...tablePath, ...astKeyPath(entry.key)];
      assignTomlNode(table, astKeyPath(entry.key), astValue(entry.value));
      assignments[pathKey(path)] = { path, range: [entry.range[0], entry.range[1]], valueRange: [entry.value.range[0], entry.value.range[1]], ownerPath: path };
      collectInlineAssignments(entry.value, path, path, assignments);
    }
  }
  return { version: VERSION, source, tree, fingerprint: sha256(source), assignments, tables };
}

export function readLosslessTomlDocument(path: string): LosslessTomlDocument {
  const bytes = readSafeRegularFile(path, MAX_CONFIG_BYTES, true, false);
  if (bytes === null) throw new Error("account continuity refused an unsafe config.toml");
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseLosslessTomlDocument(source);
  } finally {
    bytes.fill(0);
  }
}

function getTomlNode(root: TomlTableV1, path: readonly string[]): TomlNodeV1 | undefined {
  let current: TomlNodeV1 = root;
  for (const part of path) {
    if (!isTomlTable(current)) return undefined;
    current = current[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function setTomlNode(root: Record<string, TomlNodeV1>, path: readonly string[], value: TomlNodeV1): void {
  if (path.length === 0) throw new Error("empty TOML override path");
  const parent = ensureTomlTableAt(root, path.slice(0, -1));
  parent[path.at(-1)!] = clone(value);
}

function deleteTomlNode(root: Record<string, TomlNodeV1>, path: readonly string[]): void {
  if (path.length === 0) throw new Error("empty TOML override path");
  let current: Record<string, TomlNodeV1> = root;
  const parents: Array<[Record<string, TomlNodeV1>, string]> = [];
  for (const part of path.slice(0, -1)) {
    const node = current[part];
    if (!isTomlTable(node)) return;
    parents.push([current, part]);
    current = node;
  }
  delete current[path.at(-1)!];
  for (const [parent, key] of parents.reverse()) {
    const node = parent[key];
    if (isTomlTable(node) && Object.keys(node).length === 0) delete parent[key];
  }
}

function flattenTomlLeaves(root: TomlTableV1, prefix: readonly string[] = [], output = new Map<string, { path: readonly string[]; value: TomlNodeV1 }>()): Map<string, { path: readonly string[]; value: TomlNodeV1 }> {
  for (const key of Object.keys(root)) {
    const value = root[key]!;
    const path = [...prefix, key];
    if (isTomlTable(value)) flattenTomlLeaves(value, path, output);
    else output.set(configPathKey(path), { path, value });
  }
  return output;
}

function isCanonicalProjectPath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

function credentialShaped(value: string): boolean {
  return /(?:^|[_-])(auth(?:orization)?|oauth|token|cookie|credential|secret|password|passwd|api[_-]?key|bearer|keychain)(?:$|[_-])/i.test(value)
    || /^(?:\.netrc|credentials?\.json|cookies?\.json|oauth\.json|tokens?\.json|secrets?\.json)$/i.test(value);
}

function containsLiteralAuthorization(value: TomlNodeV1 | undefined): boolean {
  if (value === undefined) return false;
  if (isTomlArray(value)) return value.values.some(containsLiteralAuthorization);
  if (isTomlInlineTable(value)) return Object.entries(value.entries).some(([key, child]) => credentialShaped(key) || containsLiteralAuthorization(child));
  if (isTomlArrayTable(value)) return value.entries.some(containsLiteralAuthorization);
  if (isTomlTable(value)) return Object.entries(value).some(([key, child]) => credentialShaped(key) || containsLiteralAuthorization(child));
  if (!isTomlScalar(value) || value.type !== "string") return false;
  const text = value.value;
  if (/^(?:Bearer|Basic)\s+\S+/i.test(text)) return true;
  const assignment = /^(?:--?)?([^=\s]+)(?:=|$)/.exec(text);
  if (assignment && credentialShaped(assignment[1]!)) return true;
  const urlText = /[a-z][a-z0-9+.-]*:\/\/[^\s]+/i.exec(text)?.[0];
  if (urlText) {
    try {
      const url = new URL(urlText);
      if (url.username || url.password || [...url.searchParams.keys()].some(credentialShaped)) return true;
    } catch { /* An ordinary non-URL argument is not authorization evidence. */ }
  }
  return false;
}

function classifyTomlPath(path: readonly string[], schema: AccountContinuitySchemaV1, value?: TomlNodeV1): "shared" | "local" {
  const top = path[0];
  if (!top) return "local";
  const locals = new Set([...DEFAULT_ALWAYS_LOCAL_TOP_LEVEL, ...(schema.alwaysLocalTopLevel ?? [])]);
  if (locals.has(top) || path.some(credentialShaped)) return "local";
  if (top === "features" || (top === "model_provider" && path.length === 1)) return "shared";
  if (top === "projects") return path.length >= 2 && isCanonicalProjectPath(path[1]!) ? "shared" : "local";
  if ((top === "mcp_servers" || top === "model_providers" || top === "marketplaces") && containsLiteralAuthorization(value)) return "local";
  if (top === "mcp_servers" || top === "model_providers" || top === "plugins" || top === "marketplace" || top === "marketplaces") return "shared";
  const sharedTop = new Set([...DEFAULT_SHARED_TOP_LEVEL, ...(schema.sharedTopLevel ?? [])]);
  return path.length === 1 && sharedTop.has(top) ? "shared" : "local";
}

function selectSharedTomlTree(tree: TomlTableV1, schema: AccountContinuitySchemaV1): TomlTableV1 {
  const selected: Record<string, TomlNodeV1> = {};
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "shared") setTomlNode(selected, path, value);
  }
  const servers = getTomlNode(selected, ["mcp_servers"]);
  if (isTomlTable(servers)) {
    for (const [name, server] of Object.entries(servers)) {
      const original = getTomlNode(tree, ["mcp_servers", name]);
      if (isTomlTable(server) && isTomlTable(original) && (original.url !== undefined || original.command !== undefined)
        && server.url === undefined && server.command === undefined) deleteTomlNode(selected, ["mcp_servers", name]);
    }
  }
  return selected;
}

function preservationFingerprint(tree: TomlTableV1, schema: AccountContinuitySchemaV1): Sha256 {
  const fields: Record<string, TomlNodeV1> = {};
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "local") fields[configPathKey(path)] = value;
  }
  return sha256Json(fields);
}

function baseConfigFingerprint(generation: number, schemaFingerprint: Sha256, tree: TomlTableV1): Sha256 {
  return sha256Json({ version: VERSION, generation, schemaFingerprint, tree });
}

function capabilityManifestFingerprint(generation: number, files: readonly SharedCapabilityFileV1[]): Sha256 {
  return sha256Json({
    version: VERSION,
    generation,
    files: [...files].map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  });
}

function accountConfigOverridesFingerprint(value: Omit<AccountConfigOverridesV1, "fingerprint">): Sha256 {
  return sha256Json({
    version: value.version,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: value.operations,
    preservationFingerprint: value.preservationFingerprint,
  });
}

function accountCapabilityOverridesFingerprint(value: Omit<AccountCapabilityOverridesV1, "fingerprint" | "payloadRoot">): Sha256 {
  return sha256Json({
    version: value.version,
    opaqueAccountId: value.opaqueAccountId,
    revision: value.revision,
    basedOnSharedGeneration: value.basedOnSharedGeneration,
    operations: value.operations,
    preservationFingerprint: value.preservationFingerprint,
  });
}

function validateConfigOperations(operations: readonly ConfigOverrideOpV1[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = configPathKey(operation.path);
    if (seen.has(key)) throw new Error("duplicate account continuity config override");
    seen.add(key);
    if (operation.op === "set" && !isTomlDataValue(operation.value) && !isTomlTable(operation.value)) {
      throw new Error("invalid account continuity config override value");
    }
  }
  const paths = operations.map((operation) => operation.path);
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (pathsOverlapBySegments(paths[left]!, paths[right]!)) throw new Error("overlapping account continuity config overrides");
    }
  }
}

function pathsOverlapBySegments(left: readonly string[], right: readonly string[]): boolean {
  const common = Math.min(left.length, right.length);
  for (let index = 0; index < common; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function normalizeConfigOperations(operations: readonly ConfigOverrideOpV1[]): readonly ConfigOverrideOpV1[] {
  validateConfigOperations(operations);
  return [...operations].map((operation) => clone(operation)).sort((left, right) => configPathKey(left.path).localeCompare(configPathKey(right.path)));
}

function buildConfigOverrides(
  opaqueAccountId: OpaqueAccountId,
  generation: number,
  tree: TomlTableV1,
  schema: AccountContinuitySchemaV1,
  prior?: AccountConfigOverridesV1,
): AccountConfigOverridesV1 {
  const operations: ConfigOverrideOpV1[] = [];
  for (const { path, value } of flattenTomlLeaves(tree).values()) {
    if (classifyTomlPath(path, schema, value) === "shared") operations.push({ path, op: "set", value: clone(value) });
  }
  const draft: Omit<AccountConfigOverridesV1, "fingerprint"> = {
    version: VERSION,
    opaqueAccountId,
    revision: prior ? prior.revision + 1 : 1,
    basedOnSharedGeneration: generation,
    operations: normalizeConfigOperations(operations),
    preservationFingerprint: preservationFingerprint(tree, schema),
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}

/** Project only classified static configuration and safe capability files from primary. */
export function projectPrimarySharedBase(
  toml: LosslessTomlDocument,
  capabilities: CapabilityTreeSnapshotV1,
  schema: AccountContinuitySchemaV1,
): SharedAccountBaseV1 {
  validateSchema(schema);
  const generation = 1;
  const configTree = selectSharedTomlTree(toml.tree, schema);
  const config: SharedConfigBaseV1 = {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: configTree,
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, configTree),
  };
  const files = capabilities.files
    .filter((file) => file.scope === "shareable")
    .map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, bytes: Buffer.from(file.bytes) }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const manifest: SharedCapabilityManifestV1 = {
    version: VERSION,
    generation,
    files,
    fingerprint: capabilityManifestFingerprint(generation, files),
  };
  return { version: VERSION, config, capabilities: manifest, fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: manifest.fingerprint }) };
}

function withGeneration(base: SharedAccountBaseV1, generation: number): SharedAccountBaseV1 {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("invalid shared account base generation");
  const config: SharedConfigBaseV1 = {
    ...base.config,
    generation,
    fingerprint: baseConfigFingerprint(generation, base.config.schemaFingerprint, base.config.tree),
  };
  const capabilities: SharedCapabilityManifestV1 = {
    ...base.capabilities,
    generation,
    fingerprint: capabilityManifestFingerprint(generation, base.capabilities.files),
  };
  return { version: VERSION, config, capabilities, fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: capabilities.fingerprint }) };
}

function validateSchema(schema: AccountContinuitySchemaV1): void {
  if (schema.version !== VERSION || !isSha256(schema.schemaFingerprint)) throw new Error("invalid account continuity schema");
  for (const field of [...(schema.sharedTopLevel ?? []), ...(schema.alwaysLocalTopLevel ?? [])]) {
    if (typeof field !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(field)) throw new Error("invalid account continuity schema field");
  }
}

function pluginEnablementFromTree(tree: TomlTableV1, plugins: SharedPluginsManifestV1): { state: "ready"; value: Record<string, boolean> } | { state: "blocked"; reason: string } {
  const sealed = new Set(plugins.plugins.map((plugin) => plugin.id));
  if (plugins.version !== VERSION || !isSha256(plugins.fingerprint) || plugins.plugins.some((plugin) => !isSafePluginId(plugin.id))) {
    return { state: "blocked", reason: "invalid sealed plugin manifest" };
  }
  const result: Record<string, boolean> = {};
  for (const plugin of plugins.plugins) result[plugin.id] = Boolean(plugin.enabledByDefault);
  const pluginRoot = getTomlNode(tree, ["plugins"]);
  if (!pluginRoot) return { state: "ready", value: result };
  if (!isTomlTable(pluginRoot)) return { state: "blocked", reason: "plugins configuration is not a table" };
  for (const [id, configuration] of Object.entries(pluginRoot)) {
    // Stale/unavailable or newly account-local installations remain local
    // configuration. They never become invented shared package authority.
    if (!sealed.has(id)) continue;
    if (!isTomlTable(configuration)) return { state: "blocked", reason: "plugin configuration is not a table" };
    const enabled = configuration.enabled;
    if (enabled === undefined) continue;
    if (!isTomlScalar(enabled) || enabled.type !== "boolean") return { state: "blocked", reason: "plugin enabled flag is invalid" };
    result[id] = enabled.value;
  }
  return { state: "ready", value: result };
}

function isSafePluginId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes("\0") && !value.includes("/") && !value.includes("\\");
}

/**
 * Resolve a typed shared base plus explicit overrides.  `currentLocal` only
 * contributes always-local/unknown fields; shareable current fields must be
 * captured into an override before this function is used for a write.
 */
export function resolveAccountConfig(input: {
  readonly shared: SharedConfigBaseV1;
  readonly overrides: AccountConfigOverridesV1;
  readonly currentLocal: LosslessTomlDocument;
  readonly plugins: SharedPluginsManifestV1;
  readonly schema?: AccountContinuitySchemaV1;
}): ResolvedAccountConfigV1 {
  try {
    const schema = input.schema ?? { ...DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1, schemaFingerprint: input.shared.schemaFingerprint };
    validateSchema(schema);
    if (input.shared.version !== VERSION || input.shared.schemaFingerprint !== schema.schemaFingerprint || !isSha256(input.shared.fingerprint)) {
      return { state: "blocked", reason: "shared config base schema mismatch" };
    }
    if (input.overrides.version !== VERSION || !isOpaqueAccountId(input.overrides.opaqueAccountId) || !isSha256(input.overrides.fingerprint)) {
      return { state: "blocked", reason: "invalid config overrides" };
    }
    validateConfigOperations(input.overrides.operations);
    if (input.overrides.fingerprint !== accountConfigOverridesFingerprint({
      version: input.overrides.version,
      opaqueAccountId: input.overrides.opaqueAccountId,
      revision: input.overrides.revision,
      basedOnSharedGeneration: input.overrides.basedOnSharedGeneration,
      operations: input.overrides.operations,
      preservationFingerprint: input.overrides.preservationFingerprint,
    })) return { state: "blocked", reason: "config override fingerprint mismatch" };
    const effective = clone(input.shared.tree) as Record<string, TomlNodeV1>;
    const inherited = new Set<string>(flattenTomlLeaves(input.shared.tree).keys());
    for (const operation of input.overrides.operations) {
      if (operation.op === "set") setTomlNode(effective, operation.path, operation.value);
      else deleteTomlNode(effective, operation.path);
      for (const key of [...inherited]) {
        const path = decodePathKey(key);
        if (path.every((part) => typeof part === "string") && pathsOverlapBySegments(path as readonly string[], operation.path)) inherited.delete(key);
      }
    }
    for (const { path, value } of flattenTomlLeaves(input.currentLocal.tree).values()) {
      if (classifyTomlPath(path, schema, value) === "local"
        || (isPortableConfigUpgradePath(path) && getTomlNode(effective, path) === undefined
          && !input.overrides.operations.some((operation) => pathsOverlapBySegments(operation.path, path)))) setTomlNode(effective, path, value);
    }
    const plugins = pluginEnablementFromTree(effective, input.plugins);
    if (plugins.state === "blocked") return plugins;
    const resultTree = effective as TomlTableV1;
    return {
      state: "ready",
      tree: resultTree,
      effectiveFingerprint: sha256Json(resultTree),
      inheritedPaths: [...inherited].map((key) => decodePathKey(key) as readonly string[]).sort(compareStringPaths),
      pluginEnablement: plugins.value,
      preservationFingerprint: preservationFingerprint(input.currentLocal.tree, schema),
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "invalid account config input" };
  }
}

function compareStringPaths(left: readonly string[], right: readonly string[]): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function isSafeCapabilityRelativePath(value: string): value is CapabilityRelativePath {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0") || isAbsolute(value)) return false;
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === ".." || component.includes("\\"))) return false;
  if (components[0] !== "AGENTS.md" && components[0] !== "hooks.json" && components[0] !== "agents" && components[0] !== "skills") return false;
  if ((components[0] === "AGENTS.md" || components[0] === "hooks.json") && components.length !== 1) return false;
  return true;
}

function capabilityFileIsLocalOnly(relativePath: string): boolean {
  return relativePath.split("/").some((component) => credentialShaped(component));
}

function capabilityFingerprint(files: readonly { relativePath: string; fingerprint: Sha256; scope?: string }[]): Sha256 {
  return sha256Json(files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, scope: file.scope ?? "shareable" })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

function assertSafeCapabilityDirectory(path: string, allowMissing = false): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0) {
      throw new Error("unsafe account capability directory");
    }
    return true;
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    throw error;
  }
}

function scanCapabilityDirectory(root: string, prefix: string, files: CapabilityFileV1[], counters: { total: number; count: number }, depth: number): void {
  if (depth > MAX_CAPABILITY_DEPTH) throw new Error("account capability tree exceeds its maximum depth");
  for (const name of readdirSync(root).sort()) {
    if (name === ".DS_Store") continue;
    const relativePath = prefix ? `${prefix}/${name}` : name;
    if (!isSafeCapabilityRelativePath(relativePath)) throw new Error("unsafe account capability path");
    const path = join(root, name);
    const stat = lstatSync(path);
    // Linked skills can point to a project checkout or a plugin cache outside
    // this account home. They are intentionally left local and untouched;
    // following or copying them would turn a capability import into an
    // arbitrary-path read. Regular siblings remain eligible for continuity.
    if (stat.isSymbolicLink()) continue;
    if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) throw new Error("unsafe account capability entry");
    if ((process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0) throw new Error("unsafe account capability ownership");
    if (stat.isDirectory()) {
      if (name === "node_modules" || credentialShaped(name)) {
        // A credential-store-like directory must never be swept into an immutable generation.
        throw new Error("unsafe account capability container");
      }
      scanCapabilityDirectory(path, relativePath, files, counters, depth + 1);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CAPABILITY_FILE_BYTES) throw new Error("unsafe account capability file");
    if (counters.count >= MAX_CAPABILITY_FILES || counters.total + stat.size > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account capability tree exceeds its bounded size");
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account capability file");
    counters.count += 1;
    counters.total += bytes.byteLength;
    files.push({ relativePath, bytes, fingerprint: sha256(bytes), scope: capabilityFileIsLocalOnly(relativePath) ? "local_only" : "shareable" });
  }
}

/** Scan only the four declared capability roots without following links. */
export function scanCapabilityTree(root: string): CapabilityTreeSnapshotV1 {
  const canonicalRoot = resolve(root);
  assertSafeCapabilityDirectory(canonicalRoot);
  const files: CapabilityFileV1[] = [];
  const counters = { total: 0, count: 0 };
  for (const entry of ["AGENTS.md", "hooks.json", "agents", "skills"] as const) {
    const path = join(canonicalRoot, entry);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (entry === "agents" || entry === "skills") {
      if (!stat.isDirectory()) throw new Error("unsafe account capability root type");
      assertSafeCapabilityDirectory(path);
      scanCapabilityDirectory(path, entry, files, counters, 1);
      continue;
    }
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_CAPABILITY_FILE_BYTES || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0) {
      throw new Error("unsafe account capability file");
    }
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account capability file");
    counters.count += 1;
    counters.total += bytes.byteLength;
    if (counters.count > MAX_CAPABILITY_FILES || counters.total > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account capability tree exceeds its bounded size");
    files.push({ relativePath: entry, bytes, fingerprint: sha256(bytes), scope: capabilityFileIsLocalOnly(entry) ? "local_only" : "shareable" });
  }
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { version: VERSION, root: canonicalRoot, files, fingerprint: capabilityFingerprint(files) };
}

/** Snapshot explicitly installed primary links; destinations retain their own links. */
function scanPrimarySharedCapabilities(root: string): CapabilityTreeSnapshotV1 {
  const regular = scanCapabilityTree(root);
  const files = [...regular.files];
  const counters = { count: files.length, total: files.reduce((sum, file) => sum + file.bytes.byteLength, 0) };
  const importLink = (path: string, prefix: string) => {
    const before = lstatSync(path); const link = readlinkSync(path);
    if (before.uid !== process.getuid?.()) throw new Error("primary capability link has another owner");
    let target: string;
    try { target = realpathSync(path); } catch (error) { if (isMissing(error)) return; throw error; }
    assertSafeCapabilityDirectory(target);
    scanCapabilityDirectory(target, prefix, files, counters, 1);
    const after = lstatSync(path);
    if (!after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || readlinkSync(path) !== link || realpathSync(path) !== target) throw new Error("primary capability link changed during snapshot");
  };
  for (const name of ["skills", "agents"] as const) {
    const directory = join(resolve(root), name); const stat = lstatIfPresent(directory);
    if (!stat) continue;
    if (stat.isSymbolicLink()) { importLink(directory, name); continue; }
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (lstatSync(path).isSymbolicLink()) importLink(path, `${name}/${entry}`);
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { version: VERSION, root: resolve(root), files, fingerprint: capabilityFingerprint(files) };
}

function capabilityPathHasLocalLink(root: string, path: string): boolean {
  let current = resolve(root);
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatIfPresent(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
}

function validateCapabilityOperations(operations: readonly CapabilityOverrideOpV1[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    const key = capabilityPathKey(operation.relativePath);
    if (seen.has(key)) throw new Error("duplicate account continuity capability override");
    seen.add(key);
    if (operation.op === "set" && (!isSha256(operation.fingerprint) || !/^[a-f0-9]{64}$/.test(operation.payloadFile))) {
      throw new Error("invalid account continuity capability payload reference");
    }
  }
}

function normalizeCapabilityOperations(operations: readonly CapabilityOverrideOpV1[]): readonly CapabilityOverrideOpV1[] {
  validateCapabilityOperations(operations);
  return [...operations].map((operation) => clone(operation)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function buildCapabilityOverrides(
  opaqueAccountId: OpaqueAccountId,
  generation: number,
  snapshot: CapabilityTreeSnapshotV1,
  prior?: AccountCapabilityOverridesV1,
): AccountCapabilityOverridesV1 {
  const operations: CapabilityOverrideOpV1[] = snapshot.files
    .filter((file) => file.scope === "shareable")
    .map((file) => ({
      relativePath: file.relativePath,
      op: "set" as const,
      fingerprint: file.fingerprint,
      payloadFile: file.fingerprint.slice("sha256:".length),
    }));
  const draft: Omit<AccountCapabilityOverridesV1, "fingerprint" | "payloadRoot"> = {
    version: VERSION,
    opaqueAccountId,
    revision: prior ? prior.revision + 1 : 1,
    basedOnSharedGeneration: generation,
    operations: normalizeCapabilityOperations(operations),
    preservationFingerprint: capabilityFingerprint(snapshot.files.filter((file) => file.scope === "local_only")),
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft) };
}

function readCapabilityPayload(root: string | undefined, operation: CapabilityOverrideSetV1): Buffer | null {
  if (!root || !safeResolvedChild(root, operation.payloadFile)) return null;
  const bytes = readSafeRegularFile(join(root, operation.payloadFile), MAX_CAPABILITY_FILE_BYTES, true, true);
  if (!bytes || sha256(bytes) !== operation.fingerprint) {
    bytes?.fill(0);
    return null;
  }
  return bytes;
}

/** Resolve immutable shared bytes plus copy-on-write account payloads. */
export function resolveAccountCapabilities(input: {
  readonly shared: SharedCapabilityManifestV1;
  readonly overrides: AccountCapabilityOverridesV1;
  readonly currentLocalRoot: string;
}): ResolvedAccountCapabilitiesV1 {
  try {
    if (input.shared.version !== VERSION || !isSha256(input.shared.fingerprint)
      || input.shared.fingerprint !== capabilityManifestFingerprint(input.shared.generation, input.shared.files)) {
      return { state: "blocked", reason: "invalid shared capability manifest" };
    }
    if (input.overrides.version !== VERSION || !isOpaqueAccountId(input.overrides.opaqueAccountId) || !isSha256(input.overrides.fingerprint)) {
      return { state: "blocked", reason: "invalid capability overrides" };
    }
    validateCapabilityOperations(input.overrides.operations);
    const expectedOverrideFingerprint = accountCapabilityOverridesFingerprint({
      version: input.overrides.version,
      opaqueAccountId: input.overrides.opaqueAccountId,
      revision: input.overrides.revision,
      basedOnSharedGeneration: input.overrides.basedOnSharedGeneration,
      operations: input.overrides.operations,
      preservationFingerprint: input.overrides.preservationFingerprint,
    });
    if (input.overrides.fingerprint !== expectedOverrideFingerprint) return { state: "blocked", reason: "capability override fingerprint mismatch" };
    const resolved = new Map<string, ResolvedCapabilityFileV1>();
    const inherited = new Set<string>();
    for (const file of input.shared.files) {
      if (!isSafeCapabilityRelativePath(file.relativePath) || !isSha256(file.fingerprint) || !file.bytes || sha256(file.bytes) !== file.fingerprint) {
        return { state: "blocked", reason: "invalid immutable capability file" };
      }
      resolved.set(file.relativePath, { relativePath: file.relativePath, bytes: Buffer.from(file.bytes), fingerprint: file.fingerprint, provenance: "shared" });
      inherited.add(file.relativePath);
    }
    for (const operation of input.overrides.operations) {
      if (operation.op === "delete") {
        resolved.delete(operation.relativePath);
        inherited.delete(operation.relativePath);
        continue;
      }
      const bytes = readCapabilityPayload(input.overrides.payloadRoot, operation);
      if (!bytes) return { state: "blocked", reason: "capability override payload is missing or changed" };
      resolved.set(operation.relativePath, { relativePath: operation.relativePath, bytes, fingerprint: operation.fingerprint, provenance: "override" });
      inherited.delete(operation.relativePath);
    }
    for (const [path, file] of resolved) {
      if (capabilityPathHasLocalLink(input.currentLocalRoot, path)) {
        file.bytes.fill(0); resolved.delete(path); inherited.delete(path);
      }
    }
    const current = scanCapabilityTree(input.currentLocalRoot);
    for (const file of current.files) {
      if (file.scope !== "local_only") continue;
      const prior = resolved.get(file.relativePath);
      if (prior) {
        // Credential-shaped local content never silently shadows a shared file.
        for (const entry of resolved.values()) entry.bytes.fill(0);
        return { state: "blocked", reason: "local-only capability path collides with shared capability" };
      }
      resolved.set(file.relativePath, { relativePath: file.relativePath, bytes: Buffer.from(file.bytes), fingerprint: file.fingerprint, provenance: "local_only" });
    }
    const files = [...resolved.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      state: "ready",
      files,
      effectiveFingerprint: capabilityFingerprint(files),
      inheritedPaths: [...inherited].sort(),
      preservationFingerprint: capabilityFingerprint(current.files.filter((file) => file.scope === "local_only")),
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "invalid account capability input" };
  }
}

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function accountStateRoot(stateRoot: string, account: AccountContinuityAccountV1): string {
  if (!isOpaqueAccountId(account.opaqueAccountId)) throw new Error("invalid account continuity account id");
  const root = account.accountStateRoot ?? join(stateRoot, "accounts", account.opaqueAccountId);
  if (!isAbsolute(root)) throw new Error("account continuity state root must be absolute");
  return resolve(root);
}

function sharedAccountConfigRoot(stateRoot: string): string {
  if (!isAbsolute(stateRoot)) throw new Error("account continuity state root must be absolute");
  return join(resolve(stateRoot), ACCOUNT_CONFIG_DIRECTORY);
}

function assertSafeOwnerDirectory(path: string, create = false): void {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0) {
      throw new Error("account continuity refused an unsafe directory");
    }
  } else {
    if (!create) throw new Error("account continuity directory is missing");
    mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  chmodSync(resolved, PRIVATE_DIRECTORY_MODE);
  const checked = statSync(resolved);
  if (!checked.isDirectory() || (process.getuid?.() !== undefined && checked.uid !== process.getuid?.()) || (checked.mode & 0o077) !== 0) {
    throw new Error("account continuity directory is not owner-private");
  }
}

function assertSafePrivateDirectoryReadOnly(path: string): void {
  assertSafeCapabilityDirectory(path);
  const stat = lstatSync(path);
  if ((stat.mode & 0o077) !== 0 || realpathSync(path) !== resolve(path)) throw new Error("account continuity directory is not owner-private");
}

function safeResolvedChild(root: string, child: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(root, child);
  const relation = relative(resolvedRoot, resolvedChild);
  return relation !== "" && !relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation);
}

function assertSafeRegularFile(path: string, maxBytes: number, allowEmpty: boolean, requirePrivate: boolean): Stats {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())
    || (requirePrivate ? (stat.mode & 0o077) !== 0 : (stat.mode & 0o022) !== 0)
    || stat.size > maxBytes || (!allowEmpty && stat.size === 0)) throw new Error("account continuity refused an unsafe regular file");
  return stat;
}

/** A bounded double-stat, no-follow read. Caller owns and clears sensitive buffers. */
function readSafeRegularFile(path: string, maxBytes: number, allowEmpty: boolean, requirePrivate: boolean): Buffer | null {
  let descriptor: number | undefined;
  let bytes: Buffer | null = null;
  let accepted = false;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || (process.getuid?.() !== undefined && before.uid !== process.getuid?.())
      || (requirePrivate ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0)
      || before.size > maxBytes || (!allowEmpty && before.size === 0)) return null;
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (!read) return null;
      offset += read;
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return null;
    accepted = true;
    return bytes;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (bytes && !accepted) bytes.fill(0);
  }
}

function atomicWriteFile(path: string, bytes: Buffer, mode: number, requireExistingSafe = false): void {
  const parent = dirname(path);
  assertSafeOwnerDirectory(parent);
  if (bytes.byteLength > MAX_CAPABILITY_TOTAL_BYTES) throw new Error("account continuity refused an oversized write");
  if (existsSync(path)) {
    if (requireExistingSafe) assertSafeRegularFile(path, Math.max(MAX_CONFIG_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, false);
    else assertSafeRegularFile(path, Math.max(MAX_METADATA_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, true);
  }
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    assertSafeRegularFile(temporary, Math.max(MAX_CONFIG_BYTES, MAX_CAPABILITY_TOTAL_BYTES), true, mode === PRIVATE_FILE_MODE);
    renameSync(temporary, path);
    chmodSync(path, mode);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) {
      try { unlinkSync(temporary); } catch { /* exact private temporary only */ }
    }
  }
}

function atomicWritePrivateJson(root: string, fileName: string, value: unknown): void {
  assertSafeOwnerDirectory(root, true);
  if (basename(fileName) !== fileName || fileName.includes("..")) throw new Error("unsafe account continuity metadata file");
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.byteLength > MAX_METADATA_BYTES) throw new Error("account continuity metadata exceeds its bounded size");
  atomicWriteFile(join(root, fileName), bytes, PRIVATE_FILE_MODE);
}

function readPrivateJson(root: string, fileName: string): unknown | null {
  if (basename(fileName) !== fileName || fileName.includes("..")) throw new Error("unsafe account continuity metadata file");
  const path = join(root, fileName);
  if (!existsSync(path)) return null;
  const bytes = readSafeRegularFile(path, MAX_METADATA_BYTES, false, true);
  if (!bytes) throw new Error("unsafe account continuity metadata file");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    bytes.fill(0);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch {
    // APFS may decline directory fsync. File fsync + same-filesystem rename remains conservative.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateTomlNode(value: unknown): value is TomlNodeV1 {
  if (!isRecord(value)) return false;
  if (typeof value.type === "string") {
    switch (value.type) {
      case "string": return typeof value.value === "string";
      case "boolean": return typeof value.value === "boolean";
      case "integer": return typeof value.value === "string" && /^-?[0-9]+$/.test(value.value);
      case "float": return typeof value.value === "string" && /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value.value);
      case "datetime": return typeof value.value === "string" && ["offset-date-time", "local-date-time", "local-date", "local-time"].includes(String(value.kind));
      case "array": return Array.isArray(value.values) && value.values.every(validateTomlDataValue);
      case "inline-table": return isRecord(value.entries) && Object.values(value.entries).every(validateTomlNode);
      case "array-table": return Array.isArray(value.entries) && value.entries.every((entry) => isRecord(entry) && Object.values(entry).every(validateTomlNode));
      default: return false;
    }
  }
  return Object.keys(value).every((key) => key.length > 0 && Object.prototype.hasOwnProperty.call(value, key) && validateTomlNode(value[key]));
}

function validateTomlDataValue(value: unknown): value is TomlDataValueV1 {
  return validateTomlNode(value) && isTomlDataValue(value);
}

function parseConfigOverrides(value: unknown, payloadRoot?: string): AccountConfigOverridesV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "revision", "basedOnSharedGeneration", "operations", "preservationFingerprint", "fingerprint"].includes(key))
    || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !Number.isSafeInteger(value.basedOnSharedGeneration) || Number(value.basedOnSharedGeneration) < 1 || !Array.isArray(value.operations)
    || !isSha256(value.preservationFingerprint) || !isSha256(value.fingerprint)) return null;
  const operations: ConfigOverrideOpV1[] = [];
  for (const operation of value.operations) {
    if (!isRecord(operation) || !Array.isArray(operation.path) || operation.path.some((part) => typeof part !== "string" || part.length === 0)) return null;
    if (operation.op === "delete" && Object.keys(operation).length === 2) operations.push({ path: operation.path, op: "delete" });
    else if (operation.op === "set" && Object.keys(operation).length === 3 && validateTomlNode(operation.value)) operations.push({ path: operation.path, op: "set", value: operation.value });
    else return null;
  }
  try { validateConfigOperations(operations); } catch { return null; }
  const draft: Omit<AccountConfigOverridesV1, "fingerprint"> = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId as OpaqueAccountId,
    revision: value.revision as number,
    basedOnSharedGeneration: value.basedOnSharedGeneration as number,
    operations: normalizeConfigOperations(operations),
    preservationFingerprint: value.preservationFingerprint as Sha256,
  };
  if (accountConfigOverridesFingerprint(draft) !== (value.fingerprint as Sha256)) return null;
  void payloadRoot;
  return { ...draft, fingerprint: value.fingerprint as Sha256 };
}

function parseCapabilityOverrides(value: unknown, payloadRoot?: string): AccountCapabilityOverridesV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "revision", "basedOnSharedGeneration", "operations", "preservationFingerprint", "fingerprint"].includes(key))
    || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
    || !Number.isSafeInteger(value.basedOnSharedGeneration) || Number(value.basedOnSharedGeneration) < 1 || !Array.isArray(value.operations)
    || !isSha256(value.preservationFingerprint) || !isSha256(value.fingerprint)) return null;
  const operations: CapabilityOverrideOpV1[] = [];
  for (const operation of value.operations) {
    if (!isRecord(operation) || typeof operation.relativePath !== "string" || !isSafeCapabilityRelativePath(operation.relativePath)) return null;
    if (operation.op === "delete" && Object.keys(operation).length === 2) operations.push({ relativePath: operation.relativePath, op: "delete" });
    else if (operation.op === "set" && Object.keys(operation).length === 4 && isSha256(operation.fingerprint) && typeof operation.payloadFile === "string") {
      operations.push({ relativePath: operation.relativePath, op: "set", fingerprint: operation.fingerprint, payloadFile: operation.payloadFile });
    } else return null;
  }
  try { validateCapabilityOperations(operations); } catch { return null; }
  const draft: Omit<AccountCapabilityOverridesV1, "fingerprint" | "payloadRoot"> = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId as OpaqueAccountId,
    revision: value.revision as number,
    basedOnSharedGeneration: value.basedOnSharedGeneration as number,
    operations: normalizeCapabilityOperations(operations),
    preservationFingerprint: value.preservationFingerprint as Sha256,
  };
  if (accountCapabilityOverridesFingerprint(draft) !== (value.fingerprint as Sha256)) return null;
  return { ...draft, fingerprint: value.fingerprint as Sha256, ...(payloadRoot ? { payloadRoot } : {}) };
}

function serializableSharedBase(base: SharedAccountBaseV1): unknown {
  return {
    version: VERSION,
    config: base.config,
    capabilities: {
      version: base.capabilities.version,
      generation: base.capabilities.generation,
      files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })),
      fingerprint: base.capabilities.fingerprint,
    },
    fingerprint: base.fingerprint,
  };
}

function parseSharedBase(value: unknown, root?: string, readOnly = false): SharedAccountBaseV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "config", "capabilities", "fingerprint"].includes(key)) || value.version !== VERSION
    || !isRecord(value.config) || !isRecord(value.capabilities) || !isSha256(value.fingerprint)) return null;
  const config = value.config as Record<string, unknown>;
  if (Object.keys(config).some((key) => !["version", "generation", "schemaFingerprint", "tree", "fingerprint"].includes(key)) || config.version !== VERSION
    || !Number.isSafeInteger(config.generation) || Number(config.generation) < 1 || !isSha256(config.schemaFingerprint) || !validateTomlNode(config.tree) || !isTomlTable(config.tree) || !isSha256(config.fingerprint)) return null;
  const expectedConfig: SharedConfigBaseV1 = {
    version: VERSION,
    generation: config.generation as number,
    schemaFingerprint: config.schemaFingerprint as Sha256,
    tree: config.tree as TomlTableV1,
    fingerprint: baseConfigFingerprint(config.generation as number, config.schemaFingerprint as Sha256, config.tree as TomlTableV1),
  };
  if (expectedConfig.fingerprint !== (config.fingerprint as Sha256)) return null;
  const cap = value.capabilities as Record<string, unknown>;
  if (Object.keys(cap).some((key) => !["version", "generation", "files", "fingerprint"].includes(key)) || cap.version !== VERSION || cap.generation !== config.generation
    || !Array.isArray(cap.files) || !isSha256(cap.fingerprint)) return null;
  const files: SharedCapabilityFileV1[] = [];
  for (const entry of cap.files) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "relativePath" && key !== "fingerprint") || !isSafeCapabilityRelativePath(String(entry.relativePath)) || !isSha256(entry.fingerprint)) return null;
    files.push({ relativePath: entry.relativePath as CapabilityRelativePath, fingerprint: entry.fingerprint as Sha256 });
  }
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) return null;
  if (capabilityManifestFingerprint(config.generation as number, files) !== (cap.fingerprint as Sha256)) return null;
  const capabilities: SharedCapabilityManifestV1 = { version: VERSION, generation: config.generation as number, files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)), fingerprint: cap.fingerprint as Sha256 };
  const base: SharedAccountBaseV1 = { version: VERSION, config: expectedConfig, capabilities, fingerprint: sha256Json({ version: VERSION, config: expectedConfig.fingerprint, capabilities: capabilities.fingerprint }) };
  if (base.fingerprint !== (value.fingerprint as Sha256)) return null;
  if (!root) return base;
  const generationRoot = join(root, CAPABILITY_GENERATIONS_DIRECTORY, String(config.generation));
  try {
    if (readOnly) {
      assertSafeCapabilityDirectory(generationRoot);
      if (realpathSync(generationRoot) !== generationRoot || (lstatSync(generationRoot).mode & 0o077) !== 0) return null;
    } else assertSafeOwnerDirectory(generationRoot);
    const hydrated = base.capabilities.files.map((file) => {
      const path = join(generationRoot, ...file.relativePath.split("/"));
      if (!safeResolvedChild(generationRoot, relative(generationRoot, path))) throw new Error("unsafe immutable capability path");
      const bytes = readSafeRegularFile(path, MAX_CAPABILITY_FILE_BYTES, true, true);
      if (!bytes || sha256(bytes) !== file.fingerprint) throw new Error("immutable capability file changed");
      return { ...file, bytes };
    });
    const manifestBytes = readSafeRegularFile(join(generationRoot, CAPABILITY_MANIFEST_FILE), MAX_METADATA_BYTES, false, true);
    if (!manifestBytes || sha256(manifestBytes) !== sha256Json({ version: VERSION, generation: config.generation, files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })) })) {
      manifestBytes?.fill(0);
      throw new Error("immutable capability manifest changed");
    }
    manifestBytes.fill(0);
    return { ...base, capabilities: { ...base.capabilities, files: hydrated, root: generationRoot } };
  } catch {
    return null;
  }
}

/** Load and hydrate the latest immutable shared base from manager-private state. */
export function loadSharedAccountBase(stateRoot: string): SharedAccountBaseV1 | null {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafePrivateDirectoryReadOnly(root);
    return parseSharedBase(readPrivateJson(root, BASE_FILE), root);
  } catch {
    return null;
  }
}

/** Load one account's typed config sidecar. */
export function loadAccountConfigOverrides(stateRoot: string, account: AccountContinuityAccountV1): AccountConfigOverridesV1 | null {
  try {
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    const parsed = parseConfigOverrides(readPrivateJson(root, CONFIG_OVERRIDES_FILE));
    return parsed?.opaqueAccountId === account.opaqueAccountId ? parsed : null;
  } catch {
    return null;
  }
}

/** Load one account's capability sidecar and bind it to its private payload directory. */
export function loadAccountCapabilityOverrides(stateRoot: string, account: AccountContinuityAccountV1): AccountCapabilityOverridesV1 | null {
  try {
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    const payloadRoot = join(root, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
    assertSafeOwnerDirectory(payloadRoot);
    const parsed = parseCapabilityOverrides(readPrivateJson(root, CAPABILITY_OVERRIDES_FILE), payloadRoot);
    return parsed?.opaqueAccountId === account.opaqueAccountId ? parsed : null;
  } catch {
    return null;
  }
}

function writeCapabilityPayloads(accountRoot: string, snapshot: CapabilityTreeSnapshotV1): void {
  const payloadRoot = join(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
  assertSafeOwnerDirectory(payloadRoot, true);
  for (const file of snapshot.files) {
    if (file.scope !== "shareable") continue;
    const fileName = file.fingerprint.slice("sha256:".length);
    const target = join(payloadRoot, fileName);
    if (existsSync(target)) {
      const existing = readSafeRegularFile(target, MAX_CAPABILITY_FILE_BYTES, true, true);
      if (!existing || sha256(existing) !== file.fingerprint) {
        existing?.fill(0);
        throw new Error("account capability override payload collision");
      }
      existing.fill(0);
      continue;
    }
    atomicWriteFile(target, file.bytes, PRIVATE_FILE_MODE);
  }
}

function persistConfigOverrides(root: string, overrides: AccountConfigOverridesV1): void {
  atomicWritePrivateJson(root, CONFIG_OVERRIDES_FILE, {
    version: overrides.version,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision,
    basedOnSharedGeneration: overrides.basedOnSharedGeneration,
    operations: overrides.operations,
    preservationFingerprint: overrides.preservationFingerprint,
    fingerprint: overrides.fingerprint,
  });
}

function persistCapabilityOverrides(root: string, overrides: AccountCapabilityOverridesV1): void {
  atomicWritePrivateJson(root, CAPABILITY_OVERRIDES_FILE, {
    version: overrides.version,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision,
    basedOnSharedGeneration: overrides.basedOnSharedGeneration,
    operations: overrides.operations,
    preservationFingerprint: overrides.preservationFingerprint,
    fingerprint: overrides.fingerprint,
  });
}

function readAccountConfig(codexHome: string): LosslessTomlDocument {
  assertSafeCapabilityDirectory(codexHome);
  const path = join(codexHome, "config.toml");
  return existsSync(path) ? readLosslessTomlDocument(path) : parseLosslessTomlDocument("");
}

function writeSharedAccountBase(stateRoot: string, base: SharedAccountBaseV1, expectedPriorFingerprint?: Sha256): void {
  const root = sharedAccountConfigRoot(stateRoot);
  assertSafeOwnerDirectory(root, true);
  const current = parseSharedBase(readPrivateJson(root, BASE_FILE), root);
  if (expectedPriorFingerprint === undefined) {
    if (current !== null) throw new Error("shared account base already exists; refusing overwrite");
  } else if (!current || current.fingerprint !== expectedPriorFingerprint) {
    throw new Error("shared account base changed before primary publication");
  }
  const generationsRoot = join(root, CAPABILITY_GENERATIONS_DIRECTORY);
  assertSafeOwnerDirectory(generationsRoot, true);
  const generationRoot = join(generationsRoot, String(base.config.generation));
  if (existsSync(generationRoot)) throw new Error("shared account capability generation already exists");
  mkdirSync(generationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertSafeOwnerDirectory(generationRoot);
  try {
    for (const file of base.capabilities.files) {
      if (!file.bytes || !isSafeCapabilityRelativePath(file.relativePath) || sha256(file.bytes) !== file.fingerprint) throw new Error("invalid shared capability source");
      const target = join(generationRoot, ...file.relativePath.split("/"));
      const targetDirectory = dirname(target);
      if (resolve(targetDirectory) !== resolve(generationRoot) && !safeResolvedChild(generationRoot, relative(generationRoot, targetDirectory))) {
        throw new Error("unsafe shared capability target");
      }
      assertSafeOwnerDirectory(targetDirectory, true);
      atomicWriteFile(target, file.bytes, PRIVATE_FILE_MODE);
    }
    const manifest = {
      version: VERSION,
      generation: base.capabilities.generation,
      files: base.capabilities.files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })),
    };
    atomicWriteFile(join(generationRoot, CAPABILITY_MANIFEST_FILE), Buffer.from(stableJson(manifest)), PRIVATE_FILE_MODE);
    chmodSync(generationRoot, 0o500);
    // Immutable payloads become read-only before any base manifest can point at them.
    makeTreeReadOnly(generationRoot);
    atomicWritePrivateJson(root, BASE_FILE, serializableSharedBase(base));
    atomicWritePrivateJson(root, BASE_RECEIPT_FILE, {
      version: VERSION,
      generation: base.config.generation,
      configFingerprint: base.config.fingerprint,
      capabilityFingerprint: base.capabilities.fingerprint,
      baseFingerprint: base.fingerprint,
    });
  } catch (error) {
    // No completed receipt means this generation is not usable. Preserve it for
    // manual inspection rather than guessing whether a concurrent writer owns it.
    throw error;
  }
}

function primaryPublishedSharedBase(
  prior: SharedAccountBaseV1,
  proposedConfig: SharedConfigBaseV1,
  proposedCapabilities: CapabilityTreeSnapshotV1,
  schema: AccountContinuitySchemaV1,
): SharedAccountBaseV1 {
  validateSchema(schema);
  const generation = prior.config.generation + 1;
  if (!Number.isSafeInteger(generation) || proposedConfig.version !== VERSION || proposedConfig.generation !== generation
    || proposedConfig.schemaFingerprint !== schema.schemaFingerprint || !validateTomlNode(proposedConfig.tree) || !isTomlTable(proposedConfig.tree)
    || proposedConfig.fingerprint !== baseConfigFingerprint(generation, schema.schemaFingerprint, proposedConfig.tree)) {
    throw new Error("invalid primary shared config publication candidate");
  }
  if (proposedCapabilities.version !== VERSION || proposedCapabilities.fingerprint !== capabilityFingerprint(proposedCapabilities.files)) {
    throw new Error("invalid primary shared capability publication candidate");
  }
  const files = proposedCapabilities.files
    .filter((file) => file.scope === "shareable")
    .map((file) => {
      if (!isSafeCapabilityRelativePath(file.relativePath) || !isSha256(file.fingerprint) || sha256(file.bytes) !== file.fingerprint) {
        throw new Error("invalid primary shared capability source");
      }
      return { relativePath: file.relativePath, fingerprint: file.fingerprint, bytes: Buffer.from(file.bytes) };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (new Set(files.map((file) => file.relativePath)).size !== files.length) throw new Error("duplicate primary shared capability path");
  const config: SharedConfigBaseV1 = {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: clone(proposedConfig.tree),
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, proposedConfig.tree),
  };
  const capabilities: SharedCapabilityManifestV1 = {
    version: VERSION,
    generation,
    files,
    fingerprint: capabilityManifestFingerprint(generation, files),
  };
  return {
    version: VERSION,
    config,
    capabilities,
    fingerprint: sha256Json({ version: VERSION, config: config.fingerprint, capabilities: capabilities.fingerprint }),
  };
}

/**
 * Atomically advance the shared primary generation after its child has closed.
 * It only writes manager-private state; account homes are never changed here.
 */
export function publishPrimarySharedBaseAfterExit(input: PublishPrimarySharedBaseInputV1): PublishPrimarySharedBaseResultV1 {
  try {
    validateSchema(input.schema);
    const current = loadSharedAccountBase(input.stateRoot);
    if (!current || current.fingerprint !== input.prior.fingerprint) {
      return { state: "blocked", reason: "shared account base changed before primary publication" };
    }
    const shared = primaryPublishedSharedBase(current, input.proposedConfig, input.proposedCapabilities, input.schema);
    if (!input.apply) return { state: "would_publish", shared };
    writeSharedAccountBase(input.stateRoot, shared, current.fingerprint);
    const persisted = loadSharedAccountBase(input.stateRoot);
    if (!persisted || persisted.fingerprint !== shared.fingerprint) {
      return { state: "blocked", reason: "published shared account base could not be revalidated" };
    }
    return { state: "published", shared: persisted };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "primary shared base publication failed" };
  }
}

function makeTreeReadOnly(root: string): void {
  const stat = lstatSync(root);
  if (stat.isDirectory()) {
    for (const name of readdirSync(root)) makeTreeReadOnly(join(root, name));
    chmodSync(root, 0o500);
  } else if (stat.isFile()) chmodSync(root, 0o400);
  else throw new Error("unsafe immutable capability artifact");
}

interface PluginSourceFileV1 {
  readonly path: string;
  readonly bytes: number;
  readonly fingerprint: Sha256;
  readonly linkTarget?: string;
  readonly executable?: boolean;
}

interface PluginSourcePackageV1 {
  readonly id: string;
  readonly registry: string;
  readonly name: string;
  readonly version: string;
  readonly files: readonly PluginSourceFileV1[];
  readonly fingerprint: Sha256;
  readonly bytes: number;
}

const MAX_PLUGIN_FILES = 250_000;
const MAX_PLUGIN_BYTES = 4 * 1024 * 1024 * 1024;

function isSafePluginSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

/** Exact credential containers are account-local; code names such as token.ts remain package code. */
function pluginPrivateContainer(name: string): boolean {
  const value = name.toLowerCase();
  return value === ".env" || value.startsWith(".env.")
    || ["auth.json", "authorization.json", "cookies.json", "credentials", "credentials.json", "oauth.json", "token.json", "tokens.json", "secret.json", "secrets.json", "client_secret.json", "api-key.json", "api_key.json", ".netrc"].includes(value)
    || value.endsWith(".sqlite");
}

function scanPluginPackage(root: string): PluginSourceFileV1[] {
  assertSafeCapabilityDirectory(root);
  const canonicalRoot = realpathSync(root);
  const files: PluginSourceFileV1[] = [];
  let total = 0;
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > 64) throw new Error("plugin package exceeds maximum depth");
    for (const name of readdirSync(directory).sort()) {
      if (name === ".DS_Store" || pluginPrivateContainer(name)) continue;
      if (!isSafePluginSegment(name)) throw new Error("unsafe plugin package path");
      const path = join(directory, name);
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (relativePath === ".venv/.lock" && stat.isFile() && stat.size === 0 && stat.nlink === 1) continue;
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(path);
        const target = realpathSync(path);
        const targetRelative = relative(canonicalRoot, target);
        if (isAbsolute(linkTarget) || !targetRelative || targetRelative.startsWith(`..${sep}`) || targetRelative === ".."
          || targetRelative.split(sep).some(pluginPrivateContainer)) throw new Error("plugin package link escapes its definition tree");
        files.push({ path: relativePath, bytes: 0, fingerprint: sha256Json({ linkTarget }), linkTarget });
        continue;
      }
      if (stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()
        || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.()) || (stat.mode & 0o022) !== 0) throw new Error("unsafe plugin package entry");
      if (stat.isDirectory()) { visit(path, relativePath, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_PLUGIN_BYTES || files.length >= MAX_PLUGIN_FILES || total + stat.size > MAX_PLUGIN_BYTES) {
        throw new Error("plugin package exceeds bounded size");
      }
      const bytes = readSafeRegularFile(path, MAX_PLUGIN_BYTES, true, false);
      if (!bytes) throw new Error("unsafe plugin package file");
      try {
        total += bytes.byteLength;
        files.push({ path: relativePath, bytes: bytes.byteLength, fingerprint: sha256(bytes), executable: (stat.mode & 0o111) !== 0 });
      } finally { bytes.fill(0); }
    }
  };
  visit(root, "", 0);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Matches Codex core-plugins/store.rs: real directories, local preferred, then version ordering. */
function compareNativePluginVersions(left: string, right: string): number {
  const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
  const a = pattern.exec(left), b = pattern.exec(right);
  const lexical = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0;
  if (!a || !b) return lexical(left, right);
  for (let i = 1; i <= 3; i++) { const x = BigInt(a[i]!), y = BigInt(b[i]!); if (x !== y) return x < y ? -1 : 1; }
  if (a[4] !== b[4]) {
    if (!a[4]) return 1;
    if (!b[4]) return -1;
    const x = a[4].split("."), y = b[4].split(".");
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] === undefined) return -1;
      if (y[i] === undefined) return 1;
      if (x[i] === y[i]) continue;
      const xn = /^[0-9]+$/.test(x[i]!), yn = /^[0-9]+$/.test(y[i]!);
      if (xn && yn) return BigInt(x[i]!) < BigInt(y[i]!) ? -1 : 1;
      if (xn !== yn) return xn ? -1 : 1;
      return lexical(x[i]!, y[i]!);
    }
  }
  return lexical(a[5] ?? "", b[5] ?? "");
}

function scanPluginCache(source: string, enabledIds?: ReadonlySet<string>): PluginSourcePackageV1[] {
  assertSafeCapabilityDirectory(source);
  const packages: PluginSourcePackageV1[] = [];
  const selectedRegistries = enabledIds ? new Set([...enabledIds].map((id) => id.split("@")[1])) : undefined;
  for (const registry of readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (selectedRegistries && !selectedRegistries.has(registry)) continue;
    if (!isSafePluginSegment(registry)) throw new Error("unsafe plugin registry");
    const registryRoot = join(source, registry);
    assertSafeCapabilityDirectory(registryRoot);
    for (const name of readdirSync(registryRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()) {
      const id = `${name}@${registry}`;
      if (enabledIds && !enabledIds.has(id)) continue;
      if (!isSafePluginSegment(name)) throw new Error("unsafe plugin name");
      const nameRoot = join(registryRoot, name);
      assertSafeCapabilityDirectory(nameRoot);
      const versions = readdirSync(nameRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()
        && /^[A-Za-z0-9_.+-]+$/.test(entry.name) && entry.name !== "." && entry.name !== "..").map((entry) => entry.name).sort(compareNativePluginVersions);
      const version = versions.includes("local") ? "local" : versions.at(-1);
      if (!version) continue;
      const files = scanPluginPackage(join(nameRoot, version));
      if (!files.length) throw new Error("empty plugin package is not a sealed inventory entry");
      packages.push({ id, registry, name, version, files, fingerprint: sha256Json({ id, version, files }), bytes: files.reduce((total, file) => total + file.bytes, 0) });
    }
  }
  return packages.sort((left, right) => left.id.localeCompare(right.id));
}

function pluginInventoryFingerprint(generation: number, plugins: readonly SharedPluginInventoryEntryV1[]): Sha256 {
  return sha256Json({
    version: VERSION,
    generation,
    plugins: [...plugins].map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
      fingerprint: plugin.fingerprint,
      fileCount: plugin.fileCount,
      bytes: plugin.bytes,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function copyPluginPackage(
  source: string,
  destination: string,
  files: readonly PluginSourceFileV1[],
  immutable = true,
  afterFile?: () => void,
): void {
  assertSafeCapabilityDirectory(source);
  assertSafeOwnerDirectory(destination, true);
  for (const file of files) {
    const target = join(destination, ...file.path.split("/"));
    assertSafeOwnerDirectory(dirname(target), true);
    if (file.linkTarget !== undefined) symlinkSync(file.linkTarget, target);
    else {
      const bytes = readSafeRegularFile(join(source, ...file.path.split("/")), MAX_PLUGIN_BYTES, true, false);
      if (!bytes || sha256(bytes) !== file.fingerprint) throw new Error("plugin source changed before immutable copy");
      try { atomicWriteFile(target, bytes, file.executable ? 0o700 : PRIVATE_FILE_MODE); } finally { bytes.fill(0); }
    }
    afterFile?.();
  }
  const seal = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) seal(join(path, entry)); chmodSync(path, 0o500); }
    else if (stat.isFile()) chmodSync(path, stat.mode & 0o111 ? 0o500 : 0o400);
    else throw new Error("unsafe plugin seal artifact");
  };
  if (immutable) seal(destination);
}

function pluginGenerationArtifactFingerprint(manifest: SharedPluginsManifestV1, cache: string): Sha256 | null {
  assertSafePrivateDirectoryReadOnly(cache);
  const expected = new Map(manifest.plugins.map((plugin) => {
    const [name, registry] = plugin.id.split("@");
    return [`${registry}/${name}`, plugin] as const;
  }));
  const actual: SharedPluginInventoryEntryV1[] = [];
  for (const registry of readdirSync(cache).sort()) {
    if (!isSafePluginSegment(registry)) throw new Error("unsafe shared plugin generation registry");
    const registryRoot = join(cache, registry);
    assertSafePrivateDirectoryReadOnly(registryRoot);
    for (const name of readdirSync(registryRoot).sort()) {
      if (!isSafePluginSegment(name)) throw new Error("unsafe shared plugin generation name");
      const nameRoot = join(registryRoot, name);
      assertSafePrivateDirectoryReadOnly(nameRoot);
      const plugin = expected.get(`${registry}/${name}`);
      if (!plugin) throw new Error("unexpected shared plugin generation package");
      const versions = readdirSync(nameRoot);
      if (versions.length === 0) continue;
      if (versions.length !== 1 || versions[0] !== plugin.version) throw new Error("unexpected shared plugin generation version");
      const versionRoot = join(nameRoot, plugin.version);
      assertSafePrivateDirectoryReadOnly(versionRoot);
      let files: PluginSourceFileV1[];
      try { files = scanPluginPackage(versionRoot); }
      catch (error) {
        if (error instanceof Error && error.message === "empty plugin package is not a sealed inventory entry") return null;
        throw error;
      }
      const fingerprint = sha256Json({ id: plugin.id, version: plugin.version, files });
      actual.push({ id: plugin.id, version: plugin.version, fingerprint, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) });
    }
  }
  return pluginInventoryFingerprint(manifest.generation!, actual);
}

function assertPluginGenerationContainer(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())
    || (stat.mode & 0o077) !== 0 || realpathSync(path) !== resolve(path)) {
    throw new Error("unsafe shared plugin generation container");
  }
  const entries = readdirSync(path);
  if (entries.some((entry) => entry !== "cache" && entry !== PLUGIN_GENERATION_MANIFEST_FILE)) {
    throw new Error("unexpected shared plugin generation artifact");
  }
  if (entries.includes("cache")) assertSafePrivateDirectoryReadOnly(join(path, "cache"));
  else if (entries.includes(PLUGIN_GENERATION_MANIFEST_FILE)) throw new Error("shared plugin generation manifest lacks a cache");
}

function verifiedPluginGeneration(path: string, manifest: SharedPluginsManifestV1): boolean {
  assertPluginGenerationContainer(path);
  if (!existsSync(join(path, "cache"))) return false;
  const localManifest = readPrivateJson(path, PLUGIN_GENERATION_MANIFEST_FILE);
  if (localManifest !== null) {
    const parsed = parseSharedPluginsManifest(localManifest);
    if (!parsed || parsed.generation !== manifest.generation || parsed.fingerprint !== manifest.fingerprint) {
      throw new Error("shared plugin generation manifest does not match candidate");
    }
  }
  try {
    const artifactFingerprint = pluginGenerationArtifactFingerprint(manifest, join(path, "cache"));
    if (localManifest !== null && artifactFingerprint !== manifest.fingerprint) {
      throw new Error("sealed shared plugin generation payload changed");
    }
    return artifactFingerprint === manifest.fingerprint;
  } catch (error) {
    if (localManifest === null && error instanceof Error && error.message === "empty plugin package is not a sealed inventory entry") return false;
    throw error;
  }
}

function sealPluginGeneration(path: string, manifest: SharedPluginsManifestV1): void {
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  const manifestPath = join(path, PLUGIN_GENERATION_MANIFEST_FILE);
  if (!existsSync(manifestPath)) atomicWritePrivateJson(path, PLUGIN_GENERATION_MANIFEST_FILE, {
    version: VERSION,
    generation: manifest.generation,
    plugins: manifest.plugins,
    fingerprint: manifest.fingerprint,
  });
  const seal = (entryPath: string): void => {
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(entryPath)) seal(join(entryPath, entry));
      chmodSync(entryPath, 0o500);
    } else if (stat.isFile()) chmodSync(entryPath, stat.mode & 0o111 ? 0o500 : 0o400);
    else throw new Error("unsafe shared plugin generation artifact");
  };
  seal(path);
}

function parseSharedPluginsManifest(value: unknown, root?: string): SharedPluginsManifestV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "generation", "plugins", "fingerprint"].includes(key)) || value.version !== VERSION
    || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 || !Array.isArray(value.plugins) || !isSha256(value.fingerprint)) return null;
  const plugins: SharedPluginInventoryEntryV1[] = [];
  for (const plugin of value.plugins) {
    if (!isRecord(plugin) || Object.keys(plugin).some((key) => !["id", "version", "fingerprint", "fileCount", "bytes"].includes(key))
      || !isSafePluginId(String(plugin.id)) || typeof plugin.version !== "string" || !isSafePluginSegment(plugin.version)
      || !isSha256(plugin.fingerprint) || !Number.isSafeInteger(plugin.fileCount) || Number(plugin.fileCount) < 1
      || !Number.isSafeInteger(plugin.bytes) || Number(plugin.bytes) < 0) return null;
    plugins.push({
      id: plugin.id as string,
      version: plugin.version as string,
      fingerprint: plugin.fingerprint as Sha256,
      fileCount: plugin.fileCount as number,
      bytes: plugin.bytes as number,
    });
  }
  if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length || pluginInventoryFingerprint(value.generation as number, plugins) !== (value.fingerprint as Sha256)) return null;
  const manifest: SharedPluginsManifestV1 = { version: VERSION, generation: value.generation as number, plugins: plugins.sort((left, right) => left.id.localeCompare(right.id)), fingerprint: value.fingerprint as Sha256 };
  if (!root) return manifest;
  const cache = join(root, PLUGIN_GENERATIONS_DIRECTORY, String(value.generation), "cache");
  try {
    const scanned = scanPluginCache(cache);
    const actual = scanned.map((entry) => ({ id: entry.id, version: entry.version, fingerprint: entry.fingerprint, fileCount: entry.files.length, bytes: entry.bytes }));
    if (pluginInventoryFingerprint(value.generation as number, actual) !== manifest.fingerprint) return null;
    return { ...manifest, root: cache };
  } catch {
    return null;
  }
}

/**
 * Seal an inventory copied from a primary native home.  It never follows a
 * pre-existing cache link and does not import credentials or mutable state.
 */
export function bootstrapSharedPluginsManifest(
  stateRoot: string,
  primaryCodexHome: string,
  generation = 1,
  apply = false,
  expectedPrior?: Sha256,
  expectedCandidate?: Sha256,
  faultAt?: "during_copy",
): SharedPluginsManifestV1 | null {
  try {
    const source = join(resolve(primaryCodexHome), "plugins", "cache");
    const config = readAccountConfig(primaryCodexHome);
    const enabledIds = new Set(Object.entries(getTomlNode(config.tree, ["plugins"]) ?? {}).filter(([, value]) => isTomlTable(value) && isTomlScalar(value.enabled) && value.enabled.type === "boolean" && value.enabled.value).map(([id]) => id));
    const packages = existsSync(source) ? scanPluginCache(source, enabledIds) : [];
    const plugins: SharedPluginInventoryEntryV1[] = packages.map((entry) => ({
      id: entry.id,
      version: entry.version,
      fingerprint: entry.fingerprint,
      fileCount: entry.files.length,
      bytes: entry.bytes,
    }));
    const manifest: SharedPluginsManifestV1 = { version: VERSION, generation, plugins, fingerprint: pluginInventoryFingerprint(generation, plugins) };
    if (expectedCandidate && manifest.fingerprint !== expectedCandidate) {
      throw new Error("shared plugin candidate does not match recovery intent");
    }
    if (!apply) return manifest;
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafeOwnerDirectory(root, true);
    const previous = readPrivateJson(root, PLUGIN_MANIFEST_FILE);
    const previousManifest = previous === null ? null : parseSharedPluginsManifest(previous);
    if (previous !== null && !previousManifest) throw new Error("shared plugin publication preimage is invalid");
    if (expectedPrior ? !isRecord(previous) || previous.fingerprint !== expectedPrior : previous !== null) {
      throw new Error("shared plugin inventory changed before publication");
    }
    if (previousManifest && generation <= (previousManifest.generation ?? 0) && previousManifest.fingerprint !== manifest.fingerprint) {
      throw new Error("shared plugin publication cannot replace a published generation");
    }
    if (previousManifest?.fingerprint === manifest.fingerprint) {
      const loaded = parseSharedPluginsManifest(previous, root);
      if (!loaded) throw new Error("published shared plugin generation is invalid");
      return loaded;
    }

    const generationsRoot = join(root, PLUGIN_GENERATIONS_DIRECTORY);
    assertSafeOwnerDirectory(generationsRoot, true);
    const generationRoot = join(generationsRoot, String(generation));
    const fingerprintTag = manifest.fingerprint.slice("sha256:".length, "sha256:".length + 16);
    const stagingRoot = join(generationsRoot, `.staging-${generation}-${fingerprintTag}`);
    const interruptedRoot = join(generationsRoot, `.interrupted-${generation}-${fingerprintTag}`);
    if (!expectedCandidate && (existsSync(generationRoot) || existsSync(stagingRoot))) {
      throw new Error("shared plugin unpublished generation requires an exact recovery candidate");
    }

    const currentSourceFingerprint = (): Sha256 => {
      const latestConfig = readAccountConfig(primaryCodexHome);
      const latestEnabledIds = new Set(Object.entries(getTomlNode(latestConfig.tree, ["plugins"]) ?? {})
        .filter(([, value]) => isTomlTable(value) && isTomlScalar(value.enabled) && value.enabled.type === "boolean" && value.enabled.value)
        .map(([id]) => id));
      const latestPackages = existsSync(source) ? scanPluginCache(source, latestEnabledIds) : [];
      return pluginInventoryFingerprint(generation, latestPackages.map((entry) => ({
        id: entry.id, version: entry.version, fingerprint: entry.fingerprint, fileCount: entry.files.length, bytes: entry.bytes,
      })));
    };
    const assertPublicationInputsUnchanged = (): void => {
      if (currentSourceFingerprint() !== manifest.fingerprint) throw new Error("shared plugin source changed before publication");
      const latest = readPrivateJson(root, PLUGIN_MANIFEST_FILE);
      if (expectedPrior ? !isRecord(latest) || latest.fingerprint !== expectedPrior : latest !== null) {
        throw new Error("plugin publication preimage changed");
      }
    };

    const preserveIncomplete = (path: string): void => {
      assertPluginGenerationContainer(path);
      assertPublicationInputsUnchanged();
      if (existsSync(interruptedRoot)) throw new Error("shared plugin interrupted-generation archive already exists");
      renameSync(path, interruptedRoot);
      fsyncDirectory(generationsRoot);
    };

    if (existsSync(generationRoot)) {
      if (!verifiedPluginGeneration(generationRoot, manifest)) preserveIncomplete(generationRoot);
      else {
        assertPublicationInputsUnchanged();
        sealPluginGeneration(generationRoot, manifest);
      }
    }
    if (!existsSync(generationRoot) && existsSync(stagingRoot)) {
      if (verifiedPluginGeneration(stagingRoot, manifest)) {
        assertPublicationInputsUnchanged();
        sealPluginGeneration(stagingRoot, manifest);
        renameSync(stagingRoot, generationRoot);
        fsyncDirectory(generationsRoot);
      } else preserveIncomplete(stagingRoot);
    }
    if (!existsSync(generationRoot)) {
      mkdirSync(stagingRoot, { mode: PRIVATE_DIRECTORY_MODE });
      const cache = join(stagingRoot, "cache");
      assertSafeOwnerDirectory(cache, true);
      let copiedFiles = 0;
      for (const entry of packages) {
        const target = join(cache, entry.registry, entry.name, entry.version);
        copyPluginPackage(join(source, entry.registry, entry.name, entry.version), target, entry.files, true, () => {
          copiedFiles += 1;
          if (faultAt === "during_copy" && copiedFiles === 1) throw new Error("injected shared plugin fault during copy");
        });
        const after = scanPluginPackage(target);
        if (sha256Json({ id: entry.id, version: entry.version, files: after }) !== entry.fingerprint) throw new Error("sealed plugin copy verification failed");
      }
      if (pluginGenerationArtifactFingerprint(manifest, cache) !== manifest.fingerprint) throw new Error("sealed plugin generation verification failed");
      sealPluginGeneration(stagingRoot, manifest);

      assertPublicationInputsUnchanged();
      if (existsSync(generationRoot)) throw new Error("shared plugin generation appeared before publication");
      renameSync(stagingRoot, generationRoot);
      fsyncDirectory(generationsRoot);
    }

    if (!verifiedPluginGeneration(generationRoot, manifest)) throw new Error("shared plugin generation failed final verification");
    assertPublicationInputsUnchanged();
    atomicWritePrivateJson(root, PLUGIN_MANIFEST_FILE, {
      version: VERSION,
      generation,
      plugins,
      fingerprint: manifest.fingerprint,
    });
    return { ...manifest, root: join(generationRoot, "cache") };
  } catch {
    return null;
  }
}

/** Load and validate the native-capable sealed plugin inventory. Empty is valid. */
export function loadSharedPluginsManifestV1(stateRoot: string): SharedPluginsManifestV1 | null {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafeOwnerDirectory(root);
    return parseSharedPluginsManifest(readPrivateJson(root, PLUGIN_MANIFEST_FILE), root);
  } catch {
    return null;
  }
}

/** Publish primary native plugin changes only at the proven absent-child boundary. */
export function publishPrimaryPluginInventoryAfterExit(input: {
  stateRoot: string; account: AccountContinuityAccountV1; prior: SharedPluginsManifestV1;
  writeEvidence?: AccountConfigPrepareInputV1["writeEvidence"];
}): SharedPluginsManifestV1 | null {
  try {
    const generation = input.prior.generation ?? 1;
    const preview = bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation, false);
    if (!preview) return null;
    if (preview.fingerprint === input.prior.fingerprint) return input.prior;
    assertWriteEvidence(input.writeEvidence);
    const candidate = bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation + 1, false);
    if (!candidate) return null;
    return bootstrapSharedPluginsManifest(input.stateRoot, input.account.codexHome, generation + 1, true, input.prior.fingerprint, candidate.fingerprint);
  } catch { return null; }
}

const PLUGIN_PROJECTIONS_FILE = "plugin-projections.v1.json";
const PLUGIN_PROJECTION_INTENT_FILE = "plugin-projection-intent.v1.json";
type PluginProjectionEntry = { version: string; fingerprint: Sha256 };

function pluginNameFingerprint(path: string, id: string, entry: PluginProjectionEntry): Sha256 | null {
  try {
    assertSafeCapabilityDirectory(path);
    const names = readdirSync(path);
    if (names.length !== 1 || names[0] !== entry.version) return null;
    return sha256Json({ id, version: entry.version, files: scanPluginPackage(join(path, entry.version)) });
  } catch { return null; }
}

/** Add mutable account copies; existing or edited native packages stay local. */
function preparePluginPackages(input: AccountConfigPrepareInputV1, accountRoot: string): boolean {
  const raw = readPrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE);
  if (raw !== null && (!isRecord(raw) || raw.version !== 1 || raw.opaqueAccountId !== input.account.opaqueAccountId || !isRecord(raw.entries))) {
    throw new Error("invalid plugin projection receipt");
  }
  const entries: Record<string, PluginProjectionEntry> = raw === null ? {} : { ...(raw as { entries: Record<string, PluginProjectionEntry> }).entries };
  for (const [id, entry] of Object.entries(entries)) {
    if (!isSafePluginId(id) || !isRecord(entry) || !isSafePluginSegment(entry.version) || !isSha256(entry.fingerprint)) throw new Error("invalid plugin projection entry");
  }
  const root = join(resolve(input.account.codexHome), "plugins", "cache");
  const save = () => atomicWritePrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE, { version: 1, opaqueAccountId: input.account.opaqueAccountId, entries });
  const pending = readPrivateJson(accountRoot, PLUGIN_PROJECTION_INTENT_FILE);
  if (pending !== null) {
    if (!input.apply) return false;
    assertWriteEvidence(input.writeEvidence);
    if (!isRecord(pending) || !isSafePluginId(String(pending.id)) || typeof pending.transaction !== "string" || !/^\.tweakers-plugins-[a-f0-9]{16}$/.test(pending.transaction)
      || !isRecord(pending.after) || !isSafePluginSegment(String(pending.after.version)) || !isSha256(pending.after.fingerprint)
      || (pending.before !== null && (!isRecord(pending.before) || !isSafePluginSegment(String(pending.before.version)) || !isSha256(pending.before.fingerprint)))) {
      throw new Error("invalid pending plugin projection");
    }
    const id = String(pending.id); const [name, registry] = id.split("@");
    const target = join(root, registry!, name!);
    const transaction = join(resolve(input.account.codexHome), pending.transaction);
    assertSafeCapabilityDirectory(transaction);
    const before = pending.before as PluginProjectionEntry | null;
    const after = pending.after as unknown as PluginProjectionEntry;
    const backup = join(transaction, "backup");
    if (pluginNameFingerprint(target, id, after) === after.fingerprint) {
      entries[id] = after; save();
    } else if (!lstatIfPresent(target) && before && pluginNameFingerprint(backup, id, before) === before.fingerprint) {
      renameSync(backup, target);
    } else if ((before && pluginNameFingerprint(target, id, before) === before.fingerprint) || (!before && !lstatIfPresent(target))) {
      // No publication happened; discard only the private staged copy.
    } else throw new Error("plugin projection recovery requires inspection");
    rmSync(transaction, { recursive: true, force: true });
    unlinkSync(join(accountRoot, PLUGIN_PROJECTION_INTENT_FILE));
  }
  let ready = true;
  for (const plugin of input.plugins.plugins) {
    if (!plugin.version || !plugin.fingerprint || !input.plugins.root) throw new Error("plugin inventory lacks immutable payload");
    const [name, registry] = plugin.id.split("@");
    if (!isSafePluginId(plugin.id) || !isSafePluginSegment(plugin.version)) throw new Error("invalid plugin inventory path");
    const target = join(root, registry!, name!);
    // Do not traverse any account-provided registry/cache link.
    for (const parent of [join(input.account.codexHome, "plugins"), root, join(root, registry!)]) {
      if (lstatIfPresent(parent)) assertSafeCapabilityDirectory(parent);
    }
    const prior = entries[plugin.id];
    const present = lstatIfPresent(target);
    if (present && (!prior || pluginNameFingerprint(target, plugin.id, prior) !== prior.fingerprint)) continue;
    if (present && prior?.version === plugin.version && prior.fingerprint === plugin.fingerprint) continue;
    ready = false;
    if (!input.apply) continue;
    assertWriteEvidence(input.writeEvidence);
    assertSafeOwnerDirectory(join(root, registry!), true);
    const after = { version: plugin.version, fingerprint: plugin.fingerprint };
    const source = join(input.plugins.root, registry!, name!, plugin.version);
    const files = scanPluginPackage(source);
    if (sha256Json({ id: plugin.id, version: plugin.version, files }) !== plugin.fingerprint) throw new Error("shared plugin package changed");
    const transactionName = `.tweakers-plugins-${randomBytes(8).toString("hex")}`;
    const transaction = join(resolve(input.account.codexHome), transactionName);
    mkdirSync(transaction, { mode: PRIVATE_DIRECTORY_MODE });
    const candidate = join(transaction, "candidate");
    copyPluginPackage(source, join(candidate, plugin.version), files, false);
    if (pluginNameFingerprint(candidate, plugin.id, after) !== plugin.fingerprint) throw new Error("account plugin copy failed verification");
    atomicWritePrivateJson(accountRoot, PLUGIN_PROJECTION_INTENT_FILE, { id: plugin.id, transaction: transactionName, before: present ? prior : null, after });
    assertWriteEvidence(input.writeEvidence);
    if (present ? pluginNameFingerprint(target, plugin.id, prior!) !== prior!.fingerprint : lstatIfPresent(target) !== null) throw new Error("account plugin changed before publication");
    if (present) renameSync(target, join(transaction, "backup"));
    renameSync(candidate, target);
    fsyncDirectory(dirname(target));
    entries[plugin.id] = after; save();
    rmSync(transaction, { recursive: true, force: true });
    unlinkSync(join(accountRoot, PLUGIN_PROJECTION_INTENT_FILE));
  }
  return input.apply ? true : ready;
}

function parseSharedSourceProvenanceReceipt(value: unknown, source: "bootstrap" | "rebase"): AccountContinuitySharedSourceProvenanceV1 | null {
  if (!isRecord(value) || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !isSha256(value.sharedBaseFingerprint) || !isSha256(value.sharedPluginFingerprint)) return null;
  if (source === "bootstrap") {
    const legacy = value.version === 1;
    const allowed = legacy
      ? ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"]
      : ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedSourceOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"];
    if ((!legacy && value.version !== 2) || Object.keys(value).some((key) => !allowed.includes(key))
      || !isSha256(value.schemaFingerprint) || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
      || typeof value.createdAt !== "string" || !Array.isArray(value.accounts)
      || (!legacy && !isOpaqueAccountId(value.sharedSourceOpaqueAccountId))) return null;
    const accountIds = value.accounts.map((entry) => {
      if (!isRecord(entry) || Object.keys(entry).length !== 3 || !isOpaqueAccountId(entry.opaqueAccountId)
        || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint)) return null;
      return entry.opaqueAccountId;
    });
    const donor = legacy ? value.primaryOpaqueAccountId : value.sharedSourceOpaqueAccountId as OpaqueAccountId;
    if (accountIds.includes(null) || new Set(accountIds).size !== accountIds.length
      || !accountIds.includes(value.primaryOpaqueAccountId) || !accountIds.includes(donor)) return null;
    return {
      state: "ready",
      primaryOpaqueAccountId: value.primaryOpaqueAccountId,
      sharedSourceOpaqueAccountId: donor,
      legacy,
      sharedBaseFingerprint: value.sharedBaseFingerprint,
      sharedPluginFingerprint: value.sharedPluginFingerprint,
    };
  }
  const allowed = [
    "version", "primaryOpaqueAccountId", "previousSharedSourceOpaqueAccountId", "sharedSourceOpaqueAccountId",
    "priorSharedBaseFingerprint", "priorSharedPluginFingerprint", "sharedBaseFingerprint", "sharedPluginFingerprint",
    "sharedGeneration", "pluginGeneration", "accounts", "createdAt",
  ];
  if (value.version !== VERSION || Object.keys(value).some((key) => !allowed.includes(key))
    || !isOpaqueAccountId(value.previousSharedSourceOpaqueAccountId) || !isOpaqueAccountId(value.sharedSourceOpaqueAccountId)
    || !isSha256(value.priorSharedBaseFingerprint) || !isSha256(value.priorSharedPluginFingerprint)
    || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1
    || !Number.isSafeInteger(value.pluginGeneration) || Number(value.pluginGeneration) < 1
    || !Array.isArray(value.accounts) || typeof value.createdAt !== "string"
    || value.accounts.some((entry) => !isRecord(entry) || Object.keys(entry).length !== 3 || !isOpaqueAccountId(entry.opaqueAccountId)
      || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint))
    || new Set(value.accounts.map((entry) => (entry as Record<string, unknown>).opaqueAccountId)).size !== value.accounts.length) return null;
  return {
    state: "ready",
    primaryOpaqueAccountId: value.primaryOpaqueAccountId,
    sharedSourceOpaqueAccountId: value.sharedSourceOpaqueAccountId,
    legacy: false,
    sharedBaseFingerprint: value.sharedBaseFingerprint,
    sharedPluginFingerprint: value.sharedPluginFingerprint,
  };
}

/** Read the donor bound to the current shared manifests. Legacy bootstrap receipts bind primary as their historical donor. */
export function loadAccountContinuitySharedSourceProvenanceV1(stateRoot: string): AccountContinuitySharedSourceProvenanceV1 {
  try {
    const root = sharedAccountConfigRoot(stateRoot);
    assertSafePrivateDirectoryReadOnly(root);
    const shared = loadSharedAccountBase(stateRoot);
    const plugins = loadSharedPluginsManifestV1(stateRoot);
    if (!shared || !plugins) return { state: "blocked", reason: "shared account continuity is not initialized" };
    const rebaseValue = readPrivateJson(root, SHARED_SOURCE_REBASE_RECEIPT_FILE);
    const source = rebaseValue === null ? "bootstrap" as const : "rebase" as const;
    const value = rebaseValue ?? readPrivateJson(root, BOOTSTRAP_RECEIPT_FILE);
    const parsed = parseSharedSourceProvenanceReceipt(value, source);
    if (!parsed) return { state: "blocked", reason: "shared-source provenance is missing or invalid" };
    // Base and plugin generations advance independently during ordinary donor
    // publication. The receipt binds donor identity; current manifests remain
    // authoritative for content and are returned without rewriting history.
    return { ...parsed, sharedBaseFingerprint: shared.fingerprint, sharedPluginFingerprint: plugins.fingerprint };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "shared-source provenance could not be loaded" };
  }
}

function sharedSourceRebaseIsPending(stateRoot: string): boolean {
  const root = sharedAccountConfigRoot(stateRoot);
  assertSafePrivateDirectoryReadOnly(root);
  return readPrivateJson(root, SHARED_SOURCE_REBASE_INTENT_FILE) !== null;
}

/**
 * Bootstrap is conservative: every pre-existing shareable value/file becomes
 * an account-local set override, including primary.  It never chooses between
 * two divergent local values; only missing paths later inherit the base.
 */
export function bootstrapAccountContinuity(input: AccountContinuityBootstrapInputV1): AccountContinuityBootstrapResultV1 {
  try {
    validateSchema(input.schema);
    const sharedSourceOpaqueAccountId = input.sharedSourceOpaqueAccountId ?? input.primaryOpaqueAccountId;
    if (!isOpaqueAccountId(input.primaryOpaqueAccountId) || !isOpaqueAccountId(sharedSourceOpaqueAccountId)
      || input.accounts.length === 0 || input.accounts.length > 64) {
      return { state: "blocked", reason: "invalid account continuity bootstrap accounts" };
    }
    const accounts = [...input.accounts];
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length
      || !accounts.some((account) => account.opaqueAccountId === input.primaryOpaqueAccountId)
      || !accounts.some((account) => account.opaqueAccountId === sharedSourceOpaqueAccountId)) {
      return { state: "blocked", reason: "invalid account continuity bootstrap binding" };
    }
    const sharedSource = accounts.find((account) => account.opaqueAccountId === sharedSourceOpaqueAccountId)!;
    const documents = new Map<string, LosslessTomlDocument>();
    const capabilities = new Map<string, CapabilityTreeSnapshotV1>();
    for (const account of accounts) {
      if (!isOpaqueAccountId(account.opaqueAccountId) || !isAbsolute(account.codexHome)) return { state: "blocked", reason: "invalid account home" };
      documents.set(account.opaqueAccountId, readAccountConfig(account.codexHome));
      capabilities.set(account.opaqueAccountId, scanCapabilityTree(account.codexHome));
    }
    const generation = input.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) return { state: "blocked", reason: "invalid shared account generation" };
    const shared = withGeneration(projectPrimarySharedBase(documents.get(sharedSource.opaqueAccountId)!, scanPrimarySharedCapabilities(sharedSource.codexHome), input.schema), generation);
    const configOverrides: Record<string, AccountConfigOverridesV1> = {};
    const capabilityOverrides: Record<string, AccountCapabilityOverridesV1> = {};
    for (const account of accounts) {
      const document = documents.get(account.opaqueAccountId)!;
      const snapshot = capabilities.get(account.opaqueAccountId)!;
      configOverrides[account.opaqueAccountId] = buildConfigOverrides(account.opaqueAccountId, generation, document.tree, input.schema);
      capabilityOverrides[account.opaqueAccountId] = buildCapabilityOverrides(account.opaqueAccountId, generation, snapshot);
    }
    const pluginPreview = bootstrapSharedPluginsManifest(input.stateRoot, sharedSource.codexHome, generation, false);
    if (!pluginPreview) return { state: "blocked", reason: "shared-source plugin inventory is unsafe or unsupported" };
    if (!input.apply) return { state: "ready", shared, plugins: pluginPreview, configOverrides, capabilityOverrides };
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    if (loadSharedAccountBase(input.stateRoot) || loadSharedPluginsManifestV1(input.stateRoot)) {
      return { state: "blocked", reason: "account continuity bootstrap metadata already exists" };
    }
    for (const account of accounts) {
      const root = accountStateRoot(input.stateRoot, account);
      if (existsSync(join(root, CONFIG_OVERRIDES_FILE)) || existsSync(join(root, CAPABILITY_OVERRIDES_FILE))) {
        return { state: "blocked", reason: "account continuity bootstrap sidecar already exists" };
      }
    }
    // Payloads precede their manifests. A partial bootstrap has no completed
    // base/receipt and therefore is never interpreted as an active generation.
    for (const account of accounts) {
      const root = accountStateRoot(input.stateRoot, account);
      assertSafeOwnerDirectory(root, true);
      writeCapabilityPayloads(root, capabilities.get(account.opaqueAccountId)!);
      persistConfigOverrides(root, configOverrides[account.opaqueAccountId]!);
      persistCapabilityOverrides(root, capabilityOverrides[account.opaqueAccountId]!);
    }
    writeSharedAccountBase(input.stateRoot, shared);
    const plugins = bootstrapSharedPluginsManifest(input.stateRoot, sharedSource.codexHome, generation, true, undefined, pluginPreview.fingerprint);
    if (!plugins) throw new Error("unable to publish shared-source plugin inventory");
    // The only bootstrap receipt contains no raw configuration/capability data.
    atomicWritePrivateJson(sharedRoot, BOOTSTRAP_RECEIPT_FILE, {
      version: 2,
      schemaFingerprint: input.schema.schemaFingerprint,
      generation,
      primaryOpaqueAccountId: input.primaryOpaqueAccountId,
      sharedSourceOpaqueAccountId,
      sharedBaseFingerprint: shared.fingerprint,
      sharedPluginFingerprint: plugins.fingerprint,
      accounts: accounts.map((account) => ({
        opaqueAccountId: account.opaqueAccountId,
        configOverridesFingerprint: configOverrides[account.opaqueAccountId]!.fingerprint,
        capabilityOverridesFingerprint: capabilityOverrides[account.opaqueAccountId]!.fingerprint,
      })).sort((left, right) => left.opaqueAccountId.localeCompare(right.opaqueAccountId)),
      createdAt: input.now?.() ?? new Date().toISOString(),
    });
    return { state: "ready", shared, plugins, configOverrides, capabilityOverrides };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account continuity bootstrap failed" };
  }
}

function rebasedConfigOverrides(overrides: AccountConfigOverridesV1, generation: number): AccountConfigOverridesV1 {
  if (overrides.basedOnSharedGeneration === generation) return overrides;
  const draft: Omit<AccountConfigOverridesV1, "fingerprint"> = {
    ...overrides,
    revision: overrides.revision + 1,
    basedOnSharedGeneration: generation,
    operations: normalizeConfigOperations(overrides.operations),
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}

function rebasedCapabilityOverrides(overrides: AccountCapabilityOverridesV1, generation: number): AccountCapabilityOverridesV1 {
  if (overrides.basedOnSharedGeneration === generation) return overrides;
  const draft: Omit<AccountCapabilityOverridesV1, "fingerprint" | "payloadRoot"> = {
    version: VERSION,
    opaqueAccountId: overrides.opaqueAccountId,
    revision: overrides.revision + 1,
    basedOnSharedGeneration: generation,
    operations: normalizeCapabilityOperations(overrides.operations),
    preservationFingerprint: overrides.preservationFingerprint,
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft), ...(overrides.payloadRoot ? { payloadRoot: overrides.payloadRoot } : {}) };
}

function serializableCapabilityOverrides(overrides: AccountCapabilityOverridesV1): Omit<AccountCapabilityOverridesV1, "payloadRoot"> {
  const { payloadRoot: _payloadRoot, ...serializable } = overrides;
  return serializable;
}

interface SharedSourceRebaseSidecarsV1 {
  readonly opaqueAccountId: OpaqueAccountId;
  readonly capturedConfigArtifactFingerprint: Sha256;
  readonly capturedCapabilityArtifactFingerprint: Sha256;
  readonly beforeConfig: AccountConfigOverridesV1;
  readonly beforeCapabilities: Omit<AccountCapabilityOverridesV1, "payloadRoot">;
  readonly afterConfig: AccountConfigOverridesV1;
  readonly afterCapabilities: Omit<AccountCapabilityOverridesV1, "payloadRoot">;
}

interface SharedSourceRebaseIntentV1 {
  readonly version: 1;
  readonly primaryOpaqueAccountId: OpaqueAccountId;
  readonly previousSharedSourceOpaqueAccountId: OpaqueAccountId;
  readonly sharedSourceOpaqueAccountId: OpaqueAccountId;
  readonly priorSharedBaseFingerprint: Sha256;
  readonly priorSharedPluginFingerprint: Sha256;
  readonly sharedBaseFingerprint: Sha256;
  readonly sharedPluginFingerprint: Sha256;
  readonly sharedGeneration: number;
  readonly pluginGeneration: number;
  readonly accounts: readonly SharedSourceRebaseSidecarsV1[];
  readonly fingerprint: Sha256;
}

function parseSharedSourceRebaseIntent(value: unknown): SharedSourceRebaseIntentV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version", "primaryOpaqueAccountId", "previousSharedSourceOpaqueAccountId", "sharedSourceOpaqueAccountId",
    "priorSharedBaseFingerprint", "priorSharedPluginFingerprint", "sharedBaseFingerprint", "sharedPluginFingerprint",
    "sharedGeneration", "pluginGeneration", "accounts", "fingerprint",
  ].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.primaryOpaqueAccountId)
    || !isOpaqueAccountId(value.previousSharedSourceOpaqueAccountId) || !isOpaqueAccountId(value.sharedSourceOpaqueAccountId)
    || ![value.priorSharedBaseFingerprint, value.priorSharedPluginFingerprint, value.sharedBaseFingerprint, value.sharedPluginFingerprint, value.fingerprint].every(isSha256)
    || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1
    || !Number.isSafeInteger(value.pluginGeneration) || Number(value.pluginGeneration) < 1 || !Array.isArray(value.accounts)) return null;
  const accounts: SharedSourceRebaseSidecarsV1[] = [];
  for (const entry of value.accounts) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => ![
      "opaqueAccountId", "capturedConfigArtifactFingerprint", "capturedCapabilityArtifactFingerprint",
      "beforeConfig", "beforeCapabilities", "afterConfig", "afterCapabilities",
    ].includes(key)) || !isOpaqueAccountId(entry.opaqueAccountId)
      || !isSha256(entry.capturedConfigArtifactFingerprint) || !isSha256(entry.capturedCapabilityArtifactFingerprint)) return null;
    const beforeConfig = parseConfigOverrides(entry.beforeConfig);
    const beforeCapabilities = parseCapabilityOverrides(entry.beforeCapabilities);
    const afterConfig = parseConfigOverrides(entry.afterConfig);
    const afterCapabilities = parseCapabilityOverrides(entry.afterCapabilities);
    if (!beforeConfig || !beforeCapabilities || !afterConfig || !afterCapabilities
      || [beforeConfig, beforeCapabilities, afterConfig, afterCapabilities].some((sidecar) => sidecar.opaqueAccountId !== entry.opaqueAccountId)) return null;
    accounts.push({
      opaqueAccountId: entry.opaqueAccountId,
      capturedConfigArtifactFingerprint: entry.capturedConfigArtifactFingerprint,
      capturedCapabilityArtifactFingerprint: entry.capturedCapabilityArtifactFingerprint,
      beforeConfig,
      beforeCapabilities: serializableCapabilityOverrides(beforeCapabilities),
      afterConfig,
      afterCapabilities: serializableCapabilityOverrides(afterCapabilities),
    });
  }
  if (new Set(accounts.map((entry) => entry.opaqueAccountId)).size !== accounts.length) return null;
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) return null;
  return { ...(draft as Omit<SharedSourceRebaseIntentV1, "fingerprint" | "accounts">), accounts, fingerprint: value.fingerprint as Sha256 };
}

function sharedSourceCandidate(
  input: RebaseAccountContinuitySharedSourceInputV1,
  source: AccountContinuityAccountV1,
  generations: { readonly shared: number; readonly plugins: number } = {
    shared: input.priorShared.config.generation + 1,
    plugins: (input.priorPlugins.generation ?? input.priorShared.config.generation) + 1,
  },
): {
  shared: SharedAccountBaseV1; plugins: SharedPluginsManifestV1; fingerprint: Sha256;
} {
  const sharedGeneration = generations.shared;
  const pluginGeneration = generations.plugins;
  if (!Number.isSafeInteger(sharedGeneration) || !Number.isSafeInteger(pluginGeneration)) throw new Error("shared-source generation overflow");
  const shared = withGeneration(projectPrimarySharedBase(readAccountConfig(source.codexHome), scanPrimarySharedCapabilities(source.codexHome), input.schema), sharedGeneration);
  const plugins = bootstrapSharedPluginsManifest(input.stateRoot, source.codexHome, pluginGeneration, false);
  if (!plugins) throw new Error("shared-source plugin inventory is unsafe or unsupported");
  return { shared, plugins, fingerprint: sha256Json({ shared: shared.fingerprint, plugins: plugins.fingerprint }) };
}

/**
 * Retire one stale donor snapshot only while BOTH global manifests are still
 * prior. Restore journaled capture sidecars, never account files or published
 * generations. The unchanged intent makes an interrupted restoration resumable;
 * its final rename retains all before/after evidence for review.
 */
export function abortUnpublishedSharedSourceRebase(
  input: AbortUnpublishedSharedSourceRebaseInputV1,
): AbortUnpublishedSharedSourceRebaseResultV1 {
  try {
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    assertSafeOwnerDirectory(sharedRoot);
    if (!isSha256(input.expectedIntentFingerprint) || input.accounts.length === 0 || input.accounts.length > 64
      || new Set(input.accounts.map((account) => account.opaqueAccountId)).size !== input.accounts.length
      || input.accounts.some((account) => !isOpaqueAccountId(account.opaqueAccountId) || !isAbsolute(account.codexHome))) {
      throw new Error("invalid unpublished rebase recovery input");
    }
    const raw = readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE);
    if (raw === null) return { state: "absent" };
    const intent = parseSharedSourceRebaseIntent(raw);
    if (!intent || intent.fingerprint !== input.expectedIntentFingerprint) throw new Error("shared-source rebase intent changed");
    const archiveFile = `shared-source-rebase-aborted-${intent.fingerprint.slice("sha256:".length)}.v1.json`;
    const archivePath = join(sharedRoot, archiveFile);
    if (lstatIfPresent(archivePath)) throw new Error("shared-source rebase recovery archive already exists");

    const assertUnchanged = (requireLease: boolean): void => {
      const currentIntent = parseSharedSourceRebaseIntent(readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE));
      const shared = loadSharedAccountBase(input.stateRoot);
      const plugins = loadSharedPluginsManifestV1(input.stateRoot);
      if (!currentIntent || currentIntent.fingerprint !== intent.fingerprint
        || shared?.fingerprint !== intent.priorSharedBaseFingerprint
        || plugins?.fingerprint !== intent.priorSharedPluginFingerprint) {
        throw new Error("shared-source rebase was published or changed; rollback is unavailable");
      }
      for (const entry of intent.accounts) {
        const account = input.accounts.find((candidate) => candidate.opaqueAccountId === entry.opaqueAccountId);
        if (!account) throw new Error("shared-source recovery account is missing");
        if (requireLease) assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
        const config = loadAccountConfigOverrides(input.stateRoot, account);
        const capabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
        if (!config || !capabilities
          || ![entry.beforeConfig.fingerprint, entry.afterConfig.fingerprint].includes(config.fingerprint)
          || ![entry.beforeCapabilities.fingerprint, entry.afterCapabilities.fingerprint].includes(capabilities.fingerprint)) {
          throw new Error("shared-source recovery sidecars changed");
        }
        if (readAccountConfig(account.codexHome).fingerprint !== entry.capturedConfigArtifactFingerprint
          || effectiveCapabilityFingerprint(scanCapabilityTree(account.codexHome).files) !== entry.capturedCapabilityArtifactFingerprint) {
          throw new Error("shared-source recovery account artifacts changed");
        }
      }
    };
    assertUnchanged(Boolean(input.apply));
    if (!input.apply) return { state: "would_abort", archiveFile };
    for (const entry of intent.accounts) {
      const account = input.accounts.find((candidate) => candidate.opaqueAccountId === entry.opaqueAccountId)!;
      const root = accountStateRoot(input.stateRoot, account);
      assertUnchanged(true);
      if (loadAccountConfigOverrides(input.stateRoot, account)!.fingerprint !== entry.beforeConfig.fingerprint) {
        persistConfigOverrides(root, entry.beforeConfig);
      }
      assertUnchanged(true);
      if (loadAccountCapabilityOverrides(input.stateRoot, account)!.fingerprint !== entry.beforeCapabilities.fingerprint) {
        persistCapabilityOverrides(root, entry.beforeCapabilities);
      }
    }
    if (input.faultAt === "after_sidecars") throw new Error("injected unpublished rebase recovery fault after sidecars");
    assertUnchanged(true);
    if (lstatIfPresent(archivePath)) throw new Error("shared-source rebase recovery archive changed");
    renameSync(join(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE), archivePath);
    fsyncDirectory(sharedRoot);
    return { state: "aborted", archiveFile };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "unpublished rebase recovery failed" };
  }
}

/**
 * Preview or apply a bounded donor change for an existing continuity state.
 * The donor is observed only; non-donor materialized homes are captured at an
 * absent-child boundary before their sidecars are rebased to the new generation.
 */
export function rebaseAccountContinuitySharedSource(input: RebaseAccountContinuitySharedSourceInputV1): RebaseAccountContinuitySharedSourceResultV1 {
  try {
    validateSchema(input.schema);
    if (!isOpaqueAccountId(input.primaryOpaqueAccountId) || !isOpaqueAccountId(input.sharedSourceOpaqueAccountId)
      || input.accounts.length === 0 || input.accounts.length > 64) throw new Error("invalid shared-source rebase accounts");
    const accounts = [...input.accounts];
    if (new Set(accounts.map((account) => account.opaqueAccountId)).size !== accounts.length
      || !accounts.some((account) => account.opaqueAccountId === input.primaryOpaqueAccountId)) throw new Error("routing primary is not an exact rebase member");
    const source = accounts.find((account) => account.opaqueAccountId === input.sharedSourceOpaqueAccountId);
    if (!source) throw new Error("shared source is not an exact rebase member");
    for (const account of accounts) if (!isOpaqueAccountId(account.opaqueAccountId) || !isAbsolute(account.codexHome)) throw new Error("invalid shared-source rebase account home");
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    assertSafeOwnerDirectory(sharedRoot);
    const existingIntentValue = readPrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE);
    const existingIntent = existingIntentValue === null ? null : parseSharedSourceRebaseIntent(existingIntentValue);
    if (existingIntentValue !== null && !existingIntent) throw new Error("invalid shared-source rebase recovery intent");
    const currentShared = loadSharedAccountBase(input.stateRoot);
    const currentPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!currentShared || !currentPlugins) throw new Error("shared account continuity is not initialized");

    if (!existingIntent) {
      if (currentShared.fingerprint !== input.priorShared.fingerprint || currentPlugins.fingerprint !== input.priorPlugins.fingerprint) {
        throw new Error("shared account state changed before donor rebase");
      }
      const provenance = loadAccountContinuitySharedSourceProvenanceV1(input.stateRoot);
      if (provenance.state !== "ready") throw new Error(provenance.reason ?? "shared-source provenance is unavailable");
      if (provenance.sharedSourceOpaqueAccountId === input.sharedSourceOpaqueAccountId) {
        return {
          state: "ready", sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
          sharedGeneration: currentShared.config.generation, pluginGeneration: currentPlugins.generation,
          shared: currentShared, plugins: currentPlugins,
        };
      }
    }

    const journalGenerations = existingIntent
      ? { shared: existingIntent.sharedGeneration, plugins: existingIntent.pluginGeneration }
      : undefined;
    const firstCandidate = sharedSourceCandidate(input, source, journalGenerations);
    const finalCandidate = sharedSourceCandidate(input, source, journalGenerations);
    if (firstCandidate.fingerprint !== finalCandidate.fingerprint) {
      const changed = [
        ...(firstCandidate.shared.config.fingerprint !== finalCandidate.shared.config.fingerprint ? ["config"] : []),
        ...(firstCandidate.shared.capabilities.fingerprint !== finalCandidate.shared.capabilities.fingerprint ? ["capabilities"] : []),
        ...(firstCandidate.plugins.fingerprint !== finalCandidate.plugins.fingerprint ? ["plugins"] : []),
      ];
      throw new Error(`shared source changed during read-only snapshot (${changed.join(", ") || "unknown"})`);
    }
    const candidate = finalCandidate;
    const candidatePluginGeneration = candidate.plugins.generation;
    if (candidatePluginGeneration === undefined) throw new Error("shared-source plugin candidate lacks a generation");
    let previousSource: OpaqueAccountId;
    let receiptPrimary: OpaqueAccountId;
    let planned: SharedSourceRebaseSidecarsV1[];

    if (existingIntent) {
      if (existingIntent.sharedSourceOpaqueAccountId !== input.sharedSourceOpaqueAccountId
        || existingIntent.sharedBaseFingerprint !== candidate.shared.fingerprint
        || existingIntent.sharedPluginFingerprint !== candidate.plugins.fingerprint
        || ![existingIntent.priorSharedBaseFingerprint, existingIntent.sharedBaseFingerprint].includes(currentShared.fingerprint)
        || ![existingIntent.priorSharedPluginFingerprint, existingIntent.sharedPluginFingerprint].includes(currentPlugins.fingerprint)) {
        throw new Error("shared-source rebase recovery inputs changed");
      }
      previousSource = existingIntent.previousSharedSourceOpaqueAccountId;
      receiptPrimary = existingIntent.primaryOpaqueAccountId;
      planned = [...existingIntent.accounts];
    } else {
      const provenance = loadAccountContinuitySharedSourceProvenanceV1(input.stateRoot);
      if (provenance.state !== "ready" || !provenance.sharedSourceOpaqueAccountId) throw new Error(provenance.reason ?? "shared-source provenance is unavailable");
      previousSource = provenance.sharedSourceOpaqueAccountId;
      receiptPrimary = input.primaryOpaqueAccountId;
      planned = [];
      for (const account of accounts) {
        if (account.opaqueAccountId === input.sharedSourceOpaqueAccountId) continue;
        let config = loadAccountConfigOverrides(input.stateRoot, account);
        let capabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
        if (!config || !capabilities) throw new Error(`account ${account.opaqueAccountId} lacks rebase sidecars`);
        const stored = parseStoredMaterialization(readPrivateJson(accountStateRoot(input.stateRoot, account), MATERIALIZATION_FILE));
        if (!stored) throw new Error(`account ${account.opaqueAccountId} lacks a materialization receipt for donor rebase`);
        const captured = captureIdleAccountChangesBeforeSpawn({
          stateRoot: input.stateRoot, account, shared: input.priorShared, plugins: input.priorPlugins, schema: input.schema,
          configOverrides: config, capabilityOverrides: capabilities,
          writeEvidence: input.accountWriteEvidence?.[account.opaqueAccountId] ?? { accountChildAbsent: false }, apply: false,
        });
        if (captured.state === "blocked") throw new Error(captured.reason ?? `account ${account.opaqueAccountId} capture was blocked`);
        config = captured.configOverrides ?? config;
        capabilities = captured.capabilityOverrides ?? capabilities;
        const afterConfig = rebasedConfigOverrides(config, candidate.shared.config.generation);
        const afterCapabilities = rebasedCapabilityOverrides(capabilities, candidate.shared.capabilities.generation);
        const capturedConfig = readAccountConfig(account.codexHome);
        const capturedCapabilities = scanCapabilityTree(account.codexHome);
        planned.push({
          opaqueAccountId: account.opaqueAccountId,
          capturedConfigArtifactFingerprint: capturedConfig.fingerprint,
          capturedCapabilityArtifactFingerprint: effectiveCapabilityFingerprint(capturedCapabilities.files),
          beforeConfig: config,
          beforeCapabilities: serializableCapabilityOverrides(capabilities), afterConfig,
          afterCapabilities: serializableCapabilityOverrides(afterCapabilities),
        });
      }
    }

    const configOverrides: Record<string, AccountConfigOverridesV1> = {};
    const capabilityOverrides: Record<string, AccountCapabilityOverridesV1> = {};
    for (const account of accounts) {
      const entry = planned.find((candidateEntry) => candidateEntry.opaqueAccountId === account.opaqueAccountId);
      const config = entry?.afterConfig ?? loadAccountConfigOverrides(input.stateRoot, account);
      const capabilities = entry?.afterCapabilities ?? loadAccountCapabilityOverrides(input.stateRoot, account);
      if (!config || !capabilities) throw new Error(`account ${account.opaqueAccountId} lacks rebase sidecars`);
      configOverrides[account.opaqueAccountId] = config;
      capabilityOverrides[account.opaqueAccountId] = capabilities;
    }
    const result: RebaseAccountContinuitySharedSourceResultV1 = {
      state: "ready", sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
      sharedGeneration: candidate.shared.config.generation, pluginGeneration: candidatePluginGeneration,
      shared: candidate.shared, plugins: candidate.plugins, configOverrides, capabilityOverrides,
    };
    if (!input.apply) return result;

    for (const entry of planned) assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
    const assertCapturedArtifactsUnchanged = (): void => {
      for (const entry of planned) {
        const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId)!;
        const currentConfig = readAccountConfig(account.codexHome);
        const currentCapabilities = scanCapabilityTree(account.codexHome);
        if (currentConfig.fingerprint !== entry.capturedConfigArtifactFingerprint
          || effectiveCapabilityFingerprint(currentCapabilities.files) !== entry.capturedCapabilityArtifactFingerprint) {
          throw new Error(`account ${entry.opaqueAccountId} artifacts changed after donor capture`);
        }
      }
    };
    if (!existingIntent) {
      // Capture publication precedes the rebase journal and retains its own
      // exact materialization/capture receipts. A retry simply previews again.
      for (const entry of planned) {
        const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId)!;
        const currentConfig = loadAccountConfigOverrides(input.stateRoot, account)!;
        const currentCapabilities = loadAccountCapabilityOverrides(input.stateRoot, account)!;
        if (currentConfig.fingerprint !== entry.beforeConfig.fingerprint || currentCapabilities.fingerprint !== entry.beforeCapabilities.fingerprint) {
          const captured = captureIdleAccountChangesBeforeSpawn({
            stateRoot: input.stateRoot, account, shared: input.priorShared, plugins: input.priorPlugins, schema: input.schema,
            configOverrides: currentConfig, capabilityOverrides: currentCapabilities,
            writeEvidence: input.accountWriteEvidence![entry.opaqueAccountId]!, apply: true,
          });
          if (captured.state === "blocked" || captured.configOverrides?.fingerprint !== entry.beforeConfig.fingerprint
            || captured.capabilityOverrides?.fingerprint !== entry.beforeCapabilities.fingerprint) {
            throw new Error(captured.reason ?? `account ${entry.opaqueAccountId} changed during donor capture`);
          }
        }
      }
      assertCapturedArtifactsUnchanged();
      const intentDraft: Omit<SharedSourceRebaseIntentV1, "fingerprint"> = {
        version: VERSION, primaryOpaqueAccountId: receiptPrimary, previousSharedSourceOpaqueAccountId: previousSource,
        sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
        priorSharedBaseFingerprint: input.priorShared.fingerprint, priorSharedPluginFingerprint: input.priorPlugins.fingerprint,
        sharedBaseFingerprint: candidate.shared.fingerprint, sharedPluginFingerprint: candidate.plugins.fingerprint,
        sharedGeneration: candidate.shared.config.generation, pluginGeneration: candidatePluginGeneration,
        accounts: planned,
      };
      atomicWritePrivateJson(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE, { ...intentDraft, fingerprint: sha256Json(intentDraft) });
      if (input.faultAt === "after_intent") throw new Error("injected shared-source rebase fault after intent");
    }
    assertCapturedArtifactsUnchanged();
    for (const entry of planned) {
      const account = accounts.find((candidateAccount) => candidateAccount.opaqueAccountId === entry.opaqueAccountId)!;
      const root = accountStateRoot(input.stateRoot, account);
      const currentConfig = loadAccountConfigOverrides(input.stateRoot, account);
      const currentCapabilities = loadAccountCapabilityOverrides(input.stateRoot, account);
      if (!currentConfig || !currentCapabilities) throw new Error("shared-source rebase sidecars disappeared");
      if (![entry.beforeConfig.fingerprint, entry.afterConfig.fingerprint].includes(currentConfig.fingerprint)
        || ![entry.beforeCapabilities.fingerprint, entry.afterCapabilities.fingerprint].includes(currentCapabilities.fingerprint)) {
        throw new Error(`account ${entry.opaqueAccountId} sidecars changed during donor rebase`);
      }
      assertWriteEvidence(input.accountWriteEvidence?.[entry.opaqueAccountId]);
      if (currentConfig.fingerprint !== entry.afterConfig.fingerprint) persistConfigOverrides(root, entry.afterConfig);
      if (currentCapabilities.fingerprint !== entry.afterCapabilities.fingerprint) persistCapabilityOverrides(root, entry.afterCapabilities);
    }
    if (input.faultAt === "after_sidecars") throw new Error("injected shared-source rebase fault after sidecars");
    const beforePublish = sharedSourceCandidate(input, source, journalGenerations);
    if (beforePublish.fingerprint !== candidate.fingerprint) throw new Error("shared source changed before donor publication");
    let publishedPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    const expectedPriorPluginFingerprint = existingIntent?.priorSharedPluginFingerprint ?? input.priorPlugins.fingerprint;
    if (publishedPlugins?.fingerprint === expectedPriorPluginFingerprint) {
      publishedPlugins = bootstrapSharedPluginsManifest(
        input.stateRoot,
        source.codexHome,
        candidatePluginGeneration,
        true,
        expectedPriorPluginFingerprint,
        candidate.plugins.fingerprint,
        input.faultAt === "during_plugins" ? "during_copy" : undefined,
      );
    }
    if (!publishedPlugins || publishedPlugins.fingerprint !== candidate.plugins.fingerprint) throw new Error("shared-source plugin publication failed");
    if (input.faultAt === "after_plugins") throw new Error("injected shared-source rebase fault after plugins");
    let publishedShared = loadSharedAccountBase(input.stateRoot);
    const expectedPriorSharedFingerprint = existingIntent?.priorSharedBaseFingerprint ?? input.priorShared.fingerprint;
    if (publishedShared?.fingerprint === expectedPriorSharedFingerprint) writeSharedAccountBase(input.stateRoot, candidate.shared, expectedPriorSharedFingerprint);
    publishedShared = loadSharedAccountBase(input.stateRoot);
    if (!publishedShared || publishedShared.fingerprint !== candidate.shared.fingerprint) throw new Error("shared-source base publication failed");
    if (input.faultAt === "after_shared") throw new Error("injected shared-source rebase fault after shared base");
    atomicWritePrivateJson(sharedRoot, SHARED_SOURCE_REBASE_RECEIPT_FILE, {
      version: VERSION, primaryOpaqueAccountId: receiptPrimary, previousSharedSourceOpaqueAccountId: previousSource,
      sharedSourceOpaqueAccountId: input.sharedSourceOpaqueAccountId,
      priorSharedBaseFingerprint: existingIntent?.priorSharedBaseFingerprint ?? input.priorShared.fingerprint,
      priorSharedPluginFingerprint: existingIntent?.priorSharedPluginFingerprint ?? input.priorPlugins.fingerprint,
      sharedBaseFingerprint: publishedShared.fingerprint, sharedPluginFingerprint: publishedPlugins.fingerprint,
      sharedGeneration: publishedShared.config.generation, pluginGeneration: publishedPlugins.generation,
      accounts: planned.map((entry) => ({ opaqueAccountId: entry.opaqueAccountId, configOverridesFingerprint: entry.afterConfig.fingerprint, capabilityOverridesFingerprint: entry.afterCapabilities.fingerprint })),
      createdAt: input.now?.() ?? new Date().toISOString(),
    });
    unlinkSync(join(sharedRoot, SHARED_SOURCE_REBASE_INTENT_FILE));
    fsyncDirectory(sharedRoot);
    return { ...result, shared: publishedShared, plugins: publishedPlugins };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "shared-source rebase failed" };
  }
}

/**
 * Add a newly enrolled account without rewriting an existing shared base or
 * any existing account's sidecars. Its current shareable values become
 * explicit copy-on-write overrides, so enrollment cannot silently adopt
 * another account's policy.
 */
export function ensureAccountContinuityEnrollment(input: EnsureAccountContinuityEnrollmentInputV1): EnsureAccountContinuityEnrollmentResultV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before enrollment" };
    if (!isOpaqueAccountId(input.account.opaqueAccountId) || !isAbsolute(input.account.codexHome)) {
      return { state: "blocked", reason: "invalid account continuity enrollment home" };
    }
    const shared = loadSharedAccountBase(input.stateRoot);
    const plugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!shared || !plugins) return { state: "blocked", reason: "shared account continuity is not initialized" };
    if (shared.config.schemaFingerprint !== input.schema.schemaFingerprint) {
      return { state: "blocked", reason: "shared account continuity schema does not match enrollment" };
    }
    const root = accountStateRoot(input.stateRoot, input.account);
    const hasConfig = existsSync(join(root, CONFIG_OVERRIDES_FILE));
    const hasCapabilities = existsSync(join(root, CAPABILITY_OVERRIDES_FILE));
    if (hasConfig || hasCapabilities) {
      if (!hasConfig || !hasCapabilities) return { state: "blocked", reason: "account continuity enrollment has partial existing sidecars" };
      const configOverrides = loadAccountConfigOverrides(input.stateRoot, input.account);
      const capabilityOverrides = loadAccountCapabilityOverrides(input.stateRoot, input.account);
      if (!configOverrides || !capabilityOverrides || configOverrides.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides.opaqueAccountId !== input.account.opaqueAccountId) {
        return { state: "blocked", reason: "account continuity enrollment sidecars are invalid" };
      }
      return { state: "ready", shared, plugins, configOverrides, capabilityOverrides };
    }
    const document = readAccountConfig(input.account.codexHome);
    const capabilities = scanCapabilityTree(input.account.codexHome);
    const configOverrides = buildConfigOverrides(input.account.opaqueAccountId, shared.config.generation, document.tree, input.schema);
    const capabilityOverrides = buildCapabilityOverrides(input.account.opaqueAccountId, shared.config.generation, capabilities);
    if (!input.apply) return { state: "would_enroll", shared, plugins, configOverrides, capabilityOverrides };
    assertWriteEvidence(input.writeEvidence);
    assertSafeOwnerDirectory(root, true);
    // Payloads become durable before the capability sidecar points at them.
    writeCapabilityPayloads(root, capabilities);
    persistConfigOverrides(root, configOverrides);
    persistCapabilityOverrides(root, capabilityOverrides);
    atomicWritePrivateJson(root, "enrollment-receipt.v1.json", {
      version: VERSION,
      schemaFingerprint: input.schema.schemaFingerprint,
      opaqueAccountId: input.account.opaqueAccountId,
      sharedBaseFingerprint: shared.fingerprint,
      sharedPluginFingerprint: plugins.fingerprint,
      configOverridesFingerprint: configOverrides.fingerprint,
      capabilityOverridesFingerprint: capabilityOverrides.fingerprint,
    });
    return { state: "ready", shared, plugins, configOverrides, capabilityOverrides };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account continuity enrollment failed" };
  }
}

interface TextPatchV1 {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function pathHasPrefix(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment);
}

function applyTextPatches(source: string, patches: readonly TextPatchV1[]): string {
  const ordered = [...patches].sort((left, right) => right.start - left.start || right.end - left.end);
  let previousStart = source.length + 1;
  let output = source;
  for (const patch of ordered) {
    if (!Number.isInteger(patch.start) || !Number.isInteger(patch.end) || patch.start < 0 || patch.end < patch.start || patch.end > source.length || patch.end > previousStart) {
      throw new Error("overlapping account continuity TOML patches");
    }
    output = `${output.slice(0, patch.start)}${patch.replacement}${output.slice(patch.end)}`;
    previousStart = patch.start;
  }
  return output;
}

function sourceTableBlockEnd(document: LosslessTomlDocument, table: TomlSourceTableV1): number {
  const tables = Object.values(document.tables).sort((left, right) => left.range[0] - right.range[0]);
  const index = tables.findIndex((candidate) => candidate === table || (candidate.range[0] === table.range[0] && candidate.range[1] === table.range[1]));
  if (index < 0) return document.source.length;
  return tables[index + 1]?.range[0] ?? document.source.length;
}

function insertionText(source: string, offset: number, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const before = source.slice(0, offset);
  const needLeadingNewline = before.length > 0 && !before.endsWith("\n");
  return `${needLeadingNewline ? "\n" : ""}${lines.join("\n")}\n`;
}

function sourceAssignmentFor(document: LosslessTomlDocument, path: readonly string[]): TomlSourceAssignmentV1 | undefined {
  return document.assignments[pathKey(path)];
}

function isEmptyTomlTable(value: TomlNodeV1 | undefined): boolean {
  return isTomlTable(value) && Object.keys(value).length === 0;
}

function effectiveTomlText(
  current: LosslessTomlDocument,
  effective: TomlTableV1,
  inheritedPaths: readonly ConfigFieldPath[],
): string {
  const currentLeaves = flattenTomlLeaves(current.tree);
  const effectiveLeaves = flattenTomlLeaves(effective);
  const inherited = new Set(inheritedPaths.map(configPathKey));
  const patches: TextPatchV1[] = [];
  const patchedOwnerPaths = new Set<string>();
  const removedPaths = new Set<string>();

  // Existing assignments are either untouched, have a value-level patch, or
  // are removed only when receipt provenance proves they were inherited.
  for (const [key, sourceEntry] of currentLeaves) {
    const desired = effectiveLeaves.get(key);
    const assignment = sourceAssignmentFor(current, sourceEntry.path);
    if (!assignment) throw new Error("missing TOML source assignment");
    const ownerKey = pathKey(assignment.ownerPath);
    if (desired === undefined) {
      if (!inherited.has(key)) continue;
      if (patchedOwnerPaths.has(ownerKey)) continue;
      patches.push({ start: assignment.range[0], end: consumeAssignmentNewline(current.source, assignment.range[1]), replacement: "" });
      patchedOwnerPaths.add(ownerKey);
      removedPaths.add(key);
      continue;
    }
    if (compareToml(sourceEntry.value, desired.value)) continue;
    if (patchedOwnerPaths.has(ownerKey)) continue;
    const ownerPath = assignment.ownerPath.map((part) => {
      if (typeof part !== "string") throw new Error("array-table source replacement is unsupported");
      return part;
    });
    const ownerDesired = getTomlNode(effective, ownerPath);
    if (!ownerDesired || !isTomlDataValue(ownerDesired)) throw new Error("changed TOML source owner has no effective value");
    const ownerAssignment = sourceAssignmentFor(current, ownerPath);
    if (!ownerAssignment) throw new Error("missing TOML source owner assignment");
    patches.push({ start: ownerAssignment.valueRange[0], end: ownerAssignment.valueRange[1], replacement: renderTomlValue(ownerDesired) });
    patchedOwnerPaths.add(ownerKey);
  }

  // Add every missing leaf in table-sized groups so one new table header is
  // emitted at most once. Inline/array values are leaves and never need a
  // synthetic subtable.
  const additions = new Map<string, { parent: readonly string[]; values: Array<{ key: string; value: TomlDataValueV1 }> }>();
  for (const [key, desired] of effectiveLeaves) {
    if (currentLeaves.has(key)) continue;
    if (!isTomlDataValue(desired.value)) throw new Error("cannot materialize a bare TOML table");
    const parent = desired.path.slice(0, -1);
    const parentNode = getTomlNode(current.tree, parent);
    if (isTomlInlineTable(parentNode) || isTomlArrayTable(parentNode)) throw new Error("cannot extend a local inline or array TOML table");
    const groupKey = pathKey(parent);
    const group = additions.get(groupKey) ?? { parent, values: [] };
    group.values.push({ key: desired.path.at(-1)!, value: desired.value });
    additions.set(groupKey, group);
  }
  const tableBlocks = Object.values(current.tables).filter((table) => table.kind === "standard");
  const firstTableOffset = tableBlocks.length ? Math.min(...tableBlocks.map((table) => table.range[0])) : current.source.length;
  for (const group of additions.values()) {
    const lines = group.values.sort((left, right) => left.key.localeCompare(right.key)).map((entry) => `${renderTomlKey(entry.key)} = ${renderTomlValue(entry.value)}`);
    const knownTable = current.tables[pathKey(group.parent)];
    if (knownTable && knownTable.kind === "standard") {
      const offset = sourceTableBlockEnd(current, knownTable);
      patches.push({ start: offset, end: offset, replacement: insertionText(current.source, offset, lines) });
      continue;
    }
    if (group.parent.length === 0) {
      patches.push({ start: firstTableOffset, end: firstTableOffset, replacement: insertionText(current.source, firstTableOffset, lines) });
      continue;
    }
    const offset = current.source.length;
    patches.push({ start: offset, end: offset, replacement: insertionText(current.source, offset, [`[${renderTomlPath(group.parent)}]`, ...lines]) });
  }

  const output = applyTextPatches(current.source, compactNonOverlappingPatches(patches));
  const parsed = parseLosslessTomlDocument(output);
  if (!compareTomlTrees(parsed.tree, effective)) {
    throw new Error("lossless TOML materialization did not produce the intended effective configuration");
  }
  void removedPaths;
  return output;
}

function compactNonOverlappingPatches(patches: readonly TextPatchV1[]): readonly TextPatchV1[] {
  // Inserts at an equal offset are safe only when merged deterministically.
  const grouped = new Map<string, TextPatchV1[]>();
  for (const patch of patches) {
    const key = `${patch.start}:${patch.end}`;
    const values = grouped.get(key) ?? [];
    values.push(patch);
    grouped.set(key, values);
  }
  return [...grouped.values()].map((values) => {
    if (values.length === 1) return values[0]!;
    if (values.some((value) => value.start !== value.end)) throw new Error("overlapping account continuity TOML patches");
    const first = values[0]!;
    return { ...first, replacement: values.map((value) => value.replacement).join("") };
  });
}

function consumeAssignmentNewline(source: string, end: number): number {
  if (source.slice(end, end + 2) === "\r\n") return end + 2;
  if (source.slice(end, end + 1) === "\n") return end + 1;
  return end;
}

function compareTomlTrees(left: TomlTableV1, right: TomlTableV1): boolean {
  return stableJson(left) === stableJson(right);
}

/** Exposed for focused tests and integrations that need a no-write candidate. */
export function renderResolvedAccountToml(
  current: LosslessTomlDocument,
  effective: TomlTableV1,
  inheritedPaths: readonly ConfigFieldPath[] = [],
): string {
  return effectiveTomlText(current, effective, inheritedPaths);
}

function effectiveCapabilityFingerprint(files: readonly { relativePath: string; fingerprint: Sha256 }[]): Sha256 {
  return sha256Json(files.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint })).sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

interface StoredMaterializationV1 {
  readonly version: 1;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly codexHome: string;
  readonly schemaFingerprint: Sha256;
  readonly pluginFingerprint: Sha256;
  readonly sharedGeneration: number;
  readonly configOverridesFingerprint: Sha256;
  readonly capabilityOverridesFingerprint: Sha256;
  readonly configArtifactFingerprint: Sha256;
  readonly capabilityArtifactFingerprint: Sha256;
  readonly effectiveConfigFingerprint: Sha256;
  readonly effectiveCapabilityFingerprint: Sha256;
  readonly expectedConfig: TomlTableV1;
  readonly expectedCapabilities: readonly { readonly relativePath: string; readonly fingerprint: Sha256; readonly provenance: "shared" | "override" | "local_only" }[];
  readonly inheritedConfigPaths: readonly ConfigFieldPath[];
  readonly inheritedCapabilityPaths: readonly string[];
  readonly fingerprint: Sha256;
}

function materializationFingerprint(value: Omit<StoredMaterializationV1, "fingerprint">): Sha256 {
  return sha256Json(value);
}

function parseStoredMaterialization(value: unknown): StoredMaterializationV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version", "opaqueAccountId", "codexHome", "schemaFingerprint", "pluginFingerprint", "sharedGeneration", "configOverridesFingerprint", "capabilityOverridesFingerprint",
    "configArtifactFingerprint", "capabilityArtifactFingerprint", "effectiveConfigFingerprint", "effectiveCapabilityFingerprint", "expectedConfig", "expectedCapabilities",
    "inheritedConfigPaths", "inheritedCapabilityPaths", "fingerprint",
  ].includes(key)) || value.version !== VERSION || !isOpaqueAccountId(value.opaqueAccountId) || !isAbsolute(String(value.codexHome))
    || ![value.schemaFingerprint, value.pluginFingerprint, value.configOverridesFingerprint, value.capabilityOverridesFingerprint, value.configArtifactFingerprint,
      value.capabilityArtifactFingerprint, value.effectiveConfigFingerprint, value.effectiveCapabilityFingerprint, value.fingerprint].every(isSha256)
    || !Number.isSafeInteger(value.sharedGeneration) || Number(value.sharedGeneration) < 1 || !validateTomlNode(value.expectedConfig) || !isTomlTable(value.expectedConfig)
    || !Array.isArray(value.expectedCapabilities) || !Array.isArray(value.inheritedConfigPaths) || !Array.isArray(value.inheritedCapabilityPaths)) return null;
  const expectedCapabilities: Array<{ relativePath: string; fingerprint: Sha256; provenance: "shared" | "override" | "local_only" }> = [];
  for (const file of value.expectedCapabilities) {
    if (!isRecord(file) || Object.keys(file).some((key) => !["relativePath", "fingerprint", "provenance"].includes(key)) || !isSafeCapabilityRelativePath(String(file.relativePath))
      || !isSha256(file.fingerprint) || !["shared", "override", "local_only"].includes(String(file.provenance))) return null;
    expectedCapabilities.push({ relativePath: file.relativePath as string, fingerprint: file.fingerprint as Sha256, provenance: file.provenance as "shared" | "override" | "local_only" });
  }
  if (new Set(expectedCapabilities.map((file) => file.relativePath)).size !== expectedCapabilities.length) return null;
  const inheritedConfigPaths: ConfigFieldPath[] = [];
  for (const path of value.inheritedConfigPaths) {
    if (!Array.isArray(path) || path.length === 0 || path.some((part) => typeof part !== "string" || part.length === 0)) return null;
    inheritedConfigPaths.push(path);
  }
  const inheritedCapabilityPaths: string[] = [];
  for (const path of value.inheritedCapabilityPaths) {
    if (!isSafeCapabilityRelativePath(String(path))) return null;
    inheritedCapabilityPaths.push(path);
  }
  const draft: Omit<StoredMaterializationV1, "fingerprint"> = {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId as OpaqueAccountId,
    codexHome: resolve(value.codexHome as string),
    schemaFingerprint: value.schemaFingerprint as Sha256,
    pluginFingerprint: value.pluginFingerprint as Sha256,
    sharedGeneration: value.sharedGeneration as number,
    configOverridesFingerprint: value.configOverridesFingerprint as Sha256,
    capabilityOverridesFingerprint: value.capabilityOverridesFingerprint as Sha256,
    configArtifactFingerprint: value.configArtifactFingerprint as Sha256,
    capabilityArtifactFingerprint: value.capabilityArtifactFingerprint as Sha256,
    effectiveConfigFingerprint: value.effectiveConfigFingerprint as Sha256,
    effectiveCapabilityFingerprint: value.effectiveCapabilityFingerprint as Sha256,
    expectedConfig: value.expectedConfig as TomlTableV1,
    expectedCapabilities: expectedCapabilities.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    inheritedConfigPaths: inheritedConfigPaths.sort(compareStringPaths),
    inheritedCapabilityPaths: inheritedCapabilityPaths.sort(),
  };
  return materializationFingerprint(draft) === (value.fingerprint as Sha256) ? { ...draft, fingerprint: value.fingerprint as Sha256 } : null;
}

function materializationResult(stored: StoredMaterializationV1, expectedCapabilities: readonly ResolvedCapabilityFileV1[], state: "ready" | "would_write" | "blocked", written: boolean, reason?: string): AccountConfigMaterializationV1 {
  return {
    version: VERSION,
    state,
    ...(reason ? { reason } : {}),
    opaqueAccountId: stored.opaqueAccountId,
    sharedGeneration: stored.sharedGeneration,
    configOverridesFingerprint: stored.configOverridesFingerprint,
    capabilityOverridesFingerprint: stored.capabilityOverridesFingerprint,
    configArtifactFingerprint: stored.configArtifactFingerprint,
    capabilityArtifactFingerprint: stored.capabilityArtifactFingerprint,
    effectiveConfigFingerprint: stored.effectiveConfigFingerprint,
    effectiveCapabilityFingerprint: stored.effectiveCapabilityFingerprint,
    expectedConfig: clone(stored.expectedConfig),
    expectedCapabilities: expectedCapabilities.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })),
    inheritedConfigPaths: clone(stored.inheritedConfigPaths),
    inheritedCapabilityPaths: [...stored.inheritedCapabilityPaths],
    written,
  };
}

function materializationCandidate(
  input: AccountConfigPrepareInputV1,
  config: ResolvedAccountConfigV1,
  capabilities: ResolvedAccountCapabilitiesV1,
  currentConfig: LosslessTomlDocument,
  currentCapabilities: CapabilityTreeSnapshotV1,
): { stored: StoredMaterializationV1; expectedCapabilities: readonly ResolvedCapabilityFileV1[] } {
  if (config.state !== "ready" || !config.tree || !config.effectiveFingerprint || !config.inheritedPaths || !config.preservationFingerprint
    || capabilities.state !== "ready" || !capabilities.files || !capabilities.effectiveFingerprint || !capabilities.inheritedPaths) {
    throw new Error("cannot construct an account continuity materialization from a blocked resolution");
  }
  const expectedCapabilities = capabilities.files;
  const draft: Omit<StoredMaterializationV1, "fingerprint"> = {
    version: VERSION,
    opaqueAccountId: input.account.opaqueAccountId,
    codexHome: resolve(input.account.codexHome),
    schemaFingerprint: input.schema.schemaFingerprint,
    pluginFingerprint: input.plugins.fingerprint,
    sharedGeneration: input.shared.config.generation,
    configOverridesFingerprint: input.configOverrides!.fingerprint,
    capabilityOverridesFingerprint: input.capabilityOverrides!.fingerprint,
    configArtifactFingerprint: currentConfig.fingerprint,
    capabilityArtifactFingerprint: effectiveCapabilityFingerprint(currentCapabilities.files),
    effectiveConfigFingerprint: config.effectiveFingerprint,
    effectiveCapabilityFingerprint: capabilities.effectiveFingerprint,
    expectedConfig: clone(config.tree),
    expectedCapabilities: expectedCapabilities.map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint, provenance: file.provenance })),
    inheritedConfigPaths: clone(config.inheritedPaths),
    inheritedCapabilityPaths: [...capabilities.inheritedPaths],
  };
  // The artifact fingerprints are replaced after successful publication. The
  // prepublication values remain only in the private transaction intent.
  return { stored: { ...draft, fingerprint: materializationFingerprint(draft) }, expectedCapabilities };
}

function storedMatchesCurrent(
  stored: StoredMaterializationV1,
  input: AccountConfigPrepareInputV1,
  currentConfig: LosslessTomlDocument,
  currentCapabilities: CapabilityTreeSnapshotV1,
): boolean {
  return stored.opaqueAccountId === input.account.opaqueAccountId
    && stored.codexHome === resolve(input.account.codexHome)
    && stored.schemaFingerprint === input.schema.schemaFingerprint
    && stored.pluginFingerprint === input.plugins.fingerprint
    && stored.sharedGeneration === input.shared.config.generation
    && stored.configOverridesFingerprint === input.configOverrides!.fingerprint
    && stored.capabilityOverridesFingerprint === input.capabilityOverrides!.fingerprint
    && stored.configArtifactFingerprint === currentConfig.fingerprint
    && stored.capabilityArtifactFingerprint === effectiveCapabilityFingerprint(currentCapabilities.files);
}

function assertWriteEvidence(evidence: AccountContinuityWriteEvidenceV1 | undefined): void {
  if (!evidence?.accountChildAbsent) throw new Error("account continuity requires an absent-child write lease");
  if (!evidence.nativeWriterCensus) return;
  const first = evidence.nativeWriterCensus();
  const second = evidence.nativeWriterCensus();
  if (first !== "zero" || second !== "zero") throw new Error("account continuity native writer census is not clean");
}

function stagePrivateFile(path: string, bytes: Buffer): void {
  assertSafeOwnerDirectory(dirname(path), true);
  atomicWriteFile(path, bytes, PRIVATE_FILE_MODE);
}

function stageCapabilities(root: string, files: readonly ResolvedCapabilityFileV1[]): void {
  assertSafeOwnerDirectory(root, true);
  const paths = new Set<string>();
  for (const file of files) {
    if (!isSafeCapabilityRelativePath(file.relativePath) || sha256(file.bytes) !== file.fingerprint) throw new Error("invalid resolved capability file");
    if (paths.has(file.relativePath)) throw new Error("duplicate resolved capability file");
    const components = file.relativePath.split("/");
    for (let index = 1; index < components.length; index += 1) {
      // A file cannot also be the parent of another staged file. Checking the
      // complete prefixes prevents a malformed sidecar from turning an
      // otherwise bounded overlay into an ambiguous filesystem layout.
      const prefix = components.slice(0, index).join("/");
      if (paths.has(prefix)) throw new Error("conflicting resolved capability file layout");
    }
    if ([...paths].some((path) => path.startsWith(`${file.relativePath}/`))) throw new Error("conflicting resolved capability file layout");
    paths.add(file.relativePath);
    const target = join(root, ...file.relativePath.split("/"));
    if (!safeResolvedChild(root, relative(root, target))) throw new Error("unsafe capability staging target");
    stagePrivateFile(target, file.bytes);
  }
}

function lstatIfPresent(path: string): Stats | null {
  try { return lstatSync(path); } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function genericArtifactFingerprint(path: string): Sha256 | "missing" {
  const stat = lstatIfPresent(path);
  if (!stat) return "missing";
  if (stat.isSymbolicLink() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) throw new Error("unsafe account materialization artifact");
  if (stat.isFile()) {
    const bytes = readSafeRegularFile(path, MAX_CAPABILITY_TOTAL_BYTES, true, false);
    if (!bytes) throw new Error("unsafe account materialization file");
    try { return sha256(bytes); } finally { bytes.fill(0); }
  }
  if (!stat.isDirectory()) throw new Error("unsafe account materialization artifact");
  const entries: Array<{ path: string; fingerprint: Sha256 }> = [];
  const visit = (directory: string, prefix: string): void => {
    assertSafeCapabilityDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      if (!isSafePluginSegment(name)) throw new Error("unsafe account materialization path");
      const child = join(directory, name); const relativePath = prefix ? `${prefix}/${name}` : name;
      const childStat = lstatSync(child);
      if (childStat.isDirectory()) visit(child, relativePath);
      else {
        const bytes = readSafeRegularFile(child, MAX_CAPABILITY_FILE_BYTES, true, false);
        if (!bytes) throw new Error("unsafe account materialization file");
        try { entries.push({ path: relativePath, fingerprint: sha256(bytes) }); } finally { bytes.fill(0); }
      }
    }
  };
  visit(path, "");
  return sha256Json(entries);
}

interface MaterializationStepV1 {
  /** config.toml or one regular capability file path, never a root directory. */
  readonly name: string;
  readonly target: string;
  readonly candidate: string | null;
  readonly backup: string;
  readonly before: Sha256 | "missing";
  readonly after: Sha256 | "missing";
  readonly applied: boolean;
}

interface MaterializationIntentV1 {
  readonly version: 1;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly codexHome: string;
  readonly transactionRoot: string;
  readonly receiptFingerprint: Sha256;
  readonly steps: readonly MaterializationStepV1[];
}

function isMaterializationPath(name: string): boolean {
  return name === "config.toml" || isSafeCapabilityRelativePath(name);
}

function materializationPath(root: string, name: string): string {
  if (!isMaterializationPath(name)) throw new Error("unsafe account materialization path");
  return join(resolve(root), ...name.split("/"));
}

/**
 * Check a leaf overlay target without following a linked root or child.  A
 * capability link is intentionally an account-local reference, so a shared
 * file that would land inside it is a conflict rather than a reason to write
 * through, replace, or copy the reference.
 */
function assertSafeMaterializationLeaf(codexHome: string, name: string, createParents = false): void {
  const root = resolve(codexHome);
  assertSafeCapabilityDirectory(root);
  const parts = name.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatIfPresent(parent);
    if (!stat) {
      if (!createParents) continue;
      mkdirSync(parent, { mode: PRIVATE_DIRECTORY_MODE });
      assertSafeCapabilityDirectory(parent);
      continue;
    }
    if (stat.isSymbolicLink()) throw new Error("shared capability conflicts with an account-local linked path");
    if (!stat.isDirectory()) throw new Error("shared capability parent is not a directory");
    assertSafeCapabilityDirectory(parent);
  }
  const target = materializationPath(root, name);
  const targetStat = lstatIfPresent(target);
  if (!targetStat) return;
  if (targetStat.isSymbolicLink()) throw new Error("shared capability conflicts with an account-local linked path");
  if (targetStat.isDirectory()) throw new Error("account materialization leaf is unexpectedly a directory");
  if (!targetStat.isFile()) throw new Error("unsafe account materialization artifact");
}

function parseMaterializationIntent(value: unknown): MaterializationIntentV1 | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "opaqueAccountId", "codexHome", "transactionRoot", "receiptFingerprint", "steps"].includes(key)) || value.version !== VERSION
    || !isOpaqueAccountId(value.opaqueAccountId) || !isAbsolute(String(value.codexHome)) || !isAbsolute(String(value.transactionRoot)) || !isSha256(value.receiptFingerprint) || !Array.isArray(value.steps)) return null;
  const codexHome = resolve(value.codexHome as string);
  const transactionRoot = resolve(value.transactionRoot as string);
  const steps: MaterializationStepV1[] = [];
  for (const step of value.steps) {
    if (!isRecord(step) || Object.keys(step).some((key) => !["name", "target", "candidate", "backup", "before", "after", "applied"].includes(key))
      || !isMaterializationPath(String(step.name)) || !isAbsolute(String(step.target)) || (step.candidate !== null && !isAbsolute(String(step.candidate))) || !isAbsolute(String(step.backup))
      || !(step.before === "missing" || isSha256(step.before)) || !(step.after === "missing" || isSha256(step.after)) || typeof step.applied !== "boolean") return null;
    const name = String(step.name);
    const expectedTarget = materializationPath(codexHome, name);
    const expectedCandidate = step.candidate === null ? null : join(transactionRoot, "candidates", ...name.split("/"));
    const expectedBackup = join(transactionRoot, "backups", ...name.split("/"));
    if (resolve(String(step.target)) !== expectedTarget || (step.candidate === null ? step.after !== "missing" : resolve(String(step.candidate)) !== expectedCandidate || !isSha256(step.after))
      || resolve(String(step.backup)) !== expectedBackup) return null;
    steps.push(step as unknown as MaterializationStepV1);
  }
  if (new Set(steps.map((step) => step.name)).size !== steps.length) return null;
  return {
    version: VERSION,
    opaqueAccountId: value.opaqueAccountId as OpaqueAccountId,
    codexHome,
    transactionRoot,
    receiptFingerprint: value.receiptFingerprint as Sha256,
    steps,
  };
}

function safeTransactionPath(codexHome: string, transactionRoot: string): boolean {
  return safeResolvedChild(codexHome, relative(codexHome, transactionRoot)) && basename(transactionRoot).startsWith(".tweakers-continuity-");
}

function recoverMaterialization(accountRoot: string, account: AccountContinuityAccountV1): "none" | "recovered" | "manual" {
  const raw = readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE);
  if (raw === null) return "none";
  const intent = parseMaterializationIntent(raw);
  if (!intent || intent.opaqueAccountId !== account.opaqueAccountId || intent.codexHome !== resolve(account.codexHome) || !safeTransactionPath(intent.codexHome, intent.transactionRoot)) return "manual";
  const receipt = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
  if (receipt && receipt.opaqueAccountId === account.opaqueAccountId && receipt.codexHome === intent.codexHome && receipt.fingerprint === intent.receiptFingerprint) {
    try {
      if (existsSync(intent.transactionRoot)) rmSync(intent.transactionRoot, { recursive: true, force: true });
      unlinkSync(join(accountRoot, MATERIALIZATION_INTENT_FILE));
      fsyncDirectory(accountRoot);
      return "recovered";
    } catch { return "manual"; }
  }
  try {
    for (const step of [...intent.steps].reverse()) {
      if (step.before === step.after) continue;
      assertSafeMaterializationLeaf(intent.codexHome, step.name);
      const current = genericArtifactFingerprint(step.target);
      const backup = genericArtifactFingerprint(step.backup);
      if (current === step.before && backup === "missing") continue;
      if (step.before !== "missing" && backup !== step.before) return "manual";
      if (current !== step.after && !(current === "missing" && backup === step.before)) return "manual";
      const discarded = join(intent.transactionRoot, "discard", ...step.name.split("/"));
      assertSafeOwnerDirectory(dirname(discarded), true);
      if (lstatIfPresent(step.target)) renameSync(step.target, discarded);
      if (step.before !== "missing") {
        assertSafeOwnerDirectory(dirname(step.target), true);
        renameSync(step.backup, step.target);
      }
    }
    if (existsSync(intent.transactionRoot)) rmSync(intent.transactionRoot, { recursive: true, force: true });
    unlinkSync(join(accountRoot, MATERIALIZATION_INTENT_FILE));
    fsyncDirectory(accountRoot);
    return "recovered";
  } catch {
    return "manual";
  }
}

function publishMaterialization(
  accountRoot: string,
  input: AccountConfigPrepareInputV1,
  currentConfig: LosslessTomlDocument,
  currentCapabilities: CapabilityTreeSnapshotV1,
  configText: string,
  expectedCapabilities: readonly ResolvedCapabilityFileV1[],
  candidate: StoredMaterializationV1,
  prior: StoredMaterializationV1 | null,
): StoredMaterializationV1 {
  const codexHome = resolve(input.account.codexHome);
  assertSafeCapabilityDirectory(codexHome);
  const transactionRoot = join(codexHome, `.tweakers-continuity-${process.pid}-${randomBytes(8).toString("hex")}`);
  mkdirSync(transactionRoot, { mode: PRIVATE_DIRECTORY_MODE });
  assertSafeOwnerDirectory(transactionRoot);
  const candidatesRoot = join(transactionRoot, "candidates");
  const backupsRoot = join(transactionRoot, "backups");
  assertSafeOwnerDirectory(candidatesRoot, true);
  assertSafeOwnerDirectory(backupsRoot, true);
  try {
    const candidateConfig = join(candidatesRoot, "config.toml");
    stagePrivateFile(candidateConfig, Buffer.from(configText, "utf8"));
    stageCapabilities(candidatesRoot, expectedCapabilities);
    const filesByPath = new Map(expectedCapabilities.map((file) => [file.relativePath, file]));
    const priorPaths = new Set(prior?.expectedCapabilities.map((file) => file.relativePath) ?? []);
    const removedPaths = [...priorPaths].filter((path) => !filesByPath.has(path))
      .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
    const desiredPaths = [...filesByPath.keys()].sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
    const targets: Array<[string, string | null]> = [
      ["config.toml", candidateConfig],
      ...removedPaths.map((path) => [path, null] as [string, null]),
      ...desiredPaths.map((path) => [path, join(candidatesRoot, ...path.split("/"))] as [string, string]),
    ].filter(([name]) => !capabilityPathHasLocalLink(codexHome, name!)) as Array<[string, string | null]>;
    for (const [name] of targets) assertSafeMaterializationLeaf(codexHome, name);
    const steps: MaterializationStepV1[] = targets.map(([name, source]) => {
      const target = materializationPath(codexHome, name);
      const before = genericArtifactFingerprint(target);
      const after = source ? genericArtifactFingerprint(source) : "missing";
      return { name, target, candidate: source, backup: join(backupsRoot, ...name.split("/")), before, after, applied: false };
    });
    const { fingerprint: _beforeFingerprint, ...beforeDraft } = candidate;
    const expectedReceiptFingerprint = materializationFingerprint({ ...beforeDraft, configArtifactFingerprint: sha256(configText),
      capabilityArtifactFingerprint: effectiveCapabilityFingerprint(expectedCapabilities) });
    const initialIntent: MaterializationIntentV1 = { version: VERSION, opaqueAccountId: input.account.opaqueAccountId, codexHome, transactionRoot, receiptFingerprint: expectedReceiptFingerprint, steps };
    atomicWritePrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE, initialIntent);
    if (input.faultAt === "after_intent") throw new Error("injected materialization fault after intent");
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      if (step.before === step.after) continue;
      assertSafeMaterializationLeaf(codexHome, step.name, true);
      if (genericArtifactFingerprint(step.target) !== step.before) throw new Error("account continuity materialization preimage drift");
      assertSafeOwnerDirectory(dirname(step.backup), true);
      if (lstatIfPresent(step.target)) renameSync(step.target, step.backup);
      if (step.candidate) renameSync(step.candidate, step.target);
      if (genericArtifactFingerprint(step.target) !== step.after) throw new Error("account continuity materialization postimage drift");
      const applied: MaterializationStepV1 = { ...step, applied: true };
      steps[index] = applied;
      atomicWritePrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE, { ...initialIntent, steps });
      if (input.faultAt === "after_config" && step.name === "config.toml") throw new Error("injected materialization fault after config");
    }
    if (input.faultAt === "after_capabilities") throw new Error("injected materialization fault after capabilities");
    const finalConfig = readAccountConfig(codexHome);
    const finalCapabilities = scanCapabilityTree(codexHome);
    const finalCapabilityFingerprint = effectiveCapabilityFingerprint(finalCapabilities.files);
    const expectedCapabilityFingerprint = effectiveCapabilityFingerprint(expectedCapabilities);
    if (finalConfig.source !== configText || finalCapabilityFingerprint !== expectedCapabilityFingerprint) {
      throw new Error("account continuity materialization verification failed");
    }
    const { fingerprint: _candidateFingerprint, ...candidateDraft } = candidate;
    const finalDraft: Omit<StoredMaterializationV1, "fingerprint"> = {
      ...candidateDraft,
      configArtifactFingerprint: finalConfig.fingerprint,
      capabilityArtifactFingerprint: finalCapabilityFingerprint,
    };
    const finalStored: StoredMaterializationV1 = { ...finalDraft, fingerprint: materializationFingerprint(finalDraft) };
    atomicWritePrivateJson(accountRoot, MATERIALIZATION_FILE, finalStored);
    // The completed receipt is publication-last. A crash beforehand uses the
    // intent to restore exact postimages only.
    if (existsSync(transactionRoot)) rmSync(transactionRoot, { recursive: true, force: true });
    unlinkSync(join(accountRoot, MATERIALIZATION_INTENT_FILE));
    fsyncDirectory(accountRoot);
    void currentConfig;
    void currentCapabilities;
    return finalStored;
  } catch (error) {
    const recovery = recoverMaterialization(accountRoot, input.account);
    if (recovery === "manual") throw new Error("account continuity materialization requires manual recovery");
    throw error;
  }
}

function blockedMaterialization(account: OpaqueAccountId, reason: string): AccountConfigMaterializationV1 {
  return { version: VERSION, state: "blocked", reason, opaqueAccountId: account, written: false };
}

/**
 * Reconcile an account immediately before spawn. This function is synchronous
 * by design: callers hold their same-account Set lease through this call and
 * directly into process creation, so no yield can open a writer race.
 */
function isPortableConfigUpgradePath(path: readonly string[]): boolean {
  return path[0] === "model_provider" || path[0] === "model_providers" || path[0] === "marketplaces";
}

function preservePortableConfigOverrides(
  prior: AccountConfigOverridesV1,
  current: LosslessTomlDocument,
  stored: StoredMaterializationV1 | null,
  schema: AccountContinuitySchemaV1,
): AccountConfigOverridesV1 {
  const additions: ConfigOverrideOpV1[] = [];
  for (const { path, value } of flattenTomlLeaves(current.tree).values()) {
    if (!isPortableConfigUpgradePath(path) || classifyTomlPath(path, schema, value) !== "shared") continue;
    if (prior.operations.some((operation) => pathsOverlapBySegments(operation.path, path))
      || stored?.inheritedConfigPaths.some((inherited) => pathsOverlapBySegments(inherited, path))) continue;
    additions.push({ op: "set", path, value: clone(value) });
  }
  if (!additions.length) return prior;
  const draft: Omit<AccountConfigOverridesV1, "fingerprint"> = {
    ...prior, revision: prior.revision + 1, operations: normalizeConfigOperations([...prior.operations, ...additions]),
    preservationFingerprint: preservationFingerprint(current.tree, schema),
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}

export function prepareAccountConfigBeforeSpawn(input: AccountConfigPrepareInputV1): AccountConfigMaterializationV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return blockedMaterialization(input.account.opaqueAccountId, "shared-source rebase recovery is required before spawn");
    if (!isOpaqueAccountId(input.account.opaqueAccountId)) return blockedMaterialization(input.account.opaqueAccountId, "invalid account id");
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    if (lstatIfPresent(join(accountRoot, NATIVE_CAPTURE_INTENT_FILE))) return blockedMaterialization(input.account.opaqueAccountId, "native initial capture recovery is required before spawn");
    const pending = readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE);
    if (pending !== null) {
      if (!input.apply) return blockedMaterialization(input.account.opaqueAccountId, "account continuity recovery is required before spawn");
      assertWriteEvidence(input.writeEvidence);
      const recovery = recoverMaterialization(accountRoot, input.account);
      if (recovery === "manual") return blockedMaterialization(input.account.opaqueAccountId, "account continuity requires manual recovery");
    }
    let configOverrides = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    const capabilityOverrides = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!configOverrides || !capabilityOverrides) return blockedMaterialization(input.account.opaqueAccountId, "account continuity bootstrap sidecars are missing");
    if (configOverrides.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides.opaqueAccountId !== input.account.opaqueAccountId) {
      return blockedMaterialization(input.account.opaqueAccountId, "account continuity sidecar account mismatch");
    }
    const currentConfig = readAccountConfig(input.account.codexHome);
    const currentCapabilities = scanCapabilityTree(input.account.codexHome);
    const prior = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
    // Additive policy upgrade: keep the v1 schema/receipts valid and capture
    // previously local provider and marketplace values as explicit overrides
    // before sharing, preserving each account's existing source paths.
    // A changed native artifact still requires its ordinary after-exit capture.
    if (prior && prior.configOverridesFingerprint === configOverrides.fingerprint && prior.capabilityOverridesFingerprint === capabilityOverrides.fingerprint
      && (prior.configArtifactFingerprint !== currentConfig.fingerprint || prior.capabilityArtifactFingerprint !== effectiveCapabilityFingerprint(currentCapabilities.files))) {
      return blockedMaterialization(input.account.opaqueAccountId, "account configuration changed without an after-exit capture receipt");
    }
    const portableOverrides = preservePortableConfigOverrides(configOverrides, currentConfig, prior, input.schema);
    if (portableOverrides.fingerprint !== configOverrides.fingerprint) {
      if (input.apply) {
        assertWriteEvidence(input.writeEvidence);
        if (readAccountConfig(input.account.codexHome).fingerprint !== currentConfig.fingerprint) throw new Error("portable configuration changed during migration");
        persistConfigOverrides(accountRoot, portableOverrides);
      }
      configOverrides = portableOverrides;
    }
    const normalizedInput: AccountConfigPrepareInputV1 = { ...input, configOverrides, capabilityOverrides };
    const config = resolveAccountConfig({ shared: input.shared.config, overrides: configOverrides, currentLocal: currentConfig, plugins: input.plugins, schema: input.schema });
    if (config.state !== "ready") return blockedMaterialization(input.account.opaqueAccountId, config.reason ?? "account config resolution failed");
    const capabilities = resolveAccountCapabilities({ shared: input.shared.capabilities, overrides: capabilityOverrides, currentLocalRoot: input.account.codexHome });
    if (capabilities.state !== "ready") return blockedMaterialization(input.account.opaqueAccountId, capabilities.reason ?? "account capability resolution failed");
    const pluginsReady = preparePluginPackages(normalizedInput, accountRoot);
    const candidate = materializationCandidate(normalizedInput, config, capabilities, currentConfig, currentCapabilities);
    if (prior && storedMatchesCurrent(prior, normalizedInput, currentConfig, currentCapabilities)
      && prior.effectiveConfigFingerprint === config.effectiveFingerprint && prior.effectiveCapabilityFingerprint === capabilities.effectiveFingerprint) {
      return materializationResult(prior, capabilities.files!, pluginsReady ? "ready" : "would_write", false);
    }
    if (prior && prior.configOverridesFingerprint === configOverrides.fingerprint && prior.capabilityOverridesFingerprint === capabilityOverrides.fingerprint
      && (prior.configArtifactFingerprint !== currentConfig.fingerprint || prior.capabilityArtifactFingerprint !== effectiveCapabilityFingerprint(currentCapabilities.files))) {
      return blockedMaterialization(input.account.opaqueAccountId, "account configuration changed without an after-exit capture receipt");
    }
    const previousInherited = prior?.inheritedConfigPaths ?? [];
    const configText = effectiveTomlText(currentConfig, config.tree!, previousInherited);
    if (!input.apply) return materializationResult(candidate.stored, capabilities.files!, "would_write", false);
    assertWriteEvidence(input.writeEvidence);
    const published = publishMaterialization(accountRoot, normalizedInput, currentConfig, currentCapabilities, configText, capabilities.files!, candidate.stored, prior);
    return materializationResult(published, capabilities.files!, "ready", true);
  } catch (error) {
    return blockedMaterialization(input.account.opaqueAccountId, error instanceof Error ? error.message : "account continuity prepare failed");
  }
}

function assertNativeContinuityIdentity(input: AccountNativeBaselineInputV1): void {
  const home = resolve(input.account.codexHome);
  const accountRoot = accountStateRoot(input.stateRoot, input.account);
  const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
  const privateRoots = [resolve(input.stateRoot), sharedRoot, accountRoot, join(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY)];
  if (!isAbsolute(input.account.codexHome) || realpathSync(home) !== home) throw new Error("native account home is not canonical");
  assertSafeCapabilityDirectory(home);
  const stat = lstatSync(home);
  // The signed history binding verifies persistent volume identity on remount.
  // Keep original recorded identities in continuity receipts; do not rewrite them.
  if (stat.ino !== input.nativeHomeIdentity.inode || (stat.dev !== input.nativeHomeIdentity.device && !input.nativeBindingPreflight())) throw new Error("native account home identity changed");
  for (const root of privateRoots) {
    assertSafeCapabilityDirectory(root);
    if (realpathSync(root) !== root || (lstatSync(root).mode & 0o077) !== 0
      || root === home || safeResolvedChild(home, relative(home, root)) || safeResolvedChild(root, relative(root, home))) {
      throw new Error("native baseline metadata must be private and disjoint from the native home");
    }
  }
  if (!safeResolvedChild(resolve(input.stateRoot), relative(resolve(input.stateRoot), accountRoot))) throw new Error("native baseline account metadata is outside broker state");
}

/**
 * Recognize an already-effective native home without materializing it. Two
 * coherent observations bind the signed home, private inputs and artifacts.
 * Only the broker-private completion receipt may be written, even with apply.
 */
export function observeExistingNativeAccountContinuity(input: AccountNativeBaselineInputV1): AccountConfigMaterializationV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return blockedMaterialization(input.account.opaqueAccountId, "shared-source rebase recovery is required before native observation");
    const home = resolve(input.account.codexHome);
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    const observe = () => {
      if (!input.nativeBindingPreflight()) throw new Error("native account binding changed");
      assertNativeContinuityIdentity(input);
      const metadata = {
        shared: readPrivateJson(sharedRoot, BASE_FILE),
        plugins: readPrivateJson(sharedRoot, PLUGIN_MANIFEST_FILE),
        config: readPrivateJson(accountRoot, CONFIG_OVERRIDES_FILE),
        capabilities: readPrivateJson(accountRoot, CAPABILITY_OVERRIDES_FILE),
        receipt: readPrivateJson(accountRoot, MATERIALIZATION_FILE),
        projections: readPrivateJson(accountRoot, PLUGIN_PROJECTIONS_FILE),
      };
      for (const pending of [MATERIALIZATION_INTENT_FILE, PLUGIN_PROJECTION_INTENT_FILE, NATIVE_CAPTURE_INTENT_FILE]) {
        if (lstatIfPresent(join(accountRoot, pending))) throw new Error("native account continuity recovery is required");
      }
      if (metadata.projections === null && lstatIfPresent(join(accountRoot, PLUGIN_PROJECTIONS_FILE))) throw new Error("invalid plugin projection receipt");
      const shared = parseSharedBase(metadata.shared, sharedRoot, true);
      const plugins = parseSharedPluginsManifest(metadata.plugins, sharedRoot);
      const configOverrides = parseConfigOverrides(metadata.config);
      const capabilityOverrides = parseCapabilityOverrides(metadata.capabilities, join(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY));
      if (!shared || !plugins || !configOverrides || !capabilityOverrides
        || shared.fingerprint !== input.shared.fingerprint || stableJson(serializableSharedBase(input.shared)) !== stableJson(metadata.shared)
        || plugins.fingerprint !== input.plugins.fingerprint
        || configOverrides.opaqueAccountId !== input.account.opaqueAccountId || capabilityOverrides.opaqueAccountId !== input.account.opaqueAccountId
        || (input.configOverrides && input.configOverrides.fingerprint !== configOverrides.fingerprint)
        || (input.capabilityOverrides && input.capabilityOverrides.fingerprint !== capabilityOverrides.fingerprint)) {
        throw new Error("native account continuity inputs are missing, invalid or changed");
      }
      const normalized = { ...input, shared, plugins, configOverrides, capabilityOverrides, apply: false };
      const currentConfig = readAccountConfig(home);
      const currentCapabilities = scanCapabilityTree(home);
      const config = resolveAccountConfig({ shared: shared.config, overrides: configOverrides, currentLocal: currentConfig, plugins, schema: input.schema });
      const capabilities = resolveAccountCapabilities({ shared: shared.capabilities, overrides: capabilityOverrides, currentLocalRoot: home });
      if (config.state !== "ready" || capabilities.state !== "ready") throw new Error(config.reason ?? capabilities.reason ?? "native continuity resolution failed");
      const pluginsReady = preparePluginPackages(normalized, accountRoot);
      const cache = join(home, "plugins", "cache");
      const sharedPluginIds = new Set(plugins.plugins.map((plugin) => plugin.id));
      if (sharedPluginIds.size && lstatIfPresent(join(home, "plugins"))) assertSafeCapabilityDirectory(join(home, "plugins"));
      // Unshared native caches are account-local and do not participate in
      // this continuity claim, just as bootstrap only scans selected IDs.
      const pluginSnapshot = sharedPluginIds.size && lstatIfPresent(cache) ? scanPluginCache(cache, sharedPluginIds) : [];
      const candidate = materializationCandidate(normalized, config, capabilities, currentConfig, currentCapabilities);
      const prior = parseStoredMaterialization(metadata.receipt);
      if ((metadata.receipt !== null || lstatIfPresent(join(accountRoot, MATERIALIZATION_FILE))) && !prior) throw new Error("invalid native materialization receipt");
      if (prior && (!idleCaptureReceiptIsCoherent(prior) || prior.opaqueAccountId !== input.account.opaqueAccountId
        || prior.codexHome !== home || prior.schemaFingerprint !== input.schema.schemaFingerprint)) throw new Error("native account continuity receipt binding is invalid");
      assertNativeContinuityIdentity(input);
      const priorCompatibleWithReadOnlyDonorRebase = Boolean(prior
        && (prior.sharedGeneration !== candidate.stored.sharedGeneration || prior.pluginFingerprint !== candidate.stored.pluginFingerprint)
        && prior.configOverridesFingerprint === candidate.stored.configOverridesFingerprint
        && prior.capabilityOverridesFingerprint === candidate.stored.capabilityOverridesFingerprint);
      return {
        candidate, prior,
        ready: (!prior || prior.fingerprint === candidate.stored.fingerprint || priorCompatibleWithReadOnlyDonorRebase)
          && pluginsReady && sha256Json(currentConfig.tree) === config.effectiveFingerprint
          && effectiveCapabilityFingerprint(currentCapabilities.files) === effectiveCapabilityFingerprint(capabilities.files!),
        fingerprint: sha256Json({ metadata, candidate: candidate.stored.fingerprint, pluginSnapshot }),
      };
    };
    const first = observe();
    const final = observe();
    if (first.fingerprint !== final.fingerprint || first.ready !== final.ready) throw new Error("native account continuity changed during observation");
    if (!final.ready) return materializationResult(final.candidate.stored, final.candidate.expectedCapabilities, "would_write", false, "native account inheritance requires an idle home");
    if (input.apply && !final.prior) atomicWritePrivateJson(accountRoot, MATERIALIZATION_FILE, final.candidate.stored);
    return materializationResult(final.prior ?? final.candidate.stored, final.candidate.expectedCapabilities, "ready", false);
  } catch (error) {
    return blockedMaterialization(input.account.opaqueAccountId, error instanceof Error ? error.message : "native account continuity observation failed");
  }
}

interface NativeInitialCaptureReceiptV1 {
  readonly version: 1;
  readonly opaqueAccountId: OpaqueAccountId;
  readonly codexHome: string;
  readonly nativeHomeIdentity: { readonly device: number; readonly inode: number };
  readonly schemaFingerprint: Sha256;
  readonly sourceReceiptFingerprint: Sha256;
  readonly configOverridesFingerprint: Sha256;
  readonly capabilityOverridesFingerprint: Sha256;
  readonly observedConfig: TomlTableV1;
  readonly observedCapabilities: readonly { readonly relativePath: string; readonly fingerprint: Sha256 }[];
  readonly fingerprint: Sha256;
}

interface NativeInitialCaptureIntentV1 {
  readonly version: 1;
  readonly beforeConfig: AccountConfigOverridesV1;
  readonly beforeCapabilities: AccountCapabilityOverridesV1;
  readonly afterConfig: AccountConfigOverridesV1;
  readonly afterCapabilities: AccountCapabilityOverridesV1;
  readonly completion: NativeInitialCaptureReceiptV1;
  readonly fingerprint: Sha256;
}

function parseNativeInitialCaptureReceipt(value: unknown, input: AccountNativeBaselineInputV1): NativeInitialCaptureReceiptV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => ![
    "version", "opaqueAccountId", "codexHome", "nativeHomeIdentity", "schemaFingerprint", "sourceReceiptFingerprint",
    "configOverridesFingerprint", "capabilityOverridesFingerprint", "observedConfig", "observedCapabilities", "fingerprint",
  ].includes(key)) || value.version !== VERSION || value.opaqueAccountId !== input.account.opaqueAccountId
    || value.codexHome !== resolve(input.account.codexHome) || value.schemaFingerprint !== input.schema.schemaFingerprint
    || !isRecord(value.nativeHomeIdentity) || Object.keys(value.nativeHomeIdentity).length !== 2
    || value.nativeHomeIdentity.device !== input.nativeHomeIdentity.device || value.nativeHomeIdentity.inode !== input.nativeHomeIdentity.inode
    || ![value.sourceReceiptFingerprint, value.configOverridesFingerprint, value.capabilityOverridesFingerprint, value.fingerprint].every(isSha256)
    || !validateTomlNode(value.observedConfig) || !isTomlTable(value.observedConfig) || !Array.isArray(value.observedCapabilities)) {
    throw new Error("invalid native initial capture receipt binding");
  }
  for (const file of value.observedCapabilities) {
    if (!isRecord(file) || Object.keys(file).length !== 2 || !isSafeCapabilityRelativePath(String(file.relativePath)) || !isSha256(file.fingerprint)) {
      throw new Error("invalid native initial capture capability baseline");
    }
  }
  if (new Set(value.observedCapabilities.map((file) => file.relativePath)).size !== value.observedCapabilities.length) throw new Error("duplicate native initial capture capability");
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) throw new Error("native initial capture receipt fingerprint changed");
  return value as unknown as NativeInitialCaptureReceiptV1;
}

function parseNativeInitialCaptureIntent(value: unknown, input: AccountNativeBaselineInputV1): NativeInitialCaptureIntentV1 {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "beforeConfig", "beforeCapabilities", "afterConfig", "afterCapabilities", "completion", "fingerprint"].includes(key))
    || value.version !== VERSION || !isSha256(value.fingerprint)) throw new Error("invalid native initial capture intent");
  const { fingerprint, ...draft } = value;
  if (sha256Json(draft) !== fingerprint) throw new Error("native initial capture intent fingerprint changed");
  const beforeConfig = parseConfigOverrides(value.beforeConfig);
  const beforeCapabilities = parseCapabilityOverrides(value.beforeCapabilities);
  const afterConfig = parseConfigOverrides(value.afterConfig);
  const afterCapabilities = parseCapabilityOverrides(value.afterCapabilities);
  const completion = parseNativeInitialCaptureReceipt(value.completion, input);
  if (!beforeConfig || !beforeCapabilities || !afterConfig || !afterCapabilities
    || [beforeConfig, beforeCapabilities, afterConfig, afterCapabilities].some((entry) => entry.opaqueAccountId !== input.account.opaqueAccountId)
    || afterConfig.revision !== beforeConfig.revision + 1 || afterCapabilities.revision !== beforeCapabilities.revision + 1
    || completion.configOverridesFingerprint !== afterConfig.fingerprint || completion.capabilityOverridesFingerprint !== afterCapabilities.fingerprint) {
    throw new Error("invalid native initial capture sidecar pair");
  }
  return { version: VERSION, beforeConfig, beforeCapabilities, afterConfig, afterCapabilities, completion, fingerprint: value.fingerprint };
}

function originalNativeCaptureBaseline(
  bootstrap: unknown, enrollment: unknown, config: AccountConfigOverridesV1, capabilities: AccountCapabilityOverridesV1,
  input: AccountNativeBaselineInputV1,
): { config: TomlTableV1; capabilities: readonly { relativePath: string; fingerprint: Sha256 }[]; receiptFingerprint: Sha256 } {
  const receipt = enrollment ?? bootstrap;
  if (!isRecord(receipt) || (enrollment !== null ? receipt.version !== VERSION : ![1, 2].includes(Number(receipt.version)))
    || !isSha256(receipt.sharedBaseFingerprint) || !isSha256(receipt.sharedPluginFingerprint)
    || (receipt.schemaFingerprint === undefined ? receipt.sharedBaseFingerprint !== input.shared.fingerprint : receipt.schemaFingerprint !== input.schema.schemaFingerprint)
    || config.revision !== 1 || capabilities.revision !== 1 || config.basedOnSharedGeneration !== capabilities.basedOnSharedGeneration
    || config.operations.some((operation) => operation.op !== "set") || capabilities.operations.some((operation) => operation.op !== "set")) {
    throw new Error("native initial capture lacks an original schema-bound enrollment receipt");
  }
  let binding: Record<string, unknown>;
  if (enrollment !== null) {
    if (Object.keys(receipt).some((key) => !["version", "schemaFingerprint", "opaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "configOverridesFingerprint", "capabilityOverridesFingerprint"].includes(key))) throw new Error("invalid native enrollment receipt");
    binding = receipt;
  } else {
    const allowedBootstrapKeys = receipt.version === 1
      ? ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"]
      : ["version", "schemaFingerprint", "generation", "primaryOpaqueAccountId", "sharedSourceOpaqueAccountId", "sharedBaseFingerprint", "sharedPluginFingerprint", "accounts", "createdAt"];
    if (Object.keys(receipt).some((key) => !allowedBootstrapKeys.includes(key))
      || !Array.isArray(receipt.accounts) || receipt.generation !== config.basedOnSharedGeneration || !isOpaqueAccountId(receipt.primaryOpaqueAccountId)
      || (receipt.version === 2 && !isOpaqueAccountId(receipt.sharedSourceOpaqueAccountId))
      || typeof receipt.createdAt !== "string" || receipt.accounts.some((entry) => !isRecord(entry) || Object.keys(entry).length !== 3
        || !isOpaqueAccountId(entry.opaqueAccountId) || !isSha256(entry.configOverridesFingerprint) || !isSha256(entry.capabilityOverridesFingerprint))
      || new Set(receipt.accounts.map((entry) => entry.opaqueAccountId)).size !== receipt.accounts.length) throw new Error("invalid native bootstrap receipt");
    binding = receipt.accounts.find((entry) => entry.opaqueAccountId === input.account.opaqueAccountId) ?? {};
  }
  if (binding.opaqueAccountId !== input.account.opaqueAccountId || binding.configOverridesFingerprint !== config.fingerprint
    || binding.capabilityOverridesFingerprint !== capabilities.fingerprint) throw new Error("native initial capture sidecars no longer match enrollment");
  const tree: Record<string, TomlNodeV1> = {};
  for (const operation of config.operations) if (operation.op === "set") setTomlNode(tree, operation.path, operation.value);
  return {
    config: tree,
    capabilities: capabilities.operations.flatMap((operation) => operation.op === "set" ? [{ relativePath: operation.relativePath, fingerprint: operation.fingerprint }] : []),
    receiptFingerprint: sha256Json(receipt),
  };
}

/** Capture native edits since enrollment before inheritance has ever been applied. */
export function captureUnmaterializedNativeChangesBeforeSpawn(input: AccountNativeCaptureInputV1): AccountNativeCaptureResultV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) throw new Error("shared-source rebase recovery is required before native capture");
    if (!input.writeEvidence?.nativeWriterCensus) throw new Error("native initial capture requires a native idle census");
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    const sharedRoot = sharedAccountConfigRoot(input.stateRoot);
    const payloadRoot = join(accountRoot, CAPABILITY_OVERRIDE_FILES_DIRECTORY);
    const observe = () => {
      if (!input.nativeBindingPreflight()) throw new Error("native account binding changed before initial capture");
      assertNativeContinuityIdentity(input);
      assertWriteEvidence(input.writeEvidence);
      for (const pending of [MATERIALIZATION_FILE, MATERIALIZATION_INTENT_FILE, PLUGIN_PROJECTION_INTENT_FILE]) {
        if (lstatIfPresent(join(accountRoot, pending))) throw new Error("native initial capture requires an unmaterialized home without pending recovery");
      }
      const metadata = {
        shared: readPrivateJson(sharedRoot, BASE_FILE), plugins: readPrivateJson(sharedRoot, PLUGIN_MANIFEST_FILE),
        config: readPrivateJson(accountRoot, CONFIG_OVERRIDES_FILE), capabilities: readPrivateJson(accountRoot, CAPABILITY_OVERRIDES_FILE),
        bootstrap: readPrivateJson(sharedRoot, BOOTSTRAP_RECEIPT_FILE), enrollment: readPrivateJson(accountRoot, "enrollment-receipt.v1.json"),
        intent: readPrivateJson(accountRoot, NATIVE_CAPTURE_INTENT_FILE), completion: readPrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE),
      };
      for (const [file, value] of [[NATIVE_CAPTURE_INTENT_FILE, metadata.intent], [NATIVE_CAPTURE_RECEIPT_FILE, metadata.completion], ["enrollment-receipt.v1.json", metadata.enrollment]] as const) {
        if (value === null && lstatIfPresent(join(accountRoot, file))) throw new Error("invalid native initial capture metadata");
      }
      const shared = parseSharedBase(metadata.shared, sharedRoot, true);
      const plugins = parseSharedPluginsManifest(metadata.plugins, sharedRoot);
      const config = parseConfigOverrides(metadata.config);
      const capabilities = parseCapabilityOverrides(metadata.capabilities, payloadRoot);
      if (!shared || !plugins || !config || !capabilities || shared.fingerprint !== input.shared.fingerprint
        || stableJson(serializableSharedBase(input.shared)) !== stableJson(metadata.shared)
        || shared.config.schemaFingerprint !== input.schema.schemaFingerprint || plugins.fingerprint !== input.plugins.fingerprint
        || config.opaqueAccountId !== input.account.opaqueAccountId || capabilities.opaqueAccountId !== input.account.opaqueAccountId) throw new Error("native initial capture inputs are missing or changed");
      for (const operation of capabilities.operations) {
        if (operation.op !== "set") continue;
        const bytes = readCapabilityPayload(payloadRoot, operation);
        if (!bytes) throw new Error("native initial capture capability payload changed");
        bytes.fill(0);
      }
      const currentConfig = readAccountConfig(input.account.codexHome);
      const currentCapabilities = scanCapabilityTree(input.account.codexHome);
      assertNativeContinuityIdentity(input);
      return { metadata, config, capabilities, currentConfig, currentCapabilities,
        fingerprint: sha256Json({ metadata, config: currentConfig.fingerprint, capabilities: currentCapabilities.fingerprint }) };
    };
    const first = observe();
    const final = observe();
    if (first.fingerprint !== final.fingerprint) throw new Error("native initial capture changed during observation");
    if (final.metadata.intent !== null) {
      const intent = parseNativeInitialCaptureIntent(final.metadata.intent, input);
      if (![intent.beforeConfig.fingerprint, intent.afterConfig.fingerprint].includes(final.config.fingerprint)
        || ![intent.beforeCapabilities.fingerprint, intent.afterCapabilities.fingerprint].includes(final.capabilities.fingerprint)) throw new Error("native initial capture recovery has ambiguous sidecar drift");
      if (final.metadata.completion !== null) {
        const completed = parseNativeInitialCaptureReceipt(final.metadata.completion, input);
        if (completed.fingerprint !== intent.completion.fingerprint && completed.fingerprint !== intent.completion.sourceReceiptFingerprint) throw new Error("native initial capture completion changed during recovery");
        if (completed.fingerprint === intent.completion.fingerprint
          ? final.config.fingerprint !== intent.afterConfig.fingerprint || final.capabilities.fingerprint !== intent.afterCapabilities.fingerprint
          : completed.configOverridesFingerprint !== intent.beforeConfig.fingerprint || completed.capabilityOverridesFingerprint !== intent.beforeCapabilities.fingerprint) {
          throw new Error("native initial capture completion has ambiguous sidecars");
        }
      } else {
        const original = originalNativeCaptureBaseline(final.metadata.bootstrap, final.metadata.enrollment, intent.beforeConfig, intent.beforeCapabilities, input);
        if (original.receiptFingerprint !== intent.completion.sourceReceiptFingerprint) throw new Error("native initial capture recovery enrollment changed");
      }
      for (const operation of intent.afterCapabilities.operations) {
        if (operation.op !== "set") continue;
        const bytes = readCapabilityPayload(payloadRoot, operation);
        if (!bytes) throw new Error("native initial capture recovery payload changed");
        bytes.fill(0);
      }
      if (!input.apply) throw new Error("native initial capture recovery is required");
      assertWriteEvidence(input.writeEvidence);
      persistConfigOverrides(accountRoot, intent.afterConfig);
      persistCapabilityOverrides(accountRoot, intent.afterCapabilities);
      atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE, intent.completion);
      unlinkSync(join(accountRoot, NATIVE_CAPTURE_INTENT_FILE));
      fsyncDirectory(accountRoot);
      const resumed = captureUnmaterializedNativeChangesBeforeSpawn({ ...input, configOverrides: undefined, capabilityOverrides: undefined, captureFaultAt: undefined });
      return resumed.state === "unchanged" ? { ...resumed, state: "captured" } : resumed;
    }
    if ((input.configOverrides && input.configOverrides.fingerprint !== final.config.fingerprint)
      || (input.capabilityOverrides && input.capabilityOverrides.fingerprint !== final.capabilities.fingerprint)) throw new Error("native initial capture supplied sidecars changed");
    const completed = final.metadata.completion === null ? null : parseNativeInitialCaptureReceipt(final.metadata.completion, input);
    if (completed && (completed.configOverridesFingerprint !== final.config.fingerprint || completed.capabilityOverridesFingerprint !== final.capabilities.fingerprint)) throw new Error("native initial capture completion sidecars changed");
    const baseline = completed ? { config: completed.observedConfig, capabilities: completed.observedCapabilities, receiptFingerprint: completed.fingerprint }
      : originalNativeCaptureBaseline(final.metadata.bootstrap, final.metadata.enrollment, final.config, final.capabilities, input);
    const actualConfig = selectSharedTomlTree(final.currentConfig.tree, input.schema);
    const actualCapabilities = final.currentCapabilities.files.filter((file) => file.scope === "shareable").map((file) => ({ relativePath: file.relativePath, fingerprint: file.fingerprint }));
    if (compareTomlTrees(baseline.config, actualConfig) && effectiveCapabilityFingerprint(baseline.capabilities) === effectiveCapabilityFingerprint(actualCapabilities)) {
      return { state: "unchanged", configOverrides: final.config, capabilityOverrides: final.capabilities };
    }
    const nextConfig = capturedConfigOverrides(final.config, baseline.config, final.currentConfig.tree, input.shared.config.generation, input.schema);
    const nextCapabilities = capturedCapabilityOverrides(final.capabilities, baseline.capabilities.map((file) => ({ ...file, provenance: "override" as const })), final.currentCapabilities, input.shared.capabilities.generation);
    if (!input.apply) return { state: "captured", configOverrides: nextConfig, capabilityOverrides: nextCapabilities };
    const completionDraft: Omit<NativeInitialCaptureReceiptV1, "fingerprint"> = {
      version: VERSION, opaqueAccountId: input.account.opaqueAccountId, codexHome: resolve(input.account.codexHome), nativeHomeIdentity: { ...input.nativeHomeIdentity },
      schemaFingerprint: input.schema.schemaFingerprint, sourceReceiptFingerprint: baseline.receiptFingerprint,
      configOverridesFingerprint: nextConfig.fingerprint, capabilityOverridesFingerprint: nextCapabilities.fingerprint,
      observedConfig: actualConfig, observedCapabilities: actualCapabilities,
    };
    const completion = { ...completionDraft, fingerprint: sha256Json(completionDraft) };
    const { payloadRoot: _beforePayload, ...beforeCapabilities } = final.capabilities;
    const { payloadRoot: _afterPayload, ...afterCapabilities } = nextCapabilities;
    const intentDraft: Omit<NativeInitialCaptureIntentV1, "fingerprint"> = {
      version: VERSION, beforeConfig: final.config, beforeCapabilities, afterConfig: nextConfig, afterCapabilities, completion,
    };
    assertWriteEvidence(input.writeEvidence);
    writeCapabilityPayloads(accountRoot, final.currentCapabilities);
    // Recheck all authoritative inputs after payload staging, before the intent.
    if (observe().fingerprint !== final.fingerprint) throw new Error("native initial capture changed before publication");
    atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_INTENT_FILE, { ...intentDraft, fingerprint: sha256Json(intentDraft) });
    if (input.captureFaultAt === "after_intent") throw new Error("injected native initial capture fault after intent");
    persistConfigOverrides(accountRoot, nextConfig);
    if (input.captureFaultAt === "after_config") throw new Error("injected native initial capture fault after config");
    persistCapabilityOverrides(accountRoot, nextCapabilities);
    if (input.captureFaultAt === "after_capabilities") throw new Error("injected native initial capture fault after capabilities");
    atomicWritePrivateJson(accountRoot, NATIVE_CAPTURE_RECEIPT_FILE, completion);
    unlinkSync(join(accountRoot, NATIVE_CAPTURE_INTENT_FILE));
    fsyncDirectory(accountRoot);
    return { state: "captured", configOverrides: nextConfig, capabilityOverrides: nextCapabilities };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "native initial capture failed" };
  }
}

/** Validate only an already-completed receipt and exact materialized artifacts. */
export function validateAccountContinuityMaterialization(stateRoot: string, opaqueAccountId: OpaqueAccountId): boolean {
  try {
    if (!isOpaqueAccountId(opaqueAccountId)) return false;
    const account: AccountContinuityAccountV1 = { opaqueAccountId, codexHome: join(resolve(stateRoot), "accounts", opaqueAccountId, "codex-home") };
    const root = accountStateRoot(stateRoot, account);
    assertSafeOwnerDirectory(root);
    if (readPrivateJson(root, MATERIALIZATION_INTENT_FILE) !== null || lstatIfPresent(join(root, NATIVE_CAPTURE_INTENT_FILE))) return false;
    const receipt = parseStoredMaterialization(readPrivateJson(root, MATERIALIZATION_FILE));
    if (!receipt) return false;
    const config = readAccountConfig(receipt.codexHome);
    const capabilities = scanCapabilityTree(receipt.codexHome);
    return idleCaptureReceiptIsCoherent(receipt)
      && config.fingerprint === receipt.configArtifactFingerprint
      && effectiveCapabilityFingerprint(capabilities.files) === receipt.capabilityArtifactFingerprint
      && sha256Json(config.tree) === receipt.effectiveConfigFingerprint
      && effectiveCapabilityFingerprint(capabilities.files) === effectiveCapabilityFingerprint(receipt.expectedCapabilities);
  } catch {
    return false;
  }
}

function tablePaths(root: TomlTableV1, prefix: readonly string[] = [], output: readonly string[][] = []): readonly string[][] {
  const mutable = output as string[][];
  for (const [key, value] of Object.entries(root)) {
    const path = [...prefix, key];
    if (!isTomlTable(value)) continue;
    mutable.push(path);
    tablePaths(value, path, mutable);
  }
  return mutable;
}

function operationMap(operations: readonly ConfigOverrideOpV1[]): Map<string, ConfigOverrideOpV1> {
  return new Map(operations.map((operation) => [configPathKey(operation.path), clone(operation)]));
}

function replaceConfigOperation(map: Map<string, ConfigOverrideOpV1>, operation: ConfigOverrideOpV1): void {
  for (const [key, existing] of [...map]) {
    if (pathsOverlapBySegments(existing.path, operation.path)) map.delete(key);
  }
  map.set(configPathKey(operation.path), clone(operation));
}

function capturedConfigOverrides(
  prior: AccountConfigOverridesV1,
  expected: TomlTableV1,
  actual: TomlTableV1,
  sharedGeneration: number,
  schema: AccountContinuitySchemaV1,
): AccountConfigOverridesV1 {
  const operations = operationMap(prior.operations);
  const expectedLeaves = flattenTomlLeaves(expected);
  const actualLeaves = flattenTomlLeaves(actual);
  // A removed complete shared table is a table tombstone, so a future base
  // member cannot resurrect it. Do this before leaf-level deletes.
  for (const path of tablePaths(expected)) {
    if (classifyTomlPath(path, schema) !== "shared" || getTomlNode(actual, path) !== undefined) continue;
    replaceConfigOperation(operations, { path, op: "delete" });
  }
  for (const [key, entry] of actualLeaves) {
    if (classifyTomlPath(entry.path, schema, entry.value) !== "shared") continue;
    const expectedEntry = expectedLeaves.get(key);
    if (!expectedEntry || !compareToml(expectedEntry.value, entry.value)) replaceConfigOperation(operations, { path: entry.path, op: "set", value: entry.value });
  }
  for (const [key, entry] of expectedLeaves) {
    if (classifyTomlPath(entry.path, schema, entry.value) !== "shared" || actualLeaves.has(key)) continue;
    if ([...operations.values()].some((operation) => operation.op === "delete" && pathHasPrefix(entry.path, operation.path))) continue;
    replaceConfigOperation(operations, { path: entry.path, op: "delete" });
  }
  const normalized = normalizeConfigOperations([...operations.values()]);
  const draft: Omit<AccountConfigOverridesV1, "fingerprint"> = {
    version: VERSION,
    opaqueAccountId: prior.opaqueAccountId,
    revision: prior.revision + 1,
    basedOnSharedGeneration: sharedGeneration,
    operations: normalized,
    preservationFingerprint: preservationFingerprint(actual, schema),
  };
  return { ...draft, fingerprint: accountConfigOverridesFingerprint(draft) };
}

function proposedConfigBase(document: LosslessTomlDocument, shared: SharedAccountBaseV1, schema: AccountContinuitySchemaV1): SharedConfigBaseV1 {
  const generation = shared.config.generation + 1;
  const tree = selectSharedTomlTree(document.tree, schema);
  return {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree,
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, tree),
  };
}

/**
 * Capture one closed child's config changes. The caller retains its account
 * spawn lease; this function never edits config.toml and only advances the
 * account-private override receipt.
 */
export function captureAccountConfigAfterExit(input: AccountConfigCaptureInputV1): AccountConfigCaptureResultV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before config capture" };
    if (input.materialization.state !== "ready" || !input.materialization.expectedConfig || !input.materialization.effectiveConfigFingerprint) {
      return { state: "blocked", reason: "a valid prelaunch materialization receipt is required for config capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    const prior = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    if (!prior || prior.opaqueAccountId !== input.account.opaqueAccountId) return { state: "blocked", reason: "account config override sidecar is missing" };
    const current = readAccountConfig(input.account.codexHome);
    const next = capturedConfigOverrides(prior, input.materialization.expectedConfig, current.tree, input.shared.config.generation, input.schema);
    if (input.apply) {
      persistConfigOverrides(accountRoot, next);
      atomicWritePrivateJson(accountRoot, CAPTURE_RECEIPT_FILE, {
        version: VERSION,
        opaqueAccountId: input.account.opaqueAccountId,
        prelaunchEffectiveFingerprint: input.materialization.effectiveConfigFingerprint,
        observedConfigFingerprint: current.fingerprint,
        nextOverridesFingerprint: next.fingerprint,
        preservationFingerprint: next.preservationFingerprint,
      });
    }
    return {
      state: "captured",
      overrides: next,
      ...(input.primary ? { proposedSharedBase: proposedConfigBase(current, input.shared, input.schema) } : {}),
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account config capture failed" };
  }
}

function capabilityOperationMap(operations: readonly CapabilityOverrideOpV1[]): Map<string, CapabilityOverrideOpV1> {
  return new Map(operations.map((operation) => [operation.relativePath, clone(operation)]));
}

function replaceCapabilityOperation(map: Map<string, CapabilityOverrideOpV1>, operation: CapabilityOverrideOpV1): void {
  map.set(operation.relativePath, clone(operation));
}

function capturedCapabilityOverrides(
  prior: AccountCapabilityOverridesV1,
  expected: readonly { readonly relativePath: string; readonly fingerprint: Sha256; readonly provenance: "shared" | "override" | "local_only" }[],
  actual: CapabilityTreeSnapshotV1,
  sharedGeneration: number,
): AccountCapabilityOverridesV1 {
  const operations = capabilityOperationMap(prior.operations);
  const expectedByPath = new Map(expected.filter((file) => file.provenance !== "local_only").map((file) => [file.relativePath, file]));
  const actualByPath = new Map(actual.files.filter((file) => file.scope === "shareable").map((file) => [file.relativePath, file]));
  for (const [path, file] of actualByPath) {
    const expectedFile = expectedByPath.get(path);
    if (!expectedFile || expectedFile.fingerprint !== file.fingerprint) {
      replaceCapabilityOperation(operations, {
        relativePath: path,
        op: "set",
        fingerprint: file.fingerprint,
        payloadFile: file.fingerprint.slice("sha256:".length),
      });
    }
  }
  for (const [path] of expectedByPath) {
    if (!actualByPath.has(path)) replaceCapabilityOperation(operations, { relativePath: path, op: "delete" });
  }
  const draft: Omit<AccountCapabilityOverridesV1, "fingerprint" | "payloadRoot"> = {
    version: VERSION,
    opaqueAccountId: prior.opaqueAccountId,
    revision: prior.revision + 1,
    basedOnSharedGeneration: sharedGeneration,
    operations: normalizeCapabilityOperations([...operations.values()]),
    preservationFingerprint: capabilityFingerprint(actual.files.filter((file) => file.scope === "local_only")),
  };
  return { ...draft, fingerprint: accountCapabilityOverridesFingerprint(draft), ...(prior.payloadRoot ? { payloadRoot: prior.payloadRoot } : {}) };
}

/** Capture capability edits after a child closes, storing payloads before the sidecar references them. */
export function captureAccountCapabilitiesAfterExit(input: AccountCapabilityCaptureInputV1): AccountCapabilityCaptureResultV1 {
  try {
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before capability capture" };
    if (input.materialization.state !== "ready" || !input.materialization.expectedCapabilities || !input.materialization.effectiveCapabilityFingerprint) {
      return { state: "blocked", reason: "a valid prelaunch materialization receipt is required for capability capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot, Boolean(input.apply));
    const prior = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!prior || prior.opaqueAccountId !== input.account.opaqueAccountId) return { state: "blocked", reason: "account capability override sidecar is missing" };
    const current = scanCapabilityTree(input.account.codexHome);
    const next = capturedCapabilityOverrides(prior, input.materialization.expectedCapabilities, current, input.shared.capabilities.generation);
    if (input.apply) {
      writeCapabilityPayloads(accountRoot, current);
      persistCapabilityOverrides(accountRoot, next);
      atomicWritePrivateJson(accountRoot, CAPABILITY_CAPTURE_RECEIPT_FILE, {
        version: VERSION,
        opaqueAccountId: input.account.opaqueAccountId,
        prelaunchEffectiveFingerprint: input.materialization.effectiveCapabilityFingerprint,
        observedCapabilityFingerprint: effectiveCapabilityFingerprint(current.files),
        nextOverridesFingerprint: next.fingerprint,
        preservationFingerprint: next.preservationFingerprint,
      });
    }
    return { state: "captured", overrides: next, ...(input.primary ? { proposedSharedCapabilities: current } : {}) };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "account capability capture failed" };
  }
}

function materializationForIdleCapture(stored: StoredMaterializationV1): AccountConfigMaterializationV1 {
  return {
    version: VERSION,
    state: "ready",
    opaqueAccountId: stored.opaqueAccountId,
    sharedGeneration: stored.sharedGeneration,
    configOverridesFingerprint: stored.configOverridesFingerprint,
    capabilityOverridesFingerprint: stored.capabilityOverridesFingerprint,
    configArtifactFingerprint: stored.configArtifactFingerprint,
    capabilityArtifactFingerprint: stored.capabilityArtifactFingerprint,
    effectiveConfigFingerprint: stored.effectiveConfigFingerprint,
    effectiveCapabilityFingerprint: stored.effectiveCapabilityFingerprint,
    expectedConfig: clone(stored.expectedConfig),
    // Capture compares path/fingerprint/provenance only. Do not read any
    // mutable home file merely to populate an unused payload here.
    expectedCapabilities: stored.expectedCapabilities.map((file) => ({ ...file, bytes: Buffer.alloc(0) })),
    inheritedConfigPaths: clone(stored.inheritedConfigPaths),
    inheritedCapabilityPaths: [...stored.inheritedCapabilityPaths],
    written: false,
  };
}

function idleCaptureReceiptIsCoherent(stored: StoredMaterializationV1): boolean {
  return sha256Json(stored.expectedConfig) === stored.effectiveConfigFingerprint
    && capabilityFingerprint(stored.expectedCapabilities) === stored.effectiveCapabilityFingerprint;
}

function nextPrimaryConfigFromShared(shared: SharedAccountBaseV1, schema: AccountContinuitySchemaV1): SharedConfigBaseV1 {
  const generation = shared.config.generation + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("shared account generation overflow");
  return {
    version: VERSION,
    generation,
    schemaFingerprint: schema.schemaFingerprint,
    tree: clone(shared.config.tree),
    fingerprint: baseConfigFingerprint(generation, schema.schemaFingerprint, shared.config.tree),
  };
}

function sharedCapabilitiesAsSnapshot(shared: SharedAccountBaseV1, root: string): CapabilityTreeSnapshotV1 {
  const files: CapabilityFileV1[] = shared.capabilities.files.map((file) => {
    if (!file.bytes || !isSafeCapabilityRelativePath(file.relativePath) || sha256(file.bytes) !== file.fingerprint) {
      throw new Error("shared immutable capability bytes are unavailable for primary publication");
    }
    return { relativePath: file.relativePath, bytes: Buffer.from(file.bytes), fingerprint: file.fingerprint, scope: "shareable" };
  });
  return {
    version: VERSION,
    root: resolve(root),
    files,
    fingerprint: capabilityFingerprint(files),
  };
}

/**
 * Import an official/native app's edits after its home is proven idle and
 * before the broker materializes the next launch. Unchanged artifacts can be
 * rematerialized against a newer base. Changed artifacts are compared only to
 * their exact persisted expectation and become explicit account overrides.
 */
export function captureIdleAccountChangesBeforeSpawn(input: IdleAccountChangesCaptureInputV1): IdleAccountChangesCaptureResultV1 {
  try {
    validateSchema(input.schema);
    if (sharedSourceRebaseIsPending(input.stateRoot)) return { state: "blocked", reason: "shared-source rebase recovery is required before idle capture" };
    if (!isOpaqueAccountId(input.account.opaqueAccountId)) return { state: "blocked", reason: "invalid account id" };
    const persistedShared = loadSharedAccountBase(input.stateRoot);
    const persistedPlugins = loadSharedPluginsManifestV1(input.stateRoot);
    if (!persistedShared || !persistedPlugins || persistedShared.fingerprint !== input.shared.fingerprint || persistedPlugins.fingerprint !== input.plugins.fingerprint) {
      return { state: "blocked", reason: "shared account state changed before idle capture" };
    }
    const accountRoot = accountStateRoot(input.stateRoot, input.account);
    assertSafeOwnerDirectory(accountRoot);
    if (readPrivateJson(accountRoot, MATERIALIZATION_INTENT_FILE) !== null) {
      return { state: "blocked", reason: "account continuity recovery is required before idle capture" };
    }
    const stored = parseStoredMaterialization(readPrivateJson(accountRoot, MATERIALIZATION_FILE));
    if (!stored) return { state: "blocked", reason: "idle account changes lack a prior materialization receipt" };
    if (!idleCaptureReceiptIsCoherent(stored)) return { state: "blocked", reason: "idle account changes have an incoherent prior materialization receipt" };
    if (stored.opaqueAccountId !== input.account.opaqueAccountId || stored.codexHome !== resolve(input.account.codexHome)) {
      return { state: "blocked", reason: "idle account changes belong to a different account home" };
    }
    const currentConfig = readAccountConfig(input.account.codexHome);
    const currentCapabilities = scanCapabilityTree(input.account.codexHome);
    const configChanged = currentConfig.fingerprint !== stored.configArtifactFingerprint;
    const capabilitiesChanged = effectiveCapabilityFingerprint(currentCapabilities.files) !== stored.capabilityArtifactFingerprint;
    const primaryCapabilities = input.primary ? scanPrimarySharedCapabilities(input.account.codexHome) : undefined;
    const primaryLinksChanged = primaryCapabilities && capabilityFingerprint(primaryCapabilities.files.filter((file) => file.scope === "shareable"))
      !== capabilityFingerprint(input.shared.capabilities.files);
    if (primaryLinksChanged && input.apply) assertWriteEvidence(input.writeEvidence);
    if (!configChanged && !capabilitiesChanged) return primaryLinksChanged ? {
      state: "captured", proposedSharedConfig: nextPrimaryConfigFromShared(input.shared, input.schema),
      proposedSharedCapabilities: primaryCapabilities,
    } : { state: "unchanged" };
    if (input.apply) assertWriteEvidence(input.writeEvidence);
    if (stored.schemaFingerprint !== input.schema.schemaFingerprint) {
      return { state: "blocked", reason: "changed idle account artifacts were materialized against an incompatible schema" };
    }
    const configOverrides = input.configOverrides ?? loadAccountConfigOverrides(input.stateRoot, input.account);
    const capabilityOverrides = input.capabilityOverrides ?? loadAccountCapabilityOverrides(input.stateRoot, input.account);
    if (!configOverrides || !capabilityOverrides) return { state: "blocked", reason: "idle account changes lack account-private override sidecars" };
    const materialization = materializationForIdleCapture(stored);
    const configCapture = configChanged
      ? captureAccountConfigAfterExit({
        stateRoot: input.stateRoot,
        account: input.account,
        shared: input.shared,
        schema: input.schema,
        materialization,
        configOverrides,
        primary: input.primary,
        apply: false,
      })
      : undefined;
    const capabilityCapture = capabilitiesChanged
      ? captureAccountCapabilitiesAfterExit({
        stateRoot: input.stateRoot,
        account: input.account,
        shared: input.shared,
        materialization,
        capabilityOverrides,
        primary: input.primary,
        apply: false,
      })
      : undefined;
    if (configCapture?.state === "blocked") return { state: "blocked", reason: configCapture.reason };
    if (capabilityCapture?.state === "blocked") return { state: "blocked", reason: capabilityCapture.reason };
    const nextConfigOverrides = configCapture?.overrides ?? configOverrides;
    const nextCapabilityOverrides = capabilityCapture?.overrides ?? capabilityOverrides;
    if (!nextConfigOverrides || !nextCapabilityOverrides) return { state: "blocked", reason: "idle account change capture did not produce sidecars" };
    if (input.apply) {
      if (configChanged) {
        const applied = captureAccountConfigAfterExit({
          stateRoot: input.stateRoot,
          account: input.account,
          shared: input.shared,
          schema: input.schema,
          materialization,
          configOverrides,
          primary: input.primary,
          apply: true,
        });
        if (applied.state === "blocked" || !applied.overrides || applied.overrides.fingerprint !== nextConfigOverrides.fingerprint) {
          return { state: "blocked", reason: applied.reason ?? "idle config change capture changed during publication" };
        }
      }
      if (capabilitiesChanged) {
        const applied = captureAccountCapabilitiesAfterExit({
          stateRoot: input.stateRoot,
          account: input.account,
          shared: input.shared,
          materialization,
          capabilityOverrides,
          primary: input.primary,
          apply: true,
        });
        if (applied.state === "blocked" || !applied.overrides || applied.overrides.fingerprint !== nextCapabilityOverrides.fingerprint) {
          return { state: "blocked", reason: applied.reason ?? "idle capability change capture changed during publication" };
        }
      }
    }
    return {
      state: "captured",
      configOverrides: nextConfigOverrides,
      capabilityOverrides: nextCapabilityOverrides,
      ...(input.primary ? {
        proposedSharedConfig: configCapture?.proposedSharedBase ?? nextPrimaryConfigFromShared(input.shared, input.schema),
        proposedSharedCapabilities: primaryCapabilities!,
      } : {}),
    };
  } catch (error) {
    return { state: "blocked", reason: error instanceof Error ? error.message : "idle account change capture failed" };
  }
}
