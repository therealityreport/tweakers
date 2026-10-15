"use strict";

// The entry point owns process wiring only. State, inventory, policy, settings,
// and sidebar rendering live in small modules so each boundary can be tested
// without loading a host UI or starting a local Git scan.
const common = require("./common");
const state = require("./state");
const policy = require("./policy");
const inventory = require("./inventory");
const service = require("./service");
const nativeProjectMenu = require("./native-project-menu");
const sidebar = require("./sidebar");
const settings = require("./settings");
const threadSummaryProfiles = require("./thread-summary-profiles");

const IPC = "projects";
const SERVICE_KEY = "__tweakersProjectsServiceV1";
const HANDLER_KEY = "__tweakersProjectsHandlerV1";
const NATIVE_MENU_BRIDGE_KEY = "__tweakersProjectsNativeMenuBridgeV1";
const settingsPresenter = settings.createSettingsPresenter({
  openNativeProjectEditDialog: sidebar.openNativeProjectEditDialog,
});
const activePages = new WeakMap();

function startMain(api) {
  const projectService = service.createProjectService(api);
  globalThis[SERVICE_KEY] = projectService;
  if (!globalThis[HANDLER_KEY]) {
    const unregister = api.ipc.handle?.(IPC, (message) => {
      const active = globalThis[SERVICE_KEY];
      if (!active) return common.safeFailure("unavailable");
      return active.handle(message);
    });
    globalThis[HANDLER_KEY] = typeof unregister === "function" ? unregister : true;
  }
  globalThis[NATIVE_MENU_BRIDGE_KEY]?.dispose?.();
  globalThis[NATIVE_MENU_BRIDGE_KEY] = nativeProjectMenu.installNativeProjectMenuBridge(api);
  api.log?.info?.("Projects service ready");
}

function startRenderer(api) {
  let disposed = false;
  const profilesInstance = {};
  const profilesApi = { ...api, ipc: { ...api.ipc,
    invoke(channel, ...args) { return api.ipc.invoke(channel === "profiles.read" ? IPC : channel, ...args); },
  } };
  let profilesEnabled = false;
  const setProfilesEnabled = (enabled) => {
    if (disposed || enabled === profilesEnabled) return;
    profilesEnabled = enabled;
    if (enabled) threadSummaryProfiles.start.call(profilesInstance, profilesApi, { integrated: true });
    else threadSummaryProfiles.stop.call(profilesInstance);
  };
  setProfilesEnabled(api.storage?.get?.("threadSummaryProfiles", false) === true);
  let latestState = null;
  let latestRevision = null;
  let latestNativeProjects = [];
  let latestSurfaceFingerprint = null;
  let aliasRefreshRequest = 0;
  let revisionRefreshRequest = 0;
  let selectedSettingsProjectId = null;
  const updater = sidebar.createProjectSidebarUpdater(api, () => latestState);
  const apply = () => updater.schedule(true);
  const acceptResponse = (response) => {
    if (disposed || !response?.ok) return false;
    if (Array.isArray(response.nativeProjects)) latestNativeProjects = response.nativeProjects;
    latestState = state.bindNativeProjectIdentities(response.state, latestNativeProjects);
    latestRevision = response.revision;
    window.dispatchEvent(new CustomEvent("tweaker:projects-state-ready"));
    return true;
  };
  const saveAppearance = async (projectId, choice) => {
    if (!latestState || !projectId) return false;
    if (!latestState.nodes.some((node) => node.type === "project" && node.id === projectId)) {
      window.alert("Could not save project appearance because this project changed. Open Edit again to retry.");
      return false;
    }
    const taskOrderingChange = Object.prototype.hasOwnProperty.call(choice || {}, "taskSort")
      || Object.prototype.hasOwnProperty.call(choice || {}, "pinnedTaskIds");
    const changeLabel = taskOrderingChange ? "project task order" : "project color";
    try {
      const nodes = latestState.nodes.map((node) => node.id === projectId ? { ...node, ...choice } : node);
      const response = await api.ipc.invoke(IPC, {
        action: "save",
        state: { ...latestState, nodes },
        baseRevision: latestRevision,
      });
      if (!response?.ok) {
        const code = response?.error?.code || "unknown";
        api.log?.warn?.(`${changeLabel} save failed`, code);
        if (code === "stale-revision") {
          const current = await api.ipc.invoke(IPC, { action: "get" });
          if (acceptResponse(current)) apply();
          window.alert(`Could not save the ${changeLabel} because this project changed. Try again.`);
          return false;
        }
        window.alert(`Could not save the ${changeLabel}.`);
        return false;
      }
      latestState = state.bindNativeProjectIdentities(response.state, latestNativeProjects);
      latestRevision = response.revision;
      apply();
      window.dispatchEvent(new CustomEvent("tweaker:projects-color-change", { detail: { projectId } }));
      return true;
    } catch (error) {
      api.log?.warn?.(`${changeLabel} save failed`, String(error));
      window.alert(`Could not save the ${changeLabel}.`);
      return false;
    }
  };
  const removeRevision = api.ipc.on?.("revision", (payload) => {
    if (typeof payload?.revision === "string" && /^[a-f0-9]{32}$/.test(payload.revision)) {
      window.dispatchEvent(new CustomEvent("tweaker:projects-revision", { detail: { revision: payload.revision } }));
      const request = ++revisionRefreshRequest;
      api.ipc.invoke(IPC, { action: "get" }).then((response) => {
        if (request === revisionRefreshRequest && acceptResponse(response)) apply();
      }).catch(() => {});
    }
  });
  const handle = api.settings.registerPage({
    id: "projects",
    title: "Projects",
    description: "Organize the projects shown in your ChatGPT sidebar.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block shrink-0 align-middle" aria-hidden="true"><path d="M2.5 5.5h6l1.5 2h7.5v7.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    render(root) {
      const profilesSetting = document.createElement("label");
      profilesSetting.className = "flex items-center justify-between gap-4 rounded-lg border border-token-border p-3 text-sm text-token-text-primary";
      const copy = document.createElement("span");
      copy.textContent = "Thread Summary Profiles";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.setAttribute("role", "switch");
      toggle.checked = profilesEnabled;
      toggle.addEventListener("change", () => {
        api.storage?.set?.("threadSummaryProfiles", toggle.checked);
        setProfilesEnabled(toggle.checked);
      });
      profilesSetting.append(copy, toggle);
      const content = document.createElement("div");
      root.replaceChildren(profilesSetting, content);
      const disposePage = settingsPresenter.renderProjectsPage(api, content, (nextState, revision, nativeProjects) => {
        if (Array.isArray(nativeProjects)) latestNativeProjects = nativeProjects;
        latestState = state.bindNativeProjectIdentities(nextState, latestNativeProjects);
        latestRevision = revision;
        apply();
      }, () => selectedSettingsProjectId, (projectId) => { selectedSettingsProjectId = projectId; });
      return () => { disposePage?.(); root.replaceChildren(); };
    },
  });
  api.ipc.invoke(IPC, { action: "get" }).then((response) => {
    if (acceptResponse(response)) apply();
  }).catch(() => {});
  const removeHostObserver = api.react?.host?.observe?.(["projects"], () => {
    updater.schedule();
    const fingerprint = sidebar.nativeProjectSurfaceFingerprint(api);
    if (fingerprint === latestSurfaceFingerprint) return;
    latestSurfaceFingerprint = fingerprint;
    const request = ++aliasRefreshRequest;
    api.ipc.invoke(IPC, { action: "get" }).then((response) => {
      if (request === aliasRefreshRequest && acceptResponse(response)) apply();
    }).catch(() => {});
  });
  const removeColorControls = sidebar.installProjectColorControls(api, () => latestState, saveAppearance);
  const removeTaskControls = sidebar.installProjectTaskControls(api, () => latestState, saveAppearance);
  const removeEditProjectControls = settingsPresenter.installEditProjectDialogControls(
    api,
    () => latestState,
    saveAppearance,
    async (projectId, dialog) => {
      selectedSettingsProjectId = projectId;
      settings.dialogCloseButton(dialog)?.click?.();
      const result = await api.settings.openPage("projects");
      if (!result?.ok) window.alert("Open Settings, then choose Projects to view this project.");
    },
  );
  return {
    unregister() {
      disposed = true;
      threadSummaryProfiles.stop.call(profilesInstance);
      aliasRefreshRequest += 1;
      revisionRefreshRequest += 1;
      removeRevision?.();
      removeHostObserver?.();
      updater.dispose();
      removeColorControls?.();
      removeTaskControls?.();
      removeEditProjectControls?.();
      sidebar.removeProjectColorArtifacts();
      handle.unregister?.();
    },
  };
}

