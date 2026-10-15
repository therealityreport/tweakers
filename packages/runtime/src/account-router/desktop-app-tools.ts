import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseTOML } from "toml-eslint-parser";

export const DESKTOP_APP_TOOLS_CONTEXT_ENV = "TWEAKERS_DESKTOP_APP_TOOLS_CONTEXT_V1";
export const MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES = 64 * 1024;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface DesktopAppToolsDefinition {
  [key: string]: JsonValue;
  command: string;
  args: string[];
  cwd: string;
  enabled: true;
  env_vars: string[];
  env: Record<string, string>;
}
/** Main-owned native configuration; never accept a renderer-supplied definition. */
export interface DesktopAppToolsContextV1 {
  schemaVersion: 1;
  resourcesPath: string;
  definition: DesktopAppToolsDefinition;
}

const pluginRelativePath = "plugins/openai-bundled/plugins/codex-app-tools";
const nativeBackendRelativePath = "codex-cli/CodexCLI.app/Contents/MacOS/codex";
const invalid = (): Error => new Error("Desktop app tools context unavailable");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value: unknown): value is string => typeof value === "string"
  && Buffer.byteLength(value) <= 4096 && !/[\0\r\n]/.test(value);
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value) && resolve(value) === value;
const within = (root: string, path: string): boolean => {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith("../") && !isAbsolute(suffix);
};
function boundedJson(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every(item => boundedJson(item, depth + 1));
  return record(value) && Object.keys(value).length <= 256 && Object.entries(value)
    .every(([key, item]) => text(key) && !["__proto__", "constructor", "prototype"].includes(key) && boundedJson(item, depth + 1));
}

export function isDesktopAppToolsContext(value: unknown): value is DesktopAppToolsContextV1 {
  if (!record(value) || Object.keys(value).some(key => !["schemaVersion", "resourcesPath", "definition"].includes(key))
    || value.schemaVersion !== 1 || !absolute(value.resourcesPath) || !boundedJson(value)) return false;
  try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) return false; } catch { return false; }
  const definition = value.definition;
  const pluginRoot = join(value.resourcesPath, pluginRelativePath);
  if (!record(definition) || definition.enabled !== true || definition.cwd !== pluginRoot
    || !absolute(definition.command) || !within(pluginRoot, definition.command)
    || !Array.isArray(definition.args) || !definition.args.length || !definition.args.every(text)
    || !absolute(definition.args[0]) || !within(pluginRoot, definition.args[0])
    || !Array.isArray(definition.env_vars) || !definition.env_vars.every(key => text(key) && /^[A-Z_][A-Z0-9_]*$/.test(key))
    || !definition.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH") || !record(definition.env)
    || !Object.entries(definition.env).every(([key, val]) => (definition.env_vars as string[]).includes(key) && text(val))) return false;
  const env = definition.env;
  return absolute(env.CODEX_APP_TOOLS_PIPE_PATH)
    && env.CODEX_ELECTRON_RESOURCES_PATH === value.resourcesPath
    && env.CODEX_MCP_NODE_PATH === join(value.resourcesPath, "cua_node", "bin", "node")
    && env.CODEX_BROWSER_USE_NODE_PATH === env.CODEX_MCP_NODE_PATH
    && typeof env.CODEX_CLI_PATH === "string"
    && [join(value.resourcesPath, "codex"), join(value.resourcesPath, nativeBackendRelativePath)].includes(env.CODEX_CLI_PATH)
    && !definition.env_vars.includes("NODE_OPTIONS");
}

export function parseDesktopAppToolsContext(serialized: string): DesktopAppToolsContextV1 {
  if (Buffer.byteLength(serialized) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) throw invalid();
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw invalid(); }
  if (!isDesktopAppToolsContext(value)) throw invalid();
  return value;
}

