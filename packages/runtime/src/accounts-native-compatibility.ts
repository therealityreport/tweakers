import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateAccountsNativeCompatibility, type AccountsNativeCompatibilityStatusV1 } from "@therealityreport/tweakers-sdk";

export const ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL = "tweaker:accounts-native-compatibility";

let cached: { key: string; status: AccountsNativeCompatibilityStatusV1 } | null = null;

/** Electron's filesystem reads ASAR entries without extracting or changing it. */
export function readAccountsNativeCompatibility(asarRoot: string): AccountsNativeCompatibilityStatusV1 {
  try {
    const stat = statSync(asarRoot);
    const key = `${asarRoot}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (cached?.key === key) return cached.status;
    const pkg = JSON.parse(readFileSync(join(asarRoot, "package.json"), "utf8"));
    const status = validateAccountsNativeCompatibility(pkg?.__tweaker?.accountsNative,
      (path) => readFileSync(join(asarRoot, path), "utf8"),
      (source) => createHash("sha256").update(source).digest("hex"));
    cached = { key, status };
    return status;
  } catch {
    return { compatible: false, reason: "Accounts requires a compatible desktop refresh.", hookSetSha256: null, build: null };
  }
}
