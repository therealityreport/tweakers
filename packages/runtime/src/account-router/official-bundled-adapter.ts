import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseLosslessTomlDocument, readLosslessTomlDocument, renderTomlConfigOverridesV1, selectNonsecretDefinitionTreeV1, readOfficialPluginHttpServersV1, officialPluginDefinitionBlocksV1, nonsecretPluginPolicyV1, tomlThreadConfigOverridesV1, officialLocalPluginIdV1, type TomlNodeV1, type TomlTableV1 } from "./account-continuity";
import { isPlainRecord } from "./types";
import { NATIVE_DESKTOP_CONFIG_PROOF_V1 } from "./native-desktop-config";
import { injectDesktopAppToolsRequestConfig, type DesktopAppToolsContextV1 } from "./desktop-app-tools";

/** Bind this capability in the signed runtime sealing performed by the installer. */
export const OFFICIAL_BUNDLED_ADAPTER_VERSION_V1 = "official-bundled-adapter-v1" as const;
/** Source compatibility is verified; managed custody and live acceptance remain separate guards. */
export const OFFICIAL_BUNDLED_ADAPTER_READY_V1 = true;
export const OFFICIAL_FOLLOW_NATIVE_PLUGIN_MUTATION_HOLD_V1 = "Tweakers follows native Codex's installed plugin list. Install, remove, or update plugins in native Codex, then refresh Tweakers's shared definitions." as const;
export function officialFollowNativePluginMutationV1(method: string, params: unknown): boolean {
  if (["plugin/install", "plugin/uninstall", "plugin/share/save", "plugin/share/delete", "plugin/share/checkout", "plugin/share/updateTargets", "marketplace/add", "marketplace/remove", "marketplace/upgrade", "browser.install", "browser.uninstall"].includes(method)) return true;
  if (method !== "http.request" || !isPlainRecord(params)) return false;
  const verb = typeof params.verb === "string" ? params.verb.toUpperCase() : typeof params.method === "string" ? params.method.toUpperCase() : "";
  return !["GET", "HEAD"].includes(verb) && typeof params.path === "string" && /(?:^|\/)plugins(?:\/|$)/.test(params.path);
}
export function officialOwnedConfigMutationAllowedV1(method: string, params: unknown, executionHome: string): boolean {
  if (method !== "config/value/write" && method !== "config/batchWrite") return true;
  if (!isPlainRecord(params) || (params.filePath !== undefined && params.filePath !== null
    && (typeof params.filePath !== "string" || params.filePath !== join(executionHome, "config.toml")))) return false;
  const edits = method === "config/value/write" ? [params] : params.edits;
  if (!Array.isArray(edits) || edits.length > 4096) return false;
  return edits.every(edit => {
    if (!isPlainRecord(edit) || typeof edit.keyPath !== "string" || edit.keyPath.length > 2048) return false;
    try {
      const tree = parseLosslessTomlDocument(`${edit.keyPath}=true\n`).tree, roots = Object.keys(tree);
      if (roots.length !== 1 || ["marketplace", "marketplaces", "chatgpt_base_url", "codex_home", "sqlite_home", "cli_auth_credentials_store", "forced_chatgpt_workspace_id", "model_providers", "permissions", "sandbox", "sandbox_mode", "approval_policy", "bypass_hook_trust"].includes(roots[0]!)) return false;
      const walk = (node: TomlNodeV1): string[] => {
        if ("type" in node) return [];
        const keys = Object.keys(node); if (keys.length !== 1) throw new Error("config edit is not one leaf");
        return [keys[0]!, ...walk(node[keys[0]!]!)];
      };
      const path = [roots[0]!, ...walk(tree[roots[0]!]!)];
      if (path.length === 1 && path[0] === "desktop") return false;
      const policyTree = (path: string[], value: unknown): Record<string, unknown> => path.length ? { [path[0]!]: policyTree(path.slice(1), value) } : value as Record<string, unknown>;
      if (["plugins", "hooks", "mcp_servers"].includes(path[0]!)) {
        if (!officialThreadPluginConfigAllowedV1({ config: policyTree(path, edit.value) })) return false;
      }
      if (path[0] === "plugins") return path.length >= 3 && (path[2] === "enabled" && path.length === 3
        || path[2] === "mcp_servers" && ["enabled", "default_tools_approval_mode", "enabled_tools", "disabled_tools", "tools"].includes(path[4] ?? ""));
      if (path[0] === "features" && ["plugins", "remote_plugin", "hooks"].includes(path[1] ?? "")) return false;
      if (path[0] === "hooks") return path[1] === "state" && path.length === 4 && ["enabled", "trusted_hash"].includes(path[3]!);
      if (path[0] === "mcp_servers") return path.length >= 3 && ["enabled", "default_tools_approval_mode", "enabled_tools", "disabled_tools", "tools"].includes(path[2]!);
      // Native's directory picker writes this ordinary desktop preference into
      // the account-owned config. It does not change execution-home authority.
      if (path.length === 2 && path[0] === "desktop" && path[1] === "projectlessWorkspaceRoot") return edit.value === null || typeof edit.value === "string";
      return !path.some(part => /(?:auth|token|credential|secret|password|base_url|proxy|root|home)/i.test(part)) || path[0] === "mcp_oauth_credentials_store" && path.length === 1;
    } catch { return false; }
  });
}
export const OFFICIAL_BUNDLED_PLUGIN_ADMISSION_HOLD_V1 = "Stock account child held: its verified shared plugin library or account service is unavailable. Refresh shared definitions and the selected account connection." as const;
export interface OfficialInstalledPluginV1 { id: string; enabled: boolean; version: string | null }
export interface OfficialPluginInventoryV1 { schema_version: 1; native_base_root: string; plugins: OfficialInstalledPluginV1[] }
/** Backend registration changes get new custody; signed prior generations remain recovery material. */
export function officialPluginLedgerRootV1(overlay: string, modeFingerprint: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(modeFingerprint)) throw new Error("invalid shared plugin registration generation");
  return join(overlay, "shared-plugin-library", modeFingerprint.slice(7));
}

