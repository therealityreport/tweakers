import { createRendererStorage, type StorageLike } from "./renderer-storage";

export interface TopicTweak { manifest: { id: string; version: string }; enabled: boolean }
const UI = "co.tweakers.ui-improvements";
const PROJECTS = "co.tweakers.projects";
const LEGACY = [
  { id: "co.tweakers.titlebar-controls", owner: UI, feature: "titlebar-controls", major: 0, minor: 3 },
  { id: "co.tweakers.shadcn-codex-ui", owner: UI, feature: "rich-blocks", major: 0, minor: 3 },
  { id: "co.tweakers.thread-summary-profiles", owner: PROJECTS, feature: "threadSummaryProfiles", major: 0, minor: 8 },
] as const;

/** Main may accept delegation only for these versioned, enabled owners. */
export function topicMigrationOwner(id: string, tweaks: readonly TopicTweak[]): string | null {
  const migration = LEGACY.find(item => item.id === id);
  if (!migration || !tweaks.some(item => item.manifest.id === id)) return null;
  const owner = tweaks.find(item => item.manifest.id === migration.owner && item.enabled);
  if (!owner) return null;
  const [major, minor] = owner.manifest.version.split(".").map(Number);
  return Number.isFinite(major) && Number.isFinite(minor)
    && (major > migration.major || (major === migration.major && minor >= migration.minor))
    ? migration.owner : null;
}

/** Suppression follows successful persistence. Failed migrations leave legacy behavior available. */
export function consolidateTweakTopics(tweaks: readonly TopicTweak[], storage: StorageLike): Set<string> {
  const suppressed = new Set<string>();
  for (const migration of LEGACY) {
    const owner = tweaks.find(tweak => tweak.manifest.id === migration.owner);
    const legacy = tweaks.find(tweak => tweak.manifest.id === migration.id);
    if (!owner?.enabled || !legacy) continue;
    const [major, minor] = owner.manifest.version.split(".").map(Number);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || major < migration.major || (major === migration.major && minor < migration.minor)) continue;
    try {
      const destination = createRendererStorage(migration.owner, storage);
      const source = createRendererStorage(migration.id, storage);
      // An explicit supported destination toggle already owns activation. No
      // legacy read/write is needed, including when legacy storage is conflicted.
      const existingUi = destination.get<unknown>("enabledImprovements");
      const destinationOwnsFeature = migration.owner === UI
        ? record(existingUi) && [1, 2, 3, 4].includes(existingUi.version as number)
          && record(existingUi.enabled) && typeof existingUi.enabled[migration.feature] === "boolean"
        : typeof destination.get("threadSummaryProfiles") === "boolean";
      if (destinationOwnsFeature) { suppressed.add(migration.id); continue; }
      if (destination.migration.holdPromotion || source.migration.holdPromotion) continue;
      let enabled = legacy.enabled;
      if (migration.feature === "rich-blocks") enabled &&= source.get<boolean>("enabled", true) !== false;
      if (migration.owner === UI) {
        const settings = destination.get<unknown>("enabledImprovements", {});
        if (!record(settings)) continue;
        if (settings.version !== undefined && ![1, 2, 3, 4].includes(settings.version as number)) continue;
        const toggles = settings.enabled ?? {};
        if (!record(toggles)) continue;
        if (typeof toggles[migration.feature] !== "boolean" || settings.version === undefined) {
          destination.set("enabledImprovements", { ...settings, version: 4, enabled: { ...toggles, [migration.feature]: typeof toggles[migration.feature] === "boolean" ? toggles[migration.feature] : enabled } });
        }
      } else if (typeof destination.get("threadSummaryProfiles") !== "boolean") {
        destination.set("threadSummaryProfiles", enabled);
      }
      suppressed.add(migration.id);
    } catch { /* Quota/invalid data must not disable the old implementation. */ }
  }
  return suppressed;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
