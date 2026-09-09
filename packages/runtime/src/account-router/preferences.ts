import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateRegularFile, writePrivateJsonAtomicBounded } from "./state-store";
import { isPlainRecord } from "./types";

export const ACCOUNTS_PREFERENCES_FILE = "accounts-preferences.v1.json";
export interface AccountsPreferencesV1 {
  failoverMode: "automatic" | "ask";
  unifiedCatalogEnabled: boolean;
}
export const DEFAULT_ACCOUNTS_PREFERENCES: Readonly<AccountsPreferencesV1> = Object.freeze({
  failoverMode: "automatic",
  unifiedCatalogEnabled: false,
});

export function isAccountsPreferences(value: unknown): value is AccountsPreferencesV1 {
  return isPlainRecord(value)
    && Object.keys(value).sort().join("\0") === "failoverMode\0unifiedCatalogEnabled"
    && (value.failoverMode === "automatic" || value.failoverMode === "ask")
    && typeof value.unifiedCatalogEnabled === "boolean";
}

export function isAccountsPreferencesPatch(value: unknown): value is Partial<AccountsPreferencesV1> {
  return isPlainRecord(value) && Object.keys(value).length > 0
    && Object.keys(value).every((key) => key === "failoverMode" || key === "unifiedCatalogEnabled")
    && (!("failoverMode" in value) || value.failoverMode === "automatic" || value.failoverMode === "ask")
    && (!("unifiedCatalogEnabled" in value) || typeof value.unifiedCatalogEnabled === "boolean");
}

/** The elected broker is the only writer; reading never creates registration. */
export class AccountsPreferencesStore {
  private current: AccountsPreferencesV1;
  constructor(private readonly root: string) {
    this.current = this.read();
  }

  snapshot(): AccountsPreferencesV1 { return { ...this.current }; }

  update(patch: Partial<AccountsPreferencesV1>): AccountsPreferencesV1 {
    if (!isAccountsPreferencesPatch(patch)) throw new Error("invalid Accounts preferences");
    // Detect an external edit instead of silently replacing it from stale memory.
    if (JSON.stringify(this.read()) !== JSON.stringify(this.current)) throw new Error("Accounts preferences changed outside their owner");
    const next = { ...this.current, ...patch };
    writePrivateJsonAtomicBounded(this.root, ACCOUNTS_PREFERENCES_FILE, { version: 1, ...next }, 4_096);
    this.current = next;
    return this.snapshot();
  }

  private read(): AccountsPreferencesV1 {
    const path = join(this.root, ACCOUNTS_PREFERENCES_FILE);
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_ACCOUNTS_PREFERENCES };
      throw error;
    }
    assertPrivateRegularFile(path, 4_096);
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isPlainRecord(value) || value.version !== 1) throw new Error("invalid Accounts preferences version");
    const { version: _version, ...preferences } = value;
    if (!isAccountsPreferences(preferences)) throw new Error("invalid Accounts preferences");
    return { failoverMode: preferences.failoverMode, unifiedCatalogEnabled: preferences.unifiedCatalogEnabled };
  }
}