export function officialPluginInventoryFromResponseV1(value: unknown, root: string): OfficialPluginInventoryV1 | null {
  if (!isPlainRecord(value) || !Array.isArray(value.marketplaces) || value.marketplaces.length > 128
    || !Array.isArray(value.marketplaceLoadErrors) || value.marketplaceLoadErrors.length) return null;
  const plugins: OfficialInstalledPluginV1[] = [];
  for (const marketplace of value.marketplaces) {
    if (!isPlainRecord(marketplace) || !Array.isArray(marketplace.plugins)) return null;
    for (const plugin of marketplace.plugins) {
      if (!isPlainRecord(plugin) || typeof plugin.installed !== "boolean") return null;
      if (!plugin.installed) continue;
      plugins.push({ id: plugin.id as string, enabled: plugin.enabled as boolean, version: plugin.version as string | null });
    }
  }
  plugins.sort((a, b) => typeof a.id === "string" && typeof b.id === "string" ? a.id.localeCompare(b.id) : 0);
  const inventory = { schema_version: 1 as const, native_base_root: root, plugins };
  return isOfficialPluginInventoryV1(inventory, root) ? inventory : null;
}

export function isOfficialPluginInventoryV1(value: unknown, root: string): value is OfficialPluginInventoryV1 {
  if (!isPlainRecord(value) || Object.keys(value).sort().join() !== "native_base_root,plugins,schema_version"
    || value.schema_version !== 1 || value.native_base_root !== root || !Array.isArray(value.plugins) || value.plugins.length > 4096) return false;
  const seen = new Set<string>();
  for (const plugin of value.plugins) {
    if (!isPlainRecord(plugin) || Object.keys(plugin).sort().join() !== "enabled,id,version"
      || typeof plugin.id !== "string" || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(plugin.id)
      || Buffer.byteLength(plugin.id) > 512 || seen.has(plugin.id) || typeof plugin.enabled !== "boolean"
      || !(plugin.version === null || (typeof plugin.version === "string" && /^[A-Za-z0-9_.+-]{1,255}$/.test(plugin.version) && ![".", ".."].includes(plugin.version)))) return false;
    seen.add(plugin.id);
  }
  return Buffer.byteLength(JSON.stringify(value)) < 2 * 1024 * 1024;
}

const table = (value: TomlNodeV1 | undefined): TomlTableV1 => value && !("type" in value) ? value as TomlTableV1
  : value?.type === "inline-table" ? value.entries as TomlTableV1 : {};
const scalar = (value: TomlNodeV1 | undefined): unknown => value && "type" in value && "value" in value ? value.value : undefined;
const config = (home: string) => existsSync(join(home, "config.toml")) ? readLosslessTomlDocument(join(home, "config.toml")) : parseLosslessTomlDocument("");
function mergeTomlPoliciesV1(base: TomlTableV1, explicit: TomlTableV1): TomlTableV1 {
  const result = { ...base };
  for (const [key, node] of Object.entries(explicit)) {
    result[key] = !("type" in node) || node.type === "inline-table"
      ? mergeTomlPoliciesV1(table(result[key]), table(node)) : node;
  }
  return result;
}

export interface OfficialBundledAccountPlanV1 {
  args: string[];
  threadConfig: Record<string, unknown>;
  oauthIsolation: "file" | "blocked";
  oauthBlockReason?: string;
  sharedHttpNames: string[];
  blockedMcpNames: string[];
  withheldPlugins: Record<string, string>;
  sourceEnablement: Record<string, boolean>;
}

