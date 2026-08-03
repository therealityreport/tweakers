import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  commitUserQuestionsRollout,
  defaultUserQuestionsRolloutOptions,
  planUserQuestionsRollout,
  prepareUserQuestionsRollout,
  readUserQuestionsRolloutReceipt,
  rollbackUserQuestionsRollout,
  sealUserQuestionsRollout,
} from "../src/user-questions-transaction";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "user-questions-rollout-"));
  const userRoot = join(root, "user");
  const liveTweaksRoot = join(userRoot, "tweaks");
  const tweakersConfigPath = join(userRoot, "config.json");
  const codexConfigPath = join(root, "codex", "config.toml");
  const receiptFile = join(userRoot, "transactions", "user-questions.json");
  const archiveRoot = join(userRoot, "transactions", "archive");
  mkdirSync(liveTweaksRoot, { recursive: true });
  mkdirSync(join(root, "codex"), { recursive: true });
  writeFileSync(codexConfigPath, "# before\n", { mode: 0o600 });
  return {
    root,
    userRoot,
    liveTweaksRoot,
    tweakersConfigPath,
    codexConfigPath,
    receiptFile,
    archiveRoot,
    options: defaultUserQuestionsRolloutOptions({
      userRoot,
      liveTweaksRoot,
      tweakersConfigPath,
      codexConfigPath,
      receiptFile,
      archiveRoot,
      transactionId: "uq-tx-1",
      now: new Date("2026-07-20T12:00:00.000Z"),
    }),
  };
}

function writeLegacyState(f: ReturnType<typeof fixture>): void {
  const legacyId = "co.thomashulihan.user-questions";
  const payload = join(f.liveTweaksRoot, legacyId);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "manifest.json"), '{"version":"0.4.7"}\n');
  const data = join(f.userRoot, "tweak-data", legacyId);
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "draft.json"), '{"kept":true}\n', { mode: 0o600 });
  mkdirSync(join(f.userRoot, "storage"), { recursive: true });
  writeFileSync(join(f.userRoot, "storage", `${legacyId}.json`), '{"view":"legacy"}\n', { mode: 0o600 });
  writeFileSync(f.tweakersConfigPath, JSON.stringify({
    unrelated: { keep: true },
    tweaks: { [legacyId]: { enabled: true } },
    tweakUpdateChecks: { [legacyId]: { checkedAt: "old" } },
  }, null, 2) + "\n", { mode: 0o600 });
}

