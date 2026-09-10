/**
 * Fixed, source-only desktop handoff entrypoints.
 *
 * The mutation itself stays in portable-settings-continuity. This module owns
 * the production binding: fixed endpoints, source evidence, sealed native
 * inventory reader, and narrowly scoped launch sequencing. It intentionally
 * accepts no caller-selected paths, credentials, broker connection, or SQLite
 * handle.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { basename, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { readFileInAsar, readHeaderHash } from "./asar.js";
import {
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  type EndpointKey,
  type Sha256,
} from "./portable-continuity-projection.js";
import {
  PortableSettingsContinuityError,
  applyPortableHandoff,
  previewPortableHandoff,
  type NativeThreadInventoryReadResultV1,
  type PortableContinuityDependencies,
  type PortableEndpointV1,
  type PortableHandoffResultV2,
  type PortableWriterCensusV1,
} from "./portable-settings-continuity.js";
import {
  resolveSealedManagerManagedRuntimeAssets,
  verifySealedManagerManagedRuntimeAssets,
  type SealedManagerManagedRuntimeAssets,
} from "./manager-runtime-assets.js";
import {
  prepareManagedAccountContinuityPrelaunch,
  type AccountContinuityPrelaunchResultV1,
} from "./account-continuity-prelaunch.js";
import {
  parseTweakersManagerDescriptor,
  TWEAKERS_MANAGER_LAUNCHER_NAME,
} from "./manager-descriptor.js";
import { TWEAKERS_MANAGER_ID } from "./manager-contract.js";
import {
  TWEAKERS_ORIGINAL_EXECUTABLE,
  TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG,
  TWEAKERS_VARIANT_BUNDLE_ID,
  TWEAKERS_VARIANT_CODEX_HOME_CONFIG,
  TWEAKERS_VARIANT_USER_DATA_CONFIG,
} from "./macos-variant.js";

export const PORTABLE_DESKTOP_HANDOFF_SCHEMA_VERSION = 1 as const;
export const PORTABLE_DESKTOP_PRELAUNCH_MANAGER_RUN_COMMAND = "portable-desktop-prelaunch-v1" as const;
export const PORTABLE_DESKTOP_HANDOFF_OFFICIAL_MANAGER_RUN_COMMAND = "portable-desktop-handoff-official-v1" as const;
export const PORTABLE_DESKTOP_HANDOFF_TWEAKERS_MANAGER_RUN_COMMAND = "portable-desktop-handoff-tweakers-v1" as const;
export const PORTABLE_DESKTOP_CONTINUITY_DIRECTORY = "Tweakers Desktop Continuity" as const;

const OFFICIAL_APP = "/Applications/ChatGPT.app" as const;
const TWEAKERS_APP = "/Applications/Tweakers.app" as const;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_CONFIG_BYTES = 4 * 1024;
const MANAGED_NATIVE_TRANSFER_RELATIVE_PATH = join(
  "packages",
  "installer",
  "assets",
  "runtime",
  "account-router",
  "native-transfer.js",
);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;

export type PortableDesktopLaunchTarget = "official" | "tweakers";
export type PortableDesktopHandoffStatus =
  | "applied"
  | "already-applied"
  | "postponed"
  | "conflict"
  | "unsupported-schema";

export interface PortableDesktopEndpointLayoutV1 {
  endpointKey: EndpointKey;
  appBundlePath: string;
  codexHomeRoot: string;
  tweakersRoot: string;
}

/**
 * This has only fixed installation paths. It is exported so final activation
 * can provision the required sibling continuity root before calling the
 * handoff; ordinary callers do not supply a replacement layout.
 */
export interface PortableDesktopLayoutV1 {
  homeRoot: string;
  continuityRoot: string;
  nativeThreadInventoryStateRoot: string;
  official: PortableDesktopEndpointLayoutV1;
  tweakers: PortableDesktopEndpointLayoutV1;
  tweakersAppUserDataRoot: string;
}

export interface PortableDesktopHandoffResultV1 {
  schemaVersion: typeof PORTABLE_DESKTOP_HANDOFF_SCHEMA_VERSION;
  kind: "portable-desktop-handoff";
  target: PortableDesktopLaunchTarget;
  status: PortableDesktopHandoffStatus;
  transactionId: string;
  intentFingerprint: Sha256 | null;
  nativeThreadInventoryFingerprint: Sha256 | null;
  conflictFieldIds: readonly string[];
  excludedFieldIds: readonly string[];
  selectedFieldCount: number;
  destinationWriteFieldCount: number;
  /** True only after the caller's supplied fixed launch callback completed. */
  launched: boolean;
  /** Present only on the authenticated managed Tweakers prelaunch route. */
  accountContinuity: AccountContinuityPrelaunchResultV1 | null;
}

export interface PortableDesktopHandoffInputV1 {
  target: PortableDesktopLaunchTarget;
  /** Used solely by the signed app wrapper route before Electron execve. */
  requireAuthenticatedPrelaunchWrapper?: boolean;
  /** A parent-owned sealed caller may provide its fixed launch action. */
  launch?: () => void;
}

export interface PortableDesktopManagerCommandResultV1 {
  exitCode: 0 | 70 | 75;
  result: PortableDesktopHandoffResultV1;
}

export interface PortableDesktopProcessV1 {
  pid: number;
  ppid: number | null;
  command: string;
}

