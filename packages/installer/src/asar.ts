/**
 * asar helpers. We don't crack open the binary header ourselves; we use
 * @electron/asar which is well-maintained and matches the format Electron expects.
 *
 * The integrity hash Electron checks is the SHA-256 of the asar **header JSON**
 * (the leading length-prefixed JSON blob), not the entire file. @electron/asar
 * exposes this via `getRawHeader()`.
 */
import asar from "@electron/asar";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";

export interface AsarHeaderInfo {
  /** SHA-256 hex of the header JSON bytes Electron hashes. */
  headerHash: string;
  /** The decoded header object (the directory tree). */
  header: unknown;
}

export interface PatchAsarDependencies {
  copyFile?: (from: string, to: string) => void;
  createPackage?: typeof asar.createPackageWithOptions;
}

interface CompleteAsarInfo extends AsarHeaderInfo {
  archiveSize: bigint;
}

interface AsarIntegrity {
  algorithm?: unknown;
  hash?: unknown;
}

interface AsarEntry {
  files?: Record<string, AsarEntry>;
  integrity?: AsarIntegrity;
  link?: unknown;
  offset?: unknown;
  size?: unknown;
  unpacked?: unknown;
}

interface PackedAsarEntry {
  integrity: AsarIntegrity;
  offset: bigint;
  path: string;
  size: number;
}

/**
 * @electron/asar caches the parsed filesystem header per archive path for
 * `extractFile`. When we rewrite an asar in place (same path), that cache goes
 * stale and later reads return the PRE-patch contents. Drop the cache entry
 * whenever we read or write so callers in the same process never see a stale
 * package.json (this is exactly what made candidate validation fail: the patch
 * marker was present on disk but `extractFile` returned the cached original).
 */
function uncacheAsar(asarPath: string): void {
  try {
    (asar as unknown as { uncache?: (p: string) => boolean }).uncache?.(asarPath);
  } catch {
    /* uncache is best-effort; a missing entry is a no-op */
  }
}

export function readHeaderHash(asarPath: string): AsarHeaderInfo {
  // getRawHeader returns { header, headerString, headerSize }
  const raw = (asar as unknown as {
    getRawHeader: (p: string) => { header: unknown; headerString: string };
  }).getRawHeader(asarPath);
  const hash = createHash("sha256").update(raw.headerString).digest("hex");
  return { headerHash: hash, header: raw.header };
}

/**
 * Extract → mutate via callback → repack. The callback receives a temp dir
 * containing the unpacked asar contents and may modify files in place.
 * Returns the new header hash post-repack.
 *
 * We must preserve the original asar's unpacked-file set EXACTLY: marking a
 * file `unpacked: true` in the header tells Electron to read it from
 * `app.asar.unpacked/` instead of inline. If we accidentally mark a file
 * unpacked that isn't actually present in the .unpacked/ sibling dir,
 * `require` will fail with MODULE_NOT_FOUND.
 */
export async function patchAsar(
  asarPath: string,
  mutate: (extractedDir: string) => Promise<void> | void,
  dependencies: PatchAsarDependencies = {},
): Promise<AsarHeaderInfo> {
  const work = mkdtempSync(join(tmpdir(), "cxx-asar-"));
  const extractDir = join(work, "src");
  const outAsar = join(work, "app.asar");

  // Snapshot what was unpacked in the ORIGINAL asar before we touch anything;
  // we'll feed an equivalent compact set back to createPackageWithOptions.
  const originalUnpackOptions = collectUnpackOptions(asarPath);

  try {
    asar.extractAll(asarPath, extractDir);
    await mutate(extractDir);

    const output = await (dependencies.createPackage ?? asar.createPackageWithOptions)(extractDir, outAsar, {
      globOptions: { dot: true },
      ...originalUnpackOptions,
    });
    // @electron/asar 3.4.1 resolves createPackageWithOptions() with its output
    // stream immediately after calling end(), before the stream necessarily
    // emits finish. Do not read or copy the archive until every queued byte has
    // reached the file and late stream errors can no longer surface.
    await finished(output);
    const packedArchive = validateCompleteAsar(outAsar);

    // Atomic-ish replace: write next to the target, then rename. This prevents
    // a denied write (e.g. macOS App Management TCC) from leaving the bundle
    // without an app.asar. Both the staging file and target must be on the
    // same filesystem for `rename` to be atomic.
    const stagingPath = `${asarPath}.tweaker-new`;
    try {
      (dependencies.copyFile ?? cpSync)(outAsar, stagingPath);
      const stagedArchive = validateCompleteAsar(stagingPath);
      if (
        stagedArchive.archiveSize !== packedArchive.archiveSize
        || stagedArchive.headerHash !== packedArchive.headerHash
      ) {
        throw new Error(`Incomplete ASAR archive at ${stagingPath}: staged copy does not match packed output`);
      }
      renameSync(stagingPath, asarPath);
      // The on-disk asar just changed underneath any cached header for this path.
      uncacheAsar(asarPath);
      return { headerHash: stagedArchive.headerHash, header: stagedArchive.header };
    } catch (e) {
      throw annotatePermError(e, asarPath);
    } finally {
      // A failed copy can still leave a partial file. Use the same cleanup path
      // for copy, rename, and post-replace verification failures.
      try { unlinkSync(stagingPath); } catch { /* already moved/absent */ }
    }
  } finally {
    await cleanupTempTree(work);
  }
}

