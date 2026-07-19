"use strict";

const STYLE_ID = "tweaker-titlebar-controls-style";
const ATTR = "data-tweaker-titlebar-controls";
const CONTROL_SELECTOR = [
  '[data-titlebar-control]',
  '[aria-label="Hide sidebar"]',
  '[aria-label="Show sidebar"]',
  '[aria-label="Back"]',
  '[aria-label="Forward"]',
  '[title="Back"]',
  '[title="Forward"]',
].join(", ");

const helpers = { detectLayout, detectWindowLayout: detectLayout, alignControls, computeAlignment: alignControls, computeControlTransform, cleanup, teardown: cleanup, isMacPlatform, setTransform, pruneDetachedSnapshots, shouldShowRefresh, refreshTooltip };
const instances = new WeakMap();

module.exports = {
  start(api) {
    if (api?.process === "main" || typeof document === "undefined") return;
    // macOS-only tweak. Bail unless we can positively confirm macOS — a titlebar
    // relayout on another OS is at best a no-op and at worst misaligns controls.
    // navigator.platform is increasingly empty, so also consult userAgentData /
    // userAgent instead of short-circuiting the whole guard on an empty string.
    const state = { api, observers: [], observerConfigs: [], styles: [], listeners: [], snapshots: new Map(), disposed: false, pending: null, refreshButton: null, page: null };
    instances.set(this, state);
    const supported = isMacPlatform();
    const onResize = () => schedule(state);
    const onFullscreen = () => schedule(state);
    if (supported) {
      ensureStyle(state);
      apply(state);
      window.addEventListener?.("resize", onResize);
      document.addEventListener?.("fullscreenchange", onFullscreen);
      state.listeners.push([window, "resize", onResize], [document, "fullscreenchange", onFullscreen]);
    }
    const onFocus = () => void refreshRefreshButton(state);
    window.addEventListener?.("focus", onFocus);
    state.listeners.push([window, "focus", onFocus]);
    const disposeRefreshStatus = api?.codex?.refresh?.onStatusChanged?.(() => void refreshRefreshButton(state));
    if (disposeRefreshStatus) state.listeners.push({ remove: disposeRefreshStatus });
    void refreshRefreshButton(state);
    state.page = api.settings?.registerPage?.({
      id: "titlebar-controls",
      title: "Titlebar Controls",
      description: "Native-safe titlebar alignment and Tweakers refresh status.",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M3 7.5h14M6 5.75h.01M8 5.75h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      render(root) { return renderTitlebarPage(state, root); },
    });
    if (supported) {
      const disposeHost = api.react?.host?.observe?.(["titlebar-controls"], () => schedule(state));
      if (disposeHost) state.listeners.push({ remove: disposeHost });
    }
  },
  stop() {
    const state = instances.get(this);
    if (!state) return;
    cleanup(state);
    state.page?.unregister?.();
    instances.delete(this);
  },
  _test: helpers,
  __test: helpers,
};

function renderTitlebarPage(state, root) {
  let disposed = false;
  const paint = async () => {
    if (disposed) return;
    root.replaceChildren();
    const detected = state.api?.react?.host?.snapshot?.("titlebar-controls")?.count || 0;
    const status = document.createElement("div");
    status.className = "rounded-lg border border-token-border p-3 text-sm text-token-text-secondary";
    status.textContent = isMacPlatform()
      ? `Detected titlebar controls: ${detected}. Aligned controls: ${state.snapshots.size}.`
      : "Titlebar alignment is available only in the macOS ChatGPT app; refresh status remains available here.";
    root.appendChild(status);
    const refreshCard = document.createElement("div");
    refreshCard.className = "flex items-center justify-between gap-4 rounded-lg border border-token-border p-3";
    const copy = document.createElement("div");
    copy.className = "text-sm text-token-text-secondary";
    copy.textContent = "Checking Tweakers refresh status…";
    refreshCard.appendChild(copy);
    root.appendChild(refreshCard);
    try {
      const refresh = await state.api.codex?.refresh?.getStatus?.();
      if (disposed) return;
      copy.textContent = refresh?.detail || (refresh?.available ? "A Tweakers refresh is available." : "Tweakers is current.");
      if (shouldShowRefresh(refresh)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "rounded-md border border-token-border bg-token-foreground/5 px-3 py-1.5 text-sm text-token-text-primary";
        button.textContent = "Refresh ChatGPT";
        button.addEventListener("click", async () => {
          if (!window.confirm("Refresh ChatGPT? The app will quit and reopen.")) return;
          button.disabled = true;
          await state.api.codex.refresh.start("smart");
        });
        refreshCard.appendChild(button);
      }
    } catch (error) {
      copy.textContent = `Refresh status unavailable: ${String(error?.message || error)}`;
    }
  };
  void paint();
  return () => { disposed = true; root.replaceChildren(); };
}

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  const uaDataPlatform = navigator.userAgentData && navigator.userAgentData.platform;
  const signal = `${uaDataPlatform || ""} ${navigator.platform || ""} ${navigator.userAgent || ""}`.trim();
  // No signal at all → assume the host is the macOS desktop app we ship into.
  if (!signal) return true;
  return /mac/i.test(signal);
}

