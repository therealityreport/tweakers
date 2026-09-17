/** Original signed documents stay byte-for-byte intact. Only this companion is new. */
export declare const PERSISTENT_IDENTITIES_FILE = "native-storage-identities.v2.json";
export declare const PERSISTENT_IDENTITIES_JOURNAL = "native-storage-identities-repair.v2.json";
type Digest = `sha256:${string}`;
export interface LegacyDirectoryIdentity {
    device: number;
    inode: number;
    uid: number;
    mode: number;
}
export interface PersistentIdentityAnchor {
    authorityFile: string;
    authorityFingerprint: Digest;
    /** Exact original bytes retained as audit evidence, including resolver version. */
    documentFingerprint: Digest;
    accountId: string | null;
    path: string;
    legacy: LegacyDirectoryIdentity;
    volumeUuid: string;
}
export interface PersistentIdentityGeneration {
    version: 2;
    kind: "account-router-persistent-directory-identities";
    generation: string;
    priorFingerprint: Digest | null;
    anchors: PersistentIdentityAnchor[];
    signature: string;
}
export interface PreparedPersistentIdentities {
    priorFingerprint: Digest | null;
    next: PersistentIdentityGeneration;
}
export declare function parsePersistentIdentityGeneration(value: unknown, secret: Buffer): PersistentIdentityGeneration;
export declare function readPersistentIdentityGeneration(stateRoot: string, secret: Buffer): {
    document: PersistentIdentityGeneration;
    fingerprint: Digest;
} | null;
/** Native API access is synchronous and does not spawn a process on each history read. */
export declare function nativeVolumeUuid(path: string): string;
/** Caller must first validate the original authority's signature and account/path binding. */
export declare function matchesPersistentDirectoryIdentity(input: {
    stateRoot: string;
    secret: Buffer;
    path: string;
    expected: LegacyDirectoryIdentity;
    authorityFile: string;
    accountId?: string | null;
}): boolean;
/** Pure preparation. Only successful production validation can produce a signed proposal. */
export declare function preparePersistentIdentityGeneration(input: {
    stateRoot: string;
    secret: Buffer;
    verify(): boolean;
    allowLegacyDeviceChange?: boolean;
    /** Explicit test seam; production resolves volume UUID through the packaged native host. */
    volumeUuid?: (path: string) => string;
    /** Internal enrollment recovery only: caller verified a signed intent containing prior volume UUIDs. */
    verifiedLegacyAuthorities?: readonly string[];
}): PreparedPersistentIdentities;
export declare function persistentIdentityProposalFingerprint(proposal: PreparedPersistentIdentities): Digest;
/** Caller owns exclusive broker/metadata lifecycle. Replays accept only recorded prior or next. */
export declare function publishPersistentIdentityGeneration(stateRoot: string, secret: Buffer, proposal: PreparedPersistentIdentities): Digest;
/** Validate a replay without writing or changing the active generation. */
export declare function validatePersistentIdentityProposal(stateRoot: string, secret: Buffer, value: unknown): PreparedPersistentIdentities;
/** Offline metadata writers share Doctor's interruption-safe publication format. */
export declare function journalAndPublishPersistentIdentityGeneration(stateRoot: string, secret: Buffer, proposal: PreparedPersistentIdentities): void;
/** Restore only the recorded predecessor while the repair owner holds its socket. */
export declare function restorePriorPersistentIdentityGeneration(stateRoot: string, secret: Buffer, proposal: PreparedPersistentIdentities): void;
export {};
