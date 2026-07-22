import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPromotionPolicyState,
  canonicalPromotionPolicyText,
} from "../src/promotion-policy";

function policyState(): Record<string, unknown> {
  return {
    "ordinary-ui-state": { lastRoute: "/settings", dismissed: true },
    "electron-openai-mcp-form-elicitations-enabled": false,
    "electron-persisted-atom-state": {
      "unrelated-atom": { sessionCounter: 1 },
      "agent-mode-by-host-id": { remote: "auto", local: "custom" },
      "heartbeat-thread-permissions-by-id": {
        threadB: {
          sandboxPolicy: { type: "workspaceWrite" },
          approvalPolicy: "on-request",
        },
        threadA: {
          runtimeWorkspaceRoots: ["/private/workspace"],
          sandboxPolicy: { networkAccess: true, type: "dangerFullAccess" },
          approvalsReviewer: "user",
          approvalPolicy: { granular: { mcp_elicitations: true, sandbox_approval: false } },
          activePermissionProfile: null,
        },
      },
    },
  };
}

test("promotion policy canonicalization is stable across JSON object key order", () => {
  const state = policyState();
  const reordered = reverseObjectOrder(state);
  const first = canonicalPromotionPolicyText(JSON.stringify(state));
  const second = canonicalPromotionPolicyState(reordered);
  assert.equal(first, second);
});

function reverseObjectOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse()
    .map(([key, entry]) => [key, reverseObjectOrder(entry)]));
}

test("ordinary UI and session mutations are ignored", () => {
  const state = policyState();
  const changed = structuredClone(state);
  changed["ordinary-ui-state"] = { lastRoute: "/new-route", dismissed: false };
  const atoms = changed["electron-persisted-atom-state"] as Record<string, unknown>;
  atoms["unrelated-atom"] = { sessionCounter: 99, volatileWindow: "new" };
  (atoms["agent-mode-by-host-id"] as Record<string, unknown>).remote = "manual";
  const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
  (threads.threadA as Record<string, unknown>).updatedAt = "2026-07-22T00:00:00.000Z";
  (threads.threadA as Record<string, unknown>).displayLabel = "different";
  assert.equal(canonicalPromotionPolicyState(state), canonicalPromotionPolicyState(changed));
});

test("every selected local mode and per-thread policy slot mutation changes the projection", () => {
  const original = policyState();
  const baseline = canonicalPromotionPolicyState(original);
  const cases = [
    (state: Record<string, unknown>) => { state["electron-openai-mcp-form-elicitations-enabled"] = true; },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      (atoms["agent-mode-by-host-id"] as Record<string, unknown>).local = "full-access";
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      (threads.threadA as Record<string, unknown>).activePermissionProfile = { id: ":danger-full-access" };
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      (threads.threadA as Record<string, unknown>).approvalPolicy = "never";
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      (threads.threadA as Record<string, unknown>).sandboxPolicy = { type: "readOnly" };
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      (threads.threadA as Record<string, unknown>).approvalsReviewer = "system";
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      (threads.threadA as Record<string, unknown>).runtimeWorkspaceRoots = ["/different"];
    },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
      threads.threadC = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
    },
  ];
  for (const mutate of cases) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(canonicalPromotionPolicyState(changed), baseline);
  }
});

test("missing and explicit null policy slots have different projections", () => {
  const missing = policyState();
  const atoms = missing["electron-persisted-atom-state"] as Record<string, unknown>;
  const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
  delete (threads.threadA as Record<string, unknown>).activePermissionProfile;
  const explicitNull = structuredClone(missing);
  const nullAtoms = explicitNull["electron-persisted-atom-state"] as Record<string, unknown>;
  const nullThreads = nullAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
  (nullThreads.threadA as Record<string, unknown>).activePermissionProfile = null;
  assert.notEqual(canonicalPromotionPolicyState(missing), canonicalPromotionPolicyState(explicitNull));
});

