/**
 * Main-process bootstrap. Loaded by the asar loader before Codex's own
 * main process code runs. We hook `BrowserWindow` so every window Codex
 * creates gets our preload script attached. We also stand up an IPC
 * channel for tweaks to talk to the main process.
 *
 * We are in CJS land here (matches Electron's main process and Codex's own
 * code). The renderer-side runtime is bundled separately into preload.js.
 */
import { app, BrowserView, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, protocol, screen, session, shell, systemPreferences, webContents, type MessageBoxOptions, type OpenDialogOptions } from "electron";
import { cpSync, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as originalFs from "original-fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as extractTar, list as listTar } from "tar";
import chokidar from "chokidar";
import { discoverTweaks, type DiscoveredTweak } from "./tweak-discovery";
import { ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL, readAccountsNativeCompatibility } from "./accounts-native-compatibility";
import { invokeAccountsNativeBrowserAction } from "./accounts-native-browser";
import { createDiskStorage, removeLegacyModeSwitcherState, type DiskStorage } from "./storage";
import { applyHealthProbeKeychainIsolation } from "./health-probe-keychain";
import { applyHealthProbeDialogSuppression } from "./health-probe-dialog";
import { hashRawAsarHeader } from "./promotion-asar";
import {
  fingerprintPromotionCodexConfigPath,
  fingerprintPromotionPolicyPath,
  promotionPolicyFingerprintFailureReason,
} from "./promotion-policy";
import {
  createMcpReconciler,
  resolveMcpRuntimePaths,
  type McpSyncTrigger,
} from "./mcp-reconciliation";
import { getAndPublishWatcherHealth, getWatcherHealth, readRuntimeFingerprintEvidence } from "./watcher-health";
import {
  isMainProcessTweakScope,
  bindMainTweakStop,
  normalizeTweakStartupTimeoutMs,
  runWithStartupTimeout,
  reloadTweaks,
  setTweakEnabledAndReload,
  createTweakLifecycleJournal,
  lifecycleRecordKey,
  recoverInterruptedTweaks,
  loadTweaksInitially,
  type TweakLifecycleJournal,
  type TweakLifecycleRecord,
  type TweakLifecycleStatus,
  type TweakProcess,
} from "./tweak-lifecycle";
import { appendCappedLog } from "./logging";
import {
  getCdpStatus,
  getRuntimeCapabilities,
  getRuntimeInfo,
  listCdpTargets,
} from "./codex-runtime-probe";
import { NativeBridge, type NativeTweakContext } from "./native-bridge";
import { resolveRuntimeNativeHostPath } from "./native-host-path";
import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import type {
  CodexRuntimeCapabilities,
  CodexRuntimeInfo,
  CodexViewCreateOptions,
  CodexViewRef,
  CodexWindowRef,
  NativeHelperLaunchOptions,
  NativeModuleLoadOptions,
  NativePanelCreateOptions,
  NativeViewAttachOptions,
  TweakPermission,
  CodexHotkeyRegistration,
  FrontmostWindowCapture,
  CodexPermissionStatus,
} from "@therealityreport/tweakers-sdk";
import {
  DEFAULT_TWEAK_STORE_INDEX_URL,
  normalizeGitHubRepo,
  normalizeStoreRegistry,
  shuffleStoreEntries,
  storeArchiveUrl,
  type TweakStorePublishSubmission,
  type TweakStoreEntry,
  type TweakStoreRegistry,
  type TweakStorePlatform,
  type TweakHealthRecord,
  deriveTweakStatus,
  isBundledStoreEntry,
  resolveBundledTweakPath,
} from "./tweak-store";
import { maybeStartBrowserUiServer } from "./browser-ui";
import { resolveLocalCliRuntime } from "./local-cli-runtime";
import {
  resolveTerminalCodexBinary,
  terminalCodexPathFromShellOutput,
} from "./codex-terminal-cli";
import {
  classifyInstalledCliCommand,
  submitInstalledCliWithLaunchd,
  type LaunchdSubmitOptions,
} from "./installed-cli-launch";
import {
  assertTweakersVariantBootstrap,
  desktopUpdateStartupEnabled,
  publishIndependentTweakersRuntimeReadyReceipt,
  type TweakersVariantFilesystem,
} from "./desktop-update-startup";
import {
  AccountsBrokerSocketClientV1,
  readAccountsBrokerSecret,
  resolveAccountsBrokerRootResolution,
} from "./account-router/broker-socket";
import { readAccountsBrokerSetupState } from "./account-router/broker-readiness";
import {
  ACCOUNT_ROUTER_CONFIG_FILE,
  readRouterLaunchSelection,
} from "./account-router/config";
import {
  AccountsBrokerRendererAdapterV1,
  type RendererBrokerEventV1,
} from "./account-router/broker-adapter";
import {
  createOpaqueAppToolsRef,
  createOpaqueRendererRef,
} from "./account-router/broker";
import type { AccountsBrokerIpcEnvelopeV1, BrokerResponseV1 } from "./account-router/types";
import { dispatchCrossTweakRead } from "./cross-tweak-read";
import {
  answerPromotionHealthRequest,
  authorizePromotionOriginalRenderer,
  authorizePromotionRenderer,
  canonicalPromotionOriginalRendererUrl,
  createPromotionOriginalRendererDeadlineController,
  createPromotionOriginalRendererProofTracker,
  createPromotionRendererProtocolResponder,
  createPromotionRendererProofTracker,
  disablePromotionOriginalRendererBackgroundThrottling,
  hasUniqueSandboxedPromotionRendererProcess,
  hasAuthenticatedSessionCookie,
  hasAuthenticatedCodexToken,
  PROMOTION_RENDERER_AUTH_CHANNEL,
  PROMOTION_RENDERER_IPC_CHANNEL,
  PROMOTION_RENDERER_SCHEME,
  PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL,
  PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL,
  PROMOTION_ORIGINAL_RENDERER_URL,
  PROMOTION_HEALTH_REQUEST_MAX_AGE_MS,
  promotionOriginalRendererEvidenceUrl,
  promotionOriginalRendererLogUrl,
  promotionRendererDocumentUrl,
  promotionRendererLoadRejection,
  readCodexAuth,
  shouldFailPromotionOriginalRendererProvisionalLoad,
  validatePromotionOriginalRendererLoadObserved,
  validatePromotionOriginalRendererHandshake,
  validatePromotionOriginalRendererMountTimeout,
  validatePromotionRendererHandshake,
  verifyPromotionOriginalRendererBackgroundThrottlingDisabled,
  type HealthValue,
  type PromotionRendererProofResult,
  type PromotionSurfaceName,
  type UserQuestionsHealthObservation,
} from "./promotion-health";
import {
  applyManagedCodexCliLaneAtBootstrap,
  createCodexCliManager,
  mutateCodexFeature,
  type ArchiveEntry,
  type CodexCliManagerDependencies,
} from "./codex-cli-manager";
import type { CodexCliLane } from "./codex-version-types";
import type {
  CodexReleaseCacheEntry,
  CodexVersionsSnapshot,
  GitHubCodexRelease,
} from "./codex-version-types";
import {
  buildCodexFeatureUnion,
  codexVersionChannel,
  compareCodexVersions,
  createCodexVersionService,
  isCodexDesktopUpdateNewer,
  parseCodexVersionTag,
  probeCodexDesktopVersion,
} from "./codex-version-service";
import {
  configureCodexSparkleBridge,
  createHealthProbeCodexSparkleBridgeOptions,
  getCodexSparkleBridge,
  type SparkleAppcastMetadata,
} from "./codex-sparkle-bridge";
import { installCodexAppServerParent, resolveAccountsAuthorityMode } from "./codex-app-server-parent";
import {
  type CodexDesktopUpdateMetadata,
  type CodexDesktopUpdateTarget,
} from "./codex-desktop-update-service";
import {
  readTweakersManagerOfficialSourceRegistration,
  readTweakersManagerStatus,
  startTweakersManagerOfficialSourceRegistration,
  startTweakersManagerAction,
  type TweakersManagerStatus,
} from "./tweakers-manager-client";
import {
  environmentModeCacheMenuInputFromStatus,
} from "./codex-desktop-update-menu";
import {
  activeVerifiedCodexDesktopProfileIdentity,
  codexDesktopUpdateTargetForProfile,
  createCapturedCodexDesktopProfileFeed,
  readCapturedCodexDesktopProfileFeed,
  safePersistedAppcastUrl,
  verifiedCodexDesktopProfileIdentity,
  type CapturedCodexDesktopProfileFeed,
} from "./codex-desktop-update-profile";
import {
  userQuestionsBrokerSelfTest,
  userQuestionsMainLifecycleSelfTest,
  userQuestionsSchemaSelfTest,
  type UserQuestionsBrokerModule,
  type UserQuestionsLifecycleModule,
  type UserQuestionsSchemaModule,
} from "./user-questions-promotion-selftest";

// Tweakers is the public name. Keep the Tweakers variables as compatibility
// aliases so existing patched apps and user data continue to boot.
const LEGACY_CONFIG_KEY = ["codex", "Plus", "Plus"].join("");
const LEGACY_USER_ROOT_ENV = ["CODEX", "PLUSPLUS", "USER_ROOT"].join("_");
const LEGACY_RUNTIME_ENV = ["CODEX", "PLUSPLUS", "RUNTIME"].join("_");
const LEGACY_MANUAL_UPDATE_ENV = ["CODEX", "PLUSPLUS", "MANUAL_UPDATE"].join("_");
const LEGACY_STORE_INDEX_ENV = ["CODEX", "PLUSPLUS", "STORE_INDEX_URL"].join("_");
const LEGACY_REMOTE_DEBUG_ENV = [["CODEX", "PP"].join(""), "REMOTE_DEBUG"].join("_");
const LEGACY_REMOTE_DEBUG_PORT_ENV = [["CODEX", "PP"].join(""), "REMOTE_DEBUG_PORT"].join("_");
const LEGACY_STORE_METADATA = [".codex", "pp-store.json"].join("");
const LEGACY_DATA_DIR = ["codex", "plusplus"].join("-");
const LEGACY_WINDOW_SERVICES_KEY = ["__codex", "pp_window_services__"].join("");
const userRoot = process.env.TWEAKERS_USER_ROOT
  ?? process.env.TWEAKER_USER_ROOT
  ?? process.env[LEGACY_USER_ROOT_ENV];
const runtimeDir = process.env.TWEAKERS_RUNTIME
  ?? process.env.TWEAKER_RUNTIME
  ?? process.env[LEGACY_RUNTIME_ENV];

if (!userRoot || !runtimeDir) {
  throw new Error(
    "Tweakers runtime started without a supported user-root/runtime environment",
  );
}

const healthCheckOnly = process.env.TWEAKERS_HEALTH_CHECK_ONLY === "1";
const runningAppRoot = inferMacAppRoot();
const derivedVariant = !desktopUpdateStartupEnabled(process.env, {
  appPath: runningAppRoot,
  bundleIdentifier: runningAppRoot ? readBundleIdentifier(runningAppRoot) : null,
});
// This is deliberately ahead of app-server interception and every tweak
// lifecycle. A derived process that cannot prove its committed generation
// never gets a chance to create a local broker, child, or renderer surface.
// Electron's ordinary fs facade presents app.asar as a virtual directory.
// The active-generation receipt must hash the physical archive and bundle, so
// pass the adapter that bypasses Electron's ASAR virtualization. This is kept
// local to the receipt verifier; process.noAsar is intentionally never set.
assertTweakersVariantBootstrap({ fileSystem: originalFs as unknown as TweakersVariantFilesystem });
const accountsBrokerRootResolution = resolveAccountsBrokerRootResolution({ userRoot, derivedVariant });
const accountsBrokerRoot = accountsBrokerRootResolution.root;
// This boolean is the only invalid-root fact passed to the app-server parent;
// no raw alias value is projected to renderer or tweak code.
const accountsBrokerRootConfigured = accountsBrokerRootResolution.configured;
// This mode is chosen in main before any Accounts tweak code or renderer IPC
// executes. It contains no path, config, secret, or broker-health details.
const accountsAuthorityMode = resolveAccountsAuthorityMode({
  userRoot,
  brokerRoot: accountsBrokerRoot,
  brokerRootConfigured: accountsBrokerRootConfigured,
});
Object.defineProperty(globalThis, "__tweakersAccountsDesktopProjectsEnabledV1", {
  value: () => derivedVariant && accountsAuthorityMode === "global-v3",
  configurable: false,
  writable: false,
});
const DERIVED_VARIANT_ACTION_DISABLED_REASON =
  "Independent Tweakers maintenance is available only through the verified global manager.";

interface MainAccountsBrokerClient {
  socket: AccountsBrokerSocketClientV1;
  adapter: AccountsBrokerRendererAdapterV1;
}

/**
 * An OAuth handoff is tied to one exact main-frame document, not merely the
 * lifetime of its WebContents. The opaque context object is created by the
 * main IPC handler and is the only capability a main tweak can forward back
 * into the Accounts bridge; none of this state is exposed to a renderer.
 */
interface AccountsBrokerRendererInvocation {
  readonly webContentsId: number;
  readonly mainFrame: Electron.WebFrameMain;
  readonly documentUrl: string;
  readonly navigationEpoch: number;
}

interface AccountsBrokerNavigationTracker {
  epoch: number;
  readonly onNavigation: (
    event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
}

const SHARED_HISTORY_MAP_NATIVE_TARGET_CHANNEL = "tweaker:shared-history-map-native-target";
const SHARED_HISTORY_MAX_NATIVE_TARGET_IDS = 128;
const SHARED_HISTORY_MAX_NATIVE_TARGET_ID_BYTES = 512;

interface SharedHistoryNativeTargetRequestV1 {
  version: 1;
  conversationNativeId: string;
  composerNativeId: string;
  assistantTurnNativeIds: readonly string[];
}

type SharedHistoryNativeTargetResponseV1 =
  | { version: 1; status: "mapped"; conversationId: `conversation_${string}`; turnIds: Array<`turn_${string}`> }
  | { version: 1; status: "unavailable" };

// Keep the owner-private capability in main only. The app-server parent gets
// HMAC-derived endpoint refs at spawn time, never this value or a socket path.
const accountsBrokerSecret = accountsBrokerRoot ? readAccountsBrokerSecret(accountsBrokerRoot) : null;
const accountsBrokerClients = new Map<number, MainAccountsBrokerClient>();
const accountsBrokerInvocationContexts = new WeakMap<object, AccountsBrokerRendererInvocation>();
const accountsBrokerNavigationTrackers = new Map<number, AccountsBrokerNavigationTracker>();
// A process-local nonce makes otherwise identical `webContents.id` values in
// ChatGPT and the derived Tweakers app different broker principals. It stays
// in main only; clients receive the derived HMAC refs, never this binding.
const accountsBrokerSessionNonce = randomUUID();
const accountsBrokerClientKind = derivedVariant ? "tweakers" as const : "chatgpt" as const;
const accountsBrokerBundleIdentity = derivedVariant ? "co.tweakers.desktop" : "com.openai.chatgpt";

function accountsBrokerIdentityBinding() {
  return {
    clientKind: accountsBrokerClientKind,
    bundleIdentity: accountsBrokerBundleIdentity,
    sessionNonce: accountsBrokerSessionNonce,
  };
}

/**
 * How long a health process may take to answer the promotion request AFTER its
 * renderer proof has settled, before it exits on its own terms.
 *
 * Generous by three orders of magnitude against the ~47ms a real receipt takes,
 * because the only thing this catches is a blocked main thread — and it must
 * stay far below the installer's HEALTH_PROBE_PROCESS_TIMEOUT_MS (170s), whose
 * expiry kills the probe with no receipt and fails the promotion outright.
 */
const HEALTH_RECEIPT_WATCHDOG_MS = 30_000;

// Install before OpenAI's original main module loads and captures `spawn`.
// This keeps the locally signed desktop shell outside the native browser
// peer-authorizer's three-process ancestry window while preserving all of the
// native host's existing signature and identifier checks.
const codexAppServerParent = installCodexAppServerParent({
  secondaryVariant: derivedVariant,
  secondaryVariantSharedSqliteHome: derivedVariant
    ? process.env.CODEX_SQLITE_HOME
    : undefined,
  accountRouter: accountsBrokerRoot ? {
    userRoot,
    brokerRoot: accountsBrokerRoot,
    brokerRootConfigured: accountsBrokerRootConfigured,
    resolveBrokerDesktopIdentity: () => {
      if (!accountsBrokerSecret) return null;
      const owner = BrowserWindow.getFocusedWindow() ?? getPrimaryCodexWindow();
      const webContentsId = owner?.webContents?.id;
      if (!webContentsId || !ownedCodexRenderer(webContentsId)) return null;
      const binding = accountsBrokerIdentityBinding();
      return {
        rendererRef: createOpaqueRendererRef(accountsBrokerSecret, webContentsId, binding),
        appToolsRef: createOpaqueAppToolsRef(accountsBrokerSecret, webContentsId, binding),
      };
    },
  } : {
    userRoot,
    brokerRoot: null,
    brokerRootConfigured: accountsBrokerRootConfigured,
  },
});

// Renderer identities are resolved at the main boundary and then converted to
// HMAC-derived opaque refs. Neither a renderer nor a tweak receives the socket
// path, the shared capability, or another desktop's endpoint.
function accountsBrokerClientForRenderer(webContentsId: number): MainAccountsBrokerClient | null {
  const renderer = ownedCodexRenderer(webContentsId);
  if (accountsAuthorityMode !== "global-v3" || !accountsBrokerRoot || !accountsBrokerSecret || !renderer) return null;
  const existing = accountsBrokerClients.get(webContentsId);
  if (existing) return existing;
  try {
    const binding = accountsBrokerIdentityBinding();
    const rendererRef = createOpaqueRendererRef(accountsBrokerSecret, webContentsId, binding);
    const socket = new AccountsBrokerSocketClientV1({
      root: accountsBrokerRoot,
      secret: accountsBrokerSecret,
      clientKind: accountsBrokerClientKind,
      rendererRef,
      appToolsRef: createOpaqueAppToolsRef(accountsBrokerSecret, webContentsId, binding),
    });
    const client = {
      socket,
      adapter: new AccountsBrokerRendererAdapterV1({ secret: accountsBrokerSecret, client: socket, rendererRef }),
    } satisfies MainAccountsBrokerClient;
    replaceAccountsBrokerClient(webContentsId, client);
    renderer.once("destroyed", () => disposeAccountsBrokerClient(webContentsId, client));
    if (renderer.isDestroyed()) {
      disposeAccountsBrokerClient(webContentsId, client);
      return null;
    }
    return client;
  } catch {
    return null;
  }
}

function replaceAccountsBrokerClient(webContentsId: number, client: MainAccountsBrokerClient): void {
  const previous = accountsBrokerClients.get(webContentsId);
  accountsBrokerClients.set(webContentsId, client);
  if (previous && previous !== client) closeAccountsBrokerClient(previous);
}

function disposeAccountsBrokerClient(webContentsId: number, expected?: MainAccountsBrokerClient): void {
  const client = accountsBrokerClients.get(webContentsId);
  if (!client || (expected && client !== expected)) return;
  accountsBrokerClients.delete(webContentsId);
  closeAccountsBrokerClient(client);
}

function closeAccountsBrokerClient(client: MainAccountsBrokerClient): void {
  void client.socket.close().catch(() => {});
}

async function invokeAccountsBroker(
  input: Readonly<{ webContentsId: number }>,
  envelope: AccountsBrokerIpcEnvelopeV1,
): Promise<BrokerResponseV1> {
  const client = accountsBrokerClientForRenderer(input.webContentsId);
  if (!client) {
    markRuntimeReadyBrokerState(accountsAuthorityMode === "blocked" ? "blocked" : "unavailable");
    const setupRequired = accountsAuthorityMode !== "legacy"
      && ownedCodexRenderer(input.webContentsId) !== null
      && readAccountsBrokerSetupState(accountsBrokerRoot) === "setup-required";
    return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: false,
      error: { code: setupRequired ? "broker_setup_required" : "broker_unavailable", retryable: !setupRequired } };
  }
  try {
    const nativeParams = envelope.params && typeof envelope.params === "object" && !Array.isArray(envelope.params)
      ? envelope.params as Record<string, unknown> : null;
    if (envelope.command === "native.request" && nativeParams
      && typeof nativeParams.method === "string" && nativeParams.method.startsWith("browser.")) {
      const params = nativeParams;
      const invocation = accountsBrokerInvocationContexts.get(input);
      const translated = client.adapter.translateNativeBrowserRequest({ accountId: params.accountId, method: params.method, params: params.params });
      if (!invocation || params.surface !== "plugins" || !translated || typeof params.accountId !== "string") {
        return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: false, error: { code: "invalid_request", retryable: false } };
      }
      const result = await invokeAccountsNativeBrowserAction({ accountId: params.accountId, ...translated }, {
        isCurrent: () => isTweakEnabled("co.tweakers.account-switcher") && isCurrentAccountsBrokerRendererInvocation(invocation, client),
        compatibility: () => readAccountsNativeCompatibility(join(process.resourcesPath, "app.asar")),
        bridge: () => (globalThis as any).__tweakersAccountsNativeMainV1,
        context: (accountId) => client.adapter.resolveNativeBrowserContext(accountId),
        request: (accountId, method, requestParams) => client.adapter.invokeNativeBrowserRequest(accountId, method, requestParams),
      });
      return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: true, result: { accountId: params.accountId, surface: "plugins", result } };
    }
    const response = await client.adapter.invoke(envelope);
    markRuntimeReadyBrokerState(response.ok ? "connected" : "unavailable");
    if (isMcpOAuthAuthorizationRequest(envelope)) {
      const invocation = accountsBrokerInvocationContexts.get(input);
      if (!invocation || invocation.webContentsId !== input.webContentsId) {
        return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: false, error: { code: "broker_unavailable", retryable: true } };
      }
      return consumeMcpOAuthAuthorizationHandoff(invocation, envelope, client, response);
    }
    return response;
  } catch {
    markRuntimeReadyBrokerState("unavailable");
    return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: false, error: { code: "broker_unavailable", retryable: true } };
  }
}

/**
 * OAuth URLs are an initiating-renderer-bound, main-process-only handoff.
 * The broker adapter has already validated the private account/definition
 * binding and safe HTTPS URL; this boundary rechecks the public binding before
 * asking the operating system to open it, then returns only connection state.
 * No tweak or renderer receives the provider URL.
 */
async function consumeMcpOAuthAuthorizationHandoff(
  input: AccountsBrokerRendererInvocation,
  envelope: AccountsBrokerIpcEnvelopeV1,
  client: MainAccountsBrokerClient,
  response: BrokerResponseV1,
): Promise<BrokerResponseV1> {
  const handoff = validatedMcpOAuthAuthorizationHandoff(envelope, response);
  if (!handoff) {
    return { version: 1, requestId: accountsBrokerRequestId(envelope), ok: false, error: { code: "provider_confirmation_required", retryable: false } };
  }
  // The initiating document can disappear or be replaced while the private
  // broker request is pending. Never let that stale response launch a browser
  // for a later account/connection selection or a destroyed renderer.
  if (!isCurrentAccountsBrokerRendererInvocation(input, client)) {
    return { version: 1, requestId: handoff.requestId, ok: false, error: { code: "broker_unavailable", retryable: true } };
  }
  try {
    await shell.openExternal(handoff.oauthUrl);
  } catch {
    return { version: 1, requestId: handoff.requestId, ok: false, error: { code: "broker_unavailable", retryable: true } };
  }
  return {
    version: 1,
    requestId: handoff.requestId,
    ok: true,
    result: { accountId: handoff.accountId, connections: [handoff.connection] },
  };
}

function accountsBrokerInvocationForMainFrame(
  event: Electron.IpcMainInvokeEvent,
  renderer: Electron.WebContents,
): AccountsBrokerRendererInvocation | null {
  const mainFrame = event.senderFrame;
  if (!mainFrame || mainFrame !== renderer.mainFrame) return null;
  const tracker = accountsBrokerNavigationTracker(renderer);
  return Object.freeze({
    webContentsId: renderer.id,
    mainFrame,
    documentUrl: mainFrame.url,
    navigationEpoch: tracker.epoch,
  });
}

function accountsBrokerNavigationTracker(renderer: Electron.WebContents): AccountsBrokerNavigationTracker {
  const existing = accountsBrokerNavigationTrackers.get(renderer.id);
  if (existing) return existing;
  const tracker: AccountsBrokerNavigationTracker = {
    epoch: 0,
    onNavigation: (_event, _url, _isInPlace, isMainFrame) => {
      // The old document is not permitted to finish an OAuth handoff once a
      // main-frame navigation or reload has begun, even before it commits.
      if (isMainFrame) tracker.epoch += 1;
    },
  };
  accountsBrokerNavigationTrackers.set(renderer.id, tracker);
  renderer.on("did-start-navigation", tracker.onNavigation);
  renderer.once("destroyed", () => {
    renderer.removeListener("did-start-navigation", tracker.onNavigation);
    if (accountsBrokerNavigationTrackers.get(renderer.id) === tracker) accountsBrokerNavigationTrackers.delete(renderer.id);
  });
  return tracker;
}

/** Exact sender document proof checked after every asynchronous OAuth wait. */
function isCurrentAccountsBrokerRendererInvocation(
  input: AccountsBrokerRendererInvocation,
  client: MainAccountsBrokerClient,
): boolean {
  const renderer = ownedCodexRenderer(input.webContentsId);
  const tracker = accountsBrokerNavigationTrackers.get(input.webContentsId);
  const current = renderer && tracker ? {
    webContentsId: renderer.id,
    mainFrame: renderer.mainFrame,
    documentUrl: renderer.mainFrame.url,
    navigationEpoch: tracker.epoch,
  } : null;
  return accountsBrokerClients.get(input.webContentsId) === client
    && isSameAccountsBrokerDocument(input, current);
}

/** Pure comparison kept separately testable for same-WebContents reload races. */
function isSameAccountsBrokerDocument(
  input: Readonly<{ webContentsId: number; mainFrame: object; documentUrl: string; navigationEpoch: number }>,
  current: Readonly<{ webContentsId: number; mainFrame: object; documentUrl: string; navigationEpoch: number }> | null,
): boolean {
  return current !== null
    && input.webContentsId === current.webContentsId
    && input.mainFrame === current.mainFrame
    && input.documentUrl === current.documentUrl
    && input.navigationEpoch === current.navigationEpoch;
}

function isMcpOAuthAuthorizationRequest(envelope: AccountsBrokerIpcEnvelopeV1): boolean {
  if (envelope.command !== "connection.authorize" || !isMainRecord(envelope.params)) return false;
  const params = envelope.params;
  return Object.keys(params).sort().join("\0") === ["accountId", "connectionId", "surface"].join("\0")
    && isMainPublicAccountId(params.accountId)
    && isMainPublicConnectionId(params.connectionId)
    && params.surface === "mcp";
}

function validatedMcpOAuthAuthorizationHandoff(
  envelope: AccountsBrokerIpcEnvelopeV1,
  response: BrokerResponseV1,
): { requestId: string; accountId: string; connection: Record<string, unknown>; oauthUrl: string } | null {
  if (!isMcpOAuthAuthorizationRequest(envelope) || !response.ok || response.requestId !== envelope.requestId || !isMainRecord(response.result)) return null;
  const params = envelope.params as Record<string, unknown>;
  const result = response.result;
  if (Object.keys(result).sort().join("\0") !== ["accountId", "connections", "oauthUrl"].join("\0")
    || result.accountId !== params.accountId || !isHostSafeOAuthUrl(result.oauthUrl) || !Array.isArray(result.connections) || result.connections.length !== 1) return null;
  const connection = result.connections[0];
  if (!isMainRecord(connection)
    || Object.keys(connection).sort().join("\0") !== ["authorizationAvailable", "connectionId", "label", "status", "surface"].join("\0")
    || connection.connectionId !== params.connectionId || connection.surface !== "mcp" || connection.authorizationAvailable !== true
    || typeof connection.label !== "string" || connection.label.length < 1 || connection.label.length > 128 || /[\u0000-\u001f\u007f]/.test(connection.label)
    || !["connected", "setup_required", "expired", "unavailable"].includes(String(connection.status))) return null;
  return { requestId: response.requestId, accountId: result.accountId as string, connection, oauthUrl: result.oauthUrl };
}

function isHostSafeOAuthUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
    for (const [key, item] of url.searchParams) {
      if (/^(?:access_?token|refresh_?token|id_?token|token|code|client_?secret|credential|cookie)$/i.test(key)) return false;
      if (/(?:bearer\s+|sk-[A-Za-z0-9]|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i.test(item)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isMainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isMainPublicAccountId(value: unknown): value is string {
  return typeof value === "string" && /^account_[A-Za-z0-9_-]{16,128}$/.test(value);
}

function isMainPublicConnectionId(value: unknown): value is string {
  return typeof value === "string" && /^connection_[A-Za-z0-9_-]{16,128}$/.test(value);
}

function markRuntimeReadyBrokerState(state: RuntimeReadyBrokerState): void {
  runtimeReadyBrokerState = state;
  tryWriteRuntimeReadyReceipt();
}

function subscribeAccountsBroker(
  input: Readonly<{ webContentsId: number }>,
  handler: (event: RendererBrokerEventV1) => void,
): () => void {
  if (typeof handler !== "function") return () => {};
  const client = accountsBrokerClientForRenderer(input.webContentsId);
  return client ? client.adapter.subscribe(handler) : () => {};
}

function accountsBrokerRequestId(value: unknown): string {
  return value && typeof value === "object" && typeof (value as { requestId?: unknown }).requestId === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test((value as { requestId: string }).requestId)
    ? (value as { requestId: string }).requestId
    : "invalid";
}

/**
 * The privileged preload owns native DOM identifiers. This runtime-only
 * channel maps them through the renderer-bound broker adapter, then drops
 * every native identifier before replying. It is deliberately not part of
 * the Accounts tweak IPC surface or BrokerCommandV1 vocabulary.
 */
async function mapSharedHistoryNativeTarget(
  webContentsId: number,
  payload: unknown,
): Promise<SharedHistoryNativeTargetResponseV1> {
  const request = parseSharedHistoryNativeTargetRequest(payload);
  const client = request ? accountsBrokerClientForRenderer(webContentsId) : null;
  if (!request || !client) return sharedHistoryTargetUnavailable();
  try {
    const mapped = await client.adapter.mapBoundNativeTargets(request);
    return publicSharedHistoryTargetResponse(request, mapped);
  } catch {
    return sharedHistoryTargetUnavailable();
  }
}

function parseSharedHistoryNativeTargetRequest(value: unknown): SharedHistoryNativeTargetRequestV1 | null {
  if (!isExactRecord(value, ["assistantTurnNativeIds", "composerNativeId", "conversationNativeId", "version"])
    || value.version !== 1
    || !isBoundedNativeTargetId(value.conversationNativeId)
    || !isBoundedNativeTargetId(value.composerNativeId)
    || !Array.isArray(value.assistantTurnNativeIds)
    || value.assistantTurnNativeIds.length > SHARED_HISTORY_MAX_NATIVE_TARGET_IDS
    || !value.assistantTurnNativeIds.every(isBoundedNativeTargetId)) return null;
  const ids = new Set(value.assistantTurnNativeIds);
  if (ids.size !== value.assistantTurnNativeIds.length) return null;
  return {
    version: 1,
    conversationNativeId: value.conversationNativeId,
    composerNativeId: value.composerNativeId,
    assistantTurnNativeIds: value.assistantTurnNativeIds,
  };
}

function publicSharedHistoryTargetResponse(
  request: SharedHistoryNativeTargetRequestV1,
  value: unknown,
): SharedHistoryNativeTargetResponseV1 {
  if (isExactRecord(value, ["status", "version"]) && value.version === 1 && value.status === "unavailable") {
    return sharedHistoryTargetUnavailable();
  }
  if (!isExactRecord(value, ["conversationId", "status", "turnIds", "version"])
    || value.version !== 1
    || value.status !== "mapped"
    || !isPublicSharedHistoryConversationId(value.conversationId)
    || !Array.isArray(value.turnIds)
    || value.turnIds.length !== request.assistantTurnNativeIds.length) return sharedHistoryTargetUnavailable();

  const turnIds: Array<`turn_${string}`> = [];
  const publicIds = new Set<string>();
  for (const turnId of value.turnIds) {
    if (!isPublicSharedHistoryTurnId(turnId) || publicIds.has(turnId)) return sharedHistoryTargetUnavailable();
    publicIds.add(turnId);
    turnIds.push(turnId);
  }
  return { version: 1, status: "mapped", conversationId: value.conversationId, turnIds };
}

function sharedHistoryTargetUnavailable(): SharedHistoryNativeTargetResponseV1 {
  return { version: 1, status: "unavailable" };
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isBoundedNativeTargetId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= SHARED_HISTORY_MAX_NATIVE_TARGET_ID_BYTES
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isPublicSharedHistoryConversationId(value: unknown): value is `conversation_${string}` {
  return typeof value === "string" && /^conversation_[A-Za-z0-9_-]{43}$/.test(value);
}

function isPublicSharedHistoryTurnId(value: unknown): value is `turn_${string}` {
  return typeof value === "string" && /^turn_[A-Za-z0-9_-]{43}$/.test(value);
}

// Same seam, same reason: OpenAI's main captures `dialog` when it loads, so a
// disposable health process has to be blinded to modal panels before that
// happens. Deferred logging — `log` is hoisted but LOG_FILE is not yet
// initialised here, and a suppressed dialog can only occur long after startup.
applyHealthProbeDialogSuppression({
  dialog,
  healthCheckOnly,
  onSuppressed: (record) => {
    log("warn", "health process suppressed a modal dialog", record);
  },
});

const PRELOAD_PATH = resolve(runtimeDir, "preload.js");
const PROMOTION_HEALTH_PRELOAD_PATH = resolve(runtimeDir, "promotion-health-preload.js");
const TWEAKS_DIR = join(userRoot, "tweaks");
const LOG_DIR = join(userRoot, "log");
const LOG_FILE = join(LOG_DIR, "main.log");
const CONFIG_FILE = join(userRoot, "config.json");
const MCP_RUNTIME_PATHS = resolveMcpRuntimePaths({
  userRoot,
  homeDirectory: homedir(),
  env: process.env,
});
const CODEX_CONFIG_FILE = MCP_RUNTIME_PATHS.configPath;
const INSTALLER_STATE_FILE = join(userRoot, "state.json");
const SELF_UPDATE_STATE_FILE = join(userRoot, "self-update-state.json");
const MCP_SYNC_STATE_FILE = MCP_RUNTIME_PATHS.statePath;
const ENVIRONMENT_SELECTION_FILE = join(userRoot, "environment-selection.json");
const ENVIRONMENT_REGISTRY_FILE = join(userRoot, "environment-registry.json");
const ENVIRONMENT_RUNTIME_PROOF_FILE = join(userRoot, "environment-runtime-proof.json");
// A manager-staged expectation turns the post-promotion readiness file into a
// one-use, operation-bound receipt. It is optional for older transactions;
// when absent we retain the existing environment-runtime-proof compatibility
// path without inventing an operation identity.
const RUNTIME_READY_EXPECTATION_FILE = join(userRoot, "runtime-ready-expectation.json");
const RUNTIME_READY_FILE = join(userRoot, "runtime-ready.json");
const INDEPENDENT_TWEAKERS_LIVE_HEALTH_FILE = join(userRoot, "independent-live-health.json");
const INDEPENDENT_TWEAKERS_APP_ROOT = "/Applications/Tweakers.app";
const INDEPENDENT_TWEAKERS_BUNDLE_ID: "com.therealityreport.tweakers" = "com.therealityreport.tweakers";
const ENVIRONMENT_STATUS_TIMEOUT_MS = 60_000;
const ENVIRONMENT_PREPARE_TIMEOUT_MS = 15 * 60_000;
const ENVIRONMENT_ACTION_TIMEOUT_MS = 30_000;
const CLI_JSON_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const TWEAK_CATALOG_FILE = join(runtimeDir, "catalog.json");
const TWEAK_BUNDLED_SOURCE_DIR = join(runtimeDir, "tweaks");
const TWEAK_LIFECYCLE_FILE = join(userRoot, "tweak-lifecycle.json");
const TWEAK_STARTUP_TIMEOUT_ENV = "TWEAKERS_TWEAK_STARTUP_TIMEOUT_MS";
let runtimeReadyPreloadInitialized = false;
let runtimeReadyMainInitialized = false;
let runtimeReadyPublished = false;
let runtimeReadySettingsMounted = false;
type RuntimeReadyBrokerState = "connected" | "unavailable" | "blocked";
let runtimeReadyBrokerState: RuntimeReadyBrokerState | null = null;
let runtimeReadySettingsOpenTimer: ReturnType<typeof setInterval> | null = null;
const RUNTIME_READY_SETTINGS_OPEN_INTERVAL_MS = 2_000;
const RUNTIME_READY_SETTINGS_OPEN_ACK_GRACE_MS = 6_000;
const RUNTIME_READY_SETTINGS_OPEN_DEADLINE_MS = 45_000;
const RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS = 30;
let runtimeReadySettingsOpenAttemptCount = 0;
let runtimeReadySettingsOpenAttemptOperationId: string | null = null;
let runtimeReadySettingsOpenTerminalOperationId: string | null = null;
let independentTweakersLiveHealth: IndependentTweakersLiveHealthV1 | null = null;
let independentTweakersLiveHealthCapture: Promise<void> | null = null;
let independentTweakersZoomNormalized = false;
let independentTweakersBrokerProbeInFlight = false;

if (derivedVariant) {
  // A receipt belongs to one process and one manager operation. Never let a
  // newly launched process inherit proof from a prior promotion.
  try { rmSync(RUNTIME_READY_FILE, { force: true }); } catch {}
}
const healthOriginalMain = healthCheckOnly
  && process.env.TWEAKERS_HEALTH_RUN_ORIGINAL_MAIN === "1";

if (healthOriginalMain && process.platform === "darwin" && !codexAppServerParent.installed) {
  throw new Error("original-main health requires the owned signed Codex app-server parent tracker");
}

// The health-only process skips Codex's bootstrap, so register the production
// renderer scheme during module evaluation, before Electron becomes ready.
// The request handler itself remains scoped to the one renderer proof below.
if (healthCheckOnly && !healthOriginalMain) {
  protocol.registerSchemesAsPrivileged([{
    scheme: PROMOTION_RENDERER_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  }]);
}

// Defense in depth for one-shot macOS health processes. The installer passes
// --use-mock-keychain from process start; assert the Chromium switch again at
// the earliest runtime point and fail closed if Electron cannot retain it.
applyHealthProbeKeychainIsolation({
  commandLine: app.commandLine,
  healthCheckOnly,
  platform: process.platform,
});

// Candidate validation is a background bootstrap, not a second user-facing
// ChatGPT launch. Suppress LaunchServices/Dock activation before Electron is
// ready so installer probes never flash extra app icons or steal focus.
if (healthCheckOnly && process.platform === "darwin") {
  try { app.setActivationPolicy("prohibited"); } catch {}
  try { app.dock?.hide(); } catch {}
}
// [3d] requestSingleInstanceLock as defense-in-depth against duplicate launches.
//
// CAVEAT: this does NOT catch installer-side launches — the installer opens the
// app via `open`/LaunchServices, which can spawn or route independently of this
// process lock; the real duplicate-Dock-icon fix is the installer's single
// deterministic launch path (task 3a). And because this is injected code, our
// evaluation order relative to OpenAI's own entrypoint (and any single-instance
// handling it may already do) is NOT guaranteed. Treat this as belt-and-
// suspenders, not the primary fix. Skipped for the health-check probe, which is
// intentionally a short-lived second instance that must run and then exit.
if (!healthCheckOnly) {
  try {
    const gotSingleInstanceLock = app.requestSingleInstanceLock();
    if (!gotSingleInstanceLock) {
      app.quit();
    } else {
      app.on("second-instance", () => {
        const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
        const primary = windows.find((win) => !win.isMinimized()) ?? windows[0];
        if (!primary) return;
        if (primary.isMinimized()) primary.restore();
        primary.show();
        primary.focus();
      });
    }
  } catch (error) {
    log("warn", "single-instance lock setup failed", { message: (error as Error).message });
  }
}
const TWEAKER_VERSION = "1.0.0";
const TWEAKER_REPO = "therealityreport/tweakers";
const TWEAK_STORE_INDEX_URL = process.env.TWEAKER_STORE_INDEX_URL
  ?? process.env[LEGACY_STORE_INDEX_ENV]
  ?? DEFAULT_TWEAK_STORE_INDEX_URL;
const CODEX_WINDOW_SERVICES_KEY = "__tweaker_window_services__";
const mainTweakReadHandlers = new Map<string, (...args: unknown[]) => unknown>();

mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(TWEAKS_DIR, { recursive: true });
// One-time migration: the retired mode-switcher tweak persisted a soft
// vanilla mode; app modes are now real bundle swaps owned by the installer
// (`tweaker mode`). Drop the stale key so it can never gate tweaks again.
if (!healthCheckOnly) removeLegacyModeSwitcherState(userRoot);
const refreshStatusWatcher = chokidar.watch([
  SELF_UPDATE_STATE_FILE,
  join(userRoot, "refresh-state.json"),
  CONFIG_FILE,
], { ignoreInitial: true });
refreshStatusWatcher.on("all", () => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("tweaker:refresh-status-changed");
});
app.once("will-quit", () => { void refreshStatusWatcher.close(); });

// Optional: enable Chrome DevTools Protocol on a TCP port so we can drive the
// running Codex from outside (curl http://localhost:<port>/json, attach via
// CDP WebSocket, take screenshots, evaluate in renderer, etc.). Codex's
// production build sets webPreferences.devTools=false, which kills the
// in-window DevTools shortcut, but `--remote-debugging-port` works regardless
// because it's a Chromium command-line switch processed before app init.
//
// Off by default. Set TWEAKER_REMOTE_DEBUG=1 (optionally TWEAKER_REMOTE_DEBUG_PORT)
// to turn it on. Must be appended before `app` becomes ready; we're at module
// top-level so that's fine.
if (process.env.TWEAKER_REMOTE_DEBUG === "1" || process.env[LEGACY_REMOTE_DEBUG_ENV] === "1") {
  const port = process.env.TWEAKER_REMOTE_DEBUG_PORT ?? process.env[LEGACY_REMOTE_DEBUG_PORT_ENV] ?? "9222";
  app.commandLine.appendSwitch("remote-debugging-port", port);
  log("info", `remote debugging enabled on port ${port}`);
}

interface PersistedState {
  tweaker?: {
    autoUpdate?: boolean;
    safeMode?: boolean;
    updateChannel?: SelfUpdateChannel;
    updateRepo?: string;
    updateRef?: string;
    updateCheck?: TweakerUpdateCheck;
    /** Managed whole-backend selection. Absence preserves a user-owned override. */
    codexCliLane?: CodexCliLane;
    /** Installer-owned exact Alpha channel copy and immutable boot evidence. */
    codexCliPath?: string;
    codexCliVersion?: string;
    codexCliFingerprint?: string;
    /** Redacted validation failure from the most recent managed-lane bootstrap. */
    codexCliBootstrapFailure?: string;
    codexReleaseCache?: Partial<Record<CodexCliLane, CodexReleaseCacheEntry>>;
    codexAppcastCache?: {
      schemaVersion: 1;
      desktopVersion: string;
      marketingVersion: string;
      build: string;
      releaseUrl: string | null;
      /** Safe URL only: credentials, query, and fragment are never persisted. */
      feedUrl: string;
      checkedAt: string;
    };
    codexAppcastProfileCaches?: Partial<Record<"stable" | "alpha", {
      schemaVersion: 1;
      profile: "stable" | "alpha";
      identityKey: string;
      desktopVersion: string;
      marketingVersion: string;
      build: string;
      releaseUrl: string | null;
      /** Safe URL only: credentials, query, and fragment are never persisted. */
      feedUrl: string;
      checkedAt: string;
    }>>;
    /** Captures are profile/identity scoped. Native request headers are never persisted. */
    codexDesktopProfileFeeds?: Partial<Record<"stable" | "alpha", CapturedCodexDesktopProfileFeed>>;
  };
  /** Per-tweak enable flags. Missing entries default to enabled. */
  tweaks?: Record<string, { enabled?: boolean }>;
  /** Cached GitHub release checks. Runtime never auto-installs updates. */
  tweakUpdateChecks?: Record<string, TweakUpdateCheck>;
  /** Last known load/health state for an installed tweak. */
  tweakHealth?: Record<string, TweakHealthRecord>;
}

interface TweakerUpdateCheck {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  updateAvailable: boolean;
  error?: string;
}

interface IndependentManagerStatusProjection {
  deploymentKind: "injected" | "independent";
  manager: {
    available: boolean;
    reason: string | null;
    status: TweakersManagerStatus["status"] | null;
    actions: TweakersManagerStatus["actions"];
  };
}

const INDEPENDENT_MANAGER_STARTUP_REASON =
  "Tweakers is finishing its verified refresh. Manager status will be available after startup.";

/**
 * A manager-owned promotion verifies its freshly opened renderer on a strict
 * deadline. Manager status currently performs signed executable and app
 * validation in child processes; invoking that synchronous path from an IPC
 * handler blocks Electron's main thread and can prevent the renderer from
 * publishing the very receipt the manager is awaiting. The operation-bound
 * expectation is stronger authority than a status refresh, so defer only
 * those read projections until the receipt has been published.
 */
function independentRuntimeReadyCommitPending(): boolean {
  return derivedVariant && readRuntimeReadyExpectation() !== null;
}

function independentManagerStatusDeferredForRuntimeReady(): boolean {
  return !runtimeReadyPublished && independentRuntimeReadyCommitPending();
}

function independentManagerStatusProjection(): IndependentManagerStatusProjection {
  if (!derivedVariant) {
    return {
      deploymentKind: "injected",
      manager: { available: false, reason: null, status: null, actions: [] },
    };
  }
  if (independentManagerStatusDeferredForRuntimeReady()) {
    return {
      deploymentKind: "independent",
      manager: {
        available: false,
        reason: INDEPENDENT_MANAGER_STARTUP_REASON,
        status: null,
        actions: [],
      },
    };
  }
  try {
    const status = readTweakersManagerStatus();
    return {
      deploymentKind: "independent",
      manager: { available: true, reason: null, status: status.status, actions: status.actions },
    };
  } catch {
    // An independent app must not revive any legacy control plane just because
    // the global manager descriptor is absent, stale, or untrusted.
    return {
      deploymentKind: "independent",
      manager: {
        available: false,
        reason: "The verified global Tweakers manager is unavailable. This app is read-only until manager authority is restored.",
        status: null,
        actions: [],
      },
    };
  }
}

function derivedVariantActionBlocked(action: string): {
  started: false;
  disabled: true;
  action: string;
  reason: string;
} {
  return {
    started: false,
    disabled: true,
    action,
    reason: DERIVED_VARIANT_ACTION_DISABLED_REASON,
  };
}

function derivedVariantTweakerUpdateCheck(): TweakerUpdateCheck {
  return {
    checkedAt: new Date().toISOString(),
    currentVersion: TWEAKER_VERSION,
    latestVersion: null,
    releaseUrl: null,
    releaseNotes: null,
    updateAvailable: false,
    error: DERIVED_VARIANT_ACTION_DISABLED_REASON,
  };
}

type SelfUpdateChannel = "stable" | "prerelease" | "custom";
type SelfUpdateStatus = "checking" | "up-to-date" | "updated" | "failed" | "disabled";

interface SelfUpdateState {
  checkedAt: string;
  completedAt?: string;
  status: SelfUpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  targetRef: string | null;
  releaseUrl: string | null;
  repo: string;
  channel: SelfUpdateChannel;
  sourceRoot: string;
  installationSource?: InstallationSource;
  error?: string;
}

interface InstallationSource {
  kind: "github-source" | "homebrew" | "local-dev" | "source-archive" | "unknown";
  label: string;
  detail: string;
}

interface TweakUpdateCheck {
  checkedAt: string;
  repo: string;
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string | null;
  updateAvailable: boolean;
  error?: string;
}

interface TweakVersionDriftRow {
  id: string;
  name: string;
  enabled: boolean;
  hasMcp: boolean;
  liveVersion: string | null;
  runtimeVersion: string | null;
  catalogVersion: string | null;
  status: "current" | "drift" | "missing";
  reason: string;
}

interface TweakHealthSnapshot {
  checkedAt: string;
  catalogCount: number;
  installedCount: number;
  enabledCount: number;
  liveDriftCount: number;
  runtimeDriftCount: number;
  missingLiveCount: number;
  missingRuntimeCount: number;
  mcpRestartRequired: boolean;
  rows: TweakVersionDriftRow[];
}

function readState(): PersistedState {
  try {
    const state = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PersistedState;
    const record = state as PersistedState & Record<string, unknown>;
    const legacy = record[LEGACY_CONFIG_KEY];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      state.tweaker = {
        ...(legacy as NonNullable<PersistedState["tweaker"]>),
        ...(state.tweaker ?? {}),
      };
    }
    delete record[LEGACY_CONFIG_KEY];
    return state;
  } catch {
    return {};
  }
}
function writeState(s: PersistedState): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log("warn", "writeState failed:", String((e as Error).message));
  }
}

// The loader evaluates this module to completion before it requires OpenAI's
// original main entry. Apply the managed lane synchronously here so the
// backend resolver observes the final CODEX_CLI_PATH on its first import.
const bootstrapTweakerState = readState().tweaker;
const selectedManagedCli = bootstrapTweakerState?.codexCliPath
  && bootstrapTweakerState.codexCliVersion
  && bootstrapTweakerState.codexCliFingerprint
  ? {
      binaryPath: bootstrapTweakerState.codexCliPath,
      version: bootstrapTweakerState.codexCliVersion,
      fingerprint: bootstrapTweakerState.codexCliFingerprint,
    }
  : null;
const codexCliBootstrap = applyManagedCodexCliLaneAtBootstrap({
  lane: bootstrapTweakerState?.codexCliLane,
  home: homedir(),
  userRoot,
  env: process.env,
  selectedManagedCli,
  persistFailure: healthCheckOnly ? undefined : (message) => {
    const state = readState();
    state.tweaker ??= {};
    state.tweaker.codexCliBootstrapFailure = message;
    writeState(state);
  },
});
// The schema-v2 environment proof belongs only to the injected ChatGPT mode
// transaction. Independent Tweakers has its own operation-bound runtime-ready
// receipt and deliberately has no injected managed-runtime/current tree.
if (!healthCheckOnly && !derivedVariant) writeEnvironmentRuntimeProof();

const CODEX_RELEASE_API = "https://api.github.com/repos/openai/codex/releases?per_page=100";
const MAX_CODEX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const CODEX_APPCAST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const codexAppcastMetadataByIdentity = new Map<string, SparkleAppcastMetadata>();

const codexVersionService = createCodexVersionService({
  currentVersion: TWEAKER_VERSION,
  now: Date.now,
  readReleaseCache: async (lane) => readState().tweaker?.codexReleaseCache?.[lane] ?? null,
  writeReleaseCache: async (lane, cache) => {
    const state = readState();
    state.tweaker ??= {};
    state.tweaker.codexReleaseCache ??= {};
    state.tweaker.codexReleaseCache[lane] = cache;
    writeState(state);
  },
  fetchReleases: async (signal) => {
    const response = await fetch(CODEX_RELEASE_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `tweakers/${TWEAKER_VERSION}`,
      },
      signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const value = await response.json();
    if (!Array.isArray(value)) throw new Error("GitHub returned an invalid release list");
    return value as GitHubCodexRelease[];
  },
  execFile: (binary, args, options) => execFileResult(binary, args, options.timeoutMs, options.maxOutputBytes),
});

const codexCliManager = createCodexCliManager({
  home: homedir(),
  userRoot,
  deps: createCodexCliManagerDependencies(),
});
if (!healthCheckOnly) codexCliManager.recover();

function createCodexCliManagerDependencies(): CodexCliManagerDependencies {
  return {
    now: () => new Date(),
    operationId: randomUUID,
    resolveRelease: async () => {
      const lookup = await codexVersionService.fetchLatestRelease("beta", { force: true });
      const release = lookup.release;
      if (!release || !release.asset || release.error) {
        throw new Error(lookup.error ?? release?.error ?? "No installable Codex Beta release is available");
      }
      return {
        version: release.version,
        tag: release.tag,
        assetName: release.asset.name,
        assetUrl: release.asset.url,
        digest: release.asset.digest,
        architecture: "aarch64-apple-darwin",
      };
    },
    download: downloadManagedCodexArchive,
    listArchive: listManagedCodexArchive,
    extractArchive: async (archive, destination) => {
      await extractTar({ file: archive, cwd: destination, preservePaths: false, strict: true });
    },
    verifySignature: async (binary) => {
      if (process.platform !== "darwin") return false;
      try {
        await execFileResult("/usr/bin/codesign", ["--verify", "--deep", "--strict", binary], 5_000, 64 * 1024);
        await execFileResult("/usr/bin/codesign", [
          "-R=identifier \"codex\" and anchor apple generic and certificate leaf[subject.OU] = \"2DC432GLL2\"",
          "--verify",
          binary,
        ], 5_000, 64 * 1024);
        return true;
      } catch {
        return false;
      }
    },
    probeVersion: async (binary) => (await execFileResult(binary, ["--version"], 5_000, 64 * 1024)).stdout.trim(),
    probeArchitecture: async (binary) => {
      const output = (await execFileResult("/usr/bin/file", ["-b", binary], 5_000, 64 * 1024)).stdout;
      if (/arm64|aarch64/i.test(output)) return "aarch64-apple-darwin";
      return "unsupported";
    },
  };
}

async function downloadManagedCodexArchive(
  release: { assetUrl: string },
  destination: string,
  onBytes?: (bytes: number) => void,
): Promise<{ bytes: number; digest: string }> {
  const response = await fetch(release.assetUrl, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Codex download returned ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CODEX_DOWNLOAD_BYTES) throw new Error("Codex download exceeds maximum size");
  const digest = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_CODEX_DOWNLOAD_BYTES) {
        callback(new Error("Codex download exceeds maximum size"));
        return;
      }
      digest.update(chunk);
      onBytes?.(bytes);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(destination, { mode: 0o600 }));
  if (declaredLength > 0 && bytes !== declaredLength) throw new Error("Codex download length did not match Content-Length");
  return { bytes, digest: digest.digest("hex") };
}

async function listManagedCodexArchive(archive: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await listTar({
    file: archive,
    onentry: (entry) => {
      const type = entry.type === "File" || entry.type === "OldFile" ? "file"
        : entry.type === "Directory" ? "directory"
          : entry.type.toLowerCase();
      entries.push({ path: entry.path, type, ...(entry.linkpath ? { linkPath: entry.linkpath } : {}) });
    },
  });
  return entries;
}

function execFileResult(
  binary: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(binary, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: maxOutputBytes,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) rejectPromise(error);
      else resolvePromise({ stdout, stderr });
    });
  });
}
function isTweakerAutoUpdateEnabled(): boolean {
  return readState().tweaker?.autoUpdate !== false;
}
function setTweakerAutoUpdate(enabled: boolean): void {
  const s = readState();
  s.tweaker ??= {};
  s.tweaker.autoUpdate = enabled;
  writeState(s);
}
function setTweakerUpdateConfig(config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}): void {
  const s = readState();
  s.tweaker ??= {};
  if (config.updateChannel) s.tweaker.updateChannel = config.updateChannel;
  if ("updateRepo" in config) s.tweaker.updateRepo = cleanOptionalString(config.updateRepo);
  if ("updateRef" in config) s.tweaker.updateRef = cleanOptionalString(config.updateRef);
  writeState(s);
}
function isTweakerSafeModeEnabled(): boolean {
  return readState().tweaker?.safeMode === true;
}

function isTweakEnabled(id: string): boolean {
  const s = readState();
  if (s.tweaker?.safeMode === true) return false;
  if (s.tweakHealth?.[id]?.status === "quarantined") return false;
  return s.tweaks?.[id]?.enabled !== false;
}
function setTweakEnabled(id: string, enabled: boolean): void {
  const s = readState();
  s.tweaks ??= {};
  s.tweaks[id] = { ...s.tweaks[id], enabled };
  writeState(s);
}

function tweakHealth(id: string): TweakHealthRecord | null {
  return readState().tweakHealth?.[id] ?? null;
}

function recordTweakHealth(id: string, status: TweakHealthRecord["status"], error?: unknown): TweakHealthRecord {
  const state = readState();
  state.tweakHealth ??= {};
  const record: TweakHealthRecord = {
    status,
    updatedAt: new Date().toISOString(),
    ...(error === undefined ? {} : { error: String(error) }),
  };
  state.tweakHealth[id] = record;
  writeState(state);
  return record;
}

function clearTweakHealth(id: string): void {
  const state = readState();
  if (!state.tweakHealth?.[id]) return;
  delete state.tweakHealth[id];
  if (Object.keys(state.tweakHealth).length === 0) delete state.tweakHealth;
  writeState(state);
}

function isTweakQuarantined(id: string): boolean {
  return tweakHealth(id)?.status === "quarantined";
}

function recoverTweak(id: string): Promise<true> {
  clearTweakHealth(id);
  return setTweakEnabledAndReload(id, true, tweakLifecycleDeps);
}

interface InstallerState {
  appRoot: string;
  codexVersion: string | null;
  codexBundleId?: "com.openai.codex" | "com.openai.codex.beta";
  sourceRoot?: string;
}

function readInstallerState(): InstallerState | null {
  try {
    return JSON.parse(readFileSync(INSTALLER_STATE_FILE, "utf8")) as InstallerState;
  } catch {
    return null;
  }
}

function readSelfUpdateState(): SelfUpdateState | null {
  try {
    return JSON.parse(readFileSync(SELF_UPDATE_STATE_FILE, "utf8")) as SelfUpdateState;
  } catch {
    return null;
  }
}
function writeSelfUpdateState(state: SelfUpdateState): void {
  try {
    writeFileSync(SELF_UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("warn", "writeSelfUpdateState failed:", String((e as Error).message));
  }
}

function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function isPathInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function log(level: "info" | "warn" | "error", ...args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ")}\n`;
  try {
    appendCappedLog(LOG_FILE, line);
  } catch {}
  if (level === "error") console.error("[tweaker]", ...args);
}

const lifecycleAttemptId = randomUUID();
let lifecycleJournal: TweakLifecycleJournal;

function readTweakLifecycleJournal(): TweakLifecycleJournal {
  try {
    const parsed = JSON.parse(readFileSync(TWEAK_LIFECYCLE_FILE, "utf8")) as Partial<TweakLifecycleJournal>;
    if (parsed.schemaVersion !== 1 || !parsed.records || typeof parsed.records !== "object") {
      throw new Error("unsupported tweak lifecycle journal");
    }
    return {
      schemaVersion: 1,
      currentAttempt: parsed.currentAttempt && typeof parsed.currentAttempt === "object"
        ? parsed.currentAttempt as TweakLifecycleJournal["currentAttempt"]
        : null,
      records: parsed.records as Record<string, TweakLifecycleRecord>,
    };
  } catch {
    return createTweakLifecycleJournal("uninitialized", process.pid);
  }
}

function writeTweakLifecycleJournal(): void {
  try {
    writeFileSync(TWEAK_LIFECYCLE_FILE, JSON.stringify(lifecycleJournal, null, 2));
  } catch (error) {
    log("warn", "failed to persist tweak lifecycle journal:", String(error));
  }
}

function beginTweakLifecycleAttempt(): void {
  const before = readTweakLifecycleJournal();
  const previous = recoverInterruptedTweaks(before);
  lifecycleJournal = {
    ...previous,
    currentAttempt: {
      id: lifecycleAttemptId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    },
  };
  writeTweakLifecycleJournal();
  for (const [key, record] of Object.entries(previous.records)) {
    const beforeRecord = before.records[key];
    if (beforeRecord?.status !== "starting") continue;
    if (record.status === "quarantined") {
      recordTweakHealth(record.id, "quarantined", record.error);
      log("warn", `quarantined interrupted ${record.process} tweak: ${record.id} (${record.interruptedAttempts ?? "?"} consecutive interruptions)`);
    } else if (record.status === "failed") {
      log("info", `previous startup of ${record.process} tweak ${record.id} was interrupted; retrying this launch`);
    }
  }
}

function finishTweakLifecycleAttempt(): void {
  if (!lifecycleJournal.currentAttempt || lifecycleJournal.currentAttempt.id !== lifecycleAttemptId) return;
  lifecycleJournal = {
    ...lifecycleJournal,
    currentAttempt: {
      ...lifecycleJournal.currentAttempt,
      completedAt: new Date().toISOString(),
    },
  };
  writeTweakLifecycleJournal();
}

function recordTweakLifecycle(
  id: string,
  processName: TweakProcess,
  status: TweakLifecycleStatus,
  error?: unknown,
): TweakLifecycleRecord {
  const now = new Date().toISOString();
  const key = lifecycleRecordKey(processName, id);
  const previous = lifecycleJournal.records[key];
  const record: TweakLifecycleRecord = {
    id,
    process: processName,
    status,
    attemptId: lifecycleAttemptId,
    updatedAt: now,
    ...(status === "starting" ? { startedAt: now } : {}),
    ...(status === "ready" || status === "failed" || status === "timed_out" || status === "disabled" || status === "quarantined"
      ? { finishedAt: now }
      : {}),
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  };
  if (status === "starting" && previous?.startedAt) record.startedAt = previous.startedAt;
  // Carry the consecutive-interruption counter across the retry's "starting"
  // write so repeated interruptions can escalate to quarantine; any terminal
  // outcome (ready/failed/…) starts a fresh record and resets the counter.
  if (status === "starting" && previous?.interruptedAttempts) {
    record.interruptedAttempts = previous.interruptedAttempts;
  }
  lifecycleJournal = {
    ...lifecycleJournal,
    records: { ...lifecycleJournal.records, [key]: record },
  };
  writeTweakLifecycleJournal();

  // Keep the existing health/status contract in sync. A lifecycle failure is
  // per-tweak and therefore must never prevent sibling tweaks from loading.
  if (status === "failed" || status === "timed_out") {
    recordTweakHealth(id, "failed", error ?? status);
  } else if (status === "quarantined") {
    recordTweakHealth(id, "quarantined", error ?? "startup attempt was interrupted");
  } else if (status === "ready") {
    clearTweakHealth(id);
  }
  return record;
}

function lifecycleStartupTimeoutMs(): number {
  const raw = process.env[TWEAK_STARTUP_TIMEOUT_ENV];
  return normalizeTweakStartupTimeoutMs(raw === undefined ? undefined : Number(raw));
}

beginTweakLifecycleAttempt();

function installSparkleUpdateHook(): void {
  if (process.platform !== "darwin" || (!healthCheckOnly && !derivedVariant)) return;

  const Module = require("node:module") as typeof import("node:module") & {
    _load?: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = Module._load;
  if (typeof originalLoad !== "function") return;

  Module._load = function tweakerModuleLoad(request: string, parent: unknown, isMain: boolean) {
    const loaded = originalLoad.apply(this, [request, parent, isMain]) as unknown;
    if (typeof request === "string" && /sparkle(?:\.node)?$/i.test(request)) {
      getCodexSparkleBridge().wrapExports(loaded);
    }
    return loaded;
  };
}

function inferMacAppRoot(): string | null {
  const marker = ".app/Contents/MacOS/";
  const idx = process.execPath.indexOf(marker);
  return idx >= 0 ? process.execPath.slice(0, idx + ".app".length) : null;
}

function readBundleIdentifier(appRoot: string): string | null {
  try {
    const plist = readFileSync(join(appRoot, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

function writeEnvironmentRuntimeProof(): void {
  try {
    const proofUserRoot = userRoot;
    if (!proofUserRoot) throw new Error("could not determine the Tweakers user root");
    const appRoot = inferMacAppRoot();
    if (!appRoot) throw new Error("could not infer the exact running app path");
    const state = readInstallerState();
    const bundleId = state?.codexBundleId ?? null;
    const binaryPath = codexCliBootstrap.binary
      ?? join(appRoot, "Contents", "Resources", "codex");
    if (!existsSync(binaryPath)) throw new Error(`selected backend is missing at ${binaryPath}`);
    const versionProbe = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (versionProbe.status !== 0) throw new Error("selected backend version probe failed");
    const version = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`.trim().split(/\s+/).at(-1) ?? null;
    if (!version) throw new Error("selected backend version is empty");
    const activeRuntimePath = join(proofUserRoot, "runtime");
    const activeRuntime = readRuntimeFingerprintEvidence(activeRuntimePath);
    if (!activeRuntime) throw new Error(`active runtime fingerprint is invalid at ${activeRuntimePath}`);
    const managedRuntimePath = join(
      proofUserRoot,
      "managed-runtime",
      "current",
      "packages",
      "installer",
      "assets",
      "runtime",
    );
    const managedRuntime = readRuntimeFingerprintEvidence(managedRuntimePath);
    if (!managedRuntime) throw new Error(`managed runtime fingerprint is invalid at ${managedRuntimePath}`);
    const managedSourceRuntimeHash = readManagedRuntimeSourceHash(proofUserRoot);
    const installedDesktop = installedCodexDesktopVersion(appRoot);
    if (!installedDesktop.installedMarketingVersion || !installedDesktop.installedBuild) {
      throw new Error("could not prove the running desktop version and build");
    }
    const proof = {
      schemaVersion: 2,
      kind: "environment-runtime-proof",
      pid: process.pid,
      appRoot,
      bundleId,
      desktopVersion: installedDesktop.installedMarketingVersion,
      desktopBuild: installedDesktop.installedBuild,
      appAsarHeaderHash: promotionAppHeaderHash(),
      appExperience: "tweakers",
      releaseProfile: bundleId === "com.openai.codex.beta" ? "alpha" : "stable",
      backendLane: codexCliBootstrap.effectiveLane === "beta" ? "managed-alpha" : "bundled",
      binaryPath,
      backendVersion: version,
      backendFingerprint: createHash("sha256").update(readFileSync(binaryPath)).digest("hex"),
      runtimePath: activeRuntimePath,
      runtimeFingerprint: activeRuntime.fingerprint,
      runtimeFileCount: activeRuntime.fileCount,
      managedRuntimePath,
      managedRuntimeFingerprint: managedRuntime.fingerprint,
      managedRuntimeFileCount: managedRuntime.fileCount,
      managedSourceRuntimeHash,
      observedAt: new Date().toISOString(),
    };
    const temporary = `${ENVIRONMENT_RUNTIME_PROOF_FILE}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, ENVIRONMENT_RUNTIME_PROOF_FILE);
  } catch (error) {
    // A failed startup must never leave a previous process's runtime proof
    // available for a transaction to mistake as current evidence.
    try { rmSync(ENVIRONMENT_RUNTIME_PROOF_FILE, { force: true }); } catch {}
    log("error", "environment runtime proof failed", { message: (error as Error).message });
  }
}

interface RuntimeReadyExpectation {
  schemaVersion: 5;
  kind: "tweakers-independent-runtime-ready-expectation";
  operationId: string;
  promotionId: string;
  activePromotionReceiptSha256: string;
  appRoot: string;
  bundleId: "com.therealityreport.tweakers";
  appAsarHeaderHash: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  brokerAuthorityExpectation: RuntimeReadyBrokerAuthorityExpectation;
  appearanceExpectation: RuntimeReadyAppearanceBinding;
  expectedTweakIds: string[];
  createdAt: string;
}

interface RuntimeReadyAppearanceBinding {
  status: "normal";
  normalized: true;
}

interface RuntimeReadyBrokerAuthorityExpectation {
  globalRootState: "absent" | "valid-v3";
  configSha256: string | null;
}

interface IndependentTweakersAppearanceMetricsV1 {
  electronZoomLevel: number | null;
  electronZoomFactor: number | null;
  cssWindowZoom: number | null;
  rootZoom: number | null;
  bodyZoom: number | null;
  rootFontSizePx: number | null;
  bodyFontSizePx: number | null;
  visualViewportScale: number | null;
  devicePixelRatio: number | null;
  displayScaleFactor: number | null;
  bounds: { x: number; y: number; width: number; height: number };
}

interface IndependentTweakersLiveHealthV1 {
  schemaVersion: 1;
  kind: "tweakers-independent-live-health";
  pid: number;
  processStartToken: string;
  appRoot: string;
  bundleId: "com.therealityreport.tweakers";
  appAsarHeaderHash: string;
  appSignatureSha256: string;
  runtimeFingerprint: string;
  appUserDataRoot: string;
  codexHomeRoot: string;
  accountsBrokerRoot: string;
  accountsBrokerConfigSha256: string | null;
  sharedHistoryBrokerState: "connected" | "blocked";
  initializedTweakIds: string[];
  lifecycleFailures: Array<{
    tweakId: string;
    process: "main" | "renderer";
    status: "failed" | "timedout" | "quarantined" | "pending";
  }>;
  appearance: {
    status: "normal" | "needs_attention" | "not_observed";
    normalized: boolean;
    windowId: number | null;
    before: IndependentTweakersAppearanceMetricsV1 | null;
    after: IndependentTweakersAppearanceMetricsV1 | null;
  };
  observedAt: string;
}

function isRuntimeReadyExpectation(value: unknown): value is RuntimeReadyExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "kind", "operationId", "promotionId", "activePromotionReceiptSha256", "appRoot", "bundleId", "appAsarHeaderHash",
    "runtimeFingerprint", "appUserDataRoot", "codexHomeRoot", "accountsBrokerRoot", "brokerAuthorityExpectation", "appearanceExpectation", "expectedTweakIds", "createdAt",
  ];
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) return false;
  return record.schemaVersion === 5
    && record.kind === "tweakers-independent-runtime-ready-expectation"
    && typeof record.operationId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.operationId)
    && typeof record.promotionId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record.promotionId)
    && typeof record.activePromotionReceiptSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(record.activePromotionReceiptSha256)
    && typeof record.appRoot === "string"
    && isAbsolute(record.appRoot)
    && resolve(record.appRoot) === record.appRoot
    && record.bundleId === "com.therealityreport.tweakers"
    && typeof record.appAsarHeaderHash === "string"
    && /^[a-f0-9]{64}$/i.test(record.appAsarHeaderHash)
    && typeof record.runtimeFingerprint === "string"
    && /^[a-f0-9]{64}$/i.test(record.runtimeFingerprint)
    && typeof record.appUserDataRoot === "string"
    && isAbsolute(record.appUserDataRoot)
    && resolve(record.appUserDataRoot) === record.appUserDataRoot
    && typeof record.codexHomeRoot === "string"
    && isAbsolute(record.codexHomeRoot)
    && resolve(record.codexHomeRoot) === record.codexHomeRoot
    && typeof record.accountsBrokerRoot === "string"
    && isAbsolute(record.accountsBrokerRoot)
    && resolve(record.accountsBrokerRoot) === record.accountsBrokerRoot
    && isRuntimeReadyBrokerAuthorityExpectation(record.brokerAuthorityExpectation)
    && isRuntimeReadyAppearanceBinding(record.appearanceExpectation)
    && Array.isArray(record.expectedTweakIds)
    && record.expectedTweakIds.length > 0
    && record.expectedTweakIds.length <= 128
    && new Set(record.expectedTweakIds).size === record.expectedTweakIds.length
    && record.expectedTweakIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(id))
    && typeof record.createdAt === "string"
    && !Number.isNaN(Date.parse(record.createdAt));
}

function isRuntimeReadyBrokerAuthorityExpectation(value: unknown): value is RuntimeReadyBrokerAuthorityExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["configSha256", "globalRootState"].join("\0")) return false;
  if (record.globalRootState === "absent") return record.configSha256 === null;
  return record.globalRootState === "valid-v3"
    && typeof record.configSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(record.configSha256);
}

function isRuntimeReadyAppearanceBinding(value: unknown): value is RuntimeReadyAppearanceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const appearance = value as Record<string, unknown>;
  return Object.keys(appearance).sort().join("\0") === ["normalized", "status"].join("\0")
    && appearance.status === "normal"
    && appearance.normalized === true;
}

