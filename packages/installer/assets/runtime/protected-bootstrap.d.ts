/**
 * The protected bootstrap is intentionally independent of the Tweakers
 * renderer/runtime.  It is the only pre-main authority used by the protected
 * shell and therefore accepts immutable candidate inputs only.  In
 * particular, it must never inspect a published selection, a running
 * app-server, a terminal transaction, or an installed canary result.
 */
export declare const PROTECTED_BOOTSTRAP_SCHEMA_VERSION: 1;
export declare const APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION: 1;
export type ProtectedUiFeatures = "off" | "on";
export type McpSafetyProvider = "managed-turn-idle" | "official-bundled-degraded";
export type ProtectedRecoveryState = "normal-protected" | "pristine-openai-recovery";
export type ProtectedBootstrapVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";
export interface ProtectedEnvironmentState {
    schemaVersion: 2;
    uiFeatures: ProtectedUiFeatures;
    mcpSafetyProvider: McpSafetyProvider;
    recoveryState: ProtectedRecoveryState;
}
/** Exact immutable bytes that may be checked before OpenAI main is loaded. */
export interface ProtectedLaunchIdentity {
    appPath: string;
    appContentsSha256: string;
    appAsarSha256: string;
    asarHeaderSha256: string;
    loaderPath: string;
    loaderSha256: string;
    metadataSha256: string;
    runtimeMainPath: string;
    runtimeMainSha256: string;
    backendPath: string;
    backendSha256: string;
    backendVersion: string;
    backendArchitecture: "arm64";
    signatureReceiptSha256: string;
    policyDigest: string;
}
/**
 * A one-use grant written only after candidate bytes are promoted.  The shape
 * intentionally has no terminal/published/PID/canary fields; adding one is a
 * temporal-cycle error, not a compatibility extension.
 */
export interface AppliedPendingLaunchGrantV1 {
    schemaVersion: typeof APPLIED_PENDING_LAUNCH_GRANT_SCHEMA_VERSION;
    kind: "applied-pending-launch-grant";
    transactionId: string;
    attempt: number;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
    authoritySha256: string;
    acceptedBuildReceiptSha256: string;
    environment: ProtectedEnvironmentState;
    identity: ProtectedLaunchIdentity;
    consumedBy: null | {
        desktopPid: number;
        desktopKernelStart: string;
        consumedAt: string;
    };
}
export interface ProtectedBootstrapPreflightReceiptV1 {
    schemaVersion: typeof PROTECTED_BOOTSTRAP_SCHEMA_VERSION;
    kind: "protected-bootstrap-preflight";
    transactionId: string;
    attempt: number;
    nonce: string | null;
    verdict: ProtectedBootstrapVerdict;
    reason: string | null;
    environment: ProtectedEnvironmentState | null;
    identitySha256: string | null;
    backend: {
        path: string;
        sha256: string;
        version: string;
        architecture: "arm64";
    } | null;
    consumedAt: string | null;
    emittedAt: string;
    /** Canonical digest consumed by the post-main transaction owner and canary. */
    receiptSha256: string;
}
export interface ProtectedBootstrapPreflightInput {
    grant: unknown;
    expectedTransactionId: string;
    expectedAttempt: number;
    desktop: {
        pid: number;
        kernelStart: string;
    };
    now?: string;
}
export interface ProtectedBootstrapDependencies {
    now(): string;
    sha256File(path: string): string;
    probeVersion(path: string): string | null;
    probeArchitecture(path: string): "arm64" | null;
    fingerprintAppContents(path: string): string;
    readAsarHeader(path: string): string;
    readAsarEntry(path: string, entry: string): Buffer;
    readSignature(path: string): string | null;
    /**
     * Must compare-and-swap the original grant and persist the consumed form
     * atomically.  Returning false means another process consumed/changed it.
     */
    consumeGrant?(expected: AppliedPendingLaunchGrantV1, consumed: AppliedPendingLaunchGrantV1): boolean;
    emit(receipt: ProtectedBootstrapPreflightReceiptV1): void;
}
/**
 * A pre-main PASS deliberately blocks every autonomous updater until a fresh
 * protected authority is prepared.  This is a headless guard: it carries no
 * UI state and is safe to call from the loader, native-update bridge, and
 * installer-owned recovery paths.
 */
