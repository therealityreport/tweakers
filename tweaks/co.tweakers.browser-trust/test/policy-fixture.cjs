"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME_WRAPPER_SHA256 = "9409efb9607f52d38ed182e35a63318e03a623fdaf7e4aedd72127a7e8b74000";
const CHROME_TREE_SHA256 = "5e8e57f0be38140176f64e275de129930efbbc8016364b592f6e5b4c6825be6e";
const BROWSER_CLIENT_SHA256 = "e13fd947e846d3d306e9249dd3c73d14931b6494803dbafb16cef85e6add9506";
const REVIEWED_BROWSER_CLIENT_SHA256S = [
  "6d25aa7656feac858f3a3bdaea5bcbab0dbfd426c9de8e6931ce90c399ee8e4f",
  BROWSER_CLIENT_SHA256,
];
const PRIVATE_SENTINELS = {
  taskId: "task-private-019fa8a7",
  questionText: "Which private browser page should I open?",
  browserContent: "Secret account dashboard text",
  url: "https://private.example.test/account?token=credential",
  credential: "Bearer credential-private-123",
  toolArguments: "{\"url\":\"https://private.example.test\",\"password\":\"secret\"}",
};

function makePolicyFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-trust-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "codex", "config.toml");
  const browserConfigPath = path.join(root, "codex", "browser", "config.toml");
  const dataDir = path.join(root, "tweak-data", "co.tweakers.browser-trust");
  fs.mkdirSync(path.dirname(browserConfigPath), { recursive: true, mode: 0o700 });
  const configText = options.configText ?? codexConfig(options);
  const browserText = options.browserText ?? browserConfig(options);
  fs.writeFileSync(configPath, configText, { mode: options.configMode ?? 0o640 });
  fs.writeFileSync(browserConfigPath, browserText, { mode: options.browserMode ?? 0o600 });
  return {
    root,
    configPath,
    browserConfigPath,
    dataDir,
    configText,
    browserText,
    identityEvidence: validIdentityEvidence(),
  };
}

function codexConfig(options = {}) {
  const userQuestionsPolicy = options.userQuestionsPolicy === "missing"
    ? 'approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false } }'
    : options.userQuestionsPolicy === "false"
      ? 'approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = false } }'
      : 'approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }';
  const chromeVersion = options.chromeVersion ?? "1.6.0";
  const chromeMode = options.chromeMode ?? "shared";
  const chromeHeadless = options.chromeHeadless ?? "1";
  const chromeAutoLaunch = options.chromeAutoLaunch ?? "1";
  const seedProfile = options.seedProfile ?? "/test-home/.chrome-profiles/openai-agent";
  const liveProfile = options.liveProfile ?? "/test-home/.chrome-profiles/openai-agent-devtools";
  const trustedHashes = options.trustedHashes ?? REVIEWED_BROWSER_CLIENT_SHA256S.join(",");
  const appVersion = options.appVersion ?? "26.721.41059";
  const browserPluginEnabled = options.browserPluginEnabled ?? true;
  return [
    "# Browser Trust test fixture. Preserve this comment exactly.",
    'model = "gpt-test-only"',
    userQuestionsPolicy,
    `private_task_note = ${JSON.stringify(PRIVATE_SENTINELS.taskId)}`,
    `private_question_note = ${JSON.stringify(PRIVATE_SENTINELS.questionText)}`,
    `private_browser_note = ${JSON.stringify(PRIVATE_SENTINELS.browserContent)}`,
    `private_url_note = ${JSON.stringify(PRIVATE_SENTINELS.url)}`,
    `private_credential_note = ${JSON.stringify(PRIVATE_SENTINELS.credential)}`,
    `private_tool_arguments_note = ${JSON.stringify(PRIVATE_SENTINELS.toolArguments)}`,
    "",
    "[mcp_servers.chrome-devtools]",
    'command = "/test-home/.codex/bin/codex-chrome-devtools-mcp-global.sh"',
    "enabled = true",
    'default_tools_approval_mode = "approve"',
    "startup_timeout_sec = 45",
    "tool_timeout_sec = 120",
    "",
    "[mcp_servers.chrome-devtools.env]",
    `CODEX_CHROME_MCP_VERSION = ${JSON.stringify(chromeVersion)}`,
    `CODEX_CHROME_MODE = ${JSON.stringify(chromeMode)}`,
    `CODEX_CHROME_HEADLESS = ${JSON.stringify(chromeHeadless)}`,
    `CODEX_CHROME_AUTO_LAUNCH = ${JSON.stringify(chromeAutoLaunch)}`,
    `CODEX_CHROME_SEED_PROFILE_DIR = ${JSON.stringify(seedProfile)}`,
    `CODEX_CHROME_PROFILE_DIR = ${JSON.stringify(liveProfile)}`,
    "",
    "[mcp_servers.chrome-devtools.tools.navigate_page]",
    'approval_mode = "approve"',
    "",
    "[mcp_servers.chrome-devtools.tools.list_pages]",
    'approval_mode = "prompt"',
    "",
    "[mcp_servers.node_repl]",
    'command = "/test-app/cua_node/bin/node_repl"',
    "",
    "[mcp_servers.node_repl.env]",
    `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = ${JSON.stringify(trustedHashes)}`,
    `BROWSER_USE_CODEX_APP_VERSION = ${JSON.stringify(appVersion)}`,
    "",
    '[plugins."browser@openai-bundled"]',
    `enabled = ${browserPluginEnabled}`,
    "",
    '[plugins."infographic-docs@local-plugins".mcp_servers.infographic-preview-playwright]',
    'default_tools_approval_mode = "approve"',
    "",
    '[plugins."infographic-docs@local-plugins".mcp_servers.infographic-preview-playwright.tools.browser_navigate]',
    'approval_mode = "approve"',
    "",
    '[plugins."infographic-docs@local-plugins".mcp_servers.infographic-preview-playwright.tools.browser_snapshot]',
    'approval_mode = "approve"',
    "",
    "[unrelated.keep_me]",
    'value = "unchanged"',
    "# Preserve this final comment and newline.",
    "",
  ].join("\n");
}

