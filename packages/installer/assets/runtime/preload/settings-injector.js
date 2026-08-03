"use strict";
/**
 * Settings injector for Codex's Settings page.
 *
 * Codex's settings is a routed page (URL stays at `/index.html?hostId=local`)
 * NOT a modal dialog. The sidebar lives inside a `<div class="flex flex-col
 * gap-1 gap-0">` wrapper that holds one or more `<div class="flex flex-col
 * gap-px">` groups of buttons. There are no stable `role` / `aria-label` /
 * `data-testid` hook on the shell. Native settings rows do expose stable
 * `data-settings-panel-slug` markers, so those own the surface and localized
 * item labels only rank candidates inside that surface.
 *
 * Layout we inject:
 *
 *   GENERAL                       (uppercase group label)
 *   [Codex's existing items group]
 *   TWEAKERS                      (uppercase group label)
 *   ⓘ Config
 *   ☰ Tweaks
 *   ◇ Tweak Store
 *
 * Clicking Config / Tweaks / Tweak Store hides Codex's content panel children and renders
 * our own `main-surface` panel in their place. Clicking any of Codex's
 * sidebar items restores the original view.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startSettingsInjector = startSettingsInjector;
exports.stopSettingsInjector = stopSettingsInjector;
exports.registerSection = registerSection;
exports.clearSections = clearSections;
exports.registerPage = registerPage;
exports.setListedTweaks = setListedTweaks;
exports.updateListedTweakLifecycle = updateListedTweakLifecycle;
const electron_1 = require("electron");
const tweak_store_1 = require("../tweak-store");
const settings_page_model_1 = require("./settings-page-model");
const tweaks_page_model_1 = require("./tweaks-page-model");
const environment_config_controller_1 = require("./environment-config-controller");
const settings_probe_scheduler_1 = require("./settings-probe-scheduler");
const TWEAKERS_RELEASES_URL = "https://github.com/therealityreport/tweakers/releases";
const state = {
    sections: new Map(),
    sectionTokens: new Map(),
    pages: new Map(),
    listedTweaks: [],
    outerWrapper: null,
    nativeNavHeader: null,
    navGroup: null,
    navButtons: null,
    tweakerUpdateButton: null,
    pagesGroup: null,
    pagesGroupKey: null,
    pageNavButtons: new Map(),
    panelHost: null,
    observer: null,
    observerTarget: null,
    probeScheduler: null,
    installedRuntimeFingerprint: null,
    sourceRuntimeFingerprint: null,
    runtimeFingerprintDrift: null,
    fingerprint: null,
    sidebarDumped: false,
    activePage: null,
    sidebarRoot: null,
    sidebarRestoreHandler: null,
    settingsSurfaceVisible: false,
    settingsSurfaceHideTimer: null,
    sidebarProbeStatus: null,
    tweakStore: null,
    tweakStorePromise: null,
    tweakStoreError: null,
    tweaksPageFilter: "all",
    tweaksPageQuery: "",
};
let activeBuiltinPageCleanup = null;
const originalHistoryMethods = {};
function plog(msg, extra) {
    electron_1.ipcRenderer.send("tweaker:preload-log", "info", `[settings-injector] ${msg}${extra === undefined ? "" : " " + safeStringify(extra)}`);
}
function safeStringify(v) {
    try {
        return typeof v === "string" ? v : JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}
// ───────────────────────────────────────────────────────────── public API ──
function startSettingsInjector() {
    if (state.probeScheduler)
        return;
    state.probeScheduler = new settings_probe_scheduler_1.SettingsProbeScheduler({
        probe: runSettingsProbe,
        onProbe: (outcome) => {
            scopeSettingsObserver(outcome);
            publishSettingsInjectorDiagnostics();
        },
        onProbeError: (error) => {
            plog("scheduler probe failed; retrying", {
                error: error instanceof Error ? error.message : safeStringify(error),
            });
        },
    });
    scopeSettingsObserver("missing");
    publishSettingsInjectorDiagnostics();
    void electron_1.ipcRenderer
        .invoke("tweaker:get-runtime-fingerprint")
        .then((result) => {
        const snapshot = result;
        const fingerprint = snapshot?.installedRuntimeFingerprint;
        state.installedRuntimeFingerprint =
            typeof fingerprint === "string" ? fingerprint : null;
        state.sourceRuntimeFingerprint =
            typeof snapshot?.sourceRuntimeFingerprint === "string"
                ? snapshot.sourceRuntimeFingerprint
                : null;
        state.runtimeFingerprintDrift =
            typeof snapshot?.runtimeFingerprintDrift === "boolean"
                ? snapshot.runtimeFingerprintDrift
                : null;
        publishSettingsInjectorDiagnostics();
        plog("diagnostics ready", {
            ...state.probeScheduler?.metrics(),
            installedRuntimeFingerprint: state.installedRuntimeFingerprint,
            sourceRuntimeFingerprint: state.sourceRuntimeFingerprint,
            runtimeFingerprintDrift: state.runtimeFingerprintDrift,
        });
    })
        .catch(() => { });
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    document.addEventListener("click", onDocumentClick, true);
    window.addEventListener("pagehide", stopSettingsInjector, { once: true });
    for (const m of ["pushState", "replaceState"]) {
        const orig = history[m];
        originalHistoryMethods[m] = orig;
        history[m] = function (...args) {
            const r = orig.apply(this, args);
            window.dispatchEvent(new Event(`tweaker-${m}`));
            return r;
        };
        window.addEventListener(`tweaker-${m}`, onNav);
    }
    state.probeScheduler.request({ immediate: true, resetBackoff: true });
}
function stopSettingsInjector() {
    const metrics = state.probeScheduler?.metrics() ?? null;
    state.probeScheduler?.stop();
    state.probeScheduler = null;
    state.observer?.disconnect();
    state.observer = null;
    state.observerTarget = null;
    if (state.settingsSurfaceHideTimer) {
        clearTimeout(state.settingsSurfaceHideTimer);
        state.settingsSurfaceHideTimer = null;
    }
    window.removeEventListener("popstate", onNav);
    window.removeEventListener("hashchange", onNav);
    document.removeEventListener("click", onDocumentClick, true);
    window.removeEventListener("pagehide", stopSettingsInjector);
    for (const m of ["pushState", "replaceState"]) {
        window.removeEventListener(`tweaker-${m}`, onNav);
        const original = originalHistoryMethods[m];
        if (original)
            history[m] = original;
        delete originalHistoryMethods[m];
    }
    plog("scheduler stopped", {
        ...(metrics ?? {}),
        installedRuntimeFingerprint: state.installedRuntimeFingerprint,
        sourceRuntimeFingerprint: state.sourceRuntimeFingerprint,
        runtimeFingerprintDrift: state.runtimeFingerprintDrift,
    });
}
function onNav() {
    state.fingerprint = null;
    state.sidebarRoot = null;
    scopeSettingsObserver("missing");
    state.probeScheduler?.request({ immediate: true, resetBackoff: true });
}
function onDocumentClick(e) {
    const target = e.target instanceof Element ? e.target : null;
    const control = target?.closest("[role='link'],button,a");
    if (!(control instanceof HTMLElement))
        return;
    if (compactSettingsText(control.textContent || "") !== "Back to app")
        return;
    setTimeout(() => {
        setSettingsSurfaceVisible(false, "back-to-app");
        state.sidebarRoot = null;
        scopeSettingsObserver("missing");
        state.probeScheduler?.request({ immediate: true, resetBackoff: true });
    }, 0);
}
function runSettingsProbe() {
    const outcome = tryInject();
    maybeDumpDom();
    return outcome;
}
function scopeSettingsObserver(_outcome) {
    // Keep this observer anchored above the routed sidebar. React can replace
    // the entire root without a history event, which a root-scoped observer
    // cannot observe after that root has been detached.
    const target = document.documentElement;
    if (state.observer && state.observerTarget === target)
        return;
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => {
        const sidebarRoot = state.sidebarRoot;
        if (sidebarRoot && !sidebarRoot.isConnected) {
            state.sidebarRoot = null;
            state.fingerprint = null;
            state.probeScheduler?.request({ immediate: true, resetBackoff: true });
            return;
        }
        state.probeScheduler?.request();
    });
    state.observer.observe(target, { childList: true, subtree: true });
    state.observerTarget = target;
}
function publishSettingsInjectorDiagnostics() {
    const metrics = state.probeScheduler?.metrics() ?? {
        requestCount: 0,
        coalescedRequestCount: 0,
        backoffEventCount: 0,
        activeTimerCount: 0,
        probeCount: 0,
        cumulativeProbeTimeMs: 0,
        consecutiveMisses: 0,
        currentBackoffMs: 0,
        lastOutcome: null,
    };
    try {
        window.__tweakerSettingsInjectorDiagnostics = {
            ...metrics,
            installedRuntimeFingerprint: state.installedRuntimeFingerprint,
            sourceRuntimeFingerprint: state.sourceRuntimeFingerprint,
            runtimeFingerprintDrift: state.runtimeFingerprintDrift,
        };
    }
    catch { }
}
function registerSection(section) {
    const registrationToken = Symbol(section.id);
    state.sections.set(section.id, section);
    state.sectionTokens.set(section.id, registrationToken);
    if (state.activePage?.kind === "tweaks")
        rerender();
    return {
        unregister: () => {
            if (state.sectionTokens.get(section.id) !== registrationToken)
                return;
            state.sections.delete(section.id);
            state.sectionTokens.delete(section.id);
            if (state.activePage?.kind === "tweaks")
                rerender();
        },
    };
}
function clearSections() {
    state.sections.clear();
    state.sectionTokens.clear();
    // Drop registered pages too — they're owned by tweaks that just got
    // torn down by the host. Run any teardowns before forgetting them.
    for (const p of state.pages.values()) {
        try {
            p.teardown?.();
        }
        catch (e) {
            plog("page teardown failed", { id: p.id, err: String(e) });
        }
    }
    state.pages.clear();
    syncPagesGroup();
    // Explicit pages may disappear briefly during a hot reload. Keep the stable
    // tweak-level page active and render its fallback instead of ejecting the
    // user from Settings.
    if (state.activePage?.kind === "registered" &&
        !settingsNavigationItem(state.activePage.id)) {
        restoreCodexView();
    }
    else if (state.activePage?.kind === "registered") {
        rerender();
    }
    else if (state.activePage?.kind === "tweaks") {
        rerender();
    }
}
/**
 * Register a tweak-owned settings page. The runtime injects a sidebar entry
 * under a "TWEAKS" group header (which appears only when at least one page
 * is registered) and routes clicks to the page's `render(root)`.
 */
