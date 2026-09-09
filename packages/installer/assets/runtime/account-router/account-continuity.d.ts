import { type OpaqueAccountId } from "./types";
export type Sha256 = `sha256:${string}`;
export type ConfigFieldPath = readonly string[];
export type CapabilityRelativePath = string;
/** TOML's scalar grammar, represented without JavaScript precision loss. */
export type TomlScalarV1 = {
    type: "string";
    value: string;
} | {
    type: "boolean";
    value: boolean;
} | {
    type: "integer";
    value: string;
} | {
    type: "float";
    value: string;
} | {
    type: "datetime";
    kind: "offset-date-time" | "local-date-time" | "local-date" | "local-time";
    value: string;
};
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
export declare const DEFAULT_ACCOUNT_CONTINUITY_SCHEMA_V1: AccountContinuitySchemaV1;
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
    readonly nativeHomeIdentity: {
        readonly device: number;
        readonly inode: number;
    };
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
export declare const ACCOUNT_SCOPED_CAPABILITY_MUTATION_METHODS_V1: Set<"config/batchWrite" | "config/mcpServer/reload" | "config/value/write" | "experimentalFeature/enablement/set" | "marketplace/add" | "marketplace/remove" | "marketplace/upgrade" | "plugin/install" | "plugin/uninstall" | "skills/config/write" | "skills/extraRoots/set">;
export declare const ACCOUNT_LOCAL_OAUTH_MUTATION_METHOD_V1: "mcpServer/oauth/login";
export declare function isAccountScopedCapabilityMutationV1(method: string): boolean;
/** Parse TOML 1.0 through a CST parser, preserving source bytes and layout ranges. */
export declare function parseLosslessTomlDocument(source: string): LosslessTomlDocument;
export declare function readLosslessTomlDocument(path: string): LosslessTomlDocument;
/** Project only classified static configuration and safe capability files from primary. */
export declare function projectPrimarySharedBase(toml: LosslessTomlDocument, capabilities: CapabilityTreeSnapshotV1, schema: AccountContinuitySchemaV1): SharedAccountBaseV1;
/**
 * Resolve a typed shared base plus explicit overrides.  `currentLocal` only
 * contributes always-local/unknown fields; shareable current fields must be
 * captured into an override before this function is used for a write.
 */
export declare function resolveAccountConfig(input: {
    readonly shared: SharedConfigBaseV1;
    readonly overrides: AccountConfigOverridesV1;
    readonly currentLocal: LosslessTomlDocument;
    readonly plugins: SharedPluginsManifestV1;
    readonly schema?: AccountContinuitySchemaV1;
}): ResolvedAccountConfigV1;
/** Scan only the four declared capability roots without following links. */
export declare function scanCapabilityTree(root: string): CapabilityTreeSnapshotV1;
/** Resolve immutable shared bytes plus copy-on-write account payloads. */
export declare function resolveAccountCapabilities(input: {
    readonly shared: SharedCapabilityManifestV1;
    readonly overrides: AccountCapabilityOverridesV1;
    readonly currentLocalRoot: string;
}): ResolvedAccountCapabilitiesV1;
/** Load and hydrate the latest immutable shared base from manager-private state. */
export declare function loadSharedAccountBase(stateRoot: string): SharedAccountBaseV1 | null;
/** Load one account's typed config sidecar. */
export declare function loadAccountConfigOverrides(stateRoot: string, account: AccountContinuityAccountV1): AccountConfigOverridesV1 | null;
/** Load one account's capability sidecar and bind it to its private payload directory. */
export declare function loadAccountCapabilityOverrides(stateRoot: string, account: AccountContinuityAccountV1): AccountCapabilityOverridesV1 | null;
/**
 * Atomically advance the shared primary generation after its child has closed.
 * It only writes manager-private state; account homes are never changed here.
 */
export declare function publishPrimarySharedBaseAfterExit(input: PublishPrimarySharedBaseInputV1): PublishPrimarySharedBaseResultV1;
/**
 * Seal an inventory copied from a primary native home.  It never follows a
 * pre-existing cache link and does not import credentials or mutable state.
 */
