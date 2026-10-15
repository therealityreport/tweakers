import type { IncomingHttpHeaders } from "node:http";
import { SharedPluginLedgerStoreV1, type SharedPluginLedgerV1 } from "./shared-plugin-ledger";
export interface OfficialPluginServiceSessionV1 {
    actor: string;
    authIdentity: string;
    stamp: string;
}
export interface OfficialPluginProviderReplyV1 {
    status: number;
    value: unknown;
}
/** A private owner callback. No credentials enter the definition controller. */
export type OfficialPluginProviderReadV1 = (path: string, query: URLSearchParams, signal: AbortSignal) => Promise<OfficialPluginProviderReplyV1>;
/** Read-only native inventory and genuine version-matched provider descriptors. */
export declare function hydrateOfficialSharedPluginLedgerV1(input: {
    ledger: SharedPluginLedgerStoreV1;
    sourceHome: string;
    session: () => OfficialPluginServiceSessionV1 | null;
    readProvider: OfficialPluginProviderReadV1;
    authorize: () => boolean;
    signal?: AbortSignal;
    localLibrary?: boolean;
}): Promise<SharedPluginLedgerV1>;
export interface OfficialPluginAccountServiceV1 {
    baseUrl: string;
    childEnvironment: {
        CODEX_CA_CERTIFICATE: string;
    };
    ledgerFingerprint: string;
    /** RPC/UI plugin HTTP requests use the same installed authority as the child. */
    interceptHttp: (method: string, path: string, query: URLSearchParams, body: Buffer, signal?: AbortSignal) => Promise<OfficialPluginProviderReplyV1>;
    verify: () => boolean;
    /** Only the deferred child preparation monitor may use its owned-write allowance. */
    verifyPreparation?: () => boolean;
    close: () => Promise<boolean>;
}
/** Keep native Skills/hooks and recommendations on their canonical IDs. */
export declare function prepareOfficialPluginAccountServiceV1(input: {
    root: string;
    upstreamBaseUrl: string;
    ledger: SharedPluginLedgerStoreV1;
    session: () => OfficialPluginServiceSessionV1 | null;
    preparationSession?: () => OfficialPluginServiceSessionV1 | null;
    readProvider: OfficialPluginProviderReadV1;
    authorizeHeaders: (headers: IncomingHttpHeaders) => boolean;
    policy: (id: string) => boolean;
    caEnvironment?: NodeJS.ProcessEnv;
}): Promise<OfficialPluginAccountServiceV1>;
/** Managed config must permit the adapter before any external login is submitted. */
export declare function officialPluginEffectiveConfigMatchesV1(value: unknown, baseUrl: string): boolean;
