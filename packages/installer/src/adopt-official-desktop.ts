import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { observeCodexMainProcess } from "./alerts.js";
import { readAsarMarker } from "./commands/install.js";
import { desktopVersionAdvanced, type DesktopVersionIdentity } from "./desktop-version.js";
import {
  createEnvironmentProfileRegistry,
  environmentCommitJournalFile,
  inspectEnvironmentProfile,
  publishEnvironmentSnapshot,
  readEnvironmentProfileRegistry,
  resolveEnvironmentProfile,
  validateOfficialEnvironmentProfile,
  type EnvironmentSelection,
  type EnvironmentProfileRegistry,
} from "./environment-profile.js";
import {
  environmentPreparationCapabilities,
  inspectManagedAlphaBackend,
} from "./environment-transaction.js";
import { createMcpModeBridge } from "./mcp-mode-bridge.js";
import {
  proveRegularChatGptMcpRuntime,
  readRegularChatGptMcpConfigurationChangedAt,
} from "./mcp-runtime-proof.js";
import { readPlist } from "./plist.js";
import { readState, writeState, type InstallerState } from "./state.js";

export interface AdoptOfficialDesktopFiles {
  root: string;
  installerStateFile: string;
  environmentRegistryFile: string;
  environmentSelectionFile: string;
  runtimeProofFile: string;
  mcpConfigFile: string;
  mcpStateFile: string;
  tweaksRoot: string;
  tweakersConfigFile: string;
  now: string;
}

export interface AdoptedOfficialDesktop {
  observed: DesktopVersionIdentity;
  selection: EnvironmentSelection;
  mainPid: number;
}

export interface VerifiedOfficialDesktopProof extends AdoptedOfficialDesktop {
  state: InstallerState;
  registry: EnvironmentProfileRegistry;
}

export function readDesktopVersionIdentity(appPath: string): DesktopVersionIdentity {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return {
      marketingVersion: typeof plist.CFBundleShortVersionString === "string" ? plist.CFBundleShortVersionString : null,
      build: typeof plist.CFBundleVersion === "string" ? plist.CFBundleVersion : null,
    };
  } catch {
    return { marketingVersion: null, build: null };
  }
}

export function readDesktopBundleIdentity(appPath: string): { bundleId: string | null } {
  try {
    const plist = readPlist(join(appPath, "Contents", "Info.plist"));
    return { bundleId: typeof plist.CFBundleIdentifier === "string" ? plist.CFBundleIdentifier : null };
  } catch {
    return { bundleId: null };
  }
}

/**
 * Adopt the live official desktop as the applied environment, but only when it
 * independently proves it: exact path and bundle, pristine ASAR, a version that
 * advanced past `baseline`, and a fresh visible main process that is not the
 * one the stranded transaction was holding.
 *
 * Republishing state, selection and registry is the whole point — a transaction
 * can be stranded precisely because the official updater moved underneath it,
 * which leaves every recorded fingerprint stale. Callers own their own receipt;
 * this returns the evidence rather than stamping one, so both the desktop-update
 * and environment coordinators can share the proof without sharing a schema.
 */
