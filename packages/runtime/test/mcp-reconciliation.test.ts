import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createMcpReconciler,
  fingerprint,
  type McpReconciler,
  readMcpSyncState,
  reconcileMcpConfig,
} from "../src/mcp-reconciliation";
import { sanitizePreservedApprovalPolicy } from "../src/mcp-sync";

const MALFORMED_TOML_FIXTURE = Buffer.from([
  ...Buffer.from('[mcp_servers.manual]\ncommand = "manual"\n\n[unrelated]\nvalue = "unterminated\n'),
]);

const QUESTION_ONLY_APPROVAL_POLICY = "approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }";

test("sanitizePreservedApprovalPolicy accepts one assignment and rejects injected statements", () => {
  assert.deepEqual(sanitizePreservedApprovalPolicy({
    present: true,
    rawAssignment: '"approval_policy" = "never" # exact original',
  }), {
    present: true,
    rawAssignment: '"approval_policy" = "never" # exact original',
  });
  assert.equal(sanitizePreservedApprovalPolicy({
    present: true,
    rawAssignment: 'approval_policy = "never"\nsandbox_mode = "read-only"',
  }), null);
});

test("reconcileMcpConfig atomically preserves config mode and writes a private receipt", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# user config\n", { mode: 0o640 });
    chmodSync(configPath, 0o640);

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: [{
        dir: root,
        manifest: {
          id: "co.tweakers.example",
          mcp: { command: "node" },
        },
      }],
    });

    assert.equal(receipt.status, "updated");
    assert.equal(receipt.restartRequired, true);
    assert.match(readFileSync(configPath, "utf8"), /\[mcp_servers\.co-tweakers-example\]/);
    assert.equal(statSync(configPath).mode & 0o777, 0o640);
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
    assert.deepEqual(readMcpSyncState(statePath), receipt);
  });
});

test("reconcileMcpConfig manages and restores the User Questions approval policy", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const userQuestions = [{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }];
    writeFileSync(configPath, [
      "# personal settings",
      'approval_policy = "never" # preserve this exact original',
      'sandbox_mode = "danger-full-access"',
      "",
      "[features]",
      "hooks = true",
      "",
    ].join("\n"));

    const enabled = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });

    const enabledToml = readFileSync(configPath, "utf8");
    assert.equal(enabled.schemaVersion, 2);
    assert.equal(enabled.approvalPolicy.status, "managed");
    assert.equal(enabled.approvalPolicy.preservedOriginalRaw, 'approval_policy = "never" # preserve this exact original');
    assert.match(enabledToml, new RegExp(QUESTION_ONLY_APPROVAL_POLICY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(enabledToml, /sandbox_mode = "danger-full-access"/);
    assert.match(enabledToml, /\[features\]\nhooks = true/);

    const idempotent = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(idempotent.status, "unchanged");
    assert.equal(idempotent.approvalPolicy.status, "unchanged");
    assert.equal(idempotent.approvalPolicy.preservedOriginalRaw, 'approval_policy = "never" # preserve this exact original');

    const disabled = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "enabled-state",
      tweaks: [],
      ownedTweaks: userQuestions,
    });
    const disabledToml = readFileSync(configPath, "utf8");
    assert.equal(disabled.approvalPolicy.status, "restored");
    assert.match(disabledToml, /^approval_policy = "never" # preserve this exact original$/m);
    assert.doesNotMatch(disabledToml, /mcp_elicitations/);
    assert.match(disabledToml, /sandbox_mode = "danger-full-access"/);
    assert.equal(disabled.preservedApprovalPolicy, null);
  });
});

test("reconcileMcpConfig removes a managed approval policy that was originally absent", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, 'sandbox_mode = "danger-full-access"\n\n[features]\nhooks = true\n');

    const enabled = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.deepEqual(enabled.preservedApprovalPolicy, { present: false, rawAssignment: null });
    assert.match(readFileSync(configPath, "utf8"), /mcp_elicitations = true/);

    reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "enabled-state",
      tweaks: [],
      ownedTweaks: userQuestions,
    });
    const restored = readFileSync(configPath, "utf8");
    assert.doesNotMatch(restored, /approval_policy/);
    assert.match(restored, /sandbox_mode = "danger-full-access"/);
  });
});

