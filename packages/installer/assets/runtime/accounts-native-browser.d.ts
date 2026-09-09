import type { AccountsNativeCompatibilityStatusV1 } from "@therealityreport/tweakers-sdk";
interface NativeBrowserContext {
    version: 1;
    status: "ready";
    opaqueAccountId: string;
    codexHome: string;
    configFile: string;
    appServerVersion: string;
}
interface NativeBrowserBridge {
    version: number;
    hookSetSha256: string;
    create(input: {
        codexHome: string;
        appServerVersion: string;
        assertCurrent(): void;
        request(method: string, params: unknown): Promise<unknown>;
    }): {
        sync(): Promise<unknown>;
        install(params: unknown): Promise<unknown>;
        uninstall(params: unknown): Promise<unknown>;
    };
}
export interface AccountsNativeBrowserDependencies {
    isCurrent(): boolean;
    compatibility(): AccountsNativeCompatibilityStatusV1;
    bridge(): NativeBrowserBridge | undefined;
    context(accountId: string): Promise<NativeBrowserContext | null>;
    request(accountId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}
export declare function invokeAccountsNativeBrowserAction(input: {
    accountId: string;
    opaqueAccountId: string;
    method: string;
    params: Record<string, unknown>;
}, deps: AccountsNativeBrowserDependencies): Promise<{
    ok: true;
}>;
export {};
