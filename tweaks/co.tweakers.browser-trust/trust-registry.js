"use strict";

const { createHash } = require("node:crypto");

const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_VERSION = "1.0.0";

const TRUST_REGISTRY = deepFreeze({
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  version: REGISTRY_VERSION,
  reviewedBrowserClientSha256s: [
    "6d25aa7656feac858f3a3bdaea5bcbab0dbfd426c9de8e6931ce90c399ee8e4f",
    "e13fd947e846d3d306e9249dd3c73d14931b6494803dbafb16cef85e6add9506",
  ],
  routes: {
    "browser": {
      routeId: "browser",
      state: "trusted",
      projection: "browser-config",
      defaultApprovalMode: "never_ask",
      approvedActions: ["browse", "history"],
      promptedActions: ["download", "full_cdp_access", "upload"],
      identity: {
        appVersion: "26.721.41059",
        clientSha256: "e13fd947e846d3d306e9249dd3c73d14931b6494803dbafb16cef85e6add9506",
      },
    },
    "chrome-devtools": {
      routeId: "chrome-devtools",
      state: "trusted",
      projection: "manual-mcp",
      defaultApprovalMode: "prompt",
      approvedActions: [
        "get_console_message",
        "list_console_messages",
        "list_network_requests",
        "list_pages",
        "performance_analyze_insight",
        "wait_for",
      ],
      identity: {
        packageTreeFileCount: 366,
        packageVersion: "1.6.0",
        packageTreeFingerprint: "5e8e57f0be38140176f64e275de129930efbbc8016364b592f6e5b4c6825be6e",
        wrapperSha256: "9409efb9607f52d38ed182e35a63318e03a623fdaf7e4aedd72127a7e8b74000",
      },
    },
    "infographic-preview-playwright": {
      routeId: "infographic-preview-playwright",
      state: "unsupported_projection",
      projection: "plugin-mcp",
      defaultApprovalMode: "prompt",
      movingPackageSpec: "@playwright/mcp@latest",
      approvedActions: [],
      reviewedActions: [
        "browser_console_messages",
        "browser_find",
        "browser_network_request",
        "browser_network_requests",
        "browser_snapshot",
        "browser_wait_for",
      ],
    },
    "node-repl-browser-client": {
      routeId: "node-repl-browser-client",
      state: "unsupported_projection",
      projection: "registry-only",
      defaultApprovalMode: "prompt",
      approvedActions: [],
    },
  },
});

/**
 * Produce a JSON-compatible canonical value. Object keys and arrays are sorted
 * recursively because every array in the public registry is a semantic set.
 */
function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => canonicalize(entry))
      .sort((left, right) => canonicalString(left).localeCompare(canonicalString(right)));
  }
  if (!isRecord(value)) {
    throw new TypeError("The trust registry must contain only JSON-compatible values");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}

function canonicalString(value) {
  return JSON.stringify(value);
}

function canonicalSerialize(value = TRUST_REGISTRY) {
  return canonicalString(canonicalize(value));
}

function registryDigest(value = TRUST_REGISTRY) {
  return createHash("sha256").update(canonicalSerialize(value), "utf8").digest("hex");
}

/**
 * Resolve one exact registry action. This function deliberately has no
 * wildcard, prefix, alias, or hash-trust fallback.
 */
function resolveActionPolicy(routeId, actionName, evidence = {}) {
  const route = typeof routeId === "string" ? TRUST_REGISTRY.routes[routeId] : undefined;
  const exactAction = typeof actionName === "string" && actionName.length > 0 ? actionName : null;
  const attestedState = routeId === "chrome-devtools"
    ? evaluateChromeIdentity(evidence)
    : routeId === "browser"
      ? evaluateBrowserIdentity(evidence)
      : route?.state || "unknown";
  if (!route || !exactAction || attestedState !== "trusted") {
    return {
      routeId: typeof routeId === "string" ? routeId : "",
      actionName: exactAction || "",
      approvalMode: routeId === "browser" ? "always_ask" : "prompt",
      approved: false,
      consequential: true,
      trusted: false,
      state: attestedState,
    };
  }

  const approved = route.approvedActions.includes(exactAction);
  return {
    routeId,
    actionName: exactAction,
    approvalMode: approved ? approvedMode(route) : "prompt",
    approved,
    consequential: !approved,
    trusted: approved,
    state: attestedState,
  };
}

function evaluateChromeIdentity(evidence = {}) {
  const expected = TRUST_REGISTRY.routes["chrome-devtools"].identity;
  if (evidence.packageVersion !== expected.packageVersion) return "runtime_mismatch";
  if (
    evidence.chromeMode !== "shared"
    || evidence.headless !== "1"
    || evidence.autoLaunch !== "1"
    || !profileEndsWith(evidence.seedProfile, "/.chrome-profiles/openai-agent")
    || !profileEndsWith(evidence.liveProfile, "/.chrome-profiles/openai-agent-devtools")
  ) return "profile_mismatch";
  if (
    evidence.wrapperSha256 !== expected.wrapperSha256
    || evidence.packageTreeFingerprint !== expected.packageTreeFingerprint
  ) return "identity_drift";
  return "trusted";
}

function evaluateBrowserIdentity(evidence = {}) {
  const expected = TRUST_REGISTRY.routes.browser.identity;
  if (evidence.appVersion !== expected.appVersion) return "runtime_mismatch";
  if (
    evidence.pluginEnabled !== true
    || evidence.clientSha256 !== expected.clientSha256
    || !Array.isArray(evidence.trustedClientSha256s)
    || !evidence.trustedClientSha256s.includes(expected.clientSha256)
  ) return "identity_drift";
  return "trusted";
}

function profileEndsWith(actual, expectedSuffix) {
  return typeof actual === "string" && actual.replace(/\/+$/u, "").endsWith(expectedSuffix);
}

function approvedMode(route) {
  return route.projection === "browser-config" ? "never_ask" : "approve";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_VERSION,
  TRUST_REGISTRY,
  canonicalSerialize,
  canonicalize,
  evaluateBrowserIdentity,
  evaluateChromeIdentity,
  registryDigest,
  resolveActionPolicy,
};
