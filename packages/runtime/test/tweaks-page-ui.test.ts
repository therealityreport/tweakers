import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { TweakManifest } from "@therealityreport/tweakers-sdk";
import {
  filterTweaksPageItems,
  tweaksPageCounts,
  type TweaksPageItem,
} from "../src/preload/tweaks-page-model";

function item(
  name: string,
  overrides: Partial<TweaksPageItem> & { manifest?: Partial<TweakManifest> } = {},
): TweaksPageItem {
  return {
    installed: true,
    enabled: true,
    status: "enabled",
    update: null,
    ...overrides,
    manifest: {
      id: `com.example.${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      version: "1.0.0",
      githubRepo: `example/${name.toLowerCase().replace(/\s+/g, "-")}`,
      ...overrides.manifest,
    },
  };
}

test("Tweaks page counts status filters without hiding enabled failures", () => {
  const items = [
    item("Ready"),
    item("Disabled", { enabled: false, status: "disabled" }),
    item("Failed", { status: "failed" }),
    item("Quarantined", { status: "quarantined" }),
    item("Available", { installed: false, enabled: false, status: "not-installed" }),
    item("Update", { update: { updateAvailable: true } }),
  ];

  assert.deepEqual(tweaksPageCounts(items), {
    all: 6,
    enabled: 4,
    disabled: 1,
    updates: 1,
  });
  assert.deepEqual(
    filterTweaksPageItems(items, "enabled", "").map((entry) => entry.manifest.name),
    ["Ready", "Failed", "Quarantined", "Update"],
  );
  assert.deepEqual(
    filterTweaksPageItems(items, "disabled", "").map((entry) => entry.manifest.name),
    ["Disabled"],
  );
  assert.deepEqual(
    filterTweaksPageItems(items, "updates", "").map((entry) => entry.manifest.name),
    ["Update"],
  );
});

test("Tweaks search matches normalized metadata, status, and update state", () => {
  const items = [
    item("Résumé Helper", {
      manifest: {
        description: "Improves project cards",
        author: { name: "Tweakers", url: "https://example.com" },
        tags: ["user interface"],
      },
    }),
    item("Questions", {
      status: "failed",
      update: { updateAvailable: true },
      manifest: { author: "Tweakers", githubRepo: "therealityreport/tweakers" },
    }),
  ];

  assert.equal(filterTweaksPageItems(items, "all", "resume")[0]?.manifest.name, "Résumé Helper");
  assert.equal(filterTweaksPageItems(items, "all", "Tweakers")[0]?.manifest.name, "Résumé Helper");
  assert.equal(filterTweaksPageItems(items, "all", "user interface")[0]?.manifest.name, "Résumé Helper");
  assert.equal(filterTweaksPageItems(items, "all", "therealityreport")[0]?.manifest.name, "Questions");
  assert.equal(filterTweaksPageItems(items, "all", "update available")[0]?.manifest.name, "Questions");
  assert.equal(filterTweaksPageItems(items, "all", "failed")[0]?.manifest.name, "Questions");
});

const source = readFileSync(
  resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
  "utf8",
);

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source range exists`);
  return source.slice(start, end);
}

test("Tweaks manager mirrors the Plugins page structure and keeps legacy sections", () => {
  const render = functionBody("renderTweaksPage", "tweaksPageFilterLabel");
  const row = functionBody("tweakRow", "tweakAvatar");
  const avatar = functionBody("tweakAvatar", "tweakAuthorName");
  assert.match(source, /ap\.kind === "tweaks" \? \{ width: "plugins" \}/);
  assert.match(source, /width === "plugins" \? "max-w-3xl"/);
  assert.match(render, /Search tweaks/);
  assert.match(render, /Filter tweaks/);
  assert.match(render, /More tweak actions/);
  assert.match(render, /Force Reload/);
  assert.match(render, /Open Tweaks Folder/);
  assert.doesNotMatch(render, /sectionTitle\("Tweakers"/);
  assert.match(avatar, /h-10 w-10/);
  assert.match(row, /activatePage\(\{ kind: "registered", id: manifest\.id \}\)/);
  assert.match(row, /Preserve the legacy SettingsSection contract/);
  assert.match(row, /setAttribute\("aria-label", `\$\{tweak\.enabled \? "Disable" : "Enable"\}/);
});

test("Tweaks action menus expose keyboard and outside-click dismissal", () => {
  const menu = functionBody("actionMenuButton", "tweakStatusPill");
  assert.match(menu, /setAttribute\("role", "menu"\)/);
  assert.match(menu, /setAttribute\("role", "menuitem"\)/);
  assert.match(menu, /event\.key !== "Escape"/);
  assert.match(menu, /document\.addEventListener\("pointerdown", onPointerDown, true\)/);
  assert.match(menu, /document\.removeEventListener\("pointerdown", onPointerDown, true\)/);
});
