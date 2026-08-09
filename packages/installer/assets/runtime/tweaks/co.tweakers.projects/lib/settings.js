"use strict";

const { isRecord, titleCase } = require("./common");
const {
  CONNECTION_TYPES,
  PROJECT_COLOR_OPTIONS,
  PROJECT_OVERLAY_OPTIONS,
  autoColor,
  bindNativeProjectIdentities,
  chromeProfileDisplayName,
  projectForNativeIdentity,
  projectNativeNames,
  seedProjectsFromNativeSurface,
  updateChromeProfileAssignment,
} = require("./state");

const IPC = "projects";

function createSettingsPresenter(dependencies = {}) {
  const openNativeProjectEditDialog = typeof dependencies.openNativeProjectEditDialog === "function"
    ? dependencies.openNativeProjectEditDialog
    : () => {};
  return {
    renderProjectsPage(api, root, onState, getSelectedProjectId, setSelectedProjectId) {
      return renderProjectsPage(openNativeProjectEditDialog, api, root, onState, getSelectedProjectId, setSelectedProjectId);
    },
    installProjectSettingsSurface,
    installEditProjectDialogControls,
    projectAppearanceEditor,
    branchInventoryDisclosure,
  };
}

function renderProjectsPage(openNativeProjectEditDialog, api, root, onState, getSelectedProjectId, setSelectedProjectId) {
  let disposed = false;
  let latestResponse = null;
  const inventoryLoader = createInventoryLoader(api, root);
  const removeSurfaceStyle = installProjectSettingsSurface(root);
  root.textContent = "Loading projects…";
  const selectProject = (projectId) => {
    inventoryLoader.cancel();
    setSelectedProjectId?.(projectId);
    if (latestResponse) renderState(openNativeProjectEditDialog, api, root, latestResponse, load, {
      selectedProjectId: projectId,
      selectProject,
      inventoryLoader,
    });
  };
  const load = () => api.ipc.invoke(IPC, { action: "get" }).then((response) => {
    if (disposed) return;
    const matches = api.react?.host?.query?.("projects") || [];
    const seeded = response?.ok && response.state.nodes.length === 0
      ? seedProjectsFromNativeSurface(matches, response.nativeProjects)
      : null;
    if (seeded?.nodes?.length) {
      return api.ipc.invoke(IPC, { action: "save", state: seeded, baseRevision: response.revision }).then(load);
    }
    const displayResponse = response?.ok
      ? { ...response, state: bindNativeProjectIdentities(response.state, response.nativeProjects) }
      : response;
    if (displayResponse?.ok) onState?.(displayResponse.state, displayResponse.revision, displayResponse.nativeProjects);
    latestResponse = displayResponse;
    renderState(openNativeProjectEditDialog, api, root, displayResponse, load, {
      selectedProjectId: getSelectedProjectId?.(),
      selectProject,
      inventoryLoader,
    });
  }).catch(() => { if (!disposed) root.textContent = "Projects are unavailable."; });
  const onColorChange = () => void load();
  window.addEventListener("tweaker:projects-color-change", onColorChange);
  void load();
  return () => {
    disposed = true;
    inventoryLoader.cancel();
    window.removeEventListener("tweaker:projects-color-change", onColorChange);
    removeSurfaceStyle();
    root.textContent = "";
  };
}

function createInventoryLoader(api, root) {
  let active = null;
  const cancel = () => {
    const current = active;
    active = null;
    current?.removeProgress?.();
    if (!current) return Promise.resolve({ ok: true, cancelled: false });
    if (current.kind === "github") removeInventoryProgress(current.host);
    return Promise.resolve().then(() => api.ipc.invoke(IPC, {
      action: "inventory.cancel",
      projectId: current.projectId,
      requestId: current.requestId,
    })).catch(() => ({ ok: false, cancelled: false }));
  };
  const start = (kind, project, host, context = {}) => {
    const cancelled = cancel();
    const requestId = makeId(kind === "github" ? "github" : "inventory");
    const progress = (payload) => {
      if (active?.requestId !== requestId || payload?.requestId !== requestId || !mountIsCurrent(root, host)) return;
      renderInventoryProgress(host, payload);
    };
    const removeProgress = api.ipc.on?.("inventory.progress", progress);
    active = { projectId: project.id, requestId, kind, host, removeProgress };
    renderInventoryProgress(host, kind === "github"
      ? { provider: "github", phase: "github", status: "refreshing", completed: 0, total: null }
      : { phase: "discovering", status: "scanning", completed: 0, total: null });
    const message = kind === "github"
      ? { action: "inventory.refresh-github", projectId: project.id, requestId, refresh: context.refresh === true }
      : { action: "inventory.get", projectId: project.id, requestId, refresh: context.refresh === true };
    return cancelled.then(() => {
      if (active?.requestId !== requestId || !mountIsCurrent(root, host)) return null;
      return api.ipc.invoke(IPC, message);
    }).then((result) => {
      if (active?.requestId !== requestId || !mountIsCurrent(root, host)) return;
      removeProgress?.();
      active = null;
      if (kind === "github") {
        removeInventoryProgress(host);
        if (result?.status !== "cancelled") renderGitHubBranchInventory(host, result);
        return result;
      }
      if (!result?.ok) return renderInventoryError(host, result?.error?.code, context.repair);
      renderProjectInventory(api, host, project, result, {
        refresh: () => load(project, host, { refresh: true, repair: context.repair }),
        refreshGitHub: () => refreshGitHub(project, host, result, { repair: context.repair }),
      });
      return result;
    }).catch(() => {
      if (active?.requestId !== requestId || !mountIsCurrent(root, host)) return;
      removeProgress?.();
      active = null;
      if (kind === "github") {
        removeInventoryProgress(host);
        renderGitHubBranchInventory(host, null);
        return;
      }
      renderInventoryError(host, "inventory-unavailable", context.repair);
    });
  };
  const load = (project, host, options = {}) => start("inventory", project, host, options);
  const refreshGitHub = (project, host, inventory, options = {}) => start("github", project, host, { ...options, inventory });
  return { load, refreshGitHub, cancel };
}