function sameRuntimeReadyAppearanceBinding(
  left: RuntimeReadyAppearanceBinding,
  right: RuntimeReadyAppearanceBinding,
): boolean {
  return left.status === right.status && left.normalized === right.normalized;
}

function readRuntimeReadyExpectation(): RuntimeReadyExpectation | null {
  try {
    const stat = lstatSync(RUNTIME_READY_EXPECTATION_FILE);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("expectation is not a regular file");
    const parsed = JSON.parse(readFileSync(RUNTIME_READY_EXPECTATION_FILE, "utf8")) as unknown;
    return isRuntimeReadyExpectation(parsed) ? parsed : null;
  } catch (error) {
    if (existsSync(RUNTIME_READY_EXPECTATION_FILE)) {
      log("warn", "runtime-ready expectation is unavailable", { message: String((error as Error)?.message ?? error) });
    }
    return null;
  }
}

function runtimeReadyInitializedTweakIds(): string[] | null {
  if (!runtimeReadyMainInitialized || !runtimeReadyPreloadInitialized) return null;
  const enabled = tweakState.discovered
    .filter((tweak) => isTweakEnabled(tweak.manifest.id))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  const ids: string[] = [];
  for (const tweak of enabled) {
    const id = tweak.manifest.id;
    const mainRecord = lifecycleJournal.records[lifecycleRecordKey("main", id)];
    const rendererRecord = lifecycleJournal.records[lifecycleRecordKey("renderer", id)];
    const mainReady = mainRecord?.attemptId === lifecycleAttemptId && mainRecord.status === "ready";
    const rendererReady = rendererRecord?.attemptId === lifecycleAttemptId && rendererRecord.status === "ready";
    if ((tweak.manifest.scope === "main" && !mainReady)
      || (tweak.manifest.scope === "renderer" && !rendererReady)
      || (tweak.manifest.scope === "both" && (!mainReady || !rendererReady))) return null;
    ids.push(id);
  }
  return ids;
}

/**
 * The broker configuration is a sealed cross-app authority boundary.  A
 * missing file is a known blocked state; a present file is useful only when it
 * is an exact, validated global-v3 configuration.  Malformed or partial files
 * deliberately produce no readiness evidence at all.
 */
function currentRuntimeReadyBrokerAuthorityExpectation(): RuntimeReadyBrokerAuthorityExpectation | null {
  if (!accountsBrokerRoot) return null;
  let rootBefore: ReturnType<typeof lstatSync>;
  try {
    rootBefore = lstatSync(accountsBrokerRoot);
  } catch (error) {
    // Only the canonical global root itself being absent is the durable
    // blocked state.  A root that exists but lacks a strict v3 config is not
    // equivalent to the unpublished-root case.
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT"
      ? { globalRootState: "absent", configSha256: null }
      : null;
  }
  const ownerUid = process.getuid?.();
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()
    || (ownerUid !== undefined && rootBefore.uid !== ownerUid)
    || (rootBefore.mode & 0o077) !== 0) return null;
  const configPath = join(accountsBrokerRoot, ACCOUNT_ROUTER_CONFIG_FILE);
  let configBefore: ReturnType<typeof lstatSync>;
  try {
    configBefore = lstatSync(configPath);
    if (!configBefore.isFile() || configBefore.isSymbolicLink() || configBefore.nlink !== 1
      || (ownerUid !== undefined && configBefore.uid !== ownerUid)
      || (configBefore.mode & 0o077) !== 0) return null;
    const bytesBefore = readFileSync(configPath);
    const selection = readRouterLaunchSelection(configPath);
    if (selection.config?.schemaVersion !== 3) return null;
    const configAfter = lstatSync(configPath);
    const rootAfter = lstatSync(accountsBrokerRoot);
    const bytesAfter = readFileSync(configPath);
    if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink()
      || (ownerUid !== undefined && rootAfter.uid !== ownerUid)
      || (rootAfter.mode & 0o077) !== 0
      || rootBefore.dev !== rootAfter.dev || rootBefore.ino !== rootAfter.ino
      || !configAfter.isFile() || configAfter.isSymbolicLink() || configAfter.nlink !== 1
      || (ownerUid !== undefined && configAfter.uid !== ownerUid)
      || (configAfter.mode & 0o077) !== 0
      || configBefore.dev !== configAfter.dev || configBefore.ino !== configAfter.ino
      || !bytesBefore.equals(bytesAfter)) return null;
    return {
      globalRootState: "valid-v3",
      configSha256: createHash("sha256").update(bytesAfter).digest("hex"),
    };
  } catch {
    return null;
  }
}

function sameRuntimeReadyBrokerAuthorityExpectation(
  left: RuntimeReadyBrokerAuthorityExpectation,
  right: RuntimeReadyBrokerAuthorityExpectation,
): boolean {
  return left.globalRootState === right.globalRootState && left.configSha256 === right.configSha256;
}

function expectedRuntimeReadyBrokerState(
  expectation: RuntimeReadyBrokerAuthorityExpectation,
): "connected" | "blocked" {
  return expectation.globalRootState === "valid-v3" ? "connected" : "blocked";
}

function isExactIndependentTweakersProcess(): boolean {
  return derivedVariant
    && !healthCheckOnly
    && runningAppRoot === INDEPENDENT_TWEAKERS_APP_ROOT
    && readBundleIdentifier(INDEPENDENT_TWEAKERS_APP_ROOT) === INDEPENDENT_TWEAKERS_BUNDLE_ID;
}

/**
 * Unlike the general helper, this has no focused-window or first-window
 * fallback.  Auth, update, and auxiliary windows are therefore never targets
 * for a native zoom read or write.
 */
function exactIndependentTweakersPrimaryWindow(): Electron.BrowserWindow | null {
  if (!isExactIndependentTweakersProcess()) return null;
  const services = getCodexWindowServices();
  const fromServices = typeof services?.getPrimaryWindow === "function"
    ? services.getPrimaryWindow("local")
    : null;
  const fromManager = !fromServices && typeof services?.windowManager?.getPrimaryWindow === "function"
    ? services.windowManager.getPrimaryWindow.call(services.windowManager)
    : null;
  const primary = fromServices ?? fromManager;
  if (!primary || primary.isDestroyed()) return null;
  if (!BrowserWindow.getAllWindows().some((window) => window === primary)) return null;
  return primary.webContents.isDestroyed() ? null : primary;
}

function finiteMetric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function cssMetric(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "normal") return normalized === "normal" ? 1 : null;
  const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(normalized);
  if (percent) return finiteMetric(Number(percent[1]) / 100);
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized) ? finiteMetric(Number(normalized)) : null;
}

function readElectronZoomMetric(window: Electron.BrowserWindow, method: "getZoomLevel" | "getZoomFactor"): number | null {
  try {
    const candidate = window.webContents as unknown as Record<string, unknown>;
    const reader = candidate[method];
    return typeof reader === "function" ? finiteMetric(Reflect.apply(reader, window.webContents, [])) : null;
  } catch {
    return null;
  }
}

async function readIndependentTweakersAppearanceMetrics(
  window: Electron.BrowserWindow,
): Promise<IndependentTweakersAppearanceMetricsV1> {
  const bounds = window.getBounds();
  const displayScaleFactor = (() => {
    try { return finiteMetric(screen.getDisplayMatching(bounds).scaleFactor); } catch { return null; }
  })();
  const base: IndependentTweakersAppearanceMetricsV1 = {
    electronZoomLevel: readElectronZoomMetric(window, "getZoomLevel"),
    electronZoomFactor: readElectronZoomMetric(window, "getZoomFactor"),
    cssWindowZoom: null,
    rootZoom: null,
    bodyZoom: null,
    rootFontSizePx: null,
    bodyFontSizePx: null,
    visualViewportScale: null,
    devicePixelRatio: null,
    displayScaleFactor,
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
  };
  try {
    const measured = await withTimeout(window.webContents.executeJavaScript(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const rootStyle = root ? getComputedStyle(root) : null;
      const bodyStyle = body ? getComputedStyle(body) : null;
      return {
        cssWindowZoom: rootStyle?.getPropertyValue("--codex-window-zoom") ?? null,
        rootZoom: rootStyle?.zoom ?? null,
        bodyZoom: bodyStyle?.zoom ?? null,
        rootFontSizePx: rootStyle?.fontSize ?? null,
        bodyFontSizePx: bodyStyle?.fontSize ?? null,
        visualViewportScale: window.visualViewport?.scale ?? null,
        devicePixelRatio: window.devicePixelRatio ?? null,
      };
    })()`, true), 1_500) as unknown;
    if (!measured || typeof measured !== "object" || Array.isArray(measured)) return base;
    const values = measured as Record<string, unknown>;
    return {
      ...base,
      cssWindowZoom: cssMetric(values.cssWindowZoom),
      rootZoom: cssMetric(values.rootZoom),
      bodyZoom: cssMetric(values.bodyZoom),
      rootFontSizePx: cssMetric(values.rootFontSizePx?.toString().replace(/px$/i, "") ?? null),
      bodyFontSizePx: cssMetric(values.bodyFontSizePx?.toString().replace(/px$/i, "") ?? null),
      visualViewportScale: finiteMetric(values.visualViewportScale),
      devicePixelRatio: finiteMetric(values.devicePixelRatio),
    };
  } catch {
    return base;
  }
}

function nativeZoomNeedsNormalization(
  metrics: Pick<IndependentTweakersAppearanceMetricsV1, "electronZoomLevel" | "electronZoomFactor">,
): boolean {
  return (metrics.electronZoomLevel !== null && Math.abs(metrics.electronZoomLevel) > 0.0001)
    || (metrics.electronZoomFactor !== null && Math.abs(metrics.electronZoomFactor - 1) > 0.0001);
}

function nativeZoomObservedAtActualSize(metrics: IndependentTweakersAppearanceMetricsV1 | null): boolean {
  if (!metrics || (metrics.electronZoomLevel === null && metrics.electronZoomFactor === null)) return false;
  return !nativeZoomNeedsNormalization(metrics);
}

function appearanceNeedsAttention(metrics: IndependentTweakersAppearanceMetricsV1): boolean {
  return nativeZoomNeedsNormalization(metrics)
    || [metrics.cssWindowZoom, metrics.rootZoom, metrics.bodyZoom]
      .some((value) => value !== null && Math.abs(value - 1) > 0.0001);
}

function appearanceStatus(
  before: IndependentTweakersAppearanceMetricsV1 | null,
  after: IndependentTweakersAppearanceMetricsV1 | null,
): IndependentTweakersLiveHealthV1["appearance"]["status"] {
  if (!before || !after || (after.electronZoomLevel === null && after.electronZoomFactor === null)) return "not_observed";
  return appearanceNeedsAttention(after) ? "needs_attention" : "normal";
}

function runtimeReadyAppearanceBinding(
  appearance: IndependentTweakersLiveHealthV1["appearance"],
): RuntimeReadyAppearanceBinding | null {
  return appearance.status === "normal" && appearance.normalized === true
    ? { status: "normal", normalized: true }
    : null;
}

/**
 * The persisted live-health sample establishes CSS and viewport state. Re-read
 * Electron's native zoom immediately before receipt publication as well, so a
 * stale healthy sample cannot certify a primary window that has subsequently
 * left Actual Size.
 */
function primaryIndependentTweakersNativeZoomAtActualSize(window: Electron.BrowserWindow): boolean {
  const electronZoomLevel = readElectronZoomMetric(window, "getZoomLevel");
  const electronZoomFactor = readElectronZoomMetric(window, "getZoomFactor");
  return (electronZoomLevel !== null || electronZoomFactor !== null)
    && !nativeZoomNeedsNormalization({ electronZoomLevel, electronZoomFactor });
}

function exactLifecycleHealth(): Pick<IndependentTweakersLiveHealthV1, "initializedTweakIds" | "lifecycleFailures"> {
  const initializedTweakIds: string[] = [];
  const lifecycleFailures: IndependentTweakersLiveHealthV1["lifecycleFailures"] = [];
  const enabled = tweakState.discovered
    .filter((tweak) => isTweakEnabled(tweak.manifest.id))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  for (const tweak of enabled) {
    const requiredProcesses: TweakProcess[] = tweak.manifest.scope === "both"
      ? ["main", "renderer"]
      : tweak.manifest.scope === "main"
        ? ["main"]
        : tweak.manifest.scope === "renderer"
          ? ["renderer"]
          : [];
    let initialized = runtimeReadyMainInitialized && runtimeReadyPreloadInitialized;
    for (const processKind of requiredProcesses) {
      const record = lifecycleJournal.records[lifecycleRecordKey(processKind, tweak.manifest.id)];
      const status = record?.attemptId === lifecycleAttemptId ? record.status : undefined;
      if (status === "ready") continue;
      initialized = false;
      if (status === "failed" || status === "quarantined") {
        lifecycleFailures.push({ tweakId: tweak.manifest.id, process: processKind, status });
      } else if (status === "timed_out") {
        lifecycleFailures.push({ tweakId: tweak.manifest.id, process: processKind, status: "timedout" });
      } else {
        lifecycleFailures.push({ tweakId: tweak.manifest.id, process: processKind, status: "pending" });
      }
    }
    if (initialized) initializedTweakIds.push(tweak.manifest.id);
  }
  return { initializedTweakIds, lifecycleFailures };
}

function independentTweakersAppSignatureSha256(appRoot: string): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appRoot], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 8 * 1024,
    });
    if (result.status !== 0) return null;
    const evidence = `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^(Identifier=|TeamIdentifier=|CDHash=|CodeDirectory|Signature=|Format=)/.test(line))
      .join("\n");
    return evidence.length > 0
      ? createHash("sha256").update(evidence, "utf8").digest("hex")
      : null;
  } catch {
    return null;
  }
}

interface IndependentTweakersLiveHealthProjection {
  appearance: IndependentTweakersLiveHealthV1["appearance"];
  observedAt: string;
}

function independentTweakersLiveHealthProjection(
  health: IndependentTweakersLiveHealthV1 | null,
): IndependentTweakersLiveHealthProjection | null {
  return health ? {
    appearance: health.appearance,
    observedAt: health.observedAt,
  } : null;
}

function isExactIndependentTweakersPrimaryMainFrame(
  sender: Electron.WebContents,
  senderFrame: Electron.WebFrameMain | null,
): boolean {
  const primary = exactIndependentTweakersPrimaryWindow();
  return primary !== null
    && sender === primary.webContents
    && senderFrame === primary.webContents.mainFrame;
}

function publishIndependentTweakersLiveHealth(health: IndependentTweakersLiveHealthV1): void {
  independentTweakersLiveHealth = health;
  try {
    publishIndependentTweakersRuntimeReadyReceipt(INDEPENDENT_TWEAKERS_LIVE_HEALTH_FILE, health);
  } catch (error) {
    log("warn", "independent live health was not published", { message: String((error as Error)?.message ?? error) });
  }
  const primary = exactIndependentTweakersPrimaryWindow();
  if (primary && !primary.webContents.isDestroyed()) {
    primary.webContents.mainFrame.send(
      "tweaker:independent-live-health-changed",
      independentTweakersLiveHealthProjection(health),
    );
  }
}

function scheduleIndependentTweakersLiveHealthCapture(): void {
  if (!derivedVariant || independentTweakersLiveHealthCapture) return;
  independentTweakersLiveHealthCapture = captureIndependentTweakersLiveHealth()
    .catch((error) => log("warn", "independent live health capture failed", { message: String((error as Error)?.message ?? error) }))
    .finally(() => {
      independentTweakersLiveHealthCapture = null;
      tryWriteRuntimeReadyReceipt();
    });
}

async function captureIndependentTweakersLiveHealth(): Promise<void> {
  if (!isExactIndependentTweakersProcess()) return;
  const brokerAuthority = currentRuntimeReadyBrokerAuthorityExpectation();
  const processStartToken = currentProcessStartToken();
  const appAsarHeaderHash = promotionAppHeaderHash();
  const runtimeFingerprint = readRuntimeFingerprintEvidence(runtimeDir!)?.fingerprint;
  const appUserDataRoot = process.env.CODEX_ELECTRON_USER_DATA_PATH;
  const appSignatureSha256 = independentTweakersAppSignatureSha256(INDEPENDENT_TWEAKERS_APP_ROOT);
  if (!brokerAuthority || !processStartToken || !runtimeFingerprint || !appUserDataRoot || !appSignatureSha256 || !accountsBrokerRoot) return;
  const lifecycle = exactLifecycleHealth();
  const brokerState: "connected" | "blocked" = runtimeReadyBrokerState === "connected" ? "connected" : "blocked";
  const primary = exactIndependentTweakersPrimaryWindow();
  if (!primary) {
    publishIndependentTweakersLiveHealth({
      schemaVersion: 1,
      kind: "tweakers-independent-live-health",
      pid: process.pid,
      processStartToken,
      appRoot: INDEPENDENT_TWEAKERS_APP_ROOT,
      bundleId: INDEPENDENT_TWEAKERS_BUNDLE_ID,
      appAsarHeaderHash,
      appSignatureSha256,
      runtimeFingerprint,
      appUserDataRoot,
      codexHomeRoot: MCP_RUNTIME_PATHS.codexHome,
      accountsBrokerRoot,
      accountsBrokerConfigSha256: brokerAuthority.configSha256,
      sharedHistoryBrokerState: brokerState,
      ...lifecycle,
      appearance: { status: "not_observed", normalized: false, windowId: null, before: null, after: null },
      observedAt: new Date().toISOString(),
    });
    return;
  }
  const before = await readIndependentTweakersAppearanceMetrics(primary);
  const provisional = {
    schemaVersion: 1 as const,
    kind: "tweakers-independent-live-health" as const,
    pid: process.pid,
    processStartToken,
    appRoot: INDEPENDENT_TWEAKERS_APP_ROOT,
    bundleId: INDEPENDENT_TWEAKERS_BUNDLE_ID,
    appAsarHeaderHash,
    appSignatureSha256,
    runtimeFingerprint,
    appUserDataRoot,
    codexHomeRoot: MCP_RUNTIME_PATHS.codexHome,
    accountsBrokerRoot,
    accountsBrokerConfigSha256: brokerAuthority.configSha256,
    sharedHistoryBrokerState: brokerState,
    ...lifecycle,
  };
  // Write the pre-normalization observation before touching native zoom.  The
  // final record repeats it beside the post-operation measurement.
  publishIndependentTweakersLiveHealth({
    ...provisional,
    appearance: { status: appearanceStatus(before, null), normalized: false, windowId: primary.id, before, after: null },
    observedAt: new Date().toISOString(),
  });
  if (independentTweakersZoomNormalized && nativeZoomNeedsNormalization(before)) {
    independentTweakersZoomNormalized = false;
  }
  if (!independentTweakersZoomNormalized && nativeZoomNeedsNormalization(before)) {
    try {
      primary.webContents.setZoomLevel(0);
      primary.webContents.setZoomFactor(1);
    } catch (error) {
      log("warn", "independent primary-window zoom normalization failed", { message: String((error as Error)?.message ?? error) });
    }
  }
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  const after = primary.isDestroyed() || primary.webContents.isDestroyed()
    ? null
    : await readIndependentTweakersAppearanceMetrics(primary);
  const normalized = nativeZoomObservedAtActualSize(after);
  independentTweakersZoomNormalized = normalized;
  publishIndependentTweakersLiveHealth({
    ...provisional,
    appearance: { status: appearanceStatus(before, after), normalized, windowId: primary.id, before, after },
    observedAt: new Date().toISOString(),
  });
}

function requestRuntimeReadyBrokerConnection(window: Electron.BrowserWindow | null = exactIndependentTweakersPrimaryWindow()): void {
  if (!derivedVariant || independentTweakersBrokerProbeInFlight) return;
  const authority = currentRuntimeReadyBrokerAuthorityExpectation();
  if (!authority) return;
  if (authority.globalRootState === "absent") {
    markRuntimeReadyBrokerState("blocked");
    return;
  }
  if (!window || !accountsBrokerRoot || !accountsBrokerSecret) return;
  const client = accountsBrokerClientForRenderer(window.webContents.id);
  if (!client) {
    markRuntimeReadyBrokerState("blocked");
    return;
  }
  independentTweakersBrokerProbeInFlight = true;
  void client.socket.invoke({
    version: 1,
    requestId: `runtime-ready-${randomUUID()}`,
    command: "profile.read",
  }).then((response) => {
    markRuntimeReadyBrokerState(response.ok ? "connected" : "blocked");
  }).catch(() => {
    markRuntimeReadyBrokerState("blocked");
  }).finally(() => {
    independentTweakersBrokerProbeInFlight = false;
    scheduleIndependentTweakersLiveHealthCapture();
  });
}

function tryWriteRuntimeReadyReceipt(): void {
  if (!derivedVariant || runtimeReadyPublished) return;
  const expectation = readRuntimeReadyExpectation();
  if (!expectation) return;
  const brokerAuthority = currentRuntimeReadyBrokerAuthorityExpectation();
  if (!brokerAuthority || !sameRuntimeReadyBrokerAuthorityExpectation(
    brokerAuthority,
    expectation.brokerAuthorityExpectation,
  )) return;
  if (!runtimeReadySettingsMounted) {
    requestRuntimeReadySettingsMount();
  }
  const initializedTweakIds = runtimeReadyInitializedTweakIds();
  if (!initializedTweakIds) return;
  if (!runtimeReadySettingsMounted) return;
  const expectedBrokerState = expectedRuntimeReadyBrokerState(brokerAuthority);
  if (runtimeReadyBrokerState === null || runtimeReadyBrokerState !== expectedBrokerState) {
    requestRuntimeReadyBrokerConnection();
    return;
  }
  if (!independentTweakersLiveHealth
    || independentTweakersLiveHealth.pid !== process.pid
    || independentTweakersLiveHealth.processStartToken !== currentProcessStartToken()
    || independentTweakersLiveHealth.accountsBrokerConfigSha256 !== brokerAuthority.configSha256
    || independentTweakersLiveHealth.sharedHistoryBrokerState !== expectedBrokerState) {
    scheduleIndependentTweakersLiveHealthCapture();
    return;
  }
  // A missing authoritative primary window remains useful diagnostics for the
  // Settings row, but must not create a hot retry loop or a readiness receipt.
  const primary = exactIndependentTweakersPrimaryWindow();
  const appearance = runtimeReadyAppearanceBinding(independentTweakersLiveHealth.appearance);
  if (!primary
    || independentTweakersLiveHealth.appearance.windowId !== primary.id
    || !independentTweakersLiveHealth.appearance.before
    || !independentTweakersLiveHealth.appearance.after
    || !appearance
    || !sameRuntimeReadyAppearanceBinding(appearance, expectation.appearanceExpectation)) return;
  if (!primaryIndependentTweakersNativeZoomAtActualSize(primary)) {
    // The persisted observation was normal, but the native surface changed
    // before this synchronous receipt write. Re-capture once so normalizing
    // logic can repair it; if that capture remains unhealthy, its current
    // diagnostics stay visible without a hot retry loop.
    const shouldRecapture = independentTweakersZoomNormalized;
    independentTweakersZoomNormalized = false;
    if (shouldRecapture) scheduleIndependentTweakersLiveHealthCapture();
    return;
  }
  try {
    const appRoot = inferMacAppRoot();
    const appAsarHeaderHash = promotionAppHeaderHash();
    const runtimeFingerprint = readRuntimeFingerprintEvidence(runtimeDir!)?.fingerprint;
    const appUserDataRoot = process.env.CODEX_ELECTRON_USER_DATA_PATH;
    const bundleId = appRoot ? readBundleIdentifier(appRoot) : null;
    const processStartToken = currentProcessStartToken();
    if (!appRoot || !runtimeFingerprint || !appUserDataRoot
      || !processStartToken
      || bundleId !== expectation.bundleId
      || appRoot !== expectation.appRoot
      || appAsarHeaderHash.toLowerCase() !== expectation.appAsarHeaderHash.toLowerCase()
      || runtimeFingerprint.toLowerCase() !== expectation.runtimeFingerprint.toLowerCase()
      || appUserDataRoot !== expectation.appUserDataRoot
      || MCP_RUNTIME_PATHS.codexHome !== expectation.codexHomeRoot
      || accountsBrokerRoot !== expectation.accountsBrokerRoot) {
      log("warn", "runtime-ready expectation does not match this process");
      return;
    }
    const receipt = {
      schemaVersion: 5,
      kind: "tweakers-independent-runtime-ready",
      operationId: expectation.operationId,
      promotionId: expectation.promotionId,
      activePromotionReceiptSha256: expectation.activePromotionReceiptSha256,
      pid: process.pid,
      processStartToken,
      appRoot,
      bundleId,
      appAsarHeaderHash,
      runtimeFingerprint,
      appUserDataRoot,
      codexHomeRoot: MCP_RUNTIME_PATHS.codexHome,
      accountsBrokerRoot,
      brokerAuthorityExpectation: brokerAuthority,
      appearance,
      mainInitialized: true,
      preloadInitialized: true,
      settingsMounted: true,
      sharedHistoryBrokerState: runtimeReadyBrokerState,
      initializedTweakIds,
      observedAt: new Date().toISOString(),
    } as const;
    publishIndependentTweakersRuntimeReadyReceipt(RUNTIME_READY_FILE, receipt);
    stopRuntimeReadySettingsMountAttempts();
    runtimeReadyPublished = true;
    log("info", "runtime-ready receipt published", { operationId: expectation.operationId, tweakCount: initializedTweakIds.length });
  } catch (error) {
    log("warn", "runtime-ready receipt was not published", { message: String((error as Error)?.message ?? error) });
  }
}

function currentProcessStartToken(): string | null {
  if (process.platform !== "darwin") {
    return `pid-${process.pid}-uptime-${Math.floor(process.uptime() * 1_000)}`;
  }
  try {
    const result = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 8 * 1024,
    });
    const token = result.status === 0 ? String(result.stdout ?? "").trim() : "";
    return token.length > 0 && token.length <= 128 && !/[\u0000-\u001f\u007f]/.test(token)
      ? token
      : null;
  } catch {
    return null;
  }
}

type RuntimeReadySettingsMountRetryStopReason =
  | "mounted"
  | "published"
  | "expectation-removed"
  | "deadline"
  | "exhausted"
  | "cancelled";

interface RuntimeReadySettingsMountRetryControllerOptions<Owner> {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => unknown;
  cancel: (timer: unknown) => void;
  intervalMs: number;
  acknowledgementGraceMs: number;
  deadlineMs: number;
  maxAttempts: number;
  initialOperationId: string;
  initialAttemptCount: number;
  readExpectation: () => { operationId: string } | null;
  isMounted: () => boolean;
  isPublished: () => boolean;
  isReady: () => boolean;
  getExactPrimary: () => Owner | null;
  open: (owner: Owner) => boolean;
  onAttemptStateChange: (operationId: string, attemptCount: number) => void;
  onRequest: (attemptCount: number, accepted: boolean) => void;
  onStopped: (reason: RuntimeReadySettingsMountRetryStopReason, operationId: string) => void;
}

interface RuntimeReadySettingsMountRetryController {
  start(): void;
  stop(): void;
}

/**
 * One operation-bound Settings opener. The deadline starts when this
 * controller starts, even if lifecycle readiness or the exact primary window
 * is delayed. A successful menu callback gets a longer acknowledgement grace
 * so a normal renderer mount does not receive duplicate menu invocations.
 */
function createRuntimeReadySettingsMountRetryController<Owner>(
  options: RuntimeReadySettingsMountRetryControllerOptions<Owner>,
): RuntimeReadySettingsMountRetryController {
  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let deadlineAt = 0;
  let operationId = options.initialOperationId;
  let attemptCount = options.initialAttemptCount;

  const stop = (reason: RuntimeReadySettingsMountRetryStopReason): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) options.cancel(timer);
    timer = null;
    options.onStopped(reason, operationId);
  };

  const schedule = (callback: () => void, delayMs: number): void => {
    const remaining = deadlineAt - options.now();
    if (remaining <= 0) {
      stop("deadline");
      return;
    }
    timer = options.schedule(() => {
      timer = null;
      callback();
    }, Math.min(delayMs, remaining));
  };

  const attempt = (): void => {
    if (stopped) return;
    const now = options.now();
    if (now >= deadlineAt) {
      stop("deadline");
      return;
    }
    if (options.isMounted()) {
      stop("mounted");
      return;
    }
    if (options.isPublished()) {
      stop("published");
      return;
    }
    const expectation = options.readExpectation();
    if (!expectation) {
      stop("expectation-removed");
      return;
    }
    if (operationId !== expectation.operationId) {
      operationId = expectation.operationId;
      attemptCount = 0;
      options.onAttemptStateChange(operationId, attemptCount);
    }
    if (attemptCount >= options.maxAttempts) {
      stop("exhausted");
      return;
    }
    // Do not request Settings before the current lifecycle attempt is ready;
    // this check deliberately does not consume an attempt or reset the clock.
    if (!options.isReady()) {
      schedule(attempt, options.intervalMs);
      return;
    }
    if (options.now() >= deadlineAt) {
      stop("deadline");
      return;
    }
    attemptCount += 1;
    const owner = options.getExactPrimary();
    const accepted = owner !== null && options.open(owner);
    options.onAttemptStateChange(operationId, attemptCount);
    options.onRequest(attemptCount, accepted);
    if (attemptCount >= options.maxAttempts) {
      stop("exhausted");
      return;
    }
    schedule(attempt, accepted ? options.acknowledgementGraceMs : options.intervalMs);
  };

  return {
    start: () => {
      if (started) return;
      started = true;
      deadlineAt = options.now() + options.deadlineMs;
      attempt();
    },
    stop: () => stop("cancelled"),
  };
}

let runtimeReadySettingsOpenController: RuntimeReadySettingsMountRetryController | null = null;

function stopRuntimeReadySettingsMountAttempts(): void {
  const controller = runtimeReadySettingsOpenController;
  runtimeReadySettingsOpenController = null;
  if (controller) controller.stop();
  if (runtimeReadySettingsOpenTimer !== null) clearTimeout(runtimeReadySettingsOpenTimer as ReturnType<typeof setTimeout>);
  runtimeReadySettingsOpenTimer = null;
}

function requestRuntimeReadySettingsMount(): void {
  if (runtimeReadySettingsMounted || runtimeReadySettingsOpenController !== null) return;
  const expectation = readRuntimeReadyExpectation();
  if (!expectation) return;
  if (runtimeReadySettingsOpenAttemptOperationId !== expectation.operationId) {
    runtimeReadySettingsOpenAttemptOperationId = expectation.operationId;
    runtimeReadySettingsOpenAttemptCount = 0;
    runtimeReadySettingsOpenTerminalOperationId = null;
  }
  if (runtimeReadySettingsOpenTerminalOperationId === expectation.operationId
    || runtimeReadySettingsOpenAttemptCount >= RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS) return;

  let controller: RuntimeReadySettingsMountRetryController;
  controller = createRuntimeReadySettingsMountRetryController({
    now: () => Date.now(),
    schedule: (callback, delayMs) => {
      const scheduled = setTimeout(() => {
        if (runtimeReadySettingsOpenTimer === scheduled) runtimeReadySettingsOpenTimer = null;
        callback();
      }, delayMs);
      runtimeReadySettingsOpenTimer = scheduled;
      return scheduled;
    },
    cancel: (scheduled) => clearTimeout(scheduled as ReturnType<typeof setTimeout>),
    intervalMs: RUNTIME_READY_SETTINGS_OPEN_INTERVAL_MS,
    acknowledgementGraceMs: RUNTIME_READY_SETTINGS_OPEN_ACK_GRACE_MS,
    deadlineMs: RUNTIME_READY_SETTINGS_OPEN_DEADLINE_MS,
    maxAttempts: RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS,
    initialOperationId: expectation.operationId,
    initialAttemptCount: runtimeReadySettingsOpenAttemptCount,
    readExpectation: () => {
      const current = readRuntimeReadyExpectation();
      return current ? { operationId: current.operationId } : null;
    },
    isMounted: () => runtimeReadySettingsMounted,
    isPublished: () => runtimeReadyPublished,
    isReady: () => runtimeReadyInitializedTweakIds() !== null,
    getExactPrimary: () => exactIndependentTweakersPrimaryWindow(),
    open: (owner) => openNativeSettingsFromApplicationMenu(owner),
    onAttemptStateChange: (operationId, attemptCount) => {
      if (runtimeReadySettingsOpenAttemptOperationId !== operationId) {
        runtimeReadySettingsOpenTerminalOperationId = null;
      }
      runtimeReadySettingsOpenAttemptOperationId = operationId;
      runtimeReadySettingsOpenAttemptCount = attemptCount;
    },
    onRequest: (attemptCount, accepted) => {
      if (accepted) log("info", "runtime-ready Settings mount requested", { attempt: attemptCount });
    },
    onStopped: (reason, operationId) => {
      if (runtimeReadySettingsOpenController === controller) runtimeReadySettingsOpenController = null;
      if (reason === "deadline" || reason === "exhausted") {
        runtimeReadySettingsOpenTerminalOperationId = operationId;
      }
      if (reason === "deadline") log("warn", "runtime-ready Settings mount deadline reached");
      else if (reason === "exhausted") log("warn", "runtime-ready Settings mount attempts exhausted");
    },
  });
  runtimeReadySettingsOpenController = controller;
  controller.start();
}

function readManagedRuntimeSourceHash(root: string): string | null {
  try {
    const provenance = JSON.parse(readFileSync(
      join(root, "managed-runtime", "current", ".tweakers-provenance.json"),
      "utf8",
    )) as { sourceRuntimeHash?: unknown };
    return typeof provenance.sourceRuntimeHash === "string"
      && /^[a-f0-9]{64}$/i.test(provenance.sourceRuntimeHash)
      ? provenance.sourceRuntimeHash
      : null;
  } catch {
    return null;
  }
}

// Surface unhandled errors from anywhere in the main process to our log.
process.on("uncaughtException", (e: Error & { code?: string }) => {
  log("error", "uncaughtException", { code: e.code, message: e.message, stack: e.stack });
});
process.on("unhandledRejection", (e) => {
  log("error", "unhandledRejection", { value: String(e) });
});

function configureCodexSparkleForProcess(): void {
  // The installed ChatGPT app owns Sparkle outright. Only disposable health
  // probes and the locally signed independent app receive the inert wrapper:
  // it prevents an inherited native updater from touching a probe or derived
  // bundle, while leaving every official launch unwrapped and native-owned.
  if (healthCheckOnly || derivedVariant) {
    configureCodexSparkleBridge(createHealthProbeCodexSparkleBridgeOptions());
  }
}

configureCodexSparkleForProcess();
if (healthCheckOnly || derivedVariant) installSparkleUpdateHook();

interface LoadedMainTweak {
  stop?: () => void;
  storage: DiskStorage;
}

interface CodexWindowServices {
  createFreshWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  createFreshLocalWindow?: (route?: string) => Promise<Electron.BrowserWindow | null>;
  ensureHostWindow?: (hostId?: string) => Promise<Electron.BrowserWindow | null>;
  getPrimaryWindow?: (hostId?: string) => Electron.BrowserWindow | null;
  getContext?: (hostId: string) => { registerWindow?: (windowLike: CodexWindowLike) => void } | null;
  windowManager?: {
    createWindow?: (opts: Record<string, unknown>) => Promise<Electron.BrowserWindow | null>;
    getPrimaryWindow?: () => Electron.BrowserWindow | null;
    registerWindow?: (
      windowLike: CodexWindowLike,
      hostId: string,
      primary: boolean,
      appearance: string,
    ) => void;
    options?: {
      allowDevtools?: boolean;
      preloadPath?: string;
    };
  };
}

