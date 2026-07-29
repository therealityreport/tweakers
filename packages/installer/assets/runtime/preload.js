"use strict";

// src/preload/index.ts
var import_electron5 = require("electron");

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
        "[tweaker] React renderer attached:",
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
  window.__tweaker__ = { hook, renderers };
}
function fiberForNode(node) {
  const renderers = window.__tweaker__?.renderers;
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

// src/preload/environment-config-controller.ts
function createEnvironmentConfigController(selected, effects, options = {}) {
  let selectedValue = copySelection(selected);
  let pendingValue = copySelection(selected);
  let busy = false;
  let phase = "idle";
  let error = null;
  const readSnapshot = () => ({
    selected: copySelection(selectedValue),
    pending: copySelection(pendingValue),
    hasPendingChanges: !sameSelection(selectedValue, pendingValue),
    busy,
    phase,
    error
  });
  const publish = () => options.onChange?.(readSnapshot());
  const finishWithError = (nextPhase, nextError) => {
    error = environmentConfigError(nextError);
    busy = false;
    phase = nextPhase;
    publish();
    return error;
  };
  const completePrepared = async (requested, receipt) => {
    phase = "awaiting-confirmation";
    publish();
    let decision;
    try {
      decision = await effects.confirm(copySelection(requested), receipt);
    } catch (confirmationError) {
      return {
        outcome: "confirmation-failed",
        receipt,
        error: finishWithError("idle", confirmationError)
      };
    }
    if (decision === "cancel") {
      phase = "cancelling";
      publish();
      try {
        await effects.cancel(receipt);
      } catch (cancelError) {
        return {
          outcome: "cancel-failed",
          receipt,
          error: finishWithError("idle", cancelError)
        };
      }
      pendingValue = copySelection(selectedValue);
      busy = false;
      phase = "idle";
      error = null;
      publish();
      return { outcome: "cancelled", receipt };
    }
    phase = "committing";
    publish();
    try {
      await effects.commit(receipt);
    } catch (commitError) {
      return {
        outcome: "commit-failed",
        receipt,
        error: finishWithError("idle", commitError)
      };
    }
    busy = false;
    phase = "idle";
    error = null;
    publish();
    return { outcome: "submitted", receipt };
  };
  return {
    get snapshot() {
      return readSnapshot();
    },
    setSelected(selection) {
      const pendingWasUnchanged = sameSelection(selectedValue, pendingValue);
      selectedValue = copySelection(selection);
      if (pendingWasUnchanged) pendingValue = copySelection(selection);
      error = null;
      publish();
    },
    restorePending(selection) {
      pendingValue = copySelection(selection);
      publish();
    },
    stageAppExperience(value) {
      if (busy) return;
      pendingValue = { ...pendingValue, appExperience: value };
      error = null;
      publish();
    },
    stageReleaseProfile(value) {
      if (busy) return;
      pendingValue = { ...pendingValue, releaseProfile: value };
      error = null;
      publish();
    },
    clearError() {
      error = null;
      publish();
    },
    async applyAndRestart() {
      if (busy) return { outcome: "busy" };
      if (sameSelection(selectedValue, pendingValue)) return { outcome: "no-change" };
      const requested = copySelection(pendingValue);
      busy = true;
      phase = "preparing";
      error = null;
      publish();
      let receipt;
      try {
        receipt = await effects.prepare(copySelection(requested));
      } catch (prepareError) {
        return {
          outcome: "prepare-failed",
          error: finishWithError("idle", prepareError)
        };
      }
      return completePrepared(requested, receipt);
    },
    async resumePrepared(selection, receipt) {
      if (busy) return { outcome: "busy" };
      pendingValue = copySelection(selection);
      busy = true;
      error = null;
      return completePrepared(copySelection(selection), receipt);
    }
  };
}
function copySelection(selection) {
  return {
    appExperience: selection.appExperience,
    releaseProfile: selection.releaseProfile
  };
}
function sameSelection(left, right) {
  return left.appExperience === right.appExperience && left.releaseProfile === right.releaseProfile;
}
function environmentConfigError(error) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
function desktopUpdateStatusPresentation(status) {
  switch (status) {
    case "current":
      return { label: "Up to date", tone: "ok" };
    case "update-available":
      return { label: "Update available", tone: "warn" };
    case "error":
      return { label: "Error", tone: "error" };
    case "stale":
      return { label: "Stale", tone: "warn" };
    case "unavailable":
      return { label: "Unavailable", tone: "warn" };
    default:
      return { label: "Not checked", tone: "warn" };
  }
}
function restoreEnvironmentFocus(opener, fallback) {
  if (opener?.isConnected) {
    opener.focus();
    return "opener";
  }
  const target = fallback();
  if (target?.isConnected) {
    target.focus();
    return "fallback";
  }
  return "none";
}
var ConfigCardUpdateCoordinator = class {
  #generations = /* @__PURE__ */ new Map();
  #values = /* @__PURE__ */ new Map();
  begin(card) {
    const generation = (this.#generations.get(card) ?? 0) + 1;
    this.#generations.set(card, generation);
    return Object.freeze({ card, generation });
  }
  complete(token, value) {
    if (!this.isCurrent(token)) return false;
    this.#values.set(token.card, value);
    return true;
  }
  isCurrent(token) {
    return this.#generations.get(token.card) === token.generation;
  }
  invalidate(card) {
    this.#generations.set(card, (this.#generations.get(card) ?? 0) + 1);
  }
  value(card) {
    return this.#values.get(card);
  }
  snapshot() {
    return Object.fromEntries(this.#values);
  }
};

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
  tweakerUpdateButton: null,
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
    "tweaker:preload-log",
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
      window.dispatchEvent(new Event(`tweaker-${m}`));
      return r;
    };
    window.addEventListener(`tweaker-${m}`, onNav);
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
  const existingTweakerNavGroup = outer.querySelector(':scope > [data-tweaker="nav-group"]') ?? outer.querySelector('[data-tweaker="nav-group"]');
  if (existingTweakerNavGroup) {
    state.navGroup = existingTweakerNavGroup;
    state.tweakerUpdateButton = existingTweakerNavGroup.querySelector(
      "[data-tweaker-sidebar-update]"
    );
    state.sidebarRoot = outer;
    syncPagesGroup();
    refreshSidebarTweakerUpdateButton();
    if (state.activePage !== null) syncCodexNativeNavActive(true);
    return;
  }
  const group = document.createElement("div");
  group.dataset.tweaker = "nav-group";
  group.className = "flex flex-col gap-px";
  const updateButton = sidebarUpdatePillButton();
  state.tweakerUpdateButton = updateButton;
  group.appendChild(sidebarGroupHeader("Tweakers", "pt-3", updateButton));
  refreshSidebarTweakerUpdateButton();
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
  header.dataset.tweaker = "native-nav-header";
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
      if (!button2.closest("[data-tweaker]")) continue;
      button2.hidden = !!query && !compactSettingsText(button2.textContent ?? "").toLocaleLowerCase().includes(query);
    }
    for (const group of Array.from(root.querySelectorAll("[data-tweaker='nav-group'], [data-tweaker='pages-group']"))) {
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
  return isTweakerSettingsLabelSet(tweakerSettingsLabelsFrom(document));
}
function compactSettingsText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
var TWEAKER_CORE_SETTINGS_LABELS = [
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
].map(normalizeTweakerSettingsLabel);
var TWEAKER_EXTENDED_SETTINGS_LABELS = [
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
].map(normalizeTweakerSettingsLabel);
var TWEAKER_SETTINGS_ONLY_LABELS = [
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
].map(normalizeTweakerSettingsLabel);
var TWEAKER_MAIN_APP_NAV_LABELS = [
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
].map(normalizeTweakerSettingsLabel);
function normalizeTweakerSettingsLabel(value) {
  return compactSettingsText(value).toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
}
function tweakerControlLabel(el) {
  return normalizeTweakerSettingsLabel(
    el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || ""
  );
}
function tweakerSettingsLabelsFrom(root) {
  const controls = Array.from(
    root.querySelectorAll("button,a,[role='button'],[role='link']")
  );
  return [
    ...new Set(
      controls.map(tweakerControlLabel).filter(Boolean)
    )
  ];
}
function tweakerSettingsLabelScore(labels) {
  const core = /* @__PURE__ */ new Set();
  const total = /* @__PURE__ */ new Set();
  for (const label of labels) {
    for (const marker of TWEAKER_CORE_SETTINGS_LABELS) {
      if (tweakerLabelMatchesMarker(label, marker)) core.add(marker);
    }
    for (const marker of TWEAKER_EXTENDED_SETTINGS_LABELS) {
      if (tweakerLabelMatchesMarker(label, marker)) total.add(marker);
    }
  }
  return { core: core.size, total: total.size };
}
function tweakerLabelMatchesMarker(label, marker) {
  return label === marker || label.includes(marker);
}
function tweakerMarkerCount(labels, markers) {
  const matched = /* @__PURE__ */ new Set();
  for (const label of labels) {
    for (const marker of markers) {
      if (tweakerLabelMatchesMarker(label, marker)) matched.add(marker);
    }
  }
  return matched.size;
}
function hasTweakerSettingsOnlySignal(labels) {
  return tweakerMarkerCount(labels, TWEAKER_SETTINGS_ONLY_LABELS) > 0;
}
function hasMainAppSidebarSignals(labels) {
  return tweakerMarkerCount(labels, TWEAKER_MAIN_APP_NAV_LABELS) >= 2;
}
function isTweakerSettingsLabelSet(labels) {
  const score = tweakerSettingsLabelScore(labels);
  return score.core >= 2 && score.total >= 3;
}
function tweakerVisibleBox(el) {
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
    window.__tweakerSettingsSurfaceVisible = visible;
    document.documentElement.dataset.tweakerSettingsSurface = visible ? "true" : "false";
    window.dispatchEvent(
      new CustomEvent("tweaker:settings-surface", {
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
    group.dataset.tweaker = "pages-group";
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
    btn.dataset.tweaker = `nav-page-${p.tweakId}`;
    btn.dataset.tweakerLifecycle = p.lifecycle;
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
  btn.dataset.tweaker = `nav-${label.toLowerCase()}`;
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
    if (btn.dataset.tweaker) continue;
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
    if (child.dataset.tweaker === "tweaks-panel") continue;
    if (child.dataset.tweakerHidden === void 0) {
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
      if (target.closest("[data-tweaker-settings-search]")) return;
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
    if (child.dataset.tweakerHidden !== void 0) {
      child.style.display = child.dataset.tweakerHidden;
      delete child.dataset.tweakerHidden;
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
  else activeBuiltinPageCleanup = renderConfigPage(root.sectionsWrap, root.subtitle);
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
      void import_electron.ipcRenderer.invoke("tweaker:recover-tweak", item.tweakId).finally(() => {
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
  const cleanups = [];
  const cardUpdates = new ConfigCardUpdateCoordinator();
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
  void import_electron.ipcRenderer.invoke("tweaker:get-config").then((config) => {
    if (subtitle) {
      subtitle.textContent = `You have Tweakers ${config.version} installed.`;
    }
    card.textContent = "";
    renderTweakerConfig(card, config);
  }).catch((e) => {
    if (subtitle) subtitle.textContent = "Could not load installed Tweakers version.";
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
      } catch {
      }
    }
  };
}
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
    if (!transaction || transaction.phase !== "preparing" && transaction.phase !== "prepared") return;
    const requested = environmentTransactionRequestedSelection(transaction);
    if (requested) environmentController.restorePending(requested);
  };
  const scheduleEnvironmentTransactionPoll = () => {
    if (transactionPolling) clearTimeout(transactionPolling);
    transactionPolling = null;
    if (!card.isConnected) return;
    if (!transaction && !lastTransactionFetchFailed) return;
    if (transaction && environmentTransactionIsTerminal(transaction.phase)) return;
    transactionPolling = setTimeout(() => {
      transactionPolling = null;
      void loadEnvironmentTransaction();
    }, lastTransactionFetchFailed ? 5e3 : 900);
  };
  async function prepareEnvironmentSelection(requested) {
    cardUpdates.invalidate("environment-status");
    const update = cardUpdates.begin("environment-transaction");
    const prepared = await import_electron.ipcRenderer.invoke("tweaker:prepare-environment", requested);
    if (!cardUpdates.isCurrent(update)) throw new Error("Environment preparation was superseded");
    const receipt = normalizeEnvironmentTransaction(prepared);
    if (!receipt) throw new Error("Environment preparation returned no transaction receipt");
    transaction = receipt;
    scheduleEnvironmentTransactionPoll();
    return receipt;
  }
  async function commitPreparedEnvironment(receipt) {
    cardUpdates.invalidate("environment-status");
    const update = cardUpdates.begin("environment-transaction");
    let result;
    try {
      result = await import_electron.ipcRenderer.invoke("tweaker:commit-environment", { transactionId: receipt.transactionId });
    } catch (error) {
      const detail = `Could not submit environment change: ${safeUiError(error)}`;
      transaction = { ...receipt, error: detail };
      scheduleEnvironmentTransactionPoll();
      throw new Error(detail);
    }
    if (!cardUpdates.isCurrent(update)) throw new Error("Environment coordinator submission was superseded");
    const submission = normalizeEnvironmentHelperSubmission(result);
    const observed = normalizeEnvironmentTransaction(result);
    transaction = submission ? {
      ...receipt,
      error: submission.error ?? null,
      helper: { ...receipt.helper ?? {}, submission }
    } : observed ?? receipt;
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
      const result = await import_electron.ipcRenderer.invoke("tweaker:cancel-environment", { transactionId: receipt.transactionId });
      if (!cardUpdates.isCurrent(update)) throw new Error("Environment cancellation was superseded");
      transaction = normalizeEnvironmentTransaction(result) ?? receipt;
      if (transaction.phase !== "cancelled") {
        throw new Error(`Environment cancellation returned ${transaction.phase}`);
      }
      scheduleEnvironmentTransactionPoll();
    } catch (error) {
      const detail = `Could not cancel environment transaction: ${safeUiError(error)}`;
      transaction = { ...receipt, error: detail };
      scheduleEnvironmentTransactionPoll();
      throw new Error(detail);
    }
  }
  const environmentController = createEnvironmentConfigController(
    { appExperience: "chatgpt", releaseProfile: "stable" },
    {
      prepare: prepareEnvironmentSelection,
      confirm: (requested, receipt) => openEnvironmentConfirmModal(requested, receipt),
      commit: commitPreparedEnvironment,
      cancel: cancelPreparedEnvironment
    },
    {
      onChange: (snapshot2) => {
        environmentActionError = snapshot2.error;
        if (card.isConnected) draw();
      }
    }
  );
  function openPreparedEnvironmentConfirmation(requested, receipt) {
    if (receipt.phase !== "prepared") return;
    void environmentController.resumePrepared(requested, receipt);
  }
  function cancelEnvironmentTransaction(receipt) {
    if (isEnvironmentBusy() || receipt.phase !== "preparing" && receipt.phase !== "prepared") return;
    environmentActionError = null;
    externalBusy = true;
    draw();
    void cancelPreparedEnvironment(receipt).then(() => {
      const selected = currentSelection();
      if (transaction?.phase === "cancelled" && selected) {
        environmentController.setSelected(selected);
      }
    }).catch((error) => {
      environmentActionError = safeUiError(error);
    }).finally(() => {
      externalBusy = false;
      draw();
    });
  }
  function recoverEnvironmentTransaction(receipt) {
    if (isEnvironmentBusy() || !environmentTransactionCanRecover(receipt)) return;
    environmentActionError = null;
    externalBusy = true;
    draw();
    void import_electron.ipcRenderer.invoke("tweaker:recover-environment", { transactionId: receipt.transactionId }).then((result) => {
      const next = normalizeEnvironmentTransaction(result) ?? receipt;
      transaction = next;
      environmentActionError = next.phase === "failed" ? `Could not recover the app mode safely: ${next.error ?? "the transaction is still failed"}` : null;
      externalBusy = false;
      draw();
      scheduleEnvironmentTransactionPoll();
    }).catch((error) => {
      environmentActionError = `Could not recover the app mode safely: ${safeUiError(error)}`;
      transaction = {
        ...receipt,
        error: environmentActionError
      };
      externalBusy = false;
      draw();
      scheduleEnvironmentTransactionPoll();
    });
  }
  function appendEnvironmentTransactionRow() {
    if (!transaction) return;
    const receipt = transaction;
    const requested = environmentTransactionRequestedSelection(receipt);
    const helperInFlight = environmentHelperIsInFlight(receipt);
    card.appendChild(environmentTransactionRow(receipt, {
      busy: isEnvironmentBusy(),
      onResume: receipt.phase === "prepared" && requested && !helperInFlight ? () => openPreparedEnvironmentConfirmation(requested, receipt) : void 0,
      onCancel: (receipt.phase === "preparing" || receipt.phase === "prepared") && !helperInFlight ? () => cancelEnvironmentTransaction(receipt) : void 0,
      onRecover: environmentTransactionCanRecover(receipt) ? () => recoverEnvironmentTransaction(receipt) : void 0
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
    const observationNeedsRepair = environment.observation !== void 0 && (observedExperience === null || observedExperience !== selected.appExperience || environment.observation.transitionJournalPresent);
    const environmentSelectionLocked = busy || observationNeedsRepair || transaction !== null && (!environmentTransactionIsTerminal(transaction.phase) || environmentTransactionCanRecover(transaction));
    if (observationNeedsRepair) {
      const detail = environment.observation?.transitionJournalPresent ? "A legacy mode transition is still present. Run tweaker repair in Terminal before switching." : observedExperience === null || observedExperience === void 0 ? "The live app marker could not be verified. Run tweaker repair in Terminal before switching." : `Saved mode is ${environmentExperienceLabel(selected.appExperience)}, but the live app proves ${environmentExperienceLabel(observedExperience)}. Run tweaker repair in Terminal.`;
      card.appendChild(rowSimple("Environment needs repair", detail));
    }
    const pendingAvailability = environmentSelectionAvailability(environment, pending);
    const chatgptAvailability = environmentSelectionAvailability(environment, {
      appExperience: "chatgpt",
      releaseProfile: pending.releaseProfile
    });
    const tweakersAvailability = environmentSelectionAvailability(environment, {
      appExperience: "tweakers",
      releaseProfile: pending.releaseProfile
    });
    card.appendChild(environmentChoiceRow(
      "App Mode",
      "ChatGPT disables every tweak. Tweakers restores the tweaks you previously enabled.",
      [
        {
          value: "chatgpt",
          label: "ChatGPT",
          description: chatgptAvailability.available ? "OpenAI's standard app experience." : environmentUnavailableReason(chatgptAvailability, "ChatGPT is unavailable for this release profile."),
          disabled: environmentSelectionLocked || !chatgptAvailability.available,
          disabledReason: environmentSelectionLocked ? "Finish, cancel, or recover the current environment transaction first." : environmentUnavailableReason(chatgptAvailability, "ChatGPT is unavailable for this release profile.")
        },
        {
          value: "tweakers",
          label: "Tweakers",
          description: tweakersAvailability.available ? "The standard app with enabled Tweakers features." : environmentUnavailableReason(tweakersAvailability, "Tweakers is unavailable for this release profile."),
          disabled: environmentSelectionLocked || !tweakersAvailability.available,
          disabledReason: environmentSelectionLocked ? "Finish, cancel, or recover the current environment transaction first." : environmentUnavailableReason(tweakersAvailability, "Tweakers is unavailable for this release profile.")
        }
      ],
      pending.appExperience,
      (value) => {
        environmentController.stageAppExperience(value);
      }
    ));
    const stableAvailability = environmentSelectionAvailability(environment, {
      appExperience: pending.appExperience,
      releaseProfile: "stable"
    });
    const alphaAvailability = environmentSelectionAvailability(environment, {
      appExperience: pending.appExperience,
      releaseProfile: "alpha"
    });
    const stableReason = environmentUnavailableReason(stableAvailability, "Stable is unavailable for this app experience.");
    const alphaReason = environmentUnavailableReason(alphaAvailability, "Alpha (Pre-release) is unavailable on this Mac.");
    card.appendChild(environmentChoiceRow(
      "Desktop Release",
      "Choose OpenAI's Stable or Alpha desktop app independently of app mode. Its embedded Codex backend can have a different version label.",
      [
        {
          value: "stable",
          label: "Stable",
          description: stableAvailability.available ? "The supported stable desktop release." : stableReason,
          disabled: environmentSelectionLocked || !stableAvailability.available,
          disabledReason: environmentSelectionLocked ? "Finish, cancel, or recover the current environment transaction first." : stableReason
        },
        {
          value: "alpha",
          label: "Alpha (Pre-release)",
          description: alphaAvailability.available ? "OpenAI's verified pre-release desktop and matching backend." : alphaReason,
          disabled: environmentSelectionLocked || !alphaAvailability.available,
          disabledReason: environmentSelectionLocked ? "Finish, cancel, or recover the current environment transaction first." : alphaReason
        }
      ],
      pending.releaseProfile,
      (value) => {
        environmentController.stageReleaseProfile(value);
      }
    ));
    if (!alphaAvailability.available) {
      const chooser = actionRow(
        "Alpha (Pre-release) unavailable",
        `${alphaReason} Choose a verified OpenAI Beta app to register it for this profile.`
      );
      const chooserActions = chooser.querySelector("[data-tweaker-row-actions]");
      const choose = compactButton("Choose Beta App\u2026", () => {
        if (isEnvironmentBusy()) return;
        externalBusy = true;
        environmentActionError = null;
        draw();
        void import_electron.ipcRenderer.invoke("tweaker:choose-alpha-environment").then((result) => {
          if (result && typeof result === "object" && "canceled" in result && result.canceled === true) return;
        }).catch((error) => {
          environmentActionError = `Could not register OpenAI Beta: ${safeUiError(error)}`;
        }).finally(() => {
          externalBusy = false;
          void load();
        });
      });
      choose.disabled = isEnvironmentBusy();
      chooserActions?.appendChild(choose);
      card.appendChild(chooser);
    }
    const summary = actionRow(
      "Pending changes",
      hasPendingChanges() ? pendingAvailability.available ? `${environmentExperienceLabel(pending.appExperience)} \xB7 ${environmentProfileLabel(pending.releaseProfile)} will apply after restart.` : `Unavailable: ${environmentUnavailableReason(pendingAvailability, "This environment cannot be prepared.")}` : `Current: ${environmentExperienceLabel(selected.appExperience)} \xB7 ${environmentProfileLabel(selected.releaseProfile)}.`
    );
    const actions = summary.querySelector("[data-tweaker-row-actions]");
    const apply = compactButton("Apply & Restart", () => {
      if (isEnvironmentBusy() || !hasPendingChanges()) return;
      environmentActionError = null;
      void environmentController.applyAndRestart().then((result) => {
        if (result.outcome === "prepare-failed") {
          environmentActionError = result.error;
        }
        if (result.outcome.endsWith("failed")) {
          draw();
        }
        void loadEnvironmentTransaction();
      });
    });
    apply.disabled = environmentSelectionLocked || !hasPendingChanges() || !pendingAvailability.available;
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
      const result = await import_electron.ipcRenderer.invoke("tweaker:get-environment-transaction");
      if (!cardUpdates.isCurrent(update) || !card.isConnected) return;
      lastTransactionFetchFailed = false;
      const previous = transaction;
      transaction = normalizeEnvironmentTransaction(result);
      if (transaction?.phase === "prepared" && !transaction.helper && previous?.transactionId === transaction.transactionId && previous.helper) {
        transaction = {
          ...transaction,
          error: transaction.error ?? previous.error,
          helper: previous.helper
        };
      }
      restorePersistedRequest();
      draw();
      if (transaction && environmentTransactionIsTerminal(transaction.phase)) {
        try {
          const statusUpdate = cardUpdates.begin("environment-status");
          const statusResult = await import_electron.ipcRenderer.invoke("tweaker:get-environment-status");
          if (!cardUpdates.isCurrent(update) || !cardUpdates.isCurrent(statusUpdate) || !card.isConnected) return;
          environment = normalizeEnvironmentStatus(statusResult) ?? environment;
          const selected = currentSelection();
          if (selected) environmentController.setSelected(selected);
          draw();
        } catch (error) {
          transaction = {
            ...transaction,
            error: transaction.error ?? `Could not refresh environment status: ${safeUiError(error)}`
          };
          draw();
        }
      }
    } catch (error) {
      if (!cardUpdates.isCurrent(update) || !card.isConnected) return;
      lastTransactionFetchFailed = true;
      if (transaction) {
        transaction = {
          ...transaction,
          error: `Could not refresh environment transaction: ${safeUiError(error)}`
        };
      }
      draw();
    } finally {
      if (cardUpdates.isCurrent(update)) scheduleEnvironmentTransactionPoll();
    }
  }
  const load = async () => {
    const statusUpdate = cardUpdates.begin("environment-status");
    const transactionUpdate = cardUpdates.begin("environment-transaction");
    try {
      const [statusResult, transactionResult] = await Promise.all([
        import_electron.ipcRenderer.invoke("tweaker:get-environment-status"),
        import_electron.ipcRenderer.invoke("tweaker:get-environment-transaction")
      ]);
      if (!card.isConnected) return;
      const statusIsCurrent = cardUpdates.isCurrent(statusUpdate);
      const transactionIsCurrent = cardUpdates.isCurrent(transactionUpdate);
      if (!statusIsCurrent && !transactionIsCurrent) return;
      if (statusIsCurrent) {
        environment = normalizeEnvironmentStatus(statusResult);
        if (environment?.selected) environmentController.setSelected(environment.selected);
      }
      if (transactionIsCurrent) {
        lastTransactionFetchFailed = false;
        transaction = normalizeEnvironmentTransaction(transactionResult);
        restorePersistedRequest();
      }
      draw();
      scheduleEnvironmentTransactionPoll();
    } catch (error) {
      if (!cardUpdates.isCurrent(statusUpdate) && !cardUpdates.isCurrent(transactionUpdate) || !card.isConnected) return;
      card.textContent = "";
      card.appendChild(rowSimple("Could not load environment", safeUiError(error)));
      lastTransactionFetchFailed = true;
      setTimeout(() => {
        if (card.isConnected) void load();
      }, 5e3);
    }
  };
  void load();
  return () => {
    cardUpdates.invalidate("environment-status");
    cardUpdates.invalidate("environment-transaction");
    if (transactionPolling) clearTimeout(transactionPolling);
    transactionPolling = null;
  };
}
function environmentTransactionRequestedSelection(transaction) {
  const requested = transaction.requested;
  if (!requested) return null;
  if (requested.appExperience !== "chatgpt" && requested.appExperience !== "tweakers") return null;
  if (requested.releaseProfile !== "stable" && requested.releaseProfile !== "alpha") return null;
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
    const button2 = document.createElement("button");
    button2.type = "button";
    button2.textContent = choice.label;
    button2.disabled = choice.disabled === true;
    button2.setAttribute("aria-pressed", String(choice.value === selected));
    if (choice.disabled) button2.setAttribute("aria-disabled", "true");
    if (choice.disabledReason) button2.title = choice.disabledReason;
    button2.className = `rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border ${choice.value === selected ? "bg-token-bg-primary shadow-sm text-token-text-primary" : "text-token-text-secondary hover:text-token-text-primary"}`;
    button2.addEventListener("click", () => onChange(choice.value));
    actions.appendChild(button2);
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
    unavailableReasons: channel.unavailableReasons
  };
}
function environmentUnavailableReason(availability, fallback) {
  return availability.unavailableReasons?.filter(Boolean).join(" ") || fallback;
}
function environmentProfileLabel(value) {
  return value === "alpha" ? "Alpha (Pre-release)" : "Stable";
}
function normalizeEnvironmentStatus(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  const selected = candidate.selected;
  if (!selected || selected.appExperience !== "chatgpt" && selected.appExperience !== "tweakers" || selected.releaseProfile !== "stable" && selected.releaseProfile !== "alpha") return null;
  const channels = candidate.channels;
  const rawObservation = candidate.observation;
  const observation = rawObservation && (rawObservation.appExperience === null || rawObservation.appExperience === "chatgpt" || rawObservation.appExperience === "tweakers") ? {
    appExperience: rawObservation.appExperience,
    selectionDrift: rawObservation.selectionDrift === true,
    lifecycleContended: rawObservation.lifecycleContended === true,
    commitJournalPresent: rawObservation.commitJournalPresent === true,
    transitionJournalPresent: rawObservation.transitionJournalPresent === true,
    freshness: rawObservation.freshness === "contended" ? "contended" : "current"
  } : void 0;
  return {
    schemaVersion: 1,
    selected,
    channels: {
      stable: channels?.stable ?? { available: true, releaseProfile: "stable" },
      alpha: channels?.alpha ?? { available: false, unavailableReasons: ["Alpha (Pre-release) availability was not reported."], releaseProfile: "alpha" }
    },
    ...observation ? { observation } : {}
  };
}
function normalizeEnvironmentTransaction(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  if (typeof candidate.transactionId !== "string" || typeof candidate.phase !== "string") return null;
  return {
    ...candidate,
    transactionId: candidate.transactionId,
    phase: candidate.phase,
    error: typeof candidate.error === "string" ? candidate.error : null
  };
}
function normalizeEnvironmentHelperSubmission(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  if (candidate.kind !== "environment-commit-helper") return null;
  if (typeof candidate.transactionId !== "string") return null;
  if (candidate.phase !== "submitted" && candidate.phase !== "submit-failed") return null;
  return {
    kind: "environment-commit-helper",
    transactionId: candidate.transactionId,
    phase: candidate.phase,
    error: typeof candidate.error === "string" ? candidate.error : null
  };
}
function environmentHelperIsInFlight(transaction) {
  const helper = transaction.helper;
  const outcomePhase = helper?.outcome?.phase;
  return outcomePhase === "not-started" || outcomePhase === "running" || helper?.submission?.phase === "submitted" && outcomePhase === void 0;
}
function environmentTransactionCanRecover(transaction) {
  if (transaction.phase === "failed") return transaction.prepared !== null && transaction.prepared !== void 0;
  return ["committing", "applying", "reopening", "verifying", "rolling-back"].includes(transaction.phase);
}
function environmentHelperFailureDetail(transaction) {
  const helper = transaction.helper;
  if (!helper) return null;
  const outcome = helper.outcome;
  const submission = helper.submission;
  const failed = outcome?.phase === "failed" || submission?.phase === "submit-failed" || typeof outcome?.error === "string" || typeof submission?.error === "string";
  if (!failed) return null;
  const stderr = environmentHelperLogSnippet(helper.stderr);
  const stdout = environmentHelperLogSnippet(helper.stdout);
  const exitCode = typeof outcome?.exitCode === "number" ? `exit ${outcome.exitCode}` : null;
  const detail = [
    "Environment helper failed",
    exitCode,
    outcome?.error,
    submission?.error,
    stderr ? `stderr: ${stderr}` : null,
    !stderr && stdout ? `stdout: ${stdout}` : null
  ].filter((value) => typeof value === "string" && value.length > 0);
  return [...new Set(detail)].join(" \xB7 ");
}
function environmentHelperLogSnippet(value) {
  if (typeof value !== "string") return null;
  const compact2 = value.trim().replace(/\s+/g, " ");
  if (!compact2) return null;
  return compact2.length <= 600 ? compact2 : `\u2026${compact2.slice(-599)}`;
}
function environmentTransactionRow(transaction, actionsConfig) {
  const helperFailure = environmentHelperFailureDetail(transaction);
  const ownerExited = transaction.ownerAlive === false && !environmentTransactionIsTerminal(transaction.phase);
  const details = [
    ownerExited ? "Owner process exited \u2014 recovery required." : null,
    environmentTransactionLabel(transaction.phase),
    transaction.error,
    helperFailure
  ].filter((value) => typeof value === "string" && value.length > 0);
  const row = actionRow(
    "App mode restart",
    [...new Set(details)].join(" \xB7 ")
  );
  const left = row.firstElementChild;
  if (left) {
    left.prepend(statusBadge(
      ownerExited ? "error" : environmentTransactionTone(transaction.phase),
      environmentTransactionLabel(transaction.phase)
    ));
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
  if (phase === "committed" || phase === "completed") return "ok";
  if (phase === "failed") return "error";
  return "warn";
}
function openEnvironmentConfirmModal(requested, transaction) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const restoreFocus = () => {
    restoreEnvironmentFocus(
      opener,
      () => document.querySelector("[data-tweaker-environment-card] button:not([disabled])")
    );
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
  const target = candidate?.desktopPath ? `${candidate.desktopPath}${candidate.version ? ` (${candidate.version}${candidate.build ? `, build ${candidate.build}` : ""})` : ""}` : environmentProfileLabel(requested.releaseProfile);
  const backendTarget = backend?.lane ? `${backend.lane}${backend.version ? ` ${backend.version}` : ""}` : "the verified backend for this environment";
  const rollbackTarget = rollback?.desktopPath ?? rollback?.selection?.selectedDesktopPath ?? "the last known working environment";
  const modeEffect = requested.appExperience === "tweakers" ? "ChatGPT will close, reopen in Tweakers mode, and restore your previously enabled tweaks." : "ChatGPT will close and reopen in standard mode. All tweaks will be disabled, but their saved settings will remain available for Tweakers mode.";
  body.textContent = [
    modeEffect,
    `Desktop: ${target}. Embedded Codex backend: ${backendTarget}.`,
    `If restart verification fails, Tweakers will restore the last known working environment at ${rollbackTarget}.`
  ].join("\n");
  body.style.whiteSpace = "pre-line";
  const buttons = document.createElement("div");
  buttons.className = "flex items-center justify-end gap-2";
  let settled = false;
  const close = (outcome) => {
    if (settled) return;
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
    if (event.key !== "Tab") return;
    const focusable = [cancel, confirm];
    const currentIndex = focusable.indexOf(document.activeElement);
    const nextIndex = event.shiftKey ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1 : currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
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
  const scheduleTransactionPoll = (delayMs = 2e3) => {
    if (polling) clearTimeout(polling);
    if (!card.isConnected || !transactionIsNonTerminal() && transaction?.resumable !== true && !transactionFetchFailed) return;
    polling = setTimeout(() => {
      polling = null;
      void loadTransaction();
    }, delayMs);
  };
  const loadTransaction = async () => {
    const update = cardUpdates.begin("desktop-update-transaction");
    try {
      const value = await import_electron.ipcRenderer.invoke("tweaker:get-codex-desktop-update-transaction");
      if (!cardUpdates.isCurrent(update) || !card.isConnected) return;
      transactionFetchFailed = false;
      const observed = normalizeDesktopUpdateTransaction(value);
      if (observed?.phase === "idle" && observed.transactionId === null && transaction?.phase === "preparing" && transaction.transactionId === null) {
        if (Date.now() >= awaitingTransactionReceiptUntil) {
          transaction = {
            transactionId: null,
            phase: "failed",
            error: "The desktop updater did not create a transaction receipt."
          };
        }
      } else {
        const idleWithoutReceipt = observed?.phase === "idle" && observed.transactionId === null;
        transaction = idleWithoutReceipt ? null : observed;
        if (transaction?.transactionId) awaitingTransactionReceiptUntil = 0;
      }
      transactionPollFailures = 0;
      draw();
      scheduleTransactionPoll();
    } catch (error) {
      if (!cardUpdates.isCurrent(update) || !card.isConnected) return;
      transactionFetchFailed = true;
      if (transaction) {
        transaction = {
          ...transaction,
          error: safeUiError(error)
        };
      }
      draw();
      transactionPollFailures += 1;
      const backoff = Math.min(3e4, 1e3 * 2 ** Math.min(transactionPollFailures - 1, 5));
      const jitter = Math.floor(backoff * 0.25 * Math.random());
      scheduleTransactionPoll(backoff + jitter);
    }
  };
  const draw = () => {
    card.textContent = "";
    const result = current;
    const installed = result?.installed?.marketingVersion ?? "Unavailable";
    const latest = result?.latest?.marketingVersion ?? "Unavailable";
    const status = desktopUpdateStatusPresentation(result?.status);
    const row = actionRow("ChatGPT Desktop", `Installed ${installed} \xB7 Latest ${latest}${result?.reason ? ` \xB7 ${result.reason}` : ""}`);
    const left = row.firstElementChild;
    left?.prepend(statusBadge(status.tone, status.label));
    const actions = row.querySelector("[data-tweaker-row-actions]");
    const check = compactButton("Check for Updates\u2026", () => {
      if (busy) return;
      busy = true;
      check.disabled = true;
      void import_electron.ipcRenderer.invoke("tweaker:check-codex-desktop-update").then((value) => {
        const result2 = value;
        acceptDesktopUpdateResult(result2);
        if (result2.updateAndReloadRequested) {
          awaitingTransactionReceiptUntil = Date.now() + 1e4;
          transaction = { transactionId: null, phase: "preparing" };
          void loadTransaction();
        }
      }).catch((error) => {
        current = { status: "error", reason: safeUiError(error) };
      }).finally(() => {
        busy = false;
        draw();
      });
    });
    check.disabled = busy || !!result?.setupRequired;
    actions?.appendChild(check);
    const update = compactButton("Update and Reload", () => {
      if (busy) return;
      busy = true;
      update.disabled = true;
      void import_electron.ipcRenderer.invoke("tweaker:start-codex-desktop-update").then(() => {
        awaitingTransactionReceiptUntil = Date.now() + 1e4;
        transaction = { transactionId: null, phase: "preparing" };
        void loadTransaction();
      }).catch((error) => {
        current = { status: "error", reason: safeUiError(error) };
      }).finally(() => {
        busy = false;
        draw();
      });
    });
    update.disabled = busy || result?.status !== "update-available" || transactionIsNonTerminal() || transaction?.resumable === true;
    actions?.appendChild(update);
    card.appendChild(row);
    if (result?.setupRequired) {
      const setupLabel = result.setupRequired === "register-beta" ? "Register OpenAI Beta" : "Launch OpenAI Beta once";
      card.appendChild(rowSimple(
        `Alpha update setup \xB7 ${setupLabel}`,
        result.reason ?? "Alpha update checks stay disabled until Tweakers captures the registered Beta app's own feed."
      ));
    }
    if (result?.checkedAt) card.appendChild(rowSimple("Last checked", new Date(result.checkedAt).toLocaleString()));
    if (transaction) card.appendChild(desktopUpdateTransactionRow(transaction, {
      busy,
      onResume: () => {
        if (busy) return;
        busy = true;
        draw();
        void import_electron.ipcRenderer.invoke("tweaker:resume-codex-desktop-update").then(() => {
          transaction = transaction ? { ...transaction, phase: "awaiting_native_update", resumable: false } : transaction;
          scheduleTransactionPoll();
        }).catch((error) => {
          if (transaction) transaction = { ...transaction, error: safeUiError(error) };
        }).finally(() => {
          busy = false;
          draw();
        });
      },
      onCancel: () => {
        if (busy) return;
        busy = true;
        draw();
        void import_electron.ipcRenderer.invoke("tweaker:cancel-codex-desktop-update").then((value) => {
          transaction = normalizeDesktopUpdateTransaction(value) ?? transaction;
        }).catch((error) => {
          if (transaction) transaction = { ...transaction, error: safeUiError(error) };
        }).finally(() => {
          busy = false;
          draw();
        });
      }
    }));
  };
  draw();
  const acceptDesktopUpdateResult = (value) => {
    const currentTime = current?.checkedAt ? Date.parse(current.checkedAt) : Number.NaN;
    const nextTime = value.checkedAt ? Date.parse(value.checkedAt) : Number.NaN;
    if (Number.isFinite(currentTime) && (!Number.isFinite(nextTime) || nextTime < currentTime)) return;
    current = value;
    draw();
  };
  const onDesktopUpdateChanged = (_event, value) => {
    if (!card.isConnected) {
      import_electron.ipcRenderer.removeListener("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
      return;
    }
    initialResultSuperseded = true;
    acceptDesktopUpdateResult(value);
  };
  import_electron.ipcRenderer.on("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
  const currentUpdate = cardUpdates.begin("desktop-update-result");
  void import_electron.ipcRenderer.invoke("tweaker:get-codex-desktop-update").then((value) => {
    if (!cardUpdates.isCurrent(currentUpdate) || !card.isConnected || initialResultSuperseded) return;
    if (value && typeof value === "object") {
      acceptDesktopUpdateResult(value);
    } else {
      current = { status: "unavailable", reason: "Update status has not been checked yet." };
      draw();
    }
  }).catch((error) => {
    if (!cardUpdates.isCurrent(currentUpdate) || !card.isConnected) return;
    current = { status: "error", reason: safeUiError(error) };
    draw();
  });
  void loadTransaction();
  return () => {
    cardUpdates.invalidate("desktop-update-result");
    cardUpdates.invalidate("desktop-update-transaction");
    import_electron.ipcRenderer.removeListener("tweaker:codex-desktop-update-changed", onDesktopUpdateChanged);
    if (polling) clearTimeout(polling);
    polling = null;
  };
}
function normalizeDesktopUpdateTransaction(value) {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  if (candidate.transactionId !== null && typeof candidate.transactionId !== "string") return null;
  if (typeof candidate.phase !== "string") return null;
  return {
    ...candidate,
    transactionId: candidate.transactionId ?? null,
    phase: candidate.phase
  };
}
function desktopUpdateTransactionRow(transaction, actions) {
  const phase = humanizeCodexPhase(transaction.phase);
  const nonTerminal = !["completed", "failed", "rolled_back"].includes(transaction.phase);
  const ownerExited = nonTerminal && transaction.ownerAlive === false;
  const detail = [
    ownerExited ? "Owner process exited \u2014 recovery required." : null,
    transaction.transactionId ? `Transaction ${transaction.transactionId}` : null,
    transaction.safeOfficialMode ? "Official ChatGPT is active" : null,
    transaction.refreshSource ? `${transaction.refreshSource} Tweakers refresh` : null,
    typeof transaction.terminalAt === "string" ? `Terminal at ${new Date(transaction.terminalAt).toLocaleString()}` : transaction.updatedAt ? `Last update at ${new Date(transaction.updatedAt).toLocaleString()}` : null,
    transaction.error ?? null
  ].filter(Boolean).join(" \xB7 ") || "Waiting for the durable updater receipt.";
  const row = actionRow("Update and Reload", detail);
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  const left = row.firstElementChild;
  const tone = transaction.phase === "completed" ? "ok" : ownerExited || transaction.phase === "failed" && !transaction.resumable ? "error" : "warn";
  left?.prepend(statusBadge(tone, phase));
  const controls = row.querySelector("[data-tweaker-row-actions]");
  const canResume = transaction.resumable === true && (transaction.phase === "failed" || transaction.phase === "rolled_back");
  const deadOwnerRecoverable = ownerExited && ["switching_to_chatgpt", "returning_to_tweakers", "refreshing_runtime", "verifying", "preparing"].includes(transaction.phase);
  const canCancel = transaction.phase === "awaiting_native_update" || transaction.resumable === true && ["failed", "rolled_back"].includes(transaction.phase) || deadOwnerRecoverable;
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
  const render = (snapshot2) => {
    card.textContent = "";
    const missingCount = snapshot2.missingLiveCount + snapshot2.missingRuntimeCount;
    const totalProblems = snapshot2.liveDriftCount + snapshot2.runtimeDriftCount + missingCount + (snapshot2.mcpRestartRequired ? 1 : 0);
    const summary = actionRow(
      "Installed Tweaks",
      `${snapshot2.installedCount} installed \xB7 ${snapshot2.enabledCount} enabled \xB7 ${snapshot2.catalogCount} latest stored catalog entries.`
    );
    summary.querySelector("[data-tweaker-row-actions]")?.appendChild(
      statusBadge(totalProblems === 0 ? "ok" : "warn", totalProblems === 0 ? "Current" : "Review")
    );
    card.appendChild(summary);
    if (totalProblems === 0) {
      card.appendChild(rowSimple(
        "Version Drift",
        "All installed live copies and bundled runtime copies match the latest stored catalog versions."
      ));
    } else {
      card.appendChild(rowSimple(
        "Version Drift",
        [
          `${snapshot2.liveDriftCount} outdated live ${snapshot2.liveDriftCount === 1 ? "copy" : "copies"}`,
          `${snapshot2.runtimeDriftCount} outdated runtime ${snapshot2.runtimeDriftCount === 1 ? "copy" : "copies"}`,
          `${missingCount} missing ${missingCount === 1 ? "copy" : "copies"}`,
          snapshot2.mcpRestartRequired ? "MCP restart required" : null
        ].filter(Boolean).join(" \xB7 ")
      ));
      for (const row of snapshot2.rows.filter((candidate) => candidate.status !== "current")) {
        card.appendChild(tweakHealthDriftRow(row));
      }
    }
    if (snapshot2.mcpRestartRequired) {
      card.appendChild(rowSimple(
        "MCP Process State",
        "The managed MCP config changed. Start a new task or restart Codex to replace already-running MCP processes."
      ));
    }
    card.appendChild(rowSimple("Last checked", new Date(snapshot2.checkedAt).toLocaleString()));
  };
  const update = cardUpdates.begin("tweaks-health");
  void import_electron.ipcRenderer.invoke("tweaker:get-tweaks-health").then((value) => {
    if (!card.isConnected || !cardUpdates.complete(update, value)) return;
    render(value);
  }).catch((error) => {
    if (!card.isConnected || !cardUpdates.complete(update, error)) return;
    card.textContent = "";
    card.appendChild(rowSimple("Tweaks health unavailable", safeUiError(error)));
  });
  return () => {
    cardUpdates.invalidate("tweaks-health");
  };
}
function tweakHealthDriftRow(drift) {
  const row = actionRow(
    drift.name,
    `${drift.reason} Live: ${drift.liveVersion ?? "missing"} \xB7 Runtime: ${drift.runtimeVersion ?? "missing"} \xB7 Latest stored: ${drift.catalogVersion ?? "missing"}.`
  );
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-tweaker-row-actions]");
  actions?.appendChild(statusBadge(drift.status === "missing" ? "error" : "warn", drift.status === "missing" ? "Missing" : "Outdated"));
  if (drift.enabled) actions?.appendChild(codexNeutralBadge("Enabled"));
  if (drift.hasMcp) actions?.appendChild(codexNeutralBadge("MCP"));
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
  const render = (state2) => {
    card.textContent = "";
    if (!state2) {
      state2 = {
        status: "pending",
        summary: "Managed MCP reconciliation has not completed yet."
      };
    }
    const status = state2.status ?? (state2.error ? "error" : "ok");
    const tone = status === "error" || state2.error ? "error" : status === "conflict" || status === "warn" || status === "pending" ? "warn" : "ok";
    const row = actionRow("MCP integration", state2.summary ?? state2.error ?? (tone === "ok" ? "MCP configuration is synchronized." : "MCP configuration needs attention."));
    const left = row.firstElementChild;
    left?.prepend(statusBadge(tone, status === "ok" ? "Healthy" : humanizeCodexPhase(status)));
    const actions = row.querySelector("[data-tweaker-row-actions]");
    const repair = compactButton("Repair", () => {
      repair.disabled = true;
      const update = cardUpdates.begin("mcp");
      void import_electron.ipcRenderer.invoke("tweaker:repair-mcp").then((next) => {
        if (cardUpdates.complete(update, next)) render(next);
      }).catch((error) => {
        const next = { status: "error", error: safeUiError(error) };
        if (cardUpdates.complete(update, next)) render(next);
      });
    });
    actions?.appendChild(repair);
    card.appendChild(row);
    if (state2.restartRequired) {
      card.appendChild(rowSimple(
        "New task or restart required",
        "The canonical MCP name is written. Start a new task, or restart Codex, to replace any already-running legacy MCP process."
      ));
    }
    if (state2.conflicts?.length) {
      card.appendChild(rowSimple("Conflicts", state2.conflicts.map((conflict) => {
        if (conflict.observedName || conflict.canonicalName) {
          return `${conflict.observedName ?? "Unknown entry"} \u2192 ${conflict.canonicalName ?? "canonical entry"}: ${conflict.reason ?? conflict.detail ?? "ownership conflict"}`;
        }
        return conflict.detail ?? conflict.reason ?? conflict.name ?? "Unknown conflict";
      }).join("; ")));
    }
    const checkedAt = state2.completedAt ?? state2.checkedAt;
    if (checkedAt) card.appendChild(rowSimple("Last checked", new Date(checkedAt).toLocaleString()));
  };
  const onSyncStateChanged = (_event, value) => {
    if (!card.isConnected) {
      import_electron.ipcRenderer.removeListener("tweaker:mcp-sync-state-changed", onSyncStateChanged);
      return;
    }
    const update = cardUpdates.begin("mcp");
    const next = value && typeof value === "object" ? value : null;
    if (cardUpdates.complete(update, next)) render(next);
  };
  import_electron.ipcRenderer.on("tweaker:mcp-sync-state-changed", onSyncStateChanged);
  const initialUpdate = cardUpdates.begin("mcp");
  void import_electron.ipcRenderer.invoke("tweaker:get-mcp-sync-state").then((value) => {
    const next = value && typeof value === "object" ? value : null;
    if (card.isConnected && cardUpdates.complete(initialUpdate, next)) render(next);
  }).catch((error) => {
    const next = { status: "error", error: safeUiError(error) };
    if (card.isConnected && cardUpdates.complete(initialUpdate, next)) render(next);
  });
  return () => {
    cardUpdates.invalidate("mcp");
    import_electron.ipcRenderer.removeListener("tweaker:mcp-sync-state-changed", onSyncStateChanged);
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
        summary: "Repair was started in the background. Waiting for a completed watcher cycle\u2026"
      }, false);
      const running = actionRow("Automatic maintenance", "Repair cycle running\u2026");
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
        summary: "The watcher completed a fresh repair cycle."
      };
    } else if (repairDisplay === "failure") {
      health = {
        ...health,
        status: "error",
        title: "Automatic maintenance failed",
        summary: health.summary || "The watcher repair cycle failed."
      };
    }
    renderWatcherHealth(card, health, true, startRepair);
  };
  const load = () => {
    const update = cardUpdates.begin("watcher");
    return import_electron.ipcRenderer.invoke("tweaker:get-watcher-health").then((value) => {
      const health = value;
      if (!card.isConnected || !cardUpdates.complete(update, health)) return null;
      render(health);
      return health;
    }).catch((error) => {
      const health = { checkedAt: (/* @__PURE__ */ new Date()).toISOString(), status: "error", title: "Automatic maintenance unavailable", summary: safeUiError(error), watcher: "Watcher", checks: [] };
      if (!card.isConnected || !cardUpdates.complete(update, health)) return null;
      render(health);
      return health;
    });
  };
  const isNewerCycle = (health) => {
    const cycle = health.latestCompletedCycle;
    if (!cycle) return false;
    if (!repairBaselineCycle) {
      return Date.parse(cycle.completedAt) > repairStartedAt;
    }
    return cycle.cycleId !== repairBaselineCycle.cycleId && cycle.completedAt > repairBaselineCycle.completedAt;
  };
  const finishRepair = (health, failed = false) => {
    repairInFlight = false;
    repairDisplay = failed ? "failure" : "success";
    if (repairPoll) clearTimeout(repairPoll);
    repairPoll = null;
    const next = failed ? { ...health, status: "error", title: "Automatic maintenance failed", summary: health.summary || "The watcher repair cycle failed." } : health;
    render(next);
  };
  const pollRepair = () => {
    if (!repairInFlight || !card.isConnected) return;
    if (repairPollCount++ >= MAX_REPAIR_POLLS) {
      finishRepair({
        ...latestHealth ?? { checkedAt: (/* @__PURE__ */ new Date()).toISOString(), status: "error", title: "Automatic maintenance failed", summary: "The watcher did not report a completed cycle in time.", watcher: "Watcher", checks: [] },
        status: "error",
        title: "Automatic maintenance failed",
        summary: "The watcher did not report a completed cycle in time."
      }, true);
      return;
    }
    void load().then((health) => {
      if (!health || !repairInFlight) return;
      const cycle = health.latestCompletedCycle;
      if (isNewerCycle(health)) {
        finishRepair(health, cycle?.outcome === "failed" || cycle?.repair.status === "failed");
        return;
      }
      render(health);
      repairPoll = setTimeout(pollRepair, 1e3);
    });
  };
  const startRepair = () => {
    if (repairInFlight) return;
    repairInFlight = true;
    repairDisplay = "idle";
    repairBaselineCycle = latestHealth?.latestCompletedCycle ?? null;
    repairStartedAt = Date.now();
    repairPollCount = 0;
    render(latestHealth ?? { checkedAt: (/* @__PURE__ */ new Date()).toISOString(), status: "warn", title: "Automatic maintenance running", summary: "Starting repair\u2026", watcher: "Watcher", checks: [] });
    void import_electron.ipcRenderer.invoke("tweaker:repair-auto-maintenance").then(() => pollRepair()).catch((error) => finishRepair({
      ...latestHealth ?? { checkedAt: (/* @__PURE__ */ new Date()).toISOString(), status: "error", title: "Automatic maintenance failed", summary: "", watcher: "Watcher", checks: [] },
      status: "error",
      title: "Automatic maintenance failed",
      summary: safeUiError(error)
    }, true));
  };
  load();
  return () => {
    cardUpdates.invalidate("watcher");
    repairInFlight = false;
    if (repairPoll) clearTimeout(repairPoll);
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
  const refresh = compactButton("Refresh", () => {
    void load(true);
  });
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
  } else {
    section.appendChild(card);
  }
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
    card.textContent = "";
    renderCodexVersionsCard(card, snapshot2, requestReload);
    schedulePoll(snapshot2);
  };
  async function load(force) {
    const current = ++generation;
    refresh.disabled = true;
    try {
      const snapshot2 = await import_electron.ipcRenderer.invoke(
        force ? "tweaker:refresh-codex-versions" : "tweaker:get-codex-versions"
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
  card.appendChild(codexActiveCliRow(snapshot2));
  card.appendChild(codexEmbeddedCliRow(bundled, snapshot2));
  card.appendChild(codexLatestStableReleaseRow(bundled));
  card.appendChild(codexCliRow("Managed Alpha CLI (Pre-release)", "beta", beta, snapshot2, busy, reload));
  card.appendChild(codexRuntimeRow(snapshot2));
  const releases = actionRow("GitHub Releases", "View official OpenAI Codex release notes and packages.");
  makeCodexRowResponsive(releases);
  releases.querySelector("[data-tweaker-row-actions]")?.appendChild(
    compactButton("Open Releases", () => openCodexGithubUrl("https://github.com/openai/codex/releases"))
  );
  card.appendChild(releases);
  if (snapshot2.installProgress && snapshot2.installProgress.phase && snapshot2.installProgress.phase !== "idle") {
    const p = snapshot2.installProgress;
    const amount = formatBytes(p.bytes);
    const detail = p.error || [humanizeCodexPhase(p.phase), p.version, amount].filter(Boolean).join(" \xB7 ");
    card.appendChild(rowSimple("Alpha operation", detail));
  }
  const stateMessage = codexRuntimeMessage(snapshot2);
  if (stateMessage) card.appendChild(rowSimple("Runtime status", stateMessage));
  card.appendChild(codexFeatureBrowser(snapshot2, busy, reload));
}
function codexActiveCliRow(snapshot2) {
  const active = snapshot2.activeCli;
  const version = active.version ?? "Unavailable";
  const channel = codexVersionChannelLabel(active.versionChannel);
  const source = active.source === "bundled" ? `${channel} \xB7 embedded in the OpenAI desktop app \xB7 app-managed` : active.source === "managed-alpha" ? `${channel} \xB7 managed by Tweakers` : `${channel} \xB7 external CODEX_CLI_PATH override`;
  const detail = [`Version ${version}`, source, active.path, active.error].filter(Boolean).join(" \xB7 ");
  const row = actionRow("Active Codex backend", detail);
  makeCodexRowResponsive(row);
  row.title = active.path;
  row.querySelector("[data-tweaker-row-actions]")?.appendChild(
    statusBadge(active.available ? "ok" : "error", active.available ? "Active" : "Unavailable")
  );
  return row;
}
function codexEmbeddedCliRow(cli, snapshot2) {
  const version = cli.version ?? "Unavailable";
  const channel = codexVersionChannelLabel(cli.versionChannel);
  const detail = [
    `Version ${version}`,
    channel,
    "Embedded in the OpenAI desktop app; it changes only when OpenAI ships a desktop update",
    cli.path,
    cli.available ? null : cli.error
  ].filter(Boolean).join(" \xB7 ");
  const row = actionRow("Desktop-Embedded Codex CLI", detail);
  makeCodexRowResponsive(row);
  row.title = cli.path ?? "";
  const actions = row.querySelector("[data-tweaker-row-actions]");
  if (snapshot2.activeCli.source === "bundled") actions?.appendChild(statusBadge("ok", "Active"));
  else actions?.appendChild(codexNeutralBadge("App-managed"));
  if (cli.version) {
    const releaseUrl = `https://github.com/openai/codex/releases/tag/rust-v${encodeURIComponent(cli.version)}`;
    actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(releaseUrl)));
  }
  return row;
}
function codexLatestStableReleaseRow(cli) {
  const release = cli.release;
  const detail = release ? `Latest stable standalone release ${release.version} \xB7 This does not replace the desktop-embedded backend.` : `Latest stable standalone release unavailable${cli.error ? ` \xB7 ${cli.error}` : ""}`;
  const row = actionRow("Latest Stable CLI Release", detail);
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-tweaker-row-actions]");
  actions?.appendChild(codexNeutralBadge("Stable"));
  if (isSafeCodexGithubUrl(release?.releaseUrl)) {
    actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(release.releaseUrl)));
  }
  return row;
}
function codexCliRow(label, lane, cli, snapshot2, busy, reload) {
  const installed = cli.managedCurrentVersion ?? cli.version;
  const latest = cli.release?.version;
  const detail = installedLatestSummary(installed, latest, cli.error || cli.release?.error);
  const row = actionRow(label, detail);
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-tweaker-row-actions]");
  if (snapshot2.effectiveLane === lane) actions?.prepend(statusBadge("ok", "Active"));
  const releaseUrl = cli.release?.releaseUrl;
  if (isSafeCodexGithubUrl(releaseUrl)) actions?.appendChild(compactButton("Release", () => openCodexGithubUrl(releaseUrl)));
  if (lane === "beta") {
    const installLabel = installed && latest && installed !== latest ? "Update" : installed ? "Reinstall" : "Install";
    const install = compactButton(installLabel, () => runCodexAction(row, "tweaker:install-codex-beta", void 0, reload));
    install.disabled = busy || !latest;
    actions?.appendChild(install);
    const previousVersion = cli.managedPreviousVersion;
    if (previousVersion) {
      const rollback = compactButton(`Rollback to ${previousVersion}`, () => runCodexAction(row, "tweaker:rollback-codex-beta", void 0, reload));
      rollback.disabled = busy;
      actions?.appendChild(rollback);
    }
  }
  return row;
}
function codexRuntimeRow(snapshot2) {
  const requested = snapshot2.requestedLane;
  const selected = requested ? requested === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded (app-managed)" : snapshot2.userOverridePreserved ? "External override" : "Not explicitly selected";
  const active = snapshot2.activeCli.source === "managed-alpha" ? "Managed Alpha" : snapshot2.activeCli.source === "bundled" ? "Desktop-embedded" : "External override";
  const activeChannel = codexVersionChannelLabel(snapshot2.activeCli.versionChannel);
  const activeVersion = snapshot2.activeCli.version ? ` ${snapshot2.activeCli.version}` : "";
  const row = actionRow(
    "Selected runtime",
    `Selected: ${selected}. Active: ${active}${activeVersion} \xB7 ${activeChannel}. Desktop profile and CLI release channel are reported separately.`
  );
  makeCodexRowResponsive(row);
  const actions = row.querySelector("[data-tweaker-row-actions]");
  actions?.appendChild(codexNeutralBadge("Managed by Environment"));
  return row;
}
function codexFeatureBrowser(snapshot2, busy, reload) {
  const wrapper = document.createElement("div");
  wrapper.className = "p-3";
  const details = document.createElement("details");
  details.dataset.tweakerFeatureBrowser = "true";
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
        await import_electron.ipcRenderer.invoke("tweaker:set-codex-feature", { lane, name: feature.name, enabled: next });
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
  row.querySelector("[data-tweaker-row-actions]")?.classList.add("flex-wrap", "justify-end");
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
  if (snapshot2.fallbackReason) return `Managed Alpha could not start; the desktop-embedded backend was used. ${snapshot2.fallbackReason}`;
  if (snapshot2.restartRequired) return "Restart the app to apply the selected Codex runtime.";
  if (snapshot2.requestedLane && snapshot2.effectiveLane && snapshot2.requestedLane !== snapshot2.effectiveLane) {
    return `${snapshot2.requestedLane === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded"} is selected; ${snapshot2.effectiveLane === "beta" ? "Managed Alpha (Pre-release)" : "Desktop-embedded"} remains active until restart.`;
  }
  return null;
}
function codexVersionChannelLabel(channel) {
  if (channel === "stable") return "Stable";
  if (channel === "prerelease") return "Pre-release";
  return "Unknown release channel";
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
  void import_electron.ipcRenderer.invoke("tweaker:open-external", url).catch((error) => plog("open Codex release failed", String(error)));
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
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatBytes(value) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function renderTweakerConfig(card, config) {
  setSidebarTweakerUpdateButton(config.updateCheck);
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
      await import_electron.ipcRenderer.invoke("tweaker:set-auto-update", next);
    })
  );
  return row;
}
function updateChannelRow(config) {
  const row = actionRow("Release channel", updateChannelSummary(config));
  const action = row.querySelector("[data-tweaker-row-actions]");
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
    void import_electron.ipcRenderer.invoke("tweaker:set-update-config", { updateChannel: select.value }).then(() => refreshConfigCard(row)).catch((e) => plog("set update channel failed", String(e)));
  });
  action?.appendChild(select);
  if (config.updateChannel === "custom") {
    action?.appendChild(
      compactButton("Edit", () => {
        const repo = window.prompt("GitHub repo", config.updateRepo || "therealityreport/tweakers");
        if (repo === null) return;
        const ref = window.prompt("Git ref", config.updateRef || "main");
        if (ref === null) return;
        void import_electron.ipcRenderer.invoke("tweaker:set-update-config", {
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
        void import_electron.ipcRenderer.invoke("tweaker:open-external", check.releaseUrl);
      })
    );
  }
  actions.appendChild(
    compactButton("Check Now", () => {
      row.style.opacity = "0.65";
      void import_electron.ipcRenderer.invoke("tweaker:check-tweaker-update", true).then((check2) => {
        setSidebarTweakerUpdateButton(check2);
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
      void import_electron.ipcRenderer.invoke("tweaker:run-tweaker-update").then(() => {
        refreshSidebarTweakerUpdateButton(true);
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
  void import_electron.ipcRenderer.invoke("tweaker:get-watcher-health").then((health) => {
    card.textContent = "";
    renderWatcherHealth(card, health);
  }).catch((e) => {
    card.textContent = "";
    card.appendChild(rowSimple("Could not check watcher", String(e)));
  });
}
function renderWatcherHealth(card, health, includeRepair = false, onRepair) {
  card.appendChild(watcherSummaryRow(health));
  for (const check of health.checks) {
    if (check.status === "ok") continue;
    card.appendChild(watcherCheckRow(check));
  }
  if (includeRepair) {
    const row = actionRow(
      "Automatic maintenance",
      health.status === "ok" ? "The watcher is healthy and will continue checking automatically." : "Repair the watcher registration and run a fresh health check."
    );
    const actions = row.querySelector("[data-tweaker-row-actions]");
    actions?.appendChild(compactButton("Repair Now", onRepair ?? (() => {
      const button2 = actions.querySelector("button");
      if (button2) button2.disabled = true;
      void import_electron.ipcRenderer.invoke("tweaker:repair-auto-maintenance").then(() => import_electron.ipcRenderer.invoke("tweaker:get-watcher-health")).then((next) => {
        card.textContent = "";
        renderWatcherHealth(card, next, true);
      }).catch((error) => {
        card.textContent = "";
        renderWatcherHealth(card, {
          ...health,
          status: "error",
          title: "Automatic maintenance repair failed",
          summary: safeUiError(error)
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
  const card = row.closest("[data-tweaker-config-card]");
  if (!card) return;
  card.textContent = "";
  card.appendChild(rowSimple("Refreshing", "Loading current Tweakers update status."));
  void import_electron.ipcRenderer.invoke("tweaker:get-config").then((config) => {
    card.textContent = "";
    renderTweakerConfig(card, config);
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
  const action = row.querySelector("[data-tweaker-row-actions]");
  action?.appendChild(
    compactButton("Copy Command", () => {
      void import_electron.ipcRenderer.invoke("tweaker:copy-text", "node ~/.tweaker/source/packages/installer/dist/cli.js uninstall").catch((e) => plog("copy uninstall command failed", String(e)));
    })
  );
  return row;
}
function reportBugRow() {
  const row = actionRow(
    "Report a bug",
    "Open a GitHub issue with runtime, installer, or tweak-manager details."
  );
  const action = row.querySelector("[data-tweaker-row-actions]");
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
        "tweaker:open-external",
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
    grid.dataset.tweakerStore = JSON.stringify(store);
    renderTweakStoreGrid(grid, source);
  }).catch((e) => {
    grid.dataset.tweakerStore = "";
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
  const promise = import_electron.ipcRenderer.invoke("tweaker:get-tweak-store").then((store) => {
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
  const raw = grid.dataset.tweakerStore;
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
        void import_electron.ipcRenderer.invoke("tweaker:open-external", entry.releaseUrl);
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
      const grid = card.closest("[data-tweaker-store-grid]");
      const source = grid?.parentElement?.querySelector("[data-tweaker-store-source]");
      showStoreButtonLoading(button2, entry.installed ? "Updating" : "Installing");
      actions.querySelectorAll("button").forEach((button3) => button3.disabled = true);
      void import_electron.ipcRenderer.invoke("tweaker:install-store-tweak", entry.id).then(() => {
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
  card.querySelector("[data-tweaker-store-card-message]")?.remove();
  const notice = document.createElement("div");
  notice.dataset.tweakerStoreCardMessage = "true";
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
    void import_electron.ipcRenderer.invoke("tweaker:open-external", `https://github.com/${repo}`);
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
  btn.dataset.tweakerSidebarUpdate = "true";
  btn.className = "user-select-none no-drag cursor-interaction inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-token-charts-blue text-white hover:bg-token-charts-blue/80";
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
    textTransform: "none"
  });
  btn.textContent = "Update";
  btn.title = "Open Tweakers update";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void import_electron.ipcRenderer.invoke("tweaker:open-external", btn.dataset.tweakerReleaseUrl || TWEAKERS_RELEASES_URL);
  });
  return btn;
}
function refreshSidebarTweakerUpdateButton(force = false) {
  const btn = state.tweakerUpdateButton;
  if (!btn) return;
  void import_electron.ipcRenderer.invoke("tweaker:check-tweaker-update", force).then((check) => setSidebarTweakerUpdateButton(check)).catch((e) => {
    plog("Tweakers sidebar release check failed", String(e));
    setSidebarTweakerUpdateButton(null);
  });
}
function setSidebarTweakerUpdateButton(check) {
  const btn = state.tweakerUpdateButton;
  if (!btn) return;
  const updateAvailable = check?.updateAvailable === true;
  btn.style.display = updateAvailable ? "inline-flex" : "none";
  btn.hidden = !updateAvailable;
  btn.dataset.tweakerReleaseUrl = check?.releaseUrl || TWEAKERS_RELEASES_URL;
  btn.title = updateAvailable && check?.latestVersion ? `Open Tweakers ${check.latestVersion} update` : "Open Tweakers update";
}
function updateStoreUpdateBadge(count) {
  const badge = document.querySelector("[data-tweaker-store-update-badge]");
  if (!badge) return;
  badge.dataset.tweakerStoreUpdateCount = count === null ? "" : String(count);
  applyStoreUpdateBadgeStyle(badge, count);
  badge.hidden = count === null || count <= 0;
  badge.textContent = count && count > 0 ? String(count) : "";
  badge.title = count && count > 0 ? `${count} installed tweak${count === 1 ? "" : "s"} can be updated` : "Installed tweaks are up to date";
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
    letterSpacing: "0"
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
  let host = document.querySelector("[data-tweaker-store-toast-host]");
  if (!host) {
    host = document.createElement("div");
    host.dataset.tweakerStoreToastHost = "true";
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
  searchLabel.htmlFor = "tweaker-tweaks-search";
  searchLabel.textContent = "Search tweaks";
  const searchInput = document.createElement("input");
  searchInput.id = "tweaker-tweaks-search";
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
        void import_electron.ipcRenderer.invoke("tweaker:reload-tweaks").catch((e) => plog("force reload (main) failed", String(e))).finally(() => location.reload());
      }
    },
    {
      label: "Open Tweaks Folder",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("tweaker:reveal", tweaksPath());
      }
    }
  ]);
  toolbarActions.appendChild(globalMenu.element);
  const list = document.createElement("div");
  list.id = "tweaker-tweaks-list";
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
      button2.id = `tweaker-tweaks-filter-${filter}`;
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
    list.setAttribute("aria-labelledby", `tweaker-tweaks-filter-${state.tweaksPageFilter}`);
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
        void import_electron.ipcRenderer.invoke("tweaker:open-external", tweak.update.releaseUrl);
      }
    });
  }
  rowMenuItems.push({
    label: "Open Repository",
    onSelect: () => {
      void import_electron.ipcRenderer.invoke("tweaker:open-external", `https://github.com/${manifest.githubRepo}`);
    }
  });
  if (manifest.homepage && manifest.homepage !== `https://github.com/${manifest.githubRepo}`) {
    rowMenuItems.push({
      label: "Open Homepage",
      onSelect: () => {
        void import_electron.ipcRenderer.invoke("tweaker:open-external", manifest.homepage);
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
        void import_electron.ipcRenderer.invoke("tweaker:install-store-tweak", manifest.id).then(() => location.reload()).catch((e) => plog("catalog install failed", String(e)));
      }));
    }
  } else if (tweak.status === "quarantined") {
    actions.appendChild(compactButton("Recover", () => {
      void import_electron.ipcRenderer.invoke("tweaker:recover-tweak", manifest.id).catch((e) => plog("tweak recovery failed", String(e)));
    }));
  } else {
    if (tweak.status === "failed") {
      actions.appendChild(compactButton("Retry", () => {
        void import_electron.ipcRenderer.invoke("tweaker:clear-tweak-health", manifest.id).catch((e) => plog("clear tweak health failed", String(e)));
        void import_electron.ipcRenderer.invoke("tweaker:reload-tweaks").catch((e) => plog("tweak retry failed", String(e)));
      }));
    }
    const toggle = switchControl(tweak.enabled, async (next) => {
      await import_electron.ipcRenderer.invoke("tweaker:set-tweak-enabled", manifest.id, next);
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
  const existing = document.querySelector("[data-tweaker-publish-dialog]");
  existing?.remove();
  const overlay = document.createElement("div");
  overlay.dataset.tweakerPublishDialog = "true";
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
      "tweaker:prepare-tweak-store-submission",
      repoInput.value
    );
    const url = buildTweakPublishIssueUrl(submission);
    await import_electron.ipcRenderer.invoke("tweaker:open-external", url);
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
      "tweaker:read-tweak-asset",
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
    if (candidate.dataset.tweaker) continue;
    if (!isSettingsSidebarCandidate(candidate)) continue;
    const labels = tweakerSettingsLabelsFrom(candidate);
    const score = tweakerSettingsLabelScore(labels);
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
  "[data-tweaker-slash-menu='true']",
  "[data-tweaker-overlay-noise='true']",
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
  const rect = tweakerVisibleBox(el);
  if (!rect) return false;
  if (rect.width < 120 || rect.width > 620) return false;
  if (rect.height < 80) return false;
  if (rect.left > window.innerWidth * 0.65) return false;
  const labels = tweakerSettingsLabelsFrom(el);
  if (hasMainAppSidebarSignals(labels) && !hasTweakerSettingsOnlySignal(labels)) {
    return false;
  }
  return isTweakerSettingsLabelSet(labels);
}
function removeMisplacedSettingsGroups() {
  const groups = document.querySelectorAll(
    "[data-tweaker='nav-group'], [data-tweaker='pages-group'], [data-tweaker='native-nav-header']"
  );
  for (const group of Array.from(groups)) {
    if (isTweakerInjectedSettingsGroupPlacementValid(group)) continue;
    resetTweakerInjectedSettingsGroupState(group);
    group.remove();
  }
}
function isTweakerInjectedSettingsGroupPlacementValid(group) {
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
function resetTweakerInjectedSettingsGroupState(group) {
  if (state.navGroup === group || state.navGroup && group.contains(state.navGroup)) {
    state.navGroup = null;
    state.navButtons = null;
    state.tweakerUpdateButton = null;
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
      if (child.dataset.tweaker === "tweaks-panel") continue;
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
  return window.__tweaker_tweaks_dir__ ?? "<user dir>/tweaks";
}

// src/preload/tweak-host.ts
var import_electron2 = require("electron");

// src/preload/host-surfaces.ts
var MAX_MATCHES = 100;
var MAX_MCP_FIBER_DEPTH = 128;
var MAX_MCP_SCHEMA_PROPERTIES = 128;
var MAX_MCP_IDENTITY_LENGTH = 512;
var MAX_MCP_VISIBILITY_ANCESTORS = 128;
var MCP_CARRIER_IDENTITY_KEYS = ["elicitation", "requestId", "conversationId", "hostId"];
var MCP_CARRIER_NONCE_PREFIX = "__tweakers_carrier_nonce_";
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
  attachFiles,
  attachMcpFormCarrier
};
function attachMcpFormCarrier(nonce) {
  if (!validCarrierNonce(nonce)) return { status: "declined", reason: "invalid_nonce" };
  if (typeof document === "undefined") return { status: "declined", reason: "carrier_not_found" };
  const attached = [];
  for (const form of Array.from(document.querySelectorAll("form"))) {
    const result = attachMcpFormElement(form, nonce);
    if (result.status === "attached") attached.push(result);
  }
  if (attached.length === 0) return { status: "declined", reason: "carrier_not_found" };
  if (attached.length > 1) return { status: "declined", reason: "multiple_carriers" };
  return attached[0];
}
function attachMcpFormElement(form, nonce, resolveFiber = (element) => fiberForNode(element)) {
  if (!validCarrierNonce(nonce)) return { status: "declined", reason: "invalid_nonce" };
  if (String(form?.tagName).toUpperCase() !== "FORM") {
    return { status: "declined", reason: "not_semantic_form" };
  }
  if (!form.isConnected) return { status: "declined", reason: "disconnected_form" };
  const inspected = inspectCarrierForm(form, nonce, resolveFiber);
  if (inspected.status === "declined") return inspected;
  const identity = publicCarrierIdentity(inspected.identity);
  const controller = new SemanticMcpFormController(
    form,
    nonce,
    identity,
    inspected.identityShape,
    resolveFiber
  );
  return {
    status: "attached",
    identity,
    controller,
    acknowledgement: deliveryAcknowledgement("carrier_attach")
  };
}
var SemanticMcpFormController = class {
  constructor(form, nonce, identity, identityShape, resolveFiber) {
    this.form = form;
    this.nonce = nonce;
    this.identity = identity;
    this.identityShape = identityShape;
    this.resolveFiber = resolveFiber;
    this.taskCardAnchor = form;
  }
  form;
  nonce;
  identity;
  identityShape;
  resolveFiber;
  taskCardAnchor;
  continueDispatched = false;
  isCurrent() {
    if (!this.form.isConnected) return false;
    const current = inspectCarrierForm(this.form, this.nonce, this.resolveFiber);
    return current.status === "attached" && current.identityShape === this.identityShape;
  }
  setRadio(propertyKey, optionKey) {
    this.exactChoice("radio", propertyKey, optionKey).click();
  }
  setCheckbox(propertyKey, optionKey, checked) {
    const button2 = this.exactChoice("checkbox", propertyKey, optionKey);
    const selected = button2.getAttribute("aria-checked") === "true";
    if (selected !== checked) button2.click();
  }
  setText(propertyKey, value) {
    this.assertCurrent();
    if (!this.identity.schemaPropertyNames.includes(propertyKey)) {
      throw new Error("MCP form control drift: unknown property");
    }
    const matches = Array.from(
      this.form.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], textarea')
    ).filter((element) => controlMatchesProperty(
      element,
      propertyKey,
      this.identity.schemaPropertyNames,
      this.resolveFiber
    ));
    if (matches.length !== 1) throw new Error("MCP form control drift: text control is not unique");
    setControlledText(matches[0], value);
  }
  continueNormally() {
    if (this.continueDispatched) return;
    this.assertCurrent();
    const controls = Array.from(this.form.querySelectorAll('button[type="submit"], input[type="submit"]'));
    if (controls.length !== 1) throw new Error("MCP form control drift: submit control is not unique");
    this.continueDispatched = true;
    controls[0].click();
  }
  cancelNormally() {
    this.assertCurrent();
    const controls = Array.from(this.form.querySelectorAll(
      'button[type="button"]:not([role="radio"]):not([role="checkbox"])'
    ));
    if (controls.length !== 1) throw new Error("MCP form control drift: cancel control is not unique");
    controls[0].click();
  }
  mountAcknowledgement(owner) {
    this.assertCurrent();
    if (owner === "generic") this.assertVisibleGenericForm();
    return deliveryAcknowledgement(owner === "owned" ? "owned_mount" : "generic_mount");
  }
  exactChoice(role, propertyKey, optionKey) {
    this.assertCurrent();
    if (!this.identity.schemaPropertyNames.includes(propertyKey)) {
      throw new Error("MCP form control drift: unknown property");
    }
    const matches = Array.from(this.form.querySelectorAll(`button[role="${role}"]`)).filter(
      (element) => controlMatchesProperty(
        element,
        propertyKey,
        this.identity.schemaPropertyNames,
        this.resolveFiber
      ) && controlMatchesOption(element, optionKey, this.resolveFiber)
    );
    if (matches.length !== 1) throw new Error("MCP form control drift: choice control is not unique");
    return matches[0];
  }
  assertCurrent() {
    if (!this.isCurrent()) throw new Error("MCP form carrier is no longer current");
  }
  assertVisibleGenericForm() {
    const form = this.form;
    const ownerDocument = form.ownerDocument;
    const documentElement = ownerDocument?.documentElement;
    const view = form.ownerDocument?.defaultView;
    if (!ownerDocument || !documentElement || !view || typeof view.getComputedStyle !== "function") {
      throw new Error("MCP generic form visibility could not be measured");
    }
    const seen = /* @__PURE__ */ new Set();
    let element = form;
    let reachedDocumentElement = false;
    for (let depth = 0; element && depth < MAX_MCP_VISIBILITY_ANCESTORS; depth += 1) {
      if (seen.has(element)) {
        throw new Error("MCP generic form visibility chain is cyclic");
      }
      seen.add(element);
      if (element.ownerDocument !== ownerDocument || !element.isConnected) {
        throw new Error("MCP generic form visibility chain is disconnected");
      }
      const visibilityElement = element;
      if (visibilityElement.hidden === true || visibilityElement.inert === true || element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true") {
        throw new Error("MCP generic form is hidden or suppressed");
      }
      const style = view.getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number.isFinite(opacity) && opacity <= 0 || style.contentVisibility === "hidden") {
        throw new Error("MCP generic form is not visibly painted");
      }
      if (element === documentElement) {
        reachedDocumentElement = true;
        break;
      }
      element = element.parentElement;
    }
    if (!reachedDocumentElement) {
      throw new Error("MCP generic form visibility chain did not reach the document boundary");
    }
    const rects = Array.from(form.getClientRects());
    const painted = rects.some((rect) => Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0);
    if (!painted) throw new Error("MCP generic form has no painted geometry");
    if (!form.isConnected || form.ownerDocument !== ownerDocument) {
      throw new Error("MCP generic form visibility chain is disconnected");
    }
    this.assertCurrent();
  }
};
function inspectCarrierForm(form, nonce, resolveFiber) {
  const first = resolveFiber(form);
  if (!first) return { status: "declined", reason: "missing_fiber" };
  const identities = [];
  const seen = /* @__PURE__ */ new Set();
  let fiber = first;
  let depth = 0;
  let malformedCarrierProps = false;
  while (fiber && depth < MAX_MCP_FIBER_DEPTH) {
    if (seen.has(fiber)) return { status: "declined", reason: "ancestor_cycle" };
    seen.add(fiber);
    const props = asRecord(fiber.memoizedProps);
    if (props && completeCarrierIdentityCandidate(props)) {
      const identity2 = parseCarrierIdentity(props);
      if (identity2) identities.push(identity2);
      else malformedCarrierProps = true;
    }
    fiber = fiber.return;
    depth += 1;
  }
  if (fiber) return { status: "declined", reason: "ancestor_bound_exceeded" };
  if (malformedCarrierProps || identities.length === 0) {
    return { status: "declined", reason: "missing_or_invalid_props" };
  }
  if (identities.length > 1) {
    const shapes = new Set(identities.map(stableCarrierIdentityShape));
    return { status: "declined", reason: shapes.size === 1 ? "duplicate_props" : "conflicting_props" };
  }
  const identity = identities[0];
  if (!Object.hasOwn(identity.schemaProperties, `${MCP_CARRIER_NONCE_PREFIX}${nonce}`)) {
    return { status: "declined", reason: "nonce_not_in_schema" };
  }
  return { status: "attached", identity, identityShape: stableCarrierIdentityShape(identity) };
}
function completeCarrierIdentityCandidate(props) {
  return MCP_CARRIER_IDENTITY_KEYS.every((key) => Object.hasOwn(props, key));
}
function parseCarrierIdentity(props) {
  const elicitation = asRecord(props.elicitation);
  const schema = asRecord(elicitation?.schema);
  const properties = asRecord(schema?.properties);
  const requestId = boundedIdentity(props.requestId);
  const conversationId = boundedIdentity(props.conversationId);
  const hostId = boundedIdentity(props.hostId);
  if (elicitation?.kind !== "formElicitation" || schema?.type !== "object" || !properties || !requestId || !conversationId || !hostId) return null;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_MCP_SCHEMA_PROPERTIES) return null;
  const schemaProperties = {};
  for (const [key, value] of entries) {
    const property = asRecord(value);
    if (!key || key.length > MAX_MCP_IDENTITY_LENGTH || !property || typeof property.type !== "string") return null;
    schemaProperties[key] = property;
  }
  return { requestId, conversationId, hostId, schemaProperties };
}
function stableCarrierIdentityShape(identity) {
  return JSON.stringify({
    requestId: identity.requestId,
    conversationId: identity.conversationId,
    hostId: identity.hostId,
    propertyShape: Object.entries(identity.schemaProperties).sort(([left], [right]) => left.localeCompare(right)).map(([key, property]) => [
      key,
      property.type,
      property.const ?? null,
      property.enum ?? null,
      asRecord(property.items)?.enum ?? null
    ])
  });
}
function publicCarrierIdentity(identity) {
  return Object.freeze({
    requestId: identity.requestId,
    conversationId: identity.conversationId,
    hostId: identity.hostId,
    schemaPropertyNames: Object.freeze(Object.keys(identity.schemaProperties))
  });
}
function controlMatchesProperty(element, expected, schemaPropertyNames, resolveFiber) {
  const known = new Set(schemaPropertyNames);
  const matches = /* @__PURE__ */ new Set();
  const bounded = walkControlFibers(element, resolveFiber, (fiber) => {
    const props = asRecord(fiber.memoizedProps);
    if (!props) return;
    const queue = [props];
    const seen = /* @__PURE__ */ new Set();
    for (let visited = 0; queue.length && visited < 32; visited += 1) {
      const value = queue.shift();
      const record = asRecord(value);
      if (!record || seen.has(record)) continue;
      seen.add(record);
      for (const [key, item] of Object.entries(record)) {
        if (["name", "propertyKey", "fieldName"].includes(key) && typeof item === "string" && known.has(item)) {
          matches.add(item);
        } else if (item && typeof item === "object") {
          queue.push(item);
        }
      }
    }
  });
  return bounded && matches.size === 1 && matches.has(expected);
}
function controlMatchesOption(element, expected, resolveFiber) {
  const candidates = /* @__PURE__ */ new Set();
  const bounded = walkControlFibers(element, resolveFiber, (fiber) => {
    if (typeof fiber.key === "string" || typeof fiber.key === "number") {
      const key = String(fiber.key);
      candidates.add(key);
      if (key.startsWith(".$")) candidates.add(key.slice(2));
    }
    const props = asRecord(fiber.memoizedProps);
    for (const key of ["value", "optionKey"]) {
      if (typeof props?.[key] === "string") candidates.add(props[key]);
    }
    const option = asRecord(props?.option);
    if (typeof option?.value === "string") candidates.add(option.value);
  });
  return bounded && candidates.has(expected);
}
function walkControlFibers(element, resolveFiber, visitor) {
  let fiber = resolveFiber(element);
  const seen = /* @__PURE__ */ new Set();
  for (let depth = 0; fiber && depth < MAX_MCP_FIBER_DEPTH; depth += 1) {
    if (seen.has(fiber)) return false;
    seen.add(fiber);
    visitor(fiber);
    fiber = fiber.return;
  }
  return fiber === null;
}
function setControlledText(input, value) {
  const prototype = Object.getPrototypeOf(input);
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : void 0;
  if (setter) setter.call(input, value);
  else input.value = value;
  const inputEvent = typeof InputEvent === "function" ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: null }) : new Event("input", { bubbles: true });
  input.dispatchEvent(inputEvent);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
function validCarrierNonce(value) {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{8,128}$/.test(value);
}
function boundedIdentity(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_MCP_IDENTITY_LENGTH ? value : null;
}
function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function deliveryAcknowledgement(stage) {
  return Object.freeze({ version: 1, stage, contentRedacted: true });
}
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
    console.warn("[tweaker] host surface observer failed", error);
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
var reloadSequence = Promise.resolve();

// src/renderer-storage.ts
var CURRENT_ID_PREFIX = "co.tweakers.";
var LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
var CURRENT_STORAGE_PREFIX = "tweaker:storage:";
function parseRecord(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function discoverLegacyPublisherKey(id, storage) {
  if (!id.startsWith(CURRENT_ID_PREFIX)) return null;
  const suffix = id.slice(CURRENT_ID_PREFIX.length);
  if (!suffix) return null;
  const suffixMarker = `.${suffix}`;
  const candidates = /* @__PURE__ */ new Set();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const legacyId = key.slice(LEGACY_STORAGE_PREFIX.length);
    if (legacyId !== id && legacyId.startsWith("co.") && legacyId.endsWith(suffixMarker) && legacyId.slice(3, -suffixMarker.length).length > 0) {
      candidates.add(key);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
function createRendererStorage(id, storage) {
  const key = `${CURRENT_STORAGE_PREFIX}${id}`;
  const legacyCurrentIdKey = `${LEGACY_STORAGE_PREFIX}${id}`;
  const read = () => {
    const current = parseRecord(storage.getItem(key));
    const legacyCurrentId = parseRecord(storage.getItem(legacyCurrentIdKey));
    const legacyPublisherKey = discoverLegacyPublisherKey(id, storage);
    const legacyPublisher = legacyPublisherKey === null ? null : parseRecord(storage.getItem(legacyPublisherKey));
    const legacyKeys = [
      legacyCurrentId === null ? null : legacyCurrentIdKey,
      legacyPublisher === null ? null : legacyPublisherKey
    ].filter((candidate) => candidate !== null);
    if (legacyKeys.length === 0) return current ?? {};
    const merged = {
      ...legacyPublisher ?? {},
      ...legacyCurrentId ?? {},
      ...current ?? {}
    };
    try {
      storage.setItem(key, JSON.stringify(merged));
    } catch {
      return merged;
    }
    for (const legacyKey of legacyKeys) storage.removeItem(legacyKey);
    return merged;
  };
  const write = (value) => storage.setItem(key, JSON.stringify(value));
  return {
    get: (name, fallback) => {
      const current = read();
      return name in current ? current[name] : fallback;
    },
    set: (name, value) => {
      const current = read();
      current[name] = value;
      write(current);
    },
    delete: (name) => {
      const current = read();
      delete current[name];
      write(current);
    },
    all: () => read()
  };
}

// src/preload/tweak-host.ts
var loaded = /* @__PURE__ */ new Map();
var cachedPaths = null;
async function startTweakHost() {
  const tweaks = await import_electron2.ipcRenderer.invoke("tweaker:list-tweaks");
  const paths = await import_electron2.ipcRenderer.invoke("tweaker:user-paths");
  cachedPaths = paths;
  setListedTweaks(tweaks);
  window.__tweaker_tweaks_dir__ = paths.tweaksDir;
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
        console.error("[tweaker] tweak startup timed out:", t.manifest.id);
      } else {
        sendLifecycle(t.manifest.id, "ready");
      }
    } catch (e) {
      sendLifecycle(t.manifest.id, "failed", e);
      console.error("[tweaker] tweak load failed:", t.manifest.id, e);
      try {
        import_electron2.ipcRenderer.send(
          "tweaker:preload-log",
          "error",
          "tweak load failed: " + t.manifest.id + ": " + String(e?.stack ?? e)
        );
      } catch {
      }
    }
  }
  console.info(
    `[tweaker] renderer host loaded ${loaded.size} tweak(s):`,
    [...loaded.keys()].join(", ") || "(none)"
  );
  import_electron2.ipcRenderer.send(
    "tweaker:preload-log",
    "info",
    `renderer host loaded ${loaded.size} tweak(s): ${[...loaded.keys()].join(", ") || "(none)"}`
  );
}
function sendLifecycle(id, status, error) {
  const rendererLifecycle = status === "disabled" && error === "missing entry" ? "failed" : status === "starting" ? "starting" : status === "failed" ? "failed" : status === "timed_out" ? "timed_out" : status === "quarantined" ? "quarantined" : "enabled";
  updateListedTweakLifecycle(id, rendererLifecycle, error === void 0 ? void 0 : error instanceof Error ? error.message : String(error));
  try {
    import_electron2.ipcRenderer.send("tweaker:tweak-lifecycle", {
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
      console.warn("[tweaker] tweak stop failed:", id, e);
    } finally {
      void import_electron2.ipcRenderer.invoke("tweaker:codex-view-dispose-tweak", id).catch(() => {
      });
      void import_electron2.ipcRenderer.invoke("tweaker:native-dispose-tweak", id).catch(() => {
      });
    }
  }
  loaded.clear();
  clearSections();
}
async function loadTweak(t, paths) {
  const source = await import_electron2.ipcRenderer.invoke(
    "tweaker:read-tweak-source",
    t.entry
  );
  const module2 = { exports: {} };
  const exports2 = module2.exports;
  const fn = new Function(
    "module",
    "exports",
    "console",
    `${source}
//# sourceURL=tweaker-tweak://${encodeURIComponent(t.manifest.id)}/${encodeURIComponent(t.entry)}`
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
  const assertIpcPermission = () => {
    if (!manifest.permissions?.includes("ipc")) {
      throw new Error(`tweak ${id} must declare ipc permission`);
    }
  };
  const log = (level, ...a) => {
    const consoleFn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.log;
    consoleFn(`[tweaker][${id}]`, ...a);
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
        "tweaker:preload-log",
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
        assertIpcPermission();
        const wrapped = (_e, ...args) => h(...args);
        import_electron2.ipcRenderer.on(`tweaker:${id}:${c}`, wrapped);
        return () => import_electron2.ipcRenderer.removeListener(`tweaker:${id}:${c}`, wrapped);
      },
      send: (c, ...args) => {
        assertIpcPermission();
        import_electron2.ipcRenderer.send(`tweaker:${id}:${c}`, ...args);
      },
      invoke: (c, ...args) => {
        assertIpcPermission();
        if (id === "co.tweakers.thread-summary-profiles" && c === "profiles.read") {
          return import_electron2.ipcRenderer.invoke(
            "tweaker:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "profiles.read",
            args[0]
          );
        }
        if (id === "co.tweakers.followup" && c === "policy") {
          return import_electron2.ipcRenderer.invoke(
            "tweaker:cross-tweak-read",
            id,
            "co.tweakers.projects",
            "followup.policy.read",
            args[0]
          );
        }
        return import_electron2.ipcRenderer.invoke(`tweaker:${id}:${c}`, ...args);
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
        const info = await import_electron2.ipcRenderer.invoke("tweaker:codex-runtime-info");
        const bridge = rendererElectronBridge();
        return {
          ...info,
          buildFlavor: bridge?.getBuildFlavor?.() ?? info.buildFlavor,
          usesOwlAppShell: bridge?.usesOwlAppShell?.() ?? info.usesOwlAppShell
        };
      },
      getCapabilities: () => import_electron2.ipcRenderer.invoke("tweaker:codex-runtime-capabilities")
    },
    windows: {
      create: (options) => import_electron2.ipcRenderer.invoke("tweaker:codex-window-create", options),
      getPrimary: () => import_electron2.ipcRenderer.invoke("tweaker:codex-window-primary"),
      focus: (windowId) => import_electron2.ipcRenderer.invoke("tweaker:codex-window-focus", windowId),
      show: (windowId) => import_electron2.ipcRenderer.invoke("tweaker:codex-window-show", windowId)
    },
    views: {
      create: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "tweaker:codex-view-create",
          tweakId,
          options
        );
        return rendererCodexViewRef(tweakId, ref.id, ref.webContentsId, ref.parentWindowId);
      }
    },
    cdp: {
      getStatus: () => import_electron2.ipcRenderer.invoke("tweaker:codex-cdp-status"),
      listTargets: () => import_electron2.ipcRenderer.invoke("tweaker:codex-cdp-targets")
    },
    native: {
      loadModule: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "tweaker:native-load-module",
          tweakId,
          options
        );
        return rendererNativeModuleRef(tweakId, ref.id, ref.kind);
      },
      createPanel: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "tweaker:native-create-panel",
          tweakId,
          options
        );
        return rendererNativePanelRef(tweakId, ref.id, ref.windowId);
      },
      attachView: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "tweaker:native-attach-view",
          tweakId,
          options
        );
        return rendererNativeViewRef(tweakId, ref.id);
      },
      launchHelper: async (options) => {
        const ref = await import_electron2.ipcRenderer.invoke(
          "tweaker:native-launch-helper",
          tweakId,
          options
        );
        return rendererNativeHelperRef(tweakId, ref.id, ref.pid);
      }
    },
    refresh: {
      getStatus: () => import_electron2.ipcRenderer.invoke("tweaker:get-refresh-status"),
      start: (source = "smart") => import_electron2.ipcRenderer.invoke("tweaker:start-local-refresh", source),
      onStatusChanged: (listener) => {
        const handler = () => {
          void import_electron2.ipcRenderer.invoke("tweaker:get-refresh-status").then(listener);
        };
        import_electron2.ipcRenderer.on("tweaker:refresh-status-changed", handler);
        return () => import_electron2.ipcRenderer.removeListener("tweaker:refresh-status-changed", handler);
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
    createWindow: (options) => import_electron2.ipcRenderer.invoke("tweaker:codex-window-create", options)
  };
}
function rendererCodexViewRef(tweakId, id, webContentsId, parentWindowId) {
  return {
    id,
    webContentsId,
    parentWindowId,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setBounds", bounds),
    setVisible: (visible) => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "setVisible", visible),
    bringToFront: () => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "bringToFront"),
    loadRoute: (route, hostId) => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadRoute", route, hostId),
    loadUrl: (url) => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "loadUrl", url),
    dispose: () => import_electron2.ipcRenderer.invoke("tweaker:codex-view-call", tweakId, id, "dispose")
  };
}
function rendererNativeModuleRef(tweakId, id, kind) {
  return {
    id,
    kind,
    request: (method, payload, timeoutMs) => import_electron2.ipcRenderer.invoke(
      "tweaker:native-module-request",
      tweakId,
      id,
      method,
      payload,
      timeoutMs
    ),
    dispose: () => import_electron2.ipcRenderer.invoke("tweaker:native-module-dispose", tweakId, id)
  };
}
function rendererNativePanelRef(tweakId, id, windowId) {
  return {
    id,
    windowId,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "setBounds", bounds),
    show: () => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "show"),
    hide: () => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "hide"),
    dispose: () => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "panel", id, "dispose")
  };
}
function rendererNativeViewRef(tweakId, id) {
  return {
    id,
    setBounds: (bounds) => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setBounds", bounds),
    setVisible: (visible) => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "setVisible", visible),
    dispose: () => import_electron2.ipcRenderer.invoke("tweaker:native-instance-call", tweakId, "view", id, "dispose")
  };
}
function rendererNativeHelperRef(tweakId, id, pid) {
  return {
    id,
    pid,
    send: (message) => import_electron2.ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "send", message),
    request: (message, timeoutMs) => import_electron2.ipcRenderer.invoke(
      "tweaker:native-helper-call",
      tweakId,
      id,
      "request",
      message,
      timeoutMs
    ),
    stop: () => import_electron2.ipcRenderer.invoke("tweaker:native-helper-call", tweakId, id, "stop")
  };
}
function rendererElectronBridge() {
  const value = window.electronBridge;
  return value && typeof value === "object" ? value : null;
}
var rendererStorage = (id, storage = localStorage) => createRendererStorage(id, storage);
function rendererFs(id, _paths) {
  return {
    dataDir: `<remote>/tweak-data/${id}`,
    read: (p) => import_electron2.ipcRenderer.invoke("tweaker:tweak-fs", "read", id, p),
    write: (p, c) => import_electron2.ipcRenderer.invoke("tweaker:tweak-fs", "write", id, p, c),
    exists: (p) => import_electron2.ipcRenderer.invoke("tweaker:tweak-fs", "exists", id, p)
  };
}

// src/preload/manager.ts
var import_electron3 = require("electron");
async function mountManager() {
  const tweaks = await import_electron3.ipcRenderer.invoke("tweaker:list-tweaks");
  const paths = await import_electron3.ipcRenderer.invoke("tweaker:user-paths");
  registerSection({
    id: "tweaker:manager",
    title: "Tweak Manager",
    description: `${tweaks.length} tweak(s) installed. User dir: ${paths.userRoot}`,
    render(root) {
      root.style.cssText = "display:flex;flex-direction:column;gap:8px;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
      actions.appendChild(
        button(
          "Open tweaks folder",
          () => import_electron3.ipcRenderer.invoke("tweaker:reveal", paths.tweaksDir).catch(() => {
          })
        )
      );
      actions.appendChild(
        button(
          "Open logs",
          () => import_electron3.ipcRenderer.invoke("tweaker:reveal", paths.logDir).catch(() => {
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

// src/preload/desktop-update-indicator.ts
var import_electron4 = require("electron");

// src/preload/desktop-update-indicator-state.ts
function shouldShowDesktopUpdateIndicator(state2) {
  return state2?.status === "update-available" && state2.nativeUpdateControlActive !== true;
}
function desktopUpdateIndicatorIdentity(state2) {
  return [state2.latest?.marketingVersion ?? "unknown", state2.latest?.build ?? "unknown"].join(":");
}

// src/preload/desktop-update-indicator.ts
var UPDATE_CHANGED_CHANNEL = "tweaker:codex-desktop-update-changed";
var INDICATOR_ATTRIBUTE = "data-tweaker-desktop-update-indicator";
function findDesktopUpdateFooterMount(root = document) {
  const anchors = Array.from(root.querySelectorAll("[aria-label]"));
  for (const anchor of anchors) {
    const label = anchor.getAttribute("aria-label")?.trim().toLowerCase() ?? "";
    if (!/(settings|account|profile|help)/.test(label)) continue;
    let candidate = anchor;
    for (let depth = 0; candidate && depth < 6; depth += 1) {
      const role = candidate.getAttribute("role");
      if (candidate.matches("nav, aside, footer") || role === "navigation" || role === "contentinfo") {
        return candidate;
      }
      candidate = candidate.parentElement;
    }
  }
  return null;
}
function startDesktopUpdateIndicator() {
  let current = null;
  let indicator = null;
  let warningTimer = null;
  const warnedIdentities = /* @__PURE__ */ new Set();
  const removeIndicator = () => {
    indicator?.remove();
    indicator = null;
    if (warningTimer) clearTimeout(warningTimer);
    warningTimer = null;
  };
  const scheduleMissingMountWarning = (identity) => {
    if (warningTimer || warnedIdentities.has(identity)) return;
    warningTimer = setTimeout(() => {
      warningTimer = null;
      if (!current || !shouldShowDesktopUpdateIndicator(current)) return;
      if (desktopUpdateIndicatorIdentity(current) !== identity || findDesktopUpdateFooterMount()) return;
      warnedIdentities.add(identity);
      console.warn(`[tweaker] ChatGPT update ${identity} is available, but no semantic sidebar footer mount point was found.`);
    }, 3e3);
  };
  const render = () => {
    if (!shouldShowDesktopUpdateIndicator(current)) {
      removeIndicator();
      return;
    }
    const identity = desktopUpdateIndicatorIdentity(current);
    const mount = findDesktopUpdateFooterMount();
    if (!mount) {
      indicator?.remove();
      indicator = null;
      scheduleMissingMountWarning(identity);
      return;
    }
    if (warningTimer) clearTimeout(warningTimer);
    warningTimer = null;
    if (!indicator) {
      indicator = document.createElement("button");
      indicator.type = "button";
      indicator.setAttribute(INDICATOR_ATTRIBUTE, "true");
      indicator.setAttribute("aria-label", "ChatGPT update available");
      indicator.textContent = "Update";
      Object.assign(indicator.style, {
        appearance: "none",
        border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
        borderRadius: "9999px",
        background: "color-mix(in srgb, currentColor 10%, transparent)",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        fontSize: "12px",
        fontWeight: "600",
        margin: "6px 10px",
        padding: "5px 10px"
      });
      indicator.addEventListener("click", () => {
        indicator.disabled = true;
        void import_electron4.ipcRenderer.invoke("tweaker:check-codex-desktop-update").finally(() => {
          if (indicator?.isConnected) indicator.disabled = false;
        });
      });
    }
    indicator.title = `ChatGPT ${current?.latest?.marketingVersion ?? "update"} is available`;
    if (indicator.parentElement !== mount) mount.appendChild(indicator);
  };
  const onChanged = (_event, value) => {
    current = value && typeof value === "object" ? value : null;
    render();
  };
  import_electron4.ipcRenderer.on(UPDATE_CHANGED_CHANNEL, onChanged);
  const observer = new MutationObserver(render);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  void import_electron4.ipcRenderer.invoke("tweaker:get-codex-desktop-update").then((value) => onChanged(void 0, value)).catch(() => {
  });
  return () => {
    import_electron4.ipcRenderer.removeListener(UPDATE_CHANGED_CHANNEL, onChanged);
    observer.disconnect();
    removeIndicator();
  };
}

// src/preload/reload-focus.ts
function captureTweakReloadFocus(document2) {
  const element = document2.activeElement;
  if (!element || element === document2.body || element === document2.documentElement || typeof element.focus !== "function") {
    return null;
  }
  return {
    document: document2,
    element,
    selection: captureSelection(document2, element)
  };
}
function restoreTweakReloadFocus(snapshot2) {
  if (!snapshot2?.element.isConnected) return false;
  const { document: document2, element } = snapshot2;
  const current = document2.activeElement;
  if (current && current !== element && current !== document2.body && current !== document2.documentElement) {
    return false;
  }
  element.focus({ preventScroll: true });
  restoreSelection(snapshot2);
  return document2.activeElement === element;
}
function captureSelection(document2, element) {
  if (isTextControl(element)) {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null) return null;
    return {
      kind: "control",
      start,
      end,
      direction: element.selectionDirection ?? "none"
    };
  }
  if (!element.isContentEditable) return null;
  const selection = document2.getSelection?.();
  if (!selection || !selection.anchorNode || !selection.focusNode || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
    return null;
  }
  return {
    kind: "contenteditable",
    anchor: textOffset(document2, element, selection.anchorNode, selection.anchorOffset),
    focus: textOffset(document2, element, selection.focusNode, selection.focusOffset)
  };
}
function restoreSelection(snapshot2) {
  const { document: document2, element, selection } = snapshot2;
  if (!selection) return;
  if (selection.kind === "control" && isTextControl(element)) {
    element.setSelectionRange(selection.start, selection.end, selection.direction);
    return;
  }
  if (selection.kind !== "contenteditable" || !element.isContentEditable) return;
  const anchor = textPosition(document2, element, selection.anchor);
  const focus = textPosition(document2, element, selection.focus);
  const liveSelection = document2.getSelection?.();
  if (!anchor || !focus || !liveSelection) return;
  if (typeof liveSelection.setBaseAndExtent === "function") {
    liveSelection.setBaseAndExtent(
      anchor.node,
      anchor.offset,
      focus.node,
      focus.offset
    );
    return;
  }
  const range = document2.createRange();
  range.setStart(anchor.node, anchor.offset);
  range.setEnd(focus.node, focus.offset);
  liveSelection.removeAllRanges();
  liveSelection.addRange(range);
}
function isTextControl(element) {
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}
function textOffset(document2, root, node, offset) {
  const range = document2.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return range.toString().length;
}
function textPosition(document2, root, target) {
  const walker = document2.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, target);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return root.lastChild ? { node: root.lastChild, offset: root.lastChild.textContent?.length ?? 0 } : { node: root, offset: 0 };
}

// src/preload/index.ts
var BROWSER_UI_CONNECT_PORT = "tweaker:browser-ui-connect-app-host";
var BROWSER_UI_BRIDGE_REQUEST = "tweaker:browser-ui-bridge-request";
var BROWSER_UI_BRIDGE_RESPONSE = "tweaker:browser-ui-bridge-response";
var BROWSER_UI_MESSAGE_FOR_VIEW = "tweaker:browser-ui-message-for-view";
var BROWSER_UI_WORKER_MESSAGE = "tweaker:browser-ui-worker-message";
var BROWSER_UI_SYSTEM_THEME = "tweaker:browser-ui-system-theme";
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
  const msg = `[tweaker preload] ${stage}${extra === void 0 ? "" : " " + safeStringify2(extra)}`;
  try {
    console.error(msg);
  } catch {
  }
  try {
    import_electron5.ipcRenderer.send("tweaker:preload-log", "info", msg);
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
    startDesktopUpdateIndicator();
    fileLog("desktop update indicator started");
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
    console.error("[tweaker] preload boot failed:", e);
  }
}
var reloading = null;
function subscribeReload() {
  import_electron5.ipcRenderer.on("tweaker:tweaks-changed", () => {
    if (reloading) return;
    reloading = (async () => {
      const focusSnapshot = captureTweakReloadFocus(document);
      try {
        console.info("[tweaker] hot-reloading tweaks");
        teardownTweakHost();
        await startTweakHost();
        await mountManager();
      } catch (e) {
        console.error("[tweaker] hot reload failed:", e);
      } finally {
        window.requestAnimationFrame(() => {
          restoreTweakReloadFocus(focusSnapshot);
        });
        reloading = null;
      }
    })();
  });
}
function installBrowserUiHostBridge() {
  const workerListeners = /* @__PURE__ */ new Map();
  import_electron5.ipcRenderer.on(BROWSER_UI_CONNECT_PORT, (event) => {
    const [port] = event.ports;
    if (!port) return;
    window.postMessage({ type: "connect-app-host", port }, "*", [port]);
  });
  import_electron5.ipcRenderer.on(BROWSER_UI_BRIDGE_REQUEST, async (_event, payload) => {
    const request = payload && typeof payload === "object" ? payload : {};
    const id = typeof request.id === "string" ? request.id : "";
    const method = typeof request.method === "string" ? request.method : "";
    const args = Array.isArray(request.args) ? request.args : [];
    try {
      const value = await runBrowserUiBridgeMethod(method, args, workerListeners);
      import_electron5.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, { id, ok: true, value });
    } catch (e) {
      import_electron5.ipcRenderer.send(BROWSER_UI_BRIDGE_RESPONSE, {
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  });
  import_electron5.ipcRenderer.on(DESKTOP_MESSAGE_FOR_VIEW, (_event, message) => {
    import_electron5.ipcRenderer.send(BROWSER_UI_MESSAGE_FOR_VIEW, message);
  });
  import_electron5.ipcRenderer.on(DESKTOP_SYSTEM_THEME_UPDATED, (_event, value) => {
    import_electron5.ipcRenderer.send(BROWSER_UI_SYSTEM_THEME, value);
  });
}
async function runBrowserUiBridgeMethod(method, args, workerListeners) {
  switch (method) {
    case "snapshot":
      return import_electron5.ipcRenderer.sendSync(DESKTOP_GET_SHARED_OBJECT_SNAPSHOT) ?? {};
    case "systemTheme":
      return import_electron5.ipcRenderer.sendSync(DESKTOP_GET_SYSTEM_THEME_VARIANT);
    case "sentryOptions":
      return import_electron5.ipcRenderer.sendSync(DESKTOP_GET_SENTRY_INIT_OPTIONS);
    case "buildFlavor":
      return import_electron5.ipcRenderer.sendSync(DESKTOP_GET_BUILD_FLAVOR);
    case "usesOwlAppShell":
      return import_electron5.ipcRenderer.sendSync(DESKTOP_GET_USES_OWL_APP_SHELL) === true;
    case "sendMessageFromView":
      return import_electron5.ipcRenderer.invoke(DESKTOP_MESSAGE_FROM_VIEW, args[0]);
    case "sendWorkerMessageFromView":
      return import_electron5.ipcRenderer.invoke(desktopWorkerFromViewChannel(String(args[0])), args[1]);
    case "subscribeWorkerMessages":
      return subscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "unsubscribeWorkerMessages":
      return unsubscribeBrowserUiWorkerMessages(String(args[0]), workerListeners);
    case "showContextMenu":
      return import_electron5.ipcRenderer.invoke(DESKTOP_SHOW_CONTEXT_MENU, args[0]);
    case "showApplicationMenu":
      return import_electron5.ipcRenderer.invoke(DESKTOP_SHOW_APPLICATION_MENU, {
        menuId: args[0],
        x: args[1],
        y: args[2]
      });
    case "getFastModeRolloutMetrics":
      return import_electron5.ipcRenderer.invoke(DESKTOP_GET_FAST_MODE_ROLLOUT_METRICS, args[0]);
    case "triggerSentryTestError":
      return import_electron5.ipcRenderer.invoke(DESKTOP_TRIGGER_SENTRY_TEST);
    default:
      throw new Error(`Unknown Tweakers browser UI bridge method: ${method}`);
  }
}
function subscribeBrowserUiWorkerMessages(workerId, workerListeners) {
  if (!/^[a-zA-Z0-9._:-]+$/.test(workerId)) throw new Error("invalid worker id");
  if (workerListeners.has(workerId)) return true;
  const listener = (_event, message) => {
    import_electron5.ipcRenderer.send(BROWSER_UI_WORKER_MESSAGE, workerId, message);
  };
  workerListeners.set(workerId, listener);
  import_electron5.ipcRenderer.on(desktopWorkerForViewChannel(workerId), listener);
  return true;
}
function unsubscribeBrowserUiWorkerMessages(workerId, workerListeners) {
  const listener = workerListeners.get(workerId);
  if (!listener) return true;
  workerListeners.delete(workerId);
  import_electron5.ipcRenderer.removeListener(desktopWorkerForViewChannel(workerId), listener);
  return true;
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvdHdlYWstc3RvcmUudHMiLCAiLi4vc3JjL3ByZWxvYWQvc2V0dGluZ3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vha3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC9lbnZpcm9ubWVudC1jb25maWctY29udHJvbGxlci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL2hvc3Qtc3VyZmFjZXMudHMiLCAiLi4vc3JjL3R3ZWFrLWxpZmVjeWNsZS50cyIsICIuLi9zcmMvcmVuZGVyZXItc3RvcmFnZS50cyIsICIuLi9zcmMvcHJlbG9hZC9tYW5hZ2VyLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2Rlc2t0b3AtdXBkYXRlLWluZGljYXRvci50cyIsICIuLi9zcmMvcHJlbG9hZC9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGUudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVsb2FkLWZvY3VzLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvKipcbiAqIFJlbmRlcmVyIHByZWxvYWQgZW50cnkuIFJ1bnMgaW4gYW4gaXNvbGF0ZWQgd29ybGQgYmVmb3JlIENvZGV4J3MgcGFnZSBKUy5cbiAqIFJlc3BvbnNpYmlsaXRpZXM6XG4gKiAgIDEuIEluc3RhbGwgYSBSZWFjdCBEZXZUb29scy1zaGFwZWQgZ2xvYmFsIGhvb2sgdG8gY2FwdHVyZSB0aGUgcmVuZGVyZXJcbiAqICAgICAgcmVmZXJlbmNlIHdoZW4gUmVhY3QgbW91bnRzLiBXZSB1c2UgdGhpcyBmb3IgZmliZXIgd2Fsa2luZy5cbiAqICAgMi4gQWZ0ZXIgRE9NQ29udGVudExvYWRlZCwga2ljayBvZmYgc2V0dGluZ3MtaW5qZWN0aW9uIGxvZ2ljLlxuICogICAzLiBEaXNjb3ZlciByZW5kZXJlci1zY29wZWQgdHdlYWtzICh2aWEgSVBDIHRvIG1haW4pIGFuZCBzdGFydCB0aGVtLlxuICogICA0LiBMaXN0ZW4gZm9yIGB0d2Vha2VyOnR3ZWFrcy1jaGFuZ2VkYCBmcm9tIG1haW4gKGZpbGVzeXN0ZW0gd2F0Y2hlcikgYW5kXG4gKiAgICAgIGhvdC1yZWxvYWQgdHdlYWtzIHdpdGhvdXQgZHJvcHBpbmcgdGhlIHBhZ2UuXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IGluc3RhbGxSZWFjdEhvb2sgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBzdGFydFNldHRpbmdzSW5qZWN0b3IgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgc3RhcnRUd2Vha0hvc3QsIHRlYXJkb3duVHdlYWtIb3N0IH0gZnJvbSBcIi4vdHdlYWstaG9zdFwiO1xuaW1wb3J0IHsgbW91bnRNYW5hZ2VyIH0gZnJvbSBcIi4vbWFuYWdlclwiO1xuaW1wb3J0IHsgc3RhcnREZXNrdG9wVXBkYXRlSW5kaWNhdG9yIH0gZnJvbSBcIi4vZGVza3RvcC11cGRhdGUtaW5kaWNhdG9yXCI7XG5pbXBvcnQge1xuICBjYXB0dXJlVHdlYWtSZWxvYWRGb2N1cyxcbiAgcmVzdG9yZVR3ZWFrUmVsb2FkRm9jdXMsXG59IGZyb20gXCIuL3JlbG9hZC1mb2N1c1wiO1xuXG5jb25zdCBCUk9XU0VSX1VJX0NPTk5FQ1RfUE9SVCA9IFwidHdlYWtlcjpicm93c2VyLXVpLWNvbm5lY3QtYXBwLWhvc3RcIjtcbmNvbnN0IEJST1dTRVJfVUlfQlJJREdFX1JFUVVFU1QgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1icmlkZ2UtcmVxdWVzdFwiO1xuY29uc3QgQlJPV1NFUl9VSV9CUklER0VfUkVTUE9OU0UgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1icmlkZ2UtcmVzcG9uc2VcIjtcbmNvbnN0IEJST1dTRVJfVUlfTUVTU0FHRV9GT1JfVklFVyA9IFwidHdlYWtlcjpicm93c2VyLXVpLW1lc3NhZ2UtZm9yLXZpZXdcIjtcbmNvbnN0IEJST1dTRVJfVUlfV09SS0VSX01FU1NBR0UgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS13b3JrZXItbWVzc2FnZVwiO1xuY29uc3QgQlJPV1NFUl9VSV9TWVNURU1fVEhFTUUgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1zeXN0ZW0tdGhlbWVcIjtcblxuY29uc3QgREVTS1RPUF9NRVNTQUdFX0ZST01fVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZyb20tdmlld1wiO1xuY29uc3QgREVTS1RPUF9NRVNTQUdFX0ZPUl9WSUVXID0gXCJjb2RleF9kZXNrdG9wOm1lc3NhZ2UtZm9yLXZpZXdcIjtcbmNvbnN0IERFU0tUT1BfU0hPV19DT05URVhUX01FTlUgPSBcImNvZGV4X2Rlc2t0b3A6c2hvdy1jb250ZXh0LW1lbnVcIjtcbmNvbnN0IERFU0tUT1BfU0hPV19BUFBMSUNBVElPTl9NRU5VID0gXCJjb2RleF9kZXNrdG9wOnNob3ctYXBwbGljYXRpb24tbWVudVwiO1xuY29uc3QgREVTS1RPUF9HRVRfU0VOVFJZX0lOSVRfT1BUSU9OUyA9IFwiY29kZXhfZGVza3RvcDpnZXQtc2VudHJ5LWluaXQtb3B0aW9uc1wiO1xuY29uc3QgREVTS1RPUF9HRVRfQlVJTERfRkxBVk9SID0gXCJjb2RleF9kZXNrdG9wOmdldC1idWlsZC1mbGF2b3JcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1VTRVNfT1dMX0FQUF9TSEVMTCA9IFwiY29kZXhfZGVza3RvcDpnZXQtdXNlcy1vd2wtYXBwLXNoZWxsXCI7XG5jb25zdCBERVNLVE9QX0dFVF9TWVNURU1fVEhFTUVfVkFSSUFOVCA9IFwiY29kZXhfZGVza3RvcDpnZXQtc3lzdGVtLXRoZW1lLXZhcmlhbnRcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1NIQVJFRF9PQkpFQ1RfU05BUFNIT1QgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXNoYXJlZC1vYmplY3Qtc25hcHNob3RcIjtcbmNvbnN0IERFU0tUT1BfR0VUX0ZBU1RfTU9ERV9ST0xMT1VUX01FVFJJQ1MgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LWZhc3QtbW9kZS1yb2xsb3V0LW1ldHJpY3NcIjtcbmNvbnN0IERFU0tUT1BfU1lTVEVNX1RIRU1FX1VQREFURUQgPSBcImNvZGV4X2Rlc2t0b3A6c3lzdGVtLXRoZW1lLXZhcmlhbnQtdXBkYXRlZFwiO1xuY29uc3QgREVTS1RPUF9UUklHR0VSX1NFTlRSWV9URVNUID0gXCJjb2RleF9kZXNrdG9wOnRyaWdnZXItc2VudHJ5LXRlc3RcIjtcblxuZnVuY3Rpb24gZGVza3RvcFdvcmtlckZyb21WaWV3Q2hhbm5lbCh3b3JrZXJJZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBjb2RleF9kZXNrdG9wOndvcmtlcjoke3dvcmtlcklkfTpmcm9tLXZpZXdgO1xufVxuXG5mdW5jdGlvbiBkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgY29kZXhfZGVza3RvcDp3b3JrZXI6JHt3b3JrZXJJZH06Zm9yLXZpZXdgO1xufVxuXG4vLyBGaWxlLWxvZyBwcmVsb2FkIHByb2dyZXNzIHNvIHdlIGNhbiBkaWFnbm9zZSB3aXRob3V0IERldlRvb2xzLiBCZXN0LWVmZm9ydDpcbi8vIGZhaWx1cmVzIGhlcmUgbXVzdCBuZXZlciB0aHJvdyBiZWNhdXNlIHdlJ2QgdGFrZSB0aGUgcGFnZSBkb3duIHdpdGggdXMuXG4vL1xuLy8gQ29kZXgncyByZW5kZXJlciBpcyBzYW5kYm94ZWQgKHNhbmRib3g6IHRydWUpLCBzbyBgcmVxdWlyZShcIm5vZGU6ZnNcIilgIGlzXG4vLyB1bmF2YWlsYWJsZS4gV2UgZm9yd2FyZCBsb2cgbGluZXMgdG8gbWFpbiB2aWEgSVBDOyBtYWluIHdyaXRlcyB0aGUgZmlsZS5cbmZ1bmN0aW9uIGZpbGVMb2coc3RhZ2U6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGNvbnN0IG1zZyA9IGBbdHdlYWtlciBwcmVsb2FkXSAke3N0YWdlfSR7XG4gICAgZXh0cmEgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiBcIiBcIiArIHNhZmVTdHJpbmdpZnkoZXh0cmEpXG4gIH1gO1xuICB0cnkge1xuICAgIGNvbnNvbGUuZXJyb3IobXNnKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsIFwiaW5mb1wiLCBtc2cpO1xuICB9IGNhdGNoIHt9XG59XG5mdW5jdGlvbiBzYWZlU3RyaW5naWZ5KHY6IHVua25vd24pOiBzdHJpbmcge1xuICB0cnkge1xuICAgIHJldHVybiB0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIiA/IHYgOiBKU09OLnN0cmluZ2lmeSh2KTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFN0cmluZyh2KTtcbiAgfVxufVxuXG5maWxlTG9nKFwicHJlbG9hZCBlbnRyeVwiLCB7IHVybDogbG9jYXRpb24uaHJlZiB9KTtcblxudHJ5IHtcbiAgaW5zdGFsbEJyb3dzZXJVaUhvc3RCcmlkZ2UoKTtcbiAgZmlsZUxvZyhcImJyb3dzZXIgVUkgaG9zdCBicmlkZ2UgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwiYnJvd3NlciBVSSBob3N0IGJyaWRnZSBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxuLy8gUmVhY3QgaG9vayBtdXN0IGJlIGluc3RhbGxlZCAqYmVmb3JlKiBDb2RleCdzIGJ1bmRsZSBydW5zLlxudHJ5IHtcbiAgaW5zdGFsbFJlYWN0SG9vaygpO1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBpbnN0YWxsZWRcIik7XG59IGNhdGNoIChlKSB7XG4gIGZpbGVMb2coXCJyZWFjdCBob29rIEZBSUxFRFwiLCBTdHJpbmcoZSkpO1xufVxuXG5xdWV1ZU1pY3JvdGFzaygoKSA9PiB7XG4gIGlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSBcImxvYWRpbmdcIikge1xuICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsIGJvb3QsIHsgb25jZTogdHJ1ZSB9KTtcbiAgfSBlbHNlIHtcbiAgICBib290KCk7XG4gIH1cbn0pO1xuXG5hc3luYyBmdW5jdGlvbiBib290KCkge1xuICBmaWxlTG9nKFwiYm9vdCBzdGFydFwiLCB7IHJlYWR5U3RhdGU6IGRvY3VtZW50LnJlYWR5U3RhdGUgfSk7XG4gIHRyeSB7XG4gICAgc3RhcnREZXNrdG9wVXBkYXRlSW5kaWNhdG9yKCk7XG4gICAgZmlsZUxvZyhcImRlc2t0b3AgdXBkYXRlIGluZGljYXRvciBzdGFydGVkXCIpO1xuICAgIHN0YXJ0U2V0dGluZ3NJbmplY3RvcigpO1xuICAgIGZpbGVMb2coXCJzZXR0aW5ncyBpbmplY3RvciBzdGFydGVkXCIpO1xuICAgIGF3YWl0IHN0YXJ0VHdlYWtIb3N0KCk7XG4gICAgZmlsZUxvZyhcInR3ZWFrIGhvc3Qgc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICBmaWxlTG9nKFwibWFuYWdlciBtb3VudGVkXCIpO1xuICAgIHN1YnNjcmliZVJlbG9hZCgpO1xuICAgIGZpbGVMb2coXCJib290IGNvbXBsZXRlXCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgZmlsZUxvZyhcImJvb3QgRkFJTEVEXCIsIFN0cmluZygoZSBhcyBFcnJvcik/LnN0YWNrID8/IGUpKTtcbiAgICBjb25zb2xlLmVycm9yKFwiW3R3ZWFrZXJdIHByZWxvYWQgYm9vdCBmYWlsZWQ6XCIsIGUpO1xuICB9XG59XG5cbi8vIEhvdCByZWxvYWQ6IGdhdGVkIGJlaGluZCBhIHNtYWxsIGluLWZsaWdodCBsb2NrIHNvIGEgZmx1cnJ5IG9mIGZzIGV2ZW50c1xuLy8gZG9lc24ndCByZWVudHJhbnRseSB0ZWFyIGRvd24gdGhlIGhvc3QgbWlkLWxvYWQuXG5sZXQgcmVsb2FkaW5nOiBQcm9taXNlPHZvaWQ+IHwgbnVsbCA9IG51bGw7XG5mdW5jdGlvbiBzdWJzY3JpYmVSZWxvYWQoKTogdm9pZCB7XG4gIGlwY1JlbmRlcmVyLm9uKFwidHdlYWtlcjp0d2Vha3MtY2hhbmdlZFwiLCAoKSA9PiB7XG4gICAgaWYgKHJlbG9hZGluZykgcmV0dXJuO1xuICAgIHJlbG9hZGluZyA9IChhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBmb2N1c1NuYXBzaG90ID0gY2FwdHVyZVR3ZWFrUmVsb2FkRm9jdXMoZG9jdW1lbnQpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW3R3ZWFrZXJdIGhvdC1yZWxvYWRpbmcgdHdlYWtzXCIpO1xuICAgICAgICB0ZWFyZG93blR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICByZXN0b3JlVHdlYWtSZWxvYWRGb2N1cyhmb2N1c1NuYXBzaG90KTtcbiAgICAgICAgfSk7XG4gICAgICAgIHJlbG9hZGluZyA9IG51bGw7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxCcm93c2VyVWlIb3N0QnJpZGdlKCk6IHZvaWQge1xuICBjb25zdCB3b3JrZXJMaXN0ZW5lcnMgPSBuZXcgTWFwPHN0cmluZywgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZD4oKTtcblxuICBpcGNSZW5kZXJlci5vbihCUk9XU0VSX1VJX0NPTk5FQ1RfUE9SVCwgKGV2ZW50KSA9PiB7XG4gICAgY29uc3QgW3BvcnRdID0gZXZlbnQucG9ydHM7XG4gICAgaWYgKCFwb3J0KSByZXR1cm47XG4gICAgd2luZG93LnBvc3RNZXNzYWdlKHsgdHlwZTogXCJjb25uZWN0LWFwcC1ob3N0XCIsIHBvcnQgfSwgXCIqXCIsIFtwb3J0XSk7XG4gIH0pO1xuXG4gIGlwY1JlbmRlcmVyLm9uKEJST1dTRVJfVUlfQlJJREdFX1JFUVVFU1QsIGFzeW5jIChfZXZlbnQsIHBheWxvYWQpID0+IHtcbiAgICBjb25zdCByZXF1ZXN0ID0gcGF5bG9hZCAmJiB0eXBlb2YgcGF5bG9hZCA9PT0gXCJvYmplY3RcIlxuICAgICAgPyBwYXlsb2FkIGFzIHsgaWQ/OiB1bmtub3duOyBtZXRob2Q/OiB1bmtub3duOyBhcmdzPzogdW5rbm93biB9XG4gICAgICA6IHt9O1xuICAgIGNvbnN0IGlkID0gdHlwZW9mIHJlcXVlc3QuaWQgPT09IFwic3RyaW5nXCIgPyByZXF1ZXN0LmlkIDogXCJcIjtcbiAgICBjb25zdCBtZXRob2QgPSB0eXBlb2YgcmVxdWVzdC5tZXRob2QgPT09IFwic3RyaW5nXCIgPyByZXF1ZXN0Lm1ldGhvZCA6IFwiXCI7XG4gICAgY29uc3QgYXJncyA9IEFycmF5LmlzQXJyYXkocmVxdWVzdC5hcmdzKSA/IHJlcXVlc3QuYXJncyA6IFtdO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IHJ1bkJyb3dzZXJVaUJyaWRnZU1ldGhvZChtZXRob2QsIGFyZ3MsIHdvcmtlckxpc3RlbmVycyk7XG4gICAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfQlJJREdFX1JFU1BPTlNFLCB7IGlkLCBvazogdHJ1ZSwgdmFsdWUgfSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX0JSSURHRV9SRVNQT05TRSwge1xuICAgICAgICBpZCxcbiAgICAgICAgb2s6IGZhbHNlLFxuICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgfSk7XG4gICAgfVxuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihERVNLVE9QX01FU1NBR0VfRk9SX1ZJRVcsIChfZXZlbnQsIG1lc3NhZ2UpID0+IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfTUVTU0FHRV9GT1JfVklFVywgbWVzc2FnZSk7XG4gIH0pO1xuXG4gIGlwY1JlbmRlcmVyLm9uKERFU0tUT1BfU1lTVEVNX1RIRU1FX1VQREFURUQsIChfZXZlbnQsIHZhbHVlKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX1NZU1RFTV9USEVNRSwgdmFsdWUpO1xuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQnJvd3NlclVpQnJpZGdlTWV0aG9kKFxuICBtZXRob2Q6IHN0cmluZyxcbiAgYXJnczogdW5rbm93bltdLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogUHJvbWlzZTx1bmtub3duPiB7XG4gIHN3aXRjaCAobWV0aG9kKSB7XG4gICAgY2FzZSBcInNuYXBzaG90XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuc2VuZFN5bmMoREVTS1RPUF9HRVRfU0hBUkVEX09CSkVDVF9TTkFQU0hPVCkgPz8ge307XG4gICAgY2FzZSBcInN5c3RlbVRoZW1lXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuc2VuZFN5bmMoREVTS1RPUF9HRVRfU1lTVEVNX1RIRU1FX1ZBUklBTlQpO1xuICAgIGNhc2UgXCJzZW50cnlPcHRpb25zXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuc2VuZFN5bmMoREVTS1RPUF9HRVRfU0VOVFJZX0lOSVRfT1BUSU9OUyk7XG4gICAgY2FzZSBcImJ1aWxkRmxhdm9yXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuc2VuZFN5bmMoREVTS1RPUF9HRVRfQlVJTERfRkxBVk9SKTtcbiAgICBjYXNlIFwidXNlc093bEFwcFNoZWxsXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuc2VuZFN5bmMoREVTS1RPUF9HRVRfVVNFU19PV0xfQVBQX1NIRUxMKSA9PT0gdHJ1ZTtcbiAgICBjYXNlIFwic2VuZE1lc3NhZ2VGcm9tVmlld1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShERVNLVE9QX01FU1NBR0VfRlJPTV9WSUVXLCBhcmdzWzBdKTtcbiAgICBjYXNlIFwic2VuZFdvcmtlck1lc3NhZ2VGcm9tVmlld1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShkZXNrdG9wV29ya2VyRnJvbVZpZXdDaGFubmVsKFN0cmluZyhhcmdzWzBdKSksIGFyZ3NbMV0pO1xuICAgIGNhc2UgXCJzdWJzY3JpYmVXb3JrZXJNZXNzYWdlc1wiOlxuICAgICAgcmV0dXJuIHN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFN0cmluZyhhcmdzWzBdKSwgd29ya2VyTGlzdGVuZXJzKTtcbiAgICBjYXNlIFwidW5zdWJzY3JpYmVXb3JrZXJNZXNzYWdlc1wiOlxuICAgICAgcmV0dXJuIHVuc3Vic2NyaWJlQnJvd3NlclVpV29ya2VyTWVzc2FnZXMoU3RyaW5nKGFyZ3NbMF0pLCB3b3JrZXJMaXN0ZW5lcnMpO1xuICAgIGNhc2UgXCJzaG93Q29udGV4dE1lbnVcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9TSE9XX0NPTlRFWFRfTUVOVSwgYXJnc1swXSk7XG4gICAgY2FzZSBcInNob3dBcHBsaWNhdGlvbk1lbnVcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9TSE9XX0FQUExJQ0FUSU9OX01FTlUsIHtcbiAgICAgICAgbWVudUlkOiBhcmdzWzBdLFxuICAgICAgICB4OiBhcmdzWzFdLFxuICAgICAgICB5OiBhcmdzWzJdLFxuICAgICAgfSk7XG4gICAgY2FzZSBcImdldEZhc3RNb2RlUm9sbG91dE1ldHJpY3NcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9HRVRfRkFTVF9NT0RFX1JPTExPVVRfTUVUUklDUywgYXJnc1swXSk7XG4gICAgY2FzZSBcInRyaWdnZXJTZW50cnlUZXN0RXJyb3JcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9UUklHR0VSX1NFTlRSWV9URVNUKTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIFR3ZWFrZXJzIGJyb3dzZXIgVUkgYnJpZGdlIG1ldGhvZDogJHttZXRob2R9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gc3Vic2NyaWJlQnJvd3NlclVpV29ya2VyTWVzc2FnZXMoXG4gIHdvcmtlcklkOiBzdHJpbmcsXG4gIHdvcmtlckxpc3RlbmVyczogTWFwPHN0cmluZywgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZD4sXG4pOiBib29sZWFuIHtcbiAgaWYgKCEvXlthLXpBLVowLTkuXzotXSskLy50ZXN0KHdvcmtlcklkKSkgdGhyb3cgbmV3IEVycm9yKFwiaW52YWxpZCB3b3JrZXIgaWRcIik7XG4gIGlmICh3b3JrZXJMaXN0ZW5lcnMuaGFzKHdvcmtlcklkKSkgcmV0dXJuIHRydWU7XG4gIGNvbnN0IGxpc3RlbmVyID0gKF9ldmVudDogdW5rbm93biwgbWVzc2FnZTogdW5rbm93bikgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9XT1JLRVJfTUVTU0FHRSwgd29ya2VySWQsIG1lc3NhZ2UpO1xuICB9O1xuICB3b3JrZXJMaXN0ZW5lcnMuc2V0KHdvcmtlcklkLCBsaXN0ZW5lcik7XG4gIGlwY1JlbmRlcmVyLm9uKGRlc2t0b3BXb3JrZXJGb3JWaWV3Q2hhbm5lbCh3b3JrZXJJZCksIGxpc3RlbmVyKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIHVuc3Vic2NyaWJlQnJvd3NlclVpV29ya2VyTWVzc2FnZXMoXG4gIHdvcmtlcklkOiBzdHJpbmcsXG4gIHdvcmtlckxpc3RlbmVyczogTWFwPHN0cmluZywgKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdm9pZD4sXG4pOiBib29sZWFuIHtcbiAgY29uc3QgbGlzdGVuZXIgPSB3b3JrZXJMaXN0ZW5lcnMuZ2V0KHdvcmtlcklkKTtcbiAgaWYgKCFsaXN0ZW5lcikgcmV0dXJuIHRydWU7XG4gIHdvcmtlckxpc3RlbmVycy5kZWxldGUod29ya2VySWQpO1xuICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQpLCBsaXN0ZW5lcik7XG4gIHJldHVybiB0cnVlO1xufVxuIiwgIi8qKlxuICogSW5zdGFsbCBhIG1pbmltYWwgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fLiBSZWFjdCBjYWxsc1xuICogYGhvb2suaW5qZWN0KHJlbmRlcmVySW50ZXJuYWxzKWAgZHVyaW5nIGBjcmVhdGVSb290YC9gaHlkcmF0ZVJvb3RgLiBUaGVcbiAqIFwiaW50ZXJuYWxzXCIgb2JqZWN0IGV4cG9zZXMgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2UsIHdoaWNoIGxldHMgdXMgdHVybiBhXG4gKiBET00gbm9kZSBpbnRvIGEgUmVhY3QgZmliZXIgXHUyMDE0IG5lY2Vzc2FyeSBmb3Igb3VyIFNldHRpbmdzIGluamVjdG9yLlxuICpcbiAqIFdlIGRvbid0IHdhbnQgdG8gYnJlYWsgcmVhbCBSZWFjdCBEZXZUb29scyBpZiB0aGUgdXNlciBvcGVucyBpdDsgd2UgaW5zdGFsbFxuICogb25seSBpZiBubyBob29rIGV4aXN0cyB5ZXQsIGFuZCB3ZSBmb3J3YXJkIGNhbGxzIHRvIGEgZG93bnN0cmVhbSBob29rIGlmXG4gKiBvbmUgaXMgbGF0ZXIgYXNzaWduZWQuXG4gKi9cbmRlY2xhcmUgZ2xvYmFsIHtcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XG4gICAgX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fPzogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgX190d2Vha2VyX18/OiB7XG4gICAgICBob29rOiBSZWFjdERldnRvb2xzSG9vaztcbiAgICAgIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICAgIH07XG4gIH1cbn1cblxuaW50ZXJmYWNlIFJlbmRlcmVySW50ZXJuYWxzIHtcbiAgZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/OiAobjogTm9kZSkgPT4gdW5rbm93bjtcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgYnVuZGxlVHlwZT86IG51bWJlcjtcbiAgcmVuZGVyZXJQYWNrYWdlTmFtZT86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFJlYWN0RGV2dG9vbHNIb29rIHtcbiAgc3VwcG9ydHNGaWJlcjogdHJ1ZTtcbiAgcmVuZGVyZXJzOiBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz47XG4gIG9uKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgb2ZmKGV2ZW50OiBzdHJpbmcsIGZuOiAoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkKTogdm9pZDtcbiAgZW1pdChldmVudDogc3RyaW5nLCAuLi5hOiB1bmtub3duW10pOiB2b2lkO1xuICBpbmplY3QocmVuZGVyZXI6IFJlbmRlcmVySW50ZXJuYWxzKTogbnVtYmVyO1xuICBvblNjaGVkdWxlRmliZXJSb290PygpOiB2b2lkO1xuICBvbkNvbW1pdEZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclVubW91bnQ/KCk6IHZvaWQ7XG4gIGNoZWNrRENFPygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaW5zdGFsbFJlYWN0SG9vaygpOiB2b2lkIHtcbiAgaWYgKHdpbmRvdy5fX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX18pIHJldHVybjtcbiAgY29uc3QgcmVuZGVyZXJzID0gbmV3IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPigpO1xuICBsZXQgbmV4dElkID0gMTtcbiAgY29uc3QgbGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsIFNldDwoLi4uYTogdW5rbm93bltdKSA9PiB2b2lkPj4oKTtcblxuICBjb25zdCBob29rOiBSZWFjdERldnRvb2xzSG9vayA9IHtcbiAgICBzdXBwb3J0c0ZpYmVyOiB0cnVlLFxuICAgIHJlbmRlcmVycyxcbiAgICBpbmplY3QocmVuZGVyZXIpIHtcbiAgICAgIGNvbnN0IGlkID0gbmV4dElkKys7XG4gICAgICByZW5kZXJlcnMuc2V0KGlkLCByZW5kZXJlcik7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgY29uc29sZS5kZWJ1ZyhcbiAgICAgICAgXCJbdHdlYWtlcl0gUmVhY3QgcmVuZGVyZXIgYXR0YWNoZWQ6XCIsXG4gICAgICAgIHJlbmRlcmVyLnJlbmRlcmVyUGFja2FnZU5hbWUsXG4gICAgICAgIHJlbmRlcmVyLnZlcnNpb24sXG4gICAgICApO1xuICAgICAgcmV0dXJuIGlkO1xuICAgIH0sXG4gICAgb24oZXZlbnQsIGZuKSB7XG4gICAgICBsZXQgcyA9IGxpc3RlbmVycy5nZXQoZXZlbnQpO1xuICAgICAgaWYgKCFzKSBsaXN0ZW5lcnMuc2V0KGV2ZW50LCAocyA9IG5ldyBTZXQoKSkpO1xuICAgICAgcy5hZGQoZm4pO1xuICAgIH0sXG4gICAgb2ZmKGV2ZW50LCBmbikge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmRlbGV0ZShmbik7XG4gICAgfSxcbiAgICBlbWl0KGV2ZW50LCAuLi5hcmdzKSB7XG4gICAgICBsaXN0ZW5lcnMuZ2V0KGV2ZW50KT8uZm9yRWFjaCgoZm4pID0+IGZuKC4uLmFyZ3MpKTtcbiAgICB9LFxuICAgIG9uQ29tbWl0RmliZXJSb290KCkge30sXG4gICAgb25Db21taXRGaWJlclVubW91bnQoKSB7fSxcbiAgICBvblNjaGVkdWxlRmliZXJSb290KCkge30sXG4gICAgY2hlY2tEQ0UoKSB7fSxcbiAgfTtcblxuICBPYmplY3QuZGVmaW5lUHJvcGVydHkod2luZG93LCBcIl9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfX1wiLCB7XG4gICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICAgIGVudW1lcmFibGU6IGZhbHNlLFxuICAgIHdyaXRhYmxlOiB0cnVlLCAvLyBhbGxvdyByZWFsIERldlRvb2xzIHRvIG92ZXJ3cml0ZSBpZiB1c2VyIGluc3RhbGxzIGl0XG4gICAgdmFsdWU6IGhvb2ssXG4gIH0pO1xuXG4gIHdpbmRvdy5fX3R3ZWFrZXJfXyA9IHsgaG9vaywgcmVuZGVyZXJzIH07XG59XG5cbi8qKiBSZXNvbHZlIHRoZSBSZWFjdCBmaWJlciBmb3IgYSBET00gbm9kZSwgaWYgYW55IHJlbmRlcmVyIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZmliZXJGb3JOb2RlKG5vZGU6IE5vZGUpOiB1bmtub3duIHwgbnVsbCB7XG4gIGNvbnN0IHJlbmRlcmVycyA9IHdpbmRvdy5fX3R3ZWFrZXJfXz8ucmVuZGVyZXJzO1xuICBpZiAocmVuZGVyZXJzKSB7XG4gICAgZm9yIChjb25zdCByIG9mIHJlbmRlcmVycy52YWx1ZXMoKSkge1xuICAgICAgY29uc3QgZiA9IHIuZmluZEZpYmVyQnlIb3N0SW5zdGFuY2U/Lihub2RlKTtcbiAgICAgIGlmIChmKSByZXR1cm4gZjtcbiAgICB9XG4gIH1cbiAgLy8gRmFsbGJhY2s6IHJlYWQgdGhlIFJlYWN0IGludGVybmFsIHByb3BlcnR5IGRpcmVjdGx5IGZyb20gdGhlIERPTSBub2RlLlxuICAvLyBSZWFjdCBzdG9yZXMgZmliZXJzIGFzIGEgcHJvcGVydHkgd2hvc2Uga2V5IHN0YXJ0cyB3aXRoIFwiX19yZWFjdEZpYmVyXCIuXG4gIGZvciAoY29uc3QgayBvZiBPYmplY3Qua2V5cyhub2RlKSkge1xuICAgIGlmIChrLnN0YXJ0c1dpdGgoXCJfX3JlYWN0RmliZXJcIikpIHJldHVybiAobm9kZSBhcyB1bmtub3duIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KVtrXTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cbiIsICIvKipcbiAqIFNldHRpbmdzIGluamVjdG9yIGZvciBDb2RleCdzIFNldHRpbmdzIHBhZ2UuXG4gKlxuICogQ29kZXgncyBzZXR0aW5ncyBpcyBhIHJvdXRlZCBwYWdlIChVUkwgc3RheXMgYXQgYC9pbmRleC5odG1sP2hvc3RJZD1sb2NhbGApXG4gKiBOT1QgYSBtb2RhbCBkaWFsb2cuIFRoZSBzaWRlYmFyIGxpdmVzIGluc2lkZSBhIGA8ZGl2IGNsYXNzPVwiZmxleCBmbGV4LWNvbFxuICogZ2FwLTEgZ2FwLTBcIj5gIHdyYXBwZXIgdGhhdCBob2xkcyBvbmUgb3IgbW9yZSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC1weFwiPmAgZ3JvdXBzIG9mIGJ1dHRvbnMuIFRoZXJlIGFyZSBubyBzdGFibGUgYHJvbGVgIC8gYGFyaWEtbGFiZWxgIC9cbiAqIGBkYXRhLXRlc3RpZGAgaG9va3Mgb24gdGhlIHNoZWxsIHNvIHdlIGlkZW50aWZ5IHRoZSBzaWRlYmFyIGJ5IHRleHQtY29udGVudFxuICogbWF0Y2ggYWdhaW5zdCBrbm93biBpdGVtIGxhYmVscyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgQ29uZmlndXJhdGlvbiwgXHUyMDI2KS5cbiAqXG4gKiBMYXlvdXQgd2UgaW5qZWN0OlxuICpcbiAqICAgR0VORVJBTCAgICAgICAgICAgICAgICAgICAgICAgKHVwcGVyY2FzZSBncm91cCBsYWJlbClcbiAqICAgW0NvZGV4J3MgZXhpc3RpbmcgaXRlbXMgZ3JvdXBdXG4gKiAgIFRXRUFLRVJTICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFx1MjREOCBDb25maWdcbiAqICAgXHUyNjMwIFR3ZWFrc1xuICogICBcdTI1QzcgVHdlYWsgU3RvcmVcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgLyBUd2VhayBTdG9yZSBoaWRlcyBDb2RleCdzIGNvbnRlbnQgcGFuZWwgY2hpbGRyZW4gYW5kIHJlbmRlcnNcbiAqIG91ciBvd24gYG1haW4tc3VyZmFjZWAgcGFuZWwgaW4gdGhlaXIgcGxhY2UuIENsaWNraW5nIGFueSBvZiBDb2RleCdzXG4gKiBzaWRlYmFyIGl0ZW1zIHJlc3RvcmVzIHRoZSBvcmlnaW5hbCB2aWV3LlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFNldHRpbmdzU2VjdGlvbixcbiAgU2V0dGluZ3NQYWdlLFxuICBTZXR0aW5nc0hhbmRsZSxcbiAgVHdlYWtNYW5pZmVzdCxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRUd2Vha1B1Ymxpc2hJc3N1ZVVybCxcbiAgdHlwZSBUd2Vha0hlYWx0aFJlY29yZCxcbiAgdHlwZSBUd2Vha1N0YXR1cyxcbiAgdHlwZSBUd2Vha1N0b3JlRW50cnksXG4gIHR5cGUgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uLFxufSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcbmltcG9ydCB7XG4gIGJ1aWxkU2V0dGluZ3NOYXZpZ2F0aW9uTW9kZWwsXG4gIHR5cGUgU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSxcbn0gZnJvbSBcIi4vc2V0dGluZ3MtcGFnZS1tb2RlbFwiO1xuaW1wb3J0IHtcbiAgZmlsdGVyVHdlYWtzUGFnZUl0ZW1zLFxuICBUV0VBS1NfUEFHRV9GSUxURVJTLFxuICB0d2Vha3NQYWdlQ291bnRzLFxuICB0eXBlIFR3ZWFrc1BhZ2VGaWx0ZXIsXG59IGZyb20gXCIuL3R3ZWFrcy1wYWdlLW1vZGVsXCI7XG5pbXBvcnQge1xuICBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3IsXG4gIGNyZWF0ZUVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcixcbiAgZGVza3RvcFVwZGF0ZVN0YXR1c1ByZXNlbnRhdGlvbixcbiAgcmVzdG9yZUVudmlyb25tZW50Rm9jdXMsXG4gIHR5cGUgRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbixcbn0gZnJvbSBcIi4vZW52aXJvbm1lbnQtY29uZmlnLWNvbnRyb2xsZXJcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ29kZXhDbGlMYW5lLFxuICBDb2RleENsaVZlcnNpb25TdGF0ZSxcbiAgQ29kZXhGZWF0dXJlRW50cnksXG4gIENvZGV4RmVhdHVyZVN0YWdlLFxuICBDb2RleEluc3RhbGxQcm9ncmVzcyxcbiAgQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxufSBmcm9tIFwiLi4vY29kZXgtdmVyc2lvbi10eXBlc1wiO1xuXG5jb25zdCBUV0VBS0VSU19SRUxFQVNFU19VUkwgPSBcImh0dHBzOi8vZ2l0aHViLmNvbS90aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzL3JlbGVhc2VzXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIGhlYWx0aDogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xuICBjYXRhbG9nOiBUd2Vha1N0b3JlRW50cnkgfCBudWxsO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBsaWZlY3ljbGVPdmVycmlkZT86IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl07XG59XG5cbmludGVyZmFjZSBUd2Vha1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtWZXJzaW9uRHJpZnRSb3cge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIGhhc01jcDogYm9vbGVhbjtcbiAgbGl2ZVZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJ1bnRpbWVWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICBjYXRhbG9nVmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBcImN1cnJlbnRcIiB8IFwiZHJpZnRcIiB8IFwibWlzc2luZ1wiO1xuICByZWFzb246IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFR3ZWFrSGVhbHRoU25hcHNob3Qge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY2F0YWxvZ0NvdW50OiBudW1iZXI7XG4gIGluc3RhbGxlZENvdW50OiBudW1iZXI7XG4gIGVuYWJsZWRDb3VudDogbnVtYmVyO1xuICBsaXZlRHJpZnRDb3VudDogbnVtYmVyO1xuICBydW50aW1lRHJpZnRDb3VudDogbnVtYmVyO1xuICBtaXNzaW5nTGl2ZUNvdW50OiBudW1iZXI7XG4gIG1pc3NpbmdSdW50aW1lQ291bnQ6IG51bWJlcjtcbiAgbWNwUmVzdGFydFJlcXVpcmVkOiBib29sZWFuO1xuICByb3dzOiBUd2Vha1ZlcnNpb25EcmlmdFJvd1tdO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtlckNvbmZpZyB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgdXBkYXRlQ2hhbm5lbDogU2VsZlVwZGF0ZUNoYW5uZWw7XG4gIHVwZGF0ZVJlcG86IHN0cmluZztcbiAgdXBkYXRlUmVmOiBzdHJpbmc7XG4gIHVwZGF0ZUNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBzZWxmVXBkYXRlOiBTZWxmVXBkYXRlU3RhdGUgfCBudWxsO1xuICBpbnN0YWxsYXRpb25Tb3VyY2U6IEluc3RhbGxhdGlvblNvdXJjZTtcbn1cblxuaW50ZXJmYWNlIFR3ZWFrZXJVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlTm90ZXM6IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbnR5cGUgU2VsZlVwZGF0ZUNoYW5uZWwgPSBcInN0YWJsZVwiIHwgXCJwcmVyZWxlYXNlXCIgfCBcImN1c3RvbVwiO1xudHlwZSBTZWxmVXBkYXRlU3RhdHVzID0gXCJjaGVja2luZ1wiIHwgXCJ1cC10by1kYXRlXCIgfCBcInVwZGF0ZWRcIiB8IFwiZmFpbGVkXCIgfCBcImRpc2FibGVkXCI7XG5cbmludGVyZmFjZSBTZWxmVXBkYXRlU3RhdGUge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG4gIHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgdGFyZ2V0UmVmOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZXBvOiBzdHJpbmc7XG4gIGNoYW5uZWw6IFNlbGZVcGRhdGVDaGFubmVsO1xuICBzb3VyY2VSb290OiBzdHJpbmc7XG4gIGluc3RhbGxhdGlvblNvdXJjZT86IEluc3RhbGxhdGlvblNvdXJjZTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBJbnN0YWxsYXRpb25Tb3VyY2Uge1xuICBraW5kOiBcImdpdGh1Yi1zb3VyY2VcIiB8IFwiaG9tZWJyZXdcIiB8IFwibG9jYWwtZGV2XCIgfCBcInNvdXJjZS1hcmNoaXZlXCIgfCBcInVua25vd25cIjtcbiAgbGFiZWw6IHN0cmluZztcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbnR5cGUgRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlID0gXCJjaGF0Z3B0XCIgfCBcInR3ZWFrZXJzXCI7XG50eXBlIEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUgPSBcInN0YWJsZVwiIHwgXCJhbHBoYVwiO1xuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRTZWxlY3Rpb24ge1xuICBhcHBFeHBlcmllbmNlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2U7XG4gIHJlbGVhc2VQcm9maWxlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlO1xuICBzZWxlY3RlZERlc2t0b3BQYXRoPzogc3RyaW5nO1xuICBzZWxlY3RlZERlc2t0b3BCdW5kbGVJZD86IHN0cmluZztcbiAgYmFja2VuZExhbmU/OiBzdHJpbmc7XG4gIHJlcXVlc3RlZEF0Pzogc3RyaW5nO1xuICBhcHBsaWVkQXQ/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRDaGFubmVsU3RhdHVzIHtcbiAgYXZhaWxhYmxlOiBib29sZWFuO1xuICB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXTtcbiAgYXZhaWxhYmlsaXR5PzogUmVjb3JkPEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSwge1xuICAgIGF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXTtcbiAgfT47XG4gIHNlbGVjdGVkRGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gIHNlbGVjdGVkRGVza3RvcEJ1bmRsZUlkPzogc3RyaW5nO1xuICByZWxlYXNlUHJvZmlsZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZTtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50U3RhdHVzIHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICBjaGFubmVsczogUmVjb3JkPEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUsIEVudmlyb25tZW50Q2hhbm5lbFN0YXR1cz47XG4gIG9ic2VydmF0aW9uPzoge1xuICAgIGFwcEV4cGVyaWVuY2U6IEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSB8IG51bGw7XG4gICAgc2VsZWN0aW9uRHJpZnQ6IGJvb2xlYW47XG4gICAgbGlmZWN5Y2xlQ29udGVuZGVkOiBib29sZWFuO1xuICAgIGNvbW1pdEpvdXJuYWxQcmVzZW50OiBib29sZWFuO1xuICAgIHRyYW5zaXRpb25Kb3VybmFsUHJlc2VudDogYm9vbGVhbjtcbiAgICBmcmVzaG5lc3M6IFwiY3VycmVudFwiIHwgXCJjb250ZW5kZWRcIjtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbiB7XG4gIGtpbmQ/OiBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIjtcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nO1xuICBwaGFzZTogXCJzdWJtaXR0ZWRcIiB8IFwic3VibWl0LWZhaWxlZFwiO1xuICBlcnJvcj86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudEhlbHBlck91dGNvbWUge1xuICBwaGFzZT86IFwibm90LXN0YXJ0ZWRcIiB8IFwicnVubmluZ1wiIHwgXCJzdWNjZWVkZWRcIiB8IFwiZmFpbGVkXCI7XG4gIGV4aXRDb2RlPzogbnVtYmVyIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRIZWxwZXJTdGF0dXMge1xuICBzdWJtaXNzaW9uPzogRW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uIHwgbnVsbDtcbiAgb3V0Y29tZT86IEVudmlyb25tZW50SGVscGVyT3V0Y29tZSB8IG51bGw7XG4gIHN0ZG91dD86IHN0cmluZyB8IG51bGw7XG4gIHN0ZGVycj86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFRyYW5zYWN0aW9uIHtcbiAgc2NoZW1hVmVyc2lvbj86IDE7XG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZztcbiAgcGhhc2U6IHN0cmluZztcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG4gIHNvdXJjZT86IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICByZXF1ZXN0ZWQ/OiBFbnZpcm9ubWVudFNlbGVjdGlvbjtcbiAgcHJlcGFyZWQ/OiB7XG4gICAgY2FuZGlkYXRlPzoge1xuICAgICAgZGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gICAgICBidW5kbGVJZD86IHN0cmluZztcbiAgICAgIHZlcnNpb24/OiBzdHJpbmc7XG4gICAgICBidWlsZD86IHN0cmluZztcbiAgICB9O1xuICAgIGJhY2tlbmQ/OiB7XG4gICAgICBsYW5lPzogc3RyaW5nO1xuICAgICAgYmluYXJ5UGF0aD86IHN0cmluZztcbiAgICAgIHZlcnNpb24/OiBzdHJpbmc7XG4gICAgfTtcbiAgICByb2xsYmFjaz86IHtcbiAgICAgIHNlbGVjdGlvbj86IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICAgICAgZGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gICAgICBiYWNrZW5kTGFuZT86IHN0cmluZztcbiAgICB9O1xuICB9IHwgbnVsbDtcbiAgaGVscGVyPzogRW52aXJvbm1lbnRIZWxwZXJTdGF0dXMgfCBudWxsO1xuICB1cGRhdGVkQXQ/OiBzdHJpbmc7XG4gIC8qKiBPdXRwdXQtb25seSBhbm5vdGF0aW9uIGZyb20gdGhlIENMSTogbGl2ZW5lc3Mgb2YgdGhlIHJlY29yZGVkIG93bmVyIFBJRC4gKi9cbiAgb3duZXJBbGl2ZT86IGJvb2xlYW47XG59XG5cbmludGVyZmFjZSBNY3BTeW5jU3RhdGUge1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIGNoZWNrZWRBdD86IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG4gIGRlc2lyZWROYW1lcz86IHN0cmluZ1tdO1xuICBhcHBsaWVkTmFtZXM/OiBzdHJpbmdbXTtcbiAgY29uZmxpY3RzPzogQXJyYXk8e1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgb2JzZXJ2ZWROYW1lPzogc3RyaW5nO1xuICAgIGNhbm9uaWNhbE5hbWU/OiBzdHJpbmc7XG4gICAgZGV0YWlsPzogc3RyaW5nO1xuICAgIHJlYXNvbj86IHN0cmluZztcbiAgfT47XG4gIHJlc3RhcnRSZXF1aXJlZD86IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRGVza3RvcFVwZGF0ZUNoZWNrUmVzdWx0IHtcbiAgc3RhdHVzPzogXCJ1cGRhdGUtYXZhaWxhYmxlXCIgfCBcImN1cnJlbnRcIiB8IFwic3RhbGVcIiB8IFwidW5hdmFpbGFibGVcIiB8IFwiZXJyb3JcIjtcbiAgcHJvZmlsZT86IFwic3RhYmxlXCIgfCBcImFscGhhXCIgfCBudWxsO1xuICBpbnN0YWxsZWQ/OiB7IG1hcmtldGluZ1ZlcnNpb24/OiBzdHJpbmcgfCBudWxsOyBidWlsZD86IHN0cmluZyB8IG51bGwgfTtcbiAgbGF0ZXN0PzogeyBtYXJrZXRpbmdWZXJzaW9uPzogc3RyaW5nIHwgbnVsbDsgYnVpbGQ/OiBzdHJpbmcgfCBudWxsIH07XG4gIHJlYXNvbj86IHN0cmluZyB8IG51bGw7XG4gIGNoZWNrZWRBdD86IHN0cmluZztcbiAgdXBkYXRlQW5kUmVsb2FkUmVxdWVzdGVkPzogYm9vbGVhbjtcbiAgbmF0aXZlVXBkYXRlQ29udHJvbEFjdGl2ZT86IGJvb2xlYW47XG4gIGphdmFTY3JpcHRVcGRhdGVyTWFuYWdlckF2YWlsYWJsZT86IGJvb2xlYW47XG4gIGphdmFTY3JpcHRVcGRhdGVyTWFuYWdlclJlYXNvbj86IHN0cmluZyB8IG51bGw7XG4gIHNldHVwUmVxdWlyZWQ/OiBcInJlZ2lzdGVyLWJldGFcIiB8IFwibGF1bmNoLWJldGFcIiB8IG51bGw7XG59XG5cbmludGVyZmFjZSBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSB7XG4gIHNjaGVtYVZlcnNpb24/OiAxO1xuICBraW5kPzogXCJkZXNrdG9wLXVwZGF0ZVwiO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmcgfCBudWxsO1xuICBwaGFzZTogc3RyaW5nO1xuICBvd25lclBpZD86IG51bWJlcjtcbiAgc2FmZU9mZmljaWFsTW9kZT86IGJvb2xlYW47XG4gIHJlc3VtYWJsZT86IGJvb2xlYW47XG4gIG5hdGl2ZVVwZGF0ZUhhbmRvZmZBdD86IHN0cmluZyB8IG51bGw7XG4gIHJlZnJlc2hTb3VyY2U/OiBcImRldmVsb3BtZW50XCIgfCBcInN0YWJsZVwiIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVkQXQ/OiBzdHJpbmc7XG4gIHRlcm1pbmFsQXQ/OiBzdHJpbmcgfCBudWxsO1xuICAvKiogT3V0cHV0LW9ubHkgYW5ub3RhdGlvbiBmcm9tIHRoZSBDTEk6IGxpdmVuZXNzIG9mIHRoZSByZWNvcmRlZCBvd25lciBQSUQuICovXG4gIG93bmVyQWxpdmU/OiBib29sZWFuIHwgbnVsbDtcbn1cblxudHlwZSBDb2RleFVpUmVsb2FkID0gKG1vZGU/OiBcIm9wZXJhdGlvbi1zdGFydFwiIHwgXCJvcGVyYXRpb24tc3RvcFwiKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbiAgbGF0ZXN0Q29tcGxldGVkQ3ljbGU/OiBXYXRjaGVyQ3ljbGVSZWNlaXB0O1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckN5Y2xlUmVjZWlwdCB7XG4gIGN5Y2xlSWQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ6IHN0cmluZztcbiAgb3V0Y29tZTogXCJjb21wbGV0ZWRcIiB8IFwiZmFpbGVkXCI7XG4gIHJlcGFpcjogeyBzdGF0dXM6IFwic3VjY2VlZGVkXCIgfCBcImZhaWxlZFwiIHwgXCJza2lwcGVkXCIgfCBcInBlbmRpbmdcIjsgZXJyb3I6IHN0cmluZyB8IG51bGwgfTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgZ2VuZXJhdGVkQXQ/OiBzdHJpbmc7XG4gIHNvdXJjZVVybDogc3RyaW5nO1xuICBmZXRjaGVkQXQ6IHN0cmluZztcbiAgZW50cmllczogVHdlYWtTdG9yZUVudHJ5Vmlld1tdO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtTdG9yZUVudHJ5VmlldyBleHRlbmRzIFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGluc3RhbGxlZDoge1xuICAgIHZlcnNpb246IHN0cmluZztcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICB9IHwgbnVsbDtcbiAgcGxhdGZvcm0/OiB7XG4gICAgY3VycmVudDogc3RyaW5nO1xuICAgIHN1cHBvcnRlZDogc3RyaW5nW10gfCBudWxsO1xuICAgIGNvbXBhdGlibGU6IGJvb2xlYW47XG4gICAgcmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICB9O1xuICBydW50aW1lPzoge1xuICAgIGN1cnJlbnQ6IHN0cmluZztcbiAgICByZXF1aXJlZDogc3RyaW5nIHwgbnVsbDtcbiAgICBjb21wYXRpYmxlOiBib29sZWFuO1xuICAgIHJlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgfTtcbn1cblxuLyoqXG4gKiBBIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZS4gV2UgY2FycnkgdGhlIG93bmluZyB0d2VhaydzIG1hbmlmZXN0IHNvIHdlIGNhblxuICogcmVzb2x2ZSByZWxhdGl2ZSBpY29uVXJscyBhbmQgc2hvdyBhdXRob3JzaGlwIGluIHRoZSBwYWdlIGhlYWRlci5cbiAqL1xuaW50ZXJmYWNlIFJlZ2lzdGVyZWRQYWdlIHtcbiAgLyoqIEZ1bGx5LXF1YWxpZmllZCBpZDogYDx0d2Vha0lkPjo8cGFnZUlkPmAuICovXG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIHBhZ2U6IFNldHRpbmdzUGFnZTtcbiAgLyoqIFBlci1wYWdlIERPTSB0ZWFyZG93biByZXR1cm5lZCBieSBgcGFnZS5yZW5kZXJgLCBpZiBhbnkuICovXG4gIHRlYXJkb3duPzogKCgpID0+IHZvaWQpIHwgbnVsbDtcbiAgLyoqIFRoZSBpbmplY3RlZCBzaWRlYmFyIGJ1dHRvbiAoc28gd2UgY2FuIHVwZGF0ZSBpdHMgYWN0aXZlIHN0YXRlKS4gKi9cbiAgbmF2QnV0dG9uPzogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAvKiogSWRlbnRpdHkgdG9rZW4gcHJldmVudHMgYW4gb2xkIGhhbmRsZSBmcm9tIHVucmVnaXN0ZXJpbmcgYSByZXBsYWNlbWVudC4gKi9cbiAgcmVnaXN0cmF0aW9uVG9rZW46IHN5bWJvbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwic3RvcmVcIiB9XG4gIHwgeyBraW5kOiBcInR3ZWFrc1wiIH1cbiAgfCB7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiOyBpZDogc3RyaW5nIH07XG5cbmludGVyZmFjZSBJbmplY3RvclN0YXRlIHtcbiAgc2VjdGlvbnM6IE1hcDxzdHJpbmcsIFNldHRpbmdzU2VjdGlvbj47XG4gIHNlY3Rpb25Ub2tlbnM6IE1hcDxzdHJpbmcsIHN5bWJvbD47XG4gIHBhZ2VzOiBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkUGFnZT47XG4gIGxpc3RlZFR3ZWFrczogTGlzdGVkVHdlYWtbXTtcbiAgLyoqIE91dGVyIHdyYXBwZXIgdGhhdCBob2xkcyBDb2RleCdzIGl0ZW1zIGdyb3VwICsgb3VyIGluamVjdGVkIGdyb3Vwcy4gKi9cbiAgb3V0ZXJXcmFwcGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJHZW5lcmFsXCIgbGFiZWwgZm9yIENvZGV4J3MgbmF0aXZlIHNldHRpbmdzIGdyb3VwLiAqL1xuICBuYXRpdmVOYXZIZWFkZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrZXJzXCIgbmF2IGdyb3VwIChDb25maWcvVHdlYWtzKS4gKi9cbiAgbmF2R3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgbmF2QnV0dG9uczogUGFydGlhbDxSZWNvcmQ8QnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50Pj4gfCBudWxsO1xuICAvKiogU2lkZWJhciB1cGRhdGUgcGlsbCBzaG93biBvbmx5IHdoZW4gR2l0SHViIGhhcyBhIG5ld2VyIFR3ZWFrZXJzIHJlbGVhc2UuICovXG4gIHR3ZWFrZXJVcGRhdGVCdXR0b246IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFnZU5hdkJ1dHRvbnM6IE1hcDxzdHJpbmcsIEhUTUxCdXR0b25FbGVtZW50PjtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG4gIHR3ZWFrU3RvcmU6IFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXcgfCBudWxsO1xuICB0d2Vha1N0b3JlUHJvbWlzZTogUHJvbWlzZTxUd2Vha1N0b3JlUmVnaXN0cnlWaWV3PiB8IG51bGw7XG4gIHR3ZWFrU3RvcmVFcnJvcjogdW5rbm93bjtcbiAgdHdlYWtzUGFnZUZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcjtcbiAgdHdlYWtzUGFnZVF1ZXJ5OiBzdHJpbmc7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBzZWN0aW9uVG9rZW5zOiBuZXcgTWFwKCksXG4gIHBhZ2VzOiBuZXcgTWFwKCksXG4gIGxpc3RlZFR3ZWFrczogW10sXG4gIG91dGVyV3JhcHBlcjogbnVsbCxcbiAgbmF0aXZlTmF2SGVhZGVyOiBudWxsLFxuICBuYXZHcm91cDogbnVsbCxcbiAgbmF2QnV0dG9uczogbnVsbCxcbiAgdHdlYWtlclVwZGF0ZUJ1dHRvbjogbnVsbCxcbiAgcGFnZXNHcm91cDogbnVsbCxcbiAgcGFnZXNHcm91cEtleTogbnVsbCxcbiAgcGFnZU5hdkJ1dHRvbnM6IG5ldyBNYXAoKSxcbiAgcGFuZWxIb3N0OiBudWxsLFxuICBvYnNlcnZlcjogbnVsbCxcbiAgZmluZ2VycHJpbnQ6IG51bGwsXG4gIHNpZGViYXJEdW1wZWQ6IGZhbHNlLFxuICBhY3RpdmVQYWdlOiBudWxsLFxuICBzaWRlYmFyUm9vdDogbnVsbCxcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiBudWxsLFxuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBmYWxzZSxcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBudWxsLFxuICB0d2Vha1N0b3JlOiBudWxsLFxuICB0d2Vha1N0b3JlUHJvbWlzZTogbnVsbCxcbiAgdHdlYWtTdG9yZUVycm9yOiBudWxsLFxuICB0d2Vha3NQYWdlRmlsdGVyOiBcImFsbFwiLFxuICB0d2Vha3NQYWdlUXVlcnk6IFwiXCIsXG59O1xuXG5sZXQgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcGxvZyhtc2c6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYFtzZXR0aW5ncy1pbmplY3Rvcl0gJHttc2d9JHtleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSl9YCxcbiAgKTtcbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRTZXR0aW5nc0luamVjdG9yKCk6IHZvaWQge1xuICBpZiAoc3RhdGUub2JzZXJ2ZXIpIHJldHVybjtcblxuICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gIH0pO1xuICBvYnMub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICBzdGF0ZS5vYnNlcnZlciA9IG9icztcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsIG9uTmF2KTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJoYXNoY2hhbmdlXCIsIG9uTmF2KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uRG9jdW1lbnRDbGljaywgdHJ1ZSk7XG4gIGZvciAoY29uc3QgbSBvZiBbXCJwdXNoU3RhdGVcIiwgXCJyZXBsYWNlU3RhdGVcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBvcmlnID0gaGlzdG9yeVttXTtcbiAgICBoaXN0b3J5W21dID0gZnVuY3Rpb24gKHRoaXM6IEhpc3RvcnksIC4uLmFyZ3M6IFBhcmFtZXRlcnM8dHlwZW9mIG9yaWc+KSB7XG4gICAgICBjb25zdCByID0gb3JpZy5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChgdHdlYWtlci0ke219YCkpO1xuICAgICAgcmV0dXJuIHI7XG4gICAgfSBhcyB0eXBlb2Ygb3JpZztcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihgdHdlYWtlci0ke219YCwgb25OYXYpO1xuICB9XG5cbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xuICBsZXQgdGlja3MgPSAwO1xuICBjb25zdCBpbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICB0aWNrcysrO1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICAgIGlmICh0aWNrcyA+IDYwKSBjbGVhckludGVydmFsKGludGVydmFsKTtcbiAgfSwgNTAwKTtcbn1cblxuZnVuY3Rpb24gb25OYXYoKTogdm9pZCB7XG4gIHN0YXRlLmZpbmdlcnByaW50ID0gbnVsbDtcbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xufVxuXG5mdW5jdGlvbiBvbkRvY3VtZW50Q2xpY2soZTogTW91c2VFdmVudCk6IHZvaWQge1xuICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgPyBlLnRhcmdldCA6IG51bGw7XG4gIGNvbnN0IGNvbnRyb2wgPSB0YXJnZXQ/LmNsb3Nlc3QoXCJbcm9sZT0nbGluayddLGJ1dHRvbixhXCIpO1xuICBpZiAoIShjb250cm9sIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XG4gIGlmIChjb21wYWN0U2V0dGluZ3NUZXh0KGNvbnRyb2wudGV4dENvbnRlbnQgfHwgXCJcIikgIT09IFwiQmFjayB0byBhcHBcIikgcmV0dXJuO1xuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcImJhY2stdG8tYXBwXCIpO1xuICB9LCAwKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2VjdGlvbihzZWN0aW9uOiBTZXR0aW5nc1NlY3Rpb24pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IHJlZ2lzdHJhdGlvblRva2VuID0gU3ltYm9sKHNlY3Rpb24uaWQpO1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIHN0YXRlLnNlY3Rpb25Ub2tlbnMuc2V0KHNlY3Rpb24uaWQsIHJlZ2lzdHJhdGlvblRva2VuKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnNlY3Rpb25Ub2tlbnMuZ2V0KHNlY3Rpb24uaWQpICE9PSByZWdpc3RyYXRpb25Ub2tlbikgcmV0dXJuO1xuICAgICAgc3RhdGUuc2VjdGlvbnMuZGVsZXRlKHNlY3Rpb24uaWQpO1xuICAgICAgc3RhdGUuc2VjdGlvblRva2Vucy5kZWxldGUoc2VjdGlvbi5pZCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJTZWN0aW9ucygpOiB2b2lkIHtcbiAgc3RhdGUuc2VjdGlvbnMuY2xlYXIoKTtcbiAgc3RhdGUuc2VjdGlvblRva2Vucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gRXhwbGljaXQgcGFnZXMgbWF5IGRpc2FwcGVhciBicmllZmx5IGR1cmluZyBhIGhvdCByZWxvYWQuIEtlZXAgdGhlIHN0YWJsZVxuICAvLyB0d2Vhay1sZXZlbCBwYWdlIGFjdGl2ZSBhbmQgcmVuZGVyIGl0cyBmYWxsYmFjayBpbnN0ZWFkIG9mIGVqZWN0aW5nIHRoZVxuICAvLyB1c2VyIGZyb20gU2V0dGluZ3MuXG4gIGlmIChcbiAgICBzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJlxuICAgICFzZXR0aW5nc05hdmlnYXRpb25JdGVtKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWdpc3RlciBhIHR3ZWFrLW93bmVkIHNldHRpbmdzIHBhZ2UuIFRoZSBydW50aW1lIGluamVjdHMgYSBzaWRlYmFyIGVudHJ5XG4gKiB1bmRlciBhIFwiVFdFQUtTXCIgZ3JvdXAgaGVhZGVyICh3aGljaCBhcHBlYXJzIG9ubHkgd2hlbiBhdCBsZWFzdCBvbmUgcGFnZVxuICogaXMgcmVnaXN0ZXJlZCkgYW5kIHJvdXRlcyBjbGlja3MgdG8gdGhlIHBhZ2UncyBgcmVuZGVyKHJvb3QpYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyUGFnZShcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdCxcbiAgcGFnZTogU2V0dGluZ3NQYWdlLFxuKTogU2V0dGluZ3NIYW5kbGUge1xuICBjb25zdCBpZCA9IHBhZ2UuaWQ7IC8vIGFscmVhZHkgbmFtZXNwYWNlZCBieSB0d2Vhay1ob3N0IGFzIGAke3R3ZWFrSWR9OiR7cGFnZS5pZH1gXG4gIGNvbnN0IGV4aXN0aW5nID0gc3RhdGUucGFnZXMuZ2V0KGlkKTtcbiAgaWYgKGV4aXN0aW5nKSB7XG4gICAgdHJ5IHsgZXhpc3RpbmcudGVhcmRvd24/LigpOyB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcmVnaXN0cmF0aW9uVG9rZW4gPSBTeW1ib2woaWQpO1xuICBjb25zdCBlbnRyeTogUmVnaXN0ZXJlZFBhZ2UgPSB7IGlkLCB0d2Vha0lkLCBtYW5pZmVzdCwgcGFnZSwgcmVnaXN0cmF0aW9uVG9rZW4gfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gdHdlYWtJZCkge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBjb25zdCBlID0gc3RhdGUucGFnZXMuZ2V0KGlkKTtcbiAgICAgIGlmICghZSB8fCBlLnJlZ2lzdHJhdGlvblRva2VuICE9PSByZWdpc3RyYXRpb25Ub2tlbikgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZS50ZWFyZG93bj8uKCk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgICBzdGF0ZS5wYWdlcy5kZWxldGUoaWQpO1xuICAgICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSB0d2Vha0lkKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiAhc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbShzdGF0ZS5hY3RpdmVQYWdlLmlkKSkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVMaXN0ZWRUd2Vha0xpZmVjeWNsZShpZDogc3RyaW5nLCBsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl0sIGVycm9yPzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHR3ZWFrID0gc3RhdGUubGlzdGVkVHdlYWtzLmZpbmQoKGl0ZW0pID0+IGl0ZW0ubWFuaWZlc3QuaWQgPT09IGlkKTtcbiAgaWYgKCF0d2VhaykgcmV0dXJuO1xuICB0d2Vhay5saWZlY3ljbGVPdmVycmlkZSA9IGxpZmVjeWNsZTtcbiAgaWYgKGVycm9yKSB0d2Vhay5oZWFsdGggPSB7IHN0YXR1czogbGlmZWN5Y2xlID09PSBcInF1YXJhbnRpbmVkXCIgPyBcInF1YXJhbnRpbmVkXCIgOiBcImZhaWxlZFwiLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZXJyb3IgfTtcbiAgZWxzZSBpZiAobGlmZWN5Y2xlID09PSBcInN0YXJ0aW5nXCIgfHwgbGlmZWN5Y2xlID09PSBcImVuYWJsZWRcIikgdHdlYWsuaGVhbHRoID0gbnVsbDtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IGlkKSByZXJlbmRlcigpO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nc05hdmlnYXRpb25JdGVtcygpOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW10ge1xuICByZXR1cm4gYnVpbGRTZXR0aW5nc05hdmlnYXRpb25Nb2RlbChcbiAgICBzdGF0ZS5saXN0ZWRUd2Vha3MubWFwKCh0d2VhaykgPT4gKHtcbiAgICAgIGlkOiB0d2Vhay5tYW5pZmVzdC5pZCxcbiAgICAgIG5hbWU6IHR3ZWFrLm1hbmlmZXN0Lm5hbWUsXG4gICAgICB2ZXJzaW9uOiB0d2Vhay5tYW5pZmVzdC52ZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IHR3ZWFrLm1hbmlmZXN0LmRlc2NyaXB0aW9uLFxuICAgICAgaWNvblVybDogdHdlYWsubWFuaWZlc3QuaWNvblVybCxcbiAgICAgIGVuYWJsZWQ6IHR3ZWFrLmVuYWJsZWQsXG4gICAgICBzdGF0dXM6IHR3ZWFrLnN0YXR1cyxcbiAgICAgIGhlYWx0aEVycm9yOiB0d2Vhay5oZWFsdGg/LmVycm9yID8/IG51bGwsXG4gICAgICBsaWZlY3ljbGVPdmVycmlkZTogdHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGUsXG4gICAgfSkpLFxuICAgIFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgIGlkOiBlbnRyeS5pZCxcbiAgICAgIHR3ZWFrSWQ6IGVudHJ5LnR3ZWFrSWQsXG4gICAgICB0aXRsZTogZW50cnkucGFnZS50aXRsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBlbnRyeS5wYWdlLmRlc2NyaXB0aW9uLFxuICAgICAgaWNvblN2ZzogZW50cnkucGFnZS5pY29uU3ZnLFxuICAgIH0pKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSh0d2Vha0lkOiBzdHJpbmcpOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtIHwgbnVsbCB7XG4gIHJldHVybiBzZXR0aW5nc05hdmlnYXRpb25JdGVtcygpLmZpbmQoKGl0ZW0pID0+IGl0ZW0udHdlYWtJZCA9PT0gdHdlYWtJZCkgPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVnaXN0ZXJlZFBhZ2VzRm9yVHdlYWsodHdlYWtJZDogc3RyaW5nKTogUmVnaXN0ZXJlZFBhZ2VbXSB7XG4gIHJldHVybiBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnR3ZWFrSWQgPT09IHR3ZWFrSWQpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVMYWJlbChsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl0sIHdhcm5pbmc/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgY29uc3QgbGFiZWwgPSBsaWZlY3ljbGUgPT09IFwiZW5hYmxlZFwiID8gXCJSdW5uaW5nXCJcbiAgICA6IGxpZmVjeWNsZSA9PT0gXCJ0aW1lZF9vdXRcIiA/IFwiU3RhcnR1cCB0aW1lZCBvdXRcIlxuICAgIDogbGlmZWN5Y2xlWzBdLnRvVXBwZXJDYXNlKCkgKyBsaWZlY3ljbGUuc2xpY2UoMSk7XG4gIHJldHVybiB3YXJuaW5nID8gYCR7bGFiZWx9OiAke3dhcm5pbmd9YCA6IGxhYmVsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGlmIChpc05hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZCgpKSByZXR1cm47XG4gIHJlbW92ZU1pc3BsYWNlZFNldHRpbmdzR3JvdXBzKCk7XG5cbiAgY29uc3QgaXRlbXNHcm91cCA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIWl0ZW1zR3JvdXApIHtcbiAgICBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpO1xuICAgIHBsb2coXCJzaWRlYmFyIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpO1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gIH1cbiAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh0cnVlLCBcInNpZGViYXItZm91bmRcIik7XG4gIC8vIEtlZXAgbmF0aXZlIGFuZCBUd2Vha2VycyBlbnRyaWVzIGluIHRoZSBzYW1lIHNjcm9sbCBjb250YWluZXIuIEFwcGVuZGluZ1xuICAvLyB0byB0aGUgcGFyZW50IGNyZWF0ZWQgYSBzZWNvbmQgaW5kZXBlbmRlbnRseSBzY3JvbGxpbmcgc2lkZWJhciByZWdpb24uXG4gIGNvbnN0IG91dGVyID0gaXRlbXNHcm91cDtcbiAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShpdGVtc0dyb3VwKSkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgcGxvZyhcInJlamVjdGVkIG5vbi1zZXR0aW5ncyBzaWRlYmFyIGNhbmRpZGF0ZVwiLCB7XG4gICAgICBpdGVtc0dyb3VwOiBkZXNjcmliZShpdGVtc0dyb3VwKSxcbiAgICAgIG91dGVyOiBkZXNjcmliZShvdXRlciksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLnNpZGViYXJSb290ID0gb3V0ZXI7XG4gIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwLCBvdXRlcik7XG4gIGJpbmRTZXR0aW5nc1NlYXJjaChvdXRlcik7XG5cbiAgaWYgKHN0YXRlLm5hdkdyb3VwICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLm5hdkdyb3VwKSkge1xuICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgLy8gQ29kZXggcmUtcmVuZGVycyBpdHMgbmF0aXZlIHNpZGViYXIgYnV0dG9ucyBvbiBpdHMgb3duIHN0YXRlIGNoYW5nZXMuXG4gICAgLy8gSWYgb25lIG9mIG91ciBwYWdlcyBpcyBhY3RpdmUsIHJlLXN0cmlwIENvZGV4J3MgYWN0aXZlIHN0eWxpbmcgc29cbiAgICAvLyBHZW5lcmFsIGRvZXNuJ3QgcmVhcHBlYXIgYXMgc2VsZWN0ZWQuXG4gICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwpIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZSh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaWRlYmFyIHdhcyBlaXRoZXIgZnJlc2hseSBtb3VudGVkIChTZXR0aW5ncyBqdXN0IG9wZW5lZCkgb3IgcmUtbW91bnRlZFxuICAvLyAoY2xvc2VkIGFuZCByZS1vcGVuZWQsIG9yIG5hdmlnYXRlZCBhd2F5IGFuZCBiYWNrKS4gSW4gYWxsIG9mIHRob3NlXG4gIC8vIGNhc2VzIENvZGV4IHJlc2V0cyB0byBpdHMgZGVmYXVsdCBwYWdlIChHZW5lcmFsKSwgYnV0IG91ciBpbi1tZW1vcnlcbiAgLy8gYGFjdGl2ZVBhZ2VgIG1heSBzdGlsbCByZWZlcmVuY2UgdGhlIGxhc3QgdHdlYWsvcGFnZSB0aGUgdXNlciBoYWQgb3BlblxuICAvLyBcdTIwMTQgd2hpY2ggd291bGQgY2F1c2UgdGhhdCBuYXYgYnV0dG9uIHRvIHJlbmRlciB3aXRoIHRoZSBhY3RpdmUgc3R5bGluZ1xuICAvLyBldmVuIHRob3VnaCBDb2RleCBpcyBzaG93aW5nIEdlbmVyYWwuIENsZWFyIGl0IHNvIGBzeW5jUGFnZXNHcm91cGAgL1xuICAvLyBgc2V0TmF2QWN0aXZlYCBzdGFydCBmcm9tIGEgbmV1dHJhbCBzdGF0ZS4gVGhlIHBhbmVsSG9zdCByZWZlcmVuY2UgaXNcbiAgLy8gYWxzbyBzdGFsZSAoaXRzIERPTSB3YXMgZGlzY2FyZGVkIHdpdGggdGhlIHByZXZpb3VzIGNvbnRlbnQgYXJlYSkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsIHx8IHN0YXRlLnBhbmVsSG9zdCAhPT0gbnVsbCkge1xuICAgIHBsb2coXCJzaWRlYmFyIHJlLW1vdW50IGRldGVjdGVkOyBjbGVhcmluZyBzdGFsZSBhY3RpdmUgc3RhdGVcIiwge1xuICAgICAgcHJldkFjdGl2ZTogc3RhdGUuYWN0aXZlUGFnZSxcbiAgICB9KTtcbiAgICBzdGF0ZS5hY3RpdmVQYWdlID0gbnVsbDtcbiAgICBzdGF0ZS5wYW5lbEhvc3QgPSBudWxsO1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXAgPVxuICAgIG91dGVyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCc6c2NvcGUgPiBbZGF0YS10d2Vha2VyPVwibmF2LWdyb3VwXCJdJykgPz9cbiAgICBvdXRlci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtdHdlYWtlcj1cIm5hdi1ncm91cFwiXScpO1xuXG4gIGlmIChleGlzdGluZ1R3ZWFrZXJOYXZHcm91cCkge1xuICAgIHN0YXRlLm5hdkdyb3VwID0gZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXA7XG4gICAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IGV4aXN0aW5nVHdlYWtlck5hdkdyb3VwLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFxuICAgICAgXCJbZGF0YS10d2Vha2VyLXNpZGViYXItdXBkYXRlXVwiLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbigpO1xuICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsKSBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEdyb3VwIGNvbnRhaW5lciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBncm91cC5kYXRhc2V0LnR3ZWFrZXIgPSBcIm5hdi1ncm91cFwiO1xuICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG5cbiAgY29uc3QgdXBkYXRlQnV0dG9uID0gc2lkZWJhclVwZGF0ZVBpbGxCdXR0b24oKTtcbiAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IHVwZGF0ZUJ1dHRvbjtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiVHdlYWtlcnNcIiwgXCJwdC0zXCIsIHVwZGF0ZUJ1dHRvbikpO1xuICByZWZyZXNoU2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2lkZWJhciBpdGVtcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgY29uZmlnQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiQ29uZmlnXCIsIGNvbmZpZ0ljb25TdmcoKSk7XG4gIGNvbnN0IHR3ZWFrc0J0biA9IG1ha2VTaWRlYmFySXRlbShcIlR3ZWFrc1wiLCB0d2Vha3NJY29uU3ZnKCkpO1xuXG4gIGNvbmZpZ0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcImNvbmZpZ1wiIH0pO1xuICB9KTtcbiAgdHdlYWtzQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwidHdlYWtzXCIgfSk7XG4gIH0pO1xuICBncm91cC5hcHBlbmRDaGlsZChjb25maWdCdG4pO1xuICBncm91cC5hcHBlbmRDaGlsZCh0d2Vha3NCdG4pO1xuICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG5cbiAgc3RhdGUubmF2R3JvdXAgPSBncm91cDtcbiAgc3RhdGUubmF2QnV0dG9ucyA9IHsgY29uZmlnOiBjb25maWdCdG4sIHR3ZWFrczogdHdlYWtzQnRuIH07XG4gIG5vdGVOYXZHcm91cEluamVjdGlvbihvdXRlcik7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbi8vIEJhY2tzdG9wIGFnYWluc3QgaW5qZWN0L3JlbW92ZSBmZWVkYmFjayBsb29wczogaWYgdGhlIG5hdiBncm91cCBuZWVkc1xuLy8gcmUtaW5qZWN0aW9uIG1vcmUgdGhhbiBhIGZldyB0aW1lcyBpbiBhIHNob3J0IHdpbmRvdywgc29tZXRoaW5nIGlzXG4vLyBmaWdodGluZyB1cyBcdTIwMTQgYmFjayBvZmYgaW5zdGVhZCBvZiBzYXR1cmF0aW5nIHRoZSBsb2cgYW5kIHRoZSBDUFUuXG5jb25zdCBOQVZfR1JPVVBfSU5KRUNUSU9OX1dJTkRPV19NUyA9IDEwXzAwMDtcbmNvbnN0IE5BVl9HUk9VUF9JTkpFQ1RJT05fTElNSVQgPSA1O1xuY29uc3QgTkFWX0dST1VQX0lOSkVDVElPTl9CQUNLT0ZGX01TID0gMzBfMDAwO1xubGV0IG5hdkdyb3VwSW5qZWN0aW9uczogbnVtYmVyW10gPSBbXTtcbmxldCBuYXZHcm91cEluamVjdGlvblN1cHByZXNzZWRVbnRpbCA9IDA7XG5cbmZ1bmN0aW9uIGlzTmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gRGF0ZS5ub3coKSA8IG5hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZFVudGlsO1xufVxuXG5mdW5jdGlvbiBub3RlTmF2R3JvdXBJbmplY3Rpb24ob3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIG5hdkdyb3VwSW5qZWN0aW9ucyA9IG5hdkdyb3VwSW5qZWN0aW9ucy5maWx0ZXIoKGF0KSA9PiBub3cgLSBhdCA8IE5BVl9HUk9VUF9JTkpFQ1RJT05fV0lORE9XX01TKTtcbiAgbmF2R3JvdXBJbmplY3Rpb25zLnB1c2gobm93KTtcbiAgaWYgKG5hdkdyb3VwSW5qZWN0aW9ucy5sZW5ndGggPiBOQVZfR1JPVVBfSU5KRUNUSU9OX0xJTUlUKSB7XG4gICAgbmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkVW50aWwgPSBub3cgKyBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVM7XG4gICAgbmF2R3JvdXBJbmplY3Rpb25zID0gW107XG4gICAgcGxvZyhcIm5hdiBncm91cCByZS1pbmplY3Rpb24gbG9vcCBkZXRlY3RlZDsgYmFja2luZyBvZmZcIiwge1xuICAgICAgYmFja29mZk1zOiBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVMsXG4gICAgICBvdXRlclRhZzogb3V0ZXIudGFnTmFtZSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcGxvZyhcIm5hdiBncm91cCBpbmplY3RlZFwiLCB7IG91dGVyVGFnOiBvdXRlci50YWdOYW1lIH0pO1xufVxuXG5mdW5jdGlvbiBzeW5jTmF0aXZlU2V0dGluZ3NIZWFkZXIoaXRlbXNHcm91cDogSFRNTEVsZW1lbnQsIG91dGVyOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAoc3RhdGUubmF0aXZlTmF2SGVhZGVyICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLm5hdGl2ZU5hdkhlYWRlcikpIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC50d2Vha2VyID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIG91dGVyLnByZXBlbmQoaGVhZGVyKTtcbiAgZWxzZSBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBiaW5kU2V0dGluZ3NTZWFyY2gocm9vdDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgaW5wdXQgPSByb290LmNsb3Nlc3QoXCJhc2lkZSwgbmF2LCBbcm9sZT0nbmF2aWdhdGlvbiddLCBkaXZcIik/LnBhcmVudEVsZW1lbnRcbiAgICA/LnF1ZXJ5U2VsZWN0b3I8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtwbGFjZWhvbGRlcio9J1NlYXJjaCBzZXR0aW5ncycgaV1cIilcbiAgICA/PyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbcGxhY2Vob2xkZXIqPSdTZWFyY2ggc2V0dGluZ3MnIGldXCIpO1xuICBpZiAoIWlucHV0IHx8IGlucHV0LmRhdGFzZXQudHdlYWtlcnNTZWFyY2hCb3VuZCA9PT0gXCJ0cnVlXCIpIHJldHVybjtcbiAgaW5wdXQuZGF0YXNldC50d2Vha2Vyc1NlYXJjaEJvdW5kID0gXCJ0cnVlXCI7XG4gIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcXVlcnkgPSBpbnB1dC52YWx1ZS50cmltKCkudG9Mb2NhbGVMb3dlckNhc2UoKTtcbiAgICBmb3IgKGNvbnN0IGJ1dHRvbiBvZiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpKSB7XG4gICAgICBpZiAoIWJ1dHRvbi5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlcl1cIikpIGNvbnRpbnVlO1xuICAgICAgYnV0dG9uLmhpZGRlbiA9ICEhcXVlcnkgJiYgIWNvbXBhY3RTZXR0aW5nc1RleHQoYnV0dG9uLnRleHRDb250ZW50ID8/IFwiXCIpLnRvTG9jYWxlTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXI9J25hdi1ncm91cCddLCBbZGF0YS10d2Vha2VyPSdwYWdlcy1ncm91cCddXCIpKSkge1xuICAgICAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20oZ3JvdXAucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpO1xuICAgICAgZ3JvdXAuaGlkZGVuID0gYnV0dG9ucy5sZW5ndGggPiAwICYmIGJ1dHRvbnMuZXZlcnkoKGJ1dHRvbikgPT4gYnV0dG9uLmhpZGRlbik7XG4gICAgfVxuICB9KTtcbn1cblxuZnVuY3Rpb24gc2lkZWJhckdyb3VwSGVhZGVyKHRleHQ6IHN0cmluZywgdG9wUGFkZGluZyA9IFwicHQtMlwiLCB0cmFpbGluZz86IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID1cbiAgICBgcHgtcm93LXggJHt0b3BQYWRkaW5nfSBwYi0xIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB1cHBlcmNhc2UgdHJhY2tpbmctd2lkZXIgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIHNlbGVjdC1ub25lYDtcbiAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgbGFiZWwuY2xhc3NOYW1lID0gXCJ0cnVuY2F0ZVwiO1xuICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChsYWJlbCk7XG4gIGlmICh0cmFpbGluZykgaGVhZGVyLmFwcGVuZENoaWxkKHRyYWlsaW5nKTtcbiAgcmV0dXJuIGhlYWRlcjtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTogdm9pZCB7XG4gIGlmICghc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSB8fCBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHJldHVybjtcbiAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoc2lkZWJhcikpIHJldHVybjtcbiAgICBpZiAoaXNTZXR0aW5nc1RleHRWaXNpYmxlKCkpIHJldHVybjtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcInNpZGViYXItbm90LWZvdW5kXCIpO1xuICB9LCAxNTAwKTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1RleHRWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNUd2Vha2VyU2V0dGluZ3NMYWJlbFNldCh0d2Vha2VyU2V0dGluZ3NMYWJlbHNGcm9tKGRvY3VtZW50KSk7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG5jb25zdCBUV0VBS0VSX0NPUkVfU0VUVElOR1NfTEFCRUxTID0gW1xuICBcIkdlbmVyYWxcIixcbiAgXCJcdTVFMzhcdTg5QzRcIixcbiAgXCJcdTkwMUFcdTc1MjhcIixcbiAgXCJBcHBlYXJhbmNlXCIsXG4gIFwiXHU1OTE2XHU4OUMyXCIsXG4gIFwiQ29uZmlndXJhdGlvblwiLFxuICBcIlx1OTE0RFx1N0Y2RVwiLFxuICBcIlx1OUVEOFx1OEJBNFx1Njc0M1x1OTY1MFwiLFxuICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICBcIlx1NEUyQVx1NjAyN1x1NTMxNlwiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5jb25zdCBUV0VBS0VSX0VYVEVOREVEX1NFVFRJTkdTX0xBQkVMUyA9IFtcbiAgXCJBY2NvdW50XCIsXG4gIFwiXHU4RDI2XHU2MjM3XCIsXG4gIFwiXHU4RDI2XHU1M0Y3XCIsXG4gIFwiR2VuZXJhbFwiLFxuICBcIlx1NUUzOFx1ODlDNFwiLFxuICBcIlx1OTAxQVx1NzUyOFwiLFxuICBcIkFwcGVhcmFuY2VcIixcbiAgXCJcdTU5MTZcdTg5QzJcIixcbiAgXCJDb25maWd1cmF0aW9uXCIsXG4gIFwiXHU5MTREXHU3RjZFXCIsXG4gIFwiXHU5RUQ4XHU4QkE0XHU2NzQzXHU5NjUwXCIsXG4gIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gIFwiXHU0RTJBXHU2MDI3XHU1MzE2XCIsXG4gIFwiS2V5Ym9hcmQgc2hvcnRjdXRzXCIsXG4gIFwiQXJjaGl2ZWQgY2hhdHNcIixcbiAgXCJVc2FnZVwiLFxuICBcIkNvbXB1dGVyIHVzZVwiLFxuICBcIkJyb3dzZXIgdXNlXCIsXG4gIFwiTUNQIHNlcnZlcnNcIixcbiAgXCJNQ1AgU2VydmVyc1wiLFxuICBcIk1DUCBcdTY3MERcdTUyQTFcdTU2NjhcIixcbiAgXCJHaXRcIixcbiAgXCJFbnZpcm9ubWVudHNcIixcbiAgXCJcdTczQUZcdTU4ODNcIixcbiAgXCJDbG91ZCBFbnZpcm9ubWVudHNcIixcbiAgXCJXb3JrdHJlZXNcIixcbiAgXCJDb25uZWN0aW9uc1wiLFxuICBcIlBsdWdpbnNcIixcbiAgXCJTa2lsbHNcIixcbl0ubWFwKG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKTtcblxuY29uc3QgVFdFQUtFUl9TRVRUSU5HU19PTkxZX0xBQkVMUyA9IFtcbiAgXCJHZW5lcmFsXCIsXG4gIFwiXHU1RTM4XHU4OUM0XCIsXG4gIFwiXHU5MDFBXHU3NTI4XCIsXG4gIFwiQXBwZWFyYW5jZVwiLFxuICBcIlx1NTkxNlx1ODlDMlwiLFxuICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgXCJcdTkxNERcdTdGNkVcIixcbiAgXCJcdTlFRDhcdThCQTRcdTY3NDNcdTk2NTBcIixcbiAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgXCJcdTRFMkFcdTYwMjdcdTUzMTZcIixcbiAgXCJLZXlib2FyZCBzaG9ydGN1dHNcIixcbiAgXCJBcmNoaXZlZCBjaGF0c1wiLFxuICBcIlVzYWdlXCIsXG4gIFwiQ29tcHV0ZXIgdXNlXCIsXG4gIFwiQnJvd3NlciB1c2VcIixcbiAgXCJNQ1Agc2VydmVyc1wiLFxuICBcIk1DUCBTZXJ2ZXJzXCIsXG4gIFwiTUNQIFx1NjcwRFx1NTJBMVx1NTY2OFwiLFxuICBcIkdpdFwiLFxuICBcIkVudmlyb25tZW50c1wiLFxuICBcIlx1NzNBRlx1NTg4M1wiLFxuICBcIkNsb3VkIEVudmlyb25tZW50c1wiLFxuICBcIldvcmt0cmVlc1wiLFxuICBcIkNvbm5lY3Rpb25zXCIsXG5dLm1hcChub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCk7XG5cbmNvbnN0IFRXRUFLRVJfTUFJTl9BUFBfTkFWX0xBQkVMUyA9IFtcbiAgXCJOZXcgY2hhdFwiLFxuICBcIlF1aWNrIGNoYXRcIixcbiAgXCJcdTVGRUJcdTkwMUZcdTVCRjlcdThCRERcIixcbiAgXCJTZWFyY2hcIixcbiAgXCJcdTY0MUNcdTdEMjJcIixcbiAgXCJQbHVnaW5zXCIsXG4gIFwiXHU2M0QyXHU0RUY2XCIsXG4gIFwiQXV0b21hdGlvbnNcIixcbiAgXCJBdXRvbWF0aW9uXCIsXG4gIFwiXHU4MUVBXHU1MkE4XHU1MzE2XCIsXG4gIFwiQ2hhdHNcIixcbiAgXCJDaGF0XCIsXG4gIFwiXHU1QkY5XHU4QkREXCIsXG4gIFwiUHJvamVjdHNcIixcbiAgXCJcdTk4NzlcdTc2RUVcIixcbiAgXCJQaW5uZWRcIixcbiAgXCJTZXR0aW5nc1wiLFxuICBcIlx1OEJCRVx1N0Y2RVwiLFxuICBcIldvcmsgbG9jYWxseVwiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5mdW5jdGlvbiBub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWUpXG4gICAgLnRvTG9jYWxlTG93ZXJDYXNlKClcbiAgICAubm9ybWFsaXplKFwiTkZEXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csIFwiXCIpXG4gICAgLnJlcGxhY2UoL1tcdTIwMTlcdTIwMThgXHUwMEI0XS9nLCBcIidcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyQ29udHJvbExhYmVsKGVsOiBIVE1MRWxlbWVudCk6IHN0cmluZyB7XG4gIHJldHVybiBub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbChcbiAgICBlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8XG4gICAgICBlbC5nZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiKSB8fFxuICAgICAgZWwudGV4dENvbnRlbnQgfHxcbiAgICAgIFwiXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20ocm9vdDogUGFyZW50Tm9kZSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgY29udHJvbHMgPSBBcnJheS5mcm9tKFxuICAgIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sYSxbcm9sZT0nYnV0dG9uJ10sW3JvbGU9J2xpbmsnXVwiKSxcbiAgKTtcblxuICByZXR1cm4gW1xuICAgIC4uLm5ldyBTZXQoXG4gICAgICBjb250cm9sc1xuICAgICAgICAubWFwKHR3ZWFrZXJDb250cm9sTGFiZWwpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbiksXG4gICAgKSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlclNldHRpbmdzTGFiZWxTY29yZShsYWJlbHM6IHN0cmluZ1tdKTogeyBjb3JlOiBudW1iZXI7IHRvdGFsOiBudW1iZXIgfSB7XG4gIGNvbnN0IGNvcmUgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgdG90YWwgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IGxhYmVsIG9mIGxhYmVscykge1xuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIFRXRUFLRVJfQ09SRV9TRVRUSU5HU19MQUJFTFMpIHtcbiAgICAgIGlmICh0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsLCBtYXJrZXIpKSBjb3JlLmFkZChtYXJrZXIpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIFRXRUFLRVJfRVhURU5ERURfU0VUVElOR1NfTEFCRUxTKSB7XG4gICAgICBpZiAodHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgdG90YWwuYWRkKG1hcmtlcik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgY29yZTogY29yZS5zaXplLCB0b3RhbDogdG90YWwuc2l6ZSB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsOiBzdHJpbmcsIG1hcmtlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBsYWJlbCA9PT0gbWFya2VyIHx8IGxhYmVsLmluY2x1ZGVzKG1hcmtlcik7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJNYXJrZXJDb3VudChsYWJlbHM6IHN0cmluZ1tdLCBtYXJrZXJzOiBzdHJpbmdbXSk6IG51bWJlciB7XG4gIGNvbnN0IG1hdGNoZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICBpZiAodHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgbWF0Y2hlZC5hZGQobWFya2VyKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1hdGNoZWQuc2l6ZTtcbn1cblxuZnVuY3Rpb24gaGFzVHdlYWtlclNldHRpbmdzT25seVNpZ25hbChsYWJlbHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIHJldHVybiB0d2Vha2VyTWFya2VyQ291bnQobGFiZWxzLCBUV0VBS0VSX1NFVFRJTkdTX09OTFlfTEFCRUxTKSA+IDA7XG59XG5cbmZ1bmN0aW9uIGhhc01haW5BcHBTaWRlYmFyU2lnbmFscyhsYWJlbHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIHJldHVybiB0d2Vha2VyTWFya2VyQ291bnQobGFiZWxzLCBUV0VBS0VSX01BSU5fQVBQX05BVl9MQUJFTFMpID49IDI7XG59XG5cbmZ1bmN0aW9uIGlzVHdlYWtlclNldHRpbmdzTGFiZWxTZXQobGFiZWxzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgcmV0dXJuIHNjb3JlLmNvcmUgPj0gMiAmJiBzY29yZS50b3RhbCA+PSAzO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyVmlzaWJsZUJveChlbDogSFRNTEVsZW1lbnQpOiBET01SZWN0IHwgbnVsbCB7XG4gIGlmICghZWwuaXNDb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBzdHlsZSA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xuICBpZiAoc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHwgc3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIikgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVjdCA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBpZiAocmVjdC53aWR0aCA8PSAwIHx8IHJlY3QuaGVpZ2h0IDw9IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gcmVjdDtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgaWYgKHZpc2libGUpIHdhcm1Ud2Vha1N0b3JlKCk7XG4gIHRyeSB7XG4gICAgKHdpbmRvdyBhcyBXaW5kb3cgJiB7IF9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGU/OiBib29sZWFuIH0pLl9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnR3ZWFrZXJTZXR0aW5nc1N1cmZhY2UgPSB2aXNpYmxlID8gXCJ0cnVlXCIgOiBcImZhbHNlXCI7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQoXG4gICAgICBuZXcgQ3VzdG9tRXZlbnQoXCJ0d2Vha2VyOnNldHRpbmdzLXN1cmZhY2VcIiwge1xuICAgICAgICBkZXRhaWw6IHsgdmlzaWJsZSwgcmVhc29uIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9IGNhdGNoIHt9XG4gIHBsb2coXCJzZXR0aW5ncyBzdXJmYWNlXCIsIHsgdmlzaWJsZSwgcmVhc29uLCB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG59XG5cbi8qKlxuICogUmVuZGVyIChvciByZS1yZW5kZXIpIHRoZSBzZWNvbmQgc2lkZWJhciBncm91cCBvZiBwZXItdHdlYWsgcGFnZXMuIFRoZVxuICogZ3JvdXAgaXMgY3JlYXRlZCBsYXppbHkgYW5kIHJlbW92ZWQgd2hlbiB0aGUgbGFzdCBwYWdlIHVucmVnaXN0ZXJzLCBzb1xuICogdXNlcnMgd2l0aCBubyBwYWdlLXJlZ2lzdGVyaW5nIHR3ZWFrcyBuZXZlciBzZWUgYW4gZW1wdHkgXCJUd2Vha3NcIiBoZWFkZXIuXG4gKi9cbmZ1bmN0aW9uIHN5bmNQYWdlc0dyb3VwKCk6IHZvaWQge1xuICBjb25zdCBvdXRlciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIW91dGVyKSByZXR1cm47XG4gIGlmICghaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUob3V0ZXIpKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBhZ2VzID0gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbXMoKTtcblxuICAvLyBCdWlsZCBhIGRldGVybWluaXN0aWMgZmluZ2VycHJpbnQgb2YgdGhlIGRlc2lyZWQgZ3JvdXAgc3RhdGUuIElmIHRoZVxuICAvLyBjdXJyZW50IERPTSBncm91cCBhbHJlYWR5IG1hdGNoZXMsIHRoaXMgaXMgYSBuby1vcCBcdTIwMTQgY3JpdGljYWwsIGJlY2F1c2VcbiAgLy8gc3luY1BhZ2VzR3JvdXAgaXMgY2FsbGVkIG9uIGV2ZXJ5IE11dGF0aW9uT2JzZXJ2ZXIgdGljayBhbmQgYW55IERPTVxuICAvLyB3cml0ZSB3b3VsZCByZS10cmlnZ2VyIHRoYXQgb2JzZXJ2ZXIgKGluZmluaXRlIGxvb3AsIGFwcCBmcmVlemUpLlxuICBjb25zdCBkZXNpcmVkS2V5ID0gcGFnZXMubGVuZ3RoID09PSAwXG4gICAgPyBcIkVNUFRZXCJcbiAgICA6IHBhZ2VzLm1hcCgocCkgPT4gYCR7cC50d2Vha0lkfXwke3AudGl0bGV9fCR7cC5pY29uU3ZnID8/IFwiXCJ9fCR7cC5saWZlY3ljbGV9YCkuam9pbihcIlxcblwiKTtcbiAgY29uc3QgZ3JvdXBBdHRhY2hlZCA9ICEhc3RhdGUucGFnZXNHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKTtcbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXBLZXkgPT09IGRlc2lyZWRLZXkgJiYgKHBhZ2VzLmxlbmd0aCA9PT0gMCA/ICFncm91cEF0dGFjaGVkIDogZ3JvdXBBdHRhY2hlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXApIHtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAucmVtb3ZlKCk7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICB9XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgZ3JvdXAgPSBzdGF0ZS5wYWdlc0dyb3VwO1xuICBpZiAoIWdyb3VwIHx8ICFvdXRlci5jb250YWlucyhncm91cCkpIHtcbiAgICBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZ3JvdXAuZGF0YXNldC50d2Vha2VyID0gXCJwYWdlcy1ncm91cFwiO1xuICAgIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcbiAgICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJUd2Vha3NcIiwgXCJwdC0zXCIpKTtcbiAgICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG4gICAgc3RhdGUucGFnZXNHcm91cCA9IGdyb3VwO1xuICB9IGVsc2Uge1xuICAgIC8vIFN0cmlwIHByaW9yIGJ1dHRvbnMgKGtlZXAgdGhlIGhlYWRlciBhdCBpbmRleCAwKS5cbiAgICB3aGlsZSAoZ3JvdXAuY2hpbGRyZW4ubGVuZ3RoID4gMSkgZ3JvdXAucmVtb3ZlQ2hpbGQoZ3JvdXAubGFzdENoaWxkISk7XG4gIH1cblxuICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGFnZXMpIHtcbiAgICBjb25zdCBpY29uID0gcC5pY29uU3ZnID8/IGRlZmF1bHRQYWdlSWNvblN2ZygpO1xuICAgIGNvbnN0IGJ0biA9IG1ha2VTaWRlYmFySXRlbShwLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi1wYWdlLSR7cC50d2Vha0lkfWA7XG4gICAgYnRuLmRhdGFzZXQudHdlYWtlckxpZmVjeWNsZSA9IHAubGlmZWN5Y2xlO1xuICAgIGlmIChwLmxpZmVjeWNsZSAhPT0gXCJlbmFibGVkXCIpIGJ0bi50aXRsZSA9IGxpZmVjeWNsZUxhYmVsKHAubGlmZWN5Y2xlLCBwLndhcm5pbmcpO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAudHdlYWtJZCB9KTtcbiAgICB9KTtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5zZXQocC50d2Vha0lkLCBidG4pO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKGJ0bik7XG4gIH1cbiAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gIHBsb2coXCJwYWdlcyBncm91cCBzeW5jZWRcIiwge1xuICAgIGNvdW50OiBwYWdlcy5sZW5ndGgsXG4gICAgaWRzOiBwYWdlcy5tYXAoKHApID0+IHAudHdlYWtJZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbi8vIEZvcmNlIGFueSBpbmplY3RlZCBpY29uIFNWRyB0byBhIGZpeGVkIGJveC4gVHdlYWstcHJvdmlkZWQgaWNvblN2ZyBtYXJrdXAgbWF5XG4vLyBvbWl0IHdpZHRoL2hlaWdodCAoYW5kIHZpZXdCb3ggYWxvbmUgbGV0cyBhbiBTVkcgZXhwYW5kIHRvIGl0cyBpbnRyaW5zaWMgc2l6ZSxcbi8vIHdoaWNoIHJlbmRlcmVkIGEgcGFnZSBpY29uIGFzIGEgZ2lhbnQgZ2x5cGgpLiBJbmxpbmUgc3R5bGVzIGJlYXQgY29uZmxpY3Rpbmdcbi8vIGF0dHJpYnV0ZXMvQ1NTLCBzbyB0aGlzIGNhbm5vdCBiZSBkZWZlYXRlZCBieSB0aGUgdHdlYWsncyBvd24gbWFya3VwLlxuZnVuY3Rpb24gY29uc3RyYWluU2lkZWJhckljb25TdmcoaWNvbjogRWxlbWVudCB8IG51bGwgfCB1bmRlZmluZWQsIHNpemUgPSAyMCk6IHZvaWQge1xuICBpZiAoIWljb24pIHJldHVybjtcbiAgaWNvbi5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBpY29uLnNldEF0dHJpYnV0ZShcImhlaWdodFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBjb25zdCBzdHlsZSA9IChpY29uIGFzIHVua25vd24gYXMgeyBzdHlsZT86IENTU1N0eWxlRGVjbGFyYXRpb24gfSkuc3R5bGU7XG4gIGlmIChzdHlsZSkge1xuICAgIHN0eWxlLndpZHRoID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuaGVpZ2h0ID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuZmxleFNocmluayA9IFwiMFwiO1xuICB9XG4gIChpY29uIGFzIEVsZW1lbnQpLmNsYXNzTGlzdD8uYWRkKFwiaWNvbi1zbVwiLCBcImlubGluZS1ibG9ja1wiLCBcInNocmluay0wXCIsIFwiYWxpZ24tbWlkZGxlXCIpO1xufVxuXG5mdW5jdGlvbiBtYWtlU2lkZWJhckl0ZW0obGFiZWw6IHN0cmluZywgaWNvblN2Zzogc3RyaW5nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICAvLyBDbGFzcyBzdHJpbmcgY29waWVkIHZlcmJhdGltIGZyb20gQ29kZXgncyBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwgZXRjKS5cbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi0ke2xhYmVsLnRvTG93ZXJDYXNlKCl9YDtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbGFiZWwpO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImZvY3VzLXZpc2libGU6b3V0bGluZS10b2tlbi1ib3JkZXIgcmVsYXRpdmUgcHgtcm93LXggcHktcm93LXkgY3Vyc29yLWludGVyYWN0aW9uIHNocmluay0wIGl0ZW1zLWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyB0ZXh0LWxlZnQgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLTIgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW9mZnNldC0yIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTUwIGdhcC0yIGZsZXggdy1mdWxsIGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBmb250LW5vcm1hbFwiO1xuXG4gIGNvbnN0IGlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaW5uZXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgdGV4dC1iYXNlIGdhcC0yIGZsZXgtMSB0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgaW5uZXIuaW5uZXJIVE1MID0gYCR7aWNvblN2Z308c3BhbiBjbGFzcz1cInRydW5jYXRlXCI+JHtsYWJlbH08L3NwYW4+YDtcbiAgY29uc3RyYWluU2lkZWJhckljb25TdmcoaW5uZXIucXVlcnlTZWxlY3RvcihcInN2Z1wiKSk7XG4gIGJ0bi5hcHBlbmRDaGlsZChpbm5lcik7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGFwcGVuZFNpZGViYXJTdG9yZVVwZGF0ZUJhZGdlKGJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWlubmVyKSByZXR1cm47XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmRhdGFzZXQudHdlYWtlclN0b3JlVXBkYXRlQmFkZ2UgPSBcInRydWVcIjtcbiAgYmFkZ2UuaGlkZGVuID0gdHJ1ZTtcbiAgYmFkZ2UudGl0bGUgPSBcIkluc3RhbGxlZCB0d2Vha3Mgd2l0aCBhcHByb3ZlZCB1cGRhdGVzXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyXCI7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBwb3NpdGlvbjogXCJhYnNvbHV0ZVwiLFxuICAgIHJpZ2h0OiBcIjEycHhcIixcbiAgICB0b3A6IFwiNTAlXCIsXG4gICAgdHJhbnNmb3JtOiBcInRyYW5zbGF0ZVkoLTUwJSlcIixcbiAgICB6SW5kZXg6IFwiMVwiLFxuICB9KTtcbiAgYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2UsIG51bGwpO1xuICBidG4uYXBwZW5kQ2hpbGQoYmFkZ2UpO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCIgfCBcInN0b3JlXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOlxuICAgICAgYWN0aXZlPy5raW5kID09PSBcInN0b3JlXCIgPyBcInN0b3JlXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIE9uZSBzdGFibGUgYnV0dG9uIHBlciBlbmFibGVkIHR3ZWFrLCByZWdhcmRsZXNzIG9mIGhvdyBtYW55IHNlY3Rpb25zIGl0XG4gIC8vIHJlZ2lzdGVyZWQgb3Igd2hldGhlciBzdGFydHVwIHJlYWNoZWQgcGFnZSByZWdpc3RyYXRpb24gYXQgYWxsLlxuICBmb3IgKGNvbnN0IFt0d2Vha0lkLCBidXR0b25dIG9mIHN0YXRlLnBhZ2VOYXZCdXR0b25zKSB7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gdHdlYWtJZDtcbiAgICBhcHBseU5hdkFjdGl2ZShidXR0b24sIGlzQWN0aXZlKTtcbiAgfVxuICAvLyBDb2RleCdzIG93biBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIGV0YykuIFdoZW4gb25lIG9mXG4gIC8vIG91ciBwYWdlcyBpcyBhY3RpdmUsIENvZGV4IHN0aWxsIGhhcyBhcmlhLWN1cnJlbnQ9XCJwYWdlXCIgYW5kIHRoZVxuICAvLyBhY3RpdmUtYmcgY2xhc3Mgb24gd2hpY2hldmVyIGl0ZW0gaXQgY29uc2lkZXJlZCB0aGUgcm91dGUgXHUyMDE0IHR5cGljYWxseVxuICAvLyBHZW5lcmFsLiBUaGF0IG1ha2VzIGJvdGggYnV0dG9ucyBsb29rIHNlbGVjdGVkLiBTdHJpcCBDb2RleCdzIGFjdGl2ZVxuICAvLyBzdHlsaW5nIHdoaWxlIG9uZSBvZiBvdXJzIGlzIGFjdGl2ZTsgcmVzdG9yZSBpdCB3aGVuIG5vbmUgaXMuXG4gIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShhY3RpdmUgIT09IG51bGwpO1xufVxuXG4vKipcbiAqIE11dGUgQ29kZXgncyBvd24gYWN0aXZlLXN0YXRlIHN0eWxpbmcgb24gaXRzIHNpZGViYXIgYnV0dG9ucy4gV2UgZG9uJ3RcbiAqIHRvdWNoIENvZGV4J3MgUmVhY3Qgc3RhdGUgXHUyMDE0IHdoZW4gdGhlIHVzZXIgY2xpY2tzIGEgbmF0aXZlIGl0ZW0sIENvZGV4XG4gKiByZS1yZW5kZXJzIHRoZSBidXR0b25zIGFuZCByZS1hcHBsaWVzIGl0cyBvd24gY29ycmVjdCBzdGF0ZSwgdGhlbiBvdXJcbiAqIHNpZGViYXItY2xpY2sgbGlzdGVuZXIgZmlyZXMgYHJlc3RvcmVDb2RleFZpZXdgICh3aGljaCBjYWxscyBiYWNrIGludG9cbiAqIGBzZXROYXZBY3RpdmUobnVsbClgIGFuZCBsZXRzIENvZGV4J3Mgc3R5bGluZyBzdGFuZCkuXG4gKlxuICogYG11dGU9dHJ1ZWAgIFx1MjE5MiBzdHJpcCBhcmlhLWN1cnJlbnQgYW5kIHN3YXAgYWN0aXZlIGJnIFx1MjE5MiBob3ZlciBiZ1xuICogYG11dGU9ZmFsc2VgIFx1MjE5MiBuby1vcCAoQ29kZXgncyBvd24gcmUtcmVuZGVyIGFscmVhZHkgcmVzdG9yZWQgdGhpbmdzKVxuICovXG5mdW5jdGlvbiBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUobXV0ZTogYm9vbGVhbik6IHZvaWQge1xuICBpZiAoIW11dGUpIHJldHVybjtcbiAgY29uc3Qgcm9vdCA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIGJ1dHRvbnMpIHtcbiAgICAvLyBTa2lwIG91ciBvd24gYnV0dG9ucy5cbiAgICBpZiAoYnRuLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiKSB7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgIH1cbiAgICBpZiAoYnRuLmNsYXNzTGlzdC5jb250YWlucyhcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlOYXZBY3RpdmUoYnRuOiBIVE1MQnV0dG9uRWxlbWVudCwgYWN0aXZlOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGlubmVyID0gYnRuLmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGFjdGl2ZSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiLCBcInBhZ2VcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgYWN0aXZhdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYWN0aXZhdGVQYWdlKHBhZ2U6IEFjdGl2ZVBhZ2UpOiB2b2lkIHtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICBwbG9nKFwiYWN0aXZhdGU6IGNvbnRlbnQgYXJlYSBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBwYWdlO1xuICBwbG9nKFwiYWN0aXZhdGVcIiwgeyBwYWdlIH0pO1xuXG4gIC8vIEhpZGUgQ29kZXgncyBjb250ZW50IGNoaWxkcmVuLCBzaG93IG91cnMuXG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlciA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5kYXRhc2V0LnR3ZWFrZXJIaWRkZW4gPSBjaGlsZC5zdHlsZS5kaXNwbGF5IHx8IFwiXCI7XG4gICAgfVxuICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgfVxuICBsZXQgcGFuZWwgPSBjb250ZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS10d2Vha2VyPVwidHdlYWtzLXBhbmVsXCJdJyk7XG4gIGlmICghcGFuZWwpIHtcbiAgICBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcGFuZWwuZGF0YXNldC50d2Vha2VyID0gXCJ0d2Vha3MtcGFuZWxcIjtcbiAgICBwYW5lbC5zdHlsZS5jc3NUZXh0ID0gXCJ3aWR0aDoxMDAlO2hlaWdodDoxMDAlO292ZXJmbG93OmF1dG87XCI7XG4gICAgY29udGVudC5hcHBlbmRDaGlsZChwYW5lbCk7XG4gIH1cbiAgcGFuZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgc3RhdGUucGFuZWxIb3N0ID0gcGFuZWw7XG4gIHJlcmVuZGVyKCk7XG4gIHNldE5hdkFjdGl2ZShwYWdlKTtcbiAgLy8gcmVzdG9yZSBDb2RleCdzIHZpZXcuIFJlLXJlZ2lzdGVyIGlmIG5lZWRlZC5cbiAgY29uc3Qgc2lkZWJhciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoc2lkZWJhcikge1xuICAgIGlmIChzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICAgIHNpZGViYXIucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciwgdHJ1ZSk7XG4gICAgfVxuICAgIGNvbnN0IGhhbmRsZXIgPSAoZTogRXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG4gICAgICBpZiAoc3RhdGUubmF2R3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIGJ1dHRvbnNcbiAgICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBwYWdlIGJ1dHRvbnNcbiAgICAgIGlmICh0YXJnZXQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc2V0dGluZ3Mtc2VhcmNoXVwiKSkgcmV0dXJuO1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgIH07XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gaGFuZGxlcjtcbiAgICBzaWRlYmFyLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBoYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXN0b3JlQ29kZXhWaWV3KCk6IHZvaWQge1xuICBwbG9nKFwicmVzdG9yZSBjb2RleCB2aWV3XCIpO1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaWYgKHN0YXRlLnBhbmVsSG9zdCkgc3RhdGUucGFuZWxIb3N0LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQgPT09IHN0YXRlLnBhbmVsSG9zdCkgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuO1xuICAgICAgZGVsZXRlIGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbjtcbiAgICB9XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gIHNldE5hdkFjdGl2ZShudWxsKTtcbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgIHN0YXRlLnNpZGViYXJSb290LnJlbW92ZUV2ZW50TGlzdGVuZXIoXG4gICAgICBcImNsaWNrXCIsXG4gICAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXJlbmRlcigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5hY3RpdmVQYWdlKSByZXR1cm47XG4gIGNvbnN0IGhvc3QgPSBzdGF0ZS5wYW5lbEhvc3Q7XG4gIGlmICghaG9zdCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgaXRlbSA9IHNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oYXAuaWQpO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBlbnRyaWVzID0gcmVnaXN0ZXJlZFBhZ2VzRm9yVHdlYWsoYXAuaWQpO1xuICAgIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKGl0ZW0udGl0bGUsIGl0ZW0uZGVzY3JpcHRpb24pO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gICAgcm9vdC5oZWFkZXJUaXRsZUFjdGlvbnMuYXBwZW5kQ2hpbGQodHdlYWtMaWZlY3ljbGVCYWRnZShpdGVtKSk7XG4gICAgaWYgKGl0ZW0ud2FybmluZykgcm9vdC5zZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQodHdlYWtQYWdlV2FybmluZyhpdGVtLndhcm5pbmcpKTtcbiAgICBpZiAoIWVudHJpZXMubGVuZ3RoKSB7XG4gICAgICByZW5kZXJGYWxsYmFja1R3ZWFrUGFnZShyb290LnNlY3Rpb25zV3JhcCwgaXRlbSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICAgICAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICAgIGlmIChlbnRyaWVzLmxlbmd0aCA+IDEpIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKGVudHJ5LnBhZ2UudGl0bGUpKTtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICB0YXJnZXQuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gICAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHRhcmdldCk7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gICAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHRhcmdldCk7XG4gICAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zdCBlcnIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgICBlcnIudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHBhZ2U6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgICAgdGFyZ2V0LmFwcGVuZENoaWxkKGVycik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpdGxlID1cbiAgICBhcC5raW5kID09PSBcInR3ZWFrc1wiID8gXCJUd2Vha3NcIiA6XG4gICAgYXAua2luZCA9PT0gXCJzdG9yZVwiID8gXCJUd2VhayBTdG9yZVwiIDogXCJUd2Vha2Vyc1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9XG4gICAgYXAua2luZCA9PT0gXCJ0d2Vha3NcIlxuICAgICAgPyBcIk1hbmFnZSB5b3VyIGNhdGFsb2cgZW50cmllcyBhbmQgaW5zdGFsbGVkIHR3ZWFrcy5cIlxuICAgICAgOiBhcC5raW5kID09PSBcInN0b3JlXCJcbiAgICAgICAgPyBcIkluc3RhbGwgcmV2aWV3ZWQgdHdlYWtzIHBpbm5lZCB0byBhcHByb3ZlZCBHaXRIdWIgY29tbWl0cy5cIlxuICAgICAgICA6IFwiQ2hlY2tpbmcgaW5zdGFsbGVkIFR3ZWFrZXJzIHZlcnNpb24uXCI7XG4gIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKFxuICAgIHRpdGxlLFxuICAgIHN1YnRpdGxlLFxuICAgIGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyB7IHdpZHRoOiBcInBsdWdpbnNcIiB9IDogdW5kZWZpbmVkLFxuICApO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgaWYgKGFwLmtpbmQgPT09IFwic3RvcmVcIikgcmVuZGVyVHdlYWtTdG9yZVBhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3QuaGVhZGVyQWN0aW9ucyk7XG4gIGVsc2UgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbmZ1bmN0aW9uIHRlYXJkb3duUmVuZGVyZWRQYWdlcygpOiB2b2lkIHtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwPy4oKTtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gbnVsbDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkudGVhcmRvd24pIGNvbnRpbnVlO1xuICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duKCk7IH0gY2F0Y2gge31cbiAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHBhZ2VzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0d2Vha0xpZmVjeWNsZUJhZGdlKGl0ZW06IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gYCR7aXRlbS52ZXJzaW9ufSBcdTAwQjcgJHtsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSl9YDtcbiAgYmFkZ2UudGl0bGUgPSBgJHtpdGVtLnZlcnNpb259IFx1MDBCNyAke2xpZmVjeWNsZUxhYmVsKGl0ZW0ubGlmZWN5Y2xlLCBpdGVtLndhcm5pbmcpfWA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtQYWdlV2FybmluZyhtZXNzYWdlOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3YXJuaW5nLmNsYXNzTmFtZSA9IFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cvMzAgYmctdG9rZW4tY2hhcnRzLXllbGxvdy8xMCBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB3YXJuaW5nLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgcmV0dXJuIHdhcm5pbmc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckZhbGxiYWNrVHdlYWtQYWdlKHJvb3Q6IEhUTUxFbGVtZW50LCBpdGVtOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtKTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJTdGF0dXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJWZXJzaW9uXCIsIGl0ZW0udmVyc2lvbikpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxpZmVjeWNsZVwiLCBsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSwgaXRlbS53YXJuaW5nKSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlNldHRpbmdzIHBhZ2VcIiwgXCJUaGlzIGVuYWJsZWQgVHdlYWtlciBoYXMgbm90IHJlZ2lzdGVyZWQgaXRzIGN1c3RvbSBwYWdlIHlldC4gUnVudGltZSBzdGF0dXMgcmVtYWlucyBhdmFpbGFibGUgaGVyZS5cIikpO1xuICBpZiAoW1wiZmFpbGVkXCIsIFwicXVhcmFudGluZWRcIiwgXCJ0aW1lZF9vdXRcIl0uaW5jbHVkZXMoaXRlbS5saWZlY3ljbGUpKSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHJvd0NvcHkoXCJSZWNvdmVyeVwiLCBcIkNsZWFyIHRoZSBmYWlsdXJlIGFuZCByZXRyeSB0aGlzIFR3ZWFrZXIgd2l0aG91dCByZW1vdmluZyBpdHMgZGF0YS5cIikpO1xuICAgIGNvbnN0IHJlY292ZXIgPSBjb21wYWN0QnV0dG9uKFwiUmVjb3ZlclwiLCAoKSA9PiB7XG4gICAgICByZWNvdmVyLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWNvdmVyLXR3ZWFrXCIsIGl0ZW0udHdlYWtJZCkuZmluYWxseSgoKSA9PiB7IHJlY292ZXIuZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgfSk7XG4gICAgcm93LmFwcGVuZENoaWxkKHJlY292ZXIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICByb290LmFwcGVuZENoaWxkKHNlY3Rpb24pO1xufVxuXG5mdW5jdGlvbiByb3dDb3B5KHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29weS5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2NyaXB0aW9uLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGRlc2NyaXB0aW9uLnRleHRDb250ZW50ID0gZGV0YWlsO1xuICBjb3B5LmFwcGVuZChoZWFkaW5nLCBkZXNjcmlwdGlvbik7XG4gIHJldHVybiBjb3B5O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb25maWdQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBzdWJ0aXRsZT86IEhUTUxFbGVtZW50LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGNsZWFudXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICBjb25zdCBjYXJkVXBkYXRlcyA9IG5ldyBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4oKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJFbnZpcm9ubWVudFNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKHNlY3Rpb25zV3JhcCwgY2FyZFVwZGF0ZXMpKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJUd2Vha3NIZWFsdGhTZWN0aW9uKHNlY3Rpb25zV3JhcCwgY2FyZFVwZGF0ZXMpKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJNY3BJbnRlZ3JhdGlvblNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckF1dG9tYXRpY01haW50ZW5hbmNlU2VjdGlvbihzZWN0aW9uc1dyYXAsIGNhcmRVcGRhdGVzKSk7XG5cbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIlR3ZWFrZXJzIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJDb25maWdDYXJkID0gXCJ0cnVlXCI7XG4gIGNvbnN0IGxvYWRpbmcgPSByb3dTaW1wbGUoXCJMb2FkaW5nIHVwZGF0ZSBzZXR0aW5nc1wiLCBcIkNoZWNraW5nIGN1cnJlbnQgVHdlYWtlcnMgY29uZmlndXJhdGlvbi5cIik7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobG9hZGluZyk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvbmZpZ1wiKVxuICAgIC50aGVuKChjb25maWcpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IGBZb3UgaGF2ZSBUd2Vha2VycyAkeyhjb25maWcgYXMgVHdlYWtlckNvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZCwgY29uZmlnIGFzIFR3ZWFrZXJDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgVHdlYWtlcnMgdmVyc2lvbi5cIjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCB1cGRhdGUgc2V0dGluZ3NcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG5cbiAgcmVuZGVyQWR2YW5jZWRSdW50aW1lU2VjdGlvbihzZWN0aW9uc1dyYXApO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgZm9yIChjb25zdCBjbGVhbnVwIG9mIGNsZWFudXBzLnNwbGljZSgwKSkge1xuICAgICAgdHJ5IHsgY2xlYW51cCgpOyB9IGNhdGNoIHt9XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIENvZGV4LW5hdGl2ZSBlbnZpcm9ubWVudCBjb250cm9scy4gQXBwIGV4cGVyaWVuY2UgYW5kIHJlbGVhc2UgcHJvZmlsZSBhcmVcbiAqIGRlbGliZXJhdGVseSBpbmRlcGVuZGVudCBzZWxlY3Rpb25zOiBjaGFuZ2luZyBlaXRoZXIgb25lIG9ubHkgc3RhZ2VzIGFcbiAqIHBlbmRpbmcgdmFsdWUgdW50aWwgdGhlIHVzZXIgY2hvb3NlcyBBcHBseSAmIFJlc3RhcnQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckVudmlyb25tZW50U2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXBwIE1vZGUgJiBEZXNrdG9wIFJlbGVhc2VcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJFbnZpcm9ubWVudENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIGVudmlyb25tZW50XCIsIFwiQ2hlY2tpbmcgYXZhaWxhYmxlIGFwcCBleHBlcmllbmNlcyBhbmQgcmVsZWFzZSBwcm9maWxlcy5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGVudmlyb25tZW50OiBFbnZpcm9ubWVudFN0YXR1cyB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24gfCBudWxsID0gbnVsbDtcbiAgbGV0IGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICBsZXQgZW52aXJvbm1lbnRBY3Rpb25FcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvblBvbGxpbmc6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBsYXN0VHJhbnNhY3Rpb25GZXRjaEZhaWxlZCA9IGZhbHNlO1xuXG4gIGNvbnN0IGN1cnJlbnRTZWxlY3Rpb24gPSAoKTogRW52aXJvbm1lbnRTZWxlY3Rpb24gfCBudWxsID0+IGVudmlyb25tZW50Py5zZWxlY3RlZCA/PyBudWxsO1xuICBjb25zdCBoYXNQZW5kaW5nQ2hhbmdlcyA9ICgpOiBib29sZWFuID0+IGVudmlyb25tZW50ICE9PSBudWxsICYmIGVudmlyb25tZW50Q29udHJvbGxlci5zbmFwc2hvdC5oYXNQZW5kaW5nQ2hhbmdlcztcbiAgY29uc3QgaXNFbnZpcm9ubWVudEJ1c3kgPSAoKTogYm9vbGVhbiA9PiBleHRlcm5hbEJ1c3kgfHwgZW52aXJvbm1lbnRDb250cm9sbGVyLnNuYXBzaG90LmJ1c3k7XG5cbiAgY29uc3QgcmVzdG9yZVBlcnNpc3RlZFJlcXVlc3QgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCF0cmFuc2FjdGlvbiB8fCAodHJhbnNhY3Rpb24ucGhhc2UgIT09IFwicHJlcGFyaW5nXCIgJiYgdHJhbnNhY3Rpb24ucGhhc2UgIT09IFwicHJlcGFyZWRcIikpIHJldHVybjtcbiAgICBjb25zdCByZXF1ZXN0ZWQgPSBlbnZpcm9ubWVudFRyYW5zYWN0aW9uUmVxdWVzdGVkU2VsZWN0aW9uKHRyYW5zYWN0aW9uKTtcbiAgICBpZiAocmVxdWVzdGVkKSBlbnZpcm9ubWVudENvbnRyb2xsZXIucmVzdG9yZVBlbmRpbmcocmVxdWVzdGVkKTtcbiAgfTtcblxuICBjb25zdCBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICh0cmFuc2FjdGlvblBvbGxpbmcpIGNsZWFyVGltZW91dCh0cmFuc2FjdGlvblBvbGxpbmcpO1xuICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgLy8gQSBudWxsIHRyYW5zYWN0aW9uIGFmdGVyIGEgRkFJTEVEIGZldGNoIG11c3Qgbm90IGVuZCBwb2xsaW5nOiBhXG4gICAgLy8gdHJhbnNpZW50bHkgZmFpbGluZyBgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gLS1qc29uYCB3b3VsZCBvdGhlcndpc2VcbiAgICAvLyBoaWRlIGFuIGluLWZsaWdodCBvciBzdHJhbmRlZCByZWNlaXB0IHVudGlsIHRoZSB0YWIgaXMgcmUtbW91bnRlZC5cbiAgICBpZiAoIXRyYW5zYWN0aW9uICYmICFsYXN0VHJhbnNhY3Rpb25GZXRjaEZhaWxlZCkgcmV0dXJuO1xuICAgIGlmICh0cmFuc2FjdGlvbiAmJiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbCh0cmFuc2FjdGlvbi5waGFzZSkpIHJldHVybjtcbiAgICB0cmFuc2FjdGlvblBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gICAgfSwgbGFzdFRyYW5zYWN0aW9uRmV0Y2hGYWlsZWQgPyA1XzAwMCA6IDkwMCk7XG4gIH07XG5cbiAgYXN5bmMgZnVuY3Rpb24gcHJlcGFyZUVudmlyb25tZW50U2VsZWN0aW9uKFxuICAgIHJlcXVlc3RlZDogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuICApOiBQcm9taXNlPEVudmlyb25tZW50VHJhbnNhY3Rpb24+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgY29uc3QgcHJlcGFyZWQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnByZXBhcmUtZW52aXJvbm1lbnRcIiwgcmVxdWVzdGVkKTtcbiAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCBwcmVwYXJhdGlvbiB3YXMgc3VwZXJzZWRlZFwiKTtcbiAgICBjb25zdCByZWNlaXB0ID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihwcmVwYXJlZCk7XG4gICAgaWYgKCFyZWNlaXB0KSB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCBwcmVwYXJhdGlvbiByZXR1cm5lZCBubyB0cmFuc2FjdGlvbiByZWNlaXB0XCIpO1xuICAgIHRyYW5zYWN0aW9uID0gcmVjZWlwdDtcbiAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgcmV0dXJuIHJlY2VpcHQ7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjb21taXRQcmVwYXJlZEVudmlyb25tZW50KHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgbGV0IHJlc3VsdDogdW5rbm93bjtcbiAgICB0cnkge1xuICAgICAgcmVzdWx0ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb21taXQtZW52aXJvbm1lbnRcIiwgeyB0cmFuc2FjdGlvbklkOiByZWNlaXB0LnRyYW5zYWN0aW9uSWQgfSk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGBDb3VsZCBub3Qgc3VibWl0IGVudmlyb25tZW50IGNoYW5nZTogJHtzYWZlVWlFcnJvcihlcnJvcil9YDtcbiAgICAgIHRyYW5zYWN0aW9uID0geyAuLi5yZWNlaXB0LCBlcnJvcjogZGV0YWlsIH07XG4gICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZGV0YWlsKTtcbiAgICB9XG4gICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSkgdGhyb3cgbmV3IEVycm9yKFwiRW52aXJvbm1lbnQgY29vcmRpbmF0b3Igc3VibWlzc2lvbiB3YXMgc3VwZXJzZWRlZFwiKTtcbiAgICBjb25zdCBzdWJtaXNzaW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uKHJlc3VsdCk7XG4gICAgY29uc3Qgb2JzZXJ2ZWQgPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlc3VsdCk7XG4gICAgdHJhbnNhY3Rpb24gPSBzdWJtaXNzaW9uXG4gICAgICA/IHtcbiAgICAgICAgLi4ucmVjZWlwdCxcbiAgICAgICAgZXJyb3I6IHN1Ym1pc3Npb24uZXJyb3IgPz8gbnVsbCxcbiAgICAgICAgaGVscGVyOiB7IC4uLihyZWNlaXB0LmhlbHBlciA/PyB7fSksIHN1Ym1pc3Npb24gfSxcbiAgICAgIH1cbiAgICAgIDogb2JzZXJ2ZWQgPz8gcmVjZWlwdDtcbiAgICByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCgpO1xuICAgIGlmIChzdWJtaXNzaW9uPy5waGFzZSA9PT0gXCJzdWJtaXQtZmFpbGVkXCIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGBDb3VsZCBub3Qgc3VibWl0IGVudmlyb25tZW50IGNoYW5nZTogJHtzdWJtaXNzaW9uLmVycm9yIHx8IFwiRW52aXJvbm1lbnQgY29vcmRpbmF0b3Igc3VibWlzc2lvbiBmYWlsZWRcIn1gO1xuICAgICAgdHJhbnNhY3Rpb24gPSB7IC4uLnRyYW5zYWN0aW9uLCBlcnJvcjogZGV0YWlsIH07XG4gICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZGV0YWlsKTtcbiAgICB9XG4gICAgdm9pZCBsb2FkRW52aXJvbm1lbnRUcmFuc2FjdGlvbigpO1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY2FuY2VsUHJlcGFyZWRFbnZpcm9ubWVudChyZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjYW5jZWwtZW52aXJvbm1lbnRcIiwgeyB0cmFuc2FjdGlvbklkOiByZWNlaXB0LnRyYW5zYWN0aW9uSWQgfSk7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCBjYW5jZWxsYXRpb24gd2FzIHN1cGVyc2VkZWRcIik7XG4gICAgICB0cmFuc2FjdGlvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVzdWx0KSA/PyByZWNlaXB0O1xuICAgICAgaWYgKHRyYW5zYWN0aW9uLnBoYXNlICE9PSBcImNhbmNlbGxlZFwiKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgRW52aXJvbm1lbnQgY2FuY2VsbGF0aW9uIHJldHVybmVkICR7dHJhbnNhY3Rpb24ucGhhc2V9YCk7XG4gICAgICB9XG4gICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGBDb3VsZCBub3QgY2FuY2VsIGVudmlyb25tZW50IHRyYW5zYWN0aW9uOiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgdHJhbnNhY3Rpb24gPSB7IC4uLnJlY2VpcHQsIGVycm9yOiBkZXRhaWwgfTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihkZXRhaWwpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGVudmlyb25tZW50Q29udHJvbGxlciA9IGNyZWF0ZUVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxFbnZpcm9ubWVudFRyYW5zYWN0aW9uPihcbiAgICB7IGFwcEV4cGVyaWVuY2U6IFwiY2hhdGdwdFwiLCByZWxlYXNlUHJvZmlsZTogXCJzdGFibGVcIiB9LFxuICAgIHtcbiAgICAgIHByZXBhcmU6IHByZXBhcmVFbnZpcm9ubWVudFNlbGVjdGlvbixcbiAgICAgIGNvbmZpcm06IChyZXF1ZXN0ZWQsIHJlY2VpcHQpID0+IG9wZW5FbnZpcm9ubWVudENvbmZpcm1Nb2RhbChyZXF1ZXN0ZWQsIHJlY2VpcHQpLFxuICAgICAgY29tbWl0OiBjb21taXRQcmVwYXJlZEVudmlyb25tZW50LFxuICAgICAgY2FuY2VsOiBjYW5jZWxQcmVwYXJlZEVudmlyb25tZW50LFxuICAgIH0sXG4gICAge1xuICAgICAgb25DaGFuZ2U6IChzbmFwc2hvdCkgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gc25hcHNob3QuZXJyb3I7XG4gICAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkKSBkcmF3KCk7XG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgZnVuY3Rpb24gb3BlblByZXBhcmVkRW52aXJvbm1lbnRDb25maXJtYXRpb24oXG4gICAgcmVxdWVzdGVkOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4sXG4gICAgcmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbiAgKTogdm9pZCB7XG4gICAgaWYgKHJlY2VpcHQucGhhc2UgIT09IFwicHJlcGFyZWRcIikgcmV0dXJuO1xuICAgIHZvaWQgZW52aXJvbm1lbnRDb250cm9sbGVyLnJlc3VtZVByZXBhcmVkKHJlcXVlc3RlZCwgcmVjZWlwdCk7XG4gIH1cblxuICBmdW5jdGlvbiBjYW5jZWxFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiB2b2lkIHtcbiAgICBpZiAoaXNFbnZpcm9ubWVudEJ1c3koKSB8fCAocmVjZWlwdC5waGFzZSAhPT0gXCJwcmVwYXJpbmdcIiAmJiByZWNlaXB0LnBoYXNlICE9PSBcInByZXBhcmVkXCIpKSByZXR1cm47XG4gICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG51bGw7XG4gICAgZXh0ZXJuYWxCdXN5ID0gdHJ1ZTtcbiAgICBkcmF3KCk7XG4gICAgdm9pZCBjYW5jZWxQcmVwYXJlZEVudmlyb25tZW50KHJlY2VpcHQpXG4gICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgIGNvbnN0IHNlbGVjdGVkID0gY3VycmVudFNlbGVjdGlvbigpO1xuICAgICAgICBpZiAodHJhbnNhY3Rpb24/LnBoYXNlID09PSBcImNhbmNlbGxlZFwiICYmIHNlbGVjdGVkKSB7XG4gICAgICAgICAgZW52aXJvbm1lbnRDb250cm9sbGVyLnNldFNlbGVjdGVkKHNlbGVjdGVkKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IHNhZmVVaUVycm9yKGVycm9yKTtcbiAgICAgIH0pXG4gICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIHJlY292ZXJFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiB2b2lkIHtcbiAgICBpZiAoaXNFbnZpcm9ubWVudEJ1c3koKSB8fCAhZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIocmVjZWlwdCkpIHJldHVybjtcbiAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICBleHRlcm5hbEJ1c3kgPSB0cnVlO1xuICAgIGRyYXcoKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwidHdlYWtlcjpyZWNvdmVyLWVudmlyb25tZW50XCIsIHsgdHJhbnNhY3Rpb25JZDogcmVjZWlwdC50cmFuc2FjdGlvbklkIH0pXG4gICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgIGNvbnN0IG5leHQgPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlc3VsdCkgPz8gcmVjZWlwdDtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBuZXh0O1xuICAgICAgICAvLyBUaGUgQ0xJIHJldHVybnMgaXRzIGR1cmFibGUgcmVjZWlwdCB3aGV0aGVyIG9yIG5vdCByZWNvdmVyeVxuICAgICAgICAvLyBzdWNjZWVkZWQuIEEgcmVjZWlwdCBzdGlsbCBzaXR0aW5nIGluIGBmYWlsZWRgIGlzIGEgZmFpbHVyZSwgbm90IGFcbiAgICAgICAgLy8gcmVzdWx0IHRvIHJlbmRlciBzaWxlbnRseS5cbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG5leHQucGhhc2UgPT09IFwiZmFpbGVkXCJcbiAgICAgICAgICA/IGBDb3VsZCBub3QgcmVjb3ZlciB0aGUgYXBwIG1vZGUgc2FmZWx5OiAke25leHQuZXJyb3IgPz8gXCJ0aGUgdHJhbnNhY3Rpb24gaXMgc3RpbGwgZmFpbGVkXCJ9YFxuICAgICAgICAgIDogbnVsbDtcbiAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IGBDb3VsZCBub3QgcmVjb3ZlciB0aGUgYXBwIG1vZGUgc2FmZWx5OiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgICB0cmFuc2FjdGlvbiA9IHtcbiAgICAgICAgICAuLi5yZWNlaXB0LFxuICAgICAgICAgIGVycm9yOiBlbnZpcm9ubWVudEFjdGlvbkVycm9yLFxuICAgICAgICB9O1xuICAgICAgICBleHRlcm5hbEJ1c3kgPSBmYWxzZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB9KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGFwcGVuZEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coKTogdm9pZCB7XG4gICAgaWYgKCF0cmFuc2FjdGlvbikgcmV0dXJuO1xuICAgIGNvbnN0IHJlY2VpcHQgPSB0cmFuc2FjdGlvbjtcbiAgICBjb25zdCByZXF1ZXN0ZWQgPSBlbnZpcm9ubWVudFRyYW5zYWN0aW9uUmVxdWVzdGVkU2VsZWN0aW9uKHJlY2VpcHQpO1xuICAgIGNvbnN0IGhlbHBlckluRmxpZ2h0ID0gZW52aXJvbm1lbnRIZWxwZXJJc0luRmxpZ2h0KHJlY2VpcHQpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoZW52aXJvbm1lbnRUcmFuc2FjdGlvblJvdyhyZWNlaXB0LCB7XG4gICAgICBidXN5OiBpc0Vudmlyb25tZW50QnVzeSgpLFxuICAgICAgb25SZXN1bWU6IHJlY2VpcHQucGhhc2UgPT09IFwicHJlcGFyZWRcIiAmJiByZXF1ZXN0ZWQgJiYgIWhlbHBlckluRmxpZ2h0XG4gICAgICAgID8gKCkgPT4gb3BlblByZXBhcmVkRW52aXJvbm1lbnRDb25maXJtYXRpb24ocmVxdWVzdGVkLCByZWNlaXB0KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIG9uQ2FuY2VsOiAocmVjZWlwdC5waGFzZSA9PT0gXCJwcmVwYXJpbmdcIiB8fCByZWNlaXB0LnBoYXNlID09PSBcInByZXBhcmVkXCIpICYmICFoZWxwZXJJbkZsaWdodFxuICAgICAgICA/ICgpID0+IGNhbmNlbEVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdClcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICBvblJlY292ZXI6IGVudmlyb25tZW50VHJhbnNhY3Rpb25DYW5SZWNvdmVyKHJlY2VpcHQpXG4gICAgICAgID8gKCkgPT4gcmVjb3ZlckVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdClcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgfSkpO1xuICB9XG5cbiAgY29uc3QgZHJhdyA9ICgpOiB2b2lkID0+IHtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICBjb25zdCBzZWxlY3RlZCA9IGN1cnJlbnRTZWxlY3Rpb24oKTtcbiAgICBpZiAoIXNlbGVjdGVkIHx8ICFlbnZpcm9ubWVudCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJFbnZpcm9ubWVudCB1bmF2YWlsYWJsZVwiLCBcIlRoZSBjdXJyZW50IGVudmlyb25tZW50IHNlbGVjdGlvbiBjb3VsZCBub3QgYmUgbG9hZGVkLlwiKSk7XG4gICAgICBhcHBlbmRFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KCk7XG4gICAgICBpZiAoZW52aXJvbm1lbnRBY3Rpb25FcnJvciAmJiBlbnZpcm9ubWVudEFjdGlvbkVycm9yICE9PSB0cmFuc2FjdGlvbj8uZXJyb3IpIHtcbiAgICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJFbnZpcm9ubWVudCBhY3Rpb24gZmFpbGVkXCIsIGVudmlyb25tZW50QWN0aW9uRXJyb3IpKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgcGVuZGluZyA9IGVudmlyb25tZW50Q29udHJvbGxlci5zbmFwc2hvdC5wZW5kaW5nO1xuICAgIGNvbnN0IGJ1c3kgPSBpc0Vudmlyb25tZW50QnVzeSgpO1xuICAgIGNvbnN0IG9ic2VydmVkRXhwZXJpZW5jZSA9IGVudmlyb25tZW50Lm9ic2VydmF0aW9uPy5hcHBFeHBlcmllbmNlO1xuICAgIGNvbnN0IG9ic2VydmF0aW9uTmVlZHNSZXBhaXIgPSBlbnZpcm9ubWVudC5vYnNlcnZhdGlvbiAhPT0gdW5kZWZpbmVkXG4gICAgICAmJiAob2JzZXJ2ZWRFeHBlcmllbmNlID09PSBudWxsXG4gICAgICAgIHx8IG9ic2VydmVkRXhwZXJpZW5jZSAhPT0gc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZVxuICAgICAgICB8fCBlbnZpcm9ubWVudC5vYnNlcnZhdGlvbi50cmFuc2l0aW9uSm91cm5hbFByZXNlbnQpO1xuICAgIGNvbnN0IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkID0gYnVzeVxuICAgICAgfHwgb2JzZXJ2YXRpb25OZWVkc1JlcGFpclxuICAgICAgfHwgKHRyYW5zYWN0aW9uICE9PSBudWxsICYmIChcbiAgICAgICAgIWVudmlyb25tZW50VHJhbnNhY3Rpb25Jc1Rlcm1pbmFsKHRyYW5zYWN0aW9uLnBoYXNlKVxuICAgICAgICB8fCBlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3Zlcih0cmFuc2FjdGlvbilcbiAgICAgICkpO1xuXG4gICAgaWYgKG9ic2VydmF0aW9uTmVlZHNSZXBhaXIpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVudmlyb25tZW50Lm9ic2VydmF0aW9uPy50cmFuc2l0aW9uSm91cm5hbFByZXNlbnRcbiAgICAgICAgPyBcIkEgbGVnYWN5IG1vZGUgdHJhbnNpdGlvbiBpcyBzdGlsbCBwcmVzZW50LiBSdW4gdHdlYWtlciByZXBhaXIgaW4gVGVybWluYWwgYmVmb3JlIHN3aXRjaGluZy5cIlxuICAgICAgICA6IG9ic2VydmVkRXhwZXJpZW5jZSA9PT0gbnVsbCB8fCBvYnNlcnZlZEV4cGVyaWVuY2UgPT09IHVuZGVmaW5lZFxuICAgICAgICAgID8gXCJUaGUgbGl2ZSBhcHAgbWFya2VyIGNvdWxkIG5vdCBiZSB2ZXJpZmllZC4gUnVuIHR3ZWFrZXIgcmVwYWlyIGluIFRlcm1pbmFsIGJlZm9yZSBzd2l0Y2hpbmcuXCJcbiAgICAgICAgICA6IGBTYXZlZCBtb2RlIGlzICR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwoc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSl9LCBidXQgdGhlIGxpdmUgYXBwIHByb3ZlcyAke2Vudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKG9ic2VydmVkRXhwZXJpZW5jZSl9LiBSdW4gdHdlYWtlciByZXBhaXIgaW4gVGVybWluYWwuYDtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiRW52aXJvbm1lbnQgbmVlZHMgcmVwYWlyXCIsIGRldGFpbCkpO1xuICAgIH1cblxuICAgIGNvbnN0IHBlbmRpbmdBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwgcGVuZGluZyk7XG4gICAgY29uc3QgY2hhdGdwdEF2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCB7XG4gICAgICBhcHBFeHBlcmllbmNlOiBcImNoYXRncHRcIixcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBwZW5kaW5nLnJlbGVhc2VQcm9maWxlLFxuICAgIH0pO1xuICAgIGNvbnN0IHR3ZWFrZXJzQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IFwidHdlYWtlcnNcIixcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBwZW5kaW5nLnJlbGVhc2VQcm9maWxlLFxuICAgIH0pO1xuXG4gICAgY2FyZC5hcHBlbmRDaGlsZChlbnZpcm9ubWVudENob2ljZVJvdyhcbiAgICAgIFwiQXBwIE1vZGVcIixcbiAgICAgIFwiQ2hhdEdQVCBkaXNhYmxlcyBldmVyeSB0d2Vhay4gVHdlYWtlcnMgcmVzdG9yZXMgdGhlIHR3ZWFrcyB5b3UgcHJldmlvdXNseSBlbmFibGVkLlwiLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IFwiY2hhdGdwdFwiLFxuICAgICAgICAgIGxhYmVsOiBcIkNoYXRHUFRcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogY2hhdGdwdEF2YWlsYWJpbGl0eS5hdmFpbGFibGVcbiAgICAgICAgICAgID8gXCJPcGVuQUkncyBzdGFuZGFyZCBhcHAgZXhwZXJpZW5jZS5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKGNoYXRncHRBdmFpbGFiaWxpdHksIFwiQ2hhdEdQVCBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICAgIGRpc2FibGVkOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZCB8fCAhY2hhdGdwdEF2YWlsYWJpbGl0eS5hdmFpbGFibGUsXG4gICAgICAgICAgZGlzYWJsZWRSZWFzb246IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICAgICAgICA/IFwiRmluaXNoLCBjYW5jZWwsIG9yIHJlY292ZXIgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gZmlyc3QuXCJcbiAgICAgICAgICAgIDogZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihjaGF0Z3B0QXZhaWxhYmlsaXR5LCBcIkNoYXRHUFQgaXMgdW5hdmFpbGFibGUgZm9yIHRoaXMgcmVsZWFzZSBwcm9maWxlLlwiKSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcInR3ZWFrZXJzXCIsXG4gICAgICAgICAgbGFiZWw6IFwiVHdlYWtlcnNcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogdHdlYWtlcnNBdmFpbGFiaWxpdHkuYXZhaWxhYmxlXG4gICAgICAgICAgICA/IFwiVGhlIHN0YW5kYXJkIGFwcCB3aXRoIGVuYWJsZWQgVHdlYWtlcnMgZmVhdHVyZXMuXCJcbiAgICAgICAgICAgIDogZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbih0d2Vha2Vyc0F2YWlsYWJpbGl0eSwgXCJUd2Vha2VycyBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICAgIGRpc2FibGVkOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZCB8fCAhdHdlYWtlcnNBdmFpbGFiaWxpdHkuYXZhaWxhYmxlLFxuICAgICAgICAgIGRpc2FibGVkUmVhc29uOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgICAgICAgPyBcIkZpbmlzaCwgY2FuY2VsLCBvciByZWNvdmVyIHRoZSBjdXJyZW50IGVudmlyb25tZW50IHRyYW5zYWN0aW9uIGZpcnN0LlwiXG4gICAgICAgICAgICA6IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24odHdlYWtlcnNBdmFpbGFiaWxpdHksIFwiVHdlYWtlcnMgaXMgdW5hdmFpbGFibGUgZm9yIHRoaXMgcmVsZWFzZSBwcm9maWxlLlwiKSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBwZW5kaW5nLmFwcEV4cGVyaWVuY2UsXG4gICAgICAodmFsdWUpID0+IHtcbiAgICAgICAgZW52aXJvbm1lbnRDb250cm9sbGVyLnN0YWdlQXBwRXhwZXJpZW5jZSh2YWx1ZSBhcyBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UpO1xuICAgICAgfSxcbiAgICApKTtcblxuICAgIGNvbnN0IHN0YWJsZUF2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCB7XG4gICAgICBhcHBFeHBlcmllbmNlOiBwZW5kaW5nLmFwcEV4cGVyaWVuY2UsXG4gICAgICByZWxlYXNlUHJvZmlsZTogXCJzdGFibGVcIixcbiAgICB9KTtcbiAgICBjb25zdCBhbHBoYUF2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCB7XG4gICAgICBhcHBFeHBlcmllbmNlOiBwZW5kaW5nLmFwcEV4cGVyaWVuY2UsXG4gICAgICByZWxlYXNlUHJvZmlsZTogXCJhbHBoYVwiLFxuICAgIH0pO1xuICAgIGNvbnN0IHN0YWJsZVJlYXNvbiA9IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oc3RhYmxlQXZhaWxhYmlsaXR5LCBcIlN0YWJsZSBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyBhcHAgZXhwZXJpZW5jZS5cIik7XG4gICAgY29uc3QgYWxwaGFSZWFzb24gPSBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKGFscGhhQXZhaWxhYmlsaXR5LCBcIkFscGhhIChQcmUtcmVsZWFzZSkgaXMgdW5hdmFpbGFibGUgb24gdGhpcyBNYWMuXCIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoZW52aXJvbm1lbnRDaG9pY2VSb3coXG4gICAgICBcIkRlc2t0b3AgUmVsZWFzZVwiLFxuICAgICAgXCJDaG9vc2UgT3BlbkFJJ3MgU3RhYmxlIG9yIEFscGhhIGRlc2t0b3AgYXBwIGluZGVwZW5kZW50bHkgb2YgYXBwIG1vZGUuIEl0cyBlbWJlZGRlZCBDb2RleCBiYWNrZW5kIGNhbiBoYXZlIGEgZGlmZmVyZW50IHZlcnNpb24gbGFiZWwuXCIsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICB2YWx1ZTogXCJzdGFibGVcIixcbiAgICAgICAgICBsYWJlbDogXCJTdGFibGVcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogc3RhYmxlQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSA/IFwiVGhlIHN1cHBvcnRlZCBzdGFibGUgZGVza3RvcCByZWxlYXNlLlwiIDogc3RhYmxlUmVhc29uLFxuICAgICAgICAgIGRpc2FibGVkOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZCB8fCAhc3RhYmxlQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBzdGFibGVSZWFzb24sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICB2YWx1ZTogXCJhbHBoYVwiLFxuICAgICAgICAgIGxhYmVsOiBcIkFscGhhIChQcmUtcmVsZWFzZSlcIixcbiAgICAgICAgICBkZXNjcmlwdGlvbjogYWxwaGFBdmFpbGFiaWxpdHkuYXZhaWxhYmxlID8gXCJPcGVuQUkncyB2ZXJpZmllZCBwcmUtcmVsZWFzZSBkZXNrdG9wIGFuZCBtYXRjaGluZyBiYWNrZW5kLlwiIDogYWxwaGFSZWFzb24sXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICFhbHBoYUF2YWlsYWJpbGl0eS5hdmFpbGFibGUsXG4gICAgICAgICAgZGlzYWJsZWRSZWFzb246IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICAgICAgICA/IFwiRmluaXNoLCBjYW5jZWwsIG9yIHJlY292ZXIgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gZmlyc3QuXCJcbiAgICAgICAgICAgIDogYWxwaGFSZWFzb24sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcGVuZGluZy5yZWxlYXNlUHJvZmlsZSxcbiAgICAgICh2YWx1ZSkgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudENvbnRyb2xsZXIuc3RhZ2VSZWxlYXNlUHJvZmlsZSh2YWx1ZSBhcyBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlKTtcbiAgICAgIH0sXG4gICAgKSk7XG4gICAgaWYgKCFhbHBoYUF2YWlsYWJpbGl0eS5hdmFpbGFibGUpIHtcbiAgICAgIGNvbnN0IGNob29zZXIgPSBhY3Rpb25Sb3coXG4gICAgICAgIFwiQWxwaGEgKFByZS1yZWxlYXNlKSB1bmF2YWlsYWJsZVwiLFxuICAgICAgICBgJHthbHBoYVJlYXNvbn0gQ2hvb3NlIGEgdmVyaWZpZWQgT3BlbkFJIEJldGEgYXBwIHRvIHJlZ2lzdGVyIGl0IGZvciB0aGlzIHByb2ZpbGUuYCxcbiAgICAgICk7XG4gICAgICBjb25zdCBjaG9vc2VyQWN0aW9ucyA9IGNob29zZXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgICAgIGNvbnN0IGNob29zZSA9IGNvbXBhY3RCdXR0b24oXCJDaG9vc2UgQmV0YSBBcHBcdTIwMjZcIiwgKCkgPT4ge1xuICAgICAgICBpZiAoaXNFbnZpcm9ubWVudEJ1c3koKSkgcmV0dXJuO1xuICAgICAgICBleHRlcm5hbEJ1c3kgPSB0cnVlO1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2hvb3NlLWFscGhhLWVudmlyb25tZW50XCIpXG4gICAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgICAgaWYgKHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0ID09PSBcIm9iamVjdFwiICYmIFwiY2FuY2VsZWRcIiBpbiByZXN1bHQgJiYgcmVzdWx0LmNhbmNlbGVkID09PSB0cnVlKSByZXR1cm47XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gYENvdWxkIG5vdCByZWdpc3RlciBPcGVuQUkgQmV0YTogJHtzYWZlVWlFcnJvcihlcnJvcil9YDtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICAgIGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICAgICAgICAgICAgdm9pZCBsb2FkKCk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICAgIGNob29zZS5kaXNhYmxlZCA9IGlzRW52aXJvbm1lbnRCdXN5KCk7XG4gICAgICBjaG9vc2VyQWN0aW9ucz8uYXBwZW5kQ2hpbGQoY2hvb3NlKTtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQoY2hvb3Nlcik7XG4gICAgfVxuXG4gICAgY29uc3Qgc3VtbWFyeSA9IGFjdGlvblJvdyhcbiAgICAgIFwiUGVuZGluZyBjaGFuZ2VzXCIsXG4gICAgICBoYXNQZW5kaW5nQ2hhbmdlcygpXG4gICAgICAgID8gcGVuZGluZ0F2YWlsYWJpbGl0eS5hdmFpbGFibGVcbiAgICAgICAgICA/IGAke2Vudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHBlbmRpbmcuYXBwRXhwZXJpZW5jZSl9IFx1MDBCNyAke2Vudmlyb25tZW50UHJvZmlsZUxhYmVsKHBlbmRpbmcucmVsZWFzZVByb2ZpbGUpfSB3aWxsIGFwcGx5IGFmdGVyIHJlc3RhcnQuYFxuICAgICAgICAgIDogYFVuYXZhaWxhYmxlOiAke2Vudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24ocGVuZGluZ0F2YWlsYWJpbGl0eSwgXCJUaGlzIGVudmlyb25tZW50IGNhbm5vdCBiZSBwcmVwYXJlZC5cIil9YFxuICAgICAgICA6IGBDdXJyZW50OiAke2Vudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UpfSBcdTAwQjcgJHtlbnZpcm9ubWVudFByb2ZpbGVMYWJlbChzZWxlY3RlZC5yZWxlYXNlUHJvZmlsZSl9LmAsXG4gICAgKTtcbiAgICBjb25zdCBhY3Rpb25zID0gc3VtbWFyeS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGNvbnN0IGFwcGx5ID0gY29tcGFjdEJ1dHRvbihcIkFwcGx5ICYgUmVzdGFydFwiLCAoKSA9PiB7XG4gICAgICBpZiAoaXNFbnZpcm9ubWVudEJ1c3koKSB8fCAhaGFzUGVuZGluZ0NoYW5nZXMoKSkgcmV0dXJuO1xuICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG51bGw7XG4gICAgICB2b2lkIGVudmlyb25tZW50Q29udHJvbGxlci5hcHBseUFuZFJlc3RhcnQoKVxuICAgICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgICAgaWYgKHJlc3VsdC5vdXRjb21lID09PSBcInByZXBhcmUtZmFpbGVkXCIpIHtcbiAgICAgICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSByZXN1bHQuZXJyb3I7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXN1bHQub3V0Y29tZS5lbmRzV2l0aChcImZhaWxlZFwiKSkge1xuICAgICAgICAgICAgZHJhdygpO1xuICAgICAgICAgIH1cbiAgICAgICAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgIGFwcGx5LmRpc2FibGVkID0gZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgIHx8ICFoYXNQZW5kaW5nQ2hhbmdlcygpXG4gICAgICB8fCAhcGVuZGluZ0F2YWlsYWJpbGl0eS5hdmFpbGFibGU7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoYXBwbHkpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoc3VtbWFyeSk7XG4gICAgYXBwZW5kRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvdygpO1xuICAgIGlmIChlbnZpcm9ubWVudEFjdGlvbkVycm9yICYmIGVudmlyb25tZW50QWN0aW9uRXJyb3IgIT09IHRyYW5zYWN0aW9uPy5lcnJvcikge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJFbnZpcm9ubWVudCBhY3Rpb24gZmFpbGVkXCIsIGVudmlyb25tZW50QWN0aW9uRXJyb3IpKTtcbiAgICB9XG4gIH07XG5cbiAgYXN5bmMgZnVuY3Rpb24gbG9hZEVudmlyb25tZW50VHJhbnNhY3Rpb24oKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBsYXN0VHJhbnNhY3Rpb25GZXRjaEZhaWxlZCA9IGZhbHNlO1xuICAgICAgY29uc3QgcHJldmlvdXMgPSB0cmFuc2FjdGlvbjtcbiAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpO1xuICAgICAgaWYgKFxuICAgICAgICB0cmFuc2FjdGlvbj8ucGhhc2UgPT09IFwicHJlcGFyZWRcIlxuICAgICAgICAmJiAhdHJhbnNhY3Rpb24uaGVscGVyXG4gICAgICAgICYmIHByZXZpb3VzPy50cmFuc2FjdGlvbklkID09PSB0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkXG4gICAgICAgICYmIHByZXZpb3VzLmhlbHBlclxuICAgICAgKSB7XG4gICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgIC4uLnRyYW5zYWN0aW9uLFxuICAgICAgICAgIGVycm9yOiB0cmFuc2FjdGlvbi5lcnJvciA/PyBwcmV2aW91cy5lcnJvcixcbiAgICAgICAgICBoZWxwZXI6IHByZXZpb3VzLmhlbHBlcixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJlc3RvcmVQZXJzaXN0ZWRSZXF1ZXN0KCk7XG4gICAgICBkcmF3KCk7XG4gICAgICBpZiAodHJhbnNhY3Rpb24gJiYgZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwodHJhbnNhY3Rpb24ucGhhc2UpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzUmVzdWx0ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgICAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmRVcGRhdGVzLmlzQ3VycmVudChzdGF0dXNVcGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgICAgZW52aXJvbm1lbnQgPSBub3JtYWxpemVFbnZpcm9ubWVudFN0YXR1cyhzdGF0dXNSZXN1bHQpID8/IGVudmlyb25tZW50O1xuICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gY3VycmVudFNlbGVjdGlvbigpO1xuICAgICAgICAgIGlmIChzZWxlY3RlZCkgZW52aXJvbm1lbnRDb250cm9sbGVyLnNldFNlbGVjdGVkKHNlbGVjdGVkKTtcbiAgICAgICAgICBkcmF3KCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICAgIGVycm9yOiB0cmFuc2FjdGlvbi5lcnJvciA/PyBgQ291bGQgbm90IHJlZnJlc2ggZW52aXJvbm1lbnQgc3RhdHVzOiAke3NhZmVVaUVycm9yKGVycm9yKX1gLFxuICAgICAgICAgIH07XG4gICAgICAgICAgZHJhdygpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGxhc3RUcmFuc2FjdGlvbkZldGNoRmFpbGVkID0gdHJ1ZTtcbiAgICAgIGlmICh0cmFuc2FjdGlvbikge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IHtcbiAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICBlcnJvcjogYENvdWxkIG5vdCByZWZyZXNoIGVudmlyb25tZW50IHRyYW5zYWN0aW9uOiAke3NhZmVVaUVycm9yKGVycm9yKX1gLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgZHJhdygpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBsb2FkID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGNvbnN0IHN0YXR1c1VwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgW3N0YXR1c1Jlc3VsdCwgdHJhbnNhY3Rpb25SZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC1zdGF0dXNcIiksXG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpLFxuICAgICAgXSk7XG4gICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IHN0YXR1c0lzQ3VycmVudCA9IGNhcmRVcGRhdGVzLmlzQ3VycmVudChzdGF0dXNVcGRhdGUpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb25Jc0N1cnJlbnQgPSBjYXJkVXBkYXRlcy5pc0N1cnJlbnQodHJhbnNhY3Rpb25VcGRhdGUpO1xuICAgICAgaWYgKCFzdGF0dXNJc0N1cnJlbnQgJiYgIXRyYW5zYWN0aW9uSXNDdXJyZW50KSByZXR1cm47XG4gICAgICBpZiAoc3RhdHVzSXNDdXJyZW50KSB7XG4gICAgICAgIGVudmlyb25tZW50ID0gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXMoc3RhdHVzUmVzdWx0KTtcbiAgICAgICAgaWYgKGVudmlyb25tZW50Py5zZWxlY3RlZCkgZW52aXJvbm1lbnRDb250cm9sbGVyLnNldFNlbGVjdGVkKGVudmlyb25tZW50LnNlbGVjdGVkKTtcbiAgICAgIH1cbiAgICAgIGlmICh0cmFuc2FjdGlvbklzQ3VycmVudCkge1xuICAgICAgICBsYXN0VHJhbnNhY3Rpb25GZXRjaEZhaWxlZCA9IGZhbHNlO1xuICAgICAgICB0cmFuc2FjdGlvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24odHJhbnNhY3Rpb25SZXN1bHQpO1xuICAgICAgICByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCgpO1xuICAgICAgfVxuICAgICAgZHJhdygpO1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKSAmJiAhY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHRyYW5zYWN0aW9uVXBkYXRlKSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCBlbnZpcm9ubWVudFwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICAgIC8vIE5ldmVyIGxhdGNoIG9uIGEgZmFpbGVkIGluaXRpYWwgbG9hZDogYW4gaW4tZmxpZ2h0IG9yIHN0cmFuZGVkXG4gICAgICAvLyByZWNlaXB0IHdvdWxkIHN0YXkgaW52aXNpYmxlIHVudGlsIHRoZSB0YWIgd2FzIHJlLW1vdW50ZWQgKHRoaXMgaXNcbiAgICAgIC8vIGV4YWN0bHkgaG93IGEgUmVjb3ZlciBiYW5uZXIgb25jZSBoaWQgZm9yIH40MCBtaW51dGVzKS4gUmV0cnkgc2xvd2x5XG4gICAgICAvLyB3aGlsZSB0aGUgY2FyZCBzdGF5cyBtb3VudGVkLlxuICAgICAgbGFzdFRyYW5zYWN0aW9uRmV0Y2hGYWlsZWQgPSB0cnVlO1xuICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkKSB2b2lkIGxvYWQoKTtcbiAgICAgIH0sIDVfMDAwKTtcbiAgICB9XG4gIH07XG5cbiAgdm9pZCBsb2FkKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgaWYgKHRyYW5zYWN0aW9uUG9sbGluZykgY2xlYXJUaW1lb3V0KHRyYW5zYWN0aW9uUG9sbGluZyk7XG4gICAgdHJhbnNhY3Rpb25Qb2xsaW5nID0gbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvblJlcXVlc3RlZFNlbGVjdGlvbihcbiAgdHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24sXG4pOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4gfCBudWxsIHtcbiAgY29uc3QgcmVxdWVzdGVkID0gdHJhbnNhY3Rpb24ucmVxdWVzdGVkO1xuICBpZiAoIXJlcXVlc3RlZCkgcmV0dXJuIG51bGw7XG4gIGlmIChyZXF1ZXN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJjaGF0Z3B0XCIgJiYgcmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwidHdlYWtlcnNcIikgcmV0dXJuIG51bGw7XG4gIGlmIChyZXF1ZXN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwic3RhYmxlXCIgJiYgcmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcImFscGhhXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcHBFeHBlcmllbmNlOiByZXF1ZXN0ZWQuYXBwRXhwZXJpZW5jZSwgcmVsZWFzZVByb2ZpbGU6IHJlcXVlc3RlZC5yZWxlYXNlUHJvZmlsZSB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbChwaGFzZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBbXCJjb21taXR0ZWRcIiwgXCJjb21wbGV0ZWRcIiwgXCJyb2xsZWQtYmFja1wiLCBcInJvbGxlZF9iYWNrXCIsIFwiZmFpbGVkXCIsIFwiY2FuY2VsbGVkXCJdLmluY2x1ZGVzKHBoYXNlKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRDaG9pY2VSb3coXG4gIHRpdGxlOiBzdHJpbmcsXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gIGNob2ljZXM6IEFycmF5PHsgdmFsdWU6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZzsgZGlzYWJsZWQ/OiBib29sZWFuOyBkaXNhYmxlZFJlYXNvbj86IHN0cmluZyB9PixcbiAgc2VsZWN0ZWQ6IHN0cmluZyxcbiAgb25DaGFuZ2U6ICh2YWx1ZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSByb3dDb3B5KHRpdGxlLCBkZXNjcmlwdGlvbik7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBmbGV4LXdyYXAgcm91bmRlZC1sZyBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0wLjVcIjtcbiAgYWN0aW9ucy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwiZ3JvdXBcIik7XG4gIGFjdGlvbnMuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB0aXRsZSk7XG4gIGZvciAoY29uc3QgY2hvaWNlIG9mIGNob2ljZXMpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBjaG9pY2UubGFiZWw7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gY2hvaWNlLmRpc2FibGVkID09PSB0cnVlO1xuICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKGNob2ljZS52YWx1ZSA9PT0gc2VsZWN0ZWQpKTtcbiAgICBpZiAoY2hvaWNlLmRpc2FibGVkKSBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1kaXNhYmxlZFwiLCBcInRydWVcIik7XG4gICAgaWYgKGNob2ljZS5kaXNhYmxlZFJlYXNvbikgYnV0dG9uLnRpdGxlID0gY2hvaWNlLmRpc2FibGVkUmVhc29uO1xuICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgcm91bmRlZC1tZCBweC0zIHB5LTEuNSB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgJHtjaG9pY2UudmFsdWUgPT09IHNlbGVjdGVkID8gXCJiZy10b2tlbi1iZy1wcmltYXJ5IHNoYWRvdy1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiIDogXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOnRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCJ9YDtcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IG9uQ2hhbmdlKGNob2ljZS52YWx1ZSkpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgfVxuICBjb25zdCBkaXNhYmxlZFJlYXNvbiA9IGNob2ljZXMuZmluZCgoY2hvaWNlKSA9PiBjaG9pY2UuZGlzYWJsZWQgJiYgY2hvaWNlLmRpc2FibGVkUmVhc29uKT8uZGlzYWJsZWRSZWFzb247XG4gIGlmIChkaXNhYmxlZFJlYXNvbikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcmVhc29uLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXhzXCI7XG4gICAgcmVhc29uLnRleHRDb250ZW50ID0gZGlzYWJsZWRSZWFzb247XG4gICAgbGVmdC5hcHBlbmRDaGlsZChyZWFzb24pO1xuICB9XG4gIHJvdy5hcHBlbmQobGVmdCwgYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHZhbHVlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUgPT09IFwiY2hhdGdwdFwiID8gXCJDaGF0R1BUXCIgOiBcIlR3ZWFrZXJzXCI7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KFxuICBlbnZpcm9ubWVudDogRW52aXJvbm1lbnRTdGF0dXMsXG4gIHNlbGVjdGlvbjogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuKTogeyBhdmFpbGFibGU6IGJvb2xlYW47IHVuYXZhaWxhYmxlUmVhc29ucz86IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjaGFubmVsID0gZW52aXJvbm1lbnQuY2hhbm5lbHNbc2VsZWN0aW9uLnJlbGVhc2VQcm9maWxlXTtcbiAgcmV0dXJuIGNoYW5uZWwuYXZhaWxhYmlsaXR5Py5bc2VsZWN0aW9uLmFwcEV4cGVyaWVuY2VdID8/IHtcbiAgICBhdmFpbGFibGU6IGNoYW5uZWwuYXZhaWxhYmxlLFxuICAgIHVuYXZhaWxhYmxlUmVhc29uczogY2hhbm5lbC51bmF2YWlsYWJsZVJlYXNvbnMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oXG4gIGF2YWlsYWJpbGl0eTogeyB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXSB9LFxuICBmYWxsYmFjazogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGF2YWlsYWJpbGl0eS51bmF2YWlsYWJsZVJlYXNvbnM/LmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKSB8fCBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRQcm9maWxlTGFiZWwodmFsdWU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUgPT09IFwiYWxwaGFcIiA/IFwiQWxwaGEgKFByZS1yZWxlYXNlKVwiIDogXCJTdGFibGVcIjtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXModmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudFN0YXR1cyB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRTdGF0dXM+O1xuICBjb25zdCBzZWxlY3RlZCA9IGNhbmRpZGF0ZS5zZWxlY3RlZDtcbiAgaWYgKCFzZWxlY3RlZCB8fCAoc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJjaGF0Z3B0XCIgJiYgc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJ0d2Vha2Vyc1wiKSB8fCAoc2VsZWN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwic3RhYmxlXCIgJiYgc2VsZWN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwiYWxwaGFcIikpIHJldHVybiBudWxsO1xuICBjb25zdCBjaGFubmVscyA9IGNhbmRpZGF0ZS5jaGFubmVscyBhcyBQYXJ0aWFsPFJlY29yZDxFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlLCBFbnZpcm9ubWVudENoYW5uZWxTdGF0dXM+PiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcmF3T2JzZXJ2YXRpb24gPSBjYW5kaWRhdGUub2JzZXJ2YXRpb247XG4gIGNvbnN0IG9ic2VydmF0aW9uID0gcmF3T2JzZXJ2YXRpb25cbiAgICAmJiAocmF3T2JzZXJ2YXRpb24uYXBwRXhwZXJpZW5jZSA9PT0gbnVsbFxuICAgICAgfHwgcmF3T2JzZXJ2YXRpb24uYXBwRXhwZXJpZW5jZSA9PT0gXCJjaGF0Z3B0XCJcbiAgICAgIHx8IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IFwidHdlYWtlcnNcIilcbiAgICA/IHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UsXG4gICAgICBzZWxlY3Rpb25EcmlmdDogcmF3T2JzZXJ2YXRpb24uc2VsZWN0aW9uRHJpZnQgPT09IHRydWUsXG4gICAgICBsaWZlY3ljbGVDb250ZW5kZWQ6IHJhd09ic2VydmF0aW9uLmxpZmVjeWNsZUNvbnRlbmRlZCA9PT0gdHJ1ZSxcbiAgICAgIGNvbW1pdEpvdXJuYWxQcmVzZW50OiByYXdPYnNlcnZhdGlvbi5jb21taXRKb3VybmFsUHJlc2VudCA9PT0gdHJ1ZSxcbiAgICAgIHRyYW5zaXRpb25Kb3VybmFsUHJlc2VudDogcmF3T2JzZXJ2YXRpb24udHJhbnNpdGlvbkpvdXJuYWxQcmVzZW50ID09PSB0cnVlLFxuICAgICAgZnJlc2huZXNzOiByYXdPYnNlcnZhdGlvbi5mcmVzaG5lc3MgPT09IFwiY29udGVuZGVkXCIgPyBcImNvbnRlbmRlZFwiIGFzIGNvbnN0IDogXCJjdXJyZW50XCIgYXMgY29uc3QsXG4gICAgfVxuICAgIDogdW5kZWZpbmVkO1xuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IDEsXG4gICAgc2VsZWN0ZWQsXG4gICAgY2hhbm5lbHM6IHtcbiAgICAgIHN0YWJsZTogY2hhbm5lbHM/LnN0YWJsZSA/PyB7IGF2YWlsYWJsZTogdHJ1ZSwgcmVsZWFzZVByb2ZpbGU6IFwic3RhYmxlXCIgfSxcbiAgICAgIGFscGhhOiBjaGFubmVscz8uYWxwaGEgPz8geyBhdmFpbGFibGU6IGZhbHNlLCB1bmF2YWlsYWJsZVJlYXNvbnM6IFtcIkFscGhhIChQcmUtcmVsZWFzZSkgYXZhaWxhYmlsaXR5IHdhcyBub3QgcmVwb3J0ZWQuXCJdLCByZWxlYXNlUHJvZmlsZTogXCJhbHBoYVwiIH0sXG4gICAgfSxcbiAgICAuLi4ob2JzZXJ2YXRpb24gPyB7IG9ic2VydmF0aW9uIH0gOiB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24odmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uIHwgbnVsbCB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY2FuZGlkYXRlID0gdmFsdWUgYXMgUGFydGlhbDxFbnZpcm9ubWVudFRyYW5zYWN0aW9uPjtcbiAgaWYgKHR5cGVvZiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgY2FuZGlkYXRlLnBoYXNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi5jYW5kaWRhdGUsXG4gICAgdHJhbnNhY3Rpb25JZDogY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQsXG4gICAgcGhhc2U6IGNhbmRpZGF0ZS5waGFzZSxcbiAgICBlcnJvcjogdHlwZW9mIGNhbmRpZGF0ZS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGNhbmRpZGF0ZS5lcnJvciA6IG51bGwsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbih2YWx1ZTogdW5rbm93bik6IEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbiB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uPiAmIHsga2luZD86IHVua25vd24gfTtcbiAgaWYgKGNhbmRpZGF0ZS5raW5kICE9PSBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIikgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBpZiAoY2FuZGlkYXRlLnBoYXNlICE9PSBcInN1Ym1pdHRlZFwiICYmIGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdWJtaXQtZmFpbGVkXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiZW52aXJvbm1lbnQtY29tbWl0LWhlbHBlclwiLFxuICAgIHRyYW5zYWN0aW9uSWQ6IGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gICAgZXJyb3I6IHR5cGVvZiBjYW5kaWRhdGUuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBjYW5kaWRhdGUuZXJyb3IgOiBudWxsLFxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudEhlbHBlcklzSW5GbGlnaHQodHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBib29sZWFuIHtcbiAgY29uc3QgaGVscGVyID0gdHJhbnNhY3Rpb24uaGVscGVyO1xuICBjb25zdCBvdXRjb21lUGhhc2UgPSBoZWxwZXI/Lm91dGNvbWU/LnBoYXNlO1xuICByZXR1cm4gb3V0Y29tZVBoYXNlID09PSBcIm5vdC1zdGFydGVkXCJcbiAgICB8fCBvdXRjb21lUGhhc2UgPT09IFwicnVubmluZ1wiXG4gICAgfHwgKGhlbHBlcj8uc3VibWlzc2lvbj8ucGhhc2UgPT09IFwic3VibWl0dGVkXCIgJiYgb3V0Y29tZVBoYXNlID09PSB1bmRlZmluZWQpO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3Zlcih0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IGJvb2xlYW4ge1xuICBpZiAodHJhbnNhY3Rpb24ucGhhc2UgPT09IFwiZmFpbGVkXCIpIHJldHVybiB0cmFuc2FjdGlvbi5wcmVwYXJlZCAhPT0gbnVsbCAmJiB0cmFuc2FjdGlvbi5wcmVwYXJlZCAhPT0gdW5kZWZpbmVkO1xuICByZXR1cm4gW1wiY29tbWl0dGluZ1wiLCBcImFwcGx5aW5nXCIsIFwicmVvcGVuaW5nXCIsIFwidmVyaWZ5aW5nXCIsIFwicm9sbGluZy1iYWNrXCJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnBoYXNlKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJGYWlsdXJlRGV0YWlsKHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGhlbHBlciA9IHRyYW5zYWN0aW9uLmhlbHBlcjtcbiAgaWYgKCFoZWxwZXIpIHJldHVybiBudWxsO1xuICBjb25zdCBvdXRjb21lID0gaGVscGVyLm91dGNvbWU7XG4gIGNvbnN0IHN1Ym1pc3Npb24gPSBoZWxwZXIuc3VibWlzc2lvbjtcbiAgY29uc3QgZmFpbGVkID0gb3V0Y29tZT8ucGhhc2UgPT09IFwiZmFpbGVkXCJcbiAgICB8fCBzdWJtaXNzaW9uPy5waGFzZSA9PT0gXCJzdWJtaXQtZmFpbGVkXCJcbiAgICB8fCB0eXBlb2Ygb3V0Y29tZT8uZXJyb3IgPT09IFwic3RyaW5nXCJcbiAgICB8fCB0eXBlb2Ygc3VibWlzc2lvbj8uZXJyb3IgPT09IFwic3RyaW5nXCI7XG4gIGlmICghZmFpbGVkKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3RkZXJyID0gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KGhlbHBlci5zdGRlcnIpO1xuICBjb25zdCBzdGRvdXQgPSBlbnZpcm9ubWVudEhlbHBlckxvZ1NuaXBwZXQoaGVscGVyLnN0ZG91dCk7XG4gIGNvbnN0IGV4aXRDb2RlID0gdHlwZW9mIG91dGNvbWU/LmV4aXRDb2RlID09PSBcIm51bWJlclwiID8gYGV4aXQgJHtvdXRjb21lLmV4aXRDb2RlfWAgOiBudWxsO1xuICBjb25zdCBkZXRhaWwgPSBbXG4gICAgXCJFbnZpcm9ubWVudCBoZWxwZXIgZmFpbGVkXCIsXG4gICAgZXhpdENvZGUsXG4gICAgb3V0Y29tZT8uZXJyb3IsXG4gICAgc3VibWlzc2lvbj8uZXJyb3IsXG4gICAgc3RkZXJyID8gYHN0ZGVycjogJHtzdGRlcnJ9YCA6IG51bGwsXG4gICAgIXN0ZGVyciAmJiBzdGRvdXQgPyBgc3Rkb3V0OiAke3N0ZG91dH1gIDogbnVsbCxcbiAgXS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS5sZW5ndGggPiAwKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KGRldGFpbCldLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjb21wYWN0ID0gdmFsdWUudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpO1xuICBpZiAoIWNvbXBhY3QpIHJldHVybiBudWxsO1xuICByZXR1cm4gY29tcGFjdC5sZW5ndGggPD0gNjAwID8gY29tcGFjdCA6IGBcdTIwMjYke2NvbXBhY3Quc2xpY2UoLTU5OSl9YDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3dBY3Rpb25zIHtcbiAgYnVzeTogYm9vbGVhbjtcbiAgb25SZXN1bWU/OiAoKSA9PiB2b2lkO1xuICBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG4gIG9uUmVjb3Zlcj86ICgpID0+IHZvaWQ7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coXG4gIHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuICBhY3Rpb25zQ29uZmlnPzogRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvd0FjdGlvbnMsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlbHBlckZhaWx1cmUgPSBlbnZpcm9ubWVudEhlbHBlckZhaWx1cmVEZXRhaWwodHJhbnNhY3Rpb24pO1xuICBjb25zdCBvd25lckV4aXRlZCA9IHRyYW5zYWN0aW9uLm93bmVyQWxpdmUgPT09IGZhbHNlXG4gICAgJiYgIWVudmlyb25tZW50VHJhbnNhY3Rpb25Jc1Rlcm1pbmFsKHRyYW5zYWN0aW9uLnBoYXNlKTtcbiAgY29uc3QgZGV0YWlscyA9IFtcbiAgICBvd25lckV4aXRlZCA/IFwiT3duZXIgcHJvY2VzcyBleGl0ZWQgXHUyMDE0IHJlY292ZXJ5IHJlcXVpcmVkLlwiIDogbnVsbCxcbiAgICBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwodHJhbnNhY3Rpb24ucGhhc2UpLFxuICAgIHRyYW5zYWN0aW9uLmVycm9yLFxuICAgIGhlbHBlckZhaWx1cmUsXG4gIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIkFwcCBtb2RlIHJlc3RhcnRcIixcbiAgICBbLi4ubmV3IFNldChkZXRhaWxzKV0uam9pbihcIiBcdTAwQjcgXCIpLFxuICApO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIHtcbiAgICBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoXG4gICAgICBvd25lckV4aXRlZCA/IFwiZXJyb3JcIiA6IGVudmlyb25tZW50VHJhbnNhY3Rpb25Ub25lKHRyYW5zYWN0aW9uLnBoYXNlKSxcbiAgICAgIGVudmlyb25tZW50VHJhbnNhY3Rpb25MYWJlbCh0cmFuc2FjdGlvbi5waGFzZSksXG4gICAgKSk7XG4gIH1cbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZXN1bWUpIHtcbiAgICBjb25zdCByZXN1bWUgPSBjb21wYWN0QnV0dG9uKFwiUmVzdW1lL0NvbmZpcm1cIiwgYWN0aW9uc0NvbmZpZy5vblJlc3VtZSk7XG4gICAgcmVzdW1lLmRpc2FibGVkID0gYWN0aW9uc0NvbmZpZy5idXN5O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJlc3VtZSk7XG4gIH1cbiAgaWYgKGFjdGlvbnNDb25maWc/Lm9uQ2FuY2VsKSB7XG4gICAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCBhY3Rpb25zQ29uZmlnLm9uQ2FuY2VsKTtcbiAgICBjYW5jZWwuZGlzYWJsZWQgPSBhY3Rpb25zQ29uZmlnLmJ1c3k7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY2FuY2VsKTtcbiAgfVxuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZWNvdmVyKSB7XG4gICAgY29uc3QgcmVjb3ZlciA9IGNvbXBhY3RCdXR0b24oXCJSZWNvdmVyIFNhZmVseVwiLCBhY3Rpb25zQ29uZmlnLm9uUmVjb3Zlcik7XG4gICAgcmVjb3Zlci5kaXNhYmxlZCA9IGFjdGlvbnNDb25maWcuYnVzeTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChyZWNvdmVyKTtcbiAgfVxuICByb3cudGl0bGUgPSBgVHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkfWA7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICByb3cuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwocGhhc2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlIFwiY29tbWl0dGVkXCI6XG4gICAgY2FzZSBcImNvbXBsZXRlZFwiOlxuICAgICAgcmV0dXJuIFwiQ29tcGxldGVkXCI7XG4gICAgY2FzZSBcInJvbGxlZC1iYWNrXCI6XG4gICAgY2FzZSBcInJvbGxlZF9iYWNrXCI6XG4gICAgICByZXR1cm4gXCJSb2xsZWQgYmFja1wiO1xuICAgIGNhc2UgXCJjYW5jZWxsZWRcIjpcbiAgICAgIHJldHVybiBcIkNhbmNlbGxlZFwiO1xuICAgIGNhc2UgXCJmYWlsZWRcIjpcbiAgICAgIHJldHVybiBcIkZhaWxlZFwiO1xuICAgIGNhc2UgXCJwcmVwYXJlZFwiOlxuICAgICAgcmV0dXJuIFwiUHJlcGFyZWRcIjtcbiAgICBjYXNlIFwicHJlcGFyaW5nXCI6XG4gICAgICByZXR1cm4gXCJQcmVwYXJpbmdcIjtcbiAgICBjYXNlIFwiY29tbWl0dGluZ1wiOlxuICAgICAgcmV0dXJuIFwiQ29tbWl0dGluZ1wiO1xuICAgIGNhc2UgXCJyZW9wZW5pbmdcIjpcbiAgICAgIHJldHVybiBcIlJlb3BlbmluZ1wiO1xuICAgIGNhc2UgXCJ2ZXJpZnlpbmdcIjpcbiAgICAgIHJldHVybiBcIlZlcmlmeWluZ1wiO1xuICAgIGNhc2UgXCJyb2xsaW5nLWJhY2tcIjpcbiAgICAgIHJldHVybiBcIlJvbGxpbmcgYmFja1wiO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gaHVtYW5pemVDb2RleFBoYXNlKHBoYXNlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uVG9uZShwaGFzZTogc3RyaW5nKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAocGhhc2UgPT09IFwiY29tbWl0dGVkXCIgfHwgcGhhc2UgPT09IFwiY29tcGxldGVkXCIpIHJldHVybiBcIm9rXCI7XG4gIGlmIChwaGFzZSA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZXJyb3JcIjtcbiAgcmV0dXJuIFwid2FyblwiO1xufVxuXG4vKiogT25lIHNoYXJlZCwgYWNjZXNzaWJsZSBjb25maXJtYXRpb24gYWZ0ZXIgcHJlcGFyZTsgQ2FuY2VsIG5ldmVyIGNvbW1pdHMuICovXG5mdW5jdGlvbiBvcGVuRW52aXJvbm1lbnRDb25maXJtTW9kYWwoXG4gIHJlcXVlc3RlZDogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuICB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbik6IFByb21pc2U8RW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbj4ge1xuICBjb25zdCBvcGVuZXIgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgPyBkb2N1bWVudC5hY3RpdmVFbGVtZW50IDogbnVsbDtcbiAgY29uc3QgcmVzdG9yZUZvY3VzID0gKCk6IHZvaWQgPT4ge1xuICAgIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzKFxuICAgICAgb3BlbmVyLFxuICAgICAgKCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLWVudmlyb25tZW50LWNhcmRdIGJ1dHRvbjpub3QoW2Rpc2FibGVkXSlcIiksXG4gICAgKTtcbiAgfTtcbiAgbGV0IHJlc29sdmVEZWNpc2lvbiE6IChkZWNpc2lvbjogRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbikgPT4gdm9pZDtcbiAgY29uc3QgZGVjaXNpb24gPSBuZXcgUHJvbWlzZTxFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uPigocmVzb2x2ZVByb21pc2UpID0+IHtcbiAgICByZXNvbHZlRGVjaXNpb24gPSByZXNvbHZlUHJvbWlzZTtcbiAgfSk7XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmRhdGFzZXQudHdlYWtlckVudmlyb25tZW50TW9kYWwgPSBcInRydWVcIjtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBcImZpeGVkIGluc2V0LTAgei1bOTk5OV0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNTAgcC00XCI7XG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwiZGlhbG9nXCIpO1xuICBkaWFsb2cuc2V0QXR0cmlidXRlKFwiYXJpYS1tb2RhbFwiLCBcInRydWVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsbGVkYnlcIiwgXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tdGl0bGVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWRlc2NyaWJlZGJ5XCIsIFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCB3LWZ1bGwgbWF4LXctbWQgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC0yeGwgYm9yZGVyIHAtNSBzaGFkb3cteGxcIjtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcInN0eWxlXCIsIFwiYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tY29sb3ItYmFja2dyb3VuZC1wYW5lbCwgdmFyKC0tY29sb3ItdG9rZW4tYmctZm9nKSk7XCIpO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLXRpdGxlXCI7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgY29uc3QgZXhwZXJpZW5jZSA9IGVudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlKTtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IGBTd2l0Y2ggdG8gJHtleHBlcmllbmNlfSBhbmQgcmVzdGFydD9gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIjtcbiAgYm9keS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBjYW5kaWRhdGUgPSB0cmFuc2FjdGlvbi5wcmVwYXJlZD8uY2FuZGlkYXRlO1xuICBjb25zdCBiYWNrZW5kID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LmJhY2tlbmQ7XG4gIGNvbnN0IHJvbGxiYWNrID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LnJvbGxiYWNrO1xuICBjb25zdCB0YXJnZXQgPSBjYW5kaWRhdGU/LmRlc2t0b3BQYXRoXG4gICAgPyBgJHtjYW5kaWRhdGUuZGVza3RvcFBhdGh9JHtjYW5kaWRhdGUudmVyc2lvbiA/IGAgKCR7Y2FuZGlkYXRlLnZlcnNpb259JHtjYW5kaWRhdGUuYnVpbGQgPyBgLCBidWlsZCAke2NhbmRpZGF0ZS5idWlsZH1gIDogXCJcIn0pYCA6IFwiXCJ9YFxuICAgIDogZW52aXJvbm1lbnRQcm9maWxlTGFiZWwocmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlKTtcbiAgY29uc3QgYmFja2VuZFRhcmdldCA9IGJhY2tlbmQ/LmxhbmVcbiAgICA/IGAke2JhY2tlbmQubGFuZX0ke2JhY2tlbmQudmVyc2lvbiA/IGAgJHtiYWNrZW5kLnZlcnNpb259YCA6IFwiXCJ9YFxuICAgIDogXCJ0aGUgdmVyaWZpZWQgYmFja2VuZCBmb3IgdGhpcyBlbnZpcm9ubWVudFwiO1xuICBjb25zdCByb2xsYmFja1RhcmdldCA9IHJvbGxiYWNrPy5kZXNrdG9wUGF0aFxuICAgID8/IHJvbGxiYWNrPy5zZWxlY3Rpb24/LnNlbGVjdGVkRGVza3RvcFBhdGhcbiAgICA/PyBcInRoZSBsYXN0IGtub3duIHdvcmtpbmcgZW52aXJvbm1lbnRcIjtcbiAgY29uc3QgbW9kZUVmZmVjdCA9IHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlID09PSBcInR3ZWFrZXJzXCJcbiAgICA/IFwiQ2hhdEdQVCB3aWxsIGNsb3NlLCByZW9wZW4gaW4gVHdlYWtlcnMgbW9kZSwgYW5kIHJlc3RvcmUgeW91ciBwcmV2aW91c2x5IGVuYWJsZWQgdHdlYWtzLlwiXG4gICAgOiBcIkNoYXRHUFQgd2lsbCBjbG9zZSBhbmQgcmVvcGVuIGluIHN0YW5kYXJkIG1vZGUuIEFsbCB0d2Vha3Mgd2lsbCBiZSBkaXNhYmxlZCwgYnV0IHRoZWlyIHNhdmVkIHNldHRpbmdzIHdpbGwgcmVtYWluIGF2YWlsYWJsZSBmb3IgVHdlYWtlcnMgbW9kZS5cIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IFtcbiAgICBtb2RlRWZmZWN0LFxuICAgIGBEZXNrdG9wOiAke3RhcmdldH0uIEVtYmVkZGVkIENvZGV4IGJhY2tlbmQ6ICR7YmFja2VuZFRhcmdldH0uYCxcbiAgICBgSWYgcmVzdGFydCB2ZXJpZmljYXRpb24gZmFpbHMsIFR3ZWFrZXJzIHdpbGwgcmVzdG9yZSB0aGUgbGFzdCBrbm93biB3b3JraW5nIGVudmlyb25tZW50IGF0ICR7cm9sbGJhY2tUYXJnZXR9LmAsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgYm9keS5zdHlsZS53aGl0ZVNwYWNlID0gXCJwcmUtbGluZVwiO1xuICBjb25zdCBidXR0b25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYnV0dG9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGNsb3NlID0gKG91dGNvbWU6IFwiY29uZmlybVwiIHwgXCJjYW5jZWxcIik6IHZvaWQgPT4ge1xuICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgc2V0dGxlZCA9IHRydWU7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgIHJlc29sdmVEZWNpc2lvbihvdXRjb21lKTtcbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKHJlc3RvcmVGb2N1cyk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGNsb3NlKFwiY2FuY2VsXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZXZlbnQua2V5ICE9PSBcIlRhYlwiKSByZXR1cm47XG4gICAgY29uc3QgZm9jdXNhYmxlID0gW2NhbmNlbCwgY29uZmlybV07XG4gICAgY29uc3QgY3VycmVudEluZGV4ID0gZm9jdXNhYmxlLmluZGV4T2YoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MQnV0dG9uRWxlbWVudCk7XG4gICAgY29uc3QgbmV4dEluZGV4ID0gZXZlbnQuc2hpZnRLZXlcbiAgICAgID8gKGN1cnJlbnRJbmRleCA8PSAwID8gZm9jdXNhYmxlLmxlbmd0aCAtIDEgOiBjdXJyZW50SW5kZXggLSAxKVxuICAgICAgOiAoY3VycmVudEluZGV4IDwgMCB8fCBjdXJyZW50SW5kZXggPT09IGZvY3VzYWJsZS5sZW5ndGggLSAxID8gMCA6IGN1cnJlbnRJbmRleCArIDEpO1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZm9jdXNhYmxlW25leHRJbmRleF0/LmZvY3VzKCk7XG4gIH07XG4gIGNvbnN0IGNhbmNlbCA9IGNvbXBhY3RCdXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gY2xvc2UoXCJjYW5jZWxcIikpO1xuICBjb25zdCBjb25maXJtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29uZmlybS50eXBlID0gXCJidXR0b25cIjtcbiAgY29uZmlybS5jbGFzc05hbWUgPSBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJnLXRva2VuLWNoYXJ0cy1ibHVlIHB4LTMgdGV4dC1zbSB0ZXh0LXdoaXRlIGVuYWJsZWQ6aG92ZXI6b3BhY2l0eS05MCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MCBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIGNvbmZpcm0udGV4dENvbnRlbnQgPSBcIkFwcGx5ICYgUmVzdGFydFwiO1xuICBjb25maXJtLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNsb3NlKFwiY29uZmlybVwiKTtcbiAgfSk7XG4gIGJ1dHRvbnMuYXBwZW5kKGNhbmNlbCwgY29uZmlybSk7XG4gIGRpYWxvZy5hcHBlbmQoaGVhZGluZywgYm9keSwgYnV0dG9ucyk7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcbiAgY29uZmlybS5mb2N1cygpO1xuICByZXR1cm4gZGVjaXNpb247XG59XG5cbmZ1bmN0aW9uIHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJEZXNrdG9wIFVwZGF0ZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckRlc2t0b3BVcGRhdGVDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTG9hZGluZyBkZXNrdG9wIHVwZGF0ZVwiLCBcIkNoZWNraW5nIHRoZSBzaWduZWQgQ29kZXggYXBwY2FzdC5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGN1cnJlbnQ6IERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGxldCBidXN5ID0gZmFsc2U7XG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgPSAwO1xuICBsZXQgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IDA7XG4gIGxldCBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCA9IGZhbHNlO1xuICBsZXQgdHJhbnNhY3Rpb25GZXRjaEZhaWxlZCA9IGZhbHNlO1xuXG4gIGNvbnN0IHRyYW5zYWN0aW9uSXNOb25UZXJtaW5hbCA9ICgpOiBib29sZWFuID0+IHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkKSB7XG4gICAgICByZXR1cm4gdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmluZ1wiICYmIERhdGUubm93KCkgPCBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsO1xuICAgIH1cbiAgICByZXR1cm4gIVtcImNvbXBsZXRlZFwiLCBcImZhaWxlZFwiLCBcInJvbGxlZF9iYWNrXCJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnBoYXNlKTtcbiAgfTtcbiAgY29uc3Qgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwgPSAoZGVsYXlNcyA9IDJfMDAwKTogdm9pZCA9PiB7XG4gICAgaWYgKHBvbGxpbmcpIGNsZWFyVGltZW91dChwb2xsaW5nKTtcbiAgICAvLyBBIGZhaWxlZCBmZXRjaCBtdXN0IGtlZXAgcG9sbGluZyBldmVuIHdpdGggbm8ga25vd24gdHJhbnNhY3Rpb246IGFcbiAgICAvLyBzdHJhbmRlZCByZWNlaXB0IHdvdWxkIG90aGVyd2lzZSBzdGF5IGludmlzaWJsZSB1bnRpbCB0YWIgcmUtbW91bnQuXG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkXG4gICAgICB8fCAoIXRyYW5zYWN0aW9uSXNOb25UZXJtaW5hbCgpXG4gICAgICAgICYmIHRyYW5zYWN0aW9uPy5yZXN1bWFibGUgIT09IHRydWVcbiAgICAgICAgJiYgIXRyYW5zYWN0aW9uRmV0Y2hGYWlsZWQpKSByZXR1cm47XG4gICAgcG9sbGluZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgcG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgIH0sIGRlbGF5TXMpO1xuICB9O1xuICBjb25zdCBsb2FkVHJhbnNhY3Rpb24gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJkZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIHRyYW5zYWN0aW9uRmV0Y2hGYWlsZWQgPSBmYWxzZTtcbiAgICAgIGNvbnN0IG9ic2VydmVkID0gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlKTtcbiAgICAgIGlmIChvYnNlcnZlZD8ucGhhc2UgPT09IFwiaWRsZVwiXG4gICAgICAgICYmIG9ic2VydmVkLnRyYW5zYWN0aW9uSWQgPT09IG51bGxcbiAgICAgICAgJiYgdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmluZ1wiXG4gICAgICAgICYmIHRyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWQgPT09IG51bGwpIHtcbiAgICAgICAgaWYgKERhdGUubm93KCkgPj0gYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCkge1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgICAgdHJhbnNhY3Rpb25JZDogbnVsbCxcbiAgICAgICAgICAgIHBoYXNlOiBcImZhaWxlZFwiLFxuICAgICAgICAgICAgZXJyb3I6IFwiVGhlIGRlc2t0b3AgdXBkYXRlciBkaWQgbm90IGNyZWF0ZSBhIHRyYW5zYWN0aW9uIHJlY2VpcHQuXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgaWRsZVdpdGhvdXRSZWNlaXB0ID0gb2JzZXJ2ZWQ/LnBoYXNlID09PSBcImlkbGVcIiAmJiBvYnNlcnZlZC50cmFuc2FjdGlvbklkID09PSBudWxsO1xuICAgICAgICB0cmFuc2FjdGlvbiA9IGlkbGVXaXRob3V0UmVjZWlwdCA/IG51bGwgOiBvYnNlcnZlZDtcbiAgICAgICAgaWYgKHRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkKSBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsID0gMDtcbiAgICAgIH1cbiAgICAgIHRyYW5zYWN0aW9uUG9sbEZhaWx1cmVzID0gMDtcbiAgICAgIGRyYXcoKTtcbiAgICAgIHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIHRyYW5zYWN0aW9uRmV0Y2hGYWlsZWQgPSB0cnVlO1xuICAgICAgLy8gV2l0aCBubyBrbm93biB0cmFuc2FjdGlvbiwga2VlcCBpdCBudWxsOiBmYWJyaWNhdGluZyBhIHBoYW50b21cbiAgICAgIC8vIFwicHJlcGFyaW5nXCIgcm93IGJvdGggbWlzaW5mb3JtcyBhbmQgdXNlZCB0byBzYXRpc2Z5IG5vIHBvbGwgZ2F0ZSxcbiAgICAgIC8vIHBlcm1hbmVudGx5IGhpZGluZyBhbnkgcmVhbCBzdHJhbmRlZCByZWNlaXB0IG9uIGRpc2suXG4gICAgICBpZiAodHJhbnNhY3Rpb24pIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgLi4udHJhbnNhY3Rpb24sXG4gICAgICAgICAgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGRyYXcoKTtcbiAgICAgIHRyYW5zYWN0aW9uUG9sbEZhaWx1cmVzICs9IDE7XG4gICAgICBjb25zdCBiYWNrb2ZmID0gTWF0aC5taW4oMzBfMDAwLCAxXzAwMCAqICgyICoqIE1hdGgubWluKHRyYW5zYWN0aW9uUG9sbEZhaWx1cmVzIC0gMSwgNSkpKTtcbiAgICAgIGNvbnN0IGppdHRlciA9IE1hdGguZmxvb3IoYmFja29mZiAqIDAuMjUgKiBNYXRoLnJhbmRvbSgpKTtcbiAgICAgIHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsKGJhY2tvZmYgKyBqaXR0ZXIpO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgZHJhdyA9ICgpOiB2b2lkID0+IHtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICBjb25zdCByZXN1bHQgPSBjdXJyZW50O1xuICAgIGNvbnN0IGluc3RhbGxlZCA9IHJlc3VsdD8uaW5zdGFsbGVkPy5tYXJrZXRpbmdWZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIjtcbiAgICBjb25zdCBsYXRlc3QgPSByZXN1bHQ/LmxhdGVzdD8ubWFya2V0aW5nVmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gICAgY29uc3Qgc3RhdHVzID0gZGVza3RvcFVwZGF0ZVN0YXR1c1ByZXNlbnRhdGlvbihyZXN1bHQ/LnN0YXR1cyk7XG4gICAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiQ2hhdEdQVCBEZXNrdG9wXCIsIGBJbnN0YWxsZWQgJHtpbnN0YWxsZWR9IFx1MDBCNyBMYXRlc3QgJHtsYXRlc3R9JHtyZXN1bHQ/LnJlYXNvbiA/IGAgXHUwMEI3ICR7cmVzdWx0LnJlYXNvbn1gIDogXCJcIn1gKTtcbiAgICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHN0YXR1cy50b25lLCBzdGF0dXMubGFiZWwpKTtcbiAgICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgY2hlY2sgPSBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgZm9yIFVwZGF0ZXNcdTIwMjZcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgY2hlY2suZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbHVlIGFzIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdDtcbiAgICAgICAgICBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0KHJlc3VsdCk7XG4gICAgICAgICAgaWYgKHJlc3VsdC51cGRhdGVBbmRSZWxvYWRSZXF1ZXN0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0aW5nVHJhbnNhY3Rpb25SZWNlaXB0VW50aWwgPSBEYXRlLm5vdygpICsgMTBfMDAwO1xuICAgICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgY2hlY2suZGlzYWJsZWQgPSBidXN5IHx8ICEhcmVzdWx0Py5zZXR1cFJlcXVpcmVkO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNoZWNrKTtcbiAgICBjb25zdCB1cGRhdGUgPSBjb21wYWN0QnV0dG9uKFwiVXBkYXRlIGFuZCBSZWxvYWRcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgdXBkYXRlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzdGFydC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IERhdGUubm93KCkgKyAxMF8wMDA7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgLy8gR2F0ZSBvbiBub24tdGVybWluYWwgKG5vdCBcImFjdGl2ZVwiKTogYSBzdHJhbmRlZCBkZWFkLW93bmVyIHJlY2VpcHQgc3RpbGxcbiAgICAvLyBibG9ja3Mgc3RhcnQoKSBvbiBkaXNrLCBzbyB0aGUgYnV0dG9uIG11c3Qgc3RheSBkaXNhYmxlZCB1bnRpbCByZWNvdmVyeS5cbiAgICB1cGRhdGUuZGlzYWJsZWQgPSBidXN5XG4gICAgICB8fCByZXN1bHQ/LnN0YXR1cyAhPT0gXCJ1cGRhdGUtYXZhaWxhYmxlXCJcbiAgICAgIHx8IHRyYW5zYWN0aW9uSXNOb25UZXJtaW5hbCgpXG4gICAgICB8fCB0cmFuc2FjdGlvbj8ucmVzdW1hYmxlID09PSB0cnVlO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIGlmIChyZXN1bHQ/LnNldHVwUmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IHNldHVwTGFiZWwgPSByZXN1bHQuc2V0dXBSZXF1aXJlZCA9PT0gXCJyZWdpc3Rlci1iZXRhXCJcbiAgICAgICAgPyBcIlJlZ2lzdGVyIE9wZW5BSSBCZXRhXCJcbiAgICAgICAgOiBcIkxhdW5jaCBPcGVuQUkgQmV0YSBvbmNlXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgYEFscGhhIHVwZGF0ZSBzZXR1cCBcdTAwQjcgJHtzZXR1cExhYmVsfWAsXG4gICAgICAgIHJlc3VsdC5yZWFzb24gPz8gXCJBbHBoYSB1cGRhdGUgY2hlY2tzIHN0YXkgZGlzYWJsZWQgdW50aWwgVHdlYWtlcnMgY2FwdHVyZXMgdGhlIHJlZ2lzdGVyZWQgQmV0YSBhcHAncyBvd24gZmVlZC5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAocmVzdWx0Py5jaGVja2VkQXQpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKHJlc3VsdC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCkpKTtcbiAgICBpZiAodHJhbnNhY3Rpb24pIGNhcmQuYXBwZW5kQ2hpbGQoZGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uUm93KHRyYW5zYWN0aW9uLCB7XG4gICAgICBidXN5LFxuICAgICAgb25SZXN1bWU6ICgpID0+IHtcbiAgICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgICAgYnVzeSA9IHRydWU7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlc3VtZS1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHRyYW5zYWN0aW9uID0gdHJhbnNhY3Rpb24gPyB7IC4uLnRyYW5zYWN0aW9uLCBwaGFzZTogXCJhd2FpdGluZ19uYXRpdmVfdXBkYXRlXCIsIHJlc3VtYWJsZTogZmFsc2UgfSA6IHRyYW5zYWN0aW9uO1xuICAgICAgICAgICAgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmICh0cmFuc2FjdGlvbikgdHJhbnNhY3Rpb24gPSB7IC4uLnRyYW5zYWN0aW9uLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7IGJ1c3kgPSBmYWxzZTsgZHJhdygpOyB9KTtcbiAgICAgIH0sXG4gICAgICBvbkNhbmNlbDogKCkgPT4ge1xuICAgICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2FuY2VsLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgICAgLnRoZW4oKHZhbHVlKSA9PiB7IHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlKSA/PyB0cmFuc2FjdGlvbjsgfSlcbiAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBpZiAodHJhbnNhY3Rpb24pIHRyYW5zYWN0aW9uID0geyAuLi50cmFuc2FjdGlvbiwgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSB9O1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgICB9LFxuICAgIH0pKTtcbiAgfTtcbiAgZHJhdygpO1xuICBjb25zdCBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0ID0gKHZhbHVlOiBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpOiB2b2lkID0+IHtcbiAgICBjb25zdCBjdXJyZW50VGltZSA9IGN1cnJlbnQ/LmNoZWNrZWRBdCA/IERhdGUucGFyc2UoY3VycmVudC5jaGVja2VkQXQpIDogTnVtYmVyLk5hTjtcbiAgICBjb25zdCBuZXh0VGltZSA9IHZhbHVlLmNoZWNrZWRBdCA/IERhdGUucGFyc2UodmFsdWUuY2hlY2tlZEF0KSA6IE51bWJlci5OYU47XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZShjdXJyZW50VGltZSkgJiYgKCFOdW1iZXIuaXNGaW5pdGUobmV4dFRpbWUpIHx8IG5leHRUaW1lIDwgY3VycmVudFRpbWUpKSByZXR1cm47XG4gICAgY3VycmVudCA9IHZhbHVlO1xuICAgIGRyYXcoKTtcbiAgfTtcbiAgY29uc3Qgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCA9IChfZXZlbnQ6IHVua25vd24sIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSB7XG4gICAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaW5pdGlhbFJlc3VsdFN1cGVyc2VkZWQgPSB0cnVlO1xuICAgIGFjY2VwdERlc2t0b3BVcGRhdGVSZXN1bHQodmFsdWUgYXMgRGVza3RvcFVwZGF0ZUNoZWNrUmVzdWx0KTtcbiAgfTtcbiAgaXBjUmVuZGVyZXIub24oXCJ0d2Vha2VyOmNvZGV4LWRlc2t0b3AtdXBkYXRlLWNoYW5nZWRcIiwgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCk7XG4gIGNvbnN0IGN1cnJlbnRVcGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImRlc2t0b3AtdXBkYXRlLXJlc3VsdFwiKTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoY3VycmVudFVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQgfHwgaW5pdGlhbFJlc3VsdFN1cGVyc2VkZWQpIHJldHVybjtcbiAgICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgYWNjZXB0RGVza3RvcFVwZGF0ZVJlc3VsdCh2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3VycmVudCA9IHsgc3RhdHVzOiBcInVuYXZhaWxhYmxlXCIsIHJlYXNvbjogXCJVcGRhdGUgc3RhdHVzIGhhcyBub3QgYmVlbiBjaGVja2VkIHlldC5cIiB9O1xuICAgICAgICBkcmF3KCk7XG4gICAgICB9XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudChjdXJyZW50VXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgY3VycmVudCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIHJlYXNvbjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICBkcmF3KCk7XG4gICAgfSk7XG4gIHZvaWQgbG9hZFRyYW5zYWN0aW9uKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImRlc2t0b3AtdXBkYXRlLXJlc3VsdFwiKTtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZGVza3RvcC11cGRhdGUtdHJhbnNhY3Rpb25cIik7XG4gICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOmNvZGV4LWRlc2t0b3AtdXBkYXRlLWNoYW5nZWRcIiwgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCk7XG4gICAgaWYgKHBvbGxpbmcpIGNsZWFyVGltZW91dChwb2xsaW5nKTtcbiAgICBwb2xsaW5nID0gbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlOiB1bmtub3duKTogRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGUgfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlPjtcbiAgaWYgKGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBudWxsICYmIHR5cGVvZiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnBoYXNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi5jYW5kaWRhdGUsXG4gICAgdHJhbnNhY3Rpb25JZDogY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgPz8gbnVsbCxcbiAgICBwaGFzZTogY2FuZGlkYXRlLnBoYXNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBkZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25Sb3coXG4gIHRyYW5zYWN0aW9uOiBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSxcbiAgYWN0aW9uczogeyBidXN5OiBib29sZWFuOyBvblJlc3VtZTogKCkgPT4gdm9pZDsgb25DYW5jZWw6ICgpID0+IHZvaWQgfSxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGhhc2UgPSBodW1hbml6ZUNvZGV4UGhhc2UodHJhbnNhY3Rpb24ucGhhc2UpO1xuICBjb25zdCBub25UZXJtaW5hbCA9ICFbXCJjb21wbGV0ZWRcIiwgXCJmYWlsZWRcIiwgXCJyb2xsZWRfYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSk7XG4gIC8vIG93bmVyQWxpdmUgPT09IGZhbHNlIG9uIGEgbm9uLXRlcm1pbmFsIHJlY2VpcHQgbWVhbnMgdGhlIGNvb3JkaW5hdG9yIGRpZWRcbiAgLy8gbWlkLWZsaWdodDogdGhlIHJlY2VpcHQgaXMgc3RyYW5kZWQsIG5vdCBwcm9ncmVzc2luZy5cbiAgY29uc3Qgb3duZXJFeGl0ZWQgPSBub25UZXJtaW5hbCAmJiB0cmFuc2FjdGlvbi5vd25lckFsaXZlID09PSBmYWxzZTtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIG93bmVyRXhpdGVkID8gXCJPd25lciBwcm9jZXNzIGV4aXRlZCBcdTIwMTQgcmVjb3ZlcnkgcmVxdWlyZWQuXCIgOiBudWxsLFxuICAgIHRyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWQgPyBgVHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkfWAgOiBudWxsLFxuICAgIHRyYW5zYWN0aW9uLnNhZmVPZmZpY2lhbE1vZGUgPyBcIk9mZmljaWFsIENoYXRHUFQgaXMgYWN0aXZlXCIgOiBudWxsLFxuICAgIHRyYW5zYWN0aW9uLnJlZnJlc2hTb3VyY2UgPyBgJHt0cmFuc2FjdGlvbi5yZWZyZXNoU291cmNlfSBUd2Vha2VycyByZWZyZXNoYCA6IG51bGwsXG4gICAgdHlwZW9mIHRyYW5zYWN0aW9uLnRlcm1pbmFsQXQgPT09IFwic3RyaW5nXCJcbiAgICAgID8gYFRlcm1pbmFsIGF0ICR7bmV3IERhdGUodHJhbnNhY3Rpb24udGVybWluYWxBdCkudG9Mb2NhbGVTdHJpbmcoKX1gXG4gICAgICA6IHRyYW5zYWN0aW9uLnVwZGF0ZWRBdFxuICAgICAgICA/IGBMYXN0IHVwZGF0ZSBhdCAke25ldyBEYXRlKHRyYW5zYWN0aW9uLnVwZGF0ZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX1gXG4gICAgICAgIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5lcnJvciA/PyBudWxsLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIikgfHwgXCJXYWl0aW5nIGZvciB0aGUgZHVyYWJsZSB1cGRhdGVyIHJlY2VpcHQuXCI7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIlVwZGF0ZSBhbmQgUmVsb2FkXCIsIGRldGFpbCk7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICByb3cuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgY29uc3QgdG9uZSA9IHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImNvbXBsZXRlZFwiXG4gICAgPyBcIm9rXCJcbiAgICA6IG93bmVyRXhpdGVkIHx8ICh0cmFuc2FjdGlvbi5waGFzZSA9PT0gXCJmYWlsZWRcIiAmJiAhdHJhbnNhY3Rpb24ucmVzdW1hYmxlKVxuICAgICAgPyBcImVycm9yXCJcbiAgICAgIDogXCJ3YXJuXCI7XG4gIGxlZnQ/LnByZXBlbmQoc3RhdHVzQmFkZ2UodG9uZSwgcGhhc2UpKTtcbiAgY29uc3QgY29udHJvbHMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgY29uc3QgY2FuUmVzdW1lID0gdHJhbnNhY3Rpb24ucmVzdW1hYmxlID09PSB0cnVlXG4gICAgJiYgKHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImZhaWxlZFwiIHx8IHRyYW5zYWN0aW9uLnBoYXNlID09PSBcInJvbGxlZF9iYWNrXCIpO1xuICAvLyBjYW5jZWxVbmxvY2tlZCBoYW5kbGVzIGV4aXRlZCBvd25lcnMgZm9yIHRoZXNlIHN0cmFuZGVkIHBoYXNlcyB2aWFcbiAgLy8gcmVjb3ZlckV4aXRlZE93bmVyLCBzbyBhIGRlYWQtb3duZXIgcmVjZWlwdCBnZXRzIGEgc2FmZS1yZWNvdmVyeSBDYW5jZWwuXG4gIGNvbnN0IGRlYWRPd25lclJlY292ZXJhYmxlID0gb3duZXJFeGl0ZWRcbiAgICAmJiBbXCJzd2l0Y2hpbmdfdG9fY2hhdGdwdFwiLCBcInJldHVybmluZ190b190d2Vha2Vyc1wiLCBcInJlZnJlc2hpbmdfcnVudGltZVwiLCBcInZlcmlmeWluZ1wiLCBcInByZXBhcmluZ1wiXVxuICAgICAgLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnBoYXNlKTtcbiAgY29uc3QgY2FuQ2FuY2VsID0gdHJhbnNhY3Rpb24ucGhhc2UgPT09IFwiYXdhaXRpbmdfbmF0aXZlX3VwZGF0ZVwiXG4gICAgfHwgKHRyYW5zYWN0aW9uLnJlc3VtYWJsZSA9PT0gdHJ1ZSAmJiBbXCJmYWlsZWRcIiwgXCJyb2xsZWRfYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSkpXG4gICAgfHwgZGVhZE93bmVyUmVjb3ZlcmFibGU7XG4gIGlmIChjYW5SZXN1bWUpIHtcbiAgICBjb25zdCByZXN1bWUgPSBjb21wYWN0QnV0dG9uKFwiUmVzdW1lXCIsIGFjdGlvbnMub25SZXN1bWUpO1xuICAgIHJlc3VtZS5kaXNhYmxlZCA9IGFjdGlvbnMuYnVzeTtcbiAgICBjb250cm9scz8uYXBwZW5kQ2hpbGQocmVzdW1lKTtcbiAgfVxuICBpZiAoY2FuQ2FuY2VsKSB7XG4gICAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCBhY3Rpb25zLm9uQ2FuY2VsKTtcbiAgICBjYW5jZWwuZGlzYWJsZWQgPSBhY3Rpb25zLmJ1c3k7XG4gICAgY29udHJvbHM/LmFwcGVuZENoaWxkKGNhbmNlbCk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzSGVhbHRoU2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiVHdlYWtzIEhlYWx0aFwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlclR3ZWFrc0hlYWx0aENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB0d2Vha3NcIiwgXCJDb21wYXJpbmcgbGl2ZSBjb3BpZXMsIGJ1bmRsZWQgcnVudGltZSBjb3BpZXMsIGFuZCBsYXRlc3Qgc3RvcmVkIGNhdGFsb2cgdmVyc2lvbnMuXCIpKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIGNvbnN0IHJlbmRlciA9IChzbmFwc2hvdDogVHdlYWtIZWFsdGhTbmFwc2hvdCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IG1pc3NpbmdDb3VudCA9IHNuYXBzaG90Lm1pc3NpbmdMaXZlQ291bnQgKyBzbmFwc2hvdC5taXNzaW5nUnVudGltZUNvdW50O1xuICAgIGNvbnN0IHRvdGFsUHJvYmxlbXMgPSBzbmFwc2hvdC5saXZlRHJpZnRDb3VudFxuICAgICAgKyBzbmFwc2hvdC5ydW50aW1lRHJpZnRDb3VudFxuICAgICAgKyBtaXNzaW5nQ291bnRcbiAgICAgICsgKHNuYXBzaG90Lm1jcFJlc3RhcnRSZXF1aXJlZCA/IDEgOiAwKTtcbiAgICBjb25zdCBzdW1tYXJ5ID0gYWN0aW9uUm93KFxuICAgICAgXCJJbnN0YWxsZWQgVHdlYWtzXCIsXG4gICAgICBgJHtzbmFwc2hvdC5pbnN0YWxsZWRDb3VudH0gaW5zdGFsbGVkIFx1MDBCNyAke3NuYXBzaG90LmVuYWJsZWRDb3VudH0gZW5hYmxlZCBcdTAwQjcgJHtzbmFwc2hvdC5jYXRhbG9nQ291bnR9IGxhdGVzdCBzdG9yZWQgY2F0YWxvZyBlbnRyaWVzLmAsXG4gICAgKTtcbiAgICBzdW1tYXJ5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik/LmFwcGVuZENoaWxkKFxuICAgICAgc3RhdHVzQmFkZ2UodG90YWxQcm9ibGVtcyA9PT0gMCA/IFwib2tcIiA6IFwid2FyblwiLCB0b3RhbFByb2JsZW1zID09PSAwID8gXCJDdXJyZW50XCIgOiBcIlJldmlld1wiKSxcbiAgICApO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQoc3VtbWFyeSk7XG5cbiAgICBpZiAodG90YWxQcm9ibGVtcyA9PT0gMCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXG4gICAgICAgIFwiVmVyc2lvbiBEcmlmdFwiLFxuICAgICAgICBcIkFsbCBpbnN0YWxsZWQgbGl2ZSBjb3BpZXMgYW5kIGJ1bmRsZWQgcnVudGltZSBjb3BpZXMgbWF0Y2ggdGhlIGxhdGVzdCBzdG9yZWQgY2F0YWxvZyB2ZXJzaW9ucy5cIixcbiAgICAgICkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgXCJWZXJzaW9uIERyaWZ0XCIsXG4gICAgICAgIFtcbiAgICAgICAgICBgJHtzbmFwc2hvdC5saXZlRHJpZnRDb3VudH0gb3V0ZGF0ZWQgbGl2ZSAke3NuYXBzaG90LmxpdmVEcmlmdENvdW50ID09PSAxID8gXCJjb3B5XCIgOiBcImNvcGllc1wifWAsXG4gICAgICAgICAgYCR7c25hcHNob3QucnVudGltZURyaWZ0Q291bnR9IG91dGRhdGVkIHJ1bnRpbWUgJHtzbmFwc2hvdC5ydW50aW1lRHJpZnRDb3VudCA9PT0gMSA/IFwiY29weVwiIDogXCJjb3BpZXNcIn1gLFxuICAgICAgICAgIGAke21pc3NpbmdDb3VudH0gbWlzc2luZyAke21pc3NpbmdDb3VudCA9PT0gMSA/IFwiY29weVwiIDogXCJjb3BpZXNcIn1gLFxuICAgICAgICAgIHNuYXBzaG90Lm1jcFJlc3RhcnRSZXF1aXJlZCA/IFwiTUNQIHJlc3RhcnQgcmVxdWlyZWRcIiA6IG51bGwsXG4gICAgICAgIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKSxcbiAgICAgICkpO1xuICAgICAgZm9yIChjb25zdCByb3cgb2Ygc25hcHNob3Qucm93cy5maWx0ZXIoKGNhbmRpZGF0ZSkgPT4gY2FuZGlkYXRlLnN0YXR1cyAhPT0gXCJjdXJyZW50XCIpKSB7XG4gICAgICAgIGNhcmQuYXBwZW5kQ2hpbGQodHdlYWtIZWFsdGhEcmlmdFJvdyhyb3cpKTtcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKHNuYXBzaG90Lm1jcFJlc3RhcnRSZXF1aXJlZCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXG4gICAgICAgIFwiTUNQIFByb2Nlc3MgU3RhdGVcIixcbiAgICAgICAgXCJUaGUgbWFuYWdlZCBNQ1AgY29uZmlnIGNoYW5nZWQuIFN0YXJ0IGEgbmV3IHRhc2sgb3IgcmVzdGFydCBDb2RleCB0byByZXBsYWNlIGFscmVhZHktcnVubmluZyBNQ1AgcHJvY2Vzc2VzLlwiLFxuICAgICAgKSk7XG4gICAgfVxuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKHNuYXBzaG90LmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKSkpO1xuICB9O1xuXG4gIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwidHdlYWtzLWhlYWx0aFwiKTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC10d2Vha3MtaGVhbHRoXCIpXG4gICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQgfHwgIWNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgdmFsdWUpKSByZXR1cm47XG4gICAgICByZW5kZXIodmFsdWUgYXMgVHdlYWtIZWFsdGhTbmFwc2hvdCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQgfHwgIWNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgZXJyb3IpKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiVHdlYWtzIGhlYWx0aCB1bmF2YWlsYWJsZVwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICB9KTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwidHdlYWtzLWhlYWx0aFwiKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtIZWFsdGhEcmlmdFJvdyhkcmlmdDogVHdlYWtWZXJzaW9uRHJpZnRSb3cpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBkcmlmdC5uYW1lLFxuICAgIGAke2RyaWZ0LnJlYXNvbn0gTGl2ZTogJHtkcmlmdC5saXZlVmVyc2lvbiA/PyBcIm1pc3NpbmdcIn0gXHUwMEI3IFJ1bnRpbWU6ICR7ZHJpZnQucnVudGltZVZlcnNpb24gPz8gXCJtaXNzaW5nXCJ9IFx1MDBCNyBMYXRlc3Qgc3RvcmVkOiAke2RyaWZ0LmNhdGFsb2dWZXJzaW9uID8/IFwibWlzc2luZ1wifS5gLFxuICApO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoZHJpZnQuc3RhdHVzID09PSBcIm1pc3NpbmdcIiA/IFwiZXJyb3JcIiA6IFwid2FyblwiLCBkcmlmdC5zdGF0dXMgPT09IFwibWlzc2luZ1wiID8gXCJNaXNzaW5nXCIgOiBcIk91dGRhdGVkXCIpKTtcbiAgaWYgKGRyaWZ0LmVuYWJsZWQpIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiRW5hYmxlZFwiKSk7XG4gIGlmIChkcmlmdC5oYXNNY3ApIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiTUNQXCIpKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyTWNwSW50ZWdyYXRpb25TZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNQ1AgSW50ZWdyYXRpb24gSGVhbHRoXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC50d2Vha2VyTWNwSGVhbHRoQ2FyZCA9IFwidHJ1ZVwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIE1DUCBpbnRlZ3JhdGlvblwiLCBcIlZlcmlmeWluZyBtYW5hZ2VkIE1DUCBjb25maWd1cmF0aW9uIGFuZCBzeW5jaHJvbml6YXRpb24uXCIpKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIGNvbnN0IHJlbmRlciA9IChzdGF0ZTogTWNwU3luY1N0YXRlIHwgbnVsbCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGlmICghc3RhdGUpIHtcbiAgICAgIHN0YXRlID0ge1xuICAgICAgICBzdGF0dXM6IFwicGVuZGluZ1wiLFxuICAgICAgICBzdW1tYXJ5OiBcIk1hbmFnZWQgTUNQIHJlY29uY2lsaWF0aW9uIGhhcyBub3QgY29tcGxldGVkIHlldC5cIixcbiAgICAgIH07XG4gICAgfVxuICAgIGNvbnN0IHN0YXR1cyA9IHN0YXRlLnN0YXR1cyA/PyAoc3RhdGUuZXJyb3IgPyBcImVycm9yXCIgOiBcIm9rXCIpO1xuICAgIGNvbnN0IHRvbmUgPSBzdGF0dXMgPT09IFwiZXJyb3JcIiB8fCBzdGF0ZS5lcnJvclxuICAgICAgPyBcImVycm9yXCJcbiAgICAgIDogc3RhdHVzID09PSBcImNvbmZsaWN0XCIgfHwgc3RhdHVzID09PSBcIndhcm5cIiB8fCBzdGF0dXMgPT09IFwicGVuZGluZ1wiXG4gICAgICAgID8gXCJ3YXJuXCJcbiAgICAgICAgOiBcIm9rXCI7XG4gICAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiTUNQIGludGVncmF0aW9uXCIsIHN0YXRlLnN1bW1hcnkgPz8gc3RhdGUuZXJyb3IgPz8gKHRvbmUgPT09IFwib2tcIiA/IFwiTUNQIGNvbmZpZ3VyYXRpb24gaXMgc3luY2hyb25pemVkLlwiIDogXCJNQ1AgY29uZmlndXJhdGlvbiBuZWVkcyBhdHRlbnRpb24uXCIpKTtcbiAgICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHRvbmUsIHN0YXR1cyA9PT0gXCJva1wiID8gXCJIZWFsdGh5XCIgOiBodW1hbml6ZUNvZGV4UGhhc2Uoc3RhdHVzKSkpO1xuICAgIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgICBjb25zdCByZXBhaXIgPSBjb21wYWN0QnV0dG9uKFwiUmVwYWlyXCIsICgpID0+IHtcbiAgICAgIHJlcGFpci5kaXNhYmxlZCA9IHRydWU7XG4gICAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcIm1jcFwiKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItbWNwXCIpXG4gICAgICAgIC50aGVuKChuZXh0KSA9PiB7XG4gICAgICAgICAgaWYgKGNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0IGFzIE1jcFN5bmNTdGF0ZSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICBjb25zdCBuZXh0ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSB9O1xuICAgICAgICAgIGlmIChjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIG5leHQpKSByZW5kZXIobmV4dCk7XG4gICAgICAgIH0pO1xuICAgIH0pO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJlcGFpcik7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIGlmIChzdGF0ZS5yZXN0YXJ0UmVxdWlyZWQpIHtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFxuICAgICAgICBcIk5ldyB0YXNrIG9yIHJlc3RhcnQgcmVxdWlyZWRcIixcbiAgICAgICAgXCJUaGUgY2Fub25pY2FsIE1DUCBuYW1lIGlzIHdyaXR0ZW4uIFN0YXJ0IGEgbmV3IHRhc2ssIG9yIHJlc3RhcnQgQ29kZXgsIHRvIHJlcGxhY2UgYW55IGFscmVhZHktcnVubmluZyBsZWdhY3kgTUNQIHByb2Nlc3MuXCIsXG4gICAgICApKTtcbiAgICB9XG4gICAgaWYgKHN0YXRlLmNvbmZsaWN0cz8ubGVuZ3RoKSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvbmZsaWN0c1wiLCBzdGF0ZS5jb25mbGljdHMubWFwKChjb25mbGljdCkgPT4ge1xuICAgICAgICBpZiAoY29uZmxpY3Qub2JzZXJ2ZWROYW1lIHx8IGNvbmZsaWN0LmNhbm9uaWNhbE5hbWUpIHtcbiAgICAgICAgICByZXR1cm4gYCR7Y29uZmxpY3Qub2JzZXJ2ZWROYW1lID8/IFwiVW5rbm93biBlbnRyeVwifSBcdTIxOTIgJHtjb25mbGljdC5jYW5vbmljYWxOYW1lID8/IFwiY2Fub25pY2FsIGVudHJ5XCJ9OiAke2NvbmZsaWN0LnJlYXNvbiA/PyBjb25mbGljdC5kZXRhaWwgPz8gXCJvd25lcnNoaXAgY29uZmxpY3RcIn1gO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBjb25mbGljdC5kZXRhaWwgPz8gY29uZmxpY3QucmVhc29uID8/IGNvbmZsaWN0Lm5hbWUgPz8gXCJVbmtub3duIGNvbmZsaWN0XCI7XG4gICAgICB9KS5qb2luKFwiOyBcIikpKTtcbiAgICB9XG4gICAgY29uc3QgY2hlY2tlZEF0ID0gc3RhdGUuY29tcGxldGVkQXQgPz8gc3RhdGUuY2hlY2tlZEF0O1xuICAgIGlmIChjaGVja2VkQXQpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKGNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKSkpO1xuICB9O1xuICBjb25zdCBvblN5bmNTdGF0ZUNoYW5nZWQgPSAoX2V2ZW50OiB1bmtub3duLCB2YWx1ZTogdW5rbm93bik6IHZvaWQgPT4ge1xuICAgIGlmICghY2FyZC5pc0Nvbm5lY3RlZCkge1xuICAgICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOm1jcC1zeW5jLXN0YXRlLWNoYW5nZWRcIiwgb25TeW5jU3RhdGVDaGFuZ2VkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJtY3BcIik7XG4gICAgY29uc3QgbmV4dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIE1jcFN5bmNTdGF0ZSA6IG51bGw7XG4gICAgaWYgKGNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgfTtcbiAgaXBjUmVuZGVyZXIub24oXCJ0d2Vha2VyOm1jcC1zeW5jLXN0YXRlLWNoYW5nZWRcIiwgb25TeW5jU3RhdGVDaGFuZ2VkKTtcbiAgY29uc3QgaW5pdGlhbFVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwibWNwXCIpO1xuICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LW1jcC1zeW5jLXN0YXRlXCIpXG4gICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICBjb25zdCBuZXh0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgTWNwU3luY1N0YXRlIDogbnVsbDtcbiAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkICYmIGNhcmRVcGRhdGVzLmNvbXBsZXRlKGluaXRpYWxVcGRhdGUsIG5leHQpKSByZW5kZXIobmV4dCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICBjb25zdCBuZXh0ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSB9O1xuICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQgJiYgY2FyZFVwZGF0ZXMuY29tcGxldGUoaW5pdGlhbFVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgICB9KTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwibWNwXCIpO1xuICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjptY3Atc3luYy1zdGF0ZS1jaGFuZ2VkXCIsIG9uU3luY1N0YXRlQ2hhbmdlZCk7XG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlckF1dG9tYXRpY01haW50ZW5hbmNlU2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXV0b21hdGljIE1haW50ZW5hbmNlXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC50d2Vha2VyTWFpbnRlbmFuY2VDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgYXV0b21hdGljIG1haW50ZW5hbmNlXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgbGV0IGxhdGVzdEhlYWx0aDogV2F0Y2hlckhlYWx0aCB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVwYWlySW5GbGlnaHQgPSBmYWxzZTtcbiAgbGV0IHJlcGFpckRpc3BsYXk6IFwiaWRsZVwiIHwgXCJzdWNjZXNzXCIgfCBcImZhaWx1cmVcIiA9IFwiaWRsZVwiO1xuICBsZXQgcmVwYWlyQmFzZWxpbmVDeWNsZTogV2F0Y2hlckN5Y2xlUmVjZWlwdCB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVwYWlyU3RhcnRlZEF0ID0gMDtcbiAgbGV0IHJlcGFpclBvbGw6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGxldCByZXBhaXJQb2xsQ291bnQgPSAwO1xuICBjb25zdCBNQVhfUkVQQUlSX1BPTExTID0gMzA7XG5cbiAgY29uc3QgcmVuZGVyID0gKGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IHZvaWQgPT4ge1xuICAgIGxhdGVzdEhlYWx0aCA9IGhlYWx0aDtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICBpZiAocmVwYWlySW5GbGlnaHQpIHtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwge1xuICAgICAgICAuLi5oZWFsdGgsXG4gICAgICAgIHN0YXR1czogXCJ3YXJuXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBydW5uaW5nXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiUmVwYWlyIHdhcyBzdGFydGVkIGluIHRoZSBiYWNrZ3JvdW5kLiBXYWl0aW5nIGZvciBhIGNvbXBsZXRlZCB3YXRjaGVyIGN5Y2xlXHUyMDI2XCIsXG4gICAgICB9LCBmYWxzZSk7XG4gICAgICBjb25zdCBydW5uaW5nID0gYWN0aW9uUm93KFwiQXV0b21hdGljIG1haW50ZW5hbmNlXCIsIFwiUmVwYWlyIGN5Y2xlIHJ1bm5pbmdcdTIwMjZcIik7XG4gICAgICBydW5uaW5nLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzdGF0dXNcIik7XG4gICAgICBydW5uaW5nLnNldEF0dHJpYnV0ZShcImFyaWEtbGl2ZVwiLCBcInBvbGl0ZVwiKTtcbiAgICAgIHJ1bm5pbmcucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKT8uYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoXCJ3YXJuXCIsIFwiUnVubmluZ1wiKSk7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJ1bm5pbmcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocmVwYWlyRGlzcGxheSA9PT0gXCJzdWNjZXNzXCIpIHtcbiAgICAgIGhlYWx0aCA9IHtcbiAgICAgICAgLi4uaGVhbHRoLFxuICAgICAgICBzdGF0dXM6IFwib2tcIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHN1Y2NlZWRlZFwiLFxuICAgICAgICBzdW1tYXJ5OiBcIlRoZSB3YXRjaGVyIGNvbXBsZXRlZCBhIGZyZXNoIHJlcGFpciBjeWNsZS5cIixcbiAgICAgIH07XG4gICAgfSBlbHNlIGlmIChyZXBhaXJEaXNwbGF5ID09PSBcImZhaWx1cmVcIikge1xuICAgICAgaGVhbHRoID0ge1xuICAgICAgICAuLi5oZWFsdGgsXG4gICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IGhlYWx0aC5zdW1tYXJ5IHx8IFwiVGhlIHdhdGNoZXIgcmVwYWlyIGN5Y2xlIGZhaWxlZC5cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoLCB0cnVlLCBzdGFydFJlcGFpcik7XG4gIH07XG4gIGNvbnN0IGxvYWQgPSAoKTogUHJvbWlzZTxXYXRjaGVySGVhbHRoIHwgbnVsbD4gPT4ge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwid2F0Y2hlclwiKTtcbiAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgICBjb25zdCBoZWFsdGggPSB2YWx1ZSBhcyBXYXRjaGVySGVhbHRoO1xuICAgICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQgfHwgIWNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgaGVhbHRoKSkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJlbmRlcihoZWFsdGgpO1xuICAgICAgICByZXR1cm4gaGVhbHRoO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgY29uc3QgaGVhbHRoOiBXYXRjaGVySGVhbHRoID0geyBjaGVja2VkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgc3RhdHVzOiBcImVycm9yXCIsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSB1bmF2YWlsYWJsZVwiLCBzdW1tYXJ5OiBzYWZlVWlFcnJvcihlcnJvciksIHdhdGNoZXI6IFwiV2F0Y2hlclwiLCBjaGVja3M6IFtdIH07XG4gICAgICAgIGlmICghY2FyZC5pc0Nvbm5lY3RlZCB8fCAhY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBoZWFsdGgpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmVuZGVyKGhlYWx0aCk7XG4gICAgICAgIHJldHVybiBoZWFsdGg7XG4gICAgICB9KTtcbiAgfTtcbiAgY29uc3QgaXNOZXdlckN5Y2xlID0gKGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IGJvb2xlYW4gPT4ge1xuICAgIGNvbnN0IGN5Y2xlID0gaGVhbHRoLmxhdGVzdENvbXBsZXRlZEN5Y2xlO1xuICAgIGlmICghY3ljbGUpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIXJlcGFpckJhc2VsaW5lQ3ljbGUpIHtcbiAgICAgIHJldHVybiBEYXRlLnBhcnNlKGN5Y2xlLmNvbXBsZXRlZEF0KSA+IHJlcGFpclN0YXJ0ZWRBdDtcbiAgICB9XG4gICAgcmV0dXJuIGN5Y2xlLmN5Y2xlSWQgIT09IHJlcGFpckJhc2VsaW5lQ3ljbGUuY3ljbGVJZFxuICAgICAgJiYgY3ljbGUuY29tcGxldGVkQXQgPiByZXBhaXJCYXNlbGluZUN5Y2xlLmNvbXBsZXRlZEF0O1xuICB9O1xuICBjb25zdCBmaW5pc2hSZXBhaXIgPSAoaGVhbHRoOiBXYXRjaGVySGVhbHRoLCBmYWlsZWQgPSBmYWxzZSk6IHZvaWQgPT4ge1xuICAgIHJlcGFpckluRmxpZ2h0ID0gZmFsc2U7XG4gICAgcmVwYWlyRGlzcGxheSA9IGZhaWxlZCA/IFwiZmFpbHVyZVwiIDogXCJzdWNjZXNzXCI7XG4gICAgaWYgKHJlcGFpclBvbGwpIGNsZWFyVGltZW91dChyZXBhaXJQb2xsKTtcbiAgICByZXBhaXJQb2xsID0gbnVsbDtcbiAgICBjb25zdCBuZXh0ID0gZmFpbGVkXG4gICAgICA/IHsgLi4uaGVhbHRoLCBzdGF0dXM6IFwiZXJyb3JcIiBhcyBjb25zdCwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLCBzdW1tYXJ5OiBoZWFsdGguc3VtbWFyeSB8fCBcIlRoZSB3YXRjaGVyIHJlcGFpciBjeWNsZSBmYWlsZWQuXCIgfVxuICAgICAgOiBoZWFsdGg7XG4gICAgcmVuZGVyKG5leHQpO1xuICB9O1xuICBjb25zdCBwb2xsUmVwYWlyID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghcmVwYWlySW5GbGlnaHQgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICBpZiAocmVwYWlyUG9sbENvdW50KysgPj0gTUFYX1JFUEFJUl9QT0xMUykge1xuICAgICAgZmluaXNoUmVwYWlyKHtcbiAgICAgICAgLi4uKGxhdGVzdEhlYWx0aCA/PyB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwiZXJyb3JcIiBhcyBjb25zdCwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLCBzdW1tYXJ5OiBcIlRoZSB3YXRjaGVyIGRpZCBub3QgcmVwb3J0IGEgY29tcGxldGVkIGN5Y2xlIGluIHRpbWUuXCIsIHdhdGNoZXI6IFwiV2F0Y2hlclwiLCBjaGVja3M6IFtdIH0pLFxuICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLFxuICAgICAgICBzdW1tYXJ5OiBcIlRoZSB3YXRjaGVyIGRpZCBub3QgcmVwb3J0IGEgY29tcGxldGVkIGN5Y2xlIGluIHRpbWUuXCIsXG4gICAgICB9LCB0cnVlKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdm9pZCBsb2FkKCkudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBpZiAoIWhlYWx0aCB8fCAhcmVwYWlySW5GbGlnaHQpIHJldHVybjtcbiAgICAgIGNvbnN0IGN5Y2xlID0gaGVhbHRoLmxhdGVzdENvbXBsZXRlZEN5Y2xlO1xuICAgICAgaWYgKGlzTmV3ZXJDeWNsZShoZWFsdGgpKSB7XG4gICAgICAgIGZpbmlzaFJlcGFpcihoZWFsdGgsIGN5Y2xlPy5vdXRjb21lID09PSBcImZhaWxlZFwiIHx8IGN5Y2xlPy5yZXBhaXIuc3RhdHVzID09PSBcImZhaWxlZFwiKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgcmVuZGVyKGhlYWx0aCk7XG4gICAgICByZXBhaXJQb2xsID0gc2V0VGltZW91dChwb2xsUmVwYWlyLCAxXzAwMCk7XG4gICAgfSk7XG4gIH07XG4gIGNvbnN0IHN0YXJ0UmVwYWlyID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmIChyZXBhaXJJbkZsaWdodCkgcmV0dXJuO1xuICAgIHJlcGFpckluRmxpZ2h0ID0gdHJ1ZTtcbiAgICByZXBhaXJEaXNwbGF5ID0gXCJpZGxlXCI7XG4gICAgcmVwYWlyQmFzZWxpbmVDeWNsZSA9IGxhdGVzdEhlYWx0aD8ubGF0ZXN0Q29tcGxldGVkQ3ljbGUgPz8gbnVsbDtcbiAgICByZXBhaXJTdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIHJlcGFpclBvbGxDb3VudCA9IDA7XG4gICAgcmVuZGVyKGxhdGVzdEhlYWx0aCA/PyB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwid2FyblwiLCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgcnVubmluZ1wiLCBzdW1tYXJ5OiBcIlN0YXJ0aW5nIHJlcGFpclx1MjAyNlwiLCB3YXRjaGVyOiBcIldhdGNoZXJcIiwgY2hlY2tzOiBbXSB9KTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmVwYWlyLWF1dG8tbWFpbnRlbmFuY2VcIilcbiAgICAgIC50aGVuKCgpID0+IHBvbGxSZXBhaXIoKSlcbiAgICAgIC5jYXRjaCgoZXJyb3IpID0+IGZpbmlzaFJlcGFpcih7XG4gICAgICAgIC4uLihsYXRlc3RIZWFsdGggPz8geyBjaGVja2VkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgc3RhdHVzOiBcImVycm9yXCIgYXMgY29uc3QsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIiwgc3VtbWFyeTogXCJcIiwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfSksXG4gICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgIH0sIHRydWUpKTtcbiAgfTtcbiAgbG9hZCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJ3YXRjaGVyXCIpO1xuICAgIHJlcGFpckluRmxpZ2h0ID0gZmFsc2U7XG4gICAgaWYgKHJlcGFpclBvbGwpIGNsZWFyVGltZW91dChyZXBhaXJQb2xsKTtcbiAgICByZXBhaXJQb2xsID0gbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQWR2YW5jZWRSdW50aW1lU2VjdGlvbihzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHJlbmRlckNvZGV4VmVyc2lvbnNTZWN0aW9uKHNlY3Rpb25zV3JhcCk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGV4VmVyc2lvbnNTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBvcHRpb25zOiB7IGNvbGxhcHNlZD86IGJvb2xlYW4gfSA9IHt9LFxuKTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5kYXRhc2V0LnR3ZWFrZXJDb2RleFNlY3Rpb24gPSBcInRydWVcIjtcbiAgY29uc3QgcmVmcmVzaCA9IGNvbXBhY3RCdXR0b24oXCJSZWZyZXNoXCIsICgpID0+IHsgdm9pZCBsb2FkKHRydWUpOyB9KTtcbiAgY29uc3QgaGVhZGluZyA9IHNlY3Rpb25UaXRsZShvcHRpb25zLmNvbGxhcHNlZCA/IFwiQWR2YW5jZWQgUnVudGltZSBEZXRhaWxzXCIgOiBcIlJ1bnRpbWUgVmVyc2lvbnNcIiwgcmVmcmVzaCk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckNvZGV4Q2FyZCA9IFwidHJ1ZVwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxvYWRpbmcgQ29kZXggdmVyc2lvbnNcIiwgXCJVc2luZyBjYWNoZWQgdmVyc2lvbiBhbmQgZmVhdHVyZSBpbmZvcm1hdGlvbiBmaXJzdC5cIikpO1xuICBpZiAob3B0aW9ucy5jb2xsYXBzZWQpIHtcbiAgICBjb25zdCBkZXRhaWxzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRldGFpbHNcIik7XG4gICAgZGV0YWlscy5kYXRhc2V0LnR3ZWFrZXJBZHZhbmNlZFJ1bnRpbWVEZXRhaWxzID0gXCJ0cnVlXCI7XG4gICAgY29uc3Qgc3VtbWFyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdW1tYXJ5XCIpO1xuICAgIHN1bW1hcnkuY2xhc3NOYW1lID0gXCJjdXJzb3ItcG9pbnRlciBweC0xIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpyaW5nLTIgZm9jdXMtdmlzaWJsZTpyaW5nLXRva2VuLWZvY3VzLWJvcmRlclwiO1xuICAgIHN1bW1hcnkudGV4dENvbnRlbnQgPSBcIkJ1aWxkcywgQ0xJIHJ1bnRpbWVzLCByZWxlYXNlcywgYW5kIGZlYXR1cmVzXCI7XG4gICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYm9keS5jbGFzc05hbWUgPSBcIm10LTIgZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICAgIGJvZHkuYXBwZW5kQ2hpbGQoY2FyZCk7XG4gICAgZGV0YWlscy5hcHBlbmQoc3VtbWFyeSwgYm9keSk7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChkZXRhaWxzKTtcbiAgfSBlbHNlIHtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICB9XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICBsZXQgcG9sbGluZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IGFjdGlvbkluRmxpZ2h0ID0gZmFsc2U7XG4gIGxldCBnZW5lcmF0aW9uID0gMDtcbiAgY29uc3Qgc2NoZWR1bGVQb2xsID0gKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpID0+IHtcbiAgICBpZiAocG9sbGluZykgY2xlYXJUaW1lb3V0KHBvbGxpbmcpO1xuICAgIHBvbGxpbmcgPSBudWxsO1xuICAgIGlmICghYWN0aW9uSW5GbGlnaHQgJiYgIWNvZGV4UHJvZ3Jlc3NCdXN5KHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcykpIHJldHVybjtcbiAgICBwb2xsaW5nID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBpZiAoY2FyZC5pc0Nvbm5lY3RlZCkgdm9pZCBsb2FkKGZhbHNlKTtcbiAgICB9LCA5MDApO1xuICB9O1xuICBjb25zdCByZXF1ZXN0UmVsb2FkOiBDb2RleFVpUmVsb2FkID0gKG1vZGUpID0+IHtcbiAgICBpZiAobW9kZSA9PT0gXCJvcGVyYXRpb24tc3RhcnRcIikgYWN0aW9uSW5GbGlnaHQgPSB0cnVlO1xuICAgIGlmIChtb2RlID09PSBcIm9wZXJhdGlvbi1zdG9wXCIpIGFjdGlvbkluRmxpZ2h0ID0gZmFsc2U7XG4gICAgdm9pZCBsb2FkKGZhbHNlKTtcbiAgfTtcbiAgY29uc3Qgc2hvdyA9IChzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KSA9PiB7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgcmVuZGVyQ29kZXhWZXJzaW9uc0NhcmQoY2FyZCwgc25hcHNob3QsIHJlcXVlc3RSZWxvYWQpO1xuICAgIHNjaGVkdWxlUG9sbChzbmFwc2hvdCk7XG4gIH07XG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWQoZm9yY2U6IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCBjdXJyZW50ID0gKytnZW5lcmF0aW9uO1xuICAgIHJlZnJlc2guZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbmFwc2hvdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgZm9yY2UgPyBcInR3ZWFrZXI6cmVmcmVzaC1jb2RleC12ZXJzaW9uc1wiIDogXCJ0d2Vha2VyOmdldC1jb2RleC12ZXJzaW9uc1wiLFxuICAgICAgKSBhcyBDb2RleFZlcnNpb25zU25hcHNob3Q7XG4gICAgICBpZiAoY3VycmVudCAhPT0gZ2VuZXJhdGlvbiB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgc2hvdyhzbmFwc2hvdCk7XG4gICAgICBpZiAoIWZvcmNlICYmIGlzQ29kZXhTbmFwc2hvdFN0YWxlKHNuYXBzaG90KSkge1xuICAgICAgICB2b2lkIGxvYWQodHJ1ZSk7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmIChjdXJyZW50ICE9PSBnZW5lcmF0aW9uIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ29kZXggdmVyc2lvbnMgdW5hdmFpbGFibGVcIiwgc2FmZVVpRXJyb3IoZXJyb3IpKSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChjdXJyZW50ID09PSBnZW5lcmF0aW9uKSByZWZyZXNoLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICB9XG4gIHZvaWQgbG9hZChmYWxzZSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvZGV4VmVyc2lvbnNDYXJkKFxuICBjYXJkOiBIVE1MRWxlbWVudCxcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgcmVsb2FkOiBDb2RleFVpUmVsb2FkLFxuKTogdm9pZCB7XG4gIGNvbnN0IGJ1bmRsZWQgPSBzbmFwc2hvdC5jbGkuYnVuZGxlZDtcbiAgY29uc3QgYmV0YSA9IHNuYXBzaG90LmNsaS5iZXRhO1xuICBjb25zdCBidXN5ID0gY29kZXhQcm9ncmVzc0J1c3koc25hcHNob3QuaW5zdGFsbFByb2dyZXNzKTtcblxuICBpZiAoc25hcHNob3QuZnJvbUNhY2hlIHx8IHNuYXBzaG90LnN0YWxlKSB7XG4gICAgY29uc3QgY2hlY2tlZCA9IG5ldyBEYXRlKHNuYXBzaG90LmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgIHNuYXBzaG90LnN0YWxlID8gXCJDYWNoZWQgaW5mb3JtYXRpb24gKHJlZnJlc2ggbmVlZGVkKVwiIDogXCJDYWNoZWQgaW5mb3JtYXRpb25cIixcbiAgICAgIGBTaG93aW5nIHRoZSBsYXN0IGtub3duIGdvb2QgcmVzdWx0IGZyb20gJHtjaGVja2VkfSB3aGlsZSBjdXJyZW50IGluZm9ybWF0aW9uIGxvYWRzLmAsXG4gICAgKSk7XG4gIH1cblxuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4QWN0aXZlQ2xpUm93KHNuYXBzaG90KSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhFbWJlZGRlZENsaVJvdyhidW5kbGVkLCBzbmFwc2hvdCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4TGF0ZXN0U3RhYmxlUmVsZWFzZVJvdyhidW5kbGVkKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhDbGlSb3coXCJNYW5hZ2VkIEFscGhhIENMSSAoUHJlLXJlbGVhc2UpXCIsIFwiYmV0YVwiLCBiZXRhLCBzbmFwc2hvdCwgYnVzeSwgcmVsb2FkKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhSdW50aW1lUm93KHNuYXBzaG90KSk7XG5cbiAgY29uc3QgcmVsZWFzZXMgPSBhY3Rpb25Sb3coXCJHaXRIdWIgUmVsZWFzZXNcIiwgXCJWaWV3IG9mZmljaWFsIE9wZW5BSSBDb2RleCByZWxlYXNlIG5vdGVzIGFuZCBwYWNrYWdlcy5cIik7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocmVsZWFzZXMpO1xuICByZWxlYXNlcy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiT3BlbiBSZWxlYXNlc1wiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwoXCJodHRwczovL2dpdGh1Yi5jb20vb3BlbmFpL2NvZGV4L3JlbGVhc2VzXCIpKSxcbiAgKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlcyk7XG5cbiAgaWYgKHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcyAmJiBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MucGhhc2UgJiYgc25hcHNob3QuaW5zdGFsbFByb2dyZXNzLnBoYXNlICE9PSBcImlkbGVcIikge1xuICAgIGNvbnN0IHAgPSBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3M7XG4gICAgY29uc3QgYW1vdW50ID0gZm9ybWF0Qnl0ZXMocC5ieXRlcyk7XG4gICAgY29uc3QgZGV0YWlsID0gcC5lcnJvciB8fCBbaHVtYW5pemVDb2RleFBoYXNlKHAucGhhc2UpLCBwLnZlcnNpb24sIGFtb3VudF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkFscGhhIG9wZXJhdGlvblwiLCBkZXRhaWwpKTtcbiAgfVxuXG4gIGNvbnN0IHN0YXRlTWVzc2FnZSA9IGNvZGV4UnVudGltZU1lc3NhZ2Uoc25hcHNob3QpO1xuICBpZiAoc3RhdGVNZXNzYWdlKSBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlJ1bnRpbWUgc3RhdHVzXCIsIHN0YXRlTWVzc2FnZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4RmVhdHVyZUJyb3dzZXIoc25hcHNob3QsIGJ1c3ksIHJlbG9hZCkpO1xufVxuXG5mdW5jdGlvbiBjb2RleEFjdGl2ZUNsaVJvdyhzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBhY3RpdmUgPSBzbmFwc2hvdC5hY3RpdmVDbGk7XG4gIGNvbnN0IHZlcnNpb24gPSBhY3RpdmUudmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gIGNvbnN0IGNoYW5uZWwgPSBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoYWN0aXZlLnZlcnNpb25DaGFubmVsKTtcbiAgY29uc3Qgc291cmNlID0gYWN0aXZlLnNvdXJjZSA9PT0gXCJidW5kbGVkXCJcbiAgICA/IGAke2NoYW5uZWx9IFx1MDBCNyBlbWJlZGRlZCBpbiB0aGUgT3BlbkFJIGRlc2t0b3AgYXBwIFx1MDBCNyBhcHAtbWFuYWdlZGBcbiAgICA6IGFjdGl2ZS5zb3VyY2UgPT09IFwibWFuYWdlZC1hbHBoYVwiXG4gICAgICA/IGAke2NoYW5uZWx9IFx1MDBCNyBtYW5hZ2VkIGJ5IFR3ZWFrZXJzYFxuICAgICAgOiBgJHtjaGFubmVsfSBcdTAwQjcgZXh0ZXJuYWwgQ09ERVhfQ0xJX1BBVEggb3ZlcnJpZGVgO1xuICBjb25zdCBkZXRhaWwgPSBbYFZlcnNpb24gJHt2ZXJzaW9ufWAsIHNvdXJjZSwgYWN0aXZlLnBhdGgsIGFjdGl2ZS5lcnJvcl0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiQWN0aXZlIENvZGV4IGJhY2tlbmRcIiwgZGV0YWlsKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3cpO1xuICByb3cudGl0bGUgPSBhY3RpdmUucGF0aDtcbiAgcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik/LmFwcGVuZENoaWxkKFxuICAgIHN0YXR1c0JhZGdlKGFjdGl2ZS5hdmFpbGFibGUgPyBcIm9rXCIgOiBcImVycm9yXCIsIGFjdGl2ZS5hdmFpbGFibGUgPyBcIkFjdGl2ZVwiIDogXCJVbmF2YWlsYWJsZVwiKSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhFbWJlZGRlZENsaVJvdyhcbiAgY2xpOiBDb2RleENsaVZlcnNpb25TdGF0ZSxcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdmVyc2lvbiA9IGNsaS52ZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIjtcbiAgY29uc3QgY2hhbm5lbCA9IGNvZGV4VmVyc2lvbkNoYW5uZWxMYWJlbChjbGkudmVyc2lvbkNoYW5uZWwpO1xuICBjb25zdCBkZXRhaWwgPSBbXG4gICAgYFZlcnNpb24gJHt2ZXJzaW9ufWAsXG4gICAgY2hhbm5lbCxcbiAgICBcIkVtYmVkZGVkIGluIHRoZSBPcGVuQUkgZGVza3RvcCBhcHA7IGl0IGNoYW5nZXMgb25seSB3aGVuIE9wZW5BSSBzaGlwcyBhIGRlc2t0b3AgdXBkYXRlXCIsXG4gICAgY2xpLnBhdGgsXG4gICAgY2xpLmF2YWlsYWJsZSA/IG51bGwgOiBjbGkuZXJyb3IsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiRGVza3RvcC1FbWJlZGRlZCBDb2RleCBDTElcIiwgZGV0YWlsKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3cpO1xuICByb3cudGl0bGUgPSBjbGkucGF0aCA/PyBcIlwiO1xuICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGlmIChzbmFwc2hvdC5hY3RpdmVDbGkuc291cmNlID09PSBcImJ1bmRsZWRcIikgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkFjdGl2ZVwiKSk7XG4gIGVsc2UgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJBcHAtbWFuYWdlZFwiKSk7XG4gIGlmIChjbGkudmVyc2lvbikge1xuICAgIGNvbnN0IHJlbGVhc2VVcmwgPSBgaHR0cHM6Ly9naXRodWIuY29tL29wZW5haS9jb2RleC9yZWxlYXNlcy90YWcvcnVzdC12JHtlbmNvZGVVUklDb21wb25lbnQoY2xpLnZlcnNpb24pfWA7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJlbGVhc2VcIiwgKCkgPT4gb3BlbkNvZGV4R2l0aHViVXJsKHJlbGVhc2VVcmwpKSk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhMYXRlc3RTdGFibGVSZWxlYXNlUm93KGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJlbGVhc2UgPSBjbGkucmVsZWFzZTtcbiAgY29uc3QgZGV0YWlsID0gcmVsZWFzZVxuICAgID8gYExhdGVzdCBzdGFibGUgc3RhbmRhbG9uZSByZWxlYXNlICR7cmVsZWFzZS52ZXJzaW9ufSBcdTAwQjcgVGhpcyBkb2VzIG5vdCByZXBsYWNlIHRoZSBkZXNrdG9wLWVtYmVkZGVkIGJhY2tlbmQuYFxuICAgIDogYExhdGVzdCBzdGFibGUgc3RhbmRhbG9uZSByZWxlYXNlIHVuYXZhaWxhYmxlJHtjbGkuZXJyb3IgPyBgIFx1MDBCNyAke2NsaS5lcnJvcn1gIDogXCJcIn1gO1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJMYXRlc3QgU3RhYmxlIENMSSBSZWxlYXNlXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIlN0YWJsZVwiKSk7XG4gIGlmIChpc1NhZmVDb2RleEdpdGh1YlVybChyZWxlYXNlPy5yZWxlYXNlVXJsKSkge1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlIS5yZWxlYXNlVXJsKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4Q2xpUm93KFxuICBsYWJlbDogc3RyaW5nLFxuICBsYW5lOiBDb2RleENsaUxhbmUsXG4gIGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaW5zdGFsbGVkID0gY2xpLm1hbmFnZWRDdXJyZW50VmVyc2lvbiA/PyBjbGkudmVyc2lvbjtcbiAgY29uc3QgbGF0ZXN0ID0gY2xpLnJlbGVhc2U/LnZlcnNpb247XG4gIGNvbnN0IGRldGFpbCA9IGluc3RhbGxlZExhdGVzdFN1bW1hcnkoaW5zdGFsbGVkLCBsYXRlc3QsIGNsaS5lcnJvciB8fCBjbGkucmVsZWFzZT8uZXJyb3IpO1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3cobGFiZWwsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoc25hcHNob3QuZWZmZWN0aXZlTGFuZSA9PT0gbGFuZSkgYWN0aW9ucz8ucHJlcGVuZChzdGF0dXNCYWRnZShcIm9rXCIsIFwiQWN0aXZlXCIpKTtcbiAgY29uc3QgcmVsZWFzZVVybCA9IGNsaS5yZWxlYXNlPy5yZWxlYXNlVXJsO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwocmVsZWFzZVVybCkpIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlVXJsISkpKTtcbiAgaWYgKGxhbmUgPT09IFwiYmV0YVwiKSB7XG4gICAgY29uc3QgaW5zdGFsbExhYmVsID0gaW5zdGFsbGVkICYmIGxhdGVzdCAmJiBpbnN0YWxsZWQgIT09IGxhdGVzdCA/IFwiVXBkYXRlXCIgOiBpbnN0YWxsZWQgPyBcIlJlaW5zdGFsbFwiIDogXCJJbnN0YWxsXCI7XG4gICAgY29uc3QgaW5zdGFsbCA9IGNvbXBhY3RCdXR0b24oaW5zdGFsbExhYmVsLCAoKSA9PiBydW5Db2RleEFjdGlvbihyb3csIFwidHdlYWtlcjppbnN0YWxsLWNvZGV4LWJldGFcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgICBpbnN0YWxsLmRpc2FibGVkID0gYnVzeSB8fCAhbGF0ZXN0O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGluc3RhbGwpO1xuICAgIGNvbnN0IHByZXZpb3VzVmVyc2lvbiA9IGNsaS5tYW5hZ2VkUHJldmlvdXNWZXJzaW9uO1xuICAgIGlmIChwcmV2aW91c1ZlcnNpb24pIHtcbiAgICAgIGNvbnN0IHJvbGxiYWNrID0gY29tcGFjdEJ1dHRvbihgUm9sbGJhY2sgdG8gJHtwcmV2aW91c1ZlcnNpb259YCwgKCkgPT4gcnVuQ29kZXhBY3Rpb24ocm93LCBcInR3ZWFrZXI6cm9sbGJhY2stY29kZXgtYmV0YVwiLCB1bmRlZmluZWQsIHJlbG9hZCkpO1xuICAgICAgcm9sbGJhY2suZGlzYWJsZWQgPSBidXN5O1xuICAgICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQocm9sbGJhY2spO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleFJ1bnRpbWVSb3coXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJlcXVlc3RlZCA9IHNuYXBzaG90LnJlcXVlc3RlZExhbmU7XG4gIGNvbnN0IHNlbGVjdGVkID0gcmVxdWVzdGVkXG4gICAgPyByZXF1ZXN0ZWQgPT09IFwiYmV0YVwiID8gXCJNYW5hZ2VkIEFscGhhIChQcmUtcmVsZWFzZSlcIiA6IFwiRGVza3RvcC1lbWJlZGRlZCAoYXBwLW1hbmFnZWQpXCJcbiAgICA6IHNuYXBzaG90LnVzZXJPdmVycmlkZVByZXNlcnZlZCA/IFwiRXh0ZXJuYWwgb3ZlcnJpZGVcIiA6IFwiTm90IGV4cGxpY2l0bHkgc2VsZWN0ZWRcIjtcbiAgY29uc3QgYWN0aXZlID0gc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJtYW5hZ2VkLWFscGhhXCJcbiAgICA/IFwiTWFuYWdlZCBBbHBoYVwiXG4gICAgOiBzbmFwc2hvdC5hY3RpdmVDbGkuc291cmNlID09PSBcImJ1bmRsZWRcIlxuICAgICAgPyBcIkRlc2t0b3AtZW1iZWRkZWRcIlxuICAgICAgOiBcIkV4dGVybmFsIG92ZXJyaWRlXCI7XG4gIGNvbnN0IGFjdGl2ZUNoYW5uZWwgPSBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoc25hcHNob3QuYWN0aXZlQ2xpLnZlcnNpb25DaGFubmVsKTtcbiAgY29uc3QgYWN0aXZlVmVyc2lvbiA9IHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uID8gYCAke3NuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9ufWAgOiBcIlwiO1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJTZWxlY3RlZCBydW50aW1lXCIsXG4gICAgYFNlbGVjdGVkOiAke3NlbGVjdGVkfS4gQWN0aXZlOiAke2FjdGl2ZX0ke2FjdGl2ZVZlcnNpb259IFx1MDBCNyAke2FjdGl2ZUNoYW5uZWx9LiBEZXNrdG9wIHByb2ZpbGUgYW5kIENMSSByZWxlYXNlIGNoYW5uZWwgYXJlIHJlcG9ydGVkIHNlcGFyYXRlbHkuYCxcbiAgKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3cpO1xuICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiTWFuYWdlZCBieSBFbnZpcm9ubWVudFwiKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmVhdHVyZUJyb3dzZXIoXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgd3JhcHBlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHdyYXBwZXIuY2xhc3NOYW1lID0gXCJwLTNcIjtcbiAgY29uc3QgZGV0YWlscyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkZXRhaWxzXCIpO1xuICBkZXRhaWxzLmRhdGFzZXQudHdlYWtlckZlYXR1cmVCcm93c2VyID0gXCJ0cnVlXCI7XG4gIGNvbnN0IHN1bW1hcnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3VtbWFyeVwiKTtcbiAgc3VtbWFyeS5jbGFzc05hbWUgPSBcImN1cnNvci1wb2ludGVyIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgY29uc3QgZmVhdHVyZXMgPSBzbmFwc2hvdC5mZWF0dXJlcztcbiAgc3VtbWFyeS50ZXh0Q29udGVudCA9IGBDb2RleCBDTEkgZmVhdHVyZXMgKCR7ZmVhdHVyZXMubGVuZ3RofSlgO1xuICBkZXRhaWxzLmFwcGVuZENoaWxkKHN1bW1hcnkpO1xuICBjb25zdCBjb250ZW50ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29udGVudC5jbGFzc05hbWUgPSBcIm10LTMgZmxleCBmbGV4LWNvbCBnYXAtM1wiO1xuICBjb25zdCBmaWx0ZXJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZmlsdGVycy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBzZWFyY2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XG4gIHNlYXJjaC50eXBlID0gXCJzZWFyY2hcIjtcbiAgc2VhcmNoLnBsYWNlaG9sZGVyID0gXCJTZWFyY2ggQ29kZXggZmVhdHVyZXNcIjtcbiAgc2VhcmNoLmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgaC10b2tlbi1idXR0b24tY29tcG9zZXIgbWluLXctWzE4MHB4XSBmbGV4LTEgcm91bmRlZC1tZCBib3JkZXIgcHgtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGNvbnN0IHN0YWdlID0gY29kZXhGaWx0ZXJTZWxlY3QoXCJTdGFnZVwiLCBbXCJhbGxcIiwgXCJzdGFibGVcIiwgXCJleHBlcmltZW50YWxcIiwgXCJ1bmRlci1kZXZlbG9wbWVudFwiLCBcImRlcHJlY2F0ZWRcIiwgXCJyZW1vdmVkXCJdKTtcbiAgY29uc3QgbGFuZSA9IGNvZGV4RmlsdGVyU2VsZWN0KFwiTGFuZVwiLCBbXCJhbGxcIiwgXCJidW5kbGVkXCIsIFwiYmV0YVwiLCBcImJ1bmRsZWQtb25seVwiLCBcImJldGEtb25seVwiXSk7XG4gIGNvbnN0IHN0YXR1cyA9IGNvZGV4RmlsdGVyU2VsZWN0KFwiU3RhdHVzXCIsIFtcImFsbFwiLCBcImVuYWJsZWRcIiwgXCJkaXNhYmxlZFwiLCBcInVuc3VwcG9ydGVkXCIsIFwicmVhZC1vbmx5XCJdKTtcbiAgZmlsdGVycy5hcHBlbmQoc2VhcmNoLCBzdGFnZSwgbGFuZSwgc3RhdHVzKTtcbiAgY29udGVudC5hcHBlbmRDaGlsZChmaWx0ZXJzKTtcbiAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxpc3QuY2xhc3NOYW1lID0gXCJib3JkZXItdG9rZW4tYm9yZGVyIGZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIHJvdW5kZWQtbGcgYm9yZGVyXCI7XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQobGlzdCk7XG4gIGNvbnN0IGRyYXcgPSAoKSA9PiB7XG4gICAgbGlzdC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgY29uc3QgcXVlcnkgPSBzZWFyY2gudmFsdWUudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgY29uc3Qgc2VsZWN0ZWRMYW5lID0gc25hcHNob3QucmVxdWVzdGVkTGFuZSA/PyBzbmFwc2hvdC5lZmZlY3RpdmVMYW5lID8/IFwiYnVuZGxlZFwiO1xuICAgIGNvbnN0IHNob3duID0gZmVhdHVyZXMuZmlsdGVyKChmZWF0dXJlKSA9PiB7XG4gICAgICBjb25zdCBmZWF0dXJlU3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBzZWxlY3RlZExhbmUpO1xuICAgICAgY29uc3QgZW5hYmxlZCA9IGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgc2VsZWN0ZWRMYW5lKTtcbiAgICAgIGNvbnN0IGxhbmVNYXRjaCA9IGxhbmUudmFsdWUgPT09IFwiYWxsXCJcbiAgICAgICAgfHwgKGxhbmUudmFsdWUgPT09IFwiYnVuZGxlZC1vbmx5XCIgJiYgZmVhdHVyZS5idW5kbGVkT25seSlcbiAgICAgICAgfHwgKGxhbmUudmFsdWUgPT09IFwiYmV0YS1vbmx5XCIgJiYgZmVhdHVyZS5iZXRhT25seSlcbiAgICAgICAgfHwgKGxhbmUudmFsdWUgPT09IFwiYnVuZGxlZFwiICYmIGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmUsIFwiYnVuZGxlZFwiKSAhPT0gbnVsbClcbiAgICAgICAgfHwgKGxhbmUudmFsdWUgPT09IFwiYmV0YVwiICYmIGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmUsIFwiYmV0YVwiKSAhPT0gbnVsbCk7XG4gICAgICBjb25zdCBzdGF0dXNNYXRjaCA9IHN0YXR1cy52YWx1ZSA9PT0gXCJhbGxcIiB8fCAoc3RhdHVzLnZhbHVlID09PSBcImVuYWJsZWRcIiAmJiBlbmFibGVkID09PSB0cnVlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcImRpc2FibGVkXCIgJiYgZW5hYmxlZCA9PT0gZmFsc2UpIHx8IChzdGF0dXMudmFsdWUgPT09IFwidW5zdXBwb3J0ZWRcIiAmJiBmZWF0dXJlLnN1cHBvcnRlZCA9PT0gZmFsc2UpIHx8IChzdGF0dXMudmFsdWUgPT09IFwicmVhZC1vbmx5XCIgJiYgIWNvZGV4RmVhdHVyZU11dGFibGUoZmVhdHVyZSwgc2VsZWN0ZWRMYW5lKSk7XG4gICAgICByZXR1cm4gKCFxdWVyeSB8fCBmZWF0dXJlLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSkpICYmIChzdGFnZS52YWx1ZSA9PT0gXCJhbGxcIiB8fCBzdGFnZS52YWx1ZSA9PT0gZmVhdHVyZVN0YWdlKSAmJiBsYW5lTWF0Y2ggJiYgc3RhdHVzTWF0Y2g7XG4gICAgfSk7XG4gICAgZm9yIChjb25zdCBmZWF0dXJlIG9mIHNob3duKSBsaXN0LmFwcGVuZENoaWxkKGNvZGV4RmVhdHVyZVJvdyhmZWF0dXJlLCBzZWxlY3RlZExhbmUsIGJ1c3ksIHJlbG9hZCkpO1xuICAgIGlmICghc2hvd24ubGVuZ3RoKSBsaXN0LmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIk5vIG1hdGNoaW5nIGZlYXR1cmVzXCIsIFwiVHJ5IGEgZGlmZmVyZW50IHNlYXJjaCBvciBmaWx0ZXIuXCIpKTtcbiAgfTtcbiAgZm9yIChjb25zdCBpbnB1dCBvZiBbc2VhcmNoLCBzdGFnZSwgbGFuZSwgc3RhdHVzXSkgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihpbnB1dCA9PT0gc2VhcmNoID8gXCJpbnB1dFwiIDogXCJjaGFuZ2VcIiwgZHJhdyk7XG4gIGRyYXcoKTtcbiAgZGV0YWlscy5hcHBlbmRDaGlsZChjb250ZW50KTtcbiAgd3JhcHBlci5hcHBlbmRDaGlsZChkZXRhaWxzKTtcbiAgcmV0dXJuIHdyYXBwZXI7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmVhdHVyZVJvdyhcbiAgZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksXG4gIGxhbmU6IENvZGV4Q2xpTGFuZSxcbiAgYnVzeTogYm9vbGVhbixcbiAgcmVsb2FkOiBDb2RleFVpUmVsb2FkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBzdGFnZSA9IGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmUsIGxhbmUpO1xuICBjb25zdCBlbmFibGVkID0gY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlLCBsYW5lKTtcbiAgY29uc3QgbXV0YWJsZSA9IGNvZGV4RmVhdHVyZU11dGFibGUoZmVhdHVyZSwgbGFuZSk7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSByb3dDb3B5KGZlYXR1cmUubmFtZSwgYCR7c3RhZ2UgfHwgXCJ1bnN1cHBvcnRlZFwifSBcdTAwQjcgJHtmZWF0dXJlLmVmZmVjdCA9PT0gXCJyZXN0YXJ0XCIgPyBcIlJlc3RhcnQgcmVxdWlyZWRcIiA6IGZlYXR1cmUuZWZmZWN0ID09PSBcIm5vbmVcIiA/IFwiTm8gcmVzdGFydFwiIDogXCJBcHBsaWVzIHRvIG5ldyBzZXNzaW9uc1wifWApO1xuICBjb25zdCBiYWRnZXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBiYWRnZXMuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgaWYgKGZlYXR1cmUuYnVuZGxlZE9ubHkpIGJhZGdlcy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIkJ1bmRsZWQgb25seVwiKSk7XG4gIGlmIChmZWF0dXJlLmJldGFPbmx5KSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJCZXRhIG9ubHlcIikpO1xuICBpZiAoZmVhdHVyZS5zdXBwb3J0ZWQgPT09IGZhbHNlKSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJVbnN1cHBvcnRlZFwiKSk7XG4gIGlmIChlbmFibGVkID09PSB0cnVlKSBiYWRnZXMuYXBwZW5kQ2hpbGQoc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkVuYWJsZWRcIikpO1xuICBpZiAoZW5hYmxlZCA9PT0gZmFsc2UpIGJhZGdlcy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIkRpc2FibGVkXCIpKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChiYWRnZXMpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIGlmIChtdXRhYmxlICYmIGVuYWJsZWQgIT09IG51bGwpIHtcbiAgICBjb25zdCB0b2dnbGUgPSBzd2l0Y2hDb250cm9sKGVuYWJsZWQsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICB0b2dnbGUuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzZXQtY29kZXgtZmVhdHVyZVwiLCB7IGxhbmUsIG5hbWU6IGZlYXR1cmUubmFtZSwgZW5hYmxlZDogbmV4dCB9KTtcbiAgICAgICAgcmVsb2FkKCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICB3aW5kb3cuYWxlcnQoYENvdWxkIG5vdCB1cGRhdGUgJHtmZWF0dXJlLm5hbWV9OiAke3NhZmVVaUVycm9yKGVycm9yKX1gKTtcbiAgICAgICAgcmVsb2FkKCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICB0b2dnbGUuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICB0b2dnbGUuZGlzYWJsZWQgPSBidXN5O1xuICAgIHRvZ2dsZS50aXRsZSA9IFwiRmVhdHVyZSBjaGFuZ2VzIGFwcGx5IHRvIG5ldyBzZXNzaW9ucy5cIjtcbiAgICByb3cuYXBwZW5kQ2hpbGQodG9nZ2xlKTtcbiAgfSBlbHNlIHtcbiAgICByb3cuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2Uoc3RhZ2UgPT09IFwiZGVwcmVjYXRlZFwiIHx8IHN0YWdlID09PSBcInJlbW92ZWRcIiA/IFwiUmVhZCBvbmx5XCIgOiBcIlVuYXZhaWxhYmxlXCIpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSwgbGFuZTogQ29kZXhDbGlMYW5lKTogQ29kZXhGZWF0dXJlU3RhZ2UgfCBudWxsIHtcbiAgcmV0dXJuIGZlYXR1cmUuc3RhZ2VzW2xhbmVdO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LCBsYW5lOiBDb2RleENsaUxhbmUpOiBib29sZWFuIHwgbnVsbCB7XG4gIHJldHVybiBmZWF0dXJlLmVuYWJsZWRbbGFuZV07XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmVhdHVyZU11dGFibGUoZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksIGxhbmU6IENvZGV4Q2xpTGFuZSk6IGJvb2xlYW4ge1xuICBjb25zdCBzdGFnZSA9IGNvZGV4RmVhdHVyZVN0YWdlKGZlYXR1cmUsIGxhbmUpO1xuICByZXR1cm4gZmVhdHVyZS5tdXRhYmxlID09PSB0cnVlXG4gICAgJiYgZmVhdHVyZS5zdXBwb3J0ZWQgIT09IGZhbHNlXG4gICAgJiYgc3RhZ2UgIT09IFwiZGVwcmVjYXRlZFwiXG4gICAgJiYgc3RhZ2UgIT09IFwicmVtb3ZlZFwiXG4gICAgJiYgY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlLCBsYW5lKSAhPT0gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29kZXhGaWx0ZXJTZWxlY3QobGFiZWw6IHN0cmluZywgb3B0aW9uczogc3RyaW5nW10pOiBIVE1MU2VsZWN0RWxlbWVudCB7XG4gIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWxlY3RcIik7XG4gIHNlbGVjdC5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHJvdW5kZWQtbWQgYm9yZGVyIHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBzZWxlY3QudGl0bGUgPSBsYWJlbDtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiBvcHRpb25zKSB7XG4gICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGlvblwiKTtcbiAgICBvcHRpb24udmFsdWUgPSB2YWx1ZTtcbiAgICBvcHRpb24udGV4dENvbnRlbnQgPSB2YWx1ZSA9PT0gXCJhbGxcIiA/IGBBbGwgJHtsYWJlbC50b0xvd2VyQ2FzZSgpfXNgIDogaHVtYW5pemVDb2RleFBoYXNlKHZhbHVlKTtcbiAgICBzZWxlY3QuYXBwZW5kQ2hpbGQob3B0aW9uKTtcbiAgfVxuICByZXR1cm4gc2VsZWN0O1xufVxuXG5mdW5jdGlvbiBjb2RleE5ldXRyYWxCYWRnZSh0ZXh0OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gdGV4dDtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgcm93LmNsYXNzTGlzdC5hZGQoXCJmbGV4LXdyYXBcIik7XG4gIHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5jbGFzc0xpc3QuYWRkKFwiZmxleC13cmFwXCIsIFwianVzdGlmeS1lbmRcIik7XG59XG5cbmZ1bmN0aW9uIGNvZGV4SW5saW5lTWVzc2FnZSh0ZXh0OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZXNzYWdlLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgbWVzc2FnZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBtZXNzYWdlO1xufVxuXG5mdW5jdGlvbiBjb2RleFByb2dyZXNzQnVzeShwcm9ncmVzczogQ29kZXhJbnN0YWxsUHJvZ3Jlc3MpOiBib29sZWFuIHtcbiAgcmV0dXJuICFbXCJpZGxlXCIsIFwiY29tcGxldGVcIiwgXCJmYWlsZWRcIl0uaW5jbHVkZXMocHJvZ3Jlc3MucGhhc2UpO1xufVxuXG5mdW5jdGlvbiBpc0NvZGV4U25hcHNob3RTdGFsZShzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogYm9vbGVhbiB7XG4gIHJldHVybiBzbmFwc2hvdC5zdGFsZTtcbn1cblxuZnVuY3Rpb24gaW5zdGFsbGVkTGF0ZXN0U3VtbWFyeShcbiAgaW5zdGFsbGVkOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBsYXRlc3Q6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4gIGVycm9yPzogc3RyaW5nIHwgbnVsbCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGluc3RhbGxlZFRleHQgPSBpbnN0YWxsZWQgfHwgXCJVbmF2YWlsYWJsZVwiO1xuICBjb25zdCBsYXRlc3RUZXh0ID0gbGF0ZXN0IHx8IFwiVW5hdmFpbGFibGVcIjtcbiAgcmV0dXJuIGBJbnN0YWxsZWQgJHtpbnN0YWxsZWRUZXh0fSBcdTAwQjcgTGF0ZXN0ICR7bGF0ZXN0VGV4dH0ke2Vycm9yID8gYCBcdTAwQjcgJHtlcnJvcn1gIDogXCJcIn1gO1xufVxuXG5mdW5jdGlvbiBjb2RleFJ1bnRpbWVNZXNzYWdlKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKHNuYXBzaG90LmZhbGxiYWNrUmVhc29uKSByZXR1cm4gYE1hbmFnZWQgQWxwaGEgY291bGQgbm90IHN0YXJ0OyB0aGUgZGVza3RvcC1lbWJlZGRlZCBiYWNrZW5kIHdhcyB1c2VkLiAke3NuYXBzaG90LmZhbGxiYWNrUmVhc29ufWA7XG4gIGlmIChzbmFwc2hvdC5yZXN0YXJ0UmVxdWlyZWQpIHJldHVybiBcIlJlc3RhcnQgdGhlIGFwcCB0byBhcHBseSB0aGUgc2VsZWN0ZWQgQ29kZXggcnVudGltZS5cIjtcbiAgaWYgKHNuYXBzaG90LnJlcXVlc3RlZExhbmUgJiYgc25hcHNob3QuZWZmZWN0aXZlTGFuZSAmJiBzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lICE9PSBzbmFwc2hvdC5lZmZlY3RpdmVMYW5lKSB7XG4gICAgcmV0dXJuIGAke3NuYXBzaG90LnJlcXVlc3RlZExhbmUgPT09IFwiYmV0YVwiID8gXCJNYW5hZ2VkIEFscGhhIChQcmUtcmVsZWFzZSlcIiA6IFwiRGVza3RvcC1lbWJlZGRlZFwifSBpcyBzZWxlY3RlZDsgJHtzbmFwc2hvdC5lZmZlY3RpdmVMYW5lID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWRcIn0gcmVtYWlucyBhY3RpdmUgdW50aWwgcmVzdGFydC5gO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoY2hhbm5lbDogQ29kZXhDbGlWZXJzaW9uU3RhdGVbXCJ2ZXJzaW9uQ2hhbm5lbFwiXSk6IHN0cmluZyB7XG4gIGlmIChjaGFubmVsID09PSBcInN0YWJsZVwiKSByZXR1cm4gXCJTdGFibGVcIjtcbiAgaWYgKGNoYW5uZWwgPT09IFwicHJlcmVsZWFzZVwiKSByZXR1cm4gXCJQcmUtcmVsZWFzZVwiO1xuICByZXR1cm4gXCJVbmtub3duIHJlbGVhc2UgY2hhbm5lbFwiO1xufVxuXG5mdW5jdGlvbiBjb2RleFNjb3BlZEVycm9yKFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBzY29wZTogXCJkZXNrdG9wXCIgfCBDb2RleENsaUxhbmUsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIHNuYXBzaG90LmVycm9yc1tzY29wZV0gPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gaXNTYWZlQ29kZXhHaXRodWJVcmwodXJsOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIGlmICghdXJsKSByZXR1cm4gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTCh1cmwpO1xuICAgIHJldHVybiBwYXJzZWQucHJvdG9jb2wgPT09IFwiaHR0cHM6XCJcbiAgICAgICYmIHBhcnNlZC5ob3N0bmFtZSA9PT0gXCJnaXRodWIuY29tXCJcbiAgICAgICYmIHBhcnNlZC5wb3J0ID09PSBcIlwiXG4gICAgICAmJiBwYXJzZWQudXNlcm5hbWUgPT09IFwiXCJcbiAgICAgICYmIHBhcnNlZC5wYXNzd29yZCA9PT0gXCJcIlxuICAgICAgJiYgKHBhcnNlZC5wYXRobmFtZSA9PT0gXCIvb3BlbmFpL2NvZGV4XCIgfHwgcGFyc2VkLnBhdGhuYW1lLnN0YXJ0c1dpdGgoXCIvb3BlbmFpL2NvZGV4L1wiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBvcGVuQ29kZXhHaXRodWJVcmwodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKCFpc1NhZmVDb2RleEdpdGh1YlVybCh1cmwpKSB7XG4gICAgcGxvZyhcImJsb2NrZWQgbm9uLUNvZGV4IEdpdEh1YiBVUkxcIiwgdXJsKTtcbiAgICByZXR1cm47XG4gIH1cbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm9wZW4tZXh0ZXJuYWxcIiwgdXJsKS5jYXRjaCgoZXJyb3IpID0+IHBsb2coXCJvcGVuIENvZGV4IHJlbGVhc2UgZmFpbGVkXCIsIFN0cmluZyhlcnJvcikpKTtcbn1cblxuZnVuY3Rpb24gcnVuQ29kZXhBY3Rpb24oXG4gIHJvdzogSFRNTEVsZW1lbnQsXG4gIGNoYW5uZWw6IHN0cmluZyxcbiAgcGF5bG9hZDogdW5rbm93bixcbiAgcmVsb2FkOiBDb2RleFVpUmVsb2FkLFxuKTogdm9pZCB7XG4gIGNvbnN0IGJ1dHRvbnMgPSByb3cucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIik7XG4gIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiB7IGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7IH0pO1xuICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICByZWxvYWQoXCJvcGVyYXRpb24tc3RhcnRcIik7XG4gIGNvbnN0IGludm9rZSA9IHBheWxvYWQgPT09IHVuZGVmaW5lZCA/IGlwY1JlbmRlcmVyLmludm9rZShjaGFubmVsKSA6IGlwY1JlbmRlcmVyLmludm9rZShjaGFubmVsLCBwYXlsb2FkKTtcbiAgdm9pZCBpbnZva2VcbiAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICB3aW5kb3cuYWxlcnQoc2FmZVVpRXJyb3IoZXJyb3IpKTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCJcIjtcbiAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiB7IGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlOyB9KTtcbiAgICAgIHJlbG9hZChcIm9wZXJhdGlvbi1zdG9wXCIpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBzYWZlVWlFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciB8fCBcIlVua25vd24gZXJyb3JcIik7XG59XG5cbmZ1bmN0aW9uIGh1bWFuaXplQ29kZXhQaGFzZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLnJlcGxhY2UoL1stX10vZywgXCIgXCIpLnJlcGxhY2UoL1xcYlxcdy9nLCAobGV0dGVyKSA9PiBsZXR0ZXIudG9VcHBlckNhc2UoKSk7XG59XG5cbmZ1bmN0aW9uIGZvcm1hdEJ5dGVzKHZhbHVlOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPCAxMDI0KSByZXR1cm4gYCR7dmFsdWV9IEJgO1xuICBpZiAodmFsdWUgPCAxMDI0ICogMTAyNCkgcmV0dXJuIGAkeyh2YWx1ZSAvIDEwMjQpLnRvRml4ZWQoMSl9IEtCYDtcbiAgcmV0dXJuIGAkeyh2YWx1ZSAvICgxMDI0ICogMTAyNCkpLnRvRml4ZWQoMSl9IE1CYDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtlckNvbmZpZyhjYXJkOiBIVE1MRWxlbWVudCwgY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogdm9pZCB7XG4gIHNldFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKGNvbmZpZy51cGRhdGVDaGVjayk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoYXV0b1VwZGF0ZVJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZCh1cGRhdGVDaGFubmVsUm93KGNvbmZpZykpO1xuICBjYXJkLmFwcGVuZENoaWxkKGluc3RhbGxhdGlvblNvdXJjZVJvdyhjb25maWcuaW5zdGFsbGF0aW9uU291cmNlKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoc2VsZlVwZGF0ZVN0YXR1c1Jvdyhjb25maWcuc2VsZlVwZGF0ZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNoZWNrRm9yVXBkYXRlc1Jvdyhjb25maWcpKTtcbiAgaWYgKGNvbmZpZy51cGRhdGVDaGVjaz8ucmVsZWFzZU5vdGVzKSBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VOb3Rlc1Jvdyhjb25maWcudXBkYXRlQ2hlY2spKTtcbn1cblxuZnVuY3Rpb24gYXV0b1VwZGF0ZVJvdyhjb25maWc6IFR3ZWFrZXJDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IFwiQXV0b21hdGljYWxseSByZWZyZXNoIFR3ZWFrZXJzXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGBJbnN0YWxsZWQgdmVyc2lvbiB2JHtjb25maWcudmVyc2lvbn0uIFRoZSB3YXRjaGVyIGNoZWNrcyBob3VybHkgYW5kIGNhbiByZWZyZXNoIHRoZSBUd2Vha2VycyBydW50aW1lIGF1dG9tYXRpY2FsbHkuYDtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcbiAgcm93LmFwcGVuZENoaWxkKFxuICAgIHN3aXRjaENvbnRyb2woY29uZmlnLmF1dG9VcGRhdGUsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnNldC1hdXRvLXVwZGF0ZVwiLCBuZXh0KTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gdXBkYXRlQ2hhbm5lbFJvdyhjb25maWc6IFR3ZWFrZXJDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIlJlbGVhc2UgY2hhbm5lbFwiLCB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWcpKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IHNlbGVjdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWxlY3RcIik7XG4gIHNlbGVjdC5jbGFzc05hbWUgPVxuICAgIFwiaC04IHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdHJhbnNwYXJlbnQgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzOm91dGxpbmUtbm9uZVwiO1xuICBmb3IgKGNvbnN0IFt2YWx1ZSwgbGFiZWxdIG9mIFtcbiAgICBbXCJzdGFibGVcIiwgXCJTdGFibGVcIl0sXG4gICAgW1wicHJlcmVsZWFzZVwiLCBcIlByZXJlbGVhc2VcIl0sXG4gICAgW1wiY3VzdG9tXCIsIFwiQ3VzdG9tXCJdLFxuICBdIGFzIGNvbnN0KSB7XG4gICAgY29uc3Qgb3B0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcIm9wdGlvblwiKTtcbiAgICBvcHRpb24udmFsdWUgPSB2YWx1ZTtcbiAgICBvcHRpb24udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICBvcHRpb24uc2VsZWN0ZWQgPSBjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gdmFsdWU7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gIH1cbiAgc2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgIC5pbnZva2UoXCJ0d2Vha2VyOnNldC11cGRhdGUtY29uZmlnXCIsIHsgdXBkYXRlQ2hhbm5lbDogc2VsZWN0LnZhbHVlIH0pXG4gICAgICAudGhlbigoKSA9PiByZWZyZXNoQ29uZmlnQ2FyZChyb3cpKVxuICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwic2V0IHVwZGF0ZSBjaGFubmVsIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgfSk7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoc2VsZWN0KTtcbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcImN1c3RvbVwiKSB7XG4gICAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJFZGl0XCIsICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVwbyA9IHdpbmRvdy5wcm9tcHQoXCJHaXRIdWIgcmVwb1wiLCBjb25maWcudXBkYXRlUmVwbyB8fCBcInRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnNcIik7XG4gICAgICAgIGlmIChyZXBvID09PSBudWxsKSByZXR1cm47XG4gICAgICAgIGNvbnN0IHJlZiA9IHdpbmRvdy5wcm9tcHQoXCJHaXQgcmVmXCIsIGNvbmZpZy51cGRhdGVSZWYgfHwgXCJtYWluXCIpO1xuICAgICAgICBpZiAocmVmID09PSBudWxsKSByZXR1cm47XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpzZXQtdXBkYXRlLWNvbmZpZ1wiLCB7XG4gICAgICAgICAgICB1cGRhdGVDaGFubmVsOiBcImN1c3RvbVwiLFxuICAgICAgICAgICAgdXBkYXRlUmVwbzogcmVwbyxcbiAgICAgICAgICAgIHVwZGF0ZVJlZjogcmVmLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENvbmZpZ0NhcmQocm93KSlcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJzZXQgY3VzdG9tIHVwZGF0ZSBzb3VyY2UgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsYXRpb25Tb3VyY2VSb3coc291cmNlOiBJbnN0YWxsYXRpb25Tb3VyY2UpOiBIVE1MRWxlbWVudCB7XG4gIHJldHVybiByb3dTaW1wbGUoXCJJbnN0YWxsYXRpb24gc291cmNlXCIsIGAke3NvdXJjZS5sYWJlbH06ICR7c291cmNlLmRldGFpbH1gKTtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1JvdyhzdGF0ZTogU2VsZlVwZGF0ZVN0YXRlIHwgbnVsbCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gcm93U2ltcGxlKFwiTGFzdCBUd2Vha2VycyB1cGRhdGVcIiwgc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGUpKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0ICYmIHN0YXRlKSB7XG4gICAgY29uc3QgdW5wdWJsaXNoZWQgPSBzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpO1xuICAgIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZSh1bnB1Ymxpc2hlZCA/IFwib2tcIiA6IHNlbGZVcGRhdGVTdGF0dXNUb25lKHN0YXRlLnN0YXR1cyksIHVucHVibGlzaGVkID8gXCJDdXJyZW50XCIgOiBzZWxmVXBkYXRlU3RhdHVzTGFiZWwoc3RhdGUuc3RhdHVzKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNoZWNrRm9yVXBkYXRlc1Jvdyhjb25maWc6IFR3ZWFrZXJDb25maWcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNoZWNrID0gY29uZmlnLnVwZGF0ZUNoZWNrO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID8gXCJUd2Vha2VycyB1cGRhdGUgYXZhaWxhYmxlXCIgOiBcIkNoZWNrIGZvciBUd2Vha2VycyB1cGRhdGVzXCI7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IHVwZGF0ZVN1bW1hcnkoY2hlY2spO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgaWYgKGNoZWNrPy5yZWxlYXNlVXJsKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgIGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlIE5vdGVzXCIsICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm9wZW4tZXh0ZXJuYWxcIiwgY2hlY2sucmVsZWFzZVVybCk7XG4gICAgICB9KSxcbiAgICApO1xuICB9XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpjaGVjay10d2Vha2VyLXVwZGF0ZVwiLCB0cnVlKVxuICAgICAgICAudGhlbigoY2hlY2spID0+IHtcbiAgICAgICAgICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjaGVjayBhcyBUd2Vha2VyVXBkYXRlQ2hlY2spO1xuICAgICAgICAgIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcIlR3ZWFrZXJzIHJlbGVhc2UgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSkpXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgIH0pO1xuICAgIH0pLFxuICApO1xuICBpZiAoY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSkgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiRG93bmxvYWQgVXBkYXRlXCIsICgpID0+IHtcbiAgICAgIHJvdy5zdHlsZS5vcGFjaXR5ID0gXCIwLjY1XCI7XG4gICAgICBjb25zdCBidXR0b25zID0gYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9ucy5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSB0cnVlKSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgIC5pbnZva2UoXCJ0d2Vha2VyOnJ1bi10d2Vha2VyLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKHRydWUpO1xuICAgICAgICAgIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgIHBsb2coXCJUd2Vha2VycyBzZWxmLXVwZGF0ZSBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgICAgICAgICB2b2lkIHJlZnJlc2hDb25maWdDYXJkKHJvdyk7XG4gICAgICAgIH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICAgICAgYnV0dG9ucy5mb3JFYWNoKChidXR0b24pID0+IChidXR0b24uZGlzYWJsZWQgPSBmYWxzZSkpO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZWxlYXNlTm90ZXNSb3coY2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMiBwLTNcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkxhdGVzdCByZWxlYXNlIG5vdGVzXCI7XG4gIHJvdy5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmNsYXNzTmFtZSA9XG4gICAgXCJtYXgtaC02MCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYm9keS5hcHBlbmRDaGlsZChyZW5kZXJSZWxlYXNlTm90ZXNNYXJrZG93bihjaGVjay5yZWxlYXNlTm90ZXM/LnRyaW0oKSB8fCBjaGVjay5lcnJvciB8fCBcIk5vIHJlbGVhc2Ugbm90ZXMgYXZhaWxhYmxlLlwiKSk7XG4gIHJvdy5hcHBlbmRDaGlsZChib2R5KTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24obWFya2Rvd246IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm9vdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvb3QuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIGNvbnN0IGxpbmVzID0gbWFya2Rvd24ucmVwbGFjZSgvXFxyXFxuPy9nLCBcIlxcblwiKS5zcGxpdChcIlxcblwiKTtcbiAgbGV0IHBhcmFncmFwaDogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGxpc3Q6IEhUTUxPTGlzdEVsZW1lbnQgfCBIVE1MVUxpc3RFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBjb2RlTGluZXM6IHN0cmluZ1tdIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgZmx1c2hQYXJhZ3JhcGggPSAoKSA9PiB7XG4gICAgaWYgKHBhcmFncmFwaC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInBcIik7XG4gICAgcC5jbGFzc05hbWUgPSBcIm0tMCBsZWFkaW5nLTVcIjtcbiAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihwLCBwYXJhZ3JhcGguam9pbihcIiBcIikudHJpbSgpKTtcbiAgICByb290LmFwcGVuZENoaWxkKHApO1xuICAgIHBhcmFncmFwaCA9IFtdO1xuICB9O1xuICBjb25zdCBmbHVzaExpc3QgPSAoKSA9PiB7XG4gICAgaWYgKCFsaXN0KSByZXR1cm47XG4gICAgcm9vdC5hcHBlbmRDaGlsZChsaXN0KTtcbiAgICBsaXN0ID0gbnVsbDtcbiAgfTtcbiAgY29uc3QgZmx1c2hDb2RlID0gKCkgPT4ge1xuICAgIGlmICghY29kZUxpbmVzKSByZXR1cm47XG4gICAgY29uc3QgcHJlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInByZVwiKTtcbiAgICBwcmUuY2xhc3NOYW1lID1cbiAgICAgIFwibS0wIG92ZXJmbG93LWF1dG8gcm91bmRlZC1tZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHAtMiB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgIGNvZGUudGV4dENvbnRlbnQgPSBjb2RlTGluZXMuam9pbihcIlxcblwiKTtcbiAgICBwcmUuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwcmUpO1xuICAgIGNvZGVMaW5lcyA9IG51bGw7XG4gIH07XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgaWYgKGxpbmUudHJpbSgpLnN0YXJ0c1dpdGgoXCJgYGBcIikpIHtcbiAgICAgIGlmIChjb2RlTGluZXMpIGZsdXNoQ29kZSgpO1xuICAgICAgZWxzZSB7XG4gICAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgICBjb2RlTGluZXMgPSBbXTtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY29kZUxpbmVzKSB7XG4gICAgICBjb2RlTGluZXMucHVzaChsaW5lKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAoIXRyaW1tZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBmbHVzaExpc3QoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IGhlYWRpbmcgPSAvXigjezEsM30pXFxzKyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChoZWFkaW5nKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChoZWFkaW5nWzFdLmxlbmd0aCA9PT0gMSA/IFwiaDNcIiA6IFwiaDRcIik7XG4gICAgICBoLmNsYXNzTmFtZSA9IFwibS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGgsIGhlYWRpbmdbMl0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHVub3JkZXJlZCA9IC9eWy0qXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBjb25zdCBvcmRlcmVkID0gL15cXGQrWy4pXVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAodW5vcmRlcmVkIHx8IG9yZGVyZWQpIHtcbiAgICAgIGZsdXNoUGFyYWdyYXBoKCk7XG4gICAgICBjb25zdCB3YW50T3JkZXJlZCA9IEJvb2xlYW4ob3JkZXJlZCk7XG4gICAgICBpZiAoIWxpc3QgfHwgKHdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJPTFwiKSB8fCAoIXdhbnRPcmRlcmVkICYmIGxpc3QudGFnTmFtZSAhPT0gXCJVTFwiKSkge1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQod2FudE9yZGVyZWQgPyBcIm9sXCIgOiBcInVsXCIpO1xuICAgICAgICBsaXN0LmNsYXNzTmFtZSA9IHdhbnRPcmRlcmVkXG4gICAgICAgICAgPyBcIm0tMCBsaXN0LWRlY2ltYWwgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCJcbiAgICAgICAgICA6IFwibS0wIGxpc3QtZGlzYyBzcGFjZS15LTEgcGwtNSBsZWFkaW5nLTVcIjtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24obGksICh1bm9yZGVyZWQgPz8gb3JkZXJlZCk/LlsxXSA/PyBcIlwiKTtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQobGkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgcXVvdGUgPSAvXj5cXHM/KC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHF1b3RlKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb25zdCBibG9ja3F1b3RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJsb2NrcXVvdGVcIik7XG4gICAgICBibG9ja3F1b3RlLmNsYXNzTmFtZSA9IFwibS0wIGJvcmRlci1sLTIgYm9yZGVyLXRva2VuLWJvcmRlciBwbC0zIGxlYWRpbmctNVwiO1xuICAgICAgYXBwZW5kSW5saW5lTWFya2Rvd24oYmxvY2txdW90ZSwgcXVvdGVbMV0pO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChibG9ja3F1b3RlKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIHBhcmFncmFwaC5wdXNoKHRyaW1tZWQpO1xuICB9XG5cbiAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgZmx1c2hMaXN0KCk7XG4gIGZsdXNoQ29kZSgpO1xuICByZXR1cm4gcm9vdDtcbn1cblxuZnVuY3Rpb24gYXBwZW5kSW5saW5lTWFya2Rvd24ocGFyZW50OiBIVE1MRWxlbWVudCwgdGV4dDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHBhdHRlcm4gPSAvKGAoW15gXSspYHxcXFsoW15cXF1dKylcXF1cXCgoaHR0cHM/OlxcL1xcL1teXFxzKV0rKVxcKXxcXCpcXCooW14qXSspXFwqXFwqfFxcKihbXipdKylcXCopL2c7XG4gIGxldCBsYXN0SW5kZXggPSAwO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHRleHQubWF0Y2hBbGwocGF0dGVybikpIHtcbiAgICBpZiAobWF0Y2guaW5kZXggPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgYXBwZW5kVGV4dChwYXJlbnQsIHRleHQuc2xpY2UobGFzdEluZGV4LCBtYXRjaC5pbmRleCkpO1xuICAgIGlmIChtYXRjaFsyXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBjb2RlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImNvZGVcIik7XG4gICAgICBjb2RlLmNsYXNzTmFtZSA9XG4gICAgICAgIFwicm91bmRlZCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIHB4LTEgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIGNvZGUudGV4dENvbnRlbnQgPSBtYXRjaFsyXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChjb2RlKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzNdICE9PSB1bmRlZmluZWQgJiYgbWF0Y2hbNF0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICAgICAgYS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IHVuZGVybGluZSB1bmRlcmxpbmUtb2Zmc2V0LTJcIjtcbiAgICAgIGEuaHJlZiA9IG1hdGNoWzRdO1xuICAgICAgYS50YXJnZXQgPSBcIl9ibGFua1wiO1xuICAgICAgYS5yZWwgPSBcIm5vb3BlbmVyIG5vcmVmZXJyZXJcIjtcbiAgICAgIGEudGV4dENvbnRlbnQgPSBtYXRjaFszXTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChhKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzVdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHN0cm9uZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdHJvbmdcIik7XG4gICAgICBzdHJvbmcuY2xhc3NOYW1lID0gXCJmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgICAgc3Ryb25nLnRleHRDb250ZW50ID0gbWF0Y2hbNV07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoc3Ryb25nKTtcbiAgICB9IGVsc2UgaWYgKG1hdGNoWzZdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImVtXCIpO1xuICAgICAgZW0udGV4dENvbnRlbnQgPSBtYXRjaFs2XTtcbiAgICAgIHBhcmVudC5hcHBlbmRDaGlsZChlbSk7XG4gICAgfVxuICAgIGxhc3RJbmRleCA9IG1hdGNoLmluZGV4ICsgbWF0Y2hbMF0ubGVuZ3RoO1xuICB9XG4gIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCkpO1xufVxuXG5mdW5jdGlvbiBhcHBlbmRUZXh0KHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodGV4dCkgcGFyZW50LmFwcGVuZENoaWxkKGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKHRleHQpKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aENhcmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKVxuICAgIC50aGVuKChoZWFsdGgpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCBoZWFsdGggYXMgV2F0Y2hlckhlYWx0aCk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgY2hlY2sgd2F0Y2hlclwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyV2F0Y2hlckhlYWx0aChcbiAgY2FyZDogSFRNTEVsZW1lbnQsXG4gIGhlYWx0aDogV2F0Y2hlckhlYWx0aCxcbiAgaW5jbHVkZVJlcGFpciA9IGZhbHNlLFxuICBvblJlcGFpcj86ICgpID0+IHZvaWQsXG4pOiB2b2lkIHtcbiAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGgpKTtcbiAgZm9yIChjb25zdCBjaGVjayBvZiBoZWFsdGguY2hlY2tzKSB7XG4gICAgaWYgKGNoZWNrLnN0YXR1cyA9PT0gXCJva1wiKSBjb250aW51ZTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHdhdGNoZXJDaGVja1JvdyhjaGVjaykpO1xuICB9XG4gIGlmIChpbmNsdWRlUmVwYWlyKSB7XG4gICAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgICAgXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2VcIixcbiAgICAgIGhlYWx0aC5zdGF0dXMgPT09IFwib2tcIlxuICAgICAgICA/IFwiVGhlIHdhdGNoZXIgaXMgaGVhbHRoeSBhbmQgd2lsbCBjb250aW51ZSBjaGVja2luZyBhdXRvbWF0aWNhbGx5LlwiXG4gICAgICAgIDogXCJSZXBhaXIgdGhlIHdhdGNoZXIgcmVnaXN0cmF0aW9uIGFuZCBydW4gYSBmcmVzaCBoZWFsdGggY2hlY2suXCIsXG4gICAgKTtcbiAgICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJlcGFpciBOb3dcIiwgb25SZXBhaXIgPz8gKCgpID0+IHtcbiAgICAgIGNvbnN0IGJ1dHRvbiA9IGFjdGlvbnMucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIik7XG4gICAgICBpZiAoYnV0dG9uKSBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlcGFpci1hdXRvLW1haW50ZW5hbmNlXCIpXG4gICAgICAgIC50aGVuKCgpID0+IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LXdhdGNoZXItaGVhbHRoXCIpKVxuICAgICAgICAudGhlbigobmV4dCkgPT4ge1xuICAgICAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgbmV4dCBhcyBXYXRjaGVySGVhbHRoLCB0cnVlKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwge1xuICAgICAgICAgICAgLi4uaGVhbHRoLFxuICAgICAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgcmVwYWlyIGZhaWxlZFwiLFxuICAgICAgICAgICAgc3VtbWFyeTogc2FmZVVpRXJyb3IoZXJyb3IpLFxuICAgICAgICB9LCB0cnVlKTtcbiAgICAgIH0pO1xuICAgIH0pKSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJTdW1tYXJ5Um93KGhlYWx0aDogV2F0Y2hlckhlYWx0aCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1zdGFydCBnYXAtM1wiO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKGhlYWx0aC5zdGF0dXMsIGhlYWx0aC53YXRjaGVyKSk7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGhlYWx0aC50aXRsZTtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gYCR7aGVhbHRoLnN1bW1hcnl9IENoZWNrZWQgJHtuZXcgRGF0ZShoZWFsdGguY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGFjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGFjdGlvbi5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgTm93XCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGNhcmQgPSByb3cucGFyZW50RWxlbWVudDtcbiAgICAgIGlmICghY2FyZCkgcmV0dXJuO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIHdhdGNoZXJcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQpO1xuICAgIH0pLFxuICApO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9uKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gd2F0Y2hlckNoZWNrUm93KGNoZWNrOiBXYXRjaGVySGVhbHRoQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShjaGVjay5uYW1lLCBjaGVjay5kZXRhaWwpO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZShjaGVjay5zdGF0dXMpKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gc3RhdHVzQmFkZ2Uoc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgbGFiZWw/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGNvbnN0IHRvbmUgPVxuICAgIHN0YXR1cyA9PT0gXCJva1wiXG4gICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1ncmVlbiB0ZXh0LXRva2VuLWNoYXJ0cy1ncmVlblwiXG4gICAgICA6IHN0YXR1cyA9PT0gXCJ3YXJuXCJcbiAgICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMteWVsbG93IHRleHQtdG9rZW4tY2hhcnRzLXllbGxvd1wiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tY2hhcnRzLXJlZCB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIjtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gYGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIHB4LTIgcHktMC41IHRleHQteHMgZm9udC1tZWRpdW0gJHt0b25lfWA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWwgfHwgKHN0YXR1cyA9PT0gXCJva1wiID8gXCJPS1wiIDogc3RhdHVzID09PSBcIndhcm5cIiA/IFwiUmV2aWV3XCIgOiBcIkVycm9yXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN1bW1hcnkoY2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIWNoZWNrKSByZXR1cm4gXCJObyB1cGRhdGUgY2hlY2sgaGFzIHJ1biB5ZXQuXCI7XG4gIGNvbnN0IGxhdGVzdCA9IGNoZWNrLmxhdGVzdFZlcnNpb24gPyBgTGF0ZXN0IHYke2NoZWNrLmxhdGVzdFZlcnNpb259LiBgIDogXCJcIjtcbiAgY29uc3QgY2hlY2tlZCA9IGBDaGVja2VkICR7bmV3IERhdGUoY2hlY2suY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpfS5gO1xuICBpZiAoY2hlY2suZXJyb3IpIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfSAke2NoZWNrLmVycm9yfWA7XG4gIHJldHVybiBgJHtsYXRlc3R9JHtjaGVja2VkfWA7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUNoYW5uZWxTdW1tYXJ5KGNvbmZpZzogVHdlYWtlckNvbmZpZyk6IHN0cmluZyB7XG4gIGlmIChjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gXCJjdXN0b21cIikge1xuICAgIHJldHVybiBgJHtjb25maWcudXBkYXRlUmVwbyB8fCBcInRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnNcIn0gJHtjb25maWcudXBkYXRlUmVmIHx8IFwiKG5vIHJlZiBzZXQpXCJ9YDtcbiAgfVxuICBpZiAoY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IFwicHJlcmVsZWFzZVwiKSB7XG4gICAgcmV0dXJuIFwiVXNlIHRoZSBuZXdlc3QgcHVibGlzaGVkIEdpdEh1YiByZWxlYXNlLCBpbmNsdWRpbmcgcHJlcmVsZWFzZXMuXCI7XG4gIH1cbiAgcmV0dXJuIFwiVXNlIHRoZSBsYXRlc3Qgc3RhYmxlIEdpdEh1YiByZWxlYXNlLlwiO1xufVxuXG5mdW5jdGlvbiBzZWxmVXBkYXRlU3VtbWFyeShzdGF0ZTogU2VsZlVwZGF0ZVN0YXRlIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICghc3RhdGUpIHJldHVybiBcIk5vIGF1dG9tYXRpYyBUd2Vha2VycyB1cGRhdGUgaGFzIHJ1biB5ZXQuXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBuZXcgRGF0ZShzdGF0ZS5jb21wbGV0ZWRBdCA/PyBzdGF0ZS5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCk7XG4gIGNvbnN0IHRhcmdldCA9IHN0YXRlLmxhdGVzdFZlcnNpb24gPyBgIFRhcmdldCB2JHtzdGF0ZS5sYXRlc3RWZXJzaW9ufS5gIDogc3RhdGUudGFyZ2V0UmVmID8gYCBUYXJnZXQgJHtzdGF0ZS50YXJnZXRSZWZ9LmAgOiBcIlwiO1xuICBjb25zdCBzb3VyY2UgPSBzdGF0ZS5pbnN0YWxsYXRpb25Tb3VyY2U/LmxhYmVsID8/IFwidW5rbm93biBzb3VyY2VcIjtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJmYWlsZWRcIiAmJiAvNDA0fG5vICg/OnB1Ymxpc2hlZCB8Z2l0aHViICk/cmVsZWFzZS9pLnRlc3Qoc3RhdGUuZXJyb3IgPz8gXCJcIikpIHJldHVybiBgU291cmNlIGNoZWNrb3V0IGlzIGN1cnJlbnQgYXMgb2YgJHtjaGVja2VkfTsgbm8gcHVibGlzaGVkIHJlbGVhc2UgZXhpc3RzIHlldC5gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gYFVwZGF0ZSBjaGVjayBuZWVkcyBhdHRlbnRpb24gKCR7Y2hlY2tlZH0pLiAke3N0YXRlLmVycm9yID8/IFwiVW5rbm93biBlcnJvclwifWA7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwidXBkYXRlZFwiKSByZXR1cm4gYFVwZGF0ZWQgJHtjaGVja2VkfS4ke3RhcmdldH0gU291cmNlOiAke3NvdXJjZX0uYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJ1cC10by1kYXRlXCIpIHJldHVybiBgVXAgdG8gZGF0ZSAke2NoZWNrZWR9LiR7dGFyZ2V0fSBTb3VyY2U6ICR7c291cmNlfS5gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcImRpc2FibGVkXCIpIHJldHVybiBgU2tpcHBlZCAke2NoZWNrZWR9OyBhdXRvbWF0aWMgcmVmcmVzaCBpcyBkaXNhYmxlZC5gO1xuICByZXR1cm4gYENoZWNraW5nIGZvciB1cGRhdGVzLiBTb3VyY2U6ICR7c291cmNlfS5gO1xufVxuXG5mdW5jdGlvbiBzZWxmVXBkYXRlU3RhdHVzVG9uZShzdGF0dXM6IFNlbGZVcGRhdGVTdGF0dXMpOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiB7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcImVycm9yXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZGlzYWJsZWRcIiB8fCBzdGF0dXMgPT09IFwiY2hlY2tpbmdcIikgcmV0dXJuIFwid2FyblwiO1xuICByZXR1cm4gXCJva1wiO1xufVxuXG5mdW5jdGlvbiBzZWxmVXBkYXRlU3RhdHVzTGFiZWwoc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzKTogc3RyaW5nIHtcbiAgaWYgKHN0YXR1cyA9PT0gXCJ1cC10by1kYXRlXCIpIHJldHVybiBcIlVwIHRvIGRhdGVcIjtcbiAgaWYgKHN0YXR1cyA9PT0gXCJ1cGRhdGVkXCIpIHJldHVybiBcIlVwZGF0ZWRcIjtcbiAgaWYgKHN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiRmFpbGVkXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZGlzYWJsZWRcIikgcmV0dXJuIFwiRGlzYWJsZWRcIjtcbiAgcmV0dXJuIFwiQ2hlY2tpbmdcIjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaENvbmZpZ0NhcmQocm93OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBjYXJkID0gcm93LmNsb3Nlc3QoXCJbZGF0YS10d2Vha2VyLWNvbmZpZy1jYXJkXVwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghY2FyZCkgcmV0dXJuO1xuICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJSZWZyZXNoaW5nXCIsIFwiTG9hZGluZyBjdXJyZW50IFR3ZWFrZXJzIHVwZGF0ZSBzdGF0dXMuXCIpKTtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb25maWdcIilcbiAgICAudGhlbigoY29uZmlnKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZCwgY29uZmlnIGFzIFR3ZWFrZXJDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IHJlZnJlc2ggdXBkYXRlIHNldHRpbmdzXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiB1bmluc3RhbGxSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJVbmluc3RhbGwgVHdlYWtlcnNcIixcbiAgICBcIkNvcGllcyB0aGUgdW5pbnN0YWxsIGNvbW1hbmQuIFJ1biBpdCBmcm9tIGEgdGVybWluYWwgYWZ0ZXIgcXVpdHRpbmcgQ29kZXguXCIsXG4gICk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDb3B5IENvbW1hbmRcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpjb3B5LXRleHRcIiwgXCJub2RlIH4vLnR3ZWFrZXIvc291cmNlL3BhY2thZ2VzL2luc3RhbGxlci9kaXN0L2NsaS5qcyB1bmluc3RhbGxcIilcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiY29weSB1bmluc3RhbGwgY29tbWFuZCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlcG9ydEJ1Z1JvdygpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIlJlcG9ydCBhIGJ1Z1wiLFxuICAgIFwiT3BlbiBhIEdpdEh1YiBpc3N1ZSB3aXRoIHJ1bnRpbWUsIGluc3RhbGxlciwgb3IgdHdlYWstbWFuYWdlciBkZXRhaWxzLlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiT3BlbiBJc3N1ZVwiLCAoKSA9PiB7XG4gICAgICBjb25zdCB0aXRsZSA9IGVuY29kZVVSSUNvbXBvbmVudChcIltCdWddOiBcIik7XG4gICAgICBjb25zdCBib2R5ID0gZW5jb2RlVVJJQ29tcG9uZW50KFxuICAgICAgICBbXG4gICAgICAgICAgXCIjIyBXaGF0IGhhcHBlbmVkP1wiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBTdGVwcyB0byByZXByb2R1Y2VcIixcbiAgICAgICAgICBcIjEuIFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBFbnZpcm9ubWVudFwiLFxuICAgICAgICAgIFwiLSBUd2Vha2VycyB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gQ29kZXggYXBwIHZlcnNpb246IFwiLFxuICAgICAgICAgIFwiLSBPUzogXCIsXG4gICAgICAgICAgXCJcIixcbiAgICAgICAgICBcIiMjIExvZ3NcIixcbiAgICAgICAgICBcIkF0dGFjaCByZWxldmFudCBsaW5lcyBmcm9tIHRoZSBUd2Vha2VycyBsb2cgZGlyZWN0b3J5LlwiLFxuICAgICAgICBdLmpvaW4oXCJcXG5cIiksXG4gICAgICApO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsXG4gICAgICAgIGBodHRwczovL2dpdGh1Yi5jb20vdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy9pc3N1ZXMvbmV3P3RpdGxlPSR7dGl0bGV9JmJvZHk9JHtib2R5fWAsXG4gICAgICApO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBhY3Rpb25Sb3codGl0bGVUZXh0OiBzdHJpbmcsIGRlc2NyaXB0aW9uOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTFcIjtcbiAgY29uc3QgdGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IHRpdGxlVGV4dDtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICBkZXNjLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmRhdGFzZXQudHdlYWtlclJvd0FjdGlvbnMgPSBcInRydWVcIjtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtTdG9yZVBhZ2UoXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIGhlYWRlckFjdGlvbnM/OiBIVE1MRWxlbWVudCxcbik6IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC00XCI7XG5cbiAgY29uc3Qgc291cmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHNvdXJjZS5oaWRkZW4gPSB0cnVlO1xuICBzb3VyY2UuZGF0YXNldC50d2Vha2VyU3RvcmVTb3VyY2UgPSBcInRydWVcIjtcbiAgc291cmNlLnRleHRDb250ZW50ID0gXCJMb2FkaW5nIGxpdmUgcmVnaXN0cnlcIjtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IHJlZnJlc2hCdG4gPSBzdG9yZUljb25CdXR0b24ocmVmcmVzaEljb25TdmcoKSwgXCJSZWZyZXNoIHR3ZWFrIHN0b3JlXCIsICgpID0+IHtcbiAgICByZWZyZXNoQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG51bGwpO1xuICAgIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHJlbmRlclR3ZWFrU3RvcmVHaG9zdEdyaWQoZ3JpZCk7XG4gICAgcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSwgcmVmcmVzaEJ0biwgdHJ1ZSk7XG4gIH0pO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHJlZnJlc2hCdG4pO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlVG9vbGJhckJ1dHRvbihcIlB1Ymxpc2ggVHdlYWtcIiwgb3BlblB1Ymxpc2hUd2Vha0RpYWxvZywgXCJwcmltYXJ5XCIpKTtcbiAgaWYgKGhlYWRlckFjdGlvbnMpIHtcbiAgICBoZWFkZXJBY3Rpb25zLnJlcGxhY2VDaGlsZHJlbihhY3Rpb25zKTtcbiAgfVxuXG4gIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlR3JpZCA9IFwidHJ1ZVwiO1xuICBncmlkLmNsYXNzTmFtZSA9IFwiZ3JpZCBnYXAtNFwiO1xuICBpZiAoc3RhdGUudHdlYWtTdG9yZSkge1xuICAgIGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmUgPSBKU09OLnN0cmluZ2lmeShzdGF0ZS50d2Vha1N0b3JlKTtcbiAgICByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UpO1xuICB9IGVsc2Uge1xuICAgIHJlbmRlclR3ZWFrU3RvcmVHaG9zdEdyaWQoZ3JpZCk7XG4gIH1cbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzb3VyY2UpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGdyaWQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UsIHJlZnJlc2hCdG4pO1xufVxuXG5mdW5jdGlvbiByZWZyZXNoVHdlYWtTdG9yZUdyaWQoXG4gIGdyaWQ6IEhUTUxFbGVtZW50LFxuICBzb3VyY2U6IEhUTUxFbGVtZW50LFxuICByZWZyZXNoQnRuPzogSFRNTEJ1dHRvbkVsZW1lbnQsXG4gIGZvcmNlID0gZmFsc2UsXG4pOiB2b2lkIHtcbiAgdm9pZCBnZXRUd2Vha1N0b3JlKGZvcmNlKVxuICAgIC50aGVuKChzdG9yZSkgPT4ge1xuICAgICAgZ3JpZC5kYXRhc2V0LnR3ZWFrZXJTdG9yZSA9IEpTT04uc3RyaW5naWZ5KHN0b3JlKTtcbiAgICAgIHJlbmRlclR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmUgPSBcIlwiO1xuICAgICAgZ3JpZC5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIik7XG4gICAgICBzb3VyY2UudGV4dENvbnRlbnQgPSBcIkxpdmUgcmVnaXN0cnkgdW5hdmFpbGFibGVcIjtcbiAgICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UobnVsbCk7XG4gICAgICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGdyaWQuYXBwZW5kQ2hpbGQoc3RvcmVNZXNzYWdlQ2FyZChcIkNvdWxkIG5vdCBsb2FkIHR3ZWFrIHN0b3JlXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pXG4gICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgaWYgKHJlZnJlc2hCdG4pIHJlZnJlc2hCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gd2FybVR3ZWFrU3RvcmUoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS50d2Vha1N0b3JlIHx8IHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlKSByZXR1cm47XG4gIHZvaWQgZ2V0VHdlYWtTdG9yZSgpLnRoZW4oKHN0b3JlKSA9PiB7XG4gICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShvdXRkYXRlZEluc3RhbGxlZFN0b3JlQ291bnQoc3RvcmUuZW50cmllcykpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZ2V0VHdlYWtTdG9yZShmb3JjZSA9IGZhbHNlKTogUHJvbWlzZTxUd2Vha1N0b3JlUmVnaXN0cnlWaWV3PiB7XG4gIGlmICghZm9yY2UpIHtcbiAgICBpZiAoc3RhdGUudHdlYWtTdG9yZSkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShzdGF0ZS50d2Vha1N0b3JlKTtcbiAgICBpZiAoc3RhdGUudHdlYWtTdG9yZVByb21pc2UpIHJldHVybiBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZTtcbiAgfVxuICBzdGF0ZS50d2Vha1N0b3JlRXJyb3IgPSBudWxsO1xuICBjb25zdCBwcm9taXNlID0gaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtdHdlYWstc3RvcmVcIilcbiAgICAudGhlbigoc3RvcmUpID0+IHtcbiAgICAgIHN0YXRlLnR3ZWFrU3RvcmUgPSBzdG9yZSBhcyBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3O1xuICAgICAgcmV0dXJuIHN0YXRlLnR3ZWFrU3RvcmU7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIHN0YXRlLnR3ZWFrU3RvcmVFcnJvciA9IGU7XG4gICAgICB0aHJvdyBlO1xuICAgIH0pXG4gICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlID09PSBwcm9taXNlKSBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9IG51bGw7XG4gICAgfSk7XG4gIHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlID0gcHJvbWlzZTtcbiAgcmV0dXJuIHByb21pc2U7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrU3RvcmVHcmlkKGdyaWQ6IEhUTUxFbGVtZW50LCBzb3VyY2U6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHN0b3JlID0gcGFyc2VTdG9yZURhdGFzZXQoZ3JpZCk7XG4gIGlmICghc3RvcmUpIHJldHVybjtcbiAgY29uc3QgZW50cmllcyA9IHN0b3JlLmVudHJpZXM7XG4gIGdyaWQucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBzb3VyY2UudGV4dENvbnRlbnQgPSBgUmVmcmVzaGVkICR7bmV3IERhdGUoc3RvcmUuZmV0Y2hlZEF0KS50b0xvY2FsZVN0cmluZygpfWA7XG4gIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2Uob3V0ZGF0ZWRJbnN0YWxsZWRTdG9yZUNvdW50KGVudHJpZXMpKTtcbiAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGlmIChzdG9yZS5lbnRyaWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGdyaWQuYXBwZW5kQ2hpbGQoc3RvcmVNZXNzYWdlQ2FyZChcIk5vIHR3ZWFrcyB5ZXRcIiwgXCJVc2UgUHVibGlzaCBUd2VhayB0byBzdWJtaXQgdGhlIGZpcnN0IG9uZS5cIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIGVudHJpZXMpIGdyaWQuYXBwZW5kQ2hpbGQodHdlYWtTdG9yZUNhcmQoZW50cnkpKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VTdG9yZURhdGFzZXQoZ3JpZDogSFRNTEVsZW1lbnQpOiBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3IHwgbnVsbCB7XG4gIGNvbnN0IHJhdyA9IGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmU7XG4gIGlmICghcmF3KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXc7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVDYXJkKGVudHJ5OiBUd2Vha1N0b3JlRW50cnlWaWV3KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBzaGVsbCA9IHR3ZWFrU3RvcmVDYXJkU2hlbGwoKTtcbiAgY29uc3QgeyBjYXJkLCBsZWZ0LCBzdGFjaywgdmVyc2lvbnMsIGFjdGlvbnMgfSA9IHNoZWxsO1xuXG4gIGxlZnQuaW5zZXJ0QmVmb3JlKHN0b3JlQXZhdGFyKGVudHJ5KSwgc3RhY2spO1xuXG4gIGNvbnN0IHRpdGxlUm93ID0gdHdlYWtTdG9yZVRpdGxlUm93KCk7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtbGcgZm9udC1zZW1pYm9sZCBsZWFkaW5nLTcgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gZW50cnkubWFuaWZlc3QubmFtZTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJpZmllZFNhZmVCYWRnZSgpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuXG4gIGlmIChlbnRyeS5tYW5pZmVzdC5kZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGRlc2MgPSB0d2Vha1N0b3JlRGVzY3JpcHRpb24oKTtcbiAgICBkZXNjLnRleHRDb250ZW50ID0gZW50cnkubWFuaWZlc3QuZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIH1cblxuICBzdGFjay5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlUmVhZE1vcmVCdXR0b24oZW50cnkucmVwbyA/PyBlbnRyeS5tYW5pZmVzdC5naXRodWJSZXBvKSk7XG4gIHZlcnNpb25zLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVWZXJzaW9uQmFkZ2UoZW50cnkpKTtcblxuICBpZiAoZW50cnkucmVsZWFzZVVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGVudHJ5LnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICBjb25zdCBoYXNVcGRhdGUgPSAhIWVudHJ5Lmluc3RhbGxlZCAmJiBlbnRyeS5pbnN0YWxsZWQudmVyc2lvbiAhPT0gZW50cnkubWFuaWZlc3QudmVyc2lvbjtcbiAgaWYgKGVudHJ5LmF2YWlsYWJsZSA9PT0gZmFsc2UpIHtcbiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJvcGFjaXR5LTcwXCIpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiTm90IGF2YWlsYWJsZSB5ZXRcIikpO1xuICB9IGVsc2UgaWYgKGVudHJ5Lmluc3RhbGxlZCAmJiAhaGFzVXBkYXRlKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwoXCJJbnN0YWxsZWRcIikpO1xuICB9IGVsc2UgaWYgKGVudHJ5LnBsYXRmb3JtICYmICFlbnRyeS5wbGF0Zm9ybS5jb21wYXRpYmxlKSB7XG4gICAgY2FyZC5jbGFzc0xpc3QuYWRkKFwib3BhY2l0eS03MFwiKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChwbGF0Zm9ybUxvY2tlZExhYmVsKGVudHJ5LnBsYXRmb3JtKSkpO1xuICB9IGVsc2UgaWYgKGVudHJ5LnJ1bnRpbWUgJiYgIWVudHJ5LnJ1bnRpbWUuY29tcGF0aWJsZSkge1xuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcIm9wYWNpdHktNzBcIik7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwocnVudGltZUxvY2tlZExhYmVsKGVudHJ5LnJ1bnRpbWUpKSk7XG4gIH0gZWxzZSB7XG4gICAgY29uc3QgaW5zdGFsbExhYmVsID0gZW50cnkuaW5zdGFsbGVkID8gXCJVcGRhdGVcIiA6IFwiSW5zdGFsbFwiO1xuICAgIGlmIChoYXNVcGRhdGUpIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiVXBkYXRlIGF2YWlsYWJsZVwiLCBcImluZm9cIikpO1xuICAgIGNvbnN0IGluc3RhbGxCdXR0b24gPSBzdG9yZUluc3RhbGxCdXR0b24oaW5zdGFsbExhYmVsLCAoYnV0dG9uKSA9PiB7XG4gICAgICBjb25zdCBncmlkID0gY2FyZC5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlci1zdG9yZS1ncmlkXVwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBjb25zdCBzb3VyY2UgPSBncmlkPy5wYXJlbnRFbGVtZW50Py5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtdHdlYWtlci1zdG9yZS1zb3VyY2VdXCIpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIHNob3dTdG9yZUJ1dHRvbkxvYWRpbmcoYnV0dG9uLCBlbnRyeS5pbnN0YWxsZWQgPyBcIlVwZGF0aW5nXCIgOiBcIkluc3RhbGxpbmdcIik7XG4gICAgICBhY3Rpb25zLnF1ZXJ5U2VsZWN0b3JBbGwoXCJidXR0b25cIikuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gdHJ1ZSkpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjppbnN0YWxsLXN0b3JlLXR3ZWFrXCIsIGVudHJ5LmlkKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgc2hvd1N0b3JlVG9hc3QoYCR7ZW50cnkubWFuaWZlc3QubmFtZX0gaW5zdGFsbGVkLmApO1xuICAgICAgICAgIHNob3dTdG9yZUJ1dHRvbkluc3RhbGxlZChidXR0b24pO1xuICAgICAgICAgIHZlcnNpb25zLnJlcGxhY2VDaGlsZHJlbih0d2Vha1N0b3JlVmVyc2lvbkJhZGdlKGVudHJ5LCBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uKSk7XG4gICAgICAgICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShNYXRoLm1heCgwLCBjdXJyZW50U3RvcmVVcGRhdGVCYWRnZUNvdW50KCkgLSAxKSk7XG4gICAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgICAgICBhY3Rpb25zLnJlcGxhY2VDaGlsZHJlbihzdG9yZVN0YXR1c1BpbGwoXCJJbnN0YWxsZWRcIikpO1xuICAgICAgICAgICAgaWYgKGdyaWQgJiYgc291cmNlKSByZWZyZXNoVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlLCB1bmRlZmluZWQsIHRydWUpO1xuICAgICAgICAgIH0sIDkwMCk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgICAgIHJlc2V0U3RvcmVJbnN0YWxsQnV0dG9uKGJ1dHRvbiwgaW5zdGFsbExhYmVsKTtcbiAgICAgICAgICBhY3Rpb25zLnF1ZXJ5U2VsZWN0b3JBbGwoXCJidXR0b25cIikuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gZmFsc2UpKTtcbiAgICAgICAgICBzaG93U3RvcmVDYXJkTWVzc2FnZShjYXJkLCBTdHJpbmcoKGUgYXMgRXJyb3IpLm1lc3NhZ2UgPz8gZSkpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGluc3RhbGxCdXR0b24pO1xuICB9XG4gIHJldHVybiBjYXJkO1xufVxuXG5mdW5jdGlvbiBwbGF0Zm9ybUxvY2tlZExhYmVsKHBsYXRmb3JtOiBOb25OdWxsYWJsZTxUd2Vha1N0b3JlRW50cnlWaWV3W1wicGxhdGZvcm1cIl0+KTogc3RyaW5nIHtcbiAgY29uc3Qgc3VwcG9ydGVkID0gcGxhdGZvcm0uc3VwcG9ydGVkID8/IFtdO1xuICBpZiAoc3VwcG9ydGVkLmluY2x1ZGVzKFwid2luMzJcIikpIHJldHVybiBcIldpbmRvd3Mgb25seVwiO1xuICBpZiAoc3VwcG9ydGVkLmluY2x1ZGVzKFwiZGFyd2luXCIpKSByZXR1cm4gXCJtYWNPUyBvbmx5XCI7XG4gIGlmIChzdXBwb3J0ZWQuaW5jbHVkZXMoXCJsaW51eFwiKSkgcmV0dXJuIFwiTGludXggb25seVwiO1xuICByZXR1cm4gXCJVbmF2YWlsYWJsZVwiO1xufVxuXG5mdW5jdGlvbiBydW50aW1lTG9ja2VkTGFiZWwocnVudGltZTogTm9uTnVsbGFibGU8VHdlYWtTdG9yZUVudHJ5Vmlld1tcInJ1bnRpbWVcIl0+KTogc3RyaW5nIHtcbiAgcmV0dXJuIHJ1bnRpbWUucmVxdWlyZWQgPyBgUmVxdWlyZXMgVHdlYWtlcnMgJHtydW50aW1lLnJlcXVpcmVkfWAgOiBcIlJlcXVpcmVzIG5ld2VyIFR3ZWFrZXJzXCI7XG59XG5cbmZ1bmN0aW9uIHNob3dTdG9yZUNhcmRNZXNzYWdlKGNhcmQ6IEhUTUxFbGVtZW50LCBtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiW2RhdGEtdHdlYWtlci1zdG9yZS1jYXJkLW1lc3NhZ2VdXCIpPy5yZW1vdmUoKTtcbiAgY29uc3Qgbm90aWNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbm90aWNlLmRhdGFzZXQudHdlYWtlclN0b3JlQ2FyZE1lc3NhZ2UgPSBcInRydWVcIjtcbiAgbm90aWNlLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzUwIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0zIHB5LTIgdGV4dC1zbSBsZWFkaW5nLTUgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIG5vdGljZS50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gIGNvbnN0IGFjdGlvbnMgPSBjYXJkLmxhc3RFbGVtZW50Q2hpbGQ7XG4gIGlmIChhY3Rpb25zKSBjYXJkLmluc2VydEJlZm9yZShub3RpY2UsIGFjdGlvbnMpO1xuICBlbHNlIGNhcmQuYXBwZW5kQ2hpbGQobm90aWNlKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZUNhcmRTaGVsbCgpOiB7XG4gIGNhcmQ6IEhUTUxFbGVtZW50O1xuICBsZWZ0OiBIVE1MRWxlbWVudDtcbiAgc3RhY2s6IEhUTUxFbGVtZW50O1xuICB2ZXJzaW9uczogSFRNTEVsZW1lbnQ7XG4gIGFjdGlvbnM6IEhUTUxFbGVtZW50O1xufSB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyLzQwIGZsZXggbWluLWgtWzE5MHB4XSBmbGV4LWNvbCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcm91bmRlZC0yeGwgYm9yZGVyIHAtNCB0cmFuc2l0aW9uLWNvbG9ycyBob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzVcIjtcblxuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTJcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobGVmdCk7XG5cbiAgY29uc3QgZm9vdGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZm9vdGVyLmNsYXNzTmFtZSA9IFwibXQtYXV0byBmbGV4IG1pbi13LTAgZmxleC13cmFwIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTJcIjtcbiAgY29uc3QgdmVyc2lvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB2ZXJzaW9ucy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGZvb3Rlci5hcHBlbmRDaGlsZCh2ZXJzaW9ucyk7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgZm9vdGVyLmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuICBjYXJkLmFwcGVuZENoaWxkKGZvb3Rlcik7XG5cbiAgcmV0dXJuIHsgY2FyZCwgbGVmdCwgc3RhY2ssIHZlcnNpb25zLCBhY3Rpb25zIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVUaXRsZVJvdygpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQganVzdGlmeS1iZXR3ZWVuIGdhcC0zXCI7XG4gIHJldHVybiB0aXRsZVJvdztcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZURlc2NyaXB0aW9uKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgZGVzYyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2MuY2xhc3NOYW1lID0gXCJsaW5lLWNsYW1wLTMgbWluLXctMCB0ZXh0LXNtIGxlYWRpbmctNSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHJldHVybiBkZXNjO1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlUmVhZE1vcmVCdXR0b24ocmVwbzogc3RyaW5nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCByZWFkTW9yZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIHJlYWRNb3JlLnR5cGUgPSBcImJ1dHRvblwiO1xuICByZWFkTW9yZS5jbGFzc05hbWUgPVxuICAgIFwiaW5saW5lLWZsZXggdy1maXQgaXRlbXMtY2VudGVyIGdhcC0xIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LWxpbmstZm9yZWdyb3VuZCBob3Zlcjp1bmRlcmxpbmVcIjtcbiAgcmVhZE1vcmUuaW5uZXJIVE1MID1cbiAgICBgUmVhZCBNb3JlYCArXG4gICAgYDxzdmcgd2lkdGg9XCIxNFwiIGhlaWdodD1cIjE0XCIgdmlld0JveD1cIjAgMCAxNiAxNlwiIGZpbGw9XCJub25lXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNiAzLjVoNi41VjEwTTEyLjI1IDMuNzUgNCAxMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNDVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIHJlYWRNb3JlLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHtyZXBvfWApO1xuICB9KTtcbiAgcmV0dXJuIHJlYWRNb3JlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGdyaWQuc2V0QXR0cmlidXRlKFwiYXJpYS1idXN5XCIsIFwidHJ1ZVwiKTtcbiAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGdyaWQuYXBwZW5kQ2hpbGQodHdlYWtTdG9yZUdob3N0Q2FyZCgpKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZUdob3N0Q2FyZCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHsgY2FyZCwgbGVmdCwgc3RhY2ssIHZlcnNpb25zLCBhY3Rpb25zIH0gPSB0d2Vha1N0b3JlQ2FyZFNoZWxsKCk7XG4gIGNhcmQuY2xhc3NMaXN0LmFkZChcInBvaW50ZXItZXZlbnRzLW5vbmVcIik7XG4gIGNhcmQuc2V0QXR0cmlidXRlKFwiYXJpYS1oaWRkZW5cIiwgXCJ0cnVlXCIpO1xuXG4gIGxlZnQuaW5zZXJ0QmVmb3JlKHN0b3JlQXZhdGFyR2hvc3QoKSwgc3RhY2spO1xuXG4gIGNvbnN0IHRpdGxlUm93ID0gdHdlYWtTdG9yZVRpdGxlUm93KCk7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtbGcgZm9udC1zZW1pYm9sZCBsZWFkaW5nLTcgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIHRpdGxlLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJteS0xIGgtNSB3LTQ0IHJvdW5kZWQtbWRcIikpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcmlmaWVkU2FmZUdob3N0QmFkZ2UoKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcblxuICBjb25zdCBkZXNjID0gdHdlYWtTdG9yZURlc2NyaXB0aW9uKCk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTEgaC0zIHctZnVsbCByb3VuZGVkXCIpKTtcbiAgZGVzYy5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXQtMiBoLTMgdy0xMS8xMiByb3VuZGVkXCIpKTtcbiAgZGVzYy5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXQtMiBoLTMgdy03LzEyIHJvdW5kZWRcIikpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcblxuICBjb25zdCByZWFkTW9yZSA9IHR3ZWFrU3RvcmVSZWFkTW9yZUJ1dHRvbihcIlwiKTtcbiAgcmVhZE1vcmUucmVwbGFjZUNoaWxkcmVuKGdob3N0QmxvY2soXCJoLTUgdy0yNCByb3VuZGVkXCIpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQocmVhZE1vcmUpO1xuXG4gIHZlcnNpb25zLmFwcGVuZENoaWxkKHN0b3JlVmVyc2lvbkdob3N0QmFkZ2UoKSk7XG4gIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNHaG9zdFBpbGwoKSk7XG4gIHJldHVybiBjYXJkO1xufVxuXG5mdW5jdGlvbiBzdG9yZUF2YXRhckdob3N0KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtMTAgdy0xMCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXItZGVmYXVsdCBiZy10cmFuc3BhcmVudCB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJoLWZ1bGwgdy1mdWxsXCIpKTtcbiAgcmV0dXJuIGF2YXRhcjtcbn1cblxuZnVuY3Rpb24gdmVyaWZpZWRTYWZlR2hvc3RCYWRnZSgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gdmVyaWZpZWRTYWZlQmFkZ2UoKTtcbiAgYmFkZ2UucmVwbGFjZUNoaWxkcmVuKGdob3N0QmxvY2soXCJoLVsxM3B4XSB3LVsxM3B4XSByb3VuZGVkLXNtXCIpLCBnaG9zdEJsb2NrKFwiaC0zIHctMjAgcm91bmRlZFwiKSk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gc3RvcmVTdGF0dXNHaG9zdFBpbGwoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBwaWxsID0gc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpO1xuICBwaWxsLmNsYXNzTGlzdC5hZGQoXCJhbmltYXRlLXB1bHNlXCIpO1xuICBwaWxsLnN0eWxlLmNvbG9yID0gXCJ0cmFuc3BhcmVudFwiO1xuICByZXR1cm4gcGlsbDtcbn1cblxuZnVuY3Rpb24gc3RvcmVWZXJzaW9uR2hvc3RCYWRnZSgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gc3RvcmVWZXJzaW9uQmFkZ2VTaGVsbChmYWxzZSk7XG4gIGJhZGdlLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJoLTMgdy0zNiByb3VuZGVkXCIpKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBnaG9zdEJsb2NrKGNsYXNzTmFtZTogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBibG9jayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGJsb2NrLmNsYXNzTmFtZSA9IGBhbmltYXRlLXB1bHNlIGJnLXRva2VuLWZvcmVncm91bmQvMTAgJHtjbGFzc05hbWV9YDtcbiAgYmxvY2suc2V0QXR0cmlidXRlKFwiYXJpYS1oaWRkZW5cIiwgXCJ0cnVlXCIpO1xuICByZXR1cm4gYmxvY2s7XG59XG5cbmZ1bmN0aW9uIHN0b3JlQXZhdGFyKGVudHJ5OiBUd2Vha1N0b3JlRW50cnlWaWV3KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBhdmF0YXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC0xMCB3LTEwIHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci1kZWZhdWx0IGJnLXRyYW5zcGFyZW50IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBjb25zdCBpbml0aWFsID0gKGVudHJ5Lm1hbmlmZXN0Lm5hbWU/LlswXSA/PyBcIj9cIikudG9VcHBlckNhc2UoKTtcbiAgY29uc3QgZmFsbGJhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgZmFsbGJhY2sudGV4dENvbnRlbnQgPSBpbml0aWFsO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoZmFsbGJhY2spO1xuICBjb25zdCBpY29uVXJsID0gc3RvcmVFbnRyeUljb25VcmwoZW50cnkpO1xuICBpZiAoaWNvblVybCkge1xuICAgIGNvbnN0IGltZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gICAgaW1nLmFsdCA9IFwiXCI7XG4gICAgaW1nLmNsYXNzTmFtZSA9IFwiaC1mdWxsIHctZnVsbCBvYmplY3QtY292ZXJcIjtcbiAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgIGltZy5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCAoKSA9PiB7XG4gICAgICBmYWxsYmFjay5yZW1vdmUoKTtcbiAgICAgIGltZy5zdHlsZS5kaXNwbGF5ID0gXCJcIjtcbiAgICB9KTtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsICgpID0+IHtcbiAgICAgIGltZy5yZW1vdmUoKTtcbiAgICB9KTtcbiAgICBpbWcuc3JjID0gaWNvblVybDtcbiAgICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW1nKTtcbiAgfVxuICByZXR1cm4gYXZhdGFyO1xufVxuXG5mdW5jdGlvbiBzdG9yZUVudHJ5SWNvblVybChlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBpY29uVXJsID0gZW50cnkubWFuaWZlc3QuaWNvblVybD8udHJpbSgpO1xuICBpZiAoIWljb25VcmwpIHJldHVybiBudWxsO1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvaS50ZXN0KGljb25VcmwpKSByZXR1cm4gaWNvblVybDtcbiAgY29uc3QgcmVsID0gaWNvblVybC5yZXBsYWNlKC9eXFwuP1xcLy8sIFwiXCIpO1xuICBpZiAoIXJlbCB8fCByZWwuc3RhcnRzV2l0aChcIi4uL1wiKSkgcmV0dXJuIG51bGw7XG4gIGlmIChlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwiYnVuZGxlZFwiIHx8ICFlbnRyeS5yZXBvIHx8ICFlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiBgaHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tLyR7ZW50cnkucmVwb30vJHtlbnRyeS5hcHByb3ZlZENvbW1pdFNoYX0vJHtyZWx9YDtcbn1cblxuZnVuY3Rpb24gc2lkZWJhclVwZGF0ZVBpbGxCdXR0b24oKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LnR3ZWFrZXJTaWRlYmFyVXBkYXRlID0gXCJ0cnVlXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwidXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1mdWxsIGJnLXRva2VuLWNoYXJ0cy1ibHVlIHRleHQtd2hpdGUgaG92ZXI6YmctdG9rZW4tY2hhcnRzLWJsdWUvODBcIjtcbiAgT2JqZWN0LmFzc2lnbihidG4uc3R5bGUsIHtcbiAgICBkaXNwbGF5OiBcIm5vbmVcIixcbiAgICBoZWlnaHQ6IFwiMjBweFwiLFxuICAgIGJvcmRlclJhZGl1czogXCI5OTk5cHhcIixcbiAgICBib3JkZXI6IFwiMFwiLFxuICAgIHBhZGRpbmc6IFwiMCA4cHhcIixcbiAgICBmb250U2l6ZTogXCIxMHB4XCIsXG4gICAgZm9udFdlaWdodDogXCI3MDBcIixcbiAgICBsaW5lSGVpZ2h0OiBcIjIwcHhcIixcbiAgICBsZXR0ZXJTcGFjaW5nOiBcIjBcIixcbiAgICB0ZXh0VHJhbnNmb3JtOiBcIm5vbmVcIixcbiAgfSk7XG4gIGJ0bi50ZXh0Q29udGVudCA9IFwiVXBkYXRlXCI7XG4gIGJ0bi50aXRsZSA9IFwiT3BlbiBUd2Vha2VycyB1cGRhdGVcIjtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGJ0bi5kYXRhc2V0LnR3ZWFrZXJSZWxlYXNlVXJsIHx8IFRXRUFLRVJTX1JFTEVBU0VTX1VSTCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByZWZyZXNoU2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oZm9yY2UgPSBmYWxzZSk6IHZvaWQge1xuICBjb25zdCBidG4gPSBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uO1xuICBpZiAoIWJ0bikgcmV0dXJuO1xuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Y2hlY2stdHdlYWtlci11cGRhdGVcIiwgZm9yY2UpXG4gICAgLnRoZW4oKGNoZWNrKSA9PiBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjaGVjayBhcyBUd2Vha2VyVXBkYXRlQ2hlY2spKVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgcGxvZyhcIlR3ZWFrZXJzIHNpZGViYXIgcmVsZWFzZSBjaGVjayBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgICAgIHNldFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKG51bGwpO1xuICAgIH0pO1xufVxuXG5mdW5jdGlvbiBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjaGVjazogVHdlYWtlclVwZGF0ZUNoZWNrIHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCBidG4gPSBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uO1xuICBpZiAoIWJ0bikgcmV0dXJuO1xuICBjb25zdCB1cGRhdGVBdmFpbGFibGUgPSBjaGVjaz8udXBkYXRlQXZhaWxhYmxlID09PSB0cnVlO1xuICBidG4uc3R5bGUuZGlzcGxheSA9IHVwZGF0ZUF2YWlsYWJsZSA/IFwiaW5saW5lLWZsZXhcIiA6IFwibm9uZVwiO1xuICBidG4uaGlkZGVuID0gIXVwZGF0ZUF2YWlsYWJsZTtcbiAgYnRuLmRhdGFzZXQudHdlYWtlclJlbGVhc2VVcmwgPSBjaGVjaz8ucmVsZWFzZVVybCB8fCBUV0VBS0VSU19SRUxFQVNFU19VUkw7XG4gIGJ0bi50aXRsZSA9XG4gICAgdXBkYXRlQXZhaWxhYmxlICYmIGNoZWNrPy5sYXRlc3RWZXJzaW9uXG4gICAgICA/IGBPcGVuIFR3ZWFrZXJzICR7Y2hlY2subGF0ZXN0VmVyc2lvbn0gdXBkYXRlYFxuICAgICAgOiBcIk9wZW4gVHdlYWtlcnMgdXBkYXRlXCI7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UoY291bnQ6IG51bWJlciB8IG51bGwpOiB2b2lkIHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItc3RvcmUtdXBkYXRlLWJhZGdlXVwiKTtcbiAgaWYgKCFiYWRnZSkgcmV0dXJuO1xuICBiYWRnZS5kYXRhc2V0LnR3ZWFrZXJTdG9yZVVwZGF0ZUNvdW50ID0gY291bnQgPT09IG51bGwgPyBcIlwiIDogU3RyaW5nKGNvdW50KTtcbiAgYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2UsIGNvdW50KTtcbiAgYmFkZ2UuaGlkZGVuID0gY291bnQgPT09IG51bGwgfHwgY291bnQgPD0gMDtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBjb3VudCAmJiBjb3VudCA+IDAgPyBTdHJpbmcoY291bnQpIDogXCJcIjtcbiAgYmFkZ2UudGl0bGUgPVxuICAgIGNvdW50ICYmIGNvdW50ID4gMFxuICAgICAgPyBgJHtjb3VudH0gaW5zdGFsbGVkIHR3ZWFrJHtjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIn0gY2FuIGJlIHVwZGF0ZWRgXG4gICAgICA6IFwiSW5zdGFsbGVkIHR3ZWFrcyBhcmUgdXAgdG8gZGF0ZVwiO1xufVxuXG5mdW5jdGlvbiBhcHBseVN0b3JlVXBkYXRlQmFkZ2VTdHlsZShiYWRnZTogSFRNTEVsZW1lbnQsIGNvdW50OiBudW1iZXIgfCBudWxsKTogdm9pZCB7XG4gIGNvbnN0IGhhc1VwZGF0ZXMgPSAhIWNvdW50ICYmIGNvdW50ID4gMDtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcImJnLXRva2VuLWNoYXJ0cy1ibHVlXCIsIGhhc1VwZGF0ZXMpO1xuICBiYWRnZS5jbGFzc0xpc3QudG9nZ2xlKFwidGV4dC13aGl0ZVwiLCBoYXNVcGRhdGVzKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcImJnLXRyYW5zcGFyZW50XCIsICFoYXNVcGRhdGVzKTtcbiAgT2JqZWN0LmFzc2lnbihiYWRnZS5zdHlsZSwge1xuICAgIG1pbldpZHRoOiBcIjI0cHhcIixcbiAgICBoZWlnaHQ6IFwiMjBweFwiLFxuICAgIGJvcmRlclJhZGl1czogXCI5OTk5cHhcIixcbiAgICBib3JkZXI6IFwiMFwiLFxuICAgIHBhZGRpbmc6IFwiMCA3cHhcIixcbiAgICBmb250U2l6ZTogXCIxMnB4XCIsXG4gICAgZm9udFdlaWdodDogXCI3MDBcIixcbiAgICBsaW5lSGVpZ2h0OiBcIjIwcHhcIixcbiAgICBsZXR0ZXJTcGFjaW5nOiBcIjBcIixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGN1cnJlbnRTdG9yZVVwZGF0ZUJhZGdlQ291bnQoKTogbnVtYmVyIHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItc3RvcmUtdXBkYXRlLWJhZGdlXVwiKTtcbiAgY29uc3QgcmF3ID0gYmFkZ2U/LmRhdGFzZXQudHdlYWtlclN0b3JlVXBkYXRlQ291bnQ7XG4gIGNvbnN0IHBhcnNlZCA9IHJhdyA/IE51bWJlcihyYXcpIDogMDtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShwYXJzZWQpID8gcGFyc2VkIDogMDtcbn1cblxuZnVuY3Rpb24gb3V0ZGF0ZWRJbnN0YWxsZWRTdG9yZUNvdW50KGVudHJpZXM6IFR3ZWFrU3RvcmVFbnRyeVZpZXdbXSk6IG51bWJlciB7XG4gIHJldHVybiBlbnRyaWVzLmZpbHRlcigoZW50cnkpID0+ICEhZW50cnkuaW5zdGFsbGVkICYmIGVudHJ5Lmluc3RhbGxlZC52ZXJzaW9uICE9PSBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uKS5sZW5ndGg7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVG9vbGJhckJ1dHRvbihcbiAgbGFiZWw6IHN0cmluZyxcbiAgb25DbGljazogKCkgPT4gdm9pZCxcbiAgdmFyaWFudDogXCJwcmltYXJ5XCIgfCBcInNlY29uZGFyeVwiID0gXCJzZWNvbmRhcnlcIixcbik6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICB2YXJpYW50ID09PSBcInByaW1hcnlcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCBpdGVtcy1jZW50ZXIgZ2FwLTEgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1iZy1mb2cgcHgtMiBweS0wIHRleHQtc20gdGV4dC10b2tlbi1idXR0b24tdGVydGlhcnktZm9yZWdyb3VuZCBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MFwiXG4gICAgICA6IFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IGl0ZW1zLWNlbnRlciBnYXAtMSB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdHJhbnNwYXJlbnQgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMCB0ZXh0LXNtIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWZvcmVncm91bmQvMTAgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBzdG9yZUljb25CdXR0b24oXG4gIGljb25Tdmc6IHN0cmluZyxcbiAgbGFiZWw6IHN0cmluZyxcbiAgb25DbGljazogKCkgPT4gdm9pZCxcbik6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCB3LTggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10cmFuc3BhcmVudCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0wIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBlbmFibGVkOmhvdmVyOmJnLXRva2VuLWZvcmVncm91bmQvMTAgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLmlubmVySFRNTCA9IGljb25Tdmc7XG4gIGNvbnN0cmFpblNpZGViYXJJY29uU3ZnKGJ0bi5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpLCAxOCk7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgYnRuLnRpdGxlID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByZWZyZXNoSWNvblN2ZygpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMThcIiBoZWlnaHQ9XCIxOFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwiaWNvbi14c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQuNCA5LjM1QTUuNjUgNS42NSAwIDAgMSAxNCA1LjNMMTUuNzUgN00xNS43NSAzLjc1VjdoLTMuMjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTUuNiAxMC42NUE1LjY1IDUuNjUgMCAwIDEgNiAxNC43TDQuMjUgMTNNNC4yNSAxNi4yNVYxM0g3LjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gdmVyaWZpZWRTYWZlQmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPVxuICAgIFwiaW5saW5lLWZsZXggaC02IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMS41IHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIvMzAgYmctdHJhbnNwYXJlbnQgcHgtMiB0ZXh0LXhzIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBiYWRnZS5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTNcIiBoZWlnaHQ9XCIxM1wiIHZpZXdCb3g9XCIwIDAgMTQgMTRcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwidGV4dC1ibHVlLTUwMFwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMS43NSAxMS4yNSAzLjR2My4yYzAgMi42LTEuNjUgNC4yNS00LjI1IDUuNC0yLjYtMS4xNS00LjI1LTIuOC00LjI1LTUuNFYzLjRMNyAxLjc1WlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuMTVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk00Ljg1IDcuMDUgNi4zIDguNDVsMi44NS0zLjA1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS4yNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YCArXG4gICAgYDxzcGFuPlZlcmlmaWVkIGFzIHNhZmU8L3NwYW4+YDtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlVmVyc2lvbkJhZGdlKGVudHJ5OiBUd2Vha1N0b3JlRW50cnlWaWV3LCBpbnN0YWxsZWRPdmVycmlkZT86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaW5zdGFsbGVkID0gaW5zdGFsbGVkT3ZlcnJpZGUgPz8gZW50cnkuaW5zdGFsbGVkPy52ZXJzaW9uID8/IG51bGw7XG4gIGNvbnN0IGxhdGVzdCA9IGVudHJ5Lm1hbmlmZXN0LnZlcnNpb247XG4gIGNvbnN0IGhhc1VwZGF0ZSA9ICEhaW5zdGFsbGVkICYmIGluc3RhbGxlZCAhPT0gbGF0ZXN0O1xuICBjb25zdCBiYWRnZSA9IHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoaGFzVXBkYXRlKTtcbiAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgbGFiZWwuY2xhc3NOYW1lID0gXCJ0cnVuY2F0ZVwiO1xuICBsYWJlbC50ZXh0Q29udGVudCA9IGluc3RhbGxlZFxuICAgID8gYEluc3RhbGxlZCB2JHtpbnN0YWxsZWR9IFx1MDBCNyBMYXRlc3QgdiR7bGF0ZXN0fWBcbiAgICA6IGBMYXRlc3QgdiR7bGF0ZXN0fWA7XG4gIGJhZGdlLnRpdGxlID0gaW5zdGFsbGVkXG4gICAgPyBgSW5zdGFsbGVkIHZlcnNpb24gJHtpbnN0YWxsZWR9LiBMYXRlc3QgYXBwcm92ZWQgdmVyc2lvbiAke2xhdGVzdH0uYFxuICAgIDogYExhdGVzdCBhcHByb3ZlZCB2ZXJzaW9uICR7bGF0ZXN0fS5gO1xuICBiYWRnZS5hcHBlbmRDaGlsZChsYWJlbCk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gc3RvcmVWZXJzaW9uQmFkZ2VTaGVsbChoYXNVcGRhdGU6IGJvb2xlYW4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFtcbiAgICBcImlubGluZS1mbGV4IGgtOCBtaW4tdy0wIG1heC13LWZ1bGwgaXRlbXMtY2VudGVyIHJvdW5kZWQtbGcgYm9yZGVyIHB4LTIuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtXCIsXG4gICAgaGFzVXBkYXRlXG4gICAgICA/IFwiYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICA6IFwiYm9yZGVyLXRva2VuLWJvcmRlci80MCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCIsXG4gIF0uam9pbihcIiBcIik7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gc3RvcmVTdGF0dXNQaWxsKGxhYmVsOiBzdHJpbmcsIHRvbmU6IFwibmV1dHJhbFwiIHwgXCJpbmZvXCIgPSBcIm5ldXRyYWxcIik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBwaWxsLmNsYXNzTmFtZSA9IFtcbiAgICBcImlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBweC0zIHRleHQtc20gZm9udC1tZWRpdW1cIixcbiAgICB0b25lID09PSBcImluZm9cIlxuICAgICAgPyBcImJvcmRlciBib3JkZXItYmx1ZS01MDAvMzAgYmctYmx1ZS01MDAvMTAgdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCJcbiAgICAgIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzUgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCIsXG4gIF0uam9pbihcIiBcIik7XG4gIHBpbGwudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgcmV0dXJuIHBpbGw7XG59XG5cbmZ1bmN0aW9uIHN0b3JlSW5zdGFsbEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoYnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBzdG9yZUluc3RhbGxCdXR0b25DbGFzcygpO1xuICBidG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIG9uQ2xpY2soYnRuKTtcbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKGV4dHJhID0gXCJcIik6IHN0cmluZyB7XG4gIHJldHVybiBbXG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggbWluLXctWzgycHhdIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBnYXAtMS41IHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci1ibHVlLTUwMC80MCBiZy1ibHVlLTUwMCBweC0zIHB5LTAgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWZvcmVncm91bmQgc2hhZG93LXNtIHRyYW5zaXRpb24tY29sb3JzIGVuYWJsZWQ6aG92ZXI6YmctYmx1ZS02MDAgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktODBcIixcbiAgICBleHRyYSxcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG59XG5cbmZ1bmN0aW9uIHNob3dTdG9yZUJ1dHRvbkxvYWRpbmcoYnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBidXR0b24uY2xhc3NOYW1lID0gc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoKTtcbiAgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtYnVzeVwiLCBcInRydWVcIik7XG4gIGJ1dHRvbi5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIGNsYXNzPVwiYW5pbWF0ZS1zcGluXCIgd2lkdGg9XCIxNFwiIGhlaWdodD1cIjE0XCIgdmlld0JveD1cIjAgMCAxNiAxNlwiIGZpbGw9XCJub25lXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI4XCIgY3k9XCI4XCIgcj1cIjUuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBvcGFjaXR5PVwiLjI1XCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTEzLjUgOEE1LjUgNS41IDAgMCAwIDggMi41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMlwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmAgK1xuICAgIGA8c3Bhbj4ke2xhYmVsfTwvc3Bhbj5gO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVCdXR0b25JbnN0YWxsZWQoYnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCk6IHZvaWQge1xuICBidXR0b24uY2xhc3NOYW1lID0gc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoXCJib3JkZXItYmx1ZS01MDAgYmctYmx1ZS01MDBcIik7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIik7XG4gIGJ1dHRvbi5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTMuNzUgOC4xNSA2LjY1IDExIDEyLjI1IDVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjhcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmAgK1xuICAgIGA8c3Bhbj5JbnN0YWxsZWQ8L3NwYW4+YDtcbn1cblxuZnVuY3Rpb24gcmVzZXRTdG9yZUluc3RhbGxCdXR0b24oYnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBidXR0b24uY2xhc3NOYW1lID0gc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoKTtcbiAgYnV0dG9uLmRpc2FibGVkID0gZmFsc2U7XG4gIGJ1dHRvbi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIik7XG4gIGJ1dHRvbi50ZXh0Q29udGVudCA9IGxhYmVsO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVUb2FzdChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgbGV0IGhvc3QgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItc3RvcmUtdG9hc3QtaG9zdF1cIik7XG4gIGlmICghaG9zdCkge1xuICAgIGhvc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGhvc3QuZGF0YXNldC50d2Vha2VyU3RvcmVUb2FzdEhvc3QgPSBcInRydWVcIjtcbiAgICBob3N0LmNsYXNzTmFtZSA9IFwicG9pbnRlci1ldmVudHMtbm9uZSBmaXhlZCBib3R0b20tNSByaWdodC01IHotWzk5OTldIGZsZXggZmxleC1jb2wgaXRlbXMtZW5kIGdhcC0yXCI7XG4gICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChob3N0KTtcbiAgfVxuICBjb25zdCB0b2FzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvYXN0LmNsYXNzTmFtZSA9XG4gICAgXCJ0cmFuc2xhdGUteS0yIHJvdW5kZWQteGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIvNTAgYmctdG9rZW4tbWFpbi1zdXJmYWNlLXByaW1hcnkgcHgtMyBweS0yIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi1mb3JlZ3JvdW5kIG9wYWNpdHktMCBzaGFkb3ctbGcgdHJhbnNpdGlvbi1hbGwgZHVyYXRpb24tMjAwXCI7XG4gIHRvYXN0LnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgaG9zdC5hcHBlbmRDaGlsZCh0b2FzdCk7XG4gIHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgdG9hc3QuY2xhc3NMaXN0LnJlbW92ZShcInRyYW5zbGF0ZS15LTJcIiwgXCJvcGFjaXR5LTBcIik7XG4gIH0pO1xuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICB0b2FzdC5jbGFzc0xpc3QuYWRkKFwidHJhbnNsYXRlLXktMlwiLCBcIm9wYWNpdHktMFwiKTtcbiAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRvYXN0LnJlbW92ZSgpO1xuICAgICAgaWYgKGhvc3QgJiYgaG9zdC5jaGlsZEVsZW1lbnRDb3VudCA9PT0gMCkgaG9zdC5yZW1vdmUoKTtcbiAgICB9LCAyMjApO1xuICB9LCAyNjAwKTtcbn1cblxuZnVuY3Rpb24gc3RvcmVNZXNzYWdlQ2FyZCh0aXRsZTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNhcmQuY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIvNDAgZmxleCBtaW4taC1bODRweF0gZmxleC1jb2wganVzdGlmeS1jZW50ZXIgZ2FwLTEgcm91bmRlZC0yeGwgYm9yZGVyIHAtNCB0ZXh0LXNtXCI7XG4gIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0LmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBjYXJkLmFwcGVuZENoaWxkKHQpO1xuICBpZiAoZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBjYXJkLmFwcGVuZENoaWxkKGQpO1xuICB9XG4gIHJldHVybiBjYXJkO1xufVxuXG5mdW5jdGlvbiBzaG9ydFNoYSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlLnNsaWNlKDAsIDcpO1xufVxuXG50eXBlIEFjdGlvbk1lbnVJdGVtID0geyBsYWJlbDogc3RyaW5nOyBvblNlbGVjdDogKCkgPT4gdm9pZCB9O1xuXG5mdW5jdGlvbiByZW5kZXJUd2Vha3NQYWdlKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbnNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdzU2VjdGlvbltdPigpO1xuICBmb3IgKGNvbnN0IHNlY3Rpb24gb2Ygc3RhdGUuc2VjdGlvbnMudmFsdWVzKCkpIHtcbiAgICBjb25zdCB0d2Vha0lkID0gc2VjdGlvbi5pZC5zcGxpdChcIjpcIilbMF07XG4gICAgaWYgKCFzZWN0aW9uc0J5VHdlYWsuaGFzKHR3ZWFrSWQpKSBzZWN0aW9uc0J5VHdlYWsuc2V0KHR3ZWFrSWQsIFtdKTtcbiAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrSWQpIS5wdXNoKHNlY3Rpb24pO1xuICB9XG5cbiAgY29uc3QgcGFnZXNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlW10+KCk7XG4gIGZvciAoY29uc3QgcGFnZSBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIGlmICghcGFnZXNCeVR3ZWFrLmhhcyhwYWdlLnR3ZWFrSWQpKSBwYWdlc0J5VHdlYWsuc2V0KHBhZ2UudHdlYWtJZCwgW10pO1xuICAgIHBhZ2VzQnlUd2Vhay5nZXQocGFnZS50d2Vha0lkKSEucHVzaChwYWdlKTtcbiAgfVxuXG4gIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgd3JhcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTNcIjtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHdyYXApO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICB3cmFwLmFwcGVuZENoaWxkKHRvb2xiYXIpO1xuXG4gIGNvbnN0IHRhYnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0YWJzLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJ0YWJsaXN0XCIpO1xuICB0YWJzLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJGaWx0ZXIgdHdlYWtzXCIpO1xuICB0YWJzLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtMVwiO1xuICB0b29sYmFyLmFwcGVuZENoaWxkKHRhYnMpO1xuXG4gIGNvbnN0IHRvb2xiYXJBY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhckFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWVuZCBnYXAtMlwiO1xuICB0b29sYmFyLmFwcGVuZENoaWxkKHRvb2xiYXJBY3Rpb25zKTtcblxuICBjb25zdCBzZWFyY2ggPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzZWFyY2guY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b2tlbi1idXR0b24tY29tcG9zZXIgdy01NiBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtMiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4taW5wdXQtYm9yZGVyIGJnLXRva2VuLWlucHV0LWJhY2tncm91bmQvNzUgcHgtMi41IHRleHQtYmFzZSBzaGFkb3ctc21cIjtcbiAgc2VhcmNoLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNlwiIGhlaWdodD1cIjE2XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJpY29uLXNtIHNocmluay0wIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjlcIiBjeT1cIjlcIiByPVwiNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiLz5gICtcbiAgICBgPHBhdGggZD1cIm0xMyAxMyAzLjUgMy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YDtcbiAgY29uc3Qgc2VhcmNoTGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGFiZWxcIik7XG4gIHNlYXJjaExhYmVsLmNsYXNzTmFtZSA9IFwic3Itb25seVwiO1xuICBzZWFyY2hMYWJlbC5odG1sRm9yID0gXCJ0d2Vha2VyLXR3ZWFrcy1zZWFyY2hcIjtcbiAgc2VhcmNoTGFiZWwudGV4dENvbnRlbnQgPSBcIlNlYXJjaCB0d2Vha3NcIjtcbiAgY29uc3Qgc2VhcmNoSW5wdXQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW5wdXRcIik7XG4gIHNlYXJjaElucHV0LmlkID0gXCJ0d2Vha2VyLXR3ZWFrcy1zZWFyY2hcIjtcbiAgc2VhcmNoSW5wdXQudHlwZSA9IFwic2VhcmNoXCI7XG4gIHNlYXJjaElucHV0LnBsYWNlaG9sZGVyID0gXCJTZWFyY2ggdHdlYWtzXCI7XG4gIHNlYXJjaElucHV0LnZhbHVlID0gc3RhdGUudHdlYWtzUGFnZVF1ZXJ5O1xuICBzZWFyY2hJbnB1dC5jbGFzc05hbWUgPVxuICAgIFwibWluLXctMCBmbGV4LTEgYmctdHJhbnNwYXJlbnQgdGV4dC1iYXNlIHRleHQtdG9rZW4taW5wdXQtZm9yZWdyb3VuZCBvdXRsaW5lLW5vbmUgcGxhY2Vob2xkZXI6dGV4dC10b2tlbi1pbnB1dC1wbGFjZWhvbGRlci1mb3JlZ3JvdW5kXCI7XG4gIGNvbnN0IGNsZWFyU2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY2xlYXJTZWFyY2gudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGNsZWFyU2VhcmNoLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJDbGVhciBzZWFyY2hcIik7XG4gIGNsZWFyU2VhcmNoLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBjdXJzb3ItaW50ZXJhY3Rpb24gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3Zlcjp0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgY2xlYXJTZWFyY2guaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE2XCIgaGVpZ2h0PVwiMTZcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cImljb24tc21cIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIm02IDYgOCA4TTE0IDZsLTggOFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNsZWFyU2VhcmNoLmhpZGRlbiA9IHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeS5sZW5ndGggPT09IDA7XG4gIHNlYXJjaC5hcHBlbmQoc2VhcmNoTGFiZWwsIHNlYXJjaElucHV0LCBjbGVhclNlYXJjaCk7XG4gIHRvb2xiYXJBY3Rpb25zLmFwcGVuZENoaWxkKHNlYXJjaCk7XG5cbiAgY29uc3QgZ2xvYmFsTWVudSA9IGFjdGlvbk1lbnVCdXR0b24oXCJNb3JlIHR3ZWFrIGFjdGlvbnNcIiwgW1xuICAgIHtcbiAgICAgIGxhYmVsOiBcIkZvcmNlIFJlbG9hZFwiLFxuICAgICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAgIC5pbnZva2UoXCJ0d2Vha2VyOnJlbG9hZC10d2Vha3NcIilcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJmb3JjZSByZWxvYWQgKG1haW4pIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IGxvY2F0aW9uLnJlbG9hZCgpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBsYWJlbDogXCJPcGVuIFR3ZWFrcyBGb2xkZXJcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXZlYWxcIiwgdHdlYWtzUGF0aCgpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXSk7XG4gIHRvb2xiYXJBY3Rpb25zLmFwcGVuZENoaWxkKGdsb2JhbE1lbnUuZWxlbWVudCk7XG5cbiAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxpc3QuaWQgPSBcInR3ZWFrZXItdHdlYWtzLWxpc3RcIjtcbiAgbGlzdC5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwidGFicGFuZWxcIik7XG4gIGxpc3QuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHdyYXAuYXBwZW5kQ2hpbGQobGlzdCk7XG5cbiAgbGV0IHJvd0NsZWFudXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICBjb25zdCByZW5kZXJMaXN0ID0gKCk6IHZvaWQgPT4ge1xuICAgIGZvciAoY29uc3QgY2xlYW51cCBvZiByb3dDbGVhbnVwcykgY2xlYW51cCgpO1xuICAgIHJvd0NsZWFudXBzID0gW107XG5cbiAgICBjb25zdCBjb3VudHMgPSB0d2Vha3NQYWdlQ291bnRzKHN0YXRlLmxpc3RlZFR3ZWFrcyk7XG4gICAgdGFicy5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBmb3IgKGNvbnN0IGZpbHRlciBvZiBUV0VBS1NfUEFHRV9GSUxURVJTKSB7XG4gICAgICBjb25zdCBzZWxlY3RlZCA9IHN0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXIgPT09IGZpbHRlcjtcbiAgICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBidXR0b24udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBidXR0b24uaWQgPSBgdHdlYWtlci10d2Vha3MtZmlsdGVyLSR7ZmlsdGVyfWA7XG4gICAgICBidXR0b24uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInRhYlwiKTtcbiAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWNvbnRyb2xzXCIsIGxpc3QuaWQpO1xuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIiwgU3RyaW5nKHNlbGVjdGVkKSk7XG4gICAgICBidXR0b24uY2xhc3NOYW1lID0gW1xuICAgICAgICBcImlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSByb3VuZGVkLWxnIHB4LTIuNSB0ZXh0LXNtIGN1cnNvci1pbnRlcmFjdGlvblwiLFxuICAgICAgICBzZWxlY3RlZFxuICAgICAgICAgID8gXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9udC1tZWRpdW0gdGV4dC10b2tlbi1mb3JlZ3JvdW5kXCJcbiAgICAgICAgICA6IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIsXG4gICAgICBdLmpvaW4oXCIgXCIpO1xuICAgICAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGxhYmVsLnRleHRDb250ZW50ID0gdHdlYWtzUGFnZUZpbHRlckxhYmVsKGZpbHRlcik7XG4gICAgICBjb25zdCBjb3VudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgICAgY291bnQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWlucHV0LXBsYWNlaG9sZGVyLWZvcmVncm91bmQgdGFidWxhci1udW1zXCI7XG4gICAgICBjb3VudC50ZXh0Q29udGVudCA9IFN0cmluZyhjb3VudHNbZmlsdGVyXSk7XG4gICAgICBidXR0b24uYXBwZW5kKGxhYmVsLCBjb3VudCk7XG4gICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgICAgc3RhdGUudHdlYWtzUGFnZUZpbHRlciA9IGZpbHRlcjtcbiAgICAgICAgcmVuZGVyTGlzdCgpO1xuICAgICAgfSk7XG4gICAgICB0YWJzLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gICAgfVxuICAgIGxpc3Quc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbGxlZGJ5XCIsIGB0d2Vha2VyLXR3ZWFrcy1maWx0ZXItJHtzdGF0ZS50d2Vha3NQYWdlRmlsdGVyfWApO1xuXG4gICAgY29uc3QgdmlzaWJsZSA9IGZpbHRlclR3ZWFrc1BhZ2VJdGVtcyhcbiAgICAgIHN0YXRlLmxpc3RlZFR3ZWFrcyxcbiAgICAgIHN0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXIsXG4gICAgICBzdGF0ZS50d2Vha3NQYWdlUXVlcnksXG4gICAgKTtcbiAgICBsaXN0LnJlcGxhY2VDaGlsZHJlbigpO1xuICAgIGlmICh2aXNpYmxlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgZW1wdHkuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi1oLTI4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBweS04IHRleHQtY2VudGVyIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICAgICAgZW1wdHkudGV4dENvbnRlbnQgPSBzdGF0ZS5saXN0ZWRUd2Vha3MubGVuZ3RoID09PSAwXG4gICAgICAgID8gYE5vIGNhdGFsb2cgZW50cmllcyBhdmFpbGFibGUuIERyb3AgYSB0d2VhayBmb2xkZXIgaW50byAke3R3ZWFrc1BhdGgoKX0gYW5kIHJlbG9hZC5gXG4gICAgICAgIDogXCJObyB0d2Vha3MgbWF0Y2ggdGhpcyBzZWFyY2ggYW5kIGZpbHRlci5cIjtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgdHdlYWsgb2YgdmlzaWJsZSkge1xuICAgICAgbGlzdC5hcHBlbmRDaGlsZCh0d2Vha1JvdyhcbiAgICAgICAgdHdlYWssXG4gICAgICAgIHNlY3Rpb25zQnlUd2Vhay5nZXQodHdlYWsubWFuaWZlc3QuaWQpID8/IFtdLFxuICAgICAgICBwYWdlc0J5VHdlYWsuZ2V0KHR3ZWFrLm1hbmlmZXN0LmlkKSA/PyBbXSxcbiAgICAgICAgKGNsZWFudXApID0+IHJvd0NsZWFudXBzLnB1c2goY2xlYW51cCksXG4gICAgICApKTtcbiAgICB9XG4gIH07XG5cbiAgc2VhcmNoSW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBzdGF0ZS50d2Vha3NQYWdlUXVlcnkgPSBzZWFyY2hJbnB1dC52YWx1ZTtcbiAgICBjbGVhclNlYXJjaC5oaWRkZW4gPSBzZWFyY2hJbnB1dC52YWx1ZS5sZW5ndGggPT09IDA7XG4gICAgcmVuZGVyTGlzdCgpO1xuICB9KTtcbiAgY2xlYXJTZWFyY2guYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBzdGF0ZS50d2Vha3NQYWdlUXVlcnkgPSBcIlwiO1xuICAgIHNlYXJjaElucHV0LnZhbHVlID0gXCJcIjtcbiAgICBjbGVhclNlYXJjaC5oaWRkZW4gPSB0cnVlO1xuICAgIHJlbmRlckxpc3QoKTtcbiAgICBzZWFyY2hJbnB1dC5mb2N1cygpO1xuICB9KTtcblxuICByZW5kZXJMaXN0KCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgZ2xvYmFsTWVudS5kaXNwb3NlKCk7XG4gICAgZm9yIChjb25zdCBjbGVhbnVwIG9mIHJvd0NsZWFudXBzKSBjbGVhbnVwKCk7XG4gICAgcm93Q2xlYW51cHMgPSBbXTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzUGFnZUZpbHRlckxhYmVsKGZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcik6IHN0cmluZyB7XG4gIGlmIChmaWx0ZXIgPT09IFwiYWxsXCIpIHJldHVybiBcIkFsbFwiO1xuICBpZiAoZmlsdGVyID09PSBcImVuYWJsZWRcIikgcmV0dXJuIFwiRW5hYmxlZFwiO1xuICBpZiAoZmlsdGVyID09PSBcImRpc2FibGVkXCIpIHJldHVybiBcIkRpc2FibGVkXCI7XG4gIHJldHVybiBcIlVwZGF0ZXNcIjtcbn1cblxuZnVuY3Rpb24gdHdlYWtSb3coXG4gIHR3ZWFrOiBMaXN0ZWRUd2VhayxcbiAgc2VjdGlvbnM6IFNldHRpbmdzU2VjdGlvbltdLFxuICBwYWdlczogUmVnaXN0ZXJlZFBhZ2VbXSxcbiAgcmVnaXN0ZXJDbGVhbnVwOiAoY2xlYW51cDogKCkgPT4gdm9pZCkgPT4gdm9pZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgbWFuaWZlc3QgPSB0d2Vhay5tYW5pZmVzdDtcbiAgY29uc3QgY2VsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNlbGwuY2xhc3NOYW1lID0gW1xuICAgIFwiZ3JvdXAgZmxleCBmbGV4LWNvbCBvdmVyZmxvdy12aXNpYmxlIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIvNDAgYmctdG9rZW4tZm9yZWdyb3VuZC81IHRyYW5zaXRpb24tY29sb3JzIGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLFxuICAgICF0d2Vhay5pbnN0YWxsZWQgfHwgdHdlYWsuc3RhdHVzID09PSBcImRpc2FibGVkXCIgPyBcIm9wYWNpdHktNjBcIiA6IFwiXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xuXG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPSBcImZsZXggbWluLWgtWzY0cHhdIGl0ZW1zLWNlbnRlciBnYXAtMyBwLTIuNVwiO1xuICBjZWxsLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgY29uc3QgY2FuQ29uZmlndXJlID0gdHdlYWsuaW5zdGFsbGVkICYmIHR3ZWFrLmVuYWJsZWQgJiYgcGFnZXMubGVuZ3RoID4gMDtcbiAgY29uc3QgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoY2FuQ29uZmlndXJlID8gXCJidXR0b25cIiA6IFwiZGl2XCIpO1xuICBjb250ZW50LmNsYXNzTmFtZSA9IFtcbiAgICBcImZsZXggbWluLXctMCBmbGV4LTEgaXRlbXMtY2VudGVyIGdhcC0zIHRleHQtbGVmdFwiLFxuICAgIGNhbkNvbmZpZ3VyZVxuICAgICAgPyBcImN1cnNvci1pbnRlcmFjdGlvbiByb3VuZGVkLWxnIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIlxuICAgICAgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcbiAgaWYgKGNvbnRlbnQgaW5zdGFuY2VvZiBIVE1MQnV0dG9uRWxlbWVudCkge1xuICAgIGNvbnRlbnQudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgY29udGVudC50aXRsZSA9IHBhZ2VzLmxlbmd0aCA9PT0gMVxuICAgICAgPyBgT3BlbiAke3BhZ2VzWzBdIS5wYWdlLnRpdGxlfWBcbiAgICAgIDogYE9wZW4gJHtwYWdlcy5tYXAoKHBhZ2UpID0+IHBhZ2UucGFnZS50aXRsZSkuam9pbihcIiwgXCIpfWA7XG4gICAgY29udGVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJyZWdpc3RlcmVkXCIsIGlkOiBtYW5pZmVzdC5pZCB9KTtcbiAgICB9KTtcbiAgfVxuICBjb250ZW50LmFwcGVuZENoaWxkKHR3ZWFrQXZhdGFyKHR3ZWFrKSk7XG5cbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTAuNVwiO1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBuYW1lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmFtZS5jbGFzc05hbWUgPSBcIm1pbi13LTAgdHJ1bmNhdGUgdGV4dC1zbSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBuYW1lLnRleHRDb250ZW50ID0gbWFuaWZlc3QubmFtZTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQobmFtZSk7XG4gIGNvbnN0IHZlcnNpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgdmVyc2lvbi5jbGFzc05hbWUgPSBcInNocmluay0wIHRleHQteHMgZm9udC1ub3JtYWwgdGFidWxhci1udW1zIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgdmVyc2lvbi50ZXh0Q29udGVudCA9IGB2JHttYW5pZmVzdC52ZXJzaW9ufWA7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHZlcnNpb24pO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0d2Vha1N0YXR1c1BpbGwodHdlYWspKTtcbiAgaWYgKHR3ZWFrLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlKSB7XG4gICAgY29uc3QgdXBkYXRlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgdXBkYXRlLmNsYXNzTmFtZSA9XG4gICAgICBcInNocmluay0wIHJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHB4LTIgcHktMC41IHRleHQtWzExcHhdIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdXBkYXRlLnRleHRDb250ZW50ID0gXCJVcGRhdGUgQXZhaWxhYmxlXCI7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodXBkYXRlKTtcbiAgfVxuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG4gIGlmIChtYW5pZmVzdC5kZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBkZXNjcmlwdGlvbi5jbGFzc05hbWUgPSBcImxpbmUtY2xhbXAtMSBtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICAgIGRlc2NyaXB0aW9uLnRleHRDb250ZW50ID0gbWFuaWZlc3QuZGVzY3JpcHRpb247XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzY3JpcHRpb24pO1xuICB9XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQoY29udGVudCk7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCBhdXRob3IgPSB0d2Vha0F1dGhvck5hbWUobWFuaWZlc3QuYXV0aG9yKTtcbiAgaWYgKGF1dGhvcikge1xuICAgIGNvbnN0IGF1dGhvckxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBhdXRob3JMYWJlbC5jbGFzc05hbWUgPSBcImhpZGRlbiB3LTI4IHRydW5jYXRlIHRleHQtcmlnaHQgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1kOmJsb2NrXCI7XG4gICAgYXV0aG9yTGFiZWwudGV4dENvbnRlbnQgPSBhdXRob3I7XG4gICAgYXV0aG9yTGFiZWwudGl0bGUgPSBhdXRob3I7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChhdXRob3JMYWJlbCk7XG4gIH1cblxuICBjb25zdCByb3dNZW51SXRlbXM6IEFjdGlvbk1lbnVJdGVtW10gPSBbXTtcbiAgaWYgKGNhbkNvbmZpZ3VyZSkge1xuICAgIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIkNvbmZpZ3VyZVwiLFxuICAgICAgb25TZWxlY3Q6ICgpID0+IGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogbWFuaWZlc3QuaWQgfSksXG4gICAgfSk7XG4gIH1cbiAgaWYgKHR3ZWFrLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlICYmIHR3ZWFrLnVwZGF0ZS5yZWxlYXNlVXJsKSB7XG4gICAgcm93TWVudUl0ZW1zLnB1c2goe1xuICAgICAgbGFiZWw6IFwiUmV2aWV3IFJlbGVhc2VcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHR3ZWFrLnVwZGF0ZSEucmVsZWFzZVVybCk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICBsYWJlbDogXCJPcGVuIFJlcG9zaXRvcnlcIixcbiAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm9wZW4tZXh0ZXJuYWxcIiwgYGh0dHBzOi8vZ2l0aHViLmNvbS8ke21hbmlmZXN0LmdpdGh1YlJlcG99YCk7XG4gICAgfSxcbiAgfSk7XG4gIGlmIChtYW5pZmVzdC5ob21lcGFnZSAmJiBtYW5pZmVzdC5ob21lcGFnZSAhPT0gYGh0dHBzOi8vZ2l0aHViLmNvbS8ke21hbmlmZXN0LmdpdGh1YlJlcG99YCkge1xuICAgIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIk9wZW4gSG9tZXBhZ2VcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIG1hbmlmZXN0LmhvbWVwYWdlKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH1cbiAgY29uc3Qgcm93TWVudSA9IGFjdGlvbk1lbnVCdXR0b24oYE1vcmUgYWN0aW9ucyBmb3IgJHttYW5pZmVzdC5uYW1lfWAsIHJvd01lbnVJdGVtcyk7XG4gIHJvd01lbnUuZWxlbWVudC5jbGFzc0xpc3QuYWRkKFxuICAgIFwiaW52aXNpYmxlXCIsXG4gICAgXCJvcGFjaXR5LTBcIixcbiAgICBcImdyb3VwLWZvY3VzLXdpdGhpbjp2aXNpYmxlXCIsXG4gICAgXCJncm91cC1mb2N1cy13aXRoaW46b3BhY2l0eS0xMDBcIixcbiAgICBcImdyb3VwLWhvdmVyOnZpc2libGVcIixcbiAgICBcImdyb3VwLWhvdmVyOm9wYWNpdHktMTAwXCIsXG4gICk7XG4gIHJlZ2lzdGVyQ2xlYW51cChyb3dNZW51LmRpc3Bvc2UpO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHJvd01lbnUuZWxlbWVudCk7XG5cbiAgaWYgKCF0d2Vhay5pbnN0YWxsZWQpIHtcbiAgICBpZiAodHdlYWsuY2F0YWxvZz8uYXZhaWxhYmxlID09PSBmYWxzZSkge1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwoXCJOb3QgaW5zdGFsbGVkXCIpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiSW5zdGFsbFwiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjppbnN0YWxsLXN0b3JlLXR3ZWFrXCIsIG1hbmlmZXN0LmlkKVxuICAgICAgICAgIC50aGVuKCgpID0+IGxvY2F0aW9uLnJlbG9hZCgpKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNhdGFsb2cgaW5zdGFsbCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgICB9KSk7XG4gICAgfVxuICB9IGVsc2UgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiKSB7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVjb3ZlclwiLCAoKSA9PiB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmVjb3Zlci10d2Vha1wiLCBtYW5pZmVzdC5pZClcbiAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwidHdlYWsgcmVjb3ZlcnkgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAodHdlYWsuc3RhdHVzID09PSBcImZhaWxlZFwiKSB7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZXRyeVwiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjbGVhci10d2Vhay1oZWFsdGhcIiwgbWFuaWZlc3QuaWQpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiY2xlYXIgdHdlYWsgaGVhbHRoIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlbG9hZC10d2Vha3NcIilcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJ0d2VhayByZXRyeSBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgICB9KSk7XG4gICAgfVxuICAgIGNvbnN0IHRvZ2dsZSA9IHN3aXRjaENvbnRyb2wodHdlYWsuZW5hYmxlZCwgYXN5bmMgKG5leHQpID0+IHtcbiAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c2V0LXR3ZWFrLWVuYWJsZWRcIiwgbWFuaWZlc3QuaWQsIG5leHQpO1xuICAgIH0pO1xuICAgIHRvZ2dsZS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGAke3R3ZWFrLmVuYWJsZWQgPyBcIkRpc2FibGVcIiA6IFwiRW5hYmxlXCJ9ICR7bWFuaWZlc3QubmFtZX1gKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHRvZ2dsZSk7XG4gIH1cbiAgaGVhZGVyLmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuXG4gIC8vIFByZXNlcnZlIHRoZSBsZWdhY3kgU2V0dGluZ3NTZWN0aW9uIGNvbnRyYWN0OiByZWdpc3RlcmVkIHNlY3Rpb25zIHN0aWxsXG4gIC8vIHJlbmRlciBkaXJlY3RseSBiZW5lYXRoIHRoZWlyIG93bmluZyB0d2VhayByb3cuXG4gIGlmICh0d2Vhay5pbnN0YWxsZWQgJiYgdHdlYWsuZW5hYmxlZCAmJiBzZWN0aW9ucy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgbmVzdGVkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBuZXN0ZWQuY2xhc3NOYW1lID1cbiAgICAgIFwiZmxleCBmbGV4LWNvbCBkaXZpZGUteS1bMC41cHhdIGRpdmlkZS10b2tlbi1ib3JkZXIgYm9yZGVyLXQtWzAuNXB4XSBib3JkZXItdG9rZW4tYm9yZGVyXCI7XG4gICAgZm9yIChjb25zdCBzZWN0aW9uIG9mIHNlY3Rpb25zKSB7XG4gICAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGJvZHkuY2xhc3NOYW1lID0gXCJwLTNcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNlY3Rpb24ucmVuZGVyKGJvZHkpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zIHRleHQtc20gdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gICAgICAgIGJvZHkudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHR3ZWFrIHNlY3Rpb246ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgIH1cbiAgICAgIG5lc3RlZC5hcHBlbmRDaGlsZChib2R5KTtcbiAgICB9XG4gICAgY2VsbC5hcHBlbmRDaGlsZChuZXN0ZWQpO1xuICB9XG5cbiAgcmV0dXJuIGNlbGw7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrQXZhdGFyKHR3ZWFrOiBMaXN0ZWRUd2Vhayk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTEwIHctMTAgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLWRlZmF1bHQgYmctdHJhbnNwYXJlbnQgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBpbml0aWFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGluaXRpYWwuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW1cIjtcbiAgaW5pdGlhbC50ZXh0Q29udGVudCA9ICh0d2Vhay5tYW5pZmVzdC5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChpbml0aWFsKTtcbiAgaWYgKCF0d2Vhay5tYW5pZmVzdC5pY29uVXJsKSByZXR1cm4gYXZhdGFyO1xuXG4gIGNvbnN0IGltYWdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImltZ1wiKTtcbiAgaW1hZ2UuYWx0ID0gXCJcIjtcbiAgaW1hZ2UuY2xhc3NOYW1lID0gXCJoLWZ1bGwgdy1mdWxsIG9iamVjdC1jb250YWluXCI7XG4gIGltYWdlLmhpZGRlbiA9IHRydWU7XG4gIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoXCJsb2FkXCIsICgpID0+IHtcbiAgICBpbml0aWFsLnJlbW92ZSgpO1xuICAgIGltYWdlLmhpZGRlbiA9IGZhbHNlO1xuICB9KTtcbiAgaW1hZ2UuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsICgpID0+IGltYWdlLnJlbW92ZSgpKTtcbiAgdm9pZCByZXNvbHZlSWNvblVybCh0d2Vhay5tYW5pZmVzdC5pY29uVXJsLCB0d2Vhay5kaXIpLnRoZW4oKHVybCkgPT4ge1xuICAgIGlmICh1cmwpIGltYWdlLnNyYyA9IHVybDtcbiAgICBlbHNlIGltYWdlLnJlbW92ZSgpO1xuICB9KTtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGltYWdlKTtcbiAgcmV0dXJuIGF2YXRhcjtcbn1cblxuZnVuY3Rpb24gdHdlYWtBdXRob3JOYW1lKGF1dGhvcjogVHdlYWtNYW5pZmVzdFtcImF1dGhvclwiXSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWF1dGhvcikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB0eXBlb2YgYXV0aG9yID09PSBcInN0cmluZ1wiID8gYXV0aG9yIDogYXV0aG9yLm5hbWU7XG59XG5cbmZ1bmN0aW9uIGFjdGlvbk1lbnVCdXR0b24oXG4gIGxhYmVsOiBzdHJpbmcsXG4gIGl0ZW1zOiBBY3Rpb25NZW51SXRlbVtdLFxuKTogeyBlbGVtZW50OiBIVE1MRWxlbWVudDsgZGlzcG9zZTogKCkgPT4gdm9pZCB9IHtcbiAgY29uc3QgZGV0YWlscyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkZXRhaWxzXCIpO1xuICBkZXRhaWxzLmNsYXNzTmFtZSA9IFwicmVsYXRpdmUgc2hyaW5rLTBcIjtcbiAgY29uc3Qgc3VtbWFyeSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzdW1tYXJ5XCIpO1xuICBzdW1tYXJ5LnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbGFiZWwpO1xuICBzdW1tYXJ5LnNldEF0dHJpYnV0ZShcImFyaWEtaGFzcG9wdXBcIiwgXCJtZW51XCIpO1xuICBzdW1tYXJ5LmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtOCB3LTggbGlzdC1ub25lIGN1cnNvci1pbnRlcmFjdGlvbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZC1sZyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBob3Zlcjp0ZXh0LXRva2VuLWZvcmVncm91bmQgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpyaW5nLTIgZm9jdXMtdmlzaWJsZTpyaW5nLXRva2VuLWZvY3VzLWJvcmRlclwiO1xuICBzdW1tYXJ5LnN0eWxlLmxpc3RTdHlsZSA9IFwibm9uZVwiO1xuICBzdW1tYXJ5LmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNlwiIGhlaWdodD1cIjE2XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBjbGFzcz1cImljb24tc21cIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjRcIiBjeT1cIjEwXCIgcj1cIjEuMjVcIi8+PGNpcmNsZSBjeD1cIjEwXCIgY3k9XCIxMFwiIHI9XCIxLjI1XCIvPjxjaXJjbGUgY3g9XCIxNlwiIGN5PVwiMTBcIiByPVwiMS4yNVwiLz5gICtcbiAgICBgPC9zdmc+YDtcbiAgY29uc3QgbWVudSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1lbnUuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcIm1lbnVcIik7XG4gIG1lbnUuY2xhc3NOYW1lID1cbiAgICBcImFic29sdXRlIHJpZ2h0LTAgdG9wLWZ1bGwgei01MCBtdC0xIGZsZXggbWluLXctNDQgZmxleC1jb2wgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1tYWluLXN1cmZhY2UtcHJpbWFyeSBwLTEgc2hhZG93LWxnXCI7XG4gIGZvciAoY29uc3QgaXRlbSBvZiBpdGVtcykge1xuICAgIGNvbnN0IGJ1dHRvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwibWVudWl0ZW1cIik7XG4gICAgYnV0dG9uLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggaC04IHctZnVsbCBpdGVtcy1jZW50ZXIgcm91bmRlZC1tZCBweC0yIHRleHQtbGVmdCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiO1xuICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IGl0ZW0ubGFiZWw7XG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGRldGFpbHMub3BlbiA9IGZhbHNlO1xuICAgICAgaXRlbS5vblNlbGVjdCgpO1xuICAgIH0pO1xuICAgIG1lbnUuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgfVxuICBkZXRhaWxzLmFwcGVuZChzdW1tYXJ5LCBtZW51KTtcblxuICBsZXQgbGlzdGVuaW5nID0gZmFsc2U7XG4gIGNvbnN0IGRldGFjaCA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIWxpc3RlbmluZykgcmV0dXJuO1xuICAgIGxpc3RlbmluZyA9IGZhbHNlO1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCBvblBvaW50ZXJEb3duLCB0cnVlKTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICB9O1xuICBjb25zdCBjbG9zZSA9ICgpOiB2b2lkID0+IHtcbiAgICBkZXRhaWxzLm9wZW4gPSBmYWxzZTtcbiAgICBkZXRhY2goKTtcbiAgfTtcbiAgY29uc3Qgb25Qb2ludGVyRG93biA9IChldmVudDogUG9pbnRlckV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKCFkZXRhaWxzLmlzQ29ubmVjdGVkIHx8ICEoZXZlbnQudGFyZ2V0IGluc3RhbmNlb2YgTm9kZSkgfHwgIWRldGFpbHMuY29udGFpbnMoZXZlbnQudGFyZ2V0KSkgY2xvc2UoKTtcbiAgfTtcbiAgY29uc3Qgb25LZXlkb3duID0gKGV2ZW50OiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKGV2ZW50LmtleSAhPT0gXCJFc2NhcGVcIikgcmV0dXJuO1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgY2xvc2UoKTtcbiAgICBzdW1tYXJ5LmZvY3VzKCk7XG4gIH07XG4gIGRldGFpbHMuYWRkRXZlbnRMaXN0ZW5lcihcInRvZ2dsZVwiLCAoKSA9PiB7XG4gICAgaWYgKCFkZXRhaWxzLm9wZW4pIHtcbiAgICAgIGRldGFjaCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoIWxpc3RlbmluZykge1xuICAgICAgbGlzdGVuaW5nID0gdHJ1ZTtcbiAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVyZG93blwiLCBvblBvaW50ZXJEb3duLCB0cnVlKTtcbiAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG9uS2V5ZG93biwgdHJ1ZSk7XG4gICAgfVxuICAgIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4gbWVudS5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKT8uZm9jdXMoKSk7XG4gIH0pO1xuXG4gIHJldHVybiB7IGVsZW1lbnQ6IGRldGFpbHMsIGRpc3Bvc2U6IGNsb3NlIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RhdHVzUGlsbCh0d2VhazogTGlzdGVkVHdlYWspOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGxhYmVsczogUmVjb3JkPFR3ZWFrU3RhdHVzLCBzdHJpbmc+ID0ge1xuICAgIGluc3RhbGxlZDogXCJJbnN0YWxsZWRcIixcbiAgICBcIm5vdC1pbnN0YWxsZWRcIjogXCJOb3QgaW5zdGFsbGVkXCIsXG4gICAgZW5hYmxlZDogXCJFbmFibGVkXCIsXG4gICAgZGlzYWJsZWQ6IFwiRGlzYWJsZWRcIixcbiAgICBmYWlsZWQ6IFwiRmFpbGVkXCIsXG4gICAgcXVhcmFudGluZWQ6IFwiUXVhcmFudGluZWRcIixcbiAgfTtcbiAgY29uc3QgdG9uZSA9IHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIiB8fCB0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIiA/IFwiZXJyb3JcIiA6XG4gICAgdHdlYWsuc3RhdHVzID09PSBcImVuYWJsZWRcIiA/IFwiaW5mb1wiIDogXCJuZXV0cmFsXCI7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFtcbiAgICBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIHB4LTIgcHktMC41IHRleHQtWzExcHhdIGZvbnQtbWVkaXVtXCIsXG4gICAgdG9uZSA9PT0gXCJlcnJvclwiXG4gICAgICA/IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQvMzAgYmctdG9rZW4tY2hhcnRzLXJlZC8xMCB0ZXh0LXRva2VuLWNoYXJ0cy1yZWRcIlxuICAgICAgOiB0b25lID09PSBcImluZm9cIlxuICAgICAgICA/IFwiYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCJcbiAgICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIixcbiAgXS5qb2luKFwiIFwiKTtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBsYWJlbHNbdHdlYWsuc3RhdHVzXTtcbiAgaWYgKHR3ZWFrLmhlYWx0aD8uZXJyb3IpIGJhZGdlLnRpdGxlID0gdHdlYWsuaGVhbHRoLmVycm9yO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIG9wZW5QdWJsaXNoVHdlYWtEaWFsb2coKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXB1Ymxpc2gtZGlhbG9nXVwiKTtcbiAgZXhpc3Rpbmc/LnJlbW92ZSgpO1xuXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmRhdGFzZXQudHdlYWtlclB1Ymxpc2hEaWFsb2cgPSBcInRydWVcIjtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBcImZpeGVkIGluc2V0LTAgei1bOTk5OV0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNDAgcC00XCI7XG5cbiAgY29uc3QgZGlhbG9nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGlhbG9nLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IHctZnVsbCBtYXgtdy14bCBmbGV4LWNvbCBnYXAtNCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLW1haW4tc3VyZmFjZS1wcmltYXJ5IHAtNCBzaGFkb3cteGxcIjtcbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChkaWFsb2cpO1xuXG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtc3RhcnQganVzdGlmeS1iZXR3ZWVuIGdhcC0zXCI7XG4gIGNvbnN0IHRpdGxlU3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIlB1Ymxpc2ggVHdlYWtcIjtcbiAgY29uc3Qgc3VidGl0bGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdWJ0aXRsZS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IFwiU3VibWl0IGEgR2l0SHViIHJlcG8gZm9yIGFkbWluIHJldmlldy4gVHdlYWtlcnMgcmVjb3JkcyB0aGUgZXhhY3QgY29tbWl0IGFkbWlucyBtdXN0IHJldmlldyBhbmQgcGluLlwiO1xuICB0aXRsZVN0YWNrLmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgdGl0bGVTdGFjay5hcHBlbmRDaGlsZChzdWJ0aXRsZSk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZCh0aXRsZVN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJEaXNtaXNzXCIsICgpID0+IG92ZXJsYXkucmVtb3ZlKCkpKTtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKGhlYWRlcik7XG5cbiAgY29uc3QgcmVwb0lucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICByZXBvSW5wdXQudHlwZSA9IFwidGV4dFwiO1xuICByZXBvSW5wdXQucGxhY2Vob2xkZXIgPSBcIm93bmVyL3JlcG8gb3IgaHR0cHM6Ly9naXRodWIuY29tL293bmVyL3JlcG9cIjtcbiAgcmVwb0lucHV0LmNsYXNzTmFtZSA9XG4gICAgXCJoLTEwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdHJhbnNwYXJlbnQgcHgtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzOm91dGxpbmUtbm9uZVwiO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQocmVwb0lucHV0KTtcblxuICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGF0dXMuY2xhc3NOYW1lID0gXCJtaW4taC01IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBzdGF0dXMudGV4dENvbnRlbnQgPSBcIlRoZSBtYW5pZmVzdCBzaG91bGQgaW5jbHVkZSBhbiBpY29uVXJsIHN1aXRhYmxlIGZvciB0aGUgc3RvcmUuXCI7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChzdGF0dXMpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgY29uc3Qgc3VibWl0ID0gY29tcGFjdEJ1dHRvbihcIk9wZW4gUmV2aWV3IElzc3VlXCIsICgpID0+IHtcbiAgICB2b2lkIHN1Ym1pdFB1Ymxpc2hUd2VhayhyZXBvSW5wdXQsIHN0YXR1cyk7XG4gIH0pO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHN1Ym1pdCk7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICBvdmVybGF5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGlmIChlLnRhcmdldCA9PT0gb3ZlcmxheSkgb3ZlcmxheS5yZW1vdmUoKTtcbiAgfSk7XG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG4gIHJlcG9JbnB1dC5mb2N1cygpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBzdWJtaXRQdWJsaXNoVHdlYWsoXG4gIHJlcG9JbnB1dDogSFRNTElucHV0RWxlbWVudCxcbiAgc3RhdHVzOiBIVE1MRWxlbWVudCxcbik6IFByb21pc2U8dm9pZD4ge1xuICBzdGF0dXMuY2xhc3NOYW1lID0gXCJtaW4taC01IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBzdGF0dXMudGV4dENvbnRlbnQgPSBcIlJlc29sdmluZyB0aGUgcmVwbyBjb21taXQgdG8gcmV2aWV3LlwiO1xuICB0cnkge1xuICAgIGNvbnN0IHN1Ym1pc3Npb24gPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICBcInR3ZWFrZXI6cHJlcGFyZS10d2Vhay1zdG9yZS1zdWJtaXNzaW9uXCIsXG4gICAgICByZXBvSW5wdXQudmFsdWUsXG4gICAgKSBhcyBUd2Vha1N0b3JlUHVibGlzaFN1Ym1pc3Npb247XG4gICAgY29uc3QgdXJsID0gYnVpbGRUd2Vha1B1Ymxpc2hJc3N1ZVVybChzdWJtaXNzaW9uKTtcbiAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm9wZW4tZXh0ZXJuYWxcIiwgdXJsKTtcbiAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBgR2l0SHViIHJldmlldyBpc3N1ZSBvcGVuZWQgZm9yICR7c3VibWlzc2lvbi5jb21taXRTaGEuc2xpY2UoMCwgNyl9LmA7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBzdGF0dXMuY2xhc3NOYW1lID0gXCJtaW4taC01IHRleHQtc20gdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gICAgc3RhdHVzLnRleHRDb250ZW50ID0gU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlID8/IGUpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBjb21wb25lbnRzIFx1MjUwMFx1MjUwMFxuXG4vKiogVGhlIGZ1bGwgcGFuZWwgc2hlbGwgKHRvb2xiYXIgKyBzY3JvbGwgKyBoZWFkaW5nICsgc2VjdGlvbnMgd3JhcCkuICovXG5mdW5jdGlvbiBwYW5lbFNoZWxsKFxuICB0aXRsZTogc3RyaW5nLFxuICBzdWJ0aXRsZT86IHN0cmluZyxcbiAgb3B0aW9ucz86IHsgd2lkZT86IGJvb2xlYW47IHdpZHRoPzogXCJkZWZhdWx0XCIgfCBcInBsdWdpbnNcIiB8IFwid2lkZVwiIH0sXG4pOiB7XG4gIG91dGVyOiBIVE1MRWxlbWVudDtcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudDtcbiAgc3VidGl0bGU/OiBIVE1MRWxlbWVudDtcbiAgaGVhZGVyQWN0aW9uczogSFRNTEVsZW1lbnQ7XG4gIGhlYWRlclRpdGxlQWN0aW9uczogSFRNTEVsZW1lbnQ7XG59IHtcbiAgY29uc3Qgb3V0ZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdXRlci5jbGFzc05hbWUgPSBcIm1haW4tc3VyZmFjZSBmbGV4IGgtZnVsbCBtaW4taC0wIGZsZXgtY29sXCI7XG5cbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXIuY2xhc3NOYW1lID1cbiAgICBcImRyYWdnYWJsZSBmbGV4IGl0ZW1zLWNlbnRlciBweC1wYW5lbCBlbGVjdHJvbjpoLXRvb2xiYXIgZXh0ZW5zaW9uOmgtdG9vbGJhci1zbVwiO1xuICBvdXRlci5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCBzY3JvbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzY3JvbGwuY2xhc3NOYW1lID0gXCJmbGV4LTEgb3ZlcmZsb3cteS1hdXRvIHAtcGFuZWxcIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQoc2Nyb2xsKTtcblxuICBjb25zdCBpbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvbnN0IHdpZHRoID0gb3B0aW9ucz8ud2lkdGggPz8gKG9wdGlvbnM/LndpZGUgPyBcIndpZGVcIiA6IFwiZGVmYXVsdFwiKTtcbiAgaW5uZXIuY2xhc3NOYW1lID0gW1xuICAgIFwibXgtYXV0byBmbGV4IHctZnVsbCBmbGV4LWNvbCBlbGVjdHJvbjptaW4tdy1bY2FsYygzMjBweCp2YXIoLS1jb2RleC13aW5kb3ctem9vbSkpXVwiLFxuICAgIHdpZHRoID09PSBcIndpZGVcIiA/IFwibWF4LXctNXhsXCIgOiB3aWR0aCA9PT0gXCJwbHVnaW5zXCIgPyBcIm1heC13LTN4bFwiIDogXCJtYXgtdy0yeGxcIixcbiAgXS5qb2luKFwiIFwiKTtcbiAgc2Nyb2xsLmFwcGVuZENoaWxkKGlubmVyKTtcblxuICBjb25zdCBoZWFkZXJXcmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyV3JhcC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMyBwYi1wYW5lbFwiO1xuICBjb25zdCBoZWFkZXJJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcklubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMS41IHBiLXBhbmVsXCI7XG4gIGNvbnN0IHRpdGxlTGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlTGluZS5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgaGVhZGluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJlbGVjdHJvbjpoZWFkaW5nLWxnIGhlYWRpbmctYmFzZSB0cnVuY2F0ZVwiO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gdGl0bGU7XG4gIHRpdGxlTGluZS5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgY29uc3QgaGVhZGVyVGl0bGVBY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyVGl0bGVBY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgdGl0bGVMaW5lLmFwcGVuZENoaWxkKGhlYWRlclRpdGxlQWN0aW9ucyk7XG4gIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKHRpdGxlTGluZSk7XG4gIGxldCBzdWJ0aXRsZUVsZW1lbnQ6IEhUTUxFbGVtZW50IHwgdW5kZWZpbmVkO1xuICBpZiAoc3VidGl0bGUpIHtcbiAgICBjb25zdCBzdWIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHN1Yi5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgdGV4dC1zbVwiO1xuICAgIHN1Yi50ZXh0Q29udGVudCA9IHN1YnRpdGxlO1xuICAgIGhlYWRlcklubmVyLmFwcGVuZENoaWxkKHN1Yik7XG4gICAgc3VidGl0bGVFbGVtZW50ID0gc3ViO1xuICB9XG4gIGhlYWRlcldyYXAuYXBwZW5kQ2hpbGQoaGVhZGVySW5uZXIpO1xuICBjb25zdCBoZWFkZXJBY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGVyQWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGhlYWRlcldyYXAuYXBwZW5kQ2hpbGQoaGVhZGVyQWN0aW9ucyk7XG4gIGlubmVyLmFwcGVuZENoaWxkKGhlYWRlcldyYXApO1xuXG4gIGNvbnN0IHNlY3Rpb25zV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHNlY3Rpb25zV3JhcC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLVt2YXIoLS1wYWRkaW5nLXBhbmVsKV1cIjtcbiAgaW5uZXIuYXBwZW5kQ2hpbGQoc2VjdGlvbnNXcmFwKTtcblxuICByZXR1cm4geyBvdXRlciwgc2VjdGlvbnNXcmFwLCBzdWJ0aXRsZTogc3VidGl0bGVFbGVtZW50LCBoZWFkZXJBY3Rpb25zLCBoZWFkZXJUaXRsZUFjdGlvbnMgfTtcbn1cblxuZnVuY3Rpb24gc2VjdGlvblRpdGxlKHRleHQ6IHN0cmluZywgdHJhaWxpbmc/OiBIVE1MRWxlbWVudCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLXRvb2xiYXIgaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBweC0wIHB5LTBcIjtcbiAgY29uc3QgdGl0bGVJbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlSW5uZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0LmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0ZXh0O1xuICB0aXRsZUlubmVyLmFwcGVuZENoaWxkKHQpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh0aXRsZUlubmVyKTtcbiAgaWYgKHRyYWlsaW5nKSB7XG4gICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJpZ2h0LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgICByaWdodC5hcHBlbmRDaGlsZCh0cmFpbGluZyk7XG4gICAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQocmlnaHQpO1xuICB9XG4gIHJldHVybiB0aXRsZVJvdztcbn1cblxuLyoqXG4gKiBDb2RleCdzIFwiT3BlbiBjb25maWcudG9tbFwiLXN0eWxlIHRyYWlsaW5nIGJ1dHRvbjogZ2hvc3QgYm9yZGVyLCBtdXRlZFxuICogbGFiZWwsIHRvcC1yaWdodCBkaWFnb25hbCBhcnJvdyBpY29uLiBNYXJrdXAgbWlycm9ycyBDb25maWd1cmF0aW9uIHBhbmVsLlxuICovXG5mdW5jdGlvbiBvcGVuSW5QbGFjZUJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIGJvcmRlciB3aGl0ZXNwYWNlLW5vd3JhcCBmb2N1czpvdXRsaW5lLW5vbmUgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDAgcm91bmRlZC1sZyB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGF0YS1bc3RhdGU9b3Blbl06YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGJvcmRlci10cmFuc3BhcmVudCBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciBweC0yIHB5LTAgdGV4dC1iYXNlIGxlYWRpbmctWzE4cHhdXCI7XG4gIGJ0bi5pbm5lckhUTUwgPVxuICAgIGAke2xhYmVsfWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tMnhzXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTQuMzM0OSAxMy4zMzAxVjYuNjA2NDVMNS40NzA2NSAxNS40NzA3QzUuMjEwOTUgMTUuNzMwNCA0Ljc4ODk1IDE1LjczMDQgNC41MjkyNSAxNS40NzA3QzQuMjY5NTUgMTUuMjExIDQuMjY5NTUgMTQuNzg5IDQuNTI5MjUgMTQuNTI5M0wxMy4zOTM1IDUuNjY1MDRINi42NjAxMUM2LjI5Mjg0IDUuNjY1MDQgNS45OTUwNyA1LjM2NzI3IDUuOTk1MDcgNUM1Ljk5NTA3IDQuNjMyNzMgNi4yOTI4NCA0LjMzNDk2IDYuNjYwMTEgNC4zMzQ5NkgxNC45OTk5TDE1LjEzMzcgNC4zNDg2M0MxNS40MzY5IDQuNDEwNTcgMTUuNjY1IDQuNjc4NTcgMTUuNjY1IDVWMTMuMzMwMUMxNS42NjQ5IDEzLjY5NzMgMTUuMzY3MiAxMy45OTUxIDE0Ljk5OTkgMTMuOTk1MUMxNC42MzI3IDEzLjk5NTEgMTQuMzM1IDEzLjY5NzMgMTQuMzM0OSAxMy4zMzAxWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIj48L3BhdGg+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0QnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uQ2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnkgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIjtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKCk7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiByb3VuZGVkQ2FyZCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIGZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIHJvdW5kZWQtbGcgYm9yZGVyXCI7XG4gIGNhcmQuc2V0QXR0cmlidXRlKFxuICAgIFwic3R5bGVcIixcbiAgICBcImJhY2tncm91bmQtY29sb3I6IHZhcigtLWNvbG9yLWJhY2tncm91bmQtcGFuZWwsIHZhcigtLWNvbG9yLXRva2VuLWJnLWZvZykpO1wiLFxuICApO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcm93U2ltcGxlKHRpdGxlOiBzdHJpbmcgfCB1bmRlZmluZWQsIGRlc2NyaXB0aW9uPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciBnYXAtM1wiO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGlmICh0aXRsZSkge1xuICAgIGNvbnN0IHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHQuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICB0LnRleHRDb250ZW50ID0gdGl0bGU7XG4gICAgc3RhY2suYXBwZW5kQ2hpbGQodCk7XG4gIH1cbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gICAgZC50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGQpO1xuICB9XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJldHVybiByb3c7XG59XG5cbi8qKlxuICogQ29kZXgtc3R5bGVkIHRvZ2dsZSBzd2l0Y2guIE1hcmt1cCBtaXJyb3JzIHRoZSBHZW5lcmFsID4gUGVybWlzc2lvbnMgcm93XG4gKiBzd2l0Y2ggd2UgY2FwdHVyZWQ6IG91dGVyIGJ1dHRvbiAocm9sZT1zd2l0Y2gpLCBpbm5lciBwaWxsLCBzbGlkaW5nIGtub2IuXG4gKi9cbmZ1bmN0aW9uIHN3aXRjaENvbnRyb2woXG4gIGluaXRpYWw6IGJvb2xlYW4sXG4gIG9uQ2hhbmdlOiAobmV4dDogYm9vbGVhbikgPT4gdm9pZCB8IFByb21pc2U8dm9pZD4sXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzd2l0Y2hcIik7XG5cbiAgY29uc3QgcGlsbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCBrbm9iID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGtub2IuY2xhc3NOYW1lID1cbiAgICBcInJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLVtjb2xvcjp2YXIoLS1ncmF5LTApXSBiZy1bY29sb3I6dmFyKC0tZ3JheS0wKV0gc2hhZG93LXNtIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBlYXNlLW91dCBoLTQgdy00XCI7XG4gIHBpbGwuYXBwZW5kQ2hpbGQoa25vYik7XG5cbiAgY29uc3QgYXBwbHkgPSAob246IGJvb2xlYW4pOiB2b2lkID0+IHtcbiAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIsIFN0cmluZyhvbikpO1xuICAgIGJ0bi5kYXRhc2V0LnN0YXRlID0gb24gPyBcImNoZWNrZWRcIiA6IFwidW5jaGVja2VkXCI7XG4gICAgYnRuLmNsYXNzTmFtZSA9XG4gICAgICBcImlubGluZS1mbGV4IGl0ZW1zLWNlbnRlciB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgZm9jdXMtdmlzaWJsZTpyb3VuZGVkLWZ1bGwgY3Vyc29yLWludGVyYWN0aW9uXCI7XG4gICAgcGlsbC5jbGFzc05hbWUgPSBgcmVsYXRpdmUgaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCB0cmFuc2l0aW9uLWNvbG9ycyBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC01IHctOCAke1xuICAgICAgb24gPyBcImJnLXRva2VuLWNoYXJ0cy1ibHVlXCIgOiBcImJnLXRva2VuLWZvcmVncm91bmQvMjBcIlxuICAgIH1gO1xuICAgIHBpbGwuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2IuZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGtub2Iuc3R5bGUudHJhbnNmb3JtID0gb24gPyBcInRyYW5zbGF0ZVgoMTRweClcIiA6IFwidHJhbnNsYXRlWCgycHgpXCI7XG4gIH07XG4gIGFwcGx5KGluaXRpYWwpO1xuXG4gIGJ0bi5hcHBlbmRDaGlsZChwaWxsKTtcbiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNvbnN0IG5leHQgPSBidG4uZ2V0QXR0cmlidXRlKFwiYXJpYS1jaGVja2VkXCIpICE9PSBcInRydWVcIjtcbiAgICBhcHBseShuZXh0KTtcbiAgICBidG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBvbkNoYW5nZShuZXh0KTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfVxuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIGljb25zIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBjb25maWdJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNsaWRlcnMgLyBzZXR0aW5ncyBnbHlwaC4gMjB4MjAgY3VycmVudENvbG9yLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTMgNWg5TTE1IDVoMk0zIDEwaDJNOCAxMGg5TTMgMTVoMTFNMTcgMTVoMFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxM1wiIGN5PVwiNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiNlwiIGN5PVwiMTBcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjE1XCIgY3k9XCIxNVwiIHI9XCIxLjZcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc0ljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gU3BhcmtsZXMgLyBcIisrXCIgZ2x5cGggZm9yIHR3ZWFrcy5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0xMCAyLjUgTDExLjQgOC42IEwxNy41IDEwIEwxMS40IDExLjQgTDEwIDE3LjUgTDguNiAxMS40IEwyLjUgMTAgTDguNiA4LjYgWlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTUuNSAzIEwxNiA1IEwxOCA1LjUgTDE2IDYgTDE1LjUgOCBMMTUgNiBMMTMgNS41IEwxNSA1IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgb3BhY2l0eT1cIjAuN1wiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBzdG9yZUljb25TdmcoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk00IDguMiA1LjEgNC41QTEuNSAxLjUgMCAwIDEgNi41NSAzLjRoNi45YTEuNSAxLjUgMCAwIDEgMS40NSAxLjFMMTYgOC4yXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNC41IDhoMTF2Ny41QTEuNSAxLjUgMCAwIDEgMTQgMTdINmExLjUgMS41IDAgMCAxLTEuNS0xLjVWOFpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk03LjUgOHYxYTIuNSAyLjUgMCAwIDAgNSAwVjhcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRQYWdlSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBEb2N1bWVudC9wYWdlIGdseXBoIGZvciB0d2Vhay1yZWdpc3RlcmVkIHBhZ2VzIHdpdGhvdXQgdGhlaXIgb3duIGljb24uXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNSAzaDdsMyAzdjExYTEgMSAwIDAgMS0xIDFINWExIDEgMCAwIDEtMS0xVjRhMSAxIDAgMCAxIDEtMVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWpvaW49XCJyb3VuZFwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xMiAzdjNhMSAxIDAgMCAwIDEgMWgyXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNyAxMWg2TTcgMTRoNFwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUljb25VcmwoXG4gIHVybDogc3RyaW5nLFxuICB0d2Vha0Rpcjogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB7XG4gIGlmICgvXihodHRwcz86fGRhdGE6KS8udGVzdCh1cmwpKSByZXR1cm4gdXJsO1xuICAvLyBSZWxhdGl2ZSBwYXRoIFx1MjE5MiBhc2sgbWFpbiB0byByZWFkIHRoZSBmaWxlIGFuZCByZXR1cm4gYSBkYXRhOiBVUkwuXG4gIC8vIFJlbmRlcmVyIGlzIHNhbmRib3hlZCBzbyBmaWxlOi8vIHdvbid0IGxvYWQgZGlyZWN0bHkuXG4gIGNvbnN0IHJlbCA9IHVybC5zdGFydHNXaXRoKFwiLi9cIikgPyB1cmwuc2xpY2UoMikgOiB1cmw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICBcInR3ZWFrZXI6cmVhZC10d2Vhay1hc3NldFwiLFxuICAgICAgdHdlYWtEaXIsXG4gICAgICByZWwsXG4gICAgKSkgYXMgc3RyaW5nO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcGxvZyhcImljb24gbG9hZCBmYWlsZWRcIiwgeyB1cmwsIHR3ZWFrRGlyLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgRE9NIGhldXJpc3RpY3MgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIGZpbmRTaWRlYmFySXRlbXNHcm91cCgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBjYW5kaWRhdGVzID0gQXJyYXkuZnJvbShcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImFzaWRlLG5hdixbcm9sZT0nbmF2aWdhdGlvbiddLGRpdlwiKSxcbiAgKTtcblxuICBsZXQgYmVzdDogSFRNTEVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGJlc3RTY29yZSA9IC0xO1xuICBsZXQgYmVzdEFyZWEgPSBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFk7XG5cbiAgZm9yIChjb25zdCBjYW5kaWRhdGUgb2YgY2FuZGlkYXRlcykge1xuICAgIGlmIChjYW5kaWRhdGUuZGF0YXNldC50d2Vha2VyKSBjb250aW51ZTtcbiAgICBpZiAoIWlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKGNhbmRpZGF0ZSkpIGNvbnRpbnVlO1xuXG4gICAgY29uc3QgbGFiZWxzID0gdHdlYWtlclNldHRpbmdzTGFiZWxzRnJvbShjYW5kaWRhdGUpO1xuICAgIGNvbnN0IHNjb3JlID0gdHdlYWtlclNldHRpbmdzTGFiZWxTY29yZShsYWJlbHMpO1xuICAgIGNvbnN0IHJlY3QgPSBjYW5kaWRhdGUuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgY29uc3QgYXJlYSA9IHJlY3Qud2lkdGggKiByZWN0LmhlaWdodDtcbiAgICBjb25zdCB3ZWlnaHRlZCA9IHNjb3JlLmNvcmUgKiAxMDAgKyBzY29yZS50b3RhbDtcblxuICAgIGlmICh3ZWlnaHRlZCA+IGJlc3RTY29yZSB8fCAod2VpZ2h0ZWQgPT09IGJlc3RTY29yZSAmJiBhcmVhIDwgYmVzdEFyZWEpKSB7XG4gICAgICBiZXN0ID0gY2FuZGlkYXRlO1xuICAgICAgYmVzdFNjb3JlID0gd2VpZ2h0ZWQ7XG4gICAgICBiZXN0QXJlYSA9IGFyZWE7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbmNvbnN0IEZPUkJJRERFTl9TRVRUSU5HU19TSURFQkFSX1NFTEVDVE9SID0gW1xuICBcIltkYXRhLWNvbXBvc2VyLW92ZXJsYXktZmxvYXRpbmctdWk9J3RydWUnXVwiLFxuICBcIltkYXRhLXR3ZWFrZXItc2xhc2gtbWVudT0ndHJ1ZSddXCIsXG4gIFwiW2RhdGEtdHdlYWtlci1vdmVybGF5LW5vaXNlPSd0cnVlJ11cIixcbiAgXCIuY29tcG9zZXItaG9tZS10b3AtbWVudVwiLFxuICBcIi52ZXJ0aWNhbC1zY3JvbGwtZmFkZS1tYXNrXCIsXG4gIFwiW2NsYXNzKj0nW2NvbnRhaW5lci1uYW1lOmhvbWUtbWFpbi1jb250ZW50XSddXCIsXG5dLmpvaW4oXCIsXCIpO1xuXG5mdW5jdGlvbiBpc0ZvcmJpZGRlblNldHRpbmdzU2lkZWJhclN1cmZhY2Uobm9kZTogRWxlbWVudCB8IG51bGwpOiBib29sZWFuIHtcbiAgaWYgKCFub2RlKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGVsID0gbm9kZSBpbnN0YW5jZW9mIEhUTUxFbGVtZW50ID8gbm9kZSA6IG5vZGUucGFyZW50RWxlbWVudDtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZWwuY2xvc2VzdChGT1JCSURERU5fU0VUVElOR1NfU0lERUJBUl9TRUxFQ1RPUikpIHJldHVybiB0cnVlO1xuICBpZiAoZWwucXVlcnlTZWxlY3RvcihcIltkYXRhLWxpc3QtbmF2aWdhdGlvbi1pdGVtPSd0cnVlJ10sIFtjbWRrLWl0ZW1dXCIpKSByZXR1cm4gdHJ1ZTtcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG5mdW5jdGlvbiBpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShlbDogSFRNTEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgcmVjdCA9IHR3ZWFrZXJWaXNpYmxlQm94KGVsKTtcbiAgaWYgKCFyZWN0KSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gQ3VycmVudCBDb2RleCBTZXR0aW5ncyBzaWRlYmFyOiBsZWZ0IGNvbHVtbiwgbm90IHRoZSBtYWluIGNvbnRlbnQgcGFuZWwuXG4gIGlmIChyZWN0LndpZHRoIDwgMTIwIHx8IHJlY3Qud2lkdGggPiA2MjApIHJldHVybiBmYWxzZTtcbiAgaWYgKHJlY3QuaGVpZ2h0IDwgODApIHJldHVybiBmYWxzZTtcbiAgaWYgKHJlY3QubGVmdCA+IHdpbmRvdy5pbm5lcldpZHRoICogMC42NSkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxhYmVscyA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oZWwpO1xuICBpZiAoaGFzTWFpbkFwcFNpZGViYXJTaWduYWxzKGxhYmVscykgJiYgIWhhc1R3ZWFrZXJTZXR0aW5nc09ubHlTaWduYWwobGFiZWxzKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHJldHVybiBpc1R3ZWFrZXJTZXR0aW5nc0xhYmVsU2V0KGxhYmVscyk7XG59XG5cbmZ1bmN0aW9uIHJlbW92ZU1pc3BsYWNlZFNldHRpbmdzR3JvdXBzKCk6IHZvaWQge1xuICBjb25zdCBncm91cHMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcbiAgICBcIltkYXRhLXR3ZWFrZXI9J25hdi1ncm91cCddLCBbZGF0YS10d2Vha2VyPSdwYWdlcy1ncm91cCddLCBbZGF0YS10d2Vha2VyPSduYXRpdmUtbmF2LWhlYWRlciddXCIsXG4gICk7XG4gIGZvciAoY29uc3QgZ3JvdXAgb2YgQXJyYXkuZnJvbShncm91cHMpKSB7XG4gICAgaWYgKGlzVHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFBsYWNlbWVudFZhbGlkKGdyb3VwKSkgY29udGludWU7XG4gICAgcmVzZXRUd2Vha2VySW5qZWN0ZWRTZXR0aW5nc0dyb3VwU3RhdGUoZ3JvdXApO1xuICAgIGdyb3VwLnJlbW92ZSgpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGlzVHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFBsYWNlbWVudFZhbGlkKGdyb3VwOiBIVE1MRWxlbWVudCk6IGJvb2xlYW4ge1xuICBpZiAoaXNGb3JiaWRkZW5TZXR0aW5nc1NpZGViYXJTdXJmYWNlKGdyb3VwKSkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIFRydXN0IHRoZSBpbmplY3Rpb24tdGltZSBwbGFjZW1lbnQgd2hpbGUgdGhhdCBleGFjdCBzaWRlYmFyIG5vZGUgaXNcbiAgLy8gYWxpdmUuIGlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlIGlzIGxheW91dC1kZXBlbmRlbnQgKHZpc2libGUgYm94KSwgc29cbiAgLy8gcmUtanVkZ2luZyBtaWQgUmVhY3QgcmUtcmVuZGVyIGludGVybWl0dGVudGx5IGZhaWxzLCBzdHJpcHMgdGhlIGdyb3VwLFxuICAvLyBhbmQgcmUtdHJpZ2dlcnMgdGhlIG9ic2VydmVyIFx1MjAxNCBhbiBpbmplY3QvcmVtb3ZlIGxvb3AgYXQgcmVuZGVyIHNwZWVkLlxuICBpZiAoXG4gICAgc3RhdGUuc2lkZWJhclJvb3QgJiZcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdC5pc0Nvbm5lY3RlZCAmJlxuICAgIChncm91cC5wYXJlbnRFbGVtZW50ID09PSBzdGF0ZS5zaWRlYmFyUm9vdCB8fCBzdGF0ZS5zaWRlYmFyUm9vdC5jb250YWlucyhncm91cCkpXG4gICkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgbGV0IG5vZGUgPSBncm91cC5wYXJlbnRFbGVtZW50O1xuICBmb3IgKGxldCBkZXB0aCA9IDA7IG5vZGUgJiYgZGVwdGggPCA0OyBkZXB0aCsrKSB7XG4gICAgaWYgKGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShub2RlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShub2RlKSkgcmV0dXJuIHRydWU7XG4gICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gcmVzZXRUd2Vha2VySW5qZWN0ZWRTZXR0aW5nc0dyb3VwU3RhdGUoZ3JvdXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXZHcm91cCA9PT0gZ3JvdXAgfHwgKHN0YXRlLm5hdkdyb3VwICYmIGdyb3VwLmNvbnRhaW5zKHN0YXRlLm5hdkdyb3VwKSkpIHtcbiAgICBzdGF0ZS5uYXZHcm91cCA9IG51bGw7XG4gICAgc3RhdGUubmF2QnV0dG9ucyA9IG51bGw7XG4gICAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IG51bGw7XG4gIH1cbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXAgPT09IGdyb3VwIHx8IChzdGF0ZS5wYWdlc0dyb3VwICYmIGdyb3VwLmNvbnRhaW5zKHN0YXRlLnBhZ2VzR3JvdXApKSkge1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gIH1cbiAgaWYgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciA9PT0gZ3JvdXAgfHwgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciAmJiBncm91cC5jb250YWlucyhzdGF0ZS5uYXRpdmVOYXZIZWFkZXIpKSkge1xuICAgIHN0YXRlLm5hdGl2ZU5hdkhlYWRlciA9IG51bGw7XG4gIH1cbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSb290LmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIHN0YXRlLnNpZGViYXJSb290ID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5kQ29udGVudEFyZWEoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIXNpZGViYXIpIHJldHVybiBudWxsO1xuICBsZXQgcGFyZW50ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAocGFyZW50KSB7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKHBhcmVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkID09PSBzaWRlYmFyIHx8IGNoaWxkLmNvbnRhaW5zKHNpZGViYXIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHIgPSBjaGlsZC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGlmIChyLndpZHRoID4gMzAwICYmIHIuaGVpZ2h0ID4gMjAwKSByZXR1cm4gY2hpbGQ7XG4gICAgfVxuICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtYXliZUR1bXBEb20oKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICAgIGlmIChzaWRlYmFyICYmICFzdGF0ZS5zaWRlYmFyRHVtcGVkKSB7XG4gICAgICBzdGF0ZS5zaWRlYmFyRHVtcGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHNiUm9vdCA9IHNpZGViYXIucGFyZW50RWxlbWVudCA/PyBzaWRlYmFyO1xuICAgICAgcGxvZyhgY29kZXggc2lkZWJhciBIVE1MYCwgc2JSb290Lm91dGVySFRNTC5zbGljZSgwLCAzMjAwMCkpO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gICAgaWYgKCFjb250ZW50KSB7XG4gICAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgIT09IGxvY2F0aW9uLmhyZWYpIHtcbiAgICAgICAgc3RhdGUuZmluZ2VycHJpbnQgPSBsb2NhdGlvbi5ocmVmO1xuICAgICAgICBwbG9nKFwiZG9tIHByb2JlIChubyBjb250ZW50KVwiLCB7XG4gICAgICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgICAgIHNpZGViYXI6IHNpZGViYXIgPyBkZXNjcmliZShzaWRlYmFyKSA6IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcGFuZWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZC5kYXRhc2V0LnR3ZWFrZXIgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNoaWxkLnN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiKSBjb250aW51ZTtcbiAgICAgIHBhbmVsID0gY2hpbGQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY29uc3QgYWN0aXZlTmF2ID0gc2lkZWJhclxuICAgICAgPyBBcnJheS5mcm9tKHNpZGViYXIucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sIGFcIikpLmZpbmQoXG4gICAgICAgICAgKGIpID0+XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiZGF0YS1hY3RpdmVcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmNsYXNzTGlzdC5jb250YWlucyhcImFjdGl2ZVwiKSxcbiAgICAgICAgKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IGhlYWRpbmcgPSBwYW5lbD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXG4gICAgICBcImgxLCBoMiwgaDMsIFtjbGFzcyo9J2hlYWRpbmcnXVwiLFxuICAgICk7XG4gICAgY29uc3QgZmluZ2VycHJpbnQgPSBgJHthY3RpdmVOYXY/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7aGVhZGluZz8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtwYW5lbD8uY2hpbGRyZW4ubGVuZ3RoID8/IDB9YDtcbiAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgPT09IGZpbmdlcnByaW50KSByZXR1cm47XG4gICAgc3RhdGUuZmluZ2VycHJpbnQgPSBmaW5nZXJwcmludDtcbiAgICBwbG9nKFwiZG9tIHByb2JlXCIsIHtcbiAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgIGFjdGl2ZU5hdjogYWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBoZWFkaW5nOiBoZWFkaW5nPy50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBjb250ZW50OiBkZXNjcmliZShjb250ZW50KSxcbiAgICB9KTtcbiAgICBpZiAocGFuZWwpIHtcbiAgICAgIGNvbnN0IGh0bWwgPSBwYW5lbC5vdXRlckhUTUw7XG4gICAgICBwbG9nKFxuICAgICAgICBgY29kZXggcGFuZWwgSFRNTCAoJHthY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gXCI/XCJ9KWAsXG4gICAgICAgIGh0bWwuc2xpY2UoMCwgMzIwMDApLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiZG9tIHByb2JlIGZhaWxlZFwiLCBTdHJpbmcoZSkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRlc2NyaWJlKGVsOiBIVE1MRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHtcbiAgICB0YWc6IGVsLnRhZ05hbWUsXG4gICAgY2xzOiBlbC5jbGFzc05hbWUuc2xpY2UoMCwgMTIwKSxcbiAgICBpZDogZWwuaWQgfHwgdW5kZWZpbmVkLFxuICAgIGNoaWxkcmVuOiBlbC5jaGlsZHJlbi5sZW5ndGgsXG4gICAgcmVjdDogKCgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHJldHVybiB7IHc6IE1hdGgucm91bmQoci53aWR0aCksIGg6IE1hdGgucm91bmQoci5oZWlnaHQpIH07XG4gICAgfSkoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fdHdlYWtlcl90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX190d2Vha2VyX3R3ZWFrc19kaXJfXyA/P1xuICAgIFwiPHVzZXIgZGlyPi90d2Vha3NcIlxuICApO1xufVxuIiwgImltcG9ydCB0eXBlIHsgVHdlYWtNYW5pZmVzdCB9IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfVFdFQUtfU1RPUkVfSU5ERVhfVVJMID1cbiAgXCJodHRwczovL3RoZXJlYWxpdHlyZXBvcnQuZ2l0aHViLmlvL3R3ZWFrZXJzL3N0b3JlL2luZGV4Lmpzb25cIjtcbmV4cG9ydCBjb25zdCBUV0VBS19TVE9SRV9SRVZJRVdfSVNTVUVfVVJMID1cbiAgXCJodHRwczovL2dpdGh1Yi5jb20vdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy9pc3N1ZXMvbmV3XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdG9yZVJlZ2lzdHJ5IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgZ2VuZXJhdGVkQXQ/OiBzdHJpbmc7XG4gIGVudHJpZXM6IFR3ZWFrU3RvcmVFbnRyeVtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICAvKipcbiAgICogQW4gZW50cnkgY2FuIGJlIGNhdGFsb2cgbWV0YWRhdGEgYmVmb3JlIGl0cyBpbXBsZW1lbnRhdGlvbiBpcyBzaGlwcGVkLlxuICAgKiBNZXRhZGF0YS1vbmx5IGVudHJpZXMgZGVsaWJlcmF0ZWx5IG9taXQgaW5zdGFsbCBjb29yZGluYXRlcyBhbmQgYXJlIG5ldmVyXG4gICAqIG9mZmVyZWQgdG8gdGhlIGFyY2hpdmUgaW5zdGFsbGVyLlxuICAqL1xuICBhdmFpbGFibGU/OiBib29sZWFuO1xuICAvKiogUmVtb3RlIHNvdXJjZSBjb29yZGluYXRlcyBhcmUgcmVxdWlyZWQgb25seSBmb3IgcmVtb3RlIGVudHJpZXMuICovXG4gIHJlcG8/OiBzdHJpbmc7XG4gIGFwcHJvdmVkQ29tbWl0U2hhPzogc3RyaW5nO1xuICAvKiogUGFja2FnZWQgZW50cmllcyBwb2ludCBhdCB0aGUgaW5zdGFsbGVyLWJ1bmRsZWQgY2Fub25pY2FsIHNvdXJjZS4gKi9cbiAgc291cmNlPzogVHdlYWtTdG9yZVNvdXJjZTtcbiAgYXBwcm92ZWRBdDogc3RyaW5nO1xuICBhcHByb3ZlZEJ5OiBzdHJpbmc7XG4gIHBsYXRmb3Jtcz86IFR3ZWFrU3RvcmVQbGF0Zm9ybVtdO1xuICByZWxlYXNlVXJsPzogc3RyaW5nO1xuICByZXZpZXdVcmw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrU3RvcmVTb3VyY2UgPVxuICB8IHsga2luZDogXCJidW5kbGVkXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInJlbW90ZVwiOyByZXBvOiBzdHJpbmc7IGFwcHJvdmVkQ29tbWl0U2hhOiBzdHJpbmcgfTtcblxuLyoqIENhbm9uaWNhbCBwcm9qZWN0LW93bmVkIHR3ZWFrIGlkZW50aWZpZXJzIGFuZCBzb3VyY2UgZGlyZWN0b3JpZXMuICovXG5leHBvcnQgY29uc3QgQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0gT2JqZWN0LmZyZWV6ZSh7XG4gIFwiY28udHdlYWtlcnMuYWNjb3VudC1zd2l0Y2hlclwiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5hY2NvdW50LXN3aXRjaGVyXCIsXG4gIFwiY28udHdlYWtlcnMuYXBwc2hvdHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuYXBwc2hvdHNcIixcbiAgXCJjby50d2Vha2Vycy5kZXZlbG9wZXItdG9vbHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuZGV2ZWxvcGVyLXRvb2xzXCIsXG4gIFwiY28udHdlYWtlcnMuc2hhZGNuLWNvZGV4LXVpXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLnNoYWRjbi1jb2RleC11aVwiLFxuICBcImNvLnR3ZWFrZXJzLmZvbGxvd3VwXCI6IFwidHdlYWtzL2ZvbGxvd3VwXCIsXG4gIFwiY28udHdlYWtlcnMucHJvamVjdHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgXCJjby50d2Vha2Vycy50aHJlYWQtc3VtbWFyeS1wcm9maWxlc1wiOiBcInR3ZWFrcy9jby50d2Vha2Vycy50aHJlYWQtc3VtbWFyeS1wcm9maWxlc1wiLFxuICBcImNvLnR3ZWFrZXJzLnRpdGxlYmFyLWNvbnRyb2xzXCI6IFwidHdlYWtzL3RpdGxlYmFyLWNvbnRyb2xzXCIsXG4gIFwiY28udHdlYWtlcnMudWktaW1wcm92ZW1lbnRzXCI6IFwidHdlYWtzL3VpLWltcHJvdmVtZW50c1wiLFxuICBcImNvLnR3ZWFrZXJzLnVzZXItcXVlc3Rpb25zXCI6IFwidHdlYWtzL3VzZXItcXVlc3Rpb25zXCIsXG4gIFwiY28udHdlYWtlcnMudXNhZ2UtbGltaXQtcmVzZXRzLXRyYWNrZXJcIjogXCJ0d2Vha3MvdXNhZ2UtbGltaXQtcmVzZXRzLXRyYWNrZXJcIixcbn0pO1xuXG5leHBvcnQgdHlwZSBUd2Vha0hlYWx0aFN0YXR1cyA9IFwiZmFpbGVkXCIgfCBcInF1YXJhbnRpbmVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtIZWFsdGhSZWNvcmQge1xuICBzdGF0dXM6IFR3ZWFrSGVhbHRoU3RhdHVzO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgdXNlci1mYWNpbmcgc3RhdGUgdm9jYWJ1bGFyeSBmb3IgY2F0YWxvZyByb3dzLiAqL1xuZXhwb3J0IHR5cGUgVHdlYWtTdGF0dXMgPVxuICB8IFwiaW5zdGFsbGVkXCJcbiAgfCBcIm5vdC1pbnN0YWxsZWRcIlxuICB8IFwiZW5hYmxlZFwiXG4gIHwgXCJkaXNhYmxlZFwiXG4gIHwgXCJmYWlsZWRcIlxuICB8IFwicXVhcmFudGluZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0YXR1c0lucHV0IHtcbiAgaW5zdGFsbGVkOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBoZWFsdGg/OiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVUd2Vha1N0YXR1cyhpbnB1dDogVHdlYWtTdGF0dXNJbnB1dCk6IFR3ZWFrU3RhdHVzIHtcbiAgaWYgKCFpbnB1dC5pbnN0YWxsZWQpIHJldHVybiBcIm5vdC1pbnN0YWxsZWRcIjtcbiAgaWYgKGlucHV0LmhlYWx0aD8uc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIpIHJldHVybiBcInF1YXJhbnRpbmVkXCI7XG4gIGlmIChpbnB1dC5oZWFsdGg/LnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZmFpbGVkXCI7XG4gIHJldHVybiBpbnB1dC5lbmFibGVkID8gXCJlbmFibGVkXCIgOiBcImRpc2FibGVkXCI7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrU3RvcmVQbGF0Zm9ybSA9IFwiZGFyd2luXCIgfCBcIndpbjMyXCIgfCBcImxpbnV4XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uIHtcbiAgcmVwbzogc3RyaW5nO1xuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmc7XG4gIGNvbW1pdFNoYTogc3RyaW5nO1xuICBjb21taXRVcmw6IHN0cmluZztcbiAgbWFuaWZlc3Q/OiB7XG4gICAgaWQ/OiBzdHJpbmc7XG4gICAgbmFtZT86IHN0cmluZztcbiAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICAgIGljb25Vcmw/OiBzdHJpbmc7XG4gIH07XG59XG5cbmNvbnN0IEdJVEhVQl9SRVBPX1JFID0gL15bQS1aYS16MC05Xy4tXStcXC9bQS1aYS16MC05Xy4tXSskLztcbmNvbnN0IEZVTExfU0hBX1JFID0gL15bYS1mMC05XXs0MH0kL2k7XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVHaXRIdWJSZXBvKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByYXcgPSBpbnB1dC50cmltKCk7XG4gIGlmICghcmF3KSB0aHJvdyBuZXcgRXJyb3IoXCJHaXRIdWIgcmVwbyBpcyByZXF1aXJlZFwiKTtcblxuICBjb25zdCBzc2ggPSAvXmdpdEBnaXRodWJcXC5jb206KFteL10rXFwvW14vXSs/KSg/OlxcLmdpdCk/JC9pLmV4ZWMocmF3KTtcbiAgaWYgKHNzaCkgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KHNzaFsxXSk7XG5cbiAgaWYgKC9eaHR0cHM/OlxcL1xcLy9pLnRlc3QocmF3KSkge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLmhvc3RuYW1lICE9PSBcImdpdGh1Yi5jb21cIikgdGhyb3cgbmV3IEVycm9yKFwiT25seSBnaXRodWIuY29tIHJlcG9zaXRvcmllcyBhcmUgc3VwcG9ydGVkXCIpO1xuICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnJlcGxhY2UoL15cXC8rfFxcLyskL2csIFwiXCIpLnNwbGl0KFwiL1wiKTtcbiAgICBpZiAocGFydHMubGVuZ3RoIDwgMikgdGhyb3cgbmV3IEVycm9yKFwiR2l0SHViIHJlcG8gVVJMIG11c3QgaW5jbHVkZSBvd25lciBhbmQgcmVwb3NpdG9yeVwiKTtcbiAgICByZXR1cm4gbm9ybWFsaXplUmVwb1BhcnQoYCR7cGFydHNbMF19LyR7cGFydHNbMV19YCk7XG4gIH1cblxuICByZXR1cm4gbm9ybWFsaXplUmVwb1BhcnQocmF3KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlUmVnaXN0cnkoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlUmVnaXN0cnkge1xuICBjb25zdCByZWdpc3RyeSA9IGlucHV0IGFzIFBhcnRpYWw8VHdlYWtTdG9yZVJlZ2lzdHJ5PiB8IG51bGw7XG4gIGlmICghcmVnaXN0cnkgfHwgcmVnaXN0cnkuc2NoZW1hVmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShyZWdpc3RyeS5lbnRyaWVzKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIHR3ZWFrIHN0b3JlIHJlZ2lzdHJ5XCIpO1xuICB9XG4gIGNvbnN0IGVudHJpZXMgPSByZWdpc3RyeS5lbnRyaWVzLm1hcChub3JtYWxpemVTdG9yZUVudHJ5KTtcbiAgZW50cmllcy5zb3J0KChhLCBiKSA9PiBhLm1hbmlmZXN0Lm5hbWUubG9jYWxlQ29tcGFyZShiLm1hbmlmZXN0Lm5hbWUpKTtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIGdlbmVyYXRlZEF0OiB0eXBlb2YgcmVnaXN0cnkuZ2VuZXJhdGVkQXQgPT09IFwic3RyaW5nXCIgPyByZWdpc3RyeS5nZW5lcmF0ZWRBdCA6IHVuZGVmaW5lZCxcbiAgICBlbnRyaWVzLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2h1ZmZsZVN0b3JlRW50cmllczxUPihcbiAgZW50cmllczogcmVhZG9ubHkgVFtdLFxuICByYW5kb21JbmRleDogKGV4Y2x1c2l2ZU1heDogbnVtYmVyKSA9PiBudW1iZXIgPSAoZXhjbHVzaXZlTWF4KSA9PiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBleGNsdXNpdmVNYXgpLFxuKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uZW50cmllc107XG4gIGZvciAobGV0IGkgPSBzaHVmZmxlZC5sZW5ndGggLSAxOyBpID4gMDsgaSAtPSAxKSB7XG4gICAgY29uc3QgaiA9IHJhbmRvbUluZGV4KGkgKyAxKTtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoaikgfHwgaiA8IDAgfHwgaiA+IGkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgc2h1ZmZsZSByYW5kb21JbmRleCByZXR1cm5lZCAke2p9OyBleHBlY3RlZCBhbiBpbnRlZ2VyIGZyb20gMCB0byAke2l9YCk7XG4gICAgfVxuICAgIFtzaHVmZmxlZFtpXSwgc2h1ZmZsZWRbal1dID0gW3NodWZmbGVkW2pdLCBzaHVmZmxlZFtpXV07XG4gIH1cbiAgcmV0dXJuIHNodWZmbGVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3RvcmVFbnRyeShpbnB1dDogdW5rbm93bik6IFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGNvbnN0IGVudHJ5ID0gaW5wdXQgYXMgUGFydGlhbDxUd2Vha1N0b3JlRW50cnk+IHwgbnVsbDtcbiAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgdHdlYWsgc3RvcmUgZW50cnlcIik7XG4gIGNvbnN0IG1hbmlmZXN0ID0gZW50cnkubWFuaWZlc3QgYXMgVHdlYWtNYW5pZmVzdCB8IHVuZGVmaW5lZDtcbiAgY29uc3QgYXZhaWxhYmxlID0gZW50cnkuYXZhaWxhYmxlICE9PSBmYWxzZTtcbiAgaWYgKCFtYW5pZmVzdD8uaWQgfHwgIW1hbmlmZXN0Lm5hbWUgfHwgIW1hbmlmZXN0LnZlcnNpb24gfHwgIW1hbmlmZXN0LmdpdGh1YlJlcG8pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJTdG9yZSBlbnRyeSBpcyBtaXNzaW5nIG1hbmlmZXN0IGZpZWxkc1wiKTtcbiAgfVxuICBjb25zdCBzdXBwbGllZFJlcG8gPSB0eXBlb2YgZW50cnkucmVwbyA9PT0gXCJzdHJpbmdcIiAmJiBlbnRyeS5yZXBvLnRyaW0oKVxuICAgID8gbm9ybWFsaXplR2l0SHViUmVwbyhlbnRyeS5yZXBvKVxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoc3VwcGxpZWRSZXBvICYmIG5vcm1hbGl6ZUdpdEh1YlJlcG8obWFuaWZlc3QuZ2l0aHViUmVwbykgIT09IHN1cHBsaWVkUmVwbykge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gcmVwbyBkb2VzIG5vdCBtYXRjaCBtYW5pZmVzdCBnaXRodWJSZXBvYCk7XG4gIH1cbiAgY29uc3Qgc291cmNlSW5wdXQgPSAoZW50cnkgYXMgeyBzb3VyY2U/OiB1bmtub3duIH0pLnNvdXJjZTtcbiAgbGV0IHNvdXJjZTogVHdlYWtTdG9yZVNvdXJjZSB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlcG8gPSBzdXBwbGllZFJlcG87XG4gIGxldCBhcHByb3ZlZENvbW1pdFNoYSA9IHR5cGVvZiBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA9PT0gXCJzdHJpbmdcIiA/IGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhIDogXCJcIjtcbiAgaWYgKHNvdXJjZUlucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIXNvdXJjZUlucHV0IHx8IHR5cGVvZiBzb3VyY2VJbnB1dCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHNvdXJjZUlucHV0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBoYXMgYW4gaW52YWxpZCBzb3VyY2VgKTtcbiAgICB9XG4gICAgY29uc3QgcmF3U291cmNlID0gc291cmNlSW5wdXQgYXMgeyBraW5kPzogdW5rbm93bjsgcGF0aD86IHVua25vd247IHJlcG8/OiB1bmtub3duOyBhcHByb3ZlZENvbW1pdFNoYT86IHVua25vd24gfTtcbiAgICBpZiAocmF3U291cmNlLmtpbmQgPT09IFwiYnVuZGxlZFwiKSB7XG4gICAgICBjb25zdCBwYXRoID0gbm9ybWFsaXplQnVuZGxlZFNvdXJjZVBhdGgocmF3U291cmNlLnBhdGgsIG1hbmlmZXN0LmlkKTtcbiAgICAgIHNvdXJjZSA9IHsga2luZDogXCJidW5kbGVkXCIsIHBhdGggfTtcbiAgICAgIC8vIEEgYnVuZGxlZCBzb3VyY2UgaXMgaW50ZW50aW9uYWxseSBpbmRlcGVuZGVudCBvZiBHaXRIdWIgY29vcmRpbmF0ZXMuXG4gICAgICByZXBvID0gc3VwcGxpZWRSZXBvO1xuICAgICAgYXBwcm92ZWRDb21taXRTaGEgPSBcIlwiO1xuICAgIH0gZWxzZSBpZiAocmF3U291cmNlLmtpbmQgPT09IFwicmVtb3RlXCIpIHtcbiAgICAgIGNvbnN0IHJlbW90ZVJlcG8gPSBub3JtYWxpemVHaXRIdWJSZXBvKFN0cmluZyhyYXdTb3VyY2UucmVwbyA/PyBzdXBwbGllZFJlcG8gPz8gXCJcIikpO1xuICAgICAgY29uc3Qgc2hhID0gU3RyaW5nKHJhd1NvdXJjZS5hcHByb3ZlZENvbW1pdFNoYSA/PyBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA/PyBcIlwiKTtcbiAgICAgIGlmIChhdmFpbGFibGUgJiYgIWlzRnVsbENvbW1pdFNoYShzaGEpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gbXVzdCBwaW4gYSBmdWxsIGFwcHJvdmVkIGNvbW1pdCBTSEFgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdXBwbGllZFJlcG8gJiYgc3VwcGxpZWRSZXBvICE9PSByZW1vdGVSZXBvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gcmVtb3RlIHNvdXJjZSByZXBvIGRvZXMgbm90IG1hdGNoIHJlcG9gKTtcbiAgICAgIH1cbiAgICAgIHNvdXJjZSA9IHsga2luZDogXCJyZW1vdGVcIiwgcmVwbzogcmVtb3RlUmVwbywgYXBwcm92ZWRDb21taXRTaGE6IHNoYSB9O1xuICAgICAgcmVwbyA9IHJlbW90ZVJlcG87XG4gICAgICBhcHByb3ZlZENvbW1pdFNoYSA9IHNoYTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBoYXMgdW5zdXBwb3J0ZWQgc291cmNlIGtpbmRgKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoYXZhaWxhYmxlKSB7XG4gICAgLy8gTGVnYWN5IGF2YWlsYWJsZSBlbnRyaWVzIGFyZSByZW1vdGUgYW5kIG11c3QgcmVtYWluIHBpbm5lZC5cbiAgICByZXBvID0gbm9ybWFsaXplR2l0SHViUmVwbyhTdHJpbmcocmVwbyA/PyBtYW5pZmVzdC5naXRodWJSZXBvID8/IFwiXCIpKTtcbiAgICBpZiAoIWlzRnVsbENvbW1pdFNoYShhcHByb3ZlZENvbW1pdFNoYSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gbXVzdCBwaW4gYSBmdWxsIGFwcHJvdmVkIGNvbW1pdCBTSEFgKTtcbiAgICB9XG4gICAgc291cmNlID0geyBraW5kOiBcInJlbW90ZVwiLCByZXBvLCBhcHByb3ZlZENvbW1pdFNoYSB9O1xuICB9IGVsc2UgaWYgKCFyZXBvKSB7XG4gICAgLy8gTWV0YWRhdGEtb25seSBlbnRyaWVzIG1heSBvbWl0IGFsbCBpbnN0YWxsIGNvb3JkaW5hdGVzLiBLZWVwIHRoZSBzb3VyY2VcbiAgICAvLyBhYnNlbnQgc28gY2FsbGVycyBjYW5ub3QgYWNjaWRlbnRhbGx5IHRyZWF0IHRoZW0gYXMgaW5zdGFsbGFibGUuXG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZDogbWFuaWZlc3QuaWQsXG4gICAgbWFuaWZlc3QsXG4gICAgYXZhaWxhYmxlLFxuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgYXBwcm92ZWRDb21taXRTaGEsXG4gICAgLi4uKHNvdXJjZSA/IHsgc291cmNlIH0gOiB7fSksXG4gICAgYXBwcm92ZWRBdDogdHlwZW9mIGVudHJ5LmFwcHJvdmVkQXQgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZEF0IDogXCJcIixcbiAgICBhcHByb3ZlZEJ5OiB0eXBlb2YgZW50cnkuYXBwcm92ZWRCeSA9PT0gXCJzdHJpbmdcIiA/IGVudHJ5LmFwcHJvdmVkQnkgOiBcIlwiLFxuICAgIHBsYXRmb3Jtczogbm9ybWFsaXplU3RvcmVQbGF0Zm9ybXMoKGVudHJ5IGFzIHsgcGxhdGZvcm1zPzogdW5rbm93biB9KS5wbGF0Zm9ybXMpLFxuICAgIHJlbGVhc2VVcmw6IG9wdGlvbmFsR2l0aHViVXJsKGVudHJ5LnJlbGVhc2VVcmwpLFxuICAgIHJldmlld1VybDogb3B0aW9uYWxHaXRodWJVcmwoZW50cnkucmV2aWV3VXJsKSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0b3JlQXJjaGl2ZVVybChlbnRyeTogVHdlYWtTdG9yZUVudHJ5KTogc3RyaW5nIHtcbiAgaWYgKGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJidW5kbGVkXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7ZW50cnkuaWR9IHVzZXMgYSBidW5kbGVkIHNvdXJjZSBhbmQgaGFzIG5vIGFyY2hpdmUgVVJMYCk7XG4gIH1cbiAgY29uc3QgcmVwbyA9IGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJyZW1vdGVcIiA/IGVudHJ5LnNvdXJjZS5yZXBvIDogZW50cnkucmVwbztcbiAgY29uc3QgYXBwcm92ZWRDb21taXRTaGEgPSBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwicmVtb3RlXCJcbiAgICA/IGVudHJ5LnNvdXJjZS5hcHByb3ZlZENvbW1pdFNoYVxuICAgIDogZW50cnkuYXBwcm92ZWRDb21taXRTaGE7XG4gIGlmICghcmVwbyB8fCAhaXNGdWxsQ29tbWl0U2hhKGFwcHJvdmVkQ29tbWl0U2hhID8/IFwiXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBpcyBub3QgcGlubmVkIHRvIGEgZnVsbCBjb21taXQgU0hBYCk7XG4gIH1cbiAgcmV0dXJuIGBodHRwczovL2NvZGVsb2FkLmdpdGh1Yi5jb20vJHtyZXBvfS90YXIuZ3ovJHthcHByb3ZlZENvbW1pdFNoYX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNCdW5kbGVkU3RvcmVFbnRyeShlbnRyeTogVHdlYWtTdG9yZUVudHJ5KTogYm9vbGVhbiB7XG4gIHJldHVybiBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwiYnVuZGxlZFwiO1xufVxuXG4vKiogUmVzb2x2ZSBhIHBhY2thZ2VkIHNvdXJjZSB3aGlsZSByZWplY3RpbmcgdHJhdmVyc2FsIGFuZCBJRCBtaXNtYXRjaGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVCdW5kbGVkVHdlYWtQYXRoKFxuICBwYWNrYWdlZFR3ZWFrc1Jvb3Q6IHN0cmluZyxcbiAgZW50cnk6IFBpY2s8VHdlYWtTdG9yZUVudHJ5LCBcImlkXCIgfCBcInNvdXJjZVwiPixcbik6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5zb3VyY2U/LmtpbmQgIT09IFwiYnVuZGxlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBkb2VzIG5vdCB1c2UgYSBidW5kbGVkIHNvdXJjZWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBlbnRyeS5zb3VyY2UucGF0aC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIik7XG4gIGlmIChcbiAgICAhbm9ybWFsaXplZCB8fFxuICAgIG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICBub3JtYWxpemVkLnNwbGl0KFwiL1wiKS5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSBcIi4uXCIgfHwgcGFydCA9PT0gXCJcIikgfHxcbiAgICBub3JtYWxpemVkICE9PSBCVU5ETEVEX1RXRUFLX1NPVVJDRV9QQVRIU1tlbnRyeS5pZF1cbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBoYXMgYW4gdW5zYWZlIGJ1bmRsZWQgc291cmNlIHBhdGhgKTtcbiAgfVxuICAvLyBUaGUgbm9ybWFsaXplZCBwYXRoIGlzIGV4YWN0bHkgYHR3ZWFrcy88aWQ+YCAobm8gZG90IHNlZ21lbnRzKSwgc28gYVxuICAvLyBzaW1wbGUgam9pbiBpcyBzdWZmaWNpZW50IGFuZCBrZWVwcyB0aGlzIHNoYXJlZCBtb2R1bGUgYnJvd3Nlci1idW5kbGVhYmxlLlxuICBjb25zdCByb290ID0gcGFja2FnZWRUd2Vha3NSb290LnJlcGxhY2UoL1tcXFxcL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7cm9vdH0vJHtub3JtYWxpemVkfWA7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJ1bmRsZWRTb3VyY2VQYXRoKHZhbHVlOiB1bmtub3duLCBpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2lkfSBidW5kbGVkIHNvdXJjZSBwYXRoIGlzIHJlcXVpcmVkYCk7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikucmVwbGFjZSgvXlxcLlxcLy8sIFwiXCIpO1xuICBpZiAobm9ybWFsaXplZCAhPT0gQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFNbaWRdKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2lkfSBidW5kbGVkIHNvdXJjZSBpcyBub3QgYWxsb3dsaXN0ZWRgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwoc3VibWlzc2lvbjogVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwbyA9IG5vcm1hbGl6ZUdpdEh1YlJlcG8oc3VibWlzc2lvbi5yZXBvKTtcbiAgaWYgKCFpc0Z1bGxDb21taXRTaGEoc3VibWlzc2lvbi5jb21taXRTaGEpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiU3VibWlzc2lvbiBtdXN0IGluY2x1ZGUgdGhlIGZ1bGwgY29tbWl0IFNIQSB0byByZXZpZXdcIik7XG4gIH1cbiAgY29uc3QgdGl0bGUgPSBgVHdlYWsgc3RvcmUgcmV2aWV3OiAke3JlcG99YDtcbiAgY29uc3QgYm9keSA9IFtcbiAgICBcIiMjIFR3ZWFrIHJlcG9cIixcbiAgICBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb31gLFxuICAgIFwiXCIsXG4gICAgXCIjIyBDb21taXQgdG8gcmV2aWV3XCIsXG4gICAgc3VibWlzc2lvbi5jb21taXRTaGEsXG4gICAgc3VibWlzc2lvbi5jb21taXRVcmwsXG4gICAgXCJcIixcbiAgICBcIkRvIG5vdCBhcHByb3ZlIGEgZGlmZmVyZW50IGNvbW1pdC4gSWYgdGhlIGF1dGhvciBwdXNoZXMgY2hhbmdlcywgYXNrIHRoZW0gdG8gcmVzdWJtaXQuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIE1hbmlmZXN0XCIsXG4gICAgYC0gaWQ6ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8uaWQgPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gbmFtZTogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5uYW1lID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIHZlcnNpb246ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8udmVyc2lvbiA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSBkZXNjcmlwdGlvbjogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5kZXNjcmlwdGlvbiA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSBpY29uVXJsOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/Lmljb25VcmwgPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgXCJcIixcbiAgICBcIiMjIEFkbWluIGNoZWNrbGlzdFwiLFxuICAgIFwiLSBbIF0gbWFuaWZlc3QuanNvbiBpcyB2YWxpZFwiLFxuICAgIFwiLSBbIF0gbWFuaWZlc3QuaWNvblVybCBpcyB1c2FibGUgYXMgdGhlIHN0b3JlIGljb25cIixcbiAgICBcIi0gWyBdIHNvdXJjZSB3YXMgcmV2aWV3ZWQgYXQgdGhlIGV4YWN0IGNvbW1pdCBhYm92ZVwiLFxuICAgIFwiLSBbIF0gYHN0b3JlL2luZGV4Lmpzb25gIGVudHJ5IHBpbnMgYGFwcHJvdmVkQ29tbWl0U2hhYCB0byB0aGUgZXhhY3QgY29tbWl0IGFib3ZlXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChUV0VBS19TVE9SRV9SRVZJRVdfSVNTVUVfVVJMKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJ0ZW1wbGF0ZVwiLCBcInR3ZWFrLXN0b3JlLXJldmlldy5tZFwiKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJ0aXRsZVwiLCB0aXRsZSk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwiYm9keVwiLCBib2R5KTtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNGdWxsQ29tbWl0U2hhKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIEZVTExfU0hBX1JFLnRlc3QodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXBvUGFydCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwbyA9IHZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cXC5naXQkL2ksIFwiXCIpLnJlcGxhY2UoL15cXC8rfFxcLyskL2csIFwiXCIpO1xuICBpZiAoIUdJVEhVQl9SRVBPX1JFLnRlc3QocmVwbykpIHRocm93IG5ldyBFcnJvcihcIkdpdEh1YiByZXBvIG11c3QgYmUgaW4gb3duZXIvcmVwbyBmb3JtXCIpO1xuICByZXR1cm4gcmVwbztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RvcmVQbGF0Zm9ybXMoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlUGxhdGZvcm1bXSB8IHVuZGVmaW5lZCB7XG4gIGlmIChpbnB1dCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQpKSB0aHJvdyBuZXcgRXJyb3IoXCJTdG9yZSBlbnRyeSBwbGF0Zm9ybXMgbXVzdCBiZSBhbiBhcnJheVwiKTtcbiAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQ8VHdlYWtTdG9yZVBsYXRmb3JtPihbXCJkYXJ3aW5cIiwgXCJ3aW4zMlwiLCBcImxpbnV4XCJdKTtcbiAgY29uc3QgcGxhdGZvcm1zID0gQXJyYXkuZnJvbShuZXcgU2V0KGlucHV0Lm1hcCgodmFsdWUpID0+IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICFhbGxvd2VkLmhhcyh2YWx1ZSBhcyBUd2Vha1N0b3JlUGxhdGZvcm0pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHN0b3JlIHBsYXRmb3JtOiAke1N0cmluZyh2YWx1ZSl9YCk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZSBhcyBUd2Vha1N0b3JlUGxhdGZvcm07XG4gIH0pKSk7XG4gIHJldHVybiBwbGF0Zm9ybXMubGVuZ3RoID4gMCA/IHBsYXRmb3JtcyA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gb3B0aW9uYWxHaXRodWJVcmwodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICF2YWx1ZS50cmltKCkpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwodmFsdWUpO1xuICBpZiAodXJsLnByb3RvY29sICE9PSBcImh0dHBzOlwiIHx8IHVybC5ob3N0bmFtZSAhPT0gXCJnaXRodWIuY29tXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrIHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBpY29uVXJsPzogc3RyaW5nO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzdGF0dXM6IHN0cmluZztcbiAgaGVhbHRoRXJyb3I/OiBzdHJpbmcgfCBudWxsO1xuICBsaWZlY3ljbGVPdmVycmlkZT86IFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc1BhZ2VSZWdpc3RyYXRpb25TdW1tYXJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgdHdlYWtJZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgaWNvblN2Zz86IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlID1cbiAgfCBcImVuYWJsZWRcIlxuICB8IFwiZmFpbGVkXCJcbiAgfCBcInF1YXJhbnRpbmVkXCJcbiAgfCBcInN0YXJ0aW5nXCJcbiAgfCBcInRpbWVkX291dFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0ge1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgaWNvblVybD86IHN0cmluZztcbiAgaWNvblN2Zz86IHN0cmluZztcbiAgcmVnaXN0cmF0aW9uSWRzOiBzdHJpbmdbXTtcbiAgZmFsbGJhY2s6IGJvb2xlYW47XG4gIGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlO1xuICB3YXJuaW5nOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZXR0aW5nc05hdmlnYXRpb25Nb2RlbChcbiAgdHdlYWtzOiBTZXR0aW5nc05hdmlnYXRpb25Ud2Vha1tdLFxuICByZWdpc3RyYXRpb25zOiBTZXR0aW5nc1BhZ2VSZWdpc3RyYXRpb25TdW1tYXJ5W10sXG4pOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW10ge1xuICBjb25zdCByZWdpc3RyYXRpb25zQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nc1BhZ2VSZWdpc3RyYXRpb25TdW1tYXJ5W10+KCk7XG4gIGZvciAoY29uc3QgcmVnaXN0cmF0aW9uIG9mIHJlZ2lzdHJhdGlvbnMpIHtcbiAgICBjb25zdCBncm91cCA9IHJlZ2lzdHJhdGlvbnNCeVR3ZWFrLmdldChyZWdpc3RyYXRpb24udHdlYWtJZCkgPz8gW107XG4gICAgZ3JvdXAucHVzaChyZWdpc3RyYXRpb24pO1xuICAgIHJlZ2lzdHJhdGlvbnNCeVR3ZWFrLnNldChyZWdpc3RyYXRpb24udHdlYWtJZCwgZ3JvdXApO1xuICB9XG5cbiAgY29uc3Qgcm93czogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB0d2VhayBvZiB0d2Vha3MpIHtcbiAgICBpZiAoIXR3ZWFrLmVuYWJsZWQgfHwgc2Vlbi5oYXModHdlYWsuaWQpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZCh0d2Vhay5pZCk7XG4gICAgY29uc3QgcGFnZXMgPSByZWdpc3RyYXRpb25zQnlUd2Vhay5nZXQodHdlYWsuaWQpID8/IFtdO1xuICAgIGNvbnN0IHByaW1hcnkgPSBwYWdlc1swXTtcbiAgICByb3dzLnB1c2goe1xuICAgICAgdHdlYWtJZDogdHdlYWsuaWQsXG4gICAgICB0aXRsZTogcHJpbWFyeT8udGl0bGUgfHwgdHdlYWsubmFtZSxcbiAgICAgIHZlcnNpb246IHR3ZWFrLnZlcnNpb24sXG4gICAgICBkZXNjcmlwdGlvbjogcHJpbWFyeT8uZGVzY3JpcHRpb24gfHwgdHdlYWsuZGVzY3JpcHRpb24gfHwgXCJFbmFibGVkIFR3ZWFrZXIuXCIsXG4gICAgICBpY29uVXJsOiB0d2Vhay5pY29uVXJsLFxuICAgICAgaWNvblN2ZzogcHJpbWFyeT8uaWNvblN2ZyxcbiAgICAgIHJlZ2lzdHJhdGlvbklkczogcGFnZXMubWFwKChwYWdlKSA9PiBwYWdlLmlkKSxcbiAgICAgIGZhbGxiYWNrOiBwYWdlcy5sZW5ndGggPT09IDAsXG4gICAgICBsaWZlY3ljbGU6IGxpZmVjeWNsZUZvcih0d2VhayksXG4gICAgICB3YXJuaW5nOiB0d2Vhay5oZWFsdGhFcnJvciB8fCBudWxsLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiByb3dzLnNvcnQoKGEsIGIpID0+IGEudGl0bGUubG9jYWxlQ29tcGFyZShiLnRpdGxlKSB8fCBhLnR3ZWFrSWQubG9jYWxlQ29tcGFyZShiLnR3ZWFrSWQpKTtcbn1cblxuZnVuY3Rpb24gbGlmZWN5Y2xlRm9yKHR3ZWFrOiBTZXR0aW5nc05hdmlnYXRpb25Ud2Vhayk6IFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZSB7XG4gIGlmICh0d2Vhay5saWZlY3ljbGVPdmVycmlkZSkgcmV0dXJuIHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJmYWlsZWRcIjtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiKSByZXR1cm4gXCJxdWFyYW50aW5lZFwiO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcInN0YXJ0aW5nXCIpIHJldHVybiBcInN0YXJ0aW5nXCI7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwidGltZWRfb3V0XCIpIHJldHVybiBcInRpbWVkX291dFwiO1xuICByZXR1cm4gXCJlbmFibGVkXCI7XG59XG4iLCAiaW1wb3J0IHR5cGUgeyBUd2Vha01hbmlmZXN0IH0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuaW1wb3J0IHR5cGUgeyBUd2Vha1N0YXR1cyB9IGZyb20gXCIuLi90d2Vhay1zdG9yZVwiO1xuXG5leHBvcnQgdHlwZSBUd2Vha3NQYWdlRmlsdGVyID0gXCJhbGxcIiB8IFwiZW5hYmxlZFwiIHwgXCJkaXNhYmxlZFwiIHwgXCJ1cGRhdGVzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtzUGFnZUl0ZW0ge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgaW5zdGFsbGVkOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzdGF0dXM6IFR3ZWFrU3RhdHVzO1xuICB1cGRhdGU6IHsgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuIH0gfCBudWxsO1xufVxuXG5leHBvcnQgdHlwZSBUd2Vha3NQYWdlQ291bnRzID0gUmVjb3JkPFR3ZWFrc1BhZ2VGaWx0ZXIsIG51bWJlcj47XG5cbmV4cG9ydCBjb25zdCBUV0VBS1NfUEFHRV9GSUxURVJTOiByZWFkb25seSBUd2Vha3NQYWdlRmlsdGVyW10gPSBbXG4gIFwiYWxsXCIsXG4gIFwiZW5hYmxlZFwiLFxuICBcImRpc2FibGVkXCIsXG4gIFwidXBkYXRlc1wiLFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIHR3ZWFrc1BhZ2VDb3VudHMoaXRlbXM6IHJlYWRvbmx5IFR3ZWFrc1BhZ2VJdGVtW10pOiBUd2Vha3NQYWdlQ291bnRzIHtcbiAgcmV0dXJuIHtcbiAgICBhbGw6IGl0ZW1zLmxlbmd0aCxcbiAgICBlbmFibGVkOiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IG1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKGl0ZW0sIFwiZW5hYmxlZFwiKSkubGVuZ3RoLFxuICAgIGRpc2FibGVkOiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IG1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKGl0ZW0sIFwiZGlzYWJsZWRcIikpLmxlbmd0aCxcbiAgICB1cGRhdGVzOiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IG1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKGl0ZW0sIFwidXBkYXRlc1wiKSkubGVuZ3RoLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZmlsdGVyVHdlYWtzUGFnZUl0ZW1zPFQgZXh0ZW5kcyBUd2Vha3NQYWdlSXRlbT4oXG4gIGl0ZW1zOiByZWFkb25seSBUW10sXG4gIGZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcixcbiAgcXVlcnk6IHN0cmluZyxcbik6IFRbXSB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRRdWVyeSA9IG5vcm1hbGl6ZVR3ZWFrc1BhZ2VTZWFyY2gocXVlcnkpO1xuICByZXR1cm4gaXRlbXMuZmlsdGVyKChpdGVtKSA9PiB7XG4gICAgaWYgKCFtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBmaWx0ZXIpKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCFub3JtYWxpemVkUXVlcnkpIHJldHVybiB0cnVlO1xuICAgIHJldHVybiB0d2Vha3NQYWdlU2VhcmNoVGV4dChpdGVtKS5pbmNsdWRlcyhub3JtYWxpemVkUXVlcnkpO1xuICB9KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKFxuICBpdGVtOiBUd2Vha3NQYWdlSXRlbSxcbiAgZmlsdGVyOiBUd2Vha3NQYWdlRmlsdGVyLFxuKTogYm9vbGVhbiB7XG4gIGlmIChmaWx0ZXIgPT09IFwiZW5hYmxlZFwiKSByZXR1cm4gaXRlbS5pbnN0YWxsZWQgJiYgaXRlbS5lbmFibGVkO1xuICBpZiAoZmlsdGVyID09PSBcImRpc2FibGVkXCIpIHJldHVybiBpdGVtLmluc3RhbGxlZCAmJiAhaXRlbS5lbmFibGVkO1xuICBpZiAoZmlsdGVyID09PSBcInVwZGF0ZXNcIikgcmV0dXJuIGl0ZW0udXBkYXRlPy51cGRhdGVBdmFpbGFibGUgPT09IHRydWU7XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gdHdlYWtzUGFnZVNlYXJjaFRleHQoaXRlbTogVHdlYWtzUGFnZUl0ZW0pOiBzdHJpbmcge1xuICBjb25zdCBhdXRob3IgPSB0eXBlb2YgaXRlbS5tYW5pZmVzdC5hdXRob3IgPT09IFwic3RyaW5nXCJcbiAgICA/IGl0ZW0ubWFuaWZlc3QuYXV0aG9yXG4gICAgOiBpdGVtLm1hbmlmZXN0LmF1dGhvcj8ubmFtZTtcbiAgcmV0dXJuIG5vcm1hbGl6ZVR3ZWFrc1BhZ2VTZWFyY2goW1xuICAgIGl0ZW0ubWFuaWZlc3QubmFtZSxcbiAgICBpdGVtLm1hbmlmZXN0LmRlc2NyaXB0aW9uLFxuICAgIGF1dGhvcixcbiAgICBpdGVtLm1hbmlmZXN0LmdpdGh1YlJlcG8sXG4gICAgaXRlbS5tYW5pZmVzdC5ob21lcGFnZSxcbiAgICBpdGVtLm1hbmlmZXN0LnZlcnNpb24sXG4gICAgLi4uKGl0ZW0ubWFuaWZlc3QudGFncyA/PyBbXSksXG4gICAgaXRlbS5zdGF0dXMsXG4gICAgaXRlbS5lbmFibGVkID8gXCJlbmFibGVkXCIgOiBcImRpc2FibGVkXCIsXG4gICAgaXRlbS51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSA/IFwidXBkYXRlIGF2YWlsYWJsZVwiIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIikpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVUd2Vha3NQYWdlU2VhcmNoKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWVcbiAgICAudG9Mb2NhbGVMb3dlckNhc2UoKVxuICAgIC5ub3JtYWxpemUoXCJORkRcIilcbiAgICAucmVwbGFjZSgvW1xcdTAzMDAtXFx1MDM2Zl0vZywgXCJcIilcbiAgICAucmVwbGFjZSgvW1xcdTIwMThcXHUyMDE5YFxcdTAwYjRdL2csIFwiJ1wiKVxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKVxuICAgIC50cmltKCk7XG59XG4iLCAiZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlID0gXCJjaGF0Z3B0XCIgfCBcInR3ZWFrZXJzXCI7XG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlID0gXCJzdGFibGVcIiB8IFwiYWxwaGFcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIge1xuICBhcHBFeHBlcmllbmNlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2U7XG4gIHJlbGVhc2VQcm9maWxlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlO1xufVxuXG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uID0gXCJjb25maXJtXCIgfCBcImNhbmNlbFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnRWZmZWN0czxSZWNlaXB0PiB7XG4gIHByZXBhcmUoc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiBQcm9taXNlPFJlY2VpcHQ+O1xuICBjb25maXJtKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLCByZWNlaXB0OiBSZWNlaXB0KTogUHJvbWlzZTxFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uPjtcbiAgY29tbWl0KHJlY2VpcHQ6IFJlY2VpcHQpOiBQcm9taXNlPHZvaWQ+O1xuICBjYW5jZWwocmVjZWlwdDogUmVjZWlwdCk6IFByb21pc2U8dm9pZD47XG59XG5cbmV4cG9ydCB0eXBlIEVudmlyb25tZW50Q29uZmlnUGhhc2UgPVxuICB8IFwiaWRsZVwiXG4gIHwgXCJwcmVwYXJpbmdcIlxuICB8IFwiYXdhaXRpbmctY29uZmlybWF0aW9uXCJcbiAgfCBcImNvbW1pdHRpbmdcIlxuICB8IFwiY2FuY2VsbGluZ1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnU25hcHNob3Qge1xuICBzZWxlY3RlZDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyO1xuICBwZW5kaW5nOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXI7XG4gIGhhc1BlbmRpbmdDaGFuZ2VzOiBib29sZWFuO1xuICBidXN5OiBib29sZWFuO1xuICBwaGFzZTogRW52aXJvbm1lbnRDb25maWdQaGFzZTtcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG59XG5cbmV4cG9ydCB0eXBlIEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+ID1cbiAgfCB7IG91dGNvbWU6IFwibm8tY2hhbmdlXCIgfCBcImJ1c3lcIiB9XG4gIHwgeyBvdXRjb21lOiBcInN1Ym1pdHRlZFwiIHwgXCJjYW5jZWxsZWRcIjsgcmVjZWlwdDogUmVjZWlwdCB9XG4gIHwgeyBvdXRjb21lOiBcInByZXBhcmUtZmFpbGVkXCI7IGVycm9yOiBzdHJpbmcgfVxuICB8IHsgb3V0Y29tZTogXCJjb25maXJtYXRpb24tZmFpbGVkXCIgfCBcImNvbW1pdC1mYWlsZWRcIiB8IFwiY2FuY2VsLWZhaWxlZFwiOyByZWNlaXB0OiBSZWNlaXB0OyBlcnJvcjogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyPFJlY2VpcHQ+IHtcbiAgcmVhZG9ubHkgc25hcHNob3Q6IEVudmlyb25tZW50Q29uZmlnU25hcHNob3Q7XG4gIHNldFNlbGVjdGVkKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogdm9pZDtcbiAgcmVzdG9yZVBlbmRpbmcoc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiB2b2lkO1xuICBzdGFnZUFwcEV4cGVyaWVuY2UodmFsdWU6IEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSk6IHZvaWQ7XG4gIHN0YWdlUmVsZWFzZVByb2ZpbGUodmFsdWU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUpOiB2b2lkO1xuICBjbGVhckVycm9yKCk6IHZvaWQ7XG4gIGFwcGx5QW5kUmVzdGFydCgpOiBQcm9taXNlPEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+PjtcbiAgcmVzdW1lUHJlcGFyZWQoXG4gICAgc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIsXG4gICAgcmVjZWlwdDogUmVjZWlwdCxcbiAgKTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyT3B0aW9ucyB7XG4gIG9uQ2hhbmdlPzogKHNuYXBzaG90OiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90KSA9PiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyPFJlY2VpcHQ+KFxuICBzZWxlY3RlZDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLFxuICBlZmZlY3RzOiBFbnZpcm9ubWVudENvbmZpZ0VmZmVjdHM8UmVjZWlwdD4sXG4gIG9wdGlvbnM6IEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlck9wdGlvbnMgPSB7fSxcbik6IEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxSZWNlaXB0PiB7XG4gIGxldCBzZWxlY3RlZFZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3RlZCk7XG4gIGxldCBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGVkKTtcbiAgbGV0IGJ1c3kgPSBmYWxzZTtcbiAgbGV0IHBoYXNlOiBFbnZpcm9ubWVudENvbmZpZ1BoYXNlID0gXCJpZGxlXCI7XG4gIGxldCBlcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgcmVhZFNuYXBzaG90ID0gKCk6IEVudmlyb25tZW50Q29uZmlnU25hcHNob3QgPT4gKHtcbiAgICBzZWxlY3RlZDogY29weVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlKSxcbiAgICBwZW5kaW5nOiBjb3B5U2VsZWN0aW9uKHBlbmRpbmdWYWx1ZSksXG4gICAgaGFzUGVuZGluZ0NoYW5nZXM6ICFzYW1lU2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUsIHBlbmRpbmdWYWx1ZSksXG4gICAgYnVzeSxcbiAgICBwaGFzZSxcbiAgICBlcnJvcixcbiAgfSk7XG4gIGNvbnN0IHB1Ymxpc2ggPSAoKTogdm9pZCA9PiBvcHRpb25zLm9uQ2hhbmdlPy4ocmVhZFNuYXBzaG90KCkpO1xuICBjb25zdCBmaW5pc2hXaXRoRXJyb3IgPSAobmV4dFBoYXNlOiBFbnZpcm9ubWVudENvbmZpZ1BoYXNlLCBuZXh0RXJyb3I6IHVua25vd24pOiBzdHJpbmcgPT4ge1xuICAgIGVycm9yID0gZW52aXJvbm1lbnRDb25maWdFcnJvcihuZXh0RXJyb3IpO1xuICAgIGJ1c3kgPSBmYWxzZTtcbiAgICBwaGFzZSA9IG5leHRQaGFzZTtcbiAgICBwdWJsaXNoKCk7XG4gICAgcmV0dXJuIGVycm9yO1xuICB9O1xuXG4gIGNvbnN0IGNvbXBsZXRlUHJlcGFyZWQgPSBhc3luYyAoXG4gICAgcmVxdWVzdGVkOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIsXG4gICAgcmVjZWlwdDogUmVjZWlwdCxcbiAgKTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj4gPT4ge1xuICAgIHBoYXNlID0gXCJhd2FpdGluZy1jb25maXJtYXRpb25cIjtcbiAgICBwdWJsaXNoKCk7XG4gICAgbGV0IGRlY2lzaW9uOiBFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uO1xuICAgIHRyeSB7XG4gICAgICBkZWNpc2lvbiA9IGF3YWl0IGVmZmVjdHMuY29uZmlybShjb3B5U2VsZWN0aW9uKHJlcXVlc3RlZCksIHJlY2VpcHQpO1xuICAgIH0gY2F0Y2ggKGNvbmZpcm1hdGlvbkVycm9yKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvdXRjb21lOiBcImNvbmZpcm1hdGlvbi1mYWlsZWRcIixcbiAgICAgICAgcmVjZWlwdCxcbiAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgY29uZmlybWF0aW9uRXJyb3IpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAoZGVjaXNpb24gPT09IFwiY2FuY2VsXCIpIHtcbiAgICAgIHBoYXNlID0gXCJjYW5jZWxsaW5nXCI7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBlZmZlY3RzLmNhbmNlbChyZWNlaXB0KTtcbiAgICAgIH0gY2F0Y2ggKGNhbmNlbEVycm9yKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb3V0Y29tZTogXCJjYW5jZWwtZmFpbGVkXCIsXG4gICAgICAgICAgcmVjZWlwdCxcbiAgICAgICAgICBlcnJvcjogZmluaXNoV2l0aEVycm9yKFwiaWRsZVwiLCBjYW5jZWxFcnJvciksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUpO1xuICAgICAgYnVzeSA9IGZhbHNlO1xuICAgICAgcGhhc2UgPSBcImlkbGVcIjtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICAgIHJldHVybiB7IG91dGNvbWU6IFwiY2FuY2VsbGVkXCIsIHJlY2VpcHQgfTtcbiAgICB9XG5cbiAgICBwaGFzZSA9IFwiY29tbWl0dGluZ1wiO1xuICAgIHB1Ymxpc2goKTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgZWZmZWN0cy5jb21taXQocmVjZWlwdCk7XG4gICAgfSBjYXRjaCAoY29tbWl0RXJyb3IpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG91dGNvbWU6IFwiY29tbWl0LWZhaWxlZFwiLFxuICAgICAgICByZWNlaXB0LFxuICAgICAgICBlcnJvcjogZmluaXNoV2l0aEVycm9yKFwiaWRsZVwiLCBjb21taXRFcnJvciksXG4gICAgICB9O1xuICAgIH1cbiAgICBidXN5ID0gZmFsc2U7XG4gICAgcGhhc2UgPSBcImlkbGVcIjtcbiAgICBlcnJvciA9IG51bGw7XG4gICAgcHVibGlzaCgpO1xuICAgIHJldHVybiB7IG91dGNvbWU6IFwic3VibWl0dGVkXCIsIHJlY2VpcHQgfTtcbiAgfTtcblxuICByZXR1cm4ge1xuICAgIGdldCBzbmFwc2hvdCgpOiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90IHtcbiAgICAgIHJldHVybiByZWFkU25hcHNob3QoKTtcbiAgICB9LFxuICAgIHNldFNlbGVjdGVkKHNlbGVjdGlvbik6IHZvaWQge1xuICAgICAgY29uc3QgcGVuZGluZ1dhc1VuY2hhbmdlZCA9IHNhbWVTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSwgcGVuZGluZ1ZhbHVlKTtcbiAgICAgIHNlbGVjdGVkVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbik7XG4gICAgICAvLyBBIHN0YXR1cyByZWZyZXNoIG1heSByZXNvbHZlIGFmdGVyIHRoZSB1c2VyIGhhcyBzdGFnZWQgb25lIGhhbGYgb2YgdGhlXG4gICAgICAvLyBFbnZpcm9ubWVudCBwYWlyLiBSZWZyZXNoIHRoZSBhdXRob3JpdGF0aXZlIHNlbGVjdGlvbiB3aXRob3V0IGVyYXNpbmdcbiAgICAgIC8vIHRoYXQgbmV3ZXIgbG9jYWwgaW50ZW50OyBvbmx5IGZvbGxvdyB0aGUgc2VsZWN0ZWQgdmFsdWUgd2hpbGUgdGhlIGZvcm1cbiAgICAgIC8vIGl0c2VsZiBpcyBzdGlsbCBwcmlzdGluZS5cbiAgICAgIGlmIChwZW5kaW5nV2FzVW5jaGFuZ2VkKSBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbik7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICByZXN0b3JlUGVuZGluZyhzZWxlY3Rpb24pOiB2b2lkIHtcbiAgICAgIHBlbmRpbmdWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uKTtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIHN0YWdlQXBwRXhwZXJpZW5jZSh2YWx1ZSk6IHZvaWQge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIHBlbmRpbmdWYWx1ZSA9IHsgLi4ucGVuZGluZ1ZhbHVlLCBhcHBFeHBlcmllbmNlOiB2YWx1ZSB9O1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgc3RhZ2VSZWxlYXNlUHJvZmlsZSh2YWx1ZSk6IHZvaWQge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIHBlbmRpbmdWYWx1ZSA9IHsgLi4ucGVuZGluZ1ZhbHVlLCByZWxlYXNlUHJvZmlsZTogdmFsdWUgfTtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIGNsZWFyRXJyb3IoKTogdm9pZCB7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBhc3luYyBhcHBseUFuZFJlc3RhcnQoKTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybiB7IG91dGNvbWU6IFwiYnVzeVwiIH07XG4gICAgICBpZiAoc2FtZVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlLCBwZW5kaW5nVmFsdWUpKSByZXR1cm4geyBvdXRjb21lOiBcIm5vLWNoYW5nZVwiIH07XG4gICAgICBjb25zdCByZXF1ZXN0ZWQgPSBjb3B5U2VsZWN0aW9uKHBlbmRpbmdWYWx1ZSk7XG4gICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgIHBoYXNlID0gXCJwcmVwYXJpbmdcIjtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICAgIGxldCByZWNlaXB0OiBSZWNlaXB0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVjZWlwdCA9IGF3YWl0IGVmZmVjdHMucHJlcGFyZShjb3B5U2VsZWN0aW9uKHJlcXVlc3RlZCkpO1xuICAgICAgfSBjYXRjaCAocHJlcGFyZUVycm9yKSB7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgb3V0Y29tZTogXCJwcmVwYXJlLWZhaWxlZFwiLFxuICAgICAgICAgIGVycm9yOiBmaW5pc2hXaXRoRXJyb3IoXCJpZGxlXCIsIHByZXBhcmVFcnJvciksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXR1cm4gY29tcGxldGVQcmVwYXJlZChyZXF1ZXN0ZWQsIHJlY2VpcHQpO1xuICAgIH0sXG4gICAgYXN5bmMgcmVzdW1lUHJlcGFyZWQoc2VsZWN0aW9uLCByZWNlaXB0KTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybiB7IG91dGNvbWU6IFwiYnVzeVwiIH07XG4gICAgICBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbik7XG4gICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHJldHVybiBjb21wbGV0ZVByZXBhcmVkKGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uKSwgcmVjZWlwdCk7XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gY29weVNlbGVjdGlvbihzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpciB7XG4gIHJldHVybiB7XG4gICAgYXBwRXhwZXJpZW5jZTogc2VsZWN0aW9uLmFwcEV4cGVyaWVuY2UsXG4gICAgcmVsZWFzZVByb2ZpbGU6IHNlbGVjdGlvbi5yZWxlYXNlUHJvZmlsZSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2FtZVNlbGVjdGlvbihsZWZ0OiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIsIHJpZ2h0OiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiBib29sZWFuIHtcbiAgcmV0dXJuIGxlZnQuYXBwRXhwZXJpZW5jZSA9PT0gcmlnaHQuYXBwRXhwZXJpZW5jZVxuICAgICYmIGxlZnQucmVsZWFzZVByb2ZpbGUgPT09IHJpZ2h0LnJlbGVhc2VQcm9maWxlO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudENvbmZpZ0Vycm9yKGVycm9yOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yIHx8IFwiVW5rbm93biBlcnJvclwiKTtcbn1cblxuZXhwb3J0IHR5cGUgRGVza3RvcFVwZGF0ZVN0YXR1cyA9XG4gIHwgXCJ1cGRhdGUtYXZhaWxhYmxlXCJcbiAgfCBcImN1cnJlbnRcIlxuICB8IFwic3RhbGVcIlxuICB8IFwidW5hdmFpbGFibGVcIlxuICB8IFwiZXJyb3JcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVTdGF0dXNQcmVzZW50YXRpb24oXG4gIHN0YXR1czogRGVza3RvcFVwZGF0ZVN0YXR1cyB8IHVuZGVmaW5lZCxcbik6IHsgbGFiZWw6IHN0cmluZzsgdG9uZTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIgfSB7XG4gIHN3aXRjaCAoc3RhdHVzKSB7XG4gICAgY2FzZSBcImN1cnJlbnRcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVwIHRvIGRhdGVcIiwgdG9uZTogXCJva1wiIH07XG4gICAgY2FzZSBcInVwZGF0ZS1hdmFpbGFibGVcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVwZGF0ZSBhdmFpbGFibGVcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgICBjYXNlIFwiZXJyb3JcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIkVycm9yXCIsIHRvbmU6IFwiZXJyb3JcIiB9O1xuICAgIGNhc2UgXCJzdGFsZVwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiU3RhbGVcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgICBjYXNlIFwidW5hdmFpbGFibGVcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVuYXZhaWxhYmxlXCIsIHRvbmU6IFwid2FyblwiIH07XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIk5vdCBjaGVja2VkXCIsIHRvbmU6IFwid2FyblwiIH07XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudEZvY3VzVGFyZ2V0IHtcbiAgcmVhZG9ubHkgaXNDb25uZWN0ZWQ6IGJvb2xlYW47XG4gIGZvY3VzKCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXN0b3JlRW52aXJvbm1lbnRGb2N1cyhcbiAgb3BlbmVyOiBFbnZpcm9ubWVudEZvY3VzVGFyZ2V0IHwgbnVsbCxcbiAgZmFsbGJhY2s6ICgpID0+IEVudmlyb25tZW50Rm9jdXNUYXJnZXQgfCBudWxsLFxuKTogXCJvcGVuZXJcIiB8IFwiZmFsbGJhY2tcIiB8IFwibm9uZVwiIHtcbiAgaWYgKG9wZW5lcj8uaXNDb25uZWN0ZWQpIHtcbiAgICBvcGVuZXIuZm9jdXMoKTtcbiAgICByZXR1cm4gXCJvcGVuZXJcIjtcbiAgfVxuICBjb25zdCB0YXJnZXQgPSBmYWxsYmFjaygpO1xuICBpZiAodGFyZ2V0Py5pc0Nvbm5lY3RlZCkge1xuICAgIHRhcmdldC5mb2N1cygpO1xuICAgIHJldHVybiBcImZhbGxiYWNrXCI7XG4gIH1cbiAgcmV0dXJuIFwibm9uZVwiO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpZ0NhcmRVcGRhdGVUb2tlbiB7XG4gIHJlYWRvbmx5IGNhcmQ6IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGlvbjogbnVtYmVyO1xufVxuXG4vKipcbiAqIEtlZXBzIGFzeW5jaHJvbm91cyBDb25maWcgY2FyZHMgaW5kZXBlbmRlbnQgd2hpbGUgcmVqZWN0aW5nIGEgc3RhbGUgcmVzdWx0XG4gKiBmcm9tIGFuIG9sZGVyIHJlcXVlc3QgZm9yIHRoZSBzYW1lIGNhcmQuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8VmFsdWU+IHtcbiAgcmVhZG9ubHkgI2dlbmVyYXRpb25zID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgcmVhZG9ubHkgI3ZhbHVlcyA9IG5ldyBNYXA8c3RyaW5nLCBWYWx1ZT4oKTtcblxuICBiZWdpbihjYXJkOiBzdHJpbmcpOiBDb25maWdDYXJkVXBkYXRlVG9rZW4ge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSAodGhpcy4jZ2VuZXJhdGlvbnMuZ2V0KGNhcmQpID8/IDApICsgMTtcbiAgICB0aGlzLiNnZW5lcmF0aW9ucy5zZXQoY2FyZCwgZ2VuZXJhdGlvbik7XG4gICAgcmV0dXJuIE9iamVjdC5mcmVlemUoeyBjYXJkLCBnZW5lcmF0aW9uIH0pO1xuICB9XG5cbiAgY29tcGxldGUodG9rZW46IENvbmZpZ0NhcmRVcGRhdGVUb2tlbiwgdmFsdWU6IFZhbHVlKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmlzQ3VycmVudCh0b2tlbikpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLiN2YWx1ZXMuc2V0KHRva2VuLmNhcmQsIHZhbHVlKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlzQ3VycmVudCh0b2tlbjogQ29uZmlnQ2FyZFVwZGF0ZVRva2VuKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuI2dlbmVyYXRpb25zLmdldCh0b2tlbi5jYXJkKSA9PT0gdG9rZW4uZ2VuZXJhdGlvbjtcbiAgfVxuXG4gIGludmFsaWRhdGUoY2FyZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy4jZ2VuZXJhdGlvbnMuc2V0KGNhcmQsICh0aGlzLiNnZW5lcmF0aW9ucy5nZXQoY2FyZCkgPz8gMCkgKyAxKTtcbiAgfVxuXG4gIHZhbHVlKGNhcmQ6IHN0cmluZyk6IFZhbHVlIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy4jdmFsdWVzLmdldChjYXJkKTtcbiAgfVxuXG4gIHNuYXBzaG90KCk6IFJlY29yZDxzdHJpbmcsIFZhbHVlPiB7XG4gICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyh0aGlzLiN2YWx1ZXMpO1xuICB9XG59XG4iLCAiLyoqXG4gKiBSZW5kZXJlci1zaWRlIHR3ZWFrIGhvc3QuIFdlOlxuICogICAxLiBBc2sgbWFpbiBmb3IgdGhlIHR3ZWFrIGxpc3QgKHdpdGggcmVzb2x2ZWQgZW50cnkgcGF0aCkuXG4gKiAgIDIuIEZvciBlYWNoIHJlbmRlcmVyLXNjb3BlZCAob3IgXCJib3RoXCIpIHR3ZWFrLCBmZXRjaCBpdHMgc291cmNlIHZpYSBJUENcbiAqICAgICAgYW5kIGV4ZWN1dGUgaXQgYXMgYSBDb21tb25KUy1zaGFwZWQgZnVuY3Rpb24uXG4gKiAgIDMuIFByb3ZpZGUgaXQgdGhlIHJlbmRlcmVyIGhhbGYgb2YgdGhlIEFQSS5cbiAqXG4gKiBDb2RleCBydW5zIHRoZSByZW5kZXJlciB3aXRoIHNhbmRib3g6IHRydWUsIHNvIE5vZGUncyBgcmVxdWlyZSgpYCBpc1xuICogcmVzdHJpY3RlZCB0byBhIHRpbnkgd2hpdGVsaXN0IChlbGVjdHJvbiArIGEgZmV3IHBvbHlmaWxscykuIFRoYXQgbWVhbnMgd2VcbiAqIGNhbm5vdCBgcmVxdWlyZSgpYCBhcmJpdHJhcnkgdHdlYWsgZmlsZXMgZnJvbSBkaXNrLiBJbnN0ZWFkIHdlIHB1bGwgdGhlXG4gKiBzb3VyY2Ugc3RyaW5nIGZyb20gbWFpbiBhbmQgZXZhbHVhdGUgaXQgd2l0aCBgbmV3IEZ1bmN0aW9uYCBpbnNpZGUgdGhlXG4gKiBwcmVsb2FkIGNvbnRleHQuIFR3ZWFrIGF1dGhvcnMgd2hvIG5lZWQgbnBtIGRlcHMgbXVzdCBidW5kbGUgdGhlbSBpbi5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uLCByZWdpc3RlclBhZ2UsIGNsZWFyU2VjdGlvbnMsIHNldExpc3RlZFR3ZWFrcywgdXBkYXRlTGlzdGVkVHdlYWtMaWZlY3ljbGUgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHsgaG9zdFVpQXBpIH0gZnJvbSBcIi4vaG9zdC1zdXJmYWNlc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsIHJ1bldpdGhTdGFydHVwVGltZW91dCB9IGZyb20gXCIuLi90d2Vhay1saWZlY3ljbGVcIjtcbmltcG9ydCB0eXBlIHsgVHdlYWtIZWFsdGhSZWNvcmQsIFR3ZWFrU3RhdHVzLCBUd2Vha1N0b3JlRW50cnkgfSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ29kZXhDZHBTdGF0dXMsXG4gIENvZGV4Q2RwVGFyZ2V0LFxuICBDb2RleFJ1bnRpbWVDYXBhYmlsaXRpZXMsXG4gIENvZGV4UnVudGltZUluZm8sXG4gIENvZGV4Vmlld1JlZixcbiAgQ29kZXhXaW5kb3dSZWYsXG4gIE5hdGl2ZUhlbHBlckxhdW5jaE9wdGlvbnMsXG4gIE5hdGl2ZUhlbHBlclJlZixcbiAgTmF0aXZlTW9kdWxlS2luZCxcbiAgTmF0aXZlTW9kdWxlTG9hZE9wdGlvbnMsXG4gIE5hdGl2ZU1vZHVsZVJlZixcbiAgTmF0aXZlUGFuZWxDcmVhdGVPcHRpb25zLFxuICBOYXRpdmVQYW5lbFJlZixcbiAgTmF0aXZlVmlld0F0dGFjaE9wdGlvbnMsXG4gIE5hdGl2ZVZpZXdSZWYsXG4gIFR3ZWFrTWFuaWZlc3QsXG4gIFR3ZWFrQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbiAgVHdlYWssXG59IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB7IGNyZWF0ZVJlbmRlcmVyU3RvcmFnZSB9IGZyb20gXCIuLi9yZW5kZXJlci1zdG9yYWdlXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgaGVhbHRoOiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG4gIGNhdGFsb2c6IFR3ZWFrU3RvcmVFbnRyeSB8IG51bGw7XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRWxlY3Ryb25CcmlkZ2Uge1xuICBnZXRCdWlsZEZsYXZvcj86ICgpID0+IHN0cmluZyB8IG51bGw7XG4gIHVzZXNPd2xBcHBTaGVsbD86ICgpID0+IGJvb2xlYW47XG59XG5cbmNvbnN0IGxvYWRlZCA9IG5ldyBNYXA8c3RyaW5nLCB7IHN0b3A/OiAoKSA9PiB2b2lkIH0+KCk7XG5sZXQgY2FjaGVkUGF0aHM6IFVzZXJQYXRocyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRUd2Vha0hvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmxpc3QtdHdlYWtzXCIpKSBhcyBMaXN0ZWRUd2Vha1tdO1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnVzZXItcGF0aHNcIikpIGFzIFVzZXJQYXRocztcbiAgY2FjaGVkUGF0aHMgPSBwYXRocztcbiAgLy8gUHVzaCB0aGUgbGlzdCB0byB0aGUgc2V0dGluZ3MgaW5qZWN0b3Igc28gdGhlIFR3ZWFrcyBwYWdlIGNhbiByZW5kZXJcbiAgLy8gY2FyZHMgZXZlbiBiZWZvcmUgYW55IHR3ZWFrJ3Mgc3RhcnQoKSBydW5zIChhbmQgZm9yIGRpc2FibGVkIHR3ZWFrc1xuICAvLyB0aGF0IHdlIG5ldmVyIGxvYWQpLlxuICBzZXRMaXN0ZWRUd2Vha3ModHdlYWtzKTtcbiAgLy8gU3Rhc2ggZm9yIHRoZSBzZXR0aW5ncyBpbmplY3RvcidzIGVtcHR5LXN0YXRlIG1lc3NhZ2UuXG4gICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fdHdlYWtlcl90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX190d2Vha2VyX3R3ZWFrc19kaXJfXyA9XG4gICAgcGF0aHMudHdlYWtzRGlyO1xuXG4gIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICBpZiAodC5tYW5pZmVzdC5zY29wZSA9PT0gXCJtYWluXCIpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJkaXNhYmxlZFwiLCBcIm1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghdC5lbnRyeUV4aXN0cykge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImRpc2FibGVkXCIsIFwibWlzc2luZyBlbnRyeVwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXQuZW5hYmxlZCkge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCB0LnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiIDogXCJkaXNhYmxlZFwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwic3RhcnRpbmdcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bldpdGhTdGFydHVwVGltZW91dChcbiAgICAgICAgKCkgPT4gbG9hZFR3ZWFrKHQsIHBhdGhzKSxcbiAgICAgICAgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4gICAgICApO1xuICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwidGltZWRfb3V0XCIpIHtcbiAgICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInRpbWVkX291dFwiLCBgc3RhcnR1cCBleGNlZWRlZCAke0RFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TfW1zYCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbdHdlYWtlcl0gdHdlYWsgc3RhcnR1cCB0aW1lZCBvdXQ6XCIsIHQubWFuaWZlc3QuaWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInJlYWR5XCIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJmYWlsZWRcIiwgZSk7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW3R3ZWFrZXJdIHR3ZWFrIGxvYWQgZmFpbGVkOlwiLCB0Lm1hbmlmZXN0LmlkLCBlKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICAgIFwidHdlYWsgbG9hZCBmYWlsZWQ6IFwiICsgdC5tYW5pZmVzdC5pZCArIFwiOiBcIiArIFN0cmluZygoZSBhcyBFcnJvcik/LnN0YWNrID8/IGUpLFxuICAgICAgICApO1xuICAgICAgfSBjYXRjaCB7fVxuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuaW5mbyhcbiAgICBgW3R3ZWFrZXJdIHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOmAsXG4gICAgWy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiLFxuICApO1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTogJHtbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCJ9YCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gc2VuZExpZmVjeWNsZShcbiAgaWQ6IHN0cmluZyxcbiAgc3RhdHVzOiBcInN0YXJ0aW5nXCIgfCBcInJlYWR5XCIgfCBcImZhaWxlZFwiIHwgXCJ0aW1lZF9vdXRcIiB8IFwiZGlzYWJsZWRcIiB8IFwicXVhcmFudGluZWRcIixcbiAgZXJyb3I/OiB1bmtub3duLFxuKTogdm9pZCB7XG4gIGNvbnN0IHJlbmRlcmVyTGlmZWN5Y2xlID0gc3RhdHVzID09PSBcImRpc2FibGVkXCIgJiYgZXJyb3IgPT09IFwibWlzc2luZyBlbnRyeVwiID8gXCJmYWlsZWRcIlxuICAgIDogc3RhdHVzID09PSBcInN0YXJ0aW5nXCIgPyBcInN0YXJ0aW5nXCJcbiAgICA6IHN0YXR1cyA9PT0gXCJmYWlsZWRcIiA/IFwiZmFpbGVkXCJcbiAgICA6IHN0YXR1cyA9PT0gXCJ0aW1lZF9vdXRcIiA/IFwidGltZWRfb3V0XCJcbiAgICA6IHN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiXG4gICAgOiBcImVuYWJsZWRcIjtcbiAgdXBkYXRlTGlzdGVkVHdlYWtMaWZlY3ljbGUoaWQsIHJlbmRlcmVyTGlmZWN5Y2xlLCBlcnJvciA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwidHdlYWtlcjp0d2Vhay1saWZlY3ljbGVcIiwge1xuICAgICAgaWQsXG4gICAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgICBzdGF0dXMsXG4gICAgICAuLi4oZXJyb3IgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpIH0pLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBMaWZlY3ljbGUgdGVsZW1ldHJ5IG11c3QgbmV2ZXIgdGFrZSBkb3duIHRoZSByZW5kZXJlciBob3N0LlxuICB9XG59XG5cbi8qKlxuICogU3RvcCBldmVyeSByZW5kZXJlci1zY29wZSB0d2VhayBzbyBhIHN1YnNlcXVlbnQgYHN0YXJ0VHdlYWtIb3N0KClgIHdpbGxcbiAqIHJlLWV2YWx1YXRlIGZyZXNoIHNvdXJjZS4gTW9kdWxlIGNhY2hlIGlzbid0IHJlbGV2YW50IHNpbmNlIHdlIGV2YWxcbiAqIHNvdXJjZSBzdHJpbmdzIGRpcmVjdGx5IFx1MjAxNCBlYWNoIGxvYWQgY3JlYXRlcyBhIGZyZXNoIHNjb3BlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVhcmRvd25Ud2Vha0hvc3QoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgW2lkLCB0XSBvZiBsb2FkZWQpIHtcbiAgICB0cnkge1xuICAgICAgdC5zdG9wPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbdHdlYWtlcl0gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctZGlzcG9zZS10d2Vha1wiLCBpZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1kaXNwb3NlLXR3ZWFrXCIsIGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfVxuICB9XG4gIGxvYWRlZC5jbGVhcigpO1xuICBjbGVhclNlY3Rpb25zKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRUd2Vhayh0OiBMaXN0ZWRUd2VhaywgcGF0aHM6IFVzZXJQYXRocyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzb3VyY2UgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgIFwidHdlYWtlcjpyZWFkLXR3ZWFrLXNvdXJjZVwiLFxuICAgIHQuZW50cnksXG4gICkpIGFzIHN0cmluZztcblxuICAvLyBFdmFsdWF0ZSBhcyBDSlMtc2hhcGVkOiBwcm92aWRlIG1vZHVsZS9leHBvcnRzL2FwaS4gVHdlYWsgY29kZSBtYXkgdXNlXG4gIC8vIGBtb2R1bGUuZXhwb3J0cyA9IHsgc3RhcnQsIHN0b3AgfWAgb3IgYGV4cG9ydHMuc3RhcnQgPSAuLi5gIG9yIHB1cmUgRVNNXG4gIC8vIGRlZmF1bHQgZXhwb3J0IHNoYXBlICh3ZSBhY2NlcHQgYm90aCkuXG4gIGNvbnN0IG1vZHVsZSA9IHsgZXhwb3J0czoge30gYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrIH07XG4gIGNvbnN0IGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cztcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1pbXBsaWVkLWV2YWwsIG5vLW5ldy1mdW5jXG4gIGNvbnN0IGZuID0gbmV3IEZ1bmN0aW9uKFxuICAgIFwibW9kdWxlXCIsXG4gICAgXCJleHBvcnRzXCIsXG4gICAgXCJjb25zb2xlXCIsXG4gICAgYCR7c291cmNlfVxcbi8vIyBzb3VyY2VVUkw9dHdlYWtlci10d2VhazovLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQubWFuaWZlc3QuaWQpfS8ke2VuY29kZVVSSUNvbXBvbmVudCh0LmVudHJ5KX1gLFxuICApO1xuICBmbihtb2R1bGUsIGV4cG9ydHMsIGNvbnNvbGUpO1xuICBjb25zdCBtb2QgPSBtb2R1bGUuZXhwb3J0cyBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWs7XG4gIGNvbnN0IHR3ZWFrOiBUd2VhayA9IChtb2QgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSkuZGVmYXVsdCA/PyAobW9kIGFzIFR3ZWFrKTtcbiAgaWYgKHR5cGVvZiB0d2Vhaz8uc3RhcnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHdlYWsgJHt0Lm1hbmlmZXN0LmlkfSBoYXMgbm8gc3RhcnQoKWApO1xuICB9XG4gIGNvbnN0IGFwaSA9IG1ha2VSZW5kZXJlckFwaSh0Lm1hbmlmZXN0LCBwYXRocyk7XG4gIGF3YWl0IHR3ZWFrLnN0YXJ0KGFwaSk7XG4gIGxvYWRlZC5zZXQodC5tYW5pZmVzdC5pZCwgeyBzdG9wOiB0d2Vhay5zdG9wPy5iaW5kKHR3ZWFrKSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlbmRlcmVyQXBpKG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LCBwYXRoczogVXNlclBhdGhzKTogVHdlYWtBcGkge1xuICBjb25zdCBpZCA9IG1hbmlmZXN0LmlkO1xuICBjb25zdCBhc3NlcnRJcGNQZXJtaXNzaW9uID0gKCkgPT4ge1xuICAgIGlmICghbWFuaWZlc3QucGVybWlzc2lvbnM/LmluY2x1ZGVzKFwiaXBjXCIpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHR3ZWFrICR7aWR9IG11c3QgZGVjbGFyZSBpcGMgcGVybWlzc2lvbmApO1xuICAgIH1cbiAgfTtcbiAgY29uc3QgbG9nID0gKGxldmVsOiBcImRlYnVnXCIgfCBcImluZm9cIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCAuLi5hOiB1bmtub3duW10pID0+IHtcbiAgICBjb25zdCBjb25zb2xlRm4gPVxuICAgICAgbGV2ZWwgPT09IFwiZGVidWdcIiA/IGNvbnNvbGUuZGVidWdcbiAgICAgIDogbGV2ZWwgPT09IFwid2FyblwiID8gY29uc29sZS53YXJuXG4gICAgICA6IGxldmVsID09PSBcImVycm9yXCIgPyBjb25zb2xlLmVycm9yXG4gICAgICA6IGNvbnNvbGUubG9nO1xuICAgIGNvbnNvbGVGbihgW3R3ZWFrZXJdWyR7aWR9XWAsIC4uLmEpO1xuICAgIC8vIEFsc28gbWlycm9yIHRvIG1haW4ncyBsb2cgZmlsZSBzbyB3ZSBjYW4gZGlhZ25vc2UgdHdlYWsgYmVoYXZpb3JcbiAgICAvLyB3aXRob3V0IGF0dGFjaGluZyBEZXZUb29scy4gU3RyaW5naWZ5IGVhY2ggYXJnIGRlZmVuc2l2ZWx5LlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGEubWFwKCh2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHY7XG4gICAgICAgIGlmICh2IGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBgJHt2Lm5hbWV9OiAke3YubWVzc2FnZX1gO1xuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKHYpOyB9XG4gICAgICB9KTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgIFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICBsZXZlbCxcbiAgICAgICAgYFt0d2VhayAke2lkfV0gJHtwYXJ0cy5qb2luKFwiIFwiKX1gLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHN3YWxsb3cgXHUyMDE0IG5ldmVyIGxldCBsb2dnaW5nIGJyZWFrIGEgdHdlYWsgKi9cbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBtYW5pZmVzdCxcbiAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgbG9nOiB7XG4gICAgICBkZWJ1ZzogKC4uLmEpID0+IGxvZyhcImRlYnVnXCIsIC4uLmEpLFxuICAgICAgaW5mbzogKC4uLmEpID0+IGxvZyhcImluZm9cIiwgLi4uYSksXG4gICAgICB3YXJuOiAoLi4uYSkgPT4gbG9nKFwid2FyblwiLCAuLi5hKSxcbiAgICAgIGVycm9yOiAoLi4uYSkgPT4gbG9nKFwiZXJyb3JcIiwgLi4uYSksXG4gICAgfSxcbiAgICBzdG9yYWdlOiByZW5kZXJlclN0b3JhZ2UoaWQpLFxuICAgIHNldHRpbmdzOiB7XG4gICAgICByZWdpc3RlcjogKHMpID0+IHJlZ2lzdGVyU2VjdGlvbih7IC4uLnMsIGlkOiBgJHtpZH06JHtzLmlkfWAgfSksXG4gICAgICByZWdpc3RlclBhZ2U6IChwKSA9PlxuICAgICAgICByZWdpc3RlclBhZ2UoaWQsIG1hbmlmZXN0LCB7IC4uLnAsIGlkOiBgJHtpZH06JHtwLmlkfWAgfSksXG4gICAgfSxcbiAgICByZWFjdDoge1xuICAgICAgZ2V0RmliZXI6IChuKSA9PiBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuICAgICAgZmluZE93bmVyQnlOYW1lOiAobiwgbmFtZSkgPT4ge1xuICAgICAgICBsZXQgZiA9IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gICAgICAgIHdoaWxlIChmKSB7XG4gICAgICAgICAgY29uc3QgdCA9IGYudHlwZSBhcyB7IGRpc3BsYXlOYW1lPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCBudWxsO1xuICAgICAgICAgIGlmICh0ICYmICh0LmRpc3BsYXlOYW1lID09PSBuYW1lIHx8IHQubmFtZSA9PT0gbmFtZSkpIHJldHVybiBmO1xuICAgICAgICAgIGYgPSBmLnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICB3YWl0Rm9yRWxlbWVudDogKHNlbCwgdGltZW91dE1zID0gNTAwMCkgPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgIGlmIChleGlzdGluZykgcmV0dXJuIHJlc29sdmUoZXhpc3RpbmcpO1xuICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXRNcztcbiAgICAgICAgICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICAgIGlmIChlbCkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZXNvbHZlKGVsKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoRGF0ZS5ub3coKSA+IGRlYWRsaW5lKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHRpbWVvdXQgd2FpdGluZyBmb3IgJHtzZWx9YCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgIH0pLFxuICAgICAgaG9zdDogaG9zdFVpQXBpLFxuICAgIH0sXG4gICAgaXBjOiB7XG4gICAgICBvbjogKGMsIGgpID0+IHtcbiAgICAgICAgYXNzZXJ0SXBjUGVybWlzc2lvbigpO1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4ge1xuICAgICAgICBhc3NlcnRJcGNQZXJtaXNzaW9uKCk7XG4gICAgICAgIGlwY1JlbmRlcmVyLnNlbmQoYHR3ZWFrZXI6JHtpZH06JHtjfWAsIC4uLmFyZ3MpO1xuICAgICAgfSxcbiAgICAgIGludm9rZTogPFQ+KGM6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKSA9PiB7XG4gICAgICAgIGFzc2VydElwY1Blcm1pc3Npb24oKTtcbiAgICAgICAgaWYgKGlkID09PSBcImNvLnR3ZWFrZXJzLnRocmVhZC1zdW1tYXJ5LXByb2ZpbGVzXCIgJiYgYyA9PT0gXCJwcm9maWxlcy5yZWFkXCIpIHtcbiAgICAgICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgICAgXCJ0d2Vha2VyOmNyb3NzLXR3ZWFrLXJlYWRcIixcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgXCJjby50d2Vha2Vycy5wcm9qZWN0c1wiLFxuICAgICAgICAgICAgXCJwcm9maWxlcy5yZWFkXCIsXG4gICAgICAgICAgICBhcmdzWzBdLFxuICAgICAgICAgICkgYXMgUHJvbWlzZTxUPjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaWQgPT09IFwiY28udHdlYWtlcnMuZm9sbG93dXBcIiAmJiBjID09PSBcInBvbGljeVwiKSB7XG4gICAgICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICAgIFwidHdlYWtlcjpjcm9zcy10d2Vhay1yZWFkXCIsXG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIFwiY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgICAgICAgICAgIFwiZm9sbG93dXAucG9saWN5LnJlYWRcIixcbiAgICAgICAgICAgIGFyZ3NbMF0sXG4gICAgICAgICAgKSBhcyBQcm9taXNlPFQ+O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoYHR3ZWFrZXI6JHtpZH06JHtjfWAsIC4uLmFyZ3MpIGFzIFByb21pc2U8VD47XG4gICAgICB9LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgICBjb2RleDogcmVuZGVyZXJDb2RleEFwaShpZCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyQ29kZXhBcGkodHdlYWtJZDogc3RyaW5nKTogTm9uTnVsbGFibGU8VHdlYWtBcGlbXCJjb2RleFwiXT4ge1xuICByZXR1cm4ge1xuICAgIHJ1bnRpbWU6IHtcbiAgICAgIGdldEluZm86IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtcnVudGltZS1pbmZvXCIpIGFzIENvZGV4UnVudGltZUluZm87XG4gICAgICAgIGNvbnN0IGJyaWRnZSA9IHJlbmRlcmVyRWxlY3Ryb25CcmlkZ2UoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5pbmZvLFxuICAgICAgICAgIGJ1aWxkRmxhdm9yOiBicmlkZ2U/LmdldEJ1aWxkRmxhdm9yPy4oKSA/PyBpbmZvLmJ1aWxkRmxhdm9yLFxuICAgICAgICAgIHVzZXNPd2xBcHBTaGVsbDogYnJpZGdlPy51c2VzT3dsQXBwU2hlbGw/LigpID8/IGluZm8udXNlc093bEFwcFNoZWxsLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIGdldENhcGFiaWxpdGllczogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC1ydW50aW1lLWNhcGFiaWxpdGllc1wiKSBhcyBQcm9taXNlPENvZGV4UnVudGltZUNhcGFiaWxpdGllcz4sXG4gICAgfSxcbiAgICB3aW5kb3dzOiB7XG4gICAgICBjcmVhdGU6IChvcHRpb25zKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1jcmVhdGVcIiwgb3B0aW9ucykgYXMgUHJvbWlzZTxDb2RleFdpbmRvd1JlZj4sXG4gICAgICBnZXRQcmltYXJ5OiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1wcmltYXJ5XCIpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWYgfCBudWxsPixcbiAgICAgIGZvY3VzOiAod2luZG93SWQpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LWZvY3VzXCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgICAgc2hvdzogKHdpbmRvd0lkKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1zaG93XCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgIH0sXG4gICAgdmlld3M6IHtcbiAgICAgIGNyZWF0ZTogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpjb2RleC12aWV3LWNyZWF0ZVwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdlYkNvbnRlbnRzSWQ6IG51bWJlcjsgcGFyZW50V2luZG93SWQ6IG51bWJlciB8IG51bGwgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyQ29kZXhWaWV3UmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndlYkNvbnRlbnRzSWQsIHJlZi5wYXJlbnRXaW5kb3dJZCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY2RwOiB7XG4gICAgICBnZXRTdGF0dXM6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtY2RwLXN0YXR1c1wiKSBhcyBQcm9taXNlPENvZGV4Q2RwU3RhdHVzPixcbiAgICAgIGxpc3RUYXJnZXRzOiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LWNkcC10YXJnZXRzXCIpIGFzIFByb21pc2U8Q29kZXhDZHBUYXJnZXRbXT4sXG4gICAgfSxcbiAgICBuYXRpdmU6IHtcbiAgICAgIGxvYWRNb2R1bGU6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWxvYWQtbW9kdWxlXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsga2luZDogTmF0aXZlTW9kdWxlS2luZCB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVNb2R1bGVSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYua2luZCk7XG4gICAgICB9LFxuICAgICAgY3JlYXRlUGFuZWw6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWNyZWF0ZS1wYW5lbFwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdpbmRvd0lkOiBudW1iZXIgfCBudWxsIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZVBhbmVsUmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndpbmRvd0lkKTtcbiAgICAgIH0sXG4gICAgICBhdHRhY2hWaWV3OiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1hdHRhY2gtdmlld1wiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmcgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlVmlld1JlZih0d2Vha0lkLCByZWYuaWQpO1xuICAgICAgfSxcbiAgICAgIGxhdW5jaEhlbHBlcjogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpuYXRpdmUtbGF1bmNoLWhlbHBlclwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHBpZDogbnVtYmVyIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkLCByZWYuaWQsIHJlZi5waWQpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHJlZnJlc2g6IHtcbiAgICAgIGdldFN0YXR1czogKCkgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtcmVmcmVzaC1zdGF0dXNcIiksXG4gICAgICBzdGFydDogKHNvdXJjZSA9IFwic21hcnRcIikgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzdGFydC1sb2NhbC1yZWZyZXNoXCIsIHNvdXJjZSksXG4gICAgICBvblN0YXR1c0NoYW5nZWQ6IChsaXN0ZW5lcikgPT4ge1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKCkgPT4geyB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LXJlZnJlc2gtc3RhdHVzXCIpLnRoZW4obGlzdGVuZXIpOyB9O1xuICAgICAgICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6cmVmcmVzaC1zdGF0dXMtY2hhbmdlZFwiLCBoYW5kbGVyKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjpyZWZyZXNoLXN0YXR1cy1jaGFuZ2VkXCIsIGhhbmRsZXIpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGNhcHR1cmU6IHtcbiAgICAgIGdldFBlcm1pc3Npb25TdGF0dXM6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICByZXF1ZXN0QWNjZXNzaWJpbGl0eTogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICAgIG9wZW5QZXJtaXNzaW9uU2V0dGluZ3M6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICBjYXB0dXJlRnJvbnRtb3N0V2luZG93OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgaG90a2V5czoge1xuICAgICAgcmVnaXN0ZXJDYXB0dXJlSG90a2V5OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5ob3RrZXlzIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY3JlYXRlQnJvd3NlclZpZXc6IChfb3B0aW9ucykgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNyZWF0ZUJyb3dzZXJWaWV3IGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgfSxcbiAgICBjcmVhdGVXaW5kb3c6IChvcHRpb25zKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctY3JlYXRlXCIsIG9wdGlvbnMpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWY+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckNvZGV4Vmlld1JlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICB3ZWJDb250ZW50c0lkOiBudW1iZXIsXG4gIHBhcmVudFdpbmRvd0lkOiBudW1iZXIgfCBudWxsLFxuKTogQ29kZXhWaWV3UmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICB3ZWJDb250ZW50c0lkLFxuICAgIHBhcmVudFdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInNldEJvdW5kc1wiLCBib3VuZHMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgc2V0VmlzaWJsZTogKHZpc2libGUpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZXRWaXNpYmxlXCIsIHZpc2libGUpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgYnJpbmdUb0Zyb250OiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiYnJpbmdUb0Zyb250XCIpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgbG9hZFJvdXRlOiAocm91dGUsIGhvc3RJZCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImxvYWRSb3V0ZVwiLCByb3V0ZSwgaG9zdElkKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGxvYWRVcmw6ICh1cmwpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJsb2FkVXJsXCIsIHVybCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZU1vZHVsZVJlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICBraW5kOiBOYXRpdmVNb2R1bGVLaW5kLFxuKTogTmF0aXZlTW9kdWxlUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBraW5kLFxuICAgIHJlcXVlc3Q6IChtZXRob2QsIHBheWxvYWQsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1tb2R1bGUtcmVxdWVzdFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgbWV0aG9kLFxuICAgICAgICBwYXlsb2FkLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgICApLFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1tb2R1bGUtZGlzcG9zZVwiLCB0d2Vha0lkLCBpZCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVQYW5lbFJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHdpbmRvd0lkOiBudW1iZXIgfCBudWxsKTogTmF0aXZlUGFuZWxSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJzZXRCb3VuZHNcIiwgYm91bmRzKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHNob3c6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwic2hvd1wiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGhpZGU6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiaGlkZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZVZpZXdSZWYodHdlYWtJZDogc3RyaW5nLCBpZDogc3RyaW5nKTogTmF0aXZlVmlld1JlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgc2V0Qm91bmRzOiAoYm91bmRzKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwic2V0Qm91bmRzXCIsIGJvdW5kcykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBzZXRWaXNpYmxlOiAodmlzaWJsZSkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJ2aWV3XCIsIGlkLCBcInNldFZpc2libGVcIiwgdmlzaWJsZSkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHBpZDogbnVtYmVyKTogTmF0aXZlSGVscGVyUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBwaWQsXG4gICAgc2VuZDogKG1lc3NhZ2UpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1oZWxwZXItY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZW5kXCIsIG1lc3NhZ2UpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgcmVxdWVzdDogKG1lc3NhZ2UsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1oZWxwZXItY2FsbFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgXCJyZXF1ZXN0XCIsXG4gICAgICAgIG1lc3NhZ2UsXG4gICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICksXG4gICAgc3RvcDogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWhlbHBlci1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInN0b3BcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJFbGVjdHJvbkJyaWRnZSgpOiBFbGVjdHJvbkJyaWRnZSB8IG51bGwge1xuICBjb25zdCB2YWx1ZSA9ICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IGVsZWN0cm9uQnJpZGdlPzogdW5rbm93biB9KS5lbGVjdHJvbkJyaWRnZTtcbiAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIEVsZWN0cm9uQnJpZGdlIDogbnVsbDtcbn1cblxuZXhwb3J0IGNvbnN0IHJlbmRlcmVyU3RvcmFnZSA9IChpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlID0gbG9jYWxTdG9yYWdlKSA9PiBjcmVhdGVSZW5kZXJlclN0b3JhZ2UoaWQsIHN0b3JhZ2UpO1xuXG5mdW5jdGlvbiByZW5kZXJlckZzKGlkOiBzdHJpbmcsIF9wYXRoczogVXNlclBhdGhzKSB7XG4gIC8vIFNhbmRib3hlZCByZW5kZXJlciBjYW4ndCB1c2UgTm9kZSBmcyBkaXJlY3RseSBcdTIwMTQgcHJveHkgdGhyb3VnaCBtYWluIElQQy5cbiAgcmV0dXJuIHtcbiAgICBkYXRhRGlyOiBgPHJlbW90ZT4vdHdlYWstZGF0YS8ke2lkfWAsXG4gICAgcmVhZDogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dHdlYWstZnNcIiwgXCJyZWFkXCIsIGlkLCBwKSBhcyBQcm9taXNlPHN0cmluZz4sXG4gICAgd3JpdGU6IChwOiBzdHJpbmcsIGM6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dHdlYWstZnNcIiwgXCJ3cml0ZVwiLCBpZCwgcCwgYykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBleGlzdHM6IChwOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnR3ZWFrLWZzXCIsIFwiZXhpc3RzXCIsIGlkLCBwKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICB9O1xufVxuIiwgImltcG9ydCB7IGZpYmVyRm9yTm9kZSB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB0eXBlIHtcbiAgSG9zdE1jcERlbGl2ZXJ5QWNrbm93bGVkZ2VtZW50LFxuICBIb3N0TWNwRm9ybUF0dGFjaFJlc3VsdCxcbiAgSG9zdE1jcEZvcm1Db250cm9sbGVyLFxuICBIb3N0TWNwRm9ybUlkZW50aXR5LFxuICBIb3N0UHJvamVjdENvbnRleHQsXG4gIEhvc3RTdXJmYWNlS2luZCxcbiAgSG9zdFN1cmZhY2VNYXRjaCxcbiAgSG9zdFN1cmZhY2VTbmFwc2hvdCxcbiAgSG9zdFVpQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuXG5jb25zdCBNQVhfTUFUQ0hFUyA9IDEwMDtcbi8vIEN1cnJlbnQgZGVza3RvcCBidWlsZHMgY2FuIHBsYWNlIGEgc3RhbmRhcmQgTUNQIGZvcm0gYmVuZWF0aCBzdWJzdGFudGlhbGx5XG4vLyBtb3JlIHByb3ZpZGVyL3N1c3BlbnNlIHdyYXBwZXJzIHRoYW4gdGhlIHNoYWxsb3cgc3ludGhldGljIGZpeHR1cmVzIHVzZWRcbi8vIGR1cmluZyB0aGUgb3JpZ2luYWwgaW1wbGVtZW50YXRpb24uIEtlZXAgdGhlIHdhbGsgYm91bmRlZCwgYnV0IGxlYXZlIGVub3VnaFxuLy8gaGVhZHJvb20gdG8gcmVhY2ggdGhlIGlkZW50aXR5LWJlYXJpbmcgZm9ybSBjb21wb25lbnQgaW4gdGhlIHJlYWwgaG9zdC5cbmNvbnN0IE1BWF9NQ1BfRklCRVJfREVQVEggPSAxMjg7XG5jb25zdCBNQVhfTUNQX1NDSEVNQV9QUk9QRVJUSUVTID0gMTI4O1xuY29uc3QgTUFYX01DUF9JREVOVElUWV9MRU5HVEggPSA1MTI7XG5jb25zdCBNQVhfTUNQX1ZJU0lCSUxJVFlfQU5DRVNUT1JTID0gMTI4O1xuY29uc3QgTUNQX0NBUlJJRVJfSURFTlRJVFlfS0VZUyA9IFtcImVsaWNpdGF0aW9uXCIsIFwicmVxdWVzdElkXCIsIFwiY29udmVyc2F0aW9uSWRcIiwgXCJob3N0SWRcIl0gYXMgY29uc3Q7XG5leHBvcnQgY29uc3QgTUNQX0NBUlJJRVJfTk9OQ0VfUFJFRklYID0gXCJfX3R3ZWFrZXJzX2NhcnJpZXJfbm9uY2VfXCI7XG5jb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PHsga2luZHM6IEhvc3RTdXJmYWNlS2luZFtdOyBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkIH0+KCk7XG5sZXQgc2hhcmVkT2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsID0gbnVsbDtcbmxldCBwZW5kaW5nRnJhbWU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5jb25zdCBTRUxFQ1RPUlM6IFJlY29yZDxFeGNsdWRlPEhvc3RTdXJmYWNlS2luZCwgXCJwcm9qZWN0c1wiIHwgXCJ0aHJlYWQtY29udGV4dFwiIHwgXCJ1c2FnZVwiPiwgc3RyaW5nPiA9IHtcbiAgXCJhc3Npc3RhbnQtdHVybnNcIjogJ1tkYXRhLXRlc3RpZD1cImNvbnZlcnNhdGlvbi10dXJuXCJdLCBbZGF0YS10ZXN0aWQqPVwiYXNzaXN0YW50LW1lc3NhZ2VcIiBpXSwgW2RhdGEtbWVzc2FnZS1hdXRob3Itcm9sZT1cImFzc2lzdGFudFwiXSwgW2RhdGEtcm9sZT1cImFzc2lzdGFudFwiXScsXG4gIGNvbXBvc2VyOiAnI3Byb21wdC10ZXh0YXJlYSwgW2RhdGEtdGVzdGlkPVwiY29tcG9zZXJcIl0gdGV4dGFyZWEsIFtkYXRhLXRlc3RpZD1cImNvbXBvc2VyXCJdIFtjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdLCBmb3JtIHRleHRhcmVhOm5vdChbZGlzYWJsZWRdKSwgZm9ybSBbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXScsXG4gIFwiY29tbWFuZC1tZW51XCI6ICdbZGF0YS1jb21tYW5kLW1lbnVdLCBbZGF0YS1zbGFzaC1tZW51XSwgW3JvbGU9XCJsaXN0Ym94XCJdJyxcbiAgXCJhY2NvdW50LW1lbnVcIjogJ1tyb2xlPVwibWVudVwiXSwgW3JvbGU9XCJkaWFsb2dcIl0nLFxuICBcInNldHRpbmdzLXJvd3NcIjogJ1tkYXRhLXNldHRpbmdzLXJvd10sIFtyb2xlPVwibGlzdGl0ZW1cIl0sIHNlY3Rpb24gPiBkaXYnLFxuICBcInRpdGxlYmFyLWNvbnRyb2xzXCI6ICdbZGF0YS10aXRsZWJhci1jb250cm9sXSwgW2FyaWEtbGFiZWw9XCJIaWRlIHNpZGViYXJcIl0sIFthcmlhLWxhYmVsPVwiU2hvdyBzaWRlYmFyXCJdLCBbYXJpYS1sYWJlbD1cIkJhY2tcIl0sIFthcmlhLWxhYmVsPVwiRm9yd2FyZFwiXSwgW3RpdGxlPVwiQmFja1wiXSwgW3RpdGxlPVwiRm9yd2FyZFwiXScsXG59O1xuXG5leHBvcnQgY29uc3QgaG9zdFVpQXBpOiBIb3N0VWlBcGkgPSB7XG4gIHF1ZXJ5OiBxdWVyeUhvc3RTdXJmYWNlcyxcbiAgc25hcHNob3QsXG4gIG9ic2VydmUsXG4gIGdldEFjdGl2ZVByb2plY3QsXG4gIGF0dGFjaEZpbGVzLFxuICBhdHRhY2hNY3BGb3JtQ2Fycmllcixcbn07XG5cbnR5cGUgQ2FycmllckZpYmVyID0gUmVhY3RGaWJlck5vZGUgJiB7IGtleT86IG51bGwgfCBzdHJpbmcgfCBudW1iZXIgfTtcblxudHlwZSBDYXJyaWVySWRlbnRpdHlJbnRlcm5hbCA9IHtcbiAgcmVxdWVzdElkOiBzdHJpbmc7XG4gIGNvbnZlcnNhdGlvbklkOiBzdHJpbmc7XG4gIGhvc3RJZDogc3RyaW5nO1xuICBzY2hlbWFQcm9wZXJ0aWVzOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG59O1xuXG50eXBlIENhcnJpZXJJbnNwZWN0aW9uID1cbiAgfCB7IHN0YXR1czogXCJhdHRhY2hlZFwiOyBpZGVudGl0eTogQ2FycmllcklkZW50aXR5SW50ZXJuYWw7IGlkZW50aXR5U2hhcGU6IHN0cmluZyB9XG4gIHwgeyBzdGF0dXM6IFwiZGVjbGluZWRcIjsgcmVhc29uOiBFeGNsdWRlPEhvc3RNY3BGb3JtQXR0YWNoUmVzdWx0LCB7IHN0YXR1czogXCJhdHRhY2hlZFwiIH0+W1wicmVhc29uXCJdIH07XG5cbi8qKlxuICogRmluZCB0aGUgb25lIHN0YW5kYXJkIE1DUCBmb3JtIGNhcnJ5aW5nIHRoaXMgbm9uY2UuIERpc2NvdmVyeSB1c2VzIHNjaGVtYVxuICogcHJvcGVydHkga2V5cyBvbmx5OyB2aXNpYmxlIHByb21wdCwgbGFiZWwsIG9wdGlvbiwgYW5kIGFuc3dlciB0ZXh0IGFyZSBuZXZlclxuICogaW5zcGVjdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoTWNwRm9ybUNhcnJpZXIobm9uY2U6IHN0cmluZyk6IEhvc3RNY3BGb3JtQXR0YWNoUmVzdWx0IHtcbiAgaWYgKCF2YWxpZENhcnJpZXJOb25jZShub25jZSkpIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiaW52YWxpZF9ub25jZVwiIH07XG4gIGlmICh0eXBlb2YgZG9jdW1lbnQgPT09IFwidW5kZWZpbmVkXCIpIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiY2Fycmllcl9ub3RfZm91bmRcIiB9O1xuICBjb25zdCBhdHRhY2hlZDogRXh0cmFjdDxIb3N0TWNwRm9ybUF0dGFjaFJlc3VsdCwgeyBzdGF0dXM6IFwiYXR0YWNoZWRcIiB9PltdID0gW107XG4gIGZvciAoY29uc3QgZm9ybSBvZiBBcnJheS5mcm9tKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJmb3JtXCIpKSkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF0dGFjaE1jcEZvcm1FbGVtZW50KGZvcm0gYXMgSFRNTEZvcm1FbGVtZW50LCBub25jZSk7XG4gICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwiYXR0YWNoZWRcIikgYXR0YWNoZWQucHVzaChyZXN1bHQpO1xuICB9XG4gIGlmIChhdHRhY2hlZC5sZW5ndGggPT09IDApIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiY2Fycmllcl9ub3RfZm91bmRcIiB9O1xuICBpZiAoYXR0YWNoZWQubGVuZ3RoID4gMSkgcmV0dXJuIHsgc3RhdHVzOiBcImRlY2xpbmVkXCIsIHJlYXNvbjogXCJtdWx0aXBsZV9jYXJyaWVyc1wiIH07XG4gIHJldHVybiBhdHRhY2hlZFswXTtcbn1cblxuLyoqIEV4cG9ydGVkIGZvciBhIHJlcG9zaXRvcnktbG9jYWwgZHJpZnQgaGFybmVzczsgdHdlYWtzIHVzZSBob3N0VWlBcGkuICovXG5leHBvcnQgZnVuY3Rpb24gYXR0YWNoTWNwRm9ybUVsZW1lbnQoXG4gIGZvcm06IEhUTUxGb3JtRWxlbWVudCxcbiAgbm9uY2U6IHN0cmluZyxcbiAgcmVzb2x2ZUZpYmVyOiAoZWxlbWVudDogRWxlbWVudCkgPT4gUmVhY3RGaWJlck5vZGUgfCBudWxsID0gKGVsZW1lbnQpID0+XG4gICAgZmliZXJGb3JOb2RlKGVsZW1lbnQpIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbCxcbik6IEhvc3RNY3BGb3JtQXR0YWNoUmVzdWx0IHtcbiAgaWYgKCF2YWxpZENhcnJpZXJOb25jZShub25jZSkpIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiaW52YWxpZF9ub25jZVwiIH07XG4gIGlmIChTdHJpbmcoZm9ybT8udGFnTmFtZSkudG9VcHBlckNhc2UoKSAhPT0gXCJGT1JNXCIpIHtcbiAgICByZXR1cm4geyBzdGF0dXM6IFwiZGVjbGluZWRcIiwgcmVhc29uOiBcIm5vdF9zZW1hbnRpY19mb3JtXCIgfTtcbiAgfVxuICBpZiAoIWZvcm0uaXNDb25uZWN0ZWQpIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiZGlzY29ubmVjdGVkX2Zvcm1cIiB9O1xuICBjb25zdCBpbnNwZWN0ZWQgPSBpbnNwZWN0Q2FycmllckZvcm0oZm9ybSwgbm9uY2UsIHJlc29sdmVGaWJlcik7XG4gIGlmIChpbnNwZWN0ZWQuc3RhdHVzID09PSBcImRlY2xpbmVkXCIpIHJldHVybiBpbnNwZWN0ZWQ7XG4gIGNvbnN0IGlkZW50aXR5ID0gcHVibGljQ2FycmllcklkZW50aXR5KGluc3BlY3RlZC5pZGVudGl0eSk7XG4gIGNvbnN0IGNvbnRyb2xsZXIgPSBuZXcgU2VtYW50aWNNY3BGb3JtQ29udHJvbGxlcihcbiAgICBmb3JtLFxuICAgIG5vbmNlLFxuICAgIGlkZW50aXR5LFxuICAgIGluc3BlY3RlZC5pZGVudGl0eVNoYXBlLFxuICAgIHJlc29sdmVGaWJlcixcbiAgKTtcbiAgcmV0dXJuIHtcbiAgICBzdGF0dXM6IFwiYXR0YWNoZWRcIixcbiAgICBpZGVudGl0eSxcbiAgICBjb250cm9sbGVyLFxuICAgIGFja25vd2xlZGdlbWVudDogZGVsaXZlcnlBY2tub3dsZWRnZW1lbnQoXCJjYXJyaWVyX2F0dGFjaFwiKSxcbiAgfTtcbn1cblxuY2xhc3MgU2VtYW50aWNNY3BGb3JtQ29udHJvbGxlciBpbXBsZW1lbnRzIEhvc3RNY3BGb3JtQ29udHJvbGxlciB7XG4gIHJlYWRvbmx5IHRhc2tDYXJkQW5jaG9yOiBIVE1MRWxlbWVudDtcbiAgcHJpdmF0ZSBjb250aW51ZURpc3BhdGNoZWQgPSBmYWxzZTtcblxuICBjb25zdHJ1Y3RvcihcbiAgICByZWFkb25seSBmb3JtOiBIVE1MRm9ybUVsZW1lbnQsXG4gICAgcHJpdmF0ZSByZWFkb25seSBub25jZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGlkZW50aXR5OiBSZWFkb25seTxIb3N0TWNwRm9ybUlkZW50aXR5PixcbiAgICBwcml2YXRlIHJlYWRvbmx5IGlkZW50aXR5U2hhcGU6IHN0cmluZyxcbiAgICBwcml2YXRlIHJlYWRvbmx5IHJlc29sdmVGaWJlcjogKGVsZW1lbnQ6IEVsZW1lbnQpID0+IFJlYWN0RmliZXJOb2RlIHwgbnVsbCxcbiAgKSB7XG4gICAgLy8gVGhlIHNlbWFudGljIGZvcm0gaXRzZWxmIGlzIHRoZSBvbmx5IGFuY2hvciBwcm92ZW4gdG8gYmVsb25nIHRvIHRoZVxuICAgIC8vIGNhcnJpZXIuIENhbGxlcnMgbWF5IG1vdW50IGFkamFjZW50IHRvIGl0LCBidXQgbWF5IG5vdCBndWVzcyBhIHRhc2sgY2FyZFxuICAgIC8vIGZyb20gdGV4dCwgZm9jdXMsIFVSTCwgb3IgdGhlIHByaW1hcnkgd2luZG93LlxuICAgIHRoaXMudGFza0NhcmRBbmNob3IgPSBmb3JtO1xuICB9XG5cbiAgaXNDdXJyZW50KCk6IGJvb2xlYW4ge1xuICAgIGlmICghdGhpcy5mb3JtLmlzQ29ubmVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgY29uc3QgY3VycmVudCA9IGluc3BlY3RDYXJyaWVyRm9ybSh0aGlzLmZvcm0sIHRoaXMubm9uY2UsIHRoaXMucmVzb2x2ZUZpYmVyKTtcbiAgICByZXR1cm4gY3VycmVudC5zdGF0dXMgPT09IFwiYXR0YWNoZWRcIiAmJiBjdXJyZW50LmlkZW50aXR5U2hhcGUgPT09IHRoaXMuaWRlbnRpdHlTaGFwZTtcbiAgfVxuXG4gIHNldFJhZGlvKHByb3BlcnR5S2V5OiBzdHJpbmcsIG9wdGlvbktleTogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy5leGFjdENob2ljZShcInJhZGlvXCIsIHByb3BlcnR5S2V5LCBvcHRpb25LZXkpLmNsaWNrKCk7XG4gIH1cblxuICBzZXRDaGVja2JveChwcm9wZXJ0eUtleTogc3RyaW5nLCBvcHRpb25LZXk6IHN0cmluZywgY2hlY2tlZDogYm9vbGVhbik6IHZvaWQge1xuICAgIGNvbnN0IGJ1dHRvbiA9IHRoaXMuZXhhY3RDaG9pY2UoXCJjaGVja2JveFwiLCBwcm9wZXJ0eUtleSwgb3B0aW9uS2V5KTtcbiAgICBjb25zdCBzZWxlY3RlZCA9IGJ1dHRvbi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWNoZWNrZWRcIikgPT09IFwidHJ1ZVwiO1xuICAgIGlmIChzZWxlY3RlZCAhPT0gY2hlY2tlZCkgYnV0dG9uLmNsaWNrKCk7XG4gIH1cblxuICBzZXRUZXh0KHByb3BlcnR5S2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmFzc2VydEN1cnJlbnQoKTtcbiAgICBpZiAoIXRoaXMuaWRlbnRpdHkuc2NoZW1hUHJvcGVydHlOYW1lcy5pbmNsdWRlcyhwcm9wZXJ0eUtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk1DUCBmb3JtIGNvbnRyb2wgZHJpZnQ6IHVua25vd24gcHJvcGVydHlcIik7XG4gICAgfVxuICAgIGNvbnN0IG1hdGNoZXMgPSBBcnJheS5mcm9tKFxuICAgICAgdGhpcy5mb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoJ2lucHV0Om5vdChbdHlwZV0pLCBpbnB1dFt0eXBlPVwidGV4dFwiXSwgaW5wdXRbdHlwZT1cInNlYXJjaFwiXSwgdGV4dGFyZWEnKSxcbiAgICApLmZpbHRlcigoZWxlbWVudCkgPT4gY29udHJvbE1hdGNoZXNQcm9wZXJ0eShcbiAgICAgIGVsZW1lbnQsXG4gICAgICBwcm9wZXJ0eUtleSxcbiAgICAgIHRoaXMuaWRlbnRpdHkuc2NoZW1hUHJvcGVydHlOYW1lcyxcbiAgICAgIHRoaXMucmVzb2x2ZUZpYmVyLFxuICAgICkpO1xuICAgIGlmIChtYXRjaGVzLmxlbmd0aCAhPT0gMSkgdGhyb3cgbmV3IEVycm9yKFwiTUNQIGZvcm0gY29udHJvbCBkcmlmdDogdGV4dCBjb250cm9sIGlzIG5vdCB1bmlxdWVcIik7XG4gICAgc2V0Q29udHJvbGxlZFRleHQobWF0Y2hlc1swXSBhcyBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudCwgdmFsdWUpO1xuICB9XG5cbiAgY29udGludWVOb3JtYWxseSgpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5jb250aW51ZURpc3BhdGNoZWQpIHJldHVybjtcbiAgICB0aGlzLmFzc2VydEN1cnJlbnQoKTtcbiAgICBjb25zdCBjb250cm9scyA9IEFycmF5LmZyb20odGhpcy5mb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvblt0eXBlPVwic3VibWl0XCJdLCBpbnB1dFt0eXBlPVwic3VibWl0XCJdJykpO1xuICAgIGlmIChjb250cm9scy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihcIk1DUCBmb3JtIGNvbnRyb2wgZHJpZnQ6IHN1Ym1pdCBjb250cm9sIGlzIG5vdCB1bmlxdWVcIik7XG4gICAgLy8gTWFyayB0aGUgaGFuZG9mZiBiZWZvcmUgaW52b2tpbmcgaG9zdCBjb2RlLiBBIGhvc3QgY2FsbGJhY2sgY2FuIHJlbW92ZSB0aGVcbiAgICAvLyBmb3JtIG9yIHRocm93IGFmdGVyIGFjY2VwdGluZyB0aGUgY2xpY2ssIHNvIGFuIHVuY2VydGFpbiByZW5kZXJlciByZXRyeVxuICAgIC8vIG11c3QgbmV2ZXIgZGlzcGF0Y2ggYSBzZWNvbmQgQ29udGludWUgZm9yIHRoZSBzYW1lIGNsYWltZWQgY2Fycmllci5cbiAgICB0aGlzLmNvbnRpbnVlRGlzcGF0Y2hlZCA9IHRydWU7XG4gICAgKGNvbnRyb2xzWzBdIGFzIEhUTUxFbGVtZW50KS5jbGljaygpO1xuICB9XG5cbiAgY2FuY2VsTm9ybWFsbHkoKTogdm9pZCB7XG4gICAgdGhpcy5hc3NlcnRDdXJyZW50KCk7XG4gICAgY29uc3QgY29udHJvbHMgPSBBcnJheS5mcm9tKHRoaXMuZm9ybS5xdWVyeVNlbGVjdG9yQWxsKFxuICAgICAgJ2J1dHRvblt0eXBlPVwiYnV0dG9uXCJdOm5vdChbcm9sZT1cInJhZGlvXCJdKTpub3QoW3JvbGU9XCJjaGVja2JveFwiXSknLFxuICAgICkpO1xuICAgIGlmIChjb250cm9scy5sZW5ndGggIT09IDEpIHRocm93IG5ldyBFcnJvcihcIk1DUCBmb3JtIGNvbnRyb2wgZHJpZnQ6IGNhbmNlbCBjb250cm9sIGlzIG5vdCB1bmlxdWVcIik7XG4gICAgKGNvbnRyb2xzWzBdIGFzIEhUTUxFbGVtZW50KS5jbGljaygpO1xuICB9XG5cbiAgbW91bnRBY2tub3dsZWRnZW1lbnQob3duZXI6IFwib3duZWRcIiB8IFwiZ2VuZXJpY1wiKTogSG9zdE1jcERlbGl2ZXJ5QWNrbm93bGVkZ2VtZW50IHtcbiAgICB0aGlzLmFzc2VydEN1cnJlbnQoKTtcbiAgICBpZiAob3duZXIgPT09IFwiZ2VuZXJpY1wiKSB0aGlzLmFzc2VydFZpc2libGVHZW5lcmljRm9ybSgpO1xuICAgIHJldHVybiBkZWxpdmVyeUFja25vd2xlZGdlbWVudChvd25lciA9PT0gXCJvd25lZFwiID8gXCJvd25lZF9tb3VudFwiIDogXCJnZW5lcmljX21vdW50XCIpO1xuICB9XG5cbiAgcHJpdmF0ZSBleGFjdENob2ljZShcbiAgICByb2xlOiBcInJhZGlvXCIgfCBcImNoZWNrYm94XCIsXG4gICAgcHJvcGVydHlLZXk6IHN0cmluZyxcbiAgICBvcHRpb25LZXk6IHN0cmluZyxcbiAgKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICAgIHRoaXMuYXNzZXJ0Q3VycmVudCgpO1xuICAgIGlmICghdGhpcy5pZGVudGl0eS5zY2hlbWFQcm9wZXJ0eU5hbWVzLmluY2x1ZGVzKHByb3BlcnR5S2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTUNQIGZvcm0gY29udHJvbCBkcmlmdDogdW5rbm93biBwcm9wZXJ0eVwiKTtcbiAgICB9XG4gICAgY29uc3QgbWF0Y2hlcyA9IEFycmF5LmZyb20odGhpcy5mb3JtLnF1ZXJ5U2VsZWN0b3JBbGwoYGJ1dHRvbltyb2xlPVwiJHtyb2xlfVwiXWApKS5maWx0ZXIoXG4gICAgICAoZWxlbWVudCkgPT4gY29udHJvbE1hdGNoZXNQcm9wZXJ0eShcbiAgICAgICAgZWxlbWVudCxcbiAgICAgICAgcHJvcGVydHlLZXksXG4gICAgICAgIHRoaXMuaWRlbnRpdHkuc2NoZW1hUHJvcGVydHlOYW1lcyxcbiAgICAgICAgdGhpcy5yZXNvbHZlRmliZXIsXG4gICAgICApICYmIGNvbnRyb2xNYXRjaGVzT3B0aW9uKGVsZW1lbnQsIG9wdGlvbktleSwgdGhpcy5yZXNvbHZlRmliZXIpLFxuICAgICk7XG4gICAgaWYgKG1hdGNoZXMubGVuZ3RoICE9PSAxKSB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZm9ybSBjb250cm9sIGRyaWZ0OiBjaG9pY2UgY29udHJvbCBpcyBub3QgdW5pcXVlXCIpO1xuICAgIHJldHVybiBtYXRjaGVzWzBdIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICB9XG5cbiAgcHJpdmF0ZSBhc3NlcnRDdXJyZW50KCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5pc0N1cnJlbnQoKSkgdGhyb3cgbmV3IEVycm9yKFwiTUNQIGZvcm0gY2FycmllciBpcyBubyBsb25nZXIgY3VycmVudFwiKTtcbiAgfVxuXG4gIHByaXZhdGUgYXNzZXJ0VmlzaWJsZUdlbmVyaWNGb3JtKCk6IHZvaWQge1xuICAgIGNvbnN0IGZvcm0gPSB0aGlzLmZvcm07XG4gICAgY29uc3Qgb3duZXJEb2N1bWVudCA9IGZvcm0ub3duZXJEb2N1bWVudDtcbiAgICBjb25zdCBkb2N1bWVudEVsZW1lbnQgPSBvd25lckRvY3VtZW50Py5kb2N1bWVudEVsZW1lbnQ7XG4gICAgY29uc3QgdmlldyA9IGZvcm0ub3duZXJEb2N1bWVudD8uZGVmYXVsdFZpZXc7XG4gICAgaWYgKCFvd25lckRvY3VtZW50IHx8ICFkb2N1bWVudEVsZW1lbnQgfHwgIXZpZXcgfHwgdHlwZW9mIHZpZXcuZ2V0Q29tcHV0ZWRTdHlsZSAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZ2VuZXJpYyBmb3JtIHZpc2liaWxpdHkgY291bGQgbm90IGJlIG1lYXN1cmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PEVsZW1lbnQ+KCk7XG4gICAgbGV0IGVsZW1lbnQ6IEVsZW1lbnQgfCBudWxsID0gZm9ybTtcbiAgICBsZXQgcmVhY2hlZERvY3VtZW50RWxlbWVudCA9IGZhbHNlO1xuICAgIGZvciAobGV0IGRlcHRoID0gMDsgZWxlbWVudCAmJiBkZXB0aCA8IE1BWF9NQ1BfVklTSUJJTElUWV9BTkNFU1RPUlM7IGRlcHRoICs9IDEpIHtcbiAgICAgIGlmIChzZWVuLmhhcyhlbGVtZW50KSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZ2VuZXJpYyBmb3JtIHZpc2liaWxpdHkgY2hhaW4gaXMgY3ljbGljXCIpO1xuICAgICAgfVxuICAgICAgc2Vlbi5hZGQoZWxlbWVudCk7XG4gICAgICBpZiAoZWxlbWVudC5vd25lckRvY3VtZW50ICE9PSBvd25lckRvY3VtZW50IHx8ICFlbGVtZW50LmlzQ29ubmVjdGVkKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIk1DUCBnZW5lcmljIGZvcm0gdmlzaWJpbGl0eSBjaGFpbiBpcyBkaXNjb25uZWN0ZWRcIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHZpc2liaWxpdHlFbGVtZW50ID0gZWxlbWVudCBhcyBFbGVtZW50ICYgeyBoaWRkZW4/OiBib29sZWFuOyBpbmVydD86IGJvb2xlYW4gfTtcbiAgICAgIGlmIChcbiAgICAgICAgdmlzaWJpbGl0eUVsZW1lbnQuaGlkZGVuID09PSB0cnVlXG4gICAgICAgIHx8IHZpc2liaWxpdHlFbGVtZW50LmluZXJ0ID09PSB0cnVlXG4gICAgICAgIHx8IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiYXJpYS1oaWRkZW5cIik/LnRyaW0oKS50b0xvd2VyQ2FzZSgpID09PSBcInRydWVcIlxuICAgICAgKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIk1DUCBnZW5lcmljIGZvcm0gaXMgaGlkZGVuIG9yIHN1cHByZXNzZWRcIik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0eWxlID0gdmlldy5nZXRDb21wdXRlZFN0eWxlKGVsZW1lbnQpO1xuICAgICAgY29uc3Qgb3BhY2l0eSA9IE51bWJlci5wYXJzZUZsb2F0KHN0eWxlLm9wYWNpdHkpO1xuICAgICAgaWYgKFxuICAgICAgICBzdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIlxuICAgICAgICB8fCBzdHlsZS52aXNpYmlsaXR5ID09PSBcImhpZGRlblwiXG4gICAgICAgIHx8IHN0eWxlLnZpc2liaWxpdHkgPT09IFwiY29sbGFwc2VcIlxuICAgICAgICB8fCAoTnVtYmVyLmlzRmluaXRlKG9wYWNpdHkpICYmIG9wYWNpdHkgPD0gMClcbiAgICAgICAgfHwgc3R5bGUuY29udGVudFZpc2liaWxpdHkgPT09IFwiaGlkZGVuXCJcbiAgICAgICkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZ2VuZXJpYyBmb3JtIGlzIG5vdCB2aXNpYmx5IHBhaW50ZWRcIik7XG4gICAgICB9XG5cbiAgICAgIGlmIChlbGVtZW50ID09PSBkb2N1bWVudEVsZW1lbnQpIHtcbiAgICAgICAgcmVhY2hlZERvY3VtZW50RWxlbWVudCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgZWxlbWVudCA9IGVsZW1lbnQucGFyZW50RWxlbWVudDtcbiAgICB9XG4gICAgaWYgKCFyZWFjaGVkRG9jdW1lbnRFbGVtZW50KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZ2VuZXJpYyBmb3JtIHZpc2liaWxpdHkgY2hhaW4gZGlkIG5vdCByZWFjaCB0aGUgZG9jdW1lbnQgYm91bmRhcnlcIik7XG4gICAgfVxuXG4gICAgY29uc3QgcmVjdHMgPSBBcnJheS5mcm9tKGZvcm0uZ2V0Q2xpZW50UmVjdHMoKSk7XG4gICAgY29uc3QgcGFpbnRlZCA9IHJlY3RzLnNvbWUoKHJlY3QpID0+IChcbiAgICAgIE51bWJlci5pc0Zpbml0ZShyZWN0LndpZHRoKVxuICAgICAgJiYgTnVtYmVyLmlzRmluaXRlKHJlY3QuaGVpZ2h0KVxuICAgICAgJiYgcmVjdC53aWR0aCA+IDBcbiAgICAgICYmIHJlY3QuaGVpZ2h0ID4gMFxuICAgICkpO1xuICAgIGlmICghcGFpbnRlZCkgdGhyb3cgbmV3IEVycm9yKFwiTUNQIGdlbmVyaWMgZm9ybSBoYXMgbm8gcGFpbnRlZCBnZW9tZXRyeVwiKTtcbiAgICBpZiAoIWZvcm0uaXNDb25uZWN0ZWQgfHwgZm9ybS5vd25lckRvY3VtZW50ICE9PSBvd25lckRvY3VtZW50KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJNQ1AgZ2VuZXJpYyBmb3JtIHZpc2liaWxpdHkgY2hhaW4gaXMgZGlzY29ubmVjdGVkXCIpO1xuICAgIH1cbiAgICB0aGlzLmFzc2VydEN1cnJlbnQoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpbnNwZWN0Q2FycmllckZvcm0oXG4gIGZvcm06IEhUTUxGb3JtRWxlbWVudCxcbiAgbm9uY2U6IHN0cmluZyxcbiAgcmVzb2x2ZUZpYmVyOiAoZWxlbWVudDogRWxlbWVudCkgPT4gUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuKTogQ2Fycmllckluc3BlY3Rpb24ge1xuICBjb25zdCBmaXJzdCA9IHJlc29sdmVGaWJlcihmb3JtKSBhcyBDYXJyaWVyRmliZXIgfCBudWxsO1xuICBpZiAoIWZpcnN0KSByZXR1cm4geyBzdGF0dXM6IFwiZGVjbGluZWRcIiwgcmVhc29uOiBcIm1pc3NpbmdfZmliZXJcIiB9O1xuICBjb25zdCBpZGVudGl0aWVzOiBDYXJyaWVySWRlbnRpdHlJbnRlcm5hbFtdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PENhcnJpZXJGaWJlcj4oKTtcbiAgbGV0IGZpYmVyOiBDYXJyaWVyRmliZXIgfCBudWxsID0gZmlyc3Q7XG4gIGxldCBkZXB0aCA9IDA7XG4gIGxldCBtYWxmb3JtZWRDYXJyaWVyUHJvcHMgPSBmYWxzZTtcbiAgd2hpbGUgKGZpYmVyICYmIGRlcHRoIDwgTUFYX01DUF9GSUJFUl9ERVBUSCkge1xuICAgIGlmIChzZWVuLmhhcyhmaWJlcikpIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwiYW5jZXN0b3JfY3ljbGVcIiB9O1xuICAgIHNlZW4uYWRkKGZpYmVyKTtcbiAgICBjb25zdCBwcm9wcyA9IGFzUmVjb3JkKGZpYmVyLm1lbW9pemVkUHJvcHMpO1xuICAgIGlmIChwcm9wcyAmJiBjb21wbGV0ZUNhcnJpZXJJZGVudGl0eUNhbmRpZGF0ZShwcm9wcykpIHtcbiAgICAgIGNvbnN0IGlkZW50aXR5ID0gcGFyc2VDYXJyaWVySWRlbnRpdHkocHJvcHMpO1xuICAgICAgaWYgKGlkZW50aXR5KSBpZGVudGl0aWVzLnB1c2goaWRlbnRpdHkpO1xuICAgICAgZWxzZSBtYWxmb3JtZWRDYXJyaWVyUHJvcHMgPSB0cnVlO1xuICAgIH1cbiAgICBmaWJlciA9IGZpYmVyLnJldHVybiBhcyBDYXJyaWVyRmliZXIgfCBudWxsO1xuICAgIGRlcHRoICs9IDE7XG4gIH1cbiAgaWYgKGZpYmVyKSByZXR1cm4geyBzdGF0dXM6IFwiZGVjbGluZWRcIiwgcmVhc29uOiBcImFuY2VzdG9yX2JvdW5kX2V4Y2VlZGVkXCIgfTtcbiAgaWYgKG1hbGZvcm1lZENhcnJpZXJQcm9wcyB8fCBpZGVudGl0aWVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IFwibWlzc2luZ19vcl9pbnZhbGlkX3Byb3BzXCIgfTtcbiAgfVxuICBpZiAoaWRlbnRpdGllcy5sZW5ndGggPiAxKSB7XG4gICAgY29uc3Qgc2hhcGVzID0gbmV3IFNldChpZGVudGl0aWVzLm1hcChzdGFibGVDYXJyaWVySWRlbnRpdHlTaGFwZSkpO1xuICAgIHJldHVybiB7IHN0YXR1czogXCJkZWNsaW5lZFwiLCByZWFzb246IHNoYXBlcy5zaXplID09PSAxID8gXCJkdXBsaWNhdGVfcHJvcHNcIiA6IFwiY29uZmxpY3RpbmdfcHJvcHNcIiB9O1xuICB9XG4gIGNvbnN0IGlkZW50aXR5ID0gaWRlbnRpdGllc1swXTtcbiAgaWYgKCFPYmplY3QuaGFzT3duKGlkZW50aXR5LnNjaGVtYVByb3BlcnRpZXMsIGAke01DUF9DQVJSSUVSX05PTkNFX1BSRUZJWH0ke25vbmNlfWApKSB7XG4gICAgcmV0dXJuIHsgc3RhdHVzOiBcImRlY2xpbmVkXCIsIHJlYXNvbjogXCJub25jZV9ub3RfaW5fc2NoZW1hXCIgfTtcbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IFwiYXR0YWNoZWRcIiwgaWRlbnRpdHksIGlkZW50aXR5U2hhcGU6IHN0YWJsZUNhcnJpZXJJZGVudGl0eVNoYXBlKGlkZW50aXR5KSB9O1xufVxuXG5mdW5jdGlvbiBjb21wbGV0ZUNhcnJpZXJJZGVudGl0eUNhbmRpZGF0ZShwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pOiBib29sZWFuIHtcbiAgcmV0dXJuIE1DUF9DQVJSSUVSX0lERU5USVRZX0tFWVMuZXZlcnkoKGtleSkgPT4gT2JqZWN0Lmhhc093bihwcm9wcywga2V5KSk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQ2FycmllcklkZW50aXR5KHByb3BzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IENhcnJpZXJJZGVudGl0eUludGVybmFsIHwgbnVsbCB7XG4gIGNvbnN0IGVsaWNpdGF0aW9uID0gYXNSZWNvcmQocHJvcHMuZWxpY2l0YXRpb24pO1xuICBjb25zdCBzY2hlbWEgPSBhc1JlY29yZChlbGljaXRhdGlvbj8uc2NoZW1hKTtcbiAgY29uc3QgcHJvcGVydGllcyA9IGFzUmVjb3JkKHNjaGVtYT8ucHJvcGVydGllcyk7XG4gIGNvbnN0IHJlcXVlc3RJZCA9IGJvdW5kZWRJZGVudGl0eShwcm9wcy5yZXF1ZXN0SWQpO1xuICBjb25zdCBjb252ZXJzYXRpb25JZCA9IGJvdW5kZWRJZGVudGl0eShwcm9wcy5jb252ZXJzYXRpb25JZCk7XG4gIGNvbnN0IGhvc3RJZCA9IGJvdW5kZWRJZGVudGl0eShwcm9wcy5ob3N0SWQpO1xuICBpZiAoXG4gICAgZWxpY2l0YXRpb24/LmtpbmQgIT09IFwiZm9ybUVsaWNpdGF0aW9uXCIgfHxcbiAgICBzY2hlbWE/LnR5cGUgIT09IFwib2JqZWN0XCIgfHxcbiAgICAhcHJvcGVydGllcyB8fFxuICAgICFyZXF1ZXN0SWQgfHxcbiAgICAhY29udmVyc2F0aW9uSWQgfHxcbiAgICAhaG9zdElkXG4gICkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGVudHJpZXMgPSBPYmplY3QuZW50cmllcyhwcm9wZXJ0aWVzKTtcbiAgaWYgKGVudHJpZXMubGVuZ3RoID09PSAwIHx8IGVudHJpZXMubGVuZ3RoID4gTUFYX01DUF9TQ0hFTUFfUFJPUEVSVElFUykgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHNjaGVtYVByb3BlcnRpZXM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiA9IHt9O1xuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBlbnRyaWVzKSB7XG4gICAgY29uc3QgcHJvcGVydHkgPSBhc1JlY29yZCh2YWx1ZSk7XG4gICAgaWYgKCFrZXkgfHwga2V5Lmxlbmd0aCA+IE1BWF9NQ1BfSURFTlRJVFlfTEVOR1RIIHx8ICFwcm9wZXJ0eSB8fCB0eXBlb2YgcHJvcGVydHkudHlwZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gICAgc2NoZW1hUHJvcGVydGllc1trZXldID0gcHJvcGVydHk7XG4gIH1cbiAgcmV0dXJuIHsgcmVxdWVzdElkLCBjb252ZXJzYXRpb25JZCwgaG9zdElkLCBzY2hlbWFQcm9wZXJ0aWVzIH07XG59XG5cbmZ1bmN0aW9uIHN0YWJsZUNhcnJpZXJJZGVudGl0eVNoYXBlKGlkZW50aXR5OiBDYXJyaWVySWRlbnRpdHlJbnRlcm5hbCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBpZGVudGl0eS5yZXF1ZXN0SWQsXG4gICAgY29udmVyc2F0aW9uSWQ6IGlkZW50aXR5LmNvbnZlcnNhdGlvbklkLFxuICAgIGhvc3RJZDogaWRlbnRpdHkuaG9zdElkLFxuICAgIHByb3BlcnR5U2hhcGU6IE9iamVjdC5lbnRyaWVzKGlkZW50aXR5LnNjaGVtYVByb3BlcnRpZXMpXG4gICAgICAuc29ydCgoW2xlZnRdLCBbcmlnaHRdKSA9PiBsZWZ0LmxvY2FsZUNvbXBhcmUocmlnaHQpKVxuICAgICAgLm1hcCgoW2tleSwgcHJvcGVydHldKSA9PiBbXG4gICAgICAgIGtleSxcbiAgICAgICAgcHJvcGVydHkudHlwZSxcbiAgICAgICAgcHJvcGVydHkuY29uc3QgPz8gbnVsbCxcbiAgICAgICAgcHJvcGVydHkuZW51bSA/PyBudWxsLFxuICAgICAgICBhc1JlY29yZChwcm9wZXJ0eS5pdGVtcyk/LmVudW0gPz8gbnVsbCxcbiAgICAgIF0pLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcHVibGljQ2FycmllcklkZW50aXR5KGlkZW50aXR5OiBDYXJyaWVySWRlbnRpdHlJbnRlcm5hbCk6IFJlYWRvbmx5PEhvc3RNY3BGb3JtSWRlbnRpdHk+IHtcbiAgcmV0dXJuIE9iamVjdC5mcmVlemUoe1xuICAgIHJlcXVlc3RJZDogaWRlbnRpdHkucmVxdWVzdElkLFxuICAgIGNvbnZlcnNhdGlvbklkOiBpZGVudGl0eS5jb252ZXJzYXRpb25JZCxcbiAgICBob3N0SWQ6IGlkZW50aXR5Lmhvc3RJZCxcbiAgICBzY2hlbWFQcm9wZXJ0eU5hbWVzOiBPYmplY3QuZnJlZXplKE9iamVjdC5rZXlzKGlkZW50aXR5LnNjaGVtYVByb3BlcnRpZXMpKSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNvbnRyb2xNYXRjaGVzUHJvcGVydHkoXG4gIGVsZW1lbnQ6IEVsZW1lbnQsXG4gIGV4cGVjdGVkOiBzdHJpbmcsXG4gIHNjaGVtYVByb3BlcnR5TmFtZXM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICByZXNvbHZlRmliZXI6IChlbGVtZW50OiBFbGVtZW50KSA9PiBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgY29uc3Qga25vd24gPSBuZXcgU2V0KHNjaGVtYVByb3BlcnR5TmFtZXMpO1xuICBjb25zdCBtYXRjaGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IGJvdW5kZWQgPSB3YWxrQ29udHJvbEZpYmVycyhlbGVtZW50LCByZXNvbHZlRmliZXIsIChmaWJlcikgPT4ge1xuICAgIGNvbnN0IHByb3BzID0gYXNSZWNvcmQoZmliZXIubWVtb2l6ZWRQcm9wcyk7XG4gICAgaWYgKCFwcm9wcykgcmV0dXJuO1xuICAgIGNvbnN0IHF1ZXVlOiB1bmtub3duW10gPSBbcHJvcHNdO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHVua25vd24+KCk7XG4gICAgZm9yIChsZXQgdmlzaXRlZCA9IDA7IHF1ZXVlLmxlbmd0aCAmJiB2aXNpdGVkIDwgMzI7IHZpc2l0ZWQgKz0gMSkge1xuICAgICAgY29uc3QgdmFsdWUgPSBxdWV1ZS5zaGlmdCgpO1xuICAgICAgY29uc3QgcmVjb3JkID0gYXNSZWNvcmQodmFsdWUpO1xuICAgICAgaWYgKCFyZWNvcmQgfHwgc2Vlbi5oYXMocmVjb3JkKSkgY29udGludWU7XG4gICAgICBzZWVuLmFkZChyZWNvcmQpO1xuICAgICAgZm9yIChjb25zdCBba2V5LCBpdGVtXSBvZiBPYmplY3QuZW50cmllcyhyZWNvcmQpKSB7XG4gICAgICAgIGlmIChbXCJuYW1lXCIsIFwicHJvcGVydHlLZXlcIiwgXCJmaWVsZE5hbWVcIl0uaW5jbHVkZXMoa2V5KSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIiAmJiBrbm93bi5oYXMoaXRlbSkpIHtcbiAgICAgICAgICBtYXRjaGVzLmFkZChpdGVtKTtcbiAgICAgICAgfSBlbHNlIGlmIChpdGVtICYmIHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgcXVldWUucHVzaChpdGVtKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgfSk7XG4gIHJldHVybiBib3VuZGVkICYmIG1hdGNoZXMuc2l6ZSA9PT0gMSAmJiBtYXRjaGVzLmhhcyhleHBlY3RlZCk7XG59XG5cbmZ1bmN0aW9uIGNvbnRyb2xNYXRjaGVzT3B0aW9uKFxuICBlbGVtZW50OiBFbGVtZW50LFxuICBleHBlY3RlZDogc3RyaW5nLFxuICByZXNvbHZlRmliZXI6IChlbGVtZW50OiBFbGVtZW50KSA9PiBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBib3VuZGVkID0gd2Fsa0NvbnRyb2xGaWJlcnMoZWxlbWVudCwgcmVzb2x2ZUZpYmVyLCAoZmliZXIpID0+IHtcbiAgICBpZiAodHlwZW9mIGZpYmVyLmtleSA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgZmliZXIua2V5ID09PSBcIm51bWJlclwiKSB7XG4gICAgICBjb25zdCBrZXkgPSBTdHJpbmcoZmliZXIua2V5KTtcbiAgICAgIGNhbmRpZGF0ZXMuYWRkKGtleSk7XG4gICAgICBpZiAoa2V5LnN0YXJ0c1dpdGgoXCIuJFwiKSkgY2FuZGlkYXRlcy5hZGQoa2V5LnNsaWNlKDIpKTtcbiAgICB9XG4gICAgY29uc3QgcHJvcHMgPSBhc1JlY29yZChmaWJlci5tZW1vaXplZFByb3BzKTtcbiAgICBmb3IgKGNvbnN0IGtleSBvZiBbXCJ2YWx1ZVwiLCBcIm9wdGlvbktleVwiXSkge1xuICAgICAgaWYgKHR5cGVvZiBwcm9wcz8uW2tleV0gPT09IFwic3RyaW5nXCIpIGNhbmRpZGF0ZXMuYWRkKHByb3BzW2tleV0gYXMgc3RyaW5nKTtcbiAgICB9XG4gICAgY29uc3Qgb3B0aW9uID0gYXNSZWNvcmQocHJvcHM/Lm9wdGlvbik7XG4gICAgaWYgKHR5cGVvZiBvcHRpb24/LnZhbHVlID09PSBcInN0cmluZ1wiKSBjYW5kaWRhdGVzLmFkZChvcHRpb24udmFsdWUpO1xuICB9KTtcbiAgcmV0dXJuIGJvdW5kZWQgJiYgY2FuZGlkYXRlcy5oYXMoZXhwZWN0ZWQpO1xufVxuXG5mdW5jdGlvbiB3YWxrQ29udHJvbEZpYmVycyhcbiAgZWxlbWVudDogRWxlbWVudCxcbiAgcmVzb2x2ZUZpYmVyOiAoZWxlbWVudDogRWxlbWVudCkgPT4gUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuICB2aXNpdG9yOiAoZmliZXI6IENhcnJpZXJGaWJlcikgPT4gdm9pZCxcbik6IGJvb2xlYW4ge1xuICBsZXQgZmliZXIgPSByZXNvbHZlRmliZXIoZWxlbWVudCkgYXMgQ2FycmllckZpYmVyIHwgbnVsbDtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8Q2FycmllckZpYmVyPigpO1xuICBmb3IgKGxldCBkZXB0aCA9IDA7IGZpYmVyICYmIGRlcHRoIDwgTUFYX01DUF9GSUJFUl9ERVBUSDsgZGVwdGggKz0gMSkge1xuICAgIGlmIChzZWVuLmhhcyhmaWJlcikpIHJldHVybiBmYWxzZTtcbiAgICBzZWVuLmFkZChmaWJlcik7XG4gICAgdmlzaXRvcihmaWJlcik7XG4gICAgZmliZXIgPSBmaWJlci5yZXR1cm4gYXMgQ2FycmllckZpYmVyIHwgbnVsbDtcbiAgfVxuICByZXR1cm4gZmliZXIgPT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIHNldENvbnRyb2xsZWRUZXh0KGlucHV0OiBIVE1MSW5wdXRFbGVtZW50IHwgSFRNTFRleHRBcmVhRWxlbWVudCwgdmFsdWU6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwcm90b3R5cGUgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YoaW5wdXQpIGFzIG9iamVjdCB8IG51bGw7XG4gIGNvbnN0IHNldHRlciA9IHByb3RvdHlwZSA/IE9iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IocHJvdG90eXBlLCBcInZhbHVlXCIpPy5zZXQgOiB1bmRlZmluZWQ7XG4gIGlmIChzZXR0ZXIpIHNldHRlci5jYWxsKGlucHV0LCB2YWx1ZSk7XG4gIGVsc2UgaW5wdXQudmFsdWUgPSB2YWx1ZTtcbiAgY29uc3QgaW5wdXRFdmVudCA9IHR5cGVvZiBJbnB1dEV2ZW50ID09PSBcImZ1bmN0aW9uXCJcbiAgICA/IG5ldyBJbnB1dEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlLCBpbnB1dFR5cGU6IFwiaW5zZXJ0VGV4dFwiLCBkYXRhOiBudWxsIH0pXG4gICAgOiBuZXcgRXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUgfSk7XG4gIGlucHV0LmRpc3BhdGNoRXZlbnQoaW5wdXRFdmVudCk7XG4gIGlucHV0LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiY2hhbmdlXCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG59XG5cbmZ1bmN0aW9uIHZhbGlkQ2Fycmllck5vbmNlKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiAvXltBLVphLXowLTkuX34tXXs4LDEyOH0kLy50ZXN0KHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gYm91bmRlZElkZW50aXR5KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUudHJpbSgpLmxlbmd0aCA+IDAgJiYgdmFsdWUubGVuZ3RoIDw9IE1BWF9NQ1BfSURFTlRJVFlfTEVOR1RIXG4gICAgPyB2YWx1ZVxuICAgIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gYXNSZWNvcmQodmFsdWU6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICByZXR1cm4gdmFsdWUgIT09IG51bGwgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHZhbHVlKVxuICAgID8gdmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGRlbGl2ZXJ5QWNrbm93bGVkZ2VtZW50KFxuICBzdGFnZTogSG9zdE1jcERlbGl2ZXJ5QWNrbm93bGVkZ2VtZW50W1wic3RhZ2VcIl0sXG4pOiBIb3N0TWNwRGVsaXZlcnlBY2tub3dsZWRnZW1lbnQge1xuICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7IHZlcnNpb246IDEsIHN0YWdlLCBjb250ZW50UmVkYWN0ZWQ6IHRydWUgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBxdWVyeUhvc3RTdXJmYWNlcyhraW5kOiBIb3N0U3VyZmFjZUtpbmQpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBpZiAodHlwZW9mIGRvY3VtZW50ID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm4gW107XG4gIGlmIChraW5kID09PSBcInByb2plY3RzXCIpIHJldHVybiBwcm9qZWN0Um93cygpO1xuICBpZiAoa2luZCA9PT0gXCJ0aHJlYWQtY29udGV4dFwiKSByZXR1cm4gdGhyZWFkQ29udGV4dHMoKTtcbiAgaWYgKGtpbmQgPT09IFwidXNhZ2VcIikgcmV0dXJuIHVzYWdlU3VyZmFjZXMoKTtcbiAgY29uc3Qgc2VsZWN0b3IgPSBTRUxFQ1RPUlNba2luZF07XG4gIHJldHVybiB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKSlcbiAgICAuZmlsdGVyKChlbGVtZW50KSA9PiBzZW1hbnRpY0ZpbHRlcihraW5kLCBlbGVtZW50KSlcbiAgICAuc2xpY2UoMCwgTUFYX01BVENIRVMpXG4gICAgLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZCwgZWxlbWVudCwgY29uZmlkZW5jZTogY29uZmlkZW5jZUZvcihraW5kLCBlbGVtZW50KSwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIHNuYXBzaG90KGtpbmQ6IEhvc3RTdXJmYWNlS2luZCk6IEhvc3RTdXJmYWNlU25hcHNob3Qge1xuICBjb25zdCBtYXRjaGVzID0gcXVlcnlIb3N0U3VyZmFjZXMoa2luZCkuc2xpY2UoMCwgTUFYX01BVENIRVMpO1xuICByZXR1cm4geyBraW5kLCBjb3VudDogbWF0Y2hlcy5sZW5ndGgsIG1hdGNoZXMgfTtcbn1cblxuZnVuY3Rpb24gb2JzZXJ2ZShraW5kczogSG9zdFN1cmZhY2VLaW5kW10sIGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgZW50cnkgPSB7IGtpbmRzOiBbLi4ubmV3IFNldChraW5kcyldLCBsaXN0ZW5lciB9O1xuICBsaXN0ZW5lcnMuYWRkKGVudHJ5KTtcbiAgZW5zdXJlT2JzZXJ2ZXIoKTtcbiAgc2FmZWx5Tm90aWZ5KGVudHJ5LCBlbnRyeS5raW5kcy5tYXAoc25hcHNob3QpKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBsaXN0ZW5lcnMuZGVsZXRlKGVudHJ5KTtcbiAgICBpZiAoIWxpc3RlbmVycy5zaXplKSB7XG4gICAgICBzaGFyZWRPYnNlcnZlcj8uZGlzY29ubmVjdCgpO1xuICAgICAgc2hhcmVkT2JzZXJ2ZXIgPSBudWxsO1xuICAgICAgaWYgKHBlbmRpbmdGcmFtZSAhPT0gbnVsbCkgY2FuY2VsQW5pbWF0aW9uRnJhbWUocGVuZGluZ0ZyYW1lKTtcbiAgICAgIHBlbmRpbmdGcmFtZSA9IG51bGw7XG4gICAgfVxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnN1cmVPYnNlcnZlcigpOiB2b2lkIHtcbiAgaWYgKHNoYXJlZE9ic2VydmVyIHx8IHR5cGVvZiBNdXRhdGlvbk9ic2VydmVyID09PSBcInVuZGVmaW5lZFwiIHx8IHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuO1xuICBzaGFyZWRPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpZiAocGVuZGluZ0ZyYW1lICE9PSBudWxsKSByZXR1cm47XG4gICAgcGVuZGluZ0ZyYW1lID0gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgIHBlbmRpbmdGcmFtZSA9IG51bGw7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGxpc3RlbmVycykgc2FmZWx5Tm90aWZ5KGVudHJ5LCBlbnRyeS5raW5kcy5tYXAoc25hcHNob3QpKTtcbiAgICB9KTtcbiAgfSk7XG4gIHNoYXJlZE9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7XG4gICAgYXR0cmlidXRlczogdHJ1ZSxcbiAgICBhdHRyaWJ1dGVGaWx0ZXI6IFtcImFyaWEtbGFiZWxcIiwgXCJhcmlhLWN1cnJlbnRcIiwgXCJyb2xlXCIsIFwiZGF0YS10ZXN0aWRcIiwgXCJkYXRhLXByb2plY3QtaWRcIiwgXCJkYXRhLXByb2plY3QtbmFtZVwiLCBcImRhdGEtd29ya3NwYWNlLXBhdGhcIiwgXCJkYXRhLXVzYWdlLWxpbWl0LWtleVwiLCBcImRhdGEtdXNhZ2UtbGltaXRcIiwgXCJkaXNhYmxlZFwiXSxcbiAgICBjaGlsZExpc3Q6IHRydWUsXG4gICAgY2hhcmFjdGVyRGF0YTogdHJ1ZSxcbiAgICBzdWJ0cmVlOiB0cnVlLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZWx5Tm90aWZ5KGVudHJ5OiB7IGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQgfSwgc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pOiB2b2lkIHtcbiAgdHJ5IHsgZW50cnkubGlzdGVuZXIoc25hcHNob3RzKTsgfVxuICBjYXRjaCAoZXJyb3IpIHsgY29uc29sZS53YXJuKFwiW3R3ZWFrZXJdIGhvc3Qgc3VyZmFjZSBvYnNlcnZlciBmYWlsZWRcIiwgZXJyb3IpOyB9XG59XG5cbmZ1bmN0aW9uIHByb2plY3RSb3dzKCk6IEhvc3RTdXJmYWNlTWF0Y2hbXSB7XG4gIGNvbnN0IGNvbnRyb2xzID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uLCBhLCBbcm9sZT1cImJ1dHRvblwiXScpKTtcbiAgcmV0dXJuIGNvbnRyb2xzLmZpbHRlcigoZWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGxhYmVsID0gY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KTtcbiAgICBpZiAoIWxhYmVsIHx8IGxhYmVsLmxlbmd0aCA+IDEyMCB8fCAhZWxlbWVudC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIEJvb2xlYW4oZGlyZWN0UHJvamVjdElkZW50aXR5KGVsZW1lbnQpKTtcbiAgfSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHtcbiAgICBraW5kOiBcInByb2plY3RzXCIsXG4gICAgZWxlbWVudCxcbiAgICBjb25maWRlbmNlOiBcImhpZ2hcIixcbiAgICBsYWJlbDogY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KSxcbiAgfSkpO1xufVxuXG4vKipcbiAqIEEgcHJvamVjdCByb3cgbXVzdCBvd24gcHJvamVjdCBpZGVudGl0eSBpdHNlbGYuIFdhbGtpbmcgYW5jZXN0b3IgZmliZXJzIG1hZGVcbiAqIGV2ZXJ5IGNvbnRyb2wgcmVuZGVyZWQgaW5zaWRlIGEgcHJvamVjdCByb3V0ZSBpbmhlcml0IHByb2plY3QgY29udGV4dDogdGFza1xuICogcm93cyBhbmQgZXZlbiB0aGUgdGl0bGViYXIgbW9kZWwgcGlja2VyIHRoZW4gbG9va2VkIGxpa2UgcHJvamVjdCByb3dzLiBLZWVwXG4gKiB0aGlzIHNlYW0gZmFpbC1jbG9zZWQgc28gY29uc3VtZXJzIG5ldmVyIGRlY29yYXRlIHVucmVsYXRlZCBob3N0IGNvbnRyb2xzLlxuICovXG5mdW5jdGlvbiBkaXJlY3RQcm9qZWN0SWRlbnRpdHkoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGNvbnN0IGF0dHJpYnV0ZSBvZiBbXG4gICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIsXG4gICAgXCJkYXRhLXByb2plY3QtaWRcIixcbiAgICBcImRhdGEtcHJvamVjdC1uYW1lXCIsXG4gICAgXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIsXG4gICAgXCJkYXRhLXByb2plY3QtcGF0aFwiLFxuICBdKSB7XG4gICAgY29uc3QgdmFsdWUgPSBlbGVtZW50LmdldEF0dHJpYnV0ZShhdHRyaWJ1dGUpPy50cmltKCk7XG4gICAgaWYgKHZhbHVlKSByZXR1cm4gdmFsdWU7XG4gIH1cbiAgY29uc3QgcHJvcHMgPSAoZmliZXJGb3JOb2RlKGVsZW1lbnQpIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbCk/Lm1lbW9pemVkUHJvcHM7XG4gIHJldHVybiBwcm9wcyAmJiB0eXBlb2YgcHJvcHMgPT09IFwib2JqZWN0XCJcbiAgICA/IGZpcnN0U3RyaW5nKHByb3BzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBbXCJwcm9qZWN0SWRcIiwgXCJwcm9qZWN0TmFtZVwiLCBcIndvcmtzcGFjZVBhdGhcIiwgXCJwcm9qZWN0UGF0aFwiXSkgPz8gbnVsbFxuICAgIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gdGhyZWFkQ29udGV4dHMoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb2plY3QtaWRdLCBbZGF0YS13b3Jrc3BhY2UtcGF0aF0sIG1haW4sIFtyb2xlPVwibWFpblwiXScpKTtcbiAgcmV0dXJuIGNhbmRpZGF0ZXMuZmlsdGVyKChlbGVtZW50KSA9PiB7XG4gICAgaWYgKGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpIHx8IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiKSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgcHJvcHMgPSBmaWJlclByb3BzKGVsZW1lbnQpO1xuICAgIHJldHVybiBCb29sZWFuKGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0SWRcIiwgXCJ3b3Jrc3BhY2VQYXRoXCIsIFwicHJvamVjdE5hbWVcIl0pKTtcbiAgfSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZDogXCJ0aHJlYWQtY29udGV4dFwiLCBlbGVtZW50LCBjb25maWRlbmNlOiBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1pZFwiKSA/IFwiaGlnaFwiIDogXCJtZWRpdW1cIiwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIHVzYWdlU3VyZmFjZXMoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgZGlyZWN0ID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNhZ2UtbGltaXQta2V5XSwgW2RhdGEtdXNhZ2UtbGltaXRdLCBbZGF0YS10ZXN0aWQqPVwidXNhZ2VcIiBpXSwgW2FyaWEtbGFiZWwqPVwidXNhZ2VcIiBpXSwgW2NsYXNzKj1cInVzYWdlXCIgaV0nKSk7XG4gIGNvbnN0IHRleHR1YWwgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwic2VjdGlvbiwgYXJ0aWNsZSwgW3JvbGU9J2xpc3RpdGVtJ11cIikpLmZpbHRlcigoZWxlbWVudCkgPT4gLyg/OnVzYWdlfGxpbWl0KS4qKD86cmVtYWluaW5nfHJlc2V0fHVzZWQpfCg/OnJlbWFpbmluZ3xyZXNldHx1c2VkKS4qKD86dXNhZ2V8bGltaXQpL2kudGVzdChjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpKSk7XG4gIHJldHVybiB1bmlxdWVFbGVtZW50cyhbLi4uZGlyZWN0LCAuLi50ZXh0dWFsXSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZDogXCJ1c2FnZVwiLCBlbGVtZW50LCBjb25maWRlbmNlOiBkaXJlY3QuaW5jbHVkZXMoZWxlbWVudCkgPyBcImhpZ2hcIiA6IFwibWVkaXVtXCIsIGxhYmVsOiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudCkgfSkpO1xufVxuXG5mdW5jdGlvbiBnZXRBY3RpdmVQcm9qZWN0KCk6IEhvc3RQcm9qZWN0Q29udGV4dCB8IG51bGwge1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHF1ZXJ5SG9zdFN1cmZhY2VzKFwidGhyZWFkLWNvbnRleHRcIikpIHtcbiAgICBjb25zdCBlbGVtZW50ID0gbWF0Y2guZWxlbWVudDtcbiAgICBjb25zdCBwcm9wcyA9IGZpYmVyUHJvcHMoZWxlbWVudCk7XG4gICAgY29uc3QgY29udGV4dCA9IHtcbiAgICAgIGlkOiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1pZFwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wicHJvamVjdElkXCIsIFwiaWRcIl0pLFxuICAgICAgbmFtZTogZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtbmFtZVwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wicHJvamVjdE5hbWVcIiwgXCJuYW1lXCJdKSxcbiAgICAgIHdvcmtzcGFjZVBhdGg6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wid29ya3NwYWNlUGF0aFwiLCBcInByb2plY3RQYXRoXCIsIFwiY3dkXCJdKSxcbiAgICB9O1xuICAgIGlmIChjb250ZXh0LmlkIHx8IGNvbnRleHQubmFtZSB8fCBjb250ZXh0LndvcmtzcGFjZVBhdGgpIHJldHVybiBjb250ZXh0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhdHRhY2hGaWxlcyhmaWxlczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmc7IGRhdGFCYXNlNjQ6IHN0cmluZyB9Pik6IFByb21pc2U8eyBhY2NlcHRlZDogYm9vbGVhbjsgcmVhc29uOiBcImFjY2VwdGVkXCIgfCBcImNvbXBvc2VyLW1pc3NpbmdcIiB8IFwicGFzdGUtcmVqZWN0ZWRcIiB8IFwiYXR0YWNobWVudC10aW1lb3V0XCIgfT4ge1xuICBjb25zdCB0YXJnZXQgPSBxdWVyeUhvc3RTdXJmYWNlcyhcImNvbXBvc2VyXCIpWzBdPy5lbGVtZW50ID8/IG51bGw7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4geyBhY2NlcHRlZDogZmFsc2UsIHJlYXNvbjogXCJjb21wb3Nlci1taXNzaW5nXCIgfTtcbiAgY29uc3QgcHJlcGFyZWQgPSBmaWxlcy5tYXAoKGZpbGUpID0+IHtcbiAgICBjb25zdCBieXRlcyA9IFVpbnQ4QXJyYXkuZnJvbShhdG9iKGZpbGUuZGF0YUJhc2U2NCksIChjaGFyKSA9PiBjaGFyLmNoYXJDb2RlQXQoMCkpO1xuICAgIHJldHVybiBuZXcgRmlsZShbYnl0ZXNdLCBzYWZlRmlsZU5hbWUoZmlsZS5uYW1lKSwgeyB0eXBlOiBmaWxlLm1pbWVUeXBlIHx8IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIgfSk7XG4gIH0pO1xuICBjb25zdCB0cmFuc2ZlciA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHByZXBhcmVkKSB0cmFuc2Zlci5pdGVtcy5hZGQoZmlsZSk7XG4gIHRhcmdldC5kaXNwYXRjaEV2ZW50KG5ldyBEcmFnRXZlbnQoXCJkcm9wXCIsIHsgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZSwgZGF0YVRyYW5zZmVyOiB0cmFuc2ZlciB9KSk7XG4gIGNvbnN0IHBhc3RlID0gbmV3IENsaXBib2FyZEV2ZW50KFwicGFzdGVcIiwgeyBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlLCBjbGlwYm9hcmREYXRhOiB0cmFuc2ZlciB9KTtcbiAgY29uc3QgYWNjZXB0ZWQgPSB0YXJnZXQuZGlzcGF0Y2hFdmVudChwYXN0ZSk7XG4gIHRhcmdldC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gICh0YXJnZXQgYXMgSFRNTEVsZW1lbnQpLmZvY3VzPy4oKTtcbiAgcmV0dXJuIHsgYWNjZXB0ZWQ6IGFjY2VwdGVkICE9PSBmYWxzZSwgcmVhc29uOiBhY2NlcHRlZCA9PT0gZmFsc2UgPyBcInBhc3RlLXJlamVjdGVkXCIgOiBcImFjY2VwdGVkXCIgfTtcbn1cblxuZnVuY3Rpb24gc2FmZUZpbGVOYW1lKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHZhbHVlIHx8IFwiQXBwU2hvdFwiKS5yZXBsYWNlKC9bLzpcXFxcXFwwXFxyXFxuXS9nLCBcIi1cIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gY2xlYW5lZC5zbGljZSgwLCAxNjApIHx8IFwiQXBwU2hvdFwiO1xufVxuXG5mdW5jdGlvbiBzZW1hbnRpY0ZpbHRlcihraW5kOiBIb3N0U3VyZmFjZUtpbmQsIGVsZW1lbnQ6IEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCk7XG4gIGlmIChraW5kID09PSBcImFzc2lzdGFudC10dXJuc1wiKSB7XG4gICAgY29uc3Qgcm9sZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1tZXNzYWdlLWF1dGhvci1yb2xlXCIpIHx8IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1yb2xlXCIpO1xuICAgIHJldHVybiByb2xlID8gcm9sZS50b0xvd2VyQ2FzZSgpID09PSBcImFzc2lzdGFudFwiIDogL2Fzc2lzdGFudC1tZXNzYWdlL2kudGVzdChlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtdGVzdGlkXCIpIHx8IFwiXCIpO1xuICB9XG4gIGlmIChraW5kID09PSBcImFjY291bnQtbWVudVwiKSByZXR1cm4gL2FjY291bnR8c2V0dGluZ3N8bG9nXFxzKm91dC9pLnRlc3QodGV4dCk7XG4gIGlmIChraW5kID09PSBcInNldHRpbmdzLXJvd3NcIikgcmV0dXJuIHRleHQubGVuZ3RoID4gMDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZGVuY2VGb3Ioa2luZDogSG9zdFN1cmZhY2VLaW5kLCBlbGVtZW50OiBFbGVtZW50KTogSG9zdFN1cmZhY2VNYXRjaFtcImNvbmZpZGVuY2VcIl0ge1xuICBpZiAoZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXRlc3RpZFwiKSB8fCBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgfHwgZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJyb2xlXCIpKSByZXR1cm4gXCJoaWdoXCI7XG4gIHJldHVybiBraW5kID09PSBcImNvbXBvc2VyXCIgfHwga2luZCA9PT0gXCJ0aXRsZWJhci1jb250cm9sc1wiID8gXCJtZWRpdW1cIiA6IFwibG93XCI7XG59XG5cbmZ1bmN0aW9uIGZpYmVyUHJvcHMoZWxlbWVudDogRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGxldCBmaWJlciA9IGZpYmVyRm9yTm9kZShlbGVtZW50KSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gIGNvbnN0IG1lcmdlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgZm9yIChsZXQgZGVwdGggPSAwOyBmaWJlciAmJiBkZXB0aCA8IDIwOyBkZXB0aCArPSAxLCBmaWJlciA9IGZpYmVyLnJldHVybikge1xuICAgIGlmIChmaWJlci5tZW1vaXplZFByb3BzICYmIHR5cGVvZiBmaWJlci5tZW1vaXplZFByb3BzID09PSBcIm9iamVjdFwiKSBPYmplY3QuYXNzaWduKG1lcmdlZCwgZmliZXIubWVtb2l6ZWRQcm9wcyk7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKG1lcmdlZCkubGVuZ3RoID8gbWVyZ2VkIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZmlyc3RTdHJpbmcocHJvcHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCwga2V5czogc3RyaW5nW10pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXByb3BzKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBxdWV1ZTogdW5rbm93bltdID0gW3Byb3BzXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8dW5rbm93bj4oKTtcbiAgZm9yIChsZXQgdmlzaXRlZCA9IDA7IHF1ZXVlLmxlbmd0aCAmJiB2aXNpdGVkIDwgODA7IHZpc2l0ZWQgKz0gMSkge1xuICAgIGNvbnN0IHZhbHVlID0gcXVldWUuc2hpZnQoKTtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIiB8fCBzZWVuLmhhcyh2YWx1ZSkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGl0ZW1dIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgaWYgKGtleXMuaW5jbHVkZXMoa2V5KSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIiAmJiBpdGVtLnRyaW0oKSkgcmV0dXJuIGl0ZW07XG4gICAgICBpZiAoaXRlbSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJvYmplY3RcIikgcXVldWUucHVzaChpdGVtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdW5pcXVlRWxlbWVudHMoaW5wdXQ6IEl0ZXJhYmxlPEVsZW1lbnQ+IHwgQXJyYXlMaWtlPEVsZW1lbnQ+KTogRWxlbWVudFtdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KEFycmF5LmZyb20oaW5wdXQpKV07XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc2libGVMYWJlbChlbGVtZW50OiBFbGVtZW50KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fCBlbGVtZW50LmdldEF0dHJpYnV0ZShcInRpdGxlXCIpIHx8IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCkgfHwgdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0KHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG59XG4iLCAiZXhwb3J0IHR5cGUgVHdlYWtTY29wZSA9IFwicmVuZGVyZXJcIiB8IFwibWFpblwiIHwgXCJib3RoXCI7XG5cbi8qKlxuICogTGlmZWN5Y2xlIHN0YXRlcyBhcmUgZGVsaWJlcmF0ZWx5IG1vcmUgZGV0YWlsZWQgdGhhbiB0aGUgdXNlci1mYWNpbmdcbiAqIGluc3RhbGxlZC9lbmFibGVkIHN0YXR1cy4gIEEgdHdlYWsgbWF5IGJlIHZpc2libGUgYXMgZW5hYmxlZCB3aGlsZSBpdHNcbiAqIGFzeW5jaHJvbm91cyBzdGFydCBpcyBzdGlsbCBpbiBmbGlnaHQsIG9yIGFzIGZhaWxlZCBhZnRlciBhbm90aGVyIHR3ZWFrXG4gKiBoYXMgYWxyZWFkeSByZWFjaGVkIHJlYWR5LlxuICovXG5leHBvcnQgY29uc3QgVFdFQUtfTElGRUNZQ0xFX1NUQVRVU0VTID0gW1xuICBcInN0YXJ0aW5nXCIsXG4gIFwicmVhZHlcIixcbiAgXCJmYWlsZWRcIixcbiAgXCJ0aW1lZF9vdXRcIixcbiAgXCJkaXNhYmxlZFwiLFxuICBcInF1YXJhbnRpbmVkXCIsXG5dIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgVHdlYWtMaWZlY3ljbGVTdGF0dXMgPSAodHlwZW9mIFRXRUFLX0xJRkVDWUNMRV9TVEFUVVNFUylbbnVtYmVyXTtcbmV4cG9ydCB0eXBlIFR3ZWFrUHJvY2VzcyA9IFwibWFpblwiIHwgXCJyZW5kZXJlclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlUmVjb3JkIHtcbiAgaWQ6IHN0cmluZztcbiAgcHJvY2VzczogVHdlYWtQcm9jZXNzO1xuICBzdGF0dXM6IFR3ZWFrTGlmZWN5Y2xlU3RhdHVzO1xuICBhdHRlbXB0SWQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdD86IHN0cmluZztcbiAgZmluaXNoZWRBdD86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8qKiBDb25zZWN1dGl2ZSBzdGFydHVwIGF0dGVtcHRzIGN1dCBzaG9ydCBieSBhIHByb2Nlc3MgZXhpdDsgcmVzZXQgYnkgYSBzdWNjZXNzZnVsIHJlYWR5LiAqL1xuICBpbnRlcnJ1cHRlZEF0dGVtcHRzPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlQXR0ZW1wdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHBpZD86IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIGNvbXBsZXRlZEF0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGN1cnJlbnRBdHRlbXB0OiBUd2Vha0xpZmVjeWNsZUF0dGVtcHQgfCBudWxsO1xuICByZWNvcmRzOiBSZWNvcmQ8c3RyaW5nLCBUd2Vha0xpZmVjeWNsZVJlY29yZD47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVUd2Vha0xpZmVjeWNsZUpvdXJuYWwoXG4gIGF0dGVtcHRJZCA9IGBhdHRlbXB0LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gLFxuICBwaWQ/OiBudW1iZXIsXG4gIHN0YXJ0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbik6IFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCB7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICBjdXJyZW50QXR0ZW1wdDogeyBpZDogYXR0ZW1wdElkLCBwaWQsIHN0YXJ0ZWRBdCB9LFxuICAgIHJlY29yZHM6IHt9LFxuICB9O1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSA1XzAwMDtcbmV4cG9ydCBjb25zdCBNSU5fVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TID0gMTAwO1xuZXhwb3J0IGNvbnN0IE1BWF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSAzMF8wMDA7XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVUd2Vha1N0YXJ0dXBUaW1lb3V0TXModmFsdWU6IHVua25vd24pOiBudW1iZXIge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSB7XG4gICAgcmV0dXJuIERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TO1xuICB9XG4gIHJldHVybiBNYXRoLm1pbihcbiAgICBNQVhfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuICAgIE1hdGgubWF4KE1JTl9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsIE1hdGgucm91bmQodmFsdWUpKSxcbiAgKTtcbn1cblxuLyoqXG4gKiBSYWNlIGEgdHdlYWsncyBzdGFydHVwIHByb21pc2UgYWdhaW5zdCBhIGJvdW5kZWQgdGltZW91dC4gIFRoZSBvcmlnaW5hbFxuICogcHJvbWlzZSBpcyBvYnNlcnZlZCBhZnRlciB0aGUgdGltZW91dCBzbyBhIGxhdGUgcmVqZWN0aW9uIGNhbm5vdCBiZWNvbWUgYW5cbiAqIHVuaGFuZGxlZCByZWplY3Rpb24sIHdoaWxlIHRoZSBjYWxsZXIgaXMgZnJlZSB0byBjb250aW51ZSBsb2FkaW5nIHNpYmxpbmdcbiAqIHR3ZWFrcyBpbW1lZGlhdGVseS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhTdGFydHVwVGltZW91dDxUPihcbiAgdmFsdWU6IFByb21pc2VMaWtlPFQ+IHwgVCxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyxcbik6IFByb21pc2U8eyBzdGF0dXM6IFwicmVhZHlcIjsgdmFsdWU6IFQgfSB8IHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0+IHtcbiAgY29uc3Qgbm9ybWFsaXplZFRpbWVvdXRNcyA9IG5vcm1hbGl6ZVR3ZWFrU3RhcnR1cFRpbWVvdXRNcyh0aW1lb3V0TXMpO1xuICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKHZhbHVlKTtcbiAgY29uc3QgdGltZW91dCA9IG5ldyBQcm9taXNlPHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0+KChyZXNvbHZlKSA9PiB7XG4gICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfSksIG5vcm1hbGl6ZWRUaW1lb3V0TXMpO1xuICB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgcHJvbWlzZS50aGVuKChyZXNvbHZlZCkgPT4gKHsgc3RhdHVzOiBcInJlYWR5XCIgYXMgY29uc3QsIHZhbHVlOiByZXNvbHZlZCB9KSksXG4gICAgICB0aW1lb3V0LFxuICAgIF0pO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIC8vIEF0dGFjaCBhIHJlamVjdGlvbiBvYnNlcnZlciBldmVuIHdoZW4gdGltZW91dCB3b24uICBUaGlzIGludGVudGlvbmFsbHlcbiAgICAvLyBkb2VzIG5vdCBhd2FpdCB0aGUgbGF0ZSByZXN1bHQuXG4gICAgdm9pZCBwcm9taXNlLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbn1cblxuLyoqIENvbnZlbmllbmNlIGZvcm0gZm9yIGNhbGxlcnMgdGhhdCBoYXZlIGEgbGF6eSBzdGFydCBvcGVyYXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gcnVuV2l0aFN0YXJ0dXBUaW1lb3V0PFQ+KFxuICBzdGFydDogKCkgPT4gUHJvbWlzZUxpa2U8VD4gfCBULFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx7IHN0YXR1czogXCJyZWFkeVwiOyB2YWx1ZTogVCB9IHwgeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4ge1xuICBsZXQgdmFsdWU6IFByb21pc2VMaWtlPFQ+IHwgVDtcbiAgdHJ5IHtcbiAgICB2YWx1ZSA9IHN0YXJ0KCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycm9yKTtcbiAgfVxuICByZXR1cm4gd2l0aFN0YXJ0dXBUaW1lb3V0KHZhbHVlLCB0aW1lb3V0TXMpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGlmZWN5Y2xlUmVjb3JkS2V5KHByb2Nlc3M6IFR3ZWFrUHJvY2VzcywgaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcm9jZXNzfToke2lkfWA7XG59XG5cbi8qKlxuICogQmluZCBhIG1haW4tcHJvY2VzcyB0d2VhaydzIGBzdG9wKClgIHRvIHRoZSB0d2VhayBvYmplY3Qgc28gY2xlYW51cCB0aGF0XG4gKiByZWxpZXMgb24gYHRoaXNgIChwZXItaW5zdGFuY2UgZGlzcG9zZXJzLCBJUEMgaGFuZGxlIHJlbW92ZXJzKSB3b3Jrcy4gVGhlXG4gKiByZW5kZXJlciBob3N0IGJpbmRzIHN0b3AgdGhlIHNhbWUgd2F5IChwcmVsb2FkL3R3ZWFrLWhvc3QudHMpOyB0aGUgbWFpblxuICogcnVudGltZSBoaXN0b3JpY2FsbHkgc3RvcmVkIGl0IHVuYm91bmQsIHNpbGVudGx5IGJyZWFraW5nIGB0aGlzYC1iYXNlZCBtYWluXG4gKiBjbGVhbnVwIGZvciBgc2NvcGU6IFwiYm90aFwiYCB0d2Vha3MgKGZvbGxvd3VwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJpbmRNYWluVHdlYWtTdG9wPFQgZXh0ZW5kcyB7IHN0b3A/OiAoLi4uYXJnczogdW5rbm93bltdKSA9PiB1bmtub3duIH0+KFxuICB0d2VhazogVCB8IG51bGwgfCB1bmRlZmluZWQsXG4pOiBUW1wic3RvcFwiXSB8IHVuZGVmaW5lZCB7XG4gIGlmICghdHdlYWsgfHwgdHlwZW9mIHR3ZWFrLnN0b3AgIT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHR3ZWFrPy5zdG9wO1xuICByZXR1cm4gdHdlYWsuc3RvcC5iaW5kKHR3ZWFrKSBhcyBUW1wic3RvcFwiXTtcbn1cblxuLyoqXG4gKiBBIHdob2xlLWFwcCByZXN0YXJ0IHJhY2luZyB0aGUgc2VxdWVudGlhbCB0d2Vhay1sb2FkIGxvb3AgbGVhdmVzIGlubm9jZW50XG4gKiB0d2Vha3MgaW4gXCJzdGFydGluZ1wiOyBvbmx5IHJlcGVhdGVkIGludGVycnVwdGlvbnMgaW5kaWNhdGUgdGhlIHR3ZWFrIGl0c2VsZlxuICogaXMgaGFuZ2luZyBzdGFydHVwLiBPbmUgaW50ZXJydXB0aW9uIGlzIHRoZXJlZm9yZSByZXRyaWVkLCBub3QgcXVhcmFudGluZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORSA9IDI7XG5cbi8qKlxuICogVHVybiBhIGpvdXJuYWwgZnJvbSBhIHByZXZpb3VzIHByb2Nlc3MgaW50byBleHBsaWNpdCByZWNvcmRzLiBPbmx5IHJlY29yZHNcbiAqIGZyb20gdGhlIHVuZmluaXNoZWQgY3VycmVudCBhdHRlbXB0IGFyZSBjaGFuZ2VkOyBoaXN0b3JpY2FsIHJlYWR5L2ZhaWxlZFxuICogcmVjb3JkcyByZW1haW4gYXZhaWxhYmxlIGZvciBkaWFnbm9zdGljcy4gQSBmaXJzdCBpbnRlcnJ1cHRpb24gYmVjb21lcyBhXG4gKiByZXRyeWFibGUgXCJmYWlsZWRcIjsgSU5URVJSVVBURURfQVRURU1QVFNfQkVGT1JFX1FVQVJBTlRJTkUgY29uc2VjdXRpdmVcbiAqIGludGVycnVwdGlvbnMgcXVhcmFudGluZSB0aGUgdHdlYWsuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvdmVySW50ZXJydXB0ZWRUd2Vha3MoXG4gIGpvdXJuYWw6IFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCxcbiAgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuKTogVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgY29uc3QgY3VycmVudEF0dGVtcHQgPSBqb3VybmFsLmN1cnJlbnRBdHRlbXB0O1xuICBpZiAoIWN1cnJlbnRBdHRlbXB0IHx8IGN1cnJlbnRBdHRlbXB0LmNvbXBsZXRlZEF0KSByZXR1cm4gam91cm5hbDtcbiAgY29uc3QgcmVjb3JkcyA9IHsgLi4uam91cm5hbC5yZWNvcmRzIH07XG4gIGZvciAoY29uc3QgW2tleSwgcmVjb3JkXSBvZiBPYmplY3QuZW50cmllcyhyZWNvcmRzKSkge1xuICAgIGlmIChyZWNvcmQuYXR0ZW1wdElkICE9PSBjdXJyZW50QXR0ZW1wdC5pZCkgY29udGludWU7XG4gICAgaWYgKHJlY29yZC5zdGF0dXMgIT09IFwic3RhcnRpbmdcIikgY29udGludWU7XG4gICAgY29uc3QgaW50ZXJydXB0ZWRBdHRlbXB0cyA9IChyZWNvcmQuaW50ZXJydXB0ZWRBdHRlbXB0cyA/PyAwKSArIDE7XG4gICAgY29uc3QgcXVhcmFudGluZSA9IGludGVycnVwdGVkQXR0ZW1wdHMgPj0gSU5URVJSVVBURURfQVRURU1QVFNfQkVGT1JFX1FVQVJBTlRJTkU7XG4gICAgcmVjb3Jkc1trZXldID0ge1xuICAgICAgLi4ucmVjb3JkLFxuICAgICAgc3RhdHVzOiBxdWFyYW50aW5lID8gXCJxdWFyYW50aW5lZFwiIDogXCJmYWlsZWRcIixcbiAgICAgIGludGVycnVwdGVkQXR0ZW1wdHMsXG4gICAgICB1cGRhdGVkQXQ6IG5vdyxcbiAgICAgIGZpbmlzaGVkQXQ6IG5vdyxcbiAgICAgIGVycm9yOiByZWNvcmQuZXJyb3IgPz8gKHF1YXJhbnRpbmVcbiAgICAgICAgPyBgc3RhcnR1cCB3YXMgaW50ZXJydXB0ZWQgJHtpbnRlcnJ1cHRlZEF0dGVtcHRzfSB0aW1lcyBpbiBhIHJvd2BcbiAgICAgICAgOiBcInByZXZpb3VzIHN0YXJ0dXAgYXR0ZW1wdCB3YXMgaW50ZXJydXB0ZWQ7IHdpbGwgcmV0cnlcIiksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyAuLi5qb3VybmFsLCBjdXJyZW50QXR0ZW1wdDogeyAuLi5jdXJyZW50QXR0ZW1wdCwgY29tcGxldGVkQXQ6IG5vdyB9LCByZWNvcmRzIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVsb2FkVHdlYWtzRGVwcyB7XG4gIGxvZ0luZm8obWVzc2FnZTogc3RyaW5nKTogdm9pZDtcbiAgc3RvcEFsbE1haW5Ud2Vha3MoKTogdm9pZDtcbiAgY2xlYXJUd2Vha01vZHVsZUNhY2hlKCk6IHZvaWQ7XG4gIGxvYWRBbGxNYWluVHdlYWtzKCk6IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICBicm9hZGNhc3RSZWxvYWQoKTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXRUd2Vha0VuYWJsZWRBbmRSZWxvYWREZXBzIGV4dGVuZHMgUmVsb2FkVHdlYWtzRGVwcyB7XG4gIHNldFR3ZWFrRW5hYmxlZChpZDogc3RyaW5nLCBlbmFibGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzTWFpblByb2Nlc3NUd2Vha1Njb3BlKHNjb3BlOiBUd2Vha1Njb3BlIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBzY29wZSAhPT0gXCJyZW5kZXJlclwiO1xufVxuXG5sZXQgcmVsb2FkU2VxdWVuY2U6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRUd2Vha3NJbml0aWFsbHkoXG4gIGRlcHM6IFBpY2s8UmVsb2FkVHdlYWtzRGVwcywgXCJsb2FkQWxsTWFpblR3ZWFrc1wiPixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBydW4gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgYXdhaXQgZGVwcy5sb2FkQWxsTWFpblR3ZWFrcygpO1xuICB9O1xuICBjb25zdCBvcGVyYXRpb24gPSByZWxvYWRTZXF1ZW5jZS50aGVuKHJ1biwgcnVuKTtcbiAgcmVsb2FkU2VxdWVuY2UgPSBvcGVyYXRpb24uY2F0Y2goKCkgPT4ge30pO1xuICByZXR1cm4gb3BlcmF0aW9uO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVsb2FkVHdlYWtzKHJlYXNvbjogc3RyaW5nLCBkZXBzOiBSZWxvYWRUd2Vha3NEZXBzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1biA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBkZXBzLmxvZ0luZm8oYHJlbG9hZGluZyB0d2Vha3MgKCR7cmVhc29ufSlgKTtcbiAgICBkZXBzLnN0b3BBbGxNYWluVHdlYWtzKCk7XG4gICAgZGVwcy5jbGVhclR3ZWFrTW9kdWxlQ2FjaGUoKTtcbiAgICBhd2FpdCBkZXBzLmxvYWRBbGxNYWluVHdlYWtzKCk7XG4gICAgZGVwcy5icm9hZGNhc3RSZWxvYWQoKTtcbiAgfTtcbiAgY29uc3Qgb3BlcmF0aW9uID0gcmVsb2FkU2VxdWVuY2UudGhlbihydW4sIHJ1bik7XG4gIHJlbG9hZFNlcXVlbmNlID0gb3BlcmF0aW9uLmNhdGNoKCgpID0+IHt9KTtcbiAgcmV0dXJuIG9wZXJhdGlvbjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFR3ZWFrRW5hYmxlZEFuZFJlbG9hZChcbiAgaWQ6IHN0cmluZyxcbiAgZW5hYmxlZDogdW5rbm93bixcbiAgZGVwczogU2V0VHdlYWtFbmFibGVkQW5kUmVsb2FkRGVwcyxcbik6IFByb21pc2U8dHJ1ZT4ge1xuICBjb25zdCBub3JtYWxpemVkRW5hYmxlZCA9ICEhZW5hYmxlZDtcbiAgZGVwcy5zZXRUd2Vha0VuYWJsZWQoaWQsIG5vcm1hbGl6ZWRFbmFibGVkKTtcbiAgZGVwcy5sb2dJbmZvKGB0d2VhayAke2lkfSBlbmFibGVkPSR7bm9ybWFsaXplZEVuYWJsZWR9YCk7XG4gIGF3YWl0IHJlbG9hZFR3ZWFrcyhcImVuYWJsZWQtdG9nZ2xlXCIsIGRlcHMpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VMaWtlIHtcbiAgcmVhZG9ubHkgbGVuZ3RoOiBudW1iZXI7XG4gIGdldEl0ZW0oa2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xuICBrZXkoaW5kZXg6IG51bWJlcik6IHN0cmluZyB8IG51bGw7XG4gIHNldEl0ZW0oa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICByZW1vdmVJdGVtKGtleTogc3RyaW5nKTogdm9pZDtcbn1cblxuY29uc3QgQ1VSUkVOVF9JRF9QUkVGSVggPSBcImNvLnR3ZWFrZXJzLlwiO1xuY29uc3QgTEVHQUNZX1NUT1JBR0VfUFJFRklYID0gYCR7W1wiY29kZXhcIiwgXCJwcFwiXS5qb2luKFwiXCIpfTpzdG9yYWdlOmA7XG5jb25zdCBDVVJSRU5UX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2U6XCI7XG5cbmZ1bmN0aW9uIHBhcnNlUmVjb3JkKHJhdzogc3RyaW5nIHwgbnVsbCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIHJldHVybiBwYXJzZWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpXG4gICAgICA/IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBkaXNjb3ZlckxlZ2FjeVB1Ymxpc2hlcktleShpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlkLnN0YXJ0c1dpdGgoQ1VSUkVOVF9JRF9QUkVGSVgpKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3VmZml4ID0gaWQuc2xpY2UoQ1VSUkVOVF9JRF9QUkVGSVgubGVuZ3RoKTtcbiAgaWYgKCFzdWZmaXgpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHN1ZmZpeE1hcmtlciA9IGAuJHtzdWZmaXh9YDtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBrZXkgPSBzdG9yYWdlLmtleShpbmRleCk7XG4gICAgaWYgKCFrZXk/LnN0YXJ0c1dpdGgoTEVHQUNZX1NUT1JBR0VfUFJFRklYKSkgY29udGludWU7XG4gICAgY29uc3QgbGVnYWN5SWQgPSBrZXkuc2xpY2UoTEVHQUNZX1NUT1JBR0VfUFJFRklYLmxlbmd0aCk7XG4gICAgaWYgKFxuICAgICAgbGVnYWN5SWQgIT09IGlkXG4gICAgICAmJiBsZWdhY3lJZC5zdGFydHNXaXRoKFwiY28uXCIpXG4gICAgICAmJiBsZWdhY3lJZC5lbmRzV2l0aChzdWZmaXhNYXJrZXIpXG4gICAgICAmJiBsZWdhY3lJZC5zbGljZSgzLCAtc3VmZml4TWFya2VyLmxlbmd0aCkubGVuZ3RoID4gMFxuICAgICkge1xuICAgICAgY2FuZGlkYXRlcy5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXMuc2l6ZSA9PT0gMSA/IFsuLi5jYW5kaWRhdGVzXVswXSA6IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVSZW5kZXJlclN0b3JhZ2UoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpIHtcbiAgY29uc3Qga2V5ID0gYCR7Q1VSUkVOVF9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IGxlZ2FjeUN1cnJlbnRJZEtleSA9IGAke0xFR0FDWV9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0oa2V5KSk7XG4gICAgY29uc3QgbGVnYWN5Q3VycmVudElkID0gcGFyc2VSZWNvcmQoc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUN1cnJlbnRJZEtleSkpO1xuICAgIGNvbnN0IGxlZ2FjeVB1Ymxpc2hlcktleSA9IGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5KGlkLCBzdG9yYWdlKTtcbiAgICBjb25zdCBsZWdhY3lQdWJsaXNoZXIgPSBsZWdhY3lQdWJsaXNoZXJLZXkgPT09IG51bGxcbiAgICAgID8gbnVsbFxuICAgICAgOiBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0obGVnYWN5UHVibGlzaGVyS2V5KSk7XG5cbiAgICBjb25zdCBsZWdhY3lLZXlzID0gW1xuICAgICAgbGVnYWN5Q3VycmVudElkID09PSBudWxsID8gbnVsbCA6IGxlZ2FjeUN1cnJlbnRJZEtleSxcbiAgICAgIGxlZ2FjeVB1Ymxpc2hlciA9PT0gbnVsbCA/IG51bGwgOiBsZWdhY3lQdWJsaXNoZXJLZXksXG4gICAgXS5maWx0ZXIoKGNhbmRpZGF0ZSk6IGNhbmRpZGF0ZSBpcyBzdHJpbmcgPT4gY2FuZGlkYXRlICE9PSBudWxsKTtcblxuICAgIGlmIChsZWdhY3lLZXlzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGN1cnJlbnQgPz8ge307XG5cbiAgICBjb25zdCBtZXJnZWQgPSB7XG4gICAgICAuLi4obGVnYWN5UHVibGlzaGVyID8/IHt9KSxcbiAgICAgIC4uLihsZWdhY3lDdXJyZW50SWQgPz8ge30pLFxuICAgICAgLi4uKGN1cnJlbnQgPz8ge30pLFxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIHN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG1lcmdlZDtcbiAgICB9XG4gICAgZm9yIChjb25zdCBsZWdhY3lLZXkgb2YgbGVnYWN5S2V5cykgc3RvcmFnZS5yZW1vdmVJdGVtKGxlZ2FjeUtleSk7XG4gICAgcmV0dXJuIG1lcmdlZDtcbiAgfTtcbiAgY29uc3Qgd3JpdGUgPSAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBzdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICByZXR1cm4ge1xuICAgIGdldDogPFQ+KG5hbWU6IHN0cmluZywgZmFsbGJhY2s/OiBUKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgcmV0dXJuIG5hbWUgaW4gY3VycmVudCA/IChjdXJyZW50W25hbWVdIGFzIFQpIDogKGZhbGxiYWNrIGFzIFQpO1xuICAgIH0sXG4gICAgc2V0OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGN1cnJlbnRbbmFtZV0gPSB2YWx1ZTtcbiAgICAgIHdyaXRlKGN1cnJlbnQpO1xuICAgIH0sXG4gICAgZGVsZXRlOiAobmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgZGVsZXRlIGN1cnJlbnRbbmFtZV07XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGFsbDogKCkgPT4gcmVhZCgpLFxuICB9O1xufVxuIiwgIi8qKlxuICogQnVpbHQtaW4gXCJUd2VhayBNYW5hZ2VyXCIgXHUyMDE0IGF1dG8taW5qZWN0ZWQgYnkgdGhlIHJ1bnRpbWUsIG5vdCBhIHVzZXIgdHdlYWsuXG4gKiBMaXN0cyBkaXNjb3ZlcmVkIHR3ZWFrcyB3aXRoIGVuYWJsZSB0b2dnbGVzLCBvcGVucyB0aGUgdHdlYWtzIGRpciwgbGlua3NcbiAqIHRvIGxvZ3MgYW5kIGNvbmZpZy4gTGl2ZXMgaW4gdGhlIHJlbmRlcmVyLlxuICpcbiAqIFRoaXMgaXMgaW52b2tlZCBmcm9tIHByZWxvYWQvaW5kZXgudHMgQUZURVIgdXNlciB0d2Vha3MgYXJlIGxvYWRlZCBzbyBpdFxuICogY2FuIHNob3cgdXAtdG8tZGF0ZSBzdGF0dXMuXG4gKi9cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNlY3Rpb24gfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbW91bnRNYW5hZ2VyKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpsaXN0LXR3ZWFrc1wiKSkgYXMgQXJyYXk8e1xuICAgIG1hbmlmZXN0OiB7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZyB9O1xuICAgIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICB9PjtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp1c2VyLXBhdGhzXCIpKSBhcyB7XG4gICAgdXNlclJvb3Q6IHN0cmluZztcbiAgICB0d2Vha3NEaXI6IHN0cmluZztcbiAgICBsb2dEaXI6IHN0cmluZztcbiAgfTtcblxuICByZWdpc3RlclNlY3Rpb24oe1xuICAgIGlkOiBcInR3ZWFrZXI6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7XG4gIGRlc2t0b3BVcGRhdGVJbmRpY2F0b3JJZGVudGl0eSxcbiAgc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3IsXG4gIHR5cGUgRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlLFxufSBmcm9tIFwiLi9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGVcIjtcblxuY29uc3QgVVBEQVRFX0NIQU5HRURfQ0hBTk5FTCA9IFwidHdlYWtlcjpjb2RleC1kZXNrdG9wLXVwZGF0ZS1jaGFuZ2VkXCI7XG5jb25zdCBJTkRJQ0FUT1JfQVRUUklCVVRFID0gXCJkYXRhLXR3ZWFrZXItZGVza3RvcC11cGRhdGUtaW5kaWNhdG9yXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kRGVza3RvcFVwZGF0ZUZvb3Rlck1vdW50KHJvb3Q6IFBhcmVudE5vZGUgPSBkb2N1bWVudCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IGFuY2hvcnMgPSBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJbYXJpYS1sYWJlbF1cIikpO1xuICBmb3IgKGNvbnN0IGFuY2hvciBvZiBhbmNob3JzKSB7XG4gICAgY29uc3QgbGFiZWwgPSBhbmNob3IuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKT8udHJpbSgpLnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgICBpZiAoIS8oc2V0dGluZ3N8YWNjb3VudHxwcm9maWxlfGhlbHApLy50ZXN0KGxhYmVsKSkgY29udGludWU7XG4gICAgbGV0IGNhbmRpZGF0ZTogSFRNTEVsZW1lbnQgfCBudWxsID0gYW5jaG9yO1xuICAgIGZvciAobGV0IGRlcHRoID0gMDsgY2FuZGlkYXRlICYmIGRlcHRoIDwgNjsgZGVwdGggKz0gMSkge1xuICAgICAgY29uc3Qgcm9sZSA9IGNhbmRpZGF0ZS5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpO1xuICAgICAgaWYgKGNhbmRpZGF0ZS5tYXRjaGVzKFwibmF2LCBhc2lkZSwgZm9vdGVyXCIpIHx8IHJvbGUgPT09IFwibmF2aWdhdGlvblwiIHx8IHJvbGUgPT09IFwiY29udGVudGluZm9cIikge1xuICAgICAgICByZXR1cm4gY2FuZGlkYXRlO1xuICAgICAgfVxuICAgICAgY2FuZGlkYXRlID0gY2FuZGlkYXRlLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnREZXNrdG9wVXBkYXRlSW5kaWNhdG9yKCk6ICgpID0+IHZvaWQge1xuICBsZXQgY3VycmVudDogRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGxldCBpbmRpY2F0b3I6IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YXJuaW5nVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHdhcm5lZElkZW50aXRpZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdCByZW1vdmVJbmRpY2F0b3IgPSAoKTogdm9pZCA9PiB7XG4gICAgaW5kaWNhdG9yPy5yZW1vdmUoKTtcbiAgICBpbmRpY2F0b3IgPSBudWxsO1xuICAgIGlmICh3YXJuaW5nVGltZXIpIGNsZWFyVGltZW91dCh3YXJuaW5nVGltZXIpO1xuICAgIHdhcm5pbmdUaW1lciA9IG51bGw7XG4gIH07XG5cbiAgY29uc3Qgc2NoZWR1bGVNaXNzaW5nTW91bnRXYXJuaW5nID0gKGlkZW50aXR5OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAod2FybmluZ1RpbWVyIHx8IHdhcm5lZElkZW50aXRpZXMuaGFzKGlkZW50aXR5KSkgcmV0dXJuO1xuICAgIHdhcm5pbmdUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgd2FybmluZ1RpbWVyID0gbnVsbDtcbiAgICAgIGlmICghY3VycmVudCB8fCAhc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3IoY3VycmVudCkpIHJldHVybjtcbiAgICAgIGlmIChkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHkoY3VycmVudCkgIT09IGlkZW50aXR5IHx8IGZpbmREZXNrdG9wVXBkYXRlRm9vdGVyTW91bnQoKSkgcmV0dXJuO1xuICAgICAgd2FybmVkSWRlbnRpdGllcy5hZGQoaWRlbnRpdHkpO1xuICAgICAgY29uc29sZS53YXJuKGBbdHdlYWtlcl0gQ2hhdEdQVCB1cGRhdGUgJHtpZGVudGl0eX0gaXMgYXZhaWxhYmxlLCBidXQgbm8gc2VtYW50aWMgc2lkZWJhciBmb290ZXIgbW91bnQgcG9pbnQgd2FzIGZvdW5kLmApO1xuICAgIH0sIDNfMDAwKTtcbiAgfTtcblxuICBjb25zdCByZW5kZXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFzaG91bGRTaG93RGVza3RvcFVwZGF0ZUluZGljYXRvcihjdXJyZW50KSkge1xuICAgICAgcmVtb3ZlSW5kaWNhdG9yKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGlkZW50aXR5ID0gZGVza3RvcFVwZGF0ZUluZGljYXRvcklkZW50aXR5KGN1cnJlbnQhKTtcbiAgICBjb25zdCBtb3VudCA9IGZpbmREZXNrdG9wVXBkYXRlRm9vdGVyTW91bnQoKTtcbiAgICBpZiAoIW1vdW50KSB7XG4gICAgICBpbmRpY2F0b3I/LnJlbW92ZSgpO1xuICAgICAgaW5kaWNhdG9yID0gbnVsbDtcbiAgICAgIHNjaGVkdWxlTWlzc2luZ01vdW50V2FybmluZyhpZGVudGl0eSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh3YXJuaW5nVGltZXIpIGNsZWFyVGltZW91dCh3YXJuaW5nVGltZXIpO1xuICAgIHdhcm5pbmdUaW1lciA9IG51bGw7XG4gICAgaWYgKCFpbmRpY2F0b3IpIHtcbiAgICAgIGluZGljYXRvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBpbmRpY2F0b3IudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBpbmRpY2F0b3Iuc2V0QXR0cmlidXRlKElORElDQVRPUl9BVFRSSUJVVEUsIFwidHJ1ZVwiKTtcbiAgICAgIGluZGljYXRvci5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2hhdEdQVCB1cGRhdGUgYXZhaWxhYmxlXCIpO1xuICAgICAgaW5kaWNhdG9yLnRleHRDb250ZW50ID0gXCJVcGRhdGVcIjtcbiAgICAgIE9iamVjdC5hc3NpZ24oaW5kaWNhdG9yLnN0eWxlLCB7XG4gICAgICAgIGFwcGVhcmFuY2U6IFwibm9uZVwiLFxuICAgICAgICBib3JkZXI6IFwiMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgMjQlLCB0cmFuc3BhcmVudClcIixcbiAgICAgICAgYm9yZGVyUmFkaXVzOiBcIjk5OTlweFwiLFxuICAgICAgICBiYWNrZ3JvdW5kOiBcImNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgMTAlLCB0cmFuc3BhcmVudClcIixcbiAgICAgICAgY29sb3I6IFwiaW5oZXJpdFwiLFxuICAgICAgICBjdXJzb3I6IFwicG9pbnRlclwiLFxuICAgICAgICBmb250OiBcImluaGVyaXRcIixcbiAgICAgICAgZm9udFNpemU6IFwiMTJweFwiLFxuICAgICAgICBmb250V2VpZ2h0OiBcIjYwMFwiLFxuICAgICAgICBtYXJnaW46IFwiNnB4IDEwcHhcIixcbiAgICAgICAgcGFkZGluZzogXCI1cHggMTBweFwiLFxuICAgICAgfSk7XG4gICAgICBpbmRpY2F0b3IuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgICAgaW5kaWNhdG9yIS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjaGVjay1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICAgIGlmIChpbmRpY2F0b3I/LmlzQ29ubmVjdGVkKSBpbmRpY2F0b3IuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpbmRpY2F0b3IudGl0bGUgPSBgQ2hhdEdQVCAke2N1cnJlbnQ/LmxhdGVzdD8ubWFya2V0aW5nVmVyc2lvbiA/PyBcInVwZGF0ZVwifSBpcyBhdmFpbGFibGVgO1xuICAgIGlmIChpbmRpY2F0b3IucGFyZW50RWxlbWVudCAhPT0gbW91bnQpIG1vdW50LmFwcGVuZENoaWxkKGluZGljYXRvcik7XG4gIH07XG5cbiAgY29uc3Qgb25DaGFuZ2VkID0gKF9ldmVudDogdW5rbm93biwgdmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBjdXJyZW50ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIDogbnVsbDtcbiAgICByZW5kZXIoKTtcbiAgfTtcbiAgaXBjUmVuZGVyZXIub24oVVBEQVRFX0NIQU5HRURfQ0hBTk5FTCwgb25DaGFuZ2VkKTtcblxuICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKHJlbmRlcik7XG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgIC50aGVuKCh2YWx1ZSkgPT4gb25DaGFuZ2VkKHVuZGVmaW5lZCwgdmFsdWUpKVxuICAgIC5jYXRjaCgoKSA9PiB7fSk7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihVUERBVEVfQ0hBTkdFRF9DSEFOTkVMLCBvbkNoYW5nZWQpO1xuICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICByZW1vdmVJbmRpY2F0b3IoKTtcbiAgfTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSB7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgbGF0ZXN0PzogeyBtYXJrZXRpbmdWZXJzaW9uPzogc3RyaW5nIHwgbnVsbDsgYnVpbGQ/OiBzdHJpbmcgfCBudWxsIH07XG4gIG5hdGl2ZVVwZGF0ZUNvbnRyb2xBY3RpdmU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3Ioc3RhdGU6IERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSB8IG51bGwpOiBib29sZWFuIHtcbiAgcmV0dXJuIHN0YXRlPy5zdGF0dXMgPT09IFwidXBkYXRlLWF2YWlsYWJsZVwiICYmIHN0YXRlLm5hdGl2ZVVwZGF0ZUNvbnRyb2xBY3RpdmUgIT09IHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHkoc3RhdGU6IERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSk6IHN0cmluZyB7XG4gIHJldHVybiBbc3RhdGUubGF0ZXN0Py5tYXJrZXRpbmdWZXJzaW9uID8/IFwidW5rbm93blwiLCBzdGF0ZS5sYXRlc3Q/LmJ1aWxkID8/IFwidW5rbm93blwiXS5qb2luKFwiOlwiKTtcbn1cbiIsICJ0eXBlIFRleHREaXJlY3Rpb24gPSBcImZvcndhcmRcIiB8IFwiYmFja3dhcmRcIiB8IFwibm9uZVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrUmVsb2FkRm9jdXNTbmFwc2hvdCB7XG4gIGRvY3VtZW50OiBEb2N1bWVudDtcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQ7XG4gIHNlbGVjdGlvbjpcbiAgICB8IHsga2luZDogXCJjb250cm9sXCI7IHN0YXJ0OiBudW1iZXI7IGVuZDogbnVtYmVyOyBkaXJlY3Rpb246IFRleHREaXJlY3Rpb24gfVxuICAgIHwgeyBraW5kOiBcImNvbnRlbnRlZGl0YWJsZVwiOyBhbmNob3I6IG51bWJlcjsgZm9jdXM6IG51bWJlciB9XG4gICAgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2FwdHVyZVR3ZWFrUmVsb2FkRm9jdXMoXG4gIGRvY3VtZW50OiBEb2N1bWVudCxcbik6IFR3ZWFrUmVsb2FkRm9jdXNTbmFwc2hvdCB8IG51bGwge1xuICBjb25zdCBlbGVtZW50ID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChcbiAgICAhZWxlbWVudFxuICAgIHx8IGVsZW1lbnQgPT09IGRvY3VtZW50LmJvZHlcbiAgICB8fCBlbGVtZW50ID09PSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnRcbiAgICB8fCB0eXBlb2YgZWxlbWVudC5mb2N1cyAhPT0gXCJmdW5jdGlvblwiXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBkb2N1bWVudCxcbiAgICBlbGVtZW50LFxuICAgIHNlbGVjdGlvbjogY2FwdHVyZVNlbGVjdGlvbihkb2N1bWVudCwgZWxlbWVudCksXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXN0b3JlVHdlYWtSZWxvYWRGb2N1cyhcbiAgc25hcHNob3Q6IFR3ZWFrUmVsb2FkRm9jdXNTbmFwc2hvdCB8IG51bGwsXG4pOiBib29sZWFuIHtcbiAgaWYgKCFzbmFwc2hvdD8uZWxlbWVudC5pc0Nvbm5lY3RlZCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB7IGRvY3VtZW50LCBlbGVtZW50IH0gPSBzbmFwc2hvdDtcbiAgY29uc3QgY3VycmVudCA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ7XG4gIGlmIChcbiAgICBjdXJyZW50XG4gICAgJiYgY3VycmVudCAhPT0gZWxlbWVudFxuICAgICYmIGN1cnJlbnQgIT09IGRvY3VtZW50LmJvZHlcbiAgICAmJiBjdXJyZW50ICE9PSBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnRcbiAgKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgZWxlbWVudC5mb2N1cyh7IHByZXZlbnRTY3JvbGw6IHRydWUgfSk7XG4gIHJlc3RvcmVTZWxlY3Rpb24oc25hcHNob3QpO1xuICByZXR1cm4gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCA9PT0gZWxlbWVudDtcbn1cblxuZnVuY3Rpb24gY2FwdHVyZVNlbGVjdGlvbihcbiAgZG9jdW1lbnQ6IERvY3VtZW50LFxuICBlbGVtZW50OiBIVE1MRWxlbWVudCxcbik6IFR3ZWFrUmVsb2FkRm9jdXNTbmFwc2hvdFtcInNlbGVjdGlvblwiXSB7XG4gIGlmIChpc1RleHRDb250cm9sKGVsZW1lbnQpKSB7XG4gICAgY29uc3Qgc3RhcnQgPSBlbGVtZW50LnNlbGVjdGlvblN0YXJ0O1xuICAgIGNvbnN0IGVuZCA9IGVsZW1lbnQuc2VsZWN0aW9uRW5kO1xuICAgIGlmIChzdGFydCA9PT0gbnVsbCB8fCBlbmQgPT09IG51bGwpIHJldHVybiBudWxsO1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcImNvbnRyb2xcIixcbiAgICAgIHN0YXJ0LFxuICAgICAgZW5kLFxuICAgICAgZGlyZWN0aW9uOiBlbGVtZW50LnNlbGVjdGlvbkRpcmVjdGlvbiA/PyBcIm5vbmVcIixcbiAgICB9O1xuICB9XG5cbiAgaWYgKCFlbGVtZW50LmlzQ29udGVudEVkaXRhYmxlKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc2VsZWN0aW9uID0gZG9jdW1lbnQuZ2V0U2VsZWN0aW9uPy4oKTtcbiAgaWYgKFxuICAgICFzZWxlY3Rpb25cbiAgICB8fCAhc2VsZWN0aW9uLmFuY2hvck5vZGVcbiAgICB8fCAhc2VsZWN0aW9uLmZvY3VzTm9kZVxuICAgIHx8ICFlbGVtZW50LmNvbnRhaW5zKHNlbGVjdGlvbi5hbmNob3JOb2RlKVxuICAgIHx8ICFlbGVtZW50LmNvbnRhaW5zKHNlbGVjdGlvbi5mb2N1c05vZGUpXG4gICkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiB7XG4gICAga2luZDogXCJjb250ZW50ZWRpdGFibGVcIixcbiAgICBhbmNob3I6IHRleHRPZmZzZXQoZG9jdW1lbnQsIGVsZW1lbnQsIHNlbGVjdGlvbi5hbmNob3JOb2RlLCBzZWxlY3Rpb24uYW5jaG9yT2Zmc2V0KSxcbiAgICBmb2N1czogdGV4dE9mZnNldChkb2N1bWVudCwgZWxlbWVudCwgc2VsZWN0aW9uLmZvY3VzTm9kZSwgc2VsZWN0aW9uLmZvY3VzT2Zmc2V0KSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVzdG9yZVNlbGVjdGlvbihzbmFwc2hvdDogVHdlYWtSZWxvYWRGb2N1c1NuYXBzaG90KTogdm9pZCB7XG4gIGNvbnN0IHsgZG9jdW1lbnQsIGVsZW1lbnQsIHNlbGVjdGlvbiB9ID0gc25hcHNob3Q7XG4gIGlmICghc2VsZWN0aW9uKSByZXR1cm47XG4gIGlmIChzZWxlY3Rpb24ua2luZCA9PT0gXCJjb250cm9sXCIgJiYgaXNUZXh0Q29udHJvbChlbGVtZW50KSkge1xuICAgIGVsZW1lbnQuc2V0U2VsZWN0aW9uUmFuZ2Uoc2VsZWN0aW9uLnN0YXJ0LCBzZWxlY3Rpb24uZW5kLCBzZWxlY3Rpb24uZGlyZWN0aW9uKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHNlbGVjdGlvbi5raW5kICE9PSBcImNvbnRlbnRlZGl0YWJsZVwiIHx8ICFlbGVtZW50LmlzQ29udGVudEVkaXRhYmxlKSByZXR1cm47XG5cbiAgY29uc3QgYW5jaG9yID0gdGV4dFBvc2l0aW9uKGRvY3VtZW50LCBlbGVtZW50LCBzZWxlY3Rpb24uYW5jaG9yKTtcbiAgY29uc3QgZm9jdXMgPSB0ZXh0UG9zaXRpb24oZG9jdW1lbnQsIGVsZW1lbnQsIHNlbGVjdGlvbi5mb2N1cyk7XG4gIGNvbnN0IGxpdmVTZWxlY3Rpb24gPSBkb2N1bWVudC5nZXRTZWxlY3Rpb24/LigpO1xuICBpZiAoIWFuY2hvciB8fCAhZm9jdXMgfHwgIWxpdmVTZWxlY3Rpb24pIHJldHVybjtcbiAgaWYgKHR5cGVvZiBsaXZlU2VsZWN0aW9uLnNldEJhc2VBbmRFeHRlbnQgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIGxpdmVTZWxlY3Rpb24uc2V0QmFzZUFuZEV4dGVudChcbiAgICAgIGFuY2hvci5ub2RlLFxuICAgICAgYW5jaG9yLm9mZnNldCxcbiAgICAgIGZvY3VzLm5vZGUsXG4gICAgICBmb2N1cy5vZmZzZXQsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcmFuZ2UgPSBkb2N1bWVudC5jcmVhdGVSYW5nZSgpO1xuICByYW5nZS5zZXRTdGFydChhbmNob3Iubm9kZSwgYW5jaG9yLm9mZnNldCk7XG4gIHJhbmdlLnNldEVuZChmb2N1cy5ub2RlLCBmb2N1cy5vZmZzZXQpO1xuICBsaXZlU2VsZWN0aW9uLnJlbW92ZUFsbFJhbmdlcygpO1xuICBsaXZlU2VsZWN0aW9uLmFkZFJhbmdlKHJhbmdlKTtcbn1cblxuZnVuY3Rpb24gaXNUZXh0Q29udHJvbChcbiAgZWxlbWVudDogSFRNTEVsZW1lbnQsXG4pOiBlbGVtZW50IGlzIEhUTUxJbnB1dEVsZW1lbnQgfCBIVE1MVGV4dEFyZWFFbGVtZW50IHtcbiAgcmV0dXJuIGVsZW1lbnQudGFnTmFtZSA9PT0gXCJJTlBVVFwiIHx8IGVsZW1lbnQudGFnTmFtZSA9PT0gXCJURVhUQVJFQVwiO1xufVxuXG5mdW5jdGlvbiB0ZXh0T2Zmc2V0KFxuICBkb2N1bWVudDogRG9jdW1lbnQsXG4gIHJvb3Q6IEhUTUxFbGVtZW50LFxuICBub2RlOiBOb2RlLFxuICBvZmZzZXQ6IG51bWJlcixcbik6IG51bWJlciB7XG4gIGNvbnN0IHJhbmdlID0gZG9jdW1lbnQuY3JlYXRlUmFuZ2UoKTtcbiAgcmFuZ2Uuc2VsZWN0Tm9kZUNvbnRlbnRzKHJvb3QpO1xuICByYW5nZS5zZXRFbmQobm9kZSwgb2Zmc2V0KTtcbiAgcmV0dXJuIHJhbmdlLnRvU3RyaW5nKCkubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiB0ZXh0UG9zaXRpb24oXG4gIGRvY3VtZW50OiBEb2N1bWVudCxcbiAgcm9vdDogSFRNTEVsZW1lbnQsXG4gIHRhcmdldDogbnVtYmVyLFxuKTogeyBub2RlOiBOb2RlOyBvZmZzZXQ6IG51bWJlciB9IHwgbnVsbCB7XG4gIGNvbnN0IHdhbGtlciA9IGRvY3VtZW50LmNyZWF0ZVRyZWVXYWxrZXIocm9vdCwgTm9kZUZpbHRlci5TSE9XX1RFWFQpO1xuICBsZXQgcmVtYWluaW5nID0gTWF0aC5tYXgoMCwgdGFyZ2V0KTtcbiAgbGV0IG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKTtcbiAgd2hpbGUgKG5vZGUpIHtcbiAgICBjb25zdCBsZW5ndGggPSBub2RlLnRleHRDb250ZW50Py5sZW5ndGggPz8gMDtcbiAgICBpZiAocmVtYWluaW5nIDw9IGxlbmd0aCkgcmV0dXJuIHsgbm9kZSwgb2Zmc2V0OiByZW1haW5pbmcgfTtcbiAgICByZW1haW5pbmcgLT0gbGVuZ3RoO1xuICAgIG5vZGUgPSB3YWxrZXIubmV4dE5vZGUoKTtcbiAgfVxuICByZXR1cm4gcm9vdC5sYXN0Q2hpbGRcbiAgICA/IHsgbm9kZTogcm9vdC5sYXN0Q2hpbGQsIG9mZnNldDogcm9vdC5sYXN0Q2hpbGQudGV4dENvbnRlbnQ/Lmxlbmd0aCA/PyAwIH1cbiAgICA6IHsgbm9kZTogcm9vdCwgb2Zmc2V0OiAwIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFXQSxJQUFBQSxtQkFBNEI7OztBQzZCckIsU0FBUyxtQkFBeUI7QUFDdkMsTUFBSSxPQUFPLCtCQUFnQztBQUMzQyxRQUFNLFlBQVksb0JBQUksSUFBK0I7QUFDckQsTUFBSSxTQUFTO0FBQ2IsUUFBTUMsYUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSUEsV0FBVSxJQUFJLEtBQUs7QUFDM0IsVUFBSSxDQUFDLEVBQUcsQ0FBQUEsV0FBVSxJQUFJLE9BQVEsSUFBSSxvQkFBSSxJQUFJLENBQUU7QUFDNUMsUUFBRSxJQUFJLEVBQUU7QUFBQSxJQUNWO0FBQUEsSUFDQSxJQUFJLE9BQU8sSUFBSTtBQUNiLE1BQUFBLFdBQVUsSUFBSSxLQUFLLEdBQUcsT0FBTyxFQUFFO0FBQUEsSUFDakM7QUFBQSxJQUNBLEtBQUssVUFBVSxNQUFNO0FBQ25CLE1BQUFBLFdBQVUsSUFBSSxLQUFLLEdBQUcsUUFBUSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQztBQUFBLElBQ25EO0FBQUEsSUFDQSxvQkFBb0I7QUFBQSxJQUFDO0FBQUEsSUFDckIsdUJBQXVCO0FBQUEsSUFBQztBQUFBLElBQ3hCLHNCQUFzQjtBQUFBLElBQUM7QUFBQSxJQUN2QixXQUFXO0FBQUEsSUFBQztBQUFBLEVB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WSxPQUFPLDZCQUE2QixPQUFPLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxLQUFLLENBQUMsQ0FBQztBQUFBLElBQ2xGLEtBQUs7QUFDSCxhQUFPLGlDQUFpQyxPQUFPLEtBQUssQ0FBQyxDQUFDLEdBQUcsZUFBZTtBQUFBLElBQzFFLEtBQUs7QUFDSCxhQUFPLG1DQUFtQyxPQUFPLEtBQUssQ0FBQyxDQUFDLEdBQUcsZUFBZTtBQUFBLElBQzVFLEtBQUs7QUFDSCxhQUFPLDZCQUFZLE9BQU8sMkJBQTJCLEtBQUssQ0FBQyxDQUFDO0FBQUEsSUFDOUQsS0FBSztBQUNILGFBQU8sNkJBQVksT0FBTywrQkFBK0I7QUFBQSxRQUN2RCxRQUFRLEtBQUssQ0FBQztBQUFBLFFBQ2QsR0FBRyxLQUFLLENBQUM7QUFBQSxRQUNULEdBQUcsS0FBSyxDQUFDO0FBQUEsTUFDWCxDQUFDO0FBQUEsSUFDSCxLQUFLO0FBQ0gsYUFBTyw2QkFBWSxPQUFPLHVDQUF1QyxLQUFLLENBQUMsQ0FBQztBQUFBLElBQzFFLEtBQUs7QUFDSCxhQUFPLDZCQUFZLE9BQU8sMkJBQTJCO0FBQUEsSUFDdkQ7QUFDRSxZQUFNLElBQUksTUFBTSw4Q0FBOEMsTUFBTSxFQUFFO0FBQUEsRUFDMUU7QUFDRjtBQUVBLFNBQVMsaUNBQ1AsVUFDQSxpQkFDUztBQUNULE1BQUksQ0FBQyxxQkFBcUIsS0FBSyxRQUFRLEVBQUcsT0FBTSxJQUFJLE1BQU0sbUJBQW1CO0FBQzdFLE1BQUksZ0JBQWdCLElBQUksUUFBUSxFQUFHLFFBQU87QUFDMUMsUUFBTSxXQUFXLENBQUMsUUFBaUIsWUFBcUI7QUFDdEQsaUNBQVksS0FBSywyQkFBMkIsVUFBVSxPQUFPO0FBQUEsRUFDL0Q7QUFDQSxrQkFBZ0IsSUFBSSxVQUFVLFFBQVE7QUFDdEMsK0JBQVksR0FBRyw0QkFBNEIsUUFBUSxHQUFHLFFBQVE7QUFDOUQsU0FBTztBQUNUO0FBRUEsU0FBUyxtQ0FDUCxVQUNBLGlCQUNTO0FBQ1QsUUFBTSxXQUFXLGdCQUFnQixJQUFJLFFBQVE7QUFDN0MsTUFBSSxDQUFDLFNBQVUsUUFBTztBQUN0QixrQkFBZ0IsT0FBTyxRQUFRO0FBQy9CLCtCQUFZLGVBQWUsNEJBQTRCLFFBQVEsR0FBRyxRQUFRO0FBQzFFLFNBQU87QUFDVDsiLAogICJuYW1lcyI6IFsiaW1wb3J0X2VsZWN0cm9uIiwgImxpc3RlbmVycyIsICJidXR0b24iLCAiYnV0dG9uIiwgInJvb3QiLCAic25hcHNob3QiLCAiY29tcGFjdCIsICJyZXN1bHQiLCAic3RhdGUiLCAic25hcHNob3QiLCAiYnV0dG9uIiwgInN0YXRlIiwgImNoZWNrIiwgImJ1dHRvbiIsICJpbXBvcnRfZWxlY3Ryb24iLCAiYnV0dG9uIiwgImlkZW50aXR5IiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImltcG9ydF9lbGVjdHJvbiIsICJpbXBvcnRfZWxlY3Ryb24iLCAic3RhdGUiLCAiZG9jdW1lbnQiLCAic25hcHNob3QiLCAic2FmZVN0cmluZ2lmeSJdCn0K