async function refreshRefreshButton(state) {
  const refresh = state.api?.codex?.refresh;
  if (!refresh || state.disposed) return;
  try {
    const status = await refresh.getStatus();
    if (state.disposed) return;
    if (!shouldShowRefresh(status)) {
      state.refreshButton?.remove?.();
      state.refreshButton = null;
      return;
    }
    const button = state.refreshButton || createRefreshButton(state);
    button.title = refreshTooltip(status);
    button.setAttribute("aria-label", button.title);
    button.dataset.refreshSource = status.source;
    if (!button.isConnected) insertRefreshButton(button);
    state.refreshButton = button;
  } catch (error) {
    state.api?.log?.warn?.("refresh status unavailable", error);
  }
}

function shouldShowRefresh(status) {
  return Boolean(status?.available && (status.source === "development" || status.source === "stable"));
}

function refreshTooltip(status) {
  return status?.source === "development"
    ? "Refresh ChatGPT from development checkout"
    : "Install the latest stable Tweakers release";
}

function createRefreshButton(state) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-token-text-secondary hover:text-token-text-primary hover:bg-token-foreground/10 inline-flex h-7 w-7 items-center justify-center rounded-md cursor-interaction";
  button.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16 6V2m0 0h-4m4 0-3 3a6 6 0 1 0 1.6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const click = async () => {
    const source = button.dataset.refreshSource === "development" ? "development checkout" : "stable release";
    if (!window.confirm?.(`Refresh ChatGPT from the ${source}? ChatGPT will quit and reopen.`)) return;
    button.disabled = true;
    button.style.opacity = "0.6";
    try {
      const result = await state.api.codex.refresh.start("smart");
      if (!result?.started) {
        button.disabled = false;
        button.style.opacity = "";
        await refreshRefreshButton(state);
      }
    }
    catch (error) {
      button.disabled = false;
      button.style.opacity = "";
      state.api?.log?.error?.("local refresh failed", error);
    }
  };
  button.addEventListener("click", click);
  state.listeners.push([button, "click", click]);
  return button;
}

function insertRefreshButton(button) {
  const logo = document.querySelector?.('[data-testid*="logo" i], [aria-label="Codex"], a[href="/"] img, a[href="/"] svg');
  const anchor = logo?.closest?.("a, button, div") || logo;
  if (anchor?.parentElement) anchor.insertAdjacentElement("afterend", button);
  else {
    const firstControl = document.querySelector?.(CONTROL_SELECTOR);
    firstControl?.parentElement?.insertBefore?.(button, firstControl);
  }
}

function findObserverTarget() {
  // Scope to the titlebar shell when present so we are not woken by every DOM
  // mutation in the whole transcript; fall back to the document element.
  const shell = document.querySelector?.('[data-titlebar-layout], [data-titlebar-shell]');
  return shell || document.documentElement || document;
}

function pauseObservers(state) {
  for (const config of state.observerConfigs || []) {
    config.observer.takeRecords?.();
    config.observer.disconnect();
  }
}

function resumeObservers(state) {
  if (state.disposed) return;
  for (const config of state.observerConfigs || []) {
    config.observer.takeRecords?.();
    config.observer.observe(config.target, config.options);
  }
}

function setTransform(control, value, priority) {
  // Only write when the value actually changes, so our own writes do not feed
  // the MutationObserver a fresh mutation each frame (the old feedback loop).
  const current = control.style?.getPropertyValue?.("transform") || "";
  const currentPriority = control.style?.getPropertyPriority?.("transform") || "";
  if (current === (value || "") && currentPriority === (priority || "")) return false;
  if (value) control.style?.setProperty?.("transform", value, priority);
  else control.style?.removeProperty?.("transform");
  return true;
}

function detectLayout(input = document) {
  if (input && typeof input === "object" && Number.isFinite(input.contentLeft)) {
    return {
      windowLeft: number(input.windowLeft, 0),
      contentLeft: number(input.contentLeft, 0),
      contentTop: number(input.contentTop, 0),
      contentWidth: number(input.contentWidth, 0),
      titlebarHeight: number(input.titlebarHeight, 0),
    };
  }
  const root = input?.querySelector ? input : document;
  const shell = root.querySelector?.('[data-titlebar-layout], [data-titlebar-shell], [style*="--spacing-token-safe-header-left"]') || root.documentElement || root;
  const rect = shell.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
  const style = typeof getComputedStyle === "function" ? getComputedStyle(shell) : shell.style;
  const contentLeft = parseCssLength(style?.getPropertyValue?.("--titlebar-content-left")) ?? rect.left;
  const contentTop = parseCssLength(style?.getPropertyValue?.("--titlebar-content-top")) ?? rect.top;
  const titlebarHeight = parseCssLength(style?.getPropertyValue?.("--titlebar-height")) ?? rect.height;
  return { windowLeft: rect.left, contentLeft, contentTop, contentWidth: rect.width, titlebarHeight, shell };
}

