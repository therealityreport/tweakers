/**
 * Read/write the ElectronAsarIntegrity entry inside Info.plist (macOS).
 * On Windows/Linux, Electron stores integrity in a sidecar `resources/integrity`
 * JSON-ish blob — we read it from a known location at the package root.
 */
import { readPlist, writePlist } from "./plist.js";
import type { CodexInstall } from "./platform.js";

export interface IntegrityEntry {
  algorithm: "SHA256";
  hash: string;
}

export function getIntegrity(install: CodexInstall): IntegrityEntry | null {
  if (install.platform !== "darwin" || !install.metaPath) return null; // see TODO below
  const pl = readPlist(install.metaPath);
  const block = pl["ElectronAsarIntegrity"] as Record<string, IntegrityEntry> | undefined;
  if (!block) return null;
  return block["Resources/app.asar"] ?? null;
}

export function setIntegrity(install: CodexInstall, hash: string): void {
  if (install.platform !== "darwin" || !install.metaPath) {
    // TODO(win/linux): On Windows, integrity is stored in PE resources of
    // the main exe and read by the framework; on Linux it's in
    // `resources/electron-asar-integrity.txt` (varies by Electron version).
    // We rely on the fuse flip there, which makes integrity validation a
    // no-op. If you re-enable integrity on those platforms, this needs
    // platform-specific writers.
    return;
  }
  const pl = readPlist(install.metaPath);
  const existing = (pl["ElectronAsarIntegrity"] as Record<string, IntegrityEntry>) ?? {};
  existing["Resources/app.asar"] = { algorithm: "SHA256", hash };
  pl["ElectronAsarIntegrity"] = existing;
  writePlist(install.metaPath, pl);
}