/** Called by the main spawn interceptor after native has assigned its own pipe. */
export function captureDesktopAppToolsContext(
  resourcesPath: string,
  environment: NodeJS.ProcessEnv,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
  backendCommand: string = join(resourcesPath, "codex"),
): DesktopAppToolsContextV1 | null {
  if (environment.CODEX_APP_TOOLS_PIPE_PATH === undefined) return null;
  if (!absolute(resourcesPath) || !absolute(environment.CODEX_APP_TOOLS_PIPE_PATH)) throw invalid();
  const backend = backendCommand === join(resourcesPath, "codex-cli/bin/codex")
    ? join(resourcesPath, nativeBackendRelativePath) : backendCommand;
  if (![join(resourcesPath, "codex"), join(resourcesPath, nativeBackendRelativePath)].includes(backend)) throw invalid();
  const pluginRoot = join(resourcesPath, pluginRelativePath);
  let manifest: unknown;
  try {
    const serialized = readFile(join(pluginRoot, ".mcp.json"), "utf8");
    if (Buffer.byteLength(serialized) > MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES) throw invalid();
    manifest = JSON.parse(serialized);
  } catch { throw invalid(); }
  const servers = record(manifest) ? manifest.mcpServers : null;
  const native = record(servers) ? servers.codex_app : null;
  if (!record(native) || !boundedJson(native) || !text(native.command) || !native.command
    || !Array.isArray(native.args) || !native.args.length || !native.args.every(text)
    || !text(native.cwd) || !Array.isArray(native.env_vars) || !native.env_vars.every(text)) throw invalid();
  const env: Record<string, string> = {};
  if (native.env !== undefined) {
    if (!record(native.env) || !Object.entries(native.env).every(([key, value]) => (native.env_vars as string[]).includes(key) && text(value))) throw invalid();
    Object.assign(env, native.env);
  }
  for (const key of native.env_vars as string[]) if (environment[key] !== undefined) env[key] = environment[key]!;
  Object.assign(env, {
    CODEX_APP_TOOLS_PIPE_PATH: environment.CODEX_APP_TOOLS_PIPE_PATH,
    CODEX_MCP_NODE_PATH: join(resourcesPath, "cua_node", "bin", "node"),
    CODEX_BROWSER_USE_NODE_PATH: join(resourcesPath, "cua_node", "bin", "node"),
    CODEX_ELECTRON_RESOURCES_PATH: resourcesPath,
    CODEX_CLI_PATH: backend,
  });
  const value = {
    schemaVersion: 1, resourcesPath,
    definition: { ...native, enabled: true, cwd: resolve(pluginRoot, native.cwd),
      command: resolve(pluginRoot, native.command),
      args: native.args.map(arg => arg.startsWith("./") || arg.startsWith("../") ? resolve(pluginRoot, arg) : arg), env },
  };
  if (!isDesktopAppToolsContext(value)) throw invalid();
  return value;
}

function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function desktopAppToolsFingerprint(context: DesktopAppToolsContextV1): string {
  if (!isDesktopAppToolsContext(context)) throw invalid();
  return createHash("sha256").update(canonical(context as unknown as JsonValue)).digest("hex");
}
function configKeyPath(key: string): string[] {
  if (Buffer.byteLength(key) > 4096 || /[\r\n\0]/.test(key)) return [];
  try {
    const body = parseTOML(`${key}=true`, { tomlVersion: "1.0.0" }).body[0].body;
    const node = body.length === 1 ? body[0] : null;
    return node?.type === "TOMLKeyValue" ? node.key.keys.map(part => part.type === "TOMLBare" ? part.name : part.value) : [];
  } catch { return []; }
}
function nativePluginKey(name: string | undefined): boolean {
  return name?.split("@")[0] === "codex-app-tools";
}
function desktopOverridePath(path: readonly string[]): boolean {
  return (path[0] === "mcp_servers" && path[1] === "codex_app")
    || (path[0] === "plugins" && nativePluginKey(path[1]));
}
function configAssignmentKey(value: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && char === "\\") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "=") return value.slice(0, index);
  }
  return "";
}
/** The global broker backend must never freeze its first desktop's MCP. */
export function stripDesktopAppToolsCliOverrides(args: readonly string[]): string[] {
  const output: string[] = [];
  const owns = (value: string): boolean => desktopOverridePath(configKeyPath(configAssignmentKey(value)));
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if ((arg === "-c" || arg === "--config") && typeof args[index + 1] === "string" && owns(args[index + 1])) { index++; continue; }
    const attached = arg.startsWith("--config=") ? arg.slice(9)
      : arg.startsWith("-c=") ? arg.slice(3) : arg.startsWith("-c") && arg.length > 2 ? arg.slice(2) : null;
    if (attached !== null && owns(attached)) continue;
    output.push(arg);
  }
  return output;
}
/** Thread-local only: renderer config cannot replace the main-bound native MCP. */
export function injectDesktopAppToolsRequestConfig(
  config: unknown,
  context: DesktopAppToolsContextV1 | null,
): Record<string, unknown> {
  if (context !== null && !isDesktopAppToolsContext(context)) throw invalid();
  if (config !== undefined && config !== null && !record(config)) throw invalid();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const path = configKeyPath(key);
    if (desktopOverridePath(path)) continue;
    if (["__proto__", "constructor", "prototype"].includes(key)) throw invalid();
    if (path.length === 1 && (path[0] === "mcp_servers" || path[0] === "plugins")) {
      if (!record(value)) continue;
      const servers = { ...value };
      for (const name of Object.keys(servers)) {
        const nested = configKeyPath(name);
        if ((path[0] === "mcp_servers" && nested[0] === "codex_app")
          || (path[0] === "plugins" && nativePluginKey(nested[0] ?? name))) delete servers[name];
      }
      out[key] = servers;
    } else out[key] = value;
  }
  if (context) out["mcp_servers.codex_app"] = JSON.parse(JSON.stringify(context.definition));
  return out;
}
