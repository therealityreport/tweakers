"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TWEAKS_PAGE_FILTERS = void 0;
exports.tweaksPageCounts = tweaksPageCounts;
exports.filterTweaksPageItems = filterTweaksPageItems;
exports.matchesTweaksPageFilter = matchesTweaksPageFilter;
exports.tweaksPageSearchText = tweaksPageSearchText;
exports.TWEAKS_PAGE_FILTERS = [
    "all",
    "enabled",
    "disabled",
    "updates",
];
function tweaksPageCounts(items) {
    return {
        all: items.length,
        enabled: items.filter((item) => matchesTweaksPageFilter(item, "enabled")).length,
        disabled: items.filter((item) => matchesTweaksPageFilter(item, "disabled")).length,
        updates: items.filter((item) => matchesTweaksPageFilter(item, "updates")).length,
    };
}
function filterTweaksPageItems(items, filter, query) {
    const normalizedQuery = normalizeTweaksPageSearch(query);
    return items.filter((item) => {
        if (!matchesTweaksPageFilter(item, filter))
            return false;
        if (!normalizedQuery)
            return true;
        return tweaksPageSearchText(item).includes(normalizedQuery);
    });
}
function matchesTweaksPageFilter(item, filter) {
    if (filter === "enabled")
        return item.installed && item.enabled;
    if (filter === "disabled")
        return item.installed && !item.enabled;
    if (filter === "updates")
        return item.update?.updateAvailable === true;
    return true;
}
function tweaksPageSearchText(item) {
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
function normalizeTweaksPageSearch(value) {
    return value
        .toLocaleLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\u2018\u2019`\u00b4]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
//# sourceMappingURL=tweaks-page-model.js.map