function mountIsCurrent(root, host) {
  return root && host && root.isConnected !== false && host.isConnected !== false;
}

function renderInventoryProgress(host, payload) {
  const completed = Number.isInteger(payload?.completed) ? payload.completed : 0;
  const total = Number.isInteger(payload?.total) ? ` of ${payload.total}` : "";
  if (payload?.provider === "github") {
    let status = host.querySelector?.("[data-tweaker-project-inventory-progress]");
    if (!status) {
      status = element("div", "mt-2 text-sm text-token-text-secondary", "");
      status.setAttribute("data-tweaker-project-inventory-progress", "github");
      host.append(status);
    }
    const remote = typeof payload?.remote === "string" && payload.remote ? ` · ${payload.remote}` : "";
    const phase = payload?.status === "cancelled"
      ? "GitHub branch refresh cancelled"
      : payload?.phase === "github-auth"
        ? "Connecting to GitHub"
        : "Refreshing GitHub branches";
    status.textContent = `${phase}${remote}… ${completed}${total}`;
    return;
  }
  const phase = payload?.phase === "inspecting" ? "Inspecting repositories" : "Scanning attached folders";
  host.textContent = `${phase}… ${completed}${total}`;
}

function removeInventoryProgress(host) {
  host?.querySelector?.("[data-tweaker-project-inventory-progress]")?.remove?.();
}

function renderInventoryError(host, code, repair) {
  host.textContent = "";
  if (code === "project-unbound") {
    host.append(element("div", "text-sm text-token-text-secondary", "This project needs a primary folder before repository inventory can run."));
    host.append(button("Repair folder", () => repair?.()));
    return;
  }
  host.textContent = "Repository inventory is unavailable.";
}

function installProjectSettingsSurface(root) {
  root.setAttribute?.("data-tweaker-project-settings-page", "true");
  const surface = root.closest?.(".main-surface");
  const addedSurfaceClass = !!surface && !surface.classList.contains("bg-token-main-surface-primary");
  if (addedSurfaceClass) surface.classList.add("bg-token-main-surface-primary");
  const previousRootBackground = root.style?.getPropertyValue?.("background-color") || "";
  const previousSurfaceBackground = surface?.style?.getPropertyValue?.("background-color") || "";
  const opaqueBackground = "var(--color-token-main-surface-primary, var(--color-background-primary, #fff))";
  root.style?.setProperty?.("background-color", opaqueBackground, "important");
  surface?.style?.setProperty?.("background-color", opaqueBackground, "important");
  return () => {
    root.removeAttribute?.("data-tweaker-project-settings-page");
    if (addedSurfaceClass) surface?.classList.remove("bg-token-main-surface-primary");
    if (previousRootBackground) root.style?.setProperty?.("background-color", previousRootBackground);
    else root.style?.removeProperty?.("background-color");
    if (previousSurfaceBackground) surface?.style?.setProperty?.("background-color", previousSurfaceBackground);
    else surface?.style?.removeProperty?.("background-color");
  };
}

function renderState(openNativeProjectEditDialog, api, root, response, reload, view = {}) {
  root.textContent = "";
  if (!response?.ok) { root.textContent = "Projects are unavailable."; return; }
  const state = response.state;
  const revision = response.revision;
  const selected = state.nodes.find((node) => node.type === "project" && node.id === view.selectedProjectId);
  if (selected) {
    renderProjectDetail(openNativeProjectEditDialog, api, root, response, selected, reload, revision, view);
    return;
  }
  const heading = element("div", "flex items-center justify-end gap-3");
  const actions = element("div", "flex gap-2");
  actions.append(button("Add group", () => addNode(api, state, "group", reload, revision)), button("Add project", () => addNode(api, state, "project", reload, revision)));
  heading.append(actions);
  root.append(heading);
  const overview = element("div", "mt-4 grid grid-cols-1 gap-2");
  for (const project of state.nodes.filter((node) => node.type === "project")) {
    const card = button("", () => view.selectProject?.(project.id));
    card.className = "border-token-border hover:bg-token-foreground/5 flex w-full items-center gap-3 rounded-lg border p-3 text-left cursor-interaction";
    const swatch = element("span", "size-3 shrink-0 rounded-full");
    swatch.style.backgroundColor = project.color;
    const copy = element("span", "flex min-w-0 flex-1 flex-col gap-1");
    copy.append(element("span", "truncate text-sm font-medium text-token-text-primary", project.name));
    copy.append(element("span", "truncate text-sm text-token-text-secondary", project.projectPath || "Needs folder repair — open to repair"));
    card.append(swatch, copy, element("span", "text-token-text-secondary", "›"));
    overview.append(card);
  }
  if (!overview.childElementCount) overview.append(element("div", "text-sm text-token-text-secondary", "No projects yet."));
  root.append(overview, settingsSectionTitle("Available connections", "Local adapters that can be assigned to projects."), connectionCard(response.connections));
  const tree = element("div", "border-token-border mt-4 rounded-lg border");
  renderChildren(api, tree, state, null, response.connections, reload, 0, revision);
  if (!state.nodes.length) tree.append(element("div", "p-3 text-sm text-token-text-secondary", "No projects yet."));
  root.append(tree);
}