function alignControls(layout, controls = {}) {
  const width = number(controls.width, 0);
  const gap = number(controls.gap, 0);
  const inset = number(controls.inset, 0);
  const right = number(layout?.contentLeft, 0) - inset;
  const left = right - width;
  return { left, right, top: number(layout?.contentTop, 0), width, gap, overlap: right > number(layout?.contentLeft, 0) };
}

function apply(state) {
  if (state.disposed) return;
  // Disconnect our observers for the duration of the writes below; every style
  // write we make would otherwise be observed and reschedule apply() forever.
  pauseObservers(state);
  try {
    pruneDetachedSnapshots(state);
    if (isFullscreen()) {
      restoreControls(state);
      return;
    }
    const layout = detectLayout(document);
    const controls = Array.from(document.querySelectorAll?.(CONTROL_SELECTOR) || []);
    if (!controls.length) return;
    const shell = layout.shell || document.documentElement;
    const shellRect = shell?.getBoundingClientRect?.() || { left: 0, top: 0 };
    for (const control of controls) restoreControl(control, state.snapshots.get(control));
    const rects = controls.map((control) => control.getBoundingClientRect?.()).filter(Boolean);
    if (!rects.length) return;
    const groupLeft = Math.min(...rects.map((rect) => rect.left));
    const groupRight = Math.max(...rects.map((rect) => rect.right ?? rect.left + rect.width));
    const horizontal = alignControls(layout, { width: groupRight - groupLeft, inset: 8 });
    const translateX = Number.isFinite(horizontal.left) ? horizontal.left - groupLeft : 0;
    for (const control of controls) {
      if (!state.snapshots.has(control)) state.snapshots.set(control, {
        attr: control.getAttribute?.(ATTR),
        transform: control.style?.getPropertyValue?.("transform") || "",
        priority: control.style?.getPropertyPriority?.("transform") || "",
      });
      const rect = control.getBoundingClientRect?.() || { width: 0, left: 0, top: 0 };
      const transform = computeControlTransform(layout, rect, translateX, shellRect.top);
      if (control.getAttribute?.(ATTR) !== "active") control.setAttribute?.(ATTR, "active");
      setTransform(control, `translate(${transform.x}px, ${transform.y}px)`, "important");
    }
  } finally {
    resumeObservers(state);
  }
}

function pruneDetachedSnapshots(state) {
  if (!state.snapshots) return;
  for (const element of [...state.snapshots.keys()]) {
    if (element && element.isConnected === false) state.snapshots.delete(element);
  }
}

function computeControlTransform(layout, rect, translateX = 0, shellTop = 0) {
  const center = number(rect?.top, 0) + number(rect?.height, 0) / 2;
  const target = number(layout?.contentTop, shellTop) + number(layout?.titlebarHeight, rect?.height || 0) / 2;
  return { x: number(translateX, 0), y: Number.isFinite(center) && Number.isFinite(target) ? target - center : 0 };
}

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.documentElement?.hasAttribute?.("data-fullscreen"));
}

function restoreControl(element, original) {
  if (!original) return;
  if (original.attr == null) element.removeAttribute?.(ATTR);
  else element.setAttribute?.(ATTR, original.attr);
  setTransform(element, original.transform, original.priority);
}

function restoreControls(state) {
  for (const [element, original] of state.snapshots || []) restoreControl(element, original);
}

function ensureStyle(state) {
  const style = document.getElementById?.(STYLE_ID) || document.createElement("style");
  if (!style.id) style.id = STYLE_ID;
  style.textContent = `[${ATTR}=active] { align-self: center; }`;
  if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
  state.styles.push(style);
}

function schedule(state) {
  if (state.disposed || state.pending != null) return;
  state.pending = (window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 16)))(() => {
    state.pending = null;
    apply(state);
  });
}

function cleanup(state) {
  state.disposed = true;
  if (state.pending != null) {
    window.cancelAnimationFrame?.(state.pending);
    window.clearTimeout?.(state.pending);
    state.pending = null;
  }
  if (state.observerConfigs) state.observerConfigs.length = 0;
  for (const observer of state.observers.splice(0)) observer?.disconnect?.();
  for (const entry of state.listeners.splice(0)) {
    if (Array.isArray(entry)) {
      const [target, type, listener] = entry;
      target?.removeEventListener?.(type, listener);
    } else {
      entry?.remove?.();
    }
  }
  for (const [element, original] of state.snapshots || []) {
    restoreControl(element, original);
  }
  state.snapshots?.clear?.();
  for (const style of state.styles.splice(0)) style?.remove?.();
  state.refreshButton?.remove?.();
  state.refreshButton = null;
}

function parseCssLength(value) {
  const parsed = Number.parseFloat(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function number(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
