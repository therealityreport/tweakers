"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TRUST_REGISTRY,
  evaluateBrowserIdentity,
  evaluateChromeIdentity,
  registryDigest,
} = require("./trust-registry");

const RECEIPT_SCHEMA_VERSION = 1;
const TRANSACTIONS_DIRECTORY = ".browser-trust-transactions";
const CHROME_TABLE = "mcp_servers.chrome-devtools";
const CHROME_ENV_TABLE = "mcp_servers.chrome-devtools.env";
const CHROME_TOOL_PREFIX = "mcp_servers.chrome-devtools.tools.";
const INFOGRAPHIC_TABLE =
  'plugins."infographic-docs@local-plugins".mcp_servers.infographic-preview-playwright';
const INFOGRAPHIC_TOOL_PREFIX = `${INFOGRAPHIC_TABLE}.tools.`;
const BROWSER_PLUGIN_TABLE = 'plugins."browser@openai-bundled"';
const NODE_REPL_ENV_TABLE = "mcp_servers.node_repl.env";
const BROWSER_KEYS = Object.freeze([
  "approval_mode",
  "download_approval_mode",
  "full_cdp_access_enabled",
  "history_approval_mode",
  "upload_approval_mode",
]);
const CHROME_APPROVED_TOOLS = Object.freeze([
  "get_console_message",
  "list_console_messages",
  "list_network_requests",
  "list_pages",
  "performance_analyze_insight",
  "wait_for",
]);
const SAFE_ID = /^[A-Za-z0-9._~-]{8,256}$/;

class BrowserTrustPolicyError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "BrowserTrustPolicyError";
    this.code = code;
  }
}

function createPolicyCommandInterface(options = {}) {
  const frozen = { ...options };
  return Object.freeze({
    status: () => statusPolicy(frozen),
    preview: () => previewPolicyChange(frozen),
    apply: (previewToken) => publicMutationCall(
      () => applyPolicyChange({ ...frozen, previewToken }),
    ),
    restore: (transactionId) => publicMutationCall(
      () => restorePolicyChange({ ...frozen, transactionId }),
    ),
  });
}

function publicMutationCall(operation) {
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof BrowserTrustPolicyError)
      || !/^(?:apply|restore)(?:_rollback)?_failed$/u.test(error.code)
    ) throw error;
    return {
      status: error.code,
      errorCode: error.code,
      changed: false,
      transactionId: null,
      restartRequired: false,
      restarted: false,
      registryFingerprint: registryDigest(),
      routeStates: [],
    };
  }
}

/** Read-only: this function never creates a directory, backup, receipt, or temporary file. */
function previewPolicyChange(options = {}) {
  const context = policyContext(options);
  runHook(context, "preview.before-read");
  const sources = readSources(context);
  const plan = createProjectionPlan(sources, context);
  return publicPreview(plan);
}

