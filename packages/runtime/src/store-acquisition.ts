import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import { resolveBundledTweakPath, storeArchiveUrl, type TweakStoreEntry } from "./tweak-store";
const LEGACY_STORE_METADATA = [".codex", "pp-store.json"].join("");
export async function acquireStoreTweak(entry: TweakStoreEntry, options: {
  runtimeDir: string; runtimeVersion: string; storeIndexUrl: string; work: string; stagedTarget: string; log(message: string): void;
}): Promise<void> {
  const { work, stagedTarget } = options;
  const archive = join(work, "source.tar.gz"), extractDir = join(work, "extract");
    let source: string;
    if (entry.source?.kind === "bundled") {
      // The catalog path is constrained to `tweaks/<id>` by normalization;
      // resolving it here keeps traversal and cross-entry installs closed.
      const bundledPath = entry.source.path;
      if (typeof bundledPath !== "string") throw new Error(`bundled source for ${entry.id} is missing a path`);
      source = resolveBundledTweakPath(options.runtimeDir, { ...entry, source: { kind: "bundled", path: bundledPath as string } });
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        throw new Error(`bundled source for ${entry.id} is missing from the installer runtime`);
      }
      options.log(`installing bundled tweak ${entry.id} from ${source}`);
    } else {
      const url = storeArchiveUrl(entry);
      options.log(`installing store tweak ${entry.id} from ${entry.repo ?? "(unknown)"}@${entry.approvedCommitSha ?? "(unknown)"}`);
      const res = await fetch(url, {
        headers: { "User-Agent": `tweaker/${options.runtimeVersion}` },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      writeFileSync(archive, bytes);
      mkdirSync(extractDir, { recursive: true });
      extractTarArchive(archive, extractDir);
      source = findTweakRoot(extractDir) ?? "";
      if (!source) throw new Error("downloaded archive did not contain manifest.json");
    }
    validateStoreTweakSource(entry, source);
    rmSync(stagedTarget, { recursive: true, force: true });
    copyTweakSource(source, stagedTarget);
    const stagedFiles = hashTweakSource(stagedTarget);
    writeFileSync(
      join(stagedTarget, ".tweaker-store.json"),
      JSON.stringify(
        {
          ...(entry.repo ? { repo: entry.repo } : {}),
          ...(entry.approvedCommitSha ? { approvedCommitSha: entry.approvedCommitSha } : {}),
          ...(entry.source ? { source: entry.source } : {}),
          installedAt: new Date().toISOString(),
          storeIndexUrl: options.storeIndexUrl,
          files: stagedFiles,
        },
        null,
        2,
      ),
    );
}

interface StoreInstallMetadata {
  repo?: string;
  approvedCommitSha?: string;
  source?: { kind: "bundled" | "remote"; path?: string };
  installedAt: string;
  storeIndexUrl: string;
  files?: Record<string, string>;
}

class StoreTweakModifiedError extends Error {
  constructor(tweakName: string) {
    super(
      `${tweakName} has local source changes, so Tweakers can't auto-update it. Revert your local changes or reinstall the tweak manually.`,
    );
    this.name = "StoreTweakModifiedError";
  }
}

function extractTarArchive(archive: string, targetDir: string): void {
  const result = spawnSync("tar", ["-xzf", archive, "-C", targetDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${result.stderr || result.stdout || result.status}`);
  }
}

export function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void {
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TweakManifest;
  if (manifest.id !== entry.manifest.id) {
    throw new Error(`downloaded tweak id ${manifest.id} does not match approved id ${entry.manifest.id}`);
  }
  const approvedRepo = entry.source?.kind === "remote" ? entry.source.repo : entry.repo;
  if (approvedRepo && manifest.githubRepo !== approvedRepo) {
    throw new Error(`downloaded tweak repo ${manifest.githubRepo} does not match approved repo ${approvedRepo}`);
  }
  if (manifest.version !== entry.manifest.version) {
    throw new Error(`downloaded tweak version ${manifest.version} does not match approved version ${entry.manifest.version}`);
  }
}

function findTweakRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  if (existsSync(join(dir, "manifest.json"))) return dir;
  for (const name of readdirSync(dir)) {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findTweakRoot(child);
    if (found) return found;
  }
  return null;
}

function copyTweakSource(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !/(^|[/\\])(?:\.git|node_modules)(?:[/\\]|$)/.test(src),
  });
}

export async function assertStoreTweakCleanForAutoUpdate(
  entry: TweakStoreEntry,
  target: string,
  work: string,
  runtimeVersion: string,
): Promise<void> {
  if (!existsSync(target)) return;
  const metadata = readStoreInstallMetadata(target);
  if (!metadata) throw new Error("Cannot replace a tweak without verified installation metadata");
  if (metadata.repo !== entry.repo) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
  const currentFiles = hashTweakSource(target);
  const baselineFiles = metadata.files ?? await fetchBaselineStoreTweakHashes(metadata, work, runtimeVersion);
  if (!sameFileHashes(currentFiles, baselineFiles)) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
}

function readStoreInstallMetadata(target: string): StoreInstallMetadata | null {
  const currentPath = join(target, ".tweaker-store.json");
  const legacyPath = join(target, LEGACY_STORE_METADATA);
  const metadataPath = existsSync(currentPath) ? currentPath : legacyPath;
  if (!existsSync(metadataPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<StoreInstallMetadata>;
    const bundled = parsed.source?.kind === "bundled";
    if (!bundled && (typeof parsed.repo !== "string" || typeof parsed.approvedCommitSha !== "string")) return null;
    return {
      ...(typeof parsed.repo === "string" ? { repo: parsed.repo } : {}),
      ...(typeof parsed.approvedCommitSha === "string" ? { approvedCommitSha: parsed.approvedCommitSha } : {}),
      ...(parsed.source ? { source: parsed.source } : {}),
      installedAt: typeof parsed.installedAt === "string" ? parsed.installedAt : "",
      storeIndexUrl: typeof parsed.storeIndexUrl === "string" ? parsed.storeIndexUrl : "",
      files: isHashRecord(parsed.files) ? parsed.files : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchBaselineStoreTweakHashes(
  metadata: StoreInstallMetadata,
  work: string,
  runtimeVersion: string,
): Promise<Record<string, string>> {
  if (!metadata.repo || !metadata.approvedCommitSha) {
    throw new Error("Could not verify local tweak changes before update: source baseline is not remote");
  }
  const baselineDir = join(work, "baseline");
  const archive = join(work, "baseline.tar.gz");
  const res = await fetch(`https://codeload.github.com/${metadata.repo}/tar.gz/${metadata.approvedCommitSha}`, {
    headers: { "User-Agent": `tweaker/${runtimeVersion}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Could not verify local tweak changes before update: ${res.status}`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  mkdirSync(baselineDir, { recursive: true });
  extractTarArchive(archive, baselineDir);
  const source = findTweakRoot(baselineDir);
  if (!source) throw new Error("Could not verify local tweak changes before update: baseline manifest missing");
  return hashTweakSource(source);
}

function hashTweakSource(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  collectTweakFileHashes(root, root, out);
  return out;
}

function collectTweakFileHashes(root: string, dir: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git" || name === "node_modules" || name === ".tweaker-store.json" || name === LEGACY_STORE_METADATA) continue;
    const full = join(dir, name);
    const rel = relative(root, full).split("\\").join("/");
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("Cannot verify tweak source through symlinks");
    if (stat.isDirectory()) {
      collectTweakFileHashes(root, full, out);
      continue;
    }
    if (!stat.isFile()) continue;
    out[rel] = createHash("sha256").update(readFileSync(full)).digest("hex");
  }
}

function sameFileHashes(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (key !== bk[i] || a[key] !== b[key]) return false;
  }
  return true;
}

function isHashRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

