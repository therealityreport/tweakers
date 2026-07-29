"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadCommonJs } = require("./load-commonjs.cjs");

const REGISTRY_PATH = path.resolve(__dirname, "../trust-registry.js");
const {
  TRUST_REGISTRY,
  canonicalSerialize,
  canonicalize,
  evaluateBrowserIdentity,
  evaluateChromeIdentity,
  registryDigest,
  resolveActionPolicy,
} = loadCommonJs(REGISTRY_PATH);
const {
  BROWSER_CLIENT_SHA256,
  CHROME_TREE_SHA256,
  CHROME_WRAPPER_SHA256,
} = require("./policy-fixture.cjs");

const CHROME_APPROVED = [
  "get_console_message",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "performance_analyze_insight",
  "wait_for",
];
const CHROME_PROMPTED = [
  "navigate_page",
  "new_page",
  "get_network_request",
  "take_snapshot",
  "take_screenshot",
  "evaluate_script",
  "click",
  "upload_file",
  "select_page",
  "invented_future_tool",
];
const INFOGRAPHIC_REVIEWED = [
  "browser_console_messages",
  "browser_find",
  "browser_network_request",
  "browser_network_requests",
  "browser_snapshot",
  "browser_wait_for",
];
const INFOGRAPHIC_PROMPTED = [
  "browser_navigate",
  "browser_run_code_unsafe",
  "browser_click",
  "browser_type",
  "browser_file_upload",
  "browser_pdf_save",
  "browser_take_screenshot",
  "browser_tabs",
  "invented_future_tool",
];
const REVIEWED_BROWSER_CLIENT_HASHES = [
  "6d25aa7656feac858f3a3bdaea5bcbab0dbfd426c9de8e6931ce90c399ee8e4f",
  "e13fd947e846d3d306e9249dd3c73d14931b6494803dbafb16cef85e6add9506",
];
const CHROME_EVIDENCE = Object.freeze({
  packageVersion: "1.6.0",
  chromeMode: "shared",
  headless: "1",
  autoLaunch: "1",
  seedProfile: "/test-home/.chrome-profiles/openai-agent",
  liveProfile: "/test-home/.chrome-profiles/openai-agent-devtools",
  wrapperSha256: CHROME_WRAPPER_SHA256,
  packageTreeFingerprint: CHROME_TREE_SHA256,
});
const BROWSER_EVIDENCE = Object.freeze({
  pluginEnabled: true,
  appVersion: "26.721.41059",
  clientSha256: BROWSER_CLIENT_SHA256,
  trustedClientSha256s: [...REVIEWED_BROWSER_CLIENT_HASHES],
});

test("registry digest is deterministic across object-key and semantic-set order", () => {
  const clone = JSON.parse(JSON.stringify(TRUST_REGISTRY));
  const reordered = reverseRecursively(clone);

  assert.match(registryDigest(), /^[a-f0-9]{64}$/);
  assert.equal(registryDigest(reordered), registryDigest(TRUST_REGISTRY));
  assert.equal(canonicalSerialize(reordered), canonicalSerialize(TRUST_REGISTRY));
  assert.deepEqual(plain(canonicalize(reordered)), plain(canonicalize(TRUST_REGISTRY)));

  reordered.routes["chrome-devtools"].approvedActions.push("invented_future_tool");
  assert.notEqual(registryDigest(reordered), registryDigest(TRUST_REGISTRY));
});

test("registry preserves both exact reviewed browser-client hashes", () => {
  assert.deepEqual(
    [...TRUST_REGISTRY.reviewedBrowserClientSha256s].sort(),
    [...REVIEWED_BROWSER_CLIENT_HASHES].sort(),
  );
  assert.equal(new Set(TRUST_REGISTRY.reviewedBrowserClientSha256s).size, 2);
  assert.equal(TRUST_REGISTRY.reviewedBrowserClientSha256s.every((value) => /^[a-f0-9]{64}$/.test(value)), true);
  assert.equal(Object.isFrozen(TRUST_REGISTRY.reviewedBrowserClientSha256s), true);
});

test("Chrome DevTools defaults to prompt and approves only the exact six reviewed 1.6.0 pure tools", () => {
  const route = TRUST_REGISTRY.routes["chrome-devtools"];
  assert.equal(route.defaultApprovalMode, "prompt");
  assert.deepEqual([...route.approvedActions].sort(), [...CHROME_APPROVED].sort());
  assert.equal(evaluateChromeIdentity(CHROME_EVIDENCE), "trusted");

  for (const actionName of CHROME_APPROVED) {
    assert.deepEqual(plain(resolveActionPolicy("chrome-devtools", actionName, CHROME_EVIDENCE)), {
      routeId: "chrome-devtools",
      actionName,
      approvalMode: "approve",
      approved: true,
      consequential: false,
      trusted: true,
      state: route.state,
    });
  }
  for (const actionName of CHROME_PROMPTED) {
    assertPrompted(resolveActionPolicy("chrome-devtools", actionName, CHROME_EVIDENCE), "chrome-devtools", actionName, route.state);
  }
});

