export type EnvironmentAppExperience = "chatgpt" | "tweakers";
export type EnvironmentReleaseProfile = "stable" | "alpha";

export interface EnvironmentSelectionPair {
  appExperience: EnvironmentAppExperience;
  releaseProfile: EnvironmentReleaseProfile;
}

export type EnvironmentConfirmationDecision = "confirm" | "cancel";

export interface EnvironmentConfigEffects<Receipt> {
  prepare(selection: EnvironmentSelectionPair): Promise<Receipt>;
  confirm(selection: EnvironmentSelectionPair, receipt: Receipt): Promise<EnvironmentConfirmationDecision>;
  commit(receipt: Receipt): Promise<void>;
  cancel(receipt: Receipt): Promise<void>;
}

export type EnvironmentConfigPhase =
  | "idle"
  | "preparing"
  | "awaiting-confirmation"
  | "committing"
  | "cancelling";

export interface EnvironmentConfigSnapshot {
  selected: EnvironmentSelectionPair;
  pending: EnvironmentSelectionPair;
  hasPendingChanges: boolean;
  busy: boolean;
  phase: EnvironmentConfigPhase;
  error: string | null;
}

export type EnvironmentApplyOutcome<Receipt> =
  | { outcome: "no-change" | "busy" }
  | { outcome: "submitted" | "cancelled"; receipt: Receipt }
  | { outcome: "prepare-failed"; error: string }
  | { outcome: "confirmation-failed" | "commit-failed" | "cancel-failed"; receipt: Receipt; error: string };

export interface EnvironmentConfigController<Receipt> {
  readonly snapshot: EnvironmentConfigSnapshot;
  setSelected(selection: EnvironmentSelectionPair): void;
  restorePending(selection: EnvironmentSelectionPair): void;
  stageAppExperience(value: EnvironmentAppExperience): void;
  stageReleaseProfile(value: EnvironmentReleaseProfile): void;
  clearError(): void;
  applyAndRestart(): Promise<EnvironmentApplyOutcome<Receipt>>;
  resumePrepared(
    selection: EnvironmentSelectionPair,
    receipt: Receipt,
  ): Promise<EnvironmentApplyOutcome<Receipt>>;
}

export interface EnvironmentConfigControllerOptions {
  onChange?: (snapshot: EnvironmentConfigSnapshot) => void;
}

