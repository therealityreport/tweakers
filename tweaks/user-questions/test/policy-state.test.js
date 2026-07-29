"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  POLICY_SETTINGS_VIEW_MODEL,
  PolicyTransactionError,
  applyPolicyChange,
  createPolicyCommandInterface,
  getPolicyTransactionStatus,
  maximumAccessApprovalPolicy,
  migrateGlobalState,
  previewPolicyChange,
  questionOnlyApprovalPolicy,
  repairGlobalStateFile,
  restorePolicyChange,
} = require("../policy-state");

const SOURCE_NAME = ".codex-global-state.json";
const TRANSACTIONS_NAME = ".user-questions-policy-transactions";

test("pure migration defaults to Custom mode and maximum-access policy without changing unrelated preferences", () => {
  const source = fixtureValue();
  const result = migrateGlobalState(source);

  assert.equal(result.changed, true);
  assert.equal(result.repairedThreads, 1);
  assert.equal(source["electron-persisted-atom-state"]["agent-mode-by-host-id"].local, "full-access");
  assert.equal(result.state["electron-openai-mcp-form-elicitations-enabled"], false);
  assert.deepEqual(result.state["electron-persisted-atom-state"]["agent-mode-by-host-id"], { local: "custom", remote: "auto" });
  assert.deepEqual(result.state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"], {
    activePermissionProfile: null,
    approvalPolicy: maximumAccessApprovalPolicy(),
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
    runtimeWorkspaceRoots: ["/private/alpha-workspace"],
  });
});

test("permission profiles select exact granular values and can switch an already-managed Full Access task", () => {
  const source = fixtureValue();
  const questionsOnly = migrateGlobalState(source, "questions-only");
  assert.deepEqual(
    questionsOnly.state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"].approvalPolicy,
    questionOnlyApprovalPolicy(),
  );

  const maximum = migrateGlobalState(questionsOnly.state, "maximum-access");
  assert.equal(maximum.changed, true);
  assert.equal(maximum.repairedThreads, 1);
  assert.deepEqual(
    maximum.state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"].approvalPolicy,
    maximumAccessApprovalPolicy(),
  );
});

test("pure migration leaves non-Full-Access and semantically current task policies unchanged", () => {
  const policyWithDifferentKeyOrder = {
    granular: {
      mcp_elicitations: true,
      request_permissions: false,
      skill_approval: false,
      rules: false,
      sandbox_approval: false,
    },
  };
  const current = {
    "electron-persisted-atom-state": {
      "agent-mode-by-host-id": { local: "custom" },
      "heartbeat-thread-permissions-by-id": {
        workspace: { activePermissionProfile: { id: ":workspace" }, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } },
        current: { activePermissionProfile: null, approvalPolicy: policyWithDifferentKeyOrder, sandboxPolicy: { type: "dangerFullAccess" } },
      },
    },
  };

  const result = migrateGlobalState(current, "questions-only");
  assert.deepEqual(result, { changed: false, state: current, repairedThreads: 0 });
});

test("Preview is byte-read-only, mode-bound, and content-redacted", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const before = snapshotTree(fixture.home);
  const preview = previewPolicyChange({ codexHome: fixture.home });

  assert.deepEqual(Object.keys(preview).sort(), [
    "affectedFieldCount",
    "affectedFields",
    "affectedTaskCount",
    "previewToken",
    "profile",
    "sourceFingerprint",
  ]);
  assert.equal(preview.profile, "maximum-access");
  assert.equal(preview.affectedFieldCount, 3);
  assert.equal(preview.affectedTaskCount, 1);
  assert.deepEqual(preview.affectedFields, [
    { name: "electron-persisted-atom-state.agent-mode-by-host-id.local", count: 1 },
    { name: "electron-persisted-atom-state.heartbeat-thread-permissions-by-id.*.activePermissionProfile", count: 1 },
    { name: "electron-persisted-atom-state.heartbeat-thread-permissions-by-id.*.approvalPolicy", count: 1 },
  ]);
  assert.match(preview.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.match(preview.previewToken, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(preview);
  assert.doesNotMatch(serialized, /private-task-alpha|alpha-workspace|secret task content|:danger-full-access/);
  assert.deepEqual(snapshotTree(fixture.home), before);

  fs.chmodSync(fixture.file, 0o600);
  const modeChanged = previewPolicyChange({ codexHome: fixture.home });
  assert.equal(modeChanged.sourceFingerprint, preview.sourceFingerprint);
  assert.notEqual(modeChanged.previewToken, preview.previewToken);
});

test("settings command interface freezes explicit consequences and never exposes a restart command", (t) => {
  const fixture = makeFixture(t);
  const commands = createPolicyCommandInterface({ codexHome: fixture.home });

  assert.equal(commands.viewModel, POLICY_SETTINGS_VIEW_MODEL);
  assert.equal(Object.isFrozen(commands.viewModel), true);
  assert.equal(commands.viewModel.defaultProfile, "maximum-access");
  assert.deepEqual(Object.keys(commands.viewModel.profiles), ["maximum-access", "questions-only"]);
  assert.deepEqual(commands.viewModel.consequences, [
    "Moves the local Codex mode to Custom.",
    "Enables MCP question forms for matching Full Access tasks.",
    "Requires a later Codex restart before the change takes effect.",
  ]);
  assert.deepEqual(Object.keys(commands).sort(), ["apply", "preview", "restore", "status", "viewModel"]);
  assert.deepEqual(commands.status(), { status: "none", transactionId: null, restartRequired: false, restarted: false });
  assert.equal(commands.viewModel.commands.apply.restartsApp, false);
  assert.equal(commands.viewModel.commands.restore.restartsApp, false);
  assert.equal(commands.viewModel.commands.restore.remainsAvailableWhenTweakDisabled, true);

  const before = snapshotTree(fixture.home);
  assert.match(commands.preview().previewToken, /^[a-f0-9]{64}$/);
  assert.equal(commands.preview("questions-only").profile, "questions-only");
  assert.deepEqual(snapshotTree(fixture.home), before, "Preview followed by Cancel/no Apply writes nothing");
});

test("Apply binds the selected profile into its Preview token", (t) => {
  const fixture = makeFixture(t);
  const preview = previewPolicyChange({ codexHome: fixture.home, profile: "maximum-access" });
  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      profile: "questions-only",
    }),
    hasCode("POLICY_PREVIEW_STALE"),
  );
  assert.throws(
    () => previewPolicyChange({ codexHome: fixture.home, profile: "unknown" }),
    hasCode("POLICY_PROFILE_INVALID"),
  );
});

