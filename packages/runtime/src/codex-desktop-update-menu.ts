export interface CodexDesktopUpdateMenuItemLike {
  id?: string;
  label: string;
  sublabel?: string;
  enabled?: boolean;
  submenu?: CodexDesktopUpdateMenuLike | null;
}

export interface CodexDesktopUpdateMenuLike {
  items: CodexDesktopUpdateMenuItemLike[];
  insert?: (position: number, item: CodexDesktopUpdateMenuItemLike) => void;
}

/**
 * Menu Bar-safe presentation for the optional sealed-pair cache. The menu
 * receives this already-observed value from environment status; this helper
 * neither starts preparation nor exposes a switch action.
 */
export interface EnvironmentModeCacheMenuInput {
  state: "ready" | "preparing" | "stale" | "unavailable";
  generationId: string | null;
  invalidationReasons: string[];
}

export interface EnvironmentModeCacheMenuPresentation {
  label: string;
  detail: string;
  tone: "ok" | "warn";
}

export const ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID = "tweakers-environment-mode-cache-status";

export interface EnvironmentModeCacheMenuItemInput {
  id: typeof ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID;
  label: string;
  sublabel: string;
  enabled: false;
}

export function environmentModeCacheMenuPresentation(
  input: EnvironmentModeCacheMenuInput,
): EnvironmentModeCacheMenuPresentation {
  const generation = input.generationId ? `Generation ${input.generationId}` : "No generation";
  const reason = input.invalidationReasons[0];
  if (input.state === "ready") {
    return { label: "Sealed Pair Ready", detail: generation, tone: "ok" };
  }
  if (input.state === "preparing") {
    return { label: "Sealed Pair Preparing", detail: `${generation}${reason ? ` — ${reason}` : ""}`, tone: "warn" };
  }
  if (input.state === "stale") {
    return {
      label: "Sealed Pair Needs Preparation",
      detail: `${generation}${reason ? ` — ${reason}` : ""}; it will not switch automatically`,
      tone: "warn",
    };
  }
  return { label: "Sealed Pair Unavailable", detail: `${generation}${reason ? ` — ${reason}` : ""}`, tone: "warn" };
}

/**
 * Upsert the observational sealed-pair row next to OpenAI's existing update
 * command. The caller owns MenuItem construction; this helper never polls,
 * prepares, pins, validates, or switches an environment.
 */
export function syncEnvironmentModeCacheMenuItem(
  menu: CodexDesktopUpdateMenuLike,
  input: EnvironmentModeCacheMenuInput,
  createItem: (input: EnvironmentModeCacheMenuItemInput) => CodexDesktopUpdateMenuItemLike,
): boolean {
  const owner = findCodexDesktopUpdateMenuOwner(menu);
  if (!owner) return false;
  const presentation = environmentModeCacheMenuPresentation(input);
  const existing = owner.menu.items.find((item) => item.id === ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID);
  if (existing) {
    existing.label = presentation.label;
    existing.sublabel = presentation.detail;
    existing.enabled = false;
    return true;
  }
  if (!owner.menu.insert) return false;
  owner.menu.insert(owner.index + 1, createItem({
    id: ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID,
    label: presentation.label,
    sublabel: presentation.detail,
    enabled: false,
  }));
  return true;
}

export function environmentModeCacheMenuInputFromStatus(value: unknown): EnvironmentModeCacheMenuInput | null {
  if (!value || typeof value !== "object") return null;
  const cache = (value as { cacheV2?: unknown }).cacheV2;
  if (!cache || typeof cache !== "object") return null;
  const candidate = cache as Partial<EnvironmentModeCacheMenuInput>;
  if (!candidate.state || !["ready", "preparing", "stale", "unavailable"].includes(candidate.state)) return null;
  if (candidate.generationId !== null && typeof candidate.generationId !== "string") return null;
  if (!Array.isArray(candidate.invalidationReasons)
    || !candidate.invalidationReasons.every((reason) => typeof reason === "string")) return null;
  return {
    state: candidate.state,
    generationId: candidate.generationId ?? null,
    invalidationReasons: candidate.invalidationReasons,
  };
}

export function syncEnvironmentModeCacheMenuFromStatus(
  menu: CodexDesktopUpdateMenuLike,
  status: unknown,
  createItem: (input: EnvironmentModeCacheMenuItemInput) => CodexDesktopUpdateMenuItemLike,
): boolean {
  const input = environmentModeCacheMenuInputFromStatus(status);
  return input === null ? false : syncEnvironmentModeCacheMenuItem(menu, input, createItem);
}

/** Updates OpenAI's existing item in place, preserving its original click action. */
export function syncCodexDesktopUpdateMenuLabel(
  menu: CodexDesktopUpdateMenuLike,
  updateAvailable: boolean,
  onManualCheck?: (...args: unknown[]) => void,
  alphaSetupRequired = false,
): boolean {
  const updateItem = findCodexDesktopUpdateMenuItem(menu);
  if (!updateItem) return false;
  updateItem.label = alphaSetupRequired
    ? "Alpha Updates Require Setup…"
    : updateAvailable ? "Update Available…" : "Check for Updates…";
  updateItem.enabled = !alphaSetupRequired;
  if (onManualCheck) {
    (updateItem as CodexDesktopUpdateMenuItemLike & { click?: (...args: unknown[]) => void }).click = onManualCheck;
  }
  return true;
}

function findCodexDesktopUpdateMenuItem(
  menu: CodexDesktopUpdateMenuLike,
): CodexDesktopUpdateMenuItemLike | null {
  for (const item of menu.items) {
    if (
      item.label === "Check for Updates…"
      || item.label === "Update Available…"
      || item.label === "Alpha Updates Require Setup…"
    ) return item;
    if (item.submenu) {
      const nested = findCodexDesktopUpdateMenuItem(item.submenu);
      if (nested) return nested;
    }
  }
  return null;
}

function findCodexDesktopUpdateMenuOwner(
  menu: CodexDesktopUpdateMenuLike,
): { menu: CodexDesktopUpdateMenuLike; index: number } | null {
  for (let index = 0; index < menu.items.length; index += 1) {
    const item = menu.items[index];
    if (!item) continue;
    if (
      item.label === "Check for Updates…"
      || item.label === "Update Available…"
      || item.label === "Alpha Updates Require Setup…"
    ) return { menu, index };
    if (item.submenu) {
      const nested = findCodexDesktopUpdateMenuOwner(item.submenu);
      if (nested) return nested;
    }
  }
  return null;
}