export function createEnvironmentConfigController<Receipt>(
  selected: EnvironmentSelectionPair,
  effects: EnvironmentConfigEffects<Receipt>,
  options: EnvironmentConfigControllerOptions = {},
): EnvironmentConfigController<Receipt> {
  let selectedValue = copySelection(selected);
  let pendingValue = copySelection(selected);
  let busy = false;
  let phase: EnvironmentConfigPhase = "idle";
  let error: string | null = null;

  const readSnapshot = (): EnvironmentConfigSnapshot => ({
    selected: copySelection(selectedValue),
    pending: copySelection(pendingValue),
    hasPendingChanges: !sameSelection(selectedValue, pendingValue),
    busy,
    phase,
    error,
  });
  const publish = (): void => options.onChange?.(readSnapshot());
  const finishWithError = (nextPhase: EnvironmentConfigPhase, nextError: unknown): string => {
    error = environmentConfigError(nextError);
    busy = false;
    phase = nextPhase;
    publish();
    return error;
  };

  const completePrepared = async (
    requested: EnvironmentSelectionPair,
    receipt: Receipt,
  ): Promise<EnvironmentApplyOutcome<Receipt>> => {
    phase = "awaiting-confirmation";
    publish();
    let decision: EnvironmentConfirmationDecision;
    try {
      decision = await effects.confirm(copySelection(requested), receipt);
    } catch (confirmationError) {
      return {
        outcome: "confirmation-failed",
        receipt,
        error: finishWithError("idle", confirmationError),
      };
    }

    if (decision === "cancel") {
      phase = "cancelling";
      publish();
      try {
        await effects.cancel(receipt);
      } catch (cancelError) {
        return {
          outcome: "cancel-failed",
          receipt,
          error: finishWithError("idle", cancelError),
        };
      }
      pendingValue = copySelection(selectedValue);
      busy = false;
      phase = "idle";
      error = null;
      publish();
      return { outcome: "cancelled", receipt };
    }

    phase = "committing";
    publish();
    try {
      await effects.commit(receipt);
    } catch (commitError) {
      return {
        outcome: "commit-failed",
        receipt,
        error: finishWithError("idle", commitError),
      };
    }
    busy = false;
    phase = "idle";
    error = null;
    publish();
    return { outcome: "submitted", receipt };
  };

  return {
    get snapshot(): EnvironmentConfigSnapshot {
      return readSnapshot();
    },
    setSelected(selection): void {
      const pendingWasUnchanged = sameSelection(selectedValue, pendingValue);
      selectedValue = copySelection(selection);
      // A status refresh may resolve after the user has staged one half of the
      // Environment pair. Refresh the authoritative selection without erasing
      // that newer local intent; only follow the selected value while the form
      // itself is still pristine.
      if (pendingWasUnchanged) pendingValue = copySelection(selection);
      error = null;
      publish();
    },
    restorePending(selection): void {
      pendingValue = copySelection(selection);
      publish();
    },
    stageAppExperience(value): void {
      if (busy) return;
      pendingValue = { ...pendingValue, appExperience: value };
      error = null;
      publish();
    },
    stageReleaseProfile(value): void {
      if (busy) return;
      pendingValue = { ...pendingValue, releaseProfile: value };
      error = null;
      publish();
    },
    clearError(): void {
      error = null;
      publish();
    },
    async applyAndRestart(): Promise<EnvironmentApplyOutcome<Receipt>> {
      if (busy) return { outcome: "busy" };
      if (sameSelection(selectedValue, pendingValue)) return { outcome: "no-change" };
      const requested = copySelection(pendingValue);
      busy = true;
      phase = "preparing";
      error = null;
      publish();
      let receipt: Receipt;
      try {
        receipt = await effects.prepare(copySelection(requested));
      } catch (prepareError) {
        return {
          outcome: "prepare-failed",
          error: finishWithError("idle", prepareError),
        };
      }
      return completePrepared(requested, receipt);
    },
    async resumePrepared(selection, receipt): Promise<EnvironmentApplyOutcome<Receipt>> {
      if (busy) return { outcome: "busy" };
      pendingValue = copySelection(selection);
      busy = true;
      error = null;
      return completePrepared(copySelection(selection), receipt);
    },
  };
}

function copySelection(selection: EnvironmentSelectionPair): EnvironmentSelectionPair {
  return {
    appExperience: selection.appExperience,
    releaseProfile: selection.releaseProfile,
  };
}

function sameSelection(left: EnvironmentSelectionPair, right: EnvironmentSelectionPair): boolean {
  return left.appExperience === right.appExperience
    && left.releaseProfile === right.releaseProfile;
}

function environmentConfigError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export type DesktopUpdateStatus =
  | "update-available"
  | "current"
  | "stale"
  | "unavailable"
  | "error";

export function humanizeCodexPhase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export interface DesktopUpdatePresentationTransaction {
  phase: string;
  safeOfficialMode?: boolean;
  resumable?: boolean;
  environmentTransactionId?: string | null;
  error?: string | null;
  blocksLifecycle?: boolean;
}

export interface DesktopUpdatePresentationInput {
  busy: boolean;
  status: DesktopUpdateStatus | undefined;
  transaction: DesktopUpdatePresentationTransaction | null;
}

export interface DesktopUpdatePresentationAction {
  kind: "resume" | "cancel";
  label: "Resume" | "Cancel";
  disabled: boolean;
}

export interface DesktopUpdatePresentation {
  phaseLabel: string | null;
  tone: "ok" | "warn" | "error" | null;
  actions: DesktopUpdatePresentationAction[];
  updateDisabled: boolean;
}