export function proveVerifiedOfficialDesktop(
  input: {
    selection: EnvironmentSelection;
    baseline: DesktopVersionIdentity;
    /** Main PID the stranded transaction owned; adopting it back proves nothing. */
    excludedMainPid: number | null;
  },
  files: AdoptOfficialDesktopFiles,
): VerifiedOfficialDesktopProof | null {
  const { selection } = input;
  if (selection.appExperience !== "chatgpt" || selection.backendLane !== "official-bundled") return null;

  const appPath = selection.selectedDesktopPath;
  if (readAsarMarker(join(appPath, "Contents", "Resources", "app.asar")) !== "absent") return null;
  validateOfficialEnvironmentProfile(selection);

  const observed = readDesktopVersionIdentity(appPath);
  if (!desktopVersionAdvanced(input.baseline, observed)) return null;
  if (readDesktopBundleIdentity(appPath).bundleId !== selection.selectedDesktopBundleId) return null;
  const processObservation = observeCodexMainProcess(appPath);
  if (processObservation === null
    || !processObservation.visibleWindow
    || processObservation.pid === input.excludedMainPid) {
    return null;
  }

  const state = readState(files.installerStateFile);
  const registry = readEnvironmentProfileRegistry(files.environmentRegistryFile);
  if (state === null || state.appRoot !== appPath || registry === null) return null;
  const registeredProfile = resolveEnvironmentProfile(registry, selection.releaseProfile);
  if (registeredProfile.officialPath !== selection.selectedDesktopPath
    || registeredProfile.officialBundleId !== selection.selectedDesktopBundleId
    || registeredProfile.releaseProfile !== selection.releaseProfile) {
    return null;
  }

  const appliedSelection: EnvironmentSelection = { ...selection, appliedAt: files.now };
  const mcpModeBridge = createMcpModeBridge({
    configPath: files.mcpConfigFile,
    statePath: files.mcpStateFile,
    tweaksRoot: files.tweaksRoot,
    tweakersConfigPath: files.tweakersConfigFile,
  });
  try {
    mcpModeBridge.prove("chatgpt");
  } catch (error) {
    throw new Error(
      `Official desktop recovery cannot prove the current ChatGPT MCP configuration: ${errorMessage(error)}`,
    );
  }
  const mcpRuntimeProof = proveRegularChatGptMcpRuntime({
    mainPid: processObservation.pid,
    configPath: files.mcpConfigFile,
    tweaksRoot: files.tweaksRoot,
    configurationChanged: false,
    managedConfigurationChangedAt: readRegularChatGptMcpConfigurationChangedAt(
      files.mcpStateFile,
    ),
  });
  if (!mcpRuntimeProof.ok) {
    throw new Error(
      "Official desktop recovery requires a fresh ChatGPT restart before it can adopt the live build: "
      + (mcpRuntimeProof.error ?? "regular ChatGPT MCP runtime could not be proven clean"),
    );
  }

  return {
    observed,
    selection: appliedSelection,
    mainPid: processObservation.pid,
    state,
    registry,
  };
}

/**
 * Commit a previously proven official desktop without touching app bytes or
 * reconciling MCP configuration. The proof is repeated first so a PID, bundle,
 * version, signature, or runtime change cannot be committed from stale facts.
 */
