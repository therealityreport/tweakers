import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import type { TweakStatus } from "../tweak-store";
export type TweaksPageFilter = "all" | "enabled" | "disabled" | "updates";
export interface TweaksPageItem {
    manifest: TweakManifest;
    installed: boolean;
    enabled: boolean;
    status: TweakStatus;
    update: {
        updateAvailable: boolean;
    } | null;
}
export type TweaksPageCounts = Record<TweaksPageFilter, number>;
export declare const TWEAKS_PAGE_FILTERS: readonly TweaksPageFilter[];
export declare function tweaksPageCounts(items: readonly TweaksPageItem[]): TweaksPageCounts;
export declare function filterTweaksPageItems<T extends TweaksPageItem>(items: readonly T[], filter: TweaksPageFilter, query: string): T[];
export declare function matchesTweaksPageFilter(item: TweaksPageItem, filter: TweaksPageFilter): boolean;
export declare function tweaksPageSearchText(item: TweaksPageItem): string;