test("reconcileMcpConfig installs and repairs Full Access while User Questions is enabled", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n');

    const enabled = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(enabled.approvalPolicy.sandboxModeBeforeRaw, 'sandbox_mode = "workspace-write"');
    assert.equal(enabled.approvalPolicy.sandboxModeAfterRaw, 'sandbox_mode = "danger-full-access"');
    assert.match(readFileSync(configPath, "utf8"), /^sandbox_mode = "danger-full-access"$/m);

    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/^sandbox_mode.*$/m, 'sandbox_mode = "read-only"'));
    const repaired = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(repaired.approvalPolicy.status, "managed");
    assert.match(readFileSync(configPath, "utf8"), /^sandbox_mode = "danger-full-access"$/m);
  });
});

test("reconcileMcpConfig fails closed on duplicate top-level sandbox modes", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n"sandbox_mode" = "read-only"\n';
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, original);

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(receipt.status, "conflict");
    assert.equal(receipt.approvalPolicy.error, "Duplicate top-level sandbox_mode assignments");
    assert.equal(readFileSync(configPath, "utf8"), original);
  });
});

test("reconcileMcpConfig fails closed on duplicate top-level approval policies", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = 'approval_policy = "never"\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n';
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, original);

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });

    assert.equal(receipt.status, "conflict");
    assert.equal(receipt.approvalPolicy.status, "conflict");
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /BEGIN TWEAKER/);
  });
});

test("reconcileMcpConfig recognizes quoted approval_policy keys when detecting duplicates", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = '"approval_policy" = "never"\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n';
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, original);

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });

    assert.equal(receipt.status, "conflict");
    assert.equal(receipt.approvalPolicy.status, "conflict");
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /BEGIN TWEAKER/);
  });
});

test("createMcpReconciler repairs approval policy drift back to question-only", async () => {
  await withTempDirAsync(async (root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
    let notifyConfigChange: ((changedPath?: string) => void) | undefined;
    const reconciler = createMcpReconciler({
      configPath,
      statePath,
      debounceMs: 5,
      getTweaks: () => userQuestions,
      getOwnedTweaks: () => userQuestions,
    }, {
      watchConfig(_path, onChange) {
        notifyConfigChange = onChange;
        return { close() {} };
      },
    });

    try {
      await reconciler.reconcileNow("startup");
      const managed = readFileSync(configPath, "utf8");
      writeFileSync(configPath, managed.replace(QUESTION_ONLY_APPROVAL_POLICY, 'approval_policy = "never"'));
      notifyConfigChange?.(configPath);
      await delay(30);
      assert.match(readFileSync(configPath, "utf8"), /mcp_elicitations = true/);
      assert.equal(reconciler.readState()?.approvalPolicy.status, "managed");
    } finally {
      await reconciler.close();
    }
  });
});

test("reconcileMcpConfig preserves owned policy across ChatGPT off and Tweakers on", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const ownedTweaks = [{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }];
    writeFileSync(configPath, [
      '[mcp_servers.external]\ncommand = "external"',
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n\n"));

    const suspended = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "manual-repair",
      tweaks: [],
      ownedTweaks,
    });

    assert.equal(suspended.status, "updated");
    assert.doesNotMatch(readFileSync(configPath, "utf8"), /user-questions/);
    assert.match(readFileSync(configPath, "utf8"), /mcp_servers\.external/);
    assert.deepEqual(suspended.preservedOptions, {
      "co-tweakers-user-questions": { defaultToolsApprovalMode: "approve" },
    });

    const restored = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "manual-repair",
      tweaks: ownedTweaks,
      ownedTweaks,
    });

    const restoredToml = readFileSync(configPath, "utf8");
    assert.equal(restored.status, "updated");
    assert.match(restoredToml, /mcp_servers\.co-tweakers-user-questions/);
    assert.match(restoredToml, /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(restoredToml, /co-thomashulihan/);
  });
});