function settingsSectionTitle(title, description) {
  const row = element("div", "mt-5 flex h-toolbar items-center justify-between gap-2");
  const inner = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  inner.append(element("div", "text-base font-medium text-token-text-primary", title));
  if (description) inner.append(element("div", "text-sm text-token-text-secondary", description));
  row.append(inner);
  return row;
}

function detailsCard() {
  return element("div", "border-token-border bg-token-main-surface-primary flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border");
}

function detailRow(label, value, action) {
  const row = element("div", "flex items-center justify-between gap-4 p-3");
  const copy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
  copy.append(element("div", "text-sm text-token-text-primary", label));
  copy.append(element("div", "break-all text-sm text-token-text-secondary", value || "Not configured"));
  row.append(copy);
  if (action) row.append(action);
  return row;
}

function renderProjectDetail(openNativeProjectEditDialog, api, root, response, project, reload, revision, view) {
  const back = button("‹ All projects", () => view.selectProject?.(null));
  back.className = "mb-2 inline-flex items-center text-sm text-token-text-link-foreground hover:underline cursor-interaction";
  const title = element("div", "flex items-center justify-between gap-3");
  const name = element("div", "flex min-w-0 items-center gap-2 text-lg font-medium text-token-text-primary");
  const swatch = element("span", "size-3 shrink-0 rounded-full");
  swatch.style.backgroundColor = project.color;
  name.append(swatch, element("span", "truncate", project.name));
  const nativeEdit = button("Edit in Codex", () => openNativeProjectEditDialog(project));
  title.append(name, nativeEdit);
  root.append(back, title);

  root.append(settingsSectionTitle("Project details", "Codex owns the project name and source folders."));
  const nativeCard = detailsCard();
  nativeCard.append(detailRow("Name", project.name));
  nativeCard.append(detailRow("Primary folder", project.projectPath || project.nativeProjectPaths?.[0]));
  if (!project.projectPath) nativeCard.append(detailRow("Binding", "No primary folder is stored.", button("Repair folder", () => repairProjectPath(api, response.state, project, reload, revision))));
  const sourceFolders = [...new Set([project.projectPath, ...(project.nativeProjectPaths || [])].filter(Boolean))];
  nativeCard.append(detailRow("Source folders", sourceFolders.join("\n") || "No source folders found", nativeEdit.cloneNode(true)));
  nativeCard.lastElementChild?.lastElementChild?.addEventListener?.("click", () => openNativeProjectEditDialog(project));
  root.append(nativeCard);

  root.append(settingsSectionTitle("Appearance", "The same project color and task tint controls used in the sidebar menu."));
  const appearance = detailsCard();
  const appearanceRow = element("div", "p-3");
  appearanceRow.append(projectAppearanceEditor(project, (choice) => updateProjectAppearance(api, response.state, project.id, choice, revision, reload)));
  appearance.append(appearanceRow);
  root.append(appearance);

  root.append(settingsSectionTitle("Connections", "Assigned identities and non-secret signals detected in this project."));
  const connectionDetails = detailsCard();
  for (const type of CONNECTION_TYPES) {
    const reference = project.connections?.[type];
    const refs = response.connections?.[type]?.refs || [];
    const control = button(reference ? "Change" : "Assign", () => assignConnection(api, response.state, project, type, refs, reload, revision));
    connectionDetails.append(detailRow(titleCase(type), reference ? (type === "chrome" ? chromeProfileDisplayName(reference) : reference) : response.connections?.[type]?.status, control));
  }
  root.append(connectionDetails);

  root.append(settingsSectionTitle("Repositories, worktrees, and branches", "Read-only local Git inventory. GitHub branches load only when you refresh them."));
  const inventoryHost = element("div", "text-sm text-token-text-secondary");
  root.append(inventoryHost);
  view.inventoryLoader?.load(project, inventoryHost, { repair: () => repairProjectPath(api, response.state, project, reload, revision) });
}