function applyPolicyChange(options = {}) {
  const previewToken = requireOpaqueId(
    options.previewToken,
    "preview_token_required",
  );
  const context = policyContext(options);
  const sources = readSources(context);
  const plan = createProjectionPlan(sources, context);

  if (plan.previewToken !== previewToken) {
    const idempotent = findIdempotentApply(context, previewToken, sources);
    if (idempotent) return publicApplyResult(idempotent, false, true);
    throw new BrowserTrustPolicyError("preview_stale");
  }
  if (!plan.changed) {
    return {
      status: "current",
      changed: false,
      transactionId: null,
      restartRequired: false,
      restarted: false,
      registryFingerprint: plan.registryFingerprint,
      routeStates: plan.routeStates,
    };
  }

  ensurePrivateDirectory(context.dataDir, context);
  ensurePrivateDirectory(context.transactionsDirectory, context);
  const transactionId = context.randomUUID();
  const beforeConfigName = `${transactionId}.config.before.toml`;
  const beforeBrowserName = `${transactionId}.browser.before.toml`;
  const receiptName = `${transactionId}.receipt.json`;
  const receiptPath = path.join(context.transactionsDirectory, receiptName);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    transactionId,
    status: "prepared",
    createdAt: context.now(),
    updatedAt: context.now(),
    previewToken,
    registryFingerprint: plan.registryFingerprint,
    targets: {
      configPath: context.configPath,
      browserConfigPath: context.browserConfigPath,
    },
    beforeConfigFile: beforeConfigName,
    beforeBrowserFile: sources.browser.exists ? beforeBrowserName : null,
    before: privateSourceRecord(sources),
    applied: {
      configSha256: sha256(Buffer.from(plan.configText)),
      configMode: sources.config.mode,
      browserExists: true,
      browserSha256: sha256(Buffer.from(plan.browserText)),
      browserMode: sources.browser.exists ? sources.browser.mode : 0o600,
    },
    beforeOwned: plan.beforeOwned,
    appliedOwned: plan.appliedOwned,
    routeStates: plan.routeStates,
    restoredAt: null,
  };

  writePrivateFile(
    path.join(context.transactionsDirectory, beforeConfigName),
    sources.config.bytes,
    context,
    "apply.backup-config",
  );
  if (sources.browser.exists) {
    writePrivateFile(
      path.join(context.transactionsDirectory, beforeBrowserName),
      sources.browser.bytes,
      context,
      "apply.backup-browser",
    );
  }
  writePrivateFile(receiptPath, receiptBytes(receipt), context, "apply.receipt-prepared");

  let configPublished = false;
  let browserPublished = false;
  try {
    assertSourceUnchanged(context.configPath, sources.config, context, "apply.config-cas");
    atomicReplace(
      context.configPath,
      Buffer.from(plan.configText),
      sources.config.mode,
      context,
      "apply.config",
    );
    configPublished = true;

    assertSourceUnchanged(
      context.browserConfigPath,
      sources.browser,
      context,
      "apply.browser-cas",
    );
    atomicReplace(
      context.browserConfigPath,
      Buffer.from(plan.browserText),
      sources.browser.exists ? sources.browser.mode : 0o600,
      context,
      "apply.browser",
    );
    browserPublished = true;

    verifyAppliedSources(context, receipt.applied);
    const appliedReceipt = {
      ...receipt,
      status: "applied",
      updatedAt: context.now(),
    };
    atomicReplace(
      receiptPath,
      receiptBytes(appliedReceipt),
      0o600,
      context,
      "apply.receipt-commit",
    );
    return publicApplyResult(appliedReceipt, true, false);
  } catch (error) {
    let rollbackError = null;
    try {
      if (browserPublished) restoreExactSource(context.browserConfigPath, sources.browser, context, "apply.rollback-browser");
      if (configPublished) restoreExactSource(context.configPath, sources.config, context, "apply.rollback-config");
    } catch (candidate) {
      rollbackError = candidate;
    }
    if (rollbackError) {
      throw new BrowserTrustPolicyError("apply_rollback_failed", "apply_rollback_failed", {
        cause: rollbackError,
      });
    }
    throw error instanceof BrowserTrustPolicyError
      ? error
      : new BrowserTrustPolicyError("apply_failed", "apply_failed", { cause: error });
  }
}

function restorePolicyChange(options = {}) {
  const transactionId = requireOpaqueId(
    options.transactionId,
    "transaction_id_required",
  );
  const context = policyContext(options);
  const receiptPath = path.join(
    context.transactionsDirectory,
    `${transactionId}.receipt.json`,
  );
  const receipt = readReceipt(receiptPath, transactionId, context);
  if (receipt.status === "restored") return publicRestoreResult(receipt, false);
  if (receipt.status !== "applied") {
    throw new BrowserTrustPolicyError("transaction_not_restorable");
  }

  const current = readSources(context);
  const currentOwned = observeOwnedProjection(
    current.config.text,
    current.browser.text,
    current.browser.exists,
  );
  if (!deepEqual(currentOwned, receipt.appliedOwned)) {
    throw new BrowserTrustPolicyError("target_drift");
  }

  const beforeConfig = readPrivateBackup(
    path.join(context.transactionsDirectory, receipt.beforeConfigFile),
    receipt.before.configSha256,
    context,
  ).toString("utf8");
  const beforeBrowser = receipt.beforeBrowserFile
    ? readPrivateBackup(
      path.join(context.transactionsDirectory, receipt.beforeBrowserFile),
      receipt.before.browserSha256,
      context,
    ).toString("utf8")
    : null;
  const currentMatchesApplied =
    current.config.sha256 === receipt.applied.configSha256
    && current.config.mode === receipt.applied.configMode
    && current.browser.exists === receipt.applied.browserExists
    && current.browser.sha256 === receipt.applied.browserSha256
    && current.browser.mode === receipt.applied.browserMode;
  const restoredConfigText = currentMatchesApplied
    ? beforeConfig
    : restoreCodexOwned(current.config.text, beforeConfig);
  const restoredBrowserText = currentMatchesApplied
    ? (beforeBrowser || "")
    : restoreBrowserOwned(current.browser.text, beforeBrowser);
  const shouldRemoveBrowser =
    beforeBrowser === null && restoredBrowserText.trim().length === 0;

  let configPublished = false;
  let browserPublished = false;
  try {
    assertSourceUnchanged(context.configPath, current.config, context, "restore.config-cas");
    atomicReplace(
      context.configPath,
      Buffer.from(restoredConfigText),
      current.config.mode,
      context,
      "restore.config",
    );
    configPublished = true;

    assertSourceUnchanged(
      context.browserConfigPath,
      current.browser,
      context,
      "restore.browser-cas",
    );
    if (shouldRemoveBrowser) {
      runHook(context, "restore.browser.before-unlink");
      if (context.fs.existsSync(context.browserConfigPath)) {
        context.fs.unlinkSync(context.browserConfigPath);
        fsyncDirectory(path.dirname(context.browserConfigPath), context);
      }
    } else {
      atomicReplace(
        context.browserConfigPath,
        Buffer.from(restoredBrowserText),
        current.browser.exists ? current.browser.mode : receipt.before.browserMode || 0o600,
        context,
        "restore.browser",
      );
    }
    browserPublished = true;

    const restoredReceipt = {
      ...receipt,
      status: "restored",
      updatedAt: context.now(),
      restoredAt: context.now(),
    };
    atomicReplace(
      receiptPath,
      receiptBytes(restoredReceipt),
      0o600,
      context,
      "restore.receipt-commit",
    );
    return publicRestoreResult(restoredReceipt, true);
  } catch (error) {
    let rollbackError = null;
    try {
      if (browserPublished) restoreExactSource(context.browserConfigPath, current.browser, context, "restore.rollback-browser");
      if (configPublished) restoreExactSource(context.configPath, current.config, context, "restore.rollback-config");
    } catch (candidate) {
      rollbackError = candidate;
    }
    if (rollbackError) {
      throw new BrowserTrustPolicyError("restore_rollback_failed", "restore_rollback_failed", {
        cause: rollbackError,
      });
    }
    throw error instanceof BrowserTrustPolicyError
      ? error
      : new BrowserTrustPolicyError("restore_failed", "restore_failed", { cause: error });
  }
}