export interface PortableDesktopCommandResultV1 {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Test seams are intentionally optional; production uses the fixed bindings below. */
export interface PortableDesktopHandoffDependencies {
  layout?: () => PortableDesktopLayoutV1;
  randomId?: () => string;
  readNativeThreadInventory?: (input: { stateRoot: string }) => NativeThreadInventoryReadResultV1;
  resolveManagedRuntime?: () => SealedManagerManagedRuntimeAssets | null;
  verifyManagedRuntime?: (assets: SealedManagerManagedRuntimeAssets) => unknown;
  requireModule?: (path: string) => unknown;
  verifyBundleSchema?: (endpoint: PortableEndpointV1, layout: PortableDesktopLayoutV1) => Sha256;
  census?: PortableContinuityDependencies["census"];
  wait?: PortableContinuityDependencies["wait"];
  now?: PortableContinuityDependencies["now"];
  runCommand?: (command: string, args: readonly string[]) => PortableDesktopCommandResultV1;
  processes?: () => readonly PortableDesktopProcessV1[];
  nodePid?: () => number;
  nodeParentPid?: () => number;
  managerLauncher?: (layout: PortableDesktopLayoutV1) => string;
  prepareAccountContinuity?: (stateRoot: string) => AccountContinuityPrelaunchResultV1;
}

export interface PortableDesktopOperatorDependencies {
  homeRoot?: () => string;
  managerLauncher?: (layout: PortableDesktopLayoutV1) => string;
  invokeManager?: (executable: string, args: readonly string[]) => PortableDesktopCommandResultV1;
  openApplication?: (appBundlePath: string) => void;
}

export class PortableDesktopLaunchError extends Error {
  constructor(readonly code: string) {
    super(`Portable desktop launch stopped safely: ${code}`);
    this.name = "PortableDesktopLaunchError";
  }
}

function endpointKey(label: PortableDesktopLaunchTarget): EndpointKey {
  return `sha256:${createHash("sha256").update(`tweakers-portable-desktop-endpoint-v1:${label}`, "utf8").digest("hex")}` as EndpointKey;
}

/** Fixed, canonical installation layout. There are no user-supplied paths. */
export function portableDesktopLayout(homeRoot = homedir()): PortableDesktopLayoutV1 {
  const home = exactAbsolute(resolve(homeRoot), "home-root-invalid");
  const tweakersRoot = join(home, "Library", "Application Support", "Tweakers");
  const variantRoot = join(tweakersRoot, "variants", "tweakers");
  return {
    homeRoot: home,
    continuityRoot: join(home, "Library", "Application Support", PORTABLE_DESKTOP_CONTINUITY_DIRECTORY),
    nativeThreadInventoryStateRoot: join(tweakersRoot, "tweak-data", "co.tweakers.account-switcher"),
    official: {
      endpointKey: endpointKey("official"),
      appBundlePath: OFFICIAL_APP,
      codexHomeRoot: join(home, ".codex"),
      tweakersRoot,
    },
    tweakers: {
      endpointKey: endpointKey("tweakers"),
      appBundlePath: TWEAKERS_APP,
      codexHomeRoot: join(variantRoot, "codex-home"),
      tweakersRoot: variantRoot,
    },
    tweakersAppUserDataRoot: join(variantRoot, "app-data"),
  };
}

/**
 * Perform one source-only preview/apply sequence. A running writer postpones
 * before a journal can be created; a conflict is returned without applying
 * the otherwise-mergeable subset. This deliberately does not open, quit, or
 * signal either application unless its caller provides a fixed launch callback.
 */
export function runPortableDesktopHandoff(
  input: PortableDesktopHandoffInputV1,
  dependencies: PortableDesktopHandoffDependencies = {},
): PortableDesktopHandoffResultV1 {
  const target = parseTarget(input.target);
  const layout = (dependencies.layout ?? portableDesktopLayout)();
  assertLayout(layout);
  const transactionId = normalizedTransactionId((dependencies.randomId ?? randomUUID)());
  const destination = target === "official" ? layout.official : layout.tweakers;
  const source = target === "official" ? layout.tweakers : layout.official;
  const allowedPids = input.requireAuthenticatedPrelaunchWrapper === true
    ? [requireAuthenticatedPrelaunchWrapper(layout, dependencies)]
    : [];
  let accountContinuity: AccountContinuityPrelaunchResultV1 | null = null;
  if (target === "tweakers" && input.requireAuthenticatedPrelaunchWrapper === true) {
    // The wrapper identity is only a portable-state census exception. It is
    // intentionally absent from the native account-continuity API.
    accountContinuity = (dependencies.prepareAccountContinuity ?? prepareManagedAccountContinuityPrelaunch)(
      layout.nativeThreadInventoryStateRoot,
    );
  }
  const nativeReader = dependencies.readNativeThreadInventory ?? sealedNativeThreadInventoryReader(dependencies);
  const continuityDependencies: PortableContinuityDependencies = {
    readNativeThreadInventory: nativeReader,
    verifyBundleSchema: (endpoint) => (
      dependencies.verifyBundleSchema?.(endpoint, layout) ?? verifyFixedDesktopBundleSchema(endpoint, layout, dependencies)
    ),
    census: dependencies.census ?? createAllowedPidCensus(allowedPids, dependencies),
    ...(dependencies.wait ? { wait: dependencies.wait } : {}),
    ...(dependencies.now ? { now: dependencies.now } : {}),
  };
  const handoffInput = {
    transactionId,
    globalRoot: layout.continuityRoot,
    source: endpoint(source),
    destination: endpoint(destination),
    nativeThreadInventoryStateRoot: layout.nativeThreadInventoryStateRoot,
  };

  let preview: PortableHandoffResultV2;
  try {
    preview = previewPortableHandoff(handoffInput, continuityDependencies);
  } catch (error) {
    // A live endpoint is deliberately a successful no-merge handoff. The
    // caller may still open the requested destination, but it never gets a
    // partial preference merge while either desktop could be writing.
    if (isWriterBusy(error)) return launchAfterPostponement(target, transactionId, input.launch, accountContinuity);
    throw error;
  }
  if (preview.status === "unsupported-schema") {
    // Portable preferences are optional at authenticated app startup. A newer
    // desktop may open without admitting its schema or selecting any fields.
    // Explicit operator handoffs still report the unsupported contract.
    if (target === "tweakers" && input.requireAuthenticatedPrelaunchWrapper === true) {
      return launchAfterPostponement(target, transactionId, input.launch, accountContinuity);
    }
    return resultFromHandoff(target, "unsupported-schema", preview, false, accountContinuity);
  }
  if (preview.status !== "preview" || preview.intentFingerprint === null || preview.precondition === null) {
    throw new PortableDesktopLaunchError("preview-not-actionable");
  }
  if (preview.conflictFieldIds.length > 0) return resultFromHandoff(target, "conflict", preview, false, accountContinuity);

  let applied: PortableHandoffResultV2;
  try {
    applied = applyPortableHandoff({
      ...handoffInput,
      apply: true,
      expectedIntentFingerprint: preview.intentFingerprint,
      precondition: preview.precondition,
    }, continuityDependencies);
  } catch (error) {
    // A writer that appears before the first journal is a clean postponement.
    // Any later failure leaves the continuity module's durable recovery record
    // intact and must be surfaced instead of being disguised as a retry.
    if (isWriterBusy(error)) throw new PortableDesktopLaunchError("writers-raced-after-preview");
    throw error;
  }
  if (applied.status === "unsupported-schema") return resultFromHandoff(target, "unsupported-schema", applied, false, accountContinuity);
  if (applied.conflictFieldIds.length > 0) return resultFromHandoff(target, "conflict", applied, false, accountContinuity);
  if (applied.status !== "applied" && applied.status !== "already-applied") {
    throw new PortableDesktopLaunchError(`apply-not-complete-${applied.status}`);
  }
  const base = resultFromHandoff(target, applied.status, applied, false, accountContinuity);
  if (input.launch === undefined) return base;
  input.launch();
  return { ...base, launched: true };
}

/**
 * Exact direct-manager route. The native launcher admits only these literal
 * no-argument commands; the app wrapper uses prelaunch while the operator CLI
 * uses one of the target-specific handoff commands and opens only after zero.
 */
export function runPortableDesktopManagerCommand(
  argv: readonly string[],
  dependencies: PortableDesktopHandoffDependencies = {},
): PortableDesktopManagerCommandResultV1 {
  if (argv.length !== 1) throw new PortableDesktopLaunchError("manager-command-argv-invalid");
  const command = argv[0];
  if (command === PORTABLE_DESKTOP_PRELAUNCH_MANAGER_RUN_COMMAND) {
    const result = runPortableDesktopHandoff({ target: "tweakers", requireAuthenticatedPrelaunchWrapper: true }, dependencies);
    return { result, exitCode: exitCodeFor(result.status) };
  }
  if (command === PORTABLE_DESKTOP_HANDOFF_OFFICIAL_MANAGER_RUN_COMMAND) {
    const result = runPortableDesktopHandoff({ target: "official" }, dependencies);
    return { result, exitCode: exitCodeFor(result.status) };
  }
  if (command === PORTABLE_DESKTOP_HANDOFF_TWEAKERS_MANAGER_RUN_COMMAND) {
    const result = runPortableDesktopHandoff({ target: "tweakers" }, dependencies);
    return { result, exitCode: exitCodeFor(result.status) };
  }
  throw new PortableDesktopLaunchError("manager-command-unsupported");
}

/**
 * Fixed operator entrypoint. It never loads the mutable local runtime: it
 * invokes the already signed manager generation, waits for its result, then
 * opens exactly the selected fixed application only on a successful or safely
 * postponed handoff. Direct Finder/Dock opening of the official app remains
 * outside this interception path.
 */
export function launchPortableDesktopFromOperator(
  target: PortableDesktopLaunchTarget,
  dependencies: PortableDesktopOperatorDependencies = {},
): PortableDesktopHandoffResultV1 {
  const parsedTarget = parseTarget(target);
  const layout = portableDesktopLayout((dependencies.homeRoot ?? homedir)());
  const manager = (dependencies.managerLauncher ?? resolveFixedManagerLauncher)(layout);
  const command = parsedTarget === "official"
    ? PORTABLE_DESKTOP_HANDOFF_OFFICIAL_MANAGER_RUN_COMMAND
    : PORTABLE_DESKTOP_HANDOFF_TWEAKERS_MANAGER_RUN_COMMAND;
  const invocation = (dependencies.invokeManager ?? invokeFixedManager)(manager, [command]);
  const result = parseManagerResult(invocation.stdout);
  if (result.target !== parsedTarget) throw new PortableDesktopLaunchError("manager-result-target-mismatch");
  if (invocation.error || invocation.status === null) throw new PortableDesktopLaunchError("manager-launch-failed");
  if (result.status === "conflict" || result.status === "unsupported-schema") {
    if (invocation.status === 0) throw new PortableDesktopLaunchError("manager-result-exit-mismatch");
    return result;
  }
  if (invocation.status !== 0) throw new PortableDesktopLaunchError("manager-handoff-failed");
  if (result.status !== "applied" && result.status !== "already-applied" && result.status !== "postponed") {
    throw new PortableDesktopLaunchError("manager-result-invalid");
  }
  (dependencies.openApplication ?? openFixedApplication)(parsedTarget === "official" ? OFFICIAL_APP : TWEAKERS_APP);
  return { ...result, launched: true };
}

/** Locate a single inspected main-*.js payload; ambiguous headers fail closed. */
export function findPortableDesktopMainChunk(header: unknown): string {
  const found: string[] = [];
  const visit = (node: unknown, parent: string): void => {
    if (!isRecord(node)) throw new PortableDesktopLaunchError("asar-header-invalid");
    const files = node.files;
    if (files === undefined) return;
    if (!isRecord(files)) throw new PortableDesktopLaunchError("asar-header-invalid");
    for (const [name, entry] of Object.entries(files)) {
      if (!safeAsarSegment(name)) throw new PortableDesktopLaunchError("asar-header-invalid");
      const path = parent ? `${parent}/${name}` : name;
      if (/^main-[A-Za-z0-9_-]+\.js$/.test(name)) found.push(path);
      visit(entry, path);
    }
  };
  visit(header, "");
  if (found.length !== 1) throw new PortableDesktopLaunchError("desktop-main-chunk-ambiguous");
  return found[0]!;
}

/** Pure ancestry check used only to admit the app wrapper's own short-lived PID. */
export function authenticatedPortableDesktopPrelaunchWrapperPid(input: {
  nodePid: number;
  nodeParentPid: number;
  managerLauncher: string;
  wrapperLauncher: string;
  processes: readonly PortableDesktopProcessV1[];
}): number | null {
  const node = input.processes.find((entry) => entry.pid === input.nodePid);
  const manager = input.processes.find((entry) => entry.pid === input.nodeParentPid);
  if (node !== undefined && node.ppid !== input.nodeParentPid) return null;
  if (!manager || manager.ppid === null || !exactInvocation(
    manager.command,
    input.managerLauncher,
    [PORTABLE_DESKTOP_PRELAUNCH_MANAGER_RUN_COMMAND],
  )) return null;
  const wrapper = input.processes.find((entry) => entry.pid === manager.ppid);
  if (!wrapper || !startsInvocation(wrapper.command, input.wrapperLauncher)) return null;
  return wrapper.pid;
}

function endpoint(value: PortableDesktopEndpointLayoutV1): PortableEndpointV1 {
  return {
    endpointKey: value.endpointKey,
    appBundlePath: value.appBundlePath,
    codexHomeRoot: value.codexHomeRoot,
    tweakersRoot: value.tweakersRoot,
    bundleSchemaFingerprint: CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1,
  };
}

function sealedNativeThreadInventoryReader(
  dependencies: PortableDesktopHandoffDependencies,
): (input: { stateRoot: string }) => NativeThreadInventoryReadResultV1 {
  const assets = (dependencies.resolveManagedRuntime ?? resolveSealedManagerManagedRuntimeAssets)();
  if (assets === null) throw new PortableDesktopLaunchError("sealed-managed-runtime-unavailable");
  (dependencies.verifyManagedRuntime ?? verifySealedManagerManagedRuntimeAssets)(assets);
  const modulePath = join(assets.root, MANAGED_NATIVE_TRANSFER_RELATIVE_PATH);
  const loaded = (dependencies.requireModule ?? createRequire(import.meta.url))(modulePath) as {
    readCommittedNativeThreadInventoryV1?: unknown;
  };
  if (typeof loaded.readCommittedNativeThreadInventoryV1 !== "function") {
    throw new PortableDesktopLaunchError("sealed-native-thread-reader-unavailable");
  }
  const reader = loaded.readCommittedNativeThreadInventoryV1 as (input: { stateRoot: string }) => NativeThreadInventoryReadResultV1;
  return (input) => reader({ stateRoot: input.stateRoot });
}

/** Normalize only generated import hashes, the source-map name, and our exact window-service capture. */
export function portableDesktopMainContractFingerprint(bytes: Buffer): Sha256 {
  const source = bytes.toString("utf8")
    .replace(/globalThis\.__tweaker_window_services__=([A-Za-z_$][\w$]*);globalThis\.__codexpp_window_services__=\1;/g, "")
    .replace(/(require\(["`]\.\/[^"`\n]+)-[A-Za-z0-9_-]{8}(\.js["`]\))/g, "$1-HASH$2")
    .replace(/\/\/# sourceMappingURL=main-[A-Za-z0-9_-]+\.js\.map/g, "//# sourceMappingURL=main-HASH.js.map");
  return `sha256:${createHash("sha256").update(source).digest("hex")}` as Sha256;
}

// The inspected main-7G1VcsUF and main-C5K7o1Hr sources are equivalent after
// the narrow normalization above. Build 8109 (main-BT6ViFC-) adds only an
// incentives receipt-acknowledgement Set/method: the remaining 1,014,089 AST
// tokens match with a bijection of bound symbols. Its portable state contract
// is unchanged. Keep exact reviewed hashes; unknown executable changes still
// fail closed instead of normalizing arbitrary identifiers at runtime.
const INSPECTED_MAIN_CONTRACTS = new Set([
  "sha256:0c917ea514a36d27a8a7f811c978d8450fa5bb0b9e0b470a88254e9accf4b64a",
  "sha256:25c25ec9839e84c4de81cbbb8742858257c376eaef8b03cf4a82d5baece34090",
  // The reviewed 26.901.51231 Accounts bridge adds account-scoped request and
  // browser routing to main-BT6ViFC-. Its portable desktop state schema is
  // unchanged. Admit only this exact patched contract, not arbitrary hooks.
  "sha256:c371365a91c75a06d67c0894a934166c7614e1a9a64e68257ccb5af17fa6a23d",
  // Reviewed native project overlay: connection-home initialization, durable
  // local identities and removals, remote rows, and serialized write checks.
  // The portable desktop schema is unchanged; admit this exact build only.
  "sha256:7db96727b0bb6c7f00de8bd9b569768e41e832fd29234e9a3af1859dd248a65b",
  // The fixed manager bundles the same reviewed helpers with esbuild. Its
  // exact serialization is equivalent; future title-bar refreshes use it.
  "sha256:bb7e895047c2b66416d18ee42faf80eedd117bde4397f39f4862b1e08e300a61",
  // The current native hook inventory changes only hookSetSha256 in that
  // reviewed main bundle. Its executable helpers and portable schema match.
  "sha256:b73f0724a07d60f6d2fc0b00801005836bbcc123288614e4d042c5a13611da3f",
]);

export function portableDesktopSchemaFingerprintFromMain(bytes: Buffer): Sha256 {
  return INSPECTED_MAIN_CONTRACTS.has(portableDesktopMainContractFingerprint(bytes))
    ? CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1
    : `sha256:${createHash("sha256").update(bytes).digest("hex")}` as Sha256;
}

function verifyFixedDesktopBundleSchema(
  endpointValue: PortableEndpointV1,
  layout: PortableDesktopLayoutV1,
  dependencies: PortableDesktopHandoffDependencies,
): Sha256 {
  if (platform() !== "darwin") throw new PortableDesktopLaunchError("macos-required");
  if (endpointValue.appBundlePath === layout.official.appBundlePath) {
    assertExactExistingDirectory(endpointValue.appBundlePath, "official-app");
  } else if (endpointValue.appBundlePath === layout.tweakers.appBundlePath) {
    assertVariantProvenance(layout, dependencies);
  } else {
    throw new PortableDesktopLaunchError("endpoint-app-unrecognized");
  }
  const asar = join(endpointValue.appBundlePath, "Contents", "Resources", "app.asar");
  // The official bundle is normally owned by root while the derived app is
  // locally signed by the user. The exact source hash below is the authority
  // for the former; variant provenance already binds the latter to this user.
  assertRegularNoSymlink(
    asar,
    "desktop-asar",
    false,
    endpointValue.appBundlePath === layout.official.appBundlePath ? "any" : "current",
  );
  const header = readHeaderHash(asar).header;
  const chunk = findPortableDesktopMainChunk(header);
  const bytes = readFileInAsar(asar, chunk);
  return portableDesktopSchemaFingerprintFromMain(bytes);
}

function assertVariantProvenance(layout: PortableDesktopLayoutV1, dependencies: PortableDesktopHandoffDependencies): void {
  assertExactExistingDirectory(layout.tweakers.appBundlePath, "tweakers-app");
  const verify = runFixedCommand(dependencies, "/usr/bin/codesign", ["--verify", "--deep", "--strict", layout.tweakers.appBundlePath]);
  if (verify.error || verify.status !== 0) throw new PortableDesktopLaunchError("tweakers-variant-signature-invalid");
  const info = join(layout.tweakers.appBundlePath, "Contents", "Info.plist");
  assertRegularNoSymlink(info, "tweakers-info-plist", false);
  const bundleId = readPlistString(info, "CFBundleIdentifier", dependencies);
  const original = readPlistString(info, "TweakersOriginalExecutable", dependencies);
  const executable = readPlistString(info, "CFBundleExecutable", dependencies);
  if (bundleId !== TWEAKERS_VARIANT_BUNDLE_ID
    || original !== TWEAKERS_ORIGINAL_EXECUTABLE
    || !safeFileName(executable)
    || executable === TWEAKERS_ORIGINAL_EXECUTABLE) {
    throw new PortableDesktopLaunchError("tweakers-variant-provenance-invalid");
  }
  const environment = {
    userData: readPlistString(info, "LSEnvironment.CODEX_ELECTRON_USER_DATA_PATH", dependencies),
    codexHome: readPlistString(info, "LSEnvironment.CODEX_HOME", dependencies),
    sqliteHome: readPlistString(info, "LSEnvironment.CODEX_SQLITE_HOME", dependencies),
    broker: readPlistString(info, "LSEnvironment.TWEAKERS_ACCOUNTS_BROKER_ROOT", dependencies),
    brokerCompatibility: readPlistString(info, "LSEnvironment.TWEAKER_ACCOUNTS_BROKER_ROOT", dependencies),
    derived: readPlistString(info, "LSEnvironment.TWEAKERS_DERIVED_VARIANT", dependencies),
  };
  if (environment.userData !== layout.tweakersAppUserDataRoot
    || environment.codexHome !== layout.tweakers.codexHomeRoot
    || environment.sqliteHome !== layout.tweakers.codexHomeRoot
    || environment.broker !== layout.nativeThreadInventoryStateRoot
    || environment.brokerCompatibility !== layout.nativeThreadInventoryStateRoot
    || environment.derived !== "1") {
    throw new PortableDesktopLaunchError("tweakers-variant-provenance-invalid");
  }
  const configRoot = join(layout.tweakers.appBundlePath, "Contents", "Resources");
  assertExactConfig(configRoot, TWEAKERS_VARIANT_USER_DATA_CONFIG, layout.tweakersAppUserDataRoot);
  assertExactConfig(configRoot, TWEAKERS_VARIANT_CODEX_HOME_CONFIG, layout.tweakers.codexHomeRoot);
  assertExactConfig(configRoot, TWEAKERS_VARIANT_ACCOUNTS_BROKER_CONFIG, layout.nativeThreadInventoryStateRoot);
}

function readPlistString(
  path: string,
  key: string,
  dependencies: PortableDesktopHandoffDependencies,
): string {
  const result = runFixedCommand(dependencies, "/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path]);
  // `plutil` versions differ on whether raw stdout carries a final LF. Permit
  // precisely that presentation difference, never embedded control text.
  const value = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  if (result.error || result.status !== 0 || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new PortableDesktopLaunchError("tweakers-variant-provenance-unreadable");
  }
  return value;
}

function assertExactConfig(root: string, relativePath: string, expected: string): void {
  const path = join(root, relativePath);
  assertRegularNoSymlink(path, "tweakers-signed-launch-config", true);
  const value = readFileSync(path, "utf8");
  if (value !== `${expected}\n`) throw new PortableDesktopLaunchError("tweakers-variant-provenance-invalid");
}

function requireAuthenticatedPrelaunchWrapper(
  layout: PortableDesktopLayoutV1,
  dependencies: PortableDesktopHandoffDependencies,
): number {
  const manager = (dependencies.managerLauncher ?? resolveFixedManagerLauncher)(layout);
  const wrapper = resolveVariantWrapperLauncher(layout, dependencies);
  const processes = dependencies.processes?.() ?? readProcesses(dependencies);
  const pid = authenticatedPortableDesktopPrelaunchWrapperPid({
    nodePid: (dependencies.nodePid ?? (() => process.pid))(),
    nodeParentPid: (dependencies.nodeParentPid ?? (() => process.ppid))(),
    managerLauncher: manager,
    wrapperLauncher: wrapper,
    processes,
  });
  if (pid === null) throw new PortableDesktopLaunchError("prelaunch-ancestry-unverified");
  return pid;
}

function resolveVariantWrapperLauncher(
  layout: PortableDesktopLayoutV1,
  dependencies: PortableDesktopHandoffDependencies,
): string {
  const info = join(layout.tweakers.appBundlePath, "Contents", "Info.plist");
  const executable = readPlistString(info, "CFBundleExecutable", dependencies);
  if (!safeFileName(executable)) throw new PortableDesktopLaunchError("tweakers-wrapper-path-invalid");
  const path = join(layout.tweakers.appBundlePath, "Contents", "MacOS", executable);
  assertRegularNoSymlink(path, "tweakers-wrapper", false);
  return path;
}

function createAllowedPidCensus(
  allowedPids: readonly number[],
  dependencies: PortableDesktopHandoffDependencies,
): NonNullable<PortableContinuityDependencies["census"]> {
  const allowed = new Set(allowedPids);
  return (input) => {
    const observedAt = new Date().toISOString();
    const ps = runFixedCommand(dependencies, "/bin/ps", ["-axo", "pid=,command="]);
    if (ps.error || ps.status !== 0) return unknownCensus(observedAt);
    const processes = parsePidCommandOutput(ps.stdout);
    if (processes === null) return unknownCensus(observedAt);
    const filtered = processes.filter((entry) => !allowed.has(entry.pid));
    const source = processState(filtered, input.sourceAppBundlePath);
    const destination = processState(filtered, input.destinationAppBundlePath);
    if (source === "unknown" || destination === "unknown") return unknownCensus(observedAt);
    // A known live endpoint already prevents a desktop merge. Avoid an
    // expensive recursive home scan that cannot change that busy result.
    if (source === "running" || destination === "running") {
      return { observedAt, state: "running", openFileCount: 0, unexpectedProcessCount: 0 };
    }
    let openFileCount = 0;
    for (const protectedPath of input.protectedPaths) {
      const lsof = runFixedCommand(dependencies, "/usr/sbin/lsof", ["-nP", "+D", protectedPath]);
      if (lsof.error || (lsof.status !== 0 && lsof.status !== 1)) return unknownCensus(observedAt);
      const count = countOpenFilesExcluding(lsof.stdout, allowed);
      if (count === null) return unknownCensus(observedAt);
      openFileCount += count;
    }
    return {
      observedAt,
      state: "zero",
      openFileCount,
      unexpectedProcessCount: 0,
    };
  };
}

function processState(processes: readonly PortableDesktopProcessV1[], appPath: string): "zero" | "running" | "unknown" {
  if (!exactAbsolute(appPath, "app-path-invalid")) return "unknown";
  return processes.some((entry) => entry.command.includes(appPath)) ? "running" : "zero";
}

function parsePidCommandOutput(value: string): PortableDesktopProcessV1[] | null {
  const output: PortableDesktopProcessV1[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    output.push({ pid, ppid: null, command: match[2]! });
  }
  return output;
}

function countOpenFilesExcluding(value: string, allowed: ReadonlySet<number>): number | null {
  let count = 0;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim() || /^COMMAND\s+PID\s+/.test(line)) continue;
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    if (!allowed.has(pid)) count += 1;
  }
  return count;
}

function readProcesses(dependencies: PortableDesktopHandoffDependencies): readonly PortableDesktopProcessV1[] {
  const result = runFixedCommand(dependencies, "/bin/ps", ["-axo", "pid=,ppid=,command="]);
  if (result.error || result.status !== 0) throw new PortableDesktopLaunchError("prelaunch-process-table-unavailable");
  const processes: PortableDesktopProcessV1[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new PortableDesktopLaunchError("prelaunch-process-table-unreadable");
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      throw new PortableDesktopLaunchError("prelaunch-process-table-unreadable");
    }
    processes.push({ pid, ppid, command: match[3]! });
  }
  return processes;
}