interface CodexWindowLike {
  id: number;
  webContents: Electron.WebContents;
  on(event: "closed", listener: () => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  isDestroyed?(): boolean;
  isFocused?(): boolean;
  focus?(): void;
  show?(): void;
  hide?(): void;
  getBounds?(): Electron.Rectangle;
  getContentBounds?(): Electron.Rectangle;
  getSize?(): [number, number];
  getContentSize?(): [number, number];
  setTitle?(title: string): void;
  getTitle?(): string;
  setRepresentedFilename?(filename: string): void;
  setDocumentEdited?(edited: boolean): void;
  setWindowButtonVisibility?(visible: boolean): void;
}

interface CodexCreateWindowOptions {
  route: string;
  hostId?: string;
  show?: boolean;
  appearance?: string;
  parentWindowId?: number;
  bounds?: Electron.Rectangle;
}

interface CodexCreateViewOptions {
  route: string;
  hostId?: string;
  appearance?: string;
}

type OwlViewAttachMode = "contentView" | "browserView";

interface ManagedOwlView {
  key: string;
  tweakId: string;
  id: string;
  view: Electron.BrowserView;
  parentWindowId: number | null;
  attachMode: OwlViewAttachMode | null;
  disposeBindings: Array<() => void>;
  disposed: boolean;
}

const tweakState = {
  discovered: [] as DiscoveredTweak[],
  loadedMain: new Map<string, LoadedMainTweak>(),
};
const mainIpcHandlerRegistrations = new Map<string, symbol>();

// Candidate health probes and the derived Tweakers app must remain
// observational. In particular, neither may watch or reconcile the real
// ~/.codex/config.toml while validating a staged runtime or hosting the
// isolated app.
const mcpReconciler = healthCheckOnly || derivedVariant ? null : createMcpReconciler({
  configPath: CODEX_CONFIG_FILE,
  statePath: MCP_SYNC_STATE_FILE,
  getTweaks: () => mcpSyncTweaks(true),
  getOwnedTweaks: () => mcpSyncTweaks(false),
  onReceipt: (receipt) => {
    const summary = receipt.conflicts.length > 0
      ? receipt.conflicts.map((conflict) => (
        `${conflict.observedName} -> ${conflict.canonicalName} (${conflict.reason})`
      )).join(", ")
      : receipt.appliedNames.join(", ") || "none";
    log("info", `MCP reconciliation ${receipt.status}: ${summary}`);
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send("tweaker:mcp-sync-state-changed", receipt);
    }
  },
  onError: (error) => log("warn", "failed to reconcile Codex MCP config:", error),
});
let initialMcpReconciliationPending = true;
let nextReloadMcpTrigger: McpSyncTrigger = "tweak-reload";

function mcpSyncTweaks(enabledOnly: boolean) {
  return tweakState.discovered
    .filter((tweak) => !enabledOnly || isTweakEnabled(tweak.manifest.id))
    .map((tweak) => ({
      dir: tweak.dir,
      dataDir: join(userRoot!, "tweak-data", tweak.manifest.id),
      manifest: tweak.manifest,
    }));
}

const nativeBridge = new NativeBridge(log, {
  nativeHostPath: resolveRuntimeNativeHostPath({
    resourcesPath: process.resourcesPath,
    runtimeDir,
    packaged: app.isPackaged,
    allowExternalDevelopmentFallback: app.isPackaged === false
      && (process.defaultApp === true || healthCheckOnly),
  }),
});
const owlViews = new Map<string, ManagedOwlView>();

const tweakLifecycleDeps = {
  logInfo: (message: string) => {
    // reloadTweaks emits this inside its serialized operation immediately
    // before discovery/load, so overlapping reloads cannot steal the trigger.
    if (message.startsWith("reloading tweaks (")) {
      nextReloadMcpTrigger = message === "reloading tweaks (enabled-toggle)"
        ? "enabled-state"
        : "tweak-reload";
    }
    log("info", message);
  },
  setTweakEnabled,
  stopAllMainTweaks,
  clearTweakModuleCache,
  loadAllMainTweaks,
  broadcastReload,
};

// 1. Hook every session so our preload runs in every renderer.
//
// We use Electron's modern `session.registerPreloadScript` API (added in
// Electron 35). The deprecated `setPreloads` path silently no-ops in some
// configurations (notably with sandboxed renderers), so registerPreloadScript
// is the only reliable way to inject into Codex's BrowserWindows.
function registerPreload(s: Electron.Session, label: string): void {
  if (healthCheckOnly) return;
  try {
    const reg = (s as unknown as {
      registerPreloadScript?: (opts: {
        type?: "frame" | "service-worker";
        id?: string;
        filePath: string;
      }) => string;
    }).registerPreloadScript;
    if (typeof reg === "function") {
      reg.call(s, { type: "frame", filePath: PRELOAD_PATH, id: "tweaker" });
      runtimeReadyPreloadInitialized = true;
      log("info", `preload registered (registerPreloadScript) on ${label}:`, PRELOAD_PATH);
      tryWriteRuntimeReadyReceipt();
      return;
    }
    // Fallback for older Electron versions.
    const existing = s.getPreloads();
    if (!existing.includes(PRELOAD_PATH)) {
      s.setPreloads([...existing, PRELOAD_PATH]);
    }
    runtimeReadyPreloadInitialized = true;
    log("info", `preload registered (setPreloads) on ${label}:`, PRELOAD_PATH);
    tryWriteRuntimeReadyReceipt();
  } catch (e) {
    if (e instanceof Error && e.message.includes("existing ID")) {
      runtimeReadyPreloadInitialized = true;
      log("info", `preload already registered on ${label}:`, PRELOAD_PATH);
      tryWriteRuntimeReadyReceipt();
      return;
    }
    log("error", `preload registration on ${label} failed:`, e);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

type PromotionProbeValue = "pass" | "fail" | "unknown";
const USER_QUESTIONS_TWEAK_ID = "co.tweakers.user-questions";
const USER_QUESTIONS_FOLDER = "user-questions";
const SANITIZED_PROMOTION_POLICY_FAILURES = new WeakSet<object>();

function assertPromotionProbeIsolation(): void {
  if (!healthCheckOnly) throw new Error("promotion probes require a one-shot health process");
  const candidateRequested = process.env.TWEAKERS_CANDIDATE_MCP_RECONCILIATION !== undefined;
  if (candidateRequested && !MCP_RUNTIME_PATHS.candidateIsolated) {
    throw new Error("candidate promotion probe did not resolve contained MCP paths");
  }
}

function promotionSurfaceHash(surface: PromotionSurfaceName): string {
  assertPromotionProbeIsolation();
  switch (surface) {
    case "app": return promotionAppHeaderHash();
    case "runtime": return fingerprintPromotionPath(runtimeDir!);
    case "tweakTree": return fingerprintPromotionPath(TWEAKS_DIR);
    case "tweakersConfig": return fingerprintPromotionPath(CONFIG_FILE);
    case "codexConfig": return fingerprintPromotionCodexConfigPath(CODEX_CONFIG_FILE);
    case "namespaceData": return fingerprintPromotionPath(join(userRoot!, "tweak-data", USER_QUESTIONS_TWEAK_ID));
    case "mainStorage": return fingerprintPromotionPath(join(userRoot!, "storage", `${USER_QUESTIONS_TWEAK_ID}.json`));
    case "policy": return promotionPolicySurfaceHash();
  }
}

function promotionPolicySurfaceHash(): string {
  try {
    return fingerprintPromotionPolicyPath(join(MCP_RUNTIME_PATHS.codexHome, ".codex-global-state.json"));
  } catch (error) {
    if (error !== null && (typeof error === "object" || typeof error === "function")) {
      SANITIZED_PROMOTION_POLICY_FAILURES.add(error);
    }
    log("error", "promotion policy fingerprint failed", {
      surface: "policy",
      reason: promotionPolicyFingerprintFailureReason(error),
    });
    throw error;
  }
}

/** Parse only the bounded ASAR pickle header and hash the decoded JSON string. */
function promotionAppHeaderHash(): string {
  const archivePath = join(process.resourcesPath, "app.asar");
  // Electron's ordinary fs facade treats app.asar as a virtual directory.
  // Promotion proof needs the sealed archive bytes, so use the raw fs module.
  return hashRawAsarHeader(archivePath, originalFs);
}

/** Mode- and link-aware deterministic hash paired with install.ts. */
function fingerprintPromotionPath(path: string): string {
  if (!existsSync(path)) return "missing";
  const digest = createHash("sha256");
  const visit = (entryPath: string, name: string): void => {
    const stat = lstatSync(entryPath);
    digest.update(name).update("\0").update(String(stat.mode & 0o777)).update("\0");
    if (stat.isDirectory()) {
      digest.update("directory\0");
      for (const child of readdirSync(entryPath).sort()) {
        visit(join(entryPath, child), name ? `${name}/${child}` : child);
      }
      return;
    }
    if (stat.isFile()) {
      digest.update("file\0").update(readFileSync(entryPath));
      return;
    }
    if (stat.isSymbolicLink()) {
      digest.update("symlink\0").update(readlinkSync(entryPath));
      return;
    }
    throw new Error(`unsupported promotion surface entry: ${entryPath}`);
  };
  visit(path, "");
  return digest.digest("hex");
}

/** Exact payload hash paired with user-questions-source.ts (symlinks fail). */
function fingerprintUserQuestionsPath(path: string): string {
  const rootStat = lstatSync(path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("User Questions source must be a real directory");
  }
  const digest = createHash("sha256");
  digest.update("directory\0").update(String(rootStat.mode & 0o777)).update("\0");
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(directory, entry.name);
      const entryStat = lstatSync(entryPath);
      if (entryStat.isSymbolicLink()) throw new Error(`User Questions source contains a symbolic link: ${entryPath}`);
      const name = relative(path, entryPath);
      digest.update(name).update("\0").update(String(entryStat.mode & 0o777)).update("\0");
      if (entryStat.isDirectory()) {
        digest.update("directory\0");
        visit(entryPath);
      } else if (entryStat.isFile()) {
        digest.update("file\0").update(readFileSync(entryPath));
      } else {
        throw new Error(`unsupported User Questions source entry: ${entryPath}`);
      }
    }
  };
  visit(path);
  return digest.digest("hex");
}

function requirePromotionModule(root: string, entrypoint: string): unknown {
  if (basename(entrypoint) !== entrypoint || !entrypoint.endsWith(".js")) {
    throw new Error("User Questions entrypoints must be direct JavaScript children");
  }
  const path = join(root, entrypoint);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) {
    throw new Error(`User Questions entrypoint is unsafe: ${entrypoint}`);
  }
  return require(path) as unknown;
}