const tweak = {
  start(api) {
    if (api.process === "main") return startMain(api);
    activePages.get(this)?.unregister?.();
    const page = startRenderer(api);
    this._page = page;
    activePages.set(this, page);
    return page;
  },
  stop() {
    if (typeof window === "undefined") {
      const projectService = globalThis[SERVICE_KEY];
      projectService?.dispose?.();
      if (globalThis[SERVICE_KEY] === projectService) globalThis[SERVICE_KEY] = null;
      const unregister = globalThis[HANDLER_KEY];
      if (typeof unregister === "function") { try { unregister(); } catch {} }
      globalThis[HANDLER_KEY] = null;
      const nativeMenuBridge = globalThis[NATIVE_MENU_BRIDGE_KEY];
      nativeMenuBridge?.dispose?.();
      if (globalThis[NATIVE_MENU_BRIDGE_KEY] === nativeMenuBridge) globalThis[NATIVE_MENU_BRIDGE_KEY] = null;
    }
    this._page?.unregister?.();
    this._page = null;
    activePages.delete(this);
  },
  _test: {
    ...common,
    ...state,
    ...policy,
    ...inventory,
    createService: service.createProjectService,
    createProjectService: service.createProjectService,
    adapterProbePaths: service.adapterProbePaths,
    detectConnections: service.detectConnections,
    normalizeGitHubArgs: service.normalizeGitHubArgs,
    runGitHubForProject: service.runGitHubForProject,
    ...nativeProjectMenu,
    ...sidebar,
    projectAppearanceEditor: settings.projectAppearanceEditor,
    branchInventoryDisclosure: settings.branchInventoryDisclosure,
    createInventoryLoader: settings.createInventoryLoader,
    editProjectDialogCandidates: settings.editProjectDialogCandidates,
    installEditProjectDialogControls: settings.installEditProjectDialogControls,
  },
};

module.exports = tweak;
