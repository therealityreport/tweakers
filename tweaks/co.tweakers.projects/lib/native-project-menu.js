"use strict";

// Codex currently sends project dropdowns through Electron's native Menu API.
// This bridge recognizes only those project-shaped menus, pauses their popup,
// and lets the Projects renderer draw the same commands with Codex's own menu
// surface. Selecting a host command calls the original Electron MenuItem click
// function, so Codex keeps ownership of edits, dialogs, Finder actions, and
// destructive behavior.

const REQUEST_CHANNEL = "native-project-menu.request";
const ACTION_CHANNEL = "native-project-menu.action";
const BRIDGE_MARKER = Symbol.for("co.tweakers.projects.nativeProjectMenuBridge");
const DEFAULT_ACCEPT_TIMEOUT_MS = 350;
const DEFAULT_OWNED_TIMEOUT_MS = 60 * 1000;
const MAX_MENU_DEPTH = 4;
const MAX_MENU_ITEMS = 48;
const MAX_LABEL_LENGTH = 160;
const MAX_ICON_DATA_URL_LENGTH = 256 * 1024;

function normalizedMenuLabel(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH) : "";
}

function projectMenuLabelSignature(items) {
  const labels = (Array.isArray(items) ? items : [])
    .filter((item) => item?.visible !== false && item?.type !== "separator")
    .map((item) => normalizedMenuLabel(item?.label));
  const hasRemoveProject = labels.some((label) => /^(?:remove|delete) (?:local )?project$/i.test(label));
  const projectSignals = labels.filter((label) => /^(?:pin|unpin|edit(?: project)?|section|reveal in finder|create permanent worktree|archive chats)$/i.test(label));
  const hasProjectSpecificSignal = labels.some((label) => /^(?:reveal in finder|create permanent worktree|archive chats)$/i.test(label));
  return {
    labels,
    hasRemoveProject,
    hasProjectSpecificSignal,
    projectSignalCount: new Set(projectSignals.map((label) => label.toLowerCase())).size,
  };
}

function isNativeProjectMenu(menu) {
  const signature = projectMenuLabelSignature(menu?.items);
  return signature.hasRemoveProject && signature.hasProjectSpecificSignal && signature.projectSignalCount >= 2;
}

function menuItemIconDataUrl(item) {
  const icon = item?.icon;
  let value = null;
  try {
    if (typeof icon === "string" && /^data:image\/(?:png|webp|svg\+xml);base64,/i.test(icon)) value = icon;
    else if (icon && typeof icon.toDataURL === "function" && icon.isEmpty?.() !== true) value = icon.toDataURL();
  } catch {
    value = null;
  }
  return typeof value === "string" && value.length <= MAX_ICON_DATA_URL_LENGTH ? value : null;
}

function serializeNativeMenuItems(items, depth = 0, budget = { count: 0 }, prefix = "") {
  if (!Array.isArray(items) || depth > MAX_MENU_DEPTH) return null;
  const serialized = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || item.visible === false) continue;
    budget.count += 1;
    if (budget.count > MAX_MENU_ITEMS) return null;
    const path = prefix ? `${prefix}.${index}` : String(index);
    if (item.type === "separator") {
      serialized.push({ path, type: "separator" });
      continue;
    }
    // Native role, toggle, header, and palette behavior is implemented by
    // Electron itself. Do not replace a menu containing any of those item
    // types because calling a raw click function would not reproduce native
    // state transitions or first-responder actions.
    if (item.role || ["checkbox", "radio", "header", "palette"].includes(item.type)) return null;
    const label = normalizedMenuLabel(item.label);
    if (!label) continue;
    const submenuItems = Array.isArray(item.submenu?.items)
      ? serializeNativeMenuItems(item.submenu.items, depth + 1, budget, path)
      : null;
    if (Array.isArray(item.submenu?.items) && submenuItems === null) return null;
    const hasSubmenu = Array.isArray(item.submenu?.items);
    if (hasSubmenu && !submenuItems?.length) return null;
    if (!hasSubmenu && typeof item.click !== "function") return null;
    const type = hasSubmenu ? "submenu" : "normal";
    serialized.push({
      path,
      type,
      label,
      sublabel: normalizedMenuLabel(item.sublabel) || null,
      accelerator: normalizedMenuLabel(item.accelerator) || null,
      toolTip: normalizedMenuLabel(item.toolTip) || null,
      enabled: item.enabled !== false,
      iconDataUrl: menuItemIconDataUrl(item),
      submenu: submenuItems?.length ? submenuItems : null,
    });
  }
  return serialized;
}

