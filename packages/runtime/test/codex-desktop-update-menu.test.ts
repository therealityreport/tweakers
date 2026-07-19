import assert from "node:assert/strict";
import test from "node:test";
import {
  syncCodexDesktopUpdateMenuLabel,
  type CodexDesktopUpdateMenuLike,
} from "../src/codex-desktop-update-menu";

test("updates the nested OpenAI menu item in place and preserves its action", () => {
  let clicks = 0;
  const updateItem = {
    label: "Check for Updates…",
    click: () => { clicks += 1; },
  };
  const menu: CodexDesktopUpdateMenuLike = {
    items: [{ label: "ChatGPT", submenu: { items: [updateItem] } }],
  };

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, true), true);
  assert.equal(updateItem.label, "Update Available…");
  updateItem.click();
  assert.equal(clicks, 1);

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, false), true);
  assert.equal(updateItem.label, "Check for Updates…");
});

test("leaves unrelated application menus untouched", () => {
  const menu: CodexDesktopUpdateMenuLike = {
    items: [{ label: "ChatGPT", submenu: { items: [{ label: "About ChatGPT" }] } }],
  };

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, true), false);
  assert.equal(menu.items[0]?.submenu?.items[0]?.label, "About ChatGPT");
});

test("can replace OpenAI's manager-gated click before the menu is attached", () => {
  let originalClicks = 0;
  let safeClicks = 0;
  const updateItem = {
    label: "Check for Updates…",
    click: () => { originalClicks += 1; },
  };
  const menu: CodexDesktopUpdateMenuLike = {
    items: [{ label: "ChatGPT", submenu: { items: [updateItem] } }],
  };

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, true, () => { safeClicks += 1; }), true);
  updateItem.click();
  assert.equal(updateItem.label, "Update Available…");
  assert.equal(originalClicks, 0);
  assert.equal(safeClicks, 1);
});

test("disables the application-menu check while Alpha feed setup is required", () => {
  let safeClicks = 0;
  const updateItem = {
    label: "Check for Updates…",
    enabled: true,
    click: () => { safeClicks += 1; },
  };
  const menu: CodexDesktopUpdateMenuLike = {
    items: [{ label: "ChatGPT", submenu: { items: [updateItem] } }],
  };

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, false, () => { safeClicks += 1; }, true), true);
  assert.equal(updateItem.label, "Alpha Updates Require Setup…");
  assert.equal(updateItem.enabled, false);

  assert.equal(syncCodexDesktopUpdateMenuLabel(menu, false, () => { safeClicks += 1; }, false), true);
  assert.equal(updateItem.label, "Check for Updates…");
  assert.equal(updateItem.enabled, true);
});
