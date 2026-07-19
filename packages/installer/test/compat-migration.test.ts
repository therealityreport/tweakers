import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfigFile } from "../src/config";
import { existingInstallRoot, userPaths } from "../src/paths";
import { migrateLegacyTweakNamespaces, prepareLegacyTweakNamespaces } from "../src/tweak-namespace-migration";

const legacyPublisher = "co.thomashulihan.";

test("existing legacy install root remains authoritative", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-root-compat-"));
  try {
    const current = join(root, "Tweakers");
    const legacy = join(root, ["codex", "plusplus"].join("-"));
    mkdirSync(current);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "state.json"), "{}\n");
    assert.equal(existingInstallRoot(current, legacy), legacy);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime user-root aliases select the exact root without an installer-home override", () => {
  const variables = [
    "TWEAKERS_USER_ROOT",
    "TWEAKER_USER_ROOT",
    ["CODEX", "PLUSPLUS", "USER_ROOT"].join("_"),
    "TWEAKERS_HOME",
    "TWEAKER_HOME",
  ];
  const previous = new Map(variables.map((name) => [name, process.env[name]]));
  try {
    delete process.env.TWEAKERS_HOME;
    delete process.env.TWEAKER_HOME;
    process.env.TWEAKERS_USER_ROOT = "/tmp/exact-tweakers-variant";
    delete process.env.TWEAKER_USER_ROOT;
    delete process.env[["CODEX", "PLUSPLUS", "USER_ROOT"].join("_")];
    assert.equal(userPaths().root, "/tmp/exact-tweakers-variant");

    delete process.env.TWEAKERS_USER_ROOT;
    process.env.TWEAKER_USER_ROOT = "/tmp/exact-tweaker-variant";
    assert.equal(userPaths().root, "/tmp/exact-tweaker-variant");

    delete process.env.TWEAKER_USER_ROOT;
    process.env[["CODEX", "PLUSPLUS", "USER_ROOT"].join("_")] = "/tmp/exact-legacy-variant";
    assert.equal(userPaths().root, "/tmp/exact-legacy-variant");

    process.env.TWEAKERS_HOME = "/tmp/explicit-installer-home";
    assert.equal(userPaths().root, "/tmp/explicit-installer-home");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("config compatibility merges missing legacy fields and current values win", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-config-compat-"));
  try {
    const file = join(root, "config.json");
    const legacyKey = ["codex", "Plus", "Plus"].join("");
    writeFileSync(file, JSON.stringify({
      [legacyKey]: { autoUpdate: false, developmentSourceRoot: "/legacy", updateRef: "old" },
      tweaker: { updateRef: "current" },
    }));
    const config = readConfigFile(file) as Record<string, any>;
    assert.deepEqual(config.tweaker, { autoUpdate: false, developmentSourceRoot: "/legacy", updateRef: "current" });
    assert.equal(config[legacyKey], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tweak namespace migration preserves data, storage, config, collisions, and idempotence", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-id-compat-"));
  try {
    const configFile = join(root, "config.json");
    const legacyId = `${legacyPublisher}projects`;
    const currentId = "co.tweakers.projects";
    mkdirSync(join(root, "tweak-data", legacyId), { recursive: true });
    writeFileSync(join(root, "tweak-data", legacyId, "projects-v1.json"), '{"kept":true}\n');
    mkdirSync(join(root, "storage"), { recursive: true });
    writeFileSync(join(root, "storage", `${legacyId}.json`), '{"legacy":true}\n');
    writeFileSync(join(root, "storage", `${currentId}.json`), '{"current":true}\n');
    writeFileSync(configFile, JSON.stringify({
      tweaks: { [legacyId]: { enabled: false }, [currentId]: { label: "current" } },
      tweakUpdateChecks: { [legacyId]: { checkedAt: "old" } },
    }));

    prepareLegacyTweakNamespaces(root, configFile);
    assert.equal(existsSync(join(root, "tweak-data", legacyId, "projects-v1.json")), true);
    assert.equal(existsSync(join(root, "tweak-data", currentId, "projects-v1.json")), true);
    const prepared = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(prepared.tweaks[legacyId], { enabled: false });
    assert.deepEqual(prepared.tweaks[currentId], { enabled: false, label: "current" });

    migrateLegacyTweakNamespaces(root, configFile);
    migrateLegacyTweakNamespaces(root, configFile);

    assert.equal(existsSync(join(root, "tweak-data", currentId, "projects-v1.json")), true);
    assert.equal(readFileSync(join(root, "storage", `${currentId}.json`), "utf8"), '{"current":true}\n');
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(config.tweaks[currentId], { enabled: false, label: "current" });
    assert.deepEqual(config.tweakUpdateChecks[currentId], { checkedAt: "old" });
    assert.equal(config.tweaks[legacyId], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tweak namespace migration never claims a third-party publisher with a known suffix", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-id-third-party-"));
  try {
    const configFile = join(root, "config.json");
    const thirdPartyId = "co.bennett.projects";
    mkdirSync(join(root, "tweak-data", thirdPartyId), { recursive: true });
    writeFileSync(join(root, "tweak-data", thirdPartyId, "projects.json"), '{"ownedBy":"bennett"}\n');
    mkdirSync(join(root, "storage"), { recursive: true });
    writeFileSync(join(root, "storage", `${thirdPartyId}.json`), '{"ownedBy":"bennett"}\n');
    writeFileSync(configFile, JSON.stringify({
      tweaks: { [thirdPartyId]: { enabled: false } },
    }));

    prepareLegacyTweakNamespaces(root, configFile);
    migrateLegacyTweakNamespaces(root, configFile);

    assert.equal(existsSync(join(root, "tweak-data", thirdPartyId, "projects.json")), true);
    assert.equal(existsSync(join(root, "tweak-data", "co.tweakers.projects")), false);
    assert.equal(readFileSync(join(root, "storage", `${thirdPartyId}.json`), "utf8"), '{"ownedBy":"bennett"}\n');
    assert.equal(existsSync(join(root, "storage", "co.tweakers.projects.json")), false);
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(config.tweaks, { [thirdPartyId]: { enabled: false } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tweak namespace migration preserves unrelated keys from the former publisher", () => {
  const root = mkdtempSync(join(tmpdir(), "tweaker-id-same-publisher-"));
  try {
    const configFile = join(root, "config.json");
    const ownedLegacyId = `${legacyPublisher}projects`;
    const unrelatedLegacyId = `${legacyPublisher}personal-plugin`;
    writeFileSync(configFile, JSON.stringify({
      tweaks: {
        [ownedLegacyId]: { enabled: false },
        [unrelatedLegacyId]: { enabled: true, owner: "user" },
      },
      nested: {
        [unrelatedLegacyId]: { keep: true },
      },
    }));

    prepareLegacyTweakNamespaces(root, configFile);
    let config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(config.tweaks[unrelatedLegacyId], { enabled: true, owner: "user" });
    assert.equal(config.tweaks["co.tweakers.personal-plugin"], undefined);
    assert.deepEqual(config.nested[unrelatedLegacyId], { keep: true });

    migrateLegacyTweakNamespaces(root, configFile);
    config = JSON.parse(readFileSync(configFile, "utf8"));
    assert.deepEqual(config.tweaks["co.tweakers.projects"], { enabled: false });
    assert.deepEqual(config.tweaks[unrelatedLegacyId], { enabled: true, owner: "user" });
    assert.equal(config.tweaks["co.tweakers.personal-plugin"], undefined);
    assert.deepEqual(config.nested[unrelatedLegacyId], { keep: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
