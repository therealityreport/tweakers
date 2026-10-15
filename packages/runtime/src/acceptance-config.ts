import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, writeSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const ACCEPTANCE_CONFIG_ENV = "TWEAKERS_ACCEPTANCE_CONFIG_FILE";
export const ACCEPTANCE_TWEAK_IDS = [
  "co.tweakers.developer-tools", "co.tweakers.followup", "co.tweakers.usage-limit-resets-tracker",
] as const;
const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Config = Record<string, unknown>;
function fail(): never { throw new Error("Acceptance configuration is invalid or changed; acceptance must stop"); }
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Config => !!value && typeof value === "object" && !Array.isArray(value);

export interface AcceptanceConfig {
  readonly path: string;
  readonly directory: string;
  readonly rejectedWrites: number;
  read(): Config;
  write(value: Config): void;
  close(): void;
}

/** Acceptance diagnostics stay in memory. No diagnostic descendant is a sink,
 * even when a valid acceptance directory contains a linked diagnostic leaf. */
export function runRuntimeDiagnosticDiskOperation<T>(acceptance: AcceptanceConfig | null, operation: () => T): T | undefined {
  if (acceptance) { acceptance.read(); return undefined; }
  return operation();
}

/** The override changes settings only: no data-root, account, or backend routing. */
export function resolveAcceptanceConfig(input: {
  userRoot: string;
  derivedVariant: boolean;
  healthCheckOnly: boolean;
  environment?: NodeJS.ProcessEnv;
}): AcceptanceConfig | null {
  const requested = (input.environment ?? process.env)[ACCEPTANCE_CONFIG_ENV];
  if (requested === undefined) return null;
  if (!input.derivedVariant || input.healthCheckOnly || !requested
    || !isAbsolute(input.userRoot) || resolve(input.userRoot) !== input.userRoot
    || !isAbsolute(requested) || resolve(requested) !== requested) fail();
  const parts = relative(join(input.userRoot, "acceptance"), requested).split(/[\\/]/);
  if (parts.length !== 2 || !UUID.test(parts[0]) || parts[1] !== "config.json") fail();
  const canonicalPath = join(input.userRoot, "config.json");
  const directory = dirname(requested);
  const parents = [input.userRoot, join(input.userRoot, "acceptance"), directory];
  const uid = process.getuid?.();
  if (uid === undefined || constants.O_NOFOLLOW === undefined) fail();
  const parentIdentities = parents.map((path, index) => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path
      || stat.uid !== uid || (index > 0 && (stat.mode & 0o777) !== 0o700)) fail();
    return stat;
  });
  function checkParents(): void {
    parents.forEach((path, index) => {
      const stat = lstatSync(path);
      if (!sameFile(stat, parentIdentities[index]) || !stat.isDirectory()
        || stat.isSymbolicLink() || stat.uid !== uid || realpathSync(path) !== path
        || (index > 0 && (stat.mode & 0o777) !== 0o700)) fail();
    });
  }
  function openFile(path: string, writable: boolean, identity?: Stats): number {
    checkParents();
    const fd = openSync(path, (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      const named = lstatSync(path);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size > MAX_BYTES
        || named.isSymbolicLink() || !sameFile(stat, named)
        || (identity && !sameFile(stat, identity))
        || (writable && (stat.mode & 0o777) !== 0o600)) fail();
      checkParents();
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  function bytes(fd: number): Buffer {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1 || stat.uid !== uid) fail();
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const count = readSync(fd, result, offset, result.length - offset, offset);
      if (!count) fail();
      offset += count;
    }
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) fail();
    return result;
  }
  function parse(value: Buffer): Config {
    let config: unknown;
    try { config = JSON.parse(value.toString("utf8")); } catch { fail(); }
    if (!record(config)) fail();
    return config;
  }
  const canonicalFd = openFile(canonicalPath, false);
  let pinnedFd: number | undefined;
  try {
    const canonicalIdentity = fstatSync(canonicalFd);
    const canonicalBytes = bytes(canonicalFd);
    const canonicalHash = digest(canonicalBytes);
    const baseline = parse(canonicalBytes);
    // Ordinary configuration migration must finish before this narrow launch.
    if (Object.prototype.hasOwnProperty.call(baseline, ["codex", "Plus", "Plus"].join(""))) fail();
    if (!record(baseline.tweaks)) fail();
    for (const id of ACCEPTANCE_TWEAK_IDS) {
      const tweak = baseline.tweaks[id];
      if (!record(tweak) || tweak.enabled !== false) fail();
    }
    pinnedFd = openFile(requested, true);
    const sink = pinnedFd;
    const identity = fstatSync(sink);
    if (sameFile(identity, canonicalIdentity)) fail();
    let closed = false;
    let invalid = false;
    let rejectedWrites = 0;
    function validate(value: Config): void {
      const normalized: unknown = JSON.parse(JSON.stringify(value));
      if (!record(normalized) || !record(normalized.tweaks)) fail();
      for (const id of ACCEPTANCE_TWEAK_IDS) {
        const tweak = normalized.tweaks[id];
        if (!record(tweak) || typeof tweak.enabled !== "boolean") fail();
        tweak.enabled = false;
      }
      if (!isDeepStrictEqual(normalized, baseline)) fail();
    }
    function read(): Config {
      if (closed || invalid) fail();
      try {
        const currentCanonical = openFile(canonicalPath, false, canonicalIdentity);
        try {
          const stat = fstatSync(currentCanonical);
          if (stat.mode !== canonicalIdentity.mode || stat.mtimeMs !== canonicalIdentity.mtimeMs
            || stat.ctimeMs !== canonicalIdentity.ctimeMs || digest(bytes(currentCanonical)) !== canonicalHash) fail();
        }
        finally { closeSync(currentCanonical); }
        const current = openFile(requested!, true, identity);
        try {
          const value = parse(bytes(current));
          validate(value);
          return value;
        } finally { closeSync(current); }
      } catch (error) { invalid = true; throw error; }
    }
    read();
    return {
      path: requested, directory, read,
      get rejectedWrites() { return rejectedWrites; },
      write(value) {
        read();
        let content: Buffer;
        try {
          content = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
          if (content.length > MAX_BYTES) fail();
          validate(parse(content));
        } catch (error) { rejectedWrites++; throw error; }
        const stat = fstatSync(sink);
        if (!sameFile(stat, identity) || stat.nlink !== 1 || stat.uid !== uid
          || !stat.isFile() || (stat.mode & 0o777) !== 0o600) fail();
        // This disposable file deliberately uses the pinned descriptor instead
        // of a path-based rename. A directory swap cannot redirect the write.
        try {
          let offset = 0;
          while (offset < content.length) {
            const count = writeSync(sink, content, offset, content.length - offset, offset);
            if (!count) fail();
            offset += count;
          }
          ftruncateSync(sink, content.length);
          fsyncSync(sink);
          read();
        } catch (error) { invalid = true; throw error; }
      },
      close() { if (!closed) { closed = true; closeSync(sink); } },
    };
  } catch (error) {
    if (pinnedFd !== undefined) closeSync(pinnedFd);
    throw error;
  } finally { closeSync(canonicalFd); }
}