function renderProjectInventory(api, host, project, inventory, view = {}) {
  host.textContent = "";
  if (inventory.partial) {
    const partial = detailsCard();
    partial.append(detailRow("Partial inventory", (inventory.errors || []).map((error) => error.code || error).filter(Boolean).join(", ") || "The scan reached a safe limit."));
    host.append(partial);
  }
  if (inventory.detectedConnections?.length) {
    const detected = detailsCard();
    for (const signal of inventory.detectedConnections) detected.append(detailRow(`Detected ${titleCase(signal.type)}`, signal.detail || signal.label));
    host.append(detected);
  }
  const actions = element("div", "my-3 flex items-center justify-between gap-3");
  actions.append(element("span", "text-sm text-token-text-secondary", `${inventory.repositories.length} local repositor${inventory.repositories.length === 1 ? "y" : "ies"}${inventory.truncated ? " (limit reached)" : ""} · scanned ${formatInventoryTime(inventory.refreshedAt)}`));
  const controls = element("div", "flex shrink-0 gap-2");
  controls.append(button("Rescan", () => view.refresh?.()));
  const refresh = button("Refresh GitHub branches", () => view.refreshGitHub?.());
  controls.append(refresh);
  actions.append(controls);
  host.append(actions);
  for (const repo of inventory.repositories) {
    const card = detailsCard();
    card.classList.add("mb-3");
    const repositoryHeader = element("div", "flex items-start justify-between gap-4 p-3");
    const repositoryCopy = element("div", "flex min-w-0 flex-1 flex-col gap-1");
    repositoryCopy.append(element("div", "text-sm font-medium text-token-text-primary", "Repository"));
    repositoryCopy.append(element("div", "break-all text-sm text-token-text-secondary", repo.root));
    const head = element("code", "border-token-border bg-token-foreground/5 shrink-0 rounded-md border px-2 py-1 text-xs text-token-text-secondary", repo.error || String(repo.head || "unknown").slice(0, 12));
    head.title = repo.error ? "Repository error" : "HEAD commit";
    repositoryHeader.append(repositoryCopy, head);
    card.append(repositoryHeader);
    const worktreeSection = element("div", "flex flex-col");
    worktreeSection.append(element("div", "px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-token-text-secondary", `Worktrees · ${(repo.worktrees || []).length}`));
    for (const worktree of repo.worktrees || []) {
      const status = [worktree.branch || (worktree.detached ? "detached" : worktree.head), worktree.locked ? `locked${typeof worktree.locked === "string" ? `: ${worktree.locked}` : ""}` : null, worktree.prunable ? `prunable${typeof worktree.prunable === "string" ? `: ${worktree.prunable}` : ""}` : null].filter(Boolean).join(" · ");
      const row = element("div", "flex items-center justify-between gap-3 px-3 py-2");
      row.append(element("div", "min-w-0 break-all text-sm text-token-text-primary", worktree.path));
      row.append(element("span", "border-token-border bg-token-foreground/5 max-w-[45%] shrink-0 truncate rounded-full border px-2 py-0.5 text-xs text-token-text-secondary", status || "detached"));
      worktreeSection.append(row);
    }
    if (!(repo.worktrees || []).length) worktreeSection.append(element("div", "px-3 pb-3 text-sm text-token-text-secondary", "No worktrees found."));
    card.append(worktreeSection);
    card.append(branchInventoryDisclosure("Local branches", repo.localBranches || [], { open: (repo.localBranches || []).length <= 8 }));
    card.append(branchInventoryDisclosure("Remote-tracking branches", repo.remoteTrackingBranches || []));
    host.append(card);
  }
}

function branchInventoryDisclosure(label, branches, options = {}) {
  const disclosure = document.createElement("details");
  disclosure.className = "group/branches";
  disclosure.open = !!options.open;
  disclosure.setAttribute("data-tweaker-branch-inventory", "true");
  const summary = element("summary", "hover:bg-token-foreground/5 flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm text-token-text-primary cursor-interaction");
  summary.append(element("span", "font-medium", label));
  const summaryMeta = element("span", "flex items-center gap-2 text-token-text-secondary");
  summaryMeta.append(element("span", "rounded-full bg-token-foreground/5 px-2 py-0.5 text-xs", String(branches.length)));
  summaryMeta.append(element("span", "text-xs group-open/branches:rotate-90", "›"));
  summary.append(summaryMeta);
  disclosure.append(summary);
  const list = element("div", "border-token-border max-h-72 overflow-y-auto border-t");
  if (!branches.length) list.append(element("div", "px-3 py-2 text-sm text-token-text-secondary", "None"));
  for (const branch of branches) {
    const row = element("div", "border-token-border flex items-start justify-between gap-3 border-b px-3 py-2 last:border-b-0");
    const copy = element("div", "flex min-w-0 flex-1 flex-col gap-0.5");
    const name = element("div", "flex min-w-0 items-center gap-2");
    if (branch.current) name.append(element("span", "size-2 shrink-0 rounded-full bg-token-text-link-foreground", ""));
    name.append(element("code", "min-w-0 break-all text-xs text-token-text-primary", branch.name));
    copy.append(name);
    if (branch.upstream) copy.append(element("div", "break-all text-xs text-token-text-secondary", `Tracks ${branch.upstream}`));
    const sha = element("code", "shrink-0 text-xs text-token-text-secondary", String(branch.sha || "unknown").slice(0, 12));
    row.append(copy, sha);
    list.append(row);
  }
  disclosure.append(list);
  return disclosure;
}