function browserConfig(options = {}) {
  const origins = options.origins ?? [
    "https://github.com",
    "https://thb.localhost",
    "https://admin.thb.localhost",
  ];
  return [
    "# Browser plugin test fixture. Preserve this comment exactly.",
    'approval_mode = "never_ask"',
    'download_approval_mode = "never_ask"',
    "full_cdp_access_enabled = true",
    'history_approval_mode = "never_ask"',
    'upload_approval_mode = "never_ask"',
    'unrelated_browser_setting = "unchanged"',
    `private_browser_note = ${JSON.stringify(PRIVATE_SENTINELS.browserContent)}`,
    "",
    "[full_cdp]",
    "allowed = [",
    ...origins.map((origin) => `    ${JSON.stringify(origin)},`),
    "]",
    "",
    "[unrelated.keep_me]",
    'value = "unchanged"',
    "# Preserve this final browser comment and newline.",
    "",
  ].join("\n");
}

function validIdentityEvidence(overrides = {}) {
  return {
    chromeDevtools: {
      wrapperSha256: CHROME_WRAPPER_SHA256,
      packageVersion: "1.6.0",
      packageTreeFingerprint: CHROME_TREE_SHA256,
      chromeMode: "shared",
      headless: "1",
      autoLaunch: "1",
      seedProfile: "/test-home/.chrome-profiles/openai-agent",
      liveProfile: "/test-home/.chrome-profiles/openai-agent-devtools",
      ...overrides.chromeDevtools,
    },
    browser: {
      pluginEnabled: true,
      appVersion: "26.721.41059",
      clientSha256: BROWSER_CLIENT_SHA256,
      trustedClientSha256s: [...REVIEWED_BROWSER_CLIENT_SHA256S],
      ...overrides.browser,
    },
  };
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) return {};
  const result = {};
  const visit = (current) => {
    const relative = path.relative(root, current) || ".";
    const stat = fs.lstatSync(current);
    result[relative] = {
      type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      mode: stat.mode & 0o777,
      bytes: stat.isFile() ? fs.readFileSync(current).toString("base64") : null,
    };
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    }
  };
  visit(root);
  return result;
}

function replaceLine(source, pattern, replacement) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`fixture line not found: ${pattern}`);
  return next;
}

module.exports = {
  BROWSER_CLIENT_SHA256,
  CHROME_TREE_SHA256,
  CHROME_WRAPPER_SHA256,
  PRIVATE_SENTINELS,
  REVIEWED_BROWSER_CLIENT_SHA256S,
  browserConfig,
  codexConfig,
  makePolicyFixture,
  replaceLine,
  snapshotTree,
  validIdentityEvidence,
};
