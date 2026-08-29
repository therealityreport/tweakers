"use strict";

const { isRecord, titleCase } = require("./common");
const {
  MAX_PINNED_TASK_IDS,
  PROJECT_COLOR_OPTIONS,
  PROJECT_OVERLAY_OPTIONS,
  TASK_SORT_OPTIONS: STATE_TASK_SORT_OPTIONS,
  autoColor,
  projectForNativeIdentity,
  projectNativeNames,
} = require("./state");

const PROJECT_COLOR_MENU_ATTR = "data-tweaker-project-color-menu";
const PROJECT_COLOR_STYLE_ID = "tweaker-project-colors";
const PROJECT_COLOR_DISPOSE = Symbol("projectColorDispose");
const PROJECT_TASK_MENU_ATTR = "data-tweaker-project-task-menu";
const PROJECT_TASK_DISPOSE = Symbol("projectTaskDispose");
const PROJECT_MENU_ATTR = "data-tweaker-project-menu";
const PROJECT_MENU_DISPOSE = Symbol("projectMenuDispose");
const PROJECT_NATIVE_MENU_ATTR = "data-tweaker-project-native-menu";
const NATIVE_TASK_PLACEMENTS = new Map();
const MAX_PROJECT_ROW_END_INSET = 64;
const TASK_SORT_LABELS = {
  "created-desc": "Created newest",
  "created-asc": "Created oldest",
  "updated-desc": "Updated newest",
  "updated-asc": "Updated oldest",
};
const TASK_SORT_OPTIONS = [
  { id: "default", label: "Default", value: undefined },
  ...STATE_TASK_SORT_OPTIONS.map((value) => ({ id: value, label: TASK_SORT_LABELS[value] || value, value })),
];

function normalizeTaskSort(value) {
  return TASK_SORT_OPTIONS.some((option) => option.value === value && option.value) ? value : undefined;
}

function isRemoveProjectMenuItem(item) {
  const label = String(item?.textContent || "").replace(/\s+/g, " ").trim();
  return /^(?:remove|delete)(?: (?:local )?project)?$/i.test(label) || /^remove from\b/i.test(label);
}

function nativeMenuItemRole(item) {
  return String(item?.getAttribute?.("role") || "").toLowerCase();
}

function isNativeMenuCommand(item) {
  const role = nativeMenuItemRole(item);
  const tag = String(item?.tagName || "").toUpperCase();
  return role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio"
    || tag === "BUTTON" || item?.hasAttribute?.("data-radix-collection-item");
}

function nativeMenuCommandLabel(item) {
  const text = String(item?.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text;
  for (const attribute of ["aria-label", "title", "data-label"]) {
    const value = String(item?.getAttribute?.(attribute) || "").replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return "Untitled command";
}

function nativeMenuCommandIcon(item) {
  return item?.querySelector?.('svg, img, [data-slot="icon"]') || null;
}

function nativeMenuCommandRole(item) {
  const role = nativeMenuItemRole(item);
  return role === "menuitemcheckbox" || role === "menuitemradio" ? role : "menuitem";
}

function nativeMenuCommandChecked(item) {
  const value = item?.getAttribute?.("aria-checked");
  return value === "true" || value === "false" || value === "mixed" ? value : null;
}

function isNativeMenuCommandDisabled(item) {
  return item?.disabled === true || item?.hasAttribute?.("disabled")
    || item?.getAttribute?.("aria-disabled") === "true" || item?.getAttribute?.("data-disabled") === "true";
}

// Snapshot real host commands once. The replay closure deliberately retains the
// exact DOM command that Codex opened, rather than trying to infer behavior
// from labels (especially for destructive or future commands).
function snapshotNativeProjectMenuCommands(nativeMenu) {
  const candidateSet = new Set([
    ...(nativeMenu?.querySelectorAll?.('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]') || []),
    ...(nativeMenu?.querySelectorAll?.("button") || []),
    ...(nativeMenu?.querySelectorAll?.("[data-radix-collection-item]") || []),
  ]);
  const descendants = [];
  const visit = (node) => {
    for (const child of node?.children || []) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(nativeMenu);
  const candidates = descendants.filter((item) => candidateSet.has(item) && isNativeMenuCommand(item));
  return candidates
    .filter((item) => !candidates.some((other) => other !== item
      && /^(?:menuitem|menuitemcheckbox|menuitemradio)$/.test(nativeMenuItemRole(other)) && other.contains?.(item)))
    .map((item, order) => ({
      label: nativeMenuCommandLabel(item),
      disabled: isNativeMenuCommandDisabled(item),
      icon: nativeMenuCommandIcon(item),
      role: nativeMenuCommandRole(item),
      ariaChecked: nativeMenuCommandChecked(item),
      order,
      source: item,
      replay() {
        if (this.disabled || this.source?.isConnected === false || typeof this.source?.click !== "function") return false;
        this.source.click();
        return true;
      },
    }));
}

function ownedProjectMenuSubmenuContains(doc, target) {
  return [
    ...(doc?.querySelectorAll?.(`[${PROJECT_COLOR_MENU_ATTR}="submenu"]`) || []),
    ...(doc?.querySelectorAll?.(`[${PROJECT_TASK_MENU_ATTR}="sort-submenu"]`) || []),
  ].some((submenu) => submenu.contains?.(target));
}

function disposeOwnedProjectMenuSubmenus(overlay) {
  const submenus = [
    ...(overlay?.querySelectorAll?.(`[${PROJECT_COLOR_MENU_ATTR}="submenu"]`) || []),
    ...(overlay?.querySelectorAll?.(`[${PROJECT_TASK_MENU_ATTR}="sort-submenu"]`) || []),
  ];
  for (const submenu of submenus) {
    if (typeof submenu[PROJECT_COLOR_DISPOSE] === "function") submenu[PROJECT_COLOR_DISPOSE]();
    else if (typeof submenu[PROJECT_TASK_DISPOSE] === "function") submenu[PROJECT_TASK_DISPOSE]();
    else submenu.remove?.();
  }
}

function projectMenuSubmenuHost(doc, anchor) {
  let cursor = anchor;
  while (cursor) {
    if (["overlay", "settings-submenu"].includes(cursor.getAttribute?.(PROJECT_MENU_ATTR))) return cursor;
    cursor = cursor.parentElement;
  }
  return doc?.body || null;
}

function ownedProjectMenuItem(doc, label, template, onSelect, options = {}) {
  const item = doc.createElement("button");
  item.type = "button";
  item.setAttribute("role", options.role || "menuitem");
  item.setAttribute("tabindex", "-1");
  if (options.ariaChecked !== null && options.ariaChecked !== undefined) item.setAttribute("aria-checked", options.ariaChecked);
  item.className = template?.className || "text-token-text-primary hover:bg-token-foreground/10 flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm cursor-interaction";
  if (options.disabled) {
    item.disabled = true;
    item.setAttribute("disabled", "");
    item.setAttribute("aria-disabled", "true");
  }
  const icon = options.icon?.cloneNode?.(true) || null;
  if (icon) {
    icon.setAttribute?.("aria-hidden", "true");
    icon.classList?.add?.("size-4", "shrink-0");
    item.appendChild(icon);
  }
  const text = doc.createElement("span");
  text.textContent = label;
  text.className = "min-w-0 flex-1 truncate";
  item.appendChild(text);
  if (options.submenu) {
    const chevron = doc.createElement("span");
    chevron.textContent = "›";
    chevron.className = "text-token-text-secondary";
    chevron.setAttribute("aria-hidden", "true");
    item.appendChild(chevron);
  }
  item.addEventListener("click", (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!options.disabled) onSelect?.(event);
  });
  return item;
}

function nativeProjectMenuIsLive(nativeMenu) {
  if (!nativeMenu || nativeMenu.isConnected === false) return false;
  const state = nativeMenu.getAttribute?.("data-state");
  return state === null || state === "open";
}

function projectMenuOverlayPlacement(rect, view) {
  const viewportHeight = Number(view?.innerHeight) || 800;
  const margin = 8;
  const maxHeight = Math.max(1, Math.min(
    Math.max(96, Math.floor(viewportHeight * 0.7)),
    viewportHeight - (margin * 2),
  ));
  // The native portal may fit at its original top edge while the two owned
  // controls do not. Flip the owned surface upward and cap it to the visible
  // viewport so its own scroll container remains reachable.
  const top = Math.max(margin, Math.min(Number(rect?.top) || margin, viewportHeight - maxHeight - margin));
  return { top, maxHeight };
}

function firstDocumentMatch(doc, selector) {
  return doc?.querySelector?.(selector) || doc?.querySelectorAll?.(selector)?.[0] || null;
}

function interceptNativeProjectMenu(doc, nativeMenu, context, handlers = {}) {
  if (!doc?.createElement || !nativeProjectMenuIsLive(nativeMenu) || nativeMenu.hasAttribute?.(PROJECT_NATIVE_MENU_ATTR)) return null;
  const commands = snapshotNativeProjectMenuCommands(nativeMenu);
  if (!commands.length) return null;
  const previous = firstDocumentMatch(doc, `[${PROJECT_MENU_ATTR}="overlay"]`);
  if (typeof previous?.[PROJECT_MENU_DISPOSE] === "function") previous[PROJECT_MENU_DISPOSE]();
  else previous?.remove?.();

  const rect = nativeMenu.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const overlay = doc.createElement("div");
  overlay.setAttribute("role", "menu");
  overlay.setAttribute("tabindex", "-1");
  overlay.setAttribute(PROJECT_MENU_ATTR, "overlay");
  overlay.className = "fixed z-[10000] flex min-w-[220px] max-h-[70vh] flex-col overflow-y-auto rounded-xl border border-token-border p-1 shadow-lg";
  overlay.style?.setProperty?.("background-color", "var(--color-background-panel, var(--color-token-bg-fog))");
  const placement = projectMenuOverlayPlacement(rect, doc.defaultView);
  overlay.style?.setProperty?.("left", `${Math.max(8, Number(rect.left) || 8)}px`);
  overlay.style?.setProperty?.("top", `${placement.top}px`);
  overlay.style?.setProperty?.("min-width", `${Math.max(160, Number(rect.width) || 220)}px`);
  overlay.style?.setProperty?.("max-height", `${placement.maxHeight}px`);
  overlay.style?.setProperty?.("overflow-y", "auto");
  overlay.style?.setProperty?.("overscroll-behavior", "contain");
  overlay.style?.setProperty?.("scrollbar-gutter", "stable");

  const interactive = [];
  const add = (item) => { interactive.push(item); overlay.appendChild(item); return item; };
  const template = commands[0]?.source;
  for (const command of commands) {
    const item = ownedProjectMenuItem(doc, command.label, template, () => {
      close();
      command.replay();
    }, command);
    item.setAttribute("data-tweaker-project-native-command", String(command.order));
    add(item);
  }
  const divider = doc.createElement("div");
  divider.setAttribute("role", "separator");
  divider.className = "my-1 h-px bg-token-border";
  overlay.appendChild(divider);
  const openColor = () => openProjectColorSubmenu(doc, colorTrigger, context, async (choice) => {
    await handlers.saveAppearance?.(context.project.id, choice);
    close();
  });
  const openSort = () => openProjectTaskSortSubmenu(doc, sortTrigger, context, async (taskSort) => {
    await handlers.saveAppearance?.(context.project.id, { taskSort });
    close();
  });
  const colorTrigger = ownedProjectMenuItem(doc, "Project color", template, openColor, { submenu: true });
  colorTrigger.setAttribute(PROJECT_COLOR_MENU_ATTR, "trigger");
  add(colorTrigger);
  const sortTrigger = ownedProjectMenuItem(doc, "Sort", template, openSort, { submenu: true });
  sortTrigger.setAttribute(PROJECT_TASK_MENU_ATTR, "sort");
  add(sortTrigger);

  // Keep keyboard navigation on the same submenu seam as the trigger click.
  // Calling dispatchEvent with a plain object is rejected by a real DOM node.

  let activeIndex = -1;
  const focusAt = (position) => {
    const enabled = interactive.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled && item.getAttribute?.("aria-disabled") !== "true");
    if (!enabled.length) return;
    const match = enabled[((position % enabled.length) + enabled.length) % enabled.length];
    activeIndex = match.index;
    for (const { item, index } of interactive.map((item, index) => ({ item, index }))) item.setAttribute("tabindex", index === activeIndex ? "0" : "-1");
    match.item.focus?.();
  };
  const focusRelative = (delta) => {
    const enabledIndexes = interactive.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled && item.getAttribute?.("aria-disabled") !== "true").map(({ index }) => index);
    const current = Math.max(0, enabledIndexes.indexOf(activeIndex));
    focusAt(current + delta);
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") {
      if (ownedProjectMenuSubmenuContains(doc, event.target)) return;
      event.preventDefault?.();
      close();
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault?.(); focusRelative(1); return; }
    if (event.key === "ArrowUp") { event.preventDefault?.(); focusRelative(-1); return; }
    if (event.key === "Home") { event.preventDefault?.(); focusAt(0); return; }
    if (event.key === "End") { event.preventDefault?.(); focusAt(-1); return; }
    if (event.key === "ArrowRight" && (interactive[activeIndex] === colorTrigger || interactive[activeIndex] === sortTrigger)) {
      event.preventDefault?.();
      if (interactive[activeIndex] === colorTrigger) openColor();
      else openSort();
    }
  };
  const onOutside = (event) => {
    if (overlay.contains?.(event.target) || ownedProjectMenuSubmenuContains(doc, event.target)) return;
    close();
  };
  let closed = false;
  let nativeObserver = null;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener?.("pointerdown", onOutside, true);
    doc.removeEventListener?.("keydown", onKeydown, true);
    nativeObserver?.disconnect?.();
    disposeOwnedProjectMenuSubmenus(overlay);
    nativeMenu.removeAttribute?.(PROJECT_NATIVE_MENU_ATTR);
    overlay[PROJECT_MENU_DISPOSE] = null;
    overlay.remove?.();
  };
  nativeMenu.setAttribute(PROJECT_NATIVE_MENU_ATTR, "hidden");
  overlay[PROJECT_MENU_DISPOSE] = close;
  // Keep the owned surface inside the native portal. Codex's dismissable-menu
  // boundary therefore still treats a click in our dropdown as inside the
  // opened portal, while the source command elements remain available to
  // replay their real click semantics.
  nativeMenu.appendChild(overlay);
  doc.addEventListener?.("pointerdown", onOutside, true);
  doc.addEventListener?.("keydown", onKeydown, true);
  if (typeof MutationObserver === "function") {
    nativeObserver = new MutationObserver(() => {
      if (!nativeProjectMenuIsLive(nativeMenu)) close();
    });
    nativeObserver.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  }
  focusAt(0);
  return overlay;
}