test("reconcileMcpConfig applies no partial mutation when any owned MCP conflicts", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const firstServer = join(root, "first.js");
    writeFileSync(firstServer, "");
    const original = [
      "# byte-identical on conflict",
      "[mcp_servers.co-thomashulihan-first]",
      'command = "node"',
      `args = [${JSON.stringify(firstServer)}]`,
      "",
      "[mcp_servers.co-thomashulihan-second]",
      'command = "user-owned-command"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const ownedTweaks = [{
      dir: root,
      manifest: { id: "co.tweakers.first", mcp: { command: "node", args: ["first.js"] } },
    }, {
      dir: root,
      manifest: { id: "co.tweakers.second", mcp: { command: "node" } },
    }];

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "manual-repair",
      tweaks: ownedTweaks,
      ownedTweaks,
    });

    assert.equal(receipt.status, "conflict");
    assert.equal(receipt.restartRequired, false);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.equal(receipt.beforeFingerprint, receipt.afterFingerprint);
    assert.equal(receipt.conflicts[0]?.canonicalName, "co-tweakers-second");
  });
});

test("reconcileMcpConfig does not persist a tentative policy capture when an MCP conflict blocks the transition", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = [
      'approval_policy = "never"',
      'sandbox_mode = "danger-full-access"',
      "",
      "[mcp_servers.co-thomashulihan-second]",
      'command = "user-owned-command"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const ownedTweaks = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }, {
      dir: root,
      manifest: { id: "co.tweakers.second", mcp: { command: "node" } },
    }];

    const conflicted = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: ownedTweaks,
      ownedTweaks,
    });

    assert.equal(conflicted.status, "conflict");
    assert.equal(conflicted.preservedApprovalPolicy, null);
    assert.equal(readFileSync(configPath, "utf8"), original);

    writeFileSync(configPath, 'approval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n');
    const enabled = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: ownedTweaks,
      ownedTweaks,
    });
    assert.equal(enabled.status, "updated");
    assert.equal(enabled.preservedApprovalPolicy?.rawAssignment, 'approval_policy = "on-request"');

    reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "enabled-state",
      tweaks: [],
      ownedTweaks,
    });
    assert.match(readFileSync(configPath, "utf8"), /^approval_policy = "on-request"$/m);
  });
});

test("reconcileMcpConfig durably preserves the original policy before a committed config can outlive final receipt failure", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n');

    assert.throws(() => reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    }, {
      afterCommit() {
        throw new Error("simulated failure after verified config commit");
      },
    }), /simulated failure/);

    assert.match(readFileSync(configPath, "utf8"), /mcp_elicitations = true/);
    const failedReceipt = readMcpSyncState(statePath);
    assert.equal(failedReceipt?.status, "error");
    assert.equal(failedReceipt?.preservedApprovalPolicy?.rawAssignment, 'approval_policy = "never"');

    reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "enabled-state",
      tweaks: [],
      ownedTweaks: userQuestions,
    });
    assert.match(readFileSync(configPath, "utf8"), /^approval_policy = "never"$/m);
  });
});

test("reconcileMcpConfig trusts a prepared policy capture only when the planned config fingerprint is live", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n';
    const userQuestions = [{
      dir: root,
      manifest: { id: "co.tweakers.user-questions", mcp: { command: "node" } },
    }];
    writeFileSync(configPath, original);
    const completed = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    const plannedToml = readFileSync(configPath, "utf8");
    const prepared = {
      ...completed,
      phase: "prepared" as const,
      status: "unchanged" as const,
      beforeFingerprint: fingerprint(original),
      afterFingerprint: fingerprint(original),
      plannedAfterFingerprint: fingerprint(plannedToml),
      restartRequired: false,
    };

    writeFileSync(statePath, `${JSON.stringify(prepared, null, 2)}\n`);
    const provedCommit = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(provedCommit.preservedApprovalPolicy?.rawAssignment, 'approval_policy = "never"');

    writeFileSync(statePath, `${JSON.stringify(prepared, null, 2)}\n`);
    writeFileSync(configPath, 'approval_policy = "on-request"\nsandbox_mode = "danger-full-access"\n');
    const recaptured = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: userQuestions,
      ownedTweaks: userQuestions,
    });
    assert.equal(recaptured.preservedApprovalPolicy?.rawAssignment, 'approval_policy = "on-request"');

    reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "enabled-state",
      tweaks: [],
      ownedTweaks: userQuestions,
    });
    assert.match(readFileSync(configPath, "utf8"), /^approval_policy = "on-request"$/m);
  });
});