/** Read-only plan: native definitions and all credentials stay in their original homes. */
export function officialBundledAccountPlanV1(input: {
  sourceHome: string; accountHome: string; settingsHome?: string; definitionHome?: string; args: readonly string[]; inventory: OfficialPluginInventoryV1; localLibrary?: boolean;
  /** Parent-owned verified generation, including non-MCP custody holds. */
  withheldPlugins?: Readonly<Record<string, string>>;
}): OfficialBundledAccountPlanV1 {
  if (!isOfficialPluginInventoryV1(input.inventory, input.sourceHome)) throw new Error("invalid stock source inventory");
  if (resolve(input.accountHome) === resolve(input.sourceHome)) throw new Error("stock account execution must use an existing signed Tweakers-owned execution-home");
  const source = config(input.sourceHome), own = config(input.accountHome), settings = config(input.settingsHome ?? input.accountHome);
  const local: { tree: TomlTableV1 } = { tree: { ...settings.tree, ...own.tree, plugins: { ...table(settings.tree.plugins), ...table(own.tree.plugins) }, mcp_servers: { ...table(settings.tree.mcp_servers), ...table(own.tree.mcp_servers) } } };
  // The runtime parser also reads CLI overrides, so quoted/inline TOML is
  // handled identically to a config file. An explicit value always wins.
  let cli: TomlTableV1 = {};
  for (let i = 0; i < input.args.length; i++) {
    const arg = input.args[i]!;
    const assignment = arg === "-c" || arg === "--config" ? input.args[++i] : arg.startsWith("--config=") ? arg.slice(9) : undefined;
    if (assignment) cli = mergeTomlPoliciesV1(cli, parseLosslessTomlDocument(assignment + "\n").tree);
  }
  const definitionHome = input.definitionHome ?? input.sourceHome;
  const withheldPlugins = { ...officialPluginDefinitionBlocksV1(definitionHome, input.inventory.plugins), ...input.withheldPlugins };
  if (Object.keys(withheldPlugins).some(id => !input.inventory.plugins.some(plugin => plugin.id === id))) throw new Error("shared plugin withheld authority does not match the native inventory");
  for (const plugin of input.inventory.plugins) if (plugin.version === null) withheldPlugins[plugin.id] = "No readable installed package is available in the native source snapshot.";
  const definitions = selectNonsecretDefinitionTreeV1(source.tree);
  const effective: Record<string, TomlNodeV1> = {};
  if (input.localLibrary) {
    // Preserve this actor's existing nonsecret settings as defaults in its
    // separate home. Saved execution settings and explicit CLI values win.
    const settingsOnly = nonsecretPluginPolicyV1(settings.tree);
    for (const [key, node] of Object.entries(settingsOnly)) {
      if (["plugins", "marketplace", "marketplaces", "mcp_servers", "mcp_oauth_credentials_store", "cli_auth_credentials_store", "chatgpt_base_url"].includes(key)) continue;
      if (key === "features") {
        const absent = Object.fromEntries(Object.entries(table(node)).filter(([flag]) => table(own.tree.features)[flag] === undefined && table(cli.features)[flag] === undefined));
        if (Object.keys(absent).length) effective.features = absent;
      } else if (own.tree[key] === undefined && cli[key] === undefined) effective[key] = node;
    }
  }
  for (const root of ["mcp_servers"]) {
    const shared = table(definitions[root]), ownSettings = table(selectNonsecretDefinitionTreeV1(settings.tree)[root]), existing = table(own.tree[root]);
    const missing = Object.fromEntries(Object.entries({ ...shared, ...ownSettings }).filter(([name]) => !Object.prototype.hasOwnProperty.call(existing, name)));
    if (Object.keys(missing).length) effective[root] = mergeTomlPoliciesV1(missing, table(cli[root]));
  }
  const localPlugins = table(local.tree.plugins);
  const plugins: Record<string, TomlNodeV1> = {};
  const threadConfig: Record<string, unknown> = {};
  const sourceEnablement: Record<string, boolean> = {};
  const sharedIds = new Set(input.inventory.plugins.map(plugin => plugin.id));
  const executionId = (id: string) => input.localLibrary ? officialLocalPluginIdV1(id) : id;
  if (input.localLibrary && effective.hooks) {
    const hooks = table(effective.hooks), state = table(hooks.state);
    (hooks as Record<string, TomlNodeV1>).state = Object.fromEntries(Object.entries(state).map(([key, node]) => {
      const plugin = [...sharedIds].find(id => key.startsWith(id + ":"));
      return [plugin ? executionId(plugin) + key.slice(plugin.length) : key, node];
    }));
  }
  for (const plugin of input.inventory.plugins) {
    const id = executionId(plugin.id);
    const own = { ...table(localPlugins[plugin.id]), ...table(localPlugins[id]), ...table(table(cli.plugins)[plugin.id]), ...table(table(cli.plugins)[id]) };
    const enabled = scalar(own.enabled);
    const value = withheldPlugins[plugin.id] ? false : typeof enabled === "boolean" ? enabled : plugin.enabled;
    plugins[id] = { ...nonsecretPluginPolicyV1(own), enabled: { type: "boolean", value } };
    threadConfig[`plugins.${JSON.stringify(id)}.enabled`] = value;
    sourceEnablement[plugin.id] = value;
  }
  // Local-only definitions stay on disk; they are disabled in this child so
  // every account exposes the signed source's one installed definition list.
  const executionIds = new Set([...sharedIds].map(executionId));
  for (const id of Object.keys(localPlugins)) if (!executionIds.has(id) && (!sharedIds.has(id) || input.localLibrary)) {
    plugins[id] = { enabled: { type: "boolean", value: false } };
    threadConfig[`plugins.${JSON.stringify(id)}.enabled`] = false;
  }
  effective.plugins = plugins;
  const marketplaces: Record<string, TomlNodeV1> = {};
  for (const plugin of input.inventory.plugins) {
    const marketplace = executionId(plugin.id).split("@")[1]!;
    if (input.localLibrary || !["openai-curated-remote", "created-by-me-remote", "workspace-directory", "workspace-shared-with-me", "workspace-shared-with-me-private", "workspace-shared-with-me-unlisted"].includes(marketplace)) {
      marketplaces[marketplace] = { source_type: { type: "string", value: "local" }, source: { type: "string", value: join(input.accountHome, "plugins", "cache", marketplace) } };
    }
  }
  effective.marketplaces = marketplaces;
  const sharedHttpNames = Object.entries(table(definitions.mcp_servers)).filter(([name, server]) =>
    typeof scalar(table(server).url) === "string" && !Object.prototype.hasOwnProperty.call(table(local.tree.mcp_servers), name)).map(([name]) => name);
  const sharedPluginHttp = readOfficialPluginHttpServersV1(definitionHome, input.inventory.plugins.filter(plugin => plugin.version !== null && !withheldPlugins[plugin.id]));
  // The original home supplies read-only account policies, not a credential-store
  // preference for this separate execution home. Never inherit its global keyring.
  const storeNode = cli.mcp_oauth_credentials_store ?? own.tree.mcp_oauth_credentials_store;
  const explicitStore = storeNode === undefined ? undefined : scalar(storeNode) ?? "invalid";
  let oauthIsolation: OfficialBundledAccountPlanV1["oauthIsolation"] = explicitStore === "file" ? "file" : "blocked";
  if (explicitStore === undefined) {
    effective.mcp_oauth_credentials_store = { type: "string", value: "file" };
    oauthIsolation = "file";
  }
  if (oauthIsolation === "file") threadConfig.mcp_oauth_credentials_store = "file";
  if (oauthIsolation === "blocked") {
    // Disable only the affected HTTP server in this process. Preserve its
    // saved enabled/store setting and every auth file for later reconciliation.
    for (const { pluginId, name } of sharedPluginHttp) {
      const plugin = plugins[executionId(pluginId)] as Record<string, TomlNodeV1>;
      const servers = table(plugin.mcp_servers) as Record<string, TomlNodeV1>;
      servers[name] = { ...table(servers[name]), enabled: { type: "boolean", value: false } };
      plugin.mcp_servers = servers;
      threadConfig[`plugins.${JSON.stringify(executionId(pluginId))}.mcp_servers.${JSON.stringify(name)}.enabled`] = false;
    }
    const servers: Record<string, TomlNodeV1> = effective.mcp_servers ? { ...table(effective.mcp_servers) } : {};
    for (const [name, server] of Object.entries(table(definitions.mcp_servers))) if (typeof scalar(table(server).url) === "string") {
      servers[name] = { ...table(servers[name]), enabled: { type: "boolean", value: false } };
      threadConfig[`mcp_servers.${JSON.stringify(name)}.enabled`] = false;
    }
    if (Object.keys(servers).length) effective.mcp_servers = servers;
  }
  // Do not override existing local definitions or any account-local scalar.
  Object.assign(threadConfig, tomlThreadConfigOverridesV1({ plugins }));
  const isolationOverrides = oauthIsolation === "blocked" ? Object.keys(threadConfig).filter(key => key.includes(".mcp_servers.") || key.startsWith("mcp_servers.")).map(key => `${key}=false`) : [];
  const withheldIds = Object.keys(withheldPlugins).map(executionId);
  const suppressed = [...withheldIds, ...Object.keys(localPlugins).filter(id => !executionIds.has(id)), ...(input.localLibrary ? [...sharedIds] : [])];
  if (input.localLibrary) {
    for (const id of suppressed) plugins[id] = { ...table(plugins[id]), enabled: { type: "boolean", value: false } };
    for (const key of Object.keys(threadConfig)) if (key.startsWith("plugins.") || key.startsWith("mcp_servers.")) delete threadConfig[key];
    Object.assign(threadConfig, tomlThreadConfigOverridesV1({ plugins, ...(oauthIsolation === "blocked" && effective.mcp_servers ? { mcp_servers: effective.mcp_servers } : {}) }, true));
  }
  // Native merges an override layer into saved tables, but a later ROOT
  // override replaces earlier CLI siblings within that layer.
  if (effective.features) effective.features = mergeTomlPoliciesV1(table(effective.features), table(cli.features));
  const overrides = renderTomlConfigOverridesV1(effective, Boolean(input.localLibrary));
  const args = [...input.args, ...overrides.flatMap(value => ["-c", value]), ...(input.localLibrary ? [] : isolationOverrides.flatMap(value => ["-c", value])), ...(input.localLibrary ? [] : [...new Set(suppressed)].flatMap(id => ["-c", `plugins.${JSON.stringify(id)}.enabled=false`]))];
  return { args, threadConfig, oauthIsolation, sharedHttpNames, withheldPlugins, sourceEnablement, blockedMcpNames: oauthIsolation === "blocked" ? [...new Set([...Object.entries(table(definitions.mcp_servers)).filter(([, server]) => typeof scalar(table(server).url) === "string").map(([name]) => name), ...sharedPluginHttp.map(server => server.name)])] : [],
    ...(oauthIsolation === "blocked" ? { oauthBlockReason: explicitStore === undefined
      ? "Shared OAuth authorization requires an account-local file credential store."
      : "The selected account's explicit MCP credential store uses a global keyring; shared OAuth authorization is blocked to keep account credentials separate." } : {}) };
}

