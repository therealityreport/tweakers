import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const tweaks = [
  "co.tweakers.account-switcher",
  "co.tweakers.appshots",
  "co.tweakers.developer-tools",
  "co.tweakers.projects",
  "co.tweakers.shadcn-codex-ui",
  "co.tweakers.thread-summary-profiles",
  "followup",
  "titlebar-controls",
  "ui-improvements",
  "usage-limit-resets-tracker",
  "user-questions",
];

test("all eleven canonical Tweakers register one purpose-built settings page", () => {
  const icons = new Set<string>();
  for (const folder of tweaks) {
    const source = readFileSync(resolve(process.cwd(), "tweaks", folder, "index.js"), "utf8");
    const registrations = source.match(/registerPage(?:\?\.)?\s*\(\s*\{/g) || [];
    assert.equal(registrations.length, 1, `${folder} should register exactly one page`);
    assert.match(source, /iconSvg\s*:/, `${folder} should supply a distinct settings icon`);
    const icon = source.match(/iconSvg\s*:\s*(['"])(<svg[\s\S]*?<\/svg>)\1/)?.[2];
    assert.ok(icon, `${folder} should provide an inline SVG icon`);
    assert.match(icon, /width="20"/);
    assert.match(icon, /height="20"/);
    assert.equal(icons.has(icon), false, `${folder} should have a distinct icon`);
    icons.add(icon);
  }
  assert.equal(icons.size, 11);
});

test("canonical pages contain meaningful controls or live status instead of an Enabled placeholder", () => {
  for (const folder of tweaks) {
    const source = readFileSync(resolve(process.cwd(), "tweaks", folder, "index.js"), "utf8");
    assert.doesNotMatch(source, /root\.textContent\s*=\s*["']Enabled\.?["']/, folder);
    assert.match(source, /render[A-Za-z]*(?:Page|Settings)|render\(root\)/, folder);
  }
});