test("off-mode reconciliation replans around a concurrent manual edit", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const serverPath = join(root, "server.js");
    writeFileSync(serverPath, "");
    const ownedTweaks = [{
      dir: root,
      manifest: { id: "co.tweakers.example", mcp: { command: "node", args: ["server.js"] } },
    }];
    writeFileSync(configPath, [
      "[mcp_servers.co-thomashulihan-example]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "",
    ].join("\n"));

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "manual-repair",
      tweaks: [],
      ownedTweaks,
    }, {
      beforeCommit(attempt) {
        if (attempt === 1) {
          writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# concurrent manual edit\n`);
        }
      },
    });

    assert.equal(receipt.status, "updated");
    assert.equal(readFileSync(configPath, "utf8"), "# concurrent manual edit\n");
  });
});

test("reconcileMcpConfig replans once around an external edit", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      beforeCommit(attempt) {
        if (attempt === 1) writeFileSync(configPath, "# external edit\n", "utf8");
      },
    });

    const updated = readFileSync(configPath, "utf8");
    assert.equal(receipt.status, "updated");
    assert.match(updated, /^# external edit/m);
    assert.match(updated, /\[mcp_servers\.co-tweakers-example\]/);
  });
});

test("reconcileMcpConfig refuses to overwrite a second concurrent edit", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");

    assert.throws(() => reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      beforeCommit(attempt) {
        writeFileSync(configPath, `# external edit ${attempt}\n`, "utf8");
      },
    }), /changed during MCP reconciliation twice/);

    assert.equal(readFileSync(configPath, "utf8"), "# external edit 2\n");
    assert.equal(readMcpSyncState(statePath)?.status, "error");
  });
});

test("reconcileMcpConfig records malformed TOML and preserves the original bytes", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, MALFORMED_TOML_FIXTURE);

    assert.throws(() => reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }), /Malformed TOML/);

    assert.deepEqual(readFileSync(configPath), MALFORMED_TOML_FIXTURE);
    const receipt = readMcpSyncState(statePath);
    assert.equal(receipt?.status, "error");
    assert.match(receipt?.error ?? "", /Malformed TOML/);
    assert.equal(receipt?.restartRequired, false);
    assert.equal(receipt?.beforeFingerprint, receipt?.afterFingerprint);
  });
});

test("reconcileMcpConfig rechecks the fingerprint at the final rename boundary", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      beforeRename(attempt) {
        if (attempt === 1) writeFileSync(configPath, "# final-boundary edit\n", "utf8");
      },
    });

    const updated = readFileSync(configPath, "utf8");
    assert.equal(receipt.status, "updated");
    assert.match(updated, /^# final-boundary edit/m);
    assert.match(updated, /\[mcp_servers\.co-tweakers-example\]/);
  });
});

test("reconcileMcpConfig preserves an edit made after pathname capture", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      afterCapture(attempt) {
        if (attempt === 1) writeFileSync(configPath, "# edit after capture\n", "utf8");
      },
    });

    const updated = readFileSync(configPath, "utf8");
    assert.equal(receipt.status, "updated");
    assert.match(updated, /^# edit after capture/m);
    assert.match(updated, /mcp_servers\.co-tweakers-example/);
  });
});

