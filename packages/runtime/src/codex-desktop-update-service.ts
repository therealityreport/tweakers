export type CodexDesktopReleaseProfile = "stable" | "alpha";

export interface CodexDesktopUpdateTarget {
  profile: CodexDesktopReleaseProfile;
  available: boolean;
  unavailableReason: string | null;
  setupRequired?: "register-beta" | "launch-beta" | null;
  /** Verified profile identity used to isolate persisted appcast state. */
  identityKey?: string | null;
  /** Profile-scoped captured feed. Alpha never receives the stable fallback. */
  feedUrl?: string | null;
  fallbackFeedUrl?: string | null;
}

export interface CodexDesktopVersionIdentity {
  marketingVersion: string | null;
  build: string | null;
}

export interface CodexDesktopUpdateMetadata {
  installed: CodexDesktopVersionIdentity;
  latest: CodexDesktopVersionIdentity;
  checkedAt: string;
  stale: boolean;
  error: string | null;
  updateAvailable: boolean;
}

export type CodexDesktopUpdateCheckStatus =
  | "update-available"
  | "current"
  | "stale"
  | "unavailable"
  | "error";

export interface CodexDesktopUpdateCheckResult {
  schemaVersion: 1;
  status: CodexDesktopUpdateCheckStatus;
  profile: CodexDesktopReleaseProfile | null;
  installed: CodexDesktopVersionIdentity;
  latest: CodexDesktopVersionIdentity;
  checkedAt: string;
  reason: string | null;
  retryRequested: boolean;
  updateAndReloadRequested: boolean;
  nativeUpdateControlActive?: boolean;
  javaScriptUpdaterManagerAvailable?: boolean;
  javaScriptUpdaterManagerReason?: string | null;
  setupRequired?: "register-beta" | "launch-beta" | null;
}

