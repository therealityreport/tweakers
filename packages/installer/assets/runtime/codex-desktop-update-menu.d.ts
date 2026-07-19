export interface CodexDesktopUpdateMenuItemLike {
    label: string;
    enabled?: boolean;
    submenu?: CodexDesktopUpdateMenuLike | null;
}
export interface CodexDesktopUpdateMenuLike {
    items: CodexDesktopUpdateMenuItemLike[];
}
/** Updates OpenAI's existing item in place, preserving its original click action. */
export declare function syncCodexDesktopUpdateMenuLabel(menu: CodexDesktopUpdateMenuLike, updateAvailable: boolean, onManualCheck?: (...args: unknown[]) => void, alphaSetupRequired?: boolean): boolean;