test("prepare is copy-first across payload, data, storage, and config namespaces", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const plan = planUserQuestionsRollout(f.options);
    assert.equal(plan.holdPromotion, false);
    assert.deepEqual(plan.pathSurfaces.map((surface) => surface.status), ["copy", "copy", "copy"]);

    const prepared = prepareUserQuestionsRollout(plan);
    assert.equal(prepared.phase, "prepared");
    assert.equal(lstatSync(f.receiptFile).mode & 0o777, 0o600);
    for (const surface of prepared.pathSurfaces) {
      assert.equal(existsSync(surface.canonicalPath), true);
      assert.equal(existsSync(surface.selectedLegacyPath!), true);
    }
    const config = JSON.parse(readFileSync(f.tweakersConfigPath, "utf8"));
    assert.deepEqual(config.tweaks["co.tweakers.user-questions"], { enabled: true });
    assert.deepEqual(config.unrelated, { keep: true });
    assert.equal(readFileSync(f.codexConfigPath, "utf8"), "# before\n");
    assert.equal(readUserQuestionsRolloutReceipt(f.receiptFile)?.phase, "prepared");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("current canonical values win and mismatches hold without partial copies", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const canonicalPayload = join(f.liveTweaksRoot, "user-questions");
    mkdirSync(canonicalPayload);
    writeFileSync(join(canonicalPayload, "manifest.json"), '{"version":"0.5.0"}\n');

    const plan = planUserQuestionsRollout(f.options);
    assert.equal(plan.holdPromotion, true);
    assert.equal(plan.pathSurfaces[0]?.status, "conflict");
    const held = prepareUserQuestionsRollout(plan);
    assert.equal(held.phase, "held");
    assert.equal(existsSync(join(f.userRoot, "tweak-data", "co.tweakers.user-questions")), false);
    assert.match(readFileSync(join(canonicalPayload, "manifest.json"), "utf8"), /0\.5\.0/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("prepare and seal are idempotent and sealing rejects MCP conflicts", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const prepared = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    assert.equal(prepareUserQuestionsRollout(prepared), prepared);
    assert.throws(() => sealUserQuestionsRollout(prepared, { mcpConflictCount: 1 }), /MCP conflicts/);
    const sealed = sealUserQuestionsRollout(prepared, { mcpConflictCount: 0 });
    assert.equal(sealed.phase, "sealed");
    assert.equal(sealUserQuestionsRollout(sealed, { mcpConflictCount: 0 }), sealed);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("prepare preserves private nested modes in canonical preimages", () => {
  const f = fixture();
  try {
    const livePayload = join(f.liveTweaksRoot, "user-questions");
    mkdirSync(livePayload, { recursive: true });
    writeFileSync(join(livePayload, "index.js"), "module.exports = {};\n");
    const canonical = join(f.userRoot, "tweak-data", "co.tweakers.user-questions");
    const privateDrafts = join(canonical, "user-questions-drafts.v1");
    mkdirSync(privateDrafts, { recursive: true });
    writeFileSync(join(privateDrafts, "install-secret"), "secret", { mode: 0o600 });
    chmodSync(privateDrafts, 0o700);
    chmodSync(canonical, 0o700);

    const prepared = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    const data = prepared.pathSurfaces.find((surface) => surface.name === "tweak_data")!;

    assert.equal(lstatSync(data.preimagePath).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(data.preimagePath, "user-questions-drafts.v1")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(data.preimagePath, "user-questions-drafts.v1", "install-secret")).mode & 0o777, 0o600);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("commit archives legacy only after acceptance and rollback restores exact preimages", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const configBefore = readFileSync(f.tweakersConfigPath);
    const codexBefore = readFileSync(f.codexConfigPath);
    let receipt = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    writeFileSync(f.codexConfigPath, "# canonical MCP after T6\n", { mode: 0o600 });
    receipt = sealUserQuestionsRollout(receipt, { mcpConflictCount: 0 });
    receipt = commitUserQuestionsRollout(receipt);
    assert.equal(receipt.phase, "committed");
    for (const surface of receipt.pathSurfaces) {
      assert.equal(existsSync(surface.selectedLegacyPath!), false);
      assert.equal(existsSync(surface.legacyArchivePath!), true);
    }
    const committedConfig = JSON.parse(readFileSync(f.tweakersConfigPath, "utf8"));
    assert.equal(committedConfig.tweaks["co.thomashulihan.user-questions"], undefined);

    const rolledBack = rollbackUserQuestionsRollout(receipt);
    assert.equal(rolledBack.phase, "rolled_back");
    assert.deepEqual(readFileSync(f.tweakersConfigPath), configBefore);
    assert.deepEqual(readFileSync(f.codexConfigPath), codexBefore);
    for (const surface of rolledBack.pathSurfaces) {
      assert.equal(existsSync(surface.canonicalPath), false);
      assert.equal(existsSync(surface.selectedLegacyPath!), true);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rollback CAS preserves later edits and performs no partial restore", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    let receipt = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    receipt = sealUserQuestionsRollout(receipt, { mcpConflictCount: 0 });
    const data = receipt.pathSurfaces.find((surface) => surface.name === "tweak_data")!;
    writeFileSync(join(data.canonicalPath, "later.json"), '{"user":true}\n');

    assert.throws(() => rollbackUserQuestionsRollout(receipt), /canonical state changed after sealing/);
    assert.equal(existsSync(join(data.canonicalPath, "later.json")), true);
    assert.equal(existsSync(receipt.pathSurfaces[0]!.canonicalPath), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an ambiguous legacy surface holds the whole prepare", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const secondLegacy = join(f.liveTweaksRoot, "co.second.user-questions");
    mkdirSync(secondLegacy);
    writeFileSync(join(secondLegacy, "manifest.json"), "{}\n");
    f.options.pathSurfaces[0]!.legacyPaths.push(secondLegacy);

    const receipt = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    assert.equal(receipt.phase, "held");
    assert.equal(receipt.pathSurfaces[0]?.status, "ambiguous");
    assert.equal(existsSync(join(f.userRoot, "tweak-data", "co.tweakers.user-questions")), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("rollback restores a pre-existing canonical payload after a sealed replacement", () => {
  const f = fixture();
  try {
    const canonical = join(f.liveTweaksRoot, "user-questions");
    mkdirSync(canonical);
    writeFileSync(join(canonical, "index.js"), "module.exports = 'before';\n", { mode: 0o600 });
    writeFileSync(f.tweakersConfigPath, "{}\n", { mode: 0o600 });
    let receipt = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    rmSync(canonical, { recursive: true, force: true });
    mkdirSync(canonical);
    writeFileSync(join(canonical, "index.js"), "module.exports = 'candidate';\n", { mode: 0o644 });
    receipt = sealUserQuestionsRollout(receipt, { mcpConflictCount: 0 });

    rollbackUserQuestionsRollout(receipt);
    assert.equal(readFileSync(join(canonical, "index.js"), "utf8"), "module.exports = 'before';\n");
    assert.equal(lstatSync(join(canonical, "index.js")).mode & 0o777, 0o600);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("receipt validation rejects insecure mode and unsafe transaction IDs", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    const prepared = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    assert.equal(readUserQuestionsRolloutReceipt(f.receiptFile)?.transactionId, prepared.transactionId);
    chmodSync(f.receiptFile, 0o644);
    assert.equal(readUserQuestionsRolloutReceipt(f.receiptFile), null);
    assert.throws(
      () => planUserQuestionsRollout({ ...f.options, transactionId: "../escape" }),
      /transaction ID is invalid/,
    );
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("commit is idempotent after the durable committed receipt", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    let receipt = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    receipt = sealUserQuestionsRollout(receipt, { mcpConflictCount: 0 });
    const committed = commitUserQuestionsRollout(receipt);
    assert.equal(commitUserQuestionsRollout(committed), committed);
    assert.equal(readUserQuestionsRolloutReceipt(f.receiptFile)?.phase, "committed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("Finder junk in a rollout surface does not break preimage verification", () => {
  const f = fixture();
  try {
    writeLegacyState(f);
    // Finder writes .DS_Store into any directory the user merely browses, and
    // copyDirectoryPreservingModes sweeps it out of every copy. A fingerprint
    // that counted it could never match its own preimage.
    writeFileSync(join(f.userRoot, "tweak-data", "co.thomashulihan.user-questions", ".DS_Store"), "junk\n");
    writeFileSync(join(f.liveTweaksRoot, "co.thomashulihan.user-questions", ".DS_Store"), "junk\n");
    const prepared = prepareUserQuestionsRollout(planUserQuestionsRollout(f.options));
    assert.equal(prepared.phase, "prepared");
    const sealed = sealUserQuestionsRollout(prepared, { mcpConflictCount: 0 });
    assert.equal(commitUserQuestionsRollout(sealed).phase, "committed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