function sanitizedSerializedMenuItems(items, depth = 0, budget = { count: 0 }) {
  if (!Array.isArray(items) || depth > MAX_MENU_DEPTH) return null;
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    budget.count += 1;
    if (budget.count > MAX_MENU_ITEMS) return null;
    const path = typeof item.path === "string" && /^\d+(?:\.\d+){0,4}$/.test(item.path) ? item.path : null;
    if (!path) return null;
    if (item.type === "separator") {
      result.push({ path, type: "separator" });
      continue;
    }
    const label = normalizedMenuLabel(item.label);
    if (!label) return null;
    const submenu = item.submenu === null || item.submenu === undefined
      ? null
      : sanitizedSerializedMenuItems(item.submenu, depth + 1, budget);
    if (item.submenu && submenu === null) return null;
    if (!["normal", "submenu"].includes(item.type)) return null;
    const type = item.type;
    const iconDataUrl = typeof item.iconDataUrl === "string"
      && item.iconDataUrl.length <= MAX_ICON_DATA_URL_LENGTH
      && /^data:image\/(?:png|webp|svg\+xml);base64,/i.test(item.iconDataUrl)
      ? item.iconDataUrl
      : null;
    result.push({
      path,
      type,
      label,
      sublabel: normalizedMenuLabel(item.sublabel) || null,
      accelerator: normalizedMenuLabel(item.accelerator) || null,
      toolTip: normalizedMenuLabel(item.toolTip) || null,
      enabled: item.enabled !== false,
      iconDataUrl,
      submenu: submenu?.length ? submenu : null,
    });
  }
  return result;
}

function validateNativeProjectMenuRequest(payload) {
  if (!payload || typeof payload !== "object" || payload.schemaVersion !== 1) return null;
  const requestId = typeof payload.requestId === "string" && /^[a-f0-9-]{16,80}$/i.test(payload.requestId)
    ? payload.requestId
    : null;
  if (!requestId) return null;
  const items = sanitizedSerializedMenuItems(payload.items);
  if (!items?.length) return null;
  const signature = projectMenuLabelSignature(items);
  if (!signature.hasRemoveProject || !signature.hasProjectSpecificSignal || signature.projectSignalCount < 2) return null;
  return { schemaVersion: 1, requestId, items };
}

function nativeMenuItemAtPath(menu, path) {
  if (!menu || typeof path !== "string" || !/^\d+(?:\.\d+){0,4}$/.test(path)) return null;
  const indexes = path.split(".").map((value) => Number(value));
  let currentMenu = menu;
  let item = null;
  for (let depth = 0; depth < indexes.length; depth += 1) {
    const items = currentMenu?.items;
    const index = indexes[depth];
    if (!Array.isArray(items) || !Number.isSafeInteger(index) || index < 0 || index >= items.length) return null;
    item = items[index];
    if (depth < indexes.length - 1) currentMenu = item?.submenu;
  }
  return item || null;
}