export function commitVerifiedOfficialDesktop(
  input: {
    selection: EnvironmentSelection;
    baseline: DesktopVersionIdentity;
    excludedMainPid: number | null;
  },
  proof: VerifiedOfficialDesktopProof,
  files: AdoptOfficialDesktopFiles,
): AdoptedOfficialDesktop {
  const current = proveVerifiedOfficialDesktop(input, files);
  if (current === null
    || current.mainPid !== proof.mainPid
    || current.observed.build !== proof.observed.build
    || current.observed.marketingVersion !== proof.observed.marketingVersion
    || current.selection.selectedDesktopPath !== proof.selection.selectedDesktopPath
    || current.selection.selectedDesktopBundleId !== proof.selection.selectedDesktopBundleId) {
    throw new Error("Verified official desktop recovery proof changed before commit");
  }

  const { observed, selection: appliedSelection, state, registry } = current;
  const appPath = appliedSelection.selectedDesktopPath;
  const {
    patchedAsarStat: _patchedAsarStat,
    watcherStatGuardPasses: _watcherStatGuardPasses,
    ...stateWithoutPatchedRuntimeStats
  } = state;
  const nextState: InstallerState = {
    ...stateWithoutPatchedRuntimeStats,
    appRoot: appPath,
    mode: "chatgpt",
    codexVersion: observed.marketingVersion,
    codexChannel: appliedSelection.releaseProfile === "alpha" ? "beta" : "stable",
    codexBundleId: appliedSelection.selectedDesktopBundleId,
  };

  const capabilities = environmentPreparationCapabilities();
  const managedAlpha = inspectManagedAlphaBackend(files.root);
  const stableEvidence = inspectEnvironmentProfile(registry.profiles.stable, appliedSelection);
  const alphaEvidence = inspectEnvironmentProfile(registry.profiles.alpha, appliedSelection);
  alphaEvidence.backendVersion = managedAlpha.installed ? managedAlpha.version : null;
  alphaEvidence.backendFingerprint = managedAlpha.installed ? managedAlpha.fingerprint : null;
  const nextRegistry = createEnvironmentProfileRegistry({
    stableDesktopPath: registry.profiles.stable.officialPath,
    alphaDesktopPath: registry.profiles.alpha.officialPath,
    environmentRoot: files.root,
    selected: appliedSelection,
    lastKnownWorkingSelection: appliedSelection,
    stableEvidence: {
      ...stableEvidence,
      patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
    },
    alphaEvidence: {
      ...alphaEvidence,
      backendInstallable: capabilities.backendInstallable,
      patchedPayloadBuildable: capabilities.patchedPayloadBuildable,
    },
  });

  const snapshots = [
    snapshotFile(files.installerStateFile),
    snapshotFile(files.environmentRegistryFile),
    snapshotFile(files.environmentSelectionFile),
    snapshotFile(environmentCommitJournalFile(files.environmentRegistryFile)),
    snapshotFile(files.runtimeProofFile),
  ];
  try {
    writeState(files.installerStateFile, nextState);
    publishEnvironmentSnapshot(
      files.environmentRegistryFile,
      files.environmentSelectionFile,
      nextRegistry,
      appliedSelection,
    );
    // The recorded runtime proof described the environment that just went away.
    rmSync(files.runtimeProofFile, { force: true });
  } catch (error) {
    let restoreFailure: unknown = null;
    for (const snapshot of snapshots.reverse()) {
      try {
        restoreFile(snapshot);
      } catch (restoreError) {
        restoreFailure ??= restoreError;
      }
    }
    throw new Error(
      `Official desktop recovery state commit failed: ${errorMessage(error)}`
      + (restoreFailure === null ? "" : `; state rollback failed: ${errorMessage(restoreFailure)}`),
    );
  }

  return { observed, selection: appliedSelection, mainPid: current.mainPid };
}

/** Marker prefix that proves an environment receipt reached this outcome. */
export const OFFICIAL_ADOPTION_MESSAGE = "Recovered by adopting the verified live official ChatGPT update.";

export function officialAdoptionError(previousError: string | null | undefined): string {
  const previousFailure = previousError?.trim() ?? "";
  if (previousFailure.startsWith(OFFICIAL_ADOPTION_MESSAGE)) return previousFailure;
  return `${OFFICIAL_ADOPTION_MESSAGE}${previousFailure ? ` Previous failure: ${previousFailure}` : ""}`;
}

interface FileSnapshot {
  path: string;
  bytes: Buffer | null;
  mode: number | null;
}

function snapshotFile(path: string): FileSnapshot {
  return existsSync(path)
    ? { path, bytes: readFileSync(path), mode: statSync(path).mode & 0o7777 }
    : { path, bytes: null, mode: null };
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.bytes === null) {
    rmSync(snapshot.path, { force: true });
    return;
  }
  mkdirSync(dirname(snapshot.path), { recursive: true });
  const temporary = `${snapshot.path}.${process.pid}.${Date.now()}.restore`;
  try {
    writeFileSync(temporary, snapshot.bytes, { mode: snapshot.mode ?? 0o600 });
    chmodSync(temporary, snapshot.mode ?? 0o600);
    renameSync(temporary, snapshot.path);
    chmodSync(snapshot.path, snapshot.mode ?? 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