// Keep Codex's project menu authoritative. The tweak adds one native-shaped
// submenu trigger and never hides, clones, or replays host commands.
function injectNativeProjectSettingsMenu(doc, nativeMenu, context, handlers = {}) {
  if (!doc?.createElement || !nativeProjectMenuIsLive(nativeMenu)
    || nativeMenu.querySelector?.(`[${PROJECT_MENU_ATTR}="trigger"]`)) return null;
  const commands = snapshotNativeProjectMenuCommands(nativeMenu);
  const section = commands.find((command) => /^Section$/i.test(command.label))?.source || null;
  const remove = commands.find((command) => isRemoveProjectMenuItem(command.source))?.source || null;
  const template = section || commands.find((command) => !command.disabled)?.source;
  if (!template || !remove) return null;

  const trigger = ownedProjectMenuItem(doc, "Project settings", template, () => {
    openProjectSettingsSubmenu(doc, nativeMenu, trigger, context, handlers);
  }, { icon: nativeMenuCommandIcon(section), submenu: true });
  trigger.setAttribute(PROJECT_MENU_ATTR, "trigger");
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("data-state", "closed");
  const siblings = [...(nativeMenu.children || [])];
  const sectionIndex = section ? siblings.indexOf(section) : -1;
  nativeMenu.insertBefore(trigger, sectionIndex >= 0 ? (siblings[sectionIndex + 1] || null) : remove);

  let disposed = false;
  let observer = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect?.();
    const submenu = firstDocumentMatch(doc, `[${PROJECT_MENU_ATTR}="settings-submenu"]`);
    if (typeof submenu?.[PROJECT_MENU_DISPOSE] === "function") submenu[PROJECT_MENU_DISPOSE]();
    else submenu?.remove?.();
    trigger[PROJECT_MENU_DISPOSE] = null;
    trigger.remove?.();
  };
  trigger[PROJECT_MENU_DISPOSE] = dispose;
  if (typeof MutationObserver === "function") {
    observer = new MutationObserver(() => {
      if (!nativeProjectMenuIsLive(nativeMenu)) dispose();
    });
    observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
  }
  return trigger;
}

function openProjectSettingsSubmenu(doc, nativeMenu, anchor, context, handlers = {}) {
  const previous = firstDocumentMatch(doc, `[${PROJECT_MENU_ATTR}="settings-submenu"]`);
  if (typeof previous?.[PROJECT_MENU_DISPOSE] === "function") previous[PROJECT_MENU_DISPOSE]();
  else previous?.remove?.();
  const submenu = doc.createElement("div");
  submenu.setAttribute("role", "menu");
  submenu.setAttribute(PROJECT_MENU_ATTR, "settings-submenu");
  submenu.setAttribute("data-state", "open");
  submenu.className = nativeMenu.className || "fixed z-[10000] flex min-w-[220px] flex-col rounded-xl border border-token-border p-1 shadow-lg";
  submenu.style?.setProperty?.("background-color", "var(--color-background-panel, var(--color-token-bg-fog))");
  const rect = anchor?.getBoundingClientRect?.();
  const viewportWidth = Number(doc.defaultView?.innerWidth) || 1200;
  const right = Number(rect?.right) || 8;
  submenu.style?.setProperty?.("position", "fixed");
  submenu.style?.setProperty?.("left", `${right + 220 <= viewportWidth - 8 ? right : Math.max(8, (Number(rect?.left) || right) - 220)}px`);
  submenu.style?.setProperty?.("top", `${Math.max(8, Number(rect?.top) || 8)}px`);

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    doc.removeEventListener?.("pointerdown", onOutside, true);
    doc.removeEventListener?.("keydown", onKeydown, true);
    disposeOwnedProjectMenuSubmenus(submenu);
    anchor?.setAttribute?.("data-state", "closed");
    submenu[PROJECT_MENU_DISPOSE] = null;
    submenu.remove?.();
  };
  const openColor = () => openProjectColorSubmenu(doc, colorTrigger, context, async (choice) => {
    await handlers.saveAppearance?.(context.project.id, choice);
    dispose();
  });
  const openSort = () => openProjectTaskSortSubmenu(doc, sortTrigger, context, async (taskSort) => {
    await handlers.saveAppearance?.(context.project.id, { taskSort });
    dispose();
  });
  const colorTrigger = ownedProjectMenuItem(doc, "Project color", anchor, openColor, { submenu: true });
  colorTrigger.setAttribute(PROJECT_COLOR_MENU_ATTR, "trigger");
  colorTrigger.setAttribute("aria-haspopup", "menu");
  const sortTrigger = ownedProjectMenuItem(doc, "Task sorting", anchor, openSort, { submenu: true });
  sortTrigger.setAttribute(PROJECT_TASK_MENU_ATTR, "sort");
  sortTrigger.setAttribute("aria-haspopup", "menu");
  submenu.append(colorTrigger, sortTrigger);
  const onOutside = (event) => {
    if (submenu.contains?.(event.target) || anchor?.contains?.(event.target)
      || ownedProjectMenuSubmenuContains(doc, event.target)) return;
    dispose();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape" && !ownedProjectMenuSubmenuContains(doc, event.target)) dispose();
    if (event.key === "ArrowRight" && event.target === colorTrigger) openColor();
    if (event.key === "ArrowRight" && event.target === sortTrigger) openSort();
  };
  submenu[PROJECT_MENU_DISPOSE] = dispose;
  nativeMenu.appendChild(submenu);
  anchor?.setAttribute?.("data-state", "open");
  doc.addEventListener?.("pointerdown", onOutside, true);
  doc.addEventListener?.("keydown", onKeydown, true);
  colorTrigger.focus?.();
  return submenu;
}

