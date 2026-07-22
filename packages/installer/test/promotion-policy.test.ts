import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PROMOTION_POLICY_FILE_MAX_BYTES } from "@therealityreport/tweakers-sdk";
import {
  buildPromotionHealthExpectation,
} from "../src/commands/install";
import { fingerprintPromotionPolicyPath as fingerprintInstallerPolicy } from "../src/promotion-policy";
import promotionHealth from "../../runtime/src/promotion-health";
import runtimePolicy from "../../runtime/src/promotion-policy";
import { inspectUserQuestionsSource } from "../src/user-questions-source";

const { answerPromotionHealthRequest, PROMOTION_SURFACE_NAMES } = promotionHealth;
const { fingerprintPromotionPolicyPath: fingerprintRuntimePolicy } = runtimePolicy;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const userQuestionsRoot = join(repositoryRoot, "tweaks", "user-questions");

function policyState(): Record<string, unknown> {
  return {
    "ui-window-state": { route: "/settings", session: 1 },
    "electron-openai-mcp-form-elicitations-enabled": false,
    "electron-persisted-atom-state": {
      "transient-ui-atom": { selectedTab: "general" },
      "agent-mode-by-host-id": { remote: "auto", local: "custom" },
      "heartbeat-thread-permissions-by-id": {
        alpha: {
          activePermissionProfile: null,
          approvalPolicy: { granular: { mcp_elicitations: true, sandbox_approval: false } },
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
          runtimeWorkspaceRoots: ["/private/alpha"],
        },
      },
    },
  };
}

function writePolicy(path: string, state: unknown, mode = 0o600): void {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode });
  chmodSync(path, mode);
}