function registerPage(tweakId, manifest, page) {
    const id = page.id; // already namespaced by tweak-host as `${tweakId}:${page.id}`
    const existing = state.pages.get(id);
    if (existing) {
        try {
            existing.teardown?.();
        }
        catch { }
    }
    const registrationToken = Symbol(id);
    const entry = { id, tweakId, manifest, page, registrationToken };
    state.pages.set(id, entry);
    plog("registerPage", { id, title: page.title, tweakId });
    syncPagesGroup();
    // If the user was already on this page (hot reload), re-mount its body.
    if (state.activePage?.kind === "registered" && state.activePage.id === tweakId) {
        rerender();
    }
    return {
        unregister: () => {
            const e = state.pages.get(id);
            if (!e || e.registrationToken !== registrationToken)
                return;
            try {
                e.teardown?.();
            }
            catch { }
            state.pages.delete(id);
            syncPagesGroup();
            if (state.activePage?.kind === "registered" && state.activePage.id === tweakId)
                rerender();
        },
    };
}
/** Called by the tweak host after fetching the tweak list from main. */
function setListedTweaks(list) {
    state.listedTweaks = list;
    syncPagesGroup();
    if (state.activePage?.kind === "registered" && !settingsNavigationItem(state.activePage.id)) {
        restoreCodexView();
    }
    else if (state.activePage?.kind === "registered") {
        rerender();
    }
    if (state.activePage?.kind === "tweaks")
        rerender();
}
function updateListedTweakLifecycle(id, lifecycle, error) {
    const tweak = state.listedTweaks.find((item) => item.manifest.id === id);
    if (!tweak)
        return;
    tweak.lifecycleOverride = lifecycle;
    if (error)
        tweak.health = { status: lifecycle === "quarantined" ? "quarantined" : "failed", updatedAt: new Date().toISOString(), error };
    else if (lifecycle === "starting" || lifecycle === "enabled")
        tweak.health = null;
    syncPagesGroup();
    if (state.activePage?.kind === "registered" && state.activePage.id === id)
        rerender();
}
function settingsNavigationItems() {
    return (0, settings_page_model_1.buildSettingsNavigationModel)(state.listedTweaks.map((tweak) => ({
        id: tweak.manifest.id,
        name: tweak.manifest.name,
        version: tweak.manifest.version,
        description: tweak.manifest.description,
        iconUrl: tweak.manifest.iconUrl,
        enabled: tweak.enabled,
        status: tweak.status,
        healthError: tweak.health?.error ?? null,
        lifecycleOverride: tweak.lifecycleOverride,
    })), [...state.pages.values()].map((entry) => ({
        id: entry.id,
        tweakId: entry.tweakId,
        title: entry.page.title,
        description: entry.page.description,
        iconSvg: entry.page.iconSvg,
    })));
}
function settingsNavigationItem(tweakId) {
    return settingsNavigationItems().find((item) => item.tweakId === tweakId) ?? null;
}
function registeredPagesForTweak(tweakId) {
    return [...state.pages.values()].filter((entry) => entry.tweakId === tweakId);
}
function lifecycleLabel(lifecycle, warning) {
    const label = lifecycle === "enabled" ? "Running"
        : lifecycle === "timed_out" ? "Startup timed out"
            : lifecycle[0].toUpperCase() + lifecycle.slice(1);
    return warning ? `${label}: ${warning}` : label;
}
// ───────────────────────────────────────────────────────────── injection ──
function tryInject() {
    if (isNavGroupInjectionSuppressed())
        return "suppressed";
    removeMisplacedSettingsGroups();
    const itemsGroup = state.sidebarRoot?.isConnected === true
        ? state.sidebarRoot
        : findSidebarItemsGroup();
    if (!itemsGroup) {
        scheduleSettingsSurfaceHidden();
        // The coalescing scheduler continues bounded probes; log only the transition
        // into this state so repeated misses never flood preload.log.
        recordSidebarProbeTransition("missing");
        return "missing";
    }
    if (state.settingsSurfaceHideTimer) {
        clearTimeout(state.settingsSurfaceHideTimer);
        state.settingsSurfaceHideTimer = null;
    }
    setSettingsSurfaceVisible(true, "sidebar-found");
    // Keep native and Tweakers entries in the same scroll container. Appending
    // to the parent created a second independently scrolling sidebar region.
    const outer = itemsGroup;
    if (!isSettingsSidebarCandidate(itemsGroup)) {
        scheduleSettingsSurfaceHidden();
        // Same transition-only throttling as the "sidebar not found" branch.
        recordSidebarProbeTransition("rejected", {
            itemsGroup: describe(itemsGroup),
            outer: describe(outer),
        });
        return "rejected";
    }
    // Success transition already logs via setSettingsSurfaceVisible("sidebar-found").
    recordSidebarProbeTransition("found", { outer: describe(outer) });
    state.sidebarRoot = outer;
    syncNativeSettingsHeader(itemsGroup, outer);
    bindSettingsSearch(outer);
    if (state.navGroup && outer.contains(state.navGroup)) {
        syncPagesGroup();
        // Codex re-renders its native sidebar buttons on its own state changes.
        // If one of our pages is active, re-strip Codex's active styling so
        // General doesn't reappear as selected.
        if (state.activePage !== null)
            syncCodexNativeNavActive(true);
        return "found";
    }
    // Sidebar was either freshly mounted (Settings just opened) or re-mounted
    // (closed and re-opened, or navigated away and back). In all of those
    // cases Codex resets to its default page (General), but our in-memory
    // `activePage` may still reference the last tweak/page the user had open
    // — which would cause that nav button to render with the active styling
    // even though Codex is showing General. Clear it so `syncPagesGroup` /
    // `setNavActive` start from a neutral state. The panelHost reference is
    // also stale (its DOM was discarded with the previous content area).
    if (state.activePage !== null || state.panelHost !== null) {
        plog("sidebar re-mount detected; clearing stale active state", {
            prevActive: state.activePage,
        });
        state.activePage = null;
        state.panelHost = null;
    }
    const existingTweakerNavGroup = outer.querySelector(':scope > [data-tweaker="nav-group"]') ??
        outer.querySelector('[data-tweaker="nav-group"]');
    if (existingTweakerNavGroup) {
        state.navGroup = existingTweakerNavGroup;
        state.tweakerUpdateButton = existingTweakerNavGroup.querySelector("[data-tweaker-sidebar-update]");
        state.sidebarRoot = outer;
        syncPagesGroup();
        refreshSidebarTweakerUpdateButton();
        if (state.activePage !== null)
            syncCodexNativeNavActive(true);
        return "found";
    }
    // ── Group container ───────────────────────────────────────────────────
    const group = document.createElement("div");
    group.dataset.tweaker = "nav-group";
    group.className = "flex flex-col gap-px";
    const updateButton = sidebarUpdatePillButton();
    state.tweakerUpdateButton = updateButton;
    group.appendChild(sidebarGroupHeader("Tweakers", "pt-3", updateButton));
    refreshSidebarTweakerUpdateButton();
    // ── Sidebar items ────────────────────────────────────────────────────
    const configBtn = makeSidebarItem("Config", configIconSvg());
    const tweaksBtn = makeSidebarItem("Tweaks", tweaksIconSvg());
    configBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        activatePage({ kind: "config" });
    });
    tweaksBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        activatePage({ kind: "tweaks" });
    });
    group.appendChild(configBtn);
    group.appendChild(tweaksBtn);
    outer.appendChild(group);
    state.navGroup = group;
    state.navButtons = { config: configBtn, tweaks: tweaksBtn };
    noteNavGroupInjection(outer);
    syncPagesGroup();
    return "found";
}
function recordSidebarProbeTransition(outcome, detail) {
    if (state.sidebarProbeStatus === outcome)
        return;
    state.sidebarProbeStatus = outcome;
    if (outcome === "missing") {
        plog("sidebar not found");
    }
    else if (outcome === "rejected") {
        plog("rejected non-settings sidebar candidate", detail);
    }
    else {
        plog("sidebar found", detail);
    }
}
// Backstop against inject/remove feedback loops: if the nav group needs
// re-injection more than a few times in a short window, something is
// fighting us — back off instead of saturating the log and the CPU.
const NAV_GROUP_INJECTION_WINDOW_MS = 10_000;
const NAV_GROUP_INJECTION_LIMIT = 5;
const NAV_GROUP_INJECTION_BACKOFF_MS = 30_000;
let navGroupInjections = [];
let navGroupInjectionSuppressedUntil = 0;
function isNavGroupInjectionSuppressed() {
    return Date.now() < navGroupInjectionSuppressedUntil;
}
function noteNavGroupInjection(outer) {
    const now = Date.now();
    navGroupInjections = navGroupInjections.filter((at) => now - at < NAV_GROUP_INJECTION_WINDOW_MS);
    navGroupInjections.push(now);
    if (navGroupInjections.length > NAV_GROUP_INJECTION_LIMIT) {
        navGroupInjectionSuppressedUntil = now + NAV_GROUP_INJECTION_BACKOFF_MS;
        navGroupInjections = [];
        plog("nav group re-injection loop detected; backing off", {
            backoffMs: NAV_GROUP_INJECTION_BACKOFF_MS,
            outerTag: outer.tagName,
        });
        return;
    }
    plog("nav group injected", { outerTag: outer.tagName });
}
function syncNativeSettingsHeader(itemsGroup, outer) {
    if (state.nativeNavHeader && outer.contains(state.nativeNavHeader))
        return;
    const header = sidebarGroupHeader("General");
    header.dataset.tweaker = "native-nav-header";
    if (outer === itemsGroup)
        outer.prepend(header);
    else
        outer.insertBefore(header, itemsGroup);
    state.nativeNavHeader = header;
}
function bindSettingsSearch(root) {
    const input = root.closest("aside, nav, [role='navigation'], div")?.parentElement
        ?.querySelector("input[placeholder*='Search settings' i]")
        ?? document.querySelector("input[placeholder*='Search settings' i]");
    if (!input || input.dataset.tweakersSearchBound === "true")
        return;
    input.dataset.tweakersSearchBound = "true";
    input.addEventListener("input", () => {
        const query = input.value.trim().toLocaleLowerCase();
        for (const button of Array.from(root.querySelectorAll("button"))) {
            if (!button.closest("[data-tweaker]"))
                continue;
            button.hidden = !!query && !compactSettingsText(button.textContent ?? "").toLocaleLowerCase().includes(query);
        }
        for (const group of Array.from(root.querySelectorAll("[data-tweaker='nav-group'], [data-tweaker='pages-group']"))) {
            const buttons = Array.from(group.querySelectorAll("button"));
            group.hidden = buttons.length > 0 && buttons.every((button) => button.hidden);
        }
    });
}
function sidebarGroupHeader(text, topPadding = "pt-2", trailing) {
    const header = document.createElement("div");
    header.className =
        `px-row-x ${topPadding} pb-1 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wider text-token-description-foreground select-none`;
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = text;
    header.appendChild(label);
    if (trailing)
        header.appendChild(trailing);
    return header;
}
function scheduleSettingsSurfaceHidden() {
    if (!state.settingsSurfaceVisible || state.settingsSurfaceHideTimer)
        return;
    state.settingsSurfaceHideTimer = setTimeout(() => {
        state.settingsSurfaceHideTimer = null;
        const sidebar = findSidebarItemsGroup();
        if (sidebar && isSettingsSidebarCandidate(sidebar))
            return;
        if (isSettingsTextVisible())
            return;
        setSettingsSurfaceVisible(false, "sidebar-not-found");
    }, 1500);
}
function isSettingsTextVisible() {
    return nativeSettingsPanelSlugCount(document) >= 2;
}
function compactSettingsText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
}
const TWEAKER_CORE_SETTINGS_LABELS = [
    "General",
    "常规",
    "通用",
    "Appearance",
    "外观",
    "Configuration",
    "配置",
    "默认权限",
    "Personalization",
    "个性化",
].map(normalizeTweakerSettingsLabel);
const TWEAKER_EXTENDED_SETTINGS_LABELS = [
    "Account",
    "账户",
    "账号",
    "General",
    "常规",
    "通用",
    "Appearance",
    "外观",
    "Configuration",
    "配置",
    "默认权限",
    "Personalization",
    "个性化",
    "Keyboard shortcuts",
    "Archived chats",
    "Usage",
    "Computer use",
    "Browser use",
    "MCP servers",
    "MCP Servers",
    "MCP 服务器",
    "Git",
    "Environments",
    "环境",
    "Cloud Environments",
    "Worktrees",
    "Connections",
    "Plugins",
    "Skills",
].map(normalizeTweakerSettingsLabel);
const TWEAKER_SETTINGS_ONLY_LABELS = [
    "General",
    "常规",
    "通用",
    "Appearance",
    "外观",
    "Configuration",
    "配置",
    "默认权限",
    "Personalization",
    "个性化",
    "Keyboard shortcuts",
    "Archived chats",
    "Usage",
    "Computer use",
    "Browser use",
    "MCP servers",
    "MCP Servers",
    "MCP 服务器",
    "Git",
    "Environments",
    "环境",
    "Cloud Environments",
    "Worktrees",
    "Connections",
].map(normalizeTweakerSettingsLabel);
const TWEAKER_MAIN_APP_NAV_LABELS = [
    "New chat",
    "Quick chat",
    "快速对话",
    "Search",
    "搜索",
    "Plugins",
    "插件",
    "Automations",
    "Automation",
    "自动化",
    "Chats",
    "Chat",
    "对话",
    "Projects",
    "项目",
    "Pinned",
    "Settings",
    "设置",
    "Work locally",
].map(normalizeTweakerSettingsLabel);
function normalizeTweakerSettingsLabel(value) {
    return compactSettingsText(value)
        .toLocaleLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[’‘`´]/g, "'")
        .replace(/\s+/g, " ")
        .trim();
}
function tweakerControlLabel(el) {
    return normalizeTweakerSettingsLabel(el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent ||
        "");
}
function tweakerSettingsLabelsFrom(root) {
    const controls = Array.from(root.querySelectorAll("button,a,[role='button'],[role='link']"));
    return [
        ...new Set(controls
            .map(tweakerControlLabel)
            .filter(Boolean)),
    ];
}
function tweakerSettingsLabelScore(labels) {
    const core = new Set();
    const total = new Set();
    for (const label of labels) {
        for (const marker of TWEAKER_CORE_SETTINGS_LABELS) {
            if (tweakerLabelMatchesMarker(label, marker))
                core.add(marker);
        }
        for (const marker of TWEAKER_EXTENDED_SETTINGS_LABELS) {
            if (tweakerLabelMatchesMarker(label, marker))
                total.add(marker);
        }
    }
    return { core: core.size, total: total.size };
}
function tweakerLabelMatchesMarker(label, marker) {
    return label === marker || label.includes(marker);
}
function tweakerMarkerCount(labels, markers) {
    const matched = new Set();
    for (const label of labels) {
        for (const marker of markers) {
            if (tweakerLabelMatchesMarker(label, marker))
                matched.add(marker);
        }
    }
    return matched.size;
}
function nativeSettingsPanelSlugCount(root) {
    const slugs = new Set();
    for (const element of Array.from(root.querySelectorAll("[data-settings-panel-slug]"))) {
        if (element.closest("[data-tweaker]"))
            continue;
        const slug = element.dataset.settingsPanelSlug?.trim();
        if (slug)
            slugs.add(slug);
    }
    return slugs.size;
}
function tweakerVisibleBox(el) {
    if (!el.isConnected)
        return null;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden")
        return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0)
        return null;
    return rect;
}
function setSettingsSurfaceVisible(visible, reason) {
    if (state.settingsSurfaceVisible === visible)
        return;
    state.settingsSurfaceVisible = visible;
    if (visible)
        warmTweakStore();
    try {
        window.__tweakerSettingsSurfaceVisible = visible;
        document.documentElement.dataset.tweakerSettingsSurface = visible ? "true" : "false";
        window.dispatchEvent(new CustomEvent("tweaker:settings-surface", {
            detail: { visible, reason },
        }));
    }
    catch { }
    plog("settings surface", { visible, reason, url: location.href });
}
/**
 * Render (or re-render) the second sidebar group of per-tweak pages. The
 * group is created lazily and removed when the last page unregisters, so
 * users with no page-registering tweaks never see an empty "Tweaks" header.
 */
function syncPagesGroup() {
    const outer = state.sidebarRoot;
    if (!outer)
        return;
    if (!isSettingsSidebarCandidate(outer)) {
        state.sidebarRoot = null;
        state.pagesGroup = null;
        state.pagesGroupKey = null;
        state.pageNavButtons.clear();
        return;
    }
    const pages = settingsNavigationItems();
    // Build a deterministic fingerprint of the desired group state. If the
    // current DOM group already matches, this is a no-op — critical, because
    // syncPagesGroup is called on every MutationObserver tick and any DOM
    // write would re-trigger that observer (infinite loop, app freeze).
    const desiredKey = pages.length === 0
        ? "EMPTY"
        : pages.map((p) => `${p.tweakId}|${p.title}|${p.iconSvg ?? ""}|${p.lifecycle}`).join("\n");
    const groupAttached = !!state.pagesGroup && outer.contains(state.pagesGroup);
    if (state.pagesGroupKey === desiredKey && (pages.length === 0 ? !groupAttached : groupAttached)) {
        return;
    }
    if (pages.length === 0) {
        if (state.pagesGroup) {
            state.pagesGroup.remove();
            state.pagesGroup = null;
        }
        state.pageNavButtons.clear();
        state.pagesGroupKey = desiredKey;
        return;
    }
    let group = state.pagesGroup;
    if (!group || !outer.contains(group)) {
        group = document.createElement("div");
        group.dataset.tweaker = "pages-group";
        group.className = "flex flex-col gap-px";
        group.appendChild(sidebarGroupHeader("Tweaks", "pt-3"));
        outer.appendChild(group);
        state.pagesGroup = group;
    }
    else {
        // Strip prior buttons (keep the header at index 0).
        while (group.children.length > 1)
            group.removeChild(group.lastChild);
    }
    state.pageNavButtons.clear();
    for (const p of pages) {
        const icon = p.iconSvg ?? defaultPageIconSvg();
        const btn = makeSidebarItem(p.title, icon);
        btn.dataset.tweaker = `nav-page-${p.tweakId}`;
        btn.dataset.tweakerLifecycle = p.lifecycle;
        if (p.lifecycle !== "enabled")
            btn.title = lifecycleLabel(p.lifecycle, p.warning);
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            activatePage({ kind: "registered", id: p.tweakId });
        });
        state.pageNavButtons.set(p.tweakId, btn);
        group.appendChild(btn);
    }
    state.pagesGroupKey = desiredKey;
    plog("pages group synced", {
        count: pages.length,
        ids: pages.map((p) => p.tweakId),
    });
    // Reflect current active state across the rebuilt buttons.
    setNavActive(state.activePage);
}
// Force any injected icon SVG to a fixed box. Tweak-provided iconSvg markup may
// omit width/height (and viewBox alone lets an SVG expand to its intrinsic size,
// which rendered a page icon as a giant glyph). Inline styles beat conflicting
// attributes/CSS, so this cannot be defeated by the tweak's own markup.
function constrainSidebarIconSvg(icon, size = 20) {
    if (!icon)
        return;
    icon.setAttribute("width", String(size));
    icon.setAttribute("height", String(size));
    const style = icon.style;
    if (style) {
        style.width = `${size}px`;
        style.height = `${size}px`;
        style.flexShrink = "0";
    }
    icon.classList?.add("icon-sm", "inline-block", "shrink-0", "align-middle");
}
function makeSidebarItem(label, iconSvg) {
    // Class string copied verbatim from Codex's sidebar buttons (General etc).
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.tweaker = `nav-${label.toLowerCase()}`;
    btn.setAttribute("aria-label", label);
    btn.className =
        "focus-visible:outline-token-border relative px-row-x py-row-y cursor-interaction shrink-0 items-center overflow-hidden rounded-lg text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 gap-2 flex w-full hover:bg-token-list-hover-background font-normal";
    const inner = document.createElement("div");
    inner.className =
        "flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground";
    inner.innerHTML = `${iconSvg}<span class="truncate">${label}</span>`;
    constrainSidebarIconSvg(inner.querySelector("svg"));
    btn.appendChild(inner);
    return btn;
}
function appendSidebarStoreUpdateBadge(btn) {
    const inner = btn.firstElementChild;
    if (!inner)
        return;
    const badge = document.createElement("span");
    badge.dataset.tweakerStoreUpdateBadge = "true";
    badge.hidden = true;
    badge.title = "Installed tweaks with approved updates";
    badge.className = "inline-flex shrink-0 items-center justify-center";
    Object.assign(badge.style, {
        position: "absolute",
        right: "12px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: "1",
    });
    applyStoreUpdateBadgeStyle(badge, null);
    btn.appendChild(badge);
}
function setNavActive(active) {
    // Built-in (Config/Tweaks) buttons.
    if (state.navButtons) {
        const builtin = active?.kind === "config" ? "config" :
            active?.kind === "tweaks" ? "tweaks" :
                active?.kind === "store" ? "store" : null;
        for (const [key, btn] of Object.entries(state.navButtons)) {
            applyNavActive(btn, key === builtin);
        }
    }
    // One stable button per enabled tweak, regardless of how many sections it
    // registered or whether startup reached page registration at all.
    for (const [tweakId, button] of state.pageNavButtons) {
        const isActive = active?.kind === "registered" && active.id === tweakId;
        applyNavActive(button, isActive);
    }
    // Codex's own sidebar buttons (General, Appearance, etc). When one of
    // our pages is active, Codex still has aria-current="page" and the
    // active-bg class on whichever item it considered the route — typically
    // General. That makes both buttons look selected. Strip Codex's active
    // styling while one of ours is active; restore it when none is.
    syncCodexNativeNavActive(active !== null);
}
/**
 * Mute Codex's own active-state styling on its sidebar buttons. We don't
 * touch Codex's React state — when the user clicks a native item, Codex
 * re-renders the buttons and re-applies its own correct state, then our
 * sidebar-click listener fires `restoreCodexView` (which calls back into
 * `setNavActive(null)` and lets Codex's styling stand).
 *
 * `mute=true`  → strip aria-current and swap active bg → hover bg
 * `mute=false` → no-op (Codex's own re-render already restored things)
 */
function syncCodexNativeNavActive(mute) {
    if (!mute)
        return;
    const root = state.sidebarRoot;
    if (!root)
        return;
    const buttons = Array.from(root.querySelectorAll("button"));
    for (const btn of buttons) {
        // Skip our own buttons.
        if (btn.dataset.tweaker)
            continue;
        if (btn.getAttribute("aria-current") === "page") {
            btn.removeAttribute("aria-current");
        }
        if (btn.classList.contains("bg-token-list-hover-background")) {
            btn.classList.remove("bg-token-list-hover-background");
            btn.classList.add("hover:bg-token-list-hover-background");
        }
    }
}
function applyNavActive(btn, active) {
    const inner = btn.firstElementChild;
    if (active) {
        btn.classList.remove("hover:bg-token-list-hover-background", "font-normal");
        btn.classList.add("bg-token-list-hover-background");
        btn.setAttribute("aria-current", "page");
        if (inner) {
            inner.classList.remove("text-token-foreground");
            inner.classList.add("text-token-list-active-selection-foreground");
            inner
                .querySelector("svg")
                ?.classList.add("text-token-list-active-selection-icon-foreground");
        }
    }
    else {
        btn.classList.add("hover:bg-token-list-hover-background", "font-normal");
        btn.classList.remove("bg-token-list-hover-background");
        btn.removeAttribute("aria-current");
        if (inner) {
            inner.classList.add("text-token-foreground");
            inner.classList.remove("text-token-list-active-selection-foreground");
            inner
                .querySelector("svg")
                ?.classList.remove("text-token-list-active-selection-icon-foreground");
        }
    }
}
// ─────────────────────────────────────────────────────────── activation ──
function activatePage(page) {
    const content = findContentArea();
    if (!content) {
        plog("activate: content area not found");
        return;
    }
    state.activePage = page;
    plog("activate", { page });
    // Hide Codex's content children, show ours.
    for (const child of Array.from(content.children)) {
        if (child.dataset.tweaker === "tweaks-panel")
            continue;
        if (child.dataset.tweakerHidden === undefined) {
            child.dataset.tweakerHidden = child.style.display || "";
        }
        child.style.display = "none";
    }
    let panel = content.querySelector('[data-tweaker="tweaks-panel"]');
    if (!panel) {
        panel = document.createElement("div");
        panel.dataset.tweaker = "tweaks-panel";
        panel.style.cssText = "width:100%;height:100%;overflow:auto;";
        content.appendChild(panel);
    }
    panel.style.display = "block";
    state.panelHost = panel;
    rerender();
    setNavActive(page);
    // restore Codex's view. Re-register if needed.
    const sidebar = state.sidebarRoot;
    if (sidebar) {
        if (state.sidebarRestoreHandler) {
            sidebar.removeEventListener("click", state.sidebarRestoreHandler, true);
        }
        const handler = (e) => {
            const target = e.target;
            if (!target)
                return;
            if (state.navGroup?.contains(target))
                return; // our buttons
            if (state.pagesGroup?.contains(target))
                return; // our page buttons
            if (target.closest("[data-tweaker-settings-search]"))
                return;
            restoreCodexView();
        };
        state.sidebarRestoreHandler = handler;
        sidebar.addEventListener("click", handler, true);
    }
}
function restoreCodexView() {
    plog("restore codex view");
    const content = findContentArea();
    if (!content)
        return;
    teardownRenderedPages();
    if (state.panelHost)
        state.panelHost.style.display = "none";
    for (const child of Array.from(content.children)) {
        if (child === state.panelHost)
            continue;
        if (child.dataset.tweakerHidden !== undefined) {
            child.style.display = child.dataset.tweakerHidden;
            delete child.dataset.tweakerHidden;
        }
    }
    state.activePage = null;
    setNavActive(null);
    if (state.sidebarRoot && state.sidebarRestoreHandler) {
        state.sidebarRoot.removeEventListener("click", state.sidebarRestoreHandler, true);
        state.sidebarRestoreHandler = null;
    }
}
function rerender() {
    if (!state.activePage)
        return;
    const host = state.panelHost;
    if (!host)
        return;
    teardownRenderedPages();
    host.innerHTML = "";
    const ap = state.activePage;
    if (ap.kind === "registered") {
        const item = settingsNavigationItem(ap.id);
        if (!item) {
            restoreCodexView();
            return;
        }
        const entries = registeredPagesForTweak(ap.id);
        const root = panelShell(item.title, item.description);
        host.appendChild(root.outer);
        root.headerTitleActions.appendChild(tweakLifecycleBadge(item));
        if (item.warning)
            root.sectionsWrap.appendChild(tweakPageWarning(item.warning));
        if (!entries.length) {
            renderFallbackTweakPage(root.sectionsWrap, item);
            return;
        }
        for (const entry of entries) {
            const section = document.createElement("section");
            section.className = "flex flex-col gap-2";
            if (entries.length > 1)
                section.appendChild(sectionTitle(entry.page.title));
            const target = document.createElement("div");
            target.className = "flex flex-col gap-3";
            section.appendChild(target);
            root.sectionsWrap.appendChild(section);
            try {
                try {
                    entry.teardown?.();
                }
                catch { }
                entry.teardown = null;
                const ret = entry.page.render(target);
                if (typeof ret === "function")
                    entry.teardown = ret;
            }
            catch (e) {
                const err = document.createElement("div");
                err.className = "text-token-charts-red text-sm";
                err.textContent = `Error rendering page: ${e.message}`;
                target.appendChild(err);
            }
        }
        return;
    }
    const title = ap.kind === "tweaks" ? "Tweaks" :
        ap.kind === "store" ? "Tweak Store" : "Tweakers";
    const subtitle = ap.kind === "tweaks"
        ? "Manage your catalog entries and installed tweaks."
        : ap.kind === "store"
            ? "Install reviewed tweaks pinned to approved GitHub commits."
            : "Checking installed Tweakers version.";
    const root = panelShell(title, subtitle, ap.kind === "tweaks" ? { width: "plugins" } : undefined);
    host.appendChild(root.outer);
    if (ap.kind === "tweaks")
        activeBuiltinPageCleanup = renderTweaksPage(root.sectionsWrap);
    else if (ap.kind === "store")
        renderTweakStorePage(root.sectionsWrap, root.headerActions);
    else
        activeBuiltinPageCleanup = renderConfigPage(root.sectionsWrap, root.subtitle);
}
function teardownRenderedPages() {
    activeBuiltinPageCleanup?.();
    activeBuiltinPageCleanup = null;
    for (const entry of state.pages.values()) {
        if (!entry.teardown)
            continue;
        try {
            entry.teardown();
        }
        catch { }
        entry.teardown = null;
    }
}
// ───────────────────────────────────────────────────────────── pages ──
function tweakLifecycleBadge(item) {
    const badge = document.createElement("span");
    badge.className = "inline-flex items-center rounded-full border border-token-border bg-token-foreground/5 px-2 py-0.5 text-xs text-token-text-secondary";
    badge.textContent = `${item.version} · ${lifecycleLabel(item.lifecycle)}`;
    badge.title = `${item.version} · ${lifecycleLabel(item.lifecycle, item.warning)}`;
    return badge;
}
function tweakPageWarning(message) {
    const warning = document.createElement("div");
    warning.className = "rounded-lg border border-token-charts-yellow/30 bg-token-charts-yellow/10 p-3 text-sm text-token-text-primary";
    warning.textContent = message;
    return warning;
}
function renderFallbackTweakPage(root, item) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Status"));
    const card = roundedCard();
    card.appendChild(rowSimple("Version", item.version));
    card.appendChild(rowSimple("Lifecycle", lifecycleLabel(item.lifecycle, item.warning)));
    card.appendChild(rowSimple("Settings page", "This enabled Tweaker has not registered its custom page yet. Runtime status remains available here."));
    if (["failed", "quarantined", "timed_out"].includes(item.lifecycle)) {
        const row = document.createElement("div");
        row.className = "flex items-center justify-between gap-4 p-3";
        row.appendChild(rowCopy("Recovery", "Clear the failure and retry this Tweaker without removing its data."));
        const recover = compactButton("Recover", () => {
            recover.disabled = true;
            void electron_1.ipcRenderer.invoke("tweaker:recover-tweak", item.tweakId).finally(() => { recover.disabled = false; });
        });
        row.appendChild(recover);
        card.appendChild(row);
    }
    section.appendChild(card);
    root.appendChild(section);
}
function rowCopy(title, detail) {
    const copy = document.createElement("div");
    copy.className = "flex min-w-0 flex-col gap-1";
    const heading = document.createElement("div");
    heading.className = "text-sm text-token-text-primary";
    heading.textContent = title;
    const description = document.createElement("div");
    description.className = "text-sm text-token-text-secondary";
    description.textContent = detail;
    copy.append(heading, description);
    return copy;
}
function renderConfigPage(sectionsWrap, subtitle) {
    const cleanups = [];
    const cardUpdates = new environment_config_controller_1.ConfigCardUpdateCoordinator();
    cleanups.push(renderEnvironmentSection(sectionsWrap, cardUpdates));
    cleanups.push(renderDesktopUpdateSection(sectionsWrap, cardUpdates));
    cleanups.push(renderTweaksHealthSection(sectionsWrap, cardUpdates));
    cleanups.push(renderMcpIntegrationSection(sectionsWrap, cardUpdates));
    cleanups.push(renderAutomaticMaintenanceSection(sectionsWrap, cardUpdates));
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Tweakers Updates"));
    const card = roundedCard();
    card.dataset.tweakerConfigCard = "true";
    const loading = rowSimple("Loading update settings", "Checking current Tweakers configuration.");
    card.appendChild(loading);
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    void electron_1.ipcRenderer
        .invoke("tweaker:get-config")
        .then((config) => {
        if (subtitle) {
            subtitle.textContent = `You have Tweakers ${config.version} installed.`;
        }
        card.textContent = "";
        renderTweakerConfig(card, config);
    })
        .catch((e) => {
        if (subtitle)
            subtitle.textContent = "Could not load installed Tweakers version.";
        card.textContent = "";
        card.appendChild(rowSimple("Could not load update settings", String(e)));
    });
    renderAdvancedRuntimeSection(sectionsWrap);
    const maintenance = document.createElement("section");
    maintenance.className = "flex flex-col gap-2";
    maintenance.appendChild(sectionTitle("Maintenance"));
    const maintenanceCard = roundedCard();
    maintenanceCard.appendChild(uninstallRow());
    maintenanceCard.appendChild(reportBugRow());
    maintenance.appendChild(maintenanceCard);
    sectionsWrap.appendChild(maintenance);
    return () => {
        for (const cleanup of cleanups.splice(0)) {
            try {
                cleanup();
            }
            catch { }
        }
    };
}
/**
 * Codex-native environment controls. App experience and release profile are
 * deliberately independent selections: changing either one only stages a
 * pending value until the user chooses Apply & Restart.
 */
function renderEnvironmentSection(sectionsWrap, cardUpdates) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("App Mode & Desktop Release"));
    const card = roundedCard();
    card.dataset.tweakerEnvironmentCard = "true";
    card.appendChild(rowSimple("Loading environment", "Checking available app experiences and release profiles."));
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    let environment = null;
    let transaction = null;
    let externalBusy = false;
    let environmentActionError = null;
    let transactionPolling = null;
    let lastTransactionFetchFailed = false;
    const currentSelection = () => environment?.selected ?? null;
    const hasPendingChanges = () => environment !== null && environmentController.snapshot.hasPendingChanges;
    const isEnvironmentBusy = () => externalBusy || environmentController.snapshot.busy;
    const restorePersistedRequest = () => {
        if (!transaction || (transaction.phase !== "preparing" && transaction.phase !== "prepared"))
            return;
        const requested = environmentTransactionRequestedSelection(transaction);
        if (requested)
            environmentController.restorePending(requested);
    };
    const scheduleEnvironmentTransactionPoll = () => {
        if (transactionPolling)
            clearTimeout(transactionPolling);
        transactionPolling = null;
        if (!card.isConnected)
            return;
        // A null transaction after a FAILED fetch must not end polling: a
        // transiently failing `environment transaction --json` would otherwise
        // hide an in-flight or stranded receipt until the tab is re-mounted.
        if (!transaction && !lastTransactionFetchFailed)
            return;
        if (transaction && environmentTransactionIsTerminal(transaction.phase))
            return;
        transactionPolling = setTimeout(() => {
            transactionPolling = null;
            void loadEnvironmentTransaction();
        }, lastTransactionFetchFailed ? 5_000 : 900);
    };
    async function prepareEnvironmentSelection(requested) {
        cardUpdates.invalidate("environment-status");
        const update = cardUpdates.begin("environment-transaction");
        const prepared = await electron_1.ipcRenderer.invoke("tweaker:prepare-environment", requested);
        if (!cardUpdates.isCurrent(update))
            throw new Error("Environment preparation was superseded");
        const receipt = normalizeEnvironmentTransaction(prepared);
        if (!receipt)
            throw new Error("Environment preparation returned no transaction receipt");
        transaction = receipt;
        scheduleEnvironmentTransactionPoll();
        return receipt;
    }
    async function commitPreparedEnvironment(receipt) {
        cardUpdates.invalidate("environment-status");
        const update = cardUpdates.begin("environment-transaction");
        let result;
        try {
            result = await electron_1.ipcRenderer.invoke("tweaker:commit-environment", { transactionId: receipt.transactionId });
        }
        catch (error) {
            const detail = `Could not submit environment change: ${safeUiError(error)}`;
            transaction = { ...receipt, error: detail };
            scheduleEnvironmentTransactionPoll();
            throw new Error(detail);
        }
        if (!cardUpdates.isCurrent(update))
            throw new Error("Environment coordinator submission was superseded");
        const submission = normalizeEnvironmentHelperSubmission(result);
        const observed = normalizeEnvironmentTransaction(result);
        transaction = submission
            ? {
                ...receipt,
                error: submission.error ?? null,
                helper: { ...(receipt.helper ?? {}), submission },
            }
            : observed ?? receipt;
        restorePersistedRequest();
        if (submission?.phase === "submit-failed") {
            const detail = `Could not submit environment change: ${submission.error || "Environment coordinator submission failed"}`;
            transaction = { ...transaction, error: detail };
            scheduleEnvironmentTransactionPoll();
            throw new Error(detail);
        }
        void loadEnvironmentTransaction();
    }
    async function cancelPreparedEnvironment(receipt) {
        const update = cardUpdates.begin("environment-transaction");
        try {
            const result = await electron_1.ipcRenderer.invoke("tweaker:cancel-environment", { transactionId: receipt.transactionId });
            if (!cardUpdates.isCurrent(update))
                throw new Error("Environment cancellation was superseded");
            transaction = normalizeEnvironmentTransaction(result) ?? receipt;
            if (transaction.phase !== "cancelled") {
                throw new Error(`Environment cancellation returned ${transaction.phase}`);
            }
            scheduleEnvironmentTransactionPoll();
        }
        catch (error) {
            const detail = `Could not cancel environment transaction: ${safeUiError(error)}`;
            transaction = { ...receipt, error: detail };
            scheduleEnvironmentTransactionPoll();
            throw new Error(detail);
        }
    }
    const environmentController = (0, environment_config_controller_1.createEnvironmentConfigController)({ appExperience: "chatgpt", releaseProfile: "stable" }, {
        prepare: prepareEnvironmentSelection,
        confirm: (requested, receipt) => openEnvironmentConfirmModal(requested, receipt),
        commit: commitPreparedEnvironment,
        cancel: cancelPreparedEnvironment,
    }, {
        onChange: (snapshot) => {
            environmentActionError = snapshot.error;
            if (card.isConnected)
                draw();
        },
    });
    function openPreparedEnvironmentConfirmation(requested, receipt) {
        if (receipt.phase !== "prepared")
            return;
        void environmentController.resumePrepared(requested, receipt);
    }
    function cancelEnvironmentTransaction(receipt) {
        if (isEnvironmentBusy() || (receipt.phase !== "preparing" && receipt.phase !== "prepared"))
            return;
        environmentActionError = null;
        externalBusy = true;
        draw();
        void cancelPreparedEnvironment(receipt)
            .then(() => {
            const selected = currentSelection();
            if (transaction?.phase === "cancelled" && selected) {
                environmentController.setSelected(selected);
            }
        })
            .catch((error) => {
            environmentActionError = safeUiError(error);
        })
            .finally(() => {
            externalBusy = false;
            draw();
        });
    }
    function recoverEnvironmentTransaction(receipt) {
        if (isEnvironmentBusy() || !environmentTransactionCanRecover(receipt))
            return;
        environmentActionError = null;
        externalBusy = true;
        draw();
        void electron_1.ipcRenderer
            .invoke("tweaker:recover-environment", { transactionId: receipt.transactionId })
            .then((result) => {
            const next = normalizeEnvironmentTransaction(result) ?? receipt;
            transaction = next;
            // The CLI returns its durable receipt whether or not recovery
            // succeeded. A receipt still sitting in `failed` is a failure, not a
            // result to render silently.
            environmentActionError = next.phase === "failed"
                ? `Could not recover the app mode safely: ${next.error ?? "the transaction is still failed"}`
                : null;
            externalBusy = false;
            draw();
            scheduleEnvironmentTransactionPoll();
        })
            .catch((error) => {
            environmentActionError = `Could not recover the app mode safely: ${safeUiError(error)}`;
            transaction = {
                ...receipt,
                error: environmentActionError,
            };
            externalBusy = false;
            draw();
            scheduleEnvironmentTransactionPoll();
        });
    }
    function appendEnvironmentTransactionRow() {
        if (!transaction)
            return;
        const receipt = transaction;
        const requested = environmentTransactionRequestedSelection(receipt);
        const helperInFlight = environmentHelperIsInFlight(receipt);
        card.appendChild(environmentTransactionRow(receipt, {
            busy: isEnvironmentBusy(),
            onResume: receipt.phase === "prepared" && requested && !helperInFlight
                ? () => openPreparedEnvironmentConfirmation(requested, receipt)
                : undefined,
            onCancel: (receipt.phase === "preparing" || receipt.phase === "prepared") && !helperInFlight
                ? () => cancelEnvironmentTransaction(receipt)
                : undefined,
            onRecover: environmentTransactionCanRecover(receipt)
                ? () => recoverEnvironmentTransaction(receipt)
                : undefined,
        }));
    }
    const draw = () => {
        card.textContent = "";
        const selected = currentSelection();
        if (!selected || !environment) {
            card.appendChild(rowSimple("Environment unavailable", "The current environment selection could not be loaded."));
            appendEnvironmentTransactionRow();
            if (environmentActionError && environmentActionError !== transaction?.error) {
                card.appendChild(rowSimple("Environment action failed", environmentActionError));
            }
            return;
        }
        const pending = environmentController.snapshot.pending;
        const busy = isEnvironmentBusy();
        const observedExperience = environment.observation?.appExperience;
        const observationNeedsRepair = environment.observation !== undefined
            && (observedExperience === null
                || observedExperience !== selected.appExperience
                || environment.observation.transitionJournalPresent);
        const environmentSelectionLocked = busy
            || observationNeedsRepair
            || (transaction !== null && (!environmentTransactionIsTerminal(transaction.phase)
                || environmentTransactionCanRecover(transaction)));
        if (observationNeedsRepair) {
            const detail = environment.observation?.transitionJournalPresent
                ? "A legacy mode transition is still present. Run tweaker repair in Terminal before switching."
                : observedExperience === null || observedExperience === undefined
                    ? "The live app marker could not be verified. Run tweaker repair in Terminal before switching."
                    : `Saved mode is ${environmentExperienceLabel(selected.appExperience)}, but the live app proves ${environmentExperienceLabel(observedExperience)}. Run tweaker repair in Terminal.`;
            card.appendChild(rowSimple("Environment needs repair", detail));
        }
        const pendingAvailability = environmentSelectionAvailability(environment, pending);
        const chatgptAvailability = environmentSelectionAvailability(environment, {
            appExperience: "chatgpt",
            releaseProfile: pending.releaseProfile,
        });
        const tweakersAvailability = environmentSelectionAvailability(environment, {
            appExperience: "tweakers",
            releaseProfile: pending.releaseProfile,
        });
        card.appendChild(environmentChoiceRow("App Mode", "ChatGPT disables every tweak. Tweakers restores the tweaks you previously enabled.", [
            {
                value: "chatgpt",
                label: "ChatGPT",
                description: chatgptAvailability.available
                    ? "OpenAI's standard app experience."
                    : environmentUnavailableReason(chatgptAvailability, "ChatGPT is unavailable for this release profile."),
                disabled: environmentSelectionLocked || !chatgptAvailability.available,
                disabledReason: environmentSelectionLocked
                    ? "Finish, cancel, or recover the current environment transaction first."
                    : environmentUnavailableReason(chatgptAvailability, "ChatGPT is unavailable for this release profile."),
            },
            {
                value: "tweakers",
                label: "Tweakers",
                description: tweakersAvailability.available
                    ? "The standard app with enabled Tweakers features."
                    : environmentUnavailableReason(tweakersAvailability, "Tweakers is unavailable for this release profile."),
                disabled: environmentSelectionLocked || !tweakersAvailability.available,
                disabledReason: environmentSelectionLocked
                    ? "Finish, cancel, or recover the current environment transaction first."
                    : environmentUnavailableReason(tweakersAvailability, "Tweakers is unavailable for this release profile."),
            },
        ], pending.appExperience, (value) => {
            environmentController.stageAppExperience(value);
        }));
        const stableAvailability = environmentSelectionAvailability(environment, {
            appExperience: pending.appExperience,
            releaseProfile: "stable",
        });
        const alphaAvailability = environmentSelectionAvailability(environment, {
            appExperience: pending.appExperience,
            releaseProfile: "alpha",
        });
        const stableReason = environmentUnavailableReason(stableAvailability, "Stable is unavailable for this app experience.");
        const alphaReason = environmentUnavailableReason(alphaAvailability, "Alpha (Pre-release) is unavailable on this Mac.");
        card.appendChild(environmentChoiceRow("Desktop Release", "Choose OpenAI's Stable or Alpha desktop app independently of app mode. Its embedded Codex backend can have a different version label.", [
            {
                value: "stable",
                label: "Stable",
                description: stableAvailability.available ? "The supported stable desktop release." : stableReason,
                disabled: environmentSelectionLocked || !stableAvailability.available,
                disabledReason: environmentSelectionLocked
                    ? "Finish, cancel, or recover the current environment transaction first."
                    : stableReason,
            },
            {
                value: "alpha",
                label: "Alpha (Pre-release)",
                description: alphaAvailability.available ? "OpenAI's verified pre-release desktop and matching backend." : alphaReason,
                disabled: environmentSelectionLocked || !alphaAvailability.available,
                disabledReason: environmentSelectionLocked
                    ? "Finish, cancel, or recover the current environment transaction first."
                    : alphaReason,
            },
        ], pending.releaseProfile, (value) => {
            environmentController.stageReleaseProfile(value);
        }));
        if (!alphaAvailability.available) {
            const chooser = actionRow("Alpha (Pre-release) unavailable", `${alphaReason} Choose a verified OpenAI Beta app to register it for this profile.`);
            const chooserActions = chooser.querySelector("[data-tweaker-row-actions]");
            const choose = compactButton("Choose Beta App…", () => {
                if (isEnvironmentBusy())
                    return;
                externalBusy = true;
                environmentActionError = null;
                draw();
                void electron_1.ipcRenderer.invoke("tweaker:choose-alpha-environment")
                    .then((result) => {
                    if (result && typeof result === "object" && "canceled" in result && result.canceled === true)
                        return;
                })
                    .catch((error) => {
                    environmentActionError = `Could not register OpenAI Beta: ${safeUiError(error)}`;
                })
                    .finally(() => {
                    externalBusy = false;
                    void load();
                });
            });
            choose.disabled = isEnvironmentBusy();
            chooserActions?.appendChild(choose);
            card.appendChild(chooser);
        }
        const summary = actionRow("Pending changes", hasPendingChanges()
            ? pendingAvailability.available
                ? `${environmentExperienceLabel(pending.appExperience)} · ${environmentProfileLabel(pending.releaseProfile)} will apply after restart.`
                : `Unavailable: ${environmentUnavailableReason(pendingAvailability, "This environment cannot be prepared.")}`
            : `Current: ${environmentExperienceLabel(selected.appExperience)} · ${environmentProfileLabel(selected.releaseProfile)}.`);
        const actions = summary.querySelector("[data-tweaker-row-actions]");
        const apply = compactButton("Apply & Restart", () => {
            if (isEnvironmentBusy() || !hasPendingChanges())
                return;
            environmentActionError = null;
            void environmentController.applyAndRestart()
                .then((result) => {
                if (result.outcome === "prepare-failed") {
                    environmentActionError = result.error;
                }
                if (result.outcome.endsWith("failed")) {
                    draw();
                }
                void loadEnvironmentTransaction();
            });
        });
        apply.disabled = environmentSelectionLocked
            || !hasPendingChanges()
            || !pendingAvailability.available;
        actions?.appendChild(apply);
        card.appendChild(summary);
        appendEnvironmentTransactionRow();
        if (environmentActionError && environmentActionError !== transaction?.error) {
            card.appendChild(rowSimple("Environment action failed", environmentActionError));
        }
    };
    async function loadEnvironmentTransaction() {
        const update = cardUpdates.begin("environment-transaction");
        try {
            const result = await electron_1.ipcRenderer.invoke("tweaker:get-environment-transaction");
            if (!cardUpdates.isCurrent(update) || !card.isConnected)
                return;
            lastTransactionFetchFailed = false;
            const previous = transaction;
            transaction = normalizeEnvironmentTransaction(result);
            if (transaction?.phase === "prepared"
                && !transaction.helper
                && previous?.transactionId === transaction.transactionId
                && previous.helper) {
                transaction = {
                    ...transaction,
                    error: transaction.error ?? previous.error,
                    helper: previous.helper,
                };
            }
            restorePersistedRequest();
            draw();
            if (transaction && environmentTransactionIsTerminal(transaction.phase)) {
                try {
                    const statusUpdate = cardUpdates.begin("environment-status");
                    const statusResult = await electron_1.ipcRenderer.invoke("tweaker:get-environment-status");
                    if (!cardUpdates.isCurrent(update) || !cardUpdates.isCurrent(statusUpdate) || !card.isConnected)
                        return;
                    environment = normalizeEnvironmentStatus(statusResult) ?? environment;
                    const selected = currentSelection();
                    if (selected)
                        environmentController.setSelected(selected);
                    draw();
                }
                catch (error) {
                    transaction = {
                        ...transaction,
                        error: transaction.error ?? `Could not refresh environment status: ${safeUiError(error)}`,
                    };
                    draw();
                }
            }
        }
        catch (error) {
            if (!cardUpdates.isCurrent(update) || !card.isConnected)
                return;
            lastTransactionFetchFailed = true;
            if (transaction) {
                transaction = {
                    ...transaction,
                    error: `Could not refresh environment transaction: ${safeUiError(error)}`,
                };
            }
            draw();
        }
        finally {
            if (cardUpdates.isCurrent(update))
                scheduleEnvironmentTransactionPoll();
        }
    }
    const load = async () => {
        const statusUpdate = cardUpdates.begin("environment-status");
        const transactionUpdate = cardUpdates.begin("environment-transaction");
        try {
            const [statusResult, transactionResult] = await Promise.all([
                electron_1.ipcRenderer.invoke("tweaker:get-environment-status"),
                electron_1.ipcRenderer.invoke("tweaker:get-environment-transaction"),
            ]);
            if (!card.isConnected)
                return;
            const statusIsCurrent = cardUpdates.isCurrent(statusUpdate);
            const transactionIsCurrent = cardUpdates.isCurrent(transactionUpdate);
            if (!statusIsCurrent && !transactionIsCurrent)
                return;
            if (statusIsCurrent) {
                environment = normalizeEnvironmentStatus(statusResult);
                if (environment?.selected)
                    environmentController.setSelected(environment.selected);
            }
            if (transactionIsCurrent) {
                lastTransactionFetchFailed = false;
                transaction = normalizeEnvironmentTransaction(transactionResult);
                restorePersistedRequest();
            }
            draw();
            scheduleEnvironmentTransactionPoll();
        }
        catch (error) {
            if ((!cardUpdates.isCurrent(statusUpdate) && !cardUpdates.isCurrent(transactionUpdate)) || !card.isConnected)
                return;
            card.textContent = "";
            card.appendChild(rowSimple("Could not load environment", safeUiError(error)));
            // Never latch on a failed initial load: an in-flight or stranded
            // receipt would stay invisible until the tab was re-mounted (this is
            // exactly how a Recover banner once hid for ~40 minutes). Retry slowly
            // while the card stays mounted.
            lastTransactionFetchFailed = true;
            setTimeout(() => {
                if (card.isConnected)
                    void load();
            }, 5_000);
        }
    };
    void load();
    return () => {
        cardUpdates.invalidate("environment-status");
        cardUpdates.invalidate("environment-transaction");
        if (transactionPolling)
            clearTimeout(transactionPolling);
        transactionPolling = null;
    };
}
function environmentTransactionRequestedSelection(transaction) {
    const requested = transaction.requested;
    if (!requested)
        return null;
    if (requested.appExperience !== "chatgpt" && requested.appExperience !== "tweakers")
        return null;
    if (requested.releaseProfile !== "stable" && requested.releaseProfile !== "alpha")
        return null;
    return { appExperience: requested.appExperience, releaseProfile: requested.releaseProfile };
}
function environmentTransactionIsTerminal(phase) {
    return ["committed", "completed", "rolled-back", "rolled_back", "failed", "cancelled"].includes(phase);
}
function environmentChoiceRow(title, description, choices, selected, onChange) {
    const row = document.createElement("div");
    row.className = "flex flex-wrap items-start justify-between gap-4 p-3";
    const left = rowCopy(title, description);
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 flex-wrap rounded-lg bg-token-foreground/5 p-0.5";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", title);
    for (const choice of choices) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = choice.label;
        button.disabled = choice.disabled === true;
        button.setAttribute("aria-pressed", String(choice.value === selected));
        if (choice.disabled)
            button.setAttribute("aria-disabled", "true");
        if (choice.disabledReason)
            button.title = choice.disabledReason;
        button.className = `rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border ${choice.value === selected ? "bg-token-bg-primary shadow-sm text-token-text-primary" : "text-token-text-secondary hover:text-token-text-primary"}`;
        button.addEventListener("click", () => onChange(choice.value));
        actions.appendChild(button);
    }
    const disabledReason = choices.find((choice) => choice.disabled && choice.disabledReason)?.disabledReason;
    if (disabledReason) {
        const reason = document.createElement("div");
        reason.className = "text-token-text-secondary text-xs";
        reason.textContent = disabledReason;
        left.appendChild(reason);
    }
    row.append(left, actions);
    return row;
}
function environmentExperienceLabel(value) {
    return value === "chatgpt" ? "ChatGPT" : "Tweakers";
}
function environmentSelectionAvailability(environment, selection) {
    const channel = environment.channels[selection.releaseProfile];
    return channel.availability?.[selection.appExperience] ?? {
        available: channel.available,
        unavailableReasons: channel.unavailableReasons,
    };
}
function environmentUnavailableReason(availability, fallback) {
    return availability.unavailableReasons?.filter(Boolean).join(" ") || fallback;
}
function environmentProfileLabel(value) {
    return value === "alpha" ? "Alpha (Pre-release)" : "Stable";
}
function normalizeEnvironmentStatus(value) {
    if (!value || typeof value !== "object")
        return null;
    const candidate = value;
    const selected = candidate.selected;
    if (!selected || (selected.appExperience !== "chatgpt" && selected.appExperience !== "tweakers") || (selected.releaseProfile !== "stable" && selected.releaseProfile !== "alpha"))
        return null;
    const channels = candidate.channels;
    const rawObservation = candidate.observation;
    const observation = rawObservation
        && (rawObservation.appExperience === null
            || rawObservation.appExperience === "chatgpt"
            || rawObservation.appExperience === "tweakers")
        ? {
            appExperience: rawObservation.appExperience,
            selectionDrift: rawObservation.selectionDrift === true,
            lifecycleContended: rawObservation.lifecycleContended === true,
            commitJournalPresent: rawObservation.commitJournalPresent === true,
            transitionJournalPresent: rawObservation.transitionJournalPresent === true,
            freshness: rawObservation.freshness === "contended" ? "contended" : "current",
        }
        : undefined;
    return {
        schemaVersion: 1,
        selected,
        channels: {
            stable: channels?.stable ?? { available: true, releaseProfile: "stable" },
            alpha: channels?.alpha ?? { available: false, unavailableReasons: ["Alpha (Pre-release) availability was not reported."], releaseProfile: "alpha" },
        },
        ...(observation ? { observation } : {}),
    };
}
function normalizeEnvironmentTransaction(value) {
    if (!value || typeof value !== "object")
        return null;
    const candidate = value;
    if (typeof candidate.transactionId !== "string" || typeof candidate.phase !== "string")
        return null;
    return {
        ...candidate,
        transactionId: candidate.transactionId,
        phase: candidate.phase,
        error: typeof candidate.error === "string" ? candidate.error : null,
    };
}
function normalizeEnvironmentHelperSubmission(value) {
    if (!value || typeof value !== "object")
        return null;
    const candidate = value;
    if (candidate.kind !== "environment-commit-helper")
        return null;
    if (typeof candidate.transactionId !== "string")
        return null;
    if (candidate.phase !== "submitted" && candidate.phase !== "submit-failed")
        return null;
    return {
        kind: "environment-commit-helper",
        transactionId: candidate.transactionId,
        phase: candidate.phase,
        error: typeof candidate.error === "string" ? candidate.error : null,
    };
}
function environmentHelperIsInFlight(transaction) {
    const helper = transaction.helper;
    const outcomePhase = helper?.outcome?.phase;
    return outcomePhase === "not-started"
        || outcomePhase === "running"
        || (helper?.submission?.phase === "submitted" && outcomePhase === undefined);
}
function environmentTransactionCanRecover(transaction) {
    if (transaction.phase === "failed")
        return transaction.prepared !== null && transaction.prepared !== undefined;
    return ["committing", "applying", "reopening", "verifying", "rolling-back"].includes(transaction.phase);
}
function environmentHelperFailureDetail(transaction) {
    const helper = transaction.helper;
    if (!helper)
        return null;
    const outcome = helper.outcome;
    const submission = helper.submission;
    const failed = outcome?.phase === "failed"
        || submission?.phase === "submit-failed"
        || typeof outcome?.error === "string"
        || typeof submission?.error === "string";
    if (!failed)
        return null;
    const stderr = environmentHelperLogSnippet(helper.stderr);
    const stdout = environmentHelperLogSnippet(helper.stdout);
    const exitCode = typeof outcome?.exitCode === "number" ? `exit ${outcome.exitCode}` : null;
    const detail = [
        "Environment helper failed",
        exitCode,
        outcome?.error,
        submission?.error,
        stderr ? `stderr: ${stderr}` : null,
        !stderr && stdout ? `stdout: ${stdout}` : null,
    ].filter((value) => typeof value === "string" && value.length > 0);
    return [...new Set(detail)].join(" · ");
}
function environmentHelperLogSnippet(value) {
    if (typeof value !== "string")
        return null;
    const compact = value.trim().replace(/\s+/g, " ");
    if (!compact)
        return null;
    return compact.length <= 600 ? compact : `…${compact.slice(-599)}`;
}
function environmentTransactionRow(transaction, actionsConfig) {
    const helperFailure = environmentHelperFailureDetail(transaction);
    const ownerExited = transaction.ownerAlive === false
        && !environmentTransactionIsTerminal(transaction.phase);
    const details = [
        ownerExited ? "Owner process exited — recovery required." : null,
        environmentTransactionLabel(transaction.phase),
        transaction.error,
        helperFailure,
    ].filter((value) => typeof value === "string" && value.length > 0);
    const row = actionRow("App mode restart", [...new Set(details)].join(" · "));
    const left = row.firstElementChild;
    if (left) {
        left.prepend(statusBadge(ownerExited ? "error" : environmentTransactionTone(transaction.phase), environmentTransactionLabel(transaction.phase)));
    }
    const actions = row.querySelector("[data-tweaker-row-actions]");
    if (actionsConfig?.onResume) {
        const resume = compactButton("Resume/Confirm", actionsConfig.onResume);
        resume.disabled = actionsConfig.busy;
        actions?.appendChild(resume);
    }
    if (actionsConfig?.onCancel) {
        const cancel = compactButton("Cancel", actionsConfig.onCancel);
        cancel.disabled = actionsConfig.busy;
        actions?.appendChild(cancel);
    }
    if (actionsConfig?.onRecover) {
        const recover = compactButton("Recover Safely", actionsConfig.onRecover);
        recover.disabled = actionsConfig.busy;
        actions?.appendChild(recover);
    }
    row.title = `Transaction ${transaction.transactionId}`;
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");
    return row;
}
function environmentTransactionLabel(phase) {
    switch (phase) {
        case "committed":
        case "completed":
            return "Completed";
        case "rolled-back":
        case "rolled_back":
            return "Rolled back";
        case "cancelled":
            return "Cancelled";
        case "failed":
            return "Failed";
        case "prepared":
            return "Prepared";
        case "preparing":
            return "Preparing";
        case "committing":
            return "Committing";
        case "reopening":
            return "Reopening";
        case "verifying":
            return "Verifying";
        case "rolling-back":
            return "Rolling back";
        default:
            return humanizeCodexPhase(phase);
    }
}
function environmentTransactionTone(phase) {
    if (phase === "committed" || phase === "completed")
        return "ok";
    if (phase === "failed")
        return "error";
    return "warn";
}
/** One shared, accessible confirmation after prepare; Cancel never commits. */
function openEnvironmentConfirmModal(requested, transaction) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreFocus = () => {
        (0, environment_config_controller_1.restoreEnvironmentFocus)(opener, () => document.querySelector("[data-tweaker-environment-card] button:not([disabled])"));
    };
    let resolveDecision;
    const decision = new Promise((resolvePromise) => {
        resolveDecision = resolvePromise;
    });
    const overlay = document.createElement("div");
    overlay.dataset.tweakerEnvironmentModal = "true";
    overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4";
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "tweaker-environment-confirm-title");
    dialog.setAttribute("aria-describedby", "tweaker-environment-confirm-body");
    dialog.className = "border-token-border flex w-full max-w-md flex-col gap-4 rounded-2xl border p-5 shadow-xl";
    dialog.setAttribute("style", "background-color: var(--color-background-panel, var(--color-token-bg-fog));");
    const heading = document.createElement("div");
    heading.id = "tweaker-environment-confirm-title";
    heading.className = "text-base font-medium text-token-text-primary";
    const experience = environmentExperienceLabel(requested.appExperience);
    heading.textContent = `Switch to ${experience} and restart?`;
    const body = document.createElement("div");
    body.id = "tweaker-environment-confirm-body";
    body.className = "text-sm text-token-text-secondary";
    const candidate = transaction.prepared?.candidate;
    const backend = transaction.prepared?.backend;
    const rollback = transaction.prepared?.rollback;
    const target = candidate?.desktopPath
        ? `${candidate.desktopPath}${candidate.version ? ` (${candidate.version}${candidate.build ? `, build ${candidate.build}` : ""})` : ""}`
        : environmentProfileLabel(requested.releaseProfile);
    const backendTarget = backend?.lane
        ? `${backend.lane}${backend.version ? ` ${backend.version}` : ""}`
        : "the verified backend for this environment";
    const rollbackTarget = rollback?.desktopPath
        ?? rollback?.selection?.selectedDesktopPath
        ?? "the last known working environment";
    const modeEffect = requested.appExperience === "tweakers"
        ? "ChatGPT will close, reopen in Tweakers mode, and restore your previously enabled tweaks."
        : "ChatGPT will close and reopen in standard mode. All tweaks will be disabled, but their saved settings will remain available for Tweakers mode.";
    body.textContent = [
        modeEffect,
        `Desktop: ${target}. Embedded Codex backend: ${backendTarget}.`,
        `If restart verification fails, Tweakers will restore the last known working environment at ${rollbackTarget}.`,
    ].join("\n");
    body.style.whiteSpace = "pre-line";
    const buttons = document.createElement("div");
    buttons.className = "flex items-center justify-end gap-2";
    let settled = false;
    const close = (outcome) => {
        if (settled)
            return;
        settled = true;
        document.removeEventListener("keydown", onKeydown, true);
        overlay.remove();
        resolveDecision(outcome);
        window.requestAnimationFrame(restoreFocus);
    };
    const onKeydown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close("cancel");
            return;
        }
        if (event.key !== "Tab")
            return;
        const focusable = [cancel, confirm];
        const currentIndex = focusable.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
            ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
            : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
        event.preventDefault();
        focusable[nextIndex]?.focus();
    };
    const cancel = compactButton("Cancel", () => close("cancel"));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-token-charts-blue px-3 text-sm text-white enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
    confirm.textContent = "Apply & Restart";
    confirm.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        close("confirm");
    });
    buttons.append(cancel, confirm);
    dialog.append(heading, body, buttons);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    confirm.focus();
    return decision;
}
function renderDesktopUpdateSection(sectionsWrap, cardUpdates) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Desktop Update"));
    const card = roundedCard();
    card.dataset.tweakerDesktopUpdateCard = "true";
    card.appendChild(rowSimple("Loading desktop update", "Checking the signed Codex appcast."));
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    let current = null;
    let transaction = null;
    let busy = false;
    let polling = null;
    let transactionPollFailures = 0;
    let awaitingTransactionReceiptUntil = 0;
    let initialResultSuperseded = false;
    let transactionFetchFailed = false;
    const transactionIsNonTerminal = () => {
        if (!transaction?.transactionId) {
            return transaction?.phase === "preparing" && Date.now() < awaitingTransactionReceiptUntil;
        }
        return !["completed", "failed", "rolled_back"].includes(transaction.phase);
    };
    const scheduleTransactionPoll = (delayMs = 2_000) => {
        if (polling)
            clearTimeout(polling);
        // A failed fetch must keep polling even with no known transaction: a
        // stranded receipt would otherwise stay invisible until tab re-mount.
        if (!card.isConnected
            || (!transactionIsNonTerminal()
                && transaction?.resumable !== true
                && !transactionFetchFailed))
            return;
        polling = setTimeout(() => {
            polling = null;
            void loadTransaction();
        }, delayMs);
    };
    const loadTransaction = async () => {
        const update = cardUpdates.begin("desktop-update-transaction");
        try {
            const value = await electron_1.ipcRenderer.invoke("tweaker:get-codex-desktop-update-transaction");
            if (!cardUpdates.isCurrent(update) || !card.isConnected)
                return;
            transactionFetchFailed = false;
            const observed = normalizeDesktopUpdateTransaction(value);
            if (observed?.phase === "idle"
                && observed.transactionId === null
                && transaction?.phase === "preparing"
                && transaction.transactionId === null) {
                if (Date.now() >= awaitingTransactionReceiptUntil) {
                    transaction = {
                        transactionId: null,
                        phase: "failed",
                        error: "The desktop updater did not create a transaction receipt.",
                    };
                }
            }
            else {
                const idleWithoutReceipt = observed?.phase === "idle" && observed.transactionId === null;
                transaction = idleWithoutReceipt ? null : observed;
                if (transaction?.transactionId)
                    awaitingTransactionReceiptUntil = 0;
            }
            transactionPollFailures = 0;
            draw();
            scheduleTransactionPoll();
        }
        catch (error) {
            if (!cardUpdates.isCurrent(update) || !card.isConnected)
                return;
            transactionFetchFailed = true;
            // With no known transaction, keep it null: fabricating a phantom
            // "preparing" row both misinforms and used to satisfy no poll gate,
            // permanently hiding any real stranded receipt on disk.
            if (transaction) {
                transaction = {
                    ...transaction,
                    error: safeUiError(error),
                };
            }
            draw();
            transactionPollFailures += 1;
            const backoff = Math.min(30_000, 1_000 * (2 ** Math.min(transactionPollFailures - 1, 5)));
            const jitter = Math.floor(backoff * 0.25 * Math.random());
            scheduleTransactionPoll(backoff + jitter);
        }
    };
    const draw = () => {
        card.textContent = "";
        const result = current;
        const installed = result?.installed?.marketingVersion ?? "Unavailable";
        const latest = result?.latest?.marketingVersion ?? "Unavailable";
        const status = (0, environment_config_controller_1.desktopUpdateStatusPresentation)(result?.status);
        const row = actionRow("ChatGPT Desktop", `Installed ${installed} · Latest ${latest}${result?.reason ? ` · ${result.reason}` : ""}`);
        const left = row.firstElementChild;
        left?.prepend(statusBadge(status.tone, status.label));
        const actions = row.querySelector("[data-tweaker-row-actions]");
        const check = compactButton("Check for Updates…", () => {
            if (busy)
                return;
            busy = true;
            check.disabled = true;
            void electron_1.ipcRenderer.invoke("tweaker:check-codex-desktop-update")
                .then((value) => {
                const result = value;
                acceptDesktopUpdateResult(result);
                if (result.updateAndReloadRequested) {
                    awaitingTransactionReceiptUntil = Date.now() + 10_000;
                    transaction = { transactionId: null, phase: "preparing" };
                    void loadTransaction();
                }
            })
                .catch((error) => { current = { status: "error", reason: safeUiError(error) }; })
                .finally(() => { busy = false; draw(); });
        });
        check.disabled = busy || !!result?.setupRequired;
        actions?.appendChild(check);
        const update = compactButton("Update and Reload", () => {
            if (busy)
                return;
            busy = true;
            update.disabled = true;
            void electron_1.ipcRenderer.invoke("tweaker:start-codex-desktop-update")
                .then(() => {
                awaitingTransactionReceiptUntil = Date.now() + 10_000;
                transaction = { transactionId: null, phase: "preparing" };
                void loadTransaction();
            })
                .catch((error) => { current = { status: "error", reason: safeUiError(error) }; })
                .finally(() => { busy = false; draw(); });
        });
        // Gate on non-terminal (not "active"): a stranded dead-owner receipt still
        // blocks start() on disk, so the button must stay disabled until recovery.
        update.disabled = busy
            || result?.status !== "update-available"
            || transactionIsNonTerminal()
            || transaction?.resumable === true;
        actions?.appendChild(update);
        card.appendChild(row);
        if (result?.setupRequired) {
            const setupLabel = result.setupRequired === "register-beta"
                ? "Register OpenAI Beta"
                : "Launch OpenAI Beta once";
            card.appendChild(rowSimple(`Alpha update setup · ${setupLabel}`, result.reason ?? "Alpha update checks stay disabled until Tweakers captures the registered Beta app's own feed."));
        }
        if (result?.checkedAt)
            card.appendChild(rowSimple("Last checked", new Date(result.checkedAt).toLocaleString()));
        if (transaction)
            card.appendChild(desktopUpdateTransactionRow(transaction, {
                busy,
                onResume: () => {
                    if (busy)
                        return;
                    busy = true;
                    draw();
                    void electron_1.ipcRenderer.invoke("tweaker:resume-codex-desktop-update")
                        .then(() => {
                        transaction = transaction ? { ...transaction, phase: "awaiting_native_update", resumable: false } : transaction;
                        scheduleTransactionPoll();
                    })
                        .catch((error) => {
                        if (transaction)
                            transaction = { ...transaction, error: safeUiError(error) };
                    })
                        .finally(() => { busy = false; draw(); });
                },
                onCancel: () => {
                    if (busy)
                        return;
                    busy = true;
                    draw();
                    void electron_1.ipcRenderer.invoke("tweaker:cancel-codex-desktop-update")
                        .then((value) => { transaction = normalizeDesktopUpdateTransaction(value) ?? transaction; })
                        .catch((error) => {
                        if (transaction)
                            transaction = { ...transaction, error: safeUiError(error) };
                    })
                        .finally(() => { busy = false; draw(); });
                },
            }));
    };
    draw();
    const acceptDesktopUpdateResult = (value) => {
        const currentTime = current?.checkedAt ? Date.parse(current.checkedAt) : Number.NaN;
        const nextTime = value.checkedAt ? Date.parse(value.checkedAt) : Number.NaN;
        if (Number.isFinite(currentTime) && (!Number.isFinite(nextTime) || nextTime < currentTime))
            return;
        current = value;
        draw();
    };
    const onDesktopUpdateChanged = (_event, value) => {
        if (!card.isConnected) {
            electron_1.ipcRenderer.removeListener("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
            return;
        }
        initialResultSuperseded = true;
        acceptDesktopUpdateResult(value);
    };
    electron_1.ipcRenderer.on("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
    const currentUpdate = cardUpdates.begin("desktop-update-result");
    void electron_1.ipcRenderer.invoke("tweaker:get-codex-desktop-update")
        .then((value) => {
        if (!cardUpdates.isCurrent(currentUpdate) || !card.isConnected || initialResultSuperseded)
            return;
        if (value && typeof value === "object") {
            acceptDesktopUpdateResult(value);
        }
        else {
            current = { status: "unavailable", reason: "Update status has not been checked yet." };
            draw();
        }
    })
        .catch((error) => {
        if (!cardUpdates.isCurrent(currentUpdate) || !card.isConnected)
            return;
        current = { status: "error", reason: safeUiError(error) };
        draw();
    });
    void loadTransaction();
    return () => {
        cardUpdates.invalidate("desktop-update-result");
        cardUpdates.invalidate("desktop-update-transaction");
        electron_1.ipcRenderer.removeListener("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
        if (polling)
            clearTimeout(polling);
        polling = null;
    };
}
function normalizeDesktopUpdateTransaction(value) {
    if (!value || typeof value !== "object")
        return null;
    const candidate = value;
    if (candidate.transactionId !== null && typeof candidate.transactionId !== "string")
        return null;
    if (typeof candidate.phase !== "string")
        return null;
    return {
        ...candidate,
        transactionId: candidate.transactionId ?? null,
        phase: candidate.phase,
    };
}
function desktopUpdateTransactionRow(transaction, actions) {
    const phase = humanizeCodexPhase(transaction.phase);
    const nonTerminal = !["completed", "failed", "rolled_back"].includes(transaction.phase);
    // ownerAlive === false on a non-terminal receipt means the coordinator died
    // mid-flight: the receipt is stranded, not progressing.
    const ownerExited = nonTerminal && transaction.ownerAlive === false;
    const detail = [
        ownerExited ? "Owner process exited — recovery required." : null,
        transaction.transactionId ? `Transaction ${transaction.transactionId}` : null,
        transaction.safeOfficialMode ? "Official ChatGPT is active" : null,
        transaction.refreshSource ? `${transaction.refreshSource} Tweakers refresh` : null,
        typeof transaction.terminalAt === "string"
            ? `Terminal at ${new Date(transaction.terminalAt).toLocaleString()}`
            : transaction.updatedAt
                ? `Last update at ${new Date(transaction.updatedAt).toLocaleString()}`
                : null,
        transaction.error ?? null,
    ].filter(Boolean).join(" · ") || "Waiting for the durable updater receipt.";
    const row = actionRow("Update and Reload", detail);
    row.setAttribute("role", "status");
    row.setAttribute("aria-live", "polite");
    const left = row.firstElementChild;
    const tone = transaction.phase === "completed"
        ? "ok"
        : ownerExited || (transaction.phase === "failed" && !transaction.resumable)
            ? "error"
            : "warn";
    left?.prepend(statusBadge(tone, phase));
    const controls = row.querySelector("[data-tweaker-row-actions]");
    const canResume = transaction.resumable === true
        && (transaction.phase === "failed" || transaction.phase === "rolled_back");
    // cancelUnlocked handles exited owners for these stranded phases via
    // recoverExitedOwner, so a dead-owner receipt gets a safe-recovery Cancel.
    const deadOwnerRecoverable = ownerExited
        && ["switching_to_chatgpt", "returning_to_tweakers", "refreshing_runtime", "verifying", "preparing"]
            .includes(transaction.phase);
    const canCancel = transaction.phase === "awaiting_native_update"
        || (transaction.resumable === true && ["failed", "rolled_back"].includes(transaction.phase))
        || deadOwnerRecoverable;
    if (canResume) {
        const resume = compactButton("Resume", actions.onResume);
        resume.disabled = actions.busy;
        controls?.appendChild(resume);
    }
    if (canCancel) {
        const cancel = compactButton("Cancel", actions.onCancel);
        cancel.disabled = actions.busy;
        controls?.appendChild(cancel);
    }
    return row;
}
function renderTweaksHealthSection(sectionsWrap, cardUpdates) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Tweaks Health"));
    const card = roundedCard();
    card.dataset.tweakerTweaksHealthCard = "true";
    card.appendChild(rowSimple("Checking tweaks", "Comparing live copies, bundled runtime copies, and latest stored catalog versions."));
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    const render = (snapshot) => {
        card.textContent = "";
        const missingCount = snapshot.missingLiveCount + snapshot.missingRuntimeCount;
        const totalProblems = snapshot.liveDriftCount
            + snapshot.runtimeDriftCount
            + missingCount
            + (snapshot.mcpRestartRequired ? 1 : 0);
        const summary = actionRow("Installed Tweaks", `${snapshot.installedCount} installed · ${snapshot.enabledCount} enabled · ${snapshot.catalogCount} latest stored catalog entries.`);
        summary.querySelector("[data-tweaker-row-actions]")?.appendChild(statusBadge(totalProblems === 0 ? "ok" : "warn", totalProblems === 0 ? "Current" : "Review"));
        card.appendChild(summary);
        if (totalProblems === 0) {
            card.appendChild(rowSimple("Version Drift", "All installed live copies and bundled runtime copies match the latest stored catalog versions."));
        }
        else {
            card.appendChild(rowSimple("Version Drift", [
                `${snapshot.liveDriftCount} outdated live ${snapshot.liveDriftCount === 1 ? "copy" : "copies"}`,
                `${snapshot.runtimeDriftCount} outdated runtime ${snapshot.runtimeDriftCount === 1 ? "copy" : "copies"}`,
                `${missingCount} missing ${missingCount === 1 ? "copy" : "copies"}`,
                snapshot.mcpRestartRequired ? "MCP restart required" : null,
            ].filter(Boolean).join(" · ")));
            for (const row of snapshot.rows.filter((candidate) => candidate.status !== "current")) {
                card.appendChild(tweakHealthDriftRow(row));
            }
        }
        if (snapshot.mcpRestartRequired) {
            card.appendChild(rowSimple("MCP Process State", "The managed MCP config changed. Start a new task or restart Codex to replace already-running MCP processes."));
        }
        card.appendChild(rowSimple("Last checked", new Date(snapshot.checkedAt).toLocaleString()));
    };
    const update = cardUpdates.begin("tweaks-health");
    void electron_1.ipcRenderer.invoke("tweaker:get-tweaks-health")
        .then((value) => {
        if (!card.isConnected || !cardUpdates.complete(update, value))
            return;
        render(value);
    })
        .catch((error) => {
        if (!card.isConnected || !cardUpdates.complete(update, error))
            return;
        card.textContent = "";
        card.appendChild(rowSimple("Tweaks health unavailable", safeUiError(error)));
    });
    return () => {
        cardUpdates.invalidate("tweaks-health");
    };
}
function tweakHealthDriftRow(drift) {
    const row = actionRow(drift.name, `${drift.reason} Live: ${drift.liveVersion ?? "missing"} · Runtime: ${drift.runtimeVersion ?? "missing"} · Latest stored: ${drift.catalogVersion ?? "missing"}.`);
    makeCodexRowResponsive(row);
    const actions = row.querySelector("[data-tweaker-row-actions]");
    actions?.appendChild(statusBadge(drift.status === "missing" ? "error" : "warn", drift.status === "missing" ? "Missing" : "Outdated"));
    if (drift.enabled)
        actions?.appendChild(codexNeutralBadge("Enabled"));
    if (drift.hasMcp)
        actions?.appendChild(codexNeutralBadge("MCP"));
    return row;
}
function renderMcpIntegrationSection(sectionsWrap, cardUpdates) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("MCP Integration Health"));
    const card = roundedCard();
    card.dataset.tweakerMcpHealthCard = "true";
    card.appendChild(rowSimple("Checking MCP integration", "Verifying managed MCP configuration and synchronization."));
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    const render = (state) => {
        card.textContent = "";
        if (!state) {
            state = {
                status: "pending",
                summary: "Managed MCP reconciliation has not completed yet.",
            };
        }
        const status = state.status ?? (state.error ? "error" : "ok");
        const tone = status === "error" || state.error
            ? "error"
            : status === "conflict" || status === "warn" || status === "pending"
                ? "warn"
                : "ok";
        const row = actionRow("MCP integration", state.summary ?? state.error ?? (tone === "ok" ? "MCP configuration is synchronized." : "MCP configuration needs attention."));
        const left = row.firstElementChild;
        left?.prepend(statusBadge(tone, status === "ok" ? "Healthy" : humanizeCodexPhase(status)));
        const actions = row.querySelector("[data-tweaker-row-actions]");
        const repair = compactButton("Repair", () => {
            repair.disabled = true;
            const update = cardUpdates.begin("mcp");
            void electron_1.ipcRenderer.invoke("tweaker:repair-mcp")
                .then((next) => {
                if (cardUpdates.complete(update, next))
                    render(next);
            })
                .catch((error) => {
                const next = { status: "error", error: safeUiError(error) };
                if (cardUpdates.complete(update, next))
                    render(next);
            });
        });
        actions?.appendChild(repair);
        card.appendChild(row);
        if (state.restartRequired) {
            card.appendChild(rowSimple("New task or restart required", "The canonical MCP name is written. Start a new task, or restart Codex, to replace any already-running legacy MCP process."));
        }
        if (state.conflicts?.length) {
            card.appendChild(rowSimple("Conflicts", state.conflicts.map((conflict) => {
                if (conflict.observedName || conflict.canonicalName) {
                    return `${conflict.observedName ?? "Unknown entry"} → ${conflict.canonicalName ?? "canonical entry"}: ${conflict.reason ?? conflict.detail ?? "ownership conflict"}`;
                }
                return conflict.detail ?? conflict.reason ?? conflict.name ?? "Unknown conflict";
            }).join("; ")));
        }
        const checkedAt = state.completedAt ?? state.checkedAt;
        if (checkedAt)
            card.appendChild(rowSimple("Last checked", new Date(checkedAt).toLocaleString()));
    };
    const onSyncStateChanged = (_event, value) => {
        if (!card.isConnected) {
            electron_1.ipcRenderer.removeListener("tweaker:mcp-sync-state-changed", onSyncStateChanged);
            return;
        }
        const update = cardUpdates.begin("mcp");
        const next = value && typeof value === "object" ? value : null;
        if (cardUpdates.complete(update, next))
            render(next);
    };
    electron_1.ipcRenderer.on("tweaker:mcp-sync-state-changed", onSyncStateChanged);
    const initialUpdate = cardUpdates.begin("mcp");
    void electron_1.ipcRenderer.invoke("tweaker:get-mcp-sync-state")
        .then((value) => {
        const next = value && typeof value === "object" ? value : null;
        if (card.isConnected && cardUpdates.complete(initialUpdate, next))
            render(next);
    })
        .catch((error) => {
        const next = { status: "error", error: safeUiError(error) };
        if (card.isConnected && cardUpdates.complete(initialUpdate, next))
            render(next);
    });
    return () => {
        cardUpdates.invalidate("mcp");
        electron_1.ipcRenderer.removeListener("tweaker:mcp-sync-state-changed", onSyncStateChanged);
    };
}
function renderAutomaticMaintenanceSection(sectionsWrap, cardUpdates) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.appendChild(sectionTitle("Automatic Maintenance"));
    const card = roundedCard();
    card.dataset.tweakerMaintenanceCard = "true";
    card.appendChild(rowSimple("Checking automatic maintenance", "Verifying the updater repair service."));
    section.appendChild(card);
    sectionsWrap.appendChild(section);
    let latestHealth = null;
    let repairInFlight = false;
    let repairDisplay = "idle";
    let repairBaselineCycle = null;
    let repairStartedAt = 0;
    let repairPoll = null;
    let repairPollCount = 0;
    const MAX_REPAIR_POLLS = 30;
    const render = (health) => {
        latestHealth = health;
        card.textContent = "";
        if (repairInFlight) {
            renderWatcherHealth(card, {
                ...health,
                status: "warn",
                title: "Automatic maintenance running",
                summary: "Repair was started in the background. Waiting for a completed watcher cycle…",
            }, false);
            const running = actionRow("Automatic maintenance", "Repair cycle running…");
            running.setAttribute("role", "status");
            running.setAttribute("aria-live", "polite");
            running.querySelector("[data-tweaker-row-actions]")?.appendChild(statusBadge("warn", "Running"));
            card.appendChild(running);
            return;
        }
        if (repairDisplay === "success") {
            health = {
                ...health,
                status: "ok",
                title: "Automatic maintenance succeeded",
                summary: "The watcher completed a fresh repair cycle.",
            };
        }
        else if (repairDisplay === "failure") {
            health = {
                ...health,
                status: "error",
                title: "Automatic maintenance failed",
                summary: health.summary || "The watcher repair cycle failed.",
            };
        }
        renderWatcherHealth(card, health, true, startRepair);
    };
    const load = () => {
        const update = cardUpdates.begin("watcher");
        return electron_1.ipcRenderer.invoke("tweaker:get-watcher-health")
            .then((value) => {
            const health = value;
            if (!card.isConnected || !cardUpdates.complete(update, health))
                return null;
            render(health);
            return health;
        })
            .catch((error) => {
            const health = { checkedAt: new Date().toISOString(), status: "error", title: "Automatic maintenance unavailable", summary: safeUiError(error), watcher: "Watcher", checks: [] };
            if (!card.isConnected || !cardUpdates.complete(update, health))
                return null;
            render(health);
            return health;
        });
    };
    const isNewerCycle = (health) => {
        const cycle = health.latestCompletedCycle;
        if (!cycle)
            return false;
        if (!repairBaselineCycle) {
            return Date.parse(cycle.completedAt) > repairStartedAt;
        }
        return cycle.cycleId !== repairBaselineCycle.cycleId
            && cycle.completedAt > repairBaselineCycle.completedAt;
    };
    const finishRepair = (health, failed = false) => {
        repairInFlight = false;
        repairDisplay = failed ? "failure" : "success";
        if (repairPoll)
            clearTimeout(repairPoll);
        repairPoll = null;
        const next = failed
            ? { ...health, status: "error", title: "Automatic maintenance failed", summary: health.summary || "The watcher repair cycle failed." }
            : health;
        render(next);
    };
    const pollRepair = () => {
        if (!repairInFlight || !card.isConnected)
            return;
        if (repairPollCount++ >= MAX_REPAIR_POLLS) {
            finishRepair({
                ...(latestHealth ?? { checkedAt: new Date().toISOString(), status: "error", title: "Automatic maintenance failed", summary: "The watcher did not report a completed cycle in time.", watcher: "Watcher", checks: [] }),
                status: "error",
                title: "Automatic maintenance failed",
                summary: "The watcher did not report a completed cycle in time.",
            }, true);
            return;
        }
        void load().then((health) => {
            if (!health || !repairInFlight)
                return;
            const cycle = health.latestCompletedCycle;
            if (isNewerCycle(health)) {
                finishRepair(health, cycle?.outcome === "failed" || cycle?.repair.status === "failed");
                return;
            }
            render(health);
            repairPoll = setTimeout(pollRepair, 1_000);
        });
    };
    const startRepair = () => {
        if (repairInFlight)
            return;
        repairInFlight = true;
        repairDisplay = "idle";
        repairBaselineCycle = latestHealth?.latestCompletedCycle ?? null;
        repairStartedAt = Date.now();
        repairPollCount = 0;
        render(latestHealth ?? { checkedAt: new Date().toISOString(), status: "warn", title: "Automatic maintenance running", summary: "Starting repair…", watcher: "Watcher", checks: [] });
        void electron_1.ipcRenderer.invoke("tweaker:repair-auto-maintenance")
            .then(() => pollRepair())
            .catch((error) => finishRepair({
            ...(latestHealth ?? { checkedAt: new Date().toISOString(), status: "error", title: "Automatic maintenance failed", summary: "", watcher: "Watcher", checks: [] }),
            status: "error",
            title: "Automatic maintenance failed",
            summary: safeUiError(error),
        }, true));
    };
    load();
    return () => {
        cardUpdates.invalidate("watcher");
        repairInFlight = false;
        if (repairPoll)
            clearTimeout(repairPoll);
        repairPoll = null;
    };
}
function renderAdvancedRuntimeSection(sectionsWrap) {
    renderCodexVersionsSection(sectionsWrap);
}
function renderCodexVersionsSection(sectionsWrap, options = {}) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.dataset.tweakerCodexSection = "true";
    const refresh = compactButton("Refresh", () => { void load(true); });
    const heading = sectionTitle(options.collapsed ? "Advanced Runtime Details" : "Runtime Versions", refresh);
    section.appendChild(heading);
    const card = roundedCard();
    card.dataset.tweakerCodexCard = "true";
    card.appendChild(rowSimple("Loading Codex versions", "Using cached version and feature information first."));
    if (options.collapsed) {
        const details = document.createElement("details");
        details.dataset.tweakerAdvancedRuntimeDetails = "true";
        const summary = document.createElement("summary");
        summary.className = "cursor-pointer px-1 text-sm text-token-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
        summary.textContent = "Builds, CLI runtimes, releases, and features";
        const body = document.createElement("div");
        body.className = "mt-2 flex flex-col gap-2";
        body.appendChild(card);
        details.append(summary, body);
        section.appendChild(details);
    }
    else {
        section.appendChild(card);
    }
    sectionsWrap.appendChild(section);
    let polling = null;
    let actionInFlight = false;
    let generation = 0;
    const schedulePoll = (snapshot) => {
        if (polling)
            clearTimeout(polling);
        polling = null;
        if (!actionInFlight && !codexProgressBusy(snapshot.installProgress))
            return;
        polling = setTimeout(() => {
            if (card.isConnected)
                void load(false);
        }, 900);
    };
    const requestReload = (mode) => {
        if (mode === "operation-start")
            actionInFlight = true;
        if (mode === "operation-stop")
            actionInFlight = false;
        void load(false);
    };
    const show = (snapshot) => {
        card.textContent = "";
        renderCodexVersionsCard(card, snapshot, requestReload);
        schedulePoll(snapshot);
    };
    async function load(force) {
        const current = ++generation;
        refresh.disabled = true;
        try {
            const snapshot = await electron_1.ipcRenderer.invoke(force ? "tweaker:refresh-codex-versions" : "tweaker:get-codex-versions");
            if (current !== generation || !card.isConnected)
                return;
            show(snapshot);
            if (!force && isCodexSnapshotStale(snapshot)) {
                void load(true);
            }
        }
        catch (error) {
            if (current !== generation || !card.isConnected)
                return;
            card.textContent = "";
            card.appendChild(rowSimple("Codex versions unavailable", safeUiError(error)));
        }
        finally {
            if (current === generation)
                refresh.disabled = false;
        }
    }
    void load(false);
}
function renderCodexVersionsCard(card, snapshot, reload) {
    const bundled = snapshot.cli.bundled;
    const beta = snapshot.cli.beta;
    const busy = codexProgressBusy(snapshot.installProgress);
    if (snapshot.fromCache || snapshot.stale) {
        const checked = new Date(snapshot.checkedAt).toLocaleString();
        card.appendChild(rowSimple(snapshot.stale ? "Cached information (refresh needed)" : "Cached information", `Showing the last known good result from ${checked} while current information loads.`));
    }
    card.appendChild(codexVersionSurfaceOverview(snapshot));
    card.appendChild(codexActiveCliRow(snapshot));
    card.appendChild(codexEmbeddedCliRow(bundled, snapshot));
    card.appendChild(codexLatestStableReleaseRow(bundled));
    card.appendChild(codexCliRow("Managed Alpha CLI (Pre-release)", "beta", beta, snapshot, busy, reload));
    card.appendChild(codexRuntimeRow(snapshot));
    const releases = actionRow("GitHub Releases", "View official OpenAI Codex release notes and packages.");
    makeCodexRowResponsive(releases);
    releases.querySelector("[data-tweaker-row-actions]")?.appendChild(compactButton("Open Releases", () => openCodexGithubUrl("https://github.com/openai/codex/releases")));
    card.appendChild(releases);
    if (snapshot.installProgress && snapshot.installProgress.phase && snapshot.installProgress.phase !== "idle") {
        const p = snapshot.installProgress;
        const amount = formatBytes(p.bytes);
        const detail = p.error || [humanizeCodexPhase(p.phase), p.version, amount].filter(Boolean).join(" · ");
        card.appendChild(rowSimple("Alpha operation", detail));
    }
    const stateMessage = codexRuntimeMessage(snapshot);
    if (stateMessage)
        card.appendChild(rowSimple("Runtime status", stateMessage));
    card.appendChild(codexFeatureBrowser(snapshot, busy, reload));
}
function codexVersionSurfaceOverview(snapshot) {
    const stable = snapshot.cli.bundled.release?.version ?? "Not checked";
    const prerelease = snapshot.cli.beta.release?.version ?? "Not checked";
    const desktopPrerelease = snapshot.cli.bundled.versionChannel === "prerelease"
        ? snapshot.cli.bundled.version ?? "Not checked"
        : "Not included in this desktop release";
    const overview = document.createElement("div");
    overview.className = "grid grid-cols-1 gap-3 p-3 md:grid-cols-2";
    overview.dataset.tweakerCodexVersionOverview = "true";
    overview.append(codexVersionSurfaceSummary("Terminal", [
        ["Latest Release", stable],
        ["Latest Pre-Release", prerelease],
        ["Current", snapshot.terminalCli.version ?? "Not installed"],
    ]), codexVersionSurfaceSummary("Desktop macOS", [
        ["Latest Release", stable],
        ["Latest Pre-Release", desktopPrerelease],
        ["Current", snapshot.activeCli.version ?? "Unavailable"],
    ]));
    return overview;
}
function codexVersionSurfaceSummary(titleText, metrics) {
    const surface = document.createElement("div");
    surface.className = "border-token-border flex min-w-0 flex-col gap-2 rounded-lg border p-3";
    const title = document.createElement("div");
    title.className = "text-sm font-semibold text-token-text-primary";
    title.textContent = titleText;
    surface.appendChild(title);
    for (const [label, value] of metrics) {
        const metric = document.createElement("div");
        metric.className = "flex min-w-0 items-baseline justify-between gap-3";
        const key = document.createElement("span");
        key.className = "text-token-text-secondary text-xs";
        key.textContent = label;
        const version = document.createElement("span");
        version.className = "min-w-0 truncate text-right font-mono text-sm text-token-text-primary";
        version.textContent = value;
        version.title = value;
        metric.append(key, version);
        surface.appendChild(metric);
    }
    return surface;
}
function codexActiveCliRow(snapshot) {
    const active = snapshot.activeCli;
    const version = active.version ?? "Unavailable";
    const channel = codexVersionChannelLabel(active.versionChannel);
    const source = active.source === "bundled"
        ? `${channel} · embedded in the OpenAI desktop app · app-managed`
        : active.source === "managed-alpha"
            ? `${channel} · managed by Tweakers`
            : `${channel} · external CODEX_CLI_PATH override`;
    const detail = [`Version ${version}`, source, active.path, active.error].filter(Boolean).join(" · ");
    const row = actionRow("Active Codex backend", detail);
    makeCodexRowResponsive(row);
    row.title = active.path;
    row.querySelector("[data-tweaker-row-actions]")?.appendChild(statusBadge(active.available ? "ok" : "error", active.available ? "Active" : "Unavailable"));
    return row;
}
function codexEmbeddedCliRow(cli, snapshot) {
    const version = cli.version ?? "Unavailable";
    const channel = codexVersionChannelLabel(cli.versionChannel);
    const detail = [
        `Version ${version}`,
        channel,
        "Embedded in the OpenAI desktop app; it changes only when OpenAI ships a desktop update",
        cli.path,
        cli.available ? null : cli.error,
    ].filter(Boolean).join(" · ");
    const row = actionRow("Desktop-Embedded Codex CLI", detail);
    makeCodexRowResponsive(row);
    row.title = cli.path ?? "";
    const actions = row.querySelector("[data-tweaker-row-actions]");
    if (snapshot.activeCli.source === "bundled")
        actions?.appendChild(statusBadge("ok", "Active"));
    else
        actions?.appendChild(codexNeutralBadge("App-managed"));
    if (cli.version) {
        const releaseUrl = `https://github.com/openai/codex/releases/tag/rust-v${encodeURIComponent(cli.version)}`;
        actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(releaseUrl)));
    }
    return row;
}
function codexLatestStableReleaseRow(cli) {
    const release = cli.release;
    const detail = release
        ? `Latest stable standalone release ${release.version} · This does not replace the desktop-embedded backend.`
        : `Latest stable standalone release unavailable${cli.error ? ` · ${cli.error}` : ""}`;
    const row = actionRow("Latest Stable CLI Release", detail);
    makeCodexRowResponsive(row);
    const actions = row.querySelector("[data-tweaker-row-actions]");
    actions?.appendChild(codexNeutralBadge("Stable"));
    if (isSafeCodexGithubUrl(release?.releaseUrl)) {
        actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(release.releaseUrl)));
    }
    return row;
}
function codexCliRow(label, lane, cli, snapshot, busy, reload) {
    const installed = cli.managedCurrentVersion ?? cli.version;
    const latest = cli.release?.version;
    const detail = installedLatestSummary(installed, latest, cli.error || cli.release?.error);
    const row = actionRow(label, detail);
    makeCodexRowResponsive(row);
    const actions = row.querySelector("[data-tweaker-row-actions]");
    if (snapshot.effectiveLane === lane)
        actions?.prepend(statusBadge("ok", "Active"));
    const releaseUrl = cli.release?.releaseUrl;
    if (isSafeCodexGithubUrl(releaseUrl))
        actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(releaseUrl)));
    if (lane === "beta") {
        const installLabel = installed && latest && installed !== latest ? "Update" : installed ? "Reinstall" : "Install";
        const install = compactButton(installLabel, () => runCodexAction(row, "tweaker:install-codex-beta", undefined, reload));
        install.disabled = busy || !latest;
        actions?.appendChild(install);
        const previousVersion = cli.managedPreviousVersion;
        if (previousVersion) {
            const rollback = compactButton(`Rollback to ${previousVersion}`, () => runCodexAction(row, "tweaker:rollback-codex-beta", undefined, reload));
            rollback.disabled = busy;
            actions?.appendChild(rollback);
        }
    }
    return row;
}
function codexRuntimeRow(snapshot) {
    const requested = snapshot.requestedLane;
    const selected = requested
        ? requested === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded (app-managed)"
        : snapshot.userOverridePreserved ? "External override" : "Not explicitly selected";
    const active = snapshot.activeCli.source === "managed-alpha"
        ? "Managed Alpha"
        : snapshot.activeCli.source === "bundled"
            ? "Desktop-embedded"
            : "External override";
    const activeChannel = codexVersionChannelLabel(snapshot.activeCli.versionChannel);
    const activeVersion = snapshot.activeCli.version ? ` ${snapshot.activeCli.version}` : "";
    const row = actionRow("Selected runtime", `Selected: ${selected}. Active: ${active}${activeVersion} · ${activeChannel}. Desktop profile and CLI release channel are reported separately.`);
    makeCodexRowResponsive(row);
    const actions = row.querySelector("[data-tweaker-row-actions]");
    actions?.appendChild(codexNeutralBadge("Managed by Environment"));
    return row;
}
function codexFeatureBrowser(snapshot, busy, reload) {
    const wrapper = document.createElement("div");
    wrapper.className = "p-3";
    const details = document.createElement("details");
    details.dataset.tweakerFeatureBrowser = "true";
    const summary = document.createElement("summary");
    summary.className = "cursor-pointer text-sm text-token-text-primary";
    const features = snapshot.features;
    summary.textContent = `Codex CLI features (${features.length})`;
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "mt-3 flex flex-col gap-3";
    const filters = document.createElement("div");
    filters.className = "flex flex-wrap items-center gap-2";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search Codex features";
    search.className = "border-token-border bg-token-foreground/5 h-token-button-composer min-w-[180px] flex-1 rounded-md border px-3 text-sm text-token-text-primary";
    const stage = codexFilterSelect("Stage", ["all", "stable", "experimental", "under-development", "deprecated", "removed"]);
    const lane = codexFilterSelect("Lane", ["all", "bundled", "beta", "bundled-only", "beta-only"]);
    const status = codexFilterSelect("Status", ["all", "enabled", "disabled", "unsupported", "read-only"]);
    filters.append(search, stage, lane, status);
    content.appendChild(filters);
    const list = document.createElement("div");
    list.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
    content.appendChild(list);
    const draw = () => {
        list.textContent = "";
        const query = search.value.trim().toLowerCase();
        const selectedLane = snapshot.requestedLane ?? snapshot.effectiveLane ?? "bundled";
        const shown = features.filter((feature) => {
            const featureStage = codexFeatureStage(feature, selectedLane);
            const enabled = codexFeatureEnabled(feature, selectedLane);
            const laneMatch = lane.value === "all"
                || (lane.value === "bundled-only" && feature.bundledOnly)
                || (lane.value === "beta-only" && feature.betaOnly)
                || (lane.value === "bundled" && codexFeatureStage(feature, "bundled") !== null)
                || (lane.value === "beta" && codexFeatureStage(feature, "beta") !== null);
            const statusMatch = status.value === "all" || (status.value === "enabled" && enabled === true) || (status.value === "disabled" && enabled === false) || (status.value === "unsupported" && feature.supported === false) || (status.value === "read-only" && !codexFeatureMutable(feature, selectedLane));
            return (!query || feature.name.toLowerCase().includes(query)) && (stage.value === "all" || stage.value === featureStage) && laneMatch && statusMatch;
        });
        for (const feature of shown)
            list.appendChild(codexFeatureRow(feature, selectedLane, busy, reload));
        if (!shown.length)
            list.appendChild(rowSimple("No matching features", "Try a different search or filter."));
    };
    for (const input of [search, stage, lane, status])
        input.addEventListener(input === search ? "input" : "change", draw);
    draw();
    details.appendChild(content);
    wrapper.appendChild(details);
    return wrapper;
}
function codexFeatureRow(feature, lane, busy, reload) {
    const stage = codexFeatureStage(feature, lane);
    const enabled = codexFeatureEnabled(feature, lane);
    const mutable = codexFeatureMutable(feature, lane);
    const row = document.createElement("div");
    row.className = "flex flex-wrap items-center justify-between gap-3 p-3";
    const left = rowCopy(feature.name, `${stage || "unsupported"} · ${feature.effect === "restart" ? "Restart required" : feature.effect === "none" ? "No restart" : "Applies to new sessions"}`);
    const badges = document.createElement("div");
    badges.className = "flex flex-wrap items-center gap-1";
    if (feature.bundledOnly)
        badges.appendChild(codexNeutralBadge("Bundled only"));
    if (feature.betaOnly)
        badges.appendChild(codexNeutralBadge("Beta only"));
    if (feature.supported === false)
        badges.appendChild(codexNeutralBadge("Unsupported"));
    if (enabled === true)
        badges.appendChild(statusBadge("ok", "Enabled"));
    if (enabled === false)
        badges.appendChild(codexNeutralBadge("Disabled"));
    left.appendChild(badges);
    row.appendChild(left);
    if (mutable && enabled !== null) {
        const toggle = switchControl(enabled, async (next) => {
            toggle.disabled = true;
            try {
                await electron_1.ipcRenderer.invoke("tweaker:set-codex-feature", { lane, name: feature.name, enabled: next });
                reload();
            }
            catch (error) {
                window.alert(`Could not update ${feature.name}: ${safeUiError(error)}`);
                reload();
            }
            finally {
                toggle.disabled = false;
            }
        });
        toggle.disabled = busy;
        toggle.title = "Feature changes apply to new sessions.";
        row.appendChild(toggle);
    }
    else {
        row.appendChild(codexNeutralBadge(stage === "deprecated" || stage === "removed" ? "Read only" : "Unavailable"));
    }
    return row;
}
function codexFeatureStage(feature, lane) {
    return feature.stages[lane];
}
function codexFeatureEnabled(feature, lane) {
    return feature.enabled[lane];
}
function codexFeatureMutable(feature, lane) {
    const stage = codexFeatureStage(feature, lane);
    return feature.mutable === true
        && feature.supported !== false
        && stage !== "deprecated"
        && stage !== "removed"
        && codexFeatureEnabled(feature, lane) !== null;
}
function codexFilterSelect(label, options) {
    const select = document.createElement("select");
    select.className = "border-token-border bg-token-foreground/5 h-token-button-composer rounded-md border px-2 text-sm text-token-text-primary";
    select.title = label;
    for (const value of options) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "all" ? `All ${label.toLowerCase()}s` : humanizeCodexPhase(value);
        select.appendChild(option);
    }
    return select;
}
function codexNeutralBadge(text) {
    const badge = document.createElement("span");
    badge.className = "inline-flex shrink-0 items-center rounded-full border border-token-border bg-token-foreground/5 px-2 py-0.5 text-xs text-token-text-secondary";
    badge.textContent = text;
    return badge;
}
function makeCodexRowResponsive(row) {
    row.classList.add("flex-wrap");
    row.querySelector("[data-tweaker-row-actions]")?.classList.add("flex-wrap", "justify-end");
}
function codexInlineMessage(text) {
    const message = document.createElement("div");
    message.className = "text-token-text-secondary min-w-0 text-sm";
    message.textContent = text;
    return message;
}
function codexProgressBusy(progress) {
    return !["idle", "complete", "failed"].includes(progress.phase);
}
function isCodexSnapshotStale(snapshot) {
    return snapshot.stale;
}
function installedLatestSummary(installed, latest, error) {
    const installedText = installed || "Unavailable";
    const latestText = latest || "Unavailable";
    return `Installed ${installedText} · Latest ${latestText}${error ? ` · ${error}` : ""}`;
}
function codexRuntimeMessage(snapshot) {
    if (snapshot.fallbackReason)
        return `Managed Alpha could not start; the desktop-embedded backend was used. ${snapshot.fallbackReason}`;
    if (snapshot.restartRequired)
        return "Restart the app to apply the selected Codex runtime.";
    if (snapshot.requestedLane && snapshot.effectiveLane && snapshot.requestedLane !== snapshot.effectiveLane) {
        return `${snapshot.requestedLane === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded"} is selected; ${snapshot.effectiveLane === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded"} remains active until restart.`;
    }
    return null;
}
function codexVersionChannelLabel(channel) {
    if (channel === "stable")
        return "Stable";
    if (channel === "prerelease")
        return "Pre-release";
    return "Unknown release channel";
}
function codexScopedError(snapshot, scope) {
    return snapshot.errors[scope] ?? null;
}
function isSafeCodexGithubUrl(url) {
    if (!url)
        return false;
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:"
            && parsed.hostname === "github.com"
            && parsed.port === ""
            && parsed.username === ""
            && parsed.password === ""
            && (parsed.pathname === "/openai/codex" || parsed.pathname.startsWith("/openai/codex/"));
    }
    catch {
        return false;
    }
}
function openCodexGithubUrl(url) {
    if (!isSafeCodexGithubUrl(url)) {
        plog("blocked non-Codex GitHub URL", url);
        return;
    }
    void electron_1.ipcRenderer.invoke("tweaker:open-external", url).catch((error) => plog("open Codex release failed", String(error)));
}
function runCodexAction(row, channel, payload, reload) {
    const buttons = row.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    row.style.opacity = "0.65";
    reload("operation-start");
    const invoke = payload === undefined ? electron_1.ipcRenderer.invoke(channel) : electron_1.ipcRenderer.invoke(channel, payload);
    void invoke
        .catch((error) => {
        window.alert(safeUiError(error));
    })
        .finally(() => {
        row.style.opacity = "";
        buttons.forEach((button) => { button.disabled = false; });
        reload("operation-stop");
    });
}
function safeUiError(error) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
}
function humanizeCodexPhase(value) {
    return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatBytes(value) {
    if (value < 1024)
        return `${value} B`;
    if (value < 1024 * 1024)
        return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function renderTweakerConfig(card, config) {
    setSidebarTweakerUpdateButton(config.updateCheck);
    card.appendChild(autoUpdateRow(config));
    card.appendChild(updateChannelRow(config));
    card.appendChild(installationSourceRow(config.installationSource));
    card.appendChild(selfUpdateStatusRow(config.selfUpdate));
    card.appendChild(checkForUpdatesRow(config));
    if (config.updateCheck?.releaseNotes)
        card.appendChild(releaseNotesRow(config.updateCheck));
}
function autoUpdateRow(config) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const left = document.createElement("div");
    left.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-token-text-primary";
    title.textContent = "Automatically refresh Tweakers";
    const desc = document.createElement("div");
    desc.className = "text-token-text-secondary min-w-0 text-sm";
    desc.textContent = `Installed version v${config.version}. The watcher checks hourly and can refresh the Tweakers runtime automatically.`;
    left.appendChild(title);
    left.appendChild(desc);
    row.appendChild(left);
    row.appendChild(switchControl(config.autoUpdate, async (next) => {
        await electron_1.ipcRenderer.invoke("tweaker:set-auto-update", next);
    }));
    return row;
}
function updateChannelRow(config) {
    const row = actionRow("Release channel", updateChannelSummary(config));
    const action = row.querySelector("[data-tweaker-row-actions]");
    const select = document.createElement("select");
    select.className =
        "h-8 rounded-lg border border-token-border bg-transparent px-2 text-sm text-token-text-primary focus:outline-none";
    for (const [value, label] of [
        ["stable", "Stable"],
        ["prerelease", "Prerelease"],
        ["custom", "Custom"],
    ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        option.selected = config.updateChannel === value;
        select.appendChild(option);
    }
    select.addEventListener("change", () => {
        void electron_1.ipcRenderer
            .invoke("tweaker:set-update-config", { updateChannel: select.value })
            .then(() => refreshConfigCard(row))
            .catch((e) => plog("set update channel failed", String(e)));
    });
    action?.appendChild(select);
    if (config.updateChannel === "custom") {
        action?.appendChild(compactButton("Edit", () => {
            const repo = window.prompt("GitHub repo", config.updateRepo || "therealityreport/tweakers");
            if (repo === null)
                return;
            const ref = window.prompt("Git ref", config.updateRef || "main");
            if (ref === null)
                return;
            void electron_1.ipcRenderer
                .invoke("tweaker:set-update-config", {
                updateChannel: "custom",
                updateRepo: repo,
                updateRef: ref,
            })
                .then(() => refreshConfigCard(row))
                .catch((e) => plog("set custom update source failed", String(e)));
        }));
    }
    return row;
}
function installationSourceRow(source) {
    return rowSimple("Installation source", `${source.label}: ${source.detail}`);
}
function selfUpdateStatusRow(state) {
    const row = rowSimple("Last Tweakers update", selfUpdateSummary(state));
    const left = row.firstElementChild;
    if (left && state) {
        const unpublished = state.status === "failed" && /404|no (?:published |github )?release/i.test(state.error ?? "");
        left.prepend(statusBadge(unpublished ? "ok" : selfUpdateStatusTone(state.status), unpublished ? "Current" : selfUpdateStatusLabel(state.status)));
    }
    return row;
}
function checkForUpdatesRow(config) {
    const check = config.updateCheck;
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const left = document.createElement("div");
    left.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-token-text-primary";
    title.textContent = check?.updateAvailable ? "Tweakers update available" : "Check for Tweakers updates";
    const desc = document.createElement("div");
    desc.className = "text-token-text-secondary min-w-0 text-sm";
    desc.textContent = updateSummary(check);
    left.appendChild(title);
    left.appendChild(desc);
    row.appendChild(left);
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 items-center gap-2";
    if (check?.releaseUrl) {
        actions.appendChild(compactButton("Release Notes", () => {
            void electron_1.ipcRenderer.invoke("tweaker:open-external", check.releaseUrl);
        }));
    }
    actions.appendChild(compactButton("Check Now", () => {
        row.style.opacity = "0.65";
        void electron_1.ipcRenderer
            .invoke("tweaker:check-tweaker-update", true)
            .then((check) => {
            setSidebarTweakerUpdateButton(check);
            refreshConfigCard(row);
        })
            .catch((e) => plog("Tweakers release check failed", String(e)))
            .finally(() => {
            row.style.opacity = "";
        });
    }));
    if (check?.updateAvailable)
        actions.appendChild(compactButton("Download Update", () => {
            row.style.opacity = "0.65";
            const buttons = actions.querySelectorAll("button");
            buttons.forEach((button) => (button.disabled = true));
            void electron_1.ipcRenderer
                .invoke("tweaker:run-tweaker-update")
                .then(() => {
                refreshSidebarTweakerUpdateButton(true);
                refreshConfigCard(row);
            })
                .catch((e) => {
                plog("Tweakers self-update failed", String(e));
                void refreshConfigCard(row);
            })
                .finally(() => {
                row.style.opacity = "";
                buttons.forEach((button) => (button.disabled = false));
            });
        }));
    row.appendChild(actions);
    return row;
}
function releaseNotesRow(check) {
    const row = document.createElement("div");
    row.className = "flex flex-col gap-2 p-3";
    const title = document.createElement("div");
    title.className = "text-sm text-token-text-primary";
    title.textContent = "Latest release notes";
    row.appendChild(title);
    const body = document.createElement("div");
    body.className =
        "max-h-60 overflow-auto rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary";
    body.appendChild(renderReleaseNotesMarkdown(check.releaseNotes?.trim() || check.error || "No release notes available."));
    row.appendChild(body);
    return row;
}
function renderReleaseNotesMarkdown(markdown) {
    const root = document.createElement("div");
    root.className = "flex flex-col gap-2";
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;
    let codeLines = null;
    const flushParagraph = () => {
        if (paragraph.length === 0)
            return;
        const p = document.createElement("p");
        p.className = "m-0 leading-5";
        appendInlineMarkdown(p, paragraph.join(" ").trim());
        root.appendChild(p);
        paragraph = [];
    };
    const flushList = () => {
        if (!list)
            return;
        root.appendChild(list);
        list = null;
    };
    const flushCode = () => {
        if (!codeLines)
            return;
        const pre = document.createElement("pre");
        pre.className =
            "m-0 overflow-auto rounded-md border border-token-border bg-token-foreground/10 p-2 text-xs text-token-text-primary";
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.appendChild(code);
        root.appendChild(pre);
        codeLines = null;
    };
    for (const line of lines) {
        if (line.trim().startsWith("```")) {
            if (codeLines)
                flushCode();
            else {
                flushParagraph();
                flushList();
                codeLines = [];
            }
            continue;
        }
        if (codeLines) {
            codeLines.push(line);
            continue;
        }
        const trimmed = line.trim();
        if (!trimmed) {
            flushParagraph();
            flushList();
            continue;
        }
        const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
        if (heading) {
            flushParagraph();
            flushList();
            const h = document.createElement(heading[1].length === 1 ? "h3" : "h4");
            h.className = "m-0 text-sm font-medium text-token-text-primary";
            appendInlineMarkdown(h, heading[2]);
            root.appendChild(h);
            continue;
        }
        const unordered = /^[-*]\s+(.+)$/.exec(trimmed);
        const ordered = /^\d+[.)]\s+(.+)$/.exec(trimmed);
        if (unordered || ordered) {
            flushParagraph();
            const wantOrdered = Boolean(ordered);
            if (!list || (wantOrdered && list.tagName !== "OL") || (!wantOrdered && list.tagName !== "UL")) {
                flushList();
                list = document.createElement(wantOrdered ? "ol" : "ul");
                list.className = wantOrdered
                    ? "m-0 list-decimal space-y-1 pl-5 leading-5"
                    : "m-0 list-disc space-y-1 pl-5 leading-5";
            }
            const li = document.createElement("li");
            appendInlineMarkdown(li, (unordered ?? ordered)?.[1] ?? "");
            list.appendChild(li);
            continue;
        }
        const quote = /^>\s?(.+)$/.exec(trimmed);
        if (quote) {
            flushParagraph();
            flushList();
            const blockquote = document.createElement("blockquote");
            blockquote.className = "m-0 border-l-2 border-token-border pl-3 leading-5";
            appendInlineMarkdown(blockquote, quote[1]);
            root.appendChild(blockquote);
            continue;
        }
        paragraph.push(trimmed);
    }
    flushParagraph();
    flushList();
    flushCode();
    return root;
}
function appendInlineMarkdown(parent, text) {
    const pattern = /(`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*)/g;
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index === undefined)
            continue;
        appendText(parent, text.slice(lastIndex, match.index));
        if (match[2] !== undefined) {
            const code = document.createElement("code");
            code.className =
                "rounded border border-token-border bg-token-foreground/10 px-1 py-0.5 text-xs text-token-text-primary";
            code.textContent = match[2];
            parent.appendChild(code);
        }
        else if (match[3] !== undefined && match[4] !== undefined) {
            const a = document.createElement("a");
            a.className = "text-token-text-primary underline underline-offset-2";
            a.href = match[4];
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = match[3];
            parent.appendChild(a);
        }
        else if (match[5] !== undefined) {
            const strong = document.createElement("strong");
            strong.className = "font-medium text-token-text-primary";
            strong.textContent = match[5];
            parent.appendChild(strong);
        }
        else if (match[6] !== undefined) {
            const em = document.createElement("em");
            em.textContent = match[6];
            parent.appendChild(em);
        }
        lastIndex = match.index + match[0].length;
    }
    appendText(parent, text.slice(lastIndex));
}
function appendText(parent, text) {
    if (text)
        parent.appendChild(document.createTextNode(text));
}
function renderWatcherHealthCard(card) {
    void electron_1.ipcRenderer
        .invoke("tweaker:get-watcher-health")
        .then((health) => {
        card.textContent = "";
        renderWatcherHealth(card, health);
    })
        .catch((e) => {
        card.textContent = "";
        card.appendChild(rowSimple("Could not check watcher", String(e)));
    });
}
function renderWatcherHealth(card, health, includeRepair = false, onRepair) {
    card.appendChild(watcherSummaryRow(health));
    for (const check of health.checks) {
        if (check.status === "ok")
            continue;
        card.appendChild(watcherCheckRow(check));
    }
    if (includeRepair) {
        const row = actionRow("Automatic maintenance", health.status === "ok"
            ? "The watcher is healthy and will continue checking automatically."
            : "Repair the watcher registration and run a fresh health check.");
        const actions = row.querySelector("[data-tweaker-row-actions]");
        actions?.appendChild(compactButton("Repair Now", onRepair ?? (() => {
            const button = actions.querySelector("button");
            if (button)
                button.disabled = true;
            void electron_1.ipcRenderer.invoke("tweaker:repair-auto-maintenance")
                .then(() => electron_1.ipcRenderer.invoke("tweaker:get-watcher-health"))
                .then((next) => {
                card.textContent = "";
                renderWatcherHealth(card, next, true);
            })
                .catch((error) => {
                card.textContent = "";
                renderWatcherHealth(card, {
                    ...health,
                    status: "error",
                    title: "Automatic maintenance repair failed",
                    summary: safeUiError(error),
                }, true);
            });
        })));
        card.appendChild(row);
    }
}
function watcherSummaryRow(health) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const left = document.createElement("div");
    left.className = "flex min-w-0 items-start gap-3";
    left.appendChild(statusBadge(health.status, health.watcher));
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-token-text-primary";
    title.textContent = health.title;
    const desc = document.createElement("div");
    desc.className = "text-token-text-secondary min-w-0 text-sm";
    desc.textContent = `${health.summary} Checked ${new Date(health.checkedAt).toLocaleString()}.`;
    stack.appendChild(title);
    stack.appendChild(desc);
    left.appendChild(stack);
    row.appendChild(left);
    const action = document.createElement("div");
    action.className = "flex shrink-0 items-center gap-2";
    action.appendChild(compactButton("Check Now", () => {
        const card = row.parentElement;
        if (!card)
            return;
        card.textContent = "";
        card.appendChild(rowSimple("Checking watcher", "Verifying the updater repair service."));
        renderWatcherHealthCard(card);
    }));
    row.appendChild(action);
    return row;
}
function watcherCheckRow(check) {
    const row = rowSimple(check.name, check.detail);
    const left = row.firstElementChild;
    if (left)
        left.prepend(statusBadge(check.status));
    return row;
}
function statusBadge(status, label) {
    const badge = document.createElement("span");
    const tone = status === "ok"
        ? "border-token-charts-green text-token-charts-green"
        : status === "warn"
            ? "border-token-charts-yellow text-token-charts-yellow"
            : "border-token-charts-red text-token-charts-red";
    badge.className = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`;
    badge.textContent = label || (status === "ok" ? "OK" : status === "warn" ? "Review" : "Error");
    return badge;
}
function updateSummary(check) {
    if (!check)
        return "No update check has run yet.";
    const latest = check.latestVersion ? `Latest v${check.latestVersion}. ` : "";
    const checked = `Checked ${new Date(check.checkedAt).toLocaleString()}.`;
    if (check.error)
        return `${latest}${checked} ${check.error}`;
    return `${latest}${checked}`;
}
function updateChannelSummary(config) {
    if (config.updateChannel === "custom") {
        return `${config.updateRepo || "therealityreport/tweakers"} ${config.updateRef || "(no ref set)"}`;
    }
    if (config.updateChannel === "prerelease") {
        return "Use the newest published GitHub release, including prereleases.";
    }
    return "Use the latest stable GitHub release.";
}
function selfUpdateSummary(state) {
    if (!state)
        return "No automatic Tweakers update has run yet.";
    const checked = new Date(state.completedAt ?? state.checkedAt).toLocaleString();
    const target = state.latestVersion ? ` Target v${state.latestVersion}.` : state.targetRef ? ` Target ${state.targetRef}.` : "";
    const source = state.installationSource?.label ?? "unknown source";
    if (state.status === "failed" && /404|no (?:published |github )?release/i.test(state.error ?? ""))
        return `Source checkout is current as of ${checked}; no published release exists yet.`;
    if (state.status === "failed")
        return `Update check needs attention (${checked}). ${state.error ?? "Unknown error"}`;
    if (state.status === "updated")
        return `Updated ${checked}.${target} Source: ${source}.`;
    if (state.status === "up-to-date")
        return `Up to date ${checked}.${target} Source: ${source}.`;
    if (state.status === "disabled")
        return `Skipped ${checked}; automatic refresh is disabled.`;
    return `Checking for updates. Source: ${source}.`;
}
function selfUpdateStatusTone(status) {
    if (status === "failed")
        return "error";
    if (status === "disabled" || status === "checking")
        return "warn";
    return "ok";
}
function selfUpdateStatusLabel(status) {
    if (status === "up-to-date")
        return "Up to date";
    if (status === "updated")
        return "Updated";
    if (status === "failed")
        return "Failed";
    if (status === "disabled")
        return "Disabled";
    return "Checking";
}
function refreshConfigCard(row) {
    const card = row.closest("[data-tweaker-config-card]");
    if (!card)
        return;
    card.textContent = "";
    card.appendChild(rowSimple("Refreshing", "Loading current Tweakers update status."));
    void electron_1.ipcRenderer
        .invoke("tweaker:get-config")
        .then((config) => {
        card.textContent = "";
        renderTweakerConfig(card, config);
    })
        .catch((e) => {
        card.textContent = "";
        card.appendChild(rowSimple("Could not refresh update settings", String(e)));
    });
}
function uninstallRow() {
    const row = actionRow("Uninstall Tweakers", "Copies the uninstall command. Run it from a terminal after quitting Codex.");
    const action = row.querySelector("[data-tweaker-row-actions]");
    action?.appendChild(compactButton("Copy Command", () => {
        void electron_1.ipcRenderer
            .invoke("tweaker:copy-text", "node ~/.tweaker/source/packages/installer/dist/cli.js uninstall")
            .catch((e) => plog("copy uninstall command failed", String(e)));
    }));
    return row;
}
function reportBugRow() {
    const row = actionRow("Report a bug", "Open a GitHub issue with runtime, installer, or tweak-manager details.");
    const action = row.querySelector("[data-tweaker-row-actions]");
    action?.appendChild(compactButton("Open Issue", () => {
        const title = encodeURIComponent("[Bug]: ");
        const body = encodeURIComponent([
            "## What happened?",
            "",
            "## Steps to reproduce",
            "1. ",
            "",
            "## Environment",
            "- Tweakers version: ",
            "- Codex app version: ",
            "- OS: ",
            "",
            "## Logs",
            "Attach relevant lines from the Tweakers log directory.",
        ].join("\n"));
        void electron_1.ipcRenderer.invoke("tweaker:open-external", `https://github.com/therealityreport/tweakers/issues/new?title=${title}&body=${body}`);
    }));
    return row;
}
function actionRow(titleText, description) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const left = document.createElement("div");
    left.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-token-text-primary";
    title.textContent = titleText;
    const desc = document.createElement("div");
    desc.className = "text-token-text-secondary min-w-0 text-sm";
    desc.textContent = description;
    left.appendChild(title);
    left.appendChild(desc);
    row.appendChild(left);
    const actions = document.createElement("div");
    actions.dataset.tweakerRowActions = "true";
    actions.className = "flex shrink-0 items-center gap-2";
    row.appendChild(actions);
    return row;
}
function renderTweakStorePage(sectionsWrap, headerActions) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-4";
    const source = document.createElement("span");
    source.hidden = true;
    source.dataset.tweakerStoreSource = "true";
    source.textContent = "Loading live registry";
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 items-center gap-2";
    const refreshBtn = storeIconButton(refreshIconSvg(), "Refresh tweak store", () => {
        refreshBtn.disabled = true;
        updateStoreUpdateBadge(null);
        grid.textContent = "";
        renderTweakStoreGhostGrid(grid);
        refreshTweakStoreGrid(grid, source, refreshBtn, true);
    });
    actions.appendChild(refreshBtn);
    actions.appendChild(storeToolbarButton("Publish Tweak", openPublishTweakDialog, "primary"));
    if (headerActions) {
        headerActions.replaceChildren(actions);
    }
    const grid = document.createElement("div");
    grid.dataset.tweakerStoreGrid = "true";
    grid.className = "grid gap-4";
    if (state.tweakStore) {
        grid.dataset.tweakerStore = JSON.stringify(state.tweakStore);
        renderTweakStoreGrid(grid, source);
    }
    else {
        renderTweakStoreGhostGrid(grid);
    }
    section.appendChild(source);
    section.appendChild(grid);
    sectionsWrap.appendChild(section);
    refreshTweakStoreGrid(grid, source, refreshBtn);
}
function refreshTweakStoreGrid(grid, source, refreshBtn, force = false) {
    void getTweakStore(force)
        .then((store) => {
        grid.dataset.tweakerStore = JSON.stringify(store);
        renderTweakStoreGrid(grid, source);
    })
        .catch((e) => {
        grid.dataset.tweakerStore = "";
        grid.removeAttribute("aria-busy");
        source.textContent = "Live registry unavailable";
        updateStoreUpdateBadge(null);
        grid.textContent = "";
        grid.appendChild(storeMessageCard("Could not load tweak store", String(e)));
    })
        .finally(() => {
        if (refreshBtn)
            refreshBtn.disabled = false;
    });
}
function warmTweakStore() {
    if (state.tweakStore || state.tweakStorePromise)
        return;
    void getTweakStore().then((store) => {
        updateStoreUpdateBadge(outdatedInstalledStoreCount(store.entries));
    });
}
function getTweakStore(force = false) {
    if (!force) {
        if (state.tweakStore)
            return Promise.resolve(state.tweakStore);
        if (state.tweakStorePromise)
            return state.tweakStorePromise;
    }
    state.tweakStoreError = null;
    const promise = electron_1.ipcRenderer
        .invoke("tweaker:get-tweak-store")
        .then((store) => {
        state.tweakStore = store;
        return state.tweakStore;
    })
        .catch((e) => {
        state.tweakStoreError = e;
        throw e;
    })
        .finally(() => {
        if (state.tweakStorePromise === promise)
            state.tweakStorePromise = null;
    });
    state.tweakStorePromise = promise;
    return promise;
}
function renderTweakStoreGrid(grid, source) {
    const store = parseStoreDataset(grid);
    if (!store)
        return;
    const entries = store.entries;
    grid.removeAttribute("aria-busy");
    source.textContent = `Refreshed ${new Date(store.fetchedAt).toLocaleString()}`;
    updateStoreUpdateBadge(outdatedInstalledStoreCount(entries));
    grid.textContent = "";
    if (store.entries.length === 0) {
        grid.appendChild(storeMessageCard("No tweaks yet", "Use Publish Tweak to submit the first one."));
        return;
    }
    for (const entry of entries)
        grid.appendChild(tweakStoreCard(entry));
}
function parseStoreDataset(grid) {
    const raw = grid.dataset.tweakerStore;
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function tweakStoreCard(entry) {
    const shell = tweakStoreCardShell();
    const { card, left, stack, versions, actions } = shell;
    left.insertBefore(storeAvatar(entry), stack);
    const titleRow = tweakStoreTitleRow();
    const title = document.createElement("div");
    title.className = "min-w-0 text-lg font-semibold leading-7 text-token-foreground";
    title.textContent = entry.manifest.name;
    titleRow.appendChild(title);
    titleRow.appendChild(verifiedSafeBadge());
    stack.appendChild(titleRow);
    if (entry.manifest.description) {
        const desc = tweakStoreDescription();
        desc.textContent = entry.manifest.description;
        stack.appendChild(desc);
    }
    stack.appendChild(tweakStoreReadMoreButton(entry.repo ?? entry.manifest.githubRepo));
    versions.appendChild(tweakStoreVersionBadge(entry));
    if (entry.releaseUrl) {
        actions.appendChild(compactButton("Release", () => {
            void electron_1.ipcRenderer.invoke("tweaker:open-external", entry.releaseUrl);
        }));
    }
    const hasUpdate = !!entry.installed && entry.installed.version !== entry.manifest.version;
    if (entry.available === false) {
        card.classList.add("opacity-70");
        actions.appendChild(storeStatusPill("Not available yet"));
    }
    else if (entry.installed && !hasUpdate) {
        actions.appendChild(storeStatusPill("Installed"));
    }
    else if (entry.platform && !entry.platform.compatible) {
        card.classList.add("opacity-70");
        actions.appendChild(storeStatusPill(platformLockedLabel(entry.platform)));
    }
    else if (entry.runtime && !entry.runtime.compatible) {
        card.classList.add("opacity-70");
        actions.appendChild(storeStatusPill(runtimeLockedLabel(entry.runtime)));
    }
    else {
        const installLabel = entry.installed ? "Update" : "Install";
        if (hasUpdate)
            actions.appendChild(storeStatusPill("Update available", "info"));
        const installButton = storeInstallButton(installLabel, (button) => {
            const grid = card.closest("[data-tweaker-store-grid]");
            const source = grid?.parentElement?.querySelector("[data-tweaker-store-source]");
            showStoreButtonLoading(button, entry.installed ? "Updating" : "Installing");
            actions.querySelectorAll("button").forEach((button) => (button.disabled = true));
            void electron_1.ipcRenderer
                .invoke("tweaker:install-store-tweak", entry.id)
                .then(() => {
                showStoreToast(`${entry.manifest.name} installed.`);
                showStoreButtonInstalled(button);
                versions.replaceChildren(tweakStoreVersionBadge(entry, entry.manifest.version));
                updateStoreUpdateBadge(Math.max(0, currentStoreUpdateBadgeCount() - 1));
                setTimeout(() => {
                    actions.replaceChildren(storeStatusPill("Installed"));
                    if (grid && source)
                        refreshTweakStoreGrid(grid, source, undefined, true);
                }, 900);
            })
                .catch((e) => {
                resetStoreInstallButton(button, installLabel);
                actions.querySelectorAll("button").forEach((button) => (button.disabled = false));
                showStoreCardMessage(card, String(e.message ?? e));
            });
        });
        actions.appendChild(installButton);
    }
    return card;
}
function platformLockedLabel(platform) {
    const supported = platform.supported ?? [];
    if (supported.includes("win32"))
        return "Windows only";
    if (supported.includes("darwin"))
        return "macOS only";
    if (supported.includes("linux"))
        return "Linux only";
    return "Unavailable";
}
function runtimeLockedLabel(runtime) {
    return runtime.required ? `Requires Tweakers ${runtime.required}` : "Requires newer Tweakers";
}
function showStoreCardMessage(card, message) {
    card.querySelector("[data-tweaker-store-card-message]")?.remove();
    const notice = document.createElement("div");
    notice.dataset.tweakerStoreCardMessage = "true";
    notice.className =
        "rounded-lg border border-token-border/50 bg-token-foreground/5 px-3 py-2 text-sm leading-5 text-token-description-foreground";
    notice.textContent = message;
    const actions = card.lastElementChild;
    if (actions)
        card.insertBefore(notice, actions);
    else
        card.appendChild(notice);
}
function tweakStoreCardShell() {
    const card = document.createElement("div");
    card.className =
        "border-token-border/40 flex min-h-[190px] flex-col justify-between gap-4 rounded-2xl border p-4 transition-colors hover:bg-token-foreground/5";
    const left = document.createElement("div");
    left.className = "flex min-w-0 flex-1 items-start gap-3";
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-1 flex-col gap-2";
    left.appendChild(stack);
    card.appendChild(left);
    const footer = document.createElement("div");
    footer.className = "mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2";
    const versions = document.createElement("div");
    versions.className = "flex min-w-0 flex-1 items-center gap-2";
    footer.appendChild(versions);
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 items-center justify-end gap-2";
    footer.appendChild(actions);
    card.appendChild(footer);
    return { card, left, stack, versions, actions };
}
function tweakStoreTitleRow() {
    const titleRow = document.createElement("div");
    titleRow.className = "flex min-w-0 items-start justify-between gap-3";
    return titleRow;
}
function tweakStoreDescription() {
    const desc = document.createElement("div");
    desc.className = "line-clamp-3 min-w-0 text-sm leading-5 text-token-text-secondary";
    return desc;
}
function tweakStoreReadMoreButton(repo) {
    const readMore = document.createElement("button");
    readMore.type = "button";
    readMore.className =
        "inline-flex w-fit items-center gap-1 text-sm font-medium text-token-text-link-foreground hover:underline";
    readMore.innerHTML =
        `Read More` +
            `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
            `<path d="M6 3.5h6.5V10M12.25 3.75 4 12" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>` +
            `</svg>`;
    readMore.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void electron_1.ipcRenderer.invoke("tweaker:open-external", `https://github.com/${repo}`);
    });
    return readMore;
}
function renderTweakStoreGhostGrid(grid) {
    grid.setAttribute("aria-busy", "true");
    grid.textContent = "";
    grid.appendChild(tweakStoreGhostCard());
}
function tweakStoreGhostCard() {
    const { card, left, stack, versions, actions } = tweakStoreCardShell();
    card.classList.add("pointer-events-none");
    card.setAttribute("aria-hidden", "true");
    left.insertBefore(storeAvatarGhost(), stack);
    const titleRow = tweakStoreTitleRow();
    const title = document.createElement("div");
    title.className = "min-w-0 text-lg font-semibold leading-7 text-token-foreground";
    title.appendChild(ghostBlock("my-1 h-5 w-44 rounded-md"));
    titleRow.appendChild(title);
    titleRow.appendChild(verifiedSafeGhostBadge());
    stack.appendChild(titleRow);
    const desc = tweakStoreDescription();
    desc.appendChild(ghostBlock("mt-1 h-3 w-full rounded"));
    desc.appendChild(ghostBlock("mt-2 h-3 w-11/12 rounded"));
    desc.appendChild(ghostBlock("mt-2 h-3 w-7/12 rounded"));
    stack.appendChild(desc);
    const readMore = tweakStoreReadMoreButton("");
    readMore.replaceChildren(ghostBlock("h-5 w-24 rounded"));
    stack.appendChild(readMore);
    versions.appendChild(storeVersionGhostBadge());
    actions.appendChild(storeStatusGhostPill());
    return card;
}
function storeAvatarGhost() {
    const avatar = document.createElement("div");
    avatar.className =
        "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-description-foreground";
    avatar.appendChild(ghostBlock("h-full w-full"));
    return avatar;
}
function verifiedSafeGhostBadge() {
    const badge = verifiedSafeBadge();
    badge.replaceChildren(ghostBlock("h-[13px] w-[13px] rounded-sm"), ghostBlock("h-3 w-20 rounded"));
    return badge;
}
function storeStatusGhostPill() {
    const pill = storeStatusPill("Installed");
    pill.classList.add("animate-pulse");
    pill.style.color = "transparent";
    return pill;
}
function storeVersionGhostBadge() {
    const badge = storeVersionBadgeShell(false);
    badge.appendChild(ghostBlock("h-3 w-36 rounded"));
    return badge;
}
function ghostBlock(className) {
    const block = document.createElement("div");
    block.className = `animate-pulse bg-token-foreground/10 ${className}`;
    block.setAttribute("aria-hidden", "true");
    return block;
}
function storeAvatar(entry) {
    const avatar = document.createElement("div");
    avatar.className =
        "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-description-foreground";
    const initial = (entry.manifest.name?.[0] ?? "?").toUpperCase();
    const fallback = document.createElement("span");
    fallback.textContent = initial;
    avatar.appendChild(fallback);
    const iconUrl = storeEntryIconUrl(entry);
    if (iconUrl) {
        const img = document.createElement("img");
        img.alt = "";
        img.className = "h-full w-full object-cover";
        img.style.display = "none";
        img.addEventListener("load", () => {
            fallback.remove();
            img.style.display = "";
        });
        img.addEventListener("error", () => {
            img.remove();
        });
        img.src = iconUrl;
        avatar.appendChild(img);
    }
    return avatar;
}
function storeEntryIconUrl(entry) {
    const iconUrl = entry.manifest.iconUrl?.trim();
    if (!iconUrl)
        return null;
    if (/^(https?:|data:)/i.test(iconUrl))
        return iconUrl;
    const rel = iconUrl.replace(/^\.?\//, "");
    if (!rel || rel.startsWith("../"))
        return null;
    if (entry.source?.kind === "bundled" || !entry.repo || !entry.approvedCommitSha)
        return null;
    return `https://raw.githubusercontent.com/${entry.repo}/${entry.approvedCommitSha}/${rel}`;
}
function sidebarUpdatePillButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.tweakerSidebarUpdate = "true";
    btn.className =
        "user-select-none no-drag cursor-interaction inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-token-charts-blue text-white hover:bg-token-charts-blue/80";
    Object.assign(btn.style, {
        display: "none",
        height: "20px",
        borderRadius: "9999px",
        border: "0",
        padding: "0 8px",
        fontSize: "10px",
        fontWeight: "700",
        lineHeight: "20px",
        letterSpacing: "0",
        textTransform: "none",
    });
    btn.textContent = "Update";
    btn.title = "Open Tweakers update";
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void electron_1.ipcRenderer.invoke("tweaker:open-external", btn.dataset.tweakerReleaseUrl || TWEAKERS_RELEASES_URL);
    });
    return btn;
}
function refreshSidebarTweakerUpdateButton(force = false) {
    const btn = state.tweakerUpdateButton;
    if (!btn)
        return;
    void electron_1.ipcRenderer
        .invoke("tweaker:check-tweaker-update", force)
        .then((check) => setSidebarTweakerUpdateButton(check))
        .catch((e) => {
        plog("Tweakers sidebar release check failed", String(e));
        setSidebarTweakerUpdateButton(null);
    });
}
function setSidebarTweakerUpdateButton(check) {
    const btn = state.tweakerUpdateButton;
    if (!btn)
        return;
    const updateAvailable = check?.updateAvailable === true;
    btn.style.display = updateAvailable ? "inline-flex" : "none";
    btn.hidden = !updateAvailable;
    btn.dataset.tweakerReleaseUrl = check?.releaseUrl || TWEAKERS_RELEASES_URL;
    btn.title =
        updateAvailable && check?.latestVersion
            ? `Open Tweakers ${check.latestVersion} update`
            : "Open Tweakers update";
}
function updateStoreUpdateBadge(count) {
    const badge = document.querySelector("[data-tweaker-store-update-badge]");
    if (!badge)
        return;
    badge.dataset.tweakerStoreUpdateCount = count === null ? "" : String(count);
    applyStoreUpdateBadgeStyle(badge, count);
    badge.hidden = count === null || count <= 0;
    badge.textContent = count && count > 0 ? String(count) : "";
    badge.title =
        count && count > 0
            ? `${count} installed tweak${count === 1 ? "" : "s"} can be updated`
            : "Installed tweaks are up to date";
}
function applyStoreUpdateBadgeStyle(badge, count) {
    const hasUpdates = !!count && count > 0;
    badge.classList.toggle("bg-token-charts-blue", hasUpdates);
    badge.classList.toggle("text-white", hasUpdates);
    badge.classList.toggle("bg-transparent", !hasUpdates);
    Object.assign(badge.style, {
        minWidth: "24px",
        height: "20px",
        borderRadius: "9999px",
        border: "0",
        padding: "0 7px",
        fontSize: "12px",
        fontWeight: "700",
        lineHeight: "20px",
        letterSpacing: "0",
    });
}
function currentStoreUpdateBadgeCount() {
    const badge = document.querySelector("[data-tweaker-store-update-badge]");
    const raw = badge?.dataset.tweakerStoreUpdateCount;
    const parsed = raw ? Number(raw) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
}
function outdatedInstalledStoreCount(entries) {
    return entries.filter((entry) => !!entry.installed && entry.installed.version !== entry.manifest.version).length;
}
function storeToolbarButton(label, onClick, variant = "secondary") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        variant === "primary"
            ? "border-token-border user-select-none no-drag cursor-interaction flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-token-border bg-token-bg-fog px-2 py-0 text-sm text-token-button-tertiary-foreground enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40"
            : "border-token-border user-select-none no-drag cursor-interaction flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-transparent bg-token-foreground/5 px-2 py-0 text-sm text-token-foreground enabled:hover:bg-token-foreground/10 disabled:cursor-not-allowed disabled:opacity-40";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return btn;
}
function storeIconButton(iconSvg, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        "border-token-border user-select-none no-drag cursor-interaction flex h-8 w-8 items-center justify-center rounded-lg border border-transparent bg-token-foreground/5 p-0 text-token-foreground enabled:hover:bg-token-foreground/10 disabled:cursor-not-allowed disabled:opacity-40";
    btn.innerHTML = iconSvg;
    constrainSidebarIconSvg(btn.querySelector("svg"), 18);
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return btn;
}
function refreshIconSvg() {
    return (`<svg width="18" height="18" viewBox="0 0 20 20" fill="none" class="icon-xs" aria-hidden="true">` +
        `<path d="M4.4 9.35A5.65 5.65 0 0 1 14 5.3L15.75 7M15.75 3.75V7h-3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="M15.6 10.65A5.65 5.65 0 0 1 6 14.7L4.25 13M4.25 16.25V13H7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>` +
        `</svg>`);
}
function verifiedSafeBadge() {
    const badge = document.createElement("span");
    badge.className =
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-token-border/30 bg-transparent px-2 text-xs font-medium text-token-description-foreground";
    badge.innerHTML =
        `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" class="text-blue-500" aria-hidden="true">` +
            `<path d="M7 1.75 11.25 3.4v3.2c0 2.6-1.65 4.25-4.25 5.4-2.6-1.15-4.25-2.8-4.25-5.4V3.4L7 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/>` +
            `<path d="M4.85 7.05 6.3 8.45l2.85-3.05" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>` +
            `</svg>` +
            `<span>Verified as safe</span>`;
    return badge;
}
function tweakStoreVersionBadge(entry, installedOverride) {
    const installed = installedOverride ?? entry.installed?.version ?? null;
    const latest = entry.manifest.version;
    const hasUpdate = !!installed && installed !== latest;
    const badge = storeVersionBadgeShell(hasUpdate);
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = installed
        ? `Installed v${installed} · Latest v${latest}`
        : `Latest v${latest}`;
    badge.title = installed
        ? `Installed version ${installed}. Latest approved version ${latest}.`
        : `Latest approved version ${latest}.`;
    badge.appendChild(label);
    return badge;
}
function storeVersionBadgeShell(hasUpdate) {
    const badge = document.createElement("span");
    badge.className = [
        "inline-flex h-8 min-w-0 max-w-full items-center rounded-lg border px-2.5 text-xs font-medium",
        hasUpdate
            ? "border-blue-500/30 bg-blue-500/10 text-token-foreground"
            : "border-token-border/40 bg-token-foreground/5 text-token-description-foreground",
    ].join(" ");
    return badge;
}
function storeStatusPill(label, tone = "neutral") {
    const pill = document.createElement("span");
    pill.className = [
        "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm font-medium",
        tone === "info"
            ? "border border-blue-500/30 bg-blue-500/10 text-token-foreground"
            : "bg-token-foreground/5 text-token-description-foreground",
    ].join(" ");
    pill.textContent = label;
    return pill;
}
function storeInstallButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        storeInstallButtonClass();
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(btn);
    });
    return btn;
}
function storeInstallButtonClass(extra = "") {
    return [
        "border-token-border user-select-none no-drag cursor-interaction flex h-8 min-w-[82px] items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-blue-500/40 bg-blue-500 px-3 py-0 text-sm font-medium text-token-foreground shadow-sm transition-colors enabled:hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-80",
        extra,
    ].filter(Boolean).join(" ");
}
function showStoreButtonLoading(button, label) {
    button.className = storeInstallButtonClass();
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.innerHTML =
        `<svg class="animate-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
            `<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="2" opacity=".25"/>` +
            `<path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` +
            `</svg>` +
            `<span>${label}</span>`;
}
function showStoreButtonInstalled(button) {
    button.className = storeInstallButtonClass("border-blue-500 bg-blue-500");
    button.disabled = true;
    button.removeAttribute("aria-busy");
    button.innerHTML =
        `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
            `<path d="M3.75 8.15 6.65 11 12.25 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` +
            `</svg>` +
            `<span>Installed</span>`;
}
function resetStoreInstallButton(button, label) {
    button.className = storeInstallButtonClass();
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
}
function showStoreToast(message) {
    let host = document.querySelector("[data-tweaker-store-toast-host]");
    if (!host) {
        host = document.createElement("div");
        host.dataset.tweakerStoreToastHost = "true";
        host.className = "pointer-events-none fixed bottom-5 right-5 z-[9999] flex flex-col items-end gap-2";
        document.body.appendChild(host);
    }
    const toast = document.createElement("div");
    toast.className =
        "translate-y-2 rounded-xl border border-token-border/50 bg-token-main-surface-primary px-3 py-2 text-sm font-medium text-token-foreground opacity-0 shadow-lg transition-all duration-200";
    toast.textContent = message;
    host.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.remove("translate-y-2", "opacity-0");
    });
    setTimeout(() => {
        toast.classList.add("translate-y-2", "opacity-0");
        setTimeout(() => {
            toast.remove();
            if (host && host.childElementCount === 0)
                host.remove();
        }, 220);
    }, 2600);
}
function storeMessageCard(title, description) {
    const card = document.createElement("div");
    card.className =
        "border-token-border/40 flex min-h-[84px] flex-col justify-center gap-1 rounded-2xl border p-4 text-sm";
    const t = document.createElement("div");
    t.className = "font-medium text-token-text-primary";
    t.textContent = title;
    card.appendChild(t);
    if (description) {
        const d = document.createElement("div");
        d.className = "text-token-text-secondary";
        d.textContent = description;
        card.appendChild(d);
    }
    return card;
}
function shortSha(value) {
    return value.slice(0, 7);
}
function renderTweaksPage(sectionsWrap) {
    const sectionsByTweak = new Map();
    for (const section of state.sections.values()) {
        const tweakId = section.id.split(":")[0];
        if (!sectionsByTweak.has(tweakId))
            sectionsByTweak.set(tweakId, []);
        sectionsByTweak.get(tweakId).push(section);
    }
    const pagesByTweak = new Map();
    for (const page of state.pages.values()) {
        if (!pagesByTweak.has(page.tweakId))
            pagesByTweak.set(page.tweakId, []);
        pagesByTweak.get(page.tweakId).push(page);
    }
    const wrap = document.createElement("section");
    wrap.className = "flex flex-col gap-3";
    sectionsWrap.appendChild(wrap);
    const toolbar = document.createElement("div");
    toolbar.className = "flex flex-wrap items-center justify-between gap-3";
    wrap.appendChild(toolbar);
    const tabs = document.createElement("div");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Filter tweaks");
    tabs.className = "flex min-w-0 items-center gap-1";
    toolbar.appendChild(tabs);
    const toolbarActions = document.createElement("div");
    toolbarActions.className = "flex min-w-0 flex-1 items-center justify-end gap-2";
    toolbar.appendChild(toolbarActions);
    const search = document.createElement("div");
    search.className =
        "flex h-token-button-composer w-56 min-w-0 items-center gap-2 rounded-lg border border-token-input-border bg-token-input-background/75 px-2.5 text-base shadow-sm";
    search.innerHTML =
        `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-sm shrink-0 text-token-text-secondary" aria-hidden="true">` +
            `<circle cx="9" cy="9" r="5" stroke="currentColor" stroke-width="1.5"/>` +
            `<path d="m13 13 3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
            `</svg>`;
    const searchLabel = document.createElement("label");
    searchLabel.className = "sr-only";
    searchLabel.htmlFor = "tweaker-tweaks-search";
    searchLabel.textContent = "Search tweaks";
    const searchInput = document.createElement("input");
    searchInput.id = "tweaker-tweaks-search";
    searchInput.type = "search";
    searchInput.placeholder = "Search tweaks";
    searchInput.value = state.tweaksPageQuery;
    searchInput.className =
        "min-w-0 flex-1 bg-transparent text-base text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground";
    const clearSearch = document.createElement("button");
    clearSearch.type = "button";
    clearSearch.setAttribute("aria-label", "Clear search");
    clearSearch.className = "flex shrink-0 cursor-interaction text-token-text-secondary hover:text-token-foreground";
    clearSearch.innerHTML =
        `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-sm" aria-hidden="true">` +
            `<path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
            `</svg>`;
    clearSearch.hidden = state.tweaksPageQuery.length === 0;
    search.append(searchLabel, searchInput, clearSearch);
    toolbarActions.appendChild(search);
    const globalMenu = actionMenuButton("More tweak actions", [
        {
            label: "Force Reload",
            onSelect: () => {
                void electron_1.ipcRenderer
                    .invoke("tweaker:reload-tweaks")
                    .catch((e) => plog("force reload (main) failed", String(e)))
                    .finally(() => location.reload());
            },
        },
        {
            label: "Open Tweaks Folder",
            onSelect: () => {
                void electron_1.ipcRenderer.invoke("tweaker:reveal", tweaksPath());
            },
        },
    ]);
    toolbarActions.appendChild(globalMenu.element);
    const list = document.createElement("div");
    list.id = "tweaker-tweaks-list";
    list.setAttribute("role", "tabpanel");
    list.className = "flex flex-col gap-2";
    wrap.appendChild(list);
    let rowCleanups = [];
    const renderList = () => {
        for (const cleanup of rowCleanups)
            cleanup();
        rowCleanups = [];
        const counts = (0, tweaks_page_model_1.tweaksPageCounts)(state.listedTweaks);
        tabs.replaceChildren();
        for (const filter of tweaks_page_model_1.TWEAKS_PAGE_FILTERS) {
            const selected = state.tweaksPageFilter === filter;
            const button = document.createElement("button");
            button.type = "button";
            button.id = `tweaker-tweaks-filter-${filter}`;
            button.setAttribute("role", "tab");
            button.setAttribute("aria-controls", list.id);
            button.setAttribute("aria-selected", String(selected));
            button.className = [
                "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm cursor-interaction",
                selected
                    ? "bg-token-list-hover-background font-medium text-token-foreground"
                    : "text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground",
            ].join(" ");
            const label = document.createElement("span");
            label.textContent = tweaksPageFilterLabel(filter);
            const count = document.createElement("span");
            count.className = "text-token-input-placeholder-foreground tabular-nums";
            count.textContent = String(counts[filter]);
            button.append(label, count);
            button.addEventListener("click", () => {
                state.tweaksPageFilter = filter;
                renderList();
            });
            tabs.appendChild(button);
        }
        list.setAttribute("aria-labelledby", `tweaker-tweaks-filter-${state.tweaksPageFilter}`);
        const visible = (0, tweaks_page_model_1.filterTweaksPageItems)(state.listedTweaks, state.tweaksPageFilter, state.tweaksPageQuery);
        list.replaceChildren();
        if (visible.length === 0) {
            const empty = document.createElement("div");
            empty.className = "flex min-h-28 items-center justify-center py-8 text-center text-sm text-token-text-secondary";
            empty.textContent = state.listedTweaks.length === 0
                ? `No catalog entries available. Drop a tweak folder into ${tweaksPath()} and reload.`
                : "No tweaks match this search and filter.";
            list.appendChild(empty);
            return;
        }
        for (const tweak of visible) {
            list.appendChild(tweakRow(tweak, sectionsByTweak.get(tweak.manifest.id) ?? [], pagesByTweak.get(tweak.manifest.id) ?? [], (cleanup) => rowCleanups.push(cleanup)));
        }
    };
    searchInput.addEventListener("input", () => {
        state.tweaksPageQuery = searchInput.value;
        clearSearch.hidden = searchInput.value.length === 0;
        renderList();
    });
    clearSearch.addEventListener("click", () => {
        state.tweaksPageQuery = "";
        searchInput.value = "";
        clearSearch.hidden = true;
        renderList();
        searchInput.focus();
    });
    renderList();
    return () => {
        globalMenu.dispose();
        for (const cleanup of rowCleanups)
            cleanup();
        rowCleanups = [];
    };
}
function tweaksPageFilterLabel(filter) {
    if (filter === "all")
        return "All";
    if (filter === "enabled")
        return "Enabled";
    if (filter === "disabled")
        return "Disabled";
    return "Updates";
}
function tweakRow(tweak, sections, pages, registerCleanup) {
    const manifest = tweak.manifest;
    const cell = document.createElement("div");
    cell.className = [
        "group flex flex-col overflow-visible rounded-lg border border-token-border/40 bg-token-foreground/5 transition-colors hover:bg-token-list-hover-background",
        !tweak.installed || tweak.status === "disabled" ? "opacity-60" : "",
    ].filter(Boolean).join(" ");
    const header = document.createElement("div");
    header.className = "flex min-h-[64px] items-center gap-3 p-2.5";
    cell.appendChild(header);
    const canConfigure = tweak.installed && tweak.enabled && pages.length > 0;
    const content = document.createElement(canConfigure ? "button" : "div");
    content.className = [
        "flex min-w-0 flex-1 items-center gap-3 text-left",
        canConfigure
            ? "cursor-interaction rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border"
            : "",
    ].filter(Boolean).join(" ");
    if (content instanceof HTMLButtonElement) {
        content.type = "button";
        content.title = pages.length === 1
            ? `Open ${pages[0].page.title}`
            : `Open ${pages.map((page) => page.page.title).join(", ")}`;
        content.addEventListener("click", () => {
            activatePage({ kind: "registered", id: manifest.id });
        });
    }
    content.appendChild(tweakAvatar(tweak));
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-1 flex-col gap-0.5";
    const titleRow = document.createElement("div");
    titleRow.className = "flex min-w-0 items-center gap-2";
    const name = document.createElement("div");
    name.className = "min-w-0 truncate text-sm font-medium text-token-text-primary";
    name.textContent = manifest.name;
    titleRow.appendChild(name);
    const version = document.createElement("span");
    version.className = "shrink-0 text-xs font-normal tabular-nums text-token-text-secondary";
    version.textContent = `v${manifest.version}`;
    titleRow.appendChild(version);
    titleRow.appendChild(tweakStatusPill(tweak));
    if (tweak.update?.updateAvailable) {
        const update = document.createElement("span");
        update.className =
            "shrink-0 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-token-text-primary";
        update.textContent = "Update Available";
        titleRow.appendChild(update);
    }
    stack.appendChild(titleRow);
    if (manifest.description) {
        const description = document.createElement("div");
        description.className = "line-clamp-1 min-w-0 text-sm text-token-text-secondary";
        description.textContent = manifest.description;
        stack.appendChild(description);
    }
    content.appendChild(stack);
    header.appendChild(content);
    const actions = document.createElement("div");
    actions.className = "flex shrink-0 items-center gap-2";
    const author = tweakAuthorName(manifest.author);
    if (author) {
        const authorLabel = document.createElement("div");
        authorLabel.className = "hidden w-28 truncate text-right text-sm text-token-text-secondary md:block";
        authorLabel.textContent = author;
        authorLabel.title = author;
        actions.appendChild(authorLabel);
    }
    const rowMenuItems = [];
    if (canConfigure) {
        rowMenuItems.push({
            label: "Configure",
            onSelect: () => activatePage({ kind: "registered", id: manifest.id }),
        });
    }
    if (tweak.update?.updateAvailable && tweak.update.releaseUrl) {
        rowMenuItems.push({
            label: "Review Release",
            onSelect: () => {
                void electron_1.ipcRenderer.invoke("tweaker:open-external", tweak.update.releaseUrl);
            },
        });
    }
    rowMenuItems.push({
        label: "Open Repository",
        onSelect: () => {
            void electron_1.ipcRenderer.invoke("tweaker:open-external", `https://github.com/${manifest.githubRepo}`);
        },
    });
    if (manifest.homepage && manifest.homepage !== `https://github.com/${manifest.githubRepo}`) {
        rowMenuItems.push({
            label: "Open Homepage",
            onSelect: () => {
                void electron_1.ipcRenderer.invoke("tweaker:open-external", manifest.homepage);
            },
        });
    }
    const rowMenu = actionMenuButton(`More actions for ${manifest.name}`, rowMenuItems);
    rowMenu.element.classList.add("invisible", "opacity-0", "group-focus-within:visible", "group-focus-within:opacity-100", "group-hover:visible", "group-hover:opacity-100");
    registerCleanup(rowMenu.dispose);
    actions.appendChild(rowMenu.element);
    if (!tweak.installed) {
        if (tweak.catalog?.available === false) {
            actions.appendChild(storeStatusPill("Not installed"));
        }
        else {
            actions.appendChild(compactButton("Install", () => {
                void electron_1.ipcRenderer.invoke("tweaker:install-store-tweak", manifest.id)
                    .then(() => location.reload())
                    .catch((e) => plog("catalog install failed", String(e)));
            }));
        }
    }
    else if (tweak.status === "quarantined") {
        actions.appendChild(compactButton("Recover", () => {
            void electron_1.ipcRenderer.invoke("tweaker:recover-tweak", manifest.id)
                .catch((e) => plog("tweak recovery failed", String(e)));
        }));
    }
    else {
        if (tweak.status === "failed") {
            actions.appendChild(compactButton("Retry", () => {
                void electron_1.ipcRenderer.invoke("tweaker:clear-tweak-health", manifest.id)
                    .catch((e) => plog("clear tweak health failed", String(e)));
                void electron_1.ipcRenderer.invoke("tweaker:reload-tweaks")
                    .catch((e) => plog("tweak retry failed", String(e)));
            }));
        }
        const toggle = switchControl(tweak.enabled, async (next) => {
            await electron_1.ipcRenderer.invoke("tweaker:set-tweak-enabled", manifest.id, next);
        });
        toggle.setAttribute("aria-label", `${tweak.enabled ? "Disable" : "Enable"} ${manifest.name}`);
        actions.appendChild(toggle);
    }
    header.appendChild(actions);
    // Preserve the legacy SettingsSection contract: registered sections still
    // render directly beneath their owning tweak row.
    if (tweak.installed && tweak.enabled && sections.length > 0) {
        const nested = document.createElement("div");
        nested.className =
            "flex flex-col divide-y-[0.5px] divide-token-border border-t-[0.5px] border-token-border";
        for (const section of sections) {
            const body = document.createElement("div");
            body.className = "p-3";
            try {
                section.render(body);
            }
            catch (e) {
                body.className = "p-3 text-sm text-token-charts-red";
                body.textContent = `Error rendering tweak section: ${e.message}`;
            }
            nested.appendChild(body);
        }
        cell.appendChild(nested);
    }
    return cell;
}
function tweakAvatar(tweak) {
    const avatar = document.createElement("span");
    avatar.className =
        "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-text-secondary";
    const initial = document.createElement("span");
    initial.className = "text-base font-medium";
    initial.textContent = (tweak.manifest.name?.[0] ?? "?").toUpperCase();
    avatar.appendChild(initial);
    if (!tweak.manifest.iconUrl)
        return avatar;
    const image = document.createElement("img");
    image.alt = "";
    image.className = "h-full w-full object-contain";
    image.hidden = true;
    image.addEventListener("load", () => {
        initial.remove();
        image.hidden = false;
    });
    image.addEventListener("error", () => image.remove());
    void resolveIconUrl(tweak.manifest.iconUrl, tweak.dir).then((url) => {
        if (url)
            image.src = url;
        else
            image.remove();
    });
    avatar.appendChild(image);
    return avatar;
}
function tweakAuthorName(author) {
    if (!author)
        return null;
    return typeof author === "string" ? author : author.name;
}
function actionMenuButton(label, items) {
    const details = document.createElement("details");
    details.className = "relative shrink-0";
    const summary = document.createElement("summary");
    summary.setAttribute("aria-label", label);
    summary.setAttribute("aria-haspopup", "menu");
    summary.className =
        "flex h-8 w-8 list-none cursor-interaction items-center justify-center rounded-lg text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
    summary.style.listStyle = "none";
    summary.innerHTML =
        `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" class="icon-sm" aria-hidden="true">` +
            `<circle cx="4" cy="10" r="1.25"/><circle cx="10" cy="10" r="1.25"/><circle cx="16" cy="10" r="1.25"/>` +
            `</svg>`;
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.className =
        "absolute right-0 top-full z-50 mt-1 flex min-w-44 flex-col rounded-lg border border-token-border bg-token-main-surface-primary p-1 shadow-lg";
    for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.className =
            "flex h-8 w-full items-center rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-list-hover-background focus-visible:outline-none focus-visible:bg-token-list-hover-background";
        button.textContent = item.label;
        button.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            details.open = false;
            item.onSelect();
        });
        menu.appendChild(button);
    }
    details.append(summary, menu);
    let listening = false;
    const detach = () => {
        if (!listening)
            return;
        listening = false;
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeydown, true);
    };
    const close = () => {
        details.open = false;
        detach();
    };
    const onPointerDown = (event) => {
        if (!details.isConnected || !(event.target instanceof Node) || !details.contains(event.target))
            close();
    };
    const onKeydown = (event) => {
        if (event.key !== "Escape")
            return;
        event.preventDefault();
        close();
        summary.focus();
    };
    details.addEventListener("toggle", () => {
        if (!details.open) {
            detach();
            return;
        }
        if (!listening) {
            listening = true;
            document.addEventListener("pointerdown", onPointerDown, true);
            document.addEventListener("keydown", onKeydown, true);
        }
        window.requestAnimationFrame(() => menu.querySelector("button")?.focus());
    });
    return { element: details, dispose: close };
}
function tweakStatusPill(tweak) {
    const labels = {
        installed: "Installed",
        "not-installed": "Not installed",
        enabled: "Enabled",
        disabled: "Disabled",
        failed: "Failed",
        quarantined: "Quarantined",
    };
    const tone = tweak.status === "failed" || tweak.status === "quarantined" ? "error" :
        tweak.status === "enabled" ? "info" : "neutral";
    const badge = document.createElement("span");
    badge.className = [
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tone === "error"
            ? "border-token-charts-red/30 bg-token-charts-red/10 text-token-charts-red"
            : tone === "info"
                ? "border-blue-500/30 bg-blue-500/10 text-token-text-primary"
                : "border-token-border bg-token-foreground/5 text-token-text-secondary",
    ].join(" ");
    badge.textContent = labels[tweak.status];
    if (tweak.health?.error)
        badge.title = tweak.health.error;
    return badge;
}
function openPublishTweakDialog() {
    const existing = document.querySelector("[data-tweaker-publish-dialog]");
    existing?.remove();
    const overlay = document.createElement("div");
    overlay.dataset.tweakerPublishDialog = "true";
    overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4";
    const dialog = document.createElement("div");
    dialog.className =
        "flex w-full max-w-xl flex-col gap-4 rounded-lg border border-token-border bg-token-main-surface-primary p-4 shadow-xl";
    overlay.appendChild(dialog);
    const header = document.createElement("div");
    header.className = "flex items-start justify-between gap-3";
    const titleStack = document.createElement("div");
    titleStack.className = "flex min-w-0 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "text-base font-medium text-token-text-primary";
    title.textContent = "Publish Tweak";
    const subtitle = document.createElement("div");
    subtitle.className = "text-sm text-token-text-secondary";
    subtitle.textContent = "Submit a GitHub repo for admin review. Tweakers records the exact commit admins must review and pin.";
    titleStack.appendChild(title);
    titleStack.appendChild(subtitle);
    header.appendChild(titleStack);
    header.appendChild(compactButton("Dismiss", () => overlay.remove()));
    dialog.appendChild(header);
    const repoInput = document.createElement("input");
    repoInput.type = "text";
    repoInput.placeholder = "owner/repo or https://github.com/owner/repo";
    repoInput.className =
        "h-10 rounded-lg border border-token-border bg-transparent px-3 text-sm text-token-text-primary focus:outline-none";
    dialog.appendChild(repoInput);
    const status = document.createElement("div");
    status.className = "min-h-5 text-sm text-token-text-secondary";
    status.textContent = "The manifest should include an iconUrl suitable for the store.";
    dialog.appendChild(status);
    const actions = document.createElement("div");
    actions.className = "flex items-center justify-end gap-2";
    const submit = compactButton("Open Review Issue", () => {
        void submitPublishTweak(repoInput, status);
    });
    actions.appendChild(submit);
    dialog.appendChild(actions);
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay)
            overlay.remove();
    });
    document.body.appendChild(overlay);
    repoInput.focus();
}
async function submitPublishTweak(repoInput, status) {
    status.className = "min-h-5 text-sm text-token-text-secondary";
    status.textContent = "Resolving the repo commit to review.";
    try {
        const submission = await electron_1.ipcRenderer.invoke("tweaker:prepare-tweak-store-submission", repoInput.value);
        const url = (0, tweak_store_1.buildTweakPublishIssueUrl)(submission);
        await electron_1.ipcRenderer.invoke("tweaker:open-external", url);
        status.textContent = `GitHub review issue opened for ${submission.commitSha.slice(0, 7)}.`;
    }
    catch (e) {
        status.className = "min-h-5 text-sm text-token-charts-red";
        status.textContent = String(e.message ?? e);
    }
}
// ───────────────────────────────────────────────────────────── components ──
/** The full panel shell (toolbar + scroll + heading + sections wrap). */
function panelShell(title, subtitle, options) {
    const outer = document.createElement("div");
    outer.className = "main-surface flex h-full min-h-0 flex-col";
    const toolbar = document.createElement("div");
    toolbar.className =
        "draggable flex items-center px-panel electron:h-toolbar extension:h-toolbar-sm";
    outer.appendChild(toolbar);
    const scroll = document.createElement("div");
    scroll.className = "flex-1 overflow-y-auto p-panel";
    outer.appendChild(scroll);
    const inner = document.createElement("div");
    const width = options?.width ?? (options?.wide ? "wide" : "default");
    inner.className = [
        "mx-auto flex w-full flex-col electron:min-w-[calc(320px*var(--codex-window-zoom))]",
        width === "wide" ? "max-w-5xl" : width === "plugins" ? "max-w-3xl" : "max-w-2xl",
    ].join(" ");
    scroll.appendChild(inner);
    const headerWrap = document.createElement("div");
    headerWrap.className = "flex items-center justify-between gap-3 pb-panel";
    const headerInner = document.createElement("div");
    headerInner.className = "flex min-w-0 flex-1 flex-col gap-1.5 pb-panel";
    const titleLine = document.createElement("div");
    titleLine.className = "flex min-w-0 items-center gap-2";
    const heading = document.createElement("div");
    heading.className = "electron:heading-lg heading-base truncate";
    heading.textContent = title;
    titleLine.appendChild(heading);
    const headerTitleActions = document.createElement("div");
    headerTitleActions.className = "flex shrink-0 items-center gap-2";
    titleLine.appendChild(headerTitleActions);
    headerInner.appendChild(titleLine);
    let subtitleElement;
    if (subtitle) {
        const sub = document.createElement("div");
        sub.className = "text-token-text-secondary text-sm";
        sub.textContent = subtitle;
        headerInner.appendChild(sub);
        subtitleElement = sub;
    }
    headerWrap.appendChild(headerInner);
    const headerActions = document.createElement("div");
    headerActions.className = "flex shrink-0 items-center gap-2";
    headerWrap.appendChild(headerActions);
    inner.appendChild(headerWrap);
    const sectionsWrap = document.createElement("div");
    sectionsWrap.className = "flex flex-col gap-[var(--padding-panel)]";
    inner.appendChild(sectionsWrap);
    return { outer, sectionsWrap, subtitle: subtitleElement, headerActions, headerTitleActions };
}
function sectionTitle(text, trailing) {
    const titleRow = document.createElement("div");
    titleRow.className =
        "flex h-toolbar items-center justify-between gap-2 px-0 py-0";
    const titleInner = document.createElement("div");
    titleInner.className = "flex min-w-0 flex-1 flex-col gap-1";
    const t = document.createElement("div");
    t.className = "text-base font-medium text-token-text-primary";
    t.textContent = text;
    titleInner.appendChild(t);
    titleRow.appendChild(titleInner);
    if (trailing) {
        const right = document.createElement("div");
        right.className = "flex items-center gap-2";
        right.appendChild(trailing);
        titleRow.appendChild(right);
    }
    return titleRow;
}
/**
 * Codex's "Open config.toml"-style trailing button: ghost border, muted
 * label, top-right diagonal arrow icon. Markup mirrors Configuration panel.
 */
function openInPlaceButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-description-foreground enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px]";
    btn.innerHTML =
        `${label}` +
            `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-2xs" aria-hidden="true">` +
            `<path d="M14.3349 13.3301V6.60645L5.47065 15.4707C5.21095 15.7304 4.78895 15.7304 4.52925 15.4707C4.26955 15.211 4.26955 14.789 4.52925 14.5293L13.3935 5.66504H6.66011C6.29284 5.66504 5.99507 5.36727 5.99507 5C5.99507 4.63273 6.29284 4.33496 6.66011 4.33496H14.9999L15.1337 4.34863C15.4369 4.41057 15.665 4.67857 15.665 5V13.3301C15.6649 13.6973 15.3672 13.9951 14.9999 13.9951C14.6327 13.9951 14.335 13.6973 14.3349 13.3301Z" fill="currentColor"></path>` +
            `</svg>`;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return btn;
}
function compactButton(label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
        "border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg border px-2 text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
    });
    return btn;
}
function roundedCard() {
    const card = document.createElement("div");
    card.className =
        "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
    card.setAttribute("style", "background-color: var(--color-background-panel, var(--color-token-bg-fog));");
    return card;
}
function rowSimple(title, description) {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between gap-4 p-3";
    const left = document.createElement("div");
    left.className = "flex min-w-0 items-center gap-3";
    const stack = document.createElement("div");
    stack.className = "flex min-w-0 flex-col gap-1";
    if (title) {
        const t = document.createElement("div");
        t.className = "min-w-0 text-sm text-token-text-primary";
        t.textContent = title;
        stack.appendChild(t);
    }
    if (description) {
        const d = document.createElement("div");
        d.className = "text-token-text-secondary min-w-0 text-sm";
        d.textContent = description;
        stack.appendChild(d);
    }
    left.appendChild(stack);
    row.appendChild(left);
    return row;
}
/**
 * Codex-styled toggle switch. Markup mirrors the General > Permissions row
 * switch we captured: outer button (role=switch), inner pill, sliding knob.
 */