function openProjectColorSubmenu(doc, anchor, context, onSelect) {
  const previous = doc.body.querySelector?.(`[${PROJECT_COLOR_MENU_ATTR}="submenu"]`);
  if (typeof previous?.[PROJECT_COLOR_DISPOSE] === "function") previous[PROJECT_COLOR_DISPOSE]();
  else previous?.remove?.();
  const project = context?.project || {};
  const submenu = doc.createElement("div");
  submenu.setAttribute("role", "menu");
  submenu.setAttribute(PROJECT_COLOR_MENU_ATTR, "submenu");
  submenu.className = "fixed z-[10000] flex max-h-[70vh] min-w-[220px] flex-col overflow-y-auto rounded-xl border border-token-border p-1 shadow-lg";
  submenu.style?.setProperty?.("background-color", "var(--color-background-panel, var(--color-token-bg-fog))");
  const rect = anchor?.getBoundingClientRect?.();
  if (submenu.style?.setProperty) {
    const viewportHeight = Number(doc.defaultView?.innerHeight) || 800;
    const viewportWidth = Number(doc.defaultView?.innerWidth) || 1200;
    const maxHeight = Math.min(Math.max(160, Math.floor(viewportHeight * 0.7)), Math.max(96, viewportHeight - 16));
    const top = Math.max(8, Math.min(Number(rect?.top) || 8, viewportHeight - maxHeight - 8));
    const right = Number(rect?.right) || 8;
    const left = right + 220 <= viewportWidth - 8 ? right : Math.max(8, (Number(rect?.left) || right) - 220);
    submenu.style.setProperty("left", `${left}px`);
    submenu.style.setProperty("top", `${top}px`);
    submenu.style.setProperty("max-height", `${maxHeight}px`);
    submenu.style.setProperty("overflow-y", "auto");
    submenu.style.setProperty("overscroll-behavior", "contain");
    submenu.style.setProperty("scrollbar-gutter", "stable");
  }
  const title = doc.createElement("div");
  title.textContent = "Project color";
  title.className = "px-2 py-1 text-xs text-token-text-secondary";
  submenu.appendChild(title);
  const choices = [{ id: "auto", label: "Auto", value: autoColor(project.projectPath || project.id || project.name) }, ...PROJECT_COLOR_OPTIONS];
  let checkedItem = null;
  for (const option of choices) {
    const item = doc.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("data-color-id", option.id);
    item.setAttribute("aria-checked", String(option.id === "auto" ? project.colorMode === "auto" : project.colorMode !== "auto" && project.color === option.value));
    if (item.getAttribute("aria-checked") === "true") checkedItem = item;
    item.className = "flex min-h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-foreground/10";
    const swatch = doc.createElement("span");
    swatch.className = "size-3 shrink-0 rounded-full border border-token-border";
    swatch.style?.setProperty?.("background-color", option.value);
    const text = doc.createElement("span");
    text.textContent = option.label;
    text.className = "min-w-0 flex-1 truncate";
    const check = doc.createElement("span");
    check.textContent = item.getAttribute("aria-checked") === "true" ? "✓" : "";
    item.append(swatch, text, check);
    item.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onSelect?.(option.id === "auto" ? { colorMode: "auto", color: autoColor(project.projectPath || project.id || project.name) } : { colorMode: "manual", color: option.value });
      close();
    });
    submenu.appendChild(item);
  }
  const overlayTitle = doc.createElement("div");
  overlayTitle.textContent = "Task tint";
  overlayTitle.className = "mt-1 border-t border-token-border px-2 py-1 text-xs text-token-text-secondary";
  submenu.appendChild(overlayTitle);
  for (const intensity of PROJECT_OVERLAY_OPTIONS) {
    const item = doc.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("data-overlay-id", intensity);
    item.setAttribute("aria-checked", String(project.overlayIntensity === intensity));
    item.textContent = titleCase(intensity);
    item.className = "flex min-h-8 items-center rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-foreground/10";
    item.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onSelect?.({ overlayIntensity: intensity });
      close();
    });
    submenu.appendChild(item);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener?.("pointerdown", onOutside, true);
    doc.removeEventListener?.("keydown", onKeydown, true);
    submenu[PROJECT_COLOR_DISPOSE] = null;
    submenu.remove?.();
  };
  const onOutside = (event) => {
    if (submenu.contains?.(event.target) || anchor?.contains?.(event.target)) return;
    close();
  };
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  submenu[PROJECT_COLOR_DISPOSE] = close;
  projectMenuSubmenuHost(doc, anchor)?.appendChild(submenu);
  checkedItem?.scrollIntoView?.({ block: "nearest" });
  doc.addEventListener?.("pointerdown", onOutside, true);
  doc.addEventListener?.("keydown", onKeydown, true);
  return submenu;
}

function openNativeProjectEditDialog(project) {
  const finish = () => {
    const identities = new Set([project.id, ...(project.nativeProjectIds || [])]);
    let row = [...document.querySelectorAll?.("[data-app-action-sidebar-project-id]") || []]
      .find((node) => identities.has(node.getAttribute("data-app-action-sidebar-project-id")));
    if (!row) row = nativeProjectMatches({ react: null }, [project])[0]?.element;
    const container = closestProjectContainer(row) || row;
    const menuButton = [...(container?.querySelectorAll?.('button, [role="button"]') || [])]
      .find((node) => node !== row && (/more|menu|options/i.test(String(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "")) || !String(node.textContent || "").trim()));
    if (!menuButton) { window.alert("Open this project's menu in the sidebar and choose Edit project."); return; }
    const clickEdit = () => {
      const item = [...document.querySelectorAll?.('[role="menuitem"], [role="menu"] button') || []]
        .find((node) => /^Edit project$/i.test(String(node.textContent || "").replace(/\s+/g, " ").trim()));
      if (!item) return false;
      item.click?.();
      return true;
    };
    menuButton.click?.();
    if (clickEdit()) return;
    const observer = new MutationObserver(() => { if (clickEdit()) observer.disconnect(); });
    observer.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => observer.disconnect(), 1500);
  };
  const settingsMarker = document.querySelector?.("[data-settings-panel-slug]");
  let shell = settingsMarker;
  while (shell?.parentElement && !shell.querySelector?.('button[aria-label="Close"]')) shell = shell.parentElement;
  const close = shell?.querySelector?.('button[aria-label="Close"]');
  if (close) { close.click?.(); window.setTimeout(finish, 50); }
  else finish();
}

function installProjectColorControls(api, getState, saveAppearance) {
  if (typeof document === "undefined") return () => {};
  ensureProjectColorStyle();
  let pending = null;
  let requestId = 0;
  let menuObserver = null;
  let menuObserverTimer = null;
  const inject = (context, id) => {
    if (!pending || requestId !== id || pending !== context) return;
    const nativeMenu = findNativeProjectMenu(document, context);
    if (!nativeMenu) return;
    const trigger = injectNativeProjectSettingsMenu(document, nativeMenu, context, { saveAppearance });
    if (trigger) {
      api.log?.info?.("Project settings menu injected", { projectId: context.project.id, source: context.source });
      pending = null;
      stopMenuObserver();
    }
  };
  const stopMenuObserver = () => {
    menuObserver?.disconnect?.();
    menuObserver = null;
    if (menuObserverTimer !== null) window.clearTimeout(menuObserverTimer);
    menuObserverTimer = null;
  };
  const seed = (event) => {
    const context = resolveProjectContext(api, getState?.(), event.target);
    if (!context) return;
    if (event.type !== "contextmenu") {
      const button = event.target?.closest?.('button, [role="button"]');
      if (!button || button === context.element || !context.container.contains(button)) return;
    }
    const anchor = event.target?.closest?.('button, [role="button"]') || context.container;
    const rect = anchor?.getBoundingClientRect?.();
    const x = Number.isFinite(event.clientX) ? event.clientX : (rect?.right || rect?.left || 0);
    const y = Number.isFinite(event.clientY) ? event.clientY : (rect?.top || 0);
    stopMenuObserver();
    pending = { ...context, x, y };
    const id = ++requestId;
    api.log?.info?.("Project color menu target resolved", { projectId: pending.project.id, source: pending.source, eventType: event.type });
    inject(pending, id);
    menuObserver = new MutationObserver(() => inject(pending, id));
    menuObserver.observe(document.body, { childList: true, subtree: true });
    menuObserverTimer = window.setTimeout(() => {
      if (requestId === id) pending = null;
      stopMenuObserver();
    }, 1500);
  };
  document.addEventListener("contextmenu", seed, true);
  document.addEventListener("pointerdown", seed, true);
  document.addEventListener("click", seed, true);
  return () => {
    document.removeEventListener("contextmenu", seed, true);
    document.removeEventListener("pointerdown", seed, true);
    document.removeEventListener("click", seed, true);
    stopMenuObserver();
    requestId += 1;
    pending = null;
    removeProjectColorArtifacts();
  };
}

function resolveProjectContext(api, state, target) {
  if (!state?.nodes || !(target instanceof Element)) return null;
  const projects = state.nodes.filter((node) => node.type === "project").sort((a, b) => b.name.length - a.name.length);
  const targetContainer = target.closest?.('[role="listitem"]');
  for (const match of api.react?.host?.query?.("projects") || []) {
    const element = match.element;
    if (!(element instanceof HTMLElement)) continue;
    const container = element.closest?.('[role="listitem"]') || element;
    if (!(element === target || element.contains(target) || target.contains?.(element) || (targetContainer && targetContainer === container))) continue;
    const identity = element.getAttribute?.("data-app-action-sidebar-project-id") || element.getAttribute?.("data-workspace-path") || element.getAttribute?.("data-project-path");
    const project = unambiguousProjectForNativeIdentity(projects, projectLabelForRow(element), identity);
    if (project) return { project, element, container, source: "semantic" };
  }
  if (!(targetContainer instanceof HTMLElement)) return null;
  const projectAction = targetContainer.querySelector?.("[data-app-action-sidebar-project-id]");
  const donorRowShape = targetContainer.classList?.contains?.("group/cwd") || projectAction instanceof HTMLElement;
  if (!donorRowShape) return null;
  const label = projectLabelForRow(projectAction instanceof HTMLElement ? projectAction : targetContainer);
  const identity = projectAction?.getAttribute?.("data-app-action-sidebar-project-id") || targetContainer.getAttribute?.("data-workspace-path") || targetContainer.getAttribute?.("data-project-path");
  const project = unambiguousProjectForNativeIdentity(projects, label, identity);
  if (!project) return null;
  return { project, element: projectAction instanceof HTMLElement ? projectAction : targetContainer, container: targetContainer, source: "live-row" };
}

function unambiguousProjectForNativeIdentity(projects, label, identity) {
  const list = Array.isArray(projects) ? projects : [];
  const exact = identity ? list.filter((project) => project.id === identity || project.projectPath === identity
    || (Array.isArray(project.nativeProjectIds) && project.nativeProjectIds.includes(identity))
    || (Array.isArray(project.nativeProjectPaths) && project.nativeProjectPaths.includes(identity))) : [];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const names = list.filter((project) => projectNativeNames(project)
    .some((name) => label === name || label.startsWith(`${name} `) || label.startsWith(`${name} ·`)));
  return names.length === 1 ? names[0] : null;
}

function nativeProjectSurfaceFingerprint(api) {
  return (api.react?.host?.query?.("projects") || []).map((match) => {
    const element = match?.element;
    const identity = element?.getAttribute?.("data-app-action-sidebar-project-id") || element?.getAttribute?.("data-workspace-path") || element?.getAttribute?.("data-project-path") || "";
    return `${identity}\0${projectLabelForRow(element)}`;
  }).sort().join("\n");
}

function findNativeProjectMenu(doc, context = {}) {
  const surfaces = new Set([
    ...(doc?.querySelectorAll?.('[role="menu"]') || []),
    ...(doc?.querySelectorAll?.('[data-radix-menu-content]') || []),
    ...(doc?.querySelectorAll?.('[data-state="open"]') || []),
  ]);
  const menus = [...surfaces]
    .filter((menu) => nativeProjectMenuIsLive(menu) && !menu.hasAttribute?.(PROJECT_COLOR_MENU_ATTR)
      && !menu.hasAttribute?.(PROJECT_MENU_ATTR) && !menu.hasAttribute?.(PROJECT_NATIVE_MENU_ATTR))
    .filter((menu) => snapshotNativeProjectMenuCommands(menu).some((command) => isRemoveProjectMenuItem(command.source)))
    .map((menu) => ({ menu, rect: menu.getBoundingClientRect?.() }))
    .filter(({ rect }) => rect && rect.width > 0 && rect.height > 0);
  // A browser event may arrive while a previous portal is animating out. With
  // more than one matching command surface, there is no safe way to bind it to
  // this project row. Preserve Codex's native menus rather than guessing.
  return menus.length === 1 ? menus[0].menu : null;
}

