export interface SettingsNavigationTweak {
  id: string;
  name: string;
  version: string;
  description?: string;
  iconUrl?: string;
  enabled: boolean;
  status: string;
  healthError?: string | null;
  lifecycleOverride?: SettingsNavigationLifecycle;
}

export interface SettingsPageRegistrationSummary {
  id: string;
  tweakId: string;
  title: string;
  description?: string;
  iconSvg?: string;
}

export type SettingsNavigationLifecycle =
  | "enabled"
  | "failed"
  | "quarantined"
  | "starting"
  | "timed_out";

export interface SettingsNavigationItem {
  tweakId: string;
  title: string;
  version: string;
  description: string;
  iconUrl?: string;
  iconSvg?: string;
  registrationIds: string[];
  fallback: boolean;
  lifecycle: SettingsNavigationLifecycle;
  warning: string | null;
}

export interface SettingsSidebarEvidence {
  width: number;
  height: number;
  left: number;
  viewportWidth: number;
  forbiddenSurface: boolean;
  nativePanelSlugCount: number;
  coreLabelCount: number;
  totalLabelCount: number;
  mainAppLabelCount: number;
  settingsOnlyLabelCount: number;
}

export function hasNativeSettingsSidebarOwnership(
  evidence: Pick<SettingsSidebarEvidence, "forbiddenSurface" | "nativePanelSlugCount">,
): boolean {
  return !evidence.forbiddenSurface && evidence.nativePanelSlugCount >= 1;
}

export function isNativeSettingsSidebarEvidence(evidence: SettingsSidebarEvidence): boolean {
  if (!hasNativeSettingsSidebarOwnership(evidence)) return false;
  // Establish ownership from multiple independent native rows. Once mounted,
  // the injector may retain the verified root with one row while search filters.
  if (evidence.nativePanelSlugCount < 2) return false;
  if (evidence.width < 120 || evidence.width > 620) return false;
  if (evidence.height < 80) return false;
  if (evidence.left > evidence.viewportWidth * 0.65) return false;
  if (evidence.mainAppLabelCount >= 2 && evidence.settingsOnlyLabelCount === 0) return false;
  return evidence.coreLabelCount >= 2 && evidence.totalLabelCount >= 3;
}

export function buildSettingsNavigationModel(
  tweaks: SettingsNavigationTweak[],
  registrations: SettingsPageRegistrationSummary[],
): SettingsNavigationItem[] {
  const registrationsByTweak = new Map<string, SettingsPageRegistrationSummary[]>();
  for (const registration of registrations) {
    const group = registrationsByTweak.get(registration.tweakId) ?? [];
    group.push(registration);
    registrationsByTweak.set(registration.tweakId, group);
  }

  const rows: SettingsNavigationItem[] = [];
  const seen = new Set<string>();
  for (const tweak of tweaks) {
    if (!tweak.enabled || seen.has(tweak.id)) continue;
    seen.add(tweak.id);
    const pages = registrationsByTweak.get(tweak.id) ?? [];
    const primary = pages[0];
    rows.push({
      tweakId: tweak.id,
      title: primary?.title || tweak.name,
      version: tweak.version,
      description: primary?.description || tweak.description || "Enabled Tweaker.",
      iconUrl: tweak.iconUrl,
      iconSvg: primary?.iconSvg,
      registrationIds: pages.map((page) => page.id),
      fallback: pages.length === 0,
      lifecycle: lifecycleFor(tweak),
      warning: tweak.healthError || null,
    });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title) || a.tweakId.localeCompare(b.tweakId));
}

function lifecycleFor(tweak: SettingsNavigationTweak): SettingsNavigationLifecycle {
  if (tweak.lifecycleOverride) return tweak.lifecycleOverride;
  if (tweak.status === "failed") return "failed";
  if (tweak.status === "quarantined") return "quarantined";
  if (tweak.status === "starting") return "starting";
  if (tweak.status === "timed_out") return "timed_out";
  return "enabled";
}