test("deprecated repair compatibility is Preview-only and cannot approve automatic startup mutation", (t) => {
  const fixture = makeFixture(t);
  const before = snapshotTree(fixture.home);
  const result = repairGlobalStateFile({ codexHome: fixture.home });

  assert.deepEqual(result, {
    changed: false,
    reason: "explicit-apply-required",
    repairedThreads: 0,
    affectedThreads: 1,
    previewToken: result.previewToken,
  });
  assert.match(result.previewToken, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshotTree(fixture.home), before);
});

test("Apply requires the exact Preview token and rechecks both source bytes and mode", async (t) => {
  await t.test("source bytes", (t) => {
    const fixture = makeFixture(t);
    const preview = previewPolicyChange({ codexHome: fixture.home });
    fs.appendFileSync(fixture.file, " \n");
    const changed = fs.readFileSync(fixture.file);

    assert.throws(
      () => applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken }),
      hasCode("POLICY_PREVIEW_STALE"),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), changed);
    assert.equal(fs.existsSync(path.join(fixture.home, TRANSACTIONS_NAME)), false);
  });

  await t.test("source mode", (t) => {
    const fixture = makeFixture(t, { mode: 0o600 });
    const preview = previewPolicyChange({ codexHome: fixture.home });
    fs.chmodSync(fixture.file, 0o640);

    assert.throws(
      () => applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken }),
      hasCode("POLICY_PREVIEW_STALE"),
    );
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(path.join(fixture.home, TRANSACTIONS_NAME)), false);
  });

  await t.test("missing token", (t) => {
    const fixture = makeFixture(t);
    assert.throws(() => applyPolicyChange({ codexHome: fixture.home }), hasCode("POLICY_PREVIEW_TOKEN_REQUIRED"));
    assert.equal(fs.existsSync(path.join(fixture.home, TRANSACTIONS_NAME)), false);
  });
});

test("Apply never overwrites a concurrent edit in the final compare-and-replace window and retains recovery evidence", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const concurrentBytes = Buffer.from(`${JSON.stringify({ concurrent: "user edit wins" }, null, 2)}\n`);

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      testHooks: {
        onStage(stage) {
          if (stage !== "apply.source.before-rename") return;
          fs.writeFileSync(fixture.file, concurrentBytes, { mode: 0o640 });
          fs.chmodSync(fixture.file, 0o640);
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.deepEqual(fs.readFileSync(fixture.file), concurrentBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.recovery.sourceSha256, hash(concurrentBytes));
});

test("Apply retains private recovery evidence when rollback cannot safely overwrite drift", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const concurrentBytes = Buffer.from(`${JSON.stringify({ concurrent: "after apply" }, null, 2)}\n`);

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      testHooks: {
        onStage(stage) {
          if (stage === "apply.receipt-commit.before-fsync") {
            const error = new Error("injected receipt failure");
            error.code = "EIO";
            throw error;
          }
          if (stage === "apply.rollback.before-write") {
            fs.writeFileSync(fixture.file, concurrentBytes, { mode: 0o640 });
            fs.chmodSync(fixture.file, 0o640);
          }
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.deepEqual(fs.readFileSync(fixture.file), concurrentBytes);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const names = fs.readdirSync(transactionDirectory).sort();
  assert.equal(names.some((name) => name.endsWith(".before.json")), true);
  assert.equal(names.some((name) => name.endsWith(".receipt.json")), true);
  for (const name of names) {
    const expectedMode = name.endsWith(".evidence") ? 0o640 : 0o600;
    assert.equal(fs.statSync(path.join(transactionDirectory, name)).mode & 0o777, expectedMode);
  }
  const receiptName = names.find((name) => name.endsWith(".receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.beforeSha256, hash(fixture.originalBytes));
  assert.equal(receipt.recovery.sourceSha256, hash(concurrentBytes));
  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "recovery-required",
    transactionId: receipt.transactionId,
    restartRequired: true,
    restarted: false,
  });
});

test("Apply recovery CAS preserves an in-place edit made after recovery validation", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const concurrentBytes = Buffer.from(`${JSON.stringify({ concurrent: "recovery validation edit wins" }, null, 2)}\n`);
  let publicationFailed = false;

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      testHooks: {
        onStage(stage) {
          if (stage === "apply.source.directory-fsync" && !publicationFailed) {
            publicationFailed = true;
            const error = new Error("injected publication failure");
            error.code = "EIO";
            throw error;
          }
          if (stage === "apply.source.recovery.after-validation") {
            fs.writeFileSync(fixture.file, concurrentBytes);
            fs.chmodSync(fixture.file, 0o640);
          }
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.equal(publicationFailed, true);
  assert.deepEqual(fs.readFileSync(fixture.file), concurrentBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const names = fs.readdirSync(transactionDirectory).sort();
  const backupName = names.find((name) => name.endsWith(".before.json"));
  const receiptName = names.find((name) => name.endsWith(".receipt.json"));
  assert.ok(backupName);
  assert.ok(receiptName);
  assert.equal(fs.statSync(path.join(transactionDirectory, backupName)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(transactionDirectory, receiptName)).mode & 0o777, 0o600);
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.recovery.sourceSha256, hash(concurrentBytes));
  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "recovery-required",
    transactionId: receipt.transactionId,
    restartRequired: true,
    restarted: false,
  });
});

test("Apply recovery retains private evidence even when the exact source preimage is restored", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  let publicationFailed = false;
  let recoveryValidated = false;

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      testHooks: {
        onStage(stage) {
          if (stage === "apply.source.directory-fsync" && !publicationFailed) {
            publicationFailed = true;
            const error = new Error("injected publication failure");
            error.code = "EIO";
            throw error;
          }
          if (stage === "apply.source.recovery.after-validation") recoveryValidated = true;
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.equal(recoveryValidated, true);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  assert.deepEqual(temporaryArtifacts(fixture.home), []);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const names = fs.readdirSync(transactionDirectory).sort();
  const evidenceName = names.find((name) => name.endsWith(".evidence"));
  const receiptName = names.find((name) => name.endsWith(".receipt.json"));
  assert.ok(evidenceName);
  assert.ok(receiptName);
  assert.equal(fs.statSync(path.join(transactionDirectory, evidenceName)).mode & 0o777, 0o600);
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.recovery.code, "POLICY_REPLACEMENT_EVIDENCE_RETAINED");
  assert.equal(receipt.recovery.sourceSha256, hash(fixture.originalBytes));
  assert.equal(receipt.recovery.evidence.status, "retained");
  assert.equal(receipt.recovery.evidence.sourceState, "preimage-restored");
  assert.equal(receipt.recovery.evidence.file, path.join(transactionDirectory, evidenceName));
  assert.equal(receipt.recovery.evidence.observedSha256, hash(fs.readFileSync(receipt.recovery.evidence.file)));
});

test("Apply keeps a late open-fd write reachable through retained evidence after final validation", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const concurrentBytes = Buffer.from(`${JSON.stringify({ concurrent: "late open-fd write" }, null, 2)}\n`);
  let heldDescriptor = null;
  let heldIdentity = null;
  let lateWriteInjected = false;
  let publicationFailed = false;
  const injectedFs = { ...fs };

  injectedFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (to.endsWith(".recovery")) {
      heldDescriptor = fs.openSync(to, "r+");
      const stat = fs.fstatSync(heldDescriptor);
      heldIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
    }
  };
  injectedFs.unlinkSync = (file) => {
    if (!lateWriteInjected && heldDescriptor !== null && file.endsWith(".cas")) {
      lateWriteInjected = true;
      fs.ftruncateSync(heldDescriptor, 0);
      fs.writeSync(heldDescriptor, concurrentBytes, 0, concurrentBytes.length, 0);
      fs.fsyncSync(heldDescriptor);
    }
    return fs.unlinkSync(file);
  };
  t.after(() => {
    if (heldDescriptor !== null) fs.closeSync(heldDescriptor);
  });

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      deps: {
        fs: injectedFs,
        path,
        crypto,
        homedir: os.homedir,
        env: process.env,
        pid: process.pid,
        now: () => new Date().toISOString(),
        randomUUID: () => crypto.randomUUID(),
      },
      testHooks: {
        onStage(stage) {
          if (stage !== "apply.source.directory-fsync" || publicationFailed) return;
          publicationFailed = true;
          const error = new Error("injected publication failure");
          error.code = "EIO";
          throw error;
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.equal(publicationFailed, true);
  assert.equal(lateWriteInjected, true);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const names = fs.readdirSync(transactionDirectory).sort();
  assert.equal(names.some((name) => name.endsWith(".cas") || name.endsWith(".recovery")), false);
  assert.equal(names.some((name) => name.endsWith(".before.json")), true);
  const evidenceName = names.find((name) => name.endsWith(".evidence"));
  const receiptName = names.find((name) => name.endsWith(".receipt.json"));
  assert.ok(evidenceName);
  assert.ok(receiptName);
  const evidenceFile = path.join(transactionDirectory, evidenceName);
  const evidenceStat = fs.lstatSync(evidenceFile);
  assert.deepEqual({ dev: String(evidenceStat.dev), ino: String(evidenceStat.ino) }, heldIdentity);
  assert.equal(evidenceStat.mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(evidenceFile), concurrentBytes);
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.recovery.evidence.file, evidenceFile);
  assert.equal(receipt.recovery.evidence.observedSha256, hash(concurrentBytes));
  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "recovery-required",
    transactionId: receipt.transactionId,
    restartRequired: true,
    restarted: false,
  });
});