function renderGitHubBranchInventory(host, result) {
  host.querySelector?.("[data-tweaker-github-branches]")?.remove?.();
  const section = detailsCard();
  section.dataset.tweakerGithubBranches = "true";
  if (!result?.ok) section.append(detailRow("GitHub", result?.error?.code || "Unavailable"));
  else {
    section.append(detailRow("GitHub refreshed", formatInventoryTime(result.refreshedAt)));
    if (result.partial) section.append(detailRow("GitHub refresh", "Partial results"));
    for (const remote of result.remotes || []) {
      if (remote.error) section.append(detailRow(`${remote.host}/${remote.slug}`, remote.error));
      else section.append(branchInventoryDisclosure(`${remote.host}/${remote.slug}`, remote.branches || []));
    }
  }
  host.prepend(section);
}

function formatInventoryTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function connectionCard(connections) {
  const card = element("div", "border-token-border mt-4 grid grid-cols-1 divide-y-[0.5px] divide-token-border rounded-lg border");
  for (const type of CONNECTION_TYPES) {
    const row = element("div", "flex items-center justify-between gap-4 p-3");
    row.append(element("span", "text-sm text-token-text-primary", titleCase(type)));
    const status = connections[type]?.status || "error";
    const badge = element("span", "text-sm text-token-text-secondary", status);
    badge.setAttribute("aria-label", `${titleCase(type)} ${status}`);
    row.append(badge);
    card.append(row);
  }
  return card;
}

function renderChildren(api, root, state, parentId, connections, reload, depth, revision) {
  const siblings = state.nodes.filter((item) => item.parentId === parentId);
  for (const [siblingIndex, node] of siblings.entries()) {
    const row = element("div", "flex items-center gap-3 p-3");
    row.style.paddingLeft = `${12 + depth * 20}px`;
    const icon = element("span", "w-5 shrink-0 text-center", node.icon.kind === "emoji" ? node.icon.value : "◈");
    icon.style.color = node.color;
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", node.icon.kind === "emoji" ? "Project icon" : `Iconify ${node.icon.value}`);
    if (node.icon.kind === "iconify") { icon.classList.add("iconify"); icon.dataset.icon = node.icon.value; }
    row.append(icon, element("span", "min-w-0 flex-1 truncate text-sm text-token-text-primary", node.name));
    row.append(button("Edit", () => editNode(api, state, node, reload, revision)));
    const up = button("↑", () => moveNode(api, state, siblings, siblingIndex, -1, reload, revision));
    up.title = `Move ${node.name} up`;
    up.disabled = siblingIndex === 0;
    const down = button("↓", () => moveNode(api, state, siblings, siblingIndex, 1, reload, revision));
    down.title = `Move ${node.name} down`;
    down.disabled = siblingIndex === siblings.length - 1;
    row.append(up, down);
    if (node.type === "project") row.append(projectAppearanceControls(api, state, node, reload, revision));
    else {
      const color = document.createElement("input");
      color.type = "color";
      color.value = node.color;
      color.title = `Color for ${node.name}`;
      color.setAttribute("aria-label", `Color for ${node.name}`);
      color.className = "h-7 w-7 cursor-pointer rounded-md border-0 bg-transparent p-0";
      color.addEventListener("change", () => updateProjectAppearance(api, state, node.id, { color: color.value }, revision, reload));
      row.append(color);
    }
    if (node.type === "project") {
      for (const type of CONNECTION_TYPES) {
        const control = button(connectionButtonLabel(node, type), () => assignConnection(api, state, node, type, connections[type]?.refs || [], reload, revision));
        if (type === "chrome") control.title = "Set, replace, or remove this project's Chrome profile";
        row.append(control);
      }
    }
    root.append(row);
    if (node.type === "group") renderChildren(api, root, state, node.id, connections, reload, depth + 1, revision);
  }
}

