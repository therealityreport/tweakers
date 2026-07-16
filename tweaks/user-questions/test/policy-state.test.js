"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { migrateGlobalState, questionOnlyApprovalPolicy, repairGlobalStateFile } = require("../policy-state");

test("migration uses Custom mode with danger-full-access without changing desktop-only form preferences", () => {
  const result = migrateGlobalState({
    "electron-openai-mcp-form-elicitations-enabled": false,
    "electron-persisted-atom-state": {
      "agent-mode-by-host-id": { local: "full-access", remote: "auto" },
      "heartbeat-thread-permissions-by-id": {
        full: {
          activePermissionProfile: { id: ":danger-full-access", extends: null },
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          runtimeWorkspaceRoots: ["/workspace"],
        },
      },
    },
  });

  assert.equal(result.changed, true);
  assert.equal(result.repairedThreads, 1);
  assert.equal(result.state["electron-openai-mcp-form-elicitations-enabled"], false);
  assert.deepEqual(result.state["electron-persisted-atom-state"]["agent-mode-by-host-id"], { local: "custom", remote: "auto" });
  assert.deepEqual(result.state["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"].full, {
    activePermissionProfile: null,
    approvalPolicy: questionOnlyApprovalPolicy(),
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
    runtimeWorkspaceRoots: ["/workspace"],
  });
});

test("migration leaves non-Full-Access and existing custom task policies unchanged", () => {
  const customPolicy = questionOnlyApprovalPolicy();
  const current = {
    "electron-openai-mcp-form-elicitations-enabled": true,
    "electron-persisted-atom-state": {
      "agent-mode-by-host-id": { local: "custom" },
      "heartbeat-thread-permissions-by-id": {
        workspace: { activePermissionProfile: { id: ":workspace", extends: null }, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } },
        custom: { activePermissionProfile: null, approvalPolicy: customPolicy, sandboxPolicy: { type: "dangerFullAccess" } },
      },
    },
  };
  const result = migrateGlobalState(current);
  assert.equal(result.changed, false);
  assert.equal(result.state, current);
  assert.equal(result.repairedThreads, 0);
});

test("file repair is backed up, atomic, permission-preserving, and idempotent", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-policy-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const file = path.join(codexHome, ".codex-global-state.json");
  const original = JSON.stringify({ "electron-persisted-atom-state": { "agent-mode-by-host-id": { local: "full-access" } } }, null, 2) + "\n";
  fs.writeFileSync(file, original, { mode: 0o600 });

  const first = repairGlobalStateFile({ codexHome });
  assert.equal(first.changed, true);
  assert.equal(fs.readFileSync(first.backup, "utf8"), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8"))["electron-persisted-atom-state"]["agent-mode-by-host-id"].local, "custom");
  const second = repairGlobalStateFile({ codexHome });
  assert.deepEqual(second, { changed: false, reason: "current", file, repairedThreads: 0 });
});

test("invalid or missing global state is never overwritten", (t) => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "user-questions-policy-invalid-"));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const file = path.join(codexHome, ".codex-global-state.json");
  assert.equal(repairGlobalStateFile({ codexHome }).reason, "missing");
  fs.writeFileSync(file, "not-json\n", { mode: 0o600 });
  assert.equal(repairGlobalStateFile({ codexHome }).reason, "invalid");
  assert.equal(fs.readFileSync(file, "utf8"), "not-json\n");
});