function resolveFixedManagerLauncher(layout: PortableDesktopLayoutV1): string {
  const descriptorRoot = join(layout.homeRoot, "Library", "Application Support", "Menu Bar", "manager-descriptors");
  const descriptor = join(descriptorRoot, `${TWEAKERS_MANAGER_ID}.json`);
  assertRegularNoSymlink(descriptor, "manager-descriptor", true);
  const text = readFileSync(descriptor, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_DESCRIPTOR_BYTES) throw new PortableDesktopLaunchError("manager-descriptor-oversized");
  let parsed: ReturnType<typeof parseTweakersManagerDescriptor>;
  try { parsed = parseTweakersManagerDescriptor(text); }
  catch { throw new PortableDesktopLaunchError("manager-descriptor-invalid"); }
  const generationRoot = join(layout.official.tweakersRoot, "managers", TWEAKERS_MANAGER_ID, "generations");
  const expectedPrefix = `${generationRoot}${sep}`;
  if (!parsed.executable.startsWith(expectedPrefix)
    || basename(parsed.executable) !== TWEAKERS_MANAGER_LAUNCHER_NAME
    || !isAbsolute(parsed.executable)
    || normalize(parsed.executable) !== parsed.executable) {
    throw new PortableDesktopLaunchError("manager-descriptor-path-invalid");
  }
  const generation = parsed.executable.slice(expectedPrefix.length, -(`/${TWEAKERS_MANAGER_LAUNCHER_NAME}`).length);
  if (!HEX.test(generation)) throw new PortableDesktopLaunchError("manager-descriptor-path-invalid");
  assertRegularNoSymlink(parsed.executable, "manager-launcher", false);
  return parsed.executable;
}