test("reconcileMcpConfig preserves an old-inode edit made after the promotion check", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");
    const editorFd = openSync(configPath, "r+");

    try {
      const receipt = reconcileMcpConfig({
        configPath,
        statePath,
        trigger: "config-change",
        tweaks: [{
          dir: root,
          manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
        }],
      }, {
        beforeBackupRelease(attempt) {
          if (attempt !== 1) return;
          ftruncateSync(editorFd, 0);
          writeSync(editorFd, "# held-open external edit\n", 0, "utf8");
        },
      });

      const updated = readFileSync(configPath, "utf8");
      assert.equal(receipt.status, "updated");
      assert.match(updated, /^# held-open external edit/m);
      assert.match(updated, /mcp_servers\.co-tweakers-example/);
    } finally {
      closeSync(editorFd);
    }
  });
});

test("reconcileMcpConfig retains and later imports an old-inode edit after the final check", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");
    const editorFd = openSync(configPath, "r+");

    try {
      reconcileMcpConfig({
        configPath,
        statePath,
        trigger: "config-change",
        tweaks: [{
          dir: root,
          manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
        }],
      }, {
        afterFinalCheck(attempt) {
          if (attempt !== 1) return;
          ftruncateSync(editorFd, 0);
          writeSync(editorFd, "# post-final-check external edit\n", 0, "utf8");
        },
      });

      const retiredPath = readdirSync(root)
        .find((name) => name.startsWith(".config.toml.tweakers-cas-retired."));
      assert.ok(retiredPath);
      assert.equal(
        readFileSync(join(root, retiredPath), "utf8"),
        "# post-final-check external edit\n",
      );

      const receipt = reconcileMcpConfig({
        configPath,
        statePath,
        trigger: "config-change",
        tweaks: [{
          dir: root,
          manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
        }],
      });

      const updated = readFileSync(configPath, "utf8");
      assert.equal(receipt.status, "updated");
      assert.match(updated, /^# post-final-check external edit/m);
      assert.match(updated, /mcp_servers\.co-tweakers-example/);
    } finally {
      closeSync(editorFd);
    }
  });
});

test("reconcileMcpConfig merges a retained-inode edit with a newer current edit", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const tweakDir = join(root, "tweaks", "example");
    mkdirSync(tweakDir, { recursive: true });
    writeFileSync(join(tweakDir, "server.js"), "");
    writeFileSync(configPath, "# baseline manual config\n", "utf8");
    const editorFd = openSync(configPath, "r+");
    const tweaks = [{
      dir: tweakDir,
      manifest: {
        id: "co.tweakers.example",
        mcp: { command: "node", args: ["server.js"] },
      },
    }];

    try {
      reconcileMcpConfig({ configPath, statePath, trigger: "startup", tweaks });
      writeFileSync(
        configPath,
        `${readFileSync(configPath, "utf8")}# newer current edit\n`,
        "utf8",
      );
      ftruncateSync(editorFd, 0);
      writeSync(editorFd, "# retained editor replacement\n", 0, "utf8");

      const receipt = reconcileMcpConfig({
        configPath,
        statePath,
        trigger: "config-change",
        tweaks,
      });

      const updated = readFileSync(configPath, "utf8");
      assert.equal(receipt.status, "updated");
      assert.match(updated, /^# retained editor replacement/m);
      assert.match(updated, /^# newer current edit/m);
      assert.match(updated, /mcp_servers\.co-tweakers-example/);
      assert.match(updated, new RegExp(JSON.stringify(join(tweakDir, "server.js")).slice(1, -1)));
    } finally {
      closeSync(editorFd);
    }
  });
});

test("reconcileMcpConfig recovers an interrupted captured pathname before replanning", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const backupPath = join(root, ".config.toml.tweakers-cas-backup");
    writeFileSync(configPath, "# captured before crash\n", "utf8");
    renameSync(configPath, backupPath);

    reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    });

    assert.equal(existsSync(backupPath), false);
    assert.match(readFileSync(configPath, "utf8"), /^# captured before crash/m);
  });
});

