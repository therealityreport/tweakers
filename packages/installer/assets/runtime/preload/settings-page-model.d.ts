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
export type SettingsNavigationLifecycle = "enabled" | "failed" | "quarantined" | "starting" | "timed_out";
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
export declare function hasNativeSettingsSidebarOwnership(evidence: Pick<SettingsSidebarEvidence, "forbiddenSurface" | "nativePanelSlugCount">): boolean;
export declare function isNativeSettingsSidebarEvidence(evidence: SettingsSidebarEvidence): boolean;
export declare function buildSettingsNavigationModel(tweaks: SettingsNavigationTweak[], registrations: SettingsPageRegistrationSummary[]): SettingsNavigationItem[];