export declare function bootstrapSharedPluginsManifest(stateRoot: string, primaryCodexHome: string, generation?: number, apply?: boolean, expectedPrior?: Sha256, expectedCandidate?: Sha256, faultAt?: "during_copy"): SharedPluginsManifestV1 | null;
/** Load and validate the native-capable sealed plugin inventory. Empty is valid. */
export declare function loadSharedPluginsManifestV1(stateRoot: string): SharedPluginsManifestV1 | null;
/** Publish primary native plugin changes only at the proven absent-child boundary. */
export declare function publishPrimaryPluginInventoryAfterExit(input: {
    stateRoot: string;
    account: AccountContinuityAccountV1;
    prior: SharedPluginsManifestV1;
    writeEvidence?: AccountConfigPrepareInputV1["writeEvidence"];
}): SharedPluginsManifestV1 | null;
/** Read the donor bound to the current shared manifests. Legacy bootstrap receipts bind primary as their historical donor. */
export declare function loadAccountContinuitySharedSourceProvenanceV1(stateRoot: string): AccountContinuitySharedSourceProvenanceV1;
/**
 * Bootstrap is conservative: every pre-existing shareable value/file becomes
 * an account-local set override, including primary.  It never chooses between
 * two divergent local values; only missing paths later inherit the base.
 */
export declare function bootstrapAccountContinuity(input: AccountContinuityBootstrapInputV1): AccountContinuityBootstrapResultV1;
/**
 * Retire one stale donor snapshot only while BOTH global manifests are still
 * prior. Restore journaled capture sidecars, never account files or published
 * generations. The unchanged intent makes an interrupted restoration resumable;
 * its final rename retains all before/after evidence for review.
 */
export declare function abortUnpublishedSharedSourceRebase(input: AbortUnpublishedSharedSourceRebaseInputV1): AbortUnpublishedSharedSourceRebaseResultV1;
/**
 * Preview or apply a bounded donor change for an existing continuity state.
 * The donor is observed only; non-donor materialized homes are captured at an
 * absent-child boundary before their sidecars are rebased to the new generation.
 */
export declare function rebaseAccountContinuitySharedSource(input: RebaseAccountContinuitySharedSourceInputV1): RebaseAccountContinuitySharedSourceResultV1;
/**
 * Add a newly enrolled account without rewriting an existing shared base or
 * any existing account's sidecars. Its current shareable values become
 * explicit copy-on-write overrides, so enrollment cannot silently adopt
 * another account's policy.
 */
export declare function ensureAccountContinuityEnrollment(input: EnsureAccountContinuityEnrollmentInputV1): EnsureAccountContinuityEnrollmentResultV1;
/** Exposed for focused tests and integrations that need a no-write candidate. */
export declare function renderResolvedAccountToml(current: LosslessTomlDocument, effective: TomlTableV1, inheritedPaths?: readonly ConfigFieldPath[]): string;
export declare function prepareAccountConfigBeforeSpawn(input: AccountConfigPrepareInputV1): AccountConfigMaterializationV1;
/**
 * Recognize an already-effective native home without materializing it. Two
 * coherent observations bind the signed home, private inputs and artifacts.
 * Only the broker-private completion receipt may be written, even with apply.
 */
export declare function observeExistingNativeAccountContinuity(input: AccountNativeBaselineInputV1): AccountConfigMaterializationV1;
/** Capture native edits since enrollment before inheritance has ever been applied. */
export declare function captureUnmaterializedNativeChangesBeforeSpawn(input: AccountNativeCaptureInputV1): AccountNativeCaptureResultV1;
/** Validate only an already-completed receipt and exact materialized artifacts. */
export declare function validateAccountContinuityMaterialization(stateRoot: string, opaqueAccountId: OpaqueAccountId): boolean;
/**
 * Capture one closed child's config changes. The caller retains its account
 * spawn lease; this function never edits config.toml and only advances the
 * account-private override receipt.
 */
export declare function captureAccountConfigAfterExit(input: AccountConfigCaptureInputV1): AccountConfigCaptureResultV1;
/** Capture capability edits after a child closes, storing payloads before the sidecar references them. */
export declare function captureAccountCapabilitiesAfterExit(input: AccountCapabilityCaptureInputV1): AccountCapabilityCaptureResultV1;
/**
 * Import an official/native app's edits after its home is proven idle and
 * before the broker materializes the next launch. Unchanged artifacts can be
 * rematerialized against a newer base. Changed artifacts are compared only to
 * their exact persisted expectation and become explicit account overrides.
 */
export declare function captureIdleAccountChangesBeforeSpawn(input: IdleAccountChangesCaptureInputV1): IdleAccountChangesCaptureResultV1;
export {};
