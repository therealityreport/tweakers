"use strict";

module.exports = {
  start(api) {
    if (api.process !== "renderer") return;
    const state = { disposed: false, generation: 0, api };
    this._state = state;
    this._page = api.settings?.registerPage?.({
      id: "appshots",
      title: "AppShots",
      iconSvg: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 7h15" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="11.5" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>',

      description: "Codex native window capture and Computer History status.",
      render(root) { render(root, state); },
    });
  },
  stop() {
    if (this._state) { this._state.disposed = true; this._state.generation++; }
    this._page?.unregister?.();
    this._page = null;
    this._state = null;
  },
};

function render(root, state) {
  const generation = ++state.generation;
  root.replaceChildren();
  const wrap = el("div", "flex flex-col gap-4");
  const status = el("p", "text-sm text-token-text-secondary", "Checking native AppShots…");
  const history = el("p", "text-sm text-token-text-secondary", "Checking native Computer History…");
  const help = el("p", "text-sm text-token-text-secondary", "Native AppShots captures a window and attaches its image and text directly to Codex. Double Command means pressing both Command keys together. Recording and privacy settings remain in native Computer History.");
  const actions = el("div", "flex flex-wrap gap-2");
  const active = () => !state.disposed && generation === state.generation;
  const native = state.api.nativeCapture;
  const refresh = async () => {
    try {
      if (!native) throw new Error("This runtime does not provide native Codex services");
      const value = await native.appshots.getState();
      if (active()) status.textContent = value.supported === false
        ? "Native AppShots is not supported by this desktop."
        : `Native AppShots shortcut: ${shortcutName(value.hotkey ?? value.captureHotkey)}.`;
    } catch (error) { if (active()) status.textContent = `Native AppShots unavailable: ${message(error)}`; }
    try {
      if (!native) throw new Error("This runtime does not provide native Codex services");
      const value = await native.computerHistory.getState();
      if (active()) history.textContent = `Native Computer History: ${typeof value.state === "string" ? value.state : value.enabled === true ? "enabled" : value.enabled === false ? "disabled" : "state available in native settings"}.`;
    } catch (error) { if (active()) history.textContent = `Native Computer History unavailable: ${message(error)}`; }
  };
  const setHotkey = async (hotkey) => {
    try {
      if (!native) throw new Error("Native Codex services are unavailable");
      await native.appshots.setHotkey(hotkey);
      if (active()) await refresh();
    } catch (error) { if (active()) status.textContent = `Shortcut could not be changed: ${message(error)}`; }
  };
  actions.append(button("Use Double Command", () => setHotkey("DoubleCommand")), button("Disable native shortcut", () => setHotkey(null)), button("Refresh status", refresh));
  wrap.append(status, history, help, actions);
  root.append(wrap);
  void refresh();
}

function shortcutName(value) {
  if (value === "DoubleCommand") return "both Command keys";
  if (value === null) return "disabled";
  return typeof value === "string" ? value : "see native AppShots settings";
}
function message(error) { return error instanceof Error ? error.message : String(error); }
function button(text, action) {
  const node = el("button", "border-token-border bg-token-foreground/5 hover:bg-token-foreground/10 rounded-md border px-3 py-2 text-sm text-token-text-primary cursor-interaction", text);
  node.type = "button";
  node.addEventListener("click", async () => {
    if (node.disabled) return;
    node.disabled = true;
    try { await action(); } finally { node.disabled = false; }
  });
  return node;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
