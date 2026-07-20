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
function humanizeCodexPhase(value) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function desktopUpdatePresentation(input) {
  const { busy, status, transaction } = input;
  const phase = transaction?.phase ?? null;
  const resumable = transaction?.resumable === true;
  const inactive = phase === null || phase === "idle";
  const terminal = phase === "completed" || phase === "failed" || phase === "rolled_back";
  const unsafeFailure = phase === "failed" && transaction?.safeOfficialMode !== true;
  const blocksLifecycle = transaction?.blocksLifecycle ?? (!terminal || resumable || phase === "failed" && (transaction?.safeOfficialMode !== true || /\brollback failed\b/i.test(transaction?.error ?? "")));
  const retryableUnsafeRecovery = unsafeFailure && typeof transaction?.environmentTransactionId === "string";
  const actions = [];
  if (resumable && (phase === "failed" || phase === "rolled_back")) {
    actions.push({ kind: "resume", label: "Resume", disabled: busy });
  }
  if (phase === "awaiting_native_update" || resumable && (phase === "failed" || phase === "rolled_back") || retryableUnsafeRecovery) {
    actions.push({ kind: "cancel", label: "Cancel", disabled: busy });
  }
  return {
    phaseLabel: phase === null ? null : humanizeCodexPhase(phase),
    tone: phase === null ? null : phase === "completed" ? "ok" : phase === "failed" && !resumable ? "error" : "warn",
    actions,
    updateDisabled: busy || status !== "update-available" || !inactive && blocksLifecycle
  };
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
    const presentation = desktopUpdatePresentation({
      busy,
      status: result?.status,
      transaction
    });
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
    update.disabled = presentation.updateDisabled;
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
    if (transaction) card.appendChild(desktopUpdateTransactionRow(transaction, presentation, {
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
function desktopUpdateTransactionRow(transaction, presentation, actions) {
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
  if (presentation.tone && presentation.phaseLabel) {
    left?.prepend(statusBadge(presentation.tone, presentation.phaseLabel));
  }
  const controls = row.querySelector("[data-tweaker-row-actions]");
  for (const action of presentation.actions) {
    const handler = action.kind === "resume" ? actions.onResume : actions.onCancel;
    const button2 = compactButton(action.label, handler);
    button2.disabled = action.disabled;
    controls?.appendChild(button2);
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
  card.appendChild(codexVersionSurfaceOverview(snapshot2));
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
function codexVersionSurfaceOverview(snapshot2) {
  const stable = snapshot2.cli.bundled.release?.version ?? "Not checked";
  const prerelease = snapshot2.cli.beta.release?.version ?? "Not checked";
  const desktopPrerelease = snapshot2.cli.bundled.versionChannel === "prerelease" ? snapshot2.cli.bundled.version ?? "Not checked" : "Not included in this desktop release";
  const overview = document.createElement("div");
  overview.className = "grid grid-cols-1 gap-3 p-3 md:grid-cols-2";
  overview.dataset.tweakerCodexVersionOverview = "true";
  overview.append(
    codexVersionSurfaceSummary("Terminal", [
      ["Latest Release", stable],
      ["Latest Pre-Release", prerelease],
      ["Current", snapshot2.terminalCli.version ?? "Not installed"]
    ]),
    codexVersionSurfaceSummary("Desktop macOS", [
      ["Latest Release", stable],
      ["Latest Pre-Release", desktopPrerelease],
      ["Current", snapshot2.activeCli.version ?? "Unavailable"]
    ])
  );
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvdHdlYWstc3RvcmUudHMiLCAiLi4vc3JjL3ByZWxvYWQvc2V0dGluZ3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vha3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC9lbnZpcm9ubWVudC1jb25maWctY29udHJvbGxlci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL2hvc3Qtc3VyZmFjZXMudHMiLCAiLi4vc3JjL3R3ZWFrLWxpZmVjeWNsZS50cyIsICIuLi9zcmMvcmVuZGVyZXItc3RvcmFnZS50cyIsICIuLi9zcmMvcHJlbG9hZC9tYW5hZ2VyLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2Rlc2t0b3AtdXBkYXRlLWluZGljYXRvci50cyIsICIuLi9zcmMvcHJlbG9hZC9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVuZGVyZXIgcHJlbG9hZCBlbnRyeS4gUnVucyBpbiBhbiBpc29sYXRlZCB3b3JsZCBiZWZvcmUgQ29kZXgncyBwYWdlIEpTLlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqICAgMS4gSW5zdGFsbCBhIFJlYWN0IERldlRvb2xzLXNoYXBlZCBnbG9iYWwgaG9vayB0byBjYXB0dXJlIHRoZSByZW5kZXJlclxuICogICAgICByZWZlcmVuY2Ugd2hlbiBSZWFjdCBtb3VudHMuIFdlIHVzZSB0aGlzIGZvciBmaWJlciB3YWxraW5nLlxuICogICAyLiBBZnRlciBET01Db250ZW50TG9hZGVkLCBraWNrIG9mZiBzZXR0aW5ncy1pbmplY3Rpb24gbG9naWMuXG4gKiAgIDMuIERpc2NvdmVyIHJlbmRlcmVyLXNjb3BlZCB0d2Vha3MgKHZpYSBJUEMgdG8gbWFpbikgYW5kIHN0YXJ0IHRoZW0uXG4gKiAgIDQuIExpc3RlbiBmb3IgYHR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRgIGZyb20gbWFpbiAoZmlsZXN5c3RlbSB3YXRjaGVyKSBhbmRcbiAqICAgICAgaG90LXJlbG9hZCB0d2Vha3Mgd2l0aG91dCBkcm9wcGluZyB0aGUgcGFnZS5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgaW5zdGFsbFJlYWN0SG9vayB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB7IHN0YXJ0U2V0dGluZ3NJbmplY3RvciB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBzdGFydFR3ZWFrSG9zdCwgdGVhcmRvd25Ud2Vha0hvc3QgfSBmcm9tIFwiLi90d2Vhay1ob3N0XCI7XG5pbXBvcnQgeyBtb3VudE1hbmFnZXIgfSBmcm9tIFwiLi9tYW5hZ2VyXCI7XG5pbXBvcnQgeyBzdGFydERlc2t0b3BVcGRhdGVJbmRpY2F0b3IgfSBmcm9tIFwiLi9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3JcIjtcblxuY29uc3QgQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1jb25uZWN0LWFwcC1ob3N0XCI7XG5jb25zdCBCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNUID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlcXVlc3RcIjtcbmNvbnN0IEJST1dTRVJfVUlfQlJJREdFX1JFU1BPTlNFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlc3BvbnNlXCI7XG5jb25zdCBCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1tZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBCUk9XU0VSX1VJX1dPUktFUl9NRVNTQUdFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktd29ya2VyLW1lc3NhZ2VcIjtcbmNvbnN0IEJST1dTRVJfVUlfU1lTVEVNX1RIRU1FID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktc3lzdGVtLXRoZW1lXCI7XG5cbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GT1JfVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQ09OVEVYVF9NRU5VID0gXCJjb2RleF9kZXNrdG9wOnNob3ctY29udGV4dC1tZW51XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQVBQTElDQVRJT05fTUVOVSA9IFwiY29kZXhfZGVza3RvcDpzaG93LWFwcGxpY2F0aW9uLW1lbnVcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXNlbnRyeS1pbml0LW9wdGlvbnNcIjtcbmNvbnN0IERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUiA9IFwiY29kZXhfZGVza3RvcDpnZXQtYnVpbGQtZmxhdm9yXCI7XG5jb25zdCBERVNLVE9QX0dFVF9VU0VTX09XTF9BUFBfU0hFTEwgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXVzZXMtb3dsLWFwcC1zaGVsbFwiO1xuY29uc3QgREVTS1RPUF9HRVRfU1lTVEVNX1RIRU1FX1ZBUklBTlQgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXN5c3RlbS10aGVtZS12YXJpYW50XCI7XG5jb25zdCBERVNLVE9QX0dFVF9TSEFSRURfT0JKRUNUX1NOQVBTSE9UID0gXCJjb2RleF9kZXNrdG9wOmdldC1zaGFyZWQtb2JqZWN0LXNuYXBzaG90XCI7XG5jb25zdCBERVNLVE9QX0dFVF9GQVNUX01PREVfUk9MTE9VVF9NRVRSSUNTID0gXCJjb2RleF9kZXNrdG9wOmdldC1mYXN0LW1vZGUtcm9sbG91dC1tZXRyaWNzXCI7XG5jb25zdCBERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVEID0gXCJjb2RleF9kZXNrdG9wOnN5c3RlbS10aGVtZS12YXJpYW50LXVwZGF0ZWRcIjtcbmNvbnN0IERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCA9IFwiY29kZXhfZGVza3RvcDp0cmlnZ2VyLXNlbnRyeS10ZXN0XCI7XG5cbmZ1bmN0aW9uIGRlc2t0b3BXb3JrZXJGcm9tVmlld0NoYW5uZWwod29ya2VySWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgY29kZXhfZGVza3RvcDp3b3JrZXI6JHt3b3JrZXJJZH06ZnJvbS12aWV3YDtcbn1cblxuZnVuY3Rpb24gZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYGNvZGV4X2Rlc2t0b3A6d29ya2VyOiR7d29ya2VySWR9OmZvci12aWV3YDtcbn1cblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW3R3ZWFrZXIgcHJlbG9hZF0gJHtzdGFnZX0ke1xuICAgIGV4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKVxuICB9YDtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLCBcImluZm9cIiwgbXNnKTtcbiAgfSBjYXRjaCB7fVxufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuZmlsZUxvZyhcInByZWxvYWQgZW50cnlcIiwgeyB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG5cbnRyeSB7XG4gIGluc3RhbGxCcm93c2VyVWlIb3N0QnJpZGdlKCk7XG4gIGZpbGVMb2coXCJicm93c2VyIFVJIGhvc3QgYnJpZGdlIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcImJyb3dzZXIgVUkgaG9zdCBicmlkZ2UgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbi8vIFJlYWN0IGhvb2sgbXVzdCBiZSBpbnN0YWxsZWQgKmJlZm9yZSogQ29kZXgncyBidW5kbGUgcnVucy5cbnRyeSB7XG4gIGluc3RhbGxSZWFjdEhvb2soKTtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxucXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBib290LCB7IG9uY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgYm9vdCgpO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHtcbiAgZmlsZUxvZyhcImJvb3Qgc3RhcnRcIiwgeyByZWFkeVN0YXRlOiBkb2N1bWVudC5yZWFkeVN0YXRlIH0pO1xuICB0cnkge1xuICAgIHN0YXJ0RGVza3RvcFVwZGF0ZUluZGljYXRvcigpO1xuICAgIGZpbGVMb2coXCJkZXNrdG9wIHVwZGF0ZSBpbmRpY2F0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBwcmVsb2FkIGJvb3QgZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBIb3QgcmVsb2FkOiBnYXRlZCBiZWhpbmQgYSBzbWFsbCBpbi1mbGlnaHQgbG9jayBzbyBhIGZsdXJyeSBvZiBmcyBldmVudHNcbi8vIGRvZXNuJ3QgcmVlbnRyYW50bHkgdGVhciBkb3duIHRoZSBob3N0IG1pZC1sb2FkLlxubGV0IHJlbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gc3Vic2NyaWJlUmVsb2FkKCk6IHZvaWQge1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRcIiwgKCkgPT4ge1xuICAgIGlmIChyZWxvYWRpbmcpIHJldHVybjtcbiAgICByZWxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW3R3ZWFrZXJdIGhvdC1yZWxvYWRpbmcgdHdlYWtzXCIpO1xuICAgICAgICB0ZWFyZG93blR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsQnJvd3NlclVpSG9zdEJyaWRnZSgpOiB2b2lkIHtcbiAgY29uc3Qgd29ya2VyTGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+KCk7XG5cbiAgaXBjUmVuZGVyZXIub24oQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQsIChldmVudCkgPT4ge1xuICAgIGNvbnN0IFtwb3J0XSA9IGV2ZW50LnBvcnRzO1xuICAgIGlmICghcG9ydCkgcmV0dXJuO1xuICAgIHdpbmRvdy5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY29ubmVjdC1hcHAtaG9zdFwiLCBwb3J0IH0sIFwiKlwiLCBbcG9ydF0pO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNULCBhc3luYyAoX2V2ZW50LCBwYXlsb2FkKSA9PiB7XG4gICAgY29uc3QgcmVxdWVzdCA9IHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09IFwib2JqZWN0XCJcbiAgICAgID8gcGF5bG9hZCBhcyB7IGlkPzogdW5rbm93bjsgbWV0aG9kPzogdW5rbm93bjsgYXJncz86IHVua25vd24gfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiByZXF1ZXN0LmlkID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5pZCA6IFwiXCI7XG4gICAgY29uc3QgbWV0aG9kID0gdHlwZW9mIHJlcXVlc3QubWV0aG9kID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5tZXRob2QgOiBcIlwiO1xuICAgIGNvbnN0IGFyZ3MgPSBBcnJheS5pc0FycmF5KHJlcXVlc3QuYXJncykgPyByZXF1ZXN0LmFyZ3MgOiBbXTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBydW5Ccm93c2VyVWlCcmlkZ2VNZXRob2QobWV0aG9kLCBhcmdzLCB3b3JrZXJMaXN0ZW5lcnMpO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX0JSSURHRV9SRVNQT05TRSwgeyBpZCwgb2s6IHRydWUsIHZhbHVlIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9CUklER0VfUkVTUE9OU0UsIHtcbiAgICAgICAgaWQsXG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXBjUmVuZGVyZXIub24oREVTS1RPUF9NRVNTQUdFX0ZPUl9WSUVXLCAoX2V2ZW50LCBtZXNzYWdlKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcsIG1lc3NhZ2UpO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVELCAoX2V2ZW50LCB2YWx1ZSkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9TWVNURU1fVEhFTUUsIHZhbHVlKTtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkJyb3dzZXJVaUJyaWRnZU1ldGhvZChcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIGFyZ3M6IHVua25vd25bXSxcbiAgd29ya2VyTGlzdGVuZXJzOiBNYXA8c3RyaW5nLCAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJzbmFwc2hvdFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NIQVJFRF9PQkpFQ1RfU05BUFNIT1QpID8/IHt9O1xuICAgIGNhc2UgXCJzeXN0ZW1UaGVtZVwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NZU1RFTV9USEVNRV9WQVJJQU5UKTtcbiAgICBjYXNlIFwic2VudHJ5T3B0aW9uc1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMpO1xuICAgIGNhc2UgXCJidWlsZEZsYXZvclwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUik7XG4gICAgY2FzZSBcInVzZXNPd2xBcHBTaGVsbFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1VTRVNfT1dMX0FQUF9TSEVMTCkgPT09IHRydWU7XG4gICAgY2FzZSBcInNlbmRNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9NRVNTQUdFX0ZST01fVklFVywgYXJnc1swXSk7XG4gICAgY2FzZSBcInNlbmRXb3JrZXJNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoZGVza3RvcFdvcmtlckZyb21WaWV3Q2hhbm5lbChTdHJpbmcoYXJnc1swXSkpLCBhcmdzWzFdKTtcbiAgICBjYXNlIFwic3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiBzdWJzY3JpYmVCcm93c2VyVWlXb3JrZXJNZXNzYWdlcyhTdHJpbmcoYXJnc1swXSksIHdvcmtlckxpc3RlbmVycyk7XG4gICAgY2FzZSBcInVuc3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFN0cmluZyhhcmdzWzBdKSwgd29ya2VyTGlzdGVuZXJzKTtcbiAgICBjYXNlIFwic2hvd0NvbnRleHRNZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19DT05URVhUX01FTlUsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJzaG93QXBwbGljYXRpb25NZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19BUFBMSUNBVElPTl9NRU5VLCB7XG4gICAgICAgIG1lbnVJZDogYXJnc1swXSxcbiAgICAgICAgeDogYXJnc1sxXSxcbiAgICAgICAgeTogYXJnc1syXSxcbiAgICAgIH0pO1xuICAgIGNhc2UgXCJnZXRGYXN0TW9kZVJvbGxvdXRNZXRyaWNzXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfR0VUX0ZBU1RfTU9ERV9ST0xMT1VUX01FVFJJQ1MsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJ0cmlnZ2VyU2VudHJ5VGVzdEVycm9yXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBUd2Vha2VycyBicm93c2VyIFVJIGJyaWRnZSBtZXRob2Q6ICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGlmICghL15bYS16QS1aMC05Ll86LV0rJC8udGVzdCh3b3JrZXJJZCkpIHRocm93IG5ldyBFcnJvcihcImludmFsaWQgd29ya2VyIGlkXCIpO1xuICBpZiAod29ya2VyTGlzdGVuZXJzLmhhcyh3b3JrZXJJZCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsaXN0ZW5lciA9IChfZXZlbnQ6IHVua25vd24sIG1lc3NhZ2U6IHVua25vd24pID0+IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfV09SS0VSX01FU1NBR0UsIHdvcmtlcklkLCBtZXNzYWdlKTtcbiAgfTtcbiAgd29ya2VyTGlzdGVuZXJzLnNldCh3b3JrZXJJZCwgbGlzdGVuZXIpO1xuICBpcGNSZW5kZXJlci5vbihkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQpLCBsaXN0ZW5lcik7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxpc3RlbmVyID0gd29ya2VyTGlzdGVuZXJzLmdldCh3b3JrZXJJZCk7XG4gIGlmICghbGlzdGVuZXIpIHJldHVybiB0cnVlO1xuICB3b3JrZXJMaXN0ZW5lcnMuZGVsZXRlKHdvcmtlcklkKTtcbiAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkKSwgbGlzdGVuZXIpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICIvKipcbiAqIEluc3RhbGwgYSBtaW5pbWFsIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXy4gUmVhY3QgY2FsbHNcbiAqIGBob29rLmluamVjdChyZW5kZXJlckludGVybmFscylgIGR1cmluZyBgY3JlYXRlUm9vdGAvYGh5ZHJhdGVSb290YC4gVGhlXG4gKiBcImludGVybmFsc1wiIG9iamVjdCBleHBvc2VzIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlLCB3aGljaCBsZXRzIHVzIHR1cm4gYVxuICogRE9NIG5vZGUgaW50byBhIFJlYWN0IGZpYmVyIFx1MjAxNCBuZWNlc3NhcnkgZm9yIG91ciBTZXR0aW5ncyBpbmplY3Rvci5cbiAqXG4gKiBXZSBkb24ndCB3YW50IHRvIGJyZWFrIHJlYWwgUmVhY3QgRGV2VG9vbHMgaWYgdGhlIHVzZXIgb3BlbnMgaXQ7IHdlIGluc3RhbGxcbiAqIG9ubHkgaWYgbm8gaG9vayBleGlzdHMgeWV0LCBhbmQgd2UgZm9yd2FyZCBjYWxscyB0byBhIGRvd25zdHJlYW0gaG9vayBpZlxuICogb25lIGlzIGxhdGVyIGFzc2lnbmVkLlxuICovXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXz86IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgIF9fdHdlYWtlcl9fPzoge1xuICAgICAgaG9vazogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgICB9O1xuICB9XG59XG5cbmludGVyZmFjZSBSZW5kZXJlckludGVybmFscyB7XG4gIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPzogKG46IE5vZGUpID0+IHVua25vd247XG4gIHZlcnNpb24/OiBzdHJpbmc7XG4gIGJ1bmRsZVR5cGU/OiBudW1iZXI7XG4gIHJlbmRlcmVyUGFja2FnZU5hbWU/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWFjdERldnRvb2xzSG9vayB7XG4gIHN1cHBvcnRzRmliZXI6IHRydWU7XG4gIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICBvbihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIG9mZihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIGVtaXQoZXZlbnQ6IHN0cmluZywgLi4uYTogdW5rbm93bltdKTogdm9pZDtcbiAgaW5qZWN0KHJlbmRlcmVyOiBSZW5kZXJlckludGVybmFscyk6IG51bWJlcjtcbiAgb25TY2hlZHVsZUZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJVbm1vdW50PygpOiB2b2lkO1xuICBjaGVja0RDRT8oKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSZWFjdEhvb2soKTogdm9pZCB7XG4gIGlmICh3aW5kb3cuX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fKSByZXR1cm47XG4gIGNvbnN0IHJlbmRlcmVycyA9IG5ldyBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz4oKTtcbiAgbGV0IG5leHRJZCA9IDE7XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8KC4uLmE6IHVua25vd25bXSkgPT4gdm9pZD4+KCk7XG5cbiAgY29uc3QgaG9vazogUmVhY3REZXZ0b29sc0hvb2sgPSB7XG4gICAgc3VwcG9ydHNGaWJlcjogdHJ1ZSxcbiAgICByZW5kZXJlcnMsXG4gICAgaW5qZWN0KHJlbmRlcmVyKSB7XG4gICAgICBjb25zdCBpZCA9IG5leHRJZCsrO1xuICAgICAgcmVuZGVyZXJzLnNldChpZCwgcmVuZGVyZXIpO1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICAgIFwiW3R3ZWFrZXJdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX190d2Vha2VyX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX190d2Vha2VyX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2tzIG9uIHRoZSBzaGVsbCBzbyB3ZSBpZGVudGlmeSB0aGUgc2lkZWJhciBieSB0ZXh0LWNvbnRlbnRcbiAqIG1hdGNoIGFnYWluc3Qga25vd24gaXRlbSBsYWJlbHMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIENvbmZpZ3VyYXRpb24sIFx1MjAyNikuXG4gKlxuICogTGF5b3V0IHdlIGluamVjdDpcbiAqXG4gKiAgIEdFTkVSQUwgICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFtDb2RleCdzIGV4aXN0aW5nIGl0ZW1zIGdyb3VwXVxuICogICBUV0VBS0VSUyAgICAgICAgICAgICAgICAgICAgICAodXBwZXJjYXNlIGdyb3VwIGxhYmVsKVxuICogICBcdTI0RDggQ29uZmlnXG4gKiAgIFx1MjYzMCBUd2Vha3NcbiAqICAgXHUyNUM3IFR3ZWFrIFN0b3JlXG4gKlxuICogQ2xpY2tpbmcgQ29uZmlnIC8gVHdlYWtzIC8gVHdlYWsgU3RvcmUgaGlkZXMgQ29kZXgncyBjb250ZW50IHBhbmVsIGNoaWxkcmVuIGFuZCByZW5kZXJzXG4gKiBvdXIgb3duIGBtYWluLXN1cmZhY2VgIHBhbmVsIGluIHRoZWlyIHBsYWNlLiBDbGlja2luZyBhbnkgb2YgQ29kZXgnc1xuICogc2lkZWJhciBpdGVtcyByZXN0b3JlcyB0aGUgb3JpZ2luYWwgdmlldy5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHR5cGUge1xuICBTZXR0aW5nc1NlY3Rpb24sXG4gIFNldHRpbmdzUGFnZSxcbiAgU2V0dGluZ3NIYW5kbGUsXG4gIFR3ZWFrTWFuaWZlc3QsXG59IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB7XG4gIGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwsXG4gIHR5cGUgVHdlYWtIZWFsdGhSZWNvcmQsXG4gIHR5cGUgVHdlYWtTdGF0dXMsXG4gIHR5cGUgVHdlYWtTdG9yZUVudHJ5LFxuICB0eXBlIFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbixcbn0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5pbXBvcnQge1xuICBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsLFxuICB0eXBlIFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0sXG59IGZyb20gXCIuL3NldHRpbmdzLXBhZ2UtbW9kZWxcIjtcbmltcG9ydCB7XG4gIGZpbHRlclR3ZWFrc1BhZ2VJdGVtcyxcbiAgVFdFQUtTX1BBR0VfRklMVEVSUyxcbiAgdHdlYWtzUGFnZUNvdW50cyxcbiAgdHlwZSBUd2Vha3NQYWdlRmlsdGVyLFxufSBmcm9tIFwiLi90d2Vha3MtcGFnZS1tb2RlbFwiO1xuaW1wb3J0IHtcbiAgQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yLFxuICBjcmVhdGVFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXIsXG4gIGRlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24sXG4gIGRlc2t0b3BVcGRhdGVTdGF0dXNQcmVzZW50YXRpb24sXG4gIGh1bWFuaXplQ29kZXhQaGFzZSxcbiAgcmVzdG9yZUVudmlyb25tZW50Rm9jdXMsXG4gIHR5cGUgRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbixcbiAgdHlwZSBFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uLFxufSBmcm9tIFwiLi9lbnZpcm9ubWVudC1jb25maWctY29udHJvbGxlclwiO1xuaW1wb3J0IHR5cGUge1xuICBDb2RleENsaUxhbmUsXG4gIENvZGV4Q2xpVmVyc2lvblN0YXRlLFxuICBDb2RleEZlYXR1cmVFbnRyeSxcbiAgQ29kZXhGZWF0dXJlU3RhZ2UsXG4gIENvZGV4SW5zdGFsbFByb2dyZXNzLFxuICBDb2RleFZlcnNpb25zU25hcHNob3QsXG59IGZyb20gXCIuLi9jb2RleC12ZXJzaW9uLXR5cGVzXCI7XG5cbmNvbnN0IFRXRUFLRVJTX1JFTEVBU0VTX1VSTCA9IFwiaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvcmVsZWFzZXNcIjtcblxuLy8gTWlycm9ycyB0aGUgcnVudGltZSdzIG1haW4tc2lkZSBMaXN0ZWRUd2VhayBzaGFwZSAoa2VwdCBpbiBzeW5jIG1hbnVhbGx5KS5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgaGVhbHRoOiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG4gIGNhdGFsb2c6IFR3ZWFrU3RvcmVFbnRyeSB8IG51bGw7XG4gIHVwZGF0ZTogVHdlYWtVcGRhdGVDaGVjayB8IG51bGw7XG4gIGxpZmVjeWNsZU92ZXJyaWRlPzogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtcImxpZmVjeWNsZVwiXTtcbn1cblxuaW50ZXJmYWNlIFR3ZWFrVXBkYXRlQ2hlY2sge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgcmVwbzogc3RyaW5nO1xuICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICBsYXRlc3RUYWc6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBUd2Vha2VyQ29uZmlnIHtcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBhdXRvVXBkYXRlOiBib29sZWFuO1xuICB1cGRhdGVDaGFubmVsOiBTZWxmVXBkYXRlQ2hhbm5lbDtcbiAgdXBkYXRlUmVwbzogc3RyaW5nO1xuICB1cGRhdGVSZWY6IHN0cmluZztcbiAgdXBkYXRlQ2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayB8IG51bGw7XG4gIHNlbGZVcGRhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGw7XG4gIGluc3RhbGxhdGlvblNvdXJjZTogSW5zdGFsbGF0aW9uU291cmNlO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtlclVwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VOb3Rlczogc3RyaW5nIHwgbnVsbDtcbiAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxudHlwZSBTZWxmVXBkYXRlQ2hhbm5lbCA9IFwic3RhYmxlXCIgfCBcInByZXJlbGVhc2VcIiB8IFwiY3VzdG9tXCI7XG50eXBlIFNlbGZVcGRhdGVTdGF0dXMgPSBcImNoZWNraW5nXCIgfCBcInVwLXRvLWRhdGVcIiB8IFwidXBkYXRlZFwiIHwgXCJmYWlsZWRcIiB8IFwiZGlzYWJsZWRcIjtcblxuaW50ZXJmYWNlIFNlbGZVcGRhdGVTdGF0ZSB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBjb21wbGV0ZWRBdD86IHN0cmluZztcbiAgc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzO1xuICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB0YXJnZXRSZWY6IHN0cmluZyB8IG51bGw7XG4gIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gIHJlcG86IHN0cmluZztcbiAgY2hhbm5lbDogU2VsZlVwZGF0ZUNoYW5uZWw7XG4gIHNvdXJjZVJvb3Q6IHN0cmluZztcbiAgaW5zdGFsbGF0aW9uU291cmNlPzogSW5zdGFsbGF0aW9uU291cmNlO1xuICBlcnJvcj86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEluc3RhbGxhdGlvblNvdXJjZSB7XG4gIGtpbmQ6IFwiZ2l0aHViLXNvdXJjZVwiIHwgXCJob21lYnJld1wiIHwgXCJsb2NhbC1kZXZcIiB8IFwic291cmNlLWFyY2hpdmVcIiB8IFwidW5rbm93blwiO1xuICBsYWJlbDogc3RyaW5nO1xuICBkZXRhaWw6IHN0cmluZztcbn1cblxudHlwZSBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UgPSBcImNoYXRncHRcIiB8IFwidHdlYWtlcnNcIjtcbnR5cGUgRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSA9IFwic3RhYmxlXCIgfCBcImFscGhhXCI7XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFNlbGVjdGlvbiB7XG4gIGFwcEV4cGVyaWVuY2U6IEVudmlyb25tZW50QXBwRXhwZXJpZW5jZTtcbiAgcmVsZWFzZVByb2ZpbGU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGU7XG4gIHNlbGVjdGVkRGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gIHNlbGVjdGVkRGVza3RvcEJ1bmRsZUlkPzogc3RyaW5nO1xuICBiYWNrZW5kTGFuZT86IHN0cmluZztcbiAgcmVxdWVzdGVkQXQ/OiBzdHJpbmc7XG4gIGFwcGxpZWRBdD86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudENoYW5uZWxTdGF0dXMge1xuICBhdmFpbGFibGU6IGJvb2xlYW47XG4gIHVuYXZhaWxhYmxlUmVhc29ucz86IHN0cmluZ1tdO1xuICBhdmFpbGFiaWxpdHk/OiBSZWNvcmQ8RW52aXJvbm1lbnRBcHBFeHBlcmllbmNlLCB7XG4gICAgYXZhaWxhYmxlOiBib29sZWFuO1xuICAgIHVuYXZhaWxhYmxlUmVhc29ucz86IHN0cmluZ1tdO1xuICB9PjtcbiAgc2VsZWN0ZWREZXNrdG9wUGF0aD86IHN0cmluZztcbiAgc2VsZWN0ZWREZXNrdG9wQnVuZGxlSWQ/OiBzdHJpbmc7XG4gIHJlbGVhc2VQcm9maWxlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRTdGF0dXMge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICBzZWxlY3RlZDogRW52aXJvbm1lbnRTZWxlY3Rpb247XG4gIGNoYW5uZWxzOiBSZWNvcmQ8RW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSwgRW52aXJvbm1lbnRDaGFubmVsU3RhdHVzPjtcbiAgb2JzZXJ2YXRpb24/OiB7XG4gICAgYXBwRXhwZXJpZW5jZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlIHwgbnVsbDtcbiAgICBzZWxlY3Rpb25EcmlmdDogYm9vbGVhbjtcbiAgICBsaWZlY3ljbGVDb250ZW5kZWQ6IGJvb2xlYW47XG4gICAgY29tbWl0Sm91cm5hbFByZXNlbnQ6IGJvb2xlYW47XG4gICAgdHJhbnNpdGlvbkpvdXJuYWxQcmVzZW50OiBib29sZWFuO1xuICAgIGZyZXNobmVzczogXCJjdXJyZW50XCIgfCBcImNvbnRlbmRlZFwiO1xuICB9O1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uIHtcbiAga2luZD86IFwiZW52aXJvbm1lbnQtY29tbWl0LWhlbHBlclwiO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmc7XG4gIHBoYXNlOiBcInN1Ym1pdHRlZFwiIHwgXCJzdWJtaXQtZmFpbGVkXCI7XG4gIGVycm9yPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50SGVscGVyT3V0Y29tZSB7XG4gIHBoYXNlPzogXCJub3Qtc3RhcnRlZFwiIHwgXCJydW5uaW5nXCIgfCBcInN1Y2NlZWRlZFwiIHwgXCJmYWlsZWRcIjtcbiAgZXhpdENvZGU/OiBudW1iZXIgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudEhlbHBlclN0YXR1cyB7XG4gIHN1Ym1pc3Npb24/OiBFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24gfCBudWxsO1xuICBvdXRjb21lPzogRW52aXJvbm1lbnRIZWxwZXJPdXRjb21lIHwgbnVsbDtcbiAgc3Rkb3V0Pzogc3RyaW5nIHwgbnVsbDtcbiAgc3RkZXJyPzogc3RyaW5nIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50VHJhbnNhY3Rpb24ge1xuICBzY2hlbWFWZXJzaW9uPzogMTtcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nO1xuICBwaGFzZTogc3RyaW5nO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbiAgc291cmNlPzogRW52aXJvbm1lbnRTZWxlY3Rpb247XG4gIHJlcXVlc3RlZD86IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICBwcmVwYXJlZD86IHtcbiAgICBjYW5kaWRhdGU/OiB7XG4gICAgICBkZXNrdG9wUGF0aD86IHN0cmluZztcbiAgICAgIGJ1bmRsZUlkPzogc3RyaW5nO1xuICAgICAgdmVyc2lvbj86IHN0cmluZztcbiAgICAgIGJ1aWxkPzogc3RyaW5nO1xuICAgIH07XG4gICAgYmFja2VuZD86IHtcbiAgICAgIGxhbmU/OiBzdHJpbmc7XG4gICAgICBiaW5hcnlQYXRoPzogc3RyaW5nO1xuICAgICAgdmVyc2lvbj86IHN0cmluZztcbiAgICB9O1xuICAgIHJvbGxiYWNrPzoge1xuICAgICAgc2VsZWN0aW9uPzogRW52aXJvbm1lbnRTZWxlY3Rpb247XG4gICAgICBkZXNrdG9wUGF0aD86IHN0cmluZztcbiAgICAgIGJhY2tlbmRMYW5lPzogc3RyaW5nO1xuICAgIH07XG4gIH0gfCBudWxsO1xuICBoZWxwZXI/OiBFbnZpcm9ubWVudEhlbHBlclN0YXR1cyB8IG51bGw7XG4gIHVwZGF0ZWRBdD86IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIE1jcFN5bmNTdGF0ZSB7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgc3VtbWFyeT86IHN0cmluZztcbiAgY2hlY2tlZEF0Pzogc3RyaW5nO1xuICBjb21wbGV0ZWRBdD86IHN0cmluZztcbiAgZGVzaXJlZE5hbWVzPzogc3RyaW5nW107XG4gIGFwcGxpZWROYW1lcz86IHN0cmluZ1tdO1xuICBjb25mbGljdHM/OiBBcnJheTx7XG4gICAgbmFtZT86IHN0cmluZztcbiAgICBvYnNlcnZlZE5hbWU/OiBzdHJpbmc7XG4gICAgY2Fub25pY2FsTmFtZT86IHN0cmluZztcbiAgICBkZXRhaWw/OiBzdHJpbmc7XG4gICAgcmVhc29uPzogc3RyaW5nO1xuICB9PjtcbiAgcmVzdGFydFJlcXVpcmVkPzogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQge1xuICBzdGF0dXM/OiBcInVwZGF0ZS1hdmFpbGFibGVcIiB8IFwiY3VycmVudFwiIHwgXCJzdGFsZVwiIHwgXCJ1bmF2YWlsYWJsZVwiIHwgXCJlcnJvclwiO1xuICBwcm9maWxlPzogXCJzdGFibGVcIiB8IFwiYWxwaGFcIiB8IG51bGw7XG4gIGluc3RhbGxlZD86IHsgbWFya2V0aW5nVmVyc2lvbj86IHN0cmluZyB8IG51bGw7IGJ1aWxkPzogc3RyaW5nIHwgbnVsbCB9O1xuICBsYXRlc3Q/OiB7IG1hcmtldGluZ1ZlcnNpb24/OiBzdHJpbmcgfCBudWxsOyBidWlsZD86IHN0cmluZyB8IG51bGwgfTtcbiAgcmVhc29uPzogc3RyaW5nIHwgbnVsbDtcbiAgY2hlY2tlZEF0Pzogc3RyaW5nO1xuICB1cGRhdGVBbmRSZWxvYWRSZXF1ZXN0ZWQ/OiBib29sZWFuO1xuICBuYXRpdmVVcGRhdGVDb250cm9sQWN0aXZlPzogYm9vbGVhbjtcbiAgamF2YVNjcmlwdFVwZGF0ZXJNYW5hZ2VyQXZhaWxhYmxlPzogYm9vbGVhbjtcbiAgamF2YVNjcmlwdFVwZGF0ZXJNYW5hZ2VyUmVhc29uPzogc3RyaW5nIHwgbnVsbDtcbiAgc2V0dXBSZXF1aXJlZD86IFwicmVnaXN0ZXItYmV0YVwiIHwgXCJsYXVuY2gtYmV0YVwiIHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlIHtcbiAgc2NoZW1hVmVyc2lvbj86IDE7XG4gIGtpbmQ/OiBcImRlc2t0b3AtdXBkYXRlXCI7XG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZyB8IG51bGw7XG4gIHBoYXNlOiBzdHJpbmc7XG4gIG93bmVyUGlkPzogbnVtYmVyO1xuICBzYWZlT2ZmaWNpYWxNb2RlPzogYm9vbGVhbjtcbiAgcmVzdW1hYmxlPzogYm9vbGVhbjtcbiAgbmF0aXZlVXBkYXRlSGFuZG9mZkF0Pzogc3RyaW5nIHwgbnVsbDtcbiAgcmVmcmVzaFNvdXJjZT86IFwiZGV2ZWxvcG1lbnRcIiB8IFwic3RhYmxlXCIgfCBudWxsO1xuICBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSWQ/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZWRBdD86IHN0cmluZztcbiAgYmxvY2tzTGlmZWN5Y2xlPzogYm9vbGVhbjtcbn1cblxudHlwZSBDb2RleFVpUmVsb2FkID0gKG1vZGU/OiBcIm9wZXJhdGlvbi1zdGFydFwiIHwgXCJvcGVyYXRpb24tc3RvcFwiKSA9PiB2b2lkO1xuXG5pbnRlcmZhY2UgV2F0Y2hlckhlYWx0aCB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBzdGF0dXM6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiO1xuICB0aXRsZTogc3RyaW5nO1xuICBzdW1tYXJ5OiBzdHJpbmc7XG4gIHdhdGNoZXI6IHN0cmluZztcbiAgY2hlY2tzOiBXYXRjaGVySGVhbHRoQ2hlY2tbXTtcbiAgbGF0ZXN0Q29tcGxldGVkQ3ljbGU/OiBXYXRjaGVyQ3ljbGVSZWNlaXB0O1xufVxuXG5pbnRlcmZhY2UgV2F0Y2hlckN5Y2xlUmVjZWlwdCB7XG4gIGN5Y2xlSWQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ6IHN0cmluZztcbiAgb3V0Y29tZTogXCJjb21wbGV0ZWRcIiB8IFwiZmFpbGVkXCI7XG4gIHJlcGFpcjogeyBzdGF0dXM6IFwic3VjY2VlZGVkXCIgfCBcImZhaWxlZFwiIHwgXCJza2lwcGVkXCIgfCBcInBlbmRpbmdcIjsgZXJyb3I6IHN0cmluZyB8IG51bGwgfTtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGhDaGVjayB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgZ2VuZXJhdGVkQXQ/OiBzdHJpbmc7XG4gIHNvdXJjZVVybDogc3RyaW5nO1xuICBmZXRjaGVkQXQ6IHN0cmluZztcbiAgZW50cmllczogVHdlYWtTdG9yZUVudHJ5Vmlld1tdO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtTdG9yZUVudHJ5VmlldyBleHRlbmRzIFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGluc3RhbGxlZDoge1xuICAgIHZlcnNpb246IHN0cmluZztcbiAgICBlbmFibGVkOiBib29sZWFuO1xuICB9IHwgbnVsbDtcbiAgcGxhdGZvcm0/OiB7XG4gICAgY3VycmVudDogc3RyaW5nO1xuICAgIHN1cHBvcnRlZDogc3RyaW5nW10gfCBudWxsO1xuICAgIGNvbXBhdGlibGU6IGJvb2xlYW47XG4gICAgcmVhc29uOiBzdHJpbmcgfCBudWxsO1xuICB9O1xuICBydW50aW1lPzoge1xuICAgIGN1cnJlbnQ6IHN0cmluZztcbiAgICByZXF1aXJlZDogc3RyaW5nIHwgbnVsbDtcbiAgICBjb21wYXRpYmxlOiBib29sZWFuO1xuICAgIHJlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgfTtcbn1cblxuLyoqXG4gKiBBIHR3ZWFrLXJlZ2lzdGVyZWQgcGFnZS4gV2UgY2FycnkgdGhlIG93bmluZyB0d2VhaydzIG1hbmlmZXN0IHNvIHdlIGNhblxuICogcmVzb2x2ZSByZWxhdGl2ZSBpY29uVXJscyBhbmQgc2hvdyBhdXRob3JzaGlwIGluIHRoZSBwYWdlIGhlYWRlci5cbiAqL1xuaW50ZXJmYWNlIFJlZ2lzdGVyZWRQYWdlIHtcbiAgLyoqIEZ1bGx5LXF1YWxpZmllZCBpZDogYDx0d2Vha0lkPjo8cGFnZUlkPmAuICovXG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIHBhZ2U6IFNldHRpbmdzUGFnZTtcbiAgLyoqIFBlci1wYWdlIERPTSB0ZWFyZG93biByZXR1cm5lZCBieSBgcGFnZS5yZW5kZXJgLCBpZiBhbnkuICovXG4gIHRlYXJkb3duPzogKCgpID0+IHZvaWQpIHwgbnVsbDtcbiAgLyoqIFRoZSBpbmplY3RlZCBzaWRlYmFyIGJ1dHRvbiAoc28gd2UgY2FuIHVwZGF0ZSBpdHMgYWN0aXZlIHN0YXRlKS4gKi9cbiAgbmF2QnV0dG9uPzogSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAvKiogSWRlbnRpdHkgdG9rZW4gcHJldmVudHMgYW4gb2xkIGhhbmRsZSBmcm9tIHVucmVnaXN0ZXJpbmcgYSByZXBsYWNlbWVudC4gKi9cbiAgcmVnaXN0cmF0aW9uVG9rZW46IHN5bWJvbDtcbn1cblxuLyoqIFdoYXQgcGFnZSBpcyBjdXJyZW50bHkgc2VsZWN0ZWQgaW4gb3VyIGluamVjdGVkIG5hdi4gKi9cbnR5cGUgQWN0aXZlUGFnZSA9XG4gIHwgeyBraW5kOiBcImNvbmZpZ1wiIH1cbiAgfCB7IGtpbmQ6IFwic3RvcmVcIiB9XG4gIHwgeyBraW5kOiBcInR3ZWFrc1wiIH1cbiAgfCB7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiOyBpZDogc3RyaW5nIH07XG5cbmludGVyZmFjZSBJbmplY3RvclN0YXRlIHtcbiAgc2VjdGlvbnM6IE1hcDxzdHJpbmcsIFNldHRpbmdzU2VjdGlvbj47XG4gIHNlY3Rpb25Ub2tlbnM6IE1hcDxzdHJpbmcsIHN5bWJvbD47XG4gIHBhZ2VzOiBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkUGFnZT47XG4gIGxpc3RlZFR3ZWFrczogTGlzdGVkVHdlYWtbXTtcbiAgLyoqIE91dGVyIHdyYXBwZXIgdGhhdCBob2xkcyBDb2RleCdzIGl0ZW1zIGdyb3VwICsgb3VyIGluamVjdGVkIGdyb3Vwcy4gKi9cbiAgb3V0ZXJXcmFwcGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJHZW5lcmFsXCIgbGFiZWwgZm9yIENvZGV4J3MgbmF0aXZlIHNldHRpbmdzIGdyb3VwLiAqL1xuICBuYXRpdmVOYXZIZWFkZXI6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrZXJzXCIgbmF2IGdyb3VwIChDb25maWcvVHdlYWtzKS4gKi9cbiAgbmF2R3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgbmF2QnV0dG9uczogUGFydGlhbDxSZWNvcmQ8QnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50Pj4gfCBudWxsO1xuICAvKiogU2lkZWJhciB1cGRhdGUgcGlsbCBzaG93biBvbmx5IHdoZW4gR2l0SHViIGhhcyBhIG5ld2VyIFR3ZWFrZXJzIHJlbGVhc2UuICovXG4gIHR3ZWFrZXJVcGRhdGVCdXR0b246IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgLyoqIE91ciBcIlR3ZWFrc1wiIG5hdiBncm91cCAocGVyLXR3ZWFrIHBhZ2VzKS4gQ3JlYXRlZCBsYXppbHkuICovXG4gIHBhZ2VzR3JvdXA6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgcGFnZXNHcm91cEtleTogc3RyaW5nIHwgbnVsbDtcbiAgcGFnZU5hdkJ1dHRvbnM6IE1hcDxzdHJpbmcsIEhUTUxCdXR0b25FbGVtZW50PjtcbiAgcGFuZWxIb3N0OiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbDtcbiAgZmluZ2VycHJpbnQ6IHN0cmluZyB8IG51bGw7XG4gIHNpZGViYXJEdW1wZWQ6IGJvb2xlYW47XG4gIGFjdGl2ZVBhZ2U6IEFjdGl2ZVBhZ2UgfCBudWxsO1xuICBzaWRlYmFyUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBzaWRlYmFyUmVzdG9yZUhhbmRsZXI6ICgoZTogRXZlbnQpID0+IHZvaWQpIHwgbnVsbDtcbiAgc2V0dGluZ3NTdXJmYWNlVmlzaWJsZTogYm9vbGVhbjtcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGw7XG4gIHR3ZWFrU3RvcmU6IFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXcgfCBudWxsO1xuICB0d2Vha1N0b3JlUHJvbWlzZTogUHJvbWlzZTxUd2Vha1N0b3JlUmVnaXN0cnlWaWV3PiB8IG51bGw7XG4gIHR3ZWFrU3RvcmVFcnJvcjogdW5rbm93bjtcbiAgdHdlYWtzUGFnZUZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcjtcbiAgdHdlYWtzUGFnZVF1ZXJ5OiBzdHJpbmc7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBzZWN0aW9uVG9rZW5zOiBuZXcgTWFwKCksXG4gIHBhZ2VzOiBuZXcgTWFwKCksXG4gIGxpc3RlZFR3ZWFrczogW10sXG4gIG91dGVyV3JhcHBlcjogbnVsbCxcbiAgbmF0aXZlTmF2SGVhZGVyOiBudWxsLFxuICBuYXZHcm91cDogbnVsbCxcbiAgbmF2QnV0dG9uczogbnVsbCxcbiAgdHdlYWtlclVwZGF0ZUJ1dHRvbjogbnVsbCxcbiAgcGFnZXNHcm91cDogbnVsbCxcbiAgcGFnZXNHcm91cEtleTogbnVsbCxcbiAgcGFnZU5hdkJ1dHRvbnM6IG5ldyBNYXAoKSxcbiAgcGFuZWxIb3N0OiBudWxsLFxuICBvYnNlcnZlcjogbnVsbCxcbiAgZmluZ2VycHJpbnQ6IG51bGwsXG4gIHNpZGViYXJEdW1wZWQ6IGZhbHNlLFxuICBhY3RpdmVQYWdlOiBudWxsLFxuICBzaWRlYmFyUm9vdDogbnVsbCxcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiBudWxsLFxuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBmYWxzZSxcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBudWxsLFxuICB0d2Vha1N0b3JlOiBudWxsLFxuICB0d2Vha1N0b3JlUHJvbWlzZTogbnVsbCxcbiAgdHdlYWtTdG9yZUVycm9yOiBudWxsLFxuICB0d2Vha3NQYWdlRmlsdGVyOiBcImFsbFwiLFxuICB0d2Vha3NQYWdlUXVlcnk6IFwiXCIsXG59O1xuXG5sZXQgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gcGxvZyhtc2c6IHN0cmluZywgZXh0cmE/OiB1bmtub3duKTogdm9pZCB7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYFtzZXR0aW5ncy1pbmplY3Rvcl0gJHttc2d9JHtleHRyYSA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IFwiIFwiICsgc2FmZVN0cmluZ2lmeShleHRyYSl9YCxcbiAgKTtcbn1cbmZ1bmN0aW9uIHNhZmVTdHJpbmdpZnkodjogdW5rbm93bik6IHN0cmluZyB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHR5cGVvZiB2ID09PSBcInN0cmluZ1wiID8gdiA6IEpTT04uc3RyaW5naWZ5KHYpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gU3RyaW5nKHYpO1xuICB9XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBwdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFxuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnRTZXR0aW5nc0luamVjdG9yKCk6IHZvaWQge1xuICBpZiAoc3RhdGUub2JzZXJ2ZXIpIHJldHVybjtcblxuICBjb25zdCBvYnMgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gIH0pO1xuICBvYnMub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICBzdGF0ZS5vYnNlcnZlciA9IG9icztcblxuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcInBvcHN0YXRlXCIsIG9uTmF2KTtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJoYXNoY2hhbmdlXCIsIG9uTmF2KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uRG9jdW1lbnRDbGljaywgdHJ1ZSk7XG4gIGZvciAoY29uc3QgbSBvZiBbXCJwdXNoU3RhdGVcIiwgXCJyZXBsYWNlU3RhdGVcIl0gYXMgY29uc3QpIHtcbiAgICBjb25zdCBvcmlnID0gaGlzdG9yeVttXTtcbiAgICBoaXN0b3J5W21dID0gZnVuY3Rpb24gKHRoaXM6IEhpc3RvcnksIC4uLmFyZ3M6IFBhcmFtZXRlcnM8dHlwZW9mIG9yaWc+KSB7XG4gICAgICBjb25zdCByID0gb3JpZy5hcHBseSh0aGlzLCBhcmdzKTtcbiAgICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChgdHdlYWtlci0ke219YCkpO1xuICAgICAgcmV0dXJuIHI7XG4gICAgfSBhcyB0eXBlb2Ygb3JpZztcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihgdHdlYWtlci0ke219YCwgb25OYXYpO1xuICB9XG5cbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xuICBsZXQgdGlja3MgPSAwO1xuICBjb25zdCBpbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICB0aWNrcysrO1xuICAgIHRyeUluamVjdCgpO1xuICAgIG1heWJlRHVtcERvbSgpO1xuICAgIGlmICh0aWNrcyA+IDYwKSBjbGVhckludGVydmFsKGludGVydmFsKTtcbiAgfSwgNTAwKTtcbn1cblxuZnVuY3Rpb24gb25OYXYoKTogdm9pZCB7XG4gIHN0YXRlLmZpbmdlcnByaW50ID0gbnVsbDtcbiAgdHJ5SW5qZWN0KCk7XG4gIG1heWJlRHVtcERvbSgpO1xufVxuXG5mdW5jdGlvbiBvbkRvY3VtZW50Q2xpY2soZTogTW91c2VFdmVudCk6IHZvaWQge1xuICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBpbnN0YW5jZW9mIEVsZW1lbnQgPyBlLnRhcmdldCA6IG51bGw7XG4gIGNvbnN0IGNvbnRyb2wgPSB0YXJnZXQ/LmNsb3Nlc3QoXCJbcm9sZT0nbGluayddLGJ1dHRvbixhXCIpO1xuICBpZiAoIShjb250cm9sIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpKSByZXR1cm47XG4gIGlmIChjb21wYWN0U2V0dGluZ3NUZXh0KGNvbnRyb2wudGV4dENvbnRlbnQgfHwgXCJcIikgIT09IFwiQmFjayB0byBhcHBcIikgcmV0dXJuO1xuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcImJhY2stdG8tYXBwXCIpO1xuICB9LCAwKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2VjdGlvbihzZWN0aW9uOiBTZXR0aW5nc1NlY3Rpb24pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IHJlZ2lzdHJhdGlvblRva2VuID0gU3ltYm9sKHNlY3Rpb24uaWQpO1xuICBzdGF0ZS5zZWN0aW9ucy5zZXQoc2VjdGlvbi5pZCwgc2VjdGlvbik7XG4gIHN0YXRlLnNlY3Rpb25Ub2tlbnMuc2V0KHNlY3Rpb24uaWQsIHJlZ2lzdHJhdGlvblRva2VuKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG4gIHJldHVybiB7XG4gICAgdW5yZWdpc3RlcjogKCkgPT4ge1xuICAgICAgaWYgKHN0YXRlLnNlY3Rpb25Ub2tlbnMuZ2V0KHNlY3Rpb24uaWQpICE9PSByZWdpc3RyYXRpb25Ub2tlbikgcmV0dXJuO1xuICAgICAgc3RhdGUuc2VjdGlvbnMuZGVsZXRlKHNlY3Rpb24uaWQpO1xuICAgICAgc3RhdGUuc2VjdGlvblRva2Vucy5kZWxldGUoc2VjdGlvbi5pZCk7XG4gICAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xlYXJTZWN0aW9ucygpOiB2b2lkIHtcbiAgc3RhdGUuc2VjdGlvbnMuY2xlYXIoKTtcbiAgc3RhdGUuc2VjdGlvblRva2Vucy5jbGVhcigpO1xuICAvLyBEcm9wIHJlZ2lzdGVyZWQgcGFnZXMgdG9vIFx1MjAxNCB0aGV5J3JlIG93bmVkIGJ5IHR3ZWFrcyB0aGF0IGp1c3QgZ290XG4gIC8vIHRvcm4gZG93biBieSB0aGUgaG9zdC4gUnVuIGFueSB0ZWFyZG93bnMgYmVmb3JlIGZvcmdldHRpbmcgdGhlbS5cbiAgZm9yIChjb25zdCBwIG9mIHN0YXRlLnBhZ2VzLnZhbHVlcygpKSB7XG4gICAgdHJ5IHtcbiAgICAgIHAudGVhcmRvd24/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHBsb2coXCJwYWdlIHRlYXJkb3duIGZhaWxlZFwiLCB7IGlkOiBwLmlkLCBlcnI6IFN0cmluZyhlKSB9KTtcbiAgICB9XG4gIH1cbiAgc3RhdGUucGFnZXMuY2xlYXIoKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gRXhwbGljaXQgcGFnZXMgbWF5IGRpc2FwcGVhciBicmllZmx5IGR1cmluZyBhIGhvdCByZWxvYWQuIEtlZXAgdGhlIHN0YWJsZVxuICAvLyB0d2Vhay1sZXZlbCBwYWdlIGFjdGl2ZSBhbmQgcmVuZGVyIGl0cyBmYWxsYmFjayBpbnN0ZWFkIG9mIGVqZWN0aW5nIHRoZVxuICAvLyB1c2VyIGZyb20gU2V0dGluZ3MuXG4gIGlmIChcbiAgICBzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJlxuICAgICFzZXR0aW5nc05hdmlnYXRpb25JdGVtKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpXG4gICkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH0gZWxzZSBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWdpc3RlciBhIHR3ZWFrLW93bmVkIHNldHRpbmdzIHBhZ2UuIFRoZSBydW50aW1lIGluamVjdHMgYSBzaWRlYmFyIGVudHJ5XG4gKiB1bmRlciBhIFwiVFdFQUtTXCIgZ3JvdXAgaGVhZGVyICh3aGljaCBhcHBlYXJzIG9ubHkgd2hlbiBhdCBsZWFzdCBvbmUgcGFnZVxuICogaXMgcmVnaXN0ZXJlZCkgYW5kIHJvdXRlcyBjbGlja3MgdG8gdGhlIHBhZ2UncyBgcmVuZGVyKHJvb3QpYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyUGFnZShcbiAgdHdlYWtJZDogc3RyaW5nLFxuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdCxcbiAgcGFnZTogU2V0dGluZ3NQYWdlLFxuKTogU2V0dGluZ3NIYW5kbGUge1xuICBjb25zdCBpZCA9IHBhZ2UuaWQ7IC8vIGFscmVhZHkgbmFtZXNwYWNlZCBieSB0d2Vhay1ob3N0IGFzIGAke3R3ZWFrSWR9OiR7cGFnZS5pZH1gXG4gIGNvbnN0IGV4aXN0aW5nID0gc3RhdGUucGFnZXMuZ2V0KGlkKTtcbiAgaWYgKGV4aXN0aW5nKSB7XG4gICAgdHJ5IHsgZXhpc3RpbmcudGVhcmRvd24/LigpOyB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcmVnaXN0cmF0aW9uVG9rZW4gPSBTeW1ib2woaWQpO1xuICBjb25zdCBlbnRyeTogUmVnaXN0ZXJlZFBhZ2UgPSB7IGlkLCB0d2Vha0lkLCBtYW5pZmVzdCwgcGFnZSwgcmVnaXN0cmF0aW9uVG9rZW4gfTtcbiAgc3RhdGUucGFnZXMuc2V0KGlkLCBlbnRyeSk7XG4gIHBsb2coXCJyZWdpc3RlclBhZ2VcIiwgeyBpZCwgdGl0bGU6IHBhZ2UudGl0bGUsIHR3ZWFrSWQgfSk7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIC8vIElmIHRoZSB1c2VyIHdhcyBhbHJlYWR5IG9uIHRoaXMgcGFnZSAoaG90IHJlbG9hZCksIHJlLW1vdW50IGl0cyBib2R5LlxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gdHdlYWtJZCkge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBjb25zdCBlID0gc3RhdGUucGFnZXMuZ2V0KGlkKTtcbiAgICAgIGlmICghZSB8fCBlLnJlZ2lzdHJhdGlvblRva2VuICE9PSByZWdpc3RyYXRpb25Ub2tlbikgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgZS50ZWFyZG93bj8uKCk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgICBzdGF0ZS5wYWdlcy5kZWxldGUoaWQpO1xuICAgICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSB0d2Vha0lkKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBDYWxsZWQgYnkgdGhlIHR3ZWFrIGhvc3QgYWZ0ZXIgZmV0Y2hpbmcgdGhlIHR3ZWFrIGxpc3QgZnJvbSBtYWluLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldExpc3RlZFR3ZWFrcyhsaXN0OiBMaXN0ZWRUd2Vha1tdKTogdm9pZCB7XG4gIHN0YXRlLmxpc3RlZFR3ZWFrcyA9IGxpc3Q7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiAhc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbShzdGF0ZS5hY3RpdmVQYWdlLmlkKSkge1xuICAgIHJlc3RvcmVDb2RleFZpZXcoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIikge1xuICAgIHJlcmVuZGVyKCk7XG4gIH1cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwidHdlYWtzXCIpIHJlcmVuZGVyKCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVMaXN0ZWRUd2Vha0xpZmVjeWNsZShpZDogc3RyaW5nLCBsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl0sIGVycm9yPzogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHR3ZWFrID0gc3RhdGUubGlzdGVkVHdlYWtzLmZpbmQoKGl0ZW0pID0+IGl0ZW0ubWFuaWZlc3QuaWQgPT09IGlkKTtcbiAgaWYgKCF0d2VhaykgcmV0dXJuO1xuICB0d2Vhay5saWZlY3ljbGVPdmVycmlkZSA9IGxpZmVjeWNsZTtcbiAgaWYgKGVycm9yKSB0d2Vhay5oZWFsdGggPSB7IHN0YXR1czogbGlmZWN5Y2xlID09PSBcInF1YXJhbnRpbmVkXCIgPyBcInF1YXJhbnRpbmVkXCIgOiBcImZhaWxlZFwiLCB1cGRhdGVkQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwgZXJyb3IgfTtcbiAgZWxzZSBpZiAobGlmZWN5Y2xlID09PSBcInN0YXJ0aW5nXCIgfHwgbGlmZWN5Y2xlID09PSBcImVuYWJsZWRcIikgdHdlYWsuaGVhbHRoID0gbnVsbDtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IGlkKSByZXJlbmRlcigpO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nc05hdmlnYXRpb25JdGVtcygpOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW10ge1xuICByZXR1cm4gYnVpbGRTZXR0aW5nc05hdmlnYXRpb25Nb2RlbChcbiAgICBzdGF0ZS5saXN0ZWRUd2Vha3MubWFwKCh0d2VhaykgPT4gKHtcbiAgICAgIGlkOiB0d2Vhay5tYW5pZmVzdC5pZCxcbiAgICAgIG5hbWU6IHR3ZWFrLm1hbmlmZXN0Lm5hbWUsXG4gICAgICB2ZXJzaW9uOiB0d2Vhay5tYW5pZmVzdC52ZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IHR3ZWFrLm1hbmlmZXN0LmRlc2NyaXB0aW9uLFxuICAgICAgaWNvblVybDogdHdlYWsubWFuaWZlc3QuaWNvblVybCxcbiAgICAgIGVuYWJsZWQ6IHR3ZWFrLmVuYWJsZWQsXG4gICAgICBzdGF0dXM6IHR3ZWFrLnN0YXR1cyxcbiAgICAgIGhlYWx0aEVycm9yOiB0d2Vhay5oZWFsdGg/LmVycm9yID8/IG51bGwsXG4gICAgICBsaWZlY3ljbGVPdmVycmlkZTogdHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGUsXG4gICAgfSkpLFxuICAgIFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV0ubWFwKChlbnRyeSkgPT4gKHtcbiAgICAgIGlkOiBlbnRyeS5pZCxcbiAgICAgIHR3ZWFrSWQ6IGVudHJ5LnR3ZWFrSWQsXG4gICAgICB0aXRsZTogZW50cnkucGFnZS50aXRsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBlbnRyeS5wYWdlLmRlc2NyaXB0aW9uLFxuICAgICAgaWNvblN2ZzogZW50cnkucGFnZS5pY29uU3ZnLFxuICAgIH0pKSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbSh0d2Vha0lkOiBzdHJpbmcpOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtIHwgbnVsbCB7XG4gIHJldHVybiBzZXR0aW5nc05hdmlnYXRpb25JdGVtcygpLmZpbmQoKGl0ZW0pID0+IGl0ZW0udHdlYWtJZCA9PT0gdHdlYWtJZCkgPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gcmVnaXN0ZXJlZFBhZ2VzRm9yVHdlYWsodHdlYWtJZDogc3RyaW5nKTogUmVnaXN0ZXJlZFBhZ2VbXSB7XG4gIHJldHVybiBbLi4uc3RhdGUucGFnZXMudmFsdWVzKCldLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LnR3ZWFrSWQgPT09IHR3ZWFrSWQpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVMYWJlbChsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl0sIHdhcm5pbmc/OiBzdHJpbmcgfCBudWxsKTogc3RyaW5nIHtcbiAgY29uc3QgbGFiZWwgPSBsaWZlY3ljbGUgPT09IFwiZW5hYmxlZFwiID8gXCJSdW5uaW5nXCJcbiAgICA6IGxpZmVjeWNsZSA9PT0gXCJ0aW1lZF9vdXRcIiA/IFwiU3RhcnR1cCB0aW1lZCBvdXRcIlxuICAgIDogbGlmZWN5Y2xlWzBdLnRvVXBwZXJDYXNlKCkgKyBsaWZlY3ljbGUuc2xpY2UoMSk7XG4gIHJldHVybiB3YXJuaW5nID8gYCR7bGFiZWx9OiAke3dhcm5pbmd9YCA6IGxhYmVsO1xufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgaW5qZWN0aW9uIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0cnlJbmplY3QoKTogdm9pZCB7XG4gIGlmIChpc05hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZCgpKSByZXR1cm47XG4gIHJlbW92ZU1pc3BsYWNlZFNldHRpbmdzR3JvdXBzKCk7XG5cbiAgY29uc3QgaXRlbXNHcm91cCA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIWl0ZW1zR3JvdXApIHtcbiAgICBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpO1xuICAgIHBsb2coXCJzaWRlYmFyIG5vdCBmb3VuZFwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpO1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gIH1cbiAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh0cnVlLCBcInNpZGViYXItZm91bmRcIik7XG4gIC8vIEtlZXAgbmF0aXZlIGFuZCBUd2Vha2VycyBlbnRyaWVzIGluIHRoZSBzYW1lIHNjcm9sbCBjb250YWluZXIuIEFwcGVuZGluZ1xuICAvLyB0byB0aGUgcGFyZW50IGNyZWF0ZWQgYSBzZWNvbmQgaW5kZXBlbmRlbnRseSBzY3JvbGxpbmcgc2lkZWJhciByZWdpb24uXG4gIGNvbnN0IG91dGVyID0gaXRlbXNHcm91cDtcbiAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShpdGVtc0dyb3VwKSkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgcGxvZyhcInJlamVjdGVkIG5vbi1zZXR0aW5ncyBzaWRlYmFyIGNhbmRpZGF0ZVwiLCB7XG4gICAgICBpdGVtc0dyb3VwOiBkZXNjcmliZShpdGVtc0dyb3VwKSxcbiAgICAgIG91dGVyOiBkZXNjcmliZShvdXRlciksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLnNpZGViYXJSb290ID0gb3V0ZXI7XG4gIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwLCBvdXRlcik7XG4gIGJpbmRTZXR0aW5nc1NlYXJjaChvdXRlcik7XG5cbiAgaWYgKHN0YXRlLm5hdkdyb3VwICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLm5hdkdyb3VwKSkge1xuICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgLy8gQ29kZXggcmUtcmVuZGVycyBpdHMgbmF0aXZlIHNpZGViYXIgYnV0dG9ucyBvbiBpdHMgb3duIHN0YXRlIGNoYW5nZXMuXG4gICAgLy8gSWYgb25lIG9mIG91ciBwYWdlcyBpcyBhY3RpdmUsIHJlLXN0cmlwIENvZGV4J3MgYWN0aXZlIHN0eWxpbmcgc29cbiAgICAvLyBHZW5lcmFsIGRvZXNuJ3QgcmVhcHBlYXIgYXMgc2VsZWN0ZWQuXG4gICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwpIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZSh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaWRlYmFyIHdhcyBlaXRoZXIgZnJlc2hseSBtb3VudGVkIChTZXR0aW5ncyBqdXN0IG9wZW5lZCkgb3IgcmUtbW91bnRlZFxuICAvLyAoY2xvc2VkIGFuZCByZS1vcGVuZWQsIG9yIG5hdmlnYXRlZCBhd2F5IGFuZCBiYWNrKS4gSW4gYWxsIG9mIHRob3NlXG4gIC8vIGNhc2VzIENvZGV4IHJlc2V0cyB0byBpdHMgZGVmYXVsdCBwYWdlIChHZW5lcmFsKSwgYnV0IG91ciBpbi1tZW1vcnlcbiAgLy8gYGFjdGl2ZVBhZ2VgIG1heSBzdGlsbCByZWZlcmVuY2UgdGhlIGxhc3QgdHdlYWsvcGFnZSB0aGUgdXNlciBoYWQgb3BlblxuICAvLyBcdTIwMTQgd2hpY2ggd291bGQgY2F1c2UgdGhhdCBuYXYgYnV0dG9uIHRvIHJlbmRlciB3aXRoIHRoZSBhY3RpdmUgc3R5bGluZ1xuICAvLyBldmVuIHRob3VnaCBDb2RleCBpcyBzaG93aW5nIEdlbmVyYWwuIENsZWFyIGl0IHNvIGBzeW5jUGFnZXNHcm91cGAgL1xuICAvLyBgc2V0TmF2QWN0aXZlYCBzdGFydCBmcm9tIGEgbmV1dHJhbCBzdGF0ZS4gVGhlIHBhbmVsSG9zdCByZWZlcmVuY2UgaXNcbiAgLy8gYWxzbyBzdGFsZSAoaXRzIERPTSB3YXMgZGlzY2FyZGVkIHdpdGggdGhlIHByZXZpb3VzIGNvbnRlbnQgYXJlYSkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsIHx8IHN0YXRlLnBhbmVsSG9zdCAhPT0gbnVsbCkge1xuICAgIHBsb2coXCJzaWRlYmFyIHJlLW1vdW50IGRldGVjdGVkOyBjbGVhcmluZyBzdGFsZSBhY3RpdmUgc3RhdGVcIiwge1xuICAgICAgcHJldkFjdGl2ZTogc3RhdGUuYWN0aXZlUGFnZSxcbiAgICB9KTtcbiAgICBzdGF0ZS5hY3RpdmVQYWdlID0gbnVsbDtcbiAgICBzdGF0ZS5wYW5lbEhvc3QgPSBudWxsO1xuICB9XG5cbiAgY29uc3QgZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXAgPVxuICAgIG91dGVyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCc6c2NvcGUgPiBbZGF0YS10d2Vha2VyPVwibmF2LWdyb3VwXCJdJykgPz9cbiAgICBvdXRlci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtdHdlYWtlcj1cIm5hdi1ncm91cFwiXScpO1xuXG4gIGlmIChleGlzdGluZ1R3ZWFrZXJOYXZHcm91cCkge1xuICAgIHN0YXRlLm5hdkdyb3VwID0gZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXA7XG4gICAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IGV4aXN0aW5nVHdlYWtlck5hdkdyb3VwLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFxuICAgICAgXCJbZGF0YS10d2Vha2VyLXNpZGViYXItdXBkYXRlXVwiLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbigpO1xuICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlICE9PSBudWxsKSBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUodHJ1ZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gXHUyNTAwXHUyNTAwIEdyb3VwIGNvbnRhaW5lciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgZ3JvdXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBncm91cC5kYXRhc2V0LnR3ZWFrZXIgPSBcIm5hdi1ncm91cFwiO1xuICBncm91cC5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLXB4XCI7XG5cbiAgY29uc3QgdXBkYXRlQnV0dG9uID0gc2lkZWJhclVwZGF0ZVBpbGxCdXR0b24oKTtcbiAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IHVwZGF0ZUJ1dHRvbjtcbiAgZ3JvdXAuYXBwZW5kQ2hpbGQoc2lkZWJhckdyb3VwSGVhZGVyKFwiVHdlYWtlcnNcIiwgXCJwdC0zXCIsIHVwZGF0ZUJ1dHRvbikpO1xuICByZWZyZXNoU2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oKTtcblxuICAvLyBcdTI1MDBcdTI1MDAgU2lkZWJhciBpdGVtcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgY29uc3QgY29uZmlnQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiQ29uZmlnXCIsIGNvbmZpZ0ljb25TdmcoKSk7XG4gIGNvbnN0IHR3ZWFrc0J0biA9IG1ha2VTaWRlYmFySXRlbShcIlR3ZWFrc1wiLCB0d2Vha3NJY29uU3ZnKCkpO1xuXG4gIGNvbmZpZ0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcImNvbmZpZ1wiIH0pO1xuICB9KTtcbiAgdHdlYWtzQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwidHdlYWtzXCIgfSk7XG4gIH0pO1xuICBncm91cC5hcHBlbmRDaGlsZChjb25maWdCdG4pO1xuICBncm91cC5hcHBlbmRDaGlsZCh0d2Vha3NCdG4pO1xuICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG5cbiAgc3RhdGUubmF2R3JvdXAgPSBncm91cDtcbiAgc3RhdGUubmF2QnV0dG9ucyA9IHsgY29uZmlnOiBjb25maWdCdG4sIHR3ZWFrczogdHdlYWtzQnRuIH07XG4gIG5vdGVOYXZHcm91cEluamVjdGlvbihvdXRlcik7XG4gIHN5bmNQYWdlc0dyb3VwKCk7XG59XG5cbi8vIEJhY2tzdG9wIGFnYWluc3QgaW5qZWN0L3JlbW92ZSBmZWVkYmFjayBsb29wczogaWYgdGhlIG5hdiBncm91cCBuZWVkc1xuLy8gcmUtaW5qZWN0aW9uIG1vcmUgdGhhbiBhIGZldyB0aW1lcyBpbiBhIHNob3J0IHdpbmRvdywgc29tZXRoaW5nIGlzXG4vLyBmaWdodGluZyB1cyBcdTIwMTQgYmFjayBvZmYgaW5zdGVhZCBvZiBzYXR1cmF0aW5nIHRoZSBsb2cgYW5kIHRoZSBDUFUuXG5jb25zdCBOQVZfR1JPVVBfSU5KRUNUSU9OX1dJTkRPV19NUyA9IDEwXzAwMDtcbmNvbnN0IE5BVl9HUk9VUF9JTkpFQ1RJT05fTElNSVQgPSA1O1xuY29uc3QgTkFWX0dST1VQX0lOSkVDVElPTl9CQUNLT0ZGX01TID0gMzBfMDAwO1xubGV0IG5hdkdyb3VwSW5qZWN0aW9uczogbnVtYmVyW10gPSBbXTtcbmxldCBuYXZHcm91cEluamVjdGlvblN1cHByZXNzZWRVbnRpbCA9IDA7XG5cbmZ1bmN0aW9uIGlzTmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gRGF0ZS5ub3coKSA8IG5hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZFVudGlsO1xufVxuXG5mdW5jdGlvbiBub3RlTmF2R3JvdXBJbmplY3Rpb24ob3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIG5hdkdyb3VwSW5qZWN0aW9ucyA9IG5hdkdyb3VwSW5qZWN0aW9ucy5maWx0ZXIoKGF0KSA9PiBub3cgLSBhdCA8IE5BVl9HUk9VUF9JTkpFQ1RJT05fV0lORE9XX01TKTtcbiAgbmF2R3JvdXBJbmplY3Rpb25zLnB1c2gobm93KTtcbiAgaWYgKG5hdkdyb3VwSW5qZWN0aW9ucy5sZW5ndGggPiBOQVZfR1JPVVBfSU5KRUNUSU9OX0xJTUlUKSB7XG4gICAgbmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkVW50aWwgPSBub3cgKyBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVM7XG4gICAgbmF2R3JvdXBJbmplY3Rpb25zID0gW107XG4gICAgcGxvZyhcIm5hdiBncm91cCByZS1pbmplY3Rpb24gbG9vcCBkZXRlY3RlZDsgYmFja2luZyBvZmZcIiwge1xuICAgICAgYmFja29mZk1zOiBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVMsXG4gICAgICBvdXRlclRhZzogb3V0ZXIudGFnTmFtZSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgcGxvZyhcIm5hdiBncm91cCBpbmplY3RlZFwiLCB7IG91dGVyVGFnOiBvdXRlci50YWdOYW1lIH0pO1xufVxuXG5mdW5jdGlvbiBzeW5jTmF0aXZlU2V0dGluZ3NIZWFkZXIoaXRlbXNHcm91cDogSFRNTEVsZW1lbnQsIG91dGVyOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAoc3RhdGUubmF0aXZlTmF2SGVhZGVyICYmIG91dGVyLmNvbnRhaW5zKHN0YXRlLm5hdGl2ZU5hdkhlYWRlcikpIHJldHVybjtcblxuICBjb25zdCBoZWFkZXIgPSBzaWRlYmFyR3JvdXBIZWFkZXIoXCJHZW5lcmFsXCIpO1xuICBoZWFkZXIuZGF0YXNldC50d2Vha2VyID0gXCJuYXRpdmUtbmF2LWhlYWRlclwiO1xuICBpZiAob3V0ZXIgPT09IGl0ZW1zR3JvdXApIG91dGVyLnByZXBlbmQoaGVhZGVyKTtcbiAgZWxzZSBvdXRlci5pbnNlcnRCZWZvcmUoaGVhZGVyLCBpdGVtc0dyb3VwKTtcbiAgc3RhdGUubmF0aXZlTmF2SGVhZGVyID0gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBiaW5kU2V0dGluZ3NTZWFyY2gocm9vdDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgaW5wdXQgPSByb290LmNsb3Nlc3QoXCJhc2lkZSwgbmF2LCBbcm9sZT0nbmF2aWdhdGlvbiddLCBkaXZcIik/LnBhcmVudEVsZW1lbnRcbiAgICA/LnF1ZXJ5U2VsZWN0b3I8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtwbGFjZWhvbGRlcio9J1NlYXJjaCBzZXR0aW5ncycgaV1cIilcbiAgICA/PyBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbcGxhY2Vob2xkZXIqPSdTZWFyY2ggc2V0dGluZ3MnIGldXCIpO1xuICBpZiAoIWlucHV0IHx8IGlucHV0LmRhdGFzZXQudHdlYWtlcnNTZWFyY2hCb3VuZCA9PT0gXCJ0cnVlXCIpIHJldHVybjtcbiAgaW5wdXQuZGF0YXNldC50d2Vha2Vyc1NlYXJjaEJvdW5kID0gXCJ0cnVlXCI7XG4gIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgY29uc3QgcXVlcnkgPSBpbnB1dC52YWx1ZS50cmltKCkudG9Mb2NhbGVMb3dlckNhc2UoKTtcbiAgICBmb3IgKGNvbnN0IGJ1dHRvbiBvZiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpKSB7XG4gICAgICBpZiAoIWJ1dHRvbi5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlcl1cIikpIGNvbnRpbnVlO1xuICAgICAgYnV0dG9uLmhpZGRlbiA9ICEhcXVlcnkgJiYgIWNvbXBhY3RTZXR0aW5nc1RleHQoYnV0dG9uLnRleHRDb250ZW50ID8/IFwiXCIpLnRvTG9jYWxlTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IGdyb3VwIG9mIEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXI9J25hdi1ncm91cCddLCBbZGF0YS10d2Vha2VyPSdwYWdlcy1ncm91cCddXCIpKSkge1xuICAgICAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20oZ3JvdXAucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIikpO1xuICAgICAgZ3JvdXAuaGlkZGVuID0gYnV0dG9ucy5sZW5ndGggPiAwICYmIGJ1dHRvbnMuZXZlcnkoKGJ1dHRvbikgPT4gYnV0dG9uLmhpZGRlbik7XG4gICAgfVxuICB9KTtcbn1cblxuZnVuY3Rpb24gc2lkZWJhckdyb3VwSGVhZGVyKHRleHQ6IHN0cmluZywgdG9wUGFkZGluZyA9IFwicHQtMlwiLCB0cmFpbGluZz86IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID1cbiAgICBgcHgtcm93LXggJHt0b3BQYWRkaW5nfSBwYi0xIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB1cHBlcmNhc2UgdHJhY2tpbmctd2lkZXIgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIHNlbGVjdC1ub25lYDtcbiAgY29uc3QgbGFiZWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgbGFiZWwuY2xhc3NOYW1lID0gXCJ0cnVuY2F0ZVwiO1xuICBsYWJlbC50ZXh0Q29udGVudCA9IHRleHQ7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChsYWJlbCk7XG4gIGlmICh0cmFpbGluZykgaGVhZGVyLmFwcGVuZENoaWxkKHRyYWlsaW5nKTtcbiAgcmV0dXJuIGhlYWRlcjtcbn1cblxuZnVuY3Rpb24gc2NoZWR1bGVTZXR0aW5nc1N1cmZhY2VIaWRkZW4oKTogdm9pZCB7XG4gIGlmICghc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSB8fCBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpIHJldHVybjtcbiAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc3RhdGUuc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyID0gbnVsbDtcbiAgICBjb25zdCBzaWRlYmFyID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gICAgaWYgKHNpZGViYXIgJiYgaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoc2lkZWJhcikpIHJldHVybjtcbiAgICBpZiAoaXNTZXR0aW5nc1RleHRWaXNpYmxlKCkpIHJldHVybjtcbiAgICBzZXRTZXR0aW5nc1N1cmZhY2VWaXNpYmxlKGZhbHNlLCBcInNpZGViYXItbm90LWZvdW5kXCIpO1xuICB9LCAxNTAwKTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1RleHRWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gaXNUd2Vha2VyU2V0dGluZ3NMYWJlbFNldCh0d2Vha2VyU2V0dGluZ3NMYWJlbHNGcm9tKGRvY3VtZW50KSk7XG59XG5cbmZ1bmN0aW9uIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuXG5jb25zdCBUV0VBS0VSX0NPUkVfU0VUVElOR1NfTEFCRUxTID0gW1xuICBcIkdlbmVyYWxcIixcbiAgXCJcdTVFMzhcdTg5QzRcIixcbiAgXCJcdTkwMUFcdTc1MjhcIixcbiAgXCJBcHBlYXJhbmNlXCIsXG4gIFwiXHU1OTE2XHU4OUMyXCIsXG4gIFwiQ29uZmlndXJhdGlvblwiLFxuICBcIlx1OTE0RFx1N0Y2RVwiLFxuICBcIlx1OUVEOFx1OEJBNFx1Njc0M1x1OTY1MFwiLFxuICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICBcIlx1NEUyQVx1NjAyN1x1NTMxNlwiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5jb25zdCBUV0VBS0VSX0VYVEVOREVEX1NFVFRJTkdTX0xBQkVMUyA9IFtcbiAgXCJBY2NvdW50XCIsXG4gIFwiXHU4RDI2XHU2MjM3XCIsXG4gIFwiXHU4RDI2XHU1M0Y3XCIsXG4gIFwiR2VuZXJhbFwiLFxuICBcIlx1NUUzOFx1ODlDNFwiLFxuICBcIlx1OTAxQVx1NzUyOFwiLFxuICBcIkFwcGVhcmFuY2VcIixcbiAgXCJcdTU5MTZcdTg5QzJcIixcbiAgXCJDb25maWd1cmF0aW9uXCIsXG4gIFwiXHU5MTREXHU3RjZFXCIsXG4gIFwiXHU5RUQ4XHU4QkE0XHU2NzQzXHU5NjUwXCIsXG4gIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gIFwiXHU0RTJBXHU2MDI3XHU1MzE2XCIsXG4gIFwiS2V5Ym9hcmQgc2hvcnRjdXRzXCIsXG4gIFwiQXJjaGl2ZWQgY2hhdHNcIixcbiAgXCJVc2FnZVwiLFxuICBcIkNvbXB1dGVyIHVzZVwiLFxuICBcIkJyb3dzZXIgdXNlXCIsXG4gIFwiTUNQIHNlcnZlcnNcIixcbiAgXCJNQ1AgU2VydmVyc1wiLFxuICBcIk1DUCBcdTY3MERcdTUyQTFcdTU2NjhcIixcbiAgXCJHaXRcIixcbiAgXCJFbnZpcm9ubWVudHNcIixcbiAgXCJcdTczQUZcdTU4ODNcIixcbiAgXCJDbG91ZCBFbnZpcm9ubWVudHNcIixcbiAgXCJXb3JrdHJlZXNcIixcbiAgXCJDb25uZWN0aW9uc1wiLFxuICBcIlBsdWdpbnNcIixcbiAgXCJTa2lsbHNcIixcbl0ubWFwKG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKTtcblxuY29uc3QgVFdFQUtFUl9TRVRUSU5HU19PTkxZX0xBQkVMUyA9IFtcbiAgXCJHZW5lcmFsXCIsXG4gIFwiXHU1RTM4XHU4OUM0XCIsXG4gIFwiXHU5MDFBXHU3NTI4XCIsXG4gIFwiQXBwZWFyYW5jZVwiLFxuICBcIlx1NTkxNlx1ODlDMlwiLFxuICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgXCJcdTkxNERcdTdGNkVcIixcbiAgXCJcdTlFRDhcdThCQTRcdTY3NDNcdTk2NTBcIixcbiAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgXCJcdTRFMkFcdTYwMjdcdTUzMTZcIixcbiAgXCJLZXlib2FyZCBzaG9ydGN1dHNcIixcbiAgXCJBcmNoaXZlZCBjaGF0c1wiLFxuICBcIlVzYWdlXCIsXG4gIFwiQ29tcHV0ZXIgdXNlXCIsXG4gIFwiQnJvd3NlciB1c2VcIixcbiAgXCJNQ1Agc2VydmVyc1wiLFxuICBcIk1DUCBTZXJ2ZXJzXCIsXG4gIFwiTUNQIFx1NjcwRFx1NTJBMVx1NTY2OFwiLFxuICBcIkdpdFwiLFxuICBcIkVudmlyb25tZW50c1wiLFxuICBcIlx1NzNBRlx1NTg4M1wiLFxuICBcIkNsb3VkIEVudmlyb25tZW50c1wiLFxuICBcIldvcmt0cmVlc1wiLFxuICBcIkNvbm5lY3Rpb25zXCIsXG5dLm1hcChub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCk7XG5cbmNvbnN0IFRXRUFLRVJfTUFJTl9BUFBfTkFWX0xBQkVMUyA9IFtcbiAgXCJOZXcgY2hhdFwiLFxuICBcIlF1aWNrIGNoYXRcIixcbiAgXCJcdTVGRUJcdTkwMUZcdTVCRjlcdThCRERcIixcbiAgXCJTZWFyY2hcIixcbiAgXCJcdTY0MUNcdTdEMjJcIixcbiAgXCJQbHVnaW5zXCIsXG4gIFwiXHU2M0QyXHU0RUY2XCIsXG4gIFwiQXV0b21hdGlvbnNcIixcbiAgXCJBdXRvbWF0aW9uXCIsXG4gIFwiXHU4MUVBXHU1MkE4XHU1MzE2XCIsXG4gIFwiQ2hhdHNcIixcbiAgXCJDaGF0XCIsXG4gIFwiXHU1QkY5XHU4QkREXCIsXG4gIFwiUHJvamVjdHNcIixcbiAgXCJcdTk4NzlcdTc2RUVcIixcbiAgXCJQaW5uZWRcIixcbiAgXCJTZXR0aW5nc1wiLFxuICBcIlx1OEJCRVx1N0Y2RVwiLFxuICBcIldvcmsgbG9jYWxseVwiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5mdW5jdGlvbiBub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvbXBhY3RTZXR0aW5nc1RleHQodmFsdWUpXG4gICAgLnRvTG9jYWxlTG93ZXJDYXNlKClcbiAgICAubm9ybWFsaXplKFwiTkZEXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csIFwiXCIpXG4gICAgLnJlcGxhY2UoL1tcdTIwMTlcdTIwMThgXHUwMEI0XS9nLCBcIidcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyQ29udHJvbExhYmVsKGVsOiBIVE1MRWxlbWVudCk6IHN0cmluZyB7XG4gIHJldHVybiBub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbChcbiAgICBlbC5nZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8XG4gICAgICBlbC5nZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiKSB8fFxuICAgICAgZWwudGV4dENvbnRlbnQgfHxcbiAgICAgIFwiXCIsXG4gICk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20ocm9vdDogUGFyZW50Tm9kZSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgY29udHJvbHMgPSBBcnJheS5mcm9tKFxuICAgIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sYSxbcm9sZT0nYnV0dG9uJ10sW3JvbGU9J2xpbmsnXVwiKSxcbiAgKTtcblxuICByZXR1cm4gW1xuICAgIC4uLm5ldyBTZXQoXG4gICAgICBjb250cm9sc1xuICAgICAgICAubWFwKHR3ZWFrZXJDb250cm9sTGFiZWwpXG4gICAgICAgIC5maWx0ZXIoQm9vbGVhbiksXG4gICAgKSxcbiAgXTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlclNldHRpbmdzTGFiZWxTY29yZShsYWJlbHM6IHN0cmluZ1tdKTogeyBjb3JlOiBudW1iZXI7IHRvdGFsOiBudW1iZXIgfSB7XG4gIGNvbnN0IGNvcmUgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgdG90YWwgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBmb3IgKGNvbnN0IGxhYmVsIG9mIGxhYmVscykge1xuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIFRXRUFLRVJfQ09SRV9TRVRUSU5HU19MQUJFTFMpIHtcbiAgICAgIGlmICh0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsLCBtYXJrZXIpKSBjb3JlLmFkZChtYXJrZXIpO1xuICAgIH1cblxuICAgIGZvciAoY29uc3QgbWFya2VyIG9mIFRXRUFLRVJfRVhURU5ERURfU0VUVElOR1NfTEFCRUxTKSB7XG4gICAgICBpZiAodHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgdG90YWwuYWRkKG1hcmtlcik7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHsgY29yZTogY29yZS5zaXplLCB0b3RhbDogdG90YWwuc2l6ZSB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyTGFiZWxNYXRjaGVzTWFya2VyKGxhYmVsOiBzdHJpbmcsIG1hcmtlcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBsYWJlbCA9PT0gbWFya2VyIHx8IGxhYmVsLmluY2x1ZGVzKG1hcmtlcik7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJNYXJrZXJDb3VudChsYWJlbHM6IHN0cmluZ1tdLCBtYXJrZXJzOiBzdHJpbmdbXSk6IG51bWJlciB7XG4gIGNvbnN0IG1hdGNoZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBtYXJrZXJzKSB7XG4gICAgICBpZiAodHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgbWF0Y2hlZC5hZGQobWFya2VyKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1hdGNoZWQuc2l6ZTtcbn1cblxuZnVuY3Rpb24gaGFzVHdlYWtlclNldHRpbmdzT25seVNpZ25hbChsYWJlbHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIHJldHVybiB0d2Vha2VyTWFya2VyQ291bnQobGFiZWxzLCBUV0VBS0VSX1NFVFRJTkdTX09OTFlfTEFCRUxTKSA+IDA7XG59XG5cbmZ1bmN0aW9uIGhhc01haW5BcHBTaWRlYmFyU2lnbmFscyhsYWJlbHM6IHN0cmluZ1tdKTogYm9vbGVhbiB7XG4gIHJldHVybiB0d2Vha2VyTWFya2VyQ291bnQobGFiZWxzLCBUV0VBS0VSX01BSU5fQVBQX05BVl9MQUJFTFMpID49IDI7XG59XG5cbmZ1bmN0aW9uIGlzVHdlYWtlclNldHRpbmdzTGFiZWxTZXQobGFiZWxzOiBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgcmV0dXJuIHNjb3JlLmNvcmUgPj0gMiAmJiBzY29yZS50b3RhbCA+PSAzO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyVmlzaWJsZUJveChlbDogSFRNTEVsZW1lbnQpOiBET01SZWN0IHwgbnVsbCB7XG4gIGlmICghZWwuaXNDb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBzdHlsZSA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xuICBpZiAoc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHwgc3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIikgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVjdCA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBpZiAocmVjdC53aWR0aCA8PSAwIHx8IHJlY3QuaGVpZ2h0IDw9IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gcmVjdDtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgaWYgKHZpc2libGUpIHdhcm1Ud2Vha1N0b3JlKCk7XG4gIHRyeSB7XG4gICAgKHdpbmRvdyBhcyBXaW5kb3cgJiB7IF9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGU/OiBib29sZWFuIH0pLl9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnR3ZWFrZXJTZXR0aW5nc1N1cmZhY2UgPSB2aXNpYmxlID8gXCJ0cnVlXCIgOiBcImZhbHNlXCI7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQoXG4gICAgICBuZXcgQ3VzdG9tRXZlbnQoXCJ0d2Vha2VyOnNldHRpbmdzLXN1cmZhY2VcIiwge1xuICAgICAgICBkZXRhaWw6IHsgdmlzaWJsZSwgcmVhc29uIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9IGNhdGNoIHt9XG4gIHBsb2coXCJzZXR0aW5ncyBzdXJmYWNlXCIsIHsgdmlzaWJsZSwgcmVhc29uLCB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG59XG5cbi8qKlxuICogUmVuZGVyIChvciByZS1yZW5kZXIpIHRoZSBzZWNvbmQgc2lkZWJhciBncm91cCBvZiBwZXItdHdlYWsgcGFnZXMuIFRoZVxuICogZ3JvdXAgaXMgY3JlYXRlZCBsYXppbHkgYW5kIHJlbW92ZWQgd2hlbiB0aGUgbGFzdCBwYWdlIHVucmVnaXN0ZXJzLCBzb1xuICogdXNlcnMgd2l0aCBubyBwYWdlLXJlZ2lzdGVyaW5nIHR3ZWFrcyBuZXZlciBzZWUgYW4gZW1wdHkgXCJUd2Vha3NcIiBoZWFkZXIuXG4gKi9cbmZ1bmN0aW9uIHN5bmNQYWdlc0dyb3VwKCk6IHZvaWQge1xuICBjb25zdCBvdXRlciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIW91dGVyKSByZXR1cm47XG4gIGlmICghaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUob3V0ZXIpKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBhZ2VzID0gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbXMoKTtcblxuICAvLyBCdWlsZCBhIGRldGVybWluaXN0aWMgZmluZ2VycHJpbnQgb2YgdGhlIGRlc2lyZWQgZ3JvdXAgc3RhdGUuIElmIHRoZVxuICAvLyBjdXJyZW50IERPTSBncm91cCBhbHJlYWR5IG1hdGNoZXMsIHRoaXMgaXMgYSBuby1vcCBcdTIwMTQgY3JpdGljYWwsIGJlY2F1c2VcbiAgLy8gc3luY1BhZ2VzR3JvdXAgaXMgY2FsbGVkIG9uIGV2ZXJ5IE11dGF0aW9uT2JzZXJ2ZXIgdGljayBhbmQgYW55IERPTVxuICAvLyB3cml0ZSB3b3VsZCByZS10cmlnZ2VyIHRoYXQgb2JzZXJ2ZXIgKGluZmluaXRlIGxvb3AsIGFwcCBmcmVlemUpLlxuICBjb25zdCBkZXNpcmVkS2V5ID0gcGFnZXMubGVuZ3RoID09PSAwXG4gICAgPyBcIkVNUFRZXCJcbiAgICA6IHBhZ2VzLm1hcCgocCkgPT4gYCR7cC50d2Vha0lkfXwke3AudGl0bGV9fCR7cC5pY29uU3ZnID8/IFwiXCJ9fCR7cC5saWZlY3ljbGV9YCkuam9pbihcIlxcblwiKTtcbiAgY29uc3QgZ3JvdXBBdHRhY2hlZCA9ICEhc3RhdGUucGFnZXNHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKTtcbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXBLZXkgPT09IGRlc2lyZWRLZXkgJiYgKHBhZ2VzLmxlbmd0aCA9PT0gMCA/ICFncm91cEF0dGFjaGVkIDogZ3JvdXBBdHRhY2hlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXApIHtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAucmVtb3ZlKCk7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICB9XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgZ3JvdXAgPSBzdGF0ZS5wYWdlc0dyb3VwO1xuICBpZiAoIWdyb3VwIHx8ICFvdXRlci5jb250YWlucyhncm91cCkpIHtcbiAgICBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZ3JvdXAuZGF0YXNldC50d2Vha2VyID0gXCJwYWdlcy1ncm91cFwiO1xuICAgIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcbiAgICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJUd2Vha3NcIiwgXCJwdC0zXCIpKTtcbiAgICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG4gICAgc3RhdGUucGFnZXNHcm91cCA9IGdyb3VwO1xuICB9IGVsc2Uge1xuICAgIC8vIFN0cmlwIHByaW9yIGJ1dHRvbnMgKGtlZXAgdGhlIGhlYWRlciBhdCBpbmRleCAwKS5cbiAgICB3aGlsZSAoZ3JvdXAuY2hpbGRyZW4ubGVuZ3RoID4gMSkgZ3JvdXAucmVtb3ZlQ2hpbGQoZ3JvdXAubGFzdENoaWxkISk7XG4gIH1cblxuICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGFnZXMpIHtcbiAgICBjb25zdCBpY29uID0gcC5pY29uU3ZnID8/IGRlZmF1bHRQYWdlSWNvblN2ZygpO1xuICAgIGNvbnN0IGJ0biA9IG1ha2VTaWRlYmFySXRlbShwLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi1wYWdlLSR7cC50d2Vha0lkfWA7XG4gICAgYnRuLmRhdGFzZXQudHdlYWtlckxpZmVjeWNsZSA9IHAubGlmZWN5Y2xlO1xuICAgIGlmIChwLmxpZmVjeWNsZSAhPT0gXCJlbmFibGVkXCIpIGJ0bi50aXRsZSA9IGxpZmVjeWNsZUxhYmVsKHAubGlmZWN5Y2xlLCBwLndhcm5pbmcpO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAudHdlYWtJZCB9KTtcbiAgICB9KTtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5zZXQocC50d2Vha0lkLCBidG4pO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKGJ0bik7XG4gIH1cbiAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gIHBsb2coXCJwYWdlcyBncm91cCBzeW5jZWRcIiwge1xuICAgIGNvdW50OiBwYWdlcy5sZW5ndGgsXG4gICAgaWRzOiBwYWdlcy5tYXAoKHApID0+IHAudHdlYWtJZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbi8vIEZvcmNlIGFueSBpbmplY3RlZCBpY29uIFNWRyB0byBhIGZpeGVkIGJveC4gVHdlYWstcHJvdmlkZWQgaWNvblN2ZyBtYXJrdXAgbWF5XG4vLyBvbWl0IHdpZHRoL2hlaWdodCAoYW5kIHZpZXdCb3ggYWxvbmUgbGV0cyBhbiBTVkcgZXhwYW5kIHRvIGl0cyBpbnRyaW5zaWMgc2l6ZSxcbi8vIHdoaWNoIHJlbmRlcmVkIGEgcGFnZSBpY29uIGFzIGEgZ2lhbnQgZ2x5cGgpLiBJbmxpbmUgc3R5bGVzIGJlYXQgY29uZmxpY3Rpbmdcbi8vIGF0dHJpYnV0ZXMvQ1NTLCBzbyB0aGlzIGNhbm5vdCBiZSBkZWZlYXRlZCBieSB0aGUgdHdlYWsncyBvd24gbWFya3VwLlxuZnVuY3Rpb24gY29uc3RyYWluU2lkZWJhckljb25TdmcoaWNvbjogRWxlbWVudCB8IG51bGwgfCB1bmRlZmluZWQsIHNpemUgPSAyMCk6IHZvaWQge1xuICBpZiAoIWljb24pIHJldHVybjtcbiAgaWNvbi5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBpY29uLnNldEF0dHJpYnV0ZShcImhlaWdodFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBjb25zdCBzdHlsZSA9IChpY29uIGFzIHVua25vd24gYXMgeyBzdHlsZT86IENTU1N0eWxlRGVjbGFyYXRpb24gfSkuc3R5bGU7XG4gIGlmIChzdHlsZSkge1xuICAgIHN0eWxlLndpZHRoID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuaGVpZ2h0ID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuZmxleFNocmluayA9IFwiMFwiO1xuICB9XG4gIChpY29uIGFzIEVsZW1lbnQpLmNsYXNzTGlzdD8uYWRkKFwiaWNvbi1zbVwiLCBcImlubGluZS1ibG9ja1wiLCBcInNocmluay0wXCIsIFwiYWxpZ24tbWlkZGxlXCIpO1xufVxuXG5mdW5jdGlvbiBtYWtlU2lkZWJhckl0ZW0obGFiZWw6IHN0cmluZywgaWNvblN2Zzogc3RyaW5nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICAvLyBDbGFzcyBzdHJpbmcgY29waWVkIHZlcmJhdGltIGZyb20gQ29kZXgncyBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwgZXRjKS5cbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi0ke2xhYmVsLnRvTG93ZXJDYXNlKCl9YDtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbGFiZWwpO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImZvY3VzLXZpc2libGU6b3V0bGluZS10b2tlbi1ib3JkZXIgcmVsYXRpdmUgcHgtcm93LXggcHktcm93LXkgY3Vyc29yLWludGVyYWN0aW9uIHNocmluay0wIGl0ZW1zLWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyB0ZXh0LWxlZnQgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLTIgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW9mZnNldC0yIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTUwIGdhcC0yIGZsZXggdy1mdWxsIGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBmb250LW5vcm1hbFwiO1xuXG4gIGNvbnN0IGlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaW5uZXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgdGV4dC1iYXNlIGdhcC0yIGZsZXgtMSB0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgaW5uZXIuaW5uZXJIVE1MID0gYCR7aWNvblN2Z308c3BhbiBjbGFzcz1cInRydW5jYXRlXCI+JHtsYWJlbH08L3NwYW4+YDtcbiAgY29uc3RyYWluU2lkZWJhckljb25TdmcoaW5uZXIucXVlcnlTZWxlY3RvcihcInN2Z1wiKSk7XG4gIGJ0bi5hcHBlbmRDaGlsZChpbm5lcik7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGFwcGVuZFNpZGViYXJTdG9yZVVwZGF0ZUJhZGdlKGJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWlubmVyKSByZXR1cm47XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmRhdGFzZXQudHdlYWtlclN0b3JlVXBkYXRlQmFkZ2UgPSBcInRydWVcIjtcbiAgYmFkZ2UuaGlkZGVuID0gdHJ1ZTtcbiAgYmFkZ2UudGl0bGUgPSBcIkluc3RhbGxlZCB0d2Vha3Mgd2l0aCBhcHByb3ZlZCB1cGRhdGVzXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyXCI7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBwb3NpdGlvbjogXCJhYnNvbHV0ZVwiLFxuICAgIHJpZ2h0OiBcIjEycHhcIixcbiAgICB0b3A6IFwiNTAlXCIsXG4gICAgdHJhbnNmb3JtOiBcInRyYW5zbGF0ZVkoLTUwJSlcIixcbiAgICB6SW5kZXg6IFwiMVwiLFxuICB9KTtcbiAgYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2UsIG51bGwpO1xuICBidG4uYXBwZW5kQ2hpbGQoYmFkZ2UpO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCIgfCBcInN0b3JlXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOlxuICAgICAgYWN0aXZlPy5raW5kID09PSBcInN0b3JlXCIgPyBcInN0b3JlXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIE9uZSBzdGFibGUgYnV0dG9uIHBlciBlbmFibGVkIHR3ZWFrLCByZWdhcmRsZXNzIG9mIGhvdyBtYW55IHNlY3Rpb25zIGl0XG4gIC8vIHJlZ2lzdGVyZWQgb3Igd2hldGhlciBzdGFydHVwIHJlYWNoZWQgcGFnZSByZWdpc3RyYXRpb24gYXQgYWxsLlxuICBmb3IgKGNvbnN0IFt0d2Vha0lkLCBidXR0b25dIG9mIHN0YXRlLnBhZ2VOYXZCdXR0b25zKSB7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gdHdlYWtJZDtcbiAgICBhcHBseU5hdkFjdGl2ZShidXR0b24sIGlzQWN0aXZlKTtcbiAgfVxuICAvLyBDb2RleCdzIG93biBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIGV0YykuIFdoZW4gb25lIG9mXG4gIC8vIG91ciBwYWdlcyBpcyBhY3RpdmUsIENvZGV4IHN0aWxsIGhhcyBhcmlhLWN1cnJlbnQ9XCJwYWdlXCIgYW5kIHRoZVxuICAvLyBhY3RpdmUtYmcgY2xhc3Mgb24gd2hpY2hldmVyIGl0ZW0gaXQgY29uc2lkZXJlZCB0aGUgcm91dGUgXHUyMDE0IHR5cGljYWxseVxuICAvLyBHZW5lcmFsLiBUaGF0IG1ha2VzIGJvdGggYnV0dG9ucyBsb29rIHNlbGVjdGVkLiBTdHJpcCBDb2RleCdzIGFjdGl2ZVxuICAvLyBzdHlsaW5nIHdoaWxlIG9uZSBvZiBvdXJzIGlzIGFjdGl2ZTsgcmVzdG9yZSBpdCB3aGVuIG5vbmUgaXMuXG4gIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShhY3RpdmUgIT09IG51bGwpO1xufVxuXG4vKipcbiAqIE11dGUgQ29kZXgncyBvd24gYWN0aXZlLXN0YXRlIHN0eWxpbmcgb24gaXRzIHNpZGViYXIgYnV0dG9ucy4gV2UgZG9uJ3RcbiAqIHRvdWNoIENvZGV4J3MgUmVhY3Qgc3RhdGUgXHUyMDE0IHdoZW4gdGhlIHVzZXIgY2xpY2tzIGEgbmF0aXZlIGl0ZW0sIENvZGV4XG4gKiByZS1yZW5kZXJzIHRoZSBidXR0b25zIGFuZCByZS1hcHBsaWVzIGl0cyBvd24gY29ycmVjdCBzdGF0ZSwgdGhlbiBvdXJcbiAqIHNpZGViYXItY2xpY2sgbGlzdGVuZXIgZmlyZXMgYHJlc3RvcmVDb2RleFZpZXdgICh3aGljaCBjYWxscyBiYWNrIGludG9cbiAqIGBzZXROYXZBY3RpdmUobnVsbClgIGFuZCBsZXRzIENvZGV4J3Mgc3R5bGluZyBzdGFuZCkuXG4gKlxuICogYG11dGU9dHJ1ZWAgIFx1MjE5MiBzdHJpcCBhcmlhLWN1cnJlbnQgYW5kIHN3YXAgYWN0aXZlIGJnIFx1MjE5MiBob3ZlciBiZ1xuICogYG11dGU9ZmFsc2VgIFx1MjE5MiBuby1vcCAoQ29kZXgncyBvd24gcmUtcmVuZGVyIGFscmVhZHkgcmVzdG9yZWQgdGhpbmdzKVxuICovXG5mdW5jdGlvbiBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUobXV0ZTogYm9vbGVhbik6IHZvaWQge1xuICBpZiAoIW11dGUpIHJldHVybjtcbiAgY29uc3Qgcm9vdCA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIGJ1dHRvbnMpIHtcbiAgICAvLyBTa2lwIG91ciBvd24gYnV0dG9ucy5cbiAgICBpZiAoYnRuLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiKSB7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgIH1cbiAgICBpZiAoYnRuLmNsYXNzTGlzdC5jb250YWlucyhcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlOYXZBY3RpdmUoYnRuOiBIVE1MQnV0dG9uRWxlbWVudCwgYWN0aXZlOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGlubmVyID0gYnRuLmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGFjdGl2ZSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiLCBcInBhZ2VcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgYWN0aXZhdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYWN0aXZhdGVQYWdlKHBhZ2U6IEFjdGl2ZVBhZ2UpOiB2b2lkIHtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICBwbG9nKFwiYWN0aXZhdGU6IGNvbnRlbnQgYXJlYSBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBwYWdlO1xuICBwbG9nKFwiYWN0aXZhdGVcIiwgeyBwYWdlIH0pO1xuXG4gIC8vIEhpZGUgQ29kZXgncyBjb250ZW50IGNoaWxkcmVuLCBzaG93IG91cnMuXG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlciA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5kYXRhc2V0LnR3ZWFrZXJIaWRkZW4gPSBjaGlsZC5zdHlsZS5kaXNwbGF5IHx8IFwiXCI7XG4gICAgfVxuICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgfVxuICBsZXQgcGFuZWwgPSBjb250ZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS10d2Vha2VyPVwidHdlYWtzLXBhbmVsXCJdJyk7XG4gIGlmICghcGFuZWwpIHtcbiAgICBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcGFuZWwuZGF0YXNldC50d2Vha2VyID0gXCJ0d2Vha3MtcGFuZWxcIjtcbiAgICBwYW5lbC5zdHlsZS5jc3NUZXh0ID0gXCJ3aWR0aDoxMDAlO2hlaWdodDoxMDAlO292ZXJmbG93OmF1dG87XCI7XG4gICAgY29udGVudC5hcHBlbmRDaGlsZChwYW5lbCk7XG4gIH1cbiAgcGFuZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgc3RhdGUucGFuZWxIb3N0ID0gcGFuZWw7XG4gIHJlcmVuZGVyKCk7XG4gIHNldE5hdkFjdGl2ZShwYWdlKTtcbiAgLy8gcmVzdG9yZSBDb2RleCdzIHZpZXcuIFJlLXJlZ2lzdGVyIGlmIG5lZWRlZC5cbiAgY29uc3Qgc2lkZWJhciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoc2lkZWJhcikge1xuICAgIGlmIChzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICAgIHNpZGViYXIucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciwgdHJ1ZSk7XG4gICAgfVxuICAgIGNvbnN0IGhhbmRsZXIgPSAoZTogRXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG4gICAgICBpZiAoc3RhdGUubmF2R3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIGJ1dHRvbnNcbiAgICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBwYWdlIGJ1dHRvbnNcbiAgICAgIGlmICh0YXJnZXQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc2V0dGluZ3Mtc2VhcmNoXVwiKSkgcmV0dXJuO1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgIH07XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gaGFuZGxlcjtcbiAgICBzaWRlYmFyLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBoYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXN0b3JlQ29kZXhWaWV3KCk6IHZvaWQge1xuICBwbG9nKFwicmVzdG9yZSBjb2RleCB2aWV3XCIpO1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaWYgKHN0YXRlLnBhbmVsSG9zdCkgc3RhdGUucGFuZWxIb3N0LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQgPT09IHN0YXRlLnBhbmVsSG9zdCkgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuO1xuICAgICAgZGVsZXRlIGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbjtcbiAgICB9XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gIHNldE5hdkFjdGl2ZShudWxsKTtcbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgIHN0YXRlLnNpZGViYXJSb290LnJlbW92ZUV2ZW50TGlzdGVuZXIoXG4gICAgICBcImNsaWNrXCIsXG4gICAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXJlbmRlcigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5hY3RpdmVQYWdlKSByZXR1cm47XG4gIGNvbnN0IGhvc3QgPSBzdGF0ZS5wYW5lbEhvc3Q7XG4gIGlmICghaG9zdCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgaXRlbSA9IHNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oYXAuaWQpO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBlbnRyaWVzID0gcmVnaXN0ZXJlZFBhZ2VzRm9yVHdlYWsoYXAuaWQpO1xuICAgIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKGl0ZW0udGl0bGUsIGl0ZW0uZGVzY3JpcHRpb24pO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gICAgcm9vdC5oZWFkZXJUaXRsZUFjdGlvbnMuYXBwZW5kQ2hpbGQodHdlYWtMaWZlY3ljbGVCYWRnZShpdGVtKSk7XG4gICAgaWYgKGl0ZW0ud2FybmluZykgcm9vdC5zZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQodHdlYWtQYWdlV2FybmluZyhpdGVtLndhcm5pbmcpKTtcbiAgICBpZiAoIWVudHJpZXMubGVuZ3RoKSB7XG4gICAgICByZW5kZXJGYWxsYmFja1R3ZWFrUGFnZShyb290LnNlY3Rpb25zV3JhcCwgaXRlbSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICAgICAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICAgIGlmIChlbnRyaWVzLmxlbmd0aCA+IDEpIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKGVudHJ5LnBhZ2UudGl0bGUpKTtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICB0YXJnZXQuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gICAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHRhcmdldCk7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gICAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHRhcmdldCk7XG4gICAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zdCBlcnIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgICBlcnIudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHBhZ2U6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgICAgdGFyZ2V0LmFwcGVuZENoaWxkKGVycik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpdGxlID1cbiAgICBhcC5raW5kID09PSBcInR3ZWFrc1wiID8gXCJUd2Vha3NcIiA6XG4gICAgYXAua2luZCA9PT0gXCJzdG9yZVwiID8gXCJUd2VhayBTdG9yZVwiIDogXCJUd2Vha2Vyc1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9XG4gICAgYXAua2luZCA9PT0gXCJ0d2Vha3NcIlxuICAgICAgPyBcIk1hbmFnZSB5b3VyIGNhdGFsb2cgZW50cmllcyBhbmQgaW5zdGFsbGVkIHR3ZWFrcy5cIlxuICAgICAgOiBhcC5raW5kID09PSBcInN0b3JlXCJcbiAgICAgICAgPyBcIkluc3RhbGwgcmV2aWV3ZWQgdHdlYWtzIHBpbm5lZCB0byBhcHByb3ZlZCBHaXRIdWIgY29tbWl0cy5cIlxuICAgICAgICA6IFwiQ2hlY2tpbmcgaW5zdGFsbGVkIFR3ZWFrZXJzIHZlcnNpb24uXCI7XG4gIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKFxuICAgIHRpdGxlLFxuICAgIHN1YnRpdGxlLFxuICAgIGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyB7IHdpZHRoOiBcInBsdWdpbnNcIiB9IDogdW5kZWZpbmVkLFxuICApO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgaWYgKGFwLmtpbmQgPT09IFwic3RvcmVcIikgcmVuZGVyVHdlYWtTdG9yZVBhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3QuaGVhZGVyQWN0aW9ucyk7XG4gIGVsc2UgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbmZ1bmN0aW9uIHRlYXJkb3duUmVuZGVyZWRQYWdlcygpOiB2b2lkIHtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwPy4oKTtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gbnVsbDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkudGVhcmRvd24pIGNvbnRpbnVlO1xuICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duKCk7IH0gY2F0Y2gge31cbiAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHBhZ2VzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0d2Vha0xpZmVjeWNsZUJhZGdlKGl0ZW06IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gYCR7aXRlbS52ZXJzaW9ufSBcdTAwQjcgJHtsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSl9YDtcbiAgYmFkZ2UudGl0bGUgPSBgJHtpdGVtLnZlcnNpb259IFx1MDBCNyAke2xpZmVjeWNsZUxhYmVsKGl0ZW0ubGlmZWN5Y2xlLCBpdGVtLndhcm5pbmcpfWA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtQYWdlV2FybmluZyhtZXNzYWdlOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3YXJuaW5nLmNsYXNzTmFtZSA9IFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cvMzAgYmctdG9rZW4tY2hhcnRzLXllbGxvdy8xMCBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB3YXJuaW5nLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgcmV0dXJuIHdhcm5pbmc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckZhbGxiYWNrVHdlYWtQYWdlKHJvb3Q6IEhUTUxFbGVtZW50LCBpdGVtOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtKTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJTdGF0dXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJWZXJzaW9uXCIsIGl0ZW0udmVyc2lvbikpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxpZmVjeWNsZVwiLCBsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSwgaXRlbS53YXJuaW5nKSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlNldHRpbmdzIHBhZ2VcIiwgXCJUaGlzIGVuYWJsZWQgVHdlYWtlciBoYXMgbm90IHJlZ2lzdGVyZWQgaXRzIGN1c3RvbSBwYWdlIHlldC4gUnVudGltZSBzdGF0dXMgcmVtYWlucyBhdmFpbGFibGUgaGVyZS5cIikpO1xuICBpZiAoW1wiZmFpbGVkXCIsIFwicXVhcmFudGluZWRcIiwgXCJ0aW1lZF9vdXRcIl0uaW5jbHVkZXMoaXRlbS5saWZlY3ljbGUpKSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHJvd0NvcHkoXCJSZWNvdmVyeVwiLCBcIkNsZWFyIHRoZSBmYWlsdXJlIGFuZCByZXRyeSB0aGlzIFR3ZWFrZXIgd2l0aG91dCByZW1vdmluZyBpdHMgZGF0YS5cIikpO1xuICAgIGNvbnN0IHJlY292ZXIgPSBjb21wYWN0QnV0dG9uKFwiUmVjb3ZlclwiLCAoKSA9PiB7XG4gICAgICByZWNvdmVyLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWNvdmVyLXR3ZWFrXCIsIGl0ZW0udHdlYWtJZCkuZmluYWxseSgoKSA9PiB7IHJlY292ZXIuZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgfSk7XG4gICAgcm93LmFwcGVuZENoaWxkKHJlY292ZXIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICByb290LmFwcGVuZENoaWxkKHNlY3Rpb24pO1xufVxuXG5mdW5jdGlvbiByb3dDb3B5KHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29weS5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2NyaXB0aW9uLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGRlc2NyaXB0aW9uLnRleHRDb250ZW50ID0gZGV0YWlsO1xuICBjb3B5LmFwcGVuZChoZWFkaW5nLCBkZXNjcmlwdGlvbik7XG4gIHJldHVybiBjb3B5O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb25maWdQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBzdWJ0aXRsZT86IEhUTUxFbGVtZW50LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGNsZWFudXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICBjb25zdCBjYXJkVXBkYXRlcyA9IG5ldyBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4oKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJFbnZpcm9ubWVudFNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKHNlY3Rpb25zV3JhcCwgY2FyZFVwZGF0ZXMpKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJNY3BJbnRlZ3JhdGlvblNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckF1dG9tYXRpY01haW50ZW5hbmNlU2VjdGlvbihzZWN0aW9uc1dyYXAsIGNhcmRVcGRhdGVzKSk7XG5cbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIlR3ZWFrZXJzIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJDb25maWdDYXJkID0gXCJ0cnVlXCI7XG4gIGNvbnN0IGxvYWRpbmcgPSByb3dTaW1wbGUoXCJMb2FkaW5nIHVwZGF0ZSBzZXR0aW5nc1wiLCBcIkNoZWNraW5nIGN1cnJlbnQgVHdlYWtlcnMgY29uZmlndXJhdGlvbi5cIik7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobG9hZGluZyk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvbmZpZ1wiKVxuICAgIC50aGVuKChjb25maWcpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IGBZb3UgaGF2ZSBUd2Vha2VycyAkeyhjb25maWcgYXMgVHdlYWtlckNvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZCwgY29uZmlnIGFzIFR3ZWFrZXJDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgVHdlYWtlcnMgdmVyc2lvbi5cIjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCB1cGRhdGUgc2V0dGluZ3NcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG5cbiAgcmVuZGVyQWR2YW5jZWRSdW50aW1lU2VjdGlvbihzZWN0aW9uc1dyYXApO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgZm9yIChjb25zdCBjbGVhbnVwIG9mIGNsZWFudXBzLnNwbGljZSgwKSkge1xuICAgICAgdHJ5IHsgY2xlYW51cCgpOyB9IGNhdGNoIHt9XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIENvZGV4LW5hdGl2ZSBlbnZpcm9ubWVudCBjb250cm9scy4gQXBwIGV4cGVyaWVuY2UgYW5kIHJlbGVhc2UgcHJvZmlsZSBhcmVcbiAqIGRlbGliZXJhdGVseSBpbmRlcGVuZGVudCBzZWxlY3Rpb25zOiBjaGFuZ2luZyBlaXRoZXIgb25lIG9ubHkgc3RhZ2VzIGFcbiAqIHBlbmRpbmcgdmFsdWUgdW50aWwgdGhlIHVzZXIgY2hvb3NlcyBBcHBseSAmIFJlc3RhcnQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckVudmlyb25tZW50U2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXBwIE1vZGUgJiBEZXNrdG9wIFJlbGVhc2VcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJFbnZpcm9ubWVudENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIGVudmlyb25tZW50XCIsIFwiQ2hlY2tpbmcgYXZhaWxhYmxlIGFwcCBleHBlcmllbmNlcyBhbmQgcmVsZWFzZSBwcm9maWxlcy5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGVudmlyb25tZW50OiBFbnZpcm9ubWVudFN0YXR1cyB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24gfCBudWxsID0gbnVsbDtcbiAgbGV0IGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICBsZXQgZW52aXJvbm1lbnRBY3Rpb25FcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvblBvbGxpbmc6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgY3VycmVudFNlbGVjdGlvbiA9ICgpOiBFbnZpcm9ubWVudFNlbGVjdGlvbiB8IG51bGwgPT4gZW52aXJvbm1lbnQ/LnNlbGVjdGVkID8/IG51bGw7XG4gIGNvbnN0IGhhc1BlbmRpbmdDaGFuZ2VzID0gKCk6IGJvb2xlYW4gPT4gZW52aXJvbm1lbnQgIT09IG51bGwgJiYgZW52aXJvbm1lbnRDb250cm9sbGVyLnNuYXBzaG90Lmhhc1BlbmRpbmdDaGFuZ2VzO1xuICBjb25zdCBpc0Vudmlyb25tZW50QnVzeSA9ICgpOiBib29sZWFuID0+IGV4dGVybmFsQnVzeSB8fCBlbnZpcm9ubWVudENvbnRyb2xsZXIuc25hcHNob3QuYnVzeTtcblxuICBjb25zdCByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uIHx8ICh0cmFuc2FjdGlvbi5waGFzZSAhPT0gXCJwcmVwYXJpbmdcIiAmJiB0cmFuc2FjdGlvbi5waGFzZSAhPT0gXCJwcmVwYXJlZFwiKSkgcmV0dXJuO1xuICAgIGNvbnN0IHJlcXVlc3RlZCA9IGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24odHJhbnNhY3Rpb24pO1xuICAgIGlmIChyZXF1ZXN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5yZXN0b3JlUGVuZGluZyhyZXF1ZXN0ZWQpO1xuICB9O1xuXG4gIGNvbnN0IHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHRyYW5zYWN0aW9uUG9sbGluZykgY2xlYXJUaW1lb3V0KHRyYW5zYWN0aW9uUG9sbGluZyk7XG4gICAgdHJhbnNhY3Rpb25Qb2xsaW5nID0gbnVsbDtcbiAgICBpZiAoXG4gICAgICAhY2FyZC5pc0Nvbm5lY3RlZFxuICAgICAgfHwgIXRyYW5zYWN0aW9uXG4gICAgICB8fCBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbCh0cmFuc2FjdGlvbi5waGFzZSlcbiAgICApIHJldHVybjtcbiAgICB0cmFuc2FjdGlvblBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gICAgfSwgOTAwKTtcbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBwcmVwYXJlRW52aXJvbm1lbnRTZWxlY3Rpb24oXG4gICAgcmVxdWVzdGVkOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4sXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRUcmFuc2FjdGlvbj4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cHJlcGFyZS1lbnZpcm9ubWVudFwiLCByZXF1ZXN0ZWQpO1xuICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IHByZXBhcmF0aW9uIHdhcyBzdXBlcnNlZGVkXCIpO1xuICAgIGNvbnN0IHJlY2VpcHQgPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHByZXBhcmVkKTtcbiAgICBpZiAoIXJlY2VpcHQpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IHByZXBhcmF0aW9uIHJldHVybmVkIG5vIHRyYW5zYWN0aW9uIHJlY2VpcHRcIik7XG4gICAgdHJhbnNhY3Rpb24gPSByZWNlaXB0O1xuICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICByZXR1cm4gcmVjZWlwdDtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNvbW1pdFByZXBhcmVkRW52aXJvbm1lbnQocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICBsZXQgcmVzdWx0OiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvbW1pdC1lbnZpcm9ubWVudFwiLCB7IHRyYW5zYWN0aW9uSWQ6IHJlY2VpcHQudHJhbnNhY3Rpb25JZCB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBzdWJtaXQgZW52aXJvbm1lbnQgY2hhbmdlOiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgdHJhbnNhY3Rpb24gPSB7IC4uLnJlY2VpcHQsIGVycm9yOiBkZXRhaWwgfTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihkZXRhaWwpO1xuICAgIH1cbiAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCBjb29yZGluYXRvciBzdWJtaXNzaW9uIHdhcyBzdXBlcnNlZGVkXCIpO1xuICAgIGNvbnN0IHN1Ym1pc3Npb24gPSBub3JtYWxpemVFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24ocmVzdWx0KTtcbiAgICBjb25zdCBvYnNlcnZlZCA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVzdWx0KTtcbiAgICB0cmFuc2FjdGlvbiA9IHN1Ym1pc3Npb25cbiAgICAgID8ge1xuICAgICAgICAuLi5yZWNlaXB0LFxuICAgICAgICBlcnJvcjogc3VibWlzc2lvbi5lcnJvciA/PyBudWxsLFxuICAgICAgICBoZWxwZXI6IHsgLi4uKHJlY2VpcHQuaGVscGVyID8/IHt9KSwgc3VibWlzc2lvbiB9LFxuICAgICAgfVxuICAgICAgOiBvYnNlcnZlZCA/PyByZWNlaXB0O1xuICAgIHJlc3RvcmVQZXJzaXN0ZWRSZXF1ZXN0KCk7XG4gICAgaWYgKHN1Ym1pc3Npb24/LnBoYXNlID09PSBcInN1Ym1pdC1mYWlsZWRcIikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBzdWJtaXQgZW52aXJvbm1lbnQgY2hhbmdlOiAke3N1Ym1pc3Npb24uZXJyb3IgfHwgXCJFbnZpcm9ubWVudCBjb29yZGluYXRvciBzdWJtaXNzaW9uIGZhaWxlZFwifWA7XG4gICAgICB0cmFuc2FjdGlvbiA9IHsgLi4udHJhbnNhY3Rpb24sIGVycm9yOiBkZXRhaWwgfTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihkZXRhaWwpO1xuICAgIH1cbiAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjYW5jZWxQcmVwYXJlZEVudmlyb25tZW50KHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNhbmNlbC1lbnZpcm9ubWVudFwiLCB7IHRyYW5zYWN0aW9uSWQ6IHJlY2VpcHQudHJhbnNhY3Rpb25JZCB9KTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IGNhbmNlbGxhdGlvbiB3YXMgc3VwZXJzZWRlZFwiKTtcbiAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpID8/IHJlY2VpcHQ7XG4gICAgICBpZiAodHJhbnNhY3Rpb24ucGhhc2UgIT09IFwiY2FuY2VsbGVkXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnZpcm9ubWVudCBjYW5jZWxsYXRpb24gcmV0dXJuZWQgJHt0cmFuc2FjdGlvbi5waGFzZX1gKTtcbiAgICAgIH1cbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBjYW5jZWwgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb246ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICB0cmFuc2FjdGlvbiA9IHsgLi4ucmVjZWlwdCwgZXJyb3I6IGRldGFpbCB9O1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGRldGFpbCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZW52aXJvbm1lbnRDb250cm9sbGVyID0gY3JlYXRlRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyPEVudmlyb25tZW50VHJhbnNhY3Rpb24+KFxuICAgIHsgYXBwRXhwZXJpZW5jZTogXCJjaGF0Z3B0XCIsIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiIH0sXG4gICAge1xuICAgICAgcHJlcGFyZTogcHJlcGFyZUVudmlyb25tZW50U2VsZWN0aW9uLFxuICAgICAgY29uZmlybTogKHJlcXVlc3RlZCwgcmVjZWlwdCkgPT4gb3BlbkVudmlyb25tZW50Q29uZmlybU1vZGFsKHJlcXVlc3RlZCwgcmVjZWlwdCksXG4gICAgICBjb21taXQ6IGNvbW1pdFByZXBhcmVkRW52aXJvbm1lbnQsXG4gICAgICBjYW5jZWw6IGNhbmNlbFByZXBhcmVkRW52aXJvbm1lbnQsXG4gICAgfSxcbiAgICB7XG4gICAgICBvbkNoYW5nZTogKHNuYXBzaG90KSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBzbmFwc2hvdC5lcnJvcjtcbiAgICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQpIGRyYXcoKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICBmdW5jdGlvbiBvcGVuUHJlcGFyZWRFbnZpcm9ubWVudENvbmZpcm1hdGlvbihcbiAgICByZXF1ZXN0ZWQ6IFBpY2s8RW52aXJvbm1lbnRTZWxlY3Rpb24sIFwiYXBwRXhwZXJpZW5jZVwiIHwgXCJyZWxlYXNlUHJvZmlsZVwiPixcbiAgICByZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuICApOiB2b2lkIHtcbiAgICBpZiAocmVjZWlwdC5waGFzZSAhPT0gXCJwcmVwYXJlZFwiKSByZXR1cm47XG4gICAgdm9pZCBlbnZpcm9ubWVudENvbnRyb2xsZXIucmVzdW1lUHJlcGFyZWQocmVxdWVzdGVkLCByZWNlaXB0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbmNlbEVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHZvaWQge1xuICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8IChyZWNlaXB0LnBoYXNlICE9PSBcInByZXBhcmluZ1wiICYmIHJlY2VpcHQucGhhc2UgIT09IFwicHJlcGFyZWRcIikpIHJldHVybjtcbiAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICBleHRlcm5hbEJ1c3kgPSB0cnVlO1xuICAgIGRyYXcoKTtcbiAgICB2b2lkIGNhbmNlbFByZXBhcmVkRW52aXJvbm1lbnQocmVjZWlwdClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBjdXJyZW50U2VsZWN0aW9uKCk7XG4gICAgICAgIGlmICh0cmFuc2FjdGlvbj8ucGhhc2UgPT09IFwiY2FuY2VsbGVkXCIgJiYgc2VsZWN0ZWQpIHtcbiAgICAgICAgICBlbnZpcm9ubWVudENvbnRyb2xsZXIuc2V0U2VsZWN0ZWQoc2VsZWN0ZWQpO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gc2FmZVVpRXJyb3IoZXJyb3IpO1xuICAgICAgfSlcbiAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVjb3ZlckVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHZvaWQge1xuICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8ICFlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3ZlcihyZWNlaXB0KSkgcmV0dXJuO1xuICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgIGV4dGVybmFsQnVzeSA9IHRydWU7XG4gICAgZHJhdygpO1xuICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgIC5pbnZva2UoXCJ0d2Vha2VyOnJvbGxiYWNrLWVudmlyb25tZW50XCIsIHsgdHJhbnNhY3Rpb25JZDogcmVjZWlwdC50cmFuc2FjdGlvbklkIH0pXG4gICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpID8/IHJlY2VpcHQ7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgICAgICBleHRlcm5hbEJ1c3kgPSBmYWxzZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gYENvdWxkIG5vdCByZWNvdmVyIHRoZSBhcHAgbW9kZSBzYWZlbHk6ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgIC4uLnJlY2VpcHQsXG4gICAgICAgICAgZXJyb3I6IGVudmlyb25tZW50QWN0aW9uRXJyb3IsXG4gICAgICAgIH07XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gYXBwZW5kRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvdygpOiB2b2lkIHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVjZWlwdCA9IHRyYW5zYWN0aW9uO1xuICAgIGNvbnN0IHJlcXVlc3RlZCA9IGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24ocmVjZWlwdCk7XG4gICAgY29uc3QgaGVscGVySW5GbGlnaHQgPSBlbnZpcm9ubWVudEhlbHBlcklzSW5GbGlnaHQocmVjZWlwdCk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChlbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KHJlY2VpcHQsIHtcbiAgICAgIGJ1c3k6IGlzRW52aXJvbm1lbnRCdXN5KCksXG4gICAgICBvblJlc3VtZTogcmVjZWlwdC5waGFzZSA9PT0gXCJwcmVwYXJlZFwiICYmIHJlcXVlc3RlZCAmJiAhaGVscGVySW5GbGlnaHRcbiAgICAgICAgPyAoKSA9PiBvcGVuUHJlcGFyZWRFbnZpcm9ubWVudENvbmZpcm1hdGlvbihyZXF1ZXN0ZWQsIHJlY2VpcHQpXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgb25DYW5jZWw6IChyZWNlaXB0LnBoYXNlID09PSBcInByZXBhcmluZ1wiIHx8IHJlY2VpcHQucGhhc2UgPT09IFwicHJlcGFyZWRcIikgJiYgIWhlbHBlckluRmxpZ2h0XG4gICAgICAgID8gKCkgPT4gY2FuY2VsRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIG9uUmVjb3ZlcjogZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIocmVjZWlwdClcbiAgICAgICAgPyAoKSA9PiByZWNvdmVyRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KSk7XG4gIH1cblxuICBjb25zdCBkcmF3ID0gKCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gY3VycmVudFNlbGVjdGlvbigpO1xuICAgIGlmICghc2VsZWN0ZWQgfHwgIWVudmlyb25tZW50KSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IHVuYXZhaWxhYmxlXCIsIFwiVGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgc2VsZWN0aW9uIGNvdWxkIG5vdCBiZSBsb2FkZWQuXCIpKTtcbiAgICAgIGFwcGVuZEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coKTtcbiAgICAgIGlmIChlbnZpcm9ubWVudEFjdGlvbkVycm9yICYmIGVudmlyb25tZW50QWN0aW9uRXJyb3IgIT09IHRyYW5zYWN0aW9uPy5lcnJvcikge1xuICAgICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IGFjdGlvbiBmYWlsZWRcIiwgZW52aXJvbm1lbnRBY3Rpb25FcnJvcikpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBwZW5kaW5nID0gZW52aXJvbm1lbnRDb250cm9sbGVyLnNuYXBzaG90LnBlbmRpbmc7XG4gICAgY29uc3QgYnVzeSA9IGlzRW52aXJvbm1lbnRCdXN5KCk7XG4gICAgY29uc3Qgb2JzZXJ2ZWRFeHBlcmllbmNlID0gZW52aXJvbm1lbnQub2JzZXJ2YXRpb24/LmFwcEV4cGVyaWVuY2U7XG4gICAgY29uc3Qgb2JzZXJ2YXRpb25OZWVkc1JlcGFpciA9IGVudmlyb25tZW50Lm9ic2VydmF0aW9uICE9PSB1bmRlZmluZWRcbiAgICAgICYmIChvYnNlcnZlZEV4cGVyaWVuY2UgPT09IG51bGxcbiAgICAgICAgfHwgb2JzZXJ2ZWRFeHBlcmllbmNlICE9PSBzZWxlY3RlZC5hcHBFeHBlcmllbmNlXG4gICAgICAgIHx8IGVudmlyb25tZW50Lm9ic2VydmF0aW9uLnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudCk7XG4gICAgY29uc3QgZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgPSBidXN5XG4gICAgICB8fCBvYnNlcnZhdGlvbk5lZWRzUmVwYWlyXG4gICAgICB8fCAodHJhbnNhY3Rpb24gIT09IG51bGwgJiYgKFxuICAgICAgICAhZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwodHJhbnNhY3Rpb24ucGhhc2UpXG4gICAgICAgIHx8IGVudmlyb25tZW50VHJhbnNhY3Rpb25DYW5SZWNvdmVyKHRyYW5zYWN0aW9uKVxuICAgICAgKSk7XG5cbiAgICBpZiAob2JzZXJ2YXRpb25OZWVkc1JlcGFpcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gZW52aXJvbm1lbnQub2JzZXJ2YXRpb24/LnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudFxuICAgICAgICA/IFwiQSBsZWdhY3kgbW9kZSB0cmFuc2l0aW9uIGlzIHN0aWxsIHByZXNlbnQuIFJ1biB0d2Vha2VyIHJlcGFpciBpbiBUZXJtaW5hbCBiZWZvcmUgc3dpdGNoaW5nLlwiXG4gICAgICAgIDogb2JzZXJ2ZWRFeHBlcmllbmNlID09PSBudWxsIHx8IG9ic2VydmVkRXhwZXJpZW5jZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyBcIlRoZSBsaXZlIGFwcCBtYXJrZXIgY291bGQgbm90IGJlIHZlcmlmaWVkLiBSdW4gdHdlYWtlciByZXBhaXIgaW4gVGVybWluYWwgYmVmb3JlIHN3aXRjaGluZy5cIlxuICAgICAgICAgIDogYFNhdmVkIG1vZGUgaXMgJHtlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbChzZWxlY3RlZC5hcHBFeHBlcmllbmNlKX0sIGJ1dCB0aGUgbGl2ZSBhcHAgcHJvdmVzICR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwob2JzZXJ2ZWRFeHBlcmllbmNlKX0uIFJ1biB0d2Vha2VyIHJlcGFpciBpbiBUZXJtaW5hbC5gO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJFbnZpcm9ubWVudCBuZWVkcyByZXBhaXJcIiwgZGV0YWlsKSk7XG4gICAgfVxuXG4gICAgY29uc3QgcGVuZGluZ0F2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCBwZW5kaW5nKTtcbiAgICBjb25zdCBjaGF0Z3B0QXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IFwiY2hhdGdwdFwiLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IHBlbmRpbmcucmVsZWFzZVByb2ZpbGUsXG4gICAgfSk7XG4gICAgY29uc3QgdHdlYWtlcnNBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwge1xuICAgICAgYXBwRXhwZXJpZW5jZTogXCJ0d2Vha2Vyc1wiLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IHBlbmRpbmcucmVsZWFzZVByb2ZpbGUsXG4gICAgfSk7XG5cbiAgICBjYXJkLmFwcGVuZENoaWxkKGVudmlyb25tZW50Q2hvaWNlUm93KFxuICAgICAgXCJBcHAgTW9kZVwiLFxuICAgICAgXCJDaGF0R1BUIGRpc2FibGVzIGV2ZXJ5IHR3ZWFrLiBUd2Vha2VycyByZXN0b3JlcyB0aGUgdHdlYWtzIHlvdSBwcmV2aW91c2x5IGVuYWJsZWQuXCIsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICB2YWx1ZTogXCJjaGF0Z3B0XCIsXG4gICAgICAgICAgbGFiZWw6IFwiQ2hhdEdQVFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBjaGF0Z3B0QXZhaWxhYmlsaXR5LmF2YWlsYWJsZVxuICAgICAgICAgICAgPyBcIk9wZW5BSSdzIHN0YW5kYXJkIGFwcCBleHBlcmllbmNlLlwiXG4gICAgICAgICAgICA6IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oY2hhdGdwdEF2YWlsYWJpbGl0eSwgXCJDaGF0R1BUIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICFjaGF0Z3B0QXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKGNoYXRncHRBdmFpbGFiaWxpdHksIFwiQ2hhdEdQVCBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IFwidHdlYWtlcnNcIixcbiAgICAgICAgICBsYWJlbDogXCJUd2Vha2Vyc1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiB0d2Vha2Vyc0F2YWlsYWJpbGl0eS5hdmFpbGFibGVcbiAgICAgICAgICAgID8gXCJUaGUgc3RhbmRhcmQgYXBwIHdpdGggZW5hYmxlZCBUd2Vha2VycyBmZWF0dXJlcy5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKHR3ZWFrZXJzQXZhaWxhYmlsaXR5LCBcIlR3ZWFrZXJzIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICF0d2Vha2Vyc0F2YWlsYWJpbGl0eS5hdmFpbGFibGUsXG4gICAgICAgICAgZGlzYWJsZWRSZWFzb246IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICAgICAgICA/IFwiRmluaXNoLCBjYW5jZWwsIG9yIHJlY292ZXIgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gZmlyc3QuXCJcbiAgICAgICAgICAgIDogZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbih0d2Vha2Vyc0F2YWlsYWJpbGl0eSwgXCJUd2Vha2VycyBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgICh2YWx1ZSkgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudENvbnRyb2xsZXIuc3RhZ2VBcHBFeHBlcmllbmNlKHZhbHVlIGFzIEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSk7XG4gICAgICB9LFxuICAgICkpO1xuXG4gICAgY29uc3Qgc3RhYmxlQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiLFxuICAgIH0pO1xuICAgIGNvbnN0IGFscGhhQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBcImFscGhhXCIsXG4gICAgfSk7XG4gICAgY29uc3Qgc3RhYmxlUmVhc29uID0gZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihzdGFibGVBdmFpbGFiaWxpdHksIFwiU3RhYmxlIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIGFwcCBleHBlcmllbmNlLlwiKTtcbiAgICBjb25zdCBhbHBoYVJlYXNvbiA9IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oYWxwaGFBdmFpbGFiaWxpdHksIFwiQWxwaGEgKFByZS1yZWxlYXNlKSBpcyB1bmF2YWlsYWJsZSBvbiB0aGlzIE1hYy5cIik7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChlbnZpcm9ubWVudENob2ljZVJvdyhcbiAgICAgIFwiRGVza3RvcCBSZWxlYXNlXCIsXG4gICAgICBcIkNob29zZSBPcGVuQUkncyBTdGFibGUgb3IgQWxwaGEgZGVza3RvcCBhcHAgaW5kZXBlbmRlbnRseSBvZiBhcHAgbW9kZS4gSXRzIGVtYmVkZGVkIENvZGV4IGJhY2tlbmQgY2FuIGhhdmUgYSBkaWZmZXJlbnQgdmVyc2lvbiBsYWJlbC5cIixcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcInN0YWJsZVwiLFxuICAgICAgICAgIGxhYmVsOiBcIlN0YWJsZVwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBzdGFibGVBdmFpbGFiaWxpdHkuYXZhaWxhYmxlID8gXCJUaGUgc3VwcG9ydGVkIHN0YWJsZSBkZXNrdG9wIHJlbGVhc2UuXCIgOiBzdGFibGVSZWFzb24sXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICFzdGFibGVBdmFpbGFiaWxpdHkuYXZhaWxhYmxlLFxuICAgICAgICAgIGRpc2FibGVkUmVhc29uOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgICAgICAgPyBcIkZpbmlzaCwgY2FuY2VsLCBvciByZWNvdmVyIHRoZSBjdXJyZW50IGVudmlyb25tZW50IHRyYW5zYWN0aW9uIGZpcnN0LlwiXG4gICAgICAgICAgICA6IHN0YWJsZVJlYXNvbixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcImFscGhhXCIsXG4gICAgICAgICAgbGFiZWw6IFwiQWxwaGEgKFByZS1yZWxlYXNlKVwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBhbHBoYUF2YWlsYWJpbGl0eS5hdmFpbGFibGUgPyBcIk9wZW5BSSdzIHZlcmlmaWVkIHByZS1yZWxlYXNlIGRlc2t0b3AgYW5kIG1hdGNoaW5nIGJhY2tlbmQuXCIgOiBhbHBoYVJlYXNvbixcbiAgICAgICAgICBkaXNhYmxlZDogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgfHwgIWFscGhhQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBhbHBoYVJlYXNvbixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBwZW5kaW5nLnJlbGVhc2VQcm9maWxlLFxuICAgICAgKHZhbHVlKSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50Q29udHJvbGxlci5zdGFnZVJlbGVhc2VQcm9maWxlKHZhbHVlIGFzIEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUpO1xuICAgICAgfSxcbiAgICApKTtcbiAgICBpZiAoIWFscGhhQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSkge1xuICAgICAgY29uc3QgY2hvb3NlciA9IGFjdGlvblJvdyhcbiAgICAgICAgXCJBbHBoYSAoUHJlLXJlbGVhc2UpIHVuYXZhaWxhYmxlXCIsXG4gICAgICAgIGAke2FscGhhUmVhc29ufSBDaG9vc2UgYSB2ZXJpZmllZCBPcGVuQUkgQmV0YSBhcHAgdG8gcmVnaXN0ZXIgaXQgZm9yIHRoaXMgcHJvZmlsZS5gLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGNob29zZXJBY3Rpb25zID0gY2hvb3Nlci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgICAgY29uc3QgY2hvb3NlID0gY29tcGFjdEJ1dHRvbihcIkNob29zZSBCZXRhIEFwcFx1MjAyNlwiLCAoKSA9PiB7XG4gICAgICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpKSByZXR1cm47XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IHRydWU7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjaG9vc2UtYWxwaGEtZW52aXJvbm1lbnRcIilcbiAgICAgICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0ICYmIHR5cGVvZiByZXN1bHQgPT09IFwib2JqZWN0XCIgJiYgXCJjYW5jZWxlZFwiIGluIHJlc3VsdCAmJiByZXN1bHQuY2FuY2VsZWQgPT09IHRydWUpIHJldHVybjtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBgQ291bGQgbm90IHJlZ2lzdGVyIE9wZW5BSSBCZXRhOiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgICAgICB2b2lkIGxvYWQoKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgY2hvb3NlLmRpc2FibGVkID0gaXNFbnZpcm9ubWVudEJ1c3koKTtcbiAgICAgIGNob29zZXJBY3Rpb25zPy5hcHBlbmRDaGlsZChjaG9vc2UpO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChjaG9vc2VyKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gYWN0aW9uUm93KFxuICAgICAgXCJQZW5kaW5nIGNoYW5nZXNcIixcbiAgICAgIGhhc1BlbmRpbmdDaGFuZ2VzKClcbiAgICAgICAgPyBwZW5kaW5nQXZhaWxhYmlsaXR5LmF2YWlsYWJsZVxuICAgICAgICAgID8gYCR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwocGVuZGluZy5hcHBFeHBlcmllbmNlKX0gXHUwMEI3ICR7ZW52aXJvbm1lbnRQcm9maWxlTGFiZWwocGVuZGluZy5yZWxlYXNlUHJvZmlsZSl9IHdpbGwgYXBwbHkgYWZ0ZXIgcmVzdGFydC5gXG4gICAgICAgICAgOiBgVW5hdmFpbGFibGU6ICR7ZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihwZW5kaW5nQXZhaWxhYmlsaXR5LCBcIlRoaXMgZW52aXJvbm1lbnQgY2Fubm90IGJlIHByZXBhcmVkLlwiKX1gXG4gICAgICAgIDogYEN1cnJlbnQ6ICR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwoc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSl9IFx1MDBCNyAke2Vudmlyb25tZW50UHJvZmlsZUxhYmVsKHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlKX0uYCxcbiAgICApO1xuICAgIGNvbnN0IGFjdGlvbnMgPSBzdW1tYXJ5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgYXBwbHkgPSBjb21wYWN0QnV0dG9uKFwiQXBwbHkgJiBSZXN0YXJ0XCIsICgpID0+IHtcbiAgICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8ICFoYXNQZW5kaW5nQ2hhbmdlcygpKSByZXR1cm47XG4gICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICAgIHZvaWQgZW52aXJvbm1lbnRDb250cm9sbGVyLmFwcGx5QW5kUmVzdGFydCgpXG4gICAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0Lm91dGNvbWUgPT09IFwicHJlcGFyZS1mYWlsZWRcIikge1xuICAgICAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IHJlc3VsdC5lcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlc3VsdC5vdXRjb21lLmVuZHNXaXRoKFwiZmFpbGVkXCIpKSB7XG4gICAgICAgICAgICBkcmF3KCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHZvaWQgbG9hZEVudmlyb25tZW50VHJhbnNhY3Rpb24oKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYXBwbHkuZGlzYWJsZWQgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgfHwgIWhhc1BlbmRpbmdDaGFuZ2VzKClcbiAgICAgIHx8ICFwZW5kaW5nQXZhaWxhYmlsaXR5LmF2YWlsYWJsZTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChhcHBseSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcbiAgICBhcHBlbmRFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KCk7XG4gICAgaWYgKGVudmlyb25tZW50QWN0aW9uRXJyb3IgJiYgZW52aXJvbm1lbnRBY3Rpb25FcnJvciAhPT0gdHJhbnNhY3Rpb24/LmVycm9yKSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IGFjdGlvbiBmYWlsZWRcIiwgZW52aXJvbm1lbnRBY3Rpb25FcnJvcikpO1xuICAgIH1cbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBsb2FkRW52aXJvbm1lbnRUcmFuc2FjdGlvbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IHByZXZpb3VzID0gdHJhbnNhY3Rpb247XG4gICAgICB0cmFuc2FjdGlvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVzdWx0KTtcbiAgICAgIGlmIChcbiAgICAgICAgdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmVkXCJcbiAgICAgICAgJiYgIXRyYW5zYWN0aW9uLmhlbHBlclxuICAgICAgICAmJiBwcmV2aW91cz8udHJhbnNhY3Rpb25JZCA9PT0gdHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZFxuICAgICAgICAmJiBwcmV2aW91cy5oZWxwZXJcbiAgICAgICkge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IHtcbiAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICBlcnJvcjogdHJhbnNhY3Rpb24uZXJyb3IgPz8gcHJldmlvdXMuZXJyb3IsXG4gICAgICAgICAgaGVscGVyOiBwcmV2aW91cy5oZWxwZXIsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCgpO1xuICAgICAgZHJhdygpO1xuICAgICAgaWYgKHRyYW5zYWN0aW9uICYmIGVudmlyb25tZW50VHJhbnNhY3Rpb25Jc1Rlcm1pbmFsKHRyYW5zYWN0aW9uLnBoYXNlKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHN0YXR1c1VwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgICAgICAgIGNvbnN0IHN0YXR1c1Jlc3VsdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICAgICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpIHx8ICFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICAgIGVudmlyb25tZW50ID0gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXMoc3RhdHVzUmVzdWx0KSA/PyBlbnZpcm9ubWVudDtcbiAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGN1cnJlbnRTZWxlY3Rpb24oKTtcbiAgICAgICAgICBpZiAoc2VsZWN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5zZXRTZWxlY3RlZChzZWxlY3RlZCk7XG4gICAgICAgICAgZHJhdygpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgICAgLi4udHJhbnNhY3Rpb24sXG4gICAgICAgICAgICBlcnJvcjogdHJhbnNhY3Rpb24uZXJyb3IgPz8gYENvdWxkIG5vdCByZWZyZXNoIGVudmlyb25tZW50IHN0YXR1czogJHtzYWZlVWlFcnJvcihlcnJvcil9YCxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGRyYXcoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBpZiAodHJhbnNhY3Rpb24pIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgLi4udHJhbnNhY3Rpb24sXG4gICAgICAgICAgZXJyb3I6IGBDb3VsZCBub3QgcmVmcmVzaCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbjogJHtzYWZlVWlFcnJvcihlcnJvcil9YCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGRyYXcoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKGNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbG9hZCA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBjb25zdCBzdGF0dXNVcGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjb25zdCB0cmFuc2FjdGlvblVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IFtzdGF0dXNSZXN1bHQsIHRyYW5zYWN0aW9uUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtZW52aXJvbm1lbnQtc3RhdHVzXCIpLFxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKSxcbiAgICAgIF0pO1xuICAgICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjb25zdCBzdGF0dXNJc0N1cnJlbnQgPSBjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKTtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uSXNDdXJyZW50ID0gY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHRyYW5zYWN0aW9uVXBkYXRlKTtcbiAgICAgIGlmICghc3RhdHVzSXNDdXJyZW50ICYmICF0cmFuc2FjdGlvbklzQ3VycmVudCkgcmV0dXJuO1xuICAgICAgaWYgKHN0YXR1c0lzQ3VycmVudCkge1xuICAgICAgICBlbnZpcm9ubWVudCA9IG5vcm1hbGl6ZUVudmlyb25tZW50U3RhdHVzKHN0YXR1c1Jlc3VsdCk7XG4gICAgICAgIGlmIChlbnZpcm9ubWVudD8uc2VsZWN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5zZXRTZWxlY3RlZChlbnZpcm9ubWVudC5zZWxlY3RlZCk7XG4gICAgICB9XG4gICAgICBpZiAodHJhbnNhY3Rpb25Jc0N1cnJlbnQpIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHRyYW5zYWN0aW9uUmVzdWx0KTtcbiAgICAgICAgcmVzdG9yZVBlcnNpc3RlZFJlcXVlc3QoKTtcbiAgICAgIH1cbiAgICAgIGRyYXcoKTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHN0YXR1c1VwZGF0ZSkgJiYgIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh0cmFuc2FjdGlvblVwZGF0ZSkpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGxvYWQgZW52aXJvbm1lbnRcIiwgc2FmZVVpRXJyb3IoZXJyb3IpKSk7XG4gICAgfVxuICB9O1xuXG4gIHZvaWQgbG9hZCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIGlmICh0cmFuc2FjdGlvblBvbGxpbmcpIGNsZWFyVGltZW91dCh0cmFuc2FjdGlvblBvbGxpbmcpO1xuICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24oXG4gIHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuKTogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+IHwgbnVsbCB7XG4gIGNvbnN0IHJlcXVlc3RlZCA9IHRyYW5zYWN0aW9uLnJlcXVlc3RlZDtcbiAgaWYgKCFyZXF1ZXN0ZWQpIHJldHVybiBudWxsO1xuICBpZiAocmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwiY2hhdGdwdFwiICYmIHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlICE9PSBcInR3ZWFrZXJzXCIpIHJldHVybiBudWxsO1xuICBpZiAocmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcInN0YWJsZVwiICYmIHJlcXVlc3RlZC5yZWxlYXNlUHJvZmlsZSAhPT0gXCJhbHBoYVwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgYXBwRXhwZXJpZW5jZTogcmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UsIHJlbGVhc2VQcm9maWxlOiByZXF1ZXN0ZWQucmVsZWFzZVByb2ZpbGUgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwocGhhc2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gW1wiY29tbWl0dGVkXCIsIFwiY29tcGxldGVkXCIsIFwicm9sbGVkLWJhY2tcIiwgXCJyb2xsZWRfYmFja1wiLCBcImZhaWxlZFwiLCBcImNhbmNlbGxlZFwiXS5pbmNsdWRlcyhwaGFzZSk7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50Q2hvaWNlUm93KFxuICB0aXRsZTogc3RyaW5nLFxuICBkZXNjcmlwdGlvbjogc3RyaW5nLFxuICBjaG9pY2VzOiBBcnJheTx7IHZhbHVlOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmc7IGRpc2FibGVkPzogYm9vbGVhbjsgZGlzYWJsZWRSZWFzb24/OiBzdHJpbmcgfT4sXG4gIHNlbGVjdGVkOiBzdHJpbmcsXG4gIG9uQ2hhbmdlOiAodmFsdWU6IHN0cmluZykgPT4gdm9pZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtc3RhcnQganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gcm93Q29weSh0aXRsZSwgZGVzY3JpcHRpb24pO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgZmxleC13cmFwIHJvdW5kZWQtbGcgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMC41XCI7XG4gIGFjdGlvbnMuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcImdyb3VwXCIpO1xuICBhY3Rpb25zLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGl0bGUpO1xuICBmb3IgKGNvbnN0IGNob2ljZSBvZiBjaG9pY2VzKSB7XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBidXR0b24udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gY2hvaWNlLmxhYmVsO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGNob2ljZS5kaXNhYmxlZCA9PT0gdHJ1ZTtcbiAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhjaG9pY2UudmFsdWUgPT09IHNlbGVjdGVkKSk7XG4gICAgaWYgKGNob2ljZS5kaXNhYmxlZCkgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtZGlzYWJsZWRcIiwgXCJ0cnVlXCIpO1xuICAgIGlmIChjaG9pY2UuZGlzYWJsZWRSZWFzb24pIGJ1dHRvbi50aXRsZSA9IGNob2ljZS5kaXNhYmxlZFJlYXNvbjtcbiAgICBidXR0b24uY2xhc3NOYW1lID0gYHJvdW5kZWQtbWQgcHgtMyBweS0xLjUgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyICR7Y2hvaWNlLnZhbHVlID09PSBzZWxlY3RlZCA/IFwiYmctdG9rZW4tYmctcHJpbWFyeSBzaGFkb3ctc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIiA6IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3Zlcjp0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwifWA7XG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvbkNoYW5nZShjaG9pY2UudmFsdWUpKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gIH1cbiAgY29uc3QgZGlzYWJsZWRSZWFzb24gPSBjaG9pY2VzLmZpbmQoKGNob2ljZSkgPT4gY2hvaWNlLmRpc2FibGVkICYmIGNob2ljZS5kaXNhYmxlZFJlYXNvbik/LmRpc2FibGVkUmVhc29uO1xuICBpZiAoZGlzYWJsZWRSZWFzb24pIHtcbiAgICBjb25zdCByZWFzb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJlYXNvbi5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgdGV4dC14c1wiO1xuICAgIHJlYXNvbi50ZXh0Q29udGVudCA9IGRpc2FibGVkUmVhc29uO1xuICAgIGxlZnQuYXBwZW5kQ2hpbGQocmVhc29uKTtcbiAgfVxuICByb3cuYXBwZW5kKGxlZnQsIGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbCh2YWx1ZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNoYXRncHRcIiA/IFwiQ2hhdEdQVFwiIDogXCJUd2Vha2Vyc1wiO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShcbiAgZW52aXJvbm1lbnQ6IEVudmlyb25tZW50U3RhdHVzLFxuICBzZWxlY3Rpb246IFBpY2s8RW52aXJvbm1lbnRTZWxlY3Rpb24sIFwiYXBwRXhwZXJpZW5jZVwiIHwgXCJyZWxlYXNlUHJvZmlsZVwiPixcbik6IHsgYXZhaWxhYmxlOiBib29sZWFuOyB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY2hhbm5lbCA9IGVudmlyb25tZW50LmNoYW5uZWxzW3NlbGVjdGlvbi5yZWxlYXNlUHJvZmlsZV07XG4gIHJldHVybiBjaGFubmVsLmF2YWlsYWJpbGl0eT8uW3NlbGVjdGlvbi5hcHBFeHBlcmllbmNlXSA/PyB7XG4gICAgYXZhaWxhYmxlOiBjaGFubmVsLmF2YWlsYWJsZSxcbiAgICB1bmF2YWlsYWJsZVJlYXNvbnM6IGNoYW5uZWwudW5hdmFpbGFibGVSZWFzb25zLFxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKFxuICBhdmFpbGFiaWxpdHk6IHsgdW5hdmFpbGFibGVSZWFzb25zPzogc3RyaW5nW10gfSxcbiAgZmFsbGJhY2s6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBhdmFpbGFiaWxpdHkudW5hdmFpbGFibGVSZWFzb25zPy5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIikgfHwgZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50UHJvZmlsZUxhYmVsKHZhbHVlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImFscGhhXCIgPyBcIkFscGhhIChQcmUtcmVsZWFzZSlcIiA6IFwiU3RhYmxlXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50U3RhdHVzKHZhbHVlOiB1bmtub3duKTogRW52aXJvbm1lbnRTdGF0dXMgfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPEVudmlyb25tZW50U3RhdHVzPjtcbiAgY29uc3Qgc2VsZWN0ZWQgPSBjYW5kaWRhdGUuc2VsZWN0ZWQ7XG4gIGlmICghc2VsZWN0ZWQgfHwgKHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwiY2hhdGdwdFwiICYmIHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwidHdlYWtlcnNcIikgfHwgKHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcInN0YWJsZVwiICYmIHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcImFscGhhXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY2hhbm5lbHMgPSBjYW5kaWRhdGUuY2hhbm5lbHMgYXMgUGFydGlhbDxSZWNvcmQ8RW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSwgRW52aXJvbm1lbnRDaGFubmVsU3RhdHVzPj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHJhd09ic2VydmF0aW9uID0gY2FuZGlkYXRlLm9ic2VydmF0aW9uO1xuICBjb25zdCBvYnNlcnZhdGlvbiA9IHJhd09ic2VydmF0aW9uXG4gICAgJiYgKHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IG51bGxcbiAgICAgIHx8IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IFwiY2hhdGdwdFwiXG4gICAgICB8fCByYXdPYnNlcnZhdGlvbi5hcHBFeHBlcmllbmNlID09PSBcInR3ZWFrZXJzXCIpXG4gICAgPyB7XG4gICAgICBhcHBFeHBlcmllbmNlOiByYXdPYnNlcnZhdGlvbi5hcHBFeHBlcmllbmNlLFxuICAgICAgc2VsZWN0aW9uRHJpZnQ6IHJhd09ic2VydmF0aW9uLnNlbGVjdGlvbkRyaWZ0ID09PSB0cnVlLFxuICAgICAgbGlmZWN5Y2xlQ29udGVuZGVkOiByYXdPYnNlcnZhdGlvbi5saWZlY3ljbGVDb250ZW5kZWQgPT09IHRydWUsXG4gICAgICBjb21taXRKb3VybmFsUHJlc2VudDogcmF3T2JzZXJ2YXRpb24uY29tbWl0Sm91cm5hbFByZXNlbnQgPT09IHRydWUsXG4gICAgICB0cmFuc2l0aW9uSm91cm5hbFByZXNlbnQ6IHJhd09ic2VydmF0aW9uLnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudCA9PT0gdHJ1ZSxcbiAgICAgIGZyZXNobmVzczogcmF3T2JzZXJ2YXRpb24uZnJlc2huZXNzID09PSBcImNvbnRlbmRlZFwiID8gXCJjb250ZW5kZWRcIiBhcyBjb25zdCA6IFwiY3VycmVudFwiIGFzIGNvbnN0LFxuICAgIH1cbiAgICA6IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIHNlbGVjdGVkLFxuICAgIGNoYW5uZWxzOiB7XG4gICAgICBzdGFibGU6IGNoYW5uZWxzPy5zdGFibGUgPz8geyBhdmFpbGFibGU6IHRydWUsIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiIH0sXG4gICAgICBhbHBoYTogY2hhbm5lbHM/LmFscGhhID8/IHsgYXZhaWxhYmxlOiBmYWxzZSwgdW5hdmFpbGFibGVSZWFzb25zOiBbXCJBbHBoYSAoUHJlLXJlbGVhc2UpIGF2YWlsYWJpbGl0eSB3YXMgbm90IHJlcG9ydGVkLlwiXSwgcmVsZWFzZVByb2ZpbGU6IFwiYWxwaGFcIiB9LFxuICAgIH0sXG4gICAgLi4uKG9ic2VydmF0aW9uID8geyBvYnNlcnZhdGlvbiB9IDoge30pLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHZhbHVlOiB1bmtub3duKTogRW52aXJvbm1lbnRUcmFuc2FjdGlvbiB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRUcmFuc2FjdGlvbj47XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4uY2FuZGlkYXRlLFxuICAgIHRyYW5zYWN0aW9uSWQ6IGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gICAgZXJyb3I6IHR5cGVvZiBjYW5kaWRhdGUuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBjYW5kaWRhdGUuZXJyb3IgOiBudWxsLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24odmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24gfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbj4gJiB7IGtpbmQ/OiB1bmtub3duIH07XG4gIGlmIChjYW5kaWRhdGUua2luZCAhPT0gXCJlbnZpcm9ubWVudC1jb21taXQtaGVscGVyXCIpIHJldHVybiBudWxsO1xuICBpZiAodHlwZW9mIGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgaWYgKGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdWJtaXR0ZWRcIiAmJiBjYW5kaWRhdGUucGhhc2UgIT09IFwic3VibWl0LWZhaWxlZFwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIixcbiAgICB0cmFuc2FjdGlvbklkOiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCxcbiAgICBwaGFzZTogY2FuZGlkYXRlLnBoYXNlLFxuICAgIGVycm9yOiB0eXBlb2YgY2FuZGlkYXRlLmVycm9yID09PSBcInN0cmluZ1wiID8gY2FuZGlkYXRlLmVycm9yIDogbnVsbCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJJc0luRmxpZ2h0KHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogYm9vbGVhbiB7XG4gIGNvbnN0IGhlbHBlciA9IHRyYW5zYWN0aW9uLmhlbHBlcjtcbiAgY29uc3Qgb3V0Y29tZVBoYXNlID0gaGVscGVyPy5vdXRjb21lPy5waGFzZTtcbiAgcmV0dXJuIG91dGNvbWVQaGFzZSA9PT0gXCJub3Qtc3RhcnRlZFwiXG4gICAgfHwgb3V0Y29tZVBoYXNlID09PSBcInJ1bm5pbmdcIlxuICAgIHx8IChoZWxwZXI/LnN1Ym1pc3Npb24/LnBoYXNlID09PSBcInN1Ym1pdHRlZFwiICYmIG91dGNvbWVQaGFzZSA9PT0gdW5kZWZpbmVkKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIodHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBib29sZWFuIHtcbiAgaWYgKHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImZhaWxlZFwiKSByZXR1cm4gdHJhbnNhY3Rpb24ucHJlcGFyZWQgIT09IG51bGwgJiYgdHJhbnNhY3Rpb24ucHJlcGFyZWQgIT09IHVuZGVmaW5lZDtcbiAgcmV0dXJuIFtcImNvbW1pdHRpbmdcIiwgXCJhcHBseWluZ1wiLCBcInJlb3BlbmluZ1wiLCBcInZlcmlmeWluZ1wiLCBcInJvbGxpbmctYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSk7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50SGVscGVyRmFpbHVyZURldGFpbCh0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBoZWxwZXIgPSB0cmFuc2FjdGlvbi5oZWxwZXI7XG4gIGlmICghaGVscGVyKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgb3V0Y29tZSA9IGhlbHBlci5vdXRjb21lO1xuICBjb25zdCBzdWJtaXNzaW9uID0gaGVscGVyLnN1Ym1pc3Npb247XG4gIGNvbnN0IGZhaWxlZCA9IG91dGNvbWU/LnBoYXNlID09PSBcImZhaWxlZFwiXG4gICAgfHwgc3VibWlzc2lvbj8ucGhhc2UgPT09IFwic3VibWl0LWZhaWxlZFwiXG4gICAgfHwgdHlwZW9mIG91dGNvbWU/LmVycm9yID09PSBcInN0cmluZ1wiXG4gICAgfHwgdHlwZW9mIHN1Ym1pc3Npb24/LmVycm9yID09PSBcInN0cmluZ1wiO1xuICBpZiAoIWZhaWxlZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHN0ZGVyciA9IGVudmlyb25tZW50SGVscGVyTG9nU25pcHBldChoZWxwZXIuc3RkZXJyKTtcbiAgY29uc3Qgc3Rkb3V0ID0gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KGhlbHBlci5zdGRvdXQpO1xuICBjb25zdCBleGl0Q29kZSA9IHR5cGVvZiBvdXRjb21lPy5leGl0Q29kZSA9PT0gXCJudW1iZXJcIiA/IGBleGl0ICR7b3V0Y29tZS5leGl0Q29kZX1gIDogbnVsbDtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIFwiRW52aXJvbm1lbnQgaGVscGVyIGZhaWxlZFwiLFxuICAgIGV4aXRDb2RlLFxuICAgIG91dGNvbWU/LmVycm9yLFxuICAgIHN1Ym1pc3Npb24/LmVycm9yLFxuICAgIHN0ZGVyciA/IGBzdGRlcnI6ICR7c3RkZXJyfWAgOiBudWxsLFxuICAgICFzdGRlcnIgJiYgc3Rkb3V0ID8gYHN0ZG91dDogJHtzdGRvdXR9YCA6IG51bGwsXG4gIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCk7XG4gIHJldHVybiBbLi4ubmV3IFNldChkZXRhaWwpXS5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50SGVscGVyTG9nU25pcHBldCh2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IG51bGwge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY29tcGFjdCA9IHZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKTtcbiAgaWYgKCFjb21wYWN0KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGNvbXBhY3QubGVuZ3RoIDw9IDYwMCA/IGNvbXBhY3QgOiBgXHUyMDI2JHtjb21wYWN0LnNsaWNlKC01OTkpfWA7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93QWN0aW9ucyB7XG4gIGJ1c3k6IGJvb2xlYW47XG4gIG9uUmVzdW1lPzogKCkgPT4gdm9pZDtcbiAgb25DYW5jZWw/OiAoKSA9PiB2b2lkO1xuICBvblJlY292ZXI/OiAoKSA9PiB2b2lkO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KFxuICB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbiAgYWN0aW9uc0NvbmZpZz86IEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3dBY3Rpb25zLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBoZWxwZXJGYWlsdXJlID0gZW52aXJvbm1lbnRIZWxwZXJGYWlsdXJlRGV0YWlsKHRyYW5zYWN0aW9uKTtcbiAgY29uc3QgZGV0YWlscyA9IFtcbiAgICBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwodHJhbnNhY3Rpb24ucGhhc2UpLFxuICAgIHRyYW5zYWN0aW9uLmVycm9yLFxuICAgIGhlbHBlckZhaWx1cmUsXG4gIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIkFwcCBtb2RlIHJlc3RhcnRcIixcbiAgICBbLi4ubmV3IFNldChkZXRhaWxzKV0uam9pbihcIiBcdTAwQjcgXCIpLFxuICApO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZShlbnZpcm9ubWVudFRyYW5zYWN0aW9uVG9uZSh0cmFuc2FjdGlvbi5waGFzZSksIGVudmlyb25tZW50VHJhbnNhY3Rpb25MYWJlbCh0cmFuc2FjdGlvbi5waGFzZSkpKTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZXN1bWUpIHtcbiAgICBjb25zdCByZXN1bWUgPSBjb21wYWN0QnV0dG9uKFwiUmVzdW1lL0NvbmZpcm1cIiwgYWN0aW9uc0NvbmZpZy5vblJlc3VtZSk7XG4gICAgcmVzdW1lLmRpc2FibGVkID0gYWN0aW9uc0NvbmZpZy5idXN5O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJlc3VtZSk7XG4gIH1cbiAgaWYgKGFjdGlvbnNDb25maWc/Lm9uQ2FuY2VsKSB7XG4gICAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCBhY3Rpb25zQ29uZmlnLm9uQ2FuY2VsKTtcbiAgICBjYW5jZWwuZGlzYWJsZWQgPSBhY3Rpb25zQ29uZmlnLmJ1c3k7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY2FuY2VsKTtcbiAgfVxuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZWNvdmVyKSB7XG4gICAgY29uc3QgcmVjb3ZlciA9IGNvbXBhY3RCdXR0b24oXCJSZWNvdmVyIFNhZmVseVwiLCBhY3Rpb25zQ29uZmlnLm9uUmVjb3Zlcik7XG4gICAgcmVjb3Zlci5kaXNhYmxlZCA9IGFjdGlvbnNDb25maWcuYnVzeTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChyZWNvdmVyKTtcbiAgfVxuICByb3cudGl0bGUgPSBgVHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkfWA7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICByb3cuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwocGhhc2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlIFwiY29tbWl0dGVkXCI6XG4gICAgY2FzZSBcImNvbXBsZXRlZFwiOlxuICAgICAgcmV0dXJuIFwiQ29tcGxldGVkXCI7XG4gICAgY2FzZSBcInJvbGxlZC1iYWNrXCI6XG4gICAgY2FzZSBcInJvbGxlZF9iYWNrXCI6XG4gICAgICByZXR1cm4gXCJSb2xsZWQgYmFja1wiO1xuICAgIGNhc2UgXCJjYW5jZWxsZWRcIjpcbiAgICAgIHJldHVybiBcIkNhbmNlbGxlZFwiO1xuICAgIGNhc2UgXCJmYWlsZWRcIjpcbiAgICAgIHJldHVybiBcIkZhaWxlZFwiO1xuICAgIGNhc2UgXCJwcmVwYXJlZFwiOlxuICAgICAgcmV0dXJuIFwiUHJlcGFyZWRcIjtcbiAgICBjYXNlIFwicHJlcGFyaW5nXCI6XG4gICAgICByZXR1cm4gXCJQcmVwYXJpbmdcIjtcbiAgICBjYXNlIFwiY29tbWl0dGluZ1wiOlxuICAgICAgcmV0dXJuIFwiQ29tbWl0dGluZ1wiO1xuICAgIGNhc2UgXCJyZW9wZW5pbmdcIjpcbiAgICAgIHJldHVybiBcIlJlb3BlbmluZ1wiO1xuICAgIGNhc2UgXCJ2ZXJpZnlpbmdcIjpcbiAgICAgIHJldHVybiBcIlZlcmlmeWluZ1wiO1xuICAgIGNhc2UgXCJyb2xsaW5nLWJhY2tcIjpcbiAgICAgIHJldHVybiBcIlJvbGxpbmcgYmFja1wiO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gaHVtYW5pemVDb2RleFBoYXNlKHBoYXNlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uVG9uZShwaGFzZTogc3RyaW5nKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAocGhhc2UgPT09IFwiY29tbWl0dGVkXCIgfHwgcGhhc2UgPT09IFwiY29tcGxldGVkXCIpIHJldHVybiBcIm9rXCI7XG4gIGlmIChwaGFzZSA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZXJyb3JcIjtcbiAgcmV0dXJuIFwid2FyblwiO1xufVxuXG4vKiogT25lIHNoYXJlZCwgYWNjZXNzaWJsZSBjb25maXJtYXRpb24gYWZ0ZXIgcHJlcGFyZTsgQ2FuY2VsIG5ldmVyIGNvbW1pdHMuICovXG5mdW5jdGlvbiBvcGVuRW52aXJvbm1lbnRDb25maXJtTW9kYWwoXG4gIHJlcXVlc3RlZDogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuICB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbik6IFByb21pc2U8RW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbj4ge1xuICBjb25zdCBvcGVuZXIgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgPyBkb2N1bWVudC5hY3RpdmVFbGVtZW50IDogbnVsbDtcbiAgY29uc3QgcmVzdG9yZUZvY3VzID0gKCk6IHZvaWQgPT4ge1xuICAgIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzKFxuICAgICAgb3BlbmVyLFxuICAgICAgKCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLWVudmlyb25tZW50LWNhcmRdIGJ1dHRvbjpub3QoW2Rpc2FibGVkXSlcIiksXG4gICAgKTtcbiAgfTtcbiAgbGV0IHJlc29sdmVEZWNpc2lvbiE6IChkZWNpc2lvbjogRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbikgPT4gdm9pZDtcbiAgY29uc3QgZGVjaXNpb24gPSBuZXcgUHJvbWlzZTxFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uPigocmVzb2x2ZVByb21pc2UpID0+IHtcbiAgICByZXNvbHZlRGVjaXNpb24gPSByZXNvbHZlUHJvbWlzZTtcbiAgfSk7XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmRhdGFzZXQudHdlYWtlckVudmlyb25tZW50TW9kYWwgPSBcInRydWVcIjtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBcImZpeGVkIGluc2V0LTAgei1bOTk5OV0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNTAgcC00XCI7XG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwiZGlhbG9nXCIpO1xuICBkaWFsb2cuc2V0QXR0cmlidXRlKFwiYXJpYS1tb2RhbFwiLCBcInRydWVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsbGVkYnlcIiwgXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tdGl0bGVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWRlc2NyaWJlZGJ5XCIsIFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCB3LWZ1bGwgbWF4LXctbWQgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC0yeGwgYm9yZGVyIHAtNSBzaGFkb3cteGxcIjtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcInN0eWxlXCIsIFwiYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tY29sb3ItYmFja2dyb3VuZC1wYW5lbCwgdmFyKC0tY29sb3ItdG9rZW4tYmctZm9nKSk7XCIpO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLXRpdGxlXCI7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgY29uc3QgZXhwZXJpZW5jZSA9IGVudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlKTtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IGBTd2l0Y2ggdG8gJHtleHBlcmllbmNlfSBhbmQgcmVzdGFydD9gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIjtcbiAgYm9keS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBjYW5kaWRhdGUgPSB0cmFuc2FjdGlvbi5wcmVwYXJlZD8uY2FuZGlkYXRlO1xuICBjb25zdCBiYWNrZW5kID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LmJhY2tlbmQ7XG4gIGNvbnN0IHJvbGxiYWNrID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LnJvbGxiYWNrO1xuICBjb25zdCB0YXJnZXQgPSBjYW5kaWRhdGU/LmRlc2t0b3BQYXRoXG4gICAgPyBgJHtjYW5kaWRhdGUuZGVza3RvcFBhdGh9JHtjYW5kaWRhdGUudmVyc2lvbiA/IGAgKCR7Y2FuZGlkYXRlLnZlcnNpb259JHtjYW5kaWRhdGUuYnVpbGQgPyBgLCBidWlsZCAke2NhbmRpZGF0ZS5idWlsZH1gIDogXCJcIn0pYCA6IFwiXCJ9YFxuICAgIDogZW52aXJvbm1lbnRQcm9maWxlTGFiZWwocmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlKTtcbiAgY29uc3QgYmFja2VuZFRhcmdldCA9IGJhY2tlbmQ/LmxhbmVcbiAgICA/IGAke2JhY2tlbmQubGFuZX0ke2JhY2tlbmQudmVyc2lvbiA/IGAgJHtiYWNrZW5kLnZlcnNpb259YCA6IFwiXCJ9YFxuICAgIDogXCJ0aGUgdmVyaWZpZWQgYmFja2VuZCBmb3IgdGhpcyBlbnZpcm9ubWVudFwiO1xuICBjb25zdCByb2xsYmFja1RhcmdldCA9IHJvbGxiYWNrPy5kZXNrdG9wUGF0aFxuICAgID8/IHJvbGxiYWNrPy5zZWxlY3Rpb24/LnNlbGVjdGVkRGVza3RvcFBhdGhcbiAgICA/PyBcInRoZSBsYXN0IGtub3duIHdvcmtpbmcgZW52aXJvbm1lbnRcIjtcbiAgY29uc3QgbW9kZUVmZmVjdCA9IHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlID09PSBcInR3ZWFrZXJzXCJcbiAgICA/IFwiQ2hhdEdQVCB3aWxsIGNsb3NlLCByZW9wZW4gaW4gVHdlYWtlcnMgbW9kZSwgYW5kIHJlc3RvcmUgeW91ciBwcmV2aW91c2x5IGVuYWJsZWQgdHdlYWtzLlwiXG4gICAgOiBcIkNoYXRHUFQgd2lsbCBjbG9zZSBhbmQgcmVvcGVuIGluIHN0YW5kYXJkIG1vZGUuIEFsbCB0d2Vha3Mgd2lsbCBiZSBkaXNhYmxlZCwgYnV0IHRoZWlyIHNhdmVkIHNldHRpbmdzIHdpbGwgcmVtYWluIGF2YWlsYWJsZSBmb3IgVHdlYWtlcnMgbW9kZS5cIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IFtcbiAgICBtb2RlRWZmZWN0LFxuICAgIGBEZXNrdG9wOiAke3RhcmdldH0uIEVtYmVkZGVkIENvZGV4IGJhY2tlbmQ6ICR7YmFja2VuZFRhcmdldH0uYCxcbiAgICBgSWYgcmVzdGFydCB2ZXJpZmljYXRpb24gZmFpbHMsIFR3ZWFrZXJzIHdpbGwgcmVzdG9yZSB0aGUgbGFzdCBrbm93biB3b3JraW5nIGVudmlyb25tZW50IGF0ICR7cm9sbGJhY2tUYXJnZXR9LmAsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgYm9keS5zdHlsZS53aGl0ZVNwYWNlID0gXCJwcmUtbGluZVwiO1xuICBjb25zdCBidXR0b25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYnV0dG9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGNsb3NlID0gKG91dGNvbWU6IFwiY29uZmlybVwiIHwgXCJjYW5jZWxcIik6IHZvaWQgPT4ge1xuICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgc2V0dGxlZCA9IHRydWU7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgIHJlc29sdmVEZWNpc2lvbihvdXRjb21lKTtcbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKHJlc3RvcmVGb2N1cyk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGNsb3NlKFwiY2FuY2VsXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZXZlbnQua2V5ICE9PSBcIlRhYlwiKSByZXR1cm47XG4gICAgY29uc3QgZm9jdXNhYmxlID0gW2NhbmNlbCwgY29uZmlybV07XG4gICAgY29uc3QgY3VycmVudEluZGV4ID0gZm9jdXNhYmxlLmluZGV4T2YoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MQnV0dG9uRWxlbWVudCk7XG4gICAgY29uc3QgbmV4dEluZGV4ID0gZXZlbnQuc2hpZnRLZXlcbiAgICAgID8gKGN1cnJlbnRJbmRleCA8PSAwID8gZm9jdXNhYmxlLmxlbmd0aCAtIDEgOiBjdXJyZW50SW5kZXggLSAxKVxuICAgICAgOiAoY3VycmVudEluZGV4IDwgMCB8fCBjdXJyZW50SW5kZXggPT09IGZvY3VzYWJsZS5sZW5ndGggLSAxID8gMCA6IGN1cnJlbnRJbmRleCArIDEpO1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZm9jdXNhYmxlW25leHRJbmRleF0/LmZvY3VzKCk7XG4gIH07XG4gIGNvbnN0IGNhbmNlbCA9IGNvbXBhY3RCdXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gY2xvc2UoXCJjYW5jZWxcIikpO1xuICBjb25zdCBjb25maXJtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29uZmlybS50eXBlID0gXCJidXR0b25cIjtcbiAgY29uZmlybS5jbGFzc05hbWUgPSBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJnLXRva2VuLWNoYXJ0cy1ibHVlIHB4LTMgdGV4dC1zbSB0ZXh0LXdoaXRlIGVuYWJsZWQ6aG92ZXI6b3BhY2l0eS05MCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MCBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIGNvbmZpcm0udGV4dENvbnRlbnQgPSBcIkFwcGx5ICYgUmVzdGFydFwiO1xuICBjb25maXJtLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNsb3NlKFwiY29uZmlybVwiKTtcbiAgfSk7XG4gIGJ1dHRvbnMuYXBwZW5kKGNhbmNlbCwgY29uZmlybSk7XG4gIGRpYWxvZy5hcHBlbmQoaGVhZGluZywgYm9keSwgYnV0dG9ucyk7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcbiAgY29uZmlybS5mb2N1cygpO1xuICByZXR1cm4gZGVjaXNpb247XG59XG5cbmZ1bmN0aW9uIHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJEZXNrdG9wIFVwZGF0ZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckRlc2t0b3BVcGRhdGVDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTG9hZGluZyBkZXNrdG9wIHVwZGF0ZVwiLCBcIkNoZWNraW5nIHRoZSBzaWduZWQgQ29kZXggYXBwY2FzdC5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGN1cnJlbnQ6IERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGxldCBidXN5ID0gZmFsc2U7XG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgPSAwO1xuICBsZXQgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IDA7XG4gIGxldCBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCA9IGZhbHNlO1xuXG4gIGNvbnN0IHRyYW5zYWN0aW9uSXNBY3RpdmUgPSAoKTogYm9vbGVhbiA9PiB7XG4gICAgaWYgKCF0cmFuc2FjdGlvbj8udHJhbnNhY3Rpb25JZCkge1xuICAgICAgcmV0dXJuIHRyYW5zYWN0aW9uPy5waGFzZSA9PT0gXCJwcmVwYXJpbmdcIiAmJiBEYXRlLm5vdygpIDwgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbDtcbiAgICB9XG4gICAgcmV0dXJuICFbXCJjb21wbGV0ZWRcIiwgXCJmYWlsZWRcIiwgXCJyb2xsZWRfYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSk7XG4gIH07XG4gIGNvbnN0IHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsID0gKGRlbGF5TXMgPSAyXzAwMCk6IHZvaWQgPT4ge1xuICAgIGlmIChwb2xsaW5nKSBjbGVhclRpbWVvdXQocG9sbGluZyk7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkIHx8ICghdHJhbnNhY3Rpb25Jc0FjdGl2ZSgpICYmIHRyYW5zYWN0aW9uPy5yZXN1bWFibGUgIT09IHRydWUpKSByZXR1cm47XG4gICAgcG9sbGluZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgcG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgIH0sIGRlbGF5TXMpO1xuICB9O1xuICBjb25zdCBsb2FkVHJhbnNhY3Rpb24gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJkZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IG9ic2VydmVkID0gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlKTtcbiAgICAgIGlmIChvYnNlcnZlZD8ucGhhc2UgPT09IFwiaWRsZVwiXG4gICAgICAgICYmIG9ic2VydmVkLnRyYW5zYWN0aW9uSWQgPT09IG51bGxcbiAgICAgICAgJiYgdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmluZ1wiXG4gICAgICAgICYmIHRyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWQgPT09IG51bGwpIHtcbiAgICAgICAgaWYgKERhdGUubm93KCkgPj0gYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCkge1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgICAgdHJhbnNhY3Rpb25JZDogbnVsbCxcbiAgICAgICAgICAgIHBoYXNlOiBcImZhaWxlZFwiLFxuICAgICAgICAgICAgZXJyb3I6IFwiVGhlIGRlc2t0b3AgdXBkYXRlciBkaWQgbm90IGNyZWF0ZSBhIHRyYW5zYWN0aW9uIHJlY2VpcHQuXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBvYnNlcnZlZDtcbiAgICAgICAgaWYgKHRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkKSBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsID0gMDtcbiAgICAgIH1cbiAgICAgIHRyYW5zYWN0aW9uUG9sbEZhaWx1cmVzID0gMDtcbiAgICAgIGRyYXcoKTtcbiAgICAgIHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICB0cmFuc2FjdGlvbklkOiB0cmFuc2FjdGlvbj8udHJhbnNhY3Rpb25JZCA/PyBudWxsLFxuICAgICAgICBwaGFzZTogdHJhbnNhY3Rpb24/LnBoYXNlID8/IFwicHJlcGFyaW5nXCIsXG4gICAgICAgIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvciksXG4gICAgICB9O1xuICAgICAgZHJhdygpO1xuICAgICAgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgKz0gMTtcbiAgICAgIGNvbnN0IGJhY2tvZmYgPSBNYXRoLm1pbigzMF8wMDAsIDFfMDAwICogKDIgKiogTWF0aC5taW4odHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgLSAxLCA1KSkpO1xuICAgICAgY29uc3Qgaml0dGVyID0gTWF0aC5mbG9vcihiYWNrb2ZmICogMC4yNSAqIE1hdGgucmFuZG9tKCkpO1xuICAgICAgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwoYmFja29mZiArIGppdHRlcik7XG4gICAgfVxuICB9O1xuICBjb25zdCBkcmF3ID0gKCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IGN1cnJlbnQ7XG4gICAgY29uc3QgaW5zdGFsbGVkID0gcmVzdWx0Py5pbnN0YWxsZWQ/Lm1hcmtldGluZ1ZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICAgIGNvbnN0IGxhdGVzdCA9IHJlc3VsdD8ubGF0ZXN0Py5tYXJrZXRpbmdWZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIjtcbiAgICBjb25zdCBzdGF0dXMgPSBkZXNrdG9wVXBkYXRlU3RhdHVzUHJlc2VudGF0aW9uKHJlc3VsdD8uc3RhdHVzKTtcbiAgICBjb25zdCBwcmVzZW50YXRpb24gPSBkZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uKHtcbiAgICAgIGJ1c3ksXG4gICAgICBzdGF0dXM6IHJlc3VsdD8uc3RhdHVzLFxuICAgICAgdHJhbnNhY3Rpb24sXG4gICAgfSk7XG4gICAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiQ2hhdEdQVCBEZXNrdG9wXCIsIGBJbnN0YWxsZWQgJHtpbnN0YWxsZWR9IFx1MDBCNyBMYXRlc3QgJHtsYXRlc3R9JHtyZXN1bHQ/LnJlYXNvbiA/IGAgXHUwMEI3ICR7cmVzdWx0LnJlYXNvbn1gIDogXCJcIn1gKTtcbiAgICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHN0YXR1cy50b25lLCBzdGF0dXMubGFiZWwpKTtcbiAgICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgY2hlY2sgPSBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgZm9yIFVwZGF0ZXNcdTIwMjZcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgY2hlY2suZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbHVlIGFzIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdDtcbiAgICAgICAgICBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0KHJlc3VsdCk7XG4gICAgICAgICAgaWYgKHJlc3VsdC51cGRhdGVBbmRSZWxvYWRSZXF1ZXN0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0aW5nVHJhbnNhY3Rpb25SZWNlaXB0VW50aWwgPSBEYXRlLm5vdygpICsgMTBfMDAwO1xuICAgICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgY2hlY2suZGlzYWJsZWQgPSBidXN5IHx8ICEhcmVzdWx0Py5zZXR1cFJlcXVpcmVkO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNoZWNrKTtcbiAgICBjb25zdCB1cGRhdGUgPSBjb21wYWN0QnV0dG9uKFwiVXBkYXRlIGFuZCBSZWxvYWRcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgdXBkYXRlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzdGFydC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IERhdGUubm93KCkgKyAxMF8wMDA7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgdXBkYXRlLmRpc2FibGVkID0gcHJlc2VudGF0aW9uLnVwZGF0ZURpc2FibGVkO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIGlmIChyZXN1bHQ/LnNldHVwUmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IHNldHVwTGFiZWwgPSByZXN1bHQuc2V0dXBSZXF1aXJlZCA9PT0gXCJyZWdpc3Rlci1iZXRhXCJcbiAgICAgICAgPyBcIlJlZ2lzdGVyIE9wZW5BSSBCZXRhXCJcbiAgICAgICAgOiBcIkxhdW5jaCBPcGVuQUkgQmV0YSBvbmNlXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgYEFscGhhIHVwZGF0ZSBzZXR1cCBcdTAwQjcgJHtzZXR1cExhYmVsfWAsXG4gICAgICAgIHJlc3VsdC5yZWFzb24gPz8gXCJBbHBoYSB1cGRhdGUgY2hlY2tzIHN0YXkgZGlzYWJsZWQgdW50aWwgVHdlYWtlcnMgY2FwdHVyZXMgdGhlIHJlZ2lzdGVyZWQgQmV0YSBhcHAncyBvd24gZmVlZC5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAocmVzdWx0Py5jaGVja2VkQXQpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKHJlc3VsdC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCkpKTtcbiAgICBpZiAodHJhbnNhY3Rpb24pIGNhcmQuYXBwZW5kQ2hpbGQoZGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uUm93KHRyYW5zYWN0aW9uLCBwcmVzZW50YXRpb24sIHtcbiAgICAgIGJ1c3ksXG4gICAgICBvblJlc3VtZTogKCkgPT4ge1xuICAgICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmVzdW1lLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgdHJhbnNhY3Rpb24gPSB0cmFuc2FjdGlvbiA/IHsgLi4udHJhbnNhY3Rpb24sIHBoYXNlOiBcImF3YWl0aW5nX25hdGl2ZV91cGRhdGVcIiwgcmVzdW1hYmxlOiBmYWxzZSB9IDogdHJhbnNhY3Rpb247XG4gICAgICAgICAgICBzY2hlZHVsZVRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgICAgaWYgKHRyYW5zYWN0aW9uKSB0cmFuc2FjdGlvbiA9IHsgLi4udHJhbnNhY3Rpb24sIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHsgYnVzeSA9IGZhbHNlOyBkcmF3KCk7IH0pO1xuICAgICAgfSxcbiAgICAgIG9uQ2FuY2VsOiAoKSA9PiB7XG4gICAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjYW5jZWwtY29kZXgtZGVza3RvcC11cGRhdGVcIilcbiAgICAgICAgICAudGhlbigodmFsdWUpID0+IHsgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb24odmFsdWUpID8/IHRyYW5zYWN0aW9uOyB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmICh0cmFuc2FjdGlvbikgdHJhbnNhY3Rpb24gPSB7IC4uLnRyYW5zYWN0aW9uLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7IGJ1c3kgPSBmYWxzZTsgZHJhdygpOyB9KTtcbiAgICAgIH0sXG4gICAgfSkpO1xuICB9O1xuICBkcmF3KCk7XG4gIGNvbnN0IGFjY2VwdERlc2t0b3BVcGRhdGVSZXN1bHQgPSAodmFsdWU6IERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGN1cnJlbnRUaW1lID0gY3VycmVudD8uY2hlY2tlZEF0ID8gRGF0ZS5wYXJzZShjdXJyZW50LmNoZWNrZWRBdCkgOiBOdW1iZXIuTmFOO1xuICAgIGNvbnN0IG5leHRUaW1lID0gdmFsdWUuY2hlY2tlZEF0ID8gRGF0ZS5wYXJzZSh2YWx1ZS5jaGVja2VkQXQpIDogTnVtYmVyLk5hTjtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGN1cnJlbnRUaW1lKSAmJiAoIU51bWJlci5pc0Zpbml0ZShuZXh0VGltZSkgfHwgbmV4dFRpbWUgPCBjdXJyZW50VGltZSkpIHJldHVybjtcbiAgICBjdXJyZW50ID0gdmFsdWU7XG4gICAgZHJhdygpO1xuICB9O1xuICBjb25zdCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkID0gKF9ldmVudDogdW5rbm93biwgdmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjpjb2RleC1kZXNrdG9wLXVwZGF0ZS1jaGFuZ2VkXCIsIG9uRGVza3RvcFVwZGF0ZUNoYW5nZWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCA9IHRydWU7XG4gICAgYWNjZXB0RGVza3RvcFVwZGF0ZVJlc3VsdCh2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpO1xuICB9O1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgY29uc3QgY3VycmVudFVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZGVza3RvcC11cGRhdGUtcmVzdWx0XCIpO1xuICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudChjdXJyZW50VXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCB8fCBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCkgcmV0dXJuO1xuICAgICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0KHZhbHVlIGFzIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXJyZW50ID0geyBzdGF0dXM6IFwidW5hdmFpbGFibGVcIiwgcmVhc29uOiBcIlVwZGF0ZSBzdGF0dXMgaGFzIG5vdCBiZWVuIGNoZWNrZWQgeWV0LlwiIH07XG4gICAgICAgIGRyYXcoKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KGN1cnJlbnRVcGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgIGRyYXcoKTtcbiAgICB9KTtcbiAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZGVza3RvcC11cGRhdGUtcmVzdWx0XCIpO1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJkZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgICBpZiAocG9sbGluZykgY2xlYXJUaW1lb3V0KHBvbGxpbmcpO1xuICAgIHBvbGxpbmcgPSBudWxsO1xuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb24odmFsdWU6IHVua25vd24pOiBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGU+O1xuICBpZiAoY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IG51bGwgJiYgdHlwZW9mIGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiBjYW5kaWRhdGUucGhhc2UgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLmNhbmRpZGF0ZSxcbiAgICB0cmFuc2FjdGlvbklkOiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCA/PyBudWxsLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblJvdyhcbiAgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlLFxuICBwcmVzZW50YXRpb246IERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24sXG4gIGFjdGlvbnM6IHsgYnVzeTogYm9vbGVhbjsgb25SZXN1bWU6ICgpID0+IHZvaWQ7IG9uQ2FuY2VsOiAoKSA9PiB2b2lkIH0sXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGRldGFpbCA9IFtcbiAgICB0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkID8gYFRyYW5zYWN0aW9uICR7dHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZH1gIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5zYWZlT2ZmaWNpYWxNb2RlID8gXCJPZmZpY2lhbCBDaGF0R1BUIGlzIGFjdGl2ZVwiIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5yZWZyZXNoU291cmNlID8gYCR7dHJhbnNhY3Rpb24ucmVmcmVzaFNvdXJjZX0gVHdlYWtlcnMgcmVmcmVzaGAgOiBudWxsLFxuICAgIHRyYW5zYWN0aW9uLmVycm9yID8/IG51bGwsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKSB8fCBcIldhaXRpbmcgZm9yIHRoZSBkdXJhYmxlIHVwZGF0ZXIgcmVjZWlwdC5cIjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiVXBkYXRlIGFuZCBSZWxvYWRcIiwgZGV0YWlsKTtcbiAgcm93LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzdGF0dXNcIik7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxpdmVcIiwgXCJwb2xpdGVcIik7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAocHJlc2VudGF0aW9uLnRvbmUgJiYgcHJlc2VudGF0aW9uLnBoYXNlTGFiZWwpIHtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHByZXNlbnRhdGlvbi50b25lLCBwcmVzZW50YXRpb24ucGhhc2VMYWJlbCkpO1xuICB9XG4gIGNvbnN0IGNvbnRyb2xzID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGZvciAoY29uc3QgYWN0aW9uIG9mIHByZXNlbnRhdGlvbi5hY3Rpb25zKSB7XG4gICAgY29uc3QgaGFuZGxlciA9IGFjdGlvbi5raW5kID09PSBcInJlc3VtZVwiID8gYWN0aW9ucy5vblJlc3VtZSA6IGFjdGlvbnMub25DYW5jZWw7XG4gICAgY29uc3QgYnV0dG9uID0gY29tcGFjdEJ1dHRvbihhY3Rpb24ubGFiZWwsIGhhbmRsZXIpO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGFjdGlvbi5kaXNhYmxlZDtcbiAgICBjb250cm9scz8uYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJNY3BJbnRlZ3JhdGlvblNlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIGNhcmRVcGRhdGVzOiBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4sXG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIk1DUCBJbnRlZ3JhdGlvbiBIZWFsdGhcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJNY3BIZWFsdGhDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgTUNQIGludGVncmF0aW9uXCIsIFwiVmVyaWZ5aW5nIG1hbmFnZWQgTUNQIGNvbmZpZ3VyYXRpb24gYW5kIHN5bmNocm9uaXphdGlvbi5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgY29uc3QgcmVuZGVyID0gKHN0YXRlOiBNY3BTeW5jU3RhdGUgfCBudWxsKTogdm9pZCA9PiB7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgaWYgKCFzdGF0ZSkge1xuICAgICAgc3RhdGUgPSB7XG4gICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiTWFuYWdlZCBNQ1AgcmVjb25jaWxpYXRpb24gaGFzIG5vdCBjb21wbGV0ZWQgeWV0LlwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3Qgc3RhdHVzID0gc3RhdGUuc3RhdHVzID8/IChzdGF0ZS5lcnJvciA/IFwiZXJyb3JcIiA6IFwib2tcIik7XG4gICAgY29uc3QgdG9uZSA9IHN0YXR1cyA9PT0gXCJlcnJvclwiIHx8IHN0YXRlLmVycm9yXG4gICAgICA/IFwiZXJyb3JcIlxuICAgICAgOiBzdGF0dXMgPT09IFwiY29uZmxpY3RcIiB8fCBzdGF0dXMgPT09IFwid2FyblwiIHx8IHN0YXR1cyA9PT0gXCJwZW5kaW5nXCJcbiAgICAgICAgPyBcIndhcm5cIlxuICAgICAgICA6IFwib2tcIjtcbiAgICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJNQ1AgaW50ZWdyYXRpb25cIiwgc3RhdGUuc3VtbWFyeSA/PyBzdGF0ZS5lcnJvciA/PyAodG9uZSA9PT0gXCJva1wiID8gXCJNQ1AgY29uZmlndXJhdGlvbiBpcyBzeW5jaHJvbml6ZWQuXCIgOiBcIk1DUCBjb25maWd1cmF0aW9uIG5lZWRzIGF0dGVudGlvbi5cIikpO1xuICAgIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGxlZnQ/LnByZXBlbmQoc3RhdHVzQmFkZ2UodG9uZSwgc3RhdHVzID09PSBcIm9rXCIgPyBcIkhlYWx0aHlcIiA6IGh1bWFuaXplQ29kZXhQaGFzZShzdGF0dXMpKSk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGNvbnN0IHJlcGFpciA9IGNvbXBhY3RCdXR0b24oXCJSZXBhaXJcIiwgKCkgPT4ge1xuICAgICAgcmVwYWlyLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwibWNwXCIpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlcGFpci1tY3BcIilcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBpZiAoY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQgYXMgTWNwU3luY1N0YXRlKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIGNvbnN0IG5leHQgPSB7IHN0YXR1czogXCJlcnJvclwiLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgaWYgKGNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQocmVwYWlyKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgaWYgKHN0YXRlLnJlc3RhcnRSZXF1aXJlZCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXG4gICAgICAgIFwiTmV3IHRhc2sgb3IgcmVzdGFydCByZXF1aXJlZFwiLFxuICAgICAgICBcIlRoZSBjYW5vbmljYWwgTUNQIG5hbWUgaXMgd3JpdHRlbi4gU3RhcnQgYSBuZXcgdGFzaywgb3IgcmVzdGFydCBDb2RleCwgdG8gcmVwbGFjZSBhbnkgYWxyZWFkeS1ydW5uaW5nIGxlZ2FjeSBNQ1AgcHJvY2Vzcy5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuY29uZmxpY3RzPy5sZW5ndGgpIHtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ29uZmxpY3RzXCIsIHN0YXRlLmNvbmZsaWN0cy5tYXAoKGNvbmZsaWN0KSA9PiB7XG4gICAgICAgIGlmIChjb25mbGljdC5vYnNlcnZlZE5hbWUgfHwgY29uZmxpY3QuY2Fub25pY2FsTmFtZSkge1xuICAgICAgICAgIHJldHVybiBgJHtjb25mbGljdC5vYnNlcnZlZE5hbWUgPz8gXCJVbmtub3duIGVudHJ5XCJ9IFx1MjE5MiAke2NvbmZsaWN0LmNhbm9uaWNhbE5hbWUgPz8gXCJjYW5vbmljYWwgZW50cnlcIn06ICR7Y29uZmxpY3QucmVhc29uID8/IGNvbmZsaWN0LmRldGFpbCA/PyBcIm93bmVyc2hpcCBjb25mbGljdFwifWA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvbmZsaWN0LmRldGFpbCA/PyBjb25mbGljdC5yZWFzb24gPz8gY29uZmxpY3QubmFtZSA/PyBcIlVua25vd24gY29uZmxpY3RcIjtcbiAgICAgIH0pLmpvaW4oXCI7IFwiKSkpO1xuICAgIH1cbiAgICBjb25zdCBjaGVja2VkQXQgPSBzdGF0ZS5jb21wbGV0ZWRBdCA/PyBzdGF0ZS5jaGVja2VkQXQ7XG4gICAgaWYgKGNoZWNrZWRBdCkgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMYXN0IGNoZWNrZWRcIiwgbmV3IERhdGUoY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpKSk7XG4gIH07XG4gIGNvbnN0IG9uU3luY1N0YXRlQ2hhbmdlZCA9IChfZXZlbnQ6IHVua25vd24sIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSB7XG4gICAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6bWNwLXN5bmMtc3RhdGUtY2hhbmdlZFwiLCBvblN5bmNTdGF0ZUNoYW5nZWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcIm1jcFwiKTtcbiAgICBjb25zdCBuZXh0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgTWNwU3luY1N0YXRlIDogbnVsbDtcbiAgICBpZiAoY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICB9O1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6bWNwLXN5bmMtc3RhdGUtY2hhbmdlZFwiLCBvblN5bmNTdGF0ZUNoYW5nZWQpO1xuICBjb25zdCBpbml0aWFsVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJtY3BcIik7XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtbWNwLXN5bmMtc3RhdGVcIilcbiAgICAudGhlbigodmFsdWUpID0+IHtcbiAgICAgIGNvbnN0IG5leHQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgPyB2YWx1ZSBhcyBNY3BTeW5jU3RhdGUgOiBudWxsO1xuICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQgJiYgY2FyZFVwZGF0ZXMuY29tcGxldGUoaW5pdGlhbFVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIGNvbnN0IG5leHQgPSB7IHN0YXR1czogXCJlcnJvclwiLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICBpZiAoY2FyZC5pc0Nvbm5lY3RlZCAmJiBjYXJkVXBkYXRlcy5jb21wbGV0ZShpbml0aWFsVXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICAgIH0pO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJtY3BcIik7XG4gICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOm1jcC1zeW5jLXN0YXRlLWNoYW5nZWRcIiwgb25TeW5jU3RhdGVDaGFuZ2VkKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQXV0b21hdGljTWFpbnRlbmFuY2VTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBdXRvbWF0aWMgTWFpbnRlbmFuY2VcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJNYWludGVuYW5jZUNhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBhdXRvbWF0aWMgbWFpbnRlbmFuY2VcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICBsZXQgbGF0ZXN0SGVhbHRoOiBXYXRjaGVySGVhbHRoIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZXBhaXJJbkZsaWdodCA9IGZhbHNlO1xuICBsZXQgcmVwYWlyRGlzcGxheTogXCJpZGxlXCIgfCBcInN1Y2Nlc3NcIiB8IFwiZmFpbHVyZVwiID0gXCJpZGxlXCI7XG4gIGxldCByZXBhaXJCYXNlbGluZUN5Y2xlOiBXYXRjaGVyQ3ljbGVSZWNlaXB0IHwgbnVsbCA9IG51bGw7XG4gIGxldCByZXBhaXJTdGFydGVkQXQgPSAwO1xuICBsZXQgcmVwYWlyUG9sbDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlcGFpclBvbGxDb3VudCA9IDA7XG4gIGNvbnN0IE1BWF9SRVBBSVJfUE9MTFMgPSAzMDtcblxuICBjb25zdCByZW5kZXIgPSAoaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogdm9pZCA9PiB7XG4gICAgbGF0ZXN0SGVhbHRoID0gaGVhbHRoO1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGlmIChyZXBhaXJJbkZsaWdodCkge1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCB7XG4gICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgc3RhdHVzOiBcIndhcm5cIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJ1bm5pbmdcIixcbiAgICAgICAgc3VtbWFyeTogXCJSZXBhaXIgd2FzIHN0YXJ0ZWQgaW4gdGhlIGJhY2tncm91bmQuIFdhaXRpbmcgZm9yIGEgY29tcGxldGVkIHdhdGNoZXIgY3ljbGVcdTIwMjZcIixcbiAgICAgIH0sIGZhbHNlKTtcbiAgICAgIGNvbnN0IHJ1bm5pbmcgPSBhY3Rpb25Sb3coXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2VcIiwgXCJSZXBhaXIgY3ljbGUgcnVubmluZ1x1MjAyNlwiKTtcbiAgICAgIHJ1bm5pbmcuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInN0YXR1c1wiKTtcbiAgICAgIHJ1bm5pbmcuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICAgICAgcnVubmluZy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShcIndhcm5cIiwgXCJSdW5uaW5nXCIpKTtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocnVubmluZyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXBhaXJEaXNwbGF5ID09PSBcInN1Y2Nlc3NcIikge1xuICAgICAgaGVhbHRoID0ge1xuICAgICAgICAuLi5oZWFsdGgsXG4gICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2Ugc3VjY2VlZGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgY29tcGxldGVkIGEgZnJlc2ggcmVwYWlyIGN5Y2xlLlwiLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHJlcGFpckRpc3BsYXkgPT09IFwiZmFpbHVyZVwiKSB7XG4gICAgICBoZWFsdGggPSB7XG4gICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIixcbiAgICAgICAgc3VtbWFyeTogaGVhbHRoLnN1bW1hcnkgfHwgXCJUaGUgd2F0Y2hlciByZXBhaXIgY3ljbGUgZmFpbGVkLlwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCBoZWFsdGgsIHRydWUsIHN0YXJ0UmVwYWlyKTtcbiAgfTtcbiAgY29uc3QgbG9hZCA9ICgpOiBQcm9taXNlPFdhdGNoZXJIZWFsdGggfCBudWxsPiA9PiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJ3YXRjaGVyXCIpO1xuICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKVxuICAgICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICAgIGNvbnN0IGhlYWx0aCA9IHZhbHVlIGFzIFdhdGNoZXJIZWFsdGg7XG4gICAgICAgIGlmICghY2FyZC5pc0Nvbm5lY3RlZCB8fCAhY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBoZWFsdGgpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmVuZGVyKGhlYWx0aCk7XG4gICAgICAgIHJldHVybiBoZWFsdGg7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBjb25zdCBoZWFsdGg6IFdhdGNoZXJIZWFsdGggPSB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwiZXJyb3JcIiwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHVuYXZhaWxhYmxlXCIsIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfTtcbiAgICAgICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkIHx8ICFjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIGhlYWx0aCkpIHJldHVybiBudWxsO1xuICAgICAgICByZW5kZXIoaGVhbHRoKTtcbiAgICAgICAgcmV0dXJuIGhlYWx0aDtcbiAgICAgIH0pO1xuICB9O1xuICBjb25zdCBpc05ld2VyQ3ljbGUgPSAoaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogYm9vbGVhbiA9PiB7XG4gICAgY29uc3QgY3ljbGUgPSBoZWFsdGgubGF0ZXN0Q29tcGxldGVkQ3ljbGU7XG4gICAgaWYgKCFjeWNsZSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghcmVwYWlyQmFzZWxpbmVDeWNsZSkge1xuICAgICAgcmV0dXJuIERhdGUucGFyc2UoY3ljbGUuY29tcGxldGVkQXQpID4gcmVwYWlyU3RhcnRlZEF0O1xuICAgIH1cbiAgICByZXR1cm4gY3ljbGUuY3ljbGVJZCAhPT0gcmVwYWlyQmFzZWxpbmVDeWNsZS5jeWNsZUlkXG4gICAgICAmJiBjeWNsZS5jb21wbGV0ZWRBdCA+IHJlcGFpckJhc2VsaW5lQ3ljbGUuY29tcGxldGVkQXQ7XG4gIH07XG4gIGNvbnN0IGZpbmlzaFJlcGFpciA9IChoZWFsdGg6IFdhdGNoZXJIZWFsdGgsIGZhaWxlZCA9IGZhbHNlKTogdm9pZCA9PiB7XG4gICAgcmVwYWlySW5GbGlnaHQgPSBmYWxzZTtcbiAgICByZXBhaXJEaXNwbGF5ID0gZmFpbGVkID8gXCJmYWlsdXJlXCIgOiBcInN1Y2Nlc3NcIjtcbiAgICBpZiAocmVwYWlyUG9sbCkgY2xlYXJUaW1lb3V0KHJlcGFpclBvbGwpO1xuICAgIHJlcGFpclBvbGwgPSBudWxsO1xuICAgIGNvbnN0IG5leHQgPSBmYWlsZWRcbiAgICAgID8geyAuLi5oZWFsdGgsIHN0YXR1czogXCJlcnJvclwiIGFzIGNvbnN0LCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsIHN1bW1hcnk6IGhlYWx0aC5zdW1tYXJ5IHx8IFwiVGhlIHdhdGNoZXIgcmVwYWlyIGN5Y2xlIGZhaWxlZC5cIiB9XG4gICAgICA6IGhlYWx0aDtcbiAgICByZW5kZXIobmV4dCk7XG4gIH07XG4gIGNvbnN0IHBvbGxSZXBhaXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFyZXBhaXJJbkZsaWdodCB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgIGlmIChyZXBhaXJQb2xsQ291bnQrKyA+PSBNQVhfUkVQQUlSX1BPTExTKSB7XG4gICAgICBmaW5pc2hSZXBhaXIoe1xuICAgICAgICAuLi4obGF0ZXN0SGVhbHRoID8/IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJlcnJvclwiIGFzIGNvbnN0LCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgZGlkIG5vdCByZXBvcnQgYSBjb21wbGV0ZWQgY3ljbGUgaW4gdGltZS5cIiwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfSksXG4gICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgZGlkIG5vdCByZXBvcnQgYSBjb21wbGV0ZWQgY3ljbGUgaW4gdGltZS5cIixcbiAgICAgIH0sIHRydWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2b2lkIGxvYWQoKS50aGVuKChoZWFsdGgpID0+IHtcbiAgICAgIGlmICghaGVhbHRoIHx8ICFyZXBhaXJJbkZsaWdodCkgcmV0dXJuO1xuICAgICAgY29uc3QgY3ljbGUgPSBoZWFsdGgubGF0ZXN0Q29tcGxldGVkQ3ljbGU7XG4gICAgICBpZiAoaXNOZXdlckN5Y2xlKGhlYWx0aCkpIHtcbiAgICAgICAgZmluaXNoUmVwYWlyKGhlYWx0aCwgY3ljbGU/Lm91dGNvbWUgPT09IFwiZmFpbGVkXCIgfHwgY3ljbGU/LnJlcGFpci5zdGF0dXMgPT09IFwiZmFpbGVkXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZW5kZXIoaGVhbHRoKTtcbiAgICAgIHJlcGFpclBvbGwgPSBzZXRUaW1lb3V0KHBvbGxSZXBhaXIsIDFfMDAwKTtcbiAgICB9KTtcbiAgfTtcbiAgY29uc3Qgc3RhcnRSZXBhaXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHJlcGFpckluRmxpZ2h0KSByZXR1cm47XG4gICAgcmVwYWlySW5GbGlnaHQgPSB0cnVlO1xuICAgIHJlcGFpckRpc3BsYXkgPSBcImlkbGVcIjtcbiAgICByZXBhaXJCYXNlbGluZUN5Y2xlID0gbGF0ZXN0SGVhbHRoPy5sYXRlc3RDb21wbGV0ZWRDeWNsZSA/PyBudWxsO1xuICAgIHJlcGFpclN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgcmVwYWlyUG9sbENvdW50ID0gMDtcbiAgICByZW5kZXIobGF0ZXN0SGVhbHRoID8/IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJ3YXJuXCIsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBydW5uaW5nXCIsIHN1bW1hcnk6IFwiU3RhcnRpbmcgcmVwYWlyXHUyMDI2XCIsIHdhdGNoZXI6IFwiV2F0Y2hlclwiLCBjaGVja3M6IFtdIH0pO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItYXV0by1tYWludGVuYW5jZVwiKVxuICAgICAgLnRoZW4oKCkgPT4gcG9sbFJlcGFpcigpKVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4gZmluaXNoUmVwYWlyKHtcbiAgICAgICAgLi4uKGxhdGVzdEhlYWx0aCA/PyB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwiZXJyb3JcIiBhcyBjb25zdCwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLCBzdW1tYXJ5OiBcIlwiLCB3YXRjaGVyOiBcIldhdGNoZXJcIiwgY2hlY2tzOiBbXSB9KSxcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIixcbiAgICAgICAgc3VtbWFyeTogc2FmZVVpRXJyb3IoZXJyb3IpLFxuICAgICAgfSwgdHJ1ZSkpO1xuICB9O1xuICBsb2FkKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcIndhdGNoZXJcIik7XG4gICAgcmVwYWlySW5GbGlnaHQgPSBmYWxzZTtcbiAgICBpZiAocmVwYWlyUG9sbCkgY2xlYXJUaW1lb3V0KHJlcGFpclBvbGwpO1xuICAgIHJlcGFpclBvbGwgPSBudWxsO1xuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJBZHZhbmNlZFJ1bnRpbWVTZWN0aW9uKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgcmVuZGVyQ29kZXhWZXJzaW9uc1NlY3Rpb24oc2VjdGlvbnNXcmFwKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhWZXJzaW9uc1NlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIG9wdGlvbnM6IHsgY29sbGFwc2VkPzogYm9vbGVhbiB9ID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmRhdGFzZXQudHdlYWtlckNvZGV4U2VjdGlvbiA9IFwidHJ1ZVwiO1xuICBjb25zdCByZWZyZXNoID0gY29tcGFjdEJ1dHRvbihcIlJlZnJlc2hcIiwgKCkgPT4geyB2b2lkIGxvYWQodHJ1ZSk7IH0pO1xuICBjb25zdCBoZWFkaW5nID0gc2VjdGlvblRpdGxlKG9wdGlvbnMuY29sbGFwc2VkID8gXCJBZHZhbmNlZCBSdW50aW1lIERldGFpbHNcIiA6IFwiUnVudGltZSBWZXJzaW9uc1wiLCByZWZyZXNoKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC50d2Vha2VyQ29kZXhDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTG9hZGluZyBDb2RleCB2ZXJzaW9uc1wiLCBcIlVzaW5nIGNhY2hlZCB2ZXJzaW9uIGFuZCBmZWF0dXJlIGluZm9ybWF0aW9uIGZpcnN0LlwiKSk7XG4gIGlmIChvcHRpb25zLmNvbGxhcHNlZCkge1xuICAgIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgICBkZXRhaWxzLmRhdGFzZXQudHdlYWtlckFkdmFuY2VkUnVudGltZURldGFpbHMgPSBcInRydWVcIjtcbiAgICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gICAgc3VtbWFyeS5jbGFzc05hbWUgPSBcImN1cnNvci1wb2ludGVyIHB4LTEgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gICAgc3VtbWFyeS50ZXh0Q29udGVudCA9IFwiQnVpbGRzLCBDTEkgcnVudGltZXMsIHJlbGVhc2VzLCBhbmQgZmVhdHVyZXNcIjtcbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBib2R5LmNsYXNzTmFtZSA9IFwibXQtMiBmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gICAgYm9keS5hcHBlbmRDaGlsZChjYXJkKTtcbiAgICBkZXRhaWxzLmFwcGVuZChzdW1tYXJ5LCBib2R5KTtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKGRldGFpbHMpO1xuICB9IGVsc2Uge1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIH1cbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgbGV0IGdlbmVyYXRpb24gPSAwO1xuICBjb25zdCBzY2hlZHVsZVBvbGwgPSAoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCkgPT4ge1xuICAgIGlmIChwb2xsaW5nKSBjbGVhclRpbWVvdXQocG9sbGluZyk7XG4gICAgcG9sbGluZyA9IG51bGw7XG4gICAgaWYgKCFhY3Rpb25JbkZsaWdodCAmJiAhY29kZXhQcm9ncmVzc0J1c3koc25hcHNob3QuaW5zdGFsbFByb2dyZXNzKSkgcmV0dXJuO1xuICAgIHBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkKSB2b2lkIGxvYWQoZmFsc2UpO1xuICAgIH0sIDkwMCk7XG4gIH07XG4gIGNvbnN0IHJlcXVlc3RSZWxvYWQ6IENvZGV4VWlSZWxvYWQgPSAobW9kZSkgPT4ge1xuICAgIGlmIChtb2RlID09PSBcIm9wZXJhdGlvbi1zdGFydFwiKSBhY3Rpb25JbkZsaWdodCA9IHRydWU7XG4gICAgaWYgKG1vZGUgPT09IFwib3BlcmF0aW9uLXN0b3BcIikgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgICB2b2lkIGxvYWQoZmFsc2UpO1xuICB9O1xuICBjb25zdCBzaG93ID0gKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpID0+IHtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJDb2RleFZlcnNpb25zQ2FyZChjYXJkLCBzbmFwc2hvdCwgcmVxdWVzdFJlbG9hZCk7XG4gICAgc2NoZWR1bGVQb2xsKHNuYXBzaG90KTtcbiAgfTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZChmb3JjZTogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSArK2dlbmVyYXRpb247XG4gICAgcmVmcmVzaC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNuYXBzaG90ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBmb3JjZSA/IFwidHdlYWtlcjpyZWZyZXNoLWNvZGV4LXZlcnNpb25zXCIgOiBcInR3ZWFrZXI6Z2V0LWNvZGV4LXZlcnNpb25zXCIsXG4gICAgICApIGFzIENvZGV4VmVyc2lvbnNTbmFwc2hvdDtcbiAgICAgIGlmIChjdXJyZW50ICE9PSBnZW5lcmF0aW9uIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBzaG93KHNuYXBzaG90KTtcbiAgICAgIGlmICghZm9yY2UgJiYgaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3QpKSB7XG4gICAgICAgIHZvaWQgbG9hZCh0cnVlKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKGN1cnJlbnQgIT09IGdlbmVyYXRpb24gfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb2RleCB2ZXJzaW9ucyB1bmF2YWlsYWJsZVwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKGN1cnJlbnQgPT09IGdlbmVyYXRpb24pIHJlZnJlc2guZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgdm9pZCBsb2FkKGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhWZXJzaW9uc0NhcmQoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgYnVuZGxlZCA9IHNuYXBzaG90LmNsaS5idW5kbGVkO1xuICBjb25zdCBiZXRhID0gc25hcHNob3QuY2xpLmJldGE7XG4gIGNvbnN0IGJ1c3kgPSBjb2RleFByb2dyZXNzQnVzeShzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MpO1xuXG4gIGlmIChzbmFwc2hvdC5mcm9tQ2FjaGUgfHwgc25hcHNob3Quc3RhbGUpIHtcbiAgICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc25hcHNob3QuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFxuICAgICAgc25hcHNob3Quc3RhbGUgPyBcIkNhY2hlZCBpbmZvcm1hdGlvbiAocmVmcmVzaCBuZWVkZWQpXCIgOiBcIkNhY2hlZCBpbmZvcm1hdGlvblwiLFxuICAgICAgYFNob3dpbmcgdGhlIGxhc3Qga25vd24gZ29vZCByZXN1bHQgZnJvbSAke2NoZWNrZWR9IHdoaWxlIGN1cnJlbnQgaW5mb3JtYXRpb24gbG9hZHMuYCxcbiAgICApKTtcbiAgfVxuXG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhWZXJzaW9uU3VyZmFjZU92ZXJ2aWV3KHNuYXBzaG90KSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhBY3RpdmVDbGlSb3coc25hcHNob3QpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleEVtYmVkZGVkQ2xpUm93KGJ1bmRsZWQsIHNuYXBzaG90KSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhMYXRlc3RTdGFibGVSZWxlYXNlUm93KGJ1bmRsZWQpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleENsaVJvdyhcIk1hbmFnZWQgQWxwaGEgQ0xJIChQcmUtcmVsZWFzZSlcIiwgXCJiZXRhXCIsIGJldGEsIHNuYXBzaG90LCBidXN5LCByZWxvYWQpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleFJ1bnRpbWVSb3coc25hcHNob3QpKTtcblxuICBjb25zdCByZWxlYXNlcyA9IGFjdGlvblJvdyhcIkdpdEh1YiBSZWxlYXNlc1wiLCBcIlZpZXcgb2ZmaWNpYWwgT3BlbkFJIENvZGV4IHJlbGVhc2Ugbm90ZXMgYW5kIHBhY2thZ2VzLlwiKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyZWxlYXNlcyk7XG4gIHJlbGVhc2VzLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJPcGVuIFJlbGVhc2VzXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChcImh0dHBzOi8vZ2l0aHViLmNvbS9vcGVuYWkvY29kZXgvcmVsZWFzZXNcIikpLFxuICApO1xuICBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VzKTtcblxuICBpZiAoc25hcHNob3QuaW5zdGFsbFByb2dyZXNzICYmIHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcy5waGFzZSAmJiBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MucGhhc2UgIT09IFwiaWRsZVwiKSB7XG4gICAgY29uc3QgcCA9IHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcztcbiAgICBjb25zdCBhbW91bnQgPSBmb3JtYXRCeXRlcyhwLmJ5dGVzKTtcbiAgICBjb25zdCBkZXRhaWwgPSBwLmVycm9yIHx8IFtodW1hbml6ZUNvZGV4UGhhc2UocC5waGFzZSksIHAudmVyc2lvbiwgYW1vdW50XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcdTAwQjcgXCIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQWxwaGEgb3BlcmF0aW9uXCIsIGRldGFpbCkpO1xuICB9XG5cbiAgY29uc3Qgc3RhdGVNZXNzYWdlID0gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdCk7XG4gIGlmIChzdGF0ZU1lc3NhZ2UpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUnVudGltZSBzdGF0dXNcIiwgc3RhdGVNZXNzYWdlKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhGZWF0dXJlQnJvd3NlcihzbmFwc2hvdCwgYnVzeSwgcmVsb2FkKSk7XG59XG5cbmZ1bmN0aW9uIGNvZGV4VmVyc2lvblN1cmZhY2VPdmVydmlldyhzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBzdGFibGUgPSBzbmFwc2hvdC5jbGkuYnVuZGxlZC5yZWxlYXNlPy52ZXJzaW9uID8/IFwiTm90IGNoZWNrZWRcIjtcbiAgY29uc3QgcHJlcmVsZWFzZSA9IHNuYXBzaG90LmNsaS5iZXRhLnJlbGVhc2U/LnZlcnNpb24gPz8gXCJOb3QgY2hlY2tlZFwiO1xuICBjb25zdCBkZXNrdG9wUHJlcmVsZWFzZSA9IHNuYXBzaG90LmNsaS5idW5kbGVkLnZlcnNpb25DaGFubmVsID09PSBcInByZXJlbGVhc2VcIlxuICAgID8gc25hcHNob3QuY2xpLmJ1bmRsZWQudmVyc2lvbiA/PyBcIk5vdCBjaGVja2VkXCJcbiAgICA6IFwiTm90IGluY2x1ZGVkIGluIHRoaXMgZGVza3RvcCByZWxlYXNlXCI7XG4gIGNvbnN0IG92ZXJ2aWV3ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcnZpZXcuY2xhc3NOYW1lID0gXCJncmlkIGdyaWQtY29scy0xIGdhcC0zIHAtMyBtZDpncmlkLWNvbHMtMlwiO1xuICBvdmVydmlldy5kYXRhc2V0LnR3ZWFrZXJDb2RleFZlcnNpb25PdmVydmlldyA9IFwidHJ1ZVwiO1xuICBvdmVydmlldy5hcHBlbmQoXG4gICAgY29kZXhWZXJzaW9uU3VyZmFjZVN1bW1hcnkoXCJUZXJtaW5hbFwiLCBbXG4gICAgICBbXCJMYXRlc3QgUmVsZWFzZVwiLCBzdGFibGVdLFxuICAgICAgW1wiTGF0ZXN0IFByZS1SZWxlYXNlXCIsIHByZXJlbGVhc2VdLFxuICAgICAgW1wiQ3VycmVudFwiLCBzbmFwc2hvdC50ZXJtaW5hbENsaS52ZXJzaW9uID8/IFwiTm90IGluc3RhbGxlZFwiXSxcbiAgICBdKSxcbiAgICBjb2RleFZlcnNpb25TdXJmYWNlU3VtbWFyeShcIkRlc2t0b3AgbWFjT1NcIiwgW1xuICAgICAgW1wiTGF0ZXN0IFJlbGVhc2VcIiwgc3RhYmxlXSxcbiAgICAgIFtcIkxhdGVzdCBQcmUtUmVsZWFzZVwiLCBkZXNrdG9wUHJlcmVsZWFzZV0sXG4gICAgICBbXCJDdXJyZW50XCIsIHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIl0sXG4gICAgXSksXG4gICk7XG4gIHJldHVybiBvdmVydmlldztcbn1cblxuZnVuY3Rpb24gY29kZXhWZXJzaW9uU3VyZmFjZVN1bW1hcnkoXG4gIHRpdGxlVGV4dDogc3RyaW5nLFxuICBtZXRyaWNzOiBSZWFkb25seUFycmF5PHJlYWRvbmx5IFtsYWJlbDogc3RyaW5nLCB2YWx1ZTogc3RyaW5nXT4sXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHN1cmZhY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdXJmYWNlLmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTIgcm91bmRlZC1sZyBib3JkZXIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gIHN1cmZhY2UuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBmb3IgKGNvbnN0IFtsYWJlbCwgdmFsdWVdIG9mIG1ldHJpY3MpIHtcbiAgICBjb25zdCBtZXRyaWMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIG1ldHJpYy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1iYXNlbGluZSBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgICBjb25zdCBrZXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBrZXkuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQteHNcIjtcbiAgICBrZXkudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICBjb25zdCB2ZXJzaW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgdmVyc2lvbi5jbGFzc05hbWUgPSBcIm1pbi13LTAgdHJ1bmNhdGUgdGV4dC1yaWdodCBmb250LW1vbm8gdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHZlcnNpb24udGV4dENvbnRlbnQgPSB2YWx1ZTtcbiAgICB2ZXJzaW9uLnRpdGxlID0gdmFsdWU7XG4gICAgbWV0cmljLmFwcGVuZChrZXksIHZlcnNpb24pO1xuICAgIHN1cmZhY2UuYXBwZW5kQ2hpbGQobWV0cmljKTtcbiAgfVxuICByZXR1cm4gc3VyZmFjZTtcbn1cblxuZnVuY3Rpb24gY29kZXhBY3RpdmVDbGlSb3coc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYWN0aXZlID0gc25hcHNob3QuYWN0aXZlQ2xpO1xuICBjb25zdCB2ZXJzaW9uID0gYWN0aXZlLnZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICBjb25zdCBjaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGFjdGl2ZS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IHNvdXJjZSA9IGFjdGl2ZS5zb3VyY2UgPT09IFwiYnVuZGxlZFwiXG4gICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgZW1iZWRkZWQgaW4gdGhlIE9wZW5BSSBkZXNrdG9wIGFwcCBcdTAwQjcgYXBwLW1hbmFnZWRgXG4gICAgOiBhY3RpdmUuc291cmNlID09PSBcIm1hbmFnZWQtYWxwaGFcIlxuICAgICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgbWFuYWdlZCBieSBUd2Vha2Vyc2BcbiAgICAgIDogYCR7Y2hhbm5lbH0gXHUwMEI3IGV4dGVybmFsIENPREVYX0NMSV9QQVRIIG92ZXJyaWRlYDtcbiAgY29uc3QgZGV0YWlsID0gW2BWZXJzaW9uICR7dmVyc2lvbn1gLCBzb3VyY2UsIGFjdGl2ZS5wYXRoLCBhY3RpdmUuZXJyb3JdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkFjdGl2ZSBDb2RleCBiYWNrZW5kXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gYWN0aXZlLnBhdGg7XG4gIHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChcbiAgICBzdGF0dXNCYWRnZShhY3RpdmUuYXZhaWxhYmxlID8gXCJva1wiIDogXCJlcnJvclwiLCBhY3RpdmUuYXZhaWxhYmxlID8gXCJBY3RpdmVcIiA6IFwiVW5hdmFpbGFibGVcIiksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RW1iZWRkZWRDbGlSb3coXG4gIGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHZlcnNpb24gPSBjbGkudmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gIGNvbnN0IGNoYW5uZWwgPSBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoY2xpLnZlcnNpb25DaGFubmVsKTtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIGBWZXJzaW9uICR7dmVyc2lvbn1gLFxuICAgIGNoYW5uZWwsXG4gICAgXCJFbWJlZGRlZCBpbiB0aGUgT3BlbkFJIGRlc2t0b3AgYXBwOyBpdCBjaGFuZ2VzIG9ubHkgd2hlbiBPcGVuQUkgc2hpcHMgYSBkZXNrdG9wIHVwZGF0ZVwiLFxuICAgIGNsaS5wYXRoLFxuICAgIGNsaS5hdmFpbGFibGUgPyBudWxsIDogY2xpLmVycm9yLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkRlc2t0b3AtRW1iZWRkZWQgQ29kZXggQ0xJXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gY2xpLnBhdGggPz8gXCJcIjtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCIpIGFjdGlvbnM/LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJBY3RpdmVcIikpO1xuICBlbHNlIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQXBwLW1hbmFnZWRcIikpO1xuICBpZiAoY2xpLnZlcnNpb24pIHtcbiAgICBjb25zdCByZWxlYXNlVXJsID0gYGh0dHBzOi8vZ2l0aHViLmNvbS9vcGVuYWkvY29kZXgvcmVsZWFzZXMvdGFnL3J1c3QtdiR7ZW5jb2RlVVJJQ29tcG9uZW50KGNsaS52ZXJzaW9uKX1gO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlVXJsKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4TGF0ZXN0U3RhYmxlUmVsZWFzZVJvdyhjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZWxlYXNlID0gY2xpLnJlbGVhc2U7XG4gIGNvbnN0IGRldGFpbCA9IHJlbGVhc2VcbiAgICA/IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSAke3JlbGVhc2UudmVyc2lvbn0gXHUwMEI3IFRoaXMgZG9lcyBub3QgcmVwbGFjZSB0aGUgZGVza3RvcC1lbWJlZGRlZCBiYWNrZW5kLmBcbiAgICA6IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSB1bmF2YWlsYWJsZSR7Y2xpLmVycm9yID8gYCBcdTAwQjcgJHtjbGkuZXJyb3J9YCA6IFwiXCJ9YDtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiTGF0ZXN0IFN0YWJsZSBDTEkgUmVsZWFzZVwiLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJTdGFibGVcIikpO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwocmVsZWFzZT8ucmVsZWFzZVVybCkpIHtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZSEucmVsZWFzZVVybCkpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleENsaVJvdyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgbGFuZTogQ29kZXhDbGlMYW5lLFxuICBjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlLFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGNsaS5tYW5hZ2VkQ3VycmVudFZlcnNpb24gPz8gY2xpLnZlcnNpb247XG4gIGNvbnN0IGxhdGVzdCA9IGNsaS5yZWxlYXNlPy52ZXJzaW9uO1xuICBjb25zdCBkZXRhaWwgPSBpbnN0YWxsZWRMYXRlc3RTdW1tYXJ5KGluc3RhbGxlZCwgbGF0ZXN0LCBjbGkuZXJyb3IgfHwgY2xpLnJlbGVhc2U/LmVycm9yKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KGxhYmVsLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgaWYgKHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgPT09IGxhbmUpIGFjdGlvbnM/LnByZXBlbmQoc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkFjdGl2ZVwiKSk7XG4gIGNvbnN0IHJlbGVhc2VVcmwgPSBjbGkucmVsZWFzZT8ucmVsZWFzZVVybDtcbiAgaWYgKGlzU2FmZUNvZGV4R2l0aHViVXJsKHJlbGVhc2VVcmwpKSBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZVVybCEpKSk7XG4gIGlmIChsYW5lID09PSBcImJldGFcIikge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGluc3RhbGxlZCAmJiBsYXRlc3QgJiYgaW5zdGFsbGVkICE9PSBsYXRlc3QgPyBcIlVwZGF0ZVwiIDogaW5zdGFsbGVkID8gXCJSZWluc3RhbGxcIiA6IFwiSW5zdGFsbFwiO1xuICAgIGNvbnN0IGluc3RhbGwgPSBjb21wYWN0QnV0dG9uKGluc3RhbGxMYWJlbCwgKCkgPT4gcnVuQ29kZXhBY3Rpb24ocm93LCBcInR3ZWFrZXI6aW5zdGFsbC1jb2RleC1iZXRhXCIsIHVuZGVmaW5lZCwgcmVsb2FkKSk7XG4gICAgaW5zdGFsbC5kaXNhYmxlZCA9IGJ1c3kgfHwgIWxhdGVzdDtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChpbnN0YWxsKTtcbiAgICBjb25zdCBwcmV2aW91c1ZlcnNpb24gPSBjbGkubWFuYWdlZFByZXZpb3VzVmVyc2lvbjtcbiAgICBpZiAocHJldmlvdXNWZXJzaW9uKSB7XG4gICAgICBjb25zdCByb2xsYmFjayA9IGNvbXBhY3RCdXR0b24oYFJvbGxiYWNrIHRvICR7cHJldmlvdXNWZXJzaW9ufWAsICgpID0+IHJ1bkNvZGV4QWN0aW9uKHJvdywgXCJ0d2Vha2VyOnJvbGxiYWNrLWNvZGV4LWJldGFcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgICAgIHJvbGxiYWNrLmRpc2FibGVkID0gYnVzeTtcbiAgICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJvbGxiYWNrKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lUm93KFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZXF1ZXN0ZWQgPSBzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lO1xuICBjb25zdCBzZWxlY3RlZCA9IHJlcXVlc3RlZFxuICAgID8gcmVxdWVzdGVkID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWQgKGFwcC1tYW5hZ2VkKVwiXG4gICAgOiBzbmFwc2hvdC51c2VyT3ZlcnJpZGVQcmVzZXJ2ZWQgPyBcIkV4dGVybmFsIG92ZXJyaWRlXCIgOiBcIk5vdCBleHBsaWNpdGx5IHNlbGVjdGVkXCI7XG4gIGNvbnN0IGFjdGl2ZSA9IHNuYXBzaG90LmFjdGl2ZUNsaS5zb3VyY2UgPT09IFwibWFuYWdlZC1hbHBoYVwiXG4gICAgPyBcIk1hbmFnZWQgQWxwaGFcIlxuICAgIDogc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCJcbiAgICAgID8gXCJEZXNrdG9wLWVtYmVkZGVkXCJcbiAgICAgIDogXCJFeHRlcm5hbCBvdmVycmlkZVwiO1xuICBjb25zdCBhY3RpdmVDaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IGFjdGl2ZVZlcnNpb24gPSBzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbiA/IGAgJHtzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbn1gIDogXCJcIjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiU2VsZWN0ZWQgcnVudGltZVwiLFxuICAgIGBTZWxlY3RlZDogJHtzZWxlY3RlZH0uIEFjdGl2ZTogJHthY3RpdmV9JHthY3RpdmVWZXJzaW9ufSBcdTAwQjcgJHthY3RpdmVDaGFubmVsfS4gRGVza3RvcCBwcm9maWxlIGFuZCBDTEkgcmVsZWFzZSBjaGFubmVsIGFyZSByZXBvcnRlZCBzZXBhcmF0ZWx5LmAsXG4gICk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIk1hbmFnZWQgYnkgRW52aXJvbm1lbnRcIikpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVCcm93c2VyKFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdyYXBwZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3cmFwcGVyLmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5kYXRhc2V0LnR3ZWFrZXJGZWF0dXJlQnJvd3NlciA9IFwidHJ1ZVwiO1xuICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gIHN1bW1hcnkuY2xhc3NOYW1lID0gXCJjdXJzb3ItcG9pbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGNvbnN0IGZlYXR1cmVzID0gc25hcHNob3QuZmVhdHVyZXM7XG4gIHN1bW1hcnkudGV4dENvbnRlbnQgPSBgQ29kZXggQ0xJIGZlYXR1cmVzICgke2ZlYXR1cmVzLmxlbmd0aH0pYDtcbiAgZGV0YWlscy5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcbiAgY29uc3QgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvbnRlbnQuY2xhc3NOYW1lID0gXCJtdC0zIGZsZXggZmxleC1jb2wgZ2FwLTNcIjtcbiAgY29uc3QgZmlsdGVycyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZpbHRlcnMuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2gudHlwZSA9IFwic2VhcmNoXCI7XG4gIHNlYXJjaC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIENvZGV4IGZlYXR1cmVzXCI7XG4gIHNlYXJjaC5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIG1pbi13LVsxODBweF0gZmxleC0xIHJvdW5kZWQtbWQgYm9yZGVyIHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBjb25zdCBzdGFnZSA9IGNvZGV4RmlsdGVyU2VsZWN0KFwiU3RhZ2VcIiwgW1wiYWxsXCIsIFwic3RhYmxlXCIsIFwiZXhwZXJpbWVudGFsXCIsIFwidW5kZXItZGV2ZWxvcG1lbnRcIiwgXCJkZXByZWNhdGVkXCIsIFwicmVtb3ZlZFwiXSk7XG4gIGNvbnN0IGxhbmUgPSBjb2RleEZpbHRlclNlbGVjdChcIkxhbmVcIiwgW1wiYWxsXCIsIFwiYnVuZGxlZFwiLCBcImJldGFcIiwgXCJidW5kbGVkLW9ubHlcIiwgXCJiZXRhLW9ubHlcIl0pO1xuICBjb25zdCBzdGF0dXMgPSBjb2RleEZpbHRlclNlbGVjdChcIlN0YXR1c1wiLCBbXCJhbGxcIiwgXCJlbmFibGVkXCIsIFwiZGlzYWJsZWRcIiwgXCJ1bnN1cHBvcnRlZFwiLCBcInJlYWQtb25seVwiXSk7XG4gIGZpbHRlcnMuYXBwZW5kKHNlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1cyk7XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQoZmlsdGVycyk7XG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjb250ZW50LmFwcGVuZENoaWxkKGxpc3QpO1xuICBjb25zdCBkcmF3ID0gKCkgPT4ge1xuICAgIGxpc3QudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IHNlbGVjdGVkTGFuZSA9IHNuYXBzaG90LnJlcXVlc3RlZExhbmUgPz8gc25hcHNob3QuZWZmZWN0aXZlTGFuZSA/PyBcImJ1bmRsZWRcIjtcbiAgICBjb25zdCBzaG93biA9IGZlYXR1cmVzLmZpbHRlcigoZmVhdHVyZSkgPT4ge1xuICAgICAgY29uc3QgZmVhdHVyZVN0YWdlID0gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgc2VsZWN0ZWRMYW5lKTtcbiAgICAgIGNvbnN0IGVuYWJsZWQgPSBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSk7XG4gICAgICBjb25zdCBsYW5lTWF0Y2ggPSBsYW5lLnZhbHVlID09PSBcImFsbFwiXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWQtb25seVwiICYmIGZlYXR1cmUuYnVuZGxlZE9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGEtb25seVwiICYmIGZlYXR1cmUuYmV0YU9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWRcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJ1bmRsZWRcIikgIT09IG51bGwpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGFcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJldGFcIikgIT09IG51bGwpO1xuICAgICAgY29uc3Qgc3RhdHVzTWF0Y2ggPSBzdGF0dXMudmFsdWUgPT09IFwiYWxsXCIgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJlbmFibGVkXCIgJiYgZW5hYmxlZCA9PT0gdHJ1ZSkgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJkaXNhYmxlZFwiICYmIGVuYWJsZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInVuc3VwcG9ydGVkXCIgJiYgZmVhdHVyZS5zdXBwb3J0ZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInJlYWQtb25seVwiICYmICFjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSkpO1xuICAgICAgcmV0dXJuICghcXVlcnkgfHwgZmVhdHVyZS5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpKSAmJiAoc3RhZ2UudmFsdWUgPT09IFwiYWxsXCIgfHwgc3RhZ2UudmFsdWUgPT09IGZlYXR1cmVTdGFnZSkgJiYgbGFuZU1hdGNoICYmIHN0YXR1c01hdGNoO1xuICAgIH0pO1xuICAgIGZvciAoY29uc3QgZmVhdHVyZSBvZiBzaG93bikgbGlzdC5hcHBlbmRDaGlsZChjb2RleEZlYXR1cmVSb3coZmVhdHVyZSwgc2VsZWN0ZWRMYW5lLCBidXN5LCByZWxvYWQpKTtcbiAgICBpZiAoIXNob3duLmxlbmd0aCkgbGlzdC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJObyBtYXRjaGluZyBmZWF0dXJlc1wiLCBcIlRyeSBhIGRpZmZlcmVudCBzZWFyY2ggb3IgZmlsdGVyLlwiKSk7XG4gIH07XG4gIGZvciAoY29uc3QgaW5wdXQgb2YgW3NlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1c10pIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoaW5wdXQgPT09IHNlYXJjaCA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCIsIGRyYXcpO1xuICBkcmF3KCk7XG4gIGRldGFpbHMuYXBwZW5kQ2hpbGQoY29udGVudCk7XG4gIHdyYXBwZXIuYXBwZW5kQ2hpbGQoZGV0YWlscyk7XG4gIHJldHVybiB3cmFwcGVyO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVSb3coXG4gIGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LFxuICBsYW5lOiBDb2RleENsaUxhbmUsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgY29uc3QgZW5hYmxlZCA9IGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSk7XG4gIGNvbnN0IG11dGFibGUgPSBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIGxhbmUpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gcm93Q29weShmZWF0dXJlLm5hbWUsIGAke3N0YWdlIHx8IFwidW5zdXBwb3J0ZWRcIn0gXHUwMEI3ICR7ZmVhdHVyZS5lZmZlY3QgPT09IFwicmVzdGFydFwiID8gXCJSZXN0YXJ0IHJlcXVpcmVkXCIgOiBmZWF0dXJlLmVmZmVjdCA9PT0gXCJub25lXCIgPyBcIk5vIHJlc3RhcnRcIiA6IFwiQXBwbGllcyB0byBuZXcgc2Vzc2lvbnNcIn1gKTtcbiAgY29uc3QgYmFkZ2VzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYmFkZ2VzLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIGlmIChmZWF0dXJlLmJ1bmRsZWRPbmx5KSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJCdW5kbGVkIG9ubHlcIikpO1xuICBpZiAoZmVhdHVyZS5iZXRhT25seSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQmV0YSBvbmx5XCIpKTtcbiAgaWYgKGZlYXR1cmUuc3VwcG9ydGVkID09PSBmYWxzZSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiVW5zdXBwb3J0ZWRcIikpO1xuICBpZiAoZW5hYmxlZCA9PT0gdHJ1ZSkgYmFkZ2VzLmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJFbmFibGVkXCIpKTtcbiAgaWYgKGVuYWJsZWQgPT09IGZhbHNlKSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJEaXNhYmxlZFwiKSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoYmFkZ2VzKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBpZiAobXV0YWJsZSAmJiBlbmFibGVkICE9PSBudWxsKSB7XG4gICAgY29uc3QgdG9nZ2xlID0gc3dpdGNoQ29udHJvbChlbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgdG9nZ2xlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c2V0LWNvZGV4LWZlYXR1cmVcIiwgeyBsYW5lLCBuYW1lOiBmZWF0dXJlLm5hbWUsIGVuYWJsZWQ6IG5leHQgfSk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgd2luZG93LmFsZXJ0KGBDb3VsZCBub3QgdXBkYXRlICR7ZmVhdHVyZS5uYW1lfTogJHtzYWZlVWlFcnJvcihlcnJvcil9YCk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdG9nZ2xlLmRpc2FibGVkID0gYnVzeTtcbiAgICB0b2dnbGUudGl0bGUgPSBcIkZlYXR1cmUgY2hhbmdlcyBhcHBseSB0byBuZXcgc2Vzc2lvbnMuXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHRvZ2dsZSk7XG4gIH0gZWxzZSB7XG4gICAgcm93LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKHN0YWdlID09PSBcImRlcHJlY2F0ZWRcIiB8fCBzdGFnZSA9PT0gXCJyZW1vdmVkXCIgPyBcIlJlYWQgb25seVwiIDogXCJVbmF2YWlsYWJsZVwiKSk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksIGxhbmU6IENvZGV4Q2xpTGFuZSk6IENvZGV4RmVhdHVyZVN0YWdlIHwgbnVsbCB7XG4gIHJldHVybiBmZWF0dXJlLnN0YWdlc1tsYW5lXTtcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSwgbGFuZTogQ29kZXhDbGlMYW5lKTogYm9vbGVhbiB8IG51bGwge1xuICByZXR1cm4gZmVhdHVyZS5lbmFibGVkW2xhbmVdO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LCBsYW5lOiBDb2RleENsaUxhbmUpOiBib29sZWFuIHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgcmV0dXJuIGZlYXR1cmUubXV0YWJsZSA9PT0gdHJ1ZVxuICAgICYmIGZlYXR1cmUuc3VwcG9ydGVkICE9PSBmYWxzZVxuICAgICYmIHN0YWdlICE9PSBcImRlcHJlY2F0ZWRcIlxuICAgICYmIHN0YWdlICE9PSBcInJlbW92ZWRcIlxuICAgICYmIGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSkgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmlsdGVyU2VsZWN0KGxhYmVsOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdKTogSFRNTFNlbGVjdEVsZW1lbnQge1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID0gXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciByb3VuZGVkLW1kIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgc2VsZWN0LnRpdGxlID0gbGFiZWw7XG4gIGZvciAoY29uc3QgdmFsdWUgb2Ygb3B0aW9ucykge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gdmFsdWUgPT09IFwiYWxsXCIgPyBgQWxsICR7bGFiZWwudG9Mb3dlckNhc2UoKX1zYCA6IGh1bWFuaXplQ29kZXhQaGFzZSh2YWx1ZSk7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdDtcbn1cblxuZnVuY3Rpb24gY29kZXhOZXV0cmFsQmFkZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3c6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHJvdy5jbGFzc0xpc3QuYWRkKFwiZmxleC13cmFwXCIpO1xuICByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKT8uY2xhc3NMaXN0LmFkZChcImZsZXgtd3JhcFwiLCBcImp1c3RpZnktZW5kXCIpO1xufVxuXG5mdW5jdGlvbiBjb2RleElubGluZU1lc3NhZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtZXNzYWdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWVzc2FnZS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIG1lc3NhZ2UudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gbWVzc2FnZTtcbn1cblxuZnVuY3Rpb24gY29kZXhQcm9ncmVzc0J1c3kocHJvZ3Jlc3M6IENvZGV4SW5zdGFsbFByb2dyZXNzKTogYm9vbGVhbiB7XG4gIHJldHVybiAhW1wiaWRsZVwiLCBcImNvbXBsZXRlXCIsIFwiZmFpbGVkXCJdLmluY2x1ZGVzKHByb2dyZXNzLnBoYXNlKTtcbn1cblxuZnVuY3Rpb24gaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc25hcHNob3Quc3RhbGU7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxlZExhdGVzdFN1bW1hcnkoXG4gIGluc3RhbGxlZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgbGF0ZXN0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBlcnJvcj86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBpbnN0YWxsZWRUZXh0ID0gaW5zdGFsbGVkIHx8IFwiVW5hdmFpbGFibGVcIjtcbiAgY29uc3QgbGF0ZXN0VGV4dCA9IGxhdGVzdCB8fCBcIlVuYXZhaWxhYmxlXCI7XG4gIHJldHVybiBgSW5zdGFsbGVkICR7aW5zdGFsbGVkVGV4dH0gXHUwMEI3IExhdGVzdCAke2xhdGVzdFRleHR9JHtlcnJvciA/IGAgXHUwMEI3ICR7ZXJyb3J9YCA6IFwiXCJ9YDtcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChzbmFwc2hvdC5mYWxsYmFja1JlYXNvbikgcmV0dXJuIGBNYW5hZ2VkIEFscGhhIGNvdWxkIG5vdCBzdGFydDsgdGhlIGRlc2t0b3AtZW1iZWRkZWQgYmFja2VuZCB3YXMgdXNlZC4gJHtzbmFwc2hvdC5mYWxsYmFja1JlYXNvbn1gO1xuICBpZiAoc25hcHNob3QucmVzdGFydFJlcXVpcmVkKSByZXR1cm4gXCJSZXN0YXJ0IHRoZSBhcHAgdG8gYXBwbHkgdGhlIHNlbGVjdGVkIENvZGV4IHJ1bnRpbWUuXCI7XG4gIGlmIChzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lICYmIHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgJiYgc25hcHNob3QucmVxdWVzdGVkTGFuZSAhPT0gc25hcHNob3QuZWZmZWN0aXZlTGFuZSkge1xuICAgIHJldHVybiBgJHtzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWRcIn0gaXMgc2VsZWN0ZWQ7ICR7c25hcHNob3QuZWZmZWN0aXZlTGFuZSA9PT0gXCJiZXRhXCIgPyBcIk1hbmFnZWQgQWxwaGEgKFByZS1yZWxlYXNlKVwiIDogXCJEZXNrdG9wLWVtYmVkZGVkXCJ9IHJlbWFpbnMgYWN0aXZlIHVudGlsIHJlc3RhcnQuYDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGNoYW5uZWw6IENvZGV4Q2xpVmVyc2lvblN0YXRlW1widmVyc2lvbkNoYW5uZWxcIl0pOiBzdHJpbmcge1xuICBpZiAoY2hhbm5lbCA9PT0gXCJzdGFibGVcIikgcmV0dXJuIFwiU3RhYmxlXCI7XG4gIGlmIChjaGFubmVsID09PSBcInByZXJlbGVhc2VcIikgcmV0dXJuIFwiUHJlLXJlbGVhc2VcIjtcbiAgcmV0dXJuIFwiVW5rbm93biByZWxlYXNlIGNoYW5uZWxcIjtcbn1cblxuZnVuY3Rpb24gY29kZXhTY29wZWRFcnJvcihcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgc2NvcGU6IFwiZGVza3RvcFwiIHwgQ29kZXhDbGlMYW5lLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzbmFwc2hvdC5lcnJvcnNbc2NvcGVdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzU2FmZUNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBpZiAoIXVybCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsKTtcbiAgICByZXR1cm4gcGFyc2VkLnByb3RvY29sID09PSBcImh0dHBzOlwiXG4gICAgICAmJiBwYXJzZWQuaG9zdG5hbWUgPT09IFwiZ2l0aHViLmNvbVwiXG4gICAgICAmJiBwYXJzZWQucG9ydCA9PT0gXCJcIlxuICAgICAgJiYgcGFyc2VkLnVzZXJuYW1lID09PSBcIlwiXG4gICAgICAmJiBwYXJzZWQucGFzc3dvcmQgPT09IFwiXCJcbiAgICAgICYmIChwYXJzZWQucGF0aG5hbWUgPT09IFwiL29wZW5haS9jb2RleFwiIHx8IHBhcnNlZC5wYXRobmFtZS5zdGFydHNXaXRoKFwiL29wZW5haS9jb2RleC9cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gb3BlbkNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNTYWZlQ29kZXhHaXRodWJVcmwodXJsKSkge1xuICAgIHBsb2coXCJibG9ja2VkIG5vbi1Db2RleCBHaXRIdWIgVVJMXCIsIHVybCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCkuY2F0Y2goKGVycm9yKSA9PiBwbG9nKFwib3BlbiBDb2RleCByZWxlYXNlIGZhaWxlZFwiLCBTdHJpbmcoZXJyb3IpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bkNvZGV4QWN0aW9uKFxuICByb3c6IEhUTUxFbGVtZW50LFxuICBjaGFubmVsOiBzdHJpbmcsXG4gIHBheWxvYWQ6IHVua25vd24sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IHZvaWQge1xuICBjb25zdCBidXR0b25zID0gcm93LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyB9KTtcbiAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgcmVsb2FkKFwib3BlcmF0aW9uLXN0YXJ0XCIpO1xuICBjb25zdCBpbnZva2UgPSBwYXlsb2FkID09PSB1bmRlZmluZWQgPyBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCkgOiBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCwgcGF5bG9hZCk7XG4gIHZvaWQgaW52b2tlXG4gICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgd2luZG93LmFsZXJ0KHNhZmVVaUVycm9yKGVycm9yKSk7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgICByZWxvYWQoXCJvcGVyYXRpb24tc3RvcFwiKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZVVpRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IgfHwgXCJVbmtub3duIGVycm9yXCIpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRCeXRlcyh2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlIDwgMTAyNCkgcmV0dXJuIGAke3ZhbHVlfSBCYDtcbiAgaWYgKHZhbHVlIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsodmFsdWUgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIHJldHVybiBgJHsodmFsdWUgLyAoMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpfSBNQmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZDogSFRNTEVsZW1lbnQsIGNvbmZpZzogVHdlYWtlckNvbmZpZyk6IHZvaWQge1xuICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjb25maWcudXBkYXRlQ2hlY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGF1dG9VcGRhdGVSb3coY29uZmlnKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQodXBkYXRlQ2hhbm5lbFJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChpbnN0YWxsYXRpb25Tb3VyY2VSb3coY29uZmlnLmluc3RhbGxhdGlvblNvdXJjZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHNlbGZVcGRhdGVTdGF0dXNSb3coY29uZmlnLnNlbGZVcGRhdGUpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2s/LnJlbGVhc2VOb3RlcykgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlTm90ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG59XG5cbmZ1bmN0aW9uIGF1dG9VcGRhdGVSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkF1dG9tYXRpY2FsbHkgcmVmcmVzaCBUd2Vha2Vyc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjaGVja3MgaG91cmx5IGFuZCBjYW4gcmVmcmVzaCB0aGUgVHdlYWtlcnMgcnVudGltZSBhdXRvbWF0aWNhbGx5LmA7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJvdy5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKGNvbmZpZy5hdXRvVXBkYXRlLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzZXQtYXV0by11cGRhdGVcIiwgbmV4dCk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUNoYW5uZWxSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJSZWxlYXNlIGNoYW5uZWxcIiwgdXBkYXRlQ2hhbm5lbFN1bW1hcnkoY29uZmlnKSk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID1cbiAgICBcImgtOCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZm9yIChjb25zdCBbdmFsdWUsIGxhYmVsXSBvZiBbXG4gICAgW1wic3RhYmxlXCIsIFwiU3RhYmxlXCJdLFxuICAgIFtcInByZXJlbGVhc2VcIiwgXCJQcmVyZWxlYXNlXCJdLFxuICAgIFtcImN1c3RvbVwiLCBcIkN1c3RvbVwiXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgb3B0aW9uLnNlbGVjdGVkID0gY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IHZhbHVlO1xuICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICB9XG4gIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwidHdlYWtlcjpzZXQtdXBkYXRlLWNvbmZpZ1wiLCB7IHVwZGF0ZUNoYW5uZWw6IHNlbGVjdC52YWx1ZSB9KVxuICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENvbmZpZ0NhcmQocm93KSlcbiAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInNldCB1cGRhdGUgY2hhbm5lbCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gIH0pO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKHNlbGVjdCk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gXCJjdXN0b21cIikge1xuICAgIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiRWRpdFwiLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlcG8gPSB3aW5kb3cucHJvbXB0KFwiR2l0SHViIHJlcG9cIiwgY29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCIpO1xuICAgICAgICBpZiAocmVwbyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICBjb25zdCByZWYgPSB3aW5kb3cucHJvbXB0KFwiR2l0IHJlZlwiLCBjb25maWcudXBkYXRlUmVmIHx8IFwibWFpblwiKTtcbiAgICAgICAgaWYgKHJlZiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgICAgLmludm9rZShcInR3ZWFrZXI6c2V0LXVwZGF0ZS1jb25maWdcIiwge1xuICAgICAgICAgICAgdXBkYXRlQ2hhbm5lbDogXCJjdXN0b21cIixcbiAgICAgICAgICAgIHVwZGF0ZVJlcG86IHJlcG8sXG4gICAgICAgICAgICB1cGRhdGVSZWY6IHJlZixcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKCgpID0+IHJlZnJlc2hDb25maWdDYXJkKHJvdykpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwic2V0IGN1c3RvbSB1cGRhdGUgc291cmNlIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gaW5zdGFsbGF0aW9uU291cmNlUm93KHNvdXJjZTogSW5zdGFsbGF0aW9uU291cmNlKTogSFRNTEVsZW1lbnQge1xuICByZXR1cm4gcm93U2ltcGxlKFwiSW5zdGFsbGF0aW9uIHNvdXJjZVwiLCBgJHtzb3VyY2UubGFiZWx9OiAke3NvdXJjZS5kZXRhaWx9YCk7XG59XG5cbmZ1bmN0aW9uIHNlbGZVcGRhdGVTdGF0dXNSb3coc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShcIkxhc3QgVHdlYWtlcnMgdXBkYXRlXCIsIHNlbGZVcGRhdGVTdW1tYXJ5KHN0YXRlKSk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCAmJiBzdGF0ZSkge1xuICAgIGNvbnN0IHVucHVibGlzaGVkID0gc3RhdGUuc3RhdHVzID09PSBcImZhaWxlZFwiICYmIC80MDR8bm8gKD86cHVibGlzaGVkIHxnaXRodWIgKT9yZWxlYXNlL2kudGVzdChzdGF0ZS5lcnJvciA/PyBcIlwiKTtcbiAgICBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UodW5wdWJsaXNoZWQgPyBcIm9rXCIgOiBzZWxmVXBkYXRlU3RhdHVzVG9uZShzdGF0ZS5zdGF0dXMpLCB1bnB1Ymxpc2hlZCA/IFwiQ3VycmVudFwiIDogc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXRlLnN0YXR1cykpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjaGVjayA9IGNvbmZpZy51cGRhdGVDaGVjaztcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA/IFwiVHdlYWtlcnMgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDaGVjayBmb3IgVHdlYWtlcnMgdXBkYXRlc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSB1cGRhdGVTdW1tYXJ5KGNoZWNrKTtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGlmIChjaGVjaz8ucmVsZWFzZVVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmVsZWFzZSBOb3Rlc1wiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGNoZWNrLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y2hlY2stdHdlYWtlci11cGRhdGVcIiwgdHJ1ZSlcbiAgICAgICAgLnRoZW4oKGNoZWNrKSA9PiB7XG4gICAgICAgICAgc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJUd2Vha2VycyByZWxlYXNlIGNoZWNrIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgaWYgKGNoZWNrPy51cGRhdGVBdmFpbGFibGUpIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkRvd25sb2FkIFVwZGF0ZVwiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgY29uc3QgYnV0dG9ucyA9IGFjdGlvbnMucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gdHJ1ZSkpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpydW4tdHdlYWtlci11cGRhdGVcIilcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbih0cnVlKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICBwbG9nKFwiVHdlYWtlcnMgc2VsZi11cGRhdGUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICAgICAgdm9pZCByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gZmFsc2UpKTtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBoZWFsdGg6IFdhdGNoZXJIZWFsdGgsXG4gIGluY2x1ZGVSZXBhaXIgPSBmYWxzZSxcbiAgb25SZXBhaXI/OiAoKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoKSk7XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgaGVhbHRoLmNoZWNrcykge1xuICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwib2tcIikgY29udGludWU7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyQ2hlY2tSb3coY2hlY2spKTtcbiAgfVxuICBpZiAoaW5jbHVkZVJlcGFpcikge1xuICAgIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICAgIFwiQXV0b21hdGljIG1haW50ZW5hbmNlXCIsXG4gICAgICBoZWFsdGguc3RhdHVzID09PSBcIm9rXCJcbiAgICAgICAgPyBcIlRoZSB3YXRjaGVyIGlzIGhlYWx0aHkgYW5kIHdpbGwgY29udGludWUgY2hlY2tpbmcgYXV0b21hdGljYWxseS5cIlxuICAgICAgICA6IFwiUmVwYWlyIHRoZSB3YXRjaGVyIHJlZ2lzdHJhdGlvbiBhbmQgcnVuIGEgZnJlc2ggaGVhbHRoIGNoZWNrLlwiLFxuICAgICk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZXBhaXIgTm93XCIsIG9uUmVwYWlyID8/ICgoKSA9PiB7XG4gICAgICBjb25zdCBidXR0b24gPSBhY3Rpb25zLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICAgICAgaWYgKGJ1dHRvbikgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItYXV0by1tYWludGVuYW5jZVwiKVxuICAgICAgICAudGhlbigoKSA9PiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKSlcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIG5leHQgYXMgV2F0Y2hlckhlYWx0aCwgdHJ1ZSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIHtcbiAgICAgICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJlcGFpciBmYWlsZWRcIixcbiAgICAgICAgICAgIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICB9KTtcbiAgICB9KSkpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShoZWFsdGguc3RhdHVzLCBoZWFsdGgud2F0Y2hlcikpO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBoZWFsdGgudGl0bGU7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGAke2hlYWx0aC5zdW1tYXJ5fSBDaGVja2VkICR7bmV3IERhdGUoaGVhbHRoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBhY3Rpb24uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJDaGVja1JvdyhjaGVjazogV2F0Y2hlckhlYWx0aENoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSByb3dTaW1wbGUoY2hlY2submFtZSwgY2hlY2suZGV0YWlsKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0KSBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoY2hlY2suc3RhdHVzKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0JhZGdlKHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIGxhYmVsPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCB0b25lID1cbiAgICBzdGF0dXMgPT09IFwib2tcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtZ3JlZW4gdGV4dC10b2tlbi1jaGFydHMtZ3JlZW5cIlxuICAgICAgOiBzdGF0dXMgPT09IFwid2FyblwiXG4gICAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdyB0ZXh0LXRva2VuLWNoYXJ0cy15ZWxsb3dcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQgdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IGBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtICR7dG9uZX1gO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsIHx8IChzdGF0dXMgPT09IFwib2tcIiA/IFwiT0tcIiA6IHN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlJldmlld1wiIDogXCJFcnJvclwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2sgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjaGVjaykgcmV0dXJuIFwiTm8gdXBkYXRlIGNoZWNrIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBsYXRlc3QgPSBjaGVjay5sYXRlc3RWZXJzaW9uID8gYExhdGVzdCB2JHtjaGVjay5sYXRlc3RWZXJzaW9ufS4gYCA6IFwiXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBgQ2hlY2tlZCAke25ldyBEYXRlKGNoZWNrLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgaWYgKGNoZWNrLmVycm9yKSByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH0gJHtjaGVjay5lcnJvcn1gO1xuICByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH1gO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWc6IFR3ZWFrZXJDb25maWcpOiBzdHJpbmcge1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IFwiY3VzdG9tXCIpIHtcbiAgICByZXR1cm4gYCR7Y29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCJ9ICR7Y29uZmlnLnVwZGF0ZVJlZiB8fCBcIihubyByZWYgc2V0KVwifWA7XG4gIH1cbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcInByZXJlbGVhc2VcIikge1xuICAgIHJldHVybiBcIlVzZSB0aGUgbmV3ZXN0IHB1Ymxpc2hlZCBHaXRIdWIgcmVsZWFzZSwgaW5jbHVkaW5nIHByZXJlbGVhc2VzLlwiO1xuICB9XG4gIHJldHVybiBcIlVzZSB0aGUgbGF0ZXN0IHN0YWJsZSBHaXRIdWIgcmVsZWFzZS5cIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIXN0YXRlKSByZXR1cm4gXCJObyBhdXRvbWF0aWMgVHdlYWtlcnMgdXBkYXRlIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc3RhdGUuY29tcGxldGVkQXQgPz8gc3RhdGUuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICBjb25zdCB0YXJnZXQgPSBzdGF0ZS5sYXRlc3RWZXJzaW9uID8gYCBUYXJnZXQgdiR7c3RhdGUubGF0ZXN0VmVyc2lvbn0uYCA6IHN0YXRlLnRhcmdldFJlZiA/IGAgVGFyZ2V0ICR7c3RhdGUudGFyZ2V0UmVmfS5gIDogXCJcIjtcbiAgY29uc3Qgc291cmNlID0gc3RhdGUuaW5zdGFsbGF0aW9uU291cmNlPy5sYWJlbCA/PyBcInVua25vd24gc291cmNlXCI7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpKSByZXR1cm4gYFNvdXJjZSBjaGVja291dCBpcyBjdXJyZW50IGFzIG9mICR7Y2hlY2tlZH07IG5vIHB1Ymxpc2hlZCByZWxlYXNlIGV4aXN0cyB5ZXQuYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIGBVcGRhdGUgY2hlY2sgbmVlZHMgYXR0ZW50aW9uICgke2NoZWNrZWR9KS4gJHtzdGF0ZS5lcnJvciA/PyBcIlVua25vd24gZXJyb3JcIn1gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcInVwZGF0ZWRcIikgcmV0dXJuIGBVcGRhdGVkICR7Y2hlY2tlZH0uJHt0YXJnZXR9IFNvdXJjZTogJHtzb3VyY2V9LmA7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gYFVwIHRvIGRhdGUgJHtjaGVja2VkfS4ke3RhcmdldH0gU291cmNlOiAke3NvdXJjZX0uYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gYFNraXBwZWQgJHtjaGVja2VkfTsgYXV0b21hdGljIHJlZnJlc2ggaXMgZGlzYWJsZWQuYDtcbiAgcmV0dXJuIGBDaGVja2luZyBmb3IgdXBkYXRlcy4gU291cmNlOiAke3NvdXJjZX0uYDtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1RvbmUoc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAoc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIgfHwgc3RhdHVzID09PSBcImNoZWNraW5nXCIpIHJldHVybiBcIndhcm5cIjtcbiAgcmV0dXJuIFwib2tcIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gXCJVcCB0byBkYXRlXCI7XG4gIGlmIChzdGF0dXMgPT09IFwidXBkYXRlZFwiKSByZXR1cm4gXCJVcGRhdGVkXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcIkZhaWxlZFwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIpIHJldHVybiBcIkRpc2FibGVkXCI7XG4gIHJldHVybiBcIkNoZWNraW5nXCI7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hDb25maWdDYXJkKHJvdzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgY2FyZCA9IHJvdy5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlci1jb25maWctY2FyZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWNhcmQpIHJldHVybjtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUmVmcmVzaGluZ1wiLCBcIkxvYWRpbmcgY3VycmVudCBUd2Vha2VycyB1cGRhdGUgc3RhdHVzLlwiKSk7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJUd2Vha2VyQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBUd2Vha2VyQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWZyZXNoIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIFR3ZWFrZXJzXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly50d2Vha2VyL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gVHdlYWtlcnMgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIENvZGV4IGFwcCB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gT1M6IFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBMb2dzXCIsXG4gICAgICAgICAgXCJBdHRhY2ggcmVsZXZhbnQgbGluZXMgZnJvbSB0aGUgVHdlYWtlcnMgbG9nIGRpcmVjdG9yeS5cIixcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLFxuICAgICAgICBgaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvaXNzdWVzL25ldz90aXRsZT0ke3RpdGxlfSZib2R5PSR7Ym9keX1gLFxuICAgICAgKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gYWN0aW9uUm93KHRpdGxlVGV4dDogc3RyaW5nLCBkZXNjcmlwdGlvbjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5kYXRhc2V0LnR3ZWFrZXJSb3dBY3Rpb25zID0gXCJ0cnVlXCI7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrU3RvcmVQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBoZWFkZXJBY3Rpb25zPzogSFRNTEVsZW1lbnQsXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtNFwiO1xuXG4gIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzb3VyY2UuaGlkZGVuID0gdHJ1ZTtcbiAgc291cmNlLmRhdGFzZXQudHdlYWtlclN0b3JlU291cmNlID0gXCJ0cnVlXCI7XG4gIHNvdXJjZS50ZXh0Q29udGVudCA9IFwiTG9hZGluZyBsaXZlIHJlZ2lzdHJ5XCI7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCByZWZyZXNoQnRuID0gc3RvcmVJY29uQnV0dG9uKHJlZnJlc2hJY29uU3ZnKCksIFwiUmVmcmVzaCB0d2VhayBzdG9yZVwiLCAoKSA9PiB7XG4gICAgcmVmcmVzaEJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShudWxsKTtcbiAgICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICAgIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UsIHJlZnJlc2hCdG4sIHRydWUpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyZWZyZXNoQnRuKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVRvb2xiYXJCdXR0b24oXCJQdWJsaXNoIFR3ZWFrXCIsIG9wZW5QdWJsaXNoVHdlYWtEaWFsb2csIFwicHJpbWFyeVwiKSk7XG4gIGlmIChoZWFkZXJBY3Rpb25zKSB7XG4gICAgaGVhZGVyQWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oYWN0aW9ucyk7XG4gIH1cblxuICBjb25zdCBncmlkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZ3JpZC5kYXRhc2V0LnR3ZWFrZXJTdG9yZUdyaWQgPSBcInRydWVcIjtcbiAgZ3JpZC5jbGFzc05hbWUgPSBcImdyaWQgZ2FwLTRcIjtcbiAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHtcbiAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gSlNPTi5zdHJpbmdpZnkoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgcmVuZGVyVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlKTtcbiAgfSBlbHNlIHtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICB9XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc291cmNlKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChncmlkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICByZWZyZXNoVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlLCByZWZyZXNoQnRuKTtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKFxuICBncmlkOiBIVE1MRWxlbWVudCxcbiAgc291cmNlOiBIVE1MRWxlbWVudCxcbiAgcmVmcmVzaEJ0bj86IEhUTUxCdXR0b25FbGVtZW50LFxuICBmb3JjZSA9IGZhbHNlLFxuKTogdm9pZCB7XG4gIHZvaWQgZ2V0VHdlYWtTdG9yZShmb3JjZSlcbiAgICAudGhlbigoc3RvcmUpID0+IHtcbiAgICAgIGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmUgPSBKU09OLnN0cmluZ2lmeShzdG9yZSk7XG4gICAgICByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gXCJcIjtcbiAgICAgIGdyaWQucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICAgICAgc291cmNlLnRleHRDb250ZW50ID0gXCJMaXZlIHJlZ2lzdHJ5IHVuYXZhaWxhYmxlXCI7XG4gICAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG51bGwpO1xuICAgICAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJDb3VsZCBub3QgbG9hZCB0d2VhayBzdG9yZVwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChyZWZyZXNoQnRuKSByZWZyZXNoQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHdhcm1Ud2Vha1N0b3JlKCk6IHZvaWQge1xuICBpZiAoc3RhdGUudHdlYWtTdG9yZSB8fCBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSkgcmV0dXJuO1xuICB2b2lkIGdldFR3ZWFrU3RvcmUoKS50aGVuKChzdG9yZSkgPT4ge1xuICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2Uob3V0ZGF0ZWRJbnN0YWxsZWRTdG9yZUNvdW50KHN0b3JlLmVudHJpZXMpKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFR3ZWFrU3RvcmUoZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8VHdlYWtTdG9yZVJlZ2lzdHJ5Vmlldz4ge1xuICBpZiAoIWZvcmNlKSB7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHJldHVybiBQcm9taXNlLnJlc29sdmUoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlKSByZXR1cm4gc3RhdGUudHdlYWtTdG9yZVByb21pc2U7XG4gIH1cbiAgc3RhdGUudHdlYWtTdG9yZUVycm9yID0gbnVsbDtcbiAgY29uc3QgcHJvbWlzZSA9IGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LXR3ZWFrLXN0b3JlXCIpXG4gICAgLnRoZW4oKHN0b3JlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlID0gc3RvcmUgYXMgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldztcbiAgICAgIHJldHVybiBzdGF0ZS50d2Vha1N0b3JlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlRXJyb3IgPSBlO1xuICAgICAgdGhyb3cgZTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9PT0gcHJvbWlzZSkgc3RhdGUudHdlYWtTdG9yZVByb21pc2UgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9IHByb21pc2U7XG4gIHJldHVybiBwcm9taXNlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkOiBIVE1MRWxlbWVudCwgc291cmNlOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzdG9yZSA9IHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQpO1xuICBpZiAoIXN0b3JlKSByZXR1cm47XG4gIGNvbnN0IGVudHJpZXMgPSBzdG9yZS5lbnRyaWVzO1xuICBncmlkLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgc291cmNlLnRleHRDb250ZW50ID0gYFJlZnJlc2hlZCAke25ldyBEYXRlKHN0b3JlLmZldGNoZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX1gO1xuICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzKSk7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBpZiAoc3RvcmUuZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJObyB0d2Vha3MgeWV0XCIsIFwiVXNlIFB1Ymxpc2ggVHdlYWsgdG8gc3VibWl0IHRoZSBmaXJzdCBvbmUuXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVDYXJkKGVudHJ5KSk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQ6IEhUTUxFbGVtZW50KTogVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB8IG51bGwge1xuICBjb25zdCByYXcgPSBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlO1xuICBpZiAoIXJhdykgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlQ2FyZChlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc2hlbGwgPSB0d2Vha1N0b3JlQ2FyZFNoZWxsKCk7XG4gIGNvbnN0IHsgY2FyZCwgbGVmdCwgc3RhY2ssIHZlcnNpb25zLCBhY3Rpb25zIH0gPSBzaGVsbDtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhcihlbnRyeSksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyaWZpZWRTYWZlQmFkZ2UoKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcblxuICBpZiAoZW50cnkubWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gdHdlYWtTdG9yZURlc2NyaXB0aW9uKCk7XG4gICAgZGVzYy50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICB9XG5cbiAgc3RhY2suYXBwZW5kQ2hpbGQodHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKGVudHJ5LnJlcG8gPz8gZW50cnkubWFuaWZlc3QuZ2l0aHViUmVwbykpO1xuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlVmVyc2lvbkJhZGdlKGVudHJ5KSk7XG5cbiAgaWYgKGVudHJ5LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBlbnRyeS5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGFzVXBkYXRlID0gISFlbnRyeS5pbnN0YWxsZWQgJiYgZW50cnkuaW5zdGFsbGVkLnZlcnNpb24gIT09IGVudHJ5Lm1hbmlmZXN0LnZlcnNpb247XG4gIGlmIChlbnRyeS5hdmFpbGFibGUgPT09IGZhbHNlKSB7XG4gICAgY2FyZC5jbGFzc0xpc3QuYWRkKFwib3BhY2l0eS03MFwiKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIk5vdCBhdmFpbGFibGUgeWV0XCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5pbnN0YWxsZWQgJiYgIWhhc1VwZGF0ZSkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5wbGF0Zm9ybSAmJiAhZW50cnkucGxhdGZvcm0uY29tcGF0aWJsZSkge1xuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcIm9wYWNpdHktNzBcIik7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwocGxhdGZvcm1Mb2NrZWRMYWJlbChlbnRyeS5wbGF0Zm9ybSkpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5ydW50aW1lICYmICFlbnRyeS5ydW50aW1lLmNvbXBhdGlibGUpIHtcbiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJvcGFjaXR5LTcwXCIpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKHJ1bnRpbWVMb2NrZWRMYWJlbChlbnRyeS5ydW50aW1lKSkpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGVudHJ5Lmluc3RhbGxlZCA/IFwiVXBkYXRlXCIgOiBcIkluc3RhbGxcIjtcbiAgICBpZiAoaGFzVXBkYXRlKSBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIlVwZGF0ZSBhdmFpbGFibGVcIiwgXCJpbmZvXCIpKTtcbiAgICBjb25zdCBpbnN0YWxsQnV0dG9uID0gc3RvcmVJbnN0YWxsQnV0dG9uKGluc3RhbGxMYWJlbCwgKGJ1dHRvbikgPT4ge1xuICAgICAgY29uc3QgZ3JpZCA9IGNhcmQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc3RvcmUtZ3JpZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgY29uc3Qgc291cmNlID0gZ3JpZD8ucGFyZW50RWxlbWVudD8ucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtc291cmNlXVwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbiwgZW50cnkuaW5zdGFsbGVkID8gXCJVcGRhdGluZ1wiIDogXCJJbnN0YWxsaW5nXCIpO1xuICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IHRydWUpKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBlbnRyeS5pZClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHNob3dTdG9yZVRvYXN0KGAke2VudHJ5Lm1hbmlmZXN0Lm5hbWV9IGluc3RhbGxlZC5gKTtcbiAgICAgICAgICBzaG93U3RvcmVCdXR0b25JbnN0YWxsZWQoYnV0dG9uKTtcbiAgICAgICAgICB2ZXJzaW9ucy5yZXBsYWNlQ2hpbGRyZW4odHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeSwgZW50cnkubWFuaWZlc3QudmVyc2lvbikpO1xuICAgICAgICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UoTWF0aC5tYXgoMCwgY3VycmVudFN0b3JlVXBkYXRlQmFkZ2VDb3VudCgpIC0gMSkpO1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgYWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgICAgICAgICAgIGlmIChncmlkICYmIHNvdXJjZSkgcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSwgdW5kZWZpbmVkLCB0cnVlKTtcbiAgICAgICAgICB9LCA5MDApO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICByZXNldFN0b3JlSW5zdGFsbEJ1dHRvbihidXR0b24sIGluc3RhbGxMYWJlbCk7XG4gICAgICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlKSk7XG4gICAgICAgICAgc2hvd1N0b3JlQ2FyZE1lc3NhZ2UoY2FyZCwgU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlID8/IGUpKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChpbnN0YWxsQnV0dG9uKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcGxhdGZvcm1Mb2NrZWRMYWJlbChwbGF0Zm9ybTogTm9uTnVsbGFibGU8VHdlYWtTdG9yZUVudHJ5Vmlld1tcInBsYXRmb3JtXCJdPik6IHN0cmluZyB7XG4gIGNvbnN0IHN1cHBvcnRlZCA9IHBsYXRmb3JtLnN1cHBvcnRlZCA/PyBbXTtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcIndpbjMyXCIpKSByZXR1cm4gXCJXaW5kb3dzIG9ubHlcIjtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcImRhcndpblwiKSkgcmV0dXJuIFwibWFjT1Mgb25seVwiO1xuICBpZiAoc3VwcG9ydGVkLmluY2x1ZGVzKFwibGludXhcIikpIHJldHVybiBcIkxpbnV4IG9ubHlcIjtcbiAgcmV0dXJuIFwiVW5hdmFpbGFibGVcIjtcbn1cblxuZnVuY3Rpb24gcnVudGltZUxvY2tlZExhYmVsKHJ1bnRpbWU6IE5vbk51bGxhYmxlPFR3ZWFrU3RvcmVFbnRyeVZpZXdbXCJydW50aW1lXCJdPik6IHN0cmluZyB7XG4gIHJldHVybiBydW50aW1lLnJlcXVpcmVkID8gYFJlcXVpcmVzIFR3ZWFrZXJzICR7cnVudGltZS5yZXF1aXJlZH1gIDogXCJSZXF1aXJlcyBuZXdlciBUd2Vha2Vyc1wiO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVDYXJkTWVzc2FnZShjYXJkOiBIVE1MRWxlbWVudCwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNhcmQucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtY2FyZC1tZXNzYWdlXVwiKT8ucmVtb3ZlKCk7XG4gIGNvbnN0IG5vdGljZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5vdGljZS5kYXRhc2V0LnR3ZWFrZXJTdG9yZUNhcmRNZXNzYWdlID0gXCJ0cnVlXCI7XG4gIG5vdGljZS5jbGFzc05hbWUgPVxuICAgIFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci81MCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMyBweS0yIHRleHQtc20gbGVhZGluZy01IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBub3RpY2UudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICBjb25zdCBhY3Rpb25zID0gY2FyZC5sYXN0RWxlbWVudENoaWxkO1xuICBpZiAoYWN0aW9ucykgY2FyZC5pbnNlcnRCZWZvcmUobm90aWNlLCBhY3Rpb25zKTtcbiAgZWxzZSBjYXJkLmFwcGVuZENoaWxkKG5vdGljZSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVDYXJkU2hlbGwoKToge1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgbGVmdDogSFRNTEVsZW1lbnQ7XG4gIHN0YWNrOiBIVE1MRWxlbWVudDtcbiAgdmVyc2lvbnM6IEhUTUxFbGVtZW50O1xuICBhY3Rpb25zOiBIVE1MRWxlbWVudDtcbn0ge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlci80MCBmbGV4IG1pbi1oLVsxOTBweF0gZmxleC1jb2wganVzdGlmeS1iZXR3ZWVuIGdhcC00IHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdHJhbnNpdGlvbi1jb2xvcnMgaG92ZXI6YmctdG9rZW4tZm9yZWdyb3VuZC81XCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0yXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGZvb3RlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZvb3Rlci5jbGFzc05hbWUgPSBcIm10LWF1dG8gZmxleCBtaW4tdy0wIGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yXCI7XG4gIGNvbnN0IHZlcnNpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdmVyc2lvbnMuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBmb290ZXIuYXBwZW5kQ2hpbGQodmVyc2lvbnMpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGZvb3Rlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChmb290ZXIpO1xuXG4gIHJldHVybiB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlVGl0bGVSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwibGluZS1jbGFtcC0zIG1pbi13LTAgdGV4dC1zbSBsZWFkaW5nLTUgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICByZXR1cm4gZGVzYztcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKHJlcG86IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgcmVhZE1vcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWFkTW9yZS50eXBlID0gXCJidXR0b25cIjtcbiAgcmVhZE1vcmUuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IHctZml0IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gIHJlYWRNb3JlLmlubmVySFRNTCA9XG4gICAgYFJlYWQgTW9yZWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTYgMy41aDYuNVYxME0xMi4yNSAzLjc1IDQgMTJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjQ1XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICByZWFkTW9yZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb31gKTtcbiAgfSk7XG4gIHJldHVybiByZWFkTW9yZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtTdG9yZUdob3N0R3JpZChncmlkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBncmlkLnNldEF0dHJpYnV0ZShcImFyaWEtYnVzeVwiLCBcInRydWVcIik7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVHaG9zdENhcmQoKSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVHaG9zdENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9ID0gdHdlYWtTdG9yZUNhcmRTaGVsbCgpO1xuICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJwb2ludGVyLWV2ZW50cy1ub25lXCIpO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhckdob3N0KCksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXktMSBoLTUgdy00NCByb3VuZGVkLW1kXCIpKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJpZmllZFNhZmVHaG9zdEJhZGdlKCkpO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgY29uc3QgZGVzYyA9IHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpO1xuICBkZXNjLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJtdC0xIGgtMyB3LWZ1bGwgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctMTEvMTIgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctNy8xMiByb3VuZGVkXCIpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG5cbiAgY29uc3QgcmVhZE1vcmUgPSB0d2Vha1N0b3JlUmVhZE1vcmVCdXR0b24oXCJcIik7XG4gIHJlYWRNb3JlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC01IHctMjQgcm91bmRlZFwiKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHJlYWRNb3JlKTtcblxuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZChzdG9yZVZlcnNpb25HaG9zdEJhZGdlKCkpO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzR2hvc3RQaWxsKCkpO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc3RvcmVBdmF0YXJHaG9zdCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTEwIHctMTAgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLWRlZmF1bHQgYmctdHJhbnNwYXJlbnQgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC1mdWxsIHctZnVsbFwiKSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHZlcmlmaWVkU2FmZUJhZGdlKCk7XG4gIGJhZGdlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC1bMTNweF0gdy1bMTNweF0gcm91bmRlZC1zbVwiKSwgZ2hvc3RCbG9jayhcImgtMyB3LTIwIHJvdW5kZWRcIikpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzR2hvc3RQaWxsKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGlsbCA9IHN0b3JlU3RhdHVzUGlsbChcIkluc3RhbGxlZFwiKTtcbiAgcGlsbC5jbGFzc0xpc3QuYWRkKFwiYW5pbWF0ZS1wdWxzZVwiKTtcbiAgcGlsbC5zdHlsZS5jb2xvciA9IFwidHJhbnNwYXJlbnRcIjtcbiAgcmV0dXJuIHBpbGw7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoZmFsc2UpO1xuICBiYWRnZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC0zIHctMzYgcm91bmRlZFwiKSk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gZ2hvc3RCbG9jayhjbGFzc05hbWU6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmxvY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBibG9jay5jbGFzc05hbWUgPSBgYW5pbWF0ZS1wdWxzZSBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwICR7Y2xhc3NOYW1lfWA7XG4gIGJsb2NrLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcbiAgcmV0dXJuIGJsb2NrO1xufVxuXG5mdW5jdGlvbiBzdG9yZUF2YXRhcihlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtMTAgdy0xMCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXItZGVmYXVsdCBiZy10cmFuc3BhcmVudCB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgY29uc3QgaW5pdGlhbCA9IChlbnRyeS5tYW5pZmVzdC5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGZhbGxiYWNrLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGZhbGxiYWNrKTtcbiAgY29uc3QgaWNvblVybCA9IHN0b3JlRW50cnlJY29uVXJsKGVudHJ5KTtcbiAgaWYgKGljb25VcmwpIHtcbiAgICBjb25zdCBpbWcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICAgIGltZy5hbHQgPSBcIlwiO1xuICAgIGltZy5jbGFzc05hbWUgPSBcImgtZnVsbCB3LWZ1bGwgb2JqZWN0LWNvdmVyXCI7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgaW1nLnNyYyA9IGljb25Vcmw7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGltZyk7XG4gIH1cbiAgcmV0dXJuIGF2YXRhcjtcbn1cblxuZnVuY3Rpb24gc3RvcmVFbnRyeUljb25VcmwoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgaWNvblVybCA9IGVudHJ5Lm1hbmlmZXN0Lmljb25Vcmw/LnRyaW0oKTtcbiAgaWYgKCFpY29uVXJsKSByZXR1cm4gbnVsbDtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopL2kudGVzdChpY29uVXJsKSkgcmV0dXJuIGljb25Vcmw7XG4gIGNvbnN0IHJlbCA9IGljb25VcmwucmVwbGFjZSgvXlxcLj9cXC8vLCBcIlwiKTtcbiAgaWYgKCFyZWwgfHwgcmVsLnN0YXJ0c1dpdGgoXCIuLi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIiB8fCAhZW50cnkucmVwbyB8fCAhZW50cnkuYXBwcm92ZWRDb21taXRTaGEpIHJldHVybiBudWxsO1xuICByZXR1cm4gYGh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS8ke2VudHJ5LnJlcG99LyR7ZW50cnkuYXBwcm92ZWRDb21taXRTaGF9LyR7cmVsfWA7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJVcGRhdGVQaWxsQnV0dG9uKCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyU2lkZWJhclVwZGF0ZSA9IFwidHJ1ZVwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtZnVsbCBiZy10b2tlbi1jaGFydHMtYmx1ZSB0ZXh0LXdoaXRlIGhvdmVyOmJnLXRva2VuLWNoYXJ0cy1ibHVlLzgwXCI7XG4gIE9iamVjdC5hc3NpZ24oYnRuLnN0eWxlLCB7XG4gICAgZGlzcGxheTogXCJub25lXCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgOHB4XCIsXG4gICAgZm9udFNpemU6IFwiMTBweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gICAgdGV4dFRyYW5zZm9ybTogXCJub25lXCIsXG4gIH0pO1xuICBidG4udGV4dENvbnRlbnQgPSBcIlVwZGF0ZVwiO1xuICBidG4udGl0bGUgPSBcIk9wZW4gVHdlYWtlcnMgdXBkYXRlXCI7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBidG4uZGF0YXNldC50d2Vha2VyUmVsZWFzZVVybCB8fCBUV0VBS0VSU19SRUxFQVNFU19VUkwpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLXR3ZWFrZXItdXBkYXRlXCIsIGZvcmNlKVxuICAgIC50aGVuKChjaGVjaykgPT4gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIHBsb2coXCJUd2Vha2VycyBzaWRlYmFyIHJlbGVhc2UgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihudWxsKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayB8IG51bGwpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgY29uc3QgdXBkYXRlQXZhaWxhYmxlID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA9PT0gdHJ1ZTtcbiAgYnRuLnN0eWxlLmRpc3BsYXkgPSB1cGRhdGVBdmFpbGFibGUgPyBcImlubGluZS1mbGV4XCIgOiBcIm5vbmVcIjtcbiAgYnRuLmhpZGRlbiA9ICF1cGRhdGVBdmFpbGFibGU7XG4gIGJ0bi5kYXRhc2V0LnR3ZWFrZXJSZWxlYXNlVXJsID0gY2hlY2s/LnJlbGVhc2VVcmwgfHwgVFdFQUtFUlNfUkVMRUFTRVNfVVJMO1xuICBidG4udGl0bGUgPVxuICAgIHVwZGF0ZUF2YWlsYWJsZSAmJiBjaGVjaz8ubGF0ZXN0VmVyc2lvblxuICAgICAgPyBgT3BlbiBUd2Vha2VycyAke2NoZWNrLmxhdGVzdFZlcnNpb259IHVwZGF0ZWBcbiAgICAgIDogXCJPcGVuIFR3ZWFrZXJzIHVwZGF0ZVwiO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKGNvdW50OiBudW1iZXIgfCBudWxsKTogdm9pZCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGlmICghYmFkZ2UpIHJldHVybjtcbiAgYmFkZ2UuZGF0YXNldC50d2Vha2VyU3RvcmVVcGRhdGVDb3VudCA9IGNvdW50ID09PSBudWxsID8gXCJcIiA6IFN0cmluZyhjb3VudCk7XG4gIGFwcGx5U3RvcmVVcGRhdGVCYWRnZVN0eWxlKGJhZGdlLCBjb3VudCk7XG4gIGJhZGdlLmhpZGRlbiA9IGNvdW50ID09PSBudWxsIHx8IGNvdW50IDw9IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gY291bnQgJiYgY291bnQgPiAwID8gU3RyaW5nKGNvdW50KSA6IFwiXCI7XG4gIGJhZGdlLnRpdGxlID1cbiAgICBjb3VudCAmJiBjb3VudCA+IDBcbiAgICAgID8gYCR7Y291bnR9IGluc3RhbGxlZCB0d2VhayR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGNhbiBiZSB1cGRhdGVkYFxuICAgICAgOiBcIkluc3RhbGxlZCB0d2Vha3MgYXJlIHVwIHRvIGRhdGVcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2U6IEhUTUxFbGVtZW50LCBjb3VudDogbnVtYmVyIHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCBoYXNVcGRhdGVzID0gISFjb3VudCAmJiBjb3VudCA+IDA7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiLCBoYXNVcGRhdGVzKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcInRleHQtd2hpdGVcIiwgaGFzVXBkYXRlcyk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10cmFuc3BhcmVudFwiLCAhaGFzVXBkYXRlcyk7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBtaW5XaWR0aDogXCIyNHB4XCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgN3B4XCIsXG4gICAgZm9udFNpemU6IFwiMTJweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjdXJyZW50U3RvcmVVcGRhdGVCYWRnZUNvdW50KCk6IG51bWJlciB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGNvbnN0IHJhdyA9IGJhZGdlPy5kYXRhc2V0LnR3ZWFrZXJTdG9yZVVwZGF0ZUNvdW50O1xuICBjb25zdCBwYXJzZWQgPSByYXcgPyBOdW1iZXIocmF3KSA6IDA7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IDA7XG59XG5cbmZ1bmN0aW9uIG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlWaWV3W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiAhIWVudHJ5Lmluc3RhbGxlZCAmJiBlbnRyeS5pbnN0YWxsZWQudmVyc2lvbiAhPT0gZW50cnkubWFuaWZlc3QudmVyc2lvbikubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBzdG9yZVRvb2xiYXJCdXR0b24oXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4gIHZhcmlhbnQ6IFwicHJpbWFyeVwiIHwgXCJzZWNvbmRhcnlcIiA9IFwic2Vjb25kYXJ5XCIsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgdmFyaWFudCA9PT0gXCJwcmltYXJ5XCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tYmctZm9nIHB4LTIgcHktMCB0ZXh0LXNtIHRleHQtdG9rZW4tYnV0dG9uLXRlcnRpYXJ5LWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCBpdGVtcy1jZW50ZXIgZ2FwLTEgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRyYW5zcGFyZW50IGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAgdGV4dC1zbSB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uQnV0dG9uKFxuICBpY29uU3ZnOiBzdHJpbmcsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggdy04IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdHJhbnNwYXJlbnQgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMCB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi5pbm5lckhUTUwgPSBpY29uU3ZnO1xuICBjb25zdHJhaW5TaWRlYmFySWNvblN2ZyhidG4ucXVlcnlTZWxlY3RvcihcInN2Z1wiKSwgMTgpO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi50aXRsZSA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaEljb25TdmcoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjE4XCIgaGVpZ2h0PVwiMThcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cImljb24teHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk00LjQgOS4zNUE1LjY1IDUuNjUgMCAwIDEgMTQgNS4zTDE1Ljc1IDdNMTUuNzUgMy43NVY3aC0zLjI1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjYgMTAuNjVBNS42NSA1LjY1IDAgMCAxIDYgMTQuN0w0LjI1IDEzTTQuMjUgMTYuMjVWMTNINy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUJhZGdlKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IGgtNiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzMwIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC14cyBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgYmFkZ2UuaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjEzXCIgaGVpZ2h0PVwiMTNcIiB2aWV3Qm94PVwiMCAwIDE0IDE0XCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cInRleHQtYmx1ZS01MDBcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk03IDEuNzUgMTEuMjUgMy40djMuMmMwIDIuNi0xLjY1IDQuMjUtNC4yNSA1LjQtMi42LTEuMTUtNC4yNS0yLjgtNC4yNS01LjRWMy40TDcgMS43NVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjE1XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNC44NSA3LjA1IDYuMyA4LjQ1bDIuODUtMy4wNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuMjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmAgK1xuICAgIGA8c3Bhbj5WZXJpZmllZCBhcyBzYWZlPC9zcGFuPmA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeTogVHdlYWtTdG9yZUVudHJ5VmlldywgaW5zdGFsbGVkT3ZlcnJpZGU/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGluc3RhbGxlZE92ZXJyaWRlID8/IGVudHJ5Lmluc3RhbGxlZD8udmVyc2lvbiA/PyBudWxsO1xuICBjb25zdCBsYXRlc3QgPSBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uO1xuICBjb25zdCBoYXNVcGRhdGUgPSAhIWluc3RhbGxlZCAmJiBpbnN0YWxsZWQgIT09IGxhdGVzdDtcbiAgY29uc3QgYmFkZ2UgPSBzdG9yZVZlcnNpb25CYWRnZVNoZWxsKGhhc1VwZGF0ZSk7XG4gIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGxhYmVsLmNsYXNzTmFtZSA9IFwidHJ1bmNhdGVcIjtcbiAgbGFiZWwudGV4dENvbnRlbnQgPSBpbnN0YWxsZWRcbiAgICA/IGBJbnN0YWxsZWQgdiR7aW5zdGFsbGVkfSBcdTAwQjcgTGF0ZXN0IHYke2xhdGVzdH1gXG4gICAgOiBgTGF0ZXN0IHYke2xhdGVzdH1gO1xuICBiYWRnZS50aXRsZSA9IGluc3RhbGxlZFxuICAgID8gYEluc3RhbGxlZCB2ZXJzaW9uICR7aW5zdGFsbGVkfS4gTGF0ZXN0IGFwcHJvdmVkIHZlcnNpb24gJHtsYXRlc3R9LmBcbiAgICA6IGBMYXRlc3QgYXBwcm92ZWQgdmVyc2lvbiAke2xhdGVzdH0uYDtcbiAgYmFkZ2UuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoaGFzVXBkYXRlOiBib29sZWFuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggbWluLXctMCBtYXgtdy1mdWxsIGl0ZW1zLWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBweC0yLjUgdGV4dC14cyBmb250LW1lZGl1bVwiLFxuICAgIGhhc1VwZGF0ZVxuICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLWZvcmVncm91bmRcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIvNDAgYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzUGlsbChsYWJlbDogc3RyaW5nLCB0b25lOiBcIm5ldXRyYWxcIiB8IFwiaW5mb1wiID0gXCJuZXV0cmFsXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgcGlsbC5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgcHgtMyB0ZXh0LXNtIGZvbnQtbWVkaXVtXCIsXG4gICAgdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgID8gXCJib3JkZXIgYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICA6IFwiYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICBwaWxsLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIHJldHVybiBwaWxsO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoKTtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKGJ0bik7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b25DbGFzcyhleHRyYSA9IFwiXCIpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IG1pbi13LVs4MnB4XSBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgZ2FwLTEuNSB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItYmx1ZS01MDAvNDAgYmctYmx1ZS01MDAgcHgtMyBweS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi1mb3JlZ3JvdW5kIHNoYWRvdy1zbSB0cmFuc2l0aW9uLWNvbG9ycyBlbmFibGVkOmhvdmVyOmJnLWJsdWUtNjAwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTgwXCIsXG4gICAgZXh0cmEsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIiwgXCJ0cnVlXCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyBjbGFzcz1cImFuaW1hdGUtc3BpblwiIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiOFwiIGN5PVwiOFwiIHI9XCI1LjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIyXCIgb3BhY2l0eT1cIi4yNVwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xMy41IDhBNS41IDUuNSAwIDAgMCA4IDIuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+JHtsYWJlbH08L3NwYW4+YDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlQnV0dG9uSW5zdGFsbGVkKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKFwiYm9yZGVyLWJsdWUtNTAwIGJnLWJsdWUtNTAwXCIpO1xuICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE0XCIgaGVpZ2h0PVwiMTRcIiB2aWV3Qm94PVwiMCAwIDE2IDE2XCIgZmlsbD1cIm5vbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zLjc1IDguMTUgNi42NSAxMSAxMi4yNSA1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS44XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+SW5zdGFsbGVkPC9zcGFuPmA7XG59XG5cbmZ1bmN0aW9uIHJlc2V0U3RvcmVJbnN0YWxsQnV0dG9uKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24udGV4dENvbnRlbnQgPSBsYWJlbDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlVG9hc3QobWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGxldCBob3N0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXRvYXN0LWhvc3RdXCIpO1xuICBpZiAoIWhvc3QpIHtcbiAgICBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBob3N0LmRhdGFzZXQudHdlYWtlclN0b3JlVG9hc3RIb3N0ID0gXCJ0cnVlXCI7XG4gICAgaG9zdC5jbGFzc05hbWUgPSBcInBvaW50ZXItZXZlbnRzLW5vbmUgZml4ZWQgYm90dG9tLTUgcmlnaHQtNSB6LVs5OTk5XSBmbGV4IGZsZXgtY29sIGl0ZW1zLWVuZCBnYXAtMlwiO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gIH1cbiAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b2FzdC5jbGFzc05hbWUgPVxuICAgIFwidHJhbnNsYXRlLXktMiByb3VuZGVkLXhsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzUwIGJnLXRva2VuLW1haW4tc3VyZmFjZS1wcmltYXJ5IHB4LTMgcHktMiB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBvcGFjaXR5LTAgc2hhZG93LWxnIHRyYW5zaXRpb24tYWxsIGR1cmF0aW9uLTIwMFwiO1xuICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gIGhvc3QuYXBwZW5kQ2hpbGQodG9hc3QpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoXCJ0cmFuc2xhdGUteS0yXCIsIFwib3BhY2l0eS0wXCIpO1xuICB9KTtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgdG9hc3QuY2xhc3NMaXN0LmFkZChcInRyYW5zbGF0ZS15LTJcIiwgXCJvcGFjaXR5LTBcIik7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0b2FzdC5yZW1vdmUoKTtcbiAgICAgIGlmIChob3N0ICYmIGhvc3QuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIGhvc3QucmVtb3ZlKCk7XG4gICAgfSwgMjIwKTtcbiAgfSwgMjYwMCk7XG59XG5cbmZ1bmN0aW9uIHN0b3JlTWVzc2FnZUNhcmQodGl0bGU6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyLzQwIGZsZXggbWluLWgtWzg0cHhdIGZsZXgtY29sIGp1c3RpZnktY2VudGVyIGdhcC0xIHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdGV4dC1zbVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcImZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgY2FyZC5hcHBlbmRDaGlsZCh0KTtcbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gICAgY2FyZC5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc2hvcnRTaGEodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5zbGljZSgwLCA3KTtcbn1cblxudHlwZSBBY3Rpb25NZW51SXRlbSA9IHsgbGFiZWw6IHN0cmluZzsgb25TZWxlY3Q6ICgpID0+IHZvaWQgfTtcblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb25zQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb25bXT4oKTtcbiAgZm9yIChjb25zdCBzZWN0aW9uIG9mIHN0YXRlLnNlY3Rpb25zLnZhbHVlcygpKSB7XG4gICAgY29uc3QgdHdlYWtJZCA9IHNlY3Rpb24uaWQuc3BsaXQoXCI6XCIpWzBdO1xuICAgIGlmICghc2VjdGlvbnNCeVR3ZWFrLmhhcyh0d2Vha0lkKSkgc2VjdGlvbnNCeVR3ZWFrLnNldCh0d2Vha0lkLCBbXSk7XG4gICAgc2VjdGlvbnNCeVR3ZWFrLmdldCh0d2Vha0lkKSEucHVzaChzZWN0aW9uKTtcbiAgfVxuXG4gIGNvbnN0IHBhZ2VzQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkUGFnZVtdPigpO1xuICBmb3IgKGNvbnN0IHBhZ2Ugb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICBpZiAoIXBhZ2VzQnlUd2Vhay5oYXMocGFnZS50d2Vha0lkKSkgcGFnZXNCeVR3ZWFrLnNldChwYWdlLnR3ZWFrSWQsIFtdKTtcbiAgICBwYWdlc0J5VHdlYWsuZ2V0KHBhZ2UudHdlYWtJZCkhLnB1c2gocGFnZSk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3cmFwKTtcblxuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhci5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgd3JhcC5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCB0YWJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwidGFibGlzdFwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiRmlsdGVyIHR3ZWFrc1wiKTtcbiAgdGFicy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0YWJzKTtcblxuICBjb25zdCB0b29sYmFyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXJBY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0b29sYmFyQWN0aW9ucyk7XG5cbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VhcmNoLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHctNTYgbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTIgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWlucHV0LWJvcmRlciBiZy10b2tlbi1pbnB1dC1iYWNrZ3JvdW5kLzc1IHB4LTIuNSB0ZXh0LWJhc2Ugc2hhZG93LXNtXCI7XG4gIHNlYXJjaC5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwiaWNvbi1zbSBzaHJpbmstMCB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI5XCIgY3k9XCI5XCIgcj1cIjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJtMTMgMTMgMy41IDMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IHNlYXJjaExhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxhYmVsXCIpO1xuICBzZWFyY2hMYWJlbC5jbGFzc05hbWUgPSBcInNyLW9ubHlcIjtcbiAgc2VhcmNoTGFiZWwuaHRtbEZvciA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaExhYmVsLnRleHRDb250ZW50ID0gXCJTZWFyY2ggdHdlYWtzXCI7XG4gIGNvbnN0IHNlYXJjaElucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2hJbnB1dC5pZCA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaElucHV0LnR5cGUgPSBcInNlYXJjaFwiO1xuICBzZWFyY2hJbnB1dC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIHR3ZWFrc1wiO1xuICBzZWFyY2hJbnB1dC52YWx1ZSA9IHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeTtcbiAgc2VhcmNoSW5wdXQuY2xhc3NOYW1lID1cbiAgICBcIm1pbi13LTAgZmxleC0xIGJnLXRyYW5zcGFyZW50IHRleHQtYmFzZSB0ZXh0LXRva2VuLWlucHV0LWZvcmVncm91bmQgb3V0bGluZS1ub25lIHBsYWNlaG9sZGVyOnRleHQtdG9rZW4taW5wdXQtcGxhY2Vob2xkZXItZm9yZWdyb3VuZFwiO1xuICBjb25zdCBjbGVhclNlYXJjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNsZWFyU2VhcmNoLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjbGVhclNlYXJjaC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2xlYXIgc2VhcmNoXCIpO1xuICBjbGVhclNlYXJjaC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgY3Vyc29yLWludGVyYWN0aW9uIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGNsZWFyU2VhcmNoLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNlwiIGhlaWdodD1cIjE2XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJtNiA2IDggOE0xNCA2bC04IDhcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBjbGVhclNlYXJjaC5oaWRkZW4gPSBzdGF0ZS50d2Vha3NQYWdlUXVlcnkubGVuZ3RoID09PSAwO1xuICBzZWFyY2guYXBwZW5kKHNlYXJjaExhYmVsLCBzZWFyY2hJbnB1dCwgY2xlYXJTZWFyY2gpO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChzZWFyY2gpO1xuXG4gIGNvbnN0IGdsb2JhbE1lbnUgPSBhY3Rpb25NZW51QnV0dG9uKFwiTW9yZSB0d2VhayBhY3Rpb25zXCIsIFtcbiAgICB7XG4gICAgICBsYWJlbDogXCJGb3JjZSBSZWxvYWRcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZm9yY2UgcmVsb2FkIChtYWluKSBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbGFiZWw6IFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gIF0pO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChnbG9iYWxNZW51LmVsZW1lbnQpO1xuXG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmlkID0gXCJ0d2Vha2VyLXR3ZWFrcy1saXN0XCI7XG4gIGxpc3Quc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInRhYnBhbmVsXCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3cmFwLmFwcGVuZENoaWxkKGxpc3QpO1xuXG4gIGxldCByb3dDbGVhbnVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcbiAgY29uc3QgcmVuZGVyTGlzdCA9ICgpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGNsZWFudXAgb2Ygcm93Q2xlYW51cHMpIGNsZWFudXAoKTtcbiAgICByb3dDbGVhbnVwcyA9IFtdO1xuXG4gICAgY29uc3QgY291bnRzID0gdHdlYWtzUGFnZUNvdW50cyhzdGF0ZS5saXN0ZWRUd2Vha3MpO1xuICAgIHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZm9yIChjb25zdCBmaWx0ZXIgb2YgVFdFQUtTX1BBR0VfRklMVEVSUykge1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyID09PSBmaWx0ZXI7XG4gICAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYnV0dG9uLmlkID0gYHR3ZWFrZXItdHdlYWtzLWZpbHRlci0ke2ZpbHRlcn1gO1xuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJ0YWJcIik7XG4gICAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1jb250cm9sc1wiLCBsaXN0LmlkKTtcbiAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhzZWxlY3RlZCkpO1xuICAgICAgYnV0dG9uLmNsYXNzTmFtZSA9IFtcbiAgICAgICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xLjUgcm91bmRlZC1sZyBweC0yLjUgdGV4dC1zbSBjdXJzb3ItaW50ZXJhY3Rpb25cIixcbiAgICAgICAgc2VsZWN0ZWRcbiAgICAgICAgICA/IFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICAgICAgOiBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGhvdmVyOnRleHQtdG9rZW4tZm9yZWdyb3VuZFwiLFxuICAgICAgXS5qb2luKFwiIFwiKTtcbiAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBsYWJlbC50ZXh0Q29udGVudCA9IHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXIpO1xuICAgICAgY29uc3QgY291bnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGNvdW50LmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1pbnB1dC1wbGFjZWhvbGRlci1mb3JlZ3JvdW5kIHRhYnVsYXItbnVtc1wiO1xuICAgICAgY291bnQudGV4dENvbnRlbnQgPSBTdHJpbmcoY291bnRzW2ZpbHRlcl0pO1xuICAgICAgYnV0dG9uLmFwcGVuZChsYWJlbCwgY291bnQpO1xuICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAgIHN0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXIgPSBmaWx0ZXI7XG4gICAgICAgIHJlbmRlckxpc3QoKTtcbiAgICAgIH0pO1xuICAgICAgdGFicy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBsaXN0LnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxsZWRieVwiLCBgdHdlYWtlci10d2Vha3MtZmlsdGVyLSR7c3RhdGUudHdlYWtzUGFnZUZpbHRlcn1gKTtcblxuICAgIGNvbnN0IHZpc2libGUgPSBmaWx0ZXJUd2Vha3NQYWdlSXRlbXMoXG4gICAgICBzdGF0ZS5saXN0ZWRUd2Vha3MsXG4gICAgICBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyLFxuICAgICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5LFxuICAgICk7XG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBpZiAodmlzaWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGVtcHR5LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4taC0yOCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcHktOCB0ZXh0LWNlbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMFxuICAgICAgICA/IGBObyBjYXRhbG9nIGVudHJpZXMgYXZhaWxhYmxlLiBEcm9wIGEgdHdlYWsgZm9sZGVyIGludG8gJHt0d2Vha3NQYXRoKCl9IGFuZCByZWxvYWQuYFxuICAgICAgICA6IFwiTm8gdHdlYWtzIG1hdGNoIHRoaXMgc2VhcmNoIGFuZCBmaWx0ZXIuXCI7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHR3ZWFrIG9mIHZpc2libGUpIHtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQodHdlYWtSb3coXG4gICAgICAgIHR3ZWFrLFxuICAgICAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrLm1hbmlmZXN0LmlkKSA/PyBbXSxcbiAgICAgICAgcGFnZXNCeVR3ZWFrLmdldCh0d2Vhay5tYW5pZmVzdC5pZCkgPz8gW10sXG4gICAgICAgIChjbGVhbnVwKSA9PiByb3dDbGVhbnVwcy5wdXNoKGNsZWFudXApLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIHNlYXJjaElucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gc2VhcmNoSW5wdXQudmFsdWU7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gc2VhcmNoSW5wdXQudmFsdWUubGVuZ3RoID09PSAwO1xuICAgIHJlbmRlckxpc3QoKTtcbiAgfSk7XG4gIGNsZWFyU2VhcmNoLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gXCJcIjtcbiAgICBzZWFyY2hJbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gdHJ1ZTtcbiAgICByZW5kZXJMaXN0KCk7XG4gICAgc2VhcmNoSW5wdXQuZm9jdXMoKTtcbiAgfSk7XG5cbiAgcmVuZGVyTGlzdCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGdsb2JhbE1lbnUuZGlzcG9zZSgpO1xuICAgIGZvciAoY29uc3QgY2xlYW51cCBvZiByb3dDbGVhbnVwcykgY2xlYW51cCgpO1xuICAgIHJvd0NsZWFudXBzID0gW107XG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIpOiBzdHJpbmcge1xuICBpZiAoZmlsdGVyID09PSBcImFsbFwiKSByZXR1cm4gXCJBbGxcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJlbmFibGVkXCIpIHJldHVybiBcIkVuYWJsZWRcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gXCJEaXNhYmxlZFwiO1xuICByZXR1cm4gXCJVcGRhdGVzXCI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrUm93KFxuICB0d2VhazogTGlzdGVkVHdlYWssXG4gIHNlY3Rpb25zOiBTZXR0aW5nc1NlY3Rpb25bXSxcbiAgcGFnZXM6IFJlZ2lzdGVyZWRQYWdlW10sXG4gIHJlZ2lzdGVyQ2xlYW51cDogKGNsZWFudXA6ICgpID0+IHZvaWQpID0+IHZvaWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG1hbmlmZXN0ID0gdHdlYWsubWFuaWZlc3Q7XG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFtcbiAgICBcImdyb3VwIGZsZXggZmxleC1jb2wgb3ZlcmZsb3ctdmlzaWJsZSByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzQwIGJnLXRva2VuLWZvcmVncm91bmQvNSB0cmFuc2l0aW9uLWNvbG9ycyBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIixcbiAgICAhdHdlYWsuaW5zdGFsbGVkIHx8IHR3ZWFrLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiID8gXCJvcGFjaXR5LTYwXCIgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi1oLVs2NHB4XSBpdGVtcy1jZW50ZXIgZ2FwLTMgcC0yLjVcIjtcbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IGNhbkNvbmZpZ3VyZSA9IHR3ZWFrLmluc3RhbGxlZCAmJiB0d2Vhay5lbmFibGVkICYmIHBhZ2VzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGNhbkNvbmZpZ3VyZSA/IFwiYnV0dG9uXCIgOiBcImRpdlwiKTtcbiAgY29udGVudC5jbGFzc05hbWUgPSBbXG4gICAgXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMyB0ZXh0LWxlZnRcIixcbiAgICBjYW5Db25maWd1cmVcbiAgICAgID8gXCJjdXJzb3ItaW50ZXJhY3Rpb24gcm91bmRlZC1sZyBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCJcbiAgICAgIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG4gIGlmIChjb250ZW50IGluc3RhbmNlb2YgSFRNTEJ1dHRvbkVsZW1lbnQpIHtcbiAgICBjb250ZW50LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvbnRlbnQudGl0bGUgPSBwYWdlcy5sZW5ndGggPT09IDFcbiAgICAgID8gYE9wZW4gJHtwYWdlc1swXSEucGFnZS50aXRsZX1gXG4gICAgICA6IGBPcGVuICR7cGFnZXMubWFwKChwYWdlKSA9PiBwYWdlLnBhZ2UudGl0bGUpLmpvaW4oXCIsIFwiKX1gO1xuICAgIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogbWFuaWZlc3QuaWQgfSk7XG4gICAgfSk7XG4gIH1cbiAgY29udGVudC5hcHBlbmRDaGlsZCh0d2Vha0F2YXRhcih0d2VhaykpO1xuXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0wLjVcIjtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hbWUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRydW5jYXRlIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgbmFtZS50ZXh0Q29udGVudCA9IG1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKG5hbWUpO1xuICBjb25zdCB2ZXJzaW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHZlcnNpb24uY2xhc3NOYW1lID0gXCJzaHJpbmstMCB0ZXh0LXhzIGZvbnQtbm9ybWFsIHRhYnVsYXItbnVtcyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHZlcnNpb24udGV4dENvbnRlbnQgPSBgdiR7bWFuaWZlc3QudmVyc2lvbn1gO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJzaW9uKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodHdlYWtTdGF0dXNQaWxsKHR3ZWFrKSk7XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSkge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHVwZGF0ZS5jbGFzc05hbWUgPVxuICAgICAgXCJzaHJpbmstMCByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHVwZGF0ZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gIH1cbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuICBpZiAobWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGVzY3JpcHRpb24uY2xhc3NOYW1lID0gXCJsaW5lLWNsYW1wLTEgbWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkZXNjcmlwdGlvbi50ZXh0Q29udGVudCA9IG1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2NyaXB0aW9uKTtcbiAgfVxuICBjb250ZW50LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGNvbnRlbnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgYXV0aG9yID0gdHdlYWtBdXRob3JOYW1lKG1hbmlmZXN0LmF1dGhvcik7XG4gIGlmIChhdXRob3IpIHtcbiAgICBjb25zdCBhdXRob3JMYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYXV0aG9yTGFiZWwuY2xhc3NOYW1lID0gXCJoaWRkZW4gdy0yOCB0cnVuY2F0ZSB0ZXh0LXJpZ2h0IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtZDpibG9ja1wiO1xuICAgIGF1dGhvckxhYmVsLnRleHRDb250ZW50ID0gYXV0aG9yO1xuICAgIGF1dGhvckxhYmVsLnRpdGxlID0gYXV0aG9yO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYXV0aG9yTGFiZWwpO1xuICB9XG5cbiAgY29uc3Qgcm93TWVudUl0ZW1zOiBBY3Rpb25NZW51SXRlbVtdID0gW107XG4gIGlmIChjYW5Db25maWd1cmUpIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJDb25maWd1cmVcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IG1hbmlmZXN0LmlkIH0pLFxuICAgIH0pO1xuICB9XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0d2Vhay51cGRhdGUucmVsZWFzZVVybCkge1xuICAgIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIlJldmlldyBSZWxlYXNlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCB0d2Vhay51cGRhdGUhLnJlbGVhc2VVcmwpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgbGFiZWw6IFwiT3BlbiBSZXBvc2l0b3J5XCIsXG4gICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApO1xuICAgIH0sXG4gIH0pO1xuICBpZiAobWFuaWZlc3QuaG9tZXBhZ2UgJiYgbWFuaWZlc3QuaG9tZXBhZ2UgIT09IGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJPcGVuIEhvbWVwYWdlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBtYW5pZmVzdC5ob21lcGFnZSk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IHJvd01lbnUgPSBhY3Rpb25NZW51QnV0dG9uKGBNb3JlIGFjdGlvbnMgZm9yICR7bWFuaWZlc3QubmFtZX1gLCByb3dNZW51SXRlbXMpO1xuICByb3dNZW51LmVsZW1lbnQuY2xhc3NMaXN0LmFkZChcbiAgICBcImludmlzaWJsZVwiLFxuICAgIFwib3BhY2l0eS0wXCIsXG4gICAgXCJncm91cC1mb2N1cy13aXRoaW46dmlzaWJsZVwiLFxuICAgIFwiZ3JvdXAtZm9jdXMtd2l0aGluOm9wYWNpdHktMTAwXCIsXG4gICAgXCJncm91cC1ob3Zlcjp2aXNpYmxlXCIsXG4gICAgXCJncm91cC1ob3ZlcjpvcGFjaXR5LTEwMFwiLFxuICApO1xuICByZWdpc3RlckNsZWFudXAocm93TWVudS5kaXNwb3NlKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyb3dNZW51LmVsZW1lbnQpO1xuXG4gIGlmICghdHdlYWsuaW5zdGFsbGVkKSB7XG4gICAgaWYgKHR3ZWFrLmNhdGFsb2c/LmF2YWlsYWJsZSA9PT0gZmFsc2UpIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiTm90IGluc3RhbGxlZFwiKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIkluc3RhbGxcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBtYW5pZmVzdC5pZClcbiAgICAgICAgICAudGhlbigoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSlcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjYXRhbG9nIGluc3RhbGwgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgfSBlbHNlIGlmICh0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJlY292ZXJcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlY292ZXItdHdlYWtcIiwgbWFuaWZlc3QuaWQpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInR3ZWFrIHJlY292ZXJ5IGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikge1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmV0cnlcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2xlYXItdHdlYWstaGVhbHRoXCIsIG1hbmlmZXN0LmlkKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNsZWFyIHR3ZWFrIGhlYWx0aCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwidHdlYWsgcmV0cnkgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0b2dnbGUgPSBzd2l0Y2hDb250cm9sKHR3ZWFrLmVuYWJsZWQsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnNldC10d2Vhay1lbmFibGVkXCIsIG1hbmlmZXN0LmlkLCBuZXh0KTtcbiAgICB9KTtcbiAgICB0b2dnbGUuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBgJHt0d2Vhay5lbmFibGVkID8gXCJEaXNhYmxlXCIgOiBcIkVuYWJsZVwifSAke21hbmlmZXN0Lm5hbWV9YCk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZCh0b2dnbGUpO1xuICB9XG4gIGhlYWRlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAvLyBQcmVzZXJ2ZSB0aGUgbGVnYWN5IFNldHRpbmdzU2VjdGlvbiBjb250cmFjdDogcmVnaXN0ZXJlZCBzZWN0aW9ucyBzdGlsbFxuICAvLyByZW5kZXIgZGlyZWN0bHkgYmVuZWF0aCB0aGVpciBvd25pbmcgdHdlYWsgcm93LlxuICBpZiAodHdlYWsuaW5zdGFsbGVkICYmIHR3ZWFrLmVuYWJsZWQgJiYgc2VjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5lc3RlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbmVzdGVkLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIGJvcmRlci10LVswLjVweF0gYm9yZGVyLXRva2VuLWJvcmRlclwiO1xuICAgIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gICAgICB0cnkge1xuICAgICAgICBzZWN0aW9uLnJlbmRlcihib2R5KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYm9keS5jbGFzc05hbWUgPSBcInAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiB0d2Vha0F2YXRhcih0d2VhazogTGlzdGVkVHdlYWspOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC0xMCB3LTEwIHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci1kZWZhdWx0IGJnLXRyYW5zcGFyZW50IHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgY29uc3QgaW5pdGlhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBpbml0aWFsLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtXCI7XG4gIGluaXRpYWwudGV4dENvbnRlbnQgPSAodHdlYWsubWFuaWZlc3QubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW5pdGlhbCk7XG4gIGlmICghdHdlYWsubWFuaWZlc3QuaWNvblVybCkgcmV0dXJuIGF2YXRhcjtcblxuICBjb25zdCBpbWFnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gIGltYWdlLmFsdCA9IFwiXCI7XG4gIGltYWdlLmNsYXNzTmFtZSA9IFwiaC1mdWxsIHctZnVsbCBvYmplY3QtY29udGFpblwiO1xuICBpbWFnZS5oaWRkZW4gPSB0cnVlO1xuICBpbWFnZS5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCAoKSA9PiB7XG4gICAgaW5pdGlhbC5yZW1vdmUoKTtcbiAgICBpbWFnZS5oaWRkZW4gPSBmYWxzZTtcbiAgfSk7XG4gIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiBpbWFnZS5yZW1vdmUoKSk7XG4gIHZvaWQgcmVzb2x2ZUljb25VcmwodHdlYWsubWFuaWZlc3QuaWNvblVybCwgdHdlYWsuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICBpZiAodXJsKSBpbWFnZS5zcmMgPSB1cmw7XG4gICAgZWxzZSBpbWFnZS5yZW1vdmUoKTtcbiAgfSk7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChpbWFnZSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrQXV0aG9yTmFtZShhdXRob3I6IFR3ZWFrTWFuaWZlc3RbXCJhdXRob3JcIl0pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICByZXR1cm4gdHlwZW9mIGF1dGhvciA9PT0gXCJzdHJpbmdcIiA/IGF1dGhvciA6IGF1dGhvci5uYW1lO1xufVxuXG5mdW5jdGlvbiBhY3Rpb25NZW51QnV0dG9uKFxuICBsYWJlbDogc3RyaW5nLFxuICBpdGVtczogQWN0aW9uTWVudUl0ZW1bXSxcbik6IHsgZWxlbWVudDogSFRNTEVsZW1lbnQ7IGRpc3Bvc2U6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5jbGFzc05hbWUgPSBcInJlbGF0aXZlIHNocmluay0wXCI7XG4gIGNvbnN0IHN1bW1hcnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3VtbWFyeVwiKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhhc3BvcHVwXCIsIFwibWVudVwiKTtcbiAgc3VtbWFyeS5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTggdy04IGxpc3Qtbm9uZSBjdXJzb3ItaW50ZXJhY3Rpb24gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbGcgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgc3VtbWFyeS5zdHlsZS5saXN0U3R5bGUgPSBcIm5vbmVcIjtcbiAgc3VtbWFyeS5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI0XCIgY3k9XCIxMFwiIHI9XCIxLjI1XCIvPjxjaXJjbGUgY3g9XCIxMFwiIGN5PVwiMTBcIiByPVwiMS4yNVwiLz48Y2lyY2xlIGN4PVwiMTZcIiBjeT1cIjEwXCIgcj1cIjEuMjVcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IG1lbnUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZW51LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJtZW51XCIpO1xuICBtZW51LmNsYXNzTmFtZSA9XG4gICAgXCJhYnNvbHV0ZSByaWdodC0wIHRvcC1mdWxsIHotNTAgbXQtMSBmbGV4IG1pbi13LTQ0IGZsZXgtY29sIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tbWFpbi1zdXJmYWNlLXByaW1hcnkgcC0xIHNoYWRvdy1sZ1wiO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcIm1lbnVpdGVtXCIpO1xuICAgIGJ1dHRvbi5jbGFzc05hbWUgPVxuICAgICAgXCJmbGV4IGgtOCB3LWZ1bGwgaXRlbXMtY2VudGVyIHJvdW5kZWQtbWQgcHgtMiB0ZXh0LWxlZnQgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBpdGVtLmxhYmVsO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGV2ZW50KSA9PiB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBkZXRhaWxzLm9wZW4gPSBmYWxzZTtcbiAgICAgIGl0ZW0ub25TZWxlY3QoKTtcbiAgICB9KTtcbiAgICBtZW51LmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gIH1cbiAgZGV0YWlscy5hcHBlbmQoc3VtbWFyeSwgbWVudSk7XG5cbiAgbGV0IGxpc3RlbmluZyA9IGZhbHNlO1xuICBjb25zdCBkZXRhY2ggPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHJldHVybjtcbiAgICBsaXN0ZW5pbmcgPSBmYWxzZTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgfTtcbiAgY29uc3QgY2xvc2UgPSAoKTogdm9pZCA9PiB7XG4gICAgZGV0YWlscy5vcGVuID0gZmFsc2U7XG4gICAgZGV0YWNoKCk7XG4gIH07XG4gIGNvbnN0IG9uUG9pbnRlckRvd24gPSAoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmICghZGV0YWlscy5pc0Nvbm5lY3RlZCB8fCAhKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIE5vZGUpIHx8ICFkZXRhaWxzLmNvbnRhaW5zKGV2ZW50LnRhcmdldCkpIGNsb3NlKCk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgIT09IFwiRXNjYXBlXCIpIHJldHVybjtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNsb3NlKCk7XG4gICAgc3VtbWFyeS5mb2N1cygpO1xuICB9O1xuICBkZXRhaWxzLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4ge1xuICAgIGlmICghZGV0YWlscy5vcGVuKSB7XG4gICAgICBkZXRhY2goKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHtcbiAgICAgIGxpc3RlbmluZyA9IHRydWU7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICAgIH1cbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IG1lbnUucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIik/LmZvY3VzKCkpO1xuICB9KTtcblxuICByZXR1cm4geyBlbGVtZW50OiBkZXRhaWxzLCBkaXNwb3NlOiBjbG9zZSB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0YXR1c1BpbGwodHdlYWs6IExpc3RlZFR3ZWFrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBsYWJlbHM6IFJlY29yZDxUd2Vha1N0YXR1cywgc3RyaW5nPiA9IHtcbiAgICBpbnN0YWxsZWQ6IFwiSW5zdGFsbGVkXCIsXG4gICAgXCJub3QtaW5zdGFsbGVkXCI6IFwiTm90IGluc3RhbGxlZFwiLFxuICAgIGVuYWJsZWQ6IFwiRW5hYmxlZFwiLFxuICAgIGRpc2FibGVkOiBcIkRpc2FibGVkXCIsXG4gICAgZmFpbGVkOiBcIkZhaWxlZFwiLFxuICAgIHF1YXJhbnRpbmVkOiBcIlF1YXJhbnRpbmVkXCIsXG4gIH07XG4gIGNvbnN0IHRvbmUgPSB0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIgfHwgdHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcImVycm9yXCIgOlxuICAgIHR3ZWFrLnN0YXR1cyA9PT0gXCJlbmFibGVkXCIgPyBcImluZm9cIiA6IFwibmV1dHJhbFwiO1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bVwiLFxuICAgIHRvbmUgPT09IFwiZXJyb3JcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkLzMwIGJnLXRva2VuLWNoYXJ0cy1yZWQvMTAgdGV4dC10b2tlbi1jaGFydHMtcmVkXCJcbiAgICAgIDogdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIsXG4gIF0uam9pbihcIiBcIik7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWxzW3R3ZWFrLnN0YXR1c107XG4gIGlmICh0d2Vhay5oZWFsdGg/LmVycm9yKSBiYWRnZS50aXRsZSA9IHR3ZWFrLmhlYWx0aC5lcnJvcjtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBvcGVuUHVibGlzaFR3ZWFrRGlhbG9nKCk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1wdWJsaXNoLWRpYWxvZ11cIik7XG4gIGV4aXN0aW5nPy5yZW1vdmUoKTtcblxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5kYXRhc2V0LnR3ZWFrZXJQdWJsaXNoRGlhbG9nID0gXCJ0cnVlXCI7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJmaXhlZCBpbnNldC0wIHotWzk5OTldIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGJnLWJsYWNrLzQwIHAtNFwiO1xuXG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCB3LWZ1bGwgbWF4LXcteGwgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1tYWluLXN1cmZhY2UtcHJpbWFyeSBwLTQgc2hhZG93LXhsXCI7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICBjb25zdCB0aXRsZVN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVTdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJQdWJsaXNoIFR3ZWFrXCI7XG4gIGNvbnN0IHN1YnRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3VidGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIlN1Ym1pdCBhIEdpdEh1YiByZXBvIGZvciBhZG1pbiByZXZpZXcuIFR3ZWFrZXJzIHJlY29yZHMgdGhlIGV4YWN0IGNvbW1pdCBhZG1pbnMgbXVzdCByZXZpZXcgYW5kIHBpbi5cIjtcbiAgdGl0bGVTdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHRpdGxlU3RhY2suYXBwZW5kQ2hpbGQoc3VidGl0bGUpO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGVTdGFjayk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiRGlzbWlzc1wiLCAoKSA9PiBvdmVybGF5LnJlbW92ZSgpKSk7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IHJlcG9JbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgcmVwb0lucHV0LnR5cGUgPSBcInRleHRcIjtcbiAgcmVwb0lucHV0LnBsYWNlaG9sZGVyID0gXCJvd25lci9yZXBvIG9yIGh0dHBzOi8vZ2l0aHViLmNvbS9vd25lci9yZXBvXCI7XG4gIHJlcG9JbnB1dC5jbGFzc05hbWUgPVxuICAgIFwiaC0xMCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKHJlcG9JbnB1dCk7XG5cbiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJUaGUgbWFuaWZlc3Qgc2hvdWxkIGluY2x1ZGUgYW4gaWNvblVybCBzdWl0YWJsZSBmb3IgdGhlIHN0b3JlLlwiO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGNvbnN0IHN1Ym1pdCA9IGNvbXBhY3RCdXR0b24oXCJPcGVuIFJldmlldyBJc3N1ZVwiLCAoKSA9PiB7XG4gICAgdm9pZCBzdWJtaXRQdWJsaXNoVHdlYWsocmVwb0lucHV0LCBzdGF0dXMpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdWJtaXQpO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgb3ZlcmxheS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIG92ZXJsYXkucmVtb3ZlKCk7XG4gIH0pO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuICByZXBvSW5wdXQuZm9jdXMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0UHVibGlzaFR3ZWFrKFxuICByZXBvSW5wdXQ6IEhUTUxJbnB1dEVsZW1lbnQsXG4gIHN0YXR1czogSFRNTEVsZW1lbnQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJSZXNvbHZpbmcgdGhlIHJlcG8gY29tbWl0IHRvIHJldmlldy5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdWJtaXNzaW9uID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnByZXBhcmUtdHdlYWstc3RvcmUtc3VibWlzc2lvblwiLFxuICAgICAgcmVwb0lucHV0LnZhbHVlLFxuICAgICkgYXMgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uO1xuICAgIGNvbnN0IHVybCA9IGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwoc3VibWlzc2lvbik7XG4gICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCk7XG4gICAgc3RhdHVzLnRleHRDb250ZW50ID0gYEdpdEh1YiByZXZpZXcgaXNzdWUgb3BlbmVkIGZvciAke3N1Ym1pc3Npb24uY29tbWl0U2hhLnNsaWNlKDAsIDcpfS5gO1xuICB9IGNhdGNoIChlKSB7XG4gICAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSA/PyBlKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IHdpZGU/OiBib29sZWFuOyB3aWR0aD86IFwiZGVmYXVsdFwiIHwgXCJwbHVnaW5zXCIgfCBcIndpZGVcIiB9LFxuKToge1xuICBvdXRlcjogSFRNTEVsZW1lbnQ7XG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQ7XG4gIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQ7XG4gIGhlYWRlckFjdGlvbnM6IEhUTUxFbGVtZW50O1xuICBoZWFkZXJUaXRsZUFjdGlvbnM6IEhUTUxFbGVtZW50O1xufSB7XG4gIGNvbnN0IG91dGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3V0ZXIuY2xhc3NOYW1lID0gXCJtYWluLXN1cmZhY2UgZmxleCBoLWZ1bGwgbWluLWgtMCBmbGV4LWNvbFwiO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9XG4gICAgXCJkcmFnZ2FibGUgZmxleCBpdGVtcy1jZW50ZXIgcHgtcGFuZWwgZWxlY3Ryb246aC10b29sYmFyIGV4dGVuc2lvbjpoLXRvb2xiYXItc21cIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3Qgc2Nyb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2Nyb2xsLmNsYXNzTmFtZSA9IFwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLXBhbmVsXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHNjcm9sbCk7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb25zdCB3aWR0aCA9IG9wdGlvbnM/LndpZHRoID8/IChvcHRpb25zPy53aWRlID8gXCJ3aWRlXCIgOiBcImRlZmF1bHRcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9IFtcbiAgICBcIm14LWF1dG8gZmxleCB3LWZ1bGwgZmxleC1jb2wgZWxlY3Ryb246bWluLXctW2NhbGMoMzIwcHgqdmFyKC0tY29kZXgtd2luZG93LXpvb20pKV1cIixcbiAgICB3aWR0aCA9PT0gXCJ3aWRlXCIgPyBcIm1heC13LTV4bFwiIDogd2lkdGggPT09IFwicGx1Z2luc1wiID8gXCJtYXgtdy0zeGxcIiA6IFwibWF4LXctMnhsXCIsXG4gIF0uam9pbihcIiBcIik7XG4gIHNjcm9sbC5hcHBlbmRDaGlsZChpbm5lcik7XG5cbiAgY29uc3QgaGVhZGVyV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcldyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGVySW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTEuNSBwYi1wYW5lbFwiO1xuICBjb25zdCB0aXRsZUxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUxpbmUuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwiZWxlY3Ryb246aGVhZGluZy1sZyBoZWFkaW5nLWJhc2UgdHJ1bmNhdGVcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICB0aXRsZUxpbmUuYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gIGNvbnN0IGhlYWRlclRpdGxlQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlclRpdGxlQWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHRpdGxlTGluZS5hcHBlbmRDaGlsZChoZWFkZXJUaXRsZUFjdGlvbnMpO1xuICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZCh0aXRsZUxpbmUpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgY29uc3QgaGVhZGVyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlckFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlckFjdGlvbnMpO1xuICBpbm5lci5hcHBlbmRDaGlsZChoZWFkZXJXcmFwKTtcblxuICBjb25zdCBzZWN0aW9uc1dyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzZWN0aW9uc1dyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1bdmFyKC0tcGFkZGluZy1wYW5lbCldXCI7XG4gIGlubmVyLmFwcGVuZENoaWxkKHNlY3Rpb25zV3JhcCk7XG5cbiAgcmV0dXJuIHsgb3V0ZXIsIHNlY3Rpb25zV3JhcCwgc3VidGl0bGU6IHN1YnRpdGxlRWxlbWVudCwgaGVhZGVyQWN0aW9ucywgaGVhZGVyVGl0bGVBY3Rpb25zIH07XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25UaXRsZSh0ZXh0OiBzdHJpbmcsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b29sYmFyIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgcHgtMCBweS0wXCI7XG4gIGNvbnN0IHRpdGxlSW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUlubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdGl0bGVJbm5lci5hcHBlbmRDaGlsZCh0KTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGVJbm5lcik7XG4gIGlmICh0cmFpbGluZykge1xuICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHJpZ2h0KTtcbiAgfVxuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbi8qKlxuICogQ29kZXgncyBcIk9wZW4gY29uZmlnLnRvbWxcIi1zdHlsZSB0cmFpbGluZyBidXR0b246IGdob3N0IGJvcmRlciwgbXV0ZWRcbiAqIGxhYmVsLCB0b3AtcmlnaHQgZGlhZ29uYWwgYXJyb3cgaWNvbi4gTWFya3VwIG1pcnJvcnMgQ29uZmlndXJhdGlvbiBwYW5lbC5cbiAqL1xuZnVuY3Rpb24gb3BlbkluUGxhY2VCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBib3JkZXIgd2hpdGVzcGFjZS1ub3dyYXAgZm9jdXM6b3V0bGluZS1ub25lIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIHJvdW5kZWQtbGcgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRhdGEtW3N0YXRlPW9wZW5dOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBib3JkZXItdHJhbnNwYXJlbnQgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcHgtMiBweS0wIHRleHQtYmFzZSBsZWFkaW5nLVsxOHB4XVwiO1xuICBidG4uaW5uZXJIVE1MID1cbiAgICBgJHtsYWJlbH1gICtcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE0LjMzNDkgMTMuMzMwMVY2LjYwNjQ1TDUuNDcwNjUgMTUuNDcwN0M1LjIxMDk1IDE1LjczMDQgNC43ODg5NSAxNS43MzA0IDQuNTI5MjUgMTUuNDcwN0M0LjI2OTU1IDE1LjIxMSA0LjI2OTU1IDE0Ljc4OSA0LjUyOTI1IDE0LjUyOTNMMTMuMzkzNSA1LjY2NTA0SDYuNjYwMTFDNi4yOTI4NCA1LjY2NTA0IDUuOTk1MDcgNS4zNjcyNyA1Ljk5NTA3IDVDNS45OTUwNyA0LjYzMjczIDYuMjkyODQgNC4zMzQ5NiA2LjY2MDExIDQuMzM0OTZIMTQuOTk5OUwxNS4xMzM3IDQuMzQ4NjNDMTUuNDM2OSA0LjQxMDU3IDE1LjY2NSA0LjY3ODU3IDE1LjY2NSA1VjEzLjMzMDFDMTUuNjY0OSAxMy42OTczIDE1LjM2NzIgMTMuOTk1MSAxNC45OTk5IDEzLjk5NTFDMTQuNjMyNyAxMy45OTUxIDE0LjMzNSAxMy42OTczIDE0LjMzNDkgMTMuMzMwMVpcIiBmaWxsPVwiY3VycmVudENvbG9yXCI+PC9wYXRoPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gY29tcGFjdEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcm91bmRlZENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcbiAgICBcInN0eWxlXCIsXG4gICAgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIixcbiAgKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHJvd1NpbXBsZSh0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBpZiAodGl0bGUpIHtcbiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0LmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKHQpO1xuICB9XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByZXR1cm4gcm93O1xufVxuXG4vKipcbiAqIENvZGV4LXN0eWxlZCB0b2dnbGUgc3dpdGNoLiBNYXJrdXAgbWlycm9ycyB0aGUgR2VuZXJhbCA+IFBlcm1pc3Npb25zIHJvd1xuICogc3dpdGNoIHdlIGNhcHR1cmVkOiBvdXRlciBidXR0b24gKHJvbGU9c3dpdGNoKSwgaW5uZXIgcGlsbCwgc2xpZGluZyBrbm9iLlxuICovXG5mdW5jdGlvbiBzd2l0Y2hDb250cm9sKFxuICBpbml0aWFsOiBib29sZWFuLFxuICBvbkNoYW5nZTogKG5leHQ6IGJvb2xlYW4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+LFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3dpdGNoXCIpO1xuXG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3Qga25vYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBrbm9iLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1bY29sb3I6dmFyKC0tZ3JheS0wKV0gYmctW2NvbG9yOnZhcigtLWdyYXktMCldIHNoYWRvdy1zbSB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC00IHctNFwiO1xuICBwaWxsLmFwcGVuZENoaWxkKGtub2IpO1xuXG4gIGNvbnN0IGFwcGx5ID0gKG9uOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiLCBTdHJpbmcob24pKTtcbiAgICBidG4uZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGJ0bi5jbGFzc05hbWUgPVxuICAgICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyIGZvY3VzLXZpc2libGU6cm91bmRlZC1mdWxsIGN1cnNvci1pbnRlcmFjdGlvblwiO1xuICAgIHBpbGwuY2xhc3NOYW1lID0gYHJlbGF0aXZlIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgdHJhbnNpdGlvbi1jb2xvcnMgZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNSB3LTggJHtcbiAgICAgIG9uID8gXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzIwXCJcbiAgICB9YDtcbiAgICBwaWxsLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLnN0eWxlLnRyYW5zZm9ybSA9IG9uID8gXCJ0cmFuc2xhdGVYKDE0cHgpXCIgOiBcInRyYW5zbGF0ZVgoMnB4KVwiO1xuICB9O1xuICBhcHBseShpbml0aWFsKTtcblxuICBidG4uYXBwZW5kQ2hpbGQocGlsbCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBjb25zdCBuZXh0ID0gYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiKSAhPT0gXCJ0cnVlXCI7XG4gICAgYXBwbHkobmV4dCk7XG4gICAgYnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25DaGFuZ2UobmV4dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpY29ucyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY29uZmlnSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTbGlkZXJzIC8gc2V0dGluZ3MgZ2x5cGguIDIweDIwIGN1cnJlbnRDb2xvci5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zIDVoOU0xNSA1aDJNMyAxMGgyTTggMTBoOU0zIDE1aDExTTE3IDE1aDBcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTNcIiBjeT1cIjVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjZcIiBjeT1cIjEwXCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxNVwiIGN5PVwiMTVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha3NJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNwYXJrbGVzIC8gXCIrK1wiIGdseXBoIGZvciB0d2Vha3MuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTAgMi41IEwxMS40IDguNiBMMTcuNSAxMCBMMTEuNCAxMS40IEwxMCAxNy41IEw4LjYgMTEuNCBMMi41IDEwIEw4LjYgOC42IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjUgMyBMMTYgNSBMMTggNS41IEwxNiA2IEwxNS41IDggTDE1IDYgTDEzIDUuNSBMMTUgNSBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIG9wYWNpdHk9XCIwLjdcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uU3ZnKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNCA4LjIgNS4xIDQuNUExLjUgMS41IDAgMCAxIDYuNTUgMy40aDYuOWExLjUgMS41IDAgMCAxIDEuNDUgMS4xTDE2IDguMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQuNSA4aDExdjcuNUExLjUgMS41IDAgMCAxIDE0IDE3SDZhMS41IDEuNSAwIDAgMS0xLjUtMS41VjhaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNy41IDh2MWEyLjUgMi41IDAgMCAwIDUgMFY4XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJhc2lkZSxuYXYsW3JvbGU9J25hdmlnYXRpb24nXSxkaXZcIiksXG4gICk7XG5cbiAgbGV0IGJlc3Q6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBiZXN0U2NvcmUgPSAtMTtcbiAgbGV0IGJlc3RBcmVhID0gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY2FuZGlkYXRlLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShjYW5kaWRhdGUpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxhYmVscyA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oY2FuZGlkYXRlKTtcbiAgICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgICBjb25zdCByZWN0ID0gY2FuZGlkYXRlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIGNvbnN0IGFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XG4gICAgY29uc3Qgd2VpZ2h0ZWQgPSBzY29yZS5jb3JlICogMTAwICsgc2NvcmUudG90YWw7XG5cbiAgICBpZiAod2VpZ2h0ZWQgPiBiZXN0U2NvcmUgfHwgKHdlaWdodGVkID09PSBiZXN0U2NvcmUgJiYgYXJlYSA8IGJlc3RBcmVhKSkge1xuICAgICAgYmVzdCA9IGNhbmRpZGF0ZTtcbiAgICAgIGJlc3RTY29yZSA9IHdlaWdodGVkO1xuICAgICAgYmVzdEFyZWEgPSBhcmVhO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBiZXN0O1xufVxuXG5jb25zdCBGT1JCSURERU5fU0VUVElOR1NfU0lERUJBUl9TRUxFQ1RPUiA9IFtcbiAgXCJbZGF0YS1jb21wb3Nlci1vdmVybGF5LWZsb2F0aW5nLXVpPSd0cnVlJ11cIixcbiAgXCJbZGF0YS10d2Vha2VyLXNsYXNoLW1lbnU9J3RydWUnXVwiLFxuICBcIltkYXRhLXR3ZWFrZXItb3ZlcmxheS1ub2lzZT0ndHJ1ZSddXCIsXG4gIFwiLmNvbXBvc2VyLWhvbWUtdG9wLW1lbnVcIixcbiAgXCIudmVydGljYWwtc2Nyb2xsLWZhZGUtbWFza1wiLFxuICBcIltjbGFzcyo9J1tjb250YWluZXItbmFtZTpob21lLW1haW4tY29udGVudF0nXVwiLFxuXS5qb2luKFwiLFwiKTtcblxuZnVuY3Rpb24gaXNGb3JiaWRkZW5TZXR0aW5nc1NpZGViYXJTdXJmYWNlKG5vZGU6IEVsZW1lbnQgfCBudWxsKTogYm9vbGVhbiB7XG4gIGlmICghbm9kZSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlbCA9IG5vZGUgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IG5vZGUgOiBub2RlLnBhcmVudEVsZW1lbnQ7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGVsLmNsb3Nlc3QoRk9SQklEREVOX1NFVFRJTkdTX1NJREVCQVJfU0VMRUNUT1IpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1saXN0LW5hdmlnYXRpb24taXRlbT0ndHJ1ZSddLCBbY21kay1pdGVtXVwiKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoZWw6IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlY3QgPSB0d2Vha2VyVmlzaWJsZUJveChlbCk7XG4gIGlmICghcmVjdCkgcmV0dXJuIGZhbHNlO1xuXG4gIC8vIEN1cnJlbnQgQ29kZXggU2V0dGluZ3Mgc2lkZWJhcjogbGVmdCBjb2x1bW4sIG5vdCB0aGUgbWFpbiBjb250ZW50IHBhbmVsLlxuICBpZiAocmVjdC53aWR0aCA8IDEyMCB8fCByZWN0LndpZHRoID4gNjIwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChyZWN0LmhlaWdodCA8IDgwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChyZWN0LmxlZnQgPiB3aW5kb3cuaW5uZXJXaWR0aCAqIDAuNjUpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBsYWJlbHMgPSB0d2Vha2VyU2V0dGluZ3NMYWJlbHNGcm9tKGVsKTtcbiAgaWYgKGhhc01haW5BcHBTaWRlYmFyU2lnbmFscyhsYWJlbHMpICYmICFoYXNUd2Vha2VyU2V0dGluZ3NPbmx5U2lnbmFsKGxhYmVscykpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICByZXR1cm4gaXNUd2Vha2VyU2V0dGluZ3NMYWJlbFNldChsYWJlbHMpO1xufVxuXG5mdW5jdGlvbiByZW1vdmVNaXNwbGFjZWRTZXR0aW5nc0dyb3VwcygpOiB2b2lkIHtcbiAgY29uc3QgZ3JvdXBzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJbZGF0YS10d2Vha2VyPSduYXYtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0ncGFnZXMtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0nbmF0aXZlLW5hdi1oZWFkZXInXVwiLFxuICApO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIEFycmF5LmZyb20oZ3JvdXBzKSkge1xuICAgIGlmIChpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cCkpIGNvbnRpbnVlO1xuICAgIHJlc2V0VHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFN0YXRlKGdyb3VwKTtcbiAgICBncm91cC5yZW1vdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cDogSFRNTEVsZW1lbnQpOiBib29sZWFuIHtcbiAgaWYgKGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShncm91cCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBUcnVzdCB0aGUgaW5qZWN0aW9uLXRpbWUgcGxhY2VtZW50IHdoaWxlIHRoYXQgZXhhY3Qgc2lkZWJhciBub2RlIGlzXG4gIC8vIGFsaXZlLiBpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZSBpcyBsYXlvdXQtZGVwZW5kZW50ICh2aXNpYmxlIGJveCksIHNvXG4gIC8vIHJlLWp1ZGdpbmcgbWlkIFJlYWN0IHJlLXJlbmRlciBpbnRlcm1pdHRlbnRseSBmYWlscywgc3RyaXBzIHRoZSBncm91cCxcbiAgLy8gYW5kIHJlLXRyaWdnZXJzIHRoZSBvYnNlcnZlciBcdTIwMTQgYW4gaW5qZWN0L3JlbW92ZSBsb29wIGF0IHJlbmRlciBzcGVlZC5cbiAgaWYgKFxuICAgIHN0YXRlLnNpZGViYXJSb290ICYmXG4gICAgc3RhdGUuc2lkZWJhclJvb3QuaXNDb25uZWN0ZWQgJiZcbiAgICAoZ3JvdXAucGFyZW50RWxlbWVudCA9PT0gc3RhdGUuc2lkZWJhclJvb3QgfHwgc3RhdGUuc2lkZWJhclJvb3QuY29udGFpbnMoZ3JvdXApKVxuICApIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGxldCBub2RlID0gZ3JvdXAucGFyZW50RWxlbWVudDtcbiAgZm9yIChsZXQgZGVwdGggPSAwOyBub2RlICYmIGRlcHRoIDwgNDsgZGVwdGgrKykge1xuICAgIGlmIChpc0ZvcmJpZGRlblNldHRpbmdzU2lkZWJhclN1cmZhY2Uobm9kZSkpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUobm9kZSkpIHJldHVybiB0cnVlO1xuICAgIG5vZGUgPSBub2RlLnBhcmVudEVsZW1lbnQ7XG4gIH1cblxuICByZXR1cm4gZmFsc2U7XG59XG5cbmZ1bmN0aW9uIHJlc2V0VHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFN0YXRlKGdyb3VwOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBpZiAoc3RhdGUubmF2R3JvdXAgPT09IGdyb3VwIHx8IChzdGF0ZS5uYXZHcm91cCAmJiBncm91cC5jb250YWlucyhzdGF0ZS5uYXZHcm91cCkpKSB7XG4gICAgc3RhdGUubmF2R3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLm5hdkJ1dHRvbnMgPSBudWxsO1xuICAgIHN0YXRlLnR3ZWFrZXJVcGRhdGVCdXR0b24gPSBudWxsO1xuICB9XG4gIGlmIChzdGF0ZS5wYWdlc0dyb3VwID09PSBncm91cCB8fCAoc3RhdGUucGFnZXNHcm91cCAmJiBncm91cC5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKSkpIHtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gbnVsbDtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICB9XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPT09IGdyb3VwIHx8IChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgZ3JvdXAuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkpIHtcbiAgICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBudWxsO1xuICB9XG4gIGlmIChzdGF0ZS5zaWRlYmFyUm9vdCAmJiBzdGF0ZS5zaWRlYmFyUm9vdC5jb250YWlucyhncm91cCkpIHtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmluZENvbnRlbnRBcmVhKCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgaWYgKCFzaWRlYmFyKSByZXR1cm4gbnVsbDtcbiAgbGV0IHBhcmVudCA9IHNpZGViYXIucGFyZW50RWxlbWVudDtcbiAgd2hpbGUgKHBhcmVudCkge1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShwYXJlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZCA9PT0gc2lkZWJhciB8fCBjaGlsZC5jb250YWlucyhzaWRlYmFyKSkgY29udGludWU7XG4gICAgICBjb25zdCByID0gY2hpbGQuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICBpZiAoci53aWR0aCA+IDMwMCAmJiByLmhlaWdodCA+IDIwMCkgcmV0dXJuIGNoaWxkO1xuICAgIH1cbiAgICBwYXJlbnQgPSBwYXJlbnQucGFyZW50RWxlbWVudDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gbWF5YmVEdW1wRG9tKCk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgICBpZiAoc2lkZWJhciAmJiAhc3RhdGUuc2lkZWJhckR1bXBlZCkge1xuICAgICAgc3RhdGUuc2lkZWJhckR1bXBlZCA9IHRydWU7XG4gICAgICBjb25zdCBzYlJvb3QgPSBzaWRlYmFyLnBhcmVudEVsZW1lbnQgPz8gc2lkZWJhcjtcbiAgICAgIHBsb2coYGNvZGV4IHNpZGViYXIgSFRNTGAsIHNiUm9vdC5vdXRlckhUTUwuc2xpY2UoMCwgMzIwMDApKTtcbiAgICB9XG4gICAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICAgIGlmICghY29udGVudCkge1xuICAgICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ICE9PSBsb2NhdGlvbi5ocmVmKSB7XG4gICAgICAgIHN0YXRlLmZpbmdlcnByaW50ID0gbG9jYXRpb24uaHJlZjtcbiAgICAgICAgcGxvZyhcImRvbSBwcm9iZSAobm8gY29udGVudClcIiwge1xuICAgICAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgICAgICBzaWRlYmFyOiBzaWRlYmFyID8gZGVzY3JpYmUoc2lkZWJhcikgOiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgbGV0IHBhbmVsOiBIVE1MRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICAgIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgICBpZiAoY2hpbGQuZGF0YXNldC50d2Vha2VyID09PSBcInR3ZWFrcy1wYW5lbFwiKSBjb250aW51ZTtcbiAgICAgIGlmIChjaGlsZC5zdHlsZS5kaXNwbGF5ID09PSBcIm5vbmVcIikgY29udGludWU7XG4gICAgICBwYW5lbCA9IGNoaWxkO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNvbnN0IGFjdGl2ZU5hdiA9IHNpZGViYXJcbiAgICAgID8gQXJyYXkuZnJvbShzaWRlYmFyLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYnV0dG9uLCBhXCIpKS5maW5kKFxuICAgICAgICAgIChiKSA9PlxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImRhdGEtYWN0aXZlXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5nZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIpID09PSBcInRydWVcIiB8fFxuICAgICAgICAgICAgYi5jbGFzc0xpc3QuY29udGFpbnMoXCJhY3RpdmVcIiksXG4gICAgICAgIClcbiAgICAgIDogbnVsbDtcbiAgICBjb25zdCBoZWFkaW5nID0gcGFuZWw/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFxuICAgICAgXCJoMSwgaDIsIGgzLCBbY2xhc3MqPSdoZWFkaW5nJ11cIixcbiAgICApO1xuICAgIGNvbnN0IGZpbmdlcnByaW50ID0gYCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudCA/PyBcIlwifXwke2hlYWRpbmc/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7cGFuZWw/LmNoaWxkcmVuLmxlbmd0aCA/PyAwfWA7XG4gICAgaWYgKHN0YXRlLmZpbmdlcnByaW50ID09PSBmaW5nZXJwcmludCkgcmV0dXJuO1xuICAgIHN0YXRlLmZpbmdlcnByaW50ID0gZmluZ2VycHJpbnQ7XG4gICAgcGxvZyhcImRvbSBwcm9iZVwiLCB7XG4gICAgICB1cmw6IGxvY2F0aW9uLmhyZWYsXG4gICAgICBhY3RpdmVOYXY6IGFjdGl2ZU5hdj8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgaGVhZGluZzogaGVhZGluZz8udGV4dENvbnRlbnQ/LnRyaW0oKSA/PyBudWxsLFxuICAgICAgY29udGVudDogZGVzY3JpYmUoY29udGVudCksXG4gICAgfSk7XG4gICAgaWYgKHBhbmVsKSB7XG4gICAgICBjb25zdCBodG1sID0gcGFuZWwub3V0ZXJIVE1MO1xuICAgICAgcGxvZyhcbiAgICAgICAgYGNvZGV4IHBhbmVsIEhUTUwgKCR7YWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IFwiP1wifSlgLFxuICAgICAgICBodG1sLnNsaWNlKDAsIDMyMDAwKSxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgcGxvZyhcImRvbSBwcm9iZSBmYWlsZWRcIiwgU3RyaW5nKGUpKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBkZXNjcmliZShlbDogSFRNTEVsZW1lbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiB7XG4gICAgdGFnOiBlbC50YWdOYW1lLFxuICAgIGNsczogZWwuY2xhc3NOYW1lLnNsaWNlKDAsIDEyMCksXG4gICAgaWQ6IGVsLmlkIHx8IHVuZGVmaW5lZCxcbiAgICBjaGlsZHJlbjogZWwuY2hpbGRyZW4ubGVuZ3RoLFxuICAgIHJlY3Q6ICgoKSA9PiB7XG4gICAgICBjb25zdCByID0gZWwuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XG4gICAgICByZXR1cm4geyB3OiBNYXRoLnJvdW5kKHIud2lkdGgpLCBoOiBNYXRoLnJvdW5kKHIuaGVpZ2h0KSB9O1xuICAgIH0pKCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhdGgoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICAod2luZG93IGFzIHVua25vd24gYXMgeyBfX3R3ZWFrZXJfdHdlYWtzX2Rpcl9fPzogc3RyaW5nIH0pLl9fdHdlYWtlcl90d2Vha3NfZGlyX18gPz9cbiAgICBcIjx1c2VyIGRpcj4vdHdlYWtzXCJcbiAgKTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFR3ZWFrTWFuaWZlc3QgfSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1RXRUFLX1NUT1JFX0lOREVYX1VSTCA9XG4gIFwiaHR0cHM6Ly90aGVyZWFsaXR5cmVwb3J0LmdpdGh1Yi5pby90d2Vha2Vycy9zdG9yZS9pbmRleC5qc29uXCI7XG5leHBvcnQgY29uc3QgVFdFQUtfU1RPUkVfUkVWSUVXX0lTU1VFX1VSTCA9XG4gIFwiaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvaXNzdWVzL25ld1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVSZWdpc3RyeSB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGdlbmVyYXRlZEF0Pzogc3RyaW5nO1xuICBlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0b3JlRW50cnkge1xuICBpZDogc3RyaW5nO1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgLyoqXG4gICAqIEFuIGVudHJ5IGNhbiBiZSBjYXRhbG9nIG1ldGFkYXRhIGJlZm9yZSBpdHMgaW1wbGVtZW50YXRpb24gaXMgc2hpcHBlZC5cbiAgICogTWV0YWRhdGEtb25seSBlbnRyaWVzIGRlbGliZXJhdGVseSBvbWl0IGluc3RhbGwgY29vcmRpbmF0ZXMgYW5kIGFyZSBuZXZlclxuICAgKiBvZmZlcmVkIHRvIHRoZSBhcmNoaXZlIGluc3RhbGxlci5cbiAgKi9cbiAgYXZhaWxhYmxlPzogYm9vbGVhbjtcbiAgLyoqIFJlbW90ZSBzb3VyY2UgY29vcmRpbmF0ZXMgYXJlIHJlcXVpcmVkIG9ubHkgZm9yIHJlbW90ZSBlbnRyaWVzLiAqL1xuICByZXBvPzogc3RyaW5nO1xuICBhcHByb3ZlZENvbW1pdFNoYT86IHN0cmluZztcbiAgLyoqIFBhY2thZ2VkIGVudHJpZXMgcG9pbnQgYXQgdGhlIGluc3RhbGxlci1idW5kbGVkIGNhbm9uaWNhbCBzb3VyY2UuICovXG4gIHNvdXJjZT86IFR3ZWFrU3RvcmVTb3VyY2U7XG4gIGFwcHJvdmVkQXQ6IHN0cmluZztcbiAgYXBwcm92ZWRCeTogc3RyaW5nO1xuICBwbGF0Zm9ybXM/OiBUd2Vha1N0b3JlUGxhdGZvcm1bXTtcbiAgcmVsZWFzZVVybD86IHN0cmluZztcbiAgcmV2aWV3VXJsPzogc3RyaW5nO1xufVxuXG5leHBvcnQgdHlwZSBUd2Vha1N0b3JlU291cmNlID1cbiAgfCB7IGtpbmQ6IFwiYnVuZGxlZFwiOyBwYXRoOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJyZW1vdGVcIjsgcmVwbzogc3RyaW5nOyBhcHByb3ZlZENvbW1pdFNoYTogc3RyaW5nIH07XG5cbi8qKiBDYW5vbmljYWwgcHJvamVjdC1vd25lZCB0d2VhayBpZGVudGlmaWVycyBhbmQgc291cmNlIGRpcmVjdG9yaWVzLiAqL1xuZXhwb3J0IGNvbnN0IEJVTkRMRURfVFdFQUtfU09VUkNFX1BBVEhTOiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+PiA9IE9iamVjdC5mcmVlemUoe1xuICBcImNvLnR3ZWFrZXJzLmFjY291bnQtc3dpdGNoZXJcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuYWNjb3VudC1zd2l0Y2hlclwiLFxuICBcImNvLnR3ZWFrZXJzLmFwcHNob3RzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLmFwcHNob3RzXCIsXG4gIFwiY28udHdlYWtlcnMuZGV2ZWxvcGVyLXRvb2xzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLmRldmVsb3Blci10b29sc1wiLFxuICBcImNvLnR3ZWFrZXJzLnNoYWRjbi1jb2RleC11aVwiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5zaGFkY24tY29kZXgtdWlcIixcbiAgXCJjby50d2Vha2Vycy5mb2xsb3d1cFwiOiBcInR3ZWFrcy9mb2xsb3d1cFwiLFxuICBcImNvLnR3ZWFrZXJzLnByb2plY3RzXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLnByb2plY3RzXCIsXG4gIFwiY28udHdlYWtlcnMudGhyZWFkLXN1bW1hcnktcHJvZmlsZXNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMudGhyZWFkLXN1bW1hcnktcHJvZmlsZXNcIixcbiAgXCJjby50d2Vha2Vycy50aXRsZWJhci1jb250cm9sc1wiOiBcInR3ZWFrcy90aXRsZWJhci1jb250cm9sc1wiLFxuICBcImNvLnR3ZWFrZXJzLnVpLWltcHJvdmVtZW50c1wiOiBcInR3ZWFrcy91aS1pbXByb3ZlbWVudHNcIixcbiAgXCJjby50d2Vha2Vycy51c2VyLXF1ZXN0aW9uc1wiOiBcInR3ZWFrcy91c2VyLXF1ZXN0aW9uc1wiLFxuICBcImNvLnR3ZWFrZXJzLnVzYWdlLWxpbWl0LXJlc2V0cy10cmFja2VyXCI6IFwidHdlYWtzL3VzYWdlLWxpbWl0LXJlc2V0cy10cmFja2VyXCIsXG59KTtcblxuZXhwb3J0IHR5cGUgVHdlYWtIZWFsdGhTdGF0dXMgPSBcImZhaWxlZFwiIHwgXCJxdWFyYW50aW5lZFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrSGVhbHRoUmVjb3JkIHtcbiAgc3RhdHVzOiBUd2Vha0hlYWx0aFN0YXR1cztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG4vKiogVGhlIHVzZXItZmFjaW5nIHN0YXRlIHZvY2FidWxhcnkgZm9yIGNhdGFsb2cgcm93cy4gKi9cbmV4cG9ydCB0eXBlIFR3ZWFrU3RhdHVzID1cbiAgfCBcImluc3RhbGxlZFwiXG4gIHwgXCJub3QtaW5zdGFsbGVkXCJcbiAgfCBcImVuYWJsZWRcIlxuICB8IFwiZGlzYWJsZWRcIlxuICB8IFwiZmFpbGVkXCJcbiAgfCBcInF1YXJhbnRpbmVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdGF0dXNJbnB1dCB7XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgaGVhbHRoPzogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlVHdlYWtTdGF0dXMoaW5wdXQ6IFR3ZWFrU3RhdHVzSW5wdXQpOiBUd2Vha1N0YXR1cyB7XG4gIGlmICghaW5wdXQuaW5zdGFsbGVkKSByZXR1cm4gXCJub3QtaW5zdGFsbGVkXCI7XG4gIGlmIChpbnB1dC5oZWFsdGg/LnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiKSByZXR1cm4gXCJxdWFyYW50aW5lZFwiO1xuICBpZiAoaW5wdXQuaGVhbHRoPy5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcImZhaWxlZFwiO1xuICByZXR1cm4gaW5wdXQuZW5hYmxlZCA/IFwiZW5hYmxlZFwiIDogXCJkaXNhYmxlZFwiO1xufVxuXG5leHBvcnQgdHlwZSBUd2Vha1N0b3JlUGxhdGZvcm0gPSBcImRhcndpblwiIHwgXCJ3aW4zMlwiIHwgXCJsaW51eFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbiB7XG4gIHJlcG86IHN0cmluZztcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICBjb21taXRTaGE6IHN0cmluZztcbiAgY29tbWl0VXJsOiBzdHJpbmc7XG4gIG1hbmlmZXN0Pzoge1xuICAgIGlkPzogc3RyaW5nO1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgdmVyc2lvbj86IHN0cmluZztcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgICBpY29uVXJsPzogc3RyaW5nO1xuICB9O1xufVxuXG5jb25zdCBHSVRIVUJfUkVQT19SRSA9IC9eW0EtWmEtejAtOV8uLV0rXFwvW0EtWmEtejAtOV8uLV0rJC87XG5jb25zdCBGVUxMX1NIQV9SRSA9IC9eW2EtZjAtOV17NDB9JC9pO1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplR2l0SHViUmVwbyhpbnB1dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcmF3ID0gaW5wdXQudHJpbSgpO1xuICBpZiAoIXJhdykgdGhyb3cgbmV3IEVycm9yKFwiR2l0SHViIHJlcG8gaXMgcmVxdWlyZWRcIik7XG5cbiAgY29uc3Qgc3NoID0gL15naXRAZ2l0aHViXFwuY29tOihbXi9dK1xcL1teL10rPykoPzpcXC5naXQpPyQvaS5leGVjKHJhdyk7XG4gIGlmIChzc2gpIHJldHVybiBub3JtYWxpemVSZXBvUGFydChzc2hbMV0pO1xuXG4gIGlmICgvXmh0dHBzPzpcXC9cXC8vaS50ZXN0KHJhdykpIHtcbiAgICBjb25zdCB1cmwgPSBuZXcgVVJMKHJhdyk7XG4gICAgaWYgKHVybC5ob3N0bmFtZSAhPT0gXCJnaXRodWIuY29tXCIpIHRocm93IG5ldyBFcnJvcihcIk9ubHkgZ2l0aHViLmNvbSByZXBvc2l0b3JpZXMgYXJlIHN1cHBvcnRlZFwiKTtcbiAgICBjb25zdCBwYXJ0cyA9IHVybC5wYXRobmFtZS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCBcIlwiKS5zcGxpdChcIi9cIik7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA8IDIpIHRocm93IG5ldyBFcnJvcihcIkdpdEh1YiByZXBvIFVSTCBtdXN0IGluY2x1ZGUgb3duZXIgYW5kIHJlcG9zaXRvcnlcIik7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KGAke3BhcnRzWzBdfS8ke3BhcnRzWzFdfWApO1xuICB9XG5cbiAgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KHJhdyk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVTdG9yZVJlZ2lzdHJ5KGlucHV0OiB1bmtub3duKTogVHdlYWtTdG9yZVJlZ2lzdHJ5IHtcbiAgY29uc3QgcmVnaXN0cnkgPSBpbnB1dCBhcyBQYXJ0aWFsPFR3ZWFrU3RvcmVSZWdpc3RyeT4gfCBudWxsO1xuICBpZiAoIXJlZ2lzdHJ5IHx8IHJlZ2lzdHJ5LnNjaGVtYVZlcnNpb24gIT09IDEgfHwgIUFycmF5LmlzQXJyYXkocmVnaXN0cnkuZW50cmllcykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCB0d2VhayBzdG9yZSByZWdpc3RyeVwiKTtcbiAgfVxuICBjb25zdCBlbnRyaWVzID0gcmVnaXN0cnkuZW50cmllcy5tYXAobm9ybWFsaXplU3RvcmVFbnRyeSk7XG4gIGVudHJpZXMuc29ydCgoYSwgYikgPT4gYS5tYW5pZmVzdC5uYW1lLmxvY2FsZUNvbXBhcmUoYi5tYW5pZmVzdC5uYW1lKSk7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICBnZW5lcmF0ZWRBdDogdHlwZW9mIHJlZ2lzdHJ5LmdlbmVyYXRlZEF0ID09PSBcInN0cmluZ1wiID8gcmVnaXN0cnkuZ2VuZXJhdGVkQXQgOiB1bmRlZmluZWQsXG4gICAgZW50cmllcyxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNodWZmbGVTdG9yZUVudHJpZXM8VD4oXG4gIGVudHJpZXM6IHJlYWRvbmx5IFRbXSxcbiAgcmFuZG9tSW5kZXg6IChleGNsdXNpdmVNYXg6IG51bWJlcikgPT4gbnVtYmVyID0gKGV4Y2x1c2l2ZU1heCkgPT4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogZXhjbHVzaXZlTWF4KSxcbik6IFRbXSB7XG4gIGNvbnN0IHNodWZmbGVkID0gWy4uLmVudHJpZXNdO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGkgLT0gMSkge1xuICAgIGNvbnN0IGogPSByYW5kb21JbmRleChpICsgMSk7XG4gICAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKGopIHx8IGogPCAwIHx8IGogPiBpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHNodWZmbGUgcmFuZG9tSW5kZXggcmV0dXJuZWQgJHtqfTsgZXhwZWN0ZWQgYW4gaW50ZWdlciBmcm9tIDAgdG8gJHtpfWApO1xuICAgIH1cbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlRW50cnkoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlRW50cnkge1xuICBjb25zdCBlbnRyeSA9IGlucHV0IGFzIFBhcnRpYWw8VHdlYWtTdG9yZUVudHJ5PiB8IG51bGw7XG4gIGlmICghZW50cnkgfHwgdHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiKSB0aHJvdyBuZXcgRXJyb3IoXCJJbnZhbGlkIHR3ZWFrIHN0b3JlIGVudHJ5XCIpO1xuICBjb25zdCBtYW5pZmVzdCA9IGVudHJ5Lm1hbmlmZXN0IGFzIFR3ZWFrTWFuaWZlc3QgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGF2YWlsYWJsZSA9IGVudHJ5LmF2YWlsYWJsZSAhPT0gZmFsc2U7XG4gIGlmICghbWFuaWZlc3Q/LmlkIHx8ICFtYW5pZmVzdC5uYW1lIHx8ICFtYW5pZmVzdC52ZXJzaW9uIHx8ICFtYW5pZmVzdC5naXRodWJSZXBvKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiU3RvcmUgZW50cnkgaXMgbWlzc2luZyBtYW5pZmVzdCBmaWVsZHNcIik7XG4gIH1cbiAgY29uc3Qgc3VwcGxpZWRSZXBvID0gdHlwZW9mIGVudHJ5LnJlcG8gPT09IFwic3RyaW5nXCIgJiYgZW50cnkucmVwby50cmltKClcbiAgICA/IG5vcm1hbGl6ZUdpdEh1YlJlcG8oZW50cnkucmVwbylcbiAgICA6IHVuZGVmaW5lZDtcbiAgaWYgKHN1cHBsaWVkUmVwbyAmJiBub3JtYWxpemVHaXRIdWJSZXBvKG1hbmlmZXN0LmdpdGh1YlJlcG8pICE9PSBzdXBwbGllZFJlcG8pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IHJlcG8gZG9lcyBub3QgbWF0Y2ggbWFuaWZlc3QgZ2l0aHViUmVwb2ApO1xuICB9XG4gIGNvbnN0IHNvdXJjZUlucHV0ID0gKGVudHJ5IGFzIHsgc291cmNlPzogdW5rbm93biB9KS5zb3VyY2U7XG4gIGxldCBzb3VyY2U6IFR3ZWFrU3RvcmVTb3VyY2UgfCB1bmRlZmluZWQ7XG4gIGxldCByZXBvID0gc3VwcGxpZWRSZXBvO1xuICBsZXQgYXBwcm92ZWRDb21taXRTaGEgPSB0eXBlb2YgZW50cnkuYXBwcm92ZWRDb21taXRTaGEgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA6IFwiXCI7XG4gIGlmIChzb3VyY2VJbnB1dCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgaWYgKCFzb3VyY2VJbnB1dCB8fCB0eXBlb2Ygc291cmNlSW5wdXQgIT09IFwib2JqZWN0XCIgfHwgQXJyYXkuaXNBcnJheShzb3VyY2VJbnB1dCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gaGFzIGFuIGludmFsaWQgc291cmNlYCk7XG4gICAgfVxuICAgIGNvbnN0IHJhd1NvdXJjZSA9IHNvdXJjZUlucHV0IGFzIHsga2luZD86IHVua25vd247IHBhdGg/OiB1bmtub3duOyByZXBvPzogdW5rbm93bjsgYXBwcm92ZWRDb21taXRTaGE/OiB1bmtub3duIH07XG4gICAgaWYgKHJhd1NvdXJjZS5raW5kID09PSBcImJ1bmRsZWRcIikge1xuICAgICAgY29uc3QgcGF0aCA9IG5vcm1hbGl6ZUJ1bmRsZWRTb3VyY2VQYXRoKHJhd1NvdXJjZS5wYXRoLCBtYW5pZmVzdC5pZCk7XG4gICAgICBzb3VyY2UgPSB7IGtpbmQ6IFwiYnVuZGxlZFwiLCBwYXRoIH07XG4gICAgICAvLyBBIGJ1bmRsZWQgc291cmNlIGlzIGludGVudGlvbmFsbHkgaW5kZXBlbmRlbnQgb2YgR2l0SHViIGNvb3JkaW5hdGVzLlxuICAgICAgcmVwbyA9IHN1cHBsaWVkUmVwbztcbiAgICAgIGFwcHJvdmVkQ29tbWl0U2hhID0gXCJcIjtcbiAgICB9IGVsc2UgaWYgKHJhd1NvdXJjZS5raW5kID09PSBcInJlbW90ZVwiKSB7XG4gICAgICBjb25zdCByZW1vdGVSZXBvID0gbm9ybWFsaXplR2l0SHViUmVwbyhTdHJpbmcocmF3U291cmNlLnJlcG8gPz8gc3VwcGxpZWRSZXBvID8/IFwiXCIpKTtcbiAgICAgIGNvbnN0IHNoYSA9IFN0cmluZyhyYXdTb3VyY2UuYXBwcm92ZWRDb21taXRTaGEgPz8gZW50cnkuYXBwcm92ZWRDb21taXRTaGEgPz8gXCJcIik7XG4gICAgICBpZiAoYXZhaWxhYmxlICYmICFpc0Z1bGxDb21taXRTaGEoc2hhKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IG11c3QgcGluIGEgZnVsbCBhcHByb3ZlZCBjb21taXQgU0hBYCk7XG4gICAgICB9XG4gICAgICBpZiAoc3VwcGxpZWRSZXBvICYmIHN1cHBsaWVkUmVwbyAhPT0gcmVtb3RlUmVwbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IHJlbW90ZSBzb3VyY2UgcmVwbyBkb2VzIG5vdCBtYXRjaCByZXBvYCk7XG4gICAgICB9XG4gICAgICBzb3VyY2UgPSB7IGtpbmQ6IFwicmVtb3RlXCIsIHJlcG86IHJlbW90ZVJlcG8sIGFwcHJvdmVkQ29tbWl0U2hhOiBzaGEgfTtcbiAgICAgIHJlcG8gPSByZW1vdGVSZXBvO1xuICAgICAgYXBwcm92ZWRDb21taXRTaGEgPSBzaGE7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gaGFzIHVuc3VwcG9ydGVkIHNvdXJjZSBraW5kYCk7XG4gICAgfVxuICB9IGVsc2UgaWYgKGF2YWlsYWJsZSkge1xuICAgIC8vIExlZ2FjeSBhdmFpbGFibGUgZW50cmllcyBhcmUgcmVtb3RlIGFuZCBtdXN0IHJlbWFpbiBwaW5uZWQuXG4gICAgcmVwbyA9IG5vcm1hbGl6ZUdpdEh1YlJlcG8oU3RyaW5nKHJlcG8gPz8gbWFuaWZlc3QuZ2l0aHViUmVwbyA/PyBcIlwiKSk7XG4gICAgaWYgKCFpc0Z1bGxDb21taXRTaGEoYXBwcm92ZWRDb21taXRTaGEpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7bWFuaWZlc3QuaWR9IG11c3QgcGluIGEgZnVsbCBhcHByb3ZlZCBjb21taXQgU0hBYCk7XG4gICAgfVxuICAgIHNvdXJjZSA9IHsga2luZDogXCJyZW1vdGVcIiwgcmVwbywgYXBwcm92ZWRDb21taXRTaGEgfTtcbiAgfSBlbHNlIGlmICghcmVwbykge1xuICAgIC8vIE1ldGFkYXRhLW9ubHkgZW50cmllcyBtYXkgb21pdCBhbGwgaW5zdGFsbCBjb29yZGluYXRlcy4gS2VlcCB0aGUgc291cmNlXG4gICAgLy8gYWJzZW50IHNvIGNhbGxlcnMgY2Fubm90IGFjY2lkZW50YWxseSB0cmVhdCB0aGVtIGFzIGluc3RhbGxhYmxlLlxuICB9XG4gIHJldHVybiB7XG4gICAgaWQ6IG1hbmlmZXN0LmlkLFxuICAgIG1hbmlmZXN0LFxuICAgIGF2YWlsYWJsZSxcbiAgICAuLi4ocmVwbyA/IHsgcmVwbyB9IDoge30pLFxuICAgIGFwcHJvdmVkQ29tbWl0U2hhLFxuICAgIC4uLihzb3VyY2UgPyB7IHNvdXJjZSB9IDoge30pLFxuICAgIGFwcHJvdmVkQXQ6IHR5cGVvZiBlbnRyeS5hcHByb3ZlZEF0ID09PSBcInN0cmluZ1wiID8gZW50cnkuYXBwcm92ZWRBdCA6IFwiXCIsXG4gICAgYXBwcm92ZWRCeTogdHlwZW9mIGVudHJ5LmFwcHJvdmVkQnkgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZEJ5IDogXCJcIixcbiAgICBwbGF0Zm9ybXM6IG5vcm1hbGl6ZVN0b3JlUGxhdGZvcm1zKChlbnRyeSBhcyB7IHBsYXRmb3Jtcz86IHVua25vd24gfSkucGxhdGZvcm1zKSxcbiAgICByZWxlYXNlVXJsOiBvcHRpb25hbEdpdGh1YlVybChlbnRyeS5yZWxlYXNlVXJsKSxcbiAgICByZXZpZXdVcmw6IG9wdGlvbmFsR2l0aHViVXJsKGVudHJ5LnJldmlld1VybCksXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdG9yZUFyY2hpdmVVcmwoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeSk6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwiYnVuZGxlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSB1c2VzIGEgYnVuZGxlZCBzb3VyY2UgYW5kIGhhcyBubyBhcmNoaXZlIFVSTGApO1xuICB9XG4gIGNvbnN0IHJlcG8gPSBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwicmVtb3RlXCIgPyBlbnRyeS5zb3VyY2UucmVwbyA6IGVudHJ5LnJlcG87XG4gIGNvbnN0IGFwcHJvdmVkQ29tbWl0U2hhID0gZW50cnkuc291cmNlPy5raW5kID09PSBcInJlbW90ZVwiXG4gICAgPyBlbnRyeS5zb3VyY2UuYXBwcm92ZWRDb21taXRTaGFcbiAgICA6IGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhO1xuICBpZiAoIXJlcG8gfHwgIWlzRnVsbENvbW1pdFNoYShhcHByb3ZlZENvbW1pdFNoYSA/PyBcIlwiKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gaXMgbm90IHBpbm5lZCB0byBhIGZ1bGwgY29tbWl0IFNIQWApO1xuICB9XG4gIHJldHVybiBgaHR0cHM6Ly9jb2RlbG9hZC5naXRodWIuY29tLyR7cmVwb30vdGFyLmd6LyR7YXBwcm92ZWRDb21taXRTaGF9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzQnVuZGxlZFN0b3JlRW50cnkoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIjtcbn1cblxuLyoqIFJlc29sdmUgYSBwYWNrYWdlZCBzb3VyY2Ugd2hpbGUgcmVqZWN0aW5nIHRyYXZlcnNhbCBhbmQgSUQgbWlzbWF0Y2hlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlQnVuZGxlZFR3ZWFrUGF0aChcbiAgcGFja2FnZWRUd2Vha3NSb290OiBzdHJpbmcsXG4gIGVudHJ5OiBQaWNrPFR3ZWFrU3RvcmVFbnRyeSwgXCJpZFwiIHwgXCJzb3VyY2VcIj4sXG4pOiBzdHJpbmcge1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kICE9PSBcImJ1bmRsZWRcIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gZG9lcyBub3QgdXNlIGEgYnVuZGxlZCBzb3VyY2VgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gZW50cnkuc291cmNlLnBhdGgucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpO1xuICBpZiAoXG4gICAgIW5vcm1hbGl6ZWQgfHxcbiAgICBub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCIvXCIpIHx8XG4gICAgbm9ybWFsaXplZC5zcGxpdChcIi9cIikuc29tZSgocGFydCkgPT4gcGFydCA9PT0gXCIuLlwiIHx8IHBhcnQgPT09IFwiXCIpIHx8XG4gICAgbm9ybWFsaXplZCAhPT0gQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFNbZW50cnkuaWRdXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtlbnRyeS5pZH0gaGFzIGFuIHVuc2FmZSBidW5kbGVkIHNvdXJjZSBwYXRoYCk7XG4gIH1cbiAgLy8gVGhlIG5vcm1hbGl6ZWQgcGF0aCBpcyBleGFjdGx5IGB0d2Vha3MvPGlkPmAgKG5vIGRvdCBzZWdtZW50cyksIHNvIGFcbiAgLy8gc2ltcGxlIGpvaW4gaXMgc3VmZmljaWVudCBhbmQga2VlcHMgdGhpcyBzaGFyZWQgbW9kdWxlIGJyb3dzZXItYnVuZGxlYWJsZS5cbiAgY29uc3Qgcm9vdCA9IHBhY2thZ2VkVHdlYWtzUm9vdC5yZXBsYWNlKC9bXFxcXC9dKyQvLCBcIlwiKTtcbiAgcmV0dXJuIGAke3Jvb3R9LyR7bm9ybWFsaXplZH1gO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCdW5kbGVkU291cmNlUGF0aCh2YWx1ZTogdW5rbm93biwgaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIpIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtpZH0gYnVuZGxlZCBzb3VyY2UgcGF0aCBpcyByZXF1aXJlZGApO1xuICBjb25zdCBub3JtYWxpemVkID0gdmFsdWUucmVwbGFjZUFsbChcIlxcXFxcIiwgXCIvXCIpLnJlcGxhY2UoL15cXC5cXC8vLCBcIlwiKTtcbiAgaWYgKG5vcm1hbGl6ZWQgIT09IEJVTkRMRURfVFdFQUtfU09VUkNFX1BBVEhTW2lkXSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHtpZH0gYnVuZGxlZCBzb3VyY2UgaXMgbm90IGFsbG93bGlzdGVkYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFR3ZWFrUHVibGlzaElzc3VlVXJsKHN1Ym1pc3Npb246IFR3ZWFrU3RvcmVQdWJsaXNoU3VibWlzc2lvbik6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG8gPSBub3JtYWxpemVHaXRIdWJSZXBvKHN1Ym1pc3Npb24ucmVwbyk7XG4gIGlmICghaXNGdWxsQ29tbWl0U2hhKHN1Ym1pc3Npb24uY29tbWl0U2hhKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlN1Ym1pc3Npb24gbXVzdCBpbmNsdWRlIHRoZSBmdWxsIGNvbW1pdCBTSEEgdG8gcmV2aWV3XCIpO1xuICB9XG4gIGNvbnN0IHRpdGxlID0gYFR3ZWFrIHN0b3JlIHJldmlldzogJHtyZXBvfWA7XG4gIGNvbnN0IGJvZHkgPSBbXG4gICAgXCIjIyBUd2VhayByZXBvXCIsXG4gICAgYGh0dHBzOi8vZ2l0aHViLmNvbS8ke3JlcG99YCxcbiAgICBcIlwiLFxuICAgIFwiIyMgQ29tbWl0IHRvIHJldmlld1wiLFxuICAgIHN1Ym1pc3Npb24uY29tbWl0U2hhLFxuICAgIHN1Ym1pc3Npb24uY29tbWl0VXJsLFxuICAgIFwiXCIsXG4gICAgXCJEbyBub3QgYXBwcm92ZSBhIGRpZmZlcmVudCBjb21taXQuIElmIHRoZSBhdXRob3IgcHVzaGVzIGNoYW5nZXMsIGFzayB0aGVtIHRvIHJlc3VibWl0LlwiLFxuICAgIFwiXCIsXG4gICAgXCIjIyBNYW5pZmVzdFwiLFxuICAgIGAtIGlkOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/LmlkID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIG5hbWU6ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8ubmFtZSA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSB2ZXJzaW9uOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/LnZlcnNpb24gPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gZGVzY3JpcHRpb246ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8uZGVzY3JpcHRpb24gPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gaWNvblVybDogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5pY29uVXJsID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIFwiXCIsXG4gICAgXCIjIyBBZG1pbiBjaGVja2xpc3RcIixcbiAgICBcIi0gWyBdIG1hbmlmZXN0Lmpzb24gaXMgdmFsaWRcIixcbiAgICBcIi0gWyBdIG1hbmlmZXN0Lmljb25VcmwgaXMgdXNhYmxlIGFzIHRoZSBzdG9yZSBpY29uXCIsXG4gICAgXCItIFsgXSBzb3VyY2Ugd2FzIHJldmlld2VkIGF0IHRoZSBleGFjdCBjb21taXQgYWJvdmVcIixcbiAgICBcIi0gWyBdIGBzdG9yZS9pbmRleC5qc29uYCBlbnRyeSBwaW5zIGBhcHByb3ZlZENvbW1pdFNoYWAgdG8gdGhlIGV4YWN0IGNvbW1pdCBhYm92ZVwiLFxuICBdLmpvaW4oXCJcXG5cIik7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwoVFdFQUtfU1RPUkVfUkVWSUVXX0lTU1VFX1VSTCk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwidGVtcGxhdGVcIiwgXCJ0d2Vhay1zdG9yZS1yZXZpZXcubWRcIik7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwidGl0bGVcIiwgdGl0bGUpO1xuICB1cmwuc2VhcmNoUGFyYW1zLnNldChcImJvZHlcIiwgYm9keSk7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzRnVsbENvbW1pdFNoYSh2YWx1ZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBGVUxMX1NIQV9SRS50ZXN0KHZhbHVlKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVwb1BhcnQodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJlcG8gPSB2YWx1ZS50cmltKCkucmVwbGFjZSgvXFwuZ2l0JC9pLCBcIlwiKS5yZXBsYWNlKC9eXFwvK3xcXC8rJC9nLCBcIlwiKTtcbiAgaWYgKCFHSVRIVUJfUkVQT19SRS50ZXN0KHJlcG8pKSB0aHJvdyBuZXcgRXJyb3IoXCJHaXRIdWIgcmVwbyBtdXN0IGJlIGluIG93bmVyL3JlcG8gZm9ybVwiKTtcbiAgcmV0dXJuIHJlcG87XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlUGxhdGZvcm1zKGlucHV0OiB1bmtub3duKTogVHdlYWtTdG9yZVBsYXRmb3JtW10gfCB1bmRlZmluZWQge1xuICBpZiAoaW5wdXQgPT09IHVuZGVmaW5lZCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGlucHV0KSkgdGhyb3cgbmV3IEVycm9yKFwiU3RvcmUgZW50cnkgcGxhdGZvcm1zIG11c3QgYmUgYW4gYXJyYXlcIik7XG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PFR3ZWFrU3RvcmVQbGF0Zm9ybT4oW1wiZGFyd2luXCIsIFwid2luMzJcIiwgXCJsaW51eFwiXSk7XG4gIGNvbnN0IHBsYXRmb3JtcyA9IEFycmF5LmZyb20obmV3IFNldChpbnB1dC5tYXAoKHZhbHVlKSA9PiB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhYWxsb3dlZC5oYXModmFsdWUgYXMgVHdlYWtTdG9yZVBsYXRmb3JtKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBzdG9yZSBwbGF0Zm9ybTogJHtTdHJpbmcodmFsdWUpfWApO1xuICAgIH1cbiAgICByZXR1cm4gdmFsdWUgYXMgVHdlYWtTdG9yZVBsYXRmb3JtO1xuICB9KSkpO1xuICByZXR1cm4gcGxhdGZvcm1zLmxlbmd0aCA+IDAgPyBwbGF0Zm9ybXMgOiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIG9wdGlvbmFsR2l0aHViVXJsKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIiB8fCAhdmFsdWUudHJpbSgpKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCB1cmwgPSBuZXcgVVJMKHZhbHVlKTtcbiAgaWYgKHVybC5wcm90b2NvbCAhPT0gXCJodHRwczpcIiB8fCB1cmwuaG9zdG5hbWUgIT09IFwiZ2l0aHViLmNvbVwiKSByZXR1cm4gdW5kZWZpbmVkO1xuICByZXR1cm4gdXJsLnRvU3RyaW5nKCk7XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc05hdmlnYXRpb25Ud2VhayB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdmVyc2lvbjogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgaWNvblVybD86IHN0cmluZztcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBzdHJpbmc7XG4gIGhlYWx0aEVycm9yPzogc3RyaW5nIHwgbnVsbDtcbiAgbGlmZWN5Y2xlT3ZlcnJpZGU/OiBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIHR3ZWFrSWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIGljb25Tdmc/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZSA9XG4gIHwgXCJlbmFibGVkXCJcbiAgfCBcImZhaWxlZFwiXG4gIHwgXCJxdWFyYW50aW5lZFwiXG4gIHwgXCJzdGFydGluZ1wiXG4gIHwgXCJ0aW1lZF9vdXRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc05hdmlnYXRpb25JdGVtIHtcbiAgdHdlYWtJZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIGljb25Vcmw/OiBzdHJpbmc7XG4gIGljb25Tdmc/OiBzdHJpbmc7XG4gIHJlZ2lzdHJhdGlvbklkczogc3RyaW5nW107XG4gIGZhbGxiYWNrOiBib29sZWFuO1xuICBsaWZlY3ljbGU6IFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZTtcbiAgd2FybmluZzogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkU2V0dGluZ3NOYXZpZ2F0aW9uTW9kZWwoXG4gIHR3ZWFrczogU2V0dGluZ3NOYXZpZ2F0aW9uVHdlYWtbXSxcbiAgcmVnaXN0cmF0aW9uczogU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeVtdLFxuKTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtdIHtcbiAgY29uc3QgcmVnaXN0cmF0aW9uc0J5VHdlYWsgPSBuZXcgTWFwPHN0cmluZywgU2V0dGluZ3NQYWdlUmVnaXN0cmF0aW9uU3VtbWFyeVtdPigpO1xuICBmb3IgKGNvbnN0IHJlZ2lzdHJhdGlvbiBvZiByZWdpc3RyYXRpb25zKSB7XG4gICAgY29uc3QgZ3JvdXAgPSByZWdpc3RyYXRpb25zQnlUd2Vhay5nZXQocmVnaXN0cmF0aW9uLnR3ZWFrSWQpID8/IFtdO1xuICAgIGdyb3VwLnB1c2gocmVnaXN0cmF0aW9uKTtcbiAgICByZWdpc3RyYXRpb25zQnlUd2Vhay5zZXQocmVnaXN0cmF0aW9uLnR3ZWFrSWQsIGdyb3VwKTtcbiAgfVxuXG4gIGNvbnN0IHJvd3M6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSA9IFtdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdHdlYWsgb2YgdHdlYWtzKSB7XG4gICAgaWYgKCF0d2Vhay5lbmFibGVkIHx8IHNlZW4uaGFzKHR3ZWFrLmlkKSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQodHdlYWsuaWQpO1xuICAgIGNvbnN0IHBhZ2VzID0gcmVnaXN0cmF0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrLmlkKSA/PyBbXTtcbiAgICBjb25zdCBwcmltYXJ5ID0gcGFnZXNbMF07XG4gICAgcm93cy5wdXNoKHtcbiAgICAgIHR3ZWFrSWQ6IHR3ZWFrLmlkLFxuICAgICAgdGl0bGU6IHByaW1hcnk/LnRpdGxlIHx8IHR3ZWFrLm5hbWUsXG4gICAgICB2ZXJzaW9uOiB0d2Vhay52ZXJzaW9uLFxuICAgICAgZGVzY3JpcHRpb246IHByaW1hcnk/LmRlc2NyaXB0aW9uIHx8IHR3ZWFrLmRlc2NyaXB0aW9uIHx8IFwiRW5hYmxlZCBUd2Vha2VyLlwiLFxuICAgICAgaWNvblVybDogdHdlYWsuaWNvblVybCxcbiAgICAgIGljb25Tdmc6IHByaW1hcnk/Lmljb25TdmcsXG4gICAgICByZWdpc3RyYXRpb25JZHM6IHBhZ2VzLm1hcCgocGFnZSkgPT4gcGFnZS5pZCksXG4gICAgICBmYWxsYmFjazogcGFnZXMubGVuZ3RoID09PSAwLFxuICAgICAgbGlmZWN5Y2xlOiBsaWZlY3ljbGVGb3IodHdlYWspLFxuICAgICAgd2FybmluZzogdHdlYWsuaGVhbHRoRXJyb3IgfHwgbnVsbCxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gcm93cy5zb3J0KChhLCBiKSA9PiBhLnRpdGxlLmxvY2FsZUNvbXBhcmUoYi50aXRsZSkgfHwgYS50d2Vha0lkLmxvY2FsZUNvbXBhcmUoYi50d2Vha0lkKSk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUZvcih0d2VhazogU2V0dGluZ3NOYXZpZ2F0aW9uVHdlYWspOiBTZXR0aW5nc05hdmlnYXRpb25MaWZlY3ljbGUge1xuICBpZiAodHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGUpIHJldHVybiB0d2Vhay5saWZlY3ljbGVPdmVycmlkZTtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZmFpbGVkXCI7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikgcmV0dXJuIFwicXVhcmFudGluZWRcIjtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJzdGFydGluZ1wiKSByZXR1cm4gXCJzdGFydGluZ1wiO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcInRpbWVkX291dFwiKSByZXR1cm4gXCJ0aW1lZF9vdXRcIjtcbiAgcmV0dXJuIFwiZW5hYmxlZFwiO1xufVxuIiwgImltcG9ydCB0eXBlIHsgVHdlYWtNYW5pZmVzdCB9IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB0eXBlIHsgVHdlYWtTdGF0dXMgfSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcblxuZXhwb3J0IHR5cGUgVHdlYWtzUGFnZUZpbHRlciA9IFwiYWxsXCIgfCBcImVuYWJsZWRcIiB8IFwiZGlzYWJsZWRcIiB8IFwidXBkYXRlc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrc1BhZ2VJdGVtIHtcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgdXBkYXRlOiB7IHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbiB9IHwgbnVsbDtcbn1cblxuZXhwb3J0IHR5cGUgVHdlYWtzUGFnZUNvdW50cyA9IFJlY29yZDxUd2Vha3NQYWdlRmlsdGVyLCBudW1iZXI+O1xuXG5leHBvcnQgY29uc3QgVFdFQUtTX1BBR0VfRklMVEVSUzogcmVhZG9ubHkgVHdlYWtzUGFnZUZpbHRlcltdID0gW1xuICBcImFsbFwiLFxuICBcImVuYWJsZWRcIixcbiAgXCJkaXNhYmxlZFwiLFxuICBcInVwZGF0ZXNcIixcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiB0d2Vha3NQYWdlQ291bnRzKGl0ZW1zOiByZWFkb25seSBUd2Vha3NQYWdlSXRlbVtdKTogVHdlYWtzUGFnZUNvdW50cyB7XG4gIHJldHVybiB7XG4gICAgYWxsOiBpdGVtcy5sZW5ndGgsXG4gICAgZW5hYmxlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcImVuYWJsZWRcIikpLmxlbmd0aCxcbiAgICBkaXNhYmxlZDogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcImRpc2FibGVkXCIpKS5sZW5ndGgsXG4gICAgdXBkYXRlczogaXRlbXMuZmlsdGVyKChpdGVtKSA9PiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihpdGVtLCBcInVwZGF0ZXNcIikpLmxlbmd0aCxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlclR3ZWFrc1BhZ2VJdGVtczxUIGV4dGVuZHMgVHdlYWtzUGFnZUl0ZW0+KFxuICBpdGVtczogcmVhZG9ubHkgVFtdLFxuICBmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIsXG4gIHF1ZXJ5OiBzdHJpbmcsXG4pOiBUW10ge1xuICBjb25zdCBub3JtYWxpemVkUXVlcnkgPSBub3JtYWxpemVUd2Vha3NQYWdlU2VhcmNoKHF1ZXJ5KTtcbiAgcmV0dXJuIGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4ge1xuICAgIGlmICghbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgZmlsdGVyKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghbm9ybWFsaXplZFF1ZXJ5KSByZXR1cm4gdHJ1ZTtcbiAgICByZXR1cm4gdHdlYWtzUGFnZVNlYXJjaFRleHQoaXRlbSkuaW5jbHVkZXMobm9ybWFsaXplZFF1ZXJ5KTtcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaGVzVHdlYWtzUGFnZUZpbHRlcihcbiAgaXRlbTogVHdlYWtzUGFnZUl0ZW0sXG4gIGZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcixcbik6IGJvb2xlYW4ge1xuICBpZiAoZmlsdGVyID09PSBcImVuYWJsZWRcIikgcmV0dXJuIGl0ZW0uaW5zdGFsbGVkICYmIGl0ZW0uZW5hYmxlZDtcbiAgaWYgKGZpbHRlciA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gaXRlbS5pbnN0YWxsZWQgJiYgIWl0ZW0uZW5hYmxlZDtcbiAgaWYgKGZpbHRlciA9PT0gXCJ1cGRhdGVzXCIpIHJldHVybiBpdGVtLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlID09PSB0cnVlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHR3ZWFrc1BhZ2VTZWFyY2hUZXh0KGl0ZW06IFR3ZWFrc1BhZ2VJdGVtKTogc3RyaW5nIHtcbiAgY29uc3QgYXV0aG9yID0gdHlwZW9mIGl0ZW0ubWFuaWZlc3QuYXV0aG9yID09PSBcInN0cmluZ1wiXG4gICAgPyBpdGVtLm1hbmlmZXN0LmF1dGhvclxuICAgIDogaXRlbS5tYW5pZmVzdC5hdXRob3I/Lm5hbWU7XG4gIHJldHVybiBub3JtYWxpemVUd2Vha3NQYWdlU2VhcmNoKFtcbiAgICBpdGVtLm1hbmlmZXN0Lm5hbWUsXG4gICAgaXRlbS5tYW5pZmVzdC5kZXNjcmlwdGlvbixcbiAgICBhdXRob3IsXG4gICAgaXRlbS5tYW5pZmVzdC5naXRodWJSZXBvLFxuICAgIGl0ZW0ubWFuaWZlc3QuaG9tZXBhZ2UsXG4gICAgaXRlbS5tYW5pZmVzdC52ZXJzaW9uLFxuICAgIC4uLihpdGVtLm1hbmlmZXN0LnRhZ3MgPz8gW10pLFxuICAgIGl0ZW0uc3RhdHVzLFxuICAgIGl0ZW0uZW5hYmxlZCA/IFwiZW5hYmxlZFwiIDogXCJkaXNhYmxlZFwiLFxuICAgIGl0ZW0udXBkYXRlPy51cGRhdGVBdmFpbGFibGUgPyBcInVwZGF0ZSBhdmFpbGFibGVcIiA6IFwiXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlXG4gICAgLnRvTG9jYWxlTG93ZXJDYXNlKClcbiAgICAubm9ybWFsaXplKFwiTkZEXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUwMzAwLVxcdTAzNmZdL2csIFwiXCIpXG4gICAgLnJlcGxhY2UoL1tcXHUyMDE4XFx1MjAxOWBcXHUwMGI0XS9nLCBcIidcIilcbiAgICAucmVwbGFjZSgvXFxzKy9nLCBcIiBcIilcbiAgICAudHJpbSgpO1xufVxuIiwgImV4cG9ydCB0eXBlIEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSA9IFwiY2hhdGdwdFwiIHwgXCJ0d2Vha2Vyc1wiO1xuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSA9IFwic3RhYmxlXCIgfCBcImFscGhhXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyIHtcbiAgYXBwRXhwZXJpZW5jZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlO1xuICByZWxlYXNlUHJvZmlsZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZTtcbn1cblxuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbiA9IFwiY29uZmlybVwiIHwgXCJjYW5jZWxcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ0VmZmVjdHM8UmVjZWlwdD4ge1xuICBwcmVwYXJlKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogUHJvbWlzZTxSZWNlaXB0PjtcbiAgY29uZmlybShzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpciwgcmVjZWlwdDogUmVjZWlwdCk6IFByb21pc2U8RW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbj47XG4gIGNvbW1pdChyZWNlaXB0OiBSZWNlaXB0KTogUHJvbWlzZTx2b2lkPjtcbiAgY2FuY2VsKHJlY2VpcHQ6IFJlY2VpcHQpOiBQcm9taXNlPHZvaWQ+O1xufVxuXG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudENvbmZpZ1BoYXNlID1cbiAgfCBcImlkbGVcIlxuICB8IFwicHJlcGFyaW5nXCJcbiAgfCBcImF3YWl0aW5nLWNvbmZpcm1hdGlvblwiXG4gIHwgXCJjb21taXR0aW5nXCJcbiAgfCBcImNhbmNlbGxpbmdcIjtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90IHtcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcjtcbiAgcGVuZGluZzogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyO1xuICBoYXNQZW5kaW5nQ2hhbmdlczogYm9vbGVhbjtcbiAgYnVzeTogYm9vbGVhbjtcbiAgcGhhc2U6IEVudmlyb25tZW50Q29uZmlnUGhhc2U7XG4gIGVycm9yOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgdHlwZSBFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0PiA9XG4gIHwgeyBvdXRjb21lOiBcIm5vLWNoYW5nZVwiIHwgXCJidXN5XCIgfVxuICB8IHsgb3V0Y29tZTogXCJzdWJtaXR0ZWRcIiB8IFwiY2FuY2VsbGVkXCI7IHJlY2VpcHQ6IFJlY2VpcHQgfVxuICB8IHsgb3V0Y29tZTogXCJwcmVwYXJlLWZhaWxlZFwiOyBlcnJvcjogc3RyaW5nIH1cbiAgfCB7IG91dGNvbWU6IFwiY29uZmlybWF0aW9uLWZhaWxlZFwiIHwgXCJjb21taXQtZmFpbGVkXCIgfCBcImNhbmNlbC1mYWlsZWRcIjsgcmVjZWlwdDogUmVjZWlwdDsgZXJyb3I6IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxSZWNlaXB0PiB7XG4gIHJlYWRvbmx5IHNuYXBzaG90OiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90O1xuICBzZXRTZWxlY3RlZChzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IHZvaWQ7XG4gIHJlc3RvcmVQZW5kaW5nKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogdm9pZDtcbiAgc3RhZ2VBcHBFeHBlcmllbmNlKHZhbHVlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UpOiB2b2lkO1xuICBzdGFnZVJlbGVhc2VQcm9maWxlKHZhbHVlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlKTogdm9pZDtcbiAgY2xlYXJFcnJvcigpOiB2b2lkO1xuICBhcHBseUFuZFJlc3RhcnQoKTogUHJvbWlzZTxFbnZpcm9ubWVudEFwcGx5T3V0Y29tZTxSZWNlaXB0Pj47XG4gIHJlc3VtZVByZXBhcmVkKFxuICAgIHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLFxuICAgIHJlY2VpcHQ6IFJlY2VpcHQsXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlck9wdGlvbnMge1xuICBvbkNoYW5nZT86IChzbmFwc2hvdDogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCkgPT4gdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUVudmlyb25tZW50Q29uZmlnQ29udHJvbGxlcjxSZWNlaXB0PihcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcixcbiAgZWZmZWN0czogRW52aXJvbm1lbnRDb25maWdFZmZlY3RzPFJlY2VpcHQ+LFxuICBvcHRpb25zOiBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXJPcHRpb25zID0ge30sXG4pOiBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXI8UmVjZWlwdD4ge1xuICBsZXQgc2VsZWN0ZWRWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWQpO1xuICBsZXQgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3RlZCk7XG4gIGxldCBidXN5ID0gZmFsc2U7XG4gIGxldCBwaGFzZTogRW52aXJvbm1lbnRDb25maWdQaGFzZSA9IFwiaWRsZVwiO1xuICBsZXQgZXJyb3I6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IHJlYWRTbmFwc2hvdCA9ICgpOiBFbnZpcm9ubWVudENvbmZpZ1NuYXBzaG90ID0+ICh7XG4gICAgc2VsZWN0ZWQ6IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSksXG4gICAgcGVuZGluZzogY29weVNlbGVjdGlvbihwZW5kaW5nVmFsdWUpLFxuICAgIGhhc1BlbmRpbmdDaGFuZ2VzOiAhc2FtZVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlLCBwZW5kaW5nVmFsdWUpLFxuICAgIGJ1c3ksXG4gICAgcGhhc2UsXG4gICAgZXJyb3IsXG4gIH0pO1xuICBjb25zdCBwdWJsaXNoID0gKCk6IHZvaWQgPT4gb3B0aW9ucy5vbkNoYW5nZT8uKHJlYWRTbmFwc2hvdCgpKTtcbiAgY29uc3QgZmluaXNoV2l0aEVycm9yID0gKG5leHRQaGFzZTogRW52aXJvbm1lbnRDb25maWdQaGFzZSwgbmV4dEVycm9yOiB1bmtub3duKTogc3RyaW5nID0+IHtcbiAgICBlcnJvciA9IGVudmlyb25tZW50Q29uZmlnRXJyb3IobmV4dEVycm9yKTtcbiAgICBidXN5ID0gZmFsc2U7XG4gICAgcGhhc2UgPSBuZXh0UGhhc2U7XG4gICAgcHVibGlzaCgpO1xuICAgIHJldHVybiBlcnJvcjtcbiAgfTtcblxuICBjb25zdCBjb21wbGV0ZVByZXBhcmVkID0gYXN5bmMgKFxuICAgIHJlcXVlc3RlZDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLFxuICAgIHJlY2VpcHQ6IFJlY2VpcHQsXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+ID0+IHtcbiAgICBwaGFzZSA9IFwiYXdhaXRpbmctY29uZmlybWF0aW9uXCI7XG4gICAgcHVibGlzaCgpO1xuICAgIGxldCBkZWNpc2lvbjogRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbjtcbiAgICB0cnkge1xuICAgICAgZGVjaXNpb24gPSBhd2FpdCBlZmZlY3RzLmNvbmZpcm0oY29weVNlbGVjdGlvbihyZXF1ZXN0ZWQpLCByZWNlaXB0KTtcbiAgICB9IGNhdGNoIChjb25maXJtYXRpb25FcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb3V0Y29tZTogXCJjb25maXJtYXRpb24tZmFpbGVkXCIsXG4gICAgICAgIHJlY2VpcHQsXG4gICAgICAgIGVycm9yOiBmaW5pc2hXaXRoRXJyb3IoXCJpZGxlXCIsIGNvbmZpcm1hdGlvbkVycm9yKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKGRlY2lzaW9uID09PSBcImNhbmNlbFwiKSB7XG4gICAgICBwaGFzZSA9IFwiY2FuY2VsbGluZ1wiO1xuICAgICAgcHVibGlzaCgpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgZWZmZWN0cy5jYW5jZWwocmVjZWlwdCk7XG4gICAgICB9IGNhdGNoIChjYW5jZWxFcnJvcikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG91dGNvbWU6IFwiY2FuY2VsLWZhaWxlZFwiLFxuICAgICAgICAgIHJlY2VpcHQsXG4gICAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgY2FuY2VsRXJyb3IpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlKTtcbiAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgIHBoYXNlID0gXCJpZGxlXCI7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgICByZXR1cm4geyBvdXRjb21lOiBcImNhbmNlbGxlZFwiLCByZWNlaXB0IH07XG4gICAgfVxuXG4gICAgcGhhc2UgPSBcImNvbW1pdHRpbmdcIjtcbiAgICBwdWJsaXNoKCk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGVmZmVjdHMuY29tbWl0KHJlY2VpcHQpO1xuICAgIH0gY2F0Y2ggKGNvbW1pdEVycm9yKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvdXRjb21lOiBcImNvbW1pdC1mYWlsZWRcIixcbiAgICAgICAgcmVjZWlwdCxcbiAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgY29tbWl0RXJyb3IpLFxuICAgICAgfTtcbiAgICB9XG4gICAgYnVzeSA9IGZhbHNlO1xuICAgIHBoYXNlID0gXCJpZGxlXCI7XG4gICAgZXJyb3IgPSBudWxsO1xuICAgIHB1Ymxpc2goKTtcbiAgICByZXR1cm4geyBvdXRjb21lOiBcInN1Ym1pdHRlZFwiLCByZWNlaXB0IH07XG4gIH07XG5cbiAgcmV0dXJuIHtcbiAgICBnZXQgc25hcHNob3QoKTogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCB7XG4gICAgICByZXR1cm4gcmVhZFNuYXBzaG90KCk7XG4gICAgfSxcbiAgICBzZXRTZWxlY3RlZChzZWxlY3Rpb24pOiB2b2lkIHtcbiAgICAgIGNvbnN0IHBlbmRpbmdXYXNVbmNoYW5nZWQgPSBzYW1lU2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUsIHBlbmRpbmdWYWx1ZSk7XG4gICAgICBzZWxlY3RlZFZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgLy8gQSBzdGF0dXMgcmVmcmVzaCBtYXkgcmVzb2x2ZSBhZnRlciB0aGUgdXNlciBoYXMgc3RhZ2VkIG9uZSBoYWxmIG9mIHRoZVxuICAgICAgLy8gRW52aXJvbm1lbnQgcGFpci4gUmVmcmVzaCB0aGUgYXV0aG9yaXRhdGl2ZSBzZWxlY3Rpb24gd2l0aG91dCBlcmFzaW5nXG4gICAgICAvLyB0aGF0IG5ld2VyIGxvY2FsIGludGVudDsgb25seSBmb2xsb3cgdGhlIHNlbGVjdGVkIHZhbHVlIHdoaWxlIHRoZSBmb3JtXG4gICAgICAvLyBpdHNlbGYgaXMgc3RpbGwgcHJpc3RpbmUuXG4gICAgICBpZiAocGVuZGluZ1dhc1VuY2hhbmdlZCkgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgcmVzdG9yZVBlbmRpbmcoc2VsZWN0aW9uKTogdm9pZCB7XG4gICAgICBwZW5kaW5nVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbik7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBzdGFnZUFwcEV4cGVyaWVuY2UodmFsdWUpOiB2b2lkIHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBwZW5kaW5nVmFsdWUgPSB7IC4uLnBlbmRpbmdWYWx1ZSwgYXBwRXhwZXJpZW5jZTogdmFsdWUgfTtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIHN0YWdlUmVsZWFzZVByb2ZpbGUodmFsdWUpOiB2b2lkIHtcbiAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICBwZW5kaW5nVmFsdWUgPSB7IC4uLnBlbmRpbmdWYWx1ZSwgcmVsZWFzZVByb2ZpbGU6IHZhbHVlIH07XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBjbGVhckVycm9yKCk6IHZvaWQge1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgYXN5bmMgYXBwbHlBbmRSZXN0YXJ0KCk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm4geyBvdXRjb21lOiBcImJ1c3lcIiB9O1xuICAgICAgaWYgKHNhbWVTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSwgcGVuZGluZ1ZhbHVlKSkgcmV0dXJuIHsgb3V0Y29tZTogXCJuby1jaGFuZ2VcIiB9O1xuICAgICAgY29uc3QgcmVxdWVzdGVkID0gY29weVNlbGVjdGlvbihwZW5kaW5nVmFsdWUpO1xuICAgICAgYnVzeSA9IHRydWU7XG4gICAgICBwaGFzZSA9IFwicHJlcGFyaW5nXCI7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgICBsZXQgcmVjZWlwdDogUmVjZWlwdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlY2VpcHQgPSBhd2FpdCBlZmZlY3RzLnByZXBhcmUoY29weVNlbGVjdGlvbihyZXF1ZXN0ZWQpKTtcbiAgICAgIH0gY2F0Y2ggKHByZXBhcmVFcnJvcikge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIG91dGNvbWU6IFwicHJlcGFyZS1mYWlsZWRcIixcbiAgICAgICAgICBlcnJvcjogZmluaXNoV2l0aEVycm9yKFwiaWRsZVwiLCBwcmVwYXJlRXJyb3IpLFxuICAgICAgICB9O1xuICAgICAgfVxuICAgICAgcmV0dXJuIGNvbXBsZXRlUHJlcGFyZWQocmVxdWVzdGVkLCByZWNlaXB0KTtcbiAgICB9LFxuICAgIGFzeW5jIHJlc3VtZVByZXBhcmVkKHNlbGVjdGlvbiwgcmVjZWlwdCk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+IHtcbiAgICAgIGlmIChidXN5KSByZXR1cm4geyBvdXRjb21lOiBcImJ1c3lcIiB9O1xuICAgICAgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgYnVzeSA9IHRydWU7XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICByZXR1cm4gY29tcGxldGVQcmVwYXJlZChjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbiksIHJlY2VpcHQpO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIge1xuICByZXR1cm4ge1xuICAgIGFwcEV4cGVyaWVuY2U6IHNlbGVjdGlvbi5hcHBFeHBlcmllbmNlLFxuICAgIHJlbGVhc2VQcm9maWxlOiBzZWxlY3Rpb24ucmVsZWFzZVByb2ZpbGUsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNhbWVTZWxlY3Rpb24obGVmdDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyLCByaWdodDogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWZ0LmFwcEV4cGVyaWVuY2UgPT09IHJpZ2h0LmFwcEV4cGVyaWVuY2VcbiAgICAmJiBsZWZ0LnJlbGVhc2VQcm9maWxlID09PSByaWdodC5yZWxlYXNlUHJvZmlsZTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRDb25maWdFcnJvcihlcnJvcjogdW5rbm93bik6IHN0cmluZyB7XG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvciB8fCBcIlVua25vd24gZXJyb3JcIik7XG59XG5cbmV4cG9ydCB0eXBlIERlc2t0b3BVcGRhdGVTdGF0dXMgPVxuICB8IFwidXBkYXRlLWF2YWlsYWJsZVwiXG4gIHwgXCJjdXJyZW50XCJcbiAgfCBcInN0YWxlXCJcbiAgfCBcInVuYXZhaWxhYmxlXCJcbiAgfCBcImVycm9yXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBodW1hbml6ZUNvZGV4UGhhc2UodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5yZXBsYWNlKC9bLV9dL2csIFwiIFwiKS5yZXBsYWNlKC9cXGJcXHcvZywgKGxldHRlcikgPT4gbGV0dGVyLnRvVXBwZXJDYXNlKCkpO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb25UcmFuc2FjdGlvbiB7XG4gIHBoYXNlOiBzdHJpbmc7XG4gIHNhZmVPZmZpY2lhbE1vZGU/OiBib29sZWFuO1xuICByZXN1bWFibGU/OiBib29sZWFuO1xuICBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSWQ/OiBzdHJpbmcgfCBudWxsO1xuICBlcnJvcj86IHN0cmluZyB8IG51bGw7XG4gIGJsb2Nrc0xpZmVjeWNsZT86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbklucHV0IHtcbiAgYnVzeTogYm9vbGVhbjtcbiAgc3RhdHVzOiBEZXNrdG9wVXBkYXRlU3RhdHVzIHwgdW5kZWZpbmVkO1xuICB0cmFuc2FjdGlvbjogRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvblRyYW5zYWN0aW9uIHwgbnVsbDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uQWN0aW9uIHtcbiAga2luZDogXCJyZXN1bWVcIiB8IFwiY2FuY2VsXCI7XG4gIGxhYmVsOiBcIlJlc3VtZVwiIHwgXCJDYW5jZWxcIjtcbiAgZGlzYWJsZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbiB7XG4gIHBoYXNlTGFiZWw6IHN0cmluZyB8IG51bGw7XG4gIHRvbmU6IFwib2tcIiB8IFwid2FyblwiIHwgXCJlcnJvclwiIHwgbnVsbDtcbiAgYWN0aW9uczogRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbkFjdGlvbltdO1xuICB1cGRhdGVEaXNhYmxlZDogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24oXG4gIGlucHV0OiBEZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uSW5wdXQsXG4pOiBEZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uIHtcbiAgY29uc3QgeyBidXN5LCBzdGF0dXMsIHRyYW5zYWN0aW9uIH0gPSBpbnB1dDtcbiAgY29uc3QgcGhhc2UgPSB0cmFuc2FjdGlvbj8ucGhhc2UgPz8gbnVsbDtcbiAgY29uc3QgcmVzdW1hYmxlID0gdHJhbnNhY3Rpb24/LnJlc3VtYWJsZSA9PT0gdHJ1ZTtcbiAgY29uc3QgaW5hY3RpdmUgPSBwaGFzZSA9PT0gbnVsbCB8fCBwaGFzZSA9PT0gXCJpZGxlXCI7XG4gIGNvbnN0IHRlcm1pbmFsID0gcGhhc2UgPT09IFwiY29tcGxldGVkXCIgfHwgcGhhc2UgPT09IFwiZmFpbGVkXCIgfHwgcGhhc2UgPT09IFwicm9sbGVkX2JhY2tcIjtcbiAgY29uc3QgdW5zYWZlRmFpbHVyZSA9IHBoYXNlID09PSBcImZhaWxlZFwiICYmIHRyYW5zYWN0aW9uPy5zYWZlT2ZmaWNpYWxNb2RlICE9PSB0cnVlO1xuICBjb25zdCBibG9ja3NMaWZlY3ljbGUgPSB0cmFuc2FjdGlvbj8uYmxvY2tzTGlmZWN5Y2xlXG4gICAgPz8gKFxuICAgICAgIXRlcm1pbmFsXG4gICAgICB8fCByZXN1bWFibGVcbiAgICAgIHx8IChcbiAgICAgICAgcGhhc2UgPT09IFwiZmFpbGVkXCJcbiAgICAgICAgJiYgKFxuICAgICAgICAgIHRyYW5zYWN0aW9uPy5zYWZlT2ZmaWNpYWxNb2RlICE9PSB0cnVlXG4gICAgICAgICAgfHwgL1xcYnJvbGxiYWNrIGZhaWxlZFxcYi9pLnRlc3QodHJhbnNhY3Rpb24/LmVycm9yID8/IFwiXCIpXG4gICAgICAgIClcbiAgICAgIClcbiAgICApO1xuICBjb25zdCByZXRyeWFibGVVbnNhZmVSZWNvdmVyeSA9IHVuc2FmZUZhaWx1cmVcbiAgICAmJiB0eXBlb2YgdHJhbnNhY3Rpb24/LmVudmlyb25tZW50VHJhbnNhY3Rpb25JZCA9PT0gXCJzdHJpbmdcIjtcbiAgY29uc3QgYWN0aW9uczogRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbkFjdGlvbltdID0gW107XG4gIGlmIChyZXN1bWFibGUgJiYgKHBoYXNlID09PSBcImZhaWxlZFwiIHx8IHBoYXNlID09PSBcInJvbGxlZF9iYWNrXCIpKSB7XG4gICAgYWN0aW9ucy5wdXNoKHsga2luZDogXCJyZXN1bWVcIiwgbGFiZWw6IFwiUmVzdW1lXCIsIGRpc2FibGVkOiBidXN5IH0pO1xuICB9XG4gIGlmIChwaGFzZSA9PT0gXCJhd2FpdGluZ19uYXRpdmVfdXBkYXRlXCJcbiAgICB8fCAocmVzdW1hYmxlICYmIChwaGFzZSA9PT0gXCJmYWlsZWRcIiB8fCBwaGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiKSlcbiAgICB8fCByZXRyeWFibGVVbnNhZmVSZWNvdmVyeSkge1xuICAgIGFjdGlvbnMucHVzaCh7IGtpbmQ6IFwiY2FuY2VsXCIsIGxhYmVsOiBcIkNhbmNlbFwiLCBkaXNhYmxlZDogYnVzeSB9KTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHBoYXNlTGFiZWw6IHBoYXNlID09PSBudWxsID8gbnVsbCA6IGh1bWFuaXplQ29kZXhQaGFzZShwaGFzZSksXG4gICAgdG9uZTogcGhhc2UgPT09IG51bGxcbiAgICAgID8gbnVsbFxuICAgICAgOiBwaGFzZSA9PT0gXCJjb21wbGV0ZWRcIlxuICAgICAgICA/IFwib2tcIlxuICAgICAgICA6IHBoYXNlID09PSBcImZhaWxlZFwiICYmICFyZXN1bWFibGVcbiAgICAgICAgICA/IFwiZXJyb3JcIlxuICAgICAgICAgIDogXCJ3YXJuXCIsXG4gICAgYWN0aW9ucyxcbiAgICB1cGRhdGVEaXNhYmxlZDogYnVzeVxuICAgICAgfHwgc3RhdHVzICE9PSBcInVwZGF0ZS1hdmFpbGFibGVcIlxuICAgICAgfHwgKCFpbmFjdGl2ZSAmJiBibG9ja3NMaWZlY3ljbGUpLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcFVwZGF0ZVN0YXR1c1ByZXNlbnRhdGlvbihcbiAgc3RhdHVzOiBEZXNrdG9wVXBkYXRlU3RhdHVzIHwgdW5kZWZpbmVkLFxuKTogeyBsYWJlbDogc3RyaW5nOyB0b25lOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiB9IHtcbiAgc3dpdGNoIChzdGF0dXMpIHtcbiAgICBjYXNlIFwiY3VycmVudFwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiVXAgdG8gZGF0ZVwiLCB0b25lOiBcIm9rXCIgfTtcbiAgICBjYXNlIFwidXBkYXRlLWF2YWlsYWJsZVwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiVXBkYXRlIGF2YWlsYWJsZVwiLCB0b25lOiBcIndhcm5cIiB9O1xuICAgIGNhc2UgXCJlcnJvclwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiRXJyb3JcIiwgdG9uZTogXCJlcnJvclwiIH07XG4gICAgY2FzZSBcInN0YWxlXCI6XG4gICAgICByZXR1cm4geyBsYWJlbDogXCJTdGFsZVwiLCB0b25lOiBcIndhcm5cIiB9O1xuICAgIGNhc2UgXCJ1bmF2YWlsYWJsZVwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiVW5hdmFpbGFibGVcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiTm90IGNoZWNrZWRcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgfVxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50Rm9jdXNUYXJnZXQge1xuICByZWFkb25seSBpc0Nvbm5lY3RlZDogYm9vbGVhbjtcbiAgZm9jdXMoKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzKFxuICBvcGVuZXI6IEVudmlyb25tZW50Rm9jdXNUYXJnZXQgfCBudWxsLFxuICBmYWxsYmFjazogKCkgPT4gRW52aXJvbm1lbnRGb2N1c1RhcmdldCB8IG51bGwsXG4pOiBcIm9wZW5lclwiIHwgXCJmYWxsYmFja1wiIHwgXCJub25lXCIge1xuICBpZiAob3BlbmVyPy5pc0Nvbm5lY3RlZCkge1xuICAgIG9wZW5lci5mb2N1cygpO1xuICAgIHJldHVybiBcIm9wZW5lclwiO1xuICB9XG4gIGNvbnN0IHRhcmdldCA9IGZhbGxiYWNrKCk7XG4gIGlmICh0YXJnZXQ/LmlzQ29ubmVjdGVkKSB7XG4gICAgdGFyZ2V0LmZvY3VzKCk7XG4gICAgcmV0dXJuIFwiZmFsbGJhY2tcIjtcbiAgfVxuICByZXR1cm4gXCJub25lXCI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29uZmlnQ2FyZFVwZGF0ZVRva2VuIHtcbiAgcmVhZG9ubHkgY2FyZDogc3RyaW5nO1xuICByZWFkb25seSBnZW5lcmF0aW9uOiBudW1iZXI7XG59XG5cbi8qKlxuICogS2VlcHMgYXN5bmNocm9ub3VzIENvbmZpZyBjYXJkcyBpbmRlcGVuZGVudCB3aGlsZSByZWplY3RpbmcgYSBzdGFsZSByZXN1bHRcbiAqIGZyb20gYW4gb2xkZXIgcmVxdWVzdCBmb3IgdGhlIHNhbWUgY2FyZC5cbiAqL1xuZXhwb3J0IGNsYXNzIENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjxWYWx1ZT4ge1xuICByZWFkb25seSAjZ2VuZXJhdGlvbnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICByZWFkb25seSAjdmFsdWVzID0gbmV3IE1hcDxzdHJpbmcsIFZhbHVlPigpO1xuXG4gIGJlZ2luKGNhcmQ6IHN0cmluZyk6IENvbmZpZ0NhcmRVcGRhdGVUb2tlbiB7XG4gICAgY29uc3QgZ2VuZXJhdGlvbiA9ICh0aGlzLiNnZW5lcmF0aW9ucy5nZXQoY2FyZCkgPz8gMCkgKyAxO1xuICAgIHRoaXMuI2dlbmVyYXRpb25zLnNldChjYXJkLCBnZW5lcmF0aW9uKTtcbiAgICByZXR1cm4gT2JqZWN0LmZyZWV6ZSh7IGNhcmQsIGdlbmVyYXRpb24gfSk7XG4gIH1cblxuICBjb21wbGV0ZSh0b2tlbjogQ29uZmlnQ2FyZFVwZGF0ZVRva2VuLCB2YWx1ZTogVmFsdWUpOiBib29sZWFuIHtcbiAgICBpZiAoIXRoaXMuaXNDdXJyZW50KHRva2VuKSkgcmV0dXJuIGZhbHNlO1xuICAgIHRoaXMuI3ZhbHVlcy5zZXQodG9rZW4uY2FyZCwgdmFsdWUpO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgaXNDdXJyZW50KHRva2VuOiBDb25maWdDYXJkVXBkYXRlVG9rZW4pOiBib29sZWFuIHtcbiAgICByZXR1cm4gdGhpcy4jZ2VuZXJhdGlvbnMuZ2V0KHRva2VuLmNhcmQpID09PSB0b2tlbi5nZW5lcmF0aW9uO1xuICB9XG5cbiAgaW52YWxpZGF0ZShjYXJkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLiNnZW5lcmF0aW9ucy5zZXQoY2FyZCwgKHRoaXMuI2dlbmVyYXRpb25zLmdldChjYXJkKSA/PyAwKSArIDEpO1xuICB9XG5cbiAgdmFsdWUoY2FyZDogc3RyaW5nKTogVmFsdWUgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLiN2YWx1ZXMuZ2V0KGNhcmQpO1xuICB9XG5cbiAgc25hcHNob3QoKTogUmVjb3JkPHN0cmluZywgVmFsdWU+IHtcbiAgICByZXR1cm4gT2JqZWN0LmZyb21FbnRyaWVzKHRoaXMuI3ZhbHVlcyk7XG4gIH1cbn1cbiIsICIvKipcbiAqIFJlbmRlcmVyLXNpZGUgdHdlYWsgaG9zdC4gV2U6XG4gKiAgIDEuIEFzayBtYWluIGZvciB0aGUgdHdlYWsgbGlzdCAod2l0aCByZXNvbHZlZCBlbnRyeSBwYXRoKS5cbiAqICAgMi4gRm9yIGVhY2ggcmVuZGVyZXItc2NvcGVkIChvciBcImJvdGhcIikgdHdlYWssIGZldGNoIGl0cyBzb3VyY2UgdmlhIElQQ1xuICogICAgICBhbmQgZXhlY3V0ZSBpdCBhcyBhIENvbW1vbkpTLXNoYXBlZCBmdW5jdGlvbi5cbiAqICAgMy4gUHJvdmlkZSBpdCB0aGUgcmVuZGVyZXIgaGFsZiBvZiB0aGUgQVBJLlxuICpcbiAqIENvZGV4IHJ1bnMgdGhlIHJlbmRlcmVyIHdpdGggc2FuZGJveDogdHJ1ZSwgc28gTm9kZSdzIGByZXF1aXJlKClgIGlzXG4gKiByZXN0cmljdGVkIHRvIGEgdGlueSB3aGl0ZWxpc3QgKGVsZWN0cm9uICsgYSBmZXcgcG9seWZpbGxzKS4gVGhhdCBtZWFucyB3ZVxuICogY2Fubm90IGByZXF1aXJlKClgIGFyYml0cmFyeSB0d2VhayBmaWxlcyBmcm9tIGRpc2suIEluc3RlYWQgd2UgcHVsbCB0aGVcbiAqIHNvdXJjZSBzdHJpbmcgZnJvbSBtYWluIGFuZCBldmFsdWF0ZSBpdCB3aXRoIGBuZXcgRnVuY3Rpb25gIGluc2lkZSB0aGVcbiAqIHByZWxvYWQgY29udGV4dC4gVHdlYWsgYXV0aG9ycyB3aG8gbmVlZCBucG0gZGVwcyBtdXN0IGJ1bmRsZSB0aGVtIGluLlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNlY3Rpb24sIHJlZ2lzdGVyUGFnZSwgY2xlYXJTZWN0aW9ucywgc2V0TGlzdGVkVHdlYWtzLCB1cGRhdGVMaXN0ZWRUd2Vha0xpZmVjeWNsZSB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBmaWJlckZvck5vZGUgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgeyBob3N0VWlBcGkgfSBmcm9tIFwiLi9ob3N0LXN1cmZhY2VzXCI7XG5pbXBvcnQgeyBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUywgcnVuV2l0aFN0YXJ0dXBUaW1lb3V0IH0gZnJvbSBcIi4uL3R3ZWFrLWxpZmVjeWNsZVwiO1xuaW1wb3J0IHR5cGUgeyBUd2Vha0hlYWx0aFJlY29yZCwgVHdlYWtTdGF0dXMsIFR3ZWFrU3RvcmVFbnRyeSB9IGZyb20gXCIuLi90d2Vhay1zdG9yZVwiO1xuaW1wb3J0IHR5cGUge1xuICBDb2RleENkcFN0YXR1cyxcbiAgQ29kZXhDZHBUYXJnZXQsXG4gIENvZGV4UnVudGltZUNhcGFiaWxpdGllcyxcbiAgQ29kZXhSdW50aW1lSW5mbyxcbiAgQ29kZXhWaWV3UmVmLFxuICBDb2RleFdpbmRvd1JlZixcbiAgTmF0aXZlSGVscGVyTGF1bmNoT3B0aW9ucyxcbiAgTmF0aXZlSGVscGVyUmVmLFxuICBOYXRpdmVNb2R1bGVLaW5kLFxuICBOYXRpdmVNb2R1bGVMb2FkT3B0aW9ucyxcbiAgTmF0aXZlTW9kdWxlUmVmLFxuICBOYXRpdmVQYW5lbENyZWF0ZU9wdGlvbnMsXG4gIE5hdGl2ZVBhbmVsUmVmLFxuICBOYXRpdmVWaWV3QXR0YWNoT3B0aW9ucyxcbiAgTmF0aXZlVmlld1JlZixcbiAgVHdlYWtNYW5pZmVzdCxcbiAgVHdlYWtBcGksXG4gIFJlYWN0RmliZXJOb2RlLFxuICBUd2Vhayxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuaW1wb3J0IHsgY3JlYXRlUmVuZGVyZXJTdG9yYWdlIH0gZnJvbSBcIi4uL3JlbmRlcmVyLXN0b3JhZ2VcIjtcblxuaW50ZXJmYWNlIExpc3RlZFR3ZWFrIHtcbiAgbWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3Q7XG4gIGVudHJ5OiBzdHJpbmc7XG4gIGRpcjogc3RyaW5nO1xuICBlbnRyeUV4aXN0czogYm9vbGVhbjtcbiAgaW5zdGFsbGVkOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzdGF0dXM6IFR3ZWFrU3RhdHVzO1xuICBoZWFsdGg6IFR3ZWFrSGVhbHRoUmVjb3JkIHwgbnVsbDtcbiAgY2F0YWxvZzogVHdlYWtTdG9yZUVudHJ5IHwgbnVsbDtcbiAgdXBkYXRlOiB7XG4gICAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gICAgcmVwbzogc3RyaW5nO1xuICAgIGN1cnJlbnRWZXJzaW9uOiBzdHJpbmc7XG4gICAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgICBsYXRlc3RUYWc6IHN0cmluZyB8IG51bGw7XG4gICAgcmVsZWFzZVVybDogc3RyaW5nIHwgbnVsbDtcbiAgICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gICAgZXJyb3I/OiBzdHJpbmc7XG4gIH0gfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgVXNlclBhdGhzIHtcbiAgdXNlclJvb3Q6IHN0cmluZztcbiAgcnVudGltZURpcjogc3RyaW5nO1xuICB0d2Vha3NEaXI6IHN0cmluZztcbiAgbG9nRGlyOiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBFbGVjdHJvbkJyaWRnZSB7XG4gIGdldEJ1aWxkRmxhdm9yPzogKCkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgdXNlc093bEFwcFNoZWxsPzogKCkgPT4gYm9vbGVhbjtcbn1cblxuY29uc3QgbG9hZGVkID0gbmV3IE1hcDxzdHJpbmcsIHsgc3RvcD86ICgpID0+IHZvaWQgfT4oKTtcbmxldCBjYWNoZWRQYXRoczogVXNlclBhdGhzIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdGFydFR3ZWFrSG9zdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHdlYWtzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bGlzdC10d2Vha3NcIikpIGFzIExpc3RlZFR3ZWFrW107XG4gIGNvbnN0IHBhdGhzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dXNlci1wYXRoc1wiKSkgYXMgVXNlclBhdGhzO1xuICBjYWNoZWRQYXRocyA9IHBhdGhzO1xuICAvLyBQdXNoIHRoZSBsaXN0IHRvIHRoZSBzZXR0aW5ncyBpbmplY3RvciBzbyB0aGUgVHdlYWtzIHBhZ2UgY2FuIHJlbmRlclxuICAvLyBjYXJkcyBldmVuIGJlZm9yZSBhbnkgdHdlYWsncyBzdGFydCgpIHJ1bnMgKGFuZCBmb3IgZGlzYWJsZWQgdHdlYWtzXG4gIC8vIHRoYXQgd2UgbmV2ZXIgbG9hZCkuXG4gIHNldExpc3RlZFR3ZWFrcyh0d2Vha3MpO1xuICAvLyBTdGFzaCBmb3IgdGhlIHNldHRpbmdzIGluamVjdG9yJ3MgZW1wdHktc3RhdGUgbWVzc2FnZS5cbiAgKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgX190d2Vha2VyX3R3ZWFrc19kaXJfXz86IHN0cmluZyB9KS5fX3R3ZWFrZXJfdHdlYWtzX2Rpcl9fID1cbiAgICBwYXRocy50d2Vha3NEaXI7XG5cbiAgZm9yIChjb25zdCB0IG9mIHR3ZWFrcykge1xuICAgIGlmICh0Lm1hbmlmZXN0LnNjb3BlID09PSBcIm1haW5cIikge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImRpc2FibGVkXCIsIFwibWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCF0LmVudHJ5RXhpc3RzKSB7XG4gICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwiZGlzYWJsZWRcIiwgXCJtaXNzaW5nIGVudHJ5XCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghdC5lbmFibGVkKSB7XG4gICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIHQuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcInF1YXJhbnRpbmVkXCIgOiBcImRpc2FibGVkXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJzdGFydGluZ1wiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuV2l0aFN0YXJ0dXBUaW1lb3V0KFxuICAgICAgICAoKSA9PiBsb2FkVHdlYWsodCwgcGF0aHMpLFxuICAgICAgICBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyxcbiAgICAgICk7XG4gICAgICBpZiAocmVzdWx0LnN0YXR1cyA9PT0gXCJ0aW1lZF9vdXRcIikge1xuICAgICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwidGltZWRfb3V0XCIsIGBzdGFydHVwIGV4Y2VlZGVkICR7REVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVN9bXNgKTtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSB0d2VhayBzdGFydHVwIHRpbWVkIG91dDpcIiwgdC5tYW5pZmVzdC5pZCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwicmVhZHlcIik7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImZhaWxlZFwiLCBlKTtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbdHdlYWtlcl0gdHdlYWsgbG9hZCBmYWlsZWQ6XCIsIHQubWFuaWZlc3QuaWQsIGUpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICAgICAgICBcInR3ZWFrZXI6cHJlbG9hZC1sb2dcIixcbiAgICAgICAgICBcImVycm9yXCIsXG4gICAgICAgICAgXCJ0d2VhayBsb2FkIGZhaWxlZDogXCIgKyB0Lm1hbmlmZXN0LmlkICsgXCI6IFwiICsgU3RyaW5nKChlIGFzIEVycm9yKT8uc3RhY2sgPz8gZSksXG4gICAgICAgICk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgfVxuICB9XG5cbiAgY29uc29sZS5pbmZvKFxuICAgIGBbdHdlYWtlcl0gcmVuZGVyZXIgaG9zdCBsb2FkZWQgJHtsb2FkZWQuc2l6ZX0gdHdlYWsocyk6YCxcbiAgICBbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCIsXG4gICk7XG4gIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgXCJpbmZvXCIsXG4gICAgYHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOiAke1suLi5sb2FkZWQua2V5cygpXS5qb2luKFwiLCBcIikgfHwgXCIobm9uZSlcIn1gLFxuICApO1xufVxuXG5mdW5jdGlvbiBzZW5kTGlmZWN5Y2xlKFxuICBpZDogc3RyaW5nLFxuICBzdGF0dXM6IFwic3RhcnRpbmdcIiB8IFwicmVhZHlcIiB8IFwiZmFpbGVkXCIgfCBcInRpbWVkX291dFwiIHwgXCJkaXNhYmxlZFwiIHwgXCJxdWFyYW50aW5lZFwiLFxuICBlcnJvcj86IHVua25vd24sXG4pOiB2b2lkIHtcbiAgY29uc3QgcmVuZGVyZXJMaWZlY3ljbGUgPSBzdGF0dXMgPT09IFwiZGlzYWJsZWRcIiAmJiBlcnJvciA9PT0gXCJtaXNzaW5nIGVudHJ5XCIgPyBcImZhaWxlZFwiXG4gICAgOiBzdGF0dXMgPT09IFwic3RhcnRpbmdcIiA/IFwic3RhcnRpbmdcIlxuICAgIDogc3RhdHVzID09PSBcImZhaWxlZFwiID8gXCJmYWlsZWRcIlxuICAgIDogc3RhdHVzID09PSBcInRpbWVkX291dFwiID8gXCJ0aW1lZF9vdXRcIlxuICAgIDogc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcInF1YXJhbnRpbmVkXCJcbiAgICA6IFwiZW5hYmxlZFwiO1xuICB1cGRhdGVMaXN0ZWRUd2Vha0xpZmVjeWNsZShpZCwgcmVuZGVyZXJMaWZlY3ljbGUsIGVycm9yID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikpO1xuICB0cnkge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoXCJ0d2Vha2VyOnR3ZWFrLWxpZmVjeWNsZVwiLCB7XG4gICAgICBpZCxcbiAgICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICAgIHN0YXR1cyxcbiAgICAgIC4uLihlcnJvciA9PT0gdW5kZWZpbmVkID8ge30gOiB7IGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcikgfSksXG4gICAgfSk7XG4gIH0gY2F0Y2gge1xuICAgIC8vIExpZmVjeWNsZSB0ZWxlbWV0cnkgbXVzdCBuZXZlciB0YWtlIGRvd24gdGhlIHJlbmRlcmVyIGhvc3QuXG4gIH1cbn1cblxuLyoqXG4gKiBTdG9wIGV2ZXJ5IHJlbmRlcmVyLXNjb3BlIHR3ZWFrIHNvIGEgc3Vic2VxdWVudCBgc3RhcnRUd2Vha0hvc3QoKWAgd2lsbFxuICogcmUtZXZhbHVhdGUgZnJlc2ggc291cmNlLiBNb2R1bGUgY2FjaGUgaXNuJ3QgcmVsZXZhbnQgc2luY2Ugd2UgZXZhbFxuICogc291cmNlIHN0cmluZ3MgZGlyZWN0bHkgXHUyMDE0IGVhY2ggbG9hZCBjcmVhdGVzIGEgZnJlc2ggc2NvcGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0ZWFyZG93blR3ZWFrSG9zdCgpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBbaWQsIHRdIG9mIGxvYWRlZCkge1xuICAgIHRyeSB7XG4gICAgICB0LnN0b3A/LigpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIlt0d2Vha2VyXSB0d2VhayBzdG9wIGZhaWxlZDpcIiwgaWQsIGUpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1kaXNwb3NlLXR3ZWFrXCIsIGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWRpc3Bvc2UtdHdlYWtcIiwgaWQpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9XG4gIH1cbiAgbG9hZGVkLmNsZWFyKCk7XG4gIGNsZWFyU2VjdGlvbnMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFR3ZWFrKHQ6IExpc3RlZFR3ZWFrLCBwYXRoczogVXNlclBhdGhzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNvdXJjZSA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgXCJ0d2Vha2VyOnJlYWQtdHdlYWstc291cmNlXCIsXG4gICAgdC5lbnRyeSxcbiAgKSkgYXMgc3RyaW5nO1xuXG4gIC8vIEV2YWx1YXRlIGFzIENKUy1zaGFwZWQ6IHByb3ZpZGUgbW9kdWxlL2V4cG9ydHMvYXBpLiBUd2VhayBjb2RlIG1heSB1c2VcbiAgLy8gYG1vZHVsZS5leHBvcnRzID0geyBzdGFydCwgc3RvcCB9YCBvciBgZXhwb3J0cy5zdGFydCA9IC4uLmAgb3IgcHVyZSBFU01cbiAgLy8gZGVmYXVsdCBleHBvcnQgc2hhcGUgKHdlIGFjY2VwdCBib3RoKS5cbiAgY29uc3QgbW9kdWxlID0geyBleHBvcnRzOiB7fSBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWsgfTtcbiAgY29uc3QgZXhwb3J0cyA9IG1vZHVsZS5leHBvcnRzO1xuICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWltcGxpZWQtZXZhbCwgbm8tbmV3LWZ1bmNcbiAgY29uc3QgZm4gPSBuZXcgRnVuY3Rpb24oXG4gICAgXCJtb2R1bGVcIixcbiAgICBcImV4cG9ydHNcIixcbiAgICBcImNvbnNvbGVcIixcbiAgICBgJHtzb3VyY2V9XFxuLy8jIHNvdXJjZVVSTD10d2Vha2VyLXR3ZWFrOi8vJHtlbmNvZGVVUklDb21wb25lbnQodC5tYW5pZmVzdC5pZCl9LyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQuZW50cnkpfWAsXG4gICk7XG4gIGZuKG1vZHVsZSwgZXhwb3J0cywgY29uc29sZSk7XG4gIGNvbnN0IG1vZCA9IG1vZHVsZS5leHBvcnRzIGFzIHsgZGVmYXVsdD86IFR3ZWFrIH0gJiBUd2VhaztcbiAgY29uc3QgdHdlYWs6IFR3ZWFrID0gKG1vZCBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9KS5kZWZhdWx0ID8/IChtb2QgYXMgVHdlYWspO1xuICBpZiAodHlwZW9mIHR3ZWFrPy5zdGFydCAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGB0d2VhayAke3QubWFuaWZlc3QuaWR9IGhhcyBubyBzdGFydCgpYCk7XG4gIH1cbiAgY29uc3QgYXBpID0gbWFrZVJlbmRlcmVyQXBpKHQubWFuaWZlc3QsIHBhdGhzKTtcbiAgYXdhaXQgdHdlYWsuc3RhcnQoYXBpKTtcbiAgbG9hZGVkLnNldCh0Lm1hbmlmZXN0LmlkLCB7IHN0b3A6IHR3ZWFrLnN0b3A/LmJpbmQodHdlYWspIH0pO1xufVxuXG5mdW5jdGlvbiBtYWtlUmVuZGVyZXJBcGkobWFuaWZlc3Q6IFR3ZWFrTWFuaWZlc3QsIHBhdGhzOiBVc2VyUGF0aHMpOiBUd2Vha0FwaSB7XG4gIGNvbnN0IGlkID0gbWFuaWZlc3QuaWQ7XG4gIGNvbnN0IGxvZyA9IChsZXZlbDogXCJkZWJ1Z1wiIHwgXCJpbmZvXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiwgLi4uYTogdW5rbm93bltdKSA9PiB7XG4gICAgY29uc3QgY29uc29sZUZuID1cbiAgICAgIGxldmVsID09PSBcImRlYnVnXCIgPyBjb25zb2xlLmRlYnVnXG4gICAgICA6IGxldmVsID09PSBcIndhcm5cIiA/IGNvbnNvbGUud2FyblxuICAgICAgOiBsZXZlbCA9PT0gXCJlcnJvclwiID8gY29uc29sZS5lcnJvclxuICAgICAgOiBjb25zb2xlLmxvZztcbiAgICBjb25zb2xlRm4oYFt0d2Vha2VyXVske2lkfV1gLCAuLi5hKTtcbiAgICAvLyBBbHNvIG1pcnJvciB0byBtYWluJ3MgbG9nIGZpbGUgc28gd2UgY2FuIGRpYWdub3NlIHR3ZWFrIGJlaGF2aW9yXG4gICAgLy8gd2l0aG91dCBhdHRhY2hpbmcgRGV2VG9vbHMuIFN0cmluZ2lmeSBlYWNoIGFyZyBkZWZlbnNpdmVseS5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcGFydHMgPSBhLm1hcCgodikgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIHYgPT09IFwic3RyaW5nXCIpIHJldHVybiB2O1xuICAgICAgICBpZiAodiBpbnN0YW5jZW9mIEVycm9yKSByZXR1cm4gYCR7di5uYW1lfTogJHt2Lm1lc3NhZ2V9YDtcbiAgICAgICAgdHJ5IHsgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHYpOyB9IGNhdGNoIHsgcmV0dXJuIFN0cmluZyh2KTsgfVxuICAgICAgfSk7XG4gICAgICBpcGNSZW5kZXJlci5zZW5kKFxuICAgICAgICBcInR3ZWFrZXI6cHJlbG9hZC1sb2dcIixcbiAgICAgICAgbGV2ZWwsXG4gICAgICAgIGBbdHdlYWsgJHtpZH1dICR7cGFydHMuam9pbihcIiBcIil9YCxcbiAgICAgICk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBzd2FsbG93IFx1MjAxNCBuZXZlciBsZXQgbG9nZ2luZyBicmVhayBhIHR3ZWFrICovXG4gICAgfVxuICB9O1xuXG4gIHJldHVybiB7XG4gICAgbWFuaWZlc3QsXG4gICAgcHJvY2VzczogXCJyZW5kZXJlclwiLFxuICAgIGxvZzoge1xuICAgICAgZGVidWc6ICguLi5hKSA9PiBsb2coXCJkZWJ1Z1wiLCAuLi5hKSxcbiAgICAgIGluZm86ICguLi5hKSA9PiBsb2coXCJpbmZvXCIsIC4uLmEpLFxuICAgICAgd2FybjogKC4uLmEpID0+IGxvZyhcIndhcm5cIiwgLi4uYSksXG4gICAgICBlcnJvcjogKC4uLmEpID0+IGxvZyhcImVycm9yXCIsIC4uLmEpLFxuICAgIH0sXG4gICAgc3RvcmFnZTogcmVuZGVyZXJTdG9yYWdlKGlkKSxcbiAgICBzZXR0aW5nczoge1xuICAgICAgcmVnaXN0ZXI6IChzKSA9PiByZWdpc3RlclNlY3Rpb24oeyAuLi5zLCBpZDogYCR7aWR9OiR7cy5pZH1gIH0pLFxuICAgICAgcmVnaXN0ZXJQYWdlOiAocCkgPT5cbiAgICAgICAgcmVnaXN0ZXJQYWdlKGlkLCBtYW5pZmVzdCwgeyAuLi5wLCBpZDogYCR7aWR9OiR7cC5pZH1gIH0pLFxuICAgIH0sXG4gICAgcmVhY3Q6IHtcbiAgICAgIGdldEZpYmVyOiAobikgPT4gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbCxcbiAgICAgIGZpbmRPd25lckJ5TmFtZTogKG4sIG5hbWUpID0+IHtcbiAgICAgICAgbGV0IGYgPSBmaWJlckZvck5vZGUobikgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsO1xuICAgICAgICB3aGlsZSAoZikge1xuICAgICAgICAgIGNvbnN0IHQgPSBmLnR5cGUgYXMgeyBkaXNwbGF5TmFtZT86IHN0cmluZzsgbmFtZT86IHN0cmluZyB9IHwgbnVsbDtcbiAgICAgICAgICBpZiAodCAmJiAodC5kaXNwbGF5TmFtZSA9PT0gbmFtZSB8fCB0Lm5hbWUgPT09IG5hbWUpKSByZXR1cm4gZjtcbiAgICAgICAgICBmID0gZi5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9LFxuICAgICAgd2FpdEZvckVsZW1lbnQ6IChzZWwsIHRpbWVvdXRNcyA9IDUwMDApID0+XG4gICAgICAgIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Ioc2VsKTtcbiAgICAgICAgICBpZiAoZXhpc3RpbmcpIHJldHVybiByZXNvbHZlKGV4aXN0aW5nKTtcbiAgICAgICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyB0aW1lb3V0TXM7XG4gICAgICAgICAgY29uc3Qgb2JzID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgZWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgICBpZiAoZWwpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZShlbCk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKERhdGUubm93KCkgPiBkZWFkbGluZSkge1xuICAgICAgICAgICAgICBvYnMuZGlzY29ubmVjdCgpO1xuICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGB0aW1lb3V0IHdhaXRpbmcgZm9yICR7c2VsfWApKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgICBvYnMub2JzZXJ2ZShkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQsIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICAgICAgICB9KSxcbiAgICAgIGhvc3Q6IGhvc3RVaUFwaSxcbiAgICB9LFxuICAgIGlwYzoge1xuICAgICAgb246IChjLCBoKSA9PiB7XG4gICAgICAgIGNvbnN0IHdyYXBwZWQgPSAoX2U6IHVua25vd24sIC4uLmFyZ3M6IHVua25vd25bXSkgPT4gaCguLi5hcmdzKTtcbiAgICAgICAgaXBjUmVuZGVyZXIub24oYHR3ZWFrZXI6JHtpZH06JHtjfWAsIHdyYXBwZWQpO1xuICAgICAgICByZXR1cm4gKCkgPT4gaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoYHR3ZWFrZXI6JHtpZH06JHtjfWAsIHdyYXBwZWQpO1xuICAgICAgfSxcbiAgICAgIHNlbmQ6IChjLCAuLi5hcmdzKSA9PiBpcGNSZW5kZXJlci5zZW5kKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSxcbiAgICAgIGludm9rZTogPFQ+KGM6IHN0cmluZywgLi4uYXJnczogdW5rbm93bltdKSA9PiB7XG4gICAgICAgIGlmIChpZCA9PT0gXCJjby50d2Vha2Vycy50aHJlYWQtc3VtbWFyeS1wcm9maWxlc1wiICYmIGMgPT09IFwicHJvZmlsZXMucmVhZFwiKSB7XG4gICAgICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICAgIFwidHdlYWtlcjpjcm9zcy10d2Vhay1yZWFkXCIsXG4gICAgICAgICAgICBpZCxcbiAgICAgICAgICAgIFwiY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgICAgICAgICAgIFwicHJvZmlsZXMucmVhZFwiLFxuICAgICAgICAgICAgYXJnc1swXSxcbiAgICAgICAgICApIGFzIFByb21pc2U8VD47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGlkID09PSBcImNvLnR3ZWFrZXJzLmZvbGxvd3VwXCIgJiYgYyA9PT0gXCJwb2xpY3lcIikge1xuICAgICAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgICBcInR3ZWFrZXI6Y3Jvc3MtdHdlYWstcmVhZFwiLFxuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBcImNvLnR3ZWFrZXJzLnByb2plY3RzXCIsXG4gICAgICAgICAgICBcImZvbGxvd3VwLnBvbGljeS5yZWFkXCIsXG4gICAgICAgICAgICBhcmdzWzBdLFxuICAgICAgICAgICkgYXMgUHJvbWlzZTxUPjtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCAuLi5hcmdzKSBhcyBQcm9taXNlPFQ+O1xuICAgICAgfSxcbiAgICB9LFxuICAgIGZzOiByZW5kZXJlckZzKGlkLCBwYXRocyksXG4gICAgY29kZXg6IHJlbmRlcmVyQ29kZXhBcGkoaWQpLFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckNvZGV4QXBpKHR3ZWFrSWQ6IHN0cmluZyk6IE5vbk51bGxhYmxlPFR3ZWFrQXBpW1wiY29kZXhcIl0+IHtcbiAgcmV0dXJuIHtcbiAgICBydW50aW1lOiB7XG4gICAgICBnZXRJbmZvOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IGluZm8gPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXJ1bnRpbWUtaW5mb1wiKSBhcyBDb2RleFJ1bnRpbWVJbmZvO1xuICAgICAgICBjb25zdCBicmlkZ2UgPSByZW5kZXJlckVsZWN0cm9uQnJpZGdlKCk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgLi4uaW5mbyxcbiAgICAgICAgICBidWlsZEZsYXZvcjogYnJpZGdlPy5nZXRCdWlsZEZsYXZvcj8uKCkgPz8gaW5mby5idWlsZEZsYXZvcixcbiAgICAgICAgICB1c2VzT3dsQXBwU2hlbGw6IGJyaWRnZT8udXNlc093bEFwcFNoZWxsPy4oKSA/PyBpbmZvLnVzZXNPd2xBcHBTaGVsbCxcbiAgICAgICAgfTtcbiAgICAgIH0sXG4gICAgICBnZXRDYXBhYmlsaXRpZXM6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtcnVudGltZS1jYXBhYmlsaXRpZXNcIikgYXMgUHJvbWlzZTxDb2RleFJ1bnRpbWVDYXBhYmlsaXRpZXM+LFxuICAgIH0sXG4gICAgd2luZG93czoge1xuICAgICAgY3JlYXRlOiAob3B0aW9ucykgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctY3JlYXRlXCIsIG9wdGlvbnMpIGFzIFByb21pc2U8Q29kZXhXaW5kb3dSZWY+LFxuICAgICAgZ2V0UHJpbWFyeTogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctcHJpbWFyeVwiKSBhcyBQcm9taXNlPENvZGV4V2luZG93UmVmIHwgbnVsbD4sXG4gICAgICBmb2N1czogKHdpbmRvd0lkKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1mb2N1c1wiLCB3aW5kb3dJZCkgYXMgUHJvbWlzZTxib29sZWFuPixcbiAgICAgIHNob3c6ICh3aW5kb3dJZCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctc2hvd1wiLCB3aW5kb3dJZCkgYXMgUHJvbWlzZTxib29sZWFuPixcbiAgICB9LFxuICAgIHZpZXdzOiB7XG4gICAgICBjcmVhdGU6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6Y29kZXgtdmlldy1jcmVhdGVcIixcbiAgICAgICAgICB0d2Vha0lkLFxuICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICkgYXMgeyBpZDogc3RyaW5nOyB3ZWJDb250ZW50c0lkOiBudW1iZXI7IHBhcmVudFdpbmRvd0lkOiBudW1iZXIgfCBudWxsIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlckNvZGV4Vmlld1JlZih0d2Vha0lkLCByZWYuaWQsIHJlZi53ZWJDb250ZW50c0lkLCByZWYucGFyZW50V2luZG93SWQpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGNkcDoge1xuICAgICAgZ2V0U3RhdHVzOiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LWNkcC1zdGF0dXNcIikgYXMgUHJvbWlzZTxDb2RleENkcFN0YXR1cz4sXG4gICAgICBsaXN0VGFyZ2V0czogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC1jZHAtdGFyZ2V0c1wiKSBhcyBQcm9taXNlPENvZGV4Q2RwVGFyZ2V0W10+LFxuICAgIH0sXG4gICAgbmF0aXZlOiB7XG4gICAgICBsb2FkTW9kdWxlOiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1sb2FkLW1vZHVsZVwiLFxuICAgICAgICAgIHR3ZWFrSWQsXG4gICAgICAgICAgb3B0aW9ucyxcbiAgICAgICAgKSBhcyB7IGlkOiBzdHJpbmc7IGtpbmQ6IE5hdGl2ZU1vZHVsZUtpbmQgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlTW9kdWxlUmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLmtpbmQpO1xuICAgICAgfSxcbiAgICAgIGNyZWF0ZVBhbmVsOiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1jcmVhdGUtcGFuZWxcIixcbiAgICAgICAgICB0d2Vha0lkLFxuICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICkgYXMgeyBpZDogc3RyaW5nOyB3aW5kb3dJZDogbnVtYmVyIHwgbnVsbCB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVQYW5lbFJlZih0d2Vha0lkLCByZWYuaWQsIHJlZi53aW5kb3dJZCk7XG4gICAgICB9LFxuICAgICAgYXR0YWNoVmlldzogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpuYXRpdmUtYXR0YWNoLXZpZXdcIixcbiAgICAgICAgICB0d2Vha0lkLFxuICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICkgYXMgeyBpZDogc3RyaW5nIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZVZpZXdSZWYodHdlYWtJZCwgcmVmLmlkKTtcbiAgICAgIH0sXG4gICAgICBsYXVuY2hIZWxwZXI6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWxhdW5jaC1oZWxwZXJcIixcbiAgICAgICAgICB0d2Vha0lkLFxuICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICkgYXMgeyBpZDogc3RyaW5nOyBwaWQ6IG51bWJlciB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVIZWxwZXJSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYucGlkKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICByZWZyZXNoOiB7XG4gICAgICBnZXRTdGF0dXM6ICgpID0+IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LXJlZnJlc2gtc3RhdHVzXCIpLFxuICAgICAgc3RhcnQ6IChzb3VyY2UgPSBcInNtYXJ0XCIpID0+IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c3RhcnQtbG9jYWwtcmVmcmVzaFwiLCBzb3VyY2UpLFxuICAgICAgb25TdGF0dXNDaGFuZ2VkOiAobGlzdGVuZXIpID0+IHtcbiAgICAgICAgY29uc3QgaGFuZGxlciA9ICgpID0+IHsgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1yZWZyZXNoLXN0YXR1c1wiKS50aGVuKGxpc3RlbmVyKTsgfTtcbiAgICAgICAgaXBjUmVuZGVyZXIub24oXCJ0d2Vha2VyOnJlZnJlc2gtc3RhdHVzLWNoYW5nZWRcIiwgaGFuZGxlcik7XG4gICAgICAgIHJldHVybiAoKSA9PiBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6cmVmcmVzaC1zdGF0dXMtY2hhbmdlZFwiLCBoYW5kbGVyKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBjYXB0dXJlOiB7XG4gICAgICBnZXRQZXJtaXNzaW9uU3RhdHVzOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgICAgcmVxdWVzdEFjY2Vzc2liaWxpdHk6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgICBvcGVuUGVybWlzc2lvblNldHRpbmdzOiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgICAgY2FwdHVyZUZyb250bW9zdFdpbmRvdzogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGhvdGtleXM6IHtcbiAgICAgIHJlZ2lzdGVyQ2FwdHVyZUhvdGtleTogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguaG90a2V5cyBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIGNyZWF0ZUJyb3dzZXJWaWV3OiAoX29wdGlvbnMpID0+IHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jcmVhdGVCcm93c2VyVmlldyBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgIH0sXG4gICAgY3JlYXRlV2luZG93OiAob3B0aW9ucykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LWNyZWF0ZVwiLCBvcHRpb25zKSBhcyBQcm9taXNlPENvZGV4V2luZG93UmVmPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJDb2RleFZpZXdSZWYoXG4gIHR3ZWFrSWQ6IHN0cmluZyxcbiAgaWQ6IHN0cmluZyxcbiAgd2ViQ29udGVudHNJZDogbnVtYmVyLFxuICBwYXJlbnRXaW5kb3dJZDogbnVtYmVyIHwgbnVsbCxcbik6IENvZGV4Vmlld1JlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgd2ViQ29udGVudHNJZCxcbiAgICBwYXJlbnRXaW5kb3dJZCxcbiAgICBzZXRCb3VuZHM6IChib3VuZHMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzZXRCb3VuZHNcIiwgYm91bmRzKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHNldFZpc2libGU6ICh2aXNpYmxlKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwic2V0VmlzaWJsZVwiLCB2aXNpYmxlKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGJyaW5nVG9Gcm9udDogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImJyaW5nVG9Gcm9udFwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGxvYWRSb3V0ZTogKHJvdXRlLCBob3N0SWQpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJsb2FkUm91dGVcIiwgcm91dGUsIGhvc3RJZCkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBsb2FkVXJsOiAodXJsKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwibG9hZFVybFwiLCB1cmwpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgZGlzcG9zZTogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImRpc3Bvc2VcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVNb2R1bGVSZWYoXG4gIHR3ZWFrSWQ6IHN0cmluZyxcbiAgaWQ6IHN0cmluZyxcbiAga2luZDogTmF0aXZlTW9kdWxlS2luZCxcbik6IE5hdGl2ZU1vZHVsZVJlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAga2luZCxcbiAgICByZXF1ZXN0OiAobWV0aG9kLCBwYXlsb2FkLCB0aW1lb3V0TXMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIFwidHdlYWtlcjpuYXRpdmUtbW9kdWxlLXJlcXVlc3RcIixcbiAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgaWQsXG4gICAgICAgIG1ldGhvZCxcbiAgICAgICAgcGF5bG9hZCxcbiAgICAgICAgdGltZW91dE1zLFxuICAgICAgKSxcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtbW9kdWxlLWRpc3Bvc2VcIiwgdHdlYWtJZCwgaWQpIGFzIFByb21pc2U8dm9pZD4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyTmF0aXZlUGFuZWxSZWYodHdlYWtJZDogc3RyaW5nLCBpZDogc3RyaW5nLCB3aW5kb3dJZDogbnVtYmVyIHwgbnVsbCk6IE5hdGl2ZVBhbmVsUmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICB3aW5kb3dJZCxcbiAgICBzZXRCb3VuZHM6IChib3VuZHMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwicGFuZWxcIiwgaWQsIFwic2V0Qm91bmRzXCIsIGJvdW5kcykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBzaG93OiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInBhbmVsXCIsIGlkLCBcInNob3dcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBoaWRlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInBhbmVsXCIsIGlkLCBcImhpZGVcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBkaXNwb3NlOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInBhbmVsXCIsIGlkLCBcImRpc3Bvc2VcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVWaWV3UmVmKHR3ZWFrSWQ6IHN0cmluZywgaWQ6IHN0cmluZyk6IE5hdGl2ZVZpZXdSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHNldEJvdW5kczogKGJvdW5kcykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJ2aWV3XCIsIGlkLCBcInNldEJvdW5kc1wiLCBib3VuZHMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgc2V0VmlzaWJsZTogKHZpc2libGUpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwidmlld1wiLCBpZCwgXCJzZXRWaXNpYmxlXCIsIHZpc2libGUpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgZGlzcG9zZTogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJ2aWV3XCIsIGlkLCBcImRpc3Bvc2VcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJOYXRpdmVIZWxwZXJSZWYodHdlYWtJZDogc3RyaW5nLCBpZDogc3RyaW5nLCBwaWQ6IG51bWJlcik6IE5hdGl2ZUhlbHBlclJlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgcGlkLFxuICAgIHNlbmQ6IChtZXNzYWdlKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaGVscGVyLWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwic2VuZFwiLCBtZXNzYWdlKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHJlcXVlc3Q6IChtZXNzYWdlLCB0aW1lb3V0TXMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgIFwidHdlYWtlcjpuYXRpdmUtaGVscGVyLWNhbGxcIixcbiAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgaWQsXG4gICAgICAgIFwicmVxdWVzdFwiLFxuICAgICAgICBtZXNzYWdlLFxuICAgICAgICB0aW1lb3V0TXMsXG4gICAgICApLFxuICAgIHN0b3A6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1oZWxwZXItY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJzdG9wXCIpIGFzIFByb21pc2U8dm9pZD4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRWxlY3Ryb25CcmlkZ2UoKTogRWxlY3Ryb25CcmlkZ2UgfCBudWxsIHtcbiAgY29uc3QgdmFsdWUgPSAod2luZG93IGFzIHVua25vd24gYXMgeyBlbGVjdHJvbkJyaWRnZT86IHVua25vd24gfSkuZWxlY3Ryb25CcmlkZ2U7XG4gIHJldHVybiB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgPyB2YWx1ZSBhcyBFbGVjdHJvbkJyaWRnZSA6IG51bGw7XG59XG5cbmV4cG9ydCBjb25zdCByZW5kZXJlclN0b3JhZ2UgPSAoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZSA9IGxvY2FsU3RvcmFnZSkgPT4gY3JlYXRlUmVuZGVyZXJTdG9yYWdlKGlkLCBzdG9yYWdlKTtcblxuZnVuY3Rpb24gcmVuZGVyZXJGcyhpZDogc3RyaW5nLCBfcGF0aHM6IFVzZXJQYXRocykge1xuICAvLyBTYW5kYm94ZWQgcmVuZGVyZXIgY2FuJ3QgdXNlIE5vZGUgZnMgZGlyZWN0bHkgXHUyMDE0IHByb3h5IHRocm91Z2ggbWFpbiBJUEMuXG4gIHJldHVybiB7XG4gICAgZGF0YURpcjogYDxyZW1vdGU+L3R3ZWFrLWRhdGEvJHtpZH1gLFxuICAgIHJlYWQ6IChwOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnR3ZWFrLWZzXCIsIFwicmVhZFwiLCBpZCwgcCkgYXMgUHJvbWlzZTxzdHJpbmc+LFxuICAgIHdyaXRlOiAocDogc3RyaW5nLCBjOiBzdHJpbmcpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnR3ZWFrLWZzXCIsIFwid3JpdGVcIiwgaWQsIHAsIGMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgZXhpc3RzOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp0d2Vhay1mc1wiLCBcImV4aXN0c1wiLCBpZCwgcCkgYXMgUHJvbWlzZTxib29sZWFuPixcbiAgfTtcbn1cbiIsICJpbXBvcnQgeyBmaWJlckZvck5vZGUgfSBmcm9tIFwiLi9yZWFjdC1ob29rXCI7XG5pbXBvcnQgdHlwZSB7XG4gIEhvc3RQcm9qZWN0Q29udGV4dCxcbiAgSG9zdFN1cmZhY2VLaW5kLFxuICBIb3N0U3VyZmFjZU1hdGNoLFxuICBIb3N0U3VyZmFjZVNuYXBzaG90LFxuICBIb3N0VWlBcGksXG4gIFJlYWN0RmliZXJOb2RlLFxufSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5cbmNvbnN0IE1BWF9NQVRDSEVTID0gMTAwO1xuY29uc3QgbGlzdGVuZXJzID0gbmV3IFNldDx7IGtpbmRzOiBIb3N0U3VyZmFjZUtpbmRbXTsgbGlzdGVuZXI6IChzbmFwc2hvdHM6IEhvc3RTdXJmYWNlU25hcHNob3RbXSkgPT4gdm9pZCB9PigpO1xubGV0IHNoYXJlZE9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyIHwgbnVsbCA9IG51bGw7XG5sZXQgcGVuZGluZ0ZyYW1lOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxuY29uc3QgU0VMRUNUT1JTOiBSZWNvcmQ8RXhjbHVkZTxIb3N0U3VyZmFjZUtpbmQsIFwicHJvamVjdHNcIiB8IFwidGhyZWFkLWNvbnRleHRcIiB8IFwidXNhZ2VcIj4sIHN0cmluZz4gPSB7XG4gIFwiYXNzaXN0YW50LXR1cm5zXCI6ICdbZGF0YS10ZXN0aWQ9XCJjb252ZXJzYXRpb24tdHVyblwiXSwgW2RhdGEtdGVzdGlkKj1cImFzc2lzdGFudC1tZXNzYWdlXCIgaV0sIFtkYXRhLW1lc3NhZ2UtYXV0aG9yLXJvbGU9XCJhc3Npc3RhbnRcIl0sIFtkYXRhLXJvbGU9XCJhc3Npc3RhbnRcIl0nLFxuICBjb21wb3NlcjogJyNwcm9tcHQtdGV4dGFyZWEsIFtkYXRhLXRlc3RpZD1cImNvbXBvc2VyXCJdIHRleHRhcmVhLCBbZGF0YS10ZXN0aWQ9XCJjb21wb3NlclwiXSBbY29udGVudGVkaXRhYmxlPVwidHJ1ZVwiXSwgZm9ybSB0ZXh0YXJlYTpub3QoW2Rpc2FibGVkXSksIGZvcm0gW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0nLFxuICBcImNvbW1hbmQtbWVudVwiOiAnW2RhdGEtY29tbWFuZC1tZW51XSwgW2RhdGEtc2xhc2gtbWVudV0sIFtyb2xlPVwibGlzdGJveFwiXScsXG4gIFwiYWNjb3VudC1tZW51XCI6ICdbcm9sZT1cIm1lbnVcIl0sIFtyb2xlPVwiZGlhbG9nXCJdJyxcbiAgXCJzZXR0aW5ncy1yb3dzXCI6ICdbZGF0YS1zZXR0aW5ncy1yb3ddLCBbcm9sZT1cImxpc3RpdGVtXCJdLCBzZWN0aW9uID4gZGl2JyxcbiAgXCJ0aXRsZWJhci1jb250cm9sc1wiOiAnW2RhdGEtdGl0bGViYXItY29udHJvbF0sIFthcmlhLWxhYmVsPVwiSGlkZSBzaWRlYmFyXCJdLCBbYXJpYS1sYWJlbD1cIlNob3cgc2lkZWJhclwiXSwgW2FyaWEtbGFiZWw9XCJCYWNrXCJdLCBbYXJpYS1sYWJlbD1cIkZvcndhcmRcIl0sIFt0aXRsZT1cIkJhY2tcIl0sIFt0aXRsZT1cIkZvcndhcmRcIl0nLFxufTtcblxuZXhwb3J0IGNvbnN0IGhvc3RVaUFwaTogSG9zdFVpQXBpID0ge1xuICBxdWVyeTogcXVlcnlIb3N0U3VyZmFjZXMsXG4gIHNuYXBzaG90LFxuICBvYnNlcnZlLFxuICBnZXRBY3RpdmVQcm9qZWN0LFxuICBhdHRhY2hGaWxlcyxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBxdWVyeUhvc3RTdXJmYWNlcyhraW5kOiBIb3N0U3VyZmFjZUtpbmQpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBpZiAodHlwZW9mIGRvY3VtZW50ID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm4gW107XG4gIGlmIChraW5kID09PSBcInByb2plY3RzXCIpIHJldHVybiBwcm9qZWN0Um93cygpO1xuICBpZiAoa2luZCA9PT0gXCJ0aHJlYWQtY29udGV4dFwiKSByZXR1cm4gdGhyZWFkQ29udGV4dHMoKTtcbiAgaWYgKGtpbmQgPT09IFwidXNhZ2VcIikgcmV0dXJuIHVzYWdlU3VyZmFjZXMoKTtcbiAgY29uc3Qgc2VsZWN0b3IgPSBTRUxFQ1RPUlNba2luZF07XG4gIHJldHVybiB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKSlcbiAgICAuZmlsdGVyKChlbGVtZW50KSA9PiBzZW1hbnRpY0ZpbHRlcihraW5kLCBlbGVtZW50KSlcbiAgICAuc2xpY2UoMCwgTUFYX01BVENIRVMpXG4gICAgLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZCwgZWxlbWVudCwgY29uZmlkZW5jZTogY29uZmlkZW5jZUZvcihraW5kLCBlbGVtZW50KSwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIHNuYXBzaG90KGtpbmQ6IEhvc3RTdXJmYWNlS2luZCk6IEhvc3RTdXJmYWNlU25hcHNob3Qge1xuICBjb25zdCBtYXRjaGVzID0gcXVlcnlIb3N0U3VyZmFjZXMoa2luZCkuc2xpY2UoMCwgTUFYX01BVENIRVMpO1xuICByZXR1cm4geyBraW5kLCBjb3VudDogbWF0Y2hlcy5sZW5ndGgsIG1hdGNoZXMgfTtcbn1cblxuZnVuY3Rpb24gb2JzZXJ2ZShraW5kczogSG9zdFN1cmZhY2VLaW5kW10sIGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQpOiAoKSA9PiB2b2lkIHtcbiAgY29uc3QgZW50cnkgPSB7IGtpbmRzOiBbLi4ubmV3IFNldChraW5kcyldLCBsaXN0ZW5lciB9O1xuICBsaXN0ZW5lcnMuYWRkKGVudHJ5KTtcbiAgZW5zdXJlT2JzZXJ2ZXIoKTtcbiAgc2FmZWx5Tm90aWZ5KGVudHJ5LCBlbnRyeS5raW5kcy5tYXAoc25hcHNob3QpKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBsaXN0ZW5lcnMuZGVsZXRlKGVudHJ5KTtcbiAgICBpZiAoIWxpc3RlbmVycy5zaXplKSB7XG4gICAgICBzaGFyZWRPYnNlcnZlcj8uZGlzY29ubmVjdCgpO1xuICAgICAgc2hhcmVkT2JzZXJ2ZXIgPSBudWxsO1xuICAgICAgaWYgKHBlbmRpbmdGcmFtZSAhPT0gbnVsbCkgY2FuY2VsQW5pbWF0aW9uRnJhbWUocGVuZGluZ0ZyYW1lKTtcbiAgICAgIHBlbmRpbmdGcmFtZSA9IG51bGw7XG4gICAgfVxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnN1cmVPYnNlcnZlcigpOiB2b2lkIHtcbiAgaWYgKHNoYXJlZE9ic2VydmVyIHx8IHR5cGVvZiBNdXRhdGlvbk9ic2VydmVyID09PSBcInVuZGVmaW5lZFwiIHx8IHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuO1xuICBzaGFyZWRPYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpZiAocGVuZGluZ0ZyYW1lICE9PSBudWxsKSByZXR1cm47XG4gICAgcGVuZGluZ0ZyYW1lID0gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgIHBlbmRpbmdGcmFtZSA9IG51bGw7XG4gICAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIGxpc3RlbmVycykgc2FmZWx5Tm90aWZ5KGVudHJ5LCBlbnRyeS5raW5kcy5tYXAoc25hcHNob3QpKTtcbiAgICB9KTtcbiAgfSk7XG4gIHNoYXJlZE9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7XG4gICAgYXR0cmlidXRlczogdHJ1ZSxcbiAgICBhdHRyaWJ1dGVGaWx0ZXI6IFtcImFyaWEtbGFiZWxcIiwgXCJhcmlhLWN1cnJlbnRcIiwgXCJyb2xlXCIsIFwiZGF0YS10ZXN0aWRcIiwgXCJkYXRhLXByb2plY3QtaWRcIiwgXCJkYXRhLXByb2plY3QtbmFtZVwiLCBcImRhdGEtd29ya3NwYWNlLXBhdGhcIiwgXCJkYXRhLXVzYWdlLWxpbWl0LWtleVwiLCBcImRhdGEtdXNhZ2UtbGltaXRcIiwgXCJkaXNhYmxlZFwiXSxcbiAgICBjaGlsZExpc3Q6IHRydWUsXG4gICAgY2hhcmFjdGVyRGF0YTogdHJ1ZSxcbiAgICBzdWJ0cmVlOiB0cnVlLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZWx5Tm90aWZ5KGVudHJ5OiB7IGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQgfSwgc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pOiB2b2lkIHtcbiAgdHJ5IHsgZW50cnkubGlzdGVuZXIoc25hcHNob3RzKTsgfVxuICBjYXRjaCAoZXJyb3IpIHsgY29uc29sZS53YXJuKFwiW3R3ZWFrZXJdIGhvc3Qgc3VyZmFjZSBvYnNlcnZlciBmYWlsZWRcIiwgZXJyb3IpOyB9XG59XG5cbmZ1bmN0aW9uIHByb2plY3RSb3dzKCk6IEhvc3RTdXJmYWNlTWF0Y2hbXSB7XG4gIGNvbnN0IGNvbnRyb2xzID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnYnV0dG9uLCBhLCBbcm9sZT1cImJ1dHRvblwiXScpKTtcbiAgcmV0dXJuIGNvbnRyb2xzLmZpbHRlcigoZWxlbWVudCkgPT4ge1xuICAgIGNvbnN0IGxhYmVsID0gY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KTtcbiAgICBpZiAoIWxhYmVsIHx8IGxhYmVsLmxlbmd0aCA+IDEyMCB8fCAhZWxlbWVudC5xdWVyeVNlbGVjdG9yKFwic3ZnXCIpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIEJvb2xlYW4oZGlyZWN0UHJvamVjdElkZW50aXR5KGVsZW1lbnQpKTtcbiAgfSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHtcbiAgICBraW5kOiBcInByb2plY3RzXCIsXG4gICAgZWxlbWVudCxcbiAgICBjb25maWRlbmNlOiBcImhpZ2hcIixcbiAgICBsYWJlbDogY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KSxcbiAgfSkpO1xufVxuXG4vKipcbiAqIEEgcHJvamVjdCByb3cgbXVzdCBvd24gcHJvamVjdCBpZGVudGl0eSBpdHNlbGYuIFdhbGtpbmcgYW5jZXN0b3IgZmliZXJzIG1hZGVcbiAqIGV2ZXJ5IGNvbnRyb2wgcmVuZGVyZWQgaW5zaWRlIGEgcHJvamVjdCByb3V0ZSBpbmhlcml0IHByb2plY3QgY29udGV4dDogdGFza1xuICogcm93cyBhbmQgZXZlbiB0aGUgdGl0bGViYXIgbW9kZWwgcGlja2VyIHRoZW4gbG9va2VkIGxpa2UgcHJvamVjdCByb3dzLiBLZWVwXG4gKiB0aGlzIHNlYW0gZmFpbC1jbG9zZWQgc28gY29uc3VtZXJzIG5ldmVyIGRlY29yYXRlIHVucmVsYXRlZCBob3N0IGNvbnRyb2xzLlxuICovXG5mdW5jdGlvbiBkaXJlY3RQcm9qZWN0SWRlbnRpdHkoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB8IG51bGwge1xuICBmb3IgKGNvbnN0IGF0dHJpYnV0ZSBvZiBbXG4gICAgXCJkYXRhLWFwcC1hY3Rpb24tc2lkZWJhci1wcm9qZWN0LWlkXCIsXG4gICAgXCJkYXRhLXByb2plY3QtaWRcIixcbiAgICBcImRhdGEtcHJvamVjdC1uYW1lXCIsXG4gICAgXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIsXG4gICAgXCJkYXRhLXByb2plY3QtcGF0aFwiLFxuICBdKSB7XG4gICAgY29uc3QgdmFsdWUgPSBlbGVtZW50LmdldEF0dHJpYnV0ZShhdHRyaWJ1dGUpPy50cmltKCk7XG4gICAgaWYgKHZhbHVlKSByZXR1cm4gdmFsdWU7XG4gIH1cbiAgY29uc3QgcHJvcHMgPSAoZmliZXJGb3JOb2RlKGVsZW1lbnQpIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbCk/Lm1lbW9pemVkUHJvcHM7XG4gIHJldHVybiBwcm9wcyAmJiB0eXBlb2YgcHJvcHMgPT09IFwib2JqZWN0XCJcbiAgICA/IGZpcnN0U3RyaW5nKHByb3BzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBbXCJwcm9qZWN0SWRcIiwgXCJwcm9qZWN0TmFtZVwiLCBcIndvcmtzcGFjZVBhdGhcIiwgXCJwcm9qZWN0UGF0aFwiXSkgPz8gbnVsbFxuICAgIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gdGhyZWFkQ29udGV4dHMoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXByb2plY3QtaWRdLCBbZGF0YS13b3Jrc3BhY2UtcGF0aF0sIG1haW4sIFtyb2xlPVwibWFpblwiXScpKTtcbiAgcmV0dXJuIGNhbmRpZGF0ZXMuZmlsdGVyKChlbGVtZW50KSA9PiB7XG4gICAgaWYgKGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LWlkXCIpIHx8IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiKSkgcmV0dXJuIHRydWU7XG4gICAgY29uc3QgcHJvcHMgPSBmaWJlclByb3BzKGVsZW1lbnQpO1xuICAgIHJldHVybiBCb29sZWFuKGZpcnN0U3RyaW5nKHByb3BzLCBbXCJwcm9qZWN0SWRcIiwgXCJ3b3Jrc3BhY2VQYXRoXCIsIFwicHJvamVjdE5hbWVcIl0pKTtcbiAgfSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZDogXCJ0aHJlYWQtY29udGV4dFwiLCBlbGVtZW50LCBjb25maWRlbmNlOiBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1pZFwiKSA/IFwiaGlnaFwiIDogXCJtZWRpdW1cIiwgbGFiZWw6IGFjY2Vzc2libGVMYWJlbChlbGVtZW50KSB9KSk7XG59XG5cbmZ1bmN0aW9uIHVzYWdlU3VyZmFjZXMoKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgY29uc3QgZGlyZWN0ID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtdXNhZ2UtbGltaXQta2V5XSwgW2RhdGEtdXNhZ2UtbGltaXRdLCBbZGF0YS10ZXN0aWQqPVwidXNhZ2VcIiBpXSwgW2FyaWEtbGFiZWwqPVwidXNhZ2VcIiBpXSwgW2NsYXNzKj1cInVzYWdlXCIgaV0nKSk7XG4gIGNvbnN0IHRleHR1YWwgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwic2VjdGlvbiwgYXJ0aWNsZSwgW3JvbGU9J2xpc3RpdGVtJ11cIikpLmZpbHRlcigoZWxlbWVudCkgPT4gLyg/OnVzYWdlfGxpbWl0KS4qKD86cmVtYWluaW5nfHJlc2V0fHVzZWQpfCg/OnJlbWFpbmluZ3xyZXNldHx1c2VkKS4qKD86dXNhZ2V8bGltaXQpL2kudGVzdChjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpKSk7XG4gIHJldHVybiB1bmlxdWVFbGVtZW50cyhbLi4uZGlyZWN0LCAuLi50ZXh0dWFsXSkuc2xpY2UoMCwgTUFYX01BVENIRVMpLm1hcCgoZWxlbWVudCkgPT4gKHsga2luZDogXCJ1c2FnZVwiLCBlbGVtZW50LCBjb25maWRlbmNlOiBkaXJlY3QuaW5jbHVkZXMoZWxlbWVudCkgPyBcImhpZ2hcIiA6IFwibWVkaXVtXCIsIGxhYmVsOiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudCkgfSkpO1xufVxuXG5mdW5jdGlvbiBnZXRBY3RpdmVQcm9qZWN0KCk6IEhvc3RQcm9qZWN0Q29udGV4dCB8IG51bGwge1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHF1ZXJ5SG9zdFN1cmZhY2VzKFwidGhyZWFkLWNvbnRleHRcIikpIHtcbiAgICBjb25zdCBlbGVtZW50ID0gbWF0Y2guZWxlbWVudDtcbiAgICBjb25zdCBwcm9wcyA9IGZpYmVyUHJvcHMoZWxlbWVudCk7XG4gICAgY29uc3QgY29udGV4dCA9IHtcbiAgICAgIGlkOiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1pZFwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wicHJvamVjdElkXCIsIFwiaWRcIl0pLFxuICAgICAgbmFtZTogZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtbmFtZVwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wicHJvamVjdE5hbWVcIiwgXCJuYW1lXCJdKSxcbiAgICAgIHdvcmtzcGFjZVBhdGg6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiKSB8fCBmaXJzdFN0cmluZyhwcm9wcywgW1wid29ya3NwYWNlUGF0aFwiLCBcInByb2plY3RQYXRoXCIsIFwiY3dkXCJdKSxcbiAgICB9O1xuICAgIGlmIChjb250ZXh0LmlkIHx8IGNvbnRleHQubmFtZSB8fCBjb250ZXh0LndvcmtzcGFjZVBhdGgpIHJldHVybiBjb250ZXh0O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhdHRhY2hGaWxlcyhmaWxlczogQXJyYXk8eyBuYW1lOiBzdHJpbmc7IG1pbWVUeXBlOiBzdHJpbmc7IGRhdGFCYXNlNjQ6IHN0cmluZyB9Pik6IFByb21pc2U8eyBhY2NlcHRlZDogYm9vbGVhbjsgcmVhc29uOiBcImFjY2VwdGVkXCIgfCBcImNvbXBvc2VyLW1pc3NpbmdcIiB8IFwicGFzdGUtcmVqZWN0ZWRcIiB8IFwiYXR0YWNobWVudC10aW1lb3V0XCIgfT4ge1xuICBjb25zdCB0YXJnZXQgPSBxdWVyeUhvc3RTdXJmYWNlcyhcImNvbXBvc2VyXCIpWzBdPy5lbGVtZW50ID8/IG51bGw7XG4gIGlmICghdGFyZ2V0KSByZXR1cm4geyBhY2NlcHRlZDogZmFsc2UsIHJlYXNvbjogXCJjb21wb3Nlci1taXNzaW5nXCIgfTtcbiAgY29uc3QgcHJlcGFyZWQgPSBmaWxlcy5tYXAoKGZpbGUpID0+IHtcbiAgICBjb25zdCBieXRlcyA9IFVpbnQ4QXJyYXkuZnJvbShhdG9iKGZpbGUuZGF0YUJhc2U2NCksIChjaGFyKSA9PiBjaGFyLmNoYXJDb2RlQXQoMCkpO1xuICAgIHJldHVybiBuZXcgRmlsZShbYnl0ZXNdLCBzYWZlRmlsZU5hbWUoZmlsZS5uYW1lKSwgeyB0eXBlOiBmaWxlLm1pbWVUeXBlIHx8IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIgfSk7XG4gIH0pO1xuICBjb25zdCB0cmFuc2ZlciA9IG5ldyBEYXRhVHJhbnNmZXIoKTtcbiAgZm9yIChjb25zdCBmaWxlIG9mIHByZXBhcmVkKSB0cmFuc2Zlci5pdGVtcy5hZGQoZmlsZSk7XG4gIHRhcmdldC5kaXNwYXRjaEV2ZW50KG5ldyBEcmFnRXZlbnQoXCJkcm9wXCIsIHsgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZSwgZGF0YVRyYW5zZmVyOiB0cmFuc2ZlciB9KSk7XG4gIGNvbnN0IHBhc3RlID0gbmV3IENsaXBib2FyZEV2ZW50KFwicGFzdGVcIiwgeyBidWJibGVzOiB0cnVlLCBjYW5jZWxhYmxlOiB0cnVlLCBjbGlwYm9hcmREYXRhOiB0cmFuc2ZlciB9KTtcbiAgY29uc3QgYWNjZXB0ZWQgPSB0YXJnZXQuZGlzcGF0Y2hFdmVudChwYXN0ZSk7XG4gIHRhcmdldC5kaXNwYXRjaEV2ZW50KG5ldyBFdmVudChcImlucHV0XCIsIHsgYnViYmxlczogdHJ1ZSB9KSk7XG4gICh0YXJnZXQgYXMgSFRNTEVsZW1lbnQpLmZvY3VzPy4oKTtcbiAgcmV0dXJuIHsgYWNjZXB0ZWQ6IGFjY2VwdGVkICE9PSBmYWxzZSwgcmVhc29uOiBhY2NlcHRlZCA9PT0gZmFsc2UgPyBcInBhc3RlLXJlamVjdGVkXCIgOiBcImFjY2VwdGVkXCIgfTtcbn1cblxuZnVuY3Rpb24gc2FmZUZpbGVOYW1lKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gU3RyaW5nKHZhbHVlIHx8IFwiQXBwU2hvdFwiKS5yZXBsYWNlKC9bLzpcXFxcXFwwXFxyXFxuXS9nLCBcIi1cIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xuICByZXR1cm4gY2xlYW5lZC5zbGljZSgwLCAxNjApIHx8IFwiQXBwU2hvdFwiO1xufVxuXG5mdW5jdGlvbiBzZW1hbnRpY0ZpbHRlcihraW5kOiBIb3N0U3VyZmFjZUtpbmQsIGVsZW1lbnQ6IEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgdGV4dCA9IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCk7XG4gIGlmIChraW5kID09PSBcImFzc2lzdGFudC10dXJuc1wiKSB7XG4gICAgY29uc3Qgcm9sZSA9IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1tZXNzYWdlLWF1dGhvci1yb2xlXCIpIHx8IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1yb2xlXCIpO1xuICAgIHJldHVybiByb2xlID8gcm9sZS50b0xvd2VyQ2FzZSgpID09PSBcImFzc2lzdGFudFwiIDogL2Fzc2lzdGFudC1tZXNzYWdlL2kudGVzdChlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtdGVzdGlkXCIpIHx8IFwiXCIpO1xuICB9XG4gIGlmIChraW5kID09PSBcImFjY291bnQtbWVudVwiKSByZXR1cm4gL2FjY291bnR8c2V0dGluZ3N8bG9nXFxzKm91dC9pLnRlc3QodGV4dCk7XG4gIGlmIChraW5kID09PSBcInNldHRpbmdzLXJvd3NcIikgcmV0dXJuIHRleHQubGVuZ3RoID4gMDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmZ1bmN0aW9uIGNvbmZpZGVuY2VGb3Ioa2luZDogSG9zdFN1cmZhY2VLaW5kLCBlbGVtZW50OiBFbGVtZW50KTogSG9zdFN1cmZhY2VNYXRjaFtcImNvbmZpZGVuY2VcIl0ge1xuICBpZiAoZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXRlc3RpZFwiKSB8fCBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgfHwgZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJyb2xlXCIpKSByZXR1cm4gXCJoaWdoXCI7XG4gIHJldHVybiBraW5kID09PSBcImNvbXBvc2VyXCIgfHwga2luZCA9PT0gXCJ0aXRsZWJhci1jb250cm9sc1wiID8gXCJtZWRpdW1cIiA6IFwibG93XCI7XG59XG5cbmZ1bmN0aW9uIGZpYmVyUHJvcHMoZWxlbWVudDogRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGxldCBmaWJlciA9IGZpYmVyRm9yTm9kZShlbGVtZW50KSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGw7XG4gIGNvbnN0IG1lcmdlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgZm9yIChsZXQgZGVwdGggPSAwOyBmaWJlciAmJiBkZXB0aCA8IDIwOyBkZXB0aCArPSAxLCBmaWJlciA9IGZpYmVyLnJldHVybikge1xuICAgIGlmIChmaWJlci5tZW1vaXplZFByb3BzICYmIHR5cGVvZiBmaWJlci5tZW1vaXplZFByb3BzID09PSBcIm9iamVjdFwiKSBPYmplY3QuYXNzaWduKG1lcmdlZCwgZmliZXIubWVtb2l6ZWRQcm9wcyk7XG4gIH1cbiAgcmV0dXJuIE9iamVjdC5rZXlzKG1lcmdlZCkubGVuZ3RoID8gbWVyZ2VkIDogbnVsbDtcbn1cblxuZnVuY3Rpb24gZmlyc3RTdHJpbmcocHJvcHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCwga2V5czogc3RyaW5nW10pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAoIXByb3BzKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBxdWV1ZTogdW5rbm93bltdID0gW3Byb3BzXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8dW5rbm93bj4oKTtcbiAgZm9yIChsZXQgdmlzaXRlZCA9IDA7IHF1ZXVlLmxlbmd0aCAmJiB2aXNpdGVkIDwgODA7IHZpc2l0ZWQgKz0gMSkge1xuICAgIGNvbnN0IHZhbHVlID0gcXVldWUuc2hpZnQoKTtcbiAgICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIiB8fCBzZWVuLmhhcyh2YWx1ZSkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgICBmb3IgKGNvbnN0IFtrZXksIGl0ZW1dIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgaWYgKGtleXMuaW5jbHVkZXMoa2V5KSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJzdHJpbmdcIiAmJiBpdGVtLnRyaW0oKSkgcmV0dXJuIGl0ZW07XG4gICAgICBpZiAoaXRlbSAmJiB0eXBlb2YgaXRlbSA9PT0gXCJvYmplY3RcIikgcXVldWUucHVzaChpdGVtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdW5pcXVlRWxlbWVudHMoaW5wdXQ6IEl0ZXJhYmxlPEVsZW1lbnQ+IHwgQXJyYXlMaWtlPEVsZW1lbnQ+KTogRWxlbWVudFtdIHtcbiAgcmV0dXJuIFsuLi5uZXcgU2V0KEFycmF5LmZyb20oaW5wdXQpKV07XG59XG5cbmZ1bmN0aW9uIGFjY2Vzc2libGVMYWJlbChlbGVtZW50OiBFbGVtZW50KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fCBlbGVtZW50LmdldEF0dHJpYnV0ZShcInRpdGxlXCIpIHx8IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCkgfHwgdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0KHZhbHVlOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgcmV0dXJuIFN0cmluZyh2YWx1ZSB8fCBcIlwiKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKS50cmltKCk7XG59XG4iLCAiZXhwb3J0IHR5cGUgVHdlYWtTY29wZSA9IFwicmVuZGVyZXJcIiB8IFwibWFpblwiIHwgXCJib3RoXCI7XG5cbi8qKlxuICogTGlmZWN5Y2xlIHN0YXRlcyBhcmUgZGVsaWJlcmF0ZWx5IG1vcmUgZGV0YWlsZWQgdGhhbiB0aGUgdXNlci1mYWNpbmdcbiAqIGluc3RhbGxlZC9lbmFibGVkIHN0YXR1cy4gIEEgdHdlYWsgbWF5IGJlIHZpc2libGUgYXMgZW5hYmxlZCB3aGlsZSBpdHNcbiAqIGFzeW5jaHJvbm91cyBzdGFydCBpcyBzdGlsbCBpbiBmbGlnaHQsIG9yIGFzIGZhaWxlZCBhZnRlciBhbm90aGVyIHR3ZWFrXG4gKiBoYXMgYWxyZWFkeSByZWFjaGVkIHJlYWR5LlxuICovXG5leHBvcnQgY29uc3QgVFdFQUtfTElGRUNZQ0xFX1NUQVRVU0VTID0gW1xuICBcInN0YXJ0aW5nXCIsXG4gIFwicmVhZHlcIixcbiAgXCJmYWlsZWRcIixcbiAgXCJ0aW1lZF9vdXRcIixcbiAgXCJkaXNhYmxlZFwiLFxuICBcInF1YXJhbnRpbmVkXCIsXG5dIGFzIGNvbnN0O1xuZXhwb3J0IHR5cGUgVHdlYWtMaWZlY3ljbGVTdGF0dXMgPSAodHlwZW9mIFRXRUFLX0xJRkVDWUNMRV9TVEFUVVNFUylbbnVtYmVyXTtcbmV4cG9ydCB0eXBlIFR3ZWFrUHJvY2VzcyA9IFwibWFpblwiIHwgXCJyZW5kZXJlclwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlUmVjb3JkIHtcbiAgaWQ6IHN0cmluZztcbiAgcHJvY2VzczogVHdlYWtQcm9jZXNzO1xuICBzdGF0dXM6IFR3ZWFrTGlmZWN5Y2xlU3RhdHVzO1xuICBhdHRlbXB0SWQ6IHN0cmluZztcbiAgdXBkYXRlZEF0OiBzdHJpbmc7XG4gIHN0YXJ0ZWRBdD86IHN0cmluZztcbiAgZmluaXNoZWRBdD86IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIC8qKiBDb25zZWN1dGl2ZSBzdGFydHVwIGF0dGVtcHRzIGN1dCBzaG9ydCBieSBhIHByb2Nlc3MgZXhpdDsgcmVzZXQgYnkgYSBzdWNjZXNzZnVsIHJlYWR5LiAqL1xuICBpbnRlcnJ1cHRlZEF0dGVtcHRzPzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlQXR0ZW1wdCB7XG4gIGlkOiBzdHJpbmc7XG4gIHBpZD86IG51bWJlcjtcbiAgc3RhcnRlZEF0OiBzdHJpbmc7XG4gIGNvbXBsZXRlZEF0Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGN1cnJlbnRBdHRlbXB0OiBUd2Vha0xpZmVjeWNsZUF0dGVtcHQgfCBudWxsO1xuICByZWNvcmRzOiBSZWNvcmQ8c3RyaW5nLCBUd2Vha0xpZmVjeWNsZVJlY29yZD47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVUd2Vha0xpZmVjeWNsZUpvdXJuYWwoXG4gIGF0dGVtcHRJZCA9IGBhdHRlbXB0LSR7RGF0ZS5ub3coKX0tJHtNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyKX1gLFxuICBwaWQ/OiBudW1iZXIsXG4gIHN0YXJ0ZWRBdCA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbik6IFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCB7XG4gIHJldHVybiB7XG4gICAgc2NoZW1hVmVyc2lvbjogMSxcbiAgICBjdXJyZW50QXR0ZW1wdDogeyBpZDogYXR0ZW1wdElkLCBwaWQsIHN0YXJ0ZWRBdCB9LFxuICAgIHJlY29yZHM6IHt9LFxuICB9O1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSA1XzAwMDtcbmV4cG9ydCBjb25zdCBNSU5fVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TID0gMTAwO1xuZXhwb3J0IGNvbnN0IE1BWF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMgPSAzMF8wMDA7XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVUd2Vha1N0YXJ0dXBUaW1lb3V0TXModmFsdWU6IHVua25vd24pOiBudW1iZXIge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpKSB7XG4gICAgcmV0dXJuIERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TO1xuICB9XG4gIHJldHVybiBNYXRoLm1pbihcbiAgICBNQVhfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuICAgIE1hdGgubWF4KE1JTl9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsIE1hdGgucm91bmQodmFsdWUpKSxcbiAgKTtcbn1cblxuLyoqXG4gKiBSYWNlIGEgdHdlYWsncyBzdGFydHVwIHByb21pc2UgYWdhaW5zdCBhIGJvdW5kZWQgdGltZW91dC4gIFRoZSBvcmlnaW5hbFxuICogcHJvbWlzZSBpcyBvYnNlcnZlZCBhZnRlciB0aGUgdGltZW91dCBzbyBhIGxhdGUgcmVqZWN0aW9uIGNhbm5vdCBiZWNvbWUgYW5cbiAqIHVuaGFuZGxlZCByZWplY3Rpb24sIHdoaWxlIHRoZSBjYWxsZXIgaXMgZnJlZSB0byBjb250aW51ZSBsb2FkaW5nIHNpYmxpbmdcbiAqIHR3ZWFrcyBpbW1lZGlhdGVseS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdpdGhTdGFydHVwVGltZW91dDxUPihcbiAgdmFsdWU6IFByb21pc2VMaWtlPFQ+IHwgVCxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyxcbik6IFByb21pc2U8eyBzdGF0dXM6IFwicmVhZHlcIjsgdmFsdWU6IFQgfSB8IHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0+IHtcbiAgY29uc3Qgbm9ybWFsaXplZFRpbWVvdXRNcyA9IG5vcm1hbGl6ZVR3ZWFrU3RhcnR1cFRpbWVvdXRNcyh0aW1lb3V0TXMpO1xuICBsZXQgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBwcm9taXNlID0gUHJvbWlzZS5yZXNvbHZlKHZhbHVlKTtcbiAgY29uc3QgdGltZW91dCA9IG5ldyBQcm9taXNlPHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0+KChyZXNvbHZlKSA9PiB7XG4gICAgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUoeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfSksIG5vcm1hbGl6ZWRUaW1lb3V0TXMpO1xuICB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBQcm9taXNlLnJhY2UoW1xuICAgICAgcHJvbWlzZS50aGVuKChyZXNvbHZlZCkgPT4gKHsgc3RhdHVzOiBcInJlYWR5XCIgYXMgY29uc3QsIHZhbHVlOiByZXNvbHZlZCB9KSksXG4gICAgICB0aW1lb3V0LFxuICAgIF0pO1xuICAgIHJldHVybiByZXN1bHQ7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIC8vIEF0dGFjaCBhIHJlamVjdGlvbiBvYnNlcnZlciBldmVuIHdoZW4gdGltZW91dCB3b24uICBUaGlzIGludGVudGlvbmFsbHlcbiAgICAvLyBkb2VzIG5vdCBhd2FpdCB0aGUgbGF0ZSByZXN1bHQuXG4gICAgdm9pZCBwcm9taXNlLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIH1cbn1cblxuLyoqIENvbnZlbmllbmNlIGZvcm0gZm9yIGNhbGxlcnMgdGhhdCBoYXZlIGEgbGF6eSBzdGFydCBvcGVyYXRpb24uICovXG5leHBvcnQgZnVuY3Rpb24gcnVuV2l0aFN0YXJ0dXBUaW1lb3V0PFQ+KFxuICBzdGFydDogKCkgPT4gUHJvbWlzZUxpa2U8VD4gfCBULFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLFxuKTogUHJvbWlzZTx7IHN0YXR1czogXCJyZWFkeVwiOyB2YWx1ZTogVCB9IHwgeyBzdGF0dXM6IFwidGltZWRfb3V0XCIgfT4ge1xuICBsZXQgdmFsdWU6IFByb21pc2VMaWtlPFQ+IHwgVDtcbiAgdHJ5IHtcbiAgICB2YWx1ZSA9IHN0YXJ0KCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVqZWN0KGVycm9yKTtcbiAgfVxuICByZXR1cm4gd2l0aFN0YXJ0dXBUaW1lb3V0KHZhbHVlLCB0aW1lb3V0TXMpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbGlmZWN5Y2xlUmVjb3JkS2V5KHByb2Nlc3M6IFR3ZWFrUHJvY2VzcywgaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcm9jZXNzfToke2lkfWA7XG59XG5cbi8qKlxuICogQmluZCBhIG1haW4tcHJvY2VzcyB0d2VhaydzIGBzdG9wKClgIHRvIHRoZSB0d2VhayBvYmplY3Qgc28gY2xlYW51cCB0aGF0XG4gKiByZWxpZXMgb24gYHRoaXNgIChwZXItaW5zdGFuY2UgZGlzcG9zZXJzLCBJUEMgaGFuZGxlIHJlbW92ZXJzKSB3b3Jrcy4gVGhlXG4gKiByZW5kZXJlciBob3N0IGJpbmRzIHN0b3AgdGhlIHNhbWUgd2F5IChwcmVsb2FkL3R3ZWFrLWhvc3QudHMpOyB0aGUgbWFpblxuICogcnVudGltZSBoaXN0b3JpY2FsbHkgc3RvcmVkIGl0IHVuYm91bmQsIHNpbGVudGx5IGJyZWFraW5nIGB0aGlzYC1iYXNlZCBtYWluXG4gKiBjbGVhbnVwIGZvciBgc2NvcGU6IFwiYm90aFwiYCB0d2Vha3MgKGZvbGxvd3VwKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJpbmRNYWluVHdlYWtTdG9wPFQgZXh0ZW5kcyB7IHN0b3A/OiAoLi4uYXJnczogdW5rbm93bltdKSA9PiB1bmtub3duIH0+KFxuICB0d2VhazogVCB8IG51bGwgfCB1bmRlZmluZWQsXG4pOiBUW1wic3RvcFwiXSB8IHVuZGVmaW5lZCB7XG4gIGlmICghdHdlYWsgfHwgdHlwZW9mIHR3ZWFrLnN0b3AgIT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHR3ZWFrPy5zdG9wO1xuICByZXR1cm4gdHdlYWsuc3RvcC5iaW5kKHR3ZWFrKSBhcyBUW1wic3RvcFwiXTtcbn1cblxuLyoqXG4gKiBBIHdob2xlLWFwcCByZXN0YXJ0IHJhY2luZyB0aGUgc2VxdWVudGlhbCB0d2Vhay1sb2FkIGxvb3AgbGVhdmVzIGlubm9jZW50XG4gKiB0d2Vha3MgaW4gXCJzdGFydGluZ1wiOyBvbmx5IHJlcGVhdGVkIGludGVycnVwdGlvbnMgaW5kaWNhdGUgdGhlIHR3ZWFrIGl0c2VsZlxuICogaXMgaGFuZ2luZyBzdGFydHVwLiBPbmUgaW50ZXJydXB0aW9uIGlzIHRoZXJlZm9yZSByZXRyaWVkLCBub3QgcXVhcmFudGluZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBJTlRFUlJVUFRFRF9BVFRFTVBUU19CRUZPUkVfUVVBUkFOVElORSA9IDI7XG5cbi8qKlxuICogVHVybiBhIGpvdXJuYWwgZnJvbSBhIHByZXZpb3VzIHByb2Nlc3MgaW50byBleHBsaWNpdCByZWNvcmRzLiBPbmx5IHJlY29yZHNcbiAqIGZyb20gdGhlIHVuZmluaXNoZWQgY3VycmVudCBhdHRlbXB0IGFyZSBjaGFuZ2VkOyBoaXN0b3JpY2FsIHJlYWR5L2ZhaWxlZFxuICogcmVjb3JkcyByZW1haW4gYXZhaWxhYmxlIGZvciBkaWFnbm9zdGljcy4gQSBmaXJzdCBpbnRlcnJ1cHRpb24gYmVjb21lcyBhXG4gKiByZXRyeWFibGUgXCJmYWlsZWRcIjsgSU5URVJSVVBURURfQVRURU1QVFNfQkVGT1JFX1FVQVJBTlRJTkUgY29uc2VjdXRpdmVcbiAqIGludGVycnVwdGlvbnMgcXVhcmFudGluZSB0aGUgdHdlYWsuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWNvdmVySW50ZXJydXB0ZWRUd2Vha3MoXG4gIGpvdXJuYWw6IFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCxcbiAgbm93ID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuKTogVHdlYWtMaWZlY3ljbGVKb3VybmFsIHtcbiAgY29uc3QgY3VycmVudEF0dGVtcHQgPSBqb3VybmFsLmN1cnJlbnRBdHRlbXB0O1xuICBpZiAoIWN1cnJlbnRBdHRlbXB0IHx8IGN1cnJlbnRBdHRlbXB0LmNvbXBsZXRlZEF0KSByZXR1cm4gam91cm5hbDtcbiAgY29uc3QgcmVjb3JkcyA9IHsgLi4uam91cm5hbC5yZWNvcmRzIH07XG4gIGZvciAoY29uc3QgW2tleSwgcmVjb3JkXSBvZiBPYmplY3QuZW50cmllcyhyZWNvcmRzKSkge1xuICAgIGlmIChyZWNvcmQuYXR0ZW1wdElkICE9PSBjdXJyZW50QXR0ZW1wdC5pZCkgY29udGludWU7XG4gICAgaWYgKHJlY29yZC5zdGF0dXMgIT09IFwic3RhcnRpbmdcIikgY29udGludWU7XG4gICAgY29uc3QgaW50ZXJydXB0ZWRBdHRlbXB0cyA9IChyZWNvcmQuaW50ZXJydXB0ZWRBdHRlbXB0cyA/PyAwKSArIDE7XG4gICAgY29uc3QgcXVhcmFudGluZSA9IGludGVycnVwdGVkQXR0ZW1wdHMgPj0gSU5URVJSVVBURURfQVRURU1QVFNfQkVGT1JFX1FVQVJBTlRJTkU7XG4gICAgcmVjb3Jkc1trZXldID0ge1xuICAgICAgLi4ucmVjb3JkLFxuICAgICAgc3RhdHVzOiBxdWFyYW50aW5lID8gXCJxdWFyYW50aW5lZFwiIDogXCJmYWlsZWRcIixcbiAgICAgIGludGVycnVwdGVkQXR0ZW1wdHMsXG4gICAgICB1cGRhdGVkQXQ6IG5vdyxcbiAgICAgIGZpbmlzaGVkQXQ6IG5vdyxcbiAgICAgIGVycm9yOiByZWNvcmQuZXJyb3IgPz8gKHF1YXJhbnRpbmVcbiAgICAgICAgPyBgc3RhcnR1cCB3YXMgaW50ZXJydXB0ZWQgJHtpbnRlcnJ1cHRlZEF0dGVtcHRzfSB0aW1lcyBpbiBhIHJvd2BcbiAgICAgICAgOiBcInByZXZpb3VzIHN0YXJ0dXAgYXR0ZW1wdCB3YXMgaW50ZXJydXB0ZWQ7IHdpbGwgcmV0cnlcIiksXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyAuLi5qb3VybmFsLCBjdXJyZW50QXR0ZW1wdDogeyAuLi5jdXJyZW50QXR0ZW1wdCwgY29tcGxldGVkQXQ6IG5vdyB9LCByZWNvcmRzIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVsb2FkVHdlYWtzRGVwcyB7XG4gIGxvZ0luZm8obWVzc2FnZTogc3RyaW5nKTogdm9pZDtcbiAgc3RvcEFsbE1haW5Ud2Vha3MoKTogdm9pZDtcbiAgY2xlYXJUd2Vha01vZHVsZUNhY2hlKCk6IHZvaWQ7XG4gIGxvYWRBbGxNYWluVHdlYWtzKCk6IHZvaWQgfCBQcm9taXNlPHZvaWQ+O1xuICBicm9hZGNhc3RSZWxvYWQoKTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXRUd2Vha0VuYWJsZWRBbmRSZWxvYWREZXBzIGV4dGVuZHMgUmVsb2FkVHdlYWtzRGVwcyB7XG4gIHNldFR3ZWFrRW5hYmxlZChpZDogc3RyaW5nLCBlbmFibGVkOiBib29sZWFuKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzTWFpblByb2Nlc3NUd2Vha1Njb3BlKHNjb3BlOiBUd2Vha1Njb3BlIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBzY29wZSAhPT0gXCJyZW5kZXJlclwiO1xufVxuXG5sZXQgcmVsb2FkU2VxdWVuY2U6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRUd2Vha3NJbml0aWFsbHkoXG4gIGRlcHM6IFBpY2s8UmVsb2FkVHdlYWtzRGVwcywgXCJsb2FkQWxsTWFpblR3ZWFrc1wiPixcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBydW4gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgYXdhaXQgZGVwcy5sb2FkQWxsTWFpblR3ZWFrcygpO1xuICB9O1xuICBjb25zdCBvcGVyYXRpb24gPSByZWxvYWRTZXF1ZW5jZS50aGVuKHJ1biwgcnVuKTtcbiAgcmVsb2FkU2VxdWVuY2UgPSBvcGVyYXRpb24uY2F0Y2goKCkgPT4ge30pO1xuICByZXR1cm4gb3BlcmF0aW9uO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVsb2FkVHdlYWtzKHJlYXNvbjogc3RyaW5nLCBkZXBzOiBSZWxvYWRUd2Vha3NEZXBzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJ1biA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBkZXBzLmxvZ0luZm8oYHJlbG9hZGluZyB0d2Vha3MgKCR7cmVhc29ufSlgKTtcbiAgICBkZXBzLnN0b3BBbGxNYWluVHdlYWtzKCk7XG4gICAgZGVwcy5jbGVhclR3ZWFrTW9kdWxlQ2FjaGUoKTtcbiAgICBhd2FpdCBkZXBzLmxvYWRBbGxNYWluVHdlYWtzKCk7XG4gICAgZGVwcy5icm9hZGNhc3RSZWxvYWQoKTtcbiAgfTtcbiAgY29uc3Qgb3BlcmF0aW9uID0gcmVsb2FkU2VxdWVuY2UudGhlbihydW4sIHJ1bik7XG4gIHJlbG9hZFNlcXVlbmNlID0gb3BlcmF0aW9uLmNhdGNoKCgpID0+IHt9KTtcbiAgcmV0dXJuIG9wZXJhdGlvbjtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFR3ZWFrRW5hYmxlZEFuZFJlbG9hZChcbiAgaWQ6IHN0cmluZyxcbiAgZW5hYmxlZDogdW5rbm93bixcbiAgZGVwczogU2V0VHdlYWtFbmFibGVkQW5kUmVsb2FkRGVwcyxcbik6IFByb21pc2U8dHJ1ZT4ge1xuICBjb25zdCBub3JtYWxpemVkRW5hYmxlZCA9ICEhZW5hYmxlZDtcbiAgZGVwcy5zZXRUd2Vha0VuYWJsZWQoaWQsIG5vcm1hbGl6ZWRFbmFibGVkKTtcbiAgZGVwcy5sb2dJbmZvKGB0d2VhayAke2lkfSBlbmFibGVkPSR7bm9ybWFsaXplZEVuYWJsZWR9YCk7XG4gIGF3YWl0IHJlbG9hZFR3ZWFrcyhcImVuYWJsZWQtdG9nZ2xlXCIsIGRlcHMpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFN0b3JhZ2VMaWtlIHtcbiAgcmVhZG9ubHkgbGVuZ3RoOiBudW1iZXI7XG4gIGdldEl0ZW0oa2V5OiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsO1xuICBrZXkoaW5kZXg6IG51bWJlcik6IHN0cmluZyB8IG51bGw7XG4gIHNldEl0ZW0oa2V5OiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcpOiB2b2lkO1xuICByZW1vdmVJdGVtKGtleTogc3RyaW5nKTogdm9pZDtcbn1cblxuY29uc3QgQ1VSUkVOVF9JRF9QUkVGSVggPSBcImNvLnR3ZWFrZXJzLlwiO1xuY29uc3QgTEVHQUNZX1NUT1JBR0VfUFJFRklYID0gYCR7W1wiY29kZXhcIiwgXCJwcFwiXS5qb2luKFwiXCIpfTpzdG9yYWdlOmA7XG5jb25zdCBDVVJSRU5UX1NUT1JBR0VfUFJFRklYID0gXCJ0d2Vha2VyOnN0b3JhZ2U6XCI7XG5cbmZ1bmN0aW9uIHBhcnNlUmVjb3JkKHJhdzogc3RyaW5nIHwgbnVsbCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB7XG4gIGlmIChyYXcgPT09IG51bGwpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3KSBhcyB1bmtub3duO1xuICAgIHJldHVybiBwYXJzZWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJiAhQXJyYXkuaXNBcnJheShwYXJzZWQpXG4gICAgICA/IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPlxuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBkaXNjb3ZlckxlZ2FjeVB1Ymxpc2hlcktleShpZDogc3RyaW5nLCBzdG9yYWdlOiBTdG9yYWdlTGlrZSk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIWlkLnN0YXJ0c1dpdGgoQ1VSUkVOVF9JRF9QUkVGSVgpKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgc3VmZml4ID0gaWQuc2xpY2UoQ1VSUkVOVF9JRF9QUkVGSVgubGVuZ3RoKTtcbiAgaWYgKCFzdWZmaXgpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IHN1ZmZpeE1hcmtlciA9IGAuJHtzdWZmaXh9YDtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgc3RvcmFnZS5sZW5ndGg7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBrZXkgPSBzdG9yYWdlLmtleShpbmRleCk7XG4gICAgaWYgKCFrZXk/LnN0YXJ0c1dpdGgoTEVHQUNZX1NUT1JBR0VfUFJFRklYKSkgY29udGludWU7XG4gICAgY29uc3QgbGVnYWN5SWQgPSBrZXkuc2xpY2UoTEVHQUNZX1NUT1JBR0VfUFJFRklYLmxlbmd0aCk7XG4gICAgaWYgKFxuICAgICAgbGVnYWN5SWQgIT09IGlkXG4gICAgICAmJiBsZWdhY3lJZC5zdGFydHNXaXRoKFwiY28uXCIpXG4gICAgICAmJiBsZWdhY3lJZC5lbmRzV2l0aChzdWZmaXhNYXJrZXIpXG4gICAgICAmJiBsZWdhY3lJZC5zbGljZSgzLCAtc3VmZml4TWFya2VyLmxlbmd0aCkubGVuZ3RoID4gMFxuICAgICkge1xuICAgICAgY2FuZGlkYXRlcy5hZGQoa2V5KTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNhbmRpZGF0ZXMuc2l6ZSA9PT0gMSA/IFsuLi5jYW5kaWRhdGVzXVswXSA6IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVSZW5kZXJlclN0b3JhZ2UoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpIHtcbiAgY29uc3Qga2V5ID0gYCR7Q1VSUkVOVF9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IGxlZ2FjeUN1cnJlbnRJZEtleSA9IGAke0xFR0FDWV9TVE9SQUdFX1BSRUZJWH0ke2lkfWA7XG4gIGNvbnN0IHJlYWQgPSAoKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0oa2V5KSk7XG4gICAgY29uc3QgbGVnYWN5Q3VycmVudElkID0gcGFyc2VSZWNvcmQoc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeUN1cnJlbnRJZEtleSkpO1xuICAgIGNvbnN0IGxlZ2FjeVB1Ymxpc2hlcktleSA9IGRpc2NvdmVyTGVnYWN5UHVibGlzaGVyS2V5KGlkLCBzdG9yYWdlKTtcbiAgICBjb25zdCBsZWdhY3lQdWJsaXNoZXIgPSBsZWdhY3lQdWJsaXNoZXJLZXkgPT09IG51bGxcbiAgICAgID8gbnVsbFxuICAgICAgOiBwYXJzZVJlY29yZChzdG9yYWdlLmdldEl0ZW0obGVnYWN5UHVibGlzaGVyS2V5KSk7XG5cbiAgICBjb25zdCBsZWdhY3lLZXlzID0gW1xuICAgICAgbGVnYWN5Q3VycmVudElkID09PSBudWxsID8gbnVsbCA6IGxlZ2FjeUN1cnJlbnRJZEtleSxcbiAgICAgIGxlZ2FjeVB1Ymxpc2hlciA9PT0gbnVsbCA/IG51bGwgOiBsZWdhY3lQdWJsaXNoZXJLZXksXG4gICAgXS5maWx0ZXIoKGNhbmRpZGF0ZSk6IGNhbmRpZGF0ZSBpcyBzdHJpbmcgPT4gY2FuZGlkYXRlICE9PSBudWxsKTtcblxuICAgIGlmIChsZWdhY3lLZXlzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGN1cnJlbnQgPz8ge307XG5cbiAgICBjb25zdCBtZXJnZWQgPSB7XG4gICAgICAuLi4obGVnYWN5UHVibGlzaGVyID8/IHt9KSxcbiAgICAgIC4uLihsZWdhY3lDdXJyZW50SWQgPz8ge30pLFxuICAgICAgLi4uKGN1cnJlbnQgPz8ge30pLFxuICAgIH07XG4gICAgdHJ5IHtcbiAgICAgIHN0b3JhZ2Uuc2V0SXRlbShrZXksIEpTT04uc3RyaW5naWZ5KG1lcmdlZCkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIG1lcmdlZDtcbiAgICB9XG4gICAgZm9yIChjb25zdCBsZWdhY3lLZXkgb2YgbGVnYWN5S2V5cykgc3RvcmFnZS5yZW1vdmVJdGVtKGxlZ2FjeUtleSk7XG4gICAgcmV0dXJuIG1lcmdlZDtcbiAgfTtcbiAgY29uc3Qgd3JpdGUgPSAodmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA9PiBzdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICByZXR1cm4ge1xuICAgIGdldDogPFQ+KG5hbWU6IHN0cmluZywgZmFsbGJhY2s/OiBUKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgcmV0dXJuIG5hbWUgaW4gY3VycmVudCA/IChjdXJyZW50W25hbWVdIGFzIFQpIDogKGZhbGxiYWNrIGFzIFQpO1xuICAgIH0sXG4gICAgc2V0OiAobmFtZTogc3RyaW5nLCB2YWx1ZTogdW5rbm93bikgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGN1cnJlbnRbbmFtZV0gPSB2YWx1ZTtcbiAgICAgIHdyaXRlKGN1cnJlbnQpO1xuICAgIH0sXG4gICAgZGVsZXRlOiAobmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gcmVhZCgpO1xuICAgICAgZGVsZXRlIGN1cnJlbnRbbmFtZV07XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGFsbDogKCkgPT4gcmVhZCgpLFxuICB9O1xufVxuIiwgIi8qKlxuICogQnVpbHQtaW4gXCJUd2VhayBNYW5hZ2VyXCIgXHUyMDE0IGF1dG8taW5qZWN0ZWQgYnkgdGhlIHJ1bnRpbWUsIG5vdCBhIHVzZXIgdHdlYWsuXG4gKiBMaXN0cyBkaXNjb3ZlcmVkIHR3ZWFrcyB3aXRoIGVuYWJsZSB0b2dnbGVzLCBvcGVucyB0aGUgdHdlYWtzIGRpciwgbGlua3NcbiAqIHRvIGxvZ3MgYW5kIGNvbmZpZy4gTGl2ZXMgaW4gdGhlIHJlbmRlcmVyLlxuICpcbiAqIFRoaXMgaXMgaW52b2tlZCBmcm9tIHByZWxvYWQvaW5kZXgudHMgQUZURVIgdXNlciB0d2Vha3MgYXJlIGxvYWRlZCBzbyBpdFxuICogY2FuIHNob3cgdXAtdG8tZGF0ZSBzdGF0dXMuXG4gKi9cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNlY3Rpb24gfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbW91bnRNYW5hZ2VyKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB0d2Vha3MgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpsaXN0LXR3ZWFrc1wiKSkgYXMgQXJyYXk8e1xuICAgIG1hbmlmZXN0OiB7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nOyBkZXNjcmlwdGlvbj86IHN0cmluZyB9O1xuICAgIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICB9PjtcbiAgY29uc3QgcGF0aHMgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp1c2VyLXBhdGhzXCIpKSBhcyB7XG4gICAgdXNlclJvb3Q6IHN0cmluZztcbiAgICB0d2Vha3NEaXI6IHN0cmluZztcbiAgICBsb2dEaXI6IHN0cmluZztcbiAgfTtcblxuICByZWdpc3RlclNlY3Rpb24oe1xuICAgIGlkOiBcInR3ZWFrZXI6bWFuYWdlclwiLFxuICAgIHRpdGxlOiBcIlR3ZWFrIE1hbmFnZXJcIixcbiAgICBkZXNjcmlwdGlvbjogYCR7dHdlYWtzLmxlbmd0aH0gdHdlYWsocykgaW5zdGFsbGVkLiBVc2VyIGRpcjogJHtwYXRocy51c2VyUm9vdH1gLFxuICAgIHJlbmRlcihyb290KSB7XG4gICAgICByb290LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjhweDtcIjtcblxuICAgICAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBhY3Rpb25zLnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDtnYXA6OHB4O2ZsZXgtd3JhcDp3cmFwO1wiO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiB0d2Vha3MgZm9sZGVyXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXZlYWxcIiwgcGF0aHMudHdlYWtzRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiT3BlbiBsb2dzXCIsICgpID0+XG4gICAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXZlYWxcIiwgcGF0aHMubG9nRGlyKS5jYXRjaCgoKSA9PiB7fSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChcbiAgICAgICAgYnV0dG9uKFwiUmVsb2FkIHdpbmRvd1wiLCAoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSksXG4gICAgICApO1xuICAgICAgcm9vdC5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAgICAgaWYgKHR3ZWFrcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgY29uc3QgZW1wdHkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwicFwiKTtcbiAgICAgICAgZW1wdHkuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEzcHggc3lzdGVtLXVpO21hcmdpbjo4cHggMDtcIjtcbiAgICAgICAgZW1wdHkudGV4dENvbnRlbnQgPVxuICAgICAgICAgIFwiTm8gdXNlciB0d2Vha3MgeWV0LiBEcm9wIGEgZm9sZGVyIHdpdGggbWFuaWZlc3QuanNvbiArIGluZGV4LmpzIGludG8gdGhlIHR3ZWFrcyBkaXIsIHRoZW4gcmVsb2FkLlwiO1xuICAgICAgICByb290LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBsaXN0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInVsXCIpO1xuICAgICAgbGlzdC5zdHlsZS5jc3NUZXh0ID0gXCJsaXN0LXN0eWxlOm5vbmU7bWFyZ2luOjA7cGFkZGluZzowO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjZweDtcIjtcbiAgICAgIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICAgICAgY29uc3QgbGkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwibGlcIik7XG4gICAgICAgIGxpLnN0eWxlLmNzc1RleHQgPVxuICAgICAgICAgIFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjhweCAxMHB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLCMyYTJhMmEpO2JvcmRlci1yYWRpdXM6NnB4O1wiO1xuICAgICAgICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgbGVmdC5pbm5lckhUTUwgPSBgXG4gICAgICAgICAgPGRpdiBzdHlsZT1cImZvbnQ6NjAwIDEzcHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QubmFtZSl9IDxzcGFuIHN0eWxlPVwiY29sb3I6Izg4ODtmb250LXdlaWdodDo0MDA7XCI+diR7ZXNjYXBlKHQubWFuaWZlc3QudmVyc2lvbil9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI+JHtlc2NhcGUodC5tYW5pZmVzdC5kZXNjcmlwdGlvbiA/PyB0Lm1hbmlmZXN0LmlkKX08L2Rpdj5cbiAgICAgICAgYDtcbiAgICAgICAgY29uc3QgcmlnaHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICByaWdodC5zdHlsZS5jc3NUZXh0ID0gXCJjb2xvcjojODg4O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7XCI7XG4gICAgICAgIHJpZ2h0LnRleHRDb250ZW50ID0gdC5lbnRyeUV4aXN0cyA/IFwibG9hZGVkXCIgOiBcIm1pc3NpbmcgZW50cnlcIjtcbiAgICAgICAgbGkuYXBwZW5kKGxlZnQsIHJpZ2h0KTtcbiAgICAgICAgbGlzdC5hcHBlbmQobGkpO1xuICAgICAgfVxuICAgICAgcm9vdC5hcHBlbmQobGlzdCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbmNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBiID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYi50eXBlID0gXCJidXR0b25cIjtcbiAgYi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBiLnN0eWxlLmNzc1RleHQgPVxuICAgIFwicGFkZGluZzo2cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMzMzKTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOmluaGVyaXQ7Zm9udDoxMnB4IHN5c3RlbS11aTtjdXJzb3I6cG9pbnRlcjtcIjtcbiAgYi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25jbGljayk7XG4gIHJldHVybiBiO1xufVxuXG5mdW5jdGlvbiBlc2NhcGUoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZSgvWyY8PlwiJ10vZywgKGMpID0+XG4gICAgYyA9PT0gXCImXCJcbiAgICAgID8gXCImYW1wO1wiXG4gICAgICA6IGMgPT09IFwiPFwiXG4gICAgICAgID8gXCImbHQ7XCJcbiAgICAgICAgOiBjID09PSBcIj5cIlxuICAgICAgICAgID8gXCImZ3Q7XCJcbiAgICAgICAgICA6IGMgPT09ICdcIidcbiAgICAgICAgICAgID8gXCImcXVvdDtcIlxuICAgICAgICAgICAgOiBcIiYjMzk7XCIsXG4gICk7XG59XG4iLCAiaW1wb3J0IHsgaXBjUmVuZGVyZXIgfSBmcm9tIFwiZWxlY3Ryb25cIjtcbmltcG9ydCB7XG4gIGRlc2t0b3BVcGRhdGVJbmRpY2F0b3JJZGVudGl0eSxcbiAgc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3IsXG4gIHR5cGUgRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlLFxufSBmcm9tIFwiLi9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGVcIjtcblxuY29uc3QgVVBEQVRFX0NIQU5HRURfQ0hBTk5FTCA9IFwidHdlYWtlcjpjb2RleC1kZXNrdG9wLXVwZGF0ZS1jaGFuZ2VkXCI7XG5jb25zdCBJTkRJQ0FUT1JfQVRUUklCVVRFID0gXCJkYXRhLXR3ZWFrZXItZGVza3RvcC11cGRhdGUtaW5kaWNhdG9yXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBmaW5kRGVza3RvcFVwZGF0ZUZvb3Rlck1vdW50KHJvb3Q6IFBhcmVudE5vZGUgPSBkb2N1bWVudCk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIGNvbnN0IGFuY2hvcnMgPSBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJbYXJpYS1sYWJlbF1cIikpO1xuICBmb3IgKGNvbnN0IGFuY2hvciBvZiBhbmNob3JzKSB7XG4gICAgY29uc3QgbGFiZWwgPSBhbmNob3IuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKT8udHJpbSgpLnRvTG93ZXJDYXNlKCkgPz8gXCJcIjtcbiAgICBpZiAoIS8oc2V0dGluZ3N8YWNjb3VudHxwcm9maWxlfGhlbHApLy50ZXN0KGxhYmVsKSkgY29udGludWU7XG4gICAgbGV0IGNhbmRpZGF0ZTogSFRNTEVsZW1lbnQgfCBudWxsID0gYW5jaG9yO1xuICAgIGZvciAobGV0IGRlcHRoID0gMDsgY2FuZGlkYXRlICYmIGRlcHRoIDwgNjsgZGVwdGggKz0gMSkge1xuICAgICAgY29uc3Qgcm9sZSA9IGNhbmRpZGF0ZS5nZXRBdHRyaWJ1dGUoXCJyb2xlXCIpO1xuICAgICAgaWYgKGNhbmRpZGF0ZS5tYXRjaGVzKFwibmF2LCBhc2lkZSwgZm9vdGVyXCIpIHx8IHJvbGUgPT09IFwibmF2aWdhdGlvblwiIHx8IHJvbGUgPT09IFwiY29udGVudGluZm9cIikge1xuICAgICAgICByZXR1cm4gY2FuZGlkYXRlO1xuICAgICAgfVxuICAgICAgY2FuZGlkYXRlID0gY2FuZGlkYXRlLnBhcmVudEVsZW1lbnQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc3RhcnREZXNrdG9wVXBkYXRlSW5kaWNhdG9yKCk6ICgpID0+IHZvaWQge1xuICBsZXQgY3VycmVudDogRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGxldCBpbmRpY2F0b3I6IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YXJuaW5nVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHdhcm5lZElkZW50aXRpZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBjb25zdCByZW1vdmVJbmRpY2F0b3IgPSAoKTogdm9pZCA9PiB7XG4gICAgaW5kaWNhdG9yPy5yZW1vdmUoKTtcbiAgICBpbmRpY2F0b3IgPSBudWxsO1xuICAgIGlmICh3YXJuaW5nVGltZXIpIGNsZWFyVGltZW91dCh3YXJuaW5nVGltZXIpO1xuICAgIHdhcm5pbmdUaW1lciA9IG51bGw7XG4gIH07XG5cbiAgY29uc3Qgc2NoZWR1bGVNaXNzaW5nTW91bnRXYXJuaW5nID0gKGlkZW50aXR5OiBzdHJpbmcpOiB2b2lkID0+IHtcbiAgICBpZiAod2FybmluZ1RpbWVyIHx8IHdhcm5lZElkZW50aXRpZXMuaGFzKGlkZW50aXR5KSkgcmV0dXJuO1xuICAgIHdhcm5pbmdUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgd2FybmluZ1RpbWVyID0gbnVsbDtcbiAgICAgIGlmICghY3VycmVudCB8fCAhc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3IoY3VycmVudCkpIHJldHVybjtcbiAgICAgIGlmIChkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHkoY3VycmVudCkgIT09IGlkZW50aXR5IHx8IGZpbmREZXNrdG9wVXBkYXRlRm9vdGVyTW91bnQoKSkgcmV0dXJuO1xuICAgICAgd2FybmVkSWRlbnRpdGllcy5hZGQoaWRlbnRpdHkpO1xuICAgICAgY29uc29sZS53YXJuKGBbdHdlYWtlcl0gQ2hhdEdQVCB1cGRhdGUgJHtpZGVudGl0eX0gaXMgYXZhaWxhYmxlLCBidXQgbm8gc2VtYW50aWMgc2lkZWJhciBmb290ZXIgbW91bnQgcG9pbnQgd2FzIGZvdW5kLmApO1xuICAgIH0sIDNfMDAwKTtcbiAgfTtcblxuICBjb25zdCByZW5kZXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFzaG91bGRTaG93RGVza3RvcFVwZGF0ZUluZGljYXRvcihjdXJyZW50KSkge1xuICAgICAgcmVtb3ZlSW5kaWNhdG9yKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGNvbnN0IGlkZW50aXR5ID0gZGVza3RvcFVwZGF0ZUluZGljYXRvcklkZW50aXR5KGN1cnJlbnQhKTtcbiAgICBjb25zdCBtb3VudCA9IGZpbmREZXNrdG9wVXBkYXRlRm9vdGVyTW91bnQoKTtcbiAgICBpZiAoIW1vdW50KSB7XG4gICAgICBpbmRpY2F0b3I/LnJlbW92ZSgpO1xuICAgICAgaW5kaWNhdG9yID0gbnVsbDtcbiAgICAgIHNjaGVkdWxlTWlzc2luZ01vdW50V2FybmluZyhpZGVudGl0eSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh3YXJuaW5nVGltZXIpIGNsZWFyVGltZW91dCh3YXJuaW5nVGltZXIpO1xuICAgIHdhcm5pbmdUaW1lciA9IG51bGw7XG4gICAgaWYgKCFpbmRpY2F0b3IpIHtcbiAgICAgIGluZGljYXRvciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gICAgICBpbmRpY2F0b3IudHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgICBpbmRpY2F0b3Iuc2V0QXR0cmlidXRlKElORElDQVRPUl9BVFRSSUJVVEUsIFwidHJ1ZVwiKTtcbiAgICAgIGluZGljYXRvci5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2hhdEdQVCB1cGRhdGUgYXZhaWxhYmxlXCIpO1xuICAgICAgaW5kaWNhdG9yLnRleHRDb250ZW50ID0gXCJVcGRhdGVcIjtcbiAgICAgIE9iamVjdC5hc3NpZ24oaW5kaWNhdG9yLnN0eWxlLCB7XG4gICAgICAgIGFwcGVhcmFuY2U6IFwibm9uZVwiLFxuICAgICAgICBib3JkZXI6IFwiMXB4IHNvbGlkIGNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgMjQlLCB0cmFuc3BhcmVudClcIixcbiAgICAgICAgYm9yZGVyUmFkaXVzOiBcIjk5OTlweFwiLFxuICAgICAgICBiYWNrZ3JvdW5kOiBcImNvbG9yLW1peChpbiBzcmdiLCBjdXJyZW50Q29sb3IgMTAlLCB0cmFuc3BhcmVudClcIixcbiAgICAgICAgY29sb3I6IFwiaW5oZXJpdFwiLFxuICAgICAgICBjdXJzb3I6IFwicG9pbnRlclwiLFxuICAgICAgICBmb250OiBcImluaGVyaXRcIixcbiAgICAgICAgZm9udFNpemU6IFwiMTJweFwiLFxuICAgICAgICBmb250V2VpZ2h0OiBcIjYwMFwiLFxuICAgICAgICBtYXJnaW46IFwiNnB4IDEwcHhcIixcbiAgICAgICAgcGFkZGluZzogXCI1cHggMTBweFwiLFxuICAgICAgfSk7XG4gICAgICBpbmRpY2F0b3IuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgICAgaW5kaWNhdG9yIS5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjaGVjay1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgICAgIGlmIChpbmRpY2F0b3I/LmlzQ29ubmVjdGVkKSBpbmRpY2F0b3IuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpbmRpY2F0b3IudGl0bGUgPSBgQ2hhdEdQVCAke2N1cnJlbnQ/LmxhdGVzdD8ubWFya2V0aW5nVmVyc2lvbiA/PyBcInVwZGF0ZVwifSBpcyBhdmFpbGFibGVgO1xuICAgIGlmIChpbmRpY2F0b3IucGFyZW50RWxlbWVudCAhPT0gbW91bnQpIG1vdW50LmFwcGVuZENoaWxkKGluZGljYXRvcik7XG4gIH07XG5cbiAgY29uc3Qgb25DaGFuZ2VkID0gKF9ldmVudDogdW5rbm93biwgdmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBjdXJyZW50ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgRGVza3RvcFVwZGF0ZUluZGljYXRvclN0YXRlIDogbnVsbDtcbiAgICByZW5kZXIoKTtcbiAgfTtcbiAgaXBjUmVuZGVyZXIub24oVVBEQVRFX0NIQU5HRURfQ0hBTk5FTCwgb25DaGFuZ2VkKTtcblxuICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKHJlbmRlcik7XG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgIC50aGVuKCh2YWx1ZSkgPT4gb25DaGFuZ2VkKHVuZGVmaW5lZCwgdmFsdWUpKVxuICAgIC5jYXRjaCgoKSA9PiB7fSk7XG5cbiAgcmV0dXJuICgpID0+IHtcbiAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihVUERBVEVfQ0hBTkdFRF9DSEFOTkVMLCBvbkNoYW5nZWQpO1xuICAgIG9ic2VydmVyLmRpc2Nvbm5lY3QoKTtcbiAgICByZW1vdmVJbmRpY2F0b3IoKTtcbiAgfTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSB7XG4gIHN0YXR1cz86IHN0cmluZztcbiAgbGF0ZXN0PzogeyBtYXJrZXRpbmdWZXJzaW9uPzogc3RyaW5nIHwgbnVsbDsgYnVpbGQ/OiBzdHJpbmcgfCBudWxsIH07XG4gIG5hdGl2ZVVwZGF0ZUNvbnRyb2xBY3RpdmU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3Ioc3RhdGU6IERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSB8IG51bGwpOiBib29sZWFuIHtcbiAgcmV0dXJuIHN0YXRlPy5zdGF0dXMgPT09IFwidXBkYXRlLWF2YWlsYWJsZVwiICYmIHN0YXRlLm5hdGl2ZVVwZGF0ZUNvbnRyb2xBY3RpdmUgIT09IHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHkoc3RhdGU6IERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSk6IHN0cmluZyB7XG4gIHJldHVybiBbc3RhdGUubGF0ZXN0Py5tYXJrZXRpbmdWZXJzaW9uID8/IFwidW5rbm93blwiLCBzdGF0ZS5sYXRlc3Q/LmJ1aWxkID8/IFwidW5rbm93blwiXS5qb2luKFwiOlwiKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQVdBLElBQUFBLG1CQUE0Qjs7O0FDNkJyQixTQUFTLG1CQUF5QjtBQUN2QyxNQUFJLE9BQU8sK0JBQWdDO0FBQzNDLFFBQU0sWUFBWSxvQkFBSSxJQUErQjtBQUNyRCxNQUFJLFNBQVM7QUFDYixRQUFNQyxhQUFZLG9CQUFJLElBQTRDO0FBRWxFLFFBQU0sT0FBMEI7QUFBQSxJQUM5QixlQUFlO0FBQUEsSUFDZjtBQUFBLElBQ0EsT0FBTyxVQUFVO0FBQ2YsWUFBTSxLQUFLO0FBQ1gsZ0JBQVUsSUFBSSxJQUFJLFFBQVE7QUFFMUIsY0FBUTtBQUFBLFFBQ047QUFBQSxRQUNBLFNBQVM7QUFBQSxRQUNULFNBQVM7QUFBQSxNQUNYO0FBQ0EsYUFBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLEdBQUcsT0FBTyxJQUFJO0FBQ1osVUFBSSxJQUFJQSxXQUFVLElBQUksS0FBSztBQUMzQixVQUFJLENBQUMsRUFBRyxDQUFBQSxXQUFVLElBQUksT0FBUSxJQUFJLG9CQUFJLElBQUksQ0FBRTtBQUM1QyxRQUFFLElBQUksRUFBRTtBQUFBLElBQ1Y7QUFBQSxJQUNB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LEdBQUcsNEJBQTRCLFFBQVEsR0FBRyxRQUFRO0FBQzlELFNBQU87QUFDVDtBQUVBLFNBQVMsbUNBQ1AsVUFDQSxpQkFDUztBQUNULFFBQU0sV0FBVyxnQkFBZ0IsSUFBSSxRQUFRO0FBQzdDLE1BQUksQ0FBQyxTQUFVLFFBQU87QUFDdEIsa0JBQWdCLE9BQU8sUUFBUTtBQUMvQiwrQkFBWSxlQUFlLDRCQUE0QixRQUFRLEdBQUcsUUFBUTtBQUMxRSxTQUFPO0FBQ1Q7IiwKICAibmFtZXMiOiBbImltcG9ydF9lbGVjdHJvbiIsICJsaXN0ZW5lcnMiLCAiYnV0dG9uIiwgImJ1dHRvbiIsICJyb290IiwgInNuYXBzaG90IiwgImNvbXBhY3QiLCAicmVzdWx0IiwgInN0YXRlIiwgInNuYXBzaG90IiwgImJ1dHRvbiIsICJzdGF0ZSIsICJjaGVjayIsICJidXR0b24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImltcG9ydF9lbGVjdHJvbiIsICJpbXBvcnRfZWxlY3Ryb24iLCAic3RhdGUiLCAic2FmZVN0cmluZ2lmeSJdCn0K