test("Apply leaves every inode named when private evidence publication fails", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const injectedFs = { ...fs };
  let publicationFailed = false;
  let evidenceLinkFailed = false;

  injectedFs.linkSync = (from, to) => {
    if (to.endsWith(".evidence")) {
      evidenceLinkFailed = true;
      const error = new Error("injected evidence-link failure");
      error.code = "EIO";
      throw error;
    }
    return fs.linkSync(from, to);
  };

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      deps: {
        fs: injectedFs,
        path,
        crypto,
        homedir: os.homedir,
        env: process.env,
        pid: process.pid,
        now: () => new Date().toISOString(),
        randomUUID: () => crypto.randomUUID(),
      },
      testHooks: {
        onStage(stage) {
          if (stage !== "apply.source.directory-fsync" || publicationFailed) return;
          publicationFailed = true;
          const error = new Error("injected publication failure");
          error.code = "EIO";
          throw error;
        },
      },
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.equal(publicationFailed, true);
  assert.equal(evidenceLinkFailed, true);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.recovery.sourceSha256, hash(fs.readFileSync(fixture.file)));
  assert.notEqual(receipt.recovery.sourceSha256, hash(fixture.originalBytes));
  assert.equal(fs.readdirSync(transactionDirectory).some((name) => name.endsWith(".before.json")), true);
  const publicNames = fs.readdirSync(fixture.home);
  const capturedName = publicNames.find((name) => name.endsWith(".cas"));
  const retiredName = publicNames.find((name) => name.endsWith(".recovery"));
  assert.ok(capturedName);
  assert.ok(retiredName);
  assert.deepEqual(fs.readFileSync(path.join(fixture.home, capturedName)), fixture.originalBytes);
  const sourceStat = fs.lstatSync(fixture.file);
  const retiredStat = fs.lstatSync(path.join(fixture.home, retiredName));
  assert.deepEqual(
    { dev: String(retiredStat.dev), ino: String(retiredStat.ino) },
    { dev: String(sourceStat.dev), ino: String(sourceStat.ino) },
  );
});