function statusPolicy(options = {}) {
  const context = policyContext(options);
  const latest = latestReceipt(context);
  let routeStates = [];
  try {
    const sources = readSources(context);
    routeStates = createProjectionPlan(sources, context).routeStates;
  } catch (error) {
    if (!(error instanceof BrowserTrustPolicyError)) throw error;
    routeStates = [{
      routeId: "user-questions",
      state: error.code === "policy_blocked" ? "policy_blocked" : "schema_drift",
    }];
  }
  return {
    status: latest?.status === "applied" ? "restorable" : "none",
    changed: false,
    transactionId: latest?.status === "applied" ? latest.transactionId : null,
    restartRequired: false,
    restarted: false,
    registryFingerprint: registryDigest(),
    routeStates,
  };
}

function createProjectionPlan(sources, context) {
  assertUserQuestionsPreserved(sources.config.text);
  const evidence = collectIdentityEvidence(sources.config.text, context);
  const chromePresent = tableCount(sources.config.text, CHROME_TABLE) === 1;
  const infographicPresent =
    tableCount(sources.config.text, INFOGRAPHIC_TABLE) === 1;
  const chromeState = chromePresent
    ? evaluateChromeIdentity(evidence.chrome)
    : "disabled";
  const browserState = evaluateBrowserIdentity(evidence.browser);
  const infographicState = infographicPresent
    ? "unsupported_projection"
    : "disabled";
  const routeStates = [
    { routeId: "browser", state: browserState },
    { routeId: "chrome-devtools", state: chromeState },
    { routeId: "infographic-preview-playwright", state: infographicState },
    { routeId: "node-repl-browser-client", state: "unsupported_projection" },
  ];

  let configText = sources.config.text;
  if (chromePresent) {
    configText = projectMcpRoute(
      configText,
      CHROME_TABLE,
      CHROME_TOOL_PREFIX,
      chromeState === "trusted" ? CHROME_APPROVED_TOOLS : [],
    );
  }
  if (infographicPresent) {
    configText = projectMcpRoute(
      configText,
      INFOGRAPHIC_TABLE,
      INFOGRAPHIC_TOOL_PREFIX,
      [],
    );
  }
  const browserText = projectBrowserConfig(
    sources.browser.text,
    browserState === "trusted",
  );
  const beforeOwned = observeOwnedProjection(
    sources.config.text,
    sources.browser.text,
    sources.browser.exists,
  );
  const appliedOwned = observeOwnedProjection(configText, browserText, true);
  const affectedRoutes = affectedRouteCounts(beforeOwned, appliedOwned, routeStates);
  const registryFingerprint = registryDigest();
  const sourceFingerprint = sourceFingerprintFor(sources);
  const changed =
    configText !== sources.config.text
    || browserText !== sources.browser.text
    || !sources.browser.exists;
  const previewToken = sha256(Buffer.from(JSON.stringify({
    registryFingerprint,
    sourceFingerprint,
    configMode: sources.config.mode,
    browserExists: sources.browser.exists,
    browserMode: sources.browser.mode,
    appliedOwned,
  })));

  return {
    configText,
    browserText,
    beforeOwned,
    appliedOwned,
    affectedRoutes,
    affectedFieldCount: affectedRoutes.reduce((sum, route) => sum + route.fieldCount, 0),
    registryFingerprint,
    sourceFingerprint,
    previewToken,
    changed,
    routeStates,
  };
}

function publicPreview(plan) {
  return {
    status: plan.changed ? "ready" : "current",
    changed: plan.changed,
    affectedFieldCount: plan.affectedFieldCount,
    affectedRoutes: plan.affectedRoutes,
    registryFingerprint: plan.registryFingerprint,
    sourceFingerprint: plan.sourceFingerprint,
    previewToken: plan.previewToken,
    restartRequired: plan.changed,
  };
}

