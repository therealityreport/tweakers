import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import type { TweakStatus } from "../tweak-store";

export type TweaksPageFilter = "all" | "enabled" | "disabled" | "updates";

export interface TweaksPageItem {
  manifest: TweakManifest;
  installed: boolean;
  enabled: boolean;
  status: TweakStatus;
  update: { updateAvailable: boolean } | null;
}

export type TweaksPageCounts = Record<TweaksPageFilter, number>;

export const TWEAKS_PAGE_FILTERS: readonly TweaksPageFilter[] = [
  "all",
  "enabled",
  "disabled",
  "updates",
];

export function tweaksPageCounts(items: readonly TweaksPageItem[]): TweaksPageCounts {
  return {
    all: items.length,
    enabled: items.filter((item) => matchesTweaksPageFilter(item, "enabled")).length,
    disabled: items.filter((item) => matchesTweaksPageFilter(item, "disabled")).length,
    updates: items.filter((item) => matchesTweaksPageFilter(item, "updates")).length,
  };
}

export function filterTweaksPageItems<T extends TweaksPageItem>(
  items: readonly T[],
  filter: TweaksPageFilter,
  query: string,
): T[] {
  const normalizedQuery = normalizeTweaksPageSearch(query);
  return items.filter((item) => {
    if (!matchesTweaksPageFilter(item, filter)) return false;
    if (!normalizedQuery) return true;
    return tweaksPageSearchText(item).includes(normalizedQuery);
  });
}

export function matchesTweaksPageFilter(
  item: TweaksPageItem,
  filter: TweaksPageFilter,
): boolean {
  if (filter === "enabled") return item.installed && item.enabled;
  if (filter === "disabled") return item.installed && !item.enabled;
  if (filter === "updates") return item.update?.updateAvailable === true;
  return true;
}

export function tweaksPageSearchText(item: TweaksPageItem): string {
  const author = typeof item.manifest.author === "string"
    ? item.manifest.author
    : item.manifest.author?.name;
  return normalizeTweaksPageSearch([
    item.manifest.name,
    item.manifest.description,
    author,
    item.manifest.githubRepo,
    item.manifest.homepage,
    item.manifest.version,
    ...(item.manifest.tags ?? []),
    item.status,
    item.enabled ? "enabled" : "disabled",
    item.update?.updateAvailable ? "update available" : "",
  ].filter(Boolean).join(" "));
}

function normalizeTweaksPageSearch(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019`\u00b4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
