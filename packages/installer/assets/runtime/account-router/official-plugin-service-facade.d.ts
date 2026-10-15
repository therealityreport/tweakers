import { type IncomingHttpHeaders } from "node:http";
export interface OfficialPluginServiceFacadeOptions {
    root: string;
    upstreamBaseUrl: string;
    sessionStamp: () => string | null;
    authorize: (headers: IncomingHttpHeaders) => boolean;
    /** Headers (including authorization) are deliberately absent from this boundary. */
    intercept: (request: {
        method: string;
        path: string;
        query: URLSearchParams;
        body: Buffer;
    }, signal: AbortSignal) => Promise<{
        status: number;
        headers?: Record<string, string>;
        body: Buffer | string;
    } | null>;
    caEnvironment?: NodeJS.ProcessEnv;
    /** Fixture port only; production always uses an ephemeral listener. */
    testPorts?: {
        listen?: number;
    };
}
/** Private account-child HTTPS origin. It owns no ledger, credential storage or native files. */
export declare function startOfficialPluginServiceFacade(options: OfficialPluginServiceFacadeOptions): Promise<{
    baseUrl: string;
    caPath: string;
    childEnvironment: {
        CODEX_CA_CERTIFICATE: string;
    };
    close: () => Promise<boolean>;
    stats: () => {
        active: number;
        sockets: number;
        closed: boolean;
    };
}>;