export interface ProtectedUpdateQuarantineMarkerV1 {
    schemaVersion: 1;
    kind: "protected-update-quarantine";
    transactionId: string;
    attempt: number;
    preflightReceiptSha256: string;
    armedAt: string;
    normalLaunchBlockedUntilFreshAuthority: true;
}
export interface ProtectedUpdateQuarantineDependencies {
    exists(path: string): boolean;
    list(path: string): string[];
    lstat(path: string): {
        isDirectory(): boolean;
        isFile(): boolean;
        isSymbolicLink(): boolean;
    };
    read(path: string): string;
}
/**
 * The protected loader is the sole arming point.  It supplies its durable
 * authority writer so this shared guard never weakens loader write semantics.
 */
export declare function armProtectedUpdateQuarantine(input: Omit<ProtectedUpdateQuarantineMarkerV1, "schemaVersion" | "kind" | "normalLaunchBlockedUntilFreshAuthority">, write: (marker: ProtectedUpdateQuarantineMarkerV1) => void): ProtectedUpdateQuarantineMarkerV1;
/**
 * Fail closed whenever any protected transaction has armed its update
 * quarantine.  A new protected candidate is the only authority-producing
 * route; generic Sparkle, refresh, repair, and recovery must not silently
 * restore the bundled backend behind the protected shell.
 */
export declare function assertProtectedUpdateQuarantine(input: {
    authorityRoot: string;
    route: string;
}, dependencyOverrides?: Partial<ProtectedUpdateQuarantineDependencies>): void;
export declare function assertProtectedUpdateQuarantineMarker(value: unknown): asserts value is ProtectedUpdateQuarantineMarkerV1;
export declare function createAppliedPendingLaunchGrant(input: {
    transactionId: string;
    attempt: number;
    issuedAt: string;
    expiresAt: string;
    authoritySha256: string;
    acceptedBuildReceiptSha256: string;
    environment: ProtectedEnvironmentState;
    identity: ProtectedLaunchIdentity;
    nonce?: string;
}): AppliedPendingLaunchGrantV1;
/**
 * Validate and consume an exact one-use grant.  This returns a receipt for
 * every outcome so a protected loader can remain fail-closed without
 * inventing post-main proof.  A FAIL result never changes caller-owned env.
 */
export declare function runProtectedBootstrapPreflight(input: ProtectedBootstrapPreflightInput, dependencyOverrides?: Partial<ProtectedBootstrapDependencies>): ProtectedBootstrapPreflightReceiptV1;
/**
 * The protected loader calls this only after a PASS receipt.  It adds an exact
 * in-bundle backend path and deliberately has no branch that clears the value
 * or selects the official bundled backend on failure.
 */
export declare function applyProtectedBootstrapEnvironment(receipt: ProtectedBootstrapPreflightReceiptV1, inherited?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function createProtectedBootstrapPreflightReceipt(input: Omit<ProtectedBootstrapPreflightReceiptV1, "receiptSha256">): ProtectedBootstrapPreflightReceiptV1;
export declare function isProtectedBootstrapPreflightReceipt(value: unknown): value is ProtectedBootstrapPreflightReceiptV1;
export declare function preflightReceiptSha256(receipt: Omit<ProtectedBootstrapPreflightReceiptV1, "receiptSha256">): string;
export declare function protectedLaunchIdentitySha256(identity: ProtectedLaunchIdentity): string;
export declare function isAppliedPendingLaunchGrantV1(value: unknown): value is AppliedPendingLaunchGrantV1;
export declare function isProtectedEnvironmentState(value: unknown): value is ProtectedEnvironmentState;
export declare function isProtectedLaunchIdentity(value: unknown): value is ProtectedLaunchIdentity;
export declare function assertProtectedEnvironmentState(state: ProtectedEnvironmentState): void;
export declare function assertProtectedLaunchIdentity(identity: ProtectedLaunchIdentity): void;
