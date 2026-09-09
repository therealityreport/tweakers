import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readManagedRuntimeFingerprintEvidence,
  type ManagedRuntimeTreeFingerprint,
} from "./managed-runtime.js";
import { readRuntimeFingerprintEvidence, type RuntimeTreeFingerprint } from "./runtime-fingerprint.js";

const SHA256_HEX = /^[a-f0-9]{64}$/;
export const SEALED_MANAGER_SUPPORT_DIRECTORY = ".manager-support" as const;
export const REQUIRED_SEALED_MANAGER_SUPPORT_FILES = [
  "loader.cjs",
  "protected-loader.cjs",
  "tweakers.icns",
  "tweakers.png",
  join("app-launcher", "Tweakers App Launcher"),
  join("swap-helper", "Tweakers Swap Helper.app", "Contents", "MacOS", "Tweakers Swap Helper"),
] as const;

// Replaced with one literal digest only in the sealed manager bundle. Ordinary
// installer/CLI builds intentionally leave it undefined and use their normal
// packaged or development asset discovery.
declare const __TWEAKERS_MANAGER_RUNTIME_FINGERPRINT__: string | undefined;
declare const __TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT__: string | undefined;

export interface SealedManagerRuntimeAssets {
  fingerprint: string;
  root: string;
}

export interface SealedManagerManagedRuntimeAssets {
  fingerprint: string;
  root: string;
}

export interface SealedManagerSupportAssets {
  fingerprint: string;
  root: string;
  runtime: SealedManagerRuntimeAssets;
}

export function resolveSealedManagerRuntimeAssets(): SealedManagerRuntimeAssets | null {
  const fingerprint = typeof __TWEAKERS_MANAGER_RUNTIME_FINGERPRINT__ === "undefined"
    ? null
    : __TWEAKERS_MANAGER_RUNTIME_FINGERPRINT__;
  if (fingerprint === null) return null;
  if (!SHA256_HEX.test(fingerprint)) {
    throw new Error("The sealed Tweakers manager has an invalid compiled runtime fingerprint");
  }
  const generationRoot = dirname(fileURLToPath(import.meta.url));
  return {
    fingerprint,
    root: resolve(generationRoot, "..", "..", "runtime-generations", fingerprint),
  };
}

/**
 * Resolve the immutable control-plane source independently from Electron's
 * active runtime. This is intentionally side-effect free; callers must verify
 * the tree immediately before staging it into a transaction receipt.
 */
export function resolveSealedManagerManagedRuntimeAssets(): SealedManagerManagedRuntimeAssets | null {
  const fingerprint = typeof __TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT__ === "undefined"
    ? null
    : __TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT__;
  if (fingerprint === null) return null;
  if (!SHA256_HEX.test(fingerprint)) {
    throw new Error("The sealed Tweakers manager has an invalid compiled managed-runtime fingerprint");
  }
  const generationRoot = dirname(fileURLToPath(import.meta.url));
  return {
    fingerprint,
    root: resolve(generationRoot, "..", "..", "managed-runtime-generations", fingerprint),
  };
}

/**
 * Installer-only files needed by a sealed manager live inside the exact
 * content-addressed runtime generation that the manager bundle already pins.
 * Resolving is intentionally side-effect free so ordinary status requests do
 * not hash the tree; every mutation path verifies it immediately before use.
 */
export function resolveSealedManagerSupportAssets(): SealedManagerSupportAssets | null {
  const runtime = resolveSealedManagerRuntimeAssets();
  if (runtime === null) return null;
  return {
    fingerprint: runtime.fingerprint,
    root: resolve(runtime.root, SEALED_MANAGER_SUPPORT_DIRECTORY),
    runtime,
  };
}