function ensureProjectColorStyle() {
  let style = document.getElementById(PROJECT_COLOR_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = PROJECT_COLOR_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `
    [data-tweaker-project-color-group] { box-sizing: border-box; inline-size: calc(100% - var(--tweaker-project-row-end-inset, 0px)) !important; min-inline-size: 0; max-inline-size: calc(100% - var(--tweaker-project-row-end-inset, 0px)); contain: inline-size; overflow-x: visible; --tweaker-project-row-radius: var(--radius-lg, 0.625rem); --tweaker-project-task-tint: 10%; --tweaker-project-task-foreground: var(--tweaker-project-color); --tweaker-project-header-tint: 16%; --tweaker-project-header-foreground: color-mix(in srgb, var(--tweaker-project-color) 72%, var(--color-token-text-primary)); }
    [data-tweaker-project-color-group][data-tweaker-project-overlay="off"] { --tweaker-project-task-tint: 0%; }
    [data-tweaker-project-color-group][data-tweaker-project-overlay="subtle"] { --tweaker-project-task-tint: 6%; }
    [data-tweaker-project-color-group][data-tweaker-project-overlay="medium"] { --tweaker-project-task-tint: 10%; }
    [data-tweaker-project-color-group][data-tweaker-project-overlay="strong"] { --tweaker-project-task-tint: 15%; }
    .electron-dark [data-tweaker-project-color-group] { --tweaker-project-task-foreground: color-mix(in srgb, var(--tweaker-project-color) 42%, white); --tweaker-project-header-tint: 24%; --tweaker-project-header-foreground: color-mix(in srgb, var(--tweaker-project-color) 45%, var(--color-token-text-primary)); }
    .electron-dark [data-tweaker-project-color-group][data-tweaker-project-overlay="subtle"] { --tweaker-project-task-tint: 11%; }
    .electron-dark [data-tweaker-project-color-group][data-tweaker-project-overlay="medium"] { --tweaker-project-task-tint: 18%; }
    .electron-dark [data-tweaker-project-color-group][data-tweaker-project-overlay="strong"] { --tweaker-project-task-tint: 24%; }
    [data-tweaker-project-color-group] [role="list"], [data-tweaker-project-color-row], [data-tweaker-project-color-task], [data-tweaker-project-color-pinned], [data-tweaker-project-show-more], [data-tweaker-project-task-action] { box-sizing: border-box; inline-size: 100% !important; min-inline-size: 0; max-inline-size: 100%; }
    [data-tweaker-project-color-row] { inline-size: 100%; overflow-x: visible !important; border-radius: var(--tweaker-project-row-radius) !important; background-color: var(--tweaker-project-color) !important; color: var(--tweaker-project-foreground) !important; }
    [data-tweaker-project-color-row]:hover { background-image: linear-gradient(rgb(255 255 255 / 8%), rgb(255 255 255 / 8%)); }
    [data-tweaker-project-color-row][data-tweaker-project-selected="true"] { position: relative; border-radius: var(--tweaker-project-row-radius) !important; outline: 2px solid var(--color-token-focus-border, var(--color-token-text-link-foreground)) !important; outline-offset: 0 !important; background-color: var(--gray-1000) !important; color: var(--gray-0) !important; }
    [data-tweaker-project-color-row][data-tweaker-project-selected="true"] * { color: var(--gray-0) !important; }
    [data-tweaker-project-color-icon] { color: var(--tweaker-project-foreground) !important; }
    [data-tweaker-project-color-row][data-tweaker-project-selected="true"] [data-tweaker-project-color-icon] { color: var(--gray-0) !important; }
    [data-tweaker-project-color-title], [data-tweaker-project-task-label] { min-inline-size: 0; max-inline-size: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    [data-tweaker-project-color-title], [data-tweaker-project-task-action] > [data-tweaker-project-task-label] { flex: 1 1 auto; }
    [data-tweaker-project-task-action] { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    [data-tweaker-project-color-title] { color: var(--tweaker-project-foreground) !important; font-weight: 700 !important; text-transform: uppercase !important; }
    [data-tweaker-project-color-row][data-tweaker-project-selected="true"] [data-tweaker-project-color-title] { color: var(--gray-0) !important; }
    [data-tweaker-project-color-task] { border-radius: var(--radius-lg, 0.625rem) !important; background-color: color-mix(in srgb, var(--tweaker-project-color) var(--tweaker-project-task-tint), transparent) !important; block-size: var(--tweaker-project-native-row-block-size, auto) !important; min-block-size: var(--tweaker-project-native-row-block-size, 0) !important; inline-size: var(--tweaker-project-native-row-inline-size, 100%) !important; margin-inline-start: var(--tweaker-project-native-row-offset, 0px) !important; margin-block: 0 !important; }
    [data-tweaker-project-color-task]:hover { background-image: linear-gradient(color-mix(in srgb, var(--color-token-list-hover-background, transparent) 70%, transparent), color-mix(in srgb, var(--color-token-list-hover-background, transparent) 70%, transparent)); }
    [data-tweaker-project-task-label] { color: var(--tweaker-project-task-foreground) !important; font-weight: 400 !important; }
    [data-tweaker-project-color-task][data-tweaker-project-selected="true"] { background-color: var(--tweaker-project-color) !important; color: var(--tweaker-project-foreground) !important; }
    [data-tweaker-project-color-task][data-tweaker-project-selected="true"] [data-tweaker-project-task-label], [data-tweaker-project-color-task][data-tweaker-project-selected="true"] svg { color: var(--tweaker-project-foreground) !important; }
    [data-tweaker-project-show-more] { background: transparent !important; color: var(--tweaker-project-task-foreground) !important; font-weight: 600 !important; block-size: var(--tweaker-project-native-row-block-size, auto) !important; min-block-size: var(--tweaker-project-native-row-block-size, 0) !important; inline-size: var(--tweaker-project-native-row-inline-size, 100%) !important; margin-inline-start: var(--tweaker-project-native-row-offset, 0px) !important; margin-block: 0 !important; }
    [data-tweaker-project-color-pinned] { border-radius: var(--radius-lg, 0.625rem) !important; background-color: var(--tweaker-project-color) !important; color: var(--gray-0) !important; }
    [data-tweaker-project-color-pinned] * { color: var(--gray-0) !important; }
    [data-tweaker-project-color-pinned]:hover { background-image: linear-gradient(rgb(255 255 255 / 8%), rgb(255 255 255 / 8%)); }
    [data-tweaker-project-spacing-list] { display: flex !important; flex-direction: column !important; gap: var(--tweaker-project-native-row-gap, var(--spacing-px, 1px)) !important; margin-block-start: var(--tweaker-project-native-row-gap, var(--spacing-px, 1px)) !important; }
    [data-tweaker-project-fallback-spacing] { margin-block-start: var(--tweaker-project-native-row-gap, var(--spacing-px, 1px)) !important; }
    [data-tweaker-project-active-count] { position: relative !important; }
    [data-tweaker-project-active-count]::after { content: attr(data-tweaker-project-active-count); position: absolute; inset: 0; display: grid; place-items: center; color: var(--tweaker-project-foreground, currentColor); font-size: 7px; font-weight: 700; line-height: 1; pointer-events: none; }
    [data-tweaker-project-custom-color] { -webkit-appearance: none; appearance: none; overflow: hidden; padding: 0 !important; }
    [data-tweaker-project-custom-color]::-webkit-color-swatch-wrapper { padding: 0; }
    [data-tweaker-project-custom-color]::-webkit-color-swatch { border: 0; border-radius: 9999px; }
    [${PROJECT_NATIVE_MENU_ATTR}] { visibility: hidden !important; pointer-events: none !important; }
    [${PROJECT_NATIVE_MENU_ATTR}] [${PROJECT_MENU_ATTR}="overlay"] { visibility: visible !important; pointer-events: auto !important; }
    [${PROJECT_MENU_ATTR}="overlay"] { color-scheme: light dark; }
    [${PROJECT_COLOR_MENU_ATTR}="submenu"] { color-scheme: light dark; }
  `;
  return style;
}

function taskIdForRow(row) {
  const candidate = row?.getAttribute?.("data-app-action-sidebar-thread-id")
    || row?.querySelector?.("[data-app-action-sidebar-thread-id]")?.getAttribute?.("data-app-action-sidebar-thread-id");
  const value = typeof candidate === "string" ? candidate.trim() : "";
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) ? value : null;
}

function taskTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    return Math.abs(milliseconds) <= 8_640_000_000_000_000 ? milliseconds : null;
  }
  if (typeof value !== "string" || value.length > 80) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && value.trim() !== "") return taskTimestamp(numeric);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function taskTimestampKeys(kind) {
  return kind === "created"
    ? ["createdAt", "created_at", "createdTime", "creationTime", "createdTimestamp"]
    : ["updatedAt", "updated_at", "updatedTime", "lastUpdatedAt", "lastModifiedAt", "updatedTimestamp"];
}

function taskTimestampFromRecord(value, taskId, kind, limits = {}) {
  const maxDepth = limits.maxDepth || 5;
  const maxNodes = limits.maxNodes || 240;
  const timestampKeys = taskTimestampKeys(kind);
  const seen = new Set();
  let visited = 0;
  let result = null;
  const visit = (item, depth) => {
    if (result !== null || !isRecord(item) || depth > maxDepth || visited >= maxNodes || seen.has(item)) return;
    seen.add(item);
    visited += 1;
    const identity = item.threadId || item.thread_id || item.conversationId || item.conversation_id || item.taskId || item.task_id || item.id;
    if (identity === taskId) {
      for (const key of timestampKeys) {
        const parsed = taskTimestamp(item[key]);
        if (parsed !== null) { result = parsed; return; }
      }
    }
    for (const child of Object.values(item)) {
      if (isRecord(child)) visit(child, depth + 1);
      else if (Array.isArray(child) && depth < maxDepth) {
        for (const entry of child) visit(entry, depth + 1);
      }
      if (result !== null) return;
    }
  };
  visit(value, 0);
  return result;
}

function taskTimestampFromFiber(api, row, taskId, kind) {
  const attributeNames = kind === "created"
    ? ["data-created-at", "data-created-time"]
    : ["data-updated-at", "data-updated-time"];
  for (const attribute of attributeNames) {
    const parsed = taskTimestamp(row?.getAttribute?.(attribute));
    if (parsed !== null) return parsed;
  }
  let fiber = api?.react?.getFiber?.(row) || null;
  for (let depth = 0; fiber && depth < 18; depth += 1, fiber = fiber.return) {
    const props = taskTimestampFromRecord(fiber.memoizedProps, taskId, kind);
    if (props !== null) return props;
    const state = taskTimestampFromRecord(fiber.memoizedState, taskId, kind);
    if (state !== null) return state;
  }
  return null;
}