function publicApplyResult(receipt, changed, idempotent) {
  return {
    status: idempotent ? "applied" : "applied",
    changed,
    transactionId: receipt.transactionId,
    restartRequired: changed,
    restarted: false,
    registryFingerprint: receipt.registryFingerprint,
    routeStates: receipt.routeStates,
  };
}

function publicRestoreResult(receipt, changed) {
  return {
    status: "restored",
    changed,
    transactionId: receipt.transactionId,
    restartRequired: changed,
    restarted: false,
    registryFingerprint: receipt.registryFingerprint,
    routeStates: receipt.routeStates,
  };
}

function policyContext(options) {
  const deps = options.deps || {};
  const homeDir = options.homeDir || os.homedir();
  const dataDir = path.resolve(
    options.dataDir || path.join(homeDir, ".codex", "tweaks", "co.tweakers.browser-trust"),
  );
  const context = {
    fs: deps.fs || fs,
    homeDir,
    dataDir,
    configPath: path.resolve(
      options.configPath || path.join(homeDir, ".codex", "config.toml"),
    ),
    browserConfigPath: path.resolve(
      options.browserConfigPath || path.join(homeDir, ".codex", "browser", "config.toml"),
    ),
    randomUUID: deps.randomUUID || crypto.randomUUID,
    now: deps.now || (() => new Date().toISOString()),
    hook: deps.hook || options.hook,
    chromeIdentityEvidence: deps.chromeIdentityEvidence,
    browserIdentityEvidence: deps.browserIdentityEvidence,
  };
  context.transactionsDirectory = path.join(dataDir, TRANSACTIONS_DIRECTORY);
  return context;
}

function readSources(context) {
  return {
    config: readSource(context.configPath, context, false),
    browser: readSource(context.browserConfigPath, context, true),
  };
}

function readSource(file, context, optional) {
  if (!context.fs.existsSync(file)) {
    if (!optional) throw new BrowserTrustPolicyError("config_missing");
    return {
      exists: false,
      bytes: Buffer.alloc(0),
      text: "",
      mode: 0o600,
      sha256: sha256(Buffer.alloc(0)),
    };
  }
  const stat = context.fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BrowserTrustPolicyError("source_unsafe");
  }
  const bytes = context.fs.readFileSync(file);
  return {
    exists: true,
    bytes,
    text: bytes.toString("utf8"),
    mode: stat.mode & 0o777,
    sha256: sha256(bytes),
  };
}

function assertUserQuestionsPreserved(configText) {
  const assignments = topLevelAssignments(configText, "approval_policy");
  if (
    assignments.length !== 1
    || !/\bmcp_elicitations\s*=\s*true\b/u.test(assignments[0].value)
  ) {
    throw new BrowserTrustPolicyError("policy_blocked");
  }
}

function collectIdentityEvidence(configText, context) {
  const suppliedChrome = resolveEvidence(context.chromeIdentityEvidence, {
    configText,
    context,
  });
  const suppliedBrowser = resolveEvidence(context.browserIdentityEvidence, {
    configText,
    context,
  });
  return {
    chrome: suppliedChrome || defaultChromeEvidence(configText, context),
    browser: suppliedBrowser || defaultBrowserEvidence(configText, context),
  };
}

function resolveEvidence(value, input) {
  if (typeof value === "function") return value(input);
  return value && typeof value === "object" ? value : null;
}

function defaultChromeEvidence(configText, context) {
  const base = tableAssignments(configText, CHROME_TABLE);
  const env = tableAssignments(configText, CHROME_ENV_TABLE);
  const packageVersion = stringValue(env.CODEX_CHROME_MCP_VERSION);
  const command = stringValue(base.command);
  const wrapperSha256 = safeFileSha256(command, context);
  const packageRoot = path.join(
    context.homeDir,
    ".codex",
    "tmp",
    "chrome-devtools-global",
    "runtime",
    packageVersion || "missing",
    "node_modules",
    "chrome-devtools-mcp",
  );
  return {
    packageVersion,
    chromeMode: stringValue(env.CODEX_CHROME_MODE),
    headless: stringValue(env.CODEX_CHROME_HEADLESS),
    autoLaunch: stringValue(env.CODEX_CHROME_AUTO_LAUNCH),
    seedProfile: stringValue(env.CODEX_CHROME_SEED_PROFILE_DIR),
    liveProfile: stringValue(env.CODEX_CHROME_PROFILE_DIR),
    wrapperSha256,
    packageTreeFingerprint: safeTreeFingerprint(packageRoot, context),
  };
}

