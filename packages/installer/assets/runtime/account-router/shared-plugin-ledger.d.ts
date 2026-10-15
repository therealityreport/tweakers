import { readOfficialInstalledPluginSnapshotV1, type AccountContinuityAccountV1, type AccountContinuityWriteEvidenceV1 } from "./account-continuity";
export declare const SHARED_PREPARATION_STAGES_V1: readonly ["parent-authority", "generation-lease", "worker-runtime", "sealed-generation", "native-source", "execution-layout", "account-receipt", "account-payload", "account-catalogue", "publication", "cancelled", "prior-auth", "parent-admission", "post-projection", "resolver-binary", "spawn", "child-session", "client-session", "handoff", "ledger-service", "service-invalid", "home-auth", "helper-busy", "account-excluded"];
export type SharedPreparationStageV1 = typeof SHARED_PREPARATION_STAGES_V1[number];
export declare function sharedPreparationStageV1(value: unknown): SharedPreparationStageV1 | undefined;
export declare class SharedPreparationErrorV1 extends Error {
    readonly preparationStage: SharedPreparationStageV1;
    constructor(preparationStage: SharedPreparationStageV1);
}
export declare const sharedPluginDescriptorResponseDigestV1: (response: unknown) => string;
export interface SharedPluginAuthorityV1 {
    sourceAccountId: string;
    sourceRootIdentity: string;
    modeFingerprint: string;
}
export interface SharedPluginDescriptorProvenanceV1 {
    kind: "selected-account-detail";
    actor: string;
    authIdentity: string;
    sessionStamp: string;
    /** Digest of the real response, before allowlisting; no response credentials are retained. */
    responseDigest: string;
}
export interface SharedPluginRemoteDescriptorV1 {
    remoteId: string;
    scope: "GLOBAL" | "USER" | "WORKSPACE";
    discoverability?: "LISTED" | "PRIVATE" | "UNLISTED";
    installationPolicy: "AVAILABLE" | "NOT_AVAILABLE" | "INSTALLED_BY_DEFAULT";
    authenticationPolicy: "ON_INSTALL" | "ON_USE";
    mustShowInstallationInterstitial?: boolean;
    release: Record<string, unknown> & {
        version: string;
        display_name: string;
        description: string;
        interface: Record<string, unknown>;
        app_ids: string[];
        mcp_servers: Array<{
            key: string;
        }>;
        skills: Array<{
            name: string;
            description: string;
            interface: unknown;
        }>;
    };
    provenance: SharedPluginDescriptorProvenanceV1;
}
export interface SharedPluginEntryV1 {
    id: string;
    version: string;
    packageDigest: string;
    /** Metadata receipt only. Its actor is never authorization for another account. */
    remote?: SharedPluginRemoteDescriptorV1;
}
export interface SharedPluginLedgerV1 {
    version: 1;
    authority: SharedPluginAuthorityV1;
    generation: number;
    prior: string | null;
    projectionMode: "canonical-v1" | "local-library-v1";
    sourceSnapshotFingerprint: string;
    /** Absent legacy policies remain readable for recovery, never executable. */
    definitionPolicyFingerprint?: string;
    /** Canonical native IDs; only fixed public reasons, never source values. */
    withheldPlugins?: Record<string, string>;
    entries: SharedPluginEntryV1[];
    fingerprint: string;
}
export declare function sharedPluginWithheldReasonV1(error: unknown): string | null;
interface SharedPluginPublicationV1 {
    expected: string | null;
    sourceSnapshotFingerprint?: string;
    packages: readonly {
        id: string;
        version: string;
        source: string;
        remote?: SharedPluginRemoteDescriptorV1;
    }[];
    withheldPlugins?: Record<string, string>;
    authorize: () => boolean;
}
export interface SharedPluginInstallTicketV1 {
    nonce: string;
    actor: string;
    childStamp: string;
    authIdentity: string;
    sessionStamp: string;
    rendererRef: string;
    approvalId: string;
    installAttemptId: string;
    pluginId: string;
    remoteId?: string;
    generation: number;
    ledgerFingerprint: string;
    expiresAt: number;
}
/** Real upstream marker has only these two fields; no ID can be inferred from names. */
export declare function readSharedPluginRemoteIdentityV1(packageRoot: string): string;
/** Keep only real nonsecret descriptor fields; provider availability/auth state is not stored. */
export declare function parseSharedPluginRemoteDescriptorV1(id: string, version: string, remoteId: string, response: unknown, provenance: SharedPluginDescriptorProvenanceV1): SharedPluginRemoteDescriptorV1;
export declare class SharedPluginLedgerStoreV1 {
    private readonly input;
    readonly root: string;
    private readonly tickets;
    private readonly sourceWatchers;
    private readonly sourceVersionRoots;
    private sourceRevision;
    private sourceWatchFailed;
    private closed;
    private sourceLease;
    private pendingSourceProof;
    private projectionTail;
    private activeProjection;
    constructor(input: {
        root: string;
        sourceHome: string;
        secret: Buffer;
        authority: SharedPluginAuthorityV1;
        localLibrary?: boolean;
    });
    close(): void;
    private sourceChangeRelevant;
    private sourceIdentity;
    /** Full source proof; one queued-change race may require one fresh proof. */
    readNativeSnapshot(): Promise<ReturnType<typeof readOfficialInstalledPluginSnapshotV1>>;
    validateSourceLease(ledger: SharedPluginLedgerV1): Promise<void>;
    /** Signed/durable generation fence, never hashes source or sealed trees. */
    verifyGeneration(fingerprint: string): boolean;
    private sign;
    private verify;
    read(): SharedPluginLedgerV1 | null;
    private readSignedGeneration;
    packagePath(entry: Pick<SharedPluginEntryV1, "packageDigest">): string;
    /** Caller proves current actor and absence of package writers immediately before every publication. */
    publish(input: SharedPluginPublicationV1): SharedPluginLedgerV1;
    private publishLocked;
    issueTicket(input: Omit<SharedPluginInstallTicketV1, "nonce" | "generation" | "ledgerFingerprint">): SharedPluginInstallTicketV1;
    cancelTicket(nonce: string): void;
    validateTicket(ticket: SharedPluginInstallTicketV1, current: Pick<SharedPluginInstallTicketV1, "actor" | "childStamp" | "authIdentity" | "sessionStamp" | "rendererRef" | "approvalId" | "installAttemptId" | "pluginId">): boolean;
    /** Read-only proof for a bounded native-owned library; never repairs or projects. */
    verifyAccountProjection(input: {
        stateRoot: string;
        account: string;
        home: string;
        ids: readonly string[];
    }): Array<{
        id: string;
        version: string;
    }>;
    /** A process-local worker lease, never a durable recovery or HTTP authority. */
    ownsPendingProjection(stateRoot: string, account: string): boolean;
    /** Keep full package proofs and durable copies off the broker's RPC event loop. */
    projectAsync(input: {
        stateRoot: string;
        account: AccountContinuityAccountV1;
        writeEvidence: AccountContinuityWriteEvidenceV1;
        authorize: () => boolean;
    }): Promise<void>;
    /** Signed receipt reconciliation for native local-cache version normalization; never modifies package bytes. */
    private reconcileLocalProjectionLayout;
    project(input: {
        stateRoot: string;
        account: AccountContinuityAccountV1;
        writeEvidence: AccountContinuityWriteEvidenceV1;
        authorize: () => boolean;
        expectedFingerprint?: string;
        onPreparationStage?: (stage: SharedPreparationStageV1) => void;
    }): void;
    /** Definition snapshot only; account provider availability must be supplied from that account. */
    installedSnapshot(ledgerFingerprint: string, policy: (id: string) => boolean, provider: (remoteId: string) => {
        status: string;
        disabled_reason?: unknown;
    } | null, verifiedGenerationOnly?: boolean): unknown;
    assertNativeRevision(ledger: SharedPluginLedgerV1): void;
    private assertNativeRemoteIdentities;
    private assertDefinitionPolicy;
}
/** Internal worker entry; no account process is launched here. */
export declare function runSharedPluginProjectionWorkerV1(input: {
    store: ConstructorParameters<typeof SharedPluginLedgerStoreV1>[0];
    stateRoot: string;
    account: AccountContinuityAccountV1;
    writeEvidence: AccountContinuityWriteEvidenceV1;
    fingerprint: string;
    cancellation: Int32Array;
}): Promise<void>;
export {};