test("reconcileMcpConfig serializes same-process mutations for one config path", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const nestedStatePath = join(root, "nested-mcp-sync-state.json");
    let nestedMutationBlocked = false;
    writeFileSync(configPath, "# original\n", "utf8");

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      beforeRename() {
        assert.throws(() => reconcileMcpConfig({
          configPath,
          statePath: nestedStatePath,
          trigger: "manual-repair",
          tweaks: [],
        }), /already in progress/);
        nestedMutationBlocked = true;
      },
    });

    assert.equal(receipt.status, "updated");
    assert.equal(nestedMutationBlocked, true);
    assert.match(readFileSync(configPath, "utf8"), /mcp_servers\.co-tweakers-example/);
  });
});

test("reconcileMcpConfig cleans its temp file after a crash before rename", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const original = Buffer.from("# original bytes\n", "utf8");
    writeFileSync(configPath, original);

    assert.throws(() => reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "startup",
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }, {
      beforeRename() {
        throw new Error("simulated crash before rename");
      },
    }), /simulated crash before rename/);

    assert.deepEqual(readFileSync(configPath), original);
    assert.equal(
      readdirSync(root).some((name) => name.startsWith(".config.toml.") && name.endsWith(".tmp")),
      false,
    );
    assert.equal(readMcpSyncState(statePath)?.status, "error");
  });
});

