import { type OpaqueAccountId } from "./types";
type NativeProjectRequest = (account: OpaqueAccountId, method: string, params: Record<string, unknown>) => Promise<unknown | null>;
/** A small native project-ID mapping; never contains transcripts, thread IDs, or profile data. */
export declare class NativeProjectLinksV1 {
    private readonly root;
    private readonly metadataAccountId;
    private readonly secret;
    private readonly request;
    private readonly links;
    private failed;
    private readonly inFlight;
    constructor(root: string, metadataAccountId: OpaqueAccountId, secret: Buffer, request: NativeProjectRequest);
    projectForAccount(sourceProjectId: string, account: OpaqueAccountId): string | null;
    publicProjectId(account: OpaqueAccountId, nativeProjectId: string): string | null;
    ensureProjectForAccount(sourceProjectId: string, account: OpaqueAccountId): Promise<string | null>;
    private ensure;
    private persist;
}
export {};
