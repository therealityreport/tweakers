/** The reviewed Accounts hooks carried by a derived desktop payload. */
export const ACCOUNTS_NATIVE_REQUIRED_HOOKS = [
  "account-menu", "profile", "apps-plugins", "mcp", "usage", "thread-summary",
  "query-scopes", "signal-query-scopes", "mutation-scopes", "native-browser-home", "native-browser-consumers", "native-project-state", "http-requests", "config-scopes", "requests", "profile-query", "usage-query", "reset-read", "reset-consume",
] as const;

export interface AccountsNativeCompatibilityRecordV1 {
  version: 1;
  bridgeVersion: 1;
  status: "compatible" | "unavailable";
  build: string;
  hooks: string[];
  hookSetSha256: string;
  assets: Array<{ path: string; sha256: string }>;
  reason?: string;
}

export interface AccountsNativeCompatibilityStatusV1 {
  compatible: boolean;
  reason: string | null;
  hookSetSha256: string | null;
  build: string | null;
}

/**
 * Recheck the actual payload at preparation, startup and enable time. Callers
 * supply their own contained reader so this contract works in both Node and
 * Electron's ASAR filesystem without copying a second verifier.
 */
export function validateAccountsNativeCompatibility(
  value: unknown,
  readAsset: (path: string) => string,
  hash: (source: string) => string,
): AccountsNativeCompatibilityStatusV1 {
  const unavailable = (reason: string): AccountsNativeCompatibilityStatusV1 => ({
    compatible: false, reason, hookSetSha256: null, build: null,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable("Accounts requires a compatible desktop refresh.");
  const record = value as Partial<AccountsNativeCompatibilityRecordV1>;
  if (record.version !== 1 || record.bridgeVersion !== 1 || record.status !== "compatible") {
    return unavailable("This desktop build does not provide the required Accounts integration.");
  }
  if (typeof record.build !== "string" || !/^[0-9][0-9.]{1,63}$/.test(record.build)
    || !Array.isArray(record.hooks) || record.hooks.length !== ACCOUNTS_NATIVE_REQUIRED_HOOKS.length
    || [...record.hooks].sort().join("\0") !== [...ACCOUNTS_NATIVE_REQUIRED_HOOKS].sort().join("\0")
    || typeof record.hookSetSha256 !== "string" || record.hookSetSha256 !== hash(JSON.stringify(record.hooks))
    || !Array.isArray(record.assets) || record.assets.length !== 8) {
    return unavailable("The Accounts compatibility record is incomplete.");
  }
  const paths = new Set<string>();
  for (const asset of record.assets) {
    if (!asset || typeof asset.path !== "string" || !/^(?:webview\/assets\/[A-Za-z0-9._-]+|\.vite\/build\/(?:main|src)-[A-Za-z0-9_-]+)\.js$/.test(asset.path)
      || paths.has(asset.path) || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      return unavailable("The Accounts compatibility record contains an invalid asset.");
    }
    paths.add(asset.path);
    try {
      if (hash(readAsset(asset.path)) !== asset.sha256) return unavailable("Desktop files changed after Accounts was prepared. Refresh Tweakers to restore Accounts.");
    } catch {
      return unavailable("A required Accounts desktop file is unavailable.");
    }
  }
  const expectedFamilies = ["app-initial", "app-primary", "profile", "plugins-page", "mcp-settings", "local-conversation-thread"];
  if (expectedFamilies.some((family) => record.assets!.filter((asset) =>
    new RegExp(`^webview/assets/${family}-[a-f0-9]+\\.js$`).test(asset.path)).length !== 1)) {
    return unavailable("A required Accounts component is missing from its compatibility record.");
  }
  if (["main", "src"].some((family) => record.assets!.filter((asset) => new RegExp(`^\\.vite/build/${family}-[A-Za-z0-9_-]+\\.js$`).test(asset.path)).length !== 1)) {
    return unavailable("A required native Accounts browser helper is missing.");
  }
  return { compatible: true, reason: null, hookSetSha256: record.hookSetSha256, build: record.build };
}