/** Electron MessageBoxOptions subset kept free of Electron so the service is unit-testable. */
export interface CodexDesktopUpdateDialog {
  type: "none" | "info" | "error";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface CodexDesktopUpdateServiceDependencies {
  resolveTarget(): Promise<CodexDesktopUpdateTarget>;
  refreshMetadata(target: CodexDesktopUpdateTarget): Promise<CodexDesktopUpdateMetadata>;
  showDialog(dialog: CodexDesktopUpdateDialog): Promise<{ response: number }>;
  startUpdateAndReload(): void | Promise<void>;
  scheduleRetry?(retry: () => void): void;
  /** Publishes each completed metadata check to renderer and native UI surfaces. */
  onResult?(result: CodexDesktopUpdateCheckResult): void;
}

export interface CodexDesktopUpdateService {
  /** Menu and Config callers share the exact in-flight promise and native dialog. */
  checkAndPresent(): Promise<CodexDesktopUpdateCheckResult>;
  /** Safe metadata-only check for proactive notifications; never opens a dialog. */
  checkSilently(): Promise<CodexDesktopUpdateCheckResult>;
  /** Last completed metadata result, retained so newly mounted UI cannot miss it. */
  getSnapshot(): CodexDesktopUpdateCheckResult | null;
}

const EMPTY_VERSION: CodexDesktopVersionIdentity = {
  marketingVersion: null,
  build: null,
};

export function createCodexDesktopUpdateService(
  dependencies: CodexDesktopUpdateServiceDependencies,
): CodexDesktopUpdateService {
  let checkInFlight: Promise<CodexDesktopUpdateCheckResult> | null = null;
  let presentationInFlight: Promise<CodexDesktopUpdateCheckResult> | null = null;
  let snapshot: CodexDesktopUpdateCheckResult | null = null;
  const scheduleRetry = dependencies.scheduleRetry ?? ((retry: () => void) => queueMicrotask(retry));
  const recordResult = (result: CodexDesktopUpdateCheckResult): CodexDesktopUpdateCheckResult => {
    snapshot = cloneResult(result);
    try {
      dependencies.onResult?.(cloneResult(result));
    } catch {
      // A UI publication failure must never turn a valid metadata check into
      // an updater failure or trigger a second check flight.
    }
    return result;
  };

  const checkSilently = (): Promise<CodexDesktopUpdateCheckResult> => {
    if (checkInFlight) return checkInFlight;
    const current = runCheck(dependencies).then(recordResult);
    checkInFlight = current;
    const clearFlight = (): void => {
      if (checkInFlight === current) checkInFlight = null;
    };
    void current.then(clearFlight, clearFlight);
    return current;
  };

  const checkAndPresent = (): Promise<CodexDesktopUpdateCheckResult> => {
    if (presentationInFlight) return presentationInFlight;
    const current = checkSilently().then(async (result) => {
      const presented = await presentResult(dependencies, result);
      if (presented.status !== result.status || presented.reason !== result.reason) {
        recordResult(presented);
      }
      return presented;
    });
    presentationInFlight = current;
    void current.then((result) => {
      if (presentationInFlight === current) presentationInFlight = null;
      if (result.retryRequested) {
        scheduleRetry(() => { void checkAndPresent(); });
      }
    }, () => {
      if (presentationInFlight === current) presentationInFlight = null;
    });
    return current;
  };

  return {
    checkAndPresent,
    checkSilently,
    getSnapshot: () => snapshot ? cloneResult(snapshot) : null,
  };
}

function cloneResult(result: CodexDesktopUpdateCheckResult): CodexDesktopUpdateCheckResult {
  return {
    ...result,
    installed: { ...result.installed },
    latest: { ...result.latest },
  };
}

async function runCheck(
  dependencies: CodexDesktopUpdateServiceDependencies,
): Promise<CodexDesktopUpdateCheckResult> {
  let target: CodexDesktopUpdateTarget;
  try {
    target = await dependencies.resolveTarget();
  } catch (error) {
    return resultForFailure("error", null, safeError(error));
  }

  if (!target.available) {
    return {
      ...resultForFailure(
      "unavailable",
      target.profile,
      target.unavailableReason ?? `${profileLabel(target.profile)} updates are unavailable.`,
      ),
      setupRequired: target.setupRequired ?? null,
    };
  }

  let metadata: CodexDesktopUpdateMetadata;
  try {
    metadata = await dependencies.refreshMetadata(target);
  } catch (error) {
    return resultForFailure("error", target.profile, safeError(error));
  }

  // A refresh failure must not hide a last-known verified newer build. The
  // durable Update and Reload transaction revalidates before changing apps.
  const status: CodexDesktopUpdateCheckStatus = metadata.updateAvailable
    ? "update-available"
    : metadata.stale
      ? "stale"
      : metadata.error
        ? "error"
        : "current";
  return {
    schemaVersion: 1,
    status,
    profile: target.profile,
    installed: { ...metadata.installed },
    latest: { ...metadata.latest },
    checkedAt: metadata.checkedAt,
    reason: metadata.error,
    retryRequested: false,
    updateAndReloadRequested: false,
  };
}

async function presentResult(
  dependencies: CodexDesktopUpdateServiceDependencies,
  initial: CodexDesktopUpdateCheckResult,
): Promise<CodexDesktopUpdateCheckResult> {
  // Alpha setup is an intentional gated state, not a failed network check.
  // Settings renders the guidance inline and the app menu must not open a
  // retry dialog that cannot succeed until the Beta app is registered/run.
  if (initial.setupRequired) return initial;
  let response: number;
  try {
    response = (await dependencies.showDialog(dialogFor(initial))).response;
  } catch (error) {
    return { ...initial, status: "error", reason: safeError(error) };
  }

  if (initial.status === "update-available" && response === 0) {
    try {
      await dependencies.startUpdateAndReload();
      return { ...initial, updateAndReloadRequested: true };
    } catch (error) {
      return presentResult(dependencies, {
        ...initial,
        status: "error",
        reason: safeError(error),
      });
    }
  }

  const retryRequested = response === 0 && (
    initial.status === "stale" || initial.status === "unavailable" || initial.status === "error"
  );
  return retryRequested ? { ...initial, retryRequested: true } : initial;
}

function resultForFailure(
  status: "unavailable" | "error",
  profile: CodexDesktopReleaseProfile | null,
  reason: string,
): CodexDesktopUpdateCheckResult {
  return {
    schemaVersion: 1,
    status,
    profile,
    installed: { ...EMPTY_VERSION },
    latest: { ...EMPTY_VERSION },
    checkedAt: new Date().toISOString(),
    reason,
    retryRequested: false,
    updateAndReloadRequested: false,
  };
}

function dialogFor(result: CodexDesktopUpdateCheckResult): CodexDesktopUpdateDialog {
  const profile = result.profile ? profileLabel(result.profile) : "selected";
  const installed = versionLabel(result.installed);
  const latest = versionLabel(result.latest);
  if (result.status === "update-available") {
    return {
      type: "info",
      title: "ChatGPT Update Available",
      message: `ChatGPT ${latest} is available.`,
      detail: `Installed: ${installed}\nRelease profile: ${profile}`,
      buttons: ["Update and Reload", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
  }
  if (result.status === "current") {
    return {
      type: "info",
      title: "ChatGPT Is Up to Date",
      message: `ChatGPT ${installed} is the latest available version.`,
      detail: `Release profile: ${profile}`,
      buttons: ["OK"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
  }
  const copy = result.status === "unavailable"
    ? { title: "ChatGPT Updates Unavailable", message: `Updates for ${profile} could not be checked.` }
    : result.status === "stale"
      ? { title: "Could Not Refresh ChatGPT Updates", message: "The last known update information may be out of date." }
      : { title: "Could Not Check for ChatGPT Updates", message: "ChatGPT update information is unavailable." };
  return {
    type: result.status === "error" ? "error" : "info",
    title: copy.title,
    message: copy.message,
    detail: [result.reason, `Release profile: ${profile}`].filter(Boolean).join("\n"),
    buttons: ["Try Again", "OK"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
}

function profileLabel(profile: CodexDesktopReleaseProfile): string {
  return profile === "alpha" ? "Alpha (Pre-release)" : "Stable";
}

function versionLabel(version: CodexDesktopVersionIdentity): string {
  const marketing = version.marketingVersion ?? "Unavailable";
  return version.build ? `${marketing} (build ${version.build})` : marketing;
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Desktop update check failed.";
}