function projectAppearanceControls(api, state, project, reload, revision) {
  const details = document.createElement("details");
  details.className = "relative";
  const summary = element("summary", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 cursor-pointer rounded-md border px-2 py-1 text-sm text-token-text-primary", "Color");
  details.appendChild(summary);
  const panel = element("div", "border-token-border absolute right-0 z-50 mt-1 w-64 rounded-lg border p-2 shadow-lg");
  panel.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
  panel.append(projectAppearanceEditor(project, (choice) => updateProjectAppearance(api, state, project.id, choice, revision, reload)));
  details.appendChild(panel);
  return details;
}

function projectAppearanceEditor(project, onChange) {
  const panel = element("div", "flex flex-col gap-4");
  panel.setAttribute("data-tweaker-project-appearance-editor", "true");
  const colorSection = element("div", "flex flex-col gap-2");
  colorSection.appendChild(element("div", "text-sm font-medium text-token-text-primary", "Project color"));
  const palette = element("div", "flex flex-wrap items-center gap-2");
  palette.setAttribute("role", "group");
  palette.setAttribute("aria-label", `Project color for ${project.name}`);
  const auto = button("Auto", () => onChange?.({ colorMode: "auto", color: autoColor(project.projectPath || project.id) }));
  auto.title = "Auto project color";
  auto.setAttribute("aria-pressed", String(project.colorMode === "auto"));
  auto.className = "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-8 shrink-0 rounded-md border px-3 text-sm text-token-text-primary cursor-interaction aria-pressed:ring-2 aria-pressed:ring-token-focus-border";
  palette.appendChild(auto);
  for (const option of PROJECT_COLOR_OPTIONS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.title = option.label;
    swatch.setAttribute("aria-label", `${option.label} project color`);
    swatch.setAttribute("aria-pressed", String(project.colorMode === "manual" && String(project.color).toLowerCase() === option.value.toLowerCase()));
    swatch.className = "border-token-border h-7 w-7 shrink-0 rounded-full border cursor-interaction aria-pressed:ring-2 aria-pressed:ring-token-focus-border aria-pressed:ring-offset-1";
    swatch.style.backgroundColor = option.value;
    swatch.addEventListener("click", () => onChange?.({ colorMode: "manual", color: option.value }));
    palette.appendChild(swatch);
  }
  const custom = document.createElement("input");
  custom.type = "color";
  custom.value = project.color;
  custom.title = `Custom color for ${project.name}`;
  custom.setAttribute("aria-label", `Custom color for ${project.name}`);
  custom.setAttribute("data-tweaker-project-custom-color", "true");
  custom.className = "border-token-border h-8 w-8 shrink-0 cursor-pointer rounded-full border bg-transparent p-0";
  custom.addEventListener("change", () => onChange?.({ colorMode: "manual", color: custom.value }));
  palette.appendChild(custom);
  colorSection.appendChild(palette);
  panel.appendChild(colorSection);
  const tintSection = element("div", "flex flex-col gap-2");
  tintSection.appendChild(element("div", "text-sm font-medium text-token-text-primary", "Task tint"));
  const overlays = element("div", "border-token-border bg-token-foreground/5 flex items-center gap-1 rounded-lg border p-1");
  overlays.setAttribute("role", "group");
  overlays.setAttribute("aria-label", `Task tint for ${project.name}`);
  for (const intensity of PROJECT_OVERLAY_OPTIONS) {
    const control = button(titleCase(intensity), () => onChange?.({ overlayIntensity: intensity }));
    control.setAttribute("aria-pressed", String(project.overlayIntensity === intensity));
    control.className = "hover:bg-token-foreground/10 flex-1 rounded-md border-0 bg-transparent px-2 py-1 text-sm text-token-text-primary cursor-interaction aria-pressed:bg-token-main-surface-primary aria-pressed:shadow-sm";
    overlays.appendChild(control);
  }
  tintSection.appendChild(overlays);
  panel.appendChild(tintSection);
  return panel;
}

function updateProjectAppearance(api, state, projectId, choice, revision, reload) {
  const nodes = state.nodes.map((item) => item.id === projectId ? { ...item, ...choice } : item);
  applySave(api, { ...state, nodes }, revision, reload);
}

function applySave(api, nextState, baseRevision, reload) {
  api.ipc.invoke(IPC, { action: "save", state: nextState, baseRevision }).then((response) => {
    if (response?.ok) { reload(); return; }
    const code = response?.error?.code;
    if (code === "stale-revision") { window.alert("This project list changed in another window. Reloading the latest version."); reload(); return; }
    api?.log?.warn?.("projects save failed", code || "unknown");
    window.alert(code ? `Could not save changes (${code}).` : "Could not save changes.");
  }).catch((error) => {
    api?.log?.warn?.("projects save failed", String(error));
    window.alert("Could not save changes.");
  });
}

function addNode(api, state, type, reload, revision) {
  const name = window.prompt(type === "group" ? "Group name" : "Project name");
  if (!name) return;
  const parentId = window.prompt("Parent group ID (leave blank for top level)", "") || null;
  const rawIcon = window.prompt("Emoji or Iconify name (example: lucide:folder)", type === "group" ? "📁" : "📌") || "📁";
  const icon = rawIcon.includes(":") ? { kind: "iconify", value: rawIcon } : { kind: "emoji", value: rawIcon };
  const node = { id: makeId(type), type, parentId, name, icon, connections: {} };
  if (type === "project") {
    node.colorMode = "auto";
    node.overlayIntensity = "medium";
    node.projectPath = window.prompt("Local project path (optional)", "") || undefined;
    node.githubRepo = window.prompt("GitHub repository (owner/name, optional)", "") || undefined;
  } else node.color = "#6b7280";
  applySave(api, { ...state, nodes: [...state.nodes, node] }, revision, reload);
}

function editNode(api, state, node, reload, revision) {
  const name = window.prompt(`${titleCase(node.type)} name`, node.name);
  if (!name) return;
  const parentId = window.prompt("Parent group ID (leave blank for top level)", node.parentId || "") || null;
  const rawIcon = window.prompt("Emoji or Iconify name", node.icon.value) || node.icon.value;
  const icon = rawIcon.includes(":") ? { kind: "iconify", value: rawIcon } : { kind: "emoji", value: rawIcon };
  const updated = { ...node, name, parentId, icon };
  if (node.type === "project") {
    updated.projectPath = window.prompt("Local project path (optional)", node.projectPath || "") || undefined;
    updated.githubRepo = window.prompt("GitHub repository (owner/name, optional)", node.githubRepo || "") || undefined;
  }
  applySave(api, { ...state, nodes: state.nodes.map((item) => item.id === node.id ? updated : item) }, revision, reload);
}

function repairProjectPath(api, state, project, reload, revision) {
  const value = window.prompt("Primary local project folder", project.projectPath || "");
  if (value === null) return;
  const nodes = state.nodes.map((node) => node.id === project.id ? { ...node, projectPath: value.trim() || undefined } : node);
  applySave(api, { ...state, nodes }, revision, reload);
}

function moveNode(api, state, siblings, index, offset, reload, revision) {
  const other = siblings[index + offset];
  const node = siblings[index];
  if (!node || !other) return;
  const nodes = [...state.nodes];
  const from = nodes.findIndex((item) => item.id === node.id);
  const to = nodes.findIndex((item) => item.id === other.id);
  [nodes[from], nodes[to]] = [nodes[to], nodes[from]];
  applySave(api, { ...state, nodes }, revision, reload);
}

function assignGitHub(api, state, project, refs, reload, revision) {
  if (!refs.length) { window.alert("No configured GitHub identities were found."); return; }
  const choices = refs.map((ref, index) => `${index + 1}. ${ref.label}${ref.active ? " (active)" : ""}`).join("\n");
  const selected = Number(window.prompt(`Choose a GitHub identity:\n${choices}`, "1")) - 1;
  if (!refs[selected]) return;
  const nodes = state.nodes.map((node) => node.id === project.id ? { ...node, connections: { ...node.connections, github: refs[selected].id } } : node);
  applySave(api, { ...state, nodes }, revision, reload);
}

function assignConnection(api, state, project, type, refs, reload, revision) {
  if (type === "chrome") return assignChromeProfile(api, state, project, reload, revision);
  if (type === "github") return assignGitHub(api, state, project, refs, reload, revision);
  if (!refs.length) { window.alert(`No configured ${titleCase(type)} references were found.`); return; }
  const choices = refs.map((ref, index) => `${index + 1}. ${ref.label}`).join("\n");
  const selected = Number(window.prompt(`Choose ${titleCase(type)}:\n${choices}`, "1")) - 1;
  if (!refs[selected]) return;
  const nodes = state.nodes.map((node) => node.id === project.id ? { ...node, connections: { ...node.connections, [type]: refs[selected].id } } : node);
  applySave(api, { ...state, nodes }, revision, reload);
}

function connectionButtonLabel(project, type) {
  if (type !== "chrome") return titleCase(type);
  const reference = project.connections?.chrome;
  return reference ? `Chrome: ${chromeProfileDisplayName(reference)}` : "Set Chrome profile";
}

function assignChromeProfile(api, state, project, reload, revision) {
  const reference = project.connections?.chrome;
  const current = reference ? chromeProfileDisplayName(reference).replace(/ \(legacy\)$/, "") : "";
  const answer = window.prompt(
    `Chrome profile for ${project.name}\nEnter the friendly profile name shown in Chrome (for example, TRR or THB). Leave blank to remove this assignment.`,
    current,
  );
  if (answer === null) return;
  try { applySave(api, updateChromeProfileAssignment(state, project.id, answer), revision, reload); }
  catch { window.alert("Enter a Chrome profile name with letters or numbers. Spaces and punctuation are normalized safely."); }
}

function projectForEditDialog(api, state, dialog) {
  if (!state?.nodes) return null;
  const projects = state.nodes.filter((node) => node.type === "project");
  const identities = new Set();
  let fiber = api.react?.getFiber?.(dialog) || null;
  for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!isRecord(props)) continue;
    for (const key of ["projectId", "hoverCardProjectId", "id"]) if (typeof props[key] === "string") identities.add(props[key]);
    for (const source of Array.isArray(props.initialSources) ? props.initialSources : []) {
      if (typeof source === "string") identities.add(source);
      else if (isRecord(source)) for (const key of ["path", "rootPath", "id"]) if (typeof source[key] === "string") identities.add(source[key]);
    }
  }
  for (const identity of identities) {
    const project = projectForNativeIdentity(projects, "", identity);
    if (project) return project;
  }
  const values = [...(dialog.querySelectorAll?.("input, [contenteditable='true']") || [])]
    .map((input) => String(input.value || input.textContent || "").trim()).filter(Boolean);
  const normalizedValues = new Set(values.map((value) => value.toLocaleLowerCase()));
  const dialogText = String(dialog.textContent || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const matches = projects.filter((project) => {
    const names = projectNativeNames(project).map((value) => value.toLocaleLowerCase());
    const paths = [project.projectPath, ...(project.nativeProjectPaths || [])].filter(Boolean).map((value) => String(value).toLocaleLowerCase());
    return [...names, ...paths].some((value) => normalizedValues.has(value)) || names.some((name) => dialogText.includes(name));
  });
  return matches.length === 1 ? matches[0] : null;
}