export function desktopUpdatePresentation(
  input: DesktopUpdatePresentationInput,
): DesktopUpdatePresentation {
  const { busy, status, transaction } = input;
  const phase = transaction?.phase ?? null;
  const resumable = transaction?.resumable === true;
  const inactive = phase === null || phase === "idle";
  const terminal = phase === "completed" || phase === "failed" || phase === "rolled_back";
  const unsafeFailure = phase === "failed" && transaction?.safeOfficialMode !== true;
  const blocksLifecycle = transaction?.blocksLifecycle
    ?? (
      !terminal
      || resumable
      || (
        phase === "failed"
        && (
          transaction?.safeOfficialMode !== true
          || /\brollback failed\b/i.test(transaction?.error ?? "")
        )
      )
    );
  const retryableUnsafeRecovery = unsafeFailure
    && typeof transaction?.environmentTransactionId === "string";
  const actions: DesktopUpdatePresentationAction[] = [];
  if (resumable && (phase === "failed" || phase === "rolled_back")) {
    actions.push({ kind: "resume", label: "Resume", disabled: busy });
  }
  if (phase === "awaiting_native_update"
    || (resumable && (phase === "failed" || phase === "rolled_back"))
    || retryableUnsafeRecovery) {
    actions.push({ kind: "cancel", label: "Cancel", disabled: busy });
  }
  return {
    phaseLabel: phase === null ? null : humanizeCodexPhase(phase),
    tone: phase === null
      ? null
      : phase === "completed"
        ? "ok"
        : phase === "failed" && !resumable
          ? "error"
          : "warn",
    actions,
    updateDisabled: busy
      || status !== "update-available"
      || (!inactive && blocksLifecycle),
  };
}

export function desktopUpdateStatusPresentation(
  status: DesktopUpdateStatus | undefined,
): { label: string; tone: "ok" | "warn" | "error" } {
  switch (status) {
    case "current":
      return { label: "Up to date", tone: "ok" };
    case "update-available":
      return { label: "Update available", tone: "warn" };
    case "error":
      return { label: "Error", tone: "error" };
    case "stale":
      return { label: "Stale", tone: "warn" };
    case "unavailable":
      return { label: "Unavailable", tone: "warn" };
    default:
      return { label: "Not checked", tone: "warn" };
  }
}

export interface EnvironmentFocusTarget {
  readonly isConnected: boolean;
  focus(): void;
}

export function restoreEnvironmentFocus(
  opener: EnvironmentFocusTarget | null,
  fallback: () => EnvironmentFocusTarget | null,
): "opener" | "fallback" | "none" {
  if (opener?.isConnected) {
    opener.focus();
    return "opener";
  }
  const target = fallback();
  if (target?.isConnected) {
    target.focus();
    return "fallback";
  }
  return "none";
}

export interface ConfigCardUpdateToken {
  readonly card: string;
  readonly generation: number;
}

/**
 * Keeps asynchronous Config cards independent while rejecting a stale result
 * from an older request for the same card.
 */
export class ConfigCardUpdateCoordinator<Value> {
  readonly #generations = new Map<string, number>();
  readonly #values = new Map<string, Value>();

  begin(card: string): ConfigCardUpdateToken {
    const generation = (this.#generations.get(card) ?? 0) + 1;
    this.#generations.set(card, generation);
    return Object.freeze({ card, generation });
  }

  complete(token: ConfigCardUpdateToken, value: Value): boolean {
    if (!this.isCurrent(token)) return false;
    this.#values.set(token.card, value);
    return true;
  }

  isCurrent(token: ConfigCardUpdateToken): boolean {
    return this.#generations.get(token.card) === token.generation;
  }

  invalidate(card: string): void {
    this.#generations.set(card, (this.#generations.get(card) ?? 0) + 1);
  }

  value(card: string): Value | undefined {
    return this.#values.get(card);
  }

  snapshot(): Record<string, Value> {
    return Object.fromEntries(this.#values);
  }
}