function taskRecordsForRows(api, rows) {
  return rows.map((row, nativeIndex) => {
    const id = taskIdForRow(row);
    return {
      row,
      id,
      nativeIndex,
      createdAt: id ? taskTimestampFromFiber(api, row, id, "created") : null,
      updatedAt: id ? taskTimestampFromFiber(api, row, id, "updated") : null,
    };
  });
}

function orderProjectTaskRecords(records, taskSort, pinnedTaskIds) {
  const sort = normalizeTaskSort(taskSort);
  if (!sort) return [...records].sort((left, right) => left.nativeIndex - right.nativeIndex);
  const pinned = new Set(Array.isArray(pinnedTaskIds) ? pinnedTaskIds.map(String) : []);
  const sortKey = sort.startsWith("created") ? "createdAt" : "updatedAt";
  const direction = sort.endsWith("-asc") ? 1 : -1;
  const sortPartition = (partition) => {
    const dated = partition.filter((record) => Number.isFinite(record[sortKey]));
    const undated = partition.filter((record) => !Number.isFinite(record[sortKey]));
    dated.sort((left, right) => {
      if (left[sortKey] !== right[sortKey]) return direction * (left[sortKey] - right[sortKey]);
      return left.nativeIndex - right.nativeIndex;
    });
    // Never manufacture a timestamp from task text. Rows without a usable
    // date remain in their native relative order after the dated partition.
    undated.sort((left, right) => left.nativeIndex - right.nativeIndex);
    return [...dated, ...undated];
  };
  const localPins = records.filter((record) => !!record.id && pinned.has(String(record.id)));
  const unpinned = records.filter((record) => !record.id || !pinned.has(String(record.id)));
  return [...sortPartition(localPins), ...sortPartition(unpinned)];
}

function pruneDetachedTaskPlacements() {
  let removed = 0;
  for (const parent of [...NATIVE_TASK_PLACEMENTS.keys()]) {
    if (parent?.isConnected !== false) continue;
    NATIVE_TASK_PLACEMENTS.delete(parent);
    removed += 1;
  }
  return removed;
}

function rememberNativeTaskOrder(parent, records) {
  pruneDetachedTaskPlacements();
  if (!parent || NATIVE_TASK_PLACEMENTS.has(parent)) return;
  const siblings = [...(parent.children || [])];
  NATIVE_TASK_PLACEMENTS.set(parent, records.map((record) => {
    const index = siblings.indexOf(record.row);
    return { row: record.row, nextSibling: index >= 0 ? (siblings[index + 1] || null) : null };
  }));
}

function restoreProjectTaskOrder(container = null) {
  pruneDetachedTaskPlacements();
  for (const [parent, placements] of [...NATIVE_TASK_PLACEMENTS]) {
    if (container && parent !== container && !container.contains?.(parent)) continue;
    for (let index = placements.length - 1; index >= 0; index -= 1) {
      const { row, nextSibling } = placements[index];
      if (row?.parentElement !== parent) continue;
      if (nextSibling && nextSibling.parentElement !== parent) continue;
      row.remove?.();
      parent.insertBefore?.(row, nextSibling);
    }
    NATIVE_TASK_PLACEMENTS.delete(parent);
  }
}

function contiguousTaskRuns(records) {
  const runs = [];
  for (const record of records) {
    const parent = record.row?.parentElement;
    const current = runs[runs.length - 1];
    const previous = current?.[current.length - 1];
    const siblings = [...(parent?.children || [])];
    if (!current || previous?.row?.parentElement !== parent
      || siblings.indexOf(previous.row) + 1 !== siblings.indexOf(record.row)) {
      runs.push([record]);
    } else {
      current.push(record);
    }
  }
  return runs;
}

function reorderProjectTaskRows(api, container, project) {
  const sort = normalizeTaskSort(project?.taskSort);
  if (!sort) {
    restoreProjectTaskOrder(container);
    return 0;
  }
  if (!container?.querySelectorAll) return 0;
  const rows = [...container.querySelectorAll('[role="listitem"]')]
    .filter((row) => row !== container && !row.closest?.('[data-tweaker-project-color-row]'))
    .filter((row) => taskIdForRow(row));
  const records = taskRecordsForRows(api, rows);
  const byParent = new Map();
  for (const record of records) {
    const parent = record.row?.parentElement;
    if (!parent) continue;
    const list = byParent.get(parent) || [];
    list.push(record);
    byParent.set(parent, list);
  }
  let changed = 0;
  for (const group of byParent.values()) {
    for (const run of contiguousTaskRuns(group)) {
      const ordered = orderProjectTaskRecords(run, sort, project?.pinnedTaskIds);
      if (ordered.every((record, index) => record === run[index])) continue;
      const parent = run[0]?.row?.parentElement;
      const siblings = [...(parent?.children || [])];
      const finalNativeIndex = siblings.indexOf(run[run.length - 1].row);
      const anchor = finalNativeIndex >= 0 ? (siblings[finalNativeIndex + 1] || null) : null;
      rememberNativeTaskOrder(parent, group);
      for (const record of ordered) {
        record.row.remove?.();
        parent?.insertBefore?.(record.row, anchor);
      }
      changed += 1;
    }
  }
  return changed;
}

function taskRowsForContainer(container) {
  return [...(container?.querySelectorAll?.('[role="listitem"]') || [])]
    .filter((row) => row !== container && taskIdForRow(row));
}

function resolveProjectTaskContext(api, state, target) {
  if (!state?.nodes || !(target instanceof Element)) return null;
  const row = closestThreadRow(target);
  const taskId = taskIdForRow(row);
  if (!taskId) return null;
  const group = row?.closest?.("[data-tweaker-project-color-group]");
  const projectId = group?.getAttribute?.("data-tweaker-project-id");
  const project = state.nodes.find((node) => node.type === "project" && node.id === projectId);
  if (!project) return null;
  return { project, row, taskId, group };
}

function isNativeTaskPinMenuItem(item) {
  const label = String(item?.textContent || "").replace(/\s+/g, " ").trim();
  return /^(?:un)?pin$/i.test(label);
}

function findNativeTaskMenu(doc) {
  const menus = [...(doc?.querySelectorAll?.('[role="menu"]') || [])]
    .filter((menu) => menu.getAttribute?.("data-state") === "open"
      && !menu.hasAttribute?.(PROJECT_COLOR_MENU_ATTR)
      && !menu.hasAttribute?.(PROJECT_TASK_MENU_ATTR)
      && !menu.hasAttribute?.(PROJECT_MENU_ATTR)
      && !menu.hasAttribute?.(PROJECT_NATIVE_MENU_ATTR))
    .filter((menu) => [...(menu.querySelectorAll?.('[role="menuitem"]') || [])].some(isNativeTaskPinMenuItem))
    .map((menu) => ({ menu, rect: menu.getBoundingClientRect?.() }))
    .filter(({ rect }) => rect && rect.width > 0 && rect.height > 0);
  return menus.length === 1 ? menus[0].menu : null;
}

function addMenuButton(doc, label, template, onClick) {
  const item = doc.createElement("div");
  item.setAttribute("role", "menuitem");
  item.setAttribute("tabindex", "-1");
  item.className = template?.className || "text-token-foreground rounded-lg px-2 py-2 text-sm flex items-center cursor-interaction";
  item.textContent = label;
  item.addEventListener("click", (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    onClick?.();
  });
  return item;
}

function injectProjectTaskPinMenu(doc, nativeMenu, context, onSelect) {
  if (!doc?.createElement || !nativeMenu || nativeMenu.querySelector?.(`[${PROJECT_TASK_MENU_ATTR}="pin"]`)) return null;
  const items = [...(nativeMenu.querySelectorAll?.('[role="menuitem"]') || [])];
  const nativePin = items.find(isNativeTaskPinMenuItem);
  if (!nativePin) return null;
  const isPinned = new Set(Array.isArray(context?.project?.pinnedTaskIds) ? context.project.pinnedTaskIds.map(String) : []).has(String(context.taskId));
  const local = addMenuButton(doc, isPinned ? "Unpin from project" : "Pin in project", nativePin, () => onSelect?.(!isPinned));
  local.setAttribute(PROJECT_TASK_MENU_ATTR, "pin");
  nativeMenu.insertBefore(local, nativePin);
  return local;
}

function openProjectTaskSortSubmenu(doc, anchor, context, onSelect) {
  const previous = doc.body.querySelector?.(`[${PROJECT_TASK_MENU_ATTR}="sort-submenu"]`);
  if (typeof previous?.[PROJECT_TASK_DISPOSE] === "function") previous[PROJECT_TASK_DISPOSE]();
  else previous?.remove?.();
  const submenu = doc.createElement("div");
  submenu.setAttribute("role", "menu");
  submenu.setAttribute(PROJECT_TASK_MENU_ATTR, "sort-submenu");
  submenu.className = "fixed z-[10000] flex min-w-[220px] flex-col rounded-xl border border-token-border p-1 shadow-lg";
  submenu.style?.setProperty?.("background-color", "var(--color-background-panel, var(--color-token-bg-fog))");
  const rect = anchor?.getBoundingClientRect?.();
  const viewportWidth = Number(doc.defaultView?.innerWidth) || 1200;
  const right = Number(rect?.right) || 8;
  submenu.style?.setProperty?.("left", `${right + 220 <= viewportWidth - 8 ? right : Math.max(8, (Number(rect?.left) || right) - 220)}px`);
  submenu.style?.setProperty?.("top", `${Math.max(8, Number(rect?.top) || 8)}px`);
  const current = normalizeTaskSort(context?.project?.taskSort);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener?.("pointerdown", onOutside, true);
    doc.removeEventListener?.("keydown", onKeydown, true);
    submenu[PROJECT_TASK_DISPOSE] = null;
    submenu.remove?.();
  };
  const onOutside = (event) => {
    if (submenu.contains?.(event.target) || anchor?.contains?.(event.target)) return;
    close();
  };
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  for (const option of TASK_SORT_OPTIONS) {
    const item = doc.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(option.value === current));
    item.className = "flex min-h-8 items-center justify-between rounded-md px-2 text-left text-sm text-token-text-primary hover:bg-token-foreground/10";
    item.textContent = option.label;
    if (option.value === current) {
      const check = doc.createElement("span");
      check.textContent = "✓";
      item.appendChild(check);
    }
    item.addEventListener("click", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      onSelect?.(option.value);
      close();
    });
    submenu.appendChild(item);
  }
  submenu[PROJECT_TASK_DISPOSE] = close;
  projectMenuSubmenuHost(doc, anchor)?.appendChild(submenu);
  doc.addEventListener?.("pointerdown", onOutside, true);
  doc.addEventListener?.("keydown", onKeydown, true);
  return submenu;
}