function editProjectDialogCandidates(doc = document) {
  const candidates = new Set(doc.querySelectorAll?.('[role="dialog"], [data-radix-dialog-content], [data-state="open"]') || []);
  for (const heading of doc.querySelectorAll?.("h1, h2, h3, [role=\"heading\"]") || []) {
    if (!/^Edit project$/i.test(String(heading.textContent || "").replace(/\s+/g, " ").trim())) continue;
    let cursor = heading.parentElement;
    for (let depth = 0; cursor && depth < 8; depth += 1, cursor = cursor.parentElement) {
      const buttons = [...(cursor.querySelectorAll?.("button") || [])];
      if (buttons.some((node) => /^Save$/i.test(String(node.textContent || "").trim()))) {
        candidates.add(cursor);
        break;
      }
    }
  }
  const matching = [...candidates].filter((dialog) => {
    const text = String(dialog.textContent || "").replace(/\s+/g, " ").trim();
    const buttons = [...(dialog.querySelectorAll?.("button") || [])];
    return /^Edit project\b/i.test(text) && buttons.some((node) => /^Save$/i.test(String(node.textContent || "").trim()));
  });
  return matching.filter((dialog) => !matching.some((other) => other !== dialog && other.contains?.(dialog)));
}

function dialogCloseButton(dialog) {
  const buttons = [...(dialog.querySelectorAll?.("button") || [])];
  return buttons.find((node) => /^close$/i.test(String(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "").trim()))
    || buttons.find((node) => !String(node.textContent || "").trim() && node.querySelector?.("svg")) || null;
}