function installNativeProjectMenuBridge(api, dependencies = {}) {
  const electron = dependencies.electron || require("electron");
  const Menu = electron?.Menu;
  const popupPrototype = Menu?.prototype;
  const originalPopup = popupPrototype?.popup;
  const timeoutMs = Number.isFinite(dependencies.acceptTimeoutMs)
    ? Math.max(25, dependencies.acceptTimeoutMs)
    : DEFAULT_ACCEPT_TIMEOUT_MS;
  const ownedTimeoutMs = Number.isFinite(dependencies.ownedTimeoutMs)
    ? Math.max(250, dependencies.ownedTimeoutMs)
    : DEFAULT_OWNED_TIMEOUT_MS;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  const randomUUID = dependencies.randomUUID || (() => require("node:crypto").randomUUID());
  const now = dependencies.now || Date.now;
  if (!popupPrototype || typeof originalPopup !== "function"
    || typeof api?.ipc?.handleWithContext !== "function"
    || typeof api?.ipc?.sendToRenderer !== "function") {
    api?.log?.warn?.("Native project menu bridge unavailable; preserving Codex native menus");
    return { dispose() {}, active: false };
  }

  const pending = new Map();
  let disposed = false;

  const settle = (entry) => {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
    pending.delete(entry.requestId);
    return true;
  };

  const completeDismiss = (entry) => {
    if (!settle(entry)) return false;
    try { entry.options?.callback?.(); } catch (error) { api.log?.warn?.("Project menu dismiss callback failed", String(error)); }
    return true;
  };

  const fallback = (entry, reason) => {
    if (!settle(entry)) return false;
    api.log?.debug?.("Project menu bridge fell back to native popup", {
      requestId: entry.requestId,
      rendererId: entry.rendererId,
      elapsedMs: Math.max(0, now() - entry.createdAt),
      reason,
    });
    try {
      Reflect.apply(originalPopup, entry.menu, entry.args);
    } catch (error) {
      api.log?.warn?.("Native project menu fallback failed", String(error));
      try { entry.options?.callback?.(); } catch {}
    }
    return true;
  };

  const unregisterAction = api.ipc.handleWithContext(ACTION_CHANNEL, (context, message) => {
    const requestId = typeof message?.requestId === "string" ? message.requestId : "";
    const entry = pending.get(requestId);
    const senderRendererId = Number.isSafeInteger(context?.sender?.webContentsId)
      ? context.sender.webContentsId
      : null;
    api.log?.debug?.("Project menu bridge action received", {
      requestId: /^[a-f0-9-]{16,80}$/i.test(requestId) ? requestId : null,
      action: ["accept", "reject", "dismiss", "select"].includes(message?.action) ? message.action : "invalid",
      senderRendererId,
      expectedRendererId: entry?.rendererId || null,
      rendererMatches: Boolean(entry && entry.rendererId === senderRendererId),
      state: entry?.state || "missing",
      elapsedMs: entry ? Math.max(0, now() - entry.createdAt) : null,
    });
    if (!entry || entry.rendererId !== context?.sender?.webContentsId) return { ok: false, error: "unknown-request" };
    if (message?.action === "accept") {
      if (entry.state !== "waiting") return { ok: false, error: "already-owned" };
      entry.state = "owned";
      if (entry.timer !== null) clearTimer(entry.timer);
      entry.timer = setTimer(() => completeDismiss(entry), ownedTimeoutMs);
      api.log?.info?.("Project menu routed to Codex-styled renderer surface", {
        requestId,
        rendererId: entry.rendererId,
        elapsedMs: Math.max(0, now() - entry.createdAt),
      });
      return { ok: true };
    }
    if (message?.action === "reject") {
      if (entry.state !== "waiting") return { ok: false, error: "already-owned" };
      fallback(entry, "renderer-rejected");
      return { ok: true, fallback: true };
    }
    if (message?.action === "dismiss") {
      if (entry.state !== "owned") return { ok: false, error: "not-owned" };
      completeDismiss(entry);
      return { ok: true };
    }
    if (message?.action === "select") {
      if (entry.state !== "owned") return { ok: false, error: "not-owned" };
      const item = nativeMenuItemAtPath(entry.menu, message.path);
      if (!item || item.visible === false || item.enabled === false || item.submenu || typeof item.click !== "function") {
        completeDismiss(entry);
        return { ok: false, error: "invalid-command" };
      }
      settle(entry);
      try {
        // Electron documents MenuItem.click as (event, focusedWindow,
        // focusedWebContents). The original Codex callback then resolves the
        // bridge promise with this item's untouched host ID.
        item.click(undefined, entry.options?.window, entry.options?.window?.webContents);
        try { entry.options?.callback?.(); } catch {}
        return { ok: true };
      } catch (error) {
        api.log?.warn?.("Original Codex project command failed", String(error));
        try { entry.options?.callback?.(); } catch {}
        return { ok: false, error: "command-failed" };
      }
    }
    return { ok: false, error: "invalid-action" };
  });

  const wrappedPopup = function projectsNativeMenuPopup(...args) {
    if (disposed || !isNativeProjectMenu(this)) return Reflect.apply(originalPopup, this, args);
    const options = args[0] && typeof args[0] === "object" ? args[0] : {};
    const rendererId = options.window?.webContents?.id;
    if (!Number.isSafeInteger(rendererId) || rendererId <= 0) return Reflect.apply(originalPopup, this, args);
    const items = serializeNativeMenuItems(this.items);
    if (!items?.length) return Reflect.apply(originalPopup, this, args);
    const requestId = randomUUID();
    const entry = {
      requestId,
      rendererId,
      menu: this,
      args,
      options,
      state: "waiting",
      settled: false,
      timer: null,
      createdAt: now(),
    };
    pending.set(requestId, entry);
    entry.timer = setTimer(() => fallback(entry, "renderer-timeout"), timeoutMs);
    const sent = api.ipc.sendToRenderer(rendererId, REQUEST_CHANNEL, {
      schemaVersion: 1,
      requestId,
      items,
    });
    api.log?.info?.("Project menu bridge request dispatched", {
      requestId,
      rendererId,
      itemCount: items.length,
      timeoutMs,
      delivered: Boolean(sent),
    });
    if (!sent) {
      fallback(entry, "renderer-unavailable");
      return undefined;
    }
    return undefined;
  };
  wrappedPopup[BRIDGE_MARKER] = true;
  try {
    popupPrototype.popup = wrappedPopup;
  } catch (error) {
    try { unregisterAction?.(); } catch {}
    api.log?.warn?.("Native project menu popup hook could not be installed", String(error));
    return { dispose() {}, active: false };
  }
  if (popupPrototype.popup !== wrappedPopup) {
    try { unregisterAction?.(); } catch {}
    api.log?.warn?.("Native project menu popup hook was rejected; preserving Codex native menus");
    return { dispose() {}, active: false };
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (popupPrototype.popup === wrappedPopup) popupPrototype.popup = originalPopup;
    for (const entry of [...pending.values()]) {
      if (entry.state === "waiting") fallback(entry, "bridge-disposed");
      else completeDismiss(entry);
    }
    try { unregisterAction?.(); } catch {}
  };

  api.log?.info?.("Native project menu bridge ready");
  return { dispose, active: true, pendingCount: () => pending.size };
}

module.exports = {
  REQUEST_CHANNEL,
  ACTION_CHANNEL,
  normalizedMenuLabel,
  projectMenuLabelSignature,
  isNativeProjectMenu,
  serializeNativeMenuItems,
  sanitizedSerializedMenuItems,
  validateNativeProjectMenuRequest,
  nativeMenuItemAtPath,
  installNativeProjectMenuBridge,
};
