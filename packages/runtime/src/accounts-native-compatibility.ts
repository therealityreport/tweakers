import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateAccountsNativeCompatibility, type AccountsNativeCompatibilityStatusV1 } from "@therealityreport/tweakers-sdk";

export const ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL = "tweaker:accounts-native-compatibility";

/** Electron's filesystem reads ASAR entries without extracting or changing it. */
export function readAccountsNativeCompatibility(asarRoot: string): AccountsNativeCompatibilityStatusV1 {
  try {
    const pkg = JSON.parse(readFileSync(join(asarRoot, "package.json"), "utf8"));
    return validateAccountsNativeCompatibility(pkg?.__tweaker?.accountsNative,
      (path) => readFileSync(join(asarRoot, path), "utf8"),
      (source) => createHash("sha256").update(source).digest("hex"));
  } catch {
    return { compatible: false, reason: "Accounts requires a compatible desktop refresh.", hookSetSha256: null, build: null };
  }
}