function invokeFixedManager(executable: string, args: readonly string[]): PortableDesktopCommandResultV1 {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

function openFixedApplication(appBundlePath: string): void {
  const result = spawnSync("/usr/bin/open", [appBundlePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  if (result.error || result.status !== 0) throw new PortableDesktopLaunchError("application-open-failed");
}

function runFixedCommand(
  dependencies: PortableDesktopHandoffDependencies,
  command: string,
  args: readonly string[],
): PortableDesktopCommandResultV1 {
  if (dependencies.runCommand) return dependencies.runCommand(command, args);
  const result = spawnSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
}

function parseManagerResult(value: string): PortableDesktopHandoffResultV1 {
  if (value.length > 128 * 1024 || !value.endsWith("\n") || value.slice(0, -1).includes("\n")) {
    throw new PortableDesktopLaunchError("manager-result-invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new PortableDesktopLaunchError("manager-result-invalid"); }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== PORTABLE_DESKTOP_HANDOFF_SCHEMA_VERSION
    || parsed.kind !== "portable-desktop-handoff"
    || (parsed.target !== "official" && parsed.target !== "tweakers")
    || !isStatus(parsed.status)
    || typeof parsed.transactionId !== "string"
    || !Array.isArray(parsed.conflictFieldIds)
    || !Array.isArray(parsed.excludedFieldIds)
    || typeof parsed.selectedFieldCount !== "number"
    || typeof parsed.destinationWriteFieldCount !== "number"
    || typeof parsed.launched !== "boolean"
    || !(parsed.accountContinuity === null || isAccountContinuityResult(parsed.accountContinuity))
    || !(typeof parsed.intentFingerprint === "string" || parsed.intentFingerprint === null)
    || !(typeof parsed.nativeThreadInventoryFingerprint === "string" || parsed.nativeThreadInventoryFingerprint === null)) {
    throw new PortableDesktopLaunchError("manager-result-invalid");
  }
  if ((parsed.intentFingerprint !== null && !SHA256.test(parsed.intentFingerprint))
    || (parsed.nativeThreadInventoryFingerprint !== null && !SHA256.test(parsed.nativeThreadInventoryFingerprint))
    || !parsed.conflictFieldIds.every((entry) => typeof entry === "string")
    || !parsed.excludedFieldIds.every((entry) => typeof entry === "string")) {
    throw new PortableDesktopLaunchError("manager-result-invalid");
  }
  return parsed as unknown as PortableDesktopHandoffResultV1;
}

function resultFromHandoff(
  target: PortableDesktopLaunchTarget,
  status: Extract<PortableDesktopHandoffStatus, "applied" | "already-applied" | "conflict" | "unsupported-schema">,
  handoff: PortableHandoffResultV2,
  launched: boolean,
  accountContinuity: AccountContinuityPrelaunchResultV1 | null,
): PortableDesktopHandoffResultV1 {
  return {
    schemaVersion: PORTABLE_DESKTOP_HANDOFF_SCHEMA_VERSION,
    kind: "portable-desktop-handoff",
    target,
    status,
    transactionId: handoff.transactionId,
    intentFingerprint: handoff.intentFingerprint,
    nativeThreadInventoryFingerprint: handoff.nativeThreadInventoryFingerprint,
    conflictFieldIds: handoff.conflictFieldIds,
    excludedFieldIds: handoff.excludedFieldIds,
    selectedFieldCount: handoff.selectedFieldCount,
    destinationWriteFieldCount: handoff.destinationWriteFieldCount,
    launched,
    accountContinuity,
  };
}

function postponedResult(
  target: PortableDesktopLaunchTarget,
  transactionId: string,
  accountContinuity: AccountContinuityPrelaunchResultV1 | null,
): PortableDesktopHandoffResultV1 {
  return {
    schemaVersion: PORTABLE_DESKTOP_HANDOFF_SCHEMA_VERSION,
    kind: "portable-desktop-handoff",
    target,
    status: "postponed",
    transactionId,
    intentFingerprint: null,
    nativeThreadInventoryFingerprint: null,
    conflictFieldIds: [],
    excludedFieldIds: [],
    selectedFieldCount: 0,
    destinationWriteFieldCount: 0,
    launched: false,
    accountContinuity,
  };
}

function launchAfterPostponement(
  target: PortableDesktopLaunchTarget,
  transactionId: string,
  launch: (() => void) | undefined,
  accountContinuity: AccountContinuityPrelaunchResultV1 | null,
): PortableDesktopHandoffResultV1 {
  const result = postponedResult(target, transactionId, accountContinuity);
  if (launch === undefined) return result;
  launch();
  return { ...result, launched: true };
}

function unknownCensus(observedAt: string): PortableWriterCensusV1 {
  return { observedAt, state: "unknown", openFileCount: -1, unexpectedProcessCount: 0 };
}

function exitCodeFor(status: PortableDesktopHandoffStatus): 0 | 70 | 75 {
  if (status === "applied" || status === "already-applied" || status === "postponed") return 0;
  return status === "conflict" ? 75 : 70;
}

function isWriterBusy(error: unknown): boolean {
  return error instanceof PortableSettingsContinuityError && error.code === "writers-not-zero";
}

function parseTarget(value: unknown): PortableDesktopLaunchTarget {
  if (value === "official" || value === "tweakers") return value;
  throw new PortableDesktopLaunchError("target-invalid");
}

function isStatus(value: unknown): value is PortableDesktopHandoffStatus {
  return value === "applied" || value === "already-applied" || value === "postponed"
    || value === "conflict" || value === "unsupported-schema";
}

function isAccountContinuityResult(value: unknown): value is AccountContinuityPrelaunchResultV1 {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== "reason\0state") return false;
  return value.state === "ready"
    ? value.reason === "already-current" || value.reason === "shared-source-rebased" || value.reason === "shared-source-recovered"
    : value.state === "deferred" && (value.reason === "account-busy" || value.reason === "source-changed");
}

function normalizedTransactionId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(value)) {
    throw new PortableDesktopLaunchError("transaction-id-invalid");
  }
  return value;
}

function assertLayout(layout: PortableDesktopLayoutV1): void {
  const endpoints = [layout.official, layout.tweakers];
  if (!layout || endpoints[0]!.endpointKey === endpoints[1]!.endpointKey) {
    throw new PortableDesktopLaunchError("layout-invalid");
  }
  for (const path of [
    layout.homeRoot,
    layout.continuityRoot,
    layout.nativeThreadInventoryStateRoot,
    layout.tweakersAppUserDataRoot,
    ...endpoints.flatMap((entry) => [entry.appBundlePath, entry.codexHomeRoot, entry.tweakersRoot]),
  ]) exactAbsolute(path, "layout-path-invalid");
}

function exactAbsolute(path: string, code: string): string {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path)) {
    throw new PortableDesktopLaunchError(code);
  }
  return path;
}