test("createMcpReconciler debounces triggers and suppresses its own config event", async () => {
  await withTempDirAsync(async (root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");
    const receipts: string[] = [];
    let notifyConfigChange: (() => void) | undefined;
    const reconciler = createMcpReconciler({
      configPath,
      statePath,
      debounceMs: 10,
      getTweaks: () => [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
      onReceipt: (receipt) => receipts.push(receipt.transactionId),
    }, {
      watchConfig(_path, onChange) {
        notifyConfigChange = onChange;
        return { close() {} };
      },
    });

    try {
      const [first, second] = await Promise.all([
        reconciler.request("startup"),
        reconciler.request("tweak-reload"),
      ]);
      assert.equal(first.transactionId, second.transactionId);
      assert.equal(receipts.length, 1);

      notifyConfigChange?.();
      await delay(30);
      assert.equal(receipts.length, 1);

      writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# external\n`, "utf8");
      notifyConfigChange?.();
      await delay(30);
      assert.equal(receipts.length, 2);
    } finally {
      await reconciler.close();
    }
  });
});

test("two live-root chokidar reconcilers converge and still observe external edits", async () => {
  await withTempDirAsync(async (root) => {
    const configPath = join(root, "config.toml");
    const firstTweakDir = join(root, "live-a", "tweaks", "example");
    const secondTweakDir = join(root, "live-b", "tweaks", "example");
    mkdirSync(firstTweakDir, { recursive: true });
    mkdirSync(secondTweakDir, { recursive: true });
    writeFileSync(join(firstTweakDir, "server.js"), "");
    writeFileSync(join(secondTweakDir, "server.js"), "");
    const manifest = JSON.stringify({
      id: "co.tweakers.example",
      mcp: { command: "node", args: ["server.js"] },
    });
    writeFileSync(join(firstTweakDir, "manifest.json"), manifest);
    writeFileSync(join(secondTweakDir, "manifest.json"), manifest);
    writeFileSync(configPath, "# shared manual config\n", "utf8");
    const receipts = [0, 0];
    const errors: unknown[] = [];
    const makeTweaks = (dir: string) => [{
      dir,
      manifest: {
        id: "co.tweakers.example",
        mcp: { command: "node", args: ["server.js"] },
      },
    }];
    const first = createMcpReconciler({
      configPath,
      statePath: join(root, "live-a-state.json"),
      debounceMs: 20,
      getTweaks: () => makeTweaks(firstTweakDir),
      onReceipt: () => { receipts[0] += 1; },
      onError: (error) => errors.push(error),
    });
    const second = createMcpReconciler({
      configPath,
      statePath: join(root, "live-b-state.json"),
      debounceMs: 20,
      getTweaks: () => makeTweaks(secondTweakDir),
      onReceipt: () => { receipts[1] += 1; },
      onError: (error) => errors.push(error),
    });

    try {
      await delay(100);
      await first.reconcileNow("startup");
      await second.reconcileNow("startup");
      await delay(250);
      const converged = readFileSync(configPath, "utf8");
      const quietCounts = [...receipts];
      await delay(250);
      assert.equal(readFileSync(configPath, "utf8"), converged);
      assert.deepEqual(receipts, quietCounts);
      assert.equal(errors.length, 0);
      assert.match(converged, /mcp_servers\.co-tweakers-example/);
      assert.equal(
        converged.includes(firstTweakDir) || converged.includes(secondTweakDir),
        true,
      );

      writeFileSync(configPath, `${converged}# legitimate external edit\n`, "utf8");
      await delay(300);
      const externallyEdited = readFileSync(configPath, "utf8");
      assert.match(externallyEdited, /^# legitimate external edit/m);
      assert.equal(errors.length, 0);
      const postEditCounts = [...receipts];
      await delay(250);
      assert.equal(readFileSync(configPath, "utf8"), externallyEdited);
      assert.deepEqual(receipts, postEditCounts);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });
});

test("reconcileMcpConfig rejects an alternate path without the same canonical tweak manifest", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    const expectedTweakDir = join(root, "managed", "tweaks", "example");
    const untrustedTweakDir = join(root, "untrusted", "tweaks", "example");
    mkdirSync(expectedTweakDir, { recursive: true });
    mkdirSync(untrustedTweakDir, { recursive: true });
    writeFileSync(join(expectedTweakDir, "server.js"), "");
    writeFileSync(join(untrustedTweakDir, "server.js"), "");
    writeFileSync(join(expectedTweakDir, "manifest.json"), JSON.stringify({
      id: "co.tweakers.example",
      mcp: { command: "node", args: ["server.js"] },
    }));
    writeFileSync(join(untrustedTweakDir, "manifest.json"), JSON.stringify({
      id: "co.tweakers.impostor",
      mcp: { command: "node", args: ["server.js"] },
    }));
    writeFileSync(configPath, [
      "# BEGIN TWEAKER MANAGED MCP SERVERS",
      "[mcp_servers.co-tweakers-example]",
      'command = "node"',
      `args = [${JSON.stringify(join(untrustedTweakDir, "server.js"))}]`,
      "# END TWEAKER MANAGED MCP SERVERS",
      "",
    ].join("\n"));

    const receipt = reconcileMcpConfig({
      configPath,
      statePath,
      trigger: "config-change",
      tweaks: [{
        dir: expectedTweakDir,
        manifest: {
          id: "co.tweakers.example",
          mcp: { command: "node", args: ["server.js"] },
        },
      }],
    });

    const updated = readFileSync(configPath, "utf8");
    assert.equal(receipt.status, "updated");
    assert.match(updated, new RegExp(expectedTweakDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(updated, new RegExp(untrustedTweakDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("reconcileMcpConfig rejects a stale manifest version or changed MCP script", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const expectedTweakDir = join(root, "current", "tweaks", "example");
    const staleTweakDir = join(root, "stale", "tweaks", "example");
    mkdirSync(expectedTweakDir, { recursive: true });
    mkdirSync(staleTweakDir, { recursive: true });
    const currentManifest = JSON.stringify({
      id: "co.tweakers.example",
      version: "2.0.0",
      mcp: { command: "node", args: ["server.js"] },
    });
    const staleManifest = JSON.stringify({
      id: "co.tweakers.example",
      version: "1.0.0",
      mcp: { command: "node", args: ["server.js"] },
    });
    writeFileSync(join(expectedTweakDir, "manifest.json"), currentManifest);
    writeFileSync(join(staleTweakDir, "manifest.json"), staleManifest);
    writeFileSync(join(expectedTweakDir, "server.js"), "same-script\n");
    writeFileSync(join(staleTweakDir, "server.js"), "same-script\n");
    const writeStaleBlock = () => writeFileSync(configPath, [
      "# BEGIN TWEAKER MANAGED MCP SERVERS",
      "[mcp_servers.co-tweakers-example]",
      'command = "node"',
      `args = [${JSON.stringify(join(staleTweakDir, "server.js"))}]`,
      "# END TWEAKER MANAGED MCP SERVERS",
      "",
    ].join("\n"));
    const tweaks = [{
      dir: expectedTweakDir,
      manifest: {
        id: "co.tweakers.example",
        mcp: { command: "node", args: ["server.js"] },
      },
    }];

    writeStaleBlock();
    const staleVersion = reconcileMcpConfig({
      configPath,
      statePath: join(root, "stale-version-state.json"),
      trigger: "config-change",
      tweaks,
    });
    assert.equal(staleVersion.status, "updated");
    assert.match(readFileSync(configPath, "utf8"), new RegExp(expectedTweakDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    writeFileSync(join(staleTweakDir, "manifest.json"), currentManifest);
    writeFileSync(join(staleTweakDir, "server.js"), "changed-script\n");
    writeStaleBlock();
    const changedScript = reconcileMcpConfig({
      configPath,
      statePath: join(root, "changed-script-state.json"),
      trigger: "config-change",
      tweaks,
    });
    assert.equal(changedScript.status, "updated");
    assert.match(readFileSync(configPath, "utf8"), new RegExp(expectedTweakDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("createMcpReconciler imports a changed retained inode from its watcher event", async () => {
  await withTempDirAsync(async (root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");
    const editorFd = openSync(configPath, "r+");
    let wroteRetiredInode = false;
    let receiptCount = 0;
    let notifyConfigChange: ((changedPath?: string) => void) | undefined;
    const reconciler = createMcpReconciler({
      configPath,
      statePath,
      debounceMs: 5,
      getTweaks: () => [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
      onReceipt() {
        receiptCount += 1;
      },
      reconcileDependencies: {
        afterFinalCheck() {
          if (wroteRetiredInode) return;
          wroteRetiredInode = true;
          ftruncateSync(editorFd, 0);
          writeSync(editorFd, "# watcher-imported external edit\n", 0, "utf8");
        },
      },
    }, {
      watchConfig(_path, onChange) {
        notifyConfigChange = onChange;
        return { close() {} };
      },
    });

    try {
      await reconciler.reconcileNow("startup");
      const retiredName = readdirSync(root)
        .find((name) => name.startsWith(".config.toml.tweakers-cas-retired."));
      assert.ok(retiredName);
      notifyConfigChange?.(join(root, retiredName));
      await delay(30);

      const updated = readFileSync(configPath, "utf8");
      assert.equal(receiptCount, 2);
      assert.match(updated, /^# watcher-imported external edit/m);
      assert.match(updated, /mcp_servers\.co-tweakers-example/);
    } finally {
      closeSync(editorFd);
      await reconciler.close();
    }
  });
});

test("createMcpReconciler performs one rerun for a request arriving in flight", async () => {
  await withTempDirAsync(async (root) => {
    const configPath = join(root, "config.toml");
    const statePath = join(root, "mcp-sync-state.json");
    writeFileSync(configPath, "# original\n", "utf8");
    const receipts: string[] = [];
    let reconciler: McpReconciler;
    let rerun: Promise<unknown> | undefined;
    let requested = false;
    reconciler = createMcpReconciler({
      configPath,
      statePath,
      debounceMs: 5,
      watchConfig: false,
      getTweaks: () => [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
      onReceipt: (receipt) => receipts.push(receipt.transactionId),
      reconcileDependencies: {
        beforeCommit() {
          if (!requested) {
            requested = true;
            rerun = reconciler.request("config-change");
          }
        },
      },
    });

    try {
      await reconciler.request("startup");
      await rerun;
      assert.equal(receipts.length, 2);
      assert.notEqual(receipts[0], receipts[1]);
    } finally {
      await reconciler.close();
    }
  });
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-reconciliation-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirAsync(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-reconciliation-"));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