function switchControl(initial, onChange) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "switch");
    const pill = document.createElement("span");
    const knob = document.createElement("span");
    knob.className =
        "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform duration-200 ease-out h-4 w-4";
    pill.appendChild(knob);
    const apply = (on) => {
        btn.setAttribute("aria-checked", String(on));
        btn.dataset.state = on ? "checked" : "unchecked";
        btn.className =
            "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
        pill.className = `relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 ease-out h-5 w-8 ${on ? "bg-token-charts-blue" : "bg-token-foreground/20"}`;
        pill.dataset.state = on ? "checked" : "unchecked";
        knob.dataset.state = on ? "checked" : "unchecked";
        knob.style.transform = on ? "translateX(14px)" : "translateX(2px)";
    };
    apply(initial);
    btn.appendChild(pill);
    btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = btn.getAttribute("aria-checked") !== "true";
        apply(next);
        btn.disabled = true;
        try {
            await onChange(next);
        }
        finally {
            btn.disabled = false;
        }
    });
    return btn;
}
// ──────────────────────────────────────────────────────────────── icons ──
function configIconSvg() {
    // Sliders / settings glyph. 20x20 currentColor.
    return (`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">` +
        `<path d="M3 5h9M15 5h2M3 10h2M8 10h9M3 15h11M17 15h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
        `<circle cx="13" cy="5" r="1.6" fill="currentColor"/>` +
        `<circle cx="6" cy="10" r="1.6" fill="currentColor"/>` +
        `<circle cx="15" cy="15" r="1.6" fill="currentColor"/>` +
        `</svg>`);
}
function tweaksIconSvg() {
    // Sparkles / "++" glyph for tweaks.
    return (`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">` +
        `<path d="M10 2.5 L11.4 8.6 L17.5 10 L11.4 11.4 L10 17.5 L8.6 11.4 L2.5 10 L8.6 8.6 Z" fill="currentColor"/>` +
        `<path d="M15.5 3 L16 5 L18 5.5 L16 6 L15.5 8 L15 6 L13 5.5 L15 5 Z" fill="currentColor" opacity="0.7"/>` +
        `</svg>`);
}
function storeIconSvg() {
    return (`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">` +
        `<path d="M4 8.2 5.1 4.5A1.5 1.5 0 0 1 6.55 3.4h6.9a1.5 1.5 0 0 1 1.45 1.1L16 8.2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M4.5 8h11v7.5A1.5 1.5 0 0 1 14 17H6a1.5 1.5 0 0 1-1.5-1.5V8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M7.5 8v1a2.5 2.5 0 0 0 5 0V8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
        `</svg>`);
}
function defaultPageIconSvg() {
    // Document/page glyph for tweak-registered pages without their own icon.
    return (`<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true">` +
        `<path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M12 3v3a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>` +
        `<path d="M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
        `</svg>`);
}
async function resolveIconUrl(url, tweakDir) {
    if (/^(https?:|data:)/.test(url))
        return url;
    // Relative path → ask main to read the file and return a data: URL.
    // Renderer is sandboxed so file:// won't load directly.
    const rel = url.startsWith("./") ? url.slice(2) : url;
    try {
        return (await electron_1.ipcRenderer.invoke("tweaker:read-tweak-asset", tweakDir, rel));
    }
    catch (e) {
        plog("icon load failed", { url, tweakDir, err: String(e) });
        return null;
    }
}
// ─────────────────────────────────────────────────────── DOM heuristics ──
function findSidebarItemsGroup() {
    const candidates = Array.from(document.querySelectorAll("aside,nav,[role='navigation'],div"));
    let best = null;
    let bestScore = -1;
    let bestArea = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
        if (candidate.dataset.tweaker)
            continue;
        if (!isSettingsSidebarCandidate(candidate))
            continue;
        const labels = tweakerSettingsLabelsFrom(candidate);
        const score = tweakerSettingsLabelScore(labels);
        const rect = candidate.getBoundingClientRect();
        const area = rect.width * rect.height;
        const weighted = score.core * 100 + score.total;
        if (weighted > bestScore || (weighted === bestScore && area < bestArea)) {
            best = candidate;
            bestScore = weighted;
            bestArea = area;
        }
    }
    return best;
}
const FORBIDDEN_SETTINGS_SIDEBAR_SELECTOR = [
    "[data-composer-overlay-floating-ui='true']",
    "[data-tweaker-slash-menu='true']",
    "[data-tweaker-overlay-noise='true']",
    ".composer-home-top-menu",
    ".vertical-scroll-fade-mask",
    "[class*='[container-name:home-main-content]']",
].join(",");
function isForbiddenSettingsSidebarSurface(node) {
    if (!node)
        return false;
    const el = node instanceof HTMLElement ? node : node.parentElement;
    if (!el)
        return false;
    if (el.closest(FORBIDDEN_SETTINGS_SIDEBAR_SELECTOR))
        return true;
    if (el.querySelector("[data-list-navigation-item='true'], [cmdk-item]"))
        return true;
    return false;
}
function isSettingsSidebarCandidate(el) {
    const rect = tweakerVisibleBox(el);
    if (!rect)
        return false;
    const labels = tweakerSettingsLabelsFrom(el);
    const score = tweakerSettingsLabelScore(labels);
    return (0, settings_page_model_1.isNativeSettingsSidebarEvidence)({
        width: rect.width,
        height: rect.height,
        left: rect.left,
        viewportWidth: window.innerWidth,
        forbiddenSurface: isForbiddenSettingsSidebarSurface(el),
        nativePanelSlugCount: nativeSettingsPanelSlugCount(el),
        coreLabelCount: score.core,
        totalLabelCount: score.total,
        mainAppLabelCount: tweakerMarkerCount(labels, TWEAKER_MAIN_APP_NAV_LABELS),
        settingsOnlyLabelCount: tweakerMarkerCount(labels, TWEAKER_SETTINGS_ONLY_LABELS),
    });
}
function removeMisplacedSettingsGroups() {
    const groups = document.querySelectorAll("[data-tweaker='nav-group'], [data-tweaker='pages-group'], [data-tweaker='native-nav-header']");
    for (const group of Array.from(groups)) {
        if (isTweakerInjectedSettingsGroupPlacementValid(group))
            continue;
        resetTweakerInjectedSettingsGroupState(group);
        group.remove();
    }
}
function isTweakerInjectedSettingsGroupPlacementValid(group) {
    if (isForbiddenSettingsSidebarSurface(group))
        return false;
    // Keep the injection-time placement only while the connected root still
    // owns native Settings rows. This avoids layout-dependent re-judging while
    // ensuring a false-positive thread or side panel cannot retain the group.
    if (state.sidebarRoot &&
        state.sidebarRoot.isConnected &&
        (group.parentElement === state.sidebarRoot || state.sidebarRoot.contains(group))) {
        return (0, settings_page_model_1.hasNativeSettingsSidebarOwnership)({
            forbiddenSurface: isForbiddenSettingsSidebarSurface(state.sidebarRoot),
            nativePanelSlugCount: nativeSettingsPanelSlugCount(state.sidebarRoot),
        });
    }
    let node = group.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
        if (isForbiddenSettingsSidebarSurface(node))
            return false;
        if (isSettingsSidebarCandidate(node))
            return true;
        node = node.parentElement;
    }
    return false;
}
function resetTweakerInjectedSettingsGroupState(group) {
    if (state.navGroup === group || (state.navGroup && group.contains(state.navGroup))) {
        state.navGroup = null;
        state.navButtons = null;
        state.tweakerUpdateButton = null;
    }
    if (state.pagesGroup === group || (state.pagesGroup && group.contains(state.pagesGroup))) {
        state.pagesGroup = null;
        state.pagesGroupKey = null;
        state.pageNavButtons.clear();
    }
    if (state.nativeNavHeader === group || (state.nativeNavHeader && group.contains(state.nativeNavHeader))) {
        state.nativeNavHeader = null;
    }
    if (state.sidebarRoot && state.sidebarRoot.contains(group)) {
        state.sidebarRoot = null;
    }
}
function findContentArea() {
    const sidebar = findSidebarItemsGroup();
    if (!sidebar)
        return null;
    let parent = sidebar.parentElement;
    while (parent) {
        for (const child of Array.from(parent.children)) {
            if (child === sidebar || child.contains(sidebar))
                continue;
            const r = child.getBoundingClientRect();
            if (r.width > 300 && r.height > 200)
                return child;
        }
        parent = parent.parentElement;
    }
    return null;
}
function maybeDumpDom() {
    try {
        const sidebar = findSidebarItemsGroup();
        if (sidebar && !state.sidebarDumped) {
            state.sidebarDumped = true;
            const sbRoot = sidebar.parentElement ?? sidebar;
            plog(`codex sidebar HTML`, sbRoot.outerHTML.slice(0, 32000));
        }
        const content = findContentArea();
        if (!content) {
            if (state.fingerprint !== location.href) {
                state.fingerprint = location.href;
                plog("dom probe (no content)", {
                    url: location.href,
                    sidebar: sidebar ? describe(sidebar) : null,
                });
            }
            return;
        }
        let panel = null;
        for (const child of Array.from(content.children)) {
            if (child.dataset.tweaker === "tweaks-panel")
                continue;
            if (child.style.display === "none")
                continue;
            panel = child;
            break;
        }
        const activeNav = sidebar
            ? Array.from(sidebar.querySelectorAll("button, a")).find((b) => b.getAttribute("aria-current") === "page" ||
                b.getAttribute("data-active") === "true" ||
                b.getAttribute("aria-selected") === "true" ||
                b.classList.contains("active"))
            : null;
        const heading = panel?.querySelector("h1, h2, h3, [class*='heading']");
        const fingerprint = `${activeNav?.textContent ?? ""}|${heading?.textContent ?? ""}|${panel?.children.length ?? 0}`;
        if (state.fingerprint === fingerprint)
            return;
        state.fingerprint = fingerprint;
        plog("dom probe", {
            url: location.href,
            activeNav: activeNav?.textContent?.trim() ?? null,
            heading: heading?.textContent?.trim() ?? null,
            content: describe(content),
        });
        if (panel) {
            const html = panel.outerHTML;
            plog(`codex panel HTML (${activeNav?.textContent?.trim() ?? "?"})`, html.slice(0, 32000));
        }
    }
    catch (e) {
        plog("dom probe failed", String(e));
    }
}
function describe(el) {
    return {
        tag: el.tagName,
        cls: el.className.slice(0, 120),
        id: el.id || undefined,
        children: el.children.length,
        rect: (() => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
        })(),
    };
}
function tweaksPath() {
    return (window.__tweaker_tweaks_dir__ ??
        "<user dir>/tweaks");
}
//# sourceMappingURL=settings-injector.js.map