test("installer and runtime share stable semantic policy fingerprints", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-parity-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const state = policyState();
    writePolicy(policy, state);
    const expected = fingerprintInstallerPolicy(policy);
    assert.equal(fingerprintRuntimePolicy(policy), expected);

    const reordered = reverseObjectOrder(state);
    writePolicy(policy, reordered);
    assert.equal(fingerprintInstallerPolicy(policy), expected, "object key order is semantic-noise only");

    const nonPolicy = structuredClone(state);
    nonPolicy["ui-window-state"] = { route: "/new", session: 42 };
    nonPolicy["desktop-full-access-permission-policy"] = "unrecognized-top-level-metadata";
    const atoms = nonPolicy["electron-persisted-atom-state"] as Record<string, unknown>;
    atoms["transient-ui-atom"] = { selectedTab: "advanced", open: true };
    (atoms["agent-mode-by-host-id"] as Record<string, unknown>).remote = "manual";
    const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    (threads.alpha as Record<string, unknown>).updatedAt = "2026-07-22T00:00:00.000Z";
    writePolicy(policy, nonPolicy);
    assert.equal(fingerprintInstallerPolicy(policy), expected, "unrelated UI/session state is excluded");
    assert.equal(fingerprintRuntimePolicy(policy), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all complete selected policy records remain mutation-sensitive", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-mutations-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const original = policyState();
    writePolicy(policy, original);
    const baseline = fingerprintInstallerPolicy(policy);
    const mutations = [
      (state: Record<string, unknown>) => { state["electron-openai-mcp-form-elicitations-enabled"] = true; },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        (atoms["agent-mode-by-host-id"] as Record<string, unknown>).local = "full-access";
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        (threads.alpha as Record<string, unknown>).activePermissionProfile = { id: ":danger-full-access" };
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        (threads.alpha as Record<string, unknown>).approvalPolicy = "never";
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        (threads.alpha as Record<string, unknown>).sandboxPolicy = { type: "readOnly" };
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        (threads.alpha as Record<string, unknown>).approvalsReviewer = "system";
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        (threads.alpha as Record<string, unknown>).runtimeWorkspaceRoots = ["/different"];
      },
      (state: Record<string, unknown>) => {
        const atoms = state["electron-persisted-atom-state"] as Record<string, unknown>;
        const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
        threads.beta = { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(original);
      mutate(changed);
      writePolicy(policy, changed);
      const installer = fingerprintInstallerPolicy(policy);
      assert.notEqual(installer, baseline);
      assert.equal(fingerprintRuntimePolicy(policy), installer);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy fingerprints preserve missing versus explicit null slots", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-null-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const missing = policyState();
    const atoms = missing["electron-persisted-atom-state"] as Record<string, unknown>;
    const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    delete (threads.alpha as Record<string, unknown>).activePermissionProfile;
    writePolicy(policy, missing);
    const missingHash = fingerprintInstallerPolicy(policy);
    const explicitNull = structuredClone(missing);
    const nullAtoms = explicitNull["electron-persisted-atom-state"] as Record<string, unknown>;
    const nullThreads = nullAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    (nullThreads.alpha as Record<string, unknown>).activePermissionProfile = null;
    writePolicy(policy, explicitNull);
    const nullHash = fingerprintInstallerPolicy(policy);
    assert.notEqual(nullHash, missingHash);
    assert.equal(fingerprintRuntimePolicy(policy), nullHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installer and runtime golden vectors preserve container and arbitrary thread-ID presence", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-golden-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const vectors = [
      {},
      { "electron-persisted-atom-state": {} },
      { "electron-persisted-atom-state": { "agent-mode-by-host-id": {} } },
      {
        "electron-persisted-atom-state": {
          "agent-mode-by-host-id": { local: "custom" },
          "heartbeat-thread-permissions-by-id": { "nonmatching thread id !": {} },
        },
      },
    ];
    const hashes: string[] = [];
    for (const vector of vectors) {
      writePolicy(policy, vector);
      const installer = fingerprintInstallerPolicy(policy);
      assert.equal(fingerprintRuntimePolicy(policy), installer);
      hashes.push(installer);
    }
    assert.equal(new Set(hashes).size, hashes.length);

    const prototypeThread = policyState();
    const prototypeAtoms = prototypeThread["electron-persisted-atom-state"] as Record<string, unknown>;
    const prototypeThreads = prototypeAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    Object.defineProperty(prototypeThreads, "__proto__", {
      configurable: true,
      enumerable: true,
      value: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
      writable: true,
    });
    writePolicy(policy, prototypeThread);
    const before = fingerprintInstallerPolicy(policy);
    assert.equal(fingerprintRuntimePolicy(policy), before);
    (prototypeThreads["__proto__"] as Record<string, unknown>).approvalPolicy = "on-request";
    writePolicy(policy, prototypeThread);
    const after = fingerprintInstallerPolicy(policy);
    assert.notEqual(after, before, "__proto__ is an exact thread ID, not an object prototype operation");
    assert.equal(fingerprintRuntimePolicy(policy), after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing, malformed, oversized, permissive, and symlink policy files fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-invalid-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    assert.throws(() => fingerprintInstallerPolicy(policy));
    assert.throws(() => fingerprintRuntimePolicy(policy));

    writeFileSync(policy, "{", { mode: 0o600 });
    assert.throws(() => fingerprintInstallerPolicy(policy), /valid JSON/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /valid JSON/);

    writeFileSync(policy, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), { mode: 0o600 });
    assert.throws(() => fingerprintInstallerPolicy(policy), /valid UTF-8/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /valid UTF-8/);

    writeFileSync(
      policy,
      '{"electron-openai-mcp-form-elicitations-enabled":false,"electron-openai-mcp-form-elicitations-enabled":true}',
      { mode: 0o600 },
    );
    assert.throws(() => fingerprintInstallerPolicy(policy), /duplicate JSON key/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /duplicate JSON key/);

    writePolicy(policy, { "electron-persisted-atom-state": [] });
    assert.throws(() => fingerprintInstallerPolicy(policy), /persisted atom state must be an object/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /persisted atom state must be an object/);

    const typeDrift = policyState();
    const typeAtoms = typeDrift["electron-persisted-atom-state"] as Record<string, unknown>;
    const typeThreads = typeAtoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    (typeThreads.alpha as Record<string, unknown>).runtimeWorkspaceRoots = ["/valid", 42];
    writePolicy(policy, typeDrift);
    assert.throws(() => fingerprintInstallerPolicy(policy), /invalid value type/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /invalid value type/);

    writePolicy(policy, policyState(), 0o644);
    assert.throws(() => fingerprintInstallerPolicy(policy), /owner-only bounded regular file/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /owner-only bounded regular file/);

    writeFileSync(policy, Buffer.alloc(PROMOTION_POLICY_FILE_MAX_BYTES + 1, 0x20), { mode: 0o600 });
    chmodSync(policy, 0o600);
    assert.throws(() => fingerprintInstallerPolicy(policy), /owner-only bounded regular file/);
    assert.throws(() => fingerprintRuntimePolicy(policy), /owner-only bounded regular file/);

    const target = join(root, "target.json");
    writePolicy(target, policyState());
    rmSync(policy);
    symlinkSync(target, policy);
    assert.throws(() => fingerprintInstallerPolicy(policy));
    assert.throws(() => fingerprintRuntimePolicy(policy));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema-v2 request and receipt align installer expectation with runtime semantic observation", async () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-schema-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    writePolicy(policy, policyState());
    const policyHash = fingerprintInstallerPolicy(policy);
    const hashes = Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name, index) => [
      name,
      name === "policy" ? policyHash : String((index + 1) % 10).repeat(64),
    ])) as Record<(typeof PROMOTION_SURFACE_NAMES)[number], string>;
    const proof = inspectUserQuestionsSource(userQuestionsRoot);
    const expectation = buildPromotionHealthExpectation({
      app: { version: "candidate", build: "semantic-policy", hash: hashes.app },
      before: hashes,
      after: hashes,
      requiredPermissions: [],
      userQuestionsRoot,
    });
    assert.equal(expectation.surfaces.policy.afterHash, policyHash);

    const changed = policyState();
    changed["ui-window-state"] = { route: "/persisted-by-original-main", session: 2 };
    writePolicy(policy, changed);
    const runtimePolicyHash = fingerprintRuntimePolicy(policy);
    assert.equal(runtimePolicyHash, policyHash);

    const health = join(root, "health");
    mkdirSync(health);
    writeFileSync(join(health, "request.json"), JSON.stringify({
      schemaVersion: 2,
      requestedAt: "2026-07-21T23:00:00.000Z",
      ...expectation,
    }), { mode: 0o600 });
    chmodSync(join(health, "request.json"), 0o600);
    const accepted = await answerPromotionHealthRequest(root, {
      authenticatedSession: () => "pass",
      declaredPermission: () => "pass",
      rendererReady: () => "pass",
      rendererProof: () => ({
        capturedWindowCount: 1,
        canonicalWebContentsId: 9,
        canonicalUrl: "app://-/index.html?hostId=policy-test",
        authorized: true,
        didFinishLoad: true,
        mounted: true,
        originalPreload: true,
        preloadFailed: false,
        loadFailed: false,
        rendererExited: false,
        cleanup: "pass",
        failureReason: null,
      }),
      promotionSurface: (surface) => surface === "policy" ? runtimePolicyHash : hashes[surface],
      userQuestionsHealth: () => ({
        id: proof.id,
        version: proof.version,
        payloadHash: proof.payloadHash,
        mainLifecycle: "pass",
        brokerSelfTest: "pass",
        schemaSelfTest: "pass",
        rendererStorageSelfTest: "pass",
        mcpConflictCount: 0,
      }),
    }, { now: new Date("2026-07-21T23:00:01.000Z") });
    assert.equal(accepted, true);
    const receipt = JSON.parse(readFileSync(join(health, "promotion.json"), "utf8"));
    assert.deepEqual(receipt.surfaces.policy, {
      preimageHash: policyHash,
      expectedHash: policyHash,
      observedHash: policyHash,
      status: "pass",
    });
    assert.equal(receipt.promotionReady, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expectation rejects semantic policy changes before leaving health or approval residue", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-expectation-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const original = policyState();
    writePolicy(policy, original);
    const beforePolicy = fingerprintInstallerPolicy(policy);
    const changed = structuredClone(original);
    const atoms = changed["electron-persisted-atom-state"] as Record<string, unknown>;
    const threads = atoms["heartbeat-thread-permissions-by-id"] as Record<string, unknown>;
    (threads.alpha as Record<string, unknown>).approvalPolicy = "never";
    writePolicy(policy, changed);
    const afterPolicy = fingerprintInstallerPolicy(policy);
    assert.notEqual(afterPolicy, beforePolicy);

    const before = policySurfaceHashes(beforePolicy);
    const after = policySurfaceHashes(afterPolicy);
    assert.throws(() => buildPromotionHealthExpectation({
      app: { version: "candidate", build: "policy-change", hash: after.app },
      before,
      after,
      requiredPermissions: [],
      userQuestionsRoot,
    }), /policy surface must remain present and semantically unchanged/);
    assert.equal(existsSync(join(root, "health", "request.json")), false);
    assert.equal(existsSync(join(root, "health", "promotion.json")), false);

    assert.throws(() => buildPromotionHealthExpectation({
      app: { version: "candidate", build: "policy-missing", hash: after.app },
      before: { ...before, policy: "missing" },
      after: { ...after, policy: "missing" },
      requiredPermissions: [],
      userQuestionsRoot,
    }), /policy surface must remain present and semantically unchanged/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expectation permits unrelated UI/session persistence under the same semantic policy hash", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-promotion-policy-volatile-"));
  try {
    const policy = join(root, ".codex-global-state.json");
    const original = policyState();
    writePolicy(policy, original);
    const beforePolicy = fingerprintInstallerPolicy(policy);
    const changed = structuredClone(original);
    changed["ui-window-state"] = { route: "/persisted", session: 999 };
    const atoms = changed["electron-persisted-atom-state"] as Record<string, unknown>;
    atoms["transient-ui-atom"] = { selectedTab: "different", windowTimestamp: Date.now() };
    writePolicy(policy, changed);
    const afterPolicy = fingerprintInstallerPolicy(policy);
    assert.equal(afterPolicy, beforePolicy);

    const before = policySurfaceHashes(beforePolicy);
    const after = policySurfaceHashes(afterPolicy);
    const expectation = buildPromotionHealthExpectation({
      app: { version: "candidate", build: "volatile-state", hash: after.app },
      before,
      after,
      requiredPermissions: [],
      userQuestionsRoot,
    });
    assert.deepEqual(expectation.surfaces.policy, {
      preimageHash: beforePolicy,
      afterHash: afterPolicy,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function reverseObjectOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectOrder);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .reverse()
    .map(([key, entry]) => [key, reverseObjectOrder(entry)]));
}

function policySurfaceHashes(policy: string): Record<(typeof PROMOTION_SURFACE_NAMES)[number], string> {
  return Object.fromEntries(PROMOTION_SURFACE_NAMES.map((name, index) => [
    name,
    name === "policy" ? policy : String((index + 1) % 10).repeat(64),
  ])) as Record<(typeof PROMOTION_SURFACE_NAMES)[number], string>;
}
