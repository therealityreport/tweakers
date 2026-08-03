import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isMacOsJunkName } from "./fs-copy.js";

export const USER_QUESTIONS_TWEAK_ID = "co.tweakers.user-questions";
export const USER_QUESTIONS_FOLDER = "user-questions";
export const LEGACY_USER_QUESTIONS_TWEAK_IDS = [
  ["co", "thomashulihan", "user-questions"].join("."),
] as const;

export type PathKind = "missing" | "file" | "directory";

export interface PathFingerprint {
  kind: PathKind;
  mode: number | null;
  hash: string;
}

export interface UserQuestionsSourceProof {
  id: typeof USER_QUESTIONS_TWEAK_ID;
  version: string;
  payloadHash: string;
  mainEntrypoint: string;
  mainEntrypointHash: string;
  mcpEntrypoint: string;
  mcpEntrypointHash: string;
  brokerEntrypointHash: string;
  schemaEntrypointHash: string;
}

/** Deterministic, mode-aware SHA-256 for a regular file or symlink-free tree. */
export function fingerprintPath(path: string): PathFingerprint {
  if (!existsSync(path)) return { kind: "missing", mode: null, hash: "missing" };
  const rootStat = lstatSync(path);
  if (rootStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in rollout surfaces: ${path}`);
  const mode = rootStat.mode & 0o777;
  if (rootStat.isFile()) {
    return {
      kind: "file",
      mode,
      hash: createHash("sha256").update("file\0").update(String(mode)).update("\0").update(readFileSync(path)).digest("hex"),
    };
  }
  if (!rootStat.isDirectory()) throw new Error(`unsupported rollout surface type: ${path}`);
  const hash = createHash("sha256");
  hash.update("directory\0").update(String(mode)).update("\0");
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // copyDirectoryPreservingModes sweeps Finder junk out of every copy, so a
      // fingerprint that counted it would never match its own preimage.
      if (isMacOsJunkName(entry.name)) continue;
      const entryPath = join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in rollout surfaces: ${entryPath}`);
      const name = relative(path, entryPath);
      const entryMode = entryStat.mode & 0o777;
      hash.update(name).update("\0").update(String(entryMode)).update("\0");
      if (entryStat.isDirectory()) {
        hash.update("directory\0");
        visit(entryPath);
      } else if (entryStat.isFile()) {
        hash.update("file\0").update(readFileSync(entryPath));
      } else {
        throw new Error(`unsupported rollout surface entry: ${entryPath}`);
      }
    }
  };
  visit(path);
  return { kind: "directory", mode, hash: hash.digest("hex") };
}

export function inspectUserQuestionsSource(tweakRoot: string): UserQuestionsSourceProof {
  const manifestPath = join(tweakRoot, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
    throw new Error("User Questions manifest must be a bounded regular file");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.id !== USER_QUESTIONS_TWEAK_ID) throw new Error("User Questions canonical ID mismatch");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("User Questions version is invalid");
  }
  if (manifest.scope !== "main" && manifest.scope !== "both") {
    throw new Error("User Questions must declare a main lifecycle");
  }
  const mainEntrypoint = typeof manifest.main === "string" ? manifest.main : "index.js";
  const mcp = manifest.mcp && typeof manifest.mcp === "object" && !Array.isArray(manifest.mcp)
    ? manifest.mcp as Record<string, unknown>
    : null;
  const args = mcp && Array.isArray(mcp.args) ? mcp.args : [];
  const mcpEntrypoint = args.find((value): value is string => typeof value === "string" && value.endsWith(".js"));
  if (mcp?.command !== "node" || !mcpEntrypoint) throw new Error("User Questions MCP entrypoint is invalid");

  const entryHash = (name: string): string => {
    if (basename(name) !== name) throw new Error("User Questions entrypoints must be direct children");
    const proof = fingerprintPath(join(tweakRoot, name));
    if (proof.kind !== "file") throw new Error(`User Questions entrypoint is missing: ${name}`);
    return proof.hash;
  };
  return {
    id: USER_QUESTIONS_TWEAK_ID,
    version: manifest.version,
    payloadHash: fingerprintPath(tweakRoot).hash,
    mainEntrypoint,
    mainEntrypointHash: entryHash(mainEntrypoint),
    mcpEntrypoint,
    mcpEntrypointHash: entryHash(mcpEntrypoint),
    brokerEntrypointHash: entryHash("broker-protocol.js"),
    schemaEntrypointHash: entryHash("core.js"),
  };
}

export function userQuestionsSourceMatches(
  actual: UserQuestionsSourceProof,
  expected: Pick<UserQuestionsSourceProof, "id" | "version" | "payloadHash">,
): boolean {
  return actual.id === expected.id
    && actual.version === expected.version
    && actual.payloadHash === expected.payloadHash
    && actual.mainEntrypointHash !== "missing"
    && actual.mcpEntrypointHash !== "missing"
    && actual.brokerEntrypointHash !== "missing"
    && actual.schemaEntrypointHash !== "missing";
}