export function officialSharedPluginResponseV1(inventory: OfficialPluginInventoryV1, plan: OfficialBundledAccountPlanV1): unknown {
  const marketplaces = new Map<string, unknown[]>();
  for (const plugin of inventory.plugins) {
    const name = plugin.id.split("@")[1]!;
    const rows = marketplaces.get(name) ?? [];
    rows.push({ ...plugin, installed: plugin.version !== null, name: plugin.id.split("@")[0],
      enabled: plan.sourceEnablement[plugin.id] ?? plugin.enabled,
      ...(plan.withheldPlugins[plugin.id] ? { status: "unavailable" } : {}) });
    marketplaces.set(name, rows);
  }
  return { marketplaces: [...marketplaces].map(([name, plugins]) => ({ name, plugins, path: null })), marketplaceLoadErrors: [] };
}

export function officialOwnedAccountHomeV1(stateRoot: string, account: string, home: string): boolean {
  const expected = join(resolve(stateRoot), "accounts", account, "execution-home");
  if (resolve(home) !== expected) return false;
  const stat = lstatSync(home);
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
}

/** Generation fence exposes a digest, never source configuration or credentials. */
export function officialSourceConfigFingerprintV1(home: string): string { return config(home).fingerprint; }

/** UI names remain canonical; execution paths and native hash proofs stay untouched. */
export function officialCanonicalPluginResponseV1(value: unknown, inventory: OfficialPluginInventoryV1, method?: string, plan?: OfficialBundledAccountPlanV1): unknown {
  const ids = new Map(inventory.plugins.map(plugin => [officialLocalPluginIdV1(plugin.id), plugin.id]));
  const markets = new Map(inventory.plugins.map(plugin => [officialLocalPluginIdV1(plugin.id).split("@")[1]!, plugin.id.split("@")[1]!]));
  const token = (value: string) => ids.get(value) ?? markets.get(value) ?? (() => {
    for (const [alias, original] of ids) if (value.startsWith(alias + ":")) return original + value.slice(alias.length);
    for (const [alias, original] of ids) if (value.startsWith(`plugin:${alias}:`) || value === `plugin:${alias}`) return value.replace(`plugin:${alias}`, `plugin:${original}`);
    return value;
  })();
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("Plugin response nesting exceeds the supported bound");
    if (typeof value === "string") return token(value);
    if (Array.isArray(value)) return value.map(child => visit(child, depth + 1));
    if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [token(key), visit(child, depth + 1)]));
    return value;
  };
  // A prior account cache can retain disabled, foreign or original-ID packages.
  // Only the signed local projection supplies installed rows; discovery remains
  // the native backend's real, account-specific response.
  if (["plugin/installed", "plugin/list"].includes(method ?? "") && isPlainRecord(value) && Array.isArray(value.marketplaces)) value = { ...value,
    marketplaces: value.marketplaces.map(market => isPlainRecord(market) && Array.isArray(market.plugins) ? { ...market,
      plugins: market.plugins.filter(plugin => !isPlainRecord(plugin) || plugin.installed !== true || typeof plugin.id === "string" && ids.has(plugin.id)) } : market),
  };
  const result = visit(value, 0);
  if (plan && ["plugin/installed", "plugin/list"].includes(method ?? "") && isPlainRecord(result) && Array.isArray(result.marketplaces)) {
    for (const plugin of inventory.plugins) {
      const reason = plan.withheldPlugins[plugin.id]; if (!reason) continue;
      const [name, marketplace] = plugin.id.split("@");
      let market = result.marketplaces.find(row => isPlainRecord(row) && row.name === marketplace);
      if (!isPlainRecord(market)) { market = { name: marketplace, path: null, interface: null, plugins: [] }; result.marketplaces.push(market); }
      if (!Array.isArray(market.plugins)) continue;
      const existing = market.plugins.find((row: unknown) => isPlainRecord(row) && row.id === plugin.id);
      // This is canonical source availability metadata, not a fabricated
      // remote install or a claim that the package is executable here.
      const metadata = { installed: plugin.version !== null, enabled: false, localVersion: null, installPolicy: "NOT_AVAILABLE",
        sharedDefinitionState: "unavailable", sharedDefinitionReason: reason };
      if (isPlainRecord(existing)) Object.assign(existing, metadata);
      else market.plugins.push({ id: plugin.id, name, remotePluginId: null, version: plugin.version, shareContext: null,
        source: { type: "local", path: join(inventory.native_base_root, "plugins", "cache", marketplace!, name!, plugin.version ?? "missing") },
        installedAt: null, installPolicySource: null, authPolicy: "ON_USE", availability: "AVAILABLE", disabledReason: "unknown", eligiblePlanTypes: null,
        mustShowInstallationInterstitial: null, interface: { displayName: name, shortDescription: reason, longDescription: reason }, keywords: [], ...metadata });
    }
  }
  return result;
}

