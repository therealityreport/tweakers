import { type AccountsNativeCompatibilityStatusV1 } from "@therealityreport/tweakers-sdk";
export declare const ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL = "tweaker:accounts-native-compatibility";
/** Electron's filesystem reads ASAR entries without extracting or changing it. */
export declare function readAccountsNativeCompatibility(asarRoot: string): AccountsNativeCompatibilityStatusV1;