function promotionSelfTest(run: () => boolean): PromotionProbeValue {
  try {
    return run() ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

function promotionUserQuestionsHealth(rendererStorageSelfTest: HealthValue): UserQuestionsHealthObservation {
  assertPromotionProbeIsolation();
  const root = join(TWEAKS_DIR, USER_QUESTIONS_FOLDER);
  const manifestPath = join(root, "manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) {
    throw new Error("User Questions manifest is unsafe");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.id !== USER_QUESTIONS_TWEAK_ID) throw new Error("User Questions canonical identity is missing");
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error("User Questions version is invalid");
  }
  if (manifest.scope !== "main" && manifest.scope !== "both") throw new Error("User Questions main lifecycle is missing");
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  if (!permissions.includes("ipc") || !permissions.includes("network")) {
    throw new Error("User Questions broker permissions are missing");
  }
  const mainEntrypoint = typeof manifest.main === "string" ? manifest.main : "index.js";
  if (Object.hasOwn(manifest, "mcp")) throw new Error("User Questions enhancement must not own an MCP entrypoint");

  // These predicates are shared verbatim with the repository test that pins
  // the canonical tweak sources, so an enhancement-protocol migration can
  // never half-land again (candidate refusal 2026-08-25).
  const mainLifecycle = promotionSelfTest(() => userQuestionsMainLifecycleSelfTest(
    requirePromotionModule(root, mainEntrypoint) as UserQuestionsLifecycleModule,
  ));
  const brokerSelfTest = promotionSelfTest(() => userQuestionsBrokerSelfTest(
    requirePromotionModule(root, "main-broker.js") as UserQuestionsBrokerModule,
  ));
  const schemaSelfTest = promotionSelfTest(() => userQuestionsSchemaSelfTest(
    requirePromotionModule(root, "core.js") as UserQuestionsSchemaModule,
  ));
  return {
    id: USER_QUESTIONS_TWEAK_ID,
    version: manifest.version,
    payloadHash: fingerprintUserQuestionsPath(root),
    mainLifecycle,
    brokerSelfTest,
    schemaSelfTest,
    rendererStorageSelfTest,
    enhancementHandshake: brokerSelfTest,
    genericFallback: Object.hasOwn(manifest, "mcp") ? "fail" : "pass",
  };
}

async function runPromotionRendererProof(): Promise<PromotionRendererProofResult> {
  assertPromotionProbeIsolation();
  const nonce = randomUUID();
  const url = promotionRendererDocumentUrl(nonce);
  const tracker = createPromotionRendererProofTracker({ nonce, url, preloadPath: PRELOAD_PATH });
  const healthProtocol = session.defaultSession.protocol;
  let protocolHandlerInstalled = false;
  let proofWindow: Electron.BrowserWindow | null = null;
  let authorizationConsumed = false;
  let handshakeConsumed = false;
  let settleHandshake: (() => void) | null = null;
  let handshakeSettled = false;
  const handshake = new Promise<void>((resolvePromise) => {
    settleHandshake = () => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      resolvePromise();
    };
  });
  const onHandshake = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const windowAlive = proofWindow !== null && !proofWindow.isDestroyed() && !proofWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === proofWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === proofWindow!.webContents.mainFrame;
    const decision = validatePromotionRendererHandshake({
      windowAlive,
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      expectedUrl: url,
      authorizationConsumed,
      handshakeConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      log("warn", "promotion renderer lifecycle handshake rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    handshakeConsumed = true;
    tracker.rendererHandshake({
      webContentsId: event.sender.id,
      ...decision.observation,
    });
    log("info", "promotion renderer lifecycle handshake accepted", {
      webContentsId: event.sender.id,
      lifecycle: decision.observation.lifecycle,
      rendererStorageSelfTest: decision.observation.rendererStorageSelfTest,
    });
    settleHandshake?.();
  };
  const onAuthorization = (event: Electron.IpcMainEvent, payload: unknown): void => {
    let decision: ReturnType<typeof authorizePromotionRenderer>;
    let serializedResponse: string | null = null;
    try {
      const windowAlive = proofWindow !== null && !proofWindow.isDestroyed() && !proofWindow.webContents.isDestroyed();
      const senderMatches = windowAlive && event.sender.id === proofWindow!.webContents.id;
      const frameMatches = senderMatches
        && event.senderFrame !== null
        && event.senderFrame === proofWindow!.webContents.mainFrame;
      decision = authorizePromotionRenderer({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: url,
        consumed: authorizationConsumed,
      }, payload, nonce);
      if (decision.accepted) serializedResponse = JSON.stringify(decision.response);
    } catch {
      event.returnValue = null;
      log("warn", "promotion renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: "authorization exception",
      });
      return;
    }
    if (!decision.accepted) {
      event.returnValue = null;
      log("warn", "promotion renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    authorizationConsumed = true;
    event.returnValue = serializedResponse!;
    log("info", "promotion renderer authorization accepted", {
      webContentsId: event.sender.id,
    });
  };
  ipcMain.on(PROMOTION_RENDERER_AUTH_CHANNEL, onAuthorization);
  ipcMain.on(PROMOTION_RENDERER_IPC_CHANNEL, onHandshake);
  try {
    if (healthProtocol.isProtocolHandled(PROMOTION_RENDERER_SCHEME)) {
      throw new Error("health-only app protocol already has a handler");
    }
    healthProtocol.handle(
      PROMOTION_RENDERER_SCHEME,
      createPromotionRendererProtocolResponder(join(process.resourcesPath, "app.asar", "webview")),
    );
    protocolHandlerInstalled = true;
    log("info", "promotion renderer protocol handler installed", {
      scheme: PROMOTION_RENDERER_SCHEME,
      sessionIsDefault: true,
    });
    proofWindow = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    const proofWebContents = proofWindow.webContents;
    const preferences = (proofWebContents as unknown as {
      getLastWebPreferences?: () => { preload?: string };
    }).getLastWebPreferences?.();
    tracker.windowCreated({
      webContentsId: proofWebContents.id,
      url,
      preloadPath: preferences?.preload ?? null,
    });
    log("info", "promotion renderer load started", {
      webContentsId: proofWebContents.id,
      url,
      preloadRegistered: preferences?.preload === PRELOAD_PATH,
    });
    proofWebContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      tracker.didFailLoad({
        webContentsId: proofWebContents.id,
        errorCode,
        errorDescription,
        url: validatedURL,
      });
      log("warn", "promotion renderer did-fail-load", {
        webContentsId: proofWebContents.id,
        errorCode,
        errorDescription,
        url: validatedURL,
      });
      settleHandshake?.();
    });
    proofWebContents.on("render-process-gone", (_event, details) => {
      tracker.renderProcessGone({
        webContentsId: proofWebContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      log("warn", "promotion renderer process exited", {
        webContentsId: proofWebContents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      settleHandshake?.();
    });
    const load = proofWindow.loadURL(url).then(() => {
      tracker.didFinishLoad({ webContentsId: proofWebContents.id, url: proofWebContents.getURL() });
      log("info", "promotion renderer load completed", {
        webContentsId: proofWebContents.id,
        url: proofWebContents.getURL(),
      });
    }).catch((error) => {
      const rejection = promotionRendererLoadRejection(error, url);
      tracker.didFailLoad({
        webContentsId: proofWebContents.id,
        ...rejection,
      });
      log("warn", "promotion renderer loadURL rejected", {
        webContentsId: proofWebContents.id,
        ...rejection,
      });
      settleHandshake?.();
    });
    await withTimeout(Promise.all([load, handshake]).then(() => undefined), 5_000).catch(() => undefined);
    const result = tracker.result();
    if (result.hostReady === "pass" && result.rendererStorageSelfTest === "pass") {
      log("info", "promotion renderer mount/handshake succeeded", {
        webContentsId: proofWebContents.id,
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
      });
    } else {
      log("warn", "promotion renderer mount/handshake incomplete", {
        webContentsId: proofWebContents.id,
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
      });
    }
    return result;
  } catch (error) {
    log("warn", "promotion renderer proof could not create its hidden window", {
      error: error instanceof Error ? error.message : String(error),
    });
    return tracker.result();
  } finally {
    ipcMain.removeListener(PROMOTION_RENDERER_AUTH_CHANNEL, onAuthorization);
    ipcMain.removeListener(PROMOTION_RENDERER_IPC_CHANNEL, onHandshake);
    if (proofWindow && !proofWindow.isDestroyed()) proofWindow.destroy();
    if (protocolHandlerInstalled) {
      try {
        healthProtocol.unhandle(PROMOTION_RENDERER_SCHEME);
        log("info", "promotion renderer protocol handler removed", { scheme: PROMOTION_RENDERER_SCHEME });
      } catch (error) {
        log("warn", "promotion renderer protocol handler cleanup failed", {
          scheme: PROMOTION_RENDERER_SCHEME,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

interface PromotionOriginalMainProbe {
  registerSession(targetSession: Electron.Session, label: string): void;
  run(): Promise<PromotionRendererProofResult>;
}

function createPromotionOriginalMainProbe(): PromotionOriginalMainProbe {
  const nonce = randomUUID();
  const tracker = createPromotionOriginalRendererProofTracker(nonce);
  const capturedWindows = new Set<Electron.BrowserWindow>();
  const registeredSessions = new Set<Electron.Session>();
  const preloadErrorWebContentsIds = new Set<number>();
  const windowCleanup = new Map<Electron.BrowserWindow, Array<() => void>>();
  let canonicalWindow: Electron.BrowserWindow | null = null;
  let canonicalBackgroundThrottlingPrevious: boolean | null = null;
  let authorizationConsumed = false;
  let loadObservedConsumed = false;
  let handshakeConsumed = false;
  let cleaningUp = false;
  let cleanupFinished = false;
  let lateWindowDuringCleanup = false;
  let settled = false;
  let deadlineController: ReturnType<typeof createPromotionOriginalRendererDeadlineController> | null = null;
  let settleProof: (() => void) | null = null;
  const proofSettled = new Promise<void>((resolvePromise) => {
    settleProof = resolvePromise;
  });
  const originalOpacitySetters = new WeakMap<
    Electron.BrowserWindow,
    (opacity: number) => void
  >();

  const settleIfComplete = (): void => {
    if (settled || !tracker.complete()) return;
    settled = true;
    deadlineController?.settle();
    settleProof?.();
  };
  const fail = (reason: string, webContentsId?: number): void => {
    tracker.fail(reason, webContentsId);
    log("warn", "promotion original renderer proof failed", {
      reason,
      webContentsId: webContentsId ?? null,
    });
    settleIfComplete();
  };
  const requireBackgroundThrottlingDisabled = (
    contents: Electron.WebContents,
    phase: string,
    configure = false,
  ): boolean => {
    const configured = configure
      ? disablePromotionOriginalRendererBackgroundThrottling(contents)
      : null;
    if (configured) canonicalBackgroundThrottlingPrevious = configured.previous;
    const checked = configured ?? verifyPromotionOriginalRendererBackgroundThrottlingDisabled(contents);
    log(checked.ok ? "info" : "warn", "promotion original renderer background throttling checked", {
      webContentsId: contents.id,
      previous: canonicalBackgroundThrottlingPrevious,
      observed: checked.observed,
      phase,
    });
    if (!checked.ok) {
      fail(configure
        ? "canonical renderer background throttling could not be disabled"
        : "canonical renderer background throttling was not disabled", contents.id);
    }
    return checked.ok;
  };
  deadlineController = createPromotionOriginalRendererDeadlineController({
    onTimeout: (phase) => {
      fail(phase === "startup"
        ? "promotion original renderer startup timed out"
        : phase === "load"
          ? "promotion original renderer load timed out"
          : "promotion original renderer mount timed out");
    },
  });
  const forceWindowTransparent = (window: Electron.BrowserWindow): boolean => {
    if (window.isDestroyed()) return false;
    try {
      const setOpacity = originalOpacitySetters.get(window)
        ?? ((opacity: number) => window.setOpacity(opacity));
      setOpacity(0);
      return window.getOpacity() === 0;
    } catch {
      return false;
    }
  };
  const hideWindow = (window: Electron.BrowserWindow): void => {
    if (window.isDestroyed()) return;
    forceWindowTransparent(window);
    try { window.setFocusable(false); } catch { /* Best effort; visibility is checked below. */ }
    try { window.hide(); } catch { /* Best effort; visibility is checked below. */ }
    try { window.blur(); } catch { /* Best effort; visibility is checked below. */ }
  };
  const suppressWindowOpacity = (
    window: Electron.BrowserWindow,
    removers: Array<() => void>,
  ): void => {
    const mutableWindow = window as unknown as {
      setOpacity: (opacity: number) => void;
    };
    const original = mutableWindow.setOpacity;
    if (typeof original !== "function") {
      fail("captured window opacity interception unavailable");
      return;
    }
    const setOriginalOpacity = (opacity: number): void => {
      original.call(window, opacity);
    };
    originalOpacitySetters.set(window, setOriginalOpacity);
    const suppressed = (_opacity: number): void => {
      setOriginalOpacity(0);
      log("info", "promotion original BrowserWindow opacity suppressed", {
        webContentsId: window.webContents.id,
      });
    };
    try {
      setOriginalOpacity(0);
      mutableWindow.setOpacity = suppressed;
    } catch {
      originalOpacitySetters.delete(window);
      fail("captured window opacity interception failed");
      return;
    }
    if (mutableWindow.setOpacity !== suppressed || !forceWindowTransparent(window)) {
      fail("captured window opacity interception did not stick");
      return;
    }
    removers.push(() => {
      if (mutableWindow.setOpacity === suppressed) mutableWindow.setOpacity = original;
      originalOpacitySetters.delete(window);
    });
  };
  type SuppressedWindowActivationMethod = "show" | "showInactive" | "focus" | "restore";
  const suppressWindowActivationMethod = (
    window: Electron.BrowserWindow,
    method: SuppressedWindowActivationMethod,
    removers: Array<() => void>,
  ): void => {
    const mutableWindow = window as unknown as Record<
      SuppressedWindowActivationMethod,
      (...args: unknown[]) => void
    >;
    const original = mutableWindow[method];
    if (typeof original !== "function") {
      fail(`captured window ${method} interception unavailable`);
      return;
    }
    const suppressed = (..._args: unknown[]): void => {
      log("info", "promotion original BrowserWindow activation suppressed", {
        webContentsId: window.webContents.id,
        method,
      });
      hideWindow(window);
    };
    try {
      mutableWindow[method] = suppressed;
    } catch {
      fail(`captured window ${method} interception failed`);
      return;
    }
    if (mutableWindow[method] !== suppressed) {
      fail(`captured window ${method} interception did not stick`);
      return;
    }
    removers.push(() => {
      // Do not overwrite an original-main replacement installed after ours.
      if (mutableWindow[method] === suppressed) mutableWindow[method] = original;
    });
  };
  const originalPreloadIsValid = (preloadPath: unknown): preloadPath is string => {
    if (typeof preloadPath !== "string" || !isAbsolute(preloadPath)) return false;
    const exactPath = resolve(preloadPath);
    if (preloadPath !== exactPath || exactPath === resolve(PROMOTION_HEALTH_PRELOAD_PATH)) return false;
    const originalAsarRoot = resolve(process.resourcesPath, "app.asar");
    const containedPath = relative(originalAsarRoot, exactPath);
    if (!containedPath || containedPath.startsWith("..") || isAbsolute(containedPath)) return false;
    try {
      return existsSync(exactPath) && lstatSync(exactPath).isFile();
    } catch {
      return false;
    }
  };
  const considerEligible = (
    window: Electron.BrowserWindow,
    url: string,
    isMainFrame: boolean,
  ): void => {
    const canonicalUrl = canonicalPromotionOriginalRendererUrl(url);
    if (!isMainFrame || canonicalUrl === null || window.isDestroyed()) return;
    const contents = window.webContents;
    const preferences = (contents as unknown as {
      getLastWebPreferences?: () => {
        sandbox?: boolean;
        contextIsolation?: boolean;
        nodeIntegration?: boolean;
        preload?: string;
      };
    }).getLastWebPreferences?.() ?? {};
    const originalPreloadValid = originalPreloadIsValid(preferences.preload);
    tracker.eligibleWindow({
      webContentsId: contents.id,
      url: canonicalUrl,
      isDefaultSession: contents.session === session.defaultSession,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation === true,
      nodeIntegration: preferences.nodeIntegration === true,
      originalPreloadValid,
    });
    const selectedId = tracker.summary().canonicalWebContentsId;
    if (selectedId === contents.id && canonicalWindow === null) {
      canonicalWindow = window;
      if (requireBackgroundThrottlingDisabled(contents, "selection", true)) {
        deadlineController.canonicalSelected();
      }
    }
    if (preloadErrorWebContentsIds.has(contents.id)) {
      tracker.preloadError(contents.id);
    }
    log("info", "promotion original renderer eligible window observed", {
      webContentsId: contents.id,
      url: promotionOriginalRendererLogUrl(canonicalUrl),
      sessionIsDefault: contents.session === session.defaultSession,
      sandbox: preferences.sandbox,
      contextIsolation: preferences.contextIsolation,
      nodeIntegration: preferences.nodeIntegration,
      originalPreloadPath: preferences.preload ?? null,
      originalPreloadValid,
      selected: selectedId === contents.id,
    });
    settleIfComplete();
  };
  const onBrowserWindowCreated = (_event: Electron.Event, window: Electron.BrowserWindow): void => {
    tracker.windowCaptured();
    capturedWindows.add(window);
    const contents = window.webContents;
    const initiallyVisible = window.isVisible();
    const removers: Array<() => void> = [];
    const listen = (
      emitter: NodeJS.EventEmitter,
      event: string,
      listener: (...args: any[]) => void,
    ): void => {
      emitter.on(event, listener);
      removers.push(() => emitter.removeListener(event, listener));
    };
    suppressWindowOpacity(window, removers);
    for (const method of ["show", "showInactive", "focus", "restore"] as const) {
      suppressWindowActivationMethod(window, method, removers);
    }
    if (cleaningUp) {
      lateWindowDuringCleanup = true;
      fail("BrowserWindow was created during promotion cleanup");
      hideWindow(window);
      try { window.destroy(); } catch { /* Cleanup fails below. */ }
      if (!window.isDestroyed()) fail("late promotion cleanup window could not be destroyed");
      windowCleanup.set(window, removers);
      if (cleanupFinished) app.exit(1);
      return;
    }
    listen(window, "show", () => {
      hideWindow(window);
      if (!cleaningUp) fail(`captured window ${contents.id} emitted show`);
    });
    listen(window, "ready-to-show", () => hideWindow(window));
    listen(window, "focus", () => {
      hideWindow(window);
      if (!cleaningUp) fail(`captured window ${contents.id} emitted focus`);
    });
    listen(window, "closed", () => {
      log("info", "promotion original BrowserWindow destroyed", {
        webContentsId: contents.id,
        cleanup: cleaningUp,
      });
      if (!cleaningUp && canonicalWindow === window) fail("canonical window was destroyed", contents.id);
    });
    listen(contents, "did-start-navigation", (
      _navigationEvent: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean,
    ) => {
      log("info", "promotion original renderer navigation started", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
        isMainFrame,
      });
      considerEligible(window, url, isMainFrame);
    });
    listen(contents, "did-navigate", (_navigationEvent: Electron.Event, url: string) => {
      log("info", "promotion original renderer navigation completed", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
      });
      considerEligible(window, url, true);
    });
    listen(contents, "did-finish-load", () => {
      const url = contents.getURL();
      considerEligible(window, url, true);
      if (
        canonicalWindow === window
        && canonicalPromotionOriginalRendererUrl(url) !== null
        && !requireBackgroundThrottlingDisabled(contents, "did-finish-load")
      ) return;
      tracker.didFinishLoad(contents.id, url);
      if (canonicalWindow === window && canonicalPromotionOriginalRendererUrl(url) !== null) {
        deadlineController?.canonicalLoaded();
      }
      log("info", "promotion original renderer load completed", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(url),
      });
      settleIfComplete();
    });
    listen(contents, "dom-ready", () => {
      log("info", "promotion original renderer DOM ready", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(contents.getURL()),
        selected: canonicalWindow === window,
      });
    });
    listen(contents, "did-stop-loading", () => {
      log("info", "promotion original renderer stopped loading", {
        webContentsId: contents.id,
        url: promotionOriginalRendererLogUrl(contents.getURL()),
        selected: canonicalWindow === window,
      });
    });
    listen(contents, "preload-error", (
      _preloadEvent: Electron.Event,
      preloadPath: string,
      error: Error,
    ) => {
      preloadErrorWebContentsIds.add(contents.id);
      tracker.preloadError(contents.id);
      log("warn", "promotion original renderer preload failed", {
        webContentsId: contents.id,
        preloadPath,
        error: error instanceof Error ? error.message : String(error),
      });
      settleIfComplete();
    });
    listen(contents, "did-fail-load", (
      _loadEvent: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) considerEligible(window, validatedURL, true);
      log("warn", "promotion original renderer did-fail-load", {
        webContentsId: contents.id,
        errorCode,
        errorDescription,
        url: promotionOriginalRendererLogUrl(validatedURL),
        isMainFrame,
      });
      if (isMainFrame && canonicalWindow === window) fail("canonical renderer load failed", contents.id);
    });
    listen(contents, "did-fail-provisional-load", (
      _loadEvent: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      log("warn", "promotion original renderer did-fail-provisional-load", {
        webContentsId: contents.id,
        errorCode,
        errorDescription,
        url: promotionOriginalRendererLogUrl(validatedURL),
        isMainFrame,
        selected: canonicalWindow === window,
      });
      if (canonicalWindow === window && shouldFailPromotionOriginalRendererProvisionalLoad({
        isMainFrame,
        webContentsId: contents.id,
        canonicalWebContentsId: tracker.summary().canonicalWebContentsId,
      })) {
        fail("canonical renderer provisional load failed", contents.id);
      }
    });
    listen(contents, "render-process-gone", (_goneEvent: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      log("warn", "promotion original renderer process exited", {
        webContentsId: contents.id,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      if (canonicalWindow === window) fail("canonical renderer process exited", contents.id);
    });
    windowCleanup.set(window, removers);
    if (initiallyVisible) fail(`captured window ${contents.id} was initially visible`);
    hideWindow(window);
    if (window.isVisible()) fail("captured window could not be hidden");
    log("info", "promotion original BrowserWindow captured and hidden", {
      webContentsId: contents.id,
      capturedWindowCount: tracker.summary().capturedWindowCount,
      initiallyVisible,
    });
  };
  const onAuthorization = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (owner) considerEligible(owner, event.senderFrame?.url ?? "", event.senderFrame === event.sender.mainFrame);
    const windowAlive = canonicalWindow !== null
      && !canonicalWindow.isDestroyed()
      && !canonicalWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === canonicalWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === canonicalWindow!.webContents.mainFrame;
    const decision = authorizePromotionOriginalRenderer({
      windowAlive,
      windowHidden: windowAlive && !canonicalWindow!.isVisible(),
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      consumed: authorizationConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      event.returnValue = null;
      log("warn", "promotion original renderer authorization rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    if (process.platform === "darwin") {
      let rendererProcessId: number | null = null;
      let sandboxProcessVerified = false;
      try {
        rendererProcessId = event.sender.getOSProcessId();
        sandboxProcessVerified = hasUniqueSandboxedPromotionRendererProcess(
          app.getAppMetrics(),
          rendererProcessId,
        );
      } catch {
        sandboxProcessVerified = false;
      }
      if (!sandboxProcessVerified) {
        event.returnValue = null;
        log("warn", "promotion original renderer authorization rejected", {
          webContentsId: event.sender.id,
          reason: "sandbox process metric was not uniquely verified",
          rendererProcessId,
        });
        fail("canonical renderer sandbox process proof failed", event.sender.id);
        return;
      }
    }
    authorizationConsumed = true;
    tracker.authorization(event.sender.id);
    event.returnValue = JSON.stringify(decision.response);
    log("info", "promotion original renderer authorization accepted", {
      webContentsId: event.sender.id,
    });
    settleIfComplete();
  };
  const onHandshake = (event: Electron.IpcMainEvent, payload: unknown): void => {
    const windowAlive = canonicalWindow !== null
      && !canonicalWindow.isDestroyed()
      && !canonicalWindow.webContents.isDestroyed();
    const senderMatches = windowAlive && event.sender.id === canonicalWindow!.webContents.id;
    const frameMatches = senderMatches
      && event.senderFrame !== null
      && event.senderFrame === canonicalWindow!.webContents.mainFrame;
    if (windowAlive && canonicalWindow!.isVisible()) {
      hideWindow(canonicalWindow!);
      if (canonicalWindow!.isVisible()) {
        fail("canonical renderer became visible and could not be re-hidden", event.sender.id);
        return;
      }
      log("info", "promotion original BrowserWindow delayed activation re-hidden", {
        webContentsId: event.sender.id,
      });
    }
    if (windowAlive && !forceWindowTransparent(canonicalWindow!)) {
      fail("canonical renderer transparency guard failed", event.sender.id);
      return;
    }
    const lifecycle = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).lifecycle
      : null;
    if (lifecycle === "renderer-load-observed") {
      const loadDecision = validatePromotionOriginalRendererLoadObserved({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: tracker.summary().canonicalUrl ?? "",
        authorizationConsumed,
        loadObservedConsumed,
        handshakeConsumed,
      }, payload, nonce);
      if (!loadDecision.accepted) {
        log("warn", "promotion original renderer load observation rejected", {
          webContentsId: event.sender.id,
          reason: loadDecision.reason,
        });
        return;
      }
      if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-load-observed")) return;
      loadObservedConsumed = true;
      log("info", "promotion original renderer load observation accepted", {
        webContentsId: event.sender.id,
        url: promotionOriginalRendererLogUrl(loadDecision.observation.url),
        rendererSandboxed: loadDecision.observation.rendererSandboxed,
      });
      return;
    }
    if (lifecycle === "renderer-mount-timeout") {
      const timeoutDecision = validatePromotionOriginalRendererMountTimeout({
        windowAlive,
        senderMatches,
        frameMatches,
        senderUrl: event.senderFrame?.url ?? "",
        expectedUrl: tracker.summary().canonicalUrl ?? "",
        authorizationConsumed,
        loadObservedConsumed,
        handshakeConsumed,
      }, payload, nonce);
      if (!timeoutDecision.accepted) {
        log("warn", "promotion original renderer mount-timeout rejected", {
          webContentsId: event.sender.id,
          reason: timeoutDecision.reason,
        });
        return;
      }
      if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-mount-timeout")) return;
      handshakeConsumed = true;
      log("warn", "promotion original renderer mount timed out", {
        webContentsId: event.sender.id,
        url: promotionOriginalRendererLogUrl(timeoutDecision.observation.url),
        rendererSandboxed: timeoutDecision.observation.rendererSandboxed,
      });
      fail("canonical renderer mount timed out", event.sender.id);
      return;
    }
    const decision = validatePromotionOriginalRendererHandshake({
      windowAlive,
      senderMatches,
      frameMatches,
      senderUrl: event.senderFrame?.url ?? "",
      expectedUrl: tracker.summary().canonicalUrl ?? "",
      authorizationConsumed,
      loadObservedConsumed,
      handshakeConsumed,
    }, payload, nonce);
    if (!decision.accepted) {
      log("warn", "promotion original renderer lifecycle handshake rejected", {
        webContentsId: event.sender.id,
        reason: decision.reason,
      });
      return;
    }
    if (!requireBackgroundThrottlingDisabled(event.sender, "renderer-mounted")) return;
    handshakeConsumed = true;
    tracker.rendererHandshake({ webContentsId: event.sender.id, ...decision.observation });
    log("info", "promotion original renderer mount handshake accepted", {
      webContentsId: event.sender.id,
      rendererSandboxed: decision.observation.rendererSandboxed,
      rendererStorageSelfTest: decision.observation.rendererStorageSelfTest,
    });
    settleIfComplete();
  };
  const registerSession = (targetSession: Electron.Session, label: string): void => {
    if (registeredSessions.has(targetSession)) return;
    try {
      targetSession.registerPreloadScript({
        type: "frame",
        id: "tweaker-promotion-health-original",
        filePath: PROMOTION_HEALTH_PRELOAD_PATH,
      });
      registeredSessions.add(targetSession);
      log("info", "promotion original preload registered", {
        label,
        path: PROMOTION_HEALTH_PRELOAD_PATH,
      });
    } catch (error) {
      fail(`promotion original preload registration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const onSessionCreated = (createdSession: Electron.Session): void => {
    registerSession(createdSession, "session-created");
  };
  const onAppReady = (): void => {
    registerSession(session.defaultSession, "defaultSession-ready");
  };
  ipcMain.on(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, onAuthorization);
  ipcMain.on(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, onHandshake);
  app.on("session-created", onSessionCreated);
  app.on("browser-window-created", onBrowserWindowCreated);
  // This listener is installed while the injected runtime is still being
  // evaluated, before the loader requires Codex's original main entry. Event
  // ordering therefore registers the default-session preload before any later
  // original-main ready listener can construct a BrowserWindow.
  app.once("ready", onAppReady);

  const cleanup = async (): Promise<boolean> => {
    cleaningUp = true;
    deadlineController.settle();
    ipcMain.removeListener(PROMOTION_ORIGINAL_RENDERER_AUTH_CHANNEL, onAuthorization);
    ipcMain.removeListener(PROMOTION_ORIGINAL_RENDERER_IPC_CHANNEL, onHandshake);
    app.removeListener("session-created", onSessionCreated);
    app.removeListener("ready", onAppReady);
    let success = true;
    // Destroy while activation methods are still suppressed. Restoring them
    // first would leave a small teardown window in which original-main code
    // could reveal or focus a probe window.
    for (const window of capturedWindows) {
      try {
        if (!window.isDestroyed()) window.destroy();
        if (!window.isDestroyed()) success = false;
      } catch {
        success = false;
      }
    }
    for (const removers of windowCleanup.values()) {
      for (const remove of removers) remove();
    }
    windowCleanup.clear();
    for (const registeredSession of registeredSessions) {
      try {
        registeredSession.unregisterPreloadScript("tweaker-promotion-health-original");
      } catch {
        success = false;
      }
    }
    const appServerCleanup = await codexAppServerParent.cleanupTrackedParents();
    if (appServerCleanup.failed > 0 || lateWindowDuringCleanup) success = false;
    log(success ? "info" : "warn", "promotion original renderer cleanup completed", {
      destroyedWindowCount: capturedWindows.size,
      registeredSessionCount: registeredSessions.size,
      lateWindowDuringCleanup,
      appServerCleanup,
      success,
    });
    tracker.cleanup(success);
    cleanupFinished = true;
    return success;
  };

  return {
    registerSession,
    async run() {
      await proofSettled;
      await cleanup();
      const result = tracker.result();
      log(result.hostReady === "pass" ? "info" : "warn", "promotion original renderer proof completed", {
        hostReady: result.hostReady,
        rendererStorageSelfTest: result.rendererStorageSelfTest,
        proofSummary: result.proofSummary ? {
          ...result.proofSummary,
          ...promotionOriginalRendererEvidenceUrl(result.proofSummary.canonicalUrl),
        } : undefined,
      });
      return result;
    },
  };
}

// Construct this controller during runtime evaluation, before the loader
// requires Codex's original main entry. It registers every capture/listener
// needed to observe the original protocol and original BrowserWindow.
const originalMainPromotionProbe = healthOriginalMain
  ? createPromotionOriginalMainProbe()
  : null;

app.whenReady().then(() => {
  log("info", "app ready fired");
  originalMainPromotionProbe?.registerSession(session.defaultSession, "defaultSession-whenReady");
  // A disposable health probe launches Codex's main process only far enough to
  // reach app.whenReady — the real Codex bootstrap never runs, so services the
  // normal session cookie read depends on may never settle and could hang. Bound
  // the whole receipt path and force-exit so the installer's probe can never
  // hang on us; a missing receipt fails safe (promotion is blocked, app intact).
  if (healthCheckOnly) {
    if (!healthOriginalMain) {
      const watchdog = setTimeout(() => {
        log("warn", "health-check watchdog fired; exiting");
        app.exit(0);
      }, 12_000);
      watchdog.unref?.();
    }
  }
  void (async () => {
    // Answering is a one-shot: it unlinks the installer's request and rewrites
    // the receipt. Only a health process can produce a renderer proof, so an
    // ordinary launch that answered could only ever write an all-"unknown"
    // receipt — while consuming the request the real probe needs and replacing
    // whatever that probe had already proven. Seen live 2026-08-09: the ordinary
    // 10:45:48 launch overwrote the 10:42:57 passing proof with hostReady
    // "unknown". Ordinary launches leave the request for the health process.
    if (!healthCheckOnly) {
      if (existsSync(join(userRoot!, "health", "request.json"))) {
        log("info", "promotion health request left untouched; this launch is not a health process");
      }
      return;
    }
    const rendererProof: PromotionRendererProofResult = healthOriginalMain
      ? await originalMainPromotionProbe!.run()
      : await runPromotionRendererProof();
    // The renderer proof owns its own deadlines; nothing bounded the stretch
    // AFTER it, which is exactly where probes hung. Writing the receipt is
    // bounded hashing of small trees — measured at 47ms on a passing candidate
    // probe (proof 14:30:04.541Z, receipt 14:30:04.588Z) — so anything past a
    // few seconds here means the main thread is blocked, not busy. On
    // 2026-08-09 that stretch ran 44.4s once and past the installer's 170s
    // spawnSync timeout twice, and a probe killed by that timeout reports no
    // receipt at all, failing the whole promotion. Exit on our own terms
    // instead: a missing receipt fails safe (promotion blocked, app intact).
    const receiptWatchdog = setTimeout(() => {
      log("warn", "health-check receipt watchdog fired after the renderer proof; exiting", {
        hostReady: rendererProof.hostReady,
      });
      app.exit(0);
    }, HEALTH_RECEIPT_WATCHDOG_MS);
    receiptWatchdog.unref?.();
    void answerPromotionHealthRequest(userRoot!, {
    authenticatedSession: async () => {
      // Check the Codex account token FIRST: it is a fast, synchronous file read
      // and is the real sign-in signal for the desktop app. The web session
      // cookie read below can stall in a bare health-probe launch, so only reach
      // for it (with a timeout) when no durable token is present.
      if (hasAuthenticatedCodexToken(readCodexAuth(MCP_RUNTIME_PATHS.codexHome))) return "pass";
      try {
        const cookies = await withTimeout(session.defaultSession.cookies.get({}), 3_000);
        if (cookies && hasAuthenticatedSessionCookie(cookies)) return "pass";
      } catch {
        // No usable session signal; report unknown (fails safe).
      }
      return "unknown";
    },
    declaredPermission: (permission) => {
      if (process.platform !== "darwin") return "unknown";
      if (permission === "accessibility") return systemPreferences.isTrustedAccessibilityClient(false) ? "pass" : "fail";
      if (permission === "screen-recording") return systemPreferences.getMediaAccessStatus("screen") === "granted" ? "pass" : "fail";
      if (permission === "screen-capture") return systemPreferences.getMediaAccessStatus("screen") === "granted" ? "pass" : "fail";
      if (permission === "global-shortcut") return "pass";
      return "unknown";
    },
    rendererReady: () => rendererProof.hostReady,
    rendererProof: () => rendererProof.proofSummary ?? null,
    promotionSurface: promotionSurfaceHash,
    userQuestionsHealth: () => promotionUserQuestionsHealth(rendererProof.rendererStorageSelfTest),
    }, { maxAgeMs: PROMOTION_HEALTH_REQUEST_MAX_AGE_MS }).then((answered) => {
      if (!answered) {
        // A health process is launched to answer exactly one request, so a
        // request it could not use is always worth a warn — an absent one means
        // the installer's one-shot was consumed or never landed.
        const requestPending = existsSync(join(userRoot!, "health", "request.json"));
        log("warn", requestPending
          ? "promotion health request was present but invalid"
          : "promotion health request was absent");
      }
      app.exit(0);
    }).catch((error) => {
      if (
        error === null
        || (typeof error !== "object" && typeof error !== "function")
        || !SANITIZED_PROMOTION_POLICY_FAILURES.has(error)
      ) {
        log("warn", "promotion health receipt failed", error);
      }
      app.exit(0);
    });
  })().catch((error) => {
    log("warn", "promotion renderer bootstrap failed", error);
    if (healthCheckOnly) app.exit(0);
  });
  if (!healthCheckOnly) {
    if (isTweakerSafeModeEnabled()) {
      log("warn", "safe mode is enabled; preload will not be registered");
    } else {
      registerPreload(session.defaultSession, "defaultSession");
      maybeStartBrowserUiServer({
        getWindowServices: getCodexWindowServices,
        log,
      });
    }
  }
});

if (!healthCheckOnly) {
  app.on("session-created", (s) => {
    if (isTweakerSafeModeEnabled()) return;
    registerPreload(s, "session-created");
  });
}

// DIAGNOSTIC: log every webContents creation. Useful for verifying our
// preload reaches every renderer Codex spawns.
if (derivedVariant && !healthCheckOnly) {
  app.on("browser-window-created", (_event, window) => {
    const identifyPrimaryWindow = (title = window.getTitle()): void => {
      if (window.isDestroyed() || exactIndependentTweakersPrimaryWindow() !== window) return;
      const detail = title.replace(/^(?:Tweakers|ChatGPT|Codex)(?:\s*[-–—:]\s*|$)/, "").trim();
      window.setTitle(detail ? `Tweakers — ${detail}` : "Tweakers");
    };
    window.on("page-title-updated", (event, title) => {
      if (exactIndependentTweakersPrimaryWindow() !== window) return;
      event.preventDefault();
      identifyPrimaryWindow(title);
    });
    window.on("show", () => identifyPrimaryWindow());
    window.on("focus", () => identifyPrimaryWindow());
    window.webContents.on("did-finish-load", () => identifyPrimaryWindow());
  });
}

app.on("web-contents-created", (_e, wc) => {
  try {
    const wp = (wc as unknown as { getLastWebPreferences?: () => Record<string, unknown> })
      .getLastWebPreferences?.();
    log("info", "web-contents-created", {
      id: wc.id,
      type: wc.getType(),
      sessionIsDefault: wc.session === session.defaultSession,
      sandbox: wp?.sandbox,
      contextIsolation: wp?.contextIsolation,
    });
    wc.on("preload-error", (_ev, p, err) => {
      log("error", `wc ${wc.id} preload-error path=${p}`, String(err?.stack ?? err));
    });
  } catch (e) {
    log("error", "web-contents-created handler failed:", String((e as Error)?.stack ?? e));
  }
});

log("info", "main.ts evaluated; app.isReady=" + app.isReady());
if (isTweakerSafeModeEnabled()) {
  log("warn", "safe mode is enabled; tweaks will not be loaded");
}

// 2. Initial tweak discovery + main-scope load.
// Defer tweak discovery/load off the synchronous module-eval path so the loader
// can proceed to OpenAI's main entrypoint immediately. setImmediate runs after
// the current require chain unwinds but BEFORE Electron's `ready` event, which
// preserves the pre-ready execution context these main-scope tweaks already run
// in today (so BrowserWindow/main hooks are installed before any window opens),
// while removing the synchronous startup stall. MCP reconciliation is invoked
// inside loadAllMainTweaks, so it defers with it.
if (!healthCheckOnly) {
  setImmediate(() => {
    void loadTweaksInitially(tweakLifecycleDeps).catch((error) => {
      log("error", "failed initial main tweak load:", error);
    });
  });
}

app.on("will-quit", () => {
  void mcpReconciler?.close();
  stopAllMainTweaks();
  nativeBridge.disposeAll();
  disposeAllOwlViews();
  // Best-effort flush of any pending storage writes.
  for (const t of tweakState.loadedMain.values()) {
    try {
      t.storage.flush();
    } catch {}
  }
  finishTweakLifecycleAttempt();
});

function openNativeSettingsFromApplicationMenu(owner?: BrowserWindow): boolean {
  const applicationMenu = Menu.getApplicationMenu();
  if (!applicationMenu) return false;
  const candidates: Electron.MenuItem[] = [];
  const visit = (items: readonly Electron.MenuItem[]): void => {
    for (const item of items) {
      if (item.submenu) visit(item.submenu.items);
      if (item.enabled === false || item.visible === false || typeof item.click !== "function") continue;
      const label = item.label.replace(/&/g, "").replace(/\.{3}|…/g, "").trim().toLowerCase();
      const role = String(item.role ?? "").toLowerCase();
      const accelerator = String(item.accelerator ?? "").replace(/\s/g, "").toLowerCase();
      if (
        role === "preferences" ||
        label === "settings" ||
        label === "preferences" ||
        /^(commandorcontrol|cmdorctrl|command|cmd)\+,?$/.test(accelerator)
      ) {
        candidates.push(item);
      }
    }
  };
  visit(applicationMenu.items);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) return false;
  try {
    Reflect.apply(unique[0].click!, unique[0], [unique[0], owner, undefined]);
    return true;
  } catch (error) {
    log("warn", "open settings application-menu action failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// 3. IPC: expose tweak metadata + reveal-in-finder.
ipcMain.handle("tweaker:open-settings", (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  return openNativeSettingsFromApplicationMenu(owner);
});
ipcMain.handle("tweaker:list-tweaks", async () => {
  // The promotion journal fingerprints config.json until the manager accepts
  // the runtime-ready receipt and durably commits the generation. Settings
  // must remain readable during that proof, but its background release checks
  // update checkedAt fields in config.json. Defer those Tweakers-owned writes
  // until the one-use expectation disappears so a healthy startup cannot be
  // mistaken for promotion drift or make compensating rollback ambiguous.
  if (!independentRuntimeReadyCommitPending()) {
    await Promise.all(tweakState.discovered.map((t) => ensureTweakUpdateCheck(t)));
  }
  const updateChecks = readState().tweakUpdateChecks ?? {};
  const catalog = readBundledTweakCatalog();
  const discoveredById = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const ids = [
    ...(catalog?.entries.map((entry) => entry.id) ?? []),
    ...tweakState.discovered.map((t) => t.manifest.id),
  ].filter((id, index, all) => all.indexOf(id) === index);
  return ids.map((id) => {
    const local = discoveredById.get(id);
    const catalogEntry = catalog?.entries.find((entry) => entry.id === id) ?? null;
    const manifest = local?.manifest ?? catalogEntry?.manifest;
    if (!manifest) return null;
    const installed = !!local;
    const enabled = installed && isTweakEnabled(id);
    const health = installed ? tweakHealth(id) : null;
    return {
      manifest,
      entry: local?.entry ?? "",
      dir: local?.dir ?? "",
      entryExists: !!local && existsSync(local.entry),
      installed,
      enabled,
      status: deriveTweakStatus({ installed, enabled, health }),
      health,
      catalog: catalogEntry,
      update: local ? updateChecks[id] ?? null : null,
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
});
ipcMain.handle("tweaker:get-tweaks-health", () => buildTweakHealthSnapshot());
// Reserved privileged-preload bridge. It is intentionally registered outside
// the tweak IPC registry so renderer tweaks cannot route native IDs through
// their public command surface.
ipcMain.handle(SHARED_HISTORY_MAP_NATIVE_TARGET_CHANNEL, async (event, payload: unknown) => {
  const sender = ownedCodexRenderer(event.sender.id);
  if (!sender || sender !== event.sender) return sharedHistoryTargetUnavailable();
  return mapSharedHistoryNativeTarget(sender.id, payload);
});
ipcMain.on("tweaker:tweak-lifecycle", (event, payload: unknown) => {
  if (derivedVariant && !isExactIndependentTweakersPrimaryMainFrame(event.sender, event.senderFrame)) return;
  if (!payload || typeof payload !== "object") return;
  const value = payload as { id?: unknown; process?: unknown; status?: unknown; error?: unknown };
  if (typeof value.id !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value.id)) return;
  if (value.process !== "renderer" || typeof value.status !== "string") return;
  const status = value.status as TweakLifecycleStatus;
  if (![
    "starting",
    "ready",
    "failed",
    "timed_out",
    "disabled",
    "quarantined",
  ].includes(status)) return;
  recordTweakLifecycle(value.id, "renderer", status, value.error);
  if (status === "ready") tryWriteRuntimeReadyReceipt();
});
ipcMain.on("tweaker:settings-mounted", (event, payload: unknown) => {
  if (!derivedVariant || runtimeReadySettingsMounted) return;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload as Record<string, unknown>).join(",") !== "version"
    || (payload as { version?: unknown }).version !== 1) return;
  if (!isExactIndependentTweakersPrimaryMainFrame(event.sender, event.senderFrame)) return;
  runtimeReadySettingsMounted = true;
  stopRuntimeReadySettingsMountAttempts();
  log("info", "runtime-ready Settings mount observed", { webContentsId: event.sender.id });
  requestRuntimeReadyBrokerConnection(exactIndependentTweakersPrimaryWindow());
  scheduleIndependentTweakersLiveHealthCapture();
  tryWriteRuntimeReadyReceipt();
});
ipcMain.handle("tweaker:get-tweak-lifecycle", () => lifecycleJournal);
ipcMain.handle(
  "tweaker:cross-tweak-read",
  (_e, requester: unknown, target: unknown, action: unknown, message: unknown) =>
    dispatchCrossTweakRead(
      requester,
      target,
      action,
      message,
      (tweakId, channel) => mainTweakReadHandlers.get(`${tweakId}:${channel}`),
    ),
);

ipcMain.handle("tweaker:get-tweak-enabled", (_e, id: string) => isTweakEnabled(id));
ipcMain.on(ACCOUNTS_NATIVE_COMPATIBILITY_CHANNEL, (event) => {
  if (!ownedCodexRenderer(event.sender.id)) {
    event.returnValue = { compatible: false, reason: "Accounts is unavailable in this window.", hookSetSha256: null, build: null };
    return;
  }
  event.returnValue = readAccountsNativeCompatibility(join(process.resourcesPath, "app.asar"));
});
ipcMain.handle("tweaker:set-tweak-enabled", async (_e, id: string, enabled: boolean) => {
  if (id === "co.tweakers.account-switcher" && enabled) {
    const compatibility = readAccountsNativeCompatibility(join(process.resourcesPath, "app.asar"));
    if (!compatibility.compatible) throw new Error(compatibility.reason ?? "Accounts requires a compatible desktop refresh.");
  }
  const result = await setTweakEnabledAndReload(id, enabled, tweakLifecycleDeps);
  if (id === "co.tweakers.account-switcher") (globalThis as any).__tweakersAccountsNativeMainV1?.refreshProjects?.();
  return result;
});
ipcMain.handle("tweaker:recover-tweak", (_e, id: string) => recoverTweak(id));
ipcMain.handle("tweaker:clear-tweak-health", (_e, id: string) => {
  clearTweakHealth(id);
  return true;
});

function bundledCodexBinary(): string {
  return join(process.resourcesPath, "codex");
}

function selectedCodexLane(): CodexCliLane {
  return readState().tweaker?.codexCliLane ?? codexCliBootstrap.effectiveLane;
}

function codexReleaseIsNewer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  const latestVersion = parseCodexVersionTag(`rust-v${latest}`);
  const installedVersion = parseCodexVersionTag(`rust-v${installed}`);
  return !!latestVersion && !!installedVersion && compareCodexVersions(latestVersion, installedVersion) > 0;
}

function installedCodexDesktopVersion(root: string | null): { installedMarketingVersion: string | null; installedBuild: string | null } {
  let plistMarketingVersion: string | null = null;
  let plistBuild: string | null = null;
  try {
    if (root) {
      const plist = readFileSync(join(root, "Contents", "Info.plist"), "utf8");
      plistMarketingVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
      plistBuild = /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
    }
  } catch {}
  return probeCodexDesktopVersion({
    appVersion: null,
    infoPlistMarketingVersion: plistMarketingVersion,
    infoPlistBuild: plistBuild,
    stateMarketingVersion: null,
  });
}

function selectedCodexDesktopUpdateTarget(): CodexDesktopUpdateTarget {
  if (derivedVariant) {
    if (independentManagerStatusDeferredForRuntimeReady()) {
      return {
        profile: "stable",
        appPath: null,
        available: false,
        unavailableReason: INDEPENDENT_MANAGER_STARTUP_REASON,
        setupRequired: null,
        identityKey: null,
        feedUrl: null,
        fallbackFeedUrl: null,
      };
    }
    try {
      const official = readTweakersManagerStatus().status.environment?.officialApp;
      if (official?.state !== "valid" || !official.appPath || !official.bundleId) {
        throw new Error("The manager has no verified official ChatGPT app");
      }
      const profile = official.bundleId === "com.openai.codex.beta" ? "alpha" : "stable";
      return {
        profile,
        appPath: official.appPath,
        available: true,
        unavailableReason: null,
        setupRequired: null,
        identityKey: createHash("sha256").update(`${profile}\0${official.appPath}\0${official.bundleId}`).digest("hex"),
        feedUrl: null,
        fallbackFeedUrl: null,
      };
    } catch (error) {
      return {
        profile: "stable",
        appPath: null,
        available: false,
        unavailableReason: error instanceof Error ? error.message : String(error),
        setupRequired: null,
        identityKey: null,
        feedUrl: null,
        fallbackFeedUrl: null,
      };
    }
  }
  let profile: CodexDesktopUpdateTarget["profile"] = "stable";
  try {
    const selection = JSON.parse(readFileSync(ENVIRONMENT_SELECTION_FILE, "utf8")) as { releaseProfile?: unknown };
    if (selection.releaseProfile === "alpha") profile = "alpha";
  } catch {}
  const registry = readJsonDocument(ENVIRONMENT_REGISTRY_FILE);
  const identity = verifiedCodexDesktopProfileIdentity(registry, profile);
  const capturedFeed = identity
    ? readCapturedCodexDesktopProfileFeed(readState().tweaker?.codexDesktopProfileFeeds?.[profile], identity)
    : null;
  return codexDesktopUpdateTargetForProfile({ profile, identity, capturedFeed });
}

async function refreshCodexDesktopUpdateMetadata(
  target: CodexDesktopUpdateTarget,
): Promise<CodexDesktopUpdateMetadata> {
  if (!target.available || target.profile !== "stable") {
    if (!target.available) {
      throw new Error(target.unavailableReason ?? "The selected desktop update profile is unavailable");
    }
    if (!target.identityKey || !target.feedUrl) {
      throw new Error("The verified Alpha appcast capture is unavailable");
    }
  }
  const installed = installedCodexDesktopVersion(target.appPath ?? null);
  const cacheKey = installed.installedMarketingVersion
    ? `${installed.installedMarketingVersion}:${installed.installedBuild ?? ""}`
    : null;
  const memoryKey = codexDesktopAppcastMemoryKey(target);
  const cached = readPersistedCodexAppcast(target.profile, target.identityKey ?? null, cacheKey);
  const refreshed = target.profile === "alpha"
    ? await getCodexSparkleBridge().fetchProfileAppcastMetadata({
        identityKey: target.identityKey!,
        feedUrl: target.feedUrl!,
        fallbackFeedUrl: target.fallbackFeedUrl,
      })
    : await getCodexSparkleBridge().fetchAppcastMetadata();
  let metadata = refreshed;
  if (!refreshed.error && !refreshed.stale) {
    codexAppcastMetadataByIdentity.set(memoryKey, refreshed);
    persistCodexAppcast(target.profile, target.identityKey ?? "official-stable-default", cacheKey, refreshed);
  } else if (cached || codexAppcastMetadataByIdentity.has(memoryKey)) {
    metadata = {
      ...(codexAppcastMetadataByIdentity.get(memoryKey) ?? cached)!,
      stale: true,
      error: refreshed.error ?? "OpenAI appcast metadata could not be refreshed.",
    };
    codexAppcastMetadataByIdentity.set(memoryKey, metadata);
  }
  return {
    installed: {
      marketingVersion: installed.installedMarketingVersion,
      build: installed.installedBuild,
    },
    latest: {
      marketingVersion: metadata.marketingVersion || null,
      build: metadata.build || null,
    },
    checkedAt: metadata.checkedAt || new Date().toISOString(),
    stale: metadata.stale,
    error: metadata.error,
    updateAvailable: isCodexDesktopUpdateNewer(
      installed.installedMarketingVersion,
      installed.installedBuild,
      metadata.marketingVersion || null,
      metadata.build || null,
    ),
  };
}

function codexDesktopAppcastMemoryKey(target: CodexDesktopUpdateTarget): string {
  return `${target.profile}:${target.identityKey ?? "unverified"}`;
}

function safeAppcastCacheUrl(value: string | null): string | null {
  return safePersistedAppcastUrl(value);
}

function readPersistedCodexAppcast(
  profile: "stable" | "alpha",
  identityKey: string | null,
  desktopVersion: string | null,
): SparkleAppcastMetadata | null {
  if (!desktopVersion || !identityKey) return null;
  const state = readState().tweaker;
  const profileCache = state?.codexAppcastProfileCaches?.[profile];
  const cache = profileCache
    && profileCache.profile === profile
    && profileCache.identityKey === identityKey
    ? profileCache
    : profile === "stable" ? state?.codexAppcastCache : null;
  if (
    cache?.schemaVersion !== 1 ||
    cache.desktopVersion !== desktopVersion ||
    typeof cache.marketingVersion !== "string" || !cache.marketingVersion.trim() ||
    typeof cache.build !== "string" || !cache.build.trim() ||
    typeof cache.checkedAt !== "string" || !Number.isFinite(Date.parse(cache.checkedAt))
  ) return null;
  const feedUrl = safeAppcastCacheUrl(cache.feedUrl);
  if (!feedUrl) return null;
  const releaseUrl = cache.releaseUrl === null ? null : safeAppcastCacheUrl(cache.releaseUrl);
  if (cache.releaseUrl !== null && !releaseUrl) return null;
  return {
    marketingVersion: cache.marketingVersion,
    build: cache.build,
    releaseUrl,
    feedUrl,
    checkedAt: cache.checkedAt,
    stale: Date.now() - Date.parse(cache.checkedAt) >= CODEX_APPCAST_CACHE_TTL_MS,
    error: null,
  };
}

function persistCodexAppcast(
  profile: "stable" | "alpha",
  identityKey: string,
  desktopVersion: string | null,
  metadata: SparkleAppcastMetadata,
): void {
  // OpenAI's original main invokes its background updater during the one-shot
  // renderer probe. The redirected check may refresh this bounded cache, but
  // a health probe must remain observational: its expected promotion surfaces
  // were sealed before launch. Suppress only this cache writer so every other
  // unexpected config mutation still fails the exact surface comparison.
  if (healthCheckOnly || derivedVariant) return;
  if (!desktopVersion || metadata.error || metadata.stale) return;
  const feedUrl = safeAppcastCacheUrl(metadata.feedUrl);
  const releaseUrl = metadata.releaseUrl === null ? null : safeAppcastCacheUrl(metadata.releaseUrl);
  if (!feedUrl || (metadata.releaseUrl !== null && !releaseUrl)) return;
  if (!metadata.marketingVersion.trim() || !metadata.build.trim() || !Number.isFinite(Date.parse(metadata.checkedAt))) return;
  const state = readState();
  state.tweaker ??= {};
  state.tweaker.codexAppcastProfileCaches ??= {};
  state.tweaker.codexAppcastProfileCaches[profile] = {
    schemaVersion: 1,
    profile,
    identityKey,
    desktopVersion,
    marketingVersion: metadata.marketingVersion,
    build: metadata.build,
    releaseUrl,
    feedUrl,
    checkedAt: metadata.checkedAt,
  };
  if (profile === "stable") {
    state.tweaker.codexAppcastCache = {
      schemaVersion: 1,
      desktopVersion,
      marketingVersion: metadata.marketingVersion,
      build: metadata.build,
      releaseUrl,
      feedUrl,
      checkedAt: metadata.checkedAt,
    };
  }
  writeState(state);
}

function persistCapturedCodexDesktopProfileFeed(
  capture: { feedUrl: string | null; fallbackFeedUrl: string | null },
): void {
  if (derivedVariant) return;
  const registry = readJsonDocument(ENVIRONMENT_REGISTRY_FILE);
  const selection = readJsonDocument(ENVIRONMENT_SELECTION_FILE);
  const identity = activeVerifiedCodexDesktopProfileIdentity(registry, selection, inferMacAppRoot());
  if (!identity) {
    log("warn", "ignored Sparkle feed capture without a matching verified desktop profile");
    return;
  }
  const feed = createCapturedCodexDesktopProfileFeed(identity, capture, new Date().toISOString());
  if (!feed) {
    log("warn", "ignored invalid Sparkle feed capture", { profile: identity.profile });
    return;
  }
  const state = readState();
  state.tweaker ??= {};
  state.tweaker.codexDesktopProfileFeeds ??= {};
  state.tweaker.codexDesktopProfileFeeds[identity.profile] = feed;
  writeState(state);
}

function readJsonDocument(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function terminalCodexFromLoginShell(): string | null {
  const shellPath = process.env.SHELL;
  if (!shellPath || !isAbsolute(shellPath)) return null;
  try {
    if (!existsSync(shellPath) || !statSync(shellPath).isFile()) return null;
    const result = spawnSync(shellPath, ["-lic", "command -v codex"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0) return null;
    return terminalCodexPathFromShellOutput(result.stdout ?? "", (path) => {
      try {
        return existsSync(path) && statSync(path).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
}

async function getCodexVersionsSnapshot(force: boolean): Promise<CodexVersionsSnapshot> {
  const selectedLane = selectedCodexLane();
  const desktopTarget = selectedCodexDesktopUpdateTarget();
  const bundledPath = bundledCodexBinary();
  const betaPath = codexCliManager.getSelectedBinary();
  const activeCliPath = codexCliBootstrap.binary ?? bundledPath;
  const terminalPath = resolveTerminalCodexBinary({
    home: homedir(),
    pathValue: process.env.PATH,
    preferredPath: process.env.CODEX_TERMINAL_CLI_PATH,
    loginShellPath: terminalCodexFromLoginShell(),
    excludedPaths: [bundledPath, betaPath].filter((value): value is string => !!value),
    isExecutable: (path) => {
      try {
        return existsSync(path) && statSync(path).isFile();
      } catch {
        return false;
      }
    },
  });
  const installedDesktop = installedCodexDesktopVersion(desktopTarget.appPath ?? null);
  const desktopCacheKey = installedDesktop.installedMarketingVersion
    ? `${installedDesktop.installedMarketingVersion}:${installedDesktop.installedBuild ?? ""}`
    : null;
  const persistedAppcast = readPersistedCodexAppcast(
    desktopTarget.profile,
    desktopTarget.identityKey ?? null,
    desktopCacheKey,
  );
  const desktopAppcastMemoryKey = codexDesktopAppcastMemoryKey(desktopTarget);
  if (!codexAppcastMetadataByIdentity.has(desktopAppcastMemoryKey) && persistedAppcast) {
    codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, persistedAppcast);
  }
  const [bundledProbe, betaProbe, terminalProbe, activeCliProbe, bundledRelease, betaRelease, refreshedAppcast] = await Promise.all([
    codexVersionService.probeCli(bundledPath),
    betaPath ? codexVersionService.probeCli(betaPath) : Promise.resolve(null),
    terminalPath ? codexVersionService.probeCli(terminalPath) : Promise.resolve(null),
    codexVersionService.probeCli(activeCliPath),
    force
      ? codexVersionService.fetchLatestRelease("bundled", { force: true })
      : codexVersionService.readCachedRelease("bundled"),
    force
      ? codexVersionService.fetchLatestRelease("beta", { force: true })
      : codexVersionService.readCachedRelease("beta"),
    force && desktopTarget.available
      ? desktopTarget.profile === "alpha"
        ? getCodexSparkleBridge().fetchProfileAppcastMetadata({
            identityKey: desktopTarget.identityKey!,
            feedUrl: desktopTarget.feedUrl!,
            fallbackFeedUrl: desktopTarget.fallbackFeedUrl,
          })
        : getCodexSparkleBridge().fetchAppcastMetadata()
      : Promise.resolve(null),
  ]);
  if (refreshedAppcast) {
    if (!refreshedAppcast.error && !refreshedAppcast.stale) {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, refreshedAppcast);
      persistCodexAppcast(
        desktopTarget.profile,
        desktopTarget.identityKey ?? "official-stable-default",
        desktopCacheKey,
        refreshedAppcast,
      );
    } else if (codexAppcastMetadataByIdentity.has(desktopAppcastMemoryKey) || persistedAppcast) {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, {
        ...(codexAppcastMetadataByIdentity.get(desktopAppcastMemoryKey) ?? persistedAppcast)!,
        stale: true,
        error: refreshedAppcast.error ?? "Appcast metadata is unavailable.",
      });
    } else {
      codexAppcastMetadataByIdentity.set(desktopAppcastMemoryKey, refreshedAppcast);
    }
  }
  const codexAppcastMetadata = codexAppcastMetadataByIdentity.get(desktopAppcastMemoryKey) ?? null;
  const features = buildCodexFeatureUnion(
    bundledProbe.features,
    betaProbe?.features ?? null,
    selectedLane,
  );
  const managerState = codexCliManager.getState();
  const sparkle = getCodexSparkleBridge().getSnapshot();
  const desktopUpdate = isCodexDesktopUpdateNewer(
    installedDesktop.installedMarketingVersion,
    installedDesktop.installedBuild,
    codexAppcastMetadata?.marketingVersion ?? null,
    codexAppcastMetadata?.build ?? null,
  );
  const bundledUpdate = codexReleaseIsNewer(bundledRelease?.release?.version ?? null, bundledProbe.version);
  const betaUpdate = codexReleaseIsNewer(betaRelease?.release?.version ?? null, betaProbe?.version ?? null);
  const errors: CodexVersionsSnapshot["errors"] = {};
  if (bundledProbe.error || bundledRelease?.error) errors.bundled = bundledProbe.error ?? bundledRelease?.error ?? undefined;
  if (betaProbe?.error || betaRelease?.error) errors.beta = betaProbe?.error ?? betaRelease?.error ?? undefined;
  if (!desktopTarget.available) {
    errors.desktop = desktopTarget.unavailableReason ?? "The selected desktop update profile is unavailable.";
  } else if (sparkle.lastError || codexAppcastMetadata?.error) {
    errors.desktop = sparkle.lastError ?? codexAppcastMetadata?.error ?? undefined;
  }
  const activeCliSource = codexCliBootstrap.userOverridePreserved
    ? "override"
    : codexCliBootstrap.effectiveLane === "beta"
      ? "managed-alpha"
      : "bundled";
  const lookupCheckedAt = [
    bundledRelease?.checkedAt,
    betaRelease?.checkedAt,
    codexAppcastMetadata?.checkedAt,
  ]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .map((value) => Date.parse(value));
  // A cache-first snapshot must report when its oldest contributing lookup
  // was actually checked. Stamping Date.now() here made an older cached alpha
  // release look freshly verified while a newer GitHub prerelease existed.
  const checkedAt = lookupCheckedAt.length > 0
    ? new Date(Math.min(...lookupCheckedAt)).toISOString()
    : new Date().toISOString();
  const managedAlphaVersion = managerState.current?.version ?? betaProbe?.version ?? null;

  return {
    schemaVersion: 1,
    checkedAt,
    fromCache: !force && !!(bundledRelease?.fromCache || betaRelease?.fromCache || codexAppcastMetadata),
    stale: !bundledRelease || !betaRelease || bundledRelease.stale || betaRelease.stale || codexAppcastMetadata?.stale === true,
    desktop: {
      installedMarketingVersion: installedDesktop.installedMarketingVersion,
      installedBuild: installedDesktop.installedBuild,
      latestMarketingVersion: codexAppcastMetadata?.marketingVersion ?? null,
      latestBuild: codexAppcastMetadata?.build ?? null,
      releaseUrl: codexAppcastMetadata?.releaseUrl ?? null,
      nativeUpdateLifecycle: sparkle.lifecycle,
      nativeUpdateActionable: sparkle.canInstall,
      nativeUpdatePrerequisiteError: sparkle.installPrerequisiteFailure,
      updateAvailable: desktopUpdate,
    },
    terminalCli: {
      path: terminalProbe?.path ?? terminalPath,
      version: terminalProbe?.version ?? null,
      versionChannel: codexVersionChannel(terminalProbe?.version),
      available: terminalProbe?.available ?? false,
      release: bundledRelease?.release ?? null,
      error: terminalProbe?.error ?? (terminalPath ? null : "Terminal Codex CLI was not found"),
      managedCurrentVersion: null,
      managedPreviousVersion: null,
    },
    activeCli: {
      path: activeCliProbe.path,
      version: activeCliProbe.version,
      versionChannel: codexVersionChannel(activeCliProbe.version),
      available: activeCliProbe.available,
      lane: codexCliBootstrap.effectiveLane,
      source: activeCliSource,
      error: activeCliProbe.error,
    },
    cli: {
      bundled: {
        path: bundledProbe.path,
        version: bundledProbe.version,
        versionChannel: codexVersionChannel(bundledProbe.version),
        available: bundledProbe.available,
        release: bundledRelease?.release ?? null,
        error: bundledProbe.error ?? bundledRelease?.error ?? null,
        managedCurrentVersion: null,
        managedPreviousVersion: null,
      },
      beta: {
        path: betaProbe?.path ?? null,
        version: betaProbe?.version ?? null,
        versionChannel: codexVersionChannel(managedAlphaVersion),
        available: betaProbe?.available ?? false,
        release: betaRelease?.release ?? null,
        error: betaProbe?.error ?? betaRelease?.error ?? (betaPath ? null : "No managed Beta is installed"),
        managedCurrentVersion: managerState.current?.version ?? null,
        managedPreviousVersion: managerState.previous?.version ?? null,
      },
    },
    requestedLane: readState().tweaker?.codexCliLane ?? null,
    effectiveLane: codexCliBootstrap.effectiveLane,
    userOverridePreserved: codexCliBootstrap.userOverridePreserved,
    fallbackReason: codexCliBootstrap.error,
    restartRequired: false,
    features,
    installProgress: codexCliManager.getProgress(),
    errors,
    updateAvailable: desktopUpdate || bundledUpdate || betaUpdate,
  };
}

function assertNoIpcArguments(args: unknown[], channel: string): void {
  if (args.length !== 0) throw new Error(`${channel} does not accept arguments`);
}

function assertExactObjectKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}`);
  }
}

type EnvironmentAppExperience = "chatgpt" | "tweakers";
type EnvironmentReleaseProfile = "stable" | "alpha";

function assertEnvironmentRequest(payload: unknown): asserts payload is {
  appExperience: EnvironmentAppExperience;
  releaseProfile: EnvironmentReleaseProfile;
} {
  assertExactObjectKeys(payload, ["appExperience", "releaseProfile"], "environment request");
  if ((payload.appExperience !== "chatgpt" && payload.appExperience !== "tweakers")
    || (payload.releaseProfile !== "stable" && payload.releaseProfile !== "alpha")) {
    throw new Error("Invalid environment request");
  }
}

function assertEnvironmentTransactionRequest(payload: unknown): asserts payload is { transactionId: string } {
  assertExactObjectKeys(payload, ["transactionId"], "environment transaction request");
  if (typeof payload.transactionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.transactionId)) {
    throw new Error("Invalid environment transaction request");
  }
}

function assertEnvironmentCommitRequest(payload: unknown): asserts payload is { transactionId: string; approvalAt: string } {
  assertExactObjectKeys(payload, ["transactionId", "approvalAt"], "environment commit request");
  if (typeof payload.transactionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(payload.transactionId)
    || typeof payload.approvalAt !== "string"
    || !Number.isFinite(Date.parse(payload.approvalAt))) {
    throw new Error("Invalid environment commit request");
  }
}

async function ensureManagedAlphaEnvironmentBackend(): Promise<void> {
  let validation = await codexCliManager.validateCurrent();
  if (!validation.valid || !validation.binary) {
    await codexCliManager.installBeta();
    validation = await codexCliManager.validateCurrent();
  }
  if (!validation.valid || !validation.binary) {
    throw new Error(validation.error ?? "Managed Alpha installation did not produce a validated backend");
  }
}

ipcMain.handle("tweaker:get-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-codex-versions");
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:refresh-codex-versions", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "refresh-codex-versions");
  if (derivedVariant) return getCodexVersionsSnapshot(false);
  return getCodexVersionsSnapshot(true);
});

ipcMain.handle("tweaker:install-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "install-codex-beta");
  if (derivedVariant) return derivedVariantActionBlocked("install-codex-beta");
  await codexCliManager.installBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:rollback-codex-beta", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "rollback-codex-beta");
  if (derivedVariant) return derivedVariantActionBlocked("rollback-codex-beta");
  await codexCliManager.rollbackBeta();
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:set-codex-feature", async (_e, payload: unknown) => {
  assertExactObjectKeys(payload, ["lane", "name", "enabled"], "Codex feature request");
  const { lane, name, enabled } = payload;
  if ((lane !== "bundled" && lane !== "beta") || typeof name !== "string" || typeof enabled !== "boolean") {
    throw new Error("Invalid Codex feature request");
  }
  if (lane !== selectedCodexLane()) throw new Error("Features can only be changed for the selected Codex runtime");
  const binaryForLane = lane === "bundled" ? bundledCodexBinary() : codexCliManager.getSelectedBinary();
  if (!binaryForLane) throw new Error("The selected Codex runtime is not installed");
  await mutateCodexFeature({ lane, name, enabled }, {
    binaryPath: () => binaryForLane,
    inventory: async () => {
      const probe = await codexVersionService.probeCli(binaryForLane);
      if (!probe.available || !probe.features) throw new Error(probe.error ?? "Codex feature inventory is unavailable");
      return probe.features;
    },
    execFile: async (binary, args, options) => {
      await execFileResult(binary, args, options.timeout, 512 * 1024);
    },
  });
  return getCodexVersionsSnapshot(false);
});

ipcMain.handle("tweaker:reapply-tweakers", async (event, ...args: unknown[]) => {
  assertNoIpcArguments(args, "reapply-tweakers");
  const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const independent = derivedVariant;
  // An independent refresh has no safe fallback source. When the manager has
  // proved the normal official app but has not yet sealed it, make that fixed
  // registration action explicit and stop there; a later, separately
  // confirmed click performs the independent rebuild.
  const managerAction: "refresh.independent" | "refresh.injected" = independent
    ? "refresh.independent"
    : "refresh.injected";
  let registrationRequired = false;
  if (independent) {
    const manager = readTweakersManagerStatus();
    const refresh = manager.actions.find((action) => action.actionId === "refresh.independent");
    if (!refresh?.available) {
      // Source registration is intentionally not a fourth generic status
      // action. Discover its fixed capability through the narrow manager
      // command, then either offer its dedicated confirmation or return one
      // exact safe terminal state before any prepare/execute attempt.
      const registration = readTweakersManagerOfficialSourceRegistration();
      if (!registration.officialSourceRegistration.available) {
        return {
          started: false,
          blocked: true,
          action: "refresh.independent",
          reason: registration.officialSourceRegistration.reason,
        };
      }
      registrationRequired = true;
    }
  }
  const confirmationOptions: MessageBoxOptions = {
    type: "question",
    title: registrationRequired ? "Seal Official ChatGPT Source?" : independent ? "Rebuild Independent Tweakers?" : "Reinject ChatGPT?",
    message: registrationRequired
      ? "Create one manager-sealed copy of the exact current /Applications/ChatGPT.app source?"
      : independent
      ? "Rebuild only /Applications/Tweakers.app from the verified official source?"
      : "Consume the verified candidate for only /Applications/ChatGPT.app?",
    detail: registrationRequired
      ? "This does not invoke ChatGPT's native updater, replace ChatGPT, or restart ChatGPT. It only verifies and seals the exact official source for a later independent Tweakers rebuild."
      : independent
      ? "ChatGPT will not be replaced or restarted. Only the independent Tweakers app may require quiescence."
      : "The independent Tweakers app will not be replaced or restarted. A genuine receipt-bound candidate is required.",
    buttons: [registrationRequired ? "Seal Official Source" : independent ? "Rebuild Tweakers App" : "Reinject ChatGPT", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const confirmation = owner
    ? await dialog.showMessageBox(owner, confirmationOptions)
    : await dialog.showMessageBox(confirmationOptions);
  if (confirmation.response !== 0) return { started: false, cancelled: true };
  if (registrationRequired) {
    const result = startTweakersManagerOfficialSourceRegistration();
    return {
      ...result,
      registrationRequired: true,
      nextAction: "refresh.independent",
      detail: "Official source sealing has started. When it completes, choose Rebuild Tweakers App again.",
    };
  }
  return startTweakersManagerAction(managerAction);
});

ipcMain.handle("tweaker:get-environment-status", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-environment-status");
  if (derivedVariant) return derivedVariantActionBlocked("get-environment-status");
  const status = await runInstalledCliJson(
    ["environment", "status", "--observe", "--json"],
    ENVIRONMENT_STATUS_TIMEOUT_MS,
  );
  // Environment preparation remains available for the separately authorized
  // mode-switch workflow, but never changes ChatGPT's native update menu.
  void environmentModeCacheMenuInputFromStatus(status);
  return status;
});

// This status-only projection is the sole Settings entry point for the
// independent app. It deliberately does not expose a fallback descriptor,
// legacy environment route, watcher, or self-update capability.
ipcMain.handle("tweaker:get-independent-manager-status", (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-independent-manager-status");
  return independentManagerStatusProjection();
});

ipcMain.handle("tweaker:get-independent-live-health", (event, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-independent-live-health");
  if (!derivedVariant || !isExactIndependentTweakersPrimaryMainFrame(event.sender, event.senderFrame)) return null;
  return independentTweakersLiveHealthProjection(independentTweakersLiveHealth);
});

// The native runtime owns the file chooser. Renderer code receives only the
// verified status/result, never an arbitrary filesystem path to validate.
ipcMain.handle("tweaker:choose-alpha-environment", async (event, ...args: unknown[]) => {
  assertNoIpcArguments(args, "choose-alpha-environment");
  if (derivedVariant) return derivedVariantActionBlocked("choose-alpha-environment");
  const owner = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
  const dialogOptions: OpenDialogOptions = {
    title: "Choose OpenAI Beta app",
    properties: ["openDirectory"],
  };
  const picked = owner
    ? await dialog.showOpenDialog(owner, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (picked.canceled || picked.filePaths.length !== 1) return { canceled: true };
  return runInstalledCliJson([
    "environment",
    "register-alpha",
    "--app-path",
    picked.filePaths[0],
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:get-environment-transaction", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-environment-transaction");
  if (derivedVariant) return derivedVariantActionBlocked("get-environment-transaction");
  const transaction = await runInstalledCliJson(
    ["environment", "transaction", "--json"],
    ENVIRONMENT_ACTION_TIMEOUT_MS,
  );
  return attachEnvironmentHelperDiagnostics(transaction);
});

ipcMain.handle("tweaker:prepare-environment", async (_e, payload: unknown) => {
  if (derivedVariant) return derivedVariantActionBlocked("prepare-environment");
  assertEnvironmentRequest(payload);
  await buildDevelopmentEnvironmentControlPlane();
  if (payload.appExperience === "tweakers" && payload.releaseProfile === "alpha") {
    await ensureManagedAlphaEnvironmentBackend();
  }
  return runInstalledCliJson([
    "environment",
    "prepare",
    "--app-experience",
    payload.appExperience,
    "--release-profile",
    payload.releaseProfile,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

ipcMain.handle("tweaker:commit-environment", async (_e, payload: unknown) => {
  if (derivedVariant) return derivedVariantActionBlocked("commit-environment");
  assertEnvironmentCommitRequest(payload);
  return runInstalledCliJson([
    "environment",
    "submit",
    "--transaction",
    payload.transactionId,
    "--approval-at",
    payload.approvalAt,
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:cancel-environment", async (_e, payload: unknown) => {
  if (derivedVariant) return derivedVariantActionBlocked("cancel-environment");
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "cancel",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_ACTION_TIMEOUT_MS);
});

ipcMain.handle("tweaker:rollback-environment", async (_e, payload: unknown) => {
  if (derivedVariant) return derivedVariantActionBlocked("rollback-environment");
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "rollback",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

// Recovery resolves a stranded receipt from live proof without replacing any
// bytes, so it is the safe action to offer in the UI; rollback stays available
// for callers that specifically want the recorded payload restored.
ipcMain.handle("tweaker:recover-environment", async (_e, payload: unknown) => {
  if (derivedVariant) return derivedVariantActionBlocked("recover-environment");
  assertEnvironmentTransactionRequest(payload);
  return runInstalledCliJson([
    "environment",
    "recover",
    "--transaction",
    payload.transactionId,
    "--json",
  ], ENVIRONMENT_PREPARE_TIMEOUT_MS);
});

ipcMain.handle("tweaker:get-config", () => {
  const s = readState();
  const installerState = readInstallerState();
  const sourceRoot = installerState?.sourceRoot ?? fallbackSourceRoot();
  return {
    version: TWEAKER_VERSION,
    autoUpdate: s.tweaker?.autoUpdate !== false,
    safeMode: s.tweaker?.safeMode === true,
    updateChannel: s.tweaker?.updateChannel ?? "stable",
    updateRepo: s.tweaker?.updateRepo ?? TWEAKER_REPO,
    updateRef: s.tweaker?.updateRef ?? "",
    updateCheck: s.tweaker?.updateCheck ?? null,
    selfUpdate: readSelfUpdateState(),
    installationSource: describeInstallationSource(sourceRoot),
  };
});

ipcMain.handle("tweaker:set-auto-update", (_e, enabled: boolean) => {
  if (derivedVariant) return derivedVariantActionBlocked("set-auto-update");
  setTweakerAutoUpdate(!!enabled);
  return { autoUpdate: isTweakerAutoUpdateEnabled() };
});

ipcMain.handle("tweaker:set-update-config", (_e, config: {
  updateChannel?: SelfUpdateChannel;
  updateRepo?: string;
  updateRef?: string;
}) => {
  if (derivedVariant) return derivedVariantActionBlocked("set-update-config");
  setTweakerUpdateConfig(config);
  const s = readState();
  return {
    updateChannel: s.tweaker?.updateChannel ?? "stable",
    updateRepo: s.tweaker?.updateRepo ?? TWEAKER_REPO,
    updateRef: s.tweaker?.updateRef ?? "",
  };
});

ipcMain.handle("tweaker:check-tweaker-update", async (_e, force?: boolean) => {
  if (derivedVariant) return derivedVariantTweakerUpdateCheck();
  return ensureTweakerUpdateCheck(force === true);
});

ipcMain.handle("tweaker:run-tweaker-update", async () => {
  if (derivedVariant) return derivedVariantActionBlocked("run-tweaker-update");
  const sourceRoot = readInstallerState()?.sourceRoot ?? fallbackSourceRoot();
  if (!sourceRoot) {
    throw new Error("Tweakers source CLI was not found. Run the installer once, then try again.");
  }
  const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
  if (!existsSync(cli)) {
    throw new Error("Tweakers source CLI was not found. Run the installer once, then try again.");
  }
  const pending = markSelfUpdateStarted(sourceRoot);
  startInstalledCli(cli, ["update", "--watcher"]);
  return pending;
});

ipcMain.handle("tweaker:get-refresh-status", () => localRefreshStatus());
ipcMain.handle("tweaker:start-local-refresh", async (_e, requested?: "smart" | "development" | "stable") => (
  startLocalRefresh(requested)
));

ipcMain.handle("tweaker:get-watcher-health", () => {
  if (derivedVariant) {
    return {
      checkedAt: new Date().toISOString(),
      status: "warn",
      title: "Automatic maintenance unavailable",
      summary: DERIVED_VARIANT_ACTION_DISABLED_REASON,
      watcher: "Unavailable",
      checks: [],
    };
  }
  return getAndPublishWatcherHealth(userRoot!);
});
ipcMain.handle("tweaker:get-runtime-fingerprint", (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "get-runtime-fingerprint");
  const installedRuntimeFingerprint =
    readRuntimeFingerprintEvidence(runtimeDir!)?.fingerprint ?? null;
  const sourceRoot = readInstallerState()?.sourceRoot ?? fallbackSourceRoot();
  const sourceRuntimeFingerprint = sourceRoot
    ? readRuntimeFingerprintEvidence(
      join(sourceRoot, "packages", "installer", "assets", "runtime"),
    )?.fingerprint ?? null
    : null;
  return {
    installedRuntimeFingerprint,
    sourceRuntimeFingerprint,
    runtimeFingerprintDrift:
      installedRuntimeFingerprint !== null
      && sourceRuntimeFingerprint !== null
      && installedRuntimeFingerprint !== sourceRuntimeFingerprint,
  };
});
ipcMain.handle("tweaker:repair-auto-maintenance", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "repair-auto-maintenance");
  if (derivedVariant) return derivedVariantActionBlocked("repair-auto-maintenance");
  const cli = localRefreshCli();
  if (!existsSync(cli)) throw new Error("Tweakers maintenance CLI is unavailable");
  startInstalledCli(cli, ["watcher-run"]);
  return { started: true, checkedAt: new Date().toISOString() };
});
ipcMain.handle("tweaker:get-mcp-sync-state", () => mcpReconciler?.readState() ?? null);
ipcMain.handle("tweaker:repair-mcp", async (_e, ...args: unknown[]) => {
  assertNoIpcArguments(args, "repair-mcp");
  if (derivedVariant) return derivedVariantActionBlocked("repair-mcp");
  if (!mcpReconciler) throw new Error("MCP repair is unavailable during a health-only probe");
  return mcpReconciler.reconcileNow("manual-repair");
});

ipcMain.handle("tweaker:get-tweak-store", async () => {
  const store = await fetchTweakStoreRegistry();
  const registry = store.registry;
  const installed = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const entries = shuffleStoreEntries(registry.entries, randomInt);
  return {
    ...registry,
    sourceUrl: TWEAK_STORE_INDEX_URL,
    fetchedAt: store.fetchedAt,
    entries: entries.map((entry) => {
      const local = installed.get(entry.id);
      const platform = storeEntryPlatformCompatibility(entry);
      const runtime = storeEntryRuntimeCompatibility(entry);
      return {
        ...entry,
        platform,
        runtime,
        installed: local
          ? {
              version: local.manifest.version,
              enabled: isTweakEnabled(local.manifest.id),
            }
          : null,
      };
    }),
  };
});

ipcMain.handle("tweaker:install-store-tweak", async (_e, id: string) => {
  const { registry } = await fetchTweakStoreRegistry();
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Tweak store entry not found: ${id}`);
  if (entry.available === false && !isBundledStoreEntry(entry)) {
    throw new Error(`${entry.manifest.name} is catalog metadata only and is not installable yet.`);
  }
  assertStoreEntryPlatformCompatible(entry);
  assertStoreEntryRuntimeCompatible(entry);
  await installStoreTweak(entry);
  await reloadTweaks("store-install", tweakLifecycleDeps);
  return { installed: entry.id };
});

ipcMain.handle("tweaker:prepare-tweak-store-submission", async (_e, repoInput: string) => {
  return prepareTweakStoreSubmission(repoInput);
});

// Sandboxed renderer preload can't use Node fs to read tweak source. Main
// reads it on the renderer's behalf. Path must live under tweaksDir for
// security — we refuse anything else.
ipcMain.handle("tweaker:read-tweak-source", (_e, entryPath: string) => {
  const resolved = resolve(entryPath);
  if (!isPathInside(TWEAKS_DIR, resolved)) {
    throw new Error("path outside tweaks dir");
  }
  return require("node:fs").readFileSync(resolved, "utf8");
});

/**
 * Read an arbitrary asset file from inside a tweak's directory and return it
 * as a `data:` URL. Used by the settings injector to render manifest icons
 * (the renderer is sandboxed; `file://` won't load).
 *
 * Security: caller passes `tweakDir` and `relPath`; we (1) require tweakDir
 * to live under TWEAKS_DIR, (2) resolve relPath against it and re-check the
 * result still lives under TWEAKS_DIR, (3) cap output size at 1 MiB.
 */
const ASSET_MAX_BYTES = 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
ipcMain.handle(
  "tweaker:read-tweak-asset",
  (_e, tweakDir: string, relPath: string) => {
    const fs = require("node:fs") as typeof import("node:fs");
    const dir = resolve(tweakDir);
    if (!isPathInside(TWEAKS_DIR, dir)) {
      throw new Error("tweakDir outside tweaks dir");
    }
    const full = resolve(dir, relPath);
    if (!isPathInside(dir, full) || full === dir) {
      throw new Error("path traversal");
    }
    const stat = fs.statSync(full);
    if (stat.size > ASSET_MAX_BYTES) {
      throw new Error(`asset too large (${stat.size} > ${ASSET_MAX_BYTES})`);
    }
    const ext = full.slice(full.lastIndexOf(".")).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const buf = fs.readFileSync(full);
    return `data:${mime};base64,${buf.toString("base64")}`;
  },
);

// Sandboxed preload can't write logs to disk; forward to us via IPC.
ipcMain.on("tweaker:preload-log", (_e, level: "info" | "warn" | "error", msg: string) => {
  const lvl = level === "error" || level === "warn" ? level : "info";
  try {
    appendCappedLog(join(LOG_DIR, "preload.log"), `[${new Date().toISOString()}] [${lvl}] ${msg}\n`);
  } catch {}
});

// Sandbox-safe filesystem ops for renderer-scope tweaks. Each tweak gets
// a sandboxed dir under userRoot/tweak-data/<id>. Renderer side calls these
// over IPC instead of using Node fs directly.
ipcMain.handle("tweaker:tweak-fs", (_e, op: string, id: string, p: string, c?: string) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error("bad tweak id");
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const full = resolve(dir, p);
  if (!isPathInside(dir, full) || full === dir) throw new Error("path traversal");
  const fs = require("node:fs") as typeof import("node:fs");
  switch (op) {
    case "read": return fs.readFileSync(full, "utf8");
    case "write": return fs.writeFileSync(full, c ?? "", "utf8");
    case "exists": return fs.existsSync(full);
    case "dataDir": return dir;
    default: throw new Error(`unknown op: ${op}`);
  }
});

ipcMain.handle("tweaker:user-paths", () => ({
  userRoot,
  runtimeDir,
  tweaksDir: TWEAKS_DIR,
  logDir: LOG_DIR,
}));

ipcMain.handle("tweaker:codex-runtime-info", () => currentRuntimeInfo());
ipcMain.handle("tweaker:codex-runtime-capabilities", () => currentRuntimeCapabilities());
ipcMain.handle("tweaker:codex-cdp-status", () => getCdpStatus());
ipcMain.handle("tweaker:codex-cdp-targets", () => listCdpTargets());
ipcMain.handle("tweaker:codex-window-create", (_e, opts: CodexCreateWindowOptions) => {
  return createCodexWindow(opts);
});
ipcMain.handle("tweaker:codex-window-primary", () => getPrimaryCodexWindowRef());
ipcMain.handle("tweaker:codex-window-focus", (_e, windowId: number) => focusCodexWindow(windowId));
ipcMain.handle("tweaker:codex-window-show", (_e, windowId: number) => showCodexWindow(windowId));
ipcMain.handle(
  "tweaker:codex-view-create",
  async (_e, tweakId: string, options: CodexViewCreateOptions) => {
    const tweak = assertTweakViewPermissionForId(tweakId);
    const ref = await createOwlView({ id: tweak.manifest.id, dir: tweak.dir }, options);
    return {
      id: ref.id,
      webContentsId: ref.webContentsId,
      parentWindowId: ref.parentWindowId,
    };
  },
);
ipcMain.handle(
  "tweaker:codex-view-call",
  (_e, tweakId: string, viewId: string, method: string, arg?: unknown, arg2?: unknown) => {
    assertTweakViewPermissionForId(tweakId);
    return callOwlView(tweakId, viewId, method, arg, arg2);
  },
);
ipcMain.handle("tweaker:codex-view-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  disposeOwlViewsForTweak(tweakId);
});
ipcMain.handle(
  "tweaker:native-load-module",
  (_e, tweakId: string, options: NativeModuleLoadOptions) => {
    const ref = nativeBridge.loadModule(tweakContext(tweakId, "native-module"), options);
    return { id: ref.id, kind: ref.kind };
  },
);
ipcMain.handle(
  "tweaker:native-module-request",
  (_e, tweakId: string, moduleId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-module");
    return nativeBridge.requestModule(tweakId, moduleId, method, payload, timeoutMs);
  },
);
ipcMain.handle("tweaker:native-module-dispose", (_e, tweakId: string, moduleId: string) => {
  assertTweakPermissionForId(tweakId, "native-module");
  return nativeBridge.disposeModule(tweakId, moduleId);
});
ipcMain.handle("tweaker:native-dispose-tweak", (_e, tweakId: string) => {
  assertTweakId(tweakId);
  nativeBridge.disposeTweak(tweakId);
});
ipcMain.handle(
  "tweaker:native-create-panel",
  async (_e, tweakId: string, options: NativePanelCreateOptions) => {
    const ref = await nativeBridge.createPanel(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id, windowId: ref.windowId };
  },
);
ipcMain.handle(
  "tweaker:native-attach-view",
  async (_e, tweakId: string, options: NativeViewAttachOptions) => {
    const ref = await nativeBridge.attachView(tweakContext(tweakId, "native-view"), options);
    return { id: ref.id };
  },
);
ipcMain.handle(
  "tweaker:native-instance-call",
  async (_e, tweakId: string, kind: "panel" | "view", instanceId: string, method: string, arg?: unknown) => {
    assertTweakPermissionForId(tweakId, "native-view");
    return nativeBridge.callInstance(tweakId, kind, instanceId, method, arg);
  },
);
ipcMain.handle(
  "tweaker:native-launch-helper",
  (_e, tweakId: string, options: NativeHelperLaunchOptions) => {
    const ref = nativeBridge.launchHelper(tweakContext(tweakId, "native-helper"), options);
    return { id: ref.id, pid: ref.pid };
  },
);
ipcMain.handle(
  "tweaker:native-helper-call",
  (_e, tweakId: string, helperId: string, method: string, payload?: unknown, timeoutMs?: number) => {
    assertTweakPermissionForId(tweakId, "native-helper");
    return nativeBridge.callHelper(tweakId, helperId, method, payload, timeoutMs);
  },
);

ipcMain.handle("tweaker:reveal", (_e, p: string) => {
  shell.openPath(p).catch(() => {});
});

ipcMain.handle("tweaker:open-external", (_e, url: string) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    throw new Error("only github.com links can be opened from tweak metadata");
  }
  shell.openExternal(parsed.toString()).catch(() => {});
});

ipcMain.handle("tweaker:copy-text", (_e, text: string) => {
  clipboard.writeText(String(text));
  return true;
});

// Manual force-reload trigger from the renderer (e.g. the "Force Reload"
// button on our injected Tweaks page). Bypasses the watcher debounce.
ipcMain.handle("tweaker:reload-tweaks", async () => {
  await reloadTweaks("manual", tweakLifecycleDeps);
  return { at: Date.now(), count: tweakState.discovered.length };
});

// 4. Filesystem watcher → debounced reload + broadcast.
//    We watch the tweaks dir for any change. On the first tick of inactivity
//    we stop main-side tweaks, clear their cached modules, re-discover, then
//    restart and broadcast `tweaker:tweaks-changed` to every renderer so it
//    can re-init its host.
const RELOAD_DEBOUNCE_MS = 250;
const DEV_PUBLISH_LOCK = join(TWEAKS_DIR, ".tweaker-dev-publishing");
const DEV_PUBLISH_LOCK_MAX_AGE_MS = 5 * 60 * 1000;
let reloadTimer: NodeJS.Timeout | null = null;
function scheduleReload(reason: string): void {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void reloadTweaks(reason, tweakLifecycleDeps).catch((error) => {
      log("error", "failed to reload tweaks:", error);
    });
  }, RELOAD_DEBOUNCE_MS);
}

function devPublicationInProgress(): boolean {
  try {
    return Date.now() - statSync(DEV_PUBLISH_LOCK).mtimeMs < DEV_PUBLISH_LOCK_MAX_AGE_MS;
  } catch { return false; }
}

try {
  const watcher = chokidar.watch(TWEAKS_DIR, {
    ignoreInitial: true,
    // Wait for files to settle before triggering — guards against partially
    // written tweak files during editor saves / git checkouts.
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    // Avoid eating CPU on huge node_modules trees inside tweak folders.
    ignored: (p) => p.includes(`${TWEAKS_DIR}/`) && /\/node_modules\//.test(p),
  });
  watcher.on("all", (event, path) => {
    if (devPublicationInProgress()) return;
    scheduleReload(`${event} ${path}`);
  });
  watcher.on("error", (e) => log("warn", "watcher error:", e));
  log("info", "watching", TWEAKS_DIR);
  app.on("will-quit", () => watcher.close().catch(() => {}));
} catch (e) {
  log("error", "failed to start watcher:", e);
}

// --- helpers ---

async function loadAllMainTweaks(): Promise<void> {
  if (healthCheckOnly) return;
  const startupPromises: Promise<void>[] = [];
  try {
    tweakState.discovered = discoverTweaks(TWEAKS_DIR);
    log(
      "info",
      `discovered ${tweakState.discovered.length} tweak(s):`,
      tweakState.discovered.map((t) => t.manifest.id).join(", "),
    );
  } catch (e) {
    log("error", "tweak discovery failed:", e);
    tweakState.discovered = [];
  }

  const mcpTrigger: McpSyncTrigger = initialMcpReconciliationPending
    ? "startup"
    : nextReloadMcpTrigger;
  initialMcpReconciliationPending = false;
  nextReloadMcpTrigger = "tweak-reload";
  if (mcpReconciler) {
    try {
      await mcpReconciler.reconcileNow(mcpTrigger);
    } catch (error) {
      log("error", "MCP reconciliation failed before main tweak startup:", error);
    }
  }

  for (const t of tweakState.discovered) {
    if (!isMainProcessTweakScope(t.manifest.scope)) continue;
    if (!isTweakEnabled(t.manifest.id)) {
      recordTweakLifecycle(t.manifest.id, "main", isTweakQuarantined(t.manifest.id) ? "quarantined" : "disabled");
      log("info", `skipping disabled main tweak: ${t.manifest.id}`);
      continue;
    }
    recordTweakLifecycle(t.manifest.id, "main", "starting");
    try {
      const mod = require(t.entry);
      const tweak = mod.default ?? mod;
      if (typeof tweak?.start === "function") {
        const storage = createDiskStorage(userRoot!, t.manifest.id);
        const startResult = tweak.start({
          manifest: t.manifest,
          process: "main",
          log: makeLogger(t.manifest.id),
          storage,
          ipc: makeMainIpc(t),
          fs: makeMainFs(t.manifest.id),
          codex: makeCodexApi(t),
        });
        tweakState.loadedMain.set(t.manifest.id, {
          // Bind stop() to the tweak object so main-scope cleanup that relies on
          // `this` works — mirrors the renderer host (preload/tweak-host.ts).
          stop: bindMainTweakStop(tweak),
          storage,
        });
        const startup = runWithStartupTimeout(() => startResult, lifecycleStartupTimeoutMs()).then((result) => {
          if (result.status === "timed_out") {
            recordTweakLifecycle(t.manifest.id, "main", "timed_out", `startup exceeded ${lifecycleStartupTimeoutMs()}ms`);
            log("error", `tweak ${t.manifest.id} startup timed out`);
            return;
          }
          recordTweakLifecycle(t.manifest.id, "main", "ready");
          log("info", `started main tweak: ${t.manifest.id}`);
        }).catch((error) => {
          recordTweakLifecycle(t.manifest.id, "main", "failed", error);
          log("error", `tweak ${t.manifest.id} failed to start:`, error);
        });
        startupPromises.push(startup);
      } else {
        recordTweakLifecycle(t.manifest.id, "main", "failed", "tweak has no start() function");
      }
    } catch (e) {
      recordTweakLifecycle(t.manifest.id, "main", "failed", e);
      recordTweakHealth(t.manifest.id, "failed", e instanceof Error ? e.message : e);
      log("error", `tweak ${t.manifest.id} failed to start:`, e);
    }
  }
  await Promise.all(startupPromises);
  runtimeReadyMainInitialized = true;
  tryWriteRuntimeReadyReceipt();
}

function stopAllMainTweaks(): void {
  for (const [id, t] of tweakState.loadedMain) {
    try {
      t.stop?.();
      t.storage.flush();
      log("info", `stopped main tweak: ${id}`);
    } catch (e) {
      log("warn", `stop failed for ${id}:`, e);
    } finally {
      nativeBridge.disposeTweak(id);
      disposeOwlViewsForTweak(id);
    }
  }
  tweakState.loadedMain.clear();
}

function clearTweakModuleCache(): void {
  const rootSet = new Set<string>([TWEAKS_DIR, safeRealpath(TWEAKS_DIR)]);
  const entrySet = new Set<string>();
  for (const tweak of tweakState.discovered) {
    rootSet.add(tweak.dir);
    rootSet.add(safeRealpath(tweak.dir));
    entrySet.add(tweak.entry);
    entrySet.add(safeRealpath(tweak.entry));
  }

  const roots = [...rootSet];
  for (const key of Object.keys(require.cache)) {
    const realKey = safeRealpath(key);
    const isTweakModule =
      entrySet.has(key) ||
      entrySet.has(realKey) ||
      roots.some((root) => isPathInside(root, key) || isPathInside(root, realKey));
    if (isTweakModule) delete require.cache[key];
  }
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

async function ensureTweakerUpdateCheck(force = false): Promise<TweakerUpdateCheck> {
  if (derivedVariant) return derivedVariantTweakerUpdateCheck();
  const state = readState();
  const cached = state.tweaker?.updateCheck;
  const channel = state.tweaker?.updateChannel ?? "stable";
  const repo = state.tweaker?.updateRepo ?? TWEAKER_REPO;
  if (
    !force &&
    cached &&
    cached.currentVersion === TWEAKER_VERSION &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return cached;
  }

  const release = await fetchLatestRelease(repo, TWEAKER_VERSION, channel === "prerelease");
  const latestVersion = release.latestTag ? normalizeVersion(release.latestTag) : null;
  const check: TweakerUpdateCheck = {
    checkedAt: new Date().toISOString(),
    currentVersion: TWEAKER_VERSION,
    latestVersion,
    releaseUrl: release.releaseUrl ?? `https://github.com/${repo}/releases`,
    releaseNotes: release.releaseNotes,
    updateAvailable: latestVersion
      ? compareVersions(normalizeVersion(latestVersion), TWEAKER_VERSION) > 0
      : false,
    ...(release.error ? { error: release.error } : {}),
  };
  state.tweaker ??= {};
  state.tweaker.updateCheck = check;
  writeState(state);
  return check;
}

async function ensureTweakUpdateCheck(t: DiscoveredTweak): Promise<void> {
  const id = t.manifest.id;
  const repo = t.manifest.githubRepo;
  const state = readState();
  const cached = state.tweakUpdateChecks?.[id];
  if (
    cached &&
    cached.repo === repo &&
    cached.currentVersion === t.manifest.version &&
    Date.now() - Date.parse(cached.checkedAt) < UPDATE_CHECK_INTERVAL_MS
  ) {
    return;
  }

  const next = await fetchLatestRelease(repo, t.manifest.version);
  const latestVersion = next.latestTag ? normalizeVersion(next.latestTag) : null;
  const check: TweakUpdateCheck = {
    checkedAt: new Date().toISOString(),
    repo,
    currentVersion: t.manifest.version,
    latestVersion,
    latestTag: next.latestTag,
    releaseUrl: next.releaseUrl,
    updateAvailable: latestVersion
      ? compareVersions(latestVersion, normalizeVersion(t.manifest.version)) > 0
      : false,
    ...(next.error ? { error: next.error } : {}),
  };
  state.tweakUpdateChecks ??= {};
  state.tweakUpdateChecks[id] = check;
  writeState(state);
}

async function fetchLatestRelease(
  repo: string,
  currentVersion: string,
  includePrerelease = false,
): Promise<{ latestTag: string | null; releaseUrl: string | null; releaseNotes: string | null; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const endpoint = includePrerelease ? "releases?per_page=20" : "releases/latest";
      const res = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
        headers: {
          "Accept": "application/vnd.github+json",
          "User-Agent": `tweaker/${currentVersion}`,
        },
        signal: controller.signal,
      });
      if (res.status === 404) {
        return { latestTag: `v${currentVersion}`, releaseUrl: null, releaseNotes: null };
      }
      if (!res.ok) {
        return { latestTag: null, releaseUrl: null, releaseNotes: null, error: `GitHub returned ${res.status}` };
      }
      const json = await res.json() as { tag_name?: string; html_url?: string; body?: string; draft?: boolean } | Array<{ tag_name?: string; html_url?: string; body?: string; draft?: boolean }>;
      const body = Array.isArray(json) ? json.find((release) => !release.draft) : json;
      if (!body) {
        return { latestTag: `v${currentVersion}`, releaseUrl: null, releaseNotes: null };
      }
      return {
        latestTag: body.tag_name ?? null,
        releaseUrl: body.html_url ?? `https://github.com/${repo}/releases`,
        releaseNotes: body.body ?? null,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return {
      latestTag: null,
      releaseUrl: null,
      releaseNotes: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

interface TweakStoreFetchResult {
  registry: TweakStoreRegistry;
  fetchedAt: string;
}

/**
 * The installer copies the repository catalog beside the generated runtime.
 * It is the local source of truth for the nine v4 entries; the network
 * registry can enrich it, but may never add entries outside this catalog.
 */
function readBundledTweakCatalog(): TweakStoreRegistry | null {
  try {
    if (!existsSync(TWEAK_CATALOG_FILE)) return null;
    return normalizeStoreRegistry(JSON.parse(readFileSync(TWEAK_CATALOG_FILE, "utf8")));
  } catch (error) {
    log("warn", "failed to read bundled Tweakers catalog:", String(error));
    return null;
  }
}

function buildTweakHealthSnapshot(): TweakHealthSnapshot {
  const catalog = readBundledTweakCatalog();
  const catalogEntries = catalog?.entries ?? [];
  const discoveredById = new Map(tweakState.discovered.map((t) => [t.manifest.id, t]));
  const mcpState = mcpReconciler?.readState() as { restartRequired?: boolean } | null | undefined;
  const rows = catalogEntries.map((entry) => {
    const local = discoveredById.get(entry.id);
    const liveVersion = local?.manifest.version ?? readManifestVersion(join(TWEAKS_DIR, liveTweakFolder(entry), "manifest.json"));
    const runtimeVersion = readRuntimeTweakVersion(entry);
    const catalogVersion = entry.manifest.version ?? null;
    const liveMatches = liveVersion !== null && catalogVersion !== null && normalizeVersion(liveVersion) === normalizeVersion(catalogVersion);
    const runtimeMatches = runtimeVersion !== null && catalogVersion !== null && normalizeVersion(runtimeVersion) === normalizeVersion(catalogVersion);
    const hasMcp = Boolean((entry.manifest as TweakManifest & { mcp?: unknown }).mcp);
    const enabled = local ? isTweakEnabled(entry.id) : false;
    const status: TweakVersionDriftRow["status"] =
      liveVersion === null || runtimeVersion === null ? "missing" :
        liveMatches && runtimeMatches ? "current" : "drift";
    return {
      id: entry.id,
      name: entry.manifest.name,
      enabled,
      hasMcp,
      liveVersion,
      runtimeVersion,
      catalogVersion,
      status,
      reason: tweakVersionDriftReason({
        liveVersion,
        runtimeVersion,
        catalogVersion,
        liveMatches,
        runtimeMatches,
      }),
    };
  });
  const liveDriftCount = rows.filter((row) =>
    row.liveVersion !== null &&
    row.catalogVersion !== null &&
    normalizeVersion(row.liveVersion) !== normalizeVersion(row.catalogVersion)
  ).length;
  const runtimeDriftCount = rows.filter((row) =>
    row.runtimeVersion !== null &&
    row.catalogVersion !== null &&
    normalizeVersion(row.runtimeVersion) !== normalizeVersion(row.catalogVersion)
  ).length;
  return {
    checkedAt: new Date().toISOString(),
    catalogCount: catalogEntries.length,
    installedCount: tweakState.discovered.length,
    enabledCount: tweakState.discovered.filter((t) => isTweakEnabled(t.manifest.id)).length,
    liveDriftCount,
    runtimeDriftCount,
    missingLiveCount: rows.filter((row) => row.liveVersion === null).length,
    missingRuntimeCount: rows.filter((row) => row.runtimeVersion === null).length,
    mcpRestartRequired: mcpState?.restartRequired === true,
    rows,
  };
}

function liveTweakFolder(entry: TweakStoreEntry): string {
  if (entry.source?.kind === "bundled") return entry.source.path.split("/").pop() ?? entry.id;
  return entry.id;
}

function readRuntimeTweakVersion(entry: TweakStoreEntry): string | null {
  if (entry.source?.kind !== "bundled") return null;
  try {
    return readManifestVersion(join(resolveBundledTweakPath(runtimeDir!, entry), "manifest.json"));
  } catch {
    return null;
  }
}

function readManifestVersion(manifestPath: string): string | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<TweakManifest>;
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function tweakVersionDriftReason(input: {
  liveVersion: string | null;
  runtimeVersion: string | null;
  catalogVersion: string | null;
  liveMatches: boolean;
  runtimeMatches: boolean;
}): string {
  if (!input.catalogVersion) return "No catalog version is available.";
  if (!input.liveVersion) return "Live installed copy is missing.";
  if (!input.runtimeVersion) return "Bundled runtime copy is missing.";
  const stale: string[] = [];
  if (!input.liveMatches) stale.push(`live ${input.liveVersion}`);
  if (!input.runtimeMatches) stale.push(`runtime ${input.runtimeVersion}`);
  if (stale.length) return `${stale.join(" and ")} differs from latest stored ${input.catalogVersion}.`;
  return "Live and runtime copies match the latest stored version.";
}

function restrictRegistryToBundledCatalog(registry: TweakStoreRegistry): TweakStoreRegistry {
  const bundled = readBundledTweakCatalog();
  if (!bundled || bundled.entries.length === 0) return registry;
  const remote = new Map(registry.entries.map((entry) => [entry.id, entry]));
  return {
    ...bundled,
    // Prefer the bundled manifest/availability metadata. A remote entry may
    // only provide approved coordinates for an already-known catalog id.
    entries: bundled.entries.map((entry) => {
      const update = remote.get(entry.id);
      // Packaged entries are self-contained and must not be replaced by a
      // network response that silently turns them into an unpinned archive.
      return isBundledStoreEntry(entry) || entry.available === false ? entry : update ?? entry;
    }),
  };
}

interface StoreInstallMetadata {
  repo?: string;
  approvedCommitSha?: string;
  source?: { kind: "bundled" | "remote"; path?: string };
  installedAt: string;
  storeIndexUrl: string;
  files?: Record<string, string>;
}

interface StoreEntryPlatformCompatibility {
  current: NodeJS.Platform;
  supported: TweakStorePlatform[] | null;
  compatible: boolean;
  reason: string | null;
}

interface StoreEntryRuntimeCompatibility {
  current: string;
  required: string | null;
  compatible: boolean;
  reason: string | null;
}

class StoreTweakModifiedError extends Error {
  constructor(tweakName: string) {
    super(
      `${tweakName} has local source changes, so Tweakers can't auto-update it. Revert your local changes or reinstall the tweak manually.`,
    );
    this.name = "StoreTweakModifiedError";
  }
}

function storeEntryPlatformCompatibility(entry: TweakStoreEntry): StoreEntryPlatformCompatibility {
  const supported = entry.platforms ?? null;
  const compatible = !supported || supported.includes(process.platform as TweakStorePlatform);
  return {
    current: process.platform,
    supported,
    compatible,
    reason: compatible ? null : `${entry.manifest.name} is only available on ${formatStorePlatforms(supported)}.`,
  };
}

function assertStoreEntryPlatformCompatible(entry: TweakStoreEntry): void {
  const platform = storeEntryPlatformCompatibility(entry);
  if (!platform.compatible) {
    throw new Error(platform.reason ?? `${entry.manifest.name} is not available on this platform.`);
  }
}

function storeEntryRuntimeCompatibility(entry: TweakStoreEntry): StoreEntryRuntimeCompatibility {
  const required = cleanMinRuntime(entry.manifest.minRuntime);
  const compatible = !required || compareVersions(TWEAKER_VERSION, required) >= 0;
  return {
    current: TWEAKER_VERSION,
    required,
    compatible,
    reason: compatible || !required
      ? null
      : `${entry.manifest.name} requires Tweakers ${required} or newer.`,
  };
}

function assertStoreEntryRuntimeCompatible(entry: TweakStoreEntry): void {
  const runtime = storeEntryRuntimeCompatibility(entry);
  if (!runtime.compatible) {
    throw new Error(runtime.reason ?? `${entry.manifest.name} requires a newer Tweakers runtime.`);
  }
}

function cleanMinRuntime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = normalizeVersion(value.replace(/^>=?\s*/, ""));
  return VERSION_RE.test(version) ? version : null;
}

function formatStorePlatforms(platforms: TweakStorePlatform[] | null): string {
  if (!platforms || platforms.length === 0) return "supported platforms";
  return platforms.map((platform) => {
    if (platform === "darwin") return "macOS";
    if (platform === "win32") return "Windows";
    return "Linux";
  }).join(", ");
}

async function fetchTweakStoreRegistry(): Promise<TweakStoreFetchResult> {
  const fetchedAt = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(TWEAK_STORE_INDEX_URL, {
        headers: {
          "Accept": "application/json",
          "User-Agent": `tweaker/${TWEAKER_VERSION}`,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`store returned ${res.status}`);
      return {
        registry: restrictRegistryToBundledCatalog(normalizeStoreRegistry(await res.json())),
        fetchedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    // The hosted registry 404s while the repo/Pages is private; the bundled
    // catalog covers that. One warn per process, not one per launch fetch.
    if (!warnedStoreRegistryFetch) {
      warnedStoreRegistryFetch = true;
      log("warn", "failed to fetch tweak store registry (using bundled catalog):", error.message);
    }
    const fallback = readBundledTweakCatalog();
    if (fallback) return { registry: fallback, fetchedAt };
    throw error;
  }
}
let warnedStoreRegistryFetch = false;

async function installStoreTweak(entry: TweakStoreEntry): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "tweaker-store-tweak-"));
  const archive = join(work, "source.tar.gz");
  const extractDir = join(work, "extract");
  const target = join(TWEAKS_DIR, entry.id);
  const stagedTarget = join(work, "staged", entry.id);

  try {
    let source: string;
    if (entry.source?.kind === "bundled") {
      // The catalog path is constrained to `tweaks/<id>` by normalization;
      // resolving it here keeps traversal and cross-entry installs closed.
      const bundledPath = entry.source.path;
      if (typeof bundledPath !== "string") throw new Error(`bundled source for ${entry.id} is missing a path`);
      source = resolveBundledTweakPath(runtimeDir!, { ...entry, source: { kind: "bundled", path: bundledPath as string } });
      if (!existsSync(source) || !statSync(source).isDirectory()) {
        throw new Error(`bundled source for ${entry.id} is missing from the installer runtime`);
      }
      log("info", `installing bundled tweak ${entry.id} from ${source}`);
    } else {
      const url = storeArchiveUrl(entry);
      log("info", `installing store tweak ${entry.id} from ${entry.repo ?? "(unknown)"}@${entry.approvedCommitSha ?? "(unknown)"}`);
      const res = await fetch(url, {
        headers: { "User-Agent": `tweaker/${TWEAKER_VERSION}` },
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
          storeIndexUrl: TWEAK_STORE_INDEX_URL,
          files: stagedFiles,
        },
        null,
        2,
      ),
    );
    await assertStoreTweakCleanForAutoUpdate(entry, target, work);
    rmSync(target, { recursive: true, force: true });
    cpSync(stagedTarget, target, { recursive: true });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function prepareTweakStoreSubmission(repoInput: string): Promise<TweakStorePublishSubmission> {
  const repo = normalizeGitHubRepo(repoInput);
  const repoInfo = await fetchGithubJson<{ default_branch?: string }>(`https://api.github.com/repos/${repo}`);
  const defaultBranch = repoInfo.default_branch;
  if (!defaultBranch) throw new Error(`Could not resolve default branch for ${repo}`);

  const commit = await fetchGithubJson<{
    sha?: string;
    html_url?: string;
  }>(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(defaultBranch)}`);
  if (!commit.sha) throw new Error(`Could not resolve current commit for ${repo}`);

  const manifest = await fetchManifestAtCommit(repo, commit.sha).catch((e) => {
    log("warn", `could not read manifest for store submission ${repo}@${commit.sha}:`, e);
    return undefined;
  });

  return {
    repo,
    defaultBranch,
    commitSha: commit.sha,
    commitUrl: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}`,
    manifest: manifest
      ? {
          id: typeof manifest.id === "string" ? manifest.id : undefined,
          name: typeof manifest.name === "string" ? manifest.name : undefined,
          version: typeof manifest.version === "string" ? manifest.version : undefined,
          description: typeof manifest.description === "string" ? manifest.description : undefined,
          iconUrl: typeof manifest.iconUrl === "string" ? manifest.iconUrl : undefined,
        }
      : undefined,
  };
}

async function fetchGithubJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `tweaker/${TWEAKER_VERSION}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchManifestAtCommit(repo: string, commitSha: string): Promise<Partial<TweakManifest>> {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${commitSha}/manifest.json`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": `tweaker/${TWEAKER_VERSION}`,
    },
  });
  if (!res.ok) throw new Error(`manifest fetch returned ${res.status}`);
  return await res.json() as Partial<TweakManifest>;
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

function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void {
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

async function assertStoreTweakCleanForAutoUpdate(
  entry: TweakStoreEntry,
  target: string,
  work: string,
): Promise<void> {
  if (!existsSync(target)) return;
  const metadata = readStoreInstallMetadata(target);
  if (!metadata) return;
  if (metadata.repo !== entry.repo) {
    throw new StoreTweakModifiedError(entry.manifest.name);
  }
  const currentFiles = hashTweakSource(target);
  const baselineFiles = metadata.files ?? await fetchBaselineStoreTweakHashes(metadata, work);
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
): Promise<Record<string, string>> {
  if (!metadata.repo || !metadata.approvedCommitSha) {
    throw new Error("Could not verify local tweak changes before update: source baseline is not remote");
  }
  const baselineDir = join(work, "baseline");
  const archive = join(work, "baseline.tar.gz");
  const res = await fetch(`https://codeload.github.com/${metadata.repo}/tar.gz/${metadata.approvedCommitSha}`, {
    headers: { "User-Agent": `tweaker/${TWEAKER_VERSION}` },
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
    const stat = statSync(full);
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

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/i, "");
}

function compareVersions(a: string, b: string): number {
  const av = VERSION_RE.exec(a);
  const bv = VERSION_RE.exec(b);
  if (!av || !bv) return 0;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(av[i]) - Number(bv[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function fallbackSourceRoot(): string | null {
  const candidates = [
    join(homedir(), ".tweaker", "source"),
    join(homedir(), `.${LEGACY_DATA_DIR}`, "source"),
    join(userRoot!, "source"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "packages", "installer", "dist", "cli.js"))) return candidate;
  }
  return null;
}

function describeInstallationSource(sourceRoot: string | null): InstallationSource {
  if (!sourceRoot) {
    return {
      kind: "unknown",
      label: "Unknown",
      detail: "Tweakers source location is not recorded yet.",
    };
  }
  const normalized = sourceRoot.replace(/\\/g, "/");
  if (/\/(?:Homebrew|homebrew)\/Cellar\/tweaker\//.test(normalized)
    || normalized.includes(`/${LEGACY_DATA_DIR.replace("-", "")}/`)) {
    return { kind: "homebrew", label: "Homebrew", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, ".git"))) {
    return { kind: "local-dev", label: "Local development checkout", detail: sourceRoot };
  }
  if (normalized.endsWith("/.tweaker/source")
    || normalized.includes("/.tweaker/source/")
    || normalized.endsWith(`/.${LEGACY_DATA_DIR}/source`)
    || normalized.includes(`/.${LEGACY_DATA_DIR}/source/`)) {
    return { kind: "github-source", label: "GitHub source installer", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, "package.json"))) {
    return { kind: "source-archive", label: "Source archive", detail: sourceRoot };
  }
  return { kind: "unknown", label: "Unknown", detail: sourceRoot };
}

function startInstalledCli(cli: string, args: string[]): void {
  if (derivedVariant) return;
  if (process.platform === "darwin" && startInstalledCliWithLaunchd(cli, args)) {
    return;
  }
  const runtime = localCliRuntime(cli, args);
  const child = spawn(runtime.command, runtime.args, {
    cwd: resolve(dirname(cli), "..", "..", ".."),
    env: { ...runtime.env, TWEAKER_MANUAL_UPDATE: "1", [LEGACY_MANUAL_UPDATE_ENV]: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function installedTweakersCli(status?: LocalRefreshStatusValue): string {
  void status;
  const cli = localRefreshCli();
  if (!existsSync(cli)) throw new Error("Tweakers installer CLI is unavailable");
  return cli;
}

let environmentDevelopmentBuildInFlight: Promise<void> | null = null;

async function buildDevelopmentEnvironmentControlPlane(): Promise<void> {
  const status = await localRefreshStatus();
  if (status.source !== "development" || !status.developmentSourceRoot) return;
  if (environmentDevelopmentBuildInFlight) return environmentDevelopmentBuildInFlight;
  const sourceRoot = realpathSync(status.developmentSourceRoot);
  const packageFile = join(sourceRoot, "package.json");
  if (!existsSync(packageFile)) {
    throw new Error("The registered Tweakers development checkout is unavailable");
  }
  environmentDevelopmentBuildInFlight = new Promise<void>((resolvePromise, rejectPromise) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, ["run", "build"], {
      cwd: sourceRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const capture = (chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      output = `${output}${chunk.toString()}`.slice(-8_000);
      if (outputBytes > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(() => rejectPromise(new Error("Tweakers development build output exceeded the limit")));
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (code, signal) => finish(() => {
      if (code !== 0) {
        rejectPromise(new Error(
          `Tweakers development build failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}`
          + `${output.trim() ? `: ${output.trim()}` : ""}`,
        ));
        return;
      }
      const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
      if (!existsSync(cli)) {
        rejectPromise(new Error("Tweakers development build did not produce its installer CLI"));
        return;
      }
      resolvePromise();
    }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectPromise(new Error("Tweakers development build timed out")));
    }, 10 * 60_000);
  }).finally(() => {
    environmentDevelopmentBuildInFlight = null;
  });
  return environmentDevelopmentBuildInFlight;
}

async function runInstalledCliJson(args: string[], timeoutMs = 10_000): Promise<unknown> {
  if (derivedVariant) return derivedVariantActionBlocked(args[0] ?? "command");
  const status = await localRefreshStatus();
  const cli = installedTweakersCli(status);
  const runtime = localCliRuntime(cli, args);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(runtime.command, runtime.args, {
      cwd: resolve(dirname(cli), "..", "..", ".."),
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > CLI_JSON_MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => rejectPromise(new Error(`Tweakers CLI output exceeded the limit for ${args[0] ?? "command"}`)));
        return;
      }
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => rejectPromise(new Error(`Tweakers CLI timed out while running ${args[0] ?? "command"}`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", (error) => finish(() => rejectPromise(error)));
    child.once("close", (code) => finish(() => {
      let parsed: unknown;
      let parseFailed = false;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        parseFailed = true;
      }
      if (code !== 0) {
        // A durable receipt on stdout is the diagnosis; the non-zero exit only
        // says the action did not reach its success phase. Keep the receipt so
        // the renderer can surface why, rather than a generic failure.
        if (!parseFailed) {
          resolvePromise(parsed);
          return;
        }
        rejectPromise(new Error(stderr.trim() || `Tweakers CLI exited with status ${code ?? "unknown"}`));
        return;
      }
      if (parseFailed) {
        rejectPromise(new Error(`Tweakers CLI returned invalid JSON for ${args[0] ?? "command"}`));
        return;
      }
      resolvePromise(parsed);
    }));
  });
}

function attachEnvironmentHelperDiagnostics(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const transaction = value as Record<string, unknown>;
  const transactionId = typeof transaction.transactionId === "string" ? transaction.transactionId : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(transactionId)) return value;
  const helperRoot = transaction.schemaVersion === 2
    ? join(userRoot!, "environment-cache", "generations", transactionId)
    : join(userRoot!, "transactions", "environment", transactionId);
  const label = `co.tweakers.environment.${transactionId}`;
  const readJson = (file: string): unknown => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  };
  const readLogTail = (file: string): string => {
    try {
      const contents = readFileSync(file, "utf8");
      return contents.slice(-16 * 1024);
    } catch {
      return "";
    }
  };
  const submission = readJson(join(helperRoot, "commit-helper.json")) as Record<string, unknown> | null;
  let outcome = readJson(join(helperRoot, `${label}.outcome.json`)) as Record<string, unknown> | null;
  const ENVIRONMENT_HELPER_STALE_MS = 60_000;
  if (submission && outcome && (outcome.phase === "not-started" || outcome.phase === "running")) {
    const reference = outcome.phase === "running" ? outcome.startedAt : submission.submittedAt;
    const referenceTime = typeof reference === "string" ? Date.parse(reference) : Number.NaN;
    if (!Number.isFinite(referenceTime) || Date.now() - referenceTime >= ENVIRONMENT_HELPER_STALE_MS) {
      outcome = {
        ...outcome,
        phase: "failed",
        finishedAt: new Date().toISOString(),
        error: outcome.phase === "running"
          ? "Environment helper stopped before reporting an outcome. Retry or roll back the prepared transaction."
          : "Environment helper did not start. Retry the prepared transaction.",
      };
    }
  }
  const stdout = readLogTail(join(helperRoot, `${label}.stdout.log`));
  const stderr = readLogTail(join(helperRoot, `${label}.stderr.log`));
  if (submission === null && outcome === null && stdout === "" && stderr === "") return value;
  return {
    ...transaction,
    helper: {
      submission,
      outcome,
      stdout,
      stderr,
    },
  };
}

interface LocalRefreshStatusValue {
  available: boolean;
  source: "development" | "stable" | "current";
  phase: string;
  developmentSourceRoot: string | null;
  detail: string;
  error: string | null;
  checkedAt: string;
}

function derivedVariantLocalRefreshStatus(): LocalRefreshStatusValue {
  return {
    available: false,
    source: "current",
    phase: "disabled",
    developmentSourceRoot: null,
    detail: DERIVED_VARIANT_ACTION_DISABLED_REASON,
    error: `derived-variant: ${DERIVED_VARIANT_ACTION_DISABLED_REASON}`,
    checkedAt: new Date().toISOString(),
  };
}

interface LocalRefreshSourceBinding {
  /** Exact CLI selected once for this runtime process. */
  cli: string;
  /** Exact real Git worktree root allowed to promote development bytes. */
  developmentRoot: string | null;
  unsafeReason: string | null;
}

interface LocalRefreshDispatch {
  cli: string;
  args: string[];
}

interface LocalRefreshStartResult {
  started: boolean;
  status: LocalRefreshStatusValue;
}

// Renderer tweaks poll refresh status on DOM mutations, so this must never
// block the main process (a synchronous CLI spawn here froze the UI on
// hover) and must never spawn the Electron binary as a full second app —
// ELECTRON_RUN_AS_NODE is mandatory. Cache + in-flight dedupe absorb bursts.
let refreshStatusCache: { value: LocalRefreshStatusValue; at: number } | null = null;
let refreshStatusInFlight: Promise<LocalRefreshStatusValue> | null = null;
const REFRESH_STATUS_TTL_MS = 4_000;
const LOCAL_REFRESH_SOURCE_BINDING = resolveLocalRefreshSourceBinding();

function localRefreshStatus(): Promise<LocalRefreshStatusValue> {
  if (derivedVariant) return Promise.resolve(derivedVariantLocalRefreshStatus());
  if (refreshStatusCache && Date.now() - refreshStatusCache.at < REFRESH_STATUS_TTL_MS) {
    return Promise.resolve(refreshStatusCache.value);
  }
  if (refreshStatusInFlight) return refreshStatusInFlight;
  refreshStatusInFlight = probeLocalRefreshStatus().then((value) => {
    refreshStatusCache = { value, at: Date.now() };
    return value;
  }).finally(() => { refreshStatusInFlight = null; });
  return refreshStatusInFlight;
}

function probeLocalRefreshStatus(): Promise<LocalRefreshStatusValue> {
  const cli = localRefreshCli();
  if (!existsSync(cli)) return Promise.resolve({
    available: false, source: "current", phase: "failed", developmentSourceRoot: null,
    detail: LOCAL_REFRESH_SOURCE_BINDING.unsafeReason ?? "Tweakers refresh CLI is unavailable",
    error: LOCAL_REFRESH_SOURCE_BINDING.unsafeReason ? `unsafe-source: ${LOCAL_REFRESH_SOURCE_BINDING.unsafeReason}` : "refresh CLI missing",
    checkedAt: new Date().toISOString(),
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const runtime = localCliRuntime(cli, ["refresh-status"]);
    const child = spawn(runtime.command, runtime.args, {
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return rejectPromise(new Error(stderr.trim() || "Could not read Tweakers refresh status"));
      try { resolvePromise(normalizeLocalRefreshStatus(JSON.parse(stdout.trim()) as LocalRefreshStatusValue)); }
      catch (error) { rejectPromise(error as Error); }
    });
  });
}

function resolveLocalRefreshSourceBinding(): LocalRefreshSourceBinding {
  const managedCli = join(userRoot!, "managed-runtime", "current", "packages", "installer", "dist", "cli.js");
  const frozenRoot = readInstallerState()?.sourceRoot ?? null;
  if (!frozenRoot) {
    return {
      cli: managedCli,
      developmentRoot: null,
      unsafeReason: "No frozen Tweakers installation source is recorded; development refresh is disabled.",
    };
  }
  let exactRoot: string;
  try {
    exactRoot = realpathSync(frozenRoot);
  } catch {
    return {
      cli: managedCli,
      developmentRoot: null,
      unsafeReason: "The frozen Tweakers installation source no longer exists; development refresh is disabled.",
    };
  }
  if (!isAbsolute(frozenRoot) || exactRoot !== frozenRoot) {
    return {
      cli: managedCli,
      developmentRoot: null,
      unsafeReason: "The frozen Tweakers installation source is not an exact real path; development refresh is disabled.",
    };
  }
  const sourceCli = join(exactRoot, "packages", "installer", "dist", "cli.js");
  if (describeInstallationSource(exactRoot).kind === "local-dev") {
    if (!existsSync(sourceCli)) {
      return {
        cli: managedCli,
        developmentRoot: null,
        unsafeReason: "The frozen development checkout has no built Tweakers CLI; development refresh is disabled.",
      };
    }
    return { cli: sourceCli, developmentRoot: exactRoot, unsafeReason: null };
  }
  if (existsSync(managedCli)) return { cli: managedCli, developmentRoot: null, unsafeReason: null };
  if (existsSync(sourceCli)) return { cli: sourceCli, developmentRoot: null, unsafeReason: null };
  return {
    cli: managedCli,
    developmentRoot: null,
    unsafeReason: "No exact Tweakers refresh CLI is available; refresh is disabled.",
  };
}

function normalizeLocalRefreshStatus(status: LocalRefreshStatusValue): LocalRefreshStatusValue {
  if (status.source !== "development") return status;
  const frozenRoot = LOCAL_REFRESH_SOURCE_BINDING.developmentRoot;
  const mismatch = frozenRoot === null || status.developmentSourceRoot !== frozenRoot;
  if (!mismatch && LOCAL_REFRESH_SOURCE_BINDING.unsafeReason === null) return status;
  const reason = LOCAL_REFRESH_SOURCE_BINDING.unsafeReason
    ?? "The registered dirty development checkout does not match this runtime's frozen source; refresh is disabled.";
  return {
    ...status,
    available: false,
    source: "current",
    phase: "failed",
    detail: `Unsafe refresh source: ${reason}`,
    error: `unsafe-source: ${reason}`,
  };
}

function buildLocalRefreshDispatch(
  status: LocalRefreshStatusValue,
  requested: "smart" | "development" | "stable" | undefined,
  appRoot: string,
  binding: LocalRefreshSourceBinding = LOCAL_REFRESH_SOURCE_BINDING,
): LocalRefreshDispatch {
  if (!status.available || status.error?.startsWith("unsafe-source:")) {
    throw new Error(status.detail || "Tweakers refresh is unavailable");
  }
  const selected = requested === undefined || requested === "smart" ? status.source : requested;
  if (selected !== status.source || (selected !== "development" && selected !== "stable")) {
    throw new Error("The requested refresh source is not the currently verified source");
  }
  if (selected === "development") {
    const developmentRoot = binding.developmentRoot;
    if (
      !developmentRoot
      || binding.unsafeReason !== null
      || status.developmentSourceRoot !== developmentRoot
    ) throw new Error("Unsafe refresh source: the development worktree is not frozen to this runtime");
    return {
      cli: binding.cli,
      args: [
        "refresh-local",
        "--source", "development",
        "--development-root", developmentRoot,
        "--app", appRoot,
      ],
    };
  }
  return {
    cli: binding.cli,
    args: ["refresh-local", "--source", "stable", "--app", appRoot],
  };
}

async function startLocalRefresh(
  requested?: "smart" | "development" | "stable",
): Promise<LocalRefreshStartResult> {
  if (derivedVariant) return { started: false, status: derivedVariantLocalRefreshStatus() };
  const status = await localRefreshStatus();
  if (!status.available) return { started: false, status };
  const appRoot = readInstallerState()?.appRoot;
  if (!appRoot) throw new Error("Tweakers refresh app root is unavailable");
  const dispatch = buildLocalRefreshDispatch(status, requested, appRoot);
  if (!existsSync(dispatch.cli)) throw new Error("Tweakers refresh CLI is unavailable");
  if (dispatch.args[0] !== "refresh-local") throw new Error("Tweakers refresh dispatch is invalid");
  startInstalledCli(dispatch.cli, ["refresh-local", ...dispatch.args.slice(1)]);
  return { started: true, status: { ...status, phase: "preparing" } };
}

// The OpenAI-bundled renderer Node enforces Team-ID library validation and
// cannot load Tweakers' separately signed native swap module. Prefer the exact
// Node executable captured by the installed Tweakers CLI shim; retain the
// bundled renderer Node only as a compatibility fallback for native-free work.
function localCliRuntime(cli: string, args: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TWEAKERS_HOME: userRoot!,
    TWEAKER_HOME: userRoot!,
    TWEAKERS_USER_ROOT: userRoot!,
    TWEAKER_USER_ROOT: userRoot!,
    [LEGACY_USER_ROOT_ENV]: userRoot!,
  };
  return resolveLocalCliRuntime({
    cli,
    args,
    userRoot: userRoot!,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    env,
  });
}

function localRefreshCli(): string {
  return LOCAL_REFRESH_SOURCE_BINDING.cli;
}

// This launchd helper runs the installer CLI, which must outlive the app's own
// bundle swap AND the app's own termination. It deliberately avoids both
// app.relaunch() (cannot outlive replacing the running executable) and
// `launchctl submit` from the app process: LaunchServices records submitted
// jobs as the submitting application's "one-shot jobs" and the Dock's quit
// support UNLOADS them when that app terminates — which killed a coordinator
// mid-commit the moment it quit the app for cutover (observed 2026-07-29:
// `_LSForceQuitApplication: Unloading one-shot jobs for application "ChatGPT"`).
// A plist bootstrapped into the gui domain is a plain domain service with no
// application attribution, so it survives the app quitting; the per-PID label
// and EXIT trap's bootout + plist removal make the transient job self-remove.
function startInstalledCliWithLaunchd(cli: string, args: string[]): boolean {
  if (derivedVariant) return false;
  const label = `com.therealityreport.tweakers.patch-helper.${process.pid}.${Date.now()}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  const plistPath = join(tmpdir(), `${label}.plist`);
  // rm BEFORE bootout: booting out a running service SIGTERMs the very shell
  // executing this trap, so anything after bootout races signal delivery.
  const cleanup = `rm -f ${shellQuote(plistPath)}; launchctl bootout gui/${uid}/${label} >/dev/null 2>&1; true`;
  const runtime = localCliRuntime(cli, args);
  const command = [
    `trap ${shellQuote(cleanup)} EXIT`,
    `cd ${shellQuote(resolve(dirname(cli), "..", "..", ".."))}`,
    `TWEAKERS_HOME=${shellQuote(userRoot!)} TWEAKER_HOME=${shellQuote(userRoot!)} TWEAKERS_USER_ROOT=${shellQuote(userRoot!)} TWEAKER_USER_ROOT=${shellQuote(userRoot!)} ${LEGACY_USER_ROOT_ENV}=${shellQuote(userRoot!)} TWEAKER_MANUAL_UPDATE=1 ${LEGACY_MANUAL_UPDATE_ENV}=1 ELECTRON_RUN_AS_NODE=1 ${[runtime.command, ...runtime.args].map(shellQuote).join(" ")}`,
  ].join(" && ");
  const plist = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0"><dict>`,
    `  <key>Label</key><string>${label}</string>`,
    `  <key>ProgramArguments</key><array>`,
    `    <string>/bin/sh</string>`,
    `    <string>-c</string>`,
    `    <string>${xmlEscape(`${command} || true`)}</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>AbandonProcessGroup</key><true/>`,
    `</dict></plist>`,
  ].join("\n");
  try {
    writeFileSync(plistPath, plist, { mode: 0o600 });
  } catch (error) {
    log("warn", `could not stage Tweakers patch helper plist: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  const result = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${uid}`, plistPath],
    {
      encoding: "utf8",
      stdio: "ignore",
    },
  );
  if (result.status === 0) return true;
  try {
    rmSync(plistPath, { force: true });
  } catch {
    // Best effort — a stale tmp plist is inert without its bootstrap.
  }
  log("warn", `launchctl bootstrap failed for Tweakers patch helper: ${result.error?.message ?? result.status}`);
  return false;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function markSelfUpdateStarted(sourceRoot: string): SelfUpdateState {
  const config = readState().tweaker;
  const channel = config?.updateChannel ?? "stable";
  const state: SelfUpdateState = {
    checkedAt: new Date().toISOString(),
    status: "checking",
    currentVersion: TWEAKER_VERSION,
    latestVersion: null,
    targetRef: config?.updateChannel === "custom" ? config.updateRef ?? null : null,
    releaseUrl: null,
    repo: config?.updateRepo ?? TWEAKER_REPO,
    channel,
    sourceRoot,
    installationSource: describeInstallationSource(sourceRoot),
  };
  writeSelfUpdateState(state);
  return state;
}

function broadcastReload(): void {
  const payload = {
    at: Date.now(),
    tweaks: tweakState.discovered.map((t) => t.manifest.id),
  };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send("tweaker:tweaks-changed", payload);
    } catch (e) {
      log("warn", "broadcast send failed:", e);
    }
  }
}

function makeLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    info: (...a: unknown[]) => log("info", `[${scope}]`, ...a),
    warn: (...a: unknown[]) => log("warn", `[${scope}]`, ...a),
    error: (...a: unknown[]) => log("error", `[${scope}]`, ...a),
  };
}

function makeMainIpc(tweak: DiscoveredTweak) {
  const id = tweak.manifest.id;
  const ch = (c: string) => `tweaker:${id}:${c}`;
  const requireIpc = () => assertTweakPermission(tweak, "ipc");
  return {
    on: (c: string, h: (...args: unknown[]) => void) => {
      requireIpc();
      const wrapped = (_e: unknown, ...args: unknown[]) => h(...args);
      ipcMain.on(ch(c), wrapped);
      return () => ipcMain.removeListener(ch(c), wrapped as never);
    },
    send: (c: string, ...args: unknown[]) => {
      requireIpc();
      for (const wc of webContents.getAllWebContents()) {
        try { wc.send(ch(c), ...args); } catch {}
      }
    },
    sendToPrimary: (c: string, ...args: unknown[]) => {
      requireIpc();
      const win = getPrimaryCodexWindow();
      if (!win || win.isDestroyed()) return false;
      try {
        win.webContents.send(ch(c), ...args);
        return true;
      } catch {
        return false;
      }
    },
    sendToRenderer: (webContentsId: number, c: string, ...args: unknown[]) => {
      requireIpc();
      const target = ownedCodexRenderer(webContentsId);
      if (!target) return false;
      try {
        target.send(ch(c), ...args);
        return true;
      } catch {
        return false;
      }
    },
    invoke: (_c: string) => {
      throw new Error("ipc.invoke is renderer→main; main side uses handle");
    },
    handle: (c: string, handler: (...args: unknown[]) => unknown) => {
      requireIpc();
      const channel = ch(c);
      const registration = Symbol(channel);
      // Main tweaks are stopped and reloaded in place. Remove an old handler
      // before registering its replacement so a settings reload cannot fail
      // with Electron's "handler already registered" error.
      try { ipcMain.removeHandler(channel); } catch {}
      mainIpcHandlerRegistrations.set(channel, registration);
      const invokeHandler = async (...args: unknown[]) => handler(...args);
      ipcMain.handle(channel, async (_e: unknown, ...args: unknown[]) => invokeHandler(...args));
      if (id === "co.tweakers.projects" && c === "projects") {
        mainTweakReadHandlers.set(`${id}:${c}`, invokeHandler);
      }
      return () => {
        if (mainIpcHandlerRegistrations.get(channel) !== registration) return;
        mainIpcHandlerRegistrations.delete(channel);
        if (mainTweakReadHandlers.get(`${id}:${c}`) === invokeHandler) mainTweakReadHandlers.delete(`${id}:${c}`);
        try { ipcMain.removeHandler(channel); } catch {}
      };
    },
    handleWithContext: (
      c: string,
      handler: (
        context: Readonly<{ sender: Readonly<{ webContentsId: number }> }>,
        ...args: unknown[]
      ) => unknown,
    ) => {
      requireIpc();
      const channel = ch(c);
      const registration = Symbol(channel);
      try { ipcMain.removeHandler(channel); } catch {}
      mainIpcHandlerRegistrations.set(channel, registration);
      mainTweakReadHandlers.delete(`${id}:${c}`);
      ipcMain.handle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = ownedCodexRenderer(event.sender.id);
        if (!sender || sender !== event.sender) {
          throw new Error("IPC invoke sender is not an owned Codex renderer");
        }
        const senderContext = Object.freeze({ webContentsId: sender.id });
        const brokerInvocation = accountsBrokerInvocationForMainFrame(event, sender);
        if (brokerInvocation) accountsBrokerInvocationContexts.set(senderContext, brokerInvocation);
        const context = Object.freeze({
          sender: senderContext,
        });
        return handler(context, ...args);
      });
      return () => {
        if (mainIpcHandlerRegistrations.get(channel) !== registration) return;
        mainIpcHandlerRegistrations.delete(channel);
        try { ipcMain.removeHandler(channel); } catch {}
      };
    },
  };
}

function ownedCodexRenderer(webContentsId: number): Electron.WebContents | null {
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return null;
  const target = webContents.fromId(webContentsId);
  if (!target || target.isDestroyed()) return null;
  const owner = BrowserWindow.fromWebContents(target);
  if (!owner || owner.isDestroyed() || owner.webContents !== target) return null;
  return BrowserWindow.getAllWindows().some((window) => window === owner) ? target : null;
}

function makeMainFs(id: string) {
  const dir = join(userRoot!, "tweak-data", id);
  mkdirSync(dir, { recursive: true });
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  return {
    dataDir: dir,
    read: (p: string) => fs.readFile(join(dir, p), "utf8"),
    write: (p: string, c: string) => fs.writeFile(join(dir, p), c, "utf8"),
    exists: async (p: string) => {
      try {
        await fs.access(join(dir, p));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function currentRuntimeInfo(): CodexRuntimeInfo {
  const installerState = readInstallerState();
  return getRuntimeInfo({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
  });
}

function currentRuntimeCapabilities(): CodexRuntimeCapabilities {
  const installerState = readInstallerState();
  return getRuntimeCapabilities({
    userRoot: userRoot!,
    runtimeDir: runtimeDir!,
    codexVersion: installerState?.codexVersion ?? null,
    channel: null,
    getWindowServices: getCodexWindowServices,
    getNativeCapabilities: () => nativeBridge.getCapabilities(),
    getViewCapabilities: () => getOwlViewCapabilities(),
  });
}

function tweakContext(tweakId: string, permission?: TweakPermission): NativeTweakContext {
  const tweak = permission
    ? assertTweakPermissionForId(tweakId, permission)
    : tweakById(tweakId);
  return { id: tweak.manifest.id, dir: tweak.dir };
}

function tweakById(tweakId: string): DiscoveredTweak {
  assertTweakId(tweakId);
  const tweak = tweakState.discovered.find((item) => item.manifest.id === tweakId);
  if (!tweak) throw new Error(`unknown tweak: ${tweakId}`);
  if (!isTweakEnabled(tweakId)) throw new Error(`tweak is disabled: ${tweakId}`);
  return tweak;
}

function assertTweakPermissionForId(tweakId: string, permission: TweakPermission): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakPermission(tweak, permission);
  return tweak;
}

function assertTweakViewPermissionForId(tweakId: string): DiscoveredTweak {
  const tweak = tweakById(tweakId);
  assertTweakViewPermission(tweak);
  return tweak;
}

function assertTweakPermission(tweak: DiscoveredTweak, permission: TweakPermission): void {
  if (tweak.manifest.permissions?.includes(permission)) return;
  throw new Error(`tweak ${tweak.manifest.id} must declare ${permission} permission`);
}

function assertTweakViewPermission(tweak: DiscoveredTweak): void {
  if (
    tweak.manifest.permissions?.includes("codex-views") ||
    tweak.manifest.permissions?.includes("codex.views")
  ) {
    return;
  }
  throw new Error(`tweak ${tweak.manifest.id} must declare codex-views permission`);
}

function assertTweakId(tweakId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(tweakId)) throw new Error("bad tweak id");
}

function getPrimaryCodexWindow(): Electron.BrowserWindow | null {
  const services = getCodexWindowServices();
  const fromServices = typeof services?.getPrimaryWindow === "function"
    ? services.getPrimaryWindow("local")
    : null;
  if (fromServices && !fromServices.isDestroyed()) return fromServices;
  const fromManager = typeof services?.windowManager?.getPrimaryWindow === "function"
    ? services.windowManager.getPrimaryWindow.call(services.windowManager)
    : null;
  if (fromManager && !fromManager.isDestroyed()) return fromManager;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) return focused;
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
}

function getPrimaryCodexWindowRef(): CodexWindowRef | null {
  const win = getPrimaryCodexWindow();
  if (!win || win.isDestroyed()) return null;
  return { windowId: win.id, webContentsId: win.webContents.id };
}

function focusCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function showCodexWindow(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) return false;
  win.show();
  return true;
}

const APPLE_PRIVACY_PANES: Record<"screen-recording" | "accessibility" | "input-monitoring", string> = {
  "screen-recording": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "input-monitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

const MAX_APPSHOT_PIXELS = 16_000_000;
const MAX_APPSHOT_BYTES = 20 * 1024 * 1024;
const DEFAULT_APPSHOT_TEXT_LIMIT = 100_000;

async function getCapturePermissionStatus(): Promise<CodexPermissionStatus> {
  if (process.platform !== "darwin") {
    return {
      screenRecording: "unknown",
      accessibility: "denied",
      inputMonitoring: "unknown",
      restartRequired: false,
    };
  }
  return {
    screenRecording: normalizeScreenStatus(systemPreferences.getMediaAccessStatus("screen")),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    inputMonitoring: "unknown",
    restartRequired: false,
  };
}

function normalizeScreenStatus(value: string): CodexPermissionStatus["screenRecording"] {
  if (value === "granted" || value === "denied" || value === "restricted" || value === "not-determined") return value;
  return "unknown";
}

async function openPermissionSettings(kind: "screen-recording" | "accessibility" | "input-monitoring"): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal(APPLE_PRIVACY_PANES[kind]);
}

async function captureFrontmostWindow(options: { includeAccessibilityText?: boolean; maxTextCharacters?: number } = {}): Promise<FrontmostWindowCapture> {
  const frontmost = await readFrontmostWindowInfo(Math.max(0, Math.min(options.maxTextCharacters ?? DEFAULT_APPSHOT_TEXT_LIMIT, DEFAULT_APPSHOT_TEXT_LIMIT)));
  const source = await findDesktopSourceForFrontmost(frontmost);
  if (!source) throw new Error("frontmost window was not available to Electron capture");
  const image = source.thumbnail.toPNG();
  if (image.length > MAX_APPSHOT_BYTES) throw new Error("frontmost window capture exceeded the AppShots byte limit");
  const size = source.thumbnail.getSize();
  if (size.width * size.height > MAX_APPSHOT_PIXELS) throw new Error("frontmost window capture exceeded the AppShots pixel limit");
  return {
    captureId: randomUUID(),
    capturedAt: new Date().toISOString(),
    app: {
      name: frontmost.appName || "Unknown",
      bundleIdentifier: frontmost.bundleIdentifier,
      pid: frontmost.pid,
    },
    window: {
      id: Number(source.id.replace(/^window:/, "").split(":")[0]) || 0,
      title: frontmost.windowTitle || source.name || null,
      bounds: { x: 0, y: 0, width: size.width, height: size.height },
    },
    image: {
      mimeType: "image/png",
      dataBase64: image.toString("base64"),
      width: size.width,
      height: size.height,
      byteLength: image.length,
    },
    accessibility: options.includeAccessibilityText === false
      ? { status: "unavailable", text: null, characterCount: 0 }
      : frontmost.accessibility,
  };
}

interface FrontmostWindowInfo {
  appName: string;
  bundleIdentifier: string | null;
  pid: number;
  windowTitle: string | null;
  accessibility: FrontmostWindowCapture["accessibility"];
}

async function readFrontmostWindowInfo(maxTextCharacters: number): Promise<FrontmostWindowInfo> {
  if (process.platform !== "darwin") {
    return {
      appName: "Unknown",
      bundleIdentifier: null,
      pid: -1,
      windowTitle: null,
      accessibility: { status: "unavailable", text: null, characterCount: 0 },
    };
  }
  const script = `
set maxChars to ${Math.max(0, Math.floor(maxTextCharacters))}
tell application "System Events"
  set frontProc to first application process whose frontmost is true
  set appName to name of frontProc as text
  set appPid to unix id of frontProc as integer
  set winTitle to ""
  set axText to ""
  try
    set winTitle to name of front window of frontProc as text
  end try
  try
    set rawText to value of entire contents of front window of frontProc
    set oldDelims to AppleScript's text item delimiters
    set AppleScript's text item delimiters to linefeed
    set axText to rawText as text
    set AppleScript's text item delimiters to oldDelims
  end try
end tell
set bundleId to ""
try
  tell application "System Events" to set bundleId to bundle identifier of first application process whose frontmost is true
end try
if maxChars > 0 and length of axText > maxChars then set axText to text 1 thru maxChars of axText
return appName & linefeed & appPid & linefeed & bundleId & linefeed & winTitle & linefeed & axText
`;
  try {
    const { stdout } = await execFileResult("/usr/bin/osascript", ["-e", script], 3_000, 512 * 1024);
    const [appName = "Unknown", pidText = "-1", bundleIdentifier = "", windowTitle = "", ...textLines] = stdout.split(/\r?\n/);
    const text = normalizeAccessibilityText(textLines.join("\n"));
    const status = text ? (text.length >= maxTextCharacters && maxTextCharacters > 0 ? "truncated" : "captured") : "unavailable";
    return {
      appName: appName.trim() || "Unknown",
      bundleIdentifier: bundleIdentifier.trim() || null,
      pid: Number(pidText) || -1,
      windowTitle: windowTitle.trim() || null,
      accessibility: { status, text: text || null, characterCount: text.length },
    };
  } catch (error) {
    return {
      appName: "Unknown",
      bundleIdentifier: null,
      pid: -1,
      windowTitle: null,
      accessibility: {
        status: systemPreferences.isTrustedAccessibilityClient(false) ? "unavailable" : "permission-denied",
        text: null,
        characterCount: 0,
      },
    };
  }
}

function normalizeAccessibilityText(value: string): string {
  const lines = value
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(lines)].join("\n");
}