test("Apply creates a unique private raw backup and durable receipt, verifies hashes, and is idempotent", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const applied = applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken });

  assert.equal(applied.status, "applied");
  assert.equal(applied.changed, true);
  assert.equal(applied.restartRequired, true);
  assert.equal(applied.restarted, false);
  assert.match(applied.transactionId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(fs.readFileSync(applied.backupFile), fixture.originalBytes);
  assert.equal(fs.statSync(applied.backupFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(applied.receiptFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(applied.receiptFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  assert.equal(hash(fs.readFileSync(fixture.file)), applied.appliedSha256);
  assert.equal(hash(fixture.originalBytes), applied.beforeSha256);

  const state = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  const task = state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"];
  assert.equal(state["electron-persisted-atom-state"]["agent-mode-by-host-id"].local, "custom");
  assert.equal(task.activePermissionProfile, null);
  assert.deepEqual(task.approvalPolicy, maximumAccessApprovalPolicy());
  assert.deepEqual(task.runtimeWorkspaceRoots, ["/private/alpha-workspace"]);
  assert.deepEqual(task.sandboxPolicy, { type: "dangerFullAccess", networkAccess: true });

  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.beforeSha256, applied.beforeSha256);
  assert.equal(receipt.appliedSha256, applied.appliedSha256);
  assert.equal(receipt.beforeMode, 0o640);
  assert.equal(receipt.appliedMode, 0o640);
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.sourceEvidence.length, 1);
  assert.equal(receipt.sourceEvidence[0].operation, "apply-source");
  assert.equal(fs.statSync(receipt.sourceEvidence[0].file).mode & 0o777, 0o640);
  assert.equal(receipt.targets.length, 3);
  assert.equal(receipt.targets.some((target) => target.path.includes("private-task-alpha")), true);
  assert.equal(receipt.targets.every((target) => target.before && target.applied), true);
  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "restorable",
    transactionId: applied.transactionId,
    profile: "maximum-access",
    targetCount: 3,
    appliedTargetCount: 3,
    beforeTargetCount: 0,
    otherTargetCount: 0,
    restartRequired: true,
    restarted: false,
  });

  const filesBeforeRetry = snapshotTree(fixture.home);
  const retry = applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken });
  assert.equal(retry.status, "already-applied");
  assert.equal(retry.changed, false);
  assert.equal(retry.transactionId, applied.transactionId);
  assert.deepEqual(snapshotTree(fixture.home), filesBeforeRetry);
});

test("status detects a running host rewriting every applied target from cached task settings", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const applied = previewAndApply(fixture.home);

  fs.writeFileSync(fixture.file, fixture.originalBytes);
  fs.chmodSync(fixture.file, 0o640);

  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "overwritten",
    transactionId: applied.transactionId,
    profile: "maximum-access",
    targetCount: 3,
    appliedTargetCount: 0,
    beforeTargetCount: 3,
    otherTargetCount: 0,
    restartRequired: false,
    restarted: false,
  });
});

test("Apply retains the exact replaced inode and tolerates later open-fd evidence hash drift", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });
  const cleanupWindowBytes = Buffer.from("apply cleanup-window bytes\n");
  const laterBytes = Buffer.from("apply later open-fd bytes\n");
  const injectedFs = { ...fs };
  let capturedFile = null;
  let heldDescriptor = null;
  let heldIdentity = null;
  let cleanupWriteInjected = false;

  injectedFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (from === fixture.file && to.endsWith(".cas")) {
      capturedFile = to;
      heldDescriptor = fs.openSync(to, "r+");
      const stat = fs.fstatSync(heldDescriptor);
      heldIdentity = { device: String(stat.dev), inode: String(stat.ino) };
    }
  };
  injectedFs.unlinkSync = (file) => {
    if (!cleanupWriteInjected && heldDescriptor !== null && file === capturedFile) {
      cleanupWriteInjected = true;
      writeDescriptor(heldDescriptor, cleanupWindowBytes);
    }
    return fs.unlinkSync(file);
  };
  t.after(() => {
    if (heldDescriptor !== null) fs.closeSync(heldDescriptor);
  });

  const applied = applyPolicyChange({
    codexHome: fixture.home,
    previewToken: preview.previewToken,
    deps: depsWithFs(injectedFs),
  });
  assert.equal(cleanupWriteInjected, true);
  assert.equal(applied.status, "applied");
  assert.deepEqual(temporaryArtifacts(fixture.home), []);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  const evidence = receipt.sourceEvidence.find((entry) => entry.operation === "apply-source");
  assert.ok(evidence);
  assert.deepEqual({ device: evidence.device, inode: evidence.inode }, heldIdentity);
  assert.equal(fs.lstatSync(evidence.file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(evidence.file), cleanupWindowBytes);
  assert.equal(evidence.observedSha256, hash(cleanupWindowBytes));

  writeDescriptor(heldDescriptor, laterBytes);
  assert.notEqual(hash(fs.readFileSync(evidence.file)), evidence.observedSha256);
  const retry = applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken });
  assert.equal(retry.status, "already-applied", "idempotent Apply validates identity but permits observational hash drift");
  assert.equal(getPolicyTransactionStatus({ codexHome: fixture.home }).status, "restorable");
});

test("Apply of an already-current Preview is a no-write idempotent result", (t) => {
  const fixture = makeFixture(t, { value: currentFixtureValue() });
  const before = snapshotTree(fixture.home);
  const preview = previewPolicyChange({ codexHome: fixture.home });
  assert.equal(preview.affectedFieldCount, 0);

  const result = applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken });
  assert.deepEqual(result, {
    status: "current",
    changed: false,
    transactionId: null,
    restartRequired: false,
    restarted: false,
    profile: "maximum-access",
  });
  assert.deepEqual(snapshotTree(fixture.home), before);
});

test("Restore with no intervening edits recovers exact original bytes and mode and is idempotent", (t) => {
  const fixture = makeFixture(t, { mode: 0o640, rawPrefix: "{\n    \"format-note\": \"original spacing\",\n" });
  const applied = previewAndApply(fixture.home);
  const restored = restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId });

  assert.equal(restored.status, "restored");
  assert.equal(restored.changed, true);
  assert.equal(restored.restartRequired, true);
  assert.equal(restored.restarted, false);
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.equal(receipt.status, "restored");
  assert.equal(receipt.restoredSha256, hash(fixture.originalBytes));
  assert.equal(receipt.restoreSourceChanged, true);
  assert.deepEqual(receipt.sourceEvidence.map((evidence) => evidence.operation), ["apply-source", "restore-source"]);
  assert.equal(fs.statSync(applied.receiptFile).mode & 0o777, 0o600);
  assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home }), {
    status: "none",
    transactionId: null,
    restartRequired: false,
    restarted: false,
  });

  const beforeRetry = snapshotTree(fixture.home);
  const retry = restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId });
  assert.equal(retry.status, "already-restored");
  assert.equal(retry.changed, false);
  assert.deepEqual(snapshotTree(fixture.home), beforeRetry);
});