function installEditProjectDialogControls(api, getState, saveAppearance, openSettingsProject) {
  if (typeof document === "undefined") return () => {};
  const inject = () => {
    for (const dialog of editProjectDialogCandidates(document)) {
      const project = projectForEditDialog(api, getState?.(), dialog);
      if (project && !dialog.querySelector?.("[data-tweaker-project-dialog-appearance]")) {
        const section = element("section", "border-token-border bg-token-main-surface-primary mx-5 mb-4 flex flex-col rounded-lg border p-3");
        section.dataset.tweakerProjectDialogAppearance = "true";
        section.append(projectAppearanceEditor(project, async (choice) => {
          await saveAppearance?.(project.id, choice);
          section.remove?.();
          inject();
        }));
        const save = [...(dialog.querySelectorAll?.("button") || [])].find((node) => /^Save$/i.test(String(node.textContent || "").trim()));
        const footer = save?.parentElement;
        if (footer?.parentElement) footer.parentElement.insertBefore(section, footer);
        else dialog.append(section);
      }
      if (!dialog.querySelector?.("[data-tweaker-project-settings-button]")) {
        const close = dialogCloseButton(dialog);
        const heading = [...(dialog.querySelectorAll?.("h1, h2, h3, [role=\"heading\"]") || [])]
          .find((node) => /^Edit project$/i.test(String(node.textContent || "").replace(/\s+/g, " ").trim()));
        const placement = close?.parentElement || heading?.parentElement;
        if (!placement) continue;
        const gear = button("", (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          const currentProject = projectForEditDialog(api, getState?.(), dialog);
          void openSettingsProject?.(currentProject?.id || null, dialog);
        });
        gear.dataset.tweakerProjectSettingsButton = "true";
        gear.setAttribute("aria-label", project ? `Open ${project.name} in Settings` : "Open project in Settings");
        gear.title = project ? `Open ${project.name} in Settings` : "Open project in Settings";
        gear.className = "rounded-md p-1 text-token-text-secondary hover:bg-token-foreground/10 cursor-interaction";
        gear.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M8.3 2.8h3.4l.5 1.8 1.6.9 1.8-.5 1.7 3-1.3 1.3v1.8l1.3 1.3-1.7 3-1.8-.5-1.6.9-.5 1.8H8.3l-.5-1.8-1.6-.9-1.8.5-1.7-3L4 11.1V9.3L2.7 8l1.7-3 1.8.5 1.6-.9.5-1.8Z" stroke="currentColor" stroke-width="1.3"/><circle cx="10" cy="10.2" r="2.2" stroke="currentColor" stroke-width="1.3"/></svg>';
        if (close) placement.insertBefore(gear, close);
        else placement.append(gear);
      }
    }
  };
  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("tweaker:projects-state-ready", inject);
  inject();
  return () => {
    observer.disconnect();
    window.removeEventListener("tweaker:projects-state-ready", inject);
    document.querySelectorAll?.("[data-tweaker-project-dialog-appearance], [data-tweaker-project-settings-button]").forEach((node) => node.remove?.());
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action) {
  const node = element("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 rounded-md border px-2 py-1 text-sm text-token-text-primary", text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function makeId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  createSettingsPresenter,
  createInventoryLoader,
  projectAppearanceEditor,
  branchInventoryDisclosure,
  editProjectDialogCandidates,
  dialogCloseButton,
  installEditProjectDialogControls,
};
