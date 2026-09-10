import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CandidatePackageFilesystemError,
  assertCandidatePackagePathsDisjoint,
  closeCandidatePackageParentAnchor,
  closeCandidatePackageScratchAnchor,
  createCandidatePackageScratch,
  openCandidatePackageParentAnchor,
  projectCandidatePackagePath,
  publishCandidatePackageExclusively,
} from "../src/candidate-package-filesystem";

test("candidate no-follow projection refuses an intermediate symlink before any package write", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-candidate-projector-")));
  try {
    const production = join(root, "production");
    const publicRoot = join(root, "public");
    mkdirSync(join(production, "existing-parent"), { recursive: true, mode: 0o700 });
    mkdirSync(publicRoot, { mode: 0o700 });
    symlinkSync(production, join(publicRoot, "alias"));
    const requested = join(publicRoot, "alias", "existing-parent", "candidate");
    assert.throws(
      () => projectCandidatePackagePath(requested, "candidate output"),
      (error: unknown) => error instanceof CandidatePackageFilesystemError
        && error.code === "candidate-path-symlink-refused",
    );
    assert.equal(existsSync(join(production, "existing-parent", "candidate")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("descriptor-anchored exclusive publication preserves a raced destination and source evidence", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-candidate-rename-excl-")));
  let descriptor: ReturnType<typeof openCandidatePackageParentAnchor> | null = null;
  let scratch: ReturnType<typeof createCandidatePackageScratch> | null = null;
  try {
    const parent = join(root, "parent");
    const output = join(parent, "output");
    const scratchPath = join(parent, ".output.candidate-fixture");
    mkdirSync(parent, { mode: 0o700 });
    descriptor = openCandidatePackageParentAnchor(projectCandidatePackagePath(parent, "candidate parent"), "candidate parent");
    scratch = createCandidatePackageScratch(scratchPath, descriptor);
    writeFileSync(join(scratchPath, "candidate-sentinel"), "candidate\n");
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(join(output, "raced-sentinel"), "raced\n");

    const outcome = publishCandidatePackageExclusively({ source: scratch, destination: output, parent: descriptor });
    assert.equal(outcome, "destination-exists");
    assert.equal(readFileSync(join(output, "raced-sentinel"), "utf8"), "raced\n");
    assert.equal(readFileSync(join(scratchPath, "candidate-sentinel"), "utf8"), "candidate\n");
  } finally {
    if (scratch) closeCandidatePackageScratchAnchor(scratch);
    if (descriptor) closeCandidatePackageParentAnchor(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced visible output parent cannot redirect scratch creation through its held descriptor", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-candidate-parent-drift-")));
  let descriptor: ReturnType<typeof openCandidatePackageParentAnchor> | null = null;
  try {
    const parent = join(root, "parent");
    const relocated = join(root, "relocated-parent");
    const aliasTarget = join(root, "alias-target");
    const scratch = join(parent, ".output.candidate-fixture");
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(aliasTarget, { mode: 0o700 });
    descriptor = openCandidatePackageParentAnchor(projectCandidatePackagePath(parent, "candidate parent"), "candidate parent");
    renameSync(parent, relocated);
    symlinkSync(aliasTarget, parent);

    assert.throws(
      () => createCandidatePackageScratch(scratch, descriptor!),
      (error: unknown) => error instanceof CandidatePackageFilesystemError
        && error.code === "candidate-parent-visible-drift",
    );
    assert.equal(existsSync(join(aliasTarget, ".output.candidate-fixture")), false);
    assert.equal(existsSync(join(relocated, ".output.candidate-fixture")), false);
  } finally {
    if (descriptor) closeCandidatePackageParentAnchor(descriptor);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an absent candidate tail projected inside an identity root is rejected before mkdir", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-candidate-overlap-")));
  try {
    const identityRoot = join(root, "identity-root");
    mkdirSync(identityRoot, { mode: 0o700 });
    const output = join(identityRoot, "candidate-parent", "candidate-output");
    assert.throws(
      () => assertCandidatePackagePathsDisjoint(
        projectCandidatePackagePath(output, "candidate output"),
        projectCandidatePackagePath(identityRoot, "production identity root"),
        "candidate output",
        "production identity root",
      ),
      (error: unknown) => error instanceof CandidatePackageFilesystemError
        && error.code === "candidate-path-overlap",
    );
    assert.equal(existsSync(join(identityRoot, "candidate-parent")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