export function verifySealedManagerRuntimeAssets(
  assets: SealedManagerRuntimeAssets,
): RuntimeTreeFingerprint {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const assertDirectory = (path: string, label: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error(`${label} must be a real directory`);
    }
    if ((uid !== null && stat.uid !== uid) || (stat.mode & 0o7777) !== 0o700) {
      throw new Error(`${label} has an unsafe owner or mode`);
    }
  };
  assertDirectory(dirname(assets.root), "Tweakers manager runtime generations root");
  assertDirectory(assets.root, "Tweakers manager runtime generation");
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (entry.isDirectory()) {
        assertDirectory(path, "Tweakers manager runtime directory");
        walk(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const mode = stat.mode & 0o7777;
        if (realpathSync(path) !== path || stat.nlink !== 1
          || (uid !== null && stat.uid !== uid)
          || (mode !== 0o400 && mode !== 0o500)) {
          throw new Error("Tweakers manager runtime file has an unsafe identity, owner, or mode");
        }
      } else {
        throw new Error("Tweakers manager runtime contains a symlink or unsupported entry");
      }
    }
  };
  walk(assets.root);
  const evidence = readRuntimeFingerprintEvidence(assets.root);
  if (evidence === null || evidence.fingerprint !== assets.fingerprint) {
    throw new Error("The sealed Tweakers manager runtime failed its compiled fingerprint");
  }
  return evidence;
}

export function verifySealedManagerManagedRuntimeAssets(
  assets: SealedManagerManagedRuntimeAssets,
): ManagedRuntimeTreeFingerprint {
  assertSealedManagerGenerationTree(
    assets.root,
    assets.fingerprint,
    "Tweakers manager managed-runtime",
  );
  const evidence = readManagedRuntimeFingerprintEvidence(assets.root);
  if (evidence === null || evidence.fingerprint !== assets.fingerprint) {
    throw new Error("The sealed Tweakers manager managed-runtime failed its compiled fingerprint");
  }
  return evidence;
}

function assertSealedManagerGenerationTree(root: string, fingerprint: string, label: string): void {
  if (basename(root) !== fingerprint) {
    throw new Error(`${label} generation path does not match its fingerprint`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const assertDirectory = (path: string, directoryLabel: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error(`${directoryLabel} must be a real directory`);
    }
    if ((uid !== null && stat.uid !== uid) || (stat.mode & 0o7777) !== 0o700) {
      throw new Error(`${directoryLabel} has an unsafe owner or mode`);
    }
  };
  assertDirectory(dirname(root), `${label} generations root`);
  assertDirectory(root, `${label} generation`);
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      const stat = lstatSync(path);
      if (entry.isDirectory()) {
        assertDirectory(path, `${label} directory`);
        walk(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        const mode = stat.mode & 0o7777;
        if (realpathSync(path) !== path || stat.nlink !== 1
          || (uid !== null && stat.uid !== uid)
          || (mode !== 0o400 && mode !== 0o500)) {
          throw new Error(`${label} file has an unsafe identity, owner, or mode`);
        }
      } else {
        throw new Error(`${label} contains a symlink or unsupported entry`);
      }
    }
  };
  walk(root);
}


export function verifySealedManagerSupportAssets(
  assets: SealedManagerSupportAssets,
): RuntimeTreeFingerprint {
  if (
    assets.fingerprint !== assets.runtime.fingerprint
    || dirname(assets.root) !== assets.runtime.root
    || basename(assets.root) !== SEALED_MANAGER_SUPPORT_DIRECTORY
  ) {
    throw new Error("The sealed Tweakers manager support path is not bound to its runtime generation");
  }
  const evidence = verifySealedManagerRuntimeAssets(assets.runtime);
  let stat;
  try {
    stat = lstatSync(assets.root);
  } catch {
    throw new Error("The sealed Tweakers manager support assets are missing");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || realpathSync(assets.root) !== assets.root
    || (uid !== null && stat.uid !== uid)
    || (stat.mode & 0o7777) !== 0o700
  ) {
    throw new Error("The sealed Tweakers manager support assets have an unsafe identity, owner, or mode");
  }
  for (const relativePath of REQUIRED_SEALED_MANAGER_SUPPORT_FILES) {
    const path = join(assets.root, relativePath);
    let file;
    try {
      file = lstatSync(path);
    } catch {
      throw new Error(`The sealed Tweakers manager support asset is missing: ${relativePath}`);
    }
    if (!file.isFile() || file.isSymbolicLink() || realpathSync(path) !== path || file.nlink !== 1) {
      throw new Error(`The sealed Tweakers manager support asset has an unsafe identity: ${relativePath}`);
    }
  }
  return evidence;
}