function assertExactExistingDirectory(path: string, code: string): void {
  exactAbsolute(path, `${code}-path-invalid`);
  let stat;
  try { stat = lstatSync(path); } catch { throw new PortableDesktopLaunchError(`${code}-missing`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PortableDesktopLaunchError(`${code}-unsafe`);
  try {
    if (realpathSync(path) !== path) throw new PortableDesktopLaunchError(`${code}-unsafe`);
  } catch (error) {
    if (error instanceof PortableDesktopLaunchError) throw error;
    throw new PortableDesktopLaunchError(`${code}-unsafe`);
  }
}

function assertRegularNoSymlink(
  path: string,
  code: string,
  ownerPrivate: boolean,
  expectedOwner: "current" | "any" = "current",
): void {
  let stat;
  try { stat = lstatSync(path); } catch { throw new PortableDesktopLaunchError(`${code}-missing`); }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (stat.mode & 0o022) !== 0 || (ownerPrivate && (stat.mode & 0o077) !== 0)
    || (expectedOwner === "current" && uid !== null && stat.uid !== uid)) {
    throw new PortableDesktopLaunchError(`${code}-unsafe`);
  }
  try {
    if (realpathSync(path) !== path) throw new PortableDesktopLaunchError(`${code}-unsafe`);
  } catch (error) {
    if (error instanceof PortableDesktopLaunchError) throw error;
    throw new PortableDesktopLaunchError(`${code}-unsafe`);
  }
}

function safeAsarSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !/[\\/\0\r\n]/.test(value);
}

function safeFileName(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value !== "." && value !== ".." && basename(value) === value && !/[\0\r\n]/.test(value);
}

function exactInvocation(command: string, executable: string, args: readonly string[]): boolean {
  return command === [executable, ...args].join(" ");
}

function startsInvocation(command: string, executable: string): boolean {
  return command === executable || command.startsWith(`${executable} `);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
