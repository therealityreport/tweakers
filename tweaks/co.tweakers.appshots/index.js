"use strict";

const CAPTURE_CHANNEL = "capture";
const STATUS_CHANNEL = "status";
const PERMISSIONS_CHANNEL = "permissions";
const OPEN_PERMISSION_CHANNEL = "open-permission";
const CAPTURE_NOW_CHANNEL = "capture-now";
const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  includeText: true,
  sound: true,
  fallbackAccelerator: "Command+Shift+2",
});
const MAX_TEXT_CHARACTERS = 100000;
const COOLDOWN_MS = 750;

module.exports = {
  start(api) {
    if (api.process === "main") return startMain(api, this);
    return startRenderer(api, this);
  },
  async stop() {
    await this._appshots?.dispose?.();
    this._appshots = null;
  },
  _test: {
    normalizeSettings,
    safeFilePart,
    contextFileText,
    filesForCapture,
  },
};

function startMain(api, instance) {
  const state = {
    api,
    disposed: false,
    capturing: false,
    lastCaptureAt: 0,
    hotkey: null,
    disposers: [],
    lastStatus: { state: "idle", message: "Ready", at: new Date().toISOString() },
  };
  instance._appshots = { dispose: () => disposeMain(state) };
  state.disposers.push(api.ipc.handle?.(PERMISSIONS_CHANNEL, () => api.codex.capture.getPermissionStatus()));
  state.disposers.push(api.ipc.handle?.(OPEN_PERMISSION_CHANNEL, (kind) => api.codex.capture.openPermissionSettings(kind)));
  state.disposers.push(api.ipc.handle?.(STATUS_CHANNEL, () => state.lastStatus));
  state.disposers.push(api.ipc.handle?.(CAPTURE_NOW_CHANNEL, () => runCapture(state, "manual")));
  api.codex.hotkeys.registerCaptureHotkey({
    preferred: "DoubleCommand",
    fallbackAccelerator: DEFAULT_SETTINGS.fallbackAccelerator,
    suppressNativeAppshots: true,
  }, () => {
    void runCapture(state, "shortcut");
  }).then((registration) => {
    state.hotkey = registration;
    setStatus(state, "ready", `Shortcut active: ${registration.active === "fallback" ? DEFAULT_SETTINGS.fallbackAccelerator : "Double Command"}`);
  }).catch((error) => {
    setStatus(state, "error", `Shortcut unavailable: ${messageFor(error)}`);
  });
}

