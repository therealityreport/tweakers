import assert from "node:assert/strict";
import test from "node:test";
import {
  ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID,
  syncEnvironmentModeCacheMenuFromStatus,
  syncEnvironmentModeCacheMenuItem,
  syncCodexDesktopUpdateMenuLabel,
  type CodexDesktopUpdateMenuLike,
} from "../src/codex-desktop-update-menu";

function insertableMenu(items: CodexDesktopUpdateMenuLike["items"]): CodexDesktopUpdateMenuLike {
  const menu: CodexDesktopUpdateMenuLike = {
    items,
    insert(position, item) {
      menu.items.splice(position, 0, item);
    },
  };
  return menu;
}

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

test("polling status inserts and updates one disabled sealed-pair menu row", () => {
  const appSubmenu = insertableMenu([{ label: "Check for Updates…" }]);
  const menu: CodexDesktopUpdateMenuLike = {
    items: [{ label: "ChatGPT", submenu: appSubmenu }],
  };
  const createItem = (input: Parameters<typeof syncEnvironmentModeCacheMenuItem>[2] extends (value: infer Value) => unknown ? Value : never) => ({ ...input });

  assert.equal(syncEnvironmentModeCacheMenuFromStatus(menu, {
    schemaVersion: 1,
    cacheV2: {
      state: "ready",
      generationId: "pair-8",
      invalidationReasons: [],
    },
  }, createItem), true);
  assert.equal(appSubmenu.items.length, 2);
  assert.deepEqual(appSubmenu.items[1], {
    id: ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID,
    label: "Sealed Pair Ready",
    sublabel: "Generation pair-8",
    enabled: false,
  });

  assert.equal(syncEnvironmentModeCacheMenuItem(menu, {
    state: "stale",
    generationId: "pair-8",
    invalidationReasons: ["official application changed"],
  }, createItem), true);
  assert.equal(appSubmenu.items.length, 2);
  assert.deepEqual(appSubmenu.items[1], {
    id: ENVIRONMENT_MODE_CACHE_MENU_ITEM_ID,
    label: "Sealed Pair Needs Preparation",
    sublabel: "Generation pair-8 — official application changed; it will not switch automatically",
    enabled: false,
  });
});
