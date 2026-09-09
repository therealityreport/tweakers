import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
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
  }): { sync(): Promise<unknown>; install(params: unknown): Promise<unknown>; uninstall(params: unknown): Promise<unknown> };
}

export interface AccountsNativeBrowserDependencies {
  isCurrent(): boolean;
  compatibility(): AccountsNativeCompatibilityStatusV1;
  bridge(): NativeBrowserBridge | undefined;
  context(accountId: string): Promise<NativeBrowserContext | null>;
  request(accountId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
}

// Native browser registration spans an account home and a device registry.
// Serialize it across windows/accounts, while retaining each captured account.
let pendingBrowserAction: Promise<unknown> = Promise.resolve();

export async function invokeAccountsNativeBrowserAction(
  input: { accountId: string; opaqueAccountId: string; method: string; params: Record<string, unknown> },
  deps: AccountsNativeBrowserDependencies,
): Promise<{ ok: true }> {
  const action = pendingBrowserAction.catch(() => {}).then(async () => {
    const compatibility = deps.compatibility();
    const bridge = deps.bridge();
    if (!deps.isCurrent() || !compatibility.compatible || !bridge || bridge.version !== 1
      || bridge.hookSetSha256 !== compatibility.hookSetSha256) throw new Error("Accounts browser integration is unavailable.");
    const context = await deps.context(input.accountId);
    if (!context || context.version !== 1 || context.status !== "ready" || context.opaqueAccountId !== input.opaqueAccountId
      || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(context.appServerVersion)
      || context.codexHome !== realpathSync(context.codexHome) || context.configFile !== join(context.codexHome, "config.toml")) throw new Error("The selected account browser binding is unavailable.");
    const home = lstatSync(context.codexHome, { bigint: true });
    const assertCurrent = () => {
      if (!deps.isCurrent() || deps.bridge() !== bridge) throw new Error("The Accounts action is no longer active.");
      const current = lstatSync(context.codexHome, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== home.dev || current.ino !== home.ino
        || current.uid !== BigInt(process.getuid!()) || (current.mode & 0o022n) !== 0n) throw new Error("The selected account home changed.");
      try {
        const config = lstatSync(context.configFile, { bigint: true });
        if (!config.isFile() || config.isSymbolicLink() || config.uid !== current.uid || (config.mode & 0o022n) !== 0n) throw new Error("The selected account configuration is unsafe.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    assertCurrent();
    const request = async (method: string, params: unknown) => {
      assertCurrent();
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid native browser request.");
      const result = await deps.request(input.accountId, method, params as Record<string, unknown>);
      if (result === null || result === undefined) throw new Error("The selected account browser request was unavailable.");
      assertCurrent();
      return result;
    };
    const instance = bridge.create({ codexHome: context.codexHome, appServerVersion: context.appServerVersion, assertCurrent, request });
    if (input.method === "browser.sync") await instance.sync();
    else if (input.method === "browser.install" || input.method === "browser.uninstall") {
      if (input.params.hostId !== "local" || typeof input.params.pluginName !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(input.params.pluginName)) throw new Error("The selected execution host is unsupported.");
      const listing = await request("plugin/list", { marketplaceKinds: ["local"] }) as { marketplaces?: Array<{ name?: string; path?: string | null; plugins?: Array<{ name?: string }> }> };
      const marketplace = listing?.marketplaces?.find((entry) => entry.plugins?.some((plugin) => plugin.name === input.params.pluginName)
        && (input.method === "browser.install" ? typeof entry.path === "string" && entry.path === input.params.marketplacePath : entry.name === input.params.marketplaceName));
      if (!marketplace) throw new Error("This browser plugin does not belong to the selected account's catalog.");
      assertCurrent();
      if (input.method === "browser.install") await instance.install(input.params);
      else await instance.uninstall(input.params);
    } else throw new Error("Unknown Accounts browser action.");
    assertCurrent();
    // Native helpers return paths and internal selections. Keep them main-only.
    return { ok: true } as const;
  });
  pendingBrowserAction = action;
  return action;
}
