"use strict";

// The entry point owns process wiring only. State, inventory, policy, settings,
// and sidebar rendering live in small modules so each boundary can be tested
// without loading a host UI or starting a local Git scan.
const common = require("./common");
const state = require("./state");
const policy = require("./policy");
const inventory = require("./inventory");
const service = require("./service");
const sidebar = require("./sidebar");
const settings = require("./settings");

const IPC = "projects";
const SERVICE_KEY = "__tweakersProjectsServiceV1";
const HANDLER_KEY = "__tweakersProjectsHandlerV1";
const settingsPresenter = settings.createSettingsPresenter({
  openNativeProjectEditDialog: sidebar.openNativeProjectEditDialog,
});

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
  api.log?.info?.("Projects service ready");
}

function startRenderer(api) {
  let latestState = null;
  let latestRevision = null;
  let latestNativeProjects = [];
  let latestSurfaceFingerprint = null;
  let aliasRefreshRequest = 0;
  let selectedSettingsProjectId = null;
  const apply = () => sidebar.applyNativeProjectColors(api, latestState);
  const acceptResponse = (response) => {
    if (!response?.ok) return false;
    if (Array.isArray(response.nativeProjects)) latestNativeProjects = response.nativeProjects;
    latestState = state.bindNativeProjectIdentities(response.state, latestNativeProjects);
    latestRevision = response.revision;
    window.dispatchEvent(new CustomEvent("tweaker:projects-state-ready"));
    return true;
  };
  const saveAppearance = async (projectId, choice) => {
    if (!latestState || !projectId) return;
    try {
      const nodes = latestState.nodes.map((node) => node.id === projectId ? { ...node, ...choice } : node);
      const response = await api.ipc.invoke(IPC, {
        action: "save",
        state: { ...latestState, nodes },
        baseRevision: latestRevision,
      });
      if (!response?.ok) {
        api.log?.warn?.("project appearance save failed", response?.error?.code || "unknown");
        window.alert("Could not save the project color.");
        return;
      }
      latestState = state.bindNativeProjectIdentities(response.state, latestNativeProjects);
      latestRevision = response.revision;
      apply();
      window.dispatchEvent(new CustomEvent("tweaker:projects-color-change", { detail: { projectId } }));
    } catch (error) {
      api.log?.warn?.("project appearance save failed", String(error));
      window.alert("Could not save the project color.");
    }
  };
  const removeRevision = api.ipc.on?.("revision", (payload) => {
    if (typeof payload?.revision === "string" && /^[a-f0-9]{32}$/.test(payload.revision)) {
      window.dispatchEvent(new CustomEvent("tweaker:projects-revision", { detail: { revision: payload.revision } }));
    }
  });
  const handle = api.settings.registerPage({
    id: "projects",
    title: "Projects",
    description: "Organize the projects shown in your ChatGPT sidebar.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-sm inline-block shrink-0 align-middle" aria-hidden="true"><path d="M2.5 5.5h6l1.5 2h7.5v7.5a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V5.5Z" stroke="currentColor" stroke-width="1.5"/></svg>',
    render(root) {
      return settingsPresenter.renderProjectsPage(api, root, (nextState, revision, nativeProjects) => {
        if (Array.isArray(nativeProjects)) latestNativeProjects = nativeProjects;
        latestState = state.bindNativeProjectIdentities(nextState, latestNativeProjects);
        latestRevision = revision;
        apply();
      }, () => selectedSettingsProjectId, (projectId) => { selectedSettingsProjectId = projectId; });
    },
  });
  api.ipc.invoke(IPC, { action: "get" }).then((response) => {
    if (acceptResponse(response)) apply();
  }).catch(() => {});
  const removeHostObserver = api.react?.host?.observe?.(["projects"], () => {
    apply();
    const fingerprint = sidebar.nativeProjectSurfaceFingerprint(api);
    if (fingerprint === latestSurfaceFingerprint) return;
    latestSurfaceFingerprint = fingerprint;
    const request = ++aliasRefreshRequest;
    api.ipc.invoke(IPC, { action: "get" }).then((response) => {
      if (request === aliasRefreshRequest && acceptResponse(response)) apply();
    }).catch(() => {});
  });
  const removeColorControls = sidebar.installProjectColorControls(api, () => latestState, saveAppearance);
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
      aliasRefreshRequest += 1;
      removeRevision?.();
      removeHostObserver?.();
      removeColorControls?.();
      removeEditProjectControls?.();
      sidebar.removeProjectColorArtifacts();
      handle.unregister?.();
    },
  };
}

const tweak = {
  start(api) {
    if (api.process === "main") return startMain(api);
    const page = startRenderer(api);
    this._page = page;
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
    }
    this._page?.unregister?.();
    this._page = null;
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
    ...sidebar,
    projectAppearanceEditor: settings.projectAppearanceEditor,
    branchInventoryDisclosure: settings.branchInventoryDisclosure,
    createInventoryLoader: settings.createInventoryLoader,
    editProjectDialogCandidates: settings.editProjectDialogCandidates,
    installEditProjectDialogControls: settings.installEditProjectDialogControls,
  },
};

module.exports = tweak;
