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
    if (!card.isConnected || !transaction || environmentTransactionIsTerminal(transaction.phase)) return;
    transactionPolling = setTimeout(() => {
      transactionPolling = null;
      void loadEnvironmentTransaction();
    }, 900);
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
    void import_electron.ipcRenderer.invoke("tweaker:rollback-environment", { transactionId: receipt.transactionId }).then((result) => {
      transaction = normalizeEnvironmentTransaction(result) ?? receipt;
      environmentActionError = null;
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
        transaction = normalizeEnvironmentTransaction(transactionResult);
        restorePersistedRequest();
      }
      draw();
      scheduleEnvironmentTransactionPoll();
    } catch (error) {
      if (!cardUpdates.isCurrent(statusUpdate) && !cardUpdates.isCurrent(transactionUpdate) || !card.isConnected) return;
      card.textContent = "";
      card.appendChild(rowSimple("Could not load environment", safeUiError(error)));
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
  const details = [
    environmentTransactionLabel(transaction.phase),
    transaction.error,
    helperFailure
  ].filter((value) => typeof value === "string" && value.length > 0);
  const row = actionRow(
    "App mode restart",
    [...new Set(details)].join(" \xB7 ")
  );
  const left = row.firstElementChild;
  if (left) left.prepend(statusBadge(environmentTransactionTone(transaction.phase), environmentTransactionLabel(transaction.phase)));
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
  const transactionIsActive = () => {
    if (!transaction?.transactionId) {
      return transaction?.phase === "preparing" && Date.now() < awaitingTransactionReceiptUntil;
    }
    return !["completed", "failed", "rolled_back"].includes(transaction.phase);
  };
  const scheduleTransactionPoll = (delayMs = 2e3) => {
    if (polling) clearTimeout(polling);
    if (!card.isConnected || !transactionIsActive() && transaction?.resumable !== true) return;
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
        transaction = observed;
        if (transaction?.transactionId) awaitingTransactionReceiptUntil = 0;
      }
      transactionPollFailures = 0;
      draw();
      scheduleTransactionPoll();
    } catch (error) {
      if (!cardUpdates.isCurrent(update) || !card.isConnected) return;
      transaction = {
        transactionId: transaction?.transactionId ?? null,
        phase: transaction?.phase ?? "preparing",
        error: safeUiError(error)
      };
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
    update.disabled = busy || result?.status !== "update-available" || transactionIsActive() || transaction?.resumable === true;
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
  const detail = [
    transaction.transactionId ? `Transaction ${transaction.transactionId}` : null,
    transaction.safeOfficialMode ? "Official ChatGPT is active" : null,
    transaction.refreshSource ? `${transaction.refreshSource} Tweakers refresh` : null,
    transaction.error ?? null
  ].filter(Boolean).join(" \xB7 ") || "Waiting for the durable updater receipt.";
  const row = actionRow("Update and Reload", detail);
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  const left = row.firstElementChild;
  const tone = transaction.phase === "completed" ? "ok" : transaction.phase === "failed" && !transaction.resumable ? "error" : "warn";
  left?.prepend(statusBadge(tone, phase));
  const controls = row.querySelector("[data-tweaker-row-actions]");
  const canResume = transaction.resumable === true && (transaction.phase === "failed" || transaction.phase === "rolled_back");
  const canCancel = transaction.phase === "awaiting_native_update" || transaction.resumable === true && ["failed", "rolled_back"].includes(transaction.phase);
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
  return value.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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
        const wrapped = (_e, ...args) => h(...args);
        import_electron2.ipcRenderer.on(`tweaker:${id}:${c}`, wrapped);
        return () => import_electron2.ipcRenderer.removeListener(`tweaker:${id}:${c}`, wrapped);
      },
      send: (c, ...args) => import_electron2.ipcRenderer.send(`tweaker:${id}:${c}`, ...args),
      invoke: (c, ...args) => {
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
      try {
        console.info("[tweaker] hot-reloading tweaks");
        teardownTweakHost();
        await startTweakHost();
        await mountManager();
      } catch (e) {
        console.error("[tweaker] hot reload failed:", e);
      } finally {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvdHdlYWstc3RvcmUudHMiLCAiLi4vc3JjL3ByZWxvYWQvc2V0dGluZ3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vha3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC9lbnZpcm9ubWVudC1jb25maWctY29udHJvbGxlci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL2hvc3Qtc3VyZmFjZXMudHMiLCAiLi4vc3JjL3R3ZWFrLWxpZmVjeWNsZS50cyIsICIuLi9zcmMvcmVuZGVyZXItc3RvcmFnZS50cyIsICIuLi9zcmMvcHJlbG9hZC9tYW5hZ2VyLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2Rlc2t0b3AtdXBkYXRlLWluZGljYXRvci50cyIsICIuLi9zcmMvcHJlbG9hZC9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVuZGVyZXIgcHJlbG9hZCBlbnRyeS4gUnVucyBpbiBhbiBpc29sYXRlZCB3b3JsZCBiZWZvcmUgQ29kZXgncyBwYWdlIEpTLlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqICAgMS4gSW5zdGFsbCBhIFJlYWN0IERldlRvb2xzLXNoYXBlZCBnbG9iYWwgaG9vayB0byBjYXB0dXJlIHRoZSByZW5kZXJlclxuICogICAgICByZWZlcmVuY2Ugd2hlbiBSZWFjdCBtb3VudHMuIFdlIHVzZSB0aGlzIGZvciBmaWJlciB3YWxraW5nLlxuICogICAyLiBBZnRlciBET01Db250ZW50TG9hZGVkLCBraWNrIG9mZiBzZXR0aW5ncy1pbmplY3Rpb24gbG9naWMuXG4gKiAgIDMuIERpc2NvdmVyIHJlbmRlcmVyLXNjb3BlZCB0d2Vha3MgKHZpYSBJUEMgdG8gbWFpbikgYW5kIHN0YXJ0IHRoZW0uXG4gKiAgIDQuIExpc3RlbiBmb3IgYHR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRgIGZyb20gbWFpbiAoZmlsZXN5c3RlbSB3YXRjaGVyKSBhbmRcbiAqICAgICAgaG90LXJlbG9hZCB0d2Vha3Mgd2l0aG91dCBkcm9wcGluZyB0aGUgcGFnZS5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgaW5zdGFsbFJlYWN0SG9vayB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB7IHN0YXJ0U2V0dGluZ3NJbmplY3RvciB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBzdGFydFR3ZWFrSG9zdCwgdGVhcmRvd25Ud2Vha0hvc3QgfSBmcm9tIFwiLi90d2Vhay1ob3N0XCI7XG5pbXBvcnQgeyBtb3VudE1hbmFnZXIgfSBmcm9tIFwiLi9tYW5hZ2VyXCI7XG5pbXBvcnQgeyBzdGFydERlc2t0b3BVcGRhdGVJbmRpY2F0b3IgfSBmcm9tIFwiLi9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3JcIjtcblxuY29uc3QgQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1jb25uZWN0LWFwcC1ob3N0XCI7XG5jb25zdCBCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNUID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlcXVlc3RcIjtcbmNvbnN0IEJST1dTRVJfVUlfQlJJREdFX1JFU1BPTlNFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlc3BvbnNlXCI7XG5jb25zdCBCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1tZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBCUk9XU0VSX1VJX1dPUktFUl9NRVNTQUdFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktd29ya2VyLW1lc3NhZ2VcIjtcbmNvbnN0IEJST1dTRVJfVUlfU1lTVEVNX1RIRU1FID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktc3lzdGVtLXRoZW1lXCI7XG5cbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GT1JfVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQ09OVEVYVF9NRU5VID0gXCJjb2RleF9kZXNrdG9wOnNob3ctY29udGV4dC1tZW51XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQVBQTElDQVRJT05fTUVOVSA9IFwiY29kZXhfZGVza3RvcDpzaG93LWFwcGxpY2F0aW9uLW1lbnVcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXNlbnRyeS1pbml0LW9wdGlvbnNcIjtcbmNvbnN0IERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUiA9IFwiY29kZXhfZGVza3RvcDpnZXQtYnVpbGQtZmxhdm9yXCI7XG5jb25zdCBERVNLVE9QX0dFVF9VU0VTX09XTF9BUFBfU0hFTEwgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXVzZXMtb3dsLWFwcC1zaGVsbFwiO1xuY29uc3QgREVTS1RPUF9HRVRfU1lTVEVNX1RIRU1FX1ZBUklBTlQgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXN5c3RlbS10aGVtZS12YXJpYW50XCI7XG5jb25zdCBERVNLVE9QX0dFVF9TSEFSRURfT0JKRUNUX1NOQVBTSE9UID0gXCJjb2RleF9kZXNrdG9wOmdldC1zaGFyZWQtb2JqZWN0LXNuYXBzaG90XCI7XG5jb25zdCBERVNLVE9QX0dFVF9GQVNUX01PREVfUk9MTE9VVF9NRVRSSUNTID0gXCJjb2RleF9kZXNrdG9wOmdldC1mYXN0LW1vZGUtcm9sbG91dC1tZXRyaWNzXCI7XG5jb25zdCBERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVEID0gXCJjb2RleF9kZXNrdG9wOnN5c3RlbS10aGVtZS12YXJpYW50LXVwZGF0ZWRcIjtcbmNvbnN0IERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCA9IFwiY29kZXhfZGVza3RvcDp0cmlnZ2VyLXNlbnRyeS10ZXN0XCI7XG5cbmZ1bmN0aW9uIGRlc2t0b3BXb3JrZXJGcm9tVmlld0NoYW5uZWwod29ya2VySWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgY29kZXhfZGVza3RvcDp3b3JrZXI6JHt3b3JrZXJJZH06ZnJvbS12aWV3YDtcbn1cblxuZnVuY3Rpb24gZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYGNvZGV4X2Rlc2t0b3A6d29ya2VyOiR7d29ya2VySWR9OmZvci12aWV3YDtcbn1cblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW3R3ZWFrZXIgcHJlbG9hZF0gJHtzdGFnZX0ke1xuICAgIGV4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKVxuICB9YDtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLCBcImluZm9cIiwgbXNnKTtcbiAgfSBjYXRjaCB7fVxufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuZmlsZUxvZyhcInByZWxvYWQgZW50cnlcIiwgeyB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG5cbnRyeSB7XG4gIGluc3RhbGxCcm93c2VyVWlIb3N0QnJpZGdlKCk7XG4gIGZpbGVMb2coXCJicm93c2VyIFVJIGhvc3QgYnJpZGdlIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcImJyb3dzZXIgVUkgaG9zdCBicmlkZ2UgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbi8vIFJlYWN0IGhvb2sgbXVzdCBiZSBpbnN0YWxsZWQgKmJlZm9yZSogQ29kZXgncyBidW5kbGUgcnVucy5cbnRyeSB7XG4gIGluc3RhbGxSZWFjdEhvb2soKTtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxucXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBib290LCB7IG9uY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgYm9vdCgpO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHtcbiAgZmlsZUxvZyhcImJvb3Qgc3RhcnRcIiwgeyByZWFkeVN0YXRlOiBkb2N1bWVudC5yZWFkeVN0YXRlIH0pO1xuICB0cnkge1xuICAgIHN0YXJ0RGVza3RvcFVwZGF0ZUluZGljYXRvcigpO1xuICAgIGZpbGVMb2coXCJkZXNrdG9wIHVwZGF0ZSBpbmRpY2F0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBwcmVsb2FkIGJvb3QgZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBIb3QgcmVsb2FkOiBnYXRlZCBiZWhpbmQgYSBzbWFsbCBpbi1mbGlnaHQgbG9jayBzbyBhIGZsdXJyeSBvZiBmcyBldmVudHNcbi8vIGRvZXNuJ3QgcmVlbnRyYW50bHkgdGVhciBkb3duIHRoZSBob3N0IG1pZC1sb2FkLlxubGV0IHJlbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gc3Vic2NyaWJlUmVsb2FkKCk6IHZvaWQge1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRcIiwgKCkgPT4ge1xuICAgIGlmIChyZWxvYWRpbmcpIHJldHVybjtcbiAgICByZWxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW3R3ZWFrZXJdIGhvdC1yZWxvYWRpbmcgdHdlYWtzXCIpO1xuICAgICAgICB0ZWFyZG93blR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsQnJvd3NlclVpSG9zdEJyaWRnZSgpOiB2b2lkIHtcbiAgY29uc3Qgd29ya2VyTGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+KCk7XG5cbiAgaXBjUmVuZGVyZXIub24oQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQsIChldmVudCkgPT4ge1xuICAgIGNvbnN0IFtwb3J0XSA9IGV2ZW50LnBvcnRzO1xuICAgIGlmICghcG9ydCkgcmV0dXJuO1xuICAgIHdpbmRvdy5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY29ubmVjdC1hcHAtaG9zdFwiLCBwb3J0IH0sIFwiKlwiLCBbcG9ydF0pO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNULCBhc3luYyAoX2V2ZW50LCBwYXlsb2FkKSA9PiB7XG4gICAgY29uc3QgcmVxdWVzdCA9IHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09IFwib2JqZWN0XCJcbiAgICAgID8gcGF5bG9hZCBhcyB7IGlkPzogdW5rbm93bjsgbWV0aG9kPzogdW5rbm93bjsgYXJncz86IHVua25vd24gfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiByZXF1ZXN0LmlkID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5pZCA6IFwiXCI7XG4gICAgY29uc3QgbWV0aG9kID0gdHlwZW9mIHJlcXVlc3QubWV0aG9kID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5tZXRob2QgOiBcIlwiO1xuICAgIGNvbnN0IGFyZ3MgPSBBcnJheS5pc0FycmF5KHJlcXVlc3QuYXJncykgPyByZXF1ZXN0LmFyZ3MgOiBbXTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBydW5Ccm93c2VyVWlCcmlkZ2VNZXRob2QobWV0aG9kLCBhcmdzLCB3b3JrZXJMaXN0ZW5lcnMpO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX0JSSURHRV9SRVNQT05TRSwgeyBpZCwgb2s6IHRydWUsIHZhbHVlIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9CUklER0VfUkVTUE9OU0UsIHtcbiAgICAgICAgaWQsXG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXBjUmVuZGVyZXIub24oREVTS1RPUF9NRVNTQUdFX0ZPUl9WSUVXLCAoX2V2ZW50LCBtZXNzYWdlKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcsIG1lc3NhZ2UpO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVELCAoX2V2ZW50LCB2YWx1ZSkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9TWVNURU1fVEhFTUUsIHZhbHVlKTtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkJyb3dzZXJVaUJyaWRnZU1ldGhvZChcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIGFyZ3M6IHVua25vd25bXSxcbiAgd29ya2VyTGlzdGVuZXJzOiBNYXA8c3RyaW5nLCAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJzbmFwc2hvdFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NIQVJFRF9PQkpFQ1RfU05BUFNIT1QpID8/IHt9O1xuICAgIGNhc2UgXCJzeXN0ZW1UaGVtZVwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NZU1RFTV9USEVNRV9WQVJJQU5UKTtcbiAgICBjYXNlIFwic2VudHJ5T3B0aW9uc1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMpO1xuICAgIGNhc2UgXCJidWlsZEZsYXZvclwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUik7XG4gICAgY2FzZSBcInVzZXNPd2xBcHBTaGVsbFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1VTRVNfT1dMX0FQUF9TSEVMTCkgPT09IHRydWU7XG4gICAgY2FzZSBcInNlbmRNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9NRVNTQUdFX0ZST01fVklFVywgYXJnc1swXSk7XG4gICAgY2FzZSBcInNlbmRXb3JrZXJNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoZGVza3RvcFdvcmtlckZyb21WaWV3Q2hhbm5lbChTdHJpbmcoYXJnc1swXSkpLCBhcmdzWzFdKTtcbiAgICBjYXNlIFwic3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiBzdWJzY3JpYmVCcm93c2VyVWlXb3JrZXJNZXNzYWdlcyhTdHJpbmcoYXJnc1swXSksIHdvcmtlckxpc3RlbmVycyk7XG4gICAgY2FzZSBcInVuc3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFN0cmluZyhhcmdzWzBdKSwgd29ya2VyTGlzdGVuZXJzKTtcbiAgICBjYXNlIFwic2hvd0NvbnRleHRNZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19DT05URVhUX01FTlUsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJzaG93QXBwbGljYXRpb25NZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19BUFBMSUNBVElPTl9NRU5VLCB7XG4gICAgICAgIG1lbnVJZDogYXJnc1swXSxcbiAgICAgICAgeDogYXJnc1sxXSxcbiAgICAgICAgeTogYXJnc1syXSxcbiAgICAgIH0pO1xuICAgIGNhc2UgXCJnZXRGYXN0TW9kZVJvbGxvdXRNZXRyaWNzXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfR0VUX0ZBU1RfTU9ERV9ST0xMT1VUX01FVFJJQ1MsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJ0cmlnZ2VyU2VudHJ5VGVzdEVycm9yXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBUd2Vha2VycyBicm93c2VyIFVJIGJyaWRnZSBtZXRob2Q6ICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGlmICghL15bYS16QS1aMC05Ll86LV0rJC8udGVzdCh3b3JrZXJJZCkpIHRocm93IG5ldyBFcnJvcihcImludmFsaWQgd29ya2VyIGlkXCIpO1xuICBpZiAod29ya2VyTGlzdGVuZXJzLmhhcyh3b3JrZXJJZCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsaXN0ZW5lciA9IChfZXZlbnQ6IHVua25vd24sIG1lc3NhZ2U6IHVua25vd24pID0+IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfV09SS0VSX01FU1NBR0UsIHdvcmtlcklkLCBtZXNzYWdlKTtcbiAgfTtcbiAgd29ya2VyTGlzdGVuZXJzLnNldCh3b3JrZXJJZCwgbGlzdGVuZXIpO1xuICBpcGNSZW5kZXJlci5vbihkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQpLCBsaXN0ZW5lcik7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxpc3RlbmVyID0gd29ya2VyTGlzdGVuZXJzLmdldCh3b3JrZXJJZCk7XG4gIGlmICghbGlzdGVuZXIpIHJldHVybiB0cnVlO1xuICB3b3JrZXJMaXN0ZW5lcnMuZGVsZXRlKHdvcmtlcklkKTtcbiAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkKSwgbGlzdGVuZXIpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICIvKipcbiAqIEluc3RhbGwgYSBtaW5pbWFsIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXy4gUmVhY3QgY2FsbHNcbiAqIGBob29rLmluamVjdChyZW5kZXJlckludGVybmFscylgIGR1cmluZyBgY3JlYXRlUm9vdGAvYGh5ZHJhdGVSb290YC4gVGhlXG4gKiBcImludGVybmFsc1wiIG9iamVjdCBleHBvc2VzIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlLCB3aGljaCBsZXRzIHVzIHR1cm4gYVxuICogRE9NIG5vZGUgaW50byBhIFJlYWN0IGZpYmVyIFx1MjAxNCBuZWNlc3NhcnkgZm9yIG91ciBTZXR0aW5ncyBpbmplY3Rvci5cbiAqXG4gKiBXZSBkb24ndCB3YW50IHRvIGJyZWFrIHJlYWwgUmVhY3QgRGV2VG9vbHMgaWYgdGhlIHVzZXIgb3BlbnMgaXQ7IHdlIGluc3RhbGxcbiAqIG9ubHkgaWYgbm8gaG9vayBleGlzdHMgeWV0LCBhbmQgd2UgZm9yd2FyZCBjYWxscyB0byBhIGRvd25zdHJlYW0gaG9vayBpZlxuICogb25lIGlzIGxhdGVyIGFzc2lnbmVkLlxuICovXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXz86IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgIF9fdHdlYWtlcl9fPzoge1xuICAgICAgaG9vazogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgICB9O1xuICB9XG59XG5cbmludGVyZmFjZSBSZW5kZXJlckludGVybmFscyB7XG4gIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPzogKG46IE5vZGUpID0+IHVua25vd247XG4gIHZlcnNpb24/OiBzdHJpbmc7XG4gIGJ1bmRsZVR5cGU/OiBudW1iZXI7XG4gIHJlbmRlcmVyUGFja2FnZU5hbWU/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWFjdERldnRvb2xzSG9vayB7XG4gIHN1cHBvcnRzRmliZXI6IHRydWU7XG4gIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICBvbihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIG9mZihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIGVtaXQoZXZlbnQ6IHN0cmluZywgLi4uYTogdW5rbm93bltdKTogdm9pZDtcbiAgaW5qZWN0KHJlbmRlcmVyOiBSZW5kZXJlckludGVybmFscyk6IG51bWJlcjtcbiAgb25TY2hlZHVsZUZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJVbm1vdW50PygpOiB2b2lkO1xuICBjaGVja0RDRT8oKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSZWFjdEhvb2soKTogdm9pZCB7XG4gIGlmICh3aW5kb3cuX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fKSByZXR1cm47XG4gIGNvbnN0IHJlbmRlcmVycyA9IG5ldyBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz4oKTtcbiAgbGV0IG5leHRJZCA9IDE7XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8KC4uLmE6IHVua25vd25bXSkgPT4gdm9pZD4+KCk7XG5cbiAgY29uc3QgaG9vazogUmVhY3REZXZ0b29sc0hvb2sgPSB7XG4gICAgc3VwcG9ydHNGaWJlcjogdHJ1ZSxcbiAgICByZW5kZXJlcnMsXG4gICAgaW5qZWN0KHJlbmRlcmVyKSB7XG4gICAgICBjb25zdCBpZCA9IG5leHRJZCsrO1xuICAgICAgcmVuZGVyZXJzLnNldChpZCwgcmVuZGVyZXIpO1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICAgIFwiW3R3ZWFrZXJdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX190d2Vha2VyX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX190d2Vha2VyX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBUV0VBS0VSUyAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqICAgXHUyNUM3IFR3ZWFrIFN0b3JlXG4gKlxuICogQ2xpY2tpbmcgQ29uZmlnIC8gVHdlYWtzIC8gVHdlYWsgU3RvcmUgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB7XG4gIGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwsXG4gIHR5cGUgVHdlYWtIZWFsdGhSZWNvcmQsXG4gIHR5cGUgVHdlYWtTdGF0dXMsXG4gIHR5cGUgVHdlYWtTdG9yZUVudHJ5LFxuICB0eXBlIFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbixcbn0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5pbXBvcnQge1xuICBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsLFxuICB0eXBlIFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0sXG59IGZyb20gXCIuL3NldHRpbmdzLXBhZ2UtbW9kZWxcIjtcbmltcG9ydCB7XG4gIGZpbHRlclR3ZWFrc1BhZ2VJdGVtcyxcbiAgVFdFQUtTX1BBR0VfRklMVEVSUyxcbiAgdHdlYWtzUGFnZUNvdW50cyxcbiAgdHlwZSBUd2Vha3NQYWdlRmlsdGVyLFxufSBmcm9tIFwiLi90d2Vha3MtcGFnZS1tb2RlbFwiO1xuaW1wb3J0IHtcbiAgQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yLFxuICBjcmVhdGVFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXIsXG4gIGRlc2t0b3BVcGRhdGVTdGF0dXNQcmVzZW50YXRpb24sXG4gIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzLFxuICB0eXBlIEVudmlyb25tZW50Q29uZmlybWF0aW9uRGVjaXNpb24sXG59IGZyb20gXCIuL2Vudmlyb25tZW50LWNvbmZpZy1jb250cm9sbGVyXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENvZGV4Q2xpTGFuZSxcbiAgQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIENvZGV4RmVhdHVyZUVudHJ5LFxuICBDb2RleEZlYXR1cmVTdGFnZSxcbiAgQ29kZXhJbnN0YWxsUHJvZ3Jlc3MsXG4gIENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbn0gZnJvbSBcIi4uL2NvZGV4LXZlcnNpb24tdHlwZXNcIjtcblxuY29uc3QgVFdFQUtFUlNfUkVMRUFTRVNfVVJMID0gXCJodHRwczovL2dpdGh1Yi5jb20vdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy9yZWxlYXNlc1wiO1xuXG4vLyBNaXJyb3JzIHRoZSBydW50aW1lJ3MgbWFpbi1zaWRlIExpc3RlZFR3ZWFrIHNoYXBlIChrZXB0IGluIHN5bmMgbWFudWFsbHkpLlxuaW50ZXJmYWNlIExpc3RlZFR3ZWFrIHtcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIGVudHJ5OiBzdHJpbmc7XG4gIGRpcjogc3RyaW5nO1xuICBlbnRyeUV4aXN0czogYm9vbGVhbjtcbiAgaW5zdGFsbGVkOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzdGF0dXM6IFR3ZWFrU3RhdHVzO1xuICBoZWFsdGg6IFR3ZWFrSGVhbHRoUmVjb3JkIHwgbnVsbDtcbiAgY2F0YWxvZzogVHdlYWtTdG9yZUVudHJ5IHwgbnVsbDtcbiAgdXBkYXRlOiBUd2Vha1VwZGF0ZUNoZWNrIHwgbnVsbDtcbiAgbGlmZWN5Y2xlT3ZlcnJpZGU/OiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW1wibGlmZWN5Y2xlXCJdO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICByZXBvOiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFR3ZWFrZXJDb25maWcge1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGF1dG9VcGRhdGU6IGJvb2xlYW47XG4gIHVwZGF0ZUNoYW5uZWw6IFNlbGZVcGRhdGVDaGFubmVsO1xuICB1cGRhdGVSZXBvOiBzdHJpbmc7XG4gIHVwZGF0ZVJlZjogc3RyaW5nO1xuICB1cGRhdGVDaGVjazogVHdlYWtlclVwZGF0ZUNoZWNrIHwgbnVsbDtcbiAgc2VsZlVwZGF0ZTogU2VsZlVwZGF0ZVN0YXRlIHwgbnVsbDtcbiAgaW5zdGFsbGF0aW9uU291cmNlOiBJbnN0YWxsYXRpb25Tb3VyY2U7XG59XG5cbmludGVyZmFjZSBUd2Vha2VyVXBkYXRlQ2hlY2sge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZU5vdGVzOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG50eXBlIFNlbGZVcGRhdGVDaGFubmVsID0gXCJzdGFibGVcIiB8IFwicHJlcmVsZWFzZVwiIHwgXCJjdXN0b21cIjtcbnR5cGUgU2VsZlVwZGF0ZVN0YXR1cyA9IFwiY2hlY2tpbmdcIiB8IFwidXAtdG8tZGF0ZVwiIHwgXCJ1cGRhdGVkXCIgfCBcImZhaWxlZFwiIHwgXCJkaXNhYmxlZFwiO1xuXG5pbnRlcmZhY2UgU2VsZlVwZGF0ZVN0YXRlIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGNvbXBsZXRlZEF0Pzogc3RyaW5nO1xuICBzdGF0dXM6IFNlbGZVcGRhdGVTdGF0dXM7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHRhcmdldFJlZjogc3RyaW5nIHwgbnVsbDtcbiAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgcmVwbzogc3RyaW5nO1xuICBjaGFubmVsOiBTZWxmVXBkYXRlQ2hhbm5lbDtcbiAgc291cmNlUm9vdDogc3RyaW5nO1xuICBpbnN0YWxsYXRpb25Tb3VyY2U/OiBJbnN0YWxsYXRpb25Tb3VyY2U7XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgSW5zdGFsbGF0aW9uU291cmNlIHtcbiAga2luZDogXCJnaXRodWItc291cmNlXCIgfCBcImhvbWVicmV3XCIgfCBcImxvY2FsLWRldlwiIHwgXCJzb3VyY2UtYXJjaGl2ZVwiIHwgXCJ1bmtub3duXCI7XG4gIGxhYmVsOiBzdHJpbmc7XG4gIGRldGFpbDogc3RyaW5nO1xufVxuXG50eXBlIEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSA9IFwiY2hhdGdwdFwiIHwgXCJ0d2Vha2Vyc1wiO1xudHlwZSBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlID0gXCJzdGFibGVcIiB8IFwiYWxwaGFcIjtcblxuaW50ZXJmYWNlIEVudmlyb25tZW50U2VsZWN0aW9uIHtcbiAgYXBwRXhwZXJpZW5jZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlO1xuICByZWxlYXNlUHJvZmlsZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZTtcbiAgc2VsZWN0ZWREZXNrdG9wUGF0aD86IHN0cmluZztcbiAgc2VsZWN0ZWREZXNrdG9wQnVuZGxlSWQ/OiBzdHJpbmc7XG4gIGJhY2tlbmRMYW5lPzogc3RyaW5nO1xuICByZXF1ZXN0ZWRBdD86IHN0cmluZztcbiAgYXBwbGllZEF0Pzogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50Q2hhbm5lbFN0YXR1cyB7XG4gIGF2YWlsYWJsZTogYm9vbGVhbjtcbiAgdW5hdmFpbGFibGVSZWFzb25zPzogc3RyaW5nW107XG4gIGF2YWlsYWJpbGl0eT86IFJlY29yZDxFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UsIHtcbiAgICBhdmFpbGFibGU6IGJvb2xlYW47XG4gICAgdW5hdmFpbGFibGVSZWFzb25zPzogc3RyaW5nW107XG4gIH0+O1xuICBzZWxlY3RlZERlc2t0b3BQYXRoPzogc3RyaW5nO1xuICBzZWxlY3RlZERlc2t0b3BCdW5kbGVJZD86IHN0cmluZztcbiAgcmVsZWFzZVByb2ZpbGU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGU7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFN0YXR1cyB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIHNlbGVjdGVkOiBFbnZpcm9ubWVudFNlbGVjdGlvbjtcbiAgY2hhbm5lbHM6IFJlY29yZDxFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlLCBFbnZpcm9ubWVudENoYW5uZWxTdGF0dXM+O1xuICBvYnNlcnZhdGlvbj86IHtcbiAgICBhcHBFeHBlcmllbmNlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UgfCBudWxsO1xuICAgIHNlbGVjdGlvbkRyaWZ0OiBib29sZWFuO1xuICAgIGxpZmVjeWNsZUNvbnRlbmRlZDogYm9vbGVhbjtcbiAgICBjb21taXRKb3VybmFsUHJlc2VudDogYm9vbGVhbjtcbiAgICB0cmFuc2l0aW9uSm91cm5hbFByZXNlbnQ6IGJvb2xlYW47XG4gICAgZnJlc2huZXNzOiBcImN1cnJlbnRcIiB8IFwiY29udGVuZGVkXCI7XG4gIH07XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24ge1xuICBraW5kPzogXCJlbnZpcm9ubWVudC1jb21taXQtaGVscGVyXCI7XG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZztcbiAgcGhhc2U6IFwic3VibWl0dGVkXCIgfCBcInN1Ym1pdC1mYWlsZWRcIjtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRIZWxwZXJPdXRjb21lIHtcbiAgcGhhc2U/OiBcIm5vdC1zdGFydGVkXCIgfCBcInJ1bm5pbmdcIiB8IFwic3VjY2VlZGVkXCIgfCBcImZhaWxlZFwiO1xuICBleGl0Q29kZT86IG51bWJlciB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50SGVscGVyU3RhdHVzIHtcbiAgc3VibWlzc2lvbj86IEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbiB8IG51bGw7XG4gIG91dGNvbWU/OiBFbnZpcm9ubWVudEhlbHBlck91dGNvbWUgfCBudWxsO1xuICBzdGRvdXQ/OiBzdHJpbmcgfCBudWxsO1xuICBzdGRlcnI/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRUcmFuc2FjdGlvbiB7XG4gIHNjaGVtYVZlcnNpb24/OiAxO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmc7XG4gIHBoYXNlOiBzdHJpbmc7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xuICBzb3VyY2U/OiBFbnZpcm9ubWVudFNlbGVjdGlvbjtcbiAgcmVxdWVzdGVkPzogRW52aXJvbm1lbnRTZWxlY3Rpb247XG4gIHByZXBhcmVkPzoge1xuICAgIGNhbmRpZGF0ZT86IHtcbiAgICAgIGRlc2t0b3BQYXRoPzogc3RyaW5nO1xuICAgICAgYnVuZGxlSWQ/OiBzdHJpbmc7XG4gICAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgICAgYnVpbGQ/OiBzdHJpbmc7XG4gICAgfTtcbiAgICBiYWNrZW5kPzoge1xuICAgICAgbGFuZT86IHN0cmluZztcbiAgICAgIGJpbmFyeVBhdGg/OiBzdHJpbmc7XG4gICAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgIH07XG4gICAgcm9sbGJhY2s/OiB7XG4gICAgICBzZWxlY3Rpb24/OiBFbnZpcm9ubWVudFNlbGVjdGlvbjtcbiAgICAgIGRlc2t0b3BQYXRoPzogc3RyaW5nO1xuICAgICAgYmFja2VuZExhbmU/OiBzdHJpbmc7XG4gICAgfTtcbiAgfSB8IG51bGw7XG4gIGhlbHBlcj86IEVudmlyb25tZW50SGVscGVyU3RhdHVzIHwgbnVsbDtcbiAgdXBkYXRlZEF0Pzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgTWNwU3luY1N0YXRlIHtcbiAgc3RhdHVzPzogc3RyaW5nO1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xuICBjaGVja2VkQXQ/OiBzdHJpbmc7XG4gIGNvbXBsZXRlZEF0Pzogc3RyaW5nO1xuICBkZXNpcmVkTmFtZXM/OiBzdHJpbmdbXTtcbiAgYXBwbGllZE5hbWVzPzogc3RyaW5nW107XG4gIGNvbmZsaWN0cz86IEFycmF5PHtcbiAgICBuYW1lPzogc3RyaW5nO1xuICAgIG9ic2VydmVkTmFtZT86IHN0cmluZztcbiAgICBjYW5vbmljYWxOYW1lPzogc3RyaW5nO1xuICAgIGRldGFpbD86IHN0cmluZztcbiAgICByZWFzb24/OiBzdHJpbmc7XG4gIH0+O1xuICByZXN0YXJ0UmVxdWlyZWQ/OiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCB7XG4gIHN0YXR1cz86IFwidXBkYXRlLWF2YWlsYWJsZVwiIHwgXCJjdXJyZW50XCIgfCBcInN0YWxlXCIgfCBcInVuYXZhaWxhYmxlXCIgfCBcImVycm9yXCI7XG4gIHByb2ZpbGU/OiBcInN0YWJsZVwiIHwgXCJhbHBoYVwiIHwgbnVsbDtcbiAgaW5zdGFsbGVkPzogeyBtYXJrZXRpbmdWZXJzaW9uPzogc3RyaW5nIHwgbnVsbDsgYnVpbGQ/OiBzdHJpbmcgfCBudWxsIH07XG4gIGxhdGVzdD86IHsgbWFya2V0aW5nVmVyc2lvbj86IHN0cmluZyB8IG51bGw7IGJ1aWxkPzogc3RyaW5nIHwgbnVsbCB9O1xuICByZWFzb24/OiBzdHJpbmcgfCBudWxsO1xuICBjaGVja2VkQXQ/OiBzdHJpbmc7XG4gIHVwZGF0ZUFuZFJlbG9hZFJlcXVlc3RlZD86IGJvb2xlYW47XG4gIG5hdGl2ZVVwZGF0ZUNvbnRyb2xBY3RpdmU/OiBib29sZWFuO1xuICBqYXZhU2NyaXB0VXBkYXRlck1hbmFnZXJBdmFpbGFibGU/OiBib29sZWFuO1xuICBqYXZhU2NyaXB0VXBkYXRlck1hbmFnZXJSZWFzb24/OiBzdHJpbmcgfCBudWxsO1xuICBzZXR1cFJlcXVpcmVkPzogXCJyZWdpc3Rlci1iZXRhXCIgfCBcImxhdW5jaC1iZXRhXCIgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGUge1xuICBzY2hlbWFWZXJzaW9uPzogMTtcbiAga2luZD86IFwiZGVza3RvcC11cGRhdGVcIjtcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nIHwgbnVsbDtcbiAgcGhhc2U6IHN0cmluZztcbiAgb3duZXJQaWQ/OiBudW1iZXI7XG4gIHNhZmVPZmZpY2lhbE1vZGU/OiBib29sZWFuO1xuICByZXN1bWFibGU/OiBib29sZWFuO1xuICBuYXRpdmVVcGRhdGVIYW5kb2ZmQXQ/OiBzdHJpbmcgfCBudWxsO1xuICByZWZyZXNoU291cmNlPzogXCJkZXZlbG9wbWVudFwiIHwgXCJzdGFibGVcIiB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlZEF0Pzogc3RyaW5nO1xufVxuXG50eXBlIENvZGV4VWlSZWxvYWQgPSAobW9kZT86IFwib3BlcmF0aW9uLXN0YXJ0XCIgfCBcIm9wZXJhdGlvbi1zdG9wXCIpID0+IHZvaWQ7XG5cbmludGVyZmFjZSBXYXRjaGVySGVhbHRoIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCI7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHN1bW1hcnk6IHN0cmluZztcbiAgd2F0Y2hlcjogc3RyaW5nO1xuICBjaGVja3M6IFdhdGNoZXJIZWFsdGhDaGVja1tdO1xuICBsYXRlc3RDb21wbGV0ZWRDeWNsZT86IFdhdGNoZXJDeWNsZVJlY2VpcHQ7XG59XG5cbmludGVyZmFjZSBXYXRjaGVyQ3ljbGVSZWNlaXB0IHtcbiAgY3ljbGVJZDogc3RyaW5nO1xuICBjb21wbGV0ZWRBdDogc3RyaW5nO1xuICBvdXRjb21lOiBcImNvbXBsZXRlZFwiIHwgXCJmYWlsZWRcIjtcbiAgcmVwYWlyOiB7IHN0YXR1czogXCJzdWNjZWVkZWRcIiB8IFwiZmFpbGVkXCIgfCBcInNraXBwZWRcIiB8IFwicGVuZGluZ1wiOyBlcnJvcjogc3RyaW5nIHwgbnVsbCB9O1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aENoZWNrIHtcbiAgbmFtZTogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICBkZXRhaWw6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXcge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICBnZW5lcmF0ZWRBdD86IHN0cmluZztcbiAgc291cmNlVXJsOiBzdHJpbmc7XG4gIGZldGNoZWRBdDogc3RyaW5nO1xuICBlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlWaWV3W107XG59XG5cbmludGVyZmFjZSBUd2Vha1N0b3JlRW50cnlWaWV3IGV4dGVuZHMgVHdlYWtTdG9yZUVudHJ5IHtcbiAgaW5zdGFsbGVkOiB7XG4gICAgdmVyc2lvbjogc3RyaW5nO1xuICAgIGVuYWJsZWQ6IGJvb2xlYW47XG4gIH0gfCBudWxsO1xuICBwbGF0Zm9ybT86IHtcbiAgICBjdXJyZW50OiBzdHJpbmc7XG4gICAgc3VwcG9ydGVkOiBzdHJpbmdbXSB8IG51bGw7XG4gICAgY29tcGF0aWJsZTogYm9vbGVhbjtcbiAgICByZWFzb246IHN0cmluZyB8IG51bGw7XG4gIH07XG4gIHJ1bnRpbWU/OiB7XG4gICAgY3VycmVudDogc3RyaW5nO1xuICAgIHJlcXVpcmVkOiBzdHJpbmcgfCBudWxsO1xuICAgIGNvbXBhdGlibGU6IGJvb2xlYW47XG4gICAgcmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICB9O1xufVxuXG4vKipcbiAqIEEgdHdlYWstcmVnaXN0ZXJlZCBwYWdlLiBXZSBjYXJyeSB0aGUgb3duaW5nIHR3ZWFrJ3MgbWFuaWZlc3Qgc28gd2UgY2FuXG4gKiByZXNvbHZlIHJlbGF0aXZlIGljb25VcmxzIGFuZCBzaG93IGF1dGhvcnNoaXAgaW4gdGhlIHBhZ2UgaGVhZGVyLlxuICovXG5pbnRlcmZhY2UgUmVnaXN0ZXJlZFBhZ2Uge1xuICAvKiogRnVsbHktcXVhbGlmaWVkIGlkOiBgPHR3ZWFrSWQ+OjxwYWdlSWQ+YC4gKi9cbiAgaWQ6IHN0cmluZztcbiAgdHdlYWtJZDogc3RyaW5nO1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgcGFnZTogU2V0dGluZ3NQYWdlO1xuICAvKiogUGVyLXBhZ2UgRE9NIHRlYXJkb3duIHJldHVybmVkIGJ5IGBwYWdlLnJlbmRlcmAsIGlmIGFueS4gKi9cbiAgdGVhcmRvd24/OiAoKCkgPT4gdm9pZCkgfCBudWxsO1xuICAvKiogVGhlIGluamVjdGVkIHNpZGViYXIgYnV0dG9uIChzbyB3ZSBjYW4gdXBkYXRlIGl0cyBhY3RpdmUgc3RhdGUpLiAqL1xuICBuYXZCdXR0b24/OiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gIC8qKiBJZGVudGl0eSB0b2tlbiBwcmV2ZW50cyBhbiBvbGQgaGFuZGxlIGZyb20gdW5yZWdpc3RlcmluZyBhIHJlcGxhY2VtZW50LiAqL1xuICByZWdpc3RyYXRpb25Ub2tlbjogc3ltYm9sO1xufVxuXG4vKiogV2hhdCBwYWdlIGlzIGN1cnJlbnRseSBzZWxlY3RlZCBpbiBvdXIgaW5qZWN0ZWQgbmF2LiAqL1xudHlwZSBBY3RpdmVQYWdlID1cbiAgfCB7IGtpbmQ6IFwiY29uZmlnXCIgfVxuICB8IHsga2luZDogXCJzdG9yZVwiIH1cbiAgfCB7IGtpbmQ6IFwidHdlYWtzXCIgfVxuICB8IHsga2luZDogXCJyZWdpc3RlcmVkXCI7IGlkOiBzdHJpbmcgfTtcblxuaW50ZXJmYWNlIEluamVjdG9yU3RhdGUge1xuICBzZWN0aW9uczogTWFwPHN0cmluZywgU2V0dGluZ3NTZWN0aW9uPjtcbiAgc2VjdGlvblRva2VuczogTWFwPHN0cmluZywgc3ltYm9sPjtcbiAgcGFnZXM6IE1hcDxzdHJpbmcsIFJlZ2lzdGVyZWRQYWdlPjtcbiAgbGlzdGVkVHdlYWtzOiBMaXN0ZWRUd2Vha1tdO1xuICAvKiogT3V0ZXIgd3JhcHBlciB0aGF0IGhvbGRzIENvZGV4J3MgaXRlbXMgZ3JvdXAgKyBvdXIgaW5qZWN0ZWQgZ3JvdXBzLiAqL1xuICBvdXRlcldyYXBwZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIkdlbmVyYWxcIiBsYWJlbCBmb3IgQ29kZXgncyBuYXRpdmUgc2V0dGluZ3MgZ3JvdXAuICovXG4gIG5hdGl2ZU5hdkhlYWRlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiVHdlYWtlcnNcIiBuYXYgZ3JvdXAgKENvbmZpZy9Ud2Vha3MpLiAqL1xuICBuYXZHcm91cDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBuYXZCdXR0b25zOiBQYXJ0aWFsPFJlY29yZDxCdWlsdGluUGFnZSwgSFRNTEJ1dHRvbkVsZW1lbnQ+PiB8IG51bGw7XG4gIC8qKiBTaWRlYmFyIHVwZGF0ZSBwaWxsIHNob3duIG9ubHkgd2hlbiBHaXRIdWIgaGFzIGEgbmV3ZXIgVHdlYWtlcnMgcmVsZWFzZS4gKi9cbiAgdHdlYWtlclVwZGF0ZUJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiVHdlYWtzXCIgbmF2IGdyb3VwIChwZXItdHdlYWsgcGFnZXMpLiBDcmVhdGVkIGxhemlseS4gKi9cbiAgcGFnZXNHcm91cDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBwYWdlc0dyb3VwS2V5OiBzdHJpbmcgfCBudWxsO1xuICBwYWdlTmF2QnV0dG9uczogTWFwPHN0cmluZywgSFRNTEJ1dHRvbkVsZW1lbnQ+O1xuICBwYW5lbEhvc3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgb2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsO1xuICBmaW5nZXJwcmludDogc3RyaW5nIHwgbnVsbDtcbiAgc2lkZWJhckR1bXBlZDogYm9vbGVhbjtcbiAgYWN0aXZlUGFnZTogQWN0aXZlUGFnZSB8IG51bGw7XG4gIHNpZGViYXJSb290OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHNpZGViYXJSZXN0b3JlSGFuZGxlcjogKChlOiBFdmVudCkgPT4gdm9pZCkgfCBudWxsO1xuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBib29sZWFuO1xuICBzZXR0aW5nc1N1cmZhY2VIaWRlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbDtcbiAgdHdlYWtTdG9yZTogVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB8IG51bGw7XG4gIHR3ZWFrU3RvcmVQcm9taXNlOiBQcm9taXNlPFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXc+IHwgbnVsbDtcbiAgdHdlYWtTdG9yZUVycm9yOiB1bmtub3duO1xuICB0d2Vha3NQYWdlRmlsdGVyOiBUd2Vha3NQYWdlRmlsdGVyO1xuICB0d2Vha3NQYWdlUXVlcnk6IHN0cmluZztcbn1cblxuY29uc3Qgc3RhdGU6IEluamVjdG9yU3RhdGUgPSB7XG4gIHNlY3Rpb25zOiBuZXcgTWFwKCksXG4gIHNlY3Rpb25Ub2tlbnM6IG5ldyBNYXAoKSxcbiAgcGFnZXM6IG5ldyBNYXAoKSxcbiAgbGlzdGVkVHdlYWtzOiBbXSxcbiAgb3V0ZXJXcmFwcGVyOiBudWxsLFxuICBuYXRpdmVOYXZIZWFkZXI6IG51bGwsXG4gIG5hdkdyb3VwOiBudWxsLFxuICBuYXZCdXR0b25zOiBudWxsLFxuICB0d2Vha2VyVXBkYXRlQnV0dG9uOiBudWxsLFxuICBwYWdlc0dyb3VwOiBudWxsLFxuICBwYWdlc0dyb3VwS2V5OiBudWxsLFxuICBwYWdlTmF2QnV0dG9uczogbmV3IE1hcCgpLFxuICBwYW5lbEhvc3Q6IG51bGwsXG4gIG9ic2VydmVyOiBudWxsLFxuICBmaW5nZXJwcmludDogbnVsbCxcbiAgc2lkZWJhckR1bXBlZDogZmFsc2UsXG4gIGFjdGl2ZVBhZ2U6IG51bGwsXG4gIHNpZGViYXJSb290OiBudWxsLFxuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6IG51bGwsXG4gIHNldHRpbmdzU3VyZmFjZVZpc2libGU6IGZhbHNlLFxuICBzZXR0aW5nc1N1cmZhY2VIaWRlVGltZXI6IG51bGwsXG4gIHR3ZWFrU3RvcmU6IG51bGwsXG4gIHR3ZWFrU3RvcmVQcm9taXNlOiBudWxsLFxuICB0d2Vha1N0b3JlRXJyb3I6IG51bGwsXG4gIHR3ZWFrc1BhZ2VGaWx0ZXI6IFwiYWxsXCIsXG4gIHR3ZWFrc1BhZ2VRdWVyeTogXCJcIixcbn07XG5cbmxldCBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXA6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBwbG9nKG1zZzogc3RyaW5nLCBleHRyYT86IHVua25vd24pOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcInR3ZWFrZXI6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgW3NldHRpbmdzLWluamVjdG9yXSAke21zZ30ke2V4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKX1gLFxuICApO1xufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5vYnNlcnZlcikgcmV0dXJuO1xuXG4gIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgfSk7XG4gIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIHN0YXRlLm9ic2VydmVyID0gb2JzO1xuXG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9wc3RhdGVcIiwgb25OYXYpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcImhhc2hjaGFuZ2VcIiwgb25OYXYpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25Eb2N1bWVudENsaWNrLCB0cnVlKTtcbiAgZm9yIChjb25zdCBtIG9mIFtcInB1c2hTdGF0ZVwiLCBcInJlcGxhY2VTdGF0ZVwiXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9yaWcgPSBoaXN0b3J5W21dO1xuICAgIGhpc3RvcnlbbV0gPSBmdW5jdGlvbiAodGhpczogSGlzdG9yeSwgLi4uYXJnczogUGFyYW1ldGVyczx0eXBlb2Ygb3JpZz4pIHtcbiAgICAgIGNvbnN0IHIgPSBvcmlnLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KGB0d2Vha2VyLSR7bX1gKSk7XG4gICAgICByZXR1cm4gcjtcbiAgICB9IGFzIHR5cGVvZiBvcmlnO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKGB0d2Vha2VyLSR7bX1gLCBvbk5hdik7XG4gIH1cblxuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG4gIGxldCB0aWNrcyA9IDA7XG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHRpY2tzKys7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gICAgaWYgKHRpY2tzID4gNjApIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICB9LCA1MDApO1xufVxuXG5mdW5jdGlvbiBvbk5hdigpOiB2b2lkIHtcbiAgc3RhdGUuZmluZ2VycHJpbnQgPSBudWxsO1xuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG59XG5cbmZ1bmN0aW9uIG9uRG9jdW1lbnRDbGljayhlOiBNb3VzZUV2ZW50KTogdm9pZCB7XG4gIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCA/IGUudGFyZ2V0IDogbnVsbDtcbiAgY29uc3QgY29udHJvbCA9IHRhcmdldD8uY2xvc2VzdChcIltyb2xlPSdsaW5rJ10sYnV0dG9uLGFcIik7XG4gIGlmICghKGNvbnRyb2wgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIHJldHVybjtcbiAgaWYgKGNvbXBhY3RTZXR0aW5nc1RleHQoY29udHJvbC50ZXh0Q29udGVudCB8fCBcIlwiKSAhPT0gXCJCYWNrIHRvIGFwcFwiKSByZXR1cm47XG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUoZmFsc2UsIFwiYmFjay10by1hcHBcIik7XG4gIH0sIDApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTZWN0aW9uKHNlY3Rpb246IFNldHRpbmdzU2VjdGlvbik6IFNldHRpbmdzSGFuZGxlIHtcbiAgY29uc3QgcmVnaXN0cmF0aW9uVG9rZW4gPSBTeW1ib2woc2VjdGlvbi5pZCk7XG4gIHN0YXRlLnNlY3Rpb25zLnNldChzZWN0aW9uLmlkLCBzZWN0aW9uKTtcbiAgc3RhdGUuc2VjdGlvblRva2Vucy5zZXQoc2VjdGlvbi5pZCwgcmVnaXN0cmF0aW9uVG9rZW4pO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBpZiAoc3RhdGUuc2VjdGlvblRva2Vucy5nZXQoc2VjdGlvbi5pZCkgIT09IHJlZ2lzdHJhdGlvblRva2VuKSByZXR1cm47XG4gICAgICBzdGF0ZS5zZWN0aW9ucy5kZWxldGUoc2VjdGlvbi5pZCk7XG4gICAgICBzdGF0ZS5zZWN0aW9uVG9rZW5zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICBzdGF0ZS5zZWN0aW9uVG9rZW5zLmNsZWFyKCk7XG4gIC8vIERyb3AgcmVnaXN0ZXJlZCBwYWdlcyB0b28gXHUyMDE0IHRoZXkncmUgb3duZWQgYnkgdHdlYWtzIHRoYXQganVzdCBnb3RcbiAgLy8gdG9ybiBkb3duIGJ5IHRoZSBob3N0LiBSdW4gYW55IHRlYXJkb3ducyBiZWZvcmUgZm9yZ2V0dGluZyB0aGVtLlxuICBmb3IgKGNvbnN0IHAgb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICB0cnkge1xuICAgICAgcC50ZWFyZG93bj8uKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGxvZyhcInBhZ2UgdGVhcmRvd24gZmFpbGVkXCIsIHsgaWQ6IHAuaWQsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5wYWdlcy5jbGVhcigpO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICAvLyBFeHBsaWNpdCBwYWdlcyBtYXkgZGlzYXBwZWFyIGJyaWVmbHkgZHVyaW5nIGEgaG90IHJlbG9hZC4gS2VlcCB0aGUgc3RhYmxlXG4gIC8vIHR3ZWFrLWxldmVsIHBhZ2UgYWN0aXZlIGFuZCByZW5kZXIgaXRzIGZhbGxiYWNrIGluc3RlYWQgb2YgZWplY3RpbmcgdGhlXG4gIC8vIHVzZXIgZnJvbSBTZXR0aW5ncy5cbiAgaWYgKFxuICAgIHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmXG4gICAgIXNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oc3RhdGUuYWN0aXZlUGFnZS5pZClcbiAgKSB7XG4gICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZXhpc3RpbmcgPSBzdGF0ZS5wYWdlcy5nZXQoaWQpO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICB0cnkgeyBleGlzdGluZy50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCByZWdpc3RyYXRpb25Ub2tlbiA9IFN5bWJvbChpZCk7XG4gIGNvbnN0IGVudHJ5OiBSZWdpc3RlcmVkUGFnZSA9IHsgaWQsIHR3ZWFrSWQsIG1hbmlmZXN0LCBwYWdlLCByZWdpc3RyYXRpb25Ub2tlbiB9O1xuICBzdGF0ZS5wYWdlcy5zZXQoaWQsIGVudHJ5KTtcbiAgcGxvZyhcInJlZ2lzdGVyUGFnZVwiLCB7IGlkLCB0aXRsZTogcGFnZS50aXRsZSwgdHdlYWtJZCB9KTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgdGhlIHVzZXIgd2FzIGFscmVhZHkgb24gdGhpcyBwYWdlIChob3QgcmVsb2FkKSwgcmUtbW91bnQgaXRzIGJvZHkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSB0d2Vha0lkKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIGNvbnN0IGUgPSBzdGF0ZS5wYWdlcy5nZXQoaWQpO1xuICAgICAgaWYgKCFlIHx8IGUucmVnaXN0cmF0aW9uVG9rZW4gIT09IHJlZ2lzdHJhdGlvblRva2VuKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBlLnRlYXJkb3duPy4oKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICAgIHN0YXRlLnBhZ2VzLmRlbGV0ZShpZCk7XG4gICAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IHR3ZWFrSWQpIHJlcmVuZGVyKCk7XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIENhbGxlZCBieSB0aGUgdHdlYWsgaG9zdCBhZnRlciBmZXRjaGluZyB0aGUgdHdlYWsgbGlzdCBmcm9tIG1haW4uICovXG5leHBvcnQgZnVuY3Rpb24gc2V0TGlzdGVkVHdlYWtzKGxpc3Q6IExpc3RlZFR3ZWFrW10pOiB2b2lkIHtcbiAgc3RhdGUubGlzdGVkVHdlYWtzID0gbGlzdDtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmICFzZXR0aW5nc05hdmlnYXRpb25JdGVtKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpKSB7XG4gICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUxpc3RlZFR3ZWFrTGlmZWN5Y2xlKGlkOiBzdHJpbmcsIGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtcImxpZmVjeWNsZVwiXSwgZXJyb3I/OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdHdlYWsgPSBzdGF0ZS5saXN0ZWRUd2Vha3MuZmluZCgoaXRlbSkgPT4gaXRlbS5tYW5pZmVzdC5pZCA9PT0gaWQpO1xuICBpZiAoIXR3ZWFrKSByZXR1cm47XG4gIHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlID0gbGlmZWN5Y2xlO1xuICBpZiAoZXJyb3IpIHR3ZWFrLmhlYWx0aCA9IHsgc3RhdHVzOiBsaWZlY3ljbGUgPT09IFwicXVhcmFudGluZWRcIiA/IFwicXVhcmFudGluZWRcIiA6IFwiZmFpbGVkXCIsIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBlcnJvciB9O1xuICBlbHNlIGlmIChsaWZlY3ljbGUgPT09IFwic3RhcnRpbmdcIiB8fCBsaWZlY3ljbGUgPT09IFwiZW5hYmxlZFwiKSB0d2Vhay5oZWFsdGggPSBudWxsO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHJlcmVuZGVyKCk7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzTmF2aWdhdGlvbkl0ZW1zKCk6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSB7XG4gIHJldHVybiBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsKFxuICAgIHN0YXRlLmxpc3RlZFR3ZWFrcy5tYXAoKHR3ZWFrKSA9PiAoe1xuICAgICAgaWQ6IHR3ZWFrLm1hbmlmZXN0LmlkLFxuICAgICAgbmFtZTogdHdlYWsubWFuaWZlc3QubmFtZSxcbiAgICAgIHZlcnNpb246IHR3ZWFrLm1hbmlmZXN0LnZlcnNpb24sXG4gICAgICBkZXNjcmlwdGlvbjogdHdlYWsubWFuaWZlc3QuZGVzY3JpcHRpb24sXG4gICAgICBpY29uVXJsOiB0d2Vhay5tYW5pZmVzdC5pY29uVXJsLFxuICAgICAgZW5hYmxlZDogdHdlYWsuZW5hYmxlZCxcbiAgICAgIHN0YXR1czogdHdlYWsuc3RhdHVzLFxuICAgICAgaGVhbHRoRXJyb3I6IHR3ZWFrLmhlYWx0aD8uZXJyb3IgPz8gbnVsbCxcbiAgICAgIGxpZmVjeWNsZU92ZXJyaWRlOiB0d2Vhay5saWZlY3ljbGVPdmVycmlkZSxcbiAgICB9KSksXG4gICAgWy4uLnN0YXRlLnBhZ2VzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgaWQ6IGVudHJ5LmlkLFxuICAgICAgdHdlYWtJZDogZW50cnkudHdlYWtJZCxcbiAgICAgIHRpdGxlOiBlbnRyeS5wYWdlLnRpdGxlLFxuICAgICAgZGVzY3JpcHRpb246IGVudHJ5LnBhZ2UuZGVzY3JpcHRpb24sXG4gICAgICBpY29uU3ZnOiBlbnRyeS5wYWdlLmljb25TdmcsXG4gICAgfSkpLFxuICApO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nc05hdmlnYXRpb25JdGVtKHR3ZWFrSWQ6IHN0cmluZyk6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0gfCBudWxsIHtcbiAgcmV0dXJuIHNldHRpbmdzTmF2aWdhdGlvbkl0ZW1zKCkuZmluZCgoaXRlbSkgPT4gaXRlbS50d2Vha0lkID09PSB0d2Vha0lkKSA/PyBudWxsO1xufVxuXG5mdW5jdGlvbiByZWdpc3RlcmVkUGFnZXNGb3JUd2Vhayh0d2Vha0lkOiBzdHJpbmcpOiBSZWdpc3RlcmVkUGFnZVtdIHtcbiAgcmV0dXJuIFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV0uZmlsdGVyKChlbnRyeSkgPT4gZW50cnkudHdlYWtJZCA9PT0gdHdlYWtJZCk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUxhYmVsKGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtcImxpZmVjeWNsZVwiXSwgd2FybmluZz86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCBsYWJlbCA9IGxpZmVjeWNsZSA9PT0gXCJlbmFibGVkXCIgPyBcIlJ1bm5pbmdcIlxuICAgIDogbGlmZWN5Y2xlID09PSBcInRpbWVkX291dFwiID8gXCJTdGFydHVwIHRpbWVkIG91dFwiXG4gICAgOiBsaWZlY3ljbGVbMF0udG9VcHBlckNhc2UoKSArIGxpZmVjeWNsZS5zbGljZSgxKTtcbiAgcmV0dXJuIHdhcm5pbmcgPyBgJHtsYWJlbH06ICR7d2FybmluZ31gIDogbGFiZWw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpbmplY3Rpb24gXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHRyeUluamVjdCgpOiB2b2lkIHtcbiAgaWYgKGlzTmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkKCkpIHJldHVybjtcbiAgcmVtb3ZlTWlzcGxhY2VkU2V0dGluZ3NHcm91cHMoKTtcblxuICBjb25zdCBpdGVtc0dyb3VwID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghaXRlbXNHcm91cCkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgcGxvZyhcInNpZGViYXIgbm90IGZvdW5kXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyKSB7XG4gICAgY2xlYXJUaW1lb3V0KHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcik7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgfVxuICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKHRydWUsIFwic2lkZWJhci1mb3VuZFwiKTtcbiAgLy8gS2VlcCBuYXRpdmUgYW5kIFR3ZWFrZXJzIGVudHJpZXMgaW4gdGhlIHNhbWUgc2Nyb2xsIGNvbnRhaW5lci4gQXBwZW5kaW5nXG4gIC8vIHRvIHRoZSBwYXJlbnQgY3JlYXRlZCBhIHNlY29uZCBpbmRlcGVuZGVudGx5IHNjcm9sbGluZyBzaWRlYmFyIHJlZ2lvbi5cbiAgY29uc3Qgb3V0ZXIgPSBpdGVtc0dyb3VwO1xuICBpZiAoIWlzU2V0dGluZ3NTaWRlYmFyQ2FuZGlkYXRlKGl0ZW1zR3JvdXApKSB7XG4gICAgc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTtcbiAgICBwbG9nKFwicmVqZWN0ZWQgbm9uLXNldHRpbmdzIHNpZGViYXIgY2FuZGlkYXRlXCIsIHtcbiAgICAgIGl0ZW1zR3JvdXA6IGRlc2NyaWJlKGl0ZW1zR3JvdXApLFxuICAgICAgb3V0ZXI6IGRlc2NyaWJlKG91dGVyKSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcbiAgYmluZFNldHRpbmdzU2VhcmNoKG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICBjb25zdCBleGlzdGluZ1R3ZWFrZXJOYXZHcm91cCA9XG4gICAgb3V0ZXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJzpzY29wZSA+IFtkYXRhLXR3ZWFrZXI9XCJuYXYtZ3JvdXBcIl0nKSA/P1xuICAgIG91dGVyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS10d2Vha2VyPVwibmF2LWdyb3VwXCJdJyk7XG5cbiAgaWYgKGV4aXN0aW5nVHdlYWtlck5hdkdyb3VwKSB7XG4gICAgc3RhdGUubmF2R3JvdXAgPSBleGlzdGluZ1R3ZWFrZXJOYXZHcm91cDtcbiAgICBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uID0gZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXAucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXG4gICAgICBcIltkYXRhLXR3ZWFrZXItc2lkZWJhci11cGRhdGVdXCIsXG4gICAgKTtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG91dGVyO1xuICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKCk7XG4gICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwpIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZSh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQudHdlYWtlciA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBjb25zdCB1cGRhdGVCdXR0b24gPSBzaWRlYmFyVXBkYXRlUGlsbEJ1dHRvbigpO1xuICBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uID0gdXBkYXRlQnV0dG9uO1xuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJUd2Vha2Vyc1wiLCBcInB0LTNcIiwgdXBkYXRlQnV0dG9uKSk7XG4gIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbigpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgdHdlYWtzQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiVHdlYWtzXCIsIHR3ZWFrc0ljb25TdmcoKSk7XG5cbiAgY29uZmlnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwiY29uZmlnXCIgfSk7XG4gIH0pO1xuICB0d2Vha3NCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJ0d2Vha3NcIiB9KTtcbiAgfSk7XG4gIGdyb3VwLmFwcGVuZENoaWxkKGNvbmZpZ0J0bik7XG4gIGdyb3VwLmFwcGVuZENoaWxkKHR3ZWFrc0J0bik7XG4gIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcblxuICBzdGF0ZS5uYXZHcm91cCA9IGdyb3VwO1xuICBzdGF0ZS5uYXZCdXR0b25zID0geyBjb25maWc6IGNvbmZpZ0J0biwgdHdlYWtzOiB0d2Vha3NCdG4gfTtcbiAgbm90ZU5hdkdyb3VwSW5qZWN0aW9uKG91dGVyKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbn1cblxuLy8gQmFja3N0b3AgYWdhaW5zdCBpbmplY3QvcmVtb3ZlIGZlZWRiYWNrIGxvb3BzOiBpZiB0aGUgbmF2IGdyb3VwIG5lZWRzXG4vLyByZS1pbmplY3Rpb24gbW9yZSB0aGFuIGEgZmV3IHRpbWVzIGluIGEgc2hvcnQgd2luZG93LCBzb21ldGhpbmcgaXNcbi8vIGZpZ2h0aW5nIHVzIFx1MjAxNCBiYWNrIG9mZiBpbnN0ZWFkIG9mIHNhdHVyYXRpbmcgdGhlIGxvZyBhbmQgdGhlIENQVS5cbmNvbnN0IE5BVl9HUk9VUF9JTkpFQ1RJT05fV0lORE9XX01TID0gMTBfMDAwO1xuY29uc3QgTkFWX0dST1VQX0lOSkVDVElPTl9MSU1JVCA9IDU7XG5jb25zdCBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVMgPSAzMF8wMDA7XG5sZXQgbmF2R3JvdXBJbmplY3Rpb25zOiBudW1iZXJbXSA9IFtdO1xubGV0IG5hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZFVudGlsID0gMDtcblxuZnVuY3Rpb24gaXNOYXZHcm91cEluamVjdGlvblN1cHByZXNzZWQoKTogYm9vbGVhbiB7XG4gIHJldHVybiBEYXRlLm5vdygpIDwgbmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkVW50aWw7XG59XG5cbmZ1bmN0aW9uIG5vdGVOYXZHcm91cEluamVjdGlvbihvdXRlcjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgbmF2R3JvdXBJbmplY3Rpb25zID0gbmF2R3JvdXBJbmplY3Rpb25zLmZpbHRlcigoYXQpID0+IG5vdyAtIGF0IDwgTkFWX0dST1VQX0lOSkVDVElPTl9XSU5ET1dfTVMpO1xuICBuYXZHcm91cEluamVjdGlvbnMucHVzaChub3cpO1xuICBpZiAobmF2R3JvdXBJbmplY3Rpb25zLmxlbmd0aCA+IE5BVl9HUk9VUF9JTkpFQ1RJT05fTElNSVQpIHtcbiAgICBuYXZHcm91cEluamVjdGlvblN1cHByZXNzZWRVbnRpbCA9IG5vdyArIE5BVl9HUk9VUF9JTkpFQ1RJT05fQkFDS09GRl9NUztcbiAgICBuYXZHcm91cEluamVjdGlvbnMgPSBbXTtcbiAgICBwbG9nKFwibmF2IGdyb3VwIHJlLWluamVjdGlvbiBsb29wIGRldGVjdGVkOyBiYWNraW5nIG9mZlwiLCB7XG4gICAgICBiYWNrb2ZmTXM6IE5BVl9HUk9VUF9JTkpFQ1RJT05fQkFDS09GRl9NUyxcbiAgICAgIG91dGVyVGFnOiBvdXRlci50YWdOYW1lLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuXG4gIGNvbnN0IGhlYWRlciA9IHNpZGViYXJHcm91cEhlYWRlcihcIkdlbmVyYWxcIik7XG4gIGhlYWRlci5kYXRhc2V0LnR3ZWFrZXIgPSBcIm5hdGl2ZS1uYXYtaGVhZGVyXCI7XG4gIGlmIChvdXRlciA9PT0gaXRlbXNHcm91cCkgb3V0ZXIucHJlcGVuZChoZWFkZXIpO1xuICBlbHNlIG91dGVyLmluc2VydEJlZm9yZShoZWFkZXIsIGl0ZW1zR3JvdXApO1xuICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIGJpbmRTZXR0aW5nc1NlYXJjaChyb290OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBpbnB1dCA9IHJvb3QuY2xvc2VzdChcImFzaWRlLCBuYXYsIFtyb2xlPSduYXZpZ2F0aW9uJ10sIGRpdlwiKT8ucGFyZW50RWxlbWVudFxuICAgID8ucXVlcnlTZWxlY3RvcjxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W3BsYWNlaG9sZGVyKj0nU2VhcmNoIHNldHRpbmdzJyBpXVwiKVxuICAgID8/IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtwbGFjZWhvbGRlcio9J1NlYXJjaCBzZXR0aW5ncycgaV1cIik7XG4gIGlmICghaW5wdXQgfHwgaW5wdXQuZGF0YXNldC50d2Vha2Vyc1NlYXJjaEJvdW5kID09PSBcInRydWVcIikgcmV0dXJuO1xuICBpbnB1dC5kYXRhc2V0LnR3ZWFrZXJzU2VhcmNoQm91bmQgPSBcInRydWVcIjtcbiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCBxdWVyeSA9IGlucHV0LnZhbHVlLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgpO1xuICAgIGZvciAoY29uc3QgYnV0dG9uIG9mIEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSkpIHtcbiAgICAgIGlmICghYnV0dG9uLmNsb3Nlc3QoXCJbZGF0YS10d2Vha2VyXVwiKSkgY29udGludWU7XG4gICAgICBidXR0b24uaGlkZGVuID0gISFxdWVyeSAmJiAhY29tcGFjdFNldHRpbmdzVGV4dChidXR0b24udGV4dENvbnRlbnQgPz8gXCJcIikudG9Mb2NhbGVMb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlcj0nbmF2LWdyb3VwJ10sIFtkYXRhLXR3ZWFrZXI9J3BhZ2VzLWdyb3VwJ11cIikpKSB7XG4gICAgICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShncm91cC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gICAgICBncm91cC5oaWRkZW4gPSBidXR0b25zLmxlbmd0aCA+IDAgJiYgYnV0dG9ucy5ldmVyeSgoYnV0dG9uKSA9PiBidXR0b24uaGlkZGVuKTtcbiAgICB9XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIHRleHQtWzExcHhdIGZvbnQtbWVkaXVtIHVwcGVyY2FzZSB0cmFja2luZy13aWRlciB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgc2VsZWN0LW5vbmVgO1xuICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBsYWJlbC5jbGFzc05hbWUgPSBcInRydW5jYXRlXCI7XG4gIGxhYmVsLnRleHRDb250ZW50ID0gdGV4dDtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGxhYmVsKTtcbiAgaWYgKHRyYWlsaW5nKSBoZWFkZXIuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICByZXR1cm4gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlIHx8IHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICAgIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgICBpZiAoc2lkZWJhciAmJiBpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShzaWRlYmFyKSkgcmV0dXJuO1xuICAgIGlmIChpc1NldHRpbmdzVGV4dFZpc2libGUoKSkgcmV0dXJuO1xuICAgIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUoZmFsc2UsIFwic2lkZWJhci1ub3QtZm91bmRcIik7XG4gIH0sIDE1MDApO1xufVxuXG5mdW5jdGlvbiBpc1NldHRpbmdzVGV4dFZpc2libGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc1R3ZWFrZXJTZXR0aW5nc0xhYmVsU2V0KHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oZG9jdW1lbnQpKTtcbn1cblxuZnVuY3Rpb24gY29tcGFjdFNldHRpbmdzVGV4dCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG59XG5cbmNvbnN0IFRXRUFLRVJfQ09SRV9TRVRUSU5HU19MQUJFTFMgPSBbXG4gIFwiR2VuZXJhbFwiLFxuICBcIlx1NUUzOFx1ODlDNFwiLFxuICBcIlx1OTAxQVx1NzUyOFwiLFxuICBcIkFwcGVhcmFuY2VcIixcbiAgXCJcdTU5MTZcdTg5QzJcIixcbiAgXCJDb25maWd1cmF0aW9uXCIsXG4gIFwiXHU5MTREXHU3RjZFXCIsXG4gIFwiXHU5RUQ4XHU4QkE0XHU2NzQzXHU5NjUwXCIsXG4gIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gIFwiXHU0RTJBXHU2MDI3XHU1MzE2XCIsXG5dLm1hcChub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCk7XG5cbmNvbnN0IFRXRUFLRVJfRVhURU5ERURfU0VUVElOR1NfTEFCRUxTID0gW1xuICBcIkFjY291bnRcIixcbiAgXCJcdThEMjZcdTYyMzdcIixcbiAgXCJcdThEMjZcdTUzRjdcIixcbiAgXCJHZW5lcmFsXCIsXG4gIFwiXHU1RTM4XHU4OUM0XCIsXG4gIFwiXHU5MDFBXHU3NTI4XCIsXG4gIFwiQXBwZWFyYW5jZVwiLFxuICBcIlx1NTkxNlx1ODlDMlwiLFxuICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgXCJcdTkxNERcdTdGNkVcIixcbiAgXCJcdTlFRDhcdThCQTRcdTY3NDNcdTk2NTBcIixcbiAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgXCJcdTRFMkFcdTYwMjdcdTUzMTZcIixcbiAgXCJLZXlib2FyZCBzaG9ydGN1dHNcIixcbiAgXCJBcmNoaXZlZCBjaGF0c1wiLFxuICBcIlVzYWdlXCIsXG4gIFwiQ29tcHV0ZXIgdXNlXCIsXG4gIFwiQnJvd3NlciB1c2VcIixcbiAgXCJNQ1Agc2VydmVyc1wiLFxuICBcIk1DUCBTZXJ2ZXJzXCIsXG4gIFwiTUNQIFx1NjcwRFx1NTJBMVx1NTY2OFwiLFxuICBcIkdpdFwiLFxuICBcIkVudmlyb25tZW50c1wiLFxuICBcIlx1NzNBRlx1NTg4M1wiLFxuICBcIkNsb3VkIEVudmlyb25tZW50c1wiLFxuICBcIldvcmt0cmVlc1wiLFxuICBcIkNvbm5lY3Rpb25zXCIsXG4gIFwiUGx1Z2luc1wiLFxuICBcIlNraWxsc1wiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5jb25zdCBUV0VBS0VSX1NFVFRJTkdTX09OTFlfTEFCRUxTID0gW1xuICBcIkdlbmVyYWxcIixcbiAgXCJcdTVFMzhcdTg5QzRcIixcbiAgXCJcdTkwMUFcdTc1MjhcIixcbiAgXCJBcHBlYXJhbmNlXCIsXG4gIFwiXHU1OTE2XHU4OUMyXCIsXG4gIFwiQ29uZmlndXJhdGlvblwiLFxuICBcIlx1OTE0RFx1N0Y2RVwiLFxuICBcIlx1OUVEOFx1OEJBNFx1Njc0M1x1OTY1MFwiLFxuICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICBcIlx1NEUyQVx1NjAyN1x1NTMxNlwiLFxuICBcIktleWJvYXJkIHNob3J0Y3V0c1wiLFxuICBcIkFyY2hpdmVkIGNoYXRzXCIsXG4gIFwiVXNhZ2VcIixcbiAgXCJDb21wdXRlciB1c2VcIixcbiAgXCJCcm93c2VyIHVzZVwiLFxuICBcIk1DUCBzZXJ2ZXJzXCIsXG4gIFwiTUNQIFNlcnZlcnNcIixcbiAgXCJNQ1AgXHU2NzBEXHU1MkExXHU1NjY4XCIsXG4gIFwiR2l0XCIsXG4gIFwiRW52aXJvbm1lbnRzXCIsXG4gIFwiXHU3M0FGXHU1ODgzXCIsXG4gIFwiQ2xvdWQgRW52aXJvbm1lbnRzXCIsXG4gIFwiV29ya3RyZWVzXCIsXG4gIFwiQ29ubmVjdGlvbnNcIixcbl0ubWFwKG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKTtcblxuY29uc3QgVFdFQUtFUl9NQUlOX0FQUF9OQVZfTEFCRUxTID0gW1xuICBcIk5ldyBjaGF0XCIsXG4gIFwiUXVpY2sgY2hhdFwiLFxuICBcIlx1NUZFQlx1OTAxRlx1NUJGOVx1OEJERFwiLFxuICBcIlNlYXJjaFwiLFxuICBcIlx1NjQxQ1x1N0QyMlwiLFxuICBcIlBsdWdpbnNcIixcbiAgXCJcdTYzRDJcdTRFRjZcIixcbiAgXCJBdXRvbWF0aW9uc1wiLFxuICBcIkF1dG9tYXRpb25cIixcbiAgXCJcdTgxRUFcdTUyQThcdTUzMTZcIixcbiAgXCJDaGF0c1wiLFxuICBcIkNoYXRcIixcbiAgXCJcdTVCRjlcdThCRERcIixcbiAgXCJQcm9qZWN0c1wiLFxuICBcIlx1OTg3OVx1NzZFRVwiLFxuICBcIlBpbm5lZFwiLFxuICBcIlNldHRpbmdzXCIsXG4gIFwiXHU4QkJFXHU3RjZFXCIsXG4gIFwiV29yayBsb2NhbGx5XCIsXG5dLm1hcChub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gY29tcGFjdFNldHRpbmdzVGV4dCh2YWx1ZSlcbiAgICAudG9Mb2NhbGVMb3dlckNhc2UoKVxuICAgIC5ub3JtYWxpemUoXCJORkRcIilcbiAgICAucmVwbGFjZSgvW1xcdTAzMDAtXFx1MDM2Zl0vZywgXCJcIilcbiAgICAucmVwbGFjZSgvW1x1MjAxOVx1MjAxOGBcdTAwQjRdL2csIFwiJ1wiKVxuICAgIC5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKVxuICAgIC50cmltKCk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJDb250cm9sTGFiZWwoZWw6IEhUTUxFbGVtZW50KTogc3RyaW5nIHtcbiAgcmV0dXJuIG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKFxuICAgIGVsLmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgfHxcbiAgICAgIGVsLmdldEF0dHJpYnV0ZShcInRpdGxlXCIpIHx8XG4gICAgICBlbC50ZXh0Q29udGVudCB8fFxuICAgICAgXCJcIixcbiAgKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlclNldHRpbmdzTGFiZWxzRnJvbShyb290OiBQYXJlbnROb2RlKTogc3RyaW5nW10ge1xuICBjb25zdCBjb250cm9scyA9IEFycmF5LmZyb20oXG4gICAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcImJ1dHRvbixhLFtyb2xlPSdidXR0b24nXSxbcm9sZT0nbGluayddXCIpLFxuICApO1xuXG4gIHJldHVybiBbXG4gICAgLi4ubmV3IFNldChcbiAgICAgIGNvbnRyb2xzXG4gICAgICAgIC5tYXAodHdlYWtlckNvbnRyb2xMYWJlbClcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICApLFxuICBdO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyU2V0dGluZ3NMYWJlbFNjb3JlKGxhYmVsczogc3RyaW5nW10pOiB7IGNvcmU6IG51bWJlcjsgdG90YWw6IG51bWJlciB9IHtcbiAgY29uc3QgY29yZSA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCB0b3RhbCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGZvciAoY29uc3QgbGFiZWwgb2YgbGFiZWxzKSB7XG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgVFdFQUtFUl9DT1JFX1NFVFRJTkdTX0xBQkVMUykge1xuICAgICAgaWYgKHR3ZWFrZXJMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWwsIG1hcmtlcikpIGNvcmUuYWRkKG1hcmtlcik7XG4gICAgfVxuXG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgVFdFQUtFUl9FWFRFTkRFRF9TRVRUSU5HU19MQUJFTFMpIHtcbiAgICAgIGlmICh0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsLCBtYXJrZXIpKSB0b3RhbC5hZGQobWFya2VyKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4geyBjb3JlOiBjb3JlLnNpemUsIHRvdGFsOiB0b3RhbC5zaXplIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWw6IHN0cmluZywgbWFya2VyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGxhYmVsID09PSBtYXJrZXIgfHwgbGFiZWwuaW5jbHVkZXMobWFya2VyKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlck1hcmtlckNvdW50KGxhYmVsczogc3RyaW5nW10sIG1hcmtlcnM6IHN0cmluZ1tdKTogbnVtYmVyIHtcbiAgY29uc3QgbWF0Y2hlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGxhYmVsIG9mIGxhYmVscykge1xuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIG1hcmtlcnMpIHtcbiAgICAgIGlmICh0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsLCBtYXJrZXIpKSBtYXRjaGVkLmFkZChtYXJrZXIpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbWF0Y2hlZC5zaXplO1xufVxuXG5mdW5jdGlvbiBoYXNUd2Vha2VyU2V0dGluZ3NPbmx5U2lnbmFsKGxhYmVsczogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgcmV0dXJuIHR3ZWFrZXJNYXJrZXJDb3VudChsYWJlbHMsIFRXRUFLRVJfU0VUVElOR1NfT05MWV9MQUJFTFMpID4gMDtcbn1cblxuZnVuY3Rpb24gaGFzTWFpbkFwcFNpZGViYXJTaWduYWxzKGxhYmVsczogc3RyaW5nW10pOiBib29sZWFuIHtcbiAgcmV0dXJuIHR3ZWFrZXJNYXJrZXJDb3VudChsYWJlbHMsIFRXRUFLRVJfTUFJTl9BUFBfTkFWX0xBQkVMUykgPj0gMjtcbn1cblxuZnVuY3Rpb24gaXNUd2Vha2VyU2V0dGluZ3NMYWJlbFNldChsYWJlbHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIGNvbnN0IHNjb3JlID0gdHdlYWtlclNldHRpbmdzTGFiZWxTY29yZShsYWJlbHMpO1xuICByZXR1cm4gc2NvcmUuY29yZSA+PSAyICYmIHNjb3JlLnRvdGFsID49IDM7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJWaXNpYmxlQm94KGVsOiBIVE1MRWxlbWVudCk6IERPTVJlY3QgfCBudWxsIHtcbiAgaWYgKCFlbC5pc0Nvbm5lY3RlZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHN0eWxlID0gZ2V0Q29tcHV0ZWRTdHlsZShlbCk7XG4gIGlmIChzdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIiB8fCBzdHlsZS52aXNpYmlsaXR5ID09PSBcImhpZGRlblwiKSByZXR1cm4gbnVsbDtcblxuICBjb25zdCByZWN0ID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gIGlmIChyZWN0LndpZHRoIDw9IDAgfHwgcmVjdC5oZWlnaHQgPD0gMCkgcmV0dXJuIG51bGw7XG4gIHJldHVybiByZWN0O1xufVxuXG5mdW5jdGlvbiBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4sIHJlYXNvbjogc3RyaW5nKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID09PSB2aXNpYmxlKSByZXR1cm47XG4gIHN0YXRlLnNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICBpZiAodmlzaWJsZSkgd2FybVR3ZWFrU3RvcmUoKTtcbiAgdHJ5IHtcbiAgICAod2luZG93IGFzIFdpbmRvdyAmIHsgX190d2Vha2VyU2V0dGluZ3NTdXJmYWNlVmlzaWJsZT86IGJvb2xlYW4gfSkuX190d2Vha2VyU2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9IHZpc2libGU7XG4gICAgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmRhdGFzZXQudHdlYWtlclNldHRpbmdzU3VyZmFjZSA9IHZpc2libGUgPyBcInRydWVcIiA6IFwiZmFsc2VcIjtcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChcbiAgICAgIG5ldyBDdXN0b21FdmVudChcInR3ZWFrZXI6c2V0dGluZ3Mtc3VyZmFjZVwiLCB7XG4gICAgICAgIGRldGFpbDogeyB2aXNpYmxlLCByZWFzb24gfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH0gY2F0Y2gge31cbiAgcGxvZyhcInNldHRpbmdzIHN1cmZhY2VcIiwgeyB2aXNpYmxlLCByZWFzb24sIHVybDogbG9jYXRpb24uaHJlZiB9KTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgKG9yIHJlLXJlbmRlcikgdGhlIHNlY29uZCBzaWRlYmFyIGdyb3VwIG9mIHBlci10d2VhayBwYWdlcy4gVGhlXG4gKiBncm91cCBpcyBjcmVhdGVkIGxhemlseSBhbmQgcmVtb3ZlZCB3aGVuIHRoZSBsYXN0IHBhZ2UgdW5yZWdpc3RlcnMsIHNvXG4gKiB1c2VycyB3aXRoIG5vIHBhZ2UtcmVnaXN0ZXJpbmcgdHdlYWtzIG5ldmVyIHNlZSBhbiBlbXB0eSBcIlR3ZWFrc1wiIGhlYWRlci5cbiAqL1xuZnVuY3Rpb24gc3luY1BhZ2VzR3JvdXAoKTogdm9pZCB7XG4gIGNvbnN0IG91dGVyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghb3V0ZXIpIHJldHVybjtcbiAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShvdXRlcikpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG51bGw7XG4gICAgc3RhdGUucGFnZXNHcm91cCA9IG51bGw7XG4gICAgc3RhdGUucGFnZXNHcm91cEtleSA9IG51bGw7XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgcGFnZXMgPSBzZXR0aW5nc05hdmlnYXRpb25JdGVtcygpO1xuXG4gIC8vIEJ1aWxkIGEgZGV0ZXJtaW5pc3RpYyBmaW5nZXJwcmludCBvZiB0aGUgZGVzaXJlZCBncm91cCBzdGF0ZS4gSWYgdGhlXG4gIC8vIGN1cnJlbnQgRE9NIGdyb3VwIGFscmVhZHkgbWF0Y2hlcywgdGhpcyBpcyBhIG5vLW9wIFx1MjAxNCBjcml0aWNhbCwgYmVjYXVzZVxuICAvLyBzeW5jUGFnZXNHcm91cCBpcyBjYWxsZWQgb24gZXZlcnkgTXV0YXRpb25PYnNlcnZlciB0aWNrIGFuZCBhbnkgRE9NXG4gIC8vIHdyaXRlIHdvdWxkIHJlLXRyaWdnZXIgdGhhdCBvYnNlcnZlciAoaW5maW5pdGUgbG9vcCwgYXBwIGZyZWV6ZSkuXG4gIGNvbnN0IGRlc2lyZWRLZXkgPSBwYWdlcy5sZW5ndGggPT09IDBcbiAgICA/IFwiRU1QVFlcIlxuICAgIDogcGFnZXMubWFwKChwKSA9PiBgJHtwLnR3ZWFrSWR9fCR7cC50aXRsZX18JHtwLmljb25TdmcgPz8gXCJcIn18JHtwLmxpZmVjeWNsZX1gKS5qb2luKFwiXFxuXCIpO1xuICBjb25zdCBncm91cEF0dGFjaGVkID0gISFzdGF0ZS5wYWdlc0dyb3VwICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLnBhZ2VzR3JvdXApO1xuICBpZiAoc3RhdGUucGFnZXNHcm91cEtleSA9PT0gZGVzaXJlZEtleSAmJiAocGFnZXMubGVuZ3RoID09PSAwID8gIWdyb3VwQXR0YWNoZWQgOiBncm91cEF0dGFjaGVkKSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChwYWdlcy5sZW5ndGggPT09IDApIHtcbiAgICBpZiAoc3RhdGUucGFnZXNHcm91cCkge1xuICAgICAgc3RhdGUucGFnZXNHcm91cC5yZW1vdmUoKTtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIH1cbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBkZXNpcmVkS2V5O1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBncm91cCA9IHN0YXRlLnBhZ2VzR3JvdXA7XG4gIGlmICghZ3JvdXAgfHwgIW91dGVyLmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIGdyb3VwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBncm91cC5kYXRhc2V0LnR3ZWFrZXIgPSBcInBhZ2VzLWdyb3VwXCI7XG4gICAgZ3JvdXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1weFwiO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKHNpZGViYXJHcm91cEhlYWRlcihcIlR3ZWFrc1wiLCBcInB0LTNcIikpO1xuICAgIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gZ3JvdXA7XG4gIH0gZWxzZSB7XG4gICAgLy8gU3RyaXAgcHJpb3IgYnV0dG9ucyAoa2VlcCB0aGUgaGVhZGVyIGF0IGluZGV4IDApLlxuICAgIHdoaWxlIChncm91cC5jaGlsZHJlbi5sZW5ndGggPiAxKSBncm91cC5yZW1vdmVDaGlsZChncm91cC5sYXN0Q2hpbGQhKTtcbiAgfVxuXG4gIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gIGZvciAoY29uc3QgcCBvZiBwYWdlcykge1xuICAgIGNvbnN0IGljb24gPSBwLmljb25TdmcgPz8gZGVmYXVsdFBhZ2VJY29uU3ZnKCk7XG4gICAgY29uc3QgYnRuID0gbWFrZVNpZGViYXJJdGVtKHAudGl0bGUsIGljb24pO1xuICAgIGJ0bi5kYXRhc2V0LnR3ZWFrZXIgPSBgbmF2LXBhZ2UtJHtwLnR3ZWFrSWR9YDtcbiAgICBidG4uZGF0YXNldC50d2Vha2VyTGlmZWN5Y2xlID0gcC5saWZlY3ljbGU7XG4gICAgaWYgKHAubGlmZWN5Y2xlICE9PSBcImVuYWJsZWRcIikgYnRuLnRpdGxlID0gbGlmZWN5Y2xlTGFiZWwocC5saWZlY3ljbGUsIHAud2FybmluZyk7XG4gICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogcC50d2Vha0lkIH0pO1xuICAgIH0pO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLnNldChwLnR3ZWFrSWQsIGJ0bik7XG4gICAgZ3JvdXAuYXBwZW5kQ2hpbGQoYnRuKTtcbiAgfVxuICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgcGxvZyhcInBhZ2VzIGdyb3VwIHN5bmNlZFwiLCB7XG4gICAgY291bnQ6IHBhZ2VzLmxlbmd0aCxcbiAgICBpZHM6IHBhZ2VzLm1hcCgocCkgPT4gcC50d2Vha0lkKSxcbiAgfSk7XG4gIC8vIFJlZmxlY3QgY3VycmVudCBhY3RpdmUgc3RhdGUgYWNyb3NzIHRoZSByZWJ1aWx0IGJ1dHRvbnMuXG4gIHNldE5hdkFjdGl2ZShzdGF0ZS5hY3RpdmVQYWdlKTtcbn1cblxuLy8gRm9yY2UgYW55IGluamVjdGVkIGljb24gU1ZHIHRvIGEgZml4ZWQgYm94LiBUd2Vhay1wcm92aWRlZCBpY29uU3ZnIG1hcmt1cCBtYXlcbi8vIG9taXQgd2lkdGgvaGVpZ2h0IChhbmQgdmlld0JveCBhbG9uZSBsZXRzIGFuIFNWRyBleHBhbmQgdG8gaXRzIGludHJpbnNpYyBzaXplLFxuLy8gd2hpY2ggcmVuZGVyZWQgYSBwYWdlIGljb24gYXMgYSBnaWFudCBnbHlwaCkuIElubGluZSBzdHlsZXMgYmVhdCBjb25mbGljdGluZ1xuLy8gYXR0cmlidXRlcy9DU1MsIHNvIHRoaXMgY2Fubm90IGJlIGRlZmVhdGVkIGJ5IHRoZSB0d2VhaydzIG93biBtYXJrdXAuXG5mdW5jdGlvbiBjb25zdHJhaW5TaWRlYmFySWNvblN2ZyhpY29uOiBFbGVtZW50IHwgbnVsbCB8IHVuZGVmaW5lZCwgc2l6ZSA9IDIwKTogdm9pZCB7XG4gIGlmICghaWNvbikgcmV0dXJuO1xuICBpY29uLnNldEF0dHJpYnV0ZShcIndpZHRoXCIsIFN0cmluZyhzaXplKSk7XG4gIGljb24uc2V0QXR0cmlidXRlKFwiaGVpZ2h0XCIsIFN0cmluZyhzaXplKSk7XG4gIGNvbnN0IHN0eWxlID0gKGljb24gYXMgdW5rbm93biBhcyB7IHN0eWxlPzogQ1NTU3R5bGVEZWNsYXJhdGlvbiB9KS5zdHlsZTtcbiAgaWYgKHN0eWxlKSB7XG4gICAgc3R5bGUud2lkdGggPSBgJHtzaXplfXB4YDtcbiAgICBzdHlsZS5oZWlnaHQgPSBgJHtzaXplfXB4YDtcbiAgICBzdHlsZS5mbGV4U2hyaW5rID0gXCIwXCI7XG4gIH1cbiAgKGljb24gYXMgRWxlbWVudCkuY2xhc3NMaXN0Py5hZGQoXCJpY29uLXNtXCIsIFwiaW5saW5lLWJsb2NrXCIsIFwic2hyaW5rLTBcIiwgXCJhbGlnbi1taWRkbGVcIik7XG59XG5cbmZ1bmN0aW9uIG1ha2VTaWRlYmFySXRlbShsYWJlbDogc3RyaW5nLCBpY29uU3ZnOiBzdHJpbmcpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIC8vIENsYXNzIHN0cmluZyBjb3BpZWQgdmVyYmF0aW0gZnJvbSBDb2RleCdzIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCBldGMpLlxuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5kYXRhc2V0LnR3ZWFrZXIgPSBgbmF2LSR7bGFiZWwudG9Mb3dlckNhc2UoKX1gO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiZm9jdXMtdmlzaWJsZTpvdXRsaW5lLXRva2VuLWJvcmRlciByZWxhdGl2ZSBweC1yb3cteCBweS1yb3cteSBjdXJzb3ItaW50ZXJhY3Rpb24gc2hyaW5rLTAgaXRlbXMtY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIHRleHQtbGVmdCB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZSBmb2N1cy12aXNpYmxlOm91dGxpbmUtMiBmb2N1cy12aXNpYmxlOm91dGxpbmUtb2Zmc2V0LTIgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNTAgZ2FwLTIgZmxleCB3LWZ1bGwgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbm9ybWFsXCI7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBpbm5lci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBtaW4tdy0wIGl0ZW1zLWNlbnRlciB0ZXh0LWJhc2UgZ2FwLTIgZmxleC0xIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICBpbm5lci5pbm5lckhUTUwgPSBgJHtpY29uU3ZnfTxzcGFuIGNsYXNzPVwidHJ1bmNhdGVcIj4ke2xhYmVsfTwvc3Bhbj5gO1xuICBjb25zdHJhaW5TaWRlYmFySWNvblN2Zyhpbm5lci5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpKTtcbiAgYnRuLmFwcGVuZENoaWxkKGlubmVyKTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gYXBwZW5kU2lkZWJhclN0b3JlVXBkYXRlQmFkZ2UoYnRuOiBIVE1MQnV0dG9uRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBpbm5lciA9IGJ0bi5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmICghaW5uZXIpIHJldHVybjtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuZGF0YXNldC50d2Vha2VyU3RvcmVVcGRhdGVCYWRnZSA9IFwidHJ1ZVwiO1xuICBiYWRnZS5oaWRkZW4gPSB0cnVlO1xuICBiYWRnZS50aXRsZSA9IFwiSW5zdGFsbGVkIHR3ZWFrcyB3aXRoIGFwcHJvdmVkIHVwZGF0ZXNcIjtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXJcIjtcbiAgT2JqZWN0LmFzc2lnbihiYWRnZS5zdHlsZSwge1xuICAgIHBvc2l0aW9uOiBcImFic29sdXRlXCIsXG4gICAgcmlnaHQ6IFwiMTJweFwiLFxuICAgIHRvcDogXCI1MCVcIixcbiAgICB0cmFuc2Zvcm06IFwidHJhbnNsYXRlWSgtNTAlKVwiLFxuICAgIHpJbmRleDogXCIxXCIsXG4gIH0pO1xuICBhcHBseVN0b3JlVXBkYXRlQmFkZ2VTdHlsZShiYWRnZSwgbnVsbCk7XG4gIGJ0bi5hcHBlbmRDaGlsZChiYWRnZSk7XG59XG5cbi8qKiBJbnRlcm5hbCBrZXkgZm9yIHRoZSBidWlsdC1pbiBuYXYgYnV0dG9ucy4gKi9cbnR5cGUgQnVpbHRpblBhZ2UgPSBcImNvbmZpZ1wiIHwgXCJ0d2Vha3NcIiB8IFwic3RvcmVcIjtcblxuZnVuY3Rpb24gc2V0TmF2QWN0aXZlKGFjdGl2ZTogQWN0aXZlUGFnZSB8IG51bGwpOiB2b2lkIHtcbiAgLy8gQnVpbHQtaW4gKENvbmZpZy9Ud2Vha3MpIGJ1dHRvbnMuXG4gIGlmIChzdGF0ZS5uYXZCdXR0b25zKSB7XG4gICAgY29uc3QgYnVpbHRpbjogQnVpbHRpblBhZ2UgfCBudWxsID1cbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJjb25maWdcIiA/IFwiY29uZmlnXCIgOlxuICAgICAgYWN0aXZlPy5raW5kID09PSBcInR3ZWFrc1wiID8gXCJ0d2Vha3NcIiA6XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwic3RvcmVcIiA/IFwic3RvcmVcIiA6IG51bGw7XG4gICAgZm9yIChjb25zdCBba2V5LCBidG5dIG9mIE9iamVjdC5lbnRyaWVzKHN0YXRlLm5hdkJ1dHRvbnMpIGFzIFtCdWlsdGluUGFnZSwgSFRNTEJ1dHRvbkVsZW1lbnRdW10pIHtcbiAgICAgIGFwcGx5TmF2QWN0aXZlKGJ0biwga2V5ID09PSBidWlsdGluKTtcbiAgICB9XG4gIH1cbiAgLy8gT25lIHN0YWJsZSBidXR0b24gcGVyIGVuYWJsZWQgdHdlYWssIHJlZ2FyZGxlc3Mgb2YgaG93IG1hbnkgc2VjdGlvbnMgaXRcbiAgLy8gcmVnaXN0ZXJlZCBvciB3aGV0aGVyIHN0YXJ0dXAgcmVhY2hlZCBwYWdlIHJlZ2lzdHJhdGlvbiBhdCBhbGwuXG4gIGZvciAoY29uc3QgW3R3ZWFrSWQsIGJ1dHRvbl0gb2Ygc3RhdGUucGFnZU5hdkJ1dHRvbnMpIHtcbiAgICBjb25zdCBpc0FjdGl2ZSA9IGFjdGl2ZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgYWN0aXZlLmlkID09PSB0d2Vha0lkO1xuICAgIGFwcGx5TmF2QWN0aXZlKGJ1dHRvbiwgaXNBY3RpdmUpO1xuICB9XG4gIC8vIENvZGV4J3Mgb3duIHNpZGViYXIgYnV0dG9ucyAoR2VuZXJhbCwgQXBwZWFyYW5jZSwgZXRjKS4gV2hlbiBvbmUgb2ZcbiAgLy8gb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgQ29kZXggc3RpbGwgaGFzIGFyaWEtY3VycmVudD1cInBhZ2VcIiBhbmQgdGhlXG4gIC8vIGFjdGl2ZS1iZyBjbGFzcyBvbiB3aGljaGV2ZXIgaXRlbSBpdCBjb25zaWRlcmVkIHRoZSByb3V0ZSBcdTIwMTQgdHlwaWNhbGx5XG4gIC8vIEdlbmVyYWwuIFRoYXQgbWFrZXMgYm90aCBidXR0b25zIGxvb2sgc2VsZWN0ZWQuIFN0cmlwIENvZGV4J3MgYWN0aXZlXG4gIC8vIHN0eWxpbmcgd2hpbGUgb25lIG9mIG91cnMgaXMgYWN0aXZlOyByZXN0b3JlIGl0IHdoZW4gbm9uZSBpcy5cbiAgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKGFjdGl2ZSAhPT0gbnVsbCk7XG59XG5cbi8qKlxuICogTXV0ZSBDb2RleCdzIG93biBhY3RpdmUtc3RhdGUgc3R5bGluZyBvbiBpdHMgc2lkZWJhciBidXR0b25zLiBXZSBkb24ndFxuICogdG91Y2ggQ29kZXgncyBSZWFjdCBzdGF0ZSBcdTIwMTQgd2hlbiB0aGUgdXNlciBjbGlja3MgYSBuYXRpdmUgaXRlbSwgQ29kZXhcbiAqIHJlLXJlbmRlcnMgdGhlIGJ1dHRvbnMgYW5kIHJlLWFwcGxpZXMgaXRzIG93biBjb3JyZWN0IHN0YXRlLCB0aGVuIG91clxuICogc2lkZWJhci1jbGljayBsaXN0ZW5lciBmaXJlcyBgcmVzdG9yZUNvZGV4Vmlld2AgKHdoaWNoIGNhbGxzIGJhY2sgaW50b1xuICogYHNldE5hdkFjdGl2ZShudWxsKWAgYW5kIGxldHMgQ29kZXgncyBzdHlsaW5nIHN0YW5kKS5cbiAqXG4gKiBgbXV0ZT10cnVlYCAgXHUyMTkyIHN0cmlwIGFyaWEtY3VycmVudCBhbmQgc3dhcCBhY3RpdmUgYmcgXHUyMTkyIGhvdmVyIGJnXG4gKiBgbXV0ZT1mYWxzZWAgXHUyMTkyIG5vLW9wIChDb2RleCdzIG93biByZS1yZW5kZXIgYWxyZWFkeSByZXN0b3JlZCB0aGluZ3MpXG4gKi9cbmZ1bmN0aW9uIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShtdXRlOiBib29sZWFuKTogdm9pZCB7XG4gIGlmICghbXV0ZSkgcmV0dXJuO1xuICBjb25zdCByb290ID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmICghcm9vdCkgcmV0dXJuO1xuICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpKTtcbiAgZm9yIChjb25zdCBidG4gb2YgYnV0dG9ucykge1xuICAgIC8vIFNraXAgb3VyIG93biBidXR0b25zLlxuICAgIGlmIChidG4uZGF0YXNldC50d2Vha2VyKSBjb250aW51ZTtcbiAgICBpZiAoYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIpIHtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgfVxuICAgIGlmIChidG4uY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBhcHBseU5hdkFjdGl2ZShidG46IEhUTUxCdXR0b25FbGVtZW50LCBhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoYWN0aXZlKSB7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiLCBcImZvbnQtbm9ybWFsXCIpO1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIsIFwicGFnZVwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgYnRuLmNsYXNzTGlzdC5hZGQoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QucmVtb3ZlKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKTtcbiAgICAgIGlmIChpbm5lcikge1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QuYWRkKFwidGV4dC10b2tlbi1mb3JlZ3JvdW5kXCIpO1xuICAgICAgICBpbm5lci5jbGFzc0xpc3QucmVtb3ZlKFwidGV4dC10b2tlbi1saXN0LWFjdGl2ZS1zZWxlY3Rpb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXJcbiAgICAgICAgICAucXVlcnlTZWxlY3RvcihcInN2Z1wiKVxuICAgICAgICAgID8uY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWljb24tZm9yZWdyb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBhY3RpdmF0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBhY3RpdmF0ZVBhZ2UocGFnZTogQWN0aXZlUGFnZSk6IHZvaWQge1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkge1xuICAgIHBsb2coXCJhY3RpdmF0ZTogY29udGVudCBhcmVhIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IHBhZ2U7XG4gIHBsb2coXCJhY3RpdmF0ZVwiLCB7IHBhZ2UgfSk7XG5cbiAgLy8gSGlkZSBDb2RleCdzIGNvbnRlbnQgY2hpbGRyZW4sIHNob3cgb3Vycy5cbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC50d2Vha2VyID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiA9IGNoaWxkLnN0eWxlLmRpc3BsYXkgfHwgXCJcIjtcbiAgICB9XG4gICAgY2hpbGQuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICB9XG4gIGxldCBwYW5lbCA9IGNvbnRlbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXR3ZWFrZXI9XCJ0d2Vha3MtcGFuZWxcIl0nKTtcbiAgaWYgKCFwYW5lbCkge1xuICAgIHBhbmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBwYW5lbC5kYXRhc2V0LnR3ZWFrZXIgPSBcInR3ZWFrcy1wYW5lbFwiO1xuICAgIHBhbmVsLnN0eWxlLmNzc1RleHQgPSBcIndpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3ZlcmZsb3c6YXV0bztcIjtcbiAgICBjb250ZW50LmFwcGVuZENoaWxkKHBhbmVsKTtcbiAgfVxuICBwYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0ZS5wYW5lbEhvc3QgPSBwYW5lbDtcbiAgcmVyZW5kZXIoKTtcbiAgc2V0TmF2QWN0aXZlKHBhZ2UpO1xuICAvLyByZXN0b3JlIENvZGV4J3Mgdmlldy4gUmUtcmVnaXN0ZXIgaWYgbmVlZGVkLlxuICBjb25zdCBzaWRlYmFyID0gc3RhdGUuc2lkZWJhclJvb3Q7XG4gIGlmIChzaWRlYmFyKSB7XG4gICAgaWYgKHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgICAgc2lkZWJhci5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG4gICAgY29uc3QgaGFuZGxlciA9IChlOiBFdmVudCkgPT4ge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZS50YXJnZXQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgaWYgKCF0YXJnZXQpIHJldHVybjtcbiAgICAgIGlmIChzdGF0ZS5uYXZHcm91cD8uY29udGFpbnModGFyZ2V0KSkgcmV0dXJuOyAvLyBvdXIgYnV0dG9uc1xuICAgICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIHBhZ2UgYnV0dG9uc1xuICAgICAgaWYgKHRhcmdldC5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlci1zZXR0aW5ncy1zZWFyY2hdXCIpKSByZXR1cm47XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgfTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBoYW5kbGVyO1xuICAgIHNpZGViYXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlc3RvcmVDb2RleFZpZXcoKTogdm9pZCB7XG4gIHBsb2coXCJyZXN0b3JlIGNvZGV4IHZpZXdcIik7XG4gIGNvbnN0IGNvbnRlbnQgPSBmaW5kQ29udGVudEFyZWEoKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIHRlYXJkb3duUmVuZGVyZWRQYWdlcygpO1xuICBpZiAoc3RhdGUucGFuZWxIb3N0KSBzdGF0ZS5wYW5lbEhvc3Quc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBmb3IgKGNvbnN0IGNoaWxkIG9mIEFycmF5LmZyb20oY29udGVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgIGlmIChjaGlsZCA9PT0gc3RhdGUucGFuZWxIb3N0KSBjb250aW51ZTtcbiAgICBpZiAoY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBjaGlsZC5kYXRhc2V0LnR3ZWFrZXJIaWRkZW47XG4gICAgICBkZWxldGUgY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5hY3RpdmVQYWdlID0gbnVsbDtcbiAgc2V0TmF2QWN0aXZlKG51bGwpO1xuICBpZiAoc3RhdGUuc2lkZWJhclJvb3QgJiYgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QucmVtb3ZlRXZlbnRMaXN0ZW5lcihcbiAgICAgIFwiY2xpY2tcIixcbiAgICAgIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcixcbiAgICAgIHRydWUsXG4gICAgKTtcbiAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIgPSBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcmVuZGVyKCk6IHZvaWQge1xuICBpZiAoIXN0YXRlLmFjdGl2ZVBhZ2UpIHJldHVybjtcbiAgY29uc3QgaG9zdCA9IHN0YXRlLnBhbmVsSG9zdDtcbiAgaWYgKCFob3N0KSByZXR1cm47XG4gIHRlYXJkb3duUmVuZGVyZWRQYWdlcygpO1xuICBob3N0LmlubmVySFRNTCA9IFwiXCI7XG5cbiAgY29uc3QgYXAgPSBzdGF0ZS5hY3RpdmVQYWdlO1xuICBpZiAoYXAua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIpIHtcbiAgICBjb25zdCBpdGVtID0gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbShhcC5pZCk7XG4gICAgaWYgKCFpdGVtKSB7XG4gICAgICByZXN0b3JlQ29kZXhWaWV3KCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGVudHJpZXMgPSByZWdpc3RlcmVkUGFnZXNGb3JUd2VhayhhcC5pZCk7XG4gICAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoaXRlbS50aXRsZSwgaXRlbS5kZXNjcmlwdGlvbik7XG4gICAgaG9zdC5hcHBlbmRDaGlsZChyb290Lm91dGVyKTtcbiAgICByb290LmhlYWRlclRpdGxlQWN0aW9ucy5hcHBlbmRDaGlsZCh0d2Vha0xpZmVjeWNsZUJhZGdlKGl0ZW0pKTtcbiAgICBpZiAoaXRlbS53YXJuaW5nKSByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh0d2Vha1BhZ2VXYXJuaW5nKGl0ZW0ud2FybmluZykpO1xuICAgIGlmICghZW50cmllcy5sZW5ndGgpIHtcbiAgICAgIHJlbmRlckZhbGxiYWNrVHdlYWtQYWdlKHJvb3Quc2VjdGlvbnNXcmFwLCBpdGVtKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSB7XG4gICAgICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gICAgICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICAgICAgaWYgKGVudHJpZXMubGVuZ3RoID4gMSkgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoZW50cnkucGFnZS50aXRsZSkpO1xuICAgICAgY29uc3QgdGFyZ2V0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIHRhcmdldC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTNcIjtcbiAgICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQodGFyZ2V0KTtcbiAgICAgIHJvb3Quc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdHJ5IHsgZW50cnkudGVhcmRvd24/LigpOyB9IGNhdGNoIHt9XG4gICAgICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgICAgICAgY29uc3QgcmV0ID0gZW50cnkucGFnZS5yZW5kZXIodGFyZ2V0KTtcbiAgICAgICAgaWYgKHR5cGVvZiByZXQgPT09IFwiZnVuY3Rpb25cIikgZW50cnkudGVhcmRvd24gPSByZXQ7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnN0IGVyciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGVyci5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tY2hhcnRzLXJlZCB0ZXh0LXNtXCI7XG4gICAgICAgIGVyci50ZXh0Q29udGVudCA9IGBFcnJvciByZW5kZXJpbmcgcGFnZTogJHsoZSBhcyBFcnJvcikubWVzc2FnZX1gO1xuICAgICAgICB0YXJnZXQuYXBwZW5kQ2hpbGQoZXJyKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgdGl0bGUgPVxuICAgIGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyBcIlR3ZWFrc1wiIDpcbiAgICBhcC5raW5kID09PSBcInN0b3JlXCIgPyBcIlR3ZWFrIFN0b3JlXCIgOiBcIlR3ZWFrZXJzXCI7XG4gIGNvbnN0IHN1YnRpdGxlID1cbiAgICBhcC5raW5kID09PSBcInR3ZWFrc1wiXG4gICAgICA/IFwiTWFuYWdlIHlvdXIgY2F0YWxvZyBlbnRyaWVzIGFuZCBpbnN0YWxsZWQgdHdlYWtzLlwiXG4gICAgICA6IGFwLmtpbmQgPT09IFwic3RvcmVcIlxuICAgICAgICA/IFwiSW5zdGFsbCByZXZpZXdlZCB0d2Vha3MgcGlubmVkIHRvIGFwcHJvdmVkIEdpdEh1YiBjb21taXRzLlwiXG4gICAgICAgIDogXCJDaGVja2luZyBpbnN0YWxsZWQgVHdlYWtlcnMgdmVyc2lvbi5cIjtcbiAgY29uc3Qgcm9vdCA9IHBhbmVsU2hlbGwoXG4gICAgdGl0bGUsXG4gICAgc3VidGl0bGUsXG4gICAgYXAua2luZCA9PT0gXCJ0d2Vha3NcIiA/IHsgd2lkdGg6IFwicGx1Z2luc1wiIH0gOiB1bmRlZmluZWQsXG4gICk7XG4gIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gIGlmIChhcC5raW5kID09PSBcInR3ZWFrc1wiKSBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXAgPSByZW5kZXJUd2Vha3NQYWdlKHJvb3Quc2VjdGlvbnNXcmFwKTtcbiAgZWxzZSBpZiAoYXAua2luZCA9PT0gXCJzdG9yZVwiKSByZW5kZXJUd2Vha1N0b3JlUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5oZWFkZXJBY3Rpb25zKTtcbiAgZWxzZSBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXAgPSByZW5kZXJDb25maWdQYWdlKHJvb3Quc2VjdGlvbnNXcmFwLCByb290LnN1YnRpdGxlKTtcbn1cblxuZnVuY3Rpb24gdGVhcmRvd25SZW5kZXJlZFBhZ2VzKCk6IHZvaWQge1xuICBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXA/LigpO1xuICBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXAgPSBudWxsO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgaWYgKCFlbnRyeS50ZWFyZG93bikgY29udGludWU7XG4gICAgdHJ5IHsgZW50cnkudGVhcmRvd24oKTsgfSBjYXRjaCB7fVxuICAgIGVudHJ5LnRlYXJkb3duID0gbnVsbDtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgcGFnZXMgXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHR3ZWFrTGlmZWN5Y2xlQmFkZ2UoaXRlbTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID0gXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgYmFkZ2UudGV4dENvbnRlbnQgPSBgJHtpdGVtLnZlcnNpb259IFx1MDBCNyAke2xpZmVjeWNsZUxhYmVsKGl0ZW0ubGlmZWN5Y2xlKX1gO1xuICBiYWRnZS50aXRsZSA9IGAke2l0ZW0udmVyc2lvbn0gXHUwMEI3ICR7bGlmZWN5Y2xlTGFiZWwoaXRlbS5saWZlY3ljbGUsIGl0ZW0ud2FybmluZyl9YDtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB0d2Vha1BhZ2VXYXJuaW5nKG1lc3NhZ2U6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHdhcm5pbmcuY2xhc3NOYW1lID0gXCJyb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdy8zMCBiZy10b2tlbi1jaGFydHMteWVsbG93LzEwIHAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHdhcm5pbmcudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICByZXR1cm4gd2FybmluZztcbn1cblxuZnVuY3Rpb24gcmVuZGVyRmFsbGJhY2tUd2Vha1BhZ2Uocm9vdDogSFRNTEVsZW1lbnQsIGl0ZW06IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIlN0YXR1c1wiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlZlcnNpb25cIiwgaXRlbS52ZXJzaW9uKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGlmZWN5Y2xlXCIsIGxpZmVjeWNsZUxhYmVsKGl0ZW0ubGlmZWN5Y2xlLCBpdGVtLndhcm5pbmcpKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiU2V0dGluZ3MgcGFnZVwiLCBcIlRoaXMgZW5hYmxlZCBUd2Vha2VyIGhhcyBub3QgcmVnaXN0ZXJlZCBpdHMgY3VzdG9tIHBhZ2UgeWV0LiBSdW50aW1lIHN0YXR1cyByZW1haW5zIGF2YWlsYWJsZSBoZXJlLlwiKSk7XG4gIGlmIChbXCJmYWlsZWRcIiwgXCJxdWFyYW50aW5lZFwiLCBcInRpbWVkX291dFwiXS5pbmNsdWRlcyhpdGVtLmxpZmVjeWNsZSkpIHtcbiAgICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgICByb3cuYXBwZW5kQ2hpbGQocm93Q29weShcIlJlY292ZXJ5XCIsIFwiQ2xlYXIgdGhlIGZhaWx1cmUgYW5kIHJldHJ5IHRoaXMgVHdlYWtlciB3aXRob3V0IHJlbW92aW5nIGl0cyBkYXRhLlwiKSk7XG4gICAgY29uc3QgcmVjb3ZlciA9IGNvbXBhY3RCdXR0b24oXCJSZWNvdmVyXCIsICgpID0+IHtcbiAgICAgIHJlY292ZXIuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlY292ZXItdHdlYWtcIiwgaXRlbS50d2Vha0lkKS5maW5hbGx5KCgpID0+IHsgcmVjb3Zlci5kaXNhYmxlZCA9IGZhbHNlOyB9KTtcbiAgICB9KTtcbiAgICByb3cuYXBwZW5kQ2hpbGQocmVjb3Zlcik7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICB9XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHJvb3QuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG59XG5cbmZ1bmN0aW9uIHJvd0NvcHkodGl0bGU6IHN0cmluZywgZGV0YWlsOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNvcHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb3B5LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gdGl0bGU7XG4gIGNvbnN0IGRlc2NyaXB0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzY3JpcHRpb24uY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgZGVzY3JpcHRpb24udGV4dENvbnRlbnQgPSBkZXRhaWw7XG4gIGNvcHkuYXBwZW5kKGhlYWRpbmcsIGRlc2NyaXB0aW9uKTtcbiAgcmV0dXJuIGNvcHk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNvbmZpZ1BhZ2UoXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQsXG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgY2xlYW51cHM6IEFycmF5PCgpID0+IHZvaWQ+ID0gW107XG4gIGNvbnN0IGNhcmRVcGRhdGVzID0gbmV3IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPigpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckVudmlyb25tZW50U2VjdGlvbihzZWN0aW9uc1dyYXAsIGNhcmRVcGRhdGVzKSk7XG4gIGNsZWFudXBzLnB1c2gocmVuZGVyRGVza3RvcFVwZGF0ZVNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlck1jcEludGVncmF0aW9uU2VjdGlvbihzZWN0aW9uc1dyYXAsIGNhcmRVcGRhdGVzKSk7XG4gIGNsZWFudXBzLnB1c2gocmVuZGVyQXV0b21hdGljTWFpbnRlbmFuY2VTZWN0aW9uKHNlY3Rpb25zV3JhcCwgY2FyZFVwZGF0ZXMpKTtcblxuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiVHdlYWtlcnMgVXBkYXRlc1wiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckNvbmZpZ0NhcmQgPSBcInRydWVcIjtcbiAgY29uc3QgbG9hZGluZyA9IHJvd1NpbXBsZShcIkxvYWRpbmcgdXBkYXRlIHNldHRpbmdzXCIsIFwiQ2hlY2tpbmcgY3VycmVudCBUd2Vha2VycyBjb25maWd1cmF0aW9uLlwiKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChsb2FkaW5nKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgaWYgKHN1YnRpdGxlKSB7XG4gICAgICAgIHN1YnRpdGxlLnRleHRDb250ZW50ID0gYFlvdSBoYXZlIFR3ZWFrZXJzICR7KGNvbmZpZyBhcyBUd2Vha2VyQ29uZmlnKS52ZXJzaW9ufSBpbnN0YWxsZWQuYDtcbiAgICAgIH1cbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgcmVuZGVyVHdlYWtlckNvbmZpZyhjYXJkLCBjb25maWcgYXMgVHdlYWtlckNvbmZpZyk7XG4gICAgfSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIkNvdWxkIG5vdCBsb2FkIGluc3RhbGxlZCBUd2Vha2VycyB2ZXJzaW9uLlwiO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCBsb2FkIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcblxuICByZW5kZXJBZHZhbmNlZFJ1bnRpbWVTZWN0aW9uKHNlY3Rpb25zV3JhcCk7XG5cbiAgY29uc3QgbWFpbnRlbmFuY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgbWFpbnRlbmFuY2UuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIk1haW50ZW5hbmNlXCIpKTtcbiAgY29uc3QgbWFpbnRlbmFuY2VDYXJkID0gcm91bmRlZENhcmQoKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHVuaW5zdGFsbFJvdygpKTtcbiAgbWFpbnRlbmFuY2VDYXJkLmFwcGVuZENoaWxkKHJlcG9ydEJ1Z1JvdygpKTtcbiAgbWFpbnRlbmFuY2UuYXBwZW5kQ2hpbGQobWFpbnRlbmFuY2VDYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBmb3IgKGNvbnN0IGNsZWFudXAgb2YgY2xlYW51cHMuc3BsaWNlKDApKSB7XG4gICAgICB0cnkgeyBjbGVhbnVwKCk7IH0gY2F0Y2gge31cbiAgICB9XG4gIH07XG59XG5cbi8qKlxuICogQ29kZXgtbmF0aXZlIGVudmlyb25tZW50IGNvbnRyb2xzLiBBcHAgZXhwZXJpZW5jZSBhbmQgcmVsZWFzZSBwcm9maWxlIGFyZVxuICogZGVsaWJlcmF0ZWx5IGluZGVwZW5kZW50IHNlbGVjdGlvbnM6IGNoYW5naW5nIGVpdGhlciBvbmUgb25seSBzdGFnZXMgYVxuICogcGVuZGluZyB2YWx1ZSB1bnRpbCB0aGUgdXNlciBjaG9vc2VzIEFwcGx5ICYgUmVzdGFydC5cbiAqL1xuZnVuY3Rpb24gcmVuZGVyRW52aXJvbm1lbnRTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBcHAgTW9kZSAmIERlc2t0b3AgUmVsZWFzZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckVudmlyb25tZW50Q2FyZCA9IFwidHJ1ZVwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxvYWRpbmcgZW52aXJvbm1lbnRcIiwgXCJDaGVja2luZyBhdmFpbGFibGUgYXBwIGV4cGVyaWVuY2VzIGFuZCByZWxlYXNlIHByb2ZpbGVzLlwiKSk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICBsZXQgZW52aXJvbm1lbnQ6IEVudmlyb25tZW50U3RhdHVzIHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbiB8IG51bGwgPSBudWxsO1xuICBsZXQgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gIGxldCBlbnZpcm9ubWVudEFjdGlvbkVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IHRyYW5zYWN0aW9uUG9sbGluZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcblxuICBjb25zdCBjdXJyZW50U2VsZWN0aW9uID0gKCk6IEVudmlyb25tZW50U2VsZWN0aW9uIHwgbnVsbCA9PiBlbnZpcm9ubWVudD8uc2VsZWN0ZWQgPz8gbnVsbDtcbiAgY29uc3QgaGFzUGVuZGluZ0NoYW5nZXMgPSAoKTogYm9vbGVhbiA9PiBlbnZpcm9ubWVudCAhPT0gbnVsbCAmJiBlbnZpcm9ubWVudENvbnRyb2xsZXIuc25hcHNob3QuaGFzUGVuZGluZ0NoYW5nZXM7XG4gIGNvbnN0IGlzRW52aXJvbm1lbnRCdXN5ID0gKCk6IGJvb2xlYW4gPT4gZXh0ZXJuYWxCdXN5IHx8IGVudmlyb25tZW50Q29udHJvbGxlci5zbmFwc2hvdC5idXN5O1xuXG4gIGNvbnN0IHJlc3RvcmVQZXJzaXN0ZWRSZXF1ZXN0ID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghdHJhbnNhY3Rpb24gfHwgKHRyYW5zYWN0aW9uLnBoYXNlICE9PSBcInByZXBhcmluZ1wiICYmIHRyYW5zYWN0aW9uLnBoYXNlICE9PSBcInByZXBhcmVkXCIpKSByZXR1cm47XG4gICAgY29uc3QgcmVxdWVzdGVkID0gZW52aXJvbm1lbnRUcmFuc2FjdGlvblJlcXVlc3RlZFNlbGVjdGlvbih0cmFuc2FjdGlvbik7XG4gICAgaWYgKHJlcXVlc3RlZCkgZW52aXJvbm1lbnRDb250cm9sbGVyLnJlc3RvcmVQZW5kaW5nKHJlcXVlc3RlZCk7XG4gIH07XG5cbiAgY29uc3Qgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAodHJhbnNhY3Rpb25Qb2xsaW5nKSBjbGVhclRpbWVvdXQodHJhbnNhY3Rpb25Qb2xsaW5nKTtcbiAgICB0cmFuc2FjdGlvblBvbGxpbmcgPSBudWxsO1xuICAgIGlmIChcbiAgICAgICFjYXJkLmlzQ29ubmVjdGVkXG4gICAgICB8fCAhdHJhbnNhY3Rpb25cbiAgICAgIHx8IGVudmlyb25tZW50VHJhbnNhY3Rpb25Jc1Rlcm1pbmFsKHRyYW5zYWN0aW9uLnBoYXNlKVxuICAgICkgcmV0dXJuO1xuICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgdHJhbnNhY3Rpb25Qb2xsaW5nID0gbnVsbDtcbiAgICAgIHZvaWQgbG9hZEVudmlyb25tZW50VHJhbnNhY3Rpb24oKTtcbiAgICB9LCA5MDApO1xuICB9O1xuXG4gIGFzeW5jIGZ1bmN0aW9uIHByZXBhcmVFbnZpcm9ubWVudFNlbGVjdGlvbihcbiAgICByZXF1ZXN0ZWQ6IFBpY2s8RW52aXJvbm1lbnRTZWxlY3Rpb24sIFwiYXBwRXhwZXJpZW5jZVwiIHwgXCJyZWxlYXNlUHJvZmlsZVwiPixcbiAgKTogUHJvbWlzZTxFbnZpcm9ubWVudFRyYW5zYWN0aW9uPiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIGNvbnN0IHByZXBhcmVkID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpwcmVwYXJlLWVudmlyb25tZW50XCIsIHJlcXVlc3RlZCk7XG4gICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSkgdGhyb3cgbmV3IEVycm9yKFwiRW52aXJvbm1lbnQgcHJlcGFyYXRpb24gd2FzIHN1cGVyc2VkZWRcIik7XG4gICAgY29uc3QgcmVjZWlwdCA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocHJlcGFyZWQpO1xuICAgIGlmICghcmVjZWlwdCkgdGhyb3cgbmV3IEVycm9yKFwiRW52aXJvbm1lbnQgcHJlcGFyYXRpb24gcmV0dXJuZWQgbm8gdHJhbnNhY3Rpb24gcmVjZWlwdFwiKTtcbiAgICB0cmFuc2FjdGlvbiA9IHJlY2VpcHQ7XG4gICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgIHJldHVybiByZWNlaXB0O1xuICB9XG5cbiAgYXN5bmMgZnVuY3Rpb24gY29tbWl0UHJlcGFyZWRFbnZpcm9ubWVudChyZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIGxldCByZXN1bHQ6IHVua25vd247XG4gICAgdHJ5IHtcbiAgICAgIHJlc3VsdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29tbWl0LWVudmlyb25tZW50XCIsIHsgdHJhbnNhY3Rpb25JZDogcmVjZWlwdC50cmFuc2FjdGlvbklkIH0pO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBgQ291bGQgbm90IHN1Ym1pdCBlbnZpcm9ubWVudCBjaGFuZ2U6ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICB0cmFuc2FjdGlvbiA9IHsgLi4ucmVjZWlwdCwgZXJyb3I6IGRldGFpbCB9O1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGRldGFpbCk7XG4gICAgfVxuICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IGNvb3JkaW5hdG9yIHN1Ym1pc3Npb24gd2FzIHN1cGVyc2VkZWRcIik7XG4gICAgY29uc3Qgc3VibWlzc2lvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbihyZXN1bHQpO1xuICAgIGNvbnN0IG9ic2VydmVkID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpO1xuICAgIHRyYW5zYWN0aW9uID0gc3VibWlzc2lvblxuICAgICAgPyB7XG4gICAgICAgIC4uLnJlY2VpcHQsXG4gICAgICAgIGVycm9yOiBzdWJtaXNzaW9uLmVycm9yID8/IG51bGwsXG4gICAgICAgIGhlbHBlcjogeyAuLi4ocmVjZWlwdC5oZWxwZXIgPz8ge30pLCBzdWJtaXNzaW9uIH0sXG4gICAgICB9XG4gICAgICA6IG9ic2VydmVkID8/IHJlY2VpcHQ7XG4gICAgcmVzdG9yZVBlcnNpc3RlZFJlcXVlc3QoKTtcbiAgICBpZiAoc3VibWlzc2lvbj8ucGhhc2UgPT09IFwic3VibWl0LWZhaWxlZFwiKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBgQ291bGQgbm90IHN1Ym1pdCBlbnZpcm9ubWVudCBjaGFuZ2U6ICR7c3VibWlzc2lvbi5lcnJvciB8fCBcIkVudmlyb25tZW50IGNvb3JkaW5hdG9yIHN1Ym1pc3Npb24gZmFpbGVkXCJ9YDtcbiAgICAgIHRyYW5zYWN0aW9uID0geyAuLi50cmFuc2FjdGlvbiwgZXJyb3I6IGRldGFpbCB9O1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGRldGFpbCk7XG4gICAgfVxuICAgIHZvaWQgbG9hZEVudmlyb25tZW50VHJhbnNhY3Rpb24oKTtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNhbmNlbFByZXBhcmVkRW52aXJvbm1lbnQocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2FuY2VsLWVudmlyb25tZW50XCIsIHsgdHJhbnNhY3Rpb25JZDogcmVjZWlwdC50cmFuc2FjdGlvbklkIH0pO1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSkgdGhyb3cgbmV3IEVycm9yKFwiRW52aXJvbm1lbnQgY2FuY2VsbGF0aW9uIHdhcyBzdXBlcnNlZGVkXCIpO1xuICAgICAgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlc3VsdCkgPz8gcmVjZWlwdDtcbiAgICAgIGlmICh0cmFuc2FjdGlvbi5waGFzZSAhPT0gXCJjYW5jZWxsZWRcIikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudmlyb25tZW50IGNhbmNlbGxhdGlvbiByZXR1cm5lZCAke3RyYW5zYWN0aW9uLnBoYXNlfWApO1xuICAgICAgfVxuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBgQ291bGQgbm90IGNhbmNlbCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbjogJHtzYWZlVWlFcnJvcihlcnJvcil9YDtcbiAgICAgIHRyYW5zYWN0aW9uID0geyAuLi5yZWNlaXB0LCBlcnJvcjogZGV0YWlsIH07XG4gICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZGV0YWlsKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBlbnZpcm9ubWVudENvbnRyb2xsZXIgPSBjcmVhdGVFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXI8RW52aXJvbm1lbnRUcmFuc2FjdGlvbj4oXG4gICAgeyBhcHBFeHBlcmllbmNlOiBcImNoYXRncHRcIiwgcmVsZWFzZVByb2ZpbGU6IFwic3RhYmxlXCIgfSxcbiAgICB7XG4gICAgICBwcmVwYXJlOiBwcmVwYXJlRW52aXJvbm1lbnRTZWxlY3Rpb24sXG4gICAgICBjb25maXJtOiAocmVxdWVzdGVkLCByZWNlaXB0KSA9PiBvcGVuRW52aXJvbm1lbnRDb25maXJtTW9kYWwocmVxdWVzdGVkLCByZWNlaXB0KSxcbiAgICAgIGNvbW1pdDogY29tbWl0UHJlcGFyZWRFbnZpcm9ubWVudCxcbiAgICAgIGNhbmNlbDogY2FuY2VsUHJlcGFyZWRFbnZpcm9ubWVudCxcbiAgICB9LFxuICAgIHtcbiAgICAgIG9uQ2hhbmdlOiAoc25hcHNob3QpID0+IHtcbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IHNuYXBzaG90LmVycm9yO1xuICAgICAgICBpZiAoY2FyZC5pc0Nvbm5lY3RlZCkgZHJhdygpO1xuICAgICAgfSxcbiAgICB9LFxuICApO1xuXG4gIGZ1bmN0aW9uIG9wZW5QcmVwYXJlZEVudmlyb25tZW50Q29uZmlybWF0aW9uKFxuICAgIHJlcXVlc3RlZDogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuICAgIHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24sXG4gICk6IHZvaWQge1xuICAgIGlmIChyZWNlaXB0LnBoYXNlICE9PSBcInByZXBhcmVkXCIpIHJldHVybjtcbiAgICB2b2lkIGVudmlyb25tZW50Q29udHJvbGxlci5yZXN1bWVQcmVwYXJlZChyZXF1ZXN0ZWQsIHJlY2VpcHQpO1xuICB9XG5cbiAgZnVuY3Rpb24gY2FuY2VsRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogdm9pZCB7XG4gICAgaWYgKGlzRW52aXJvbm1lbnRCdXN5KCkgfHwgKHJlY2VpcHQucGhhc2UgIT09IFwicHJlcGFyaW5nXCIgJiYgcmVjZWlwdC5waGFzZSAhPT0gXCJwcmVwYXJlZFwiKSkgcmV0dXJuO1xuICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgIGV4dGVybmFsQnVzeSA9IHRydWU7XG4gICAgZHJhdygpO1xuICAgIHZvaWQgY2FuY2VsUHJlcGFyZWRFbnZpcm9ubWVudChyZWNlaXB0KVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGN1cnJlbnRTZWxlY3Rpb24oKTtcbiAgICAgICAgaWYgKHRyYW5zYWN0aW9uPy5waGFzZSA9PT0gXCJjYW5jZWxsZWRcIiAmJiBzZWxlY3RlZCkge1xuICAgICAgICAgIGVudmlyb25tZW50Q29udHJvbGxlci5zZXRTZWxlY3RlZChzZWxlY3RlZCk7XG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBzYWZlVWlFcnJvcihlcnJvcik7XG4gICAgICB9KVxuICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICBleHRlcm5hbEJ1c3kgPSBmYWxzZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiByZWNvdmVyRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogdm9pZCB7XG4gICAgaWYgKGlzRW52aXJvbm1lbnRCdXN5KCkgfHwgIWVudmlyb25tZW50VHJhbnNhY3Rpb25DYW5SZWNvdmVyKHJlY2VpcHQpKSByZXR1cm47XG4gICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG51bGw7XG4gICAgZXh0ZXJuYWxCdXN5ID0gdHJ1ZTtcbiAgICBkcmF3KCk7XG4gICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgLmludm9rZShcInR3ZWFrZXI6cm9sbGJhY2stZW52aXJvbm1lbnRcIiwgeyB0cmFuc2FjdGlvbklkOiByZWNlaXB0LnRyYW5zYWN0aW9uSWQgfSlcbiAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlc3VsdCkgPz8gcmVjZWlwdDtcbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG51bGw7XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBgQ291bGQgbm90IHJlY292ZXIgdGhlIGFwcCBtb2RlIHNhZmVseTogJHtzYWZlVWlFcnJvcihlcnJvcil9YDtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgLi4ucmVjZWlwdCxcbiAgICAgICAgICBlcnJvcjogZW52aXJvbm1lbnRBY3Rpb25FcnJvcixcbiAgICAgICAgfTtcbiAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgfSk7XG4gIH1cblxuICBmdW5jdGlvbiBhcHBlbmRFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KCk6IHZvaWQge1xuICAgIGlmICghdHJhbnNhY3Rpb24pIHJldHVybjtcbiAgICBjb25zdCByZWNlaXB0ID0gdHJhbnNhY3Rpb247XG4gICAgY29uc3QgcmVxdWVzdGVkID0gZW52aXJvbm1lbnRUcmFuc2FjdGlvblJlcXVlc3RlZFNlbGVjdGlvbihyZWNlaXB0KTtcbiAgICBjb25zdCBoZWxwZXJJbkZsaWdodCA9IGVudmlyb25tZW50SGVscGVySXNJbkZsaWdodChyZWNlaXB0KTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKGVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3cocmVjZWlwdCwge1xuICAgICAgYnVzeTogaXNFbnZpcm9ubWVudEJ1c3koKSxcbiAgICAgIG9uUmVzdW1lOiByZWNlaXB0LnBoYXNlID09PSBcInByZXBhcmVkXCIgJiYgcmVxdWVzdGVkICYmICFoZWxwZXJJbkZsaWdodFxuICAgICAgICA/ICgpID0+IG9wZW5QcmVwYXJlZEVudmlyb25tZW50Q29uZmlybWF0aW9uKHJlcXVlc3RlZCwgcmVjZWlwdClcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICBvbkNhbmNlbDogKHJlY2VpcHQucGhhc2UgPT09IFwicHJlcGFyaW5nXCIgfHwgcmVjZWlwdC5waGFzZSA9PT0gXCJwcmVwYXJlZFwiKSAmJiAhaGVscGVySW5GbGlnaHRcbiAgICAgICAgPyAoKSA9PiBjYW5jZWxFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlY2VpcHQpXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgb25SZWNvdmVyOiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3ZlcihyZWNlaXB0KVxuICAgICAgICA/ICgpID0+IHJlY292ZXJFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHJlY2VpcHQpXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgIH0pKTtcbiAgfVxuXG4gIGNvbnN0IGRyYXcgPSAoKTogdm9pZCA9PiB7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgY29uc3Qgc2VsZWN0ZWQgPSBjdXJyZW50U2VsZWN0aW9uKCk7XG4gICAgaWYgKCFzZWxlY3RlZCB8fCAhZW52aXJvbm1lbnQpIHtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiRW52aXJvbm1lbnQgdW5hdmFpbGFibGVcIiwgXCJUaGUgY3VycmVudCBlbnZpcm9ubWVudCBzZWxlY3Rpb24gY291bGQgbm90IGJlIGxvYWRlZC5cIikpO1xuICAgICAgYXBwZW5kRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvdygpO1xuICAgICAgaWYgKGVudmlyb25tZW50QWN0aW9uRXJyb3IgJiYgZW52aXJvbm1lbnRBY3Rpb25FcnJvciAhPT0gdHJhbnNhY3Rpb24/LmVycm9yKSB7XG4gICAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiRW52aXJvbm1lbnQgYWN0aW9uIGZhaWxlZFwiLCBlbnZpcm9ubWVudEFjdGlvbkVycm9yKSk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHBlbmRpbmcgPSBlbnZpcm9ubWVudENvbnRyb2xsZXIuc25hcHNob3QucGVuZGluZztcbiAgICBjb25zdCBidXN5ID0gaXNFbnZpcm9ubWVudEJ1c3koKTtcbiAgICBjb25zdCBvYnNlcnZlZEV4cGVyaWVuY2UgPSBlbnZpcm9ubWVudC5vYnNlcnZhdGlvbj8uYXBwRXhwZXJpZW5jZTtcbiAgICBjb25zdCBvYnNlcnZhdGlvbk5lZWRzUmVwYWlyID0gZW52aXJvbm1lbnQub2JzZXJ2YXRpb24gIT09IHVuZGVmaW5lZFxuICAgICAgJiYgKG9ic2VydmVkRXhwZXJpZW5jZSA9PT0gbnVsbFxuICAgICAgICB8fCBvYnNlcnZlZEV4cGVyaWVuY2UgIT09IHNlbGVjdGVkLmFwcEV4cGVyaWVuY2VcbiAgICAgICAgfHwgZW52aXJvbm1lbnQub2JzZXJ2YXRpb24udHJhbnNpdGlvbkpvdXJuYWxQcmVzZW50KTtcbiAgICBjb25zdCBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZCA9IGJ1c3lcbiAgICAgIHx8IG9ic2VydmF0aW9uTmVlZHNSZXBhaXJcbiAgICAgIHx8ICh0cmFuc2FjdGlvbiAhPT0gbnVsbCAmJiAoXG4gICAgICAgICFlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbCh0cmFuc2FjdGlvbi5waGFzZSlcbiAgICAgICAgfHwgZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIodHJhbnNhY3Rpb24pXG4gICAgICApKTtcblxuICAgIGlmIChvYnNlcnZhdGlvbk5lZWRzUmVwYWlyKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBlbnZpcm9ubWVudC5vYnNlcnZhdGlvbj8udHJhbnNpdGlvbkpvdXJuYWxQcmVzZW50XG4gICAgICAgID8gXCJBIGxlZ2FjeSBtb2RlIHRyYW5zaXRpb24gaXMgc3RpbGwgcHJlc2VudC4gUnVuIHR3ZWFrZXIgcmVwYWlyIGluIFRlcm1pbmFsIGJlZm9yZSBzd2l0Y2hpbmcuXCJcbiAgICAgICAgOiBvYnNlcnZlZEV4cGVyaWVuY2UgPT09IG51bGwgfHwgb2JzZXJ2ZWRFeHBlcmllbmNlID09PSB1bmRlZmluZWRcbiAgICAgICAgICA/IFwiVGhlIGxpdmUgYXBwIG1hcmtlciBjb3VsZCBub3QgYmUgdmVyaWZpZWQuIFJ1biB0d2Vha2VyIHJlcGFpciBpbiBUZXJtaW5hbCBiZWZvcmUgc3dpdGNoaW5nLlwiXG4gICAgICAgICAgOiBgU2F2ZWQgbW9kZSBpcyAke2Vudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UpfSwgYnV0IHRoZSBsaXZlIGFwcCBwcm92ZXMgJHtlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbChvYnNlcnZlZEV4cGVyaWVuY2UpfS4gUnVuIHR3ZWFrZXIgcmVwYWlyIGluIFRlcm1pbmFsLmA7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IG5lZWRzIHJlcGFpclwiLCBkZXRhaWwpKTtcbiAgICB9XG5cbiAgICBjb25zdCBwZW5kaW5nQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHBlbmRpbmcpO1xuICAgIGNvbnN0IGNoYXRncHRBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwge1xuICAgICAgYXBwRXhwZXJpZW5jZTogXCJjaGF0Z3B0XCIsXG4gICAgICByZWxlYXNlUHJvZmlsZTogcGVuZGluZy5yZWxlYXNlUHJvZmlsZSxcbiAgICB9KTtcbiAgICBjb25zdCB0d2Vha2Vyc0F2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCB7XG4gICAgICBhcHBFeHBlcmllbmNlOiBcInR3ZWFrZXJzXCIsXG4gICAgICByZWxlYXNlUHJvZmlsZTogcGVuZGluZy5yZWxlYXNlUHJvZmlsZSxcbiAgICB9KTtcblxuICAgIGNhcmQuYXBwZW5kQ2hpbGQoZW52aXJvbm1lbnRDaG9pY2VSb3coXG4gICAgICBcIkFwcCBNb2RlXCIsXG4gICAgICBcIkNoYXRHUFQgZGlzYWJsZXMgZXZlcnkgdHdlYWsuIFR3ZWFrZXJzIHJlc3RvcmVzIHRoZSB0d2Vha3MgeW91IHByZXZpb3VzbHkgZW5hYmxlZC5cIixcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcImNoYXRncHRcIixcbiAgICAgICAgICBsYWJlbDogXCJDaGF0R1BUXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGNoYXRncHRBdmFpbGFiaWxpdHkuYXZhaWxhYmxlXG4gICAgICAgICAgICA/IFwiT3BlbkFJJ3Mgc3RhbmRhcmQgYXBwIGV4cGVyaWVuY2UuXCJcbiAgICAgICAgICAgIDogZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihjaGF0Z3B0QXZhaWxhYmlsaXR5LCBcIkNoYXRHUFQgaXMgdW5hdmFpbGFibGUgZm9yIHRoaXMgcmVsZWFzZSBwcm9maWxlLlwiKSxcbiAgICAgICAgICBkaXNhYmxlZDogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgfHwgIWNoYXRncHRBdmFpbGFiaWxpdHkuYXZhaWxhYmxlLFxuICAgICAgICAgIGRpc2FibGVkUmVhc29uOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgICAgICAgPyBcIkZpbmlzaCwgY2FuY2VsLCBvciByZWNvdmVyIHRoZSBjdXJyZW50IGVudmlyb25tZW50IHRyYW5zYWN0aW9uIGZpcnN0LlwiXG4gICAgICAgICAgICA6IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oY2hhdGdwdEF2YWlsYWJpbGl0eSwgXCJDaGF0R1BUIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICB2YWx1ZTogXCJ0d2Vha2Vyc1wiLFxuICAgICAgICAgIGxhYmVsOiBcIlR3ZWFrZXJzXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IHR3ZWFrZXJzQXZhaWxhYmlsaXR5LmF2YWlsYWJsZVxuICAgICAgICAgICAgPyBcIlRoZSBzdGFuZGFyZCBhcHAgd2l0aCBlbmFibGVkIFR3ZWFrZXJzIGZlYXR1cmVzLlwiXG4gICAgICAgICAgICA6IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24odHdlYWtlcnNBdmFpbGFiaWxpdHksIFwiVHdlYWtlcnMgaXMgdW5hdmFpbGFibGUgZm9yIHRoaXMgcmVsZWFzZSBwcm9maWxlLlwiKSxcbiAgICAgICAgICBkaXNhYmxlZDogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgfHwgIXR3ZWFrZXJzQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKHR3ZWFrZXJzQXZhaWxhYmlsaXR5LCBcIlR3ZWFrZXJzIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcGVuZGluZy5hcHBFeHBlcmllbmNlLFxuICAgICAgKHZhbHVlKSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50Q29udHJvbGxlci5zdGFnZUFwcEV4cGVyaWVuY2UodmFsdWUgYXMgRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlKTtcbiAgICAgIH0sXG4gICAgKSk7XG5cbiAgICBjb25zdCBzdGFibGVBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwge1xuICAgICAgYXBwRXhwZXJpZW5jZTogcGVuZGluZy5hcHBFeHBlcmllbmNlLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IFwic3RhYmxlXCIsXG4gICAgfSk7XG4gICAgY29uc3QgYWxwaGFBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwge1xuICAgICAgYXBwRXhwZXJpZW5jZTogcGVuZGluZy5hcHBFeHBlcmllbmNlLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IFwiYWxwaGFcIixcbiAgICB9KTtcbiAgICBjb25zdCBzdGFibGVSZWFzb24gPSBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKHN0YWJsZUF2YWlsYWJpbGl0eSwgXCJTdGFibGUgaXMgdW5hdmFpbGFibGUgZm9yIHRoaXMgYXBwIGV4cGVyaWVuY2UuXCIpO1xuICAgIGNvbnN0IGFscGhhUmVhc29uID0gZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihhbHBoYUF2YWlsYWJpbGl0eSwgXCJBbHBoYSAoUHJlLXJlbGVhc2UpIGlzIHVuYXZhaWxhYmxlIG9uIHRoaXMgTWFjLlwiKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKGVudmlyb25tZW50Q2hvaWNlUm93KFxuICAgICAgXCJEZXNrdG9wIFJlbGVhc2VcIixcbiAgICAgIFwiQ2hvb3NlIE9wZW5BSSdzIFN0YWJsZSBvciBBbHBoYSBkZXNrdG9wIGFwcCBpbmRlcGVuZGVudGx5IG9mIGFwcCBtb2RlLiBJdHMgZW1iZWRkZWQgQ29kZXggYmFja2VuZCBjYW4gaGF2ZSBhIGRpZmZlcmVudCB2ZXJzaW9uIGxhYmVsLlwiLFxuICAgICAgW1xuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IFwic3RhYmxlXCIsXG4gICAgICAgICAgbGFiZWw6IFwiU3RhYmxlXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IHN0YWJsZUF2YWlsYWJpbGl0eS5hdmFpbGFibGUgPyBcIlRoZSBzdXBwb3J0ZWQgc3RhYmxlIGRlc2t0b3AgcmVsZWFzZS5cIiA6IHN0YWJsZVJlYXNvbixcbiAgICAgICAgICBkaXNhYmxlZDogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgfHwgIXN0YWJsZUF2YWlsYWJpbGl0eS5hdmFpbGFibGUsXG4gICAgICAgICAgZGlzYWJsZWRSZWFzb246IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICAgICAgICA/IFwiRmluaXNoLCBjYW5jZWwsIG9yIHJlY292ZXIgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gZmlyc3QuXCJcbiAgICAgICAgICAgIDogc3RhYmxlUmVhc29uLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IFwiYWxwaGFcIixcbiAgICAgICAgICBsYWJlbDogXCJBbHBoYSAoUHJlLXJlbGVhc2UpXCIsXG4gICAgICAgICAgZGVzY3JpcHRpb246IGFscGhhQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSA/IFwiT3BlbkFJJ3MgdmVyaWZpZWQgcHJlLXJlbGVhc2UgZGVza3RvcCBhbmQgbWF0Y2hpbmcgYmFja2VuZC5cIiA6IGFscGhhUmVhc29uLFxuICAgICAgICAgIGRpc2FibGVkOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZCB8fCAhYWxwaGFBdmFpbGFiaWxpdHkuYXZhaWxhYmxlLFxuICAgICAgICAgIGRpc2FibGVkUmVhc29uOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgICAgICAgPyBcIkZpbmlzaCwgY2FuY2VsLCBvciByZWNvdmVyIHRoZSBjdXJyZW50IGVudmlyb25tZW50IHRyYW5zYWN0aW9uIGZpcnN0LlwiXG4gICAgICAgICAgICA6IGFscGhhUmVhc29uLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlbmRpbmcucmVsZWFzZVByb2ZpbGUsXG4gICAgICAodmFsdWUpID0+IHtcbiAgICAgICAgZW52aXJvbm1lbnRDb250cm9sbGVyLnN0YWdlUmVsZWFzZVByb2ZpbGUodmFsdWUgYXMgRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSk7XG4gICAgICB9LFxuICAgICkpO1xuICAgIGlmICghYWxwaGFBdmFpbGFiaWxpdHkuYXZhaWxhYmxlKSB7XG4gICAgICBjb25zdCBjaG9vc2VyID0gYWN0aW9uUm93KFxuICAgICAgICBcIkFscGhhIChQcmUtcmVsZWFzZSkgdW5hdmFpbGFibGVcIixcbiAgICAgICAgYCR7YWxwaGFSZWFzb259IENob29zZSBhIHZlcmlmaWVkIE9wZW5BSSBCZXRhIGFwcCB0byByZWdpc3RlciBpdCBmb3IgdGhpcyBwcm9maWxlLmAsXG4gICAgICApO1xuICAgICAgY29uc3QgY2hvb3NlckFjdGlvbnMgPSBjaG9vc2VyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgICBjb25zdCBjaG9vc2UgPSBjb21wYWN0QnV0dG9uKFwiQ2hvb3NlIEJldGEgQXBwXHUyMDI2XCIsICgpID0+IHtcbiAgICAgICAgaWYgKGlzRW52aXJvbm1lbnRCdXN5KCkpIHJldHVybjtcbiAgICAgICAgZXh0ZXJuYWxCdXN5ID0gdHJ1ZTtcbiAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IG51bGw7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNob29zZS1hbHBoYS1lbnZpcm9ubWVudFwiKVxuICAgICAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICAgIGlmIChyZXN1bHQgJiYgdHlwZW9mIHJlc3VsdCA9PT0gXCJvYmplY3RcIiAmJiBcImNhbmNlbGVkXCIgaW4gcmVzdWx0ICYmIHJlc3VsdC5jYW5jZWxlZCA9PT0gdHJ1ZSkgcmV0dXJuO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IGBDb3VsZCBub3QgcmVnaXN0ZXIgT3BlbkFJIEJldGE6ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgICBleHRlcm5hbEJ1c3kgPSBmYWxzZTtcbiAgICAgICAgICAgIHZvaWQgbG9hZCgpO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgICBjaG9vc2UuZGlzYWJsZWQgPSBpc0Vudmlyb25tZW50QnVzeSgpO1xuICAgICAgY2hvb3NlckFjdGlvbnM/LmFwcGVuZENoaWxkKGNob29zZSk7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKGNob29zZXIpO1xuICAgIH1cblxuICAgIGNvbnN0IHN1bW1hcnkgPSBhY3Rpb25Sb3coXG4gICAgICBcIlBlbmRpbmcgY2hhbmdlc1wiLFxuICAgICAgaGFzUGVuZGluZ0NoYW5nZXMoKVxuICAgICAgICA/IHBlbmRpbmdBdmFpbGFiaWxpdHkuYXZhaWxhYmxlXG4gICAgICAgICAgPyBgJHtlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbChwZW5kaW5nLmFwcEV4cGVyaWVuY2UpfSBcdTAwQjcgJHtlbnZpcm9ubWVudFByb2ZpbGVMYWJlbChwZW5kaW5nLnJlbGVhc2VQcm9maWxlKX0gd2lsbCBhcHBseSBhZnRlciByZXN0YXJ0LmBcbiAgICAgICAgICA6IGBVbmF2YWlsYWJsZTogJHtlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKHBlbmRpbmdBdmFpbGFiaWxpdHksIFwiVGhpcyBlbnZpcm9ubWVudCBjYW5ub3QgYmUgcHJlcGFyZWQuXCIpfWBcbiAgICAgICAgOiBgQ3VycmVudDogJHtlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbChzZWxlY3RlZC5hcHBFeHBlcmllbmNlKX0gXHUwMEI3ICR7ZW52aXJvbm1lbnRQcm9maWxlTGFiZWwoc2VsZWN0ZWQucmVsZWFzZVByb2ZpbGUpfS5gLFxuICAgICk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHN1bW1hcnkucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgICBjb25zdCBhcHBseSA9IGNvbXBhY3RCdXR0b24oXCJBcHBseSAmIFJlc3RhcnRcIiwgKCkgPT4ge1xuICAgICAgaWYgKGlzRW52aXJvbm1lbnRCdXN5KCkgfHwgIWhhc1BlbmRpbmdDaGFuZ2VzKCkpIHJldHVybjtcbiAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgICAgdm9pZCBlbnZpcm9ubWVudENvbnRyb2xsZXIuYXBwbHlBbmRSZXN0YXJ0KClcbiAgICAgICAgLnRoZW4oKHJlc3VsdCkgPT4ge1xuICAgICAgICAgIGlmIChyZXN1bHQub3V0Y29tZSA9PT0gXCJwcmVwYXJlLWZhaWxlZFwiKSB7XG4gICAgICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gcmVzdWx0LmVycm9yO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAocmVzdWx0Lm91dGNvbWUuZW5kc1dpdGgoXCJmYWlsZWRcIikpIHtcbiAgICAgICAgICAgIGRyYXcoKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgdm9pZCBsb2FkRW52aXJvbm1lbnRUcmFuc2FjdGlvbigpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBhcHBseS5kaXNhYmxlZCA9IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICB8fCAhaGFzUGVuZGluZ0NoYW5nZXMoKVxuICAgICAgfHwgIXBlbmRpbmdBdmFpbGFiaWxpdHkuYXZhaWxhYmxlO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGFwcGx5KTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHN1bW1hcnkpO1xuICAgIGFwcGVuZEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coKTtcbiAgICBpZiAoZW52aXJvbm1lbnRBY3Rpb25FcnJvciAmJiBlbnZpcm9ubWVudEFjdGlvbkVycm9yICE9PSB0cmFuc2FjdGlvbj8uZXJyb3IpIHtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiRW52aXJvbm1lbnQgYWN0aW9uIGZhaWxlZFwiLCBlbnZpcm9ubWVudEFjdGlvbkVycm9yKSk7XG4gICAgfVxuICB9O1xuXG4gIGFzeW5jIGZ1bmN0aW9uIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgY29uc3QgcHJldmlvdXMgPSB0cmFuc2FjdGlvbjtcbiAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpO1xuICAgICAgaWYgKFxuICAgICAgICB0cmFuc2FjdGlvbj8ucGhhc2UgPT09IFwicHJlcGFyZWRcIlxuICAgICAgICAmJiAhdHJhbnNhY3Rpb24uaGVscGVyXG4gICAgICAgICYmIHByZXZpb3VzPy50cmFuc2FjdGlvbklkID09PSB0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkXG4gICAgICAgICYmIHByZXZpb3VzLmhlbHBlclxuICAgICAgKSB7XG4gICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgIC4uLnRyYW5zYWN0aW9uLFxuICAgICAgICAgIGVycm9yOiB0cmFuc2FjdGlvbi5lcnJvciA/PyBwcmV2aW91cy5lcnJvcixcbiAgICAgICAgICBoZWxwZXI6IHByZXZpb3VzLmhlbHBlcixcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJlc3RvcmVQZXJzaXN0ZWRSZXF1ZXN0KCk7XG4gICAgICBkcmF3KCk7XG4gICAgICBpZiAodHJhbnNhY3Rpb24gJiYgZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwodHJhbnNhY3Rpb24ucGhhc2UpKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgICAgICAgY29uc3Qgc3RhdHVzUmVzdWx0ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgICAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmRVcGRhdGVzLmlzQ3VycmVudChzdGF0dXNVcGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICAgICAgZW52aXJvbm1lbnQgPSBub3JtYWxpemVFbnZpcm9ubWVudFN0YXR1cyhzdGF0dXNSZXN1bHQpID8/IGVudmlyb25tZW50O1xuICAgICAgICAgIGNvbnN0IHNlbGVjdGVkID0gY3VycmVudFNlbGVjdGlvbigpO1xuICAgICAgICAgIGlmIChzZWxlY3RlZCkgZW52aXJvbm1lbnRDb250cm9sbGVyLnNldFNlbGVjdGVkKHNlbGVjdGVkKTtcbiAgICAgICAgICBkcmF3KCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICAgIGVycm9yOiB0cmFuc2FjdGlvbi5lcnJvciA/PyBgQ291bGQgbm90IHJlZnJlc2ggZW52aXJvbm1lbnQgc3RhdHVzOiAke3NhZmVVaUVycm9yKGVycm9yKX1gLFxuICAgICAgICAgIH07XG4gICAgICAgICAgZHJhdygpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGlmICh0cmFuc2FjdGlvbikge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IHtcbiAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICBlcnJvcjogYENvdWxkIG5vdCByZWZyZXNoIGVudmlyb25tZW50IHRyYW5zYWN0aW9uOiAke3NhZmVVaUVycm9yKGVycm9yKX1gLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgZHJhdygpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBsb2FkID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGNvbnN0IHN0YXR1c1VwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgIGNvbnN0IHRyYW5zYWN0aW9uVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgW3N0YXR1c1Jlc3VsdCwgdHJhbnNhY3Rpb25SZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC1zdGF0dXNcIiksXG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpLFxuICAgICAgXSk7XG4gICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IHN0YXR1c0lzQ3VycmVudCA9IGNhcmRVcGRhdGVzLmlzQ3VycmVudChzdGF0dXNVcGRhdGUpO1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb25Jc0N1cnJlbnQgPSBjYXJkVXBkYXRlcy5pc0N1cnJlbnQodHJhbnNhY3Rpb25VcGRhdGUpO1xuICAgICAgaWYgKCFzdGF0dXNJc0N1cnJlbnQgJiYgIXRyYW5zYWN0aW9uSXNDdXJyZW50KSByZXR1cm47XG4gICAgICBpZiAoc3RhdHVzSXNDdXJyZW50KSB7XG4gICAgICAgIGVudmlyb25tZW50ID0gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXMoc3RhdHVzUmVzdWx0KTtcbiAgICAgICAgaWYgKGVudmlyb25tZW50Py5zZWxlY3RlZCkgZW52aXJvbm1lbnRDb250cm9sbGVyLnNldFNlbGVjdGVkKGVudmlyb25tZW50LnNlbGVjdGVkKTtcbiAgICAgIH1cbiAgICAgIGlmICh0cmFuc2FjdGlvbklzQ3VycmVudCkge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24odHJhbnNhY3Rpb25SZXN1bHQpO1xuICAgICAgICByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCgpO1xuICAgICAgfVxuICAgICAgZHJhdygpO1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKSAmJiAhY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHRyYW5zYWN0aW9uVXBkYXRlKSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCBlbnZpcm9ubWVudFwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICB9XG4gIH07XG5cbiAgdm9pZCBsb2FkKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgaWYgKHRyYW5zYWN0aW9uUG9sbGluZykgY2xlYXJUaW1lb3V0KHRyYW5zYWN0aW9uUG9sbGluZyk7XG4gICAgdHJhbnNhY3Rpb25Qb2xsaW5nID0gbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvblJlcXVlc3RlZFNlbGVjdGlvbihcbiAgdHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24sXG4pOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4gfCBudWxsIHtcbiAgY29uc3QgcmVxdWVzdGVkID0gdHJhbnNhY3Rpb24ucmVxdWVzdGVkO1xuICBpZiAoIXJlcXVlc3RlZCkgcmV0dXJuIG51bGw7XG4gIGlmIChyZXF1ZXN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJjaGF0Z3B0XCIgJiYgcmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwidHdlYWtlcnNcIikgcmV0dXJuIG51bGw7XG4gIGlmIChyZXF1ZXN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwic3RhYmxlXCIgJiYgcmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcImFscGhhXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcHBFeHBlcmllbmNlOiByZXF1ZXN0ZWQuYXBwRXhwZXJpZW5jZSwgcmVsZWFzZVByb2ZpbGU6IHJlcXVlc3RlZC5yZWxlYXNlUHJvZmlsZSB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbChwaGFzZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBbXCJjb21taXR0ZWRcIiwgXCJjb21wbGV0ZWRcIiwgXCJyb2xsZWQtYmFja1wiLCBcInJvbGxlZF9iYWNrXCIsIFwiZmFpbGVkXCIsIFwiY2FuY2VsbGVkXCJdLmluY2x1ZGVzKHBoYXNlKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRDaG9pY2VSb3coXG4gIHRpdGxlOiBzdHJpbmcsXG4gIGRlc2NyaXB0aW9uOiBzdHJpbmcsXG4gIGNob2ljZXM6IEFycmF5PHsgdmFsdWU6IHN0cmluZzsgbGFiZWw6IHN0cmluZzsgZGVzY3JpcHRpb246IHN0cmluZzsgZGlzYWJsZWQ/OiBib29sZWFuOyBkaXNhYmxlZFJlYXNvbj86IHN0cmluZyB9PixcbiAgc2VsZWN0ZWQ6IHN0cmluZyxcbiAgb25DaGFuZ2U6ICh2YWx1ZTogc3RyaW5nKSA9PiB2b2lkLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1zdGFydCBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSByb3dDb3B5KHRpdGxlLCBkZXNjcmlwdGlvbik7XG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBmbGV4LXdyYXAgcm91bmRlZC1sZyBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcC0wLjVcIjtcbiAgYWN0aW9ucy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwiZ3JvdXBcIik7XG4gIGFjdGlvbnMuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB0aXRsZSk7XG4gIGZvciAoY29uc3QgY2hvaWNlIG9mIGNob2ljZXMpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBjaG9pY2UubGFiZWw7XG4gICAgYnV0dG9uLmRpc2FibGVkID0gY2hvaWNlLmRpc2FibGVkID09PSB0cnVlO1xuICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXByZXNzZWRcIiwgU3RyaW5nKGNob2ljZS52YWx1ZSA9PT0gc2VsZWN0ZWQpKTtcbiAgICBpZiAoY2hvaWNlLmRpc2FibGVkKSBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1kaXNhYmxlZFwiLCBcInRydWVcIik7XG4gICAgaWYgKGNob2ljZS5kaXNhYmxlZFJlYXNvbikgYnV0dG9uLnRpdGxlID0gY2hvaWNlLmRpc2FibGVkUmVhc29uO1xuICAgIGJ1dHRvbi5jbGFzc05hbWUgPSBgcm91bmRlZC1tZCBweC0zIHB5LTEuNSB0ZXh0LXNtIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXIgJHtjaG9pY2UudmFsdWUgPT09IHNlbGVjdGVkID8gXCJiZy10b2tlbi1iZy1wcmltYXJ5IHNoYWRvdy1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiIDogXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IGhvdmVyOnRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCJ9YDtcbiAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IG9uQ2hhbmdlKGNob2ljZS52YWx1ZSkpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgfVxuICBjb25zdCBkaXNhYmxlZFJlYXNvbiA9IGNob2ljZXMuZmluZCgoY2hvaWNlKSA9PiBjaG9pY2UuZGlzYWJsZWQgJiYgY2hvaWNlLmRpc2FibGVkUmVhc29uKT8uZGlzYWJsZWRSZWFzb247XG4gIGlmIChkaXNhYmxlZFJlYXNvbikge1xuICAgIGNvbnN0IHJlYXNvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcmVhc29uLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSB0ZXh0LXhzXCI7XG4gICAgcmVhc29uLnRleHRDb250ZW50ID0gZGlzYWJsZWRSZWFzb247XG4gICAgbGVmdC5hcHBlbmRDaGlsZChyZWFzb24pO1xuICB9XG4gIHJvdy5hcHBlbmQobGVmdCwgYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHZhbHVlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUgPT09IFwiY2hhdGdwdFwiID8gXCJDaGF0R1BUXCIgOiBcIlR3ZWFrZXJzXCI7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KFxuICBlbnZpcm9ubWVudDogRW52aXJvbm1lbnRTdGF0dXMsXG4gIHNlbGVjdGlvbjogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuKTogeyBhdmFpbGFibGU6IGJvb2xlYW47IHVuYXZhaWxhYmxlUmVhc29ucz86IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjaGFubmVsID0gZW52aXJvbm1lbnQuY2hhbm5lbHNbc2VsZWN0aW9uLnJlbGVhc2VQcm9maWxlXTtcbiAgcmV0dXJuIGNoYW5uZWwuYXZhaWxhYmlsaXR5Py5bc2VsZWN0aW9uLmFwcEV4cGVyaWVuY2VdID8/IHtcbiAgICBhdmFpbGFibGU6IGNoYW5uZWwuYXZhaWxhYmxlLFxuICAgIHVuYXZhaWxhYmxlUmVhc29uczogY2hhbm5lbC51bmF2YWlsYWJsZVJlYXNvbnMsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oXG4gIGF2YWlsYWJpbGl0eTogeyB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXSB9LFxuICBmYWxsYmFjazogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGF2YWlsYWJpbGl0eS51bmF2YWlsYWJsZVJlYXNvbnM/LmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKSB8fCBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRQcm9maWxlTGFiZWwodmFsdWU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUgPT09IFwiYWxwaGFcIiA/IFwiQWxwaGEgKFByZS1yZWxlYXNlKVwiIDogXCJTdGFibGVcIjtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXModmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudFN0YXR1cyB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRTdGF0dXM+O1xuICBjb25zdCBzZWxlY3RlZCA9IGNhbmRpZGF0ZS5zZWxlY3RlZDtcbiAgaWYgKCFzZWxlY3RlZCB8fCAoc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJjaGF0Z3B0XCIgJiYgc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSAhPT0gXCJ0d2Vha2Vyc1wiKSB8fCAoc2VsZWN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwic3RhYmxlXCIgJiYgc2VsZWN0ZWQucmVsZWFzZVByb2ZpbGUgIT09IFwiYWxwaGFcIikpIHJldHVybiBudWxsO1xuICBjb25zdCBjaGFubmVscyA9IGNhbmRpZGF0ZS5jaGFubmVscyBhcyBQYXJ0aWFsPFJlY29yZDxFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlLCBFbnZpcm9ubWVudENoYW5uZWxTdGF0dXM+PiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcmF3T2JzZXJ2YXRpb24gPSBjYW5kaWRhdGUub2JzZXJ2YXRpb247XG4gIGNvbnN0IG9ic2VydmF0aW9uID0gcmF3T2JzZXJ2YXRpb25cbiAgICAmJiAocmF3T2JzZXJ2YXRpb24uYXBwRXhwZXJpZW5jZSA9PT0gbnVsbFxuICAgICAgfHwgcmF3T2JzZXJ2YXRpb24uYXBwRXhwZXJpZW5jZSA9PT0gXCJjaGF0Z3B0XCJcbiAgICAgIHx8IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IFwidHdlYWtlcnNcIilcbiAgICA/IHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UsXG4gICAgICBzZWxlY3Rpb25EcmlmdDogcmF3T2JzZXJ2YXRpb24uc2VsZWN0aW9uRHJpZnQgPT09IHRydWUsXG4gICAgICBsaWZlY3ljbGVDb250ZW5kZWQ6IHJhd09ic2VydmF0aW9uLmxpZmVjeWNsZUNvbnRlbmRlZCA9PT0gdHJ1ZSxcbiAgICAgIGNvbW1pdEpvdXJuYWxQcmVzZW50OiByYXdPYnNlcnZhdGlvbi5jb21taXRKb3VybmFsUHJlc2VudCA9PT0gdHJ1ZSxcbiAgICAgIHRyYW5zaXRpb25Kb3VybmFsUHJlc2VudDogcmF3T2JzZXJ2YXRpb24udHJhbnNpdGlvbkpvdXJuYWxQcmVzZW50ID09PSB0cnVlLFxuICAgICAgZnJlc2huZXNzOiByYXdPYnNlcnZhdGlvbi5mcmVzaG5lc3MgPT09IFwiY29udGVuZGVkXCIgPyBcImNvbnRlbmRlZFwiIGFzIGNvbnN0IDogXCJjdXJyZW50XCIgYXMgY29uc3QsXG4gICAgfVxuICAgIDogdW5kZWZpbmVkO1xuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IDEsXG4gICAgc2VsZWN0ZWQsXG4gICAgY2hhbm5lbHM6IHtcbiAgICAgIHN0YWJsZTogY2hhbm5lbHM/LnN0YWJsZSA/PyB7IGF2YWlsYWJsZTogdHJ1ZSwgcmVsZWFzZVByb2ZpbGU6IFwic3RhYmxlXCIgfSxcbiAgICAgIGFscGhhOiBjaGFubmVscz8uYWxwaGEgPz8geyBhdmFpbGFibGU6IGZhbHNlLCB1bmF2YWlsYWJsZVJlYXNvbnM6IFtcIkFscGhhIChQcmUtcmVsZWFzZSkgYXZhaWxhYmlsaXR5IHdhcyBub3QgcmVwb3J0ZWQuXCJdLCByZWxlYXNlUHJvZmlsZTogXCJhbHBoYVwiIH0sXG4gICAgfSxcbiAgICAuLi4ob2JzZXJ2YXRpb24gPyB7IG9ic2VydmF0aW9uIH0gOiB7fSksXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24odmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uIHwgbnVsbCB7XG4gIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY2FuZGlkYXRlID0gdmFsdWUgYXMgUGFydGlhbDxFbnZpcm9ubWVudFRyYW5zYWN0aW9uPjtcbiAgaWYgKHR5cGVvZiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCAhPT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgY2FuZGlkYXRlLnBoYXNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi5jYW5kaWRhdGUsXG4gICAgdHJhbnNhY3Rpb25JZDogY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQsXG4gICAgcGhhc2U6IGNhbmRpZGF0ZS5waGFzZSxcbiAgICBlcnJvcjogdHlwZW9mIGNhbmRpZGF0ZS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGNhbmRpZGF0ZS5lcnJvciA6IG51bGwsXG4gIH07XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbih2YWx1ZTogdW5rbm93bik6IEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbiB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uPiAmIHsga2luZD86IHVua25vd24gfTtcbiAgaWYgKGNhbmRpZGF0ZS5raW5kICE9PSBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIikgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBpZiAoY2FuZGlkYXRlLnBoYXNlICE9PSBcInN1Ym1pdHRlZFwiICYmIGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdWJtaXQtZmFpbGVkXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiZW52aXJvbm1lbnQtY29tbWl0LWhlbHBlclwiLFxuICAgIHRyYW5zYWN0aW9uSWQ6IGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gICAgZXJyb3I6IHR5cGVvZiBjYW5kaWRhdGUuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBjYW5kaWRhdGUuZXJyb3IgOiBudWxsLFxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudEhlbHBlcklzSW5GbGlnaHQodHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBib29sZWFuIHtcbiAgY29uc3QgaGVscGVyID0gdHJhbnNhY3Rpb24uaGVscGVyO1xuICBjb25zdCBvdXRjb21lUGhhc2UgPSBoZWxwZXI/Lm91dGNvbWU/LnBoYXNlO1xuICByZXR1cm4gb3V0Y29tZVBoYXNlID09PSBcIm5vdC1zdGFydGVkXCJcbiAgICB8fCBvdXRjb21lUGhhc2UgPT09IFwicnVubmluZ1wiXG4gICAgfHwgKGhlbHBlcj8uc3VibWlzc2lvbj8ucGhhc2UgPT09IFwic3VibWl0dGVkXCIgJiYgb3V0Y29tZVBoYXNlID09PSB1bmRlZmluZWQpO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3Zlcih0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IGJvb2xlYW4ge1xuICBpZiAodHJhbnNhY3Rpb24ucGhhc2UgPT09IFwiZmFpbGVkXCIpIHJldHVybiB0cmFuc2FjdGlvbi5wcmVwYXJlZCAhPT0gbnVsbCAmJiB0cmFuc2FjdGlvbi5wcmVwYXJlZCAhPT0gdW5kZWZpbmVkO1xuICByZXR1cm4gW1wiY29tbWl0dGluZ1wiLCBcImFwcGx5aW5nXCIsIFwicmVvcGVuaW5nXCIsIFwidmVyaWZ5aW5nXCIsIFwicm9sbGluZy1iYWNrXCJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnBoYXNlKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJGYWlsdXJlRGV0YWlsKHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IGhlbHBlciA9IHRyYW5zYWN0aW9uLmhlbHBlcjtcbiAgaWYgKCFoZWxwZXIpIHJldHVybiBudWxsO1xuICBjb25zdCBvdXRjb21lID0gaGVscGVyLm91dGNvbWU7XG4gIGNvbnN0IHN1Ym1pc3Npb24gPSBoZWxwZXIuc3VibWlzc2lvbjtcbiAgY29uc3QgZmFpbGVkID0gb3V0Y29tZT8ucGhhc2UgPT09IFwiZmFpbGVkXCJcbiAgICB8fCBzdWJtaXNzaW9uPy5waGFzZSA9PT0gXCJzdWJtaXQtZmFpbGVkXCJcbiAgICB8fCB0eXBlb2Ygb3V0Y29tZT8uZXJyb3IgPT09IFwic3RyaW5nXCJcbiAgICB8fCB0eXBlb2Ygc3VibWlzc2lvbj8uZXJyb3IgPT09IFwic3RyaW5nXCI7XG4gIGlmICghZmFpbGVkKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3RkZXJyID0gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KGhlbHBlci5zdGRlcnIpO1xuICBjb25zdCBzdGRvdXQgPSBlbnZpcm9ubWVudEhlbHBlckxvZ1NuaXBwZXQoaGVscGVyLnN0ZG91dCk7XG4gIGNvbnN0IGV4aXRDb2RlID0gdHlwZW9mIG91dGNvbWU/LmV4aXRDb2RlID09PSBcIm51bWJlclwiID8gYGV4aXQgJHtvdXRjb21lLmV4aXRDb2RlfWAgOiBudWxsO1xuICBjb25zdCBkZXRhaWwgPSBbXG4gICAgXCJFbnZpcm9ubWVudCBoZWxwZXIgZmFpbGVkXCIsXG4gICAgZXhpdENvZGUsXG4gICAgb3V0Y29tZT8uZXJyb3IsXG4gICAgc3VibWlzc2lvbj8uZXJyb3IsXG4gICAgc3RkZXJyID8gYHN0ZGVycjogJHtzdGRlcnJ9YCA6IG51bGwsXG4gICAgIXN0ZGVyciAmJiBzdGRvdXQgPyBgc3Rkb3V0OiAke3N0ZG91dH1gIDogbnVsbCxcbiAgXS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS5sZW5ndGggPiAwKTtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KGRldGFpbCldLmpvaW4oXCIgXHUwMEI3IFwiKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjb21wYWN0ID0gdmFsdWUudHJpbSgpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpO1xuICBpZiAoIWNvbXBhY3QpIHJldHVybiBudWxsO1xuICByZXR1cm4gY29tcGFjdC5sZW5ndGggPD0gNjAwID8gY29tcGFjdCA6IGBcdTIwMjYke2NvbXBhY3Quc2xpY2UoLTU5OSl9YDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3dBY3Rpb25zIHtcbiAgYnVzeTogYm9vbGVhbjtcbiAgb25SZXN1bWU/OiAoKSA9PiB2b2lkO1xuICBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG4gIG9uUmVjb3Zlcj86ICgpID0+IHZvaWQ7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coXG4gIHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuICBhY3Rpb25zQ29uZmlnPzogRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvd0FjdGlvbnMsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlbHBlckZhaWx1cmUgPSBlbnZpcm9ubWVudEhlbHBlckZhaWx1cmVEZXRhaWwodHJhbnNhY3Rpb24pO1xuICBjb25zdCBkZXRhaWxzID0gW1xuICAgIGVudmlyb25tZW50VHJhbnNhY3Rpb25MYWJlbCh0cmFuc2FjdGlvbi5waGFzZSksXG4gICAgdHJhbnNhY3Rpb24uZXJyb3IsXG4gICAgaGVscGVyRmFpbHVyZSxcbiAgXS5maWx0ZXIoKHZhbHVlKTogdmFsdWUgaXMgc3RyaW5nID0+IHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS5sZW5ndGggPiAwKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiQXBwIG1vZGUgcmVzdGFydFwiLFxuICAgIFsuLi5uZXcgU2V0KGRldGFpbHMpXS5qb2luKFwiIFx1MDBCNyBcIiksXG4gICk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCkgbGVmdC5wcmVwZW5kKHN0YXR1c0JhZGdlKGVudmlyb25tZW50VHJhbnNhY3Rpb25Ub25lKHRyYW5zYWN0aW9uLnBoYXNlKSwgZW52aXJvbm1lbnRUcmFuc2FjdGlvbkxhYmVsKHRyYW5zYWN0aW9uLnBoYXNlKSkpO1xuICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGlmIChhY3Rpb25zQ29uZmlnPy5vblJlc3VtZSkge1xuICAgIGNvbnN0IHJlc3VtZSA9IGNvbXBhY3RCdXR0b24oXCJSZXN1bWUvQ29uZmlybVwiLCBhY3Rpb25zQ29uZmlnLm9uUmVzdW1lKTtcbiAgICByZXN1bWUuZGlzYWJsZWQgPSBhY3Rpb25zQ29uZmlnLmJ1c3k7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQocmVzdW1lKTtcbiAgfVxuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25DYW5jZWwpIHtcbiAgICBjb25zdCBjYW5jZWwgPSBjb21wYWN0QnV0dG9uKFwiQ2FuY2VsXCIsIGFjdGlvbnNDb25maWcub25DYW5jZWwpO1xuICAgIGNhbmNlbC5kaXNhYmxlZCA9IGFjdGlvbnNDb25maWcuYnVzeTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjYW5jZWwpO1xuICB9XG4gIGlmIChhY3Rpb25zQ29uZmlnPy5vblJlY292ZXIpIHtcbiAgICBjb25zdCByZWNvdmVyID0gY29tcGFjdEJ1dHRvbihcIlJlY292ZXIgU2FmZWx5XCIsIGFjdGlvbnNDb25maWcub25SZWNvdmVyKTtcbiAgICByZWNvdmVyLmRpc2FibGVkID0gYWN0aW9uc0NvbmZpZy5idXN5O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJlY292ZXIpO1xuICB9XG4gIHJvdy50aXRsZSA9IGBUcmFuc2FjdGlvbiAke3RyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWR9YDtcbiAgcm93LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzdGF0dXNcIik7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxpdmVcIiwgXCJwb2xpdGVcIik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25MYWJlbChwaGFzZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgc3dpdGNoIChwaGFzZSkge1xuICAgIGNhc2UgXCJjb21taXR0ZWRcIjpcbiAgICBjYXNlIFwiY29tcGxldGVkXCI6XG4gICAgICByZXR1cm4gXCJDb21wbGV0ZWRcIjtcbiAgICBjYXNlIFwicm9sbGVkLWJhY2tcIjpcbiAgICBjYXNlIFwicm9sbGVkX2JhY2tcIjpcbiAgICAgIHJldHVybiBcIlJvbGxlZCBiYWNrXCI7XG4gICAgY2FzZSBcImNhbmNlbGxlZFwiOlxuICAgICAgcmV0dXJuIFwiQ2FuY2VsbGVkXCI7XG4gICAgY2FzZSBcImZhaWxlZFwiOlxuICAgICAgcmV0dXJuIFwiRmFpbGVkXCI7XG4gICAgY2FzZSBcInByZXBhcmVkXCI6XG4gICAgICByZXR1cm4gXCJQcmVwYXJlZFwiO1xuICAgIGNhc2UgXCJwcmVwYXJpbmdcIjpcbiAgICAgIHJldHVybiBcIlByZXBhcmluZ1wiO1xuICAgIGNhc2UgXCJjb21taXR0aW5nXCI6XG4gICAgICByZXR1cm4gXCJDb21taXR0aW5nXCI7XG4gICAgY2FzZSBcInJlb3BlbmluZ1wiOlxuICAgICAgcmV0dXJuIFwiUmVvcGVuaW5nXCI7XG4gICAgY2FzZSBcInZlcmlmeWluZ1wiOlxuICAgICAgcmV0dXJuIFwiVmVyaWZ5aW5nXCI7XG4gICAgY2FzZSBcInJvbGxpbmctYmFja1wiOlxuICAgICAgcmV0dXJuIFwiUm9sbGluZyBiYWNrXCI7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBodW1hbml6ZUNvZGV4UGhhc2UocGhhc2UpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25Ub25lKHBoYXNlOiBzdHJpbmcpOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiB7XG4gIGlmIChwaGFzZSA9PT0gXCJjb21taXR0ZWRcIiB8fCBwaGFzZSA9PT0gXCJjb21wbGV0ZWRcIikgcmV0dXJuIFwib2tcIjtcbiAgaWYgKHBoYXNlID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJlcnJvclwiO1xuICByZXR1cm4gXCJ3YXJuXCI7XG59XG5cbi8qKiBPbmUgc2hhcmVkLCBhY2Nlc3NpYmxlIGNvbmZpcm1hdGlvbiBhZnRlciBwcmVwYXJlOyBDYW5jZWwgbmV2ZXIgY29tbWl0cy4gKi9cbmZ1bmN0aW9uIG9wZW5FbnZpcm9ubWVudENvbmZpcm1Nb2RhbChcbiAgcmVxdWVzdGVkOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4sXG4gIHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuKTogUHJvbWlzZTxFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uPiB7XG4gIGNvbnN0IG9wZW5lciA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgOiBudWxsO1xuICBjb25zdCByZXN0b3JlRm9jdXMgPSAoKTogdm9pZCA9PiB7XG4gICAgcmVzdG9yZUVudmlyb25tZW50Rm9jdXMoXG4gICAgICBvcGVuZXIsXG4gICAgICAoKSA9PiBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItZW52aXJvbm1lbnQtY2FyZF0gYnV0dG9uOm5vdChbZGlzYWJsZWRdKVwiKSxcbiAgICApO1xuICB9O1xuICBsZXQgcmVzb2x2ZURlY2lzaW9uITogKGRlY2lzaW9uOiBFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uKSA9PiB2b2lkO1xuICBjb25zdCBkZWNpc2lvbiA9IG5ldyBQcm9taXNlPEVudmlyb25tZW50Q29uZmlybWF0aW9uRGVjaXNpb24+KChyZXNvbHZlUHJvbWlzZSkgPT4ge1xuICAgIHJlc29sdmVEZWNpc2lvbiA9IHJlc29sdmVQcm9taXNlO1xuICB9KTtcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuZGF0YXNldC50d2Vha2VyRW52aXJvbm1lbnRNb2RhbCA9IFwidHJ1ZVwiO1xuICBvdmVybGF5LmNsYXNzTmFtZSA9IFwiZml4ZWQgaW5zZXQtMCB6LVs5OTk5XSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBwLTRcIjtcbiAgY29uc3QgZGlhbG9nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJkaWFsb2dcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLW1vZGFsXCIsIFwidHJ1ZVwiKTtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxsZWRieVwiLCBcInR3ZWFrZXItZW52aXJvbm1lbnQtY29uZmlybS10aXRsZVwiKTtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcImFyaWEtZGVzY3JpYmVkYnlcIiwgXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tYm9keVwiKTtcbiAgZGlhbG9nLmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IHctZnVsbCBtYXgtdy1tZCBmbGV4LWNvbCBnYXAtNCByb3VuZGVkLTJ4bCBib3JkZXIgcC01IHNoYWRvdy14bFwiO1xuICBkaWFsb2cuc2V0QXR0cmlidXRlKFwic3R5bGVcIiwgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIik7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmlkID0gXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tdGl0bGVcIjtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBjb25zdCBleHBlcmllbmNlID0gZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwocmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UpO1xuICBoZWFkaW5nLnRleHRDb250ZW50ID0gYFN3aXRjaCB0byAke2V4cGVyaWVuY2V9IGFuZCByZXN0YXJ0P2A7XG4gIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBib2R5LmlkID0gXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tYm9keVwiO1xuICBib2R5LmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHRyYW5zYWN0aW9uLnByZXBhcmVkPy5jYW5kaWRhdGU7XG4gIGNvbnN0IGJhY2tlbmQgPSB0cmFuc2FjdGlvbi5wcmVwYXJlZD8uYmFja2VuZDtcbiAgY29uc3Qgcm9sbGJhY2sgPSB0cmFuc2FjdGlvbi5wcmVwYXJlZD8ucm9sbGJhY2s7XG4gIGNvbnN0IHRhcmdldCA9IGNhbmRpZGF0ZT8uZGVza3RvcFBhdGhcbiAgICA/IGAke2NhbmRpZGF0ZS5kZXNrdG9wUGF0aH0ke2NhbmRpZGF0ZS52ZXJzaW9uID8gYCAoJHtjYW5kaWRhdGUudmVyc2lvbn0ke2NhbmRpZGF0ZS5idWlsZCA/IGAsIGJ1aWxkICR7Y2FuZGlkYXRlLmJ1aWxkfWAgOiBcIlwifSlgIDogXCJcIn1gXG4gICAgOiBlbnZpcm9ubWVudFByb2ZpbGVMYWJlbChyZXF1ZXN0ZWQucmVsZWFzZVByb2ZpbGUpO1xuICBjb25zdCBiYWNrZW5kVGFyZ2V0ID0gYmFja2VuZD8ubGFuZVxuICAgID8gYCR7YmFja2VuZC5sYW5lfSR7YmFja2VuZC52ZXJzaW9uID8gYCAke2JhY2tlbmQudmVyc2lvbn1gIDogXCJcIn1gXG4gICAgOiBcInRoZSB2ZXJpZmllZCBiYWNrZW5kIGZvciB0aGlzIGVudmlyb25tZW50XCI7XG4gIGNvbnN0IHJvbGxiYWNrVGFyZ2V0ID0gcm9sbGJhY2s/LmRlc2t0b3BQYXRoXG4gICAgPz8gcm9sbGJhY2s/LnNlbGVjdGlvbj8uc2VsZWN0ZWREZXNrdG9wUGF0aFxuICAgID8/IFwidGhlIGxhc3Qga25vd24gd29ya2luZyBlbnZpcm9ubWVudFwiO1xuICBjb25zdCBtb2RlRWZmZWN0ID0gcmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UgPT09IFwidHdlYWtlcnNcIlxuICAgID8gXCJDaGF0R1BUIHdpbGwgY2xvc2UsIHJlb3BlbiBpbiBUd2Vha2VycyBtb2RlLCBhbmQgcmVzdG9yZSB5b3VyIHByZXZpb3VzbHkgZW5hYmxlZCB0d2Vha3MuXCJcbiAgICA6IFwiQ2hhdEdQVCB3aWxsIGNsb3NlIGFuZCByZW9wZW4gaW4gc3RhbmRhcmQgbW9kZS4gQWxsIHR3ZWFrcyB3aWxsIGJlIGRpc2FibGVkLCBidXQgdGhlaXIgc2F2ZWQgc2V0dGluZ3Mgd2lsbCByZW1haW4gYXZhaWxhYmxlIGZvciBUd2Vha2VycyBtb2RlLlwiO1xuICBib2R5LnRleHRDb250ZW50ID0gW1xuICAgIG1vZGVFZmZlY3QsXG4gICAgYERlc2t0b3A6ICR7dGFyZ2V0fS4gRW1iZWRkZWQgQ29kZXggYmFja2VuZDogJHtiYWNrZW5kVGFyZ2V0fS5gLFxuICAgIGBJZiByZXN0YXJ0IHZlcmlmaWNhdGlvbiBmYWlscywgVHdlYWtlcnMgd2lsbCByZXN0b3JlIHRoZSBsYXN0IGtub3duIHdvcmtpbmcgZW52aXJvbm1lbnQgYXQgJHtyb2xsYmFja1RhcmdldH0uYCxcbiAgXS5qb2luKFwiXFxuXCIpO1xuICBib2R5LnN0eWxlLndoaXRlU3BhY2UgPSBcInByZS1saW5lXCI7XG4gIGNvbnN0IGJ1dHRvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBidXR0b25zLmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgbGV0IHNldHRsZWQgPSBmYWxzZTtcbiAgY29uc3QgY2xvc2UgPSAob3V0Y29tZTogXCJjb25maXJtXCIgfCBcImNhbmNlbFwiKTogdm9pZCA9PiB7XG4gICAgaWYgKHNldHRsZWQpIHJldHVybjtcbiAgICBzZXR0bGVkID0gdHJ1ZTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICAgIG92ZXJsYXkucmVtb3ZlKCk7XG4gICAgcmVzb2x2ZURlY2lzaW9uKG91dGNvbWUpO1xuICAgIHdpbmRvdy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmVzdG9yZUZvY3VzKTtcbiAgfTtcbiAgY29uc3Qgb25LZXlkb3duID0gKGV2ZW50OiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKGV2ZW50LmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgICAgY2xvc2UoXCJjYW5jZWxcIik7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChldmVudC5rZXkgIT09IFwiVGFiXCIpIHJldHVybjtcbiAgICBjb25zdCBmb2N1c2FibGUgPSBbY2FuY2VsLCBjb25maXJtXTtcbiAgICBjb25zdCBjdXJyZW50SW5kZXggPSBmb2N1c2FibGUuaW5kZXhPZihkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxCdXR0b25FbGVtZW50KTtcbiAgICBjb25zdCBuZXh0SW5kZXggPSBldmVudC5zaGlmdEtleVxuICAgICAgPyAoY3VycmVudEluZGV4IDw9IDAgPyBmb2N1c2FibGUubGVuZ3RoIC0gMSA6IGN1cnJlbnRJbmRleCAtIDEpXG4gICAgICA6IChjdXJyZW50SW5kZXggPCAwIHx8IGN1cnJlbnRJbmRleCA9PT0gZm9jdXNhYmxlLmxlbmd0aCAtIDEgPyAwIDogY3VycmVudEluZGV4ICsgMSk7XG4gICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICBmb2N1c2FibGVbbmV4dEluZGV4XT8uZm9jdXMoKTtcbiAgfTtcbiAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCAoKSA9PiBjbG9zZShcImNhbmNlbFwiKSk7XG4gIGNvbnN0IGNvbmZpcm0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBjb25maXJtLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjb25maXJtLmNsYXNzTmFtZSA9IFwidXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYmctdG9rZW4tY2hhcnRzLWJsdWUgcHgtMyB0ZXh0LXNtIHRleHQtd2hpdGUgZW5hYmxlZDpob3ZlcjpvcGFjaXR5LTkwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgY29uZmlybS50ZXh0Q29udGVudCA9IFwiQXBwbHkgJiBSZXN0YXJ0XCI7XG4gIGNvbmZpcm0uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChldmVudCkgPT4ge1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgY2xvc2UoXCJjb25maXJtXCIpO1xuICB9KTtcbiAgYnV0dG9ucy5hcHBlbmQoY2FuY2VsLCBjb25maXJtKTtcbiAgZGlhbG9nLmFwcGVuZChoZWFkaW5nLCBib2R5LCBidXR0b25zKTtcbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChkaWFsb2cpO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuICBjb25maXJtLmZvY3VzKCk7XG4gIHJldHVybiBkZWNpc2lvbjtcbn1cblxuZnVuY3Rpb24gcmVuZGVyRGVza3RvcFVwZGF0ZVNlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIGNhcmRVcGRhdGVzOiBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4sXG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkRlc2t0b3AgVXBkYXRlXCIpKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC50d2Vha2VyRGVza3RvcFVwZGF0ZUNhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIGRlc2t0b3AgdXBkYXRlXCIsIFwiQ2hlY2tpbmcgdGhlIHNpZ25lZCBDb2RleCBhcHBjYXN0LlwiKSk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICBsZXQgY3VycmVudDogRGVza3RvcFVwZGF0ZUNoZWNrUmVzdWx0IHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvbjogRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGUgfCBudWxsID0gbnVsbDtcbiAgbGV0IGJ1c3kgPSBmYWxzZTtcbiAgbGV0IHBvbGxpbmc6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvblBvbGxGYWlsdXJlcyA9IDA7XG4gIGxldCBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsID0gMDtcbiAgbGV0IGluaXRpYWxSZXN1bHRTdXBlcnNlZGVkID0gZmFsc2U7XG5cbiAgY29uc3QgdHJhbnNhY3Rpb25Jc0FjdGl2ZSA9ICgpOiBib29sZWFuID0+IHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkKSB7XG4gICAgICByZXR1cm4gdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmluZ1wiICYmIERhdGUubm93KCkgPCBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsO1xuICAgIH1cbiAgICByZXR1cm4gIVtcImNvbXBsZXRlZFwiLCBcImZhaWxlZFwiLCBcInJvbGxlZF9iYWNrXCJdLmluY2x1ZGVzKHRyYW5zYWN0aW9uLnBoYXNlKTtcbiAgfTtcbiAgY29uc3Qgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwgPSAoZGVsYXlNcyA9IDJfMDAwKTogdm9pZCA9PiB7XG4gICAgaWYgKHBvbGxpbmcpIGNsZWFyVGltZW91dChwb2xsaW5nKTtcbiAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQgfHwgKCF0cmFuc2FjdGlvbklzQWN0aXZlKCkgJiYgdHJhbnNhY3Rpb24/LnJlc3VtYWJsZSAhPT0gdHJ1ZSkpIHJldHVybjtcbiAgICBwb2xsaW5nID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBwb2xsaW5nID0gbnVsbDtcbiAgICAgIHZvaWQgbG9hZFRyYW5zYWN0aW9uKCk7XG4gICAgfSwgZGVsYXlNcyk7XG4gIH07XG4gIGNvbnN0IGxvYWRUcmFuc2FjdGlvbiA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImRlc2t0b3AtdXBkYXRlLXRyYW5zYWN0aW9uXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvZGV4LWRlc2t0b3AtdXBkYXRlLXRyYW5zYWN0aW9uXCIpO1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgY29uc3Qgb2JzZXJ2ZWQgPSBub3JtYWxpemVEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb24odmFsdWUpO1xuICAgICAgaWYgKG9ic2VydmVkPy5waGFzZSA9PT0gXCJpZGxlXCJcbiAgICAgICAgJiYgb2JzZXJ2ZWQudHJhbnNhY3Rpb25JZCA9PT0gbnVsbFxuICAgICAgICAmJiB0cmFuc2FjdGlvbj8ucGhhc2UgPT09IFwicHJlcGFyaW5nXCJcbiAgICAgICAgJiYgdHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZCA9PT0gbnVsbCkge1xuICAgICAgICBpZiAoRGF0ZS5ub3coKSA+PSBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsKSB7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgICB0cmFuc2FjdGlvbklkOiBudWxsLFxuICAgICAgICAgICAgcGhhc2U6IFwiZmFpbGVkXCIsXG4gICAgICAgICAgICBlcnJvcjogXCJUaGUgZGVza3RvcCB1cGRhdGVyIGRpZCBub3QgY3JlYXRlIGEgdHJhbnNhY3Rpb24gcmVjZWlwdC5cIixcbiAgICAgICAgICB9O1xuICAgICAgICB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IG9ic2VydmVkO1xuICAgICAgICBpZiAodHJhbnNhY3Rpb24/LnRyYW5zYWN0aW9uSWQpIGF3YWl0aW5nVHJhbnNhY3Rpb25SZWNlaXB0VW50aWwgPSAwO1xuICAgICAgfVxuICAgICAgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgPSAwO1xuICAgICAgZHJhdygpO1xuICAgICAgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQodXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgIHRyYW5zYWN0aW9uSWQ6IHRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkID8/IG51bGwsXG4gICAgICAgIHBoYXNlOiB0cmFuc2FjdGlvbj8ucGhhc2UgPz8gXCJwcmVwYXJpbmdcIixcbiAgICAgICAgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgIH07XG4gICAgICBkcmF3KCk7XG4gICAgICB0cmFuc2FjdGlvblBvbGxGYWlsdXJlcyArPSAxO1xuICAgICAgY29uc3QgYmFja29mZiA9IE1hdGgubWluKDMwXzAwMCwgMV8wMDAgKiAoMiAqKiBNYXRoLm1pbih0cmFuc2FjdGlvblBvbGxGYWlsdXJlcyAtIDEsIDUpKSk7XG4gICAgICBjb25zdCBqaXR0ZXIgPSBNYXRoLmZsb29yKGJhY2tvZmYgKiAwLjI1ICogTWF0aC5yYW5kb20oKSk7XG4gICAgICBzY2hlZHVsZVRyYW5zYWN0aW9uUG9sbChiYWNrb2ZmICsgaml0dGVyKTtcbiAgICB9XG4gIH07XG4gIGNvbnN0IGRyYXcgPSAoKTogdm9pZCA9PiB7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgY29uc3QgcmVzdWx0ID0gY3VycmVudDtcbiAgICBjb25zdCBpbnN0YWxsZWQgPSByZXN1bHQ/Lmluc3RhbGxlZD8ubWFya2V0aW5nVmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gICAgY29uc3QgbGF0ZXN0ID0gcmVzdWx0Py5sYXRlc3Q/Lm1hcmtldGluZ1ZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICAgIGNvbnN0IHN0YXR1cyA9IGRlc2t0b3BVcGRhdGVTdGF0dXNQcmVzZW50YXRpb24ocmVzdWx0Py5zdGF0dXMpO1xuICAgIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkNoYXRHUFQgRGVza3RvcFwiLCBgSW5zdGFsbGVkICR7aW5zdGFsbGVkfSBcdTAwQjcgTGF0ZXN0ICR7bGF0ZXN0fSR7cmVzdWx0Py5yZWFzb24gPyBgIFx1MDBCNyAke3Jlc3VsdC5yZWFzb259YCA6IFwiXCJ9YCk7XG4gICAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgbGVmdD8ucHJlcGVuZChzdGF0dXNCYWRnZShzdGF0dXMudG9uZSwgc3RhdHVzLmxhYmVsKSk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGNvbnN0IGNoZWNrID0gY29tcGFjdEJ1dHRvbihcIkNoZWNrIGZvciBVcGRhdGVzXHUyMDI2XCIsICgpID0+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgIGNoZWNrLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjaGVjay1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigodmFsdWUpID0+IHtcbiAgICAgICAgICBjb25zdCByZXN1bHQgPSB2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQ7XG4gICAgICAgICAgYWNjZXB0RGVza3RvcFVwZGF0ZVJlc3VsdChyZXN1bHQpO1xuICAgICAgICAgIGlmIChyZXN1bHQudXBkYXRlQW5kUmVsb2FkUmVxdWVzdGVkKSB7XG4gICAgICAgICAgICBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsID0gRGF0ZS5ub3coKSArIDEwXzAwMDtcbiAgICAgICAgICAgIHRyYW5zYWN0aW9uID0geyB0cmFuc2FjdGlvbklkOiBudWxsLCBwaGFzZTogXCJwcmVwYXJpbmdcIiB9O1xuICAgICAgICAgICAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHsgY3VycmVudCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIHJlYXNvbjogc2FmZVVpRXJyb3IoZXJyb3IpIH07IH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHsgYnVzeSA9IGZhbHNlOyBkcmF3KCk7IH0pO1xuICAgIH0pO1xuICAgIGNoZWNrLmRpc2FibGVkID0gYnVzeSB8fCAhIXJlc3VsdD8uc2V0dXBSZXF1aXJlZDtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjaGVjayk7XG4gICAgY29uc3QgdXBkYXRlID0gY29tcGFjdEJ1dHRvbihcIlVwZGF0ZSBhbmQgUmVsb2FkXCIsICgpID0+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgIHVwZGF0ZS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c3RhcnQtY29kZXgtZGVza3RvcC11cGRhdGVcIilcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIGF3YWl0aW5nVHJhbnNhY3Rpb25SZWNlaXB0VW50aWwgPSBEYXRlLm5vdygpICsgMTBfMDAwO1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0geyB0cmFuc2FjdGlvbklkOiBudWxsLCBwaGFzZTogXCJwcmVwYXJpbmdcIiB9O1xuICAgICAgICAgIHZvaWQgbG9hZFRyYW5zYWN0aW9uKCk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHsgY3VycmVudCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIHJlYXNvbjogc2FmZVVpRXJyb3IoZXJyb3IpIH07IH0pXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHsgYnVzeSA9IGZhbHNlOyBkcmF3KCk7IH0pO1xuICAgIH0pO1xuICAgIHVwZGF0ZS5kaXNhYmxlZCA9IGJ1c3lcbiAgICAgIHx8IHJlc3VsdD8uc3RhdHVzICE9PSBcInVwZGF0ZS1hdmFpbGFibGVcIlxuICAgICAgfHwgdHJhbnNhY3Rpb25Jc0FjdGl2ZSgpXG4gICAgICB8fCB0cmFuc2FjdGlvbj8ucmVzdW1hYmxlID09PSB0cnVlO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIGlmIChyZXN1bHQ/LnNldHVwUmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IHNldHVwTGFiZWwgPSByZXN1bHQuc2V0dXBSZXF1aXJlZCA9PT0gXCJyZWdpc3Rlci1iZXRhXCJcbiAgICAgICAgPyBcIlJlZ2lzdGVyIE9wZW5BSSBCZXRhXCJcbiAgICAgICAgOiBcIkxhdW5jaCBPcGVuQUkgQmV0YSBvbmNlXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgYEFscGhhIHVwZGF0ZSBzZXR1cCBcdTAwQjcgJHtzZXR1cExhYmVsfWAsXG4gICAgICAgIHJlc3VsdC5yZWFzb24gPz8gXCJBbHBoYSB1cGRhdGUgY2hlY2tzIHN0YXkgZGlzYWJsZWQgdW50aWwgVHdlYWtlcnMgY2FwdHVyZXMgdGhlIHJlZ2lzdGVyZWQgQmV0YSBhcHAncyBvd24gZmVlZC5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAocmVzdWx0Py5jaGVja2VkQXQpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKHJlc3VsdC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCkpKTtcbiAgICBpZiAodHJhbnNhY3Rpb24pIGNhcmQuYXBwZW5kQ2hpbGQoZGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uUm93KHRyYW5zYWN0aW9uLCB7XG4gICAgICBidXN5LFxuICAgICAgb25SZXN1bWU6ICgpID0+IHtcbiAgICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgICAgYnVzeSA9IHRydWU7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlc3VtZS1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgICAgIHRyYW5zYWN0aW9uID0gdHJhbnNhY3Rpb24gPyB7IC4uLnRyYW5zYWN0aW9uLCBwaGFzZTogXCJhd2FpdGluZ19uYXRpdmVfdXBkYXRlXCIsIHJlc3VtYWJsZTogZmFsc2UgfSA6IHRyYW5zYWN0aW9uO1xuICAgICAgICAgICAgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmICh0cmFuc2FjdGlvbikgdHJhbnNhY3Rpb24gPSB7IC4uLnRyYW5zYWN0aW9uLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7IGJ1c3kgPSBmYWxzZTsgZHJhdygpOyB9KTtcbiAgICAgIH0sXG4gICAgICBvbkNhbmNlbDogKCkgPT4ge1xuICAgICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2FuY2VsLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgICAgLnRoZW4oKHZhbHVlKSA9PiB7IHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlKSA/PyB0cmFuc2FjdGlvbjsgfSlcbiAgICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgICBpZiAodHJhbnNhY3Rpb24pIHRyYW5zYWN0aW9uID0geyAuLi50cmFuc2FjdGlvbiwgZXJyb3I6IHNhZmVVaUVycm9yKGVycm9yKSB9O1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgICB9LFxuICAgIH0pKTtcbiAgfTtcbiAgZHJhdygpO1xuICBjb25zdCBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0ID0gKHZhbHVlOiBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpOiB2b2lkID0+IHtcbiAgICBjb25zdCBjdXJyZW50VGltZSA9IGN1cnJlbnQ/LmNoZWNrZWRBdCA/IERhdGUucGFyc2UoY3VycmVudC5jaGVja2VkQXQpIDogTnVtYmVyLk5hTjtcbiAgICBjb25zdCBuZXh0VGltZSA9IHZhbHVlLmNoZWNrZWRBdCA/IERhdGUucGFyc2UodmFsdWUuY2hlY2tlZEF0KSA6IE51bWJlci5OYU47XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZShjdXJyZW50VGltZSkgJiYgKCFOdW1iZXIuaXNGaW5pdGUobmV4dFRpbWUpIHx8IG5leHRUaW1lIDwgY3VycmVudFRpbWUpKSByZXR1cm47XG4gICAgY3VycmVudCA9IHZhbHVlO1xuICAgIGRyYXcoKTtcbiAgfTtcbiAgY29uc3Qgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCA9IChfZXZlbnQ6IHVua25vd24sIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSB7XG4gICAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaW5pdGlhbFJlc3VsdFN1cGVyc2VkZWQgPSB0cnVlO1xuICAgIGFjY2VwdERlc2t0b3BVcGRhdGVSZXN1bHQodmFsdWUgYXMgRGVza3RvcFVwZGF0ZUNoZWNrUmVzdWx0KTtcbiAgfTtcbiAgaXBjUmVuZGVyZXIub24oXCJ0d2Vha2VyOmNvZGV4LWRlc2t0b3AtdXBkYXRlLWNoYW5nZWRcIiwgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCk7XG4gIGNvbnN0IGN1cnJlbnRVcGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImRlc2t0b3AtdXBkYXRlLXJlc3VsdFwiKTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgaWYgKCFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoY3VycmVudFVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQgfHwgaW5pdGlhbFJlc3VsdFN1cGVyc2VkZWQpIHJldHVybjtcbiAgICAgIGlmICh2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgYWNjZXB0RGVza3RvcFVwZGF0ZVJlc3VsdCh2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY3VycmVudCA9IHsgc3RhdHVzOiBcInVuYXZhaWxhYmxlXCIsIHJlYXNvbjogXCJVcGRhdGUgc3RhdHVzIGhhcyBub3QgYmVlbiBjaGVja2VkIHlldC5cIiB9O1xuICAgICAgICBkcmF3KCk7XG4gICAgICB9XG4gICAgfSlcbiAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudChjdXJyZW50VXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgY3VycmVudCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIHJlYXNvbjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICBkcmF3KCk7XG4gICAgfSk7XG4gIHZvaWQgbG9hZFRyYW5zYWN0aW9uKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImRlc2t0b3AtdXBkYXRlLXJlc3VsdFwiKTtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZGVza3RvcC11cGRhdGUtdHJhbnNhY3Rpb25cIik7XG4gICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOmNvZGV4LWRlc2t0b3AtdXBkYXRlLWNoYW5nZWRcIiwgb25EZXNrdG9wVXBkYXRlQ2hhbmdlZCk7XG4gICAgaWYgKHBvbGxpbmcpIGNsZWFyVGltZW91dChwb2xsaW5nKTtcbiAgICBwb2xsaW5nID0gbnVsbDtcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlOiB1bmtub3duKTogRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGUgfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlPjtcbiAgaWYgKGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBudWxsICYmIHR5cGVvZiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnBoYXNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICAuLi5jYW5kaWRhdGUsXG4gICAgdHJhbnNhY3Rpb25JZDogY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgPz8gbnVsbCxcbiAgICBwaGFzZTogY2FuZGlkYXRlLnBoYXNlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBkZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25Sb3coXG4gIHRyYW5zYWN0aW9uOiBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSxcbiAgYWN0aW9uczogeyBidXN5OiBib29sZWFuOyBvblJlc3VtZTogKCkgPT4gdm9pZDsgb25DYW5jZWw6ICgpID0+IHZvaWQgfSxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGhhc2UgPSBodW1hbml6ZUNvZGV4UGhhc2UodHJhbnNhY3Rpb24ucGhhc2UpO1xuICBjb25zdCBkZXRhaWwgPSBbXG4gICAgdHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZCA/IGBUcmFuc2FjdGlvbiAke3RyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWR9YCA6IG51bGwsXG4gICAgdHJhbnNhY3Rpb24uc2FmZU9mZmljaWFsTW9kZSA/IFwiT2ZmaWNpYWwgQ2hhdEdQVCBpcyBhY3RpdmVcIiA6IG51bGwsXG4gICAgdHJhbnNhY3Rpb24ucmVmcmVzaFNvdXJjZSA/IGAke3RyYW5zYWN0aW9uLnJlZnJlc2hTb3VyY2V9IFR3ZWFrZXJzIHJlZnJlc2hgIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5lcnJvciA/PyBudWxsLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIikgfHwgXCJXYWl0aW5nIGZvciB0aGUgZHVyYWJsZSB1cGRhdGVyIHJlY2VpcHQuXCI7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIlVwZGF0ZSBhbmQgUmVsb2FkXCIsIGRldGFpbCk7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICByb3cuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgY29uc3QgdG9uZSA9IHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImNvbXBsZXRlZFwiXG4gICAgPyBcIm9rXCJcbiAgICA6IHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImZhaWxlZFwiICYmICF0cmFuc2FjdGlvbi5yZXN1bWFibGVcbiAgICAgID8gXCJlcnJvclwiXG4gICAgICA6IFwid2FyblwiO1xuICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHRvbmUsIHBoYXNlKSk7XG4gIGNvbnN0IGNvbnRyb2xzID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGNvbnN0IGNhblJlc3VtZSA9IHRyYW5zYWN0aW9uLnJlc3VtYWJsZSA9PT0gdHJ1ZVxuICAgICYmICh0cmFuc2FjdGlvbi5waGFzZSA9PT0gXCJmYWlsZWRcIiB8fCB0cmFuc2FjdGlvbi5waGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiKTtcbiAgY29uc3QgY2FuQ2FuY2VsID0gdHJhbnNhY3Rpb24ucGhhc2UgPT09IFwiYXdhaXRpbmdfbmF0aXZlX3VwZGF0ZVwiXG4gICAgfHwgKHRyYW5zYWN0aW9uLnJlc3VtYWJsZSA9PT0gdHJ1ZSAmJiBbXCJmYWlsZWRcIiwgXCJyb2xsZWRfYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSkpO1xuICBpZiAoY2FuUmVzdW1lKSB7XG4gICAgY29uc3QgcmVzdW1lID0gY29tcGFjdEJ1dHRvbihcIlJlc3VtZVwiLCBhY3Rpb25zLm9uUmVzdW1lKTtcbiAgICByZXN1bWUuZGlzYWJsZWQgPSBhY3Rpb25zLmJ1c3k7XG4gICAgY29udHJvbHM/LmFwcGVuZENoaWxkKHJlc3VtZSk7XG4gIH1cbiAgaWYgKGNhbkNhbmNlbCkge1xuICAgIGNvbnN0IGNhbmNlbCA9IGNvbXBhY3RCdXR0b24oXCJDYW5jZWxcIiwgYWN0aW9ucy5vbkNhbmNlbCk7XG4gICAgY2FuY2VsLmRpc2FibGVkID0gYWN0aW9ucy5idXN5O1xuICAgIGNvbnRyb2xzPy5hcHBlbmRDaGlsZChjYW5jZWwpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlck1jcEludGVncmF0aW9uU2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiTUNQIEludGVncmF0aW9uIEhlYWx0aFwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlck1jcEhlYWx0aENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBNQ1AgaW50ZWdyYXRpb25cIiwgXCJWZXJpZnlpbmcgbWFuYWdlZCBNQ1AgY29uZmlndXJhdGlvbiBhbmQgc3luY2hyb25pemF0aW9uLlwiKSk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICBjb25zdCByZW5kZXIgPSAoc3RhdGU6IE1jcFN5bmNTdGF0ZSB8IG51bGwpOiB2b2lkID0+IHtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICBpZiAoIXN0YXRlKSB7XG4gICAgICBzdGF0ZSA9IHtcbiAgICAgICAgc3RhdHVzOiBcInBlbmRpbmdcIixcbiAgICAgICAgc3VtbWFyeTogXCJNYW5hZ2VkIE1DUCByZWNvbmNpbGlhdGlvbiBoYXMgbm90IGNvbXBsZXRlZCB5ZXQuXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICBjb25zdCBzdGF0dXMgPSBzdGF0ZS5zdGF0dXMgPz8gKHN0YXRlLmVycm9yID8gXCJlcnJvclwiIDogXCJva1wiKTtcbiAgICBjb25zdCB0b25lID0gc3RhdHVzID09PSBcImVycm9yXCIgfHwgc3RhdGUuZXJyb3JcbiAgICAgID8gXCJlcnJvclwiXG4gICAgICA6IHN0YXR1cyA9PT0gXCJjb25mbGljdFwiIHx8IHN0YXR1cyA9PT0gXCJ3YXJuXCIgfHwgc3RhdHVzID09PSBcInBlbmRpbmdcIlxuICAgICAgICA/IFwid2FyblwiXG4gICAgICAgIDogXCJva1wiO1xuICAgIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIk1DUCBpbnRlZ3JhdGlvblwiLCBzdGF0ZS5zdW1tYXJ5ID8/IHN0YXRlLmVycm9yID8/ICh0b25lID09PSBcIm9rXCIgPyBcIk1DUCBjb25maWd1cmF0aW9uIGlzIHN5bmNocm9uaXplZC5cIiA6IFwiTUNQIGNvbmZpZ3VyYXRpb24gbmVlZHMgYXR0ZW50aW9uLlwiKSk7XG4gICAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgbGVmdD8ucHJlcGVuZChzdGF0dXNCYWRnZSh0b25lLCBzdGF0dXMgPT09IFwib2tcIiA/IFwiSGVhbHRoeVwiIDogaHVtYW5pemVDb2RleFBoYXNlKHN0YXR1cykpKTtcbiAgICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgcmVwYWlyID0gY29tcGFjdEJ1dHRvbihcIlJlcGFpclwiLCAoKSA9PiB7XG4gICAgICByZXBhaXIuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJtY3BcIik7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmVwYWlyLW1jcFwiKVxuICAgICAgICAudGhlbigobmV4dCkgPT4ge1xuICAgICAgICAgIGlmIChjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIG5leHQpKSByZW5kZXIobmV4dCBhcyBNY3BTeW5jU3RhdGUpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgY29uc3QgbmV4dCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgICAgICBpZiAoY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICAgICAgICB9KTtcbiAgICB9KTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChyZXBhaXIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgICBpZiAoc3RhdGUucmVzdGFydFJlcXVpcmVkKSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgXCJOZXcgdGFzayBvciByZXN0YXJ0IHJlcXVpcmVkXCIsXG4gICAgICAgIFwiVGhlIGNhbm9uaWNhbCBNQ1AgbmFtZSBpcyB3cml0dGVuLiBTdGFydCBhIG5ldyB0YXNrLCBvciByZXN0YXJ0IENvZGV4LCB0byByZXBsYWNlIGFueSBhbHJlYWR5LXJ1bm5pbmcgbGVnYWN5IE1DUCBwcm9jZXNzLlwiLFxuICAgICAgKSk7XG4gICAgfVxuICAgIGlmIChzdGF0ZS5jb25mbGljdHM/Lmxlbmd0aCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb25mbGljdHNcIiwgc3RhdGUuY29uZmxpY3RzLm1hcCgoY29uZmxpY3QpID0+IHtcbiAgICAgICAgaWYgKGNvbmZsaWN0Lm9ic2VydmVkTmFtZSB8fCBjb25mbGljdC5jYW5vbmljYWxOYW1lKSB7XG4gICAgICAgICAgcmV0dXJuIGAke2NvbmZsaWN0Lm9ic2VydmVkTmFtZSA/PyBcIlVua25vd24gZW50cnlcIn0gXHUyMTkyICR7Y29uZmxpY3QuY2Fub25pY2FsTmFtZSA/PyBcImNhbm9uaWNhbCBlbnRyeVwifTogJHtjb25mbGljdC5yZWFzb24gPz8gY29uZmxpY3QuZGV0YWlsID8/IFwib3duZXJzaGlwIGNvbmZsaWN0XCJ9YDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gY29uZmxpY3QuZGV0YWlsID8/IGNvbmZsaWN0LnJlYXNvbiA/PyBjb25mbGljdC5uYW1lID8/IFwiVW5rbm93biBjb25mbGljdFwiO1xuICAgICAgfSkuam9pbihcIjsgXCIpKSk7XG4gICAgfVxuICAgIGNvbnN0IGNoZWNrZWRBdCA9IHN0YXRlLmNvbXBsZXRlZEF0ID8/IHN0YXRlLmNoZWNrZWRBdDtcbiAgICBpZiAoY2hlY2tlZEF0KSBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxhc3QgY2hlY2tlZFwiLCBuZXcgRGF0ZShjaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCkpKTtcbiAgfTtcbiAgY29uc3Qgb25TeW5jU3RhdGVDaGFuZ2VkID0gKF9ldmVudDogdW5rbm93biwgdmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjptY3Atc3luYy1zdGF0ZS1jaGFuZ2VkXCIsIG9uU3luY1N0YXRlQ2hhbmdlZCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwibWNwXCIpO1xuICAgIGNvbnN0IG5leHQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgPyB2YWx1ZSBhcyBNY3BTeW5jU3RhdGUgOiBudWxsO1xuICAgIGlmIChjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIG5leHQpKSByZW5kZXIobmV4dCk7XG4gIH07XG4gIGlwY1JlbmRlcmVyLm9uKFwidHdlYWtlcjptY3Atc3luYy1zdGF0ZS1jaGFuZ2VkXCIsIG9uU3luY1N0YXRlQ2hhbmdlZCk7XG4gIGNvbnN0IGluaXRpYWxVcGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcIm1jcFwiKTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1tY3Atc3luYy1zdGF0ZVwiKVxuICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgY29uc3QgbmV4dCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIE1jcFN5bmNTdGF0ZSA6IG51bGw7XG4gICAgICBpZiAoY2FyZC5pc0Nvbm5lY3RlZCAmJiBjYXJkVXBkYXRlcy5jb21wbGV0ZShpbml0aWFsVXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgY29uc3QgbmV4dCA9IHsgc3RhdHVzOiBcImVycm9yXCIsIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkICYmIGNhcmRVcGRhdGVzLmNvbXBsZXRlKGluaXRpYWxVcGRhdGUsIG5leHQpKSByZW5kZXIobmV4dCk7XG4gICAgfSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcIm1jcFwiKTtcbiAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6bWNwLXN5bmMtc3RhdGUtY2hhbmdlZFwiLCBvblN5bmNTdGF0ZUNoYW5nZWQpO1xuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJBdXRvbWF0aWNNYWludGVuYW5jZVNlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIGNhcmRVcGRhdGVzOiBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4sXG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIkF1dG9tYXRpYyBNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlck1haW50ZW5hbmNlQ2FyZCA9IFwidHJ1ZVwiO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNoZWNraW5nIGF1dG9tYXRpYyBtYWludGVuYW5jZVwiLCBcIlZlcmlmeWluZyB0aGUgdXBkYXRlciByZXBhaXIgc2VydmljZS5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG4gIGxldCBsYXRlc3RIZWFsdGg6IFdhdGNoZXJIZWFsdGggfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlcGFpckluRmxpZ2h0ID0gZmFsc2U7XG4gIGxldCByZXBhaXJEaXNwbGF5OiBcImlkbGVcIiB8IFwic3VjY2Vzc1wiIHwgXCJmYWlsdXJlXCIgPSBcImlkbGVcIjtcbiAgbGV0IHJlcGFpckJhc2VsaW5lQ3ljbGU6IFdhdGNoZXJDeWNsZVJlY2VpcHQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlcGFpclN0YXJ0ZWRBdCA9IDA7XG4gIGxldCByZXBhaXJQb2xsOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVwYWlyUG9sbENvdW50ID0gMDtcbiAgY29uc3QgTUFYX1JFUEFJUl9QT0xMUyA9IDMwO1xuXG4gIGNvbnN0IHJlbmRlciA9IChoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiB2b2lkID0+IHtcbiAgICBsYXRlc3RIZWFsdGggPSBoZWFsdGg7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgaWYgKHJlcGFpckluRmxpZ2h0KSB7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIHtcbiAgICAgICAgLi4uaGVhbHRoLFxuICAgICAgICBzdGF0dXM6IFwid2FyblwiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgcnVubmluZ1wiLFxuICAgICAgICBzdW1tYXJ5OiBcIlJlcGFpciB3YXMgc3RhcnRlZCBpbiB0aGUgYmFja2dyb3VuZC4gV2FpdGluZyBmb3IgYSBjb21wbGV0ZWQgd2F0Y2hlciBjeWNsZVx1MjAyNlwiLFxuICAgICAgfSwgZmFsc2UpO1xuICAgICAgY29uc3QgcnVubmluZyA9IGFjdGlvblJvdyhcIkF1dG9tYXRpYyBtYWludGVuYW5jZVwiLCBcIlJlcGFpciBjeWNsZSBydW5uaW5nXHUyMDI2XCIpO1xuICAgICAgcnVubmluZy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICAgICAgcnVubmluZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxpdmVcIiwgXCJwb2xpdGVcIik7XG4gICAgICBydW5uaW5nLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik/LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwid2FyblwiLCBcIlJ1bm5pbmdcIikpO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChydW5uaW5nKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHJlcGFpckRpc3BsYXkgPT09IFwic3VjY2Vzc1wiKSB7XG4gICAgICBoZWFsdGggPSB7XG4gICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgc3RhdHVzOiBcIm9rXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBzdWNjZWVkZWRcIixcbiAgICAgICAgc3VtbWFyeTogXCJUaGUgd2F0Y2hlciBjb21wbGV0ZWQgYSBmcmVzaCByZXBhaXIgY3ljbGUuXCIsXG4gICAgICB9O1xuICAgIH0gZWxzZSBpZiAocmVwYWlyRGlzcGxheSA9PT0gXCJmYWlsdXJlXCIpIHtcbiAgICAgIGhlYWx0aCA9IHtcbiAgICAgICAgLi4uaGVhbHRoLFxuICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLFxuICAgICAgICBzdW1tYXJ5OiBoZWFsdGguc3VtbWFyeSB8fCBcIlRoZSB3YXRjaGVyIHJlcGFpciBjeWNsZSBmYWlsZWQuXCIsXG4gICAgICB9O1xuICAgIH1cbiAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIGhlYWx0aCwgdHJ1ZSwgc3RhcnRSZXBhaXIpO1xuICB9O1xuICBjb25zdCBsb2FkID0gKCk6IFByb21pc2U8V2F0Y2hlckhlYWx0aCB8IG51bGw+ID0+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcIndhdGNoZXJcIik7XG4gICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LXdhdGNoZXItaGVhbHRoXCIpXG4gICAgICAudGhlbigodmFsdWUpID0+IHtcbiAgICAgICAgY29uc3QgaGVhbHRoID0gdmFsdWUgYXMgV2F0Y2hlckhlYWx0aDtcbiAgICAgICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkIHx8ICFjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIGhlYWx0aCkpIHJldHVybiBudWxsO1xuICAgICAgICByZW5kZXIoaGVhbHRoKTtcbiAgICAgICAgcmV0dXJuIGhlYWx0aDtcbiAgICAgIH0pXG4gICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgIGNvbnN0IGhlYWx0aDogV2F0Y2hlckhlYWx0aCA9IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJlcnJvclwiLCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgdW5hdmFpbGFibGVcIiwgc3VtbWFyeTogc2FmZVVpRXJyb3IoZXJyb3IpLCB3YXRjaGVyOiBcIldhdGNoZXJcIiwgY2hlY2tzOiBbXSB9O1xuICAgICAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQgfHwgIWNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgaGVhbHRoKSkgcmV0dXJuIG51bGw7XG4gICAgICAgIHJlbmRlcihoZWFsdGgpO1xuICAgICAgICByZXR1cm4gaGVhbHRoO1xuICAgICAgfSk7XG4gIH07XG4gIGNvbnN0IGlzTmV3ZXJDeWNsZSA9IChoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBib29sZWFuID0+IHtcbiAgICBjb25zdCBjeWNsZSA9IGhlYWx0aC5sYXRlc3RDb21wbGV0ZWRDeWNsZTtcbiAgICBpZiAoIWN5Y2xlKSByZXR1cm4gZmFsc2U7XG4gICAgaWYgKCFyZXBhaXJCYXNlbGluZUN5Y2xlKSB7XG4gICAgICByZXR1cm4gRGF0ZS5wYXJzZShjeWNsZS5jb21wbGV0ZWRBdCkgPiByZXBhaXJTdGFydGVkQXQ7XG4gICAgfVxuICAgIHJldHVybiBjeWNsZS5jeWNsZUlkICE9PSByZXBhaXJCYXNlbGluZUN5Y2xlLmN5Y2xlSWRcbiAgICAgICYmIGN5Y2xlLmNvbXBsZXRlZEF0ID4gcmVwYWlyQmFzZWxpbmVDeWNsZS5jb21wbGV0ZWRBdDtcbiAgfTtcbiAgY29uc3QgZmluaXNoUmVwYWlyID0gKGhlYWx0aDogV2F0Y2hlckhlYWx0aCwgZmFpbGVkID0gZmFsc2UpOiB2b2lkID0+IHtcbiAgICByZXBhaXJJbkZsaWdodCA9IGZhbHNlO1xuICAgIHJlcGFpckRpc3BsYXkgPSBmYWlsZWQgPyBcImZhaWx1cmVcIiA6IFwic3VjY2Vzc1wiO1xuICAgIGlmIChyZXBhaXJQb2xsKSBjbGVhclRpbWVvdXQocmVwYWlyUG9sbCk7XG4gICAgcmVwYWlyUG9sbCA9IG51bGw7XG4gICAgY29uc3QgbmV4dCA9IGZhaWxlZFxuICAgICAgPyB7IC4uLmhlYWx0aCwgc3RhdHVzOiBcImVycm9yXCIgYXMgY29uc3QsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIiwgc3VtbWFyeTogaGVhbHRoLnN1bW1hcnkgfHwgXCJUaGUgd2F0Y2hlciByZXBhaXIgY3ljbGUgZmFpbGVkLlwiIH1cbiAgICAgIDogaGVhbHRoO1xuICAgIHJlbmRlcihuZXh0KTtcbiAgfTtcbiAgY29uc3QgcG9sbFJlcGFpciA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIXJlcGFpckluRmxpZ2h0IHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgaWYgKHJlcGFpclBvbGxDb3VudCsrID49IE1BWF9SRVBBSVJfUE9MTFMpIHtcbiAgICAgIGZpbmlzaFJlcGFpcih7XG4gICAgICAgIC4uLihsYXRlc3RIZWFsdGggPz8geyBjaGVja2VkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgc3RhdHVzOiBcImVycm9yXCIgYXMgY29uc3QsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIiwgc3VtbWFyeTogXCJUaGUgd2F0Y2hlciBkaWQgbm90IHJlcG9ydCBhIGNvbXBsZXRlZCBjeWNsZSBpbiB0aW1lLlwiLCB3YXRjaGVyOiBcIldhdGNoZXJcIiwgY2hlY2tzOiBbXSB9KSxcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIixcbiAgICAgICAgc3VtbWFyeTogXCJUaGUgd2F0Y2hlciBkaWQgbm90IHJlcG9ydCBhIGNvbXBsZXRlZCBjeWNsZSBpbiB0aW1lLlwiLFxuICAgICAgfSwgdHJ1ZSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHZvaWQgbG9hZCgpLnRoZW4oKGhlYWx0aCkgPT4ge1xuICAgICAgaWYgKCFoZWFsdGggfHwgIXJlcGFpckluRmxpZ2h0KSByZXR1cm47XG4gICAgICBjb25zdCBjeWNsZSA9IGhlYWx0aC5sYXRlc3RDb21wbGV0ZWRDeWNsZTtcbiAgICAgIGlmIChpc05ld2VyQ3ljbGUoaGVhbHRoKSkge1xuICAgICAgICBmaW5pc2hSZXBhaXIoaGVhbHRoLCBjeWNsZT8ub3V0Y29tZSA9PT0gXCJmYWlsZWRcIiB8fCBjeWNsZT8ucmVwYWlyLnN0YXR1cyA9PT0gXCJmYWlsZWRcIik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHJlbmRlcihoZWFsdGgpO1xuICAgICAgcmVwYWlyUG9sbCA9IHNldFRpbWVvdXQocG9sbFJlcGFpciwgMV8wMDApO1xuICAgIH0pO1xuICB9O1xuICBjb25zdCBzdGFydFJlcGFpciA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAocmVwYWlySW5GbGlnaHQpIHJldHVybjtcbiAgICByZXBhaXJJbkZsaWdodCA9IHRydWU7XG4gICAgcmVwYWlyRGlzcGxheSA9IFwiaWRsZVwiO1xuICAgIHJlcGFpckJhc2VsaW5lQ3ljbGUgPSBsYXRlc3RIZWFsdGg/LmxhdGVzdENvbXBsZXRlZEN5Y2xlID8/IG51bGw7XG4gICAgcmVwYWlyU3RhcnRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICByZXBhaXJQb2xsQ291bnQgPSAwO1xuICAgIHJlbmRlcihsYXRlc3RIZWFsdGggPz8geyBjaGVja2VkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgc3RhdHVzOiBcIndhcm5cIiwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJ1bm5pbmdcIiwgc3VtbWFyeTogXCJTdGFydGluZyByZXBhaXJcdTIwMjZcIiwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfSk7XG4gICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlcGFpci1hdXRvLW1haW50ZW5hbmNlXCIpXG4gICAgICAudGhlbigoKSA9PiBwb2xsUmVwYWlyKCkpXG4gICAgICAuY2F0Y2goKGVycm9yKSA9PiBmaW5pc2hSZXBhaXIoe1xuICAgICAgICAuLi4obGF0ZXN0SGVhbHRoID8/IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJlcnJvclwiIGFzIGNvbnN0LCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsIHN1bW1hcnk6IFwiXCIsIHdhdGNoZXI6IFwiV2F0Y2hlclwiLCBjaGVja3M6IFtdIH0pLFxuICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLFxuICAgICAgICBzdW1tYXJ5OiBzYWZlVWlFcnJvcihlcnJvciksXG4gICAgICB9LCB0cnVlKSk7XG4gIH07XG4gIGxvYWQoKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwid2F0Y2hlclwiKTtcbiAgICByZXBhaXJJbkZsaWdodCA9IGZhbHNlO1xuICAgIGlmIChyZXBhaXJQb2xsKSBjbGVhclRpbWVvdXQocmVwYWlyUG9sbCk7XG4gICAgcmVwYWlyUG9sbCA9IG51bGw7XG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlckFkdmFuY2VkUnVudGltZVNlY3Rpb24oc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICByZW5kZXJDb2RleFZlcnNpb25zU2VjdGlvbihzZWN0aW9uc1dyYXApO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RleFZlcnNpb25zU2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgb3B0aW9uczogeyBjb2xsYXBzZWQ/OiBib29sZWFuIH0gPSB7fSxcbik6IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uZGF0YXNldC50d2Vha2VyQ29kZXhTZWN0aW9uID0gXCJ0cnVlXCI7XG4gIGNvbnN0IHJlZnJlc2ggPSBjb21wYWN0QnV0dG9uKFwiUmVmcmVzaFwiLCAoKSA9PiB7IHZvaWQgbG9hZCh0cnVlKTsgfSk7XG4gIGNvbnN0IGhlYWRpbmcgPSBzZWN0aW9uVGl0bGUob3B0aW9ucy5jb2xsYXBzZWQgPyBcIkFkdmFuY2VkIFJ1bnRpbWUgRGV0YWlsc1wiIDogXCJSdW50aW1lIFZlcnNpb25zXCIsIHJlZnJlc2gpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGhlYWRpbmcpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJDb2RleENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIENvZGV4IHZlcnNpb25zXCIsIFwiVXNpbmcgY2FjaGVkIHZlcnNpb24gYW5kIGZlYXR1cmUgaW5mb3JtYXRpb24gZmlyc3QuXCIpKTtcbiAgaWYgKG9wdGlvbnMuY29sbGFwc2VkKSB7XG4gICAgY29uc3QgZGV0YWlscyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkZXRhaWxzXCIpO1xuICAgIGRldGFpbHMuZGF0YXNldC50d2Vha2VyQWR2YW5jZWRSdW50aW1lRGV0YWlscyA9IFwidHJ1ZVwiO1xuICAgIGNvbnN0IHN1bW1hcnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3VtbWFyeVwiKTtcbiAgICBzdW1tYXJ5LmNsYXNzTmFtZSA9IFwiY3Vyc29yLXBvaW50ZXIgcHgtMSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgICBzdW1tYXJ5LnRleHRDb250ZW50ID0gXCJCdWlsZHMsIENMSSBydW50aW1lcywgcmVsZWFzZXMsIGFuZCBmZWF0dXJlc1wiO1xuICAgIGNvbnN0IGJvZHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGJvZHkuY2xhc3NOYW1lID0gXCJtdC0yIGZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICBib2R5LmFwcGVuZENoaWxkKGNhcmQpO1xuICAgIGRldGFpbHMuYXBwZW5kKHN1bW1hcnksIGJvZHkpO1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoZGV0YWlscyk7XG4gIH0gZWxzZSB7XG4gICAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgfVxuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IHBvbGxpbmc6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGxldCBhY3Rpb25JbkZsaWdodCA9IGZhbHNlO1xuICBsZXQgZ2VuZXJhdGlvbiA9IDA7XG4gIGNvbnN0IHNjaGVkdWxlUG9sbCA9IChzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KSA9PiB7XG4gICAgaWYgKHBvbGxpbmcpIGNsZWFyVGltZW91dChwb2xsaW5nKTtcbiAgICBwb2xsaW5nID0gbnVsbDtcbiAgICBpZiAoIWFjdGlvbkluRmxpZ2h0ICYmICFjb2RleFByb2dyZXNzQnVzeShzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MpKSByZXR1cm47XG4gICAgcG9sbGluZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQpIHZvaWQgbG9hZChmYWxzZSk7XG4gICAgfSwgOTAwKTtcbiAgfTtcbiAgY29uc3QgcmVxdWVzdFJlbG9hZDogQ29kZXhVaVJlbG9hZCA9IChtb2RlKSA9PiB7XG4gICAgaWYgKG1vZGUgPT09IFwib3BlcmF0aW9uLXN0YXJ0XCIpIGFjdGlvbkluRmxpZ2h0ID0gdHJ1ZTtcbiAgICBpZiAobW9kZSA9PT0gXCJvcGVyYXRpb24tc3RvcFwiKSBhY3Rpb25JbkZsaWdodCA9IGZhbHNlO1xuICAgIHZvaWQgbG9hZChmYWxzZSk7XG4gIH07XG4gIGNvbnN0IHNob3cgPSAoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCkgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIHJlbmRlckNvZGV4VmVyc2lvbnNDYXJkKGNhcmQsIHNuYXBzaG90LCByZXF1ZXN0UmVsb2FkKTtcbiAgICBzY2hlZHVsZVBvbGwoc25hcHNob3QpO1xuICB9O1xuICBhc3luYyBmdW5jdGlvbiBsb2FkKGZvcmNlOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XG4gICAgY29uc3QgY3VycmVudCA9ICsrZ2VuZXJhdGlvbjtcbiAgICByZWZyZXNoLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc25hcHNob3QgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIGZvcmNlID8gXCJ0d2Vha2VyOnJlZnJlc2gtY29kZXgtdmVyc2lvbnNcIiA6IFwidHdlYWtlcjpnZXQtY29kZXgtdmVyc2lvbnNcIixcbiAgICAgICkgYXMgQ29kZXhWZXJzaW9uc1NuYXBzaG90O1xuICAgICAgaWYgKGN1cnJlbnQgIT09IGdlbmVyYXRpb24gfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIHNob3coc25hcHNob3QpO1xuICAgICAgaWYgKCFmb3JjZSAmJiBpc0NvZGV4U25hcHNob3RTdGFsZShzbmFwc2hvdCkpIHtcbiAgICAgICAgdm9pZCBsb2FkKHRydWUpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoY3VycmVudCAhPT0gZ2VuZXJhdGlvbiB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvZGV4IHZlcnNpb25zIHVuYXZhaWxhYmxlXCIsIHNhZmVVaUVycm9yKGVycm9yKSkpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoY3VycmVudCA9PT0gZ2VuZXJhdGlvbikgcmVmcmVzaC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfVxuICB2b2lkIGxvYWQoZmFsc2UpO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb2RleFZlcnNpb25zQ2FyZChcbiAgY2FyZDogSFRNTEVsZW1lbnQsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IHZvaWQge1xuICBjb25zdCBidW5kbGVkID0gc25hcHNob3QuY2xpLmJ1bmRsZWQ7XG4gIGNvbnN0IGJldGEgPSBzbmFwc2hvdC5jbGkuYmV0YTtcbiAgY29uc3QgYnVzeSA9IGNvZGV4UHJvZ3Jlc3NCdXN5KHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcyk7XG5cbiAgaWYgKHNuYXBzaG90LmZyb21DYWNoZSB8fCBzbmFwc2hvdC5zdGFsZSkge1xuICAgIGNvbnN0IGNoZWNrZWQgPSBuZXcgRGF0ZShzbmFwc2hvdC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXG4gICAgICBzbmFwc2hvdC5zdGFsZSA/IFwiQ2FjaGVkIGluZm9ybWF0aW9uIChyZWZyZXNoIG5lZWRlZClcIiA6IFwiQ2FjaGVkIGluZm9ybWF0aW9uXCIsXG4gICAgICBgU2hvd2luZyB0aGUgbGFzdCBrbm93biBnb29kIHJlc3VsdCBmcm9tICR7Y2hlY2tlZH0gd2hpbGUgY3VycmVudCBpbmZvcm1hdGlvbiBsb2Fkcy5gLFxuICAgICkpO1xuICB9XG5cbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleEFjdGl2ZUNsaVJvdyhzbmFwc2hvdCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4RW1iZWRkZWRDbGlSb3coYnVuZGxlZCwgc25hcHNob3QpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleExhdGVzdFN0YWJsZVJlbGVhc2VSb3coYnVuZGxlZCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4Q2xpUm93KFwiTWFuYWdlZCBBbHBoYSBDTEkgKFByZS1yZWxlYXNlKVwiLCBcImJldGFcIiwgYmV0YSwgc25hcHNob3QsIGJ1c3ksIHJlbG9hZCkpO1xuICBjYXJkLmFwcGVuZENoaWxkKGNvZGV4UnVudGltZVJvdyhzbmFwc2hvdCkpO1xuXG4gIGNvbnN0IHJlbGVhc2VzID0gYWN0aW9uUm93KFwiR2l0SHViIFJlbGVhc2VzXCIsIFwiVmlldyBvZmZpY2lhbCBPcGVuQUkgQ29kZXggcmVsZWFzZSBub3RlcyBhbmQgcGFja2FnZXMuXCIpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJlbGVhc2VzKTtcbiAgcmVsZWFzZXMucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKT8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gUmVsZWFzZXNcIiwgKCkgPT4gb3BlbkNvZGV4R2l0aHViVXJsKFwiaHR0cHM6Ly9naXRodWIuY29tL29wZW5haS9jb2RleC9yZWxlYXNlc1wiKSksXG4gICk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocmVsZWFzZXMpO1xuXG4gIGlmIChzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MgJiYgc25hcHNob3QuaW5zdGFsbFByb2dyZXNzLnBoYXNlICYmIHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcy5waGFzZSAhPT0gXCJpZGxlXCIpIHtcbiAgICBjb25zdCBwID0gc25hcHNob3QuaW5zdGFsbFByb2dyZXNzO1xuICAgIGNvbnN0IGFtb3VudCA9IGZvcm1hdEJ5dGVzKHAuYnl0ZXMpO1xuICAgIGNvbnN0IGRldGFpbCA9IHAuZXJyb3IgfHwgW2h1bWFuaXplQ29kZXhQaGFzZShwLnBoYXNlKSwgcC52ZXJzaW9uLCBhbW91bnRdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJBbHBoYSBvcGVyYXRpb25cIiwgZGV0YWlsKSk7XG4gIH1cblxuICBjb25zdCBzdGF0ZU1lc3NhZ2UgPSBjb2RleFJ1bnRpbWVNZXNzYWdlKHNuYXBzaG90KTtcbiAgaWYgKHN0YXRlTWVzc2FnZSkgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJSdW50aW1lIHN0YXR1c1wiLCBzdGF0ZU1lc3NhZ2UpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleEZlYXR1cmVCcm93c2VyKHNuYXBzaG90LCBidXN5LCByZWxvYWQpKTtcbn1cblxuZnVuY3Rpb24gY29kZXhBY3RpdmVDbGlSb3coc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYWN0aXZlID0gc25hcHNob3QuYWN0aXZlQ2xpO1xuICBjb25zdCB2ZXJzaW9uID0gYWN0aXZlLnZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICBjb25zdCBjaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGFjdGl2ZS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IHNvdXJjZSA9IGFjdGl2ZS5zb3VyY2UgPT09IFwiYnVuZGxlZFwiXG4gICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgZW1iZWRkZWQgaW4gdGhlIE9wZW5BSSBkZXNrdG9wIGFwcCBcdTAwQjcgYXBwLW1hbmFnZWRgXG4gICAgOiBhY3RpdmUuc291cmNlID09PSBcIm1hbmFnZWQtYWxwaGFcIlxuICAgICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgbWFuYWdlZCBieSBUd2Vha2Vyc2BcbiAgICAgIDogYCR7Y2hhbm5lbH0gXHUwMEI3IGV4dGVybmFsIENPREVYX0NMSV9QQVRIIG92ZXJyaWRlYDtcbiAgY29uc3QgZGV0YWlsID0gW2BWZXJzaW9uICR7dmVyc2lvbn1gLCBzb3VyY2UsIGFjdGl2ZS5wYXRoLCBhY3RpdmUuZXJyb3JdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkFjdGl2ZSBDb2RleCBiYWNrZW5kXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gYWN0aXZlLnBhdGg7XG4gIHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChcbiAgICBzdGF0dXNCYWRnZShhY3RpdmUuYXZhaWxhYmxlID8gXCJva1wiIDogXCJlcnJvclwiLCBhY3RpdmUuYXZhaWxhYmxlID8gXCJBY3RpdmVcIiA6IFwiVW5hdmFpbGFibGVcIiksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RW1iZWRkZWRDbGlSb3coXG4gIGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHZlcnNpb24gPSBjbGkudmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gIGNvbnN0IGNoYW5uZWwgPSBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoY2xpLnZlcnNpb25DaGFubmVsKTtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIGBWZXJzaW9uICR7dmVyc2lvbn1gLFxuICAgIGNoYW5uZWwsXG4gICAgXCJFbWJlZGRlZCBpbiB0aGUgT3BlbkFJIGRlc2t0b3AgYXBwOyBpdCBjaGFuZ2VzIG9ubHkgd2hlbiBPcGVuQUkgc2hpcHMgYSBkZXNrdG9wIHVwZGF0ZVwiLFxuICAgIGNsaS5wYXRoLFxuICAgIGNsaS5hdmFpbGFibGUgPyBudWxsIDogY2xpLmVycm9yLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkRlc2t0b3AtRW1iZWRkZWQgQ29kZXggQ0xJXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gY2xpLnBhdGggPz8gXCJcIjtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCIpIGFjdGlvbnM/LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJBY3RpdmVcIikpO1xuICBlbHNlIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQXBwLW1hbmFnZWRcIikpO1xuICBpZiAoY2xpLnZlcnNpb24pIHtcbiAgICBjb25zdCByZWxlYXNlVXJsID0gYGh0dHBzOi8vZ2l0aHViLmNvbS9vcGVuYWkvY29kZXgvcmVsZWFzZXMvdGFnL3J1c3QtdiR7ZW5jb2RlVVJJQ29tcG9uZW50KGNsaS52ZXJzaW9uKX1gO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlVXJsKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4TGF0ZXN0U3RhYmxlUmVsZWFzZVJvdyhjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZWxlYXNlID0gY2xpLnJlbGVhc2U7XG4gIGNvbnN0IGRldGFpbCA9IHJlbGVhc2VcbiAgICA/IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSAke3JlbGVhc2UudmVyc2lvbn0gXHUwMEI3IFRoaXMgZG9lcyBub3QgcmVwbGFjZSB0aGUgZGVza3RvcC1lbWJlZGRlZCBiYWNrZW5kLmBcbiAgICA6IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSB1bmF2YWlsYWJsZSR7Y2xpLmVycm9yID8gYCBcdTAwQjcgJHtjbGkuZXJyb3J9YCA6IFwiXCJ9YDtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiTGF0ZXN0IFN0YWJsZSBDTEkgUmVsZWFzZVwiLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJTdGFibGVcIikpO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwocmVsZWFzZT8ucmVsZWFzZVVybCkpIHtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZSEucmVsZWFzZVVybCkpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleENsaVJvdyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgbGFuZTogQ29kZXhDbGlMYW5lLFxuICBjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlLFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGNsaS5tYW5hZ2VkQ3VycmVudFZlcnNpb24gPz8gY2xpLnZlcnNpb247XG4gIGNvbnN0IGxhdGVzdCA9IGNsaS5yZWxlYXNlPy52ZXJzaW9uO1xuICBjb25zdCBkZXRhaWwgPSBpbnN0YWxsZWRMYXRlc3RTdW1tYXJ5KGluc3RhbGxlZCwgbGF0ZXN0LCBjbGkuZXJyb3IgfHwgY2xpLnJlbGVhc2U/LmVycm9yKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KGxhYmVsLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgaWYgKHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgPT09IGxhbmUpIGFjdGlvbnM/LnByZXBlbmQoc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkFjdGl2ZVwiKSk7XG4gIGNvbnN0IHJlbGVhc2VVcmwgPSBjbGkucmVsZWFzZT8ucmVsZWFzZVVybDtcbiAgaWYgKGlzU2FmZUNvZGV4R2l0aHViVXJsKHJlbGVhc2VVcmwpKSBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZVVybCEpKSk7XG4gIGlmIChsYW5lID09PSBcImJldGFcIikge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGluc3RhbGxlZCAmJiBsYXRlc3QgJiYgaW5zdGFsbGVkICE9PSBsYXRlc3QgPyBcIlVwZGF0ZVwiIDogaW5zdGFsbGVkID8gXCJSZWluc3RhbGxcIiA6IFwiSW5zdGFsbFwiO1xuICAgIGNvbnN0IGluc3RhbGwgPSBjb21wYWN0QnV0dG9uKGluc3RhbGxMYWJlbCwgKCkgPT4gcnVuQ29kZXhBY3Rpb24ocm93LCBcInR3ZWFrZXI6aW5zdGFsbC1jb2RleC1iZXRhXCIsIHVuZGVmaW5lZCwgcmVsb2FkKSk7XG4gICAgaW5zdGFsbC5kaXNhYmxlZCA9IGJ1c3kgfHwgIWxhdGVzdDtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChpbnN0YWxsKTtcbiAgICBjb25zdCBwcmV2aW91c1ZlcnNpb24gPSBjbGkubWFuYWdlZFByZXZpb3VzVmVyc2lvbjtcbiAgICBpZiAocHJldmlvdXNWZXJzaW9uKSB7XG4gICAgICBjb25zdCByb2xsYmFjayA9IGNvbXBhY3RCdXR0b24oYFJvbGxiYWNrIHRvICR7cHJldmlvdXNWZXJzaW9ufWAsICgpID0+IHJ1bkNvZGV4QWN0aW9uKHJvdywgXCJ0d2Vha2VyOnJvbGxiYWNrLWNvZGV4LWJldGFcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgICAgIHJvbGxiYWNrLmRpc2FibGVkID0gYnVzeTtcbiAgICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJvbGxiYWNrKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lUm93KFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZXF1ZXN0ZWQgPSBzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lO1xuICBjb25zdCBzZWxlY3RlZCA9IHJlcXVlc3RlZFxuICAgID8gcmVxdWVzdGVkID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWQgKGFwcC1tYW5hZ2VkKVwiXG4gICAgOiBzbmFwc2hvdC51c2VyT3ZlcnJpZGVQcmVzZXJ2ZWQgPyBcIkV4dGVybmFsIG92ZXJyaWRlXCIgOiBcIk5vdCBleHBsaWNpdGx5IHNlbGVjdGVkXCI7XG4gIGNvbnN0IGFjdGl2ZSA9IHNuYXBzaG90LmFjdGl2ZUNsaS5zb3VyY2UgPT09IFwibWFuYWdlZC1hbHBoYVwiXG4gICAgPyBcIk1hbmFnZWQgQWxwaGFcIlxuICAgIDogc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCJcbiAgICAgID8gXCJEZXNrdG9wLWVtYmVkZGVkXCJcbiAgICAgIDogXCJFeHRlcm5hbCBvdmVycmlkZVwiO1xuICBjb25zdCBhY3RpdmVDaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IGFjdGl2ZVZlcnNpb24gPSBzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbiA/IGAgJHtzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbn1gIDogXCJcIjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiU2VsZWN0ZWQgcnVudGltZVwiLFxuICAgIGBTZWxlY3RlZDogJHtzZWxlY3RlZH0uIEFjdGl2ZTogJHthY3RpdmV9JHthY3RpdmVWZXJzaW9ufSBcdTAwQjcgJHthY3RpdmVDaGFubmVsfS4gRGVza3RvcCBwcm9maWxlIGFuZCBDTEkgcmVsZWFzZSBjaGFubmVsIGFyZSByZXBvcnRlZCBzZXBhcmF0ZWx5LmAsXG4gICk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIk1hbmFnZWQgYnkgRW52aXJvbm1lbnRcIikpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVCcm93c2VyKFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdyYXBwZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3cmFwcGVyLmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5kYXRhc2V0LnR3ZWFrZXJGZWF0dXJlQnJvd3NlciA9IFwidHJ1ZVwiO1xuICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gIHN1bW1hcnkuY2xhc3NOYW1lID0gXCJjdXJzb3ItcG9pbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGNvbnN0IGZlYXR1cmVzID0gc25hcHNob3QuZmVhdHVyZXM7XG4gIHN1bW1hcnkudGV4dENvbnRlbnQgPSBgQ29kZXggQ0xJIGZlYXR1cmVzICgke2ZlYXR1cmVzLmxlbmd0aH0pYDtcbiAgZGV0YWlscy5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcbiAgY29uc3QgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvbnRlbnQuY2xhc3NOYW1lID0gXCJtdC0zIGZsZXggZmxleC1jb2wgZ2FwLTNcIjtcbiAgY29uc3QgZmlsdGVycyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZpbHRlcnMuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2gudHlwZSA9IFwic2VhcmNoXCI7XG4gIHNlYXJjaC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIENvZGV4IGZlYXR1cmVzXCI7XG4gIHNlYXJjaC5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIG1pbi13LVsxODBweF0gZmxleC0xIHJvdW5kZWQtbWQgYm9yZGVyIHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBjb25zdCBzdGFnZSA9IGNvZGV4RmlsdGVyU2VsZWN0KFwiU3RhZ2VcIiwgW1wiYWxsXCIsIFwic3RhYmxlXCIsIFwiZXhwZXJpbWVudGFsXCIsIFwidW5kZXItZGV2ZWxvcG1lbnRcIiwgXCJkZXByZWNhdGVkXCIsIFwicmVtb3ZlZFwiXSk7XG4gIGNvbnN0IGxhbmUgPSBjb2RleEZpbHRlclNlbGVjdChcIkxhbmVcIiwgW1wiYWxsXCIsIFwiYnVuZGxlZFwiLCBcImJldGFcIiwgXCJidW5kbGVkLW9ubHlcIiwgXCJiZXRhLW9ubHlcIl0pO1xuICBjb25zdCBzdGF0dXMgPSBjb2RleEZpbHRlclNlbGVjdChcIlN0YXR1c1wiLCBbXCJhbGxcIiwgXCJlbmFibGVkXCIsIFwiZGlzYWJsZWRcIiwgXCJ1bnN1cHBvcnRlZFwiLCBcInJlYWQtb25seVwiXSk7XG4gIGZpbHRlcnMuYXBwZW5kKHNlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1cyk7XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQoZmlsdGVycyk7XG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjb250ZW50LmFwcGVuZENoaWxkKGxpc3QpO1xuICBjb25zdCBkcmF3ID0gKCkgPT4ge1xuICAgIGxpc3QudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IHNlbGVjdGVkTGFuZSA9IHNuYXBzaG90LnJlcXVlc3RlZExhbmUgPz8gc25hcHNob3QuZWZmZWN0aXZlTGFuZSA/PyBcImJ1bmRsZWRcIjtcbiAgICBjb25zdCBzaG93biA9IGZlYXR1cmVzLmZpbHRlcigoZmVhdHVyZSkgPT4ge1xuICAgICAgY29uc3QgZmVhdHVyZVN0YWdlID0gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgc2VsZWN0ZWRMYW5lKTtcbiAgICAgIGNvbnN0IGVuYWJsZWQgPSBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSk7XG4gICAgICBjb25zdCBsYW5lTWF0Y2ggPSBsYW5lLnZhbHVlID09PSBcImFsbFwiXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWQtb25seVwiICYmIGZlYXR1cmUuYnVuZGxlZE9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGEtb25seVwiICYmIGZlYXR1cmUuYmV0YU9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWRcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJ1bmRsZWRcIikgIT09IG51bGwpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGFcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJldGFcIikgIT09IG51bGwpO1xuICAgICAgY29uc3Qgc3RhdHVzTWF0Y2ggPSBzdGF0dXMudmFsdWUgPT09IFwiYWxsXCIgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJlbmFibGVkXCIgJiYgZW5hYmxlZCA9PT0gdHJ1ZSkgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJkaXNhYmxlZFwiICYmIGVuYWJsZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInVuc3VwcG9ydGVkXCIgJiYgZmVhdHVyZS5zdXBwb3J0ZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInJlYWQtb25seVwiICYmICFjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSkpO1xuICAgICAgcmV0dXJuICghcXVlcnkgfHwgZmVhdHVyZS5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpKSAmJiAoc3RhZ2UudmFsdWUgPT09IFwiYWxsXCIgfHwgc3RhZ2UudmFsdWUgPT09IGZlYXR1cmVTdGFnZSkgJiYgbGFuZU1hdGNoICYmIHN0YXR1c01hdGNoO1xuICAgIH0pO1xuICAgIGZvciAoY29uc3QgZmVhdHVyZSBvZiBzaG93bikgbGlzdC5hcHBlbmRDaGlsZChjb2RleEZlYXR1cmVSb3coZmVhdHVyZSwgc2VsZWN0ZWRMYW5lLCBidXN5LCByZWxvYWQpKTtcbiAgICBpZiAoIXNob3duLmxlbmd0aCkgbGlzdC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJObyBtYXRjaGluZyBmZWF0dXJlc1wiLCBcIlRyeSBhIGRpZmZlcmVudCBzZWFyY2ggb3IgZmlsdGVyLlwiKSk7XG4gIH07XG4gIGZvciAoY29uc3QgaW5wdXQgb2YgW3NlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1c10pIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoaW5wdXQgPT09IHNlYXJjaCA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCIsIGRyYXcpO1xuICBkcmF3KCk7XG4gIGRldGFpbHMuYXBwZW5kQ2hpbGQoY29udGVudCk7XG4gIHdyYXBwZXIuYXBwZW5kQ2hpbGQoZGV0YWlscyk7XG4gIHJldHVybiB3cmFwcGVyO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVSb3coXG4gIGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LFxuICBsYW5lOiBDb2RleENsaUxhbmUsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgY29uc3QgZW5hYmxlZCA9IGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSk7XG4gIGNvbnN0IG11dGFibGUgPSBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIGxhbmUpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gcm93Q29weShmZWF0dXJlLm5hbWUsIGAke3N0YWdlIHx8IFwidW5zdXBwb3J0ZWRcIn0gXHUwMEI3ICR7ZmVhdHVyZS5lZmZlY3QgPT09IFwicmVzdGFydFwiID8gXCJSZXN0YXJ0IHJlcXVpcmVkXCIgOiBmZWF0dXJlLmVmZmVjdCA9PT0gXCJub25lXCIgPyBcIk5vIHJlc3RhcnRcIiA6IFwiQXBwbGllcyB0byBuZXcgc2Vzc2lvbnNcIn1gKTtcbiAgY29uc3QgYmFkZ2VzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYmFkZ2VzLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIGlmIChmZWF0dXJlLmJ1bmRsZWRPbmx5KSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJCdW5kbGVkIG9ubHlcIikpO1xuICBpZiAoZmVhdHVyZS5iZXRhT25seSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQmV0YSBvbmx5XCIpKTtcbiAgaWYgKGZlYXR1cmUuc3VwcG9ydGVkID09PSBmYWxzZSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiVW5zdXBwb3J0ZWRcIikpO1xuICBpZiAoZW5hYmxlZCA9PT0gdHJ1ZSkgYmFkZ2VzLmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJFbmFibGVkXCIpKTtcbiAgaWYgKGVuYWJsZWQgPT09IGZhbHNlKSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJEaXNhYmxlZFwiKSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoYmFkZ2VzKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBpZiAobXV0YWJsZSAmJiBlbmFibGVkICE9PSBudWxsKSB7XG4gICAgY29uc3QgdG9nZ2xlID0gc3dpdGNoQ29udHJvbChlbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgdG9nZ2xlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c2V0LWNvZGV4LWZlYXR1cmVcIiwgeyBsYW5lLCBuYW1lOiBmZWF0dXJlLm5hbWUsIGVuYWJsZWQ6IG5leHQgfSk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgd2luZG93LmFsZXJ0KGBDb3VsZCBub3QgdXBkYXRlICR7ZmVhdHVyZS5uYW1lfTogJHtzYWZlVWlFcnJvcihlcnJvcil9YCk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdG9nZ2xlLmRpc2FibGVkID0gYnVzeTtcbiAgICB0b2dnbGUudGl0bGUgPSBcIkZlYXR1cmUgY2hhbmdlcyBhcHBseSB0byBuZXcgc2Vzc2lvbnMuXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHRvZ2dsZSk7XG4gIH0gZWxzZSB7XG4gICAgcm93LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKHN0YWdlID09PSBcImRlcHJlY2F0ZWRcIiB8fCBzdGFnZSA9PT0gXCJyZW1vdmVkXCIgPyBcIlJlYWQgb25seVwiIDogXCJVbmF2YWlsYWJsZVwiKSk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksIGxhbmU6IENvZGV4Q2xpTGFuZSk6IENvZGV4RmVhdHVyZVN0YWdlIHwgbnVsbCB7XG4gIHJldHVybiBmZWF0dXJlLnN0YWdlc1tsYW5lXTtcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSwgbGFuZTogQ29kZXhDbGlMYW5lKTogYm9vbGVhbiB8IG51bGwge1xuICByZXR1cm4gZmVhdHVyZS5lbmFibGVkW2xhbmVdO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LCBsYW5lOiBDb2RleENsaUxhbmUpOiBib29sZWFuIHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgcmV0dXJuIGZlYXR1cmUubXV0YWJsZSA9PT0gdHJ1ZVxuICAgICYmIGZlYXR1cmUuc3VwcG9ydGVkICE9PSBmYWxzZVxuICAgICYmIHN0YWdlICE9PSBcImRlcHJlY2F0ZWRcIlxuICAgICYmIHN0YWdlICE9PSBcInJlbW92ZWRcIlxuICAgICYmIGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSkgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmlsdGVyU2VsZWN0KGxhYmVsOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdKTogSFRNTFNlbGVjdEVsZW1lbnQge1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID0gXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciByb3VuZGVkLW1kIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgc2VsZWN0LnRpdGxlID0gbGFiZWw7XG4gIGZvciAoY29uc3QgdmFsdWUgb2Ygb3B0aW9ucykge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gdmFsdWUgPT09IFwiYWxsXCIgPyBgQWxsICR7bGFiZWwudG9Mb3dlckNhc2UoKX1zYCA6IGh1bWFuaXplQ29kZXhQaGFzZSh2YWx1ZSk7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdDtcbn1cblxuZnVuY3Rpb24gY29kZXhOZXV0cmFsQmFkZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3c6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHJvdy5jbGFzc0xpc3QuYWRkKFwiZmxleC13cmFwXCIpO1xuICByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKT8uY2xhc3NMaXN0LmFkZChcImZsZXgtd3JhcFwiLCBcImp1c3RpZnktZW5kXCIpO1xufVxuXG5mdW5jdGlvbiBjb2RleElubGluZU1lc3NhZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtZXNzYWdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWVzc2FnZS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIG1lc3NhZ2UudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gbWVzc2FnZTtcbn1cblxuZnVuY3Rpb24gY29kZXhQcm9ncmVzc0J1c3kocHJvZ3Jlc3M6IENvZGV4SW5zdGFsbFByb2dyZXNzKTogYm9vbGVhbiB7XG4gIHJldHVybiAhW1wiaWRsZVwiLCBcImNvbXBsZXRlXCIsIFwiZmFpbGVkXCJdLmluY2x1ZGVzKHByb2dyZXNzLnBoYXNlKTtcbn1cblxuZnVuY3Rpb24gaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc25hcHNob3Quc3RhbGU7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxlZExhdGVzdFN1bW1hcnkoXG4gIGluc3RhbGxlZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgbGF0ZXN0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBlcnJvcj86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBpbnN0YWxsZWRUZXh0ID0gaW5zdGFsbGVkIHx8IFwiVW5hdmFpbGFibGVcIjtcbiAgY29uc3QgbGF0ZXN0VGV4dCA9IGxhdGVzdCB8fCBcIlVuYXZhaWxhYmxlXCI7XG4gIHJldHVybiBgSW5zdGFsbGVkICR7aW5zdGFsbGVkVGV4dH0gXHUwMEI3IExhdGVzdCAke2xhdGVzdFRleHR9JHtlcnJvciA/IGAgXHUwMEI3ICR7ZXJyb3J9YCA6IFwiXCJ9YDtcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChzbmFwc2hvdC5mYWxsYmFja1JlYXNvbikgcmV0dXJuIGBNYW5hZ2VkIEFscGhhIGNvdWxkIG5vdCBzdGFydDsgdGhlIGRlc2t0b3AtZW1iZWRkZWQgYmFja2VuZCB3YXMgdXNlZC4gJHtzbmFwc2hvdC5mYWxsYmFja1JlYXNvbn1gO1xuICBpZiAoc25hcHNob3QucmVzdGFydFJlcXVpcmVkKSByZXR1cm4gXCJSZXN0YXJ0IHRoZSBhcHAgdG8gYXBwbHkgdGhlIHNlbGVjdGVkIENvZGV4IHJ1bnRpbWUuXCI7XG4gIGlmIChzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lICYmIHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgJiYgc25hcHNob3QucmVxdWVzdGVkTGFuZSAhPT0gc25hcHNob3QuZWZmZWN0aXZlTGFuZSkge1xuICAgIHJldHVybiBgJHtzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWRcIn0gaXMgc2VsZWN0ZWQ7ICR7c25hcHNob3QuZWZmZWN0aXZlTGFuZSA9PT0gXCJiZXRhXCIgPyBcIk1hbmFnZWQgQWxwaGEgKFByZS1yZWxlYXNlKVwiIDogXCJEZXNrdG9wLWVtYmVkZGVkXCJ9IHJlbWFpbnMgYWN0aXZlIHVudGlsIHJlc3RhcnQuYDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGNoYW5uZWw6IENvZGV4Q2xpVmVyc2lvblN0YXRlW1widmVyc2lvbkNoYW5uZWxcIl0pOiBzdHJpbmcge1xuICBpZiAoY2hhbm5lbCA9PT0gXCJzdGFibGVcIikgcmV0dXJuIFwiU3RhYmxlXCI7XG4gIGlmIChjaGFubmVsID09PSBcInByZXJlbGVhc2VcIikgcmV0dXJuIFwiUHJlLXJlbGVhc2VcIjtcbiAgcmV0dXJuIFwiVW5rbm93biByZWxlYXNlIGNoYW5uZWxcIjtcbn1cblxuZnVuY3Rpb24gY29kZXhTY29wZWRFcnJvcihcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgc2NvcGU6IFwiZGVza3RvcFwiIHwgQ29kZXhDbGlMYW5lLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzbmFwc2hvdC5lcnJvcnNbc2NvcGVdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzU2FmZUNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBpZiAoIXVybCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsKTtcbiAgICByZXR1cm4gcGFyc2VkLnByb3RvY29sID09PSBcImh0dHBzOlwiXG4gICAgICAmJiBwYXJzZWQuaG9zdG5hbWUgPT09IFwiZ2l0aHViLmNvbVwiXG4gICAgICAmJiBwYXJzZWQucG9ydCA9PT0gXCJcIlxuICAgICAgJiYgcGFyc2VkLnVzZXJuYW1lID09PSBcIlwiXG4gICAgICAmJiBwYXJzZWQucGFzc3dvcmQgPT09IFwiXCJcbiAgICAgICYmIChwYXJzZWQucGF0aG5hbWUgPT09IFwiL29wZW5haS9jb2RleFwiIHx8IHBhcnNlZC5wYXRobmFtZS5zdGFydHNXaXRoKFwiL29wZW5haS9jb2RleC9cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gb3BlbkNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNTYWZlQ29kZXhHaXRodWJVcmwodXJsKSkge1xuICAgIHBsb2coXCJibG9ja2VkIG5vbi1Db2RleCBHaXRIdWIgVVJMXCIsIHVybCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCkuY2F0Y2goKGVycm9yKSA9PiBwbG9nKFwib3BlbiBDb2RleCByZWxlYXNlIGZhaWxlZFwiLCBTdHJpbmcoZXJyb3IpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bkNvZGV4QWN0aW9uKFxuICByb3c6IEhUTUxFbGVtZW50LFxuICBjaGFubmVsOiBzdHJpbmcsXG4gIHBheWxvYWQ6IHVua25vd24sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IHZvaWQge1xuICBjb25zdCBidXR0b25zID0gcm93LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyB9KTtcbiAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgcmVsb2FkKFwib3BlcmF0aW9uLXN0YXJ0XCIpO1xuICBjb25zdCBpbnZva2UgPSBwYXlsb2FkID09PSB1bmRlZmluZWQgPyBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCkgOiBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCwgcGF5bG9hZCk7XG4gIHZvaWQgaW52b2tlXG4gICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgd2luZG93LmFsZXJ0KHNhZmVVaUVycm9yKGVycm9yKSk7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgICByZWxvYWQoXCJvcGVyYXRpb24tc3RvcFwiKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZVVpRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IgfHwgXCJVbmtub3duIGVycm9yXCIpO1xufVxuXG5mdW5jdGlvbiBodW1hbml6ZUNvZGV4UGhhc2UodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC8tL2csIFwiIFwiKS5yZXBsYWNlKC9cXGJcXHcvZywgKGxldHRlcikgPT4gbGV0dGVyLnRvVXBwZXJDYXNlKCkpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRCeXRlcyh2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlIDwgMTAyNCkgcmV0dXJuIGAke3ZhbHVlfSBCYDtcbiAgaWYgKHZhbHVlIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsodmFsdWUgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIHJldHVybiBgJHsodmFsdWUgLyAoMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpfSBNQmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZDogSFRNTEVsZW1lbnQsIGNvbmZpZzogVHdlYWtlckNvbmZpZyk6IHZvaWQge1xuICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjb25maWcudXBkYXRlQ2hlY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGF1dG9VcGRhdGVSb3coY29uZmlnKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQodXBkYXRlQ2hhbm5lbFJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChpbnN0YWxsYXRpb25Tb3VyY2VSb3coY29uZmlnLmluc3RhbGxhdGlvblNvdXJjZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHNlbGZVcGRhdGVTdGF0dXNSb3coY29uZmlnLnNlbGZVcGRhdGUpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2s/LnJlbGVhc2VOb3RlcykgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlTm90ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG59XG5cbmZ1bmN0aW9uIGF1dG9VcGRhdGVSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkF1dG9tYXRpY2FsbHkgcmVmcmVzaCBUd2Vha2Vyc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjaGVja3MgaG91cmx5IGFuZCBjYW4gcmVmcmVzaCB0aGUgVHdlYWtlcnMgcnVudGltZSBhdXRvbWF0aWNhbGx5LmA7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJvdy5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKGNvbmZpZy5hdXRvVXBkYXRlLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzZXQtYXV0by11cGRhdGVcIiwgbmV4dCk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUNoYW5uZWxSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJSZWxlYXNlIGNoYW5uZWxcIiwgdXBkYXRlQ2hhbm5lbFN1bW1hcnkoY29uZmlnKSk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID1cbiAgICBcImgtOCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZm9yIChjb25zdCBbdmFsdWUsIGxhYmVsXSBvZiBbXG4gICAgW1wic3RhYmxlXCIsIFwiU3RhYmxlXCJdLFxuICAgIFtcInByZXJlbGVhc2VcIiwgXCJQcmVyZWxlYXNlXCJdLFxuICAgIFtcImN1c3RvbVwiLCBcIkN1c3RvbVwiXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgb3B0aW9uLnNlbGVjdGVkID0gY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IHZhbHVlO1xuICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICB9XG4gIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwidHdlYWtlcjpzZXQtdXBkYXRlLWNvbmZpZ1wiLCB7IHVwZGF0ZUNoYW5uZWw6IHNlbGVjdC52YWx1ZSB9KVxuICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENvbmZpZ0NhcmQocm93KSlcbiAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInNldCB1cGRhdGUgY2hhbm5lbCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gIH0pO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKHNlbGVjdCk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gXCJjdXN0b21cIikge1xuICAgIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiRWRpdFwiLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlcG8gPSB3aW5kb3cucHJvbXB0KFwiR2l0SHViIHJlcG9cIiwgY29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCIpO1xuICAgICAgICBpZiAocmVwbyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICBjb25zdCByZWYgPSB3aW5kb3cucHJvbXB0KFwiR2l0IHJlZlwiLCBjb25maWcudXBkYXRlUmVmIHx8IFwibWFpblwiKTtcbiAgICAgICAgaWYgKHJlZiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgICAgLmludm9rZShcInR3ZWFrZXI6c2V0LXVwZGF0ZS1jb25maWdcIiwge1xuICAgICAgICAgICAgdXBkYXRlQ2hhbm5lbDogXCJjdXN0b21cIixcbiAgICAgICAgICAgIHVwZGF0ZVJlcG86IHJlcG8sXG4gICAgICAgICAgICB1cGRhdGVSZWY6IHJlZixcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKCgpID0+IHJlZnJlc2hDb25maWdDYXJkKHJvdykpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwic2V0IGN1c3RvbSB1cGRhdGUgc291cmNlIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gaW5zdGFsbGF0aW9uU291cmNlUm93KHNvdXJjZTogSW5zdGFsbGF0aW9uU291cmNlKTogSFRNTEVsZW1lbnQge1xuICByZXR1cm4gcm93U2ltcGxlKFwiSW5zdGFsbGF0aW9uIHNvdXJjZVwiLCBgJHtzb3VyY2UubGFiZWx9OiAke3NvdXJjZS5kZXRhaWx9YCk7XG59XG5cbmZ1bmN0aW9uIHNlbGZVcGRhdGVTdGF0dXNSb3coc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShcIkxhc3QgVHdlYWtlcnMgdXBkYXRlXCIsIHNlbGZVcGRhdGVTdW1tYXJ5KHN0YXRlKSk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCAmJiBzdGF0ZSkge1xuICAgIGNvbnN0IHVucHVibGlzaGVkID0gc3RhdGUuc3RhdHVzID09PSBcImZhaWxlZFwiICYmIC80MDR8bm8gKD86cHVibGlzaGVkIHxnaXRodWIgKT9yZWxlYXNlL2kudGVzdChzdGF0ZS5lcnJvciA/PyBcIlwiKTtcbiAgICBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UodW5wdWJsaXNoZWQgPyBcIm9rXCIgOiBzZWxmVXBkYXRlU3RhdHVzVG9uZShzdGF0ZS5zdGF0dXMpLCB1bnB1Ymxpc2hlZCA/IFwiQ3VycmVudFwiIDogc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXRlLnN0YXR1cykpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjaGVjayA9IGNvbmZpZy51cGRhdGVDaGVjaztcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA/IFwiVHdlYWtlcnMgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDaGVjayBmb3IgVHdlYWtlcnMgdXBkYXRlc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSB1cGRhdGVTdW1tYXJ5KGNoZWNrKTtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGlmIChjaGVjaz8ucmVsZWFzZVVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmVsZWFzZSBOb3Rlc1wiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGNoZWNrLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y2hlY2stdHdlYWtlci11cGRhdGVcIiwgdHJ1ZSlcbiAgICAgICAgLnRoZW4oKGNoZWNrKSA9PiB7XG4gICAgICAgICAgc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJUd2Vha2VycyByZWxlYXNlIGNoZWNrIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgaWYgKGNoZWNrPy51cGRhdGVBdmFpbGFibGUpIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkRvd25sb2FkIFVwZGF0ZVwiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgY29uc3QgYnV0dG9ucyA9IGFjdGlvbnMucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gdHJ1ZSkpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpydW4tdHdlYWtlci11cGRhdGVcIilcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbih0cnVlKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICBwbG9nKFwiVHdlYWtlcnMgc2VsZi11cGRhdGUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICAgICAgdm9pZCByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gZmFsc2UpKTtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBoZWFsdGg6IFdhdGNoZXJIZWFsdGgsXG4gIGluY2x1ZGVSZXBhaXIgPSBmYWxzZSxcbiAgb25SZXBhaXI/OiAoKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoKSk7XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgaGVhbHRoLmNoZWNrcykge1xuICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwib2tcIikgY29udGludWU7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyQ2hlY2tSb3coY2hlY2spKTtcbiAgfVxuICBpZiAoaW5jbHVkZVJlcGFpcikge1xuICAgIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICAgIFwiQXV0b21hdGljIG1haW50ZW5hbmNlXCIsXG4gICAgICBoZWFsdGguc3RhdHVzID09PSBcIm9rXCJcbiAgICAgICAgPyBcIlRoZSB3YXRjaGVyIGlzIGhlYWx0aHkgYW5kIHdpbGwgY29udGludWUgY2hlY2tpbmcgYXV0b21hdGljYWxseS5cIlxuICAgICAgICA6IFwiUmVwYWlyIHRoZSB3YXRjaGVyIHJlZ2lzdHJhdGlvbiBhbmQgcnVuIGEgZnJlc2ggaGVhbHRoIGNoZWNrLlwiLFxuICAgICk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZXBhaXIgTm93XCIsIG9uUmVwYWlyID8/ICgoKSA9PiB7XG4gICAgICBjb25zdCBidXR0b24gPSBhY3Rpb25zLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICAgICAgaWYgKGJ1dHRvbikgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItYXV0by1tYWludGVuYW5jZVwiKVxuICAgICAgICAudGhlbigoKSA9PiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKSlcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIG5leHQgYXMgV2F0Y2hlckhlYWx0aCwgdHJ1ZSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIHtcbiAgICAgICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJlcGFpciBmYWlsZWRcIixcbiAgICAgICAgICAgIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICB9KTtcbiAgICB9KSkpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShoZWFsdGguc3RhdHVzLCBoZWFsdGgud2F0Y2hlcikpO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBoZWFsdGgudGl0bGU7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGAke2hlYWx0aC5zdW1tYXJ5fSBDaGVja2VkICR7bmV3IERhdGUoaGVhbHRoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBhY3Rpb24uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJDaGVja1JvdyhjaGVjazogV2F0Y2hlckhlYWx0aENoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSByb3dTaW1wbGUoY2hlY2submFtZSwgY2hlY2suZGV0YWlsKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0KSBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoY2hlY2suc3RhdHVzKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0JhZGdlKHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIGxhYmVsPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCB0b25lID1cbiAgICBzdGF0dXMgPT09IFwib2tcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtZ3JlZW4gdGV4dC10b2tlbi1jaGFydHMtZ3JlZW5cIlxuICAgICAgOiBzdGF0dXMgPT09IFwid2FyblwiXG4gICAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdyB0ZXh0LXRva2VuLWNoYXJ0cy15ZWxsb3dcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQgdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IGBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtICR7dG9uZX1gO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsIHx8IChzdGF0dXMgPT09IFwib2tcIiA/IFwiT0tcIiA6IHN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlJldmlld1wiIDogXCJFcnJvclwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2sgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjaGVjaykgcmV0dXJuIFwiTm8gdXBkYXRlIGNoZWNrIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBsYXRlc3QgPSBjaGVjay5sYXRlc3RWZXJzaW9uID8gYExhdGVzdCB2JHtjaGVjay5sYXRlc3RWZXJzaW9ufS4gYCA6IFwiXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBgQ2hlY2tlZCAke25ldyBEYXRlKGNoZWNrLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgaWYgKGNoZWNrLmVycm9yKSByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH0gJHtjaGVjay5lcnJvcn1gO1xuICByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH1gO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWc6IFR3ZWFrZXJDb25maWcpOiBzdHJpbmcge1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IFwiY3VzdG9tXCIpIHtcbiAgICByZXR1cm4gYCR7Y29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCJ9ICR7Y29uZmlnLnVwZGF0ZVJlZiB8fCBcIihubyByZWYgc2V0KVwifWA7XG4gIH1cbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcInByZXJlbGVhc2VcIikge1xuICAgIHJldHVybiBcIlVzZSB0aGUgbmV3ZXN0IHB1Ymxpc2hlZCBHaXRIdWIgcmVsZWFzZSwgaW5jbHVkaW5nIHByZXJlbGVhc2VzLlwiO1xuICB9XG4gIHJldHVybiBcIlVzZSB0aGUgbGF0ZXN0IHN0YWJsZSBHaXRIdWIgcmVsZWFzZS5cIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIXN0YXRlKSByZXR1cm4gXCJObyBhdXRvbWF0aWMgVHdlYWtlcnMgdXBkYXRlIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc3RhdGUuY29tcGxldGVkQXQgPz8gc3RhdGUuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICBjb25zdCB0YXJnZXQgPSBzdGF0ZS5sYXRlc3RWZXJzaW9uID8gYCBUYXJnZXQgdiR7c3RhdGUubGF0ZXN0VmVyc2lvbn0uYCA6IHN0YXRlLnRhcmdldFJlZiA/IGAgVGFyZ2V0ICR7c3RhdGUudGFyZ2V0UmVmfS5gIDogXCJcIjtcbiAgY29uc3Qgc291cmNlID0gc3RhdGUuaW5zdGFsbGF0aW9uU291cmNlPy5sYWJlbCA/PyBcInVua25vd24gc291cmNlXCI7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpKSByZXR1cm4gYFNvdXJjZSBjaGVja291dCBpcyBjdXJyZW50IGFzIG9mICR7Y2hlY2tlZH07IG5vIHB1Ymxpc2hlZCByZWxlYXNlIGV4aXN0cyB5ZXQuYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIGBVcGRhdGUgY2hlY2sgbmVlZHMgYXR0ZW50aW9uICgke2NoZWNrZWR9KS4gJHtzdGF0ZS5lcnJvciA/PyBcIlVua25vd24gZXJyb3JcIn1gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcInVwZGF0ZWRcIikgcmV0dXJuIGBVcGRhdGVkICR7Y2hlY2tlZH0uJHt0YXJnZXR9IFNvdXJjZTogJHtzb3VyY2V9LmA7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gYFVwIHRvIGRhdGUgJHtjaGVja2VkfS4ke3RhcmdldH0gU291cmNlOiAke3NvdXJjZX0uYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gYFNraXBwZWQgJHtjaGVja2VkfTsgYXV0b21hdGljIHJlZnJlc2ggaXMgZGlzYWJsZWQuYDtcbiAgcmV0dXJuIGBDaGVja2luZyBmb3IgdXBkYXRlcy4gU291cmNlOiAke3NvdXJjZX0uYDtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1RvbmUoc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAoc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIgfHwgc3RhdHVzID09PSBcImNoZWNraW5nXCIpIHJldHVybiBcIndhcm5cIjtcbiAgcmV0dXJuIFwib2tcIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gXCJVcCB0byBkYXRlXCI7XG4gIGlmIChzdGF0dXMgPT09IFwidXBkYXRlZFwiKSByZXR1cm4gXCJVcGRhdGVkXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcIkZhaWxlZFwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIpIHJldHVybiBcIkRpc2FibGVkXCI7XG4gIHJldHVybiBcIkNoZWNraW5nXCI7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hDb25maWdDYXJkKHJvdzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgY2FyZCA9IHJvdy5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlci1jb25maWctY2FyZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWNhcmQpIHJldHVybjtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUmVmcmVzaGluZ1wiLCBcIkxvYWRpbmcgY3VycmVudCBUd2Vha2VycyB1cGRhdGUgc3RhdHVzLlwiKSk7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJUd2Vha2VyQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBUd2Vha2VyQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWZyZXNoIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIFR3ZWFrZXJzXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly50d2Vha2VyL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gVHdlYWtlcnMgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIENvZGV4IGFwcCB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gT1M6IFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBMb2dzXCIsXG4gICAgICAgICAgXCJBdHRhY2ggcmVsZXZhbnQgbGluZXMgZnJvbSB0aGUgVHdlYWtlcnMgbG9nIGRpcmVjdG9yeS5cIixcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLFxuICAgICAgICBgaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvaXNzdWVzL25ldz90aXRsZT0ke3RpdGxlfSZib2R5PSR7Ym9keX1gLFxuICAgICAgKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gYWN0aW9uUm93KHRpdGxlVGV4dDogc3RyaW5nLCBkZXNjcmlwdGlvbjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5kYXRhc2V0LnR3ZWFrZXJSb3dBY3Rpb25zID0gXCJ0cnVlXCI7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrU3RvcmVQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBoZWFkZXJBY3Rpb25zPzogSFRNTEVsZW1lbnQsXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtNFwiO1xuXG4gIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzb3VyY2UuaGlkZGVuID0gdHJ1ZTtcbiAgc291cmNlLmRhdGFzZXQudHdlYWtlclN0b3JlU291cmNlID0gXCJ0cnVlXCI7XG4gIHNvdXJjZS50ZXh0Q29udGVudCA9IFwiTG9hZGluZyBsaXZlIHJlZ2lzdHJ5XCI7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCByZWZyZXNoQnRuID0gc3RvcmVJY29uQnV0dG9uKHJlZnJlc2hJY29uU3ZnKCksIFwiUmVmcmVzaCB0d2VhayBzdG9yZVwiLCAoKSA9PiB7XG4gICAgcmVmcmVzaEJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShudWxsKTtcbiAgICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICAgIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UsIHJlZnJlc2hCdG4sIHRydWUpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyZWZyZXNoQnRuKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVRvb2xiYXJCdXR0b24oXCJQdWJsaXNoIFR3ZWFrXCIsIG9wZW5QdWJsaXNoVHdlYWtEaWFsb2csIFwicHJpbWFyeVwiKSk7XG4gIGlmIChoZWFkZXJBY3Rpb25zKSB7XG4gICAgaGVhZGVyQWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oYWN0aW9ucyk7XG4gIH1cblxuICBjb25zdCBncmlkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZ3JpZC5kYXRhc2V0LnR3ZWFrZXJTdG9yZUdyaWQgPSBcInRydWVcIjtcbiAgZ3JpZC5jbGFzc05hbWUgPSBcImdyaWQgZ2FwLTRcIjtcbiAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHtcbiAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gSlNPTi5zdHJpbmdpZnkoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgcmVuZGVyVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlKTtcbiAgfSBlbHNlIHtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICB9XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc291cmNlKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChncmlkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICByZWZyZXNoVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlLCByZWZyZXNoQnRuKTtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKFxuICBncmlkOiBIVE1MRWxlbWVudCxcbiAgc291cmNlOiBIVE1MRWxlbWVudCxcbiAgcmVmcmVzaEJ0bj86IEhUTUxCdXR0b25FbGVtZW50LFxuICBmb3JjZSA9IGZhbHNlLFxuKTogdm9pZCB7XG4gIHZvaWQgZ2V0VHdlYWtTdG9yZShmb3JjZSlcbiAgICAudGhlbigoc3RvcmUpID0+IHtcbiAgICAgIGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmUgPSBKU09OLnN0cmluZ2lmeShzdG9yZSk7XG4gICAgICByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gXCJcIjtcbiAgICAgIGdyaWQucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICAgICAgc291cmNlLnRleHRDb250ZW50ID0gXCJMaXZlIHJlZ2lzdHJ5IHVuYXZhaWxhYmxlXCI7XG4gICAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG51bGwpO1xuICAgICAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJDb3VsZCBub3QgbG9hZCB0d2VhayBzdG9yZVwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChyZWZyZXNoQnRuKSByZWZyZXNoQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHdhcm1Ud2Vha1N0b3JlKCk6IHZvaWQge1xuICBpZiAoc3RhdGUudHdlYWtTdG9yZSB8fCBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSkgcmV0dXJuO1xuICB2b2lkIGdldFR3ZWFrU3RvcmUoKS50aGVuKChzdG9yZSkgPT4ge1xuICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2Uob3V0ZGF0ZWRJbnN0YWxsZWRTdG9yZUNvdW50KHN0b3JlLmVudHJpZXMpKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFR3ZWFrU3RvcmUoZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8VHdlYWtTdG9yZVJlZ2lzdHJ5Vmlldz4ge1xuICBpZiAoIWZvcmNlKSB7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHJldHVybiBQcm9taXNlLnJlc29sdmUoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlKSByZXR1cm4gc3RhdGUudHdlYWtTdG9yZVByb21pc2U7XG4gIH1cbiAgc3RhdGUudHdlYWtTdG9yZUVycm9yID0gbnVsbDtcbiAgY29uc3QgcHJvbWlzZSA9IGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LXR3ZWFrLXN0b3JlXCIpXG4gICAgLnRoZW4oKHN0b3JlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlID0gc3RvcmUgYXMgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldztcbiAgICAgIHJldHVybiBzdGF0ZS50d2Vha1N0b3JlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlRXJyb3IgPSBlO1xuICAgICAgdGhyb3cgZTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9PT0gcHJvbWlzZSkgc3RhdGUudHdlYWtTdG9yZVByb21pc2UgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9IHByb21pc2U7XG4gIHJldHVybiBwcm9taXNlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkOiBIVE1MRWxlbWVudCwgc291cmNlOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzdG9yZSA9IHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQpO1xuICBpZiAoIXN0b3JlKSByZXR1cm47XG4gIGNvbnN0IGVudHJpZXMgPSBzdG9yZS5lbnRyaWVzO1xuICBncmlkLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgc291cmNlLnRleHRDb250ZW50ID0gYFJlZnJlc2hlZCAke25ldyBEYXRlKHN0b3JlLmZldGNoZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX1gO1xuICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzKSk7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBpZiAoc3RvcmUuZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJObyB0d2Vha3MgeWV0XCIsIFwiVXNlIFB1Ymxpc2ggVHdlYWsgdG8gc3VibWl0IHRoZSBmaXJzdCBvbmUuXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVDYXJkKGVudHJ5KSk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQ6IEhUTUxFbGVtZW50KTogVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB8IG51bGwge1xuICBjb25zdCByYXcgPSBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlO1xuICBpZiAoIXJhdykgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlQ2FyZChlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc2hlbGwgPSB0d2Vha1N0b3JlQ2FyZFNoZWxsKCk7XG4gIGNvbnN0IHsgY2FyZCwgbGVmdCwgc3RhY2ssIHZlcnNpb25zLCBhY3Rpb25zIH0gPSBzaGVsbDtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhcihlbnRyeSksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyaWZpZWRTYWZlQmFkZ2UoKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcblxuICBpZiAoZW50cnkubWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gdHdlYWtTdG9yZURlc2NyaXB0aW9uKCk7XG4gICAgZGVzYy50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICB9XG5cbiAgc3RhY2suYXBwZW5kQ2hpbGQodHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKGVudHJ5LnJlcG8gPz8gZW50cnkubWFuaWZlc3QuZ2l0aHViUmVwbykpO1xuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlVmVyc2lvbkJhZGdlKGVudHJ5KSk7XG5cbiAgaWYgKGVudHJ5LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBlbnRyeS5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGFzVXBkYXRlID0gISFlbnRyeS5pbnN0YWxsZWQgJiYgZW50cnkuaW5zdGFsbGVkLnZlcnNpb24gIT09IGVudHJ5Lm1hbmlmZXN0LnZlcnNpb247XG4gIGlmIChlbnRyeS5hdmFpbGFibGUgPT09IGZhbHNlKSB7XG4gICAgY2FyZC5jbGFzc0xpc3QuYWRkKFwib3BhY2l0eS03MFwiKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIk5vdCBhdmFpbGFibGUgeWV0XCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5pbnN0YWxsZWQgJiYgIWhhc1VwZGF0ZSkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5wbGF0Zm9ybSAmJiAhZW50cnkucGxhdGZvcm0uY29tcGF0aWJsZSkge1xuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcIm9wYWNpdHktNzBcIik7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwocGxhdGZvcm1Mb2NrZWRMYWJlbChlbnRyeS5wbGF0Zm9ybSkpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5ydW50aW1lICYmICFlbnRyeS5ydW50aW1lLmNvbXBhdGlibGUpIHtcbiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJvcGFjaXR5LTcwXCIpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKHJ1bnRpbWVMb2NrZWRMYWJlbChlbnRyeS5ydW50aW1lKSkpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGVudHJ5Lmluc3RhbGxlZCA/IFwiVXBkYXRlXCIgOiBcIkluc3RhbGxcIjtcbiAgICBpZiAoaGFzVXBkYXRlKSBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIlVwZGF0ZSBhdmFpbGFibGVcIiwgXCJpbmZvXCIpKTtcbiAgICBjb25zdCBpbnN0YWxsQnV0dG9uID0gc3RvcmVJbnN0YWxsQnV0dG9uKGluc3RhbGxMYWJlbCwgKGJ1dHRvbikgPT4ge1xuICAgICAgY29uc3QgZ3JpZCA9IGNhcmQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc3RvcmUtZ3JpZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgY29uc3Qgc291cmNlID0gZ3JpZD8ucGFyZW50RWxlbWVudD8ucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtc291cmNlXVwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbiwgZW50cnkuaW5zdGFsbGVkID8gXCJVcGRhdGluZ1wiIDogXCJJbnN0YWxsaW5nXCIpO1xuICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IHRydWUpKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBlbnRyeS5pZClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHNob3dTdG9yZVRvYXN0KGAke2VudHJ5Lm1hbmlmZXN0Lm5hbWV9IGluc3RhbGxlZC5gKTtcbiAgICAgICAgICBzaG93U3RvcmVCdXR0b25JbnN0YWxsZWQoYnV0dG9uKTtcbiAgICAgICAgICB2ZXJzaW9ucy5yZXBsYWNlQ2hpbGRyZW4odHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeSwgZW50cnkubWFuaWZlc3QudmVyc2lvbikpO1xuICAgICAgICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UoTWF0aC5tYXgoMCwgY3VycmVudFN0b3JlVXBkYXRlQmFkZ2VDb3VudCgpIC0gMSkpO1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgYWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgICAgICAgICAgIGlmIChncmlkICYmIHNvdXJjZSkgcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSwgdW5kZWZpbmVkLCB0cnVlKTtcbiAgICAgICAgICB9LCA5MDApO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICByZXNldFN0b3JlSW5zdGFsbEJ1dHRvbihidXR0b24sIGluc3RhbGxMYWJlbCk7XG4gICAgICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlKSk7XG4gICAgICAgICAgc2hvd1N0b3JlQ2FyZE1lc3NhZ2UoY2FyZCwgU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlID8/IGUpKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChpbnN0YWxsQnV0dG9uKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcGxhdGZvcm1Mb2NrZWRMYWJlbChwbGF0Zm9ybTogTm9uTnVsbGFibGU8VHdlYWtTdG9yZUVudHJ5Vmlld1tcInBsYXRmb3JtXCJdPik6IHN0cmluZyB7XG4gIGNvbnN0IHN1cHBvcnRlZCA9IHBsYXRmb3JtLnN1cHBvcnRlZCA/PyBbXTtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcIndpbjMyXCIpKSByZXR1cm4gXCJXaW5kb3dzIG9ubHlcIjtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcImRhcndpblwiKSkgcmV0dXJuIFwibWFjT1Mgb25seVwiO1xuICBpZiAoc3VwcG9ydGVkLmluY2x1ZGVzKFwibGludXhcIikpIHJldHVybiBcIkxpbnV4IG9ubHlcIjtcbiAgcmV0dXJuIFwiVW5hdmFpbGFibGVcIjtcbn1cblxuZnVuY3Rpb24gcnVudGltZUxvY2tlZExhYmVsKHJ1bnRpbWU6IE5vbk51bGxhYmxlPFR3ZWFrU3RvcmVFbnRyeVZpZXdbXCJydW50aW1lXCJdPik6IHN0cmluZyB7XG4gIHJldHVybiBydW50aW1lLnJlcXVpcmVkID8gYFJlcXVpcmVzIFR3ZWFrZXJzICR7cnVudGltZS5yZXF1aXJlZH1gIDogXCJSZXF1aXJlcyBuZXdlciBUd2Vha2Vyc1wiO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVDYXJkTWVzc2FnZShjYXJkOiBIVE1MRWxlbWVudCwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNhcmQucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtY2FyZC1tZXNzYWdlXVwiKT8ucmVtb3ZlKCk7XG4gIGNvbnN0IG5vdGljZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5vdGljZS5kYXRhc2V0LnR3ZWFrZXJTdG9yZUNhcmRNZXNzYWdlID0gXCJ0cnVlXCI7XG4gIG5vdGljZS5jbGFzc05hbWUgPVxuICAgIFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci81MCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMyBweS0yIHRleHQtc20gbGVhZGluZy01IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBub3RpY2UudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICBjb25zdCBhY3Rpb25zID0gY2FyZC5sYXN0RWxlbWVudENoaWxkO1xuICBpZiAoYWN0aW9ucykgY2FyZC5pbnNlcnRCZWZvcmUobm90aWNlLCBhY3Rpb25zKTtcbiAgZWxzZSBjYXJkLmFwcGVuZENoaWxkKG5vdGljZSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVDYXJkU2hlbGwoKToge1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgbGVmdDogSFRNTEVsZW1lbnQ7XG4gIHN0YWNrOiBIVE1MRWxlbWVudDtcbiAgdmVyc2lvbnM6IEhUTUxFbGVtZW50O1xuICBhY3Rpb25zOiBIVE1MRWxlbWVudDtcbn0ge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlci80MCBmbGV4IG1pbi1oLVsxOTBweF0gZmxleC1jb2wganVzdGlmeS1iZXR3ZWVuIGdhcC00IHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdHJhbnNpdGlvbi1jb2xvcnMgaG92ZXI6YmctdG9rZW4tZm9yZWdyb3VuZC81XCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0yXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGZvb3RlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZvb3Rlci5jbGFzc05hbWUgPSBcIm10LWF1dG8gZmxleCBtaW4tdy0wIGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yXCI7XG4gIGNvbnN0IHZlcnNpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdmVyc2lvbnMuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBmb290ZXIuYXBwZW5kQ2hpbGQodmVyc2lvbnMpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGZvb3Rlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChmb290ZXIpO1xuXG4gIHJldHVybiB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlVGl0bGVSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwibGluZS1jbGFtcC0zIG1pbi13LTAgdGV4dC1zbSBsZWFkaW5nLTUgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICByZXR1cm4gZGVzYztcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKHJlcG86IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgcmVhZE1vcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWFkTW9yZS50eXBlID0gXCJidXR0b25cIjtcbiAgcmVhZE1vcmUuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IHctZml0IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gIHJlYWRNb3JlLmlubmVySFRNTCA9XG4gICAgYFJlYWQgTW9yZWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTYgMy41aDYuNVYxME0xMi4yNSAzLjc1IDQgMTJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjQ1XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICByZWFkTW9yZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb31gKTtcbiAgfSk7XG4gIHJldHVybiByZWFkTW9yZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtTdG9yZUdob3N0R3JpZChncmlkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBncmlkLnNldEF0dHJpYnV0ZShcImFyaWEtYnVzeVwiLCBcInRydWVcIik7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVHaG9zdENhcmQoKSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVHaG9zdENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9ID0gdHdlYWtTdG9yZUNhcmRTaGVsbCgpO1xuICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJwb2ludGVyLWV2ZW50cy1ub25lXCIpO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhckdob3N0KCksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXktMSBoLTUgdy00NCByb3VuZGVkLW1kXCIpKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJpZmllZFNhZmVHaG9zdEJhZGdlKCkpO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgY29uc3QgZGVzYyA9IHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpO1xuICBkZXNjLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJtdC0xIGgtMyB3LWZ1bGwgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctMTEvMTIgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctNy8xMiByb3VuZGVkXCIpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG5cbiAgY29uc3QgcmVhZE1vcmUgPSB0d2Vha1N0b3JlUmVhZE1vcmVCdXR0b24oXCJcIik7XG4gIHJlYWRNb3JlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC01IHctMjQgcm91bmRlZFwiKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHJlYWRNb3JlKTtcblxuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZChzdG9yZVZlcnNpb25HaG9zdEJhZGdlKCkpO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzR2hvc3RQaWxsKCkpO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc3RvcmVBdmF0YXJHaG9zdCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTEwIHctMTAgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLWRlZmF1bHQgYmctdHJhbnNwYXJlbnQgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC1mdWxsIHctZnVsbFwiKSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHZlcmlmaWVkU2FmZUJhZGdlKCk7XG4gIGJhZGdlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC1bMTNweF0gdy1bMTNweF0gcm91bmRlZC1zbVwiKSwgZ2hvc3RCbG9jayhcImgtMyB3LTIwIHJvdW5kZWRcIikpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzR2hvc3RQaWxsKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGlsbCA9IHN0b3JlU3RhdHVzUGlsbChcIkluc3RhbGxlZFwiKTtcbiAgcGlsbC5jbGFzc0xpc3QuYWRkKFwiYW5pbWF0ZS1wdWxzZVwiKTtcbiAgcGlsbC5zdHlsZS5jb2xvciA9IFwidHJhbnNwYXJlbnRcIjtcbiAgcmV0dXJuIHBpbGw7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoZmFsc2UpO1xuICBiYWRnZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC0zIHctMzYgcm91bmRlZFwiKSk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gZ2hvc3RCbG9jayhjbGFzc05hbWU6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmxvY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBibG9jay5jbGFzc05hbWUgPSBgYW5pbWF0ZS1wdWxzZSBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwICR7Y2xhc3NOYW1lfWA7XG4gIGJsb2NrLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcbiAgcmV0dXJuIGJsb2NrO1xufVxuXG5mdW5jdGlvbiBzdG9yZUF2YXRhcihlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtMTAgdy0xMCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXItZGVmYXVsdCBiZy10cmFuc3BhcmVudCB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgY29uc3QgaW5pdGlhbCA9IChlbnRyeS5tYW5pZmVzdC5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGZhbGxiYWNrLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGZhbGxiYWNrKTtcbiAgY29uc3QgaWNvblVybCA9IHN0b3JlRW50cnlJY29uVXJsKGVudHJ5KTtcbiAgaWYgKGljb25VcmwpIHtcbiAgICBjb25zdCBpbWcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICAgIGltZy5hbHQgPSBcIlwiO1xuICAgIGltZy5jbGFzc05hbWUgPSBcImgtZnVsbCB3LWZ1bGwgb2JqZWN0LWNvdmVyXCI7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgaW1nLnNyYyA9IGljb25Vcmw7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGltZyk7XG4gIH1cbiAgcmV0dXJuIGF2YXRhcjtcbn1cblxuZnVuY3Rpb24gc3RvcmVFbnRyeUljb25VcmwoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgaWNvblVybCA9IGVudHJ5Lm1hbmlmZXN0Lmljb25Vcmw/LnRyaW0oKTtcbiAgaWYgKCFpY29uVXJsKSByZXR1cm4gbnVsbDtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopL2kudGVzdChpY29uVXJsKSkgcmV0dXJuIGljb25Vcmw7XG4gIGNvbnN0IHJlbCA9IGljb25VcmwucmVwbGFjZSgvXlxcLj9cXC8vLCBcIlwiKTtcbiAgaWYgKCFyZWwgfHwgcmVsLnN0YXJ0c1dpdGgoXCIuLi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIiB8fCAhZW50cnkucmVwbyB8fCAhZW50cnkuYXBwcm92ZWRDb21taXRTaGEpIHJldHVybiBudWxsO1xuICByZXR1cm4gYGh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS8ke2VudHJ5LnJlcG99LyR7ZW50cnkuYXBwcm92ZWRDb21taXRTaGF9LyR7cmVsfWA7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJVcGRhdGVQaWxsQnV0dG9uKCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyU2lkZWJhclVwZGF0ZSA9IFwidHJ1ZVwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtZnVsbCBiZy10b2tlbi1jaGFydHMtYmx1ZSB0ZXh0LXdoaXRlIGhvdmVyOmJnLXRva2VuLWNoYXJ0cy1ibHVlLzgwXCI7XG4gIE9iamVjdC5hc3NpZ24oYnRuLnN0eWxlLCB7XG4gICAgZGlzcGxheTogXCJub25lXCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgOHB4XCIsXG4gICAgZm9udFNpemU6IFwiMTBweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gICAgdGV4dFRyYW5zZm9ybTogXCJub25lXCIsXG4gIH0pO1xuICBidG4udGV4dENvbnRlbnQgPSBcIlVwZGF0ZVwiO1xuICBidG4udGl0bGUgPSBcIk9wZW4gVHdlYWtlcnMgdXBkYXRlXCI7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBidG4uZGF0YXNldC50d2Vha2VyUmVsZWFzZVVybCB8fCBUV0VBS0VSU19SRUxFQVNFU19VUkwpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLXR3ZWFrZXItdXBkYXRlXCIsIGZvcmNlKVxuICAgIC50aGVuKChjaGVjaykgPT4gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIHBsb2coXCJUd2Vha2VycyBzaWRlYmFyIHJlbGVhc2UgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihudWxsKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayB8IG51bGwpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgY29uc3QgdXBkYXRlQXZhaWxhYmxlID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA9PT0gdHJ1ZTtcbiAgYnRuLnN0eWxlLmRpc3BsYXkgPSB1cGRhdGVBdmFpbGFibGUgPyBcImlubGluZS1mbGV4XCIgOiBcIm5vbmVcIjtcbiAgYnRuLmhpZGRlbiA9ICF1cGRhdGVBdmFpbGFibGU7XG4gIGJ0bi5kYXRhc2V0LnR3ZWFrZXJSZWxlYXNlVXJsID0gY2hlY2s/LnJlbGVhc2VVcmwgfHwgVFdFQUtFUlNfUkVMRUFTRVNfVVJMO1xuICBidG4udGl0bGUgPVxuICAgIHVwZGF0ZUF2YWlsYWJsZSAmJiBjaGVjaz8ubGF0ZXN0VmVyc2lvblxuICAgICAgPyBgT3BlbiBUd2Vha2VycyAke2NoZWNrLmxhdGVzdFZlcnNpb259IHVwZGF0ZWBcbiAgICAgIDogXCJPcGVuIFR3ZWFrZXJzIHVwZGF0ZVwiO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKGNvdW50OiBudW1iZXIgfCBudWxsKTogdm9pZCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGlmICghYmFkZ2UpIHJldHVybjtcbiAgYmFkZ2UuZGF0YXNldC50d2Vha2VyU3RvcmVVcGRhdGVDb3VudCA9IGNvdW50ID09PSBudWxsID8gXCJcIiA6IFN0cmluZyhjb3VudCk7XG4gIGFwcGx5U3RvcmVVcGRhdGVCYWRnZVN0eWxlKGJhZGdlLCBjb3VudCk7XG4gIGJhZGdlLmhpZGRlbiA9IGNvdW50ID09PSBudWxsIHx8IGNvdW50IDw9IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gY291bnQgJiYgY291bnQgPiAwID8gU3RyaW5nKGNvdW50KSA6IFwiXCI7XG4gIGJhZGdlLnRpdGxlID1cbiAgICBjb3VudCAmJiBjb3VudCA+IDBcbiAgICAgID8gYCR7Y291bnR9IGluc3RhbGxlZCB0d2VhayR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGNhbiBiZSB1cGRhdGVkYFxuICAgICAgOiBcIkluc3RhbGxlZCB0d2Vha3MgYXJlIHVwIHRvIGRhdGVcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2U6IEhUTUxFbGVtZW50LCBjb3VudDogbnVtYmVyIHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCBoYXNVcGRhdGVzID0gISFjb3VudCAmJiBjb3VudCA+IDA7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiLCBoYXNVcGRhdGVzKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcInRleHQtd2hpdGVcIiwgaGFzVXBkYXRlcyk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10cmFuc3BhcmVudFwiLCAhaGFzVXBkYXRlcyk7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBtaW5XaWR0aDogXCIyNHB4XCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgN3B4XCIsXG4gICAgZm9udFNpemU6IFwiMTJweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjdXJyZW50U3RvcmVVcGRhdGVCYWRnZUNvdW50KCk6IG51bWJlciB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGNvbnN0IHJhdyA9IGJhZGdlPy5kYXRhc2V0LnR3ZWFrZXJTdG9yZVVwZGF0ZUNvdW50O1xuICBjb25zdCBwYXJzZWQgPSByYXcgPyBOdW1iZXIocmF3KSA6IDA7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IDA7XG59XG5cbmZ1bmN0aW9uIG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlWaWV3W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiAhIWVudHJ5Lmluc3RhbGxlZCAmJiBlbnRyeS5pbnN0YWxsZWQudmVyc2lvbiAhPT0gZW50cnkubWFuaWZlc3QudmVyc2lvbikubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBzdG9yZVRvb2xiYXJCdXR0b24oXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4gIHZhcmlhbnQ6IFwicHJpbWFyeVwiIHwgXCJzZWNvbmRhcnlcIiA9IFwic2Vjb25kYXJ5XCIsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgdmFyaWFudCA9PT0gXCJwcmltYXJ5XCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tYmctZm9nIHB4LTIgcHktMCB0ZXh0LXNtIHRleHQtdG9rZW4tYnV0dG9uLXRlcnRpYXJ5LWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCBpdGVtcy1jZW50ZXIgZ2FwLTEgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRyYW5zcGFyZW50IGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAgdGV4dC1zbSB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uQnV0dG9uKFxuICBpY29uU3ZnOiBzdHJpbmcsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggdy04IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdHJhbnNwYXJlbnQgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMCB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi5pbm5lckhUTUwgPSBpY29uU3ZnO1xuICBjb25zdHJhaW5TaWRlYmFySWNvblN2ZyhidG4ucXVlcnlTZWxlY3RvcihcInN2Z1wiKSwgMTgpO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi50aXRsZSA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaEljb25TdmcoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjE4XCIgaGVpZ2h0PVwiMThcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cImljb24teHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk00LjQgOS4zNUE1LjY1IDUuNjUgMCAwIDEgMTQgNS4zTDE1Ljc1IDdNMTUuNzUgMy43NVY3aC0zLjI1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjYgMTAuNjVBNS42NSA1LjY1IDAgMCAxIDYgMTQuN0w0LjI1IDEzTTQuMjUgMTYuMjVWMTNINy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUJhZGdlKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IGgtNiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzMwIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC14cyBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgYmFkZ2UuaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjEzXCIgaGVpZ2h0PVwiMTNcIiB2aWV3Qm94PVwiMCAwIDE0IDE0XCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cInRleHQtYmx1ZS01MDBcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk03IDEuNzUgMTEuMjUgMy40djMuMmMwIDIuNi0xLjY1IDQuMjUtNC4yNSA1LjQtMi42LTEuMTUtNC4yNS0yLjgtNC4yNS01LjRWMy40TDcgMS43NVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjE1XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNC44NSA3LjA1IDYuMyA4LjQ1bDIuODUtMy4wNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuMjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmAgK1xuICAgIGA8c3Bhbj5WZXJpZmllZCBhcyBzYWZlPC9zcGFuPmA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeTogVHdlYWtTdG9yZUVudHJ5VmlldywgaW5zdGFsbGVkT3ZlcnJpZGU/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGluc3RhbGxlZE92ZXJyaWRlID8/IGVudHJ5Lmluc3RhbGxlZD8udmVyc2lvbiA/PyBudWxsO1xuICBjb25zdCBsYXRlc3QgPSBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uO1xuICBjb25zdCBoYXNVcGRhdGUgPSAhIWluc3RhbGxlZCAmJiBpbnN0YWxsZWQgIT09IGxhdGVzdDtcbiAgY29uc3QgYmFkZ2UgPSBzdG9yZVZlcnNpb25CYWRnZVNoZWxsKGhhc1VwZGF0ZSk7XG4gIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGxhYmVsLmNsYXNzTmFtZSA9IFwidHJ1bmNhdGVcIjtcbiAgbGFiZWwudGV4dENvbnRlbnQgPSBpbnN0YWxsZWRcbiAgICA/IGBJbnN0YWxsZWQgdiR7aW5zdGFsbGVkfSBcdTAwQjcgTGF0ZXN0IHYke2xhdGVzdH1gXG4gICAgOiBgTGF0ZXN0IHYke2xhdGVzdH1gO1xuICBiYWRnZS50aXRsZSA9IGluc3RhbGxlZFxuICAgID8gYEluc3RhbGxlZCB2ZXJzaW9uICR7aW5zdGFsbGVkfS4gTGF0ZXN0IGFwcHJvdmVkIHZlcnNpb24gJHtsYXRlc3R9LmBcbiAgICA6IGBMYXRlc3QgYXBwcm92ZWQgdmVyc2lvbiAke2xhdGVzdH0uYDtcbiAgYmFkZ2UuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoaGFzVXBkYXRlOiBib29sZWFuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggbWluLXctMCBtYXgtdy1mdWxsIGl0ZW1zLWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBweC0yLjUgdGV4dC14cyBmb250LW1lZGl1bVwiLFxuICAgIGhhc1VwZGF0ZVxuICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLWZvcmVncm91bmRcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIvNDAgYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzUGlsbChsYWJlbDogc3RyaW5nLCB0b25lOiBcIm5ldXRyYWxcIiB8IFwiaW5mb1wiID0gXCJuZXV0cmFsXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgcGlsbC5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgcHgtMyB0ZXh0LXNtIGZvbnQtbWVkaXVtXCIsXG4gICAgdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgID8gXCJib3JkZXIgYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICA6IFwiYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICBwaWxsLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIHJldHVybiBwaWxsO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoKTtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKGJ0bik7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b25DbGFzcyhleHRyYSA9IFwiXCIpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IG1pbi13LVs4MnB4XSBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgZ2FwLTEuNSB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItYmx1ZS01MDAvNDAgYmctYmx1ZS01MDAgcHgtMyBweS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi1mb3JlZ3JvdW5kIHNoYWRvdy1zbSB0cmFuc2l0aW9uLWNvbG9ycyBlbmFibGVkOmhvdmVyOmJnLWJsdWUtNjAwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTgwXCIsXG4gICAgZXh0cmEsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIiwgXCJ0cnVlXCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyBjbGFzcz1cImFuaW1hdGUtc3BpblwiIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiOFwiIGN5PVwiOFwiIHI9XCI1LjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIyXCIgb3BhY2l0eT1cIi4yNVwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xMy41IDhBNS41IDUuNSAwIDAgMCA4IDIuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+JHtsYWJlbH08L3NwYW4+YDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlQnV0dG9uSW5zdGFsbGVkKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKFwiYm9yZGVyLWJsdWUtNTAwIGJnLWJsdWUtNTAwXCIpO1xuICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE0XCIgaGVpZ2h0PVwiMTRcIiB2aWV3Qm94PVwiMCAwIDE2IDE2XCIgZmlsbD1cIm5vbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zLjc1IDguMTUgNi42NSAxMSAxMi4yNSA1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS44XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+SW5zdGFsbGVkPC9zcGFuPmA7XG59XG5cbmZ1bmN0aW9uIHJlc2V0U3RvcmVJbnN0YWxsQnV0dG9uKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24udGV4dENvbnRlbnQgPSBsYWJlbDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlVG9hc3QobWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGxldCBob3N0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXRvYXN0LWhvc3RdXCIpO1xuICBpZiAoIWhvc3QpIHtcbiAgICBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBob3N0LmRhdGFzZXQudHdlYWtlclN0b3JlVG9hc3RIb3N0ID0gXCJ0cnVlXCI7XG4gICAgaG9zdC5jbGFzc05hbWUgPSBcInBvaW50ZXItZXZlbnRzLW5vbmUgZml4ZWQgYm90dG9tLTUgcmlnaHQtNSB6LVs5OTk5XSBmbGV4IGZsZXgtY29sIGl0ZW1zLWVuZCBnYXAtMlwiO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gIH1cbiAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b2FzdC5jbGFzc05hbWUgPVxuICAgIFwidHJhbnNsYXRlLXktMiByb3VuZGVkLXhsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzUwIGJnLXRva2VuLW1haW4tc3VyZmFjZS1wcmltYXJ5IHB4LTMgcHktMiB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBvcGFjaXR5LTAgc2hhZG93LWxnIHRyYW5zaXRpb24tYWxsIGR1cmF0aW9uLTIwMFwiO1xuICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gIGhvc3QuYXBwZW5kQ2hpbGQodG9hc3QpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoXCJ0cmFuc2xhdGUteS0yXCIsIFwib3BhY2l0eS0wXCIpO1xuICB9KTtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgdG9hc3QuY2xhc3NMaXN0LmFkZChcInRyYW5zbGF0ZS15LTJcIiwgXCJvcGFjaXR5LTBcIik7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0b2FzdC5yZW1vdmUoKTtcbiAgICAgIGlmIChob3N0ICYmIGhvc3QuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIGhvc3QucmVtb3ZlKCk7XG4gICAgfSwgMjIwKTtcbiAgfSwgMjYwMCk7XG59XG5cbmZ1bmN0aW9uIHN0b3JlTWVzc2FnZUNhcmQodGl0bGU6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyLzQwIGZsZXggbWluLWgtWzg0cHhdIGZsZXgtY29sIGp1c3RpZnktY2VudGVyIGdhcC0xIHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdGV4dC1zbVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcImZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgY2FyZC5hcHBlbmRDaGlsZCh0KTtcbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gICAgY2FyZC5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc2hvcnRTaGEodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5zbGljZSgwLCA3KTtcbn1cblxudHlwZSBBY3Rpb25NZW51SXRlbSA9IHsgbGFiZWw6IHN0cmluZzsgb25TZWxlY3Q6ICgpID0+IHZvaWQgfTtcblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb25zQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb25bXT4oKTtcbiAgZm9yIChjb25zdCBzZWN0aW9uIG9mIHN0YXRlLnNlY3Rpb25zLnZhbHVlcygpKSB7XG4gICAgY29uc3QgdHdlYWtJZCA9IHNlY3Rpb24uaWQuc3BsaXQoXCI6XCIpWzBdO1xuICAgIGlmICghc2VjdGlvbnNCeVR3ZWFrLmhhcyh0d2Vha0lkKSkgc2VjdGlvbnNCeVR3ZWFrLnNldCh0d2Vha0lkLCBbXSk7XG4gICAgc2VjdGlvbnNCeVR3ZWFrLmdldCh0d2Vha0lkKSEucHVzaChzZWN0aW9uKTtcbiAgfVxuXG4gIGNvbnN0IHBhZ2VzQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkUGFnZVtdPigpO1xuICBmb3IgKGNvbnN0IHBhZ2Ugb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICBpZiAoIXBhZ2VzQnlUd2Vhay5oYXMocGFnZS50d2Vha0lkKSkgcGFnZXNCeVR3ZWFrLnNldChwYWdlLnR3ZWFrSWQsIFtdKTtcbiAgICBwYWdlc0J5VHdlYWsuZ2V0KHBhZ2UudHdlYWtJZCkhLnB1c2gocGFnZSk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3cmFwKTtcblxuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhci5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgd3JhcC5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCB0YWJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwidGFibGlzdFwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiRmlsdGVyIHR3ZWFrc1wiKTtcbiAgdGFicy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0YWJzKTtcblxuICBjb25zdCB0b29sYmFyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXJBY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0b29sYmFyQWN0aW9ucyk7XG5cbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VhcmNoLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHctNTYgbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTIgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWlucHV0LWJvcmRlciBiZy10b2tlbi1pbnB1dC1iYWNrZ3JvdW5kLzc1IHB4LTIuNSB0ZXh0LWJhc2Ugc2hhZG93LXNtXCI7XG4gIHNlYXJjaC5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwiaWNvbi1zbSBzaHJpbmstMCB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI5XCIgY3k9XCI5XCIgcj1cIjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJtMTMgMTMgMy41IDMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IHNlYXJjaExhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxhYmVsXCIpO1xuICBzZWFyY2hMYWJlbC5jbGFzc05hbWUgPSBcInNyLW9ubHlcIjtcbiAgc2VhcmNoTGFiZWwuaHRtbEZvciA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaExhYmVsLnRleHRDb250ZW50ID0gXCJTZWFyY2ggdHdlYWtzXCI7XG4gIGNvbnN0IHNlYXJjaElucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2hJbnB1dC5pZCA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaElucHV0LnR5cGUgPSBcInNlYXJjaFwiO1xuICBzZWFyY2hJbnB1dC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIHR3ZWFrc1wiO1xuICBzZWFyY2hJbnB1dC52YWx1ZSA9IHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeTtcbiAgc2VhcmNoSW5wdXQuY2xhc3NOYW1lID1cbiAgICBcIm1pbi13LTAgZmxleC0xIGJnLXRyYW5zcGFyZW50IHRleHQtYmFzZSB0ZXh0LXRva2VuLWlucHV0LWZvcmVncm91bmQgb3V0bGluZS1ub25lIHBsYWNlaG9sZGVyOnRleHQtdG9rZW4taW5wdXQtcGxhY2Vob2xkZXItZm9yZWdyb3VuZFwiO1xuICBjb25zdCBjbGVhclNlYXJjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNsZWFyU2VhcmNoLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjbGVhclNlYXJjaC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2xlYXIgc2VhcmNoXCIpO1xuICBjbGVhclNlYXJjaC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgY3Vyc29yLWludGVyYWN0aW9uIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGNsZWFyU2VhcmNoLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNlwiIGhlaWdodD1cIjE2XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJtNiA2IDggOE0xNCA2bC04IDhcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBjbGVhclNlYXJjaC5oaWRkZW4gPSBzdGF0ZS50d2Vha3NQYWdlUXVlcnkubGVuZ3RoID09PSAwO1xuICBzZWFyY2guYXBwZW5kKHNlYXJjaExhYmVsLCBzZWFyY2hJbnB1dCwgY2xlYXJTZWFyY2gpO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChzZWFyY2gpO1xuXG4gIGNvbnN0IGdsb2JhbE1lbnUgPSBhY3Rpb25NZW51QnV0dG9uKFwiTW9yZSB0d2VhayBhY3Rpb25zXCIsIFtcbiAgICB7XG4gICAgICBsYWJlbDogXCJGb3JjZSBSZWxvYWRcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZm9yY2UgcmVsb2FkIChtYWluKSBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbGFiZWw6IFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gIF0pO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChnbG9iYWxNZW51LmVsZW1lbnQpO1xuXG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmlkID0gXCJ0d2Vha2VyLXR3ZWFrcy1saXN0XCI7XG4gIGxpc3Quc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInRhYnBhbmVsXCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3cmFwLmFwcGVuZENoaWxkKGxpc3QpO1xuXG4gIGxldCByb3dDbGVhbnVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcbiAgY29uc3QgcmVuZGVyTGlzdCA9ICgpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGNsZWFudXAgb2Ygcm93Q2xlYW51cHMpIGNsZWFudXAoKTtcbiAgICByb3dDbGVhbnVwcyA9IFtdO1xuXG4gICAgY29uc3QgY291bnRzID0gdHdlYWtzUGFnZUNvdW50cyhzdGF0ZS5saXN0ZWRUd2Vha3MpO1xuICAgIHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZm9yIChjb25zdCBmaWx0ZXIgb2YgVFdFQUtTX1BBR0VfRklMVEVSUykge1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyID09PSBmaWx0ZXI7XG4gICAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYnV0dG9uLmlkID0gYHR3ZWFrZXItdHdlYWtzLWZpbHRlci0ke2ZpbHRlcn1gO1xuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJ0YWJcIik7XG4gICAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1jb250cm9sc1wiLCBsaXN0LmlkKTtcbiAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhzZWxlY3RlZCkpO1xuICAgICAgYnV0dG9uLmNsYXNzTmFtZSA9IFtcbiAgICAgICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xLjUgcm91bmRlZC1sZyBweC0yLjUgdGV4dC1zbSBjdXJzb3ItaW50ZXJhY3Rpb25cIixcbiAgICAgICAgc2VsZWN0ZWRcbiAgICAgICAgICA/IFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICAgICAgOiBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGhvdmVyOnRleHQtdG9rZW4tZm9yZWdyb3VuZFwiLFxuICAgICAgXS5qb2luKFwiIFwiKTtcbiAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBsYWJlbC50ZXh0Q29udGVudCA9IHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXIpO1xuICAgICAgY29uc3QgY291bnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGNvdW50LmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1pbnB1dC1wbGFjZWhvbGRlci1mb3JlZ3JvdW5kIHRhYnVsYXItbnVtc1wiO1xuICAgICAgY291bnQudGV4dENvbnRlbnQgPSBTdHJpbmcoY291bnRzW2ZpbHRlcl0pO1xuICAgICAgYnV0dG9uLmFwcGVuZChsYWJlbCwgY291bnQpO1xuICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAgIHN0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXIgPSBmaWx0ZXI7XG4gICAgICAgIHJlbmRlckxpc3QoKTtcbiAgICAgIH0pO1xuICAgICAgdGFicy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBsaXN0LnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxsZWRieVwiLCBgdHdlYWtlci10d2Vha3MtZmlsdGVyLSR7c3RhdGUudHdlYWtzUGFnZUZpbHRlcn1gKTtcblxuICAgIGNvbnN0IHZpc2libGUgPSBmaWx0ZXJUd2Vha3NQYWdlSXRlbXMoXG4gICAgICBzdGF0ZS5saXN0ZWRUd2Vha3MsXG4gICAgICBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyLFxuICAgICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5LFxuICAgICk7XG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBpZiAodmlzaWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGVtcHR5LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4taC0yOCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcHktOCB0ZXh0LWNlbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMFxuICAgICAgICA/IGBObyBjYXRhbG9nIGVudHJpZXMgYXZhaWxhYmxlLiBEcm9wIGEgdHdlYWsgZm9sZGVyIGludG8gJHt0d2Vha3NQYXRoKCl9IGFuZCByZWxvYWQuYFxuICAgICAgICA6IFwiTm8gdHdlYWtzIG1hdGNoIHRoaXMgc2VhcmNoIGFuZCBmaWx0ZXIuXCI7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHR3ZWFrIG9mIHZpc2libGUpIHtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQodHdlYWtSb3coXG4gICAgICAgIHR3ZWFrLFxuICAgICAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrLm1hbmlmZXN0LmlkKSA/PyBbXSxcbiAgICAgICAgcGFnZXNCeVR3ZWFrLmdldCh0d2Vhay5tYW5pZmVzdC5pZCkgPz8gW10sXG4gICAgICAgIChjbGVhbnVwKSA9PiByb3dDbGVhbnVwcy5wdXNoKGNsZWFudXApLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIHNlYXJjaElucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gc2VhcmNoSW5wdXQudmFsdWU7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gc2VhcmNoSW5wdXQudmFsdWUubGVuZ3RoID09PSAwO1xuICAgIHJlbmRlckxpc3QoKTtcbiAgfSk7XG4gIGNsZWFyU2VhcmNoLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gXCJcIjtcbiAgICBzZWFyY2hJbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gdHJ1ZTtcbiAgICByZW5kZXJMaXN0KCk7XG4gICAgc2VhcmNoSW5wdXQuZm9jdXMoKTtcbiAgfSk7XG5cbiAgcmVuZGVyTGlzdCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGdsb2JhbE1lbnUuZGlzcG9zZSgpO1xuICAgIGZvciAoY29uc3QgY2xlYW51cCBvZiByb3dDbGVhbnVwcykgY2xlYW51cCgpO1xuICAgIHJvd0NsZWFudXBzID0gW107XG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIpOiBzdHJpbmcge1xuICBpZiAoZmlsdGVyID09PSBcImFsbFwiKSByZXR1cm4gXCJBbGxcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJlbmFibGVkXCIpIHJldHVybiBcIkVuYWJsZWRcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gXCJEaXNhYmxlZFwiO1xuICByZXR1cm4gXCJVcGRhdGVzXCI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrUm93KFxuICB0d2VhazogTGlzdGVkVHdlYWssXG4gIHNlY3Rpb25zOiBTZXR0aW5nc1NlY3Rpb25bXSxcbiAgcGFnZXM6IFJlZ2lzdGVyZWRQYWdlW10sXG4gIHJlZ2lzdGVyQ2xlYW51cDogKGNsZWFudXA6ICgpID0+IHZvaWQpID0+IHZvaWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG1hbmlmZXN0ID0gdHdlYWsubWFuaWZlc3Q7XG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFtcbiAgICBcImdyb3VwIGZsZXggZmxleC1jb2wgb3ZlcmZsb3ctdmlzaWJsZSByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzQwIGJnLXRva2VuLWZvcmVncm91bmQvNSB0cmFuc2l0aW9uLWNvbG9ycyBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIixcbiAgICAhdHdlYWsuaW5zdGFsbGVkIHx8IHR3ZWFrLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiID8gXCJvcGFjaXR5LTYwXCIgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi1oLVs2NHB4XSBpdGVtcy1jZW50ZXIgZ2FwLTMgcC0yLjVcIjtcbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IGNhbkNvbmZpZ3VyZSA9IHR3ZWFrLmluc3RhbGxlZCAmJiB0d2Vhay5lbmFibGVkICYmIHBhZ2VzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGNhbkNvbmZpZ3VyZSA/IFwiYnV0dG9uXCIgOiBcImRpdlwiKTtcbiAgY29udGVudC5jbGFzc05hbWUgPSBbXG4gICAgXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMyB0ZXh0LWxlZnRcIixcbiAgICBjYW5Db25maWd1cmVcbiAgICAgID8gXCJjdXJzb3ItaW50ZXJhY3Rpb24gcm91bmRlZC1sZyBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCJcbiAgICAgIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG4gIGlmIChjb250ZW50IGluc3RhbmNlb2YgSFRNTEJ1dHRvbkVsZW1lbnQpIHtcbiAgICBjb250ZW50LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvbnRlbnQudGl0bGUgPSBwYWdlcy5sZW5ndGggPT09IDFcbiAgICAgID8gYE9wZW4gJHtwYWdlc1swXSEucGFnZS50aXRsZX1gXG4gICAgICA6IGBPcGVuICR7cGFnZXMubWFwKChwYWdlKSA9PiBwYWdlLnBhZ2UudGl0bGUpLmpvaW4oXCIsIFwiKX1gO1xuICAgIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogbWFuaWZlc3QuaWQgfSk7XG4gICAgfSk7XG4gIH1cbiAgY29udGVudC5hcHBlbmRDaGlsZCh0d2Vha0F2YXRhcih0d2VhaykpO1xuXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0wLjVcIjtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hbWUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRydW5jYXRlIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgbmFtZS50ZXh0Q29udGVudCA9IG1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKG5hbWUpO1xuICBjb25zdCB2ZXJzaW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHZlcnNpb24uY2xhc3NOYW1lID0gXCJzaHJpbmstMCB0ZXh0LXhzIGZvbnQtbm9ybWFsIHRhYnVsYXItbnVtcyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHZlcnNpb24udGV4dENvbnRlbnQgPSBgdiR7bWFuaWZlc3QudmVyc2lvbn1gO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJzaW9uKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodHdlYWtTdGF0dXNQaWxsKHR3ZWFrKSk7XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSkge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHVwZGF0ZS5jbGFzc05hbWUgPVxuICAgICAgXCJzaHJpbmstMCByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHVwZGF0ZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gIH1cbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuICBpZiAobWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGVzY3JpcHRpb24uY2xhc3NOYW1lID0gXCJsaW5lLWNsYW1wLTEgbWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkZXNjcmlwdGlvbi50ZXh0Q29udGVudCA9IG1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2NyaXB0aW9uKTtcbiAgfVxuICBjb250ZW50LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGNvbnRlbnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgYXV0aG9yID0gdHdlYWtBdXRob3JOYW1lKG1hbmlmZXN0LmF1dGhvcik7XG4gIGlmIChhdXRob3IpIHtcbiAgICBjb25zdCBhdXRob3JMYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYXV0aG9yTGFiZWwuY2xhc3NOYW1lID0gXCJoaWRkZW4gdy0yOCB0cnVuY2F0ZSB0ZXh0LXJpZ2h0IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtZDpibG9ja1wiO1xuICAgIGF1dGhvckxhYmVsLnRleHRDb250ZW50ID0gYXV0aG9yO1xuICAgIGF1dGhvckxhYmVsLnRpdGxlID0gYXV0aG9yO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYXV0aG9yTGFiZWwpO1xuICB9XG5cbiAgY29uc3Qgcm93TWVudUl0ZW1zOiBBY3Rpb25NZW51SXRlbVtdID0gW107XG4gIGlmIChjYW5Db25maWd1cmUpIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJDb25maWd1cmVcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IG1hbmlmZXN0LmlkIH0pLFxuICAgIH0pO1xuICB9XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0d2Vhay51cGRhdGUucmVsZWFzZVVybCkge1xuICAgIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIlJldmlldyBSZWxlYXNlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCB0d2Vhay51cGRhdGUhLnJlbGVhc2VVcmwpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgbGFiZWw6IFwiT3BlbiBSZXBvc2l0b3J5XCIsXG4gICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApO1xuICAgIH0sXG4gIH0pO1xuICBpZiAobWFuaWZlc3QuaG9tZXBhZ2UgJiYgbWFuaWZlc3QuaG9tZXBhZ2UgIT09IGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJPcGVuIEhvbWVwYWdlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBtYW5pZmVzdC5ob21lcGFnZSk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IHJvd01lbnUgPSBhY3Rpb25NZW51QnV0dG9uKGBNb3JlIGFjdGlvbnMgZm9yICR7bWFuaWZlc3QubmFtZX1gLCByb3dNZW51SXRlbXMpO1xuICByb3dNZW51LmVsZW1lbnQuY2xhc3NMaXN0LmFkZChcbiAgICBcImludmlzaWJsZVwiLFxuICAgIFwib3BhY2l0eS0wXCIsXG4gICAgXCJncm91cC1mb2N1cy13aXRoaW46dmlzaWJsZVwiLFxuICAgIFwiZ3JvdXAtZm9jdXMtd2l0aGluOm9wYWNpdHktMTAwXCIsXG4gICAgXCJncm91cC1ob3Zlcjp2aXNpYmxlXCIsXG4gICAgXCJncm91cC1ob3ZlcjpvcGFjaXR5LTEwMFwiLFxuICApO1xuICByZWdpc3RlckNsZWFudXAocm93TWVudS5kaXNwb3NlKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyb3dNZW51LmVsZW1lbnQpO1xuXG4gIGlmICghdHdlYWsuaW5zdGFsbGVkKSB7XG4gICAgaWYgKHR3ZWFrLmNhdGFsb2c/LmF2YWlsYWJsZSA9PT0gZmFsc2UpIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiTm90IGluc3RhbGxlZFwiKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIkluc3RhbGxcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBtYW5pZmVzdC5pZClcbiAgICAgICAgICAudGhlbigoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSlcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjYXRhbG9nIGluc3RhbGwgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgfSBlbHNlIGlmICh0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJlY292ZXJcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlY292ZXItdHdlYWtcIiwgbWFuaWZlc3QuaWQpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInR3ZWFrIHJlY292ZXJ5IGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikge1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmV0cnlcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2xlYXItdHdlYWstaGVhbHRoXCIsIG1hbmlmZXN0LmlkKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNsZWFyIHR3ZWFrIGhlYWx0aCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwidHdlYWsgcmV0cnkgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0b2dnbGUgPSBzd2l0Y2hDb250cm9sKHR3ZWFrLmVuYWJsZWQsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnNldC10d2Vhay1lbmFibGVkXCIsIG1hbmlmZXN0LmlkLCBuZXh0KTtcbiAgICB9KTtcbiAgICB0b2dnbGUuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBgJHt0d2Vhay5lbmFibGVkID8gXCJEaXNhYmxlXCIgOiBcIkVuYWJsZVwifSAke21hbmlmZXN0Lm5hbWV9YCk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZCh0b2dnbGUpO1xuICB9XG4gIGhlYWRlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAvLyBQcmVzZXJ2ZSB0aGUgbGVnYWN5IFNldHRpbmdzU2VjdGlvbiBjb250cmFjdDogcmVnaXN0ZXJlZCBzZWN0aW9ucyBzdGlsbFxuICAvLyByZW5kZXIgZGlyZWN0bHkgYmVuZWF0aCB0aGVpciBvd25pbmcgdHdlYWsgcm93LlxuICBpZiAodHdlYWsuaW5zdGFsbGVkICYmIHR3ZWFrLmVuYWJsZWQgJiYgc2VjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5lc3RlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbmVzdGVkLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIGJvcmRlci10LVswLjVweF0gYm9yZGVyLXRva2VuLWJvcmRlclwiO1xuICAgIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gICAgICB0cnkge1xuICAgICAgICBzZWN0aW9uLnJlbmRlcihib2R5KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYm9keS5jbGFzc05hbWUgPSBcInAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiB0d2Vha0F2YXRhcih0d2VhazogTGlzdGVkVHdlYWspOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC0xMCB3LTEwIHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci1kZWZhdWx0IGJnLXRyYW5zcGFyZW50IHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgY29uc3QgaW5pdGlhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBpbml0aWFsLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtXCI7XG4gIGluaXRpYWwudGV4dENvbnRlbnQgPSAodHdlYWsubWFuaWZlc3QubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW5pdGlhbCk7XG4gIGlmICghdHdlYWsubWFuaWZlc3QuaWNvblVybCkgcmV0dXJuIGF2YXRhcjtcblxuICBjb25zdCBpbWFnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gIGltYWdlLmFsdCA9IFwiXCI7XG4gIGltYWdlLmNsYXNzTmFtZSA9IFwiaC1mdWxsIHctZnVsbCBvYmplY3QtY29udGFpblwiO1xuICBpbWFnZS5oaWRkZW4gPSB0cnVlO1xuICBpbWFnZS5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCAoKSA9PiB7XG4gICAgaW5pdGlhbC5yZW1vdmUoKTtcbiAgICBpbWFnZS5oaWRkZW4gPSBmYWxzZTtcbiAgfSk7XG4gIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiBpbWFnZS5yZW1vdmUoKSk7XG4gIHZvaWQgcmVzb2x2ZUljb25VcmwodHdlYWsubWFuaWZlc3QuaWNvblVybCwgdHdlYWsuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICBpZiAodXJsKSBpbWFnZS5zcmMgPSB1cmw7XG4gICAgZWxzZSBpbWFnZS5yZW1vdmUoKTtcbiAgfSk7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChpbWFnZSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrQXV0aG9yTmFtZShhdXRob3I6IFR3ZWFrTWFuaWZlc3RbXCJhdXRob3JcIl0pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICByZXR1cm4gdHlwZW9mIGF1dGhvciA9PT0gXCJzdHJpbmdcIiA/IGF1dGhvciA6IGF1dGhvci5uYW1lO1xufVxuXG5mdW5jdGlvbiBhY3Rpb25NZW51QnV0dG9uKFxuICBsYWJlbDogc3RyaW5nLFxuICBpdGVtczogQWN0aW9uTWVudUl0ZW1bXSxcbik6IHsgZWxlbWVudDogSFRNTEVsZW1lbnQ7IGRpc3Bvc2U6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5jbGFzc05hbWUgPSBcInJlbGF0aXZlIHNocmluay0wXCI7XG4gIGNvbnN0IHN1bW1hcnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3VtbWFyeVwiKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhhc3BvcHVwXCIsIFwibWVudVwiKTtcbiAgc3VtbWFyeS5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTggdy04IGxpc3Qtbm9uZSBjdXJzb3ItaW50ZXJhY3Rpb24gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbGcgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgc3VtbWFyeS5zdHlsZS5saXN0U3R5bGUgPSBcIm5vbmVcIjtcbiAgc3VtbWFyeS5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI0XCIgY3k9XCIxMFwiIHI9XCIxLjI1XCIvPjxjaXJjbGUgY3g9XCIxMFwiIGN5PVwiMTBcIiByPVwiMS4yNVwiLz48Y2lyY2xlIGN4PVwiMTZcIiBjeT1cIjEwXCIgcj1cIjEuMjVcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IG1lbnUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZW51LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJtZW51XCIpO1xuICBtZW51LmNsYXNzTmFtZSA9XG4gICAgXCJhYnNvbHV0ZSByaWdodC0wIHRvcC1mdWxsIHotNTAgbXQtMSBmbGV4IG1pbi13LTQ0IGZsZXgtY29sIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tbWFpbi1zdXJmYWNlLXByaW1hcnkgcC0xIHNoYWRvdy1sZ1wiO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcIm1lbnVpdGVtXCIpO1xuICAgIGJ1dHRvbi5jbGFzc05hbWUgPVxuICAgICAgXCJmbGV4IGgtOCB3LWZ1bGwgaXRlbXMtY2VudGVyIHJvdW5kZWQtbWQgcHgtMiB0ZXh0LWxlZnQgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBpdGVtLmxhYmVsO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGV2ZW50KSA9PiB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBkZXRhaWxzLm9wZW4gPSBmYWxzZTtcbiAgICAgIGl0ZW0ub25TZWxlY3QoKTtcbiAgICB9KTtcbiAgICBtZW51LmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gIH1cbiAgZGV0YWlscy5hcHBlbmQoc3VtbWFyeSwgbWVudSk7XG5cbiAgbGV0IGxpc3RlbmluZyA9IGZhbHNlO1xuICBjb25zdCBkZXRhY2ggPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHJldHVybjtcbiAgICBsaXN0ZW5pbmcgPSBmYWxzZTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgfTtcbiAgY29uc3QgY2xvc2UgPSAoKTogdm9pZCA9PiB7XG4gICAgZGV0YWlscy5vcGVuID0gZmFsc2U7XG4gICAgZGV0YWNoKCk7XG4gIH07XG4gIGNvbnN0IG9uUG9pbnRlckRvd24gPSAoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmICghZGV0YWlscy5pc0Nvbm5lY3RlZCB8fCAhKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIE5vZGUpIHx8ICFkZXRhaWxzLmNvbnRhaW5zKGV2ZW50LnRhcmdldCkpIGNsb3NlKCk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgIT09IFwiRXNjYXBlXCIpIHJldHVybjtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNsb3NlKCk7XG4gICAgc3VtbWFyeS5mb2N1cygpO1xuICB9O1xuICBkZXRhaWxzLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4ge1xuICAgIGlmICghZGV0YWlscy5vcGVuKSB7XG4gICAgICBkZXRhY2goKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHtcbiAgICAgIGxpc3RlbmluZyA9IHRydWU7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICAgIH1cbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IG1lbnUucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIik/LmZvY3VzKCkpO1xuICB9KTtcblxuICByZXR1cm4geyBlbGVtZW50OiBkZXRhaWxzLCBkaXNwb3NlOiBjbG9zZSB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0YXR1c1BpbGwodHdlYWs6IExpc3RlZFR3ZWFrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBsYWJlbHM6IFJlY29yZDxUd2Vha1N0YXR1cywgc3RyaW5nPiA9IHtcbiAgICBpbnN0YWxsZWQ6IFwiSW5zdGFsbGVkXCIsXG4gICAgXCJub3QtaW5zdGFsbGVkXCI6IFwiTm90IGluc3RhbGxlZFwiLFxuICAgIGVuYWJsZWQ6IFwiRW5hYmxlZFwiLFxuICAgIGRpc2FibGVkOiBcIkRpc2FibGVkXCIsXG4gICAgZmFpbGVkOiBcIkZhaWxlZFwiLFxuICAgIHF1YXJhbnRpbmVkOiBcIlF1YXJhbnRpbmVkXCIsXG4gIH07XG4gIGNvbnN0IHRvbmUgPSB0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIgfHwgdHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcImVycm9yXCIgOlxuICAgIHR3ZWFrLnN0YXR1cyA9PT0gXCJlbmFibGVkXCIgPyBcImluZm9cIiA6IFwibmV1dHJhbFwiO1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bVwiLFxuICAgIHRvbmUgPT09IFwiZXJyb3JcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkLzMwIGJnLXRva2VuLWNoYXJ0cy1yZWQvMTAgdGV4dC10b2tlbi1jaGFydHMtcmVkXCJcbiAgICAgIDogdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIsXG4gIF0uam9pbihcIiBcIik7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWxzW3R3ZWFrLnN0YXR1c107XG4gIGlmICh0d2Vhay5oZWFsdGg/LmVycm9yKSBiYWRnZS50aXRsZSA9IHR3ZWFrLmhlYWx0aC5lcnJvcjtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBvcGVuUHVibGlzaFR3ZWFrRGlhbG9nKCk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1wdWJsaXNoLWRpYWxvZ11cIik7XG4gIGV4aXN0aW5nPy5yZW1vdmUoKTtcblxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5kYXRhc2V0LnR3ZWFrZXJQdWJsaXNoRGlhbG9nID0gXCJ0cnVlXCI7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJmaXhlZCBpbnNldC0wIHotWzk5OTldIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGJnLWJsYWNrLzQwIHAtNFwiO1xuXG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCB3LWZ1bGwgbWF4LXcteGwgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1tYWluLXN1cmZhY2UtcHJpbWFyeSBwLTQgc2hhZG93LXhsXCI7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICBjb25zdCB0aXRsZVN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVTdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJQdWJsaXNoIFR3ZWFrXCI7XG4gIGNvbnN0IHN1YnRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3VidGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIlN1Ym1pdCBhIEdpdEh1YiByZXBvIGZvciBhZG1pbiByZXZpZXcuIFR3ZWFrZXJzIHJlY29yZHMgdGhlIGV4YWN0IGNvbW1pdCBhZG1pbnMgbXVzdCByZXZpZXcgYW5kIHBpbi5cIjtcbiAgdGl0bGVTdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHRpdGxlU3RhY2suYXBwZW5kQ2hpbGQoc3VidGl0bGUpO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGVTdGFjayk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiRGlzbWlzc1wiLCAoKSA9PiBvdmVybGF5LnJlbW92ZSgpKSk7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IHJlcG9JbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgcmVwb0lucHV0LnR5cGUgPSBcInRleHRcIjtcbiAgcmVwb0lucHV0LnBsYWNlaG9sZGVyID0gXCJvd25lci9yZXBvIG9yIGh0dHBzOi8vZ2l0aHViLmNvbS9vd25lci9yZXBvXCI7XG4gIHJlcG9JbnB1dC5jbGFzc05hbWUgPVxuICAgIFwiaC0xMCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKHJlcG9JbnB1dCk7XG5cbiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJUaGUgbWFuaWZlc3Qgc2hvdWxkIGluY2x1ZGUgYW4gaWNvblVybCBzdWl0YWJsZSBmb3IgdGhlIHN0b3JlLlwiO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGNvbnN0IHN1Ym1pdCA9IGNvbXBhY3RCdXR0b24oXCJPcGVuIFJldmlldyBJc3N1ZVwiLCAoKSA9PiB7XG4gICAgdm9pZCBzdWJtaXRQdWJsaXNoVHdlYWsocmVwb0lucHV0LCBzdGF0dXMpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdWJtaXQpO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgb3ZlcmxheS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIG92ZXJsYXkucmVtb3ZlKCk7XG4gIH0pO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuICByZXBvSW5wdXQuZm9jdXMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0UHVibGlzaFR3ZWFrKFxuICByZXBvSW5wdXQ6IEhUTUxJbnB1dEVsZW1lbnQsXG4gIHN0YXR1czogSFRNTEVsZW1lbnQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJSZXNvbHZpbmcgdGhlIHJlcG8gY29tbWl0IHRvIHJldmlldy5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdWJtaXNzaW9uID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnByZXBhcmUtdHdlYWstc3RvcmUtc3VibWlzc2lvblwiLFxuICAgICAgcmVwb0lucHV0LnZhbHVlLFxuICAgICkgYXMgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uO1xuICAgIGNvbnN0IHVybCA9IGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwoc3VibWlzc2lvbik7XG4gICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCk7XG4gICAgc3RhdHVzLnRleHRDb250ZW50ID0gYEdpdEh1YiByZXZpZXcgaXNzdWUgb3BlbmVkIGZvciAke3N1Ym1pc3Npb24uY29tbWl0U2hhLnNsaWNlKDAsIDcpfS5gO1xuICB9IGNhdGNoIChlKSB7XG4gICAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSA/PyBlKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IHdpZGU/OiBib29sZWFuOyB3aWR0aD86IFwiZGVmYXVsdFwiIHwgXCJwbHVnaW5zXCIgfCBcIndpZGVcIiB9LFxuKToge1xuICBvdXRlcjogSFRNTEVsZW1lbnQ7XG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQ7XG4gIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQ7XG4gIGhlYWRlckFjdGlvbnM6IEhUTUxFbGVtZW50O1xuICBoZWFkZXJUaXRsZUFjdGlvbnM6IEhUTUxFbGVtZW50O1xufSB7XG4gIGNvbnN0IG91dGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3V0ZXIuY2xhc3NOYW1lID0gXCJtYWluLXN1cmZhY2UgZmxleCBoLWZ1bGwgbWluLWgtMCBmbGV4LWNvbFwiO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9XG4gICAgXCJkcmFnZ2FibGUgZmxleCBpdGVtcy1jZW50ZXIgcHgtcGFuZWwgZWxlY3Ryb246aC10b29sYmFyIGV4dGVuc2lvbjpoLXRvb2xiYXItc21cIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3Qgc2Nyb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2Nyb2xsLmNsYXNzTmFtZSA9IFwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLXBhbmVsXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHNjcm9sbCk7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb25zdCB3aWR0aCA9IG9wdGlvbnM/LndpZHRoID8/IChvcHRpb25zPy53aWRlID8gXCJ3aWRlXCIgOiBcImRlZmF1bHRcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9IFtcbiAgICBcIm14LWF1dG8gZmxleCB3LWZ1bGwgZmxleC1jb2wgZWxlY3Ryb246bWluLXctW2NhbGMoMzIwcHgqdmFyKC0tY29kZXgtd2luZG93LXpvb20pKV1cIixcbiAgICB3aWR0aCA9PT0gXCJ3aWRlXCIgPyBcIm1heC13LTV4bFwiIDogd2lkdGggPT09IFwicGx1Z2luc1wiID8gXCJtYXgtdy0zeGxcIiA6IFwibWF4LXctMnhsXCIsXG4gIF0uam9pbihcIiBcIik7XG4gIHNjcm9sbC5hcHBlbmRDaGlsZChpbm5lcik7XG5cbiAgY29uc3QgaGVhZGVyV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcldyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGVySW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTEuNSBwYi1wYW5lbFwiO1xuICBjb25zdCB0aXRsZUxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUxpbmUuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwiZWxlY3Ryb246aGVhZGluZy1sZyBoZWFkaW5nLWJhc2UgdHJ1bmNhdGVcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICB0aXRsZUxpbmUuYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gIGNvbnN0IGhlYWRlclRpdGxlQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlclRpdGxlQWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHRpdGxlTGluZS5hcHBlbmRDaGlsZChoZWFkZXJUaXRsZUFjdGlvbnMpO1xuICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZCh0aXRsZUxpbmUpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgY29uc3QgaGVhZGVyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlckFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlckFjdGlvbnMpO1xuICBpbm5lci5hcHBlbmRDaGlsZChoZWFkZXJXcmFwKTtcblxuICBjb25zdCBzZWN0aW9uc1dyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzZWN0aW9uc1dyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1bdmFyKC0tcGFkZGluZy1wYW5lbCldXCI7XG4gIGlubmVyLmFwcGVuZENoaWxkKHNlY3Rpb25zV3JhcCk7XG5cbiAgcmV0dXJuIHsgb3V0ZXIsIHNlY3Rpb25zV3JhcCwgc3VidGl0bGU6IHN1YnRpdGxlRWxlbWVudCwgaGVhZGVyQWN0aW9ucywgaGVhZGVyVGl0bGVBY3Rpb25zIH07XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25UaXRsZSh0ZXh0OiBzdHJpbmcsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b29sYmFyIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgcHgtMCBweS0wXCI7XG4gIGNvbnN0IHRpdGxlSW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUlubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdGl0bGVJbm5lci5hcHBlbmRDaGlsZCh0KTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGVJbm5lcik7XG4gIGlmICh0cmFpbGluZykge1xuICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHJpZ2h0KTtcbiAgfVxuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbi8qKlxuICogQ29kZXgncyBcIk9wZW4gY29uZmlnLnRvbWxcIi1zdHlsZSB0cmFpbGluZyBidXR0b246IGdob3N0IGJvcmRlciwgbXV0ZWRcbiAqIGxhYmVsLCB0b3AtcmlnaHQgZGlhZ29uYWwgYXJyb3cgaWNvbi4gTWFya3VwIG1pcnJvcnMgQ29uZmlndXJhdGlvbiBwYW5lbC5cbiAqL1xuZnVuY3Rpb24gb3BlbkluUGxhY2VCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBib3JkZXIgd2hpdGVzcGFjZS1ub3dyYXAgZm9jdXM6b3V0bGluZS1ub25lIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIHJvdW5kZWQtbGcgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRhdGEtW3N0YXRlPW9wZW5dOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBib3JkZXItdHJhbnNwYXJlbnQgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcHgtMiBweS0wIHRleHQtYmFzZSBsZWFkaW5nLVsxOHB4XVwiO1xuICBidG4uaW5uZXJIVE1MID1cbiAgICBgJHtsYWJlbH1gICtcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE0LjMzNDkgMTMuMzMwMVY2LjYwNjQ1TDUuNDcwNjUgMTUuNDcwN0M1LjIxMDk1IDE1LjczMDQgNC43ODg5NSAxNS43MzA0IDQuNTI5MjUgMTUuNDcwN0M0LjI2OTU1IDE1LjIxMSA0LjI2OTU1IDE0Ljc4OSA0LjUyOTI1IDE0LjUyOTNMMTMuMzkzNSA1LjY2NTA0SDYuNjYwMTFDNi4yOTI4NCA1LjY2NTA0IDUuOTk1MDcgNS4zNjcyNyA1Ljk5NTA3IDVDNS45OTUwNyA0LjYzMjczIDYuMjkyODQgNC4zMzQ5NiA2LjY2MDExIDQuMzM0OTZIMTQuOTk5OUwxNS4xMzM3IDQuMzQ4NjNDMTUuNDM2OSA0LjQxMDU3IDE1LjY2NSA0LjY3ODU3IDE1LjY2NSA1VjEzLjMzMDFDMTUuNjY0OSAxMy42OTczIDE1LjM2NzIgMTMuOTk1MSAxNC45OTk5IDEzLjk5NTFDMTQuNjMyNyAxMy45OTUxIDE0LjMzNSAxMy42OTczIDE0LjMzNDkgMTMuMzMwMVpcIiBmaWxsPVwiY3VycmVudENvbG9yXCI+PC9wYXRoPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gY29tcGFjdEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcm91bmRlZENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcbiAgICBcInN0eWxlXCIsXG4gICAgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIixcbiAgKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHJvd1NpbXBsZSh0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBpZiAodGl0bGUpIHtcbiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0LmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKHQpO1xuICB9XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByZXR1cm4gcm93O1xufVxuXG4vKipcbiAqIENvZGV4LXN0eWxlZCB0b2dnbGUgc3dpdGNoLiBNYXJrdXAgbWlycm9ycyB0aGUgR2VuZXJhbCA+IFBlcm1pc3Npb25zIHJvd1xuICogc3dpdGNoIHdlIGNhcHR1cmVkOiBvdXRlciBidXR0b24gKHJvbGU9c3dpdGNoKSwgaW5uZXIgcGlsbCwgc2xpZGluZyBrbm9iLlxuICovXG5mdW5jdGlvbiBzd2l0Y2hDb250cm9sKFxuICBpbml0aWFsOiBib29sZWFuLFxuICBvbkNoYW5nZTogKG5leHQ6IGJvb2xlYW4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+LFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3dpdGNoXCIpO1xuXG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3Qga25vYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBrbm9iLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1bY29sb3I6dmFyKC0tZ3JheS0wKV0gYmctW2NvbG9yOnZhcigtLWdyYXktMCldIHNoYWRvdy1zbSB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC00IHctNFwiO1xuICBwaWxsLmFwcGVuZENoaWxkKGtub2IpO1xuXG4gIGNvbnN0IGFwcGx5ID0gKG9uOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiLCBTdHJpbmcob24pKTtcbiAgICBidG4uZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGJ0bi5jbGFzc05hbWUgPVxuICAgICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyIGZvY3VzLXZpc2libGU6cm91bmRlZC1mdWxsIGN1cnNvci1pbnRlcmFjdGlvblwiO1xuICAgIHBpbGwuY2xhc3NOYW1lID0gYHJlbGF0aXZlIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgdHJhbnNpdGlvbi1jb2xvcnMgZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNSB3LTggJHtcbiAgICAgIG9uID8gXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzIwXCJcbiAgICB9YDtcbiAgICBwaWxsLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLnN0eWxlLnRyYW5zZm9ybSA9IG9uID8gXCJ0cmFuc2xhdGVYKDE0cHgpXCIgOiBcInRyYW5zbGF0ZVgoMnB4KVwiO1xuICB9O1xuICBhcHBseShpbml0aWFsKTtcblxuICBidG4uYXBwZW5kQ2hpbGQocGlsbCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBjb25zdCBuZXh0ID0gYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiKSAhPT0gXCJ0cnVlXCI7XG4gICAgYXBwbHkobmV4dCk7XG4gICAgYnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25DaGFuZ2UobmV4dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpY29ucyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY29uZmlnSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTbGlkZXJzIC8gc2V0dGluZ3MgZ2x5cGguIDIweDIwIGN1cnJlbnRDb2xvci5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zIDVoOU0xNSA1aDJNMyAxMGgyTTggMTBoOU0zIDE1aDExTTE3IDE1aDBcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTNcIiBjeT1cIjVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjZcIiBjeT1cIjEwXCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxNVwiIGN5PVwiMTVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha3NJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNwYXJrbGVzIC8gXCIrK1wiIGdseXBoIGZvciB0d2Vha3MuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTAgMi41IEwxMS40IDguNiBMMTcuNSAxMCBMMTEuNCAxMS40IEwxMCAxNy41IEw4LjYgMTEuNCBMMi41IDEwIEw4LjYgOC42IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjUgMyBMMTYgNSBMMTggNS41IEwxNiA2IEwxNS41IDggTDE1IDYgTDEzIDUuNSBMMTUgNSBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIG9wYWNpdHk9XCIwLjdcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uU3ZnKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNCA4LjIgNS4xIDQuNUExLjUgMS41IDAgMCAxIDYuNTUgMy40aDYuOWExLjUgMS41IDAgMCAxIDEuNDUgMS4xTDE2IDguMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQuNSA4aDExdjcuNUExLjUgMS41IDAgMCAxIDE0IDE3SDZhMS41IDEuNSAwIDAgMS0xLjUtMS41VjhaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNy41IDh2MWEyLjUgMi41IDAgMCAwIDUgMFY4XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJhc2lkZSxuYXYsW3JvbGU9J25hdmlnYXRpb24nXSxkaXZcIiksXG4gICk7XG5cbiAgbGV0IGJlc3Q6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBiZXN0U2NvcmUgPSAtMTtcbiAgbGV0IGJlc3RBcmVhID0gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY2FuZGlkYXRlLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShjYW5kaWRhdGUpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxhYmVscyA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oY2FuZGlkYXRlKTtcbiAgICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgICBjb25zdCByZWN0ID0gY2FuZGlkYXRlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIGNvbnN0IGFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XG4gICAgY29uc3Qgd2VpZ2h0ZWQgPSBzY29yZS5jb3JlICogMTAwICsgc2NvcmUudG90YWw7XG5cbiAgICBpZiAod2VpZ2h0ZWQgPiBiZXN0U2NvcmUgfHwgKHdlaWdodGVkID09PSBiZXN0U2NvcmUgJiYgYXJlYSA8IGJlc3RBcmVhKSkge1xuICAgICAgYmVzdCA9IGNhbmRpZGF0ZTtcbiAgICAgIGJlc3RTY29yZSA9IHdlaWdodGVkO1xuICAgICAgYmVzdEFyZWEgPSBhcmVhO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBiZXN0O1xufVxuXG5jb25zdCBGT1JCSURERU5fU0VUVElOR1NfU0lERUJBUl9TRUxFQ1RPUiA9IFtcbiAgXCJbZGF0YS1jb21wb3Nlci1vdmVybGF5LWZsb2F0aW5nLXVpPSd0cnVlJ11cIixcbiAgXCJbZGF0YS10d2Vha2VyLXNsYXNoLW1lbnU9J3RydWUnXVwiLFxuICBcIltkYXRhLXR3ZWFrZXItb3ZlcmxheS1ub2lzZT0ndHJ1ZSddXCIsXG4gIFwiLmNvbXBvc2VyLWhvbWUtdG9wLW1lbnVcIixcbiAgXCIudmVydGljYWwtc2Nyb2xsLWZhZGUtbWFza1wiLFxuICBcIltjbGFzcyo9J1tjb250YWluZXItbmFtZTpob21lLW1haW4tY29udGVudF0nXVwiLFxuXS5qb2luKFwiLFwiKTtcblxuZnVuY3Rpb24gaXNGb3JiaWRkZW5TZXR0aW5nc1NpZGViYXJTdXJmYWNlKG5vZGU6IEVsZW1lbnQgfCBudWxsKTogYm9vbGVhbiB7XG4gIGlmICghbm9kZSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlbCA9IG5vZGUgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IG5vZGUgOiBub2RlLnBhcmVudEVsZW1lbnQ7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGVsLmNsb3Nlc3QoRk9SQklEREVOX1NFVFRJTkdTX1NJREVCQVJfU0VMRUNUT1IpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1saXN0LW5hdmlnYXRpb24taXRlbT0ndHJ1ZSddLCBbY21kay1pdGVtXVwiKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoZWw6IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlY3QgPSB0d2Vha2VyVmlzaWJsZUJveChlbCk7XG4gIGlmICghcmVjdCkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEN1cnJlbnQgQ29kZXggU2V0dGluZ3Mgc2lkZWJhcjogbGVmdCBjb2x1bW4sIG5vdCB0aGUgbWFpbiBjb250ZW50IHBhbmVsLlxuICBpZiAocmVjdC53aWR0aCA8IDEyMCB8fCByZWN0LndpZHRoID4gNjIwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChyZWN0LmhlaWdodCA8IDgwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChyZWN0LmxlZnQgPiB3aW5kb3cuaW5uZXJXaWR0aCAqIDAuNjUpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBsYWJlbHMgPSB0d2Vha2VyU2V0dGluZ3NMYWJlbHNGcm9tKGVsKTtcbiAgaWYgKGhhc01haW5BcHBTaWRlYmFyU2lnbmFscyhsYWJlbHMpICYmICFoYXNUd2Vha2VyU2V0dGluZ3NPbmx5U2lnbmFsKGxhYmVscykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gaXNUd2Vha2VyU2V0dGluZ3NMYWJlbFNldChsYWJlbHMpO1xufVxuXG5mdW5jdGlvbiByZW1vdmVNaXNwbGFjZWRTZXR0aW5nc0dyb3VwcygpOiB2b2lkIHtcbiAgY29uc3QgZ3JvdXBzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJbZGF0YS10d2Vha2VyPSduYXYtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0ncGFnZXMtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0nbmF0aXZlLW5hdi1oZWFkZXInXVwiLFxuICApO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIEFycmF5LmZyb20oZ3JvdXBzKSkge1xuICAgIGlmIChpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cCkpIGNvbnRpbnVlO1xuICAgIHJlc2V0VHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFN0YXRlKGdyb3VwKTtcbiAgICBncm91cC5yZW1vdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cDogSFRNTEVsZW1lbnQpOiBib29sZWFuIHtcbiAgaWYgKGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShncm91cCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBUcnVzdCB0aGUgaW5qZWN0aW9uLXRpbWUgcGxhY2VtZW50IHdoaWxlIHRoYXQgZXhhY3Qgc2lkZWJhciBub2RlIGlzXG4gIC8vIGFsaXZlLiBpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZSBpcyBsYXlvdXQtZGVwZW5kZW50ICh2aXNpYmxlIGJveCksIHNvXG4gIC8vIHJlLWp1ZGdpbmcgbWlkIFJlYWN0IHJlLXJlbmRlciBpbnRlcm1pdHRlbnRseSBmYWlscywgc3RyaXBzIHRoZSBncm91cCxcbiAgLy8gYW5kIHJlLXRyaWdnZXJzIHRoZSBvYnNlcnZlciBcdTIwMTQgYW4gaW5qZWN0L3JlbW92ZSBsb29wIGF0IHJlbmRlciBzcGVlZC5cbiAgaWYgKFxuICAgIHN0YXRlLnNpZGViYXJSb290ICYmXG4gICAgc3RhdGUuc2lkZWJhclJvb3QuaXNDb25uZWN0ZWQgJiZcbiAgICAoZ3JvdXAucGFyZW50RWxlbWVudCA9PT0gc3RhdGUuc2lkZWJhclJvb3QgfHwgc3RhdGUuc2lkZWJhclJvb3QuY29udGFpbnMoZ3JvdXApKVxuICApIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGxldCBub2RlID0gZ3JvdXAucGFyZW50RWxlbWVudDtcbiAgZm9yIChsZXQgZGVwdGggPSAwOyBub2RlICYmIGRlcHRoIDwgNDsgZGVwdGgrKykge1xuICAgIGlmIChpc0ZvcmJpZGRlblNldHRpbmdzU2lkZWJhclN1cmZhY2Uobm9kZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUobm9kZSkpIHJldHVybiB0cnVlO1xuICAgIG5vZGUgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIHJlc2V0VHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFN0YXRlKGdyb3VwOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAoc3RhdGUubmF2R3JvdXAgPT09IGdyb3VwIHx8IChzdGF0ZS5uYXZHcm91cCAmJiBncm91cC5jb250YWlucyhzdGF0ZS5uYXZHcm91cCkpKSB7XG4gICAgc3RhdGUubmF2R3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLm5hdkJ1dHRvbnMgPSBudWxsO1xuICAgIHN0YXRlLnR3ZWFrZXJVcGRhdGVCdXR0b24gPSBudWxsO1xuICB9XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwID09PSBncm91cCB8fCAoc3RhdGUucGFnZXNHcm91cCAmJiBncm91cC5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKSkpIHtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICB9XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPT09IGdyb3VwIHx8IChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgZ3JvdXAuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkpIHtcbiAgICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBudWxsO1xuICB9XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUm9vdC5jb250YWlucyhncm91cCkpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmluZENvbnRlbnRBcmVhKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFzaWRlYmFyKSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcmVudCA9IHNpZGViYXIucGFyZW50RWxlbWVudDtcbiAgd2hpbGUgKHBhcmVudCkge1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShwYXJlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZCA9PT0gc2lkZWJhciB8fCBjaGlsZC5jb250YWlucyhzaWRlYmFyKSkgY29udGludWU7XG4gICAgICBjb25zdCByID0gY2hpbGQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICBpZiAoci53aWR0aCA+IDMwMCAmJiByLmhlaWdodCA+IDIwMCkgcmV0dXJuIGNoaWxkO1xuICAgIH1cbiAgICBwYXJlbnQgPSBwYXJlbnQucGFyZW50RWxlbWVudDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbWF5YmVEdW1wRG9tKCk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgICBpZiAoc2lkZWJhciAmJiAhc3RhdGUuc2lkZWJhckR1bXBlZCkge1xuICAgICAgc3RhdGUuc2lkZWJhckR1bXBlZCA9IHRydWU7XG4gICAgICBjb25zdCBzYlJvb3QgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQgPz8gc2lkZWJhcjtcbiAgICAgIHBsb2coYGNvZGV4IHNpZGViYXIgSFRNTGAsIHNiUm9vdC5vdXRlckhUTUwuc2xpY2UoMCwgMzIwMDApKTtcbiAgICB9XG4gICAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICAgIGlmICghY29udGVudCkge1xuICAgICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ICE9PSBsb2NhdGlvbi5ocmVmKSB7XG4gICAgICAgIHN0YXRlLmZpbmdlcnByaW50ID0gbG9jYXRpb24uaHJlZjtcbiAgICAgICAgcGxvZyhcImRvbSBwcm9iZSAobm8gY29udGVudClcIiwge1xuICAgICAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgICAgICBzaWRlYmFyOiBzaWRlYmFyID8gZGVzY3JpYmUoc2lkZWJhcikgOiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHBhbmVsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQuZGF0YXNldC50d2Vha2VyID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICAgIGlmIChjaGlsZC5zdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIikgY29udGludWU7XG4gICAgICBwYW5lbCA9IGNoaWxkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNvbnN0IGFjdGl2ZU5hdiA9IHNpZGViYXJcbiAgICAgID8gQXJyYXkuZnJvbShzaWRlYmFyLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYnV0dG9uLCBhXCIpKS5maW5kKFxuICAgICAgICAgIChiKSA9PlxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImRhdGEtYWN0aXZlXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5jbGFzc0xpc3QuY29udGFpbnMoXCJhY3RpdmVcIiksXG4gICAgICAgIClcbiAgICAgIDogbnVsbDtcbiAgICBjb25zdCBoZWFkaW5nID0gcGFuZWw/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFxuICAgICAgXCJoMSwgaDIsIGgzLCBbY2xhc3MqPSdoZWFkaW5nJ11cIixcbiAgICApO1xuICAgIGNvbnN0IGZpbmdlcnByaW50ID0gYCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudCA/PyBcIlwifXwke2hlYWRpbmc/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7cGFuZWw/LmNoaWxkcmVuLmxlbmd0aCA/PyAwfWA7XG4gICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ID09PSBmaW5nZXJwcmludCkgcmV0dXJuO1xuICAgIHN0YXRlLmZpbmdlcnByaW50ID0gZmluZ2VycHJpbnQ7XG4gICAgcGxvZyhcImRvbSBwcm9iZVwiLCB7XG4gICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICBhY3RpdmVOYXY6IGFjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgaGVhZGluZzogaGVhZGluZz8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgY29udGVudDogZGVzY3JpYmUoY29udGVudCksXG4gICAgfSk7XG4gICAgaWYgKHBhbmVsKSB7XG4gICAgICBjb25zdCBodG1sID0gcGFuZWwub3V0ZXJIVE1MO1xuICAgICAgcGxvZyhcbiAgICAgICAgYGNvZGV4IHBhbmVsIEhUTUwgKCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IFwiP1wifSlgLFxuICAgICAgICBodG1sLnNsaWNlKDAsIDMyMDAwKSxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgcGxvZyhcImRvbSBwcm9iZSBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBkZXNjcmliZShlbDogSFRNTEVsZW1lbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB7XG4gICAgdGFnOiBlbC50YWdOYW1lLFxuICAgIGNsczogZWwuY2xhc3NOYW1lLnNsaWNlKDAsIDEyMCksXG4gICAgaWQ6IGVsLmlkIHx8IHVuZGVmaW5lZCxcbiAgICBjaGlsZHJlbjogZWwuY2hpbGRyZW4ubGVuZ3RoLFxuICAgIHJlY3Q6ICgoKSA9PiB7XG4gICAgICBjb25zdCByID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICByZXR1cm4geyB3OiBNYXRoLnJvdW5kKHIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKHIuaGVpZ2h0KSB9O1xuICAgIH0pKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhdGgoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX3R3ZWFrZXJfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fdHdlYWtlcl90d2Vha3NfZGlyX18gPz9cbiAgICBcIjx1c2VyIGRpcj4vdHdlYWtzXCJcbiAgKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFR3ZWFrTWFuaWZlc3QgfSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RXRUFLX1NUT1JFX0lOREVYX1VSTCA9XG4gIFwiaHR0cHM6Ly90aGVyZWFsaXR5cmVwb3J0LmdpdGh1Yi5pby90d2Vha2Vycy9zdG9yZS9pbmRleC5qc29uXCI7XG5leHBvcnQgY29uc3QgVFdFQUtfU1RPUkVfUkVWSUVXX0lTU1VFX1VSTCA9XG4gIFwiaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvaXNzdWVzL25ld1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVSZWdpc3RyeSB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGdlbmVyYXRlZEF0Pzogc3RyaW5nO1xuICBlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0b3JlRW50cnkge1xuICBpZDogc3RyaW5nO1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgLyoqXG4gICAqIEFuIGVudHJ5IGNhbiBiZSBjYXRhbG9nIG1ldGFkYXRhIGJlZm9yZSBpdHMgaW1wbGVtZW50YXRpb24gaXMgc2hpcHBlZC5cbiAgICogTWV0YWRhdGEtb25seSBlbnRyaWVzIGRlbGliZXJhdGVseSBvbWl0IGluc3RhbGwgY29vcmRpbmF0ZXMgYW5kIGFyZSBuZXZlclxuICAgKiBvZmZlcmVkIHRvIHRoZSBhcmNoaXZlIGluc3RhbGxlci5cbiAgKi9cbiAgYXZhaWxhYmxlPzogYm9vbGVhbjtcbiAgLyoqIFJlbW90ZSBzb3VyY2UgY29vcmRpbmF0ZXMgYXJlIHJlcXVpcmVkIG9ubHkgZm9yIHJlbW90ZSBlbnRyaWVzLiAqL1xuICByZXBvPzogc3RyaW5nO1xuICBhcHByb3ZlZENvbW1pdFNoYT86IHN0cmluZztcbiAgLyoqIFBhY2thZ2VkIGVudHJpZXMgcG9pbnQgYXQgdGhlIGluc3RhbGxlci1idW5kbGVkIGNhbm9uaWNhbCBzb3VyY2UuICovXG4gIHNvdXJjZT86IFR3ZWFrU3RvcmVTb3VyY2U7XG4gIGFwcHJvdmVkQXQ6IHN0cmluZztcbiAgYXBwcm92ZWRCeTogc3RyaW5nO1xuICBwbGF0Zm9ybXM/OiBUd2Vha1N0b3JlUGxhdGZvcm1bXTtcbiAgcmVsZWFzZVVybD86IHN0cmluZztcbiAgcmV2aWV3VXJsPzogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSBUd2Vha1N0b3JlU291cmNlID1cbiAgfCB7IGtpbmQ6IFwiYnVuZGxlZFwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJyZW1vdGVcIjsgcmVwbzogc3RyaW5nOyBhcHByb3ZlZENvbW1pdFNoYTogc3RyaW5nIH07XG5cbi8qKiBDYW5vbmljYWwgcHJvamVjdC1vd25lZCB0d2VhayBpZGVudGlmaWVycyBhbmQgc291cmNlIGRpcmVjdG9yaWVzLiAqL1xuZXhwb3J0IGNvbnN0IEJVTkRMRURfVFdFQUtfU09VUkNFX1BBVEhTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IE9iamVjdC5mcmVlemUoe1xuICBcImNvLnR3ZWFrZXJzLmFjY291bnQtc3dpdGNoZXJcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuYWNjb3VudC1zd2l0Y2hlclwiLFxuICBcImNvLnR3ZWFrZXJzLmFwcHNob3RzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLmFwcHNob3RzXCIsXG4gIFwiY28udHdlYWtlcnMuZGV2ZWxvcGVyLXRvb2xzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLmRldmVsb3Blci10b29sc1wiLFxuICBcImNvLnR3ZWFrZXJzLnNoYWRjbi1jb2RleC11aVwiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5zaGFkY24tY29kZXgtdWlcIixcbiAgXCJjby50d2Vha2Vycy5mb2xsb3d1cFwiOiBcInR3ZWFrcy9mb2xsb3d1cFwiLFxuICBcImNvLnR3ZWFrZXJzLnByb2plY3RzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLnByb2plY3RzXCIsXG4gIFwiY28udHdlYWtlcnMudGhyZWFkLXN1bW1hcnktcHJvZmlsZXNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMudGhyZWFkLXN1bW1hcnktcHJvZmlsZXNcIixcbiAgXCJjby50d2Vha2Vycy50aXRsZWJhci1jb250cm9sc1wiOiBcInR3ZWFrcy90aXRsZWJhci1jb250cm9sc1wiLFxuICBcImNvLnR3ZWFrZXJzLnVpLWltcHJvdmVtZW50c1wiOiBcInR3ZWFrcy91aS1pbXByb3ZlbWVudHNcIixcbiAgXCJjby50d2Vha2Vycy51c2VyLXF1ZXN0aW9uc1wiOiBcInR3ZWFrcy91c2VyLXF1ZXN0aW9uc1wiLFxuICBcImNvLnR3ZWFrZXJzLnVzYWdlLWxpbWl0LXJlc2V0cy10cmFja2VyXCI6IFwidHdlYWtzL3VzYWdlLWxpbWl0LXJlc2V0cy10cmFja2VyXCIsXG59KTtcblxuZXhwb3J0IHR5cGUgVHdlYWtIZWFsdGhTdGF0dXMgPSBcImZhaWxlZFwiIHwgXCJxdWFyYW50aW5lZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrSGVhbHRoUmVjb3JkIHtcbiAgc3RhdHVzOiBUd2Vha0hlYWx0aFN0YXR1cztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG4vKiogVGhlIHVzZXItZmFjaW5nIHN0YXRlIHZvY2FidWxhcnkgZm9yIGNhdGFsb2cgcm93cy4gKi9cbmV4cG9ydCB0eXBlIFR3ZWFrU3RhdHVzID1cbiAgfCBcImluc3RhbGxlZFwiXG4gIHwgXCJub3QtaW5zdGFsbGVkXCJcbiAgfCBcImVuYWJsZWRcIlxuICB8IFwiZGlzYWJsZWRcIlxuICB8IFwiZmFpbGVkXCJcbiAgfCBcInF1YXJhbnRpbmVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdGF0dXNJbnB1dCB7XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgaGVhbHRoPzogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlVHdlYWtTdGF0dXMoaW5wdXQ6IFR3ZWFrU3RhdHVzSW5wdXQpOiBUd2Vha1N0YXR1cyB7XG4gIGlmICghaW5wdXQuaW5zdGFsbGVkKSByZXR1cm4gXCJub3QtaW5zdGFsbGVkXCI7XG4gIGlmIChpbnB1dC5oZWFsdGg/LnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiKSByZXR1cm4gXCJxdWFyYW50aW5lZFwiO1xuICBpZiAoaW5wdXQuaGVhbHRoPy5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcImZhaWxlZFwiO1xuICByZXR1cm4gaW5wdXQuZW5hYmxlZCA/IFwiZW5hYmxlZFwiIDogXCJkaXNhYmxlZFwiO1xufVxuXG5leHBvcnQgdHlwZSBUd2Vha1N0b3JlUGxhdGZvcm0gPSBcImRhcndpblwiIHwgXCJ3aW4zMlwiIHwgXCJsaW51eFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbiB7XG4gIHJlcG86IHN0cmluZztcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICBjb21taXRTaGE6IHN0cmluZztcbiAgY29tbWl0VXJsOiBzdHJpbmc7XG4gIG1hbmlmZXN0Pzoge1xuICAgIGlkPzogc3RyaW5nO1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgdmVyc2lvbj86IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICBpY29uVXJsPzogc3RyaW5nO1xuICB9O1xufVxuXG5jb25zdCBHSVRIVUJfUkVQT19SRSA9IC9eW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rJC87XG5jb25zdCBGVUxMX1NIQV9SRSA9IC9eW2EtZjAtOV17NDB9JC9pO1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplR2l0SHViUmVwbyhpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gaW5wdXQudHJpbSgpO1xuICBpZiAoIXJhdykgdGhyb3cgbmV3IEVycm9yKFwiR2l0SHViIHJlcG8gaXMgcmVxdWlyZWRcIik7XG5cbiAgY29uc3Qgc3NoID0gL15naXRAZ2l0aHViXFwuY29tOihbXi9dK1xcL1teL10rPykoPzpcXC5naXQpPyQvaS5leGVjKHJhdyk7XG4gIGlmIChzc2gpIHJldHVybiBub3JtYWxpemVSZXBvUGFydChzc2hbMV0pO1xuXG4gIGlmICgvXmh0dHBzPzpcXC9cXC8vaS50ZXN0KHJhdykpIHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgaWYgKHVybC5ob3N0bmFtZSAhPT0gXCJnaXRodWIuY29tXCIpIHRocm93IG5ldyBFcnJvcihcIk9ubHkgZ2l0aHViLmNvbSByZXBvc2l0b3JpZXMgYXJlIHN1cHBvcnRlZFwiKTtcbiAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCBcIlwiKS5zcGxpdChcIi9cIik7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkdpdEh1YiByZXBvIFVSTCBtdXN0IGluY2x1ZGUgb3duZXIgYW5kIHJlcG9zaXRvcnlcIik7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KGAke3BhcnRzWzBdfS8ke3BhcnRzWzFdfWApO1xuICB9XG5cbiAgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KHJhdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTdG9yZVJlZ2lzdHJ5KGlucHV0OiB1bmtub3duKTogVHdlYWtTdG9yZVJlZ2lzdHJ5IHtcbiAgY29uc3QgcmVnaXN0cnkgPSBpbnB1dCBhcyBQYXJ0aWFsPFR3ZWFrU3RvcmVSZWdpc3RyeT4gfCBudWxsO1xuICBpZiAoIXJlZ2lzdHJ5IHx8IHJlZ2lzdHJ5LnNjaGVtYVZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocmVnaXN0cnkuZW50cmllcykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCB0d2VhayBzdG9yZSByZWdpc3RyeVwiKTtcbiAgfVxuICBjb25zdCBlbnRyaWVzID0gcmVnaXN0cnkuZW50cmllcy5tYXAobm9ybWFsaXplU3RvcmVFbnRyeSk7XG4gIGVudHJpZXMuc29ydCgoYSwgYikgPT4gYS5tYW5pZmVzdC5uYW1lLmxvY2FsZUNvbXBhcmUoYi5tYW5pZmVzdC5uYW1lKSk7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICBnZW5lcmF0ZWRBdDogdHlwZW9mIHJlZ2lzdHJ5LmdlbmVyYXRlZEF0ID09PSBcInN0cmluZ1wiID8gcmVnaXN0cnkuZ2VuZXJhdGVkQXQgOiB1bmRlZmluZWQsXG4gICAgZW50cmllcyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNodWZmbGVTdG9yZUVudHJpZXM8VD4oXG4gIGVudHJpZXM6IHJlYWRvbmx5IFRbXSxcbiAgcmFuZG9tSW5kZXg6IChleGNsdXNpdmVNYXg6IG51bWJlcikgPT4gbnVtYmVyID0gKGV4Y2x1c2l2ZU1heCkgPT4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogZXhjbHVzaXZlTWF4KSxcbik6IFRbXSB7XG4gIGNvbnN0IHNodWZmbGVkID0gWy4uLmVudHJpZXNdO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGkgLT0gMSkge1xuICAgIGNvbnN0IGogPSByYW5kb21JbmRleChpICsgMSk7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGopIHx8IGogPCAwIHx8IGogPiBpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHNodWZmbGUgcmFuZG9tSW5kZXggcmV0dXJuZWQgJHtqfTsgZXhwZWN0ZWQgYW4gaW50ZWdlciBmcm9tIDAgdG8gJHtpfWApO1xuICAgIH1cbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlRW50cnkoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlRW50cnkge1xuICBjb25zdCBlbnRyeSA9IGlucHV0IGFzIFBhcnRpYWw8VHdlYWtTdG9yZUVudHJ5PiB8IG51bGw7XG4gIGlmICghZW50cnkgfHwgdHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHR3ZWFrIHN0b3JlIGVudHJ5XCIpO1xuICBjb25zdCBtYW5pZmVzdCA9IGVudHJ5Lm1hbmlmZXN0IGFzIFR3ZWFrTWFuaWZlc3QgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGF2YWlsYWJsZSA9IGVudHJ5LmF2YWlsYWJsZSAhPT0gZmFsc2U7XG4gIGlmICghbWFuaWZlc3Q/LmlkIHx8ICFtYW5pZmVzdC5uYW1lIHx8ICFtYW5pZmVzdC52ZXJzaW9uIHx8ICFtYW5pZmVzdC5naXRodWJSZXBvKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiU3RvcmUgZW50cnkgaXMgbWlzc2luZyBtYW5pZmVzdCBmaWVsZHNcIik7XG4gIH1cbiAgY29uc3Qgc3VwcGxpZWRSZXBvID0gdHlwZW9mIGVudHJ5LnJlcG8gPT09IFwic3RyaW5nXCIgJiYgZW50cnkucmVwby50cmltKClcbiAgICA/IG5vcm1hbGl6ZUdpdEh1YlJlcG8oZW50cnkucmVwbylcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKHN1cHBsaWVkUmVwbyAmJiBub3JtYWxpemVHaXRIdWJSZXBvKG1hbmlmZXN0LmdpdGh1YlJlcG8pICE9PSBzdXBwbGllZFJlcG8pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IHJlcG8gZG9lcyBub3QgbWF0Y2ggbWFuaWZlc3QgZ2l0aHViUmVwb2ApO1xuICB9XG4gIGNvbnN0IHNvdXJjZUlucHV0ID0gKGVudHJ5IGFzIHsgc291cmNlPzogdW5rbm93biB9KS5zb3VyY2U7XG4gIGxldCBzb3VyY2U6IFR3ZWFrU3RvcmVTb3VyY2UgfCB1bmRlZmluZWQ7XG4gIGxldCByZXBvID0gc3VwcGxpZWRSZXBvO1xuICBsZXQgYXBwcm92ZWRDb21taXRTaGEgPSB0eXBlb2YgZW50cnkuYXBwcm92ZWRDb21taXRTaGEgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA6IFwiXCI7XG4gIGlmIChzb3VyY2VJbnB1dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFzb3VyY2VJbnB1dCB8fCB0eXBlb2Ygc291cmNlSW5wdXQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShzb3VyY2VJbnB1dCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gaGFzIGFuIGludmFsaWQgc291cmNlYCk7XG4gICAgfVxuICAgIGNvbnN0IHJhd1NvdXJjZSA9IHNvdXJjZUlucHV0IGFzIHsga2luZD86IHVua25vd247IHBhdGg/OiB1bmtub3duOyByZXBvPzogdW5rbm93bjsgYXBwcm92ZWRDb21taXRTaGE/OiB1bmtub3duIH07XG4gICAgaWYgKHJhd1NvdXJjZS5raW5kID09PSBcImJ1bmRsZWRcIikge1xuICAgICAgY29uc3QgcGF0aCA9IG5vcm1hbGl6ZUJ1bmRsZWRTb3VyY2VQYXRoKHJhd1NvdXJjZS5wYXRoLCBtYW5pZmVzdC5pZCk7XG4gICAgICBzb3VyY2UgPSB7IGtpbmQ6IFwiYnVuZGxlZFwiLCBwYXRoIH07XG4gICAgICAvLyBBIGJ1bmRsZWQgc291cmNlIGlzIGludGVudGlvbmFsbHkgaW5kZXBlbmRlbnQgb2YgR2l0SHViIGNvb3JkaW5hdGVzLlxuICAgICAgcmVwbyA9IHN1cHBsaWVkUmVwbztcbiAgICAgIGFwcHJvdmVkQ29tbWl0U2hhID0gXCJcIjtcbiAgICB9IGVsc2UgaWYgKHJhd1NvdXJjZS5raW5kID09PSBcInJlbW90ZVwiKSB7XG4gICAgICBjb25zdCByZW1vdGVSZXBvID0gbm9ybWFsaXplR2l0SHViUmVwbyhTdHJpbmcocmF3U291cmNlLnJlcG8gPz8gc3VwcGxpZWRSZXBvID8/IFwiXCIpKTtcbiAgICAgIGNvbnN0IHNoYSA9IFN0cmluZyhyYXdTb3VyY2UuYXBwcm92ZWRDb21taXRTaGEgPz8gZW50cnkuYXBwcm92ZWRDb21taXRTaGEgPz8gXCJcIik7XG4gICAgICBpZiAoYXZhaWxhYmxlICYmICFpc0Z1bGxDb21taXRTaGEoc2hhKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IG11c3QgcGluIGEgZnVsbCBhcHByb3ZlZCBjb21taXQgU0hBYCk7XG4gICAgICB9XG4gICAgICBpZiAoc3VwcGxpZWRSZXBvICYmIHN1cHBsaWVkUmVwbyAhPT0gcmVtb3RlUmVwbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IHJlbW90ZSBzb3VyY2UgcmVwbyBkb2VzIG5vdCBtYXRjaCByZXBvYCk7XG4gICAgICB9XG4gICAgICBzb3VyY2UgPSB7IGtpbmQ6IFwicmVtb3RlXCIsIHJlcG86IHJlbW90ZVJlcG8sIGFwcHJvdmVkQ29tbWl0U2hhOiBzaGEgfTtcbiAgICAgIHJlcG8gPSByZW1vdGVSZXBvO1xuICAgICAgYXBwcm92ZWRDb21taXRTaGEgPSBzaGE7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gaGFzIHVuc3VwcG9ydGVkIHNvdXJjZSBraW5kYCk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGF2YWlsYWJsZSkge1xuICAgIC8vIExlZ2FjeSBhdmFpbGFibGUgZW50cmllcyBhcmUgcmVtb3RlIGFuZCBtdXN0IHJlbWFpbiBwaW5uZWQuXG4gICAgcmVwbyA9IG5vcm1hbGl6ZUdpdEh1YlJlcG8oU3RyaW5nKHJlcG8gPz8gbWFuaWZlc3QuZ2l0aHViUmVwbyA/PyBcIlwiKSk7XG4gICAgaWYgKCFpc0Z1bGxDb21taXRTaGEoYXBwcm92ZWRDb21taXRTaGEpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IG11c3QgcGluIGEgZnVsbCBhcHByb3ZlZCBjb21taXQgU0hBYCk7XG4gICAgfVxuICAgIHNvdXJjZSA9IHsga2luZDogXCJyZW1vdGVcIiwgcmVwbywgYXBwcm92ZWRDb21taXRTaGEgfTtcbiAgfSBlbHNlIGlmICghcmVwbykge1xuICAgIC8vIE1ldGFkYXRhLW9ubHkgZW50cmllcyBtYXkgb21pdCBhbGwgaW5zdGFsbCBjb29yZGluYXRlcy4gS2VlcCB0aGUgc291cmNlXG4gICAgLy8gYWJzZW50IHNvIGNhbGxlcnMgY2Fubm90IGFjY2lkZW50YWxseSB0cmVhdCB0aGVtIGFzIGluc3RhbGxhYmxlLlxuICB9XG4gIHJldHVybiB7XG4gICAgaWQ6IG1hbmlmZXN0LmlkLFxuICAgIG1hbmlmZXN0LFxuICAgIGF2YWlsYWJsZSxcbiAgICAuLi4ocmVwbyA/IHsgcmVwbyB9IDoge30pLFxuICAgIGFwcHJvdmVkQ29tbWl0U2hhLFxuICAgIC4uLihzb3VyY2UgPyB7IHNvdXJjZSB9IDoge30pLFxuICAgIGFwcHJvdmVkQXQ6IHR5cGVvZiBlbnRyeS5hcHByb3ZlZEF0ID09PSBcInN0cmluZ1wiID8gZW50cnkuYXBwcm92ZWRBdCA6IFwiXCIsXG4gICAgYXBwcm92ZWRCeTogdHlwZW9mIGVudHJ5LmFwcHJvdmVkQnkgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZEJ5IDogXCJcIixcbiAgICBwbGF0Zm9ybXM6IG5vcm1hbGl6ZVN0b3JlUGxhdGZvcm1zKChlbnRyeSBhcyB7IHBsYXRmb3Jtcz86IHVua25vd24gfSkucGxhdGZvcm1zKSxcbiAgICByZWxlYXNlVXJsOiBvcHRpb25hbEdpdGh1YlVybChlbnRyeS5yZWxlYXNlVXJsKSxcbiAgICByZXZpZXdVcmw6IG9wdGlvbmFsR2l0aHViVXJsKGVudHJ5LnJldmlld1VybCksXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdG9yZUFyY2hpdmVVcmwoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeSk6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwiYnVuZGxlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSB1c2VzIGEgYnVuZGxlZCBzb3VyY2UgYW5kIGhhcyBubyBhcmNoaXZlIFVSTGApO1xuICB9XG4gIGNvbnN0IHJlcG8gPSBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwicmVtb3RlXCIgPyBlbnRyeS5zb3VyY2UucmVwbyA6IGVudHJ5LnJlcG87XG4gIGNvbnN0IGFwcHJvdmVkQ29tbWl0U2hhID0gZW50cnkuc291cmNlPy5raW5kID09PSBcInJlbW90ZVwiXG4gICAgPyBlbnRyeS5zb3VyY2UuYXBwcm92ZWRDb21taXRTaGFcbiAgICA6IGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhO1xuICBpZiAoIXJlcG8gfHwgIWlzRnVsbENvbW1pdFNoYShhcHByb3ZlZENvbW1pdFNoYSA/PyBcIlwiKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gaXMgbm90IHBpbm5lZCB0byBhIGZ1bGwgY29tbWl0IFNIQWApO1xuICB9XG4gIHJldHVybiBgaHR0cHM6Ly9jb2RlbG9hZC5naXRodWIuY29tLyR7cmVwb30vdGFyLmd6LyR7YXBwcm92ZWRDb21taXRTaGF9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQnVuZGxlZFN0b3JlRW50cnkoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIjtcbn1cblxuLyoqIFJlc29sdmUgYSBwYWNrYWdlZCBzb3VyY2Ugd2hpbGUgcmVqZWN0aW5nIHRyYXZlcnNhbCBhbmQgSUQgbWlzbWF0Y2hlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQnVuZGxlZFR3ZWFrUGF0aChcbiAgcGFja2FnZWRUd2Vha3NSb290OiBzdHJpbmcsXG4gIGVudHJ5OiBQaWNrPFR3ZWFrU3RvcmVFbnRyeSwgXCJpZFwiIHwgXCJzb3VyY2VcIj4sXG4pOiBzdHJpbmcge1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kICE9PSBcImJ1bmRsZWRcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gZG9lcyBub3QgdXNlIGEgYnVuZGxlZCBzb3VyY2VgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gZW50cnkuc291cmNlLnBhdGgucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuICBpZiAoXG4gICAgIW5vcm1hbGl6ZWQgfHxcbiAgICBub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgbm9ybWFsaXplZC5zcGxpdChcIi9cIikuc29tZSgocGFydCkgPT4gcGFydCA9PT0gXCIuLlwiIHx8IHBhcnQgPT09IFwiXCIpIHx8XG4gICAgbm9ybWFsaXplZCAhPT0gQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFNbZW50cnkuaWRdXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gaGFzIGFuIHVuc2FmZSBidW5kbGVkIHNvdXJjZSBwYXRoYCk7XG4gIH1cbiAgLy8gVGhlIG5vcm1hbGl6ZWQgcGF0aCBpcyBleGFjdGx5IGB0d2Vha3MvPGlkPmAgKG5vIGRvdCBzZWdtZW50cyksIHNvIGFcbiAgLy8gc2ltcGxlIGpvaW4gaXMgc3VmZmljaWVudCBhbmQga2VlcHMgdGhpcyBzaGFyZWQgbW9kdWxlIGJyb3dzZXItYnVuZGxlYWJsZS5cbiAgY29uc3Qgcm9vdCA9IHBhY2thZ2VkVHdlYWtzUm9vdC5yZXBsYWNlKC9bXFxcXC9dKyQvLCBcIlwiKTtcbiAgcmV0dXJuIGAke3Jvb3R9LyR7bm9ybWFsaXplZH1gO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCdW5kbGVkU291cmNlUGF0aCh2YWx1ZTogdW5rbm93biwgaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtpZH0gYnVuZGxlZCBzb3VyY2UgcGF0aCBpcyByZXF1aXJlZGApO1xuICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpLnJlcGxhY2UoL15cXC5cXC8vLCBcIlwiKTtcbiAgaWYgKG5vcm1hbGl6ZWQgIT09IEJVTkRMRURfVFdFQUtfU09VUkNFX1BBVEhTW2lkXSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtpZH0gYnVuZGxlZCBzb3VyY2UgaXMgbm90IGFsbG93bGlzdGVkYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFR3ZWFrUHVibGlzaElzc3VlVXJsKHN1Ym1pc3Npb246IFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbik6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG8gPSBub3JtYWxpemVHaXRIdWJSZXBvKHN1Ym1pc3Npb24ucmVwbyk7XG4gIGlmICghaXNGdWxsQ29tbWl0U2hhKHN1Ym1pc3Npb24uY29tbWl0U2hhKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlN1Ym1pc3Npb24gbXVzdCBpbmNsdWRlIHRoZSBmdWxsIGNvbW1pdCBTSEEgdG8gcmV2aWV3XCIpO1xuICB9XG4gIGNvbnN0IHRpdGxlID0gYFR3ZWFrIHN0b3JlIHJldmlldzogJHtyZXBvfWA7XG4gIGNvbnN0IGJvZHkgPSBbXG4gICAgXCIjIyBUd2VhayByZXBvXCIsXG4gICAgYGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG99YCxcbiAgICBcIlwiLFxuICAgIFwiIyMgQ29tbWl0IHRvIHJldmlld1wiLFxuICAgIHN1Ym1pc3Npb24uY29tbWl0U2hhLFxuICAgIHN1Ym1pc3Npb24uY29tbWl0VXJsLFxuICAgIFwiXCIsXG4gICAgXCJEbyBub3QgYXBwcm92ZSBhIGRpZmZlcmVudCBjb21taXQuIElmIHRoZSBhdXRob3IgcHVzaGVzIGNoYW5nZXMsIGFzayB0aGVtIHRvIHJlc3VibWl0LlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBNYW5pZmVzdFwiLFxuICAgIGAtIGlkOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/LmlkID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIG5hbWU6ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8ubmFtZSA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSB2ZXJzaW9uOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/LnZlcnNpb24gPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gZGVzY3JpcHRpb246ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8uZGVzY3JpcHRpb24gPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gaWNvblVybDogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5pY29uVXJsID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIFwiXCIsXG4gICAgXCIjIyBBZG1pbiBjaGVja2xpc3RcIixcbiAgICBcIi0gWyBdIG1hbmlmZXN0Lmpzb24gaXMgdmFsaWRcIixcbiAgICBcIi0gWyBdIG1hbmlmZXN0Lmljb25VcmwgaXMgdXNhYmxlIGFzIHRoZSBzdG9yZSBpY29uXCIsXG4gICAgXCItIFsgXSBzb3VyY2Ugd2FzIHJldmlld2VkIGF0IHRoZSBleGFjdCBjb21taXQgYWJvdmVcIixcbiAgICBcIi0gWyBdIGBzdG9yZS9pbmRleC5qc29uYCBlbnRyeSBwaW5zIGBhcHByb3ZlZENvbW1pdFNoYWAgdG8gdGhlIGV4YWN0IGNvbW1pdCBhYm92ZVwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoVFdFQUtfU1RPUkVfUkVWSUVXX0lTU1VFX1VSTCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwidGVtcGxhdGVcIiwgXCJ0d2Vhay1zdG9yZS1yZXZpZXcubWRcIik7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwidGl0bGVcIiwgdGl0bGUpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldChcImJvZHlcIiwgYm9keSk7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRnVsbENvbW1pdFNoYSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBGVUxMX1NIQV9SRS50ZXN0KHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVwb1BhcnQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG8gPSB2YWx1ZS50cmltKCkucmVwbGFjZSgvXFwuZ2l0JC9pLCBcIlwiKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCBcIlwiKTtcbiAgaWYgKCFHSVRIVUJfUkVQT19SRS50ZXN0KHJlcG8pKSB0aHJvdyBuZXcgRXJyb3IoXCJHaXRIdWIgcmVwbyBtdXN0IGJlIGluIG93bmVyL3JlcG8gZm9ybVwiKTtcbiAgcmV0dXJuIHJlcG87XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlUGxhdGZvcm1zKGlucHV0OiB1bmtub3duKTogVHdlYWtTdG9yZVBsYXRmb3JtW10gfCB1bmRlZmluZWQge1xuICBpZiAoaW5wdXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0KSkgdGhyb3cgbmV3IEVycm9yKFwiU3RvcmUgZW50cnkgcGxhdGZvcm1zIG11c3QgYmUgYW4gYXJyYXlcIik7XG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PFR3ZWFrU3RvcmVQbGF0Zm9ybT4oW1wiZGFyd2luXCIsIFwid2luMzJcIiwgXCJsaW51eFwiXSk7XG4gIGNvbnN0IHBsYXRmb3JtcyA9IEFycmF5LmZyb20obmV3IFNldChpbnB1dC5tYXAoKHZhbHVlKSA9PiB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhYWxsb3dlZC5oYXModmFsdWUgYXMgVHdlYWtTdG9yZVBsYXRmb3JtKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBzdG9yZSBwbGF0Zm9ybTogJHtTdHJpbmcodmFsdWUpfWApO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWUgYXMgVHdlYWtTdG9yZVBsYXRmb3JtO1xuICB9KSkpO1xuICByZXR1cm4gcGxhdGZvcm1zLmxlbmd0aCA+IDAgPyBwbGF0Zm9ybXMgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIG9wdGlvbmFsR2l0aHViVXJsKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhdmFsdWUudHJpbSgpKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHZhbHVlKTtcbiAgaWYgKHVybC5wcm90b2NvbCAhPT0gXCJodHRwczpcIiB8fCB1cmwuaG9zdG5hbWUgIT09IFwiZ2l0aHViLmNvbVwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc05hdmlnYXRpb25Ud2VhayB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgaWNvblVybD86IHN0cmluZztcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIGhlYWx0aEVycm9yPzogc3RyaW5nIHwgbnVsbDtcbiAgbGlmZWN5Y2xlT3ZlcnJpZGU/OiBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIGljb25Tdmc/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZSA9XG4gIHwgXCJlbmFibGVkXCJcbiAgfCBcImZhaWxlZFwiXG4gIHwgXCJxdWFyYW50aW5lZFwiXG4gIHwgXCJzdGFydGluZ1wiXG4gIHwgXCJ0aW1lZF9vdXRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc05hdmlnYXRpb25JdGVtIHtcbiAgdHdlYWtJZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIGljb25Vcmw/OiBzdHJpbmc7XG4gIGljb25Tdmc/OiBzdHJpbmc7XG4gIHJlZ2lzdHJhdGlvbklkczogc3RyaW5nW107XG4gIGZhbGxiYWNrOiBib29sZWFuO1xuICBsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZTtcbiAgd2FybmluZzogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2V0dGluZ3NOYXZpZ2F0aW9uTW9kZWwoXG4gIHR3ZWFrczogU2V0dGluZ3NOYXZpZ2F0aW9uVHdlYWtbXSxcbiAgcmVnaXN0cmF0aW9uczogU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeVtdLFxuKTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtdIHtcbiAgY29uc3QgcmVnaXN0cmF0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeVtdPigpO1xuICBmb3IgKGNvbnN0IHJlZ2lzdHJhdGlvbiBvZiByZWdpc3RyYXRpb25zKSB7XG4gICAgY29uc3QgZ3JvdXAgPSByZWdpc3RyYXRpb25zQnlUd2Vhay5nZXQocmVnaXN0cmF0aW9uLnR3ZWFrSWQpID8/IFtdO1xuICAgIGdyb3VwLnB1c2gocmVnaXN0cmF0aW9uKTtcbiAgICByZWdpc3RyYXRpb25zQnlUd2Vhay5zZXQocmVnaXN0cmF0aW9uLnR3ZWFrSWQsIGdyb3VwKTtcbiAgfVxuXG4gIGNvbnN0IHJvd3M6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdHdlYWsgb2YgdHdlYWtzKSB7XG4gICAgaWYgKCF0d2Vhay5lbmFibGVkIHx8IHNlZW4uaGFzKHR3ZWFrLmlkKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQodHdlYWsuaWQpO1xuICAgIGNvbnN0IHBhZ2VzID0gcmVnaXN0cmF0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrLmlkKSA/PyBbXTtcbiAgICBjb25zdCBwcmltYXJ5ID0gcGFnZXNbMF07XG4gICAgcm93cy5wdXNoKHtcbiAgICAgIHR3ZWFrSWQ6IHR3ZWFrLmlkLFxuICAgICAgdGl0bGU6IHByaW1hcnk/LnRpdGxlIHx8IHR3ZWFrLm5hbWUsXG4gICAgICB2ZXJzaW9uOiB0d2Vhay52ZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IHByaW1hcnk/LmRlc2NyaXB0aW9uIHx8IHR3ZWFrLmRlc2NyaXB0aW9uIHx8IFwiRW5hYmxlZCBUd2Vha2VyLlwiLFxuICAgICAgaWNvblVybDogdHdlYWsuaWNvblVybCxcbiAgICAgIGljb25Tdmc6IHByaW1hcnk/Lmljb25TdmcsXG4gICAgICByZWdpc3RyYXRpb25JZHM6IHBhZ2VzLm1hcCgocGFnZSkgPT4gcGFnZS5pZCksXG4gICAgICBmYWxsYmFjazogcGFnZXMubGVuZ3RoID09PSAwLFxuICAgICAgbGlmZWN5Y2xlOiBsaWZlY3ljbGVGb3IodHdlYWspLFxuICAgICAgd2FybmluZzogdHdlYWsuaGVhbHRoRXJyb3IgfHwgbnVsbCxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcm93cy5zb3J0KChhLCBiKSA9PiBhLnRpdGxlLmxvY2FsZUNvbXBhcmUoYi50aXRsZSkgfHwgYS50d2Vha0lkLmxvY2FsZUNvbXBhcmUoYi50d2Vha0lkKSk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUZvcih0d2VhazogU2V0dGluZ3NOYXZpZ2F0aW9uVHdlYWspOiBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGUge1xuICBpZiAodHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGUpIHJldHVybiB0d2Vhay5saWZlY3ljbGVPdmVycmlkZTtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZmFpbGVkXCI7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikgcmV0dXJuIFwicXVhcmFudGluZWRcIjtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJzdGFydGluZ1wiKSByZXR1cm4gXCJzdGFydGluZ1wiO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcInRpbWVkX291dFwiKSByZXR1cm4gXCJ0aW1lZF9vdXRcIjtcbiAgcmV0dXJuIFwiZW5hYmxlZFwiO1xufVxuIiwgImltcG9ydCB0eXBlIHsgVHdlYWtNYW5pZmVzdCB9IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB0eXBlIHsgVHdlYWtTdGF0dXMgfSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcblxuZXhwb3J0IHR5cGUgVHdlYWtzUGFnZUZpbHRlciA9IFwiYWxsXCIgfCBcImVuYWJsZWRcIiB8IFwiZGlzYWJsZWRcIiB8IFwidXBkYXRlc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrc1BhZ2VJdGVtIHtcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgdXBkYXRlOiB7IHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbiB9IHwgbnVsbDtcbn1cblxuZXhwb3J0IHR5cGUgVHdlYWtzUGFnZUNvdW50cyA9IFJlY29yZDxUd2Vha3NQYWdlRmlsdGVyLCBudW1iZXI+O1xuXG5leHBvcnQgY29uc3QgVFdFQUtTX1BBR0VfRklMVEVSUzogcmVhZG9ubHkgVHdlYWtzUGFnZUZpbHRlcltdID0gW1xuICBcImFsbFwiLFxuICBcImVuYWJsZWRcIixcbiAgXCJkaXNhYmxlZFwiLFxuICBcInVwZGF0ZXNcIixcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiB0d2Vha3NQYWdlQ291bnRzKGl0ZW1zOiByZWFkb25seSBUd2Vha3NQYWdlSXRlbVtdKTogVHdlYWtzUGFnZUNvdW50cyB7XG4gIHJldHVybiB7XG4gICAgYWxsOiBpdGVtcy5sZW5ndGgsXG4gICAgZW5hYmxlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcImVuYWJsZWRcIikpLmxlbmd0aCxcbiAgICBkaXNhYmxlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcImRpc2FibGVkXCIpKS5sZW5ndGgsXG4gICAgdXBkYXRlczogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcInVwZGF0ZXNcIikpLmxlbmd0aCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlclR3ZWFrc1BhZ2VJdGVtczxUIGV4dGVuZHMgVHdlYWtzUGFnZUl0ZW0+KFxuICBpdGVtczogcmVhZG9ubHkgVFtdLFxuICBmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIsXG4gIHF1ZXJ5OiBzdHJpbmcsXG4pOiBUW10ge1xuICBjb25zdCBub3JtYWxpemVkUXVlcnkgPSBub3JtYWxpemVUd2Vha3NQYWdlU2VhcmNoKHF1ZXJ5KTtcbiAgcmV0dXJuIGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4ge1xuICAgIGlmICghbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgZmlsdGVyKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghbm9ybWFsaXplZFF1ZXJ5KSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gdHdlYWtzUGFnZVNlYXJjaFRleHQoaXRlbSkuaW5jbHVkZXMobm9ybWFsaXplZFF1ZXJ5KTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihcbiAgaXRlbTogVHdlYWtzUGFnZUl0ZW0sXG4gIGZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcixcbik6IGJvb2xlYW4ge1xuICBpZiAoZmlsdGVyID09PSBcImVuYWJsZWRcIikgcmV0dXJuIGl0ZW0uaW5zdGFsbGVkICYmIGl0ZW0uZW5hYmxlZDtcbiAgaWYgKGZpbHRlciA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gaXRlbS5pbnN0YWxsZWQgJiYgIWl0ZW0uZW5hYmxlZDtcbiAgaWYgKGZpbHRlciA9PT0gXCJ1cGRhdGVzXCIpIHJldHVybiBpdGVtLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlID09PSB0cnVlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHR3ZWFrc1BhZ2VTZWFyY2hUZXh0KGl0ZW06IFR3ZWFrc1BhZ2VJdGVtKTogc3RyaW5nIHtcbiAgY29uc3QgYXV0aG9yID0gdHlwZW9mIGl0ZW0ubWFuaWZlc3QuYXV0aG9yID09PSBcInN0cmluZ1wiXG4gICAgPyBpdGVtLm1hbmlmZXN0LmF1dGhvclxuICAgIDogaXRlbS5tYW5pZmVzdC5hdXRob3I/Lm5hbWU7XG4gIHJldHVybiBub3JtYWxpemVUd2Vha3NQYWdlU2VhcmNoKFtcbiAgICBpdGVtLm1hbmlmZXN0Lm5hbWUsXG4gICAgaXRlbS5tYW5pZmVzdC5kZXNjcmlwdGlvbixcbiAgICBhdXRob3IsXG4gICAgaXRlbS5tYW5pZmVzdC5naXRodWJSZXBvLFxuICAgIGl0ZW0ubWFuaWZlc3QuaG9tZXBhZ2UsXG4gICAgaXRlbS5tYW5pZmVzdC52ZXJzaW9uLFxuICAgIC4uLihpdGVtLm1hbmlmZXN0LnRhZ3MgPz8gW10pLFxuICAgIGl0ZW0uc3RhdHVzLFxuICAgIGl0ZW0uZW5hYmxlZCA/IFwiZW5hYmxlZFwiIDogXCJkaXNhYmxlZFwiLFxuICAgIGl0ZW0udXBkYXRlPy51cGRhdGVBdmFpbGFibGUgPyBcInVwZGF0ZSBhdmFpbGFibGVcIiA6IFwiXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlXG4gICAgLnRvTG9jYWxlTG93ZXJDYXNlKClcbiAgICAubm9ybWFsaXplKFwiTkZEXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csIFwiXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUyMDE4XFx1MjAxOWBcXHUwMGI0XS9nLCBcIidcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xufVxuIiwgImV4cG9ydCB0eXBlIEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSA9IFwiY2hhdGdwdFwiIHwgXCJ0d2Vha2Vyc1wiO1xuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSA9IFwic3RhYmxlXCIgfCBcImFscGhhXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyIHtcbiAgYXBwRXhwZXJpZW5jZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlO1xuICByZWxlYXNlUHJvZmlsZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZTtcbn1cblxuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbiA9IFwiY29uZmlybVwiIHwgXCJjYW5jZWxcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ0VmZmVjdHM8UmVjZWlwdD4ge1xuICBwcmVwYXJlKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogUHJvbWlzZTxSZWNlaXB0PjtcbiAgY29uZmlybShzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpciwgcmVjZWlwdDogUmVjZWlwdCk6IFByb21pc2U8RW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbj47XG4gIGNvbW1pdChyZWNlaXB0OiBSZWNlaXB0KTogUHJvbWlzZTx2b2lkPjtcbiAgY2FuY2VsKHJlY2VpcHQ6IFJlY2VpcHQpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudENvbmZpZ1BoYXNlID1cbiAgfCBcImlkbGVcIlxuICB8IFwicHJlcGFyaW5nXCJcbiAgfCBcImF3YWl0aW5nLWNvbmZpcm1hdGlvblwiXG4gIHwgXCJjb21taXR0aW5nXCJcbiAgfCBcImNhbmNlbGxpbmdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90IHtcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcjtcbiAgcGVuZGluZzogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyO1xuICBoYXNQZW5kaW5nQ2hhbmdlczogYm9vbGVhbjtcbiAgYnVzeTogYm9vbGVhbjtcbiAgcGhhc2U6IEVudmlyb25tZW50Q29uZmlnUGhhc2U7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0PiA9XG4gIHwgeyBvdXRjb21lOiBcIm5vLWNoYW5nZVwiIHwgXCJidXN5XCIgfVxuICB8IHsgb3V0Y29tZTogXCJzdWJtaXR0ZWRcIiB8IFwiY2FuY2VsbGVkXCI7IHJlY2VpcHQ6IFJlY2VpcHQgfVxuICB8IHsgb3V0Y29tZTogXCJwcmVwYXJlLWZhaWxlZFwiOyBlcnJvcjogc3RyaW5nIH1cbiAgfCB7IG91dGNvbWU6IFwiY29uZmlybWF0aW9uLWZhaWxlZFwiIHwgXCJjb21taXQtZmFpbGVkXCIgfCBcImNhbmNlbC1mYWlsZWRcIjsgcmVjZWlwdDogUmVjZWlwdDsgZXJyb3I6IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxSZWNlaXB0PiB7XG4gIHJlYWRvbmx5IHNuYXBzaG90OiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90O1xuICBzZXRTZWxlY3RlZChzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IHZvaWQ7XG4gIHJlc3RvcmVQZW5kaW5nKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogdm9pZDtcbiAgc3RhZ2VBcHBFeHBlcmllbmNlKHZhbHVlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UpOiB2b2lkO1xuICBzdGFnZVJlbGVhc2VQcm9maWxlKHZhbHVlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlKTogdm9pZDtcbiAgY2xlYXJFcnJvcigpOiB2b2lkO1xuICBhcHBseUFuZFJlc3RhcnQoKTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj47XG4gIHJlc3VtZVByZXBhcmVkKFxuICAgIHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLFxuICAgIHJlY2VpcHQ6IFJlY2VpcHQsXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlck9wdGlvbnMge1xuICBvbkNoYW5nZT86IChzbmFwc2hvdDogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxSZWNlaXB0PihcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcixcbiAgZWZmZWN0czogRW52aXJvbm1lbnRDb25maWdFZmZlY3RzPFJlY2VpcHQ+LFxuICBvcHRpb25zOiBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXJPcHRpb25zID0ge30sXG4pOiBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXI8UmVjZWlwdD4ge1xuICBsZXQgc2VsZWN0ZWRWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWQpO1xuICBsZXQgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3RlZCk7XG4gIGxldCBidXN5ID0gZmFsc2U7XG4gIGxldCBwaGFzZTogRW52aXJvbm1lbnRDb25maWdQaGFzZSA9IFwiaWRsZVwiO1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IHJlYWRTbmFwc2hvdCA9ICgpOiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90ID0+ICh7XG4gICAgc2VsZWN0ZWQ6IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSksXG4gICAgcGVuZGluZzogY29weVNlbGVjdGlvbihwZW5kaW5nVmFsdWUpLFxuICAgIGhhc1BlbmRpbmdDaGFuZ2VzOiAhc2FtZVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlLCBwZW5kaW5nVmFsdWUpLFxuICAgIGJ1c3ksXG4gICAgcGhhc2UsXG4gICAgZXJyb3IsXG4gIH0pO1xuICBjb25zdCBwdWJsaXNoID0gKCk6IHZvaWQgPT4gb3B0aW9ucy5vbkNoYW5nZT8uKHJlYWRTbmFwc2hvdCgpKTtcbiAgY29uc3QgZmluaXNoV2l0aEVycm9yID0gKG5leHRQaGFzZTogRW52aXJvbm1lbnRDb25maWdQaGFzZSwgbmV4dEVycm9yOiB1bmtub3duKTogc3RyaW5nID0+IHtcbiAgICBlcnJvciA9IGVudmlyb25tZW50Q29uZmlnRXJyb3IobmV4dEVycm9yKTtcbiAgICBidXN5ID0gZmFsc2U7XG4gICAgcGhhc2UgPSBuZXh0UGhhc2U7XG4gICAgcHVibGlzaCgpO1xuICAgIHJldHVybiBlcnJvcjtcbiAgfTtcblxuICBjb25zdCBjb21wbGV0ZVByZXBhcmVkID0gYXN5bmMgKFxuICAgIHJlcXVlc3RlZDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLFxuICAgIHJlY2VpcHQ6IFJlY2VpcHQsXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+ID0+IHtcbiAgICBwaGFzZSA9IFwiYXdhaXRpbmctY29uZmlybWF0aW9uXCI7XG4gICAgcHVibGlzaCgpO1xuICAgIGxldCBkZWNpc2lvbjogRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbjtcbiAgICB0cnkge1xuICAgICAgZGVjaXNpb24gPSBhd2FpdCBlZmZlY3RzLmNvbmZpcm0oY29weVNlbGVjdGlvbihyZXF1ZXN0ZWQpLCByZWNlaXB0KTtcbiAgICB9IGNhdGNoIChjb25maXJtYXRpb25FcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb3V0Y29tZTogXCJjb25maXJtYXRpb24tZmFpbGVkXCIsXG4gICAgICAgIHJlY2VpcHQsXG4gICAgICAgIGVycm9yOiBmaW5pc2hXaXRoRXJyb3IoXCJpZGxlXCIsIGNvbmZpcm1hdGlvbkVycm9yKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKGRlY2lzaW9uID09PSBcImNhbmNlbFwiKSB7XG4gICAgICBwaGFzZSA9IFwiY2FuY2VsbGluZ1wiO1xuICAgICAgcHVibGlzaCgpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZWZmZWN0cy5jYW5jZWwocmVjZWlwdCk7XG4gICAgICB9IGNhdGNoIChjYW5jZWxFcnJvcikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG91dGNvbWU6IFwiY2FuY2VsLWZhaWxlZFwiLFxuICAgICAgICAgIHJlY2VpcHQsXG4gICAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgY2FuY2VsRXJyb3IpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlKTtcbiAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgIHBoYXNlID0gXCJpZGxlXCI7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgICByZXR1cm4geyBvdXRjb21lOiBcImNhbmNlbGxlZFwiLCByZWNlaXB0IH07XG4gICAgfVxuXG4gICAgcGhhc2UgPSBcImNvbW1pdHRpbmdcIjtcbiAgICBwdWJsaXNoKCk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGVmZmVjdHMuY29tbWl0KHJlY2VpcHQpO1xuICAgIH0gY2F0Y2ggKGNvbW1pdEVycm9yKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvdXRjb21lOiBcImNvbW1pdC1mYWlsZWRcIixcbiAgICAgICAgcmVjZWlwdCxcbiAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgY29tbWl0RXJyb3IpLFxuICAgICAgfTtcbiAgICB9XG4gICAgYnVzeSA9IGZhbHNlO1xuICAgIHBoYXNlID0gXCJpZGxlXCI7XG4gICAgZXJyb3IgPSBudWxsO1xuICAgIHB1Ymxpc2goKTtcbiAgICByZXR1cm4geyBvdXRjb21lOiBcInN1Ym1pdHRlZFwiLCByZWNlaXB0IH07XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBnZXQgc25hcHNob3QoKTogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCB7XG4gICAgICByZXR1cm4gcmVhZFNuYXBzaG90KCk7XG4gICAgfSxcbiAgICBzZXRTZWxlY3RlZChzZWxlY3Rpb24pOiB2b2lkIHtcbiAgICAgIGNvbnN0IHBlbmRpbmdXYXNVbmNoYW5nZWQgPSBzYW1lU2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUsIHBlbmRpbmdWYWx1ZSk7XG4gICAgICBzZWxlY3RlZFZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgLy8gQSBzdGF0dXMgcmVmcmVzaCBtYXkgcmVzb2x2ZSBhZnRlciB0aGUgdXNlciBoYXMgc3RhZ2VkIG9uZSBoYWxmIG9mIHRoZVxuICAgICAgLy8gRW52aXJvbm1lbnQgcGFpci4gUmVmcmVzaCB0aGUgYXV0aG9yaXRhdGl2ZSBzZWxlY3Rpb24gd2l0aG91dCBlcmFzaW5nXG4gICAgICAvLyB0aGF0IG5ld2VyIGxvY2FsIGludGVudDsgb25seSBmb2xsb3cgdGhlIHNlbGVjdGVkIHZhbHVlIHdoaWxlIHRoZSBmb3JtXG4gICAgICAvLyBpdHNlbGYgaXMgc3RpbGwgcHJpc3RpbmUuXG4gICAgICBpZiAocGVuZGluZ1dhc1VuY2hhbmdlZCkgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgcmVzdG9yZVBlbmRpbmcoc2VsZWN0aW9uKTogdm9pZCB7XG4gICAgICBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbik7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBzdGFnZUFwcEV4cGVyaWVuY2UodmFsdWUpOiB2b2lkIHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBwZW5kaW5nVmFsdWUgPSB7IC4uLnBlbmRpbmdWYWx1ZSwgYXBwRXhwZXJpZW5jZTogdmFsdWUgfTtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIHN0YWdlUmVsZWFzZVByb2ZpbGUodmFsdWUpOiB2b2lkIHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBwZW5kaW5nVmFsdWUgPSB7IC4uLnBlbmRpbmdWYWx1ZSwgcmVsZWFzZVByb2ZpbGU6IHZhbHVlIH07XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBjbGVhckVycm9yKCk6IHZvaWQge1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgYXN5bmMgYXBwbHlBbmRSZXN0YXJ0KCk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm4geyBvdXRjb21lOiBcImJ1c3lcIiB9O1xuICAgICAgaWYgKHNhbWVTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSwgcGVuZGluZ1ZhbHVlKSkgcmV0dXJuIHsgb3V0Y29tZTogXCJuby1jaGFuZ2VcIiB9O1xuICAgICAgY29uc3QgcmVxdWVzdGVkID0gY29weVNlbGVjdGlvbihwZW5kaW5nVmFsdWUpO1xuICAgICAgYnVzeSA9IHRydWU7XG4gICAgICBwaGFzZSA9IFwicHJlcGFyaW5nXCI7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgICBsZXQgcmVjZWlwdDogUmVjZWlwdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlY2VpcHQgPSBhd2FpdCBlZmZlY3RzLnByZXBhcmUoY29weVNlbGVjdGlvbihyZXF1ZXN0ZWQpKTtcbiAgICAgIH0gY2F0Y2ggKHByZXBhcmVFcnJvcikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG91dGNvbWU6IFwicHJlcGFyZS1mYWlsZWRcIixcbiAgICAgICAgICBlcnJvcjogZmluaXNoV2l0aEVycm9yKFwiaWRsZVwiLCBwcmVwYXJlRXJyb3IpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGNvbXBsZXRlUHJlcGFyZWQocmVxdWVzdGVkLCByZWNlaXB0KTtcbiAgICB9LFxuICAgIGFzeW5jIHJlc3VtZVByZXBhcmVkKHNlbGVjdGlvbiwgcmVjZWlwdCk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm4geyBvdXRjb21lOiBcImJ1c3lcIiB9O1xuICAgICAgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgYnVzeSA9IHRydWU7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICByZXR1cm4gY29tcGxldGVQcmVwYXJlZChjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbiksIHJlY2VpcHQpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIge1xuICByZXR1cm4ge1xuICAgIGFwcEV4cGVyaWVuY2U6IHNlbGVjdGlvbi5hcHBFeHBlcmllbmNlLFxuICAgIHJlbGVhc2VQcm9maWxlOiBzZWxlY3Rpb24ucmVsZWFzZVByb2ZpbGUsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNhbWVTZWxlY3Rpb24obGVmdDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLCByaWdodDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWZ0LmFwcEV4cGVyaWVuY2UgPT09IHJpZ2h0LmFwcEV4cGVyaWVuY2VcbiAgICAmJiBsZWZ0LnJlbGVhc2VQcm9maWxlID09PSByaWdodC5yZWxlYXNlUHJvZmlsZTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRDb25maWdFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciB8fCBcIlVua25vd24gZXJyb3JcIik7XG59XG5cbmV4cG9ydCB0eXBlIERlc2t0b3BVcGRhdGVTdGF0dXMgPVxuICB8IFwidXBkYXRlLWF2YWlsYWJsZVwiXG4gIHwgXCJjdXJyZW50XCJcbiAgfCBcInN0YWxlXCJcbiAgfCBcInVuYXZhaWxhYmxlXCJcbiAgfCBcImVycm9yXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wVXBkYXRlU3RhdHVzUHJlc2VudGF0aW9uKFxuICBzdGF0dXM6IERlc2t0b3BVcGRhdGVTdGF0dXMgfCB1bmRlZmluZWQsXG4pOiB7IGxhYmVsOiBzdHJpbmc7IHRvbmU6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiIH0ge1xuICBzd2l0Y2ggKHN0YXR1cykge1xuICAgIGNhc2UgXCJjdXJyZW50XCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJVcCB0byBkYXRlXCIsIHRvbmU6IFwib2tcIiB9O1xuICAgIGNhc2UgXCJ1cGRhdGUtYXZhaWxhYmxlXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJVcGRhdGUgYXZhaWxhYmxlXCIsIHRvbmU6IFwid2FyblwiIH07XG4gICAgY2FzZSBcImVycm9yXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJFcnJvclwiLCB0b25lOiBcImVycm9yXCIgfTtcbiAgICBjYXNlIFwic3RhbGVcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlN0YWxlXCIsIHRvbmU6IFwid2FyblwiIH07XG4gICAgY2FzZSBcInVuYXZhaWxhYmxlXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJVbmF2YWlsYWJsZVwiLCB0b25lOiBcIndhcm5cIiB9O1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJOb3QgY2hlY2tlZFwiLCB0b25lOiBcIndhcm5cIiB9O1xuICB9XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRGb2N1c1RhcmdldCB7XG4gIHJlYWRvbmx5IGlzQ29ubmVjdGVkOiBib29sZWFuO1xuICBmb2N1cygpOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVzdG9yZUVudmlyb25tZW50Rm9jdXMoXG4gIG9wZW5lcjogRW52aXJvbm1lbnRGb2N1c1RhcmdldCB8IG51bGwsXG4gIGZhbGxiYWNrOiAoKSA9PiBFbnZpcm9ubWVudEZvY3VzVGFyZ2V0IHwgbnVsbCxcbik6IFwib3BlbmVyXCIgfCBcImZhbGxiYWNrXCIgfCBcIm5vbmVcIiB7XG4gIGlmIChvcGVuZXI/LmlzQ29ubmVjdGVkKSB7XG4gICAgb3BlbmVyLmZvY3VzKCk7XG4gICAgcmV0dXJuIFwib3BlbmVyXCI7XG4gIH1cbiAgY29uc3QgdGFyZ2V0ID0gZmFsbGJhY2soKTtcbiAgaWYgKHRhcmdldD8uaXNDb25uZWN0ZWQpIHtcbiAgICB0YXJnZXQuZm9jdXMoKTtcbiAgICByZXR1cm4gXCJmYWxsYmFja1wiO1xuICB9XG4gIHJldHVybiBcIm5vbmVcIjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb25maWdDYXJkVXBkYXRlVG9rZW4ge1xuICByZWFkb25seSBjYXJkOiBzdHJpbmc7XG4gIHJlYWRvbmx5IGdlbmVyYXRpb246IG51bWJlcjtcbn1cblxuLyoqXG4gKiBLZWVwcyBhc3luY2hyb25vdXMgQ29uZmlnIGNhcmRzIGluZGVwZW5kZW50IHdoaWxlIHJlamVjdGluZyBhIHN0YWxlIHJlc3VsdFxuICogZnJvbSBhbiBvbGRlciByZXF1ZXN0IGZvciB0aGUgc2FtZSBjYXJkLlxuICovXG5leHBvcnQgY2xhc3MgQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPFZhbHVlPiB7XG4gIHJlYWRvbmx5ICNnZW5lcmF0aW9ucyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIHJlYWRvbmx5ICN2YWx1ZXMgPSBuZXcgTWFwPHN0cmluZywgVmFsdWU+KCk7XG5cbiAgYmVnaW4oY2FyZDogc3RyaW5nKTogQ29uZmlnQ2FyZFVwZGF0ZVRva2VuIHtcbiAgICBjb25zdCBnZW5lcmF0aW9uID0gKHRoaXMuI2dlbmVyYXRpb25zLmdldChjYXJkKSA/PyAwKSArIDE7XG4gICAgdGhpcy4jZ2VuZXJhdGlvbnMuc2V0KGNhcmQsIGdlbmVyYXRpb24pO1xuICAgIHJldHVybiBPYmplY3QuZnJlZXplKHsgY2FyZCwgZ2VuZXJhdGlvbiB9KTtcbiAgfVxuXG4gIGNvbXBsZXRlKHRva2VuOiBDb25maWdDYXJkVXBkYXRlVG9rZW4sIHZhbHVlOiBWYWx1ZSk6IGJvb2xlYW4ge1xuICAgIGlmICghdGhpcy5pc0N1cnJlbnQodG9rZW4pKSByZXR1cm4gZmFsc2U7XG4gICAgdGhpcy4jdmFsdWVzLnNldCh0b2tlbi5jYXJkLCB2YWx1ZSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBpc0N1cnJlbnQodG9rZW46IENvbmZpZ0NhcmRVcGRhdGVUb2tlbik6IGJvb2xlYW4ge1xuICAgIHJldHVybiB0aGlzLiNnZW5lcmF0aW9ucy5nZXQodG9rZW4uY2FyZCkgPT09IHRva2VuLmdlbmVyYXRpb247XG4gIH1cblxuICBpbnZhbGlkYXRlKGNhcmQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMuI2dlbmVyYXRpb25zLnNldChjYXJkLCAodGhpcy4jZ2VuZXJhdGlvbnMuZ2V0KGNhcmQpID8/IDApICsgMSk7XG4gIH1cblxuICB2YWx1ZShjYXJkOiBzdHJpbmcpOiBWYWx1ZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuI3ZhbHVlcy5nZXQoY2FyZCk7XG4gIH1cblxuICBzbmFwc2hvdCgpOiBSZWNvcmQ8c3RyaW5nLCBWYWx1ZT4ge1xuICAgIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXModGhpcy4jdmFsdWVzKTtcbiAgfVxufVxuIiwgIi8qKlxuICogUmVuZGVyZXItc2lkZSB0d2VhayBob3N0LiBXZTpcbiAqICAgMS4gQXNrIG1haW4gZm9yIHRoZSB0d2VhayBsaXN0ICh3aXRoIHJlc29sdmVkIGVudHJ5IHBhdGgpLlxuICogICAyLiBGb3IgZWFjaCByZW5kZXJlci1zY29wZWQgKG9yIFwiYm90aFwiKSB0d2VhaywgZmV0Y2ggaXRzIHNvdXJjZSB2aWEgSVBDXG4gKiAgICAgIGFuZCBleGVjdXRlIGl0IGFzIGEgQ29tbW9uSlMtc2hhcGVkIGZ1bmN0aW9uLlxuICogICAzLiBQcm92aWRlIGl0IHRoZSByZW5kZXJlciBoYWxmIG9mIHRoZSBBUEkuXG4gKlxuICogQ29kZXggcnVucyB0aGUgcmVuZGVyZXIgd2l0aCBzYW5kYm94OiB0cnVlLCBzbyBOb2RlJ3MgYHJlcXVpcmUoKWAgaXNcbiAqIHJlc3RyaWN0ZWQgdG8gYSB0aW55IHdoaXRlbGlzdCAoZWxlY3Ryb24gKyBhIGZldyBwb2x5ZmlsbHMpLiBUaGF0IG1lYW5zIHdlXG4gKiBjYW5ub3QgYHJlcXVpcmUoKWAgYXJiaXRyYXJ5IHR3ZWFrIGZpbGVzIGZyb20gZGlzay4gSW5zdGVhZCB3ZSBwdWxsIHRoZVxuICogc291cmNlIHN0cmluZyBmcm9tIG1haW4gYW5kIGV2YWx1YXRlIGl0IHdpdGggYG5ldyBGdW5jdGlvbmAgaW5zaWRlIHRoZVxuICogcHJlbG9hZCBjb250ZXh0LiBUd2VhayBhdXRob3JzIHdobyBuZWVkIG5wbSBkZXBzIG11c3QgYnVuZGxlIHRoZW0gaW4uXG4gKi9cblxuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiwgcmVnaXN0ZXJQYWdlLCBjbGVhclNlY3Rpb25zLCBzZXRMaXN0ZWRUd2Vha3MsIHVwZGF0ZUxpc3RlZFR3ZWFrTGlmZWN5Y2xlIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcbmltcG9ydCB7IGZpYmVyRm9yTm9kZSB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB7IGhvc3RVaUFwaSB9IGZyb20gXCIuL2hvc3Qtc3VyZmFjZXNcIjtcbmltcG9ydCB7IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLCBydW5XaXRoU3RhcnR1cFRpbWVvdXQgfSBmcm9tIFwiLi4vdHdlYWstbGlmZWN5Y2xlXCI7XG5pbXBvcnQgdHlwZSB7IFR3ZWFrSGVhbHRoUmVjb3JkLCBUd2Vha1N0YXR1cywgVHdlYWtTdG9yZUVudHJ5IH0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENvZGV4Q2RwU3RhdHVzLFxuICBDb2RleENkcFRhcmdldCxcbiAgQ29kZXhSdW50aW1lQ2FwYWJpbGl0aWVzLFxuICBDb2RleFJ1bnRpbWVJbmZvLFxuICBDb2RleFZpZXdSZWYsXG4gIENvZGV4V2luZG93UmVmLFxuICBOYXRpdmVIZWxwZXJMYXVuY2hPcHRpb25zLFxuICBOYXRpdmVIZWxwZXJSZWYsXG4gIE5hdGl2ZU1vZHVsZUtpbmQsXG4gIE5hdGl2ZU1vZHVsZUxvYWRPcHRpb25zLFxuICBOYXRpdmVNb2R1bGVSZWYsXG4gIE5hdGl2ZVBhbmVsQ3JlYXRlT3B0aW9ucyxcbiAgTmF0aXZlUGFuZWxSZWYsXG4gIE5hdGl2ZVZpZXdBdHRhY2hPcHRpb25zLFxuICBOYXRpdmVWaWV3UmVmLFxuICBUd2Vha01hbmlmZXN0LFxuICBUd2Vha0FwaSxcbiAgUmVhY3RGaWJlck5vZGUsXG4gIFR3ZWFrLFxufSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5pbXBvcnQgeyBjcmVhdGVSZW5kZXJlclN0b3JhZ2UgfSBmcm9tIFwiLi4vcmVuZGVyZXItc3RvcmFnZVwiO1xuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIGhlYWx0aDogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xuICBjYXRhbG9nOiBUd2Vha1N0b3JlRW50cnkgfCBudWxsO1xuICB1cGRhdGU6IHtcbiAgICBjaGVja2VkQXQ6IHN0cmluZztcbiAgICByZXBvOiBzdHJpbmc7XG4gICAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICAgIGxhdGVzdFRhZzogc3RyaW5nIHwgbnVsbDtcbiAgICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICAgIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfSB8IG51bGw7XG59XG5cbmludGVyZmFjZSBVc2VyUGF0aHMge1xuICB1c2VyUm9vdDogc3RyaW5nO1xuICBydW50aW1lRGlyOiBzdHJpbmc7XG4gIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICBsb2dEaXI6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEVsZWN0cm9uQnJpZGdlIHtcbiAgZ2V0QnVpbGRGbGF2b3I/OiAoKSA9PiBzdHJpbmcgfCBudWxsO1xuICB1c2VzT3dsQXBwU2hlbGw/OiAoKSA9PiBib29sZWFuO1xufVxuXG5jb25zdCBsb2FkZWQgPSBuZXcgTWFwPHN0cmluZywgeyBzdG9wPzogKCkgPT4gdm9pZCB9PigpO1xubGV0IGNhY2hlZFBhdGhzOiBVc2VyUGF0aHMgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHN0YXJ0VHdlYWtIb3N0KCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpsaXN0LXR3ZWFrc1wiKSkgYXMgTGlzdGVkVHdlYWtbXTtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp1c2VyLXBhdGhzXCIpKSBhcyBVc2VyUGF0aHM7XG4gIGNhY2hlZFBhdGhzID0gcGF0aHM7XG4gIC8vIFB1c2ggdGhlIGxpc3QgdG8gdGhlIHNldHRpbmdzIGluamVjdG9yIHNvIHRoZSBUd2Vha3MgcGFnZSBjYW4gcmVuZGVyXG4gIC8vIGNhcmRzIGV2ZW4gYmVmb3JlIGFueSB0d2VhaydzIHN0YXJ0KCkgcnVucyAoYW5kIGZvciBkaXNhYmxlZCB0d2Vha3NcbiAgLy8gdGhhdCB3ZSBuZXZlciBsb2FkKS5cbiAgc2V0TGlzdGVkVHdlYWtzKHR3ZWFrcyk7XG4gIC8vIFN0YXNoIGZvciB0aGUgc2V0dGluZ3MgaW5qZWN0b3IncyBlbXB0eS1zdGF0ZSBtZXNzYWdlLlxuICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX3R3ZWFrZXJfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fdHdlYWtlcl90d2Vha3NfZGlyX18gPVxuICAgIHBhdGhzLnR3ZWFrc0RpcjtcblxuICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgaWYgKHQubWFuaWZlc3Quc2NvcGUgPT09IFwibWFpblwiKSB7XG4gICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwiZGlzYWJsZWRcIiwgXCJtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXQuZW50cnlFeGlzdHMpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJkaXNhYmxlZFwiLCBcIm1pc3NpbmcgZW50cnlcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCF0LmVuYWJsZWQpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgdC5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIiA/IFwicXVhcmFudGluZWRcIiA6IFwiZGlzYWJsZWRcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInN0YXJ0aW5nXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5XaXRoU3RhcnR1cFRpbWVvdXQoXG4gICAgICAgICgpID0+IGxvYWRUd2Vhayh0LCBwYXRocyksXG4gICAgICAgIERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuICAgICAgKTtcbiAgICAgIGlmIChyZXN1bHQuc3RhdHVzID09PSBcInRpbWVkX291dFwiKSB7XG4gICAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJ0aW1lZF9vdXRcIiwgYHN0YXJ0dXAgZXhjZWVkZWQgJHtERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NU31tc2ApO1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW3R3ZWFrZXJdIHR3ZWFrIHN0YXJ0dXAgdGltZWQgb3V0OlwiLCB0Lm1hbmlmZXN0LmlkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJyZWFkeVwiKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwiZmFpbGVkXCIsIGUpO1xuICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSB0d2VhayBsb2FkIGZhaWxlZDpcIiwgdC5tYW5pZmVzdC5pZCwgZSk7XG4gICAgICB0cnkge1xuICAgICAgICBpcGNSZW5kZXJlci5zZW5kKFxuICAgICAgICAgIFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICAgIFwiZXJyb3JcIixcbiAgICAgICAgICBcInR3ZWFrIGxvYWQgZmFpbGVkOiBcIiArIHQubWFuaWZlc3QuaWQgKyBcIjogXCIgKyBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSxcbiAgICAgICAgKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICB9XG4gIH1cblxuICBjb25zb2xlLmluZm8oXG4gICAgYFt0d2Vha2VyXSByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTpgLFxuICAgIFsuLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIixcbiAgKTtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcInR3ZWFrZXI6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6ICR7Wy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwifWAsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHNlbmRMaWZlY3ljbGUoXG4gIGlkOiBzdHJpbmcsXG4gIHN0YXR1czogXCJzdGFydGluZ1wiIHwgXCJyZWFkeVwiIHwgXCJmYWlsZWRcIiB8IFwidGltZWRfb3V0XCIgfCBcImRpc2FibGVkXCIgfCBcInF1YXJhbnRpbmVkXCIsXG4gIGVycm9yPzogdW5rbm93bixcbik6IHZvaWQge1xuICBjb25zdCByZW5kZXJlckxpZmVjeWNsZSA9IHN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiICYmIGVycm9yID09PSBcIm1pc3NpbmcgZW50cnlcIiA/IFwiZmFpbGVkXCJcbiAgICA6IHN0YXR1cyA9PT0gXCJzdGFydGluZ1wiID8gXCJzdGFydGluZ1wiXG4gICAgOiBzdGF0dXMgPT09IFwiZmFpbGVkXCIgPyBcImZhaWxlZFwiXG4gICAgOiBzdGF0dXMgPT09IFwidGltZWRfb3V0XCIgPyBcInRpbWVkX291dFwiXG4gICAgOiBzdGF0dXMgPT09IFwicXVhcmFudGluZWRcIiA/IFwicXVhcmFudGluZWRcIlxuICAgIDogXCJlbmFibGVkXCI7XG4gIHVwZGF0ZUxpc3RlZFR3ZWFrTGlmZWN5Y2xlKGlkLCByZW5kZXJlckxpZmVjeWNsZSwgZXJyb3IgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XG4gIHRyeSB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChcInR3ZWFrZXI6dHdlYWstbGlmZWN5Y2xlXCIsIHtcbiAgICAgIGlkLFxuICAgICAgcHJvY2VzczogXCJyZW5kZXJlclwiLFxuICAgICAgc3RhdHVzLFxuICAgICAgLi4uKGVycm9yID09PSB1bmRlZmluZWQgPyB7fSA6IHsgZXJyb3I6IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSB9KSxcbiAgICB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gTGlmZWN5Y2xlIHRlbGVtZXRyeSBtdXN0IG5ldmVyIHRha2UgZG93biB0aGUgcmVuZGVyZXIgaG9zdC5cbiAgfVxufVxuXG4vKipcbiAqIFN0b3AgZXZlcnkgcmVuZGVyZXItc2NvcGUgdHdlYWsgc28gYSBzdWJzZXF1ZW50IGBzdGFydFR3ZWFrSG9zdCgpYCB3aWxsXG4gKiByZS1ldmFsdWF0ZSBmcmVzaCBzb3VyY2UuIE1vZHVsZSBjYWNoZSBpc24ndCByZWxldmFudCBzaW5jZSB3ZSBldmFsXG4gKiBzb3VyY2Ugc3RyaW5ncyBkaXJlY3RseSBcdTIwMTQgZWFjaCBsb2FkIGNyZWF0ZXMgYSBmcmVzaCBzY29wZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRlYXJkb3duVHdlYWtIb3N0KCk6IHZvaWQge1xuICBmb3IgKGNvbnN0IFtpZCwgdF0gb2YgbG9hZGVkKSB7XG4gICAgdHJ5IHtcbiAgICAgIHQuc3RvcD8uKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS53YXJuKFwiW3R3ZWFrZXJdIHR3ZWFrIHN0b3AgZmFpbGVkOlwiLCBpZCwgZSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWRpc3Bvc2UtdHdlYWtcIiwgaWQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtZGlzcG9zZS10d2Vha1wiLCBpZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH1cbiAgfVxuICBsb2FkZWQuY2xlYXIoKTtcbiAgY2xlYXJTZWN0aW9ucygpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkVHdlYWsodDogTGlzdGVkVHdlYWssIHBhdGhzOiBVc2VyUGF0aHMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc291cmNlID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICBcInR3ZWFrZXI6cmVhZC10d2Vhay1zb3VyY2VcIixcbiAgICB0LmVudHJ5LFxuICApKSBhcyBzdHJpbmc7XG5cbiAgLy8gRXZhbHVhdGUgYXMgQ0pTLXNoYXBlZDogcHJvdmlkZSBtb2R1bGUvZXhwb3J0cy9hcGkuIFR3ZWFrIGNvZGUgbWF5IHVzZVxuICAvLyBgbW9kdWxlLmV4cG9ydHMgPSB7IHN0YXJ0LCBzdG9wIH1gIG9yIGBleHBvcnRzLnN0YXJ0ID0gLi4uYCBvciBwdXJlIEVTTVxuICAvLyBkZWZhdWx0IGV4cG9ydCBzaGFwZSAod2UgYWNjZXB0IGJvdGgpLlxuICBjb25zdCBtb2R1bGUgPSB7IGV4cG9ydHM6IHt9IGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhayB9O1xuICBjb25zdCBleHBvcnRzID0gbW9kdWxlLmV4cG9ydHM7XG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8taW1wbGllZC1ldmFsLCBuby1uZXctZnVuY1xuICBjb25zdCBmbiA9IG5ldyBGdW5jdGlvbihcbiAgICBcIm1vZHVsZVwiLFxuICAgIFwiZXhwb3J0c1wiLFxuICAgIFwiY29uc29sZVwiLFxuICAgIGAke3NvdXJjZX1cXG4vLyMgc291cmNlVVJMPXR3ZWFrZXItdHdlYWs6Ly8ke2VuY29kZVVSSUNvbXBvbmVudCh0Lm1hbmlmZXN0LmlkKX0vJHtlbmNvZGVVUklDb21wb25lbnQodC5lbnRyeSl9YCxcbiAgKTtcbiAgZm4obW9kdWxlLCBleHBvcnRzLCBjb25zb2xlKTtcbiAgY29uc3QgbW9kID0gbW9kdWxlLmV4cG9ydHMgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrO1xuICBjb25zdCB0d2VhazogVHdlYWsgPSAobW9kIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0pLmRlZmF1bHQgPz8gKG1vZCBhcyBUd2Vhayk7XG4gIGlmICh0eXBlb2YgdHdlYWs/LnN0YXJ0ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYHR3ZWFrICR7dC5tYW5pZmVzdC5pZH0gaGFzIG5vIHN0YXJ0KClgKTtcbiAgfVxuICBjb25zdCBhcGkgPSBtYWtlUmVuZGVyZXJBcGkodC5tYW5pZmVzdCwgcGF0aHMpO1xuICBhd2FpdCB0d2Vhay5zdGFydChhcGkpO1xuICBsb2FkZWQuc2V0KHQubWFuaWZlc3QuaWQsIHsgc3RvcDogdHdlYWsuc3RvcD8uYmluZCh0d2VhaykgfSk7XG59XG5cbmZ1bmN0aW9uIG1ha2VSZW5kZXJlckFwaShtYW5pZmVzdDogVHdlYWtNYW5pZmVzdCwgcGF0aHM6IFVzZXJQYXRocyk6IFR3ZWFrQXBpIHtcbiAgY29uc3QgaWQgPSBtYW5pZmVzdC5pZDtcbiAgY29uc3QgbG9nID0gKGxldmVsOiBcImRlYnVnXCIgfCBcImluZm9cIiB8IFwid2FyblwiIHwgXCJlcnJvclwiLCAuLi5hOiB1bmtub3duW10pID0+IHtcbiAgICBjb25zdCBjb25zb2xlRm4gPVxuICAgICAgbGV2ZWwgPT09IFwiZGVidWdcIiA/IGNvbnNvbGUuZGVidWdcbiAgICAgIDogbGV2ZWwgPT09IFwid2FyblwiID8gY29uc29sZS53YXJuXG4gICAgICA6IGxldmVsID09PSBcImVycm9yXCIgPyBjb25zb2xlLmVycm9yXG4gICAgICA6IGNvbnNvbGUubG9nO1xuICAgIGNvbnNvbGVGbihgW3R3ZWFrZXJdWyR7aWR9XWAsIC4uLmEpO1xuICAgIC8vIEFsc28gbWlycm9yIHRvIG1haW4ncyBsb2cgZmlsZSBzbyB3ZSBjYW4gZGlhZ25vc2UgdHdlYWsgYmVoYXZpb3JcbiAgICAvLyB3aXRob3V0IGF0dGFjaGluZyBEZXZUb29scy4gU3RyaW5naWZ5IGVhY2ggYXJnIGRlZmVuc2l2ZWx5LlxuICAgIHRyeSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGEubWFwKCh2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgdiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHY7XG4gICAgICAgIGlmICh2IGluc3RhbmNlb2YgRXJyb3IpIHJldHVybiBgJHt2Lm5hbWV9OiAke3YubWVzc2FnZX1gO1xuICAgICAgICB0cnkgeyByZXR1cm4gSlNPTi5zdHJpbmdpZnkodik7IH0gY2F0Y2ggeyByZXR1cm4gU3RyaW5nKHYpOyB9XG4gICAgICB9KTtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgIFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLFxuICAgICAgICBsZXZlbCxcbiAgICAgICAgYFt0d2VhayAke2lkfV0gJHtwYXJ0cy5qb2luKFwiIFwiKX1gLFxuICAgICAgKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHN3YWxsb3cgXHUyMDE0IG5ldmVyIGxldCBsb2dnaW5nIGJyZWFrIGEgdHdlYWsgKi9cbiAgICB9XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBtYW5pZmVzdCxcbiAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgbG9nOiB7XG4gICAgICBkZWJ1ZzogKC4uLmEpID0+IGxvZyhcImRlYnVnXCIsIC4uLmEpLFxuICAgICAgaW5mbzogKC4uLmEpID0+IGxvZyhcImluZm9cIiwgLi4uYSksXG4gICAgICB3YXJuOiAoLi4uYSkgPT4gbG9nKFwid2FyblwiLCAuLi5hKSxcbiAgICAgIGVycm9yOiAoLi4uYSkgPT4gbG9nKFwiZXJyb3JcIiwgLi4uYSksXG4gICAgfSxcbiAgICBzdG9yYWdlOiByZW5kZXJlclN0b3JhZ2UoaWQpLFxuICAgIHNldHRpbmdzOiB7XG4gICAgICByZWdpc3RlcjogKHMpID0+IHJlZ2lzdGVyU2VjdGlvbih7IC4uLnMsIGlkOiBgJHtpZH06JHtzLmlkfWAgfSksXG4gICAgICByZWdpc3RlclBhZ2U6IChwKSA9PlxuICAgICAgICByZWdpc3RlclBhZ2UoaWQsIG1hbmlmZXN0LCB7IC4uLnAsIGlkOiBgJHtpZH06JHtwLmlkfWAgfSksXG4gICAgfSxcbiAgICByZWFjdDoge1xuICAgICAgZ2V0RmliZXI6IChuKSA9PiBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsLFxuICAgICAgZmluZE93bmVyQnlOYW1lOiAobiwgbmFtZSkgPT4ge1xuICAgICAgICBsZXQgZiA9IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gICAgICAgIHdoaWxlIChmKSB7XG4gICAgICAgICAgY29uc3QgdCA9IGYudHlwZSBhcyB7IGRpc3BsYXlOYW1lPzogc3RyaW5nOyBuYW1lPzogc3RyaW5nIH0gfCBudWxsO1xuICAgICAgICAgIGlmICh0ICYmICh0LmRpc3BsYXlOYW1lID09PSBuYW1lIHx8IHQubmFtZSA9PT0gbmFtZSkpIHJldHVybiBmO1xuICAgICAgICAgIGYgPSBmLnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICB3YWl0Rm9yRWxlbWVudDogKHNlbCwgdGltZW91dE1zID0gNTAwMCkgPT5cbiAgICAgICAgbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgIGlmIChleGlzdGluZykgcmV0dXJuIHJlc29sdmUoZXhpc3RpbmcpO1xuICAgICAgICAgIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIHRpbWVvdXRNcztcbiAgICAgICAgICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBlbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICAgIGlmIChlbCkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZXNvbHZlKGVsKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoRGF0ZS5ub3coKSA+IGRlYWRsaW5lKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoYHRpbWVvdXQgd2FpdGluZyBmb3IgJHtzZWx9YCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICAgIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gICAgICAgIH0pLFxuICAgICAgaG9zdDogaG9zdFVpQXBpLFxuICAgIH0sXG4gICAgaXBjOiB7XG4gICAgICBvbjogKGMsIGgpID0+IHtcbiAgICAgICAgY29uc3Qgd3JhcHBlZCA9IChfZTogdW5rbm93biwgLi4uYXJnczogdW5rbm93bltdKSA9PiBoKC4uLmFyZ3MpO1xuICAgICAgICBpcGNSZW5kZXJlci5vbihgdHdlYWtlcjoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICAgIHJldHVybiAoKSA9PiBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihgdHdlYWtlcjoke2lkfToke2N9YCwgd3JhcHBlZCk7XG4gICAgICB9LFxuICAgICAgc2VuZDogKGMsIC4uLmFyZ3MpID0+IGlwY1JlbmRlcmVyLnNlbmQoYHR3ZWFrZXI6JHtpZH06JHtjfWAsIC4uLmFyZ3MpLFxuICAgICAgaW52b2tlOiA8VD4oYzogc3RyaW5nLCAuLi5hcmdzOiB1bmtub3duW10pID0+IHtcbiAgICAgICAgaWYgKGlkID09PSBcImNvLnR3ZWFrZXJzLnRocmVhZC1zdW1tYXJ5LXByb2ZpbGVzXCIgJiYgYyA9PT0gXCJwcm9maWxlcy5yZWFkXCIpIHtcbiAgICAgICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgICAgXCJ0d2Vha2VyOmNyb3NzLXR3ZWFrLXJlYWRcIixcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgXCJjby50d2Vha2Vycy5wcm9qZWN0c1wiLFxuICAgICAgICAgICAgXCJwcm9maWxlcy5yZWFkXCIsXG4gICAgICAgICAgICBhcmdzWzBdLFxuICAgICAgICAgICkgYXMgUHJvbWlzZTxUPjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaWQgPT09IFwiY28udHdlYWtlcnMuZm9sbG93dXBcIiAmJiBjID09PSBcInBvbGljeVwiKSB7XG4gICAgICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICAgIFwidHdlYWtlcjpjcm9zcy10d2Vhay1yZWFkXCIsXG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIFwiY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgICAgICAgICAgIFwiZm9sbG93dXAucG9saWN5LnJlYWRcIixcbiAgICAgICAgICAgIGFyZ3NbMF0sXG4gICAgICAgICAgKSBhcyBQcm9taXNlPFQ+O1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoYHR3ZWFrZXI6JHtpZH06JHtjfWAsIC4uLmFyZ3MpIGFzIFByb21pc2U8VD47XG4gICAgICB9LFxuICAgIH0sXG4gICAgZnM6IHJlbmRlcmVyRnMoaWQsIHBhdGhzKSxcbiAgICBjb2RleDogcmVuZGVyZXJDb2RleEFwaShpZCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyQ29kZXhBcGkodHdlYWtJZDogc3RyaW5nKTogTm9uTnVsbGFibGU8VHdlYWtBcGlbXCJjb2RleFwiXT4ge1xuICByZXR1cm4ge1xuICAgIHJ1bnRpbWU6IHtcbiAgICAgIGdldEluZm86IGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3QgaW5mbyA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtcnVudGltZS1pbmZvXCIpIGFzIENvZGV4UnVudGltZUluZm87XG4gICAgICAgIGNvbnN0IGJyaWRnZSA9IHJlbmRlcmVyRWxlY3Ryb25CcmlkZ2UoKTtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAuLi5pbmZvLFxuICAgICAgICAgIGJ1aWxkRmxhdm9yOiBicmlkZ2U/LmdldEJ1aWxkRmxhdm9yPy4oKSA/PyBpbmZvLmJ1aWxkRmxhdm9yLFxuICAgICAgICAgIHVzZXNPd2xBcHBTaGVsbDogYnJpZGdlPy51c2VzT3dsQXBwU2hlbGw/LigpID8/IGluZm8udXNlc093bEFwcFNoZWxsLFxuICAgICAgICB9O1xuICAgICAgfSxcbiAgICAgIGdldENhcGFiaWxpdGllczogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC1ydW50aW1lLWNhcGFiaWxpdGllc1wiKSBhcyBQcm9taXNlPENvZGV4UnVudGltZUNhcGFiaWxpdGllcz4sXG4gICAgfSxcbiAgICB3aW5kb3dzOiB7XG4gICAgICBjcmVhdGU6IChvcHRpb25zKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1jcmVhdGVcIiwgb3B0aW9ucykgYXMgUHJvbWlzZTxDb2RleFdpbmRvd1JlZj4sXG4gICAgICBnZXRQcmltYXJ5OiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1wcmltYXJ5XCIpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWYgfCBudWxsPixcbiAgICAgIGZvY3VzOiAod2luZG93SWQpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LWZvY3VzXCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgICAgc2hvdzogKHdpbmRvd0lkKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1zaG93XCIsIHdpbmRvd0lkKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICAgIH0sXG4gICAgdmlld3M6IHtcbiAgICAgIGNyZWF0ZTogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpjb2RleC12aWV3LWNyZWF0ZVwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdlYkNvbnRlbnRzSWQ6IG51bWJlcjsgcGFyZW50V2luZG93SWQ6IG51bWJlciB8IG51bGwgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyQ29kZXhWaWV3UmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndlYkNvbnRlbnRzSWQsIHJlZi5wYXJlbnRXaW5kb3dJZCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY2RwOiB7XG4gICAgICBnZXRTdGF0dXM6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtY2RwLXN0YXR1c1wiKSBhcyBQcm9taXNlPENvZGV4Q2RwU3RhdHVzPixcbiAgICAgIGxpc3RUYXJnZXRzOiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LWNkcC10YXJnZXRzXCIpIGFzIFByb21pc2U8Q29kZXhDZHBUYXJnZXRbXT4sXG4gICAgfSxcbiAgICBuYXRpdmU6IHtcbiAgICAgIGxvYWRNb2R1bGU6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWxvYWQtbW9kdWxlXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsga2luZDogTmF0aXZlTW9kdWxlS2luZCB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVNb2R1bGVSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYua2luZCk7XG4gICAgICB9LFxuICAgICAgY3JlYXRlUGFuZWw6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWNyZWF0ZS1wYW5lbFwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHdpbmRvd0lkOiBudW1iZXIgfCBudWxsIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZVBhbmVsUmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLndpbmRvd0lkKTtcbiAgICAgIH0sXG4gICAgICBhdHRhY2hWaWV3OiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1hdHRhY2gtdmlld1wiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmcgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlVmlld1JlZih0d2Vha0lkLCByZWYuaWQpO1xuICAgICAgfSxcbiAgICAgIGxhdW5jaEhlbHBlcjogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpuYXRpdmUtbGF1bmNoLWhlbHBlclwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IHBpZDogbnVtYmVyIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkLCByZWYuaWQsIHJlZi5waWQpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHJlZnJlc2g6IHtcbiAgICAgIGdldFN0YXR1czogKCkgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtcmVmcmVzaC1zdGF0dXNcIiksXG4gICAgICBzdGFydDogKHNvdXJjZSA9IFwic21hcnRcIikgPT4gaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzdGFydC1sb2NhbC1yZWZyZXNoXCIsIHNvdXJjZSksXG4gICAgICBvblN0YXR1c0NoYW5nZWQ6IChsaXN0ZW5lcikgPT4ge1xuICAgICAgICBjb25zdCBoYW5kbGVyID0gKCkgPT4geyB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LXJlZnJlc2gtc3RhdHVzXCIpLnRoZW4obGlzdGVuZXIpOyB9O1xuICAgICAgICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6cmVmcmVzaC1zdGF0dXMtY2hhbmdlZFwiLCBoYW5kbGVyKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjpyZWZyZXNoLXN0YXR1cy1jaGFuZ2VkXCIsIGhhbmRsZXIpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGNhcHR1cmU6IHtcbiAgICAgIGdldFBlcm1pc3Npb25TdGF0dXM6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICByZXF1ZXN0QWNjZXNzaWJpbGl0eTogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICAgIG9wZW5QZXJtaXNzaW9uU2V0dGluZ3M6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICBjYXB0dXJlRnJvbnRtb3N0V2luZG93OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgaG90a2V5czoge1xuICAgICAgcmVnaXN0ZXJDYXB0dXJlSG90a2V5OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5ob3RrZXlzIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY3JlYXRlQnJvd3NlclZpZXc6IChfb3B0aW9ucykgPT4ge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNyZWF0ZUJyb3dzZXJWaWV3IGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgfSxcbiAgICBjcmVhdGVXaW5kb3c6IChvcHRpb25zKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctY3JlYXRlXCIsIG9wdGlvbnMpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWY+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckNvZGV4Vmlld1JlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICB3ZWJDb250ZW50c0lkOiBudW1iZXIsXG4gIHBhcmVudFdpbmRvd0lkOiBudW1iZXIgfCBudWxsLFxuKTogQ29kZXhWaWV3UmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICB3ZWJDb250ZW50c0lkLFxuICAgIHBhcmVudFdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInNldEJvdW5kc1wiLCBib3VuZHMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgc2V0VmlzaWJsZTogKHZpc2libGUpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZXRWaXNpYmxlXCIsIHZpc2libGUpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgYnJpbmdUb0Zyb250OiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiYnJpbmdUb0Zyb250XCIpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgbG9hZFJvdXRlOiAocm91dGUsIGhvc3RJZCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImxvYWRSb3V0ZVwiLCByb3V0ZSwgaG9zdElkKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGxvYWRVcmw6ICh1cmwpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJsb2FkVXJsXCIsIHVybCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZU1vZHVsZVJlZihcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBpZDogc3RyaW5nLFxuICBraW5kOiBOYXRpdmVNb2R1bGVLaW5kLFxuKTogTmF0aXZlTW9kdWxlUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBraW5kLFxuICAgIHJlcXVlc3Q6IChtZXRob2QsIHBheWxvYWQsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1tb2R1bGUtcmVxdWVzdFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgbWV0aG9kLFxuICAgICAgICBwYXlsb2FkLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgICApLFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1tb2R1bGUtZGlzcG9zZVwiLCB0d2Vha0lkLCBpZCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVQYW5lbFJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHdpbmRvd0lkOiBudW1iZXIgfCBudWxsKTogTmF0aXZlUGFuZWxSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHdpbmRvd0lkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJzZXRCb3VuZHNcIiwgYm91bmRzKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHNob3c6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwic2hvd1wiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGhpZGU6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiaGlkZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZVZpZXdSZWYodHdlYWtJZDogc3RyaW5nLCBpZDogc3RyaW5nKTogTmF0aXZlVmlld1JlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgc2V0Qm91bmRzOiAoYm91bmRzKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwic2V0Qm91bmRzXCIsIGJvdW5kcykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBzZXRWaXNpYmxlOiAodmlzaWJsZSkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJ2aWV3XCIsIGlkLCBcInNldFZpc2libGVcIiwgdmlzaWJsZSkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwiZGlzcG9zZVwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZUhlbHBlclJlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcsIHBpZDogbnVtYmVyKTogTmF0aXZlSGVscGVyUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBwaWQsXG4gICAgc2VuZDogKG1lc3NhZ2UpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1oZWxwZXItY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZW5kXCIsIG1lc3NhZ2UpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgcmVxdWVzdDogKG1lc3NhZ2UsIHRpbWVvdXRNcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1oZWxwZXItY2FsbFwiLFxuICAgICAgICB0d2Vha0lkLFxuICAgICAgICBpZCxcbiAgICAgICAgXCJyZXF1ZXN0XCIsXG4gICAgICAgIG1lc3NhZ2UsXG4gICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICksXG4gICAgc3RvcDogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWhlbHBlci1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInN0b3BcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJFbGVjdHJvbkJyaWRnZSgpOiBFbGVjdHJvbkJyaWRnZSB8IG51bGwge1xuICBjb25zdCB2YWx1ZSA9ICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IGVsZWN0cm9uQnJpZGdlPzogdW5rbm93biB9KS5lbGVjdHJvbkJyaWRnZTtcbiAgcmV0dXJuIHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIEVsZWN0cm9uQnJpZGdlIDogbnVsbDtcbn1cblxuZXhwb3J0IGNvbnN0IHJlbmRlcmVyU3RvcmFnZSA9IChpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlID0gbG9jYWxTdG9yYWdlKSA9PiBjcmVhdGVSZW5kZXJlclN0b3JhZ2UoaWQsIHN0b3JhZ2UpO1xuXG5mdW5jdGlvbiByZW5kZXJlckZzKGlkOiBzdHJpbmcsIF9wYXRoczogVXNlclBhdGhzKSB7XG4gIC8vIFNhbmRib3hlZCByZW5kZXJlciBjYW4ndCB1c2UgTm9kZSBmcyBkaXJlY3RseSBcdTIwMTQgcHJveHkgdGhyb3VnaCBtYWluIElQQy5cbiAgcmV0dXJuIHtcbiAgICBkYXRhRGlyOiBgPHJlbW90ZT4vdHdlYWstZGF0YS8ke2lkfWAsXG4gICAgcmVhZDogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dHdlYWstZnNcIiwgXCJyZWFkXCIsIGlkLCBwKSBhcyBQcm9taXNlPHN0cmluZz4sXG4gICAgd3JpdGU6IChwOiBzdHJpbmcsIGM6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dHdlYWstZnNcIiwgXCJ3cml0ZVwiLCBpZCwgcCwgYykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBleGlzdHM6IChwOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnR3ZWFrLWZzXCIsIFwiZXhpc3RzXCIsIGlkLCBwKSBhcyBQcm9taXNlPGJvb2xlYW4+LFxuICB9O1xufVxuIiwgImltcG9ydCB7IGZpYmVyRm9yTm9kZSB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB0eXBlIHtcbiAgSG9zdFByb2plY3RDb250ZXh0LFxuICBIb3N0U3VyZmFjZUtpbmQsXG4gIEhvc3RTdXJmYWNlTWF0Y2gsXG4gIEhvc3RTdXJmYWNlU25hcHNob3QsXG4gIEhvc3RVaUFwaSxcbiAgUmVhY3RGaWJlck5vZGUsXG59IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcblxuY29uc3QgTUFYX01BVENIRVMgPSAxMDA7XG5jb25zdCBsaXN0ZW5lcnMgPSBuZXcgU2V0PHsga2luZHM6IEhvc3RTdXJmYWNlS2luZFtdOyBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkIH0+KCk7XG5sZXQgc2hhcmVkT2JzZXJ2ZXI6IE11dGF0aW9uT2JzZXJ2ZXIgfCBudWxsID0gbnVsbDtcbmxldCBwZW5kaW5nRnJhbWU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5jb25zdCBTRUxFQ1RPUlM6IFJlY29yZDxFeGNsdWRlPEhvc3RTdXJmYWNlS2luZCwgXCJwcm9qZWN0c1wiIHwgXCJ0aHJlYWQtY29udGV4dFwiIHwgXCJ1c2FnZVwiPiwgc3RyaW5nPiA9IHtcbiAgXCJhc3Npc3RhbnQtdHVybnNcIjogJ1tkYXRhLXRlc3RpZD1cImNvbnZlcnNhdGlvbi10dXJuXCJdLCBbZGF0YS10ZXN0aWQqPVwiYXNzaXN0YW50LW1lc3NhZ2VcIiBpXSwgW2RhdGEtbWVzc2FnZS1hdXRob3Itcm9sZT1cImFzc2lzdGFudFwiXSwgW2RhdGEtcm9sZT1cImFzc2lzdGFudFwiXScsXG4gIGNvbXBvc2VyOiAnI3Byb21wdC10ZXh0YXJlYSwgW2RhdGEtdGVzdGlkPVwiY29tcG9zZXJcIl0gdGV4dGFyZWEsIFtkYXRhLXRlc3RpZD1cImNvbXBvc2VyXCJdIFtjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdLCBmb3JtIHRleHRhcmVhOm5vdChbZGlzYWJsZWRdKSwgZm9ybSBbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXScsXG4gIFwiY29tbWFuZC1tZW51XCI6ICdbZGF0YS1jb21tYW5kLW1lbnVdLCBbZGF0YS1zbGFzaC1tZW51XSwgW3JvbGU9XCJsaXN0Ym94XCJdJyxcbiAgXCJhY2NvdW50LW1lbnVcIjogJ1tyb2xlPVwibWVudVwiXSwgW3JvbGU9XCJkaWFsb2dcIl0nLFxuICBcInNldHRpbmdzLXJvd3NcIjogJ1tkYXRhLXNldHRpbmdzLXJvd10sIFtyb2xlPVwibGlzdGl0ZW1cIl0sIHNlY3Rpb24gPiBkaXYnLFxuICBcInRpdGxlYmFyLWNvbnRyb2xzXCI6ICdbZGF0YS10aXRsZWJhci1jb250cm9sXSwgW2FyaWEtbGFiZWw9XCJIaWRlIHNpZGViYXJcIl0sIFthcmlhLWxhYmVsPVwiU2hvdyBzaWRlYmFyXCJdLCBbYXJpYS1sYWJlbD1cIkJhY2tcIl0sIFthcmlhLWxhYmVsPVwiRm9yd2FyZFwiXSwgW3RpdGxlPVwiQmFja1wiXSwgW3RpdGxlPVwiRm9yd2FyZFwiXScsXG59O1xuXG5leHBvcnQgY29uc3QgaG9zdFVpQXBpOiBIb3N0VWlBcGkgPSB7XG4gIHF1ZXJ5OiBxdWVyeUhvc3RTdXJmYWNlcyxcbiAgc25hcHNob3QsXG4gIG9ic2VydmUsXG4gIGdldEFjdGl2ZVByb2plY3QsXG4gIGF0dGFjaEZpbGVzLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIHF1ZXJ5SG9zdFN1cmZhY2VzKGtpbmQ6IEhvc3RTdXJmYWNlS2luZCk6IEhvc3RTdXJmYWNlTWF0Y2hbXSB7XG4gIGlmICh0eXBlb2YgZG9jdW1lbnQgPT09IFwidW5kZWZpbmVkXCIpIHJldHVybiBbXTtcbiAgaWYgKGtpbmQgPT09IFwicHJvamVjdHNcIikgcmV0dXJuIHByb2plY3RSb3dzKCk7XG4gIGlmIChraW5kID09PSBcInRocmVhZC1jb250ZXh0XCIpIHJldHVybiB0aHJlYWRDb250ZXh0cygpO1xuICBpZiAoa2luZCA9PT0gXCJ1c2FnZVwiKSByZXR1cm4gdXNhZ2VTdXJmYWNlcygpO1xuICBjb25zdCBzZWxlY3RvciA9IFNFTEVDVE9SU1traW5kXTtcbiAgcmV0dXJuIHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpKVxuICAgIC5maWx0ZXIoKGVsZW1lbnQpID0+IHNlbWFudGljRmlsdGVyKGtpbmQsIGVsZW1lbnQpKVxuICAgIC5zbGljZSgwLCBNQVhfTUFUQ0hFUylcbiAgICAubWFwKChlbGVtZW50KSA9PiAoeyBraW5kLCBlbGVtZW50LCBjb25maWRlbmNlOiBjb25maWRlbmNlRm9yKGtpbmQsIGVsZW1lbnQpLCBsYWJlbDogYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQpIH0pKTtcbn1cblxuZnVuY3Rpb24gc25hcHNob3Qoa2luZDogSG9zdFN1cmZhY2VLaW5kKTogSG9zdFN1cmZhY2VTbmFwc2hvdCB7XG4gIGNvbnN0IG1hdGNoZXMgPSBxdWVyeUhvc3RTdXJmYWNlcyhraW5kKS5zbGljZSgwLCBNQVhfTUFUQ0hFUyk7XG4gIHJldHVybiB7IGtpbmQsIGNvdW50OiBtYXRjaGVzLmxlbmd0aCwgbWF0Y2hlcyB9O1xufVxuXG5mdW5jdGlvbiBvYnNlcnZlKGtpbmRzOiBIb3N0U3VyZmFjZUtpbmRbXSwgbGlzdGVuZXI6IChzbmFwc2hvdHM6IEhvc3RTdXJmYWNlU25hcHNob3RbXSkgPT4gdm9pZCk6ICgpID0+IHZvaWQge1xuICBjb25zdCBlbnRyeSA9IHsga2luZHM6IFsuLi5uZXcgU2V0KGtpbmRzKV0sIGxpc3RlbmVyIH07XG4gIGxpc3RlbmVycy5hZGQoZW50cnkpO1xuICBlbnN1cmVPYnNlcnZlcigpO1xuICBzYWZlbHlOb3RpZnkoZW50cnksIGVudHJ5LmtpbmRzLm1hcChzbmFwc2hvdCkpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGxpc3RlbmVycy5kZWxldGUoZW50cnkpO1xuICAgIGlmICghbGlzdGVuZXJzLnNpemUpIHtcbiAgICAgIHNoYXJlZE9ic2VydmVyPy5kaXNjb25uZWN0KCk7XG4gICAgICBzaGFyZWRPYnNlcnZlciA9IG51bGw7XG4gICAgICBpZiAocGVuZGluZ0ZyYW1lICE9PSBudWxsKSBjYW5jZWxBbmltYXRpb25GcmFtZShwZW5kaW5nRnJhbWUpO1xuICAgICAgcGVuZGluZ0ZyYW1lID0gbnVsbDtcbiAgICB9XG4gIH07XG59XG5cbmZ1bmN0aW9uIGVuc3VyZU9ic2VydmVyKCk6IHZvaWQge1xuICBpZiAoc2hhcmVkT2JzZXJ2ZXIgfHwgdHlwZW9mIE11dGF0aW9uT2JzZXJ2ZXIgPT09IFwidW5kZWZpbmVkXCIgfHwgdHlwZW9mIGRvY3VtZW50ID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm47XG4gIHNoYXJlZE9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGlmIChwZW5kaW5nRnJhbWUgIT09IG51bGwpIHJldHVybjtcbiAgICBwZW5kaW5nRnJhbWUgPSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgICAgcGVuZGluZ0ZyYW1lID0gbnVsbDtcbiAgICAgIGZvciAoY29uc3QgZW50cnkgb2YgbGlzdGVuZXJzKSBzYWZlbHlOb3RpZnkoZW50cnksIGVudHJ5LmtpbmRzLm1hcChzbmFwc2hvdCkpO1xuICAgIH0pO1xuICB9KTtcbiAgc2hhcmVkT2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHtcbiAgICBhdHRyaWJ1dGVzOiB0cnVlLFxuICAgIGF0dHJpYnV0ZUZpbHRlcjogW1wiYXJpYS1sYWJlbFwiLCBcImFyaWEtY3VycmVudFwiLCBcInJvbGVcIiwgXCJkYXRhLXRlc3RpZFwiLCBcImRhdGEtcHJvamVjdC1pZFwiLCBcImRhdGEtcHJvamVjdC1uYW1lXCIsIFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiLCBcImRhdGEtdXNhZ2UtbGltaXQta2V5XCIsIFwiZGF0YS11c2FnZS1saW1pdFwiLCBcImRpc2FibGVkXCJdLFxuICAgIGNoaWxkTGlzdDogdHJ1ZSxcbiAgICBjaGFyYWN0ZXJEYXRhOiB0cnVlLFxuICAgIHN1YnRyZWU6IHRydWUsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzYWZlbHlOb3RpZnkoZW50cnk6IHsgbGlzdGVuZXI6IChzbmFwc2hvdHM6IEhvc3RTdXJmYWNlU25hcHNob3RbXSkgPT4gdm9pZCB9LCBzbmFwc2hvdHM6IEhvc3RTdXJmYWNlU25hcHNob3RbXSk6IHZvaWQge1xuICB0cnkgeyBlbnRyeS5saXN0ZW5lcihzbmFwc2hvdHMpOyB9XG4gIGNhdGNoIChlcnJvcikgeyBjb25zb2xlLndhcm4oXCJbdHdlYWtlcl0gaG9zdCBzdXJmYWNlIG9ic2VydmVyIGZhaWxlZFwiLCBlcnJvcik7IH1cbn1cblxuZnVuY3Rpb24gcHJvamVjdFJvd3MoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgY29udHJvbHMgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdidXR0b24sIGEsIFtyb2xlPVwiYnV0dG9uXCJdJykpO1xuICByZXR1cm4gY29udHJvbHMuZmlsdGVyKChlbGVtZW50KSA9PiB7XG4gICAgY29uc3QgbGFiZWwgPSBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpO1xuICAgIGlmICghbGFiZWwgfHwgbGFiZWwubGVuZ3RoID4gMTIwIHx8ICFlbGVtZW50LnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIikpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gQm9vbGVhbihkaXJlY3RQcm9qZWN0SWRlbnRpdHkoZWxlbWVudCkpO1xuICB9KS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoe1xuICAgIGtpbmQ6IFwicHJvamVjdHNcIixcbiAgICBlbGVtZW50LFxuICAgIGNvbmZpZGVuY2U6IFwiaGlnaFwiLFxuICAgIGxhYmVsOiBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpLFxuICB9KSk7XG59XG5cbi8qKlxuICogQSBwcm9qZWN0IHJvdyBtdXN0IG93biBwcm9qZWN0IGlkZW50aXR5IGl0c2VsZi4gV2Fsa2luZyBhbmNlc3RvciBmaWJlcnMgbWFkZVxuICogZXZlcnkgY29udHJvbCByZW5kZXJlZCBpbnNpZGUgYSBwcm9qZWN0IHJvdXRlIGluaGVyaXQgcHJvamVjdCBjb250ZXh0OiB0YXNrXG4gKiByb3dzIGFuZCBldmVuIHRoZSB0aXRsZWJhciBtb2RlbCBwaWNrZXIgdGhlbiBsb29rZWQgbGlrZSBwcm9qZWN0IHJvd3MuIEtlZXBcbiAqIHRoaXMgc2VhbSBmYWlsLWNsb3NlZCBzbyBjb25zdW1lcnMgbmV2ZXIgZGVjb3JhdGUgdW5yZWxhdGVkIGhvc3QgY29udHJvbHMuXG4gKi9cbmZ1bmN0aW9uIGRpcmVjdFByb2plY3RJZGVudGl0eShlbGVtZW50OiBFbGVtZW50KTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAoY29uc3QgYXR0cmlidXRlIG9mIFtcbiAgICBcImRhdGEtYXBwLWFjdGlvbi1zaWRlYmFyLXByb2plY3QtaWRcIixcbiAgICBcImRhdGEtcHJvamVjdC1pZFwiLFxuICAgIFwiZGF0YS1wcm9qZWN0LW5hbWVcIixcbiAgICBcImRhdGEtd29ya3NwYWNlLXBhdGhcIixcbiAgICBcImRhdGEtcHJvamVjdC1wYXRoXCIsXG4gIF0pIHtcbiAgICBjb25zdCB2YWx1ZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKGF0dHJpYnV0ZSk/LnRyaW0oKTtcbiAgICBpZiAodmFsdWUpIHJldHVybiB2YWx1ZTtcbiAgfVxuICBjb25zdCBwcm9wcyA9IChmaWJlckZvck5vZGUoZWxlbWVudCkgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsKT8ubWVtb2l6ZWRQcm9wcztcbiAgcmV0dXJuIHByb3BzICYmIHR5cGVvZiBwcm9wcyA9PT0gXCJvYmplY3RcIlxuICAgID8gZmlyc3RTdHJpbmcocHJvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIFtcInByb2plY3RJZFwiLCBcInByb2plY3ROYW1lXCIsIFwid29ya3NwYWNlUGF0aFwiLCBcInByb2plY3RQYXRoXCJdKSA/PyBudWxsXG4gICAgOiBudWxsO1xufVxuXG5mdW5jdGlvbiB0aHJlYWRDb250ZXh0cygpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBjb25zdCBjYW5kaWRhdGVzID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtcHJvamVjdC1pZF0sIFtkYXRhLXdvcmtzcGFjZS1wYXRoXSwgbWFpbiwgW3JvbGU9XCJtYWluXCJdJykpO1xuICByZXR1cm4gY2FuZGlkYXRlcy5maWx0ZXIoKGVsZW1lbnQpID0+IHtcbiAgICBpZiAoZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtaWRcIikgfHwgZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIpKSByZXR1cm4gdHJ1ZTtcbiAgICBjb25zdCBwcm9wcyA9IGZpYmVyUHJvcHMoZWxlbWVudCk7XG4gICAgcmV0dXJuIEJvb2xlYW4oZmlyc3RTdHJpbmcocHJvcHMsIFtcInByb2plY3RJZFwiLCBcIndvcmtzcGFjZVBhdGhcIiwgXCJwcm9qZWN0TmFtZVwiXSkpO1xuICB9KS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoeyBraW5kOiBcInRocmVhZC1jb250ZXh0XCIsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpID8gXCJoaWdoXCIgOiBcIm1lZGl1bVwiLCBsYWJlbDogYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQpIH0pKTtcbn1cblxuZnVuY3Rpb24gdXNhZ2VTdXJmYWNlcygpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBjb25zdCBkaXJlY3QgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS11c2FnZS1saW1pdC1rZXldLCBbZGF0YS11c2FnZS1saW1pdF0sIFtkYXRhLXRlc3RpZCo9XCJ1c2FnZVwiIGldLCBbYXJpYS1sYWJlbCo9XCJ1c2FnZVwiIGldLCBbY2xhc3MqPVwidXNhZ2VcIiBpXScpKTtcbiAgY29uc3QgdGV4dHVhbCA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCJzZWN0aW9uLCBhcnRpY2xlLCBbcm9sZT0nbGlzdGl0ZW0nXVwiKSkuZmlsdGVyKChlbGVtZW50KSA9PiAvKD86dXNhZ2V8bGltaXQpLiooPzpyZW1haW5pbmd8cmVzZXR8dXNlZCl8KD86cmVtYWluaW5nfHJlc2V0fHVzZWQpLiooPzp1c2FnZXxsaW1pdCkvaS50ZXN0KGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCkpKTtcbiAgcmV0dXJuIHVuaXF1ZUVsZW1lbnRzKFsuLi5kaXJlY3QsIC4uLnRleHR1YWxdKS5zbGljZSgwLCBNQVhfTUFUQ0hFUykubWFwKChlbGVtZW50KSA9PiAoeyBraW5kOiBcInVzYWdlXCIsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGRpcmVjdC5pbmNsdWRlcyhlbGVtZW50KSA/IFwiaGlnaFwiIDogXCJtZWRpdW1cIiwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIGdldEFjdGl2ZVByb2plY3QoKTogSG9zdFByb2plY3RDb250ZXh0IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgbWF0Y2ggb2YgcXVlcnlIb3N0U3VyZmFjZXMoXCJ0aHJlYWQtY29udGV4dFwiKSkge1xuICAgIGNvbnN0IGVsZW1lbnQgPSBtYXRjaC5lbGVtZW50O1xuICAgIGNvbnN0IHByb3BzID0gZmliZXJQcm9wcyhlbGVtZW50KTtcbiAgICBjb25zdCBjb250ZXh0ID0ge1xuICAgICAgaWQ6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0SWRcIiwgXCJpZFwiXSksXG4gICAgICBuYW1lOiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1uYW1lXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0TmFtZVwiLCBcIm5hbWVcIl0pLFxuICAgICAgd29ya3NwYWNlUGF0aDogZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIpIHx8IGZpcnN0U3RyaW5nKHByb3BzLCBbXCJ3b3Jrc3BhY2VQYXRoXCIsIFwicHJvamVjdFBhdGhcIiwgXCJjd2RcIl0pLFxuICAgIH07XG4gICAgaWYgKGNvbnRleHQuaWQgfHwgY29udGV4dC5uYW1lIHx8IGNvbnRleHQud29ya3NwYWNlUGF0aCkgcmV0dXJuIGNvbnRleHQ7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGF0dGFjaEZpbGVzKGZpbGVzOiBBcnJheTx7IG5hbWU6IHN0cmluZzsgbWltZVR5cGU6IHN0cmluZzsgZGF0YUJhc2U2NDogc3RyaW5nIH0+KTogUHJvbWlzZTx7IGFjY2VwdGVkOiBib29sZWFuOyByZWFzb246IFwiYWNjZXB0ZWRcIiB8IFwiY29tcG9zZXItbWlzc2luZ1wiIHwgXCJwYXN0ZS1yZWplY3RlZFwiIHwgXCJhdHRhY2htZW50LXRpbWVvdXRcIiB9PiB7XG4gIGNvbnN0IHRhcmdldCA9IHF1ZXJ5SG9zdFN1cmZhY2VzKFwiY29tcG9zZXJcIilbMF0/LmVsZW1lbnQgPz8gbnVsbDtcbiAgaWYgKCF0YXJnZXQpIHJldHVybiB7IGFjY2VwdGVkOiBmYWxzZSwgcmVhc29uOiBcImNvbXBvc2VyLW1pc3NpbmdcIiB9O1xuICBjb25zdCBwcmVwYXJlZCA9IGZpbGVzLm1hcCgoZmlsZSkgPT4ge1xuICAgIGNvbnN0IGJ5dGVzID0gVWludDhBcnJheS5mcm9tKGF0b2IoZmlsZS5kYXRhQmFzZTY0KSwgKGNoYXIpID0+IGNoYXIuY2hhckNvZGVBdCgwKSk7XG4gICAgcmV0dXJuIG5ldyBGaWxlKFtieXRlc10sIHNhZmVGaWxlTmFtZShmaWxlLm5hbWUpLCB7IHR5cGU6IGZpbGUubWltZVR5cGUgfHwgXCJhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW1cIiB9KTtcbiAgfSk7XG4gIGNvbnN0IHRyYW5zZmVyID0gbmV3IERhdGFUcmFuc2ZlcigpO1xuICBmb3IgKGNvbnN0IGZpbGUgb2YgcHJlcGFyZWQpIHRyYW5zZmVyLml0ZW1zLmFkZChmaWxlKTtcbiAgdGFyZ2V0LmRpc3BhdGNoRXZlbnQobmV3IERyYWdFdmVudChcImRyb3BcIiwgeyBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlLCBkYXRhVHJhbnNmZXI6IHRyYW5zZmVyIH0pKTtcbiAgY29uc3QgcGFzdGUgPSBuZXcgQ2xpcGJvYXJkRXZlbnQoXCJwYXN0ZVwiLCB7IGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWUsIGNsaXBib2FyZERhdGE6IHRyYW5zZmVyIH0pO1xuICBjb25zdCBhY2NlcHRlZCA9IHRhcmdldC5kaXNwYXRjaEV2ZW50KHBhc3RlKTtcbiAgdGFyZ2V0LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KFwiaW5wdXRcIiwgeyBidWJibGVzOiB0cnVlIH0pKTtcbiAgKHRhcmdldCBhcyBIVE1MRWxlbWVudCkuZm9jdXM/LigpO1xuICByZXR1cm4geyBhY2NlcHRlZDogYWNjZXB0ZWQgIT09IGZhbHNlLCByZWFzb246IGFjY2VwdGVkID09PSBmYWxzZSA/IFwicGFzdGUtcmVqZWN0ZWRcIiA6IFwiYWNjZXB0ZWRcIiB9O1xufVxuXG5mdW5jdGlvbiBzYWZlRmlsZU5hbWUodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBTdHJpbmcodmFsdWUgfHwgXCJBcHBTaG90XCIpLnJlcGxhY2UoL1svOlxcXFxcXDBcXHJcXG5dL2csIFwiLVwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG4gIHJldHVybiBjbGVhbmVkLnNsaWNlKDAsIDE2MCkgfHwgXCJBcHBTaG90XCI7XG59XG5cbmZ1bmN0aW9uIHNlbWFudGljRmlsdGVyKGtpbmQ6IEhvc3RTdXJmYWNlS2luZCwgZWxlbWVudDogRWxlbWVudCk6IGJvb2xlYW4ge1xuICBjb25zdCB0ZXh0ID0gY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KTtcbiAgaWYgKGtpbmQgPT09IFwiYXNzaXN0YW50LXR1cm5zXCIpIHtcbiAgICBjb25zdCByb2xlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLW1lc3NhZ2UtYXV0aG9yLXJvbGVcIikgfHwgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXJvbGVcIik7XG4gICAgcmV0dXJuIHJvbGUgPyByb2xlLnRvTG93ZXJDYXNlKCkgPT09IFwiYXNzaXN0YW50XCIgOiAvYXNzaXN0YW50LW1lc3NhZ2UvaS50ZXN0KGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS10ZXN0aWRcIikgfHwgXCJcIik7XG4gIH1cbiAgaWYgKGtpbmQgPT09IFwiYWNjb3VudC1tZW51XCIpIHJldHVybiAvYWNjb3VudHxzZXR0aW5nc3xsb2dcXHMqb3V0L2kudGVzdCh0ZXh0KTtcbiAgaWYgKGtpbmQgPT09IFwic2V0dGluZ3Mtcm93c1wiKSByZXR1cm4gdGV4dC5sZW5ndGggPiAwO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZnVuY3Rpb24gY29uZmlkZW5jZUZvcihraW5kOiBIb3N0U3VyZmFjZUtpbmQsIGVsZW1lbnQ6IEVsZW1lbnQpOiBIb3N0U3VyZmFjZU1hdGNoW1wiY29uZmlkZW5jZVwiXSB7XG4gIGlmIChlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtdGVzdGlkXCIpIHx8IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fCBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcInJvbGVcIikpIHJldHVybiBcImhpZ2hcIjtcbiAgcmV0dXJuIGtpbmQgPT09IFwiY29tcG9zZXJcIiB8fCBraW5kID09PSBcInRpdGxlYmFyLWNvbnRyb2xzXCIgPyBcIm1lZGl1bVwiIDogXCJsb3dcIjtcbn1cblxuZnVuY3Rpb24gZmliZXJQcm9wcyhlbGVtZW50OiBFbGVtZW50KTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgbGV0IGZpYmVyID0gZmliZXJGb3JOb2RlKGVsZW1lbnQpIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICBmb3IgKGxldCBkZXB0aCA9IDA7IGZpYmVyICYmIGRlcHRoIDwgMjA7IGRlcHRoICs9IDEsIGZpYmVyID0gZmliZXIucmV0dXJuKSB7XG4gICAgaWYgKGZpYmVyLm1lbW9pemVkUHJvcHMgJiYgdHlwZW9mIGZpYmVyLm1lbW9pemVkUHJvcHMgPT09IFwib2JqZWN0XCIpIE9iamVjdC5hc3NpZ24obWVyZ2VkLCBmaWJlci5tZW1vaXplZFByb3BzKTtcbiAgfVxuICByZXR1cm4gT2JqZWN0LmtleXMobWVyZ2VkKS5sZW5ndGggPyBtZXJnZWQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiBmaXJzdFN0cmluZyhwcm9wczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsLCBrZXlzOiBzdHJpbmdbXSk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGlmICghcHJvcHMpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHF1ZXVlOiB1bmtub3duW10gPSBbcHJvcHNdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDx1bmtub3duPigpO1xuICBmb3IgKGxldCB2aXNpdGVkID0gMDsgcXVldWUubGVuZ3RoICYmIHZpc2l0ZWQgPCA4MDsgdmlzaXRlZCArPSAxKSB7XG4gICAgY29uc3QgdmFsdWUgPSBxdWV1ZS5zaGlmdCgpO1xuICAgIGlmICghdmFsdWUgfHwgdHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHNlZW4uaGFzKHZhbHVlKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICAgIGZvciAoY29uc3QgW2tleSwgaXRlbV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICBpZiAoa2V5cy5pbmNsdWRlcyhrZXkpICYmIHR5cGVvZiBpdGVtID09PSBcInN0cmluZ1wiICYmIGl0ZW0udHJpbSgpKSByZXR1cm4gaXRlbTtcbiAgICAgIGlmIChpdGVtICYmIHR5cGVvZiBpdGVtID09PSBcIm9iamVjdFwiKSBxdWV1ZS5wdXNoKGl0ZW0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB1bmlxdWVFbGVtZW50cyhpbnB1dDogSXRlcmFibGU8RWxlbWVudD4gfCBBcnJheUxpa2U8RWxlbWVudD4pOiBFbGVtZW50W10ge1xuICByZXR1cm4gWy4uLm5ldyBTZXQoQXJyYXkuZnJvbShpbnB1dCkpXTtcbn1cblxuZnVuY3Rpb24gYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQ6IEVsZW1lbnQpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwidGl0bGVcIikgfHwgY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KSB8fCB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3QodmFsdWU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cbiIsICJleHBvcnQgdHlwZSBUd2Vha1Njb3BlID0gXCJyZW5kZXJlclwiIHwgXCJtYWluXCIgfCBcImJvdGhcIjtcblxuLyoqXG4gKiBMaWZlY3ljbGUgc3RhdGVzIGFyZSBkZWxpYmVyYXRlbHkgbW9yZSBkZXRhaWxlZCB0aGFuIHRoZSB1c2VyLWZhY2luZ1xuICogaW5zdGFsbGVkL2VuYWJsZWQgc3RhdHVzLiAgQSB0d2VhayBtYXkgYmUgdmlzaWJsZSBhcyBlbmFibGVkIHdoaWxlIGl0c1xuICogYXN5bmNocm9ub3VzIHN0YXJ0IGlzIHN0aWxsIGluIGZsaWdodCwgb3IgYXMgZmFpbGVkIGFmdGVyIGFub3RoZXIgdHdlYWtcbiAqIGhhcyBhbHJlYWR5IHJlYWNoZWQgcmVhZHkuXG4gKi9cbmV4cG9ydCBjb25zdCBUV0VBS19MSUZFQ1lDTEVfU1RBVFVTRVMgPSBbXG4gIFwic3RhcnRpbmdcIixcbiAgXCJyZWFkeVwiLFxuICBcImZhaWxlZFwiLFxuICBcInRpbWVkX291dFwiLFxuICBcImRpc2FibGVkXCIsXG4gIFwicXVhcmFudGluZWRcIixcbl0gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBUd2Vha0xpZmVjeWNsZVN0YXR1cyA9ICh0eXBlb2YgVFdFQUtfTElGRUNZQ0xFX1NUQVRVU0VTKVtudW1iZXJdO1xuZXhwb3J0IHR5cGUgVHdlYWtQcm9jZXNzID0gXCJtYWluXCIgfCBcInJlbmRlcmVyXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVSZWNvcmQge1xuICBpZDogc3RyaW5nO1xuICBwcm9jZXNzOiBUd2Vha1Byb2Nlc3M7XG4gIHN0YXR1czogVHdlYWtMaWZlY3ljbGVTdGF0dXM7XG4gIGF0dGVtcHRJZDogc3RyaW5nO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbiAgc3RhcnRlZEF0Pzogc3RyaW5nO1xuICBmaW5pc2hlZEF0Pzogc3RyaW5nO1xuICBlcnJvcj86IHN0cmluZztcbiAgLyoqIENvbnNlY3V0aXZlIHN0YXJ0dXAgYXR0ZW1wdHMgY3V0IHNob3J0IGJ5IGEgcHJvY2VzcyBleGl0OyByZXNldCBieSBhIHN1Y2Nlc3NmdWwgcmVhZHkuICovXG4gIGludGVycnVwdGVkQXR0ZW1wdHM/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVBdHRlbXB0IHtcbiAgaWQ6IHN0cmluZztcbiAgcGlkPzogbnVtYmVyO1xuICBzdGFydGVkQXQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgY3VycmVudEF0dGVtcHQ6IFR3ZWFrTGlmZWN5Y2xlQXR0ZW1wdCB8IG51bGw7XG4gIHJlY29yZHM6IFJlY29yZDxzdHJpbmcsIFR3ZWFrTGlmZWN5Y2xlUmVjb3JkPjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVR3ZWFrTGlmZWN5Y2xlSm91cm5hbChcbiAgYXR0ZW1wdElkID0gYGF0dGVtcHQtJHtEYXRlLm5vdygpfS0ke01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIpfWAsXG4gIHBpZD86IG51bWJlcixcbiAgc3RhcnRlZEF0ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuKTogVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIGN1cnJlbnRBdHRlbXB0OiB7IGlkOiBhdHRlbXB0SWQsIHBpZCwgc3RhcnRlZEF0IH0sXG4gICAgcmVjb3Jkczoge30sXG4gIH07XG59XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyA9IDVfMDAwO1xuZXhwb3J0IGNvbnN0IE1JTl9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSAxMDA7XG5leHBvcnQgY29uc3QgTUFYX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyA9IDMwXzAwMDtcblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVR3ZWFrU3RhcnR1cFRpbWVvdXRNcyh2YWx1ZTogdW5rbm93bik6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc0Zpbml0ZSh2YWx1ZSkpIHtcbiAgICByZXR1cm4gREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVM7XG4gIH1cbiAgcmV0dXJuIE1hdGgubWluKFxuICAgIE1BWF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4gICAgTWF0aC5tYXgoTUlOX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUywgTWF0aC5yb3VuZCh2YWx1ZSkpLFxuICApO1xufVxuXG4vKipcbiAqIFJhY2UgYSB0d2VhaydzIHN0YXJ0dXAgcHJvbWlzZSBhZ2FpbnN0IGEgYm91bmRlZCB0aW1lb3V0LiAgVGhlIG9yaWdpbmFsXG4gKiBwcm9taXNlIGlzIG9ic2VydmVkIGFmdGVyIHRoZSB0aW1lb3V0IHNvIGEgbGF0ZSByZWplY3Rpb24gY2Fubm90IGJlY29tZSBhblxuICogdW5oYW5kbGVkIHJlamVjdGlvbiwgd2hpbGUgdGhlIGNhbGxlciBpcyBmcmVlIHRvIGNvbnRpbnVlIGxvYWRpbmcgc2libGluZ1xuICogdHdlYWtzIGltbWVkaWF0ZWx5LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd2l0aFN0YXJ0dXBUaW1lb3V0PFQ+KFxuICB2YWx1ZTogUHJvbWlzZUxpa2U8VD4gfCBULFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx7IHN0YXR1czogXCJyZWFkeVwiOyB2YWx1ZTogVCB9IHwgeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4ge1xuICBjb25zdCBub3JtYWxpemVkVGltZW91dE1zID0gbm9ybWFsaXplVHdlYWtTdGFydHVwVGltZW91dE1zKHRpbWVvdXRNcyk7XG4gIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHByb21pc2UgPSBQcm9taXNlLnJlc29sdmUodmFsdWUpO1xuICBjb25zdCB0aW1lb3V0ID0gbmV3IFByb21pc2U8eyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4oKHJlc29sdmUpID0+IHtcbiAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSh7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9KSwgbm9ybWFsaXplZFRpbWVvdXRNcyk7XG4gIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgICBwcm9taXNlLnRoZW4oKHJlc29sdmVkKSA9PiAoeyBzdGF0dXM6IFwicmVhZHlcIiBhcyBjb25zdCwgdmFsdWU6IHJlc29sdmVkIH0pKSxcbiAgICAgIHRpbWVvdXQsXG4gICAgXSk7XG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgLy8gQXR0YWNoIGEgcmVqZWN0aW9uIG9ic2VydmVyIGV2ZW4gd2hlbiB0aW1lb3V0IHdvbi4gIFRoaXMgaW50ZW50aW9uYWxseVxuICAgIC8vIGRvZXMgbm90IGF3YWl0IHRoZSBsYXRlIHJlc3VsdC5cbiAgICB2b2lkIHByb21pc2UuY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgfVxufVxuXG4vKiogQ29udmVuaWVuY2UgZm9ybSBmb3IgY2FsbGVycyB0aGF0IGhhdmUgYSBsYXp5IHN0YXJ0IG9wZXJhdGlvbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBydW5XaXRoU3RhcnR1cFRpbWVvdXQ8VD4oXG4gIHN0YXJ0OiAoKSA9PiBQcm9taXNlTGlrZTxUPiB8IFQsXG4gIHRpbWVvdXRNczogbnVtYmVyID0gREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBcInJlYWR5XCI7IHZhbHVlOiBUIH0gfCB7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9PiB7XG4gIGxldCB2YWx1ZTogUHJvbWlzZUxpa2U8VD4gfCBUO1xuICB0cnkge1xuICAgIHZhbHVlID0gc3RhcnQoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoZXJyb3IpO1xuICB9XG4gIHJldHVybiB3aXRoU3RhcnR1cFRpbWVvdXQodmFsdWUsIHRpbWVvdXRNcyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsaWZlY3ljbGVSZWNvcmRLZXkocHJvY2VzczogVHdlYWtQcm9jZXNzLCBpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Byb2Nlc3N9OiR7aWR9YDtcbn1cblxuLyoqXG4gKiBCaW5kIGEgbWFpbi1wcm9jZXNzIHR3ZWFrJ3MgYHN0b3AoKWAgdG8gdGhlIHR3ZWFrIG9iamVjdCBzbyBjbGVhbnVwIHRoYXRcbiAqIHJlbGllcyBvbiBgdGhpc2AgKHBlci1pbnN0YW5jZSBkaXNwb3NlcnMsIElQQyBoYW5kbGUgcmVtb3ZlcnMpIHdvcmtzLiBUaGVcbiAqIHJlbmRlcmVyIGhvc3QgYmluZHMgc3RvcCB0aGUgc2FtZSB3YXkgKHByZWxvYWQvdHdlYWstaG9zdC50cyk7IHRoZSBtYWluXG4gKiBydW50aW1lIGhpc3RvcmljYWxseSBzdG9yZWQgaXQgdW5ib3VuZCwgc2lsZW50bHkgYnJlYWtpbmcgYHRoaXNgLWJhc2VkIG1haW5cbiAqIGNsZWFudXAgZm9yIGBzY29wZTogXCJib3RoXCJgIHR3ZWFrcyAoZm9sbG93dXApLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmluZE1haW5Ud2Vha1N0b3A8VCBleHRlbmRzIHsgc3RvcD86ICguLi5hcmdzOiB1bmtub3duW10pID0+IHVua25vd24gfT4oXG4gIHR3ZWFrOiBUIHwgbnVsbCB8IHVuZGVmaW5lZCxcbik6IFRbXCJzdG9wXCJdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCF0d2VhayB8fCB0eXBlb2YgdHdlYWsuc3RvcCAhPT0gXCJmdW5jdGlvblwiKSByZXR1cm4gdHdlYWs/LnN0b3A7XG4gIHJldHVybiB0d2Vhay5zdG9wLmJpbmQodHdlYWspIGFzIFRbXCJzdG9wXCJdO1xufVxuXG4vKipcbiAqIEEgd2hvbGUtYXBwIHJlc3RhcnQgcmFjaW5nIHRoZSBzZXF1ZW50aWFsIHR3ZWFrLWxvYWQgbG9vcCBsZWF2ZXMgaW5ub2NlbnRcbiAqIHR3ZWFrcyBpbiBcInN0YXJ0aW5nXCI7IG9ubHkgcmVwZWF0ZWQgaW50ZXJydXB0aW9ucyBpbmRpY2F0ZSB0aGUgdHdlYWsgaXRzZWxmXG4gKiBpcyBoYW5naW5nIHN0YXJ0dXAuIE9uZSBpbnRlcnJ1cHRpb24gaXMgdGhlcmVmb3JlIHJldHJpZWQsIG5vdCBxdWFyYW50aW5lZC5cbiAqL1xuZXhwb3J0IGNvbnN0IElOVEVSUlVQVEVEX0FUVEVNUFRTX0JFRk9SRV9RVUFSQU5USU5FID0gMjtcblxuLyoqXG4gKiBUdXJuIGEgam91cm5hbCBmcm9tIGEgcHJldmlvdXMgcHJvY2VzcyBpbnRvIGV4cGxpY2l0IHJlY29yZHMuIE9ubHkgcmVjb3Jkc1xuICogZnJvbSB0aGUgdW5maW5pc2hlZCBjdXJyZW50IGF0dGVtcHQgYXJlIGNoYW5nZWQ7IGhpc3RvcmljYWwgcmVhZHkvZmFpbGVkXG4gKiByZWNvcmRzIHJlbWFpbiBhdmFpbGFibGUgZm9yIGRpYWdub3N0aWNzLiBBIGZpcnN0IGludGVycnVwdGlvbiBiZWNvbWVzIGFcbiAqIHJldHJ5YWJsZSBcImZhaWxlZFwiOyBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORSBjb25zZWN1dGl2ZVxuICogaW50ZXJydXB0aW9ucyBxdWFyYW50aW5lIHRoZSB0d2Vhay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY292ZXJJbnRlcnJ1cHRlZFR3ZWFrcyhcbiAgam91cm5hbDogVHdlYWtMaWZlY3ljbGVKb3VybmFsLFxuICBub3cgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4pOiBUd2Vha0xpZmVjeWNsZUpvdXJuYWwge1xuICBjb25zdCBjdXJyZW50QXR0ZW1wdCA9IGpvdXJuYWwuY3VycmVudEF0dGVtcHQ7XG4gIGlmICghY3VycmVudEF0dGVtcHQgfHwgY3VycmVudEF0dGVtcHQuY29tcGxldGVkQXQpIHJldHVybiBqb3VybmFsO1xuICBjb25zdCByZWNvcmRzID0geyAuLi5qb3VybmFsLnJlY29yZHMgfTtcbiAgZm9yIChjb25zdCBba2V5LCByZWNvcmRdIG9mIE9iamVjdC5lbnRyaWVzKHJlY29yZHMpKSB7XG4gICAgaWYgKHJlY29yZC5hdHRlbXB0SWQgIT09IGN1cnJlbnRBdHRlbXB0LmlkKSBjb250aW51ZTtcbiAgICBpZiAocmVjb3JkLnN0YXR1cyAhPT0gXCJzdGFydGluZ1wiKSBjb250aW51ZTtcbiAgICBjb25zdCBpbnRlcnJ1cHRlZEF0dGVtcHRzID0gKHJlY29yZC5pbnRlcnJ1cHRlZEF0dGVtcHRzID8/IDApICsgMTtcbiAgICBjb25zdCBxdWFyYW50aW5lID0gaW50ZXJydXB0ZWRBdHRlbXB0cyA+PSBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORTtcbiAgICByZWNvcmRzW2tleV0gPSB7XG4gICAgICAuLi5yZWNvcmQsXG4gICAgICBzdGF0dXM6IHF1YXJhbnRpbmUgPyBcInF1YXJhbnRpbmVkXCIgOiBcImZhaWxlZFwiLFxuICAgICAgaW50ZXJydXB0ZWRBdHRlbXB0cyxcbiAgICAgIHVwZGF0ZWRBdDogbm93LFxuICAgICAgZmluaXNoZWRBdDogbm93LFxuICAgICAgZXJyb3I6IHJlY29yZC5lcnJvciA/PyAocXVhcmFudGluZVxuICAgICAgICA/IGBzdGFydHVwIHdhcyBpbnRlcnJ1cHRlZCAke2ludGVycnVwdGVkQXR0ZW1wdHN9IHRpbWVzIGluIGEgcm93YFxuICAgICAgICA6IFwicHJldmlvdXMgc3RhcnR1cCBhdHRlbXB0IHdhcyBpbnRlcnJ1cHRlZDsgd2lsbCByZXRyeVwiKSxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7IC4uLmpvdXJuYWwsIGN1cnJlbnRBdHRlbXB0OiB7IC4uLmN1cnJlbnRBdHRlbXB0LCBjb21wbGV0ZWRBdDogbm93IH0sIHJlY29yZHMgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBSZWxvYWRUd2Vha3NEZXBzIHtcbiAgbG9nSW5mbyhtZXNzYWdlOiBzdHJpbmcpOiB2b2lkO1xuICBzdG9wQWxsTWFpblR3ZWFrcygpOiB2b2lkO1xuICBjbGVhclR3ZWFrTW9kdWxlQ2FjaGUoKTogdm9pZDtcbiAgbG9hZEFsbE1haW5Ud2Vha3MoKTogdm9pZCB8IFByb21pc2U8dm9pZD47XG4gIGJyb2FkY2FzdFJlbG9hZCgpOiB2b2lkO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldFR3ZWFrRW5hYmxlZEFuZFJlbG9hZERlcHMgZXh0ZW5kcyBSZWxvYWRUd2Vha3NEZXBzIHtcbiAgc2V0VHdlYWtFbmFibGVkKGlkOiBzdHJpbmcsIGVuYWJsZWQ6IGJvb2xlYW4pOiB2b2lkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNNYWluUHJvY2Vzc1R3ZWFrU2NvcGUoc2NvcGU6IFR3ZWFrU2NvcGUgfCB1bmRlZmluZWQpOiBib29sZWFuIHtcbiAgcmV0dXJuIHNjb3BlICE9PSBcInJlbmRlcmVyXCI7XG59XG5cbmxldCByZWxvYWRTZXF1ZW5jZTogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG5leHBvcnQgZnVuY3Rpb24gbG9hZFR3ZWFrc0luaXRpYWxseShcbiAgZGVwczogUGljazxSZWxvYWRUd2Vha3NEZXBzLCBcImxvYWRBbGxNYWluVHdlYWtzXCI+LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1biA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBhd2FpdCBkZXBzLmxvYWRBbGxNYWluVHdlYWtzKCk7XG4gIH07XG4gIGNvbnN0IG9wZXJhdGlvbiA9IHJlbG9hZFNlcXVlbmNlLnRoZW4ocnVuLCBydW4pO1xuICByZWxvYWRTZXF1ZW5jZSA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gIHJldHVybiBvcGVyYXRpb247XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZWxvYWRUd2Vha3MocmVhc29uOiBzdHJpbmcsIGRlcHM6IFJlbG9hZFR3ZWFrc0RlcHMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcnVuID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGRlcHMubG9nSW5mbyhgcmVsb2FkaW5nIHR3ZWFrcyAoJHtyZWFzb259KWApO1xuICAgIGRlcHMuc3RvcEFsbE1haW5Ud2Vha3MoKTtcbiAgICBkZXBzLmNsZWFyVHdlYWtNb2R1bGVDYWNoZSgpO1xuICAgIGF3YWl0IGRlcHMubG9hZEFsbE1haW5Ud2Vha3MoKTtcbiAgICBkZXBzLmJyb2FkY2FzdFJlbG9hZCgpO1xuICB9O1xuICBjb25zdCBvcGVyYXRpb24gPSByZWxvYWRTZXF1ZW5jZS50aGVuKHJ1biwgcnVuKTtcbiAgcmVsb2FkU2VxdWVuY2UgPSBvcGVyYXRpb24uY2F0Y2goKCkgPT4ge30pO1xuICByZXR1cm4gb3BlcmF0aW9uO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0VHdlYWtFbmFibGVkQW5kUmVsb2FkKFxuICBpZDogc3RyaW5nLFxuICBlbmFibGVkOiB1bmtub3duLFxuICBkZXBzOiBTZXRUd2Vha0VuYWJsZWRBbmRSZWxvYWREZXBzLFxuKTogUHJvbWlzZTx0cnVlPiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRFbmFibGVkID0gISFlbmFibGVkO1xuICBkZXBzLnNldFR3ZWFrRW5hYmxlZChpZCwgbm9ybWFsaXplZEVuYWJsZWQpO1xuICBkZXBzLmxvZ0luZm8oYHR3ZWFrICR7aWR9IGVuYWJsZWQ9JHtub3JtYWxpemVkRW5hYmxlZH1gKTtcbiAgYXdhaXQgcmVsb2FkVHdlYWtzKFwiZW5hYmxlZC10b2dnbGVcIiwgZGVwcyk7XG4gIHJldHVybiB0cnVlO1xufVxuIiwgImV4cG9ydCBpbnRlcmZhY2UgU3RvcmFnZUxpa2Uge1xuICByZWFkb25seSBsZW5ndGg6IG51bWJlcjtcbiAgZ2V0SXRlbShrZXk6IHN0cmluZyk6IHN0cmluZyB8IG51bGw7XG4gIGtleShpbmRleDogbnVtYmVyKTogc3RyaW5nIHwgbnVsbDtcbiAgc2V0SXRlbShrZXk6IHN0cmluZywgdmFsdWU6IHN0cmluZyk6IHZvaWQ7XG4gIHJlbW92ZUl0ZW0oa2V5OiBzdHJpbmcpOiB2b2lkO1xufVxuXG5jb25zdCBDVVJSRU5UX0lEX1BSRUZJWCA9IFwiY28udHdlYWtlcnMuXCI7XG5jb25zdCBMRUdBQ1lfU1RPUkFHRV9QUkVGSVggPSBgJHtbXCJjb2RleFwiLCBcInBwXCJdLmpvaW4oXCJcIil9OnN0b3JhZ2U6YDtcbmNvbnN0IENVUlJFTlRfU1RPUkFHRV9QUkVGSVggPSBcInR3ZWFrZXI6c3RvcmFnZTpcIjtcblxuZnVuY3Rpb24gcGFyc2VSZWNvcmQocmF3OiBzdHJpbmcgfCBudWxsKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsIHtcbiAgaWYgKHJhdyA9PT0gbnVsbCkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcGFyc2VkID0gSlNPTi5wYXJzZShyYXcpIGFzIHVua25vd247XG4gICAgcmV0dXJuIHBhcnNlZCAhPT0gbnVsbCAmJiB0eXBlb2YgcGFyc2VkID09PSBcIm9iamVjdFwiICYmICFBcnJheS5pc0FycmF5KHBhcnNlZClcbiAgICAgID8gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgICA6IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5KGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmICghaWQuc3RhcnRzV2l0aChDVVJSRU5UX0lEX1BSRUZJWCkpIHJldHVybiBudWxsO1xuICBjb25zdCBzdWZmaXggPSBpZC5zbGljZShDVVJSRU5UX0lEX1BSRUZJWC5sZW5ndGgpO1xuICBpZiAoIXN1ZmZpeCkgcmV0dXJuIG51bGw7XG5cbiAgY29uc3Qgc3VmZml4TWFya2VyID0gYC4ke3N1ZmZpeH1gO1xuICBjb25zdCBjYW5kaWRhdGVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBzdG9yYWdlLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IGtleSA9IHN0b3JhZ2Uua2V5KGluZGV4KTtcbiAgICBpZiAoIWtleT8uc3RhcnRzV2l0aChMRUdBQ1lfU1RPUkFHRV9QUkVGSVgpKSBjb250aW51ZTtcbiAgICBjb25zdCBsZWdhY3lJZCA9IGtleS5zbGljZShMRUdBQ1lfU1RPUkFHRV9QUkVGSVgubGVuZ3RoKTtcbiAgICBpZiAoXG4gICAgICBsZWdhY3lJZCAhPT0gaWRcbiAgICAgICYmIGxlZ2FjeUlkLnN0YXJ0c1dpdGgoXCJjby5cIilcbiAgICAgICYmIGxlZ2FjeUlkLmVuZHNXaXRoKHN1ZmZpeE1hcmtlcilcbiAgICAgICYmIGxlZ2FjeUlkLnNsaWNlKDMsIC1zdWZmaXhNYXJrZXIubGVuZ3RoKS5sZW5ndGggPiAwXG4gICAgKSB7XG4gICAgICBjYW5kaWRhdGVzLmFkZChrZXkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlcy5zaXplID09PSAxID8gWy4uLmNhbmRpZGF0ZXNdWzBdIDogbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVJlbmRlcmVyU3RvcmFnZShpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSkge1xuICBjb25zdCBrZXkgPSBgJHtDVVJSRU5UX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3QgbGVnYWN5Q3VycmVudElkS2V5ID0gYCR7TEVHQUNZX1NUT1JBR0VfUFJFRklYfSR7aWR9YDtcbiAgY29uc3QgcmVhZCA9ICgpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9PiB7XG4gICAgY29uc3QgY3VycmVudCA9IHBhcnNlUmVjb3JkKHN0b3JhZ2UuZ2V0SXRlbShrZXkpKTtcbiAgICBjb25zdCBsZWdhY3lDdXJyZW50SWQgPSBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0obGVnYWN5Q3VycmVudElkS2V5KSk7XG4gICAgY29uc3QgbGVnYWN5UHVibGlzaGVyS2V5ID0gZGlzY292ZXJMZWdhY3lQdWJsaXNoZXJLZXkoaWQsIHN0b3JhZ2UpO1xuICAgIGNvbnN0IGxlZ2FjeVB1Ymxpc2hlciA9IGxlZ2FjeVB1Ymxpc2hlcktleSA9PT0gbnVsbFxuICAgICAgPyBudWxsXG4gICAgICA6IHBhcnNlUmVjb3JkKHN0b3JhZ2UuZ2V0SXRlbShsZWdhY3lQdWJsaXNoZXJLZXkpKTtcblxuICAgIGNvbnN0IGxlZ2FjeUtleXMgPSBbXG4gICAgICBsZWdhY3lDdXJyZW50SWQgPT09IG51bGwgPyBudWxsIDogbGVnYWN5Q3VycmVudElkS2V5LFxuICAgICAgbGVnYWN5UHVibGlzaGVyID09PSBudWxsID8gbnVsbCA6IGxlZ2FjeVB1Ymxpc2hlcktleSxcbiAgICBdLmZpbHRlcigoY2FuZGlkYXRlKTogY2FuZGlkYXRlIGlzIHN0cmluZyA9PiBjYW5kaWRhdGUgIT09IG51bGwpO1xuXG4gICAgaWYgKGxlZ2FjeUtleXMubGVuZ3RoID09PSAwKSByZXR1cm4gY3VycmVudCA/PyB7fTtcblxuICAgIGNvbnN0IG1lcmdlZCA9IHtcbiAgICAgIC4uLihsZWdhY3lQdWJsaXNoZXIgPz8ge30pLFxuICAgICAgLi4uKGxlZ2FjeUN1cnJlbnRJZCA/PyB7fSksXG4gICAgICAuLi4oY3VycmVudCA/PyB7fSksXG4gICAgfTtcbiAgICB0cnkge1xuICAgICAgc3RvcmFnZS5zZXRJdGVtKGtleSwgSlNPTi5zdHJpbmdpZnkobWVyZ2VkKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbWVyZ2VkO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGxlZ2FjeUtleSBvZiBsZWdhY3lLZXlzKSBzdG9yYWdlLnJlbW92ZUl0ZW0obGVnYWN5S2V5KTtcbiAgICByZXR1cm4gbWVyZ2VkO1xuICB9O1xuICBjb25zdCB3cml0ZSA9ICh2YWx1ZTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gIHJldHVybiB7XG4gICAgZ2V0OiA8VD4obmFtZTogc3RyaW5nLCBmYWxsYmFjaz86IFQpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICByZXR1cm4gbmFtZSBpbiBjdXJyZW50ID8gKGN1cnJlbnRbbmFtZV0gYXMgVCkgOiAoZmFsbGJhY2sgYXMgVCk7XG4gICAgfSxcbiAgICBzZXQ6IChuYW1lOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgY3VycmVudFtuYW1lXSA9IHZhbHVlO1xuICAgICAgd3JpdGUoY3VycmVudCk7XG4gICAgfSxcbiAgICBkZWxldGU6IChuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICBkZWxldGUgY3VycmVudFtuYW1lXTtcbiAgICAgIHdyaXRlKGN1cnJlbnQpO1xuICAgIH0sXG4gICAgYWxsOiAoKSA9PiByZWFkKCksXG4gIH07XG59XG4iLCAiLyoqXG4gKiBCdWlsdC1pbiBcIlR3ZWFrIE1hbmFnZXJcIiBcdTIwMTQgYXV0by1pbmplY3RlZCBieSB0aGUgcnVudGltZSwgbm90IGEgdXNlciB0d2Vhay5cbiAqIExpc3RzIGRpc2NvdmVyZWQgdHdlYWtzIHdpdGggZW5hYmxlIHRvZ2dsZXMsIG9wZW5zIHRoZSB0d2Vha3MgZGlyLCBsaW5rc1xuICogdG8gbG9ncyBhbmQgY29uZmlnLiBMaXZlcyBpbiB0aGUgcmVuZGVyZXIuXG4gKlxuICogVGhpcyBpcyBpbnZva2VkIGZyb20gcHJlbG9hZC9pbmRleC50cyBBRlRFUiB1c2VyIHR3ZWFrcyBhcmUgbG9hZGVkIHNvIGl0XG4gKiBjYW4gc2hvdyB1cC10by1kYXRlIHN0YXR1cy5cbiAqL1xuaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2VjdGlvbiB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBtb3VudE1hbmFnZXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmxpc3QtdHdlYWtzXCIpKSBhcyBBcnJheTx7XG4gICAgbWFuaWZlc3Q6IHsgaWQ6IHN0cmluZzsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmc7IGRlc2NyaXB0aW9uPzogc3RyaW5nIH07XG4gICAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIH0+O1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnVzZXItcGF0aHNcIikpIGFzIHtcbiAgICB1c2VyUm9vdDogc3RyaW5nO1xuICAgIHR3ZWFrc0Rpcjogc3RyaW5nO1xuICAgIGxvZ0Rpcjogc3RyaW5nO1xuICB9O1xuXG4gIHJlZ2lzdGVyU2VjdGlvbih7XG4gICAgaWQ6IFwidHdlYWtlcjptYW5hZ2VyXCIsXG4gICAgdGl0bGU6IFwiVHdlYWsgTWFuYWdlclwiLFxuICAgIGRlc2NyaXB0aW9uOiBgJHt0d2Vha3MubGVuZ3RofSB0d2VhayhzKSBpbnN0YWxsZWQuIFVzZXIgZGlyOiAke3BhdGhzLnVzZXJSb290fWAsXG4gICAgcmVuZGVyKHJvb3QpIHtcbiAgICAgIHJvb3Quc3R5bGUuY3NzVGV4dCA9IFwiZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6OHB4O1wiO1xuXG4gICAgICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGFjdGlvbnMuc3R5bGUuY3NzVGV4dCA9IFwiZGlzcGxheTpmbGV4O2dhcDo4cHg7ZmxleC13cmFwOndyYXA7XCI7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJPcGVuIHR3ZWFrcyBmb2xkZXJcIiwgKCkgPT5cbiAgICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJldmVhbFwiLCBwYXRocy50d2Vha3NEaXIpLmNhdGNoKCgpID0+IHt9KSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJPcGVuIGxvZ3NcIiwgKCkgPT5cbiAgICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJldmVhbFwiLCBwYXRocy5sb2dEaXIpLmNhdGNoKCgpID0+IHt9KSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgICBidXR0b24oXCJSZWxvYWQgd2luZG93XCIsICgpID0+IGxvY2F0aW9uLnJlbG9hZCgpKSxcbiAgICAgICk7XG4gICAgICByb290LmFwcGVuZENoaWxkKGFjdGlvbnMpO1xuXG4gICAgICBpZiAodHdlYWtzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICBjb25zdCBlbXB0eSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgICAgICBlbXB0eS5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTNweCBzeXN0ZW0tdWk7bWFyZ2luOjhweCAwO1wiO1xuICAgICAgICBlbXB0eS50ZXh0Q29udGVudCA9XG4gICAgICAgICAgXCJObyB1c2VyIHR3ZWFrcyB5ZXQuIERyb3AgYSBmb2xkZXIgd2l0aCBtYW5pZmVzdC5qc29uICsgaW5kZXguanMgaW50byB0aGUgdHdlYWtzIGRpciwgdGhlbiByZWxvYWQuXCI7XG4gICAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoZW1wdHkpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwidWxcIik7XG4gICAgICBsaXN0LnN0eWxlLmNzc1RleHQgPSBcImxpc3Qtc3R5bGU6bm9uZTttYXJnaW46MDtwYWRkaW5nOjA7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NnB4O1wiO1xuICAgICAgZm9yIChjb25zdCB0IG9mIHR3ZWFrcykge1xuICAgICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgICAgbGkuc3R5bGUuY3NzVGV4dCA9XG4gICAgICAgICAgXCJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6OHB4IDEwcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIsIzJhMmEyYSk7Ym9yZGVyLXJhZGl1czo2cHg7XCI7XG4gICAgICAgIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBsZWZ0LmlubmVySFRNTCA9IGBcbiAgICAgICAgICA8ZGl2IHN0eWxlPVwiZm9udDo2MDAgMTNweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5uYW1lKX0gPHNwYW4gc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQtd2VpZ2h0OjQwMDtcIj52JHtlc2NhcGUodC5tYW5pZmVzdC52ZXJzaW9uKX08L3NwYW4+PC9kaXY+XG4gICAgICAgICAgPGRpdiBzdHlsZT1cImNvbG9yOiM4ODg7Zm9udDoxMnB4IHN5c3RlbS11aTtcIj4ke2VzY2FwZSh0Lm1hbmlmZXN0LmRlc2NyaXB0aW9uID8/IHQubWFuaWZlc3QuaWQpfTwvZGl2PlxuICAgICAgICBgO1xuICAgICAgICBjb25zdCByaWdodCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIHJpZ2h0LnN0eWxlLmNzc1RleHQgPSBcImNvbG9yOiM4ODg7Zm9udDoxMnB4IHN5c3RlbS11aTtcIjtcbiAgICAgICAgcmlnaHQudGV4dENvbnRlbnQgPSB0LmVudHJ5RXhpc3RzID8gXCJsb2FkZWRcIiA6IFwibWlzc2luZyBlbnRyeVwiO1xuICAgICAgICBsaS5hcHBlbmQobGVmdCwgcmlnaHQpO1xuICAgICAgICBsaXN0LmFwcGVuZChsaSk7XG4gICAgICB9XG4gICAgICByb290LmFwcGVuZChsaXN0KTtcbiAgICB9LFxuICB9KTtcbn1cblxuZnVuY3Rpb24gYnV0dG9uKGxhYmVsOiBzdHJpbmcsIG9uY2xpY2s6ICgpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBiLnR5cGUgPSBcImJ1dHRvblwiO1xuICBiLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGIuc3R5bGUuY3NzVGV4dCA9XG4gICAgXCJwYWRkaW5nOjZweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMzMzMpO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6aW5oZXJpdDtmb250OjEycHggc3lzdGVtLXVpO2N1cnNvcjpwb2ludGVyO1wiO1xuICBiLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbmNsaWNrKTtcbiAgcmV0dXJuIGI7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZShzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcy5yZXBsYWNlKC9bJjw+XCInXS9nLCAoYykgPT5cbiAgICBjID09PSBcIiZcIlxuICAgICAgPyBcIiZhbXA7XCJcbiAgICAgIDogYyA9PT0gXCI8XCJcbiAgICAgICAgPyBcIiZsdDtcIlxuICAgICAgICA6IGMgPT09IFwiPlwiXG4gICAgICAgICAgPyBcIiZndDtcIlxuICAgICAgICAgIDogYyA9PT0gJ1wiJ1xuICAgICAgICAgICAgPyBcIiZxdW90O1wiXG4gICAgICAgICAgICA6IFwiJiMzOTtcIixcbiAgKTtcbn1cbiIsICJpbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHtcbiAgZGVza3RvcFVwZGF0ZUluZGljYXRvcklkZW50aXR5LFxuICBzaG91bGRTaG93RGVza3RvcFVwZGF0ZUluZGljYXRvcixcbiAgdHlwZSBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUsXG59IGZyb20gXCIuL2Rlc2t0b3AtdXBkYXRlLWluZGljYXRvci1zdGF0ZVwiO1xuXG5jb25zdCBVUERBVEVfQ0hBTkdFRF9DSEFOTkVMID0gXCJ0d2Vha2VyOmNvZGV4LWRlc2t0b3AtdXBkYXRlLWNoYW5nZWRcIjtcbmNvbnN0IElORElDQVRPUl9BVFRSSUJVVEUgPSBcImRhdGEtdHdlYWtlci1kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3JcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGZpbmREZXNrdG9wVXBkYXRlRm9vdGVyTW91bnQocm9vdDogUGFyZW50Tm9kZSA9IGRvY3VtZW50KTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3QgYW5jaG9ycyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIlthcmlhLWxhYmVsXVwiKSk7XG4gIGZvciAoY29uc3QgYW5jaG9yIG9mIGFuY2hvcnMpIHtcbiAgICBjb25zdCBsYWJlbCA9IGFuY2hvci5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpPy50cmltKCkudG9Mb3dlckNhc2UoKSA/PyBcIlwiO1xuICAgIGlmICghLyhzZXR0aW5nc3xhY2NvdW50fHByb2ZpbGV8aGVscCkvLnRlc3QobGFiZWwpKSBjb250aW51ZTtcbiAgICBsZXQgY2FuZGlkYXRlOiBIVE1MRWxlbWVudCB8IG51bGwgPSBhbmNob3I7XG4gICAgZm9yIChsZXQgZGVwdGggPSAwOyBjYW5kaWRhdGUgJiYgZGVwdGggPCA2OyBkZXB0aCArPSAxKSB7XG4gICAgICBjb25zdCByb2xlID0gY2FuZGlkYXRlLmdldEF0dHJpYnV0ZShcInJvbGVcIik7XG4gICAgICBpZiAoY2FuZGlkYXRlLm1hdGNoZXMoXCJuYXYsIGFzaWRlLCBmb290ZXJcIikgfHwgcm9sZSA9PT0gXCJuYXZpZ2F0aW9uXCIgfHwgcm9sZSA9PT0gXCJjb250ZW50aW5mb1wiKSB7XG4gICAgICAgIHJldHVybiBjYW5kaWRhdGU7XG4gICAgICB9XG4gICAgICBjYW5kaWRhdGUgPSBjYW5kaWRhdGUucGFyZW50RWxlbWVudDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydERlc2t0b3BVcGRhdGVJbmRpY2F0b3IoKTogKCkgPT4gdm9pZCB7XG4gIGxldCBjdXJyZW50OiBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUgfCBudWxsID0gbnVsbDtcbiAgbGV0IGluZGljYXRvcjogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdhcm5pbmdUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgd2FybmVkSWRlbnRpdGllcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0IHJlbW92ZUluZGljYXRvciA9ICgpOiB2b2lkID0+IHtcbiAgICBpbmRpY2F0b3I/LnJlbW92ZSgpO1xuICAgIGluZGljYXRvciA9IG51bGw7XG4gICAgaWYgKHdhcm5pbmdUaW1lcikgY2xlYXJUaW1lb3V0KHdhcm5pbmdUaW1lcik7XG4gICAgd2FybmluZ1RpbWVyID0gbnVsbDtcbiAgfTtcblxuICBjb25zdCBzY2hlZHVsZU1pc3NpbmdNb3VudFdhcm5pbmcgPSAoaWRlbnRpdHk6IHN0cmluZyk6IHZvaWQgPT4ge1xuICAgIGlmICh3YXJuaW5nVGltZXIgfHwgd2FybmVkSWRlbnRpdGllcy5oYXMoaWRlbnRpdHkpKSByZXR1cm47XG4gICAgd2FybmluZ1RpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB3YXJuaW5nVGltZXIgPSBudWxsO1xuICAgICAgaWYgKCFjdXJyZW50IHx8ICFzaG91bGRTaG93RGVza3RvcFVwZGF0ZUluZGljYXRvcihjdXJyZW50KSkgcmV0dXJuO1xuICAgICAgaWYgKGRlc2t0b3BVcGRhdGVJbmRpY2F0b3JJZGVudGl0eShjdXJyZW50KSAhPT0gaWRlbnRpdHkgfHwgZmluZERlc2t0b3BVcGRhdGVGb290ZXJNb3VudCgpKSByZXR1cm47XG4gICAgICB3YXJuZWRJZGVudGl0aWVzLmFkZChpZGVudGl0eSk7XG4gICAgICBjb25zb2xlLndhcm4oYFt0d2Vha2VyXSBDaGF0R1BUIHVwZGF0ZSAke2lkZW50aXR5fSBpcyBhdmFpbGFibGUsIGJ1dCBubyBzZW1hbnRpYyBzaWRlYmFyIGZvb3RlciBtb3VudCBwb2ludCB3YXMgZm91bmQuYCk7XG4gICAgfSwgM18wMDApO1xuICB9O1xuXG4gIGNvbnN0IHJlbmRlciA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIXNob3VsZFNob3dEZXNrdG9wVXBkYXRlSW5kaWNhdG9yKGN1cnJlbnQpKSB7XG4gICAgICByZW1vdmVJbmRpY2F0b3IoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgY29uc3QgaWRlbnRpdHkgPSBkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHkoY3VycmVudCEpO1xuICAgIGNvbnN0IG1vdW50ID0gZmluZERlc2t0b3BVcGRhdGVGb290ZXJNb3VudCgpO1xuICAgIGlmICghbW91bnQpIHtcbiAgICAgIGluZGljYXRvcj8ucmVtb3ZlKCk7XG4gICAgICBpbmRpY2F0b3IgPSBudWxsO1xuICAgICAgc2NoZWR1bGVNaXNzaW5nTW91bnRXYXJuaW5nKGlkZW50aXR5KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKHdhcm5pbmdUaW1lcikgY2xlYXJUaW1lb3V0KHdhcm5pbmdUaW1lcik7XG4gICAgd2FybmluZ1RpbWVyID0gbnVsbDtcbiAgICBpZiAoIWluZGljYXRvcikge1xuICAgICAgaW5kaWNhdG9yID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICAgIGluZGljYXRvci50eXBlID0gXCJidXR0b25cIjtcbiAgICAgIGluZGljYXRvci5zZXRBdHRyaWJ1dGUoSU5ESUNBVE9SX0FUVFJJQlVURSwgXCJ0cnVlXCIpO1xuICAgICAgaW5kaWNhdG9yLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgXCJDaGF0R1BUIHVwZGF0ZSBhdmFpbGFibGVcIik7XG4gICAgICBpbmRpY2F0b3IudGV4dENvbnRlbnQgPSBcIlVwZGF0ZVwiO1xuICAgICAgT2JqZWN0LmFzc2lnbihpbmRpY2F0b3Iuc3R5bGUsIHtcbiAgICAgICAgYXBwZWFyYW5jZTogXCJub25lXCIsXG4gICAgICAgIGJvcmRlcjogXCIxcHggc29saWQgY29sb3ItbWl4KGluIHNyZ2IsIGN1cnJlbnRDb2xvciAyNCUsIHRyYW5zcGFyZW50KVwiLFxuICAgICAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgICAgIGJhY2tncm91bmQ6IFwiY29sb3ItbWl4KGluIHNyZ2IsIGN1cnJlbnRDb2xvciAxMCUsIHRyYW5zcGFyZW50KVwiLFxuICAgICAgICBjb2xvcjogXCJpbmhlcml0XCIsXG4gICAgICAgIGN1cnNvcjogXCJwb2ludGVyXCIsXG4gICAgICAgIGZvbnQ6IFwiaW5oZXJpdFwiLFxuICAgICAgICBmb250U2l6ZTogXCIxMnB4XCIsXG4gICAgICAgIGZvbnRXZWlnaHQ6IFwiNjAwXCIsXG4gICAgICAgIG1hcmdpbjogXCI2cHggMTBweFwiLFxuICAgICAgICBwYWRkaW5nOiBcIjVweCAxMHB4XCIsXG4gICAgICB9KTtcbiAgICAgIGluZGljYXRvci5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgICBpbmRpY2F0b3IhLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgICAgaWYgKGluZGljYXRvcj8uaXNDb25uZWN0ZWQpIGluZGljYXRvci5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICAgIGluZGljYXRvci50aXRsZSA9IGBDaGF0R1BUICR7Y3VycmVudD8ubGF0ZXN0Py5tYXJrZXRpbmdWZXJzaW9uID8/IFwidXBkYXRlXCJ9IGlzIGF2YWlsYWJsZWA7XG4gICAgaWYgKGluZGljYXRvci5wYXJlbnRFbGVtZW50ICE9PSBtb3VudCkgbW91bnQuYXBwZW5kQ2hpbGQoaW5kaWNhdG9yKTtcbiAgfTtcblxuICBjb25zdCBvbkNoYW5nZWQgPSAoX2V2ZW50OiB1bmtub3duLCB2YWx1ZTogdW5rbm93bik6IHZvaWQgPT4ge1xuICAgIGN1cnJlbnQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgPyB2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUgOiBudWxsO1xuICAgIHJlbmRlcigpO1xuICB9O1xuICBpcGNSZW5kZXJlci5vbihVUERBVEVfQ0hBTkdFRF9DSEFOTkVMLCBvbkNoYW5nZWQpO1xuXG4gIGNvbnN0IG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIocmVuZGVyKTtcbiAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgLnRoZW4oKHZhbHVlKSA9PiBvbkNoYW5nZWQodW5kZWZpbmVkLCB2YWx1ZSkpXG4gICAgLmNhdGNoKCgpID0+IHt9KTtcblxuICByZXR1cm4gKCkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFVQREFURV9DSEFOR0VEX0NIQU5ORUwsIG9uQ2hhbmdlZCk7XG4gICAgb2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgIHJlbW92ZUluZGljYXRvcigpO1xuICB9O1xufVxuIiwgImV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIHtcbiAgc3RhdHVzPzogc3RyaW5nO1xuICBsYXRlc3Q/OiB7IG1hcmtldGluZ1ZlcnNpb24/OiBzdHJpbmcgfCBudWxsOyBidWlsZD86IHN0cmluZyB8IG51bGwgfTtcbiAgbmF0aXZlVXBkYXRlQ29udHJvbEFjdGl2ZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRTaG93RGVza3RvcFVwZGF0ZUluZGljYXRvcihzdGF0ZTogRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIHwgbnVsbCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc3RhdGU/LnN0YXR1cyA9PT0gXCJ1cGRhdGUtYXZhaWxhYmxlXCIgJiYgc3RhdGUubmF0aXZlVXBkYXRlQ29udHJvbEFjdGl2ZSAhPT0gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVJbmRpY2F0b3JJZGVudGl0eShzdGF0ZTogRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlKTogc3RyaW5nIHtcbiAgcmV0dXJuIFtzdGF0ZS5sYXRlc3Q/Lm1hcmtldGluZ1ZlcnNpb24gPz8gXCJ1bmtub3duXCIsIHN0YXRlLmxhdGVzdD8uYnVpbGQgPz8gXCJ1bmtub3duXCJdLmpvaW4oXCI6XCIpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBV0EsSUFBQUEsbUJBQTRCOzs7QUM2QnJCLFNBQVMsbUJBQXlCO0FBQ3ZDLE1BQUksT0FBTywrQkFBZ0M7QUFDM0MsUUFBTSxZQUFZLG9CQUFJLElBQStCO0FBQ3JELE1BQUksU0FBUztBQUNiLFFBQU1DLGFBQVksb0JBQUksSUFBNEM7QUFFbEUsUUFBTSxPQUEwQjtBQUFBLElBQzlCLGVBQWU7QUFBQSxJQUNmO0FBQUEsSUFDQSxPQUFPLFVBQVU7QUFDZixZQUFNLEtBQUs7QUFDWCxnQkFBVSxJQUFJLElBQUksUUFBUTtBQUUxQixjQUFRO0FBQUEsUUFDTjtBQUFBLFFBQ0EsU0FBUztBQUFBLFFBQ1QsU0FBUztBQUFBLE1BQ1g7QUFDQSxhQUFPO0FBQUEsSUFDVDtBQUFBLElBQ0EsR0FBRyxPQUFPLElBQUk7QUFDWixVQUFJLElBQUlBLFdBQVUsSUFBSSxLQUFLO0FBQzNCLFVBQUksQ0FBQyxFQUFHLENBQUFBLFdBQVUsSUFBSSxPQUFRLElBQUksb0JBQUksSUFBSSxDQUFFO0FBQzVDLFFBQUUsSUFBSSxFQUFFO0FBQUEsSUFDVjtBQUFBLElBQ0EsSUFBSSxPQUFPLElBQUk7QUFDYixNQUFBQSxXQUFVLElBQUksS0FBSyxHQUFHLE9BQU8sRUFBRTtBQUFBLElBQ2pDO0FBQUEsSUFDQSxL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LEVBQy9EO0FBQ0Esa0JBQWdCLElBQUksVUFBVSxRQUFRO0FBQ3RDLCtCQUFZLEdBQUcsNEJBQTRCLFFBQVEsR0FBRyxRQUFRO0FBQzlELFNBQU87QUFDVDtBQUVBLFNBQVMsbUNBQ1AsVUFDQSxpQkFDUztBQUNULFFBQU0sV0FBVyxnQkFBZ0IsSUFBSSxRQUFRO0FBQzdDLE1BQUksQ0FBQyxTQUFVLFFBQU87QUFDdEIsa0JBQWdCLE9BQU8sUUFBUTtBQUMvQiwrQkFBWSxlQUFlLDRCQUE0QixRQUFRLEdBQUcsUUFBUTtBQUMxRSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbImltcG9ydF9lbGVjdHJvbiIsICJsaXN0ZW5lcnMiLCAiYnV0dG9uIiwgImJ1dHRvbiIsICJyb290IiwgInNuYXBzaG90IiwgImNvbXBhY3QiLCAicmVzdWx0IiwgInN0YXRlIiwgInNuYXBzaG90IiwgImJ1dHRvbiIsICJzdGF0ZSIsICJjaGVjayIsICJidXR0b24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImltcG9ydF9lbGVjdHJvbiIsICJpbXBvcnRfZWxlY3Ryb24iLCAic3RhdGUiLCAic2FmZVN0cmluZ2lmeSJdCn0K