/**
 * Reject archives whose declared packed payload does not reach the physical
 * EOF, then verify the integrity hash of the packed entry that reaches EOF.
 * The EOF check catches a short pack/copy without reading the whole archive;
 * hashing the final entry also proves that the tail is readable and complete.
 */
function validateCompleteAsar(asarPath: string): CompleteAsarInfo {
  uncacheAsar(asarPath);
  const raw = (asar as unknown as {
    getRawHeader: (p: string) => { header: AsarEntry; headerString: string; headerSize: number };
  }).getRawHeader(asarPath);
  const headerHash = createHash("sha256").update(raw.headerString).digest("hex");
  const packedEntries: PackedAsarEntry[] = [];
  collectPackedEntries(raw.header, "", packedEntries);

  let payloadSize = 0n;
  let finalEntry: PackedAsarEntry | undefined;
  for (const entry of packedEntries) {
    const end = entry.offset + BigInt(entry.size);
    if (
      end > payloadSize
      || (end === payloadSize && entry.size > (finalEntry?.size ?? -1))
    ) {
      payloadSize = end;
      finalEntry = entry;
    }
  }

  const archiveSize = statSync(asarPath, { bigint: true }).size;
  const expectedSize = 8n + BigInt(raw.headerSize) + payloadSize;
  if (archiveSize !== expectedSize) {
    throw new Error(
      `Incomplete ASAR archive at ${asarPath}: expected EOF at ${expectedSize}, found ${archiveSize}`,
    );
  }

  if (finalEntry) verifyPackedEntryIntegrity(asarPath, raw.headerSize, finalEntry);
  return { archiveSize, headerHash, header: raw.header };
}

function collectPackedEntries(
  entry: AsarEntry,
  parentPath: string,
  packedEntries: PackedAsarEntry[],
): void {
  if (entry.files) {
    for (const [name, child] of Object.entries(entry.files)) {
      collectPackedEntries(child, parentPath ? `${parentPath}/${name}` : name, packedEntries);
    }
    return;
  }
  if (entry.unpacked || typeof entry.link === "string") return;

  if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) {
    throw new Error(`Invalid packed ASAR entry size for ${parentPath}`);
  }
  if (typeof entry.offset !== "string" || !/^\d+$/.test(entry.offset)) {
    throw new Error(`Invalid packed ASAR entry offset for ${parentPath}`);
  }
  if (!entry.integrity || entry.integrity.algorithm !== "SHA256") {
    throw new Error(`Missing SHA256 integrity for packed ASAR entry ${parentPath}`);
  }
  if (typeof entry.integrity.hash !== "string" || !/^[a-f0-9]{64}$/i.test(entry.integrity.hash)) {
    throw new Error(`Invalid SHA256 integrity for packed ASAR entry ${parentPath}`);
  }

  packedEntries.push({
    integrity: entry.integrity,
    offset: BigInt(entry.offset),
    path: parentPath,
    size: entry.size as number,
  });
}

