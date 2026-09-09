/**
 * Read/write the ElectronAsarIntegrity entry inside Info.plist (macOS).
 * On Windows/Linux, Electron stores integrity in a sidecar `resources/integrity`
 * JSON-ish blob — we read it from a known location at the package root.
 */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readHeaderHash } from "./asar.js";
import { readPlist, writePlist } from "./plist.js";
import type { CodexInstall } from "./platform.js";

type IntegrityInstall = Pick<CodexInstall, "platform" | "metaPath" | "resourcesDir">;

export interface IntegrityEntry {
  algorithm: "SHA256";
  hash: string;
}

export function getIntegrity(install: IntegrityInstall): IntegrityEntry | null {
  if (install.platform !== "darwin" || !install.metaPath) return null; // see TODO below
  const pl = readPlist(install.metaPath);
  const block = pl["ElectronAsarIntegrity"] as Record<string, IntegrityEntry> | undefined;
  if (!block) return null;
  return block["Resources/app.asar"] ?? null;
}

export function setIntegrity(install: IntegrityInstall, hash: string): void {
  if (install.platform !== "darwin" || !install.metaPath) {
    // TODO(win/linux): On Windows, integrity is stored in PE resources of
    // the main exe and read by the framework; on Linux it's in
    // `resources/electron-asar-integrity.txt` (varies by Electron version).
    // We rely on the fuse flip there, which makes integrity validation a
    // no-op. If you re-enable integrity on those platforms, this needs
    // platform-specific writers.
    return;
  }
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error("app.asar integrity hash must be one SHA-256 digest");
  }
  const pl = readPlist(install.metaPath);
  const current = pl["ElectronAsarIntegrity"];
  const existing = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, IntegrityEntry>
    : {};
  const archives = resourceAsarArchives(install);
  for (const archive of archives) {
    const archiveHash = archive.key === "Resources/app.asar"
      ? hash.toLowerCase()
      : readHeaderHash(archive.path).headerHash.toLowerCase();
    existing[archive.key] = { algorithm: "SHA256", hash: archiveHash };
  }
  pl["ElectronAsarIntegrity"] = existing;
  writePlist(install.metaPath, pl);
  assertResourceAsarIntegrity(install);
}

/**
 * Electron validates every bundle-relative ASAR that it opens while the
 * embedded-integrity fuse is enabled.  A desktop release may add another
 * top-level archive (for example busy-bar.asar), so candidate validation must
 * prove the complete Resources/*.asar set rather than only app.asar.
 */
export function assertResourceAsarIntegrity(install: IntegrityInstall): void {
  if (install.platform !== "darwin" || !install.metaPath) return;
  const pl = readPlist(install.metaPath);
  const current = pl["ElectronAsarIntegrity"];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error("ElectronAsarIntegrity is missing or malformed");
  }
  const entries = current as Record<string, IntegrityEntry>;
  for (const archive of resourceAsarArchives(install)) {
    const entry = entries[archive.key];
    const actual = readHeaderHash(archive.path).headerHash.toLowerCase();
    if (entry?.algorithm !== "SHA256"
      || typeof entry.hash !== "string"
      || entry.hash.toLowerCase() !== actual) {
      throw new Error(`ElectronAsarIntegrity does not match ${archive.key}`);
    }
  }
}

interface ResourceAsarArchive {
  key: `Resources/${string}`;
  path: string;
}

function resourceAsarArchives(install: IntegrityInstall): ResourceAsarArchive[] {
  const resources = realpathSync(install.resourcesDir);
  const archives: ResourceAsarArchive[] = [];
  for (const name of readdirSync(resources).filter((entry) => entry.endsWith(".asar")).sort()) {
    const path = join(resources, name);
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) {
      throw new Error(`Refusing unsafe Electron ASAR resource: Resources/${name}`);
    }
    if (realpathSync(path) !== path) {
      throw new Error(`Refusing non-canonical Electron ASAR resource: Resources/${name}`);
    }
    archives.push({ key: `Resources/${name}`, path });
  }
  if (!archives.some((archive) => archive.key === "Resources/app.asar")) {
    throw new Error("Resources/app.asar is missing from the Electron bundle");
  }
  return archives;
}
