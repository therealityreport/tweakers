import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyRelease, verifyReleaseArchiveAssets, verifyReleaseAssets } from "./verify-release.mjs";

test("release verification requires matching package versions, tag, and changelog", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-release-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    for (const name of ["sdk", "runtime", "installer", "loader", "native-host"]) {
      mkdirSync(join(root, "packages", name), { recursive: true });
      writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
    }
    writeFileSync(join(root, "CHANGELOG.md"), "## 1.2.3\n\n- Ready.\n");
    assert.deepEqual(verifyRelease(root, "v1.2.3"), { version: "1.2.3", tag: "v1.2.3" });
    assert.throws(() => verifyRelease(root, "v1.2.2"), /must match package version/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release asset verification requires the tagged tarball and checksum reference", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-release-assets-"));
  const tarball = "tweakers-v1.2.3.tar.gz";
  try {
    writeFileSync(join(root, tarball), "release bytes");
    writeFileSync(join(root, "SHA256SUMS"), `${"a".repeat(64)}  ${tarball}\n`);
    assert.deepEqual(verifyReleaseAssets(root, "v1.2.3"), {
      tarball,
      sums: "SHA256SUMS",
    });

    rmSync(join(root, tarball));
    assert.throws(() => verifyReleaseAssets(root, "v1.2.3"), /missing release asset/);

    writeFileSync(join(root, tarball), "release bytes");
    writeFileSync(join(root, "SHA256SUMS"), `${"a".repeat(64)}  another-file.tar.gz\n`);
    assert.throws(() => verifyReleaseAssets(root, "v1.2.3"), /does not reference/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("tagged archive verification binds every committed manager artifact byte", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-release-archive-"));
  const tag = "v1.2.3";
  const prefix = `tweakers-${tag}`;
  const archiveRoot = join(root, prefix);
  const tarball = `tweakers-${tag}.tar.gz`;
  const managerFiles = [
    "packages/native-host/manager-signing-policy.json",
    "packages/native-host/assets/Tweakers Manager Launcher",
    "packages/installer/assets/manager-launcher/Tweakers Manager Launcher",
    "packages/installer/assets/manager-launcher/manager.mjs",
    "packages/installer/assets/manager-launcher/signing-policy.json",
  ];
  try {
    writeFileSync(join(root, "package.json"), "committed package\n");
    for (const [index, relativePath] of managerFiles.entries()) {
      mkdirSync(join(root, relativePath, ".."), { recursive: true });
      writeFileSync(join(root, relativePath), `committed manager artifact ${index}\n`);
      mkdirSync(join(archiveRoot, relativePath, ".."), { recursive: true });
      writeFileSync(join(archiveRoot, relativePath), `committed manager artifact ${index}\n`);
    }
    writeFileSync(join(archiveRoot, "package.json"), "committed package\n");
    const archived = spawnSync("tar", ["-czf", join(root, tarball), "-C", root, prefix], { encoding: "utf8" });
    assert.equal(archived.status, 0, archived.stderr);
    const digest = createHash("sha256").update(readFileSync(join(root, tarball))).digest("hex");
    writeFileSync(join(root, "SHA256SUMS"), `${digest}  ${tarball}\n`);
    assert.equal(verifyReleaseArchiveAssets(root, tag).sha256, digest);

    writeFileSync(join(root, managerFiles[3]), "changed after archive\n");
    assert.throws(() => verifyReleaseArchiveAssets(root, tag), /stale manager artifact bytes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("root AGENTS policy contains all feature routes and live synchronization gate", () => {
  const policy = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
  for (const route of ["Add to an existing tweak", "Revise an existing tweak", "Create a new tweak"]) assert.match(policy, new RegExp(route));
  assert.match(policy, /npm run sync:tweaks/);
  assert.match(policy, /tweaker dev-sync/);
  assert.match(policy, /Never push a tag or publish/);
});