export function officialExecutionPluginParamsV1(method: string, value: unknown, inventory: OfficialPluginInventoryV1, home: string): unknown {
  if (!isPlainRecord(value)) return value;
  const ids = new Map(inventory.plugins.map(plugin => [plugin.id, officialLocalPluginIdV1(plugin.id)]));
  const token = (v: string) => ids.get(v) ?? (() => {
    for (const [original, alias] of ids) if (v.startsWith(original + ":")) return alias + v.slice(original.length);
    for (const [original, alias] of ids) if (v.startsWith(`plugin:${original}:`) || v === `plugin:${original}`) return v.replace(`plugin:${original}`, `plugin:${alias}`);
    return v;
  })();
  const keyPath = (key: string) => {
    let result = key;
    for (const [original, alias] of ids) result = result.replace(JSON.stringify(original), JSON.stringify(alias)).replace(JSON.stringify(`plugin:${original}`), JSON.stringify(`plugin:${alias}`)).replace(original + ":", alias + ":");
    return result;
  };
  const result: Record<string, unknown> = { ...value };
  if (typeof result.pluginId === "string") result.pluginId = token(result.pluginId);
  if (Array.isArray(result.disabledPluginIds)) result.disabledPluginIds = result.disabledPluginIds.map(v => typeof v === "string" ? token(v) : v);
  if (method === "config/value/write" && typeof result.keyPath === "string") result.keyPath = keyPath(result.keyPath);
  if (method === "config/batchWrite" && Array.isArray(result.edits)) result.edits = result.edits.map(edit => isPlainRecord(edit) && typeof edit.keyPath === "string" ? { ...edit, keyPath: keyPath(edit.keyPath) } : edit);
  if (isPlainRecord(result.config)) {
    const mapped = Object.fromEntries(Object.entries(result.config).map(([key, child]) => [keyPath(key), child]));
    for (const root of ["plugins", "hooks"] as const) {
      if (!isPlainRecord(mapped[root])) continue;
      if (root === "plugins") mapped.plugins = Object.fromEntries(Object.entries(mapped.plugins as Record<string, unknown>).map(([id, node]) => [token(id), node]));
      else {
        const hooks = mapped.hooks as Record<string, unknown>;
        if (isPlainRecord(hooks.state)) mapped.hooks = { ...hooks, state: Object.fromEntries(Object.entries(hooks.state).map(([key, node]) => [token(key), node])) };
      }
    }
    result.config = normalizeOfficialThreadConfigV1(mapped);
  }
  if (method === "plugin/read" && typeof result.pluginName === "string" && typeof result.remoteMarketplaceName === "string") {
    const alias = ids.get(`${result.pluginName}@${result.remoteMarketplaceName}`);
    if (alias) { result.remoteMarketplaceName = null; result.marketplacePath = join(home, "plugins", "cache", alias.split("@")[1]!, ".agents", "plugins", "marketplace.json"); }
  }
  return result;
}

