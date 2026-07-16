"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSettingsNavigationModel = buildSettingsNavigationModel;
function buildSettingsNavigationModel(tweaks, registrations) {
    const registrationsByTweak = new Map();
    for (const registration of registrations) {
        const group = registrationsByTweak.get(registration.tweakId) ?? [];
        group.push(registration);
        registrationsByTweak.set(registration.tweakId, group);
    }
    const rows = [];
    const seen = new Set();
    for (const tweak of tweaks) {
        if (!tweak.enabled || seen.has(tweak.id))
            continue;
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
function lifecycleFor(tweak) {
    if (tweak.lifecycleOverride)
        return tweak.lifecycleOverride;
    if (tweak.status === "failed")
        return "failed";
    if (tweak.status === "quarantined")
        return "quarantined";
    if (tweak.status === "starting")
        return "starting";
    if (tweak.status === "timed_out")
        return "timed_out";
    return "enabled";
}
//# sourceMappingURL=settings-page-model.js.map