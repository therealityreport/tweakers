import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "packages/runtime/src/preload/settings-injector.ts"),
  "utf8",
);

test("settings registration protects replacement pages and sections from stale handles", () => {
  assert.match(source, /const registrationToken = Symbol\(section\.id\)/);
  assert.match(source, /state\.sectionTokens\.get\(section\.id\) !== registrationToken/);
  assert.match(source, /const existing = state\.pages\.get\(id\)/);
  assert.match(source, /e\.registrationToken !== registrationToken/);
});

test("clearing tweak registrations removes the shared page group", () => {
  const clearStart = source.indexOf("export function clearSections");
  const clearEnd = source.indexOf("export function registerPage", clearStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart);
  const body = source.slice(clearStart, clearEnd);
  assert.match(body, /state\.pages\.clear\(\)/);
  assert.match(body, /syncPagesGroup\(\)/);
});

test("registered page icons are constrained to the native sidebar size", () => {
  // Sidebar items constrain their icon via the shared constrainSidebarIconSvg
  // helper, which forces width/height AND an inline size style so a tweak's own
  // (possibly unsized) iconSvg cannot render at intrinsic size.
  const itemStart = source.indexOf("function makeSidebarItem");
  const itemEnd = source.indexOf("function appendSidebarStoreUpdateBadge", itemStart);
  const body = source.slice(itemStart, itemEnd);
  assert.match(body, /constrainSidebarIconSvg\(inner\.querySelector\("svg"\)\)/);

  const helperStart = source.indexOf("function constrainSidebarIconSvg");
  const helperEnd = source.indexOf("function makeSidebarItem", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /setAttribute\("width", String\(size\)\)/);
  assert.match(helper, /setAttribute\("height", String\(size\)\)/);
  assert.match(helper, /style\.width = `\$\{size\}px`/);
  assert.match(helper, /classList\?\.add\("icon-sm", "inline-block", "shrink-0", "align-middle"\)/);
});

test("Tweakers navigation shares native scrolling, hides Store, and joins settings search", () => {
  assert.match(source, /const outer = itemsGroup;/);
  assert.match(source, /if \(outer === itemsGroup\) outer\.prepend\(header\)/);
  assert.match(source, /bindSettingsSearch\(outer\)/);
  assert.doesNotMatch(source, /makeSidebarItem\("Tweak Store"/);
});

test("Tweakers navigation mounts only in native Settings and revalidates connected ownership", () => {
  assert.match(source, /\[data-settings-panel-slug\]/);

  const candidateStart = source.indexOf("function isSettingsSidebarCandidate");
  const candidateEnd = source.indexOf("function removeMisplacedSettingsGroups", candidateStart);
  assert.ok(candidateStart >= 0 && candidateEnd > candidateStart);
  const candidate = source.slice(candidateStart, candidateEnd);
  assert.match(candidate, /isNativeSettingsSidebarEvidence/);
  assert.match(candidate, /nativePanelSlugCount: nativeSettingsPanelSlugCount\(el\)/);
  assert.match(candidate, /forbiddenSurface: isForbiddenSettingsSidebarSurface\(el\)/);

  const placementStart = source.indexOf("function isTweakerInjectedSettingsGroupPlacementValid");
  const placementEnd = source.indexOf("function resetTweakerInjectedSettingsGroupState", placementStart);
  assert.ok(placementStart >= 0 && placementEnd > placementStart);
  const placement = source.slice(placementStart, placementEnd);
  assert.match(placement, /hasNativeSettingsSidebarOwnership/);
  assert.match(placement, /nativeSettingsPanelSlugCount\(state\.sidebarRoot\)/);
  assert.doesNotMatch(placement, /\) \{\s*return true;\s*\}/);
});