function mergeOfficialConfigV1(base: Record<string, unknown>, explicit: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 64) throw new Error("Shared plugin configuration exceeds the supported nesting bound");
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(explicit)])].map(key => {
    const own = Object.prototype.hasOwnProperty.call(explicit, key), selected = own ? explicit[key] : base[key];
    return [key, isPlainRecord(selected) ? mergeOfficialConfigV1(isPlainRecord(base[key]) ? base[key] : {}, own ? selected : {}, depth + 1) : selected];
  }));
}

/** The native override parser does not unquote dotted path segments. */
function normalizeOfficialThreadConfigV1(config: Record<string, unknown>): Record<string, unknown> {
  let result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!key.includes(".") && !key.startsWith('"')) { result = mergeOfficialConfigV1(result, { [key]: value }); continue; }
    if (key.length > 2048) throw new Error("Shared plugin configuration key exceeds the supported bound");
    // Native desktop overrides are dotted paths, not TOML source. Its bundled
    // app-tools policy uses a bare plugin ID containing @. Quote that exact
    // unambiguous path segment before asking the TOML parser to decode the path.
    // Signed native configuration has already been verified in its wire form.
    const nativePluginPath = /^plugins\.([A-Za-z0-9_-]+@[A-Za-z0-9_-]+)(?=\.)/;
    if (nativePluginPath.test(key)) {
      const segments = key.split(".");
      if (!segments.slice(2).every(part => /^[A-Za-z0-9_-]+$/.test(part))
        || segments.some(part => ["__proto__", "prototype", "constructor"].includes(part))) {
        throw new Error("Unsafe native plugin configuration path");
      }
    }
    const tomlKey = key.replace(nativePluginPath, (_match, id: string) => `plugins.${JSON.stringify(id)}`);
    const path = parseLosslessTomlDocument(`${tomlKey}=true\n`).tree;
    const replaceLeaf = (node: TomlNodeV1, depth: number): unknown => {
      if (depth > 64) throw new Error("Shared plugin configuration exceeds the supported nesting bound");
      if ("type" in node) return value;
      return Object.fromEntries(Object.entries(node).map(([name, child]) => [name, replaceLeaf(child, depth + 1)]));
    };
    result = mergeOfficialConfigV1(result, Object.fromEntries(Object.entries(path).map(([name, node]) => [name, replaceLeaf(node, 0)])));
  }
  return result;
}