test("Restore retains the exact applied inode and preserves both evidence records across later hash drift", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const applied = previewAndApply(fixture.home);
  const cleanupWindowBytes = Buffer.from("restore cleanup-window bytes\n");
  const laterBytes = Buffer.from("restore later open-fd bytes\n");
  const injectedFs = { ...fs };
  let capturedFile = null;
  let heldDescriptor = null;
  let heldIdentity = null;
  let cleanupWriteInjected = false;

  injectedFs.renameSync = (from, to) => {
    fs.renameSync(from, to);
    if (from === fixture.file && to.endsWith(".cas")) {
      capturedFile = to;
      heldDescriptor = fs.openSync(to, "r+");
      const stat = fs.fstatSync(heldDescriptor);
      heldIdentity = { device: String(stat.dev), inode: String(stat.ino) };
    }
  };
  injectedFs.unlinkSync = (file) => {
    if (!cleanupWriteInjected && heldDescriptor !== null && file === capturedFile) {
      cleanupWriteInjected = true;
      writeDescriptor(heldDescriptor, cleanupWindowBytes);
    }
    return fs.unlinkSync(file);
  };
  t.after(() => {
    if (heldDescriptor !== null) fs.closeSync(heldDescriptor);
  });

  const restored = restorePolicyChange({
    codexHome: fixture.home,
    transactionId: applied.transactionId,
    deps: depsWithFs(injectedFs),
  });
  assert.equal(cleanupWriteInjected, true);
  assert.equal(restored.status, "restored");
  assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
  assert.deepEqual(temporaryArtifacts(fixture.home), []);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.deepEqual(receipt.sourceEvidence.map((entry) => entry.operation), ["apply-source", "restore-source"]);
  const evidence = receipt.sourceEvidence.find((entry) => entry.operation === "restore-source");
  assert.deepEqual({ device: evidence.device, inode: evidence.inode }, heldIdentity);
  assert.equal(fs.lstatSync(evidence.file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readFileSync(evidence.file), cleanupWindowBytes);
  assert.equal(evidence.observedSha256, hash(cleanupWindowBytes));

  writeDescriptor(heldDescriptor, laterBytes);
  assert.notEqual(hash(fs.readFileSync(evidence.file)), evidence.observedSha256);
  const retry = restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId });
  assert.equal(retry.status, "already-restored", "idempotent Restore validates both inode identities while allowing hash drift");
});

test("Restore performs a three-way targeted merge and preserves unrelated byte-state changes and mode", (t) => {
  const fixture = makeFixture(t, { mode: 0o600 });
  const applied = previewAndApply(fixture.home);
  const edited = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  edited["unrelated-after-apply"] = { note: "preserve this edit" };
  edited["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"].runtimeWorkspaceRoots = ["/new/unrelated/workspace"];
  fs.writeFileSync(fixture.file, `${JSON.stringify(edited)}\n`);
  fs.chmodSync(fixture.file, 0o640);

  const restored = restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId });
  assert.equal(restored.status, "restored");
  const state = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  const task = state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"];
  assert.deepEqual(state["unrelated-after-apply"], { note: "preserve this edit" });
  assert.deepEqual(task.runtimeWorkspaceRoots, ["/new/unrelated/workspace"]);
  assert.deepEqual(task.activePermissionProfile, { id: ":danger-full-access", extends: null });
  assert.equal(task.approvalPolicy, "never");
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640, "an unrelated intervening mode edit is preserved");
});

test("Restore is all-or-nothing and refuses targeted drift without touching bytes", (t) => {
  const fixture = makeFixture(t);
  const applied = previewAndApply(fixture.home);
  const drifted = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
  drifted["unrelated-after-apply"] = true;
  drifted["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"].approvalPolicy = "on-request";
  fs.writeFileSync(fixture.file, `${JSON.stringify(drifted, null, 2)}\n`);
  const beforeRestore = fs.readFileSync(fixture.file);

  assert.throws(
    () => restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId }),
    hasCode("POLICY_TARGET_DRIFT"),
  );
  assert.deepEqual(fs.readFileSync(fixture.file), beforeRestore);
  assert.equal(JSON.parse(fs.readFileSync(applied.receiptFile, "utf8")).status, "applied");
});

test("missing, malformed, unsafe, and private-artifact permission states fail closed", async (t) => {
  await t.test("missing", (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-policy-missing-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    assert.throws(() => previewPolicyChange({ codexHome: home }), hasCode("POLICY_SOURCE_MISSING"));
    assert.deepEqual(repairGlobalStateFile({ codexHome: home }), { changed: false, reason: "missing", repairedThreads: 0 });
    assert.deepEqual(fs.readdirSync(home), []);
  });

  await t.test("malformed JSON", (t) => {
    const fixture = makeFixture(t, { raw: Buffer.from("not-json\n") });
    const before = snapshotTree(fixture.home);
    assert.throws(() => previewPolicyChange({ codexHome: fixture.home }), hasCode("POLICY_SOURCE_INVALID"));
    assert.deepEqual(repairGlobalStateFile({ codexHome: fixture.home }), { changed: false, reason: "invalid", repairedThreads: 0 });
    assert.deepEqual(snapshotTree(fixture.home), before);
  });

  await t.test("source symlink", (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-policy-link-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const target = path.join(home, "target.json");
    fs.writeFileSync(target, "{}\n", { mode: 0o600 });
    fs.symlinkSync(target, path.join(home, SOURCE_NAME));
    assert.throws(() => previewPolicyChange({ codexHome: home }), hasCode("POLICY_SOURCE_UNSAFE"));
    assert.equal(fs.readFileSync(target, "utf8"), "{}\n");
  });

  await t.test("receipt mode", (t) => {
    const fixture = makeFixture(t);
    const applied = previewAndApply(fixture.home);
    fs.chmodSync(applied.receiptFile, 0o644);
    const before = fs.readFileSync(fixture.file);
    assert.throws(
      () => restorePolicyChange({ codexHome: fixture.home, transactionId: applied.transactionId }),
      hasCode("POLICY_ARTIFACT_PERMISSIONS"),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), before);
  });
});

