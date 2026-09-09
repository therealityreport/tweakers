export declare const ACCOUNTS_PREFERENCES_FILE = "accounts-preferences.v1.json";
export interface AccountsPreferencesV1 {
    failoverMode: "automatic" | "ask";
    unifiedCatalogEnabled: boolean;
}
export declare const DEFAULT_ACCOUNTS_PREFERENCES: Readonly<AccountsPreferencesV1>;
export declare function isAccountsPreferences(value: unknown): value is AccountsPreferencesV1;
export declare function isAccountsPreferencesPatch(value: unknown): value is Partial<AccountsPreferencesV1>;
/** The elected broker is the only writer; reading never creates registration. */
export declare class AccountsPreferencesStore {
    private readonly root;
    private current;
    constructor(root: string);
    snapshot(): AccountsPreferencesV1;
    update(patch: Partial<AccountsPreferencesV1>): AccountsPreferencesV1;
    private read;
}
