"use strict";

// src/preload/index.ts
var import_electron4 = require("electron");

// src/preload/react-hook.ts
function installReactHook() {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  const renderers = /* @__PURE__ */ new Map();
  let nextId = 1;
  const listeners2 = /* @__PURE__ */ new Map();
  const hook = {
    supportsFiber: true,
    renderers,
    inject(renderer) {
      const id = nextId++;
      renderers.set(id, renderer);
      console.debug(
        "[codex-plusplus] React renderer attached:",
        renderer.rendererPackageName,
        renderer.version
      );
      return id;
    },
    on(event, fn) {
      let s = listeners2.get(event);
      if (!s) listeners2.set(event, s = /* @__PURE__ */ new Set());
      s.add(fn);
    },
    off(event, fn) {
      listeners2.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      listeners2.get(event)?.forEach((fn) => fn(...args));
    },
    onCommitFiberRoot() {
    },
    onCommitFiberUnmount() {
    },
    onScheduleFiberRoot() {
    },
    checkDCE() {
    }
  };
  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    enumerable: false,
    writable: true,
    // allow real DevTools to overwrite if user installs it
    value: hook
  });
  window.__codexpp__ = { hook, renderers };
}
function fiberForNode(node) {
  const renderers = window.__codexpp__?.renderers;
  if (renderers) {
    for (const r of renderers.values()) {
      const f = r.findFiberByHostInstance?.(node);
      if (f) return f;
    }
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith("__reactFiber")) return node[k];
  }
  return null;
}

// src/preload/settings-injector.ts
var import_electron = require("electron");

// src/tweak-store.ts
var TWEAK_STORE_REVIEW_ISSUE_URL = "https://github.com/therealityreport/tweakers/issues/new";
var BUNDLED_TWEAK_SOURCE_PATHS = Object.freeze({
  "co.tweakers.account-switcher": "tweaks/co.tweakers.account-switcher",
  "co.tweakers.appshots": "tweaks/co.tweakers.appshots",
  "co.tweakers.developer-tools": "tweaks/co.tweakers.developer-tools",
  "co.tweakers.shadcn-codex-ui": "tweaks/co.tweakers.shadcn-codex-ui",
  "co.tweakers.followup": "tweaks/followup",
  "co.tweakers.projects": "tweaks/co.tweakers.projects",
  "co.tweakers.thread-summary-profiles": "tweaks/co.tweakers.thread-summary-profiles",
  "co.tweakers.titlebar-controls": "tweaks/titlebar-controls",
  "co.tweakers.ui-improvements": "tweaks/ui-improvements",
  "co.tweakers.user-questions": "tweaks/user-questions",
  "co.tweakers.usage-limit-resets-tracker": "tweaks/usage-limit-resets-tracker"
});
var GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
var FULL_SHA_RE = /^[a-f0-9]{40}$/i;
function normalizeGitHubRepo(input) {
  const raw = input.trim();
  if (!raw) throw new Error("GitHub repo is required");
  const ssh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return normalizeRepoPart(ssh[1]);
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname !== "github.com") throw new Error("Only github.com repositories are supported");
    const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length < 2) throw new Error("GitHub repo URL must include owner and repository");
    return normalizeRepoPart(`${parts[0]}/${parts[1]}`);
  }
  return normalizeRepoPart(raw);
}
function buildTweakPublishIssueUrl(submission) {
  const repo = normalizeGitHubRepo(submission.repo);
  if (!isFullCommitSha(submission.commitSha)) {
    throw new Error("Submission must include the full commit SHA to review");
  }
  const title = `Tweak store review: ${repo}`;
  const body = [
    "## Tweak repo",
    `https://github.com/${repo}`,
    "",
    "## Commit to review",
    submission.commitSha,
    submission.commitUrl,
    "",
    "Do not approve a different commit. If the author pushes changes, ask them to resubmit.",
    "",
    "## Manifest",
    `- id: ${submission.manifest?.id ?? "(not detected)"}`,
    `- name: ${submission.manifest?.name ?? "(not detected)"}`,
    `- version: ${submission.manifest?.version ?? "(not detected)"}`,
    `- description: ${submission.manifest?.description ?? "(not detected)"}`,
    `- iconUrl: ${submission.manifest?.iconUrl ?? "(not detected)"}`,
    "",
    "## Admin checklist",
    "- [ ] manifest.json is valid",
    "- [ ] manifest.iconUrl is usable as the store icon",
    "- [ ] source was reviewed at the exact commit above",
    "- [ ] `store/index.json` entry pins `approvedCommitSha` to the exact commit above"
  ].join("\n");
  const url = new URL(TWEAK_STORE_REVIEW_ISSUE_URL);
  url.searchParams.set("template", "tweak-store-review.md");
  url.searchParams.set("title", title);
  url.searchParams.set("body", body);
  return url.toString();
}
function isFullCommitSha(value) {
  return FULL_SHA_RE.test(value);
}
function normalizeRepoPart(value) {
  const repo = value.trim().replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("GitHub repo must be in owner/repo form");
  return repo;
}

// src/preload/settings-page-model.ts
function buildSettingsNavigationModel(tweaks, registrations) {
  const registrationsByTweak = /* @__PURE__ */ new Map();
  for (const registration of registrations) {
    const group = registrationsByTweak.get(registration.tweakId) ?? [];
    group.push(registration);
    registrationsByTweak.set(registration.tweakId, group);
  }
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
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
      warning: tweak.healthError || null
    });
  }
  return rows.sort((a, b) => a.title.localeCompare(b.title) || a.tweakId.localeCompare(b.tweakId));
}
function lifecycleFor(tweak) {
  if (tweak.lifecycleOverride) return tweak.lifecycleOverride;
  if (tweak.status === "failed") return "failed";
  if (tweak.status === "quarantined") return "quarantined";
  if (tweak.status === "starting") return "starting";
  if (tweak.status === "timed_out") return "timed_out";
  return "enabled";
}

// src/preload/tweaks-page-model.ts
var TWEAKS_PAGE_FILTERS = [
  "all",
  "enabled",
  "disabled",
  "updates"
];
function tweaksPageCounts(items) {
  return {
    all: items.length,
    enabled: items.filter((item) => matchesTweaksPageFilter(item, "enabled")).length,
    disabled: items.filter((item) => matchesTweaksPageFilter(item, "disabled")).length,
    updates: items.filter((item) => matchesTweaksPageFilter(item, "updates")).length
  };
}
function filterTweaksPageItems(items, filter, query) {
  const normalizedQuery = normalizeTweaksPageSearch(query);
  return items.filter((item) => {
    if (!matchesTweaksPageFilter(item, filter)) return false;
    if (!normalizedQuery) return true;
    return tweaksPageSearchText(item).includes(normalizedQuery);
  });
}
function matchesTweaksPageFilter(item, filter) {
  if (filter === "enabled") return item.installed && item.enabled;
  if (filter === "disabled") return item.installed && !item.enabled;
  if (filter === "updates") return item.update?.updateAvailable === true;
  return true;
}
function tweaksPageSearchText(item) {
  const author = typeof item.manifest.author === "string" ? item.manifest.author : item.manifest.author?.name;
  return normalizeTweaksPageSearch([
    item.manifest.name,
    item.manifest.description,
    author,
    item.manifest.githubRepo,
    item.manifest.homepage,
    item.manifest.version,
    ...item.manifest.tags ?? [],
    item.status,
    item.enabled ? "enabled" : "disabled",
    item.update?.updateAvailable ? "update available" : ""
  ].filter(Boolean).join(" "));
}
function normalizeTweaksPageSearch(value) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019`\u00b4]/g, "'").replace(/\s+/g, " ").trim();
}

// src/app-mode.ts
function appModeLabel(mode) {
  return mode === "chatgpt" ? "ChatGPT App" : "Tweakers";
}

// src/preload/settings-injector.ts
var TWEAKERS_RELEASES_URL = "https://github.com/therealityreport/tweakers/releases";
var state = {
  sections: /* @__PURE__ */ new Map(),
  sectionTokens: /* @__PURE__ */ new Map(),
  pages: /* @__PURE__ */ new Map(),
  listedTweaks: [],
  outerWrapper: null,
  nativeNavHeader: null,
  navGroup: null,
  navButtons: null,
  codexPlusPlusUpdateButton: null,
  pagesGroup: null,
  pagesGroupKey: null,
  pageNavButtons: /* @__PURE__ */ new Map(),
  panelHost: null,
  observer: null,
  fingerprint: null,
  sidebarDumped: false,
  activePage: null,
  sidebarRoot: null,
  sidebarRestoreHandler: null,
  settingsSurfaceVisible: false,
  settingsSurfaceHideTimer: null,
  tweakStore: null,
  tweakStorePromise: null,
  tweakStoreError: null,
  tweaksPageFilter: "all",
  tweaksPageQuery: ""
};
var activeBuiltinPageCleanup = null;
function plog(msg, extra) {
  import_electron.ipcRenderer.send(
    "codexpp:preload-log",
    "info",
    `[settings-injector] ${msg}${extra === void 0 ? "" : " " + safeStringify(extra)}`
  );
}
function safeStringify(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
function startSettingsInjector() {
  if (state.observer) return;
  const obs = new MutationObserver(() => {
    tryInject();
    maybeDumpDom();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  state.observer = obs;
  window.addEventListener("popstate", onNav);
  window.addEventListener("hashchange", onNav);
  document.addEventListener("click", onDocumentClick, true);
  for (const m of ["pushState", "replaceState"]) {
    const orig = history[m];
    history[m] = function(...args) {
      const r = orig.apply(this, args);
      window.dispatchEvent(new Event(`codexpp-${m}`));
      return r;
    };
    window.addEventListener(`codexpp-${m}`, onNav);
  }
  tryInject();
  maybeDumpDom();
  let ticks = 0;
  const interval = setInterval(() => {
    ticks++;
    tryInject();
    maybeDumpDom();
    if (ticks > 60) clearInterval(interval);
  }, 500);
}
function onNav() {
  state.fingerprint = null;
  tryInject();
  maybeDumpDom();
}
function onDocumentClick(e) {
  const target = e.target instanceof Element ? e.target : null;
  const control = target?.closest("[role='link'],button,a");
  if (!(control instanceof HTMLElement)) return;
  if (compactSettingsText(control.textContent || "") !== "Back to app") return;
  setTimeout(() => {
    setSettingsSurfaceVisible(false, "back-to-app");
  }, 0);
}
function registerSection(section) {
  const registrationToken = Symbol(section.id);
  state.sections.set(section.id, section);
  state.sectionTokens.set(section.id, registrationToken);
  if (state.activePage?.kind === "tweaks") rerender();
  return {
    unregister: () => {
      if (state.sectionTokens.get(section.id) !== registrationToken) return;
      state.sections.delete(section.id);
      state.sectionTokens.delete(section.id);
      if (state.activePage?.kind === "tweaks") rerender();
    }
  };
}
function clearSections() {
  state.sections.clear();
  state.sectionTokens.clear();
  for (const p of state.pages.values()) {
    try {
      p.teardown?.();
    } catch (e) {
      plog("page teardown failed", { id: p.id, err: String(e) });
    }
  }
  state.pages.clear();
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && !settingsNavigationItem(state.activePage.id)) {
    restoreCodexView();
  } else if (state.activePage?.kind === "registered") {
    rerender();
  } else if (state.activePage?.kind === "tweaks") {
    rerender();
  }
}
function registerPage(tweakId, manifest, page) {
  const id = page.id;
  const existing = state.pages.get(id);
  if (existing) {
    try {
      existing.teardown?.();
    } catch {
    }
  }
  const registrationToken = Symbol(id);
  const entry = { id, tweakId, manifest, page, registrationToken };
  state.pages.set(id, entry);
  plog("registerPage", { id, title: page.title, tweakId });
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && state.activePage.id === tweakId) {
    rerender();
  }
  return {
    unregister: () => {
      const e = state.pages.get(id);
      if (!e || e.registrationToken !== registrationToken) return;
      try {
        e.teardown?.();
      } catch {
      }
      state.pages.delete(id);
      syncPagesGroup();
      if (state.activePage?.kind === "registered" && state.activePage.id === tweakId) rerender();
    }
  };
}
function setListedTweaks(list) {
  state.listedTweaks = list;
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && !settingsNavigationItem(state.activePage.id)) {
    restoreCodexView();
  } else if (state.activePage?.kind === "registered") {
    rerender();
  }
  if (state.activePage?.kind === "tweaks") rerender();
}
function updateListedTweakLifecycle(id, lifecycle, error) {
  const tweak = state.listedTweaks.find((item) => item.manifest.id === id);
  if (!tweak) return;
  tweak.lifecycleOverride = lifecycle;
  if (error) tweak.health = { status: lifecycle === "quarantined" ? "quarantined" : "failed", updatedAt: (/* @__PURE__ */ new Date()).toISOString(), error };
  else if (lifecycle === "starting" || lifecycle === "enabled") tweak.health = null;
  syncPagesGroup();
  if (state.activePage?.kind === "registered" && state.activePage.id === id) rerender();
}
function settingsNavigationItems() {
  return buildSettingsNavigationModel(
    state.listedTweaks.map((tweak) => ({
      id: tweak.manifest.id,
      name: tweak.manifest.name,
      version: tweak.manifest.version,
      description: tweak.manifest.description,
      iconUrl: tweak.manifest.iconUrl,
      enabled: tweak.enabled,
      status: tweak.status,
      healthError: tweak.health?.error ?? null,
      lifecycleOverride: tweak.lifecycleOverride
    })),
    [...state.pages.values()].map((entry) => ({
      id: entry.id,
      tweakId: entry.tweakId,
      title: entry.page.title,
      description: entry.page.description,
      iconSvg: entry.page.iconSvg
    }))
  );
}
function settingsNavigationItem(tweakId) {
  return settingsNavigationItems().find((item) => item.tweakId === tweakId) ?? null;
}
function registeredPagesForTweak(tweakId) {
  return [...state.pages.values()].filter((entry) => entry.tweakId === tweakId);
}
function lifecycleLabel(lifecycle, warning) {
  const label = lifecycle === "enabled" ? "Running" : lifecycle === "timed_out" ? "Startup timed out" : lifecycle[0].toUpperCase() + lifecycle.slice(1);
  return warning ? `${label}: ${warning}` : label;
}
function tryInject() {
  if (isNavGroupInjectionSuppressed()) return;
  removeMisplacedSettingsGroups();
  const itemsGroup = findSidebarItemsGroup();
  if (!itemsGroup) {
    scheduleSettingsSurfaceHidden();
    plog("sidebar not found");
    return;
  }
  if (state.settingsSurfaceHideTimer) {
    clearTimeout(state.settingsSurfaceHideTimer);
    state.settingsSurfaceHideTimer = null;
  }
  setSettingsSurfaceVisible(true, "sidebar-found");
  const outer = itemsGroup;
  if (!isSettingsSidebarCandidate(itemsGroup)) {
    scheduleSettingsSurfaceHidden();
    plog("rejected non-settings sidebar candidate", {
      itemsGroup: describe(itemsGroup),
      outer: describe(outer)
    });
    return;
  }
  state.sidebarRoot = outer;
  syncNativeSettingsHeader(itemsGroup, outer);
  bindSettingsSearch(outer);
  if (state.navGroup && outer.contains(state.navGroup)) {
    syncPagesGroup();
    if (state.activePage !== null) syncCodexNativeNavActive(true);
    return;
  }
  if (state.activePage !== null || state.panelHost !== null) {
    plog("sidebar re-mount detected; clearing stale active state", {
      prevActive: state.activePage
    });
    state.activePage = null;
    state.panelHost = null;
  }
  const existingCodexPpNavGroup = outer.querySelector(':scope > [data-codexpp="nav-group"]') ?? outer.querySelector('[data-codexpp="nav-group"]');
  if (existingCodexPpNavGroup) {
    state.navGroup = existingCodexPpNavGroup;
    state.codexPlusPlusUpdateButton = existingCodexPpNavGroup.querySelector(
      "[data-codexpp-sidebar-update]"
    );
    state.sidebarRoot = outer;
    syncPagesGroup();
    refreshSidebarCodexPlusPlusUpdateButton();
    if (state.activePage !== null) syncCodexNativeNavActive(true);
    return;
  }
  const group = document.createElement("div");
  group.dataset.codexpp = "nav-group";
  group.className = "flex flex-col gap-px";
  const updateButton = sidebarUpdatePillButton();
  state.codexPlusPlusUpdateButton = updateButton;
  group.appendChild(sidebarGroupHeader("Tweakers", "pt-3", updateButton));
  refreshSidebarCodexPlusPlusUpdateButton();
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
}
var NAV_GROUP_INJECTION_WINDOW_MS = 1e4;
var NAV_GROUP_INJECTION_LIMIT = 5;
var NAV_GROUP_INJECTION_BACKOFF_MS = 3e4;
var navGroupInjections = [];
var navGroupInjectionSuppressedUntil = 0;
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
      outerTag: outer.tagName
    });
    return;
  }
  plog("nav group injected", { outerTag: outer.tagName });
}
function syncNativeSettingsHeader(itemsGroup, outer) {
  if (state.nativeNavHeader && outer.contains(state.nativeNavHeader)) return;
  const header = sidebarGroupHeader("General");
  header.dataset.codexpp = "native-nav-header";
  if (outer === itemsGroup) outer.prepend(header);
  else outer.insertBefore(header, itemsGroup);
  state.nativeNavHeader = header;
}
function bindSettingsSearch(root) {
  const input = root.closest("aside, nav, [role='navigation'], div")?.parentElement?.querySelector("input[placeholder*='Search settings' i]") ?? document.querySelector("input[placeholder*='Search settings' i]");
  if (!input || input.dataset.tweakersSearchBound === "true") return;
  input.dataset.tweakersSearchBound = "true";
  input.addEventListener("input", () => {
    const query = input.value.trim().toLocaleLowerCase();
    for (const button2 of Array.from(root.querySelectorAll("button"))) {
      if (!button2.closest("[data-codexpp]")) continue;
      button2.hidden = !!query && !compactSettingsText(button2.textContent ?? "").toLocaleLowerCase().includes(query);
    }
    for (const group of Array.from(root.querySelectorAll("[data-codexpp='nav-group'], [data-codexpp='pages-group']"))) {
      const buttons = Array.from(group.querySelectorAll("button"));
      group.hidden = buttons.length > 0 && buttons.every((button2) => button2.hidden);
    }
  });
}
function sidebarGroupHeader(text, topPadding = "pt-2", trailing) {
  const header = document.createElement("div");
  header.className = `px-row-x ${topPadding} pb-1 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wider text-token-description-foreground select-none`;
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = text;
  header.appendChild(label);
  if (trailing) header.appendChild(trailing);
  return header;
}
function scheduleSettingsSurfaceHidden() {
  if (!state.settingsSurfaceVisible || state.settingsSurfaceHideTimer) return;
  state.settingsSurfaceHideTimer = setTimeout(() => {
    state.settingsSurfaceHideTimer = null;
    const sidebar = findSidebarItemsGroup();
    if (sidebar && isSettingsSidebarCandidate(sidebar)) return;
    if (isSettingsTextVisible()) return;
    setSettingsSurfaceVisible(false, "sidebar-not-found");
  }, 1500);
}
function isSettingsTextVisible() {
  return isCodexPpSettingsLabelSet(codexPpSettingsLabelsFrom(document));
}
function compactSettingsText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
var CODEXPP_CORE_SETTINGS_LABELS = [
  "General",
  "\u5E38\u89C4",
  "\u901A\u7528",
  "Appearance",
  "\u5916\u89C2",
  "Configuration",
  "\u914D\u7F6E",
  "\u9ED8\u8BA4\u6743\u9650",
  "Personalization",
  "\u4E2A\u6027\u5316"
].map(normalizeCodexPpSettingsLabel);
var CODEXPP_EXTENDED_SETTINGS_LABELS = [
  "Account",
  "\u8D26\u6237",
  "\u8D26\u53F7",
  "General",
  "\u5E38\u89C4",
  "\u901A\u7528",
  "Appearance",
  "\u5916\u89C2",
  "Configuration",
  "\u914D\u7F6E",
  "\u9ED8\u8BA4\u6743\u9650",
  "Personalization",
  "\u4E2A\u6027\u5316",
  "Keyboard shortcuts",
  "Archived chats",
  "Usage",
  "Computer use",
  "Browser use",
  "MCP servers",
  "MCP Servers",
  "MCP \u670D\u52A1\u5668",
  "Git",
  "Environments",
  "\u73AF\u5883",
  "Cloud Environments",
  "Worktrees",
  "Connections",
  "Plugins",
  "Skills"
].map(normalizeCodexPpSettingsLabel);
var CODEXPP_SETTINGS_ONLY_LABELS = [
  "General",
  "\u5E38\u89C4",
  "\u901A\u7528",
  "Appearance",
  "\u5916\u89C2",
  "Configuration",
  "\u914D\u7F6E",
  "\u9ED8\u8BA4\u6743\u9650",
  "Personalization",
  "\u4E2A\u6027\u5316",
  "Keyboard shortcuts",
  "Archived chats",
  "Usage",
  "Computer use",
  "Browser use",
  "MCP servers",
  "MCP Servers",
  "MCP \u670D\u52A1\u5668",
  "Git",
  "Environments",
  "\u73AF\u5883",
  "Cloud Environments",
  "Worktrees",
  "Connections"
].map(normalizeCodexPpSettingsLabel);
var CODEXPP_MAIN_APP_NAV_LABELS = [
  "New chat",
  "Quick chat",
  "\u5FEB\u901F\u5BF9\u8BDD",
  "Search",
  "\u641C\u7D22",
  "Plugins",
  "\u63D2\u4EF6",
  "Automations",
  "Automation",
  "\u81EA\u52A8\u5316",
  "Chats",
  "Chat",
  "\u5BF9\u8BDD",
  "Projects",
  "\u9879\u76EE",
  "Pinned",
  "Settings",
  "\u8BBE\u7F6E",
  "Work locally"
].map(normalizeCodexPpSettingsLabel);
function normalizeCodexPpSettingsLabel(value) {
  return compactSettingsText(value).toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
}
function codexPpControlLabel(el) {
  return normalizeCodexPpSettingsLabel(
    el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || ""
  );
}
function codexPpSettingsLabelsFrom(root) {
  const controls = Array.from(
    root.querySelectorAll("button,a,[role='button'],[role='link']")
  );
  return [
    ...new Set(
      controls.map(codexPpControlLabel).filter(Boolean)
    )
  ];
}
function codexPpSettingsLabelScore(labels) {
  const core = /* @__PURE__ */ new Set();
  const total = /* @__PURE__ */ new Set();
  for (const label of labels) {
    for (const marker of CODEXPP_CORE_SETTINGS_LABELS) {
      if (codexPpLabelMatchesMarker(label, marker)) core.add(marker);
    }
    for (const marker of CODEXPP_EXTENDED_SETTINGS_LABELS) {
      if (codexPpLabelMatchesMarker(label, marker)) total.add(marker);
    }
  }
  return { core: core.size, total: total.size };
}
function codexPpLabelMatchesMarker(label, marker) {
  return label === marker || label.includes(marker);
}
function codexPpMarkerCount(labels, markers) {
  const matched = /* @__PURE__ */ new Set();
  for (const label of labels) {
    for (const marker of markers) {
      if (codexPpLabelMatchesMarker(label, marker)) matched.add(marker);
    }
  }
  return matched.size;
}
function hasCodexPpSettingsOnlySignal(labels) {
  return codexPpMarkerCount(labels, CODEXPP_SETTINGS_ONLY_LABELS) > 0;
}
function hasMainAppSidebarSignals(labels) {
  return codexPpMarkerCount(labels, CODEXPP_MAIN_APP_NAV_LABELS) >= 2;
}
function isCodexPpSettingsLabelSet(labels) {
  const score = codexPpSettingsLabelScore(labels);
  return score.core >= 2 && score.total >= 3;
}
function codexPpVisibleBox(el) {
  if (!el.isConnected) return null;
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}
function setSettingsSurfaceVisible(visible, reason) {
  if (state.settingsSurfaceVisible === visible) return;
  state.settingsSurfaceVisible = visible;
  if (visible) warmTweakStore();
  try {
    window.__codexppSettingsSurfaceVisible = visible;
    document.documentElement.dataset.codexppSettingsSurface = visible ? "true" : "false";
    window.dispatchEvent(
      new CustomEvent("codexpp:settings-surface", {
        detail: { visible, reason }
      })
    );
  } catch {
  }
  plog("settings surface", { visible, reason, url: location.href });
}
function syncPagesGroup() {
  const outer = state.sidebarRoot;
  if (!outer) return;
  if (!isSettingsSidebarCandidate(outer)) {
    state.sidebarRoot = null;
    state.pagesGroup = null;
    state.pagesGroupKey = null;
    state.pageNavButtons.clear();
    return;
  }
  const pages = settingsNavigationItems();
  const desiredKey = pages.length === 0 ? "EMPTY" : pages.map((p) => `${p.tweakId}|${p.title}|${p.iconSvg ?? ""}|${p.lifecycle}`).join("\n");
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
    group.dataset.codexpp = "pages-group";
    group.className = "flex flex-col gap-px";
    group.appendChild(sidebarGroupHeader("Tweaks", "pt-3"));
    outer.appendChild(group);
    state.pagesGroup = group;
  } else {
    while (group.children.length > 1) group.removeChild(group.lastChild);
  }
  state.pageNavButtons.clear();
  for (const p of pages) {
    const icon = p.iconSvg ?? defaultPageIconSvg();
    const btn = makeSidebarItem(p.title, icon);
    btn.dataset.codexpp = `nav-page-${p.tweakId}`;
    btn.dataset.codexppLifecycle = p.lifecycle;
    if (p.lifecycle !== "enabled") btn.title = lifecycleLabel(p.lifecycle, p.warning);
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
    ids: pages.map((p) => p.tweakId)
  });
  setNavActive(state.activePage);
}
function constrainSidebarIconSvg(icon, size = 20) {
  if (!icon) return;
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
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.codexpp = `nav-${label.toLowerCase()}`;
  btn.setAttribute("aria-label", label);
  btn.className = "focus-visible:outline-token-border relative px-row-x py-row-y cursor-interaction shrink-0 items-center overflow-hidden rounded-lg text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 gap-2 flex w-full hover:bg-token-list-hover-background font-normal";
  const inner = document.createElement("div");
  inner.className = "flex min-w-0 items-center text-base gap-2 flex-1 text-token-foreground";
  inner.innerHTML = `${iconSvg}<span class="truncate">${label}</span>`;
  constrainSidebarIconSvg(inner.querySelector("svg"));
  btn.appendChild(inner);
  return btn;
}
function setNavActive(active) {
  if (state.navButtons) {
    const builtin = active?.kind === "config" ? "config" : active?.kind === "tweaks" ? "tweaks" : active?.kind === "store" ? "store" : null;
    for (const [key, btn] of Object.entries(state.navButtons)) {
      applyNavActive(btn, key === builtin);
    }
  }
  for (const [tweakId, button2] of state.pageNavButtons) {
    const isActive = active?.kind === "registered" && active.id === tweakId;
    applyNavActive(button2, isActive);
  }
  syncCodexNativeNavActive(active !== null);
}
function syncCodexNativeNavActive(mute) {
  if (!mute) return;
  const root = state.sidebarRoot;
  if (!root) return;
  const buttons = Array.from(root.querySelectorAll("button"));
  for (const btn of buttons) {
    if (btn.dataset.codexpp) continue;
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
      inner.querySelector("svg")?.classList.add("text-token-list-active-selection-icon-foreground");
    }
  } else {
    btn.classList.add("hover:bg-token-list-hover-background", "font-normal");
    btn.classList.remove("bg-token-list-hover-background");
    btn.removeAttribute("aria-current");
    if (inner) {
      inner.classList.add("text-token-foreground");
      inner.classList.remove("text-token-list-active-selection-foreground");
      inner.querySelector("svg")?.classList.remove("text-token-list-active-selection-icon-foreground");
    }
  }
}
function activatePage(page) {
  const content = findContentArea();
  if (!content) {
    plog("activate: content area not found");
    return;
  }
  state.activePage = page;
  plog("activate", { page });
  for (const child of Array.from(content.children)) {
    if (child.dataset.codexpp === "tweaks-panel") continue;
    if (child.dataset.codexppHidden === void 0) {
      child.dataset.codexppHidden = child.style.display || "";
    }
    child.style.display = "none";
  }
  let panel = content.querySelector('[data-codexpp="tweaks-panel"]');
  if (!panel) {
    panel = document.createElement("div");
    panel.dataset.codexpp = "tweaks-panel";
    panel.style.cssText = "width:100%;height:100%;overflow:auto;";
    content.appendChild(panel);
  }
  panel.style.display = "block";
  state.panelHost = panel;
  rerender();
  setNavActive(page);
  const sidebar = state.sidebarRoot;
  if (sidebar) {
    if (state.sidebarRestoreHandler) {
      sidebar.removeEventListener("click", state.sidebarRestoreHandler, true);
    }
    const handler = (e) => {
      const target = e.target;
      if (!target) return;
      if (state.navGroup?.contains(target)) return;
      if (state.pagesGroup?.contains(target)) return;
      if (target.closest("[data-codexpp-settings-search]")) return;
      restoreCodexView();
    };
    state.sidebarRestoreHandler = handler;
    sidebar.addEventListener("click", handler, true);
  }
}
function restoreCodexView() {
  plog("restore codex view");
  const content = findContentArea();
  if (!content) return;
  teardownRenderedPages();
  if (state.panelHost) state.panelHost.style.display = "none";
  for (const child of Array.from(content.children)) {
    if (child === state.panelHost) continue;
    if (child.dataset.codexppHidden !== void 0) {
      child.style.display = child.dataset.codexppHidden;
      delete child.dataset.codexppHidden;
    }
  }
  state.activePage = null;
  setNavActive(null);
  if (state.sidebarRoot && state.sidebarRestoreHandler) {
    state.sidebarRoot.removeEventListener(
      "click",
      state.sidebarRestoreHandler,
      true
    );
    state.sidebarRestoreHandler = null;
  }
}
function rerender() {
  if (!state.activePage) return;
  const host = state.panelHost;
  if (!host) return;
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
    const root2 = panelShell(item.title, item.description);
    host.appendChild(root2.outer);
    root2.headerTitleActions.appendChild(tweakLifecycleBadge(item));
    if (item.warning) root2.sectionsWrap.appendChild(tweakPageWarning(item.warning));
    if (!entries.length) {
      renderFallbackTweakPage(root2.sectionsWrap, item);
      return;
    }
    for (const entry of entries) {
      const section = document.createElement("section");
      section.className = "flex flex-col gap-2";
      if (entries.length > 1) section.appendChild(sectionTitle(entry.page.title));
      const target = document.createElement("div");
      target.className = "flex flex-col gap-3";
      section.appendChild(target);
      root2.sectionsWrap.appendChild(section);
      try {
        try {
          entry.teardown?.();
        } catch {
        }
        entry.teardown = null;
        const ret = entry.page.render(target);
        if (typeof ret === "function") entry.teardown = ret;
      } catch (e) {
        const err = document.createElement("div");
        err.className = "text-token-charts-red text-sm";
        err.textContent = `Error rendering page: ${e.message}`;
        target.appendChild(err);
      }
    }
    return;
  }
  const title = ap.kind === "tweaks" ? "Tweaks" : ap.kind === "store" ? "Tweak Store" : "Tweakers";
  const subtitle = ap.kind === "tweaks" ? "Manage your catalog entries and installed tweaks." : ap.kind === "store" ? "Install reviewed tweaks pinned to approved GitHub commits." : "Checking installed Tweakers version.";
  const root = panelShell(
    title,
    subtitle,
    ap.kind === "tweaks" ? { width: "plugins" } : void 0
  );
  host.appendChild(root.outer);
  if (ap.kind === "tweaks") activeBuiltinPageCleanup = renderTweaksPage(root.sectionsWrap);
  else if (ap.kind === "store") renderTweakStorePage(root.sectionsWrap, root.headerActions);
  else renderConfigPage(root.sectionsWrap, root.subtitle);
}
function teardownRenderedPages() {
  activeBuiltinPageCleanup?.();
  activeBuiltinPageCleanup = null;
  for (const entry of state.pages.values()) {
    if (!entry.teardown) continue;
    try {
      entry.teardown();
    } catch {
    }
    entry.teardown = null;
  }
}
function tweakLifecycleBadge(item) {
  const badge = document.createElement("span");
  badge.className = "inline-flex items-center rounded-full border border-token-border bg-token-foreground/5 px-2 py-0.5 text-xs text-token-text-secondary";
  badge.textContent = `${item.version} \xB7 ${lifecycleLabel(item.lifecycle)}`;
  badge.title = `${item.version} \xB7 ${lifecycleLabel(item.lifecycle, item.warning)}`;
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
      void import_electron.ipcRenderer.invoke("codexpp:recover-tweak", item.tweakId).finally(() => {
        recover.disabled = false;
      });
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
  renderCodexVersionsSection(sectionsWrap);
  renderModeSection(sectionsWrap);
  const section = document.createElement("section");
  section.className = "flex flex-col gap-2";
  section.appendChild(sectionTitle("Tweakers Updates"));
  const card = roundedCard();
  card.dataset.codexppConfigCard = "true";
  const loading = rowSimple("Loading update settings", "Checking current Tweakers configuration.");
  card.appendChild(loading);
  section.appendChild(card);
  sectionsWrap.appendChild(section);
  void import_electron.ipcRenderer.invoke("codexpp:get-config").then((config) => {
    if (subtitle) {
      subtitle.textContent = `You have Tweakers ${config.version} installed.`;
    }
    card.textContent = "";
    renderCodexPlusPlusConfig(card, config);
  }).catch((e) => {
    if (subtitle) subtitle.textContent = "Could not load installed Tweakers version.";
    card.textContent = "";
    card.appendChild(rowSimple("Could not load update settings", String(e)));
  });
  const watcher = document.createElement("section");
  watcher.className = "flex flex-col gap-2";
  watcher.appendChild(sectionTitle("Auto-Repair Watcher"));
  const watcherCard = roundedCard();
  watcherCard.appendChild(rowSimple("Checking watcher", "Verifying the updater repair service."));
  watcher.appendChild(watcherCard);
  sectionsWrap.appendChild(watcher);
  renderWatcherHealthCard(watcherCard);
  const maintenance = document.createElement("section");
  maintenance.className = "flex flex-col gap-2";
  maintenance.appendChild(sectionTitle("Maintenance"));
  const maintenanceCard = roundedCard();
  maintenanceCard.appendChild(uninstallRow());
  maintenanceCard.appendChild(reportBugRow());
  maintenance.appendChild(maintenanceCard);
  sectionsWrap.appendChild(maintenance);
}
function renderCodexVersionsSection(sectionsWrap) {
  const section = document.createElement("section");
  section.className = "flex flex-col gap-2";
  section.dataset.codexppCodexSection = "true";
  const refresh = compactButton("Refresh", () => {
    void load(true);
  });
  const heading = sectionTitle("CODEX", refresh);
  const headingText = heading.querySelector(".text-base");
  section.appendChild(heading);
  const card = roundedCard();
  card.dataset.codexppCodexCard = "true";
  card.appendChild(rowSimple("Loading Codex versions", "Using cached version and feature information first."));
  section.appendChild(card);
  sectionsWrap.appendChild(section);
  let polling = null;
  let actionInFlight = false;
  let generation = 0;
  const schedulePoll = (snapshot2) => {
    if (polling) clearTimeout(polling);
    polling = null;
    if (!actionInFlight && !codexProgressBusy(snapshot2.installProgress)) return;
    polling = setTimeout(() => {
      if (card.isConnected) void load(false);
    }, 900);
  };
  const requestReload = (mode) => {
    if (mode === "operation-start") actionInFlight = true;
    if (mode === "operation-stop") actionInFlight = false;
    void load(false);
  };
  const show = (snapshot2) => {
    if (headingText) headingText.textContent = snapshot2.updateAvailable ? "CODEX (UPDATE AVAILABLE)" : "CODEX";
    card.textContent = "";
    renderCodexVersionsCard(card, snapshot2, requestReload);
    schedulePoll(snapshot2);
  };
  async function load(force) {
    const current = ++generation;
    refresh.disabled = true;
    try {
      const snapshot2 = await import_electron.ipcRenderer.invoke(
        force ? "codexpp:refresh-codex-versions" : "codexpp:get-codex-versions"
      );
      if (current !== generation || !card.isConnected) return;
      show(snapshot2);
      if (!force && isCodexSnapshotStale(snapshot2)) {
        void load(true);
      }
    } catch (error) {
      if (current !== generation || !card.isConnected) return;
      card.textContent = "";
      card.appendChild(rowSimple("Codex versions unavailable", safeUiError(error)));
    } finally {
      if (current === generation) refresh.disabled = false;
    }
  }
  void load(false);
}
function renderCodexVersionsCard(card, snapshot2, reload) {
  const desktop = snapshot2.desktop;
  const bundled = snapshot2.cli.bundled;
  const beta = snapshot2.cli.beta;
  const busy = codexProgressBusy(snapshot2.installProgress);
  if (snapshot2.fromCache || snapshot2.stale) {
    const checked = new Date(snapshot2.checkedAt).toLocaleString();
    card.appendChild(rowSimple(
      snapshot2.stale ? "Cached information (refresh needed)" : "Cached information",
      `Showing the last known good result from ${checked} while current information loads.`
    ));
  }
  card.appendChild(codexDesktopRow(desktop, codexScopedError(snapshot2, "desktop"), busy, reload));
  card.appendChild(rowSimple(
    "Build",
    installedLatestSummary(desktop.installedBuild, desktop.latestBuild, codexScopedError(snapshot2, "desktop"))
  ));
  card.appendChild(codexCliRow("Bundled Codex CLI", "bundled", bundled, snapshot2, busy, reload));
  card.appendChild(codexCliRow("Beta Codex CLI", "beta", beta, snapshot2, busy, reload));
  card.appendChild(codexRuntimeRow(snapshot2, beta, busy, reload));
  const releases = actionRow("GitHub Releases", "View official OpenAI Codex release notes and packages.");
  makeCodexRowResponsive(releases);
  releases.querySelector("[data-codexpp-row-actions]")?.appendChild(
    compactButton("Open Releases", () => openCodexGithubUrl("https://github.com/openai/codex/releases"))
  );
  card.appendChild(releases);
  if (snapshot2.installProgress && snapshot2.installProgress.phase && snapshot2.installProgress.phase !== "idle") {
    const p = snapshot2.installProgress;
    const amount = formatBytes(p.bytes);
    const detail = p.error || [humanizeCodexPhase(p.phase), p.version, amount].filter(Boolean).join(" \xB7 ");
    card.appendChild(rowSimple("Beta operation", detail));
  }
  const stateMessage = codexRuntimeMessage(snapshot2);
  if (stateMessage) card.appendChild(rowSimple("Runtime status", stateMessage));
  card.appendChild(codexFeatureBrowser(snapshot2, busy, reload));
}
function codexDesktopRow(desktop, error, busy, reload) {
  const installed = desktop.installedMarketingVersion;
  const latest = desktop.latestMarketingVersion;
  const row = actionRow("Desktop App", installedLatestSummary(installed, latest, error));
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-codexpp-row-actions]");
  const lifecycle = desktop.nativeUpdateLifecycle;
  const prerequisiteError = desktop.nativeUpdatePrerequisiteError;
  const nativeUnavailable = prerequisiteError === "The native updater is unavailable.";
  if (isSafeCodexGithubUrl(desktop.releaseUrl)) {
    actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(desktop.releaseUrl)));
  }
  const check = compactButton("Check", () => runCodexAction(row, "codexpp:check-codex-desktop-update", void 0, reload));
  check.disabled = busy;
  actions?.appendChild(check);
  const install = compactButton("Install Update", () => runCodexAction(row, "codexpp:install-codex-desktop-update", void 0, reload));
  install.disabled = busy || nativeUnavailable || !desktop.nativeUpdateActionable;
  install.title = prerequisiteError || (install.disabled ? "A verified signed backup and update-ready native updater are required." : "OpenAI's updater may close the app after confirmation.");
  actions?.appendChild(install);
  if (lifecycle || prerequisiteError) {
    const left = row.firstElementChild;
    left?.appendChild(codexInlineMessage(prerequisiteError || `Native updater: ${humanizeCodexPhase(lifecycle ?? "available")}`));
  }
  return row;
}
function codexCliRow(label, lane, cli, snapshot2, busy, reload) {
  const installed = cli.managedCurrentVersion ?? cli.version;
  const latest = cli.release?.version;
  const detail = installedLatestSummary(installed, latest, cli.error || cli.release?.error);
  const row = actionRow(label, detail);
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-codexpp-row-actions]");
  if (snapshot2.effectiveLane === lane) actions?.prepend(statusBadge("ok", "Active"));
  const releaseUrl = cli.release?.releaseUrl;
  if (isSafeCodexGithubUrl(releaseUrl)) actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(releaseUrl)));
  if (lane === "beta") {
    const installLabel = installed && latest && installed !== latest ? "Update" : installed ? "Reinstall" : "Install";
    const install = compactButton(installLabel, () => runCodexAction(row, "codexpp:install-codex-beta", void 0, reload));
    install.disabled = busy || !latest;
    actions?.appendChild(install);
    const previousVersion = cli.managedPreviousVersion;
    if (previousVersion) {
      const rollback = compactButton(`Rollback to ${previousVersion}`, () => runCodexAction(row, "codexpp:rollback-codex-beta", void 0, reload));
      rollback.disabled = busy;
      actions?.appendChild(rollback);
    }
  }
  return row;
}
function codexRuntimeRow(snapshot2, beta, busy, reload) {
  const requested = snapshot2.requestedLane;
  const row = actionRow(
    "Runtime",
    requested ? `${requested === "beta" ? "Beta" : "Bundled"} is selected. Runtime changes apply after restarting the app.` : snapshot2.userOverridePreserved ? "An existing CODEX_CLI_PATH override is preserved until you choose a managed runtime." : "No managed runtime is selected."
  );
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-codexpp-row-actions]");
  actions?.classList.add("flex-wrap", "justify-end");
  const selector = document.createElement("div");
  selector.className = "flex shrink-0 rounded-lg bg-token-foreground/5 p-0.5";
  for (const lane of ["bundled", "beta"]) {
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.textContent = lane === "beta" ? "Beta" : "Bundled";
    button2.className = `rounded-md px-3 py-1.5 text-sm ${requested === lane ? "bg-token-bg-primary shadow-sm text-token-text-primary" : "text-token-text-secondary hover:text-token-text-primary"}`;
    button2.disabled = busy || requested === lane || lane === "beta" && !(beta.managedCurrentVersion ?? beta.version);
    button2.title = lane === "beta" && button2.disabled && requested !== lane ? "Install a verified Beta CLI first." : "";
    button2.addEventListener("click", () => {
      const confirmOverride = snapshot2.userOverridePreserved;
      if (confirmOverride && !window.confirm("Tweakers will replace the existing CODEX_CLI_PATH override with a managed runtime on the next app start. Continue?")) return;
      void runCodexAction(row, "codexpp:set-codex-cli-lane", { lane, confirmOverride }, reload);
    });
    selector.appendChild(button2);
  }
  actions?.appendChild(selector);
  return row;
}
function codexFeatureBrowser(snapshot2, busy, reload) {
  const wrapper = document.createElement("div");
  wrapper.className = "p-3";
  const details = document.createElement("details");
  details.dataset.codexppFeatureBrowser = "true";
  const summary = document.createElement("summary");
  summary.className = "cursor-pointer text-sm text-token-text-primary";
  const features = snapshot2.features;
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
    const selectedLane = snapshot2.requestedLane ?? snapshot2.effectiveLane ?? "bundled";
    const shown = features.filter((feature) => {
      const featureStage = codexFeatureStage(feature, selectedLane);
      const enabled = codexFeatureEnabled(feature, selectedLane);
      const laneMatch = lane.value === "all" || lane.value === "bundled-only" && feature.bundledOnly || lane.value === "beta-only" && feature.betaOnly || lane.value === "bundled" && codexFeatureStage(feature, "bundled") !== null || lane.value === "beta" && codexFeatureStage(feature, "beta") !== null;
      const statusMatch = status.value === "all" || status.value === "enabled" && enabled === true || status.value === "disabled" && enabled === false || status.value === "unsupported" && feature.supported === false || status.value === "read-only" && !codexFeatureMutable(feature, selectedLane);
      return (!query || feature.name.toLowerCase().includes(query)) && (stage.value === "all" || stage.value === featureStage) && laneMatch && statusMatch;
    });
    for (const feature of shown) list.appendChild(codexFeatureRow(feature, selectedLane, busy, reload));
    if (!shown.length) list.appendChild(rowSimple("No matching features", "Try a different search or filter."));
  };
  for (const input of [search, stage, lane, status]) input.addEventListener(input === search ? "input" : "change", draw);
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
  const left = rowCopy(feature.name, `${stage || "unsupported"} \xB7 ${feature.effect === "restart" ? "Restart required" : feature.effect === "none" ? "No restart" : "Applies to new sessions"}`);
  const badges = document.createElement("div");
  badges.className = "flex flex-wrap items-center gap-1";
  if (feature.bundledOnly) badges.appendChild(codexNeutralBadge("Bundled only"));
  if (feature.betaOnly) badges.appendChild(codexNeutralBadge("Beta only"));
  if (feature.supported === false) badges.appendChild(codexNeutralBadge("Unsupported"));
  if (enabled === true) badges.appendChild(statusBadge("ok", "Enabled"));
  if (enabled === false) badges.appendChild(codexNeutralBadge("Disabled"));
  left.appendChild(badges);
  row.appendChild(left);
  if (mutable && enabled !== null) {
    const toggle = switchControl(enabled, async (next) => {
      toggle.disabled = true;
      try {
        await import_electron.ipcRenderer.invoke("codexpp:set-codex-feature", { lane, name: feature.name, enabled: next });
        reload();
      } catch (error) {
        window.alert(`Could not update ${feature.name}: ${safeUiError(error)}`);
        reload();
      } finally {
        toggle.disabled = false;
      }
    });
    toggle.disabled = busy;
    toggle.title = "Feature changes apply to new sessions.";
    row.appendChild(toggle);
  } else {
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
  return feature.mutable === true && feature.supported !== false && stage !== "deprecated" && stage !== "removed" && codexFeatureEnabled(feature, lane) !== null;
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
  row.querySelector("[data-codexpp-row-actions]")?.classList.add("flex-wrap", "justify-end");
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
function isCodexSnapshotStale(snapshot2) {
  return snapshot2.stale;
}
function installedLatestSummary(installed, latest, error) {
  const installedText = installed || "Unavailable";
  const latestText = latest || "Unavailable";
  return `Installed ${installedText} \xB7 Latest ${latestText}${error ? ` \xB7 ${error}` : ""}`;
}
function codexRuntimeMessage(snapshot2) {
  if (snapshot2.fallbackReason) return `Beta could not start; Bundled was used. ${snapshot2.fallbackReason}`;
  if (snapshot2.restartRequired) return "Restart the app to apply the selected Codex runtime.";
  if (snapshot2.requestedLane && snapshot2.effectiveLane && snapshot2.requestedLane !== snapshot2.effectiveLane) {
    return `${snapshot2.requestedLane === "beta" ? "Beta" : "Bundled"} is selected; ${snapshot2.effectiveLane === "beta" ? "Beta" : "Bundled"} remains active until restart.`;
  }
  return null;
}
function codexScopedError(snapshot2, scope) {
  return snapshot2.errors[scope] ?? null;
}
function isSafeCodexGithubUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.port === "" && parsed.username === "" && parsed.password === "" && (parsed.pathname === "/openai/codex" || parsed.pathname.startsWith("/openai/codex/"));
  } catch {
    return false;
  }
}
function openCodexGithubUrl(url) {
  if (!isSafeCodexGithubUrl(url)) {
    plog("blocked non-Codex GitHub URL", url);
    return;
  }
  void import_electron.ipcRenderer.invoke("codexpp:open-external", url).catch((error) => plog("open Codex release failed", String(error)));
}
function runCodexAction(row, channel, payload, reload) {
  const buttons = row.querySelectorAll("button");
  buttons.forEach((button2) => {
    button2.disabled = true;
  });
  row.style.opacity = "0.65";
  reload("operation-start");
  const invoke = payload === void 0 ? import_electron.ipcRenderer.invoke(channel) : import_electron.ipcRenderer.invoke(channel, payload);
  void invoke.catch((error) => {
    window.alert(safeUiError(error));
  }).finally(() => {
    row.style.opacity = "";
    buttons.forEach((button2) => {
      button2.disabled = false;
    });
    reload("operation-stop");
  });
}
function safeUiError(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
function humanizeCodexPhase(value) {
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
var MODE_SWITCH_COPY = {
  chatgpt: {
    title: "Switch to the official ChatGPT app?",
    body: "ChatGPT will quit and restart as the official app. Tweaks turn off; the Chrome-extension bridge turns on; some macOS permissions may need re-granting.",
    restarting: "ChatGPT is quitting and will restart as the official app."
  },
  tweakers: {
    title: "Switch to Tweakers?",
    body: "ChatGPT will quit and restart with Tweakers enabled. Tweaks turn on; the Chrome-extension bridge turns off; some macOS permissions may need re-granting.",
    restarting: "ChatGPT is quitting and will restart with Tweakers enabled."
  }
};
var MODE_DESCRIPTIONS = {
  chatgpt: "OpenAI's standard app experience.",
  tweakers: "The standard app with your enabled Tweakers features."
};
var MODE_SWITCH_START_TIMEOUT_MS = 45e3;
function renderModeSection(sectionsWrap) {
  const section = document.createElement("section");
  section.className = "flex flex-col gap-2";
  section.appendChild(sectionTitle("App Mode"));
  const card = roundedCard();
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-4 p-3";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-1";
  const title = document.createElement("div");
  title.className = "text-sm text-token-text-primary";
  const detail = document.createElement("div");
  detail.className = "text-sm text-token-text-secondary";
  const actions = document.createElement("div");
  actions.className = "flex shrink-0 rounded-lg bg-token-foreground/5 p-0.5";
  const currentMode = "tweakers";
  let switchingTo = null;
  let switchStartTimer = null;
  const clearSwitchStartTimer = () => {
    if (switchStartTimer !== null) {
      clearTimeout(switchStartTimer);
      switchStartTimer = null;
    }
  };
  window.addEventListener("pagehide", clearSwitchStartTimer);
  const startSwitch = (target) => {
    switchingTo = target;
    render();
    void import_electron.ipcRenderer.invoke("codexpp:switch-app-mode", { target }).then((result) => {
      if (result?.ok) {
        clearSwitchStartTimer();
        switchStartTimer = setTimeout(() => {
          switchStartTimer = null;
          switchingTo = null;
          render();
          detail.textContent = "The switch did not start \u2014 check the Tweakers menu-bar switcher or run `tweakers mode status`.";
        }, MODE_SWITCH_START_TIMEOUT_MS);
        return;
      }
      clearSwitchStartTimer();
      switchingTo = null;
      render();
      detail.textContent = result?.message || "The mode switch could not be started.";
    }).catch((error) => {
      clearSwitchStartTimer();
      switchingTo = null;
      render();
      detail.textContent = safeUiError(error);
      plog("switch app mode failed", String(error));
    });
  };
  const render = () => {
    if (switchingTo) {
      title.textContent = "Restarting\u2026";
      detail.textContent = MODE_SWITCH_COPY[switchingTo].restarting;
    } else {
      title.textContent = appModeLabel(currentMode);
      detail.textContent = MODE_DESCRIPTIONS[currentMode];
    }
    actions.replaceChildren();
    for (const target of ["chatgpt", "tweakers"]) {
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.textContent = appModeLabel(target);
      button2.disabled = switchingTo !== null || target === currentMode;
      button2.className = `rounded-md px-3 py-1.5 text-sm ${target === currentMode ? "bg-token-bg-primary shadow-sm text-token-text-primary" : "text-token-text-secondary hover:text-token-text-primary"}`;
      if (target !== currentMode) {
        button2.addEventListener("click", () => openModeSwitchModal(target, () => startSwitch(target)));
      }
      actions.append(button2);
    }
  };
  render();
  copy.append(title, detail);
  row.append(copy, actions);
  card.append(row);
  section.append(card);
  sectionsWrap.append(section);
}
function openModeSwitchModal(target, onConfirm) {
  const overlay = document.createElement("div");
  overlay.dataset.codexppModeModal = "true";
  overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4";
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.className = "border-token-border flex w-full max-w-md flex-col gap-4 rounded-2xl border p-5 shadow-xl";
  dialog.setAttribute(
    "style",
    "background-color: var(--color-background-panel, var(--color-token-bg-fog));"
  );
  const heading = document.createElement("div");
  heading.className = "text-base font-medium text-token-text-primary";
  heading.textContent = MODE_SWITCH_COPY[target].title;
  const body = document.createElement("div");
  body.className = "text-sm text-token-text-secondary";
  body.textContent = MODE_SWITCH_COPY[target].body;
  const buttons = document.createElement("div");
  buttons.className = "flex items-center justify-end gap-2";
  const close = () => {
    document.removeEventListener("keydown", onKeydown, true);
    overlay.remove();
  };
  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const cancel = compactButton("Cancel", close);
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-token-charts-blue px-3 text-sm text-white enabled:hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
  confirm.textContent = "Switch & Restart";
  confirm.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    close();
    onConfirm();
  });
  buttons.append(cancel, confirm);
  const openedAt = Date.now();
  let pressBeganOnOverlay = false;
  overlay.addEventListener("mousedown", (event) => {
    pressBeganOnOverlay = event.target === overlay;
  });
  overlay.addEventListener("click", (event) => {
    if (event.target !== overlay || !pressBeganOnOverlay) return;
    if (Date.now() - openedAt < 250) return;
    close();
  });
  document.addEventListener("keydown", onKeydown, true);
  dialog.append(heading, body, buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  confirm.focus();
}
function renderCodexPlusPlusConfig(card, config) {
  setSidebarCodexPlusPlusUpdateButton(config.updateCheck);
  card.appendChild(autoUpdateRow(config));
  card.appendChild(updateChannelRow(config));
  card.appendChild(installationSourceRow(config.installationSource));
  card.appendChild(selfUpdateStatusRow(config.selfUpdate));
  card.appendChild(checkForUpdatesRow(config));
  if (config.updateCheck?.releaseNotes) card.appendChild(releaseNotesRow(config.updateCheck));
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
  row.appendChild(
    switchControl(config.autoUpdate, async (next) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-auto-update", next);
    })
  );
  return row;
}
function updateChannelRow(config) {
  const row = actionRow("Release channel", updateChannelSummary(config));
  const action = row.querySelector("[data-codexpp-row-actions]");
  const select = document.createElement("select");
  select.className = "h-8 rounded-lg border border-token-border bg-transparent px-2 text-sm text-token-text-primary focus:outline-none";
  for (const [value, label] of [
    ["stable", "Stable"],
    ["prerelease", "Prerelease"],
    ["custom", "Custom"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = config.updateChannel === value;
    select.appendChild(option);
  }
  select.addEventListener("change", () => {
    void import_electron.ipcRenderer.invoke("codexpp:set-update-config", { updateChannel: select.value }).then(() => refreshConfigCard(row)).catch((e) => plog("set update channel failed", String(e)));
  });
  action?.appendChild(select);
  if (config.updateChannel === "custom") {
    action?.appendChild(
      compactButton("Edit", () => {
        const repo = window.prompt("GitHub repo", config.updateRepo || "therealityreport/tweakers");
        if (repo === null) return;
        const ref = window.prompt("Git ref", config.updateRef || "main");
        if (ref === null) return;
        void import_electron.ipcRenderer.invoke("codexpp:set-update-config", {
          updateChannel: "custom",
          updateRepo: repo,
          updateRef: ref
        }).then(() => refreshConfigCard(row)).catch((e) => plog("set custom update source failed", String(e)));
      })
    );
  }
  return row;
}
function installationSourceRow(source) {
  return rowSimple("Installation source", `${source.label}: ${source.detail}`);
}
function selfUpdateStatusRow(state2) {
  const row = rowSimple("Last Tweakers update", selfUpdateSummary(state2));
  const left = row.firstElementChild;
  if (left && state2) {
    const unpublished = state2.status === "failed" && /404|no (?:published |github )?release/i.test(state2.error ?? "");
    left.prepend(statusBadge(unpublished ? "ok" : selfUpdateStatusTone(state2.status), unpublished ? "Current" : selfUpdateStatusLabel(state2.status)));
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
    actions.appendChild(
      compactButton("Release Notes", () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", check.releaseUrl);
      })
    );
  }
  actions.appendChild(
    compactButton("Check Now", () => {
      row.style.opacity = "0.65";
      void import_electron.ipcRenderer.invoke("codexpp:check-codexpp-update", true).then((check2) => {
        setSidebarCodexPlusPlusUpdateButton(check2);
        refreshConfigCard(row);
      }).catch((e) => plog("Tweakers release check failed", String(e))).finally(() => {
        row.style.opacity = "";
      });
    })
  );
  if (check?.updateAvailable) actions.appendChild(
    compactButton("Download Update", () => {
      row.style.opacity = "0.65";
      const buttons = actions.querySelectorAll("button");
      buttons.forEach((button2) => button2.disabled = true);
      void import_electron.ipcRenderer.invoke("codexpp:run-codexpp-update").then(() => {
        refreshSidebarCodexPlusPlusUpdateButton(true);
        refreshConfigCard(row);
      }).catch((e) => {
        plog("Tweakers self-update failed", String(e));
        void refreshConfigCard(row);
      }).finally(() => {
        row.style.opacity = "";
        buttons.forEach((button2) => button2.disabled = false);
      });
    })
  );
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
  body.className = "max-h-60 overflow-auto rounded-md border border-token-border bg-token-foreground/5 p-3 text-sm text-token-text-secondary";
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
    if (paragraph.length === 0) return;
    const p = document.createElement("p");
    p.className = "m-0 leading-5";
    appendInlineMarkdown(p, paragraph.join(" ").trim());
    root.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    root.appendChild(list);
    list = null;
  };
  const flushCode = () => {
    if (!codeLines) return;
    const pre = document.createElement("pre");
    pre.className = "m-0 overflow-auto rounded-md border border-token-border bg-token-foreground/10 p-2 text-xs text-token-text-primary";
    const code = document.createElement("code");
    code.textContent = codeLines.join("\n");
    pre.appendChild(code);
    root.appendChild(pre);
    codeLines = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (codeLines) flushCode();
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
      if (!list || wantOrdered && list.tagName !== "OL" || !wantOrdered && list.tagName !== "UL") {
        flushList();
        list = document.createElement(wantOrdered ? "ol" : "ul");
        list.className = wantOrdered ? "m-0 list-decimal space-y-1 pl-5 leading-5" : "m-0 list-disc space-y-1 pl-5 leading-5";
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
    if (match.index === void 0) continue;
    appendText(parent, text.slice(lastIndex, match.index));
    if (match[2] !== void 0) {
      const code = document.createElement("code");
      code.className = "rounded border border-token-border bg-token-foreground/10 px-1 py-0.5 text-xs text-token-text-primary";
      code.textContent = match[2];
      parent.appendChild(code);
    } else if (match[3] !== void 0 && match[4] !== void 0) {
      const a = document.createElement("a");
      a.className = "text-token-text-primary underline underline-offset-2";
      a.href = match[4];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[3];
      parent.appendChild(a);
    } else if (match[5] !== void 0) {
      const strong = document.createElement("strong");
      strong.className = "font-medium text-token-text-primary";
      strong.textContent = match[5];
      parent.appendChild(strong);
    } else if (match[6] !== void 0) {
      const em = document.createElement("em");
      em.textContent = match[6];
      parent.appendChild(em);
    }
    lastIndex = match.index + match[0].length;
  }
  appendText(parent, text.slice(lastIndex));
}
function appendText(parent, text) {
  if (text) parent.appendChild(document.createTextNode(text));
}
function renderWatcherHealthCard(card) {
  void import_electron.ipcRenderer.invoke("codexpp:get-watcher-health").then((health) => {
    card.textContent = "";
    renderWatcherHealth(card, health);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not check watcher", String(e)));
  });
}
function renderWatcherHealth(card, health) {
  card.appendChild(watcherSummaryRow(health));
  for (const check of health.checks) {
    if (check.status === "ok") continue;
    card.appendChild(watcherCheckRow(check));
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
  action.appendChild(
    compactButton("Check Now", () => {
      const card = row.parentElement;
      if (!card) return;
      card.textContent = "";
      card.appendChild(rowSimple("Checking watcher", "Verifying the updater repair service."));
      renderWatcherHealthCard(card);
    })
  );
  row.appendChild(action);
  return row;
}
function watcherCheckRow(check) {
  const row = rowSimple(check.name, check.detail);
  const left = row.firstElementChild;
  if (left) left.prepend(statusBadge(check.status));
  return row;
}
function statusBadge(status, label) {
  const badge = document.createElement("span");
  const tone = status === "ok" ? "border-token-charts-green text-token-charts-green" : status === "warn" ? "border-token-charts-yellow text-token-charts-yellow" : "border-token-charts-red text-token-charts-red";
  badge.className = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${tone}`;
  badge.textContent = label || (status === "ok" ? "OK" : status === "warn" ? "Review" : "Error");
  return badge;
}
function updateSummary(check) {
  if (!check) return "No update check has run yet.";
  const latest = check.latestVersion ? `Latest v${check.latestVersion}. ` : "";
  const checked = `Checked ${new Date(check.checkedAt).toLocaleString()}.`;
  if (check.error) return `${latest}${checked} ${check.error}`;
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
function selfUpdateSummary(state2) {
  if (!state2) return "No automatic Tweakers update has run yet.";
  const checked = new Date(state2.completedAt ?? state2.checkedAt).toLocaleString();
  const target = state2.latestVersion ? ` Target v${state2.latestVersion}.` : state2.targetRef ? ` Target ${state2.targetRef}.` : "";
  const source = state2.installationSource?.label ?? "unknown source";
  if (state2.status === "failed" && /404|no (?:published |github )?release/i.test(state2.error ?? "")) return `Source checkout is current as of ${checked}; no published release exists yet.`;
  if (state2.status === "failed") return `Update check needs attention (${checked}). ${state2.error ?? "Unknown error"}`;
  if (state2.status === "updated") return `Updated ${checked}.${target} Source: ${source}.`;
  if (state2.status === "up-to-date") return `Up to date ${checked}.${target} Source: ${source}.`;
  if (state2.status === "disabled") return `Skipped ${checked}; automatic refresh is disabled.`;
  return `Checking for updates. Source: ${source}.`;
}
function selfUpdateStatusTone(status) {
  if (status === "failed") return "error";
  if (status === "disabled" || status === "checking") return "warn";
  return "ok";
}
function selfUpdateStatusLabel(status) {
  if (status === "up-to-date") return "Up to date";
  if (status === "updated") return "Updated";
  if (status === "failed") return "Failed";
  if (status === "disabled") return "Disabled";
  return "Checking";
}
function refreshConfigCard(row) {
  const card = row.closest("[data-codexpp-config-card]");
  if (!card) return;
  card.textContent = "";
  card.appendChild(rowSimple("Refreshing", "Loading current Tweakers update status."));
  void import_electron.ipcRenderer.invoke("codexpp:get-config").then((config) => {
    card.textContent = "";
    renderCodexPlusPlusConfig(card, config);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not refresh update settings", String(e)));
  });
}
function uninstallRow() {
  const row = actionRow(
    "Uninstall Tweakers",
    "Copies the uninstall command. Run it from a terminal after quitting Codex."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Copy Command", () => {
      void import_electron.ipcRenderer.invoke("codexpp:copy-text", "node ~/.codex-plusplus/source/packages/installer/dist/cli.js uninstall").catch((e) => plog("copy uninstall command failed", String(e)));
    })
  );
  return row;
}
function reportBugRow() {
  const row = actionRow(
    "Report a bug",
    "Open a GitHub issue with runtime, installer, or tweak-manager details."
  );
  const action = row.querySelector("[data-codexpp-row-actions]");
  action?.appendChild(
    compactButton("Open Issue", () => {
      const title = encodeURIComponent("[Bug]: ");
      const body = encodeURIComponent(
        [
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
          "Attach relevant lines from the Tweakers log directory."
        ].join("\n")
      );
      void import_electron.ipcRenderer.invoke(
        "codexpp:open-external",
        `https://github.com/therealityreport/tweakers/issues/new?title=${title}&body=${body}`
      );
    })
  );
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
  actions.dataset.codexppRowActions = "true";
  actions.className = "flex shrink-0 items-center gap-2";
  row.appendChild(actions);
  return row;
}
function renderTweakStorePage(sectionsWrap, headerActions) {
  const section = document.createElement("section");
  section.className = "flex flex-col gap-4";
  const source = document.createElement("span");
  source.hidden = true;
  source.dataset.codexppStoreSource = "true";
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
  grid.dataset.codexppStoreGrid = "true";
  grid.className = "grid gap-4";
  if (state.tweakStore) {
    grid.dataset.codexppStore = JSON.stringify(state.tweakStore);
    renderTweakStoreGrid(grid, source);
  } else {
    renderTweakStoreGhostGrid(grid);
  }
  section.appendChild(source);
  section.appendChild(grid);
  sectionsWrap.appendChild(section);
  refreshTweakStoreGrid(grid, source, refreshBtn);
}
function refreshTweakStoreGrid(grid, source, refreshBtn, force = false) {
  void getTweakStore(force).then((store) => {
    grid.dataset.codexppStore = JSON.stringify(store);
    renderTweakStoreGrid(grid, source);
  }).catch((e) => {
    grid.dataset.codexppStore = "";
    grid.removeAttribute("aria-busy");
    source.textContent = "Live registry unavailable";
    updateStoreUpdateBadge(null);
    grid.textContent = "";
    grid.appendChild(storeMessageCard("Could not load tweak store", String(e)));
  }).finally(() => {
    if (refreshBtn) refreshBtn.disabled = false;
  });
}
function warmTweakStore() {
  if (state.tweakStore || state.tweakStorePromise) return;
  void getTweakStore().then((store) => {
    updateStoreUpdateBadge(outdatedInstalledStoreCount(store.entries));
  });
}
function getTweakStore(force = false) {
  if (!force) {
    if (state.tweakStore) return Promise.resolve(state.tweakStore);
    if (state.tweakStorePromise) return state.tweakStorePromise;
  }
  state.tweakStoreError = null;
  const promise = import_electron.ipcRenderer.invoke("codexpp:get-tweak-store").then((store) => {
    state.tweakStore = store;
    return state.tweakStore;
  }).catch((e) => {
    state.tweakStoreError = e;
    throw e;
  }).finally(() => {
    if (state.tweakStorePromise === promise) state.tweakStorePromise = null;
  });
  state.tweakStorePromise = promise;
  return promise;
}
function renderTweakStoreGrid(grid, source) {
  const store = parseStoreDataset(grid);
  if (!store) return;
  const entries = store.entries;
  grid.removeAttribute("aria-busy");
  source.textContent = `Refreshed ${new Date(store.fetchedAt).toLocaleString()}`;
  updateStoreUpdateBadge(outdatedInstalledStoreCount(entries));
  grid.textContent = "";
  if (store.entries.length === 0) {
    grid.appendChild(storeMessageCard("No tweaks yet", "Use Publish Tweak to submit the first one."));
    return;
  }
  for (const entry of entries) grid.appendChild(tweakStoreCard(entry));
}
function parseStoreDataset(grid) {
  const raw = grid.dataset.codexppStore;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
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
    actions.appendChild(
      compactButton("Release", () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", entry.releaseUrl);
      })
    );
  }
  const hasUpdate = !!entry.installed && entry.installed.version !== entry.manifest.version;
  if (entry.available === false) {
    card.classList.add("opacity-70");
    actions.appendChild(storeStatusPill("Not available yet"));
  } else if (entry.installed && !hasUpdate) {
    actions.appendChild(storeStatusPill("Installed"));
  } else if (entry.platform && !entry.platform.compatible) {
    card.classList.add("opacity-70");
    actions.appendChild(storeStatusPill(platformLockedLabel(entry.platform)));
  } else if (entry.runtime && !entry.runtime.compatible) {
    card.classList.add("opacity-70");
    actions.appendChild(storeStatusPill(runtimeLockedLabel(entry.runtime)));
  } else {
    const installLabel = entry.installed ? "Update" : "Install";
    if (hasUpdate) actions.appendChild(storeStatusPill("Update available", "info"));
    const installButton = storeInstallButton(installLabel, (button2) => {
      const grid = card.closest("[data-codexpp-store-grid]");
      const source = grid?.parentElement?.querySelector("[data-codexpp-store-source]");
      showStoreButtonLoading(button2, entry.installed ? "Updating" : "Installing");
      actions.querySelectorAll("button").forEach((button3) => button3.disabled = true);
      void import_electron.ipcRenderer.invoke("codexpp:install-store-tweak", entry.id).then(() => {
        showStoreToast(`${entry.manifest.name} installed.`);
        showStoreButtonInstalled(button2);
        versions.replaceChildren(tweakStoreVersionBadge(entry, entry.manifest.version));
        updateStoreUpdateBadge(Math.max(0, currentStoreUpdateBadgeCount() - 1));
        setTimeout(() => {
          actions.replaceChildren(storeStatusPill("Installed"));
          if (grid && source) refreshTweakStoreGrid(grid, source, void 0, true);
        }, 900);
      }).catch((e) => {
        resetStoreInstallButton(button2, installLabel);
        actions.querySelectorAll("button").forEach((button3) => button3.disabled = false);
        showStoreCardMessage(card, String(e.message ?? e));
      });
    });
    actions.appendChild(installButton);
  }
  return card;
}
function platformLockedLabel(platform) {
  const supported = platform.supported ?? [];
  if (supported.includes("win32")) return "Windows only";
  if (supported.includes("darwin")) return "macOS only";
  if (supported.includes("linux")) return "Linux only";
  return "Unavailable";
}
function runtimeLockedLabel(runtime) {
  return runtime.required ? `Requires Tweakers ${runtime.required}` : "Requires newer Tweakers";
}
function showStoreCardMessage(card, message) {
  card.querySelector("[data-codexpp-store-card-message]")?.remove();
  const notice = document.createElement("div");
  notice.dataset.codexppStoreCardMessage = "true";
  notice.className = "rounded-lg border border-token-border/50 bg-token-foreground/5 px-3 py-2 text-sm leading-5 text-token-description-foreground";
  notice.textContent = message;
  const actions = card.lastElementChild;
  if (actions) card.insertBefore(notice, actions);
  else card.appendChild(notice);
}
function tweakStoreCardShell() {
  const card = document.createElement("div");
  card.className = "border-token-border/40 flex min-h-[190px] flex-col justify-between gap-4 rounded-2xl border p-4 transition-colors hover:bg-token-foreground/5";
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
  readMore.className = "inline-flex w-fit items-center gap-1 text-sm font-medium text-token-text-link-foreground hover:underline";
  readMore.innerHTML = `Read More<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5h6.5V10M12.25 3.75 4 12" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  readMore.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void import_electron.ipcRenderer.invoke("codexpp:open-external", `https://github.com/${repo}`);
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
  avatar.className = "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-description-foreground";
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
  avatar.className = "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-description-foreground";
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
  if (!iconUrl) return null;
  if (/^(https?:|data:)/i.test(iconUrl)) return iconUrl;
  const rel = iconUrl.replace(/^\.?\//, "");
  if (!rel || rel.startsWith("../")) return null;
  if (entry.source?.kind === "bundled" || !entry.repo || !entry.approvedCommitSha) return null;
  return `https://raw.githubusercontent.com/${entry.repo}/${entry.approvedCommitSha}/${rel}`;
}
function sidebarUpdatePillButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.dataset.codexppSidebarUpdate = "true";
  btn.className = "user-select-none no-drag cursor-interaction inline-flex shrink-0 items-center justify-center whitespace-nowrap";
  Object.assign(btn.style, {
    display: "none",
    height: "20px",
    borderRadius: "9999px",
    border: "0",
    background: "#0A84FF",
    color: "#FFFFFF",
    padding: "0 8px",
    fontSize: "10px",
    fontWeight: "700",
    lineHeight: "20px",
    letterSpacing: "0",
    textTransform: "none",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.18)"
  });
  btn.textContent = "Update";
  btn.title = "Open Tweakers update";
  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#0071E3";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.background = "#0A84FF";
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void import_electron.ipcRenderer.invoke("codexpp:open-external", btn.dataset.codexppReleaseUrl || TWEAKERS_RELEASES_URL);
  });
  return btn;
}
function refreshSidebarCodexPlusPlusUpdateButton(force = false) {
  const btn = state.codexPlusPlusUpdateButton;
  if (!btn) return;
  void import_electron.ipcRenderer.invoke("codexpp:check-codexpp-update", force).then((check) => setSidebarCodexPlusPlusUpdateButton(check)).catch((e) => {
    plog("Tweakers sidebar release check failed", String(e));
    setSidebarCodexPlusPlusUpdateButton(null);
  });
}
function setSidebarCodexPlusPlusUpdateButton(check) {
  const btn = state.codexPlusPlusUpdateButton;
  if (!btn) return;
  const updateAvailable = check?.updateAvailable === true;
  btn.style.display = updateAvailable ? "inline-flex" : "none";
  btn.hidden = !updateAvailable;
  btn.dataset.codexppReleaseUrl = check?.releaseUrl || TWEAKERS_RELEASES_URL;
  btn.title = updateAvailable && check?.latestVersion ? `Open Tweakers ${check.latestVersion} update` : "Open Tweakers update";
}
function updateStoreUpdateBadge(count) {
  const badge = document.querySelector("[data-codexpp-store-update-badge]");
  if (!badge) return;
  badge.dataset.codexppStoreUpdateCount = count === null ? "" : String(count);
  applyStoreUpdateBadgeStyle(badge, count);
  badge.hidden = count === null || count <= 0;
  badge.textContent = count && count > 0 ? String(count) : "";
  badge.title = count && count > 0 ? `${count} installed tweak${count === 1 ? "" : "s"} can be updated` : "Installed tweaks are up to date";
}
function applyStoreUpdateBadgeStyle(badge, count) {
  const hasUpdates = !!count && count > 0;
  Object.assign(badge.style, {
    minWidth: "24px",
    height: "20px",
    borderRadius: "9999px",
    border: "0",
    background: hasUpdates ? "#0A84FF" : "transparent",
    color: "#FFFFFF",
    padding: "0 7px",
    fontSize: "12px",
    fontWeight: "700",
    lineHeight: "20px",
    letterSpacing: "0",
    boxShadow: hasUpdates ? "0 1px 2px rgba(0, 0, 0, 0.22)" : "none"
  });
}
function currentStoreUpdateBadgeCount() {
  const badge = document.querySelector("[data-codexpp-store-update-badge]");
  const raw = badge?.dataset.codexppStoreUpdateCount;
  const parsed = raw ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
function outdatedInstalledStoreCount(entries) {
  return entries.filter((entry) => !!entry.installed && entry.installed.version !== entry.manifest.version).length;
}
function storeToolbarButton(label, onClick, variant = "secondary") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = variant === "primary" ? "border-token-border user-select-none no-drag cursor-interaction flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-token-border bg-token-bg-fog px-2 py-0 text-sm text-token-button-tertiary-foreground enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40" : "border-token-border user-select-none no-drag cursor-interaction flex h-8 items-center gap-1 whitespace-nowrap rounded-lg border border-transparent bg-token-foreground/5 px-2 py-0 text-sm text-token-foreground enabled:hover:bg-token-foreground/10 disabled:cursor-not-allowed disabled:opacity-40";
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
  btn.className = "border-token-border user-select-none no-drag cursor-interaction flex h-8 w-8 items-center justify-center rounded-lg border border-transparent bg-token-foreground/5 p-0 text-token-foreground enabled:hover:bg-token-foreground/10 disabled:cursor-not-allowed disabled:opacity-40";
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
  return `<svg width="18" height="18" viewBox="0 0 20 20" fill="none" class="icon-xs" aria-hidden="true"><path d="M4.4 9.35A5.65 5.65 0 0 1 14 5.3L15.75 7M15.75 3.75V7h-3.25" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.6 10.65A5.65 5.65 0 0 1 6 14.7L4.25 13M4.25 16.25V13H7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function verifiedSafeBadge() {
  const badge = document.createElement("span");
  badge.className = "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-token-border/30 bg-transparent px-2 text-xs font-medium text-token-description-foreground";
  badge.innerHTML = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" class="text-blue-500" aria-hidden="true"><path d="M7 1.75 11.25 3.4v3.2c0 2.6-1.65 4.25-4.25 5.4-2.6-1.15-4.25-2.8-4.25-5.4V3.4L7 1.75Z" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"/><path d="M4.85 7.05 6.3 8.45l2.85-3.05" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Verified as safe</span>`;
  return badge;
}
function tweakStoreVersionBadge(entry, installedOverride) {
  const installed = installedOverride ?? entry.installed?.version ?? null;
  const latest = entry.manifest.version;
  const hasUpdate = !!installed && installed !== latest;
  const badge = storeVersionBadgeShell(hasUpdate);
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = installed ? `Installed v${installed} \xB7 Latest v${latest}` : `Latest v${latest}`;
  badge.title = installed ? `Installed version ${installed}. Latest approved version ${latest}.` : `Latest approved version ${latest}.`;
  badge.appendChild(label);
  return badge;
}
function storeVersionBadgeShell(hasUpdate) {
  const badge = document.createElement("span");
  badge.className = [
    "inline-flex h-8 min-w-0 max-w-full items-center rounded-lg border px-2.5 text-xs font-medium",
    hasUpdate ? "border-blue-500/30 bg-blue-500/10 text-token-foreground" : "border-token-border/40 bg-token-foreground/5 text-token-description-foreground"
  ].join(" ");
  return badge;
}
function storeStatusPill(label, tone = "neutral") {
  const pill = document.createElement("span");
  pill.className = [
    "inline-flex h-8 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm font-medium",
    tone === "info" ? "border border-blue-500/30 bg-blue-500/10 text-token-foreground" : "bg-token-foreground/5 text-token-description-foreground"
  ].join(" ");
  pill.textContent = label;
  return pill;
}
function storeInstallButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = storeInstallButtonClass();
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
    extra
  ].filter(Boolean).join(" ");
}
function showStoreButtonLoading(button2, label) {
  button2.className = storeInstallButtonClass();
  button2.disabled = true;
  button2.setAttribute("aria-busy", "true");
  button2.innerHTML = `<svg class="animate-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="2" opacity=".25"/><path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>${label}</span>`;
}
function showStoreButtonInstalled(button2) {
  button2.className = storeInstallButtonClass("border-blue-500 bg-blue-500");
  button2.disabled = true;
  button2.removeAttribute("aria-busy");
  button2.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.75 8.15 6.65 11 12.25 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Installed</span>`;
}
function resetStoreInstallButton(button2, label) {
  button2.className = storeInstallButtonClass();
  button2.disabled = false;
  button2.removeAttribute("aria-busy");
  button2.textContent = label;
}
function showStoreToast(message) {
  let host = document.querySelector("[data-codexpp-store-toast-host]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.codexppStoreToastHost = "true";
    host.className = "pointer-events-none fixed bottom-5 right-5 z-[9999] flex flex-col items-end gap-2";
    document.body.appendChild(host);
  }
  const toast = document.createElement("div");
  toast.className = "translate-y-2 rounded-xl border border-token-border/50 bg-token-main-surface-primary px-3 py-2 text-sm font-medium text-token-foreground opacity-0 shadow-lg transition-all duration-200";
  toast.textContent = message;
  host.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove("translate-y-2", "opacity-0");
  });
  setTimeout(() => {
    toast.classList.add("translate-y-2", "opacity-0");
    setTimeout(() => {
      toast.remove();
      if (host && host.childElementCount === 0) host.remove();
    }, 220);
  }, 2600);
}
function storeMessageCard(title, description) {
  const card = document.createElement("div");
  card.className = "border-token-border/40 flex min-h-[84px] flex-col justify-center gap-1 rounded-2xl border p-4 text-sm";
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
function renderTweaksPage(sectionsWrap) {
  const sectionsByTweak = /* @__PURE__ */ new Map();
  for (const section of state.sections.values()) {
    const tweakId = section.id.split(":")[0];
    if (!sectionsByTweak.has(tweakId)) sectionsByTweak.set(tweakId, []);
    sectionsByTweak.get(tweakId).push(section);
  }
  const pagesByTweak = /* @__PURE__ */ new Map();
  for (const page of state.pages.values()) {
    if (!pagesByTweak.has(page.tweakId)) pagesByTweak.set(page.tweakId, []);
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
  search.className = "flex h-token-button-composer w-56 min-w-0 items-center gap-2 rounded-lg border border-token-input-border bg-token-input-background/75 px-2.5 text-base shadow-sm";
  search.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-sm shrink-0 text-token-text-secondary" aria-hidden="true"><circle cx="9" cy="9" r="5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  const searchLabel = document.createElement("label");
  searchLabel.className = "sr-only";
  searchLabel.htmlFor = "codexpp-tweaks-search";
  searchLabel.textContent = "Search tweaks";
  const searchInput = document.createElement("input");
  searchInput.id = "codexpp-tweaks-search";
  searchInput.type = "search";
  searchInput.placeholder = "Search tweaks";
  searchInput.value = state.tweaksPageQuery;
  searchInput.className = "min-w-0 flex-1 bg-transparent text-base text-token-input-foreground outline-none placeholder:text-token-input-placeholder-foreground";
  const clearSearch = document.createElement("button");
  clearSearch.type = "button";
  clearSearch.setAttribute("aria-label", "Clear search");
  clearSearch.className = "flex shrink-0 cursor-interaction text-token-text-secondary hover:text-token-foreground";
  clearSearch.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" class="icon-sm" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  clearSearch.hidden = state.tweaksPageQuery.length === 0;
  search.append(searchLabel, searchInput, clearSearch);
  toolbarActions.appendChild(search);
  const globalMenu = actionMenuButton("More tweak actions", [
    {
      label: "Force Reload",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("codexpp:reload-tweaks").catch((e) => plog("force reload (main) failed", String(e))).finally(() => location.reload());
      }
    },
    {
      label: "Open Tweaks Folder",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("codexpp:reveal", tweaksPath());
      }
    }
  ]);
  toolbarActions.appendChild(globalMenu.element);
  const list = document.createElement("div");
  list.id = "codexpp-tweaks-list";
  list.setAttribute("role", "tabpanel");
  list.className = "flex flex-col gap-2";
  wrap.appendChild(list);
  let rowCleanups = [];
  const renderList = () => {
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
    const counts = tweaksPageCounts(state.listedTweaks);
    tabs.replaceChildren();
    for (const filter of TWEAKS_PAGE_FILTERS) {
      const selected = state.tweaksPageFilter === filter;
      const button2 = document.createElement("button");
      button2.type = "button";
      button2.id = `codexpp-tweaks-filter-${filter}`;
      button2.setAttribute("role", "tab");
      button2.setAttribute("aria-controls", list.id);
      button2.setAttribute("aria-selected", String(selected));
      button2.className = [
        "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm cursor-interaction",
        selected ? "bg-token-list-hover-background font-medium text-token-foreground" : "text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground"
      ].join(" ");
      const label = document.createElement("span");
      label.textContent = tweaksPageFilterLabel(filter);
      const count = document.createElement("span");
      count.className = "text-token-input-placeholder-foreground tabular-nums";
      count.textContent = String(counts[filter]);
      button2.append(label, count);
      button2.addEventListener("click", () => {
        state.tweaksPageFilter = filter;
        renderList();
      });
      tabs.appendChild(button2);
    }
    list.setAttribute("aria-labelledby", `codexpp-tweaks-filter-${state.tweaksPageFilter}`);
    const visible = filterTweaksPageItems(
      state.listedTweaks,
      state.tweaksPageFilter,
      state.tweaksPageQuery
    );
    list.replaceChildren();
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "flex min-h-28 items-center justify-center py-8 text-center text-sm text-token-text-secondary";
      empty.textContent = state.listedTweaks.length === 0 ? `No catalog entries available. Drop a tweak folder into ${tweaksPath()} and reload.` : "No tweaks match this search and filter.";
      list.appendChild(empty);
      return;
    }
    for (const tweak of visible) {
      list.appendChild(tweakRow(
        tweak,
        sectionsByTweak.get(tweak.manifest.id) ?? [],
        pagesByTweak.get(tweak.manifest.id) ?? [],
        (cleanup) => rowCleanups.push(cleanup)
      ));
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
    for (const cleanup of rowCleanups) cleanup();
    rowCleanups = [];
  };
}
function tweaksPageFilterLabel(filter) {
  if (filter === "all") return "All";
  if (filter === "enabled") return "Enabled";
  if (filter === "disabled") return "Disabled";
  return "Updates";
}
function tweakRow(tweak, sections, pages, registerCleanup) {
  const manifest = tweak.manifest;
  const cell = document.createElement("div");
  cell.className = [
    "group flex flex-col overflow-visible rounded-lg border border-token-border/40 bg-token-foreground/5 transition-colors hover:bg-token-list-hover-background",
    !tweak.installed || tweak.status === "disabled" ? "opacity-60" : ""
  ].filter(Boolean).join(" ");
  const header = document.createElement("div");
  header.className = "flex min-h-[64px] items-center gap-3 p-2.5";
  cell.appendChild(header);
  const canConfigure = tweak.installed && tweak.enabled && pages.length > 0;
  const content = document.createElement(canConfigure ? "button" : "div");
  content.className = [
    "flex min-w-0 flex-1 items-center gap-3 text-left",
    canConfigure ? "cursor-interaction rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border" : ""
  ].filter(Boolean).join(" ");
  if (content instanceof HTMLButtonElement) {
    content.type = "button";
    content.title = pages.length === 1 ? `Open ${pages[0].page.title}` : `Open ${pages.map((page) => page.page.title).join(", ")}`;
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
    update.className = "shrink-0 rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-token-text-primary";
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
      onSelect: () => activatePage({ kind: "registered", id: manifest.id })
    });
  }
  if (tweak.update?.updateAvailable && tweak.update.releaseUrl) {
    rowMenuItems.push({
      label: "Review Release",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", tweak.update.releaseUrl);
      }
    });
  }
  rowMenuItems.push({
    label: "Open Repository",
    onSelect: () => {
      void import_electron.ipcRenderer.invoke("codexpp:open-external", `https://github.com/${manifest.githubRepo}`);
    }
  });
  if (manifest.homepage && manifest.homepage !== `https://github.com/${manifest.githubRepo}`) {
    rowMenuItems.push({
      label: "Open Homepage",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("codexpp:open-external", manifest.homepage);
      }
    });
  }
  const rowMenu = actionMenuButton(`More actions for ${manifest.name}`, rowMenuItems);
  rowMenu.element.classList.add(
    "invisible",
    "opacity-0",
    "group-focus-within:visible",
    "group-focus-within:opacity-100",
    "group-hover:visible",
    "group-hover:opacity-100"
  );
  registerCleanup(rowMenu.dispose);
  actions.appendChild(rowMenu.element);
  if (!tweak.installed) {
    if (tweak.catalog?.available === false) {
      actions.appendChild(storeStatusPill("Not installed"));
    } else {
      actions.appendChild(compactButton("Install", () => {
        void import_electron.ipcRenderer.invoke("codexpp:install-store-tweak", manifest.id).then(() => location.reload()).catch((e) => plog("catalog install failed", String(e)));
      }));
    }
  } else if (tweak.status === "quarantined") {
    actions.appendChild(compactButton("Recover", () => {
      void import_electron.ipcRenderer.invoke("codexpp:recover-tweak", manifest.id).catch((e) => plog("tweak recovery failed", String(e)));
    }));
  } else {
    if (tweak.status === "failed") {
      actions.appendChild(compactButton("Retry", () => {
        void import_electron.ipcRenderer.invoke("codexpp:clear-tweak-health", manifest.id).catch((e) => plog("clear tweak health failed", String(e)));
        void import_electron.ipcRenderer.invoke("codexpp:reload-tweaks").catch((e) => plog("tweak retry failed", String(e)));
      }));
    }
    const toggle = switchControl(tweak.enabled, async (next) => {
      await import_electron.ipcRenderer.invoke("codexpp:set-tweak-enabled", manifest.id, next);
    });
    toggle.setAttribute("aria-label", `${tweak.enabled ? "Disable" : "Enable"} ${manifest.name}`);
    actions.appendChild(toggle);
  }
  header.appendChild(actions);
  if (tweak.installed && tweak.enabled && sections.length > 0) {
    const nested = document.createElement("div");
    nested.className = "flex flex-col divide-y-[0.5px] divide-token-border border-t-[0.5px] border-token-border";
    for (const section of sections) {
      const body = document.createElement("div");
      body.className = "p-3";
      try {
        section.render(body);
      } catch (e) {
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
  avatar.className = "flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-token-border-default bg-transparent text-token-text-secondary";
  const initial = document.createElement("span");
  initial.className = "text-base font-medium";
  initial.textContent = (tweak.manifest.name?.[0] ?? "?").toUpperCase();
  avatar.appendChild(initial);
  if (!tweak.manifest.iconUrl) return avatar;
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
    if (url) image.src = url;
    else image.remove();
  });
  avatar.appendChild(image);
  return avatar;
}
function tweakAuthorName(author) {
  if (!author) return null;
  return typeof author === "string" ? author : author.name;
}
function actionMenuButton(label, items) {
  const details = document.createElement("details");
  details.className = "relative shrink-0";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", label);
  summary.setAttribute("aria-haspopup", "menu");
  summary.className = "flex h-8 w-8 list-none cursor-interaction items-center justify-center rounded-lg text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border";
  summary.style.listStyle = "none";
  summary.innerHTML = `<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" class="icon-sm" aria-hidden="true"><circle cx="4" cy="10" r="1.25"/><circle cx="10" cy="10" r="1.25"/><circle cx="16" cy="10" r="1.25"/></svg>`;
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.className = "absolute right-0 top-full z-50 mt-1 flex min-w-44 flex-col rounded-lg border border-token-border bg-token-main-surface-primary p-1 shadow-lg";
  for (const item of items) {
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.setAttribute("role", "menuitem");
    button2.className = "flex h-8 w-full items-center rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-list-hover-background focus-visible:outline-none focus-visible:bg-token-list-hover-background";
    button2.textContent = item.label;
    button2.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      details.open = false;
      item.onSelect();
    });
    menu.appendChild(button2);
  }
  details.append(summary, menu);
  let listening = false;
  const detach = () => {
    if (!listening) return;
    listening = false;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeydown, true);
  };
  const close = () => {
    details.open = false;
    detach();
  };
  const onPointerDown = (event) => {
    if (!details.isConnected || !(event.target instanceof Node) || !details.contains(event.target)) close();
  };
  const onKeydown = (event) => {
    if (event.key !== "Escape") return;
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
    quarantined: "Quarantined"
  };
  const tone = tweak.status === "failed" || tweak.status === "quarantined" ? "error" : tweak.status === "enabled" ? "info" : "neutral";
  const badge = document.createElement("span");
  badge.className = [
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
    tone === "error" ? "border-token-charts-red/30 bg-token-charts-red/10 text-token-charts-red" : tone === "info" ? "border-blue-500/30 bg-blue-500/10 text-token-text-primary" : "border-token-border bg-token-foreground/5 text-token-text-secondary"
  ].join(" ");
  badge.textContent = labels[tweak.status];
  if (tweak.health?.error) badge.title = tweak.health.error;
  return badge;
}
function openPublishTweakDialog() {
  const existing = document.querySelector("[data-codexpp-publish-dialog]");
  existing?.remove();
  const overlay = document.createElement("div");
  overlay.dataset.codexppPublishDialog = "true";
  overlay.className = "fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-4";
  const dialog = document.createElement("div");
  dialog.className = "flex w-full max-w-xl flex-col gap-4 rounded-lg border border-token-border bg-token-main-surface-primary p-4 shadow-xl";
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
  repoInput.className = "h-10 rounded-lg border border-token-border bg-transparent px-3 text-sm text-token-text-primary focus:outline-none";
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
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
  repoInput.focus();
}
async function submitPublishTweak(repoInput, status) {
  status.className = "min-h-5 text-sm text-token-text-secondary";
  status.textContent = "Resolving the repo commit to review.";
  try {
    const submission = await import_electron.ipcRenderer.invoke(
      "codexpp:prepare-tweak-store-submission",
      repoInput.value
    );
    const url = buildTweakPublishIssueUrl(submission);
    await import_electron.ipcRenderer.invoke("codexpp:open-external", url);
    status.textContent = `GitHub review issue opened for ${submission.commitSha.slice(0, 7)}.`;
  } catch (e) {
    status.className = "min-h-5 text-sm text-token-charts-red";
    status.textContent = String(e.message ?? e);
  }
}
function panelShell(title, subtitle, options) {
  const outer = document.createElement("div");
  outer.className = "main-surface flex h-full min-h-0 flex-col";
  const toolbar = document.createElement("div");
  toolbar.className = "draggable flex items-center px-panel electron:h-toolbar extension:h-toolbar-sm";
  outer.appendChild(toolbar);
  const scroll = document.createElement("div");
  scroll.className = "flex-1 overflow-y-auto p-panel";
  outer.appendChild(scroll);
  const inner = document.createElement("div");
  const width = options?.width ?? (options?.wide ? "wide" : "default");
  inner.className = [
    "mx-auto flex w-full flex-col electron:min-w-[calc(320px*var(--codex-window-zoom))]",
    width === "wide" ? "max-w-5xl" : width === "plugins" ? "max-w-3xl" : "max-w-2xl"
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
  titleRow.className = "flex h-toolbar items-center justify-between gap-2 px-0 py-0";
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
function compactButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg border px-2 text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
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
  card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
  card.setAttribute(
    "style",
    "background-color: var(--color-background-panel, var(--color-token-bg-fog));"
  );
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
function switchControl(initial, onChange) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  const pill = document.createElement("span");
  const knob = document.createElement("span");
  knob.className = "rounded-full border border-[color:var(--gray-0)] bg-[color:var(--gray-0)] shadow-sm transition-transform duration-200 ease-out h-4 w-4";
  pill.appendChild(knob);
  const apply = (on) => {
    btn.setAttribute("aria-checked", String(on));
    btn.dataset.state = on ? "checked" : "unchecked";
    btn.className = "inline-flex items-center text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:rounded-full cursor-interaction";
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
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}
function configIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M3 5h9M15 5h2M3 10h2M8 10h9M3 15h11M17 15h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="13" cy="5" r="1.6" fill="currentColor"/><circle cx="6" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="15" r="1.6" fill="currentColor"/></svg>`;
}
function tweaksIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M10 2.5 L11.4 8.6 L17.5 10 L11.4 11.4 L10 17.5 L8.6 11.4 L2.5 10 L8.6 8.6 Z" fill="currentColor"/><path d="M15.5 3 L16 5 L18 5.5 L16 6 L15.5 8 L15 6 L13 5.5 L15 5 Z" fill="currentColor" opacity="0.7"/></svg>`;
}
function defaultPageIconSvg() {
  return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block align-middle" aria-hidden="true"><path d="M5 3h7l3 3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 3v3a1 1 0 0 0 1 1h2" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M7 11h6M7 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
async function resolveIconUrl(url, tweakDir) {
  if (/^(https?:|data:)/.test(url)) return url;
  const rel = url.startsWith("./") ? url.slice(2) : url;
  try {
    return await import_electron.ipcRenderer.invoke(
      "codexpp:read-tweak-asset",
      tweakDir,
      rel
    );
  } catch (e) {
    plog("icon load failed", { url, tweakDir, err: String(e) });
    return null;
  }
}
function findSidebarItemsGroup() {
  const candidates = Array.from(
    document.querySelectorAll("aside,nav,[role='navigation'],div")
  );
  let best = null;
  let bestScore = -1;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.dataset.codexpp) continue;
    if (!isSettingsSidebarCandidate(candidate)) continue;
    const labels = codexPpSettingsLabelsFrom(candidate);
    const score = codexPpSettingsLabelScore(labels);
    const rect = candidate.getBoundingClientRect();
    const area = rect.width * rect.height;
    const weighted = score.core * 100 + score.total;
    if (weighted > bestScore || weighted === bestScore && area < bestArea) {
      best = candidate;
      bestScore = weighted;
      bestArea = area;
    }
  }
  return best;
}
var FORBIDDEN_SETTINGS_SIDEBAR_SELECTOR = [
  "[data-composer-overlay-floating-ui='true']",
  "[data-codexpp-slash-menu='true']",
  "[data-codexpp-overlay-noise='true']",
  ".composer-home-top-menu",
  ".vertical-scroll-fade-mask",
  "[class*='[container-name:home-main-content]']"
].join(",");
function isForbiddenSettingsSidebarSurface(node) {
  if (!node) return false;
  const el = node instanceof HTMLElement ? node : node.parentElement;
  if (!el) return false;
  if (el.closest(FORBIDDEN_SETTINGS_SIDEBAR_SELECTOR)) return true;
  if (el.querySelector("[data-list-navigation-item='true'], [cmdk-item]")) return true;
  return false;
}
function isSettingsSidebarCandidate(el) {
  const rect = codexPpVisibleBox(el);
  if (!rect) return false;
  if (rect.width < 120 || rect.width > 620) return false;
  if (rect.height < 80) return false;
  if (rect.left > window.innerWidth * 0.65) return false;
  const labels = codexPpSettingsLabelsFrom(el);
  if (hasMainAppSidebarSignals(labels) && !hasCodexPpSettingsOnlySignal(labels)) {
    return false;
  }
  return isCodexPpSettingsLabelSet(labels);
}
function removeMisplacedSettingsGroups() {
  const groups = document.querySelectorAll(
    "[data-codexpp='nav-group'], [data-codexpp='pages-group'], [data-codexpp='native-nav-header']"
  );
  for (const group of Array.from(groups)) {
    if (isCodexPpInjectedSettingsGroupPlacementValid(group)) continue;
    resetCodexPpInjectedSettingsGroupState(group);
    group.remove();
  }
}
function isCodexPpInjectedSettingsGroupPlacementValid(group) {
  if (isForbiddenSettingsSidebarSurface(group)) return false;
  if (state.sidebarRoot && state.sidebarRoot.isConnected && (group.parentElement === state.sidebarRoot || state.sidebarRoot.contains(group))) {
    return true;
  }
  let node = group.parentElement;
  for (let depth = 0; node && depth < 4; depth++) {
    if (isForbiddenSettingsSidebarSurface(node)) return false;
    if (isSettingsSidebarCandidate(node)) return true;
    node = node.parentElement;
  }
  return false;
}
function resetCodexPpInjectedSettingsGroupState(group) {
  if (state.navGroup === group || state.navGroup && group.contains(state.navGroup)) {
    state.navGroup = null;
    state.navButtons = null;
    state.codexPlusPlusUpdateButton = null;
  }
  if (state.pagesGroup === group || state.pagesGroup && group.contains(state.pagesGroup)) {
    state.pagesGroup = null;
    state.pagesGroupKey = null;
    state.pageNavButtons.clear();
  }
  if (state.nativeNavHeader === group || state.nativeNavHeader && group.contains(state.nativeNavHeader)) {
    state.nativeNavHeader = null;
  }
  if (state.sidebarRoot && state.sidebarRoot.contains(group)) {
    state.sidebarRoot = null;
  }
}
function findContentArea() {
  const sidebar = findSidebarItemsGroup();
  if (!sidebar) return null;
  let parent = sidebar.parentElement;
  while (parent) {
    for (const child of Array.from(parent.children)) {
      if (child === sidebar || child.contains(sidebar)) continue;
      const r = child.getBoundingClientRect();
      if (r.width > 300 && r.height > 200) return child;
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
      plog(`codex sidebar HTML`, sbRoot.outerHTML.slice(0, 32e3));
    }
    const content = findContentArea();
    if (!content) {
      if (state.fingerprint !== location.href) {
        state.fingerprint = location.href;
        plog("dom probe (no content)", {
          url: location.href,
          sidebar: sidebar ? describe(sidebar) : null
        });
      }
      return;
    }
    let panel = null;
    for (const child of Array.from(content.children)) {
      if (child.dataset.codexpp === "tweaks-panel") continue;
      if (child.style.display === "none") continue;
      panel = child;
      break;
    }
    const activeNav = sidebar ? Array.from(sidebar.querySelectorAll("button, a")).find(
      (b) => b.getAttribute("aria-current") === "page" || b.getAttribute("data-active") === "true" || b.getAttribute("aria-selected") === "true" || b.classList.contains("active")
    ) : null;
    const heading = panel?.querySelector(
      "h1, h2, h3, [class*='heading']"
    );
    const fingerprint = `${activeNav?.textContent ?? ""}|${heading?.textContent ?? ""}|${panel?.children.length ?? 0}`;
    if (state.fingerprint === fingerprint) return;
    state.fingerprint = fingerprint;
    plog("dom probe", {
      url: location.href,
      activeNav: activeNav?.textContent?.trim() ?? null,
      heading: heading?.textContent?.trim() ?? null,
      content: describe(content)
    });
    if (panel) {
      const html = panel.outerHTML;
      plog(
        `codex panel HTML (${activeNav?.textContent?.trim() ?? "?"})`,
        html.slice(0, 32e3)
      );
    }
  } catch (e) {
    plog("dom probe failed", String(e));
  }
}
function describe(el) {
  return {
    tag: el.tagName,
    cls: el.className.slice(0, 120),
    id: el.id || void 0,
    children: el.children.length,
    rect: (() => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()
  };
}
function tweaksPath() {
  return window.__codexpp_tweaks_dir__ ?? "<user dir>/tweaks";
}

// src/preload/tweak-host.ts
var import_electron2 = require("electron");

// src/preload/host-surfaces.ts
var MAX_MATCHES = 100;
var listeners = /* @__PURE__ */ new Set();
var sharedObserver = null;
var pendingFrame = null;
var SELECTORS = {
  "assistant-turns": '[data-testid="conversation-turn"], [data-testid*="assistant-message" i], [data-message-author-role="assistant"], [data-role="assistant"]',
  composer: '#prompt-textarea, [data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"], form textarea:not([disabled]), form [contenteditable="true"]',
  "command-menu": '[data-command-menu], [data-slash-menu], [role="listbox"]',
  "account-menu": '[role="menu"], [role="dialog"]',
  "settings-rows": '[data-settings-row], [role="listitem"], section > div',
  "titlebar-controls": '[data-titlebar-control], [aria-label="Hide sidebar"], [aria-label="Show sidebar"], [aria-label="Back"], [aria-label="Forward"], [title="Back"], [title="Forward"]'
};
var hostUiApi = {
  query: queryHostSurfaces,
  snapshot,
  observe,
  getActiveProject,
  attachFiles
};
function queryHostSurfaces(kind) {
  if (typeof document === "undefined") return [];
  if (kind === "projects") return projectRows();
  if (kind === "thread-context") return threadContexts();
  if (kind === "usage") return usageSurfaces();
  const selector = SELECTORS[kind];
  return uniqueElements(document.querySelectorAll(selector)).filter((element) => semanticFilter(kind, element)).slice(0, MAX_MATCHES).map((element) => ({ kind, element, confidence: confidenceFor(kind, element), label: accessibleLabel(element) }));
}
function snapshot(kind) {
  const matches = queryHostSurfaces(kind).slice(0, MAX_MATCHES);
  return { kind, count: matches.length, matches };
}
function observe(kinds, listener) {
  const entry = { kinds: [...new Set(kinds)], listener };
  listeners.add(entry);
  ensureObserver();
  safelyNotify(entry, entry.kinds.map(snapshot));
  return () => {
    listeners.delete(entry);
    if (!listeners.size) {
      sharedObserver?.disconnect();
      sharedObserver = null;
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
  };
}
function ensureObserver() {
  if (sharedObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  sharedObserver = new MutationObserver(() => {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      for (const entry of listeners) safelyNotify(entry, entry.kinds.map(snapshot));
    });
  });
  sharedObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-label", "aria-current", "role", "data-testid", "data-project-id", "data-project-name", "data-workspace-path", "data-usage-limit-key", "data-usage-limit", "disabled"],
    childList: true,
    characterData: true,
    subtree: true
  });
}
function safelyNotify(entry, snapshots) {
  try {
    entry.listener(snapshots);
  } catch (error) {
    console.warn("[codex-plusplus] host surface observer failed", error);
  }
}
function projectRows() {
  const controls = uniqueElements(document.querySelectorAll('button, a, [role="button"]'));
  return controls.filter((element) => {
    const label = compact(element.textContent);
    if (!label || label.length > 120 || !element.querySelector("svg")) return false;
    return Boolean(directProjectIdentity(element));
  }).slice(0, MAX_MATCHES).map((element) => ({
    kind: "projects",
    element,
    confidence: "high",
    label: compact(element.textContent)
  }));
}
function directProjectIdentity(element) {
  for (const attribute of [
    "data-app-action-sidebar-project-id",
    "data-project-id",
    "data-project-name",
    "data-workspace-path",
    "data-project-path"
  ]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  const props = fiberForNode(element)?.memoizedProps;
  return props && typeof props === "object" ? firstString(props, ["projectId", "projectName", "workspacePath", "projectPath"]) ?? null : null;
}
function threadContexts() {
  const candidates = uniqueElements(document.querySelectorAll('[data-project-id], [data-workspace-path], main, [role="main"]'));
  return candidates.filter((element) => {
    if (element.hasAttribute("data-project-id") || element.hasAttribute("data-workspace-path")) return true;
    const props = fiberProps(element);
    return Boolean(firstString(props, ["projectId", "workspacePath", "projectName"]));
  }).slice(0, MAX_MATCHES).map((element) => ({ kind: "thread-context", element, confidence: element.hasAttribute("data-project-id") ? "high" : "medium", label: accessibleLabel(element) }));
}
function usageSurfaces() {
  const direct = uniqueElements(document.querySelectorAll('[data-usage-limit-key], [data-usage-limit], [data-testid*="usage" i], [aria-label*="usage" i], [class*="usage" i]'));
  const textual = uniqueElements(document.querySelectorAll("section, article, [role='listitem']")).filter((element) => /(?:usage|limit).*(?:remaining|reset|used)|(?:remaining|reset|used).*(?:usage|limit)/i.test(compact(element.textContent)));
  return uniqueElements([...direct, ...textual]).slice(0, MAX_MATCHES).map((element) => ({ kind: "usage", element, confidence: direct.includes(element) ? "high" : "medium", label: accessibleLabel(element) }));
}
function getActiveProject() {
  for (const match of queryHostSurfaces("thread-context")) {
    const element = match.element;
    const props = fiberProps(element);
    const context = {
      id: element.getAttribute("data-project-id") || firstString(props, ["projectId", "id"]),
      name: element.getAttribute("data-project-name") || firstString(props, ["projectName", "name"]),
      workspacePath: element.getAttribute("data-workspace-path") || firstString(props, ["workspacePath", "projectPath", "cwd"])
    };
    if (context.id || context.name || context.workspacePath) return context;
  }
  return null;
}
async function attachFiles(files) {
  const target = queryHostSurfaces("composer")[0]?.element ?? null;
  if (!target) return { accepted: false, reason: "composer-missing" };
  const prepared = files.map((file) => {
    const bytes = Uint8Array.from(atob(file.dataBase64), (char) => char.charCodeAt(0));
    return new File([bytes], safeFileName(file.name), { type: file.mimeType || "application/octet-stream" });
  });
  const transfer = new DataTransfer();
  for (const file of prepared) transfer.items.add(file);
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
  const accepted = target.dispatchEvent(paste);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus?.();
  return { accepted: accepted !== false, reason: accepted === false ? "paste-rejected" : "accepted" };
}
function safeFileName(value) {
  const cleaned = String(value || "AppShot").replace(/[/:\\\0\r\n]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 160) || "AppShot";
}
function semanticFilter(kind, element) {
  const text = compact(element.textContent);
  if (kind === "assistant-turns") {
    const role = element.getAttribute("data-message-author-role") || element.getAttribute("data-role");
    return role ? role.toLowerCase() === "assistant" : /assistant-message/i.test(element.getAttribute("data-testid") || "");
  }
  if (kind === "account-menu") return /account|settings|log\s*out/i.test(text);
  if (kind === "settings-rows") return text.length > 0;
  return true;
}
function confidenceFor(kind, element) {
  if (element.hasAttribute("data-testid") || element.hasAttribute("aria-label") || element.hasAttribute("role")) return "high";
  return kind === "composer" || kind === "titlebar-controls" ? "medium" : "low";
}
function fiberProps(element) {
  let fiber = fiberForNode(element);
  const merged = {};
  for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
    if (fiber.memoizedProps && typeof fiber.memoizedProps === "object") Object.assign(merged, fiber.memoizedProps);
  }
  return Object.keys(merged).length ? merged : null;
}
function firstString(props, keys) {
  if (!props) return void 0;
  const queue = [props];
  const seen = /* @__PURE__ */ new Set();
  for (let visited = 0; queue.length && visited < 80; visited += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      if (keys.includes(key) && typeof item === "string" && item.trim()) return item;
      if (item && typeof item === "object") queue.push(item);
    }
  }
  return void 0;
}
function uniqueElements(input) {
  return [...new Set(Array.from(input))];
}
function accessibleLabel(element) {
  return element.getAttribute("aria-label") || element.getAttribute("title") || compact(element.textContent) || void 0;
}
function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// src/tweak-lifecycle.ts
var DEFAULT_TWEAK_STARTUP_TIMEOUT_MS = 5e3;
var MIN_TWEAK_STARTUP_TIMEOUT_MS = 100;
var MAX_TWEAK_STARTUP_TIMEOUT_MS = 3e4;
function normalizeTweakStartupTimeoutMs(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TWEAK_STARTUP_TIMEOUT_MS;
  }
  return Math.min(
    MAX_TWEAK_STARTUP_TIMEOUT_MS,
    Math.max(MIN_TWEAK_STARTUP_TIMEOUT_MS, Math.round(value))
  );
}
async function withStartupTimeout(value, timeoutMs = DEFAULT_TWEAK_STARTUP_TIMEOUT_MS) {
  const normalizedTimeoutMs = normalizeTweakStartupTimeoutMs(timeoutMs);
  let timer;
  const promise = Promise.resolve(value);
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), normalizedTimeoutMs);
  });
  try {
    const result = await Promise.race([
      promise.then((resolved) => ({ status: "ready", value: resolved })),
      timeout
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    void promise.catch(() => void 0);
  }
}
function runWithStartupTimeout(start, timeoutMs = DEFAULT_TWEAK_STARTUP_TIMEOUT_MS) {
  let value;
  try {
    value = start();
  } catch (error) {
    return Promise.reject(error);
  }
  return withStartupTimeout(value, timeoutMs);
}

// src/preload/tweak-host.ts
var loaded = /* @__PURE__ */ new Map();
var cachedPaths = null;
async function startTweakHost() {
  const tweaks = await import_electron2.ipcRenderer.invoke("codexpp:list-tweaks");
  const paths = await import_electron2.ipcRenderer.invoke("codexpp:user-paths");
  cachedPaths = paths;
  setListedTweaks(tweaks);
  window.__codexpp_tweaks_dir__ = paths.tweaksDir;
  for (const t of tweaks) {
    if (t.manifest.scope === "main") {
      sendLifecycle(t.manifest.id, "disabled", "main-scoped tweak");
      continue;
    }
    if (!t.entryExists) {
      sendLifecycle(t.manifest.id, "disabled", "missing entry");
      continue;
    }
    if (!t.enabled) {
      sendLifecycle(t.manifest.id, t.status === "quarantined" ? "quarantined" : "disabled");
      continue;
    }
    sendLifecycle(t.manifest.id, "starting");
    try {
      const result = await runWithStartupTimeout(
        () => loadTweak(t, paths),
        DEFAULT_TWEAK_STARTUP_TIMEOUT_MS
      );
      if (result.status === "timed_out") {
        sendLifecycle(t.manifest.id, "timed_out", `startup exceeded ${DEFAULT_TWEAK_STARTUP_TIMEOUT_MS}ms`);
        console.error("[codex-plus-plus] tweak startup timed out:", t.manifest.id);
      } else {
        sendLifecycle(t.manifest.id, "ready");
      }
    } catch (e) {
      sendLifecycle(t.manifest.id, "failed", e);
      console.error("[codex-plus-plus] tweak load failed:", t.manifest.id, e);
      try {
        import_electron2.ipcRenderer.send(
          "codexpp:preload-log",
          "error",
          "tweak load failed: " + t.manifest.id + ": " + String(e?.stack ?? e)
        );
      } catch {
      }
    }
  }
  console.info(
    `[codex-plusplus] renderer host loaded ${loaded.size} tweak(s):`,
    [...loaded.keys()].join(", ") || "(none)"
  );
  import_electron2.ipcRenderer.send(
    "codexpp:preload-log",
    "info",
    `renderer host loaded ${loaded.size} tweak(s): ${[...loaded.keys()].join(", ") || "(none)"}`
  );
}
function sendLifecycle(id, status, error) {
  const rendererLifecycle = status === "disabled" && error === "missing entry" ? "failed" : status === "starting" ? "starting" : status === "failed" ? "failed" : status === "timed_out" ? "timed_out" : status === "quarantined" ? "quarantined" : "enabled";
  updateListedTweakLifecycle(id, rendererLifecycle, error === void 0 ? void 0 : error instanceof Error ? error.message : String(error));
  try {
    import_electron2.ipcRenderer.send("codexpp:tweak-lifecycle", {
      id,
      process: "renderer",
      status,
      ...error === void 0 ? {} : { error: error instanceof Error ? error.message : String(error) }
    });
  } catch {
  }
}
function teardownTweakHost() {
  for (const [id, t] of loaded) {
    try {
      t.stop?.();
    } catch (e) {
      console.warn("[codex-plusplus] tweak stop failed:", id, e);
    } finally {
      void import_electron2.ipcRenderer.invoke("codexpp:codex-view-dispose-tweak", id).catch(() => {
      });
      void import_electron2.ipcRenderer.invoke("codexpp:native-dispose-tweak", id).catch(() => {
      });
    }
  }
  loaded.clear();
  clearSections();
}
async function loadTweak(t, paths) {
  const source = await import_electron2.ipcRenderer.invoke(
    "codexpp:read-tweak-source",
    t.entry
  );
  const module2 = { exports: {} };
  const exports2 = module2.exports;
  const fn = new Function(
    "module",
    "exports",
    "console",
    `${source}
//# sourceURL=codexpp-tweak://${encodeURIComponent(t.manifest.id)}/${encodeURIComponent(t.entry)}`
  );
  fn(module2, exports2, console);
  const mod = module2.exports;
  const tweak = mod.default ?? mod;
  if (typeof tweak?.start !== "function") {
    throw new Error(`tweak ${t.manifest.id} has no start()`);
  }
  const api = makeRendererApi(t.manifest, paths);
  await tweak.start(api);
  loaded.set(t.manifest.id, { stop: tweak.stop?.bind(tweak) });
}
function makeRendererApi(manifest, paths) {
  const id = manifest.id;
  const log = (level, ...a) => {
    const consoleFn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    consoleFn(`[codex-plusplus][${id}]`, ...a);
    try {
      const parts = a.map((v) => {
        if (typeof v === "string") return v;
        if (v instanceof Error) return `${v.name}: ${v.message}`;
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      });
      import_electron2.ipcRenderer.send(
        "codexpp:preload-log",
        level,
        `[tweak ${id}] ${parts.join(" ")}`
      );
    } catch {
    }
  };
  return {
    manifest,
    process: "renderer",
    log: {
      debug: (...a) => log("debug", ...a),
      info: (...a) => log("info", ...a),
      warn: (...a) => log("warn", ...a),
      error: (...a) => log("error", ...a)
    },
    storage: rendererStorage(id),
    settings: {
      register: (s) => registerSection({ ...s, id: `${id}:${s.id}` }),
      registerPage: (p) => registerPage(id, manifest, { ...p, id: `${id}:${p.id}` })
    },
    react: {
      getFiber: (n) => fiberForNode(n),
      findOwnerByName: (n, name) => {
        let f = fiberForNode(n);
        while (f) {
          const t = f.type;
          if (t && (t.displayName === name || t.name === name)) return f;
          f = f.return;
        }
        return null;
      },
      waitForElement: (sel, timeoutMs = 5e3) => new Promise((resolve, reject) => {
        const existing = document.querySelector(sel);
        if (existing) return resolve(existing);
        const deadline = Date.now() + timeoutMs;
        const obs = new MutationObserver(() => {
          const el = document.querySelector(sel);
          if (el) {
            obs.disconnect();
            resolve(el);
          } else if (Date.now() > deadline) {
            obs.disconnect();
            reject(new Error(`timeout waiting for ${sel}`));
          }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
      }),
      host: hostUiApi
    },
    ipc: {
      on: (c, h) => {
        const wrapped = (_e, ...args) => h(...args);
        import_electron2.ipcRenderer.on(`codexpp:${id}:${c}`, wrapped);
        return () => import_electron2.ipcRenderer.removeListener(`codexpp:${id}:${c}`, wrapped);
      },
      send: (c, ...args) => import_electron2.ipcRenderer.send(`codexpp:${id}:${c}`, ...args),
      invoke: (c, ...args) => {
        if (id === "co.tweakers.thread-summary-profiles" && c === "profiles.read") {
          return import_electron2.ipcRenderer.invoke(
            "codexpp:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "profiles.read",
            args[0]
          );
        }
        if (id === "co.tweakers.followup" && c === "policy") {
          return import_electron2.ipcRenderer.invoke(
            "codexpp:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "followup.policy.read",
            args[0]
          );
        }
        return import_electron2.ipcRenderer.invoke(`codexpp:${id}:${c}`, ...args);
      }
    },
    fs: rendererFs(id, paths),
    codex: rendererCodexApi(id)
  };
}
function rendererCodexApi(tweakId) {
  return {
    runtime: {
      getInfo: async () => {
        const info = await import_electron2.ipcRenderer.invoke("codexpp:codex-runtime-info");
        const bridge = rendererElectronBridge();
        return {
          ...info,
          buildFlavor: bridge?.getBuildFlavor?.() ?? info.buildFlavor,
          usesOwlAppShell: bridge?.usesOwlAppShell?.() ?? info.usesOwlAppShell
        };
      },
      getCapabilities: () => import_electron2.ipcRenderer.invoke("codexpp:codex-runtime-capabilities")
    },
    windows: {
      create: (options) => import_electron2.ipcRenderer.invoke("codexpp:codex-window-create", options),
      getPrimary: () => import_electron2.ipcRenderer.invoke("codexpp:codex-window-primary"),
      focus: (windowId) => import_electron2.ipcRenderer.invoke("codexpp:codex-window-focus", windowId),
      show: (windowId) => import_electron2.ipcRenderer.invoke("codexpp:codex-window-show", windowId)
    },
    views: {
      create: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "codexpp:codex-view-create",
          tweakId,
          options
        );
        return rendererCodexViewRef(tweakId, ref.id, ref.webContentsId, ref.parentWindowId);
      }
    },
    cdp: {
      getStatus: () => import_electron2.ipcRenderer.invoke("codexpp:codex-cdp-status"),
      listTargets: () => import_electron2.ipcRenderer.invoke("codexpp:codex-cdp-targets")
    },
    native: {
      loadModule: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "codexpp:native-load-module",
          tweakId,
          options
        );
        return rendererNativeModuleRef(tweakId, ref.id, ref.kind);
      },
      createPanel: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "codexpp:native-create-panel",
          tweakId,
          options
        );
        return rendererNativePanelRef(tweakId, ref.id, ref.windowId);
      },
      attachView: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "codexpp:native-attach-view",
          tweakId,
          options
        );
        return rendererNativeViewRef(tweakId, ref.id);
      },
      launchHelper: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "codexpp:native-launch-helper",
          tweakId,
          options
        );
        return rendererNativeHelperRef(tweakId, ref.id, ref.pid);
      }
    },
    refresh: {
      getStatus: () => import_electron2.ipcRenderer.invoke("codexpp:get-refresh-status"),
      start: (source = "smart") => import_electron2.ipcRenderer.invoke("codexpp:start-local-refresh", source),
      onStatusChanged: (listener) => {
        const handler = () => {
          void import_electron2.ipcRenderer.invoke("codexpp:get-refresh-status").then(listener);
        };
        import_electron2.ipcRenderer.on("codexpp:refresh-status-changed", handler);
        return () => import_electron2.ipcRenderer.removeListener("codexpp:refresh-status-changed", handler);
      }
    },
    capture: {
      getPermissionStatus: () => {
        throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
      },
      requestAccessibility: () => {
        throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
      },
      openPermissionSettings: () => {
        throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
      },
      captureFrontmostWindow: () => {
        throw new Error("api.codex.capture is main-only; use a main-scoped tweak");
      }
    },
    hotkeys: {
      registerCaptureHotkey: () => {
        throw new Error("api.codex.hotkeys is main-only; use a main-scoped tweak");
      }
    },
    createBrowserView: (_options) => {
      throw new Error("api.codex.createBrowserView is main-only; use a main-scoped tweak");
    },
    createWindow: (options) => import_electron2.ipcRenderer.invoke("codexpp:codex-window-create", options)
  };
}
function rendererCodexViewRef(tweakId, id, webContentsId, parentWindowId) {
  return {
    id,
    webContentsId,
    parentWindowId,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "setBounds", bounds),
    setVisible: (visible) => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "setVisible", visible),
    bringToFront: () => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "bringToFront"),
    loadRoute: (route, hostId) => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "loadRoute", route, hostId),
    loadUrl: (url) => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "loadUrl", url),
    dispose: () => import_electron2.ipcRenderer.invoke("codexpp:codex-view-call", tweakId, id, "dispose")
  };
}
function rendererNativeModuleRef(tweakId, id, kind) {
  return {
    id,
    kind,
    request: (method, payload, timeoutMs) => import_electron2.ipcRenderer.invoke(
      "codexpp:native-module-request",
      tweakId,
      id,
      method,
      payload,
      timeoutMs
    ),
    dispose: () => import_electron2.ipcRenderer.invoke("codexpp:native-module-dispose", tweakId, id)
  };
}
function rendererNativePanelRef(tweakId, id, windowId) {
  return {
    id,
    windowId,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "panel", id, "setBounds", bounds),
    show: () => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "panel", id, "show"),
    hide: () => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "panel", id, "hide"),
    dispose: () => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "panel", id, "dispose")
  };
}
function rendererNativeViewRef(tweakId, id) {
  return {
    id,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "view", id, "setBounds", bounds),
    setVisible: (visible) => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "view", id, "setVisible", visible),
    dispose: () => import_electron2.ipcRenderer.invoke("codexpp:native-instance-call", tweakId, "view", id, "dispose")
  };
}
function rendererNativeHelperRef(tweakId, id, pid) {
  return {
    id,
    pid,
    send: (message) => import_electron2.ipcRenderer.invoke("codexpp:native-helper-call", tweakId, id, "send", message),
    request: (message, timeoutMs) => import_electron2.ipcRenderer.invoke(
      "codexpp:native-helper-call",
      tweakId,
      id,
      "request",
      message,
      timeoutMs
    ),
    stop: () => import_electron2.ipcRenderer.invoke("codexpp:native-helper-call", tweakId, id, "stop")
  };
}
function rendererElectronBridge() {
  const value = window.electronBridge;
  return value && typeof value === "object" ? value : null;
}
function rendererStorage(id) {
  const key = `codexpp:storage:${id}`;
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return {};
    }
  };
  const write = (v) => localStorage.setItem(key, JSON.stringify(v));
  return {
    get: (k, d) => k in read() ? read()[k] : d,
    set: (k, v) => {
      const o = read();
      o[k] = v;
      write(o);
    },
    delete: (k) => {
      const o = read();
      delete o[k];
      write(o);
    },
    all: () => read()
  };
}
function rendererFs(id, _paths) {
  return {
    dataDir: `<remote>/tweak-data/${id}`,
    read: (p) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "read", id, p),
    write: (p, c) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "write", id, p, c),
    exists: (p) => import_electron2.ipcRenderer.invoke("codexpp:tweak-fs", "exists", id, p)
  };
}

// src/preload/manager.ts
var import_electron3 = require("electron");
async function mountManager() {
  const tweaks = await import_electron3.ipcRenderer.invoke("codexpp:list-tweaks");
  const paths = await import_electron3.ipcRenderer.invoke("codexpp:user-paths");
  registerSection({
    id: "codex-plusplus:manager",
    title: "Tweak Manager",
    description: `${tweaks.length} tweak(s) installed. User dir: ${paths.userRoot}`,
    render(root) {
      root.style.cssText = "display:flex;flex-direction:column;gap:8px;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      actions.appendChild(
        button(
          "Open tweaks folder",
          () => import_electron3.ipcRenderer.invoke("codexpp:reveal", paths.tweaksDir).catch(() => {
          })
        )
      );
      actions.appendChild(
        button(
          "Open logs",
          () => import_electron3.ipcRenderer.invoke("codexpp:reveal", paths.logDir).catch(() => {
          })
        )
      );
      actions.appendChild(
        button("Reload window", () => location.reload())
      );
      root.appendChild(actions);
      if (tweaks.length === 0) {
        const empty = document.createElement("p");
        empty.style.cssText = "color:#888;font:13px system-ui;margin:8px 0;";
        empty.textContent = "No user tweaks yet. Drop a folder with manifest.json + index.js into the tweaks dir, then reload.";
        root.appendChild(empty);
        return;
      }
      const list = document.createElement("ul");
      list.style.cssText = "list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;";
      for (const t of tweaks) {
        const li = document.createElement("li");
        li.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border,#2a2a2a);border-radius:6px;";
        const left = document.createElement("div");
        left.innerHTML = `
          <div style="font:600 13px system-ui;">${escape(t.manifest.name)} <span style="color:#888;font-weight:400;">v${escape(t.manifest.version)}</span></div>
          <div style="color:#888;font:12px system-ui;">${escape(t.manifest.description ?? t.manifest.id)}</div>
        `;
        const right = document.createElement("div");
        right.style.cssText = "color:#888;font:12px system-ui;";
        right.textContent = t.entryExists ? "loaded" : "missing entry";
        li.append(left, right);
        list.append(li);
      }
      root.append(list);
    }
  });
}
function button(label, onclick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = "padding:6px 10px;border:1px solid var(--border,#333);border-radius:6px;background:transparent;color:inherit;font:12px system-ui;cursor:pointer;";
  b.addEventListener("click", onclick);
  return b;
}
function escape(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}

// src/preload/index.ts
var BROWSER_UI_CONNECT_PORT = "codexpp:browser-ui-connect-app-host";
var BROWSER_UI_BRIDGE_REQUEST = "codexpp:browser-ui-bridge-request";
var BROWSER_UI_BRIDGE_RESPONSE = "codexpp:browser-ui-bridge-response";
var BROWSER_UI_MESSAGE_FOR_VIEW = "codexpp:browser-ui-message-for-view";
var BROWSER_UI_WORKER_MESSAGE = "codexpp:browser-ui-worker-message";
var BROWSER_UI_SYSTEM_THEME = "codexpp:browser-ui-system-theme";
var DESKTOP_MESSAGE_FROM_VIEW = "codex_desktop:message-from-view";
var DESKTOP_MESSAGE_FOR_VIEW = "codex_desktop:message-for-view";
var DESKTOP_SHOW_CONTEXT_MENU = "codex_desktop:show-context-menu";
var DESKTOP_SHOW_APPLICATION_MENU = "codex_desktop:show-application-menu";
var DESKTOP_GET_SENTRY_INIT_OPTIONS = "codex_desktop:get-sentry-init-options";
var DESKTOP_GET_BUILD_FLAVOR = "codex_desktop:get-build-flavor";
var DESKTOP_GET_USES_OWL_APP_SHELL = "codex_desktop:get-uses-owl-app-shell";
var DESKTOP_GET_SYSTEM_THEME_VARIANT = "codex_desktop:get-system-theme-variant";
var DESKTOP_GET_SHARED_OBJECT_SNAPSHOT = "codex_desktop:get-shared-object-snapshot";
var DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS = "codex_desktop:get-fast-mode-rollout-metrics";
var DESKTOP_SYSTEM_THEME_UPDATED = "codex_desktop:system-theme-variant-updated";
var DESKTOP_TRIGGER_SENTRY_TEST = "codex_desktop:trigger-sentry-test";
function desktopWorkerFromViewChannel(workerId) {
  return `codex_desktop:worker:${workerId}:from-view`;
}
function desktopWorkerForViewChannel(workerId) {
  return `codex_desktop:worker:${workerId}:for-view`;
}
function fileLog(stage, extra) {
  const msg = `[codex-plusplus preload] ${stage}${extra === void 0 ? "" : " " + safeStringify2(extra)}`;
  try {
    console.error(msg);
  } catch {
  }
  try {
    import_electron4.ipcRenderer.send("codexpp:preload-log", "info", msg);
  } catch {
  }
}
function safeStringify2(v) {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
fileLog("preload entry", { url: location.href });
try {
  installBrowserUiHostBridge();
  fileLog("browser UI host bridge installed");
} catch (e) {
  fileLog("browser UI host bridge FAILED", String(e));
}
try {
  installReactHook();
  fileLog("react hook installed");
} catch (e) {
  fileLog("react hook FAILED", String(e));
}
queueMicrotask(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
});
async function boot() {
  fileLog("boot start", { readyState: document.readyState });
  try {
    startSettingsInjector();
    fileLog("settings injector started");
    await startTweakHost();
    fileLog("tweak host started");
    await mountManager();
    fileLog("manager mounted");
    subscribeReload();
    fileLog("boot complete");
  } catch (e) {
    fileLog("boot FAILED", String(e?.stack ?? e));
    console.error("[codex-plusplus] preload boot failed:", e);
  }
}
var reloading = null;
function subscribeReload() {
  import_electron4.ipcRenderer.on("codexpp:tweaks-changed", () => {
    if (reloading) return;
    reloading = (async () => {
      try {
        console.info("[codex-plusplus] hot-reloading tweaks");
        teardownTweakHost();
        await startTweakHost();
        await mountManager();
      } catch (e) {
        console.error("[codex-plusplus] hot reload failed:", e);
      } finally {
        reloading = null;
      }
    })();
  });
}
function installBrowserUiHostBridge() {
  const workerListeners = /* @__PURE__ */ new Map();
  import_electron4.ipcRenderer.on(BROWSER_UI_CONNECT_PORT, (event) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage({ type: "connect-app-host", port }, "*", [port]);
  });
  import_electron4.ipcRenderer.on(BROWSER_UI_BRIDGE_REQUEST, async (_event, payload) => {
    const request = payload && typeof payload === "object" ? payload : {};
    const id = typeof request.id === "string" ? request.id : "";
    const method = typeof request.method === "string" ? request.method : "";
    const args = Array.isArray(request.args) ? request.args : [];
    try {
      const value = await runBrowserUiBridgeMethod(method, args, workerListeners);
      import_electron4.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, { id, ok: true, value });
    } catch (e) {
      import_electron4.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, {
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  });
  import_electron4.ipcRenderer.on(DESKTOP_MESSAGE_FOR_VIEW, (_event, message) => {
    import_electron4.ipcRenderer.send(BROWSER_UI_MESSAGE_FOR_VIEW, message);
  });
  import_electron4.ipcRenderer.on(DESKTOP_SYSTEM_THEME_UPDATED, (_event, value) => {
    import_electron4.ipcRenderer.send(BROWSER_UI_SYSTEM_THEME, value);
  });
}
async function runBrowserUiBridgeMethod(method, args, workerListeners) {
  switch (method) {
    case "snapshot":
      return import_electron4.ipcRenderer.sendSync(DESKTOP_GET_SHARED_OBJECT_SNAPSHOT) ?? {};
    case "systemTheme":
      return import_electron4.ipcRenderer.sendSync(DESKTOP_GET_SYSTEM_THEME_VARIANT);
    case "sentryOptions":
      return import_electron4.ipcRenderer.sendSync(DESKTOP_GET_SENTRY_INIT_OPTIONS);
    case "buildFlavor":
      return import_electron4.ipcRenderer.sendSync(DESKTOP_GET_BUILD_FLAVOR);
    case "usesOwlAppShell":
      return import_electron4.ipcRenderer.sendSync(DESKTOP_GET_USES_OWL_APP_SHELL) === true;
    case "sendMessageFromView":
      return import_electron4.ipcRenderer.invoke(DESKTOP_MESSAGE_FROM_VIEW, args[0]);
    case "sendWorkerMessageFromView":
      return import_electron4.ipcRenderer.invoke(desktopWorkerFromViewChannel(String(args[0])), args[1]);
    case "subscribeWorkerMessages":
      return subscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "unsubscribeWorkerMessages":
      return unsubscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "showContextMenu":
      return import_electron4.ipcRenderer.invoke(DESKTOP_SHOW_CONTEXT_MENU, args[0]);
    case "showApplicationMenu":
      return import_electron4.ipcRenderer.invoke(DESKTOP_SHOW_APPLICATION_MENU, {
        menuId: args[0],
        x: args[1],
        y: args[2]
      });
    case "getFastModeRolloutMetrics":
      return import_electron4.ipcRenderer.invoke(DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS, args[0]);
    case "triggerSentryTestError":
      return import_electron4.ipcRenderer.invoke(DESKTOP_TRIGGER_SENTRY_TEST);
    default:
      throw new Error(`Unknown Tweakers browser UI bridge method: ${method}`);
  }
}
function subscribeBrowserUiWorkerMessages(workerId, workerListeners) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(workerId)) throw new Error("invalid worker id");
  if (workerListeners.has(workerId)) return true;
  const listener = (_event, message) => {
    import_electron4.ipcRenderer.send(BROWSER_UI_WORKER_MESSAGE, workerId, message);
  };
  workerListeners.set(workerId, listener);
  import_electron4.ipcRenderer.on(desktopWorkerForViewChannel(workerId), listener);
  return true;
}
function unsubscribeBrowserUiWorkerMessages(workerId, workerListeners) {
  const listener = workerListeners.get(workerId);
  if (!listener) return true;
  workerListeners.delete(workerId);
  import_electron4.ipcRenderer.removeListener(desktopWorkerForViewChannel(workerId), listener);
  return true;
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvdHdlYWstc3RvcmUudHMiLCAiLi4vc3JjL3ByZWxvYWQvc2V0dGluZ3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vha3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvYXBwLW1vZGUudHMiLCAiLi4vc3JjL3ByZWxvYWQvdHdlYWstaG9zdC50cyIsICIuLi9zcmMvcHJlbG9hZC9ob3N0LXN1cmZhY2VzLnRzIiwgIi4uL3NyYy90d2Vhay1saWZlY3ljbGUudHMiLCAiLi4vc3JjL3ByZWxvYWQvbWFuYWdlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBSZW5kZXJlciBwcmVsb2FkIGVudHJ5LiBSdW5zIGluIGFuIGlzb2xhdGVkIHdvcmxkIGJlZm9yZSBDb2RleCdzIHBhZ2UgSlMuXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogICAxLiBJbnN0YWxsIGEgUmVhY3QgRGV2VG9vbHMtc2hhcGVkIGdsb2JhbCBob29rIHRvIGNhcHR1cmUgdGhlIHJlbmRlcmVyXG4gKiAgICAgIHJlZmVyZW5jZSB3aGVuIFJlYWN0IG1vdW50cy4gV2UgdXNlIHRoaXMgZm9yIGZpYmVyIHdhbGtpbmcuXG4gKiAgIDIuIEFmdGVyIERPTUNvbnRlbnRMb2FkZWQsIGtpY2sgb2ZmIHNldHRpbmdzLWluamVjdGlvbiBsb2dpYy5cbiAqICAgMy4gRGlzY292ZXIgcmVuZGVyZXItc2NvcGVkIHR3ZWFrcyAodmlhIElQQyB0byBtYWluKSBhbmQgc3RhcnQgdGhlbS5cbiAqICAgNC4gTGlzdGVuIGZvciBgY29kZXhwcDp0d2Vha3MtY2hhbmdlZGAgZnJvbSBtYWluIChmaWxlc3lzdGVtIHdhdGNoZXIpIGFuZFxuICogICAgICBob3QtcmVsb2FkIHR3ZWFrcyB3aXRob3V0IGRyb3BwaW5nIHRoZSBwYWdlLlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyBpbnN0YWxsUmVhY3RIb29rIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHsgc3RhcnRTZXR0aW5nc0luamVjdG9yIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcbmltcG9ydCB7IHN0YXJ0VHdlYWtIb3N0LCB0ZWFyZG93blR3ZWFrSG9zdCB9IGZyb20gXCIuL3R3ZWFrLWhvc3RcIjtcbmltcG9ydCB7IG1vdW50TWFuYWdlciB9IGZyb20gXCIuL21hbmFnZXJcIjtcblxuY29uc3QgQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQgPSBcImNvZGV4cHA6YnJvd3Nlci11aS1jb25uZWN0LWFwcC1ob3N0XCI7XG5jb25zdCBCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNUID0gXCJjb2RleHBwOmJyb3dzZXItdWktYnJpZGdlLXJlcXVlc3RcIjtcbmNvbnN0IEJST1dTRVJfVUlfQlJJREdFX1JFU1BPTlNFID0gXCJjb2RleHBwOmJyb3dzZXItdWktYnJpZGdlLXJlc3BvbnNlXCI7XG5jb25zdCBCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcgPSBcImNvZGV4cHA6YnJvd3Nlci11aS1tZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBCUk9XU0VSX1VJX1dPUktFUl9NRVNTQUdFID0gXCJjb2RleHBwOmJyb3dzZXItdWktd29ya2VyLW1lc3NhZ2VcIjtcbmNvbnN0IEJST1dTRVJfVUlfU1lTVEVNX1RIRU1FID0gXCJjb2RleHBwOmJyb3dzZXItdWktc3lzdGVtLXRoZW1lXCI7XG5cbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GT1JfVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQ09OVEVYVF9NRU5VID0gXCJjb2RleF9kZXNrdG9wOnNob3ctY29udGV4dC1tZW51XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQVBQTElDQVRJT05fTUVOVSA9IFwiY29kZXhfZGVza3RvcDpzaG93LWFwcGxpY2F0aW9uLW1lbnVcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXNlbnRyeS1pbml0LW9wdGlvbnNcIjtcbmNvbnN0IERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUiA9IFwiY29kZXhfZGVza3RvcDpnZXQtYnVpbGQtZmxhdm9yXCI7XG5jb25zdCBERVNLVE9QX0dFVF9VU0VTX09XTF9BUFBfU0hFTEwgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXVzZXMtb3dsLWFwcC1zaGVsbFwiO1xuY29uc3QgREVTS1RPUF9HRVRfU1lTVEVNX1RIRU1FX1ZBUklBTlQgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXN5c3RlbS10aGVtZS12YXJpYW50XCI7XG5jb25zdCBERVNLVE9QX0dFVF9TSEFSRURfT0JKRUNUX1NOQVBTSE9UID0gXCJjb2RleF9kZXNrdG9wOmdldC1zaGFyZWQtb2JqZWN0LXNuYXBzaG90XCI7XG5jb25zdCBERVNLVE9QX0dFVF9GQVNUX01PREVfUk9MTE9VVF9NRVRSSUNTID0gXCJjb2RleF9kZXNrdG9wOmdldC1mYXN0LW1vZGUtcm9sbG91dC1tZXRyaWNzXCI7XG5jb25zdCBERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVEID0gXCJjb2RleF9kZXNrdG9wOnN5c3RlbS10aGVtZS12YXJpYW50LXVwZGF0ZWRcIjtcbmNvbnN0IERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCA9IFwiY29kZXhfZGVza3RvcDp0cmlnZ2VyLXNlbnRyeS10ZXN0XCI7XG5cbmZ1bmN0aW9uIGRlc2t0b3BXb3JrZXJGcm9tVmlld0NoYW5uZWwod29ya2VySWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgY29kZXhfZGVza3RvcDp3b3JrZXI6JHt3b3JrZXJJZH06ZnJvbS12aWV3YDtcbn1cblxuZnVuY3Rpb24gZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYGNvZGV4X2Rlc2t0b3A6d29ya2VyOiR7d29ya2VySWR9OmZvci12aWV3YDtcbn1cblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW2NvZGV4LXBsdXNwbHVzIHByZWxvYWRdICR7c3RhZ2V9JHtcbiAgICBleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSlcbiAgfWA7XG4gIHRyeSB7XG4gICAgY29uc29sZS5lcnJvcihtc2cpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcImNvZGV4cHA6cHJlbG9hZC1sb2dcIiwgXCJpbmZvXCIsIG1zZyk7XG4gIH0gY2F0Y2gge31cbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbmZpbGVMb2coXCJwcmVsb2FkIGVudHJ5XCIsIHsgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xuXG50cnkge1xuICBpbnN0YWxsQnJvd3NlclVpSG9zdEJyaWRnZSgpO1xuICBmaWxlTG9nKFwiYnJvd3NlciBVSSBob3N0IGJyaWRnZSBpbnN0YWxsZWRcIik7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJicm93c2VyIFVJIGhvc3QgYnJpZGdlIEZBSUxFRFwiLCBTdHJpbmcoZSkpO1xufVxuXG4vLyBSZWFjdCBob29rIG11c3QgYmUgaW5zdGFsbGVkICpiZWZvcmUqIENvZGV4J3MgYnVuZGxlIHJ1bnMuXG50cnkge1xuICBpbnN0YWxsUmVhY3RIb29rKCk7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbnF1ZXVlTWljcm90YXNrKCgpID0+IHtcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgYm9vdCwgeyBvbmNlOiB0cnVlIH0pO1xuICB9IGVsc2Uge1xuICAgIGJvb3QoKTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGJvb3QoKSB7XG4gIGZpbGVMb2coXCJib290IHN0YXJ0XCIsIHsgcmVhZHlTdGF0ZTogZG9jdW1lbnQucmVhZHlTdGF0ZSB9KTtcbiAgdHJ5IHtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIltjb2RleC1wbHVzcGx1c10gcHJlbG9hZCBib290IGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gSG90IHJlbG9hZDogZ2F0ZWQgYmVoaW5kIGEgc21hbGwgaW4tZmxpZ2h0IGxvY2sgc28gYSBmbHVycnkgb2YgZnMgZXZlbnRzXG4vLyBkb2Vzbid0IHJlZW50cmFudGx5IHRlYXIgZG93biB0aGUgaG9zdCBtaWQtbG9hZC5cbmxldCByZWxvYWRpbmc6IFByb21pc2U8dm9pZD4gfCBudWxsID0gbnVsbDtcbmZ1bmN0aW9uIHN1YnNjcmliZVJlbG9hZCgpOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIub24oXCJjb2RleHBwOnR3ZWFrcy1jaGFuZ2VkXCIsICgpID0+IHtcbiAgICBpZiAocmVsb2FkaW5nKSByZXR1cm47XG4gICAgcmVsb2FkaW5nID0gKGFzeW5jICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUuaW5mbyhcIltjb2RleC1wbHVzcGx1c10gaG90LXJlbG9hZGluZyB0d2Vha3NcIik7XG4gICAgICAgIHRlYXJkb3duVHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgICAgIGF3YWl0IG1vdW50TWFuYWdlcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW2NvZGV4LXBsdXNwbHVzXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsQnJvd3NlclVpSG9zdEJyaWRnZSgpOiB2b2lkIHtcbiAgY29uc3Qgd29ya2VyTGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+KCk7XG5cbiAgaXBjUmVuZGVyZXIub24oQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQsIChldmVudCkgPT4ge1xuICAgIGNvbnN0IFtwb3J0XSA9IGV2ZW50LnBvcnRzO1xuICAgIGlmICghcG9ydCkgcmV0dXJuO1xuICAgIHdpbmRvdy5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY29ubmVjdC1hcHAtaG9zdFwiLCBwb3J0IH0sIFwiKlwiLCBbcG9ydF0pO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNULCBhc3luYyAoX2V2ZW50LCBwYXlsb2FkKSA9PiB7XG4gICAgY29uc3QgcmVxdWVzdCA9IHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09IFwib2JqZWN0XCJcbiAgICAgID8gcGF5bG9hZCBhcyB7IGlkPzogdW5rbm93bjsgbWV0aG9kPzogdW5rbm93bjsgYXJncz86IHVua25vd24gfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiByZXF1ZXN0LmlkID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5pZCA6IFwiXCI7XG4gICAgY29uc3QgbWV0aG9kID0gdHlwZW9mIHJlcXVlc3QubWV0aG9kID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5tZXRob2QgOiBcIlwiO1xuICAgIGNvbnN0IGFyZ3MgPSBBcnJheS5pc0FycmF5KHJlcXVlc3QuYXJncykgPyByZXF1ZXN0LmFyZ3MgOiBbXTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBydW5Ccm93c2VyVWlCcmlkZ2VNZXRob2QobWV0aG9kLCBhcmdzLCB3b3JrZXJMaXN0ZW5lcnMpO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX0JSSURHRV9SRVNQT05TRSwgeyBpZCwgb2s6IHRydWUsIHZhbHVlIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9CUklER0VfUkVTUE9OU0UsIHtcbiAgICAgICAgaWQsXG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXBjUmVuZGVyZXIub24oREVTS1RPUF9NRVNTQUdFX0ZPUl9WSUVXLCAoX2V2ZW50LCBtZXNzYWdlKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcsIG1lc3NhZ2UpO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVELCAoX2V2ZW50LCB2YWx1ZSkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9TWVNURU1fVEhFTUUsIHZhbHVlKTtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkJyb3dzZXJVaUJyaWRnZU1ldGhvZChcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIGFyZ3M6IHVua25vd25bXSxcbiAgd29ya2VyTGlzdGVuZXJzOiBNYXA8c3RyaW5nLCAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJzbmFwc2hvdFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NIQVJFRF9PQkpFQ1RfU05BUFNIT1QpID8/IHt9O1xuICAgIGNhc2UgXCJzeXN0ZW1UaGVtZVwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NZU1RFTV9USEVNRV9WQVJJQU5UKTtcbiAgICBjYXNlIFwic2VudHJ5T3B0aW9uc1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMpO1xuICAgIGNhc2UgXCJidWlsZEZsYXZvclwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUik7XG4gICAgY2FzZSBcInVzZXNPd2xBcHBTaGVsbFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1VTRVNfT1dMX0FQUF9TSEVMTCkgPT09IHRydWU7XG4gICAgY2FzZSBcInNlbmRNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9NRVNTQUdFX0ZST01fVklFVywgYXJnc1swXSk7XG4gICAgY2FzZSBcInNlbmRXb3JrZXJNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoZGVza3RvcFdvcmtlckZyb21WaWV3Q2hhbm5lbChTdHJpbmcoYXJnc1swXSkpLCBhcmdzWzFdKTtcbiAgICBjYXNlIFwic3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiBzdWJzY3JpYmVCcm93c2VyVWlXb3JrZXJNZXNzYWdlcyhTdHJpbmcoYXJnc1swXSksIHdvcmtlckxpc3RlbmVycyk7XG4gICAgY2FzZSBcInVuc3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFN0cmluZyhhcmdzWzBdKSwgd29ya2VyTGlzdGVuZXJzKTtcbiAgICBjYXNlIFwic2hvd0NvbnRleHRNZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19DT05URVhUX01FTlUsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJzaG93QXBwbGljYXRpb25NZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19BUFBMSUNBVElPTl9NRU5VLCB7XG4gICAgICAgIG1lbnVJZDogYXJnc1swXSxcbiAgICAgICAgeDogYXJnc1sxXSxcbiAgICAgICAgeTogYXJnc1syXSxcbiAgICAgIH0pO1xuICAgIGNhc2UgXCJnZXRGYXN0TW9kZVJvbGxvdXRNZXRyaWNzXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfR0VUX0ZBU1RfTU9ERV9ST0xMT1VUX01FVFJJQ1MsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJ0cmlnZ2VyU2VudHJ5VGVzdEVycm9yXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBUd2Vha2VycyBicm93c2VyIFVJIGJyaWRnZSBtZXRob2Q6ICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGlmICghL15bYS16QS1aMC05Ll86LV0rJC8udGVzdCh3b3JrZXJJZCkpIHRocm93IG5ldyBFcnJvcihcImludmFsaWQgd29ya2VyIGlkXCIpO1xuICBpZiAod29ya2VyTGlzdGVuZXJzLmhhcyh3b3JrZXJJZCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsaXN0ZW5lciA9IChfZXZlbnQ6IHVua25vd24sIG1lc3NhZ2U6IHVua25vd24pID0+IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfV09SS0VSX01FU1NBR0UsIHdvcmtlcklkLCBtZXNzYWdlKTtcbiAgfTtcbiAgd29ya2VyTGlzdGVuZXJzLnNldCh3b3JrZXJJZCwgbGlzdGVuZXIpO1xuICBpcGNSZW5kZXJlci5vbihkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQpLCBsaXN0ZW5lcik7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxpc3RlbmVyID0gd29ya2VyTGlzdGVuZXJzLmdldCh3b3JrZXJJZCk7XG4gIGlmICghbGlzdGVuZXIpIHJldHVybiB0cnVlO1xuICB3b3JrZXJMaXN0ZW5lcnMuZGVsZXRlKHdvcmtlcklkKTtcbiAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkKSwgbGlzdGVuZXIpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICIvKipcbiAqIEluc3RhbGwgYSBtaW5pbWFsIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXy4gUmVhY3QgY2FsbHNcbiAqIGBob29rLmluamVjdChyZW5kZXJlckludGVybmFscylgIGR1cmluZyBgY3JlYXRlUm9vdGAvYGh5ZHJhdGVSb290YC4gVGhlXG4gKiBcImludGVybmFsc1wiIG9iamVjdCBleHBvc2VzIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlLCB3aGljaCBsZXRzIHVzIHR1cm4gYVxuICogRE9NIG5vZGUgaW50byBhIFJlYWN0IGZpYmVyIFx1MjAxNCBuZWNlc3NhcnkgZm9yIG91ciBTZXR0aW5ncyBpbmplY3Rvci5cbiAqXG4gKiBXZSBkb24ndCB3YW50IHRvIGJyZWFrIHJlYWwgUmVhY3QgRGV2VG9vbHMgaWYgdGhlIHVzZXIgb3BlbnMgaXQ7IHdlIGluc3RhbGxcbiAqIG9ubHkgaWYgbm8gaG9vayBleGlzdHMgeWV0LCBhbmQgd2UgZm9yd2FyZCBjYWxscyB0byBhIGRvd25zdHJlYW0gaG9vayBpZlxuICogb25lIGlzIGxhdGVyIGFzc2lnbmVkLlxuICovXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXz86IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgIF9fY29kZXhwcF9fPzoge1xuICAgICAgaG9vazogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgICB9O1xuICB9XG59XG5cbmludGVyZmFjZSBSZW5kZXJlckludGVybmFscyB7XG4gIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPzogKG46IE5vZGUpID0+IHVua25vd247XG4gIHZlcnNpb24/OiBzdHJpbmc7XG4gIGJ1bmRsZVR5cGU/OiBudW1iZXI7XG4gIHJlbmRlcmVyUGFja2FnZU5hbWU/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWFjdERldnRvb2xzSG9vayB7XG4gIHN1cHBvcnRzRmliZXI6IHRydWU7XG4gIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICBvbihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIG9mZihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIGVtaXQoZXZlbnQ6IHN0cmluZywgLi4uYTogdW5rbm93bltdKTogdm9pZDtcbiAgaW5qZWN0KHJlbmRlcmVyOiBSZW5kZXJlckludGVybmFscyk6IG51bWJlcjtcbiAgb25TY2hlZHVsZUZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJVbm1vdW50PygpOiB2b2lkO1xuICBjaGVja0RDRT8oKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSZWFjdEhvb2soKTogdm9pZCB7XG4gIGlmICh3aW5kb3cuX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fKSByZXR1cm47XG4gIGNvbnN0IHJlbmRlcmVycyA9IG5ldyBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz4oKTtcbiAgbGV0IG5leHRJZCA9IDE7XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8KC4uLmE6IHVua25vd25bXSkgPT4gdm9pZD4+KCk7XG5cbiAgY29uc3QgaG9vazogUmVhY3REZXZ0b29sc0hvb2sgPSB7XG4gICAgc3VwcG9ydHNGaWJlcjogdHJ1ZSxcbiAgICByZW5kZXJlcnMsXG4gICAgaW5qZWN0KHJlbmRlcmVyKSB7XG4gICAgICBjb25zdCBpZCA9IG5leHRJZCsrO1xuICAgICAgcmVuZGVyZXJzLnNldChpZCwgcmVuZGVyZXIpO1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICAgIFwiW2NvZGV4LXBsdXNwbHVzXSBSZWFjdCByZW5kZXJlciBhdHRhY2hlZDpcIixcbiAgICAgICAgcmVuZGVyZXIucmVuZGVyZXJQYWNrYWdlTmFtZSxcbiAgICAgICAgcmVuZGVyZXIudmVyc2lvbixcbiAgICAgICk7XG4gICAgICByZXR1cm4gaWQ7XG4gICAgfSxcbiAgICBvbihldmVudCwgZm4pIHtcbiAgICAgIGxldCBzID0gbGlzdGVuZXJzLmdldChldmVudCk7XG4gICAgICBpZiAoIXMpIGxpc3RlbmVycy5zZXQoZXZlbnQsIChzID0gbmV3IFNldCgpKSk7XG4gICAgICBzLmFkZChmbik7XG4gICAgfSxcbiAgICBvZmYoZXZlbnQsIGZuKSB7XG4gICAgICBsaXN0ZW5lcnMuZ2V0KGV2ZW50KT8uZGVsZXRlKGZuKTtcbiAgICB9LFxuICAgIGVtaXQoZXZlbnQsIC4uLmFyZ3MpIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5mb3JFYWNoKChmbikgPT4gZm4oLi4uYXJncykpO1xuICAgIH0sXG4gICAgb25Db21taXRGaWJlclJvb3QoKSB7fSxcbiAgICBvbkNvbW1pdEZpYmVyVW5tb3VudCgpIHt9LFxuICAgIG9uU2NoZWR1bGVGaWJlclJvb3QoKSB7fSxcbiAgICBjaGVja0RDRSgpIHt9LFxuICB9O1xuXG4gIE9iamVjdC5kZWZpbmVQcm9wZXJ0eSh3aW5kb3csIFwiX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fXCIsIHtcbiAgICBjb25maWd1cmFibGU6IHRydWUsXG4gICAgZW51bWVyYWJsZTogZmFsc2UsXG4gICAgd3JpdGFibGU6IHRydWUsIC8vIGFsbG93IHJlYWwgRGV2VG9vbHMgdG8gb3ZlcndyaXRlIGlmIHVzZXIgaW5zdGFsbHMgaXRcbiAgICB2YWx1ZTogaG9vayxcbiAgfSk7XG5cbiAgd2luZG93Ll9fY29kZXhwcF9fID0geyBob29rLCByZW5kZXJlcnMgfTtcbn1cblxuLyoqIFJlc29sdmUgdGhlIFJlYWN0IGZpYmVyIGZvciBhIERPTSBub2RlLCBpZiBhbnkgcmVuZGVyZXIgaGFzIG9uZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWJlckZvck5vZGUobm9kZTogTm9kZSk6IHVua25vd24gfCBudWxsIHtcbiAgY29uc3QgcmVuZGVyZXJzID0gd2luZG93Ll9fY29kZXhwcF9fPy5yZW5kZXJlcnM7XG4gIGlmIChyZW5kZXJlcnMpIHtcbiAgICBmb3IgKGNvbnN0IHIgb2YgcmVuZGVyZXJzLnZhbHVlcygpKSB7XG4gICAgICBjb25zdCBmID0gci5maW5kRmliZXJCeUhvc3RJbnN0YW5jZT8uKG5vZGUpO1xuICAgICAgaWYgKGYpIHJldHVybiBmO1xuICAgIH1cbiAgfVxuICAvLyBGYWxsYmFjazogcmVhZCB0aGUgUmVhY3QgaW50ZXJuYWwgcHJvcGVydHkgZGlyZWN0bHkgZnJvbSB0aGUgRE9NIG5vZGUuXG4gIC8vIFJlYWN0IHN0b3JlcyBmaWJlcnMgYXMgYSBwcm9wZXJ0eSB3aG9zZSBrZXkgc3RhcnRzIHdpdGggXCJfX3JlYWN0RmliZXJcIi5cbiAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKG5vZGUpKSB7XG4gICAgaWYgKGsuc3RhcnRzV2l0aChcIl9fcmVhY3RGaWJlclwiKSkgcmV0dXJuIChub2RlIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW2tdO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuIiwgIi8qKlxuICogU2V0dGluZ3MgaW5qZWN0b3IgZm9yIENvZGV4J3MgU2V0dGluZ3MgcGFnZS5cbiAqXG4gKiBDb2RleCdzIHNldHRpbmdzIGlzIGEgcm91dGVkIHBhZ2UgKFVSTCBzdGF5cyBhdCBgL2luZGV4Lmh0bWw/aG9zdElkPWxvY2FsYClcbiAqIE5PVCBhIG1vZGFsIGRpYWxvZy4gVGhlIHNpZGViYXIgbGl2ZXMgaW5zaWRlIGEgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtMSBnYXAtMFwiPmAgd3JhcHBlciB0aGF0IGhvbGRzIG9uZSBvciBtb3JlIGA8ZGl2IGNsYXNzPVwiZmxleCBmbGV4LWNvbFxuICogZ2FwLXB4XCI+YCBncm91cHMgb2YgYnV0dG9ucy4gVGhlcmUgYXJlIG5vIHN0YWJsZSBgcm9sZWAgLyBgYXJpYS1sYWJlbGAgL1xuICogYGRhdGEtdGVzdGlkYCBob29rcyBvbiB0aGUgc2hlbGwgc28gd2UgaWRlbnRpZnkgdGhlIHNpZGViYXIgYnkgdGV4dC1jb250ZW50XG4gKiBtYXRjaCBhZ2FpbnN0IGtub3duIGl0ZW0gbGFiZWxzIChHZW5lcmFsLCBBcHBlYXJhbmNlLCBDb25maWd1cmF0aW9uLCBcdTIwMjYpLlxuICpcbiAqIExheW91dCB3ZSBpbmplY3Q6XG4gKlxuICogICBHRU5FUkFMICAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBbQ29kZXgncyBleGlzdGluZyBpdGVtcyBncm91cF1cbiAqICAgVFdFQUtFUlMgICAgICAgICAgICAgICAgICAgICAgKHVwcGVyY2FzZSBncm91cCBsYWJlbClcbiAqICAgXHUyNEQ4IENvbmZpZ1xuICogICBcdTI2MzAgVHdlYWtzXG4gKiAgIFx1MjVDNyBUd2VhayBTdG9yZVxuICpcbiAqIENsaWNraW5nIENvbmZpZyAvIFR3ZWFrcyAvIFR3ZWFrIFN0b3JlIGhpZGVzIENvZGV4J3MgY29udGVudCBwYW5lbCBjaGlsZHJlbiBhbmQgcmVuZGVyc1xuICogb3VyIG93biBgbWFpbi1zdXJmYWNlYCBwYW5lbCBpbiB0aGVpciBwbGFjZS4gQ2xpY2tpbmcgYW55IG9mIENvZGV4J3NcbiAqIHNpZGViYXIgaXRlbXMgcmVzdG9yZXMgdGhlIG9yaWdpbmFsIHZpZXcuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB0eXBlIHtcbiAgU2V0dGluZ3NTZWN0aW9uLFxuICBTZXR0aW5nc1BhZ2UsXG4gIFNldHRpbmdzSGFuZGxlLFxuICBUd2Vha01hbmlmZXN0LFxufSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5pbXBvcnQge1xuICBidWlsZFR3ZWFrUHVibGlzaElzc3VlVXJsLFxuICB0eXBlIFR3ZWFrSGVhbHRoUmVjb3JkLFxuICB0eXBlIFR3ZWFrU3RhdHVzLFxuICB0eXBlIFR3ZWFrU3RvcmVFbnRyeSxcbiAgdHlwZSBUd2Vha1N0b3JlUHVibGlzaFN1Ym1pc3Npb24sXG59IGZyb20gXCIuLi90d2Vhay1zdG9yZVwiO1xuaW1wb3J0IHtcbiAgYnVpbGRTZXR0aW5nc05hdmlnYXRpb25Nb2RlbCxcbiAgdHlwZSBTZXR0aW5nc05hdmlnYXRpb25JdGVtLFxufSBmcm9tIFwiLi9zZXR0aW5ncy1wYWdlLW1vZGVsXCI7XG5pbXBvcnQge1xuICBmaWx0ZXJUd2Vha3NQYWdlSXRlbXMsXG4gIFRXRUFLU19QQUdFX0ZJTFRFUlMsXG4gIHR3ZWFrc1BhZ2VDb3VudHMsXG4gIHR5cGUgVHdlYWtzUGFnZUZpbHRlcixcbn0gZnJvbSBcIi4vdHdlYWtzLXBhZ2UtbW9kZWxcIjtcbmltcG9ydCB7IGFwcE1vZGVMYWJlbCwgdHlwZSBBcHBNb2RlVGFyZ2V0IH0gZnJvbSBcIi4uL2FwcC1tb2RlXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENvZGV4Q2xpTGFuZSxcbiAgQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIENvZGV4RGVza3RvcFZlcnNpb25TdGF0ZSxcbiAgQ29kZXhGZWF0dXJlRW50cnksXG4gIENvZGV4RmVhdHVyZVN0YWdlLFxuICBDb2RleEluc3RhbGxQcm9ncmVzcyxcbiAgQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxufSBmcm9tIFwiLi4vY29kZXgtdmVyc2lvbi10eXBlc1wiO1xuXG5jb25zdCBUV0VBS0VSU19SRUxFQVNFU19VUkwgPSBcImh0dHBzOi8vZ2l0aHViLmNvbS90aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzL3JlbGVhc2VzXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIGhlYWx0aDogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xuICBjYXRhbG9nOiBUd2Vha1N0b3JlRW50cnkgfCBudWxsO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBsaWZlY3ljbGVPdmVycmlkZT86IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl07XG59XG5cbmludGVyZmFjZSBUd2Vha1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQ29kZXhQbHVzUGx1c0NvbmZpZyB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgdXBkYXRlQ2hhbm5lbDogU2VsZlVwZGF0ZUNoYW5uZWw7XG4gIHVwZGF0ZVJlcG86IHN0cmluZztcbiAgdXBkYXRlUmVmOiBzdHJpbmc7XG4gIHVwZGF0ZUNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBzZWxmVXBkYXRlOiBTZWxmVXBkYXRlU3RhdGUgfCBudWxsO1xuICBpbnN0YWxsYXRpb25Tb3VyY2U6IEluc3RhbGxhdGlvblNvdXJjZTtcbn1cblxuaW50ZXJmYWNlIENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlTm90ZXM6IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbnR5cGUgU2VsZlVwZGF0ZUNoYW5uZWwgPSBcInN0YWJsZVwiIHwgXCJwcmVyZWxlYXNlXCIgfCBcImN1c3RvbVwiO1xudHlwZSBTZWxmVXBkYXRlU3RhdHVzID0gXCJjaGVja2luZ1wiIHwgXCJ1cC10by1kYXRlXCIgfCBcInVwZGF0ZWRcIiB8IFwiZmFpbGVkXCIgfCBcImRpc2FibGVkXCI7XG5cbmludGVyZmFjZSBTZWxmVXBkYXRlU3RhdGUge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG4gIHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgdGFyZ2V0UmVmOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZXBvOiBzdHJpbmc7XG4gIGNoYW5uZWw6IFNlbGZVcGRhdGVDaGFubmVsO1xuICBzb3VyY2VSb290OiBzdHJpbmc7XG4gIGluc3RhbGxhdGlvblNvdXJjZT86IEluc3RhbGxhdGlvblNvdXJjZTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBJbnN0YWxsYXRpb25Tb3VyY2Uge1xuICBraW5kOiBcImdpdGh1Yi1zb3VyY2VcIiB8IFwiaG9tZWJyZXdcIiB8IFwibG9jYWwtZGV2XCIgfCBcInNvdXJjZS1hcmNoaXZlXCIgfCBcInVua25vd25cIjtcbiAgbGFiZWw6IHN0cmluZztcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbnR5cGUgQ29kZXhVaVJlbG9hZCA9IChtb2RlPzogXCJvcGVyYXRpb24tc3RhcnRcIiB8IFwib3BlcmF0aW9uLXN0b3BcIikgPT4gdm9pZDtcblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGgge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3VtbWFyeTogc3RyaW5nO1xuICB3YXRjaGVyOiBzdHJpbmc7XG4gIGNoZWNrczogV2F0Y2hlckhlYWx0aENoZWNrW107XG59XG5cbmludGVyZmFjZSBXYXRjaGVySGVhbHRoQ2hlY2sge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCI7XG4gIGRldGFpbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGdlbmVyYXRlZEF0Pzogc3RyaW5nO1xuICBzb3VyY2VVcmw6IHN0cmluZztcbiAgZmV0Y2hlZEF0OiBzdHJpbmc7XG4gIGVudHJpZXM6IFR3ZWFrU3RvcmVFbnRyeVZpZXdbXTtcbn1cblxuaW50ZXJmYWNlIFR3ZWFrU3RvcmVFbnRyeVZpZXcgZXh0ZW5kcyBUd2Vha1N0b3JlRW50cnkge1xuICBpbnN0YWxsZWQ6IHtcbiAgICB2ZXJzaW9uOiBzdHJpbmc7XG4gICAgZW5hYmxlZDogYm9vbGVhbjtcbiAgfSB8IG51bGw7XG4gIHBsYXRmb3JtPzoge1xuICAgIGN1cnJlbnQ6IHN0cmluZztcbiAgICBzdXBwb3J0ZWQ6IHN0cmluZ1tdIHwgbnVsbDtcbiAgICBjb21wYXRpYmxlOiBib29sZWFuO1xuICAgIHJlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgfTtcbiAgcnVudGltZT86IHtcbiAgICBjdXJyZW50OiBzdHJpbmc7XG4gICAgcmVxdWlyZWQ6IHN0cmluZyB8IG51bGw7XG4gICAgY29tcGF0aWJsZTogYm9vbGVhbjtcbiAgICByZWFzb246IHN0cmluZyB8IG51bGw7XG4gIH07XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgLyoqIElkZW50aXR5IHRva2VuIHByZXZlbnRzIGFuIG9sZCBoYW5kbGUgZnJvbSB1bnJlZ2lzdGVyaW5nIGEgcmVwbGFjZW1lbnQuICovXG4gIHJlZ2lzdHJhdGlvblRva2VuOiBzeW1ib2w7XG59XG5cbi8qKiBXaGF0IHBhZ2UgaXMgY3VycmVudGx5IHNlbGVjdGVkIGluIG91ciBpbmplY3RlZCBuYXYuICovXG50eXBlIEFjdGl2ZVBhZ2UgPVxuICB8IHsga2luZDogXCJjb25maWdcIiB9XG4gIHwgeyBraW5kOiBcInN0b3JlXCIgfVxuICB8IHsga2luZDogXCJ0d2Vha3NcIiB9XG4gIHwgeyBraW5kOiBcInJlZ2lzdGVyZWRcIjsgaWQ6IHN0cmluZyB9O1xuXG5pbnRlcmZhY2UgSW5qZWN0b3JTdGF0ZSB7XG4gIHNlY3Rpb25zOiBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb24+O1xuICBzZWN0aW9uVG9rZW5zOiBNYXA8c3RyaW5nLCBzeW1ib2w+O1xuICBwYWdlczogTWFwPHN0cmluZywgUmVnaXN0ZXJlZFBhZ2U+O1xuICBsaXN0ZWRUd2Vha3M6IExpc3RlZFR3ZWFrW107XG4gIC8qKiBPdXRlciB3cmFwcGVyIHRoYXQgaG9sZHMgQ29kZXgncyBpdGVtcyBncm91cCArIG91ciBpbmplY3RlZCBncm91cHMuICovXG4gIG91dGVyV3JhcHBlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiR2VuZXJhbFwiIGxhYmVsIGZvciBDb2RleCdzIG5hdGl2ZSBzZXR0aW5ncyBncm91cC4gKi9cbiAgbmF0aXZlTmF2SGVhZGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJUd2Vha2Vyc1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IFBhcnRpYWw8UmVjb3JkPEJ1aWx0aW5QYWdlLCBIVE1MQnV0dG9uRWxlbWVudD4+IHwgbnVsbDtcbiAgLyoqIFNpZGViYXIgdXBkYXRlIHBpbGwgc2hvd24gb25seSB3aGVuIEdpdEh1YiBoYXMgYSBuZXdlciBUd2Vha2VycyByZWxlYXNlLiAqL1xuICBjb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJUd2Vha3NcIiBuYXYgZ3JvdXAgKHBlci10d2VhayBwYWdlcykuIENyZWF0ZWQgbGF6aWx5LiAqL1xuICBwYWdlc0dyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHBhZ2VzR3JvdXBLZXk6IHN0cmluZyB8IG51bGw7XG4gIHBhZ2VOYXZCdXR0b25zOiBNYXA8c3RyaW5nLCBIVE1MQnV0dG9uRWxlbWVudD47XG4gIHBhbmVsSG9zdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGw7XG4gIGZpbmdlcnByaW50OiBzdHJpbmcgfCBudWxsO1xuICBzaWRlYmFyRHVtcGVkOiBib29sZWFuO1xuICBhY3RpdmVQYWdlOiBBY3RpdmVQYWdlIHwgbnVsbDtcbiAgc2lkZWJhclJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiAoKGU6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGw7XG4gIHNldHRpbmdzU3VyZmFjZVZpc2libGU6IGJvb2xlYW47XG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsO1xuICB0d2Vha1N0b3JlOiBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3IHwgbnVsbDtcbiAgdHdlYWtTdG9yZVByb21pc2U6IFByb21pc2U8VHdlYWtTdG9yZVJlZ2lzdHJ5Vmlldz4gfCBudWxsO1xuICB0d2Vha1N0b3JlRXJyb3I6IHVua25vd247XG4gIHR3ZWFrc1BhZ2VGaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXI7XG4gIHR3ZWFrc1BhZ2VRdWVyeTogc3RyaW5nO1xufVxuXG5jb25zdCBzdGF0ZTogSW5qZWN0b3JTdGF0ZSA9IHtcbiAgc2VjdGlvbnM6IG5ldyBNYXAoKSxcbiAgc2VjdGlvblRva2VuczogbmV3IE1hcCgpLFxuICBwYWdlczogbmV3IE1hcCgpLFxuICBsaXN0ZWRUd2Vha3M6IFtdLFxuICBvdXRlcldyYXBwZXI6IG51bGwsXG4gIG5hdGl2ZU5hdkhlYWRlcjogbnVsbCxcbiAgbmF2R3JvdXA6IG51bGwsXG4gIG5hdkJ1dHRvbnM6IG51bGwsXG4gIGNvZGV4UGx1c1BsdXNVcGRhdGVCdXR0b246IG51bGwsXG4gIHBhZ2VzR3JvdXA6IG51bGwsXG4gIHBhZ2VzR3JvdXBLZXk6IG51bGwsXG4gIHBhZ2VOYXZCdXR0b25zOiBuZXcgTWFwKCksXG4gIHBhbmVsSG9zdDogbnVsbCxcbiAgb2JzZXJ2ZXI6IG51bGwsXG4gIGZpbmdlcnByaW50OiBudWxsLFxuICBzaWRlYmFyRHVtcGVkOiBmYWxzZSxcbiAgYWN0aXZlUGFnZTogbnVsbCxcbiAgc2lkZWJhclJvb3Q6IG51bGwsXG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogbnVsbCxcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogZmFsc2UsXG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogbnVsbCxcbiAgdHdlYWtTdG9yZTogbnVsbCxcbiAgdHdlYWtTdG9yZVByb21pc2U6IG51bGwsXG4gIHR3ZWFrU3RvcmVFcnJvcjogbnVsbCxcbiAgdHdlYWtzUGFnZUZpbHRlcjogXCJhbGxcIixcbiAgdHdlYWtzUGFnZVF1ZXJ5OiBcIlwiLFxufTtcblxubGV0IGFjdGl2ZUJ1aWx0aW5QYWdlQ2xlYW51cDogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbmZ1bmN0aW9uIHBsb2cobXNnOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGBbc2V0dGluZ3MtaW5qZWN0b3JdICR7bXNnfSR7ZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpfWAsXG4gICk7XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcHVibGljIEFQSSBcdTI1MDBcdTI1MDBcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm9ic2VydmVyKSByZXR1cm47XG5cbiAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICB9KTtcbiAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgc3RhdGUub2JzZXJ2ZXIgPSBvYnM7XG5cbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJwb3BzdGF0ZVwiLCBvbk5hdik7XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiaGFzaGNoYW5nZVwiLCBvbk5hdik7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkRvY3VtZW50Q2xpY2ssIHRydWUpO1xuICBmb3IgKGNvbnN0IG0gb2YgW1wicHVzaFN0YXRlXCIsIFwicmVwbGFjZVN0YXRlXCJdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3JpZyA9IGhpc3RvcnlbbV07XG4gICAgaGlzdG9yeVttXSA9IGZ1bmN0aW9uICh0aGlzOiBIaXN0b3J5LCAuLi5hcmdzOiBQYXJhbWV0ZXJzPHR5cGVvZiBvcmlnPikge1xuICAgICAgY29uc3QgciA9IG9yaWcuYXBwbHkodGhpcywgYXJncyk7XG4gICAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoYGNvZGV4cHAtJHttfWApKTtcbiAgICAgIHJldHVybiByO1xuICAgIH0gYXMgdHlwZW9mIG9yaWc7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoYGNvZGV4cHAtJHttfWAsIG9uTmF2KTtcbiAgfVxuXG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbiAgbGV0IHRpY2tzID0gMDtcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgdGlja3MrKztcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgICBpZiAodGlja3MgPiA2MCkgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gIH0sIDUwMCk7XG59XG5cbmZ1bmN0aW9uIG9uTmF2KCk6IHZvaWQge1xuICBzdGF0ZS5maW5nZXJwcmludCA9IG51bGw7XG4gIHRyeUluamVjdCgpO1xuICBtYXliZUR1bXBEb20oKTtcbn1cblxuZnVuY3Rpb24gb25Eb2N1bWVudENsaWNrKGU6IE1vdXNlRXZlbnQpOiB2b2lkIHtcbiAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgaW5zdGFuY2VvZiBFbGVtZW50ID8gZS50YXJnZXQgOiBudWxsO1xuICBjb25zdCBjb250cm9sID0gdGFyZ2V0Py5jbG9zZXN0KFwiW3JvbGU9J2xpbmsnXSxidXR0b24sYVwiKTtcbiAgaWYgKCEoY29udHJvbCBpbnN0YW5jZW9mIEhUTUxFbGVtZW50KSkgcmV0dXJuO1xuICBpZiAoY29tcGFjdFNldHRpbmdzVGV4dChjb250cm9sLnRleHRDb250ZW50IHx8IFwiXCIpICE9PSBcIkJhY2sgdG8gYXBwXCIpIHJldHVybjtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJiYWNrLXRvLWFwcFwiKTtcbiAgfSwgMCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNlY3Rpb24oc2VjdGlvbjogU2V0dGluZ3NTZWN0aW9uKTogU2V0dGluZ3NIYW5kbGUge1xuICBjb25zdCByZWdpc3RyYXRpb25Ub2tlbiA9IFN5bWJvbChzZWN0aW9uLmlkKTtcbiAgc3RhdGUuc2VjdGlvbnMuc2V0KHNlY3Rpb24uaWQsIHNlY3Rpb24pO1xuICBzdGF0ZS5zZWN0aW9uVG9rZW5zLnNldChzZWN0aW9uLmlkLCByZWdpc3RyYXRpb25Ub2tlbik7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS5zZWN0aW9uVG9rZW5zLmdldChzZWN0aW9uLmlkKSAhPT0gcmVnaXN0cmF0aW9uVG9rZW4pIHJldHVybjtcbiAgICAgIHN0YXRlLnNlY3Rpb25zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIHN0YXRlLnNlY3Rpb25Ub2tlbnMuZGVsZXRlKHNlY3Rpb24uaWQpO1xuICAgICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU2VjdGlvbnMoKTogdm9pZCB7XG4gIHN0YXRlLnNlY3Rpb25zLmNsZWFyKCk7XG4gIHN0YXRlLnNlY3Rpb25Ub2tlbnMuY2xlYXIoKTtcbiAgLy8gRHJvcCByZWdpc3RlcmVkIHBhZ2VzIHRvbyBcdTIwMTQgdGhleSdyZSBvd25lZCBieSB0d2Vha3MgdGhhdCBqdXN0IGdvdFxuICAvLyB0b3JuIGRvd24gYnkgdGhlIGhvc3QuIFJ1biBhbnkgdGVhcmRvd25zIGJlZm9yZSBmb3JnZXR0aW5nIHRoZW0uXG4gIGZvciAoY29uc3QgcCBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIHRyeSB7XG4gICAgICBwLnRlYXJkb3duPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwbG9nKFwicGFnZSB0ZWFyZG93biBmYWlsZWRcIiwgeyBpZDogcC5pZCwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgfVxuICB9XG4gIHN0YXRlLnBhZ2VzLmNsZWFyKCk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIEV4cGxpY2l0IHBhZ2VzIG1heSBkaXNhcHBlYXIgYnJpZWZseSBkdXJpbmcgYSBob3QgcmVsb2FkLiBLZWVwIHRoZSBzdGFibGVcbiAgLy8gdHdlYWstbGV2ZWwgcGFnZSBhY3RpdmUgYW5kIHJlbmRlciBpdHMgZmFsbGJhY2sgaW5zdGVhZCBvZiBlamVjdGluZyB0aGVcbiAgLy8gdXNlciBmcm9tIFNldHRpbmdzLlxuICBpZiAoXG4gICAgc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiZcbiAgICAhc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbShzdGF0ZS5hY3RpdmVQYWdlLmlkKVxuICApIHtcbiAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIpIHtcbiAgICByZXJlbmRlcigpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG59XG5cbi8qKlxuICogUmVnaXN0ZXIgYSB0d2Vhay1vd25lZCBzZXR0aW5ncyBwYWdlLiBUaGUgcnVudGltZSBpbmplY3RzIGEgc2lkZWJhciBlbnRyeVxuICogdW5kZXIgYSBcIlRXRUFLU1wiIGdyb3VwIGhlYWRlciAod2hpY2ggYXBwZWFycyBvbmx5IHdoZW4gYXQgbGVhc3Qgb25lIHBhZ2VcbiAqIGlzIHJlZ2lzdGVyZWQpIGFuZCByb3V0ZXMgY2xpY2tzIHRvIHRoZSBwYWdlJ3MgYHJlbmRlcihyb290KWAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclBhZ2UoXG4gIHR3ZWFrSWQ6IHN0cmluZyxcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsXG4gIHBhZ2U6IFNldHRpbmdzUGFnZSxcbik6IFNldHRpbmdzSGFuZGxlIHtcbiAgY29uc3QgaWQgPSBwYWdlLmlkOyAvLyBhbHJlYWR5IG5hbWVzcGFjZWQgYnkgdHdlYWstaG9zdCBhcyBgJHt0d2Vha0lkfToke3BhZ2UuaWR9YFxuICBjb25zdCBleGlzdGluZyA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gIGlmIChleGlzdGluZykge1xuICAgIHRyeSB7IGV4aXN0aW5nLnRlYXJkb3duPy4oKTsgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHJlZ2lzdHJhdGlvblRva2VuID0gU3ltYm9sKGlkKTtcbiAgY29uc3QgZW50cnk6IFJlZ2lzdGVyZWRQYWdlID0geyBpZCwgdHdlYWtJZCwgbWFuaWZlc3QsIHBhZ2UsIHJlZ2lzdHJhdGlvblRva2VuIH07XG4gIHN0YXRlLnBhZ2VzLnNldChpZCwgZW50cnkpO1xuICBwbG9nKFwicmVnaXN0ZXJQYWdlXCIsIHsgaWQsIHRpdGxlOiBwYWdlLnRpdGxlLCB0d2Vha0lkIH0pO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICAvLyBJZiB0aGUgdXNlciB3YXMgYWxyZWFkeSBvbiB0aGlzIHBhZ2UgKGhvdCByZWxvYWQpLCByZS1tb3VudCBpdHMgYm9keS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IHR3ZWFrSWQpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgY29uc3QgZSA9IHN0YXRlLnBhZ2VzLmdldChpZCk7XG4gICAgICBpZiAoIWUgfHwgZS5yZWdpc3RyYXRpb25Ub2tlbiAhPT0gcmVnaXN0cmF0aW9uVG9rZW4pIHJldHVybjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGUudGVhcmRvd24/LigpO1xuICAgICAgfSBjYXRjaCB7fVxuICAgICAgc3RhdGUucGFnZXMuZGVsZXRlKGlkKTtcbiAgICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gdHdlYWtJZCkgcmVyZW5kZXIoKTtcbiAgICB9LFxuICB9O1xufVxuXG4vKiogQ2FsbGVkIGJ5IHRoZSB0d2VhayBob3N0IGFmdGVyIGZldGNoaW5nIHRoZSB0d2VhayBsaXN0IGZyb20gbWFpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRMaXN0ZWRUd2Vha3MobGlzdDogTGlzdGVkVHdlYWtbXSk6IHZvaWQge1xuICBzdGF0ZS5saXN0ZWRUd2Vha3MgPSBsaXN0O1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgIXNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oc3RhdGUuYWN0aXZlUGFnZS5pZCkpIHtcbiAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIpIHtcbiAgICByZXJlbmRlcigpO1xuICB9XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlTGlzdGVkVHdlYWtMaWZlY3ljbGUoaWQ6IHN0cmluZywgbGlmZWN5Y2xlOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW1wibGlmZWN5Y2xlXCJdLCBlcnJvcj86IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCB0d2VhayA9IHN0YXRlLmxpc3RlZFR3ZWFrcy5maW5kKChpdGVtKSA9PiBpdGVtLm1hbmlmZXN0LmlkID09PSBpZCk7XG4gIGlmICghdHdlYWspIHJldHVybjtcbiAgdHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGUgPSBsaWZlY3ljbGU7XG4gIGlmIChlcnJvcikgdHdlYWsuaGVhbHRoID0geyBzdGF0dXM6IGxpZmVjeWNsZSA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiIDogXCJmYWlsZWRcIiwgdXBkYXRlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIGVycm9yIH07XG4gIGVsc2UgaWYgKGxpZmVjeWNsZSA9PT0gXCJzdGFydGluZ1wiIHx8IGxpZmVjeWNsZSA9PT0gXCJlbmFibGVkXCIpIHR3ZWFrLmhlYWx0aCA9IG51bGw7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSBpZCkgcmVyZW5kZXIoKTtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbXMoKTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtdIHtcbiAgcmV0dXJuIGJ1aWxkU2V0dGluZ3NOYXZpZ2F0aW9uTW9kZWwoXG4gICAgc3RhdGUubGlzdGVkVHdlYWtzLm1hcCgodHdlYWspID0+ICh7XG4gICAgICBpZDogdHdlYWsubWFuaWZlc3QuaWQsXG4gICAgICBuYW1lOiB0d2Vhay5tYW5pZmVzdC5uYW1lLFxuICAgICAgdmVyc2lvbjogdHdlYWsubWFuaWZlc3QudmVyc2lvbixcbiAgICAgIGRlc2NyaXB0aW9uOiB0d2Vhay5tYW5pZmVzdC5kZXNjcmlwdGlvbixcbiAgICAgIGljb25Vcmw6IHR3ZWFrLm1hbmlmZXN0Lmljb25VcmwsXG4gICAgICBlbmFibGVkOiB0d2Vhay5lbmFibGVkLFxuICAgICAgc3RhdHVzOiB0d2Vhay5zdGF0dXMsXG4gICAgICBoZWFsdGhFcnJvcjogdHdlYWsuaGVhbHRoPy5lcnJvciA/PyBudWxsLFxuICAgICAgbGlmZWN5Y2xlT3ZlcnJpZGU6IHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlLFxuICAgIH0pKSxcbiAgICBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldLm1hcCgoZW50cnkpID0+ICh7XG4gICAgICBpZDogZW50cnkuaWQsXG4gICAgICB0d2Vha0lkOiBlbnRyeS50d2Vha0lkLFxuICAgICAgdGl0bGU6IGVudHJ5LnBhZ2UudGl0bGUsXG4gICAgICBkZXNjcmlwdGlvbjogZW50cnkucGFnZS5kZXNjcmlwdGlvbixcbiAgICAgIGljb25Tdmc6IGVudHJ5LnBhZ2UuaWNvblN2ZyxcbiAgICB9KSksXG4gICk7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzTmF2aWdhdGlvbkl0ZW0odHdlYWtJZDogc3RyaW5nKTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSB8IG51bGwge1xuICByZXR1cm4gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbXMoKS5maW5kKChpdGVtKSA9PiBpdGVtLnR3ZWFrSWQgPT09IHR3ZWFrSWQpID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlZ2lzdGVyZWRQYWdlc0ZvclR3ZWFrKHR3ZWFrSWQ6IHN0cmluZyk6IFJlZ2lzdGVyZWRQYWdlW10ge1xuICByZXR1cm4gWy4uLnN0YXRlLnBhZ2VzLnZhbHVlcygpXS5maWx0ZXIoKGVudHJ5KSA9PiBlbnRyeS50d2Vha0lkID09PSB0d2Vha0lkKTtcbn1cblxuZnVuY3Rpb24gbGlmZWN5Y2xlTGFiZWwobGlmZWN5Y2xlOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW1wibGlmZWN5Y2xlXCJdLCB3YXJuaW5nPzogc3RyaW5nIHwgbnVsbCk6IHN0cmluZyB7XG4gIGNvbnN0IGxhYmVsID0gbGlmZWN5Y2xlID09PSBcImVuYWJsZWRcIiA/IFwiUnVubmluZ1wiXG4gICAgOiBsaWZlY3ljbGUgPT09IFwidGltZWRfb3V0XCIgPyBcIlN0YXJ0dXAgdGltZWQgb3V0XCJcbiAgICA6IGxpZmVjeWNsZVswXS50b1VwcGVyQ2FzZSgpICsgbGlmZWN5Y2xlLnNsaWNlKDEpO1xuICByZXR1cm4gd2FybmluZyA/IGAke2xhYmVsfTogJHt3YXJuaW5nfWAgOiBsYWJlbDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGluamVjdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gdHJ5SW5qZWN0KCk6IHZvaWQge1xuICBpZiAoaXNOYXZHcm91cEluamVjdGlvblN1cHByZXNzZWQoKSkgcmV0dXJuO1xuICByZW1vdmVNaXNwbGFjZWRTZXR0aW5nc0dyb3VwcygpO1xuXG4gIGNvbnN0IGl0ZW1zR3JvdXAgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFpdGVtc0dyb3VwKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwic2lkZWJhciBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHtcbiAgICBjbGVhclRpbWVvdXQoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKTtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICB9XG4gIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodHJ1ZSwgXCJzaWRlYmFyLWZvdW5kXCIpO1xuICAvLyBLZWVwIG5hdGl2ZSBhbmQgVHdlYWtlcnMgZW50cmllcyBpbiB0aGUgc2FtZSBzY3JvbGwgY29udGFpbmVyLiBBcHBlbmRpbmdcbiAgLy8gdG8gdGhlIHBhcmVudCBjcmVhdGVkIGEgc2Vjb25kIGluZGVwZW5kZW50bHkgc2Nyb2xsaW5nIHNpZGViYXIgcmVnaW9uLlxuICBjb25zdCBvdXRlciA9IGl0ZW1zR3JvdXA7XG4gIGlmICghaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoaXRlbXNHcm91cCkpIHtcbiAgICBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpO1xuICAgIHBsb2coXCJyZWplY3RlZCBub24tc2V0dGluZ3Mgc2lkZWJhciBjYW5kaWRhdGVcIiwge1xuICAgICAgaXRlbXNHcm91cDogZGVzY3JpYmUoaXRlbXNHcm91cCksXG4gICAgICBvdXRlcjogZGVzY3JpYmUob3V0ZXIpLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG91dGVyO1xuICBzeW5jTmF0aXZlU2V0dGluZ3NIZWFkZXIoaXRlbXNHcm91cCwgb3V0ZXIpO1xuICBiaW5kU2V0dGluZ3NTZWFyY2gob3V0ZXIpO1xuXG4gIGlmIChzdGF0ZS5uYXZHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5uYXZHcm91cCkpIHtcbiAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgIC8vIENvZGV4IHJlLXJlbmRlcnMgaXRzIG5hdGl2ZSBzaWRlYmFyIGJ1dHRvbnMgb24gaXRzIG93biBzdGF0ZSBjaGFuZ2VzLlxuICAgIC8vIElmIG9uZSBvZiBvdXIgcGFnZXMgaXMgYWN0aXZlLCByZS1zdHJpcCBDb2RleCdzIGFjdGl2ZSBzdHlsaW5nIHNvXG4gICAgLy8gR2VuZXJhbCBkb2Vzbid0IHJlYXBwZWFyIGFzIHNlbGVjdGVkLlxuICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsKSBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2lkZWJhciB3YXMgZWl0aGVyIGZyZXNobHkgbW91bnRlZCAoU2V0dGluZ3MganVzdCBvcGVuZWQpIG9yIHJlLW1vdW50ZWRcbiAgLy8gKGNsb3NlZCBhbmQgcmUtb3BlbmVkLCBvciBuYXZpZ2F0ZWQgYXdheSBhbmQgYmFjaykuIEluIGFsbCBvZiB0aG9zZVxuICAvLyBjYXNlcyBDb2RleCByZXNldHMgdG8gaXRzIGRlZmF1bHQgcGFnZSAoR2VuZXJhbCksIGJ1dCBvdXIgaW4tbWVtb3J5XG4gIC8vIGBhY3RpdmVQYWdlYCBtYXkgc3RpbGwgcmVmZXJlbmNlIHRoZSBsYXN0IHR3ZWFrL3BhZ2UgdGhlIHVzZXIgaGFkIG9wZW5cbiAgLy8gXHUyMDE0IHdoaWNoIHdvdWxkIGNhdXNlIHRoYXQgbmF2IGJ1dHRvbiB0byByZW5kZXIgd2l0aCB0aGUgYWN0aXZlIHN0eWxpbmdcbiAgLy8gZXZlbiB0aG91Z2ggQ29kZXggaXMgc2hvd2luZyBHZW5lcmFsLiBDbGVhciBpdCBzbyBgc3luY1BhZ2VzR3JvdXBgIC9cbiAgLy8gYHNldE5hdkFjdGl2ZWAgc3RhcnQgZnJvbSBhIG5ldXRyYWwgc3RhdGUuIFRoZSBwYW5lbEhvc3QgcmVmZXJlbmNlIGlzXG4gIC8vIGFsc28gc3RhbGUgKGl0cyBET00gd2FzIGRpc2NhcmRlZCB3aXRoIHRoZSBwcmV2aW91cyBjb250ZW50IGFyZWEpLlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCB8fCBzdGF0ZS5wYW5lbEhvc3QgIT09IG51bGwpIHtcbiAgICBwbG9nKFwic2lkZWJhciByZS1tb3VudCBkZXRlY3RlZDsgY2xlYXJpbmcgc3RhbGUgYWN0aXZlIHN0YXRlXCIsIHtcbiAgICAgIHByZXZBY3RpdmU6IHN0YXRlLmFjdGl2ZVBhZ2UsXG4gICAgfSk7XG4gICAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gICAgc3RhdGUucGFuZWxIb3N0ID0gbnVsbDtcbiAgfVxuXG4gIGNvbnN0IGV4aXN0aW5nQ29kZXhQcE5hdkdyb3VwID1cbiAgICBvdXRlci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignOnNjb3BlID4gW2RhdGEtY29kZXhwcD1cIm5hdi1ncm91cFwiXScpID8/XG4gICAgb3V0ZXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLWNvZGV4cHA9XCJuYXYtZ3JvdXBcIl0nKTtcblxuICBpZiAoZXhpc3RpbmdDb2RleFBwTmF2R3JvdXApIHtcbiAgICBzdGF0ZS5uYXZHcm91cCA9IGV4aXN0aW5nQ29kZXhQcE5hdkdyb3VwO1xuICAgIHN0YXRlLmNvZGV4UGx1c1BsdXNVcGRhdGVCdXR0b24gPSBleGlzdGluZ0NvZGV4UHBOYXZHcm91cC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcbiAgICAgIFwiW2RhdGEtY29kZXhwcC1zaWRlYmFyLXVwZGF0ZV1cIixcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSb290ID0gb3V0ZXI7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICByZWZyZXNoU2lkZWJhckNvZGV4UGx1c1BsdXNVcGRhdGVCdXR0b24oKTtcbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFx1MjUwMFx1MjUwMCBHcm91cCBjb250YWluZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZ3JvdXAuZGF0YXNldC5jb2RleHBwID0gXCJuYXYtZ3JvdXBcIjtcbiAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuXG4gIGNvbnN0IHVwZGF0ZUJ1dHRvbiA9IHNpZGViYXJVcGRhdGVQaWxsQnV0dG9uKCk7XG4gIHN0YXRlLmNvZGV4UGx1c1BsdXNVcGRhdGVCdXR0b24gPSB1cGRhdGVCdXR0b247XG4gIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrZXJzXCIsIFwicHQtM1wiLCB1cGRhdGVCdXR0b24pKTtcbiAgcmVmcmVzaFNpZGViYXJDb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uKCk7XG5cbiAgLy8gXHUyNTAwXHUyNTAwIFNpZGViYXIgaXRlbXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gIGNvbnN0IGNvbmZpZ0J0biA9IG1ha2VTaWRlYmFySXRlbShcIkNvbmZpZ1wiLCBjb25maWdJY29uU3ZnKCkpO1xuICBjb25zdCB0d2Vha3NCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJUd2Vha3NcIiwgdHdlYWtzSWNvblN2ZygpKTtcblxuICBjb25maWdCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJjb25maWdcIiB9KTtcbiAgfSk7XG4gIHR3ZWFrc0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInR3ZWFrc1wiIH0pO1xuICB9KTtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoY29uZmlnQnRuKTtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQodHdlYWtzQnRuKTtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuXG4gIHN0YXRlLm5hdkdyb3VwID0gZ3JvdXA7XG4gIHN0YXRlLm5hdkJ1dHRvbnMgPSB7IGNvbmZpZzogY29uZmlnQnRuLCB0d2Vha3M6IHR3ZWFrc0J0biB9O1xuICBub3RlTmF2R3JvdXBJbmplY3Rpb24ob3V0ZXIpO1xuICBzeW5jUGFnZXNHcm91cCgpO1xufVxuXG4vLyBCYWNrc3RvcCBhZ2FpbnN0IGluamVjdC9yZW1vdmUgZmVlZGJhY2sgbG9vcHM6IGlmIHRoZSBuYXYgZ3JvdXAgbmVlZHNcbi8vIHJlLWluamVjdGlvbiBtb3JlIHRoYW4gYSBmZXcgdGltZXMgaW4gYSBzaG9ydCB3aW5kb3csIHNvbWV0aGluZyBpc1xuLy8gZmlnaHRpbmcgdXMgXHUyMDE0IGJhY2sgb2ZmIGluc3RlYWQgb2Ygc2F0dXJhdGluZyB0aGUgbG9nIGFuZCB0aGUgQ1BVLlxuY29uc3QgTkFWX0dST1VQX0lOSkVDVElPTl9XSU5ET1dfTVMgPSAxMF8wMDA7XG5jb25zdCBOQVZfR1JPVVBfSU5KRUNUSU9OX0xJTUlUID0gNTtcbmNvbnN0IE5BVl9HUk9VUF9JTkpFQ1RJT05fQkFDS09GRl9NUyA9IDMwXzAwMDtcbmxldCBuYXZHcm91cEluamVjdGlvbnM6IG51bWJlcltdID0gW107XG5sZXQgbmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkVW50aWwgPSAwO1xuXG5mdW5jdGlvbiBpc05hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIERhdGUubm93KCkgPCBuYXZHcm91cEluamVjdGlvblN1cHByZXNzZWRVbnRpbDtcbn1cblxuZnVuY3Rpb24gbm90ZU5hdkdyb3VwSW5qZWN0aW9uKG91dGVyOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBuYXZHcm91cEluamVjdGlvbnMgPSBuYXZHcm91cEluamVjdGlvbnMuZmlsdGVyKChhdCkgPT4gbm93IC0gYXQgPCBOQVZfR1JPVVBfSU5KRUNUSU9OX1dJTkRPV19NUyk7XG4gIG5hdkdyb3VwSW5qZWN0aW9ucy5wdXNoKG5vdyk7XG4gIGlmIChuYXZHcm91cEluamVjdGlvbnMubGVuZ3RoID4gTkFWX0dST1VQX0lOSkVDVElPTl9MSU1JVCkge1xuICAgIG5hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZFVudGlsID0gbm93ICsgTkFWX0dST1VQX0lOSkVDVElPTl9CQUNLT0ZGX01TO1xuICAgIG5hdkdyb3VwSW5qZWN0aW9ucyA9IFtdO1xuICAgIHBsb2coXCJuYXYgZ3JvdXAgcmUtaW5qZWN0aW9uIGxvb3AgZGV0ZWN0ZWQ7IGJhY2tpbmcgb2ZmXCIsIHtcbiAgICAgIGJhY2tvZmZNczogTkFWX0dST1VQX0lOSkVDVElPTl9CQUNLT0ZGX01TLFxuICAgICAgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUsXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHBsb2coXCJuYXYgZ3JvdXAgaW5qZWN0ZWRcIiwgeyBvdXRlclRhZzogb3V0ZXIudGFnTmFtZSB9KTtcbn1cblxuZnVuY3Rpb24gc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXA6IEhUTUxFbGVtZW50LCBvdXRlcjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5uYXRpdmVOYXZIZWFkZXIpKSByZXR1cm47XG5cbiAgY29uc3QgaGVhZGVyID0gc2lkZWJhckdyb3VwSGVhZGVyKFwiR2VuZXJhbFwiKTtcbiAgaGVhZGVyLmRhdGFzZXQuY29kZXhwcCA9IFwibmF0aXZlLW5hdi1oZWFkZXJcIjtcbiAgaWYgKG91dGVyID09PSBpdGVtc0dyb3VwKSBvdXRlci5wcmVwZW5kKGhlYWRlcik7XG4gIGVsc2Ugb3V0ZXIuaW5zZXJ0QmVmb3JlKGhlYWRlciwgaXRlbXNHcm91cCk7XG4gIHN0YXRlLm5hdGl2ZU5hdkhlYWRlciA9IGhlYWRlcjtcbn1cblxuZnVuY3Rpb24gYmluZFNldHRpbmdzU2VhcmNoKHJvb3Q6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IGlucHV0ID0gcm9vdC5jbG9zZXN0KFwiYXNpZGUsIG5hdiwgW3JvbGU9J25hdmlnYXRpb24nXSwgZGl2XCIpPy5wYXJlbnRFbGVtZW50XG4gICAgPy5xdWVyeVNlbGVjdG9yPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbcGxhY2Vob2xkZXIqPSdTZWFyY2ggc2V0dGluZ3MnIGldXCIpXG4gICAgPz8gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W3BsYWNlaG9sZGVyKj0nU2VhcmNoIHNldHRpbmdzJyBpXVwiKTtcbiAgaWYgKCFpbnB1dCB8fCBpbnB1dC5kYXRhc2V0LnR3ZWFrZXJzU2VhcmNoQm91bmQgPT09IFwidHJ1ZVwiKSByZXR1cm47XG4gIGlucHV0LmRhdGFzZXQudHdlYWtlcnNTZWFyY2hCb3VuZCA9IFwidHJ1ZVwiO1xuICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgIGNvbnN0IHF1ZXJ5ID0gaW5wdXQudmFsdWUudHJpbSgpLnRvTG9jYWxlTG93ZXJDYXNlKCk7XG4gICAgZm9yIChjb25zdCBidXR0b24gb2YgQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKSkge1xuICAgICAgaWYgKCFidXR0b24uY2xvc2VzdChcIltkYXRhLWNvZGV4cHBdXCIpKSBjb250aW51ZTtcbiAgICAgIGJ1dHRvbi5oaWRkZW4gPSAhIXF1ZXJ5ICYmICFjb21wYWN0U2V0dGluZ3NUZXh0KGJ1dHRvbi50ZXh0Q29udGVudCA/PyBcIlwiKS50b0xvY2FsZUxvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBncm91cCBvZiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwPSduYXYtZ3JvdXAnXSwgW2RhdGEtY29kZXhwcD0ncGFnZXMtZ3JvdXAnXVwiKSkpIHtcbiAgICAgIGNvbnN0IGJ1dHRvbnMgPSBBcnJheS5mcm9tKGdyb3VwLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgICAgIGdyb3VwLmhpZGRlbiA9IGJ1dHRvbnMubGVuZ3RoID4gMCAmJiBidXR0b25zLmV2ZXJ5KChidXR0b24pID0+IGJ1dHRvbi5oaWRkZW4pO1xuICAgIH1cbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJHcm91cEhlYWRlcih0ZXh0OiBzdHJpbmcsIHRvcFBhZGRpbmcgPSBcInB0LTJcIiwgdHJhaWxpbmc/OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9XG4gICAgYHB4LXJvdy14ICR7dG9wUGFkZGluZ30gcGItMSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdXBwZXJjYXNlIHRyYWNraW5nLXdpZGVyIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBzZWxlY3Qtbm9uZWA7XG4gIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGxhYmVsLmNsYXNzTmFtZSA9IFwidHJ1bmNhdGVcIjtcbiAgbGFiZWwudGV4dENvbnRlbnQgPSB0ZXh0O1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICBpZiAodHJhaWxpbmcpIGhlYWRlci5hcHBlbmRDaGlsZCh0cmFpbGluZyk7XG4gIHJldHVybiBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgfHwgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gICAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICAgIGlmIChzaWRlYmFyICYmIGlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKHNpZGViYXIpKSByZXR1cm47XG4gICAgaWYgKGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpKSByZXR1cm47XG4gICAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShmYWxzZSwgXCJzaWRlYmFyLW5vdC1mb3VuZFwiKTtcbiAgfSwgMTUwMCk7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NUZXh0VmlzaWJsZSgpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzQ29kZXhQcFNldHRpbmdzTGFiZWxTZXQoY29kZXhQcFNldHRpbmdzTGFiZWxzRnJvbShkb2N1bWVudCkpO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuY29uc3QgQ09ERVhQUF9DT1JFX1NFVFRJTkdTX0xBQkVMUyA9IFtcbiAgXCJHZW5lcmFsXCIsXG4gIFwiXHU1RTM4XHU4OUM0XCIsXG4gIFwiXHU5MDFBXHU3NTI4XCIsXG4gIFwiQXBwZWFyYW5jZVwiLFxuICBcIlx1NTkxNlx1ODlDMlwiLFxuICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgXCJcdTkxNERcdTdGNkVcIixcbiAgXCJcdTlFRDhcdThCQTRcdTY3NDNcdTk2NTBcIixcbiAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgXCJcdTRFMkFcdTYwMjdcdTUzMTZcIixcbl0ubWFwKG5vcm1hbGl6ZUNvZGV4UHBTZXR0aW5nc0xhYmVsKTtcblxuY29uc3QgQ09ERVhQUF9FWFRFTkRFRF9TRVRUSU5HU19MQUJFTFMgPSBbXG4gIFwiQWNjb3VudFwiLFxuICBcIlx1OEQyNlx1NjIzN1wiLFxuICBcIlx1OEQyNlx1NTNGN1wiLFxuICBcIkdlbmVyYWxcIixcbiAgXCJcdTVFMzhcdTg5QzRcIixcbiAgXCJcdTkwMUFcdTc1MjhcIixcbiAgXCJBcHBlYXJhbmNlXCIsXG4gIFwiXHU1OTE2XHU4OUMyXCIsXG4gIFwiQ29uZmlndXJhdGlvblwiLFxuICBcIlx1OTE0RFx1N0Y2RVwiLFxuICBcIlx1OUVEOFx1OEJBNFx1Njc0M1x1OTY1MFwiLFxuICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICBcIlx1NEUyQVx1NjAyN1x1NTMxNlwiLFxuICBcIktleWJvYXJkIHNob3J0Y3V0c1wiLFxuICBcIkFyY2hpdmVkIGNoYXRzXCIsXG4gIFwiVXNhZ2VcIixcbiAgXCJDb21wdXRlciB1c2VcIixcbiAgXCJCcm93c2VyIHVzZVwiLFxuICBcIk1DUCBzZXJ2ZXJzXCIsXG4gIFwiTUNQIFNlcnZlcnNcIixcbiAgXCJNQ1AgXHU2NzBEXHU1MkExXHU1NjY4XCIsXG4gIFwiR2l0XCIsXG4gIFwiRW52aXJvbm1lbnRzXCIsXG4gIFwiXHU3M0FGXHU1ODgzXCIsXG4gIFwiQ2xvdWQgRW52aXJvbm1lbnRzXCIsXG4gIFwiV29ya3RyZWVzXCIsXG4gIFwiQ29ubmVjdGlvbnNcIixcbiAgXCJQbHVnaW5zXCIsXG4gIFwiU2tpbGxzXCIsXG5dLm1hcChub3JtYWxpemVDb2RleFBwU2V0dGluZ3NMYWJlbCk7XG5cbmNvbnN0IENPREVYUFBfU0VUVElOR1NfT05MWV9MQUJFTFMgPSBbXG4gIFwiR2VuZXJhbFwiLFxuICBcIlx1NUUzOFx1ODlDNFwiLFxuICBcIlx1OTAxQVx1NzUyOFwiLFxuICBcIkFwcGVhcmFuY2VcIixcbiAgXCJcdTU5MTZcdTg5QzJcIixcbiAgXCJDb25maWd1cmF0aW9uXCIsXG4gIFwiXHU5MTREXHU3RjZFXCIsXG4gIFwiXHU5RUQ4XHU4QkE0XHU2NzQzXHU5NjUwXCIsXG4gIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gIFwiXHU0RTJBXHU2MDI3XHU1MzE2XCIsXG4gIFwiS2V5Ym9hcmQgc2hvcnRjdXRzXCIsXG4gIFwiQXJjaGl2ZWQgY2hhdHNcIixcbiAgXCJVc2FnZVwiLFxuICBcIkNvbXB1dGVyIHVzZVwiLFxuICBcIkJyb3dzZXIgdXNlXCIsXG4gIFwiTUNQIHNlcnZlcnNcIixcbiAgXCJNQ1AgU2VydmVyc1wiLFxuICBcIk1DUCBcdTY3MERcdTUyQTFcdTU2NjhcIixcbiAgXCJHaXRcIixcbiAgXCJFbnZpcm9ubWVudHNcIixcbiAgXCJcdTczQUZcdTU4ODNcIixcbiAgXCJDbG91ZCBFbnZpcm9ubWVudHNcIixcbiAgXCJXb3JrdHJlZXNcIixcbiAgXCJDb25uZWN0aW9uc1wiLFxuXS5tYXAobm9ybWFsaXplQ29kZXhQcFNldHRpbmdzTGFiZWwpO1xuXG5jb25zdCBDT0RFWFBQX01BSU5fQVBQX05BVl9MQUJFTFMgPSBbXG4gIFwiTmV3IGNoYXRcIixcbiAgXCJRdWljayBjaGF0XCIsXG4gIFwiXHU1RkVCXHU5MDFGXHU1QkY5XHU4QkREXCIsXG4gIFwiU2VhcmNoXCIsXG4gIFwiXHU2NDFDXHU3RDIyXCIsXG4gIFwiUGx1Z2luc1wiLFxuICBcIlx1NjNEMlx1NEVGNlwiLFxuICBcIkF1dG9tYXRpb25zXCIsXG4gIFwiQXV0b21hdGlvblwiLFxuICBcIlx1ODFFQVx1NTJBOFx1NTMxNlwiLFxuICBcIkNoYXRzXCIsXG4gIFwiQ2hhdFwiLFxuICBcIlx1NUJGOVx1OEJERFwiLFxuICBcIlByb2plY3RzXCIsXG4gIFwiXHU5ODc5XHU3NkVFXCIsXG4gIFwiUGlubmVkXCIsXG4gIFwiU2V0dGluZ3NcIixcbiAgXCJcdThCQkVcdTdGNkVcIixcbiAgXCJXb3JrIGxvY2FsbHlcIixcbl0ubWFwKG5vcm1hbGl6ZUNvZGV4UHBTZXR0aW5nc0xhYmVsKTtcblxuZnVuY3Rpb24gbm9ybWFsaXplQ29kZXhQcFNldHRpbmdzTGFiZWwodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlKVxuICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9bXHUyMDE5XHUyMDE4YFx1MDBCNF0vZywgXCInXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gY29kZXhQcENvbnRyb2xMYWJlbChlbDogSFRNTEVsZW1lbnQpOiBzdHJpbmcge1xuICByZXR1cm4gbm9ybWFsaXplQ29kZXhQcFNldHRpbmdzTGFiZWwoXG4gICAgZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fFxuICAgICAgZWwuZ2V0QXR0cmlidXRlKFwidGl0bGVcIikgfHxcbiAgICAgIGVsLnRleHRDb250ZW50IHx8XG4gICAgICBcIlwiLFxuICApO1xufVxuXG5mdW5jdGlvbiBjb2RleFBwU2V0dGluZ3NMYWJlbHNGcm9tKHJvb3Q6IFBhcmVudE5vZGUpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGNvbnRyb2xzID0gQXJyYXkuZnJvbShcbiAgICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYnV0dG9uLGEsW3JvbGU9J2J1dHRvbiddLFtyb2xlPSdsaW5rJ11cIiksXG4gICk7XG5cbiAgcmV0dXJuIFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgY29udHJvbHNcbiAgICAgICAgLm1hcChjb2RleFBwQ29udHJvbExhYmVsKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICksXG4gIF07XG59XG5cbmZ1bmN0aW9uIGNvZGV4UHBTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzOiBzdHJpbmdbXSk6IHsgY29yZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0ge1xuICBjb25zdCBjb3JlID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHRvdGFsID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBDT0RFWFBQX0NPUkVfU0VUVElOR1NfTEFCRUxTKSB7XG4gICAgICBpZiAoY29kZXhQcExhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgY29yZS5hZGQobWFya2VyKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBDT0RFWFBQX0VYVEVOREVEX1NFVFRJTkdTX0xBQkVMUykge1xuICAgICAgaWYgKGNvZGV4UHBMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWwsIG1hcmtlcikpIHRvdGFsLmFkZChtYXJrZXIpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGNvcmU6IGNvcmUuc2l6ZSwgdG90YWw6IHRvdGFsLnNpemUgfTtcbn1cblxuZnVuY3Rpb24gY29kZXhQcExhYmVsTWF0Y2hlc01hcmtlcihsYWJlbDogc3RyaW5nLCBtYXJrZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gbGFiZWwgPT09IG1hcmtlciB8fCBsYWJlbC5pbmNsdWRlcyhtYXJrZXIpO1xufVxuXG5mdW5jdGlvbiBjb2RleFBwTWFya2VyQ291bnQobGFiZWxzOiBzdHJpbmdbXSwgbWFya2Vyczogc3RyaW5nW10pOiBudW1iZXIge1xuICBjb25zdCBtYXRjaGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGFiZWwgb2YgbGFiZWxzKSB7XG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xuICAgICAgaWYgKGNvZGV4UHBMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWwsIG1hcmtlcikpIG1hdGNoZWQuYWRkKG1hcmtlcik7XG4gICAgfVxuICB9XG4gIHJldHVybiBtYXRjaGVkLnNpemU7XG59XG5cbmZ1bmN0aW9uIGhhc0NvZGV4UHBTZXR0aW5nc09ubHlTaWduYWwobGFiZWxzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gY29kZXhQcE1hcmtlckNvdW50KGxhYmVscywgQ09ERVhQUF9TRVRUSU5HU19PTkxZX0xBQkVMUykgPiAwO1xufVxuXG5mdW5jdGlvbiBoYXNNYWluQXBwU2lkZWJhclNpZ25hbHMobGFiZWxzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gY29kZXhQcE1hcmtlckNvdW50KGxhYmVscywgQ09ERVhQUF9NQUlOX0FQUF9OQVZfTEFCRUxTKSA+PSAyO1xufVxuXG5mdW5jdGlvbiBpc0NvZGV4UHBTZXR0aW5nc0xhYmVsU2V0KGxhYmVsczogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgY29uc3Qgc2NvcmUgPSBjb2RleFBwU2V0dGluZ3NMYWJlbFNjb3JlKGxhYmVscyk7XG4gIHJldHVybiBzY29yZS5jb3JlID49IDIgJiYgc2NvcmUudG90YWwgPj0gMztcbn1cblxuZnVuY3Rpb24gY29kZXhQcFZpc2libGVCb3goZWw6IEhUTUxFbGVtZW50KTogRE9NUmVjdCB8IG51bGwge1xuICBpZiAoIWVsLmlzQ29ubmVjdGVkKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3R5bGUgPSBnZXRDb21wdXRlZFN0eWxlKGVsKTtcbiAgaWYgKHN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiIHx8IHN0eWxlLnZpc2liaWxpdHkgPT09IFwiaGlkZGVuXCIpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHJlY3QgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgaWYgKHJlY3Qud2lkdGggPD0gMCB8fCByZWN0LmhlaWdodCA8PSAwKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHJlY3Q7XG59XG5cbmZ1bmN0aW9uIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUodmlzaWJsZTogYm9vbGVhbiwgcmVhc29uOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgPT09IHZpc2libGUpIHJldHVybjtcbiAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gIGlmICh2aXNpYmxlKSB3YXJtVHdlYWtTdG9yZSgpO1xuICB0cnkge1xuICAgICh3aW5kb3cgYXMgV2luZG93ICYgeyBfX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlPzogYm9vbGVhbiB9KS5fX2NvZGV4cHBTZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgICBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuZGF0YXNldC5jb2RleHBwU2V0dGluZ3NTdXJmYWNlID0gdmlzaWJsZSA/IFwidHJ1ZVwiIDogXCJmYWxzZVwiO1xuICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KFxuICAgICAgbmV3IEN1c3RvbUV2ZW50KFwiY29kZXhwcDpzZXR0aW5ncy1zdXJmYWNlXCIsIHtcbiAgICAgICAgZGV0YWlsOiB7IHZpc2libGUsIHJlYXNvbiB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfSBjYXRjaCB7fVxuICBwbG9nKFwic2V0dGluZ3Mgc3VyZmFjZVwiLCB7IHZpc2libGUsIHJlYXNvbiwgdXJsOiBsb2NhdGlvbi5ocmVmIH0pO1xufVxuXG4vKipcbiAqIFJlbmRlciAob3IgcmUtcmVuZGVyKSB0aGUgc2Vjb25kIHNpZGViYXIgZ3JvdXAgb2YgcGVyLXR3ZWFrIHBhZ2VzLiBUaGVcbiAqIGdyb3VwIGlzIGNyZWF0ZWQgbGF6aWx5IGFuZCByZW1vdmVkIHdoZW4gdGhlIGxhc3QgcGFnZSB1bnJlZ2lzdGVycywgc29cbiAqIHVzZXJzIHdpdGggbm8gcGFnZS1yZWdpc3RlcmluZyB0d2Vha3MgbmV2ZXIgc2VlIGFuIGVtcHR5IFwiVHdlYWtzXCIgaGVhZGVyLlxuICovXG5mdW5jdGlvbiBzeW5jUGFnZXNHcm91cCgpOiB2b2lkIHtcbiAgY29uc3Qgb3V0ZXIgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKCFvdXRlcikgcmV0dXJuO1xuICBpZiAoIWlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKG91dGVyKSkge1xuICAgIHN0YXRlLnNpZGViYXJSb290ID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwYWdlcyA9IHNldHRpbmdzTmF2aWdhdGlvbkl0ZW1zKCk7XG5cbiAgLy8gQnVpbGQgYSBkZXRlcm1pbmlzdGljIGZpbmdlcnByaW50IG9mIHRoZSBkZXNpcmVkIGdyb3VwIHN0YXRlLiBJZiB0aGVcbiAgLy8gY3VycmVudCBET00gZ3JvdXAgYWxyZWFkeSBtYXRjaGVzLCB0aGlzIGlzIGEgbm8tb3AgXHUyMDE0IGNyaXRpY2FsLCBiZWNhdXNlXG4gIC8vIHN5bmNQYWdlc0dyb3VwIGlzIGNhbGxlZCBvbiBldmVyeSBNdXRhdGlvbk9ic2VydmVyIHRpY2sgYW5kIGFueSBET01cbiAgLy8gd3JpdGUgd291bGQgcmUtdHJpZ2dlciB0aGF0IG9ic2VydmVyIChpbmZpbml0ZSBsb29wLCBhcHAgZnJlZXplKS5cbiAgY29uc3QgZGVzaXJlZEtleSA9IHBhZ2VzLmxlbmd0aCA9PT0gMFxuICAgID8gXCJFTVBUWVwiXG4gICAgOiBwYWdlcy5tYXAoKHApID0+IGAke3AudHdlYWtJZH18JHtwLnRpdGxlfXwke3AuaWNvblN2ZyA/PyBcIlwifXwke3AubGlmZWN5Y2xlfWApLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IGdyb3VwQXR0YWNoZWQgPSAhIXN0YXRlLnBhZ2VzR3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCk7XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwS2V5ID09PSBkZXNpcmVkS2V5ICYmIChwYWdlcy5sZW5ndGggPT09IDAgPyAhZ3JvdXBBdHRhY2hlZCA6IGdyb3VwQXR0YWNoZWQpKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHBhZ2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwKSB7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwLnJlbW92ZSgpO1xuICAgICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgfVxuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gICAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgbGV0IGdyb3VwID0gc3RhdGUucGFnZXNHcm91cDtcbiAgaWYgKCFncm91cCB8fCAhb3V0ZXIuY29udGFpbnMoZ3JvdXApKSB7XG4gICAgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGdyb3VwLmRhdGFzZXQuY29kZXhwcCA9IFwicGFnZXMtZ3JvdXBcIjtcbiAgICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiVHdlYWtzXCIsIFwicHQtM1wiKSk7XG4gICAgb3V0ZXIuYXBwZW5kQ2hpbGQoZ3JvdXApO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBncm91cDtcbiAgfSBlbHNlIHtcbiAgICAvLyBTdHJpcCBwcmlvciBidXR0b25zIChrZWVwIHRoZSBoZWFkZXIgYXQgaW5kZXggMCkuXG4gICAgd2hpbGUgKGdyb3VwLmNoaWxkcmVuLmxlbmd0aCA+IDEpIGdyb3VwLnJlbW92ZUNoaWxkKGdyb3VwLmxhc3RDaGlsZCEpO1xuICB9XG5cbiAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhZ2VzKSB7XG4gICAgY29uc3QgaWNvbiA9IHAuaWNvblN2ZyA/PyBkZWZhdWx0UGFnZUljb25TdmcoKTtcbiAgICBjb25zdCBidG4gPSBtYWtlU2lkZWJhckl0ZW0ocC50aXRsZSwgaWNvbik7XG4gICAgYnRuLmRhdGFzZXQuY29kZXhwcCA9IGBuYXYtcGFnZS0ke3AudHdlYWtJZH1gO1xuICAgIGJ0bi5kYXRhc2V0LmNvZGV4cHBMaWZlY3ljbGUgPSBwLmxpZmVjeWNsZTtcbiAgICBpZiAocC5saWZlY3ljbGUgIT09IFwiZW5hYmxlZFwiKSBidG4udGl0bGUgPSBsaWZlY3ljbGVMYWJlbChwLmxpZmVjeWNsZSwgcC53YXJuaW5nKTtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJyZWdpc3RlcmVkXCIsIGlkOiBwLnR3ZWFrSWQgfSk7XG4gICAgfSk7XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuc2V0KHAudHdlYWtJZCwgYnRuKTtcbiAgICBncm91cC5hcHBlbmRDaGlsZChidG4pO1xuICB9XG4gIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICBwbG9nKFwicGFnZXMgZ3JvdXAgc3luY2VkXCIsIHtcbiAgICBjb3VudDogcGFnZXMubGVuZ3RoLFxuICAgIGlkczogcGFnZXMubWFwKChwKSA9PiBwLnR3ZWFrSWQpLFxuICB9KTtcbiAgLy8gUmVmbGVjdCBjdXJyZW50IGFjdGl2ZSBzdGF0ZSBhY3Jvc3MgdGhlIHJlYnVpbHQgYnV0dG9ucy5cbiAgc2V0TmF2QWN0aXZlKHN0YXRlLmFjdGl2ZVBhZ2UpO1xufVxuXG4vLyBGb3JjZSBhbnkgaW5qZWN0ZWQgaWNvbiBTVkcgdG8gYSBmaXhlZCBib3guIFR3ZWFrLXByb3ZpZGVkIGljb25TdmcgbWFya3VwIG1heVxuLy8gb21pdCB3aWR0aC9oZWlnaHQgKGFuZCB2aWV3Qm94IGFsb25lIGxldHMgYW4gU1ZHIGV4cGFuZCB0byBpdHMgaW50cmluc2ljIHNpemUsXG4vLyB3aGljaCByZW5kZXJlZCBhIHBhZ2UgaWNvbiBhcyBhIGdpYW50IGdseXBoKS4gSW5saW5lIHN0eWxlcyBiZWF0IGNvbmZsaWN0aW5nXG4vLyBhdHRyaWJ1dGVzL0NTUywgc28gdGhpcyBjYW5ub3QgYmUgZGVmZWF0ZWQgYnkgdGhlIHR3ZWFrJ3Mgb3duIG1hcmt1cC5cbmZ1bmN0aW9uIGNvbnN0cmFpblNpZGViYXJJY29uU3ZnKGljb246IEVsZW1lbnQgfCBudWxsIHwgdW5kZWZpbmVkLCBzaXplID0gMjApOiB2b2lkIHtcbiAgaWYgKCFpY29uKSByZXR1cm47XG4gIGljb24uc2V0QXR0cmlidXRlKFwid2lkdGhcIiwgU3RyaW5nKHNpemUpKTtcbiAgaWNvbi5zZXRBdHRyaWJ1dGUoXCJoZWlnaHRcIiwgU3RyaW5nKHNpemUpKTtcbiAgY29uc3Qgc3R5bGUgPSAoaWNvbiBhcyB1bmtub3duIGFzIHsgc3R5bGU/OiBDU1NTdHlsZURlY2xhcmF0aW9uIH0pLnN0eWxlO1xuICBpZiAoc3R5bGUpIHtcbiAgICBzdHlsZS53aWR0aCA9IGAke3NpemV9cHhgO1xuICAgIHN0eWxlLmhlaWdodCA9IGAke3NpemV9cHhgO1xuICAgIHN0eWxlLmZsZXhTaHJpbmsgPSBcIjBcIjtcbiAgfVxuICAoaWNvbiBhcyBFbGVtZW50KS5jbGFzc0xpc3Q/LmFkZChcImljb24tc21cIiwgXCJpbmxpbmUtYmxvY2tcIiwgXCJzaHJpbmstMFwiLCBcImFsaWduLW1pZGRsZVwiKTtcbn1cblxuZnVuY3Rpb24gbWFrZVNpZGViYXJJdGVtKGxhYmVsOiBzdHJpbmcsIGljb25Tdmc6IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgLy8gQ2xhc3Mgc3RyaW5nIGNvcGllZCB2ZXJiYXRpbSBmcm9tIENvZGV4J3Mgc2lkZWJhciBidXR0b25zIChHZW5lcmFsIGV0YykuXG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmRhdGFzZXQuY29kZXhwcCA9IGBuYXYtJHtsYWJlbC50b0xvd2VyQ2FzZSgpfWA7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJmb2N1cy12aXNpYmxlOm91dGxpbmUtdG9rZW4tYm9yZGVyIHJlbGF0aXZlIHB4LXJvdy14IHB5LXJvdy15IGN1cnNvci1pbnRlcmFjdGlvbiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgdGV4dC1sZWZ0IHRleHQtc20gZm9jdXMtdmlzaWJsZTpvdXRsaW5lIGZvY3VzLXZpc2libGU6b3V0bGluZS0yIGZvY3VzLXZpc2libGU6b3V0bGluZS1vZmZzZXQtMiBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS01MCBnYXAtMiBmbGV4IHctZnVsbCBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9udC1ub3JtYWxcIjtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIHRleHQtYmFzZSBnYXAtMiBmbGV4LTEgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGlubmVyLmlubmVySFRNTCA9IGAke2ljb25Tdmd9PHNwYW4gY2xhc3M9XCJ0cnVuY2F0ZVwiPiR7bGFiZWx9PC9zcGFuPmA7XG4gIGNvbnN0cmFpblNpZGViYXJJY29uU3ZnKGlubmVyLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIikpO1xuICBidG4uYXBwZW5kQ2hpbGQoaW5uZXIpO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRTaWRlYmFyU3RvcmVVcGRhdGVCYWRnZShidG46IEhUTUxCdXR0b25FbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IGlubmVyID0gYnRuLmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKCFpbm5lcikgcmV0dXJuO1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5kYXRhc2V0LmNvZGV4cHBTdG9yZVVwZGF0ZUJhZGdlID0gXCJ0cnVlXCI7XG4gIGJhZGdlLmhpZGRlbiA9IHRydWU7XG4gIGJhZGdlLnRpdGxlID0gXCJJbnN0YWxsZWQgdHdlYWtzIHdpdGggYXBwcm92ZWQgdXBkYXRlc1wiO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlclwiO1xuICBPYmplY3QuYXNzaWduKGJhZGdlLnN0eWxlLCB7XG4gICAgcG9zaXRpb246IFwiYWJzb2x1dGVcIixcbiAgICByaWdodDogXCIxMnB4XCIsXG4gICAgdG9wOiBcIjUwJVwiLFxuICAgIHRyYW5zZm9ybTogXCJ0cmFuc2xhdGVZKC01MCUpXCIsXG4gICAgekluZGV4OiBcIjFcIixcbiAgfSk7XG4gIGFwcGx5U3RvcmVVcGRhdGVCYWRnZVN0eWxlKGJhZGdlLCBudWxsKTtcbiAgYnRuLmFwcGVuZENoaWxkKGJhZGdlKTtcbn1cblxuLyoqIEludGVybmFsIGtleSBmb3IgdGhlIGJ1aWx0LWluIG5hdiBidXR0b25zLiAqL1xudHlwZSBCdWlsdGluUGFnZSA9IFwiY29uZmlnXCIgfCBcInR3ZWFrc1wiIHwgXCJzdG9yZVwiO1xuXG5mdW5jdGlvbiBzZXROYXZBY3RpdmUoYWN0aXZlOiBBY3RpdmVQYWdlIHwgbnVsbCk6IHZvaWQge1xuICAvLyBCdWlsdC1pbiAoQ29uZmlnL1R3ZWFrcykgYnV0dG9ucy5cbiAgaWYgKHN0YXRlLm5hdkJ1dHRvbnMpIHtcbiAgICBjb25zdCBidWlsdGluOiBCdWlsdGluUGFnZSB8IG51bGwgPVxuICAgICAgYWN0aXZlPy5raW5kID09PSBcImNvbmZpZ1wiID8gXCJjb25maWdcIiA6XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwidHdlYWtzXCIgPyBcInR3ZWFrc1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJzdG9yZVwiID8gXCJzdG9yZVwiIDogbnVsbDtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGJ0bl0gb2YgT2JqZWN0LmVudHJpZXMoc3RhdGUubmF2QnV0dG9ucykgYXMgW0J1aWx0aW5QYWdlLCBIVE1MQnV0dG9uRWxlbWVudF1bXSkge1xuICAgICAgYXBwbHlOYXZBY3RpdmUoYnRuLCBrZXkgPT09IGJ1aWx0aW4pO1xuICAgIH1cbiAgfVxuICAvLyBPbmUgc3RhYmxlIGJ1dHRvbiBwZXIgZW5hYmxlZCB0d2VhaywgcmVnYXJkbGVzcyBvZiBob3cgbWFueSBzZWN0aW9ucyBpdFxuICAvLyByZWdpc3RlcmVkIG9yIHdoZXRoZXIgc3RhcnR1cCByZWFjaGVkIHBhZ2UgcmVnaXN0cmF0aW9uIGF0IGFsbC5cbiAgZm9yIChjb25zdCBbdHdlYWtJZCwgYnV0dG9uXSBvZiBzdGF0ZS5wYWdlTmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGlzQWN0aXZlID0gYWN0aXZlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBhY3RpdmUuaWQgPT09IHR3ZWFrSWQ7XG4gICAgYXBwbHlOYXZBY3RpdmUoYnV0dG9uLCBpc0FjdGl2ZSk7XG4gIH1cbiAgLy8gQ29kZXgncyBvd24gc2lkZWJhciBidXR0b25zIChHZW5lcmFsLCBBcHBlYXJhbmNlLCBldGMpLiBXaGVuIG9uZSBvZlxuICAvLyBvdXIgcGFnZXMgaXMgYWN0aXZlLCBDb2RleCBzdGlsbCBoYXMgYXJpYS1jdXJyZW50PVwicGFnZVwiIGFuZCB0aGVcbiAgLy8gYWN0aXZlLWJnIGNsYXNzIG9uIHdoaWNoZXZlciBpdGVtIGl0IGNvbnNpZGVyZWQgdGhlIHJvdXRlIFx1MjAxNCB0eXBpY2FsbHlcbiAgLy8gR2VuZXJhbC4gVGhhdCBtYWtlcyBib3RoIGJ1dHRvbnMgbG9vayBzZWxlY3RlZC4gU3RyaXAgQ29kZXgncyBhY3RpdmVcbiAgLy8gc3R5bGluZyB3aGlsZSBvbmUgb2Ygb3VycyBpcyBhY3RpdmU7IHJlc3RvcmUgaXQgd2hlbiBub25lIGlzLlxuICBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUoYWN0aXZlICE9PSBudWxsKTtcbn1cblxuLyoqXG4gKiBNdXRlIENvZGV4J3Mgb3duIGFjdGl2ZS1zdGF0ZSBzdHlsaW5nIG9uIGl0cyBzaWRlYmFyIGJ1dHRvbnMuIFdlIGRvbid0XG4gKiB0b3VjaCBDb2RleCdzIFJlYWN0IHN0YXRlIFx1MjAxNCB3aGVuIHRoZSB1c2VyIGNsaWNrcyBhIG5hdGl2ZSBpdGVtLCBDb2RleFxuICogcmUtcmVuZGVycyB0aGUgYnV0dG9ucyBhbmQgcmUtYXBwbGllcyBpdHMgb3duIGNvcnJlY3Qgc3RhdGUsIHRoZW4gb3VyXG4gKiBzaWRlYmFyLWNsaWNrIGxpc3RlbmVyIGZpcmVzIGByZXN0b3JlQ29kZXhWaWV3YCAod2hpY2ggY2FsbHMgYmFjayBpbnRvXG4gKiBgc2V0TmF2QWN0aXZlKG51bGwpYCBhbmQgbGV0cyBDb2RleCdzIHN0eWxpbmcgc3RhbmQpLlxuICpcbiAqIGBtdXRlPXRydWVgICBcdTIxOTIgc3RyaXAgYXJpYS1jdXJyZW50IGFuZCBzd2FwIGFjdGl2ZSBiZyBcdTIxOTIgaG92ZXIgYmdcbiAqIGBtdXRlPWZhbHNlYCBcdTIxOTIgbm8tb3AgKENvZGV4J3Mgb3duIHJlLXJlbmRlciBhbHJlYWR5IHJlc3RvcmVkIHRoaW5ncylcbiAqL1xuZnVuY3Rpb24gc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKG11dGU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgaWYgKCFtdXRlKSByZXR1cm47XG4gIGNvbnN0IHJvb3QgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKCFyb290KSByZXR1cm47XG4gIGNvbnN0IGJ1dHRvbnMgPSBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpO1xuICBmb3IgKGNvbnN0IGJ0biBvZiBidXR0b25zKSB7XG4gICAgLy8gU2tpcCBvdXIgb3duIGJ1dHRvbnMuXG4gICAgaWYgKGJ0bi5kYXRhc2V0LmNvZGV4cHApIGNvbnRpbnVlO1xuICAgIGlmIChidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIikge1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICB9XG4gICAgaWYgKGJ0bi5jbGFzc0xpc3QuY29udGFpbnMoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIikpIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGFwcGx5TmF2QWN0aXZlKGJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQsIGFjdGl2ZTogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBpbm5lciA9IGJ0bi5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChhY3RpdmUpIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIiwgXCJwYWdlXCIpO1xuICAgICAgaWYgKGlubmVyKSB7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lclxuICAgICAgICAgIC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpXG4gICAgICAgICAgPy5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24taWNvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgICAgaWYgKGlubmVyKSB7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyLmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lclxuICAgICAgICAgIC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpXG4gICAgICAgICAgPy5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24taWNvbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgfVxuICAgIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGFjdGl2YXRpb24gXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGFjdGl2YXRlUGFnZShwYWdlOiBBY3RpdmVQYWdlKTogdm9pZCB7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSB7XG4gICAgcGxvZyhcImFjdGl2YXRlOiBjb250ZW50IGFyZWEgbm90IGZvdW5kXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBzdGF0ZS5hY3RpdmVQYWdlID0gcGFnZTtcbiAgcGxvZyhcImFjdGl2YXRlXCIsIHsgcGFnZSB9KTtcblxuICAvLyBIaWRlIENvZGV4J3MgY29udGVudCBjaGlsZHJlbiwgc2hvdyBvdXJzLlxuICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHAgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gPT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuZGF0YXNldC5jb2RleHBwSGlkZGVuID0gY2hpbGQuc3R5bGUuZGlzcGxheSB8fCBcIlwiO1xuICAgIH1cbiAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIH1cbiAgbGV0IHBhbmVsID0gY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtY29kZXhwcD1cInR3ZWFrcy1wYW5lbFwiXScpO1xuICBpZiAoIXBhbmVsKSB7XG4gICAgcGFuZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHBhbmVsLmRhdGFzZXQuY29kZXhwcCA9IFwidHdlYWtzLXBhbmVsXCI7XG4gICAgcGFuZWwuc3R5bGUuY3NzVGV4dCA9IFwid2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvdmVyZmxvdzphdXRvO1wiO1xuICAgIGNvbnRlbnQuYXBwZW5kQ2hpbGQocGFuZWwpO1xuICB9XG4gIHBhbmVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIHN0YXRlLnBhbmVsSG9zdCA9IHBhbmVsO1xuICByZXJlbmRlcigpO1xuICBzZXROYXZBY3RpdmUocGFnZSk7XG4gIC8vIHJlc3RvcmUgQ29kZXgncyB2aWV3LiBSZS1yZWdpc3RlciBpZiBuZWVkZWQuXG4gIGNvbnN0IHNpZGViYXIgPSBzdGF0ZS5zaWRlYmFyUm9vdDtcbiAgaWYgKHNpZGViYXIpIHtcbiAgICBpZiAoc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyKSB7XG4gICAgICBzaWRlYmFyLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsIHRydWUpO1xuICAgIH1cbiAgICBjb25zdCBoYW5kbGVyID0gKGU6IEV2ZW50KSA9PiB7XG4gICAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBpZiAoIXRhcmdldCkgcmV0dXJuO1xuICAgICAgaWYgKHN0YXRlLm5hdkdyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBidXR0b25zXG4gICAgICBpZiAoc3RhdGUucGFnZXNHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgcGFnZSBidXR0b25zXG4gICAgICBpZiAodGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS1jb2RleHBwLXNldHRpbmdzLXNlYXJjaF1cIikpIHJldHVybjtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICB9O1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IGhhbmRsZXI7XG4gICAgc2lkZWJhci5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlciwgdHJ1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzdG9yZUNvZGV4VmlldygpOiB2b2lkIHtcbiAgcGxvZyhcInJlc3RvcmUgY29kZXggdmlld1wiKTtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHJldHVybjtcbiAgdGVhcmRvd25SZW5kZXJlZFBhZ2VzKCk7XG4gIGlmIChzdGF0ZS5wYW5lbEhvc3QpIHN0YXRlLnBhbmVsSG9zdC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkID09PSBzdGF0ZS5wYW5lbEhvc3QpIGNvbnRpbnVlO1xuICAgIGlmIChjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IGNoaWxkLmRhdGFzZXQuY29kZXhwcEhpZGRlbjtcbiAgICAgIGRlbGV0ZSBjaGlsZC5kYXRhc2V0LmNvZGV4cHBIaWRkZW47XG4gICAgfVxuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICBzZXROYXZBY3RpdmUobnVsbCk7XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5yZW1vdmVFdmVudExpc3RlbmVyKFxuICAgICAgXCJjbGlja1wiLFxuICAgICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVyZW5kZXIoKTogdm9pZCB7XG4gIGlmICghc3RhdGUuYWN0aXZlUGFnZSkgcmV0dXJuO1xuICBjb25zdCBob3N0ID0gc3RhdGUucGFuZWxIb3N0O1xuICBpZiAoIWhvc3QpIHJldHVybjtcbiAgdGVhcmRvd25SZW5kZXJlZFBhZ2VzKCk7XG4gIGhvc3QuaW5uZXJIVE1MID0gXCJcIjtcblxuICBjb25zdCBhcCA9IHN0YXRlLmFjdGl2ZVBhZ2U7XG4gIGlmIChhcC5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIGNvbnN0IGl0ZW0gPSBzZXR0aW5nc05hdmlnYXRpb25JdGVtKGFwLmlkKTtcbiAgICBpZiAoIWl0ZW0pIHtcbiAgICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgZW50cmllcyA9IHJlZ2lzdGVyZWRQYWdlc0ZvclR3ZWFrKGFwLmlkKTtcbiAgICBjb25zdCByb290ID0gcGFuZWxTaGVsbChpdGVtLnRpdGxlLCBpdGVtLmRlc2NyaXB0aW9uKTtcbiAgICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICAgIHJvb3QuaGVhZGVyVGl0bGVBY3Rpb25zLmFwcGVuZENoaWxkKHR3ZWFrTGlmZWN5Y2xlQmFkZ2UoaXRlbSkpO1xuICAgIGlmIChpdGVtLndhcm5pbmcpIHJvb3Quc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHR3ZWFrUGFnZVdhcm5pbmcoaXRlbS53YXJuaW5nKSk7XG4gICAgaWYgKCFlbnRyaWVzLmxlbmd0aCkge1xuICAgICAgcmVuZGVyRmFsbGJhY2tUd2Vha1BhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIGl0ZW0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIHtcbiAgICAgIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgICAgIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gICAgICBpZiAoZW50cmllcy5sZW5ndGggPiAxKSBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShlbnRyeS5wYWdlLnRpdGxlKSk7XG4gICAgICBjb25zdCB0YXJnZXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgdGFyZ2V0LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtM1wiO1xuICAgICAgc2VjdGlvbi5hcHBlbmRDaGlsZCh0YXJnZXQpO1xuICAgICAgcm9vdC5zZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gICAgICB0cnkge1xuICAgICAgICB0cnkgeyBlbnRyeS50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgICAgICAgZW50cnkudGVhcmRvd24gPSBudWxsO1xuICAgICAgICBjb25zdCByZXQgPSBlbnRyeS5wYWdlLnJlbmRlcih0YXJnZXQpO1xuICAgICAgICBpZiAodHlwZW9mIHJldCA9PT0gXCJmdW5jdGlvblwiKSBlbnRyeS50ZWFyZG93biA9IHJldDtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc3QgZXJyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgZXJyLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1jaGFydHMtcmVkIHRleHQtc21cIjtcbiAgICAgICAgZXJyLnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyBwYWdlOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICAgIHRhcmdldC5hcHBlbmRDaGlsZChlcnIpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB0aXRsZSA9XG4gICAgYXAua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwiVHdlYWtzXCIgOlxuICAgIGFwLmtpbmQgPT09IFwic3RvcmVcIiA/IFwiVHdlYWsgU3RvcmVcIiA6IFwiVHdlYWtlcnNcIjtcbiAgY29uc3Qgc3VidGl0bGUgPVxuICAgIGFwLmtpbmQgPT09IFwidHdlYWtzXCJcbiAgICAgID8gXCJNYW5hZ2UgeW91ciBjYXRhbG9nIGVudHJpZXMgYW5kIGluc3RhbGxlZCB0d2Vha3MuXCJcbiAgICAgIDogYXAua2luZCA9PT0gXCJzdG9yZVwiXG4gICAgICAgID8gXCJJbnN0YWxsIHJldmlld2VkIHR3ZWFrcyBwaW5uZWQgdG8gYXBwcm92ZWQgR2l0SHViIGNvbW1pdHMuXCJcbiAgICAgICAgOiBcIkNoZWNraW5nIGluc3RhbGxlZCBUd2Vha2VycyB2ZXJzaW9uLlwiO1xuICBjb25zdCByb290ID0gcGFuZWxTaGVsbChcbiAgICB0aXRsZSxcbiAgICBzdWJ0aXRsZSxcbiAgICBhcC5raW5kID09PSBcInR3ZWFrc1wiID8geyB3aWR0aDogXCJwbHVnaW5zXCIgfSA6IHVuZGVmaW5lZCxcbiAgKTtcbiAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgaWYgKGFwLmtpbmQgPT09IFwidHdlYWtzXCIpIGFjdGl2ZUJ1aWx0aW5QYWdlQ2xlYW51cCA9IHJlbmRlclR3ZWFrc1BhZ2Uocm9vdC5zZWN0aW9uc1dyYXApO1xuICBlbHNlIGlmIChhcC5raW5kID09PSBcInN0b3JlXCIpIHJlbmRlclR3ZWFrU3RvcmVQYWdlKHJvb3Quc2VjdGlvbnNXcmFwLCByb290LmhlYWRlckFjdGlvbnMpO1xuICBlbHNlIHJlbmRlckNvbmZpZ1BhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3Quc3VidGl0bGUpO1xufVxuXG5mdW5jdGlvbiB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTogdm9pZCB7XG4gIGFjdGl2ZUJ1aWx0aW5QYWdlQ2xlYW51cD8uKCk7XG4gIGFjdGl2ZUJ1aWx0aW5QYWdlQ2xlYW51cCA9IG51bGw7XG4gIGZvciAoY29uc3QgZW50cnkgb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICBpZiAoIWVudHJ5LnRlYXJkb3duKSBjb250aW51ZTtcbiAgICB0cnkgeyBlbnRyeS50ZWFyZG93bigpOyB9IGNhdGNoIHt9XG4gICAgZW50cnkudGVhcmRvd24gPSBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwYWdlcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gdHdlYWtMaWZlY3ljbGVCYWRnZShpdGVtOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGAke2l0ZW0udmVyc2lvbn0gXHUwMEI3ICR7bGlmZWN5Y2xlTGFiZWwoaXRlbS5saWZlY3ljbGUpfWA7XG4gIGJhZGdlLnRpdGxlID0gYCR7aXRlbS52ZXJzaW9ufSBcdTAwQjcgJHtsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSwgaXRlbS53YXJuaW5nKX1gO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrUGFnZVdhcm5pbmcobWVzc2FnZTogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB3YXJuaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgd2FybmluZy5jbGFzc05hbWUgPSBcInJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1jaGFydHMteWVsbG93LzMwIGJnLXRva2VuLWNoYXJ0cy15ZWxsb3cvMTAgcC0zIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgd2FybmluZy50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gIHJldHVybiB3YXJuaW5nO1xufVxuXG5mdW5jdGlvbiByZW5kZXJGYWxsYmFja1R3ZWFrUGFnZShyb290OiBIVE1MRWxlbWVudCwgaXRlbTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSk6IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiU3RhdHVzXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiVmVyc2lvblwiLCBpdGVtLnZlcnNpb24pKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMaWZlY3ljbGVcIiwgbGlmZWN5Y2xlTGFiZWwoaXRlbS5saWZlY3ljbGUsIGl0ZW0ud2FybmluZykpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJTZXR0aW5ncyBwYWdlXCIsIFwiVGhpcyBlbmFibGVkIFR3ZWFrZXIgaGFzIG5vdCByZWdpc3RlcmVkIGl0cyBjdXN0b20gcGFnZSB5ZXQuIFJ1bnRpbWUgc3RhdHVzIHJlbWFpbnMgYXZhaWxhYmxlIGhlcmUuXCIpKTtcbiAgaWYgKFtcImZhaWxlZFwiLCBcInF1YXJhbnRpbmVkXCIsIFwidGltZWRfb3V0XCJdLmluY2x1ZGVzKGl0ZW0ubGlmZWN5Y2xlKSkge1xuICAgIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICAgIHJvdy5hcHBlbmRDaGlsZChyb3dDb3B5KFwiUmVjb3ZlcnlcIiwgXCJDbGVhciB0aGUgZmFpbHVyZSBhbmQgcmV0cnkgdGhpcyBUd2Vha2VyIHdpdGhvdXQgcmVtb3ZpbmcgaXRzIGRhdGEuXCIpKTtcbiAgICBjb25zdCByZWNvdmVyID0gY29tcGFjdEJ1dHRvbihcIlJlY292ZXJcIiwgKCkgPT4ge1xuICAgICAgcmVjb3Zlci5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmVjb3Zlci10d2Vha1wiLCBpdGVtLnR3ZWFrSWQpLmZpbmFsbHkoKCkgPT4geyByZWNvdmVyLmRpc2FibGVkID0gZmFsc2U7IH0pO1xuICAgIH0pO1xuICAgIHJvdy5hcHBlbmRDaGlsZChyZWNvdmVyKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvdyk7XG4gIH1cbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgcm9vdC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbn1cblxuZnVuY3Rpb24gcm93Q29weSh0aXRsZTogc3RyaW5nLCBkZXRhaWw6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgY29weSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvcHkuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGhlYWRpbmcudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgY29uc3QgZGVzY3JpcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjcmlwdGlvbi5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBkZXNjcmlwdGlvbi50ZXh0Q29udGVudCA9IGRldGFpbDtcbiAgY29weS5hcHBlbmQoaGVhZGluZywgZGVzY3JpcHRpb24pO1xuICByZXR1cm4gY29weTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29uZmlnUGFnZShcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgc3VidGl0bGU/OiBIVE1MRWxlbWVudCxcbik6IHZvaWQge1xuICByZW5kZXJDb2RleFZlcnNpb25zU2VjdGlvbihzZWN0aW9uc1dyYXApO1xuICByZW5kZXJNb2RlU2VjdGlvbihzZWN0aW9uc1dyYXApO1xuXG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJUd2Vha2VycyBVcGRhdGVzXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC5jb2RleHBwQ29uZmlnQ2FyZCA9IFwidHJ1ZVwiO1xuICBjb25zdCBsb2FkaW5nID0gcm93U2ltcGxlKFwiTG9hZGluZyB1cGRhdGUgc2V0dGluZ3NcIiwgXCJDaGVja2luZyBjdXJyZW50IFR3ZWFrZXJzIGNvbmZpZ3VyYXRpb24uXCIpO1xuICBjYXJkLmFwcGVuZENoaWxkKGxvYWRpbmcpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC1jb25maWdcIilcbiAgICAudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHtcbiAgICAgICAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBgWW91IGhhdmUgVHdlYWtlcnMgJHsoY29uZmlnIGFzIENvZGV4UGx1c1BsdXNDb25maWcpLnZlcnNpb259IGluc3RhbGxlZC5gO1xuICAgICAgfVxuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJDb2RleFBsdXNQbHVzQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgaWYgKHN1YnRpdGxlKSBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IFwiQ291bGQgbm90IGxvYWQgaW5zdGFsbGVkIFR3ZWFrZXJzIHZlcnNpb24uXCI7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGxvYWQgdXBkYXRlIHNldHRpbmdzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xuXG4gIGNvbnN0IHdhdGNoZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgd2F0Y2hlci5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgd2F0Y2hlci5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBdXRvLVJlcGFpciBXYXRjaGVyXCIpKTtcbiAgY29uc3Qgd2F0Y2hlckNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICB3YXRjaGVyQ2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gIHdhdGNoZXIuYXBwZW5kQ2hpbGQod2F0Y2hlckNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQod2F0Y2hlcik7XG4gIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKHdhdGNoZXJDYXJkKTtcblxuICBjb25zdCBtYWludGVuYW5jZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBtYWludGVuYW5jZS5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgbWFpbnRlbmFuY2UuYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiTWFpbnRlbmFuY2VcIikpO1xuICBjb25zdCBtYWludGVuYW5jZUNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBtYWludGVuYW5jZUNhcmQuYXBwZW5kQ2hpbGQodW5pbnN0YWxsUm93KCkpO1xuICBtYWludGVuYW5jZUNhcmQuYXBwZW5kQ2hpbGQocmVwb3J0QnVnUm93KCkpO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChtYWludGVuYW5jZUNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQobWFpbnRlbmFuY2UpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RleFZlcnNpb25zU2VjdGlvbihzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5kYXRhc2V0LmNvZGV4cHBDb2RleFNlY3Rpb24gPSBcInRydWVcIjtcbiAgY29uc3QgcmVmcmVzaCA9IGNvbXBhY3RCdXR0b24oXCJSZWZyZXNoXCIsICgpID0+IHsgdm9pZCBsb2FkKHRydWUpOyB9KTtcbiAgY29uc3QgaGVhZGluZyA9IHNlY3Rpb25UaXRsZShcIkNPREVYXCIsIHJlZnJlc2gpO1xuICBjb25zdCBoZWFkaW5nVGV4dCA9IGhlYWRpbmcucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIudGV4dC1iYXNlXCIpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LmNvZGV4cHBDb2RleENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIENvZGV4IHZlcnNpb25zXCIsIFwiVXNpbmcgY2FjaGVkIHZlcnNpb24gYW5kIGZlYXR1cmUgaW5mb3JtYXRpb24gZmlyc3QuXCIpKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgbGV0IGdlbmVyYXRpb24gPSAwO1xuICBjb25zdCBzY2hlZHVsZVBvbGwgPSAoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCkgPT4ge1xuICAgIGlmIChwb2xsaW5nKSBjbGVhclRpbWVvdXQocG9sbGluZyk7XG4gICAgcG9sbGluZyA9IG51bGw7XG4gICAgaWYgKCFhY3Rpb25JbkZsaWdodCAmJiAhY29kZXhQcm9ncmVzc0J1c3koc25hcHNob3QuaW5zdGFsbFByb2dyZXNzKSkgcmV0dXJuO1xuICAgIHBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkKSB2b2lkIGxvYWQoZmFsc2UpO1xuICAgIH0sIDkwMCk7XG4gIH07XG4gIGNvbnN0IHJlcXVlc3RSZWxvYWQ6IENvZGV4VWlSZWxvYWQgPSAobW9kZSkgPT4ge1xuICAgIGlmIChtb2RlID09PSBcIm9wZXJhdGlvbi1zdGFydFwiKSBhY3Rpb25JbkZsaWdodCA9IHRydWU7XG4gICAgaWYgKG1vZGUgPT09IFwib3BlcmF0aW9uLXN0b3BcIikgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgICB2b2lkIGxvYWQoZmFsc2UpO1xuICB9O1xuICBjb25zdCBzaG93ID0gKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpID0+IHtcbiAgICBpZiAoaGVhZGluZ1RleHQpIGhlYWRpbmdUZXh0LnRleHRDb250ZW50ID0gc25hcHNob3QudXBkYXRlQXZhaWxhYmxlID8gXCJDT0RFWCAoVVBEQVRFIEFWQUlMQUJMRSlcIiA6IFwiQ09ERVhcIjtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJDb2RleFZlcnNpb25zQ2FyZChjYXJkLCBzbmFwc2hvdCwgcmVxdWVzdFJlbG9hZCk7XG4gICAgc2NoZWR1bGVQb2xsKHNuYXBzaG90KTtcbiAgfTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZChmb3JjZTogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSArK2dlbmVyYXRpb247XG4gICAgcmVmcmVzaC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNuYXBzaG90ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBmb3JjZSA/IFwiY29kZXhwcDpyZWZyZXNoLWNvZGV4LXZlcnNpb25zXCIgOiBcImNvZGV4cHA6Z2V0LWNvZGV4LXZlcnNpb25zXCIsXG4gICAgICApIGFzIENvZGV4VmVyc2lvbnNTbmFwc2hvdDtcbiAgICAgIGlmIChjdXJyZW50ICE9PSBnZW5lcmF0aW9uIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBzaG93KHNuYXBzaG90KTtcbiAgICAgIGlmICghZm9yY2UgJiYgaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3QpKSB7XG4gICAgICAgIHZvaWQgbG9hZCh0cnVlKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKGN1cnJlbnQgIT09IGdlbmVyYXRpb24gfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb2RleCB2ZXJzaW9ucyB1bmF2YWlsYWJsZVwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKGN1cnJlbnQgPT09IGdlbmVyYXRpb24pIHJlZnJlc2guZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgdm9pZCBsb2FkKGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhWZXJzaW9uc0NhcmQoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgZGVza3RvcCA9IHNuYXBzaG90LmRlc2t0b3A7XG4gIGNvbnN0IGJ1bmRsZWQgPSBzbmFwc2hvdC5jbGkuYnVuZGxlZDtcbiAgY29uc3QgYmV0YSA9IHNuYXBzaG90LmNsaS5iZXRhO1xuICBjb25zdCBidXN5ID0gY29kZXhQcm9ncmVzc0J1c3koc25hcHNob3QuaW5zdGFsbFByb2dyZXNzKTtcblxuICBpZiAoc25hcHNob3QuZnJvbUNhY2hlIHx8IHNuYXBzaG90LnN0YWxlKSB7XG4gICAgY29uc3QgY2hlY2tlZCA9IG5ldyBEYXRlKHNuYXBzaG90LmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgIHNuYXBzaG90LnN0YWxlID8gXCJDYWNoZWQgaW5mb3JtYXRpb24gKHJlZnJlc2ggbmVlZGVkKVwiIDogXCJDYWNoZWQgaW5mb3JtYXRpb25cIixcbiAgICAgIGBTaG93aW5nIHRoZSBsYXN0IGtub3duIGdvb2QgcmVzdWx0IGZyb20gJHtjaGVja2VkfSB3aGlsZSBjdXJyZW50IGluZm9ybWF0aW9uIGxvYWRzLmAsXG4gICAgKSk7XG4gIH1cblxuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4RGVza3RvcFJvdyhkZXNrdG9wLCBjb2RleFNjb3BlZEVycm9yKHNuYXBzaG90LCBcImRlc2t0b3BcIiksIGJ1c3ksIHJlbG9hZCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICBcIkJ1aWxkXCIsXG4gICAgaW5zdGFsbGVkTGF0ZXN0U3VtbWFyeShkZXNrdG9wLmluc3RhbGxlZEJ1aWxkLCBkZXNrdG9wLmxhdGVzdEJ1aWxkLCBjb2RleFNjb3BlZEVycm9yKHNuYXBzaG90LCBcImRlc2t0b3BcIikpLFxuICApKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleENsaVJvdyhcIkJ1bmRsZWQgQ29kZXggQ0xJXCIsIFwiYnVuZGxlZFwiLCBidW5kbGVkLCBzbmFwc2hvdCwgYnVzeSwgcmVsb2FkKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhDbGlSb3coXCJCZXRhIENvZGV4IENMSVwiLCBcImJldGFcIiwgYmV0YSwgc25hcHNob3QsIGJ1c3ksIHJlbG9hZCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4UnVudGltZVJvdyhzbmFwc2hvdCwgYmV0YSwgYnVzeSwgcmVsb2FkKSk7XG5cbiAgY29uc3QgcmVsZWFzZXMgPSBhY3Rpb25Sb3coXCJHaXRIdWIgUmVsZWFzZXNcIiwgXCJWaWV3IG9mZmljaWFsIE9wZW5BSSBDb2RleCByZWxlYXNlIG5vdGVzIGFuZCBwYWNrYWdlcy5cIik7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocmVsZWFzZXMpO1xuICByZWxlYXNlcy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiT3BlbiBSZWxlYXNlc1wiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwoXCJodHRwczovL2dpdGh1Yi5jb20vb3BlbmFpL2NvZGV4L3JlbGVhc2VzXCIpKSxcbiAgKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlcyk7XG5cbiAgaWYgKHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcyAmJiBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MucGhhc2UgJiYgc25hcHNob3QuaW5zdGFsbFByb2dyZXNzLnBoYXNlICE9PSBcImlkbGVcIikge1xuICAgIGNvbnN0IHAgPSBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3M7XG4gICAgY29uc3QgYW1vdW50ID0gZm9ybWF0Qnl0ZXMocC5ieXRlcyk7XG4gICAgY29uc3QgZGV0YWlsID0gcC5lcnJvciB8fCBbaHVtYW5pemVDb2RleFBoYXNlKHAucGhhc2UpLCBwLnZlcnNpb24sIGFtb3VudF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkJldGEgb3BlcmF0aW9uXCIsIGRldGFpbCkpO1xuICB9XG5cbiAgY29uc3Qgc3RhdGVNZXNzYWdlID0gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdCk7XG4gIGlmIChzdGF0ZU1lc3NhZ2UpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUnVudGltZSBzdGF0dXNcIiwgc3RhdGVNZXNzYWdlKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhGZWF0dXJlQnJvd3NlcihzbmFwc2hvdCwgYnVzeSwgcmVsb2FkKSk7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RGVza3RvcFJvdyhcbiAgZGVza3RvcDogQ29kZXhEZXNrdG9wVmVyc2lvblN0YXRlLFxuICBlcnJvcjogc3RyaW5nIHwgbnVsbCxcbiAgYnVzeTogYm9vbGVhbixcbiAgcmVsb2FkOiBDb2RleFVpUmVsb2FkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBpbnN0YWxsZWQgPSBkZXNrdG9wLmluc3RhbGxlZE1hcmtldGluZ1ZlcnNpb247XG4gIGNvbnN0IGxhdGVzdCA9IGRlc2t0b3AubGF0ZXN0TWFya2V0aW5nVmVyc2lvbjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiRGVza3RvcCBBcHBcIiwgaW5zdGFsbGVkTGF0ZXN0U3VtbWFyeShpbnN0YWxsZWQsIGxhdGVzdCwgZXJyb3IpKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3cpO1xuICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IGxpZmVjeWNsZSA9IGRlc2t0b3AubmF0aXZlVXBkYXRlTGlmZWN5Y2xlO1xuICBjb25zdCBwcmVyZXF1aXNpdGVFcnJvciA9IGRlc2t0b3AubmF0aXZlVXBkYXRlUHJlcmVxdWlzaXRlRXJyb3I7XG4gIGNvbnN0IG5hdGl2ZVVuYXZhaWxhYmxlID0gcHJlcmVxdWlzaXRlRXJyb3IgPT09IFwiVGhlIG5hdGl2ZSB1cGRhdGVyIGlzIHVuYXZhaWxhYmxlLlwiO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwoZGVza3RvcC5yZWxlYXNlVXJsKSkge1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChkZXNrdG9wLnJlbGVhc2VVcmwhKSkpO1xuICB9XG4gIGNvbnN0IGNoZWNrID0gY29tcGFjdEJ1dHRvbihcIkNoZWNrXCIsICgpID0+IHJ1bkNvZGV4QWN0aW9uKHJvdywgXCJjb2RleHBwOmNoZWNrLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIsIHVuZGVmaW5lZCwgcmVsb2FkKSk7XG4gIC8vIFZlcnNpb24gY2hlY2tzIHVzZSB0aGUgc2lnbmVkIGFwcGNhc3QgYW5kIHJlbWFpbiBhdmFpbGFibGUgZXZlbiB3aGVuIHRoZVxuICAvLyBuYXRpdmUgaW5zdGFsbGVyIGlzIHVuYXZhaWxhYmxlIGluIHRoZSBsb2NhbGx5IHNpZ25lZCBwYXRjaGVkIHByb2Nlc3MuXG4gIGNoZWNrLmRpc2FibGVkID0gYnVzeTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY2hlY2spO1xuICBjb25zdCBpbnN0YWxsID0gY29tcGFjdEJ1dHRvbihcIkluc3RhbGwgVXBkYXRlXCIsICgpID0+IHJ1bkNvZGV4QWN0aW9uKHJvdywgXCJjb2RleHBwOmluc3RhbGwtY29kZXgtZGVza3RvcC11cGRhdGVcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgaW5zdGFsbC5kaXNhYmxlZCA9IGJ1c3kgfHwgbmF0aXZlVW5hdmFpbGFibGUgfHwgIWRlc2t0b3AubmF0aXZlVXBkYXRlQWN0aW9uYWJsZTtcbiAgaW5zdGFsbC50aXRsZSA9IHByZXJlcXVpc2l0ZUVycm9yIHx8IChpbnN0YWxsLmRpc2FibGVkID8gXCJBIHZlcmlmaWVkIHNpZ25lZCBiYWNrdXAgYW5kIHVwZGF0ZS1yZWFkeSBuYXRpdmUgdXBkYXRlciBhcmUgcmVxdWlyZWQuXCIgOiBcIk9wZW5BSSdzIHVwZGF0ZXIgbWF5IGNsb3NlIHRoZSBhcHAgYWZ0ZXIgY29uZmlybWF0aW9uLlwiKTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoaW5zdGFsbCk7XG4gIGlmIChsaWZlY3ljbGUgfHwgcHJlcmVxdWlzaXRlRXJyb3IpIHtcbiAgICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBsZWZ0Py5hcHBlbmRDaGlsZChjb2RleElubGluZU1lc3NhZ2UocHJlcmVxdWlzaXRlRXJyb3IgfHwgYE5hdGl2ZSB1cGRhdGVyOiAke2h1bWFuaXplQ29kZXhQaGFzZShsaWZlY3ljbGUgPz8gXCJhdmFpbGFibGVcIil9YCkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4Q2xpUm93KFxuICBsYWJlbDogc3RyaW5nLFxuICBsYW5lOiBDb2RleENsaUxhbmUsXG4gIGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaW5zdGFsbGVkID0gY2xpLm1hbmFnZWRDdXJyZW50VmVyc2lvbiA/PyBjbGkudmVyc2lvbjtcbiAgY29uc3QgbGF0ZXN0ID0gY2xpLnJlbGVhc2U/LnZlcnNpb247XG4gIGNvbnN0IGRldGFpbCA9IGluc3RhbGxlZExhdGVzdFN1bW1hcnkoaW5zdGFsbGVkLCBsYXRlc3QsIGNsaS5lcnJvciB8fCBjbGkucmVsZWFzZT8uZXJyb3IpO1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3cobGFiZWwsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoc25hcHNob3QuZWZmZWN0aXZlTGFuZSA9PT0gbGFuZSkgYWN0aW9ucz8ucHJlcGVuZChzdGF0dXNCYWRnZShcIm9rXCIsIFwiQWN0aXZlXCIpKTtcbiAgY29uc3QgcmVsZWFzZVVybCA9IGNsaS5yZWxlYXNlPy5yZWxlYXNlVXJsO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwocmVsZWFzZVVybCkpIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlVXJsISkpKTtcbiAgaWYgKGxhbmUgPT09IFwiYmV0YVwiKSB7XG4gICAgY29uc3QgaW5zdGFsbExhYmVsID0gaW5zdGFsbGVkICYmIGxhdGVzdCAmJiBpbnN0YWxsZWQgIT09IGxhdGVzdCA/IFwiVXBkYXRlXCIgOiBpbnN0YWxsZWQgPyBcIlJlaW5zdGFsbFwiIDogXCJJbnN0YWxsXCI7XG4gICAgY29uc3QgaW5zdGFsbCA9IGNvbXBhY3RCdXR0b24oaW5zdGFsbExhYmVsLCAoKSA9PiBydW5Db2RleEFjdGlvbihyb3csIFwiY29kZXhwcDppbnN0YWxsLWNvZGV4LWJldGFcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgICBpbnN0YWxsLmRpc2FibGVkID0gYnVzeSB8fCAhbGF0ZXN0O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGluc3RhbGwpO1xuICAgIGNvbnN0IHByZXZpb3VzVmVyc2lvbiA9IGNsaS5tYW5hZ2VkUHJldmlvdXNWZXJzaW9uO1xuICAgIGlmIChwcmV2aW91c1ZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJvbGxiYWNrID0gY29tcGFjdEJ1dHRvbihgUm9sbGJhY2sgdG8gJHtwcmV2aW91c1ZlcnNpb259YCwgKCkgPT4gcnVuQ29kZXhBY3Rpb24ocm93LCBcImNvZGV4cHA6cm9sbGJhY2stY29kZXgtYmV0YVwiLCB1bmRlZmluZWQsIHJlbG9hZCkpO1xuICAgICAgcm9sbGJhY2suZGlzYWJsZWQgPSBidXN5O1xuICAgICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQocm9sbGJhY2spO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleFJ1bnRpbWVSb3coXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4gIGJldGE6IENvZGV4Q2xpVmVyc2lvblN0YXRlLFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJlcXVlc3RlZCA9IHNuYXBzaG90LnJlcXVlc3RlZExhbmU7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlJ1bnRpbWVcIixcbiAgICByZXF1ZXN0ZWRcbiAgICAgID8gYCR7cmVxdWVzdGVkID09PSBcImJldGFcIiA/IFwiQmV0YVwiIDogXCJCdW5kbGVkXCJ9IGlzIHNlbGVjdGVkLiBSdW50aW1lIGNoYW5nZXMgYXBwbHkgYWZ0ZXIgcmVzdGFydGluZyB0aGUgYXBwLmBcbiAgICAgIDogc25hcHNob3QudXNlck92ZXJyaWRlUHJlc2VydmVkXG4gICAgICAgID8gXCJBbiBleGlzdGluZyBDT0RFWF9DTElfUEFUSCBvdmVycmlkZSBpcyBwcmVzZXJ2ZWQgdW50aWwgeW91IGNob29zZSBhIG1hbmFnZWQgcnVudGltZS5cIlxuICAgICAgICA6IFwiTm8gbWFuYWdlZCBydW50aW1lIGlzIHNlbGVjdGVkLlwiLFxuICApO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9ucz8uY2xhc3NMaXN0LmFkZChcImZsZXgtd3JhcFwiLCBcImp1c3RpZnktZW5kXCIpO1xuICBjb25zdCBzZWxlY3RvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNlbGVjdG9yLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCByb3VuZGVkLWxnIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTAuNVwiO1xuICBmb3IgKGNvbnN0IGxhbmUgb2YgW1wiYnVuZGxlZFwiLCBcImJldGFcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBsYW5lID09PSBcImJldGFcIiA/IFwiQmV0YVwiIDogXCJCdW5kbGVkXCI7XG4gICAgYnV0dG9uLmNsYXNzTmFtZSA9IGByb3VuZGVkLW1kIHB4LTMgcHktMS41IHRleHQtc20gJHtyZXF1ZXN0ZWQgPT09IGxhbmUgPyBcImJnLXRva2VuLWJnLXByaW1hcnkgc2hhZG93LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCIgOiBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6dGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIn1gO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGJ1c3kgfHwgcmVxdWVzdGVkID09PSBsYW5lIHx8IChsYW5lID09PSBcImJldGFcIiAmJiAhKGJldGEubWFuYWdlZEN1cnJlbnRWZXJzaW9uID8/IGJldGEudmVyc2lvbikpO1xuICAgIGJ1dHRvbi50aXRsZSA9IGxhbmUgPT09IFwiYmV0YVwiICYmIGJ1dHRvbi5kaXNhYmxlZCAmJiByZXF1ZXN0ZWQgIT09IGxhbmUgPyBcIkluc3RhbGwgYSB2ZXJpZmllZCBCZXRhIENMSSBmaXJzdC5cIiA6IFwiXCI7XG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjb25maXJtT3ZlcnJpZGUgPSBzbmFwc2hvdC51c2VyT3ZlcnJpZGVQcmVzZXJ2ZWQ7XG4gICAgICBpZiAoY29uZmlybU92ZXJyaWRlICYmICF3aW5kb3cuY29uZmlybShcIlR3ZWFrZXJzIHdpbGwgcmVwbGFjZSB0aGUgZXhpc3RpbmcgQ09ERVhfQ0xJX1BBVEggb3ZlcnJpZGUgd2l0aCBhIG1hbmFnZWQgcnVudGltZSBvbiB0aGUgbmV4dCBhcHAgc3RhcnQuIENvbnRpbnVlP1wiKSkgcmV0dXJuO1xuICAgICAgdm9pZCBydW5Db2RleEFjdGlvbihyb3csIFwiY29kZXhwcDpzZXQtY29kZXgtY2xpLWxhbmVcIiwgeyBsYW5lLCBjb25maXJtT3ZlcnJpZGUgfSwgcmVsb2FkKTtcbiAgICB9KTtcbiAgICBzZWxlY3Rvci5hcHBlbmRDaGlsZChidXR0b24pO1xuICB9XG4gIGFjdGlvbnM/LmFwcGVuZENoaWxkKHNlbGVjdG9yKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlQnJvd3NlcihcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgYnVzeTogYm9vbGVhbixcbiAgcmVsb2FkOiBDb2RleFVpUmVsb2FkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB3cmFwcGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgd3JhcHBlci5jbGFzc05hbWUgPSBcInAtM1wiO1xuICBjb25zdCBkZXRhaWxzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRldGFpbHNcIik7XG4gIGRldGFpbHMuZGF0YXNldC5jb2RleHBwRmVhdHVyZUJyb3dzZXIgPSBcInRydWVcIjtcbiAgY29uc3Qgc3VtbWFyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdW1tYXJ5XCIpO1xuICBzdW1tYXJ5LmNsYXNzTmFtZSA9IFwiY3Vyc29yLXBvaW50ZXIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBjb25zdCBmZWF0dXJlcyA9IHNuYXBzaG90LmZlYXR1cmVzO1xuICBzdW1tYXJ5LnRleHRDb250ZW50ID0gYENvZGV4IENMSSBmZWF0dXJlcyAoJHtmZWF0dXJlcy5sZW5ndGh9KWA7XG4gIGRldGFpbHMuYXBwZW5kQ2hpbGQoc3VtbWFyeSk7XG4gIGNvbnN0IGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb250ZW50LmNsYXNzTmFtZSA9IFwibXQtMyBmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gIGNvbnN0IGZpbHRlcnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmaWx0ZXJzLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgc2VhcmNoLnR5cGUgPSBcInNlYXJjaFwiO1xuICBzZWFyY2gucGxhY2Vob2xkZXIgPSBcIlNlYXJjaCBDb2RleCBmZWF0dXJlc1wiO1xuICBzZWFyY2guY2xhc3NOYW1lID0gXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciBtaW4tdy1bMTgwcHhdIGZsZXgtMSByb3VuZGVkLW1kIGJvcmRlciBweC0zIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZpbHRlclNlbGVjdChcIlN0YWdlXCIsIFtcImFsbFwiLCBcInN0YWJsZVwiLCBcImV4cGVyaW1lbnRhbFwiLCBcInVuZGVyLWRldmVsb3BtZW50XCIsIFwiZGVwcmVjYXRlZFwiLCBcInJlbW92ZWRcIl0pO1xuICBjb25zdCBsYW5lID0gY29kZXhGaWx0ZXJTZWxlY3QoXCJMYW5lXCIsIFtcImFsbFwiLCBcImJ1bmRsZWRcIiwgXCJiZXRhXCIsIFwiYnVuZGxlZC1vbmx5XCIsIFwiYmV0YS1vbmx5XCJdKTtcbiAgY29uc3Qgc3RhdHVzID0gY29kZXhGaWx0ZXJTZWxlY3QoXCJTdGF0dXNcIiwgW1wiYWxsXCIsIFwiZW5hYmxlZFwiLCBcImRpc2FibGVkXCIsIFwidW5zdXBwb3J0ZWRcIiwgXCJyZWFkLW9ubHlcIl0pO1xuICBmaWx0ZXJzLmFwcGVuZChzZWFyY2gsIHN0YWdlLCBsYW5lLCBzdGF0dXMpO1xuICBjb250ZW50LmFwcGVuZENoaWxkKGZpbHRlcnMpO1xuICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGlzdC5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgcm91bmRlZC1sZyBib3JkZXJcIjtcbiAgY29udGVudC5hcHBlbmRDaGlsZChsaXN0KTtcbiAgY29uc3QgZHJhdyA9ICgpID0+IHtcbiAgICBsaXN0LnRleHRDb250ZW50ID0gXCJcIjtcbiAgICBjb25zdCBxdWVyeSA9IHNlYXJjaC52YWx1ZS50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgICBjb25zdCBzZWxlY3RlZExhbmUgPSBzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lID8/IHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgPz8gXCJidW5kbGVkXCI7XG4gICAgY29uc3Qgc2hvd24gPSBmZWF0dXJlcy5maWx0ZXIoKGZlYXR1cmUpID0+IHtcbiAgICAgIGNvbnN0IGZlYXR1cmVTdGFnZSA9IGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSk7XG4gICAgICBjb25zdCBlbmFibGVkID0gY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlLCBzZWxlY3RlZExhbmUpO1xuICAgICAgY29uc3QgbGFuZU1hdGNoID0gbGFuZS52YWx1ZSA9PT0gXCJhbGxcIlxuICAgICAgICB8fCAobGFuZS52YWx1ZSA9PT0gXCJidW5kbGVkLW9ubHlcIiAmJiBmZWF0dXJlLmJ1bmRsZWRPbmx5KVxuICAgICAgICB8fCAobGFuZS52YWx1ZSA9PT0gXCJiZXRhLW9ubHlcIiAmJiBmZWF0dXJlLmJldGFPbmx5KVxuICAgICAgICB8fCAobGFuZS52YWx1ZSA9PT0gXCJidW5kbGVkXCIgJiYgY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgXCJidW5kbGVkXCIpICE9PSBudWxsKVxuICAgICAgICB8fCAobGFuZS52YWx1ZSA9PT0gXCJiZXRhXCIgJiYgY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgXCJiZXRhXCIpICE9PSBudWxsKTtcbiAgICAgIGNvbnN0IHN0YXR1c01hdGNoID0gc3RhdHVzLnZhbHVlID09PSBcImFsbFwiIHx8IChzdGF0dXMudmFsdWUgPT09IFwiZW5hYmxlZFwiICYmIGVuYWJsZWQgPT09IHRydWUpIHx8IChzdGF0dXMudmFsdWUgPT09IFwiZGlzYWJsZWRcIiAmJiBlbmFibGVkID09PSBmYWxzZSkgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJ1bnN1cHBvcnRlZFwiICYmIGZlYXR1cmUuc3VwcG9ydGVkID09PSBmYWxzZSkgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJyZWFkLW9ubHlcIiAmJiAhY29kZXhGZWF0dXJlTXV0YWJsZShmZWF0dXJlLCBzZWxlY3RlZExhbmUpKTtcbiAgICAgIHJldHVybiAoIXF1ZXJ5IHx8IGZlYXR1cmUubmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHF1ZXJ5KSkgJiYgKHN0YWdlLnZhbHVlID09PSBcImFsbFwiIHx8IHN0YWdlLnZhbHVlID09PSBmZWF0dXJlU3RhZ2UpICYmIGxhbmVNYXRjaCAmJiBzdGF0dXNNYXRjaDtcbiAgICB9KTtcbiAgICBmb3IgKGNvbnN0IGZlYXR1cmUgb2Ygc2hvd24pIGxpc3QuYXBwZW5kQ2hpbGQoY29kZXhGZWF0dXJlUm93KGZlYXR1cmUsIHNlbGVjdGVkTGFuZSwgYnVzeSwgcmVsb2FkKSk7XG4gICAgaWYgKCFzaG93bi5sZW5ndGgpIGxpc3QuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTm8gbWF0Y2hpbmcgZmVhdHVyZXNcIiwgXCJUcnkgYSBkaWZmZXJlbnQgc2VhcmNoIG9yIGZpbHRlci5cIikpO1xuICB9O1xuICBmb3IgKGNvbnN0IGlucHV0IG9mIFtzZWFyY2gsIHN0YWdlLCBsYW5lLCBzdGF0dXNdKSBpbnB1dC5hZGRFdmVudExpc3RlbmVyKGlucHV0ID09PSBzZWFyY2ggPyBcImlucHV0XCIgOiBcImNoYW5nZVwiLCBkcmF3KTtcbiAgZHJhdygpO1xuICBkZXRhaWxzLmFwcGVuZENoaWxkKGNvbnRlbnQpO1xuICB3cmFwcGVyLmFwcGVuZENoaWxkKGRldGFpbHMpO1xuICByZXR1cm4gd3JhcHBlcjtcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlUm93KFxuICBmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSxcbiAgbGFuZTogQ29kZXhDbGlMYW5lLFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHN0YWdlID0gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgbGFuZSk7XG4gIGNvbnN0IGVuYWJsZWQgPSBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmUsIGxhbmUpO1xuICBjb25zdCBtdXRhYmxlID0gY29kZXhGZWF0dXJlTXV0YWJsZShmZWF0dXJlLCBsYW5lKTtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMyBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IHJvd0NvcHkoZmVhdHVyZS5uYW1lLCBgJHtzdGFnZSB8fCBcInVuc3VwcG9ydGVkXCJ9IFx1MDBCNyAke2ZlYXR1cmUuZWZmZWN0ID09PSBcInJlc3RhcnRcIiA/IFwiUmVzdGFydCByZXF1aXJlZFwiIDogZmVhdHVyZS5lZmZlY3QgPT09IFwibm9uZVwiID8gXCJObyByZXN0YXJ0XCIgOiBcIkFwcGxpZXMgdG8gbmV3IHNlc3Npb25zXCJ9YCk7XG4gIGNvbnN0IGJhZGdlcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJhZGdlcy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBnYXAtMVwiO1xuICBpZiAoZmVhdHVyZS5idW5kbGVkT25seSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQnVuZGxlZCBvbmx5XCIpKTtcbiAgaWYgKGZlYXR1cmUuYmV0YU9ubHkpIGJhZGdlcy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIkJldGEgb25seVwiKSk7XG4gIGlmIChmZWF0dXJlLnN1cHBvcnRlZCA9PT0gZmFsc2UpIGJhZGdlcy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIlVuc3VwcG9ydGVkXCIpKTtcbiAgaWYgKGVuYWJsZWQgPT09IHRydWUpIGJhZGdlcy5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShcIm9rXCIsIFwiRW5hYmxlZFwiKSk7XG4gIGlmIChlbmFibGVkID09PSBmYWxzZSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiRGlzYWJsZWRcIikpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGJhZGdlcyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgaWYgKG11dGFibGUgJiYgZW5hYmxlZCAhPT0gbnVsbCkge1xuICAgIGNvbnN0IHRvZ2dsZSA9IHN3aXRjaENvbnRyb2woZW5hYmxlZCwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIHRvZ2dsZS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1jb2RleC1mZWF0dXJlXCIsIHsgbGFuZSwgbmFtZTogZmVhdHVyZS5uYW1lLCBlbmFibGVkOiBuZXh0IH0pO1xuICAgICAgICByZWxvYWQoKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHdpbmRvdy5hbGVydChgQ291bGQgbm90IHVwZGF0ZSAke2ZlYXR1cmUubmFtZX06ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWApO1xuICAgICAgICByZWxvYWQoKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHRvZ2dsZS5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICAgIHRvZ2dsZS5kaXNhYmxlZCA9IGJ1c3k7XG4gICAgdG9nZ2xlLnRpdGxlID0gXCJGZWF0dXJlIGNoYW5nZXMgYXBwbHkgdG8gbmV3IHNlc3Npb25zLlwiO1xuICAgIHJvdy5hcHBlbmRDaGlsZCh0b2dnbGUpO1xuICB9IGVsc2Uge1xuICAgIHJvdy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShzdGFnZSA9PT0gXCJkZXByZWNhdGVkXCIgfHwgc3RhZ2UgPT09IFwicmVtb3ZlZFwiID8gXCJSZWFkIG9ubHlcIiA6IFwiVW5hdmFpbGFibGVcIikpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LCBsYW5lOiBDb2RleENsaUxhbmUpOiBDb2RleEZlYXR1cmVTdGFnZSB8IG51bGwge1xuICByZXR1cm4gZmVhdHVyZS5zdGFnZXNbbGFuZV07XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksIGxhbmU6IENvZGV4Q2xpTGFuZSk6IGJvb2xlYW4gfCBudWxsIHtcbiAgcmV0dXJuIGZlYXR1cmUuZW5hYmxlZFtsYW5lXTtcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlTXV0YWJsZShmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSwgbGFuZTogQ29kZXhDbGlMYW5lKTogYm9vbGVhbiB7XG4gIGNvbnN0IHN0YWdlID0gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgbGFuZSk7XG4gIHJldHVybiBmZWF0dXJlLm11dGFibGUgPT09IHRydWVcbiAgICAmJiBmZWF0dXJlLnN1cHBvcnRlZCAhPT0gZmFsc2VcbiAgICAmJiBzdGFnZSAhPT0gXCJkZXByZWNhdGVkXCJcbiAgICAmJiBzdGFnZSAhPT0gXCJyZW1vdmVkXCJcbiAgICAmJiBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmUsIGxhbmUpICE9PSBudWxsO1xufVxuXG5mdW5jdGlvbiBjb2RleEZpbHRlclNlbGVjdChsYWJlbDogc3RyaW5nLCBvcHRpb25zOiBzdHJpbmdbXSk6IEhUTUxTZWxlY3RFbGVtZW50IHtcbiAgY29uc3Qgc2VsZWN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlbGVjdFwiKTtcbiAgc2VsZWN0LmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcm91bmRlZC1tZCBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHNlbGVjdC50aXRsZSA9IGxhYmVsO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIG9wdGlvbnMpIHtcbiAgICBjb25zdCBvcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwib3B0aW9uXCIpO1xuICAgIG9wdGlvbi52YWx1ZSA9IHZhbHVlO1xuICAgIG9wdGlvbi50ZXh0Q29udGVudCA9IHZhbHVlID09PSBcImFsbFwiID8gYEFsbCAke2xhYmVsLnRvTG93ZXJDYXNlKCl9c2AgOiBodW1hbml6ZUNvZGV4UGhhc2UodmFsdWUpO1xuICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICB9XG4gIHJldHVybiBzZWxlY3Q7XG59XG5cbmZ1bmN0aW9uIGNvZGV4TmV1dHJhbEJhZGdlKHRleHQ6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICByb3cuY2xhc3NMaXN0LmFkZChcImZsZXgtd3JhcFwiKTtcbiAgcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik/LmNsYXNzTGlzdC5hZGQoXCJmbGV4LXdyYXBcIiwgXCJqdXN0aWZ5LWVuZFwiKTtcbn1cblxuZnVuY3Rpb24gY29kZXhJbmxpbmVNZXNzYWdlKHRleHQ6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgbWVzc2FnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1lc3NhZ2UuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBtZXNzYWdlLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIG1lc3NhZ2U7XG59XG5cbmZ1bmN0aW9uIGNvZGV4UHJvZ3Jlc3NCdXN5KHByb2dyZXNzOiBDb2RleEluc3RhbGxQcm9ncmVzcyk6IGJvb2xlYW4ge1xuICByZXR1cm4gIVtcImlkbGVcIiwgXCJjb21wbGV0ZVwiLCBcImZhaWxlZFwiXS5pbmNsdWRlcyhwcm9ncmVzcy5waGFzZSk7XG59XG5cbmZ1bmN0aW9uIGlzQ29kZXhTbmFwc2hvdFN0YWxlKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpOiBib29sZWFuIHtcbiAgcmV0dXJuIHNuYXBzaG90LnN0YWxlO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsZWRMYXRlc3RTdW1tYXJ5KFxuICBpbnN0YWxsZWQ6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4gIGxhdGVzdDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgaW5zdGFsbGVkVGV4dCA9IGluc3RhbGxlZCB8fCBcIlVuYXZhaWxhYmxlXCI7XG4gIGNvbnN0IGxhdGVzdFRleHQgPSBsYXRlc3QgfHwgXCJVbmF2YWlsYWJsZVwiO1xuICByZXR1cm4gYEluc3RhbGxlZCAke2luc3RhbGxlZFRleHR9IFx1MDBCNyBMYXRlc3QgJHtsYXRlc3RUZXh0fSR7ZXJyb3IgPyBgIFx1MDBCNyAke2Vycm9yfWAgOiBcIlwifWA7XG59XG5cbmZ1bmN0aW9uIGNvZGV4UnVudGltZU1lc3NhZ2Uoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoc25hcHNob3QuZmFsbGJhY2tSZWFzb24pIHJldHVybiBgQmV0YSBjb3VsZCBub3Qgc3RhcnQ7IEJ1bmRsZWQgd2FzIHVzZWQuICR7c25hcHNob3QuZmFsbGJhY2tSZWFzb259YDtcbiAgaWYgKHNuYXBzaG90LnJlc3RhcnRSZXF1aXJlZCkgcmV0dXJuIFwiUmVzdGFydCB0aGUgYXBwIHRvIGFwcGx5IHRoZSBzZWxlY3RlZCBDb2RleCBydW50aW1lLlwiO1xuICBpZiAoc25hcHNob3QucmVxdWVzdGVkTGFuZSAmJiBzbmFwc2hvdC5lZmZlY3RpdmVMYW5lICYmIHNuYXBzaG90LnJlcXVlc3RlZExhbmUgIT09IHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUpIHtcbiAgICByZXR1cm4gYCR7c25hcHNob3QucmVxdWVzdGVkTGFuZSA9PT0gXCJiZXRhXCIgPyBcIkJldGFcIiA6IFwiQnVuZGxlZFwifSBpcyBzZWxlY3RlZDsgJHtzbmFwc2hvdC5lZmZlY3RpdmVMYW5lID09PSBcImJldGFcIiA/IFwiQmV0YVwiIDogXCJCdW5kbGVkXCJ9IHJlbWFpbnMgYWN0aXZlIHVudGlsIHJlc3RhcnQuYDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29kZXhTY29wZWRFcnJvcihcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgc2NvcGU6IFwiZGVza3RvcFwiIHwgQ29kZXhDbGlMYW5lLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzbmFwc2hvdC5lcnJvcnNbc2NvcGVdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzU2FmZUNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBpZiAoIXVybCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsKTtcbiAgICByZXR1cm4gcGFyc2VkLnByb3RvY29sID09PSBcImh0dHBzOlwiXG4gICAgICAmJiBwYXJzZWQuaG9zdG5hbWUgPT09IFwiZ2l0aHViLmNvbVwiXG4gICAgICAmJiBwYXJzZWQucG9ydCA9PT0gXCJcIlxuICAgICAgJiYgcGFyc2VkLnVzZXJuYW1lID09PSBcIlwiXG4gICAgICAmJiBwYXJzZWQucGFzc3dvcmQgPT09IFwiXCJcbiAgICAgICYmIChwYXJzZWQucGF0aG5hbWUgPT09IFwiL29wZW5haS9jb2RleFwiIHx8IHBhcnNlZC5wYXRobmFtZS5zdGFydHNXaXRoKFwiL29wZW5haS9jb2RleC9cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gb3BlbkNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNTYWZlQ29kZXhHaXRodWJVcmwodXJsKSkge1xuICAgIHBsb2coXCJibG9ja2VkIG5vbi1Db2RleCBHaXRIdWIgVVJMXCIsIHVybCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIHVybCkuY2F0Y2goKGVycm9yKSA9PiBwbG9nKFwib3BlbiBDb2RleCByZWxlYXNlIGZhaWxlZFwiLCBTdHJpbmcoZXJyb3IpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bkNvZGV4QWN0aW9uKFxuICByb3c6IEhUTUxFbGVtZW50LFxuICBjaGFubmVsOiBzdHJpbmcsXG4gIHBheWxvYWQ6IHVua25vd24sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IHZvaWQge1xuICBjb25zdCBidXR0b25zID0gcm93LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyB9KTtcbiAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgcmVsb2FkKFwib3BlcmF0aW9uLXN0YXJ0XCIpO1xuICBjb25zdCBpbnZva2UgPSBwYXlsb2FkID09PSB1bmRlZmluZWQgPyBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCkgOiBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCwgcGF5bG9hZCk7XG4gIHZvaWQgaW52b2tlXG4gICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgd2luZG93LmFsZXJ0KHNhZmVVaUVycm9yKGVycm9yKSk7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgICByZWxvYWQoXCJvcGVyYXRpb24tc3RvcFwiKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZVVpRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IgfHwgXCJVbmtub3duIGVycm9yXCIpO1xufVxuXG5mdW5jdGlvbiBodW1hbml6ZUNvZGV4UGhhc2UodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC8tL2csIFwiIFwiKS5yZXBsYWNlKC9cXGJcXHcvZywgKGxldHRlcikgPT4gbGV0dGVyLnRvVXBwZXJDYXNlKCkpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRCeXRlcyh2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlIDwgMTAyNCkgcmV0dXJuIGAke3ZhbHVlfSBCYDtcbiAgaWYgKHZhbHVlIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsodmFsdWUgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIHJldHVybiBgJHsodmFsdWUgLyAoMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpfSBNQmA7XG59XG5cbi8vIENvbmZpcm1hdGlvbiBjb3B5IGZvciBlYWNoIHN3aXRjaCBkaXJlY3Rpb24uIFN3aXRjaGluZyBpcyBhIHJlYWwgYnVuZGxlXG4vLyBzd2FwOiB0aGUgaW5zdGFsbGVyIENMSSBxdWl0cyB0aGUgYXBwLCBzd2FwcyBwYXlsb2FkcywgYW5kIHJlbGF1bmNoZXMuXG5jb25zdCBNT0RFX1NXSVRDSF9DT1BZOiBSZWNvcmQ8QXBwTW9kZVRhcmdldCwgeyB0aXRsZTogc3RyaW5nOyBib2R5OiBzdHJpbmc7IHJlc3RhcnRpbmc6IHN0cmluZyB9PiA9IHtcbiAgY2hhdGdwdDoge1xuICAgIHRpdGxlOiBcIlN3aXRjaCB0byB0aGUgb2ZmaWNpYWwgQ2hhdEdQVCBhcHA/XCIsXG4gICAgYm9keTogXCJDaGF0R1BUIHdpbGwgcXVpdCBhbmQgcmVzdGFydCBhcyB0aGUgb2ZmaWNpYWwgYXBwLiBUd2Vha3MgdHVybiBvZmY7IHRoZSBDaHJvbWUtZXh0ZW5zaW9uIGJyaWRnZSB0dXJucyBvbjsgc29tZSBtYWNPUyBwZXJtaXNzaW9ucyBtYXkgbmVlZCByZS1ncmFudGluZy5cIixcbiAgICByZXN0YXJ0aW5nOiBcIkNoYXRHUFQgaXMgcXVpdHRpbmcgYW5kIHdpbGwgcmVzdGFydCBhcyB0aGUgb2ZmaWNpYWwgYXBwLlwiLFxuICB9LFxuICB0d2Vha2Vyczoge1xuICAgIHRpdGxlOiBcIlN3aXRjaCB0byBUd2Vha2Vycz9cIixcbiAgICBib2R5OiBcIkNoYXRHUFQgd2lsbCBxdWl0IGFuZCByZXN0YXJ0IHdpdGggVHdlYWtlcnMgZW5hYmxlZC4gVHdlYWtzIHR1cm4gb247IHRoZSBDaHJvbWUtZXh0ZW5zaW9uIGJyaWRnZSB0dXJucyBvZmY7IHNvbWUgbWFjT1MgcGVybWlzc2lvbnMgbWF5IG5lZWQgcmUtZ3JhbnRpbmcuXCIsXG4gICAgcmVzdGFydGluZzogXCJDaGF0R1BUIGlzIHF1aXR0aW5nIGFuZCB3aWxsIHJlc3RhcnQgd2l0aCBUd2Vha2VycyBlbmFibGVkLlwiLFxuICB9LFxufTtcblxuY29uc3QgTU9ERV9ERVNDUklQVElPTlM6IFJlY29yZDxBcHBNb2RlVGFyZ2V0LCBzdHJpbmc+ID0ge1xuICBjaGF0Z3B0OiBcIk9wZW5BSSdzIHN0YW5kYXJkIGFwcCBleHBlcmllbmNlLlwiLFxuICB0d2Vha2VyczogXCJUaGUgc3RhbmRhcmQgYXBwIHdpdGggeW91ciBlbmFibGVkIFR3ZWFrZXJzIGZlYXR1cmVzLlwiLFxufTtcblxuLy8gSG93IGxvbmcgdGhlIGNvbnRyb2wgbWF5IHN0YXkgcGFya2VkIGluIFwiUmVzdGFydGluZ1x1MjAyNlwiIGFmdGVyIHRoZSBzd2l0Y2hcbi8vIGhlbHBlciB3YXMgc3VibWl0dGVkLiBBIHN3aXRjaCB0aGF0IHN0YXJ0cyBxdWl0cyB0aGlzIGFwcCB3ZWxsIHdpdGhpbiB0aGlzXG4vLyB3aW5kb3c7IGlmIHdlIGFyZSBzdGlsbCBhbGl2ZSBhZnRlcndhcmRzIHRoZSBDTEkgcmVmdXNlZCBwcmUtcXVpdCAoaXRzXG4vLyBzdGRpbyBpcyBkaXNjYXJkZWQgYmVoaW5kIGxhdW5jaGQpLCBhbmQgdGhpcyBVSSBpcyB0aGUgb25seSBwbGFjZSBsZWZ0IHRvXG4vLyBzYXkgc28uXG5jb25zdCBNT0RFX1NXSVRDSF9TVEFSVF9USU1FT1VUX01TID0gNDVfMDAwO1xuXG5mdW5jdGlvbiByZW5kZXJNb2RlU2VjdGlvbihzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBcHAgTW9kZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb3B5LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGNvbnN0IGRldGFpbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRldGFpbC5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgcm91bmRlZC1sZyBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0wLjVcIjtcblxuICAvLyBUaGlzIHNldHRpbmdzIFVJIG9ubHkgZXhpc3RzIGluc2lkZSB0aGUgcGF0Y2hlZCBidW5kbGUsIHNvIHdoZW4gdGhpc1xuICAvLyBzZWN0aW9uIHJlbmRlcnMgdGhlIGxpdmUgbW9kZSBpcyBhbHdheXMgXCJ0d2Vha2Vyc1wiIChpbiBjaGF0Z3B0IG1vZGVcbiAgLy8gbm90aGluZyBpcyBpbmplY3RlZCkuIFRoZSBjb250cm9sIHN0YXlzIHR3by1zaWRlZCBhbnl3YXk6IGl0IHJlZmxlY3RzXG4gIC8vIGJvdGggcGF5bG9hZHMgaG9uZXN0bHksIGFuZCB0aGUgaW5hY3RpdmUgc2lkZSBpcyB0aGUgZW50cnkgcG9pbnQgZm9yXG4gIC8vIHN3aXRjaGluZyBiYWNrIHRvIHRoZSBvZmZpY2lhbCBhcHAuXG4gIGNvbnN0IGN1cnJlbnRNb2RlOiBBcHBNb2RlVGFyZ2V0ID0gXCJ0d2Vha2Vyc1wiO1xuICBsZXQgc3dpdGNoaW5nVG86IEFwcE1vZGVUYXJnZXQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHN3aXRjaFN0YXJ0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgY2xlYXJTd2l0Y2hTdGFydFRpbWVyID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmIChzd2l0Y2hTdGFydFRpbWVyICE9PSBudWxsKSB7XG4gICAgICBjbGVhclRpbWVvdXQoc3dpdGNoU3RhcnRUaW1lcik7XG4gICAgICBzd2l0Y2hTdGFydFRpbWVyID0gbnVsbDtcbiAgICB9XG4gIH07XG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicGFnZWhpZGVcIiwgY2xlYXJTd2l0Y2hTdGFydFRpbWVyKTtcblxuICBjb25zdCBzdGFydFN3aXRjaCA9ICh0YXJnZXQ6IEFwcE1vZGVUYXJnZXQpOiB2b2lkID0+IHtcbiAgICBzd2l0Y2hpbmdUbyA9IHRhcmdldDtcbiAgICByZW5kZXIoKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwiY29kZXhwcDpzd2l0Y2gtYXBwLW1vZGVcIiwgeyB0YXJnZXQgfSlcbiAgICAgIC50aGVuKChyZXN1bHQ6IHsgb2s6IGJvb2xlYW47IG1lc3NhZ2U/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgICBpZiAocmVzdWx0Py5vaykge1xuICAgICAgICAgIC8vIG9rIG9ubHkgbWVhbnMgdGhlIGxhdW5jaGQgaGVscGVyIHdhcyBzdWJtaXR0ZWQgXHUyMDE0IHRoZSBDTEkgY2FuIHN0aWxsXG4gICAgICAgICAgLy8gcmVmdXNlIGJlZm9yZSBxdWl0dGluZyB0aGUgYXBwIChsb2NrIGNvbnRlbnRpb24sIG1pc3NpbmcgYmFja3VwLFxuICAgICAgICAgIC8vIHN3aXRjaGVyIHNldHVwIGZhaWx1cmUpIHdpdGggaXRzIG91dHB1dCBkaXNjYXJkZWQuIE5ldmVyIHBhcmsgdGhlXG4gICAgICAgICAgLy8gY29udHJvbCBmb3JldmVyOiBpZiB0aGlzIGFwcCBpcyBzdGlsbCBhbGl2ZSB3aGVuIHRoZSB0aW1lciBmaXJlcyxcbiAgICAgICAgICAvLyB0aGUgc3dpdGNoIGRpZCBub3Qgc3RhcnQuXG4gICAgICAgICAgY2xlYXJTd2l0Y2hTdGFydFRpbWVyKCk7XG4gICAgICAgICAgc3dpdGNoU3RhcnRUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgc3dpdGNoU3RhcnRUaW1lciA9IG51bGw7XG4gICAgICAgICAgICBzd2l0Y2hpbmdUbyA9IG51bGw7XG4gICAgICAgICAgICByZW5kZXIoKTtcbiAgICAgICAgICAgIGRldGFpbC50ZXh0Q29udGVudCA9XG4gICAgICAgICAgICAgIFwiVGhlIHN3aXRjaCBkaWQgbm90IHN0YXJ0IFx1MjAxNCBjaGVjayB0aGUgVHdlYWtlcnMgbWVudS1iYXIgc3dpdGNoZXIgb3IgcnVuIGB0d2Vha2VycyBtb2RlIHN0YXR1c2AuXCI7XG4gICAgICAgICAgfSwgTU9ERV9TV0lUQ0hfU1RBUlRfVElNRU9VVF9NUyk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIGNsZWFyU3dpdGNoU3RhcnRUaW1lcigpO1xuICAgICAgICBzd2l0Y2hpbmdUbyA9IG51bGw7XG4gICAgICAgIHJlbmRlcigpO1xuICAgICAgICBkZXRhaWwudGV4dENvbnRlbnQgPSByZXN1bHQ/Lm1lc3NhZ2UgfHwgXCJUaGUgbW9kZSBzd2l0Y2ggY291bGQgbm90IGJlIHN0YXJ0ZWQuXCI7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBjbGVhclN3aXRjaFN0YXJ0VGltZXIoKTtcbiAgICAgICAgc3dpdGNoaW5nVG8gPSBudWxsO1xuICAgICAgICByZW5kZXIoKTtcbiAgICAgICAgZGV0YWlsLnRleHRDb250ZW50ID0gc2FmZVVpRXJyb3IoZXJyb3IpO1xuICAgICAgICBwbG9nKFwic3dpdGNoIGFwcCBtb2RlIGZhaWxlZFwiLCBTdHJpbmcoZXJyb3IpKTtcbiAgICAgIH0pO1xuICB9O1xuXG4gIGNvbnN0IHJlbmRlciA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoc3dpdGNoaW5nVG8pIHtcbiAgICAgIHRpdGxlLnRleHRDb250ZW50ID0gXCJSZXN0YXJ0aW5nXHUyMDI2XCI7XG4gICAgICBkZXRhaWwudGV4dENvbnRlbnQgPSBNT0RFX1NXSVRDSF9DT1BZW3N3aXRjaGluZ1RvXS5yZXN0YXJ0aW5nO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aXRsZS50ZXh0Q29udGVudCA9IGFwcE1vZGVMYWJlbChjdXJyZW50TW9kZSk7XG4gICAgICBkZXRhaWwudGV4dENvbnRlbnQgPSBNT0RFX0RFU0NSSVBUSU9OU1tjdXJyZW50TW9kZV07XG4gICAgfVxuICAgIGFjdGlvbnMucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZm9yIChjb25zdCB0YXJnZXQgb2YgW1wiY2hhdGdwdFwiLCBcInR3ZWFrZXJzXCJdIGFzIGNvbnN0KSB7XG4gICAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYnV0dG9uLnRleHRDb250ZW50ID0gYXBwTW9kZUxhYmVsKHRhcmdldCk7XG4gICAgICBidXR0b24uZGlzYWJsZWQgPSBzd2l0Y2hpbmdUbyAhPT0gbnVsbCB8fCB0YXJnZXQgPT09IGN1cnJlbnRNb2RlO1xuICAgICAgYnV0dG9uLmNsYXNzTmFtZSA9IGByb3VuZGVkLW1kIHB4LTMgcHktMS41IHRleHQtc20gJHt0YXJnZXQgPT09IGN1cnJlbnRNb2RlID8gXCJiZy10b2tlbi1iZy1wcmltYXJ5IHNoYWRvdy1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiIDogXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOnRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCJ9YDtcbiAgICAgIGlmICh0YXJnZXQgIT09IGN1cnJlbnRNb2RlKSB7XG4gICAgICAgIC8vIENvbmZpcm1hdGlvbiBoYXBwZW5zIGhlcmUsIGluIHRoZSByZW5kZXJlciBcdTIwMTQgdGhlIElQQyBoYW5kbGVyIG5ldmVyXG4gICAgICAgIC8vIHByb21wdHMuIENvbmZpcm0gaGFuZHMgb2ZmIHRvIHRoZSBpbnN0YWxsZXIgQ0xJIHZpYSBsYXVuY2hkLlxuICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IG9wZW5Nb2RlU3dpdGNoTW9kYWwodGFyZ2V0LCAoKSA9PiBzdGFydFN3aXRjaCh0YXJnZXQpKSk7XG4gICAgICB9XG4gICAgICBhY3Rpb25zLmFwcGVuZChidXR0b24pO1xuICAgIH1cbiAgfTtcbiAgcmVuZGVyKCk7XG4gIGNvcHkuYXBwZW5kKHRpdGxlLCBkZXRhaWwpOyByb3cuYXBwZW5kKGNvcHksIGFjdGlvbnMpOyBjYXJkLmFwcGVuZChyb3cpOyBzZWN0aW9uLmFwcGVuZChjYXJkKTsgc2VjdGlvbnNXcmFwLmFwcGVuZChzZWN0aW9uKTtcbn1cblxuLyoqXG4gKiBTdHlsZWQgY29uZmlybWF0aW9uIG1vZGFsIGZvciBtb2RlIHN3aXRjaGVzLCBtYXRjaGluZyB0aGUgaW5qZWN0ZWRcbiAqIHNldHRpbmdzIGxvb2sgKHRva2VuIGNsYXNzZXMgKyBwYW5lbCBiYWNrZ3JvdW5kKSBpbnN0ZWFkIG9mIHRoZSBiYXJlXG4gKiB3aW5kb3cuY29uZmlybSB1c2VkIGJ5IG9sZGVyIGZsb3dzLiBDb25maXJtIFx1MjE5MiBvbkNvbmZpcm0oKTsgQ2FuY2VsL0VzY2FwZS9cbiAqIGJhY2tkcm9wIGNsaWNrIFx1MjE5MiBkaXNtaXNzIHdpdGhvdXQgc2lkZSBlZmZlY3RzLlxuICovXG5mdW5jdGlvbiBvcGVuTW9kZVN3aXRjaE1vZGFsKHRhcmdldDogQXBwTW9kZVRhcmdldCwgb25Db25maXJtOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmRhdGFzZXQuY29kZXhwcE1vZGVNb2RhbCA9IFwidHJ1ZVwiO1xuICBvdmVybGF5LmNsYXNzTmFtZSA9IFwiZml4ZWQgaW5zZXQtMCB6LVs5OTk5XSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBwLTRcIjtcbiAgY29uc3QgZGlhbG9nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJkaWFsb2dcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLW1vZGFsXCIsIFwidHJ1ZVwiKTtcbiAgZGlhbG9nLmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IHctZnVsbCBtYXgtdy1tZCBmbGV4LWNvbCBnYXAtNCByb3VuZGVkLTJ4bCBib3JkZXIgcC01IHNoYWRvdy14bFwiO1xuICBkaWFsb2cuc2V0QXR0cmlidXRlKFxuICAgIFwic3R5bGVcIixcbiAgICBcImJhY2tncm91bmQtY29sb3I6IHZhcigtLWNvbG9yLWJhY2tncm91bmQtcGFuZWwsIHZhcigtLWNvbG9yLXRva2VuLWJnLWZvZykpO1wiLFxuICApO1xuXG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGhlYWRpbmcudGV4dENvbnRlbnQgPSBNT0RFX1NXSVRDSF9DT1BZW3RhcmdldF0udGl0bGU7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkudGV4dENvbnRlbnQgPSBNT0RFX1NXSVRDSF9DT1BZW3RhcmdldF0uYm9keTtcblxuICBjb25zdCBidXR0b25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYnV0dG9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGNvbnN0IGNsb3NlID0gKCk6IHZvaWQgPT4ge1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG9uS2V5ZG93biwgdHJ1ZSk7XG4gICAgb3ZlcmxheS5yZW1vdmUoKTtcbiAgfTtcbiAgY29uc3Qgb25LZXlkb3duID0gKGV2ZW50OiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKGV2ZW50LmtleSAhPT0gXCJFc2NhcGVcIikgcmV0dXJuO1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgY2xvc2UoKTtcbiAgfTtcbiAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCBjbG9zZSk7XG4gIGNvbnN0IGNvbmZpcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb25maXJtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb25maXJtLmNsYXNzTmFtZSA9XG4gICAgXCJ1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBiZy10b2tlbi1jaGFydHMtYmx1ZSBweC0zIHRleHQtc20gdGV4dC13aGl0ZSBlbmFibGVkOmhvdmVyOm9wYWNpdHktOTAgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgY29uZmlybS50ZXh0Q29udGVudCA9IFwiU3dpdGNoICYgUmVzdGFydFwiO1xuICBjb25maXJtLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNsb3NlKCk7XG4gICAgb25Db25maXJtKCk7XG4gIH0pO1xuICBidXR0b25zLmFwcGVuZChjYW5jZWwsIGNvbmZpcm0pO1xuXG4gIGNvbnN0IG9wZW5lZEF0ID0gRGF0ZS5ub3coKTtcbiAgbGV0IHByZXNzQmVnYW5Pbk92ZXJsYXkgPSBmYWxzZTtcbiAgb3ZlcmxheS5hZGRFdmVudExpc3RlbmVyKFwibW91c2Vkb3duXCIsIChldmVudCkgPT4ge1xuICAgIHByZXNzQmVnYW5Pbk92ZXJsYXkgPSBldmVudC50YXJnZXQgPT09IG92ZXJsYXk7XG4gIH0pO1xuICBvdmVybGF5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICAvLyBCYWNrZHJvcCBkaXNtaXNzYWwgb25seSBjb3VudHMgd2hlbiB0aGUgcHJlc3MgYWxzbyBCRUdBTiBvbiB0aGVcbiAgICAvLyBiYWNrZHJvcCwgYW5kIG5ldmVyIGluc2lkZSB0aGUgb3BlbiBncmFjZSBwZXJpb2Q6IHRoZSBzZWNvbmQgY2xpY2sgb2YgYVxuICAgIC8vIGRvdWJsZS1jbGljayBvbiB0aGUgdHJpZ2dlciBidXR0b24gbGFuZHMgb24gdGhlIG92ZXJsYXkgdGhhdCBqdXN0XG4gICAgLy8gYXBwZWFyZWQgb3ZlciBpdCBhbmQgbXVzdCBub3QgaW5zdGFudGx5IGRpc21pc3MgdGhlIGRpYWxvZy5cbiAgICBpZiAoZXZlbnQudGFyZ2V0ICE9PSBvdmVybGF5IHx8ICFwcmVzc0JlZ2FuT25PdmVybGF5KSByZXR1cm47XG4gICAgaWYgKERhdGUubm93KCkgLSBvcGVuZWRBdCA8IDI1MCkgcmV0dXJuO1xuICAgIGNsb3NlKCk7XG4gIH0pO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICBkaWFsb2cuYXBwZW5kKGhlYWRpbmcsIGJvZHksIGJ1dHRvbnMpO1xuICBvdmVybGF5LmFwcGVuZENoaWxkKGRpYWxvZyk7XG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG4gIGNvbmZpcm0uZm9jdXMoKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhQbHVzUGx1c0NvbmZpZyhjYXJkOiBIVE1MRWxlbWVudCwgY29uZmlnOiBDb2RleFBsdXNQbHVzQ29uZmlnKTogdm9pZCB7XG4gIHNldFNpZGViYXJDb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uKGNvbmZpZy51cGRhdGVDaGVjayk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXV0b1VwZGF0ZVJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZCh1cGRhdGVDaGFubmVsUm93KGNvbmZpZykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGluc3RhbGxhdGlvblNvdXJjZVJvdyhjb25maWcuaW5zdGFsbGF0aW9uU291cmNlKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoc2VsZlVwZGF0ZVN0YXR1c1Jvdyhjb25maWcuc2VsZlVwZGF0ZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNoZWNrRm9yVXBkYXRlc1Jvdyhjb25maWcpKTtcbiAgaWYgKGNvbmZpZy51cGRhdGVDaGVjaz8ucmVsZWFzZU5vdGVzKSBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VOb3Rlc1Jvdyhjb25maWcudXBkYXRlQ2hlY2spKTtcbn1cblxuZnVuY3Rpb24gYXV0b1VwZGF0ZVJvdyhjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQXV0b21hdGljYWxseSByZWZyZXNoIFR3ZWFrZXJzXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGBJbnN0YWxsZWQgdmVyc2lvbiB2JHtjb25maWcudmVyc2lvbn0uIFRoZSB3YXRjaGVyIGNoZWNrcyBob3VybHkgYW5kIGNhbiByZWZyZXNoIHRoZSBUd2Vha2VycyBydW50aW1lIGF1dG9tYXRpY2FsbHkuYDtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woY29uZmlnLmF1dG9VcGRhdGUsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnNldC1hdXRvLXVwZGF0ZVwiLCBuZXh0KTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gdXBkYXRlQ2hhbm5lbFJvdyhjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIlJlbGVhc2UgY2hhbm5lbFwiLCB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWcpKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWxlY3RcIik7XG4gIHNlbGVjdC5jbGFzc05hbWUgPVxuICAgIFwiaC04IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdHJhbnNwYXJlbnQgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzOm91dGxpbmUtbm9uZVwiO1xuICBmb3IgKGNvbnN0IFt2YWx1ZSwgbGFiZWxdIG9mIFtcbiAgICBbXCJzdGFibGVcIiwgXCJTdGFibGVcIl0sXG4gICAgW1wicHJlcmVsZWFzZVwiLCBcIlByZXJlbGVhc2VcIl0sXG4gICAgW1wiY3VzdG9tXCIsIFwiQ3VzdG9tXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGlvblwiKTtcbiAgICBvcHRpb24udmFsdWUgPSB2YWx1ZTtcbiAgICBvcHRpb24udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICBvcHRpb24uc2VsZWN0ZWQgPSBjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gdmFsdWU7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gIH1cbiAgc2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgIC5pbnZva2UoXCJjb2RleHBwOnNldC11cGRhdGUtY29uZmlnXCIsIHsgdXBkYXRlQ2hhbm5lbDogc2VsZWN0LnZhbHVlIH0pXG4gICAgICAudGhlbigoKSA9PiByZWZyZXNoQ29uZmlnQ2FyZChyb3cpKVxuICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwic2V0IHVwZGF0ZSBjaGFubmVsIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgfSk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoc2VsZWN0KTtcbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcImN1c3RvbVwiKSB7XG4gICAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJFZGl0XCIsICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVwbyA9IHdpbmRvdy5wcm9tcHQoXCJHaXRIdWIgcmVwb1wiLCBjb25maWcudXBkYXRlUmVwbyB8fCBcInRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnNcIik7XG4gICAgICAgIGlmIChyZXBvID09PSBudWxsKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlZiA9IHdpbmRvdy5wcm9tcHQoXCJHaXQgcmVmXCIsIGNvbmZpZy51cGRhdGVSZWYgfHwgXCJtYWluXCIpO1xuICAgICAgICBpZiAocmVmID09PSBudWxsKSByZXR1cm47XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpzZXQtdXBkYXRlLWNvbmZpZ1wiLCB7XG4gICAgICAgICAgICB1cGRhdGVDaGFubmVsOiBcImN1c3RvbVwiLFxuICAgICAgICAgICAgdXBkYXRlUmVwbzogcmVwbyxcbiAgICAgICAgICAgIHVwZGF0ZVJlZjogcmVmLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENvbmZpZ0NhcmQocm93KSlcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJzZXQgY3VzdG9tIHVwZGF0ZSBzb3VyY2UgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsYXRpb25Tb3VyY2VSb3coc291cmNlOiBJbnN0YWxsYXRpb25Tb3VyY2UpOiBIVE1MRWxlbWVudCB7XG4gIHJldHVybiByb3dTaW1wbGUoXCJJbnN0YWxsYXRpb24gc291cmNlXCIsIGAke3NvdXJjZS5sYWJlbH06ICR7c291cmNlLmRldGFpbH1gKTtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1JvdyhzdGF0ZTogU2VsZlVwZGF0ZVN0YXRlIHwgbnVsbCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gcm93U2ltcGxlKFwiTGFzdCBUd2Vha2VycyB1cGRhdGVcIiwgc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGUpKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0ICYmIHN0YXRlKSB7XG4gICAgY29uc3QgdW5wdWJsaXNoZWQgPSBzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpO1xuICAgIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZSh1bnB1Ymxpc2hlZCA/IFwib2tcIiA6IHNlbGZVcGRhdGVTdGF0dXNUb25lKHN0YXRlLnN0YXR1cyksIHVucHVibGlzaGVkID8gXCJDdXJyZW50XCIgOiBzZWxmVXBkYXRlU3RhdHVzTGFiZWwoc3RhdGUuc3RhdHVzKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNoZWNrRm9yVXBkYXRlc1Jvdyhjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNoZWNrID0gY29uZmlnLnVwZGF0ZUNoZWNrO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID8gXCJUd2Vha2VycyB1cGRhdGUgYXZhaWxhYmxlXCIgOiBcIkNoZWNrIGZvciBUd2Vha2VycyB1cGRhdGVzXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IHVwZGF0ZVN1bW1hcnkoY2hlY2spO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgaWYgKGNoZWNrPy5yZWxlYXNlVXJsKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlIE5vdGVzXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgY2hlY2sucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwiY29kZXhwcDpjaGVjay1jb2RleHBwLXVwZGF0ZVwiLCB0cnVlKVxuICAgICAgICAudGhlbigoY2hlY2spID0+IHtcbiAgICAgICAgICBzZXRTaWRlYmFyQ29kZXhQbHVzUGx1c1VwZGF0ZUJ1dHRvbihjaGVjayBhcyBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2spO1xuICAgICAgICAgIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcIlR3ZWFrZXJzIHJlbGVhc2UgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgIH0pO1xuICAgIH0pLFxuICApO1xuICBpZiAoY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSkgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiRG93bmxvYWQgVXBkYXRlXCIsICgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCIwLjY1XCI7XG4gICAgICBjb25zdCBidXR0b25zID0gYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9ucy5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSB0cnVlKSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOnJ1bi1jb2RleHBwLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgcmVmcmVzaFNpZGViYXJDb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uKHRydWUpO1xuICAgICAgICAgIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgIHBsb2coXCJUd2Vha2VycyBzZWxmLXVwZGF0ZSBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgICAgICAgICB2b2lkIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgICAgYnV0dG9ucy5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSBmYWxzZSkpO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZWxlYXNlTm90ZXNSb3coY2hlY2s6IENvZGV4UGx1c1BsdXNVcGRhdGVDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMiBwLTNcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkxhdGVzdCByZWxlYXNlIG5vdGVzXCI7XG4gIHJvdy5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9XG4gICAgXCJtYXgtaC02MCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYm9keS5hcHBlbmRDaGlsZChyZW5kZXJSZWxlYXNlTm90ZXNNYXJrZG93bihjaGVjay5yZWxlYXNlTm90ZXM/LnRyaW0oKSB8fCBjaGVjay5lcnJvciB8fCBcIk5vIHJlbGVhc2Ugbm90ZXMgYXZhaWxhYmxlLlwiKSk7XG4gIHJvdy5hcHBlbmRDaGlsZChib2R5KTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24obWFya2Rvd246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIGNvbnN0IGxpbmVzID0gbWFya2Rvd24ucmVwbGFjZSgvXFxyXFxuPy9nLCBcIlxcblwiKS5zcGxpdChcIlxcblwiKTtcbiAgbGV0IHBhcmFncmFwaDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGxpc3Q6IEhUTUxPTGlzdEVsZW1lbnQgfCBIVE1MVUxpc3RFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjb2RlTGluZXM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgZmx1c2hQYXJhZ3JhcGggPSAoKSA9PiB7XG4gICAgaWYgKHBhcmFncmFwaC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInBcIik7XG4gICAgcC5jbGFzc05hbWUgPSBcIm0tMCBsZWFkaW5nLTVcIjtcbiAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihwLCBwYXJhZ3JhcGguam9pbihcIiBcIikudHJpbSgpKTtcbiAgICByb290LmFwcGVuZENoaWxkKHApO1xuICAgIHBhcmFncmFwaCA9IFtdO1xuICB9O1xuICBjb25zdCBmbHVzaExpc3QgPSAoKSA9PiB7XG4gICAgaWYgKCFsaXN0KSByZXR1cm47XG4gICAgcm9vdC5hcHBlbmRDaGlsZChsaXN0KTtcbiAgICBsaXN0ID0gbnVsbDtcbiAgfTtcbiAgY29uc3QgZmx1c2hDb2RlID0gKCkgPT4ge1xuICAgIGlmICghY29kZUxpbmVzKSByZXR1cm47XG4gICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInByZVwiKTtcbiAgICBwcmUuY2xhc3NOYW1lID1cbiAgICAgIFwibS0wIG92ZXJmbG93LWF1dG8gcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHAtMiB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgIGNvZGUudGV4dENvbnRlbnQgPSBjb2RlTGluZXMuam9pbihcIlxcblwiKTtcbiAgICBwcmUuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwcmUpO1xuICAgIGNvZGVMaW5lcyA9IG51bGw7XG4gIH07XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgaWYgKGxpbmUudHJpbSgpLnN0YXJ0c1dpdGgoXCJgYGBcIikpIHtcbiAgICAgIGlmIChjb2RlTGluZXMpIGZsdXNoQ29kZSgpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgICBjb2RlTGluZXMgPSBbXTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY29kZUxpbmVzKSB7XG4gICAgICBjb2RlTGluZXMucHVzaChsaW5lKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IGhlYWRpbmcgPSAvXigjezEsM30pXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChoZWFkaW5nKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChoZWFkaW5nWzFdLmxlbmd0aCA9PT0gMSA/IFwiaDNcIiA6IFwiaDRcIik7XG4gICAgICBoLmNsYXNzTmFtZSA9IFwibS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGgsIGhlYWRpbmdbMl0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHVub3JkZXJlZCA9IC9eWy0qXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBjb25zdCBvcmRlcmVkID0gL15cXGQrWy4pXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAodW5vcmRlcmVkIHx8IG9yZGVyZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBjb25zdCB3YW50T3JkZXJlZCA9IEJvb2xlYW4ob3JkZXJlZCk7XG4gICAgICBpZiAoIWxpc3QgfHwgKHdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJPTFwiKSB8fCAoIXdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJVTFwiKSkge1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQod2FudE9yZGVyZWQgPyBcIm9sXCIgOiBcInVsXCIpO1xuICAgICAgICBsaXN0LmNsYXNzTmFtZSA9IHdhbnRPcmRlcmVkXG4gICAgICAgICAgPyBcIm0tMCBsaXN0LWRlY2ltYWwgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCJcbiAgICAgICAgICA6IFwibS0wIGxpc3QtZGlzYyBzcGFjZS15LTEgcGwtNSBsZWFkaW5nLTVcIjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24obGksICh1bm9yZGVyZWQgPz8gb3JkZXJlZCk/LlsxXSA/PyBcIlwiKTtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQobGkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcXVvdGUgPSAvXj5cXHM/KC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHF1b3RlKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBibG9ja3F1b3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJsb2NrcXVvdGVcIik7XG4gICAgICBibG9ja3F1b3RlLmNsYXNzTmFtZSA9IFwibS0wIGJvcmRlci1sLTIgYm9yZGVyLXRva2VuLWJvcmRlciBwbC0zIGxlYWRpbmctNVwiO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24oYmxvY2txdW90ZSwgcXVvdGVbMV0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChibG9ja3F1b3RlKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHBhcmFncmFwaC5wdXNoKHRyaW1tZWQpO1xuICB9XG5cbiAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgZmx1c2hMaXN0KCk7XG4gIGZsdXNoQ29kZSgpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gYXBwZW5kSW5saW5lTWFya2Rvd24ocGFyZW50OiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHBhdHRlcm4gPSAvKGAoW15gXSspYHxcXFsoW15cXF1dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKXxcXCpcXCooW14qXSspXFwqXFwqfFxcKihbXipdKylcXCopL2c7XG4gIGxldCBsYXN0SW5kZXggPSAwO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHRleHQubWF0Y2hBbGwocGF0dGVybikpIHtcbiAgICBpZiAobWF0Y2guaW5kZXggPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgYXBwZW5kVGV4dChwYXJlbnQsIHRleHQuc2xpY2UobGFzdEluZGV4LCBtYXRjaC5pbmRleCkpO1xuICAgIGlmIChtYXRjaFsyXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNvZGVcIik7XG4gICAgICBjb2RlLmNsYXNzTmFtZSA9XG4gICAgICAgIFwicm91bmRlZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHB4LTEgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGNvZGUudGV4dENvbnRlbnQgPSBtYXRjaFsyXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChjb2RlKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzNdICE9PSB1bmRlZmluZWQgJiYgbWF0Y2hbNF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgICAgYS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IHVuZGVybGluZSB1bmRlcmxpbmUtb2Zmc2V0LTJcIjtcbiAgICAgIGEuaHJlZiA9IG1hdGNoWzRdO1xuICAgICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgICAgYS5yZWwgPSBcIm5vb3BlbmVyIG5vcmVmZXJyZXJcIjtcbiAgICAgIGEudGV4dENvbnRlbnQgPSBtYXRjaFszXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChhKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHN0cm9uZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHJvbmdcIik7XG4gICAgICBzdHJvbmcuY2xhc3NOYW1lID0gXCJmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgc3Ryb25nLnRleHRDb250ZW50ID0gbWF0Y2hbNV07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoc3Ryb25nKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzZdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImVtXCIpO1xuICAgICAgZW0udGV4dENvbnRlbnQgPSBtYXRjaFs2XTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChlbSk7XG4gICAgfVxuICAgIGxhc3RJbmRleCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICB9XG4gIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCkpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRUZXh0KHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodGV4dCkgcGFyZW50LmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRleHQpKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC13YXRjaGVyLWhlYWx0aFwiKVxuICAgIC50aGVuKChoZWFsdGgpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCBoZWFsdGggYXMgV2F0Y2hlckhlYWx0aCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgY2hlY2sgd2F0Y2hlclwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkOiBIVE1MRWxlbWVudCwgaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoKSk7XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgaGVhbHRoLmNoZWNrcykge1xuICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwib2tcIikgY29udGludWU7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyQ2hlY2tSb3coY2hlY2spKTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShoZWFsdGguc3RhdHVzLCBoZWFsdGgud2F0Y2hlcikpO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBoZWFsdGgudGl0bGU7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGAke2hlYWx0aC5zdW1tYXJ5fSBDaGVja2VkICR7bmV3IERhdGUoaGVhbHRoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBhY3Rpb24uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJDaGVja1JvdyhjaGVjazogV2F0Y2hlckhlYWx0aENoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSByb3dTaW1wbGUoY2hlY2submFtZSwgY2hlY2suZGV0YWlsKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0KSBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoY2hlY2suc3RhdHVzKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0JhZGdlKHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIGxhYmVsPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCB0b25lID1cbiAgICBzdGF0dXMgPT09IFwib2tcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtZ3JlZW4gdGV4dC10b2tlbi1jaGFydHMtZ3JlZW5cIlxuICAgICAgOiBzdGF0dXMgPT09IFwid2FyblwiXG4gICAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdyB0ZXh0LXRva2VuLWNoYXJ0cy15ZWxsb3dcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQgdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IGBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtICR7dG9uZX1gO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsIHx8IChzdGF0dXMgPT09IFwib2tcIiA/IFwiT0tcIiA6IHN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlJldmlld1wiIDogXCJFcnJvclwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KGNoZWNrOiBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2sgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjaGVjaykgcmV0dXJuIFwiTm8gdXBkYXRlIGNoZWNrIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBsYXRlc3QgPSBjaGVjay5sYXRlc3RWZXJzaW9uID8gYExhdGVzdCB2JHtjaGVjay5sYXRlc3RWZXJzaW9ufS4gYCA6IFwiXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBgQ2hlY2tlZCAke25ldyBEYXRlKGNoZWNrLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgaWYgKGNoZWNrLmVycm9yKSByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH0gJHtjaGVjay5lcnJvcn1gO1xuICByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH1gO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWc6IENvZGV4UGx1c1BsdXNDb25maWcpOiBzdHJpbmcge1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IFwiY3VzdG9tXCIpIHtcbiAgICByZXR1cm4gYCR7Y29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCJ9ICR7Y29uZmlnLnVwZGF0ZVJlZiB8fCBcIihubyByZWYgc2V0KVwifWA7XG4gIH1cbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcInByZXJlbGVhc2VcIikge1xuICAgIHJldHVybiBcIlVzZSB0aGUgbmV3ZXN0IHB1Ymxpc2hlZCBHaXRIdWIgcmVsZWFzZSwgaW5jbHVkaW5nIHByZXJlbGVhc2VzLlwiO1xuICB9XG4gIHJldHVybiBcIlVzZSB0aGUgbGF0ZXN0IHN0YWJsZSBHaXRIdWIgcmVsZWFzZS5cIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIXN0YXRlKSByZXR1cm4gXCJObyBhdXRvbWF0aWMgVHdlYWtlcnMgdXBkYXRlIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc3RhdGUuY29tcGxldGVkQXQgPz8gc3RhdGUuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICBjb25zdCB0YXJnZXQgPSBzdGF0ZS5sYXRlc3RWZXJzaW9uID8gYCBUYXJnZXQgdiR7c3RhdGUubGF0ZXN0VmVyc2lvbn0uYCA6IHN0YXRlLnRhcmdldFJlZiA/IGAgVGFyZ2V0ICR7c3RhdGUudGFyZ2V0UmVmfS5gIDogXCJcIjtcbiAgY29uc3Qgc291cmNlID0gc3RhdGUuaW5zdGFsbGF0aW9uU291cmNlPy5sYWJlbCA/PyBcInVua25vd24gc291cmNlXCI7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpKSByZXR1cm4gYFNvdXJjZSBjaGVja291dCBpcyBjdXJyZW50IGFzIG9mICR7Y2hlY2tlZH07IG5vIHB1Ymxpc2hlZCByZWxlYXNlIGV4aXN0cyB5ZXQuYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIGBVcGRhdGUgY2hlY2sgbmVlZHMgYXR0ZW50aW9uICgke2NoZWNrZWR9KS4gJHtzdGF0ZS5lcnJvciA/PyBcIlVua25vd24gZXJyb3JcIn1gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcInVwZGF0ZWRcIikgcmV0dXJuIGBVcGRhdGVkICR7Y2hlY2tlZH0uJHt0YXJnZXR9IFNvdXJjZTogJHtzb3VyY2V9LmA7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gYFVwIHRvIGRhdGUgJHtjaGVja2VkfS4ke3RhcmdldH0gU291cmNlOiAke3NvdXJjZX0uYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gYFNraXBwZWQgJHtjaGVja2VkfTsgYXV0b21hdGljIHJlZnJlc2ggaXMgZGlzYWJsZWQuYDtcbiAgcmV0dXJuIGBDaGVja2luZyBmb3IgdXBkYXRlcy4gU291cmNlOiAke3NvdXJjZX0uYDtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1RvbmUoc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAoc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIgfHwgc3RhdHVzID09PSBcImNoZWNraW5nXCIpIHJldHVybiBcIndhcm5cIjtcbiAgcmV0dXJuIFwib2tcIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gXCJVcCB0byBkYXRlXCI7XG4gIGlmIChzdGF0dXMgPT09IFwidXBkYXRlZFwiKSByZXR1cm4gXCJVcGRhdGVkXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcIkZhaWxlZFwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIpIHJldHVybiBcIkRpc2FibGVkXCI7XG4gIHJldHVybiBcIkNoZWNraW5nXCI7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hDb25maWdDYXJkKHJvdzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgY2FyZCA9IHJvdy5jbG9zZXN0KFwiW2RhdGEtY29kZXhwcC1jb25maWctY2FyZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWNhcmQpIHJldHVybjtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUmVmcmVzaGluZ1wiLCBcIkxvYWRpbmcgY3VycmVudCBUd2Vha2VycyB1cGRhdGUgc3RhdHVzLlwiKSk7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwiY29kZXhwcDpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJDb2RleFBsdXNQbHVzQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBDb2RleFBsdXNQbHVzQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWZyZXNoIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIFR3ZWFrZXJzXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS1jb2RleHBwLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcImNvZGV4cHA6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly5jb2RleC1wbHVzcGx1cy9zb3VyY2UvcGFja2FnZXMvaW5zdGFsbGVyL2Rpc3QvY2xpLmpzIHVuaW5zdGFsbFwiKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjb3B5IHVuaW5zdGFsbCBjb21tYW5kIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVwb3J0QnVnUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiUmVwb3J0IGEgYnVnXCIsXG4gICAgXCJPcGVuIGEgR2l0SHViIGlzc3VlIHdpdGggcnVudGltZSwgaW5zdGFsbGVyLCBvciB0d2Vhay1tYW5hZ2VyIGRldGFpbHMuXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJPcGVuIElzc3VlXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHRpdGxlID0gZW5jb2RlVVJJQ29tcG9uZW50KFwiW0J1Z106IFwiKTtcbiAgICAgIGNvbnN0IGJvZHkgPSBlbmNvZGVVUklDb21wb25lbnQoXG4gICAgICAgIFtcbiAgICAgICAgICBcIiMjIFdoYXQgaGFwcGVuZWQ/XCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIFN0ZXBzIHRvIHJlcHJvZHVjZVwiLFxuICAgICAgICAgIFwiMS4gXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIEVudmlyb25tZW50XCIsXG4gICAgICAgICAgXCItIFR3ZWFrZXJzIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBDb2RleCBhcHAgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIE9TOiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgTG9nc1wiLFxuICAgICAgICAgIFwiQXR0YWNoIHJlbGV2YW50IGxpbmVzIGZyb20gdGhlIFR3ZWFrZXJzIGxvZyBkaXJlY3RvcnkuXCIsXG4gICAgICAgIF0uam9pbihcIlxcblwiKSxcbiAgICAgICk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIixcbiAgICAgICAgYGh0dHBzOi8vZ2l0aHViLmNvbS90aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzL2lzc3Vlcy9uZXc/dGl0bGU9JHt0aXRsZX0mYm9keT0ke2JvZHl9YCxcbiAgICAgICk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGFjdGlvblJvdyh0aXRsZVRleHQ6IHN0cmluZywgZGVzY3JpcHRpb246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gdGl0bGVUZXh0O1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuZGF0YXNldC5jb2RleHBwUm93QWN0aW9ucyA9IFwidHJ1ZVwiO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha1N0b3JlUGFnZShcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgaGVhZGVyQWN0aW9ucz86IEhUTUxFbGVtZW50LFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTRcIjtcblxuICBjb25zdCBzb3VyY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgc291cmNlLmhpZGRlbiA9IHRydWU7XG4gIHNvdXJjZS5kYXRhc2V0LmNvZGV4cHBTdG9yZVNvdXJjZSA9IFwidHJ1ZVwiO1xuICBzb3VyY2UudGV4dENvbnRlbnQgPSBcIkxvYWRpbmcgbGl2ZSByZWdpc3RyeVwiO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgcmVmcmVzaEJ0biA9IHN0b3JlSWNvbkJ1dHRvbihyZWZyZXNoSWNvblN2ZygpLCBcIlJlZnJlc2ggdHdlYWsgc3RvcmVcIiwgKCkgPT4ge1xuICAgIHJlZnJlc2hCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UobnVsbCk7XG4gICAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgcmVuZGVyVHdlYWtTdG9yZUdob3N0R3JpZChncmlkKTtcbiAgICByZWZyZXNoVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlLCByZWZyZXNoQnRuLCB0cnVlKTtcbiAgfSk7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQocmVmcmVzaEJ0bik7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVUb29sYmFyQnV0dG9uKFwiUHVibGlzaCBUd2Vha1wiLCBvcGVuUHVibGlzaFR3ZWFrRGlhbG9nLCBcInByaW1hcnlcIikpO1xuICBpZiAoaGVhZGVyQWN0aW9ucykge1xuICAgIGhlYWRlckFjdGlvbnMucmVwbGFjZUNoaWxkcmVuKGFjdGlvbnMpO1xuICB9XG5cbiAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyaWQuZGF0YXNldC5jb2RleHBwU3RvcmVHcmlkID0gXCJ0cnVlXCI7XG4gIGdyaWQuY2xhc3NOYW1lID0gXCJncmlkIGdhcC00XCI7XG4gIGlmIChzdGF0ZS50d2Vha1N0b3JlKSB7XG4gICAgZ3JpZC5kYXRhc2V0LmNvZGV4cHBTdG9yZSA9IEpTT04uc3RyaW5naWZ5KHN0YXRlLnR3ZWFrU3RvcmUpO1xuICAgIHJlbmRlclR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSk7XG4gIH0gZWxzZSB7XG4gICAgcmVuZGVyVHdlYWtTdG9yZUdob3N0R3JpZChncmlkKTtcbiAgfVxuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNvdXJjZSk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoZ3JpZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSwgcmVmcmVzaEJ0bik7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChcbiAgZ3JpZDogSFRNTEVsZW1lbnQsXG4gIHNvdXJjZTogSFRNTEVsZW1lbnQsXG4gIHJlZnJlc2hCdG4/OiBIVE1MQnV0dG9uRWxlbWVudCxcbiAgZm9yY2UgPSBmYWxzZSxcbik6IHZvaWQge1xuICB2b2lkIGdldFR3ZWFrU3RvcmUoZm9yY2UpXG4gICAgLnRoZW4oKHN0b3JlKSA9PiB7XG4gICAgICBncmlkLmRhdGFzZXQuY29kZXhwcFN0b3JlID0gSlNPTi5zdHJpbmdpZnkoc3RvcmUpO1xuICAgICAgcmVuZGVyVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgZ3JpZC5kYXRhc2V0LmNvZGV4cHBTdG9yZSA9IFwiXCI7XG4gICAgICBncmlkLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgICAgIHNvdXJjZS50ZXh0Q29udGVudCA9IFwiTGl2ZSByZWdpc3RyeSB1bmF2YWlsYWJsZVwiO1xuICAgICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShudWxsKTtcbiAgICAgIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgZ3JpZC5hcHBlbmRDaGlsZChzdG9yZU1lc3NhZ2VDYXJkKFwiQ291bGQgbm90IGxvYWQgdHdlYWsgc3RvcmVcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICBpZiAocmVmcmVzaEJ0bikgcmVmcmVzaEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiB3YXJtVHdlYWtTdG9yZSgpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUgfHwgc3RhdGUudHdlYWtTdG9yZVByb21pc2UpIHJldHVybjtcbiAgdm9pZCBnZXRUd2Vha1N0b3JlKCkudGhlbigoc3RvcmUpID0+IHtcbiAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChzdG9yZS5lbnRyaWVzKSk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBnZXRUd2Vha1N0b3JlKGZvcmNlID0gZmFsc2UpOiBQcm9taXNlPFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXc+IHtcbiAgaWYgKCFmb3JjZSkge1xuICAgIGlmIChzdGF0ZS50d2Vha1N0b3JlKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHN0YXRlLnR3ZWFrU3RvcmUpO1xuICAgIGlmIChzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSkgcmV0dXJuIHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlO1xuICB9XG4gIHN0YXRlLnR3ZWFrU3RvcmVFcnJvciA9IG51bGw7XG4gIGNvbnN0IHByb21pc2UgPSBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJjb2RleHBwOmdldC10d2Vhay1zdG9yZVwiKVxuICAgIC50aGVuKChzdG9yZSkgPT4ge1xuICAgICAgc3RhdGUudHdlYWtTdG9yZSA9IHN0b3JlIGFzIFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXc7XG4gICAgICByZXR1cm4gc3RhdGUudHdlYWtTdG9yZTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgc3RhdGUudHdlYWtTdG9yZUVycm9yID0gZTtcbiAgICAgIHRocm93IGU7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICBpZiAoc3RhdGUudHdlYWtTdG9yZVByb21pc2UgPT09IHByb21pc2UpIHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlID0gbnVsbDtcbiAgICB9KTtcbiAgc3RhdGUudHdlYWtTdG9yZVByb21pc2UgPSBwcm9taXNlO1xuICByZXR1cm4gcHJvbWlzZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtTdG9yZUdyaWQoZ3JpZDogSFRNTEVsZW1lbnQsIHNvdXJjZTogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgc3RvcmUgPSBwYXJzZVN0b3JlRGF0YXNldChncmlkKTtcbiAgaWYgKCFzdG9yZSkgcmV0dXJuO1xuICBjb25zdCBlbnRyaWVzID0gc3RvcmUuZW50cmllcztcbiAgZ3JpZC5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIik7XG4gIHNvdXJjZS50ZXh0Q29udGVudCA9IGBSZWZyZXNoZWQgJHtuZXcgRGF0ZShzdG9yZS5mZXRjaGVkQXQpLnRvTG9jYWxlU3RyaW5nKCl9YDtcbiAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShvdXRkYXRlZEluc3RhbGxlZFN0b3JlQ291bnQoZW50cmllcykpO1xuICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgaWYgKHN0b3JlLmVudHJpZXMubGVuZ3RoID09PSAwKSB7XG4gICAgZ3JpZC5hcHBlbmRDaGlsZChzdG9yZU1lc3NhZ2VDYXJkKFwiTm8gdHdlYWtzIHlldFwiLCBcIlVzZSBQdWJsaXNoIFR3ZWFrIHRvIHN1Ym1pdCB0aGUgZmlyc3Qgb25lLlwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykgZ3JpZC5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlQ2FyZChlbnRyeSkpO1xufVxuXG5mdW5jdGlvbiBwYXJzZVN0b3JlRGF0YXNldChncmlkOiBIVE1MRWxlbWVudCk6IFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXcgfCBudWxsIHtcbiAgY29uc3QgcmF3ID0gZ3JpZC5kYXRhc2V0LmNvZGV4cHBTdG9yZTtcbiAgaWYgKCFyYXcpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykgYXMgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZUNhcmQoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHNoZWxsID0gdHdlYWtTdG9yZUNhcmRTaGVsbCgpO1xuICBjb25zdCB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9ID0gc2hlbGw7XG5cbiAgbGVmdC5pbnNlcnRCZWZvcmUoc3RvcmVBdmF0YXIoZW50cnkpLCBzdGFjayk7XG5cbiAgY29uc3QgdGl0bGVSb3cgPSB0d2Vha1N0b3JlVGl0bGVSb3coKTtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1sZyBmb250LXNlbWlib2xkIGxlYWRpbmctNyB0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBlbnRyeS5tYW5pZmVzdC5uYW1lO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcmlmaWVkU2FmZUJhZGdlKCkpO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgaWYgKGVudHJ5Lm1hbmlmZXN0LmRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZGVzYyA9IHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpO1xuICAgIGRlc2MudGV4dENvbnRlbnQgPSBlbnRyeS5tYW5pZmVzdC5kZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgfVxuXG4gIHN0YWNrLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVSZWFkTW9yZUJ1dHRvbihlbnRyeS5yZXBvID8/IGVudHJ5Lm1hbmlmZXN0LmdpdGh1YlJlcG8pKTtcbiAgdmVyc2lvbnMuYXBwZW5kQ2hpbGQodHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeSkpO1xuXG4gIGlmIChlbnRyeS5yZWxlYXNlVXJsKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgZW50cnkucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGhhc1VwZGF0ZSA9ICEhZW50cnkuaW5zdGFsbGVkICYmIGVudHJ5Lmluc3RhbGxlZC52ZXJzaW9uICE9PSBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uO1xuICBpZiAoZW50cnkuYXZhaWxhYmxlID09PSBmYWxzZSkge1xuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcIm9wYWNpdHktNzBcIik7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwoXCJOb3QgYXZhaWxhYmxlIHlldFwiKSk7XG4gIH0gZWxzZSBpZiAoZW50cnkuaW5zdGFsbGVkICYmICFoYXNVcGRhdGUpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIkluc3RhbGxlZFwiKSk7XG4gIH0gZWxzZSBpZiAoZW50cnkucGxhdGZvcm0gJiYgIWVudHJ5LnBsYXRmb3JtLmNvbXBhdGlibGUpIHtcbiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJvcGFjaXR5LTcwXCIpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKHBsYXRmb3JtTG9ja2VkTGFiZWwoZW50cnkucGxhdGZvcm0pKSk7XG4gIH0gZWxzZSBpZiAoZW50cnkucnVudGltZSAmJiAhZW50cnkucnVudGltZS5jb21wYXRpYmxlKSB7XG4gICAgY2FyZC5jbGFzc0xpc3QuYWRkKFwib3BhY2l0eS03MFwiKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChydW50aW1lTG9ja2VkTGFiZWwoZW50cnkucnVudGltZSkpKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpbnN0YWxsTGFiZWwgPSBlbnRyeS5pbnN0YWxsZWQgPyBcIlVwZGF0ZVwiIDogXCJJbnN0YWxsXCI7XG4gICAgaWYgKGhhc1VwZGF0ZSkgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwoXCJVcGRhdGUgYXZhaWxhYmxlXCIsIFwiaW5mb1wiKSk7XG4gICAgY29uc3QgaW5zdGFsbEJ1dHRvbiA9IHN0b3JlSW5zdGFsbEJ1dHRvbihpbnN0YWxsTGFiZWwsIChidXR0b24pID0+IHtcbiAgICAgIGNvbnN0IGdyaWQgPSBjYXJkLmNsb3Nlc3QoXCJbZGF0YS1jb2RleHBwLXN0b3JlLWdyaWRdXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIGNvbnN0IHNvdXJjZSA9IGdyaWQ/LnBhcmVudEVsZW1lbnQ/LnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1jb2RleHBwLXN0b3JlLXNvdXJjZV1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgc2hvd1N0b3JlQnV0dG9uTG9hZGluZyhidXR0b24sIGVudHJ5Lmluc3RhbGxlZCA/IFwiVXBkYXRpbmdcIiA6IFwiSW5zdGFsbGluZ1wiKTtcbiAgICAgIGFjdGlvbnMucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvblwiKS5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSB0cnVlKSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJjb2RleHBwOmluc3RhbGwtc3RvcmUtdHdlYWtcIiwgZW50cnkuaWQpXG4gICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICBzaG93U3RvcmVUb2FzdChgJHtlbnRyeS5tYW5pZmVzdC5uYW1lfSBpbnN0YWxsZWQuYCk7XG4gICAgICAgICAgc2hvd1N0b3JlQnV0dG9uSW5zdGFsbGVkKGJ1dHRvbik7XG4gICAgICAgICAgdmVyc2lvbnMucmVwbGFjZUNoaWxkcmVuKHR3ZWFrU3RvcmVWZXJzaW9uQmFkZ2UoZW50cnksIGVudHJ5Lm1hbmlmZXN0LnZlcnNpb24pKTtcbiAgICAgICAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKE1hdGgubWF4KDAsIGN1cnJlbnRTdG9yZVVwZGF0ZUJhZGdlQ291bnQoKSAtIDEpKTtcbiAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICAgIGFjdGlvbnMucmVwbGFjZUNoaWxkcmVuKHN0b3JlU3RhdHVzUGlsbChcIkluc3RhbGxlZFwiKSk7XG4gICAgICAgICAgICBpZiAoZ3JpZCAmJiBzb3VyY2UpIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UsIHVuZGVmaW5lZCwgdHJ1ZSk7XG4gICAgICAgICAgfSwgOTAwKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICAgICAgcmVzZXRTdG9yZUluc3RhbGxCdXR0b24oYnV0dG9uLCBpbnN0YWxsTGFiZWwpO1xuICAgICAgICAgIGFjdGlvbnMucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvblwiKS5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSBmYWxzZSkpO1xuICAgICAgICAgIHNob3dTdG9yZUNhcmRNZXNzYWdlKGNhcmQsIFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSA/PyBlKSk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoaW5zdGFsbEJ1dHRvbik7XG4gIH1cbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHBsYXRmb3JtTG9ja2VkTGFiZWwocGxhdGZvcm06IE5vbk51bGxhYmxlPFR3ZWFrU3RvcmVFbnRyeVZpZXdbXCJwbGF0Zm9ybVwiXT4pOiBzdHJpbmcge1xuICBjb25zdCBzdXBwb3J0ZWQgPSBwbGF0Zm9ybS5zdXBwb3J0ZWQgPz8gW107XG4gIGlmIChzdXBwb3J0ZWQuaW5jbHVkZXMoXCJ3aW4zMlwiKSkgcmV0dXJuIFwiV2luZG93cyBvbmx5XCI7XG4gIGlmIChzdXBwb3J0ZWQuaW5jbHVkZXMoXCJkYXJ3aW5cIikpIHJldHVybiBcIm1hY09TIG9ubHlcIjtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcImxpbnV4XCIpKSByZXR1cm4gXCJMaW51eCBvbmx5XCI7XG4gIHJldHVybiBcIlVuYXZhaWxhYmxlXCI7XG59XG5cbmZ1bmN0aW9uIHJ1bnRpbWVMb2NrZWRMYWJlbChydW50aW1lOiBOb25OdWxsYWJsZTxUd2Vha1N0b3JlRW50cnlWaWV3W1wicnVudGltZVwiXT4pOiBzdHJpbmcge1xuICByZXR1cm4gcnVudGltZS5yZXF1aXJlZCA/IGBSZXF1aXJlcyBUd2Vha2VycyAke3J1bnRpbWUucmVxdWlyZWR9YCA6IFwiUmVxdWlyZXMgbmV3ZXIgVHdlYWtlcnNcIjtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlQ2FyZE1lc3NhZ2UoY2FyZDogSFRNTEVsZW1lbnQsIG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBjYXJkLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1jb2RleHBwLXN0b3JlLWNhcmQtbWVzc2FnZV1cIik/LnJlbW92ZSgpO1xuICBjb25zdCBub3RpY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBub3RpY2UuZGF0YXNldC5jb2RleHBwU3RvcmVDYXJkTWVzc2FnZSA9IFwidHJ1ZVwiO1xuICBub3RpY2UuY2xhc3NOYW1lID1cbiAgICBcInJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIvNTAgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTMgcHktMiB0ZXh0LXNtIGxlYWRpbmctNSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgbm90aWNlLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgY29uc3QgYWN0aW9ucyA9IGNhcmQubGFzdEVsZW1lbnRDaGlsZDtcbiAgaWYgKGFjdGlvbnMpIGNhcmQuaW5zZXJ0QmVmb3JlKG5vdGljZSwgYWN0aW9ucyk7XG4gIGVsc2UgY2FyZC5hcHBlbmRDaGlsZChub3RpY2UpO1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlQ2FyZFNoZWxsKCk6IHtcbiAgY2FyZDogSFRNTEVsZW1lbnQ7XG4gIGxlZnQ6IEhUTUxFbGVtZW50O1xuICBzdGFjazogSFRNTEVsZW1lbnQ7XG4gIHZlcnNpb25zOiBIVE1MRWxlbWVudDtcbiAgYWN0aW9uczogSFRNTEVsZW1lbnQ7XG59IHtcbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNhcmQuY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIvNDAgZmxleCBtaW4taC1bMTkwcHhdIGZsZXgtY29sIGp1c3RpZnktYmV0d2VlbiBnYXAtNCByb3VuZGVkLTJ4bCBib3JkZXIgcC00IHRyYW5zaXRpb24tY29sb3JzIGhvdmVyOmJnLXRva2VuLWZvcmVncm91bmQvNVwiO1xuXG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMlwiO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBmb290ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBmb290ZXIuY2xhc3NOYW1lID0gXCJtdC1hdXRvIGZsZXggbWluLXctMCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMlwiO1xuICBjb25zdCB2ZXJzaW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHZlcnNpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgZm9vdGVyLmFwcGVuZENoaWxkKHZlcnNpb25zKTtcbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWVuZCBnYXAtMlwiO1xuICBmb290ZXIuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoZm9vdGVyKTtcblxuICByZXR1cm4geyBjYXJkLCBsZWZ0LCBzdGFjaywgdmVyc2lvbnMsIGFjdGlvbnMgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVRpdGxlUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgcmV0dXJuIHRpdGxlUm93O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlRGVzY3JpcHRpb24oKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcImxpbmUtY2xhbXAtMyBtaW4tdy0wIHRleHQtc20gbGVhZGluZy01IHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgcmV0dXJuIGRlc2M7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVSZWFkTW9yZUJ1dHRvbihyZXBvOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IHJlYWRNb3JlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgcmVhZE1vcmUudHlwZSA9IFwiYnV0dG9uXCI7XG4gIHJlYWRNb3JlLmNsYXNzTmFtZSA9XG4gICAgXCJpbmxpbmUtZmxleCB3LWZpdCBpdGVtcy1jZW50ZXIgZ2FwLTEgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtbGluay1mb3JlZ3JvdW5kIGhvdmVyOnVuZGVybGluZVwiO1xuICByZWFkTW9yZS5pbm5lckhUTUwgPVxuICAgIGBSZWFkIE1vcmVgICtcbiAgICBgPHN2ZyB3aWR0aD1cIjE0XCIgaGVpZ2h0PVwiMTRcIiB2aWV3Qm94PVwiMCAwIDE2IDE2XCIgZmlsbD1cIm5vbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk02IDMuNWg2LjVWMTBNMTIuMjUgMy43NSA0IDEyXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS40NVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YDtcbiAgcmVhZE1vcmUuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgYGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG99YCk7XG4gIH0pO1xuICByZXR1cm4gcmVhZE1vcmU7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrU3RvcmVHaG9zdEdyaWQoZ3JpZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgZ3JpZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIiwgXCJ0cnVlXCIpO1xuICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgZ3JpZC5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlR2hvc3RDYXJkKCkpO1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlR2hvc3RDYXJkKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgeyBjYXJkLCBsZWZ0LCBzdGFjaywgdmVyc2lvbnMsIGFjdGlvbnMgfSA9IHR3ZWFrU3RvcmVDYXJkU2hlbGwoKTtcbiAgY2FyZC5jbGFzc0xpc3QuYWRkKFwicG9pbnRlci1ldmVudHMtbm9uZVwiKTtcbiAgY2FyZC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhpZGRlblwiLCBcInRydWVcIik7XG5cbiAgbGVmdC5pbnNlcnRCZWZvcmUoc3RvcmVBdmF0YXJHaG9zdCgpLCBzdGFjayk7XG5cbiAgY29uc3QgdGl0bGVSb3cgPSB0d2Vha1N0b3JlVGl0bGVSb3coKTtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1sZyBmb250LXNlbWlib2xkIGxlYWRpbmctNyB0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgdGl0bGUuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm15LTEgaC01IHctNDQgcm91bmRlZC1tZFwiKSk7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyaWZpZWRTYWZlR2hvc3RCYWRnZSgpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuXG4gIGNvbnN0IGRlc2MgPSB0d2Vha1N0b3JlRGVzY3JpcHRpb24oKTtcbiAgZGVzYy5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXQtMSBoLTMgdy1mdWxsIHJvdW5kZWRcIikpO1xuICBkZXNjLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJtdC0yIGgtMyB3LTExLzEyIHJvdW5kZWRcIikpO1xuICBkZXNjLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJtdC0yIGgtMyB3LTcvMTIgcm91bmRlZFwiKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuXG4gIGNvbnN0IHJlYWRNb3JlID0gdHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKFwiXCIpO1xuICByZWFkTW9yZS5yZXBsYWNlQ2hpbGRyZW4oZ2hvc3RCbG9jayhcImgtNSB3LTI0IHJvdW5kZWRcIikpO1xuICBzdGFjay5hcHBlbmRDaGlsZChyZWFkTW9yZSk7XG5cbiAgdmVyc2lvbnMuYXBwZW5kQ2hpbGQoc3RvcmVWZXJzaW9uR2hvc3RCYWRnZSgpKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c0dob3N0UGlsbCgpKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHN0b3JlQXZhdGFyR2hvc3QoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC0xMCB3LTEwIHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci1kZWZhdWx0IGJnLXRyYW5zcGFyZW50IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcImgtZnVsbCB3LWZ1bGxcIikpO1xuICByZXR1cm4gYXZhdGFyO1xufVxuXG5mdW5jdGlvbiB2ZXJpZmllZFNhZmVHaG9zdEJhZGdlKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSB2ZXJpZmllZFNhZmVCYWRnZSgpO1xuICBiYWRnZS5yZXBsYWNlQ2hpbGRyZW4oZ2hvc3RCbG9jayhcImgtWzEzcHhdIHctWzEzcHhdIHJvdW5kZWQtc21cIiksIGdob3N0QmxvY2soXCJoLTMgdy0yMCByb3VuZGVkXCIpKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBzdG9yZVN0YXR1c0dob3N0UGlsbCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHBpbGwgPSBzdG9yZVN0YXR1c1BpbGwoXCJJbnN0YWxsZWRcIik7XG4gIHBpbGwuY2xhc3NMaXN0LmFkZChcImFuaW1hdGUtcHVsc2VcIik7XG4gIHBpbGwuc3R5bGUuY29sb3IgPSBcInRyYW5zcGFyZW50XCI7XG4gIHJldHVybiBwaWxsO1xufVxuXG5mdW5jdGlvbiBzdG9yZVZlcnNpb25HaG9zdEJhZGdlKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBzdG9yZVZlcnNpb25CYWRnZVNoZWxsKGZhbHNlKTtcbiAgYmFkZ2UuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcImgtMyB3LTM2IHJvdW5kZWRcIikpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIGdob3N0QmxvY2soY2xhc3NOYW1lOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJsb2NrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYmxvY2suY2xhc3NOYW1lID0gYGFuaW1hdGUtcHVsc2UgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCAke2NsYXNzTmFtZX1gO1xuICBibG9jay5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhpZGRlblwiLCBcInRydWVcIik7XG4gIHJldHVybiBibG9jaztcbn1cblxuZnVuY3Rpb24gc3RvcmVBdmF0YXIoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTEwIHctMTAgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLWRlZmF1bHQgYmctdHJhbnNwYXJlbnQgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIGNvbnN0IGluaXRpYWwgPSAoZW50cnkubWFuaWZlc3QubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICBjb25zdCBmYWxsYmFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBmYWxsYmFjay50ZXh0Q29udGVudCA9IGluaXRpYWw7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChmYWxsYmFjayk7XG4gIGNvbnN0IGljb25VcmwgPSBzdG9yZUVudHJ5SWNvblVybChlbnRyeSk7XG4gIGlmIChpY29uVXJsKSB7XG4gICAgY29uc3QgaW1nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImltZ1wiKTtcbiAgICBpbWcuYWx0ID0gXCJcIjtcbiAgICBpbWcuY2xhc3NOYW1lID0gXCJoLWZ1bGwgdy1mdWxsIG9iamVjdC1jb3ZlclwiO1xuICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJsb2FkXCIsICgpID0+IHtcbiAgICAgIGZhbGxiYWNrLnJlbW92ZSgpO1xuICAgICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuICAgIH0pO1xuICAgIGltZy5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKCkgPT4ge1xuICAgICAgaW1nLnJlbW92ZSgpO1xuICAgIH0pO1xuICAgIGltZy5zcmMgPSBpY29uVXJsO1xuICAgIGF2YXRhci5hcHBlbmRDaGlsZChpbWcpO1xuICB9XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHN0b3JlRW50cnlJY29uVXJsKGVudHJ5OiBUd2Vha1N0b3JlRW50cnlWaWV3KTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGljb25VcmwgPSBlbnRyeS5tYW5pZmVzdC5pY29uVXJsPy50cmltKCk7XG4gIGlmICghaWNvblVybCkgcmV0dXJuIG51bGw7XG4gIGlmICgvXihodHRwcz86fGRhdGE6KS9pLnRlc3QoaWNvblVybCkpIHJldHVybiBpY29uVXJsO1xuICBjb25zdCByZWwgPSBpY29uVXJsLnJlcGxhY2UoL15cXC4/XFwvLywgXCJcIik7XG4gIGlmICghcmVsIHx8IHJlbC5zdGFydHNXaXRoKFwiLi4vXCIpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJidW5kbGVkXCIgfHwgIWVudHJ5LnJlcG8gfHwgIWVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGBodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vJHtlbnRyeS5yZXBvfS8ke2VudHJ5LmFwcHJvdmVkQ29tbWl0U2hhfS8ke3JlbH1gO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyVXBkYXRlUGlsbEJ1dHRvbigpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmRhdGFzZXQuY29kZXhwcFNpZGViYXJVcGRhdGUgPSBcInRydWVcIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJ1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcFwiO1xuICBPYmplY3QuYXNzaWduKGJ0bi5zdHlsZSwge1xuICAgIGRpc3BsYXk6IFwibm9uZVwiLFxuICAgIGhlaWdodDogXCIyMHB4XCIsXG4gICAgYm9yZGVyUmFkaXVzOiBcIjk5OTlweFwiLFxuICAgIGJvcmRlcjogXCIwXCIsXG4gICAgYmFja2dyb3VuZDogXCIjMEE4NEZGXCIsXG4gICAgY29sb3I6IFwiI0ZGRkZGRlwiLFxuICAgIHBhZGRpbmc6IFwiMCA4cHhcIixcbiAgICBmb250U2l6ZTogXCIxMHB4XCIsXG4gICAgZm9udFdlaWdodDogXCI3MDBcIixcbiAgICBsaW5lSGVpZ2h0OiBcIjIwcHhcIixcbiAgICBsZXR0ZXJTcGFjaW5nOiBcIjBcIixcbiAgICB0ZXh0VHJhbnNmb3JtOiBcIm5vbmVcIixcbiAgICBib3hTaGFkb3c6IFwiMCAxcHggMnB4IHJnYmEoMCwgMCwgMCwgMC4xOClcIixcbiAgfSk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IFwiVXBkYXRlXCI7XG4gIGJ0bi50aXRsZSA9IFwiT3BlbiBUd2Vha2VycyB1cGRhdGVcIjtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWVudGVyXCIsICgpID0+IHtcbiAgICBidG4uc3R5bGUuYmFja2dyb3VuZCA9IFwiIzAwNzFFM1wiO1xuICB9KTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWxlYXZlXCIsICgpID0+IHtcbiAgICBidG4uc3R5bGUuYmFja2dyb3VuZCA9IFwiIzBBODRGRlwiO1xuICB9KTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpvcGVuLWV4dGVybmFsXCIsIGJ0bi5kYXRhc2V0LmNvZGV4cHBSZWxlYXNlVXJsIHx8IFRXRUFLRVJTX1JFTEVBU0VTX1VSTCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByZWZyZXNoU2lkZWJhckNvZGV4UGx1c1BsdXNVcGRhdGVCdXR0b24oZm9yY2UgPSBmYWxzZSk6IHZvaWQge1xuICBjb25zdCBidG4gPSBzdGF0ZS5jb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uO1xuICBpZiAoIWJ0bikgcmV0dXJuO1xuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcImNvZGV4cHA6Y2hlY2stY29kZXhwcC11cGRhdGVcIiwgZm9yY2UpXG4gICAgLnRoZW4oKGNoZWNrKSA9PiBzZXRTaWRlYmFyQ29kZXhQbHVzUGx1c1VwZGF0ZUJ1dHRvbihjaGVjayBhcyBDb2RleFBsdXNQbHVzVXBkYXRlQ2hlY2spKVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgcGxvZyhcIlR3ZWFrZXJzIHNpZGViYXIgcmVsZWFzZSBjaGVjayBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgICAgIHNldFNpZGViYXJDb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uKG51bGwpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBzZXRTaWRlYmFyQ29kZXhQbHVzUGx1c1VwZGF0ZUJ1dHRvbihjaGVjazogQ29kZXhQbHVzUGx1c1VwZGF0ZUNoZWNrIHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCBidG4gPSBzdGF0ZS5jb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uO1xuICBpZiAoIWJ0bikgcmV0dXJuO1xuICBjb25zdCB1cGRhdGVBdmFpbGFibGUgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID09PSB0cnVlO1xuICBidG4uc3R5bGUuZGlzcGxheSA9IHVwZGF0ZUF2YWlsYWJsZSA/IFwiaW5saW5lLWZsZXhcIiA6IFwibm9uZVwiO1xuICBidG4uaGlkZGVuID0gIXVwZGF0ZUF2YWlsYWJsZTtcbiAgYnRuLmRhdGFzZXQuY29kZXhwcFJlbGVhc2VVcmwgPSBjaGVjaz8ucmVsZWFzZVVybCB8fCBUV0VBS0VSU19SRUxFQVNFU19VUkw7XG4gIGJ0bi50aXRsZSA9XG4gICAgdXBkYXRlQXZhaWxhYmxlICYmIGNoZWNrPy5sYXRlc3RWZXJzaW9uXG4gICAgICA/IGBPcGVuIFR3ZWFrZXJzICR7Y2hlY2subGF0ZXN0VmVyc2lvbn0gdXBkYXRlYFxuICAgICAgOiBcIk9wZW4gVHdlYWtlcnMgdXBkYXRlXCI7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UoY291bnQ6IG51bWJlciB8IG51bGwpOiB2b2lkIHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtc3RvcmUtdXBkYXRlLWJhZGdlXVwiKTtcbiAgaWYgKCFiYWRnZSkgcmV0dXJuO1xuICBiYWRnZS5kYXRhc2V0LmNvZGV4cHBTdG9yZVVwZGF0ZUNvdW50ID0gY291bnQgPT09IG51bGwgPyBcIlwiIDogU3RyaW5nKGNvdW50KTtcbiAgYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2UsIGNvdW50KTtcbiAgYmFkZ2UuaGlkZGVuID0gY291bnQgPT09IG51bGwgfHwgY291bnQgPD0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBjb3VudCAmJiBjb3VudCA+IDAgPyBTdHJpbmcoY291bnQpIDogXCJcIjtcbiAgYmFkZ2UudGl0bGUgPVxuICAgIGNvdW50ICYmIGNvdW50ID4gMFxuICAgICAgPyBgJHtjb3VudH0gaW5zdGFsbGVkIHR3ZWFrJHtjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gY2FuIGJlIHVwZGF0ZWRgXG4gICAgICA6IFwiSW5zdGFsbGVkIHR3ZWFrcyBhcmUgdXAgdG8gZGF0ZVwiO1xufVxuXG5mdW5jdGlvbiBhcHBseVN0b3JlVXBkYXRlQmFkZ2VTdHlsZShiYWRnZTogSFRNTEVsZW1lbnQsIGNvdW50OiBudW1iZXIgfCBudWxsKTogdm9pZCB7XG4gIGNvbnN0IGhhc1VwZGF0ZXMgPSAhIWNvdW50ICYmIGNvdW50ID4gMDtcbiAgT2JqZWN0LmFzc2lnbihiYWRnZS5zdHlsZSwge1xuICAgIG1pbldpZHRoOiBcIjI0cHhcIixcbiAgICBoZWlnaHQ6IFwiMjBweFwiLFxuICAgIGJvcmRlclJhZGl1czogXCI5OTk5cHhcIixcbiAgICBib3JkZXI6IFwiMFwiLFxuICAgIGJhY2tncm91bmQ6IGhhc1VwZGF0ZXMgPyBcIiMwQTg0RkZcIiA6IFwidHJhbnNwYXJlbnRcIixcbiAgICBjb2xvcjogXCIjRkZGRkZGXCIsXG4gICAgcGFkZGluZzogXCIwIDdweFwiLFxuICAgIGZvbnRTaXplOiBcIjEycHhcIixcbiAgICBmb250V2VpZ2h0OiBcIjcwMFwiLFxuICAgIGxpbmVIZWlnaHQ6IFwiMjBweFwiLFxuICAgIGxldHRlclNwYWNpbmc6IFwiMFwiLFxuICAgIGJveFNoYWRvdzogaGFzVXBkYXRlcyA/IFwiMCAxcHggMnB4IHJnYmEoMCwgMCwgMCwgMC4yMilcIiA6IFwibm9uZVwiLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gY3VycmVudFN0b3JlVXBkYXRlQmFkZ2VDb3VudCgpOiBudW1iZXIge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1zdG9yZS11cGRhdGUtYmFkZ2VdXCIpO1xuICBjb25zdCByYXcgPSBiYWRnZT8uZGF0YXNldC5jb2RleHBwU3RvcmVVcGRhdGVDb3VudDtcbiAgY29uc3QgcGFyc2VkID0gcmF3ID8gTnVtYmVyKHJhdykgOiAwO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgPyBwYXJzZWQgOiAwO1xufVxuXG5mdW5jdGlvbiBvdXRkYXRlZEluc3RhbGxlZFN0b3JlQ291bnQoZW50cmllczogVHdlYWtTdG9yZUVudHJ5Vmlld1tdKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVudHJpZXMuZmlsdGVyKChlbnRyeSkgPT4gISFlbnRyeS5pbnN0YWxsZWQgJiYgZW50cnkuaW5zdGFsbGVkLnZlcnNpb24gIT09IGVudHJ5Lm1hbmlmZXN0LnZlcnNpb24pLmxlbmd0aDtcbn1cblxuZnVuY3Rpb24gc3RvcmVUb29sYmFyQnV0dG9uKFxuICBsYWJlbDogc3RyaW5nLFxuICBvbkNsaWNrOiAoKSA9PiB2b2lkLFxuICB2YXJpYW50OiBcInByaW1hcnlcIiB8IFwic2Vjb25kYXJ5XCIgPSBcInNlY29uZGFyeVwiLFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIHZhcmlhbnQgPT09IFwicHJpbWFyeVwiXG4gICAgICA/IFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IGl0ZW1zLWNlbnRlciBnYXAtMSB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWJnLWZvZyBweC0yIHB5LTAgdGV4dC1zbSB0ZXh0LXRva2VuLWJ1dHRvbi10ZXJ0aWFyeS1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCJcbiAgICAgIDogXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10cmFuc3BhcmVudCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wIHRleHQtc20gdGV4dC10b2tlbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tZm9yZWdyb3VuZC8xMCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MFwiO1xuICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIHN0b3JlSWNvbkJ1dHRvbihcbiAgaWNvblN2Zzogc3RyaW5nLFxuICBsYWJlbDogc3RyaW5nLFxuICBvbkNsaWNrOiAoKSA9PiB2b2lkLFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IHctOCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRyYW5zcGFyZW50IGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTAgdGV4dC10b2tlbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tZm9yZWdyb3VuZC8xMCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MFwiO1xuICBidG4uaW5uZXJIVE1MID0gaWNvblN2ZztcbiAgY29uc3RyYWluU2lkZWJhckljb25TdmcoYnRuLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIiksIDE4KTtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbGFiZWwpO1xuICBidG4udGl0bGUgPSBsYWJlbDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hJY29uU3ZnKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIxOFwiIGhlaWdodD1cIjE4XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJpY29uLXhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNC40IDkuMzVBNS42NSA1LjY1IDAgMCAxIDE0IDUuM0wxNS43NSA3TTE1Ljc1IDMuNzVWN2gtMy4yNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xNS42IDEwLjY1QTUuNjUgNS42NSAwIDAgMSA2IDE0LjdMNC4yNSAxM000LjI1IDE2LjI1VjEzSDcuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB2ZXJpZmllZFNhZmVCYWRnZSgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9XG4gICAgXCJpbmxpbmUtZmxleCBoLTYgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0xLjUgcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci8zMCBiZy10cmFuc3BhcmVudCBweC0yIHRleHQteHMgZm9udC1tZWRpdW0gdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIGJhZGdlLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxM1wiIGhlaWdodD1cIjEzXCIgdmlld0JveD1cIjAgMCAxNCAxNFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJ0ZXh0LWJsdWUtNTAwXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNyAxLjc1IDExLjI1IDMuNHYzLjJjMCAyLjYtMS42NSA0LjI1LTQuMjUgNS40LTIuNi0xLjE1LTQuMjUtMi44LTQuMjUtNS40VjMuNEw3IDEuNzVaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS4xNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQuODUgNy4wNSA2LjMgOC40NWwyLjg1LTMuMDVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjI1XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+VmVyaWZpZWQgYXMgc2FmZTwvc3Bhbj5gO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVWZXJzaW9uQmFkZ2UoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcsIGluc3RhbGxlZE92ZXJyaWRlPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBpbnN0YWxsZWQgPSBpbnN0YWxsZWRPdmVycmlkZSA/PyBlbnRyeS5pbnN0YWxsZWQ/LnZlcnNpb24gPz8gbnVsbDtcbiAgY29uc3QgbGF0ZXN0ID0gZW50cnkubWFuaWZlc3QudmVyc2lvbjtcbiAgY29uc3QgaGFzVXBkYXRlID0gISFpbnN0YWxsZWQgJiYgaW5zdGFsbGVkICE9PSBsYXRlc3Q7XG4gIGNvbnN0IGJhZGdlID0gc3RvcmVWZXJzaW9uQmFkZ2VTaGVsbChoYXNVcGRhdGUpO1xuICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBsYWJlbC5jbGFzc05hbWUgPSBcInRydW5jYXRlXCI7XG4gIGxhYmVsLnRleHRDb250ZW50ID0gaW5zdGFsbGVkXG4gICAgPyBgSW5zdGFsbGVkIHYke2luc3RhbGxlZH0gXHUwMEI3IExhdGVzdCB2JHtsYXRlc3R9YFxuICAgIDogYExhdGVzdCB2JHtsYXRlc3R9YDtcbiAgYmFkZ2UudGl0bGUgPSBpbnN0YWxsZWRcbiAgICA/IGBJbnN0YWxsZWQgdmVyc2lvbiAke2luc3RhbGxlZH0uIExhdGVzdCBhcHByb3ZlZCB2ZXJzaW9uICR7bGF0ZXN0fS5gXG4gICAgOiBgTGF0ZXN0IGFwcHJvdmVkIHZlcnNpb24gJHtsYXRlc3R9LmA7XG4gIGJhZGdlLmFwcGVuZENoaWxkKGxhYmVsKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBzdG9yZVZlcnNpb25CYWRnZVNoZWxsKGhhc1VwZGF0ZTogYm9vbGVhbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gW1xuICAgIFwiaW5saW5lLWZsZXggaC04IG1pbi13LTAgbWF4LXctZnVsbCBpdGVtcy1jZW50ZXIgcm91bmRlZC1sZyBib3JkZXIgcHgtMi41IHRleHQteHMgZm9udC1tZWRpdW1cIixcbiAgICBoYXNVcGRhdGVcbiAgICAgID8gXCJib3JkZXItYmx1ZS01MDAvMzAgYmctYmx1ZS01MDAvMTAgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCJcbiAgICAgIDogXCJib3JkZXItdG9rZW4tYm9yZGVyLzQwIGJnLXRva2VuLWZvcmVncm91bmQvNSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIixcbiAgXS5qb2luKFwiIFwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBzdG9yZVN0YXR1c1BpbGwobGFiZWw6IHN0cmluZywgdG9uZTogXCJuZXV0cmFsXCIgfCBcImluZm9cIiA9IFwibmV1dHJhbFwiKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBwaWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHBpbGwuY2xhc3NOYW1lID0gW1xuICAgIFwiaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIHB4LTMgdGV4dC1zbSBmb250LW1lZGl1bVwiLFxuICAgIHRvbmUgPT09IFwiaW5mb1wiXG4gICAgICA/IFwiYm9yZGVyIGJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLWZvcmVncm91bmRcIlxuICAgICAgOiBcImJnLXRva2VuLWZvcmVncm91bmQvNSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIixcbiAgXS5qb2luKFwiIFwiKTtcbiAgcGlsbC50ZXh0Q29udGVudCA9IGxhYmVsO1xuICByZXR1cm4gcGlsbDtcbn1cblxuZnVuY3Rpb24gc3RvcmVJbnN0YWxsQnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6IChidXR0b246IEhUTUxCdXR0b25FbGVtZW50KSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljayhidG4pO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoZXh0cmEgPSBcIlwiKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtcbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCBtaW4tdy1bODJweF0gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGdhcC0xLjUgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLWJsdWUtNTAwLzQwIGJnLWJsdWUtNTAwIHB4LTMgcHktMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBzaGFkb3ctc20gdHJhbnNpdGlvbi1jb2xvcnMgZW5hYmxlZDpob3ZlcjpiZy1ibHVlLTYwMCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS04MFwiLFxuICAgIGV4dHJhLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlQnV0dG9uTG9hZGluZyhidXR0b246IEhUTUxCdXR0b25FbGVtZW50LCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGJ1dHRvbi5jbGFzc05hbWUgPSBzdG9yZUluc3RhbGxCdXR0b25DbGFzcygpO1xuICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1idXN5XCIsIFwidHJ1ZVwiKTtcbiAgYnV0dG9uLmlubmVySFRNTCA9XG4gICAgYDxzdmcgY2xhc3M9XCJhbmltYXRlLXNwaW5cIiB3aWR0aD1cIjE0XCIgaGVpZ2h0PVwiMTRcIiB2aWV3Qm94PVwiMCAwIDE2IDE2XCIgZmlsbD1cIm5vbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjhcIiBjeT1cIjhcIiByPVwiNS41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMlwiIG9wYWNpdHk9XCIuMjVcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTMuNSA4QTUuNSA1LjUgMCAwIDAgOCAyLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIyXCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YCArXG4gICAgYDxzcGFuPiR7bGFiZWx9PC9zcGFuPmA7XG59XG5cbmZ1bmN0aW9uIHNob3dTdG9yZUJ1dHRvbkluc3RhbGxlZChidXR0b246IEhUTUxCdXR0b25FbGVtZW50KTogdm9pZCB7XG4gIGJ1dHRvbi5jbGFzc05hbWUgPSBzdG9yZUluc3RhbGxCdXR0b25DbGFzcyhcImJvcmRlci1ibHVlLTUwMCBiZy1ibHVlLTUwMFwiKTtcbiAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgYnV0dG9uLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNFwiIGhlaWdodD1cIjE0XCIgdmlld0JveD1cIjAgMCAxNiAxNlwiIGZpbGw9XCJub25lXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMy43NSA4LjE1IDYuNjUgMTEgMTIuMjUgNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuOFwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YCArXG4gICAgYDxzcGFuPkluc3RhbGxlZDwvc3Bhbj5gO1xufVxuXG5mdW5jdGlvbiByZXNldFN0b3JlSW5zdGFsbEJ1dHRvbihidXR0b246IEhUTUxCdXR0b25FbGVtZW50LCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGJ1dHRvbi5jbGFzc05hbWUgPSBzdG9yZUluc3RhbGxCdXR0b25DbGFzcygpO1xuICBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTtcbiAgYnV0dG9uLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgYnV0dG9uLnRleHRDb250ZW50ID0gbGFiZWw7XG59XG5cbmZ1bmN0aW9uIHNob3dTdG9yZVRvYXN0KG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgaG9zdCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtY29kZXhwcC1zdG9yZS10b2FzdC1ob3N0XVwiKTtcbiAgaWYgKCFob3N0KSB7XG4gICAgaG9zdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgaG9zdC5kYXRhc2V0LmNvZGV4cHBTdG9yZVRvYXN0SG9zdCA9IFwidHJ1ZVwiO1xuICAgIGhvc3QuY2xhc3NOYW1lID0gXCJwb2ludGVyLWV2ZW50cy1ub25lIGZpeGVkIGJvdHRvbS01IHJpZ2h0LTUgei1bOTk5OV0gZmxleCBmbGV4LWNvbCBpdGVtcy1lbmQgZ2FwLTJcIjtcbiAgICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKGhvc3QpO1xuICB9XG4gIGNvbnN0IHRvYXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9hc3QuY2xhc3NOYW1lID1cbiAgICBcInRyYW5zbGF0ZS15LTIgcm91bmRlZC14bCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci81MCBiZy10b2tlbi1tYWluLXN1cmZhY2UtcHJpbWFyeSBweC0zIHB5LTIgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWZvcmVncm91bmQgb3BhY2l0eS0wIHNoYWRvdy1sZyB0cmFuc2l0aW9uLWFsbCBkdXJhdGlvbi0yMDBcIjtcbiAgdG9hc3QudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICBob3N0LmFwcGVuZENoaWxkKHRvYXN0KTtcbiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICB0b2FzdC5jbGFzc0xpc3QucmVtb3ZlKFwidHJhbnNsYXRlLXktMlwiLCBcIm9wYWNpdHktMFwiKTtcbiAgfSk7XG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHRvYXN0LmNsYXNzTGlzdC5hZGQoXCJ0cmFuc2xhdGUteS0yXCIsIFwib3BhY2l0eS0wXCIpO1xuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgdG9hc3QucmVtb3ZlKCk7XG4gICAgICBpZiAoaG9zdCAmJiBob3N0LmNoaWxkRWxlbWVudENvdW50ID09PSAwKSBob3N0LnJlbW92ZSgpO1xuICAgIH0sIDIyMCk7XG4gIH0sIDI2MDApO1xufVxuXG5mdW5jdGlvbiBzdG9yZU1lc3NhZ2VDYXJkKHRpdGxlOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlci80MCBmbGV4IG1pbi1oLVs4NHB4XSBmbGV4LWNvbCBqdXN0aWZ5LWNlbnRlciBnYXAtMSByb3VuZGVkLTJ4bCBib3JkZXIgcC00IHRleHQtc21cIjtcbiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHQuY2xhc3NOYW1lID0gXCJmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGl0bGU7XG4gIGNhcmQuYXBwZW5kQ2hpbGQodCk7XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gICAgZC50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoZCk7XG4gIH1cbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHNob3J0U2hhKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUuc2xpY2UoMCwgNyk7XG59XG5cbnR5cGUgQWN0aW9uTWVudUl0ZW0gPSB7IGxhYmVsOiBzdHJpbmc7IG9uU2VsZWN0OiAoKSA9PiB2b2lkIH07XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrc1BhZ2Uoc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCk6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uW10+KCk7XG4gIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzdGF0ZS5zZWN0aW9ucy52YWx1ZXMoKSkge1xuICAgIGNvbnN0IHR3ZWFrSWQgPSBzZWN0aW9uLmlkLnNwbGl0KFwiOlwiKVswXTtcbiAgICBpZiAoIXNlY3Rpb25zQnlUd2Vhay5oYXModHdlYWtJZCkpIHNlY3Rpb25zQnlUd2Vhay5zZXQodHdlYWtJZCwgW10pO1xuICAgIHNlY3Rpb25zQnlUd2Vhay5nZXQodHdlYWtJZCkhLnB1c2goc2VjdGlvbik7XG4gIH1cblxuICBjb25zdCBwYWdlc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgUmVnaXN0ZXJlZFBhZ2VbXT4oKTtcbiAgZm9yIChjb25zdCBwYWdlIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFwYWdlc0J5VHdlYWsuaGFzKHBhZ2UudHdlYWtJZCkpIHBhZ2VzQnlUd2Vhay5zZXQocGFnZS50d2Vha0lkLCBbXSk7XG4gICAgcGFnZXNCeVR3ZWFrLmdldChwYWdlLnR3ZWFrSWQpIS5wdXNoKHBhZ2UpO1xuICB9XG5cbiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICB3cmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtM1wiO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQod3JhcCk7XG5cbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXIuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zXCI7XG4gIHdyYXAuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3QgdGFicyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRhYnMuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInRhYmxpc3RcIik7XG4gIHRhYnMuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkZpbHRlciB0d2Vha3NcIik7XG4gIHRhYnMuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIHRvb2xiYXIuYXBwZW5kQ2hpbGQodGFicyk7XG5cbiAgY29uc3QgdG9vbGJhckFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyQWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIHRvb2xiYXIuYXBwZW5kQ2hpbGQodG9vbGJhckFjdGlvbnMpO1xuXG4gIGNvbnN0IHNlYXJjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNlYXJjaC5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciB3LTU2IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0yIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1pbnB1dC1ib3JkZXIgYmctdG9rZW4taW5wdXQtYmFja2dyb3VuZC83NSBweC0yLjUgdGV4dC1iYXNlIHNoYWRvdy1zbVwiO1xuICBzZWFyY2guaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE2XCIgaGVpZ2h0PVwiMTZcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cImljb24tc20gc2hyaW5rLTAgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiOVwiIGN5PVwiOVwiIHI9XCI1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIvPmAgK1xuICAgIGA8cGF0aCBkPVwibTEzIDEzIDMuNSAzLjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBjb25zdCBzZWFyY2hMYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsYWJlbFwiKTtcbiAgc2VhcmNoTGFiZWwuY2xhc3NOYW1lID0gXCJzci1vbmx5XCI7XG4gIHNlYXJjaExhYmVsLmh0bWxGb3IgPSBcImNvZGV4cHAtdHdlYWtzLXNlYXJjaFwiO1xuICBzZWFyY2hMYWJlbC50ZXh0Q29udGVudCA9IFwiU2VhcmNoIHR3ZWFrc1wiO1xuICBjb25zdCBzZWFyY2hJbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgc2VhcmNoSW5wdXQuaWQgPSBcImNvZGV4cHAtdHdlYWtzLXNlYXJjaFwiO1xuICBzZWFyY2hJbnB1dC50eXBlID0gXCJzZWFyY2hcIjtcbiAgc2VhcmNoSW5wdXQucGxhY2Vob2xkZXIgPSBcIlNlYXJjaCB0d2Vha3NcIjtcbiAgc2VhcmNoSW5wdXQudmFsdWUgPSBzdGF0ZS50d2Vha3NQYWdlUXVlcnk7XG4gIHNlYXJjaElucHV0LmNsYXNzTmFtZSA9XG4gICAgXCJtaW4tdy0wIGZsZXgtMSBiZy10cmFuc3BhcmVudCB0ZXh0LWJhc2UgdGV4dC10b2tlbi1pbnB1dC1mb3JlZ3JvdW5kIG91dGxpbmUtbm9uZSBwbGFjZWhvbGRlcjp0ZXh0LXRva2VuLWlucHV0LXBsYWNlaG9sZGVyLWZvcmVncm91bmRcIjtcbiAgY29uc3QgY2xlYXJTZWFyY2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjbGVhclNlYXJjaC50eXBlID0gXCJidXR0b25cIjtcbiAgY2xlYXJTZWFyY2guc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNsZWFyIHNlYXJjaFwiKTtcbiAgY2xlYXJTZWFyY2guY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGN1cnNvci1pbnRlcmFjdGlvbiB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOnRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBjbGVhclNlYXJjaC5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwiaWNvbi1zbVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwibTYgNiA4IDhNMTQgNmwtOCA4XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YDtcbiAgY2xlYXJTZWFyY2guaGlkZGVuID0gc3RhdGUudHdlYWtzUGFnZVF1ZXJ5Lmxlbmd0aCA9PT0gMDtcbiAgc2VhcmNoLmFwcGVuZChzZWFyY2hMYWJlbCwgc2VhcmNoSW5wdXQsIGNsZWFyU2VhcmNoKTtcbiAgdG9vbGJhckFjdGlvbnMuYXBwZW5kQ2hpbGQoc2VhcmNoKTtcblxuICBjb25zdCBnbG9iYWxNZW51ID0gYWN0aW9uTWVudUJ1dHRvbihcIk1vcmUgdHdlYWsgYWN0aW9uc1wiLCBbXG4gICAge1xuICAgICAgbGFiZWw6IFwiRm9yY2UgUmVsb2FkXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgICAgLmludm9rZShcImNvZGV4cHA6cmVsb2FkLXR3ZWFrc1wiKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImZvcmNlIHJlbG9hZCAobWFpbikgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4gbG9jYXRpb24ucmVsb2FkKCkpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIGxhYmVsOiBcIk9wZW4gVHdlYWtzIEZvbGRlclwiLFxuICAgICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnJldmVhbFwiLCB0d2Vha3NQYXRoKCkpO1xuICAgICAgfSxcbiAgICB9LFxuICBdKTtcbiAgdG9vbGJhckFjdGlvbnMuYXBwZW5kQ2hpbGQoZ2xvYmFsTWVudS5lbGVtZW50KTtcblxuICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGlzdC5pZCA9IFwiY29kZXhwcC10d2Vha3MtbGlzdFwiO1xuICBsaXN0LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJ0YWJwYW5lbFwiKTtcbiAgbGlzdC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgd3JhcC5hcHBlbmRDaGlsZChsaXN0KTtcblxuICBsZXQgcm93Q2xlYW51cHM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG4gIGNvbnN0IHJlbmRlckxpc3QgPSAoKTogdm9pZCA9PiB7XG4gICAgZm9yIChjb25zdCBjbGVhbnVwIG9mIHJvd0NsZWFudXBzKSBjbGVhbnVwKCk7XG4gICAgcm93Q2xlYW51cHMgPSBbXTtcblxuICAgIGNvbnN0IGNvdW50cyA9IHR3ZWFrc1BhZ2VDb3VudHMoc3RhdGUubGlzdGVkVHdlYWtzKTtcbiAgICB0YWJzLnJlcGxhY2VDaGlsZHJlbigpO1xuICAgIGZvciAoY29uc3QgZmlsdGVyIG9mIFRXRUFLU19QQUdFX0ZJTFRFUlMpIHtcbiAgICAgIGNvbnN0IHNlbGVjdGVkID0gc3RhdGUudHdlYWtzUGFnZUZpbHRlciA9PT0gZmlsdGVyO1xuICAgICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGJ1dHRvbi5pZCA9IGBjb2RleHBwLXR3ZWFrcy1maWx0ZXItJHtmaWx0ZXJ9YDtcbiAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwidGFiXCIpO1xuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtY29udHJvbHNcIiwgbGlzdC5pZCk7XG4gICAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiLCBTdHJpbmcoc2VsZWN0ZWQpKTtcbiAgICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBbXG4gICAgICAgIFwiaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciBnYXAtMS41IHJvdW5kZWQtbGcgcHgtMi41IHRleHQtc20gY3Vyc29yLWludGVyYWN0aW9uXCIsXG4gICAgICAgIHNlbGVjdGVkXG4gICAgICAgICAgPyBcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWZvcmVncm91bmRcIlxuICAgICAgICAgIDogXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBob3Zlcjp0ZXh0LXRva2VuLWZvcmVncm91bmRcIixcbiAgICAgIF0uam9pbihcIiBcIik7XG4gICAgICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgICAgbGFiZWwudGV4dENvbnRlbnQgPSB0d2Vha3NQYWdlRmlsdGVyTGFiZWwoZmlsdGVyKTtcbiAgICAgIGNvbnN0IGNvdW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBjb3VudC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4taW5wdXQtcGxhY2Vob2xkZXItZm9yZWdyb3VuZCB0YWJ1bGFyLW51bXNcIjtcbiAgICAgIGNvdW50LnRleHRDb250ZW50ID0gU3RyaW5nKGNvdW50c1tmaWx0ZXJdKTtcbiAgICAgIGJ1dHRvbi5hcHBlbmQobGFiZWwsIGNvdW50KTtcbiAgICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyID0gZmlsdGVyO1xuICAgICAgICByZW5kZXJMaXN0KCk7XG4gICAgICB9KTtcbiAgICAgIHRhYnMuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgICB9XG4gICAgbGlzdC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsbGVkYnlcIiwgYGNvZGV4cHAtdHdlYWtzLWZpbHRlci0ke3N0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXJ9YCk7XG5cbiAgICBjb25zdCB2aXNpYmxlID0gZmlsdGVyVHdlYWtzUGFnZUl0ZW1zKFxuICAgICAgc3RhdGUubGlzdGVkVHdlYWtzLFxuICAgICAgc3RhdGUudHdlYWtzUGFnZUZpbHRlcixcbiAgICAgIHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeSxcbiAgICApO1xuICAgIGxpc3QucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgaWYgKHZpc2libGUubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBlbXB0eS5jbGFzc05hbWUgPSBcImZsZXggbWluLWgtMjggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHB5LTggdGV4dC1jZW50ZXIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gICAgICBlbXB0eS50ZXh0Q29udGVudCA9IHN0YXRlLmxpc3RlZFR3ZWFrcy5sZW5ndGggPT09IDBcbiAgICAgICAgPyBgTm8gY2F0YWxvZyBlbnRyaWVzIGF2YWlsYWJsZS4gRHJvcCBhIHR3ZWFrIGZvbGRlciBpbnRvICR7dHdlYWtzUGF0aCgpfSBhbmQgcmVsb2FkLmBcbiAgICAgICAgOiBcIk5vIHR3ZWFrcyBtYXRjaCB0aGlzIHNlYXJjaCBhbmQgZmlsdGVyLlwiO1xuICAgICAgbGlzdC5hcHBlbmRDaGlsZChlbXB0eSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCB0d2VhayBvZiB2aXNpYmxlKSB7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKHR3ZWFrUm93KFxuICAgICAgICB0d2VhayxcbiAgICAgICAgc2VjdGlvbnNCeVR3ZWFrLmdldCh0d2Vhay5tYW5pZmVzdC5pZCkgPz8gW10sXG4gICAgICAgIHBhZ2VzQnlUd2Vhay5nZXQodHdlYWsubWFuaWZlc3QuaWQpID8/IFtdLFxuICAgICAgICAoY2xlYW51cCkgPT4gcm93Q2xlYW51cHMucHVzaChjbGVhbnVwKSxcbiAgICAgICkpO1xuICAgIH1cbiAgfTtcblxuICBzZWFyY2hJbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKCkgPT4ge1xuICAgIHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeSA9IHNlYXJjaElucHV0LnZhbHVlO1xuICAgIGNsZWFyU2VhcmNoLmhpZGRlbiA9IHNlYXJjaElucHV0LnZhbHVlLmxlbmd0aCA9PT0gMDtcbiAgICByZW5kZXJMaXN0KCk7XG4gIH0pO1xuICBjbGVhclNlYXJjaC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeSA9IFwiXCI7XG4gICAgc2VhcmNoSW5wdXQudmFsdWUgPSBcIlwiO1xuICAgIGNsZWFyU2VhcmNoLmhpZGRlbiA9IHRydWU7XG4gICAgcmVuZGVyTGlzdCgpO1xuICAgIHNlYXJjaElucHV0LmZvY3VzKCk7XG4gIH0pO1xuXG4gIHJlbmRlckxpc3QoKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBnbG9iYWxNZW51LmRpc3Bvc2UoKTtcbiAgICBmb3IgKGNvbnN0IGNsZWFudXAgb2Ygcm93Q2xlYW51cHMpIGNsZWFudXAoKTtcbiAgICByb3dDbGVhbnVwcyA9IFtdO1xuICB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha3NQYWdlRmlsdGVyTGFiZWwoZmlsdGVyOiBUd2Vha3NQYWdlRmlsdGVyKTogc3RyaW5nIHtcbiAgaWYgKGZpbHRlciA9PT0gXCJhbGxcIikgcmV0dXJuIFwiQWxsXCI7XG4gIGlmIChmaWx0ZXIgPT09IFwiZW5hYmxlZFwiKSByZXR1cm4gXCJFbmFibGVkXCI7XG4gIGlmIChmaWx0ZXIgPT09IFwiZGlzYWJsZWRcIikgcmV0dXJuIFwiRGlzYWJsZWRcIjtcbiAgcmV0dXJuIFwiVXBkYXRlc1wiO1xufVxuXG5mdW5jdGlvbiB0d2Vha1JvdyhcbiAgdHdlYWs6IExpc3RlZFR3ZWFrLFxuICBzZWN0aW9uczogU2V0dGluZ3NTZWN0aW9uW10sXG4gIHBhZ2VzOiBSZWdpc3RlcmVkUGFnZVtdLFxuICByZWdpc3RlckNsZWFudXA6IChjbGVhbnVwOiAoKSA9PiB2b2lkKSA9PiB2b2lkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtYW5pZmVzdCA9IHR3ZWFrLm1hbmlmZXN0O1xuICBjb25zdCBjZWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2VsbC5jbGFzc05hbWUgPSBbXG4gICAgXCJncm91cCBmbGV4IGZsZXgtY29sIG92ZXJmbG93LXZpc2libGUgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci80MCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgdHJhbnNpdGlvbi1jb2xvcnMgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsXG4gICAgIXR3ZWFrLmluc3RhbGxlZCB8fCB0d2Vhay5zdGF0dXMgPT09IFwiZGlzYWJsZWRcIiA/IFwib3BhY2l0eS02MFwiIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4taC1bNjRweF0gaXRlbXMtY2VudGVyIGdhcC0zIHAtMi41XCI7XG4gIGNlbGwuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICBjb25zdCBjYW5Db25maWd1cmUgPSB0d2Vhay5pbnN0YWxsZWQgJiYgdHdlYWsuZW5hYmxlZCAmJiBwYWdlcy5sZW5ndGggPiAwO1xuICBjb25zdCBjb250ZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChjYW5Db25maWd1cmUgPyBcImJ1dHRvblwiIDogXCJkaXZcIik7XG4gIGNvbnRlbnQuY2xhc3NOYW1lID0gW1xuICAgIFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1jZW50ZXIgZ2FwLTMgdGV4dC1sZWZ0XCIsXG4gICAgY2FuQ29uZmlndXJlXG4gICAgICA/IFwiY3Vyc29yLWludGVyYWN0aW9uIHJvdW5kZWQtbGcgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpyaW5nLTIgZm9jdXMtdmlzaWJsZTpyaW5nLXRva2VuLWZvY3VzLWJvcmRlclwiXG4gICAgICA6IFwiXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xuICBpZiAoY29udGVudCBpbnN0YW5jZW9mIEhUTUxCdXR0b25FbGVtZW50KSB7XG4gICAgY29udGVudC50eXBlID0gXCJidXR0b25cIjtcbiAgICBjb250ZW50LnRpdGxlID0gcGFnZXMubGVuZ3RoID09PSAxXG4gICAgICA/IGBPcGVuICR7cGFnZXNbMF0hLnBhZ2UudGl0bGV9YFxuICAgICAgOiBgT3BlbiAke3BhZ2VzLm1hcCgocGFnZSkgPT4gcGFnZS5wYWdlLnRpdGxlKS5qb2luKFwiLCBcIil9YDtcbiAgICBjb250ZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IG1hbmlmZXN0LmlkIH0pO1xuICAgIH0pO1xuICB9XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQodHdlYWtBdmF0YXIodHdlYWspKTtcblxuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMC41XCI7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IG5hbWUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBuYW1lLmNsYXNzTmFtZSA9IFwibWluLXctMCB0cnVuY2F0ZSB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIG5hbWUudGV4dENvbnRlbnQgPSBtYW5pZmVzdC5uYW1lO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZChuYW1lKTtcbiAgY29uc3QgdmVyc2lvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICB2ZXJzaW9uLmNsYXNzTmFtZSA9IFwic2hyaW5rLTAgdGV4dC14cyBmb250LW5vcm1hbCB0YWJ1bGFyLW51bXMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICB2ZXJzaW9uLnRleHRDb250ZW50ID0gYHYke21hbmlmZXN0LnZlcnNpb259YDtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyc2lvbik7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHR3ZWFrU3RhdHVzUGlsbCh0d2VhaykpO1xuICBpZiAodHdlYWsudXBkYXRlPy51cGRhdGVBdmFpbGFibGUpIHtcbiAgICBjb25zdCB1cGRhdGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICB1cGRhdGUuY2xhc3NOYW1lID1cbiAgICAgIFwic2hyaW5rLTAgcm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItYmx1ZS01MDAvMzAgYmctYmx1ZS01MDAvMTAgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICB1cGRhdGUudGV4dENvbnRlbnQgPSBcIlVwZGF0ZSBBdmFpbGFibGVcIjtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh1cGRhdGUpO1xuICB9XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcbiAgaWYgKG1hbmlmZXN0LmRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGRlc2NyaXB0aW9uLmNsYXNzTmFtZSA9IFwibGluZS1jbGFtcC0xIG1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gICAgZGVzY3JpcHRpb24udGV4dENvbnRlbnQgPSBtYW5pZmVzdC5kZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkZXNjcmlwdGlvbik7XG4gIH1cbiAgY29udGVudC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChjb250ZW50KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IGF1dGhvciA9IHR3ZWFrQXV0aG9yTmFtZShtYW5pZmVzdC5hdXRob3IpO1xuICBpZiAoYXV0aG9yKSB7XG4gICAgY29uc3QgYXV0aG9yTGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGF1dGhvckxhYmVsLmNsYXNzTmFtZSA9IFwiaGlkZGVuIHctMjggdHJ1bmNhdGUgdGV4dC1yaWdodCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWQ6YmxvY2tcIjtcbiAgICBhdXRob3JMYWJlbC50ZXh0Q29udGVudCA9IGF1dGhvcjtcbiAgICBhdXRob3JMYWJlbC50aXRsZSA9IGF1dGhvcjtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGF1dGhvckxhYmVsKTtcbiAgfVxuXG4gIGNvbnN0IHJvd01lbnVJdGVtczogQWN0aW9uTWVudUl0ZW1bXSA9IFtdO1xuICBpZiAoY2FuQ29uZmlndXJlKSB7XG4gICAgcm93TWVudUl0ZW1zLnB1c2goe1xuICAgICAgbGFiZWw6IFwiQ29uZmlndXJlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4gYWN0aXZhdGVQYWdlKHsga2luZDogXCJyZWdpc3RlcmVkXCIsIGlkOiBtYW5pZmVzdC5pZCB9KSxcbiAgICB9KTtcbiAgfVxuICBpZiAodHdlYWsudXBkYXRlPy51cGRhdGVBdmFpbGFibGUgJiYgdHdlYWsudXBkYXRlLnJlbGVhc2VVcmwpIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJSZXZpZXcgUmVsZWFzZVwiLFxuICAgICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgdHdlYWsudXBkYXRlIS5yZWxlYXNlVXJsKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cbiAgcm93TWVudUl0ZW1zLnB1c2goe1xuICAgIGxhYmVsOiBcIk9wZW4gUmVwb3NpdG9yeVwiLFxuICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7bWFuaWZlc3QuZ2l0aHViUmVwb31gKTtcbiAgICB9LFxuICB9KTtcbiAgaWYgKG1hbmlmZXN0LmhvbWVwYWdlICYmIG1hbmlmZXN0LmhvbWVwYWdlICE9PSBgaHR0cHM6Ly9naXRodWIuY29tLyR7bWFuaWZlc3QuZ2l0aHViUmVwb31gKSB7XG4gICAgcm93TWVudUl0ZW1zLnB1c2goe1xuICAgICAgbGFiZWw6IFwiT3BlbiBIb21lcGFnZVwiLFxuICAgICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm9wZW4tZXh0ZXJuYWxcIiwgbWFuaWZlc3QuaG9tZXBhZ2UpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuICBjb25zdCByb3dNZW51ID0gYWN0aW9uTWVudUJ1dHRvbihgTW9yZSBhY3Rpb25zIGZvciAke21hbmlmZXN0Lm5hbWV9YCwgcm93TWVudUl0ZW1zKTtcbiAgcm93TWVudS5lbGVtZW50LmNsYXNzTGlzdC5hZGQoXG4gICAgXCJpbnZpc2libGVcIixcbiAgICBcIm9wYWNpdHktMFwiLFxuICAgIFwiZ3JvdXAtZm9jdXMtd2l0aGluOnZpc2libGVcIixcbiAgICBcImdyb3VwLWZvY3VzLXdpdGhpbjpvcGFjaXR5LTEwMFwiLFxuICAgIFwiZ3JvdXAtaG92ZXI6dmlzaWJsZVwiLFxuICAgIFwiZ3JvdXAtaG92ZXI6b3BhY2l0eS0xMDBcIixcbiAgKTtcbiAgcmVnaXN0ZXJDbGVhbnVwKHJvd01lbnUuZGlzcG9zZSk7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQocm93TWVudS5lbGVtZW50KTtcblxuICBpZiAoIXR3ZWFrLmluc3RhbGxlZCkge1xuICAgIGlmICh0d2Vhay5jYXRhbG9nPy5hdmFpbGFibGUgPT09IGZhbHNlKSB7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIk5vdCBpbnN0YWxsZWRcIikpO1xuICAgIH0gZWxzZSB7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJJbnN0YWxsXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmluc3RhbGwtc3RvcmUtdHdlYWtcIiwgbWFuaWZlc3QuaWQpXG4gICAgICAgICAgLnRoZW4oKCkgPT4gbG9jYXRpb24ucmVsb2FkKCkpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiY2F0YWxvZyBpbnN0YWxsIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIH0pKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAodHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWNvdmVyXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZWNvdmVyLXR3ZWFrXCIsIG1hbmlmZXN0LmlkKVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJ0d2VhayByZWNvdmVyeSBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSkpO1xuICB9IGVsc2Uge1xuICAgIGlmICh0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJldHJ5XCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNsZWFyLXR3ZWFrLWhlYWx0aFwiLCBtYW5pZmVzdC5pZClcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjbGVhciB0d2VhayBoZWFsdGggZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6cmVsb2FkLXR3ZWFrc1wiKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInR3ZWFrIHJldHJ5IGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIH0pKTtcbiAgICB9XG4gICAgY29uc3QgdG9nZ2xlID0gc3dpdGNoQ29udHJvbCh0d2Vhay5lbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzZXQtdHdlYWstZW5hYmxlZFwiLCBtYW5pZmVzdC5pZCwgbmV4dCk7XG4gICAgfSk7XG4gICAgdG9nZ2xlLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgYCR7dHdlYWsuZW5hYmxlZCA/IFwiRGlzYWJsZVwiIDogXCJFbmFibGVcIn0gJHttYW5pZmVzdC5uYW1lfWApO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQodG9nZ2xlKTtcbiAgfVxuICBoZWFkZXIuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgLy8gUHJlc2VydmUgdGhlIGxlZ2FjeSBTZXR0aW5nc1NlY3Rpb24gY29udHJhY3Q6IHJlZ2lzdGVyZWQgc2VjdGlvbnMgc3RpbGxcbiAgLy8gcmVuZGVyIGRpcmVjdGx5IGJlbmVhdGggdGhlaXIgb3duaW5nIHR3ZWFrIHJvdy5cbiAgaWYgKHR3ZWFrLmluc3RhbGxlZCAmJiB0d2Vhay5lbmFibGVkICYmIHNlY3Rpb25zLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCBuZXN0ZWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIG5lc3RlZC5jbGFzc05hbWUgPVxuICAgICAgXCJmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciBib3JkZXItdC1bMC41cHhdIGJvcmRlci10b2tlbi1ib3JkZXJcIjtcbiAgICBmb3IgKGNvbnN0IHNlY3Rpb24gb2Ygc2VjdGlvbnMpIHtcbiAgICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYm9keS5jbGFzc05hbWUgPSBcInAtM1wiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgc2VjdGlvbi5yZW5kZXIoYm9keSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJvZHkuY2xhc3NOYW1lID0gXCJwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIjtcbiAgICAgICAgYm9keS50ZXh0Q29udGVudCA9IGBFcnJvciByZW5kZXJpbmcgdHdlYWsgc2VjdGlvbjogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgICAgfVxuICAgICAgbmVzdGVkLmFwcGVuZENoaWxkKGJvZHkpO1xuICAgIH1cbiAgICBjZWxsLmFwcGVuZENoaWxkKG5lc3RlZCk7XG4gIH1cblxuICByZXR1cm4gY2VsbDtcbn1cblxuZnVuY3Rpb24gdHdlYWtBdmF0YXIodHdlYWs6IExpc3RlZFR3ZWFrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtMTAgdy0xMCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXItZGVmYXVsdCBiZy10cmFuc3BhcmVudCB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGNvbnN0IGluaXRpYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgaW5pdGlhbC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bVwiO1xuICBpbml0aWFsLnRleHRDb250ZW50ID0gKHR3ZWFrLm1hbmlmZXN0Lm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGluaXRpYWwpO1xuICBpZiAoIXR3ZWFrLm1hbmlmZXN0Lmljb25VcmwpIHJldHVybiBhdmF0YXI7XG5cbiAgY29uc3QgaW1hZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICBpbWFnZS5hbHQgPSBcIlwiO1xuICBpbWFnZS5jbGFzc05hbWUgPSBcImgtZnVsbCB3LWZ1bGwgb2JqZWN0LWNvbnRhaW5cIjtcbiAgaW1hZ2UuaGlkZGVuID0gdHJ1ZTtcbiAgaW1hZ2UuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgIGluaXRpYWwucmVtb3ZlKCk7XG4gICAgaW1hZ2UuaGlkZGVuID0gZmFsc2U7XG4gIH0pO1xuICBpbWFnZS5hZGRFdmVudExpc3RlbmVyKFwiZXJyb3JcIiwgKCkgPT4gaW1hZ2UucmVtb3ZlKCkpO1xuICB2b2lkIHJlc29sdmVJY29uVXJsKHR3ZWFrLm1hbmlmZXN0Lmljb25VcmwsIHR3ZWFrLmRpcikudGhlbigodXJsKSA9PiB7XG4gICAgaWYgKHVybCkgaW1hZ2Uuc3JjID0gdXJsO1xuICAgIGVsc2UgaW1hZ2UucmVtb3ZlKCk7XG4gIH0pO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW1hZ2UpO1xuICByZXR1cm4gYXZhdGFyO1xufVxuXG5mdW5jdGlvbiB0d2Vha0F1dGhvck5hbWUoYXV0aG9yOiBUd2Vha01hbmlmZXN0W1wiYXV0aG9yXCJdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghYXV0aG9yKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHR5cGVvZiBhdXRob3IgPT09IFwic3RyaW5nXCIgPyBhdXRob3IgOiBhdXRob3IubmFtZTtcbn1cblxuZnVuY3Rpb24gYWN0aW9uTWVudUJ1dHRvbihcbiAgbGFiZWw6IHN0cmluZyxcbiAgaXRlbXM6IEFjdGlvbk1lbnVJdGVtW10sXG4pOiB7IGVsZW1lbnQ6IEhUTUxFbGVtZW50OyBkaXNwb3NlOiAoKSA9PiB2b2lkIH0ge1xuICBjb25zdCBkZXRhaWxzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRldGFpbHNcIik7XG4gIGRldGFpbHMuY2xhc3NOYW1lID0gXCJyZWxhdGl2ZSBzaHJpbmstMFwiO1xuICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gIHN1bW1hcnkuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIHN1bW1hcnkuc2V0QXR0cmlidXRlKFwiYXJpYS1oYXNwb3B1cFwiLCBcIm1lbnVcIik7XG4gIHN1bW1hcnkuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC04IHctOCBsaXN0LW5vbmUgY3Vyc29yLWludGVyYWN0aW9uIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLWxnIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGhvdmVyOnRleHQtdG9rZW4tZm9yZWdyb3VuZCBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIHN1bW1hcnkuc3R5bGUubGlzdFN0eWxlID0gXCJub25lXCI7XG4gIHN1bW1hcnkuaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE2XCIgaGVpZ2h0PVwiMTZcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIGNsYXNzPVwiaWNvbi1zbVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiNFwiIGN5PVwiMTBcIiByPVwiMS4yNVwiLz48Y2lyY2xlIGN4PVwiMTBcIiBjeT1cIjEwXCIgcj1cIjEuMjVcIi8+PGNpcmNsZSBjeD1cIjE2XCIgY3k9XCIxMFwiIHI9XCIxLjI1XCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBjb25zdCBtZW51ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWVudS5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwibWVudVwiKTtcbiAgbWVudS5jbGFzc05hbWUgPVxuICAgIFwiYWJzb2x1dGUgcmlnaHQtMCB0b3AtZnVsbCB6LTUwIG10LTEgZmxleCBtaW4tdy00NCBmbGV4LWNvbCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLW1haW4tc3VyZmFjZS1wcmltYXJ5IHAtMSBzaGFkb3ctbGdcIjtcbiAgZm9yIChjb25zdCBpdGVtIG9mIGl0ZW1zKSB7XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBidXR0b24udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJtZW51aXRlbVwiKTtcbiAgICBidXR0b24uY2xhc3NOYW1lID1cbiAgICAgIFwiZmxleCBoLTggdy1mdWxsIGl0ZW1zLWNlbnRlciByb3VuZGVkLW1kIHB4LTIgdGV4dC1sZWZ0IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCI7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gaXRlbS5sYWJlbDtcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChldmVudCkgPT4ge1xuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgZGV0YWlscy5vcGVuID0gZmFsc2U7XG4gICAgICBpdGVtLm9uU2VsZWN0KCk7XG4gICAgfSk7XG4gICAgbWVudS5hcHBlbmRDaGlsZChidXR0b24pO1xuICB9XG4gIGRldGFpbHMuYXBwZW5kKHN1bW1hcnksIG1lbnUpO1xuXG4gIGxldCBsaXN0ZW5pbmcgPSBmYWxzZTtcbiAgY29uc3QgZGV0YWNoID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghbGlzdGVuaW5nKSByZXR1cm47XG4gICAgbGlzdGVuaW5nID0gZmFsc2U7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIG9uUG9pbnRlckRvd24sIHRydWUpO1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG9uS2V5ZG93biwgdHJ1ZSk7XG4gIH07XG4gIGNvbnN0IGNsb3NlID0gKCk6IHZvaWQgPT4ge1xuICAgIGRldGFpbHMub3BlbiA9IGZhbHNlO1xuICAgIGRldGFjaCgpO1xuICB9O1xuICBjb25zdCBvblBvaW50ZXJEb3duID0gKGV2ZW50OiBQb2ludGVyRXZlbnQpOiB2b2lkID0+IHtcbiAgICBpZiAoIWRldGFpbHMuaXNDb25uZWN0ZWQgfHwgIShldmVudC50YXJnZXQgaW5zdGFuY2VvZiBOb2RlKSB8fCAhZGV0YWlscy5jb250YWlucyhldmVudC50YXJnZXQpKSBjbG9zZSgpO1xuICB9O1xuICBjb25zdCBvbktleWRvd24gPSAoZXZlbnQ6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcbiAgICBpZiAoZXZlbnQua2V5ICE9PSBcIkVzY2FwZVwiKSByZXR1cm47XG4gICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICBjbG9zZSgpO1xuICAgIHN1bW1hcnkuZm9jdXMoKTtcbiAgfTtcbiAgZGV0YWlscy5hZGRFdmVudExpc3RlbmVyKFwidG9nZ2xlXCIsICgpID0+IHtcbiAgICBpZiAoIWRldGFpbHMub3Blbikge1xuICAgICAgZGV0YWNoKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghbGlzdGVuaW5nKSB7XG4gICAgICBsaXN0ZW5pbmcgPSB0cnVlO1xuICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJkb3duXCIsIG9uUG9pbnRlckRvd24sIHRydWUpO1xuICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgICB9XG4gICAgd2luZG93LnJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiBtZW51LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpPy5mb2N1cygpKTtcbiAgfSk7XG5cbiAgcmV0dXJuIHsgZWxlbWVudDogZGV0YWlscywgZGlzcG9zZTogY2xvc2UgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdGF0dXNQaWxsKHR3ZWFrOiBMaXN0ZWRUd2Vhayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgbGFiZWxzOiBSZWNvcmQ8VHdlYWtTdGF0dXMsIHN0cmluZz4gPSB7XG4gICAgaW5zdGFsbGVkOiBcIkluc3RhbGxlZFwiLFxuICAgIFwibm90LWluc3RhbGxlZFwiOiBcIk5vdCBpbnN0YWxsZWRcIixcbiAgICBlbmFibGVkOiBcIkVuYWJsZWRcIixcbiAgICBkaXNhYmxlZDogXCJEaXNhYmxlZFwiLFxuICAgIGZhaWxlZDogXCJGYWlsZWRcIixcbiAgICBxdWFyYW50aW5lZDogXCJRdWFyYW50aW5lZFwiLFxuICB9O1xuICBjb25zdCB0b25lID0gdHdlYWsuc3RhdHVzID09PSBcImZhaWxlZFwiIHx8IHR3ZWFrLnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJlcnJvclwiIDpcbiAgICB0d2Vhay5zdGF0dXMgPT09IFwiZW5hYmxlZFwiID8gXCJpbmZvXCIgOiBcIm5ldXRyYWxcIjtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gW1xuICAgIFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgcHgtMiBweS0wLjUgdGV4dC1bMTFweF0gZm9udC1tZWRpdW1cIixcbiAgICB0b25lID09PSBcImVycm9yXCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXJlZC8zMCBiZy10b2tlbi1jaGFydHMtcmVkLzEwIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiXG4gICAgICA6IHRvbmUgPT09IFwiaW5mb1wiXG4gICAgICAgID8gXCJib3JkZXItYmx1ZS01MDAvMzAgYmctYmx1ZS01MDAvMTAgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsc1t0d2Vhay5zdGF0dXNdO1xuICBpZiAodHdlYWsuaGVhbHRoPy5lcnJvcikgYmFkZ2UudGl0bGUgPSB0d2Vhay5oZWFsdGguZXJyb3I7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gb3BlblB1Ymxpc2hUd2Vha0RpYWxvZygpOiB2b2lkIHtcbiAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLWNvZGV4cHAtcHVibGlzaC1kaWFsb2ddXCIpO1xuICBleGlzdGluZz8ucmVtb3ZlKCk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuZGF0YXNldC5jb2RleHBwUHVibGlzaERpYWxvZyA9IFwidHJ1ZVwiO1xuICBvdmVybGF5LmNsYXNzTmFtZSA9IFwiZml4ZWQgaW5zZXQtMCB6LVs5OTk5XSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay80MCBwLTRcIjtcblxuICBjb25zdCBkaWFsb2cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkaWFsb2cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggdy1mdWxsIG1heC13LXhsIGZsZXgtY29sIGdhcC00IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tbWFpbi1zdXJmYWNlLXByaW1hcnkgcC00IHNoYWRvdy14bFwiO1xuICBvdmVybGF5LmFwcGVuZENoaWxkKGRpYWxvZyk7XG5cbiAgY29uc3QgaGVhZGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgY29uc3QgdGl0bGVTdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlU3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiUHVibGlzaCBUd2Vha1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN1YnRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJTdWJtaXQgYSBHaXRIdWIgcmVwbyBmb3IgYWRtaW4gcmV2aWV3LiBUd2Vha2VycyByZWNvcmRzIHRoZSBleGFjdCBjb21taXQgYWRtaW5zIG11c3QgcmV2aWV3IGFuZCBwaW4uXCI7XG4gIHRpdGxlU3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICB0aXRsZVN0YWNrLmFwcGVuZENoaWxkKHN1YnRpdGxlKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKHRpdGxlU3RhY2spO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIkRpc21pc3NcIiwgKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSkpO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoaGVhZGVyKTtcblxuICBjb25zdCByZXBvSW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XG4gIHJlcG9JbnB1dC50eXBlID0gXCJ0ZXh0XCI7XG4gIHJlcG9JbnB1dC5wbGFjZWhvbGRlciA9IFwib3duZXIvcmVwbyBvciBodHRwczovL2dpdGh1Yi5jb20vb3duZXIvcmVwb1wiO1xuICByZXBvSW5wdXQuY2xhc3NOYW1lID1cbiAgICBcImgtMTAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10cmFuc3BhcmVudCBweC0zIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZm9jdXM6b3V0bGluZS1ub25lXCI7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChyZXBvSW5wdXQpO1xuXG4gIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YXR1cy5jbGFzc05hbWUgPSBcIm1pbi1oLTUgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHN0YXR1cy50ZXh0Q29udGVudCA9IFwiVGhlIG1hbmlmZXN0IHNob3VsZCBpbmNsdWRlIGFuIGljb25Vcmwgc3VpdGFibGUgZm9yIHRoZSBzdG9yZS5cIjtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKHN0YXR1cyk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWVuZCBnYXAtMlwiO1xuICBjb25zdCBzdWJtaXQgPSBjb21wYWN0QnV0dG9uKFwiT3BlbiBSZXZpZXcgSXNzdWVcIiwgKCkgPT4ge1xuICAgIHZvaWQgc3VibWl0UHVibGlzaFR3ZWFrKHJlcG9JbnB1dCwgc3RhdHVzKTtcbiAgfSk7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3VibWl0KTtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuXG4gIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgaWYgKGUudGFyZ2V0ID09PSBvdmVybGF5KSBvdmVybGF5LnJlbW92ZSgpO1xuICB9KTtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcbiAgcmVwb0lucHV0LmZvY3VzKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHN1Ym1pdFB1Ymxpc2hUd2VhayhcbiAgcmVwb0lucHV0OiBIVE1MSW5wdXRFbGVtZW50LFxuICBzdGF0dXM6IEhUTUxFbGVtZW50LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIHN0YXR1cy5jbGFzc05hbWUgPSBcIm1pbi1oLTUgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHN0YXR1cy50ZXh0Q29udGVudCA9IFwiUmVzb2x2aW5nIHRoZSByZXBvIGNvbW1pdCB0byByZXZpZXcuXCI7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3VibWlzc2lvbiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgIFwiY29kZXhwcDpwcmVwYXJlLXR3ZWFrLXN0b3JlLXN1Ym1pc3Npb25cIixcbiAgICAgIHJlcG9JbnB1dC52YWx1ZSxcbiAgICApIGFzIFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbjtcbiAgICBjb25zdCB1cmwgPSBidWlsZFR3ZWFrUHVibGlzaElzc3VlVXJsKHN1Ym1pc3Npb24pO1xuICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6b3Blbi1leHRlcm5hbFwiLCB1cmwpO1xuICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IGBHaXRIdWIgcmV2aWV3IGlzc3VlIG9wZW5lZCBmb3IgJHtzdWJtaXNzaW9uLmNvbW1pdFNoYS5zbGljZSgwLCA3KX0uYDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHN0YXR1cy5jbGFzc05hbWUgPSBcIm1pbi1oLTUgdGV4dC1zbSB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIjtcbiAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UgPz8gZSk7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGNvbXBvbmVudHMgXHUyNTAwXHUyNTAwXG5cbi8qKiBUaGUgZnVsbCBwYW5lbCBzaGVsbCAodG9vbGJhciArIHNjcm9sbCArIGhlYWRpbmcgKyBzZWN0aW9ucyB3cmFwKS4gKi9cbmZ1bmN0aW9uIHBhbmVsU2hlbGwoXG4gIHRpdGxlOiBzdHJpbmcsXG4gIHN1YnRpdGxlPzogc3RyaW5nLFxuICBvcHRpb25zPzogeyB3aWRlPzogYm9vbGVhbjsgd2lkdGg/OiBcImRlZmF1bHRcIiB8IFwicGx1Z2luc1wiIHwgXCJ3aWRlXCIgfSxcbik6IHtcbiAgb3V0ZXI6IEhUTUxFbGVtZW50O1xuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50O1xuICBzdWJ0aXRsZT86IEhUTUxFbGVtZW50O1xuICBoZWFkZXJBY3Rpb25zOiBIVE1MRWxlbWVudDtcbiAgaGVhZGVyVGl0bGVBY3Rpb25zOiBIVE1MRWxlbWVudDtcbn0ge1xuICBjb25zdCBvdXRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG91dGVyLmNsYXNzTmFtZSA9IFwibWFpbi1zdXJmYWNlIGZsZXggaC1mdWxsIG1pbi1oLTAgZmxleC1jb2xcIjtcblxuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhci5jbGFzc05hbWUgPVxuICAgIFwiZHJhZ2dhYmxlIGZsZXggaXRlbXMtY2VudGVyIHB4LXBhbmVsIGVsZWN0cm9uOmgtdG9vbGJhciBleHRlbnNpb246aC10b29sYmFyLXNtXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHRvb2xiYXIpO1xuXG4gIGNvbnN0IHNjcm9sbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNjcm9sbC5jbGFzc05hbWUgPSBcImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gcC1wYW5lbFwiO1xuICBvdXRlci5hcHBlbmRDaGlsZChzY3JvbGwpO1xuXG4gIGNvbnN0IGlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29uc3Qgd2lkdGggPSBvcHRpb25zPy53aWR0aCA/PyAob3B0aW9ucz8ud2lkZSA/IFwid2lkZVwiIDogXCJkZWZhdWx0XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPSBbXG4gICAgXCJteC1hdXRvIGZsZXggdy1mdWxsIGZsZXgtY29sIGVsZWN0cm9uOm1pbi13LVtjYWxjKDMyMHB4KnZhcigtLWNvZGV4LXdpbmRvdy16b29tKSldXCIsXG4gICAgd2lkdGggPT09IFwid2lkZVwiID8gXCJtYXgtdy01eGxcIiA6IHdpZHRoID09PSBcInBsdWdpbnNcIiA/IFwibWF4LXctM3hsXCIgOiBcIm1heC13LTJ4bFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICBzY3JvbGwuYXBwZW5kQ2hpbGQoaW5uZXIpO1xuXG4gIGNvbnN0IGhlYWRlcldyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHBiLXBhbmVsXCI7XG4gIGNvbnN0IGhlYWRlcklubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVySW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xLjUgcGItcGFuZWxcIjtcbiAgY29uc3QgdGl0bGVMaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVMaW5lLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcImVsZWN0cm9uOmhlYWRpbmctbGcgaGVhZGluZy1iYXNlIHRydW5jYXRlXCI7XG4gIGhlYWRpbmcudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgdGl0bGVMaW5lLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBjb25zdCBoZWFkZXJUaXRsZUFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJUaXRsZUFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICB0aXRsZUxpbmUuYXBwZW5kQ2hpbGQoaGVhZGVyVGl0bGVBY3Rpb25zKTtcbiAgaGVhZGVySW5uZXIuYXBwZW5kQ2hpbGQodGl0bGVMaW5lKTtcbiAgbGV0IHN1YnRpdGxlRWxlbWVudDogSFRNTEVsZW1lbnQgfCB1bmRlZmluZWQ7XG4gIGlmIChzdWJ0aXRsZSkge1xuICAgIGNvbnN0IHN1YiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgc3ViLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXNtXCI7XG4gICAgc3ViLnRleHRDb250ZW50ID0gc3VidGl0bGU7XG4gICAgaGVhZGVySW5uZXIuYXBwZW5kQ2hpbGQoc3ViKTtcbiAgICBzdWJ0aXRsZUVsZW1lbnQgPSBzdWI7XG4gIH1cbiAgaGVhZGVyV3JhcC5hcHBlbmRDaGlsZChoZWFkZXJJbm5lcik7XG4gIGNvbnN0IGhlYWRlckFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJBY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgaGVhZGVyV3JhcC5hcHBlbmRDaGlsZChoZWFkZXJBY3Rpb25zKTtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoaGVhZGVyV3JhcCk7XG5cbiAgY29uc3Qgc2VjdGlvbnNXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VjdGlvbnNXcmFwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtW3ZhcigtLXBhZGRpbmctcGFuZWwpXVwiO1xuICBpbm5lci5hcHBlbmRDaGlsZChzZWN0aW9uc1dyYXApO1xuXG4gIHJldHVybiB7IG91dGVyLCBzZWN0aW9uc1dyYXAsIHN1YnRpdGxlOiBzdWJ0aXRsZUVsZW1lbnQsIGhlYWRlckFjdGlvbnMsIGhlYWRlclRpdGxlQWN0aW9ucyB9O1xufVxuXG5mdW5jdGlvbiBzZWN0aW9uVGl0bGUodGV4dDogc3RyaW5nLCB0cmFpbGluZz86IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtdG9vbGJhciBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIHB4LTAgcHktMFwiO1xuICBjb25zdCB0aXRsZUlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHQuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHRpdGxlSW5uZXIuYXBwZW5kQ2hpbGQodCk7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlSW5uZXIpO1xuICBpZiAodHJhaWxpbmcpIHtcbiAgICBjb25zdCByaWdodCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcmlnaHQuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICAgIHJpZ2h0LmFwcGVuZENoaWxkKHRyYWlsaW5nKTtcbiAgICB0aXRsZVJvdy5hcHBlbmRDaGlsZChyaWdodCk7XG4gIH1cbiAgcmV0dXJuIHRpdGxlUm93O1xufVxuXG4vKipcbiAqIENvZGV4J3MgXCJPcGVuIGNvbmZpZy50b21sXCItc3R5bGUgdHJhaWxpbmcgYnV0dG9uOiBnaG9zdCBib3JkZXIsIG11dGVkXG4gKiBsYWJlbCwgdG9wLXJpZ2h0IGRpYWdvbmFsIGFycm93IGljb24uIE1hcmt1cCBtaXJyb3JzIENvbmZpZ3VyYXRpb24gcGFuZWwuXG4gKi9cbmZ1bmN0aW9uIG9wZW5JblBsYWNlQnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgYm9yZGVyIHdoaXRlc3BhY2Utbm93cmFwIGZvY3VzOm91dGxpbmUtbm9uZSBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MCByb3VuZGVkLWxnIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZCBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBkYXRhLVtzdGF0ZT1vcGVuXTpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgYm9yZGVyLXRyYW5zcGFyZW50IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHB4LTIgcHktMCB0ZXh0LWJhc2UgbGVhZGluZy1bMThweF1cIjtcbiAgYnRuLmlubmVySFRNTCA9XG4gICAgYCR7bGFiZWx9YCArXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi0yeHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xNC4zMzQ5IDEzLjMzMDFWNi42MDY0NUw1LjQ3MDY1IDE1LjQ3MDdDNS4yMTA5NSAxNS43MzA0IDQuNzg4OTUgMTUuNzMwNCA0LjUyOTI1IDE1LjQ3MDdDNC4yNjk1NSAxNS4yMTEgNC4yNjk1NSAxNC43ODkgNC41MjkyNSAxNC41MjkzTDEzLjM5MzUgNS42NjUwNEg2LjY2MDExQzYuMjkyODQgNS42NjUwNCA1Ljk5NTA3IDUuMzY3MjcgNS45OTUwNyA1QzUuOTk1MDcgNC42MzI3MyA2LjI5Mjg0IDQuMzM0OTYgNi42NjAxMSA0LjMzNDk2SDE0Ljk5OTlMMTUuMTMzNyA0LjM0ODYzQzE1LjQzNjkgNC40MTA1NyAxNS42NjUgNC42Nzg1NyAxNS42NjUgNVYxMy4zMzAxQzE1LjY2NDkgMTMuNjk3MyAxNS4zNjcyIDEzLjk5NTEgMTQuOTk5OSAxMy45OTUxQzE0LjYzMjcgMTMuOTk1MSAxNC4zMzUgMTMuNjk3MyAxNC4zMzQ5IDEzLjMzMDFaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiPjwvcGF0aD5gICtcbiAgICBgPC9zdmc+YDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MFwiO1xuICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIHJvdW5kZWRDYXJkKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNhcmQuY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgcm91bmRlZC1sZyBib3JkZXJcIjtcbiAgY2FyZC5zZXRBdHRyaWJ1dGUoXG4gICAgXCJzdHlsZVwiLFxuICAgIFwiYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tY29sb3ItYmFja2dyb3VuZC1wYW5lbCwgdmFyKC0tY29sb3ItdG9rZW4tYmctZm9nKSk7XCIsXG4gICk7XG4gIHJldHVybiBjYXJkO1xufVxuXG5mdW5jdGlvbiByb3dTaW1wbGUodGl0bGU6IHN0cmluZyB8IHVuZGVmaW5lZCwgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0zXCI7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgaWYgKHRpdGxlKSB7XG4gICAgY29uc3QgdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdC5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHQudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgICBzdGFjay5hcHBlbmRDaGlsZCh0KTtcbiAgfVxuICBpZiAoZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgICBkLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZCk7XG4gIH1cbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcmV0dXJuIHJvdztcbn1cblxuLyoqXG4gKiBDb2RleC1zdHlsZWQgdG9nZ2xlIHN3aXRjaC4gTWFya3VwIG1pcnJvcnMgdGhlIEdlbmVyYWwgPiBQZXJtaXNzaW9ucyByb3dcbiAqIHN3aXRjaCB3ZSBjYXB0dXJlZDogb3V0ZXIgYnV0dG9uIChyb2xlPXN3aXRjaCksIGlubmVyIHBpbGwsIHNsaWRpbmcga25vYi5cbiAqL1xuZnVuY3Rpb24gc3dpdGNoQ29udHJvbChcbiAgaW5pdGlhbDogYm9vbGVhbixcbiAgb25DaGFuZ2U6IChuZXh0OiBib29sZWFuKSA9PiB2b2lkIHwgUHJvbWlzZTx2b2lkPixcbik6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInN3aXRjaFwiKTtcblxuICBjb25zdCBwaWxsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbnN0IGtub2IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAga25vYi5jbGFzc05hbWUgPVxuICAgIFwicm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItW2NvbG9yOnZhcigtLWdyYXktMCldIGJnLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBzaGFkb3ctc20gdHJhbnNpdGlvbi10cmFuc2Zvcm0gZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNCB3LTRcIjtcbiAgcGlsbC5hcHBlbmRDaGlsZChrbm9iKTtcblxuICBjb25zdCBhcHBseSA9IChvbjogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWNoZWNrZWRcIiwgU3RyaW5nKG9uKSk7XG4gICAgYnRuLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBidG4uY2xhc3NOYW1lID1cbiAgICAgIFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHRleHQtc20gZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpyaW5nLTIgZm9jdXMtdmlzaWJsZTpyaW5nLXRva2VuLWZvY3VzLWJvcmRlciBmb2N1cy12aXNpYmxlOnJvdW5kZWQtZnVsbCBjdXJzb3ItaW50ZXJhY3Rpb25cIjtcbiAgICBwaWxsLmNsYXNzTmFtZSA9IGByZWxhdGl2ZSBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIHRyYW5zaXRpb24tY29sb3JzIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTUgdy04ICR7XG4gICAgICBvbiA/IFwiYmctdG9rZW4tY2hhcnRzLWJsdWVcIiA6IFwiYmctdG9rZW4tZm9yZWdyb3VuZC8yMFwiXG4gICAgfWA7XG4gICAgcGlsbC5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAga25vYi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAga25vYi5zdHlsZS50cmFuc2Zvcm0gPSBvbiA/IFwidHJhbnNsYXRlWCgxNHB4KVwiIDogXCJ0cmFuc2xhdGVYKDJweClcIjtcbiAgfTtcbiAgYXBwbHkoaW5pdGlhbCk7XG5cbiAgYnRuLmFwcGVuZENoaWxkKHBpbGwpO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgY29uc3QgbmV4dCA9IGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWNoZWNrZWRcIikgIT09IFwidHJ1ZVwiO1xuICAgIGFwcGx5KG5leHQpO1xuICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IG9uQ2hhbmdlKG5leHQpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaWNvbnMgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGNvbmZpZ0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU2xpZGVycyAvIHNldHRpbmdzIGdseXBoLiAyMHgyMCBjdXJyZW50Q29sb3IuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMyA1aDlNMTUgNWgyTTMgMTBoMk04IDEwaDlNMyAxNWgxMU0xNyAxNWgwXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjEzXCIgY3k9XCI1XCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI2XCIgY3k9XCIxMFwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTVcIiBjeT1cIjE1XCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTcGFya2xlcyAvIFwiKytcIiBnbHlwaCBmb3IgdHdlYWtzLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEwIDIuNSBMMTEuNCA4LjYgTDE3LjUgMTAgTDExLjQgMTEuNCBMMTAgMTcuNSBMOC42IDExLjQgTDIuNSAxMCBMOC42IDguNiBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xNS41IDMgTDE2IDUgTDE4IDUuNSBMMTYgNiBMMTUuNSA4IEwxNSA2IEwxMyA1LjUgTDE1IDUgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBvcGFjaXR5PVwiMC43XCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHN0b3JlSWNvblN2ZygpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQgOC4yIDUuMSA0LjVBMS41IDEuNSAwIDAgMSA2LjU1IDMuNGg2LjlhMS41IDEuNSAwIDAgMSAxLjQ1IDEuMUwxNiA4LjJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk00LjUgOGgxMXY3LjVBMS41IDEuNSAwIDAgMSAxNCAxN0g2YTEuNSAxLjUgMCAwIDEtMS41LTEuNVY4WlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcuNSA4djFhMi41IDIuNSAwIDAgMCA1IDBWOFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdFBhZ2VJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIERvY3VtZW50L3BhZ2UgZ2x5cGggZm9yIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZXMgd2l0aG91dCB0aGVpciBvd24gaWNvbi5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk01IDNoN2wzIDN2MTFhMSAxIDAgMCAxLTEgMUg1YTEgMSAwIDAgMS0xLTFWNGExIDEgMCAwIDEgMS0xWlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEyIDN2M2ExIDEgMCAwIDAgMSAxaDJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk03IDExaDZNNyAxNGg0XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlSWNvblVybChcbiAgdXJsOiBzdHJpbmcsXG4gIHR3ZWFrRGlyOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopLy50ZXN0KHVybCkpIHJldHVybiB1cmw7XG4gIC8vIFJlbGF0aXZlIHBhdGggXHUyMTkyIGFzayBtYWluIHRvIHJlYWQgdGhlIGZpbGUgYW5kIHJldHVybiBhIGRhdGE6IFVSTC5cbiAgLy8gUmVuZGVyZXIgaXMgc2FuZGJveGVkIHNvIGZpbGU6Ly8gd29uJ3QgbG9hZCBkaXJlY3RseS5cbiAgY29uc3QgcmVsID0gdXJsLnN0YXJ0c1dpdGgoXCIuL1wiKSA/IHVybC5zbGljZSgyKSA6IHVybDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLWFzc2V0XCIsXG4gICAgICB0d2Vha0RpcixcbiAgICAgIHJlbCxcbiAgICApKSBhcyBzdHJpbmc7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiaWNvbiBsb2FkIGZhaWxlZFwiLCB7IHVybCwgdHdlYWtEaXIsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBET00gaGV1cmlzdGljcyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBBcnJheS5mcm9tKFxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYXNpZGUsbmF2LFtyb2xlPSduYXZpZ2F0aW9uJ10sZGl2XCIpLFxuICApO1xuXG4gIGxldCBiZXN0OiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgYmVzdFNjb3JlID0gLTE7XG4gIGxldCBiZXN0QXJlYSA9IE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcblxuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgaWYgKGNhbmRpZGF0ZS5kYXRhc2V0LmNvZGV4cHApIGNvbnRpbnVlO1xuICAgIGlmICghaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoY2FuZGlkYXRlKSkgY29udGludWU7XG5cbiAgICBjb25zdCBsYWJlbHMgPSBjb2RleFBwU2V0dGluZ3NMYWJlbHNGcm9tKGNhbmRpZGF0ZSk7XG4gICAgY29uc3Qgc2NvcmUgPSBjb2RleFBwU2V0dGluZ3NMYWJlbFNjb3JlKGxhYmVscyk7XG4gICAgY29uc3QgcmVjdCA9IGNhbmRpZGF0ZS5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICBjb25zdCBhcmVhID0gcmVjdC53aWR0aCAqIHJlY3QuaGVpZ2h0O1xuICAgIGNvbnN0IHdlaWdodGVkID0gc2NvcmUuY29yZSAqIDEwMCArIHNjb3JlLnRvdGFsO1xuXG4gICAgaWYgKHdlaWdodGVkID4gYmVzdFNjb3JlIHx8ICh3ZWlnaHRlZCA9PT0gYmVzdFNjb3JlICYmIGFyZWEgPCBiZXN0QXJlYSkpIHtcbiAgICAgIGJlc3QgPSBjYW5kaWRhdGU7XG4gICAgICBiZXN0U2NvcmUgPSB3ZWlnaHRlZDtcbiAgICAgIGJlc3RBcmVhID0gYXJlYTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gYmVzdDtcbn1cblxuY29uc3QgRk9SQklEREVOX1NFVFRJTkdTX1NJREVCQVJfU0VMRUNUT1IgPSBbXG4gIFwiW2RhdGEtY29tcG9zZXItb3ZlcmxheS1mbG9hdGluZy11aT0ndHJ1ZSddXCIsXG4gIFwiW2RhdGEtY29kZXhwcC1zbGFzaC1tZW51PSd0cnVlJ11cIixcbiAgXCJbZGF0YS1jb2RleHBwLW92ZXJsYXktbm9pc2U9J3RydWUnXVwiLFxuICBcIi5jb21wb3Nlci1ob21lLXRvcC1tZW51XCIsXG4gIFwiLnZlcnRpY2FsLXNjcm9sbC1mYWRlLW1hc2tcIixcbiAgXCJbY2xhc3MqPSdbY29udGFpbmVyLW5hbWU6aG9tZS1tYWluLWNvbnRlbnRdJ11cIixcbl0uam9pbihcIixcIik7XG5cbmZ1bmN0aW9uIGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShub2RlOiBFbGVtZW50IHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoIW5vZGUpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZWwgPSBub2RlIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgPyBub2RlIDogbm9kZS5wYXJlbnRFbGVtZW50O1xuICBpZiAoIWVsKSByZXR1cm4gZmFsc2U7XG4gIGlmIChlbC5jbG9zZXN0KEZPUkJJRERFTl9TRVRUSU5HU19TSURFQkFSX1NFTEVDVE9SKSkgcmV0dXJuIHRydWU7XG4gIGlmIChlbC5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtbGlzdC1uYXZpZ2F0aW9uLWl0ZW09J3RydWUnXSwgW2NtZGstaXRlbV1cIikpIHJldHVybiB0cnVlO1xuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIGlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKGVsOiBIVE1MRWxlbWVudCk6IGJvb2xlYW4ge1xuICBjb25zdCByZWN0ID0gY29kZXhQcFZpc2libGVCb3goZWwpO1xuICBpZiAoIXJlY3QpIHJldHVybiBmYWxzZTtcblxuICAvLyBDdXJyZW50IENvZGV4IFNldHRpbmdzIHNpZGViYXI6IGxlZnQgY29sdW1uLCBub3QgdGhlIG1haW4gY29udGVudCBwYW5lbC5cbiAgaWYgKHJlY3Qud2lkdGggPCAxMjAgfHwgcmVjdC53aWR0aCA+IDYyMCkgcmV0dXJuIGZhbHNlO1xuICBpZiAocmVjdC5oZWlnaHQgPCA4MCkgcmV0dXJuIGZhbHNlO1xuICBpZiAocmVjdC5sZWZ0ID4gd2luZG93LmlubmVyV2lkdGggKiAwLjY1KSByZXR1cm4gZmFsc2U7XG5cbiAgY29uc3QgbGFiZWxzID0gY29kZXhQcFNldHRpbmdzTGFiZWxzRnJvbShlbCk7XG4gIGlmIChoYXNNYWluQXBwU2lkZWJhclNpZ25hbHMobGFiZWxzKSAmJiAhaGFzQ29kZXhQcFNldHRpbmdzT25seVNpZ25hbChsYWJlbHMpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcmV0dXJuIGlzQ29kZXhQcFNldHRpbmdzTGFiZWxTZXQobGFiZWxzKTtcbn1cblxuZnVuY3Rpb24gcmVtb3ZlTWlzcGxhY2VkU2V0dGluZ3NHcm91cHMoKTogdm9pZCB7XG4gIGNvbnN0IGdyb3VwcyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFxuICAgIFwiW2RhdGEtY29kZXhwcD0nbmF2LWdyb3VwJ10sIFtkYXRhLWNvZGV4cHA9J3BhZ2VzLWdyb3VwJ10sIFtkYXRhLWNvZGV4cHA9J25hdGl2ZS1uYXYtaGVhZGVyJ11cIixcbiAgKTtcbiAgZm9yIChjb25zdCBncm91cCBvZiBBcnJheS5mcm9tKGdyb3VwcykpIHtcbiAgICBpZiAoaXNDb2RleFBwSW5qZWN0ZWRTZXR0aW5nc0dyb3VwUGxhY2VtZW50VmFsaWQoZ3JvdXApKSBjb250aW51ZTtcbiAgICByZXNldENvZGV4UHBJbmplY3RlZFNldHRpbmdzR3JvdXBTdGF0ZShncm91cCk7XG4gICAgZ3JvdXAucmVtb3ZlKCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gaXNDb2RleFBwSW5qZWN0ZWRTZXR0aW5nc0dyb3VwUGxhY2VtZW50VmFsaWQoZ3JvdXA6IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XG4gIGlmIChpc0ZvcmJpZGRlblNldHRpbmdzU2lkZWJhclN1cmZhY2UoZ3JvdXApKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gVHJ1c3QgdGhlIGluamVjdGlvbi10aW1lIHBsYWNlbWVudCB3aGlsZSB0aGF0IGV4YWN0IHNpZGViYXIgbm9kZSBpc1xuICAvLyBhbGl2ZS4gaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUgaXMgbGF5b3V0LWRlcGVuZGVudCAodmlzaWJsZSBib3gpLCBzb1xuICAvLyByZS1qdWRnaW5nIG1pZCBSZWFjdCByZS1yZW5kZXIgaW50ZXJtaXR0ZW50bHkgZmFpbHMsIHN0cmlwcyB0aGUgZ3JvdXAsXG4gIC8vIGFuZCByZS10cmlnZ2VycyB0aGUgb2JzZXJ2ZXIgXHUyMDE0IGFuIGluamVjdC9yZW1vdmUgbG9vcCBhdCByZW5kZXIgc3BlZWQuXG4gIGlmIChcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCAmJlxuICAgIHN0YXRlLnNpZGViYXJSb290LmlzQ29ubmVjdGVkICYmXG4gICAgKGdyb3VwLnBhcmVudEVsZW1lbnQgPT09IHN0YXRlLnNpZGViYXJSb290IHx8IHN0YXRlLnNpZGViYXJSb290LmNvbnRhaW5zKGdyb3VwKSlcbiAgKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBsZXQgbm9kZSA9IGdyb3VwLnBhcmVudEVsZW1lbnQ7XG4gIGZvciAobGV0IGRlcHRoID0gMDsgbm9kZSAmJiBkZXB0aCA8IDQ7IGRlcHRoKyspIHtcbiAgICBpZiAoaXNGb3JiaWRkZW5TZXR0aW5nc1NpZGViYXJTdXJmYWNlKG5vZGUpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKGlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKG5vZGUpKSByZXR1cm4gdHJ1ZTtcbiAgICBub2RlID0gbm9kZS5wYXJlbnRFbGVtZW50O1xuICB9XG5cbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiByZXNldENvZGV4UHBJbmplY3RlZFNldHRpbmdzR3JvdXBTdGF0ZShncm91cDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLm5hdkdyb3VwID09PSBncm91cCB8fCAoc3RhdGUubmF2R3JvdXAgJiYgZ3JvdXAuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSkge1xuICAgIHN0YXRlLm5hdkdyb3VwID0gbnVsbDtcbiAgICBzdGF0ZS5uYXZCdXR0b25zID0gbnVsbDtcbiAgICBzdGF0ZS5jb2RleFBsdXNQbHVzVXBkYXRlQnV0dG9uID0gbnVsbDtcbiAgfVxuICBpZiAoc3RhdGUucGFnZXNHcm91cCA9PT0gZ3JvdXAgfHwgKHN0YXRlLnBhZ2VzR3JvdXAgJiYgZ3JvdXAuY29udGFpbnMoc3RhdGUucGFnZXNHcm91cCkpKSB7XG4gICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgc3RhdGUucGFnZXNHcm91cEtleSA9IG51bGw7XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgfVxuICBpZiAoc3RhdGUubmF0aXZlTmF2SGVhZGVyID09PSBncm91cCB8fCAoc3RhdGUubmF0aXZlTmF2SGVhZGVyICYmIGdyb3VwLmNvbnRhaW5zKHN0YXRlLm5hdGl2ZU5hdkhlYWRlcikpKSB7XG4gICAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gbnVsbDtcbiAgfVxuICBpZiAoc3RhdGUuc2lkZWJhclJvb3QgJiYgc3RhdGUuc2lkZWJhclJvb3QuY29udGFpbnMoZ3JvdXApKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbmRDb250ZW50QXJlYSgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghc2lkZWJhcikgcmV0dXJuIG51bGw7XG4gIGxldCBwYXJlbnQgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQ7XG4gIHdoaWxlIChwYXJlbnQpIHtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20ocGFyZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQgPT09IHNpZGViYXIgfHwgY2hpbGQuY29udGFpbnMoc2lkZWJhcikpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgciA9IGNoaWxkLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgaWYgKHIud2lkdGggPiAzMDAgJiYgci5oZWlnaHQgPiAyMDApIHJldHVybiBjaGlsZDtcbiAgICB9XG4gICAgcGFyZW50ID0gcGFyZW50LnBhcmVudEVsZW1lbnQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIG1heWJlRHVtcERvbSgpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgIXN0YXRlLnNpZGViYXJEdW1wZWQpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJEdW1wZWQgPSB0cnVlO1xuICAgICAgY29uc3Qgc2JSb290ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50ID8/IHNpZGViYXI7XG4gICAgICBwbG9nKGBjb2RleCBzaWRlYmFyIEhUTUxgLCBzYlJvb3Qub3V0ZXJIVE1MLnNsaWNlKDAsIDMyMDAwKSk7XG4gICAgfVxuICAgIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgICBpZiAoIWNvbnRlbnQpIHtcbiAgICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCAhPT0gbG9jYXRpb24uaHJlZikge1xuICAgICAgICBzdGF0ZS5maW5nZXJwcmludCA9IGxvY2F0aW9uLmhyZWY7XG4gICAgICAgIHBsb2coXCJkb20gcHJvYmUgKG5vIGNvbnRlbnQpXCIsIHtcbiAgICAgICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICAgICAgc2lkZWJhcjogc2lkZWJhciA/IGRlc2NyaWJlKHNpZGViYXIpIDogbnVsbCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGxldCBwYW5lbDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkLmRhdGFzZXQuY29kZXhwcCA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgICBpZiAoY2hpbGQuc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIpIGNvbnRpbnVlO1xuICAgICAgcGFuZWwgPSBjaGlsZDtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjb25zdCBhY3RpdmVOYXYgPSBzaWRlYmFyXG4gICAgICA/IEFycmF5LmZyb20oc2lkZWJhci5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImJ1dHRvbiwgYVwiKSkuZmluZChcbiAgICAgICAgICAoYikgPT5cbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpID09PSBcInBhZ2VcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJkYXRhLWFjdGl2ZVwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiKSA9PT0gXCJ0cnVlXCIgfHxcbiAgICAgICAgICAgIGIuY2xhc3NMaXN0LmNvbnRhaW5zKFwiYWN0aXZlXCIpLFxuICAgICAgICApXG4gICAgICA6IG51bGw7XG4gICAgY29uc3QgaGVhZGluZyA9IHBhbmVsPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcbiAgICAgIFwiaDEsIGgyLCBoMywgW2NsYXNzKj0naGVhZGluZyddXCIsXG4gICAgKTtcbiAgICBjb25zdCBmaW5nZXJwcmludCA9IGAke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtoZWFkaW5nPy50ZXh0Q29udGVudCA/PyBcIlwifXwke3BhbmVsPy5jaGlsZHJlbi5sZW5ndGggPz8gMH1gO1xuICAgIGlmIChzdGF0ZS5maW5nZXJwcmludCA9PT0gZmluZ2VycHJpbnQpIHJldHVybjtcbiAgICBzdGF0ZS5maW5nZXJwcmludCA9IGZpbmdlcnByaW50O1xuICAgIHBsb2coXCJkb20gcHJvYmVcIiwge1xuICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgYWN0aXZlTmF2OiBhY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGhlYWRpbmc6IGhlYWRpbmc/LnRleHRDb250ZW50Py50cmltKCkgPz8gbnVsbCxcbiAgICAgIGNvbnRlbnQ6IGRlc2NyaWJlKGNvbnRlbnQpLFxuICAgIH0pO1xuICAgIGlmIChwYW5lbCkge1xuICAgICAgY29uc3QgaHRtbCA9IHBhbmVsLm91dGVySFRNTDtcbiAgICAgIHBsb2coXG4gICAgICAgIGBjb2RleCBwYW5lbCBIVE1MICgke2FjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBcIj9cIn0pYCxcbiAgICAgICAgaHRtbC5zbGljZSgwLCAzMjAwMCksXG4gICAgICApO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJkb20gcHJvYmUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGVzY3JpYmUoZWw6IEhUTUxFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4ge1xuICAgIHRhZzogZWwudGFnTmFtZSxcbiAgICBjbHM6IGVsLmNsYXNzTmFtZS5zbGljZSgwLCAxMjApLFxuICAgIGlkOiBlbC5pZCB8fCB1bmRlZmluZWQsXG4gICAgY2hpbGRyZW46IGVsLmNoaWxkcmVuLmxlbmd0aCxcbiAgICByZWN0OiAoKCkgPT4ge1xuICAgICAgY29uc3QgciA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgICAgcmV0dXJuIHsgdzogTWF0aC5yb3VuZChyLndpZHRoKSwgaDogTWF0aC5yb3VuZChyLmhlaWdodCkgfTtcbiAgICB9KSgpLFxuICB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha3NQYXRoKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX19jb2RleHBwX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX2NvZGV4cHBfdHdlYWtzX2Rpcl9fID8/XG4gICAgXCI8dXNlciBkaXI+L3R3ZWFrc1wiXG4gICk7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBUd2Vha01hbmlmZXN0IH0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9UV0VBS19TVE9SRV9JTkRFWF9VUkwgPVxuICBcImh0dHBzOi8vdGhlcmVhbGl0eXJlcG9ydC5naXRodWIuaW8vdHdlYWtlcnMvc3RvcmUvaW5kZXguanNvblwiO1xuZXhwb3J0IGNvbnN0IFRXRUFLX1NUT1JFX1JFVklFV19JU1NVRV9VUkwgPVxuICBcImh0dHBzOi8vZ2l0aHViLmNvbS90aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzL2lzc3Vlcy9uZXdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0b3JlUmVnaXN0cnkge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICBnZW5lcmF0ZWRBdD86IHN0cmluZztcbiAgZW50cmllczogVHdlYWtTdG9yZUVudHJ5W107XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdG9yZUVudHJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIC8qKlxuICAgKiBBbiBlbnRyeSBjYW4gYmUgY2F0YWxvZyBtZXRhZGF0YSBiZWZvcmUgaXRzIGltcGxlbWVudGF0aW9uIGlzIHNoaXBwZWQuXG4gICAqIE1ldGFkYXRhLW9ubHkgZW50cmllcyBkZWxpYmVyYXRlbHkgb21pdCBpbnN0YWxsIGNvb3JkaW5hdGVzIGFuZCBhcmUgbmV2ZXJcbiAgICogb2ZmZXJlZCB0byB0aGUgYXJjaGl2ZSBpbnN0YWxsZXIuXG4gICovXG4gIGF2YWlsYWJsZT86IGJvb2xlYW47XG4gIC8qKiBSZW1vdGUgc291cmNlIGNvb3JkaW5hdGVzIGFyZSByZXF1aXJlZCBvbmx5IGZvciByZW1vdGUgZW50cmllcy4gKi9cbiAgcmVwbz86IHN0cmluZztcbiAgYXBwcm92ZWRDb21taXRTaGE/OiBzdHJpbmc7XG4gIC8qKiBQYWNrYWdlZCBlbnRyaWVzIHBvaW50IGF0IHRoZSBpbnN0YWxsZXItYnVuZGxlZCBjYW5vbmljYWwgc291cmNlLiAqL1xuICBzb3VyY2U/OiBUd2Vha1N0b3JlU291cmNlO1xuICBhcHByb3ZlZEF0OiBzdHJpbmc7XG4gIGFwcHJvdmVkQnk6IHN0cmluZztcbiAgcGxhdGZvcm1zPzogVHdlYWtTdG9yZVBsYXRmb3JtW107XG4gIHJlbGVhc2VVcmw/OiBzdHJpbmc7XG4gIHJldmlld1VybD86IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgVHdlYWtTdG9yZVNvdXJjZSA9XG4gIHwgeyBraW5kOiBcImJ1bmRsZWRcIjsgcGF0aDogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwicmVtb3RlXCI7IHJlcG86IHN0cmluZzsgYXBwcm92ZWRDb21taXRTaGE6IHN0cmluZyB9O1xuXG4vKiogQ2Fub25pY2FsIHByb2plY3Qtb3duZWQgdHdlYWsgaWRlbnRpZmllcnMgYW5kIHNvdXJjZSBkaXJlY3Rvcmllcy4gKi9cbmV4cG9ydCBjb25zdCBCVU5ETEVEX1RXRUFLX1NPVVJDRV9QQVRIUzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gPSBPYmplY3QuZnJlZXplKHtcbiAgXCJjby50d2Vha2Vycy5hY2NvdW50LXN3aXRjaGVyXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLmFjY291bnQtc3dpdGNoZXJcIixcbiAgXCJjby50d2Vha2Vycy5hcHBzaG90c1wiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5hcHBzaG90c1wiLFxuICBcImNvLnR3ZWFrZXJzLmRldmVsb3Blci10b29sc1wiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5kZXZlbG9wZXItdG9vbHNcIixcbiAgXCJjby50d2Vha2Vycy5zaGFkY24tY29kZXgtdWlcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuc2hhZGNuLWNvZGV4LXVpXCIsXG4gIFwiY28udHdlYWtlcnMuZm9sbG93dXBcIjogXCJ0d2Vha3MvZm9sbG93dXBcIixcbiAgXCJjby50d2Vha2Vycy5wcm9qZWN0c1wiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5wcm9qZWN0c1wiLFxuICBcImNvLnR3ZWFrZXJzLnRocmVhZC1zdW1tYXJ5LXByb2ZpbGVzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLnRocmVhZC1zdW1tYXJ5LXByb2ZpbGVzXCIsXG4gIFwiY28udHdlYWtlcnMudGl0bGViYXItY29udHJvbHNcIjogXCJ0d2Vha3MvdGl0bGViYXItY29udHJvbHNcIixcbiAgXCJjby50d2Vha2Vycy51aS1pbXByb3ZlbWVudHNcIjogXCJ0d2Vha3MvdWktaW1wcm92ZW1lbnRzXCIsXG4gIFwiY28udHdlYWtlcnMudXNlci1xdWVzdGlvbnNcIjogXCJ0d2Vha3MvdXNlci1xdWVzdGlvbnNcIixcbiAgXCJjby50d2Vha2Vycy51c2FnZS1saW1pdC1yZXNldHMtdHJhY2tlclwiOiBcInR3ZWFrcy91c2FnZS1saW1pdC1yZXNldHMtdHJhY2tlclwiLFxufSk7XG5cbmV4cG9ydCB0eXBlIFR3ZWFrSGVhbHRoU3RhdHVzID0gXCJmYWlsZWRcIiB8IFwicXVhcmFudGluZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha0hlYWx0aFJlY29yZCB7XG4gIHN0YXR1czogVHdlYWtIZWFsdGhTdGF0dXM7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuLyoqIFRoZSB1c2VyLWZhY2luZyBzdGF0ZSB2b2NhYnVsYXJ5IGZvciBjYXRhbG9nIHJvd3MuICovXG5leHBvcnQgdHlwZSBUd2Vha1N0YXR1cyA9XG4gIHwgXCJpbnN0YWxsZWRcIlxuICB8IFwibm90LWluc3RhbGxlZFwiXG4gIHwgXCJlbmFibGVkXCJcbiAgfCBcImRpc2FibGVkXCJcbiAgfCBcImZhaWxlZFwiXG4gIHwgXCJxdWFyYW50aW5lZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RhdHVzSW5wdXQge1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIGhlYWx0aD86IFR3ZWFrSGVhbHRoUmVjb3JkIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlcml2ZVR3ZWFrU3RhdHVzKGlucHV0OiBUd2Vha1N0YXR1c0lucHV0KTogVHdlYWtTdGF0dXMge1xuICBpZiAoIWlucHV0Lmluc3RhbGxlZCkgcmV0dXJuIFwibm90LWluc3RhbGxlZFwiO1xuICBpZiAoaW5wdXQuaGVhbHRoPy5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikgcmV0dXJuIFwicXVhcmFudGluZWRcIjtcbiAgaWYgKGlucHV0LmhlYWx0aD8uc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJmYWlsZWRcIjtcbiAgcmV0dXJuIGlucHV0LmVuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIjtcbn1cblxuZXhwb3J0IHR5cGUgVHdlYWtTdG9yZVBsYXRmb3JtID0gXCJkYXJ3aW5cIiB8IFwid2luMzJcIiB8IFwibGludXhcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0b3JlUHVibGlzaFN1Ym1pc3Npb24ge1xuICByZXBvOiBzdHJpbmc7XG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZztcbiAgY29tbWl0U2hhOiBzdHJpbmc7XG4gIGNvbW1pdFVybDogc3RyaW5nO1xuICBtYW5pZmVzdD86IHtcbiAgICBpZD86IHN0cmluZztcbiAgICBuYW1lPzogc3RyaW5nO1xuICAgIHZlcnNpb24/OiBzdHJpbmc7XG4gICAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gICAgaWNvblVybD86IHN0cmluZztcbiAgfTtcbn1cblxuY29uc3QgR0lUSFVCX1JFUE9fUkUgPSAvXltBLVphLXowLTlfLi1dK1xcL1tBLVphLXowLTlfLi1dKyQvO1xuY29uc3QgRlVMTF9TSEFfUkUgPSAvXlthLWYwLTldezQwfSQvaTtcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZUdpdEh1YlJlcG8oaW5wdXQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJhdyA9IGlucHV0LnRyaW0oKTtcbiAgaWYgKCFyYXcpIHRocm93IG5ldyBFcnJvcihcIkdpdEh1YiByZXBvIGlzIHJlcXVpcmVkXCIpO1xuXG4gIGNvbnN0IHNzaCA9IC9eZ2l0QGdpdGh1YlxcLmNvbTooW14vXStcXC9bXi9dKz8pKD86XFwuZ2l0KT8kL2kuZXhlYyhyYXcpO1xuICBpZiAoc3NoKSByZXR1cm4gbm9ybWFsaXplUmVwb1BhcnQoc3NoWzFdKTtcblxuICBpZiAoL15odHRwcz86XFwvXFwvL2kudGVzdChyYXcpKSB7XG4gICAgY29uc3QgdXJsID0gbmV3IFVSTChyYXcpO1xuICAgIGlmICh1cmwuaG9zdG5hbWUgIT09IFwiZ2l0aHViLmNvbVwiKSB0aHJvdyBuZXcgRXJyb3IoXCJPbmx5IGdpdGh1Yi5jb20gcmVwb3NpdG9yaWVzIGFyZSBzdXBwb3J0ZWRcIik7XG4gICAgY29uc3QgcGFydHMgPSB1cmwucGF0aG5hbWUucmVwbGFjZSgvXlxcLyt8XFwvKyQvZywgXCJcIikuc3BsaXQoXCIvXCIpO1xuICAgIGlmIChwYXJ0cy5sZW5ndGggPCAyKSB0aHJvdyBuZXcgRXJyb3IoXCJHaXRIdWIgcmVwbyBVUkwgbXVzdCBpbmNsdWRlIG93bmVyIGFuZCByZXBvc2l0b3J5XCIpO1xuICAgIHJldHVybiBub3JtYWxpemVSZXBvUGFydChgJHtwYXJ0c1swXX0vJHtwYXJ0c1sxXX1gKTtcbiAgfVxuXG4gIHJldHVybiBub3JtYWxpemVSZXBvUGFydChyYXcpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3RvcmVSZWdpc3RyeShpbnB1dDogdW5rbm93bik6IFR3ZWFrU3RvcmVSZWdpc3RyeSB7XG4gIGNvbnN0IHJlZ2lzdHJ5ID0gaW5wdXQgYXMgUGFydGlhbDxUd2Vha1N0b3JlUmVnaXN0cnk+IHwgbnVsbDtcbiAgaWYgKCFyZWdpc3RyeSB8fCByZWdpc3RyeS5zY2hlbWFWZXJzaW9uICE9PSAxIHx8ICFBcnJheS5pc0FycmF5KHJlZ2lzdHJ5LmVudHJpZXMpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgdHdlYWsgc3RvcmUgcmVnaXN0cnlcIik7XG4gIH1cbiAgY29uc3QgZW50cmllcyA9IHJlZ2lzdHJ5LmVudHJpZXMubWFwKG5vcm1hbGl6ZVN0b3JlRW50cnkpO1xuICBlbnRyaWVzLnNvcnQoKGEsIGIpID0+IGEubWFuaWZlc3QubmFtZS5sb2NhbGVDb21wYXJlKGIubWFuaWZlc3QubmFtZSkpO1xuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IDEsXG4gICAgZ2VuZXJhdGVkQXQ6IHR5cGVvZiByZWdpc3RyeS5nZW5lcmF0ZWRBdCA9PT0gXCJzdHJpbmdcIiA/IHJlZ2lzdHJ5LmdlbmVyYXRlZEF0IDogdW5kZWZpbmVkLFxuICAgIGVudHJpZXMsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaHVmZmxlU3RvcmVFbnRyaWVzPFQ+KFxuICBlbnRyaWVzOiByZWFkb25seSBUW10sXG4gIHJhbmRvbUluZGV4OiAoZXhjbHVzaXZlTWF4OiBudW1iZXIpID0+IG51bWJlciA9IChleGNsdXNpdmVNYXgpID0+IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGV4Y2x1c2l2ZU1heCksXG4pOiBUW10ge1xuICBjb25zdCBzaHVmZmxlZCA9IFsuLi5lbnRyaWVzXTtcbiAgZm9yIChsZXQgaSA9IHNodWZmbGVkLmxlbmd0aCAtIDE7IGkgPiAwOyBpIC09IDEpIHtcbiAgICBjb25zdCBqID0gcmFuZG9tSW5kZXgoaSArIDEpO1xuICAgIGlmICghTnVtYmVyLmlzSW50ZWdlcihqKSB8fCBqIDwgMCB8fCBqID4gaSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBzaHVmZmxlIHJhbmRvbUluZGV4IHJldHVybmVkICR7an07IGV4cGVjdGVkIGFuIGludGVnZXIgZnJvbSAwIHRvICR7aX1gKTtcbiAgICB9XG4gICAgW3NodWZmbGVkW2ldLCBzaHVmZmxlZFtqXV0gPSBbc2h1ZmZsZWRbal0sIHNodWZmbGVkW2ldXTtcbiAgfVxuICByZXR1cm4gc2h1ZmZsZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTdG9yZUVudHJ5KGlucHV0OiB1bmtub3duKTogVHdlYWtTdG9yZUVudHJ5IHtcbiAgY29uc3QgZW50cnkgPSBpbnB1dCBhcyBQYXJ0aWFsPFR3ZWFrU3RvcmVFbnRyeT4gfCBudWxsO1xuICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgdGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCB0d2VhayBzdG9yZSBlbnRyeVwiKTtcbiAgY29uc3QgbWFuaWZlc3QgPSBlbnRyeS5tYW5pZmVzdCBhcyBUd2Vha01hbmlmZXN0IHwgdW5kZWZpbmVkO1xuICBjb25zdCBhdmFpbGFibGUgPSBlbnRyeS5hdmFpbGFibGUgIT09IGZhbHNlO1xuICBpZiAoIW1hbmlmZXN0Py5pZCB8fCAhbWFuaWZlc3QubmFtZSB8fCAhbWFuaWZlc3QudmVyc2lvbiB8fCAhbWFuaWZlc3QuZ2l0aHViUmVwbykge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlN0b3JlIGVudHJ5IGlzIG1pc3NpbmcgbWFuaWZlc3QgZmllbGRzXCIpO1xuICB9XG4gIGNvbnN0IHN1cHBsaWVkUmVwbyA9IHR5cGVvZiBlbnRyeS5yZXBvID09PSBcInN0cmluZ1wiICYmIGVudHJ5LnJlcG8udHJpbSgpXG4gICAgPyBub3JtYWxpemVHaXRIdWJSZXBvKGVudHJ5LnJlcG8pXG4gICAgOiB1bmRlZmluZWQ7XG4gIGlmIChzdXBwbGllZFJlcG8gJiYgbm9ybWFsaXplR2l0SHViUmVwbyhtYW5pZmVzdC5naXRodWJSZXBvKSAhPT0gc3VwcGxpZWRSZXBvKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSByZXBvIGRvZXMgbm90IG1hdGNoIG1hbmlmZXN0IGdpdGh1YlJlcG9gKTtcbiAgfVxuICBjb25zdCBzb3VyY2VJbnB1dCA9IChlbnRyeSBhcyB7IHNvdXJjZT86IHVua25vd24gfSkuc291cmNlO1xuICBsZXQgc291cmNlOiBUd2Vha1N0b3JlU291cmNlIHwgdW5kZWZpbmVkO1xuICBsZXQgcmVwbyA9IHN1cHBsaWVkUmVwbztcbiAgbGV0IGFwcHJvdmVkQ29tbWl0U2hhID0gdHlwZW9mIGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhID09PSBcInN0cmluZ1wiID8gZW50cnkuYXBwcm92ZWRDb21taXRTaGEgOiBcIlwiO1xuICBpZiAoc291cmNlSW5wdXQgIT09IHVuZGVmaW5lZCkge1xuICAgIGlmICghc291cmNlSW5wdXQgfHwgdHlwZW9mIHNvdXJjZUlucHV0ICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkoc291cmNlSW5wdXQpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IGhhcyBhbiBpbnZhbGlkIHNvdXJjZWApO1xuICAgIH1cbiAgICBjb25zdCByYXdTb3VyY2UgPSBzb3VyY2VJbnB1dCBhcyB7IGtpbmQ/OiB1bmtub3duOyBwYXRoPzogdW5rbm93bjsgcmVwbz86IHVua25vd247IGFwcHJvdmVkQ29tbWl0U2hhPzogdW5rbm93biB9O1xuICAgIGlmIChyYXdTb3VyY2Uua2luZCA9PT0gXCJidW5kbGVkXCIpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBub3JtYWxpemVCdW5kbGVkU291cmNlUGF0aChyYXdTb3VyY2UucGF0aCwgbWFuaWZlc3QuaWQpO1xuICAgICAgc291cmNlID0geyBraW5kOiBcImJ1bmRsZWRcIiwgcGF0aCB9O1xuICAgICAgLy8gQSBidW5kbGVkIHNvdXJjZSBpcyBpbnRlbnRpb25hbGx5IGluZGVwZW5kZW50IG9mIEdpdEh1YiBjb29yZGluYXRlcy5cbiAgICAgIHJlcG8gPSBzdXBwbGllZFJlcG87XG4gICAgICBhcHByb3ZlZENvbW1pdFNoYSA9IFwiXCI7XG4gICAgfSBlbHNlIGlmIChyYXdTb3VyY2Uua2luZCA9PT0gXCJyZW1vdGVcIikge1xuICAgICAgY29uc3QgcmVtb3RlUmVwbyA9IG5vcm1hbGl6ZUdpdEh1YlJlcG8oU3RyaW5nKHJhd1NvdXJjZS5yZXBvID8/IHN1cHBsaWVkUmVwbyA/PyBcIlwiKSk7XG4gICAgICBjb25zdCBzaGEgPSBTdHJpbmcocmF3U291cmNlLmFwcHJvdmVkQ29tbWl0U2hhID8/IGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhID8/IFwiXCIpO1xuICAgICAgaWYgKGF2YWlsYWJsZSAmJiAhaXNGdWxsQ29tbWl0U2hhKHNoYSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBtdXN0IHBpbiBhIGZ1bGwgYXBwcm92ZWQgY29tbWl0IFNIQWApO1xuICAgICAgfVxuICAgICAgaWYgKHN1cHBsaWVkUmVwbyAmJiBzdXBwbGllZFJlcG8gIT09IHJlbW90ZVJlcG8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSByZW1vdGUgc291cmNlIHJlcG8gZG9lcyBub3QgbWF0Y2ggcmVwb2ApO1xuICAgICAgfVxuICAgICAgc291cmNlID0geyBraW5kOiBcInJlbW90ZVwiLCByZXBvOiByZW1vdGVSZXBvLCBhcHByb3ZlZENvbW1pdFNoYTogc2hhIH07XG4gICAgICByZXBvID0gcmVtb3RlUmVwbztcbiAgICAgIGFwcHJvdmVkQ29tbWl0U2hhID0gc2hhO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IGhhcyB1bnN1cHBvcnRlZCBzb3VyY2Uga2luZGApO1xuICAgIH1cbiAgfSBlbHNlIGlmIChhdmFpbGFibGUpIHtcbiAgICAvLyBMZWdhY3kgYXZhaWxhYmxlIGVudHJpZXMgYXJlIHJlbW90ZSBhbmQgbXVzdCByZW1haW4gcGlubmVkLlxuICAgIHJlcG8gPSBub3JtYWxpemVHaXRIdWJSZXBvKFN0cmluZyhyZXBvID8/IG1hbmlmZXN0LmdpdGh1YlJlcG8gPz8gXCJcIikpO1xuICAgIGlmICghaXNGdWxsQ29tbWl0U2hhKGFwcHJvdmVkQ29tbWl0U2hhKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBtdXN0IHBpbiBhIGZ1bGwgYXBwcm92ZWQgY29tbWl0IFNIQWApO1xuICAgIH1cbiAgICBzb3VyY2UgPSB7IGtpbmQ6IFwicmVtb3RlXCIsIHJlcG8sIGFwcHJvdmVkQ29tbWl0U2hhIH07XG4gIH0gZWxzZSBpZiAoIXJlcG8pIHtcbiAgICAvLyBNZXRhZGF0YS1vbmx5IGVudHJpZXMgbWF5IG9taXQgYWxsIGluc3RhbGwgY29vcmRpbmF0ZXMuIEtlZXAgdGhlIHNvdXJjZVxuICAgIC8vIGFic2VudCBzbyBjYWxsZXJzIGNhbm5vdCBhY2NpZGVudGFsbHkgdHJlYXQgdGhlbSBhcyBpbnN0YWxsYWJsZS5cbiAgfVxuICByZXR1cm4ge1xuICAgIGlkOiBtYW5pZmVzdC5pZCxcbiAgICBtYW5pZmVzdCxcbiAgICBhdmFpbGFibGUsXG4gICAgLi4uKHJlcG8gPyB7IHJlcG8gfSA6IHt9KSxcbiAgICBhcHByb3ZlZENvbW1pdFNoYSxcbiAgICAuLi4oc291cmNlID8geyBzb3VyY2UgfSA6IHt9KSxcbiAgICBhcHByb3ZlZEF0OiB0eXBlb2YgZW50cnkuYXBwcm92ZWRBdCA9PT0gXCJzdHJpbmdcIiA/IGVudHJ5LmFwcHJvdmVkQXQgOiBcIlwiLFxuICAgIGFwcHJvdmVkQnk6IHR5cGVvZiBlbnRyeS5hcHByb3ZlZEJ5ID09PSBcInN0cmluZ1wiID8gZW50cnkuYXBwcm92ZWRCeSA6IFwiXCIsXG4gICAgcGxhdGZvcm1zOiBub3JtYWxpemVTdG9yZVBsYXRmb3JtcygoZW50cnkgYXMgeyBwbGF0Zm9ybXM/OiB1bmtub3duIH0pLnBsYXRmb3JtcyksXG4gICAgcmVsZWFzZVVybDogb3B0aW9uYWxHaXRodWJVcmwoZW50cnkucmVsZWFzZVVybCksXG4gICAgcmV2aWV3VXJsOiBvcHRpb25hbEdpdGh1YlVybChlbnRyeS5yZXZpZXdVcmwpLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RvcmVBcmNoaXZlVXJsKGVudHJ5OiBUd2Vha1N0b3JlRW50cnkpOiBzdHJpbmcge1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gdXNlcyBhIGJ1bmRsZWQgc291cmNlIGFuZCBoYXMgbm8gYXJjaGl2ZSBVUkxgKTtcbiAgfVxuICBjb25zdCByZXBvID0gZW50cnkuc291cmNlPy5raW5kID09PSBcInJlbW90ZVwiID8gZW50cnkuc291cmNlLnJlcG8gOiBlbnRyeS5yZXBvO1xuICBjb25zdCBhcHByb3ZlZENvbW1pdFNoYSA9IGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJyZW1vdGVcIlxuICAgID8gZW50cnkuc291cmNlLmFwcHJvdmVkQ29tbWl0U2hhXG4gICAgOiBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYTtcbiAgaWYgKCFyZXBvIHx8ICFpc0Z1bGxDb21taXRTaGEoYXBwcm92ZWRDb21taXRTaGEgPz8gXCJcIikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7ZW50cnkuaWR9IGlzIG5vdCBwaW5uZWQgdG8gYSBmdWxsIGNvbW1pdCBTSEFgKTtcbiAgfVxuICByZXR1cm4gYGh0dHBzOi8vY29kZWxvYWQuZ2l0aHViLmNvbS8ke3JlcG99L3Rhci5nei8ke2FwcHJvdmVkQ29tbWl0U2hhfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0J1bmRsZWRTdG9yZUVudHJ5KGVudHJ5OiBUd2Vha1N0b3JlRW50cnkpOiBib29sZWFuIHtcbiAgcmV0dXJuIGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJidW5kbGVkXCI7XG59XG5cbi8qKiBSZXNvbHZlIGEgcGFja2FnZWQgc291cmNlIHdoaWxlIHJlamVjdGluZyB0cmF2ZXJzYWwgYW5kIElEIG1pc21hdGNoZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZUJ1bmRsZWRUd2Vha1BhdGgoXG4gIHBhY2thZ2VkVHdlYWtzUm9vdDogc3RyaW5nLFxuICBlbnRyeTogUGljazxUd2Vha1N0b3JlRW50cnksIFwiaWRcIiB8IFwic291cmNlXCI+LFxuKTogc3RyaW5nIHtcbiAgaWYgKGVudHJ5LnNvdXJjZT8ua2luZCAhPT0gXCJidW5kbGVkXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7ZW50cnkuaWR9IGRvZXMgbm90IHVzZSBhIGJ1bmRsZWQgc291cmNlYCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGVudHJ5LnNvdXJjZS5wYXRoLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKTtcbiAgaWYgKFxuICAgICFub3JtYWxpemVkIHx8XG4gICAgbm9ybWFsaXplZC5zdGFydHNXaXRoKFwiL1wiKSB8fFxuICAgIG5vcm1hbGl6ZWQuc3BsaXQoXCIvXCIpLnNvbWUoKHBhcnQpID0+IHBhcnQgPT09IFwiLi5cIiB8fCBwYXJ0ID09PSBcIlwiKSB8fFxuICAgIG5vcm1hbGl6ZWQgIT09IEJVTkRMRURfVFdFQUtfU09VUkNFX1BBVEhTW2VudHJ5LmlkXVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7ZW50cnkuaWR9IGhhcyBhbiB1bnNhZmUgYnVuZGxlZCBzb3VyY2UgcGF0aGApO1xuICB9XG4gIC8vIFRoZSBub3JtYWxpemVkIHBhdGggaXMgZXhhY3RseSBgdHdlYWtzLzxpZD5gIChubyBkb3Qgc2VnbWVudHMpLCBzbyBhXG4gIC8vIHNpbXBsZSBqb2luIGlzIHN1ZmZpY2llbnQgYW5kIGtlZXBzIHRoaXMgc2hhcmVkIG1vZHVsZSBicm93c2VyLWJ1bmRsZWFibGUuXG4gIGNvbnN0IHJvb3QgPSBwYWNrYWdlZFR3ZWFrc1Jvb3QucmVwbGFjZSgvW1xcXFwvXSskLywgXCJcIik7XG4gIHJldHVybiBgJHtyb290fS8ke25vcm1hbGl6ZWR9YDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQnVuZGxlZFNvdXJjZVBhdGgodmFsdWU6IHVua25vd24sIGlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7aWR9IGJ1bmRsZWQgc291cmNlIHBhdGggaXMgcmVxdWlyZWRgKTtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IHZhbHVlLnJlcGxhY2VBbGwoXCJcXFxcXCIsIFwiL1wiKS5yZXBsYWNlKC9eXFwuXFwvLywgXCJcIik7XG4gIGlmIChub3JtYWxpemVkICE9PSBCVU5ETEVEX1RXRUFLX1NPVVJDRV9QQVRIU1tpZF0pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7aWR9IGJ1bmRsZWQgc291cmNlIGlzIG5vdCBhbGxvd2xpc3RlZGApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRUd2Vha1B1Ymxpc2hJc3N1ZVVybChzdWJtaXNzaW9uOiBUd2Vha1N0b3JlUHVibGlzaFN1Ym1pc3Npb24pOiBzdHJpbmcge1xuICBjb25zdCByZXBvID0gbm9ybWFsaXplR2l0SHViUmVwbyhzdWJtaXNzaW9uLnJlcG8pO1xuICBpZiAoIWlzRnVsbENvbW1pdFNoYShzdWJtaXNzaW9uLmNvbW1pdFNoYSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJTdWJtaXNzaW9uIG11c3QgaW5jbHVkZSB0aGUgZnVsbCBjb21taXQgU0hBIHRvIHJldmlld1wiKTtcbiAgfVxuICBjb25zdCB0aXRsZSA9IGBUd2VhayBzdG9yZSByZXZpZXc6ICR7cmVwb31gO1xuICBjb25zdCBib2R5ID0gW1xuICAgIFwiIyMgVHdlYWsgcmVwb1wiLFxuICAgIGBodHRwczovL2dpdGh1Yi5jb20vJHtyZXBvfWAsXG4gICAgXCJcIixcbiAgICBcIiMjIENvbW1pdCB0byByZXZpZXdcIixcbiAgICBzdWJtaXNzaW9uLmNvbW1pdFNoYSxcbiAgICBzdWJtaXNzaW9uLmNvbW1pdFVybCxcbiAgICBcIlwiLFxuICAgIFwiRG8gbm90IGFwcHJvdmUgYSBkaWZmZXJlbnQgY29tbWl0LiBJZiB0aGUgYXV0aG9yIHB1c2hlcyBjaGFuZ2VzLCBhc2sgdGhlbSB0byByZXN1Ym1pdC5cIixcbiAgICBcIlwiLFxuICAgIFwiIyMgTWFuaWZlc3RcIixcbiAgICBgLSBpZDogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5pZCA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSBuYW1lOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/Lm5hbWUgPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gdmVyc2lvbjogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py52ZXJzaW9uID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIGRlc2NyaXB0aW9uOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/LmRlc2NyaXB0aW9uID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIGljb25Vcmw6ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8uaWNvblVybCA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBcIlwiLFxuICAgIFwiIyMgQWRtaW4gY2hlY2tsaXN0XCIsXG4gICAgXCItIFsgXSBtYW5pZmVzdC5qc29uIGlzIHZhbGlkXCIsXG4gICAgXCItIFsgXSBtYW5pZmVzdC5pY29uVXJsIGlzIHVzYWJsZSBhcyB0aGUgc3RvcmUgaWNvblwiLFxuICAgIFwiLSBbIF0gc291cmNlIHdhcyByZXZpZXdlZCBhdCB0aGUgZXhhY3QgY29tbWl0IGFib3ZlXCIsXG4gICAgXCItIFsgXSBgc3RvcmUvaW5kZXguanNvbmAgZW50cnkgcGlucyBgYXBwcm92ZWRDb21taXRTaGFgIHRvIHRoZSBleGFjdCBjb21taXQgYWJvdmVcIixcbiAgXS5qb2luKFwiXFxuXCIpO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKFRXRUFLX1NUT1JFX1JFVklFV19JU1NVRV9VUkwpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldChcInRlbXBsYXRlXCIsIFwidHdlYWstc3RvcmUtcmV2aWV3Lm1kXCIpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldChcInRpdGxlXCIsIHRpdGxlKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJib2R5XCIsIGJvZHkpO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0Z1bGxDb21taXRTaGEodmFsdWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gRlVMTF9TSEFfUkUudGVzdCh2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcG9QYXJ0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByZXBvID0gdmFsdWUudHJpbSgpLnJlcGxhY2UoL1xcLmdpdCQvaSwgXCJcIikucmVwbGFjZSgvXlxcLyt8XFwvKyQvZywgXCJcIik7XG4gIGlmICghR0lUSFVCX1JFUE9fUkUudGVzdChyZXBvKSkgdGhyb3cgbmV3IEVycm9yKFwiR2l0SHViIHJlcG8gbXVzdCBiZSBpbiBvd25lci9yZXBvIGZvcm1cIik7XG4gIHJldHVybiByZXBvO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdG9yZVBsYXRmb3JtcyhpbnB1dDogdW5rbm93bik6IFR3ZWFrU3RvcmVQbGF0Zm9ybVtdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGlucHV0ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmICghQXJyYXkuaXNBcnJheShpbnB1dCkpIHRocm93IG5ldyBFcnJvcihcIlN0b3JlIGVudHJ5IHBsYXRmb3JtcyBtdXN0IGJlIGFuIGFycmF5XCIpO1xuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxUd2Vha1N0b3JlUGxhdGZvcm0+KFtcImRhcndpblwiLCBcIndpbjMyXCIsIFwibGludXhcIl0pO1xuICBjb25zdCBwbGF0Zm9ybXMgPSBBcnJheS5mcm9tKG5ldyBTZXQoaW5wdXQubWFwKCh2YWx1ZSkgPT4ge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIWFsbG93ZWQuaGFzKHZhbHVlIGFzIFR3ZWFrU3RvcmVQbGF0Zm9ybSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgc3RvcmUgcGxhdGZvcm06ICR7U3RyaW5nKHZhbHVlKX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlIGFzIFR3ZWFrU3RvcmVQbGF0Zm9ybTtcbiAgfSkpKTtcbiAgcmV0dXJuIHBsYXRmb3Jtcy5sZW5ndGggPiAwID8gcGxhdGZvcm1zIDogdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBvcHRpb25hbEdpdGh1YlVybCh2YWx1ZTogdW5rbm93bik6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIXZhbHVlLnRyaW0oKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgdXJsID0gbmV3IFVSTCh2YWx1ZSk7XG4gIGlmICh1cmwucHJvdG9jb2wgIT09IFwiaHR0cHM6XCIgfHwgdXJsLmhvc3RuYW1lICE9PSBcImdpdGh1Yi5jb21cIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuIiwgImV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3NOYXZpZ2F0aW9uVHdlYWsge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIGljb25Vcmw/OiBzdHJpbmc7XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogc3RyaW5nO1xuICBoZWFsdGhFcnJvcj86IHN0cmluZyB8IG51bGw7XG4gIGxpZmVjeWNsZU92ZXJyaWRlPzogU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzUGFnZVJlZ2lzdHJhdGlvblN1bW1hcnkge1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBpY29uU3ZnPzogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGUgPVxuICB8IFwiZW5hYmxlZFwiXG4gIHwgXCJmYWlsZWRcIlxuICB8IFwicXVhcmFudGluZWRcIlxuICB8IFwic3RhcnRpbmdcIlxuICB8IFwidGltZWRfb3V0XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSB7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBpY29uVXJsPzogc3RyaW5nO1xuICBpY29uU3ZnPzogc3RyaW5nO1xuICByZWdpc3RyYXRpb25JZHM6IHN0cmluZ1tdO1xuICBmYWxsYmFjazogYm9vbGVhbjtcbiAgbGlmZWN5Y2xlOiBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGU7XG4gIHdhcm5pbmc6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsKFxuICB0d2Vha3M6IFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrW10sXG4gIHJlZ2lzdHJhdGlvbnM6IFNldHRpbmdzUGFnZVJlZ2lzdHJhdGlvblN1bW1hcnlbXSxcbik6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSB7XG4gIGNvbnN0IHJlZ2lzdHJhdGlvbnNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdzUGFnZVJlZ2lzdHJhdGlvblN1bW1hcnlbXT4oKTtcbiAgZm9yIChjb25zdCByZWdpc3RyYXRpb24gb2YgcmVnaXN0cmF0aW9ucykge1xuICAgIGNvbnN0IGdyb3VwID0gcmVnaXN0cmF0aW9uc0J5VHdlYWsuZ2V0KHJlZ2lzdHJhdGlvbi50d2Vha0lkKSA/PyBbXTtcbiAgICBncm91cC5wdXNoKHJlZ2lzdHJhdGlvbik7XG4gICAgcmVnaXN0cmF0aW9uc0J5VHdlYWsuc2V0KHJlZ2lzdHJhdGlvbi50d2Vha0lkLCBncm91cCk7XG4gIH1cblxuICBjb25zdCByb3dzOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHR3ZWFrIG9mIHR3ZWFrcykge1xuICAgIGlmICghdHdlYWsuZW5hYmxlZCB8fCBzZWVuLmhhcyh0d2Vhay5pZCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHR3ZWFrLmlkKTtcbiAgICBjb25zdCBwYWdlcyA9IHJlZ2lzdHJhdGlvbnNCeVR3ZWFrLmdldCh0d2Vhay5pZCkgPz8gW107XG4gICAgY29uc3QgcHJpbWFyeSA9IHBhZ2VzWzBdO1xuICAgIHJvd3MucHVzaCh7XG4gICAgICB0d2Vha0lkOiB0d2Vhay5pZCxcbiAgICAgIHRpdGxlOiBwcmltYXJ5Py50aXRsZSB8fCB0d2Vhay5uYW1lLFxuICAgICAgdmVyc2lvbjogdHdlYWsudmVyc2lvbixcbiAgICAgIGRlc2NyaXB0aW9uOiBwcmltYXJ5Py5kZXNjcmlwdGlvbiB8fCB0d2Vhay5kZXNjcmlwdGlvbiB8fCBcIkVuYWJsZWQgVHdlYWtlci5cIixcbiAgICAgIGljb25Vcmw6IHR3ZWFrLmljb25VcmwsXG4gICAgICBpY29uU3ZnOiBwcmltYXJ5Py5pY29uU3ZnLFxuICAgICAgcmVnaXN0cmF0aW9uSWRzOiBwYWdlcy5tYXAoKHBhZ2UpID0+IHBhZ2UuaWQpLFxuICAgICAgZmFsbGJhY2s6IHBhZ2VzLmxlbmd0aCA9PT0gMCxcbiAgICAgIGxpZmVjeWNsZTogbGlmZWN5Y2xlRm9yKHR3ZWFrKSxcbiAgICAgIHdhcm5pbmc6IHR3ZWFrLmhlYWx0aEVycm9yIHx8IG51bGwsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHJvd3Muc29ydCgoYSwgYikgPT4gYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpIHx8IGEudHdlYWtJZC5sb2NhbGVDb21wYXJlKGIudHdlYWtJZCkpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVGb3IodHdlYWs6IFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrKTogU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlIHtcbiAgaWYgKHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlKSByZXR1cm4gdHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGU7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcImZhaWxlZFwiO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIpIHJldHVybiBcInF1YXJhbnRpbmVkXCI7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwic3RhcnRpbmdcIikgcmV0dXJuIFwic3RhcnRpbmdcIjtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJ0aW1lZF9vdXRcIikgcmV0dXJuIFwidGltZWRfb3V0XCI7XG4gIHJldHVybiBcImVuYWJsZWRcIjtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFR3ZWFrTWFuaWZlc3QgfSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5pbXBvcnQgdHlwZSB7IFR3ZWFrU3RhdHVzIH0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5cbmV4cG9ydCB0eXBlIFR3ZWFrc1BhZ2VGaWx0ZXIgPSBcImFsbFwiIHwgXCJlbmFibGVkXCIgfCBcImRpc2FibGVkXCIgfCBcInVwZGF0ZXNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha3NQYWdlSXRlbSB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIHVwZGF0ZTogeyB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW4gfSB8IG51bGw7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrc1BhZ2VDb3VudHMgPSBSZWNvcmQ8VHdlYWtzUGFnZUZpbHRlciwgbnVtYmVyPjtcblxuZXhwb3J0IGNvbnN0IFRXRUFLU19QQUdFX0ZJTFRFUlM6IHJlYWRvbmx5IFR3ZWFrc1BhZ2VGaWx0ZXJbXSA9IFtcbiAgXCJhbGxcIixcbiAgXCJlbmFibGVkXCIsXG4gIFwiZGlzYWJsZWRcIixcbiAgXCJ1cGRhdGVzXCIsXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gdHdlYWtzUGFnZUNvdW50cyhpdGVtczogcmVhZG9ubHkgVHdlYWtzUGFnZUl0ZW1bXSk6IFR3ZWFrc1BhZ2VDb3VudHMge1xuICByZXR1cm4ge1xuICAgIGFsbDogaXRlbXMubGVuZ3RoLFxuICAgIGVuYWJsZWQ6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJlbmFibGVkXCIpKS5sZW5ndGgsXG4gICAgZGlzYWJsZWQ6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJkaXNhYmxlZFwiKSkubGVuZ3RoLFxuICAgIHVwZGF0ZXM6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJ1cGRhdGVzXCIpKS5sZW5ndGgsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJUd2Vha3NQYWdlSXRlbXM8VCBleHRlbmRzIFR3ZWFrc1BhZ2VJdGVtPihcbiAgaXRlbXM6IHJlYWRvbmx5IFRbXSxcbiAgZmlsdGVyOiBUd2Vha3NQYWdlRmlsdGVyLFxuICBxdWVyeTogc3RyaW5nLFxuKTogVFtdIHtcbiAgY29uc3Qgbm9ybWFsaXplZFF1ZXJ5ID0gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaChxdWVyeSk7XG4gIHJldHVybiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHtcbiAgICBpZiAoIW1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKGl0ZW0sIGZpbHRlcikpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRRdWVyeSkgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIHR3ZWFrc1BhZ2VTZWFyY2hUZXh0KGl0ZW0pLmluY2x1ZGVzKG5vcm1hbGl6ZWRRdWVyeSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoXG4gIGl0ZW06IFR3ZWFrc1BhZ2VJdGVtLFxuICBmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKGZpbHRlciA9PT0gXCJlbmFibGVkXCIpIHJldHVybiBpdGVtLmluc3RhbGxlZCAmJiBpdGVtLmVuYWJsZWQ7XG4gIGlmIChmaWx0ZXIgPT09IFwiZGlzYWJsZWRcIikgcmV0dXJuIGl0ZW0uaW5zdGFsbGVkICYmICFpdGVtLmVuYWJsZWQ7XG4gIGlmIChmaWx0ZXIgPT09IFwidXBkYXRlc1wiKSByZXR1cm4gaXRlbS51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSA9PT0gdHJ1ZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0d2Vha3NQYWdlU2VhcmNoVGV4dChpdGVtOiBUd2Vha3NQYWdlSXRlbSk6IHN0cmluZyB7XG4gIGNvbnN0IGF1dGhvciA9IHR5cGVvZiBpdGVtLm1hbmlmZXN0LmF1dGhvciA9PT0gXCJzdHJpbmdcIlxuICAgID8gaXRlbS5tYW5pZmVzdC5hdXRob3JcbiAgICA6IGl0ZW0ubWFuaWZlc3QuYXV0aG9yPy5uYW1lO1xuICByZXR1cm4gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaChbXG4gICAgaXRlbS5tYW5pZmVzdC5uYW1lLFxuICAgIGl0ZW0ubWFuaWZlc3QuZGVzY3JpcHRpb24sXG4gICAgYXV0aG9yLFxuICAgIGl0ZW0ubWFuaWZlc3QuZ2l0aHViUmVwbyxcbiAgICBpdGVtLm1hbmlmZXN0LmhvbWVwYWdlLFxuICAgIGl0ZW0ubWFuaWZlc3QudmVyc2lvbixcbiAgICAuLi4oaXRlbS5tYW5pZmVzdC50YWdzID8/IFtdKSxcbiAgICBpdGVtLnN0YXR1cyxcbiAgICBpdGVtLmVuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIixcbiAgICBpdGVtLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlID8gXCJ1cGRhdGUgYXZhaWxhYmxlXCIgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVR3ZWFrc1BhZ2VTZWFyY2godmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZVxuICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MjAxOFxcdTIwMTlgXFx1MDBiNF0vZywgXCInXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cbiIsICIvKipcbiAqIEFwcC1tb2RlIHN3aXRjaGluZzogQ2hhdEdQVCBcdTIxQzQgVHdlYWtlcnMgYnVuZGxlIHN3YXAsIHJlbmRlcmVyLXRyaWdnZXJlZC5cbiAqXG4gKiBgL0FwcGxpY2F0aW9ucy9DaGF0R1BULmFwcGAgYWx0ZXJuYXRlcyBiZXR3ZWVuIHR3byBwYXlsb2FkczogdGhlIHByaXN0aW5lXG4gKiBPcGVuQUkgRGV2ZWxvcGVyLUlEIGJ1bmRsZSAoXCJjaGF0Z3B0XCIgbW9kZSkgYW5kIHRoZSBwYXRjaGVkLFxuICogY29udGFpbmVkLXNpZ25lZCBidW5kbGUgKFwidHdlYWtlcnNcIiBtb2RlKS4gVGhlIHN3aXRjaCBpdHNlbGYgXHUyMDE0IHF1aXR0aW5nIHRoZVxuICogYXBwLCBzd2FwcGluZyBidW5kbGVzLCByZWxhdW5jaGluZyBcdTIwMTQgaXMgb3duZWQgZW50aXJlbHkgYnkgdGhlIGluc3RhbGxlciBDTElcbiAqIChgdHdlYWtlcnMgbW9kZSA8dGFyZ2V0PiAtLXllc2ApLiBUaGUgcnVudGltZSdzIG9ubHkgam9iIGlzIHRvIHZhbGlkYXRlIHRoZVxuICogcmVuZGVyZXIncyByZXF1ZXN0IGFuZCBoYW5kIG9mZiB0byB0aGF0IENMSS5cbiAqXG4gKiBUd28gaW52YXJpYW50cyBjYWxsZXJzIG11c3QgdXBob2xkOlxuICogLSBUaGUgcmVuZGVyZXIgc2hvd3MgaXRzIG93biBjb25maXJtYXRpb24gQkVGT1JFIGludm9raW5nIHRoaXM7IG5vdGhpbmcgb25cbiAqICAgdGhpcyBwYXRoIHByb21wdHMgdGhlIHVzZXIuXG4gKiAtIFRoZSBDTEkgbXVzdCBiZSBzdGFydGVkIHRocm91Z2ggdGhlIGxhdW5jaGQtc3VibWl0IHNlYW1cbiAqICAgKGBzdGFydEluc3RhbGxlZENsaVdpdGhMYXVuY2hkYCBpbiBtYWluLnRzKSwgbmV2ZXIgYSBwbGFpbiBjaGlsZCBzcGF3bjpcbiAqICAgdGhlIGhlbHBlciBoYXMgdG8gc3Vydml2ZSB0aGlzIGFwcCBxdWl0dGluZyBhbmQgdGhlIGxpdmUgYnVuZGxlIGJlaW5nXG4gKiAgIHN3YXBwZWQgb3V0IGZyb20gdW5kZXIgaXQgbWlkLWZsaWdodC5cbiAqL1xuXG5leHBvcnQgdHlwZSBBcHBNb2RlVGFyZ2V0ID0gXCJjaGF0Z3B0XCIgfCBcInR3ZWFrZXJzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3dpdGNoQXBwTW9kZVJlc3VsdCB7XG4gIG9rOiBib29sZWFuO1xuICBtZXNzYWdlPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFN3aXRjaEFwcE1vZGVEZXBzIHtcbiAgLyoqXG4gICAqIE1vZGUgb2YgdGhlIGxpdmUgYnVuZGxlIGhvc3RpbmcgdGhpcyBydW50aW1lLiBJbiBwcmFjdGljZSBhbHdheXNcbiAgICogXCJ0d2Vha2Vyc1wiIFx1MjAxNCB0aGUgaW5qZWN0ZWQgcnVudGltZSBkb2VzIG5vdCBleGlzdCBpbnNpZGUgdGhlIHByaXN0aW5lXG4gICAqIGJ1bmRsZSBcdTIwMTQgYnV0IHRoZSBzZWFtIGtlZXBzIHRoZSB0YXJnZXQgdmFsaWRhdGlvbiBob25lc3QgYW5kIHRlc3RhYmxlLlxuICAgKi9cbiAgY3VycmVudE1vZGU6IEFwcE1vZGVUYXJnZXQ7XG4gIC8qKiBJbnN0YWxsZXIgQ0xJIHBhdGggKHNhbWUgcmVzb2x1dGlvbiBhcyBgY29kZXhwcDpzdGFydC1sb2NhbC1yZWZyZXNoYCkuICovXG4gIHJlc29sdmVDbGk6ICgpID0+IHN0cmluZztcbiAgY2xpRXhpc3RzOiAoY2xpOiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIC8qKlxuICAgKiBsYXVuY2hkLXN1Ym1pdCBzZWFtIChgc3RhcnRJbnN0YWxsZWRDbGlXaXRoTGF1bmNoZGApLiBSZXR1cm5zIGZhbHNlIHdoZW5cbiAgICogdGhlIGxhdW5jaGQgc3VibWlzc2lvbiBmYWlscy5cbiAgICovXG4gIHN0YXJ0Q2xpV2l0aExhdW5jaGQ6IChjbGk6IHN0cmluZywgYXJnczogc3RyaW5nW10pID0+IGJvb2xlYW47XG59XG5cbi8qKiBTdHJpY3QgcGF5bG9hZCBzaGFwZTogZXhhY3RseSBgeyB0YXJnZXQ6IFwiY2hhdGdwdFwiIHwgXCJ0d2Vha2Vyc1wiIH1gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3dpdGNoQXBwTW9kZVBheWxvYWQocGF5bG9hZDogdW5rbm93bik6IEFwcE1vZGVUYXJnZXQgfCBudWxsIHtcbiAgaWYgKCFwYXlsb2FkIHx8IHR5cGVvZiBwYXlsb2FkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGF5bG9hZCkpIHJldHVybiBudWxsO1xuICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMocGF5bG9hZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIGlmIChrZXlzLmxlbmd0aCAhPT0gMSB8fCBrZXlzWzBdICE9PSBcInRhcmdldFwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgdGFyZ2V0ID0gKHBheWxvYWQgYXMgeyB0YXJnZXQ6IHVua25vd24gfSkudGFyZ2V0O1xuICByZXR1cm4gdGFyZ2V0ID09PSBcImNoYXRncHRcIiB8fCB0YXJnZXQgPT09IFwidHdlYWtlcnNcIiA/IHRhcmdldCA6IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBhcHBNb2RlTGFiZWwobW9kZTogQXBwTW9kZVRhcmdldCk6IHN0cmluZyB7XG4gIHJldHVybiBtb2RlID09PSBcImNoYXRncHRcIiA/IFwiQ2hhdEdQVCBBcHBcIiA6IFwiVHdlYWtlcnNcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN3aXRjaEFwcE1vZGUocGF5bG9hZDogdW5rbm93biwgZGVwczogU3dpdGNoQXBwTW9kZURlcHMpOiBTd2l0Y2hBcHBNb2RlUmVzdWx0IHtcbiAgY29uc3QgdGFyZ2V0ID0gcGFyc2VTd2l0Y2hBcHBNb2RlUGF5bG9hZChwYXlsb2FkKTtcbiAgaWYgKCF0YXJnZXQpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIG1lc3NhZ2U6ICdJbnZhbGlkIGFwcCBtb2RlIHJlcXVlc3Q7IGV4cGVjdGVkIHsgdGFyZ2V0OiBcImNoYXRncHRcIiB8IFwidHdlYWtlcnNcIiB9LicgfTtcbiAgfVxuICBpZiAodGFyZ2V0ID09PSBkZXBzLmN1cnJlbnRNb2RlKSB7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBtZXNzYWdlOiBgVGhlIGFwcCBpcyBhbHJlYWR5IGluICR7YXBwTW9kZUxhYmVsKHRhcmdldCl9IG1vZGUuYCB9O1xuICB9XG4gIGNvbnN0IGNsaSA9IGRlcHMucmVzb2x2ZUNsaSgpO1xuICBpZiAoIWRlcHMuY2xpRXhpc3RzKGNsaSkpIHtcbiAgICByZXR1cm4geyBvazogZmFsc2UsIG1lc3NhZ2U6IFwiVHdlYWtlcnMgaW5zdGFsbGVyIENMSSBpcyB1bmF2YWlsYWJsZS4gUnVuIHRoZSBpbnN0YWxsZXIgb25jZSwgdGhlbiB0cnkgYWdhaW4uXCIgfTtcbiAgfVxuICBpZiAoIWRlcHMuc3RhcnRDbGlXaXRoTGF1bmNoZChjbGksIFtcIm1vZGVcIiwgdGFyZ2V0LCBcIi0teWVzXCJdKSkge1xuICAgIHJldHVybiB7IG9rOiBmYWxzZSwgbWVzc2FnZTogXCJDb3VsZCBub3Qgc3RhcnQgdGhlIG1vZGUtc3dpdGNoIGhlbHBlci4gQ2hlY2sgdGhlIFR3ZWFrZXJzIGxvZyBmb3IgZGV0YWlscy5cIiB9O1xuICB9XG4gIHJldHVybiB7IG9rOiB0cnVlLCBtZXNzYWdlOiBgU3dpdGNoaW5nIHRvICR7YXBwTW9kZUxhYmVsKHRhcmdldCl9OyB0aGUgYXBwIHdpbGwgcXVpdCBhbmQgcmVsYXVuY2guYCB9O1xufVxuIiwgIi8qKlxuICogUmVuZGVyZXItc2lkZSB0d2VhayBob3N0LiBXZTpcbiAqICAgMS4gQXNrIG1haW4gZm9yIHRoZSB0d2VhayBsaXN0ICh3aXRoIHJlc29sdmVkIGVudHJ5IHBhdGgpLlxuICogICAyLiBGb3IgZWFjaCByZW5kZXJlci1zY29wZWQgKG9yIFwiYm90aFwiKSB0d2VhaywgZmV0Y2ggaXRzIHNvdXJjZSB2aWEgSVBDXG4gKiAgICAgIGFuZCBleGVjdXRlIGl0IGFzIGEgQ29tbW9uSlMtc2hhcGVkIGZ1bmN0aW9uLlxuICogICAzLiBQcm92aWRlIGl0IHRoZSByZW5kZXJlciBoYWxmIG9mIHRoZSBBUEkuXG4gKlxuICogQ29kZXggcnVucyB0aGUgcmVuZGVyZXIgd2l0aCBzYW5kYm94OiB0cnVlLCBzbyBOb2RlJ3MgYHJlcXVpcmUoKWAgaXNcbiAqIHJlc3RyaWN0ZWQgdG8gYSB0aW55IHdoaXRlbGlzdCAoZWxlY3Ryb24gKyBhIGZldyBwb2x5ZmlsbHMpLiBUaGF0IG1lYW5zIHdlXG4gKiBjYW5ub3QgYHJlcXVpcmUoKWAgYXJiaXRyYXJ5IHR3ZWFrIGZpbGVzIGZyb20gZGlzay4gSW5zdGVhZCB3ZSBwdWxsIHRoZVxuICogc291cmNlIHN0cmluZyBmcm9tIG1haW4gYW5kIGV2YWx1YXRlIGl0IHdpdGggYG5ldyBGdW5jdGlvbmAgaW5zaWRlIHRoZVxuICogcHJlbG9hZCBjb250ZXh0LiBUd2VhayBhdXRob3JzIHdobyBuZWVkIG5wbSBkZXBzIG11c3QgYnVuZGxlIHRoZW0gaW4uXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiwgcmVnaXN0ZXJQYWdlLCBjbGVhclNlY3Rpb25zLCBzZXRMaXN0ZWRUd2Vha3MsIHVwZGF0ZUxpc3RlZFR3ZWFrTGlmZWN5Y2xlIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcbmltcG9ydCB7IGZpYmVyRm9yTm9kZSB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB7IGhvc3RVaUFwaSB9IGZyb20gXCIuL2hvc3Qtc3VyZmFjZXNcIjtcbmltcG9ydCB7IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLCBydW5XaXRoU3RhcnR1cFRpbWVvdXQgfSBmcm9tIFwiLi4vdHdlYWstbGlmZWN5Y2xlXCI7XG5pbXBvcnQgdHlwZSB7IFR3ZWFrSGVhbHRoUmVjb3JkLCBUd2Vha1N0YXR1cywgVHdlYWtTdG9yZUVudHJ5IH0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENvZGV4Q2RwU3RhdHVzLFxuICBDb2RleENkcFRhcmdldCxcbiAgQ29kZXhSdW50aW1lQ2FwYWJpbGl0aWVzLFxuICBDb2RleFJ1bnRpbWVJbmZvLFxuICBDb2RleFZpZXdSZWYsXG4gIENvZGV4V2luZG93UmVmLFxuICBOYXRpdmVIZWxwZXJMYXVuY2hPcHRpb25zLFxuICBOYXRpdmVIZWxwZXJSZWYsXG4gIE5hdGl2ZU1vZHVsZUtpbmQsXG4gIE5hdGl2ZU1vZHVsZUxvYWRPcHRpb25zLFxuICBOYXRpdmVNb2R1bGVSZWYsXG4gIE5hdGl2ZVBhbmVsQ3JlYXRlT3B0aW9ucyxcbiAgTmF0aXZlUGFuZWxSZWYsXG4gIE5hdGl2ZVZpZXdBdHRhY2hPcHRpb25zLFxuICBOYXRpdmVWaWV3UmVmLFxuICBUd2Vha01hbmlmZXN0LFxuICBUd2Vha0FwaSxcbiAgUmVhY3RGaWJlck5vZGUsXG4gIFR3ZWFrLFxufSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgaGVhbHRoOiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG4gIGNhdGFsb2c6IFR3ZWFrU3RvcmVFbnRyeSB8IG51bGw7XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRWxlY3Ryb25CcmlkZ2Uge1xuICBnZXRCdWlsZEZsYXZvcj86ICgpID0+IHN0cmluZyB8IG51bGw7XG4gIHVzZXNPd2xBcHBTaGVsbD86ICgpID0+IGJvb2xlYW47XG59XG5cbmNvbnN0IGxvYWRlZCA9IG5ldyBNYXA8c3RyaW5nLCB7IHN0b3A/OiAoKSA9PiB2b2lkIH0+KCk7XG5sZXQgY2FjaGVkUGF0aHM6IFVzZXJQYXRocyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRUd2Vha0hvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBMaXN0ZWRUd2Vha1tdO1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIFVzZXJQYXRocztcbiAgY2FjaGVkUGF0aHMgPSBwYXRocztcbiAgLy8gUHVzaCB0aGUgbGlzdCB0byB0aGUgc2V0dGluZ3MgaW5qZWN0b3Igc28gdGhlIFR3ZWFrcyBwYWdlIGNhbiByZW5kZXJcbiAgLy8gY2FyZHMgZXZlbiBiZWZvcmUgYW55IHR3ZWFrJ3Mgc3RhcnQoKSBydW5zIChhbmQgZm9yIGRpc2FibGVkIHR3ZWFrc1xuICAvLyB0aGF0IHdlIG5ldmVyIGxvYWQpLlxuICBzZXRMaXN0ZWRUd2Vha3ModHdlYWtzKTtcbiAgLy8gU3Rhc2ggZm9yIHRoZSBzZXR0aW5ncyBpbmplY3RvcidzIGVtcHR5LXN0YXRlIG1lc3NhZ2UuXG4gICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fY29kZXhwcF90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX19jb2RleHBwX3R3ZWFrc19kaXJfXyA9XG4gICAgcGF0aHMudHdlYWtzRGlyO1xuXG4gIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICBpZiAodC5tYW5pZmVzdC5zY29wZSA9PT0gXCJtYWluXCIpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJkaXNhYmxlZFwiLCBcIm1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghdC5lbnRyeUV4aXN0cykge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImRpc2FibGVkXCIsIFwibWlzc2luZyBlbnRyeVwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXQuZW5hYmxlZCkge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCB0LnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiIDogXCJkaXNhYmxlZFwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwic3RhcnRpbmdcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bldpdGhTdGFydHVwVGltZW91dChcbiAgICAgICAgKCkgPT4gbG9hZFR3ZWFrKHQsIHBhdGhzKSxcbiAgICAgICAgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4gICAgICApO1xuICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwidGltZWRfb3V0XCIpIHtcbiAgICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInRpbWVkX291dFwiLCBgc3RhcnR1cCBleGNlZWRlZCAke0RFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TfW1zYCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbY29kZXgtcGx1cy1wbHVzXSB0d2VhayBzdGFydHVwIHRpbWVkIG91dDpcIiwgdC5tYW5pZmVzdC5pZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwicmVhZHlcIik7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImZhaWxlZFwiLCBlKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbY29kZXgtcGx1cy1wbHVzXSB0d2VhayBsb2FkIGZhaWxlZDpcIiwgdC5tYW5pZmVzdC5pZCwgZSk7XG4gICAgICB0cnkge1xuICAgICAgICBpcGNSZW5kZXJlci5zZW5kKFxuICAgICAgICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICBcInR3ZWFrIGxvYWQgZmFpbGVkOiBcIiArIHQubWFuaWZlc3QuaWQgKyBcIjogXCIgKyBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSxcbiAgICAgICAgKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICB9XG4gIH1cblxuICBjb25zb2xlLmluZm8oXG4gICAgYFtjb2RleC1wbHVzcGx1c10gcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6YCxcbiAgICBbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCIsXG4gICk7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJjb2RleHBwOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOiAke1suLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIn1gLFxuICApO1xufVxuXG5mdW5jdGlvbiBzZW5kTGlmZWN5Y2xlKFxuICBpZDogc3RyaW5nLFxuICBzdGF0dXM6IFwic3RhcnRpbmdcIiB8IFwicmVhZHlcIiB8IFwiZmFpbGVkXCIgfCBcInRpbWVkX291dFwiIHwgXCJkaXNhYmxlZFwiIHwgXCJxdWFyYW50aW5lZFwiLFxuICBlcnJvcj86IHVua25vd24sXG4pOiB2b2lkIHtcbiAgY29uc3QgcmVuZGVyZXJMaWZlY3ljbGUgPSBzdGF0dXMgPT09IFwiZGlzYWJsZWRcIiAmJiBlcnJvciA9PT0gXCJtaXNzaW5nIGVudHJ5XCIgPyBcImZhaWxlZFwiXG4gICAgOiBzdGF0dXMgPT09IFwic3RhcnRpbmdcIiA/IFwic3RhcnRpbmdcIlxuICAgIDogc3RhdHVzID09PSBcImZhaWxlZFwiID8gXCJmYWlsZWRcIlxuICAgIDogc3RhdHVzID09PSBcInRpbWVkX291dFwiID8gXCJ0aW1lZF9vdXRcIlxuICAgIDogc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcInF1YXJhbnRpbmVkXCJcbiAgICA6IFwiZW5hYmxlZFwiO1xuICB1cGRhdGVMaXN0ZWRUd2Vha0xpZmVjeWNsZShpZCwgcmVuZGVyZXJMaWZlY3ljbGUsIGVycm9yID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuICB0cnkge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoXCJjb2RleHBwOnR3ZWFrLWxpZmVjeWNsZVwiLCB7XG4gICAgICBpZCxcbiAgICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICAgIHN0YXR1cyxcbiAgICAgIC4uLihlcnJvciA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikgfSksXG4gICAgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIExpZmVjeWNsZSB0ZWxlbWV0cnkgbXVzdCBuZXZlciB0YWtlIGRvd24gdGhlIHJlbmRlcmVyIGhvc3QuXG4gIH1cbn1cblxuLyoqXG4gKiBTdG9wIGV2ZXJ5IHJlbmRlcmVyLXNjb3BlIHR3ZWFrIHNvIGEgc3Vic2VxdWVudCBgc3RhcnRUd2Vha0hvc3QoKWAgd2lsbFxuICogcmUtZXZhbHVhdGUgZnJlc2ggc291cmNlLiBNb2R1bGUgY2FjaGUgaXNuJ3QgcmVsZXZhbnQgc2luY2Ugd2UgZXZhbFxuICogc291cmNlIHN0cmluZ3MgZGlyZWN0bHkgXHUyMDE0IGVhY2ggbG9hZCBjcmVhdGVzIGEgZnJlc2ggc2NvcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0ZWFyZG93blR3ZWFrSG9zdCgpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbaWQsIHRdIG9mIGxvYWRlZCkge1xuICAgIHRyeSB7XG4gICAgICB0LnN0b3A/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIltjb2RleC1wbHVzcGx1c10gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXZpZXctZGlzcG9zZS10d2Vha1wiLCBpZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1kaXNwb3NlLXR3ZWFrXCIsIGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfVxuICB9XG4gIGxvYWRlZC5jbGVhcigpO1xuICBjbGVhclNlY3Rpb25zKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRUd2Vhayh0OiBMaXN0ZWRUd2VhaywgcGF0aHM6IFVzZXJQYXRocyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzb3VyY2UgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgIFwiY29kZXhwcDpyZWFkLXR3ZWFrLXNvdXJjZVwiLFxuICAgIHQuZW50cnksXG4gICkpIGFzIHN0cmluZztcblxuICAvLyBFdmFsdWF0ZSBhcyBDSlMtc2hhcGVkOiBwcm92aWRlIG1vZHVsZS9leHBvcnRzL2FwaS4gVHdlYWsgY29kZSBtYXkgdXNlXG4gIC8vIGBtb2R1bGUuZXhwb3J0cyA9IHsgc3RhcnQsIHN0b3AgfWAgb3IgYGV4cG9ydHMuc3RhcnQgPSAuLi5gIG9yIHB1cmUgRVNNXG4gIC8vIGRlZmF1bHQgZXhwb3J0IHNoYXBlICh3ZSBhY2NlcHQgYm90aCkuXG4gIGNvbnN0IG1vZHVsZSA9IHsgZXhwb3J0czoge30gYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrIH07XG4gIGNvbnN0IGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cztcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1pbXBsaWVkLWV2YWwsIG5vLW5ldy1mdW5jXG4gIGNvbnN0IGZuID0gbmV3IEZ1bmN0aW9uKFxuICAgIFwibW9kdWxlXCIsXG4gICAgXCJleHBvcnRzXCIsXG4gICAgXCJjb25zb2xlXCIsXG4gICAgYCR7c291cmNlfVxcbi8vIyBzb3VyY2VVUkw9Y29kZXhwcC10d2VhazovLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQubWFuaWZlc3QuaWQpfS8ke2VuY29kZVVSSUNvbXBvbmVudCh0LmVudHJ5KX1gLFxuICApO1xuICBmbihtb2R1bGUsIGV4cG9ydHMsIGNvbnNvbGUpO1xuICBjb25zdCBtb2QgPSBtb2R1bGUuZXhwb3J0cyBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWs7XG4gIGNvbnN0IHR3ZWFrOiBUd2VhayA9IChtb2QgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSkuZGVmYXVsdCA/PyAobW9kIGFzIFR3ZWFrKTtcbiAgaWYgKHR5cGVvZiB0d2Vhaz8uc3RhcnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHdlYWsgJHt0Lm1hbmlmZXN0LmlkfSBoYXMgbm8gc3RhcnQoKWApO1xuICB9XG4gIGNvbnN0IGFwaSA9IG1ha2VSZW5kZXJlckFwaSh0Lm1hbmlmZXN0LCBwYXRocyk7XG4gIGF3YWl0IHR3ZWFrLnN0YXJ0KGFwaSk7XG4gIGxvYWRlZC5zZXQodC5tYW5pZmVzdC5pZCwgeyBzdG9wOiB0d2Vhay5zdG9wPy5iaW5kKHR3ZWFrKSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlbmRlcmVyQXBpKG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LCBwYXRoczogVXNlclBhdGhzKTogVHdlYWtBcGkge1xuICBjb25zdCBpZCA9IG1hbmlmZXN0LmlkO1xuICBjb25zdCBsb2cgPSAobGV2ZWw6IFwiZGVidWdcIiB8IFwiaW5mb1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIC4uLmE6IHVua25vd25bXSkgPT4ge1xuICAgIGNvbnN0IGNvbnNvbGVGbiA9XG4gICAgICBsZXZlbCA9PT0gXCJkZWJ1Z1wiID8gY29uc29sZS5kZWJ1Z1xuICAgICAgOiBsZXZlbCA9PT0gXCJ3YXJuXCIgPyBjb25zb2xlLndhcm5cbiAgICAgIDogbGV2ZWwgPT09IFwiZXJyb3JcIiA/IGNvbnNvbGUuZXJyb3JcbiAgICAgIDogY29uc29sZS5sb2c7XG4gICAgY29uc29sZUZuKGBbY29kZXgtcGx1c3BsdXNdWyR7aWR9XWAsIC4uLmEpO1xuICAgIC8vIEFsc28gbWlycm9yIHRvIG1haW4ncyBsb2cgZmlsZSBzbyB3ZSBjYW4gZGlhZ25vc2UgdHdlYWsgYmVoYXZpb3JcbiAgICAvLyB3aXRob3V0IGF0dGFjaGluZyBEZXZUb29scy4gU3RyaW5naWZ5IGVhY2ggYXJnIGRlZmVuc2l2ZWx5LlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGEubWFwKCh2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHY7XG4gICAgICAgIGlmICh2IGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBgJHt2Lm5hbWV9OiAke3YubWVzc2FnZX1gO1xuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKHYpOyB9XG4gICAgICB9KTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgIFwiY29kZXhwcDpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICBsZXZlbCxcbiAgICAgICAgYFt0d2VhayAke2lkfV0gJHtwYXJ0cy5qb2luKFwiIFwiKX1gLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHN3YWxsb3cgXHUyMDE0IG5ldmVyIGxldCBsb2dnaW5nIGJyZWFrIGEgdHdlYWsgKi9cbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBtYW5pZmVzdCxcbiAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgbG9nOiB7XG4gICAgICBkZWJ1ZzogKC4uLmEpID0+IGxvZyhcImRlYnVnXCIsIC4uLmEpLFxuICAgICAgaW5mbzogKC4uLmEpID0+IGxvZyhcImluZm9cIiwgLi4uYSksXG4gICAgICB3YXJuOiAoLi4uYSkgPT4gbG9nKFwid2FyblwiLCAuLi5hKSxcbiAgICAgIGVycm9yOiAoLi4uYSkgPT4gbG9nKFwiZXJyb3JcIiwgLi4uYSksXG4gICAgfSxcbiAgICBzdG9yYWdlOiByZW5kZXJlclN0b3JhZ2UoaWQpLFxuICAgIHNldHRpbmdzOiB7XG4gICAgICByZWdpc3RlcjogKHMpID0+IHJlZ2lzdGVyU2VjdGlvbih7IC4uLnMsIGlkOiBgJHtpZH06JHtzLmlkfWAgfSksXG4gICAgICByZWdpc3RlclBhZ2U6IChwKSA9PlxuICAgICAgICByZWdpc3RlclBhZ2UoaWQsIG1hbmlmZXN0LCB7IC4uLnAsIGlkOiBgJHtpZH06JHtwLmlkfWAgfSksXG4gICAgfSxcbiAgICByZWFjdDoge1xuICAgICAgZ2V0RmliZXI6IChuKSA9PiBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuICAgICAgZmluZE93bmVyQnlOYW1lOiAobiwgbmFtZSkgPT4ge1xuICAgICAgICBsZXQgZiA9IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gICAgICAgIHdoaWxlIChmKSB7XG4gICAgICAgICAgY29uc3QgdCA9IGYudHlwZSBhcyB7IGRpc3BsYXlOYW1lPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCBudWxsO1xuICAgICAgICAgIGlmICh0ICYmICh0LmRpc3BsYXlOYW1lID09PSBuYW1lIHx8IHQubmFtZSA9PT0gbmFtZSkpIHJldHVybiBmO1xuICAgICAgICAgIGYgPSBmLnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICB3YWl0Rm9yRWxlbWVudDogKHNlbCwgdGltZW91dE1zID0gNTAwMCkgPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgIGlmIChleGlzdGluZykgcmV0dXJuIHJlc29sdmUoZXhpc3RpbmcpO1xuICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXRNcztcbiAgICAgICAgICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICAgIGlmIChlbCkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZXNvbHZlKGVsKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoRGF0ZS5ub3coKSA+IGRlYWRsaW5lKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHRpbWVvdXQgd2FpdGluZyBmb3IgJHtzZWx9YCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgIH0pLFxuICAgICAgaG9zdDogaG9zdFVpQXBpLFxuICAgIH0sXG4gICAgaXBjOiB7XG4gICAgICBvbjogKGMsIGgpID0+IHtcbiAgICAgICAgY29uc3Qgd3JhcHBlZCA9IChfZTogdW5rbm93biwgLi4uYXJnczogdW5rbm93bltdKSA9PiBoKC4uLmFyZ3MpO1xuICAgICAgICBpcGNSZW5kZXJlci5vbihgY29kZXhwcDoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICAgIHJldHVybiAoKSA9PiBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihgY29kZXhwcDoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICB9LFxuICAgICAgc2VuZDogKGMsIC4uLmFyZ3MpID0+IGlwY1JlbmRlcmVyLnNlbmQoYGNvZGV4cHA6JHtpZH06JHtjfWAsIC4uLmFyZ3MpLFxuICAgICAgaW52b2tlOiA8VD4oYzogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgICAgaWYgKGlkID09PSBcImNvLnR3ZWFrZXJzLnRocmVhZC1zdW1tYXJ5LXByb2ZpbGVzXCIgJiYgYyA9PT0gXCJwcm9maWxlcy5yZWFkXCIpIHtcbiAgICAgICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgICAgXCJjb2RleHBwOmNyb3NzLXR3ZWFrLXJlYWRcIixcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgXCJjby50d2Vha2Vycy5wcm9qZWN0c1wiLFxuICAgICAgICAgICAgXCJwcm9maWxlcy5yZWFkXCIsXG4gICAgICAgICAgICBhcmdzWzBdLFxuICAgICAgICAgICkgYXMgUHJvbWlzZTxUPjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaWQgPT09IFwiY28udHdlYWtlcnMuZm9sbG93dXBcIiAmJiBjID09PSBcInBvbGljeVwiKSB7XG4gICAgICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICAgIFwiY29kZXhwcDpjcm9zcy10d2Vhay1yZWFkXCIsXG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIFwiY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgICAgICAgICAgIFwiZm9sbG93dXAucG9saWN5LnJlYWRcIixcbiAgICAgICAgICAgIGFyZ3NbMF0sXG4gICAgICAgICAgKSBhcyBQcm9taXNlPFQ+O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoYGNvZGV4cHA6JHtpZH06JHtjfWAsIC4uLmFyZ3MpIGFzIFByb21pc2U8VD47XG4gICAgICB9LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgICBjb2RleDogcmVuZGVyZXJDb2RleEFwaShpZCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyQ29kZXhBcGkodHdlYWtJZDogc3RyaW5nKTogTm9uTnVsbGFibGU8VHdlYWtBcGlbXCJjb2RleFwiXT4ge1xuICByZXR1cm4ge1xuICAgIHJ1bnRpbWU6IHtcbiAgICAgIGdldEluZm86IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29kZXgtcnVudGltZS1pbmZvXCIpIGFzIENvZGV4UnVudGltZUluZm87XG4gICAgICAgIGNvbnN0IGJyaWRnZSA9IHJlbmRlcmVyRWxlY3Ryb25CcmlkZ2UoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5pbmZvLFxuICAgICAgICAgIGJ1aWxkRmxhdm9yOiBicmlkZ2U/LmdldEJ1aWxkRmxhdm9yPy4oKSA/PyBpbmZvLmJ1aWxkRmxhdm9yLFxuICAgICAgICAgIHVzZXNPd2xBcHBTaGVsbDogYnJpZGdlPy51c2VzT3dsQXBwU2hlbGw/LigpID8/IGluZm8udXNlc093bEFwcFNoZWxsLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIGdldENhcGFiaWxpdGllczogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb2RleC1ydW50aW1lLWNhcGFiaWxpdGllc1wiKSBhcyBQcm9taXNlPENvZGV4UnVudGltZUNhcGFiaWxpdGllcz4sXG4gICAgfSxcbiAgICB3aW5kb3dzOiB7XG4gICAgICBjcmVhdGU6IChvcHRpb25zKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXdpbmRvdy1jcmVhdGVcIiwgb3B0aW9ucykgYXMgUHJvbWlzZTxDb2RleFdpbmRvd1JlZj4sXG4gICAgICBnZXRQcmltYXJ5OiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXdpbmRvdy1wcmltYXJ5XCIpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWYgfCBudWxsPixcbiAgICAgIGZvY3VzOiAod2luZG93SWQpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29kZXgtd2luZG93LWZvY3VzXCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgICAgc2hvdzogKHdpbmRvd0lkKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXdpbmRvdy1zaG93XCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgIH0sXG4gICAgdmlld3M6IHtcbiAgICAgIGNyZWF0ZTogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwiY29kZXhwcDpjb2RleC12aWV3LWNyZWF0ZVwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdlYkNvbnRlbnRzSWQ6IG51bWJlcjsgcGFyZW50V2luZG93SWQ6IG51bWJlciB8IG51bGwgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyQ29kZXhWaWV3UmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndlYkNvbnRlbnRzSWQsIHJlZi5wYXJlbnRXaW5kb3dJZCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY2RwOiB7XG4gICAgICBnZXRTdGF0dXM6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29kZXgtY2RwLXN0YXR1c1wiKSBhcyBQcm9taXNlPENvZGV4Q2RwU3RhdHVzPixcbiAgICAgIGxpc3RUYXJnZXRzOiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LWNkcC10YXJnZXRzXCIpIGFzIFByb21pc2U8Q29kZXhDZHBUYXJnZXRbXT4sXG4gICAgfSxcbiAgICBuYXRpdmU6IHtcbiAgICAgIGxvYWRNb2R1bGU6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcImNvZGV4cHA6bmF0aXZlLWxvYWQtbW9kdWxlXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsga2luZDogTmF0aXZlTW9kdWxlS2luZCB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVNb2R1bGVSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYua2luZCk7XG4gICAgICB9LFxuICAgICAgY3JlYXRlUGFuZWw6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcImNvZGV4cHA6bmF0aXZlLWNyZWF0ZS1wYW5lbFwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdpbmRvd0lkOiBudW1iZXIgfCBudWxsIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZVBhbmVsUmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndpbmRvd0lkKTtcbiAgICAgIH0sXG4gICAgICBhdHRhY2hWaWV3OiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJjb2RleHBwOm5hdGl2ZS1hdHRhY2gtdmlld1wiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmcgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlVmlld1JlZih0d2Vha0lkLCByZWYuaWQpO1xuICAgICAgfSxcbiAgICAgIGxhdW5jaEhlbHBlcjogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwiY29kZXhwcDpuYXRpdmUtbGF1bmNoLWhlbHBlclwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHBpZDogbnVtYmVyIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkLCByZWYuaWQsIHJlZi5waWQpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHJlZnJlc2g6IHtcbiAgICAgIGdldFN0YXR1czogKCkgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpnZXQtcmVmcmVzaC1zdGF0dXNcIiksXG4gICAgICBzdGFydDogKHNvdXJjZSA9IFwic21hcnRcIikgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpzdGFydC1sb2NhbC1yZWZyZXNoXCIsIHNvdXJjZSksXG4gICAgICBvblN0YXR1c0NoYW5nZWQ6IChsaXN0ZW5lcikgPT4ge1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKCkgPT4geyB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Z2V0LXJlZnJlc2gtc3RhdHVzXCIpLnRoZW4obGlzdGVuZXIpOyB9O1xuICAgICAgICBpcGNSZW5kZXJlci5vbihcImNvZGV4cHA6cmVmcmVzaC1zdGF0dXMtY2hhbmdlZFwiLCBoYW5kbGVyKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwiY29kZXhwcDpyZWZyZXNoLXN0YXR1cy1jaGFuZ2VkXCIsIGhhbmRsZXIpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGNhcHR1cmU6IHtcbiAgICAgIGdldFBlcm1pc3Npb25TdGF0dXM6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICByZXF1ZXN0QWNjZXNzaWJpbGl0eTogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICAgIG9wZW5QZXJtaXNzaW9uU2V0dGluZ3M6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICBjYXB0dXJlRnJvbnRtb3N0V2luZG93OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgaG90a2V5czoge1xuICAgICAgcmVnaXN0ZXJDYXB0dXJlSG90a2V5OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5ob3RrZXlzIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY3JlYXRlQnJvd3NlclZpZXc6IChfb3B0aW9ucykgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNyZWF0ZUJyb3dzZXJWaWV3IGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgfSxcbiAgICBjcmVhdGVXaW5kb3c6IChvcHRpb25zKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb2RleC13aW5kb3ctY3JlYXRlXCIsIG9wdGlvbnMpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWY+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckNvZGV4Vmlld1JlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICB3ZWJDb250ZW50c0lkOiBudW1iZXIsXG4gIHBhcmVudFdpbmRvd0lkOiBudW1iZXIgfCBudWxsLFxuKTogQ29kZXhWaWV3UmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICB3ZWJDb250ZW50c0lkLFxuICAgIHBhcmVudFdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInNldEJvdW5kc1wiLCBib3VuZHMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgc2V0VmlzaWJsZTogKHZpc2libGUpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZXRWaXNpYmxlXCIsIHZpc2libGUpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgYnJpbmdUb0Zyb250OiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiYnJpbmdUb0Zyb250XCIpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgbG9hZFJvdXRlOiAocm91dGUsIGhvc3RJZCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImxvYWRSb3V0ZVwiLCByb3V0ZSwgaG9zdElkKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGxvYWRVcmw6ICh1cmwpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJsb2FkVXJsXCIsIHVybCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZU1vZHVsZVJlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICBraW5kOiBOYXRpdmVNb2R1bGVLaW5kLFxuKTogTmF0aXZlTW9kdWxlUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBraW5kLFxuICAgIHJlcXVlc3Q6IChtZXRob2QsIHBheWxvYWQsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm5hdGl2ZS1tb2R1bGUtcmVxdWVzdFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgbWV0aG9kLFxuICAgICAgICBwYXlsb2FkLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgICApLFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1tb2R1bGUtZGlzcG9zZVwiLCB0d2Vha0lkLCBpZCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVQYW5lbFJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHdpbmRvd0lkOiBudW1iZXIgfCBudWxsKTogTmF0aXZlUGFuZWxSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJzZXRCb3VuZHNcIiwgYm91bmRzKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHNob3c6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwic2hvd1wiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGhpZGU6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiaGlkZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZVZpZXdSZWYodHdlYWtJZDogc3RyaW5nLCBpZDogc3RyaW5nKTogTmF0aXZlVmlld1JlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgc2V0Qm91bmRzOiAoYm91bmRzKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwic2V0Qm91bmRzXCIsIGJvdW5kcykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBzZXRWaXNpYmxlOiAodmlzaWJsZSkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJ2aWV3XCIsIGlkLCBcInNldFZpc2libGVcIiwgdmlzaWJsZSkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHBpZDogbnVtYmVyKTogTmF0aXZlSGVscGVyUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBwaWQsXG4gICAgc2VuZDogKG1lc3NhZ2UpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOm5hdGl2ZS1oZWxwZXItY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZW5kXCIsIG1lc3NhZ2UpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgcmVxdWVzdDogKG1lc3NhZ2UsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJjb2RleHBwOm5hdGl2ZS1oZWxwZXItY2FsbFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgXCJyZXF1ZXN0XCIsXG4gICAgICAgIG1lc3NhZ2UsXG4gICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICksXG4gICAgc3RvcDogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6bmF0aXZlLWhlbHBlci1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInN0b3BcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJFbGVjdHJvbkJyaWRnZSgpOiBFbGVjdHJvbkJyaWRnZSB8IG51bGwge1xuICBjb25zdCB2YWx1ZSA9ICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IGVsZWN0cm9uQnJpZGdlPzogdW5rbm93biB9KS5lbGVjdHJvbkJyaWRnZTtcbiAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIEVsZWN0cm9uQnJpZGdlIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcpIHtcbiAgY29uc3Qga2V5ID0gYGNvZGV4cHA6c3RvcmFnZToke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gSlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShrZXkpID8/IFwie31cIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT5cbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHYpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihrOiBzdHJpbmcsIGQ/OiBUKSA9PiAoayBpbiByZWFkKCkgPyAocmVhZCgpW2tdIGFzIFQpIDogKGQgYXMgVCkpLFxuICAgIHNldDogKGs6IHN0cmluZywgdjogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgbyA9IHJlYWQoKTtcbiAgICAgIG9ba10gPSB2O1xuICAgICAgd3JpdGUobyk7XG4gICAgfSxcbiAgICBkZWxldGU6IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG8gPSByZWFkKCk7XG4gICAgICBkZWxldGUgb1trXTtcbiAgICAgIHdyaXRlKG8pO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcImNvZGV4cHA6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG4iLCAiaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHR5cGUge1xuICBIb3N0UHJvamVjdENvbnRleHQsXG4gIEhvc3RTdXJmYWNlS2luZCxcbiAgSG9zdFN1cmZhY2VNYXRjaCxcbiAgSG9zdFN1cmZhY2VTbmFwc2hvdCxcbiAgSG9zdFVpQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuXG5jb25zdCBNQVhfTUFUQ0hFUyA9IDEwMDtcbmNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8eyBraW5kczogSG9zdFN1cmZhY2VLaW5kW107IGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQgfT4oKTtcbmxldCBzaGFyZWRPYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGwgPSBudWxsO1xubGV0IHBlbmRpbmdGcmFtZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IFNFTEVDVE9SUzogUmVjb3JkPEV4Y2x1ZGU8SG9zdFN1cmZhY2VLaW5kLCBcInByb2plY3RzXCIgfCBcInRocmVhZC1jb250ZXh0XCIgfCBcInVzYWdlXCI+LCBzdHJpbmc+ID0ge1xuICBcImFzc2lzdGFudC10dXJuc1wiOiAnW2RhdGEtdGVzdGlkPVwiY29udmVyc2F0aW9uLXR1cm5cIl0sIFtkYXRhLXRlc3RpZCo9XCJhc3Npc3RhbnQtbWVzc2FnZVwiIGldLCBbZGF0YS1tZXNzYWdlLWF1dGhvci1yb2xlPVwiYXNzaXN0YW50XCJdLCBbZGF0YS1yb2xlPVwiYXNzaXN0YW50XCJdJyxcbiAgY29tcG9zZXI6ICcjcHJvbXB0LXRleHRhcmVhLCBbZGF0YS10ZXN0aWQ9XCJjb21wb3NlclwiXSB0ZXh0YXJlYSwgW2RhdGEtdGVzdGlkPVwiY29tcG9zZXJcIl0gW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIGZvcm0gdGV4dGFyZWE6bm90KFtkaXNhYmxlZF0pLCBmb3JtIFtjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdJyxcbiAgXCJjb21tYW5kLW1lbnVcIjogJ1tkYXRhLWNvbW1hbmQtbWVudV0sIFtkYXRhLXNsYXNoLW1lbnVdLCBbcm9sZT1cImxpc3Rib3hcIl0nLFxuICBcImFjY291bnQtbWVudVwiOiAnW3JvbGU9XCJtZW51XCJdLCBbcm9sZT1cImRpYWxvZ1wiXScsXG4gIFwic2V0dGluZ3Mtcm93c1wiOiAnW2RhdGEtc2V0dGluZ3Mtcm93XSwgW3JvbGU9XCJsaXN0aXRlbVwiXSwgc2VjdGlvbiA+IGRpdicsXG4gIFwidGl0bGViYXItY29udHJvbHNcIjogJ1tkYXRhLXRpdGxlYmFyLWNvbnRyb2xdLCBbYXJpYS1sYWJlbD1cIkhpZGUgc2lkZWJhclwiXSwgW2FyaWEtbGFiZWw9XCJTaG93IHNpZGViYXJcIl0sIFthcmlhLWxhYmVsPVwiQmFja1wiXSwgW2FyaWEtbGFiZWw9XCJGb3J3YXJkXCJdLCBbdGl0bGU9XCJCYWNrXCJdLCBbdGl0bGU9XCJGb3J3YXJkXCJdJyxcbn07XG5cbmV4cG9ydCBjb25zdCBob3N0VWlBcGk6IEhvc3RVaUFwaSA9IHtcbiAgcXVlcnk6IHF1ZXJ5SG9zdFN1cmZhY2VzLFxuICBzbmFwc2hvdCxcbiAgb2JzZXJ2ZSxcbiAgZ2V0QWN0aXZlUHJvamVjdCxcbiAgYXR0YWNoRmlsZXMsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gcXVlcnlIb3N0U3VyZmFjZXMoa2luZDogSG9zdFN1cmZhY2VLaW5kKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgaWYgKHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuIFtdO1xuICBpZiAoa2luZCA9PT0gXCJwcm9qZWN0c1wiKSByZXR1cm4gcHJvamVjdFJvd3MoKTtcbiAgaWYgKGtpbmQgPT09IFwidGhyZWFkLWNvbnRleHRcIikgcmV0dXJuIHRocmVhZENvbnRleHRzKCk7XG4gIGlmIChraW5kID09PSBcInVzYWdlXCIpIHJldHVybiB1c2FnZVN1cmZhY2VzKCk7XG4gIGNvbnN0IHNlbGVjdG9yID0gU0VMRUNUT1JTW2tpbmRdO1xuICByZXR1cm4gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcikpXG4gICAgLmZpbHRlcigoZWxlbWVudCkgPT4gc2VtYW50aWNGaWx0ZXIoa2luZCwgZWxlbWVudCkpXG4gICAgLnNsaWNlKDAsIE1BWF9NQVRDSEVTKVxuICAgIC5tYXAoKGVsZW1lbnQpID0+ICh7IGtpbmQsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGNvbmZpZGVuY2VGb3Ioa2luZCwgZWxlbWVudCksIGxhYmVsOiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudCkgfSkpO1xufVxuXG5mdW5jdGlvbiBzbmFwc2hvdChraW5kOiBIb3N0U3VyZmFjZUtpbmQpOiBIb3N0U3VyZmFjZVNuYXBzaG90IHtcbiAgY29uc3QgbWF0Y2hlcyA9IHF1ZXJ5SG9zdFN1cmZhY2VzKGtpbmQpLnNsaWNlKDAsIE1BWF9NQVRDSEVTKTtcbiAgcmV0dXJuIHsga2luZCwgY291bnQ6IG1hdGNoZXMubGVuZ3RoLCBtYXRjaGVzIH07XG59XG5cbmZ1bmN0aW9uIG9ic2VydmUoa2luZHM6IEhvc3RTdXJmYWNlS2luZFtdLCBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGVudHJ5ID0geyBraW5kczogWy4uLm5ldyBTZXQoa2luZHMpXSwgbGlzdGVuZXIgfTtcbiAgbGlzdGVuZXJzLmFkZChlbnRyeSk7XG4gIGVuc3VyZU9ic2VydmVyKCk7XG4gIHNhZmVseU5vdGlmeShlbnRyeSwgZW50cnkua2luZHMubWFwKHNuYXBzaG90KSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgbGlzdGVuZXJzLmRlbGV0ZShlbnRyeSk7XG4gICAgaWYgKCFsaXN0ZW5lcnMuc2l6ZSkge1xuICAgICAgc2hhcmVkT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICAgIHNoYXJlZE9ic2VydmVyID0gbnVsbDtcbiAgICAgIGlmIChwZW5kaW5nRnJhbWUgIT09IG51bGwpIGNhbmNlbEFuaW1hdGlvbkZyYW1lKHBlbmRpbmdGcmFtZSk7XG4gICAgICBwZW5kaW5nRnJhbWUgPSBudWxsO1xuICAgIH1cbiAgfTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlT2JzZXJ2ZXIoKTogdm9pZCB7XG4gIGlmIChzaGFyZWRPYnNlcnZlciB8fCB0eXBlb2YgTXV0YXRpb25PYnNlcnZlciA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YgZG9jdW1lbnQgPT09IFwidW5kZWZpbmVkXCIpIHJldHVybjtcbiAgc2hhcmVkT2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgaWYgKHBlbmRpbmdGcmFtZSAhPT0gbnVsbCkgcmV0dXJuO1xuICAgIHBlbmRpbmdGcmFtZSA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICBwZW5kaW5nRnJhbWUgPSBudWxsO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBsaXN0ZW5lcnMpIHNhZmVseU5vdGlmeShlbnRyeSwgZW50cnkua2luZHMubWFwKHNuYXBzaG90KSk7XG4gICAgfSk7XG4gIH0pO1xuICBzaGFyZWRPYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwge1xuICAgIGF0dHJpYnV0ZXM6IHRydWUsXG4gICAgYXR0cmlidXRlRmlsdGVyOiBbXCJhcmlhLWxhYmVsXCIsIFwiYXJpYS1jdXJyZW50XCIsIFwicm9sZVwiLCBcImRhdGEtdGVzdGlkXCIsIFwiZGF0YS1wcm9qZWN0LWlkXCIsIFwiZGF0YS1wcm9qZWN0LW5hbWVcIiwgXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIsIFwiZGF0YS11c2FnZS1saW1pdC1rZXlcIiwgXCJkYXRhLXVzYWdlLWxpbWl0XCIsIFwiZGlzYWJsZWRcIl0sXG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIGNoYXJhY3RlckRhdGE6IHRydWUsXG4gICAgc3VidHJlZTogdHJ1ZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNhZmVseU5vdGlmeShlbnRyeTogeyBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkIH0sIHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKTogdm9pZCB7XG4gIHRyeSB7IGVudHJ5Lmxpc3RlbmVyKHNuYXBzaG90cyk7IH1cbiAgY2F0Y2ggKGVycm9yKSB7IGNvbnNvbGUud2FybihcIltjb2RleC1wbHVzcGx1c10gaG9zdCBzdXJmYWNlIG9ic2VydmVyIGZhaWxlZFwiLCBlcnJvcik7IH1cbn1cblxuZnVuY3Rpb24gcHJvamVjdFJvd3MoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgY29udHJvbHMgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24sIGEsIFtyb2xlPVwiYnV0dG9uXCJdJykpO1xuICByZXR1cm4gY29udHJvbHMuZmlsdGVyKChlbGVtZW50KSA9PiB7XG4gICAgY29uc3QgbGFiZWwgPSBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpO1xuICAgIGlmICghbGFiZWwgfHwgbGFiZWwubGVuZ3RoID4gMTIwIHx8ICFlbGVtZW50LnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIikpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gQm9vbGVhbihkaXJlY3RQcm9qZWN0SWRlbnRpdHkoZWxlbWVudCkpO1xuICB9KS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoe1xuICAgIGtpbmQ6IFwicHJvamVjdHNcIixcbiAgICBlbGVtZW50LFxuICAgIGNvbmZpZGVuY2U6IFwiaGlnaFwiLFxuICAgIGxhYmVsOiBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpLFxuICB9KSk7XG59XG5cbi8qKlxuICogQSBwcm9qZWN0IHJvdyBtdXN0IG93biBwcm9qZWN0IGlkZW50aXR5IGl0c2VsZi4gV2Fsa2luZyBhbmNlc3RvciBmaWJlcnMgbWFkZVxuICogZXZlcnkgY29udHJvbCByZW5kZXJlZCBpbnNpZGUgYSBwcm9qZWN0IHJvdXRlIGluaGVyaXQgcHJvamVjdCBjb250ZXh0OiB0YXNrXG4gKiByb3dzIGFuZCBldmVuIHRoZSB0aXRsZWJhciBtb2RlbCBwaWNrZXIgdGhlbiBsb29rZWQgbGlrZSBwcm9qZWN0IHJvd3MuIEtlZXBcbiAqIHRoaXMgc2VhbSBmYWlsLWNsb3NlZCBzbyBjb25zdW1lcnMgbmV2ZXIgZGVjb3JhdGUgdW5yZWxhdGVkIGhvc3QgY29udHJvbHMuXG4gKi9cbmZ1bmN0aW9uIGRpcmVjdFByb2plY3RJZGVudGl0eShlbGVtZW50OiBFbGVtZW50KTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIFtcbiAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtaWRcIixcbiAgICBcImRhdGEtcHJvamVjdC1pZFwiLFxuICAgIFwiZGF0YS1wcm9qZWN0LW5hbWVcIixcbiAgICBcImRhdGEtd29ya3NwYWNlLXBhdGhcIixcbiAgICBcImRhdGEtcHJvamVjdC1wYXRoXCIsXG4gIF0pIHtcbiAgICBjb25zdCB2YWx1ZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKGF0dHJpYnV0ZSk/LnRyaW0oKTtcbiAgICBpZiAodmFsdWUpIHJldHVybiB2YWx1ZTtcbiAgfVxuICBjb25zdCBwcm9wcyA9IChmaWJlckZvck5vZGUoZWxlbWVudCkgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsKT8ubWVtb2l6ZWRQcm9wcztcbiAgcmV0dXJuIHByb3BzICYmIHR5cGVvZiBwcm9wcyA9PT0gXCJvYmplY3RcIlxuICAgID8gZmlyc3RTdHJpbmcocHJvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIFtcInByb2plY3RJZFwiLCBcInByb2plY3ROYW1lXCIsIFwid29ya3NwYWNlUGF0aFwiLCBcInByb2plY3RQYXRoXCJdKSA/PyBudWxsXG4gICAgOiBudWxsO1xufVxuXG5mdW5jdGlvbiB0aHJlYWRDb250ZXh0cygpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBjb25zdCBjYW5kaWRhdGVzID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvamVjdC1pZF0sIFtkYXRhLXdvcmtzcGFjZS1wYXRoXSwgbWFpbiwgW3JvbGU9XCJtYWluXCJdJykpO1xuICByZXR1cm4gY2FuZGlkYXRlcy5maWx0ZXIoKGVsZW1lbnQpID0+IHtcbiAgICBpZiAoZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtaWRcIikgfHwgZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIpKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCBwcm9wcyA9IGZpYmVyUHJvcHMoZWxlbWVudCk7XG4gICAgcmV0dXJuIEJvb2xlYW4oZmlyc3RTdHJpbmcocHJvcHMsIFtcInByb2plY3RJZFwiLCBcIndvcmtzcGFjZVBhdGhcIiwgXCJwcm9qZWN0TmFtZVwiXSkpO1xuICB9KS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoeyBraW5kOiBcInRocmVhZC1jb250ZXh0XCIsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpID8gXCJoaWdoXCIgOiBcIm1lZGl1bVwiLCBsYWJlbDogYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQpIH0pKTtcbn1cblxuZnVuY3Rpb24gdXNhZ2VTdXJmYWNlcygpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBjb25zdCBkaXJlY3QgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS11c2FnZS1saW1pdC1rZXldLCBbZGF0YS11c2FnZS1saW1pdF0sIFtkYXRhLXRlc3RpZCo9XCJ1c2FnZVwiIGldLCBbYXJpYS1sYWJlbCo9XCJ1c2FnZVwiIGldLCBbY2xhc3MqPVwidXNhZ2VcIiBpXScpKTtcbiAgY29uc3QgdGV4dHVhbCA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJzZWN0aW9uLCBhcnRpY2xlLCBbcm9sZT0nbGlzdGl0ZW0nXVwiKSkuZmlsdGVyKChlbGVtZW50KSA9PiAvKD86dXNhZ2V8bGltaXQpLiooPzpyZW1haW5pbmd8cmVzZXR8dXNlZCl8KD86cmVtYWluaW5nfHJlc2V0fHVzZWQpLiooPzp1c2FnZXxsaW1pdCkvaS50ZXN0KGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCkpKTtcbiAgcmV0dXJuIHVuaXF1ZUVsZW1lbnRzKFsuLi5kaXJlY3QsIC4uLnRleHR1YWxdKS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoeyBraW5kOiBcInVzYWdlXCIsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGRpcmVjdC5pbmNsdWRlcyhlbGVtZW50KSA/IFwiaGlnaFwiIDogXCJtZWRpdW1cIiwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIGdldEFjdGl2ZVByb2plY3QoKTogSG9zdFByb2plY3RDb250ZXh0IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgcXVlcnlIb3N0U3VyZmFjZXMoXCJ0aHJlYWQtY29udGV4dFwiKSkge1xuICAgIGNvbnN0IGVsZW1lbnQgPSBtYXRjaC5lbGVtZW50O1xuICAgIGNvbnN0IHByb3BzID0gZmliZXJQcm9wcyhlbGVtZW50KTtcbiAgICBjb25zdCBjb250ZXh0ID0ge1xuICAgICAgaWQ6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0SWRcIiwgXCJpZFwiXSksXG4gICAgICBuYW1lOiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1uYW1lXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0TmFtZVwiLCBcIm5hbWVcIl0pLFxuICAgICAgd29ya3NwYWNlUGF0aDogZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJ3b3Jrc3BhY2VQYXRoXCIsIFwicHJvamVjdFBhdGhcIiwgXCJjd2RcIl0pLFxuICAgIH07XG4gICAgaWYgKGNvbnRleHQuaWQgfHwgY29udGV4dC5uYW1lIHx8IGNvbnRleHQud29ya3NwYWNlUGF0aCkgcmV0dXJuIGNvbnRleHQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF0dGFjaEZpbGVzKGZpbGVzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbWltZVR5cGU6IHN0cmluZzsgZGF0YUJhc2U2NDogc3RyaW5nIH0+KTogUHJvbWlzZTx7IGFjY2VwdGVkOiBib29sZWFuOyByZWFzb246IFwiYWNjZXB0ZWRcIiB8IFwiY29tcG9zZXItbWlzc2luZ1wiIHwgXCJwYXN0ZS1yZWplY3RlZFwiIHwgXCJhdHRhY2htZW50LXRpbWVvdXRcIiB9PiB7XG4gIGNvbnN0IHRhcmdldCA9IHF1ZXJ5SG9zdFN1cmZhY2VzKFwiY29tcG9zZXJcIilbMF0/LmVsZW1lbnQgPz8gbnVsbDtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiB7IGFjY2VwdGVkOiBmYWxzZSwgcmVhc29uOiBcImNvbXBvc2VyLW1pc3NpbmdcIiB9O1xuICBjb25zdCBwcmVwYXJlZCA9IGZpbGVzLm1hcCgoZmlsZSkgPT4ge1xuICAgIGNvbnN0IGJ5dGVzID0gVWludDhBcnJheS5mcm9tKGF0b2IoZmlsZS5kYXRhQmFzZTY0KSwgKGNoYXIpID0+IGNoYXIuY2hhckNvZGVBdCgwKSk7XG4gICAgcmV0dXJuIG5ldyBGaWxlKFtieXRlc10sIHNhZmVGaWxlTmFtZShmaWxlLm5hbWUpLCB7IHR5cGU6IGZpbGUubWltZVR5cGUgfHwgXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIiB9KTtcbiAgfSk7XG4gIGNvbnN0IHRyYW5zZmVyID0gbmV3IERhdGFUcmFuc2ZlcigpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgcHJlcGFyZWQpIHRyYW5zZmVyLml0ZW1zLmFkZChmaWxlKTtcbiAgdGFyZ2V0LmRpc3BhdGNoRXZlbnQobmV3IERyYWdFdmVudChcImRyb3BcIiwgeyBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlLCBkYXRhVHJhbnNmZXI6IHRyYW5zZmVyIH0pKTtcbiAgY29uc3QgcGFzdGUgPSBuZXcgQ2xpcGJvYXJkRXZlbnQoXCJwYXN0ZVwiLCB7IGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWUsIGNsaXBib2FyZERhdGE6IHRyYW5zZmVyIH0pO1xuICBjb25zdCBhY2NlcHRlZCA9IHRhcmdldC5kaXNwYXRjaEV2ZW50KHBhc3RlKTtcbiAgdGFyZ2V0LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgKHRhcmdldCBhcyBIVE1MRWxlbWVudCkuZm9jdXM/LigpO1xuICByZXR1cm4geyBhY2NlcHRlZDogYWNjZXB0ZWQgIT09IGZhbHNlLCByZWFzb246IGFjY2VwdGVkID09PSBmYWxzZSA/IFwicGFzdGUtcmVqZWN0ZWRcIiA6IFwiYWNjZXB0ZWRcIiB9O1xufVxuXG5mdW5jdGlvbiBzYWZlRmlsZU5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBTdHJpbmcodmFsdWUgfHwgXCJBcHBTaG90XCIpLnJlcGxhY2UoL1svOlxcXFxcXDBcXHJcXG5dL2csIFwiLVwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiBjbGVhbmVkLnNsaWNlKDAsIDE2MCkgfHwgXCJBcHBTaG90XCI7XG59XG5cbmZ1bmN0aW9uIHNlbWFudGljRmlsdGVyKGtpbmQ6IEhvc3RTdXJmYWNlS2luZCwgZWxlbWVudDogRWxlbWVudCk6IGJvb2xlYW4ge1xuICBjb25zdCB0ZXh0ID0gY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KTtcbiAgaWYgKGtpbmQgPT09IFwiYXNzaXN0YW50LXR1cm5zXCIpIHtcbiAgICBjb25zdCByb2xlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLW1lc3NhZ2UtYXV0aG9yLXJvbGVcIikgfHwgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXJvbGVcIik7XG4gICAgcmV0dXJuIHJvbGUgPyByb2xlLnRvTG93ZXJDYXNlKCkgPT09IFwiYXNzaXN0YW50XCIgOiAvYXNzaXN0YW50LW1lc3NhZ2UvaS50ZXN0KGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS10ZXN0aWRcIikgfHwgXCJcIik7XG4gIH1cbiAgaWYgKGtpbmQgPT09IFwiYWNjb3VudC1tZW51XCIpIHJldHVybiAvYWNjb3VudHxzZXR0aW5nc3xsb2dcXHMqb3V0L2kudGVzdCh0ZXh0KTtcbiAgaWYgKGtpbmQgPT09IFwic2V0dGluZ3Mtcm93c1wiKSByZXR1cm4gdGV4dC5sZW5ndGggPiAwO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY29uZmlkZW5jZUZvcihraW5kOiBIb3N0U3VyZmFjZUtpbmQsIGVsZW1lbnQ6IEVsZW1lbnQpOiBIb3N0U3VyZmFjZU1hdGNoW1wiY29uZmlkZW5jZVwiXSB7XG4gIGlmIChlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtdGVzdGlkXCIpIHx8IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fCBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcInJvbGVcIikpIHJldHVybiBcImhpZ2hcIjtcbiAgcmV0dXJuIGtpbmQgPT09IFwiY29tcG9zZXJcIiB8fCBraW5kID09PSBcInRpdGxlYmFyLWNvbnRyb2xzXCIgPyBcIm1lZGl1bVwiIDogXCJsb3dcIjtcbn1cblxuZnVuY3Rpb24gZmliZXJQcm9wcyhlbGVtZW50OiBFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgbGV0IGZpYmVyID0gZmliZXJGb3JOb2RlKGVsZW1lbnQpIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBmb3IgKGxldCBkZXB0aCA9IDA7IGZpYmVyICYmIGRlcHRoIDwgMjA7IGRlcHRoICs9IDEsIGZpYmVyID0gZmliZXIucmV0dXJuKSB7XG4gICAgaWYgKGZpYmVyLm1lbW9pemVkUHJvcHMgJiYgdHlwZW9mIGZpYmVyLm1lbW9pemVkUHJvcHMgPT09IFwib2JqZWN0XCIpIE9iamVjdC5hc3NpZ24obWVyZ2VkLCBmaWJlci5tZW1vaXplZFByb3BzKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXMobWVyZ2VkKS5sZW5ndGggPyBtZXJnZWQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBmaXJzdFN0cmluZyhwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsLCBrZXlzOiBzdHJpbmdbXSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICghcHJvcHMpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHF1ZXVlOiB1bmtub3duW10gPSBbcHJvcHNdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpO1xuICBmb3IgKGxldCB2aXNpdGVkID0gMDsgcXVldWUubGVuZ3RoICYmIHZpc2l0ZWQgPCA4MDsgdmlzaXRlZCArPSAxKSB7XG4gICAgY29uc3QgdmFsdWUgPSBxdWV1ZS5zaGlmdCgpO1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHNlZW4uaGFzKHZhbHVlKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICAgIGZvciAoY29uc3QgW2tleSwgaXRlbV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBpZiAoa2V5cy5pbmNsdWRlcyhrZXkpICYmIHR5cGVvZiBpdGVtID09PSBcInN0cmluZ1wiICYmIGl0ZW0udHJpbSgpKSByZXR1cm4gaXRlbTtcbiAgICAgIGlmIChpdGVtICYmIHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiKSBxdWV1ZS5wdXNoKGl0ZW0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB1bmlxdWVFbGVtZW50cyhpbnB1dDogSXRlcmFibGU8RWxlbWVudD4gfCBBcnJheUxpa2U8RWxlbWVudD4pOiBFbGVtZW50W10ge1xuICByZXR1cm4gWy4uLm5ldyBTZXQoQXJyYXkuZnJvbShpbnB1dCkpXTtcbn1cblxuZnVuY3Rpb24gYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQ6IEVsZW1lbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwidGl0bGVcIikgfHwgY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KSB8fCB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3QodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cbiIsICJleHBvcnQgdHlwZSBUd2Vha1Njb3BlID0gXCJyZW5kZXJlclwiIHwgXCJtYWluXCIgfCBcImJvdGhcIjtcblxuLyoqXG4gKiBMaWZlY3ljbGUgc3RhdGVzIGFyZSBkZWxpYmVyYXRlbHkgbW9yZSBkZXRhaWxlZCB0aGFuIHRoZSB1c2VyLWZhY2luZ1xuICogaW5zdGFsbGVkL2VuYWJsZWQgc3RhdHVzLiAgQSB0d2VhayBtYXkgYmUgdmlzaWJsZSBhcyBlbmFibGVkIHdoaWxlIGl0c1xuICogYXN5bmNocm9ub3VzIHN0YXJ0IGlzIHN0aWxsIGluIGZsaWdodCwgb3IgYXMgZmFpbGVkIGFmdGVyIGFub3RoZXIgdHdlYWtcbiAqIGhhcyBhbHJlYWR5IHJlYWNoZWQgcmVhZHkuXG4gKi9cbmV4cG9ydCBjb25zdCBUV0VBS19MSUZFQ1lDTEVfU1RBVFVTRVMgPSBbXG4gIFwic3RhcnRpbmdcIixcbiAgXCJyZWFkeVwiLFxuICBcImZhaWxlZFwiLFxuICBcInRpbWVkX291dFwiLFxuICBcImRpc2FibGVkXCIsXG4gIFwicXVhcmFudGluZWRcIixcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBUd2Vha0xpZmVjeWNsZVN0YXR1cyA9ICh0eXBlb2YgVFdFQUtfTElGRUNZQ0xFX1NUQVRVU0VTKVtudW1iZXJdO1xuZXhwb3J0IHR5cGUgVHdlYWtQcm9jZXNzID0gXCJtYWluXCIgfCBcInJlbmRlcmVyXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVSZWNvcmQge1xuICBpZDogc3RyaW5nO1xuICBwcm9jZXNzOiBUd2Vha1Byb2Nlc3M7XG4gIHN0YXR1czogVHdlYWtMaWZlY3ljbGVTdGF0dXM7XG4gIGF0dGVtcHRJZDogc3RyaW5nO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbiAgc3RhcnRlZEF0Pzogc3RyaW5nO1xuICBmaW5pc2hlZEF0Pzogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbiAgLyoqIENvbnNlY3V0aXZlIHN0YXJ0dXAgYXR0ZW1wdHMgY3V0IHNob3J0IGJ5IGEgcHJvY2VzcyBleGl0OyByZXNldCBieSBhIHN1Y2Nlc3NmdWwgcmVhZHkuICovXG4gIGludGVycnVwdGVkQXR0ZW1wdHM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVBdHRlbXB0IHtcbiAgaWQ6IHN0cmluZztcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkQXQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgY3VycmVudEF0dGVtcHQ6IFR3ZWFrTGlmZWN5Y2xlQXR0ZW1wdCB8IG51bGw7XG4gIHJlY29yZHM6IFJlY29yZDxzdHJpbmcsIFR3ZWFrTGlmZWN5Y2xlUmVjb3JkPjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVR3ZWFrTGlmZWN5Y2xlSm91cm5hbChcbiAgYXR0ZW1wdElkID0gYGF0dGVtcHQtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWAsXG4gIHBpZD86IG51bWJlcixcbiAgc3RhcnRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuKTogVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIGN1cnJlbnRBdHRlbXB0OiB7IGlkOiBhdHRlbXB0SWQsIHBpZCwgc3RhcnRlZEF0IH0sXG4gICAgcmVjb3Jkczoge30sXG4gIH07XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyA9IDVfMDAwO1xuZXhwb3J0IGNvbnN0IE1JTl9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSAxMDA7XG5leHBvcnQgY29uc3QgTUFYX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyA9IDMwXzAwMDtcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVR3ZWFrU3RhcnR1cFRpbWVvdXRNcyh2YWx1ZTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHtcbiAgICByZXR1cm4gREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVM7XG4gIH1cbiAgcmV0dXJuIE1hdGgubWluKFxuICAgIE1BWF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4gICAgTWF0aC5tYXgoTUlOX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUywgTWF0aC5yb3VuZCh2YWx1ZSkpLFxuICApO1xufVxuXG4vKipcbiAqIFJhY2UgYSB0d2VhaydzIHN0YXJ0dXAgcHJvbWlzZSBhZ2FpbnN0IGEgYm91bmRlZCB0aW1lb3V0LiAgVGhlIG9yaWdpbmFsXG4gKiBwcm9taXNlIGlzIG9ic2VydmVkIGFmdGVyIHRoZSB0aW1lb3V0IHNvIGEgbGF0ZSByZWplY3Rpb24gY2Fubm90IGJlY29tZSBhblxuICogdW5oYW5kbGVkIHJlamVjdGlvbiwgd2hpbGUgdGhlIGNhbGxlciBpcyBmcmVlIHRvIGNvbnRpbnVlIGxvYWRpbmcgc2libGluZ1xuICogdHdlYWtzIGltbWVkaWF0ZWx5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aFN0YXJ0dXBUaW1lb3V0PFQ+KFxuICB2YWx1ZTogUHJvbWlzZUxpa2U8VD4gfCBULFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx7IHN0YXR1czogXCJyZWFkeVwiOyB2YWx1ZTogVCB9IHwgeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4ge1xuICBjb25zdCBub3JtYWxpemVkVGltZW91dE1zID0gbm9ybWFsaXplVHdlYWtTdGFydHVwVGltZW91dE1zKHRpbWVvdXRNcyk7XG4gIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUodmFsdWUpO1xuICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2U8eyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4oKHJlc29sdmUpID0+IHtcbiAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSh7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9KSwgbm9ybWFsaXplZFRpbWVvdXRNcyk7XG4gIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBwcm9taXNlLnRoZW4oKHJlc29sdmVkKSA9PiAoeyBzdGF0dXM6IFwicmVhZHlcIiBhcyBjb25zdCwgdmFsdWU6IHJlc29sdmVkIH0pKSxcbiAgICAgIHRpbWVvdXQsXG4gICAgXSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgLy8gQXR0YWNoIGEgcmVqZWN0aW9uIG9ic2VydmVyIGV2ZW4gd2hlbiB0aW1lb3V0IHdvbi4gIFRoaXMgaW50ZW50aW9uYWxseVxuICAgIC8vIGRvZXMgbm90IGF3YWl0IHRoZSBsYXRlIHJlc3VsdC5cbiAgICB2b2lkIHByb21pc2UuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgfVxufVxuXG4vKiogQ29udmVuaWVuY2UgZm9ybSBmb3IgY2FsbGVycyB0aGF0IGhhdmUgYSBsYXp5IHN0YXJ0IG9wZXJhdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5XaXRoU3RhcnR1cFRpbWVvdXQ8VD4oXG4gIHN0YXJ0OiAoKSA9PiBQcm9taXNlTGlrZTxUPiB8IFQsXG4gIHRpbWVvdXRNczogbnVtYmVyID0gREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBcInJlYWR5XCI7IHZhbHVlOiBUIH0gfCB7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9PiB7XG4gIGxldCB2YWx1ZTogUHJvbWlzZUxpa2U8VD4gfCBUO1xuICB0cnkge1xuICAgIHZhbHVlID0gc3RhcnQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyb3IpO1xuICB9XG4gIHJldHVybiB3aXRoU3RhcnR1cFRpbWVvdXQodmFsdWUsIHRpbWVvdXRNcyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsaWZlY3ljbGVSZWNvcmRLZXkocHJvY2VzczogVHdlYWtQcm9jZXNzLCBpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Byb2Nlc3N9OiR7aWR9YDtcbn1cblxuLyoqXG4gKiBCaW5kIGEgbWFpbi1wcm9jZXNzIHR3ZWFrJ3MgYHN0b3AoKWAgdG8gdGhlIHR3ZWFrIG9iamVjdCBzbyBjbGVhbnVwIHRoYXRcbiAqIHJlbGllcyBvbiBgdGhpc2AgKHBlci1pbnN0YW5jZSBkaXNwb3NlcnMsIElQQyBoYW5kbGUgcmVtb3ZlcnMpIHdvcmtzLiBUaGVcbiAqIHJlbmRlcmVyIGhvc3QgYmluZHMgc3RvcCB0aGUgc2FtZSB3YXkgKHByZWxvYWQvdHdlYWstaG9zdC50cyk7IHRoZSBtYWluXG4gKiBydW50aW1lIGhpc3RvcmljYWxseSBzdG9yZWQgaXQgdW5ib3VuZCwgc2lsZW50bHkgYnJlYWtpbmcgYHRoaXNgLWJhc2VkIG1haW5cbiAqIGNsZWFudXAgZm9yIGBzY29wZTogXCJib3RoXCJgIHR3ZWFrcyAoZm9sbG93dXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmluZE1haW5Ud2Vha1N0b3A8VCBleHRlbmRzIHsgc3RvcD86ICguLi5hcmdzOiB1bmtub3duW10pID0+IHVua25vd24gfT4oXG4gIHR3ZWFrOiBUIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IFRbXCJzdG9wXCJdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0d2VhayB8fCB0eXBlb2YgdHdlYWsuc3RvcCAhPT0gXCJmdW5jdGlvblwiKSByZXR1cm4gdHdlYWs/LnN0b3A7XG4gIHJldHVybiB0d2Vhay5zdG9wLmJpbmQodHdlYWspIGFzIFRbXCJzdG9wXCJdO1xufVxuXG4vKipcbiAqIEEgd2hvbGUtYXBwIHJlc3RhcnQgcmFjaW5nIHRoZSBzZXF1ZW50aWFsIHR3ZWFrLWxvYWQgbG9vcCBsZWF2ZXMgaW5ub2NlbnRcbiAqIHR3ZWFrcyBpbiBcInN0YXJ0aW5nXCI7IG9ubHkgcmVwZWF0ZWQgaW50ZXJydXB0aW9ucyBpbmRpY2F0ZSB0aGUgdHdlYWsgaXRzZWxmXG4gKiBpcyBoYW5naW5nIHN0YXJ0dXAuIE9uZSBpbnRlcnJ1cHRpb24gaXMgdGhlcmVmb3JlIHJldHJpZWQsIG5vdCBxdWFyYW50aW5lZC5cbiAqL1xuZXhwb3J0IGNvbnN0IElOVEVSUlVQVEVEX0FUVEVNUFRTX0JFRk9SRV9RVUFSQU5USU5FID0gMjtcblxuLyoqXG4gKiBUdXJuIGEgam91cm5hbCBmcm9tIGEgcHJldmlvdXMgcHJvY2VzcyBpbnRvIGV4cGxpY2l0IHJlY29yZHMuIE9ubHkgcmVjb3Jkc1xuICogZnJvbSB0aGUgdW5maW5pc2hlZCBjdXJyZW50IGF0dGVtcHQgYXJlIGNoYW5nZWQ7IGhpc3RvcmljYWwgcmVhZHkvZmFpbGVkXG4gKiByZWNvcmRzIHJlbWFpbiBhdmFpbGFibGUgZm9yIGRpYWdub3N0aWNzLiBBIGZpcnN0IGludGVycnVwdGlvbiBiZWNvbWVzIGFcbiAqIHJldHJ5YWJsZSBcImZhaWxlZFwiOyBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORSBjb25zZWN1dGl2ZVxuICogaW50ZXJydXB0aW9ucyBxdWFyYW50aW5lIHRoZSB0d2Vhay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY292ZXJJbnRlcnJ1cHRlZFR3ZWFrcyhcbiAgam91cm5hbDogVHdlYWtMaWZlY3ljbGVKb3VybmFsLFxuICBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4pOiBUd2Vha0xpZmVjeWNsZUpvdXJuYWwge1xuICBjb25zdCBjdXJyZW50QXR0ZW1wdCA9IGpvdXJuYWwuY3VycmVudEF0dGVtcHQ7XG4gIGlmICghY3VycmVudEF0dGVtcHQgfHwgY3VycmVudEF0dGVtcHQuY29tcGxldGVkQXQpIHJldHVybiBqb3VybmFsO1xuICBjb25zdCByZWNvcmRzID0geyAuLi5qb3VybmFsLnJlY29yZHMgfTtcbiAgZm9yIChjb25zdCBba2V5LCByZWNvcmRdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZHMpKSB7XG4gICAgaWYgKHJlY29yZC5hdHRlbXB0SWQgIT09IGN1cnJlbnRBdHRlbXB0LmlkKSBjb250aW51ZTtcbiAgICBpZiAocmVjb3JkLnN0YXR1cyAhPT0gXCJzdGFydGluZ1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBpbnRlcnJ1cHRlZEF0dGVtcHRzID0gKHJlY29yZC5pbnRlcnJ1cHRlZEF0dGVtcHRzID8/IDApICsgMTtcbiAgICBjb25zdCBxdWFyYW50aW5lID0gaW50ZXJydXB0ZWRBdHRlbXB0cyA+PSBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORTtcbiAgICByZWNvcmRzW2tleV0gPSB7XG4gICAgICAuLi5yZWNvcmQsXG4gICAgICBzdGF0dXM6IHF1YXJhbnRpbmUgPyBcInF1YXJhbnRpbmVkXCIgOiBcImZhaWxlZFwiLFxuICAgICAgaW50ZXJydXB0ZWRBdHRlbXB0cyxcbiAgICAgIHVwZGF0ZWRBdDogbm93LFxuICAgICAgZmluaXNoZWRBdDogbm93LFxuICAgICAgZXJyb3I6IHJlY29yZC5lcnJvciA/PyAocXVhcmFudGluZVxuICAgICAgICA/IGBzdGFydHVwIHdhcyBpbnRlcnJ1cHRlZCAke2ludGVycnVwdGVkQXR0ZW1wdHN9IHRpbWVzIGluIGEgcm93YFxuICAgICAgICA6IFwicHJldmlvdXMgc3RhcnR1cCBhdHRlbXB0IHdhcyBpbnRlcnJ1cHRlZDsgd2lsbCByZXRyeVwiKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IC4uLmpvdXJuYWwsIGN1cnJlbnRBdHRlbXB0OiB7IC4uLmN1cnJlbnRBdHRlbXB0LCBjb21wbGV0ZWRBdDogbm93IH0sIHJlY29yZHMgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWxvYWRUd2Vha3NEZXBzIHtcbiAgbG9nSW5mbyhtZXNzYWdlOiBzdHJpbmcpOiB2b2lkO1xuICBzdG9wQWxsTWFpblR3ZWFrcygpOiB2b2lkO1xuICBjbGVhclR3ZWFrTW9kdWxlQ2FjaGUoKTogdm9pZDtcbiAgbG9hZEFsbE1haW5Ud2Vha3MoKTogdm9pZDtcbiAgYnJvYWRjYXN0UmVsb2FkKCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0VHdlYWtFbmFibGVkQW5kUmVsb2FkRGVwcyBleHRlbmRzIFJlbG9hZFR3ZWFrc0RlcHMge1xuICBzZXRUd2Vha0VuYWJsZWQoaWQ6IHN0cmluZywgZW5hYmxlZDogYm9vbGVhbik6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc01haW5Qcm9jZXNzVHdlYWtTY29wZShzY29wZTogVHdlYWtTY29wZSB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc2NvcGUgIT09IFwicmVuZGVyZXJcIjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbG9hZFR3ZWFrcyhyZWFzb246IHN0cmluZywgZGVwczogUmVsb2FkVHdlYWtzRGVwcyk6IHZvaWQge1xuICBkZXBzLmxvZ0luZm8oYHJlbG9hZGluZyB0d2Vha3MgKCR7cmVhc29ufSlgKTtcbiAgZGVwcy5zdG9wQWxsTWFpblR3ZWFrcygpO1xuICBkZXBzLmNsZWFyVHdlYWtNb2R1bGVDYWNoZSgpO1xuICBkZXBzLmxvYWRBbGxNYWluVHdlYWtzKCk7XG4gIGRlcHMuYnJvYWRjYXN0UmVsb2FkKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRUd2Vha0VuYWJsZWRBbmRSZWxvYWQoXG4gIGlkOiBzdHJpbmcsXG4gIGVuYWJsZWQ6IHVua25vd24sXG4gIGRlcHM6IFNldFR3ZWFrRW5hYmxlZEFuZFJlbG9hZERlcHMsXG4pOiB0cnVlIHtcbiAgY29uc3Qgbm9ybWFsaXplZEVuYWJsZWQgPSAhIWVuYWJsZWQ7XG4gIGRlcHMuc2V0VHdlYWtFbmFibGVkKGlkLCBub3JtYWxpemVkRW5hYmxlZCk7XG4gIGRlcHMubG9nSW5mbyhgdHdlYWsgJHtpZH0gZW5hYmxlZD0ke25vcm1hbGl6ZWRFbmFibGVkfWApO1xuICByZWxvYWRUd2Vha3MoXCJlbmFibGVkLXRvZ2dsZVwiLCBkZXBzKTtcbiAgcmV0dXJuIHRydWU7XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJjb2RleHBwOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwiY29kZXgtcGx1c3BsdXM6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwiY29kZXhwcDpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFXQSxJQUFBQSxtQkFBNEI7OztBQzZCckIsU0FBUyxtQkFBeUI7QUFDdkMsTUFBSSxPQUFPLCtCQUFnQztBQUMzQyxRQUFNLFlBQVksb0JBQUksSUFBK0I7QUFDckQsTUFBSSxTQUFTO0FBQ2IsUUFBTUMsYUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSUEsV0FBVSxJQUFJLEtBQUs7QUFDM0IsVUFBSSxDQUFDLEVBQUcsQ0FBQUEsV0FBVSxJQUFJLE9BQVEsSUFBSSxvQkFBSSxJQUFJLENBQUU7QUFDNUMsUUFBRSxJQUFJLEVBQUU7QUFBQSxJQUNWO0FBQUEsSUFDQSxJQUFJLE9BQU8s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LFFBQVEsRUFBRyxPQUFNLElBQUksTUFBTSxtQkFBbUI7QUFDN0UsTUFBSSxnQkFBZ0IsSUFBSSxRQUFRLEVBQUcsUUFBTztBQUMxQyxRQUFNLFdBQVcsQ0FBQyxRQUFpQixZQUFxQjtBQUN0RCxpQ0FBWSxLQUFLLDJCQUEyQixVQUFVLE9BQU87QUFBQSxFQUMvRDtBQUNBLGtCQUFnQixJQUFJLFVBQVUsUUFBUTtBQUN0QywrQkFBWSxHQUFHLDRCQUE0QixRQUFRLEdBQUcsUUFBUTtBQUM5RCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLG1DQUNQLFVBQ0EsaUJBQ1M7QUFDVCxRQUFNLFdBQVcsZ0JBQWdCLElBQUksUUFBUTtBQUM3QyxNQUFJLENBQUMsU0FBVSxRQUFPO0FBQ3RCLGtCQUFnQixPQUFPLFFBQVE7QUFDL0IsK0JBQVksZUFBZSw0QkFBNEIsUUFBUSxHQUFHLFFBQVE7QUFDMUUsU0FBTztBQUNUOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfZWxlY3Ryb24iLCAibGlzdGVuZXJzIiwgImJ1dHRvbiIsICJidXR0b24iLCAicm9vdCIsICJzbmFwc2hvdCIsICJzdGF0ZSIsICJjaGVjayIsICJidXR0b24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImltcG9ydF9lbGVjdHJvbiIsICJzYWZlU3RyaW5naWZ5Il0KfQo=