for (const [label, stage, errorCode] of [
  ["permission", "apply.transaction-directory.before-create", "EACCES"],
  ["backup", "apply.backup.before-open", "EIO"],
  ["write", "apply.source.before-write", "EIO"],
  ["file fsync", "apply.source.before-fsync", "EIO"],
  ["rename", "apply.source.before-rename", "EIO"],
]) {
  test(`Apply ${label} failure injection preserves exact source and cleans temporary artifacts`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const preview = previewPolicyChange({ codexHome: fixture.home });

    assert.throws(
      () => applyPolicyChange({
        codexHome: fixture.home,
        previewToken: preview.previewToken,
        testHooks: failOnce(stage, errorCode),
      }),
      (error) => error instanceof PolicyTransactionError && /^POLICY_APPLY/.test(error.code),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
    assert.deepEqual(temporaryArtifacts(fixture.home), []);
    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    assert.equal(!fs.existsSync(transactionDirectory) || fs.readdirSync(transactionDirectory).length === 0, true);
  });
}

test("Apply receipt-commit failure restores source but retains and receipts both replaced inodes", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const preview = previewPolicyChange({ codexHome: fixture.home });

  assert.throws(
    () => applyPolicyChange({
      codexHome: fixture.home,
      previewToken: preview.previewToken,
      testHooks: failOnce("apply.receipt-commit.before-fsync", "EIO"),
    }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );

  assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  assert.deepEqual(temporaryArtifacts(fixture.home), []);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.deepEqual(receipt.sourceEvidence.map((evidence) => evidence.operation), ["apply-source", "apply-rollback"]);
  for (const evidence of receipt.sourceEvidence) {
    assert.equal(fs.existsSync(evidence.file), true);
    const stat = fs.lstatSync(evidence.file);
    assert.equal(String(stat.dev), evidence.device);
    assert.equal(String(stat.ino), evidence.inode);
    assert.equal(stat.mode & 0o777, evidence.capturedMode);
  }
});

for (const [label, stage, expectedSource] of [
  ["evidence-directory fsync", "apply.source.success-evidence.directory-fsync", "original"],
  ["capture-release fsync", "apply.source.capture-release-fsync", "applied"],
  ["final evidence observation", "apply.source.success-evidence.before-final-observation", "applied"],
]) {
  test(`Apply ${label} failure records every retained evidence path and never reports a clean failure`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const preview = previewPolicyChange({ codexHome: fixture.home });

    assert.throws(
      () => applyPolicyChange({
        codexHome: fixture.home,
        previewToken: preview.previewToken,
        testHooks: failOnce(stage, "EIO"),
      }),
      hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
    );

    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
    const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
    assert.equal(receipt.status, "recovery-required");
    assert.equal(receipt.sourceEvidence.some((evidence) => evidence.operation === "apply-source"), true);
    assert.equal(fs.readdirSync(transactionDirectory).some((name) => name.endsWith(".before.json")), true);
    assertAllEvidenceReferenced(transactionDirectory, receipt);
    if (expectedSource === "original") assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
    else assert.equal(hash(fs.readFileSync(fixture.file)), receipt.appliedSha256);
  });
}

for (const [label, stage] of [
  ["directory fsync", "apply.source.directory-fsync"],
  ["verification", "apply.source.before-verify"],
]) {
  test(`Apply ${label} failure after publication restores source and retains private evidence`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const preview = previewPolicyChange({ codexHome: fixture.home });

    assert.throws(
      () => applyPolicyChange({
        codexHome: fixture.home,
        previewToken: preview.previewToken,
        testHooks: failOnce(stage, "EIO"),
      }),
      hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), fixture.originalBytes);
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
    assert.deepEqual(temporaryArtifacts(fixture.home), []);
    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    const names = fs.readdirSync(transactionDirectory).sort();
    const receiptName = names.find((name) => name.endsWith(".receipt.json"));
    const evidenceName = names.find((name) => name.endsWith(".evidence"));
    assert.ok(receiptName);
    assert.ok(evidenceName);
    const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
    assert.equal(receipt.status, "recovery-required");
    assert.equal(receipt.recovery.evidence.file, path.join(transactionDirectory, evidenceName));
  });
}

for (const [label, stage] of [
  ["write", "restore.source.before-write"],
  ["file fsync", "restore.source.before-fsync"],
  ["rename", "restore.source.before-rename"],
]) {
  test(`Restore ${label} failure injection recovers the applied preimage and receipt`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const applied = previewAndApply(fixture.home);
    const appliedBytes = fs.readFileSync(fixture.file);

    assert.throws(
      () => restorePolicyChange({
        codexHome: fixture.home,
        transactionId: applied.transactionId,
        testHooks: failOnce(stage, "EIO"),
      }),
      (error) => error instanceof PolicyTransactionError && /^POLICY_RESTORE/.test(error.code),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), appliedBytes);
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
    assert.equal(JSON.parse(fs.readFileSync(applied.receiptFile, "utf8")).status, "applied");
    assert.deepEqual(temporaryArtifacts(fixture.home), []);
  });
}

test("Restore receipt-commit failure recovers the applied source and receipts every replaced inode", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const applied = previewAndApply(fixture.home);
  const appliedBytes = fs.readFileSync(fixture.file);

  assert.throws(
    () => restorePolicyChange({
      codexHome: fixture.home,
      transactionId: applied.transactionId,
      testHooks: failOnce("restore.receipt-commit.before-fsync", "EIO"),
    }),
    hasCode("POLICY_RESTORE_ROLLBACK_FAILED"),
  );

  assert.deepEqual(fs.readFileSync(fixture.file), appliedBytes);
  assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
  assert.deepEqual(temporaryArtifacts(fixture.home), []);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.deepEqual(
    receipt.sourceEvidence.map((evidence) => evidence.operation),
    ["apply-source", "restore-source", "restore-rollback"],
  );
  assert.equal(receipt.sourceEvidence.every((evidence) => fs.existsSync(evidence.file)), true);
});

test("Restore rollback evidence-publication failure discloses every retained inode in its recovery receipt", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const applied = previewAndApply(fixture.home);
  const failedStages = new Set();

  assert.throws(
    () => restorePolicyChange({
      codexHome: fixture.home,
      transactionId: applied.transactionId,
      testHooks: {
        onStage(stage) {
          if (stage === "restore.receipt-commit.before-fsync" && !failedStages.has(stage)) {
            failedStages.add(stage);
            const error = new Error("injected restore receipt failure");
            error.code = "EIO";
            throw error;
          }
          if (stage === "restore.rollback.success-evidence.directory-fsync" && !failedStages.has(stage)) {
            failedStages.add(stage);
            const error = new Error("injected rollback evidence fsync failure");
            error.code = "EIO";
            throw error;
          }
        },
      },
    }),
    hasCode("POLICY_RESTORE_ROLLBACK_FAILED"),
  );

  assert.deepEqual(
    [...failedStages].sort(),
    ["restore.receipt-commit.before-fsync", "restore.rollback.success-evidence.directory-fsync"].sort(),
  );
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assert.equal(receipt.sourceEvidence.some((evidence) => evidence.operation === "restore-source"), true);
  assert.equal(receipt.sourceEvidence.some((evidence) => evidence.operation === "restore-rollback"), true);
  assertAllEvidenceReferenced(transactionDirectory, receipt);
});