const mcpPolicyV1 = (value: unknown): boolean => isPlainRecord(value) && Object.entries(value).every(([key, child]) => {
  if (key === "enabled") return typeof child === "boolean";
  if (key === "default_tools_approval_mode") return typeof child === "string" && child.length <= 128;
  if (["enabled_tools", "disabled_tools"].includes(key)) return Array.isArray(child) && child.every(name => typeof name === "string" && name.length <= 512);
  return key === "tools" && isPlainRecord(child) && Object.values(child).every(tool => isPlainRecord(tool) && Object.entries(tool).every(([field, policy]) =>
    field === "enabled" ? typeof policy === "boolean" : field === "approval_mode" && typeof policy === "string" && policy.length <= 128));
});
/** Keep policy while replacing executable authority with the main-owned tool. */
export function officialDesktopAppToolsConfigV1(value: unknown, context: DesktopAppToolsContextV1 | null, includePluginPolicy = true): Record<string, unknown> {
  const normalized = normalizeOfficialThreadConfigV1(isPlainRecord(value) ? value : {});
  const fields = new Set(["enabled", "default_tools_approval_mode", "enabled_tools", "disabled_tools", "tools"]);
  const policy = (node: unknown) => isPlainRecord(node) ? Object.fromEntries(Object.entries(node).filter(([key]) => fields.has(key))) : {};
  let selected: Record<string, unknown> = {};
  if (includePluginPolicy && isPlainRecord(normalized.plugins)) for (const [id, node] of Object.entries(normalized.plugins)) {
    if (id.split("@")[0] !== "codex-app-tools" || !isPlainRecord(node)) continue;
    if (Object.hasOwn(node, "enabled")) selected.enabled = node.enabled;
    if (isPlainRecord(node.mcp_servers)) selected = mergeOfficialConfigV1(selected, policy(node.mcp_servers.codex_app));
  }
  if (isPlainRecord(normalized.mcp_servers)) selected = mergeOfficialConfigV1(selected, policy(normalized.mcp_servers.codex_app));
  if (!mcpPolicyV1(selected)) throw new Error("Invalid desktop tool policy");
  const result = injectDesktopAppToolsRequestConfig(normalized, null);
  if (context || Object.keys(selected).length) result.mcp_servers = {
    ...(isPlainRecord(result.mcp_servers) ? result.mcp_servers : {}),
    codex_app: mergeOfficialConfigV1(context ? JSON.parse(JSON.stringify(context.definition)) : {}, selected),
  };
  return result;
}
/** Chat overrides may change policy and trust, never install executable definitions. */
export function officialThreadPluginConfigAllowedV1(value: unknown): boolean {
  if (!isPlainRecord(value) || value.config === undefined || value.config === null) return isPlainRecord(value);
  if (!isPlainRecord(value.config)) return false;
  if (Object.hasOwn(value.config, NATIVE_DESKTOP_CONFIG_PROOF_V1)) return false;
  try {
    const config = normalizeOfficialThreadConfigV1(value.config);
    return Object.entries(config).every(([root, node]) => {
      if (["marketplace", "marketplaces", "chatgpt_base_url", "codex_home", "sqlite_home", "cli_auth_credentials_store", "forced_chatgpt_workspace_id", "model_providers", "bypass_hook_trust"].includes(root)) return false;
      if (root === "plugins") return isPlainRecord(node) && Object.values(node).every(plugin => isPlainRecord(plugin) && Object.entries(plugin).every(([key, policy]) =>
        key === "enabled" ? typeof policy === "boolean" : key === "mcp_servers" && isPlainRecord(policy) && Object.values(policy).every(mcpPolicyV1)));
      if (root === "mcp_servers") return isPlainRecord(node) && Object.values(node).every(mcpPolicyV1);
      if (root === "hooks") return isPlainRecord(node) && Object.keys(node).every(key => key === "state") && isPlainRecord(node.state)
        && Object.values(node.state).every(state => isPlainRecord(state) && Object.entries(state).every(([key, policy]) =>
          key === "enabled" ? typeof policy === "boolean" : key === "trusted_hash" && typeof policy === "string" && policy.length <= 256));
      return true;
    });
  } catch { return false; }
}

