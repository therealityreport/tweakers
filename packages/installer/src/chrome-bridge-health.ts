import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";

export interface ChromeBridgeCheck {
  ok: boolean | "warn";
  detail: string;
}

export interface ChromeBridgeHealth {
  bundledVersion: string | null;
  extensionId: string | null;
  nativeHostName: string | null;
  cache: ChromeBridgeCheck;
  nativeHost: ChromeBridgeCheck;
}

interface InspectChromeBridgeOptions {
  appRoot: string;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

interface ChromePluginManifest {
  version?: unknown;
}

interface ExtensionConfig {
  extensionId?: unknown;
  extensionHostName?: unknown;
}

interface NativeHostManifest {
  name?: unknown;
  path?: unknown;
  allowed_origins?: unknown;
}

interface NativeHostRegistration {
  nativeHostVersion?: unknown;
  extensionIds?: unknown;
  nativeHostNames?: unknown;
  paths?: unknown;
}

interface NativeHostRegistry {
  entries?: unknown;
}

export function inspectChromeBridge(
  options: InspectChromeBridgeOptions,
): ChromeBridgeHealth | null {
  const currentPlatform = options.platform ?? platform();
  if (currentPlatform !== "darwin") return null;

  const home = options.homeDir ?? homedir();
  const bundledRoot = join(
    options.appRoot,
    "Contents",
    "Resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
  );
  const pluginManifest = readJson<ChromePluginManifest>(
    join(bundledRoot, ".codex-plugin", "plugin.json"),
  );
  const extensionConfig = readJson<ExtensionConfig>(
    join(bundledRoot, "scripts", "extension-id.json"),
  );
  const bundledVersion = nonEmptyString(pluginManifest?.version);
  const extensionId = nonEmptyString(extensionConfig?.extensionId);
  const nativeHostName = nonEmptyString(extensionConfig?.extensionHostName);

  if (!bundledVersion || !extensionId || !nativeHostName) {
    const detail = "active app does not expose complete bundled Chrome bridge metadata";
    return {
      bundledVersion,
      extensionId,
      nativeHostName,
      cache: { ok: "warn", detail },
      nativeHost: { ok: "warn", detail },
    };
  }

  const cacheRoot = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
  );
  const latest = join(cacheRoot, "latest");
  const cache = inspectCache(latest, bundledVersion);
  const nativeHost = inspectNativeHost({
    home,
    bundledVersion,
    extensionId,
    nativeHostName,
  });

  return { bundledVersion, extensionId, nativeHostName, cache, nativeHost };
}

function inspectCache(latest: string, bundledVersion: string): ChromeBridgeCheck {
  if (!pathEntryExists(latest)) {
    return { ok: false, detail: `missing cache projection: ${latest}` };
  }

  let target: string;
  try {
    target = realpathSync(latest);
  } catch {
    return {
      ok: false,
      detail: `dangling cache projection: ${latest} -> ${safeReadlink(latest) ?? "unresolved"}`,
    };
  }

  const host = join(target, "extension-host", "macos", architectureDirectory(), "ChatGPT for Chrome");
  if (!isExecutable(host)) {
    return { ok: false, detail: `native host executable is missing: ${host}` };
  }

  const targetVersion = basename(target);
  if (targetVersion !== bundledVersion) {
    return {
      ok: "warn",
      detail: `cache targets ${targetVersion}; active app bundles ${bundledVersion}`,
    };
  }

  return { ok: true, detail: `${targetVersion} (${host})` };
}

function inspectNativeHost(input: {
  home: string;
  bundledVersion: string;
  extensionId: string;
  nativeHostName: string;
}): ChromeBridgeCheck {
  const manifestPath = join(
    input.home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${input.nativeHostName}.json`,
  );
  const manifest = readJson<NativeHostManifest>(manifestPath);
  if (!manifest) {
    return { ok: false, detail: `native host manifest is missing: ${manifestPath}` };
  }

  if (manifest.name !== input.nativeHostName) {
    return { ok: false, detail: `native host manifest name does not match ${input.nativeHostName}` };
  }

  const expectedOrigin = `chrome-extension://${input.extensionId}/`;
  const allowedOrigins = Array.isArray(manifest.allowed_origins)
    ? manifest.allowed_origins.filter((value): value is string => typeof value === "string")
    : [];
  if (!allowedOrigins.includes(expectedOrigin)) {
    return { ok: false, detail: `native host does not allow ${expectedOrigin}` };
  }

  const executable = nonEmptyString(manifest.path);
  if (!executable || !isExecutable(executable)) {
    return {
      ok: false,
      detail: `registered native host executable is missing: ${executable ?? "unset"}`,
    };
  }

  const registry = readJson<NativeHostRegistry>(
    join(input.home, ".codex", "chrome-native-hosts-v2.json"),
  );
  const entries = Array.isArray(registry?.entries)
    ? registry.entries.filter(isNativeHostRegistration)
    : [];
  const current = entries.some((entry) =>
    entry.nativeHostVersion === input.bundledVersion &&
    stringArray(entry.extensionIds).includes(input.extensionId) &&
    stringArray(entry.nativeHostNames).includes(input.nativeHostName) &&
    registrationHostIsExecutable(entry.paths)
  );
  if (!current) {
    return {
      ok: "warn",
      detail: `manifest is healthy, but v2 registration is stale for ${input.bundledVersion}`,
    };
  }

  return { ok: true, detail: `${input.bundledVersion} (${executable})` };
}

function architectureDirectory(): string {
  return process.arch === "x64" ? "x64" : "arm64";
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeReadlink(path: string): string | null {
  try {
    return resolve(join(path, ".."), readlinkSync(path));
  } catch {
    return null;
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isNativeHostRegistration(value: unknown): value is NativeHostRegistration {
  return typeof value === "object" && value !== null;
}

function registrationHostIsExecutable(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const executable = nonEmptyString((value as { extensionHostPath?: unknown }).extensionHostPath);
  return executable !== null && isExecutable(executable);
}