for (const [label, stage] of [
  ["directory fsync", "restore.source.directory-fsync"],
  ["verification", "restore.source.before-verify"],
]) {
  test(`Restore ${label} failure after publication retains private evidence and requires recovery`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const applied = previewAndApply(fixture.home);
    const appliedBytes = fs.readFileSync(fixture.file);

    assert.throws(
      () => restorePolicyChange({
        codexHome: fixture.home,
        transactionId: applied.transactionId,
        testHooks: failOnce(stage, "EIO"),
      }),
      hasCode("POLICY_RESTORE_ROLLBACK_FAILED"),
    );
    assert.deepEqual(fs.readFileSync(fixture.file), appliedBytes);
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o640);
    assert.deepEqual(temporaryArtifacts(fixture.home), []);
    const names = fs.readdirSync(path.join(fixture.home, TRANSACTIONS_NAME)).sort();
    const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
    assert.equal(receipt.status, "recovery-required");
    assert.equal(receipt.recovery.evidence.status, "retained");
    assert.equal(names.includes(path.basename(receipt.recovery.evidence.file)), true);
  });
}

for (const [operation, prepare, stages, expectedCode] of [
  [
    "Apply",
    (fixture) => ({
      run: (testHooks) => applyPolicyChange({
        codexHome: fixture.home,
        previewToken: previewPolicyChange({ codexHome: fixture.home }).previewToken,
        testHooks,
      }),
    }),
    ["apply.source.directory-fsync", "apply.source.recovery.evidence-directory-fsync"],
    "POLICY_APPLY_ROLLBACK_FAILED",
  ],
  [
    "Restore",
    (fixture) => {
      const applied = previewAndApply(fixture.home);
      return {
        run: (testHooks) => restorePolicyChange({
          codexHome: fixture.home,
          transactionId: applied.transactionId,
          testHooks,
        }),
      };
    },
    ["restore.source.directory-fsync", "restore.source.recovery.evidence-directory-fsync"],
    "POLICY_RESTORE_ROLLBACK_FAILED",
  ],
]) {
  test(`${operation} recovery evidence fsync failure remains durably referenced`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const flow = prepare(fixture);
    const failedStages = new Set();
    const testHooks = {
      onStage(stage) {
        if (!stages.includes(stage) || failedStages.has(stage)) return;
        failedStages.add(stage);
        const error = new Error(`injected ${stage}`);
        error.code = "EIO";
        throw error;
      },
    };

    assert.throws(() => flow.run(testHooks), hasCode(expectedCode));
    assert.deepEqual([...failedStages].sort(), [...stages].sort());
    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
    const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
    assert.equal(receipt.status, "recovery-required");
    assert.equal(receipt.recovery.evidence.status, "provisional");
    assert.equal(fs.existsSync(receipt.recovery.evidence.file), true);
    assertAllEvidenceReferenced(transactionDirectory, receipt);
  });
}

test("Apply retries a failed recovery-receipt commit and references every retained inode", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const injected = fsWithReceiptFsyncFailures(new Set([2, 3]));
  const deps = depsWithFs(injected.fs);
  const preview = previewPolicyChange({ codexHome: fixture.home, deps });

  assert.throws(
    () => applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken, deps }),
    hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
  );
  assert.deepEqual(injected.failedWrites, [2, 3]);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
  const receipt = JSON.parse(fs.readFileSync(path.join(transactionDirectory, receiptName), "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assertAllEvidenceReferenced(transactionDirectory, receipt);
});

test("Restore retries a failed recovery-receipt commit and references every retained inode", (t) => {
  const fixture = makeFixture(t, { mode: 0o640 });
  const applied = previewAndApply(fixture.home);
  const injected = fsWithReceiptFsyncFailures(new Set([1, 2]));

  assert.throws(
    () => restorePolicyChange({
      codexHome: fixture.home,
      transactionId: applied.transactionId,
      deps: depsWithFs(injected.fs),
    }),
    hasCode("POLICY_RESTORE_ROLLBACK_FAILED"),
  );
  assert.deepEqual(injected.failedWrites, [1, 2]);
  const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
  const receipt = JSON.parse(fs.readFileSync(applied.receiptFile, "utf8"));
  assert.equal(receipt.status, "recovery-required");
  assertAllEvidenceReferenced(transactionDirectory, receipt);
});

for (const [label, tamper] of [
  ["deleted", (file) => fs.unlinkSync(file)],
  ["substituted", (file) => {
    const mode = fs.statSync(file).mode & 0o777;
    fs.unlinkSync(file);
    fs.writeFileSync(file, "substituted sidecar evidence\n", { mode });
  }],
]) {
  test(`status remains recovery-required when fallback sidecar evidence is ${label}`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const injected = fsWithReceiptFsyncFailures(new Set([2, 3, 4]));
    const deps = depsWithFs(injected.fs);
    const preview = previewPolicyChange({ codexHome: fixture.home, deps });

    assert.throws(
      () => applyPolicyChange({ codexHome: fixture.home, previewToken: preview.previewToken, deps }),
      hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
    );
    assert.deepEqual(injected.failedWrites, [2, 3, 4]);
    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    const recoveryName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".recovery.json"));
    assert.ok(recoveryName, "recovery receipt fallback must be published");
    const recovery = JSON.parse(fs.readFileSync(path.join(transactionDirectory, recoveryName), "utf8"));
    const evidence = recovery.sourceEvidence.find((entry) => entry.status === "retained");
    assert.ok(evidence, "fallback sidecar must reference retained evidence");
    tamper(evidence.file);

    assert.deepEqual(getPolicyTransactionStatus({ codexHome: fixture.home, deps }), {
      status: "recovery-required",
      transactionId: recovery.transactionId,
      restartRequired: true,
      restarted: false,
    });
  });
}

