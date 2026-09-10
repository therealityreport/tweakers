import type { AccountsNativeApi, AccountsNativeRequestSurface, AccountsNativeSelection, AccountsNativeSlotSurface, AccountsNativeStatus } from "@therealityreport/tweakers-sdk";
export interface AccountsNativeTransport {
    initialize(value: {
        version: 1;
        hookSetSha256: string;
    }): boolean;
    status(): AccountsNativeStatus;
    snapshot(surface: AccountsNativeSlotSurface): AccountsNativeSelection;
    subscribe(handler: (event: {
        surface: AccountsNativeSlotSurface | null;
        generation: number;
    }) => void): () => void;
    project(surface: AccountsNativeRequestSurface, kind: string, input: unknown): unknown;
    request(surface: AccountsNativeRequestSurface, method: string, params: Readonly<Record<string, unknown>>, selection: AccountsNativeSelection): Promise<unknown>;
}
export interface AccountsNativeBridgeController {
    api: AccountsNativeApi;
    transport: AccountsNativeTransport;
    setCompatibility(status: {
        compatible: boolean;
        reason?: string;
        hookSetSha256?: string | null;
    }): void;
    dispose(): void;
}
/**
 * Creates the isolated-world half of the Accounts native bridge. The exposed
 * transport accepts and returns data only; the parent main-world wrapper owns
 * native React elements and falls back before calling this bridge when its
 * compatibility receipt is not current.
 */
export declare function createAccountsNativeBridge(): AccountsNativeBridgeController;
export declare const accountsNativeBridge: AccountsNativeBridgeController;
export declare const accountsNativeApi: AccountsNativeApi;
export declare const accountsNativeTransport: AccountsNativeTransport;