async function findDesktopSourceForFrontmost(frontmost: FrontmostWindowInfo): Promise<Electron.DesktopCapturerSource | null> {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 4096, height: 4096 },
    fetchWindowIcons: false,
  });
  const title = compactSourceName(frontmost.windowTitle);
  const appName = compactSourceName(frontmost.appName);
  return sources.find((source) => title && compactSourceName(source.name).includes(title))
    ?? sources.find((source) => appName && compactSourceName(source.name).includes(appName))
    ?? sources.find((source) => !/ChatGPT|Codex/i.test(source.name))
    ?? sources[0]
    ?? null;
}

function compactSourceName(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

async function registerCaptureHotkey(
  tweak: DiscoveredTweak,
  options: { preferred?: "DoubleCommand"; fallbackAccelerator: string; suppressNativeAppshots?: boolean },
  listener: () => void,
): Promise<CodexHotkeyRegistration> {
  assertTweakPermission(tweak, "global-shortcut");
  const accelerator = typeof options.fallbackAccelerator === "string" && options.fallbackAccelerator.trim()
    ? options.fallbackAccelerator.trim()
    : "Command+Shift+2";
  await app.whenReady();
  if (!globalShortcut.register(accelerator, listener)) {
    throw new Error(`Could not register AppShots shortcut: ${accelerator}`);
  }
  return {
    active: "fallback",
    unregister: async () => {
      try { globalShortcut.unregister(accelerator); } catch {}
    },
  };
}

function getOwlViewCapabilities(): CodexRuntimeCapabilities["views"] {
  const parent = getPrimaryCodexWindow() ?? BrowserWindow.getFocusedWindow();
  const contentView = asRecord(parent)?.contentView;
  let sampleView: Electron.BrowserView | null = null;
  try {
    sampleView = new BrowserView({ webPreferences: { sandbox: true } });
  } catch {}
  const webContentsView = asRecord(sampleView)?.webContentsView;
  const privateViewTree = typeof asRecord(contentView)?.addChildView === "function" &&
    typeof asRecord(contentView)?.removeChildView === "function";
  const webContentsViewAvailable = Boolean(webContentsView) &&
    typeof asRecord(webContentsView)?.setBounds === "function";
  const privateAttach = privateViewTree && webContentsViewAvailable;
  const browserViewFallback = typeof asRecord(parent)?.addBrowserView === "function";
  try {
    if (sampleView && !sampleView.webContents.isDestroyed()) {
      sampleView.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
  return {
    create: privateAttach || browserViewFallback,
    privateViewTree: privateAttach,
    webContentsView: webContentsViewAvailable,
    browserViewFallback,
  };
}

async function createOwlView(
  ctx: NativeTweakContext,
  opts: CodexViewCreateOptions,
): Promise<CodexViewRef> {
  const id = assertBridgeId(opts.id ?? randomUUID(), "Codex view id");
  const key = owlViewKey(ctx.id, id);
  if (owlViews.has(key)) throw new Error(`Codex view already exists: ${ctx.id}:${id}`);

  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : getPrimaryCodexWindow();
  if (!parent || isWindowDestroyed(parent)) {
    throw new Error("Codex view needs an active parent window");
  }

  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  const route = opts.route === undefined ? null : normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const view = new BrowserView({
    webPreferences: {
      preload: opts.registerWithCodex === false ? undefined : windowManager?.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager?.options?.allowDevtools,
    },
  });

  if (opts.backgroundColor) {
    callObjectMethod(view, "setBackgroundColor", [opts.backgroundColor]);
    callObjectMethod(asRecord(view)?.webContentsView, "setBackgroundColor", [opts.backgroundColor]);
  }

  const managed: ManagedOwlView = {
    key,
    tweakId: ctx.id,
    id,
    view,
    parentWindowId: windowIdFor(parent),
    attachMode: null,
    disposeBindings: [],
    disposed: false,
  };
  owlViews.set(key, managed);

  try {
    if (route !== null && opts.registerWithCodex !== false && windowManager?.registerWindow) {
      const appearance = opts.appearance || "secondary";
      const windowLike = makeWindowLikeForView(view);
      windowManager.registerWindow(windowLike, hostId, false, appearance);
      services?.getContext?.(hostId)?.registerWindow?.(windowLike);
    }

    attachOwlView(managed, parent);
    if (opts.bounds) setOwlViewBounds(managed, opts.bounds);
    if (opts.visible === false) setOwlViewVisible(managed, false);

    if (route !== null) {
      await view.webContents.loadURL(codexAppUrl(route, hostId));
    } else if (opts.url) {
      await view.webContents.loadURL(normalizeOwlViewUrl(opts.url));
    } else {
      await view.webContents.loadURL("about:blank");
    }
  } catch (e) {
    disposeOwlView(managed);
    throw e;
  }

  log("info", `created Owl view ${ctx.id}:${id}`, {
    parentWindowId: managed.parentWindowId,
    webContentsId: view.webContents.id,
    attachMode: managed.attachMode,
  });
  return owlViewRef(managed);
}

async function callOwlView(
  tweakId: string,
  id: string,
  method: string,
  arg?: unknown,
  arg2?: unknown,
): Promise<unknown> {
  const view = owlViewFor(tweakId, id);
  if (method === "setBounds") return setOwlViewBounds(view, arg as Electron.Rectangle);
  if (method === "setVisible") return setOwlViewVisible(view, Boolean(arg));
  if (method === "bringToFront") return bringOwlViewToFront(view);
  if (method === "loadRoute") {
    const route = normalizeCodexRoute(String(arg));
    const hostId = typeof arg2 === "string" && arg2 ? arg2 : "local";
    return view.view.webContents.loadURL(codexAppUrl(route, hostId));
  }
  if (method === "loadUrl") return view.view.webContents.loadURL(normalizeOwlViewUrl(String(arg)));
  if (method === "dispose") return disposeOwlViewById(tweakId, id);
  throw new Error(`unknown Codex view method: ${method}`);
}

function owlViewRef(view: ManagedOwlView): CodexViewRef {
  return {
    id: view.id,
    webContentsId: view.view.webContents.id,
    parentWindowId: view.parentWindowId,
    setBounds: (bounds) => Promise.resolve(setOwlViewBounds(view, bounds)),
    setVisible: (visible) => Promise.resolve(setOwlViewVisible(view, visible)),
    bringToFront: () => Promise.resolve(bringOwlViewToFront(view)),
    loadRoute: (route, hostId) => view.view.webContents.loadURL(codexAppUrl(normalizeCodexRoute(route), hostId || "local")).then(() => {}),
    loadUrl: (url) => view.view.webContents.loadURL(normalizeOwlViewUrl(url)).then(() => {}),
    dispose: () => Promise.resolve(disposeOwlViewById(view.tweakId, view.id)),
  };
}

function attachOwlView(view: ManagedOwlView, parent: Electron.BrowserWindow): void {
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (typeof asRecord(parent)?.addBrowserView === "function") {
    callObjectMethod(parent, "addBrowserView", [view.view]);
    view.attachMode = "browserView";
  } else if (
    typeof asRecord(contentView)?.addChildView === "function" &&
    webContentsView
  ) {
    try {
      addOwlChildView(parent, view.view);
      view.attachMode = "contentView";
    } catch (e) {
      log("warn", "Owl contentView attachment failed; falling back to BrowserView", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (!view.attachMode) {
    throw new Error("Owl view attachment is not available on this Codex window");
  }

  const dispose = () => disposeOwlViewById(view.tweakId, view.id);
  bindWindowEvent(parent, view, "closed", dispose);
  bindWindowEvent(parent, view, "close", dispose);
}

function bringOwlViewToFront(view: ManagedOwlView): void {
  if (view.disposed) return;
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (!parent || isWindowDestroyed(parent)) return;
  const contentView = asRecord(parent)?.contentView;
  const webContentsView = asRecord(view.view)?.webContentsView;
  if (view.attachMode === "contentView" && webContentsView) {
    try {
      if (typeof asRecord(parent)?.setTopBrowserView === "function") {
        callObjectMethod(parent, "setTopBrowserView", [view.view]);
      } else {
        callObjectMethod(contentView, "addChildView", [webContentsView]);
      }
      return;
    } catch (e) {
      log("warn", "Owl contentView bring-to-front failed", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  if (typeof asRecord(parent)?.setTopBrowserView === "function") {
    callObjectMethod(parent, "setTopBrowserView", [view.view]);
  }
}

function setOwlViewBounds(view: ManagedOwlView, bounds: Electron.Rectangle): void {
  assertBounds(bounds);
  callObjectMethod(view.view, "setBounds", [bounds]);
  callObjectMethod(asRecord(view.view)?.webContentsView, "setBounds", [bounds]);
}

function setOwlViewVisible(view: ManagedOwlView, visible: boolean): void {
  callObjectMethod(asRecord(view.view)?.webContentsView, "setVisible", [visible]);
}

function disposeOwlViewById(tweakId: string, id: string): void {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view) return;
  disposeOwlView(view);
}

function disposeOwlViewsForTweak(tweakId: string): void {
  for (const view of [...owlViews.values()]) {
    if (view.tweakId === tweakId) disposeOwlView(view);
  }
}

function disposeAllOwlViews(): void {
  for (const view of [...owlViews.values()]) disposeOwlView(view);
}

function disposeOwlView(view: ManagedOwlView): void {
  if (view.disposed) return;
  view.disposed = true;
  owlViews.delete(view.key);
  for (const dispose of view.disposeBindings.splice(0)) {
    try {
      dispose();
    } catch {}
  }
  const parent = view.parentWindowId === null ? null : BrowserWindow.fromId(view.parentWindowId);
  if (parent && !isWindowDestroyed(parent)) {
    try {
      if (view.attachMode === "contentView") {
        removeOwlChildView(parent, view.view);
      } else if (view.attachMode === "browserView") {
        callObjectMethod(parent, "removeBrowserView", [view.view]);
      }
    } catch (e) {
      log("warn", "Owl view detach failed during dispose", {
        tweakId: view.tweakId,
        viewId: view.id,
        error: String(e),
      });
    }
  }
  try {
    if (!view.view.webContents.isDestroyed()) {
      view.view.webContents.close({ waitForBeforeUnload: false });
    }
  } catch {}
}

function owlViewFor(tweakId: string, id: string): ManagedOwlView {
  const view = owlViews.get(owlViewKey(tweakId, id));
  if (!view || view.disposed) throw new Error(`Codex view is not loaded: ${tweakId}:${id}`);
  return view;
}

function owlViewKey(tweakId: string, viewId: string): string {
  return `${tweakId}:${viewId}`;
}

function addOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  const ownerWindow = asRecord(child)?.ownerWindow;
  if (ownerWindow && ownerWindow !== parent) {
    callObjectMethod(ownerWindow, "removeBrowserView", [child]);
  }

  callObjectMethod(asRecord(parent)?.contentView, "addChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = parent;
  } catch {}
  callObjectMethod(asRecord(child.webContents), "_setOwnerWindow", [parent]);

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews) && !browserViews.includes(child)) {
    browserViews.push(child);
  }
}

function removeOwlChildView(parent: Electron.BrowserWindow, child: Electron.BrowserView): void {
  callObjectMethod(asRecord(parent)?.contentView, "removeChildView", [asRecord(child)?.webContentsView]);
  try {
    (child as unknown as { ownerWindow: Electron.BrowserWindow | null }).ownerWindow = null;
  } catch {}

  const browserViews = asRecord(parent)?._browserViews;
  if (Array.isArray(browserViews)) {
    const index = browserViews.indexOf(child);
    if (index >= 0) browserViews.splice(index, 1);
  }
}

async function createCodexBrowserView(opts: CodexCreateViewOptions): Promise<unknown> {
  const services = getCodexWindowServices();
  const windowManager = services?.windowManager;
  if (!services || !windowManager?.registerWindow) {
    throw new Error(
      "Codex embedded view services are not available. Reinstall Tweakers 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const appearance = opts.appearance || "secondary";
  const view = new BrowserView({
    webPreferences: {
      preload: windowManager.options?.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: windowManager.options?.allowDevtools,
    },
  });
  const windowLike = makeWindowLikeForView(view);
  windowManager.registerWindow(windowLike, hostId, false, appearance);
  services.getContext?.(hostId)?.registerWindow?.(windowLike);
  await view.webContents.loadURL(codexAppUrl(route, hostId));
  return view;
}

async function createCodexWindow(opts: CodexCreateWindowOptions): Promise<CodexWindowRef> {
  const services = getCodexWindowServices();
  if (!services) {
    throw new Error(
      "Codex window services are not available. Reinstall Tweakers 1.0.0 or later.",
    );
  }

  const route = normalizeCodexRoute(opts.route);
  const hostId = opts.hostId || "local";
  const parent = typeof opts.parentWindowId === "number"
    ? BrowserWindow.fromId(opts.parentWindowId)
    : BrowserWindow.getFocusedWindow();
  const createWindow = services.windowManager?.createWindow;

  let win: Electron.BrowserWindow | null | undefined;
  if (typeof createWindow === "function") {
    win = await createWindow.call(services.windowManager, {
      initialRoute: route,
      hostId,
      show: opts.show !== false,
      appearance: opts.appearance || "secondary",
      parent,
    });
  } else if (hostId === "local" && typeof services.createFreshWindow === "function") {
    win = await services.createFreshWindow(route);
  } else if (hostId === "local" && typeof services.createFreshLocalWindow === "function") {
    win = await services.createFreshLocalWindow(route);
  } else if (typeof services.ensureHostWindow === "function") {
    win = await services.ensureHostWindow(hostId);
  }

  if (!win || win.isDestroyed()) {
    throw new Error("Codex did not return a window for the requested route");
  }

  if (opts.bounds) {
    win.setBounds(opts.bounds);
  }
  if (parent && !parent.isDestroyed()) {
    try {
      win.setParentWindow(parent);
    } catch {}
  }
  if (opts.show !== false) {
    win.show();
  }

  return {
    windowId: win.id,
    webContentsId: win.webContents.id,
  };
}

function makeCodexApi(tweak: DiscoveredTweak) {
  const ctx = (): NativeTweakContext => ({ id: tweak.manifest.id, dir: tweak.dir });
  return {
    runtime: {
      getInfo: async () => currentRuntimeInfo(),
      getCapabilities: async () => currentRuntimeCapabilities(),
    },
    settings: {
      open: async (ownerWebContentsId?: number) => {
        assertTweakPermission(tweak, "settings");
        if (ownerWebContentsId !== undefined) {
          const sender = ownedCodexRenderer(ownerWebContentsId);
          if (!sender) return false;
          return openNativeSettingsFromApplicationMenu(BrowserWindow.fromWebContents(sender) ?? undefined);
        }
        return openNativeSettingsFromApplicationMenu(getPrimaryCodexWindow() ?? undefined);
      },
    },
    windows: {
      create: createCodexWindow,
      getPrimary: async () => getPrimaryCodexWindowRef(),
      focus: async (windowId: number) => focusCodexWindow(windowId),
      show: async (windowId: number) => showCodexWindow(windowId),
    },
    views: {
      create: async (options: CodexViewCreateOptions) => {
        assertTweakViewPermission(tweak);
        return createOwlView(ctx(), options);
      },
    },
    cdp: {
      getStatus: async () => getCdpStatus(),
      listTargets: async () => listCdpTargets(),
    },
    // Main tweaks receive a redacted adapter only. The Accounts tweak binds
    // the caller's already-validated renderer id through handleWithContext;
    // no renderer opens or learns an owner-private broker socket.
    accounts: {
      // Main tweaks may observe this opaque authority state, but no renderer
      // message can provide, override, or derive it from broker reachability.
      authorityMode: () => accountsAuthorityMode,
      invoke: (
        input: Readonly<{ webContentsId: number }>,
        envelope: AccountsBrokerIpcEnvelopeV1,
      ) => invokeAccountsBroker(input, envelope),
      subscribe: (
        input: Readonly<{ webContentsId: number }>,
        handler: (event: RendererBrokerEventV1) => void,
      ) => subscribeAccountsBroker(input, handler),
    },
    native: {
      loadModule: async (options: NativeModuleLoadOptions) => {
        assertTweakPermission(tweak, "native-module");
        return nativeBridge.loadModule(ctx(), options);
      },
      createPanel: async (options: NativePanelCreateOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.createPanel(ctx(), options);
      },
      attachView: async (options: NativeViewAttachOptions) => {
        assertTweakPermission(tweak, "native-view");
        return nativeBridge.attachView(ctx(), options);
      },
      launchHelper: async (options: NativeHelperLaunchOptions) => {
        assertTweakPermission(tweak, "native-helper");
        return nativeBridge.launchHelper(ctx(), options);
      },
    },
    refresh: {
      getStatus: async () => localRefreshStatus(),
      start: async (source?: "smart" | "development" | "stable") => startLocalRefresh(source),
      onStatusChanged: () => () => {},
    },
    capture: {
      getPermissionStatus: async () => {
        assertTweakPermission(tweak, "screen-capture");
        return getCapturePermissionStatus();
      },
      requestAccessibility: async () => {
        assertTweakPermission(tweak, "accessibility");
        return process.platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(true) : false;
      },
      openPermissionSettings: async (kind: "screen-recording" | "accessibility" | "input-monitoring") => {
        if (kind === "screen-recording") assertTweakPermission(tweak, "screen-capture");
        if (kind === "accessibility") assertTweakPermission(tweak, "accessibility");
        if (kind === "input-monitoring") assertTweakPermission(tweak, "global-shortcut");
        return openPermissionSettings(kind);
      },
      captureFrontmostWindow: async (options?: { includeAccessibilityText?: boolean; maxTextCharacters?: number }) => {
        assertTweakPermission(tweak, "screen-capture");
        if (options?.includeAccessibilityText !== false) assertTweakPermission(tweak, "accessibility");
        return captureFrontmostWindow(options);
      },
    },
    hotkeys: {
      registerCaptureHotkey: (options: { preferred?: "DoubleCommand"; fallbackAccelerator: string; suppressNativeAppshots?: boolean }, listener: () => void) =>
        registerCaptureHotkey(tweak, options, listener),
    },
    createBrowserView: createCodexBrowserView,
    createWindow: createCodexWindow,
  };
}

function makeWindowLikeForView(view: Electron.BrowserView): CodexWindowLike {
  const viewBounds = () => view.getBounds();
  return {
    id: view.webContents.id,
    webContents: view.webContents,
    on: (event: "closed", listener: () => void) => {
      if (event === "closed") {
        view.webContents.once("destroyed", listener);
      } else {
        view.webContents.on(event, listener);
      }
      return view;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.once(event as "destroyed", listener);
      return view;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.off(event as "destroyed", listener);
      return view;
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      view.webContents.removeListener(event as "destroyed", listener);
      return view;
    },
    isDestroyed: () => view.webContents.isDestroyed(),
    isFocused: () => view.webContents.isFocused(),
    focus: () => view.webContents.focus(),
    show: () => {},
    hide: () => {},
    getBounds: viewBounds,
    getContentBounds: viewBounds,
    getSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    getContentSize: () => {
      const b = viewBounds();
      return [b.width, b.height];
    },
    setTitle: () => {},
    getTitle: () => "",
    setRepresentedFilename: () => {},
    setDocumentEdited: () => {},
    setWindowButtonVisibility: () => {},
  };
}

function codexAppUrl(route: string, hostId: string): string {
  const url = new URL("app://-/index.html");
  url.searchParams.set("hostId", hostId);
  if (route !== "/") url.searchParams.set("initialRoute", route);
  return url.toString();
}

function normalizeOwlViewUrl(url: string): string {
  if (typeof url !== "string" || url.includes("\n") || url.includes("\r")) {
    throw new Error("Owl view URL must be a string without control characters");
  }
  const parsed = new URL(url);
  if (!["http:", "https:", "app:", "file:", "data:", "about:"].includes(parsed.protocol)) {
    throw new Error(`unsupported Owl view URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function getCodexWindowServices(): CodexWindowServices | null {
  const globals = globalThis as unknown as Record<string, unknown>;
  const services = globals[CODEX_WINDOW_SERVICES_KEY] ?? globals[LEGACY_WINDOW_SERVICES_KEY];
  return services && typeof services === "object" ? (services as CodexWindowServices) : null;
}

function normalizeCodexRoute(route: string): string {
  if (typeof route !== "string" || !route.startsWith("/")) {
    throw new Error("Codex route must be an absolute app route");
  }
  if (route.includes("://") || route.includes("\n") || route.includes("\r")) {
    throw new Error("Codex route must not include a protocol or control characters");
  }
  return route;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function callObjectMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = asRecord(target)?.[method];
  if (typeof fn !== "function") return undefined;
  return fn.apply(target, args);
}

function isWindowDestroyed(win: Electron.BrowserWindow | null | undefined): boolean {
  if (!win) return true;
  const fn = asRecord(win)?.isDestroyed;
  if (typeof fn !== "function") return false;
  try {
    return Boolean(fn.call(win));
  } catch {
    return true;
  }
}

function windowIdFor(win: Electron.BrowserWindow | null | undefined): number | null {
  const id = asRecord(win)?.id;
  return typeof id === "number" ? id : null;
}

function bindWindowEvent(
  win: Electron.BrowserWindow,
  view: ManagedOwlView,
  event: string,
  listener: (...args: unknown[]) => void,
): void {
  const on = asRecord(win)?.on;
  const off = asRecord(win)?.off;
  if (typeof on !== "function") return;
  on.call(win, event, listener);
  view.disposeBindings.push(() => {
    if (typeof off === "function") off.call(win, event, listener);
    else callObjectMethod(win, "removeListener", [event, listener]);
  });
}

function assertBridgeId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`${label} may only contain letters, numbers, dots, underscores, and dashes`);
  }
  return value;
}

function assertBounds(bounds: Electron.Rectangle): void {
  const values = [bounds?.x, bounds?.y, bounds?.width, bounds?.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("bounds must contain finite x, y, width, and height numbers");
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error("bounds width and height must be non-negative");
  }
}

// Touch BrowserWindow to keep its import — older Electron lint rules.
void BrowserWindow;