test("policy container presence and every thread ID remain fingerprinted", () => {
  assert.notEqual(canonicalPromotionPolicyState({}), canonicalPromotionPolicyState({
    "electron-persisted-atom-state": {},
  }));
  assert.notEqual(canonicalPromotionPolicyState({
    "electron-persisted-atom-state": {},
  }), canonicalPromotionPolicyState({
    "electron-persisted-atom-state": { "agent-mode-by-host-id": {} },
  }));

  const baseline = policyState();
  const removed = structuredClone(baseline);
  const removedAtoms = removed["electron-persisted-atom-state"] as Record<string, unknown>;
  delete (removedAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>).threadA;
  assert.notEqual(canonicalPromotionPolicyState(removed), canonicalPromotionPolicyState(baseline));

  const added = structuredClone(baseline);
  const addedAtoms = added["electron-persisted-atom-state"] as Record<string, unknown>;
  const addedThreads = addedAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
  addedThreads["not-a-standard-thread-id !"] = {};
  assert.notEqual(canonicalPromotionPolicyState(added), canonicalPromotionPolicyState(baseline));
});

test("selected policy slot type drift fails closed", () => {
  const cases = [
    (state: Record<string, unknown>) => { state["electron-openai-mcp-form-elicitations-enabled"] = "yes"; },
    (state: Record<string, unknown>) => {
      const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
      (atoms["agent-mode-by-host-id"] as Record<string, unknown>).local = false;
    },
    (state: Record<string, unknown>) => mutateThread(state, "activePermissionProfile", "full-access"),
    (state: Record<string, unknown>) => mutateThread(state, "approvalPolicy", []),
    (state: Record<string, unknown>) => mutateThread(state, "sandboxPolicy", "dangerFullAccess"),
    (state: Record<string, unknown>) => mutateThread(state, "approvalsReviewer", {}),
    (state: Record<string, unknown>) => mutateThread(state, "runtimeWorkspaceRoots", ["/valid", 42]),
  ];
  for (const mutate of cases) {
    const changed = policyState();
    mutate(changed);
    assert.throws(() => canonicalPromotionPolicyState(changed), /invalid value type/);
  }
});

test("duplicate JSON keys fail closed before last-write-wins parsing", () => {
  assert.throws(() => canonicalPromotionPolicyText(
    '{"electron-openai-mcp-form-elicitations-enabled":false,"electron-openai-mcp-form-elicitations-enabled":true}',
  ), /duplicate JSON key/);
  assert.throws(() => canonicalPromotionPolicyText(
    '{"electron-persisted-atom-state":{"agent-mode-by-host-id":{"local":"custom","local":"full-access"}}}',
  ), /duplicate JSON key/);
});

test("malformed policy shapes and non-JSON input fail closed", () => {
  assert.throws(() => canonicalPromotionPolicyText(""), /non-empty and bounded/);
  assert.throws(() => canonicalPromotionPolicyText("{"), /valid JSON/);
  assert.throws(() => canonicalPromotionPolicyState([]), /root must be an object/);
  assert.throws(() => canonicalPromotionPolicyState({
    "electron-persisted-atom-state": [],
  }), /persisted atom state must be an object/);
  assert.throws(() => canonicalPromotionPolicyState({
    "electron-persisted-atom-state": { "agent-mode-by-host-id": "custom" },
  }), /agent-mode state must be an object/);
  assert.throws(() => canonicalPromotionPolicyState({
    "electron-persisted-atom-state": { "heartbeat-thread-permissions-by-id": [] },
  }), /thread-permission state must be an object/);
  assert.throws(() => canonicalPromotionPolicyState({
    "electron-persisted-atom-state": { "heartbeat-thread-permissions-by-id": { bad: [] } },
  }), /thread-permission record must be an object/);
});

function mutateThread(state: Record<string, unknown>, key: string, value: unknown): void {
  const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
  const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
  (threads.threadA as Record<string, unknown>)[key] = value;
}