function defaultBrowserEvidence(configText, context) {
  const plugin = tableAssignments(configText, BROWSER_PLUGIN_TABLE);
  const env = tableAssignments(configText, NODE_REPL_ENV_TABLE);
  const appVersion = stringValue(env.BROWSER_USE_CODEX_APP_VERSION);
  const clientFile = path.join(
    context.homeDir,
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "browser",
    appVersion || "missing",
    "scripts",
    "browser-client.mjs",
  );
  return {
    appVersion,
    pluginEnabled: booleanValue(plugin.enabled),
    clientSha256: safeFileSha256(clientFile, context),
    trustedClientSha256s: (stringValue(
      env.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S,
    ) || "").split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function safeFileSha256(file, context) {
  try {
    if (!file || !context.fs.existsSync(file)) return "";
    const stat = context.fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return "";
    return sha256(context.fs.readFileSync(file));
  } catch {
    return "";
  }
}

function safeTreeFingerprint(root, context) {
  try {
    if (!context.fs.existsSync(root) || !context.fs.lstatSync(root).isDirectory()) return "";
    const files = [];
    const visit = (directory) => {
      for (const entry of context.fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile()) files.push(file);
        else throw new Error("unsafe tree entry");
      }
    };
    visit(root);
    files.sort();
    const hash = crypto.createHash("sha256");
    for (const file of files) {
      hash.update(path.relative(root, file).replaceAll(path.sep, "/"));
      hash.update("\0");
      hash.update(context.fs.readFileSync(file));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
}

function projectMcpRoute(text, baseTable, toolPrefix, approvedTools) {
  assertTargetStructure(text, baseTable, toolPrefix);
  let next = setTableAssignment(
    text,
    baseTable,
    "default_tools_approval_mode",
    '"prompt"',
  );
  next = removeTablesByPrefix(next, toolPrefix);
  if (approvedTools.length > 0) {
    const blocks = [...approvedTools].sort().map((tool) => (
      `[${toolPrefix}${tool}]\napproval_mode = "approve"\n`
    ));
    next = `${next.replace(/\s*$/u, "")}\n\n${blocks.join("\n")}`;
  }
  return ensureFinalNewline(next);
}

function projectBrowserConfig(text, trusted) {
  let next = text;
  next = setTopLevelAssignment(
    next,
    "approval_mode",
    trusted ? '"never_ask"' : '"always_ask"',
  );
  next = setTopLevelAssignment(next, "download_approval_mode", '"always_ask"');
  next = setTopLevelAssignment(next, "full_cdp_access_enabled", "false");
  next = setTopLevelAssignment(
    next,
    "history_approval_mode",
    trusted ? '"never_ask"' : '"always_ask"',
  );
  next = setTopLevelAssignment(next, "upload_approval_mode", '"always_ask"');
  return ensureFinalNewline(next);
}

function observeOwnedProjection(configText, browserText, browserExists) {
  return {
    chrome: observeMcpRoute(configText, CHROME_TABLE, CHROME_TOOL_PREFIX),
    infographic: observeMcpRoute(
      configText,
      INFOGRAPHIC_TABLE,
      INFOGRAPHIC_TOOL_PREFIX,
    ),
    browser: {
      exists: browserExists,
      values: Object.fromEntries(
        BROWSER_KEYS.map((key) => [key, singleTopLevelValue(browserText, key)]),
      ),
    },
  };
}

function observeMcpRoute(text, baseTable, toolPrefix) {
  const count = tableCount(text, baseTable);
  if (count === 0) return { exists: false, defaultMode: null, tools: {} };
  assertTargetStructure(text, baseTable, toolPrefix);
  const base = tableAssignments(text, baseTable);
  const tools = {};
  for (const table of parseTables(text).filter((entry) => entry.name.startsWith(toolPrefix))) {
    tools[table.name.slice(toolPrefix.length)] =
      stringValue(tableAssignments(text, table.name).approval_mode);
  }
  return {
    exists: true,
    defaultMode: stringValue(base.default_tools_approval_mode),
    tools,
  };
}

function affectedRouteCounts(before, after, routeStates) {
  const stateById = Object.fromEntries(routeStates.map((entry) => [entry.routeId, entry.state]));
  return [
    {
      routeId: "browser",
      fieldCount: differenceCount(before.browser, after.browser),
      state: stateById.browser,
    },
    {
      routeId: "chrome-devtools",
      fieldCount: differenceCount(before.chrome, after.chrome),
      state: stateById["chrome-devtools"],
    },
    {
      routeId: "infographic-preview-playwright",
      fieldCount: differenceCount(before.infographic, after.infographic),
      state: stateById["infographic-preview-playwright"],
    },
    {
      routeId: "node-repl-browser-client",
      fieldCount: 0,
      state: "unsupported_projection",
    },
  ];
}

function differenceCount(left, right) {
  if (deepEqual(left, right)) return 0;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return 1;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  let count = 0;
  for (const key of keys) count += deepEqual(left[key], right[key]) ? 0 : 1;
  return Math.max(1, count);
}

function restoreCodexOwned(currentText, beforeText) {
  let next = currentText;
  for (const [base, prefix] of [
    [CHROME_TABLE, CHROME_TOOL_PREFIX],
    [INFOGRAPHIC_TABLE, INFOGRAPHIC_TOOL_PREFIX],
  ]) {
    if (tableCount(next, base) === 0 || tableCount(beforeText, base) === 0) continue;
    const before = tableAssignments(beforeText, base);
    if (before.default_tools_approval_mode === undefined) {
      next = removeTableAssignment(next, base, "default_tools_approval_mode");
    } else {
      next = setTableAssignment(
        next,
        base,
        "default_tools_approval_mode",
        before.default_tools_approval_mode,
      );
    }
    next = removeTablesByPrefix(next, prefix);
    const blocks = extractTableBlocks(beforeText, prefix);
    if (blocks.length > 0) {
      next = `${next.replace(/\s*$/u, "")}\n\n${blocks.join("\n\n")}\n`;
    }
  }
  return ensureFinalNewline(next);
}

function restoreBrowserOwned(currentText, beforeText) {
  let next = currentText;
  for (const key of BROWSER_KEYS) {
    const beforeValue = beforeText === null
      ? null
      : singleTopLevelValue(beforeText, key);
    next = beforeValue === null
      ? removeTopLevelAssignment(next, key)
      : setTopLevelAssignment(next, key, beforeValue);
  }
  return ensureFinalNewline(next).replace(/^\n$/u, "");
}

function assertTargetStructure(text, baseTable, toolPrefix) {
  if (tableCount(text, baseTable) !== 1) {
    throw new BrowserTrustPolicyError("schema_drift");
  }
  const tables = parseTables(text);
  const names = new Set();
  for (const table of tables) {
    if (table.name !== baseTable && !table.name.startsWith(toolPrefix)) continue;
    if (names.has(table.name)) throw new BrowserTrustPolicyError("schema_drift");
    names.add(table.name);
    const assignments = tableAssignments(text, table.name);
    if (
      table.name === baseTable
      && assignmentCount(text, table.name, "default_tools_approval_mode") > 1
    ) throw new BrowserTrustPolicyError("schema_drift");
    if (
      table.name.startsWith(toolPrefix)
      && (
        assignmentCount(text, table.name, "approval_mode") > 1
        || Object.keys(assignments).some((key) => key !== "approval_mode")
      )
    ) throw new BrowserTrustPolicyError("schema_drift");
  }
}

function parseTables(text) {
  const lines = splitLines(text);
  const tables = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(lines[index]);
    if (!match) continue;
    if (tables.length > 0) tables[tables.length - 1].end = index;
    tables.push({ name: match[1].trim(), start: index, end: lines.length });
  }
  return tables;
}

function tableCount(text, tableName) {
  return parseTables(text).filter((table) => table.name === tableName).length;
}

function tableAssignments(text, tableName) {
  const tables = parseTables(text).filter((table) => table.name === tableName);
  if (tables.length === 0) return {};
  if (tables.length !== 1) throw new BrowserTrustPolicyError("schema_drift");
  const lines = splitLines(text);
  const result = {};
  for (let index = tables[0].start + 1; index < tables[0].end; index += 1) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)(?:\s+#.*)?$/u.exec(lines[index]);
    if (!match) continue;
    if (Object.prototype.hasOwnProperty.call(result, match[1])) {
      throw new BrowserTrustPolicyError("schema_drift");
    }
    result[match[1]] = match[2].trim();
  }
  return result;
}

function assignmentCount(text, tableName, key) {
  const table = parseTables(text).find((entry) => entry.name === tableName);
  if (!table) return 0;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  return splitLines(text).slice(table.start + 1, table.end)
    .filter((line) => pattern.test(line)).length;
}

function setTableAssignment(text, tableName, key, rawValue) {
  const lines = splitLines(text);
  const tables = parseTables(text).filter((table) => table.name === tableName);
  if (tables.length !== 1) throw new BrowserTrustPolicyError("schema_drift");
  const table = tables[0];
  const pattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=.*?(\\s+#.*)?$`, "u");
  const matches = [];
  for (let index = table.start + 1; index < table.end; index += 1) {
    if (pattern.test(lines[index])) matches.push(index);
  }
  if (matches.length > 1) throw new BrowserTrustPolicyError("schema_drift");
  if (matches.length === 1) {
    const match = pattern.exec(lines[matches[0]]);
    lines[matches[0]] = `${match[1]}${key} = ${rawValue}${match[2] || ""}`;
  } else {
    lines.splice(table.end, 0, `${key} = ${rawValue}`);
  }
  return joinLines(lines, text);
}

function removeTableAssignment(text, tableName, key) {
  const lines = splitLines(text);
  const table = parseTables(text).find((entry) => entry.name === tableName);
  if (!table) return text;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "u");
  const indexes = [];
  for (let index = table.start + 1; index < table.end; index += 1) {
    if (pattern.test(lines[index])) indexes.push(index);
  }
  if (indexes.length > 1) throw new BrowserTrustPolicyError("schema_drift");
  if (indexes.length === 1) lines.splice(indexes[0], 1);
  return joinLines(lines, text);
}

function removeTablesByPrefix(text, prefix) {
  const lines = splitLines(text);
  const ranges = parseTables(text)
    .filter((table) => table.name.startsWith(prefix))
    .sort((left, right) => right.start - left.start);
  const seen = new Set();
  for (const table of ranges) {
    if (seen.has(table.name)) throw new BrowserTrustPolicyError("schema_drift");
    seen.add(table.name);
    lines.splice(table.start, table.end - table.start);
  }
  return joinLines(lines, text);
}

function extractTableBlocks(text, prefix) {
  const lines = splitLines(text);
  const tables = parseTables(text).filter((table) => table.name.startsWith(prefix));
  const seen = new Set();
  return tables.map((table) => {
    if (seen.has(table.name)) throw new BrowserTrustPolicyError("schema_drift");
    seen.add(table.name);
    return lines.slice(table.start, table.end).join("\n").replace(/\s+$/u, "");
  });
}

function topLevelAssignments(text, key) {
  const lines = splitLines(text);
  const firstTable = parseTables(text)[0]?.start ?? lines.length;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*?)(?:\\s+#.*)?$`, "u");
  const values = [];
  for (let index = 0; index < firstTable; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) values.push({ index, value: match[1].trim() });
  }
  return values;
}

