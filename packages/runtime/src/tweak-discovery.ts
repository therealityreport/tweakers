/**
 * Discover tweaks under <userRoot>/tweaks. Each tweak is a directory with a
 * manifest.json and an entry script. Entry resolution is manifest.main first,
 * then index.js, index.mjs, and index.cjs.
 *
 * The manifest gate is intentionally strict. A tweak must identify its GitHub
 * repository so the manager can check releases without granting the tweak an
 * update/install channel. Update checks are advisory only.
 */
import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateTweakManifest, type TweakManifest } from "@therealityreport/tweakers-sdk";

export interface DiscoveredTweak {
  dir: string;
  entry: string;
  manifest: TweakManifest;
}

const ENTRY_CANDIDATES = ["index.js", "index.cjs", "index.mjs"];

export interface TweakDiscoveryOptions {
  runtimeVersion?: string;
  onInvalid?: (directory: string, reason: string) => void;
}

export function discoverTweaks(tweaksDir: string, options: TweakDiscoveryOptions = {}): DiscoveredTweak[] {
  if (!existsSync(tweaksDir)) return [];
  const out: DiscoveredTweak[] = [];
  for (const name of readdirSync(tweaksDir).sort((a, b) => a.localeCompare(b))) {
    const dir = join(tweaksDir, name);
    // A removed development target can leave a dangling top-level symlink.
    // Treat one unreadable entry as invalid instead of taking every installed
    // tweak offline.
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      options.onInvalid?.(dir, "manifest is unreadable or invalid JSON");
      continue;
    }
    const validation = validateTweakManifest(value);
    if (!validation.ok) {
      options.onInvalid?.(dir, validation.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
      continue;
    }
    const manifest = value as TweakManifest;
    if (options.runtimeVersion && manifest.minRuntime && !supportsMinimumRuntime(options.runtimeVersion, manifest.minRuntime)) {
      options.onInvalid?.(dir, `requires runtime ${manifest.minRuntime}; current runtime is ${options.runtimeVersion}`);
      continue;
    }
    const entry = resolveEntry(dir, manifest);
    if (!entry) {
      options.onInvalid?.(dir, "entry must be a readable file inside the tweak directory");
      continue;
    }
    out.push({ dir, entry, manifest });
  }
  const counts = new Map<string, number>();
  for (const tweak of out) counts.set(tweak.manifest.id, (counts.get(tweak.manifest.id) ?? 0) + 1);
  return out.filter((tweak) => {
    if (counts.get(tweak.manifest.id) === 1) return true;
    options.onInvalid?.(tweak.dir, `duplicate tweak id: ${tweak.manifest.id}`);
    return false;
  });
}

function resolveEntry(dir: string, m: TweakManifest): string | null {
  for (const name of m.main ? [m.main] : ENTRY_CANDIDATES) {
    if (isAbsolute(name) || name.includes("\\") || name.split("/").includes("..")) return null;
    const entry = resolve(dir, name);
    try {
      const within = relative(realpathSync(dir), realpathSync(entry));
      if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) return null;
      if (statSync(entry).isFile()) return entry;
    } catch { /* Missing or unreadable entries do not poison sibling discovery. */ }
  }
  return null;
}


function supportsMinimumRuntime(current: string, minimum: string): boolean {
  const parse = (value: string) => /^(?:>=\s*)?v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())?.slice(1).map(Number);
  const available = parse(current), required = parse(minimum);
  if (!available || !required) return false;
  for (let index = 0; index < 3; index++) {
    if (available[index] !== required[index]) return available[index] > required[index];
  }
  return true;
}
