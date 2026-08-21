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
export declare const ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID = "tweakers-environment-mode-cache-status";
export interface EnvironmentModeCacheMenuItemInput {
    id: typeof ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID;
    label: string;
    sublabel: string;
    enabled: false;
}
export declare function environmentModeCacheMenuPresentation(input: EnvironmentModeCacheMenuInput): EnvironmentModeCacheMenuPresentation;
/**
 * Upsert the observational sealed-pair row next to OpenAI's existing update
 * command. The caller owns MenuItem construction; this helper never polls,
 * prepares, pins, validates, or switches an environment.
 */
export declare function syncEnvironmentModeCacheMenuItem(menu: CodexDesktopUpdateMenuLike, input: EnvironmentModeCacheMenuInput, createItem: (input: EnvironmentModeCacheMenuItemInput) => CodexDesktopUpdateMenuItemLike): boolean;
export declare function environmentModeCacheMenuInputFromStatus(value: unknown): EnvironmentModeCacheMenuInput | null;
export declare function syncEnvironmentModeCacheMenuFromStatus(menu: CodexDesktopUpdateMenuLike, status: unknown, createItem: (input: EnvironmentModeCacheMenuItemInput) => CodexDesktopUpdateMenuItemLike): boolean;
/** Updates OpenAI's existing item in place, preserving its original click action. */
export declare function syncCodexDesktopUpdateMenuLabel(menu: CodexDesktopUpdateMenuLike, updateAvailable: boolean, onManualCheck?: (...args: unknown[]) => void, alphaSetupRequired?: boolean): boolean;