function singleTopLevelValue(text, key) {
  const values = topLevelAssignments(text, key);
  if (values.length > 1) throw new BrowserTrustPolicyError("schema_drift");
  return values[0]?.value ?? null;
}

function setTopLevelAssignment(text, key, rawValue) {
  const lines = splitLines(text);
  const values = topLevelAssignments(text, key);
  if (values.length > 1) throw new BrowserTrustPolicyError("schema_drift");
  if (values.length === 1) {
    const pattern = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=.*?(\\s+#.*)?$`, "u");
    const match = pattern.exec(lines[values[0].index]);
    lines[values[0].index] = `${match[1]}${key} = ${rawValue}${match[2] || ""}`;
  } else {
    const firstTable = parseTables(text)[0]?.start ?? lines.length;
    lines.splice(firstTable, 0, `${key} = ${rawValue}`);
  }
  return joinLines(lines, text);
}

function removeTopLevelAssignment(text, key) {
  const lines = splitLines(text);
  const values = topLevelAssignments(text, key);
  if (values.length > 1) throw new BrowserTrustPolicyError("schema_drift");
  if (values.length === 1) lines.splice(values[0].index, 1);
  return joinLines(lines, text);
}

function splitLines(text) {
  const lines = String(text).split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function joinLines(lines, originalText) {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}${originalText.endsWith("\n") ? "\n" : ""}`;
}

function ensureFinalNewline(text) {
  return text.length === 0 ? "" : `${text.replace(/\s*$/u, "")}\n`;
}

function stringValue(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function booleanValue(raw) {
  return raw === "true" ? true : raw === "false" ? false : null;
}

function sourceFingerprintFor(sources) {
  return sha256(Buffer.from(JSON.stringify({
    configSha256: sources.config.sha256,
    configMode: sources.config.mode,
    browserExists: sources.browser.exists,
    browserSha256: sources.browser.sha256,
    browserMode: sources.browser.mode,
  })));
}

function privateSourceRecord(sources) {
  return {
    configSha256: sources.config.sha256,
    configMode: sources.config.mode,
    browserExists: sources.browser.exists,
    browserSha256: sources.browser.sha256,
    browserMode: sources.browser.mode,
  };
}

function receiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

function ensurePrivateDirectory(directory, context) {
  if (!context.fs.existsSync(directory)) {
    context.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stat = context.fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new BrowserTrustPolicyError("transaction_directory_unsafe");
  }
  context.fs.chmodSync(directory, 0o700);
}

function writePrivateFile(file, bytes, context, stage) {
  runHook(context, stage);
  const descriptor = context.fs.openSync(file, "wx", 0o600);
  try {
    context.fs.writeFileSync(descriptor, bytes);
    context.fs.fsyncSync(descriptor);
  } finally {
    context.fs.closeSync(descriptor);
  }
  context.fs.chmodSync(file, 0o600);
  fsyncDirectory(path.dirname(file), context);
}

function atomicReplace(file, bytes, mode, context, stage) {
  runHook(context, `${stage}.before-write`);
  context.fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.browser-trust-${context.randomUUID()}.tmp`,
  );
  let descriptor = null;
  try {
    descriptor = context.fs.openSync(temporary, "wx", mode);
    context.fs.writeFileSync(descriptor, bytes);
    runHook(context, `${stage}.before-fsync`);
    context.fs.fsyncSync(descriptor);
    context.fs.closeSync(descriptor);
    descriptor = null;
    context.fs.chmodSync(temporary, mode);
    runHook(context, `${stage}.before-rename`);
    context.fs.renameSync(temporary, file);
    fsyncDirectory(path.dirname(file), context);
  } catch (error) {
    if (descriptor !== null) {
      try { context.fs.closeSync(descriptor); } catch {}
    }
    try {
      if (context.fs.existsSync(temporary)) context.fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function fsyncDirectory(directory, context) {
  const descriptor = context.fs.openSync(directory, "r");
  try {
    context.fs.fsyncSync(descriptor);
  } finally {
    context.fs.closeSync(descriptor);
  }
}

function assertSourceUnchanged(file, expected, context, stage) {
  runHook(context, stage);
  const current = readSource(file, context, !expected.exists);
  if (
    current.exists !== expected.exists
    || current.mode !== expected.mode
    || current.sha256 !== expected.sha256
  ) throw new BrowserTrustPolicyError("source_stale");
}

function restoreExactSource(file, snapshot, context, stage) {
  if (!snapshot.exists) {
    if (context.fs.existsSync(file)) {
      runHook(context, `${stage}.before-unlink`);
      context.fs.unlinkSync(file);
      fsyncDirectory(path.dirname(file), context);
    }
    return;
  }
  atomicReplace(file, snapshot.bytes, snapshot.mode, context, stage);
}

function verifyAppliedSources(context, applied) {
  const config = readSource(context.configPath, context, false);
  const browser = readSource(context.browserConfigPath, context, false);
  if (
    config.sha256 !== applied.configSha256
    || config.mode !== applied.configMode
    || browser.sha256 !== applied.browserSha256
    || browser.mode !== applied.browserMode
  ) throw new BrowserTrustPolicyError("apply_verification_failed");
}

function readPrivateBackup(file, expectedSha256, context) {
  const stat = context.fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new BrowserTrustPolicyError("backup_unsafe");
  }
  const bytes = context.fs.readFileSync(file);
  if (sha256(bytes) !== expectedSha256) {
    throw new BrowserTrustPolicyError("backup_invalid");
  }
  return bytes;
}

function readReceipt(file, transactionId, context) {
  if (!context.fs.existsSync(file)) throw new BrowserTrustPolicyError("transaction_missing");
  const stat = context.fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new BrowserTrustPolicyError("receipt_unsafe");
  }
  let receipt;
  try {
    receipt = JSON.parse(context.fs.readFileSync(file, "utf8"));
  } catch {
    throw new BrowserTrustPolicyError("receipt_invalid");
  }
  if (
    receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION
    || receipt.transactionId !== transactionId
  ) throw new BrowserTrustPolicyError("receipt_invalid");
  return receipt;
}

function latestReceipt(context) {
  if (!context.fs.existsSync(context.transactionsDirectory)) return null;
  const stat = context.fs.lstatSync(context.transactionsDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) {
    throw new BrowserTrustPolicyError("transaction_directory_unsafe");
  }
  const receipts = context.fs.readdirSync(context.transactionsDirectory)
    .filter((name) => /^[A-Za-z0-9._~-]{8,256}\.receipt\.json$/u.test(name))
    .sort()
    .reverse();
  for (const name of receipts) {
    try {
      return readReceipt(
        path.join(context.transactionsDirectory, name),
        name.slice(0, -".receipt.json".length),
        context,
      );
    } catch {}
  }
  return null;
}

function findIdempotentApply(context, previewToken, sources) {
  if (!context.fs.existsSync(context.transactionsDirectory)) return null;
  for (const name of context.fs.readdirSync(context.transactionsDirectory)) {
    if (!name.endsWith(".receipt.json")) continue;
    const transactionId = name.slice(0, -".receipt.json".length);
    let receipt;
    try {
      receipt = readReceipt(path.join(context.transactionsDirectory, name), transactionId, context);
    } catch {
      continue;
    }
    if (
      receipt.status === "applied"
      && receipt.previewToken === previewToken
      && receipt.applied.configSha256 === sources.config.sha256
      && receipt.applied.browserSha256 === sources.browser.sha256
    ) return receipt;
  }
  return null;
}

function runHook(context, stage) {
  if (typeof context.hook === "function") context.hook(stage);
}

function requireOpaqueId(value, code) {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new BrowserTrustPolicyError(code);
  }
  return value;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

module.exports = {
  BrowserTrustPolicyError,
  CHROME_APPROVED_TOOLS,
  TRANSACTIONS_DIRECTORY,
  applyPolicyChange,
  createPolicyCommandInterface,
  previewPolicyChange,
  restorePolicyChange,
  statusPolicy,
  _internals: {
    collectIdentityEvidence,
    createProjectionPlan,
    defaultBrowserEvidence,
    defaultChromeEvidence,
    observeOwnedProjection,
    parseTables,
    projectBrowserConfig,
    projectMcpRoute,
    restoreBrowserOwned,
    restoreCodexOwned,
    safeTreeFingerprint,
  },
};
