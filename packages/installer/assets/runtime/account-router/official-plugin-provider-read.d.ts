import type { IncomingHttpHeaders } from "node:http";
import type { OfficialPluginProviderReplyV1 } from "./official-plugin-service-controller";
export interface OfficialPluginProviderCredentialsV1 {
    accessToken: string;
    chatgptAccountId: string;
}
/** Same actor, exact bearer. Credentials and their hashes never leave this private owner. */
export declare function officialPluginAuthorizationMatchesV1(headers: IncomingHttpHeaders, credentials: OfficialPluginProviderCredentialsV1): boolean;
/** Read-only same-origin service metadata, with the child's original upstream trust. */
export declare function readOfficialPluginProviderV1(input: {
    upstreamBaseUrl: string;
    path: string;
    query: URLSearchParams;
    signal: AbortSignal;
    credentials: () => OfficialPluginProviderCredentialsV1;
    caEnvironment?: NodeJS.ProcessEnv;
}): Promise<OfficialPluginProviderReplyV1>;