function installProjectTaskControls(api, getState, saveProject) {
  if (typeof document === "undefined") return () => {};
  let pending = null;
  let requestId = 0;
  let menuObserver = null;
  let menuTimer = null;
  const stopMenuObserver = () => {
    menuObserver?.disconnect?.();
    menuObserver = null;
    if (menuTimer !== null) window.clearTimeout(menuTimer);
    menuTimer = null;
  };
  const savePins = async (context, pinned) => {
    const ids = Array.isArray(context.project.pinnedTaskIds) ? context.project.pinnedTaskIds.map(String) : [];
    const next = pinned ? [...ids.filter((id) => id !== context.taskId), context.taskId] : ids.filter((id) => id !== context.taskId);
    if (next.length > MAX_PINNED_TASK_IDS) {
      window.alert(`This project already has ${MAX_PINNED_TASK_IDS} pinned tasks. Unpin one task first.`);
      return;
    }
    await saveProject?.(context.project.id, { pinnedTaskIds: next });
  };
  const inject = (context, id) => {
    if (!pending || pending !== context || requestId !== id) return;
    const nativeMenu = findNativeTaskMenu(document);
    if (!nativeMenu) return;
    injectProjectTaskPinMenu(document, nativeMenu, context, async (pinned) => {
      await savePins(context, pinned);
      nativeMenu.remove?.();
    });
  };
  const seed = (event) => {
    const context = resolveProjectTaskContext(api, getState?.(), event.target);
    if (!context) return;
    stopMenuObserver();
    const rect = context.row?.getBoundingClientRect?.();
    pending = { ...context, x: Number.isFinite(event.clientX) ? event.clientX : (rect?.right || 0), y: Number.isFinite(event.clientY) ? event.clientY : (rect?.top || 0) };
    const id = ++requestId;
    inject(pending, id);
    menuObserver = new MutationObserver(() => inject(pending, id));
    menuObserver.observe(document.body, { childList: true, subtree: true });
    menuTimer = window.setTimeout(() => {
      if (requestId === id) pending = null;
      stopMenuObserver();
    }, 1_500);
  };
  document.addEventListener("contextmenu", seed, true);
  document.addEventListener("pointerdown", seed, true);
  document.addEventListener("click", seed, true);
  return () => {
    document.removeEventListener("contextmenu", seed, true);
    document.removeEventListener("pointerdown", seed, true);
    document.removeEventListener("click", seed, true);
    stopMenuObserver();
    requestId += 1;
    pending = null;
  };
}

function applyNativeProjectColors(api, state) {
  if (!state?.nodes) return;
  clearNativeProjectColors();
  ensureProjectColorStyle();
  const projects = state.nodes.filter((node) => node.type === "project").sort((a, b) => b.name.length - a.name.length);
  const matches = nativeProjectMatches(api, projects);
  for (const match of matches) {
    const row = match.element;
    if (!(row instanceof HTMLElement)) continue;
    const label = projectLabelForRow(row);
    const identity = row.getAttribute?.("data-app-action-sidebar-project-id") || row.getAttribute?.("data-workspace-path") || row.getAttribute?.("data-project-path");
    const project = projectForNativeIdentity(projects, label, identity);
    if (!project) continue;
    const container = closestProjectContainer(row) || row;
    const header = projectHeaderForMatch(row, container, project);
    markProjectColorNode(container, "data-tweaker-project-color-group", project);
    markProjectColorNode(header, "data-tweaker-project-color-row", project);
    reorderProjectTaskRows(api, container, project);
    for (const icon of header.querySelectorAll?.("svg") || []) icon.setAttribute?.("data-tweaker-project-color-icon", "true");
    const projectNames = new Set(projectNativeNames(project));
    const title = [...(header.querySelectorAll?.("span") || [])]
      .find((node) => projectNames.has(String(node.textContent || "").trim()) || String(node.textContent || "").trim() === label);
    title?.setAttribute?.("data-tweaker-project-color-title", "true");
    const hasSelectedTask = markProjectTaskRows(container, project, header);
    if (isNativeSelected(header) || hasNativeSelectionAttribute(container) || hasSelectedTask) header.setAttribute("data-tweaker-project-selected", "true");
    applyCollapsedProjectActiveCount(api, container, header, project);
  }
  applyPinnedProjectColors(api, projects);
  applyUniformNativeRowSpacing();
}

function collectProjectIdentities(value, out, depth = 0) {
  if (!isRecord(value) || depth > 2) return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:hoverCardProjectId|projectId|workspaceId)$/i.test(key) && typeof item === "string") out.add(item);
    else if (depth < 2 && ["thread", "threadSummary", "conversation", "project", "item"].includes(key) && isRecord(item)) collectProjectIdentities(item, out, depth + 1);
  }
}

function projectIdFromPinnedFiber(api, row, projects) {
  const identities = new Set();
  let fiber = api?.react?.getFiber?.(row) || null;
  for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) collectProjectIdentities(fiber.memoizedProps, identities);
  const matches = new Set();
  for (const identity of identities) {
    const project = projectForNativeIdentity(projects, "", identity);
    if (project) matches.add(project);
  }
  return matches.size === 1 ? [...matches][0].id : null;
}

function closestThreadRow(node) {
  let cursor = node;
  let action = null;
  while (cursor) {
    if (!action && ["A", "BUTTON"].includes(String(cursor.tagName || "").toUpperCase())) action = cursor;
    if (cursor.getAttribute?.("data-app-action-sidebar-thread-row") !== null || cursor.getAttribute?.("role") === "listitem") return cursor;
    if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") break;
    cursor = cursor.parentElement;
  }
  return action || node;
}

function visibleSectionHeading(doc, label) {
  return [...(doc.querySelectorAll?.("h1, h2, h3, div, span") || [])]
    .filter((node) => String(node.textContent || "").replace(/\s+/g, " ").trim() === label)
    .map((node) => ({ node, rect: node.getBoundingClientRect?.() }))
    .filter(({ rect }) => rect && Number.isFinite(rect.top) && (rect.height === undefined || rect.height > 0))
    .sort((a, b) => a.rect.top - b.rect.top)[0] || null;
}

function pinnedProjectRows(doc = document) {
  const rows = new Set();
  for (const node of doc.querySelectorAll?.('[data-app-action-sidebar-thread-pinned="true"]') || []) rows.add(closestThreadRow(node));
  const pinned = visibleSectionHeading(doc, "Pinned");
  const projects = visibleSectionHeading(doc, "Projects");
  if (!pinned || !projects || projects.rect.top <= pinned.rect.bottom) return [...rows];
  for (const node of doc.querySelectorAll?.("[data-app-action-sidebar-thread-id]") || []) {
    const row = closestThreadRow(node);
    if (row.closest?.("[data-tweaker-project-color-group]")) continue;
    const rect = row.getBoundingClientRect?.();
    if (rect && rect.top >= pinned.rect.bottom && rect.bottom <= projects.rect.top) rows.add(row);
  }
  return [...rows];
}

function applyPinnedProjectColors(api, projects) {
  const threadProjects = new Map();
  for (const group of document.querySelectorAll?.("[data-tweaker-project-color-group]") || []) {
    const projectId = group.getAttribute?.("data-tweaker-project-id");
    if (!projectId) continue;
    for (const row of group.querySelectorAll?.("[data-app-action-sidebar-thread-id]") || []) {
      const threadId = row.getAttribute?.("data-app-action-sidebar-thread-id");
      if (!threadId) continue;
      const current = threadProjects.get(threadId);
      threadProjects.set(threadId, current && current !== projectId ? null : projectId);
    }
  }
  for (const row of pinnedProjectRows(document)) {
    if (!(row instanceof HTMLElement)) continue;
    const fiberProjectId = projectIdFromPinnedFiber(api, row, projects);
    const threadId = row.getAttribute?.("data-app-action-sidebar-thread-id") || row.querySelector?.("[data-app-action-sidebar-thread-id]")?.getAttribute?.("data-app-action-sidebar-thread-id");
    const fallbackProjectId = threadId ? threadProjects.get(threadId) : null;
    const projectId = fiberProjectId || fallbackProjectId;
    const project = projects.find((item) => item.id === projectId);
    if (!project) continue;
    markProjectColorNode(row, "data-tweaker-project-color-pinned", project);
  }
}

function activeProjectSessionCount(value, project, limits = {}) {
  const projectIds = new Set([project?.id, ...(project?.nativeProjectIds || [])].filter(Boolean).map(String));
  const seen = new Set();
  const sessionIds = new Set();
  let explicitCount = 0;
  let visited = 0;
  const maxDepth = limits.maxDepth || 6;
  const maxNodes = limits.maxNodes || 1_200;
  const activeStatuses = new Set(["running", "working", "streaming", "processing", "in_progress", "in-progress"]);
  const visit = (item, path, depth) => {
    if (!item || typeof item !== "object" || depth > maxDepth || visited >= maxNodes || seen.has(item)) return;
    seen.add(item); visited += 1;
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, path, depth + 1);
      return;
    }
    const entries = Object.entries(item);
    const boundProjectId = entries.find(([key, entry]) => /^(?:project|workspace)(?:Id|_id)$/i.test(key) && typeof entry === "string")?.[1];
    const belongsToProject = !boundProjectId || projectIds.size === 0 || projectIds.has(String(boundProjectId));
    if (belongsToProject) {
      for (const [key, entry] of entries) {
        if (/^(?:active|running|working)(?:Thread|Session|Conversation|Task)s?Count$/i.test(key) && Number.isSafeInteger(entry) && entry > explicitCount) explicitCount = entry;
        if (/^(?:active|running|working)(?:Thread|Session|Conversation|Task)(?:Ids|IDs|s)$/i.test(key) && Array.isArray(entry)) {
          const projectBoundEntries = entry.filter((record) => {
            if (!record || typeof record !== "object") return !!boundProjectId;
            const recordProjectId = record.projectId || record.project_id || record.workspaceId || record.workspace_id;
            return recordProjectId ? projectIds.has(String(recordProjectId)) : !!boundProjectId;
          });
          if (projectBoundEntries.length > explicitCount) explicitCount = projectBoundEntries.length;
        }
      }
      const sessionContext = /(?:^|\.)(?:threads?|sessions?|conversations?|tasks?|items?)(?:\.|$)/i.test(path);
      const sessionId = item.threadId || item.sessionId || item.conversationId || (sessionContext ? item.id : null);
      const status = String(item.status || item.state || item.phase || "").toLowerCase();
      const active = activeStatuses.has(status) || item.isRunning === true || item.isWorking === true || item.isStreaming === true || item.isGenerating === true;
      if (sessionContext && sessionId && active) sessionIds.add(String(sessionId));
    }
    for (const [key, entry] of entries) {
      if (entry && typeof entry === "object") visit(entry, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  visit(value, "", 0);
  return Math.max(explicitCount, sessionIds.size);
}

function activeProjectSessionCountFromFiber(api, node, project) {
  let count = 0;
  let fiber = api?.react?.getFiber?.(node) || null;
  for (let depth = 0; fiber && depth < 24; depth += 1, fiber = fiber.return) {
    count = Math.max(count, activeProjectSessionCount(fiber.memoizedProps, project));
    count = Math.max(count, activeProjectSessionCount(fiber.memoizedState, project));
  }
  return count;
}

function projectActiveSpinner(header) {
  const candidates = [...(header?.querySelectorAll?.('svg, [role="progressbar"]') || [])];
  const explicit = candidates.filter((node) => {
    const label = String(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.className?.baseVal || node.className || "");
    return /(?:animate-spin|spinner|progress|running|working|loading)/i.test(label);
  });
  if (explicit.length) return explicit[explicit.length - 1];
  return candidates.length > 1 ? candidates[candidates.length - 1] : null;
}

function projectSpinnerHost(spinner, header) {
  let host = spinner?.parentElement;
  let best = null;
  for (let depth = 0; host && host !== header && depth < 4; depth += 1, host = host.parentElement) {
    const rect = host.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0 && rect.width <= 40 && rect.height <= 40) best = host;
    else if (best) break;
  }
  return best;
}