test("Chrome DevTools identity, runtime, and profile evidence all fail closed independently", () => {
  const cases = [
    ["missing evidence", {}, "runtime_mismatch"],
    ["package version mismatch", { packageVersion: "1.6.1" }, "runtime_mismatch"],
    ["wrapper SHA mismatch", { wrapperSha256: "0".repeat(64) }, "identity_drift"],
    ["package tree mismatch", { packageTreeFingerprint: "0".repeat(64) }, "identity_drift"],
    ["mode mismatch", { chromeMode: "isolated" }, "profile_mismatch"],
    ["headless mismatch", { headless: "0" }, "profile_mismatch"],
    ["auto-launch mismatch", { autoLaunch: "0" }, "profile_mismatch"],
    ["seed profile mismatch", { seedProfile: "/test-home/.chrome-profiles/codex" }, "profile_mismatch"],
    ["live profile mismatch", { liveProfile: "/test-home/.chrome-profiles/codex" }, "profile_mismatch"],
  ];
  for (const [label, change, state] of cases) {
    const evidence = label === "missing evidence" ? change : { ...CHROME_EVIDENCE, ...change };
    assert.equal(evaluateChromeIdentity(evidence), state, label);
    for (const actionName of CHROME_APPROVED) {
      assertPrompted(resolveActionPolicy("chrome-devtools", actionName, evidence), "chrome-devtools", actionName, state);
    }
  }
});

test("moving Infographic Playwright transport remains unsupported with zero prompt-free actions", () => {
  const route = TRUST_REGISTRY.routes["infographic-preview-playwright"];
  const reviewedActions = route.reviewedActions || route.approvedActions;
  assert.equal(route.defaultApprovalMode, "prompt");
  assert.equal(route.state, "unsupported_projection");
  assert.deepEqual([...reviewedActions].sort(), [...INFOGRAPHIC_REVIEWED].sort());

  for (const actionName of [...INFOGRAPHIC_REVIEWED, ...INFOGRAPHIC_PROMPTED]) {
    assertPrompted(
      resolveActionPolicy("infographic-preview-playwright", actionName),
      "infographic-preview-playwright",
      actionName,
      "unsupported_projection",
    );
  }
});

test("browser route never prompts for browse/history and always prompts for transfer or raw-CDP actions", () => {
  assert.equal(evaluateBrowserIdentity(BROWSER_EVIDENCE), "trusted");
  for (const actionName of ["browse", "history"]) {
    const policy = plain(resolveActionPolicy("browser", actionName, BROWSER_EVIDENCE));
    assert.equal(policy.approvalMode, "never_ask");
    assert.equal(policy.approved, true);
    assert.equal(policy.consequential, false);
    assert.equal(policy.trusted, true);
  }
  for (const actionName of ["download", "upload", "full_cdp_access", "invented_future_action"]) {
    assertPrompted(resolveActionPolicy("browser", actionName, BROWSER_EVIDENCE), "browser", actionName, TRUST_REGISTRY.routes.browser.state);
  }
});

test("built-in Browser attestation failure makes every browser action always-ask", () => {
  const cases = [
    ["missing evidence", {}, "runtime_mismatch"],
    ["app version mismatch", { appVersion: "26.999.0" }, "runtime_mismatch"],
    ["plugin disabled", { pluginEnabled: false }, "identity_drift"],
    ["client hash mismatch", { clientSha256: "0".repeat(64) }, "identity_drift"],
    ["accepted-hash environment missing reviewed client", { trustedClientSha256s: [REVIEWED_BROWSER_CLIENT_HASHES[0]] }, "identity_drift"],
  ];
  for (const [label, change, state] of cases) {
    const evidence = label === "missing evidence" ? change : { ...BROWSER_EVIDENCE, ...change };
    assert.equal(evaluateBrowserIdentity(evidence), state, label);
    for (const actionName of ["browse", "history", "download", "upload", "full_cdp_access"]) {
      const result = plain(resolveActionPolicy("browser", actionName, evidence));
      assert.equal(result.approvalMode, "always_ask", label);
      assert.equal(result.approved, false, label);
      assert.equal(result.trusted, false, label);
      assert.equal(result.state, state, label);
    }
  }
});

test("Node REPL JavaScript remains unsupported and prompted", () => {
  for (const actionName of ["js", "browser_control", "invented_future_tool"]) {
    assertPrompted(
      resolveActionPolicy("node-repl-browser-client", actionName),
      "node-repl-browser-client",
      actionName,
      "unsupported_projection",
    );
  }
});

test("unknown route and unknown action fail closed as consequential and untrusted", () => {
  assert.deepEqual(plain(resolveActionPolicy("invented-future-route", "invented_future_tool")), {
    routeId: "invented-future-route",
    actionName: "invented_future_tool",
    approvalMode: "prompt",
    approved: false,
    consequential: true,
    trusted: false,
    state: "unknown",
  });
  assertPrompted(
    resolveActionPolicy("chrome-devtools", "invented_future_tool", CHROME_EVIDENCE),
    "chrome-devtools",
    "invented_future_tool",
    TRUST_REGISTRY.routes["chrome-devtools"].state,
  );
});

function assertPrompted(value, routeId, actionName, state) {
  assert.deepEqual(plain(value), {
    routeId,
    actionName,
    approvalMode: "prompt",
    approved: false,
    consequential: true,
    trusted: false,
    state,
  });
}

function reverseRecursively(value) {
  if (Array.isArray(value)) return value.map(reverseRecursively).reverse();
  if (value === null || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).reverse()) result[key] = reverseRecursively(value[key]);
  return result;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