/** Preserve explicit chat policy while retaining source and credential isolation holds. */
export function officialThreadPluginParamsV1(value: unknown, plan: OfficialBundledAccountPlanV1, inventory: OfficialPluginInventoryV1, home: string, attestedNativeConfig?: Record<string, unknown>): unknown {
  if (!officialThreadPluginConfigAllowedV1(value)) throw new Error(OFFICIAL_FOLLOW_NATIVE_PLUGIN_MUTATION_HOLD_V1);
  const mapped = officialExecutionPluginParamsV1("thread/start", isPlainRecord(value) ? value : {}, inventory, home) as Record<string, unknown>;
  const native = attestedNativeConfig ? officialExecutionPluginParamsV1("thread/start", { config: attestedNativeConfig }, inventory, home) as Record<string, unknown> : {};
  const config = mergeOfficialConfigV1(mergeOfficialConfigV1(normalizeOfficialThreadConfigV1(plan.threadConfig), isPlainRecord(native.config) ? native.config : {}), isPlainRecord(mapped.config) ? mapped.config : {});
  const plugins = isPlainRecord(config.plugins) ? config.plugins : {};
  const allowed = new Set(inventory.plugins.filter(plugin => plugin.version !== null && !plan.withheldPlugins[plugin.id]).map(plugin => officialLocalPluginIdV1(plugin.id)));
  const defaults = normalizeOfficialThreadConfigV1(plan.threadConfig);
  for (const [id, node] of Object.entries(plugins)) {
    if (!allowed.has(id)) plugins[id] = { ...(isPlainRecord(node) ? node : {}), enabled: false };
    else if (plan.oauthIsolation === "blocked" && isPlainRecord(node)) {
      const baseline = isPlainRecord(defaults.plugins) && isPlainRecord(defaults.plugins[id]) ? defaults.plugins[id] : {};
      const blocked = isPlainRecord(baseline.mcp_servers) ? baseline.mcp_servers : {};
      for (const [name, policy] of Object.entries(blocked)) if (isPlainRecord(policy) && policy.enabled === false) {
        const servers = isPlainRecord(node.mcp_servers) ? node.mcp_servers : {};
        node.mcp_servers = { ...servers, [name]: { ...(isPlainRecord(servers[name]) ? servers[name] : {}), enabled: false } };
      }
    }
  }
  config.plugins = plugins;
  if (plan.oauthIsolation === "file") config.mcp_oauth_credentials_store = "file";
  else if (isPlainRecord(defaults.mcp_servers)) {
    const servers = isPlainRecord(config.mcp_servers) ? config.mcp_servers : {};
    for (const [name, policy] of Object.entries(defaults.mcp_servers)) if (isPlainRecord(policy) && policy.enabled === false) servers[name] = { ...(isPlainRecord(servers[name]) ? servers[name] : {}), enabled: false };
    config.mcp_servers = servers;
  }
  return { ...mapped, config };
}