function applyCollapsedProjectActiveCount(api, group, header, project) {
  if (visibleProjectTaskRows(group).length > 0) return;
  const count = activeProjectSessionCountFromFiber(api, group, project);
  if (count <= 1) return;
  const spinner = projectActiveSpinner(header);
  const host = projectSpinnerHost(spinner, header);
  if (!host) return;
  host.setAttribute("data-tweaker-project-active-count", String(count > 99 ? "99+" : count));
}

function measureNativeProjectRowGap(groups) {
  const gaps = [];
  const nodes = [...groups].filter((node) => node?.getBoundingClientRect && node.parentElement);
  for (let index = 1; index < nodes.length; index += 1) {
    if (nodes[index - 1].parentElement !== nodes[index].parentElement) continue;
    const previous = nodes[index - 1].getBoundingClientRect();
    const current = nodes[index].getBoundingClientRect();
    const gap = current.top - previous.bottom;
    if (Number.isFinite(gap) && gap > 0 && gap <= 32) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function visibleProjectTaskRows(group) {
  return [...(group?.querySelectorAll?.("[data-tweaker-project-color-task]") || [])]
    .filter((row) => {
      const rect = row.getBoundingClientRect?.();
      return rect && rect.width > 0 && rect.height > 0;
    });
}

function projectNavigationForNode(node) {
  let cursor = node;
  while (cursor) {
    if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

function nativeProjectsHeadingInset(group, navigationRect, headerRect) {
  const documentRef = group?.ownerDocument || (typeof document === "object" ? document : null);
  if (!documentRef?.querySelectorAll) return 0;
  const navigationRight = Number.isFinite(navigationRect.right)
    ? navigationRect.right
    : navigationRect.left + navigationRect.width;
  const headerTop = Number.isFinite(headerRect.top) ? headerRect.top : Number.POSITIVE_INFINITY;
  const candidates = [...documentRef.querySelectorAll("h1, h2, h3, div, span")]
    .filter((node) => String(node.textContent || "").replace(/\s+/g, " ").trim() === "Projects")
    .map((node) => node.getBoundingClientRect?.())
    .filter((rect) => rect && Number.isFinite(rect.left) && rect.left >= navigationRect.left && rect.left < navigationRight)
    .filter((rect) => (rect.height === undefined || rect.height > 0) && (!Number.isFinite(rect.top) || rect.top <= headerTop))
    .map((rect) => ({
      inset: rect.left - navigationRect.left,
      distance: Number.isFinite(rect.bottom) ? Math.max(0, headerTop - rect.bottom) : 0,
    }))
    .filter(({ inset }) => Number.isFinite(inset) && inset > 0)
    .sort((left, right) => left.distance - right.distance || left.inset - right.inset);
  return candidates[0]?.inset || 0;
}

function measureNativeProjectRowEndInset(group, header) {
  const navigation = projectNavigationForNode(group);
  const navigationRect = navigation?.getBoundingClientRect?.();
  const headerRect = header?.getBoundingClientRect?.();
  if (!navigationRect || !headerRect) return 0;
  const navigationWidth = Number.isFinite(navigationRect.width)
    ? navigationRect.width
    : navigationRect.right - navigationRect.left;
  const headerInset = headerRect.left - navigationRect.left;
  const inset = headerInset > 0 ? headerInset : nativeProjectsHeadingInset(group, navigationRect, headerRect);
  if (!Number.isFinite(navigationWidth) || navigationWidth <= 0 || !Number.isFinite(inset) || inset <= 0) return 0;
  return Math.min(inset, MAX_PROJECT_ROW_END_INSET, navigationWidth / 4);
}

function applyProjectGroupEndInset(group, header) {
  const inset = measureNativeProjectRowEndInset(group, header);
  if (inset > 0) group.style?.setProperty?.("--tweaker-project-row-end-inset", `${inset}px`);
  else group.style?.removeProperty?.("--tweaker-project-row-end-inset");
  return inset;
}

function measureNativeProjectRowGeometry(groups) {
  const collapsed = groups.filter((group) => visibleProjectTaskRows(group).length === 0);
  const references = collapsed.length >= 2 ? collapsed : groups;
  const headers = references.map((group) => group.querySelector?.("[data-tweaker-project-color-row]"))
    .filter((row) => row?.getBoundingClientRect)
    .map((row) => row.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  let gap = measureNativeProjectRowGap(collapsed.length >= 2 ? collapsed : groups);
  if (gap === null && references[0]?.parentElement && typeof getComputedStyle === "function") {
    const computed = getComputedStyle(references[0].parentElement);
    const value = Number.parseFloat(computed.rowGap || computed.gap);
    if (Number.isFinite(value) && value > 0 && value <= 32) gap = value;
  }
  return {
    gap,
    blockSize: median(headers.map((rect) => rect.height)),
    inlineSize: median(headers.map((rect) => rect.width)),
  };
}

function applyProjectTaskGeometry(group, header, geometry) {
  const headerRect = header?.getBoundingClientRect?.();
  if (!headerRect || headerRect.width <= 0 || headerRect.height <= 0) return;
  const rows = [...(group.querySelectorAll?.("[data-tweaker-project-color-task], [data-tweaker-project-show-more]") || [])];
  for (const row of rows) {
    const rect = row.getBoundingClientRect?.();
    const offset = rect && rect.width > 0 ? headerRect.left - rect.left : 0;
    row.style?.setProperty?.("--tweaker-project-native-row-block-size", `${geometry.blockSize || headerRect.height}px`);
    row.style?.setProperty?.("--tweaker-project-native-row-inline-size", `${geometry.inlineSize || headerRect.width}px`);
    row.style?.setProperty?.("--tweaker-project-native-row-offset", `${offset}px`);
  }
  const lists = [...(group.querySelectorAll?.('[role="list"]') || [])];
  for (const list of lists) list.setAttribute?.("data-tweaker-project-spacing-list", "true");
  if (!lists.length) {
    for (const row of rows) row.setAttribute?.("data-tweaker-project-fallback-spacing", "true");
  }
}

function applyUniformNativeRowSpacing() {
  const groups = [...(document.querySelectorAll?.("[data-tweaker-project-color-group]") || [])]
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  for (const group of groups) {
    const header = group.querySelector?.("[data-tweaker-project-color-row]");
    applyProjectGroupEndInset(group, header);
  }
  const geometry = measureNativeProjectRowGeometry(groups);
  const gapValue = geometry.gap === null ? "var(--spacing-px, 1px)" : `${geometry.gap}px`;
  document.documentElement?.style?.setProperty?.("--tweaker-project-native-row-gap", gapValue);
  for (const group of groups) {
    const header = group.querySelector?.("[data-tweaker-project-color-row]");
    applyProjectTaskGeometry(group, header, geometry);
  }
}

function installProjectSidebarResizeObserver(onResize) {
  if (typeof ResizeObserver !== "function" || typeof onResize !== "function") {
    return { sync() {}, dispose() {} };
  }
  let observed = new Set();
  let scheduled = null;
  let scheduledWithAnimationFrame = false;
  let disposed = false;
  const run = () => {
    scheduled = null;
    scheduledWithAnimationFrame = false;
    if (!disposed) onResize();
  };
  const observer = new ResizeObserver(() => {
    if (disposed || scheduled !== null) return;
    if (typeof requestAnimationFrame === "function") {
      scheduledWithAnimationFrame = true;
      scheduled = requestAnimationFrame(run);
    } else {
      scheduled = setTimeout(run, 0);
    }
  });
  return {
    sync() {
      if (disposed) return;
      const next = new Set();
      for (const group of document.querySelectorAll?.("[data-tweaker-project-color-group]") || []) {
        const navigation = projectNavigationForNode(group);
        if (navigation) next.add(navigation);
      }
      for (const navigation of observed) {
        if (!next.has(navigation)) observer.unobserve?.(navigation);
      }
      for (const navigation of next) {
        if (!observed.has(navigation)) observer.observe(navigation);
      }
      observed = next;
    },
    dispose() {
      disposed = true;
      if (scheduled !== null) {
        if (scheduledWithAnimationFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduled);
        else clearTimeout(scheduled);
      }
      scheduled = null;
      observer.disconnect();
      observed.clear();
    },
  };
}

function nativeProjectMatches(api, projects) {
  const matches = [...(api.react?.host?.query?.("projects") || [])];
  const seen = new Set(matches.map((match) => match?.element).filter(Boolean));
  const add = (element) => {
    if (!(element instanceof HTMLElement) || seen.has(element)) return;
    seen.add(element);
    matches.push({ element, source: "projects-fallback" });
  };
  for (const element of document.querySelectorAll?.('[data-app-action-sidebar-project-id], [data-workspace-path], [data-project-path]') || []) add(element);
  const represented = new Set();
  for (const match of matches) {
    const element = match?.element;
    const identity = element?.getAttribute?.("data-app-action-sidebar-project-id") || element?.getAttribute?.("data-workspace-path") || element?.getAttribute?.("data-project-path");
    const label = projectLabelForRow(element);
    const project = projectForNativeIdentity(projects, label, identity);
    if (project) represented.add(project.id);
  }
  if (projects.every((project) => represented.has(project.id))) return matches;
  const scope = projectNavigationScope(projects);
  for (const element of scope?.querySelectorAll?.('button, a, [role="button"]') || []) {
    if (!element.querySelector?.("svg")) continue;
    const label = projectLabelForRow(element);
    if (projectForNativeIdentity(projects, label, null)) add(element);
  }
  return matches;
}

function projectNavigationScope(projects) {
  const headings = [...(document.querySelectorAll?.("h1, h2, h3, div, span") || [])]
    .filter((element) => String(element.textContent || "").replace(/\s+/g, " ").trim() === "Projects");
  for (const heading of headings) {
    let cursor = heading.parentElement;
    while (cursor) {
      if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") {
        const labels = [...(cursor.querySelectorAll?.('button, a, [role="button"]') || [])].map(projectLabelForRow);
        if (projects.some((project) => labels.some((label) => projectForNativeIdentity([project], label, null)))) return cursor;
        break;
      }
      cursor = cursor.parentElement;
    }
  }
  return null;
}

function closestProjectContainer(row) {
  let cursor = row;
  let listItem = null;
  while (cursor) {
    if (cursor.classList?.contains?.("group/cwd")) return cursor;
    if (!listItem && cursor.getAttribute?.("role") === "listitem") listItem = cursor;
    if (cursor.tagName === "NAV" || cursor.tagName === "ASIDE" || cursor.getAttribute?.("role") === "navigation") return listItem;
    cursor = cursor.parentElement;
  }
  return listItem;
}

function projectHeaderForMatch(row, container, project) {
  if (row !== container) return row;
  const pathAction = container.querySelector?.("[data-app-action-sidebar-project-id]");
  if (pathAction instanceof HTMLElement) return pathAction;
  return [...(container.querySelectorAll?.("button") || [])]
    .find((node) => projectForNativeIdentity([project], projectLabelForRow(node), null)) || row;
}

function markProjectTaskRows(container, project, header) {
  let hasSelectedTask = false;
  const lists = [...(container.querySelectorAll?.('[role="list"]') || [])];
  for (const list of lists) {
    for (const task of list.querySelectorAll?.('[role="listitem"]') || []) {
      if (nearestRoleList(task) !== list) continue;
      markProjectColorNode(task, "data-tweaker-project-color-task", project);
      const action = taskActionForRow(task);
      action?.setAttribute?.("data-tweaker-project-task-action", "true");
      taskLabelForRow(task, action)?.setAttribute?.("data-tweaker-project-task-label", "true");
      if (isNativeSelected(task)) {
        task.setAttribute("data-tweaker-project-selected", "true");
        hasSelectedTask = true;
      }
    }
    const showMore = [...(list.querySelectorAll?.("button") || []), ...(list.querySelectorAll?.('[role="button"]') || [])]
      .find((node) => String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === "show more");
    if (showMore) markProjectColorNode(showMore, "data-tweaker-project-show-more", project);
  }
  if (!lists.length && container.classList?.contains?.("group/cwd")) {
    for (const task of container.querySelectorAll?.('button, a, [role="button"]') || []) {
      if (task === header || header?.contains?.(task)) continue;
      const label = String(task.textContent || "").replace(/\s+/g, " ").trim();
      if (!label) continue;
      if (label.toLowerCase() === "show more") {
        markProjectColorNode(task, "data-tweaker-project-show-more", project);
        continue;
      }
      markProjectColorNode(task, "data-tweaker-project-color-task", project);
      const action = taskActionForRow(task);
      action?.setAttribute?.("data-tweaker-project-task-action", "true");
      taskLabelForRow(task, action)?.setAttribute?.("data-tweaker-project-task-label", "true");
      if (isNativeSelected(task)) {
        task.setAttribute("data-tweaker-project-selected", "true");
        hasSelectedTask = true;
      }
    }
  }
  return hasSelectedTask;
}

function taskActionForRow(task) {
  const tagName = String(task?.tagName || "").toUpperCase();
  if (tagName === "A" || tagName === "BUTTON" || task?.getAttribute?.("role") === "button") return task;
  return [...(task?.querySelectorAll?.('a, button, [role="button"]') || [])]
    .find((node) => String(node.textContent || "").trim() || [...(node.querySelectorAll?.("span") || [])].some((span) => String(span.textContent || "").trim())) || null;
}

function taskLabelForRow(task, interactive = taskActionForRow(task)) {
  const scope = interactive || task;
  const spans = [...(scope.querySelectorAll?.("span") || [])].filter(isTaskLabelCandidate);
  const accessibleName = String(scope.getAttribute?.("aria-label") || scope.getAttribute?.("title") || task.getAttribute?.("aria-label") || "").trim();
  const named = accessibleName && spans.find((node) => accessibleName.includes(String(node.textContent || "").trim()));
  const visuallyPrimary = spans.find((node) => /(?:^|\s)(?:truncate|line-clamp-\d+)(?:\s|$)/.test(String(node.className || "")));
  return named || visuallyPrimary || spans[0] || interactive || task;
}

function isTaskLabelCandidate(node) {
  if (!String(node.textContent || "").trim()) return false;
  if (node.getAttribute?.("aria-hidden") === "true" || node.getAttribute?.("role") === "status") return false;
  if (/^(?:badge|status|timestamp|time|metadata?)$/i.test(String(node.getAttribute?.("data-slot") || ""))) return false;
  if (/(?:^|[-_\s])(?:badge|status|timestamp|metadata?)(?:$|[-_\s])/.test(String(node.className || "").toLowerCase())) return false;
  return ![...(node.querySelectorAll?.("span") || [])].some((child) => String(child.textContent || "").trim());
}

function nearestRoleList(node) {
  let cursor = node?.parentElement;
  while (cursor) {
    if (cursor.getAttribute?.("role") === "list") return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

function isNativeSelected(node) {
  if (hasNativeSelectionAttribute(node)) return true;
  const descendants = [...(node?.querySelectorAll?.("[aria-current]") || []), ...(node?.querySelectorAll?.('[aria-selected="true"]') || []), ...(node?.querySelectorAll?.('[data-state="active"]') || [])];
  return descendants.some(hasNativeSelectionAttribute);
}

function hasNativeSelectionAttribute(element) {
  const current = element?.getAttribute?.("aria-current");
  return (current !== null && current !== "false") || element?.getAttribute?.("aria-selected") === "true" || element?.getAttribute?.("data-state") === "active";
}

function projectLabelForRow(row) {
  return (row?.getAttribute?.("data-project-name") || row?.getAttribute?.("aria-label") || row?.getAttribute?.("title") || row?.textContent || "").replace(/\s+/g, " ").trim();
}

function projectColorForeground(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(color || "").trim());
  if (!match) return "var(--gray-0)";
  const channels = match[1].match(/.{2}/g).map((value) => Number.parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "var(--gray-1000)" : "var(--gray-0)";
}

function markProjectColorNode(node, attribute, project) {
  node.setAttribute(attribute, "true");
  node.setAttribute("data-tweaker-project-id", project.id);
  node.setAttribute("data-tweaker-project-overlay", project.overlayIntensity || "medium");
  node.style.setProperty("--tweaker-project-color", project.color);
  node.style.setProperty("--tweaker-project-foreground", projectColorForeground(project.color));
}

function clearNativeProjectColors() {
  for (const node of document.querySelectorAll("[data-tweaker-project-color-group], [data-tweaker-project-color-row], [data-tweaker-project-color-task], [data-tweaker-project-color-pinned], [data-tweaker-project-show-more], [data-tweaker-project-spaced-row], [data-tweaker-project-fallback-spacing], [data-tweaker-project-active-count]")) {
    node.removeAttribute("data-tweaker-project-color-group");
    node.removeAttribute("data-tweaker-project-color-row");
    node.removeAttribute("data-tweaker-project-color-task");
    node.removeAttribute("data-tweaker-project-color-pinned");
    node.removeAttribute("data-tweaker-project-show-more");
    node.removeAttribute("data-tweaker-project-spaced-row");
    node.removeAttribute("data-tweaker-project-fallback-spacing");
    node.removeAttribute("data-tweaker-project-active-count");
    node.removeAttribute("data-tweaker-project-selected");
    node.removeAttribute("data-tweaker-project-overlay");
    node.removeAttribute("data-tweaker-project-id");
    node.style.removeProperty("--tweaker-project-color");
    node.style.removeProperty("--tweaker-project-foreground");
    node.style.removeProperty("--tweaker-project-native-row-block-size");
    node.style.removeProperty("--tweaker-project-native-row-inline-size");
    node.style.removeProperty("--tweaker-project-native-row-offset");
    node.style.removeProperty("--tweaker-project-row-end-inset");
  }
  for (const node of document.querySelectorAll("[data-tweaker-project-color-icon], [data-tweaker-project-color-title], [data-tweaker-project-task-action], [data-tweaker-project-task-label]")) {
    node.removeAttribute("data-tweaker-project-color-icon");
    node.removeAttribute("data-tweaker-project-color-title");
    node.removeAttribute("data-tweaker-project-task-action");
    node.removeAttribute("data-tweaker-project-task-label");
  }
  for (const node of document.querySelectorAll("[data-tweaker-project-spacing-list], [data-tweaker-project-spacing-pinned-list]")) {
    node.removeAttribute("data-tweaker-project-spacing-list");
    node.removeAttribute("data-tweaker-project-spacing-pinned-list");
  }
  document.documentElement?.style?.removeProperty?.("--tweaker-project-row-gap");
  document.documentElement?.style?.removeProperty?.("--tweaker-project-native-row-gap");
}

function removeProjectColorArtifacts() {
  if (typeof document === "undefined") return;
  restoreProjectTaskOrder();
  clearNativeProjectColors();
  document.querySelectorAll(`[${PROJECT_COLOR_MENU_ATTR}]`).forEach((node) => {
    if (typeof node[PROJECT_COLOR_DISPOSE] === "function") node[PROJECT_COLOR_DISPOSE]();
    else node.remove();
  });
  document.querySelectorAll(`[${PROJECT_TASK_MENU_ATTR}]`).forEach((node) => {
    if (typeof node[PROJECT_TASK_DISPOSE] === "function") node[PROJECT_TASK_DISPOSE]();
    else node.remove();
  });
  document.querySelectorAll(`[${PROJECT_MENU_ATTR}]`).forEach((node) => {
    if (typeof node[PROJECT_MENU_DISPOSE] === "function") node[PROJECT_MENU_DISPOSE]();
    else node.remove();
  });
  document.querySelectorAll(`[${PROJECT_NATIVE_MENU_ATTR}]`).forEach((node) => node.removeAttribute?.(PROJECT_NATIVE_MENU_ATTR));
  document.getElementById(PROJECT_COLOR_STYLE_ID)?.remove();
}

module.exports = {
  PROJECT_COLOR_MENU_ATTR,
  PROJECT_MENU_ATTR,
  PROJECT_NATIVE_MENU_ATTR,
  snapshotNativeProjectMenuCommands,
  interceptNativeProjectMenu,
  injectNativeProjectSettingsMenu,
  openProjectSettingsSubmenu,
  openProjectColorSubmenu,
  openNativeProjectEditDialog,
  installProjectColorControls,
  resolveProjectContext,
  unambiguousProjectForNativeIdentity,
  nativeProjectSurfaceFingerprint,
  findNativeProjectMenu,
  ensureProjectColorStyle,
  applyNativeProjectColors,
  normalizeTaskSort,
  taskIdForRow,
  taskTimestamp,
  taskTimestampFromRecord,
  taskTimestampFromFiber,
  taskRecordsForRows,
  orderProjectTaskRecords,
  reorderProjectTaskRows,
  pruneDetachedTaskPlacements,
  restoreProjectTaskOrder,
  taskRowsForContainer,
  resolveProjectTaskContext,
  findNativeTaskMenu,
  injectProjectTaskPinMenu,
  openProjectTaskSortSubmenu,
  installProjectTaskControls,
  collectProjectIdentities,
  projectIdFromPinnedFiber,
  pinnedProjectRows,
  activeProjectSessionCount,
  activeProjectSessionCountFromFiber,
  measureNativeProjectRowGap,
  measureNativeProjectRowGeometry,
  measureNativeProjectRowEndInset,
  applyProjectGroupEndInset,
  applyProjectTaskGeometry,
  installProjectSidebarResizeObserver,
  nativeProjectMatches,
  projectColorForeground,
  clearNativeProjectColors,
  removeProjectColorArtifacts,
};