for (const [label, tamper, expectedCode] of [
  [
    "path escape",
    (receipt, fixture) => { receipt.recovery.evidence.file = path.join(fixture.home, "outside.recovery.evidence"); },
    "POLICY_RECEIPT_INVALID",
  ],
  [
    "missing artifact",
    (receipt) => { fs.unlinkSync(receipt.recovery.evidence.file); },
    "POLICY_RECOVERY_EVIDENCE_INVALID",
  ],
  [
    "substituted inode",
    (receipt) => {
      fs.unlinkSync(receipt.recovery.evidence.file);
      fs.writeFileSync(receipt.recovery.evidence.file, "substituted evidence\n", { mode: receipt.recovery.evidence.mode });
    },
    "POLICY_RECOVERY_EVIDENCE_INVALID",
  ],
]) {
  test(`recovery evidence validation rejects ${label}`, (t) => {
    const fixture = makeFixture(t, { mode: 0o640 });
    const preview = previewPolicyChange({ codexHome: fixture.home });
    assert.throws(
      () => applyPolicyChange({
        codexHome: fixture.home,
        previewToken: preview.previewToken,
        testHooks: failOnce("apply.source.directory-fsync", "EIO"),
      }),
      hasCode("POLICY_APPLY_ROLLBACK_FAILED"),
    );
    const transactionDirectory = path.join(fixture.home, TRANSACTIONS_NAME);
    const receiptName = fs.readdirSync(transactionDirectory).find((name) => name.endsWith(".receipt.json"));
    const receiptFile = path.join(transactionDirectory, receiptName);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    tamper(receipt, fixture);
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

    assert.throws(
      () => restorePolicyChange({ codexHome: fixture.home, transactionId: receipt.transactionId }),
      hasCode(expectedCode),
    );
  });
}

function fixtureValue() {
  return {
    "format-note": "secret task content",
    "electron-openai-mcp-form-elicitations-enabled": false,
    "electron-persisted-atom-state": {
      "agent-mode-by-host-id": { local: "full-access", remote: "auto" },
      "heartbeat-thread-permissions-by-id": {
        "private-task-alpha": {
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
          runtimeWorkspaceRoots: ["/private/alpha-workspace"],
        },
        workspace: {
          activePermissionProfile: { id: ":workspace", extends: null },
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspaceWrite" },
        },
      },
    },
  };
}

function currentFixtureValue() {
  const value = fixtureValue();
  value["electron-persisted-atom-state"]["agent-mode-by-host-id"].local = "custom";
  const task = value["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"]["private-task-alpha"];
  task.activePermissionProfile = null;
  task.approvalPolicy = maximumAccessApprovalPolicy();
  return value;
}

function makeFixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-policy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, SOURCE_NAME);
  const value = options.value || fixtureValue();
  let originalBytes;
  if (options.raw) {
    originalBytes = Buffer.from(options.raw);
  } else if (options.rawPrefix) {
    const tail = JSON.stringify(value, null, 4).replace(/^\{\n/, "");
    originalBytes = Buffer.from(`${options.rawPrefix}${tail}\n`);
  } else {
    originalBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  }
  fs.writeFileSync(file, originalBytes, { mode: options.mode ?? 0o600 });
  fs.chmodSync(file, options.mode ?? 0o600);
  return { home, file, originalBytes };
}

function previewAndApply(home) {
  const preview = previewPolicyChange({ codexHome: home });
  return applyPolicyChange({ codexHome: home, previewToken: preview.previewToken });
}

function depsWithFs(fsImplementation) {
  return {
    fs: fsImplementation,
    path,
    crypto,
    homedir: os.homedir,
    env: process.env,
    pid: process.pid,
    now: () => new Date().toISOString(),
    randomUUID: () => crypto.randomUUID(),
  };
}

function fsWithReceiptFsyncFailures(failureNumbers) {
  const fdPaths = new Map();
  const failedWrites = [];
  let receiptWrite = 0;

  return {
    failedWrites,
    fs: {
      ...fs,
      openSync(file, ...args) {
        const fd = fs.openSync(file, ...args);
        fdPaths.set(fd, String(file));
        return fd;
      },
      closeSync(fd) {
        fdPaths.delete(fd);
        return fs.closeSync(fd);
      },
      fsyncSync(fd) {
        const file = fdPaths.get(fd) || "";
        if (file.includes(".receipt.json")) {
          receiptWrite += 1;
          if (failureNumbers.has(receiptWrite)) {
            failedWrites.push(receiptWrite);
            const error = new Error("injected receipt fsync failure");
            error.code = "EIO";
            throw error;
          }
        }
        return fs.fsyncSync(fd);
      },
    },
  };
}

function writeDescriptor(descriptor, bytes) {
  fs.ftruncateSync(descriptor, 0);
  fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
  fs.fsyncSync(descriptor);
}

function assertAllEvidenceReferenced(transactionDirectory, receipt) {
  const present = fs.readdirSync(transactionDirectory)
    .filter((name) => name.endsWith(".evidence"))
    .map((name) => path.join(transactionDirectory, name))
    .sort();
  const referenced = [
    ...receipt.sourceEvidence.map((evidence) => evidence.file),
    ...(receipt.recovery?.evidence?.file ? [receipt.recovery.evidence.file] : []),
  ].sort();
  assert.deepEqual(present, referenced, "every retained evidence name must be disclosed by the recovery receipt");
}

function snapshotTree(root) {
  const entries = [];
  walk(root, "");
  return entries;

  function walk(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const childRelative = path.join(relative, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        entries.push({ path: childRelative, type: "directory", mode: stat.mode & 0o777 });
        walk(full, childRelative);
      } else {
        entries.push({ path: childRelative, type: "file", mode: stat.mode & 0o777, sha256: hash(fs.readFileSync(full)) });
      }
    }
  }
}

function temporaryArtifacts(root) {
  return snapshotTree(root)
    .filter((entry) => /\.(?:tmp|cas|recovery)$/.test(entry.path))
    .map((entry) => entry.path);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hasCode(code) {
  return (error) => error instanceof PolicyTransactionError && error.code === code;
}

function failOnce(expectedStage, code) {
  let failed = false;
  return {
    onStage(stage) {
      if (failed || stage !== expectedStage) return;
      failed = true;
      const error = new Error(`injected ${expectedStage}`);
      error.code = code;
      throw error;
    },
  };
}