async function runCapture(state, source) {
  if (state.disposed) return { ok: false, reason: "disposed" };
  const now = Date.now();
  if (state.capturing || now - state.lastCaptureAt < COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  state.capturing = true;
  state.lastCaptureAt = now;
  setStatus(state, "capturing", source === "manual" ? "Capturing from settings" : "Capturing from shortcut");
  try {
    const capture = await state.api.codex.capture.captureFrontmostWindow({
      includeAccessibilityText: true,
      maxTextCharacters: MAX_TEXT_CHARACTERS,
    });
    const delivered = state.api.ipc.sendToPrimary?.(CAPTURE_CHANNEL, capture) === true;
    if (!delivered) {
      setStatus(state, "error", "No primary composer window was available");
      return { ok: false, reason: "no-primary-window" };
    }
    setStatus(state, "delivered", `Captured ${capture.app.name || "frontmost window"}`);
    return { ok: true, captureId: capture.captureId };
  } catch (error) {
    const message = messageFor(error);
    setStatus(state, "error", message);
    return { ok: false, reason: message };
  } finally {
    state.capturing = false;
  }
}

async function disposeMain(state) {
  state.disposed = true;
  for (const dispose of state.disposers.splice(0)) {
    try { dispose?.(); } catch {}
  }
  try { await state.hotkey?.unregister?.(); } catch {}
  state.hotkey = null;
}

function setStatus(state, status, message) {
  state.lastStatus = { state: status, message, at: new Date().toISOString() };
  state.api.ipc.sendToPrimary?.(STATUS_CHANNEL, state.lastStatus);
}

function startRenderer(api, instance) {
  const state = {
    api,
    settings: normalizeSettings(api.storage.get("settings", DEFAULT_SETTINGS)),
    lastStatus: { state: "idle", message: "Ready", at: new Date().toISOString() },
    page: null,
    disposers: [],
  };
  instance._appshots = { dispose: () => disposeRenderer(state) };
  state.disposers.push(api.ipc.on(CAPTURE_CHANNEL, (capture) => {
    void attachCapture(state, capture);
  }));
  state.disposers.push(api.ipc.on(STATUS_CHANNEL, (status) => {
    state.lastStatus = status;
  }));
  state.page = api.settings?.registerPage?.({
    id: "appshots",
    title: "AppShots",
    description: "Attach the frontmost window as image and context.",
    iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M7 9.5l2 2 3-4 3 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    render(root) { renderSettings(root, state); },
  });
}

async function attachCapture(state, capture) {
  try {
    const files = filesForCapture(capture, state.settings);
    const result = await state.api.react.host.attachFiles(files);
    state.lastStatus = {
      state: result.accepted ? "attached" : "error",
      message: result.accepted ? "Attached AppShot to composer" : `Attachment failed: ${result.reason}`,
      at: new Date().toISOString(),
    };
  } catch (error) {
    state.lastStatus = { state: "error", message: messageFor(error), at: new Date().toISOString() };
  }
}

function disposeRenderer(state) {
  for (const dispose of state.disposers.splice(0)) {
    try { dispose?.(); } catch {}
  }
  state.page?.unregister?.();
  state.page = null;
}

function renderSettings(root, state) {
  root.replaceChildren();
  const wrap = el("div", "flex flex-col gap-4");
  const status = el("div", "border-token-border rounded-lg border p-3 text-sm text-token-text-secondary", state.lastStatus.message || "Ready");
  const actions = el("div", "flex flex-wrap gap-2");
  actions.append(
    button("Capture now", async () => {
      state.lastStatus = { state: "capturing", message: "Capturing", at: new Date().toISOString() };
      await state.api.ipc.invoke(CAPTURE_NOW_CHANNEL);
      renderSettings(root, state);
    }),
    button("Screen Recording", () => state.api.ipc.invoke(OPEN_PERMISSION_CHANNEL, "screen-recording")),
    button("Accessibility", () => state.api.ipc.invoke(OPEN_PERMISSION_CHANNEL, "accessibility")),
    button("Input Monitoring", () => state.api.ipc.invoke(OPEN_PERMISSION_CHANNEL, "input-monitoring")),
  );
  const details = el("div", "text-sm text-token-text-secondary", `Shortcut: ${state.settings.fallbackAccelerator}. Text context: ${state.settings.includeText ? "on" : "off"}.`);
  wrap.append(status, actions, details);
  root.append(wrap);
  void state.api.ipc.invoke(PERMISSIONS_CHANNEL).then((permissions) => {
    details.textContent = `Shortcut: ${state.settings.fallbackAccelerator}. Screen Recording: ${permissions.screenRecording}. Accessibility: ${permissions.accessibility}.`;
  }).catch(() => {});
}

function filesForCapture(capture, settings) {
  const app = safeFilePart(capture?.app?.name || "Window");
  const stamp = safeFilePart(String(capture?.capturedAt || new Date().toISOString()).replace(/[:.]/g, "-"));
  const files = [{
    name: `AppShot-${app}-${stamp}.png`,
    mimeType: "image/png",
    dataBase64: String(capture?.image?.dataBase64 || ""),
  }];
  if (settings.includeText && capture?.accessibility?.text) {
    files.push({
      name: `AppShot-${app}-Context.txt`,
      mimeType: "text/plain",
      dataBase64: textToBase64(contextFileText(capture)),
    });
  }
  return files;
}

function contextFileText(capture) {
  const lines = [
    `App: ${capture?.app?.name || "Unknown"}`,
    `Bundle ID: ${capture?.app?.bundleIdentifier || "unknown"}`,
    `Window: ${capture?.window?.title || "Untitled"}`,
    `Captured: ${capture?.capturedAt || "unknown"}`,
    `Accessibility: ${capture?.accessibility?.status || "unavailable"}`,
    "",
    capture?.accessibility?.text || "",
  ];
  return lines.join("\n").trimEnd() + "\n";
}

function normalizeSettings(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    enabled: input.enabled !== false,
    includeText: input.includeText !== false,
    sound: input.sound !== false,
    fallbackAccelerator: typeof input.fallbackAccelerator === "string" && input.fallbackAccelerator.trim()
      ? input.fallbackAccelerator.trim()
      : DEFAULT_SETTINGS.fallbackAccelerator,
  };
}

function safeFilePart(value) {
  return String(value || "Unknown")
    .replace(/[/:\\\0\r\n]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80) || "Unknown";
}

function textToBase64(value) {
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function button(text, action) {
  const node = el("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 h-token-button-composer rounded-md border px-3 text-sm text-token-text-primary cursor-interaction", text);
  node.type = "button";
  node.addEventListener("click", () => {
    void action();
  });
  return node;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}
