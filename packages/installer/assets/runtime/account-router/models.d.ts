import { type OpaqueAccountId } from "./types";
export declare const MODEL_CATALOG_TTL_MS: number;
export declare const MODEL_CATALOG_MAX_BYTES: number;
export declare const MODEL_CATALOG_MAX_CONCURRENCY = 4;
export interface AccountModelSupportV1 {
    native: boolean;
    eligible: Set<OpaqueAccountId>;
    unsupported: Set<OpaqueAccountId>;
}
export declare class AccountModelCatalogsV1 {
    private readonly fetchCatalog;
    private readonly now;
    private readonly cache;
    private readonly inFlight;
    constructor(fetchCatalog: (account: OpaqueAccountId) => Promise<unknown>, now?: () => number);
    support(model: string, accounts: readonly OpaqueAccountId[]): Promise<AccountModelSupportV1>;
    private catalog;
}
export declare function requestedModelFromParamsV1(params: unknown): string | null;
export declare function parseModelCatalogV1(value: unknown): Set<string> | null;