function verifyPackedEntryIntegrity(asarPath: string, headerSize: number, entry: PackedAsarEntry): void {
  const absoluteOffset = 8n + BigInt(headerSize) + entry.offset;
  if (absoluteOffset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Packed ASAR entry offset exceeds the safe read range for ${entry.path}`);
  }

  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(entry.size, 1024 * 1024));
  const fd = openSync(asarPath, "r");
  let bytesRead = 0;
  try {
    while (bytesRead < entry.size) {
      const length = Math.min(buffer.length, entry.size - bytesRead);
      const count = readSync(fd, buffer, 0, length, Number(absoluteOffset) + bytesRead);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytesRead += count;
    }
  } finally {
    closeSync(fd);
  }

  if (bytesRead !== entry.size) {
    throw new Error(
      `Incomplete ASAR archive at ${asarPath}: could not read ${entry.path} through its declared EOF`,
    );
  }
  if (hash.digest("hex") !== entry.integrity.hash) {
    throw new Error(`Corrupt ASAR archive at ${asarPath}: integrity mismatch for ${entry.path}`);
  }
}

export async function cleanupTempTree(path: string): Promise<void> {
  const retryDelaysMs = [25, 75, 150, 300, 600];
  for (const waitMs of [0, ...retryDelaysMs]) {
    if (waitMs > 0) await delay(waitMs);
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (e) {
      if (!isTransientCleanupError(e)) return;
    }
  }
}

function isTransientCleanupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

/**
 * Walk the existing asar header and produce compact glob options that preserve
 * exactly what was unpacked. Prefer unpackDir for fully-unpacked directories,
 * falling back to unpack for individual files.
 *
 * Why this matters: if the header marks a file `unpacked: true` but the file
 * isn't on disk under `app.asar.unpacked/`, Electron's resolver throws
 * MODULE_NOT_FOUND when something requires the module. The current Owl app also
 * has hundreds of unpacked files, so preserving each file with one giant glob
 * can exceed minimatch's pattern length limit.
 */
export function collectUnpackOptions(asarPath: string): { unpack?: string; unpackDir?: string } {
  const sibling = `${asarPath}.unpacked`;
  if (!existsSync(sibling)) return {};
  const raw = (asar as unknown as {
    getRawHeader: (p: string) => { header: { files?: Record<string, unknown> } };
  }).getRawHeader(asarPath);
  const covers = unpackCovers(raw.header as Record<string, unknown>, "").covers;
  const dirs = covers
    .filter((cover) => cover.type === "dir")
    .map((cover) => stripLeadingSlash(cover.path));
  const files = covers
    .filter((cover) => cover.type === "file")
    .map((cover) => `**/${stripLeadingSlash(cover.path)}`);
  return {
    ...(files.length > 0 ? { unpack: bracePattern(files) } : {}),
    ...(dirs.length > 0 ? { unpackDir: bracePattern(dirs) } : {}),
  };
}

interface UnpackCover {
  type: "dir" | "file";
  path: string;
}

function unpackCovers(
  node: Record<string, unknown>,
  prefix: string,
): { total: number; unpacked: number; covers: UnpackCover[] } {
  const files = (node as { files?: Record<string, Record<string, unknown>> }).files;
  if (!files) return { total: 0, unpacked: 0, covers: [] };

  let total = 0;
  let unpacked = 0;
  const covers: UnpackCover[] = [];

  for (const [name, val] of Object.entries(files)) {
    const p = `${prefix}/${name}`;
    const isDir = !!(val as { files?: unknown }).files;
    if (isDir) {
      const child = unpackCovers(val, p);
      total += child.total;
      unpacked += child.unpacked;
      covers.push(...child.covers);
      continue;
    }

    total += 1;
    if ((val as { unpacked?: boolean }).unpacked) {
      unpacked += 1;
      covers.push({ type: "file", path: p });
    }
  }

  if (prefix && total > 0 && total === unpacked) {
    return { total, unpacked, covers: [{ type: "dir", path: prefix }] };
  }
  return { total, unpacked, covers };
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function bracePattern(patterns: string[]): string {
  return patterns.length === 1 ? patterns[0] : `{${patterns.join(",")}}`;
}

/** Backup helper: copy `from` to `to` if `to` doesn't already exist. */
export function backupOnce(from: string, to: string): void {
  if (!existsSync(to)) cpSync(from, to, { recursive: true });
}

/** Read a file inside the asar without extracting the whole thing. */
export function readFileInAsar(asarPath: string, relPath: string): Buffer {
  // Defensive: never trust a possibly-stale cached header for this path.
  uncacheAsar(asarPath);
  return asar.extractFile(asarPath, relPath) as Buffer;
}

/**
 * Wrap EPERM/EACCES errors writing into an app bundle with an actionable
 * message about macOS App Management permission. Other errors pass through.
 */
function annotatePermError(e: unknown, target: string): Error {
  const err = e as NodeJS.ErrnoException;
  if (err && (err.code === "EPERM" || err.code === "EACCES") && /\/Applications\//.test(target)) {
    const msg =
      `Permission denied writing to ${target}.\n\n` +
      `macOS App Management is blocking modification of /Applications/Codex.app.\n` +
      `Run "tweaker repair" in your terminal.\n\n` +
      `Original error: ${err.message}`;
    const wrapped = new Error(msg);
    (wrapped as NodeJS.ErrnoException).code = err.code;
    return wrapped;
  }
  return err instanceof Error ? err : new Error(String(err));
}
