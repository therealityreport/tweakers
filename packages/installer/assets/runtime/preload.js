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
function hasNativeSettingsSidebarOwnership(evidence) {
  return !evidence.forbiddenSurface && evidence.nativePanelSlugCount >= 1;
}
function isNativeSettingsSidebarEvidence(evidence) {
  if (!hasNativeSettingsSidebarOwnership(evidence)) return false;
  if (evidence.nativePanelSlugCount < 2) return false;
  if (evidence.width < 120 || evidence.width > 620) return false;
  if (evidence.height < 80) return false;
  if (evidence.left > evidence.viewportWidth * 0.65) return false;
  if (evidence.mainAppLabelCount >= 2 && evidence.settingsOnlyLabelCount === 0) return false;
  return evidence.coreLabelCount >= 2 && evidence.totalLabelCount >= 3;
}
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
  sidebarProbeStatus: null,
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
    if (state.sidebarProbeStatus !== "missing") {
      state.sidebarProbeStatus = "missing";
      plog("sidebar not found");
    }
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
    if (state.sidebarProbeStatus !== "rejected") {
      state.sidebarProbeStatus = "rejected";
      plog("rejected non-settings sidebar candidate", {
        itemsGroup: describe(itemsGroup),
        outer: describe(outer)
      });
    }
    return;
  }
  state.sidebarProbeStatus = "found";
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
  return nativeSettingsPanelSlugCount(document) >= 2;
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
function nativeSettingsPanelSlugCount(root) {
  const slugs = /* @__PURE__ */ new Set();
  for (const element of Array.from(root.querySelectorAll("[data-settings-panel-slug]"))) {
    if (element.closest("[data-tweaker]")) continue;
    const slug = element.dataset.settingsPanelSlug?.trim();
    if (slug) slugs.add(slug);
  }
  return slugs.size;
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
  const labels = tweakerSettingsLabelsFrom(el);
  const score = tweakerSettingsLabelScore(labels);
  return isNativeSettingsSidebarEvidence({
    width: rect.width,
    height: rect.height,
    left: rect.left,
    viewportWidth: window.innerWidth,
    forbiddenSurface: isForbiddenSettingsSidebarSurface(el),
    nativePanelSlugCount: nativeSettingsPanelSlugCount(el),
    coreLabelCount: score.core,
    totalLabelCount: score.total,
    mainAppLabelCount: tweakerMarkerCount(labels, TWEAKER_MAIN_APP_NAV_LABELS),
    settingsOnlyLabelCount: tweakerMarkerCount(labels, TWEAKER_SETTINGS_ONLY_LABELS)
  });
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
    return hasNativeSettingsSidebarOwnership({
      forbiddenSurface: isForbiddenSettingsSidebarSurface(state.sidebarRoot),
      nativePanelSlugCount: nativeSettingsPanelSlugCount(state.sidebarRoot)
    });
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
    const fingerprint2 = `${activeNav?.textContent ?? ""}|${heading?.textContent ?? ""}|${panel?.children.length ?? 0}`;
    if (state.fingerprint === fingerprint2) return;
    state.fingerprint = fingerprint2;
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
var MAX_MCP_FIBER_DEPTH = 12;
var MAX_MCP_SCHEMA_PROPERTIES = 128;
var MAX_MCP_IDENTITY_LENGTH = 512;
var MAX_MCP_VISIBILITY_ANCESTORS = 128;
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
    if (props && carrierSignal(props)) {
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
function carrierSignal(props) {
  return ["elicitation", "requestId", "conversationId", "hostId"].some((key) => Object.hasOwn(props, key));
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

// src/renderer-crypto.ts
var SHA256_INITIAL = new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_ROUND = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
function rotateRight(value, amount) {
  return value >>> amount | value << 32 - amount;
}
function sha256HexUtf8(value) {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 128;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number(bitLength >> 32n & 0xffffffffn), false);
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn), false);
  const state2 = new Uint32Array(SHA256_INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < words.length; index += 1) {
      const prior15 = words[index - 15];
      const prior2 = words[index - 2];
      const small0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ prior15 >>> 3;
      const small1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ prior2 >>> 10;
      words[index] = words[index - 16] + small0 + words[index - 7] + small1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state2;
    for (let index = 0; index < words.length; index += 1) {
      const large1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = e & f ^ ~e & g;
      const temporary1 = h + large1 + choose + SHA256_ROUND[index] + words[index] >>> 0;
      const large0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const temporary2 = large0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = d + temporary1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2 >>> 0;
    }
    state2[0] = state2[0] + a >>> 0;
    state2[1] = state2[1] + b >>> 0;
    state2[2] = state2[2] + c >>> 0;
    state2[3] = state2[3] + d >>> 0;
    state2[4] = state2[4] + e >>> 0;
    state2[5] = state2[5] + f >>> 0;
    state2[6] = state2[6] + g >>> 0;
    state2[7] = state2[7] + h >>> 0;
  }
  return [...state2].map((word) => word.toString(16).padStart(8, "0")).join("");
}
function secureRendererUuid() {
  const provider = globalThis.crypto;
  if (typeof provider?.randomUUID === "function") return provider.randomUUID();
  if (typeof provider?.getRandomValues !== "function") {
    throw new Error("secure renderer randomness is unavailable");
  }
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

// src/renderer-storage.ts
var CURRENT_ID_PREFIX = "co.tweakers.";
var LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
var CURRENT_STORAGE_PREFIX = "tweaker:storage:";
var ARCHIVE_STORAGE_PREFIX = "tweaker:storage-archive:";
function parseRecord(raw) {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function fingerprint(raw) {
  return raw === null ? "missing" : sha256HexUtf8(raw);
}
function discoverLegacyPublisherKeys(id, storage) {
  if (!id.startsWith(CURRENT_ID_PREFIX)) return [];
  const suffix = id.slice(CURRENT_ID_PREFIX.length);
  if (!suffix) return [];
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
  return [...candidates].sort();
}
function legacyKeysFor(id, storage) {
  const exactLegacyKey = `${LEGACY_STORAGE_PREFIX}${id}`;
  const keys = new Set(discoverLegacyPublisherKeys(id, storage));
  if (storage.getItem(exactLegacyKey) !== null) keys.add(exactLegacyKey);
  return [...keys].sort();
}
function planMigration(id, storage, transactionId = secureRendererUuid()) {
  const currentKey = `${CURRENT_STORAGE_PREFIX}${id}`;
  const canonicalRaw = storage.getItem(currentKey);
  const legacyKeys = legacyKeysFor(id, storage);
  const selectedLegacyKey = legacyKeys.length === 1 ? legacyKeys[0] : null;
  const selectedLegacyRaw = selectedLegacyKey === null ? null : storage.getItem(selectedLegacyKey);
  const base = {
    schemaVersion: 1,
    transactionId,
    currentKey,
    legacyKeys,
    selectedLegacyKey,
    createdCanonical: false,
    canonicalBeforeHash: fingerprint(canonicalRaw),
    canonicalAfterHash: fingerprint(canonicalRaw),
    selectedLegacyHash: fingerprint(selectedLegacyRaw),
    archiveKey: null,
    phase: "planned"
  };
  if (!id.startsWith(CURRENT_ID_PREFIX)) {
    return { receipt: { ...base, status: "not_applicable", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  if (legacyKeys.length > 1) {
    return { receipt: { ...base, status: "ambiguous", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null && parseRecord(canonicalRaw) === null) {
    return { receipt: { ...base, status: "invalid_canonical", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (selectedLegacyRaw !== null && parseRecord(selectedLegacyRaw) === null) {
    return { receipt: { ...base, status: "invalid_legacy", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null) {
    const mismatch = selectedLegacyRaw !== null && selectedLegacyRaw !== canonicalRaw;
    return {
      receipt: { ...base, status: mismatch ? "conflict" : "canonical", holdPromotion: mismatch },
      canonicalRaw,
      selectedLegacyRaw
    };
  }
  if (selectedLegacyRaw === null) {
    return { receipt: { ...base, status: "absent", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  return {
    receipt: {
      ...base,
      status: "prepared",
      holdPromotion: false,
      createdCanonical: true,
      canonicalAfterHash: fingerprint(selectedLegacyRaw)
    },
    canonicalRaw,
    selectedLegacyRaw
  };
}
function prepareRendererStorageMigration(id, storage, transactionId) {
  const plan = planMigration(id, storage, transactionId);
  if (!plan.receipt.createdCanonical || plan.selectedLegacyRaw === null) {
    return { ...plan.receipt, phase: "prepared" };
  }
  try {
    if (storage.getItem(plan.receipt.currentKey) !== null) {
      return { ...plan.receipt, status: "conflict", holdPromotion: true, createdCanonical: false, phase: "prepared" };
    }
    storage.setItem(plan.receipt.currentKey, plan.selectedLegacyRaw);
    if (fingerprint(storage.getItem(plan.receipt.currentKey)) !== plan.receipt.canonicalAfterHash) {
      throw new Error("renderer storage verification failed");
    }
    return { ...plan.receipt, phase: "prepared" };
  } catch {
    return {
      ...plan.receipt,
      status: "write_failed",
      holdPromotion: true,
      createdCanonical: false,
      canonicalAfterHash: fingerprint(storage.getItem(plan.receipt.currentKey)),
      phase: "prepared"
    };
  }
}
function commitRendererStorageMigration(receipt, storage) {
  if (receipt.phase === "committed") return receipt;
  if (receipt.holdPromotion) throw new Error("renderer storage migration is on hold");
  if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
    throw new Error("renderer storage canonical value changed before commit");
  }
  if (receipt.selectedLegacyKey === null) return { ...receipt, phase: "committed" };
  const legacyRaw = storage.getItem(receipt.selectedLegacyKey);
  if (fingerprint(legacyRaw) !== receipt.selectedLegacyHash || legacyRaw === null) {
    throw new Error("renderer storage legacy value changed before commit");
  }
  const archiveKey = `${ARCHIVE_STORAGE_PREFIX}${receipt.transactionId}:${encodeURIComponent(receipt.selectedLegacyKey)}`;
  const archived = storage.getItem(archiveKey);
  if (archived !== null && archived !== legacyRaw) {
    throw new Error("renderer storage archive collision");
  }
  storage.setItem(archiveKey, legacyRaw);
  if (storage.getItem(archiveKey) !== legacyRaw) throw new Error("renderer storage archive verification failed");
  storage.removeItem(receipt.selectedLegacyKey);
  return { ...receipt, archiveKey, phase: "committed" };
}
function rollbackRendererStorageMigration(receipt, storage) {
  if (receipt.phase === "rolled_back") return receipt;
  if (receipt.archiveKey !== null && receipt.selectedLegacyKey !== null) {
    const archived = storage.getItem(receipt.archiveKey);
    if (fingerprint(archived) !== receipt.selectedLegacyHash || archived === null) {
      throw new Error("renderer storage archive changed before rollback");
    }
    const currentLegacy = storage.getItem(receipt.selectedLegacyKey);
    if (currentLegacy !== null && fingerprint(currentLegacy) !== receipt.selectedLegacyHash) {
      throw new Error("renderer storage legacy value changed before rollback");
    }
    if (currentLegacy === null) storage.setItem(receipt.selectedLegacyKey, archived);
    storage.removeItem(receipt.archiveKey);
  }
  if (receipt.createdCanonical) {
    if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
      throw new Error("renderer storage canonical value changed before rollback");
    }
    storage.removeItem(receipt.currentKey);
  }
  return { ...receipt, phase: "rolled_back" };
}
function createRendererStorage(id, storage) {
  let migration = prepareRendererStorageMigration(id, storage);
  const key = `${CURRENT_STORAGE_PREFIX}${id}`;
  const read = () => parseRecord(storage.getItem(key)) ?? {};
  const write = (value) => storage.setItem(key, JSON.stringify(value));
  return {
    get migration() {
      return migration;
    },
    commitMigration: () => {
      migration = commitRendererStorageMigration(migration, storage);
      return migration;
    },
    rollbackMigration: () => {
      migration = rollbackRendererStorageMigration(migration, storage);
      return migration;
    },
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

// src/preload/promotion-renderer-mount.ts
var PROMOTION_RENDERER_NONCE_QUERY = "tweakerPromotionNonce";
var PROMOTION_RENDERER_NONCE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var PROMOTION_RENDERER_AUTH_RESPONSE_MAX_CHARS = 1024;
function promotionRendererAuthorizationAttempt(href) {
  try {
    const parsed = new URL(href);
    const queryEntries = [...parsed.searchParams.entries()];
    const hasReservedQuery = queryEntries.some(([key]) => key === PROMOTION_RENDERER_NONCE_QUERY);
    if (!hasReservedQuery) return { kind: "ordinary" };
    if (parsed.protocol !== "app:" || parsed.hostname !== "-" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/index.html" || parsed.hash !== "" || queryEntries.length !== 1 || queryEntries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY) return { kind: "invalid-candidate", reason: "candidate URL shape invalid" };
    const nonce = queryEntries[0][1];
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(nonce)) {
      return { kind: "invalid-candidate", reason: "candidate nonce invalid" };
    }
    if (parsed.toString() !== href) {
      return { kind: "invalid-candidate", reason: "candidate URL is not canonical" };
    }
    return {
      kind: "candidate",
      nonce,
      request: { version: 1, url: href }
    };
  } catch {
    return { kind: "ordinary" };
  }
}
function promotionRendererAuthorizedNonce(attempt, response) {
  if (attempt.kind !== "candidate" || typeof response !== "string" || response.length === 0 || response.length > PROMOTION_RENDERER_AUTH_RESPONSE_MAX_CHARS) {
    return null;
  }
  try {
    const decoded = JSON.parse(response);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const value = decoded;
    if (Object.keys(value).sort().join(",") !== "nonce,url,version") return null;
    if (value.version !== 1 || typeof value.nonce !== "string" || typeof value.url !== "string") return null;
    if (!PROMOTION_RENDERER_NONCE_PATTERN.test(value.nonce)) return null;
    if (value.nonce !== attempt.nonce || value.url !== attempt.request.url) return null;
    const parsed = new URL(value.url);
    const entries = [...parsed.searchParams.entries()];
    if (parsed.protocol !== "app:" || parsed.hostname !== "-" || parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.pathname !== "/index.html" || parsed.hash !== "" || entries.length !== 1 || entries[0]?.[0] !== PROMOTION_RENDERER_NONCE_QUERY || entries[0][1] !== value.nonce || parsed.toString() !== value.url) return null;
    return value.nonce;
  } catch {
    return null;
  }
}
function createPromotionRendererMountTracker() {
  let sawStartupLoader = false;
  let mounted = false;
  return {
    observe(observation) {
      if (mounted) return "mounted";
      if (!observation.rootPresent) return "waiting";
      if (observation.startupLoaderPresent) {
        sawStartupLoader = true;
        return "waiting";
      }
      if (sawStartupLoader && Number.isSafeInteger(observation.elementChildCount) && observation.elementChildCount > 0) {
        mounted = true;
      }
      return mounted ? "mounted" : "waiting";
    },
    result() {
      return mounted ? "mounted" : "waiting";
    }
  };
}

// src/preload/index.ts
var BROWSER_UI_CONNECT_PORT = "tweaker:browser-ui-connect-app-host";
var BROWSER_UI_BRIDGE_REQUEST = "tweaker:browser-ui-bridge-request";
var BROWSER_UI_BRIDGE_RESPONSE = "tweaker:browser-ui-bridge-response";
var BROWSER_UI_MESSAGE_FOR_VIEW = "tweaker:browser-ui-message-for-view";
var BROWSER_UI_WORKER_MESSAGE = "tweaker:browser-ui-worker-message";
var BROWSER_UI_SYSTEM_THEME = "tweaker:browser-ui-system-theme";
var PROMOTION_RENDERER_IPC_CHANNEL = "tweaker:promotion-renderer-proof";
var PROMOTION_RENDERER_AUTH_CHANNEL = "tweaker:promotion-renderer-authorize";
var PROMOTION_RENDERER_MOUNT_TIMEOUT_MS = 4e3;
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
var promotionAttempt = promotionRendererAuthorizationAttempt(location.href);
var promotionNonce = null;
if (promotionAttempt.kind === "candidate") {
  let response = null;
  let rejectionReason = "main authorization rejected";
  try {
    response = import_electron5.ipcRenderer.sendSync(PROMOTION_RENDERER_AUTH_CHANNEL, promotionAttempt.request);
  } catch {
    rejectionReason = "synchronous authorization failed";
  }
  promotionNonce = promotionRendererAuthorizedNonce(promotionAttempt, response);
  if (promotionNonce === null) {
    fileLog("promotion renderer authorization incomplete", { reason: rejectionReason });
  }
} else if (promotionAttempt.kind === "invalid-candidate") {
  fileLog("promotion renderer authorization incomplete", { reason: promotionAttempt.reason });
}
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
if (promotionNonce) {
  schedulePromotionRendererProof(promotionNonce);
} else if (promotionAttempt.kind === "ordinary") {
  queueMicrotask(() => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
  });
}
function schedulePromotionRendererProof(nonce) {
  const mount = createPromotionRendererMountTracker();
  let observer = null;
  let timeout = null;
  let settled = false;
  const cleanup = () => {
    observer?.disconnect();
    observer = null;
    if (timeout !== null) window.clearTimeout(timeout);
    timeout = null;
  };
  const inspect = () => {
    if (settled) return;
    const root = document.getElementById("root");
    const state2 = mount.observe({
      rootPresent: root !== null,
      startupLoaderPresent: root !== null && root.querySelector(":scope > .startup-loader") !== null,
      elementChildCount: root?.children.length ?? 0
    });
    if (state2 !== "mounted") return;
    settled = true;
    cleanup();
    const rendererStorageSelfTest = promotionRendererStorageSelfTest(nonce);
    import_electron5.ipcRenderer.send(PROMOTION_RENDERER_IPC_CHANNEL, {
      nonce,
      url: location.href,
      lifecycle: "renderer-mounted",
      rendererStorageSelfTest
    });
    fileLog("promotion renderer mount proof sent", { rendererStorageSelfTest });
  };
  queueMicrotask(() => {
    const observationRoot = document.documentElement;
    if (!observationRoot) {
      fileLog("promotion renderer mount proof incomplete", { reason: "document root unavailable" });
      return;
    }
    observer = new MutationObserver(inspect);
    observer.observe(observationRoot, { childList: true, subtree: true });
    timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      fileLog("promotion renderer mount proof incomplete", {
        reason: "startup loader was not replaced by renderer content",
        timeoutMs: PROMOTION_RENDERER_MOUNT_TIMEOUT_MS
      });
    }, PROMOTION_RENDERER_MOUNT_TIMEOUT_MS);
    inspect();
  });
}
function promotionRendererStorageSelfTest(nonce) {
  const suffix = `promotion-health-${nonce}`;
  const currentId = `co.tweakers.${suffix}`;
  const currentKey = `tweaker:storage:${currentId}`;
  const legacyKey = `${["codex", "pp"].join("")}:storage:co.promotion-probe.${suffix}`;
  const raw = JSON.stringify({ retained: true, nonce });
  let archiveKey = null;
  let ownsProbeKeys = false;
  try {
    if (localStorage.getItem(currentKey) !== null || localStorage.getItem(legacyKey) !== null) return "fail";
    ownsProbeKeys = true;
    localStorage.setItem(legacyKey, raw);
    const prepared = prepareRendererStorageMigration(currentId, localStorage, nonce);
    if (prepared.status !== "prepared" || prepared.holdPromotion || localStorage.getItem(currentKey) !== raw) return "fail";
    const committed = commitRendererStorageMigration(prepared, localStorage);
    archiveKey = committed.archiveKey;
    if (committed.phase !== "committed" || !archiveKey || localStorage.getItem(legacyKey) !== null) return "fail";
    const rolledBack = rollbackRendererStorageMigration(committed, localStorage);
    return rolledBack.phase === "rolled_back" && localStorage.getItem(legacyKey) === raw && localStorage.getItem(currentKey) === null && localStorage.getItem(archiveKey) === null ? "pass" : "fail";
  } catch {
    return "fail";
  } finally {
    if (ownsProbeKeys) {
      try {
        localStorage.removeItem(currentKey);
      } catch {
      }
      try {
        localStorage.removeItem(legacyKey);
      } catch {
      }
      if (archiveKey) {
        try {
          localStorage.removeItem(archiveKey);
        } catch {
        }
      }
    }
  }
}
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vc3JjL3ByZWxvYWQvaW5kZXgudHMiLCAiLi4vc3JjL3ByZWxvYWQvcmVhY3QtaG9vay50cyIsICIuLi9zcmMvcHJlbG9hZC9zZXR0aW5ncy1pbmplY3Rvci50cyIsICIuLi9zcmMvdHdlYWstc3RvcmUudHMiLCAiLi4vc3JjL3ByZWxvYWQvc2V0dGluZ3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vha3MtcGFnZS1tb2RlbC50cyIsICIuLi9zcmMvcHJlbG9hZC9lbnZpcm9ubWVudC1jb25maWctY29udHJvbGxlci50cyIsICIuLi9zcmMvcHJlbG9hZC90d2Vhay1ob3N0LnRzIiwgIi4uL3NyYy9wcmVsb2FkL2hvc3Qtc3VyZmFjZXMudHMiLCAiLi4vc3JjL3R3ZWFrLWxpZmVjeWNsZS50cyIsICIuLi9zcmMvcmVuZGVyZXItc3RvcmFnZS50cyIsICIuLi9zcmMvcHJlbG9hZC9tYW5hZ2VyLnRzIiwgIi4uL3NyYy9wcmVsb2FkL2Rlc2t0b3AtdXBkYXRlLWluZGljYXRvci50cyIsICIuLi9zcmMvcHJlbG9hZC9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3Itc3RhdGUudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogUmVuZGVyZXIgcHJlbG9hZCBlbnRyeS4gUnVucyBpbiBhbiBpc29sYXRlZCB3b3JsZCBiZWZvcmUgQ29kZXgncyBwYWdlIEpTLlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqICAgMS4gSW5zdGFsbCBhIFJlYWN0IERldlRvb2xzLXNoYXBlZCBnbG9iYWwgaG9vayB0byBjYXB0dXJlIHRoZSByZW5kZXJlclxuICogICAgICByZWZlcmVuY2Ugd2hlbiBSZWFjdCBtb3VudHMuIFdlIHVzZSB0aGlzIGZvciBmaWJlciB3YWxraW5nLlxuICogICAyLiBBZnRlciBET01Db250ZW50TG9hZGVkLCBraWNrIG9mZiBzZXR0aW5ncy1pbmplY3Rpb24gbG9naWMuXG4gKiAgIDMuIERpc2NvdmVyIHJlbmRlcmVyLXNjb3BlZCB0d2Vha3MgKHZpYSBJUEMgdG8gbWFpbikgYW5kIHN0YXJ0IHRoZW0uXG4gKiAgIDQuIExpc3RlbiBmb3IgYHR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRgIGZyb20gbWFpbiAoZmlsZXN5c3RlbSB3YXRjaGVyKSBhbmRcbiAqICAgICAgaG90LXJlbG9hZCB0d2Vha3Mgd2l0aG91dCBkcm9wcGluZyB0aGUgcGFnZS5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgaW5zdGFsbFJlYWN0SG9vayB9IGZyb20gXCIuL3JlYWN0LWhvb2tcIjtcbmltcG9ydCB7IHN0YXJ0U2V0dGluZ3NJbmplY3RvciB9IGZyb20gXCIuL3NldHRpbmdzLWluamVjdG9yXCI7XG5pbXBvcnQgeyBzdGFydFR3ZWFrSG9zdCwgdGVhcmRvd25Ud2Vha0hvc3QgfSBmcm9tIFwiLi90d2Vhay1ob3N0XCI7XG5pbXBvcnQgeyBtb3VudE1hbmFnZXIgfSBmcm9tIFwiLi9tYW5hZ2VyXCI7XG5pbXBvcnQgeyBzdGFydERlc2t0b3BVcGRhdGVJbmRpY2F0b3IgfSBmcm9tIFwiLi9kZXNrdG9wLXVwZGF0ZS1pbmRpY2F0b3JcIjtcblxuY29uc3QgQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1jb25uZWN0LWFwcC1ob3N0XCI7XG5jb25zdCBCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNUID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlcXVlc3RcIjtcbmNvbnN0IEJST1dTRVJfVUlfQlJJREdFX1JFU1BPTlNFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktYnJpZGdlLXJlc3BvbnNlXCI7XG5jb25zdCBCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcgPSBcInR3ZWFrZXI6YnJvd3Nlci11aS1tZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBCUk9XU0VSX1VJX1dPUktFUl9NRVNTQUdFID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktd29ya2VyLW1lc3NhZ2VcIjtcbmNvbnN0IEJST1dTRVJfVUlfU1lTVEVNX1RIRU1FID0gXCJ0d2Vha2VyOmJyb3dzZXItdWktc3lzdGVtLXRoZW1lXCI7XG5cbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GUk9NX1ZJRVcgPSBcImNvZGV4X2Rlc2t0b3A6bWVzc2FnZS1mcm9tLXZpZXdcIjtcbmNvbnN0IERFU0tUT1BfTUVTU0FHRV9GT1JfVklFVyA9IFwiY29kZXhfZGVza3RvcDptZXNzYWdlLWZvci12aWV3XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQ09OVEVYVF9NRU5VID0gXCJjb2RleF9kZXNrdG9wOnNob3ctY29udGV4dC1tZW51XCI7XG5jb25zdCBERVNLVE9QX1NIT1dfQVBQTElDQVRJT05fTUVOVSA9IFwiY29kZXhfZGVza3RvcDpzaG93LWFwcGxpY2F0aW9uLW1lbnVcIjtcbmNvbnN0IERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXNlbnRyeS1pbml0LW9wdGlvbnNcIjtcbmNvbnN0IERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUiA9IFwiY29kZXhfZGVza3RvcDpnZXQtYnVpbGQtZmxhdm9yXCI7XG5jb25zdCBERVNLVE9QX0dFVF9VU0VTX09XTF9BUFBfU0hFTEwgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXVzZXMtb3dsLWFwcC1zaGVsbFwiO1xuY29uc3QgREVTS1RPUF9HRVRfU1lTVEVNX1RIRU1FX1ZBUklBTlQgPSBcImNvZGV4X2Rlc2t0b3A6Z2V0LXN5c3RlbS10aGVtZS12YXJpYW50XCI7XG5jb25zdCBERVNLVE9QX0dFVF9TSEFSRURfT0JKRUNUX1NOQVBTSE9UID0gXCJjb2RleF9kZXNrdG9wOmdldC1zaGFyZWQtb2JqZWN0LXNuYXBzaG90XCI7XG5jb25zdCBERVNLVE9QX0dFVF9GQVNUX01PREVfUk9MTE9VVF9NRVRSSUNTID0gXCJjb2RleF9kZXNrdG9wOmdldC1mYXN0LW1vZGUtcm9sbG91dC1tZXRyaWNzXCI7XG5jb25zdCBERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVEID0gXCJjb2RleF9kZXNrdG9wOnN5c3RlbS10aGVtZS12YXJpYW50LXVwZGF0ZWRcIjtcbmNvbnN0IERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCA9IFwiY29kZXhfZGVza3RvcDp0cmlnZ2VyLXNlbnRyeS10ZXN0XCI7XG5cbmZ1bmN0aW9uIGRlc2t0b3BXb3JrZXJGcm9tVmlld0NoYW5uZWwod29ya2VySWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgY29kZXhfZGVza3RvcDp3b3JrZXI6JHt3b3JrZXJJZH06ZnJvbS12aWV3YDtcbn1cblxuZnVuY3Rpb24gZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYGNvZGV4X2Rlc2t0b3A6d29ya2VyOiR7d29ya2VySWR9OmZvci12aWV3YDtcbn1cblxuLy8gRmlsZS1sb2cgcHJlbG9hZCBwcm9ncmVzcyBzbyB3ZSBjYW4gZGlhZ25vc2Ugd2l0aG91dCBEZXZUb29scy4gQmVzdC1lZmZvcnQ6XG4vLyBmYWlsdXJlcyBoZXJlIG11c3QgbmV2ZXIgdGhyb3cgYmVjYXVzZSB3ZSdkIHRha2UgdGhlIHBhZ2UgZG93biB3aXRoIHVzLlxuLy9cbi8vIENvZGV4J3MgcmVuZGVyZXIgaXMgc2FuZGJveGVkIChzYW5kYm94OiB0cnVlKSwgc28gYHJlcXVpcmUoXCJub2RlOmZzXCIpYCBpc1xuLy8gdW5hdmFpbGFibGUuIFdlIGZvcndhcmQgbG9nIGxpbmVzIHRvIG1haW4gdmlhIElQQzsgbWFpbiB3cml0ZXMgdGhlIGZpbGUuXG5mdW5jdGlvbiBmaWxlTG9nKHN0YWdlOiBzdHJpbmcsIGV4dHJhPzogdW5rbm93bik6IHZvaWQge1xuICBjb25zdCBtc2cgPSBgW3R3ZWFrZXIgcHJlbG9hZF0gJHtzdGFnZX0ke1xuICAgIGV4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKVxuICB9YDtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmVycm9yKG1zZyk7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLCBcImluZm9cIiwgbXNnKTtcbiAgfSBjYXRjaCB7fVxufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuZmlsZUxvZyhcInByZWxvYWQgZW50cnlcIiwgeyB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG5cbnRyeSB7XG4gIGluc3RhbGxCcm93c2VyVWlIb3N0QnJpZGdlKCk7XG4gIGZpbGVMb2coXCJicm93c2VyIFVJIGhvc3QgYnJpZGdlIGluc3RhbGxlZFwiKTtcbn0gY2F0Y2ggKGUpIHtcbiAgZmlsZUxvZyhcImJyb3dzZXIgVUkgaG9zdCBicmlkZ2UgRkFJTEVEXCIsIFN0cmluZyhlKSk7XG59XG5cbi8vIFJlYWN0IGhvb2sgbXVzdCBiZSBpbnN0YWxsZWQgKmJlZm9yZSogQ29kZXgncyBidW5kbGUgcnVucy5cbnRyeSB7XG4gIGluc3RhbGxSZWFjdEhvb2soKTtcbiAgZmlsZUxvZyhcInJlYWN0IGhvb2sgaW5zdGFsbGVkXCIpO1xufSBjYXRjaCAoZSkge1xuICBmaWxlTG9nKFwicmVhY3QgaG9vayBGQUlMRURcIiwgU3RyaW5nKGUpKTtcbn1cblxucXVldWVNaWNyb3Rhc2soKCkgPT4ge1xuICBpZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBib290LCB7IG9uY2U6IHRydWUgfSk7XG4gIH0gZWxzZSB7XG4gICAgYm9vdCgpO1xuICB9XG59KTtcblxuYXN5bmMgZnVuY3Rpb24gYm9vdCgpIHtcbiAgZmlsZUxvZyhcImJvb3Qgc3RhcnRcIiwgeyByZWFkeVN0YXRlOiBkb2N1bWVudC5yZWFkeVN0YXRlIH0pO1xuICB0cnkge1xuICAgIHN0YXJ0RGVza3RvcFVwZGF0ZUluZGljYXRvcigpO1xuICAgIGZpbGVMb2coXCJkZXNrdG9wIHVwZGF0ZSBpbmRpY2F0b3Igc3RhcnRlZFwiKTtcbiAgICBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTtcbiAgICBmaWxlTG9nKFwic2V0dGluZ3MgaW5qZWN0b3Igc3RhcnRlZFwiKTtcbiAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgIGZpbGVMb2coXCJ0d2VhayBob3N0IHN0YXJ0ZWRcIik7XG4gICAgYXdhaXQgbW91bnRNYW5hZ2VyKCk7XG4gICAgZmlsZUxvZyhcIm1hbmFnZXIgbW91bnRlZFwiKTtcbiAgICBzdWJzY3JpYmVSZWxvYWQoKTtcbiAgICBmaWxlTG9nKFwiYm9vdCBjb21wbGV0ZVwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZpbGVMb2coXCJib290IEZBSUxFRFwiLCBTdHJpbmcoKGUgYXMgRXJyb3IpPy5zdGFjayA/PyBlKSk7XG4gICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBwcmVsb2FkIGJvb3QgZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBIb3QgcmVsb2FkOiBnYXRlZCBiZWhpbmQgYSBzbWFsbCBpbi1mbGlnaHQgbG9jayBzbyBhIGZsdXJyeSBvZiBmcyBldmVudHNcbi8vIGRvZXNuJ3QgcmVlbnRyYW50bHkgdGVhciBkb3duIHRoZSBob3N0IG1pZC1sb2FkLlxubGV0IHJlbG9hZGluZzogUHJvbWlzZTx2b2lkPiB8IG51bGwgPSBudWxsO1xuZnVuY3Rpb24gc3Vic2NyaWJlUmVsb2FkKCk6IHZvaWQge1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6dHdlYWtzLWNoYW5nZWRcIiwgKCkgPT4ge1xuICAgIGlmIChyZWxvYWRpbmcpIHJldHVybjtcbiAgICByZWxvYWRpbmcgPSAoYXN5bmMgKCkgPT4ge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5pbmZvKFwiW3R3ZWFrZXJdIGhvdC1yZWxvYWRpbmcgdHdlYWtzXCIpO1xuICAgICAgICB0ZWFyZG93blR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBzdGFydFR3ZWFrSG9zdCgpO1xuICAgICAgICBhd2FpdCBtb3VudE1hbmFnZXIoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIlt0d2Vha2VyXSBob3QgcmVsb2FkIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWxvYWRpbmcgPSBudWxsO1xuICAgICAgfVxuICAgIH0pKCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBpbnN0YWxsQnJvd3NlclVpSG9zdEJyaWRnZSgpOiB2b2lkIHtcbiAgY29uc3Qgd29ya2VyTGlzdGVuZXJzID0gbmV3IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+KCk7XG5cbiAgaXBjUmVuZGVyZXIub24oQlJPV1NFUl9VSV9DT05ORUNUX1BPUlQsIChldmVudCkgPT4ge1xuICAgIGNvbnN0IFtwb3J0XSA9IGV2ZW50LnBvcnRzO1xuICAgIGlmICghcG9ydCkgcmV0dXJuO1xuICAgIHdpbmRvdy5wb3N0TWVzc2FnZSh7IHR5cGU6IFwiY29ubmVjdC1hcHAtaG9zdFwiLCBwb3J0IH0sIFwiKlwiLCBbcG9ydF0pO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihCUk9XU0VSX1VJX0JSSURHRV9SRVFVRVNULCBhc3luYyAoX2V2ZW50LCBwYXlsb2FkKSA9PiB7XG4gICAgY29uc3QgcmVxdWVzdCA9IHBheWxvYWQgJiYgdHlwZW9mIHBheWxvYWQgPT09IFwib2JqZWN0XCJcbiAgICAgID8gcGF5bG9hZCBhcyB7IGlkPzogdW5rbm93bjsgbWV0aG9kPzogdW5rbm93bjsgYXJncz86IHVua25vd24gfVxuICAgICAgOiB7fTtcbiAgICBjb25zdCBpZCA9IHR5cGVvZiByZXF1ZXN0LmlkID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5pZCA6IFwiXCI7XG4gICAgY29uc3QgbWV0aG9kID0gdHlwZW9mIHJlcXVlc3QubWV0aG9kID09PSBcInN0cmluZ1wiID8gcmVxdWVzdC5tZXRob2QgOiBcIlwiO1xuICAgIGNvbnN0IGFyZ3MgPSBBcnJheS5pc0FycmF5KHJlcXVlc3QuYXJncykgPyByZXF1ZXN0LmFyZ3MgOiBbXTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBydW5Ccm93c2VyVWlCcmlkZ2VNZXRob2QobWV0aG9kLCBhcmdzLCB3b3JrZXJMaXN0ZW5lcnMpO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX0JSSURHRV9SRVNQT05TRSwgeyBpZCwgb2s6IHRydWUsIHZhbHVlIH0pO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9CUklER0VfUkVTUE9OU0UsIHtcbiAgICAgICAgaWQsXG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgaXBjUmVuZGVyZXIub24oREVTS1RPUF9NRVNTQUdFX0ZPUl9WSUVXLCAoX2V2ZW50LCBtZXNzYWdlKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIuc2VuZChCUk9XU0VSX1VJX01FU1NBR0VfRk9SX1ZJRVcsIG1lc3NhZ2UpO1xuICB9KTtcblxuICBpcGNSZW5kZXJlci5vbihERVNLVE9QX1NZU1RFTV9USEVNRV9VUERBVEVELCAoX2V2ZW50LCB2YWx1ZSkgPT4ge1xuICAgIGlwY1JlbmRlcmVyLnNlbmQoQlJPV1NFUl9VSV9TWVNURU1fVEhFTUUsIHZhbHVlKTtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1bkJyb3dzZXJVaUJyaWRnZU1ldGhvZChcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIGFyZ3M6IHVua25vd25bXSxcbiAgd29ya2VyTGlzdGVuZXJzOiBNYXA8c3RyaW5nLCAoLi4uYXJnczogdW5rbm93bltdKSA9PiB2b2lkPixcbik6IFByb21pc2U8dW5rbm93bj4ge1xuICBzd2l0Y2ggKG1ldGhvZCkge1xuICAgIGNhc2UgXCJzbmFwc2hvdFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NIQVJFRF9PQkpFQ1RfU05BUFNIT1QpID8/IHt9O1xuICAgIGNhc2UgXCJzeXN0ZW1UaGVtZVwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NZU1RFTV9USEVNRV9WQVJJQU5UKTtcbiAgICBjYXNlIFwic2VudHJ5T3B0aW9uc1wiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1NFTlRSWV9JTklUX09QVElPTlMpO1xuICAgIGNhc2UgXCJidWlsZEZsYXZvclwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX0JVSUxEX0ZMQVZPUik7XG4gICAgY2FzZSBcInVzZXNPd2xBcHBTaGVsbFwiOlxuICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLnNlbmRTeW5jKERFU0tUT1BfR0VUX1VTRVNfT1dMX0FQUF9TSEVMTCkgPT09IHRydWU7XG4gICAgY2FzZSBcInNlbmRNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoREVTS1RPUF9NRVNTQUdFX0ZST01fVklFVywgYXJnc1swXSk7XG4gICAgY2FzZSBcInNlbmRXb3JrZXJNZXNzYWdlRnJvbVZpZXdcIjpcbiAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoZGVza3RvcFdvcmtlckZyb21WaWV3Q2hhbm5lbChTdHJpbmcoYXJnc1swXSkpLCBhcmdzWzFdKTtcbiAgICBjYXNlIFwic3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiBzdWJzY3JpYmVCcm93c2VyVWlXb3JrZXJNZXNzYWdlcyhTdHJpbmcoYXJnc1swXSksIHdvcmtlckxpc3RlbmVycyk7XG4gICAgY2FzZSBcInVuc3Vic2NyaWJlV29ya2VyTWVzc2FnZXNcIjpcbiAgICAgIHJldHVybiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFN0cmluZyhhcmdzWzBdKSwgd29ya2VyTGlzdGVuZXJzKTtcbiAgICBjYXNlIFwic2hvd0NvbnRleHRNZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19DT05URVhUX01FTlUsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJzaG93QXBwbGljYXRpb25NZW51XCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfU0hPV19BUFBMSUNBVElPTl9NRU5VLCB7XG4gICAgICAgIG1lbnVJZDogYXJnc1swXSxcbiAgICAgICAgeDogYXJnc1sxXSxcbiAgICAgICAgeTogYXJnc1syXSxcbiAgICAgIH0pO1xuICAgIGNhc2UgXCJnZXRGYXN0TW9kZVJvbGxvdXRNZXRyaWNzXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfR0VUX0ZBU1RfTU9ERV9ST0xMT1VUX01FVFJJQ1MsIGFyZ3NbMF0pO1xuICAgIGNhc2UgXCJ0cmlnZ2VyU2VudHJ5VGVzdEVycm9yXCI6XG4gICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKERFU0tUT1BfVFJJR0dFUl9TRU5UUllfVEVTVCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBUd2Vha2VycyBicm93c2VyIFVJIGJyaWRnZSBtZXRob2Q6ICR7bWV0aG9kfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGlmICghL15bYS16QS1aMC05Ll86LV0rJC8udGVzdCh3b3JrZXJJZCkpIHRocm93IG5ldyBFcnJvcihcImludmFsaWQgd29ya2VyIGlkXCIpO1xuICBpZiAod29ya2VyTGlzdGVuZXJzLmhhcyh3b3JrZXJJZCkpIHJldHVybiB0cnVlO1xuICBjb25zdCBsaXN0ZW5lciA9IChfZXZlbnQ6IHVua25vd24sIG1lc3NhZ2U6IHVua25vd24pID0+IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKEJST1dTRVJfVUlfV09SS0VSX01FU1NBR0UsIHdvcmtlcklkLCBtZXNzYWdlKTtcbiAgfTtcbiAgd29ya2VyTGlzdGVuZXJzLnNldCh3b3JrZXJJZCwgbGlzdGVuZXIpO1xuICBpcGNSZW5kZXJlci5vbihkZXNrdG9wV29ya2VyRm9yVmlld0NoYW5uZWwod29ya2VySWQpLCBsaXN0ZW5lcik7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiB1bnN1YnNjcmliZUJyb3dzZXJVaVdvcmtlck1lc3NhZ2VzKFxuICB3b3JrZXJJZDogc3RyaW5nLFxuICB3b3JrZXJMaXN0ZW5lcnM6IE1hcDxzdHJpbmcsICguLi5hcmdzOiB1bmtub3duW10pID0+IHZvaWQ+LFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxpc3RlbmVyID0gd29ya2VyTGlzdGVuZXJzLmdldCh3b3JrZXJJZCk7XG4gIGlmICghbGlzdGVuZXIpIHJldHVybiB0cnVlO1xuICB3b3JrZXJMaXN0ZW5lcnMuZGVsZXRlKHdvcmtlcklkKTtcbiAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoZGVza3RvcFdvcmtlckZvclZpZXdDaGFubmVsKHdvcmtlcklkKSwgbGlzdGVuZXIpO1xuICByZXR1cm4gdHJ1ZTtcbn1cbiIsICIvKipcbiAqIEluc3RhbGwgYSBtaW5pbWFsIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXy4gUmVhY3QgY2FsbHNcbiAqIGBob29rLmluamVjdChyZW5kZXJlckludGVybmFscylgIGR1cmluZyBgY3JlYXRlUm9vdGAvYGh5ZHJhdGVSb290YC4gVGhlXG4gKiBcImludGVybmFsc1wiIG9iamVjdCBleHBvc2VzIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlLCB3aGljaCBsZXRzIHVzIHR1cm4gYVxuICogRE9NIG5vZGUgaW50byBhIFJlYWN0IGZpYmVyIFx1MjAxNCBuZWNlc3NhcnkgZm9yIG91ciBTZXR0aW5ncyBpbmplY3Rvci5cbiAqXG4gKiBXZSBkb24ndCB3YW50IHRvIGJyZWFrIHJlYWwgUmVhY3QgRGV2VG9vbHMgaWYgdGhlIHVzZXIgb3BlbnMgaXQ7IHdlIGluc3RhbGxcbiAqIG9ubHkgaWYgbm8gaG9vayBleGlzdHMgeWV0LCBhbmQgd2UgZm9yd2FyZCBjYWxscyB0byBhIGRvd25zdHJlYW0gaG9vayBpZlxuICogb25lIGlzIGxhdGVyIGFzc2lnbmVkLlxuICovXG5kZWNsYXJlIGdsb2JhbCB7XG4gIGludGVyZmFjZSBXaW5kb3cge1xuICAgIF9fUkVBQ1RfREVWVE9PTFNfR0xPQkFMX0hPT0tfXz86IFJlYWN0RGV2dG9vbHNIb29rO1xuICAgIF9fdHdlYWtlcl9fPzoge1xuICAgICAgaG9vazogUmVhY3REZXZ0b29sc0hvb2s7XG4gICAgICByZW5kZXJlcnM6IE1hcDxudW1iZXIsIFJlbmRlcmVySW50ZXJuYWxzPjtcbiAgICB9O1xuICB9XG59XG5cbmludGVyZmFjZSBSZW5kZXJlckludGVybmFscyB7XG4gIGZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPzogKG46IE5vZGUpID0+IHVua25vd247XG4gIHZlcnNpb24/OiBzdHJpbmc7XG4gIGJ1bmRsZVR5cGU/OiBudW1iZXI7XG4gIHJlbmRlcmVyUGFja2FnZU5hbWU/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBSZWFjdERldnRvb2xzSG9vayB7XG4gIHN1cHBvcnRzRmliZXI6IHRydWU7XG4gIHJlbmRlcmVyczogTWFwPG51bWJlciwgUmVuZGVyZXJJbnRlcm5hbHM+O1xuICBvbihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIG9mZihldmVudDogc3RyaW5nLCBmbjogKC4uLmE6IHVua25vd25bXSkgPT4gdm9pZCk6IHZvaWQ7XG4gIGVtaXQoZXZlbnQ6IHN0cmluZywgLi4uYTogdW5rbm93bltdKTogdm9pZDtcbiAgaW5qZWN0KHJlbmRlcmVyOiBSZW5kZXJlckludGVybmFscyk6IG51bWJlcjtcbiAgb25TY2hlZHVsZUZpYmVyUm9vdD8oKTogdm9pZDtcbiAgb25Db21taXRGaWJlclJvb3Q/KCk6IHZvaWQ7XG4gIG9uQ29tbWl0RmliZXJVbm1vdW50PygpOiB2b2lkO1xuICBjaGVja0RDRT8oKTogdm9pZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGluc3RhbGxSZWFjdEhvb2soKTogdm9pZCB7XG4gIGlmICh3aW5kb3cuX19SRUFDVF9ERVZUT09MU19HTE9CQUxfSE9PS19fKSByZXR1cm47XG4gIGNvbnN0IHJlbmRlcmVycyA9IG5ldyBNYXA8bnVtYmVyLCBSZW5kZXJlckludGVybmFscz4oKTtcbiAgbGV0IG5leHRJZCA9IDE7XG4gIGNvbnN0IGxpc3RlbmVycyA9IG5ldyBNYXA8c3RyaW5nLCBTZXQ8KC4uLmE6IHVua25vd25bXSkgPT4gdm9pZD4+KCk7XG5cbiAgY29uc3QgaG9vazogUmVhY3REZXZ0b29sc0hvb2sgPSB7XG4gICAgc3VwcG9ydHNGaWJlcjogdHJ1ZSxcbiAgICByZW5kZXJlcnMsXG4gICAgaW5qZWN0KHJlbmRlcmVyKSB7XG4gICAgICBjb25zdCBpZCA9IG5leHRJZCsrO1xuICAgICAgcmVuZGVyZXJzLnNldChpZCwgcmVuZGVyZXIpO1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgIGNvbnNvbGUuZGVidWcoXG4gICAgICAgIFwiW3R3ZWFrZXJdIFJlYWN0IHJlbmRlcmVyIGF0dGFjaGVkOlwiLFxuICAgICAgICByZW5kZXJlci5yZW5kZXJlclBhY2thZ2VOYW1lLFxuICAgICAgICByZW5kZXJlci52ZXJzaW9uLFxuICAgICAgKTtcbiAgICAgIHJldHVybiBpZDtcbiAgICB9LFxuICAgIG9uKGV2ZW50LCBmbikge1xuICAgICAgbGV0IHMgPSBsaXN0ZW5lcnMuZ2V0KGV2ZW50KTtcbiAgICAgIGlmICghcykgbGlzdGVuZXJzLnNldChldmVudCwgKHMgPSBuZXcgU2V0KCkpKTtcbiAgICAgIHMuYWRkKGZuKTtcbiAgICB9LFxuICAgIG9mZihldmVudCwgZm4pIHtcbiAgICAgIGxpc3RlbmVycy5nZXQoZXZlbnQpPy5kZWxldGUoZm4pO1xuICAgIH0sXG4gICAgZW1pdChldmVudCwgLi4uYXJncykge1xuICAgICAgbGlzdGVuZXJzLmdldChldmVudCk/LmZvckVhY2goKGZuKSA9PiBmbiguLi5hcmdzKSk7XG4gICAgfSxcbiAgICBvbkNvbW1pdEZpYmVyUm9vdCgpIHt9LFxuICAgIG9uQ29tbWl0RmliZXJVbm1vdW50KCkge30sXG4gICAgb25TY2hlZHVsZUZpYmVyUm9vdCgpIHt9LFxuICAgIGNoZWNrRENFKCkge30sXG4gIH07XG5cbiAgT2JqZWN0LmRlZmluZVByb3BlcnR5KHdpbmRvdywgXCJfX1JFQUNUX0RFVlRPT0xTX0dMT0JBTF9IT09LX19cIiwge1xuICAgIGNvbmZpZ3VyYWJsZTogdHJ1ZSxcbiAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICB3cml0YWJsZTogdHJ1ZSwgLy8gYWxsb3cgcmVhbCBEZXZUb29scyB0byBvdmVyd3JpdGUgaWYgdXNlciBpbnN0YWxscyBpdFxuICAgIHZhbHVlOiBob29rLFxuICB9KTtcblxuICB3aW5kb3cuX190d2Vha2VyX18gPSB7IGhvb2ssIHJlbmRlcmVycyB9O1xufVxuXG4vKiogUmVzb2x2ZSB0aGUgUmVhY3QgZmliZXIgZm9yIGEgRE9NIG5vZGUsIGlmIGFueSByZW5kZXJlciBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpYmVyRm9yTm9kZShub2RlOiBOb2RlKTogdW5rbm93biB8IG51bGwge1xuICBjb25zdCByZW5kZXJlcnMgPSB3aW5kb3cuX190d2Vha2VyX18/LnJlbmRlcmVycztcbiAgaWYgKHJlbmRlcmVycykge1xuICAgIGZvciAoY29uc3QgciBvZiByZW5kZXJlcnMudmFsdWVzKCkpIHtcbiAgICAgIGNvbnN0IGYgPSByLmZpbmRGaWJlckJ5SG9zdEluc3RhbmNlPy4obm9kZSk7XG4gICAgICBpZiAoZikgcmV0dXJuIGY7XG4gICAgfVxuICB9XG4gIC8vIEZhbGxiYWNrOiByZWFkIHRoZSBSZWFjdCBpbnRlcm5hbCBwcm9wZXJ0eSBkaXJlY3RseSBmcm9tIHRoZSBET00gbm9kZS5cbiAgLy8gUmVhY3Qgc3RvcmVzIGZpYmVycyBhcyBhIHByb3BlcnR5IHdob3NlIGtleSBzdGFydHMgd2l0aCBcIl9fcmVhY3RGaWJlclwiLlxuICBmb3IgKGNvbnN0IGsgb2YgT2JqZWN0LmtleXMobm9kZSkpIHtcbiAgICBpZiAoay5zdGFydHNXaXRoKFwiX19yZWFjdEZpYmVyXCIpKSByZXR1cm4gKG5vZGUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba107XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG4iLCAiLyoqXG4gKiBTZXR0aW5ncyBpbmplY3RvciBmb3IgQ29kZXgncyBTZXR0aW5ncyBwYWdlLlxuICpcbiAqIENvZGV4J3Mgc2V0dGluZ3MgaXMgYSByb3V0ZWQgcGFnZSAoVVJMIHN0YXlzIGF0IGAvaW5kZXguaHRtbD9ob3N0SWQ9bG9jYWxgKVxuICogTk9UIGEgbW9kYWwgZGlhbG9nLiBUaGUgc2lkZWJhciBsaXZlcyBpbnNpZGUgYSBgPGRpdiBjbGFzcz1cImZsZXggZmxleC1jb2xcbiAqIGdhcC0xIGdhcC0wXCI+YCB3cmFwcGVyIHRoYXQgaG9sZHMgb25lIG9yIG1vcmUgYDxkaXYgY2xhc3M9XCJmbGV4IGZsZXgtY29sXG4gKiBnYXAtcHhcIj5gIGdyb3VwcyBvZiBidXR0b25zLiBUaGVyZSBhcmUgbm8gc3RhYmxlIGByb2xlYCAvIGBhcmlhLWxhYmVsYCAvXG4gKiBgZGF0YS10ZXN0aWRgIGhvb2sgb24gdGhlIHNoZWxsLiBOYXRpdmUgc2V0dGluZ3Mgcm93cyBkbyBleHBvc2Ugc3RhYmxlXG4gKiBgZGF0YS1zZXR0aW5ncy1wYW5lbC1zbHVnYCBtYXJrZXJzLCBzbyB0aG9zZSBvd24gdGhlIHN1cmZhY2UgYW5kIGxvY2FsaXplZFxuICogaXRlbSBsYWJlbHMgb25seSByYW5rIGNhbmRpZGF0ZXMgaW5zaWRlIHRoYXQgc3VyZmFjZS5cbiAqXG4gKiBMYXlvdXQgd2UgaW5qZWN0OlxuICpcbiAqICAgR0VORVJBTCAgICAgICAgICAgICAgICAgICAgICAgKHVwcGVyY2FzZSBncm91cCBsYWJlbClcbiAqICAgW0NvZGV4J3MgZXhpc3RpbmcgaXRlbXMgZ3JvdXBdXG4gKiAgIFRXRUFLRVJTICAgICAgICAgICAgICAgICAgICAgICh1cHBlcmNhc2UgZ3JvdXAgbGFiZWwpXG4gKiAgIFx1MjREOCBDb25maWdcbiAqICAgXHUyNjMwIFR3ZWFrc1xuICogICBcdTI1QzcgVHdlYWsgU3RvcmVcbiAqXG4gKiBDbGlja2luZyBDb25maWcgLyBUd2Vha3MgLyBUd2VhayBTdG9yZSBoaWRlcyBDb2RleCdzIGNvbnRlbnQgcGFuZWwgY2hpbGRyZW4gYW5kIHJlbmRlcnNcbiAqIG91ciBvd24gYG1haW4tc3VyZmFjZWAgcGFuZWwgaW4gdGhlaXIgcGxhY2UuIENsaWNraW5nIGFueSBvZiBDb2RleCdzXG4gKiBzaWRlYmFyIGl0ZW1zIHJlc3RvcmVzIHRoZSBvcmlnaW5hbCB2aWV3LlxuICovXG5cbmltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQgdHlwZSB7XG4gIFNldHRpbmdzU2VjdGlvbixcbiAgU2V0dGluZ3NQYWdlLFxuICBTZXR0aW5nc0hhbmRsZSxcbiAgVHdlYWtNYW5pZmVzdCxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuaW1wb3J0IHtcbiAgYnVpbGRUd2Vha1B1Ymxpc2hJc3N1ZVVybCxcbiAgdHlwZSBUd2Vha0hlYWx0aFJlY29yZCxcbiAgdHlwZSBUd2Vha1N0YXR1cyxcbiAgdHlwZSBUd2Vha1N0b3JlRW50cnksXG4gIHR5cGUgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uLFxufSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcbmltcG9ydCB7XG4gIGJ1aWxkU2V0dGluZ3NOYXZpZ2F0aW9uTW9kZWwsXG4gIGhhc05hdGl2ZVNldHRpbmdzU2lkZWJhck93bmVyc2hpcCxcbiAgaXNOYXRpdmVTZXR0aW5nc1NpZGViYXJFdmlkZW5jZSxcbiAgdHlwZSBTZXR0aW5nc05hdmlnYXRpb25JdGVtLFxufSBmcm9tIFwiLi9zZXR0aW5ncy1wYWdlLW1vZGVsXCI7XG5pbXBvcnQge1xuICBmaWx0ZXJUd2Vha3NQYWdlSXRlbXMsXG4gIFRXRUFLU19QQUdFX0ZJTFRFUlMsXG4gIHR3ZWFrc1BhZ2VDb3VudHMsXG4gIHR5cGUgVHdlYWtzUGFnZUZpbHRlcixcbn0gZnJvbSBcIi4vdHdlYWtzLXBhZ2UtbW9kZWxcIjtcbmltcG9ydCB7XG4gIENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcixcbiAgY3JlYXRlRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyLFxuICBkZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uLFxuICBkZXNrdG9wVXBkYXRlU3RhdHVzUHJlc2VudGF0aW9uLFxuICBodW1hbml6ZUNvZGV4UGhhc2UsXG4gIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzLFxuICB0eXBlIERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24sXG4gIHR5cGUgRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbixcbn0gZnJvbSBcIi4vZW52aXJvbm1lbnQtY29uZmlnLWNvbnRyb2xsZXJcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ29kZXhDbGlMYW5lLFxuICBDb2RleENsaVZlcnNpb25TdGF0ZSxcbiAgQ29kZXhGZWF0dXJlRW50cnksXG4gIENvZGV4RmVhdHVyZVN0YWdlLFxuICBDb2RleEluc3RhbGxQcm9ncmVzcyxcbiAgQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxufSBmcm9tIFwiLi4vY29kZXgtdmVyc2lvbi10eXBlc1wiO1xuXG5jb25zdCBUV0VBS0VSU19SRUxFQVNFU19VUkwgPSBcImh0dHBzOi8vZ2l0aHViLmNvbS90aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzL3JlbGVhc2VzXCI7XG5cbi8vIE1pcnJvcnMgdGhlIHJ1bnRpbWUncyBtYWluLXNpZGUgTGlzdGVkVHdlYWsgc2hhcGUgKGtlcHQgaW4gc3luYyBtYW51YWxseSkuXG5pbnRlcmZhY2UgTGlzdGVkVHdlYWsge1xuICBtYW5pZmVzdDogVHdlYWtNYW5pZmVzdDtcbiAgZW50cnk6IHN0cmluZztcbiAgZGlyOiBzdHJpbmc7XG4gIGVudHJ5RXhpc3RzOiBib29sZWFuO1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIGhlYWx0aDogVHdlYWtIZWFsdGhSZWNvcmQgfCBudWxsO1xuICBjYXRhbG9nOiBUd2Vha1N0b3JlRW50cnkgfCBudWxsO1xuICB1cGRhdGU6IFR3ZWFrVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBsaWZlY3ljbGVPdmVycmlkZT86IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXCJsaWZlY3ljbGVcIl07XG59XG5cbmludGVyZmFjZSBUd2Vha1VwZGF0ZUNoZWNrIHtcbiAgY2hlY2tlZEF0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtlckNvbmZpZyB7XG4gIHZlcnNpb246IHN0cmluZztcbiAgYXV0b1VwZGF0ZTogYm9vbGVhbjtcbiAgdXBkYXRlQ2hhbm5lbDogU2VsZlVwZGF0ZUNoYW5uZWw7XG4gIHVwZGF0ZVJlcG86IHN0cmluZztcbiAgdXBkYXRlUmVmOiBzdHJpbmc7XG4gIHVwZGF0ZUNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2sgfCBudWxsO1xuICBzZWxmVXBkYXRlOiBTZWxmVXBkYXRlU3RhdGUgfCBudWxsO1xuICBpbnN0YWxsYXRpb25Tb3VyY2U6IEluc3RhbGxhdGlvblNvdXJjZTtcbn1cblxuaW50ZXJmYWNlIFR3ZWFrZXJVcGRhdGVDaGVjayB7XG4gIGNoZWNrZWRBdDogc3RyaW5nO1xuICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICBsYXRlc3RWZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlTm90ZXM6IHN0cmluZyB8IG51bGw7XG4gIHVwZGF0ZUF2YWlsYWJsZTogYm9vbGVhbjtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbnR5cGUgU2VsZlVwZGF0ZUNoYW5uZWwgPSBcInN0YWJsZVwiIHwgXCJwcmVyZWxlYXNlXCIgfCBcImN1c3RvbVwiO1xudHlwZSBTZWxmVXBkYXRlU3RhdHVzID0gXCJjaGVja2luZ1wiIHwgXCJ1cC10by1kYXRlXCIgfCBcInVwZGF0ZWRcIiB8IFwiZmFpbGVkXCIgfCBcImRpc2FibGVkXCI7XG5cbmludGVyZmFjZSBTZWxmVXBkYXRlU3RhdGUge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG4gIHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cztcbiAgY3VycmVudFZlcnNpb246IHN0cmluZztcbiAgbGF0ZXN0VmVyc2lvbjogc3RyaW5nIHwgbnVsbDtcbiAgdGFyZ2V0UmVmOiBzdHJpbmcgfCBudWxsO1xuICByZWxlYXNlVXJsOiBzdHJpbmcgfCBudWxsO1xuICByZXBvOiBzdHJpbmc7XG4gIGNoYW5uZWw6IFNlbGZVcGRhdGVDaGFubmVsO1xuICBzb3VyY2VSb290OiBzdHJpbmc7XG4gIGluc3RhbGxhdGlvblNvdXJjZT86IEluc3RhbGxhdGlvblNvdXJjZTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBJbnN0YWxsYXRpb25Tb3VyY2Uge1xuICBraW5kOiBcImdpdGh1Yi1zb3VyY2VcIiB8IFwiaG9tZWJyZXdcIiB8IFwibG9jYWwtZGV2XCIgfCBcInNvdXJjZS1hcmNoaXZlXCIgfCBcInVua25vd25cIjtcbiAgbGFiZWw6IHN0cmluZztcbiAgZGV0YWlsOiBzdHJpbmc7XG59XG5cbnR5cGUgRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlID0gXCJjaGF0Z3B0XCIgfCBcInR3ZWFrZXJzXCI7XG50eXBlIEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUgPSBcInN0YWJsZVwiIHwgXCJhbHBoYVwiO1xuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRTZWxlY3Rpb24ge1xuICBhcHBFeHBlcmllbmNlOiBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2U7XG4gIHJlbGVhc2VQcm9maWxlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlO1xuICBzZWxlY3RlZERlc2t0b3BQYXRoPzogc3RyaW5nO1xuICBzZWxlY3RlZERlc2t0b3BCdW5kbGVJZD86IHN0cmluZztcbiAgYmFja2VuZExhbmU/OiBzdHJpbmc7XG4gIHJlcXVlc3RlZEF0Pzogc3RyaW5nO1xuICBhcHBsaWVkQXQ/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRDaGFubmVsU3RhdHVzIHtcbiAgYXZhaWxhYmxlOiBib29sZWFuO1xuICB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXTtcbiAgYXZhaWxhYmlsaXR5PzogUmVjb3JkPEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSwge1xuICAgIGF2YWlsYWJsZTogYm9vbGVhbjtcbiAgICB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXTtcbiAgfT47XG4gIHNlbGVjdGVkRGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gIHNlbGVjdGVkRGVza3RvcEJ1bmRsZUlkPzogc3RyaW5nO1xuICByZWxlYXNlUHJvZmlsZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZTtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50U3RhdHVzIHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgc2VsZWN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICBjaGFubmVsczogUmVjb3JkPEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUsIEVudmlyb25tZW50Q2hhbm5lbFN0YXR1cz47XG4gIG9ic2VydmF0aW9uPzoge1xuICAgIGFwcEV4cGVyaWVuY2U6IEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSB8IG51bGw7XG4gICAgc2VsZWN0aW9uRHJpZnQ6IGJvb2xlYW47XG4gICAgbGlmZWN5Y2xlQ29udGVuZGVkOiBib29sZWFuO1xuICAgIGNvbW1pdEpvdXJuYWxQcmVzZW50OiBib29sZWFuO1xuICAgIHRyYW5zaXRpb25Kb3VybmFsUHJlc2VudDogYm9vbGVhbjtcbiAgICBmcmVzaG5lc3M6IFwiY3VycmVudFwiIHwgXCJjb250ZW5kZWRcIjtcbiAgfTtcbn1cblxuaW50ZXJmYWNlIEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbiB7XG4gIGtpbmQ/OiBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIjtcbiAgdHJhbnNhY3Rpb25JZDogc3RyaW5nO1xuICBwaGFzZTogXCJzdWJtaXR0ZWRcIiB8IFwic3VibWl0LWZhaWxlZFwiO1xuICBlcnJvcj86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudEhlbHBlck91dGNvbWUge1xuICBwaGFzZT86IFwibm90LXN0YXJ0ZWRcIiB8IFwicnVubmluZ1wiIHwgXCJzdWNjZWVkZWRcIiB8IFwiZmFpbGVkXCI7XG4gIGV4aXRDb2RlPzogbnVtYmVyIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xufVxuXG5pbnRlcmZhY2UgRW52aXJvbm1lbnRIZWxwZXJTdGF0dXMge1xuICBzdWJtaXNzaW9uPzogRW52aXJvbm1lbnRIZWxwZXJTdWJtaXNzaW9uIHwgbnVsbDtcbiAgb3V0Y29tZT86IEVudmlyb25tZW50SGVscGVyT3V0Y29tZSB8IG51bGw7XG4gIHN0ZG91dD86IHN0cmluZyB8IG51bGw7XG4gIHN0ZGVycj86IHN0cmluZyB8IG51bGw7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFRyYW5zYWN0aW9uIHtcbiAgc2NoZW1hVmVyc2lvbj86IDE7XG4gIHRyYW5zYWN0aW9uSWQ6IHN0cmluZztcbiAgcGhhc2U6IHN0cmluZztcbiAgZXJyb3I6IHN0cmluZyB8IG51bGw7XG4gIHNvdXJjZT86IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICByZXF1ZXN0ZWQ/OiBFbnZpcm9ubWVudFNlbGVjdGlvbjtcbiAgcHJlcGFyZWQ/OiB7XG4gICAgY2FuZGlkYXRlPzoge1xuICAgICAgZGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gICAgICBidW5kbGVJZD86IHN0cmluZztcbiAgICAgIHZlcnNpb24/OiBzdHJpbmc7XG4gICAgICBidWlsZD86IHN0cmluZztcbiAgICB9O1xuICAgIGJhY2tlbmQ/OiB7XG4gICAgICBsYW5lPzogc3RyaW5nO1xuICAgICAgYmluYXJ5UGF0aD86IHN0cmluZztcbiAgICAgIHZlcnNpb24/OiBzdHJpbmc7XG4gICAgfTtcbiAgICByb2xsYmFjaz86IHtcbiAgICAgIHNlbGVjdGlvbj86IEVudmlyb25tZW50U2VsZWN0aW9uO1xuICAgICAgZGVza3RvcFBhdGg/OiBzdHJpbmc7XG4gICAgICBiYWNrZW5kTGFuZT86IHN0cmluZztcbiAgICB9O1xuICB9IHwgbnVsbDtcbiAgaGVscGVyPzogRW52aXJvbm1lbnRIZWxwZXJTdGF0dXMgfCBudWxsO1xuICB1cGRhdGVkQXQ/OiBzdHJpbmc7XG59XG5cbmludGVyZmFjZSBNY3BTeW5jU3RhdGUge1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIGNoZWNrZWRBdD86IHN0cmluZztcbiAgY29tcGxldGVkQXQ/OiBzdHJpbmc7XG4gIGRlc2lyZWROYW1lcz86IHN0cmluZ1tdO1xuICBhcHBsaWVkTmFtZXM/OiBzdHJpbmdbXTtcbiAgY29uZmxpY3RzPzogQXJyYXk8e1xuICAgIG5hbWU/OiBzdHJpbmc7XG4gICAgb2JzZXJ2ZWROYW1lPzogc3RyaW5nO1xuICAgIGNhbm9uaWNhbE5hbWU/OiBzdHJpbmc7XG4gICAgZGV0YWlsPzogc3RyaW5nO1xuICAgIHJlYXNvbj86IHN0cmluZztcbiAgfT47XG4gIHJlc3RhcnRSZXF1aXJlZD86IGJvb2xlYW47XG4gIGVycm9yPzogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRGVza3RvcFVwZGF0ZUNoZWNrUmVzdWx0IHtcbiAgc3RhdHVzPzogXCJ1cGRhdGUtYXZhaWxhYmxlXCIgfCBcImN1cnJlbnRcIiB8IFwic3RhbGVcIiB8IFwidW5hdmFpbGFibGVcIiB8IFwiZXJyb3JcIjtcbiAgcHJvZmlsZT86IFwic3RhYmxlXCIgfCBcImFscGhhXCIgfCBudWxsO1xuICBpbnN0YWxsZWQ/OiB7IG1hcmtldGluZ1ZlcnNpb24/OiBzdHJpbmcgfCBudWxsOyBidWlsZD86IHN0cmluZyB8IG51bGwgfTtcbiAgbGF0ZXN0PzogeyBtYXJrZXRpbmdWZXJzaW9uPzogc3RyaW5nIHwgbnVsbDsgYnVpbGQ/OiBzdHJpbmcgfCBudWxsIH07XG4gIHJlYXNvbj86IHN0cmluZyB8IG51bGw7XG4gIGNoZWNrZWRBdD86IHN0cmluZztcbiAgdXBkYXRlQW5kUmVsb2FkUmVxdWVzdGVkPzogYm9vbGVhbjtcbiAgbmF0aXZlVXBkYXRlQ29udHJvbEFjdGl2ZT86IGJvb2xlYW47XG4gIGphdmFTY3JpcHRVcGRhdGVyTWFuYWdlckF2YWlsYWJsZT86IGJvb2xlYW47XG4gIGphdmFTY3JpcHRVcGRhdGVyTWFuYWdlclJlYXNvbj86IHN0cmluZyB8IG51bGw7XG4gIHNldHVwUmVxdWlyZWQ/OiBcInJlZ2lzdGVyLWJldGFcIiB8IFwibGF1bmNoLWJldGFcIiB8IG51bGw7XG59XG5cbmludGVyZmFjZSBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSB7XG4gIHNjaGVtYVZlcnNpb24/OiAxO1xuICBraW5kPzogXCJkZXNrdG9wLXVwZGF0ZVwiO1xuICB0cmFuc2FjdGlvbklkOiBzdHJpbmcgfCBudWxsO1xuICBwaGFzZTogc3RyaW5nO1xuICBvd25lclBpZD86IG51bWJlcjtcbiAgc2FmZU9mZmljaWFsTW9kZT86IGJvb2xlYW47XG4gIHJlc3VtYWJsZT86IGJvb2xlYW47XG4gIG5hdGl2ZVVwZGF0ZUhhbmRvZmZBdD86IHN0cmluZyB8IG51bGw7XG4gIHJlZnJlc2hTb3VyY2U/OiBcImRldmVsb3BtZW50XCIgfCBcInN0YWJsZVwiIHwgbnVsbDtcbiAgZW52aXJvbm1lbnRUcmFuc2FjdGlvbklkPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xuICB1cGRhdGVkQXQ/OiBzdHJpbmc7XG4gIGJsb2Nrc0xpZmVjeWNsZT86IGJvb2xlYW47XG59XG5cbnR5cGUgQ29kZXhVaVJlbG9hZCA9IChtb2RlPzogXCJvcGVyYXRpb24tc3RhcnRcIiB8IFwib3BlcmF0aW9uLXN0b3BcIikgPT4gdm9pZDtcblxuaW50ZXJmYWNlIFdhdGNoZXJIZWFsdGgge1xuICBjaGVja2VkQXQ6IHN0cmluZztcbiAgc3RhdHVzOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIjtcbiAgdGl0bGU6IHN0cmluZztcbiAgc3VtbWFyeTogc3RyaW5nO1xuICB3YXRjaGVyOiBzdHJpbmc7XG4gIGNoZWNrczogV2F0Y2hlckhlYWx0aENoZWNrW107XG4gIGxhdGVzdENvbXBsZXRlZEN5Y2xlPzogV2F0Y2hlckN5Y2xlUmVjZWlwdDtcbn1cblxuaW50ZXJmYWNlIFdhdGNoZXJDeWNsZVJlY2VpcHQge1xuICBjeWNsZUlkOiBzdHJpbmc7XG4gIGNvbXBsZXRlZEF0OiBzdHJpbmc7XG4gIG91dGNvbWU6IFwiY29tcGxldGVkXCIgfCBcImZhaWxlZFwiO1xuICByZXBhaXI6IHsgc3RhdHVzOiBcInN1Y2NlZWRlZFwiIHwgXCJmYWlsZWRcIiB8IFwic2tpcHBlZFwiIHwgXCJwZW5kaW5nXCI7IGVycm9yOiBzdHJpbmcgfCBudWxsIH07XG59XG5cbmludGVyZmFjZSBXYXRjaGVySGVhbHRoQ2hlY2sge1xuICBuYW1lOiBzdHJpbmc7XG4gIHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCI7XG4gIGRldGFpbDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB7XG4gIHNjaGVtYVZlcnNpb246IDE7XG4gIGdlbmVyYXRlZEF0Pzogc3RyaW5nO1xuICBzb3VyY2VVcmw6IHN0cmluZztcbiAgZmV0Y2hlZEF0OiBzdHJpbmc7XG4gIGVudHJpZXM6IFR3ZWFrU3RvcmVFbnRyeVZpZXdbXTtcbn1cblxuaW50ZXJmYWNlIFR3ZWFrU3RvcmVFbnRyeVZpZXcgZXh0ZW5kcyBUd2Vha1N0b3JlRW50cnkge1xuICBpbnN0YWxsZWQ6IHtcbiAgICB2ZXJzaW9uOiBzdHJpbmc7XG4gICAgZW5hYmxlZDogYm9vbGVhbjtcbiAgfSB8IG51bGw7XG4gIHBsYXRmb3JtPzoge1xuICAgIGN1cnJlbnQ6IHN0cmluZztcbiAgICBzdXBwb3J0ZWQ6IHN0cmluZ1tdIHwgbnVsbDtcbiAgICBjb21wYXRpYmxlOiBib29sZWFuO1xuICAgIHJlYXNvbjogc3RyaW5nIHwgbnVsbDtcbiAgfTtcbiAgcnVudGltZT86IHtcbiAgICBjdXJyZW50OiBzdHJpbmc7XG4gICAgcmVxdWlyZWQ6IHN0cmluZyB8IG51bGw7XG4gICAgY29tcGF0aWJsZTogYm9vbGVhbjtcbiAgICByZWFzb246IHN0cmluZyB8IG51bGw7XG4gIH07XG59XG5cbi8qKlxuICogQSB0d2Vhay1yZWdpc3RlcmVkIHBhZ2UuIFdlIGNhcnJ5IHRoZSBvd25pbmcgdHdlYWsncyBtYW5pZmVzdCBzbyB3ZSBjYW5cbiAqIHJlc29sdmUgcmVsYXRpdmUgaWNvblVybHMgYW5kIHNob3cgYXV0aG9yc2hpcCBpbiB0aGUgcGFnZSBoZWFkZXIuXG4gKi9cbmludGVyZmFjZSBSZWdpc3RlcmVkUGFnZSB7XG4gIC8qKiBGdWxseS1xdWFsaWZpZWQgaWQ6IGA8dHdlYWtJZD46PHBhZ2VJZD5gLiAqL1xuICBpZDogc3RyaW5nO1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBwYWdlOiBTZXR0aW5nc1BhZ2U7XG4gIC8qKiBQZXItcGFnZSBET00gdGVhcmRvd24gcmV0dXJuZWQgYnkgYHBhZ2UucmVuZGVyYCwgaWYgYW55LiAqL1xuICB0ZWFyZG93bj86ICgoKSA9PiB2b2lkKSB8IG51bGw7XG4gIC8qKiBUaGUgaW5qZWN0ZWQgc2lkZWJhciBidXR0b24gKHNvIHdlIGNhbiB1cGRhdGUgaXRzIGFjdGl2ZSBzdGF0ZSkuICovXG4gIG5hdkJ1dHRvbj86IEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgLyoqIElkZW50aXR5IHRva2VuIHByZXZlbnRzIGFuIG9sZCBoYW5kbGUgZnJvbSB1bnJlZ2lzdGVyaW5nIGEgcmVwbGFjZW1lbnQuICovXG4gIHJlZ2lzdHJhdGlvblRva2VuOiBzeW1ib2w7XG59XG5cbi8qKiBXaGF0IHBhZ2UgaXMgY3VycmVudGx5IHNlbGVjdGVkIGluIG91ciBpbmplY3RlZCBuYXYuICovXG50eXBlIEFjdGl2ZVBhZ2UgPVxuICB8IHsga2luZDogXCJjb25maWdcIiB9XG4gIHwgeyBraW5kOiBcInN0b3JlXCIgfVxuICB8IHsga2luZDogXCJ0d2Vha3NcIiB9XG4gIHwgeyBraW5kOiBcInJlZ2lzdGVyZWRcIjsgaWQ6IHN0cmluZyB9O1xuXG5pbnRlcmZhY2UgSW5qZWN0b3JTdGF0ZSB7XG4gIHNlY3Rpb25zOiBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb24+O1xuICBzZWN0aW9uVG9rZW5zOiBNYXA8c3RyaW5nLCBzeW1ib2w+O1xuICBwYWdlczogTWFwPHN0cmluZywgUmVnaXN0ZXJlZFBhZ2U+O1xuICBsaXN0ZWRUd2Vha3M6IExpc3RlZFR3ZWFrW107XG4gIC8qKiBPdXRlciB3cmFwcGVyIHRoYXQgaG9sZHMgQ29kZXgncyBpdGVtcyBncm91cCArIG91ciBpbmplY3RlZCBncm91cHMuICovXG4gIG91dGVyV3JhcHBlcjogSFRNTEVsZW1lbnQgfCBudWxsO1xuICAvKiogT3VyIFwiR2VuZXJhbFwiIGxhYmVsIGZvciBDb2RleCdzIG5hdGl2ZSBzZXR0aW5ncyBncm91cC4gKi9cbiAgbmF0aXZlTmF2SGVhZGVyOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJUd2Vha2Vyc1wiIG5hdiBncm91cCAoQ29uZmlnL1R3ZWFrcykuICovXG4gIG5hdkdyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIG5hdkJ1dHRvbnM6IFBhcnRpYWw8UmVjb3JkPEJ1aWx0aW5QYWdlLCBIVE1MQnV0dG9uRWxlbWVudD4+IHwgbnVsbDtcbiAgLyoqIFNpZGViYXIgdXBkYXRlIHBpbGwgc2hvd24gb25seSB3aGVuIEdpdEh1YiBoYXMgYSBuZXdlciBUd2Vha2VycyByZWxlYXNlLiAqL1xuICB0d2Vha2VyVXBkYXRlQnV0dG9uOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gIC8qKiBPdXIgXCJUd2Vha3NcIiBuYXYgZ3JvdXAgKHBlci10d2VhayBwYWdlcykuIENyZWF0ZWQgbGF6aWx5LiAqL1xuICBwYWdlc0dyb3VwOiBIVE1MRWxlbWVudCB8IG51bGw7XG4gIHBhZ2VzR3JvdXBLZXk6IHN0cmluZyB8IG51bGw7XG4gIHBhZ2VOYXZCdXR0b25zOiBNYXA8c3RyaW5nLCBIVE1MQnV0dG9uRWxlbWVudD47XG4gIHBhbmVsSG9zdDogSFRNTEVsZW1lbnQgfCBudWxsO1xuICBvYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGw7XG4gIGZpbmdlcnByaW50OiBzdHJpbmcgfCBudWxsO1xuICBzaWRlYmFyRHVtcGVkOiBib29sZWFuO1xuICBhY3RpdmVQYWdlOiBBY3RpdmVQYWdlIHwgbnVsbDtcbiAgc2lkZWJhclJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiAoKGU6IEV2ZW50KSA9PiB2b2lkKSB8IG51bGw7XG4gIHNldHRpbmdzU3VyZmFjZVZpc2libGU6IGJvb2xlYW47XG4gIHNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsO1xuICAvKiogTGFzdCB0cnlJbmplY3Qgc2lkZWJhciBwcm9iZSBvdXRjb21lIHNvIHJlcGVhdGVkIG1pc3NlcyBsb2cgb25jZSBwZXIgdHJhbnNpdGlvbi4gKi9cbiAgc2lkZWJhclByb2JlU3RhdHVzOiBcImZvdW5kXCIgfCBcIm1pc3NpbmdcIiB8IFwicmVqZWN0ZWRcIiB8IG51bGw7XG4gIHR3ZWFrU3RvcmU6IFR3ZWFrU3RvcmVSZWdpc3RyeVZpZXcgfCBudWxsO1xuICB0d2Vha1N0b3JlUHJvbWlzZTogUHJvbWlzZTxUd2Vha1N0b3JlUmVnaXN0cnlWaWV3PiB8IG51bGw7XG4gIHR3ZWFrU3RvcmVFcnJvcjogdW5rbm93bjtcbiAgdHdlYWtzUGFnZUZpbHRlcjogVHdlYWtzUGFnZUZpbHRlcjtcbiAgdHdlYWtzUGFnZVF1ZXJ5OiBzdHJpbmc7XG59XG5cbmNvbnN0IHN0YXRlOiBJbmplY3RvclN0YXRlID0ge1xuICBzZWN0aW9uczogbmV3IE1hcCgpLFxuICBzZWN0aW9uVG9rZW5zOiBuZXcgTWFwKCksXG4gIHBhZ2VzOiBuZXcgTWFwKCksXG4gIGxpc3RlZFR3ZWFrczogW10sXG4gIG91dGVyV3JhcHBlcjogbnVsbCxcbiAgbmF0aXZlTmF2SGVhZGVyOiBudWxsLFxuICBuYXZHcm91cDogbnVsbCxcbiAgbmF2QnV0dG9uczogbnVsbCxcbiAgdHdlYWtlclVwZGF0ZUJ1dHRvbjogbnVsbCxcbiAgcGFnZXNHcm91cDogbnVsbCxcbiAgcGFnZXNHcm91cEtleTogbnVsbCxcbiAgcGFnZU5hdkJ1dHRvbnM6IG5ldyBNYXAoKSxcbiAgcGFuZWxIb3N0OiBudWxsLFxuICBvYnNlcnZlcjogbnVsbCxcbiAgZmluZ2VycHJpbnQ6IG51bGwsXG4gIHNpZGViYXJEdW1wZWQ6IGZhbHNlLFxuICBhY3RpdmVQYWdlOiBudWxsLFxuICBzaWRlYmFyUm9vdDogbnVsbCxcbiAgc2lkZWJhclJlc3RvcmVIYW5kbGVyOiBudWxsLFxuICBzZXR0aW5nc1N1cmZhY2VWaXNpYmxlOiBmYWxzZSxcbiAgc2V0dGluZ3NTdXJmYWNlSGlkZVRpbWVyOiBudWxsLFxuICBzaWRlYmFyUHJvYmVTdGF0dXM6IG51bGwsXG4gIHR3ZWFrU3RvcmU6IG51bGwsXG4gIHR3ZWFrU3RvcmVQcm9taXNlOiBudWxsLFxuICB0d2Vha1N0b3JlRXJyb3I6IG51bGwsXG4gIHR3ZWFrc1BhZ2VGaWx0ZXI6IFwiYWxsXCIsXG4gIHR3ZWFrc1BhZ2VRdWVyeTogXCJcIixcbn07XG5cbmxldCBhY3RpdmVCdWlsdGluUGFnZUNsZWFudXA6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBwbG9nKG1zZzogc3RyaW5nLCBleHRyYT86IHVua25vd24pOiB2b2lkIHtcbiAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICBcInR3ZWFrZXI6cHJlbG9hZC1sb2dcIixcbiAgICBcImluZm9cIixcbiAgICBgW3NldHRpbmdzLWluamVjdG9yXSAke21zZ30ke2V4dHJhID09PSB1bmRlZmluZWQgPyBcIlwiIDogXCIgXCIgKyBzYWZlU3RyaW5naWZ5KGV4dHJhKX1gLFxuICApO1xufVxuZnVuY3Rpb24gc2FmZVN0cmluZ2lmeSh2OiB1bmtub3duKTogc3RyaW5nIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgPyB2IDogSlNPTi5zdHJpbmdpZnkodik7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBTdHJpbmcodik7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFydFNldHRpbmdzSW5qZWN0b3IoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5vYnNlcnZlcikgcmV0dXJuO1xuXG4gIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICB0cnlJbmplY3QoKTtcbiAgICBtYXliZUR1bXBEb20oKTtcbiAgfSk7XG4gIG9icy5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIHN0YXRlLm9ic2VydmVyID0gb2JzO1xuXG4gIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicG9wc3RhdGVcIiwgb25OYXYpO1xuICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihcImhhc2hjaGFuZ2VcIiwgb25OYXYpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25Eb2N1bWVudENsaWNrLCB0cnVlKTtcbiAgZm9yIChjb25zdCBtIG9mIFtcInB1c2hTdGF0ZVwiLCBcInJlcGxhY2VTdGF0ZVwiXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9yaWcgPSBoaXN0b3J5W21dO1xuICAgIGhpc3RvcnlbbV0gPSBmdW5jdGlvbiAodGhpczogSGlzdG9yeSwgLi4uYXJnczogUGFyYW1ldGVyczx0eXBlb2Ygb3JpZz4pIHtcbiAgICAgIGNvbnN0IHIgPSBvcmlnLmFwcGx5KHRoaXMsIGFyZ3MpO1xuICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEV2ZW50KGB0d2Vha2VyLSR7bX1gKSk7XG4gICAgICByZXR1cm4gcjtcbiAgICB9IGFzIHR5cGVvZiBvcmlnO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKGB0d2Vha2VyLSR7bX1gLCBvbk5hdik7XG4gIH1cblxuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG4gIGxldCB0aWNrcyA9IDA7XG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHRpY2tzKys7XG4gICAgdHJ5SW5qZWN0KCk7XG4gICAgbWF5YmVEdW1wRG9tKCk7XG4gICAgaWYgKHRpY2tzID4gNjApIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICB9LCA1MDApO1xufVxuXG5mdW5jdGlvbiBvbk5hdigpOiB2b2lkIHtcbiAgc3RhdGUuZmluZ2VycHJpbnQgPSBudWxsO1xuICB0cnlJbmplY3QoKTtcbiAgbWF5YmVEdW1wRG9tKCk7XG59XG5cbmZ1bmN0aW9uIG9uRG9jdW1lbnRDbGljayhlOiBNb3VzZUV2ZW50KTogdm9pZCB7XG4gIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGluc3RhbmNlb2YgRWxlbWVudCA/IGUudGFyZ2V0IDogbnVsbDtcbiAgY29uc3QgY29udHJvbCA9IHRhcmdldD8uY2xvc2VzdChcIltyb2xlPSdsaW5rJ10sYnV0dG9uLGFcIik7XG4gIGlmICghKGNvbnRyb2wgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCkpIHJldHVybjtcbiAgaWYgKGNvbXBhY3RTZXR0aW5nc1RleHQoY29udHJvbC50ZXh0Q29udGVudCB8fCBcIlwiKSAhPT0gXCJCYWNrIHRvIGFwcFwiKSByZXR1cm47XG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUoZmFsc2UsIFwiYmFjay10by1hcHBcIik7XG4gIH0sIDApO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTZWN0aW9uKHNlY3Rpb246IFNldHRpbmdzU2VjdGlvbik6IFNldHRpbmdzSGFuZGxlIHtcbiAgY29uc3QgcmVnaXN0cmF0aW9uVG9rZW4gPSBTeW1ib2woc2VjdGlvbi5pZCk7XG4gIHN0YXRlLnNlY3Rpb25zLnNldChzZWN0aW9uLmlkLCBzZWN0aW9uKTtcbiAgc3RhdGUuc2VjdGlvblRva2Vucy5zZXQoc2VjdGlvbi5pZCwgcmVnaXN0cmF0aW9uVG9rZW4pO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICB1bnJlZ2lzdGVyOiAoKSA9PiB7XG4gICAgICBpZiAoc3RhdGUuc2VjdGlvblRva2Vucy5nZXQoc2VjdGlvbi5pZCkgIT09IHJlZ2lzdHJhdGlvblRva2VuKSByZXR1cm47XG4gICAgICBzdGF0ZS5zZWN0aW9ucy5kZWxldGUoc2VjdGlvbi5pZCk7XG4gICAgICBzdGF0ZS5zZWN0aW9uVG9rZW5zLmRlbGV0ZShzZWN0aW9uLmlkKTtcbiAgICAgIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSByZXJlbmRlcigpO1xuICAgIH0sXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNlY3Rpb25zKCk6IHZvaWQge1xuICBzdGF0ZS5zZWN0aW9ucy5jbGVhcigpO1xuICBzdGF0ZS5zZWN0aW9uVG9rZW5zLmNsZWFyKCk7XG4gIC8vIERyb3AgcmVnaXN0ZXJlZCBwYWdlcyB0b28gXHUyMDE0IHRoZXkncmUgb3duZWQgYnkgdHdlYWtzIHRoYXQganVzdCBnb3RcbiAgLy8gdG9ybiBkb3duIGJ5IHRoZSBob3N0LiBSdW4gYW55IHRlYXJkb3ducyBiZWZvcmUgZm9yZ2V0dGluZyB0aGVtLlxuICBmb3IgKGNvbnN0IHAgb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICB0cnkge1xuICAgICAgcC50ZWFyZG93bj8uKCk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgcGxvZyhcInBhZ2UgdGVhcmRvd24gZmFpbGVkXCIsIHsgaWQ6IHAuaWQsIGVycjogU3RyaW5nKGUpIH0pO1xuICAgIH1cbiAgfVxuICBzdGF0ZS5wYWdlcy5jbGVhcigpO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICAvLyBFeHBsaWNpdCBwYWdlcyBtYXkgZGlzYXBwZWFyIGJyaWVmbHkgZHVyaW5nIGEgaG90IHJlbG9hZC4gS2VlcCB0aGUgc3RhYmxlXG4gIC8vIHR3ZWFrLWxldmVsIHBhZ2UgYWN0aXZlIGFuZCByZW5kZXIgaXRzIGZhbGxiYWNrIGluc3RlYWQgb2YgZWplY3RpbmcgdGhlXG4gIC8vIHVzZXIgZnJvbSBTZXR0aW5ncy5cbiAgaWYgKFxuICAgIHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmXG4gICAgIXNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oc3RhdGUuYWN0aXZlUGFnZS5pZClcbiAgKSB7XG4gICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfSBlbHNlIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInR3ZWFrc1wiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxufVxuXG4vKipcbiAqIFJlZ2lzdGVyIGEgdHdlYWstb3duZWQgc2V0dGluZ3MgcGFnZS4gVGhlIHJ1bnRpbWUgaW5qZWN0cyBhIHNpZGViYXIgZW50cnlcbiAqIHVuZGVyIGEgXCJUV0VBS1NcIiBncm91cCBoZWFkZXIgKHdoaWNoIGFwcGVhcnMgb25seSB3aGVuIGF0IGxlYXN0IG9uZSBwYWdlXG4gKiBpcyByZWdpc3RlcmVkKSBhbmQgcm91dGVzIGNsaWNrcyB0byB0aGUgcGFnZSdzIGByZW5kZXIocm9vdClgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJQYWdlKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LFxuICBwYWdlOiBTZXR0aW5nc1BhZ2UsXG4pOiBTZXR0aW5nc0hhbmRsZSB7XG4gIGNvbnN0IGlkID0gcGFnZS5pZDsgLy8gYWxyZWFkeSBuYW1lc3BhY2VkIGJ5IHR3ZWFrLWhvc3QgYXMgYCR7dHdlYWtJZH06JHtwYWdlLmlkfWBcbiAgY29uc3QgZXhpc3RpbmcgPSBzdGF0ZS5wYWdlcy5nZXQoaWQpO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICB0cnkgeyBleGlzdGluZy50ZWFyZG93bj8uKCk7IH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCByZWdpc3RyYXRpb25Ub2tlbiA9IFN5bWJvbChpZCk7XG4gIGNvbnN0IGVudHJ5OiBSZWdpc3RlcmVkUGFnZSA9IHsgaWQsIHR3ZWFrSWQsIG1hbmlmZXN0LCBwYWdlLCByZWdpc3RyYXRpb25Ub2tlbiB9O1xuICBzdGF0ZS5wYWdlcy5zZXQoaWQsIGVudHJ5KTtcbiAgcGxvZyhcInJlZ2lzdGVyUGFnZVwiLCB7IGlkLCB0aXRsZTogcGFnZS50aXRsZSwgdHdlYWtJZCB9KTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgLy8gSWYgdGhlIHVzZXIgd2FzIGFscmVhZHkgb24gdGhpcyBwYWdlIChob3QgcmVsb2FkKSwgcmUtbW91bnQgaXRzIGJvZHkuXG4gIGlmIChzdGF0ZS5hY3RpdmVQYWdlPy5raW5kID09PSBcInJlZ2lzdGVyZWRcIiAmJiBzdGF0ZS5hY3RpdmVQYWdlLmlkID09PSB0d2Vha0lkKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIHVucmVnaXN0ZXI6ICgpID0+IHtcbiAgICAgIGNvbnN0IGUgPSBzdGF0ZS5wYWdlcy5nZXQoaWQpO1xuICAgICAgaWYgKCFlIHx8IGUucmVnaXN0cmF0aW9uVG9rZW4gIT09IHJlZ2lzdHJhdGlvblRva2VuKSByZXR1cm47XG4gICAgICB0cnkge1xuICAgICAgICBlLnRlYXJkb3duPy4oKTtcbiAgICAgIH0gY2F0Y2gge31cbiAgICAgIHN0YXRlLnBhZ2VzLmRlbGV0ZShpZCk7XG4gICAgICBzeW5jUGFnZXNHcm91cCgpO1xuICAgICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIHN0YXRlLmFjdGl2ZVBhZ2UuaWQgPT09IHR3ZWFrSWQpIHJlcmVuZGVyKCk7XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIENhbGxlZCBieSB0aGUgdHdlYWsgaG9zdCBhZnRlciBmZXRjaGluZyB0aGUgdHdlYWsgbGlzdCBmcm9tIG1haW4uICovXG5leHBvcnQgZnVuY3Rpb24gc2V0TGlzdGVkVHdlYWtzKGxpc3Q6IExpc3RlZFR3ZWFrW10pOiB2b2lkIHtcbiAgc3RhdGUubGlzdGVkVHdlYWtzID0gbGlzdDtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmICFzZXR0aW5nc05hdmlnYXRpb25JdGVtKHN0YXRlLmFjdGl2ZVBhZ2UuaWQpKSB7XG4gICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICB9IGVsc2UgaWYgKHN0YXRlLmFjdGl2ZVBhZ2U/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgcmVyZW5kZXIoKTtcbiAgfVxuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJ0d2Vha3NcIikgcmVyZW5kZXIoKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUxpc3RlZFR3ZWFrTGlmZWN5Y2xlKGlkOiBzdHJpbmcsIGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtcImxpZmVjeWNsZVwiXSwgZXJyb3I/OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgdHdlYWsgPSBzdGF0ZS5saXN0ZWRUd2Vha3MuZmluZCgoaXRlbSkgPT4gaXRlbS5tYW5pZmVzdC5pZCA9PT0gaWQpO1xuICBpZiAoIXR3ZWFrKSByZXR1cm47XG4gIHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlID0gbGlmZWN5Y2xlO1xuICBpZiAoZXJyb3IpIHR3ZWFrLmhlYWx0aCA9IHsgc3RhdHVzOiBsaWZlY3ljbGUgPT09IFwicXVhcmFudGluZWRcIiA/IFwicXVhcmFudGluZWRcIiA6IFwiZmFpbGVkXCIsIHVwZGF0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBlcnJvciB9O1xuICBlbHNlIGlmIChsaWZlY3ljbGUgPT09IFwic3RhcnRpbmdcIiB8fCBsaWZlY3ljbGUgPT09IFwiZW5hYmxlZFwiKSB0d2Vhay5oZWFsdGggPSBudWxsO1xuICBzeW5jUGFnZXNHcm91cCgpO1xuICBpZiAoc3RhdGUuYWN0aXZlUGFnZT8ua2luZCA9PT0gXCJyZWdpc3RlcmVkXCIgJiYgc3RhdGUuYWN0aXZlUGFnZS5pZCA9PT0gaWQpIHJlcmVuZGVyKCk7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdzTmF2aWdhdGlvbkl0ZW1zKCk6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSB7XG4gIHJldHVybiBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsKFxuICAgIHN0YXRlLmxpc3RlZFR3ZWFrcy5tYXAoKHR3ZWFrKSA9PiAoe1xuICAgICAgaWQ6IHR3ZWFrLm1hbmlmZXN0LmlkLFxuICAgICAgbmFtZTogdHdlYWsubWFuaWZlc3QubmFtZSxcbiAgICAgIHZlcnNpb246IHR3ZWFrLm1hbmlmZXN0LnZlcnNpb24sXG4gICAgICBkZXNjcmlwdGlvbjogdHdlYWsubWFuaWZlc3QuZGVzY3JpcHRpb24sXG4gICAgICBpY29uVXJsOiB0d2Vhay5tYW5pZmVzdC5pY29uVXJsLFxuICAgICAgZW5hYmxlZDogdHdlYWsuZW5hYmxlZCxcbiAgICAgIHN0YXR1czogdHdlYWsuc3RhdHVzLFxuICAgICAgaGVhbHRoRXJyb3I6IHR3ZWFrLmhlYWx0aD8uZXJyb3IgPz8gbnVsbCxcbiAgICAgIGxpZmVjeWNsZU92ZXJyaWRlOiB0d2Vhay5saWZlY3ljbGVPdmVycmlkZSxcbiAgICB9KSksXG4gICAgWy4uLnN0YXRlLnBhZ2VzLnZhbHVlcygpXS5tYXAoKGVudHJ5KSA9PiAoe1xuICAgICAgaWQ6IGVudHJ5LmlkLFxuICAgICAgdHdlYWtJZDogZW50cnkudHdlYWtJZCxcbiAgICAgIHRpdGxlOiBlbnRyeS5wYWdlLnRpdGxlLFxuICAgICAgZGVzY3JpcHRpb246IGVudHJ5LnBhZ2UuZGVzY3JpcHRpb24sXG4gICAgICBpY29uU3ZnOiBlbnRyeS5wYWdlLmljb25TdmcsXG4gICAgfSkpLFxuICApO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nc05hdmlnYXRpb25JdGVtKHR3ZWFrSWQ6IHN0cmluZyk6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0gfCBudWxsIHtcbiAgcmV0dXJuIHNldHRpbmdzTmF2aWdhdGlvbkl0ZW1zKCkuZmluZCgoaXRlbSkgPT4gaXRlbS50d2Vha0lkID09PSB0d2Vha0lkKSA/PyBudWxsO1xufVxuXG5mdW5jdGlvbiByZWdpc3RlcmVkUGFnZXNGb3JUd2Vhayh0d2Vha0lkOiBzdHJpbmcpOiBSZWdpc3RlcmVkUGFnZVtdIHtcbiAgcmV0dXJuIFsuLi5zdGF0ZS5wYWdlcy52YWx1ZXMoKV0uZmlsdGVyKChlbnRyeSkgPT4gZW50cnkudHdlYWtJZCA9PT0gdHdlYWtJZCk7XG59XG5cbmZ1bmN0aW9uIGxpZmVjeWNsZUxhYmVsKGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uSXRlbVtcImxpZmVjeWNsZVwiXSwgd2FybmluZz86IHN0cmluZyB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCBsYWJlbCA9IGxpZmVjeWNsZSA9PT0gXCJlbmFibGVkXCIgPyBcIlJ1bm5pbmdcIlxuICAgIDogbGlmZWN5Y2xlID09PSBcInRpbWVkX291dFwiID8gXCJTdGFydHVwIHRpbWVkIG91dFwiXG4gICAgOiBsaWZlY3ljbGVbMF0udG9VcHBlckNhc2UoKSArIGxpZmVjeWNsZS5zbGljZSgxKTtcbiAgcmV0dXJuIHdhcm5pbmcgPyBgJHtsYWJlbH06ICR7d2FybmluZ31gIDogbGFiZWw7XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpbmplY3Rpb24gXHUyNTAwXHUyNTAwXG5cbmZ1bmN0aW9uIHRyeUluamVjdCgpOiB2b2lkIHtcbiAgaWYgKGlzTmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkKCkpIHJldHVybjtcbiAgcmVtb3ZlTWlzcGxhY2VkU2V0dGluZ3NHcm91cHMoKTtcblxuICBjb25zdCBpdGVtc0dyb3VwID0gZmluZFNpZGViYXJJdGVtc0dyb3VwKCk7XG4gIGlmICghaXRlbXNHcm91cCkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgLy8gdHJ5SW5qZWN0IHBvbGxzIGV2ZXJ5IDUwMG1zOyBsb2cgb25seSBvbiB0aGUgdHJhbnNpdGlvbiBpbnRvIHRoaXMgc3RhdGVcbiAgICAvLyBzbyByZXBlYXRlZCBtaXNzZXMgZG9uJ3QgZmxvb2QgcHJlbG9hZC5sb2cuXG4gICAgaWYgKHN0YXRlLnNpZGViYXJQcm9iZVN0YXR1cyAhPT0gXCJtaXNzaW5nXCIpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJQcm9iZVN0YXR1cyA9IFwibWlzc2luZ1wiO1xuICAgICAgcGxvZyhcInNpZGViYXIgbm90IGZvdW5kXCIpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIpO1xuICAgIHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lciA9IG51bGw7XG4gIH1cbiAgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh0cnVlLCBcInNpZGViYXItZm91bmRcIik7XG4gIC8vIEtlZXAgbmF0aXZlIGFuZCBUd2Vha2VycyBlbnRyaWVzIGluIHRoZSBzYW1lIHNjcm9sbCBjb250YWluZXIuIEFwcGVuZGluZ1xuICAvLyB0byB0aGUgcGFyZW50IGNyZWF0ZWQgYSBzZWNvbmQgaW5kZXBlbmRlbnRseSBzY3JvbGxpbmcgc2lkZWJhciByZWdpb24uXG4gIGNvbnN0IG91dGVyID0gaXRlbXNHcm91cDtcbiAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShpdGVtc0dyb3VwKSkge1xuICAgIHNjaGVkdWxlU2V0dGluZ3NTdXJmYWNlSGlkZGVuKCk7XG4gICAgLy8gU2FtZSB0cmFuc2l0aW9uLW9ubHkgdGhyb3R0bGluZyBhcyB0aGUgXCJzaWRlYmFyIG5vdCBmb3VuZFwiIGJyYW5jaC5cbiAgICBpZiAoc3RhdGUuc2lkZWJhclByb2JlU3RhdHVzICE9PSBcInJlamVjdGVkXCIpIHtcbiAgICAgIHN0YXRlLnNpZGViYXJQcm9iZVN0YXR1cyA9IFwicmVqZWN0ZWRcIjtcbiAgICAgIHBsb2coXCJyZWplY3RlZCBub24tc2V0dGluZ3Mgc2lkZWJhciBjYW5kaWRhdGVcIiwge1xuICAgICAgICBpdGVtc0dyb3VwOiBkZXNjcmliZShpdGVtc0dyb3VwKSxcbiAgICAgICAgb3V0ZXI6IGRlc2NyaWJlKG91dGVyKSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cbiAgLy8gU3VjY2VzcyB0cmFuc2l0aW9uIGFscmVhZHkgbG9ncyB2aWEgc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZShcInNpZGViYXItZm91bmRcIikuXG4gIHN0YXRlLnNpZGViYXJQcm9iZVN0YXR1cyA9IFwiZm91bmRcIjtcbiAgc3RhdGUuc2lkZWJhclJvb3QgPSBvdXRlcjtcbiAgc3luY05hdGl2ZVNldHRpbmdzSGVhZGVyKGl0ZW1zR3JvdXAsIG91dGVyKTtcbiAgYmluZFNldHRpbmdzU2VhcmNoKG91dGVyKTtcblxuICBpZiAoc3RhdGUubmF2R3JvdXAgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF2R3JvdXApKSB7XG4gICAgc3luY1BhZ2VzR3JvdXAoKTtcbiAgICAvLyBDb2RleCByZS1yZW5kZXJzIGl0cyBuYXRpdmUgc2lkZWJhciBidXR0b25zIG9uIGl0cyBvd24gc3RhdGUgY2hhbmdlcy5cbiAgICAvLyBJZiBvbmUgb2Ygb3VyIHBhZ2VzIGlzIGFjdGl2ZSwgcmUtc3RyaXAgQ29kZXgncyBhY3RpdmUgc3R5bGluZyBzb1xuICAgIC8vIEdlbmVyYWwgZG9lc24ndCByZWFwcGVhciBhcyBzZWxlY3RlZC5cbiAgICBpZiAoc3RhdGUuYWN0aXZlUGFnZSAhPT0gbnVsbCkgc3luY0NvZGV4TmF0aXZlTmF2QWN0aXZlKHRydWUpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFNpZGViYXIgd2FzIGVpdGhlciBmcmVzaGx5IG1vdW50ZWQgKFNldHRpbmdzIGp1c3Qgb3BlbmVkKSBvciByZS1tb3VudGVkXG4gIC8vIChjbG9zZWQgYW5kIHJlLW9wZW5lZCwgb3IgbmF2aWdhdGVkIGF3YXkgYW5kIGJhY2spLiBJbiBhbGwgb2YgdGhvc2VcbiAgLy8gY2FzZXMgQ29kZXggcmVzZXRzIHRvIGl0cyBkZWZhdWx0IHBhZ2UgKEdlbmVyYWwpLCBidXQgb3VyIGluLW1lbW9yeVxuICAvLyBgYWN0aXZlUGFnZWAgbWF5IHN0aWxsIHJlZmVyZW5jZSB0aGUgbGFzdCB0d2Vhay9wYWdlIHRoZSB1c2VyIGhhZCBvcGVuXG4gIC8vIFx1MjAxNCB3aGljaCB3b3VsZCBjYXVzZSB0aGF0IG5hdiBidXR0b24gdG8gcmVuZGVyIHdpdGggdGhlIGFjdGl2ZSBzdHlsaW5nXG4gIC8vIGV2ZW4gdGhvdWdoIENvZGV4IGlzIHNob3dpbmcgR2VuZXJhbC4gQ2xlYXIgaXQgc28gYHN5bmNQYWdlc0dyb3VwYCAvXG4gIC8vIGBzZXROYXZBY3RpdmVgIHN0YXJ0IGZyb20gYSBuZXV0cmFsIHN0YXRlLiBUaGUgcGFuZWxIb3N0IHJlZmVyZW5jZSBpc1xuICAvLyBhbHNvIHN0YWxlIChpdHMgRE9NIHdhcyBkaXNjYXJkZWQgd2l0aCB0aGUgcHJldmlvdXMgY29udGVudCBhcmVhKS5cbiAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwgfHwgc3RhdGUucGFuZWxIb3N0ICE9PSBudWxsKSB7XG4gICAgcGxvZyhcInNpZGViYXIgcmUtbW91bnQgZGV0ZWN0ZWQ7IGNsZWFyaW5nIHN0YWxlIGFjdGl2ZSBzdGF0ZVwiLCB7XG4gICAgICBwcmV2QWN0aXZlOiBzdGF0ZS5hY3RpdmVQYWdlLFxuICAgIH0pO1xuICAgIHN0YXRlLmFjdGl2ZVBhZ2UgPSBudWxsO1xuICAgIHN0YXRlLnBhbmVsSG9zdCA9IG51bGw7XG4gIH1cblxuICBjb25zdCBleGlzdGluZ1R3ZWFrZXJOYXZHcm91cCA9XG4gICAgb3V0ZXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJzpzY29wZSA+IFtkYXRhLXR3ZWFrZXI9XCJuYXYtZ3JvdXBcIl0nKSA/P1xuICAgIG91dGVyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS10d2Vha2VyPVwibmF2LWdyb3VwXCJdJyk7XG5cbiAgaWYgKGV4aXN0aW5nVHdlYWtlck5hdkdyb3VwKSB7XG4gICAgc3RhdGUubmF2R3JvdXAgPSBleGlzdGluZ1R3ZWFrZXJOYXZHcm91cDtcbiAgICBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uID0gZXhpc3RpbmdUd2Vha2VyTmF2R3JvdXAucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXG4gICAgICBcIltkYXRhLXR3ZWFrZXItc2lkZWJhci11cGRhdGVdXCIsXG4gICAgKTtcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCA9IG91dGVyO1xuICAgIHN5bmNQYWdlc0dyb3VwKCk7XG4gICAgcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKCk7XG4gICAgaWYgKHN0YXRlLmFjdGl2ZVBhZ2UgIT09IG51bGwpIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZSh0cnVlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBcdTI1MDBcdTI1MDAgR3JvdXAgY29udGFpbmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGdyb3VwLmRhdGFzZXQudHdlYWtlciA9IFwibmF2LWdyb3VwXCI7XG4gIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcblxuICBjb25zdCB1cGRhdGVCdXR0b24gPSBzaWRlYmFyVXBkYXRlUGlsbEJ1dHRvbigpO1xuICBzdGF0ZS50d2Vha2VyVXBkYXRlQnV0dG9uID0gdXBkYXRlQnV0dG9uO1xuICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJUd2Vha2Vyc1wiLCBcInB0LTNcIiwgdXBkYXRlQnV0dG9uKSk7XG4gIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbigpO1xuXG4gIC8vIFx1MjUwMFx1MjUwMCBTaWRlYmFyIGl0ZW1zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICBjb25zdCBjb25maWdCdG4gPSBtYWtlU2lkZWJhckl0ZW0oXCJDb25maWdcIiwgY29uZmlnSWNvblN2ZygpKTtcbiAgY29uc3QgdHdlYWtzQnRuID0gbWFrZVNpZGViYXJJdGVtKFwiVHdlYWtzXCIsIHR3ZWFrc0ljb25TdmcoKSk7XG5cbiAgY29uZmlnQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBlLnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwiY29uZmlnXCIgfSk7XG4gIH0pO1xuICB0d2Vha3NCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgYWN0aXZhdGVQYWdlKHsga2luZDogXCJ0d2Vha3NcIiB9KTtcbiAgfSk7XG4gIGdyb3VwLmFwcGVuZENoaWxkKGNvbmZpZ0J0bik7XG4gIGdyb3VwLmFwcGVuZENoaWxkKHR3ZWFrc0J0bik7XG4gIG91dGVyLmFwcGVuZENoaWxkKGdyb3VwKTtcblxuICBzdGF0ZS5uYXZHcm91cCA9IGdyb3VwO1xuICBzdGF0ZS5uYXZCdXR0b25zID0geyBjb25maWc6IGNvbmZpZ0J0biwgdHdlYWtzOiB0d2Vha3NCdG4gfTtcbiAgbm90ZU5hdkdyb3VwSW5qZWN0aW9uKG91dGVyKTtcbiAgc3luY1BhZ2VzR3JvdXAoKTtcbn1cblxuLy8gQmFja3N0b3AgYWdhaW5zdCBpbmplY3QvcmVtb3ZlIGZlZWRiYWNrIGxvb3BzOiBpZiB0aGUgbmF2IGdyb3VwIG5lZWRzXG4vLyByZS1pbmplY3Rpb24gbW9yZSB0aGFuIGEgZmV3IHRpbWVzIGluIGEgc2hvcnQgd2luZG93LCBzb21ldGhpbmcgaXNcbi8vIGZpZ2h0aW5nIHVzIFx1MjAxNCBiYWNrIG9mZiBpbnN0ZWFkIG9mIHNhdHVyYXRpbmcgdGhlIGxvZyBhbmQgdGhlIENQVS5cbmNvbnN0IE5BVl9HUk9VUF9JTkpFQ1RJT05fV0lORE9XX01TID0gMTBfMDAwO1xuY29uc3QgTkFWX0dST1VQX0lOSkVDVElPTl9MSU1JVCA9IDU7XG5jb25zdCBOQVZfR1JPVVBfSU5KRUNUSU9OX0JBQ0tPRkZfTVMgPSAzMF8wMDA7XG5sZXQgbmF2R3JvdXBJbmplY3Rpb25zOiBudW1iZXJbXSA9IFtdO1xubGV0IG5hdkdyb3VwSW5qZWN0aW9uU3VwcHJlc3NlZFVudGlsID0gMDtcblxuZnVuY3Rpb24gaXNOYXZHcm91cEluamVjdGlvblN1cHByZXNzZWQoKTogYm9vbGVhbiB7XG4gIHJldHVybiBEYXRlLm5vdygpIDwgbmF2R3JvdXBJbmplY3Rpb25TdXBwcmVzc2VkVW50aWw7XG59XG5cbmZ1bmN0aW9uIG5vdGVOYXZHcm91cEluamVjdGlvbihvdXRlcjogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgbmF2R3JvdXBJbmplY3Rpb25zID0gbmF2R3JvdXBJbmplY3Rpb25zLmZpbHRlcigoYXQpID0+IG5vdyAtIGF0IDwgTkFWX0dST1VQX0lOSkVDVElPTl9XSU5ET1dfTVMpO1xuICBuYXZHcm91cEluamVjdGlvbnMucHVzaChub3cpO1xuICBpZiAobmF2R3JvdXBJbmplY3Rpb25zLmxlbmd0aCA+IE5BVl9HUk9VUF9JTkpFQ1RJT05fTElNSVQpIHtcbiAgICBuYXZHcm91cEluamVjdGlvblN1cHByZXNzZWRVbnRpbCA9IG5vdyArIE5BVl9HUk9VUF9JTkpFQ1RJT05fQkFDS09GRl9NUztcbiAgICBuYXZHcm91cEluamVjdGlvbnMgPSBbXTtcbiAgICBwbG9nKFwibmF2IGdyb3VwIHJlLWluamVjdGlvbiBsb29wIGRldGVjdGVkOyBiYWNraW5nIG9mZlwiLCB7XG4gICAgICBiYWNrb2ZmTXM6IE5BVl9HUk9VUF9JTkpFQ1RJT05fQkFDS09GRl9NUyxcbiAgICAgIG91dGVyVGFnOiBvdXRlci50YWdOYW1lLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBwbG9nKFwibmF2IGdyb3VwIGluamVjdGVkXCIsIHsgb3V0ZXJUYWc6IG91dGVyLnRhZ05hbWUgfSk7XG59XG5cbmZ1bmN0aW9uIHN5bmNOYXRpdmVTZXR0aW5nc0hlYWRlcihpdGVtc0dyb3VwOiBIVE1MRWxlbWVudCwgb3V0ZXI6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgJiYgb3V0ZXIuY29udGFpbnMoc3RhdGUubmF0aXZlTmF2SGVhZGVyKSkgcmV0dXJuO1xuXG4gIGNvbnN0IGhlYWRlciA9IHNpZGViYXJHcm91cEhlYWRlcihcIkdlbmVyYWxcIik7XG4gIGhlYWRlci5kYXRhc2V0LnR3ZWFrZXIgPSBcIm5hdGl2ZS1uYXYtaGVhZGVyXCI7XG4gIGlmIChvdXRlciA9PT0gaXRlbXNHcm91cCkgb3V0ZXIucHJlcGVuZChoZWFkZXIpO1xuICBlbHNlIG91dGVyLmluc2VydEJlZm9yZShoZWFkZXIsIGl0ZW1zR3JvdXApO1xuICBzdGF0ZS5uYXRpdmVOYXZIZWFkZXIgPSBoZWFkZXI7XG59XG5cbmZ1bmN0aW9uIGJpbmRTZXR0aW5nc1NlYXJjaChyb290OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBpbnB1dCA9IHJvb3QuY2xvc2VzdChcImFzaWRlLCBuYXYsIFtyb2xlPSduYXZpZ2F0aW9uJ10sIGRpdlwiKT8ucGFyZW50RWxlbWVudFxuICAgID8ucXVlcnlTZWxlY3RvcjxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W3BsYWNlaG9sZGVyKj0nU2VhcmNoIHNldHRpbmdzJyBpXVwiKVxuICAgID8/IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtwbGFjZWhvbGRlcio9J1NlYXJjaCBzZXR0aW5ncycgaV1cIik7XG4gIGlmICghaW5wdXQgfHwgaW5wdXQuZGF0YXNldC50d2Vha2Vyc1NlYXJjaEJvdW5kID09PSBcInRydWVcIikgcmV0dXJuO1xuICBpbnB1dC5kYXRhc2V0LnR3ZWFrZXJzU2VhcmNoQm91bmQgPSBcInRydWVcIjtcbiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImlucHV0XCIsICgpID0+IHtcbiAgICBjb25zdCBxdWVyeSA9IGlucHV0LnZhbHVlLnRyaW0oKS50b0xvY2FsZUxvd2VyQ2FzZSgpO1xuICAgIGZvciAoY29uc3QgYnV0dG9uIG9mIEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSkpIHtcbiAgICAgIGlmICghYnV0dG9uLmNsb3Nlc3QoXCJbZGF0YS10d2Vha2VyXVwiKSkgY29udGludWU7XG4gICAgICBidXR0b24uaGlkZGVuID0gISFxdWVyeSAmJiAhY29tcGFjdFNldHRpbmdzVGV4dChidXR0b24udGV4dENvbnRlbnQgPz8gXCJcIikudG9Mb2NhbGVMb3dlckNhc2UoKS5pbmNsdWRlcyhxdWVyeSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZ3JvdXAgb2YgQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlcj0nbmF2LWdyb3VwJ10sIFtkYXRhLXR3ZWFrZXI9J3BhZ2VzLWdyb3VwJ11cIikpKSB7XG4gICAgICBjb25zdCBidXR0b25zID0gQXJyYXkuZnJvbShncm91cC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gICAgICBncm91cC5oaWRkZW4gPSBidXR0b25zLmxlbmd0aCA+IDAgJiYgYnV0dG9ucy5ldmVyeSgoYnV0dG9uKSA9PiBidXR0b24uaGlkZGVuKTtcbiAgICB9XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzaWRlYmFyR3JvdXBIZWFkZXIodGV4dDogc3RyaW5nLCB0b3BQYWRkaW5nID0gXCJwdC0yXCIsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGhlYWRlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlci5jbGFzc05hbWUgPVxuICAgIGBweC1yb3cteCAke3RvcFBhZGRpbmd9IHBiLTEgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIHRleHQtWzExcHhdIGZvbnQtbWVkaXVtIHVwcGVyY2FzZSB0cmFja2luZy13aWRlciB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmQgc2VsZWN0LW5vbmVgO1xuICBjb25zdCBsYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBsYWJlbC5jbGFzc05hbWUgPSBcInRydW5jYXRlXCI7XG4gIGxhYmVsLnRleHRDb250ZW50ID0gdGV4dDtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGxhYmVsKTtcbiAgaWYgKHRyYWlsaW5nKSBoZWFkZXIuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICByZXR1cm4gaGVhZGVyO1xufVxuXG5mdW5jdGlvbiBzY2hlZHVsZVNldHRpbmdzU3VyZmFjZUhpZGRlbigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlIHx8IHN0YXRlLnNldHRpbmdzU3VyZmFjZUhpZGVUaW1lcikgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VIaWRlVGltZXIgPSBudWxsO1xuICAgIGNvbnN0IHNpZGViYXIgPSBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTtcbiAgICBpZiAoc2lkZWJhciAmJiBpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShzaWRlYmFyKSkgcmV0dXJuO1xuICAgIGlmIChpc1NldHRpbmdzVGV4dFZpc2libGUoKSkgcmV0dXJuO1xuICAgIHNldFNldHRpbmdzU3VyZmFjZVZpc2libGUoZmFsc2UsIFwic2lkZWJhci1ub3QtZm91bmRcIik7XG4gIH0sIDE1MDApO1xufVxuXG5mdW5jdGlvbiBpc1NldHRpbmdzVGV4dFZpc2libGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBuYXRpdmVTZXR0aW5nc1BhbmVsU2x1Z0NvdW50KGRvY3VtZW50KSA+PSAyO1xufVxuXG5mdW5jdGlvbiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gU3RyaW5nKHZhbHVlIHx8IFwiXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuY29uc3QgVFdFQUtFUl9DT1JFX1NFVFRJTkdTX0xBQkVMUyA9IFtcbiAgXCJHZW5lcmFsXCIsXG4gIFwiXHU1RTM4XHU4OUM0XCIsXG4gIFwiXHU5MDFBXHU3NTI4XCIsXG4gIFwiQXBwZWFyYW5jZVwiLFxuICBcIlx1NTkxNlx1ODlDMlwiLFxuICBcIkNvbmZpZ3VyYXRpb25cIixcbiAgXCJcdTkxNERcdTdGNkVcIixcbiAgXCJcdTlFRDhcdThCQTRcdTY3NDNcdTk2NTBcIixcbiAgXCJQZXJzb25hbGl6YXRpb25cIixcbiAgXCJcdTRFMkFcdTYwMjdcdTUzMTZcIixcbl0ubWFwKG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKTtcblxuY29uc3QgVFdFQUtFUl9FWFRFTkRFRF9TRVRUSU5HU19MQUJFTFMgPSBbXG4gIFwiQWNjb3VudFwiLFxuICBcIlx1OEQyNlx1NjIzN1wiLFxuICBcIlx1OEQyNlx1NTNGN1wiLFxuICBcIkdlbmVyYWxcIixcbiAgXCJcdTVFMzhcdTg5QzRcIixcbiAgXCJcdTkwMUFcdTc1MjhcIixcbiAgXCJBcHBlYXJhbmNlXCIsXG4gIFwiXHU1OTE2XHU4OUMyXCIsXG4gIFwiQ29uZmlndXJhdGlvblwiLFxuICBcIlx1OTE0RFx1N0Y2RVwiLFxuICBcIlx1OUVEOFx1OEJBNFx1Njc0M1x1OTY1MFwiLFxuICBcIlBlcnNvbmFsaXphdGlvblwiLFxuICBcIlx1NEUyQVx1NjAyN1x1NTMxNlwiLFxuICBcIktleWJvYXJkIHNob3J0Y3V0c1wiLFxuICBcIkFyY2hpdmVkIGNoYXRzXCIsXG4gIFwiVXNhZ2VcIixcbiAgXCJDb21wdXRlciB1c2VcIixcbiAgXCJCcm93c2VyIHVzZVwiLFxuICBcIk1DUCBzZXJ2ZXJzXCIsXG4gIFwiTUNQIFNlcnZlcnNcIixcbiAgXCJNQ1AgXHU2NzBEXHU1MkExXHU1NjY4XCIsXG4gIFwiR2l0XCIsXG4gIFwiRW52aXJvbm1lbnRzXCIsXG4gIFwiXHU3M0FGXHU1ODgzXCIsXG4gIFwiQ2xvdWQgRW52aXJvbm1lbnRzXCIsXG4gIFwiV29ya3RyZWVzXCIsXG4gIFwiQ29ubmVjdGlvbnNcIixcbiAgXCJQbHVnaW5zXCIsXG4gIFwiU2tpbGxzXCIsXG5dLm1hcChub3JtYWxpemVUd2Vha2VyU2V0dGluZ3NMYWJlbCk7XG5cbmNvbnN0IFRXRUFLRVJfU0VUVElOR1NfT05MWV9MQUJFTFMgPSBbXG4gIFwiR2VuZXJhbFwiLFxuICBcIlx1NUUzOFx1ODlDNFwiLFxuICBcIlx1OTAxQVx1NzUyOFwiLFxuICBcIkFwcGVhcmFuY2VcIixcbiAgXCJcdTU5MTZcdTg5QzJcIixcbiAgXCJDb25maWd1cmF0aW9uXCIsXG4gIFwiXHU5MTREXHU3RjZFXCIsXG4gIFwiXHU5RUQ4XHU4QkE0XHU2NzQzXHU5NjUwXCIsXG4gIFwiUGVyc29uYWxpemF0aW9uXCIsXG4gIFwiXHU0RTJBXHU2MDI3XHU1MzE2XCIsXG4gIFwiS2V5Ym9hcmQgc2hvcnRjdXRzXCIsXG4gIFwiQXJjaGl2ZWQgY2hhdHNcIixcbiAgXCJVc2FnZVwiLFxuICBcIkNvbXB1dGVyIHVzZVwiLFxuICBcIkJyb3dzZXIgdXNlXCIsXG4gIFwiTUNQIHNlcnZlcnNcIixcbiAgXCJNQ1AgU2VydmVyc1wiLFxuICBcIk1DUCBcdTY3MERcdTUyQTFcdTU2NjhcIixcbiAgXCJHaXRcIixcbiAgXCJFbnZpcm9ubWVudHNcIixcbiAgXCJcdTczQUZcdTU4ODNcIixcbiAgXCJDbG91ZCBFbnZpcm9ubWVudHNcIixcbiAgXCJXb3JrdHJlZXNcIixcbiAgXCJDb25uZWN0aW9uc1wiLFxuXS5tYXAobm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwpO1xuXG5jb25zdCBUV0VBS0VSX01BSU5fQVBQX05BVl9MQUJFTFMgPSBbXG4gIFwiTmV3IGNoYXRcIixcbiAgXCJRdWljayBjaGF0XCIsXG4gIFwiXHU1RkVCXHU5MDFGXHU1QkY5XHU4QkREXCIsXG4gIFwiU2VhcmNoXCIsXG4gIFwiXHU2NDFDXHU3RDIyXCIsXG4gIFwiUGx1Z2luc1wiLFxuICBcIlx1NjNEMlx1NEVGNlwiLFxuICBcIkF1dG9tYXRpb25zXCIsXG4gIFwiQXV0b21hdGlvblwiLFxuICBcIlx1ODFFQVx1NTJBOFx1NTMxNlwiLFxuICBcIkNoYXRzXCIsXG4gIFwiQ2hhdFwiLFxuICBcIlx1NUJGOVx1OEJERFwiLFxuICBcIlByb2plY3RzXCIsXG4gIFwiXHU5ODc5XHU3NkVFXCIsXG4gIFwiUGlubmVkXCIsXG4gIFwiU2V0dGluZ3NcIixcbiAgXCJcdThCQkVcdTdGNkVcIixcbiAgXCJXb3JrIGxvY2FsbHlcIixcbl0ubWFwKG5vcm1hbGl6ZVR3ZWFrZXJTZXR0aW5nc0xhYmVsKTtcblxuZnVuY3Rpb24gbm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjb21wYWN0U2V0dGluZ3NUZXh0KHZhbHVlKVxuICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9bXHUyMDE5XHUyMDE4YFx1MDBCNF0vZywgXCInXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlckNvbnRyb2xMYWJlbChlbDogSFRNTEVsZW1lbnQpOiBzdHJpbmcge1xuICByZXR1cm4gbm9ybWFsaXplVHdlYWtlclNldHRpbmdzTGFiZWwoXG4gICAgZWwuZ2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiKSB8fFxuICAgICAgZWwuZ2V0QXR0cmlidXRlKFwidGl0bGVcIikgfHxcbiAgICAgIGVsLnRleHRDb250ZW50IHx8XG4gICAgICBcIlwiLFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyU2V0dGluZ3NMYWJlbHNGcm9tKHJvb3Q6IFBhcmVudE5vZGUpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGNvbnRyb2xzID0gQXJyYXkuZnJvbShcbiAgICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiYnV0dG9uLGEsW3JvbGU9J2J1dHRvbiddLFtyb2xlPSdsaW5rJ11cIiksXG4gICk7XG5cbiAgcmV0dXJuIFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgY29udHJvbHNcbiAgICAgICAgLm1hcCh0d2Vha2VyQ29udHJvbExhYmVsKVxuICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICksXG4gIF07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzOiBzdHJpbmdbXSk6IHsgY29yZTogbnVtYmVyOyB0b3RhbDogbnVtYmVyIH0ge1xuICBjb25zdCBjb3JlID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHRvdGFsID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgZm9yIChjb25zdCBsYWJlbCBvZiBsYWJlbHMpIHtcbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBUV0VBS0VSX0NPUkVfU0VUVElOR1NfTEFCRUxTKSB7XG4gICAgICBpZiAodHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbCwgbWFya2VyKSkgY29yZS5hZGQobWFya2VyKTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IG1hcmtlciBvZiBUV0VBS0VSX0VYVEVOREVEX1NFVFRJTkdTX0xBQkVMUykge1xuICAgICAgaWYgKHR3ZWFrZXJMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWwsIG1hcmtlcikpIHRvdGFsLmFkZChtYXJrZXIpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IGNvcmU6IGNvcmUuc2l6ZSwgdG90YWw6IHRvdGFsLnNpemUgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtlckxhYmVsTWF0Y2hlc01hcmtlcihsYWJlbDogc3RyaW5nLCBtYXJrZXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gbGFiZWwgPT09IG1hcmtlciB8fCBsYWJlbC5pbmNsdWRlcyhtYXJrZXIpO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyTWFya2VyQ291bnQobGFiZWxzOiBzdHJpbmdbXSwgbWFya2Vyczogc3RyaW5nW10pOiBudW1iZXIge1xuICBjb25zdCBtYXRjaGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbGFiZWwgb2YgbGFiZWxzKSB7XG4gICAgZm9yIChjb25zdCBtYXJrZXIgb2YgbWFya2Vycykge1xuICAgICAgaWYgKHR3ZWFrZXJMYWJlbE1hdGNoZXNNYXJrZXIobGFiZWwsIG1hcmtlcikpIG1hdGNoZWQuYWRkKG1hcmtlcik7XG4gICAgfVxuICB9XG4gIHJldHVybiBtYXRjaGVkLnNpemU7XG59XG5cbmZ1bmN0aW9uIG5hdGl2ZVNldHRpbmdzUGFuZWxTbHVnQ291bnQocm9vdDogUGFyZW50Tm9kZSk6IG51bWJlciB7XG4gIGNvbnN0IHNsdWdzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgZWxlbWVudCBvZiBBcnJheS5mcm9tKHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJbZGF0YS1zZXR0aW5ncy1wYW5lbC1zbHVnXVwiKSkpIHtcbiAgICBpZiAoZWxlbWVudC5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlcl1cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHNsdWcgPSBlbGVtZW50LmRhdGFzZXQuc2V0dGluZ3NQYW5lbFNsdWc/LnRyaW0oKTtcbiAgICBpZiAoc2x1Zykgc2x1Z3MuYWRkKHNsdWcpO1xuICB9XG4gIHJldHVybiBzbHVncy5zaXplO1xufVxuXG5mdW5jdGlvbiB0d2Vha2VyVmlzaWJsZUJveChlbDogSFRNTEVsZW1lbnQpOiBET01SZWN0IHwgbnVsbCB7XG4gIGlmICghZWwuaXNDb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICBjb25zdCBzdHlsZSA9IGdldENvbXB1dGVkU3R5bGUoZWwpO1xuICBpZiAoc3R5bGUuZGlzcGxheSA9PT0gXCJub25lXCIgfHwgc3R5bGUudmlzaWJpbGl0eSA9PT0gXCJoaWRkZW5cIikgcmV0dXJuIG51bGw7XG5cbiAgY29uc3QgcmVjdCA9IGVsLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICBpZiAocmVjdC53aWR0aCA8PSAwIHx8IHJlY3QuaGVpZ2h0IDw9IDApIHJldHVybiBudWxsO1xuICByZXR1cm4gcmVjdDtcbn1cblxuZnVuY3Rpb24gc2V0U2V0dGluZ3NTdXJmYWNlVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuLCByZWFzb246IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3NTdXJmYWNlVmlzaWJsZSA9PT0gdmlzaWJsZSkgcmV0dXJuO1xuICBzdGF0ZS5zZXR0aW5nc1N1cmZhY2VWaXNpYmxlID0gdmlzaWJsZTtcbiAgaWYgKHZpc2libGUpIHdhcm1Ud2Vha1N0b3JlKCk7XG4gIHRyeSB7XG4gICAgKHdpbmRvdyBhcyBXaW5kb3cgJiB7IF9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGU/OiBib29sZWFuIH0pLl9fdHdlYWtlclNldHRpbmdzU3VyZmFjZVZpc2libGUgPSB2aXNpYmxlO1xuICAgIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudC5kYXRhc2V0LnR3ZWFrZXJTZXR0aW5nc1N1cmZhY2UgPSB2aXNpYmxlID8gXCJ0cnVlXCIgOiBcImZhbHNlXCI7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQoXG4gICAgICBuZXcgQ3VzdG9tRXZlbnQoXCJ0d2Vha2VyOnNldHRpbmdzLXN1cmZhY2VcIiwge1xuICAgICAgICBkZXRhaWw6IHsgdmlzaWJsZSwgcmVhc29uIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9IGNhdGNoIHt9XG4gIHBsb2coXCJzZXR0aW5ncyBzdXJmYWNlXCIsIHsgdmlzaWJsZSwgcmVhc29uLCB1cmw6IGxvY2F0aW9uLmhyZWYgfSk7XG59XG5cbi8qKlxuICogUmVuZGVyIChvciByZS1yZW5kZXIpIHRoZSBzZWNvbmQgc2lkZWJhciBncm91cCBvZiBwZXItdHdlYWsgcGFnZXMuIFRoZVxuICogZ3JvdXAgaXMgY3JlYXRlZCBsYXppbHkgYW5kIHJlbW92ZWQgd2hlbiB0aGUgbGFzdCBwYWdlIHVucmVnaXN0ZXJzLCBzb1xuICogdXNlcnMgd2l0aCBubyBwYWdlLXJlZ2lzdGVyaW5nIHR3ZWFrcyBuZXZlciBzZWUgYW4gZW1wdHkgXCJUd2Vha3NcIiBoZWFkZXIuXG4gKi9cbmZ1bmN0aW9uIHN5bmNQYWdlc0dyb3VwKCk6IHZvaWQge1xuICBjb25zdCBvdXRlciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIW91dGVyKSByZXR1cm47XG4gIGlmICghaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUob3V0ZXIpKSB7XG4gICAgc3RhdGUuc2lkZWJhclJvb3QgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHBhZ2VzID0gc2V0dGluZ3NOYXZpZ2F0aW9uSXRlbXMoKTtcblxuICAvLyBCdWlsZCBhIGRldGVybWluaXN0aWMgZmluZ2VycHJpbnQgb2YgdGhlIGRlc2lyZWQgZ3JvdXAgc3RhdGUuIElmIHRoZVxuICAvLyBjdXJyZW50IERPTSBncm91cCBhbHJlYWR5IG1hdGNoZXMsIHRoaXMgaXMgYSBuby1vcCBcdTIwMTQgY3JpdGljYWwsIGJlY2F1c2VcbiAgLy8gc3luY1BhZ2VzR3JvdXAgaXMgY2FsbGVkIG9uIGV2ZXJ5IE11dGF0aW9uT2JzZXJ2ZXIgdGljayBhbmQgYW55IERPTVxuICAvLyB3cml0ZSB3b3VsZCByZS10cmlnZ2VyIHRoYXQgb2JzZXJ2ZXIgKGluZmluaXRlIGxvb3AsIGFwcCBmcmVlemUpLlxuICBjb25zdCBkZXNpcmVkS2V5ID0gcGFnZXMubGVuZ3RoID09PSAwXG4gICAgPyBcIkVNUFRZXCJcbiAgICA6IHBhZ2VzLm1hcCgocCkgPT4gYCR7cC50d2Vha0lkfXwke3AudGl0bGV9fCR7cC5pY29uU3ZnID8/IFwiXCJ9fCR7cC5saWZlY3ljbGV9YCkuam9pbihcIlxcblwiKTtcbiAgY29uc3QgZ3JvdXBBdHRhY2hlZCA9ICEhc3RhdGUucGFnZXNHcm91cCAmJiBvdXRlci5jb250YWlucyhzdGF0ZS5wYWdlc0dyb3VwKTtcbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXBLZXkgPT09IGRlc2lyZWRLZXkgJiYgKHBhZ2VzLmxlbmd0aCA9PT0gMCA/ICFncm91cEF0dGFjaGVkIDogZ3JvdXBBdHRhY2hlZCkpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAocGFnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgaWYgKHN0YXRlLnBhZ2VzR3JvdXApIHtcbiAgICAgIHN0YXRlLnBhZ2VzR3JvdXAucmVtb3ZlKCk7XG4gICAgICBzdGF0ZS5wYWdlc0dyb3VwID0gbnVsbDtcbiAgICB9XG4gICAgc3RhdGUucGFnZU5hdkJ1dHRvbnMuY2xlYXIoKTtcbiAgICBzdGF0ZS5wYWdlc0dyb3VwS2V5ID0gZGVzaXJlZEtleTtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgZ3JvdXAgPSBzdGF0ZS5wYWdlc0dyb3VwO1xuICBpZiAoIWdyb3VwIHx8ICFvdXRlci5jb250YWlucyhncm91cCkpIHtcbiAgICBncm91cCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZ3JvdXAuZGF0YXNldC50d2Vha2VyID0gXCJwYWdlcy1ncm91cFwiO1xuICAgIGdyb3VwLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtcHhcIjtcbiAgICBncm91cC5hcHBlbmRDaGlsZChzaWRlYmFyR3JvdXBIZWFkZXIoXCJUd2Vha3NcIiwgXCJwdC0zXCIpKTtcbiAgICBvdXRlci5hcHBlbmRDaGlsZChncm91cCk7XG4gICAgc3RhdGUucGFnZXNHcm91cCA9IGdyb3VwO1xuICB9IGVsc2Uge1xuICAgIC8vIFN0cmlwIHByaW9yIGJ1dHRvbnMgKGtlZXAgdGhlIGhlYWRlciBhdCBpbmRleCAwKS5cbiAgICB3aGlsZSAoZ3JvdXAuY2hpbGRyZW4ubGVuZ3RoID4gMSkgZ3JvdXAucmVtb3ZlQ2hpbGQoZ3JvdXAubGFzdENoaWxkISk7XG4gIH1cblxuICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5jbGVhcigpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGFnZXMpIHtcbiAgICBjb25zdCBpY29uID0gcC5pY29uU3ZnID8/IGRlZmF1bHRQYWdlSWNvblN2ZygpO1xuICAgIGNvbnN0IGJ0biA9IG1ha2VTaWRlYmFySXRlbShwLnRpdGxlLCBpY29uKTtcbiAgICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi1wYWdlLSR7cC50d2Vha0lkfWA7XG4gICAgYnRuLmRhdGFzZXQudHdlYWtlckxpZmVjeWNsZSA9IHAubGlmZWN5Y2xlO1xuICAgIGlmIChwLmxpZmVjeWNsZSAhPT0gXCJlbmFibGVkXCIpIGJ0bi50aXRsZSA9IGxpZmVjeWNsZUxhYmVsKHAubGlmZWN5Y2xlLCBwLndhcm5pbmcpO1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IHAudHdlYWtJZCB9KTtcbiAgICB9KTtcbiAgICBzdGF0ZS5wYWdlTmF2QnV0dG9ucy5zZXQocC50d2Vha0lkLCBidG4pO1xuICAgIGdyb3VwLmFwcGVuZENoaWxkKGJ0bik7XG4gIH1cbiAgc3RhdGUucGFnZXNHcm91cEtleSA9IGRlc2lyZWRLZXk7XG4gIHBsb2coXCJwYWdlcyBncm91cCBzeW5jZWRcIiwge1xuICAgIGNvdW50OiBwYWdlcy5sZW5ndGgsXG4gICAgaWRzOiBwYWdlcy5tYXAoKHApID0+IHAudHdlYWtJZCksXG4gIH0pO1xuICAvLyBSZWZsZWN0IGN1cnJlbnQgYWN0aXZlIHN0YXRlIGFjcm9zcyB0aGUgcmVidWlsdCBidXR0b25zLlxuICBzZXROYXZBY3RpdmUoc3RhdGUuYWN0aXZlUGFnZSk7XG59XG5cbi8vIEZvcmNlIGFueSBpbmplY3RlZCBpY29uIFNWRyB0byBhIGZpeGVkIGJveC4gVHdlYWstcHJvdmlkZWQgaWNvblN2ZyBtYXJrdXAgbWF5XG4vLyBvbWl0IHdpZHRoL2hlaWdodCAoYW5kIHZpZXdCb3ggYWxvbmUgbGV0cyBhbiBTVkcgZXhwYW5kIHRvIGl0cyBpbnRyaW5zaWMgc2l6ZSxcbi8vIHdoaWNoIHJlbmRlcmVkIGEgcGFnZSBpY29uIGFzIGEgZ2lhbnQgZ2x5cGgpLiBJbmxpbmUgc3R5bGVzIGJlYXQgY29uZmxpY3Rpbmdcbi8vIGF0dHJpYnV0ZXMvQ1NTLCBzbyB0aGlzIGNhbm5vdCBiZSBkZWZlYXRlZCBieSB0aGUgdHdlYWsncyBvd24gbWFya3VwLlxuZnVuY3Rpb24gY29uc3RyYWluU2lkZWJhckljb25TdmcoaWNvbjogRWxlbWVudCB8IG51bGwgfCB1bmRlZmluZWQsIHNpemUgPSAyMCk6IHZvaWQge1xuICBpZiAoIWljb24pIHJldHVybjtcbiAgaWNvbi5zZXRBdHRyaWJ1dGUoXCJ3aWR0aFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBpY29uLnNldEF0dHJpYnV0ZShcImhlaWdodFwiLCBTdHJpbmcoc2l6ZSkpO1xuICBjb25zdCBzdHlsZSA9IChpY29uIGFzIHVua25vd24gYXMgeyBzdHlsZT86IENTU1N0eWxlRGVjbGFyYXRpb24gfSkuc3R5bGU7XG4gIGlmIChzdHlsZSkge1xuICAgIHN0eWxlLndpZHRoID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuaGVpZ2h0ID0gYCR7c2l6ZX1weGA7XG4gICAgc3R5bGUuZmxleFNocmluayA9IFwiMFwiO1xuICB9XG4gIChpY29uIGFzIEVsZW1lbnQpLmNsYXNzTGlzdD8uYWRkKFwiaWNvbi1zbVwiLCBcImlubGluZS1ibG9ja1wiLCBcInNocmluay0wXCIsIFwiYWxpZ24tbWlkZGxlXCIpO1xufVxuXG5mdW5jdGlvbiBtYWtlU2lkZWJhckl0ZW0obGFiZWw6IHN0cmluZywgaWNvblN2Zzogc3RyaW5nKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICAvLyBDbGFzcyBzdHJpbmcgY29waWVkIHZlcmJhdGltIGZyb20gQ29kZXgncyBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwgZXRjKS5cbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyID0gYG5hdi0ke2xhYmVsLnRvTG93ZXJDYXNlKCl9YDtcbiAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbGFiZWwpO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImZvY3VzLXZpc2libGU6b3V0bGluZS10b2tlbi1ib3JkZXIgcmVsYXRpdmUgcHgtcm93LXggcHktcm93LXkgY3Vyc29yLWludGVyYWN0aW9uIHNocmluay0wIGl0ZW1zLWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyB0ZXh0LWxlZnQgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLTIgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW9mZnNldC0yIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTUwIGdhcC0yIGZsZXggdy1mdWxsIGhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBmb250LW5vcm1hbFwiO1xuXG4gIGNvbnN0IGlubmVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaW5uZXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgdGV4dC1iYXNlIGdhcC0yIGZsZXgtMSB0ZXh0LXRva2VuLWZvcmVncm91bmRcIjtcbiAgaW5uZXIuaW5uZXJIVE1MID0gYCR7aWNvblN2Z308c3BhbiBjbGFzcz1cInRydW5jYXRlXCI+JHtsYWJlbH08L3NwYW4+YDtcbiAgY29uc3RyYWluU2lkZWJhckljb25TdmcoaW5uZXIucXVlcnlTZWxlY3RvcihcInN2Z1wiKSk7XG4gIGJ0bi5hcHBlbmRDaGlsZChpbm5lcik7XG4gIHJldHVybiBidG47XG59XG5cbmZ1bmN0aW9uIGFwcGVuZFNpZGViYXJTdG9yZVVwZGF0ZUJhZGdlKGJ0bjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgaW5uZXIgPSBidG4uZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWlubmVyKSByZXR1cm47XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmRhdGFzZXQudHdlYWtlclN0b3JlVXBkYXRlQmFkZ2UgPSBcInRydWVcIjtcbiAgYmFkZ2UuaGlkZGVuID0gdHJ1ZTtcbiAgYmFkZ2UudGl0bGUgPSBcIkluc3RhbGxlZCB0d2Vha3Mgd2l0aCBhcHByb3ZlZCB1cGRhdGVzXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyXCI7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBwb3NpdGlvbjogXCJhYnNvbHV0ZVwiLFxuICAgIHJpZ2h0OiBcIjEycHhcIixcbiAgICB0b3A6IFwiNTAlXCIsXG4gICAgdHJhbnNmb3JtOiBcInRyYW5zbGF0ZVkoLTUwJSlcIixcbiAgICB6SW5kZXg6IFwiMVwiLFxuICB9KTtcbiAgYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2UsIG51bGwpO1xuICBidG4uYXBwZW5kQ2hpbGQoYmFkZ2UpO1xufVxuXG4vKiogSW50ZXJuYWwga2V5IGZvciB0aGUgYnVpbHQtaW4gbmF2IGJ1dHRvbnMuICovXG50eXBlIEJ1aWx0aW5QYWdlID0gXCJjb25maWdcIiB8IFwidHdlYWtzXCIgfCBcInN0b3JlXCI7XG5cbmZ1bmN0aW9uIHNldE5hdkFjdGl2ZShhY3RpdmU6IEFjdGl2ZVBhZ2UgfCBudWxsKTogdm9pZCB7XG4gIC8vIEJ1aWx0LWluIChDb25maWcvVHdlYWtzKSBidXR0b25zLlxuICBpZiAoc3RhdGUubmF2QnV0dG9ucykge1xuICAgIGNvbnN0IGJ1aWx0aW46IEJ1aWx0aW5QYWdlIHwgbnVsbCA9XG4gICAgICBhY3RpdmU/LmtpbmQgPT09IFwiY29uZmlnXCIgPyBcImNvbmZpZ1wiIDpcbiAgICAgIGFjdGl2ZT8ua2luZCA9PT0gXCJ0d2Vha3NcIiA/IFwidHdlYWtzXCIgOlxuICAgICAgYWN0aXZlPy5raW5kID09PSBcInN0b3JlXCIgPyBcInN0b3JlXCIgOiBudWxsO1xuICAgIGZvciAoY29uc3QgW2tleSwgYnRuXSBvZiBPYmplY3QuZW50cmllcyhzdGF0ZS5uYXZCdXR0b25zKSBhcyBbQnVpbHRpblBhZ2UsIEhUTUxCdXR0b25FbGVtZW50XVtdKSB7XG4gICAgICBhcHBseU5hdkFjdGl2ZShidG4sIGtleSA9PT0gYnVpbHRpbik7XG4gICAgfVxuICB9XG4gIC8vIE9uZSBzdGFibGUgYnV0dG9uIHBlciBlbmFibGVkIHR3ZWFrLCByZWdhcmRsZXNzIG9mIGhvdyBtYW55IHNlY3Rpb25zIGl0XG4gIC8vIHJlZ2lzdGVyZWQgb3Igd2hldGhlciBzdGFydHVwIHJlYWNoZWQgcGFnZSByZWdpc3RyYXRpb24gYXQgYWxsLlxuICBmb3IgKGNvbnN0IFt0d2Vha0lkLCBidXR0b25dIG9mIHN0YXRlLnBhZ2VOYXZCdXR0b25zKSB7XG4gICAgY29uc3QgaXNBY3RpdmUgPSBhY3RpdmU/LmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiICYmIGFjdGl2ZS5pZCA9PT0gdHdlYWtJZDtcbiAgICBhcHBseU5hdkFjdGl2ZShidXR0b24sIGlzQWN0aXZlKTtcbiAgfVxuICAvLyBDb2RleCdzIG93biBzaWRlYmFyIGJ1dHRvbnMgKEdlbmVyYWwsIEFwcGVhcmFuY2UsIGV0YykuIFdoZW4gb25lIG9mXG4gIC8vIG91ciBwYWdlcyBpcyBhY3RpdmUsIENvZGV4IHN0aWxsIGhhcyBhcmlhLWN1cnJlbnQ9XCJwYWdlXCIgYW5kIHRoZVxuICAvLyBhY3RpdmUtYmcgY2xhc3Mgb24gd2hpY2hldmVyIGl0ZW0gaXQgY29uc2lkZXJlZCB0aGUgcm91dGUgXHUyMDE0IHR5cGljYWxseVxuICAvLyBHZW5lcmFsLiBUaGF0IG1ha2VzIGJvdGggYnV0dG9ucyBsb29rIHNlbGVjdGVkLiBTdHJpcCBDb2RleCdzIGFjdGl2ZVxuICAvLyBzdHlsaW5nIHdoaWxlIG9uZSBvZiBvdXJzIGlzIGFjdGl2ZTsgcmVzdG9yZSBpdCB3aGVuIG5vbmUgaXMuXG4gIHN5bmNDb2RleE5hdGl2ZU5hdkFjdGl2ZShhY3RpdmUgIT09IG51bGwpO1xufVxuXG4vKipcbiAqIE11dGUgQ29kZXgncyBvd24gYWN0aXZlLXN0YXRlIHN0eWxpbmcgb24gaXRzIHNpZGViYXIgYnV0dG9ucy4gV2UgZG9uJ3RcbiAqIHRvdWNoIENvZGV4J3MgUmVhY3Qgc3RhdGUgXHUyMDE0IHdoZW4gdGhlIHVzZXIgY2xpY2tzIGEgbmF0aXZlIGl0ZW0sIENvZGV4XG4gKiByZS1yZW5kZXJzIHRoZSBidXR0b25zIGFuZCByZS1hcHBsaWVzIGl0cyBvd24gY29ycmVjdCBzdGF0ZSwgdGhlbiBvdXJcbiAqIHNpZGViYXItY2xpY2sgbGlzdGVuZXIgZmlyZXMgYHJlc3RvcmVDb2RleFZpZXdgICh3aGljaCBjYWxscyBiYWNrIGludG9cbiAqIGBzZXROYXZBY3RpdmUobnVsbClgIGFuZCBsZXRzIENvZGV4J3Mgc3R5bGluZyBzdGFuZCkuXG4gKlxuICogYG11dGU9dHJ1ZWAgIFx1MjE5MiBzdHJpcCBhcmlhLWN1cnJlbnQgYW5kIHN3YXAgYWN0aXZlIGJnIFx1MjE5MiBob3ZlciBiZ1xuICogYG11dGU9ZmFsc2VgIFx1MjE5MiBuby1vcCAoQ29kZXgncyBvd24gcmUtcmVuZGVyIGFscmVhZHkgcmVzdG9yZWQgdGhpbmdzKVxuICovXG5mdW5jdGlvbiBzeW5jQ29kZXhOYXRpdmVOYXZBY3RpdmUobXV0ZTogYm9vbGVhbik6IHZvaWQge1xuICBpZiAoIW11dGUpIHJldHVybjtcbiAgY29uc3Qgcm9vdCA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoIXJvb3QpIHJldHVybjtcbiAgY29uc3QgYnV0dG9ucyA9IEFycmF5LmZyb20ocm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcImJ1dHRvblwiKSk7XG4gIGZvciAoY29uc3QgYnRuIG9mIGJ1dHRvbnMpIHtcbiAgICAvLyBTa2lwIG91ciBvd24gYnV0dG9ucy5cbiAgICBpZiAoYnRuLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKGJ0bi5nZXRBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIikgPT09IFwicGFnZVwiKSB7XG4gICAgICBidG4ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1jdXJyZW50XCIpO1xuICAgIH1cbiAgICBpZiAoYnRuLmNsYXNzTGlzdC5jb250YWlucyhcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LmFkZChcImhvdmVyOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gYXBwbHlOYXZBY3RpdmUoYnRuOiBIVE1MQnV0dG9uRWxlbWVudCwgYWN0aXZlOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGlubmVyID0gYnRuLmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGFjdGl2ZSkge1xuICAgICAgYnRuLmNsYXNzTGlzdC5yZW1vdmUoXCJob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIiwgXCJmb250LW5vcm1hbFwiKTtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIpO1xuICAgICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiLCBcInBhZ2VcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5hZGQoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGJ0bi5jbGFzc0xpc3QuYWRkKFwiaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kXCIsIFwiZm9udC1ub3JtYWxcIik7XG4gICAgICBidG4uY2xhc3NMaXN0LnJlbW92ZShcImJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZFwiKTtcbiAgICAgIGJ0bi5yZW1vdmVBdHRyaWJ1dGUoXCJhcmlhLWN1cnJlbnRcIik7XG4gICAgICBpZiAoaW5uZXIpIHtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LmFkZChcInRleHQtdG9rZW4tZm9yZWdyb3VuZFwiKTtcbiAgICAgICAgaW5uZXIuY2xhc3NMaXN0LnJlbW92ZShcInRleHQtdG9rZW4tbGlzdC1hY3RpdmUtc2VsZWN0aW9uLWZvcmVncm91bmRcIik7XG4gICAgICAgIGlubmVyXG4gICAgICAgICAgLnF1ZXJ5U2VsZWN0b3IoXCJzdmdcIilcbiAgICAgICAgICA/LmNsYXNzTGlzdC5yZW1vdmUoXCJ0ZXh0LXRva2VuLWxpc3QtYWN0aXZlLXNlbGVjdGlvbi1pY29uLWZvcmVncm91bmRcIik7XG4gICAgICB9XG4gICAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgYWN0aXZhdGlvbiBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gYWN0aXZhdGVQYWdlKHBhZ2U6IEFjdGl2ZVBhZ2UpOiB2b2lkIHtcbiAgY29uc3QgY29udGVudCA9IGZpbmRDb250ZW50QXJlYSgpO1xuICBpZiAoIWNvbnRlbnQpIHtcbiAgICBwbG9nKFwiYWN0aXZhdGU6IGNvbnRlbnQgYXJlYSBub3QgZm91bmRcIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLmFjdGl2ZVBhZ2UgPSBwYWdlO1xuICBwbG9nKFwiYWN0aXZhdGVcIiwgeyBwYWdlIH0pO1xuXG4gIC8vIEhpZGUgQ29kZXgncyBjb250ZW50IGNoaWxkcmVuLCBzaG93IG91cnMuXG4gIGZvciAoY29uc3QgY2hpbGQgb2YgQXJyYXkuZnJvbShjb250ZW50LmNoaWxkcmVuKSBhcyBIVE1MRWxlbWVudFtdKSB7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlciA9PT0gXCJ0d2Vha3MtcGFuZWxcIikgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5kYXRhc2V0LnR3ZWFrZXJIaWRkZW4gPSBjaGlsZC5zdHlsZS5kaXNwbGF5IHx8IFwiXCI7XG4gICAgfVxuICAgIGNoaWxkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgfVxuICBsZXQgcGFuZWwgPSBjb250ZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS10d2Vha2VyPVwidHdlYWtzLXBhbmVsXCJdJyk7XG4gIGlmICghcGFuZWwpIHtcbiAgICBwYW5lbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcGFuZWwuZGF0YXNldC50d2Vha2VyID0gXCJ0d2Vha3MtcGFuZWxcIjtcbiAgICBwYW5lbC5zdHlsZS5jc3NUZXh0ID0gXCJ3aWR0aDoxMDAlO2hlaWdodDoxMDAlO292ZXJmbG93OmF1dG87XCI7XG4gICAgY29udGVudC5hcHBlbmRDaGlsZChwYW5lbCk7XG4gIH1cbiAgcGFuZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgc3RhdGUucGFuZWxIb3N0ID0gcGFuZWw7XG4gIHJlcmVuZGVyKCk7XG4gIHNldE5hdkFjdGl2ZShwYWdlKTtcbiAgLy8gcmVzdG9yZSBDb2RleCdzIHZpZXcuIFJlLXJlZ2lzdGVyIGlmIG5lZWRlZC5cbiAgY29uc3Qgc2lkZWJhciA9IHN0YXRlLnNpZGViYXJSb290O1xuICBpZiAoc2lkZWJhcikge1xuICAgIGlmIChzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIpIHtcbiAgICAgIHNpZGViYXIucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlciwgdHJ1ZSk7XG4gICAgfVxuICAgIGNvbnN0IGhhbmRsZXIgPSAoZTogRXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG4gICAgICBpZiAoc3RhdGUubmF2R3JvdXA/LmNvbnRhaW5zKHRhcmdldCkpIHJldHVybjsgLy8gb3VyIGJ1dHRvbnNcbiAgICAgIGlmIChzdGF0ZS5wYWdlc0dyb3VwPy5jb250YWlucyh0YXJnZXQpKSByZXR1cm47IC8vIG91ciBwYWdlIGJ1dHRvbnNcbiAgICAgIGlmICh0YXJnZXQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc2V0dGluZ3Mtc2VhcmNoXVwiKSkgcmV0dXJuO1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgIH07XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gaGFuZGxlcjtcbiAgICBzaWRlYmFyLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBoYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXN0b3JlQ29kZXhWaWV3KCk6IHZvaWQge1xuICBwbG9nKFwicmVzdG9yZSBjb2RleCB2aWV3XCIpO1xuICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gIGlmICghY29udGVudCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaWYgKHN0YXRlLnBhbmVsSG9zdCkgc3RhdGUucGFuZWxIb3N0LnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICBpZiAoY2hpbGQgPT09IHN0YXRlLnBhbmVsSG9zdCkgY29udGludWU7XG4gICAgaWYgKGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjaGlsZC5zdHlsZS5kaXNwbGF5ID0gY2hpbGQuZGF0YXNldC50d2Vha2VySGlkZGVuO1xuICAgICAgZGVsZXRlIGNoaWxkLmRhdGFzZXQudHdlYWtlckhpZGRlbjtcbiAgICB9XG4gIH1cbiAgc3RhdGUuYWN0aXZlUGFnZSA9IG51bGw7XG4gIHNldE5hdkFjdGl2ZShudWxsKTtcbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSZXN0b3JlSGFuZGxlcikge1xuICAgIHN0YXRlLnNpZGViYXJSb290LnJlbW92ZUV2ZW50TGlzdGVuZXIoXG4gICAgICBcImNsaWNrXCIsXG4gICAgICBzdGF0ZS5zaWRlYmFyUmVzdG9yZUhhbmRsZXIsXG4gICAgICB0cnVlLFxuICAgICk7XG4gICAgc3RhdGUuc2lkZWJhclJlc3RvcmVIYW5kbGVyID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXJlbmRlcigpOiB2b2lkIHtcbiAgaWYgKCFzdGF0ZS5hY3RpdmVQYWdlKSByZXR1cm47XG4gIGNvbnN0IGhvc3QgPSBzdGF0ZS5wYW5lbEhvc3Q7XG4gIGlmICghaG9zdCkgcmV0dXJuO1xuICB0ZWFyZG93blJlbmRlcmVkUGFnZXMoKTtcbiAgaG9zdC5pbm5lckhUTUwgPSBcIlwiO1xuXG4gIGNvbnN0IGFwID0gc3RhdGUuYWN0aXZlUGFnZTtcbiAgaWYgKGFwLmtpbmQgPT09IFwicmVnaXN0ZXJlZFwiKSB7XG4gICAgY29uc3QgaXRlbSA9IHNldHRpbmdzTmF2aWdhdGlvbkl0ZW0oYXAuaWQpO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgcmVzdG9yZUNvZGV4VmlldygpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBlbnRyaWVzID0gcmVnaXN0ZXJlZFBhZ2VzRm9yVHdlYWsoYXAuaWQpO1xuICAgIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKGl0ZW0udGl0bGUsIGl0ZW0uZGVzY3JpcHRpb24pO1xuICAgIGhvc3QuYXBwZW5kQ2hpbGQocm9vdC5vdXRlcik7XG4gICAgcm9vdC5oZWFkZXJUaXRsZUFjdGlvbnMuYXBwZW5kQ2hpbGQodHdlYWtMaWZlY3ljbGVCYWRnZShpdGVtKSk7XG4gICAgaWYgKGl0ZW0ud2FybmluZykgcm9vdC5zZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQodHdlYWtQYWdlV2FybmluZyhpdGVtLndhcm5pbmcpKTtcbiAgICBpZiAoIWVudHJpZXMubGVuZ3RoKSB7XG4gICAgICByZW5kZXJGYWxsYmFja1R3ZWFrUGFnZShyb290LnNlY3Rpb25zV3JhcCwgaXRlbSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGZvciAoY29uc3QgZW50cnkgb2YgZW50cmllcykge1xuICAgICAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICAgICAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgICAgIGlmIChlbnRyaWVzLmxlbmd0aCA+IDEpIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKGVudHJ5LnBhZ2UudGl0bGUpKTtcbiAgICAgIGNvbnN0IHRhcmdldCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICB0YXJnZXQuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gICAgICBzZWN0aW9uLmFwcGVuZENoaWxkKHRhcmdldCk7XG4gICAgICByb290LnNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duPy4oKTsgfSBjYXRjaCB7fVxuICAgICAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gICAgICAgIGNvbnN0IHJldCA9IGVudHJ5LnBhZ2UucmVuZGVyKHRhcmdldCk7XG4gICAgICAgIGlmICh0eXBlb2YgcmV0ID09PSBcImZ1bmN0aW9uXCIpIGVudHJ5LnRlYXJkb3duID0gcmV0O1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zdCBlcnIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgICBlcnIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLWNoYXJ0cy1yZWQgdGV4dC1zbVwiO1xuICAgICAgICBlcnIudGV4dENvbnRlbnQgPSBgRXJyb3IgcmVuZGVyaW5nIHBhZ2U6ICR7KGUgYXMgRXJyb3IpLm1lc3NhZ2V9YDtcbiAgICAgICAgdGFyZ2V0LmFwcGVuZENoaWxkKGVycik7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHRpdGxlID1cbiAgICBhcC5raW5kID09PSBcInR3ZWFrc1wiID8gXCJUd2Vha3NcIiA6XG4gICAgYXAua2luZCA9PT0gXCJzdG9yZVwiID8gXCJUd2VhayBTdG9yZVwiIDogXCJUd2Vha2Vyc1wiO1xuICBjb25zdCBzdWJ0aXRsZSA9XG4gICAgYXAua2luZCA9PT0gXCJ0d2Vha3NcIlxuICAgICAgPyBcIk1hbmFnZSB5b3VyIGNhdGFsb2cgZW50cmllcyBhbmQgaW5zdGFsbGVkIHR3ZWFrcy5cIlxuICAgICAgOiBhcC5raW5kID09PSBcInN0b3JlXCJcbiAgICAgICAgPyBcIkluc3RhbGwgcmV2aWV3ZWQgdHdlYWtzIHBpbm5lZCB0byBhcHByb3ZlZCBHaXRIdWIgY29tbWl0cy5cIlxuICAgICAgICA6IFwiQ2hlY2tpbmcgaW5zdGFsbGVkIFR3ZWFrZXJzIHZlcnNpb24uXCI7XG4gIGNvbnN0IHJvb3QgPSBwYW5lbFNoZWxsKFxuICAgIHRpdGxlLFxuICAgIHN1YnRpdGxlLFxuICAgIGFwLmtpbmQgPT09IFwidHdlYWtzXCIgPyB7IHdpZHRoOiBcInBsdWdpbnNcIiB9IDogdW5kZWZpbmVkLFxuICApO1xuICBob3N0LmFwcGVuZENoaWxkKHJvb3Qub3V0ZXIpO1xuICBpZiAoYXAua2luZCA9PT0gXCJ0d2Vha3NcIikgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyVHdlYWtzUGFnZShyb290LnNlY3Rpb25zV3JhcCk7XG4gIGVsc2UgaWYgKGFwLmtpbmQgPT09IFwic3RvcmVcIikgcmVuZGVyVHdlYWtTdG9yZVBhZ2Uocm9vdC5zZWN0aW9uc1dyYXAsIHJvb3QuaGVhZGVyQWN0aW9ucyk7XG4gIGVsc2UgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gcmVuZGVyQ29uZmlnUGFnZShyb290LnNlY3Rpb25zV3JhcCwgcm9vdC5zdWJ0aXRsZSk7XG59XG5cbmZ1bmN0aW9uIHRlYXJkb3duUmVuZGVyZWRQYWdlcygpOiB2b2lkIHtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwPy4oKTtcbiAgYWN0aXZlQnVpbHRpblBhZ2VDbGVhbnVwID0gbnVsbDtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBzdGF0ZS5wYWdlcy52YWx1ZXMoKSkge1xuICAgIGlmICghZW50cnkudGVhcmRvd24pIGNvbnRpbnVlO1xuICAgIHRyeSB7IGVudHJ5LnRlYXJkb3duKCk7IH0gY2F0Y2gge31cbiAgICBlbnRyeS50ZWFyZG93biA9IG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIHBhZ2VzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiB0d2Vha0xpZmVjeWNsZUJhZGdlKGl0ZW06IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IFwiaW5saW5lLWZsZXggaXRlbXMtY2VudGVyIHJvdW5kZWQtZnVsbCBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMiBweS0wLjUgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gYCR7aXRlbS52ZXJzaW9ufSBcdTAwQjcgJHtsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSl9YDtcbiAgYmFkZ2UudGl0bGUgPSBgJHtpdGVtLnZlcnNpb259IFx1MDBCNyAke2xpZmVjeWNsZUxhYmVsKGl0ZW0ubGlmZWN5Y2xlLCBpdGVtLndhcm5pbmcpfWA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtQYWdlV2FybmluZyhtZXNzYWdlOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3YXJuaW5nLmNsYXNzTmFtZSA9IFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWNoYXJ0cy15ZWxsb3cvMzAgYmctdG9rZW4tY2hhcnRzLXllbGxvdy8xMCBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB3YXJuaW5nLnRleHRDb250ZW50ID0gbWVzc2FnZTtcbiAgcmV0dXJuIHdhcm5pbmc7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckZhbGxiYWNrVHdlYWtQYWdlKHJvb3Q6IEhUTUxFbGVtZW50LCBpdGVtOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtKTogdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJTdGF0dXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJWZXJzaW9uXCIsIGl0ZW0udmVyc2lvbikpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkxpZmVjeWNsZVwiLCBsaWZlY3ljbGVMYWJlbChpdGVtLmxpZmVjeWNsZSwgaXRlbS53YXJuaW5nKSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIlNldHRpbmdzIHBhZ2VcIiwgXCJUaGlzIGVuYWJsZWQgVHdlYWtlciBoYXMgbm90IHJlZ2lzdGVyZWQgaXRzIGN1c3RvbSBwYWdlIHlldC4gUnVudGltZSBzdGF0dXMgcmVtYWlucyBhdmFpbGFibGUgaGVyZS5cIikpO1xuICBpZiAoW1wiZmFpbGVkXCIsIFwicXVhcmFudGluZWRcIiwgXCJ0aW1lZF9vdXRcIl0uaW5jbHVkZXMoaXRlbS5saWZlY3ljbGUpKSB7XG4gICAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHJvd0NvcHkoXCJSZWNvdmVyeVwiLCBcIkNsZWFyIHRoZSBmYWlsdXJlIGFuZCByZXRyeSB0aGlzIFR3ZWFrZXIgd2l0aG91dCByZW1vdmluZyBpdHMgZGF0YS5cIikpO1xuICAgIGNvbnN0IHJlY292ZXIgPSBjb21wYWN0QnV0dG9uKFwiUmVjb3ZlclwiLCAoKSA9PiB7XG4gICAgICByZWNvdmVyLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWNvdmVyLXR3ZWFrXCIsIGl0ZW0udHdlYWtJZCkuZmluYWxseSgoKSA9PiB7IHJlY292ZXIuZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgfSk7XG4gICAgcm93LmFwcGVuZENoaWxkKHJlY292ZXIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICByb290LmFwcGVuZENoaWxkKHNlY3Rpb24pO1xufVxuXG5mdW5jdGlvbiByb3dDb3B5KHRpdGxlOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjb3B5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY29weS5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRlc2NyaXB0aW9uLmNsYXNzTmFtZSA9IFwidGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGRlc2NyaXB0aW9uLnRleHRDb250ZW50ID0gZGV0YWlsO1xuICBjb3B5LmFwcGVuZChoZWFkaW5nLCBkZXNjcmlwdGlvbik7XG4gIHJldHVybiBjb3B5O1xufVxuXG5mdW5jdGlvbiByZW5kZXJDb25maWdQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBzdWJ0aXRsZT86IEhUTUxFbGVtZW50LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGNsZWFudXBzOiBBcnJheTwoKSA9PiB2b2lkPiA9IFtdO1xuICBjb25zdCBjYXJkVXBkYXRlcyA9IG5ldyBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4oKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJFbnZpcm9ubWVudFNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKHNlY3Rpb25zV3JhcCwgY2FyZFVwZGF0ZXMpKTtcbiAgY2xlYW51cHMucHVzaChyZW5kZXJNY3BJbnRlZ3JhdGlvblNlY3Rpb24oc2VjdGlvbnNXcmFwLCBjYXJkVXBkYXRlcykpO1xuICBjbGVhbnVwcy5wdXNoKHJlbmRlckF1dG9tYXRpY01haW50ZW5hbmNlU2VjdGlvbihzZWN0aW9uc1dyYXAsIGNhcmRVcGRhdGVzKSk7XG5cbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIlR3ZWFrZXJzIFVwZGF0ZXNcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJDb25maWdDYXJkID0gXCJ0cnVlXCI7XG4gIGNvbnN0IGxvYWRpbmcgPSByb3dTaW1wbGUoXCJMb2FkaW5nIHVwZGF0ZSBzZXR0aW5nc1wiLCBcIkNoZWNraW5nIGN1cnJlbnQgVHdlYWtlcnMgY29uZmlndXJhdGlvbi5cIik7XG4gIGNhcmQuYXBwZW5kQ2hpbGQobG9hZGluZyk7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChzZWN0aW9uKTtcblxuICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvbmZpZ1wiKVxuICAgIC50aGVuKChjb25maWcpID0+IHtcbiAgICAgIGlmIChzdWJ0aXRsZSkge1xuICAgICAgICBzdWJ0aXRsZS50ZXh0Q29udGVudCA9IGBZb3UgaGF2ZSBUd2Vha2VycyAkeyhjb25maWcgYXMgVHdlYWtlckNvbmZpZykudmVyc2lvbn0gaW5zdGFsbGVkLmA7XG4gICAgICB9XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZCwgY29uZmlnIGFzIFR3ZWFrZXJDb25maWcpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBpZiAoc3VidGl0bGUpIHN1YnRpdGxlLnRleHRDb250ZW50ID0gXCJDb3VsZCBub3QgbG9hZCBpbnN0YWxsZWQgVHdlYWtlcnMgdmVyc2lvbi5cIjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb3VsZCBub3QgbG9hZCB1cGRhdGUgc2V0dGluZ3NcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG5cbiAgcmVuZGVyQWR2YW5jZWRSdW50aW1lU2VjdGlvbihzZWN0aW9uc1dyYXApO1xuXG4gIGNvbnN0IG1haW50ZW5hbmNlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIG1haW50ZW5hbmNlLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBtYWludGVuYW5jZS5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJNYWludGVuYW5jZVwiKSk7XG4gIGNvbnN0IG1haW50ZW5hbmNlQ2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZCh1bmluc3RhbGxSb3coKSk7XG4gIG1haW50ZW5hbmNlQ2FyZC5hcHBlbmRDaGlsZChyZXBvcnRCdWdSb3coKSk7XG4gIG1haW50ZW5hbmNlLmFwcGVuZENoaWxkKG1haW50ZW5hbmNlQ2FyZCk7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZChtYWludGVuYW5jZSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgZm9yIChjb25zdCBjbGVhbnVwIG9mIGNsZWFudXBzLnNwbGljZSgwKSkge1xuICAgICAgdHJ5IHsgY2xlYW51cCgpOyB9IGNhdGNoIHt9XG4gICAgfVxuICB9O1xufVxuXG4vKipcbiAqIENvZGV4LW5hdGl2ZSBlbnZpcm9ubWVudCBjb250cm9scy4gQXBwIGV4cGVyaWVuY2UgYW5kIHJlbGVhc2UgcHJvZmlsZSBhcmVcbiAqIGRlbGliZXJhdGVseSBpbmRlcGVuZGVudCBzZWxlY3Rpb25zOiBjaGFuZ2luZyBlaXRoZXIgb25lIG9ubHkgc3RhZ2VzIGFcbiAqIHBlbmRpbmcgdmFsdWUgdW50aWwgdGhlIHVzZXIgY2hvb3NlcyBBcHBseSAmIFJlc3RhcnQuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlckVudmlyb25tZW50U2VjdGlvbihcbiAgc2VjdGlvbnNXcmFwOiBIVE1MRWxlbWVudCxcbiAgY2FyZFVwZGF0ZXM6IENvbmZpZ0NhcmRVcGRhdGVDb29yZGluYXRvcjx1bmtub3duPixcbik6ICgpID0+IHZvaWQge1xuICBjb25zdCBzZWN0aW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHNlY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc2VjdGlvblRpdGxlKFwiQXBwIE1vZGUgJiBEZXNrdG9wIFJlbGVhc2VcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJFbnZpcm9ubWVudENhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMb2FkaW5nIGVudmlyb25tZW50XCIsIFwiQ2hlY2tpbmcgYXZhaWxhYmxlIGFwcCBleHBlcmllbmNlcyBhbmQgcmVsZWFzZSBwcm9maWxlcy5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGVudmlyb25tZW50OiBFbnZpcm9ubWVudFN0YXR1cyB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24gfCBudWxsID0gbnVsbDtcbiAgbGV0IGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICBsZXQgZW52aXJvbm1lbnRBY3Rpb25FcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCB0cmFuc2FjdGlvblBvbGxpbmc6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbiAgY29uc3QgY3VycmVudFNlbGVjdGlvbiA9ICgpOiBFbnZpcm9ubWVudFNlbGVjdGlvbiB8IG51bGwgPT4gZW52aXJvbm1lbnQ/LnNlbGVjdGVkID8/IG51bGw7XG4gIGNvbnN0IGhhc1BlbmRpbmdDaGFuZ2VzID0gKCk6IGJvb2xlYW4gPT4gZW52aXJvbm1lbnQgIT09IG51bGwgJiYgZW52aXJvbm1lbnRDb250cm9sbGVyLnNuYXBzaG90Lmhhc1BlbmRpbmdDaGFuZ2VzO1xuICBjb25zdCBpc0Vudmlyb25tZW50QnVzeSA9ICgpOiBib29sZWFuID0+IGV4dGVybmFsQnVzeSB8fCBlbnZpcm9ubWVudENvbnRyb2xsZXIuc25hcHNob3QuYnVzeTtcblxuICBjb25zdCByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCA9ICgpOiB2b2lkID0+IHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uIHx8ICh0cmFuc2FjdGlvbi5waGFzZSAhPT0gXCJwcmVwYXJpbmdcIiAmJiB0cmFuc2FjdGlvbi5waGFzZSAhPT0gXCJwcmVwYXJlZFwiKSkgcmV0dXJuO1xuICAgIGNvbnN0IHJlcXVlc3RlZCA9IGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24odHJhbnNhY3Rpb24pO1xuICAgIGlmIChyZXF1ZXN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5yZXN0b3JlUGVuZGluZyhyZXF1ZXN0ZWQpO1xuICB9O1xuXG4gIGNvbnN0IHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHRyYW5zYWN0aW9uUG9sbGluZykgY2xlYXJUaW1lb3V0KHRyYW5zYWN0aW9uUG9sbGluZyk7XG4gICAgdHJhbnNhY3Rpb25Qb2xsaW5nID0gbnVsbDtcbiAgICBpZiAoXG4gICAgICAhY2FyZC5pc0Nvbm5lY3RlZFxuICAgICAgfHwgIXRyYW5zYWN0aW9uXG4gICAgICB8fCBlbnZpcm9ubWVudFRyYW5zYWN0aW9uSXNUZXJtaW5hbCh0cmFuc2FjdGlvbi5waGFzZSlcbiAgICApIHJldHVybjtcbiAgICB0cmFuc2FjdGlvblBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gICAgfSwgOTAwKTtcbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBwcmVwYXJlRW52aXJvbm1lbnRTZWxlY3Rpb24oXG4gICAgcmVxdWVzdGVkOiBQaWNrPEVudmlyb25tZW50U2VsZWN0aW9uLCBcImFwcEV4cGVyaWVuY2VcIiB8IFwicmVsZWFzZVByb2ZpbGVcIj4sXG4gICk6IFByb21pc2U8RW52aXJvbm1lbnRUcmFuc2FjdGlvbj4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICBjb25zdCBwcmVwYXJlZCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cHJlcGFyZS1lbnZpcm9ubWVudFwiLCByZXF1ZXN0ZWQpO1xuICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IHByZXBhcmF0aW9uIHdhcyBzdXBlcnNlZGVkXCIpO1xuICAgIGNvbnN0IHJlY2VpcHQgPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHByZXBhcmVkKTtcbiAgICBpZiAoIXJlY2VpcHQpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IHByZXBhcmF0aW9uIHJldHVybmVkIG5vIHRyYW5zYWN0aW9uIHJlY2VpcHRcIik7XG4gICAgdHJhbnNhY3Rpb24gPSByZWNlaXB0O1xuICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICByZXR1cm4gcmVjZWlwdDtcbiAgfVxuXG4gIGFzeW5jIGZ1bmN0aW9uIGNvbW1pdFByZXBhcmVkRW52aXJvbm1lbnQocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJlbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICBsZXQgcmVzdWx0OiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvbW1pdC1lbnZpcm9ubWVudFwiLCB7IHRyYW5zYWN0aW9uSWQ6IHJlY2VpcHQudHJhbnNhY3Rpb25JZCB9KTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBzdWJtaXQgZW52aXJvbm1lbnQgY2hhbmdlOiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgdHJhbnNhY3Rpb24gPSB7IC4uLnJlY2VpcHQsIGVycm9yOiBkZXRhaWwgfTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihkZXRhaWwpO1xuICAgIH1cbiAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSB0aHJvdyBuZXcgRXJyb3IoXCJFbnZpcm9ubWVudCBjb29yZGluYXRvciBzdWJtaXNzaW9uIHdhcyBzdXBlcnNlZGVkXCIpO1xuICAgIGNvbnN0IHN1Ym1pc3Npb24gPSBub3JtYWxpemVFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24ocmVzdWx0KTtcbiAgICBjb25zdCBvYnNlcnZlZCA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVzdWx0KTtcbiAgICB0cmFuc2FjdGlvbiA9IHN1Ym1pc3Npb25cbiAgICAgID8ge1xuICAgICAgICAuLi5yZWNlaXB0LFxuICAgICAgICBlcnJvcjogc3VibWlzc2lvbi5lcnJvciA/PyBudWxsLFxuICAgICAgICBoZWxwZXI6IHsgLi4uKHJlY2VpcHQuaGVscGVyID8/IHt9KSwgc3VibWlzc2lvbiB9LFxuICAgICAgfVxuICAgICAgOiBvYnNlcnZlZCA/PyByZWNlaXB0O1xuICAgIHJlc3RvcmVQZXJzaXN0ZWRSZXF1ZXN0KCk7XG4gICAgaWYgKHN1Ym1pc3Npb24/LnBoYXNlID09PSBcInN1Ym1pdC1mYWlsZWRcIikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBzdWJtaXQgZW52aXJvbm1lbnQgY2hhbmdlOiAke3N1Ym1pc3Npb24uZXJyb3IgfHwgXCJFbnZpcm9ubWVudCBjb29yZGluYXRvciBzdWJtaXNzaW9uIGZhaWxlZFwifWA7XG4gICAgICB0cmFuc2FjdGlvbiA9IHsgLi4udHJhbnNhY3Rpb24sIGVycm9yOiBkZXRhaWwgfTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihkZXRhaWwpO1xuICAgIH1cbiAgICB2b2lkIGxvYWRFbnZpcm9ubWVudFRyYW5zYWN0aW9uKCk7XG4gIH1cblxuICBhc3luYyBmdW5jdGlvbiBjYW5jZWxQcmVwYXJlZEVudmlyb25tZW50KHJlY2VpcHQ6IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNhbmNlbC1lbnZpcm9ubWVudFwiLCB7IHRyYW5zYWN0aW9uSWQ6IHJlY2VpcHQudHJhbnNhY3Rpb25JZCB9KTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkpIHRocm93IG5ldyBFcnJvcihcIkVudmlyb25tZW50IGNhbmNlbGxhdGlvbiB3YXMgc3VwZXJzZWRlZFwiKTtcbiAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpID8/IHJlY2VpcHQ7XG4gICAgICBpZiAodHJhbnNhY3Rpb24ucGhhc2UgIT09IFwiY2FuY2VsbGVkXCIpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnZpcm9ubWVudCBjYW5jZWxsYXRpb24gcmV0dXJuZWQgJHt0cmFuc2FjdGlvbi5waGFzZX1gKTtcbiAgICAgIH1cbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gYENvdWxkIG5vdCBjYW5jZWwgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb246ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICB0cmFuc2FjdGlvbiA9IHsgLi4ucmVjZWlwdCwgZXJyb3I6IGRldGFpbCB9O1xuICAgICAgc2NoZWR1bGVFbnZpcm9ubWVudFRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGRldGFpbCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZW52aXJvbm1lbnRDb250cm9sbGVyID0gY3JlYXRlRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyPEVudmlyb25tZW50VHJhbnNhY3Rpb24+KFxuICAgIHsgYXBwRXhwZXJpZW5jZTogXCJjaGF0Z3B0XCIsIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiIH0sXG4gICAge1xuICAgICAgcHJlcGFyZTogcHJlcGFyZUVudmlyb25tZW50U2VsZWN0aW9uLFxuICAgICAgY29uZmlybTogKHJlcXVlc3RlZCwgcmVjZWlwdCkgPT4gb3BlbkVudmlyb25tZW50Q29uZmlybU1vZGFsKHJlcXVlc3RlZCwgcmVjZWlwdCksXG4gICAgICBjb21taXQ6IGNvbW1pdFByZXBhcmVkRW52aXJvbm1lbnQsXG4gICAgICBjYW5jZWw6IGNhbmNlbFByZXBhcmVkRW52aXJvbm1lbnQsXG4gICAgfSxcbiAgICB7XG4gICAgICBvbkNoYW5nZTogKHNuYXBzaG90KSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBzbmFwc2hvdC5lcnJvcjtcbiAgICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQpIGRyYXcoKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICBmdW5jdGlvbiBvcGVuUHJlcGFyZWRFbnZpcm9ubWVudENvbmZpcm1hdGlvbihcbiAgICByZXF1ZXN0ZWQ6IFBpY2s8RW52aXJvbm1lbnRTZWxlY3Rpb24sIFwiYXBwRXhwZXJpZW5jZVwiIHwgXCJyZWxlYXNlUHJvZmlsZVwiPixcbiAgICByZWNlaXB0OiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuICApOiB2b2lkIHtcbiAgICBpZiAocmVjZWlwdC5waGFzZSAhPT0gXCJwcmVwYXJlZFwiKSByZXR1cm47XG4gICAgdm9pZCBlbnZpcm9ubWVudENvbnRyb2xsZXIucmVzdW1lUHJlcGFyZWQocmVxdWVzdGVkLCByZWNlaXB0KTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGNhbmNlbEVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHZvaWQge1xuICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8IChyZWNlaXB0LnBoYXNlICE9PSBcInByZXBhcmluZ1wiICYmIHJlY2VpcHQucGhhc2UgIT09IFwicHJlcGFyZWRcIikpIHJldHVybjtcbiAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICBleHRlcm5hbEJ1c3kgPSB0cnVlO1xuICAgIGRyYXcoKTtcbiAgICB2b2lkIGNhbmNlbFByZXBhcmVkRW52aXJvbm1lbnQocmVjZWlwdClcbiAgICAgIC50aGVuKCgpID0+IHtcbiAgICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBjdXJyZW50U2VsZWN0aW9uKCk7XG4gICAgICAgIGlmICh0cmFuc2FjdGlvbj8ucGhhc2UgPT09IFwiY2FuY2VsbGVkXCIgJiYgc2VsZWN0ZWQpIHtcbiAgICAgICAgICBlbnZpcm9ubWVudENvbnRyb2xsZXIuc2V0U2VsZWN0ZWQoc2VsZWN0ZWQpO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gc2FmZVVpRXJyb3IoZXJyb3IpO1xuICAgICAgfSlcbiAgICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgIGRyYXcoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVjb3ZlckVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVjZWlwdDogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHZvaWQge1xuICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8ICFlbnZpcm9ubWVudFRyYW5zYWN0aW9uQ2FuUmVjb3ZlcihyZWNlaXB0KSkgcmV0dXJuO1xuICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgIGV4dGVybmFsQnVzeSA9IHRydWU7XG4gICAgZHJhdygpO1xuICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgIC5pbnZva2UoXCJ0d2Vha2VyOnJvbGxiYWNrLWVudmlyb25tZW50XCIsIHsgdHJhbnNhY3Rpb25JZDogcmVjZWlwdC50cmFuc2FjdGlvbklkIH0pXG4gICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgIHRyYW5zYWN0aW9uID0gbm9ybWFsaXplRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZXN1bHQpID8/IHJlY2VpcHQ7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgICAgICBleHRlcm5hbEJ1c3kgPSBmYWxzZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gYENvdWxkIG5vdCByZWNvdmVyIHRoZSBhcHAgbW9kZSBzYWZlbHk6ICR7c2FmZVVpRXJyb3IoZXJyb3IpfWA7XG4gICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgIC4uLnJlY2VpcHQsXG4gICAgICAgICAgZXJyb3I6IGVudmlyb25tZW50QWN0aW9uRXJyb3IsXG4gICAgICAgIH07XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IGZhbHNlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gYXBwZW5kRW52aXJvbm1lbnRUcmFuc2FjdGlvblJvdygpOiB2b2lkIHtcbiAgICBpZiAoIXRyYW5zYWN0aW9uKSByZXR1cm47XG4gICAgY29uc3QgcmVjZWlwdCA9IHRyYW5zYWN0aW9uO1xuICAgIGNvbnN0IHJlcXVlc3RlZCA9IGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24ocmVjZWlwdCk7XG4gICAgY29uc3QgaGVscGVySW5GbGlnaHQgPSBlbnZpcm9ubWVudEhlbHBlcklzSW5GbGlnaHQocmVjZWlwdCk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChlbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KHJlY2VpcHQsIHtcbiAgICAgIGJ1c3k6IGlzRW52aXJvbm1lbnRCdXN5KCksXG4gICAgICBvblJlc3VtZTogcmVjZWlwdC5waGFzZSA9PT0gXCJwcmVwYXJlZFwiICYmIHJlcXVlc3RlZCAmJiAhaGVscGVySW5GbGlnaHRcbiAgICAgICAgPyAoKSA9PiBvcGVuUHJlcGFyZWRFbnZpcm9ubWVudENvbmZpcm1hdGlvbihyZXF1ZXN0ZWQsIHJlY2VpcHQpXG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgb25DYW5jZWw6IChyZWNlaXB0LnBoYXNlID09PSBcInByZXBhcmluZ1wiIHx8IHJlY2VpcHQucGhhc2UgPT09IFwicHJlcGFyZWRcIikgJiYgIWhlbHBlckluRmxpZ2h0XG4gICAgICAgID8gKCkgPT4gY2FuY2VsRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIG9uUmVjb3ZlcjogZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIocmVjZWlwdClcbiAgICAgICAgPyAoKSA9PiByZWNvdmVyRW52aXJvbm1lbnRUcmFuc2FjdGlvbihyZWNlaXB0KVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KSk7XG4gIH1cblxuICBjb25zdCBkcmF3ID0gKCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHNlbGVjdGVkID0gY3VycmVudFNlbGVjdGlvbigpO1xuICAgIGlmICghc2VsZWN0ZWQgfHwgIWVudmlyb25tZW50KSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IHVuYXZhaWxhYmxlXCIsIFwiVGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgc2VsZWN0aW9uIGNvdWxkIG5vdCBiZSBsb2FkZWQuXCIpKTtcbiAgICAgIGFwcGVuZEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3coKTtcbiAgICAgIGlmIChlbnZpcm9ubWVudEFjdGlvbkVycm9yICYmIGVudmlyb25tZW50QWN0aW9uRXJyb3IgIT09IHRyYW5zYWN0aW9uPy5lcnJvcikge1xuICAgICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IGFjdGlvbiBmYWlsZWRcIiwgZW52aXJvbm1lbnRBY3Rpb25FcnJvcikpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBwZW5kaW5nID0gZW52aXJvbm1lbnRDb250cm9sbGVyLnNuYXBzaG90LnBlbmRpbmc7XG4gICAgY29uc3QgYnVzeSA9IGlzRW52aXJvbm1lbnRCdXN5KCk7XG4gICAgY29uc3Qgb2JzZXJ2ZWRFeHBlcmllbmNlID0gZW52aXJvbm1lbnQub2JzZXJ2YXRpb24/LmFwcEV4cGVyaWVuY2U7XG4gICAgY29uc3Qgb2JzZXJ2YXRpb25OZWVkc1JlcGFpciA9IGVudmlyb25tZW50Lm9ic2VydmF0aW9uICE9PSB1bmRlZmluZWRcbiAgICAgICYmIChvYnNlcnZlZEV4cGVyaWVuY2UgPT09IG51bGxcbiAgICAgICAgfHwgb2JzZXJ2ZWRFeHBlcmllbmNlICE9PSBzZWxlY3RlZC5hcHBFeHBlcmllbmNlXG4gICAgICAgIHx8IGVudmlyb25tZW50Lm9ic2VydmF0aW9uLnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudCk7XG4gICAgY29uc3QgZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgPSBidXN5XG4gICAgICB8fCBvYnNlcnZhdGlvbk5lZWRzUmVwYWlyXG4gICAgICB8fCAodHJhbnNhY3Rpb24gIT09IG51bGwgJiYgKFxuICAgICAgICAhZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwodHJhbnNhY3Rpb24ucGhhc2UpXG4gICAgICAgIHx8IGVudmlyb25tZW50VHJhbnNhY3Rpb25DYW5SZWNvdmVyKHRyYW5zYWN0aW9uKVxuICAgICAgKSk7XG5cbiAgICBpZiAob2JzZXJ2YXRpb25OZWVkc1JlcGFpcikge1xuICAgICAgY29uc3QgZGV0YWlsID0gZW52aXJvbm1lbnQub2JzZXJ2YXRpb24/LnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudFxuICAgICAgICA/IFwiQSBsZWdhY3kgbW9kZSB0cmFuc2l0aW9uIGlzIHN0aWxsIHByZXNlbnQuIFJ1biB0d2Vha2VyIHJlcGFpciBpbiBUZXJtaW5hbCBiZWZvcmUgc3dpdGNoaW5nLlwiXG4gICAgICAgIDogb2JzZXJ2ZWRFeHBlcmllbmNlID09PSBudWxsIHx8IG9ic2VydmVkRXhwZXJpZW5jZSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyBcIlRoZSBsaXZlIGFwcCBtYXJrZXIgY291bGQgbm90IGJlIHZlcmlmaWVkLiBSdW4gdHdlYWtlciByZXBhaXIgaW4gVGVybWluYWwgYmVmb3JlIHN3aXRjaGluZy5cIlxuICAgICAgICAgIDogYFNhdmVkIG1vZGUgaXMgJHtlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbChzZWxlY3RlZC5hcHBFeHBlcmllbmNlKX0sIGJ1dCB0aGUgbGl2ZSBhcHAgcHJvdmVzICR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwob2JzZXJ2ZWRFeHBlcmllbmNlKX0uIFJ1biB0d2Vha2VyIHJlcGFpciBpbiBUZXJtaW5hbC5gO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJFbnZpcm9ubWVudCBuZWVkcyByZXBhaXJcIiwgZGV0YWlsKSk7XG4gICAgfVxuXG4gICAgY29uc3QgcGVuZGluZ0F2YWlsYWJpbGl0eSA9IGVudmlyb25tZW50U2VsZWN0aW9uQXZhaWxhYmlsaXR5KGVudmlyb25tZW50LCBwZW5kaW5nKTtcbiAgICBjb25zdCBjaGF0Z3B0QXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IFwiY2hhdGdwdFwiLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IHBlbmRpbmcucmVsZWFzZVByb2ZpbGUsXG4gICAgfSk7XG4gICAgY29uc3QgdHdlYWtlcnNBdmFpbGFiaWxpdHkgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShlbnZpcm9ubWVudCwge1xuICAgICAgYXBwRXhwZXJpZW5jZTogXCJ0d2Vha2Vyc1wiLFxuICAgICAgcmVsZWFzZVByb2ZpbGU6IHBlbmRpbmcucmVsZWFzZVByb2ZpbGUsXG4gICAgfSk7XG5cbiAgICBjYXJkLmFwcGVuZENoaWxkKGVudmlyb25tZW50Q2hvaWNlUm93KFxuICAgICAgXCJBcHAgTW9kZVwiLFxuICAgICAgXCJDaGF0R1BUIGRpc2FibGVzIGV2ZXJ5IHR3ZWFrLiBUd2Vha2VycyByZXN0b3JlcyB0aGUgdHdlYWtzIHlvdSBwcmV2aW91c2x5IGVuYWJsZWQuXCIsXG4gICAgICBbXG4gICAgICAgIHtcbiAgICAgICAgICB2YWx1ZTogXCJjaGF0Z3B0XCIsXG4gICAgICAgICAgbGFiZWw6IFwiQ2hhdEdQVFwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBjaGF0Z3B0QXZhaWxhYmlsaXR5LmF2YWlsYWJsZVxuICAgICAgICAgICAgPyBcIk9wZW5BSSdzIHN0YW5kYXJkIGFwcCBleHBlcmllbmNlLlwiXG4gICAgICAgICAgICA6IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oY2hhdGdwdEF2YWlsYWJpbGl0eSwgXCJDaGF0R1BUIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICFjaGF0Z3B0QXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKGNoYXRncHRBdmFpbGFiaWxpdHksIFwiQ2hhdEdQVCBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgdmFsdWU6IFwidHdlYWtlcnNcIixcbiAgICAgICAgICBsYWJlbDogXCJUd2Vha2Vyc1wiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiB0d2Vha2Vyc0F2YWlsYWJpbGl0eS5hdmFpbGFibGVcbiAgICAgICAgICAgID8gXCJUaGUgc3RhbmRhcmQgYXBwIHdpdGggZW5hYmxlZCBUd2Vha2VycyBmZWF0dXJlcy5cIlxuICAgICAgICAgICAgOiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKHR3ZWFrZXJzQXZhaWxhYmlsaXR5LCBcIlR3ZWFrZXJzIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIHJlbGVhc2UgcHJvZmlsZS5cIiksXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICF0d2Vha2Vyc0F2YWlsYWJpbGl0eS5hdmFpbGFibGUsXG4gICAgICAgICAgZGlzYWJsZWRSZWFzb246IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkXG4gICAgICAgICAgICA/IFwiRmluaXNoLCBjYW5jZWwsIG9yIHJlY292ZXIgdGhlIGN1cnJlbnQgZW52aXJvbm1lbnQgdHJhbnNhY3Rpb24gZmlyc3QuXCJcbiAgICAgICAgICAgIDogZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbih0d2Vha2Vyc0F2YWlsYWJpbGl0eSwgXCJUd2Vha2VycyBpcyB1bmF2YWlsYWJsZSBmb3IgdGhpcyByZWxlYXNlIHByb2ZpbGUuXCIpLFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgICh2YWx1ZSkgPT4ge1xuICAgICAgICBlbnZpcm9ubWVudENvbnRyb2xsZXIuc3RhZ2VBcHBFeHBlcmllbmNlKHZhbHVlIGFzIEVudmlyb25tZW50QXBwRXhwZXJpZW5jZSk7XG4gICAgICB9LFxuICAgICkpO1xuXG4gICAgY29uc3Qgc3RhYmxlQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiLFxuICAgIH0pO1xuICAgIGNvbnN0IGFscGhhQXZhaWxhYmlsaXR5ID0gZW52aXJvbm1lbnRTZWxlY3Rpb25BdmFpbGFiaWxpdHkoZW52aXJvbm1lbnQsIHtcbiAgICAgIGFwcEV4cGVyaWVuY2U6IHBlbmRpbmcuYXBwRXhwZXJpZW5jZSxcbiAgICAgIHJlbGVhc2VQcm9maWxlOiBcImFscGhhXCIsXG4gICAgfSk7XG4gICAgY29uc3Qgc3RhYmxlUmVhc29uID0gZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihzdGFibGVBdmFpbGFiaWxpdHksIFwiU3RhYmxlIGlzIHVuYXZhaWxhYmxlIGZvciB0aGlzIGFwcCBleHBlcmllbmNlLlwiKTtcbiAgICBjb25zdCBhbHBoYVJlYXNvbiA9IGVudmlyb25tZW50VW5hdmFpbGFibGVSZWFzb24oYWxwaGFBdmFpbGFiaWxpdHksIFwiQWxwaGEgKFByZS1yZWxlYXNlKSBpcyB1bmF2YWlsYWJsZSBvbiB0aGlzIE1hYy5cIik7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChlbnZpcm9ubWVudENob2ljZVJvdyhcbiAgICAgIFwiRGVza3RvcCBSZWxlYXNlXCIsXG4gICAgICBcIkNob29zZSBPcGVuQUkncyBTdGFibGUgb3IgQWxwaGEgZGVza3RvcCBhcHAgaW5kZXBlbmRlbnRseSBvZiBhcHAgbW9kZS4gSXRzIGVtYmVkZGVkIENvZGV4IGJhY2tlbmQgY2FuIGhhdmUgYSBkaWZmZXJlbnQgdmVyc2lvbiBsYWJlbC5cIixcbiAgICAgIFtcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcInN0YWJsZVwiLFxuICAgICAgICAgIGxhYmVsOiBcIlN0YWJsZVwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBzdGFibGVBdmFpbGFiaWxpdHkuYXZhaWxhYmxlID8gXCJUaGUgc3VwcG9ydGVkIHN0YWJsZSBkZXNrdG9wIHJlbGVhc2UuXCIgOiBzdGFibGVSZWFzb24sXG4gICAgICAgICAgZGlzYWJsZWQ6IGVudmlyb25tZW50U2VsZWN0aW9uTG9ja2VkIHx8ICFzdGFibGVBdmFpbGFiaWxpdHkuYXZhaWxhYmxlLFxuICAgICAgICAgIGRpc2FibGVkUmVhc29uOiBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgICAgICAgPyBcIkZpbmlzaCwgY2FuY2VsLCBvciByZWNvdmVyIHRoZSBjdXJyZW50IGVudmlyb25tZW50IHRyYW5zYWN0aW9uIGZpcnN0LlwiXG4gICAgICAgICAgICA6IHN0YWJsZVJlYXNvbixcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIHZhbHVlOiBcImFscGhhXCIsXG4gICAgICAgICAgbGFiZWw6IFwiQWxwaGEgKFByZS1yZWxlYXNlKVwiLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiBhbHBoYUF2YWlsYWJpbGl0eS5hdmFpbGFibGUgPyBcIk9wZW5BSSdzIHZlcmlmaWVkIHByZS1yZWxlYXNlIGRlc2t0b3AgYW5kIG1hdGNoaW5nIGJhY2tlbmQuXCIgOiBhbHBoYVJlYXNvbixcbiAgICAgICAgICBkaXNhYmxlZDogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWQgfHwgIWFscGhhQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSxcbiAgICAgICAgICBkaXNhYmxlZFJlYXNvbjogZW52aXJvbm1lbnRTZWxlY3Rpb25Mb2NrZWRcbiAgICAgICAgICAgID8gXCJGaW5pc2gsIGNhbmNlbCwgb3IgcmVjb3ZlciB0aGUgY3VycmVudCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbiBmaXJzdC5cIlxuICAgICAgICAgICAgOiBhbHBoYVJlYXNvbixcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICBwZW5kaW5nLnJlbGVhc2VQcm9maWxlLFxuICAgICAgKHZhbHVlKSA9PiB7XG4gICAgICAgIGVudmlyb25tZW50Q29udHJvbGxlci5zdGFnZVJlbGVhc2VQcm9maWxlKHZhbHVlIGFzIEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUpO1xuICAgICAgfSxcbiAgICApKTtcbiAgICBpZiAoIWFscGhhQXZhaWxhYmlsaXR5LmF2YWlsYWJsZSkge1xuICAgICAgY29uc3QgY2hvb3NlciA9IGFjdGlvblJvdyhcbiAgICAgICAgXCJBbHBoYSAoUHJlLXJlbGVhc2UpIHVuYXZhaWxhYmxlXCIsXG4gICAgICAgIGAke2FscGhhUmVhc29ufSBDaG9vc2UgYSB2ZXJpZmllZCBPcGVuQUkgQmV0YSBhcHAgdG8gcmVnaXN0ZXIgaXQgZm9yIHRoaXMgcHJvZmlsZS5gLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGNob29zZXJBY3Rpb25zID0gY2hvb3Nlci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgICAgY29uc3QgY2hvb3NlID0gY29tcGFjdEJ1dHRvbihcIkNob29zZSBCZXRhIEFwcFx1MjAyNlwiLCAoKSA9PiB7XG4gICAgICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpKSByZXR1cm47XG4gICAgICAgIGV4dGVybmFsQnVzeSA9IHRydWU7XG4gICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBudWxsO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjaG9vc2UtYWxwaGEtZW52aXJvbm1lbnRcIilcbiAgICAgICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgICAgICBpZiAocmVzdWx0ICYmIHR5cGVvZiByZXN1bHQgPT09IFwib2JqZWN0XCIgJiYgXCJjYW5jZWxlZFwiIGluIHJlc3VsdCAmJiByZXN1bHQuY2FuY2VsZWQgPT09IHRydWUpIHJldHVybjtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGVudmlyb25tZW50QWN0aW9uRXJyb3IgPSBgQ291bGQgbm90IHJlZ2lzdGVyIE9wZW5BSSBCZXRhOiAke3NhZmVVaUVycm9yKGVycm9yKX1gO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmZpbmFsbHkoKCkgPT4ge1xuICAgICAgICAgICAgZXh0ZXJuYWxCdXN5ID0gZmFsc2U7XG4gICAgICAgICAgICB2b2lkIGxvYWQoKTtcbiAgICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgICAgY2hvb3NlLmRpc2FibGVkID0gaXNFbnZpcm9ubWVudEJ1c3koKTtcbiAgICAgIGNob29zZXJBY3Rpb25zPy5hcHBlbmRDaGlsZChjaG9vc2UpO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChjaG9vc2VyKTtcbiAgICB9XG5cbiAgICBjb25zdCBzdW1tYXJ5ID0gYWN0aW9uUm93KFxuICAgICAgXCJQZW5kaW5nIGNoYW5nZXNcIixcbiAgICAgIGhhc1BlbmRpbmdDaGFuZ2VzKClcbiAgICAgICAgPyBwZW5kaW5nQXZhaWxhYmlsaXR5LmF2YWlsYWJsZVxuICAgICAgICAgID8gYCR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwocGVuZGluZy5hcHBFeHBlcmllbmNlKX0gXHUwMEI3ICR7ZW52aXJvbm1lbnRQcm9maWxlTGFiZWwocGVuZGluZy5yZWxlYXNlUHJvZmlsZSl9IHdpbGwgYXBwbHkgYWZ0ZXIgcmVzdGFydC5gXG4gICAgICAgICAgOiBgVW5hdmFpbGFibGU6ICR7ZW52aXJvbm1lbnRVbmF2YWlsYWJsZVJlYXNvbihwZW5kaW5nQXZhaWxhYmlsaXR5LCBcIlRoaXMgZW52aXJvbm1lbnQgY2Fubm90IGJlIHByZXBhcmVkLlwiKX1gXG4gICAgICAgIDogYEN1cnJlbnQ6ICR7ZW52aXJvbm1lbnRFeHBlcmllbmNlTGFiZWwoc2VsZWN0ZWQuYXBwRXhwZXJpZW5jZSl9IFx1MDBCNyAke2Vudmlyb25tZW50UHJvZmlsZUxhYmVsKHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlKX0uYCxcbiAgICApO1xuICAgIGNvbnN0IGFjdGlvbnMgPSBzdW1tYXJ5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgYXBwbHkgPSBjb21wYWN0QnV0dG9uKFwiQXBwbHkgJiBSZXN0YXJ0XCIsICgpID0+IHtcbiAgICAgIGlmIChpc0Vudmlyb25tZW50QnVzeSgpIHx8ICFoYXNQZW5kaW5nQ2hhbmdlcygpKSByZXR1cm47XG4gICAgICBlbnZpcm9ubWVudEFjdGlvbkVycm9yID0gbnVsbDtcbiAgICAgIHZvaWQgZW52aXJvbm1lbnRDb250cm9sbGVyLmFwcGx5QW5kUmVzdGFydCgpXG4gICAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICBpZiAocmVzdWx0Lm91dGNvbWUgPT09IFwicHJlcGFyZS1mYWlsZWRcIikge1xuICAgICAgICAgICAgZW52aXJvbm1lbnRBY3Rpb25FcnJvciA9IHJlc3VsdC5lcnJvcjtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHJlc3VsdC5vdXRjb21lLmVuZHNXaXRoKFwiZmFpbGVkXCIpKSB7XG4gICAgICAgICAgICBkcmF3KCk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHZvaWQgbG9hZEVudmlyb25tZW50VHJhbnNhY3Rpb24oKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYXBwbHkuZGlzYWJsZWQgPSBlbnZpcm9ubWVudFNlbGVjdGlvbkxvY2tlZFxuICAgICAgfHwgIWhhc1BlbmRpbmdDaGFuZ2VzKClcbiAgICAgIHx8ICFwZW5kaW5nQXZhaWxhYmlsaXR5LmF2YWlsYWJsZTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChhcHBseSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcbiAgICBhcHBlbmRFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KCk7XG4gICAgaWYgKGVudmlyb25tZW50QWN0aW9uRXJyb3IgJiYgZW52aXJvbm1lbnRBY3Rpb25FcnJvciAhPT0gdHJhbnNhY3Rpb24/LmVycm9yKSB7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkVudmlyb25tZW50IGFjdGlvbiBmYWlsZWRcIiwgZW52aXJvbm1lbnRBY3Rpb25FcnJvcikpO1xuICAgIH1cbiAgfTtcblxuICBhc3luYyBmdW5jdGlvbiBsb2FkRW52aXJvbm1lbnRUcmFuc2FjdGlvbigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IHByZXZpb3VzID0gdHJhbnNhY3Rpb247XG4gICAgICB0cmFuc2FjdGlvbiA9IG5vcm1hbGl6ZUVudmlyb25tZW50VHJhbnNhY3Rpb24ocmVzdWx0KTtcbiAgICAgIGlmIChcbiAgICAgICAgdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmVkXCJcbiAgICAgICAgJiYgIXRyYW5zYWN0aW9uLmhlbHBlclxuICAgICAgICAmJiBwcmV2aW91cz8udHJhbnNhY3Rpb25JZCA9PT0gdHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZFxuICAgICAgICAmJiBwcmV2aW91cy5oZWxwZXJcbiAgICAgICkge1xuICAgICAgICB0cmFuc2FjdGlvbiA9IHtcbiAgICAgICAgICAuLi50cmFuc2FjdGlvbixcbiAgICAgICAgICBlcnJvcjogdHJhbnNhY3Rpb24uZXJyb3IgPz8gcHJldmlvdXMuZXJyb3IsXG4gICAgICAgICAgaGVscGVyOiBwcmV2aW91cy5oZWxwZXIsXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgICByZXN0b3JlUGVyc2lzdGVkUmVxdWVzdCgpO1xuICAgICAgZHJhdygpO1xuICAgICAgaWYgKHRyYW5zYWN0aW9uICYmIGVudmlyb25tZW50VHJhbnNhY3Rpb25Jc1Rlcm1pbmFsKHRyYW5zYWN0aW9uLnBoYXNlKSkge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHN0YXR1c1VwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtc3RhdHVzXCIpO1xuICAgICAgICAgIGNvbnN0IHN0YXR1c1Jlc3VsdCA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICAgICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpIHx8ICFjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgICAgICAgIGVudmlyb25tZW50ID0gbm9ybWFsaXplRW52aXJvbm1lbnRTdGF0dXMoc3RhdHVzUmVzdWx0KSA/PyBlbnZpcm9ubWVudDtcbiAgICAgICAgICBjb25zdCBzZWxlY3RlZCA9IGN1cnJlbnRTZWxlY3Rpb24oKTtcbiAgICAgICAgICBpZiAoc2VsZWN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5zZXRTZWxlY3RlZChzZWxlY3RlZCk7XG4gICAgICAgICAgZHJhdygpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgICAgLi4udHJhbnNhY3Rpb24sXG4gICAgICAgICAgICBlcnJvcjogdHJhbnNhY3Rpb24uZXJyb3IgPz8gYENvdWxkIG5vdCByZWZyZXNoIGVudmlyb25tZW50IHN0YXR1czogJHtzYWZlVWlFcnJvcihlcnJvcil9YCxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGRyYXcoKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBpZiAodHJhbnNhY3Rpb24pIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSB7XG4gICAgICAgICAgLi4udHJhbnNhY3Rpb24sXG4gICAgICAgICAgZXJyb3I6IGBDb3VsZCBub3QgcmVmcmVzaCBlbnZpcm9ubWVudCB0cmFuc2FjdGlvbjogJHtzYWZlVWlFcnJvcihlcnJvcil9YCxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIGRyYXcoKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKGNhcmRVcGRhdGVzLmlzQ3VycmVudCh1cGRhdGUpKSBzY2hlZHVsZUVudmlyb25tZW50VHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbG9hZCA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICBjb25zdCBzdGF0dXNVcGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcImVudmlyb25tZW50LXN0YXR1c1wiKTtcbiAgICBjb25zdCB0cmFuc2FjdGlvblVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZW52aXJvbm1lbnQtdHJhbnNhY3Rpb25cIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IFtzdGF0dXNSZXN1bHQsIHRyYW5zYWN0aW9uUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtZW52aXJvbm1lbnQtc3RhdHVzXCIpLFxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1lbnZpcm9ubWVudC10cmFuc2FjdGlvblwiKSxcbiAgICAgIF0pO1xuICAgICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjb25zdCBzdGF0dXNJc0N1cnJlbnQgPSBjYXJkVXBkYXRlcy5pc0N1cnJlbnQoc3RhdHVzVXBkYXRlKTtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uSXNDdXJyZW50ID0gY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHRyYW5zYWN0aW9uVXBkYXRlKTtcbiAgICAgIGlmICghc3RhdHVzSXNDdXJyZW50ICYmICF0cmFuc2FjdGlvbklzQ3VycmVudCkgcmV0dXJuO1xuICAgICAgaWYgKHN0YXR1c0lzQ3VycmVudCkge1xuICAgICAgICBlbnZpcm9ubWVudCA9IG5vcm1hbGl6ZUVudmlyb25tZW50U3RhdHVzKHN0YXR1c1Jlc3VsdCk7XG4gICAgICAgIGlmIChlbnZpcm9ubWVudD8uc2VsZWN0ZWQpIGVudmlyb25tZW50Q29udHJvbGxlci5zZXRTZWxlY3RlZChlbnZpcm9ubWVudC5zZWxlY3RlZCk7XG4gICAgICB9XG4gICAgICBpZiAodHJhbnNhY3Rpb25Jc0N1cnJlbnQpIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHRyYW5zYWN0aW9uUmVzdWx0KTtcbiAgICAgICAgcmVzdG9yZVBlcnNpc3RlZFJlcXVlc3QoKTtcbiAgICAgIH1cbiAgICAgIGRyYXcoKTtcbiAgICAgIHNjaGVkdWxlRW52aXJvbm1lbnRUcmFuc2FjdGlvblBvbGwoKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKCghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHN0YXR1c1VwZGF0ZSkgJiYgIWNhcmRVcGRhdGVzLmlzQ3VycmVudCh0cmFuc2FjdGlvblVwZGF0ZSkpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGxvYWQgZW52aXJvbm1lbnRcIiwgc2FmZVVpRXJyb3IoZXJyb3IpKSk7XG4gICAgfVxuICB9O1xuXG4gIHZvaWQgbG9hZCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJlbnZpcm9ubWVudC1zdGF0dXNcIik7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcImVudmlyb25tZW50LXRyYW5zYWN0aW9uXCIpO1xuICAgIGlmICh0cmFuc2FjdGlvblBvbGxpbmcpIGNsZWFyVGltZW91dCh0cmFuc2FjdGlvblBvbGxpbmcpO1xuICAgIHRyYW5zYWN0aW9uUG9sbGluZyA9IG51bGw7XG4gIH07XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50VHJhbnNhY3Rpb25SZXF1ZXN0ZWRTZWxlY3Rpb24oXG4gIHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uLFxuKTogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+IHwgbnVsbCB7XG4gIGNvbnN0IHJlcXVlc3RlZCA9IHRyYW5zYWN0aW9uLnJlcXVlc3RlZDtcbiAgaWYgKCFyZXF1ZXN0ZWQpIHJldHVybiBudWxsO1xuICBpZiAocmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwiY2hhdGdwdFwiICYmIHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlICE9PSBcInR3ZWFrZXJzXCIpIHJldHVybiBudWxsO1xuICBpZiAocmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcInN0YWJsZVwiICYmIHJlcXVlc3RlZC5yZWxlYXNlUHJvZmlsZSAhPT0gXCJhbHBoYVwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgYXBwRXhwZXJpZW5jZTogcmVxdWVzdGVkLmFwcEV4cGVyaWVuY2UsIHJlbGVhc2VQcm9maWxlOiByZXF1ZXN0ZWQucmVsZWFzZVByb2ZpbGUgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvbklzVGVybWluYWwocGhhc2U6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gW1wiY29tbWl0dGVkXCIsIFwiY29tcGxldGVkXCIsIFwicm9sbGVkLWJhY2tcIiwgXCJyb2xsZWRfYmFja1wiLCBcImZhaWxlZFwiLCBcImNhbmNlbGxlZFwiXS5pbmNsdWRlcyhwaGFzZSk7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50Q2hvaWNlUm93KFxuICB0aXRsZTogc3RyaW5nLFxuICBkZXNjcmlwdGlvbjogc3RyaW5nLFxuICBjaG9pY2VzOiBBcnJheTx7IHZhbHVlOiBzdHJpbmc7IGxhYmVsOiBzdHJpbmc7IGRlc2NyaXB0aW9uOiBzdHJpbmc7IGRpc2FibGVkPzogYm9vbGVhbjsgZGlzYWJsZWRSZWFzb24/OiBzdHJpbmcgfT4sXG4gIHNlbGVjdGVkOiBzdHJpbmcsXG4gIG9uQ2hhbmdlOiAodmFsdWU6IHN0cmluZykgPT4gdm9pZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtc3RhcnQganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gcm93Q29weSh0aXRsZSwgZGVzY3JpcHRpb24pO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgZmxleC13cmFwIHJvdW5kZWQtbGcgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMC41XCI7XG4gIGFjdGlvbnMuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcImdyb3VwXCIpO1xuICBhY3Rpb25zLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdGl0bGUpO1xuICBmb3IgKGNvbnN0IGNob2ljZSBvZiBjaG9pY2VzKSB7XG4gICAgY29uc3QgYnV0dG9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgICBidXR0b24udHlwZSA9IFwiYnV0dG9uXCI7XG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gY2hvaWNlLmxhYmVsO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGNob2ljZS5kaXNhYmxlZCA9PT0gdHJ1ZTtcbiAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1wcmVzc2VkXCIsIFN0cmluZyhjaG9pY2UudmFsdWUgPT09IHNlbGVjdGVkKSk7XG4gICAgaWYgKGNob2ljZS5kaXNhYmxlZCkgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtZGlzYWJsZWRcIiwgXCJ0cnVlXCIpO1xuICAgIGlmIChjaG9pY2UuZGlzYWJsZWRSZWFzb24pIGJ1dHRvbi50aXRsZSA9IGNob2ljZS5kaXNhYmxlZFJlYXNvbjtcbiAgICBidXR0b24uY2xhc3NOYW1lID0gYHJvdW5kZWQtbWQgcHgtMyBweS0xLjUgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyICR7Y2hvaWNlLnZhbHVlID09PSBzZWxlY3RlZCA/IFwiYmctdG9rZW4tYmctcHJpbWFyeSBzaGFkb3ctc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIiA6IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3Zlcjp0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwifWA7XG4gICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvbkNoYW5nZShjaG9pY2UudmFsdWUpKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gIH1cbiAgY29uc3QgZGlzYWJsZWRSZWFzb24gPSBjaG9pY2VzLmZpbmQoKGNob2ljZSkgPT4gY2hvaWNlLmRpc2FibGVkICYmIGNob2ljZS5kaXNhYmxlZFJlYXNvbik/LmRpc2FibGVkUmVhc29uO1xuICBpZiAoZGlzYWJsZWRSZWFzb24pIHtcbiAgICBjb25zdCByZWFzb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHJlYXNvbi5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgdGV4dC14c1wiO1xuICAgIHJlYXNvbi50ZXh0Q29udGVudCA9IGRpc2FibGVkUmVhc29uO1xuICAgIGxlZnQuYXBwZW5kQ2hpbGQocmVhc29uKTtcbiAgfVxuICByb3cuYXBwZW5kKGxlZnQsIGFjdGlvbnMpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudEV4cGVyaWVuY2VMYWJlbCh2YWx1ZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImNoYXRncHRcIiA/IFwiQ2hhdEdQVFwiIDogXCJUd2Vha2Vyc1wiO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFNlbGVjdGlvbkF2YWlsYWJpbGl0eShcbiAgZW52aXJvbm1lbnQ6IEVudmlyb25tZW50U3RhdHVzLFxuICBzZWxlY3Rpb246IFBpY2s8RW52aXJvbm1lbnRTZWxlY3Rpb24sIFwiYXBwRXhwZXJpZW5jZVwiIHwgXCJyZWxlYXNlUHJvZmlsZVwiPixcbik6IHsgYXZhaWxhYmxlOiBib29sZWFuOyB1bmF2YWlsYWJsZVJlYXNvbnM/OiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY2hhbm5lbCA9IGVudmlyb25tZW50LmNoYW5uZWxzW3NlbGVjdGlvbi5yZWxlYXNlUHJvZmlsZV07XG4gIHJldHVybiBjaGFubmVsLmF2YWlsYWJpbGl0eT8uW3NlbGVjdGlvbi5hcHBFeHBlcmllbmNlXSA/PyB7XG4gICAgYXZhaWxhYmxlOiBjaGFubmVsLmF2YWlsYWJsZSxcbiAgICB1bmF2YWlsYWJsZVJlYXNvbnM6IGNoYW5uZWwudW5hdmFpbGFibGVSZWFzb25zLFxuICB9O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFVuYXZhaWxhYmxlUmVhc29uKFxuICBhdmFpbGFiaWxpdHk6IHsgdW5hdmFpbGFibGVSZWFzb25zPzogc3RyaW5nW10gfSxcbiAgZmFsbGJhY2s6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIHJldHVybiBhdmFpbGFiaWxpdHkudW5hdmFpbGFibGVSZWFzb25zPy5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIikgfHwgZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50UHJvZmlsZUxhYmVsKHZhbHVlOiBFbnZpcm9ubWVudFJlbGVhc2VQcm9maWxlKTogc3RyaW5nIHtcbiAgcmV0dXJuIHZhbHVlID09PSBcImFscGhhXCIgPyBcIkFscGhhIChQcmUtcmVsZWFzZSlcIiA6IFwiU3RhYmxlXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVudmlyb25tZW50U3RhdHVzKHZhbHVlOiB1bmtub3duKTogRW52aXJvbm1lbnRTdGF0dXMgfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPEVudmlyb25tZW50U3RhdHVzPjtcbiAgY29uc3Qgc2VsZWN0ZWQgPSBjYW5kaWRhdGUuc2VsZWN0ZWQ7XG4gIGlmICghc2VsZWN0ZWQgfHwgKHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwiY2hhdGdwdFwiICYmIHNlbGVjdGVkLmFwcEV4cGVyaWVuY2UgIT09IFwidHdlYWtlcnNcIikgfHwgKHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcInN0YWJsZVwiICYmIHNlbGVjdGVkLnJlbGVhc2VQcm9maWxlICE9PSBcImFscGhhXCIpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY2hhbm5lbHMgPSBjYW5kaWRhdGUuY2hhbm5lbHMgYXMgUGFydGlhbDxSZWNvcmQ8RW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSwgRW52aXJvbm1lbnRDaGFubmVsU3RhdHVzPj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHJhd09ic2VydmF0aW9uID0gY2FuZGlkYXRlLm9ic2VydmF0aW9uO1xuICBjb25zdCBvYnNlcnZhdGlvbiA9IHJhd09ic2VydmF0aW9uXG4gICAgJiYgKHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IG51bGxcbiAgICAgIHx8IHJhd09ic2VydmF0aW9uLmFwcEV4cGVyaWVuY2UgPT09IFwiY2hhdGdwdFwiXG4gICAgICB8fCByYXdPYnNlcnZhdGlvbi5hcHBFeHBlcmllbmNlID09PSBcInR3ZWFrZXJzXCIpXG4gICAgPyB7XG4gICAgICBhcHBFeHBlcmllbmNlOiByYXdPYnNlcnZhdGlvbi5hcHBFeHBlcmllbmNlLFxuICAgICAgc2VsZWN0aW9uRHJpZnQ6IHJhd09ic2VydmF0aW9uLnNlbGVjdGlvbkRyaWZ0ID09PSB0cnVlLFxuICAgICAgbGlmZWN5Y2xlQ29udGVuZGVkOiByYXdPYnNlcnZhdGlvbi5saWZlY3ljbGVDb250ZW5kZWQgPT09IHRydWUsXG4gICAgICBjb21taXRKb3VybmFsUHJlc2VudDogcmF3T2JzZXJ2YXRpb24uY29tbWl0Sm91cm5hbFByZXNlbnQgPT09IHRydWUsXG4gICAgICB0cmFuc2l0aW9uSm91cm5hbFByZXNlbnQ6IHJhd09ic2VydmF0aW9uLnRyYW5zaXRpb25Kb3VybmFsUHJlc2VudCA9PT0gdHJ1ZSxcbiAgICAgIGZyZXNobmVzczogcmF3T2JzZXJ2YXRpb24uZnJlc2huZXNzID09PSBcImNvbnRlbmRlZFwiID8gXCJjb250ZW5kZWRcIiBhcyBjb25zdCA6IFwiY3VycmVudFwiIGFzIGNvbnN0LFxuICAgIH1cbiAgICA6IHVuZGVmaW5lZDtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIHNlbGVjdGVkLFxuICAgIGNoYW5uZWxzOiB7XG4gICAgICBzdGFibGU6IGNoYW5uZWxzPy5zdGFibGUgPz8geyBhdmFpbGFibGU6IHRydWUsIHJlbGVhc2VQcm9maWxlOiBcInN0YWJsZVwiIH0sXG4gICAgICBhbHBoYTogY2hhbm5lbHM/LmFscGhhID8/IHsgYXZhaWxhYmxlOiBmYWxzZSwgdW5hdmFpbGFibGVSZWFzb25zOiBbXCJBbHBoYSAoUHJlLXJlbGVhc2UpIGF2YWlsYWJpbGl0eSB3YXMgbm90IHJlcG9ydGVkLlwiXSwgcmVsZWFzZVByb2ZpbGU6IFwiYWxwaGFcIiB9LFxuICAgIH0sXG4gICAgLi4uKG9ic2VydmF0aW9uID8geyBvYnNlcnZhdGlvbiB9IDoge30pLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFbnZpcm9ubWVudFRyYW5zYWN0aW9uKHZhbHVlOiB1bmtub3duKTogRW52aXJvbm1lbnRUcmFuc2FjdGlvbiB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RW52aXJvbm1lbnRUcmFuc2FjdGlvbj47XG4gIGlmICh0eXBlb2YgY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7XG4gICAgLi4uY2FuZGlkYXRlLFxuICAgIHRyYW5zYWN0aW9uSWQ6IGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gICAgZXJyb3I6IHR5cGVvZiBjYW5kaWRhdGUuZXJyb3IgPT09IFwic3RyaW5nXCIgPyBjYW5kaWRhdGUuZXJyb3IgOiBudWxsLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24odmFsdWU6IHVua25vd24pOiBFbnZpcm9ubWVudEhlbHBlclN1Ym1pc3Npb24gfCBudWxsIHtcbiAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIpIHJldHVybiBudWxsO1xuICBjb25zdCBjYW5kaWRhdGUgPSB2YWx1ZSBhcyBQYXJ0aWFsPEVudmlyb25tZW50SGVscGVyU3VibWlzc2lvbj4gJiB7IGtpbmQ/OiB1bmtub3duIH07XG4gIGlmIChjYW5kaWRhdGUua2luZCAhPT0gXCJlbnZpcm9ubWVudC1jb21taXQtaGVscGVyXCIpIHJldHVybiBudWxsO1xuICBpZiAodHlwZW9mIGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgaWYgKGNhbmRpZGF0ZS5waGFzZSAhPT0gXCJzdWJtaXR0ZWRcIiAmJiBjYW5kaWRhdGUucGhhc2UgIT09IFwic3VibWl0LWZhaWxlZFwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBcImVudmlyb25tZW50LWNvbW1pdC1oZWxwZXJcIixcbiAgICB0cmFuc2FjdGlvbklkOiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCxcbiAgICBwaGFzZTogY2FuZGlkYXRlLnBoYXNlLFxuICAgIGVycm9yOiB0eXBlb2YgY2FuZGlkYXRlLmVycm9yID09PSBcInN0cmluZ1wiID8gY2FuZGlkYXRlLmVycm9yIDogbnVsbCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRIZWxwZXJJc0luRmxpZ2h0KHRyYW5zYWN0aW9uOiBFbnZpcm9ubWVudFRyYW5zYWN0aW9uKTogYm9vbGVhbiB7XG4gIGNvbnN0IGhlbHBlciA9IHRyYW5zYWN0aW9uLmhlbHBlcjtcbiAgY29uc3Qgb3V0Y29tZVBoYXNlID0gaGVscGVyPy5vdXRjb21lPy5waGFzZTtcbiAgcmV0dXJuIG91dGNvbWVQaGFzZSA9PT0gXCJub3Qtc3RhcnRlZFwiXG4gICAgfHwgb3V0Y29tZVBoYXNlID09PSBcInJ1bm5pbmdcIlxuICAgIHx8IChoZWxwZXI/LnN1Ym1pc3Npb24/LnBoYXNlID09PSBcInN1Ym1pdHRlZFwiICYmIG91dGNvbWVQaGFzZSA9PT0gdW5kZWZpbmVkKTtcbn1cblxuZnVuY3Rpb24gZW52aXJvbm1lbnRUcmFuc2FjdGlvbkNhblJlY292ZXIodHJhbnNhY3Rpb246IEVudmlyb25tZW50VHJhbnNhY3Rpb24pOiBib29sZWFuIHtcbiAgaWYgKHRyYW5zYWN0aW9uLnBoYXNlID09PSBcImZhaWxlZFwiKSByZXR1cm4gdHJhbnNhY3Rpb24ucHJlcGFyZWQgIT09IG51bGwgJiYgdHJhbnNhY3Rpb24ucHJlcGFyZWQgIT09IHVuZGVmaW5lZDtcbiAgcmV0dXJuIFtcImNvbW1pdHRpbmdcIiwgXCJhcHBseWluZ1wiLCBcInJlb3BlbmluZ1wiLCBcInZlcmlmeWluZ1wiLCBcInJvbGxpbmctYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSk7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50SGVscGVyRmFpbHVyZURldGFpbCh0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbik6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBoZWxwZXIgPSB0cmFuc2FjdGlvbi5oZWxwZXI7XG4gIGlmICghaGVscGVyKSByZXR1cm4gbnVsbDtcbiAgY29uc3Qgb3V0Y29tZSA9IGhlbHBlci5vdXRjb21lO1xuICBjb25zdCBzdWJtaXNzaW9uID0gaGVscGVyLnN1Ym1pc3Npb247XG4gIGNvbnN0IGZhaWxlZCA9IG91dGNvbWU/LnBoYXNlID09PSBcImZhaWxlZFwiXG4gICAgfHwgc3VibWlzc2lvbj8ucGhhc2UgPT09IFwic3VibWl0LWZhaWxlZFwiXG4gICAgfHwgdHlwZW9mIG91dGNvbWU/LmVycm9yID09PSBcInN0cmluZ1wiXG4gICAgfHwgdHlwZW9mIHN1Ym1pc3Npb24/LmVycm9yID09PSBcInN0cmluZ1wiO1xuICBpZiAoIWZhaWxlZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHN0ZGVyciA9IGVudmlyb25tZW50SGVscGVyTG9nU25pcHBldChoZWxwZXIuc3RkZXJyKTtcbiAgY29uc3Qgc3Rkb3V0ID0gZW52aXJvbm1lbnRIZWxwZXJMb2dTbmlwcGV0KGhlbHBlci5zdGRvdXQpO1xuICBjb25zdCBleGl0Q29kZSA9IHR5cGVvZiBvdXRjb21lPy5leGl0Q29kZSA9PT0gXCJudW1iZXJcIiA/IGBleGl0ICR7b3V0Y29tZS5leGl0Q29kZX1gIDogbnVsbDtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIFwiRW52aXJvbm1lbnQgaGVscGVyIGZhaWxlZFwiLFxuICAgIGV4aXRDb2RlLFxuICAgIG91dGNvbWU/LmVycm9yLFxuICAgIHN1Ym1pc3Npb24/LmVycm9yLFxuICAgIHN0ZGVyciA/IGBzdGRlcnI6ICR7c3RkZXJyfWAgOiBudWxsLFxuICAgICFzdGRlcnIgJiYgc3Rkb3V0ID8gYHN0ZG91dDogJHtzdGRvdXR9YCA6IG51bGwsXG4gIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCk7XG4gIHJldHVybiBbLi4ubmV3IFNldChkZXRhaWwpXS5qb2luKFwiIFx1MDBCNyBcIik7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50SGVscGVyTG9nU25pcHBldCh2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB8IG51bGwge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgY29tcGFjdCA9IHZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cXHMrL2csIFwiIFwiKTtcbiAgaWYgKCFjb21wYWN0KSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIGNvbXBhY3QubGVuZ3RoIDw9IDYwMCA/IGNvbXBhY3QgOiBgXHUyMDI2JHtjb21wYWN0LnNsaWNlKC01OTkpfWA7XG59XG5cbmludGVyZmFjZSBFbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93QWN0aW9ucyB7XG4gIGJ1c3k6IGJvb2xlYW47XG4gIG9uUmVzdW1lPzogKCkgPT4gdm9pZDtcbiAgb25DYW5jZWw/OiAoKSA9PiB2b2lkO1xuICBvblJlY292ZXI/OiAoKSA9PiB2b2lkO1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uUm93KFxuICB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbiAgYWN0aW9uc0NvbmZpZz86IEVudmlyb25tZW50VHJhbnNhY3Rpb25Sb3dBY3Rpb25zLFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBoZWxwZXJGYWlsdXJlID0gZW52aXJvbm1lbnRIZWxwZXJGYWlsdXJlRGV0YWlsKHRyYW5zYWN0aW9uKTtcbiAgY29uc3QgZGV0YWlscyA9IFtcbiAgICBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwodHJhbnNhY3Rpb24ucGhhc2UpLFxuICAgIHRyYW5zYWN0aW9uLmVycm9yLFxuICAgIGhlbHBlckZhaWx1cmUsXG4gIF0uZmlsdGVyKCh2YWx1ZSk6IHZhbHVlIGlzIHN0cmluZyA9PiB0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCk7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICBcIkFwcCBtb2RlIHJlc3RhcnRcIixcbiAgICBbLi4ubmV3IFNldChkZXRhaWxzKV0uam9pbihcIiBcdTAwQjcgXCIpLFxuICApO1xuICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgaWYgKGxlZnQpIGxlZnQucHJlcGVuZChzdGF0dXNCYWRnZShlbnZpcm9ubWVudFRyYW5zYWN0aW9uVG9uZSh0cmFuc2FjdGlvbi5waGFzZSksIGVudmlyb25tZW50VHJhbnNhY3Rpb25MYWJlbCh0cmFuc2FjdGlvbi5waGFzZSkpKTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZXN1bWUpIHtcbiAgICBjb25zdCByZXN1bWUgPSBjb21wYWN0QnV0dG9uKFwiUmVzdW1lL0NvbmZpcm1cIiwgYWN0aW9uc0NvbmZpZy5vblJlc3VtZSk7XG4gICAgcmVzdW1lLmRpc2FibGVkID0gYWN0aW9uc0NvbmZpZy5idXN5O1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJlc3VtZSk7XG4gIH1cbiAgaWYgKGFjdGlvbnNDb25maWc/Lm9uQ2FuY2VsKSB7XG4gICAgY29uc3QgY2FuY2VsID0gY29tcGFjdEJ1dHRvbihcIkNhbmNlbFwiLCBhY3Rpb25zQ29uZmlnLm9uQ2FuY2VsKTtcbiAgICBjYW5jZWwuZGlzYWJsZWQgPSBhY3Rpb25zQ29uZmlnLmJ1c3k7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY2FuY2VsKTtcbiAgfVxuICBpZiAoYWN0aW9uc0NvbmZpZz8ub25SZWNvdmVyKSB7XG4gICAgY29uc3QgcmVjb3ZlciA9IGNvbXBhY3RCdXR0b24oXCJSZWNvdmVyIFNhZmVseVwiLCBhY3Rpb25zQ29uZmlnLm9uUmVjb3Zlcik7XG4gICAgcmVjb3Zlci5kaXNhYmxlZCA9IGFjdGlvbnNDb25maWcuYnVzeTtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChyZWNvdmVyKTtcbiAgfVxuICByb3cudGl0bGUgPSBgVHJhbnNhY3Rpb24gJHt0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkfWA7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3RhdHVzXCIpO1xuICByb3cuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uTGFiZWwocGhhc2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIHN3aXRjaCAocGhhc2UpIHtcbiAgICBjYXNlIFwiY29tbWl0dGVkXCI6XG4gICAgY2FzZSBcImNvbXBsZXRlZFwiOlxuICAgICAgcmV0dXJuIFwiQ29tcGxldGVkXCI7XG4gICAgY2FzZSBcInJvbGxlZC1iYWNrXCI6XG4gICAgY2FzZSBcInJvbGxlZF9iYWNrXCI6XG4gICAgICByZXR1cm4gXCJSb2xsZWQgYmFja1wiO1xuICAgIGNhc2UgXCJjYW5jZWxsZWRcIjpcbiAgICAgIHJldHVybiBcIkNhbmNlbGxlZFwiO1xuICAgIGNhc2UgXCJmYWlsZWRcIjpcbiAgICAgIHJldHVybiBcIkZhaWxlZFwiO1xuICAgIGNhc2UgXCJwcmVwYXJlZFwiOlxuICAgICAgcmV0dXJuIFwiUHJlcGFyZWRcIjtcbiAgICBjYXNlIFwicHJlcGFyaW5nXCI6XG4gICAgICByZXR1cm4gXCJQcmVwYXJpbmdcIjtcbiAgICBjYXNlIFwiY29tbWl0dGluZ1wiOlxuICAgICAgcmV0dXJuIFwiQ29tbWl0dGluZ1wiO1xuICAgIGNhc2UgXCJyZW9wZW5pbmdcIjpcbiAgICAgIHJldHVybiBcIlJlb3BlbmluZ1wiO1xuICAgIGNhc2UgXCJ2ZXJpZnlpbmdcIjpcbiAgICAgIHJldHVybiBcIlZlcmlmeWluZ1wiO1xuICAgIGNhc2UgXCJyb2xsaW5nLWJhY2tcIjpcbiAgICAgIHJldHVybiBcIlJvbGxpbmcgYmFja1wiO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gaHVtYW5pemVDb2RleFBoYXNlKHBoYXNlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBlbnZpcm9ubWVudFRyYW5zYWN0aW9uVG9uZShwaGFzZTogc3RyaW5nKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAocGhhc2UgPT09IFwiY29tbWl0dGVkXCIgfHwgcGhhc2UgPT09IFwiY29tcGxldGVkXCIpIHJldHVybiBcIm9rXCI7XG4gIGlmIChwaGFzZSA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZXJyb3JcIjtcbiAgcmV0dXJuIFwid2FyblwiO1xufVxuXG4vKiogT25lIHNoYXJlZCwgYWNjZXNzaWJsZSBjb25maXJtYXRpb24gYWZ0ZXIgcHJlcGFyZTsgQ2FuY2VsIG5ldmVyIGNvbW1pdHMuICovXG5mdW5jdGlvbiBvcGVuRW52aXJvbm1lbnRDb25maXJtTW9kYWwoXG4gIHJlcXVlc3RlZDogUGljazxFbnZpcm9ubWVudFNlbGVjdGlvbiwgXCJhcHBFeHBlcmllbmNlXCIgfCBcInJlbGVhc2VQcm9maWxlXCI+LFxuICB0cmFuc2FjdGlvbjogRW52aXJvbm1lbnRUcmFuc2FjdGlvbixcbik6IFByb21pc2U8RW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbj4ge1xuICBjb25zdCBvcGVuZXIgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGluc3RhbmNlb2YgSFRNTEVsZW1lbnQgPyBkb2N1bWVudC5hY3RpdmVFbGVtZW50IDogbnVsbDtcbiAgY29uc3QgcmVzdG9yZUZvY3VzID0gKCk6IHZvaWQgPT4ge1xuICAgIHJlc3RvcmVFbnZpcm9ubWVudEZvY3VzKFxuICAgICAgb3BlbmVyLFxuICAgICAgKCkgPT4gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLWVudmlyb25tZW50LWNhcmRdIGJ1dHRvbjpub3QoW2Rpc2FibGVkXSlcIiksXG4gICAgKTtcbiAgfTtcbiAgbGV0IHJlc29sdmVEZWNpc2lvbiE6IChkZWNpc2lvbjogRW52aXJvbm1lbnRDb25maXJtYXRpb25EZWNpc2lvbikgPT4gdm9pZDtcbiAgY29uc3QgZGVjaXNpb24gPSBuZXcgUHJvbWlzZTxFbnZpcm9ubWVudENvbmZpcm1hdGlvbkRlY2lzaW9uPigocmVzb2x2ZVByb21pc2UpID0+IHtcbiAgICByZXNvbHZlRGVjaXNpb24gPSByZXNvbHZlUHJvbWlzZTtcbiAgfSk7XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmRhdGFzZXQudHdlYWtlckVudmlyb25tZW50TW9kYWwgPSBcInRydWVcIjtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBcImZpeGVkIGluc2V0LTAgei1bOTk5OV0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNTAgcC00XCI7XG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwiZGlhbG9nXCIpO1xuICBkaWFsb2cuc2V0QXR0cmlidXRlKFwiYXJpYS1tb2RhbFwiLCBcInRydWVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsbGVkYnlcIiwgXCJ0d2Vha2VyLWVudmlyb25tZW50LWNvbmZpcm0tdGl0bGVcIik7XG4gIGRpYWxvZy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWRlc2NyaWJlZGJ5XCIsIFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgZmxleCB3LWZ1bGwgbWF4LXctbWQgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC0yeGwgYm9yZGVyIHAtNSBzaGFkb3cteGxcIjtcbiAgZGlhbG9nLnNldEF0dHJpYnV0ZShcInN0eWxlXCIsIFwiYmFja2dyb3VuZC1jb2xvcjogdmFyKC0tY29sb3ItYmFja2dyb3VuZC1wYW5lbCwgdmFyKC0tY29sb3ItdG9rZW4tYmctZm9nKSk7XCIpO1xuICBjb25zdCBoZWFkaW5nID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgaGVhZGluZy5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLXRpdGxlXCI7XG4gIGhlYWRpbmcuY2xhc3NOYW1lID0gXCJ0ZXh0LWJhc2UgZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgY29uc3QgZXhwZXJpZW5jZSA9IGVudmlyb25tZW50RXhwZXJpZW5jZUxhYmVsKHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlKTtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IGBTd2l0Y2ggdG8gJHtleHBlcmllbmNlfSBhbmQgcmVzdGFydD9gO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5pZCA9IFwidHdlYWtlci1lbnZpcm9ubWVudC1jb25maXJtLWJvZHlcIjtcbiAgYm9keS5jbGFzc05hbWUgPSBcInRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBjb25zdCBjYW5kaWRhdGUgPSB0cmFuc2FjdGlvbi5wcmVwYXJlZD8uY2FuZGlkYXRlO1xuICBjb25zdCBiYWNrZW5kID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LmJhY2tlbmQ7XG4gIGNvbnN0IHJvbGxiYWNrID0gdHJhbnNhY3Rpb24ucHJlcGFyZWQ/LnJvbGxiYWNrO1xuICBjb25zdCB0YXJnZXQgPSBjYW5kaWRhdGU/LmRlc2t0b3BQYXRoXG4gICAgPyBgJHtjYW5kaWRhdGUuZGVza3RvcFBhdGh9JHtjYW5kaWRhdGUudmVyc2lvbiA/IGAgKCR7Y2FuZGlkYXRlLnZlcnNpb259JHtjYW5kaWRhdGUuYnVpbGQgPyBgLCBidWlsZCAke2NhbmRpZGF0ZS5idWlsZH1gIDogXCJcIn0pYCA6IFwiXCJ9YFxuICAgIDogZW52aXJvbm1lbnRQcm9maWxlTGFiZWwocmVxdWVzdGVkLnJlbGVhc2VQcm9maWxlKTtcbiAgY29uc3QgYmFja2VuZFRhcmdldCA9IGJhY2tlbmQ/LmxhbmVcbiAgICA/IGAke2JhY2tlbmQubGFuZX0ke2JhY2tlbmQudmVyc2lvbiA/IGAgJHtiYWNrZW5kLnZlcnNpb259YCA6IFwiXCJ9YFxuICAgIDogXCJ0aGUgdmVyaWZpZWQgYmFja2VuZCBmb3IgdGhpcyBlbnZpcm9ubWVudFwiO1xuICBjb25zdCByb2xsYmFja1RhcmdldCA9IHJvbGxiYWNrPy5kZXNrdG9wUGF0aFxuICAgID8/IHJvbGxiYWNrPy5zZWxlY3Rpb24/LnNlbGVjdGVkRGVza3RvcFBhdGhcbiAgICA/PyBcInRoZSBsYXN0IGtub3duIHdvcmtpbmcgZW52aXJvbm1lbnRcIjtcbiAgY29uc3QgbW9kZUVmZmVjdCA9IHJlcXVlc3RlZC5hcHBFeHBlcmllbmNlID09PSBcInR3ZWFrZXJzXCJcbiAgICA/IFwiQ2hhdEdQVCB3aWxsIGNsb3NlLCByZW9wZW4gaW4gVHdlYWtlcnMgbW9kZSwgYW5kIHJlc3RvcmUgeW91ciBwcmV2aW91c2x5IGVuYWJsZWQgdHdlYWtzLlwiXG4gICAgOiBcIkNoYXRHUFQgd2lsbCBjbG9zZSBhbmQgcmVvcGVuIGluIHN0YW5kYXJkIG1vZGUuIEFsbCB0d2Vha3Mgd2lsbCBiZSBkaXNhYmxlZCwgYnV0IHRoZWlyIHNhdmVkIHNldHRpbmdzIHdpbGwgcmVtYWluIGF2YWlsYWJsZSBmb3IgVHdlYWtlcnMgbW9kZS5cIjtcbiAgYm9keS50ZXh0Q29udGVudCA9IFtcbiAgICBtb2RlRWZmZWN0LFxuICAgIGBEZXNrdG9wOiAke3RhcmdldH0uIEVtYmVkZGVkIENvZGV4IGJhY2tlbmQ6ICR7YmFja2VuZFRhcmdldH0uYCxcbiAgICBgSWYgcmVzdGFydCB2ZXJpZmljYXRpb24gZmFpbHMsIFR3ZWFrZXJzIHdpbGwgcmVzdG9yZSB0aGUgbGFzdCBrbm93biB3b3JraW5nIGVudmlyb25tZW50IGF0ICR7cm9sbGJhY2tUYXJnZXR9LmAsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgYm9keS5zdHlsZS53aGl0ZVNwYWNlID0gXCJwcmUtbGluZVwiO1xuICBjb25zdCBidXR0b25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYnV0dG9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGxldCBzZXR0bGVkID0gZmFsc2U7XG4gIGNvbnN0IGNsb3NlID0gKG91dGNvbWU6IFwiY29uZmlybVwiIHwgXCJjYW5jZWxcIik6IHZvaWQgPT4ge1xuICAgIGlmIChzZXR0bGVkKSByZXR1cm47XG4gICAgc2V0dGxlZCA9IHRydWU7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgIHJlc29sdmVEZWNpc2lvbihvdXRjb21lKTtcbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKHJlc3RvcmVGb2N1cyk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBldmVudC5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICAgIGNsb3NlKFwiY2FuY2VsXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAoZXZlbnQua2V5ICE9PSBcIlRhYlwiKSByZXR1cm47XG4gICAgY29uc3QgZm9jdXNhYmxlID0gW2NhbmNlbCwgY29uZmlybV07XG4gICAgY29uc3QgY3VycmVudEluZGV4ID0gZm9jdXNhYmxlLmluZGV4T2YoZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MQnV0dG9uRWxlbWVudCk7XG4gICAgY29uc3QgbmV4dEluZGV4ID0gZXZlbnQuc2hpZnRLZXlcbiAgICAgID8gKGN1cnJlbnRJbmRleCA8PSAwID8gZm9jdXNhYmxlLmxlbmd0aCAtIDEgOiBjdXJyZW50SW5kZXggLSAxKVxuICAgICAgOiAoY3VycmVudEluZGV4IDwgMCB8fCBjdXJyZW50SW5kZXggPT09IGZvY3VzYWJsZS5sZW5ndGggLSAxID8gMCA6IGN1cnJlbnRJbmRleCArIDEpO1xuICAgIGV2ZW50LnByZXZlbnREZWZhdWx0KCk7XG4gICAgZm9jdXNhYmxlW25leHRJbmRleF0/LmZvY3VzKCk7XG4gIH07XG4gIGNvbnN0IGNhbmNlbCA9IGNvbXBhY3RCdXR0b24oXCJDYW5jZWxcIiwgKCkgPT4gY2xvc2UoXCJjYW5jZWxcIikpO1xuICBjb25zdCBjb25maXJtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgY29uZmlybS50eXBlID0gXCJidXR0b25cIjtcbiAgY29uZmlybS5jbGFzc05hbWUgPSBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggaC04IGl0ZW1zLWNlbnRlciB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJnLXRva2VuLWNoYXJ0cy1ibHVlIHB4LTMgdGV4dC1zbSB0ZXh0LXdoaXRlIGVuYWJsZWQ6aG92ZXI6b3BhY2l0eS05MCBkaXNhYmxlZDpjdXJzb3Itbm90LWFsbG93ZWQgZGlzYWJsZWQ6b3BhY2l0eS00MCBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gIGNvbmZpcm0udGV4dENvbnRlbnQgPSBcIkFwcGx5ICYgUmVzdGFydFwiO1xuICBjb25maXJtLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZXZlbnQpID0+IHtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuICAgIGNsb3NlKFwiY29uZmlybVwiKTtcbiAgfSk7XG4gIGJ1dHRvbnMuYXBwZW5kKGNhbmNlbCwgY29uZmlybSk7XG4gIGRpYWxvZy5hcHBlbmQoaGVhZGluZywgYm9keSwgYnV0dG9ucyk7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChvdmVybGF5KTtcbiAgY29uZmlybS5mb2N1cygpO1xuICByZXR1cm4gZGVjaXNpb247XG59XG5cbmZ1bmN0aW9uIHJlbmRlckRlc2t0b3BVcGRhdGVTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJEZXNrdG9wIFVwZGF0ZVwiKSk7XG4gIGNvbnN0IGNhcmQgPSByb3VuZGVkQ2FyZCgpO1xuICBjYXJkLmRhdGFzZXQudHdlYWtlckRlc2t0b3BVcGRhdGVDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTG9hZGluZyBkZXNrdG9wIHVwZGF0ZVwiLCBcIkNoZWNraW5nIHRoZSBzaWduZWQgQ29kZXggYXBwY2FzdC5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgbGV0IGN1cnJlbnQ6IERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlIHwgbnVsbCA9IG51bGw7XG4gIGxldCBidXN5ID0gZmFsc2U7XG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgPSAwO1xuICBsZXQgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IDA7XG4gIGxldCBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCA9IGZhbHNlO1xuXG4gIGNvbnN0IHRyYW5zYWN0aW9uSXNBY3RpdmUgPSAoKTogYm9vbGVhbiA9PiB7XG4gICAgaWYgKCF0cmFuc2FjdGlvbj8udHJhbnNhY3Rpb25JZCkge1xuICAgICAgcmV0dXJuIHRyYW5zYWN0aW9uPy5waGFzZSA9PT0gXCJwcmVwYXJpbmdcIiAmJiBEYXRlLm5vdygpIDwgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbDtcbiAgICB9XG4gICAgcmV0dXJuICFbXCJjb21wbGV0ZWRcIiwgXCJmYWlsZWRcIiwgXCJyb2xsZWRfYmFja1wiXS5pbmNsdWRlcyh0cmFuc2FjdGlvbi5waGFzZSk7XG4gIH07XG4gIGNvbnN0IHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsID0gKGRlbGF5TXMgPSAyXzAwMCk6IHZvaWQgPT4ge1xuICAgIGlmIChwb2xsaW5nKSBjbGVhclRpbWVvdXQocG9sbGluZyk7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkIHx8ICghdHJhbnNhY3Rpb25Jc0FjdGl2ZSgpICYmIHRyYW5zYWN0aW9uPy5yZXN1bWFibGUgIT09IHRydWUpKSByZXR1cm47XG4gICAgcG9sbGluZyA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgcG9sbGluZyA9IG51bGw7XG4gICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgIH0sIGRlbGF5TXMpO1xuICB9O1xuICBjb25zdCBsb2FkVHJhbnNhY3Rpb24gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJkZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgdmFsdWUgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1jb2RleC1kZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNvbnN0IG9ic2VydmVkID0gbm9ybWFsaXplRGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uKHZhbHVlKTtcbiAgICAgIGlmIChvYnNlcnZlZD8ucGhhc2UgPT09IFwiaWRsZVwiXG4gICAgICAgICYmIG9ic2VydmVkLnRyYW5zYWN0aW9uSWQgPT09IG51bGxcbiAgICAgICAgJiYgdHJhbnNhY3Rpb24/LnBoYXNlID09PSBcInByZXBhcmluZ1wiXG4gICAgICAgICYmIHRyYW5zYWN0aW9uLnRyYW5zYWN0aW9uSWQgPT09IG51bGwpIHtcbiAgICAgICAgaWYgKERhdGUubm93KCkgPj0gYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCkge1xuICAgICAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICAgICAgdHJhbnNhY3Rpb25JZDogbnVsbCxcbiAgICAgICAgICAgIHBoYXNlOiBcImZhaWxlZFwiLFxuICAgICAgICAgICAgZXJyb3I6IFwiVGhlIGRlc2t0b3AgdXBkYXRlciBkaWQgbm90IGNyZWF0ZSBhIHRyYW5zYWN0aW9uIHJlY2VpcHQuXCIsXG4gICAgICAgICAgfTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHJhbnNhY3Rpb24gPSBvYnNlcnZlZDtcbiAgICAgICAgaWYgKHRyYW5zYWN0aW9uPy50cmFuc2FjdGlvbklkKSBhd2FpdGluZ1RyYW5zYWN0aW9uUmVjZWlwdFVudGlsID0gMDtcbiAgICAgIH1cbiAgICAgIHRyYW5zYWN0aW9uUG9sbEZhaWx1cmVzID0gMDtcbiAgICAgIGRyYXcoKTtcbiAgICAgIHNjaGVkdWxlVHJhbnNhY3Rpb25Qb2xsKCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KHVwZGF0ZSkgfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIHRyYW5zYWN0aW9uID0ge1xuICAgICAgICB0cmFuc2FjdGlvbklkOiB0cmFuc2FjdGlvbj8udHJhbnNhY3Rpb25JZCA/PyBudWxsLFxuICAgICAgICBwaGFzZTogdHJhbnNhY3Rpb24/LnBoYXNlID8/IFwicHJlcGFyaW5nXCIsXG4gICAgICAgIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvciksXG4gICAgICB9O1xuICAgICAgZHJhdygpO1xuICAgICAgdHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgKz0gMTtcbiAgICAgIGNvbnN0IGJhY2tvZmYgPSBNYXRoLm1pbigzMF8wMDAsIDFfMDAwICogKDIgKiogTWF0aC5taW4odHJhbnNhY3Rpb25Qb2xsRmFpbHVyZXMgLSAxLCA1KSkpO1xuICAgICAgY29uc3Qgaml0dGVyID0gTWF0aC5mbG9vcihiYWNrb2ZmICogMC4yNSAqIE1hdGgucmFuZG9tKCkpO1xuICAgICAgc2NoZWR1bGVUcmFuc2FjdGlvblBvbGwoYmFja29mZiArIGppdHRlcik7XG4gICAgfVxuICB9O1xuICBjb25zdCBkcmF3ID0gKCk6IHZvaWQgPT4ge1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHJlc3VsdCA9IGN1cnJlbnQ7XG4gICAgY29uc3QgaW5zdGFsbGVkID0gcmVzdWx0Py5pbnN0YWxsZWQ/Lm1hcmtldGluZ1ZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICAgIGNvbnN0IGxhdGVzdCA9IHJlc3VsdD8ubGF0ZXN0Py5tYXJrZXRpbmdWZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIjtcbiAgICBjb25zdCBzdGF0dXMgPSBkZXNrdG9wVXBkYXRlU3RhdHVzUHJlc2VudGF0aW9uKHJlc3VsdD8uc3RhdHVzKTtcbiAgICBjb25zdCBwcmVzZW50YXRpb24gPSBkZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uKHtcbiAgICAgIGJ1c3ksXG4gICAgICBzdGF0dXM6IHJlc3VsdD8uc3RhdHVzLFxuICAgICAgdHJhbnNhY3Rpb24sXG4gICAgfSk7XG4gICAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiQ2hhdEdQVCBEZXNrdG9wXCIsIGBJbnN0YWxsZWQgJHtpbnN0YWxsZWR9IFx1MDBCNyBMYXRlc3QgJHtsYXRlc3R9JHtyZXN1bHQ/LnJlYXNvbiA/IGAgXHUwMEI3ICR7cmVzdWx0LnJlYXNvbn1gIDogXCJcIn1gKTtcbiAgICBjb25zdCBsZWZ0ID0gcm93LmZpcnN0RWxlbWVudENoaWxkIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHN0YXR1cy50b25lLCBzdGF0dXMubGFiZWwpKTtcbiAgICBjb25zdCBhY3Rpb25zID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gICAgY29uc3QgY2hlY2sgPSBjb21wYWN0QnV0dG9uKFwiQ2hlY2sgZm9yIFVwZGF0ZXNcdTIwMjZcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgY2hlY2suZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgIC50aGVuKCh2YWx1ZSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHZhbHVlIGFzIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdDtcbiAgICAgICAgICBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0KHJlc3VsdCk7XG4gICAgICAgICAgaWYgKHJlc3VsdC51cGRhdGVBbmRSZWxvYWRSZXF1ZXN0ZWQpIHtcbiAgICAgICAgICAgIGF3YWl0aW5nVHJhbnNhY3Rpb25SZWNlaXB0VW50aWwgPSBEYXRlLm5vdygpICsgMTBfMDAwO1xuICAgICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgICB2b2lkIGxvYWRUcmFuc2FjdGlvbigpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgY2hlY2suZGlzYWJsZWQgPSBidXN5IHx8ICEhcmVzdWx0Py5zZXR1cFJlcXVpcmVkO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNoZWNrKTtcbiAgICBjb25zdCB1cGRhdGUgPSBjb21wYWN0QnV0dG9uKFwiVXBkYXRlIGFuZCBSZWxvYWRcIiwgKCkgPT4ge1xuICAgICAgaWYgKGJ1c3kpIHJldHVybjtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgdXBkYXRlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzdGFydC1jb2RleC1kZXNrdG9wLXVwZGF0ZVwiKVxuICAgICAgICAudGhlbigoKSA9PiB7XG4gICAgICAgICAgYXdhaXRpbmdUcmFuc2FjdGlvblJlY2VpcHRVbnRpbCA9IERhdGUubm93KCkgKyAxMF8wMDA7XG4gICAgICAgICAgdHJhbnNhY3Rpb24gPSB7IHRyYW5zYWN0aW9uSWQ6IG51bGwsIHBoYXNlOiBcInByZXBhcmluZ1wiIH07XG4gICAgICAgICAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4geyBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTsgfSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4geyBidXN5ID0gZmFsc2U7IGRyYXcoKTsgfSk7XG4gICAgfSk7XG4gICAgdXBkYXRlLmRpc2FibGVkID0gcHJlc2VudGF0aW9uLnVwZGF0ZURpc2FibGVkO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gICAgY2FyZC5hcHBlbmRDaGlsZChyb3cpO1xuICAgIGlmIChyZXN1bHQ/LnNldHVwUmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IHNldHVwTGFiZWwgPSByZXN1bHQuc2V0dXBSZXF1aXJlZCA9PT0gXCJyZWdpc3Rlci1iZXRhXCJcbiAgICAgICAgPyBcIlJlZ2lzdGVyIE9wZW5BSSBCZXRhXCJcbiAgICAgICAgOiBcIkxhdW5jaCBPcGVuQUkgQmV0YSBvbmNlXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcbiAgICAgICAgYEFscGhhIHVwZGF0ZSBzZXR1cCBcdTAwQjcgJHtzZXR1cExhYmVsfWAsXG4gICAgICAgIHJlc3VsdC5yZWFzb24gPz8gXCJBbHBoYSB1cGRhdGUgY2hlY2tzIHN0YXkgZGlzYWJsZWQgdW50aWwgVHdlYWtlcnMgY2FwdHVyZXMgdGhlIHJlZ2lzdGVyZWQgQmV0YSBhcHAncyBvd24gZmVlZC5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAocmVzdWx0Py5jaGVja2VkQXQpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTGFzdCBjaGVja2VkXCIsIG5ldyBEYXRlKHJlc3VsdC5jaGVja2VkQXQpLnRvTG9jYWxlU3RyaW5nKCkpKTtcbiAgICBpZiAodHJhbnNhY3Rpb24pIGNhcmQuYXBwZW5kQ2hpbGQoZGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uUm93KHRyYW5zYWN0aW9uLCBwcmVzZW50YXRpb24sIHtcbiAgICAgIGJ1c3ksXG4gICAgICBvblJlc3VtZTogKCkgPT4ge1xuICAgICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgICAgZHJhdygpO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmVzdW1lLWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgICAgdHJhbnNhY3Rpb24gPSB0cmFuc2FjdGlvbiA/IHsgLi4udHJhbnNhY3Rpb24sIHBoYXNlOiBcImF3YWl0aW5nX25hdGl2ZV91cGRhdGVcIiwgcmVzdW1hYmxlOiBmYWxzZSB9IDogdHJhbnNhY3Rpb247XG4gICAgICAgICAgICBzY2hlZHVsZVRyYW5zYWN0aW9uUG9sbCgpO1xuICAgICAgICAgIH0pXG4gICAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgICAgaWYgKHRyYW5zYWN0aW9uKSB0cmFuc2FjdGlvbiA9IHsgLi4udHJhbnNhY3Rpb24sIGVycm9yOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgICAgICB9KVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHsgYnVzeSA9IGZhbHNlOyBkcmF3KCk7IH0pO1xuICAgICAgfSxcbiAgICAgIG9uQ2FuY2VsOiAoKSA9PiB7XG4gICAgICAgIGlmIChidXN5KSByZXR1cm47XG4gICAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgICBkcmF3KCk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjYW5jZWwtY29kZXgtZGVza3RvcC11cGRhdGVcIilcbiAgICAgICAgICAudGhlbigodmFsdWUpID0+IHsgdHJhbnNhY3Rpb24gPSBub3JtYWxpemVEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb24odmFsdWUpID8/IHRyYW5zYWN0aW9uOyB9KVxuICAgICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICAgIGlmICh0cmFuc2FjdGlvbikgdHJhbnNhY3Rpb24gPSB7IC4uLnRyYW5zYWN0aW9uLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgfSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7IGJ1c3kgPSBmYWxzZTsgZHJhdygpOyB9KTtcbiAgICAgIH0sXG4gICAgfSkpO1xuICB9O1xuICBkcmF3KCk7XG4gIGNvbnN0IGFjY2VwdERlc2t0b3BVcGRhdGVSZXN1bHQgPSAodmFsdWU6IERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGN1cnJlbnRUaW1lID0gY3VycmVudD8uY2hlY2tlZEF0ID8gRGF0ZS5wYXJzZShjdXJyZW50LmNoZWNrZWRBdCkgOiBOdW1iZXIuTmFOO1xuICAgIGNvbnN0IG5leHRUaW1lID0gdmFsdWUuY2hlY2tlZEF0ID8gRGF0ZS5wYXJzZSh2YWx1ZS5jaGVja2VkQXQpIDogTnVtYmVyLk5hTjtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGN1cnJlbnRUaW1lKSAmJiAoIU51bWJlci5pc0Zpbml0ZShuZXh0VGltZSkgfHwgbmV4dFRpbWUgPCBjdXJyZW50VGltZSkpIHJldHVybjtcbiAgICBjdXJyZW50ID0gdmFsdWU7XG4gICAgZHJhdygpO1xuICB9O1xuICBjb25zdCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkID0gKF9ldmVudDogdW5rbm93biwgdmFsdWU6IHVua25vd24pOiB2b2lkID0+IHtcbiAgICBpZiAoIWNhcmQuaXNDb25uZWN0ZWQpIHtcbiAgICAgIGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKFwidHdlYWtlcjpjb2RleC1kZXNrdG9wLXVwZGF0ZS1jaGFuZ2VkXCIsIG9uRGVza3RvcFVwZGF0ZUNoYW5nZWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCA9IHRydWU7XG4gICAgYWNjZXB0RGVza3RvcFVwZGF0ZVJlc3VsdCh2YWx1ZSBhcyBEZXNrdG9wVXBkYXRlQ2hlY2tSZXN1bHQpO1xuICB9O1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgY29uc3QgY3VycmVudFVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwiZGVza3RvcC11cGRhdGUtcmVzdWx0XCIpO1xuICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Z2V0LWNvZGV4LWRlc2t0b3AtdXBkYXRlXCIpXG4gICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICBpZiAoIWNhcmRVcGRhdGVzLmlzQ3VycmVudChjdXJyZW50VXBkYXRlKSB8fCAhY2FyZC5pc0Nvbm5lY3RlZCB8fCBpbml0aWFsUmVzdWx0U3VwZXJzZWRlZCkgcmV0dXJuO1xuICAgICAgaWYgKHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIikge1xuICAgICAgICBhY2NlcHREZXNrdG9wVXBkYXRlUmVzdWx0KHZhbHVlIGFzIERlc2t0b3BVcGRhdGVDaGVja1Jlc3VsdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXJyZW50ID0geyBzdGF0dXM6IFwidW5hdmFpbGFibGVcIiwgcmVhc29uOiBcIlVwZGF0ZSBzdGF0dXMgaGFzIG5vdCBiZWVuIGNoZWNrZWQgeWV0LlwiIH07XG4gICAgICAgIGRyYXcoKTtcbiAgICAgIH1cbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIGlmICghY2FyZFVwZGF0ZXMuaXNDdXJyZW50KGN1cnJlbnRVcGRhdGUpIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBjdXJyZW50ID0geyBzdGF0dXM6IFwiZXJyb3JcIiwgcmVhc29uOiBzYWZlVWlFcnJvcihlcnJvcikgfTtcbiAgICAgIGRyYXcoKTtcbiAgICB9KTtcbiAgdm9pZCBsb2FkVHJhbnNhY3Rpb24oKTtcbiAgcmV0dXJuICgpID0+IHtcbiAgICBjYXJkVXBkYXRlcy5pbnZhbGlkYXRlKFwiZGVza3RvcC11cGRhdGUtcmVzdWx0XCIpO1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJkZXNrdG9wLXVwZGF0ZS10cmFuc2FjdGlvblwiKTtcbiAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiLCBvbkRlc2t0b3BVcGRhdGVDaGFuZ2VkKTtcbiAgICBpZiAocG9sbGluZykgY2xlYXJUaW1lb3V0KHBvbGxpbmcpO1xuICAgIHBvbGxpbmcgPSBudWxsO1xuICB9O1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb24odmFsdWU6IHVua25vd24pOiBEZXNrdG9wVXBkYXRlVHJhbnNhY3Rpb25TdGF0ZSB8IG51bGwge1xuICBpZiAoIXZhbHVlIHx8IHR5cGVvZiB2YWx1ZSAhPT0gXCJvYmplY3RcIikgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGNhbmRpZGF0ZSA9IHZhbHVlIGFzIFBhcnRpYWw8RGVza3RvcFVwZGF0ZVRyYW5zYWN0aW9uU3RhdGU+O1xuICBpZiAoY2FuZGlkYXRlLnRyYW5zYWN0aW9uSWQgIT09IG51bGwgJiYgdHlwZW9mIGNhbmRpZGF0ZS50cmFuc2FjdGlvbklkICE9PSBcInN0cmluZ1wiKSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiBjYW5kaWRhdGUucGhhc2UgIT09IFwic3RyaW5nXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIC4uLmNhbmRpZGF0ZSxcbiAgICB0cmFuc2FjdGlvbklkOiBjYW5kaWRhdGUudHJhbnNhY3Rpb25JZCA/PyBudWxsLFxuICAgIHBoYXNlOiBjYW5kaWRhdGUucGhhc2UsXG4gIH07XG59XG5cbmZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblJvdyhcbiAgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVUcmFuc2FjdGlvblN0YXRlLFxuICBwcmVzZW50YXRpb246IERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24sXG4gIGFjdGlvbnM6IHsgYnVzeTogYm9vbGVhbjsgb25SZXN1bWU6ICgpID0+IHZvaWQ7IG9uQ2FuY2VsOiAoKSA9PiB2b2lkIH0sXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGRldGFpbCA9IFtcbiAgICB0cmFuc2FjdGlvbi50cmFuc2FjdGlvbklkID8gYFRyYW5zYWN0aW9uICR7dHJhbnNhY3Rpb24udHJhbnNhY3Rpb25JZH1gIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5zYWZlT2ZmaWNpYWxNb2RlID8gXCJPZmZpY2lhbCBDaGF0R1BUIGlzIGFjdGl2ZVwiIDogbnVsbCxcbiAgICB0cmFuc2FjdGlvbi5yZWZyZXNoU291cmNlID8gYCR7dHJhbnNhY3Rpb24ucmVmcmVzaFNvdXJjZX0gVHdlYWtlcnMgcmVmcmVzaGAgOiBudWxsLFxuICAgIHRyYW5zYWN0aW9uLmVycm9yID8/IG51bGwsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXHUwMEI3IFwiKSB8fCBcIldhaXRpbmcgZm9yIHRoZSBkdXJhYmxlIHVwZGF0ZXIgcmVjZWlwdC5cIjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiVXBkYXRlIGFuZCBSZWxvYWRcIiwgZGV0YWlsKTtcbiAgcm93LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJzdGF0dXNcIik7XG4gIHJvdy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxpdmVcIiwgXCJwb2xpdGVcIik7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAocHJlc2VudGF0aW9uLnRvbmUgJiYgcHJlc2VudGF0aW9uLnBoYXNlTGFiZWwpIHtcbiAgICBsZWZ0Py5wcmVwZW5kKHN0YXR1c0JhZGdlKHByZXNlbnRhdGlvbi50b25lLCBwcmVzZW50YXRpb24ucGhhc2VMYWJlbCkpO1xuICB9XG4gIGNvbnN0IGNvbnRyb2xzID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGZvciAoY29uc3QgYWN0aW9uIG9mIHByZXNlbnRhdGlvbi5hY3Rpb25zKSB7XG4gICAgY29uc3QgaGFuZGxlciA9IGFjdGlvbi5raW5kID09PSBcInJlc3VtZVwiID8gYWN0aW9ucy5vblJlc3VtZSA6IGFjdGlvbnMub25DYW5jZWw7XG4gICAgY29uc3QgYnV0dG9uID0gY29tcGFjdEJ1dHRvbihhY3Rpb24ubGFiZWwsIGhhbmRsZXIpO1xuICAgIGJ1dHRvbi5kaXNhYmxlZCA9IGFjdGlvbi5kaXNhYmxlZDtcbiAgICBjb250cm9scz8uYXBwZW5kQ2hpbGQoYnV0dG9uKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZW5kZXJNY3BJbnRlZ3JhdGlvblNlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIGNhcmRVcGRhdGVzOiBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8dW5rbm93bj4sXG4pOiAoKSA9PiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKHNlY3Rpb25UaXRsZShcIk1DUCBJbnRlZ3JhdGlvbiBIZWFsdGhcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJNY3BIZWFsdGhDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ2hlY2tpbmcgTUNQIGludGVncmF0aW9uXCIsIFwiVmVyaWZ5aW5nIG1hbmFnZWQgTUNQIGNvbmZpZ3VyYXRpb24gYW5kIHN5bmNocm9uaXphdGlvbi5cIikpO1xuICBzZWN0aW9uLmFwcGVuZENoaWxkKGNhcmQpO1xuICBzZWN0aW9uc1dyYXAuYXBwZW5kQ2hpbGQoc2VjdGlvbik7XG5cbiAgY29uc3QgcmVuZGVyID0gKHN0YXRlOiBNY3BTeW5jU3RhdGUgfCBudWxsKTogdm9pZCA9PiB7XG4gICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgaWYgKCFzdGF0ZSkge1xuICAgICAgc3RhdGUgPSB7XG4gICAgICAgIHN0YXR1czogXCJwZW5kaW5nXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiTWFuYWdlZCBNQ1AgcmVjb25jaWxpYXRpb24gaGFzIG5vdCBjb21wbGV0ZWQgeWV0LlwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgY29uc3Qgc3RhdHVzID0gc3RhdGUuc3RhdHVzID8/IChzdGF0ZS5lcnJvciA/IFwiZXJyb3JcIiA6IFwib2tcIik7XG4gICAgY29uc3QgdG9uZSA9IHN0YXR1cyA9PT0gXCJlcnJvclwiIHx8IHN0YXRlLmVycm9yXG4gICAgICA/IFwiZXJyb3JcIlxuICAgICAgOiBzdGF0dXMgPT09IFwiY29uZmxpY3RcIiB8fCBzdGF0dXMgPT09IFwid2FyblwiIHx8IHN0YXR1cyA9PT0gXCJwZW5kaW5nXCJcbiAgICAgICAgPyBcIndhcm5cIlxuICAgICAgICA6IFwib2tcIjtcbiAgICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJNQ1AgaW50ZWdyYXRpb25cIiwgc3RhdGUuc3VtbWFyeSA/PyBzdGF0ZS5lcnJvciA/PyAodG9uZSA9PT0gXCJva1wiID8gXCJNQ1AgY29uZmlndXJhdGlvbiBpcyBzeW5jaHJvbml6ZWQuXCIgOiBcIk1DUCBjb25maWd1cmF0aW9uIG5lZWRzIGF0dGVudGlvbi5cIikpO1xuICAgIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgIGxlZnQ/LnByZXBlbmQoc3RhdHVzQmFkZ2UodG9uZSwgc3RhdHVzID09PSBcIm9rXCIgPyBcIkhlYWx0aHlcIiA6IGh1bWFuaXplQ29kZXhQaGFzZShzdGF0dXMpKSk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGNvbnN0IHJlcGFpciA9IGNvbXBhY3RCdXR0b24oXCJSZXBhaXJcIiwgKCkgPT4ge1xuICAgICAgcmVwYWlyLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHVwZGF0ZSA9IGNhcmRVcGRhdGVzLmJlZ2luKFwibWNwXCIpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlcGFpci1tY3BcIilcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBpZiAoY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQgYXMgTWNwU3luY1N0YXRlKTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIGNvbnN0IG5leHQgPSB7IHN0YXR1czogXCJlcnJvclwiLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICAgICAgaWYgKGNhcmRVcGRhdGVzLmNvbXBsZXRlKHVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQocmVwYWlyKTtcbiAgICBjYXJkLmFwcGVuZENoaWxkKHJvdyk7XG4gICAgaWYgKHN0YXRlLnJlc3RhcnRSZXF1aXJlZCkge1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXG4gICAgICAgIFwiTmV3IHRhc2sgb3IgcmVzdGFydCByZXF1aXJlZFwiLFxuICAgICAgICBcIlRoZSBjYW5vbmljYWwgTUNQIG5hbWUgaXMgd3JpdHRlbi4gU3RhcnQgYSBuZXcgdGFzaywgb3IgcmVzdGFydCBDb2RleCwgdG8gcmVwbGFjZSBhbnkgYWxyZWFkeS1ydW5uaW5nIGxlZ2FjeSBNQ1AgcHJvY2Vzcy5cIixcbiAgICAgICkpO1xuICAgIH1cbiAgICBpZiAoc3RhdGUuY29uZmxpY3RzPy5sZW5ndGgpIHtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ29uZmxpY3RzXCIsIHN0YXRlLmNvbmZsaWN0cy5tYXAoKGNvbmZsaWN0KSA9PiB7XG4gICAgICAgIGlmIChjb25mbGljdC5vYnNlcnZlZE5hbWUgfHwgY29uZmxpY3QuY2Fub25pY2FsTmFtZSkge1xuICAgICAgICAgIHJldHVybiBgJHtjb25mbGljdC5vYnNlcnZlZE5hbWUgPz8gXCJVbmtub3duIGVudHJ5XCJ9IFx1MjE5MiAke2NvbmZsaWN0LmNhbm9uaWNhbE5hbWUgPz8gXCJjYW5vbmljYWwgZW50cnlcIn06ICR7Y29uZmxpY3QucmVhc29uID8/IGNvbmZsaWN0LmRldGFpbCA/PyBcIm93bmVyc2hpcCBjb25mbGljdFwifWA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGNvbmZsaWN0LmRldGFpbCA/PyBjb25mbGljdC5yZWFzb24gPz8gY29uZmxpY3QubmFtZSA/PyBcIlVua25vd24gY29uZmxpY3RcIjtcbiAgICAgIH0pLmpvaW4oXCI7IFwiKSkpO1xuICAgIH1cbiAgICBjb25zdCBjaGVja2VkQXQgPSBzdGF0ZS5jb21wbGV0ZWRBdCA/PyBzdGF0ZS5jaGVja2VkQXQ7XG4gICAgaWYgKGNoZWNrZWRBdCkgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJMYXN0IGNoZWNrZWRcIiwgbmV3IERhdGUoY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpKSk7XG4gIH07XG4gIGNvbnN0IG9uU3luY1N0YXRlQ2hhbmdlZCA9IChfZXZlbnQ6IHVua25vd24sIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkKSB7XG4gICAgICBpcGNSZW5kZXJlci5yZW1vdmVMaXN0ZW5lcihcInR3ZWFrZXI6bWNwLXN5bmMtc3RhdGUtY2hhbmdlZFwiLCBvblN5bmNTdGF0ZUNoYW5nZWQpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB1cGRhdGUgPSBjYXJkVXBkYXRlcy5iZWdpbihcIm1jcFwiKTtcbiAgICBjb25zdCBuZXh0ID0gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgTWNwU3luY1N0YXRlIDogbnVsbDtcbiAgICBpZiAoY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICB9O1xuICBpcGNSZW5kZXJlci5vbihcInR3ZWFrZXI6bWNwLXN5bmMtc3RhdGUtY2hhbmdlZFwiLCBvblN5bmNTdGF0ZUNoYW5nZWQpO1xuICBjb25zdCBpbml0aWFsVXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJtY3BcIik7XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtbWNwLXN5bmMtc3RhdGVcIilcbiAgICAudGhlbigodmFsdWUpID0+IHtcbiAgICAgIGNvbnN0IG5leHQgPSB2YWx1ZSAmJiB0eXBlb2YgdmFsdWUgPT09IFwib2JqZWN0XCIgPyB2YWx1ZSBhcyBNY3BTeW5jU3RhdGUgOiBudWxsO1xuICAgICAgaWYgKGNhcmQuaXNDb25uZWN0ZWQgJiYgY2FyZFVwZGF0ZXMuY29tcGxldGUoaW5pdGlhbFVwZGF0ZSwgbmV4dCkpIHJlbmRlcihuZXh0KTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgIGNvbnN0IG5leHQgPSB7IHN0YXR1czogXCJlcnJvclwiLCBlcnJvcjogc2FmZVVpRXJyb3IoZXJyb3IpIH07XG4gICAgICBpZiAoY2FyZC5pc0Nvbm5lY3RlZCAmJiBjYXJkVXBkYXRlcy5jb21wbGV0ZShpbml0aWFsVXBkYXRlLCBuZXh0KSkgcmVuZGVyKG5leHQpO1xuICAgIH0pO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGNhcmRVcGRhdGVzLmludmFsaWRhdGUoXCJtY3BcIik7XG4gICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOm1jcC1zeW5jLXN0YXRlLWNoYW5nZWRcIiwgb25TeW5jU3RhdGVDaGFuZ2VkKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQXV0b21hdGljTWFpbnRlbmFuY2VTZWN0aW9uKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBjYXJkVXBkYXRlczogQ29uZmlnQ2FyZFVwZGF0ZUNvb3JkaW5hdG9yPHVua25vd24+LFxuKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VjdGlvblwiKTtcbiAgc2VjdGlvbi5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTJcIjtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChzZWN0aW9uVGl0bGUoXCJBdXRvbWF0aWMgTWFpbnRlbmFuY2VcIikpO1xuICBjb25zdCBjYXJkID0gcm91bmRlZENhcmQoKTtcbiAgY2FyZC5kYXRhc2V0LnR3ZWFrZXJNYWludGVuYW5jZUNhcmQgPSBcInRydWVcIjtcbiAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyBhdXRvbWF0aWMgbWFpbnRlbmFuY2VcIiwgXCJWZXJpZnlpbmcgdGhlIHVwZGF0ZXIgcmVwYWlyIHNlcnZpY2UuXCIpKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChjYXJkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICBsZXQgbGF0ZXN0SGVhbHRoOiBXYXRjaGVySGVhbHRoIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZXBhaXJJbkZsaWdodCA9IGZhbHNlO1xuICBsZXQgcmVwYWlyRGlzcGxheTogXCJpZGxlXCIgfCBcInN1Y2Nlc3NcIiB8IFwiZmFpbHVyZVwiID0gXCJpZGxlXCI7XG4gIGxldCByZXBhaXJCYXNlbGluZUN5Y2xlOiBXYXRjaGVyQ3ljbGVSZWNlaXB0IHwgbnVsbCA9IG51bGw7XG4gIGxldCByZXBhaXJTdGFydGVkQXQgPSAwO1xuICBsZXQgcmVwYWlyUG9sbDogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgbGV0IHJlcGFpclBvbGxDb3VudCA9IDA7XG4gIGNvbnN0IE1BWF9SRVBBSVJfUE9MTFMgPSAzMDtcblxuICBjb25zdCByZW5kZXIgPSAoaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogdm9pZCA9PiB7XG4gICAgbGF0ZXN0SGVhbHRoID0gaGVhbHRoO1xuICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGlmIChyZXBhaXJJbkZsaWdodCkge1xuICAgICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCB7XG4gICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgc3RhdHVzOiBcIndhcm5cIixcbiAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJ1bm5pbmdcIixcbiAgICAgICAgc3VtbWFyeTogXCJSZXBhaXIgd2FzIHN0YXJ0ZWQgaW4gdGhlIGJhY2tncm91bmQuIFdhaXRpbmcgZm9yIGEgY29tcGxldGVkIHdhdGNoZXIgY3ljbGVcdTIwMjZcIixcbiAgICAgIH0sIGZhbHNlKTtcbiAgICAgIGNvbnN0IHJ1bm5pbmcgPSBhY3Rpb25Sb3coXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2VcIiwgXCJSZXBhaXIgY3ljbGUgcnVubmluZ1x1MjAyNlwiKTtcbiAgICAgIHJ1bm5pbmcuc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInN0YXR1c1wiKTtcbiAgICAgIHJ1bm5pbmcuc2V0QXR0cmlidXRlKFwiYXJpYS1saXZlXCIsIFwicG9saXRlXCIpO1xuICAgICAgcnVubmluZy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShcIndhcm5cIiwgXCJSdW5uaW5nXCIpKTtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocnVubmluZyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChyZXBhaXJEaXNwbGF5ID09PSBcInN1Y2Nlc3NcIikge1xuICAgICAgaGVhbHRoID0ge1xuICAgICAgICAuLi5oZWFsdGgsXG4gICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2Ugc3VjY2VlZGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgY29tcGxldGVkIGEgZnJlc2ggcmVwYWlyIGN5Y2xlLlwiLFxuICAgICAgfTtcbiAgICB9IGVsc2UgaWYgKHJlcGFpckRpc3BsYXkgPT09IFwiZmFpbHVyZVwiKSB7XG4gICAgICBoZWFsdGggPSB7XG4gICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIixcbiAgICAgICAgc3VtbWFyeTogaGVhbHRoLnN1bW1hcnkgfHwgXCJUaGUgd2F0Y2hlciByZXBhaXIgY3ljbGUgZmFpbGVkLlwiLFxuICAgICAgfTtcbiAgICB9XG4gICAgcmVuZGVyV2F0Y2hlckhlYWx0aChjYXJkLCBoZWFsdGgsIHRydWUsIHN0YXJ0UmVwYWlyKTtcbiAgfTtcbiAgY29uc3QgbG9hZCA9ICgpOiBQcm9taXNlPFdhdGNoZXJIZWFsdGggfCBudWxsPiA9PiB7XG4gICAgY29uc3QgdXBkYXRlID0gY2FyZFVwZGF0ZXMuYmVnaW4oXCJ3YXRjaGVyXCIpO1xuICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKVxuICAgICAgLnRoZW4oKHZhbHVlKSA9PiB7XG4gICAgICAgIGNvbnN0IGhlYWx0aCA9IHZhbHVlIGFzIFdhdGNoZXJIZWFsdGg7XG4gICAgICAgIGlmICghY2FyZC5pc0Nvbm5lY3RlZCB8fCAhY2FyZFVwZGF0ZXMuY29tcGxldGUodXBkYXRlLCBoZWFsdGgpKSByZXR1cm4gbnVsbDtcbiAgICAgICAgcmVuZGVyKGhlYWx0aCk7XG4gICAgICAgIHJldHVybiBoZWFsdGg7XG4gICAgICB9KVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICBjb25zdCBoZWFsdGg6IFdhdGNoZXJIZWFsdGggPSB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwiZXJyb3JcIiwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHVuYXZhaWxhYmxlXCIsIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfTtcbiAgICAgICAgaWYgKCFjYXJkLmlzQ29ubmVjdGVkIHx8ICFjYXJkVXBkYXRlcy5jb21wbGV0ZSh1cGRhdGUsIGhlYWx0aCkpIHJldHVybiBudWxsO1xuICAgICAgICByZW5kZXIoaGVhbHRoKTtcbiAgICAgICAgcmV0dXJuIGhlYWx0aDtcbiAgICAgIH0pO1xuICB9O1xuICBjb25zdCBpc05ld2VyQ3ljbGUgPSAoaGVhbHRoOiBXYXRjaGVySGVhbHRoKTogYm9vbGVhbiA9PiB7XG4gICAgY29uc3QgY3ljbGUgPSBoZWFsdGgubGF0ZXN0Q29tcGxldGVkQ3ljbGU7XG4gICAgaWYgKCFjeWNsZSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmICghcmVwYWlyQmFzZWxpbmVDeWNsZSkge1xuICAgICAgcmV0dXJuIERhdGUucGFyc2UoY3ljbGUuY29tcGxldGVkQXQpID4gcmVwYWlyU3RhcnRlZEF0O1xuICAgIH1cbiAgICByZXR1cm4gY3ljbGUuY3ljbGVJZCAhPT0gcmVwYWlyQmFzZWxpbmVDeWNsZS5jeWNsZUlkXG4gICAgICAmJiBjeWNsZS5jb21wbGV0ZWRBdCA+IHJlcGFpckJhc2VsaW5lQ3ljbGUuY29tcGxldGVkQXQ7XG4gIH07XG4gIGNvbnN0IGZpbmlzaFJlcGFpciA9IChoZWFsdGg6IFdhdGNoZXJIZWFsdGgsIGZhaWxlZCA9IGZhbHNlKTogdm9pZCA9PiB7XG4gICAgcmVwYWlySW5GbGlnaHQgPSBmYWxzZTtcbiAgICByZXBhaXJEaXNwbGF5ID0gZmFpbGVkID8gXCJmYWlsdXJlXCIgOiBcInN1Y2Nlc3NcIjtcbiAgICBpZiAocmVwYWlyUG9sbCkgY2xlYXJUaW1lb3V0KHJlcGFpclBvbGwpO1xuICAgIHJlcGFpclBvbGwgPSBudWxsO1xuICAgIGNvbnN0IG5leHQgPSBmYWlsZWRcbiAgICAgID8geyAuLi5oZWFsdGgsIHN0YXR1czogXCJlcnJvclwiIGFzIGNvbnN0LCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsIHN1bW1hcnk6IGhlYWx0aC5zdW1tYXJ5IHx8IFwiVGhlIHdhdGNoZXIgcmVwYWlyIGN5Y2xlIGZhaWxlZC5cIiB9XG4gICAgICA6IGhlYWx0aDtcbiAgICByZW5kZXIobmV4dCk7XG4gIH07XG4gIGNvbnN0IHBvbGxSZXBhaXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFyZXBhaXJJbkZsaWdodCB8fCAhY2FyZC5pc0Nvbm5lY3RlZCkgcmV0dXJuO1xuICAgIGlmIChyZXBhaXJQb2xsQ291bnQrKyA+PSBNQVhfUkVQQUlSX1BPTExTKSB7XG4gICAgICBmaW5pc2hSZXBhaXIoe1xuICAgICAgICAuLi4obGF0ZXN0SGVhbHRoID8/IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJlcnJvclwiIGFzIGNvbnN0LCB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgZGlkIG5vdCByZXBvcnQgYSBjb21wbGV0ZWQgY3ljbGUgaW4gdGltZS5cIiwgd2F0Y2hlcjogXCJXYXRjaGVyXCIsIGNoZWNrczogW10gfSksXG4gICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICB0aXRsZTogXCJBdXRvbWF0aWMgbWFpbnRlbmFuY2UgZmFpbGVkXCIsXG4gICAgICAgIHN1bW1hcnk6IFwiVGhlIHdhdGNoZXIgZGlkIG5vdCByZXBvcnQgYSBjb21wbGV0ZWQgY3ljbGUgaW4gdGltZS5cIixcbiAgICAgIH0sIHRydWUpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2b2lkIGxvYWQoKS50aGVuKChoZWFsdGgpID0+IHtcbiAgICAgIGlmICghaGVhbHRoIHx8ICFyZXBhaXJJbkZsaWdodCkgcmV0dXJuO1xuICAgICAgY29uc3QgY3ljbGUgPSBoZWFsdGgubGF0ZXN0Q29tcGxldGVkQ3ljbGU7XG4gICAgICBpZiAoaXNOZXdlckN5Y2xlKGhlYWx0aCkpIHtcbiAgICAgICAgZmluaXNoUmVwYWlyKGhlYWx0aCwgY3ljbGU/Lm91dGNvbWUgPT09IFwiZmFpbGVkXCIgfHwgY3ljbGU/LnJlcGFpci5zdGF0dXMgPT09IFwiZmFpbGVkXCIpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICByZW5kZXIoaGVhbHRoKTtcbiAgICAgIHJlcGFpclBvbGwgPSBzZXRUaW1lb3V0KHBvbGxSZXBhaXIsIDFfMDAwKTtcbiAgICB9KTtcbiAgfTtcbiAgY29uc3Qgc3RhcnRSZXBhaXIgPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKHJlcGFpckluRmxpZ2h0KSByZXR1cm47XG4gICAgcmVwYWlySW5GbGlnaHQgPSB0cnVlO1xuICAgIHJlcGFpckRpc3BsYXkgPSBcImlkbGVcIjtcbiAgICByZXBhaXJCYXNlbGluZUN5Y2xlID0gbGF0ZXN0SGVhbHRoPy5sYXRlc3RDb21wbGV0ZWRDeWNsZSA/PyBudWxsO1xuICAgIHJlcGFpclN0YXJ0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgcmVwYWlyUG9sbENvdW50ID0gMDtcbiAgICByZW5kZXIobGF0ZXN0SGVhbHRoID8/IHsgY2hlY2tlZEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksIHN0YXR1czogXCJ3YXJuXCIsIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBydW5uaW5nXCIsIHN1bW1hcnk6IFwiU3RhcnRpbmcgcmVwYWlyXHUyMDI2XCIsIHdhdGNoZXI6IFwiV2F0Y2hlclwiLCBjaGVja3M6IFtdIH0pO1xuICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItYXV0by1tYWludGVuYW5jZVwiKVxuICAgICAgLnRoZW4oKCkgPT4gcG9sbFJlcGFpcigpKVxuICAgICAgLmNhdGNoKChlcnJvcikgPT4gZmluaXNoUmVwYWlyKHtcbiAgICAgICAgLi4uKGxhdGVzdEhlYWx0aCA/PyB7IGNoZWNrZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBzdGF0dXM6IFwiZXJyb3JcIiBhcyBjb25zdCwgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIGZhaWxlZFwiLCBzdW1tYXJ5OiBcIlwiLCB3YXRjaGVyOiBcIldhdGNoZXJcIiwgY2hlY2tzOiBbXSB9KSxcbiAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgIHRpdGxlOiBcIkF1dG9tYXRpYyBtYWludGVuYW5jZSBmYWlsZWRcIixcbiAgICAgICAgc3VtbWFyeTogc2FmZVVpRXJyb3IoZXJyb3IpLFxuICAgICAgfSwgdHJ1ZSkpO1xuICB9O1xuICBsb2FkKCk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgY2FyZFVwZGF0ZXMuaW52YWxpZGF0ZShcIndhdGNoZXJcIik7XG4gICAgcmVwYWlySW5GbGlnaHQgPSBmYWxzZTtcbiAgICBpZiAocmVwYWlyUG9sbCkgY2xlYXJUaW1lb3V0KHJlcGFpclBvbGwpO1xuICAgIHJlcGFpclBvbGwgPSBudWxsO1xuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJBZHZhbmNlZFJ1bnRpbWVTZWN0aW9uKHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgcmVuZGVyQ29kZXhWZXJzaW9uc1NlY3Rpb24oc2VjdGlvbnNXcmFwKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhWZXJzaW9uc1NlY3Rpb24oXG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQsXG4gIG9wdGlvbnM6IHsgY29sbGFwc2VkPzogYm9vbGVhbiB9ID0ge30sXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBzZWN0aW9uLmRhdGFzZXQudHdlYWtlckNvZGV4U2VjdGlvbiA9IFwidHJ1ZVwiO1xuICBjb25zdCByZWZyZXNoID0gY29tcGFjdEJ1dHRvbihcIlJlZnJlc2hcIiwgKCkgPT4geyB2b2lkIGxvYWQodHJ1ZSk7IH0pO1xuICBjb25zdCBoZWFkaW5nID0gc2VjdGlvblRpdGxlKG9wdGlvbnMuY29sbGFwc2VkID8gXCJBZHZhbmNlZCBSdW50aW1lIERldGFpbHNcIiA6IFwiUnVudGltZSBWZXJzaW9uc1wiLCByZWZyZXNoKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChoZWFkaW5nKTtcbiAgY29uc3QgY2FyZCA9IHJvdW5kZWRDYXJkKCk7XG4gIGNhcmQuZGF0YXNldC50d2Vha2VyQ29kZXhDYXJkID0gXCJ0cnVlXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiTG9hZGluZyBDb2RleCB2ZXJzaW9uc1wiLCBcIlVzaW5nIGNhY2hlZCB2ZXJzaW9uIGFuZCBmZWF0dXJlIGluZm9ybWF0aW9uIGZpcnN0LlwiKSk7XG4gIGlmIChvcHRpb25zLmNvbGxhcHNlZCkge1xuICAgIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgICBkZXRhaWxzLmRhdGFzZXQudHdlYWtlckFkdmFuY2VkUnVudGltZURldGFpbHMgPSBcInRydWVcIjtcbiAgICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gICAgc3VtbWFyeS5jbGFzc05hbWUgPSBcImN1cnNvci1wb2ludGVyIHB4LTEgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCI7XG4gICAgc3VtbWFyeS50ZXh0Q29udGVudCA9IFwiQnVpbGRzLCBDTEkgcnVudGltZXMsIHJlbGVhc2VzLCBhbmQgZmVhdHVyZXNcIjtcbiAgICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBib2R5LmNsYXNzTmFtZSA9IFwibXQtMiBmbGV4IGZsZXgtY29sIGdhcC0yXCI7XG4gICAgYm9keS5hcHBlbmRDaGlsZChjYXJkKTtcbiAgICBkZXRhaWxzLmFwcGVuZChzdW1tYXJ5LCBib2R5KTtcbiAgICBzZWN0aW9uLmFwcGVuZENoaWxkKGRldGFpbHMpO1xuICB9IGVsc2Uge1xuICAgIHNlY3Rpb24uYXBwZW5kQ2hpbGQoY2FyZCk7XG4gIH1cbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuXG4gIGxldCBwb2xsaW5nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBsZXQgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgbGV0IGdlbmVyYXRpb24gPSAwO1xuICBjb25zdCBzY2hlZHVsZVBvbGwgPSAoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCkgPT4ge1xuICAgIGlmIChwb2xsaW5nKSBjbGVhclRpbWVvdXQocG9sbGluZyk7XG4gICAgcG9sbGluZyA9IG51bGw7XG4gICAgaWYgKCFhY3Rpb25JbkZsaWdodCAmJiAhY29kZXhQcm9ncmVzc0J1c3koc25hcHNob3QuaW5zdGFsbFByb2dyZXNzKSkgcmV0dXJuO1xuICAgIHBvbGxpbmcgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIGlmIChjYXJkLmlzQ29ubmVjdGVkKSB2b2lkIGxvYWQoZmFsc2UpO1xuICAgIH0sIDkwMCk7XG4gIH07XG4gIGNvbnN0IHJlcXVlc3RSZWxvYWQ6IENvZGV4VWlSZWxvYWQgPSAobW9kZSkgPT4ge1xuICAgIGlmIChtb2RlID09PSBcIm9wZXJhdGlvbi1zdGFydFwiKSBhY3Rpb25JbkZsaWdodCA9IHRydWU7XG4gICAgaWYgKG1vZGUgPT09IFwib3BlcmF0aW9uLXN0b3BcIikgYWN0aW9uSW5GbGlnaHQgPSBmYWxzZTtcbiAgICB2b2lkIGxvYWQoZmFsc2UpO1xuICB9O1xuICBjb25zdCBzaG93ID0gKHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QpID0+IHtcbiAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJDb2RleFZlcnNpb25zQ2FyZChjYXJkLCBzbmFwc2hvdCwgcmVxdWVzdFJlbG9hZCk7XG4gICAgc2NoZWR1bGVQb2xsKHNuYXBzaG90KTtcbiAgfTtcbiAgYXN5bmMgZnVuY3Rpb24gbG9hZChmb3JjZTogYm9vbGVhbik6IFByb21pc2U8dm9pZD4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSArK2dlbmVyYXRpb247XG4gICAgcmVmcmVzaC5kaXNhYmxlZCA9IHRydWU7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHNuYXBzaG90ID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBmb3JjZSA/IFwidHdlYWtlcjpyZWZyZXNoLWNvZGV4LXZlcnNpb25zXCIgOiBcInR3ZWFrZXI6Z2V0LWNvZGV4LXZlcnNpb25zXCIsXG4gICAgICApIGFzIENvZGV4VmVyc2lvbnNTbmFwc2hvdDtcbiAgICAgIGlmIChjdXJyZW50ICE9PSBnZW5lcmF0aW9uIHx8ICFjYXJkLmlzQ29ubmVjdGVkKSByZXR1cm47XG4gICAgICBzaG93KHNuYXBzaG90KTtcbiAgICAgIGlmICghZm9yY2UgJiYgaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3QpKSB7XG4gICAgICAgIHZvaWQgbG9hZCh0cnVlKTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgaWYgKGN1cnJlbnQgIT09IGdlbmVyYXRpb24gfHwgIWNhcmQuaXNDb25uZWN0ZWQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDb2RleCB2ZXJzaW9ucyB1bmF2YWlsYWJsZVwiLCBzYWZlVWlFcnJvcihlcnJvcikpKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgaWYgKGN1cnJlbnQgPT09IGdlbmVyYXRpb24pIHJlZnJlc2guZGlzYWJsZWQgPSBmYWxzZTtcbiAgICB9XG4gIH1cbiAgdm9pZCBsb2FkKGZhbHNlKTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ29kZXhWZXJzaW9uc0NhcmQoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiB2b2lkIHtcbiAgY29uc3QgYnVuZGxlZCA9IHNuYXBzaG90LmNsaS5idW5kbGVkO1xuICBjb25zdCBiZXRhID0gc25hcHNob3QuY2xpLmJldGE7XG4gIGNvbnN0IGJ1c3kgPSBjb2RleFByb2dyZXNzQnVzeShzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MpO1xuXG4gIGlmIChzbmFwc2hvdC5mcm9tQ2FjaGUgfHwgc25hcHNob3Quc3RhbGUpIHtcbiAgICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc25hcHNob3QuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFxuICAgICAgc25hcHNob3Quc3RhbGUgPyBcIkNhY2hlZCBpbmZvcm1hdGlvbiAocmVmcmVzaCBuZWVkZWQpXCIgOiBcIkNhY2hlZCBpbmZvcm1hdGlvblwiLFxuICAgICAgYFNob3dpbmcgdGhlIGxhc3Qga25vd24gZ29vZCByZXN1bHQgZnJvbSAke2NoZWNrZWR9IHdoaWxlIGN1cnJlbnQgaW5mb3JtYXRpb24gbG9hZHMuYCxcbiAgICApKTtcbiAgfVxuXG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhWZXJzaW9uU3VyZmFjZU92ZXJ2aWV3KHNuYXBzaG90KSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhBY3RpdmVDbGlSb3coc25hcHNob3QpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleEVtYmVkZGVkQ2xpUm93KGJ1bmRsZWQsIHNuYXBzaG90KSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhMYXRlc3RTdGFibGVSZWxlYXNlUm93KGJ1bmRsZWQpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleENsaVJvdyhcIk1hbmFnZWQgQWxwaGEgQ0xJIChQcmUtcmVsZWFzZSlcIiwgXCJiZXRhXCIsIGJldGEsIHNuYXBzaG90LCBidXN5LCByZWxvYWQpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjb2RleFJ1bnRpbWVSb3coc25hcHNob3QpKTtcblxuICBjb25zdCByZWxlYXNlcyA9IGFjdGlvblJvdyhcIkdpdEh1YiBSZWxlYXNlc1wiLCBcIlZpZXcgb2ZmaWNpYWwgT3BlbkFJIENvZGV4IHJlbGVhc2Ugbm90ZXMgYW5kIHBhY2thZ2VzLlwiKTtcbiAgbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyZWxlYXNlcyk7XG4gIHJlbGVhc2VzLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik/LmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJPcGVuIFJlbGVhc2VzXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChcImh0dHBzOi8vZ2l0aHViLmNvbS9vcGVuYWkvY29kZXgvcmVsZWFzZXNcIikpLFxuICApO1xuICBjYXJkLmFwcGVuZENoaWxkKHJlbGVhc2VzKTtcblxuICBpZiAoc25hcHNob3QuaW5zdGFsbFByb2dyZXNzICYmIHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcy5waGFzZSAmJiBzbmFwc2hvdC5pbnN0YWxsUHJvZ3Jlc3MucGhhc2UgIT09IFwiaWRsZVwiKSB7XG4gICAgY29uc3QgcCA9IHNuYXBzaG90Lmluc3RhbGxQcm9ncmVzcztcbiAgICBjb25zdCBhbW91bnQgPSBmb3JtYXRCeXRlcyhwLmJ5dGVzKTtcbiAgICBjb25zdCBkZXRhaWwgPSBwLmVycm9yIHx8IFtodW1hbml6ZUNvZGV4UGhhc2UocC5waGFzZSksIHAudmVyc2lvbiwgYW1vdW50XS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcdTAwQjcgXCIpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQWxwaGEgb3BlcmF0aW9uXCIsIGRldGFpbCkpO1xuICB9XG5cbiAgY29uc3Qgc3RhdGVNZXNzYWdlID0gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdCk7XG4gIGlmIChzdGF0ZU1lc3NhZ2UpIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUnVudGltZSBzdGF0dXNcIiwgc3RhdGVNZXNzYWdlKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQoY29kZXhGZWF0dXJlQnJvd3NlcihzbmFwc2hvdCwgYnVzeSwgcmVsb2FkKSk7XG59XG5cbmZ1bmN0aW9uIGNvZGV4VmVyc2lvblN1cmZhY2VPdmVydmlldyhzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBzdGFibGUgPSBzbmFwc2hvdC5jbGkuYnVuZGxlZC5yZWxlYXNlPy52ZXJzaW9uID8/IFwiTm90IGNoZWNrZWRcIjtcbiAgY29uc3QgcHJlcmVsZWFzZSA9IHNuYXBzaG90LmNsaS5iZXRhLnJlbGVhc2U/LnZlcnNpb24gPz8gXCJOb3QgY2hlY2tlZFwiO1xuICBjb25zdCBkZXNrdG9wUHJlcmVsZWFzZSA9IHNuYXBzaG90LmNsaS5idW5kbGVkLnZlcnNpb25DaGFubmVsID09PSBcInByZXJlbGVhc2VcIlxuICAgID8gc25hcHNob3QuY2xpLmJ1bmRsZWQudmVyc2lvbiA/PyBcIk5vdCBjaGVja2VkXCJcbiAgICA6IFwiTm90IGluY2x1ZGVkIGluIHRoaXMgZGVza3RvcCByZWxlYXNlXCI7XG4gIGNvbnN0IG92ZXJ2aWV3ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcnZpZXcuY2xhc3NOYW1lID0gXCJncmlkIGdyaWQtY29scy0xIGdhcC0zIHAtMyBtZDpncmlkLWNvbHMtMlwiO1xuICBvdmVydmlldy5kYXRhc2V0LnR3ZWFrZXJDb2RleFZlcnNpb25PdmVydmlldyA9IFwidHJ1ZVwiO1xuICBvdmVydmlldy5hcHBlbmQoXG4gICAgY29kZXhWZXJzaW9uU3VyZmFjZVN1bW1hcnkoXCJUZXJtaW5hbFwiLCBbXG4gICAgICBbXCJMYXRlc3QgUmVsZWFzZVwiLCBzdGFibGVdLFxuICAgICAgW1wiTGF0ZXN0IFByZS1SZWxlYXNlXCIsIHByZXJlbGVhc2VdLFxuICAgICAgW1wiQ3VycmVudFwiLCBzbmFwc2hvdC50ZXJtaW5hbENsaS52ZXJzaW9uID8/IFwiTm90IGluc3RhbGxlZFwiXSxcbiAgICBdKSxcbiAgICBjb2RleFZlcnNpb25TdXJmYWNlU3VtbWFyeShcIkRlc2t0b3AgbWFjT1NcIiwgW1xuICAgICAgW1wiTGF0ZXN0IFJlbGVhc2VcIiwgc3RhYmxlXSxcbiAgICAgIFtcIkxhdGVzdCBQcmUtUmVsZWFzZVwiLCBkZXNrdG9wUHJlcmVsZWFzZV0sXG4gICAgICBbXCJDdXJyZW50XCIsIHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uID8/IFwiVW5hdmFpbGFibGVcIl0sXG4gICAgXSksXG4gICk7XG4gIHJldHVybiBvdmVydmlldztcbn1cblxuZnVuY3Rpb24gY29kZXhWZXJzaW9uU3VyZmFjZVN1bW1hcnkoXG4gIHRpdGxlVGV4dDogc3RyaW5nLFxuICBtZXRyaWNzOiBSZWFkb25seUFycmF5PHJlYWRvbmx5IFtsYWJlbDogc3RyaW5nLCB2YWx1ZTogc3RyaW5nXT4sXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHN1cmZhY2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdXJmYWNlLmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IG1pbi13LTAgZmxleC1jb2wgZ2FwLTIgcm91bmRlZC1sZyBib3JkZXIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQgdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gIHN1cmZhY2UuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBmb3IgKGNvbnN0IFtsYWJlbCwgdmFsdWVdIG9mIG1ldHJpY3MpIHtcbiAgICBjb25zdCBtZXRyaWMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIG1ldHJpYy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1iYXNlbGluZSBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgICBjb25zdCBrZXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICBrZXkuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQteHNcIjtcbiAgICBrZXkudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICBjb25zdCB2ZXJzaW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgdmVyc2lvbi5jbGFzc05hbWUgPSBcIm1pbi13LTAgdHJ1bmNhdGUgdGV4dC1yaWdodCBmb250LW1vbm8gdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHZlcnNpb24udGV4dENvbnRlbnQgPSB2YWx1ZTtcbiAgICB2ZXJzaW9uLnRpdGxlID0gdmFsdWU7XG4gICAgbWV0cmljLmFwcGVuZChrZXksIHZlcnNpb24pO1xuICAgIHN1cmZhY2UuYXBwZW5kQ2hpbGQobWV0cmljKTtcbiAgfVxuICByZXR1cm4gc3VyZmFjZTtcbn1cblxuZnVuY3Rpb24gY29kZXhBY3RpdmVDbGlSb3coc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYWN0aXZlID0gc25hcHNob3QuYWN0aXZlQ2xpO1xuICBjb25zdCB2ZXJzaW9uID0gYWN0aXZlLnZlcnNpb24gPz8gXCJVbmF2YWlsYWJsZVwiO1xuICBjb25zdCBjaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGFjdGl2ZS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IHNvdXJjZSA9IGFjdGl2ZS5zb3VyY2UgPT09IFwiYnVuZGxlZFwiXG4gICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgZW1iZWRkZWQgaW4gdGhlIE9wZW5BSSBkZXNrdG9wIGFwcCBcdTAwQjcgYXBwLW1hbmFnZWRgXG4gICAgOiBhY3RpdmUuc291cmNlID09PSBcIm1hbmFnZWQtYWxwaGFcIlxuICAgICAgPyBgJHtjaGFubmVsfSBcdTAwQjcgbWFuYWdlZCBieSBUd2Vha2Vyc2BcbiAgICAgIDogYCR7Y2hhbm5lbH0gXHUwMEI3IGV4dGVybmFsIENPREVYX0NMSV9QQVRIIG92ZXJyaWRlYDtcbiAgY29uc3QgZGV0YWlsID0gW2BWZXJzaW9uICR7dmVyc2lvbn1gLCBzb3VyY2UsIGFjdGl2ZS5wYXRoLCBhY3RpdmUuZXJyb3JdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkFjdGl2ZSBDb2RleCBiYWNrZW5kXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gYWN0aXZlLnBhdGg7XG4gIHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpPy5hcHBlbmRDaGlsZChcbiAgICBzdGF0dXNCYWRnZShhY3RpdmUuYXZhaWxhYmxlID8gXCJva1wiIDogXCJlcnJvclwiLCBhY3RpdmUuYXZhaWxhYmxlID8gXCJBY3RpdmVcIiA6IFwiVW5hdmFpbGFibGVcIiksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RW1iZWRkZWRDbGlSb3coXG4gIGNsaTogQ29kZXhDbGlWZXJzaW9uU3RhdGUsXG4gIHNuYXBzaG90OiBDb2RleFZlcnNpb25zU25hcHNob3QsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHZlcnNpb24gPSBjbGkudmVyc2lvbiA/PyBcIlVuYXZhaWxhYmxlXCI7XG4gIGNvbnN0IGNoYW5uZWwgPSBjb2RleFZlcnNpb25DaGFubmVsTGFiZWwoY2xpLnZlcnNpb25DaGFubmVsKTtcbiAgY29uc3QgZGV0YWlsID0gW1xuICAgIGBWZXJzaW9uICR7dmVyc2lvbn1gLFxuICAgIGNoYW5uZWwsXG4gICAgXCJFbWJlZGRlZCBpbiB0aGUgT3BlbkFJIGRlc2t0b3AgYXBwOyBpdCBjaGFuZ2VzIG9ubHkgd2hlbiBPcGVuQUkgc2hpcHMgYSBkZXNrdG9wIHVwZGF0ZVwiLFxuICAgIGNsaS5wYXRoLFxuICAgIGNsaS5hdmFpbGFibGUgPyBudWxsIDogY2xpLmVycm9yLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFx1MDBCNyBcIik7XG4gIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcIkRlc2t0b3AtRW1iZWRkZWQgQ29kZXggQ0xJXCIsIGRldGFpbCk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgcm93LnRpdGxlID0gY2xpLnBhdGggPz8gXCJcIjtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBpZiAoc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCIpIGFjdGlvbnM/LmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJBY3RpdmVcIikpO1xuICBlbHNlIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQXBwLW1hbmFnZWRcIikpO1xuICBpZiAoY2xpLnZlcnNpb24pIHtcbiAgICBjb25zdCByZWxlYXNlVXJsID0gYGh0dHBzOi8vZ2l0aHViLmNvbS9vcGVuYWkvY29kZXgvcmVsZWFzZXMvdGFnL3J1c3QtdiR7ZW5jb2RlVVJJQ29tcG9uZW50KGNsaS52ZXJzaW9uKX1gO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZWxlYXNlXCIsICgpID0+IG9wZW5Db2RleEdpdGh1YlVybChyZWxlYXNlVXJsKSkpO1xuICB9XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIGNvZGV4TGF0ZXN0U3RhYmxlUmVsZWFzZVJvdyhjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZWxlYXNlID0gY2xpLnJlbGVhc2U7XG4gIGNvbnN0IGRldGFpbCA9IHJlbGVhc2VcbiAgICA/IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSAke3JlbGVhc2UudmVyc2lvbn0gXHUwMEI3IFRoaXMgZG9lcyBub3QgcmVwbGFjZSB0aGUgZGVza3RvcC1lbWJlZGRlZCBiYWNrZW5kLmBcbiAgICA6IGBMYXRlc3Qgc3RhYmxlIHN0YW5kYWxvbmUgcmVsZWFzZSB1bmF2YWlsYWJsZSR7Y2xpLmVycm9yID8gYCBcdTAwQjcgJHtjbGkuZXJyb3J9YCA6IFwiXCJ9YDtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFwiTGF0ZXN0IFN0YWJsZSBDTEkgUmVsZWFzZVwiLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9ucz8uYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJTdGFibGVcIikpO1xuICBpZiAoaXNTYWZlQ29kZXhHaXRodWJVcmwocmVsZWFzZT8ucmVsZWFzZVVybCkpIHtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZSEucmVsZWFzZVVybCkpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleENsaVJvdyhcbiAgbGFiZWw6IHN0cmluZyxcbiAgbGFuZTogQ29kZXhDbGlMYW5lLFxuICBjbGk6IENvZGV4Q2xpVmVyc2lvblN0YXRlLFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGNsaS5tYW5hZ2VkQ3VycmVudFZlcnNpb24gPz8gY2xpLnZlcnNpb247XG4gIGNvbnN0IGxhdGVzdCA9IGNsaS5yZWxlYXNlPy52ZXJzaW9uO1xuICBjb25zdCBkZXRhaWwgPSBpbnN0YWxsZWRMYXRlc3RTdW1tYXJ5KGluc3RhbGxlZCwgbGF0ZXN0LCBjbGkuZXJyb3IgfHwgY2xpLnJlbGVhc2U/LmVycm9yKTtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KGxhYmVsLCBkZXRhaWwpO1xuICBtYWtlQ29kZXhSb3dSZXNwb25zaXZlKHJvdyk7XG4gIGNvbnN0IGFjdGlvbnMgPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgaWYgKHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgPT09IGxhbmUpIGFjdGlvbnM/LnByZXBlbmQoc3RhdHVzQmFkZ2UoXCJva1wiLCBcIkFjdGl2ZVwiKSk7XG4gIGNvbnN0IHJlbGVhc2VVcmwgPSBjbGkucmVsZWFzZT8ucmVsZWFzZVVybDtcbiAgaWYgKGlzU2FmZUNvZGV4R2l0aHViVXJsKHJlbGVhc2VVcmwpKSBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmVsZWFzZVwiLCAoKSA9PiBvcGVuQ29kZXhHaXRodWJVcmwocmVsZWFzZVVybCEpKSk7XG4gIGlmIChsYW5lID09PSBcImJldGFcIikge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGluc3RhbGxlZCAmJiBsYXRlc3QgJiYgaW5zdGFsbGVkICE9PSBsYXRlc3QgPyBcIlVwZGF0ZVwiIDogaW5zdGFsbGVkID8gXCJSZWluc3RhbGxcIiA6IFwiSW5zdGFsbFwiO1xuICAgIGNvbnN0IGluc3RhbGwgPSBjb21wYWN0QnV0dG9uKGluc3RhbGxMYWJlbCwgKCkgPT4gcnVuQ29kZXhBY3Rpb24ocm93LCBcInR3ZWFrZXI6aW5zdGFsbC1jb2RleC1iZXRhXCIsIHVuZGVmaW5lZCwgcmVsb2FkKSk7XG4gICAgaW5zdGFsbC5kaXNhYmxlZCA9IGJ1c3kgfHwgIWxhdGVzdDtcbiAgICBhY3Rpb25zPy5hcHBlbmRDaGlsZChpbnN0YWxsKTtcbiAgICBjb25zdCBwcmV2aW91c1ZlcnNpb24gPSBjbGkubWFuYWdlZFByZXZpb3VzVmVyc2lvbjtcbiAgICBpZiAocHJldmlvdXNWZXJzaW9uKSB7XG4gICAgICBjb25zdCByb2xsYmFjayA9IGNvbXBhY3RCdXR0b24oYFJvbGxiYWNrIHRvICR7cHJldmlvdXNWZXJzaW9ufWAsICgpID0+IHJ1bkNvZGV4QWN0aW9uKHJvdywgXCJ0d2Vha2VyOnJvbGxiYWNrLWNvZGV4LWJldGFcIiwgdW5kZWZpbmVkLCByZWxvYWQpKTtcbiAgICAgIHJvbGxiYWNrLmRpc2FibGVkID0gYnVzeTtcbiAgICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKHJvbGxiYWNrKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lUm93KFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByZXF1ZXN0ZWQgPSBzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lO1xuICBjb25zdCBzZWxlY3RlZCA9IHJlcXVlc3RlZFxuICAgID8gcmVxdWVzdGVkID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWQgKGFwcC1tYW5hZ2VkKVwiXG4gICAgOiBzbmFwc2hvdC51c2VyT3ZlcnJpZGVQcmVzZXJ2ZWQgPyBcIkV4dGVybmFsIG92ZXJyaWRlXCIgOiBcIk5vdCBleHBsaWNpdGx5IHNlbGVjdGVkXCI7XG4gIGNvbnN0IGFjdGl2ZSA9IHNuYXBzaG90LmFjdGl2ZUNsaS5zb3VyY2UgPT09IFwibWFuYWdlZC1hbHBoYVwiXG4gICAgPyBcIk1hbmFnZWQgQWxwaGFcIlxuICAgIDogc25hcHNob3QuYWN0aXZlQ2xpLnNvdXJjZSA9PT0gXCJidW5kbGVkXCJcbiAgICAgID8gXCJEZXNrdG9wLWVtYmVkZGVkXCJcbiAgICAgIDogXCJFeHRlcm5hbCBvdmVycmlkZVwiO1xuICBjb25zdCBhY3RpdmVDaGFubmVsID0gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKHNuYXBzaG90LmFjdGl2ZUNsaS52ZXJzaW9uQ2hhbm5lbCk7XG4gIGNvbnN0IGFjdGl2ZVZlcnNpb24gPSBzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbiA/IGAgJHtzbmFwc2hvdC5hY3RpdmVDbGkudmVyc2lvbn1gIDogXCJcIjtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiU2VsZWN0ZWQgcnVudGltZVwiLFxuICAgIGBTZWxlY3RlZDogJHtzZWxlY3RlZH0uIEFjdGl2ZTogJHthY3RpdmV9JHthY3RpdmVWZXJzaW9ufSBcdTAwQjcgJHthY3RpdmVDaGFubmVsfS4gRGVza3RvcCBwcm9maWxlIGFuZCBDTEkgcmVsZWFzZSBjaGFubmVsIGFyZSByZXBvcnRlZCBzZXBhcmF0ZWx5LmAsXG4gICk7XG4gIG1ha2VDb2RleFJvd1Jlc3BvbnNpdmUocm93KTtcbiAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBhY3Rpb25zPy5hcHBlbmRDaGlsZChjb2RleE5ldXRyYWxCYWRnZShcIk1hbmFnZWQgYnkgRW52aXJvbm1lbnRcIikpO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVCcm93c2VyKFxuICBzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90LFxuICBidXN5OiBib29sZWFuLFxuICByZWxvYWQ6IENvZGV4VWlSZWxvYWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHdyYXBwZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB3cmFwcGVyLmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5kYXRhc2V0LnR3ZWFrZXJGZWF0dXJlQnJvd3NlciA9IFwidHJ1ZVwiO1xuICBjb25zdCBzdW1tYXJ5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInN1bW1hcnlcIik7XG4gIHN1bW1hcnkuY2xhc3NOYW1lID0gXCJjdXJzb3ItcG9pbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIGNvbnN0IGZlYXR1cmVzID0gc25hcHNob3QuZmVhdHVyZXM7XG4gIHN1bW1hcnkudGV4dENvbnRlbnQgPSBgQ29kZXggQ0xJIGZlYXR1cmVzICgke2ZlYXR1cmVzLmxlbmd0aH0pYDtcbiAgZGV0YWlscy5hcHBlbmRDaGlsZChzdW1tYXJ5KTtcbiAgY29uc3QgY29udGVudCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNvbnRlbnQuY2xhc3NOYW1lID0gXCJtdC0zIGZsZXggZmxleC1jb2wgZ2FwLTNcIjtcbiAgY29uc3QgZmlsdGVycyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZpbHRlcnMuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2gudHlwZSA9IFwic2VhcmNoXCI7XG4gIHNlYXJjaC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIENvZGV4IGZlYXR1cmVzXCI7XG4gIHNlYXJjaC5jbGFzc05hbWUgPSBcImJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIG1pbi13LVsxODBweF0gZmxleC0xIHJvdW5kZWQtbWQgYm9yZGVyIHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICBjb25zdCBzdGFnZSA9IGNvZGV4RmlsdGVyU2VsZWN0KFwiU3RhZ2VcIiwgW1wiYWxsXCIsIFwic3RhYmxlXCIsIFwiZXhwZXJpbWVudGFsXCIsIFwidW5kZXItZGV2ZWxvcG1lbnRcIiwgXCJkZXByZWNhdGVkXCIsIFwicmVtb3ZlZFwiXSk7XG4gIGNvbnN0IGxhbmUgPSBjb2RleEZpbHRlclNlbGVjdChcIkxhbmVcIiwgW1wiYWxsXCIsIFwiYnVuZGxlZFwiLCBcImJldGFcIiwgXCJidW5kbGVkLW9ubHlcIiwgXCJiZXRhLW9ubHlcIl0pO1xuICBjb25zdCBzdGF0dXMgPSBjb2RleEZpbHRlclNlbGVjdChcIlN0YXR1c1wiLCBbXCJhbGxcIiwgXCJlbmFibGVkXCIsIFwiZGlzYWJsZWRcIiwgXCJ1bnN1cHBvcnRlZFwiLCBcInJlYWQtb25seVwiXSk7XG4gIGZpbHRlcnMuYXBwZW5kKHNlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1cyk7XG4gIGNvbnRlbnQuYXBwZW5kQ2hpbGQoZmlsdGVycyk7XG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjb250ZW50LmFwcGVuZENoaWxkKGxpc3QpO1xuICBjb25zdCBkcmF3ID0gKCkgPT4ge1xuICAgIGxpc3QudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoLnZhbHVlLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIGNvbnN0IHNlbGVjdGVkTGFuZSA9IHNuYXBzaG90LnJlcXVlc3RlZExhbmUgPz8gc25hcHNob3QuZWZmZWN0aXZlTGFuZSA/PyBcImJ1bmRsZWRcIjtcbiAgICBjb25zdCBzaG93biA9IGZlYXR1cmVzLmZpbHRlcigoZmVhdHVyZSkgPT4ge1xuICAgICAgY29uc3QgZmVhdHVyZVN0YWdlID0gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZSwgc2VsZWN0ZWRMYW5lKTtcbiAgICAgIGNvbnN0IGVuYWJsZWQgPSBjb2RleEZlYXR1cmVFbmFibGVkKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSk7XG4gICAgICBjb25zdCBsYW5lTWF0Y2ggPSBsYW5lLnZhbHVlID09PSBcImFsbFwiXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWQtb25seVwiICYmIGZlYXR1cmUuYnVuZGxlZE9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGEtb25seVwiICYmIGZlYXR1cmUuYmV0YU9ubHkpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJ1bmRsZWRcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJ1bmRsZWRcIikgIT09IG51bGwpXG4gICAgICAgIHx8IChsYW5lLnZhbHVlID09PSBcImJldGFcIiAmJiBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBcImJldGFcIikgIT09IG51bGwpO1xuICAgICAgY29uc3Qgc3RhdHVzTWF0Y2ggPSBzdGF0dXMudmFsdWUgPT09IFwiYWxsXCIgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJlbmFibGVkXCIgJiYgZW5hYmxlZCA9PT0gdHJ1ZSkgfHwgKHN0YXR1cy52YWx1ZSA9PT0gXCJkaXNhYmxlZFwiICYmIGVuYWJsZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInVuc3VwcG9ydGVkXCIgJiYgZmVhdHVyZS5zdXBwb3J0ZWQgPT09IGZhbHNlKSB8fCAoc3RhdHVzLnZhbHVlID09PSBcInJlYWQtb25seVwiICYmICFjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIHNlbGVjdGVkTGFuZSkpO1xuICAgICAgcmV0dXJuICghcXVlcnkgfHwgZmVhdHVyZS5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocXVlcnkpKSAmJiAoc3RhZ2UudmFsdWUgPT09IFwiYWxsXCIgfHwgc3RhZ2UudmFsdWUgPT09IGZlYXR1cmVTdGFnZSkgJiYgbGFuZU1hdGNoICYmIHN0YXR1c01hdGNoO1xuICAgIH0pO1xuICAgIGZvciAoY29uc3QgZmVhdHVyZSBvZiBzaG93bikgbGlzdC5hcHBlbmRDaGlsZChjb2RleEZlYXR1cmVSb3coZmVhdHVyZSwgc2VsZWN0ZWRMYW5lLCBidXN5LCByZWxvYWQpKTtcbiAgICBpZiAoIXNob3duLmxlbmd0aCkgbGlzdC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJObyBtYXRjaGluZyBmZWF0dXJlc1wiLCBcIlRyeSBhIGRpZmZlcmVudCBzZWFyY2ggb3IgZmlsdGVyLlwiKSk7XG4gIH07XG4gIGZvciAoY29uc3QgaW5wdXQgb2YgW3NlYXJjaCwgc3RhZ2UsIGxhbmUsIHN0YXR1c10pIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoaW5wdXQgPT09IHNlYXJjaCA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCIsIGRyYXcpO1xuICBkcmF3KCk7XG4gIGRldGFpbHMuYXBwZW5kQ2hpbGQoY29udGVudCk7XG4gIHdyYXBwZXIuYXBwZW5kQ2hpbGQoZGV0YWlscyk7XG4gIHJldHVybiB3cmFwcGVyO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVSb3coXG4gIGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LFxuICBsYW5lOiBDb2RleENsaUxhbmUsXG4gIGJ1c3k6IGJvb2xlYW4sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgY29uc3QgZW5hYmxlZCA9IGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSk7XG4gIGNvbnN0IG11dGFibGUgPSBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmUsIGxhbmUpO1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0zIHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gcm93Q29weShmZWF0dXJlLm5hbWUsIGAke3N0YWdlIHx8IFwidW5zdXBwb3J0ZWRcIn0gXHUwMEI3ICR7ZmVhdHVyZS5lZmZlY3QgPT09IFwicmVzdGFydFwiID8gXCJSZXN0YXJ0IHJlcXVpcmVkXCIgOiBmZWF0dXJlLmVmZmVjdCA9PT0gXCJub25lXCIgPyBcIk5vIHJlc3RhcnRcIiA6IFwiQXBwbGllcyB0byBuZXcgc2Vzc2lvbnNcIn1gKTtcbiAgY29uc3QgYmFkZ2VzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYmFkZ2VzLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LXdyYXAgaXRlbXMtY2VudGVyIGdhcC0xXCI7XG4gIGlmIChmZWF0dXJlLmJ1bmRsZWRPbmx5KSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJCdW5kbGVkIG9ubHlcIikpO1xuICBpZiAoZmVhdHVyZS5iZXRhT25seSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiQmV0YSBvbmx5XCIpKTtcbiAgaWYgKGZlYXR1cmUuc3VwcG9ydGVkID09PSBmYWxzZSkgYmFkZ2VzLmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKFwiVW5zdXBwb3J0ZWRcIikpO1xuICBpZiAoZW5hYmxlZCA9PT0gdHJ1ZSkgYmFkZ2VzLmFwcGVuZENoaWxkKHN0YXR1c0JhZGdlKFwib2tcIiwgXCJFbmFibGVkXCIpKTtcbiAgaWYgKGVuYWJsZWQgPT09IGZhbHNlKSBiYWRnZXMuYXBwZW5kQ2hpbGQoY29kZXhOZXV0cmFsQmFkZ2UoXCJEaXNhYmxlZFwiKSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoYmFkZ2VzKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBpZiAobXV0YWJsZSAmJiBlbmFibGVkICE9PSBudWxsKSB7XG4gICAgY29uc3QgdG9nZ2xlID0gc3dpdGNoQ29udHJvbChlbmFibGVkLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgdG9nZ2xlLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6c2V0LWNvZGV4LWZlYXR1cmVcIiwgeyBsYW5lLCBuYW1lOiBmZWF0dXJlLm5hbWUsIGVuYWJsZWQ6IG5leHQgfSk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgd2luZG93LmFsZXJ0KGBDb3VsZCBub3QgdXBkYXRlICR7ZmVhdHVyZS5uYW1lfTogJHtzYWZlVWlFcnJvcihlcnJvcil9YCk7XG4gICAgICAgIHJlbG9hZCgpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgdG9nZ2xlLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gICAgdG9nZ2xlLmRpc2FibGVkID0gYnVzeTtcbiAgICB0b2dnbGUudGl0bGUgPSBcIkZlYXR1cmUgY2hhbmdlcyBhcHBseSB0byBuZXcgc2Vzc2lvbnMuXCI7XG4gICAgcm93LmFwcGVuZENoaWxkKHRvZ2dsZSk7XG4gIH0gZWxzZSB7XG4gICAgcm93LmFwcGVuZENoaWxkKGNvZGV4TmV1dHJhbEJhZGdlKHN0YWdlID09PSBcImRlcHJlY2F0ZWRcIiB8fCBzdGFnZSA9PT0gXCJyZW1vdmVkXCIgPyBcIlJlYWQgb25seVwiIDogXCJVbmF2YWlsYWJsZVwiKSk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlU3RhZ2UoZmVhdHVyZTogQ29kZXhGZWF0dXJlRW50cnksIGxhbmU6IENvZGV4Q2xpTGFuZSk6IENvZGV4RmVhdHVyZVN0YWdlIHwgbnVsbCB7XG4gIHJldHVybiBmZWF0dXJlLnN0YWdlc1tsYW5lXTtcbn1cblxuZnVuY3Rpb24gY29kZXhGZWF0dXJlRW5hYmxlZChmZWF0dXJlOiBDb2RleEZlYXR1cmVFbnRyeSwgbGFuZTogQ29kZXhDbGlMYW5lKTogYm9vbGVhbiB8IG51bGwge1xuICByZXR1cm4gZmVhdHVyZS5lbmFibGVkW2xhbmVdO1xufVxuXG5mdW5jdGlvbiBjb2RleEZlYXR1cmVNdXRhYmxlKGZlYXR1cmU6IENvZGV4RmVhdHVyZUVudHJ5LCBsYW5lOiBDb2RleENsaUxhbmUpOiBib29sZWFuIHtcbiAgY29uc3Qgc3RhZ2UgPSBjb2RleEZlYXR1cmVTdGFnZShmZWF0dXJlLCBsYW5lKTtcbiAgcmV0dXJuIGZlYXR1cmUubXV0YWJsZSA9PT0gdHJ1ZVxuICAgICYmIGZlYXR1cmUuc3VwcG9ydGVkICE9PSBmYWxzZVxuICAgICYmIHN0YWdlICE9PSBcImRlcHJlY2F0ZWRcIlxuICAgICYmIHN0YWdlICE9PSBcInJlbW92ZWRcIlxuICAgICYmIGNvZGV4RmVhdHVyZUVuYWJsZWQoZmVhdHVyZSwgbGFuZSkgIT09IG51bGw7XG59XG5cbmZ1bmN0aW9uIGNvZGV4RmlsdGVyU2VsZWN0KGxhYmVsOiBzdHJpbmcsIG9wdGlvbnM6IHN0cmluZ1tdKTogSFRNTFNlbGVjdEVsZW1lbnQge1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID0gXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBoLXRva2VuLWJ1dHRvbi1jb21wb3NlciByb3VuZGVkLW1kIGJvcmRlciBweC0yIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgc2VsZWN0LnRpdGxlID0gbGFiZWw7XG4gIGZvciAoY29uc3QgdmFsdWUgb2Ygb3B0aW9ucykge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gdmFsdWUgPT09IFwiYWxsXCIgPyBgQWxsICR7bGFiZWwudG9Mb3dlckNhc2UoKX1zYCA6IGh1bWFuaXplQ29kZXhQaGFzZSh2YWx1ZSk7XG4gICAgc2VsZWN0LmFwcGVuZENoaWxkKG9wdGlvbik7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdDtcbn1cblxuZnVuY3Rpb24gY29kZXhOZXV0cmFsQmFkZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBcImlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC81IHB4LTIgcHktMC41IHRleHQteHMgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IHRleHQ7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gbWFrZUNvZGV4Um93UmVzcG9uc2l2ZShyb3c6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHJvdy5jbGFzc0xpc3QuYWRkKFwiZmxleC13cmFwXCIpO1xuICByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKT8uY2xhc3NMaXN0LmFkZChcImZsZXgtd3JhcFwiLCBcImp1c3RpZnktZW5kXCIpO1xufVxuXG5mdW5jdGlvbiBjb2RleElubGluZU1lc3NhZ2UodGV4dDogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBtZXNzYWdlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbWVzc2FnZS5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIG1lc3NhZ2UudGV4dENvbnRlbnQgPSB0ZXh0O1xuICByZXR1cm4gbWVzc2FnZTtcbn1cblxuZnVuY3Rpb24gY29kZXhQcm9ncmVzc0J1c3kocHJvZ3Jlc3M6IENvZGV4SW5zdGFsbFByb2dyZXNzKTogYm9vbGVhbiB7XG4gIHJldHVybiAhW1wiaWRsZVwiLCBcImNvbXBsZXRlXCIsIFwiZmFpbGVkXCJdLmluY2x1ZGVzKHByb2dyZXNzLnBoYXNlKTtcbn1cblxuZnVuY3Rpb24gaXNDb2RleFNuYXBzaG90U3RhbGUoc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc25hcHNob3Quc3RhbGU7XG59XG5cbmZ1bmN0aW9uIGluc3RhbGxlZExhdGVzdFN1bW1hcnkoXG4gIGluc3RhbGxlZDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCxcbiAgbGF0ZXN0OiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkLFxuICBlcnJvcj86IHN0cmluZyB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBpbnN0YWxsZWRUZXh0ID0gaW5zdGFsbGVkIHx8IFwiVW5hdmFpbGFibGVcIjtcbiAgY29uc3QgbGF0ZXN0VGV4dCA9IGxhdGVzdCB8fCBcIlVuYXZhaWxhYmxlXCI7XG4gIHJldHVybiBgSW5zdGFsbGVkICR7aW5zdGFsbGVkVGV4dH0gXHUwMEI3IExhdGVzdCAke2xhdGVzdFRleHR9JHtlcnJvciA/IGAgXHUwMEI3ICR7ZXJyb3J9YCA6IFwiXCJ9YDtcbn1cblxuZnVuY3Rpb24gY29kZXhSdW50aW1lTWVzc2FnZShzbmFwc2hvdDogQ29kZXhWZXJzaW9uc1NuYXBzaG90KTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChzbmFwc2hvdC5mYWxsYmFja1JlYXNvbikgcmV0dXJuIGBNYW5hZ2VkIEFscGhhIGNvdWxkIG5vdCBzdGFydDsgdGhlIGRlc2t0b3AtZW1iZWRkZWQgYmFja2VuZCB3YXMgdXNlZC4gJHtzbmFwc2hvdC5mYWxsYmFja1JlYXNvbn1gO1xuICBpZiAoc25hcHNob3QucmVzdGFydFJlcXVpcmVkKSByZXR1cm4gXCJSZXN0YXJ0IHRoZSBhcHAgdG8gYXBwbHkgdGhlIHNlbGVjdGVkIENvZGV4IHJ1bnRpbWUuXCI7XG4gIGlmIChzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lICYmIHNuYXBzaG90LmVmZmVjdGl2ZUxhbmUgJiYgc25hcHNob3QucmVxdWVzdGVkTGFuZSAhPT0gc25hcHNob3QuZWZmZWN0aXZlTGFuZSkge1xuICAgIHJldHVybiBgJHtzbmFwc2hvdC5yZXF1ZXN0ZWRMYW5lID09PSBcImJldGFcIiA/IFwiTWFuYWdlZCBBbHBoYSAoUHJlLXJlbGVhc2UpXCIgOiBcIkRlc2t0b3AtZW1iZWRkZWRcIn0gaXMgc2VsZWN0ZWQ7ICR7c25hcHNob3QuZWZmZWN0aXZlTGFuZSA9PT0gXCJiZXRhXCIgPyBcIk1hbmFnZWQgQWxwaGEgKFByZS1yZWxlYXNlKVwiIDogXCJEZXNrdG9wLWVtYmVkZGVkXCJ9IHJlbWFpbnMgYWN0aXZlIHVudGlsIHJlc3RhcnQuYDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gY29kZXhWZXJzaW9uQ2hhbm5lbExhYmVsKGNoYW5uZWw6IENvZGV4Q2xpVmVyc2lvblN0YXRlW1widmVyc2lvbkNoYW5uZWxcIl0pOiBzdHJpbmcge1xuICBpZiAoY2hhbm5lbCA9PT0gXCJzdGFibGVcIikgcmV0dXJuIFwiU3RhYmxlXCI7XG4gIGlmIChjaGFubmVsID09PSBcInByZXJlbGVhc2VcIikgcmV0dXJuIFwiUHJlLXJlbGVhc2VcIjtcbiAgcmV0dXJuIFwiVW5rbm93biByZWxlYXNlIGNoYW5uZWxcIjtcbn1cblxuZnVuY3Rpb24gY29kZXhTY29wZWRFcnJvcihcbiAgc25hcHNob3Q6IENvZGV4VmVyc2lvbnNTbmFwc2hvdCxcbiAgc2NvcGU6IFwiZGVza3RvcFwiIHwgQ29kZXhDbGlMYW5lLFxuKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBzbmFwc2hvdC5lcnJvcnNbc2NvcGVdID8/IG51bGw7XG59XG5cbmZ1bmN0aW9uIGlzU2FmZUNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICBpZiAoIXVybCkgcmV0dXJuIGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsKTtcbiAgICByZXR1cm4gcGFyc2VkLnByb3RvY29sID09PSBcImh0dHBzOlwiXG4gICAgICAmJiBwYXJzZWQuaG9zdG5hbWUgPT09IFwiZ2l0aHViLmNvbVwiXG4gICAgICAmJiBwYXJzZWQucG9ydCA9PT0gXCJcIlxuICAgICAgJiYgcGFyc2VkLnVzZXJuYW1lID09PSBcIlwiXG4gICAgICAmJiBwYXJzZWQucGFzc3dvcmQgPT09IFwiXCJcbiAgICAgICYmIChwYXJzZWQucGF0aG5hbWUgPT09IFwiL29wZW5haS9jb2RleFwiIHx8IHBhcnNlZC5wYXRobmFtZS5zdGFydHNXaXRoKFwiL29wZW5haS9jb2RleC9cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuZnVuY3Rpb24gb3BlbkNvZGV4R2l0aHViVXJsKHVybDogc3RyaW5nKTogdm9pZCB7XG4gIGlmICghaXNTYWZlQ29kZXhHaXRodWJVcmwodXJsKSkge1xuICAgIHBsb2coXCJibG9ja2VkIG5vbi1Db2RleCBHaXRIdWIgVVJMXCIsIHVybCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCkuY2F0Y2goKGVycm9yKSA9PiBwbG9nKFwib3BlbiBDb2RleCByZWxlYXNlIGZhaWxlZFwiLCBTdHJpbmcoZXJyb3IpKSk7XG59XG5cbmZ1bmN0aW9uIHJ1bkNvZGV4QWN0aW9uKFxuICByb3c6IEhUTUxFbGVtZW50LFxuICBjaGFubmVsOiBzdHJpbmcsXG4gIHBheWxvYWQ6IHVua25vd24sXG4gIHJlbG9hZDogQ29kZXhVaVJlbG9hZCxcbik6IHZvaWQge1xuICBjb25zdCBidXR0b25zID0gcm93LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSB0cnVlOyB9KTtcbiAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgcmVsb2FkKFwib3BlcmF0aW9uLXN0YXJ0XCIpO1xuICBjb25zdCBpbnZva2UgPSBwYXlsb2FkID09PSB1bmRlZmluZWQgPyBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCkgOiBpcGNSZW5kZXJlci5pbnZva2UoY2hhbm5lbCwgcGF5bG9hZCk7XG4gIHZvaWQgaW52b2tlXG4gICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgd2luZG93LmFsZXJ0KHNhZmVVaUVycm9yKGVycm9yKSk7XG4gICAgfSlcbiAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiXCI7XG4gICAgICBidXR0b25zLmZvckVhY2goKGJ1dHRvbikgPT4geyBidXR0b24uZGlzYWJsZWQgPSBmYWxzZTsgfSk7XG4gICAgICByZWxvYWQoXCJvcGVyYXRpb24tc3RvcFwiKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2FmZVVpRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IgfHwgXCJVbmtub3duIGVycm9yXCIpO1xufVxuXG5mdW5jdGlvbiBmb3JtYXRCeXRlcyh2YWx1ZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlIDwgMTAyNCkgcmV0dXJuIGAke3ZhbHVlfSBCYDtcbiAgaWYgKHZhbHVlIDwgMTAyNCAqIDEwMjQpIHJldHVybiBgJHsodmFsdWUgLyAxMDI0KS50b0ZpeGVkKDEpfSBLQmA7XG4gIHJldHVybiBgJHsodmFsdWUgLyAoMTAyNCAqIDEwMjQpKS50b0ZpeGVkKDEpfSBNQmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrZXJDb25maWcoY2FyZDogSFRNTEVsZW1lbnQsIGNvbmZpZzogVHdlYWtlckNvbmZpZyk6IHZvaWQge1xuICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihjb25maWcudXBkYXRlQ2hlY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGF1dG9VcGRhdGVSb3coY29uZmlnKSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQodXBkYXRlQ2hhbm5lbFJvdyhjb25maWcpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChpbnN0YWxsYXRpb25Tb3VyY2VSb3coY29uZmlnLmluc3RhbGxhdGlvblNvdXJjZSkpO1xuICBjYXJkLmFwcGVuZENoaWxkKHNlbGZVcGRhdGVTdGF0dXNSb3coY29uZmlnLnNlbGZVcGRhdGUpKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnKSk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hlY2s/LnJlbGVhc2VOb3RlcykgY2FyZC5hcHBlbmRDaGlsZChyZWxlYXNlTm90ZXNSb3coY29uZmlnLnVwZGF0ZUNoZWNrKSk7XG59XG5cbmZ1bmN0aW9uIGF1dG9VcGRhdGVSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBcIkF1dG9tYXRpY2FsbHkgcmVmcmVzaCBUd2Vha2Vyc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSBgSW5zdGFsbGVkIHZlcnNpb24gdiR7Y29uZmlnLnZlcnNpb259LiBUaGUgd2F0Y2hlciBjaGVja3MgaG91cmx5IGFuZCBjYW4gcmVmcmVzaCB0aGUgVHdlYWtlcnMgcnVudGltZSBhdXRvbWF0aWNhbGx5LmA7XG4gIGxlZnQuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBsZWZ0LmFwcGVuZENoaWxkKGRlc2MpO1xuICByb3cuYXBwZW5kQ2hpbGQobGVmdCk7XG4gIHJvdy5hcHBlbmRDaGlsZChcbiAgICBzd2l0Y2hDb250cm9sKGNvbmZpZy5hdXRvVXBkYXRlLCBhc3luYyAobmV4dCkgPT4ge1xuICAgICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpzZXQtYXV0by11cGRhdGVcIiwgbmV4dCk7XG4gICAgfSksXG4gICk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHVwZGF0ZUNoYW5uZWxSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXCJSZWxlYXNlIGNoYW5uZWxcIiwgdXBkYXRlQ2hhbm5lbFN1bW1hcnkoY29uZmlnKSk7XG4gIGNvbnN0IGFjdGlvbiA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICBjb25zdCBzZWxlY3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic2VsZWN0XCIpO1xuICBzZWxlY3QuY2xhc3NOYW1lID1cbiAgICBcImgtOCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZm9yIChjb25zdCBbdmFsdWUsIGxhYmVsXSBvZiBbXG4gICAgW1wic3RhYmxlXCIsIFwiU3RhYmxlXCJdLFxuICAgIFtcInByZXJlbGVhc2VcIiwgXCJQcmVyZWxlYXNlXCJdLFxuICAgIFtcImN1c3RvbVwiLCBcIkN1c3RvbVwiXSxcbiAgXSBhcyBjb25zdCkge1xuICAgIGNvbnN0IG9wdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJvcHRpb25cIik7XG4gICAgb3B0aW9uLnZhbHVlID0gdmFsdWU7XG4gICAgb3B0aW9uLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgb3B0aW9uLnNlbGVjdGVkID0gY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IHZhbHVlO1xuICAgIHNlbGVjdC5hcHBlbmRDaGlsZChvcHRpb24pO1xuICB9XG4gIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAuaW52b2tlKFwidHdlYWtlcjpzZXQtdXBkYXRlLWNvbmZpZ1wiLCB7IHVwZGF0ZUNoYW5uZWw6IHNlbGVjdC52YWx1ZSB9KVxuICAgICAgLnRoZW4oKCkgPT4gcmVmcmVzaENvbmZpZ0NhcmQocm93KSlcbiAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInNldCB1cGRhdGUgY2hhbm5lbCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gIH0pO1xuICBhY3Rpb24/LmFwcGVuZENoaWxkKHNlbGVjdCk7XG4gIGlmIChjb25maWcudXBkYXRlQ2hhbm5lbCA9PT0gXCJjdXN0b21cIikge1xuICAgIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiRWRpdFwiLCAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlcG8gPSB3aW5kb3cucHJvbXB0KFwiR2l0SHViIHJlcG9cIiwgY29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCIpO1xuICAgICAgICBpZiAocmVwbyA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICBjb25zdCByZWYgPSB3aW5kb3cucHJvbXB0KFwiR2l0IHJlZlwiLCBjb25maWcudXBkYXRlUmVmIHx8IFwibWFpblwiKTtcbiAgICAgICAgaWYgKHJlZiA9PT0gbnVsbCkgcmV0dXJuO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyXG4gICAgICAgICAgLmludm9rZShcInR3ZWFrZXI6c2V0LXVwZGF0ZS1jb25maWdcIiwge1xuICAgICAgICAgICAgdXBkYXRlQ2hhbm5lbDogXCJjdXN0b21cIixcbiAgICAgICAgICAgIHVwZGF0ZVJlcG86IHJlcG8sXG4gICAgICAgICAgICB1cGRhdGVSZWY6IHJlZixcbiAgICAgICAgICB9KVxuICAgICAgICAgIC50aGVuKCgpID0+IHJlZnJlc2hDb25maWdDYXJkKHJvdykpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwic2V0IGN1c3RvbSB1cGRhdGUgc291cmNlIGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gaW5zdGFsbGF0aW9uU291cmNlUm93KHNvdXJjZTogSW5zdGFsbGF0aW9uU291cmNlKTogSFRNTEVsZW1lbnQge1xuICByZXR1cm4gcm93U2ltcGxlKFwiSW5zdGFsbGF0aW9uIHNvdXJjZVwiLCBgJHtzb3VyY2UubGFiZWx9OiAke3NvdXJjZS5kZXRhaWx9YCk7XG59XG5cbmZ1bmN0aW9uIHNlbGZVcGRhdGVTdGF0dXNSb3coc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IHJvd1NpbXBsZShcIkxhc3QgVHdlYWtlcnMgdXBkYXRlXCIsIHNlbGZVcGRhdGVTdW1tYXJ5KHN0YXRlKSk7XG4gIGNvbnN0IGxlZnQgPSByb3cuZmlyc3RFbGVtZW50Q2hpbGQgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAobGVmdCAmJiBzdGF0ZSkge1xuICAgIGNvbnN0IHVucHVibGlzaGVkID0gc3RhdGUuc3RhdHVzID09PSBcImZhaWxlZFwiICYmIC80MDR8bm8gKD86cHVibGlzaGVkIHxnaXRodWIgKT9yZWxlYXNlL2kudGVzdChzdGF0ZS5lcnJvciA/PyBcIlwiKTtcbiAgICBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UodW5wdWJsaXNoZWQgPyBcIm9rXCIgOiBzZWxmVXBkYXRlU3RhdHVzVG9uZShzdGF0ZS5zdGF0dXMpLCB1bnB1Ymxpc2hlZCA/IFwiQ3VycmVudFwiIDogc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXRlLnN0YXR1cykpKTtcbiAgfVxuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiBjaGVja0ZvclVwZGF0ZXNSb3coY29uZmlnOiBUd2Vha2VyQ29uZmlnKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjaGVjayA9IGNvbmZpZy51cGRhdGVDaGVjaztcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA/IFwiVHdlYWtlcnMgdXBkYXRlIGF2YWlsYWJsZVwiIDogXCJDaGVjayBmb3IgVHdlYWtlcnMgdXBkYXRlc1wiO1xuICBjb25zdCBkZXNjID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZGVzYy5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgbWluLXctMCB0ZXh0LXNtXCI7XG4gIGRlc2MudGV4dENvbnRlbnQgPSB1cGRhdGVTdW1tYXJ5KGNoZWNrKTtcbiAgbGVmdC5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoZGVzYyk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGlmIChjaGVjaz8ucmVsZWFzZVVybCkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICBjb21wYWN0QnV0dG9uKFwiUmVsZWFzZSBOb3Rlc1wiLCAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGNoZWNrLnJlbGVhc2VVcmwpO1xuICAgICAgfSksXG4gICAgKTtcbiAgfVxuICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgIGNvbXBhY3RCdXR0b24oXCJDaGVjayBOb3dcIiwgKCkgPT4ge1xuICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIjAuNjVcIjtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y2hlY2stdHdlYWtlci11cGRhdGVcIiwgdHJ1ZSlcbiAgICAgICAgLnRoZW4oKGNoZWNrKSA9PiB7XG4gICAgICAgICAgc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJUd2Vha2VycyByZWxlYXNlIGNoZWNrIGZhaWxlZFwiLCBTdHJpbmcoZSkpKVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICB9KTtcbiAgICB9KSxcbiAgKTtcbiAgaWYgKGNoZWNrPy51cGRhdGVBdmFpbGFibGUpIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkRvd25sb2FkIFVwZGF0ZVwiLCAoKSA9PiB7XG4gICAgICByb3cuc3R5bGUub3BhY2l0eSA9IFwiMC42NVwiO1xuICAgICAgY29uc3QgYnV0dG9ucyA9IGFjdGlvbnMucXVlcnlTZWxlY3RvckFsbChcImJ1dHRvblwiKTtcbiAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gdHJ1ZSkpO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlclxuICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpydW4tdHdlYWtlci11cGRhdGVcIilcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHJlZnJlc2hTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbih0cnVlKTtcbiAgICAgICAgICByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICBwbG9nKFwiVHdlYWtlcnMgc2VsZi11cGRhdGUgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICAgICAgdm9pZCByZWZyZXNoQ29uZmlnQ2FyZChyb3cpO1xuICAgICAgICB9KVxuICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgcm93LnN0eWxlLm9wYWNpdHkgPSBcIlwiO1xuICAgICAgICAgIGJ1dHRvbnMuZm9yRWFjaCgoYnV0dG9uKSA9PiAoYnV0dG9uLmRpc2FibGVkID0gZmFsc2UpKTtcbiAgICAgICAgfSk7XG4gICAgfSksXG4gICk7XG4gIHJvdy5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gcmVsZWFzZU5vdGVzUm93KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2spOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggZmxleC1jb2wgZ2FwLTIgcC0zXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJMYXRlc3QgcmVsZWFzZSBub3Rlc1wiO1xuICByb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBjb25zdCBib2R5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYm9keS5jbGFzc05hbWUgPVxuICAgIFwibWF4LWgtNjAgb3ZlcmZsb3ctYXV0byByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSBwLTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIGJvZHkuYXBwZW5kQ2hpbGQocmVuZGVyUmVsZWFzZU5vdGVzTWFya2Rvd24oY2hlY2sucmVsZWFzZU5vdGVzPy50cmltKCkgfHwgY2hlY2suZXJyb3IgfHwgXCJObyByZWxlYXNlIG5vdGVzIGF2YWlsYWJsZS5cIikpO1xuICByb3cuYXBwZW5kQ2hpbGQoYm9keSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclJlbGVhc2VOb3Rlc01hcmtkb3duKG1hcmtkb3duOiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvb3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb290LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICBjb25zdCBsaW5lcyA9IG1hcmtkb3duLnJlcGxhY2UoL1xcclxcbj8vZywgXCJcXG5cIikuc3BsaXQoXCJcXG5cIik7XG4gIGxldCBwYXJhZ3JhcGg6IHN0cmluZ1tdID0gW107XG4gIGxldCBsaXN0OiBIVE1MT0xpc3RFbGVtZW50IHwgSFRNTFVMaXN0RWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgY29kZUxpbmVzOiBzdHJpbmdbXSB8IG51bGwgPSBudWxsO1xuXG4gIGNvbnN0IGZsdXNoUGFyYWdyYXBoID0gKCkgPT4ge1xuICAgIGlmIChwYXJhZ3JhcGgubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwXCIpO1xuICAgIHAuY2xhc3NOYW1lID0gXCJtLTAgbGVhZGluZy01XCI7XG4gICAgYXBwZW5kSW5saW5lTWFya2Rvd24ocCwgcGFyYWdyYXBoLmpvaW4oXCIgXCIpLnRyaW0oKSk7XG4gICAgcm9vdC5hcHBlbmRDaGlsZChwKTtcbiAgICBwYXJhZ3JhcGggPSBbXTtcbiAgfTtcbiAgY29uc3QgZmx1c2hMaXN0ID0gKCkgPT4ge1xuICAgIGlmICghbGlzdCkgcmV0dXJuO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQobGlzdCk7XG4gICAgbGlzdCA9IG51bGw7XG4gIH07XG4gIGNvbnN0IGZsdXNoQ29kZSA9ICgpID0+IHtcbiAgICBpZiAoIWNvZGVMaW5lcykgcmV0dXJuO1xuICAgIGNvbnN0IHByZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJwcmVcIik7XG4gICAgcHJlLmNsYXNzTmFtZSA9XG4gICAgICBcIm0tMCBvdmVyZmxvdy1hdXRvIHJvdW5kZWQtbWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBwLTIgdGV4dC14cyB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIGNvbnN0IGNvZGUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiY29kZVwiKTtcbiAgICBjb2RlLnRleHRDb250ZW50ID0gY29kZUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgcHJlLmFwcGVuZENoaWxkKGNvZGUpO1xuICAgIHJvb3QuYXBwZW5kQ2hpbGQocHJlKTtcbiAgICBjb2RlTGluZXMgPSBudWxsO1xuICB9O1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGlmIChsaW5lLnRyaW0oKS5zdGFydHNXaXRoKFwiYGBgXCIpKSB7XG4gICAgICBpZiAoY29kZUxpbmVzKSBmbHVzaENvZGUoKTtcbiAgICAgIGVsc2Uge1xuICAgICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgICBmbHVzaExpc3QoKTtcbiAgICAgICAgY29kZUxpbmVzID0gW107XG4gICAgICB9XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNvZGVMaW5lcykge1xuICAgICAgY29kZUxpbmVzLnB1c2gobGluZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB0cmltbWVkID0gbGluZS50cmltKCk7XG4gICAgaWYgKCF0cmltbWVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCBoZWFkaW5nID0gL14oI3sxLDN9KVxccysoLispJC8uZXhlYyh0cmltbWVkKTtcbiAgICBpZiAoaGVhZGluZykge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoaGVhZGluZ1sxXS5sZW5ndGggPT09IDEgPyBcImgzXCIgOiBcImg0XCIpO1xuICAgICAgaC5jbGFzc05hbWUgPSBcIm0tMCB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBhcHBlbmRJbmxpbmVNYXJrZG93bihoLCBoZWFkaW5nWzJdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoaCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCB1bm9yZGVyZWQgPSAvXlstKl1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgY29uc3Qgb3JkZXJlZCA9IC9eXFxkK1suKV1cXHMrKC4rKSQvLmV4ZWModHJpbW1lZCk7XG4gICAgaWYgKHVub3JkZXJlZCB8fCBvcmRlcmVkKSB7XG4gICAgICBmbHVzaFBhcmFncmFwaCgpO1xuICAgICAgY29uc3Qgd2FudE9yZGVyZWQgPSBCb29sZWFuKG9yZGVyZWQpO1xuICAgICAgaWYgKCFsaXN0IHx8ICh3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiT0xcIikgfHwgKCF3YW50T3JkZXJlZCAmJiBsaXN0LnRhZ05hbWUgIT09IFwiVUxcIikpIHtcbiAgICAgICAgZmx1c2hMaXN0KCk7XG4gICAgICAgIGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KHdhbnRPcmRlcmVkID8gXCJvbFwiIDogXCJ1bFwiKTtcbiAgICAgICAgbGlzdC5jbGFzc05hbWUgPSB3YW50T3JkZXJlZFxuICAgICAgICAgID8gXCJtLTAgbGlzdC1kZWNpbWFsIHNwYWNlLXktMSBwbC01IGxlYWRpbmctNVwiXG4gICAgICAgICAgOiBcIm0tMCBsaXN0LWRpc2Mgc3BhY2UteS0xIHBsLTUgbGVhZGluZy01XCI7XG4gICAgICB9XG4gICAgICBjb25zdCBsaSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJsaVwiKTtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGxpLCAodW5vcmRlcmVkID8/IG9yZGVyZWQpPy5bMV0gPz8gXCJcIik7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGxpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHF1b3RlID0gL14+XFxzPyguKykkLy5leGVjKHRyaW1tZWQpO1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgZmx1c2hQYXJhZ3JhcGgoKTtcbiAgICAgIGZsdXNoTGlzdCgpO1xuICAgICAgY29uc3QgYmxvY2txdW90ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJibG9ja3F1b3RlXCIpO1xuICAgICAgYmxvY2txdW90ZS5jbGFzc05hbWUgPSBcIm0tMCBib3JkZXItbC0yIGJvcmRlci10b2tlbi1ib3JkZXIgcGwtMyBsZWFkaW5nLTVcIjtcbiAgICAgIGFwcGVuZElubGluZU1hcmtkb3duKGJsb2NrcXVvdGUsIHF1b3RlWzFdKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYmxvY2txdW90ZSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBwYXJhZ3JhcGgucHVzaCh0cmltbWVkKTtcbiAgfVxuXG4gIGZsdXNoUGFyYWdyYXBoKCk7XG4gIGZsdXNoTGlzdCgpO1xuICBmbHVzaENvZGUoKTtcbiAgcmV0dXJuIHJvb3Q7XG59XG5cbmZ1bmN0aW9uIGFwcGVuZElubGluZU1hcmtkb3duKHBhcmVudDogSFRNTEVsZW1lbnQsIHRleHQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBwYXR0ZXJuID0gLyhgKFteYF0rKWB8XFxbKFteXFxdXSspXFxdXFwoKGh0dHBzPzpcXC9cXC9bXlxccyldKylcXCl8XFwqXFwqKFteKl0rKVxcKlxcKnxcXCooW14qXSspXFwqKS9nO1xuICBsZXQgbGFzdEluZGV4ID0gMDtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgaWYgKG1hdGNoLmluZGV4ID09PSB1bmRlZmluZWQpIGNvbnRpbnVlO1xuICAgIGFwcGVuZFRleHQocGFyZW50LCB0ZXh0LnNsaWNlKGxhc3RJbmRleCwgbWF0Y2guaW5kZXgpKTtcbiAgICBpZiAobWF0Y2hbMl0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgY29kZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJjb2RlXCIpO1xuICAgICAgY29kZS5jbGFzc05hbWUgPVxuICAgICAgICBcInJvdW5kZWQgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tZm9yZWdyb3VuZC8xMCBweC0xIHB5LTAuNSB0ZXh0LXhzIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gbWF0Y2hbMl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoY29kZSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFszXSAhPT0gdW5kZWZpbmVkICYmIG1hdGNoWzRdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGEgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgICAgIGEuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSB1bmRlcmxpbmUgdW5kZXJsaW5lLW9mZnNldC0yXCI7XG4gICAgICBhLmhyZWYgPSBtYXRjaFs0XTtcbiAgICAgIGEudGFyZ2V0ID0gXCJfYmxhbmtcIjtcbiAgICAgIGEucmVsID0gXCJub29wZW5lciBub3JlZmVycmVyXCI7XG4gICAgICBhLnRleHRDb250ZW50ID0gbWF0Y2hbM107XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoYSk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs1XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBzdHJvbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3Ryb25nXCIpO1xuICAgICAgc3Ryb25nLmNsYXNzTmFtZSA9IFwiZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgICAgIHN0cm9uZy50ZXh0Q29udGVudCA9IG1hdGNoWzVdO1xuICAgICAgcGFyZW50LmFwcGVuZENoaWxkKHN0cm9uZyk7XG4gICAgfSBlbHNlIGlmIChtYXRjaFs2XSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJlbVwiKTtcbiAgICAgIGVtLnRleHRDb250ZW50ID0gbWF0Y2hbNl07XG4gICAgICBwYXJlbnQuYXBwZW5kQ2hpbGQoZW0pO1xuICAgIH1cbiAgICBsYXN0SW5kZXggPSBtYXRjaC5pbmRleCArIG1hdGNoWzBdLmxlbmd0aDtcbiAgfVxuICBhcHBlbmRUZXh0KHBhcmVudCwgdGV4dC5zbGljZShsYXN0SW5kZXgpKTtcbn1cblxuZnVuY3Rpb24gYXBwZW5kVGV4dChwYXJlbnQ6IEhUTUxFbGVtZW50LCB0ZXh0OiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHRleHQpIHBhcmVudC5hcHBlbmRDaGlsZChkb2N1bWVudC5jcmVhdGVUZXh0Tm9kZSh0ZXh0KSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGhDYXJkKGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtd2F0Y2hlci1oZWFsdGhcIilcbiAgICAudGhlbigoaGVhbHRoKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIHJlbmRlcldhdGNoZXJIZWFsdGgoY2FyZCwgaGVhbHRoIGFzIFdhdGNoZXJIZWFsdGgpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiQ291bGQgbm90IGNoZWNrIHdhdGNoZXJcIiwgU3RyaW5nKGUpKSk7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbmRlcldhdGNoZXJIZWFsdGgoXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBoZWFsdGg6IFdhdGNoZXJIZWFsdGgsXG4gIGluY2x1ZGVSZXBhaXIgPSBmYWxzZSxcbiAgb25SZXBhaXI/OiAoKSA9PiB2b2lkLFxuKTogdm9pZCB7XG4gIGNhcmQuYXBwZW5kQ2hpbGQod2F0Y2hlclN1bW1hcnlSb3coaGVhbHRoKSk7XG4gIGZvciAoY29uc3QgY2hlY2sgb2YgaGVhbHRoLmNoZWNrcykge1xuICAgIGlmIChjaGVjay5zdGF0dXMgPT09IFwib2tcIikgY29udGludWU7XG4gICAgY2FyZC5hcHBlbmRDaGlsZCh3YXRjaGVyQ2hlY2tSb3coY2hlY2spKTtcbiAgfVxuICBpZiAoaW5jbHVkZVJlcGFpcikge1xuICAgIGNvbnN0IHJvdyA9IGFjdGlvblJvdyhcbiAgICAgIFwiQXV0b21hdGljIG1haW50ZW5hbmNlXCIsXG4gICAgICBoZWFsdGguc3RhdHVzID09PSBcIm9rXCJcbiAgICAgICAgPyBcIlRoZSB3YXRjaGVyIGlzIGhlYWx0aHkgYW5kIHdpbGwgY29udGludWUgY2hlY2tpbmcgYXV0b21hdGljYWxseS5cIlxuICAgICAgICA6IFwiUmVwYWlyIHRoZSB3YXRjaGVyIHJlZ2lzdHJhdGlvbiBhbmQgcnVuIGEgZnJlc2ggaGVhbHRoIGNoZWNrLlwiLFxuICAgICk7XG4gICAgY29uc3QgYWN0aW9ucyA9IHJvdy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIltkYXRhLXR3ZWFrZXItcm93LWFjdGlvbnNdXCIpO1xuICAgIGFjdGlvbnM/LmFwcGVuZENoaWxkKGNvbXBhY3RCdXR0b24oXCJSZXBhaXIgTm93XCIsIG9uUmVwYWlyID8/ICgoKSA9PiB7XG4gICAgICBjb25zdCBidXR0b24gPSBhY3Rpb25zLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiYnV0dG9uXCIpO1xuICAgICAgaWYgKGJ1dHRvbikgYnV0dG9uLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZXBhaXItYXV0by1tYWludGVuYW5jZVwiKVxuICAgICAgICAudGhlbigoKSA9PiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC13YXRjaGVyLWhlYWx0aFwiKSlcbiAgICAgICAgLnRoZW4oKG5leHQpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIG5leHQgYXMgV2F0Y2hlckhlYWx0aCwgdHJ1ZSk7XG4gICAgICAgIH0pXG4gICAgICAgIC5jYXRjaCgoZXJyb3IpID0+IHtcbiAgICAgICAgICBjYXJkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICAgICAgICByZW5kZXJXYXRjaGVySGVhbHRoKGNhcmQsIHtcbiAgICAgICAgICAgIC4uLmhlYWx0aCxcbiAgICAgICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICAgICAgdGl0bGU6IFwiQXV0b21hdGljIG1haW50ZW5hbmNlIHJlcGFpciBmYWlsZWRcIixcbiAgICAgICAgICAgIHN1bW1hcnk6IHNhZmVVaUVycm9yKGVycm9yKSxcbiAgICAgICAgfSwgdHJ1ZSk7XG4gICAgICB9KTtcbiAgICB9KSkpO1xuICAgIGNhcmQuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxufVxuXG5mdW5jdGlvbiB3YXRjaGVyU3VtbWFyeVJvdyhoZWFsdGg6IFdhdGNoZXJIZWFsdGgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJvdy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtNCBwLTNcIjtcbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtc3RhcnQgZ2FwLTNcIjtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGF0dXNCYWRnZShoZWFsdGguc3RhdHVzLCBoZWFsdGgud2F0Y2hlcikpO1xuICBjb25zdCBzdGFjayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHN0YWNrLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSBoZWFsdGgudGl0bGU7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGAke2hlYWx0aC5zdW1tYXJ5fSBDaGVja2VkICR7bmV3IERhdGUoaGVhbHRoLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGUpO1xuICBzdGFjay5hcHBlbmRDaGlsZChkZXNjKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChzdGFjayk7XG4gIHJvdy5hcHBlbmRDaGlsZChsZWZ0KTtcblxuICBjb25zdCBhY3Rpb24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb24uY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBhY3Rpb24uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIkNoZWNrIE5vd1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjYXJkID0gcm93LnBhcmVudEVsZW1lbnQ7XG4gICAgICBpZiAoIWNhcmQpIHJldHVybjtcbiAgICAgIGNhcmQudGV4dENvbnRlbnQgPSBcIlwiO1xuICAgICAgY2FyZC5hcHBlbmRDaGlsZChyb3dTaW1wbGUoXCJDaGVja2luZyB3YXRjaGVyXCIsIFwiVmVyaWZ5aW5nIHRoZSB1cGRhdGVyIHJlcGFpciBzZXJ2aWNlLlwiKSk7XG4gICAgICByZW5kZXJXYXRjaGVySGVhbHRoQ2FyZChjYXJkKTtcbiAgICB9KSxcbiAgKTtcbiAgcm93LmFwcGVuZENoaWxkKGFjdGlvbik7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHdhdGNoZXJDaGVja1JvdyhjaGVjazogV2F0Y2hlckhlYWx0aENoZWNrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSByb3dTaW1wbGUoY2hlY2submFtZSwgY2hlY2suZGV0YWlsKTtcbiAgY29uc3QgbGVmdCA9IHJvdy5maXJzdEVsZW1lbnRDaGlsZCBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gIGlmIChsZWZ0KSBsZWZ0LnByZXBlbmQoc3RhdHVzQmFkZ2UoY2hlY2suc3RhdHVzKSk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0JhZGdlKHN0YXR1czogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIGxhYmVsPzogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBjb25zdCB0b25lID1cbiAgICBzdGF0dXMgPT09IFwib2tcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtZ3JlZW4gdGV4dC10b2tlbi1jaGFydHMtZ3JlZW5cIlxuICAgICAgOiBzdGF0dXMgPT09IFwid2FyblwiXG4gICAgICAgID8gXCJib3JkZXItdG9rZW4tY2hhcnRzLXllbGxvdyB0ZXh0LXRva2VuLWNoYXJ0cy15ZWxsb3dcIlxuICAgICAgICA6IFwiYm9yZGVyLXRva2VuLWNoYXJ0cy1yZWQgdGV4dC10b2tlbi1jaGFydHMtcmVkXCI7XG4gIGJhZGdlLmNsYXNzTmFtZSA9IGBpbmxpbmUtZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LXhzIGZvbnQtbWVkaXVtICR7dG9uZX1gO1xuICBiYWRnZS50ZXh0Q29udGVudCA9IGxhYmVsIHx8IChzdGF0dXMgPT09IFwib2tcIiA/IFwiT0tcIiA6IHN0YXR1cyA9PT0gXCJ3YXJuXCIgPyBcIlJldmlld1wiIDogXCJFcnJvclwiKTtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdW1tYXJ5KGNoZWNrOiBUd2Vha2VyVXBkYXRlQ2hlY2sgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKCFjaGVjaykgcmV0dXJuIFwiTm8gdXBkYXRlIGNoZWNrIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBsYXRlc3QgPSBjaGVjay5sYXRlc3RWZXJzaW9uID8gYExhdGVzdCB2JHtjaGVjay5sYXRlc3RWZXJzaW9ufS4gYCA6IFwiXCI7XG4gIGNvbnN0IGNoZWNrZWQgPSBgQ2hlY2tlZCAke25ldyBEYXRlKGNoZWNrLmNoZWNrZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX0uYDtcbiAgaWYgKGNoZWNrLmVycm9yKSByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH0gJHtjaGVjay5lcnJvcn1gO1xuICByZXR1cm4gYCR7bGF0ZXN0fSR7Y2hlY2tlZH1gO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVDaGFubmVsU3VtbWFyeShjb25maWc6IFR3ZWFrZXJDb25maWcpOiBzdHJpbmcge1xuICBpZiAoY29uZmlnLnVwZGF0ZUNoYW5uZWwgPT09IFwiY3VzdG9tXCIpIHtcbiAgICByZXR1cm4gYCR7Y29uZmlnLnVwZGF0ZVJlcG8gfHwgXCJ0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzXCJ9ICR7Y29uZmlnLnVwZGF0ZVJlZiB8fCBcIihubyByZWYgc2V0KVwifWA7XG4gIH1cbiAgaWYgKGNvbmZpZy51cGRhdGVDaGFubmVsID09PSBcInByZXJlbGVhc2VcIikge1xuICAgIHJldHVybiBcIlVzZSB0aGUgbmV3ZXN0IHB1Ymxpc2hlZCBHaXRIdWIgcmVsZWFzZSwgaW5jbHVkaW5nIHByZXJlbGVhc2VzLlwiO1xuICB9XG4gIHJldHVybiBcIlVzZSB0aGUgbGF0ZXN0IHN0YWJsZSBHaXRIdWIgcmVsZWFzZS5cIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN1bW1hcnkoc3RhdGU6IFNlbGZVcGRhdGVTdGF0ZSB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAoIXN0YXRlKSByZXR1cm4gXCJObyBhdXRvbWF0aWMgVHdlYWtlcnMgdXBkYXRlIGhhcyBydW4geWV0LlwiO1xuICBjb25zdCBjaGVja2VkID0gbmV3IERhdGUoc3RhdGUuY29tcGxldGVkQXQgPz8gc3RhdGUuY2hlY2tlZEF0KS50b0xvY2FsZVN0cmluZygpO1xuICBjb25zdCB0YXJnZXQgPSBzdGF0ZS5sYXRlc3RWZXJzaW9uID8gYCBUYXJnZXQgdiR7c3RhdGUubGF0ZXN0VmVyc2lvbn0uYCA6IHN0YXRlLnRhcmdldFJlZiA/IGAgVGFyZ2V0ICR7c3RhdGUudGFyZ2V0UmVmfS5gIDogXCJcIjtcbiAgY29uc3Qgc291cmNlID0gc3RhdGUuaW5zdGFsbGF0aW9uU291cmNlPy5sYWJlbCA/PyBcInVua25vd24gc291cmNlXCI7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwiZmFpbGVkXCIgJiYgLzQwNHxubyAoPzpwdWJsaXNoZWQgfGdpdGh1YiApP3JlbGVhc2UvaS50ZXN0KHN0YXRlLmVycm9yID8/IFwiXCIpKSByZXR1cm4gYFNvdXJjZSBjaGVja291dCBpcyBjdXJyZW50IGFzIG9mICR7Y2hlY2tlZH07IG5vIHB1Ymxpc2hlZCByZWxlYXNlIGV4aXN0cyB5ZXQuYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIGBVcGRhdGUgY2hlY2sgbmVlZHMgYXR0ZW50aW9uICgke2NoZWNrZWR9KS4gJHtzdGF0ZS5lcnJvciA/PyBcIlVua25vd24gZXJyb3JcIn1gO1xuICBpZiAoc3RhdGUuc3RhdHVzID09PSBcInVwZGF0ZWRcIikgcmV0dXJuIGBVcGRhdGVkICR7Y2hlY2tlZH0uJHt0YXJnZXR9IFNvdXJjZTogJHtzb3VyY2V9LmA7XG4gIGlmIChzdGF0ZS5zdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gYFVwIHRvIGRhdGUgJHtjaGVja2VkfS4ke3RhcmdldH0gU291cmNlOiAke3NvdXJjZX0uYDtcbiAgaWYgKHN0YXRlLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gYFNraXBwZWQgJHtjaGVja2VkfTsgYXV0b21hdGljIHJlZnJlc2ggaXMgZGlzYWJsZWQuYDtcbiAgcmV0dXJuIGBDaGVja2luZyBmb3IgdXBkYXRlcy4gU291cmNlOiAke3NvdXJjZX0uYDtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c1RvbmUoc3RhdHVzOiBTZWxmVXBkYXRlU3RhdHVzKTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIge1xuICBpZiAoc3RhdHVzID09PSBcImZhaWxlZFwiKSByZXR1cm4gXCJlcnJvclwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIgfHwgc3RhdHVzID09PSBcImNoZWNraW5nXCIpIHJldHVybiBcIndhcm5cIjtcbiAgcmV0dXJuIFwib2tcIjtcbn1cblxuZnVuY3Rpb24gc2VsZlVwZGF0ZVN0YXR1c0xhYmVsKHN0YXR1czogU2VsZlVwZGF0ZVN0YXR1cyk6IHN0cmluZyB7XG4gIGlmIChzdGF0dXMgPT09IFwidXAtdG8tZGF0ZVwiKSByZXR1cm4gXCJVcCB0byBkYXRlXCI7XG4gIGlmIChzdGF0dXMgPT09IFwidXBkYXRlZFwiKSByZXR1cm4gXCJVcGRhdGVkXCI7XG4gIGlmIChzdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcIkZhaWxlZFwiO1xuICBpZiAoc3RhdHVzID09PSBcImRpc2FibGVkXCIpIHJldHVybiBcIkRpc2FibGVkXCI7XG4gIHJldHVybiBcIkNoZWNraW5nXCI7XG59XG5cbmZ1bmN0aW9uIHJlZnJlc2hDb25maWdDYXJkKHJvdzogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgY2FyZCA9IHJvdy5jbG9zZXN0KFwiW2RhdGEtdHdlYWtlci1jb25maWctY2FyZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICBpZiAoIWNhcmQpIHJldHVybjtcbiAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gIGNhcmQuYXBwZW5kQ2hpbGQocm93U2ltcGxlKFwiUmVmcmVzaGluZ1wiLCBcIkxvYWRpbmcgY3VycmVudCBUd2Vha2VycyB1cGRhdGUgc3RhdHVzLlwiKSk7XG4gIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAuaW52b2tlKFwidHdlYWtlcjpnZXQtY29uZmlnXCIpXG4gICAgLnRoZW4oKGNvbmZpZykgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICByZW5kZXJUd2Vha2VyQ29uZmlnKGNhcmQsIGNvbmZpZyBhcyBUd2Vha2VyQ29uZmlnKTtcbiAgICB9KVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY2FyZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBjYXJkLmFwcGVuZENoaWxkKHJvd1NpbXBsZShcIkNvdWxkIG5vdCByZWZyZXNoIHVwZGF0ZSBzZXR0aW5nc1wiLCBTdHJpbmcoZSkpKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gdW5pbnN0YWxsUm93KCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gYWN0aW9uUm93KFxuICAgIFwiVW5pbnN0YWxsIFR3ZWFrZXJzXCIsXG4gICAgXCJDb3BpZXMgdGhlIHVuaW5zdGFsbCBjb21tYW5kLiBSdW4gaXQgZnJvbSBhIHRlcm1pbmFsIGFmdGVyIHF1aXR0aW5nIENvZGV4LlwiLFxuICApO1xuICBjb25zdCBhY3Rpb24gPSByb3cucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXJvdy1hY3Rpb25zXVwiKTtcbiAgYWN0aW9uPy5hcHBlbmRDaGlsZChcbiAgICBjb21wYWN0QnV0dG9uKFwiQ29weSBDb21tYW5kXCIsICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6Y29weS10ZXh0XCIsIFwibm9kZSB+Ly50d2Vha2VyL3NvdXJjZS9wYWNrYWdlcy9pbnN0YWxsZXIvZGlzdC9jbGkuanMgdW5pbnN0YWxsXCIpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNvcHkgdW5pbnN0YWxsIGNvbW1hbmQgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgIH0pLFxuICApO1xuICByZXR1cm4gcm93O1xufVxuXG5mdW5jdGlvbiByZXBvcnRCdWdSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBhY3Rpb25Sb3coXG4gICAgXCJSZXBvcnQgYSBidWdcIixcbiAgICBcIk9wZW4gYSBHaXRIdWIgaXNzdWUgd2l0aCBydW50aW1lLCBpbnN0YWxsZXIsIG9yIHR3ZWFrLW1hbmFnZXIgZGV0YWlscy5cIixcbiAgKTtcbiAgY29uc3QgYWN0aW9uID0gcm93LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1yb3ctYWN0aW9uc11cIik7XG4gIGFjdGlvbj8uYXBwZW5kQ2hpbGQoXG4gICAgY29tcGFjdEJ1dHRvbihcIk9wZW4gSXNzdWVcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGl0bGUgPSBlbmNvZGVVUklDb21wb25lbnQoXCJbQnVnXTogXCIpO1xuICAgICAgY29uc3QgYm9keSA9IGVuY29kZVVSSUNvbXBvbmVudChcbiAgICAgICAgW1xuICAgICAgICAgIFwiIyMgV2hhdCBoYXBwZW5lZD9cIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgU3RlcHMgdG8gcmVwcm9kdWNlXCIsXG4gICAgICAgICAgXCIxLiBcIixcbiAgICAgICAgICBcIlwiLFxuICAgICAgICAgIFwiIyMgRW52aXJvbm1lbnRcIixcbiAgICAgICAgICBcIi0gVHdlYWtlcnMgdmVyc2lvbjogXCIsXG4gICAgICAgICAgXCItIENvZGV4IGFwcCB2ZXJzaW9uOiBcIixcbiAgICAgICAgICBcIi0gT1M6IFwiLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICAgXCIjIyBMb2dzXCIsXG4gICAgICAgICAgXCJBdHRhY2ggcmVsZXZhbnQgbGluZXMgZnJvbSB0aGUgVHdlYWtlcnMgbG9nIGRpcmVjdG9yeS5cIixcbiAgICAgICAgXS5qb2luKFwiXFxuXCIpLFxuICAgICAgKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLFxuICAgICAgICBgaHR0cHM6Ly9naXRodWIuY29tL3RoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMvaXNzdWVzL25ldz90aXRsZT0ke3RpdGxlfSZib2R5PSR7Ym9keX1gLFxuICAgICAgKTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHJvdztcbn1cblxuZnVuY3Rpb24gYWN0aW9uUm93KHRpdGxlVGV4dDogc3RyaW5nLCBkZXNjcmlwdGlvbjogc3RyaW5nKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCByb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByb3cuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTQgcC0zXCI7XG4gIGNvbnN0IGxlZnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsZWZ0LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtY29sIGdhcC0xXCI7XG4gIGNvbnN0IHRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgdGl0bGUudGV4dENvbnRlbnQgPSB0aXRsZVRleHQ7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtaW4tdy0wIHRleHQtc21cIjtcbiAgZGVzYy50ZXh0Q29udGVudCA9IGRlc2NyaXB0aW9uO1xuICBsZWZ0LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgbGVmdC5hcHBlbmRDaGlsZChkZXNjKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5kYXRhc2V0LnR3ZWFrZXJSb3dBY3Rpb25zID0gXCJ0cnVlXCI7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICByb3cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG4gIHJldHVybiByb3c7XG59XG5cbmZ1bmN0aW9uIHJlbmRlclR3ZWFrU3RvcmVQYWdlKFxuICBzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50LFxuICBoZWFkZXJBY3Rpb25zPzogSFRNTEVsZW1lbnQsXG4pOiB2b2lkIHtcbiAgY29uc3Qgc2VjdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzZWN0aW9uXCIpO1xuICBzZWN0aW9uLmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtNFwiO1xuXG4gIGNvbnN0IHNvdXJjZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBzb3VyY2UuaGlkZGVuID0gdHJ1ZTtcbiAgc291cmNlLmRhdGFzZXQudHdlYWtlclN0b3JlU291cmNlID0gXCJ0cnVlXCI7XG4gIHNvdXJjZS50ZXh0Q29udGVudCA9IFwiTG9hZGluZyBsaXZlIHJlZ2lzdHJ5XCI7XG5cbiAgY29uc3QgYWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBjb25zdCByZWZyZXNoQnRuID0gc3RvcmVJY29uQnV0dG9uKHJlZnJlc2hJY29uU3ZnKCksIFwiUmVmcmVzaCB0d2VhayBzdG9yZVwiLCAoKSA9PiB7XG4gICAgcmVmcmVzaEJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgdXBkYXRlU3RvcmVVcGRhdGVCYWRnZShudWxsKTtcbiAgICBncmlkLnRleHRDb250ZW50ID0gXCJcIjtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICAgIHJlZnJlc2hUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UsIHJlZnJlc2hCdG4sIHRydWUpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyZWZyZXNoQnRuKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVRvb2xiYXJCdXR0b24oXCJQdWJsaXNoIFR3ZWFrXCIsIG9wZW5QdWJsaXNoVHdlYWtEaWFsb2csIFwicHJpbWFyeVwiKSk7XG4gIGlmIChoZWFkZXJBY3Rpb25zKSB7XG4gICAgaGVhZGVyQWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oYWN0aW9ucyk7XG4gIH1cblxuICBjb25zdCBncmlkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgZ3JpZC5kYXRhc2V0LnR3ZWFrZXJTdG9yZUdyaWQgPSBcInRydWVcIjtcbiAgZ3JpZC5jbGFzc05hbWUgPSBcImdyaWQgZ2FwLTRcIjtcbiAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHtcbiAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gSlNPTi5zdHJpbmdpZnkoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgcmVuZGVyVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlKTtcbiAgfSBlbHNlIHtcbiAgICByZW5kZXJUd2Vha1N0b3JlR2hvc3RHcmlkKGdyaWQpO1xuICB9XG4gIHNlY3Rpb24uYXBwZW5kQ2hpbGQoc291cmNlKTtcbiAgc2VjdGlvbi5hcHBlbmRDaGlsZChncmlkKTtcbiAgc2VjdGlvbnNXcmFwLmFwcGVuZENoaWxkKHNlY3Rpb24pO1xuICByZWZyZXNoVHdlYWtTdG9yZUdyaWQoZ3JpZCwgc291cmNlLCByZWZyZXNoQnRuKTtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKFxuICBncmlkOiBIVE1MRWxlbWVudCxcbiAgc291cmNlOiBIVE1MRWxlbWVudCxcbiAgcmVmcmVzaEJ0bj86IEhUTUxCdXR0b25FbGVtZW50LFxuICBmb3JjZSA9IGZhbHNlLFxuKTogdm9pZCB7XG4gIHZvaWQgZ2V0VHdlYWtTdG9yZShmb3JjZSlcbiAgICAudGhlbigoc3RvcmUpID0+IHtcbiAgICAgIGdyaWQuZGF0YXNldC50d2Vha2VyU3RvcmUgPSBKU09OLnN0cmluZ2lmeShzdG9yZSk7XG4gICAgICByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkLCBzb3VyY2UpO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlID0gXCJcIjtcbiAgICAgIGdyaWQucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICAgICAgc291cmNlLnRleHRDb250ZW50ID0gXCJMaXZlIHJlZ2lzdHJ5IHVuYXZhaWxhYmxlXCI7XG4gICAgICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG51bGwpO1xuICAgICAgZ3JpZC50ZXh0Q29udGVudCA9IFwiXCI7XG4gICAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJDb3VsZCBub3QgbG9hZCB0d2VhayBzdG9yZVwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChyZWZyZXNoQnRuKSByZWZyZXNoQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgfSk7XG59XG5cbmZ1bmN0aW9uIHdhcm1Ud2Vha1N0b3JlKCk6IHZvaWQge1xuICBpZiAoc3RhdGUudHdlYWtTdG9yZSB8fCBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSkgcmV0dXJuO1xuICB2b2lkIGdldFR3ZWFrU3RvcmUoKS50aGVuKChzdG9yZSkgPT4ge1xuICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2Uob3V0ZGF0ZWRJbnN0YWxsZWRTdG9yZUNvdW50KHN0b3JlLmVudHJpZXMpKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGdldFR3ZWFrU3RvcmUoZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8VHdlYWtTdG9yZVJlZ2lzdHJ5Vmlldz4ge1xuICBpZiAoIWZvcmNlKSB7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmUpIHJldHVybiBQcm9taXNlLnJlc29sdmUoc3RhdGUudHdlYWtTdG9yZSk7XG4gICAgaWYgKHN0YXRlLnR3ZWFrU3RvcmVQcm9taXNlKSByZXR1cm4gc3RhdGUudHdlYWtTdG9yZVByb21pc2U7XG4gIH1cbiAgc3RhdGUudHdlYWtTdG9yZUVycm9yID0gbnVsbDtcbiAgY29uc3QgcHJvbWlzZSA9IGlwY1JlbmRlcmVyXG4gICAgLmludm9rZShcInR3ZWFrZXI6Z2V0LXR3ZWFrLXN0b3JlXCIpXG4gICAgLnRoZW4oKHN0b3JlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlID0gc3RvcmUgYXMgVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldztcbiAgICAgIHJldHVybiBzdGF0ZS50d2Vha1N0b3JlO1xuICAgIH0pXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBzdGF0ZS50d2Vha1N0b3JlRXJyb3IgPSBlO1xuICAgICAgdGhyb3cgZTtcbiAgICB9KVxuICAgIC5maW5hbGx5KCgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9PT0gcHJvbWlzZSkgc3RhdGUudHdlYWtTdG9yZVByb21pc2UgPSBudWxsO1xuICAgIH0pO1xuICBzdGF0ZS50d2Vha1N0b3JlUHJvbWlzZSA9IHByb21pc2U7XG4gIHJldHVybiBwcm9taXNlO1xufVxuXG5mdW5jdGlvbiByZW5kZXJUd2Vha1N0b3JlR3JpZChncmlkOiBIVE1MRWxlbWVudCwgc291cmNlOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBzdG9yZSA9IHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQpO1xuICBpZiAoIXN0b3JlKSByZXR1cm47XG4gIGNvbnN0IGVudHJpZXMgPSBzdG9yZS5lbnRyaWVzO1xuICBncmlkLnJlbW92ZUF0dHJpYnV0ZShcImFyaWEtYnVzeVwiKTtcbiAgc291cmNlLnRleHRDb250ZW50ID0gYFJlZnJlc2hlZCAke25ldyBEYXRlKHN0b3JlLmZldGNoZWRBdCkudG9Mb2NhbGVTdHJpbmcoKX1gO1xuICB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzKSk7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBpZiAoc3RvcmUuZW50cmllcy5sZW5ndGggPT09IDApIHtcbiAgICBncmlkLmFwcGVuZENoaWxkKHN0b3JlTWVzc2FnZUNhcmQoXCJObyB0d2Vha3MgeWV0XCIsIFwiVXNlIFB1Ymxpc2ggVHdlYWsgdG8gc3VibWl0IHRoZSBmaXJzdCBvbmUuXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBlbnRyaWVzKSBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVDYXJkKGVudHJ5KSk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlU3RvcmVEYXRhc2V0KGdyaWQ6IEhUTUxFbGVtZW50KTogVHdlYWtTdG9yZVJlZ2lzdHJ5VmlldyB8IG51bGwge1xuICBjb25zdCByYXcgPSBncmlkLmRhdGFzZXQudHdlYWtlclN0b3JlO1xuICBpZiAoIXJhdykgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBUd2Vha1N0b3JlUmVnaXN0cnlWaWV3O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlQ2FyZChlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgc2hlbGwgPSB0d2Vha1N0b3JlQ2FyZFNoZWxsKCk7XG4gIGNvbnN0IHsgY2FyZCwgbGVmdCwgc3RhY2ssIHZlcnNpb25zLCBhY3Rpb25zIH0gPSBzaGVsbDtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhcihlbnRyeSksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKHRpdGxlKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodmVyaWZpZWRTYWZlQmFkZ2UoKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHRpdGxlUm93KTtcblxuICBpZiAoZW50cnkubWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjID0gdHdlYWtTdG9yZURlc2NyaXB0aW9uKCk7XG4gICAgZGVzYy50ZXh0Q29udGVudCA9IGVudHJ5Lm1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2MpO1xuICB9XG5cbiAgc3RhY2suYXBwZW5kQ2hpbGQodHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKGVudHJ5LnJlcG8gPz8gZW50cnkubWFuaWZlc3QuZ2l0aHViUmVwbykpO1xuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZCh0d2Vha1N0b3JlVmVyc2lvbkJhZGdlKGVudHJ5KSk7XG5cbiAgaWYgKGVudHJ5LnJlbGVhc2VVcmwpIHtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKFxuICAgICAgY29tcGFjdEJ1dHRvbihcIlJlbGVhc2VcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBlbnRyeS5yZWxlYXNlVXJsKTtcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cbiAgY29uc3QgaGFzVXBkYXRlID0gISFlbnRyeS5pbnN0YWxsZWQgJiYgZW50cnkuaW5zdGFsbGVkLnZlcnNpb24gIT09IGVudHJ5Lm1hbmlmZXN0LnZlcnNpb247XG4gIGlmIChlbnRyeS5hdmFpbGFibGUgPT09IGZhbHNlKSB7XG4gICAgY2FyZC5jbGFzc0xpc3QuYWRkKFwib3BhY2l0eS03MFwiKTtcbiAgICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIk5vdCBhdmFpbGFibGUgeWV0XCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5pbnN0YWxsZWQgJiYgIWhhc1VwZGF0ZSkge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5wbGF0Zm9ybSAmJiAhZW50cnkucGxhdGZvcm0uY29tcGF0aWJsZSkge1xuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcIm9wYWNpdHktNzBcIik7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdG9yZVN0YXR1c1BpbGwocGxhdGZvcm1Mb2NrZWRMYWJlbChlbnRyeS5wbGF0Zm9ybSkpKTtcbiAgfSBlbHNlIGlmIChlbnRyeS5ydW50aW1lICYmICFlbnRyeS5ydW50aW1lLmNvbXBhdGlibGUpIHtcbiAgICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJvcGFjaXR5LTcwXCIpO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKHJ1bnRpbWVMb2NrZWRMYWJlbChlbnRyeS5ydW50aW1lKSkpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGluc3RhbGxMYWJlbCA9IGVudHJ5Lmluc3RhbGxlZCA/IFwiVXBkYXRlXCIgOiBcIkluc3RhbGxcIjtcbiAgICBpZiAoaGFzVXBkYXRlKSBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzUGlsbChcIlVwZGF0ZSBhdmFpbGFibGVcIiwgXCJpbmZvXCIpKTtcbiAgICBjb25zdCBpbnN0YWxsQnV0dG9uID0gc3RvcmVJbnN0YWxsQnV0dG9uKGluc3RhbGxMYWJlbCwgKGJ1dHRvbikgPT4ge1xuICAgICAgY29uc3QgZ3JpZCA9IGNhcmQuY2xvc2VzdChcIltkYXRhLXR3ZWFrZXItc3RvcmUtZ3JpZF1cIikgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xuICAgICAgY29uc3Qgc291cmNlID0gZ3JpZD8ucGFyZW50RWxlbWVudD8ucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtc291cmNlXVwiKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XG4gICAgICBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbiwgZW50cnkuaW5zdGFsbGVkID8gXCJVcGRhdGluZ1wiIDogXCJJbnN0YWxsaW5nXCIpO1xuICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IHRydWUpKTtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBlbnRyeS5pZClcbiAgICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICAgIHNob3dTdG9yZVRvYXN0KGAke2VudHJ5Lm1hbmlmZXN0Lm5hbWV9IGluc3RhbGxlZC5gKTtcbiAgICAgICAgICBzaG93U3RvcmVCdXR0b25JbnN0YWxsZWQoYnV0dG9uKTtcbiAgICAgICAgICB2ZXJzaW9ucy5yZXBsYWNlQ2hpbGRyZW4odHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeSwgZW50cnkubWFuaWZlc3QudmVyc2lvbikpO1xuICAgICAgICAgIHVwZGF0ZVN0b3JlVXBkYXRlQmFkZ2UoTWF0aC5tYXgoMCwgY3VycmVudFN0b3JlVXBkYXRlQmFkZ2VDb3VudCgpIC0gMSkpO1xuICAgICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgICAgYWN0aW9ucy5yZXBsYWNlQ2hpbGRyZW4oc3RvcmVTdGF0dXNQaWxsKFwiSW5zdGFsbGVkXCIpKTtcbiAgICAgICAgICAgIGlmIChncmlkICYmIHNvdXJjZSkgcmVmcmVzaFR3ZWFrU3RvcmVHcmlkKGdyaWQsIHNvdXJjZSwgdW5kZWZpbmVkLCB0cnVlKTtcbiAgICAgICAgICB9LCA5MDApO1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgICAgICByZXNldFN0b3JlSW5zdGFsbEJ1dHRvbihidXR0b24sIGluc3RhbGxMYWJlbCk7XG4gICAgICAgICAgYWN0aW9ucy5xdWVyeVNlbGVjdG9yQWxsKFwiYnV0dG9uXCIpLmZvckVhY2goKGJ1dHRvbikgPT4gKGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlKSk7XG4gICAgICAgICAgc2hvd1N0b3JlQ2FyZE1lc3NhZ2UoY2FyZCwgU3RyaW5nKChlIGFzIEVycm9yKS5tZXNzYWdlID8/IGUpKTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZChpbnN0YWxsQnV0dG9uKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gcGxhdGZvcm1Mb2NrZWRMYWJlbChwbGF0Zm9ybTogTm9uTnVsbGFibGU8VHdlYWtTdG9yZUVudHJ5Vmlld1tcInBsYXRmb3JtXCJdPik6IHN0cmluZyB7XG4gIGNvbnN0IHN1cHBvcnRlZCA9IHBsYXRmb3JtLnN1cHBvcnRlZCA/PyBbXTtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcIndpbjMyXCIpKSByZXR1cm4gXCJXaW5kb3dzIG9ubHlcIjtcbiAgaWYgKHN1cHBvcnRlZC5pbmNsdWRlcyhcImRhcndpblwiKSkgcmV0dXJuIFwibWFjT1Mgb25seVwiO1xuICBpZiAoc3VwcG9ydGVkLmluY2x1ZGVzKFwibGludXhcIikpIHJldHVybiBcIkxpbnV4IG9ubHlcIjtcbiAgcmV0dXJuIFwiVW5hdmFpbGFibGVcIjtcbn1cblxuZnVuY3Rpb24gcnVudGltZUxvY2tlZExhYmVsKHJ1bnRpbWU6IE5vbk51bGxhYmxlPFR3ZWFrU3RvcmVFbnRyeVZpZXdbXCJydW50aW1lXCJdPik6IHN0cmluZyB7XG4gIHJldHVybiBydW50aW1lLnJlcXVpcmVkID8gYFJlcXVpcmVzIFR3ZWFrZXJzICR7cnVudGltZS5yZXF1aXJlZH1gIDogXCJSZXF1aXJlcyBuZXdlciBUd2Vha2Vyc1wiO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVDYXJkTWVzc2FnZShjYXJkOiBIVE1MRWxlbWVudCwgbWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGNhcmQucXVlcnlTZWxlY3RvcihcIltkYXRhLXR3ZWFrZXItc3RvcmUtY2FyZC1tZXNzYWdlXVwiKT8ucmVtb3ZlKCk7XG4gIGNvbnN0IG5vdGljZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5vdGljZS5kYXRhc2V0LnR3ZWFrZXJTdG9yZUNhcmRNZXNzYWdlID0gXCJ0cnVlXCI7XG4gIG5vdGljZS5jbGFzc05hbWUgPVxuICAgIFwicm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci81MCBiZy10b2tlbi1mb3JlZ3JvdW5kLzUgcHgtMyBweS0yIHRleHQtc20gbGVhZGluZy01IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiO1xuICBub3RpY2UudGV4dENvbnRlbnQgPSBtZXNzYWdlO1xuICBjb25zdCBhY3Rpb25zID0gY2FyZC5sYXN0RWxlbWVudENoaWxkO1xuICBpZiAoYWN0aW9ucykgY2FyZC5pbnNlcnRCZWZvcmUobm90aWNlLCBhY3Rpb25zKTtcbiAgZWxzZSBjYXJkLmFwcGVuZENoaWxkKG5vdGljZSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVDYXJkU2hlbGwoKToge1xuICBjYXJkOiBIVE1MRWxlbWVudDtcbiAgbGVmdDogSFRNTEVsZW1lbnQ7XG4gIHN0YWNrOiBIVE1MRWxlbWVudDtcbiAgdmVyc2lvbnM6IEhUTUxFbGVtZW50O1xuICBhY3Rpb25zOiBIVE1MRWxlbWVudDtcbn0ge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlci80MCBmbGV4IG1pbi1oLVsxOTBweF0gZmxleC1jb2wganVzdGlmeS1iZXR3ZWVuIGdhcC00IHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdHJhbnNpdGlvbi1jb2xvcnMgaG92ZXI6YmctdG9rZW4tZm9yZWdyb3VuZC81XCI7XG5cbiAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGxlZnQuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLXN0YXJ0IGdhcC0zXCI7XG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0yXCI7XG4gIGxlZnQuYXBwZW5kQ2hpbGQoc3RhY2spO1xuICBjYXJkLmFwcGVuZENoaWxkKGxlZnQpO1xuXG4gIGNvbnN0IGZvb3RlciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGZvb3Rlci5jbGFzc05hbWUgPSBcIm10LWF1dG8gZmxleCBtaW4tdy0wIGZsZXgtd3JhcCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yXCI7XG4gIGNvbnN0IHZlcnNpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdmVyc2lvbnMuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBmb290ZXIuYXBwZW5kQ2hpbGQodmVyc2lvbnMpO1xuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGZvb3Rlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcbiAgY2FyZC5hcHBlbmRDaGlsZChmb290ZXIpO1xuXG4gIHJldHVybiB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0b3JlVGl0bGVSb3coKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB0aXRsZVJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlUm93LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGRlc2MgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBkZXNjLmNsYXNzTmFtZSA9IFwibGluZS1jbGFtcC0zIG1pbi13LTAgdGV4dC1zbSBsZWFkaW5nLTUgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeVwiO1xuICByZXR1cm4gZGVzYztcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVJlYWRNb3JlQnV0dG9uKHJlcG86IHN0cmluZyk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgcmVhZE1vcmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICByZWFkTW9yZS50eXBlID0gXCJidXR0b25cIjtcbiAgcmVhZE1vcmUuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IHctZml0IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1saW5rLWZvcmVncm91bmQgaG92ZXI6dW5kZXJsaW5lXCI7XG4gIHJlYWRNb3JlLmlubmVySFRNTCA9XG4gICAgYFJlYWQgTW9yZWAgK1xuICAgIGA8c3ZnIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTYgMy41aDYuNVYxME0xMi4yNSAzLjc1IDQgMTJcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjQ1XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICByZWFkTW9yZS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb31gKTtcbiAgfSk7XG4gIHJldHVybiByZWFkTW9yZTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtTdG9yZUdob3N0R3JpZChncmlkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBncmlkLnNldEF0dHJpYnV0ZShcImFyaWEtYnVzeVwiLCBcInRydWVcIik7XG4gIGdyaWQudGV4dENvbnRlbnQgPSBcIlwiO1xuICBncmlkLmFwcGVuZENoaWxkKHR3ZWFrU3RvcmVHaG9zdENhcmQoKSk7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrU3RvcmVHaG9zdENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCB7IGNhcmQsIGxlZnQsIHN0YWNrLCB2ZXJzaW9ucywgYWN0aW9ucyB9ID0gdHdlYWtTdG9yZUNhcmRTaGVsbCgpO1xuICBjYXJkLmNsYXNzTGlzdC5hZGQoXCJwb2ludGVyLWV2ZW50cy1ub25lXCIpO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcblxuICBsZWZ0Lmluc2VydEJlZm9yZShzdG9yZUF2YXRhckdob3N0KCksIHN0YWNrKTtcblxuICBjb25zdCB0aXRsZVJvdyA9IHR3ZWFrU3RvcmVUaXRsZVJvdygpO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LWxnIGZvbnQtc2VtaWJvbGQgbGVhZGluZy03IHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiO1xuICB0aXRsZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwibXktMSBoLTUgdy00NCByb3VuZGVkLW1kXCIpKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGUpO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJpZmllZFNhZmVHaG9zdEJhZGdlKCkpO1xuICBzdGFjay5hcHBlbmRDaGlsZCh0aXRsZVJvdyk7XG5cbiAgY29uc3QgZGVzYyA9IHR3ZWFrU3RvcmVEZXNjcmlwdGlvbigpO1xuICBkZXNjLmFwcGVuZENoaWxkKGdob3N0QmxvY2soXCJtdC0xIGgtMyB3LWZ1bGwgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctMTEvMTIgcm91bmRlZFwiKSk7XG4gIGRlc2MuYXBwZW5kQ2hpbGQoZ2hvc3RCbG9jayhcIm10LTIgaC0zIHctNy8xMiByb3VuZGVkXCIpKTtcbiAgc3RhY2suYXBwZW5kQ2hpbGQoZGVzYyk7XG5cbiAgY29uc3QgcmVhZE1vcmUgPSB0d2Vha1N0b3JlUmVhZE1vcmVCdXR0b24oXCJcIik7XG4gIHJlYWRNb3JlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC01IHctMjQgcm91bmRlZFwiKSk7XG4gIHN0YWNrLmFwcGVuZENoaWxkKHJlYWRNb3JlKTtcblxuICB2ZXJzaW9ucy5hcHBlbmRDaGlsZChzdG9yZVZlcnNpb25HaG9zdEJhZGdlKCkpO1xuICBhY3Rpb25zLmFwcGVuZENoaWxkKHN0b3JlU3RhdHVzR2hvc3RQaWxsKCkpO1xuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc3RvcmVBdmF0YXJHaG9zdCgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGF2YXRhci5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTEwIHctMTAgc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLWRlZmF1bHQgYmctdHJhbnNwYXJlbnQgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kXCI7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC1mdWxsIHctZnVsbFwiKSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHZlcmlmaWVkU2FmZUJhZGdlKCk7XG4gIGJhZGdlLnJlcGxhY2VDaGlsZHJlbihnaG9zdEJsb2NrKFwiaC1bMTNweF0gdy1bMTNweF0gcm91bmRlZC1zbVwiKSwgZ2hvc3RCbG9jayhcImgtMyB3LTIwIHJvdW5kZWRcIikpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzR2hvc3RQaWxsKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgcGlsbCA9IHN0b3JlU3RhdHVzUGlsbChcIkluc3RhbGxlZFwiKTtcbiAgcGlsbC5jbGFzc0xpc3QuYWRkKFwiYW5pbWF0ZS1wdWxzZVwiKTtcbiAgcGlsbC5zdHlsZS5jb2xvciA9IFwidHJhbnNwYXJlbnRcIjtcbiAgcmV0dXJuIHBpbGw7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkdob3N0QmFkZ2UoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoZmFsc2UpO1xuICBiYWRnZS5hcHBlbmRDaGlsZChnaG9zdEJsb2NrKFwiaC0zIHctMzYgcm91bmRlZFwiKSk7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gZ2hvc3RCbG9jayhjbGFzc05hbWU6IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmxvY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBibG9jay5jbGFzc05hbWUgPSBgYW5pbWF0ZS1wdWxzZSBiZy10b2tlbi1mb3JlZ3JvdW5kLzEwICR7Y2xhc3NOYW1lfWA7XG4gIGJsb2NrLnNldEF0dHJpYnV0ZShcImFyaWEtaGlkZGVuXCIsIFwidHJ1ZVwiKTtcbiAgcmV0dXJuIGJsb2NrO1xufVxuXG5mdW5jdGlvbiBzdG9yZUF2YXRhcihlbnRyeTogVHdlYWtTdG9yZUVudHJ5Vmlldyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYXZhdGFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYXZhdGFyLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtMTAgdy0xMCBzaHJpbmstMCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgb3ZlcmZsb3ctaGlkZGVuIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXItZGVmYXVsdCBiZy10cmFuc3BhcmVudCB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgY29uc3QgaW5pdGlhbCA9IChlbnRyeS5tYW5pZmVzdC5uYW1lPy5bMF0gPz8gXCI/XCIpLnRvVXBwZXJDYXNlKCk7XG4gIGNvbnN0IGZhbGxiYWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGZhbGxiYWNrLnRleHRDb250ZW50ID0gaW5pdGlhbDtcbiAgYXZhdGFyLmFwcGVuZENoaWxkKGZhbGxiYWNrKTtcbiAgY29uc3QgaWNvblVybCA9IHN0b3JlRW50cnlJY29uVXJsKGVudHJ5KTtcbiAgaWYgKGljb25VcmwpIHtcbiAgICBjb25zdCBpbWcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiaW1nXCIpO1xuICAgIGltZy5hbHQgPSBcIlwiO1xuICAgIGltZy5jbGFzc05hbWUgPSBcImgtZnVsbCB3LWZ1bGwgb2JqZWN0LWNvdmVyXCI7XG4gICAgaW1nLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICBpbWcuYWRkRXZlbnRMaXN0ZW5lcihcImxvYWRcIiwgKCkgPT4ge1xuICAgICAgZmFsbGJhY2sucmVtb3ZlKCk7XG4gICAgICBpbWcuc3R5bGUuZGlzcGxheSA9IFwiXCI7XG4gICAgfSk7XG4gICAgaW1nLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiB7XG4gICAgICBpbWcucmVtb3ZlKCk7XG4gICAgfSk7XG4gICAgaW1nLnNyYyA9IGljb25Vcmw7XG4gICAgYXZhdGFyLmFwcGVuZENoaWxkKGltZyk7XG4gIH1cbiAgcmV0dXJuIGF2YXRhcjtcbn1cblxuZnVuY3Rpb24gc3RvcmVFbnRyeUljb25VcmwoZW50cnk6IFR3ZWFrU3RvcmVFbnRyeVZpZXcpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgaWNvblVybCA9IGVudHJ5Lm1hbmlmZXN0Lmljb25Vcmw/LnRyaW0oKTtcbiAgaWYgKCFpY29uVXJsKSByZXR1cm4gbnVsbDtcbiAgaWYgKC9eKGh0dHBzPzp8ZGF0YTopL2kudGVzdChpY29uVXJsKSkgcmV0dXJuIGljb25Vcmw7XG4gIGNvbnN0IHJlbCA9IGljb25VcmwucmVwbGFjZSgvXlxcLj9cXC8vLCBcIlwiKTtcbiAgaWYgKCFyZWwgfHwgcmVsLnN0YXJ0c1dpdGgoXCIuLi9cIikpIHJldHVybiBudWxsO1xuICBpZiAoZW50cnkuc291cmNlPy5raW5kID09PSBcImJ1bmRsZWRcIiB8fCAhZW50cnkucmVwbyB8fCAhZW50cnkuYXBwcm92ZWRDb21taXRTaGEpIHJldHVybiBudWxsO1xuICByZXR1cm4gYGh0dHBzOi8vcmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbS8ke2VudHJ5LnJlcG99LyR7ZW50cnkuYXBwcm92ZWRDb21taXRTaGF9LyR7cmVsfWA7XG59XG5cbmZ1bmN0aW9uIHNpZGViYXJVcGRhdGVQaWxsQnV0dG9uKCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uZGF0YXNldC50d2Vha2VyU2lkZWJhclVwZGF0ZSA9IFwidHJ1ZVwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcInVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gaW5saW5lLWZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtZnVsbCBiZy10b2tlbi1jaGFydHMtYmx1ZSB0ZXh0LXdoaXRlIGhvdmVyOmJnLXRva2VuLWNoYXJ0cy1ibHVlLzgwXCI7XG4gIE9iamVjdC5hc3NpZ24oYnRuLnN0eWxlLCB7XG4gICAgZGlzcGxheTogXCJub25lXCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgOHB4XCIsXG4gICAgZm9udFNpemU6IFwiMTBweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gICAgdGV4dFRyYW5zZm9ybTogXCJub25lXCIsXG4gIH0pO1xuICBidG4udGV4dENvbnRlbnQgPSBcIlVwZGF0ZVwiO1xuICBidG4udGl0bGUgPSBcIk9wZW4gVHdlYWtlcnMgdXBkYXRlXCI7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBidG4uZGF0YXNldC50d2Vha2VyUmVsZWFzZVVybCB8fCBUV0VBS0VSU19SRUxFQVNFU19VUkwpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaFNpZGViYXJUd2Vha2VyVXBkYXRlQnV0dG9uKGZvcmNlID0gZmFsc2UpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgdm9pZCBpcGNSZW5kZXJlclxuICAgIC5pbnZva2UoXCJ0d2Vha2VyOmNoZWNrLXR3ZWFrZXItdXBkYXRlXCIsIGZvcmNlKVxuICAgIC50aGVuKChjaGVjaykgPT4gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2sgYXMgVHdlYWtlclVwZGF0ZUNoZWNrKSlcbiAgICAuY2F0Y2goKGUpID0+IHtcbiAgICAgIHBsb2coXCJUd2Vha2VycyBzaWRlYmFyIHJlbGVhc2UgY2hlY2sgZmFpbGVkXCIsIFN0cmluZyhlKSk7XG4gICAgICBzZXRTaWRlYmFyVHdlYWtlclVwZGF0ZUJ1dHRvbihudWxsKTtcbiAgICB9KTtcbn1cblxuZnVuY3Rpb24gc2V0U2lkZWJhclR3ZWFrZXJVcGRhdGVCdXR0b24oY2hlY2s6IFR3ZWFrZXJVcGRhdGVDaGVjayB8IG51bGwpOiB2b2lkIHtcbiAgY29uc3QgYnRuID0gc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbjtcbiAgaWYgKCFidG4pIHJldHVybjtcbiAgY29uc3QgdXBkYXRlQXZhaWxhYmxlID0gY2hlY2s/LnVwZGF0ZUF2YWlsYWJsZSA9PT0gdHJ1ZTtcbiAgYnRuLnN0eWxlLmRpc3BsYXkgPSB1cGRhdGVBdmFpbGFibGUgPyBcImlubGluZS1mbGV4XCIgOiBcIm5vbmVcIjtcbiAgYnRuLmhpZGRlbiA9ICF1cGRhdGVBdmFpbGFibGU7XG4gIGJ0bi5kYXRhc2V0LnR3ZWFrZXJSZWxlYXNlVXJsID0gY2hlY2s/LnJlbGVhc2VVcmwgfHwgVFdFQUtFUlNfUkVMRUFTRVNfVVJMO1xuICBidG4udGl0bGUgPVxuICAgIHVwZGF0ZUF2YWlsYWJsZSAmJiBjaGVjaz8ubGF0ZXN0VmVyc2lvblxuICAgICAgPyBgT3BlbiBUd2Vha2VycyAke2NoZWNrLmxhdGVzdFZlcnNpb259IHVwZGF0ZWBcbiAgICAgIDogXCJPcGVuIFR3ZWFrZXJzIHVwZGF0ZVwiO1xufVxuXG5mdW5jdGlvbiB1cGRhdGVTdG9yZVVwZGF0ZUJhZGdlKGNvdW50OiBudW1iZXIgfCBudWxsKTogdm9pZCB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGlmICghYmFkZ2UpIHJldHVybjtcbiAgYmFkZ2UuZGF0YXNldC50d2Vha2VyU3RvcmVVcGRhdGVDb3VudCA9IGNvdW50ID09PSBudWxsID8gXCJcIiA6IFN0cmluZyhjb3VudCk7XG4gIGFwcGx5U3RvcmVVcGRhdGVCYWRnZVN0eWxlKGJhZGdlLCBjb3VudCk7XG4gIGJhZGdlLmhpZGRlbiA9IGNvdW50ID09PSBudWxsIHx8IGNvdW50IDw9IDA7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gY291bnQgJiYgY291bnQgPiAwID8gU3RyaW5nKGNvdW50KSA6IFwiXCI7XG4gIGJhZGdlLnRpdGxlID1cbiAgICBjb3VudCAmJiBjb3VudCA+IDBcbiAgICAgID8gYCR7Y291bnR9IGluc3RhbGxlZCB0d2VhayR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGNhbiBiZSB1cGRhdGVkYFxuICAgICAgOiBcIkluc3RhbGxlZCB0d2Vha3MgYXJlIHVwIHRvIGRhdGVcIjtcbn1cblxuZnVuY3Rpb24gYXBwbHlTdG9yZVVwZGF0ZUJhZGdlU3R5bGUoYmFkZ2U6IEhUTUxFbGVtZW50LCBjb3VudDogbnVtYmVyIHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCBoYXNVcGRhdGVzID0gISFjb3VudCAmJiBjb3VudCA+IDA7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiLCBoYXNVcGRhdGVzKTtcbiAgYmFkZ2UuY2xhc3NMaXN0LnRvZ2dsZShcInRleHQtd2hpdGVcIiwgaGFzVXBkYXRlcyk7XG4gIGJhZGdlLmNsYXNzTGlzdC50b2dnbGUoXCJiZy10cmFuc3BhcmVudFwiLCAhaGFzVXBkYXRlcyk7XG4gIE9iamVjdC5hc3NpZ24oYmFkZ2Uuc3R5bGUsIHtcbiAgICBtaW5XaWR0aDogXCIyNHB4XCIsXG4gICAgaGVpZ2h0OiBcIjIwcHhcIixcbiAgICBib3JkZXJSYWRpdXM6IFwiOTk5OXB4XCIsXG4gICAgYm9yZGVyOiBcIjBcIixcbiAgICBwYWRkaW5nOiBcIjAgN3B4XCIsXG4gICAgZm9udFNpemU6IFwiMTJweFwiLFxuICAgIGZvbnRXZWlnaHQ6IFwiNzAwXCIsXG4gICAgbGluZUhlaWdodDogXCIyMHB4XCIsXG4gICAgbGV0dGVyU3BhY2luZzogXCIwXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjdXJyZW50U3RvcmVVcGRhdGVCYWRnZUNvdW50KCk6IG51bWJlciB7XG4gIGNvbnN0IGJhZGdlID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXVwZGF0ZS1iYWRnZV1cIik7XG4gIGNvbnN0IHJhdyA9IGJhZGdlPy5kYXRhc2V0LnR3ZWFrZXJTdG9yZVVwZGF0ZUNvdW50O1xuICBjb25zdCBwYXJzZWQgPSByYXcgPyBOdW1iZXIocmF3KSA6IDA7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGFyc2VkKSA/IHBhcnNlZCA6IDA7XG59XG5cbmZ1bmN0aW9uIG91dGRhdGVkSW5zdGFsbGVkU3RvcmVDb3VudChlbnRyaWVzOiBUd2Vha1N0b3JlRW50cnlWaWV3W10pOiBudW1iZXIge1xuICByZXR1cm4gZW50cmllcy5maWx0ZXIoKGVudHJ5KSA9PiAhIWVudHJ5Lmluc3RhbGxlZCAmJiBlbnRyeS5pbnN0YWxsZWQudmVyc2lvbiAhPT0gZW50cnkubWFuaWZlc3QudmVyc2lvbikubGVuZ3RoO1xufVxuXG5mdW5jdGlvbiBzdG9yZVRvb2xiYXJCdXR0b24oXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4gIHZhcmlhbnQ6IFwicHJpbWFyeVwiIHwgXCJzZWNvbmRhcnlcIiA9IFwic2Vjb25kYXJ5XCIsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgdmFyaWFudCA9PT0gXCJwcmltYXJ5XCJcbiAgICAgID8gXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tYmctZm9nIHB4LTIgcHktMCB0ZXh0LXNtIHRleHQtdG9rZW4tYnV0dG9uLXRlcnRpYXJ5LWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZGlzYWJsZWQ6Y3Vyc29yLW5vdC1hbGxvd2VkIGRpc2FibGVkOm9wYWNpdHktNDBcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGgtOCBpdGVtcy1jZW50ZXIgZ2FwLTEgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRyYW5zcGFyZW50IGJnLXRva2VuLWZvcmVncm91bmQvNSBweC0yIHB5LTAgdGV4dC1zbSB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uQnV0dG9uKFxuICBpY29uU3ZnOiBzdHJpbmcsXG4gIGxhYmVsOiBzdHJpbmcsXG4gIG9uQ2xpY2s6ICgpID0+IHZvaWQsXG4pOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyIHVzZXItc2VsZWN0LW5vbmUgbm8tZHJhZyBjdXJzb3ItaW50ZXJhY3Rpb24gZmxleCBoLTggdy04IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdHJhbnNwYXJlbnQgYmctdG9rZW4tZm9yZWdyb3VuZC81IHAtMCB0ZXh0LXRva2VuLWZvcmVncm91bmQgZW5hYmxlZDpob3ZlcjpiZy10b2tlbi1mb3JlZ3JvdW5kLzEwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi5pbm5lckhUTUwgPSBpY29uU3ZnO1xuICBjb25zdHJhaW5TaWRlYmFySWNvblN2ZyhidG4ucXVlcnlTZWxlY3RvcihcInN2Z1wiKSwgMTgpO1xuICBidG4uc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBsYWJlbCk7XG4gIGJ0bi50aXRsZSA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcmVmcmVzaEljb25TdmcoKTogc3RyaW5nIHtcbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjE4XCIgaGVpZ2h0PVwiMThcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cImljb24teHNcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk00LjQgOS4zNUE1LjY1IDUuNjUgMCAwIDEgMTQgNS4zTDE1Ljc1IDdNMTUuNzUgMy43NVY3aC0zLjI1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjYgMTAuNjVBNS42NSA1LjY1IDAgMCAxIDYgMTQuN0w0LjI1IDEzTTQuMjUgMTYuMjVWMTNINy41XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcmlmaWVkU2FmZUJhZGdlKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgYmFkZ2UuY2xhc3NOYW1lID1cbiAgICBcImlubGluZS1mbGV4IGgtNiBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSByb3VuZGVkLW1kIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzMwIGJnLXRyYW5zcGFyZW50IHB4LTIgdGV4dC14cyBmb250LW1lZGl1bSB0ZXh0LXRva2VuLWRlc2NyaXB0aW9uLWZvcmVncm91bmRcIjtcbiAgYmFkZ2UuaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjEzXCIgaGVpZ2h0PVwiMTNcIiB2aWV3Qm94PVwiMCAwIDE0IDE0XCIgZmlsbD1cIm5vbmVcIiBjbGFzcz1cInRleHQtYmx1ZS01MDBcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk03IDEuNzUgMTEuMjUgMy40djMuMmMwIDIuNi0xLjY1IDQuMjUtNC4yNSA1LjQtMi42LTEuMTUtNC4yNS0yLjgtNC4yNS01LjRWMy40TDcgMS43NVpcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjE1XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNC44NSA3LjA1IDYuMyA4LjQ1bDIuODUtMy4wNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuMjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmAgK1xuICAgIGA8c3Bhbj5WZXJpZmllZCBhcyBzYWZlPC9zcGFuPmA7XG4gIHJldHVybiBiYWRnZTtcbn1cblxuZnVuY3Rpb24gdHdlYWtTdG9yZVZlcnNpb25CYWRnZShlbnRyeTogVHdlYWtTdG9yZUVudHJ5VmlldywgaW5zdGFsbGVkT3ZlcnJpZGU/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGluc3RhbGxlZCA9IGluc3RhbGxlZE92ZXJyaWRlID8/IGVudHJ5Lmluc3RhbGxlZD8udmVyc2lvbiA/PyBudWxsO1xuICBjb25zdCBsYXRlc3QgPSBlbnRyeS5tYW5pZmVzdC52ZXJzaW9uO1xuICBjb25zdCBoYXNVcGRhdGUgPSAhIWluc3RhbGxlZCAmJiBpbnN0YWxsZWQgIT09IGxhdGVzdDtcbiAgY29uc3QgYmFkZ2UgPSBzdG9yZVZlcnNpb25CYWRnZVNoZWxsKGhhc1VwZGF0ZSk7XG4gIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGxhYmVsLmNsYXNzTmFtZSA9IFwidHJ1bmNhdGVcIjtcbiAgbGFiZWwudGV4dENvbnRlbnQgPSBpbnN0YWxsZWRcbiAgICA/IGBJbnN0YWxsZWQgdiR7aW5zdGFsbGVkfSBcdTAwQjcgTGF0ZXN0IHYke2xhdGVzdH1gXG4gICAgOiBgTGF0ZXN0IHYke2xhdGVzdH1gO1xuICBiYWRnZS50aXRsZSA9IGluc3RhbGxlZFxuICAgID8gYEluc3RhbGxlZCB2ZXJzaW9uICR7aW5zdGFsbGVkfS4gTGF0ZXN0IGFwcHJvdmVkIHZlcnNpb24gJHtsYXRlc3R9LmBcbiAgICA6IGBMYXRlc3QgYXBwcm92ZWQgdmVyc2lvbiAke2xhdGVzdH0uYDtcbiAgYmFkZ2UuYXBwZW5kQ2hpbGQobGFiZWwpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlVmVyc2lvbkJhZGdlU2hlbGwoaGFzVXBkYXRlOiBib29sZWFuKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggbWluLXctMCBtYXgtdy1mdWxsIGl0ZW1zLWNlbnRlciByb3VuZGVkLWxnIGJvcmRlciBweC0yLjUgdGV4dC14cyBmb250LW1lZGl1bVwiLFxuICAgIGhhc1VwZGF0ZVxuICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLWZvcmVncm91bmRcIlxuICAgICAgOiBcImJvcmRlci10b2tlbi1ib3JkZXIvNDAgYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICByZXR1cm4gYmFkZ2U7XG59XG5cbmZ1bmN0aW9uIHN0b3JlU3RhdHVzUGlsbChsYWJlbDogc3RyaW5nLCB0b25lOiBcIm5ldXRyYWxcIiB8IFwiaW5mb1wiID0gXCJuZXV0cmFsXCIpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgcGlsbC5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHdoaXRlc3BhY2Utbm93cmFwIHJvdW5kZWQtbGcgcHgtMyB0ZXh0LXNtIGZvbnQtbWVkaXVtXCIsXG4gICAgdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgID8gXCJib3JkZXIgYm9yZGVyLWJsdWUtNTAwLzMwIGJnLWJsdWUtNTAwLzEwIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICA6IFwiYmctdG9rZW4tZm9yZWdyb3VuZC81IHRleHQtdG9rZW4tZGVzY3JpcHRpb24tZm9yZWdyb3VuZFwiLFxuICBdLmpvaW4oXCIgXCIpO1xuICBwaWxsLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIHJldHVybiBwaWxsO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpID0+IHZvaWQpOiBIVE1MQnV0dG9uRWxlbWVudCB7XG4gIGNvbnN0IGJ0biA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGJ0bi50eXBlID0gXCJidXR0b25cIjtcbiAgYnRuLmNsYXNzTmFtZSA9XG4gICAgc3RvcmVJbnN0YWxsQnV0dG9uQ2xhc3MoKTtcbiAgYnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBvbkNsaWNrKGJ0bik7XG4gIH0pO1xuICByZXR1cm4gYnRuO1xufVxuXG5mdW5jdGlvbiBzdG9yZUluc3RhbGxCdXR0b25DbGFzcyhleHRyYSA9IFwiXCIpOiBzdHJpbmcge1xuICByZXR1cm4gW1xuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGZsZXggaC04IG1pbi13LVs4MnB4XSBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgZ2FwLTEuNSB3aGl0ZXNwYWNlLW5vd3JhcCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItYmx1ZS01MDAvNDAgYmctYmx1ZS01MDAgcHgtMyBweS0wIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi1mb3JlZ3JvdW5kIHNoYWRvdy1zbSB0cmFuc2l0aW9uLWNvbG9ycyBlbmFibGVkOmhvdmVyOmJnLWJsdWUtNjAwIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTgwXCIsXG4gICAgZXh0cmEsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oXCIgXCIpO1xufVxuXG5mdW5jdGlvbiBzaG93U3RvcmVCdXR0b25Mb2FkaW5nKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IHRydWU7XG4gIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWJ1c3lcIiwgXCJ0cnVlXCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyBjbGFzcz1cImFuaW1hdGUtc3BpblwiIHdpZHRoPVwiMTRcIiBoZWlnaHQ9XCIxNFwiIHZpZXdCb3g9XCIwIDAgMTYgMTZcIiBmaWxsPVwibm9uZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiOFwiIGN5PVwiOFwiIHI9XCI1LjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIyXCIgb3BhY2l0eT1cIi4yNVwiLz5gICtcbiAgICBgPHBhdGggZD1cIk0xMy41IDhBNS41IDUuNSAwIDAgMCA4IDIuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjJcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+JHtsYWJlbH08L3NwYW4+YDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlQnV0dG9uSW5zdGFsbGVkKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKFwiYm9yZGVyLWJsdWUtNTAwIGJnLWJsdWUtNTAwXCIpO1xuICBidXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24uaW5uZXJIVE1MID1cbiAgICBgPHN2ZyB3aWR0aD1cIjE0XCIgaGVpZ2h0PVwiMTRcIiB2aWV3Qm94PVwiMCAwIDE2IDE2XCIgZmlsbD1cIm5vbmVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zLjc1IDguMTUgNi42NSAxMSAxMi4yNSA1XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS44XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gICtcbiAgICBgPHNwYW4+SW5zdGFsbGVkPC9zcGFuPmA7XG59XG5cbmZ1bmN0aW9uIHJlc2V0U3RvcmVJbnN0YWxsQnV0dG9uKGJ1dHRvbjogSFRNTEJ1dHRvbkVsZW1lbnQsIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgYnV0dG9uLmNsYXNzTmFtZSA9IHN0b3JlSW5zdGFsbEJ1dHRvbkNsYXNzKCk7XG4gIGJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICBidXR0b24ucmVtb3ZlQXR0cmlidXRlKFwiYXJpYS1idXN5XCIpO1xuICBidXR0b24udGV4dENvbnRlbnQgPSBsYWJlbDtcbn1cblxuZnVuY3Rpb24gc2hvd1N0b3JlVG9hc3QobWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGxldCBob3N0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCJbZGF0YS10d2Vha2VyLXN0b3JlLXRvYXN0LWhvc3RdXCIpO1xuICBpZiAoIWhvc3QpIHtcbiAgICBob3N0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBob3N0LmRhdGFzZXQudHdlYWtlclN0b3JlVG9hc3RIb3N0ID0gXCJ0cnVlXCI7XG4gICAgaG9zdC5jbGFzc05hbWUgPSBcInBvaW50ZXItZXZlbnRzLW5vbmUgZml4ZWQgYm90dG9tLTUgcmlnaHQtNSB6LVs5OTk5XSBmbGV4IGZsZXgtY29sIGl0ZW1zLWVuZCBnYXAtMlwiO1xuICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoaG9zdCk7XG4gIH1cbiAgY29uc3QgdG9hc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b2FzdC5jbGFzc05hbWUgPVxuICAgIFwidHJhbnNsYXRlLXktMiByb3VuZGVkLXhsIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzUwIGJnLXRva2VuLW1haW4tc3VyZmFjZS1wcmltYXJ5IHB4LTMgcHktMiB0ZXh0LXNtIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZCBvcGFjaXR5LTAgc2hhZG93LWxnIHRyYW5zaXRpb24tYWxsIGR1cmF0aW9uLTIwMFwiO1xuICB0b2FzdC50ZXh0Q29udGVudCA9IG1lc3NhZ2U7XG4gIGhvc3QuYXBwZW5kQ2hpbGQodG9hc3QpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCkgPT4ge1xuICAgIHRvYXN0LmNsYXNzTGlzdC5yZW1vdmUoXCJ0cmFuc2xhdGUteS0yXCIsIFwib3BhY2l0eS0wXCIpO1xuICB9KTtcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgdG9hc3QuY2xhc3NMaXN0LmFkZChcInRyYW5zbGF0ZS15LTJcIiwgXCJvcGFjaXR5LTBcIik7XG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0b2FzdC5yZW1vdmUoKTtcbiAgICAgIGlmIChob3N0ICYmIGhvc3QuY2hpbGRFbGVtZW50Q291bnQgPT09IDApIGhvc3QucmVtb3ZlKCk7XG4gICAgfSwgMjIwKTtcbiAgfSwgMjYwMCk7XG59XG5cbmZ1bmN0aW9uIHN0b3JlTWVzc2FnZUNhcmQodGl0bGU6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjYXJkLmNsYXNzTmFtZSA9XG4gICAgXCJib3JkZXItdG9rZW4tYm9yZGVyLzQwIGZsZXggbWluLWgtWzg0cHhdIGZsZXgtY29sIGp1c3RpZnktY2VudGVyIGdhcC0xIHJvdW5kZWQtMnhsIGJvcmRlciBwLTQgdGV4dC1zbVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcImZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHQudGV4dENvbnRlbnQgPSB0aXRsZTtcbiAgY2FyZC5hcHBlbmRDaGlsZCh0KTtcbiAgaWYgKGRlc2NyaXB0aW9uKSB7XG4gICAgY29uc3QgZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZC5jbGFzc05hbWUgPSBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkLnRleHRDb250ZW50ID0gZGVzY3JpcHRpb247XG4gICAgY2FyZC5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICByZXR1cm4gY2FyZDtcbn1cblxuZnVuY3Rpb24gc2hvcnRTaGEodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZS5zbGljZSgwLCA3KTtcbn1cblxudHlwZSBBY3Rpb25NZW51SXRlbSA9IHsgbGFiZWw6IHN0cmluZzsgb25TZWxlY3Q6ICgpID0+IHZvaWQgfTtcblxuZnVuY3Rpb24gcmVuZGVyVHdlYWtzUGFnZShzZWN0aW9uc1dyYXA6IEhUTUxFbGVtZW50KTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IHNlY3Rpb25zQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBTZXR0aW5nc1NlY3Rpb25bXT4oKTtcbiAgZm9yIChjb25zdCBzZWN0aW9uIG9mIHN0YXRlLnNlY3Rpb25zLnZhbHVlcygpKSB7XG4gICAgY29uc3QgdHdlYWtJZCA9IHNlY3Rpb24uaWQuc3BsaXQoXCI6XCIpWzBdO1xuICAgIGlmICghc2VjdGlvbnNCeVR3ZWFrLmhhcyh0d2Vha0lkKSkgc2VjdGlvbnNCeVR3ZWFrLnNldCh0d2Vha0lkLCBbXSk7XG4gICAgc2VjdGlvbnNCeVR3ZWFrLmdldCh0d2Vha0lkKSEucHVzaChzZWN0aW9uKTtcbiAgfVxuXG4gIGNvbnN0IHBhZ2VzQnlUd2VhayA9IG5ldyBNYXA8c3RyaW5nLCBSZWdpc3RlcmVkUGFnZVtdPigpO1xuICBmb3IgKGNvbnN0IHBhZ2Ugb2Ygc3RhdGUucGFnZXMudmFsdWVzKCkpIHtcbiAgICBpZiAoIXBhZ2VzQnlUd2Vhay5oYXMocGFnZS50d2Vha0lkKSkgcGFnZXNCeVR3ZWFrLnNldChwYWdlLnR3ZWFrSWQsIFtdKTtcbiAgICBwYWdlc0J5VHdlYWsuZ2V0KHBhZ2UudHdlYWtJZCkhLnB1c2gocGFnZSk7XG4gIH1cblxuICBjb25zdCB3cmFwID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNlY3Rpb25cIik7XG4gIHdyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC0zXCI7XG4gIHNlY3Rpb25zV3JhcC5hcHBlbmRDaGlsZCh3cmFwKTtcblxuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdG9vbGJhci5jbGFzc05hbWUgPSBcImZsZXggZmxleC13cmFwIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTNcIjtcbiAgd3JhcC5hcHBlbmRDaGlsZCh0b29sYmFyKTtcblxuICBjb25zdCB0YWJzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwidGFibGlzdFwiKTtcbiAgdGFicy5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiRmlsdGVyIHR3ZWFrc1wiKTtcbiAgdGFicy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTFcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0YWJzKTtcblxuICBjb25zdCB0b29sYmFyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRvb2xiYXJBY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBpdGVtcy1jZW50ZXIganVzdGlmeS1lbmQgZ2FwLTJcIjtcbiAgdG9vbGJhci5hcHBlbmRDaGlsZCh0b29sYmFyQWN0aW9ucyk7XG5cbiAgY29uc3Qgc2VhcmNoID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2VhcmNoLmNsYXNzTmFtZSA9XG4gICAgXCJmbGV4IGgtdG9rZW4tYnV0dG9uLWNvbXBvc2VyIHctNTYgbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTIgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWlucHV0LWJvcmRlciBiZy10b2tlbi1pbnB1dC1iYWNrZ3JvdW5kLzc1IHB4LTIuNSB0ZXh0LWJhc2Ugc2hhZG93LXNtXCI7XG4gIHNlYXJjaC5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIGNsYXNzPVwiaWNvbi1zbSBzaHJpbmstMCB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI5XCIgY3k9XCI5XCIgcj1cIjVcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJtMTMgMTMgMy41IDMuNVwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lY2FwPVwicm91bmRcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IHNlYXJjaExhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxhYmVsXCIpO1xuICBzZWFyY2hMYWJlbC5jbGFzc05hbWUgPSBcInNyLW9ubHlcIjtcbiAgc2VhcmNoTGFiZWwuaHRtbEZvciA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaExhYmVsLnRleHRDb250ZW50ID0gXCJTZWFyY2ggdHdlYWtzXCI7XG4gIGNvbnN0IHNlYXJjaElucHV0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImlucHV0XCIpO1xuICBzZWFyY2hJbnB1dC5pZCA9IFwidHdlYWtlci10d2Vha3Mtc2VhcmNoXCI7XG4gIHNlYXJjaElucHV0LnR5cGUgPSBcInNlYXJjaFwiO1xuICBzZWFyY2hJbnB1dC5wbGFjZWhvbGRlciA9IFwiU2VhcmNoIHR3ZWFrc1wiO1xuICBzZWFyY2hJbnB1dC52YWx1ZSA9IHN0YXRlLnR3ZWFrc1BhZ2VRdWVyeTtcbiAgc2VhcmNoSW5wdXQuY2xhc3NOYW1lID1cbiAgICBcIm1pbi13LTAgZmxleC0xIGJnLXRyYW5zcGFyZW50IHRleHQtYmFzZSB0ZXh0LXRva2VuLWlucHV0LWZvcmVncm91bmQgb3V0bGluZS1ub25lIHBsYWNlaG9sZGVyOnRleHQtdG9rZW4taW5wdXQtcGxhY2Vob2xkZXItZm9yZWdyb3VuZFwiO1xuICBjb25zdCBjbGVhclNlYXJjaCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGNsZWFyU2VhcmNoLnR5cGUgPSBcImJ1dHRvblwiO1xuICBjbGVhclNlYXJjaC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIFwiQ2xlYXIgc2VhcmNoXCIpO1xuICBjbGVhclNlYXJjaC5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgY3Vyc29yLWludGVyYWN0aW9uIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kXCI7XG4gIGNsZWFyU2VhcmNoLmlubmVySFRNTCA9XG4gICAgYDxzdmcgd2lkdGg9XCIxNlwiIGhlaWdodD1cIjE2XCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJtNiA2IDggOE0xNCA2bC04IDhcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBjbGVhclNlYXJjaC5oaWRkZW4gPSBzdGF0ZS50d2Vha3NQYWdlUXVlcnkubGVuZ3RoID09PSAwO1xuICBzZWFyY2guYXBwZW5kKHNlYXJjaExhYmVsLCBzZWFyY2hJbnB1dCwgY2xlYXJTZWFyY2gpO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChzZWFyY2gpO1xuXG4gIGNvbnN0IGdsb2JhbE1lbnUgPSBhY3Rpb25NZW51QnV0dG9uKFwiTW9yZSB0d2VhayBhY3Rpb25zXCIsIFtcbiAgICB7XG4gICAgICBsYWJlbDogXCJGb3JjZSBSZWxvYWRcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiB7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXJcbiAgICAgICAgICAuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwiZm9yY2UgcmVsb2FkIChtYWluKSBmYWlsZWRcIiwgU3RyaW5nKGUpKSlcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbGFiZWw6IFwiT3BlbiBUd2Vha3MgRm9sZGVyXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmV2ZWFsXCIsIHR3ZWFrc1BhdGgoKSk7XG4gICAgICB9LFxuICAgIH0sXG4gIF0pO1xuICB0b29sYmFyQWN0aW9ucy5hcHBlbmRDaGlsZChnbG9iYWxNZW51LmVsZW1lbnQpO1xuXG4gIGNvbnN0IGxpc3QgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBsaXN0LmlkID0gXCJ0d2Vha2VyLXR3ZWFrcy1saXN0XCI7XG4gIGxpc3Quc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcInRhYnBhbmVsXCIpO1xuICBsaXN0LmNsYXNzTmFtZSA9IFwiZmxleCBmbGV4LWNvbCBnYXAtMlwiO1xuICB3cmFwLmFwcGVuZENoaWxkKGxpc3QpO1xuXG4gIGxldCByb3dDbGVhbnVwczogQXJyYXk8KCkgPT4gdm9pZD4gPSBbXTtcbiAgY29uc3QgcmVuZGVyTGlzdCA9ICgpOiB2b2lkID0+IHtcbiAgICBmb3IgKGNvbnN0IGNsZWFudXAgb2Ygcm93Q2xlYW51cHMpIGNsZWFudXAoKTtcbiAgICByb3dDbGVhbnVwcyA9IFtdO1xuXG4gICAgY29uc3QgY291bnRzID0gdHdlYWtzUGFnZUNvdW50cyhzdGF0ZS5saXN0ZWRUd2Vha3MpO1xuICAgIHRhYnMucmVwbGFjZUNoaWxkcmVuKCk7XG4gICAgZm9yIChjb25zdCBmaWx0ZXIgb2YgVFdFQUtTX1BBR0VfRklMVEVSUykge1xuICAgICAgY29uc3Qgc2VsZWN0ZWQgPSBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyID09PSBmaWx0ZXI7XG4gICAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgYnV0dG9uLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgYnV0dG9uLmlkID0gYHR3ZWFrZXItdHdlYWtzLWZpbHRlci0ke2ZpbHRlcn1gO1xuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJ0YWJcIik7XG4gICAgICBidXR0b24uc2V0QXR0cmlidXRlKFwiYXJpYS1jb250cm9sc1wiLCBsaXN0LmlkKTtcbiAgICAgIGJ1dHRvbi5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhzZWxlY3RlZCkpO1xuICAgICAgYnV0dG9uLmNsYXNzTmFtZSA9IFtcbiAgICAgICAgXCJpbmxpbmUtZmxleCBoLTggaXRlbXMtY2VudGVyIGdhcC0xLjUgcm91bmRlZC1sZyBweC0yLjUgdGV4dC1zbSBjdXJzb3ItaW50ZXJhY3Rpb25cIixcbiAgICAgICAgc2VsZWN0ZWRcbiAgICAgICAgICA/IFwiYmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tZm9yZWdyb3VuZFwiXG4gICAgICAgICAgOiBcInRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnkgaG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGhvdmVyOnRleHQtdG9rZW4tZm9yZWdyb3VuZFwiLFxuICAgICAgXS5qb2luKFwiIFwiKTtcbiAgICAgIGNvbnN0IGxhYmVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gICAgICBsYWJlbC50ZXh0Q29udGVudCA9IHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXIpO1xuICAgICAgY29uc3QgY291bnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgICAgIGNvdW50LmNsYXNzTmFtZSA9IFwidGV4dC10b2tlbi1pbnB1dC1wbGFjZWhvbGRlci1mb3JlZ3JvdW5kIHRhYnVsYXItbnVtc1wiO1xuICAgICAgY291bnQudGV4dENvbnRlbnQgPSBTdHJpbmcoY291bnRzW2ZpbHRlcl0pO1xuICAgICAgYnV0dG9uLmFwcGVuZChsYWJlbCwgY291bnQpO1xuICAgICAgYnV0dG9uLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAgIHN0YXRlLnR3ZWFrc1BhZ2VGaWx0ZXIgPSBmaWx0ZXI7XG4gICAgICAgIHJlbmRlckxpc3QoKTtcbiAgICAgIH0pO1xuICAgICAgdGFicy5hcHBlbmRDaGlsZChidXR0b24pO1xuICAgIH1cbiAgICBsaXN0LnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxsZWRieVwiLCBgdHdlYWtlci10d2Vha3MtZmlsdGVyLSR7c3RhdGUudHdlYWtzUGFnZUZpbHRlcn1gKTtcblxuICAgIGNvbnN0IHZpc2libGUgPSBmaWx0ZXJUd2Vha3NQYWdlSXRlbXMoXG4gICAgICBzdGF0ZS5saXN0ZWRUd2Vha3MsXG4gICAgICBzdGF0ZS50d2Vha3NQYWdlRmlsdGVyLFxuICAgICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5LFxuICAgICk7XG4gICAgbGlzdC5yZXBsYWNlQ2hpbGRyZW4oKTtcbiAgICBpZiAodmlzaWJsZS5sZW5ndGggPT09IDApIHtcbiAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgIGVtcHR5LmNsYXNzTmFtZSA9IFwiZmxleCBtaW4taC0yOCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcHktOCB0ZXh0LWNlbnRlciB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICAgIGVtcHR5LnRleHRDb250ZW50ID0gc3RhdGUubGlzdGVkVHdlYWtzLmxlbmd0aCA9PT0gMFxuICAgICAgICA/IGBObyBjYXRhbG9nIGVudHJpZXMgYXZhaWxhYmxlLiBEcm9wIGEgdHdlYWsgZm9sZGVyIGludG8gJHt0d2Vha3NQYXRoKCl9IGFuZCByZWxvYWQuYFxuICAgICAgICA6IFwiTm8gdHdlYWtzIG1hdGNoIHRoaXMgc2VhcmNoIGFuZCBmaWx0ZXIuXCI7XG4gICAgICBsaXN0LmFwcGVuZENoaWxkKGVtcHR5KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IHR3ZWFrIG9mIHZpc2libGUpIHtcbiAgICAgIGxpc3QuYXBwZW5kQ2hpbGQodHdlYWtSb3coXG4gICAgICAgIHR3ZWFrLFxuICAgICAgICBzZWN0aW9uc0J5VHdlYWsuZ2V0KHR3ZWFrLm1hbmlmZXN0LmlkKSA/PyBbXSxcbiAgICAgICAgcGFnZXNCeVR3ZWFrLmdldCh0d2Vhay5tYW5pZmVzdC5pZCkgPz8gW10sXG4gICAgICAgIChjbGVhbnVwKSA9PiByb3dDbGVhbnVwcy5wdXNoKGNsZWFudXApLFxuICAgICAgKSk7XG4gICAgfVxuICB9O1xuXG4gIHNlYXJjaElucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJpbnB1dFwiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gc2VhcmNoSW5wdXQudmFsdWU7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gc2VhcmNoSW5wdXQudmFsdWUubGVuZ3RoID09PSAwO1xuICAgIHJlbmRlckxpc3QoKTtcbiAgfSk7XG4gIGNsZWFyU2VhcmNoLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgc3RhdGUudHdlYWtzUGFnZVF1ZXJ5ID0gXCJcIjtcbiAgICBzZWFyY2hJbnB1dC52YWx1ZSA9IFwiXCI7XG4gICAgY2xlYXJTZWFyY2guaGlkZGVuID0gdHJ1ZTtcbiAgICByZW5kZXJMaXN0KCk7XG4gICAgc2VhcmNoSW5wdXQuZm9jdXMoKTtcbiAgfSk7XG5cbiAgcmVuZGVyTGlzdCgpO1xuICByZXR1cm4gKCkgPT4ge1xuICAgIGdsb2JhbE1lbnUuZGlzcG9zZSgpO1xuICAgIGZvciAoY29uc3QgY2xlYW51cCBvZiByb3dDbGVhbnVwcykgY2xlYW51cCgpO1xuICAgIHJvd0NsZWFudXBzID0gW107XG4gIH07XG59XG5cbmZ1bmN0aW9uIHR3ZWFrc1BhZ2VGaWx0ZXJMYWJlbChmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIpOiBzdHJpbmcge1xuICBpZiAoZmlsdGVyID09PSBcImFsbFwiKSByZXR1cm4gXCJBbGxcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJlbmFibGVkXCIpIHJldHVybiBcIkVuYWJsZWRcIjtcbiAgaWYgKGZpbHRlciA9PT0gXCJkaXNhYmxlZFwiKSByZXR1cm4gXCJEaXNhYmxlZFwiO1xuICByZXR1cm4gXCJVcGRhdGVzXCI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrUm93KFxuICB0d2VhazogTGlzdGVkVHdlYWssXG4gIHNlY3Rpb25zOiBTZXR0aW5nc1NlY3Rpb25bXSxcbiAgcGFnZXM6IFJlZ2lzdGVyZWRQYWdlW10sXG4gIHJlZ2lzdGVyQ2xlYW51cDogKGNsZWFudXA6ICgpID0+IHZvaWQpID0+IHZvaWQsXG4pOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IG1hbmlmZXN0ID0gdHdlYWsubWFuaWZlc3Q7XG4gIGNvbnN0IGNlbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjZWxsLmNsYXNzTmFtZSA9IFtcbiAgICBcImdyb3VwIGZsZXggZmxleC1jb2wgb3ZlcmZsb3ctdmlzaWJsZSByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyLzQwIGJnLXRva2VuLWZvcmVncm91bmQvNSB0cmFuc2l0aW9uLWNvbG9ycyBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIixcbiAgICAhdHdlYWsuaW5zdGFsbGVkIHx8IHR3ZWFrLnN0YXR1cyA9PT0gXCJkaXNhYmxlZFwiID8gXCJvcGFjaXR5LTYwXCIgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi1oLVs2NHB4XSBpdGVtcy1jZW50ZXIgZ2FwLTMgcC0yLjVcIjtcbiAgY2VsbC5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IGNhbkNvbmZpZ3VyZSA9IHR3ZWFrLmluc3RhbGxlZCAmJiB0d2Vhay5lbmFibGVkICYmIHBhZ2VzLmxlbmd0aCA+IDA7XG4gIGNvbnN0IGNvbnRlbnQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KGNhbkNvbmZpZ3VyZSA/IFwiYnV0dG9uXCIgOiBcImRpdlwiKTtcbiAgY29udGVudC5jbGFzc05hbWUgPSBbXG4gICAgXCJmbGV4IG1pbi13LTAgZmxleC0xIGl0ZW1zLWNlbnRlciBnYXAtMyB0ZXh0LWxlZnRcIixcbiAgICBjYW5Db25maWd1cmVcbiAgICAgID8gXCJjdXJzb3ItaW50ZXJhY3Rpb24gcm91bmRlZC1sZyBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyXCJcbiAgICAgIDogXCJcIixcbiAgXS5maWx0ZXIoQm9vbGVhbikuam9pbihcIiBcIik7XG4gIGlmIChjb250ZW50IGluc3RhbmNlb2YgSFRNTEJ1dHRvbkVsZW1lbnQpIHtcbiAgICBjb250ZW50LnR5cGUgPSBcImJ1dHRvblwiO1xuICAgIGNvbnRlbnQudGl0bGUgPSBwYWdlcy5sZW5ndGggPT09IDFcbiAgICAgID8gYE9wZW4gJHtwYWdlc1swXSEucGFnZS50aXRsZX1gXG4gICAgICA6IGBPcGVuICR7cGFnZXMubWFwKChwYWdlKSA9PiBwYWdlLnBhZ2UudGl0bGUpLmpvaW4oXCIsIFwiKX1gO1xuICAgIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGFjdGl2YXRlUGFnZSh7IGtpbmQ6IFwicmVnaXN0ZXJlZFwiLCBpZDogbWFuaWZlc3QuaWQgfSk7XG4gICAgfSk7XG4gIH1cbiAgY29udGVudC5hcHBlbmRDaGlsZCh0d2Vha0F2YXRhcih0d2VhaykpO1xuXG4gIGNvbnN0IHN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhY2suY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgZmxleC0xIGZsZXgtY29sIGdhcC0wLjVcIjtcbiAgY29uc3QgdGl0bGVSb3cgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZVJvdy5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgbmFtZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hbWUuY2xhc3NOYW1lID0gXCJtaW4tdy0wIHRydW5jYXRlIHRleHQtc20gZm9udC1tZWRpdW0gdGV4dC10b2tlbi10ZXh0LXByaW1hcnlcIjtcbiAgbmFtZS50ZXh0Q29udGVudCA9IG1hbmlmZXN0Lm5hbWU7XG4gIHRpdGxlUm93LmFwcGVuZENoaWxkKG5hbWUpO1xuICBjb25zdCB2ZXJzaW9uID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIHZlcnNpb24uY2xhc3NOYW1lID0gXCJzaHJpbmstMCB0ZXh0LXhzIGZvbnQtbm9ybWFsIHRhYnVsYXItbnVtcyB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCI7XG4gIHZlcnNpb24udGV4dENvbnRlbnQgPSBgdiR7bWFuaWZlc3QudmVyc2lvbn1gO1xuICB0aXRsZVJvdy5hcHBlbmRDaGlsZCh2ZXJzaW9uKTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodHdlYWtTdGF0dXNQaWxsKHR3ZWFrKSk7XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSkge1xuICAgIGNvbnN0IHVwZGF0ZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICAgIHVwZGF0ZS5jbGFzc05hbWUgPVxuICAgICAgXCJzaHJpbmstMCByb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICAgIHVwZGF0ZS50ZXh0Q29udGVudCA9IFwiVXBkYXRlIEF2YWlsYWJsZVwiO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHVwZGF0ZSk7XG4gIH1cbiAgc3RhY2suYXBwZW5kQ2hpbGQodGl0bGVSb3cpO1xuICBpZiAobWFuaWZlc3QuZGVzY3JpcHRpb24pIHtcbiAgICBjb25zdCBkZXNjcmlwdGlvbiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgZGVzY3JpcHRpb24uY2xhc3NOYW1lID0gXCJsaW5lLWNsYW1wLTEgbWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgICBkZXNjcmlwdGlvbi50ZXh0Q29udGVudCA9IG1hbmlmZXN0LmRlc2NyaXB0aW9uO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKGRlc2NyaXB0aW9uKTtcbiAgfVxuICBjb250ZW50LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgaGVhZGVyLmFwcGVuZENoaWxkKGNvbnRlbnQpO1xuXG4gIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBhY3Rpb25zLmNsYXNzTmFtZSA9IFwiZmxleCBzaHJpbmstMCBpdGVtcy1jZW50ZXIgZ2FwLTJcIjtcbiAgY29uc3QgYXV0aG9yID0gdHdlYWtBdXRob3JOYW1lKG1hbmlmZXN0LmF1dGhvcik7XG4gIGlmIChhdXRob3IpIHtcbiAgICBjb25zdCBhdXRob3JMYWJlbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgYXV0aG9yTGFiZWwuY2xhc3NOYW1lID0gXCJoaWRkZW4gdy0yOCB0cnVuY2F0ZSB0ZXh0LXJpZ2h0IHRleHQtc20gdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBtZDpibG9ja1wiO1xuICAgIGF1dGhvckxhYmVsLnRleHRDb250ZW50ID0gYXV0aG9yO1xuICAgIGF1dGhvckxhYmVsLnRpdGxlID0gYXV0aG9yO1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoYXV0aG9yTGFiZWwpO1xuICB9XG5cbiAgY29uc3Qgcm93TWVudUl0ZW1zOiBBY3Rpb25NZW51SXRlbVtdID0gW107XG4gIGlmIChjYW5Db25maWd1cmUpIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJDb25maWd1cmVcIixcbiAgICAgIG9uU2VsZWN0OiAoKSA9PiBhY3RpdmF0ZVBhZ2UoeyBraW5kOiBcInJlZ2lzdGVyZWRcIiwgaWQ6IG1hbmlmZXN0LmlkIH0pLFxuICAgIH0pO1xuICB9XG4gIGlmICh0d2Vhay51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSAmJiB0d2Vhay51cGRhdGUucmVsZWFzZVVybCkge1xuICAgIHJvd01lbnVJdGVtcy5wdXNoKHtcbiAgICAgIGxhYmVsOiBcIlJldmlldyBSZWxlYXNlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCB0d2Vhay51cGRhdGUhLnJlbGVhc2VVcmwpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgfVxuICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgbGFiZWw6IFwiT3BlbiBSZXBvc2l0b3J5XCIsXG4gICAgb25TZWxlY3Q6ICgpID0+IHtcbiAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApO1xuICAgIH0sXG4gIH0pO1xuICBpZiAobWFuaWZlc3QuaG9tZXBhZ2UgJiYgbWFuaWZlc3QuaG9tZXBhZ2UgIT09IGBodHRwczovL2dpdGh1Yi5jb20vJHttYW5pZmVzdC5naXRodWJSZXBvfWApIHtcbiAgICByb3dNZW51SXRlbXMucHVzaCh7XG4gICAgICBsYWJlbDogXCJPcGVuIEhvbWVwYWdlXCIsXG4gICAgICBvblNlbGVjdDogKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6b3Blbi1leHRlcm5hbFwiLCBtYW5pZmVzdC5ob21lcGFnZSk7XG4gICAgICB9LFxuICAgIH0pO1xuICB9XG4gIGNvbnN0IHJvd01lbnUgPSBhY3Rpb25NZW51QnV0dG9uKGBNb3JlIGFjdGlvbnMgZm9yICR7bWFuaWZlc3QubmFtZX1gLCByb3dNZW51SXRlbXMpO1xuICByb3dNZW51LmVsZW1lbnQuY2xhc3NMaXN0LmFkZChcbiAgICBcImludmlzaWJsZVwiLFxuICAgIFwib3BhY2l0eS0wXCIsXG4gICAgXCJncm91cC1mb2N1cy13aXRoaW46dmlzaWJsZVwiLFxuICAgIFwiZ3JvdXAtZm9jdXMtd2l0aGluOm9wYWNpdHktMTAwXCIsXG4gICAgXCJncm91cC1ob3Zlcjp2aXNpYmxlXCIsXG4gICAgXCJncm91cC1ob3ZlcjpvcGFjaXR5LTEwMFwiLFxuICApO1xuICByZWdpc3RlckNsZWFudXAocm93TWVudS5kaXNwb3NlKTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChyb3dNZW51LmVsZW1lbnQpO1xuXG4gIGlmICghdHdlYWsuaW5zdGFsbGVkKSB7XG4gICAgaWYgKHR3ZWFrLmNhdGFsb2c/LmF2YWlsYWJsZSA9PT0gZmFsc2UpIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoc3RvcmVTdGF0dXNQaWxsKFwiTm90IGluc3RhbGxlZFwiKSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIkluc3RhbGxcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6aW5zdGFsbC1zdG9yZS10d2Vha1wiLCBtYW5pZmVzdC5pZClcbiAgICAgICAgICAudGhlbigoKSA9PiBsb2NhdGlvbi5yZWxvYWQoKSlcbiAgICAgICAgICAuY2F0Y2goKGUpID0+IHBsb2coXCJjYXRhbG9nIGluc3RhbGwgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgfSBlbHNlIGlmICh0d2Vhay5zdGF0dXMgPT09IFwicXVhcmFudGluZWRcIikge1xuICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoY29tcGFjdEJ1dHRvbihcIlJlY292ZXJcIiwgKCkgPT4ge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnJlY292ZXItdHdlYWtcIiwgbWFuaWZlc3QuaWQpXG4gICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcInR3ZWFrIHJlY292ZXJ5IGZhaWxlZFwiLCBTdHJpbmcoZSkpKTtcbiAgICB9KSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJmYWlsZWRcIikge1xuICAgICAgYWN0aW9ucy5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiUmV0cnlcIiwgKCkgPT4ge1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2xlYXItdHdlYWstaGVhbHRoXCIsIG1hbmlmZXN0LmlkKVxuICAgICAgICAgIC5jYXRjaCgoZSkgPT4gcGxvZyhcImNsZWFyIHR3ZWFrIGhlYWx0aCBmYWlsZWRcIiwgU3RyaW5nKGUpKSk7XG4gICAgICAgIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpyZWxvYWQtdHdlYWtzXCIpXG4gICAgICAgICAgLmNhdGNoKChlKSA9PiBwbG9nKFwidHdlYWsgcmV0cnkgZmFpbGVkXCIsIFN0cmluZyhlKSkpO1xuICAgICAgfSkpO1xuICAgIH1cbiAgICBjb25zdCB0b2dnbGUgPSBzd2l0Y2hDb250cm9sKHR3ZWFrLmVuYWJsZWQsIGFzeW5jIChuZXh0KSA9PiB7XG4gICAgICBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnNldC10d2Vhay1lbmFibGVkXCIsIG1hbmlmZXN0LmlkLCBuZXh0KTtcbiAgICB9KTtcbiAgICB0b2dnbGUuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBgJHt0d2Vhay5lbmFibGVkID8gXCJEaXNhYmxlXCIgOiBcIkVuYWJsZVwifSAke21hbmlmZXN0Lm5hbWV9YCk7XG4gICAgYWN0aW9ucy5hcHBlbmRDaGlsZCh0b2dnbGUpO1xuICB9XG4gIGhlYWRlci5hcHBlbmRDaGlsZChhY3Rpb25zKTtcblxuICAvLyBQcmVzZXJ2ZSB0aGUgbGVnYWN5IFNldHRpbmdzU2VjdGlvbiBjb250cmFjdDogcmVnaXN0ZXJlZCBzZWN0aW9ucyBzdGlsbFxuICAvLyByZW5kZXIgZGlyZWN0bHkgYmVuZWF0aCB0aGVpciBvd25pbmcgdHdlYWsgcm93LlxuICBpZiAodHdlYWsuaW5zdGFsbGVkICYmIHR3ZWFrLmVuYWJsZWQgJiYgc2VjdGlvbnMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5lc3RlZCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbmVzdGVkLmNsYXNzTmFtZSA9XG4gICAgICBcImZsZXggZmxleC1jb2wgZGl2aWRlLXktWzAuNXB4XSBkaXZpZGUtdG9rZW4tYm9yZGVyIGJvcmRlci10LVswLjVweF0gYm9yZGVyLXRva2VuLWJvcmRlclwiO1xuICAgIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgICAgY29uc3QgYm9keSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICBib2R5LmNsYXNzTmFtZSA9IFwicC0zXCI7XG4gICAgICB0cnkge1xuICAgICAgICBzZWN0aW9uLnJlbmRlcihib2R5KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgYm9keS5jbGFzc05hbWUgPSBcInAtMyB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgICAgICBib2R5LnRleHRDb250ZW50ID0gYEVycm9yIHJlbmRlcmluZyB0d2VhayBzZWN0aW9uOiAkeyhlIGFzIEVycm9yKS5tZXNzYWdlfWA7XG4gICAgICB9XG4gICAgICBuZXN0ZWQuYXBwZW5kQ2hpbGQoYm9keSk7XG4gICAgfVxuICAgIGNlbGwuYXBwZW5kQ2hpbGQobmVzdGVkKTtcbiAgfVxuXG4gIHJldHVybiBjZWxsO1xufVxuXG5mdW5jdGlvbiB0d2Vha0F2YXRhcih0d2VhazogTGlzdGVkVHdlYWspOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGF2YXRhciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBhdmF0YXIuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC0xMCB3LTEwIHNocmluay0wIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBvdmVyZmxvdy1oaWRkZW4gcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlci1kZWZhdWx0IGJnLXRyYW5zcGFyZW50IHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgY29uc3QgaW5pdGlhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBpbml0aWFsLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtXCI7XG4gIGluaXRpYWwudGV4dENvbnRlbnQgPSAodHdlYWsubWFuaWZlc3QubmFtZT8uWzBdID8/IFwiP1wiKS50b1VwcGVyQ2FzZSgpO1xuICBhdmF0YXIuYXBwZW5kQ2hpbGQoaW5pdGlhbCk7XG4gIGlmICghdHdlYWsubWFuaWZlc3QuaWNvblVybCkgcmV0dXJuIGF2YXRhcjtcblxuICBjb25zdCBpbWFnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbWdcIik7XG4gIGltYWdlLmFsdCA9IFwiXCI7XG4gIGltYWdlLmNsYXNzTmFtZSA9IFwiaC1mdWxsIHctZnVsbCBvYmplY3QtY29udGFpblwiO1xuICBpbWFnZS5oaWRkZW4gPSB0cnVlO1xuICBpbWFnZS5hZGRFdmVudExpc3RlbmVyKFwibG9hZFwiLCAoKSA9PiB7XG4gICAgaW5pdGlhbC5yZW1vdmUoKTtcbiAgICBpbWFnZS5oaWRkZW4gPSBmYWxzZTtcbiAgfSk7XG4gIGltYWdlLmFkZEV2ZW50TGlzdGVuZXIoXCJlcnJvclwiLCAoKSA9PiBpbWFnZS5yZW1vdmUoKSk7XG4gIHZvaWQgcmVzb2x2ZUljb25VcmwodHdlYWsubWFuaWZlc3QuaWNvblVybCwgdHdlYWsuZGlyKS50aGVuKCh1cmwpID0+IHtcbiAgICBpZiAodXJsKSBpbWFnZS5zcmMgPSB1cmw7XG4gICAgZWxzZSBpbWFnZS5yZW1vdmUoKTtcbiAgfSk7XG4gIGF2YXRhci5hcHBlbmRDaGlsZChpbWFnZSk7XG4gIHJldHVybiBhdmF0YXI7XG59XG5cbmZ1bmN0aW9uIHR3ZWFrQXV0aG9yTmFtZShhdXRob3I6IFR3ZWFrTWFuaWZlc3RbXCJhdXRob3JcIl0pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFhdXRob3IpIHJldHVybiBudWxsO1xuICByZXR1cm4gdHlwZW9mIGF1dGhvciA9PT0gXCJzdHJpbmdcIiA/IGF1dGhvciA6IGF1dGhvci5uYW1lO1xufVxuXG5mdW5jdGlvbiBhY3Rpb25NZW51QnV0dG9uKFxuICBsYWJlbDogc3RyaW5nLFxuICBpdGVtczogQWN0aW9uTWVudUl0ZW1bXSxcbik6IHsgZWxlbWVudDogSFRNTEVsZW1lbnQ7IGRpc3Bvc2U6ICgpID0+IHZvaWQgfSB7XG4gIGNvbnN0IGRldGFpbHMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGV0YWlsc1wiKTtcbiAgZGV0YWlscy5jbGFzc05hbWUgPSBcInJlbGF0aXZlIHNocmluay0wXCI7XG4gIGNvbnN0IHN1bW1hcnkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3VtbWFyeVwiKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIGxhYmVsKTtcbiAgc3VtbWFyeS5zZXRBdHRyaWJ1dGUoXCJhcmlhLWhhc3BvcHVwXCIsIFwibWVudVwiKTtcbiAgc3VtbWFyeS5jbGFzc05hbWUgPVxuICAgIFwiZmxleCBoLTggdy04IGxpc3Qtbm9uZSBjdXJzb3ItaW50ZXJhY3Rpb24gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHJvdW5kZWQtbGcgdGV4dC10b2tlbi10ZXh0LXNlY29uZGFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgaG92ZXI6dGV4dC10b2tlbi1mb3JlZ3JvdW5kIGZvY3VzLXZpc2libGU6b3V0bGluZS1ub25lIGZvY3VzLXZpc2libGU6cmluZy0yIGZvY3VzLXZpc2libGU6cmluZy10b2tlbi1mb2N1cy1ib3JkZXJcIjtcbiAgc3VtbWFyeS5zdHlsZS5saXN0U3R5bGUgPSBcIm5vbmVcIjtcbiAgc3VtbWFyeS5pbm5lckhUTUwgPVxuICAgIGA8c3ZnIHdpZHRoPVwiMTZcIiBoZWlnaHQ9XCIxNlwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwiY3VycmVudENvbG9yXCIgY2xhc3M9XCJpY29uLXNtXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxjaXJjbGUgY3g9XCI0XCIgY3k9XCIxMFwiIHI9XCIxLjI1XCIvPjxjaXJjbGUgY3g9XCIxMFwiIGN5PVwiMTBcIiByPVwiMS4yNVwiLz48Y2lyY2xlIGN4PVwiMTZcIiBjeT1cIjEwXCIgcj1cIjEuMjVcIi8+YCArXG4gICAgYDwvc3ZnPmA7XG4gIGNvbnN0IG1lbnUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtZW51LnNldEF0dHJpYnV0ZShcInJvbGVcIiwgXCJtZW51XCIpO1xuICBtZW51LmNsYXNzTmFtZSA9XG4gICAgXCJhYnNvbHV0ZSByaWdodC0wIHRvcC1mdWxsIHotNTAgbXQtMSBmbGV4IG1pbi13LTQ0IGZsZXgtY29sIHJvdW5kZWQtbGcgYm9yZGVyIGJvcmRlci10b2tlbi1ib3JkZXIgYmctdG9rZW4tbWFpbi1zdXJmYWNlLXByaW1hcnkgcC0xIHNoYWRvdy1sZ1wiO1xuICBmb3IgKGNvbnN0IGl0ZW0gb2YgaXRlbXMpIHtcbiAgICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgIGJ1dHRvbi50eXBlID0gXCJidXR0b25cIjtcbiAgICBidXR0b24uc2V0QXR0cmlidXRlKFwicm9sZVwiLCBcIm1lbnVpdGVtXCIpO1xuICAgIGJ1dHRvbi5jbGFzc05hbWUgPVxuICAgICAgXCJmbGV4IGgtOCB3LWZ1bGwgaXRlbXMtY2VudGVyIHJvdW5kZWQtbWQgcHgtMiB0ZXh0LWxlZnQgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBob3ZlcjpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmQgZm9jdXMtdmlzaWJsZTpvdXRsaW5lLW5vbmUgZm9jdXMtdmlzaWJsZTpiZy10b2tlbi1saXN0LWhvdmVyLWJhY2tncm91bmRcIjtcbiAgICBidXR0b24udGV4dENvbnRlbnQgPSBpdGVtLmxhYmVsO1xuICAgIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGV2ZW50KSA9PiB7XG4gICAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgICBkZXRhaWxzLm9wZW4gPSBmYWxzZTtcbiAgICAgIGl0ZW0ub25TZWxlY3QoKTtcbiAgICB9KTtcbiAgICBtZW51LmFwcGVuZENoaWxkKGJ1dHRvbik7XG4gIH1cbiAgZGV0YWlscy5hcHBlbmQoc3VtbWFyeSwgbWVudSk7XG5cbiAgbGV0IGxpc3RlbmluZyA9IGZhbHNlO1xuICBjb25zdCBkZXRhY2ggPSAoKTogdm9pZCA9PiB7XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHJldHVybjtcbiAgICBsaXN0ZW5pbmcgPSBmYWxzZTtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgb25LZXlkb3duLCB0cnVlKTtcbiAgfTtcbiAgY29uc3QgY2xvc2UgPSAoKTogdm9pZCA9PiB7XG4gICAgZGV0YWlscy5vcGVuID0gZmFsc2U7XG4gICAgZGV0YWNoKCk7XG4gIH07XG4gIGNvbnN0IG9uUG9pbnRlckRvd24gPSAoZXZlbnQ6IFBvaW50ZXJFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmICghZGV0YWlscy5pc0Nvbm5lY3RlZCB8fCAhKGV2ZW50LnRhcmdldCBpbnN0YW5jZW9mIE5vZGUpIHx8ICFkZXRhaWxzLmNvbnRhaW5zKGV2ZW50LnRhcmdldCkpIGNsb3NlKCk7XG4gIH07XG4gIGNvbnN0IG9uS2V5ZG93biA9IChldmVudDogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChldmVudC5rZXkgIT09IFwiRXNjYXBlXCIpIHJldHVybjtcbiAgICBldmVudC5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGNsb3NlKCk7XG4gICAgc3VtbWFyeS5mb2N1cygpO1xuICB9O1xuICBkZXRhaWxzLmFkZEV2ZW50TGlzdGVuZXIoXCJ0b2dnbGVcIiwgKCkgPT4ge1xuICAgIGlmICghZGV0YWlscy5vcGVuKSB7XG4gICAgICBkZXRhY2goKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKCFsaXN0ZW5pbmcpIHtcbiAgICAgIGxpc3RlbmluZyA9IHRydWU7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwicG9pbnRlcmRvd25cIiwgb25Qb2ludGVyRG93biwgdHJ1ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBvbktleWRvd24sIHRydWUpO1xuICAgIH1cbiAgICB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IG1lbnUucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCJidXR0b25cIik/LmZvY3VzKCkpO1xuICB9KTtcblxuICByZXR1cm4geyBlbGVtZW50OiBkZXRhaWxzLCBkaXNwb3NlOiBjbG9zZSB9O1xufVxuXG5mdW5jdGlvbiB0d2Vha1N0YXR1c1BpbGwodHdlYWs6IExpc3RlZFR3ZWFrKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBsYWJlbHM6IFJlY29yZDxUd2Vha1N0YXR1cywgc3RyaW5nPiA9IHtcbiAgICBpbnN0YWxsZWQ6IFwiSW5zdGFsbGVkXCIsXG4gICAgXCJub3QtaW5zdGFsbGVkXCI6IFwiTm90IGluc3RhbGxlZFwiLFxuICAgIGVuYWJsZWQ6IFwiRW5hYmxlZFwiLFxuICAgIGRpc2FibGVkOiBcIkRpc2FibGVkXCIsXG4gICAgZmFpbGVkOiBcIkZhaWxlZFwiLFxuICAgIHF1YXJhbnRpbmVkOiBcIlF1YXJhbnRpbmVkXCIsXG4gIH07XG4gIGNvbnN0IHRvbmUgPSB0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIgfHwgdHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIgPyBcImVycm9yXCIgOlxuICAgIHR3ZWFrLnN0YXR1cyA9PT0gXCJlbmFibGVkXCIgPyBcImluZm9cIiA6IFwibmV1dHJhbFwiO1xuICBjb25zdCBiYWRnZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBiYWRnZS5jbGFzc05hbWUgPSBbXG4gICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgcm91bmRlZC1mdWxsIGJvcmRlciBweC0yIHB5LTAuNSB0ZXh0LVsxMXB4XSBmb250LW1lZGl1bVwiLFxuICAgIHRvbmUgPT09IFwiZXJyb3JcIlxuICAgICAgPyBcImJvcmRlci10b2tlbi1jaGFydHMtcmVkLzMwIGJnLXRva2VuLWNoYXJ0cy1yZWQvMTAgdGV4dC10b2tlbi1jaGFydHMtcmVkXCJcbiAgICAgIDogdG9uZSA9PT0gXCJpbmZvXCJcbiAgICAgICAgPyBcImJvcmRlci1ibHVlLTUwMC8zMCBiZy1ibHVlLTUwMC8xMCB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiXG4gICAgICAgIDogXCJib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRva2VuLWZvcmVncm91bmQvNSB0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5XCIsXG4gIF0uam9pbihcIiBcIik7XG4gIGJhZGdlLnRleHRDb250ZW50ID0gbGFiZWxzW3R3ZWFrLnN0YXR1c107XG4gIGlmICh0d2Vhay5oZWFsdGg/LmVycm9yKSBiYWRnZS50aXRsZSA9IHR3ZWFrLmhlYWx0aC5lcnJvcjtcbiAgcmV0dXJuIGJhZGdlO1xufVxuXG5mdW5jdGlvbiBvcGVuUHVibGlzaFR3ZWFrRGlhbG9nKCk6IHZvaWQge1xuICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtdHdlYWtlci1wdWJsaXNoLWRpYWxvZ11cIik7XG4gIGV4aXN0aW5nPy5yZW1vdmUoKTtcblxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5kYXRhc2V0LnR3ZWFrZXJQdWJsaXNoRGlhbG9nID0gXCJ0cnVlXCI7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJmaXhlZCBpbnNldC0wIHotWzk5OTldIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGJnLWJsYWNrLzQwIHAtNFwiO1xuXG4gIGNvbnN0IGRpYWxvZyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGRpYWxvZy5jbGFzc05hbWUgPVxuICAgIFwiZmxleCB3LWZ1bGwgbWF4LXcteGwgZmxleC1jb2wgZ2FwLTQgcm91bmRlZC1sZyBib3JkZXIgYm9yZGVyLXRva2VuLWJvcmRlciBiZy10b2tlbi1tYWluLXN1cmZhY2UtcHJpbWFyeSBwLTQgc2hhZG93LXhsXCI7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoZGlhbG9nKTtcblxuICBjb25zdCBoZWFkZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXIuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLXN0YXJ0IGp1c3RpZnktYmV0d2VlbiBnYXAtM1wiO1xuICBjb25zdCB0aXRsZVN0YWNrID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVTdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0aXRsZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHRpdGxlLmNsYXNzTmFtZSA9IFwidGV4dC1iYXNlIGZvbnQtbWVkaXVtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gIHRpdGxlLnRleHRDb250ZW50ID0gXCJQdWJsaXNoIFR3ZWFrXCI7XG4gIGNvbnN0IHN1YnRpdGxlID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3VidGl0bGUuY2xhc3NOYW1lID0gXCJ0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3VidGl0bGUudGV4dENvbnRlbnQgPSBcIlN1Ym1pdCBhIEdpdEh1YiByZXBvIGZvciBhZG1pbiByZXZpZXcuIFR3ZWFrZXJzIHJlY29yZHMgdGhlIGV4YWN0IGNvbW1pdCBhZG1pbnMgbXVzdCByZXZpZXcgYW5kIHBpbi5cIjtcbiAgdGl0bGVTdGFjay5hcHBlbmRDaGlsZCh0aXRsZSk7XG4gIHRpdGxlU3RhY2suYXBwZW5kQ2hpbGQoc3VidGl0bGUpO1xuICBoZWFkZXIuYXBwZW5kQ2hpbGQodGl0bGVTdGFjayk7XG4gIGhlYWRlci5hcHBlbmRDaGlsZChjb21wYWN0QnV0dG9uKFwiRGlzbWlzc1wiLCAoKSA9PiBvdmVybGF5LnJlbW92ZSgpKSk7XG4gIGRpYWxvZy5hcHBlbmRDaGlsZChoZWFkZXIpO1xuXG4gIGNvbnN0IHJlcG9JbnB1dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJpbnB1dFwiKTtcbiAgcmVwb0lucHV0LnR5cGUgPSBcInRleHRcIjtcbiAgcmVwb0lucHV0LnBsYWNlaG9sZGVyID0gXCJvd25lci9yZXBvIG9yIGh0dHBzOi8vZ2l0aHViLmNvbS9vd25lci9yZXBvXCI7XG4gIHJlcG9JbnB1dC5jbGFzc05hbWUgPVxuICAgIFwiaC0xMCByb3VuZGVkLWxnIGJvcmRlciBib3JkZXItdG9rZW4tYm9yZGVyIGJnLXRyYW5zcGFyZW50IHB4LTMgdGV4dC1zbSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeSBmb2N1czpvdXRsaW5lLW5vbmVcIjtcbiAgZGlhbG9nLmFwcGVuZENoaWxkKHJlcG9JbnB1dCk7XG5cbiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJUaGUgbWFuaWZlc3Qgc2hvdWxkIGluY2x1ZGUgYW4gaWNvblVybCBzdWl0YWJsZSBmb3IgdGhlIHN0b3JlLlwiO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoc3RhdHVzKTtcblxuICBjb25zdCBhY3Rpb25zID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgYWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktZW5kIGdhcC0yXCI7XG4gIGNvbnN0IHN1Ym1pdCA9IGNvbXBhY3RCdXR0b24oXCJPcGVuIFJldmlldyBJc3N1ZVwiLCAoKSA9PiB7XG4gICAgdm9pZCBzdWJtaXRQdWJsaXNoVHdlYWsocmVwb0lucHV0LCBzdGF0dXMpO1xuICB9KTtcbiAgYWN0aW9ucy5hcHBlbmRDaGlsZChzdWJtaXQpO1xuICBkaWFsb2cuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgb3ZlcmxheS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIG92ZXJsYXkucmVtb3ZlKCk7XG4gIH0pO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuICByZXBvSW5wdXQuZm9jdXMoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gc3VibWl0UHVibGlzaFR3ZWFrKFxuICByZXBvSW5wdXQ6IEhUTUxJbnB1dEVsZW1lbnQsXG4gIHN0YXR1czogSFRNTEVsZW1lbnQsXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1zZWNvbmRhcnlcIjtcbiAgc3RhdHVzLnRleHRDb250ZW50ID0gXCJSZXNvbHZpbmcgdGhlIHJlcG8gY29tbWl0IHRvIHJldmlldy5cIjtcbiAgdHJ5IHtcbiAgICBjb25zdCBzdWJtaXNzaW9uID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnByZXBhcmUtdHdlYWstc3RvcmUtc3VibWlzc2lvblwiLFxuICAgICAgcmVwb0lucHV0LnZhbHVlLFxuICAgICkgYXMgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uO1xuICAgIGNvbnN0IHVybCA9IGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwoc3VibWlzc2lvbik7XG4gICAgYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpvcGVuLWV4dGVybmFsXCIsIHVybCk7XG4gICAgc3RhdHVzLnRleHRDb250ZW50ID0gYEdpdEh1YiByZXZpZXcgaXNzdWUgb3BlbmVkIGZvciAke3N1Ym1pc3Npb24uY29tbWl0U2hhLnNsaWNlKDAsIDcpfS5gO1xuICB9IGNhdGNoIChlKSB7XG4gICAgc3RhdHVzLmNsYXNzTmFtZSA9IFwibWluLWgtNSB0ZXh0LXNtIHRleHQtdG9rZW4tY2hhcnRzLXJlZFwiO1xuICAgIHN0YXR1cy50ZXh0Q29udGVudCA9IFN0cmluZygoZSBhcyBFcnJvcikubWVzc2FnZSA/PyBlKTtcbiAgfVxufVxuXG4vLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDAgY29tcG9uZW50cyBcdTI1MDBcdTI1MDBcblxuLyoqIFRoZSBmdWxsIHBhbmVsIHNoZWxsICh0b29sYmFyICsgc2Nyb2xsICsgaGVhZGluZyArIHNlY3Rpb25zIHdyYXApLiAqL1xuZnVuY3Rpb24gcGFuZWxTaGVsbChcbiAgdGl0bGU6IHN0cmluZyxcbiAgc3VidGl0bGU/OiBzdHJpbmcsXG4gIG9wdGlvbnM/OiB7IHdpZGU/OiBib29sZWFuOyB3aWR0aD86IFwiZGVmYXVsdFwiIHwgXCJwbHVnaW5zXCIgfCBcIndpZGVcIiB9LFxuKToge1xuICBvdXRlcjogSFRNTEVsZW1lbnQ7XG4gIHNlY3Rpb25zV3JhcDogSFRNTEVsZW1lbnQ7XG4gIHN1YnRpdGxlPzogSFRNTEVsZW1lbnQ7XG4gIGhlYWRlckFjdGlvbnM6IEhUTUxFbGVtZW50O1xuICBoZWFkZXJUaXRsZUFjdGlvbnM6IEhUTUxFbGVtZW50O1xufSB7XG4gIGNvbnN0IG91dGVyID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3V0ZXIuY2xhc3NOYW1lID0gXCJtYWluLXN1cmZhY2UgZmxleCBoLWZ1bGwgbWluLWgtMCBmbGV4LWNvbFwiO1xuXG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0b29sYmFyLmNsYXNzTmFtZSA9XG4gICAgXCJkcmFnZ2FibGUgZmxleCBpdGVtcy1jZW50ZXIgcHgtcGFuZWwgZWxlY3Ryb246aC10b29sYmFyIGV4dGVuc2lvbjpoLXRvb2xiYXItc21cIjtcbiAgb3V0ZXIuYXBwZW5kQ2hpbGQodG9vbGJhcik7XG5cbiAgY29uc3Qgc2Nyb2xsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgc2Nyb2xsLmNsYXNzTmFtZSA9IFwiZmxleC0xIG92ZXJmbG93LXktYXV0byBwLXBhbmVsXCI7XG4gIG91dGVyLmFwcGVuZENoaWxkKHNjcm9sbCk7XG5cbiAgY29uc3QgaW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjb25zdCB3aWR0aCA9IG9wdGlvbnM/LndpZHRoID8/IChvcHRpb25zPy53aWRlID8gXCJ3aWRlXCIgOiBcImRlZmF1bHRcIik7XG4gIGlubmVyLmNsYXNzTmFtZSA9IFtcbiAgICBcIm14LWF1dG8gZmxleCB3LWZ1bGwgZmxleC1jb2wgZWxlY3Ryb246bWluLXctW2NhbGMoMzIwcHgqdmFyKC0tY29kZXgtd2luZG93LXpvb20pKV1cIixcbiAgICB3aWR0aCA9PT0gXCJ3aWRlXCIgPyBcIm1heC13LTV4bFwiIDogd2lkdGggPT09IFwicGx1Z2luc1wiID8gXCJtYXgtdy0zeGxcIiA6IFwibWF4LXctMnhsXCIsXG4gIF0uam9pbihcIiBcIik7XG4gIHNjcm9sbC5hcHBlbmRDaGlsZChpbm5lcik7XG5cbiAgY29uc3QgaGVhZGVyV3JhcCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlcldyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTMgcGItcGFuZWxcIjtcbiAgY29uc3QgaGVhZGVySW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkZXJJbm5lci5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LTEgZmxleC1jb2wgZ2FwLTEuNSBwYi1wYW5lbFwiO1xuICBjb25zdCB0aXRsZUxpbmUgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUxpbmUuY2xhc3NOYW1lID0gXCJmbGV4IG1pbi13LTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIGNvbnN0IGhlYWRpbmcgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBoZWFkaW5nLmNsYXNzTmFtZSA9IFwiZWxlY3Ryb246aGVhZGluZy1sZyBoZWFkaW5nLWJhc2UgdHJ1bmNhdGVcIjtcbiAgaGVhZGluZy50ZXh0Q29udGVudCA9IHRpdGxlO1xuICB0aXRsZUxpbmUuYXBwZW5kQ2hpbGQoaGVhZGluZyk7XG4gIGNvbnN0IGhlYWRlclRpdGxlQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlclRpdGxlQWN0aW9ucy5jbGFzc05hbWUgPSBcImZsZXggc2hyaW5rLTAgaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gIHRpdGxlTGluZS5hcHBlbmRDaGlsZChoZWFkZXJUaXRsZUFjdGlvbnMpO1xuICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZCh0aXRsZUxpbmUpO1xuICBsZXQgc3VidGl0bGVFbGVtZW50OiBIVE1MRWxlbWVudCB8IHVuZGVmaW5lZDtcbiAgaWYgKHN1YnRpdGxlKSB7XG4gICAgY29uc3Qgc3ViID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBzdWIuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IHRleHQtc21cIjtcbiAgICBzdWIudGV4dENvbnRlbnQgPSBzdWJ0aXRsZTtcbiAgICBoZWFkZXJJbm5lci5hcHBlbmRDaGlsZChzdWIpO1xuICAgIHN1YnRpdGxlRWxlbWVudCA9IHN1YjtcbiAgfVxuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlcklubmVyKTtcbiAgY29uc3QgaGVhZGVyQWN0aW9ucyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGhlYWRlckFjdGlvbnMuY2xhc3NOYW1lID0gXCJmbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciBnYXAtMlwiO1xuICBoZWFkZXJXcmFwLmFwcGVuZENoaWxkKGhlYWRlckFjdGlvbnMpO1xuICBpbm5lci5hcHBlbmRDaGlsZChoZWFkZXJXcmFwKTtcblxuICBjb25zdCBzZWN0aW9uc1dyYXAgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzZWN0aW9uc1dyYXAuY2xhc3NOYW1lID0gXCJmbGV4IGZsZXgtY29sIGdhcC1bdmFyKC0tcGFkZGluZy1wYW5lbCldXCI7XG4gIGlubmVyLmFwcGVuZENoaWxkKHNlY3Rpb25zV3JhcCk7XG5cbiAgcmV0dXJuIHsgb3V0ZXIsIHNlY3Rpb25zV3JhcCwgc3VidGl0bGU6IHN1YnRpdGxlRWxlbWVudCwgaGVhZGVyQWN0aW9ucywgaGVhZGVyVGl0bGVBY3Rpb25zIH07XG59XG5cbmZ1bmN0aW9uIHNlY3Rpb25UaXRsZSh0ZXh0OiBzdHJpbmcsIHRyYWlsaW5nPzogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IHRpdGxlUm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdGl0bGVSb3cuY2xhc3NOYW1lID1cbiAgICBcImZsZXggaC10b29sYmFyIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIgcHgtMCBweS0wXCI7XG4gIGNvbnN0IHRpdGxlSW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICB0aXRsZUlubmVyLmNsYXNzTmFtZSA9IFwiZmxleCBtaW4tdy0wIGZsZXgtMSBmbGV4LWNvbCBnYXAtMVwiO1xuICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgdC5jbGFzc05hbWUgPSBcInRleHQtYmFzZSBmb250LW1lZGl1bSB0ZXh0LXRva2VuLXRleHQtcHJpbWFyeVwiO1xuICB0LnRleHRDb250ZW50ID0gdGV4dDtcbiAgdGl0bGVJbm5lci5hcHBlbmRDaGlsZCh0KTtcbiAgdGl0bGVSb3cuYXBwZW5kQ2hpbGQodGl0bGVJbm5lcik7XG4gIGlmICh0cmFpbGluZykge1xuICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByaWdodC5jbGFzc05hbWUgPSBcImZsZXggaXRlbXMtY2VudGVyIGdhcC0yXCI7XG4gICAgcmlnaHQuYXBwZW5kQ2hpbGQodHJhaWxpbmcpO1xuICAgIHRpdGxlUm93LmFwcGVuZENoaWxkKHJpZ2h0KTtcbiAgfVxuICByZXR1cm4gdGl0bGVSb3c7XG59XG5cbi8qKlxuICogQ29kZXgncyBcIk9wZW4gY29uZmlnLnRvbWxcIi1zdHlsZSB0cmFpbGluZyBidXR0b246IGdob3N0IGJvcmRlciwgbXV0ZWRcbiAqIGxhYmVsLCB0b3AtcmlnaHQgZGlhZ29uYWwgYXJyb3cgaWNvbi4gTWFya3VwIG1pcnJvcnMgQ29uZmlndXJhdGlvbiBwYW5lbC5cbiAqL1xuZnVuY3Rpb24gb3BlbkluUGxhY2VCdXR0b24obGFiZWw6IHN0cmluZywgb25DbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYnRuID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImJ1dHRvblwiKTtcbiAgYnRuLnR5cGUgPSBcImJ1dHRvblwiO1xuICBidG4uY2xhc3NOYW1lID1cbiAgICBcImJvcmRlci10b2tlbi1ib3JkZXIgdXNlci1zZWxlY3Qtbm9uZSBuby1kcmFnIGN1cnNvci1pbnRlcmFjdGlvbiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBib3JkZXIgd2hpdGVzcGFjZS1ub3dyYXAgZm9jdXM6b3V0bGluZS1ub25lIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwIHJvdW5kZWQtbGcgdGV4dC10b2tlbi1kZXNjcmlwdGlvbi1mb3JlZ3JvdW5kIGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRhdGEtW3N0YXRlPW9wZW5dOmJnLXRva2VuLWxpc3QtaG92ZXItYmFja2dyb3VuZCBib3JkZXItdHJhbnNwYXJlbnQgaC10b2tlbi1idXR0b24tY29tcG9zZXIgcHgtMiBweS0wIHRleHQtYmFzZSBsZWFkaW5nLVsxOHB4XVwiO1xuICBidG4uaW5uZXJIVE1MID1cbiAgICBgJHtsYWJlbH1gICtcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLTJ4c1wiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE0LjMzNDkgMTMuMzMwMVY2LjYwNjQ1TDUuNDcwNjUgMTUuNDcwN0M1LjIxMDk1IDE1LjczMDQgNC43ODg5NSAxNS43MzA0IDQuNTI5MjUgMTUuNDcwN0M0LjI2OTU1IDE1LjIxMSA0LjI2OTU1IDE0Ljc4OSA0LjUyOTI1IDE0LjUyOTNMMTMuMzkzNSA1LjY2NTA0SDYuNjYwMTFDNi4yOTI4NCA1LjY2NTA0IDUuOTk1MDcgNS4zNjcyNyA1Ljk5NTA3IDVDNS45OTUwNyA0LjYzMjczIDYuMjkyODQgNC4zMzQ5NiA2LjY2MDExIDQuMzM0OTZIMTQuOTk5OUwxNS4xMzM3IDQuMzQ4NjNDMTUuNDM2OSA0LjQxMDU3IDE1LjY2NSA0LjY3ODU3IDE1LjY2NSA1VjEzLjMzMDFDMTUuNjY0OSAxMy42OTczIDE1LjM2NzIgMTMuOTk1MSAxNC45OTk5IDEzLjk5NTFDMTQuNjMyNyAxMy45OTUxIDE0LjMzNSAxMy42OTczIDE0LjMzNDkgMTMuMzMwMVpcIiBmaWxsPVwiY3VycmVudENvbG9yXCI+PC9wYXRoPmAgK1xuICAgIGA8L3N2Zz5gO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gY29tcGFjdEJ1dHRvbihsYWJlbDogc3RyaW5nLCBvbkNsaWNrOiAoKSA9PiB2b2lkKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciB1c2VyLXNlbGVjdC1ub25lIG5vLWRyYWcgY3Vyc29yLWludGVyYWN0aW9uIGlubGluZS1mbGV4IGgtOCBpdGVtcy1jZW50ZXIgd2hpdGVzcGFjZS1ub3dyYXAgcm91bmRlZC1sZyBib3JkZXIgcHgtMiB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5IGVuYWJsZWQ6aG92ZXI6YmctdG9rZW4tbGlzdC1ob3Zlci1iYWNrZ3JvdW5kIGRpc2FibGVkOmN1cnNvci1ub3QtYWxsb3dlZCBkaXNhYmxlZDpvcGFjaXR5LTQwXCI7XG4gIGJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7XG4gICAgb25DbGljaygpO1xuICB9KTtcbiAgcmV0dXJuIGJ0bjtcbn1cblxuZnVuY3Rpb24gcm91bmRlZENhcmQoKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBjYXJkID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2FyZC5jbGFzc05hbWUgPVxuICAgIFwiYm9yZGVyLXRva2VuLWJvcmRlciBmbGV4IGZsZXgtY29sIGRpdmlkZS15LVswLjVweF0gZGl2aWRlLXRva2VuLWJvcmRlciByb3VuZGVkLWxnIGJvcmRlclwiO1xuICBjYXJkLnNldEF0dHJpYnV0ZShcbiAgICBcInN0eWxlXCIsXG4gICAgXCJiYWNrZ3JvdW5kLWNvbG9yOiB2YXIoLS1jb2xvci1iYWNrZ3JvdW5kLXBhbmVsLCB2YXIoLS1jb2xvci10b2tlbi1iZy1mb2cpKTtcIixcbiAgKTtcbiAgcmV0dXJuIGNhcmQ7XG59XG5cbmZ1bmN0aW9uIHJvd1NpbXBsZSh0aXRsZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBkZXNjcmlwdGlvbj86IHN0cmluZyk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3Qgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcm93LmNsYXNzTmFtZSA9IFwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC00IHAtM1wiO1xuICBjb25zdCBsZWZ0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbGVmdC5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBpdGVtcy1jZW50ZXIgZ2FwLTNcIjtcbiAgY29uc3Qgc3RhY2sgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBzdGFjay5jbGFzc05hbWUgPSBcImZsZXggbWluLXctMCBmbGV4LWNvbCBnYXAtMVwiO1xuICBpZiAodGl0bGUpIHtcbiAgICBjb25zdCB0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB0LmNsYXNzTmFtZSA9IFwibWluLXctMCB0ZXh0LXNtIHRleHQtdG9rZW4tdGV4dC1wcmltYXJ5XCI7XG4gICAgdC50ZXh0Q29udGVudCA9IHRpdGxlO1xuICAgIHN0YWNrLmFwcGVuZENoaWxkKHQpO1xuICB9XG4gIGlmIChkZXNjcmlwdGlvbikge1xuICAgIGNvbnN0IGQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIGQuY2xhc3NOYW1lID0gXCJ0ZXh0LXRva2VuLXRleHQtc2Vjb25kYXJ5IG1pbi13LTAgdGV4dC1zbVwiO1xuICAgIGQudGV4dENvbnRlbnQgPSBkZXNjcmlwdGlvbjtcbiAgICBzdGFjay5hcHBlbmRDaGlsZChkKTtcbiAgfVxuICBsZWZ0LmFwcGVuZENoaWxkKHN0YWNrKTtcbiAgcm93LmFwcGVuZENoaWxkKGxlZnQpO1xuICByZXR1cm4gcm93O1xufVxuXG4vKipcbiAqIENvZGV4LXN0eWxlZCB0b2dnbGUgc3dpdGNoLiBNYXJrdXAgbWlycm9ycyB0aGUgR2VuZXJhbCA+IFBlcm1pc3Npb25zIHJvd1xuICogc3dpdGNoIHdlIGNhcHR1cmVkOiBvdXRlciBidXR0b24gKHJvbGU9c3dpdGNoKSwgaW5uZXIgcGlsbCwgc2xpZGluZyBrbm9iLlxuICovXG5mdW5jdGlvbiBzd2l0Y2hDb250cm9sKFxuICBpbml0aWFsOiBib29sZWFuLFxuICBvbkNoYW5nZTogKG5leHQ6IGJvb2xlYW4pID0+IHZvaWQgfCBQcm9taXNlPHZvaWQ+LFxuKTogSFRNTEJ1dHRvbkVsZW1lbnQge1xuICBjb25zdCBidG4gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICBidG4udHlwZSA9IFwiYnV0dG9uXCI7XG4gIGJ0bi5zZXRBdHRyaWJ1dGUoXCJyb2xlXCIsIFwic3dpdGNoXCIpO1xuXG4gIGNvbnN0IHBpbGwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgY29uc3Qga25vYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBrbm9iLmNsYXNzTmFtZSA9XG4gICAgXCJyb3VuZGVkLWZ1bGwgYm9yZGVyIGJvcmRlci1bY29sb3I6dmFyKC0tZ3JheS0wKV0gYmctW2NvbG9yOnZhcigtLWdyYXktMCldIHNoYWRvdy1zbSB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgZWFzZS1vdXQgaC00IHctNFwiO1xuICBwaWxsLmFwcGVuZENoaWxkKGtub2IpO1xuXG4gIGNvbnN0IGFwcGx5ID0gKG9uOiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgYnRuLnNldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiLCBTdHJpbmcob24pKTtcbiAgICBidG4uZGF0YXNldC5zdGF0ZSA9IG9uID8gXCJjaGVja2VkXCIgOiBcInVuY2hlY2tlZFwiO1xuICAgIGJ0bi5jbGFzc05hbWUgPVxuICAgICAgXCJpbmxpbmUtZmxleCBpdGVtcy1jZW50ZXIgdGV4dC1zbSBmb2N1cy12aXNpYmxlOm91dGxpbmUtbm9uZSBmb2N1cy12aXNpYmxlOnJpbmctMiBmb2N1cy12aXNpYmxlOnJpbmctdG9rZW4tZm9jdXMtYm9yZGVyIGZvY3VzLXZpc2libGU6cm91bmRlZC1mdWxsIGN1cnNvci1pbnRlcmFjdGlvblwiO1xuICAgIHBpbGwuY2xhc3NOYW1lID0gYHJlbGF0aXZlIGlubGluZS1mbGV4IHNocmluay0wIGl0ZW1zLWNlbnRlciByb3VuZGVkLWZ1bGwgdHJhbnNpdGlvbi1jb2xvcnMgZHVyYXRpb24tMjAwIGVhc2Utb3V0IGgtNSB3LTggJHtcbiAgICAgIG9uID8gXCJiZy10b2tlbi1jaGFydHMtYmx1ZVwiIDogXCJiZy10b2tlbi1mb3JlZ3JvdW5kLzIwXCJcbiAgICB9YDtcbiAgICBwaWxsLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLmRhdGFzZXQuc3RhdGUgPSBvbiA/IFwiY2hlY2tlZFwiIDogXCJ1bmNoZWNrZWRcIjtcbiAgICBrbm9iLnN0eWxlLnRyYW5zZm9ybSA9IG9uID8gXCJ0cmFuc2xhdGVYKDE0cHgpXCIgOiBcInRyYW5zbGF0ZVgoMnB4KVwiO1xuICB9O1xuICBhcHBseShpbml0aWFsKTtcblxuICBidG4uYXBwZW5kQ2hpbGQocGlsbCk7XG4gIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgZS5zdG9wUHJvcGFnYXRpb24oKTtcbiAgICBjb25zdCBuZXh0ID0gYnRuLmdldEF0dHJpYnV0ZShcImFyaWEtY2hlY2tlZFwiKSAhPT0gXCJ0cnVlXCI7XG4gICAgYXBwbHkobmV4dCk7XG4gICAgYnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgb25DaGFuZ2UobmV4dCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBidG47XG59XG5cbi8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMCBpY29ucyBcdTI1MDBcdTI1MDBcblxuZnVuY3Rpb24gY29uZmlnSWNvblN2ZygpOiBzdHJpbmcge1xuICAvLyBTbGlkZXJzIC8gc2V0dGluZ3MgZ2x5cGguIDIweDIwIGN1cnJlbnRDb2xvci5cbiAgcmV0dXJuIChcbiAgICBgPHN2ZyB3aWR0aD1cIjIwXCIgaGVpZ2h0PVwiMjBcIiB2aWV3Qm94PVwiMCAwIDIwIDIwXCIgZmlsbD1cIm5vbmVcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgY2xhc3M9XCJpY29uLXNtIGlubGluZS1ibG9jayBhbGlnbi1taWRkbGVcIiBhcmlhLWhpZGRlbj1cInRydWVcIj5gICtcbiAgICBgPHBhdGggZD1cIk0zIDVoOU0xNSA1aDJNMyAxMGgyTTggMTBoOU0zIDE1aDExTTE3IDE1aDBcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8Y2lyY2xlIGN4PVwiMTNcIiBjeT1cIjVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPGNpcmNsZSBjeD1cIjZcIiBjeT1cIjEwXCIgcj1cIjEuNlwiIGZpbGw9XCJjdXJyZW50Q29sb3JcIi8+YCArXG4gICAgYDxjaXJjbGUgY3g9XCIxNVwiIGN5PVwiMTVcIiByPVwiMS42XCIgZmlsbD1cImN1cnJlbnRDb2xvclwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiB0d2Vha3NJY29uU3ZnKCk6IHN0cmluZyB7XG4gIC8vIFNwYXJrbGVzIC8gXCIrK1wiIGdseXBoIGZvciB0d2Vha3MuXG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTAgMi41IEwxMS40IDguNiBMMTcuNSAxMCBMMTEuNCAxMS40IEwxMCAxNy41IEw4LjYgMTEuNCBMMi41IDEwIEw4LjYgOC42IFpcIiBmaWxsPVwiY3VycmVudENvbG9yXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTE1LjUgMyBMMTYgNSBMMTggNS41IEwxNiA2IEwxNS41IDggTDE1IDYgTDEzIDUuNSBMMTUgNSBaXCIgZmlsbD1cImN1cnJlbnRDb2xvclwiIG9wYWNpdHk9XCIwLjdcIi8+YCArXG4gICAgYDwvc3ZnPmBcbiAgKTtcbn1cblxuZnVuY3Rpb24gc3RvcmVJY29uU3ZnKCk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgYDxzdmcgd2lkdGg9XCIyMFwiIGhlaWdodD1cIjIwXCIgdmlld0JveD1cIjAgMCAyMCAyMFwiIGZpbGw9XCJub25lXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIGNsYXNzPVwiaWNvbi1zbSBpbmxpbmUtYmxvY2sgYWxpZ24tbWlkZGxlXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+YCArXG4gICAgYDxwYXRoIGQ9XCJNNCA4LjIgNS4xIDQuNUExLjUgMS41IDAgMCAxIDYuNTUgMy40aDYuOWExLjUgMS41IDAgMCAxIDEuNDUgMS4xTDE2IDguMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTQuNSA4aDExdjcuNUExLjUgMS41IDAgMCAxIDE0IDE3SDZhMS41IDEuNSAwIDAgMS0xLjUtMS41VjhaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNNy41IDh2MWEyLjUgMi41IDAgMCAwIDUgMFY4XCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVjYXA9XCJyb3VuZFwiLz5gICtcbiAgICBgPC9zdmc+YFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0UGFnZUljb25TdmcoKTogc3RyaW5nIHtcbiAgLy8gRG9jdW1lbnQvcGFnZSBnbHlwaCBmb3IgdHdlYWstcmVnaXN0ZXJlZCBwYWdlcyB3aXRob3V0IHRoZWlyIG93biBpY29uLlxuICByZXR1cm4gKFxuICAgIGA8c3ZnIHdpZHRoPVwiMjBcIiBoZWlnaHQ9XCIyMFwiIHZpZXdCb3g9XCIwIDAgMjAgMjBcIiBmaWxsPVwibm9uZVwiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiBjbGFzcz1cImljb24tc20gaW5saW5lLWJsb2NrIGFsaWduLW1pZGRsZVwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPmAgK1xuICAgIGA8cGF0aCBkPVwiTTUgM2g3bDMgM3YxMWExIDEgMCAwIDEtMSAxSDVhMSAxIDAgMCAxLTEtMVY0YTEgMSAwIDAgMSAxLTFaXCIgc3Ryb2tlPVwiY3VycmVudENvbG9yXCIgc3Ryb2tlLXdpZHRoPVwiMS41XCIgc3Ryb2tlLWxpbmVqb2luPVwicm91bmRcIi8+YCArXG4gICAgYDxwYXRoIGQ9XCJNMTIgM3YzYTEgMSAwIDAgMCAxIDFoMlwiIHN0cm9rZT1cImN1cnJlbnRDb2xvclwiIHN0cm9rZS13aWR0aD1cIjEuNVwiIHN0cm9rZS1saW5lam9pbj1cInJvdW5kXCIvPmAgK1xuICAgIGA8cGF0aCBkPVwiTTcgMTFoNk03IDE0aDRcIiBzdHJva2U9XCJjdXJyZW50Q29sb3JcIiBzdHJva2Utd2lkdGg9XCIxLjVcIiBzdHJva2UtbGluZWNhcD1cInJvdW5kXCIvPmAgK1xuICAgIGA8L3N2Zz5gXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc29sdmVJY29uVXJsKFxuICB1cmw6IHN0cmluZyxcbiAgdHdlYWtEaXI6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoL14oaHR0cHM/OnxkYXRhOikvLnRlc3QodXJsKSkgcmV0dXJuIHVybDtcbiAgLy8gUmVsYXRpdmUgcGF0aCBcdTIxOTIgYXNrIG1haW4gdG8gcmVhZCB0aGUgZmlsZSBhbmQgcmV0dXJuIGEgZGF0YTogVVJMLlxuICAvLyBSZW5kZXJlciBpcyBzYW5kYm94ZWQgc28gZmlsZTovLyB3b24ndCBsb2FkIGRpcmVjdGx5LlxuICBjb25zdCByZWwgPSB1cmwuc3RhcnRzV2l0aChcIi4vXCIpID8gdXJsLnNsaWNlKDIpIDogdXJsO1xuICB0cnkge1xuICAgIHJldHVybiAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgXCJ0d2Vha2VyOnJlYWQtdHdlYWstYXNzZXRcIixcbiAgICAgIHR3ZWFrRGlyLFxuICAgICAgcmVsLFxuICAgICkpIGFzIHN0cmluZztcbiAgfSBjYXRjaCAoZSkge1xuICAgIHBsb2coXCJpY29uIGxvYWQgZmFpbGVkXCIsIHsgdXJsLCB0d2Vha0RpciwgZXJyOiBTdHJpbmcoZSkgfSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwIERPTSBoZXVyaXN0aWNzIFx1MjUwMFx1MjUwMFxuXG5mdW5jdGlvbiBmaW5kU2lkZWJhckl0ZW1zR3JvdXAoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3QgY2FuZGlkYXRlcyA9IEFycmF5LmZyb20oXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJhc2lkZSxuYXYsW3JvbGU9J25hdmlnYXRpb24nXSxkaXZcIiksXG4gICk7XG5cbiAgbGV0IGJlc3Q6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gIGxldCBiZXN0U2NvcmUgPSAtMTtcbiAgbGV0IGJlc3RBcmVhID0gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuXG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBpZiAoY2FuZGlkYXRlLmRhdGFzZXQudHdlYWtlcikgY29udGludWU7XG4gICAgaWYgKCFpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShjYW5kaWRhdGUpKSBjb250aW51ZTtcblxuICAgIGNvbnN0IGxhYmVscyA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oY2FuZGlkYXRlKTtcbiAgICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgICBjb25zdCByZWN0ID0gY2FuZGlkYXRlLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAgIGNvbnN0IGFyZWEgPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XG4gICAgY29uc3Qgd2VpZ2h0ZWQgPSBzY29yZS5jb3JlICogMTAwICsgc2NvcmUudG90YWw7XG5cbiAgICBpZiAod2VpZ2h0ZWQgPiBiZXN0U2NvcmUgfHwgKHdlaWdodGVkID09PSBiZXN0U2NvcmUgJiYgYXJlYSA8IGJlc3RBcmVhKSkge1xuICAgICAgYmVzdCA9IGNhbmRpZGF0ZTtcbiAgICAgIGJlc3RTY29yZSA9IHdlaWdodGVkO1xuICAgICAgYmVzdEFyZWEgPSBhcmVhO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBiZXN0O1xufVxuXG5jb25zdCBGT1JCSURERU5fU0VUVElOR1NfU0lERUJBUl9TRUxFQ1RPUiA9IFtcbiAgXCJbZGF0YS1jb21wb3Nlci1vdmVybGF5LWZsb2F0aW5nLXVpPSd0cnVlJ11cIixcbiAgXCJbZGF0YS10d2Vha2VyLXNsYXNoLW1lbnU9J3RydWUnXVwiLFxuICBcIltkYXRhLXR3ZWFrZXItb3ZlcmxheS1ub2lzZT0ndHJ1ZSddXCIsXG4gIFwiLmNvbXBvc2VyLWhvbWUtdG9wLW1lbnVcIixcbiAgXCIudmVydGljYWwtc2Nyb2xsLWZhZGUtbWFza1wiLFxuICBcIltjbGFzcyo9J1tjb250YWluZXItbmFtZTpob21lLW1haW4tY29udGVudF0nXVwiLFxuXS5qb2luKFwiLFwiKTtcblxuZnVuY3Rpb24gaXNGb3JiaWRkZW5TZXR0aW5nc1NpZGViYXJTdXJmYWNlKG5vZGU6IEVsZW1lbnQgfCBudWxsKTogYm9vbGVhbiB7XG4gIGlmICghbm9kZSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlbCA9IG5vZGUgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IG5vZGUgOiBub2RlLnBhcmVudEVsZW1lbnQ7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKGVsLmNsb3Nlc3QoRk9SQklEREVOX1NFVFRJTkdTX1NJREVCQVJfU0VMRUNUT1IpKSByZXR1cm4gdHJ1ZTtcbiAgaWYgKGVsLnF1ZXJ5U2VsZWN0b3IoXCJbZGF0YS1saXN0LW5hdmlnYXRpb24taXRlbT0ndHJ1ZSddLCBbY21kay1pdGVtXVwiKSkgcmV0dXJuIHRydWU7XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gaXNTZXR0aW5nc1NpZGViYXJDYW5kaWRhdGUoZWw6IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XG4gIGNvbnN0IHJlY3QgPSB0d2Vha2VyVmlzaWJsZUJveChlbCk7XG4gIGlmICghcmVjdCkgcmV0dXJuIGZhbHNlO1xuXG4gIGNvbnN0IGxhYmVscyA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsc0Zyb20oZWwpO1xuICBjb25zdCBzY29yZSA9IHR3ZWFrZXJTZXR0aW5nc0xhYmVsU2NvcmUobGFiZWxzKTtcbiAgcmV0dXJuIGlzTmF0aXZlU2V0dGluZ3NTaWRlYmFyRXZpZGVuY2Uoe1xuICAgIHdpZHRoOiByZWN0LndpZHRoLFxuICAgIGhlaWdodDogcmVjdC5oZWlnaHQsXG4gICAgbGVmdDogcmVjdC5sZWZ0LFxuICAgIHZpZXdwb3J0V2lkdGg6IHdpbmRvdy5pbm5lcldpZHRoLFxuICAgIGZvcmJpZGRlblN1cmZhY2U6IGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShlbCksXG4gICAgbmF0aXZlUGFuZWxTbHVnQ291bnQ6IG5hdGl2ZVNldHRpbmdzUGFuZWxTbHVnQ291bnQoZWwpLFxuICAgIGNvcmVMYWJlbENvdW50OiBzY29yZS5jb3JlLFxuICAgIHRvdGFsTGFiZWxDb3VudDogc2NvcmUudG90YWwsXG4gICAgbWFpbkFwcExhYmVsQ291bnQ6IHR3ZWFrZXJNYXJrZXJDb3VudChsYWJlbHMsIFRXRUFLRVJfTUFJTl9BUFBfTkFWX0xBQkVMUyksXG4gICAgc2V0dGluZ3NPbmx5TGFiZWxDb3VudDogdHdlYWtlck1hcmtlckNvdW50KGxhYmVscywgVFdFQUtFUl9TRVRUSU5HU19PTkxZX0xBQkVMUyksXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZW1vdmVNaXNwbGFjZWRTZXR0aW5nc0dyb3VwcygpOiB2b2lkIHtcbiAgY29uc3QgZ3JvdXBzID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXG4gICAgXCJbZGF0YS10d2Vha2VyPSduYXYtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0ncGFnZXMtZ3JvdXAnXSwgW2RhdGEtdHdlYWtlcj0nbmF0aXZlLW5hdi1oZWFkZXInXVwiLFxuICApO1xuICBmb3IgKGNvbnN0IGdyb3VwIG9mIEFycmF5LmZyb20oZ3JvdXBzKSkge1xuICAgIGlmIChpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cCkpIGNvbnRpbnVlO1xuICAgIHJlc2V0VHdlYWtlckluamVjdGVkU2V0dGluZ3NHcm91cFN0YXRlKGdyb3VwKTtcbiAgICBncm91cC5yZW1vdmUoKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1R3ZWFrZXJJbmplY3RlZFNldHRpbmdzR3JvdXBQbGFjZW1lbnRWYWxpZChncm91cDogSFRNTEVsZW1lbnQpOiBib29sZWFuIHtcbiAgaWYgKGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShncm91cCkpIHJldHVybiBmYWxzZTtcblxuICAvLyBLZWVwIHRoZSBpbmplY3Rpb24tdGltZSBwbGFjZW1lbnQgb25seSB3aGlsZSB0aGUgY29ubmVjdGVkIHJvb3Qgc3RpbGxcbiAgLy8gb3ducyBuYXRpdmUgU2V0dGluZ3Mgcm93cy4gVGhpcyBhdm9pZHMgbGF5b3V0LWRlcGVuZGVudCByZS1qdWRnaW5nIHdoaWxlXG4gIC8vIGVuc3VyaW5nIGEgZmFsc2UtcG9zaXRpdmUgdGhyZWFkIG9yIHNpZGUgcGFuZWwgY2Fubm90IHJldGFpbiB0aGUgZ3JvdXAuXG4gIGlmIChcbiAgICBzdGF0ZS5zaWRlYmFyUm9vdCAmJlxuICAgIHN0YXRlLnNpZGViYXJSb290LmlzQ29ubmVjdGVkICYmXG4gICAgKGdyb3VwLnBhcmVudEVsZW1lbnQgPT09IHN0YXRlLnNpZGViYXJSb290IHx8IHN0YXRlLnNpZGViYXJSb290LmNvbnRhaW5zKGdyb3VwKSlcbiAgKSB7XG4gICAgcmV0dXJuIGhhc05hdGl2ZVNldHRpbmdzU2lkZWJhck93bmVyc2hpcCh7XG4gICAgICBmb3JiaWRkZW5TdXJmYWNlOiBpc0ZvcmJpZGRlblNldHRpbmdzU2lkZWJhclN1cmZhY2Uoc3RhdGUuc2lkZWJhclJvb3QpLFxuICAgICAgbmF0aXZlUGFuZWxTbHVnQ291bnQ6IG5hdGl2ZVNldHRpbmdzUGFuZWxTbHVnQ291bnQoc3RhdGUuc2lkZWJhclJvb3QpLFxuICAgIH0pO1xuICB9XG5cbiAgbGV0IG5vZGUgPSBncm91cC5wYXJlbnRFbGVtZW50O1xuICBmb3IgKGxldCBkZXB0aCA9IDA7IG5vZGUgJiYgZGVwdGggPCA0OyBkZXB0aCsrKSB7XG4gICAgaWYgKGlzRm9yYmlkZGVuU2V0dGluZ3NTaWRlYmFyU3VyZmFjZShub2RlKSkgcmV0dXJuIGZhbHNlO1xuICAgIGlmIChpc1NldHRpbmdzU2lkZWJhckNhbmRpZGF0ZShub2RlKSkgcmV0dXJuIHRydWU7XG4gICAgbm9kZSA9IG5vZGUucGFyZW50RWxlbWVudDtcbiAgfVxuXG4gIHJldHVybiBmYWxzZTtcbn1cblxuZnVuY3Rpb24gcmVzZXRUd2Vha2VySW5qZWN0ZWRTZXR0aW5nc0dyb3VwU3RhdGUoZ3JvdXA6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGlmIChzdGF0ZS5uYXZHcm91cCA9PT0gZ3JvdXAgfHwgKHN0YXRlLm5hdkdyb3VwICYmIGdyb3VwLmNvbnRhaW5zKHN0YXRlLm5hdkdyb3VwKSkpIHtcbiAgICBzdGF0ZS5uYXZHcm91cCA9IG51bGw7XG4gICAgc3RhdGUubmF2QnV0dG9ucyA9IG51bGw7XG4gICAgc3RhdGUudHdlYWtlclVwZGF0ZUJ1dHRvbiA9IG51bGw7XG4gIH1cbiAgaWYgKHN0YXRlLnBhZ2VzR3JvdXAgPT09IGdyb3VwIHx8IChzdGF0ZS5wYWdlc0dyb3VwICYmIGdyb3VwLmNvbnRhaW5zKHN0YXRlLnBhZ2VzR3JvdXApKSkge1xuICAgIHN0YXRlLnBhZ2VzR3JvdXAgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VzR3JvdXBLZXkgPSBudWxsO1xuICAgIHN0YXRlLnBhZ2VOYXZCdXR0b25zLmNsZWFyKCk7XG4gIH1cbiAgaWYgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciA9PT0gZ3JvdXAgfHwgKHN0YXRlLm5hdGl2ZU5hdkhlYWRlciAmJiBncm91cC5jb250YWlucyhzdGF0ZS5uYXRpdmVOYXZIZWFkZXIpKSkge1xuICAgIHN0YXRlLm5hdGl2ZU5hdkhlYWRlciA9IG51bGw7XG4gIH1cbiAgaWYgKHN0YXRlLnNpZGViYXJSb290ICYmIHN0YXRlLnNpZGViYXJSb290LmNvbnRhaW5zKGdyb3VwKSkge1xuICAgIHN0YXRlLnNpZGViYXJSb290ID0gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaW5kQ29udGVudEFyZWEoKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICBpZiAoIXNpZGViYXIpIHJldHVybiBudWxsO1xuICBsZXQgcGFyZW50ID0gc2lkZWJhci5wYXJlbnRFbGVtZW50O1xuICB3aGlsZSAocGFyZW50KSB7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKHBhcmVudC5jaGlsZHJlbikgYXMgSFRNTEVsZW1lbnRbXSkge1xuICAgICAgaWYgKGNoaWxkID09PSBzaWRlYmFyIHx8IGNoaWxkLmNvbnRhaW5zKHNpZGViYXIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHIgPSBjaGlsZC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIGlmIChyLndpZHRoID4gMzAwICYmIHIuaGVpZ2h0ID4gMjAwKSByZXR1cm4gY2hpbGQ7XG4gICAgfVxuICAgIHBhcmVudCA9IHBhcmVudC5wYXJlbnRFbGVtZW50O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBtYXliZUR1bXBEb20oKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2lkZWJhciA9IGZpbmRTaWRlYmFySXRlbXNHcm91cCgpO1xuICAgIGlmIChzaWRlYmFyICYmICFzdGF0ZS5zaWRlYmFyRHVtcGVkKSB7XG4gICAgICBzdGF0ZS5zaWRlYmFyRHVtcGVkID0gdHJ1ZTtcbiAgICAgIGNvbnN0IHNiUm9vdCA9IHNpZGViYXIucGFyZW50RWxlbWVudCA/PyBzaWRlYmFyO1xuICAgICAgcGxvZyhgY29kZXggc2lkZWJhciBIVE1MYCwgc2JSb290Lm91dGVySFRNTC5zbGljZSgwLCAzMjAwMCkpO1xuICAgIH1cbiAgICBjb25zdCBjb250ZW50ID0gZmluZENvbnRlbnRBcmVhKCk7XG4gICAgaWYgKCFjb250ZW50KSB7XG4gICAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgIT09IGxvY2F0aW9uLmhyZWYpIHtcbiAgICAgICAgc3RhdGUuZmluZ2VycHJpbnQgPSBsb2NhdGlvbi5ocmVmO1xuICAgICAgICBwbG9nKFwiZG9tIHByb2JlIChubyBjb250ZW50KVwiLCB7XG4gICAgICAgICAgdXJsOiBsb2NhdGlvbi5ocmVmLFxuICAgICAgICAgIHNpZGViYXI6IHNpZGViYXIgPyBkZXNjcmliZShzaWRlYmFyKSA6IG51bGwsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBsZXQgcGFuZWw6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XG4gICAgZm9yIChjb25zdCBjaGlsZCBvZiBBcnJheS5mcm9tKGNvbnRlbnQuY2hpbGRyZW4pIGFzIEhUTUxFbGVtZW50W10pIHtcbiAgICAgIGlmIChjaGlsZC5kYXRhc2V0LnR3ZWFrZXIgPT09IFwidHdlYWtzLXBhbmVsXCIpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNoaWxkLnN0eWxlLmRpc3BsYXkgPT09IFwibm9uZVwiKSBjb250aW51ZTtcbiAgICAgIHBhbmVsID0gY2hpbGQ7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY29uc3QgYWN0aXZlTmF2ID0gc2lkZWJhclxuICAgICAgPyBBcnJheS5mcm9tKHNpZGViYXIucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCJidXR0b24sIGFcIikpLmZpbmQoXG4gICAgICAgICAgKGIpID0+XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtY3VycmVudFwiKSA9PT0gXCJwYWdlXCIgfHxcbiAgICAgICAgICAgIGIuZ2V0QXR0cmlidXRlKFwiZGF0YS1hY3RpdmVcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmdldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIikgPT09IFwidHJ1ZVwiIHx8XG4gICAgICAgICAgICBiLmNsYXNzTGlzdC5jb250YWlucyhcImFjdGl2ZVwiKSxcbiAgICAgICAgKVxuICAgICAgOiBudWxsO1xuICAgIGNvbnN0IGhlYWRpbmcgPSBwYW5lbD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXG4gICAgICBcImgxLCBoMiwgaDMsIFtjbGFzcyo9J2hlYWRpbmcnXVwiLFxuICAgICk7XG4gICAgY29uc3QgZmluZ2VycHJpbnQgPSBgJHthY3RpdmVOYXY/LnRleHRDb250ZW50ID8/IFwiXCJ9fCR7aGVhZGluZz8udGV4dENvbnRlbnQgPz8gXCJcIn18JHtwYW5lbD8uY2hpbGRyZW4ubGVuZ3RoID8/IDB9YDtcbiAgICBpZiAoc3RhdGUuZmluZ2VycHJpbnQgPT09IGZpbmdlcnByaW50KSByZXR1cm47XG4gICAgc3RhdGUuZmluZ2VycHJpbnQgPSBmaW5nZXJwcmludDtcbiAgICBwbG9nKFwiZG9tIHByb2JlXCIsIHtcbiAgICAgIHVybDogbG9jYXRpb24uaHJlZixcbiAgICAgIGFjdGl2ZU5hdjogYWN0aXZlTmF2Py50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBoZWFkaW5nOiBoZWFkaW5nPy50ZXh0Q29udGVudD8udHJpbSgpID8/IG51bGwsXG4gICAgICBjb250ZW50OiBkZXNjcmliZShjb250ZW50KSxcbiAgICB9KTtcbiAgICBpZiAocGFuZWwpIHtcbiAgICAgIGNvbnN0IGh0bWwgPSBwYW5lbC5vdXRlckhUTUw7XG4gICAgICBwbG9nKFxuICAgICAgICBgY29kZXggcGFuZWwgSFRNTCAoJHthY3RpdmVOYXY/LnRleHRDb250ZW50Py50cmltKCkgPz8gXCI/XCJ9KWAsXG4gICAgICAgIGh0bWwuc2xpY2UoMCwgMzIwMDApLFxuICAgICAgKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwbG9nKFwiZG9tIHByb2JlIGZhaWxlZFwiLCBTdHJpbmcoZSkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRlc2NyaWJlKGVsOiBIVE1MRWxlbWVudCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHtcbiAgICB0YWc6IGVsLnRhZ05hbWUsXG4gICAgY2xzOiBlbC5jbGFzc05hbWUuc2xpY2UoMCwgMTIwKSxcbiAgICBpZDogZWwuaWQgfHwgdW5kZWZpbmVkLFxuICAgIGNoaWxkcmVuOiBlbC5jaGlsZHJlbi5sZW5ndGgsXG4gICAgcmVjdDogKCgpID0+IHtcbiAgICAgIGNvbnN0IHIgPSBlbC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcbiAgICAgIHJldHVybiB7IHc6IE1hdGgucm91bmQoci53aWR0aCksIGg6IE1hdGgucm91bmQoci5oZWlnaHQpIH07XG4gICAgfSkoKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gdHdlYWtzUGF0aCgpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fdHdlYWtlcl90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX190d2Vha2VyX3R3ZWFrc19kaXJfXyA/P1xuICAgIFwiPHVzZXIgZGlyPi90d2Vha3NcIlxuICApO1xufVxuIiwgImltcG9ydCB0eXBlIHsgVHdlYWtNYW5pZmVzdCB9IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfVFdFQUtfU1RPUkVfSU5ERVhfVVJMID1cbiAgXCJodHRwczovL3RoZXJlYWxpdHlyZXBvcnQuZ2l0aHViLmlvL3R3ZWFrZXJzL3N0b3JlL2luZGV4Lmpzb25cIjtcbmV4cG9ydCBjb25zdCBUV0VBS19TVE9SRV9SRVZJRVdfSVNTVUVfVVJMID1cbiAgXCJodHRwczovL2dpdGh1Yi5jb20vdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy9pc3N1ZXMvbmV3XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdG9yZVJlZ2lzdHJ5IHtcbiAgc2NoZW1hVmVyc2lvbjogMTtcbiAgZ2VuZXJhdGVkQXQ/OiBzdHJpbmc7XG4gIGVudHJpZXM6IFR3ZWFrU3RvcmVFbnRyeVtdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGlkOiBzdHJpbmc7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICAvKipcbiAgICogQW4gZW50cnkgY2FuIGJlIGNhdGFsb2cgbWV0YWRhdGEgYmVmb3JlIGl0cyBpbXBsZW1lbnRhdGlvbiBpcyBzaGlwcGVkLlxuICAgKiBNZXRhZGF0YS1vbmx5IGVudHJpZXMgZGVsaWJlcmF0ZWx5IG9taXQgaW5zdGFsbCBjb29yZGluYXRlcyBhbmQgYXJlIG5ldmVyXG4gICAqIG9mZmVyZWQgdG8gdGhlIGFyY2hpdmUgaW5zdGFsbGVyLlxuICAqL1xuICBhdmFpbGFibGU/OiBib29sZWFuO1xuICAvKiogUmVtb3RlIHNvdXJjZSBjb29yZGluYXRlcyBhcmUgcmVxdWlyZWQgb25seSBmb3IgcmVtb3RlIGVudHJpZXMuICovXG4gIHJlcG8/OiBzdHJpbmc7XG4gIGFwcHJvdmVkQ29tbWl0U2hhPzogc3RyaW5nO1xuICAvKiogUGFja2FnZWQgZW50cmllcyBwb2ludCBhdCB0aGUgaW5zdGFsbGVyLWJ1bmRsZWQgY2Fub25pY2FsIHNvdXJjZS4gKi9cbiAgc291cmNlPzogVHdlYWtTdG9yZVNvdXJjZTtcbiAgYXBwcm92ZWRBdDogc3RyaW5nO1xuICBhcHByb3ZlZEJ5OiBzdHJpbmc7XG4gIHBsYXRmb3Jtcz86IFR3ZWFrU3RvcmVQbGF0Zm9ybVtdO1xuICByZWxlYXNlVXJsPzogc3RyaW5nO1xuICByZXZpZXdVcmw/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrU3RvcmVTb3VyY2UgPVxuICB8IHsga2luZDogXCJidW5kbGVkXCI7IHBhdGg6IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcInJlbW90ZVwiOyByZXBvOiBzdHJpbmc7IGFwcHJvdmVkQ29tbWl0U2hhOiBzdHJpbmcgfTtcblxuLyoqIENhbm9uaWNhbCBwcm9qZWN0LW93bmVkIHR3ZWFrIGlkZW50aWZpZXJzIGFuZCBzb3VyY2UgZGlyZWN0b3JpZXMuICovXG5leHBvcnQgY29uc3QgQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFM6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+ID0gT2JqZWN0LmZyZWV6ZSh7XG4gIFwiY28udHdlYWtlcnMuYWNjb3VudC1zd2l0Y2hlclwiOiBcInR3ZWFrcy9jby50d2Vha2Vycy5hY2NvdW50LXN3aXRjaGVyXCIsXG4gIFwiY28udHdlYWtlcnMuYXBwc2hvdHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuYXBwc2hvdHNcIixcbiAgXCJjby50d2Vha2Vycy5kZXZlbG9wZXItdG9vbHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMuZGV2ZWxvcGVyLXRvb2xzXCIsXG4gIFwiY28udHdlYWtlcnMuc2hhZGNuLWNvZGV4LXVpXCI6IFwidHdlYWtzL2NvLnR3ZWFrZXJzLnNoYWRjbi1jb2RleC11aVwiLFxuICBcImNvLnR3ZWFrZXJzLmZvbGxvd3VwXCI6IFwidHdlYWtzL2ZvbGxvd3VwXCIsXG4gIFwiY28udHdlYWtlcnMucHJvamVjdHNcIjogXCJ0d2Vha3MvY28udHdlYWtlcnMucHJvamVjdHNcIixcbiAgXCJjby50d2Vha2Vycy50aHJlYWQtc3VtbWFyeS1wcm9maWxlc1wiOiBcInR3ZWFrcy9jby50d2Vha2Vycy50aHJlYWQtc3VtbWFyeS1wcm9maWxlc1wiLFxuICBcImNvLnR3ZWFrZXJzLnRpdGxlYmFyLWNvbnRyb2xzXCI6IFwidHdlYWtzL3RpdGxlYmFyLWNvbnRyb2xzXCIsXG4gIFwiY28udHdlYWtlcnMudWktaW1wcm92ZW1lbnRzXCI6IFwidHdlYWtzL3VpLWltcHJvdmVtZW50c1wiLFxuICBcImNvLnR3ZWFrZXJzLnVzZXItcXVlc3Rpb25zXCI6IFwidHdlYWtzL3VzZXItcXVlc3Rpb25zXCIsXG4gIFwiY28udHdlYWtlcnMudXNhZ2UtbGltaXQtcmVzZXRzLXRyYWNrZXJcIjogXCJ0d2Vha3MvdXNhZ2UtbGltaXQtcmVzZXRzLXRyYWNrZXJcIixcbn0pO1xuXG5leHBvcnQgdHlwZSBUd2Vha0hlYWx0aFN0YXR1cyA9IFwiZmFpbGVkXCIgfCBcInF1YXJhbnRpbmVkXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtIZWFsdGhSZWNvcmQge1xuICBzdGF0dXM6IFR3ZWFrSGVhbHRoU3RhdHVzO1xuICB1cGRhdGVkQXQ6IHN0cmluZztcbiAgZXJyb3I/OiBzdHJpbmc7XG59XG5cbi8qKiBUaGUgdXNlci1mYWNpbmcgc3RhdGUgdm9jYWJ1bGFyeSBmb3IgY2F0YWxvZyByb3dzLiAqL1xuZXhwb3J0IHR5cGUgVHdlYWtTdGF0dXMgPVxuICB8IFwiaW5zdGFsbGVkXCJcbiAgfCBcIm5vdC1pbnN0YWxsZWRcIlxuICB8IFwiZW5hYmxlZFwiXG4gIHwgXCJkaXNhYmxlZFwiXG4gIHwgXCJmYWlsZWRcIlxuICB8IFwicXVhcmFudGluZWRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha1N0YXR1c0lucHV0IHtcbiAgaW5zdGFsbGVkOiBib29sZWFuO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBoZWFsdGg/OiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXJpdmVUd2Vha1N0YXR1cyhpbnB1dDogVHdlYWtTdGF0dXNJbnB1dCk6IFR3ZWFrU3RhdHVzIHtcbiAgaWYgKCFpbnB1dC5pbnN0YWxsZWQpIHJldHVybiBcIm5vdC1pbnN0YWxsZWRcIjtcbiAgaWYgKGlucHV0LmhlYWx0aD8uc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIpIHJldHVybiBcInF1YXJhbnRpbmVkXCI7XG4gIGlmIChpbnB1dC5oZWFsdGg/LnN0YXR1cyA9PT0gXCJmYWlsZWRcIikgcmV0dXJuIFwiZmFpbGVkXCI7XG4gIHJldHVybiBpbnB1dC5lbmFibGVkID8gXCJlbmFibGVkXCIgOiBcImRpc2FibGVkXCI7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrU3RvcmVQbGF0Zm9ybSA9IFwiZGFyd2luXCIgfCBcIndpbjMyXCIgfCBcImxpbnV4XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uIHtcbiAgcmVwbzogc3RyaW5nO1xuICBkZWZhdWx0QnJhbmNoOiBzdHJpbmc7XG4gIGNvbW1pdFNoYTogc3RyaW5nO1xuICBjb21taXRVcmw6IHN0cmluZztcbiAgbWFuaWZlc3Q/OiB7XG4gICAgaWQ/OiBzdHJpbmc7XG4gICAgbmFtZT86IHN0cmluZztcbiAgICB2ZXJzaW9uPzogc3RyaW5nO1xuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICAgIGljb25Vcmw/OiBzdHJpbmc7XG4gIH07XG59XG5cbmNvbnN0IEdJVEhVQl9SRVBPX1JFID0gL15bQS1aYS16MC05Xy4tXStcXC9bQS1aYS16MC05Xy4tXSskLztcbmNvbnN0IEZVTExfU0hBX1JFID0gL15bYS1mMC05XXs0MH0kL2k7XG5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVHaXRIdWJSZXBvKGlucHV0OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByYXcgPSBpbnB1dC50cmltKCk7XG4gIGlmICghcmF3KSB0aHJvdyBuZXcgRXJyb3IoXCJHaXRIdWIgcmVwbyBpcyByZXF1aXJlZFwiKTtcblxuICBjb25zdCBzc2ggPSAvXmdpdEBnaXRodWJcXC5jb206KFteL10rXFwvW14vXSs/KSg/OlxcLmdpdCk/JC9pLmV4ZWMocmF3KTtcbiAgaWYgKHNzaCkgcmV0dXJuIG5vcm1hbGl6ZVJlcG9QYXJ0KHNzaFsxXSk7XG5cbiAgaWYgKC9eaHR0cHM/OlxcL1xcLy9pLnRlc3QocmF3KSkge1xuICAgIGNvbnN0IHVybCA9IG5ldyBVUkwocmF3KTtcbiAgICBpZiAodXJsLmhvc3RuYW1lICE9PSBcImdpdGh1Yi5jb21cIikgdGhyb3cgbmV3IEVycm9yKFwiT25seSBnaXRodWIuY29tIHJlcG9zaXRvcmllcyBhcmUgc3VwcG9ydGVkXCIpO1xuICAgIGNvbnN0IHBhcnRzID0gdXJsLnBhdGhuYW1lLnJlcGxhY2UoL15cXC8rfFxcLyskL2csIFwiXCIpLnNwbGl0KFwiL1wiKTtcbiAgICBpZiAocGFydHMubGVuZ3RoIDwgMikgdGhyb3cgbmV3IEVycm9yKFwiR2l0SHViIHJlcG8gVVJMIG11c3QgaW5jbHVkZSBvd25lciBhbmQgcmVwb3NpdG9yeVwiKTtcbiAgICByZXR1cm4gbm9ybWFsaXplUmVwb1BhcnQoYCR7cGFydHNbMF19LyR7cGFydHNbMV19YCk7XG4gIH1cblxuICByZXR1cm4gbm9ybWFsaXplUmVwb1BhcnQocmF3KTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZVN0b3JlUmVnaXN0cnkoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlUmVnaXN0cnkge1xuICBjb25zdCByZWdpc3RyeSA9IGlucHV0IGFzIFBhcnRpYWw8VHdlYWtTdG9yZVJlZ2lzdHJ5PiB8IG51bGw7XG4gIGlmICghcmVnaXN0cnkgfHwgcmVnaXN0cnkuc2NoZW1hVmVyc2lvbiAhPT0gMSB8fCAhQXJyYXkuaXNBcnJheShyZWdpc3RyeS5lbnRyaWVzKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIHR3ZWFrIHN0b3JlIHJlZ2lzdHJ5XCIpO1xuICB9XG4gIGNvbnN0IGVudHJpZXMgPSByZWdpc3RyeS5lbnRyaWVzLm1hcChub3JtYWxpemVTdG9yZUVudHJ5KTtcbiAgZW50cmllcy5zb3J0KChhLCBiKSA9PiBhLm1hbmlmZXN0Lm5hbWUubG9jYWxlQ29tcGFyZShiLm1hbmlmZXN0Lm5hbWUpKTtcbiAgcmV0dXJuIHtcbiAgICBzY2hlbWFWZXJzaW9uOiAxLFxuICAgIGdlbmVyYXRlZEF0OiB0eXBlb2YgcmVnaXN0cnkuZ2VuZXJhdGVkQXQgPT09IFwic3RyaW5nXCIgPyByZWdpc3RyeS5nZW5lcmF0ZWRBdCA6IHVuZGVmaW5lZCxcbiAgICBlbnRyaWVzLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2h1ZmZsZVN0b3JlRW50cmllczxUPihcbiAgZW50cmllczogcmVhZG9ubHkgVFtdLFxuICByYW5kb21JbmRleDogKGV4Y2x1c2l2ZU1heDogbnVtYmVyKSA9PiBudW1iZXIgPSAoZXhjbHVzaXZlTWF4KSA9PiBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBleGNsdXNpdmVNYXgpLFxuKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uZW50cmllc107XG4gIGZvciAobGV0IGkgPSBzaHVmZmxlZC5sZW5ndGggLSAxOyBpID4gMDsgaSAtPSAxKSB7XG4gICAgY29uc3QgaiA9IHJhbmRvbUluZGV4KGkgKyAxKTtcbiAgICBpZiAoIU51bWJlci5pc0ludGVnZXIoaikgfHwgaiA8IDAgfHwgaiA+IGkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgc2h1ZmZsZSByYW5kb21JbmRleCByZXR1cm5lZCAke2p9OyBleHBlY3RlZCBhbiBpbnRlZ2VyIGZyb20gMCB0byAke2l9YCk7XG4gICAgfVxuICAgIFtzaHVmZmxlZFtpXSwgc2h1ZmZsZWRbal1dID0gW3NodWZmbGVkW2pdLCBzaHVmZmxlZFtpXV07XG4gIH1cbiAgcmV0dXJuIHNodWZmbGVkO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplU3RvcmVFbnRyeShpbnB1dDogdW5rbm93bik6IFR3ZWFrU3RvcmVFbnRyeSB7XG4gIGNvbnN0IGVudHJ5ID0gaW5wdXQgYXMgUGFydGlhbDxUd2Vha1N0b3JlRW50cnk+IHwgbnVsbDtcbiAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIpIHRocm93IG5ldyBFcnJvcihcIkludmFsaWQgdHdlYWsgc3RvcmUgZW50cnlcIik7XG4gIGNvbnN0IG1hbmlmZXN0ID0gZW50cnkubWFuaWZlc3QgYXMgVHdlYWtNYW5pZmVzdCB8IHVuZGVmaW5lZDtcbiAgY29uc3QgYXZhaWxhYmxlID0gZW50cnkuYXZhaWxhYmxlICE9PSBmYWxzZTtcbiAgaWYgKCFtYW5pZmVzdD8uaWQgfHwgIW1hbmlmZXN0Lm5hbWUgfHwgIW1hbmlmZXN0LnZlcnNpb24gfHwgIW1hbmlmZXN0LmdpdGh1YlJlcG8pIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJTdG9yZSBlbnRyeSBpcyBtaXNzaW5nIG1hbmlmZXN0IGZpZWxkc1wiKTtcbiAgfVxuICBjb25zdCBzdXBwbGllZFJlcG8gPSB0eXBlb2YgZW50cnkucmVwbyA9PT0gXCJzdHJpbmdcIiAmJiBlbnRyeS5yZXBvLnRyaW0oKVxuICAgID8gbm9ybWFsaXplR2l0SHViUmVwbyhlbnRyeS5yZXBvKVxuICAgIDogdW5kZWZpbmVkO1xuICBpZiAoc3VwcGxpZWRSZXBvICYmIG5vcm1hbGl6ZUdpdEh1YlJlcG8obWFuaWZlc3QuZ2l0aHViUmVwbykgIT09IHN1cHBsaWVkUmVwbykge1xuICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gcmVwbyBkb2VzIG5vdCBtYXRjaCBtYW5pZmVzdCBnaXRodWJSZXBvYCk7XG4gIH1cbiAgY29uc3Qgc291cmNlSW5wdXQgPSAoZW50cnkgYXMgeyBzb3VyY2U/OiB1bmtub3duIH0pLnNvdXJjZTtcbiAgbGV0IHNvdXJjZTogVHdlYWtTdG9yZVNvdXJjZSB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlcG8gPSBzdXBwbGllZFJlcG87XG4gIGxldCBhcHByb3ZlZENvbW1pdFNoYSA9IHR5cGVvZiBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA9PT0gXCJzdHJpbmdcIiA/IGVudHJ5LmFwcHJvdmVkQ29tbWl0U2hhIDogXCJcIjtcbiAgaWYgKHNvdXJjZUlucHV0ICE9PSB1bmRlZmluZWQpIHtcbiAgICBpZiAoIXNvdXJjZUlucHV0IHx8IHR5cGVvZiBzb3VyY2VJbnB1dCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHNvdXJjZUlucHV0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBoYXMgYW4gaW52YWxpZCBzb3VyY2VgKTtcbiAgICB9XG4gICAgY29uc3QgcmF3U291cmNlID0gc291cmNlSW5wdXQgYXMgeyBraW5kPzogdW5rbm93bjsgcGF0aD86IHVua25vd247IHJlcG8/OiB1bmtub3duOyBhcHByb3ZlZENvbW1pdFNoYT86IHVua25vd24gfTtcbiAgICBpZiAocmF3U291cmNlLmtpbmQgPT09IFwiYnVuZGxlZFwiKSB7XG4gICAgICBjb25zdCBwYXRoID0gbm9ybWFsaXplQnVuZGxlZFNvdXJjZVBhdGgocmF3U291cmNlLnBhdGgsIG1hbmlmZXN0LmlkKTtcbiAgICAgIHNvdXJjZSA9IHsga2luZDogXCJidW5kbGVkXCIsIHBhdGggfTtcbiAgICAgIC8vIEEgYnVuZGxlZCBzb3VyY2UgaXMgaW50ZW50aW9uYWxseSBpbmRlcGVuZGVudCBvZiBHaXRIdWIgY29vcmRpbmF0ZXMuXG4gICAgICByZXBvID0gc3VwcGxpZWRSZXBvO1xuICAgICAgYXBwcm92ZWRDb21taXRTaGEgPSBcIlwiO1xuICAgIH0gZWxzZSBpZiAocmF3U291cmNlLmtpbmQgPT09IFwicmVtb3RlXCIpIHtcbiAgICAgIGNvbnN0IHJlbW90ZVJlcG8gPSBub3JtYWxpemVHaXRIdWJSZXBvKFN0cmluZyhyYXdTb3VyY2UucmVwbyA/PyBzdXBwbGllZFJlcG8gPz8gXCJcIikpO1xuICAgICAgY29uc3Qgc2hhID0gU3RyaW5nKHJhd1NvdXJjZS5hcHByb3ZlZENvbW1pdFNoYSA/PyBlbnRyeS5hcHByb3ZlZENvbW1pdFNoYSA/PyBcIlwiKTtcbiAgICAgIGlmIChhdmFpbGFibGUgJiYgIWlzRnVsbENvbW1pdFNoYShzaGEpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gbXVzdCBwaW4gYSBmdWxsIGFwcHJvdmVkIGNvbW1pdCBTSEFgKTtcbiAgICAgIH1cbiAgICAgIGlmIChzdXBwbGllZFJlcG8gJiYgc3VwcGxpZWRSZXBvICE9PSByZW1vdGVSZXBvKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gcmVtb3RlIHNvdXJjZSByZXBvIGRvZXMgbm90IG1hdGNoIHJlcG9gKTtcbiAgICAgIH1cbiAgICAgIHNvdXJjZSA9IHsga2luZDogXCJyZW1vdGVcIiwgcmVwbzogcmVtb3RlUmVwbywgYXBwcm92ZWRDb21taXRTaGE6IHNoYSB9O1xuICAgICAgcmVwbyA9IHJlbW90ZVJlcG87XG4gICAgICBhcHByb3ZlZENvbW1pdFNoYSA9IHNoYTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke21hbmlmZXN0LmlkfSBoYXMgdW5zdXBwb3J0ZWQgc291cmNlIGtpbmRgKTtcbiAgICB9XG4gIH0gZWxzZSBpZiAoYXZhaWxhYmxlKSB7XG4gICAgLy8gTGVnYWN5IGF2YWlsYWJsZSBlbnRyaWVzIGFyZSByZW1vdGUgYW5kIG11c3QgcmVtYWluIHBpbm5lZC5cbiAgICByZXBvID0gbm9ybWFsaXplR2l0SHViUmVwbyhTdHJpbmcocmVwbyA/PyBtYW5pZmVzdC5naXRodWJSZXBvID8/IFwiXCIpKTtcbiAgICBpZiAoIWlzRnVsbENvbW1pdFNoYShhcHByb3ZlZENvbW1pdFNoYSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU3RvcmUgZW50cnkgJHttYW5pZmVzdC5pZH0gbXVzdCBwaW4gYSBmdWxsIGFwcHJvdmVkIGNvbW1pdCBTSEFgKTtcbiAgICB9XG4gICAgc291cmNlID0geyBraW5kOiBcInJlbW90ZVwiLCByZXBvLCBhcHByb3ZlZENvbW1pdFNoYSB9O1xuICB9IGVsc2UgaWYgKCFyZXBvKSB7XG4gICAgLy8gTWV0YWRhdGEtb25seSBlbnRyaWVzIG1heSBvbWl0IGFsbCBpbnN0YWxsIGNvb3JkaW5hdGVzLiBLZWVwIHRoZSBzb3VyY2VcbiAgICAvLyBhYnNlbnQgc28gY2FsbGVycyBjYW5ub3QgYWNjaWRlbnRhbGx5IHRyZWF0IHRoZW0gYXMgaW5zdGFsbGFibGUuXG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZDogbWFuaWZlc3QuaWQsXG4gICAgbWFuaWZlc3QsXG4gICAgYXZhaWxhYmxlLFxuICAgIC4uLihyZXBvID8geyByZXBvIH0gOiB7fSksXG4gICAgYXBwcm92ZWRDb21taXRTaGEsXG4gICAgLi4uKHNvdXJjZSA/IHsgc291cmNlIH0gOiB7fSksXG4gICAgYXBwcm92ZWRBdDogdHlwZW9mIGVudHJ5LmFwcHJvdmVkQXQgPT09IFwic3RyaW5nXCIgPyBlbnRyeS5hcHByb3ZlZEF0IDogXCJcIixcbiAgICBhcHByb3ZlZEJ5OiB0eXBlb2YgZW50cnkuYXBwcm92ZWRCeSA9PT0gXCJzdHJpbmdcIiA/IGVudHJ5LmFwcHJvdmVkQnkgOiBcIlwiLFxuICAgIHBsYXRmb3Jtczogbm9ybWFsaXplU3RvcmVQbGF0Zm9ybXMoKGVudHJ5IGFzIHsgcGxhdGZvcm1zPzogdW5rbm93biB9KS5wbGF0Zm9ybXMpLFxuICAgIHJlbGVhc2VVcmw6IG9wdGlvbmFsR2l0aHViVXJsKGVudHJ5LnJlbGVhc2VVcmwpLFxuICAgIHJldmlld1VybDogb3B0aW9uYWxHaXRodWJVcmwoZW50cnkucmV2aWV3VXJsKSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0b3JlQXJjaGl2ZVVybChlbnRyeTogVHdlYWtTdG9yZUVudHJ5KTogc3RyaW5nIHtcbiAgaWYgKGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJidW5kbGVkXCIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYFN0b3JlIGVudHJ5ICR7ZW50cnkuaWR9IHVzZXMgYSBidW5kbGVkIHNvdXJjZSBhbmQgaGFzIG5vIGFyY2hpdmUgVVJMYCk7XG4gIH1cbiAgY29uc3QgcmVwbyA9IGVudHJ5LnNvdXJjZT8ua2luZCA9PT0gXCJyZW1vdGVcIiA/IGVudHJ5LnNvdXJjZS5yZXBvIDogZW50cnkucmVwbztcbiAgY29uc3QgYXBwcm92ZWRDb21taXRTaGEgPSBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwicmVtb3RlXCJcbiAgICA/IGVudHJ5LnNvdXJjZS5hcHByb3ZlZENvbW1pdFNoYVxuICAgIDogZW50cnkuYXBwcm92ZWRDb21taXRTaGE7XG4gIGlmICghcmVwbyB8fCAhaXNGdWxsQ29tbWl0U2hhKGFwcHJvdmVkQ29tbWl0U2hhID8/IFwiXCIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBpcyBub3QgcGlubmVkIHRvIGEgZnVsbCBjb21taXQgU0hBYCk7XG4gIH1cbiAgcmV0dXJuIGBodHRwczovL2NvZGVsb2FkLmdpdGh1Yi5jb20vJHtyZXBvfS90YXIuZ3ovJHthcHByb3ZlZENvbW1pdFNoYX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNCdW5kbGVkU3RvcmVFbnRyeShlbnRyeTogVHdlYWtTdG9yZUVudHJ5KTogYm9vbGVhbiB7XG4gIHJldHVybiBlbnRyeS5zb3VyY2U/LmtpbmQgPT09IFwiYnVuZGxlZFwiO1xufVxuXG4vKiogUmVzb2x2ZSBhIHBhY2thZ2VkIHNvdXJjZSB3aGlsZSByZWplY3RpbmcgdHJhdmVyc2FsIGFuZCBJRCBtaXNtYXRjaGVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVCdW5kbGVkVHdlYWtQYXRoKFxuICBwYWNrYWdlZFR3ZWFrc1Jvb3Q6IHN0cmluZyxcbiAgZW50cnk6IFBpY2s8VHdlYWtTdG9yZUVudHJ5LCBcImlkXCIgfCBcInNvdXJjZVwiPixcbik6IHN0cmluZyB7XG4gIGlmIChlbnRyeS5zb3VyY2U/LmtpbmQgIT09IFwiYnVuZGxlZFwiKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBkb2VzIG5vdCB1c2UgYSBidW5kbGVkIHNvdXJjZWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBlbnRyeS5zb3VyY2UucGF0aC5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIik7XG4gIGlmIChcbiAgICAhbm9ybWFsaXplZCB8fFxuICAgIG5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi9cIikgfHxcbiAgICBub3JtYWxpemVkLnNwbGl0KFwiL1wiKS5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSBcIi4uXCIgfHwgcGFydCA9PT0gXCJcIikgfHxcbiAgICBub3JtYWxpemVkICE9PSBCVU5ETEVEX1RXRUFLX1NPVVJDRV9QQVRIU1tlbnRyeS5pZF1cbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2VudHJ5LmlkfSBoYXMgYW4gdW5zYWZlIGJ1bmRsZWQgc291cmNlIHBhdGhgKTtcbiAgfVxuICAvLyBUaGUgbm9ybWFsaXplZCBwYXRoIGlzIGV4YWN0bHkgYHR3ZWFrcy88aWQ+YCAobm8gZG90IHNlZ21lbnRzKSwgc28gYVxuICAvLyBzaW1wbGUgam9pbiBpcyBzdWZmaWNpZW50IGFuZCBrZWVwcyB0aGlzIHNoYXJlZCBtb2R1bGUgYnJvd3Nlci1idW5kbGVhYmxlLlxuICBjb25zdCByb290ID0gcGFja2FnZWRUd2Vha3NSb290LnJlcGxhY2UoL1tcXFxcL10rJC8sIFwiXCIpO1xuICByZXR1cm4gYCR7cm9vdH0vJHtub3JtYWxpemVkfWA7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUJ1bmRsZWRTb3VyY2VQYXRoKHZhbHVlOiB1bmtub3duLCBpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2lkfSBidW5kbGVkIHNvdXJjZSBwYXRoIGlzIHJlcXVpcmVkYCk7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSB2YWx1ZS5yZXBsYWNlQWxsKFwiXFxcXFwiLCBcIi9cIikucmVwbGFjZSgvXlxcLlxcLy8sIFwiXCIpO1xuICBpZiAobm9ybWFsaXplZCAhPT0gQlVORExFRF9UV0VBS19TT1VSQ0VfUEFUSFNbaWRdKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBTdG9yZSBlbnRyeSAke2lkfSBidW5kbGVkIHNvdXJjZSBpcyBub3QgYWxsb3dsaXN0ZWRgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkVHdlYWtQdWJsaXNoSXNzdWVVcmwoc3VibWlzc2lvbjogVHdlYWtTdG9yZVB1Ymxpc2hTdWJtaXNzaW9uKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwbyA9IG5vcm1hbGl6ZUdpdEh1YlJlcG8oc3VibWlzc2lvbi5yZXBvKTtcbiAgaWYgKCFpc0Z1bGxDb21taXRTaGEoc3VibWlzc2lvbi5jb21taXRTaGEpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiU3VibWlzc2lvbiBtdXN0IGluY2x1ZGUgdGhlIGZ1bGwgY29tbWl0IFNIQSB0byByZXZpZXdcIik7XG4gIH1cbiAgY29uc3QgdGl0bGUgPSBgVHdlYWsgc3RvcmUgcmV2aWV3OiAke3JlcG99YDtcbiAgY29uc3QgYm9keSA9IFtcbiAgICBcIiMjIFR3ZWFrIHJlcG9cIixcbiAgICBgaHR0cHM6Ly9naXRodWIuY29tLyR7cmVwb31gLFxuICAgIFwiXCIsXG4gICAgXCIjIyBDb21taXQgdG8gcmV2aWV3XCIsXG4gICAgc3VibWlzc2lvbi5jb21taXRTaGEsXG4gICAgc3VibWlzc2lvbi5jb21taXRVcmwsXG4gICAgXCJcIixcbiAgICBcIkRvIG5vdCBhcHByb3ZlIGEgZGlmZmVyZW50IGNvbW1pdC4gSWYgdGhlIGF1dGhvciBwdXNoZXMgY2hhbmdlcywgYXNrIHRoZW0gdG8gcmVzdWJtaXQuXCIsXG4gICAgXCJcIixcbiAgICBcIiMjIE1hbmlmZXN0XCIsXG4gICAgYC0gaWQ6ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8uaWQgPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgYC0gbmFtZTogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5uYW1lID8/IFwiKG5vdCBkZXRlY3RlZClcIn1gLFxuICAgIGAtIHZlcnNpb246ICR7c3VibWlzc2lvbi5tYW5pZmVzdD8udmVyc2lvbiA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSBkZXNjcmlwdGlvbjogJHtzdWJtaXNzaW9uLm1hbmlmZXN0Py5kZXNjcmlwdGlvbiA/PyBcIihub3QgZGV0ZWN0ZWQpXCJ9YCxcbiAgICBgLSBpY29uVXJsOiAke3N1Ym1pc3Npb24ubWFuaWZlc3Q/Lmljb25VcmwgPz8gXCIobm90IGRldGVjdGVkKVwifWAsXG4gICAgXCJcIixcbiAgICBcIiMjIEFkbWluIGNoZWNrbGlzdFwiLFxuICAgIFwiLSBbIF0gbWFuaWZlc3QuanNvbiBpcyB2YWxpZFwiLFxuICAgIFwiLSBbIF0gbWFuaWZlc3QuaWNvblVybCBpcyB1c2FibGUgYXMgdGhlIHN0b3JlIGljb25cIixcbiAgICBcIi0gWyBdIHNvdXJjZSB3YXMgcmV2aWV3ZWQgYXQgdGhlIGV4YWN0IGNvbW1pdCBhYm92ZVwiLFxuICAgIFwiLSBbIF0gYHN0b3JlL2luZGV4Lmpzb25gIGVudHJ5IHBpbnMgYGFwcHJvdmVkQ29tbWl0U2hhYCB0byB0aGUgZXhhY3QgY29tbWl0IGFib3ZlXCIsXG4gIF0uam9pbihcIlxcblwiKTtcbiAgY29uc3QgdXJsID0gbmV3IFVSTChUV0VBS19TVE9SRV9SRVZJRVdfSVNTVUVfVVJMKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJ0ZW1wbGF0ZVwiLCBcInR3ZWFrLXN0b3JlLXJldmlldy5tZFwiKTtcbiAgdXJsLnNlYXJjaFBhcmFtcy5zZXQoXCJ0aXRsZVwiLCB0aXRsZSk7XG4gIHVybC5zZWFyY2hQYXJhbXMuc2V0KFwiYm9keVwiLCBib2R5KTtcbiAgcmV0dXJuIHVybC50b1N0cmluZygpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNGdWxsQ29tbWl0U2hhKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIEZVTExfU0hBX1JFLnRlc3QodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXBvUGFydCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgcmVwbyA9IHZhbHVlLnRyaW0oKS5yZXBsYWNlKC9cXC5naXQkL2ksIFwiXCIpLnJlcGxhY2UoL15cXC8rfFxcLyskL2csIFwiXCIpO1xuICBpZiAoIUdJVEhVQl9SRVBPX1JFLnRlc3QocmVwbykpIHRocm93IG5ldyBFcnJvcihcIkdpdEh1YiByZXBvIG11c3QgYmUgaW4gb3duZXIvcmVwbyBmb3JtXCIpO1xuICByZXR1cm4gcmVwbztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RvcmVQbGF0Zm9ybXMoaW5wdXQ6IHVua25vd24pOiBUd2Vha1N0b3JlUGxhdGZvcm1bXSB8IHVuZGVmaW5lZCB7XG4gIGlmIChpbnB1dCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gdW5kZWZpbmVkO1xuICBpZiAoIUFycmF5LmlzQXJyYXkoaW5wdXQpKSB0aHJvdyBuZXcgRXJyb3IoXCJTdG9yZSBlbnRyeSBwbGF0Zm9ybXMgbXVzdCBiZSBhbiBhcnJheVwiKTtcbiAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQ8VHdlYWtTdG9yZVBsYXRmb3JtPihbXCJkYXJ3aW5cIiwgXCJ3aW4zMlwiLCBcImxpbnV4XCJdKTtcbiAgY29uc3QgcGxhdGZvcm1zID0gQXJyYXkuZnJvbShuZXcgU2V0KGlucHV0Lm1hcCgodmFsdWUpID0+IHtcbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICFhbGxvd2VkLmhhcyh2YWx1ZSBhcyBUd2Vha1N0b3JlUGxhdGZvcm0pKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIHN0b3JlIHBsYXRmb3JtOiAke1N0cmluZyh2YWx1ZSl9YCk7XG4gICAgfVxuICAgIHJldHVybiB2YWx1ZSBhcyBUd2Vha1N0b3JlUGxhdGZvcm07XG4gIH0pKSk7XG4gIHJldHVybiBwbGF0Zm9ybXMubGVuZ3RoID4gMCA/IHBsYXRmb3JtcyA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gb3B0aW9uYWxHaXRodWJVcmwodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICF2YWx1ZS50cmltKCkpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IHVybCA9IG5ldyBVUkwodmFsdWUpO1xuICBpZiAodXJsLnByb3RvY29sICE9PSBcImh0dHBzOlwiIHx8IHVybC5ob3N0bmFtZSAhPT0gXCJnaXRodWIuY29tXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIHJldHVybiB1cmwudG9TdHJpbmcoKTtcbn1cbiIsICJleHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrIHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB2ZXJzaW9uOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICBpY29uVXJsPzogc3RyaW5nO1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzdGF0dXM6IHN0cmluZztcbiAgaGVhbHRoRXJyb3I/OiBzdHJpbmcgfCBudWxsO1xuICBsaWZlY3ljbGVPdmVycmlkZT86IFNldHRpbmdzTmF2aWdhdGlvbkxpZmVjeWNsZTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTZXR0aW5nc1BhZ2VSZWdpc3RyYXRpb25TdW1tYXJ5IHtcbiAgaWQ6IHN0cmluZztcbiAgdHdlYWtJZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgaWNvblN2Zz86IHN0cmluZztcbn1cblxuZXhwb3J0IHR5cGUgU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlID1cbiAgfCBcImVuYWJsZWRcIlxuICB8IFwiZmFpbGVkXCJcbiAgfCBcInF1YXJhbnRpbmVkXCJcbiAgfCBcInN0YXJ0aW5nXCJcbiAgfCBcInRpbWVkX291dFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzTmF2aWdhdGlvbkl0ZW0ge1xuICB0d2Vha0lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHZlcnNpb246IHN0cmluZztcbiAgZGVzY3JpcHRpb246IHN0cmluZztcbiAgaWNvblVybD86IHN0cmluZztcbiAgaWNvblN2Zz86IHN0cmluZztcbiAgcmVnaXN0cmF0aW9uSWRzOiBzdHJpbmdbXTtcbiAgZmFsbGJhY2s6IGJvb2xlYW47XG4gIGxpZmVjeWNsZTogU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlO1xuICB3YXJuaW5nOiBzdHJpbmcgfCBudWxsO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFNldHRpbmdzU2lkZWJhckV2aWRlbmNlIHtcbiAgd2lkdGg6IG51bWJlcjtcbiAgaGVpZ2h0OiBudW1iZXI7XG4gIGxlZnQ6IG51bWJlcjtcbiAgdmlld3BvcnRXaWR0aDogbnVtYmVyO1xuICBmb3JiaWRkZW5TdXJmYWNlOiBib29sZWFuO1xuICBuYXRpdmVQYW5lbFNsdWdDb3VudDogbnVtYmVyO1xuICBjb3JlTGFiZWxDb3VudDogbnVtYmVyO1xuICB0b3RhbExhYmVsQ291bnQ6IG51bWJlcjtcbiAgbWFpbkFwcExhYmVsQ291bnQ6IG51bWJlcjtcbiAgc2V0dGluZ3NPbmx5TGFiZWxDb3VudDogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaGFzTmF0aXZlU2V0dGluZ3NTaWRlYmFyT3duZXJzaGlwKFxuICBldmlkZW5jZTogUGljazxTZXR0aW5nc1NpZGViYXJFdmlkZW5jZSwgXCJmb3JiaWRkZW5TdXJmYWNlXCIgfCBcIm5hdGl2ZVBhbmVsU2x1Z0NvdW50XCI+LFxuKTogYm9vbGVhbiB7XG4gIHJldHVybiAhZXZpZGVuY2UuZm9yYmlkZGVuU3VyZmFjZSAmJiBldmlkZW5jZS5uYXRpdmVQYW5lbFNsdWdDb3VudCA+PSAxO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNOYXRpdmVTZXR0aW5nc1NpZGViYXJFdmlkZW5jZShldmlkZW5jZTogU2V0dGluZ3NTaWRlYmFyRXZpZGVuY2UpOiBib29sZWFuIHtcbiAgaWYgKCFoYXNOYXRpdmVTZXR0aW5nc1NpZGViYXJPd25lcnNoaXAoZXZpZGVuY2UpKSByZXR1cm4gZmFsc2U7XG4gIC8vIEVzdGFibGlzaCBvd25lcnNoaXAgZnJvbSBtdWx0aXBsZSBpbmRlcGVuZGVudCBuYXRpdmUgcm93cy4gT25jZSBtb3VudGVkLFxuICAvLyB0aGUgaW5qZWN0b3IgbWF5IHJldGFpbiB0aGUgdmVyaWZpZWQgcm9vdCB3aXRoIG9uZSByb3cgd2hpbGUgc2VhcmNoIGZpbHRlcnMuXG4gIGlmIChldmlkZW5jZS5uYXRpdmVQYW5lbFNsdWdDb3VudCA8IDIpIHJldHVybiBmYWxzZTtcbiAgaWYgKGV2aWRlbmNlLndpZHRoIDwgMTIwIHx8IGV2aWRlbmNlLndpZHRoID4gNjIwKSByZXR1cm4gZmFsc2U7XG4gIGlmIChldmlkZW5jZS5oZWlnaHQgPCA4MCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZXZpZGVuY2UubGVmdCA+IGV2aWRlbmNlLnZpZXdwb3J0V2lkdGggKiAwLjY1KSByZXR1cm4gZmFsc2U7XG4gIGlmIChldmlkZW5jZS5tYWluQXBwTGFiZWxDb3VudCA+PSAyICYmIGV2aWRlbmNlLnNldHRpbmdzT25seUxhYmVsQ291bnQgPT09IDApIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGV2aWRlbmNlLmNvcmVMYWJlbENvdW50ID49IDIgJiYgZXZpZGVuY2UudG90YWxMYWJlbENvdW50ID49IDM7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNldHRpbmdzTmF2aWdhdGlvbk1vZGVsKFxuICB0d2Vha3M6IFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrW10sXG4gIHJlZ2lzdHJhdGlvbnM6IFNldHRpbmdzUGFnZVJlZ2lzdHJhdGlvblN1bW1hcnlbXSxcbik6IFNldHRpbmdzTmF2aWdhdGlvbkl0ZW1bXSB7XG4gIGNvbnN0IHJlZ2lzdHJhdGlvbnNCeVR3ZWFrID0gbmV3IE1hcDxzdHJpbmcsIFNldHRpbmdzUGFnZVJlZ2lzdHJhdGlvblN1bW1hcnlbXT4oKTtcbiAgZm9yIChjb25zdCByZWdpc3RyYXRpb24gb2YgcmVnaXN0cmF0aW9ucykge1xuICAgIGNvbnN0IGdyb3VwID0gcmVnaXN0cmF0aW9uc0J5VHdlYWsuZ2V0KHJlZ2lzdHJhdGlvbi50d2Vha0lkKSA/PyBbXTtcbiAgICBncm91cC5wdXNoKHJlZ2lzdHJhdGlvbik7XG4gICAgcmVnaXN0cmF0aW9uc0J5VHdlYWsuc2V0KHJlZ2lzdHJhdGlvbi50d2Vha0lkLCBncm91cCk7XG4gIH1cblxuICBjb25zdCByb3dzOiBTZXR0aW5nc05hdmlnYXRpb25JdGVtW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHR3ZWFrIG9mIHR3ZWFrcykge1xuICAgIGlmICghdHdlYWsuZW5hYmxlZCB8fCBzZWVuLmhhcyh0d2Vhay5pZCkpIGNvbnRpbnVlO1xuICAgIHNlZW4uYWRkKHR3ZWFrLmlkKTtcbiAgICBjb25zdCBwYWdlcyA9IHJlZ2lzdHJhdGlvbnNCeVR3ZWFrLmdldCh0d2Vhay5pZCkgPz8gW107XG4gICAgY29uc3QgcHJpbWFyeSA9IHBhZ2VzWzBdO1xuICAgIHJvd3MucHVzaCh7XG4gICAgICB0d2Vha0lkOiB0d2Vhay5pZCxcbiAgICAgIHRpdGxlOiBwcmltYXJ5Py50aXRsZSB8fCB0d2Vhay5uYW1lLFxuICAgICAgdmVyc2lvbjogdHdlYWsudmVyc2lvbixcbiAgICAgIGRlc2NyaXB0aW9uOiBwcmltYXJ5Py5kZXNjcmlwdGlvbiB8fCB0d2Vhay5kZXNjcmlwdGlvbiB8fCBcIkVuYWJsZWQgVHdlYWtlci5cIixcbiAgICAgIGljb25Vcmw6IHR3ZWFrLmljb25VcmwsXG4gICAgICBpY29uU3ZnOiBwcmltYXJ5Py5pY29uU3ZnLFxuICAgICAgcmVnaXN0cmF0aW9uSWRzOiBwYWdlcy5tYXAoKHBhZ2UpID0+IHBhZ2UuaWQpLFxuICAgICAgZmFsbGJhY2s6IHBhZ2VzLmxlbmd0aCA9PT0gMCxcbiAgICAgIGxpZmVjeWNsZTogbGlmZWN5Y2xlRm9yKHR3ZWFrKSxcbiAgICAgIHdhcm5pbmc6IHR3ZWFrLmhlYWx0aEVycm9yIHx8IG51bGwsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIHJvd3Muc29ydCgoYSwgYikgPT4gYS50aXRsZS5sb2NhbGVDb21wYXJlKGIudGl0bGUpIHx8IGEudHdlYWtJZC5sb2NhbGVDb21wYXJlKGIudHdlYWtJZCkpO1xufVxuXG5mdW5jdGlvbiBsaWZlY3ljbGVGb3IodHdlYWs6IFNldHRpbmdzTmF2aWdhdGlvblR3ZWFrKTogU2V0dGluZ3NOYXZpZ2F0aW9uTGlmZWN5Y2xlIHtcbiAgaWYgKHR3ZWFrLmxpZmVjeWNsZU92ZXJyaWRlKSByZXR1cm4gdHdlYWsubGlmZWN5Y2xlT3ZlcnJpZGU7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwiZmFpbGVkXCIpIHJldHVybiBcImZhaWxlZFwiO1xuICBpZiAodHdlYWsuc3RhdHVzID09PSBcInF1YXJhbnRpbmVkXCIpIHJldHVybiBcInF1YXJhbnRpbmVkXCI7XG4gIGlmICh0d2Vhay5zdGF0dXMgPT09IFwic3RhcnRpbmdcIikgcmV0dXJuIFwic3RhcnRpbmdcIjtcbiAgaWYgKHR3ZWFrLnN0YXR1cyA9PT0gXCJ0aW1lZF9vdXRcIikgcmV0dXJuIFwidGltZWRfb3V0XCI7XG4gIHJldHVybiBcImVuYWJsZWRcIjtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFR3ZWFrTWFuaWZlc3QgfSBmcm9tIFwiQHRoZXJlYWxpdHlyZXBvcnQvdHdlYWtlcnMtc2RrXCI7XG5pbXBvcnQgdHlwZSB7IFR3ZWFrU3RhdHVzIH0gZnJvbSBcIi4uL3R3ZWFrLXN0b3JlXCI7XG5cbmV4cG9ydCB0eXBlIFR3ZWFrc1BhZ2VGaWx0ZXIgPSBcImFsbFwiIHwgXCJlbmFibGVkXCIgfCBcImRpc2FibGVkXCIgfCBcInVwZGF0ZXNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha3NQYWdlSXRlbSB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBpbnN0YWxsZWQ6IGJvb2xlYW47XG4gIGVuYWJsZWQ6IGJvb2xlYW47XG4gIHN0YXR1czogVHdlYWtTdGF0dXM7XG4gIHVwZGF0ZTogeyB1cGRhdGVBdmFpbGFibGU6IGJvb2xlYW4gfSB8IG51bGw7XG59XG5cbmV4cG9ydCB0eXBlIFR3ZWFrc1BhZ2VDb3VudHMgPSBSZWNvcmQ8VHdlYWtzUGFnZUZpbHRlciwgbnVtYmVyPjtcblxuZXhwb3J0IGNvbnN0IFRXRUFLU19QQUdFX0ZJTFRFUlM6IHJlYWRvbmx5IFR3ZWFrc1BhZ2VGaWx0ZXJbXSA9IFtcbiAgXCJhbGxcIixcbiAgXCJlbmFibGVkXCIsXG4gIFwiZGlzYWJsZWRcIixcbiAgXCJ1cGRhdGVzXCIsXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gdHdlYWtzUGFnZUNvdW50cyhpdGVtczogcmVhZG9ubHkgVHdlYWtzUGFnZUl0ZW1bXSk6IFR3ZWFrc1BhZ2VDb3VudHMge1xuICByZXR1cm4ge1xuICAgIGFsbDogaXRlbXMubGVuZ3RoLFxuICAgIGVuYWJsZWQ6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJlbmFibGVkXCIpKS5sZW5ndGgsXG4gICAgZGlzYWJsZWQ6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJkaXNhYmxlZFwiKSkubGVuZ3RoLFxuICAgIHVwZGF0ZXM6IGl0ZW1zLmZpbHRlcigoaXRlbSkgPT4gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoaXRlbSwgXCJ1cGRhdGVzXCIpKS5sZW5ndGgsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmaWx0ZXJUd2Vha3NQYWdlSXRlbXM8VCBleHRlbmRzIFR3ZWFrc1BhZ2VJdGVtPihcbiAgaXRlbXM6IHJlYWRvbmx5IFRbXSxcbiAgZmlsdGVyOiBUd2Vha3NQYWdlRmlsdGVyLFxuICBxdWVyeTogc3RyaW5nLFxuKTogVFtdIHtcbiAgY29uc3Qgbm9ybWFsaXplZFF1ZXJ5ID0gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaChxdWVyeSk7XG4gIHJldHVybiBpdGVtcy5maWx0ZXIoKGl0ZW0pID0+IHtcbiAgICBpZiAoIW1hdGNoZXNUd2Vha3NQYWdlRmlsdGVyKGl0ZW0sIGZpbHRlcikpIHJldHVybiBmYWxzZTtcbiAgICBpZiAoIW5vcm1hbGl6ZWRRdWVyeSkgcmV0dXJuIHRydWU7XG4gICAgcmV0dXJuIHR3ZWFrc1BhZ2VTZWFyY2hUZXh0KGl0ZW0pLmluY2x1ZGVzKG5vcm1hbGl6ZWRRdWVyeSk7XG4gIH0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gbWF0Y2hlc1R3ZWFrc1BhZ2VGaWx0ZXIoXG4gIGl0ZW06IFR3ZWFrc1BhZ2VJdGVtLFxuICBmaWx0ZXI6IFR3ZWFrc1BhZ2VGaWx0ZXIsXG4pOiBib29sZWFuIHtcbiAgaWYgKGZpbHRlciA9PT0gXCJlbmFibGVkXCIpIHJldHVybiBpdGVtLmluc3RhbGxlZCAmJiBpdGVtLmVuYWJsZWQ7XG4gIGlmIChmaWx0ZXIgPT09IFwiZGlzYWJsZWRcIikgcmV0dXJuIGl0ZW0uaW5zdGFsbGVkICYmICFpdGVtLmVuYWJsZWQ7XG4gIGlmIChmaWx0ZXIgPT09IFwidXBkYXRlc1wiKSByZXR1cm4gaXRlbS51cGRhdGU/LnVwZGF0ZUF2YWlsYWJsZSA9PT0gdHJ1ZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0d2Vha3NQYWdlU2VhcmNoVGV4dChpdGVtOiBUd2Vha3NQYWdlSXRlbSk6IHN0cmluZyB7XG4gIGNvbnN0IGF1dGhvciA9IHR5cGVvZiBpdGVtLm1hbmlmZXN0LmF1dGhvciA9PT0gXCJzdHJpbmdcIlxuICAgID8gaXRlbS5tYW5pZmVzdC5hdXRob3JcbiAgICA6IGl0ZW0ubWFuaWZlc3QuYXV0aG9yPy5uYW1lO1xuICByZXR1cm4gbm9ybWFsaXplVHdlYWtzUGFnZVNlYXJjaChbXG4gICAgaXRlbS5tYW5pZmVzdC5uYW1lLFxuICAgIGl0ZW0ubWFuaWZlc3QuZGVzY3JpcHRpb24sXG4gICAgYXV0aG9yLFxuICAgIGl0ZW0ubWFuaWZlc3QuZ2l0aHViUmVwbyxcbiAgICBpdGVtLm1hbmlmZXN0LmhvbWVwYWdlLFxuICAgIGl0ZW0ubWFuaWZlc3QudmVyc2lvbixcbiAgICAuLi4oaXRlbS5tYW5pZmVzdC50YWdzID8/IFtdKSxcbiAgICBpdGVtLnN0YXR1cyxcbiAgICBpdGVtLmVuYWJsZWQgPyBcImVuYWJsZWRcIiA6IFwiZGlzYWJsZWRcIixcbiAgICBpdGVtLnVwZGF0ZT8udXBkYXRlQXZhaWxhYmxlID8gXCJ1cGRhdGUgYXZhaWxhYmxlXCIgOiBcIlwiLFxuICBdLmZpbHRlcihCb29sZWFuKS5qb2luKFwiIFwiKSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVR3ZWFrc1BhZ2VTZWFyY2godmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB2YWx1ZVxuICAgIC50b0xvY2FsZUxvd2VyQ2FzZSgpXG4gICAgLm5vcm1hbGl6ZShcIk5GRFwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MDMwMC1cXHUwMzZmXS9nLCBcIlwiKVxuICAgIC5yZXBsYWNlKC9bXFx1MjAxOFxcdTIwMTlgXFx1MDBiNF0vZywgXCInXCIpXG4gICAgLnJlcGxhY2UoL1xccysvZywgXCIgXCIpXG4gICAgLnRyaW0oKTtcbn1cbiIsICJleHBvcnQgdHlwZSBFbnZpcm9ubWVudEFwcEV4cGVyaWVuY2UgPSBcImNoYXRncHRcIiB8IFwidHdlYWtlcnNcIjtcbmV4cG9ydCB0eXBlIEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGUgPSBcInN0YWJsZVwiIHwgXCJhbHBoYVwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEVudmlyb25tZW50U2VsZWN0aW9uUGFpciB7XG4gIGFwcEV4cGVyaWVuY2U6IEVudmlyb25tZW50QXBwRXhwZXJpZW5jZTtcbiAgcmVsZWFzZVByb2ZpbGU6IEVudmlyb25tZW50UmVsZWFzZVByb2ZpbGU7XG59XG5cbmV4cG9ydCB0eXBlIEVudmlyb25tZW50Q29uZmlybWF0aW9uRGVjaXNpb24gPSBcImNvbmZpcm1cIiB8IFwiY2FuY2VsXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRDb25maWdFZmZlY3RzPFJlY2VpcHQ+IHtcbiAgcHJlcGFyZShzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IFByb21pc2U8UmVjZWlwdD47XG4gIGNvbmZpcm0oc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIsIHJlY2VpcHQ6IFJlY2VpcHQpOiBQcm9taXNlPEVudmlyb25tZW50Q29uZmlybWF0aW9uRGVjaXNpb24+O1xuICBjb21taXQocmVjZWlwdDogUmVjZWlwdCk6IFByb21pc2U8dm9pZD47XG4gIGNhbmNlbChyZWNlaXB0OiBSZWNlaXB0KTogUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRDb25maWdQaGFzZSA9XG4gIHwgXCJpZGxlXCJcbiAgfCBcInByZXBhcmluZ1wiXG4gIHwgXCJhd2FpdGluZy1jb25maXJtYXRpb25cIlxuICB8IFwiY29tbWl0dGluZ1wiXG4gIHwgXCJjYW5jZWxsaW5nXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCB7XG4gIHNlbGVjdGVkOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXI7XG4gIHBlbmRpbmc6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcjtcbiAgaGFzUGVuZGluZ0NoYW5nZXM6IGJvb2xlYW47XG4gIGJ1c3k6IGJvb2xlYW47XG4gIHBoYXNlOiBFbnZpcm9ubWVudENvbmZpZ1BoYXNlO1xuICBlcnJvcjogc3RyaW5nIHwgbnVsbDtcbn1cblxuZXhwb3J0IHR5cGUgRW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4gPVxuICB8IHsgb3V0Y29tZTogXCJuby1jaGFuZ2VcIiB8IFwiYnVzeVwiIH1cbiAgfCB7IG91dGNvbWU6IFwic3VibWl0dGVkXCIgfCBcImNhbmNlbGxlZFwiOyByZWNlaXB0OiBSZWNlaXB0IH1cbiAgfCB7IG91dGNvbWU6IFwicHJlcGFyZS1mYWlsZWRcIjsgZXJyb3I6IHN0cmluZyB9XG4gIHwgeyBvdXRjb21lOiBcImNvbmZpcm1hdGlvbi1mYWlsZWRcIiB8IFwiY29tbWl0LWZhaWxlZFwiIHwgXCJjYW5jZWwtZmFpbGVkXCI7IHJlY2VpcHQ6IFJlY2VpcHQ7IGVycm9yOiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXI8UmVjZWlwdD4ge1xuICByZWFkb25seSBzbmFwc2hvdDogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdDtcbiAgc2V0U2VsZWN0ZWQoc2VsZWN0aW9uOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIpOiB2b2lkO1xuICByZXN0b3JlUGVuZGluZyhzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IHZvaWQ7XG4gIHN0YWdlQXBwRXhwZXJpZW5jZSh2YWx1ZTogRW52aXJvbm1lbnRBcHBFeHBlcmllbmNlKTogdm9pZDtcbiAgc3RhZ2VSZWxlYXNlUHJvZmlsZSh2YWx1ZTogRW52aXJvbm1lbnRSZWxlYXNlUHJvZmlsZSk6IHZvaWQ7XG4gIGNsZWFyRXJyb3IoKTogdm9pZDtcbiAgYXBwbHlBbmRSZXN0YXJ0KCk6IFByb21pc2U8RW52aXJvbm1lbnRBcHBseU91dGNvbWU8UmVjZWlwdD4+O1xuICByZXN1bWVQcmVwYXJlZChcbiAgICBzZWxlY3Rpb246IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcixcbiAgICByZWNlaXB0OiBSZWNlaXB0LFxuICApOiBQcm9taXNlPEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+Pjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXJPcHRpb25zIHtcbiAgb25DaGFuZ2U/OiAoc25hcHNob3Q6IEVudmlyb25tZW50Q29uZmlnU25hcHNob3QpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFbnZpcm9ubWVudENvbmZpZ0NvbnRyb2xsZXI8UmVjZWlwdD4oXG4gIHNlbGVjdGVkOiBFbnZpcm9ubWVudFNlbGVjdGlvblBhaXIsXG4gIGVmZmVjdHM6IEVudmlyb25tZW50Q29uZmlnRWZmZWN0czxSZWNlaXB0PixcbiAgb3B0aW9uczogRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyT3B0aW9ucyA9IHt9LFxuKTogRW52aXJvbm1lbnRDb25maWdDb250cm9sbGVyPFJlY2VpcHQ+IHtcbiAgbGV0IHNlbGVjdGVkVmFsdWUgPSBjb3B5U2VsZWN0aW9uKHNlbGVjdGVkKTtcbiAgbGV0IHBlbmRpbmdWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWQpO1xuICBsZXQgYnVzeSA9IGZhbHNlO1xuICBsZXQgcGhhc2U6IEVudmlyb25tZW50Q29uZmlnUGhhc2UgPSBcImlkbGVcIjtcbiAgbGV0IGVycm9yOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBjb25zdCByZWFkU25hcHNob3QgPSAoKTogRW52aXJvbm1lbnRDb25maWdTbmFwc2hvdCA9PiAoe1xuICAgIHNlbGVjdGVkOiBjb3B5U2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUpLFxuICAgIHBlbmRpbmc6IGNvcHlTZWxlY3Rpb24ocGVuZGluZ1ZhbHVlKSxcbiAgICBoYXNQZW5kaW5nQ2hhbmdlczogIXNhbWVTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSwgcGVuZGluZ1ZhbHVlKSxcbiAgICBidXN5LFxuICAgIHBoYXNlLFxuICAgIGVycm9yLFxuICB9KTtcbiAgY29uc3QgcHVibGlzaCA9ICgpOiB2b2lkID0+IG9wdGlvbnMub25DaGFuZ2U/LihyZWFkU25hcHNob3QoKSk7XG4gIGNvbnN0IGZpbmlzaFdpdGhFcnJvciA9IChuZXh0UGhhc2U6IEVudmlyb25tZW50Q29uZmlnUGhhc2UsIG5leHRFcnJvcjogdW5rbm93bik6IHN0cmluZyA9PiB7XG4gICAgZXJyb3IgPSBlbnZpcm9ubWVudENvbmZpZ0Vycm9yKG5leHRFcnJvcik7XG4gICAgYnVzeSA9IGZhbHNlO1xuICAgIHBoYXNlID0gbmV4dFBoYXNlO1xuICAgIHB1Ymxpc2goKTtcbiAgICByZXR1cm4gZXJyb3I7XG4gIH07XG5cbiAgY29uc3QgY29tcGxldGVQcmVwYXJlZCA9IGFzeW5jIChcbiAgICByZXF1ZXN0ZWQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcixcbiAgICByZWNlaXB0OiBSZWNlaXB0LFxuICApOiBQcm9taXNlPEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+PiA9PiB7XG4gICAgcGhhc2UgPSBcImF3YWl0aW5nLWNvbmZpcm1hdGlvblwiO1xuICAgIHB1Ymxpc2goKTtcbiAgICBsZXQgZGVjaXNpb246IEVudmlyb25tZW50Q29uZmlybWF0aW9uRGVjaXNpb247XG4gICAgdHJ5IHtcbiAgICAgIGRlY2lzaW9uID0gYXdhaXQgZWZmZWN0cy5jb25maXJtKGNvcHlTZWxlY3Rpb24ocmVxdWVzdGVkKSwgcmVjZWlwdCk7XG4gICAgfSBjYXRjaCAoY29uZmlybWF0aW9uRXJyb3IpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG91dGNvbWU6IFwiY29uZmlybWF0aW9uLWZhaWxlZFwiLFxuICAgICAgICByZWNlaXB0LFxuICAgICAgICBlcnJvcjogZmluaXNoV2l0aEVycm9yKFwiaWRsZVwiLCBjb25maXJtYXRpb25FcnJvciksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChkZWNpc2lvbiA9PT0gXCJjYW5jZWxcIikge1xuICAgICAgcGhhc2UgPSBcImNhbmNlbGxpbmdcIjtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGVmZmVjdHMuY2FuY2VsKHJlY2VpcHQpO1xuICAgICAgfSBjYXRjaCAoY2FuY2VsRXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvdXRjb21lOiBcImNhbmNlbC1mYWlsZWRcIixcbiAgICAgICAgICByZWNlaXB0LFxuICAgICAgICAgIGVycm9yOiBmaW5pc2hXaXRoRXJyb3IoXCJpZGxlXCIsIGNhbmNlbEVycm9yKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHBlbmRpbmdWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0ZWRWYWx1ZSk7XG4gICAgICBidXN5ID0gZmFsc2U7XG4gICAgICBwaGFzZSA9IFwiaWRsZVwiO1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgICAgcmV0dXJuIHsgb3V0Y29tZTogXCJjYW5jZWxsZWRcIiwgcmVjZWlwdCB9O1xuICAgIH1cblxuICAgIHBoYXNlID0gXCJjb21taXR0aW5nXCI7XG4gICAgcHVibGlzaCgpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBlZmZlY3RzLmNvbW1pdChyZWNlaXB0KTtcbiAgICB9IGNhdGNoIChjb21taXRFcnJvcikge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgb3V0Y29tZTogXCJjb21taXQtZmFpbGVkXCIsXG4gICAgICAgIHJlY2VpcHQsXG4gICAgICAgIGVycm9yOiBmaW5pc2hXaXRoRXJyb3IoXCJpZGxlXCIsIGNvbW1pdEVycm9yKSxcbiAgICAgIH07XG4gICAgfVxuICAgIGJ1c3kgPSBmYWxzZTtcbiAgICBwaGFzZSA9IFwiaWRsZVwiO1xuICAgIGVycm9yID0gbnVsbDtcbiAgICBwdWJsaXNoKCk7XG4gICAgcmV0dXJuIHsgb3V0Y29tZTogXCJzdWJtaXR0ZWRcIiwgcmVjZWlwdCB9O1xuICB9O1xuXG4gIHJldHVybiB7XG4gICAgZ2V0IHNuYXBzaG90KCk6IEVudmlyb25tZW50Q29uZmlnU25hcHNob3Qge1xuICAgICAgcmV0dXJuIHJlYWRTbmFwc2hvdCgpO1xuICAgIH0sXG4gICAgc2V0U2VsZWN0ZWQoc2VsZWN0aW9uKTogdm9pZCB7XG4gICAgICBjb25zdCBwZW5kaW5nV2FzVW5jaGFuZ2VkID0gc2FtZVNlbGVjdGlvbihzZWxlY3RlZFZhbHVlLCBwZW5kaW5nVmFsdWUpO1xuICAgICAgc2VsZWN0ZWRWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uKTtcbiAgICAgIC8vIEEgc3RhdHVzIHJlZnJlc2ggbWF5IHJlc29sdmUgYWZ0ZXIgdGhlIHVzZXIgaGFzIHN0YWdlZCBvbmUgaGFsZiBvZiB0aGVcbiAgICAgIC8vIEVudmlyb25tZW50IHBhaXIuIFJlZnJlc2ggdGhlIGF1dGhvcml0YXRpdmUgc2VsZWN0aW9uIHdpdGhvdXQgZXJhc2luZ1xuICAgICAgLy8gdGhhdCBuZXdlciBsb2NhbCBpbnRlbnQ7IG9ubHkgZm9sbG93IHRoZSBzZWxlY3RlZCB2YWx1ZSB3aGlsZSB0aGUgZm9ybVxuICAgICAgLy8gaXRzZWxmIGlzIHN0aWxsIHByaXN0aW5lLlxuICAgICAgaWYgKHBlbmRpbmdXYXNVbmNoYW5nZWQpIHBlbmRpbmdWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uKTtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIHJlc3RvcmVQZW5kaW5nKHNlbGVjdGlvbik6IHZvaWQge1xuICAgICAgcGVuZGluZ1ZhbHVlID0gY29weVNlbGVjdGlvbihzZWxlY3Rpb24pO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgc3RhZ2VBcHBFeHBlcmllbmNlKHZhbHVlKTogdm9pZCB7XG4gICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgcGVuZGluZ1ZhbHVlID0geyAuLi5wZW5kaW5nVmFsdWUsIGFwcEV4cGVyaWVuY2U6IHZhbHVlIH07XG4gICAgICBlcnJvciA9IG51bGw7XG4gICAgICBwdWJsaXNoKCk7XG4gICAgfSxcbiAgICBzdGFnZVJlbGVhc2VQcm9maWxlKHZhbHVlKTogdm9pZCB7XG4gICAgICBpZiAoYnVzeSkgcmV0dXJuO1xuICAgICAgcGVuZGluZ1ZhbHVlID0geyAuLi5wZW5kaW5nVmFsdWUsIHJlbGVhc2VQcm9maWxlOiB2YWx1ZSB9O1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgIH0sXG4gICAgY2xlYXJFcnJvcigpOiB2b2lkIHtcbiAgICAgIGVycm9yID0gbnVsbDtcbiAgICAgIHB1Ymxpc2goKTtcbiAgICB9LFxuICAgIGFzeW5jIGFwcGx5QW5kUmVzdGFydCgpOiBQcm9taXNlPEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+PiB7XG4gICAgICBpZiAoYnVzeSkgcmV0dXJuIHsgb3V0Y29tZTogXCJidXN5XCIgfTtcbiAgICAgIGlmIChzYW1lU2VsZWN0aW9uKHNlbGVjdGVkVmFsdWUsIHBlbmRpbmdWYWx1ZSkpIHJldHVybiB7IG91dGNvbWU6IFwibm8tY2hhbmdlXCIgfTtcbiAgICAgIGNvbnN0IHJlcXVlc3RlZCA9IGNvcHlTZWxlY3Rpb24ocGVuZGluZ1ZhbHVlKTtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgcGhhc2UgPSBcInByZXBhcmluZ1wiO1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcHVibGlzaCgpO1xuICAgICAgbGV0IHJlY2VpcHQ6IFJlY2VpcHQ7XG4gICAgICB0cnkge1xuICAgICAgICByZWNlaXB0ID0gYXdhaXQgZWZmZWN0cy5wcmVwYXJlKGNvcHlTZWxlY3Rpb24ocmVxdWVzdGVkKSk7XG4gICAgICB9IGNhdGNoIChwcmVwYXJlRXJyb3IpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvdXRjb21lOiBcInByZXBhcmUtZmFpbGVkXCIsXG4gICAgICAgICAgZXJyb3I6IGZpbmlzaFdpdGhFcnJvcihcImlkbGVcIiwgcHJlcGFyZUVycm9yKSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBjb21wbGV0ZVByZXBhcmVkKHJlcXVlc3RlZCwgcmVjZWlwdCk7XG4gICAgfSxcbiAgICBhc3luYyByZXN1bWVQcmVwYXJlZChzZWxlY3Rpb24sIHJlY2VpcHQpOiBQcm9taXNlPEVudmlyb25tZW50QXBwbHlPdXRjb21lPFJlY2VpcHQ+PiB7XG4gICAgICBpZiAoYnVzeSkgcmV0dXJuIHsgb3V0Y29tZTogXCJidXN5XCIgfTtcbiAgICAgIHBlbmRpbmdWYWx1ZSA9IGNvcHlTZWxlY3Rpb24oc2VsZWN0aW9uKTtcbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgZXJyb3IgPSBudWxsO1xuICAgICAgcmV0dXJuIGNvbXBsZXRlUHJlcGFyZWQoY29weVNlbGVjdGlvbihzZWxlY3Rpb24pLCByZWNlaXB0KTtcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBjb3B5U2VsZWN0aW9uKHNlbGVjdGlvbjogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyKTogRW52aXJvbm1lbnRTZWxlY3Rpb25QYWlyIHtcbiAgcmV0dXJuIHtcbiAgICBhcHBFeHBlcmllbmNlOiBzZWxlY3Rpb24uYXBwRXhwZXJpZW5jZSxcbiAgICByZWxlYXNlUHJvZmlsZTogc2VsZWN0aW9uLnJlbGVhc2VQcm9maWxlLFxuICB9O1xufVxuXG5mdW5jdGlvbiBzYW1lU2VsZWN0aW9uKGxlZnQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpciwgcmlnaHQ6IEVudmlyb25tZW50U2VsZWN0aW9uUGFpcik6IGJvb2xlYW4ge1xuICByZXR1cm4gbGVmdC5hcHBFeHBlcmllbmNlID09PSByaWdodC5hcHBFeHBlcmllbmNlXG4gICAgJiYgbGVmdC5yZWxlYXNlUHJvZmlsZSA9PT0gcmlnaHQucmVsZWFzZVByb2ZpbGU7XG59XG5cbmZ1bmN0aW9uIGVudmlyb25tZW50Q29uZmlnRXJyb3IoZXJyb3I6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IgfHwgXCJVbmtub3duIGVycm9yXCIpO1xufVxuXG5leHBvcnQgdHlwZSBEZXNrdG9wVXBkYXRlU3RhdHVzID1cbiAgfCBcInVwZGF0ZS1hdmFpbGFibGVcIlxuICB8IFwiY3VycmVudFwiXG4gIHwgXCJzdGFsZVwiXG4gIHwgXCJ1bmF2YWlsYWJsZVwiXG4gIHwgXCJlcnJvclwiO1xuXG5leHBvcnQgZnVuY3Rpb24gaHVtYW5pemVDb2RleFBoYXNlKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZSgvWy1fXS9nLCBcIiBcIikucmVwbGFjZSgvXFxiXFx3L2csIChsZXR0ZXIpID0+IGxldHRlci50b1VwcGVyQ2FzZSgpKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uVHJhbnNhY3Rpb24ge1xuICBwaGFzZTogc3RyaW5nO1xuICBzYWZlT2ZmaWNpYWxNb2RlPzogYm9vbGVhbjtcbiAgcmVzdW1hYmxlPzogYm9vbGVhbjtcbiAgZW52aXJvbm1lbnRUcmFuc2FjdGlvbklkPzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmcgfCBudWxsO1xuICBibG9ja3NMaWZlY3ljbGU/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb25JbnB1dCB7XG4gIGJ1c3k6IGJvb2xlYW47XG4gIHN0YXR1czogRGVza3RvcFVwZGF0ZVN0YXR1cyB8IHVuZGVmaW5lZDtcbiAgdHJhbnNhY3Rpb246IERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb25UcmFuc2FjdGlvbiB8IG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbkFjdGlvbiB7XG4gIGtpbmQ6IFwicmVzdW1lXCIgfCBcImNhbmNlbFwiO1xuICBsYWJlbDogXCJSZXN1bWVcIiB8IFwiQ2FuY2VsXCI7XG4gIGRpc2FibGVkOiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb24ge1xuICBwaGFzZUxhYmVsOiBzdHJpbmcgfCBudWxsO1xuICB0b25lOiBcIm9rXCIgfCBcIndhcm5cIiB8IFwiZXJyb3JcIiB8IG51bGw7XG4gIGFjdGlvbnM6IERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb25BY3Rpb25bXTtcbiAgdXBkYXRlRGlzYWJsZWQ6IGJvb2xlYW47XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBkZXNrdG9wVXBkYXRlUHJlc2VudGF0aW9uKFxuICBpbnB1dDogRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbklucHV0LFxuKTogRGVza3RvcFVwZGF0ZVByZXNlbnRhdGlvbiB7XG4gIGNvbnN0IHsgYnVzeSwgc3RhdHVzLCB0cmFuc2FjdGlvbiB9ID0gaW5wdXQ7XG4gIGNvbnN0IHBoYXNlID0gdHJhbnNhY3Rpb24/LnBoYXNlID8/IG51bGw7XG4gIGNvbnN0IHJlc3VtYWJsZSA9IHRyYW5zYWN0aW9uPy5yZXN1bWFibGUgPT09IHRydWU7XG4gIGNvbnN0IGluYWN0aXZlID0gcGhhc2UgPT09IG51bGwgfHwgcGhhc2UgPT09IFwiaWRsZVwiO1xuICBjb25zdCB0ZXJtaW5hbCA9IHBoYXNlID09PSBcImNvbXBsZXRlZFwiIHx8IHBoYXNlID09PSBcImZhaWxlZFwiIHx8IHBoYXNlID09PSBcInJvbGxlZF9iYWNrXCI7XG4gIGNvbnN0IHVuc2FmZUZhaWx1cmUgPSBwaGFzZSA9PT0gXCJmYWlsZWRcIiAmJiB0cmFuc2FjdGlvbj8uc2FmZU9mZmljaWFsTW9kZSAhPT0gdHJ1ZTtcbiAgY29uc3QgYmxvY2tzTGlmZWN5Y2xlID0gdHJhbnNhY3Rpb24/LmJsb2Nrc0xpZmVjeWNsZVxuICAgID8/IChcbiAgICAgICF0ZXJtaW5hbFxuICAgICAgfHwgcmVzdW1hYmxlXG4gICAgICB8fCAoXG4gICAgICAgIHBoYXNlID09PSBcImZhaWxlZFwiXG4gICAgICAgICYmIChcbiAgICAgICAgICB0cmFuc2FjdGlvbj8uc2FmZU9mZmljaWFsTW9kZSAhPT0gdHJ1ZVxuICAgICAgICAgIHx8IC9cXGJyb2xsYmFjayBmYWlsZWRcXGIvaS50ZXN0KHRyYW5zYWN0aW9uPy5lcnJvciA/PyBcIlwiKVxuICAgICAgICApXG4gICAgICApXG4gICAgKTtcbiAgY29uc3QgcmV0cnlhYmxlVW5zYWZlUmVjb3ZlcnkgPSB1bnNhZmVGYWlsdXJlXG4gICAgJiYgdHlwZW9mIHRyYW5zYWN0aW9uPy5lbnZpcm9ubWVudFRyYW5zYWN0aW9uSWQgPT09IFwic3RyaW5nXCI7XG4gIGNvbnN0IGFjdGlvbnM6IERlc2t0b3BVcGRhdGVQcmVzZW50YXRpb25BY3Rpb25bXSA9IFtdO1xuICBpZiAocmVzdW1hYmxlICYmIChwaGFzZSA9PT0gXCJmYWlsZWRcIiB8fCBwaGFzZSA9PT0gXCJyb2xsZWRfYmFja1wiKSkge1xuICAgIGFjdGlvbnMucHVzaCh7IGtpbmQ6IFwicmVzdW1lXCIsIGxhYmVsOiBcIlJlc3VtZVwiLCBkaXNhYmxlZDogYnVzeSB9KTtcbiAgfVxuICBpZiAocGhhc2UgPT09IFwiYXdhaXRpbmdfbmF0aXZlX3VwZGF0ZVwiXG4gICAgfHwgKHJlc3VtYWJsZSAmJiAocGhhc2UgPT09IFwiZmFpbGVkXCIgfHwgcGhhc2UgPT09IFwicm9sbGVkX2JhY2tcIikpXG4gICAgfHwgcmV0cnlhYmxlVW5zYWZlUmVjb3ZlcnkpIHtcbiAgICBhY3Rpb25zLnB1c2goeyBraW5kOiBcImNhbmNlbFwiLCBsYWJlbDogXCJDYW5jZWxcIiwgZGlzYWJsZWQ6IGJ1c3kgfSk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwaGFzZUxhYmVsOiBwaGFzZSA9PT0gbnVsbCA/IG51bGwgOiBodW1hbml6ZUNvZGV4UGhhc2UocGhhc2UpLFxuICAgIHRvbmU6IHBoYXNlID09PSBudWxsXG4gICAgICA/IG51bGxcbiAgICAgIDogcGhhc2UgPT09IFwiY29tcGxldGVkXCJcbiAgICAgICAgPyBcIm9rXCJcbiAgICAgICAgOiBwaGFzZSA9PT0gXCJmYWlsZWRcIiAmJiAhcmVzdW1hYmxlXG4gICAgICAgICAgPyBcImVycm9yXCJcbiAgICAgICAgICA6IFwid2FyblwiLFxuICAgIGFjdGlvbnMsXG4gICAgdXBkYXRlRGlzYWJsZWQ6IGJ1c3lcbiAgICAgIHx8IHN0YXR1cyAhPT0gXCJ1cGRhdGUtYXZhaWxhYmxlXCJcbiAgICAgIHx8ICghaW5hY3RpdmUgJiYgYmxvY2tzTGlmZWN5Y2xlKSxcbiAgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGRlc2t0b3BVcGRhdGVTdGF0dXNQcmVzZW50YXRpb24oXG4gIHN0YXR1czogRGVza3RvcFVwZGF0ZVN0YXR1cyB8IHVuZGVmaW5lZCxcbik6IHsgbGFiZWw6IHN0cmluZzsgdG9uZTogXCJva1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIgfSB7XG4gIHN3aXRjaCAoc3RhdHVzKSB7XG4gICAgY2FzZSBcImN1cnJlbnRcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVwIHRvIGRhdGVcIiwgdG9uZTogXCJva1wiIH07XG4gICAgY2FzZSBcInVwZGF0ZS1hdmFpbGFibGVcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVwZGF0ZSBhdmFpbGFibGVcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgICBjYXNlIFwiZXJyb3JcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIkVycm9yXCIsIHRvbmU6IFwiZXJyb3JcIiB9O1xuICAgIGNhc2UgXCJzdGFsZVwiOlxuICAgICAgcmV0dXJuIHsgbGFiZWw6IFwiU3RhbGVcIiwgdG9uZTogXCJ3YXJuXCIgfTtcbiAgICBjYXNlIFwidW5hdmFpbGFibGVcIjpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIlVuYXZhaWxhYmxlXCIsIHRvbmU6IFwid2FyblwiIH07XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiB7IGxhYmVsOiBcIk5vdCBjaGVja2VkXCIsIHRvbmU6IFwid2FyblwiIH07XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbnZpcm9ubWVudEZvY3VzVGFyZ2V0IHtcbiAgcmVhZG9ubHkgaXNDb25uZWN0ZWQ6IGJvb2xlYW47XG4gIGZvY3VzKCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiByZXN0b3JlRW52aXJvbm1lbnRGb2N1cyhcbiAgb3BlbmVyOiBFbnZpcm9ubWVudEZvY3VzVGFyZ2V0IHwgbnVsbCxcbiAgZmFsbGJhY2s6ICgpID0+IEVudmlyb25tZW50Rm9jdXNUYXJnZXQgfCBudWxsLFxuKTogXCJvcGVuZXJcIiB8IFwiZmFsbGJhY2tcIiB8IFwibm9uZVwiIHtcbiAgaWYgKG9wZW5lcj8uaXNDb25uZWN0ZWQpIHtcbiAgICBvcGVuZXIuZm9jdXMoKTtcbiAgICByZXR1cm4gXCJvcGVuZXJcIjtcbiAgfVxuICBjb25zdCB0YXJnZXQgPSBmYWxsYmFjaygpO1xuICBpZiAodGFyZ2V0Py5pc0Nvbm5lY3RlZCkge1xuICAgIHRhcmdldC5mb2N1cygpO1xuICAgIHJldHVybiBcImZhbGxiYWNrXCI7XG4gIH1cbiAgcmV0dXJuIFwibm9uZVwiO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpZ0NhcmRVcGRhdGVUb2tlbiB7XG4gIHJlYWRvbmx5IGNhcmQ6IHN0cmluZztcbiAgcmVhZG9ubHkgZ2VuZXJhdGlvbjogbnVtYmVyO1xufVxuXG4vKipcbiAqIEtlZXBzIGFzeW5jaHJvbm91cyBDb25maWcgY2FyZHMgaW5kZXBlbmRlbnQgd2hpbGUgcmVqZWN0aW5nIGEgc3RhbGUgcmVzdWx0XG4gKiBmcm9tIGFuIG9sZGVyIHJlcXVlc3QgZm9yIHRoZSBzYW1lIGNhcmQuXG4gKi9cbmV4cG9ydCBjbGFzcyBDb25maWdDYXJkVXBkYXRlQ29vcmRpbmF0b3I8VmFsdWU+IHtcbiAgcmVhZG9ubHkgI2dlbmVyYXRpb25zID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgcmVhZG9ubHkgI3ZhbHVlcyA9IG5ldyBNYXA8c3RyaW5nLCBWYWx1ZT4oKTtcblxuICBiZWdpbihjYXJkOiBzdHJpbmcpOiBDb25maWdDYXJkVXBkYXRlVG9rZW4ge1xuICAgIGNvbnN0IGdlbmVyYXRpb24gPSAodGhpcy4jZ2VuZXJhdGlvbnMuZ2V0KGNhcmQpID8/IDApICsgMTtcbiAgICB0aGlzLiNnZW5lcmF0aW9ucy5zZXQoY2FyZCwgZ2VuZXJhdGlvbik7XG4gICAgcmV0dXJuIE9iamVjdC5mcmVlemUoeyBjYXJkLCBnZW5lcmF0aW9uIH0pO1xuICB9XG5cbiAgY29tcGxldGUodG9rZW46IENvbmZpZ0NhcmRVcGRhdGVUb2tlbiwgdmFsdWU6IFZhbHVlKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmlzQ3VycmVudCh0b2tlbikpIHJldHVybiBmYWxzZTtcbiAgICB0aGlzLiN2YWx1ZXMuc2V0KHRva2VuLmNhcmQsIHZhbHVlKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIGlzQ3VycmVudCh0b2tlbjogQ29uZmlnQ2FyZFVwZGF0ZVRva2VuKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuIHRoaXMuI2dlbmVyYXRpb25zLmdldCh0b2tlbi5jYXJkKSA9PT0gdG9rZW4uZ2VuZXJhdGlvbjtcbiAgfVxuXG4gIGludmFsaWRhdGUoY2FyZDogc3RyaW5nKTogdm9pZCB7XG4gICAgdGhpcy4jZ2VuZXJhdGlvbnMuc2V0KGNhcmQsICh0aGlzLiNnZW5lcmF0aW9ucy5nZXQoY2FyZCkgPz8gMCkgKyAxKTtcbiAgfVxuXG4gIHZhbHVlKGNhcmQ6IHN0cmluZyk6IFZhbHVlIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy4jdmFsdWVzLmdldChjYXJkKTtcbiAgfVxuXG4gIHNuYXBzaG90KCk6IFJlY29yZDxzdHJpbmcsIFZhbHVlPiB7XG4gICAgcmV0dXJuIE9iamVjdC5mcm9tRW50cmllcyh0aGlzLiN2YWx1ZXMpO1xuICB9XG59XG4iLCAiLyoqXG4gKiBSZW5kZXJlci1zaWRlIHR3ZWFrIGhvc3QuIFdlOlxuICogICAxLiBBc2sgbWFpbiBmb3IgdGhlIHR3ZWFrIGxpc3QgKHdpdGggcmVzb2x2ZWQgZW50cnkgcGF0aCkuXG4gKiAgIDIuIEZvciBlYWNoIHJlbmRlcmVyLXNjb3BlZCAob3IgXCJib3RoXCIpIHR3ZWFrLCBmZXRjaCBpdHMgc291cmNlIHZpYSBJUENcbiAqICAgICAgYW5kIGV4ZWN1dGUgaXQgYXMgYSBDb21tb25KUy1zaGFwZWQgZnVuY3Rpb24uXG4gKiAgIDMuIFByb3ZpZGUgaXQgdGhlIHJlbmRlcmVyIGhhbGYgb2YgdGhlIEFQSS5cbiAqXG4gKiBDb2RleCBydW5zIHRoZSByZW5kZXJlciB3aXRoIHNhbmRib3g6IHRydWUsIHNvIE5vZGUncyBgcmVxdWlyZSgpYCBpc1xuICogcmVzdHJpY3RlZCB0byBhIHRpbnkgd2hpdGVsaXN0IChlbGVjdHJvbiArIGEgZmV3IHBvbHlmaWxscykuIFRoYXQgbWVhbnMgd2VcbiAqIGNhbm5vdCBgcmVxdWlyZSgpYCBhcmJpdHJhcnkgdHdlYWsgZmlsZXMgZnJvbSBkaXNrLiBJbnN0ZWFkIHdlIHB1bGwgdGhlXG4gKiBzb3VyY2Ugc3RyaW5nIGZyb20gbWFpbiBhbmQgZXZhbHVhdGUgaXQgd2l0aCBgbmV3IEZ1bmN0aW9uYCBpbnNpZGUgdGhlXG4gKiBwcmVsb2FkIGNvbnRleHQuIFR3ZWFrIGF1dGhvcnMgd2hvIG5lZWQgbnBtIGRlcHMgbXVzdCBidW5kbGUgdGhlbSBpbi5cbiAqL1xuXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uLCByZWdpc3RlclBhZ2UsIGNsZWFyU2VjdGlvbnMsIHNldExpc3RlZFR3ZWFrcywgdXBkYXRlTGlzdGVkVHdlYWtMaWZlY3ljbGUgfSBmcm9tIFwiLi9zZXR0aW5ncy1pbmplY3RvclwiO1xuaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHsgaG9zdFVpQXBpIH0gZnJvbSBcIi4vaG9zdC1zdXJmYWNlc1wiO1xuaW1wb3J0IHsgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsIHJ1bldpdGhTdGFydHVwVGltZW91dCB9IGZyb20gXCIuLi90d2Vhay1saWZlY3ljbGVcIjtcbmltcG9ydCB0eXBlIHsgVHdlYWtIZWFsdGhSZWNvcmQsIFR3ZWFrU3RhdHVzLCBUd2Vha1N0b3JlRW50cnkgfSBmcm9tIFwiLi4vdHdlYWstc3RvcmVcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ29kZXhDZHBTdGF0dXMsXG4gIENvZGV4Q2RwVGFyZ2V0LFxuICBDb2RleFJ1bnRpbWVDYXBhYmlsaXRpZXMsXG4gIENvZGV4UnVudGltZUluZm8sXG4gIENvZGV4Vmlld1JlZixcbiAgQ29kZXhXaW5kb3dSZWYsXG4gIE5hdGl2ZUhlbHBlckxhdW5jaE9wdGlvbnMsXG4gIE5hdGl2ZUhlbHBlclJlZixcbiAgTmF0aXZlTW9kdWxlS2luZCxcbiAgTmF0aXZlTW9kdWxlTG9hZE9wdGlvbnMsXG4gIE5hdGl2ZU1vZHVsZVJlZixcbiAgTmF0aXZlUGFuZWxDcmVhdGVPcHRpb25zLFxuICBOYXRpdmVQYW5lbFJlZixcbiAgTmF0aXZlVmlld0F0dGFjaE9wdGlvbnMsXG4gIE5hdGl2ZVZpZXdSZWYsXG4gIFR3ZWFrTWFuaWZlc3QsXG4gIFR3ZWFrQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbiAgVHdlYWssXG59IGZyb20gXCJAdGhlcmVhbGl0eXJlcG9ydC90d2Vha2Vycy1zZGtcIjtcbmltcG9ydCB7IGNyZWF0ZVJlbmRlcmVyU3RvcmFnZSB9IGZyb20gXCIuLi9yZW5kZXJlci1zdG9yYWdlXCI7XG5cbmludGVyZmFjZSBMaXN0ZWRUd2VhayB7XG4gIG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0O1xuICBlbnRyeTogc3RyaW5nO1xuICBkaXI6IHN0cmluZztcbiAgZW50cnlFeGlzdHM6IGJvb2xlYW47XG4gIGluc3RhbGxlZDogYm9vbGVhbjtcbiAgZW5hYmxlZDogYm9vbGVhbjtcbiAgc3RhdHVzOiBUd2Vha1N0YXR1cztcbiAgaGVhbHRoOiBUd2Vha0hlYWx0aFJlY29yZCB8IG51bGw7XG4gIGNhdGFsb2c6IFR3ZWFrU3RvcmVFbnRyeSB8IG51bGw7XG4gIHVwZGF0ZToge1xuICAgIGNoZWNrZWRBdDogc3RyaW5nO1xuICAgIHJlcG86IHN0cmluZztcbiAgICBjdXJyZW50VmVyc2lvbjogc3RyaW5nO1xuICAgIGxhdGVzdFZlcnNpb246IHN0cmluZyB8IG51bGw7XG4gICAgbGF0ZXN0VGFnOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlbGVhc2VVcmw6IHN0cmluZyB8IG51bGw7XG4gICAgdXBkYXRlQXZhaWxhYmxlOiBib29sZWFuO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9IHwgbnVsbDtcbn1cblxuaW50ZXJmYWNlIFVzZXJQYXRocyB7XG4gIHVzZXJSb290OiBzdHJpbmc7XG4gIHJ1bnRpbWVEaXI6IHN0cmluZztcbiAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gIGxvZ0Rpcjogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgRWxlY3Ryb25CcmlkZ2Uge1xuICBnZXRCdWlsZEZsYXZvcj86ICgpID0+IHN0cmluZyB8IG51bGw7XG4gIHVzZXNPd2xBcHBTaGVsbD86ICgpID0+IGJvb2xlYW47XG59XG5cbmNvbnN0IGxvYWRlZCA9IG5ldyBNYXA8c3RyaW5nLCB7IHN0b3A/OiAoKSA9PiB2b2lkIH0+KCk7XG5sZXQgY2FjaGVkUGF0aHM6IFVzZXJQYXRocyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc3RhcnRUd2Vha0hvc3QoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHR3ZWFrcyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmxpc3QtdHdlYWtzXCIpKSBhcyBMaXN0ZWRUd2Vha1tdO1xuICBjb25zdCBwYXRocyA9IChhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnVzZXItcGF0aHNcIikpIGFzIFVzZXJQYXRocztcbiAgY2FjaGVkUGF0aHMgPSBwYXRocztcbiAgLy8gUHVzaCB0aGUgbGlzdCB0byB0aGUgc2V0dGluZ3MgaW5qZWN0b3Igc28gdGhlIFR3ZWFrcyBwYWdlIGNhbiByZW5kZXJcbiAgLy8gY2FyZHMgZXZlbiBiZWZvcmUgYW55IHR3ZWFrJ3Mgc3RhcnQoKSBydW5zIChhbmQgZm9yIGRpc2FibGVkIHR3ZWFrc1xuICAvLyB0aGF0IHdlIG5ldmVyIGxvYWQpLlxuICBzZXRMaXN0ZWRUd2Vha3ModHdlYWtzKTtcbiAgLy8gU3Rhc2ggZm9yIHRoZSBzZXR0aW5ncyBpbmplY3RvcidzIGVtcHR5LXN0YXRlIG1lc3NhZ2UuXG4gICh3aW5kb3cgYXMgdW5rbm93biBhcyB7IF9fdHdlYWtlcl90d2Vha3NfZGlyX18/OiBzdHJpbmcgfSkuX190d2Vha2VyX3R3ZWFrc19kaXJfXyA9XG4gICAgcGF0aHMudHdlYWtzRGlyO1xuXG4gIGZvciAoY29uc3QgdCBvZiB0d2Vha3MpIHtcbiAgICBpZiAodC5tYW5pZmVzdC5zY29wZSA9PT0gXCJtYWluXCIpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJkaXNhYmxlZFwiLCBcIm1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghdC5lbnRyeUV4aXN0cykge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcImRpc2FibGVkXCIsIFwibWlzc2luZyBlbnRyeVwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXQuZW5hYmxlZCkge1xuICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCB0LnN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiIDogXCJkaXNhYmxlZFwiKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBzZW5kTGlmZWN5Y2xlKHQubWFuaWZlc3QuaWQsIFwic3RhcnRpbmdcIik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bldpdGhTdGFydHVwVGltZW91dChcbiAgICAgICAgKCkgPT4gbG9hZFR3ZWFrKHQsIHBhdGhzKSxcbiAgICAgICAgREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4gICAgICApO1xuICAgICAgaWYgKHJlc3VsdC5zdGF0dXMgPT09IFwidGltZWRfb3V0XCIpIHtcbiAgICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInRpbWVkX291dFwiLCBgc3RhcnR1cCBleGNlZWRlZCAke0RFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TfW1zYCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbdHdlYWtlcl0gdHdlYWsgc3RhcnR1cCB0aW1lZCBvdXQ6XCIsIHQubWFuaWZlc3QuaWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgc2VuZExpZmVjeWNsZSh0Lm1hbmlmZXN0LmlkLCBcInJlYWR5XCIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIHNlbmRMaWZlY3ljbGUodC5tYW5pZmVzdC5pZCwgXCJmYWlsZWRcIiwgZSk7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW3R3ZWFrZXJdIHR3ZWFrIGxvYWQgZmFpbGVkOlwiLCB0Lm1hbmlmZXN0LmlkLCBlKTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlwY1JlbmRlcmVyLnNlbmQoXG4gICAgICAgICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgICAgICAgXCJlcnJvclwiLFxuICAgICAgICAgIFwidHdlYWsgbG9hZCBmYWlsZWQ6IFwiICsgdC5tYW5pZmVzdC5pZCArIFwiOiBcIiArIFN0cmluZygoZSBhcyBFcnJvcik/LnN0YWNrID8/IGUpLFxuICAgICAgICApO1xuICAgICAgfSBjYXRjaCB7fVxuICAgIH1cbiAgfVxuXG4gIGNvbnNvbGUuaW5mbyhcbiAgICBgW3R3ZWFrZXJdIHJlbmRlcmVyIGhvc3QgbG9hZGVkICR7bG9hZGVkLnNpemV9IHR3ZWFrKHMpOmAsXG4gICAgWy4uLmxvYWRlZC5rZXlzKCldLmpvaW4oXCIsIFwiKSB8fCBcIihub25lKVwiLFxuICApO1xuICBpcGNSZW5kZXJlci5zZW5kKFxuICAgIFwidHdlYWtlcjpwcmVsb2FkLWxvZ1wiLFxuICAgIFwiaW5mb1wiLFxuICAgIGByZW5kZXJlciBob3N0IGxvYWRlZCAke2xvYWRlZC5zaXplfSB0d2VhayhzKTogJHtbLi4ubG9hZGVkLmtleXMoKV0uam9pbihcIiwgXCIpIHx8IFwiKG5vbmUpXCJ9YCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gc2VuZExpZmVjeWNsZShcbiAgaWQ6IHN0cmluZyxcbiAgc3RhdHVzOiBcInN0YXJ0aW5nXCIgfCBcInJlYWR5XCIgfCBcImZhaWxlZFwiIHwgXCJ0aW1lZF9vdXRcIiB8IFwiZGlzYWJsZWRcIiB8IFwicXVhcmFudGluZWRcIixcbiAgZXJyb3I/OiB1bmtub3duLFxuKTogdm9pZCB7XG4gIGNvbnN0IHJlbmRlcmVyTGlmZWN5Y2xlID0gc3RhdHVzID09PSBcImRpc2FibGVkXCIgJiYgZXJyb3IgPT09IFwibWlzc2luZyBlbnRyeVwiID8gXCJmYWlsZWRcIlxuICAgIDogc3RhdHVzID09PSBcInN0YXJ0aW5nXCIgPyBcInN0YXJ0aW5nXCJcbiAgICA6IHN0YXR1cyA9PT0gXCJmYWlsZWRcIiA/IFwiZmFpbGVkXCJcbiAgICA6IHN0YXR1cyA9PT0gXCJ0aW1lZF9vdXRcIiA/IFwidGltZWRfb3V0XCJcbiAgICA6IHN0YXR1cyA9PT0gXCJxdWFyYW50aW5lZFwiID8gXCJxdWFyYW50aW5lZFwiXG4gICAgOiBcImVuYWJsZWRcIjtcbiAgdXBkYXRlTGlzdGVkVHdlYWtMaWZlY3ljbGUoaWQsIHJlbmRlcmVyTGlmZWN5Y2xlLCBlcnJvciA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcbiAgdHJ5IHtcbiAgICBpcGNSZW5kZXJlci5zZW5kKFwidHdlYWtlcjp0d2Vhay1saWZlY3ljbGVcIiwge1xuICAgICAgaWQsXG4gICAgICBwcm9jZXNzOiBcInJlbmRlcmVyXCIsXG4gICAgICBzdGF0dXMsXG4gICAgICAuLi4oZXJyb3IgPT09IHVuZGVmaW5lZCA/IHt9IDogeyBlcnJvcjogZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpIH0pLFxuICAgIH0pO1xuICB9IGNhdGNoIHtcbiAgICAvLyBMaWZlY3ljbGUgdGVsZW1ldHJ5IG11c3QgbmV2ZXIgdGFrZSBkb3duIHRoZSByZW5kZXJlciBob3N0LlxuICB9XG59XG5cbi8qKlxuICogU3RvcCBldmVyeSByZW5kZXJlci1zY29wZSB0d2VhayBzbyBhIHN1YnNlcXVlbnQgYHN0YXJ0VHdlYWtIb3N0KClgIHdpbGxcbiAqIHJlLWV2YWx1YXRlIGZyZXNoIHNvdXJjZS4gTW9kdWxlIGNhY2hlIGlzbid0IHJlbGV2YW50IHNpbmNlIHdlIGV2YWxcbiAqIHNvdXJjZSBzdHJpbmdzIGRpcmVjdGx5IFx1MjAxNCBlYWNoIGxvYWQgY3JlYXRlcyBhIGZyZXNoIHNjb3BlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdGVhcmRvd25Ud2Vha0hvc3QoKTogdm9pZCB7XG4gIGZvciAoY29uc3QgW2lkLCB0XSBvZiBsb2FkZWQpIHtcbiAgICB0cnkge1xuICAgICAgdC5zdG9wPy4oKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbdHdlYWtlcl0gdHdlYWsgc3RvcCBmYWlsZWQ6XCIsIGlkLCBlKTtcbiAgICB9IGZpbmFsbHkge1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctZGlzcG9zZS10d2Vha1wiLCBpZCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgdm9pZCBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1kaXNwb3NlLXR3ZWFrXCIsIGlkKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfVxuICB9XG4gIGxvYWRlZC5jbGVhcigpO1xuICBjbGVhclNlY3Rpb25zKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRUd2Vhayh0OiBMaXN0ZWRUd2VhaywgcGF0aHM6IFVzZXJQYXRocyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzb3VyY2UgPSAoYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgIFwidHdlYWtlcjpyZWFkLXR3ZWFrLXNvdXJjZVwiLFxuICAgIHQuZW50cnksXG4gICkpIGFzIHN0cmluZztcblxuICAvLyBFdmFsdWF0ZSBhcyBDSlMtc2hhcGVkOiBwcm92aWRlIG1vZHVsZS9leHBvcnRzL2FwaS4gVHdlYWsgY29kZSBtYXkgdXNlXG4gIC8vIGBtb2R1bGUuZXhwb3J0cyA9IHsgc3RhcnQsIHN0b3AgfWAgb3IgYGV4cG9ydHMuc3RhcnQgPSAuLi5gIG9yIHB1cmUgRVNNXG4gIC8vIGRlZmF1bHQgZXhwb3J0IHNoYXBlICh3ZSBhY2NlcHQgYm90aCkuXG4gIGNvbnN0IG1vZHVsZSA9IHsgZXhwb3J0czoge30gYXMgeyBkZWZhdWx0PzogVHdlYWsgfSAmIFR3ZWFrIH07XG4gIGNvbnN0IGV4cG9ydHMgPSBtb2R1bGUuZXhwb3J0cztcbiAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1pbXBsaWVkLWV2YWwsIG5vLW5ldy1mdW5jXG4gIGNvbnN0IGZuID0gbmV3IEZ1bmN0aW9uKFxuICAgIFwibW9kdWxlXCIsXG4gICAgXCJleHBvcnRzXCIsXG4gICAgXCJjb25zb2xlXCIsXG4gICAgYCR7c291cmNlfVxcbi8vIyBzb3VyY2VVUkw9dHdlYWtlci10d2VhazovLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHQubWFuaWZlc3QuaWQpfS8ke2VuY29kZVVSSUNvbXBvbmVudCh0LmVudHJ5KX1gLFxuICApO1xuICBmbihtb2R1bGUsIGV4cG9ydHMsIGNvbnNvbGUpO1xuICBjb25zdCBtb2QgPSBtb2R1bGUuZXhwb3J0cyBhcyB7IGRlZmF1bHQ/OiBUd2VhayB9ICYgVHdlYWs7XG4gIGNvbnN0IHR3ZWFrOiBUd2VhayA9IChtb2QgYXMgeyBkZWZhdWx0PzogVHdlYWsgfSkuZGVmYXVsdCA/PyAobW9kIGFzIFR3ZWFrKTtcbiAgaWYgKHR5cGVvZiB0d2Vhaz8uc3RhcnQgIT09IFwiZnVuY3Rpb25cIikge1xuICAgIHRocm93IG5ldyBFcnJvcihgdHdlYWsgJHt0Lm1hbmlmZXN0LmlkfSBoYXMgbm8gc3RhcnQoKWApO1xuICB9XG4gIGNvbnN0IGFwaSA9IG1ha2VSZW5kZXJlckFwaSh0Lm1hbmlmZXN0LCBwYXRocyk7XG4gIGF3YWl0IHR3ZWFrLnN0YXJ0KGFwaSk7XG4gIGxvYWRlZC5zZXQodC5tYW5pZmVzdC5pZCwgeyBzdG9wOiB0d2Vhay5zdG9wPy5iaW5kKHR3ZWFrKSB9KTtcbn1cblxuZnVuY3Rpb24gbWFrZVJlbmRlcmVyQXBpKG1hbmlmZXN0OiBUd2Vha01hbmlmZXN0LCBwYXRoczogVXNlclBhdGhzKTogVHdlYWtBcGkge1xuICBjb25zdCBpZCA9IG1hbmlmZXN0LmlkO1xuICBjb25zdCBsb2cgPSAobGV2ZWw6IFwiZGVidWdcIiB8IFwiaW5mb1wiIHwgXCJ3YXJuXCIgfCBcImVycm9yXCIsIC4uLmE6IHVua25vd25bXSkgPT4ge1xuICAgIGNvbnN0IGNvbnNvbGVGbiA9XG4gICAgICBsZXZlbCA9PT0gXCJkZWJ1Z1wiID8gY29uc29sZS5kZWJ1Z1xuICAgICAgOiBsZXZlbCA9PT0gXCJ3YXJuXCIgPyBjb25zb2xlLndhcm5cbiAgICAgIDogbGV2ZWwgPT09IFwiZXJyb3JcIiA/IGNvbnNvbGUuZXJyb3JcbiAgICAgIDogY29uc29sZS5sb2c7XG4gICAgY29uc29sZUZuKGBbdHdlYWtlcl1bJHtpZH1dYCwgLi4uYSk7XG4gICAgLy8gQWxzbyBtaXJyb3IgdG8gbWFpbidzIGxvZyBmaWxlIHNvIHdlIGNhbiBkaWFnbm9zZSB0d2VhayBiZWhhdmlvclxuICAgIC8vIHdpdGhvdXQgYXR0YWNoaW5nIERldlRvb2xzLiBTdHJpbmdpZnkgZWFjaCBhcmcgZGVmZW5zaXZlbHkuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHBhcnRzID0gYS5tYXAoKHYpID0+IHtcbiAgICAgICAgaWYgKHR5cGVvZiB2ID09PSBcInN0cmluZ1wiKSByZXR1cm4gdjtcbiAgICAgICAgaWYgKHYgaW5zdGFuY2VvZiBFcnJvcikgcmV0dXJuIGAke3YubmFtZX06ICR7di5tZXNzYWdlfWA7XG4gICAgICAgIHRyeSB7IHJldHVybiBKU09OLnN0cmluZ2lmeSh2KTsgfSBjYXRjaCB7IHJldHVybiBTdHJpbmcodik7IH1cbiAgICAgIH0pO1xuICAgICAgaXBjUmVuZGVyZXIuc2VuZChcbiAgICAgICAgXCJ0d2Vha2VyOnByZWxvYWQtbG9nXCIsXG4gICAgICAgIGxldmVsLFxuICAgICAgICBgW3R3ZWFrICR7aWR9XSAke3BhcnRzLmpvaW4oXCIgXCIpfWAsXG4gICAgICApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc3dhbGxvdyBcdTIwMTQgbmV2ZXIgbGV0IGxvZ2dpbmcgYnJlYWsgYSB0d2VhayAqL1xuICAgIH1cbiAgfTtcblxuICByZXR1cm4ge1xuICAgIG1hbmlmZXN0LFxuICAgIHByb2Nlc3M6IFwicmVuZGVyZXJcIixcbiAgICBsb2c6IHtcbiAgICAgIGRlYnVnOiAoLi4uYSkgPT4gbG9nKFwiZGVidWdcIiwgLi4uYSksXG4gICAgICBpbmZvOiAoLi4uYSkgPT4gbG9nKFwiaW5mb1wiLCAuLi5hKSxcbiAgICAgIHdhcm46ICguLi5hKSA9PiBsb2coXCJ3YXJuXCIsIC4uLmEpLFxuICAgICAgZXJyb3I6ICguLi5hKSA9PiBsb2coXCJlcnJvclwiLCAuLi5hKSxcbiAgICB9LFxuICAgIHN0b3JhZ2U6IHJlbmRlcmVyU3RvcmFnZShpZCksXG4gICAgc2V0dGluZ3M6IHtcbiAgICAgIHJlZ2lzdGVyOiAocykgPT4gcmVnaXN0ZXJTZWN0aW9uKHsgLi4ucywgaWQ6IGAke2lkfToke3MuaWR9YCB9KSxcbiAgICAgIHJlZ2lzdGVyUGFnZTogKHApID0+XG4gICAgICAgIHJlZ2lzdGVyUGFnZShpZCwgbWFuaWZlc3QsIHsgLi4ucCwgaWQ6IGAke2lkfToke3AuaWR9YCB9KSxcbiAgICB9LFxuICAgIHJlYWN0OiB7XG4gICAgICBnZXRGaWJlcjogKG4pID0+IGZpYmVyRm9yTm9kZShuKSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwsXG4gICAgICBmaW5kT3duZXJCeU5hbWU6IChuLCBuYW1lKSA9PiB7XG4gICAgICAgIGxldCBmID0gZmliZXJGb3JOb2RlKG4pIGFzIFJlYWN0RmliZXJOb2RlIHwgbnVsbDtcbiAgICAgICAgd2hpbGUgKGYpIHtcbiAgICAgICAgICBjb25zdCB0ID0gZi50eXBlIGFzIHsgZGlzcGxheU5hbWU/OiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gICAgICAgICAgaWYgKHQgJiYgKHQuZGlzcGxheU5hbWUgPT09IG5hbWUgfHwgdC5uYW1lID09PSBuYW1lKSkgcmV0dXJuIGY7XG4gICAgICAgICAgZiA9IGYucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBudWxsO1xuICAgICAgfSxcbiAgICAgIHdhaXRGb3JFbGVtZW50OiAoc2VsLCB0aW1lb3V0TXMgPSA1MDAwKSA9PlxuICAgICAgICBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKHNlbCk7XG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSByZXR1cm4gcmVzb2x2ZShleGlzdGluZyk7XG4gICAgICAgICAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgdGltZW91dE1zO1xuICAgICAgICAgIGNvbnN0IG9icyA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzZWwpO1xuICAgICAgICAgICAgaWYgKGVsKSB7XG4gICAgICAgICAgICAgIG9icy5kaXNjb25uZWN0KCk7XG4gICAgICAgICAgICAgIHJlc29sdmUoZWwpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChEYXRlLm5vdygpID4gZGVhZGxpbmUpIHtcbiAgICAgICAgICAgICAgb2JzLmRpc2Nvbm5lY3QoKTtcbiAgICAgICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihgdGltZW91dCB3YWl0aW5nIGZvciAke3NlbH1gKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgICAgb2JzLm9ic2VydmUoZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgICAgICAgfSksXG4gICAgICBob3N0OiBob3N0VWlBcGksXG4gICAgfSxcbiAgICBpcGM6IHtcbiAgICAgIG9uOiAoYywgaCkgPT4ge1xuICAgICAgICBjb25zdCB3cmFwcGVkID0gKF9lOiB1bmtub3duLCAuLi5hcmdzOiB1bmtub3duW10pID0+IGgoLi4uYXJncyk7XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgICAgcmV0dXJuICgpID0+IGlwY1JlbmRlcmVyLnJlbW92ZUxpc3RlbmVyKGB0d2Vha2VyOiR7aWR9OiR7Y31gLCB3cmFwcGVkKTtcbiAgICAgIH0sXG4gICAgICBzZW5kOiAoYywgLi4uYXJncykgPT4gaXBjUmVuZGVyZXIuc2VuZChgdHdlYWtlcjoke2lkfToke2N9YCwgLi4uYXJncyksXG4gICAgICBpbnZva2U6IDxUPihjOiBzdHJpbmcsIC4uLmFyZ3M6IHVua25vd25bXSkgPT4ge1xuICAgICAgICBpZiAoaWQgPT09IFwiY28udHdlYWtlcnMudGhyZWFkLXN1bW1hcnktcHJvZmlsZXNcIiAmJiBjID09PSBcInByb2ZpbGVzLnJlYWRcIikge1xuICAgICAgICAgIHJldHVybiBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgICBcInR3ZWFrZXI6Y3Jvc3MtdHdlYWstcmVhZFwiLFxuICAgICAgICAgICAgaWQsXG4gICAgICAgICAgICBcImNvLnR3ZWFrZXJzLnByb2plY3RzXCIsXG4gICAgICAgICAgICBcInByb2ZpbGVzLnJlYWRcIixcbiAgICAgICAgICAgIGFyZ3NbMF0sXG4gICAgICAgICAgKSBhcyBQcm9taXNlPFQ+O1xuICAgICAgICB9XG4gICAgICAgIGlmIChpZCA9PT0gXCJjby50d2Vha2Vycy5mb2xsb3d1cFwiICYmIGMgPT09IFwicG9saWN5XCIpIHtcbiAgICAgICAgICByZXR1cm4gaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgICAgXCJ0d2Vha2VyOmNyb3NzLXR3ZWFrLXJlYWRcIixcbiAgICAgICAgICAgIGlkLFxuICAgICAgICAgICAgXCJjby50d2Vha2Vycy5wcm9qZWN0c1wiLFxuICAgICAgICAgICAgXCJmb2xsb3d1cC5wb2xpY3kucmVhZFwiLFxuICAgICAgICAgICAgYXJnc1swXSxcbiAgICAgICAgICApIGFzIFByb21pc2U8VD47XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGlwY1JlbmRlcmVyLmludm9rZShgdHdlYWtlcjoke2lkfToke2N9YCwgLi4uYXJncykgYXMgUHJvbWlzZTxUPjtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBmczogcmVuZGVyZXJGcyhpZCwgcGF0aHMpLFxuICAgIGNvZGV4OiByZW5kZXJlckNvZGV4QXBpKGlkKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmVuZGVyZXJDb2RleEFwaSh0d2Vha0lkOiBzdHJpbmcpOiBOb25OdWxsYWJsZTxUd2Vha0FwaVtcImNvZGV4XCJdPiB7XG4gIHJldHVybiB7XG4gICAgcnVudGltZToge1xuICAgICAgZ2V0SW5mbzogYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBpbmZvID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC1ydW50aW1lLWluZm9cIikgYXMgQ29kZXhSdW50aW1lSW5mbztcbiAgICAgICAgY29uc3QgYnJpZGdlID0gcmVuZGVyZXJFbGVjdHJvbkJyaWRnZSgpO1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIC4uLmluZm8sXG4gICAgICAgICAgYnVpbGRGbGF2b3I6IGJyaWRnZT8uZ2V0QnVpbGRGbGF2b3I/LigpID8/IGluZm8uYnVpbGRGbGF2b3IsXG4gICAgICAgICAgdXNlc093bEFwcFNoZWxsOiBicmlkZ2U/LnVzZXNPd2xBcHBTaGVsbD8uKCkgPz8gaW5mby51c2VzT3dsQXBwU2hlbGwsXG4gICAgICAgIH07XG4gICAgICB9LFxuICAgICAgZ2V0Q2FwYWJpbGl0aWVzOiAoKSA9PlxuICAgICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXJ1bnRpbWUtY2FwYWJpbGl0aWVzXCIpIGFzIFByb21pc2U8Q29kZXhSdW50aW1lQ2FwYWJpbGl0aWVzPixcbiAgICB9LFxuICAgIHdpbmRvd3M6IHtcbiAgICAgIGNyZWF0ZTogKG9wdGlvbnMpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LWNyZWF0ZVwiLCBvcHRpb25zKSBhcyBQcm9taXNlPENvZGV4V2luZG93UmVmPixcbiAgICAgIGdldFByaW1hcnk6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LXByaW1hcnlcIikgYXMgUHJvbWlzZTxDb2RleFdpbmRvd1JlZiB8IG51bGw+LFxuICAgICAgZm9jdXM6ICh3aW5kb3dJZCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC13aW5kb3ctZm9jdXNcIiwgd2luZG93SWQpIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gICAgICBzaG93OiAod2luZG93SWQpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtd2luZG93LXNob3dcIiwgd2luZG93SWQpIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gICAgfSxcbiAgICB2aWV3czoge1xuICAgICAgY3JlYXRlOiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOmNvZGV4LXZpZXctY3JlYXRlXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsgd2ViQ29udGVudHNJZDogbnVtYmVyOyBwYXJlbnRXaW5kb3dJZDogbnVtYmVyIHwgbnVsbCB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJDb2RleFZpZXdSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYud2ViQ29udGVudHNJZCwgcmVmLnBhcmVudFdpbmRvd0lkKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBjZHA6IHtcbiAgICAgIGdldFN0YXR1czogKCkgPT5cbiAgICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC1jZHAtc3RhdHVzXCIpIGFzIFByb21pc2U8Q29kZXhDZHBTdGF0dXM+LFxuICAgICAgbGlzdFRhcmdldHM6ICgpID0+XG4gICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtY2RwLXRhcmdldHNcIikgYXMgUHJvbWlzZTxDb2RleENkcFRhcmdldFtdPixcbiAgICB9LFxuICAgIG5hdGl2ZToge1xuICAgICAgbG9hZE1vZHVsZTogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpuYXRpdmUtbG9hZC1tb2R1bGVcIixcbiAgICAgICAgICB0d2Vha0lkLFxuICAgICAgICAgIG9wdGlvbnMsXG4gICAgICAgICkgYXMgeyBpZDogc3RyaW5nOyBraW5kOiBOYXRpdmVNb2R1bGVLaW5kIH07XG4gICAgICAgIHJldHVybiByZW5kZXJlck5hdGl2ZU1vZHVsZVJlZih0d2Vha0lkLCByZWYuaWQsIHJlZi5raW5kKTtcbiAgICAgIH0sXG4gICAgICBjcmVhdGVQYW5lbDogYXN5bmMgKG9wdGlvbnMpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gYXdhaXQgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICAgIFwidHdlYWtlcjpuYXRpdmUtY3JlYXRlLXBhbmVsXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsgd2luZG93SWQ6IG51bWJlciB8IG51bGwgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlUGFuZWxSZWYodHdlYWtJZCwgcmVmLmlkLCByZWYud2luZG93SWQpO1xuICAgICAgfSxcbiAgICAgIGF0dGFjaFZpZXc6IGFzeW5jIChvcHRpb25zKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlZiA9IGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcbiAgICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWF0dGFjaC12aWV3XCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZyB9O1xuICAgICAgICByZXR1cm4gcmVuZGVyZXJOYXRpdmVWaWV3UmVmKHR3ZWFrSWQsIHJlZi5pZCk7XG4gICAgICB9LFxuICAgICAgbGF1bmNoSGVscGVyOiBhc3luYyAob3B0aW9ucykgPT4ge1xuICAgICAgICBjb25zdCByZWYgPSBhd2FpdCBpcGNSZW5kZXJlci5pbnZva2UoXG4gICAgICAgICAgXCJ0d2Vha2VyOm5hdGl2ZS1sYXVuY2gtaGVscGVyXCIsXG4gICAgICAgICAgdHdlYWtJZCxcbiAgICAgICAgICBvcHRpb25zLFxuICAgICAgICApIGFzIHsgaWQ6IHN0cmluZzsgcGlkOiBudW1iZXIgfTtcbiAgICAgICAgcmV0dXJuIHJlbmRlcmVyTmF0aXZlSGVscGVyUmVmKHR3ZWFrSWQsIHJlZi5pZCwgcmVmLnBpZCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAgcmVmcmVzaDoge1xuICAgICAgZ2V0U3RhdHVzOiAoKSA9PiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmdldC1yZWZyZXNoLXN0YXR1c1wiKSxcbiAgICAgIHN0YXJ0OiAoc291cmNlID0gXCJzbWFydFwiKSA9PiBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOnN0YXJ0LWxvY2FsLXJlZnJlc2hcIiwgc291cmNlKSxcbiAgICAgIG9uU3RhdHVzQ2hhbmdlZDogKGxpc3RlbmVyKSA9PiB7XG4gICAgICAgIGNvbnN0IGhhbmRsZXIgPSAoKSA9PiB7IHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtcmVmcmVzaC1zdGF0dXNcIikudGhlbihsaXN0ZW5lcik7IH07XG4gICAgICAgIGlwY1JlbmRlcmVyLm9uKFwidHdlYWtlcjpyZWZyZXNoLXN0YXR1cy1jaGFuZ2VkXCIsIGhhbmRsZXIpO1xuICAgICAgICByZXR1cm4gKCkgPT4gaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoXCJ0d2Vha2VyOnJlZnJlc2gtc3RhdHVzLWNoYW5nZWRcIiwgaGFuZGxlcik7XG4gICAgICB9LFxuICAgIH0sXG4gICAgY2FwdHVyZToge1xuICAgICAgZ2V0UGVybWlzc2lvblN0YXR1czogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICAgIHJlcXVlc3RBY2Nlc3NpYmlsaXR5OiAoKSA9PiB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImFwaS5jb2RleC5jYXB0dXJlIGlzIG1haW4tb25seTsgdXNlIGEgbWFpbi1zY29wZWQgdHdlYWtcIik7XG4gICAgICB9LFxuICAgICAgb3BlblBlcm1pc3Npb25TZXR0aW5nczogKCkgPT4ge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY2FwdHVyZSBpcyBtYWluLW9ubHk7IHVzZSBhIG1haW4tc2NvcGVkIHR3ZWFrXCIpO1xuICAgICAgfSxcbiAgICAgIGNhcHR1cmVGcm9udG1vc3RXaW5kb3c6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmNhcHR1cmUgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBob3RrZXlzOiB7XG4gICAgICByZWdpc3RlckNhcHR1cmVIb3RrZXk6ICgpID0+IHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiYXBpLmNvZGV4LmhvdGtleXMgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICBjcmVhdGVCcm93c2VyVmlldzogKF9vcHRpb25zKSA9PiB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJhcGkuY29kZXguY3JlYXRlQnJvd3NlclZpZXcgaXMgbWFpbi1vbmx5OyB1c2UgYSBtYWluLXNjb3BlZCB0d2Vha1wiKTtcbiAgICB9LFxuICAgIGNyZWF0ZVdpbmRvdzogKG9wdGlvbnMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXdpbmRvdy1jcmVhdGVcIiwgb3B0aW9ucykgYXMgUHJvbWlzZTxDb2RleFdpbmRvd1JlZj4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyQ29kZXhWaWV3UmVmKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4gIHdlYkNvbnRlbnRzSWQ6IG51bWJlcixcbiAgcGFyZW50V2luZG93SWQ6IG51bWJlciB8IG51bGwsXG4pOiBDb2RleFZpZXdSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHdlYkNvbnRlbnRzSWQsXG4gICAgcGFyZW50V2luZG93SWQsXG4gICAgc2V0Qm91bmRzOiAoYm91bmRzKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwic2V0Qm91bmRzXCIsIGJvdW5kcykgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBzZXRWaXNpYmxlOiAodmlzaWJsZSkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInNldFZpc2libGVcIiwgdmlzaWJsZSkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBicmluZ1RvRnJvbnQ6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJicmluZ1RvRnJvbnRcIikgYXMgUHJvbWlzZTx2b2lkPixcbiAgICBsb2FkUm91dGU6IChyb3V0ZSwgaG9zdElkKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpjb2RleC12aWV3LWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwibG9hZFJvdXRlXCIsIHJvdXRlLCBob3N0SWQpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgbG9hZFVybDogKHVybCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y29kZXgtdmlldy1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcImxvYWRVcmxcIiwgdXJsKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOmNvZGV4LXZpZXctY2FsbFwiLCB0d2Vha0lkLCBpZCwgXCJkaXNwb3NlXCIpIGFzIFByb21pc2U8dm9pZD4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyTmF0aXZlTW9kdWxlUmVmKFxuICB0d2Vha0lkOiBzdHJpbmcsXG4gIGlkOiBzdHJpbmcsXG4gIGtpbmQ6IE5hdGl2ZU1vZHVsZUtpbmQsXG4pOiBOYXRpdmVNb2R1bGVSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGtpbmQsXG4gICAgcmVxdWVzdDogKG1ldGhvZCwgcGF5bG9hZCwgdGltZW91dE1zKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLW1vZHVsZS1yZXF1ZXN0XCIsXG4gICAgICAgIHR3ZWFrSWQsXG4gICAgICAgIGlkLFxuICAgICAgICBtZXRob2QsXG4gICAgICAgIHBheWxvYWQsXG4gICAgICAgIHRpbWVvdXRNcyxcbiAgICAgICksXG4gICAgZGlzcG9zZTogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLW1vZHVsZS1kaXNwb3NlXCIsIHR3ZWFrSWQsIGlkKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlck5hdGl2ZVBhbmVsUmVmKHR3ZWFrSWQ6IHN0cmluZywgaWQ6IHN0cmluZywgd2luZG93SWQ6IG51bWJlciB8IG51bGwpOiBOYXRpdmVQYW5lbFJlZiB7XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgd2luZG93SWQsXG4gICAgc2V0Qm91bmRzOiAoYm91bmRzKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInBhbmVsXCIsIGlkLCBcInNldEJvdW5kc1wiLCBib3VuZHMpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgc2hvdzogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJzaG93XCIpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgaGlkZTogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJoaWRlXCIpIGFzIFByb21pc2U8dm9pZD4sXG4gICAgZGlzcG9zZTogKCkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWluc3RhbmNlLWNhbGxcIiwgdHdlYWtJZCwgXCJwYW5lbFwiLCBpZCwgXCJkaXNwb3NlXCIpIGFzIFByb21pc2U8dm9pZD4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyTmF0aXZlVmlld1JlZih0d2Vha0lkOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBOYXRpdmVWaWV3UmVmIHtcbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBzZXRCb3VuZHM6IChib3VuZHMpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwidmlld1wiLCBpZCwgXCJzZXRCb3VuZHNcIiwgYm91bmRzKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIHNldFZpc2libGU6ICh2aXNpYmxlKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaW5zdGFuY2UtY2FsbFwiLCB0d2Vha0lkLCBcInZpZXdcIiwgaWQsIFwic2V0VmlzaWJsZVwiLCB2aXNpYmxlKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGRpc3Bvc2U6ICgpID0+XG4gICAgICBpcGNSZW5kZXJlci5pbnZva2UoXCJ0d2Vha2VyOm5hdGl2ZS1pbnN0YW5jZS1jYWxsXCIsIHR3ZWFrSWQsIFwidmlld1wiLCBpZCwgXCJkaXNwb3NlXCIpIGFzIFByb21pc2U8dm9pZD4sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHJlbmRlcmVyTmF0aXZlSGVscGVyUmVmKHR3ZWFrSWQ6IHN0cmluZywgaWQ6IHN0cmluZywgcGlkOiBudW1iZXIpOiBOYXRpdmVIZWxwZXJSZWYge1xuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIHBpZCxcbiAgICBzZW5kOiAobWVzc2FnZSkgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bmF0aXZlLWhlbHBlci1jYWxsXCIsIHR3ZWFrSWQsIGlkLCBcInNlbmRcIiwgbWVzc2FnZSkgYXMgUHJvbWlzZTx2b2lkPixcbiAgICByZXF1ZXN0OiAobWVzc2FnZSwgdGltZW91dE1zKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFxuICAgICAgICBcInR3ZWFrZXI6bmF0aXZlLWhlbHBlci1jYWxsXCIsXG4gICAgICAgIHR3ZWFrSWQsXG4gICAgICAgIGlkLFxuICAgICAgICBcInJlcXVlc3RcIixcbiAgICAgICAgbWVzc2FnZSxcbiAgICAgICAgdGltZW91dE1zLFxuICAgICAgKSxcbiAgICBzdG9wOiAoKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpuYXRpdmUtaGVscGVyLWNhbGxcIiwgdHdlYWtJZCwgaWQsIFwic3RvcFwiKSBhcyBQcm9taXNlPHZvaWQ+LFxuICB9O1xufVxuXG5mdW5jdGlvbiByZW5kZXJlckVsZWN0cm9uQnJpZGdlKCk6IEVsZWN0cm9uQnJpZGdlIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gKHdpbmRvdyBhcyB1bmtub3duIGFzIHsgZWxlY3Ryb25CcmlkZ2U/OiB1bmtub3duIH0pLmVsZWN0cm9uQnJpZGdlO1xuICByZXR1cm4gdmFsdWUgJiYgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiID8gdmFsdWUgYXMgRWxlY3Ryb25CcmlkZ2UgOiBudWxsO1xufVxuXG5leHBvcnQgY29uc3QgcmVuZGVyZXJTdG9yYWdlID0gKGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2UgPSBsb2NhbFN0b3JhZ2UpID0+IGNyZWF0ZVJlbmRlcmVyU3RvcmFnZShpZCwgc3RvcmFnZSk7XG5cbmZ1bmN0aW9uIHJlbmRlcmVyRnMoaWQ6IHN0cmluZywgX3BhdGhzOiBVc2VyUGF0aHMpIHtcbiAgLy8gU2FuZGJveGVkIHJlbmRlcmVyIGNhbid0IHVzZSBOb2RlIGZzIGRpcmVjdGx5IFx1MjAxNCBwcm94eSB0aHJvdWdoIG1haW4gSVBDLlxuICByZXR1cm4ge1xuICAgIGRhdGFEaXI6IGA8cmVtb3RlPi90d2Vhay1kYXRhLyR7aWR9YCxcbiAgICByZWFkOiAocDogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp0d2Vhay1mc1wiLCBcInJlYWRcIiwgaWQsIHApIGFzIFByb21pc2U8c3RyaW5nPixcbiAgICB3cml0ZTogKHA6IHN0cmluZywgYzogc3RyaW5nKSA9PlxuICAgICAgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjp0d2Vhay1mc1wiLCBcIndyaXRlXCIsIGlkLCBwLCBjKSBhcyBQcm9taXNlPHZvaWQ+LFxuICAgIGV4aXN0czogKHA6IHN0cmluZykgPT5cbiAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dHdlYWstZnNcIiwgXCJleGlzdHNcIiwgaWQsIHApIGFzIFByb21pc2U8Ym9vbGVhbj4sXG4gIH07XG59XG4iLCAiaW1wb3J0IHsgZmliZXJGb3JOb2RlIH0gZnJvbSBcIi4vcmVhY3QtaG9va1wiO1xuaW1wb3J0IHR5cGUge1xuICBIb3N0UHJvamVjdENvbnRleHQsXG4gIEhvc3RTdXJmYWNlS2luZCxcbiAgSG9zdFN1cmZhY2VNYXRjaCxcbiAgSG9zdFN1cmZhY2VTbmFwc2hvdCxcbiAgSG9zdFVpQXBpLFxuICBSZWFjdEZpYmVyTm9kZSxcbn0gZnJvbSBcIkB0aGVyZWFsaXR5cmVwb3J0L3R3ZWFrZXJzLXNka1wiO1xuXG5jb25zdCBNQVhfTUFUQ0hFUyA9IDEwMDtcbmNvbnN0IGxpc3RlbmVycyA9IG5ldyBTZXQ8eyBraW5kczogSG9zdFN1cmZhY2VLaW5kW107IGxpc3RlbmVyOiAoc25hcHNob3RzOiBIb3N0U3VyZmFjZVNuYXBzaG90W10pID0+IHZvaWQgfT4oKTtcbmxldCBzaGFyZWRPYnNlcnZlcjogTXV0YXRpb25PYnNlcnZlciB8IG51bGwgPSBudWxsO1xubGV0IHBlbmRpbmdGcmFtZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmNvbnN0IFNFTEVDVE9SUzogUmVjb3JkPEV4Y2x1ZGU8SG9zdFN1cmZhY2VLaW5kLCBcInByb2plY3RzXCIgfCBcInRocmVhZC1jb250ZXh0XCIgfCBcInVzYWdlXCI+LCBzdHJpbmc+ID0ge1xuICBcImFzc2lzdGFudC10dXJuc1wiOiAnW2RhdGEtdGVzdGlkPVwiY29udmVyc2F0aW9uLXR1cm5cIl0sIFtkYXRhLXRlc3RpZCo9XCJhc3Npc3RhbnQtbWVzc2FnZVwiIGldLCBbZGF0YS1tZXNzYWdlLWF1dGhvci1yb2xlPVwiYXNzaXN0YW50XCJdLCBbZGF0YS1yb2xlPVwiYXNzaXN0YW50XCJdJyxcbiAgY29tcG9zZXI6ICcjcHJvbXB0LXRleHRhcmVhLCBbZGF0YS10ZXN0aWQ9XCJjb21wb3NlclwiXSB0ZXh0YXJlYSwgW2RhdGEtdGVzdGlkPVwiY29tcG9zZXJcIl0gW2NvbnRlbnRlZGl0YWJsZT1cInRydWVcIl0sIGZvcm0gdGV4dGFyZWE6bm90KFtkaXNhYmxlZF0pLCBmb3JtIFtjb250ZW50ZWRpdGFibGU9XCJ0cnVlXCJdJyxcbiAgXCJjb21tYW5kLW1lbnVcIjogJ1tkYXRhLWNvbW1hbmQtbWVudV0sIFtkYXRhLXNsYXNoLW1lbnVdLCBbcm9sZT1cImxpc3Rib3hcIl0nLFxuICBcImFjY291bnQtbWVudVwiOiAnW3JvbGU9XCJtZW51XCJdLCBbcm9sZT1cImRpYWxvZ1wiXScsXG4gIFwic2V0dGluZ3Mtcm93c1wiOiAnW2RhdGEtc2V0dGluZ3Mtcm93XSwgW3JvbGU9XCJsaXN0aXRlbVwiXSwgc2VjdGlvbiA+IGRpdicsXG4gIFwidGl0bGViYXItY29udHJvbHNcIjogJ1tkYXRhLXRpdGxlYmFyLWNvbnRyb2xdLCBbYXJpYS1sYWJlbD1cIkhpZGUgc2lkZWJhclwiXSwgW2FyaWEtbGFiZWw9XCJTaG93IHNpZGViYXJcIl0sIFthcmlhLWxhYmVsPVwiQmFja1wiXSwgW2FyaWEtbGFiZWw9XCJGb3J3YXJkXCJdLCBbdGl0bGU9XCJCYWNrXCJdLCBbdGl0bGU9XCJGb3J3YXJkXCJdJyxcbn07XG5cbmV4cG9ydCBjb25zdCBob3N0VWlBcGk6IEhvc3RVaUFwaSA9IHtcbiAgcXVlcnk6IHF1ZXJ5SG9zdFN1cmZhY2VzLFxuICBzbmFwc2hvdCxcbiAgb2JzZXJ2ZSxcbiAgZ2V0QWN0aXZlUHJvamVjdCxcbiAgYXR0YWNoRmlsZXMsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gcXVlcnlIb3N0U3VyZmFjZXMoa2luZDogSG9zdFN1cmZhY2VLaW5kKTogSG9zdFN1cmZhY2VNYXRjaFtdIHtcbiAgaWYgKHR5cGVvZiBkb2N1bWVudCA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuIFtdO1xuICBpZiAoa2luZCA9PT0gXCJwcm9qZWN0c1wiKSByZXR1cm4gcHJvamVjdFJvd3MoKTtcbiAgaWYgKGtpbmQgPT09IFwidGhyZWFkLWNvbnRleHRcIikgcmV0dXJuIHRocmVhZENvbnRleHRzKCk7XG4gIGlmIChraW5kID09PSBcInVzYWdlXCIpIHJldHVybiB1c2FnZVN1cmZhY2VzKCk7XG4gIGNvbnN0IHNlbGVjdG9yID0gU0VMRUNUT1JTW2tpbmRdO1xuICByZXR1cm4gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcikpXG4gICAgLmZpbHRlcigoZWxlbWVudCkgPT4gc2VtYW50aWNGaWx0ZXIoa2luZCwgZWxlbWVudCkpXG4gICAgLnNsaWNlKDAsIE1BWF9NQVRDSEVTKVxuICAgIC5tYXAoKGVsZW1lbnQpID0+ICh7IGtpbmQsIGVsZW1lbnQsIGNvbmZpZGVuY2U6IGNvbmZpZGVuY2VGb3Ioa2luZCwgZWxlbWVudCksIGxhYmVsOiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudCkgfSkpO1xufVxuXG5mdW5jdGlvbiBzbmFwc2hvdChraW5kOiBIb3N0U3VyZmFjZUtpbmQpOiBIb3N0U3VyZmFjZVNuYXBzaG90IHtcbiAgY29uc3QgbWF0Y2hlcyA9IHF1ZXJ5SG9zdFN1cmZhY2VzKGtpbmQpLnNsaWNlKDAsIE1BWF9NQVRDSEVTKTtcbiAgcmV0dXJuIHsga2luZCwgY291bnQ6IG1hdGNoZXMubGVuZ3RoLCBtYXRjaGVzIH07XG59XG5cbmZ1bmN0aW9uIG9ic2VydmUoa2luZHM6IEhvc3RTdXJmYWNlS2luZFtdLCBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkKTogKCkgPT4gdm9pZCB7XG4gIGNvbnN0IGVudHJ5ID0geyBraW5kczogWy4uLm5ldyBTZXQoa2luZHMpXSwgbGlzdGVuZXIgfTtcbiAgbGlzdGVuZXJzLmFkZChlbnRyeSk7XG4gIGVuc3VyZU9ic2VydmVyKCk7XG4gIHNhZmVseU5vdGlmeShlbnRyeSwgZW50cnkua2luZHMubWFwKHNuYXBzaG90KSk7XG4gIHJldHVybiAoKSA9PiB7XG4gICAgbGlzdGVuZXJzLmRlbGV0ZShlbnRyeSk7XG4gICAgaWYgKCFsaXN0ZW5lcnMuc2l6ZSkge1xuICAgICAgc2hhcmVkT2JzZXJ2ZXI/LmRpc2Nvbm5lY3QoKTtcbiAgICAgIHNoYXJlZE9ic2VydmVyID0gbnVsbDtcbiAgICAgIGlmIChwZW5kaW5nRnJhbWUgIT09IG51bGwpIGNhbmNlbEFuaW1hdGlvbkZyYW1lKHBlbmRpbmdGcmFtZSk7XG4gICAgICBwZW5kaW5nRnJhbWUgPSBudWxsO1xuICAgIH1cbiAgfTtcbn1cblxuZnVuY3Rpb24gZW5zdXJlT2JzZXJ2ZXIoKTogdm9pZCB7XG4gIGlmIChzaGFyZWRPYnNlcnZlciB8fCB0eXBlb2YgTXV0YXRpb25PYnNlcnZlciA9PT0gXCJ1bmRlZmluZWRcIiB8fCB0eXBlb2YgZG9jdW1lbnQgPT09IFwidW5kZWZpbmVkXCIpIHJldHVybjtcbiAgc2hhcmVkT2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgaWYgKHBlbmRpbmdGcmFtZSAhPT0gbnVsbCkgcmV0dXJuO1xuICAgIHBlbmRpbmdGcmFtZSA9IHJlcXVlc3RBbmltYXRpb25GcmFtZSgoKSA9PiB7XG4gICAgICBwZW5kaW5nRnJhbWUgPSBudWxsO1xuICAgICAgZm9yIChjb25zdCBlbnRyeSBvZiBsaXN0ZW5lcnMpIHNhZmVseU5vdGlmeShlbnRyeSwgZW50cnkua2luZHMubWFwKHNuYXBzaG90KSk7XG4gICAgfSk7XG4gIH0pO1xuICBzaGFyZWRPYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwge1xuICAgIGF0dHJpYnV0ZXM6IHRydWUsXG4gICAgYXR0cmlidXRlRmlsdGVyOiBbXCJhcmlhLWxhYmVsXCIsIFwiYXJpYS1jdXJyZW50XCIsIFwicm9sZVwiLCBcImRhdGEtdGVzdGlkXCIsIFwiZGF0YS1wcm9qZWN0LWlkXCIsIFwiZGF0YS1wcm9qZWN0LW5hbWVcIiwgXCJkYXRhLXdvcmtzcGFjZS1wYXRoXCIsIFwiZGF0YS11c2FnZS1saW1pdC1rZXlcIiwgXCJkYXRhLXVzYWdlLWxpbWl0XCIsIFwiZGlzYWJsZWRcIl0sXG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIGNoYXJhY3RlckRhdGE6IHRydWUsXG4gICAgc3VidHJlZTogdHJ1ZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNhZmVseU5vdGlmeShlbnRyeTogeyBsaXN0ZW5lcjogKHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKSA9PiB2b2lkIH0sIHNuYXBzaG90czogSG9zdFN1cmZhY2VTbmFwc2hvdFtdKTogdm9pZCB7XG4gIHRyeSB7IGVudHJ5Lmxpc3RlbmVyKHNuYXBzaG90cyk7IH1cbiAgY2F0Y2ggKGVycm9yKSB7IGNvbnNvbGUud2FybihcIlt0d2Vha2VyXSBob3N0IHN1cmZhY2Ugb2JzZXJ2ZXIgZmFpbGVkXCIsIGVycm9yKTsgfVxufVxuXG5mdW5jdGlvbiBwcm9qZWN0Um93cygpOiBIb3N0U3VyZmFjZU1hdGNoW10ge1xuICBjb25zdCBjb250cm9scyA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ2J1dHRvbiwgYSwgW3JvbGU9XCJidXR0b25cIl0nKSk7XG4gIHJldHVybiBjb250cm9scy5maWx0ZXIoKGVsZW1lbnQpID0+IHtcbiAgICBjb25zdCBsYWJlbCA9IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCk7XG4gICAgaWYgKCFsYWJlbCB8fCBsYWJlbC5sZW5ndGggPiAxMjAgfHwgIWVsZW1lbnQucXVlcnlTZWxlY3RvcihcInN2Z1wiKSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBCb29sZWFuKGRpcmVjdFByb2plY3RJZGVudGl0eShlbGVtZW50KSk7XG4gIH0pLnNsaWNlKDAsIE1BWF9NQVRDSEVTKS5tYXAoKGVsZW1lbnQpID0+ICh7XG4gICAga2luZDogXCJwcm9qZWN0c1wiLFxuICAgIGVsZW1lbnQsXG4gICAgY29uZmlkZW5jZTogXCJoaWdoXCIsXG4gICAgbGFiZWw6IGNvbXBhY3QoZWxlbWVudC50ZXh0Q29udGVudCksXG4gIH0pKTtcbn1cblxuLyoqXG4gKiBBIHByb2plY3Qgcm93IG11c3Qgb3duIHByb2plY3QgaWRlbnRpdHkgaXRzZWxmLiBXYWxraW5nIGFuY2VzdG9yIGZpYmVycyBtYWRlXG4gKiBldmVyeSBjb250cm9sIHJlbmRlcmVkIGluc2lkZSBhIHByb2plY3Qgcm91dGUgaW5oZXJpdCBwcm9qZWN0IGNvbnRleHQ6IHRhc2tcbiAqIHJvd3MgYW5kIGV2ZW4gdGhlIHRpdGxlYmFyIG1vZGVsIHBpY2tlciB0aGVuIGxvb2tlZCBsaWtlIHByb2plY3Qgcm93cy4gS2VlcFxuICogdGhpcyBzZWFtIGZhaWwtY2xvc2VkIHNvIGNvbnN1bWVycyBuZXZlciBkZWNvcmF0ZSB1bnJlbGF0ZWQgaG9zdCBjb250cm9scy5cbiAqL1xuZnVuY3Rpb24gZGlyZWN0UHJvamVjdElkZW50aXR5KGVsZW1lbnQ6IEVsZW1lbnQpOiBzdHJpbmcgfCBudWxsIHtcbiAgZm9yIChjb25zdCBhdHRyaWJ1dGUgb2YgW1xuICAgIFwiZGF0YS1hcHAtYWN0aW9uLXNpZGViYXItcHJvamVjdC1pZFwiLFxuICAgIFwiZGF0YS1wcm9qZWN0LWlkXCIsXG4gICAgXCJkYXRhLXByb2plY3QtbmFtZVwiLFxuICAgIFwiZGF0YS13b3Jrc3BhY2UtcGF0aFwiLFxuICAgIFwiZGF0YS1wcm9qZWN0LXBhdGhcIixcbiAgXSkge1xuICAgIGNvbnN0IHZhbHVlID0gZWxlbWVudC5nZXRBdHRyaWJ1dGUoYXR0cmlidXRlKT8udHJpbSgpO1xuICAgIGlmICh2YWx1ZSkgcmV0dXJuIHZhbHVlO1xuICB9XG4gIGNvbnN0IHByb3BzID0gKGZpYmVyRm9yTm9kZShlbGVtZW50KSBhcyBSZWFjdEZpYmVyTm9kZSB8IG51bGwpPy5tZW1vaXplZFByb3BzO1xuICByZXR1cm4gcHJvcHMgJiYgdHlwZW9mIHByb3BzID09PSBcIm9iamVjdFwiXG4gICAgPyBmaXJzdFN0cmluZyhwcm9wcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgW1wicHJvamVjdElkXCIsIFwicHJvamVjdE5hbWVcIiwgXCJ3b3Jrc3BhY2VQYXRoXCIsIFwicHJvamVjdFBhdGhcIl0pID8/IG51bGxcbiAgICA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIHRocmVhZENvbnRleHRzKCk6IEhvc3RTdXJmYWNlTWF0Y2hbXSB7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSB1bmlxdWVFbGVtZW50cyhkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1wcm9qZWN0LWlkXSwgW2RhdGEtd29ya3NwYWNlLXBhdGhdLCBtYWluLCBbcm9sZT1cIm1haW5cIl0nKSk7XG4gIHJldHVybiBjYW5kaWRhdGVzLmZpbHRlcigoZWxlbWVudCkgPT4ge1xuICAgIGlmIChlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtcHJvamVjdC1pZFwiKSB8fCBlbGVtZW50Lmhhc0F0dHJpYnV0ZShcImRhdGEtd29ya3NwYWNlLXBhdGhcIikpIHJldHVybiB0cnVlO1xuICAgIGNvbnN0IHByb3BzID0gZmliZXJQcm9wcyhlbGVtZW50KTtcbiAgICByZXR1cm4gQm9vbGVhbihmaXJzdFN0cmluZyhwcm9wcywgW1wicHJvamVjdElkXCIsIFwid29ya3NwYWNlUGF0aFwiLCBcInByb2plY3ROYW1lXCJdKSk7XG4gIH0pLnNsaWNlKDAsIE1BWF9NQVRDSEVTKS5tYXAoKGVsZW1lbnQpID0+ICh7IGtpbmQ6IFwidGhyZWFkLWNvbnRleHRcIiwgZWxlbWVudCwgY29uZmlkZW5jZTogZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtaWRcIikgPyBcImhpZ2hcIiA6IFwibWVkaXVtXCIsIGxhYmVsOiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudCkgfSkpO1xufVxuXG5mdW5jdGlvbiB1c2FnZVN1cmZhY2VzKCk6IEhvc3RTdXJmYWNlTWF0Y2hbXSB7XG4gIGNvbnN0IGRpcmVjdCA9IHVuaXF1ZUVsZW1lbnRzKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLXVzYWdlLWxpbWl0LWtleV0sIFtkYXRhLXVzYWdlLWxpbWl0XSwgW2RhdGEtdGVzdGlkKj1cInVzYWdlXCIgaV0sIFthcmlhLWxhYmVsKj1cInVzYWdlXCIgaV0sIFtjbGFzcyo9XCJ1c2FnZVwiIGldJykpO1xuICBjb25zdCB0ZXh0dWFsID0gdW5pcXVlRWxlbWVudHMoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcInNlY3Rpb24sIGFydGljbGUsIFtyb2xlPSdsaXN0aXRlbSddXCIpKS5maWx0ZXIoKGVsZW1lbnQpID0+IC8oPzp1c2FnZXxsaW1pdCkuKig/OnJlbWFpbmluZ3xyZXNldHx1c2VkKXwoPzpyZW1haW5pbmd8cmVzZXR8dXNlZCkuKig/OnVzYWdlfGxpbWl0KS9pLnRlc3QoY29tcGFjdChlbGVtZW50LnRleHRDb250ZW50KSkpO1xuICByZXR1cm4gdW5pcXVlRWxlbWVudHMoWy4uLmRpcmVjdCwgLi4udGV4dHVhbF0pLnNsaWNlKDAsIE1BWF9NQVRDSEVTKS5tYXAoKGVsZW1lbnQpID0+ICh7IGtpbmQ6IFwidXNhZ2VcIiwgZWxlbWVudCwgY29uZmlkZW5jZTogZGlyZWN0LmluY2x1ZGVzKGVsZW1lbnQpID8gXCJoaWdoXCIgOiBcIm1lZGl1bVwiLCBsYWJlbDogYWNjZXNzaWJsZUxhYmVsKGVsZW1lbnQpIH0pKTtcbn1cblxuZnVuY3Rpb24gZ2V0QWN0aXZlUHJvamVjdCgpOiBIb3N0UHJvamVjdENvbnRleHQgfCBudWxsIHtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBxdWVyeUhvc3RTdXJmYWNlcyhcInRocmVhZC1jb250ZXh0XCIpKSB7XG4gICAgY29uc3QgZWxlbWVudCA9IG1hdGNoLmVsZW1lbnQ7XG4gICAgY29uc3QgcHJvcHMgPSBmaWJlclByb3BzKGVsZW1lbnQpO1xuICAgIGNvbnN0IGNvbnRleHQgPSB7XG4gICAgICBpZDogZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXByb2plY3QtaWRcIikgfHwgZmlyc3RTdHJpbmcocHJvcHMsIFtcInByb2plY3RJZFwiLCBcImlkXCJdKSxcbiAgICAgIG5hbWU6IGVsZW1lbnQuZ2V0QXR0cmlidXRlKFwiZGF0YS1wcm9qZWN0LW5hbWVcIikgfHwgZmlyc3RTdHJpbmcocHJvcHMsIFtcInByb2plY3ROYW1lXCIsIFwibmFtZVwiXSksXG4gICAgICB3b3Jrc3BhY2VQYXRoOiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtd29ya3NwYWNlLXBhdGhcIikgfHwgZmlyc3RTdHJpbmcocHJvcHMsIFtcIndvcmtzcGFjZVBhdGhcIiwgXCJwcm9qZWN0UGF0aFwiLCBcImN3ZFwiXSksXG4gICAgfTtcbiAgICBpZiAoY29udGV4dC5pZCB8fCBjb250ZXh0Lm5hbWUgfHwgY29udGV4dC53b3Jrc3BhY2VQYXRoKSByZXR1cm4gY29udGV4dDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXR0YWNoRmlsZXMoZmlsZXM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBtaW1lVHlwZTogc3RyaW5nOyBkYXRhQmFzZTY0OiBzdHJpbmcgfT4pOiBQcm9taXNlPHsgYWNjZXB0ZWQ6IGJvb2xlYW47IHJlYXNvbjogXCJhY2NlcHRlZFwiIHwgXCJjb21wb3Nlci1taXNzaW5nXCIgfCBcInBhc3RlLXJlamVjdGVkXCIgfCBcImF0dGFjaG1lbnQtdGltZW91dFwiIH0+IHtcbiAgY29uc3QgdGFyZ2V0ID0gcXVlcnlIb3N0U3VyZmFjZXMoXCJjb21wb3NlclwiKVswXT8uZWxlbWVudCA/PyBudWxsO1xuICBpZiAoIXRhcmdldCkgcmV0dXJuIHsgYWNjZXB0ZWQ6IGZhbHNlLCByZWFzb246IFwiY29tcG9zZXItbWlzc2luZ1wiIH07XG4gIGNvbnN0IHByZXBhcmVkID0gZmlsZXMubWFwKChmaWxlKSA9PiB7XG4gICAgY29uc3QgYnl0ZXMgPSBVaW50OEFycmF5LmZyb20oYXRvYihmaWxlLmRhdGFCYXNlNjQpLCAoY2hhcikgPT4gY2hhci5jaGFyQ29kZUF0KDApKTtcbiAgICByZXR1cm4gbmV3IEZpbGUoW2J5dGVzXSwgc2FmZUZpbGVOYW1lKGZpbGUubmFtZSksIHsgdHlwZTogZmlsZS5taW1lVHlwZSB8fCBcImFwcGxpY2F0aW9uL29jdGV0LXN0cmVhbVwiIH0pO1xuICB9KTtcbiAgY29uc3QgdHJhbnNmZXIgPSBuZXcgRGF0YVRyYW5zZmVyKCk7XG4gIGZvciAoY29uc3QgZmlsZSBvZiBwcmVwYXJlZCkgdHJhbnNmZXIuaXRlbXMuYWRkKGZpbGUpO1xuICB0YXJnZXQuZGlzcGF0Y2hFdmVudChuZXcgRHJhZ0V2ZW50KFwiZHJvcFwiLCB7IGJ1YmJsZXM6IHRydWUsIGNhbmNlbGFibGU6IHRydWUsIGRhdGFUcmFuc2ZlcjogdHJhbnNmZXIgfSkpO1xuICBjb25zdCBwYXN0ZSA9IG5ldyBDbGlwYm9hcmRFdmVudChcInBhc3RlXCIsIHsgYnViYmxlczogdHJ1ZSwgY2FuY2VsYWJsZTogdHJ1ZSwgY2xpcGJvYXJkRGF0YTogdHJhbnNmZXIgfSk7XG4gIGNvbnN0IGFjY2VwdGVkID0gdGFyZ2V0LmRpc3BhdGNoRXZlbnQocGFzdGUpO1xuICB0YXJnZXQuZGlzcGF0Y2hFdmVudChuZXcgRXZlbnQoXCJpbnB1dFwiLCB7IGJ1YmJsZXM6IHRydWUgfSkpO1xuICAodGFyZ2V0IGFzIEhUTUxFbGVtZW50KS5mb2N1cz8uKCk7XG4gIHJldHVybiB7IGFjY2VwdGVkOiBhY2NlcHRlZCAhPT0gZmFsc2UsIHJlYXNvbjogYWNjZXB0ZWQgPT09IGZhbHNlID8gXCJwYXN0ZS1yZWplY3RlZFwiIDogXCJhY2NlcHRlZFwiIH07XG59XG5cbmZ1bmN0aW9uIHNhZmVGaWxlTmFtZSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgY2xlYW5lZCA9IFN0cmluZyh2YWx1ZSB8fCBcIkFwcFNob3RcIikucmVwbGFjZSgvWy86XFxcXFxcMFxcclxcbl0vZywgXCItXCIpLnJlcGxhY2UoL1xccysvZywgXCIgXCIpLnRyaW0oKTtcbiAgcmV0dXJuIGNsZWFuZWQuc2xpY2UoMCwgMTYwKSB8fCBcIkFwcFNob3RcIjtcbn1cblxuZnVuY3Rpb24gc2VtYW50aWNGaWx0ZXIoa2luZDogSG9zdFN1cmZhY2VLaW5kLCBlbGVtZW50OiBFbGVtZW50KTogYm9vbGVhbiB7XG4gIGNvbnN0IHRleHQgPSBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpO1xuICBpZiAoa2luZCA9PT0gXCJhc3Npc3RhbnQtdHVybnNcIikge1xuICAgIGNvbnN0IHJvbGUgPSBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtbWVzc2FnZS1hdXRob3Itcm9sZVwiKSB8fCBlbGVtZW50LmdldEF0dHJpYnV0ZShcImRhdGEtcm9sZVwiKTtcbiAgICByZXR1cm4gcm9sZSA/IHJvbGUudG9Mb3dlckNhc2UoKSA9PT0gXCJhc3Npc3RhbnRcIiA6IC9hc3Npc3RhbnQtbWVzc2FnZS9pLnRlc3QoZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJkYXRhLXRlc3RpZFwiKSB8fCBcIlwiKTtcbiAgfVxuICBpZiAoa2luZCA9PT0gXCJhY2NvdW50LW1lbnVcIikgcmV0dXJuIC9hY2NvdW50fHNldHRpbmdzfGxvZ1xccypvdXQvaS50ZXN0KHRleHQpO1xuICBpZiAoa2luZCA9PT0gXCJzZXR0aW5ncy1yb3dzXCIpIHJldHVybiB0ZXh0Lmxlbmd0aCA+IDA7XG4gIHJldHVybiB0cnVlO1xufVxuXG5mdW5jdGlvbiBjb25maWRlbmNlRm9yKGtpbmQ6IEhvc3RTdXJmYWNlS2luZCwgZWxlbWVudDogRWxlbWVudCk6IEhvc3RTdXJmYWNlTWF0Y2hbXCJjb25maWRlbmNlXCJdIHtcbiAgaWYgKGVsZW1lbnQuaGFzQXR0cmlidXRlKFwiZGF0YS10ZXN0aWRcIikgfHwgZWxlbWVudC5oYXNBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIpIHx8IGVsZW1lbnQuaGFzQXR0cmlidXRlKFwicm9sZVwiKSkgcmV0dXJuIFwiaGlnaFwiO1xuICByZXR1cm4ga2luZCA9PT0gXCJjb21wb3NlclwiIHx8IGtpbmQgPT09IFwidGl0bGViYXItY29udHJvbHNcIiA/IFwibWVkaXVtXCIgOiBcImxvd1wiO1xufVxuXG5mdW5jdGlvbiBmaWJlclByb3BzKGVsZW1lbnQ6IEVsZW1lbnQpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBsZXQgZmliZXIgPSBmaWJlckZvck5vZGUoZWxlbWVudCkgYXMgUmVhY3RGaWJlck5vZGUgfCBudWxsO1xuICBjb25zdCBtZXJnZWQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIGZvciAobGV0IGRlcHRoID0gMDsgZmliZXIgJiYgZGVwdGggPCAyMDsgZGVwdGggKz0gMSwgZmliZXIgPSBmaWJlci5yZXR1cm4pIHtcbiAgICBpZiAoZmliZXIubWVtb2l6ZWRQcm9wcyAmJiB0eXBlb2YgZmliZXIubWVtb2l6ZWRQcm9wcyA9PT0gXCJvYmplY3RcIikgT2JqZWN0LmFzc2lnbihtZXJnZWQsIGZpYmVyLm1lbW9pemVkUHJvcHMpO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhtZXJnZWQpLmxlbmd0aCA/IG1lcmdlZCA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIGZpcnN0U3RyaW5nKHByb3BzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwsIGtleXM6IHN0cmluZ1tdKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKCFwcm9wcykgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcXVldWU6IHVua25vd25bXSA9IFtwcm9wc107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHVua25vd24+KCk7XG4gIGZvciAobGV0IHZpc2l0ZWQgPSAwOyBxdWV1ZS5sZW5ndGggJiYgdmlzaXRlZCA8IDgwOyB2aXNpdGVkICs9IDEpIHtcbiAgICBjb25zdCB2YWx1ZSA9IHF1ZXVlLnNoaWZ0KCk7XG4gICAgaWYgKCF2YWx1ZSB8fCB0eXBlb2YgdmFsdWUgIT09IFwib2JqZWN0XCIgfHwgc2Vlbi5oYXModmFsdWUpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gICAgZm9yIChjb25zdCBba2V5LCBpdGVtXSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgIGlmIChrZXlzLmluY2x1ZGVzKGtleSkgJiYgdHlwZW9mIGl0ZW0gPT09IFwic3RyaW5nXCIgJiYgaXRlbS50cmltKCkpIHJldHVybiBpdGVtO1xuICAgICAgaWYgKGl0ZW0gJiYgdHlwZW9mIGl0ZW0gPT09IFwib2JqZWN0XCIpIHF1ZXVlLnB1c2goaXRlbSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHVuaXF1ZUVsZW1lbnRzKGlucHV0OiBJdGVyYWJsZTxFbGVtZW50PiB8IEFycmF5TGlrZTxFbGVtZW50Pik6IEVsZW1lbnRbXSB7XG4gIHJldHVybiBbLi4ubmV3IFNldChBcnJheS5mcm9tKGlucHV0KSldO1xufVxuXG5mdW5jdGlvbiBhY2Nlc3NpYmxlTGFiZWwoZWxlbWVudDogRWxlbWVudCk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBlbGVtZW50LmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIikgfHwgZWxlbWVudC5nZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiKSB8fCBjb21wYWN0KGVsZW1lbnQudGV4dENvbnRlbnQpIHx8IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gY29tcGFjdCh2YWx1ZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIHJldHVybiBTdHJpbmcodmFsdWUgfHwgXCJcIikucmVwbGFjZSgvXFxzKy9nLCBcIiBcIikudHJpbSgpO1xufVxuIiwgImV4cG9ydCB0eXBlIFR3ZWFrU2NvcGUgPSBcInJlbmRlcmVyXCIgfCBcIm1haW5cIiB8IFwiYm90aFwiO1xuXG4vKipcbiAqIExpZmVjeWNsZSBzdGF0ZXMgYXJlIGRlbGliZXJhdGVseSBtb3JlIGRldGFpbGVkIHRoYW4gdGhlIHVzZXItZmFjaW5nXG4gKiBpbnN0YWxsZWQvZW5hYmxlZCBzdGF0dXMuICBBIHR3ZWFrIG1heSBiZSB2aXNpYmxlIGFzIGVuYWJsZWQgd2hpbGUgaXRzXG4gKiBhc3luY2hyb25vdXMgc3RhcnQgaXMgc3RpbGwgaW4gZmxpZ2h0LCBvciBhcyBmYWlsZWQgYWZ0ZXIgYW5vdGhlciB0d2Vha1xuICogaGFzIGFscmVhZHkgcmVhY2hlZCByZWFkeS5cbiAqL1xuZXhwb3J0IGNvbnN0IFRXRUFLX0xJRkVDWUNMRV9TVEFUVVNFUyA9IFtcbiAgXCJzdGFydGluZ1wiLFxuICBcInJlYWR5XCIsXG4gIFwiZmFpbGVkXCIsXG4gIFwidGltZWRfb3V0XCIsXG4gIFwiZGlzYWJsZWRcIixcbiAgXCJxdWFyYW50aW5lZFwiLFxuXSBhcyBjb25zdDtcbmV4cG9ydCB0eXBlIFR3ZWFrTGlmZWN5Y2xlU3RhdHVzID0gKHR5cGVvZiBUV0VBS19MSUZFQ1lDTEVfU1RBVFVTRVMpW251bWJlcl07XG5leHBvcnQgdHlwZSBUd2Vha1Byb2Nlc3MgPSBcIm1haW5cIiB8IFwicmVuZGVyZXJcIjtcblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha0xpZmVjeWNsZVJlY29yZCB7XG4gIGlkOiBzdHJpbmc7XG4gIHByb2Nlc3M6IFR3ZWFrUHJvY2VzcztcbiAgc3RhdHVzOiBUd2Vha0xpZmVjeWNsZVN0YXR1cztcbiAgYXR0ZW1wdElkOiBzdHJpbmc7XG4gIHVwZGF0ZWRBdDogc3RyaW5nO1xuICBzdGFydGVkQXQ/OiBzdHJpbmc7XG4gIGZpbmlzaGVkQXQ/OiBzdHJpbmc7XG4gIGVycm9yPzogc3RyaW5nO1xuICAvKiogQ29uc2VjdXRpdmUgc3RhcnR1cCBhdHRlbXB0cyBjdXQgc2hvcnQgYnkgYSBwcm9jZXNzIGV4aXQ7IHJlc2V0IGJ5IGEgc3VjY2Vzc2Z1bCByZWFkeS4gKi9cbiAgaW50ZXJydXB0ZWRBdHRlbXB0cz86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha0xpZmVjeWNsZUF0dGVtcHQge1xuICBpZDogc3RyaW5nO1xuICBwaWQ/OiBudW1iZXI7XG4gIHN0YXJ0ZWRBdDogc3RyaW5nO1xuICBjb21wbGV0ZWRBdD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUd2Vha0xpZmVjeWNsZUpvdXJuYWwge1xuICBzY2hlbWFWZXJzaW9uOiAxO1xuICBjdXJyZW50QXR0ZW1wdDogVHdlYWtMaWZlY3ljbGVBdHRlbXB0IHwgbnVsbDtcbiAgcmVjb3JkczogUmVjb3JkPHN0cmluZywgVHdlYWtMaWZlY3ljbGVSZWNvcmQ+O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlVHdlYWtMaWZlY3ljbGVKb3VybmFsKFxuICBhdHRlbXB0SWQgPSBgYXR0ZW1wdC0ke0RhdGUubm93KCl9LSR7TWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMil9YCxcbiAgcGlkPzogbnVtYmVyLFxuICBzdGFydGVkQXQgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4pOiBUd2Vha0xpZmVjeWNsZUpvdXJuYWwge1xuICByZXR1cm4ge1xuICAgIHNjaGVtYVZlcnNpb246IDEsXG4gICAgY3VycmVudEF0dGVtcHQ6IHsgaWQ6IGF0dGVtcHRJZCwgcGlkLCBzdGFydGVkQXQgfSxcbiAgICByZWNvcmRzOiB7fSxcbiAgfTtcbn1cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TID0gNV8wMDA7XG5leHBvcnQgY29uc3QgTUlOX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyA9IDEwMDtcbmV4cG9ydCBjb25zdCBNQVhfVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TID0gMzBfMDAwO1xuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplVHdlYWtTdGFydHVwVGltZW91dE1zKHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKHZhbHVlKSkge1xuICAgIHJldHVybiBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUztcbiAgfVxuICByZXR1cm4gTWF0aC5taW4oXG4gICAgTUFYX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyxcbiAgICBNYXRoLm1heChNSU5fVFdFQUtfU1RBUlRVUF9USU1FT1VUX01TLCBNYXRoLnJvdW5kKHZhbHVlKSksXG4gICk7XG59XG5cbi8qKlxuICogUmFjZSBhIHR3ZWFrJ3Mgc3RhcnR1cCBwcm9taXNlIGFnYWluc3QgYSBib3VuZGVkIHRpbWVvdXQuICBUaGUgb3JpZ2luYWxcbiAqIHByb21pc2UgaXMgb2JzZXJ2ZWQgYWZ0ZXIgdGhlIHRpbWVvdXQgc28gYSBsYXRlIHJlamVjdGlvbiBjYW5ub3QgYmVjb21lIGFuXG4gKiB1bmhhbmRsZWQgcmVqZWN0aW9uLCB3aGlsZSB0aGUgY2FsbGVyIGlzIGZyZWUgdG8gY29udGludWUgbG9hZGluZyBzaWJsaW5nXG4gKiB0d2Vha3MgaW1tZWRpYXRlbHkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3aXRoU3RhcnR1cFRpbWVvdXQ8VD4oXG4gIHZhbHVlOiBQcm9taXNlTGlrZTxUPiB8IFQsXG4gIHRpbWVvdXRNczogbnVtYmVyID0gREVGQVVMVF9UV0VBS19TVEFSVFVQX1RJTUVPVVRfTVMsXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBcInJlYWR5XCI7IHZhbHVlOiBUIH0gfCB7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9PiB7XG4gIGNvbnN0IG5vcm1hbGl6ZWRUaW1lb3V0TXMgPSBub3JtYWxpemVUd2Vha1N0YXJ0dXBUaW1lb3V0TXModGltZW91dE1zKTtcbiAgbGV0IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgcHJvbWlzZSA9IFByb21pc2UucmVzb2x2ZSh2YWx1ZSk7XG4gIGNvbnN0IHRpbWVvdXQgPSBuZXcgUHJvbWlzZTx7IHN0YXR1czogXCJ0aW1lZF9vdXRcIiB9PigocmVzb2x2ZSkgPT4ge1xuICAgIHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0pLCBub3JtYWxpemVkVGltZW91dE1zKTtcbiAgfSk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgIHByb21pc2UudGhlbigocmVzb2x2ZWQpID0+ICh7IHN0YXR1czogXCJyZWFkeVwiIGFzIGNvbnN0LCB2YWx1ZTogcmVzb2x2ZWQgfSkpLFxuICAgICAgdGltZW91dCxcbiAgICBdKTtcbiAgICByZXR1cm4gcmVzdWx0O1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lcikgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAvLyBBdHRhY2ggYSByZWplY3Rpb24gb2JzZXJ2ZXIgZXZlbiB3aGVuIHRpbWVvdXQgd29uLiAgVGhpcyBpbnRlbnRpb25hbGx5XG4gICAgLy8gZG9lcyBub3QgYXdhaXQgdGhlIGxhdGUgcmVzdWx0LlxuICAgIHZvaWQgcHJvbWlzZS5jYXRjaCgoKSA9PiB1bmRlZmluZWQpO1xuICB9XG59XG5cbi8qKiBDb252ZW5pZW5jZSBmb3JtIGZvciBjYWxsZXJzIHRoYXQgaGF2ZSBhIGxhenkgc3RhcnQgb3BlcmF0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJ1bldpdGhTdGFydHVwVGltZW91dDxUPihcbiAgc3RhcnQ6ICgpID0+IFByb21pc2VMaWtlPFQ+IHwgVCxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBERUZBVUxUX1RXRUFLX1NUQVJUVVBfVElNRU9VVF9NUyxcbik6IFByb21pc2U8eyBzdGF0dXM6IFwicmVhZHlcIjsgdmFsdWU6IFQgfSB8IHsgc3RhdHVzOiBcInRpbWVkX291dFwiIH0+IHtcbiAgbGV0IHZhbHVlOiBQcm9taXNlTGlrZTxUPiB8IFQ7XG4gIHRyeSB7XG4gICAgdmFsdWUgPSBzdGFydCgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJldHVybiBQcm9taXNlLnJlamVjdChlcnJvcik7XG4gIH1cbiAgcmV0dXJuIHdpdGhTdGFydHVwVGltZW91dCh2YWx1ZSwgdGltZW91dE1zKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxpZmVjeWNsZVJlY29yZEtleShwcm9jZXNzOiBUd2Vha1Byb2Nlc3MsIGlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cHJvY2Vzc306JHtpZH1gO1xufVxuXG4vKipcbiAqIEJpbmQgYSBtYWluLXByb2Nlc3MgdHdlYWsncyBgc3RvcCgpYCB0byB0aGUgdHdlYWsgb2JqZWN0IHNvIGNsZWFudXAgdGhhdFxuICogcmVsaWVzIG9uIGB0aGlzYCAocGVyLWluc3RhbmNlIGRpc3Bvc2VycywgSVBDIGhhbmRsZSByZW1vdmVycykgd29ya3MuIFRoZVxuICogcmVuZGVyZXIgaG9zdCBiaW5kcyBzdG9wIHRoZSBzYW1lIHdheSAocHJlbG9hZC90d2Vhay1ob3N0LnRzKTsgdGhlIG1haW5cbiAqIHJ1bnRpbWUgaGlzdG9yaWNhbGx5IHN0b3JlZCBpdCB1bmJvdW5kLCBzaWxlbnRseSBicmVha2luZyBgdGhpc2AtYmFzZWQgbWFpblxuICogY2xlYW51cCBmb3IgYHNjb3BlOiBcImJvdGhcImAgdHdlYWtzIChmb2xsb3d1cCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiaW5kTWFpblR3ZWFrU3RvcDxUIGV4dGVuZHMgeyBzdG9wPzogKC4uLmFyZ3M6IHVua25vd25bXSkgPT4gdW5rbm93biB9PihcbiAgdHdlYWs6IFQgfCBudWxsIHwgdW5kZWZpbmVkLFxuKTogVFtcInN0b3BcIl0gfCB1bmRlZmluZWQge1xuICBpZiAoIXR3ZWFrIHx8IHR5cGVvZiB0d2Vhay5zdG9wICE9PSBcImZ1bmN0aW9uXCIpIHJldHVybiB0d2Vhaz8uc3RvcDtcbiAgcmV0dXJuIHR3ZWFrLnN0b3AuYmluZCh0d2VhaykgYXMgVFtcInN0b3BcIl07XG59XG5cbi8qKlxuICogQSB3aG9sZS1hcHAgcmVzdGFydCByYWNpbmcgdGhlIHNlcXVlbnRpYWwgdHdlYWstbG9hZCBsb29wIGxlYXZlcyBpbm5vY2VudFxuICogdHdlYWtzIGluIFwic3RhcnRpbmdcIjsgb25seSByZXBlYXRlZCBpbnRlcnJ1cHRpb25zIGluZGljYXRlIHRoZSB0d2VhayBpdHNlbGZcbiAqIGlzIGhhbmdpbmcgc3RhcnR1cC4gT25lIGludGVycnVwdGlvbiBpcyB0aGVyZWZvcmUgcmV0cmllZCwgbm90IHF1YXJhbnRpbmVkLlxuICovXG5leHBvcnQgY29uc3QgSU5URVJSVVBURURfQVRURU1QVFNfQkVGT1JFX1FVQVJBTlRJTkUgPSAyO1xuXG4vKipcbiAqIFR1cm4gYSBqb3VybmFsIGZyb20gYSBwcmV2aW91cyBwcm9jZXNzIGludG8gZXhwbGljaXQgcmVjb3Jkcy4gT25seSByZWNvcmRzXG4gKiBmcm9tIHRoZSB1bmZpbmlzaGVkIGN1cnJlbnQgYXR0ZW1wdCBhcmUgY2hhbmdlZDsgaGlzdG9yaWNhbCByZWFkeS9mYWlsZWRcbiAqIHJlY29yZHMgcmVtYWluIGF2YWlsYWJsZSBmb3IgZGlhZ25vc3RpY3MuIEEgZmlyc3QgaW50ZXJydXB0aW9uIGJlY29tZXMgYVxuICogcmV0cnlhYmxlIFwiZmFpbGVkXCI7IElOVEVSUlVQVEVEX0FUVEVNUFRTX0JFRk9SRV9RVUFSQU5USU5FIGNvbnNlY3V0aXZlXG4gKiBpbnRlcnJ1cHRpb25zIHF1YXJhbnRpbmUgdGhlIHR3ZWFrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3ZlckludGVycnVwdGVkVHdlYWtzKFxuICBqb3VybmFsOiBUd2Vha0xpZmVjeWNsZUpvdXJuYWwsXG4gIG5vdyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbik6IFR3ZWFrTGlmZWN5Y2xlSm91cm5hbCB7XG4gIGNvbnN0IGN1cnJlbnRBdHRlbXB0ID0gam91cm5hbC5jdXJyZW50QXR0ZW1wdDtcbiAgaWYgKCFjdXJyZW50QXR0ZW1wdCB8fCBjdXJyZW50QXR0ZW1wdC5jb21wbGV0ZWRBdCkgcmV0dXJuIGpvdXJuYWw7XG4gIGNvbnN0IHJlY29yZHMgPSB7IC4uLmpvdXJuYWwucmVjb3JkcyB9O1xuICBmb3IgKGNvbnN0IFtrZXksIHJlY29yZF0gb2YgT2JqZWN0LmVudHJpZXMocmVjb3JkcykpIHtcbiAgICBpZiAocmVjb3JkLmF0dGVtcHRJZCAhPT0gY3VycmVudEF0dGVtcHQuaWQpIGNvbnRpbnVlO1xuICAgIGlmIChyZWNvcmQuc3RhdHVzICE9PSBcInN0YXJ0aW5nXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGludGVycnVwdGVkQXR0ZW1wdHMgPSAocmVjb3JkLmludGVycnVwdGVkQXR0ZW1wdHMgPz8gMCkgKyAxO1xuICAgIGNvbnN0IHF1YXJhbnRpbmUgPSBpbnRlcnJ1cHRlZEF0dGVtcHRzID49IElOVEVSUlVQVEVEX0FUVEVNUFRTX0JFRk9SRV9RVUFSQU5USU5FO1xuICAgIHJlY29yZHNba2V5XSA9IHtcbiAgICAgIC4uLnJlY29yZCxcbiAgICAgIHN0YXR1czogcXVhcmFudGluZSA/IFwicXVhcmFudGluZWRcIiA6IFwiZmFpbGVkXCIsXG4gICAgICBpbnRlcnJ1cHRlZEF0dGVtcHRzLFxuICAgICAgdXBkYXRlZEF0OiBub3csXG4gICAgICBmaW5pc2hlZEF0OiBub3csXG4gICAgICBlcnJvcjogcmVjb3JkLmVycm9yID8/IChxdWFyYW50aW5lXG4gICAgICAgID8gYHN0YXJ0dXAgd2FzIGludGVycnVwdGVkICR7aW50ZXJydXB0ZWRBdHRlbXB0c30gdGltZXMgaW4gYSByb3dgXG4gICAgICAgIDogXCJwcmV2aW91cyBzdGFydHVwIGF0dGVtcHQgd2FzIGludGVycnVwdGVkOyB3aWxsIHJldHJ5XCIpLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgLi4uam91cm5hbCwgY3VycmVudEF0dGVtcHQ6IHsgLi4uY3VycmVudEF0dGVtcHQsIGNvbXBsZXRlZEF0OiBub3cgfSwgcmVjb3JkcyB9O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFJlbG9hZFR3ZWFrc0RlcHMge1xuICBsb2dJbmZvKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQ7XG4gIHN0b3BBbGxNYWluVHdlYWtzKCk6IHZvaWQ7XG4gIGNsZWFyVHdlYWtNb2R1bGVDYWNoZSgpOiB2b2lkO1xuICBsb2FkQWxsTWFpblR3ZWFrcygpOiB2b2lkIHwgUHJvbWlzZTx2b2lkPjtcbiAgYnJvYWRjYXN0UmVsb2FkKCk6IHZvaWQ7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0VHdlYWtFbmFibGVkQW5kUmVsb2FkRGVwcyBleHRlbmRzIFJlbG9hZFR3ZWFrc0RlcHMge1xuICBzZXRUd2Vha0VuYWJsZWQoaWQ6IHN0cmluZywgZW5hYmxlZDogYm9vbGVhbik6IHZvaWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc01haW5Qcm9jZXNzVHdlYWtTY29wZShzY29wZTogVHdlYWtTY29wZSB8IHVuZGVmaW5lZCk6IGJvb2xlYW4ge1xuICByZXR1cm4gc2NvcGUgIT09IFwicmVuZGVyZXJcIjtcbn1cblxubGV0IHJlbG9hZFNlcXVlbmNlOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkVHdlYWtzSW5pdGlhbGx5KFxuICBkZXBzOiBQaWNrPFJlbG9hZFR3ZWFrc0RlcHMsIFwibG9hZEFsbE1haW5Ud2Vha3NcIj4sXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcnVuID0gYXN5bmMgKCk6IFByb21pc2U8dm9pZD4gPT4ge1xuICAgIGF3YWl0IGRlcHMubG9hZEFsbE1haW5Ud2Vha3MoKTtcbiAgfTtcbiAgY29uc3Qgb3BlcmF0aW9uID0gcmVsb2FkU2VxdWVuY2UudGhlbihydW4sIHJ1bik7XG4gIHJlbG9hZFNlcXVlbmNlID0gb3BlcmF0aW9uLmNhdGNoKCgpID0+IHt9KTtcbiAgcmV0dXJuIG9wZXJhdGlvbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbG9hZFR3ZWFrcyhyZWFzb246IHN0cmluZywgZGVwczogUmVsb2FkVHdlYWtzRGVwcyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBydW4gPSBhc3luYyAoKTogUHJvbWlzZTx2b2lkPiA9PiB7XG4gICAgZGVwcy5sb2dJbmZvKGByZWxvYWRpbmcgdHdlYWtzICgke3JlYXNvbn0pYCk7XG4gICAgZGVwcy5zdG9wQWxsTWFpblR3ZWFrcygpO1xuICAgIGRlcHMuY2xlYXJUd2Vha01vZHVsZUNhY2hlKCk7XG4gICAgYXdhaXQgZGVwcy5sb2FkQWxsTWFpblR3ZWFrcygpO1xuICAgIGRlcHMuYnJvYWRjYXN0UmVsb2FkKCk7XG4gIH07XG4gIGNvbnN0IG9wZXJhdGlvbiA9IHJlbG9hZFNlcXVlbmNlLnRoZW4ocnVuLCBydW4pO1xuICByZWxvYWRTZXF1ZW5jZSA9IG9wZXJhdGlvbi5jYXRjaCgoKSA9PiB7fSk7XG4gIHJldHVybiBvcGVyYXRpb247XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRUd2Vha0VuYWJsZWRBbmRSZWxvYWQoXG4gIGlkOiBzdHJpbmcsXG4gIGVuYWJsZWQ6IHVua25vd24sXG4gIGRlcHM6IFNldFR3ZWFrRW5hYmxlZEFuZFJlbG9hZERlcHMsXG4pOiBQcm9taXNlPHRydWU+IHtcbiAgY29uc3Qgbm9ybWFsaXplZEVuYWJsZWQgPSAhIWVuYWJsZWQ7XG4gIGRlcHMuc2V0VHdlYWtFbmFibGVkKGlkLCBub3JtYWxpemVkRW5hYmxlZCk7XG4gIGRlcHMubG9nSW5mbyhgdHdlYWsgJHtpZH0gZW5hYmxlZD0ke25vcm1hbGl6ZWRFbmFibGVkfWApO1xuICBhd2FpdCByZWxvYWRUd2Vha3MoXCJlbmFibGVkLXRvZ2dsZVwiLCBkZXBzKTtcbiAgcmV0dXJuIHRydWU7XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBTdG9yYWdlTGlrZSB7XG4gIHJlYWRvbmx5IGxlbmd0aDogbnVtYmVyO1xuICBnZXRJdGVtKGtleTogc3RyaW5nKTogc3RyaW5nIHwgbnVsbDtcbiAga2V5KGluZGV4OiBudW1iZXIpOiBzdHJpbmcgfCBudWxsO1xuICBzZXRJdGVtKGtleTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZDtcbiAgcmVtb3ZlSXRlbShrZXk6IHN0cmluZyk6IHZvaWQ7XG59XG5cbmNvbnN0IENVUlJFTlRfSURfUFJFRklYID0gXCJjby50d2Vha2Vycy5cIjtcbmNvbnN0IExFR0FDWV9TVE9SQUdFX1BSRUZJWCA9IGAke1tcImNvZGV4XCIsIFwicHBcIl0uam9pbihcIlwiKX06c3RvcmFnZTpgO1xuY29uc3QgQ1VSUkVOVF9TVE9SQUdFX1BSRUZJWCA9IFwidHdlYWtlcjpzdG9yYWdlOlwiO1xuXG5mdW5jdGlvbiBwYXJzZVJlY29yZChyYXc6IHN0cmluZyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwge1xuICBpZiAocmF3ID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdykgYXMgdW5rbm93bjtcbiAgICByZXR1cm4gcGFyc2VkICE9PSBudWxsICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIgJiYgIUFycmF5LmlzQXJyYXkocGFyc2VkKVxuICAgICAgPyBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgICAgIDogbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGlzY292ZXJMZWdhY3lQdWJsaXNoZXJLZXkoaWQ6IHN0cmluZywgc3RvcmFnZTogU3RvcmFnZUxpa2UpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFpZC5zdGFydHNXaXRoKENVUlJFTlRfSURfUFJFRklYKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHN1ZmZpeCA9IGlkLnNsaWNlKENVUlJFTlRfSURfUFJFRklYLmxlbmd0aCk7XG4gIGlmICghc3VmZml4KSByZXR1cm4gbnVsbDtcblxuICBjb25zdCBzdWZmaXhNYXJrZXIgPSBgLiR7c3VmZml4fWA7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHN0b3JhZ2UubGVuZ3RoOyBpbmRleCArPSAxKSB7XG4gICAgY29uc3Qga2V5ID0gc3RvcmFnZS5rZXkoaW5kZXgpO1xuICAgIGlmICgha2V5Py5zdGFydHNXaXRoKExFR0FDWV9TVE9SQUdFX1BSRUZJWCkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxlZ2FjeUlkID0ga2V5LnNsaWNlKExFR0FDWV9TVE9SQUdFX1BSRUZJWC5sZW5ndGgpO1xuICAgIGlmIChcbiAgICAgIGxlZ2FjeUlkICE9PSBpZFxuICAgICAgJiYgbGVnYWN5SWQuc3RhcnRzV2l0aChcImNvLlwiKVxuICAgICAgJiYgbGVnYWN5SWQuZW5kc1dpdGgoc3VmZml4TWFya2VyKVxuICAgICAgJiYgbGVnYWN5SWQuc2xpY2UoMywgLXN1ZmZpeE1hcmtlci5sZW5ndGgpLmxlbmd0aCA+IDBcbiAgICApIHtcbiAgICAgIGNhbmRpZGF0ZXMuYWRkKGtleSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjYW5kaWRhdGVzLnNpemUgPT09IDEgPyBbLi4uY2FuZGlkYXRlc11bMF0gOiBudWxsO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUmVuZGVyZXJTdG9yYWdlKGlkOiBzdHJpbmcsIHN0b3JhZ2U6IFN0b3JhZ2VMaWtlKSB7XG4gIGNvbnN0IGtleSA9IGAke0NVUlJFTlRfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCBsZWdhY3lDdXJyZW50SWRLZXkgPSBgJHtMRUdBQ1lfU1RPUkFHRV9QUkVGSVh9JHtpZH1gO1xuICBjb25zdCByZWFkID0gKCk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0+IHtcbiAgICBjb25zdCBjdXJyZW50ID0gcGFyc2VSZWNvcmQoc3RvcmFnZS5nZXRJdGVtKGtleSkpO1xuICAgIGNvbnN0IGxlZ2FjeUN1cnJlbnRJZCA9IHBhcnNlUmVjb3JkKHN0b3JhZ2UuZ2V0SXRlbShsZWdhY3lDdXJyZW50SWRLZXkpKTtcbiAgICBjb25zdCBsZWdhY3lQdWJsaXNoZXJLZXkgPSBkaXNjb3ZlckxlZ2FjeVB1Ymxpc2hlcktleShpZCwgc3RvcmFnZSk7XG4gICAgY29uc3QgbGVnYWN5UHVibGlzaGVyID0gbGVnYWN5UHVibGlzaGVyS2V5ID09PSBudWxsXG4gICAgICA/IG51bGxcbiAgICAgIDogcGFyc2VSZWNvcmQoc3RvcmFnZS5nZXRJdGVtKGxlZ2FjeVB1Ymxpc2hlcktleSkpO1xuXG4gICAgY29uc3QgbGVnYWN5S2V5cyA9IFtcbiAgICAgIGxlZ2FjeUN1cnJlbnRJZCA9PT0gbnVsbCA/IG51bGwgOiBsZWdhY3lDdXJyZW50SWRLZXksXG4gICAgICBsZWdhY3lQdWJsaXNoZXIgPT09IG51bGwgPyBudWxsIDogbGVnYWN5UHVibGlzaGVyS2V5LFxuICAgIF0uZmlsdGVyKChjYW5kaWRhdGUpOiBjYW5kaWRhdGUgaXMgc3RyaW5nID0+IGNhbmRpZGF0ZSAhPT0gbnVsbCk7XG5cbiAgICBpZiAobGVnYWN5S2V5cy5sZW5ndGggPT09IDApIHJldHVybiBjdXJyZW50ID8/IHt9O1xuXG4gICAgY29uc3QgbWVyZ2VkID0ge1xuICAgICAgLi4uKGxlZ2FjeVB1Ymxpc2hlciA/PyB7fSksXG4gICAgICAuLi4obGVnYWN5Q3VycmVudElkID8/IHt9KSxcbiAgICAgIC4uLihjdXJyZW50ID8/IHt9KSxcbiAgICB9O1xuICAgIHRyeSB7XG4gICAgICBzdG9yYWdlLnNldEl0ZW0oa2V5LCBKU09OLnN0cmluZ2lmeShtZXJnZWQpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBtZXJnZWQ7XG4gICAgfVxuICAgIGZvciAoY29uc3QgbGVnYWN5S2V5IG9mIGxlZ2FjeUtleXMpIHN0b3JhZ2UucmVtb3ZlSXRlbShsZWdhY3lLZXkpO1xuICAgIHJldHVybiBtZXJnZWQ7XG4gIH07XG4gIGNvbnN0IHdyaXRlID0gKHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gc3RvcmFnZS5zZXRJdGVtKGtleSwgSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgcmV0dXJuIHtcbiAgICBnZXQ6IDxUPihuYW1lOiBzdHJpbmcsIGZhbGxiYWNrPzogVCkgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIHJldHVybiBuYW1lIGluIGN1cnJlbnQgPyAoY3VycmVudFtuYW1lXSBhcyBUKSA6IChmYWxsYmFjayBhcyBUKTtcbiAgICB9LFxuICAgIHNldDogKG5hbWU6IHN0cmluZywgdmFsdWU6IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSByZWFkKCk7XG4gICAgICBjdXJyZW50W25hbWVdID0gdmFsdWU7XG4gICAgICB3cml0ZShjdXJyZW50KTtcbiAgICB9LFxuICAgIGRlbGV0ZTogKG5hbWU6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHJlYWQoKTtcbiAgICAgIGRlbGV0ZSBjdXJyZW50W25hbWVdO1xuICAgICAgd3JpdGUoY3VycmVudCk7XG4gICAgfSxcbiAgICBhbGw6ICgpID0+IHJlYWQoKSxcbiAgfTtcbn1cbiIsICIvKipcbiAqIEJ1aWx0LWluIFwiVHdlYWsgTWFuYWdlclwiIFx1MjAxNCBhdXRvLWluamVjdGVkIGJ5IHRoZSBydW50aW1lLCBub3QgYSB1c2VyIHR3ZWFrLlxuICogTGlzdHMgZGlzY292ZXJlZCB0d2Vha3Mgd2l0aCBlbmFibGUgdG9nZ2xlcywgb3BlbnMgdGhlIHR3ZWFrcyBkaXIsIGxpbmtzXG4gKiB0byBsb2dzIGFuZCBjb25maWcuIExpdmVzIGluIHRoZSByZW5kZXJlci5cbiAqXG4gKiBUaGlzIGlzIGludm9rZWQgZnJvbSBwcmVsb2FkL2luZGV4LnRzIEFGVEVSIHVzZXIgdHdlYWtzIGFyZSBsb2FkZWQgc28gaXRcbiAqIGNhbiBzaG93IHVwLXRvLWRhdGUgc3RhdHVzLlxuICovXG5pbXBvcnQgeyBpcGNSZW5kZXJlciB9IGZyb20gXCJlbGVjdHJvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTZWN0aW9uIH0gZnJvbSBcIi4vc2V0dGluZ3MtaW5qZWN0b3JcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG1vdW50TWFuYWdlcigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgdHdlYWtzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6bGlzdC10d2Vha3NcIikpIGFzIEFycmF5PHtcbiAgICBtYW5pZmVzdDogeyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZzsgZGVzY3JpcHRpb24/OiBzdHJpbmcgfTtcbiAgICBlbnRyeUV4aXN0czogYm9vbGVhbjtcbiAgfT47XG4gIGNvbnN0IHBhdGhzID0gKGF3YWl0IGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6dXNlci1wYXRoc1wiKSkgYXMge1xuICAgIHVzZXJSb290OiBzdHJpbmc7XG4gICAgdHdlYWtzRGlyOiBzdHJpbmc7XG4gICAgbG9nRGlyOiBzdHJpbmc7XG4gIH07XG5cbiAgcmVnaXN0ZXJTZWN0aW9uKHtcbiAgICBpZDogXCJ0d2Vha2VyOm1hbmFnZXJcIixcbiAgICB0aXRsZTogXCJUd2VhayBNYW5hZ2VyXCIsXG4gICAgZGVzY3JpcHRpb246IGAke3R3ZWFrcy5sZW5ndGh9IHR3ZWFrKHMpIGluc3RhbGxlZC4gVXNlciBkaXI6ICR7cGF0aHMudXNlclJvb3R9YCxcbiAgICByZW5kZXIocm9vdCkge1xuICAgICAgcm9vdC5zdHlsZS5jc3NUZXh0ID0gXCJkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo4cHg7XCI7XG5cbiAgICAgIGNvbnN0IGFjdGlvbnMgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgICAgYWN0aW9ucy5zdHlsZS5jc3NUZXh0ID0gXCJkaXNwbGF5OmZsZXg7Z2FwOjhweDtmbGV4LXdyYXA6d3JhcDtcIjtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIk9wZW4gdHdlYWtzIGZvbGRlclwiLCAoKSA9PlxuICAgICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmV2ZWFsXCIsIHBhdGhzLnR3ZWFrc0RpcikuY2F0Y2goKCkgPT4ge30pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIk9wZW4gbG9nc1wiLCAoKSA9PlxuICAgICAgICAgIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6cmV2ZWFsXCIsIHBhdGhzLmxvZ0RpcikuY2F0Y2goKCkgPT4ge30pLFxuICAgICAgICApLFxuICAgICAgKTtcbiAgICAgIGFjdGlvbnMuYXBwZW5kQ2hpbGQoXG4gICAgICAgIGJ1dHRvbihcIlJlbG9hZCB3aW5kb3dcIiwgKCkgPT4gbG9jYXRpb24ucmVsb2FkKCkpLFxuICAgICAgKTtcbiAgICAgIHJvb3QuYXBwZW5kQ2hpbGQoYWN0aW9ucyk7XG5cbiAgICAgIGlmICh0d2Vha3MubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIGNvbnN0IGVtcHR5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInBcIik7XG4gICAgICAgIGVtcHR5LnN0eWxlLmNzc1RleHQgPSBcImNvbG9yOiM4ODg7Zm9udDoxM3B4IHN5c3RlbS11aTttYXJnaW46OHB4IDA7XCI7XG4gICAgICAgIGVtcHR5LnRleHRDb250ZW50ID1cbiAgICAgICAgICBcIk5vIHVzZXIgdHdlYWtzIHlldC4gRHJvcCBhIGZvbGRlciB3aXRoIG1hbmlmZXN0Lmpzb24gKyBpbmRleC5qcyBpbnRvIHRoZSB0d2Vha3MgZGlyLCB0aGVuIHJlbG9hZC5cIjtcbiAgICAgICAgcm9vdC5hcHBlbmRDaGlsZChlbXB0eSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgY29uc3QgbGlzdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ1bFwiKTtcbiAgICAgIGxpc3Quc3R5bGUuY3NzVGV4dCA9IFwibGlzdC1zdHlsZTpub25lO21hcmdpbjowO3BhZGRpbmc6MDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo2cHg7XCI7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgdHdlYWtzKSB7XG4gICAgICAgIGNvbnN0IGxpID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImxpXCIpO1xuICAgICAgICBsaS5zdHlsZS5jc3NUZXh0ID1cbiAgICAgICAgICBcImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47cGFkZGluZzo4cHggMTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlciwjMmEyYTJhKTtib3JkZXItcmFkaXVzOjZweDtcIjtcbiAgICAgICAgY29uc3QgbGVmdCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgICAgIGxlZnQuaW5uZXJIVE1MID0gYFxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJmb250OjYwMCAxM3B4IHN5c3RlbS11aTtcIj4ke2VzY2FwZSh0Lm1hbmlmZXN0Lm5hbWUpfSA8c3BhbiBzdHlsZT1cImNvbG9yOiM4ODg7Zm9udC13ZWlnaHQ6NDAwO1wiPnYke2VzY2FwZSh0Lm1hbmlmZXN0LnZlcnNpb24pfTwvc3Bhbj48L2Rpdj5cbiAgICAgICAgICA8ZGl2IHN0eWxlPVwiY29sb3I6Izg4ODtmb250OjEycHggc3lzdGVtLXVpO1wiPiR7ZXNjYXBlKHQubWFuaWZlc3QuZGVzY3JpcHRpb24gPz8gdC5tYW5pZmVzdC5pZCl9PC9kaXY+XG4gICAgICAgIGA7XG4gICAgICAgIGNvbnN0IHJpZ2h0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgcmlnaHQuc3R5bGUuY3NzVGV4dCA9IFwiY29sb3I6Izg4ODtmb250OjEycHggc3lzdGVtLXVpO1wiO1xuICAgICAgICByaWdodC50ZXh0Q29udGVudCA9IHQuZW50cnlFeGlzdHMgPyBcImxvYWRlZFwiIDogXCJtaXNzaW5nIGVudHJ5XCI7XG4gICAgICAgIGxpLmFwcGVuZChsZWZ0LCByaWdodCk7XG4gICAgICAgIGxpc3QuYXBwZW5kKGxpKTtcbiAgICAgIH1cbiAgICAgIHJvb3QuYXBwZW5kKGxpc3QpO1xuICAgIH0sXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBidXR0b24obGFiZWw6IHN0cmluZywgb25jbGljazogKCkgPT4gdm9pZCk6IEhUTUxCdXR0b25FbGVtZW50IHtcbiAgY29uc3QgYiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJidXR0b25cIik7XG4gIGIudHlwZSA9IFwiYnV0dG9uXCI7XG4gIGIudGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgYi5zdHlsZS5jc3NUZXh0ID1cbiAgICBcInBhZGRpbmc6NnB4IDEwcHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXIsIzMzMyk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjppbmhlcml0O2ZvbnQ6MTJweCBzeXN0ZW0tdWk7Y3Vyc29yOnBvaW50ZXI7XCI7XG4gIGIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uY2xpY2spO1xuICByZXR1cm4gYjtcbn1cblxuZnVuY3Rpb24gZXNjYXBlKHM6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzLnJlcGxhY2UoL1smPD5cIiddL2csIChjKSA9PlxuICAgIGMgPT09IFwiJlwiXG4gICAgICA/IFwiJmFtcDtcIlxuICAgICAgOiBjID09PSBcIjxcIlxuICAgICAgICA/IFwiJmx0O1wiXG4gICAgICAgIDogYyA9PT0gXCI+XCJcbiAgICAgICAgICA/IFwiJmd0O1wiXG4gICAgICAgICAgOiBjID09PSAnXCInXG4gICAgICAgICAgICA/IFwiJnF1b3Q7XCJcbiAgICAgICAgICAgIDogXCImIzM5O1wiLFxuICApO1xufVxuIiwgImltcG9ydCB7IGlwY1JlbmRlcmVyIH0gZnJvbSBcImVsZWN0cm9uXCI7XG5pbXBvcnQge1xuICBkZXNrdG9wVXBkYXRlSW5kaWNhdG9ySWRlbnRpdHksXG4gIHNob3VsZFNob3dEZXNrdG9wVXBkYXRlSW5kaWNhdG9yLFxuICB0eXBlIERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSxcbn0gZnJvbSBcIi4vZGVza3RvcC11cGRhdGUtaW5kaWNhdG9yLXN0YXRlXCI7XG5cbmNvbnN0IFVQREFURV9DSEFOR0VEX0NIQU5ORUwgPSBcInR3ZWFrZXI6Y29kZXgtZGVza3RvcC11cGRhdGUtY2hhbmdlZFwiO1xuY29uc3QgSU5ESUNBVE9SX0FUVFJJQlVURSA9IFwiZGF0YS10d2Vha2VyLWRlc2t0b3AtdXBkYXRlLWluZGljYXRvclwiO1xuXG5leHBvcnQgZnVuY3Rpb24gZmluZERlc2t0b3BVcGRhdGVGb290ZXJNb3VudChyb290OiBQYXJlbnROb2RlID0gZG9jdW1lbnQpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBhbmNob3JzID0gQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiW2FyaWEtbGFiZWxdXCIpKTtcbiAgZm9yIChjb25zdCBhbmNob3Igb2YgYW5jaG9ycykge1xuICAgIGNvbnN0IGxhYmVsID0gYW5jaG9yLmdldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIik/LnRyaW0oKS50b0xvd2VyQ2FzZSgpID8/IFwiXCI7XG4gICAgaWYgKCEvKHNldHRpbmdzfGFjY291bnR8cHJvZmlsZXxoZWxwKS8udGVzdChsYWJlbCkpIGNvbnRpbnVlO1xuICAgIGxldCBjYW5kaWRhdGU6IEhUTUxFbGVtZW50IHwgbnVsbCA9IGFuY2hvcjtcbiAgICBmb3IgKGxldCBkZXB0aCA9IDA7IGNhbmRpZGF0ZSAmJiBkZXB0aCA8IDY7IGRlcHRoICs9IDEpIHtcbiAgICAgIGNvbnN0IHJvbGUgPSBjYW5kaWRhdGUuZ2V0QXR0cmlidXRlKFwicm9sZVwiKTtcbiAgICAgIGlmIChjYW5kaWRhdGUubWF0Y2hlcyhcIm5hdiwgYXNpZGUsIGZvb3RlclwiKSB8fCByb2xlID09PSBcIm5hdmlnYXRpb25cIiB8fCByb2xlID09PSBcImNvbnRlbnRpbmZvXCIpIHtcbiAgICAgICAgcmV0dXJuIGNhbmRpZGF0ZTtcbiAgICAgIH1cbiAgICAgIGNhbmRpZGF0ZSA9IGNhbmRpZGF0ZS5wYXJlbnRFbGVtZW50O1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0RGVza3RvcFVwZGF0ZUluZGljYXRvcigpOiAoKSA9PiB2b2lkIHtcbiAgbGV0IGN1cnJlbnQ6IERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSB8IG51bGwgPSBudWxsO1xuICBsZXQgaW5kaWNhdG9yOiBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FybmluZ1RpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICBjb25zdCB3YXJuZWRJZGVudGl0aWVzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgY29uc3QgcmVtb3ZlSW5kaWNhdG9yID0gKCk6IHZvaWQgPT4ge1xuICAgIGluZGljYXRvcj8ucmVtb3ZlKCk7XG4gICAgaW5kaWNhdG9yID0gbnVsbDtcbiAgICBpZiAod2FybmluZ1RpbWVyKSBjbGVhclRpbWVvdXQod2FybmluZ1RpbWVyKTtcbiAgICB3YXJuaW5nVGltZXIgPSBudWxsO1xuICB9O1xuXG4gIGNvbnN0IHNjaGVkdWxlTWlzc2luZ01vdW50V2FybmluZyA9IChpZGVudGl0eTogc3RyaW5nKTogdm9pZCA9PiB7XG4gICAgaWYgKHdhcm5pbmdUaW1lciB8fCB3YXJuZWRJZGVudGl0aWVzLmhhcyhpZGVudGl0eSkpIHJldHVybjtcbiAgICB3YXJuaW5nVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHdhcm5pbmdUaW1lciA9IG51bGw7XG4gICAgICBpZiAoIWN1cnJlbnQgfHwgIXNob3VsZFNob3dEZXNrdG9wVXBkYXRlSW5kaWNhdG9yKGN1cnJlbnQpKSByZXR1cm47XG4gICAgICBpZiAoZGVza3RvcFVwZGF0ZUluZGljYXRvcklkZW50aXR5KGN1cnJlbnQpICE9PSBpZGVudGl0eSB8fCBmaW5kRGVza3RvcFVwZGF0ZUZvb3Rlck1vdW50KCkpIHJldHVybjtcbiAgICAgIHdhcm5lZElkZW50aXRpZXMuYWRkKGlkZW50aXR5KTtcbiAgICAgIGNvbnNvbGUud2FybihgW3R3ZWFrZXJdIENoYXRHUFQgdXBkYXRlICR7aWRlbnRpdHl9IGlzIGF2YWlsYWJsZSwgYnV0IG5vIHNlbWFudGljIHNpZGViYXIgZm9vdGVyIG1vdW50IHBvaW50IHdhcyBmb3VuZC5gKTtcbiAgICB9LCAzXzAwMCk7XG4gIH07XG5cbiAgY29uc3QgcmVuZGVyID0gKCk6IHZvaWQgPT4ge1xuICAgIGlmICghc2hvdWxkU2hvd0Rlc2t0b3BVcGRhdGVJbmRpY2F0b3IoY3VycmVudCkpIHtcbiAgICAgIHJlbW92ZUluZGljYXRvcigpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCBpZGVudGl0eSA9IGRlc2t0b3BVcGRhdGVJbmRpY2F0b3JJZGVudGl0eShjdXJyZW50ISk7XG4gICAgY29uc3QgbW91bnQgPSBmaW5kRGVza3RvcFVwZGF0ZUZvb3Rlck1vdW50KCk7XG4gICAgaWYgKCFtb3VudCkge1xuICAgICAgaW5kaWNhdG9yPy5yZW1vdmUoKTtcbiAgICAgIGluZGljYXRvciA9IG51bGw7XG4gICAgICBzY2hlZHVsZU1pc3NpbmdNb3VudFdhcm5pbmcoaWRlbnRpdHkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAod2FybmluZ1RpbWVyKSBjbGVhclRpbWVvdXQod2FybmluZ1RpbWVyKTtcbiAgICB3YXJuaW5nVGltZXIgPSBudWxsO1xuICAgIGlmICghaW5kaWNhdG9yKSB7XG4gICAgICBpbmRpY2F0b3IgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYnV0dG9uXCIpO1xuICAgICAgaW5kaWNhdG9yLnR5cGUgPSBcImJ1dHRvblwiO1xuICAgICAgaW5kaWNhdG9yLnNldEF0dHJpYnV0ZShJTkRJQ0FUT1JfQVRUUklCVVRFLCBcInRydWVcIik7XG4gICAgICBpbmRpY2F0b3Iuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCBcIkNoYXRHUFQgdXBkYXRlIGF2YWlsYWJsZVwiKTtcbiAgICAgIGluZGljYXRvci50ZXh0Q29udGVudCA9IFwiVXBkYXRlXCI7XG4gICAgICBPYmplY3QuYXNzaWduKGluZGljYXRvci5zdHlsZSwge1xuICAgICAgICBhcHBlYXJhbmNlOiBcIm5vbmVcIixcbiAgICAgICAgYm9yZGVyOiBcIjFweCBzb2xpZCBjb2xvci1taXgoaW4gc3JnYiwgY3VycmVudENvbG9yIDI0JSwgdHJhbnNwYXJlbnQpXCIsXG4gICAgICAgIGJvcmRlclJhZGl1czogXCI5OTk5cHhcIixcbiAgICAgICAgYmFja2dyb3VuZDogXCJjb2xvci1taXgoaW4gc3JnYiwgY3VycmVudENvbG9yIDEwJSwgdHJhbnNwYXJlbnQpXCIsXG4gICAgICAgIGNvbG9yOiBcImluaGVyaXRcIixcbiAgICAgICAgY3Vyc29yOiBcInBvaW50ZXJcIixcbiAgICAgICAgZm9udDogXCJpbmhlcml0XCIsXG4gICAgICAgIGZvbnRTaXplOiBcIjEycHhcIixcbiAgICAgICAgZm9udFdlaWdodDogXCI2MDBcIixcbiAgICAgICAgbWFyZ2luOiBcIjZweCAxMHB4XCIsXG4gICAgICAgIHBhZGRpbmc6IFwiNXB4IDEwcHhcIixcbiAgICAgIH0pO1xuICAgICAgaW5kaWNhdG9yLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAgIGluZGljYXRvciEuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICB2b2lkIGlwY1JlbmRlcmVyLmludm9rZShcInR3ZWFrZXI6Y2hlY2stY29kZXgtZGVza3RvcC11cGRhdGVcIilcbiAgICAgICAgICAuZmluYWxseSgoKSA9PiB7XG4gICAgICAgICAgICBpZiAoaW5kaWNhdG9yPy5pc0Nvbm5lY3RlZCkgaW5kaWNhdG9yLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcbiAgICB9XG4gICAgaW5kaWNhdG9yLnRpdGxlID0gYENoYXRHUFQgJHtjdXJyZW50Py5sYXRlc3Q/Lm1hcmtldGluZ1ZlcnNpb24gPz8gXCJ1cGRhdGVcIn0gaXMgYXZhaWxhYmxlYDtcbiAgICBpZiAoaW5kaWNhdG9yLnBhcmVudEVsZW1lbnQgIT09IG1vdW50KSBtb3VudC5hcHBlbmRDaGlsZChpbmRpY2F0b3IpO1xuICB9O1xuXG4gIGNvbnN0IG9uQ2hhbmdlZCA9IChfZXZlbnQ6IHVua25vd24sIHZhbHVlOiB1bmtub3duKTogdm9pZCA9PiB7XG4gICAgY3VycmVudCA9IHZhbHVlICYmIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiA/IHZhbHVlIGFzIERlc2t0b3BVcGRhdGVJbmRpY2F0b3JTdGF0ZSA6IG51bGw7XG4gICAgcmVuZGVyKCk7XG4gIH07XG4gIGlwY1JlbmRlcmVyLm9uKFVQREFURV9DSEFOR0VEX0NIQU5ORUwsIG9uQ2hhbmdlZCk7XG5cbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcihyZW5kZXIpO1xuICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIHZvaWQgaXBjUmVuZGVyZXIuaW52b2tlKFwidHdlYWtlcjpnZXQtY29kZXgtZGVza3RvcC11cGRhdGVcIilcbiAgICAudGhlbigodmFsdWUpID0+IG9uQ2hhbmdlZCh1bmRlZmluZWQsIHZhbHVlKSlcbiAgICAuY2F0Y2goKCkgPT4ge30pO1xuXG4gIHJldHVybiAoKSA9PiB7XG4gICAgaXBjUmVuZGVyZXIucmVtb3ZlTGlzdGVuZXIoVVBEQVRFX0NIQU5HRURfQ0hBTk5FTCwgb25DaGFuZ2VkKTtcbiAgICBvYnNlcnZlci5kaXNjb25uZWN0KCk7XG4gICAgcmVtb3ZlSW5kaWNhdG9yKCk7XG4gIH07XG59XG4iLCAiZXhwb3J0IGludGVyZmFjZSBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUge1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGxhdGVzdD86IHsgbWFya2V0aW5nVmVyc2lvbj86IHN0cmluZyB8IG51bGw7IGJ1aWxkPzogc3RyaW5nIHwgbnVsbCB9O1xuICBuYXRpdmVVcGRhdGVDb250cm9sQWN0aXZlPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFNob3dEZXNrdG9wVXBkYXRlSW5kaWNhdG9yKHN0YXRlOiBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUgfCBudWxsKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGF0ZT8uc3RhdHVzID09PSBcInVwZGF0ZS1hdmFpbGFibGVcIiAmJiBzdGF0ZS5uYXRpdmVVcGRhdGVDb250cm9sQWN0aXZlICE9PSB0cnVlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZGVza3RvcFVwZGF0ZUluZGljYXRvcklkZW50aXR5KHN0YXRlOiBEZXNrdG9wVXBkYXRlSW5kaWNhdG9yU3RhdGUpOiBzdHJpbmcge1xuICByZXR1cm4gW3N0YXRlLmxhdGVzdD8ubWFya2V0aW5nVmVyc2lvbiA/PyBcInVua25vd25cIiwgc3RhdGUubGF0ZXN0Py5idWlsZCA/PyBcInVua25vd25cIl0uam9pbihcIjpcIik7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFXQSxJQUFBQSxtQkFBNEI7OztBQzZCckIsU0FBUyxtQkFBeUI7QUFDdkMsTUFBSSxPQUFPLCtCQUFnQztBQUMzQyxRQUFNLFlBQVksb0JBQUksSUFBK0I7QUFDckQsTUFBSSxTQUFTO0FBQ2IsUUFBTUMsYUFBWSxvQkFBSSxJQUE0QztBQUVsRSxRQUFNLE9BQTBCO0FBQUEsSUFDOUIsZUFBZTtBQUFBLElBQ2Y7QUFBQSxJQUNBLE9BQU8sVUFBVTtBQUNmLFlBQU0sS0FBSztBQUNYLGdCQUFVLElBQUksSUFBSSxRQUFRO0FBRTFCLGNBQVE7QUFBQSxRQUNOO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxTQUFTO0FBQUEsTUFDWDtBQUNBLGFBQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxHQUFHLE9BQU8sSUFBSTtBQUNaLFVBQUksSUFBSUEsV0FBVSxJQUFJLEtBQUs7QUFDM0IsVUFBSSxDQUFDLEVBQUcsQ0FBQUEsV0FBVSxJQUFJLE9BQVEsSUFBSSxvQkFBSSxJQUFJLENBQUU7QUFDNUMsUUFBRSxJQUFJLEVBQUU7QUFBQSxJQUNWO0FBQUEsSUFDQSxJQUFJLE9BQU8sSUFBSTtBQUNiLE1BQUFBLFdBQVUsSUFBSSxLQUFLLEdBQUcsT0FBTyxFQUFFO0FBQUEsSUFDakM7QUFBQSxJQUNBLEtBQUssVUFBVSxNQUFNO0FBQ25CLE1BQUFBLFdBQVUsSUFBSSxLQUFLLEdBQUcsUUFBUSxDQUFDLE9BQU8sR0FBRyxHQUFHLElBQUksQ0FBQztBQUFBLElBQ25EO0FBQUEsSUFDQSxvQkFBb0I7QUFBQSxJQUFDO0FBQUEsSUFDckIsdUJBQXVCO0FBQUEsSUFBQztBQUFBLElBQ3hCLHNCQUFzQjtBQUFBLElBQUM7QUFBQSxJQUN2QixXQUFXO0FBQUEsSUFBQztBQUFBLEVBQ2Q7QUFFQSxTQUFPLGVBQWUsUUFBUSxrQ0FBa0M7QUFBQSxJ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QUNYLENBQUM7QUFBQSxJQUNILEtBQUs7QUFDSCxhQUFPLDZCQUFZLE9BQU8sdUNBQXVDLEtBQUssQ0FBQyxDQUFDO0FBQUEsSUFDMUUsS0FBSztBQUNILGFBQU8sNkJBQVksT0FBTywyQkFBMkI7QUFBQSxJQUN2RDtBQUNFLFlBQU0sSUFBSSxNQUFNLDhDQUE4QyxNQUFNLEVBQUU7QUFBQSxFQUMxRTtBQUNGO0FBRUEsU0FBUyxpQ0FDUCxVQUNBLGlCQUNTO0FBQ1QsTUFBSSxDQUFDLHFCQUFxQixLQUFLLFFBQVEsRUFBRyxPQUFNLElBQUksTUFBTSxtQkFBbUI7QUFDN0UsTUFBSSxnQkFBZ0IsSUFBSSxRQUFRLEVBQUcsUUFBTztBQUMxQyxRQUFNLFdBQVcsQ0FBQyxRQUFpQixZQUFxQjtBQUN0RCxpQ0FBWSxLQUFLLDJCQUEyQixVQUFVLE9BQU87QUFBQSxFQUMvRDtBQUNBLGtCQUFnQixJQUFJLFVBQVUsUUFBUTtBQUN0QywrQkFBWSxHQUFHLDRCQUE0QixRQUFRLEdBQUcsUUFBUTtBQUM5RCxTQUFPO0FBQ1Q7QUFFQSxTQUFTLG1DQUNQLFVBQ0EsaUJBQ1M7QUFDVCxRQUFNLFdBQVcsZ0JBQWdCLElBQUksUUFBUTtBQUM3QyxNQUFJLENBQUMsU0FBVSxRQUFPO0FBQ3RCLGtCQUFnQixPQUFPLFFBQVE7QUFDL0IsK0JBQVksZUFBZSw0QkFBNEIsUUFBUSxHQUFHLFFBQVE7QUFDMUUsU0FBTztBQUNUOyIsCiAgIm5hbWVzIjogWyJpbXBvcnRfZWxlY3Ryb24iLCAibGlzdGVuZXJzIiwgImJ1dHRvbiIsICJidXR0b24iLCAicm9vdCIsICJzbmFwc2hvdCIsICJjb21wYWN0IiwgInJlc3VsdCIsICJzdGF0ZSIsICJzbmFwc2hvdCIsICJidXR0b24iLCAic3RhdGUiLCAiY2hlY2siLCAiYnV0dG9uIiwgImltcG9ydF9lbGVjdHJvbiIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJpbXBvcnRfZWxlY3Ryb24iLCAiaW1wb3J0X2VsZWN0cm9uIiwgInN0YXRlIiwgInNhZmVTdHJpbmdpZnkiXQp9Cg==
