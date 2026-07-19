export interface CodexDesktopUpdateMenuItemLike {
  label: string;
  enabled?: boolean;
  submenu?: CodexDesktopUpdateMenuLike | null;
}

export interface CodexDesktopUpdateMenuLike {
  items: CodexDesktopUpdateMenuItemLike[];
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
