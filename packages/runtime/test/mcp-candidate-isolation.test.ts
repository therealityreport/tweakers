import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MCP_CANDIDATE_CODEX_HOME_ENV,
  MCP_CANDIDATE_RECONCILIATION_ENV,
  readMcpSyncState,
  reconcileMcpConfig,
  resolveMcpRuntimePaths,
} from "../src/mcp-reconciliation";

const QUESTION_ONLY_APPROVAL_POLICY = "approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }";
const MAIN_SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("ordinary MCP paths preserve ~/.codex behavior and ignore CODEX_HOME without candidate opt-in", () => {
  withTempDir((root) => {
    const homeDirectory = join(root, "ordinary-home");
    const userRoot = join(root, "tweakers-user");
    mkdirSync(homeDirectory);
    mkdirSync(userRoot);

    const paths = resolveMcpRuntimePaths({
      userRoot,
      homeDirectory,
      env: { CODEX_HOME: join(userRoot, "ignored-without-opt-in") },
    });

    assert.deepEqual(paths, {
      codexHome: join(homeDirectory, ".codex"),
      configPath: join(homeDirectory, ".codex", "config.toml"),
      statePath: join(userRoot, "mcp-sync-state.json"),
      candidateIsolated: false,
    });
  });
});

test("opt-in candidate reconciliation migrates only its contained Codex config", () => {
  withTempDir((root) => {
    const homeDirectory = join(root, "ordinary-home");
    const realCodexHome = join(homeDirectory, ".codex");
    const realConfigPath = join(realCodexHome, "config.toml");
    const userRoot = join(root, "candidate-user");
    const candidateCodexHome = join(userRoot, "codex-home");
    mkdirSync(realCodexHome, { recursive: true });
    mkdirSync(userRoot);
    writeFileSync(realConfigPath, "# live config must stay byte-identical\n", { mode: 0o640 });
    const liveBefore = readFileSync(realConfigPath);

    const paths = resolveMcpRuntimePaths({
      userRoot,
      homeDirectory,
      env: {
        [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
        [MCP_CANDIDATE_CODEX_HOME_ENV]: candidateCodexHome,
      },
    });
    mkdirSync(candidateCodexHome);

    const tweakId = "co.tweakers.user-questions";
    const tweakDir = join(userRoot, "tweaks", tweakId);
    const serverPath = join(tweakDir, "mcp-server.js");
    const dataDir = join(userRoot, "tweak-data", tweakId);
    mkdirSync(tweakDir, { recursive: true });
    writeFileSync(serverPath, "");
    const unrelatedPrefix = [
      QUESTION_ONLY_APPROVAL_POLICY,
      'sandbox_mode = "danger-full-access"',
      "# unrelated candidate bytes",
      "[unrelated]",
      'value = "preserve exactly"',
      "",
    ].join("\n");
    const legacy = [
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      `env = { TWEAKER_TWEAK_DATA_DIR = ${JSON.stringify(dataDir)}, TWEAKER_TWEAK_ID = ${JSON.stringify(tweakId)} }`,
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n");
    writeFileSync(paths.configPath, `${unrelatedPrefix}${legacy}`, { mode: 0o640 });
    chmodSync(paths.configPath, 0o640);

    const tweak = {
      dir: tweakDir,
      dataDir,
      manifest: {
        id: tweakId,
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    };
    const receipt = reconcileMcpConfig({
      configPath: paths.configPath,
      statePath: paths.statePath,
      tweaks: [tweak],
      ownedTweaks: [tweak],
      trigger: "startup",
    });

    const candidateAfter = readFileSync(paths.configPath, "utf8");
    assert.equal(paths.candidateIsolated, true);
    assert.equal(paths.codexHome, candidateCodexHome);
    assert.equal(receipt.status, "updated");
    assert.deepEqual(receipt.migrations, [{
      from: "co-thomashulihan-user-questions",
      to: "co-tweakers-user-questions",
    }]);
    assert.ok(candidateAfter.startsWith(unrelatedPrefix));
    assert.equal(countMatches(candidateAfter, /\[mcp_servers\.co-tweakers-user-questions\]/g), 1);
    assert.doesNotMatch(candidateAfter, /co-tweakers-user-questions-2/);
    assert.doesNotMatch(candidateAfter, /co-thomashulihan-user-questions/);
    assert.match(candidateAfter, new RegExp(`TWEAKER_TWEAK_DATA_DIR = ${escapeRegExp(JSON.stringify(dataDir))}`));
    assert.deepEqual(readFileSync(realConfigPath), liveBefore);
    assert.equal(statSync(paths.configPath).mode & 0o777, 0o640);
    assert.equal(statSync(paths.statePath).mode & 0o777, 0o600);
    assert.deepEqual(readMcpSyncState(paths.statePath), receipt);
  });
});

test("candidate path contract fails closed without exact, contained opt-in paths", () => {
  withTempDir((root) => {
    const homeDirectory = join(root, "ordinary-home");
    const userRoot = join(root, "candidate-user");
    const candidateCodexHome = join(userRoot, "codex-home");
    mkdirSync(homeDirectory);
    mkdirSync(userRoot);
    const resolveCandidate = (env: Record<string, string | undefined>) => resolveMcpRuntimePaths({
      userRoot,
      homeDirectory,
      env,
    });

    assert.throws(() => resolveCandidate({
      [MCP_CANDIDATE_RECONCILIATION_ENV]: "true",
      [MCP_CANDIDATE_CODEX_HOME_ENV]: candidateCodexHome,
    }), /must be exactly 1/);
    assert.throws(() => resolveCandidate({
      [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
    }), /CODEX_HOME is required/);
    assert.throws(() => resolveCandidate({
      [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
      [MCP_CANDIDATE_CODEX_HOME_ENV]: "relative/codex-home",
    }), /normalized absolute path/);
    assert.throws(() => resolveCandidate({
      [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
      [MCP_CANDIDATE_CODEX_HOME_ENV]: `${userRoot}/nested/../codex-home`,
    }), /normalized absolute path/);
    assert.throws(() => resolveCandidate({
      [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
      [MCP_CANDIDATE_CODEX_HOME_ENV]: join(root, "outside-candidate-root"),
    }), /contained under/);
  });
});

test("candidate path contract rejects symlinked homes, configs, receipts, and real ~/.codex aliases", () => {
  withTempDir((root) => {
    const homeDirectory = join(root, "ordinary-home");
    const realCodexHome = join(homeDirectory, ".codex");
    const userRoot = join(root, "candidate-user");
    mkdirSync(realCodexHome, { recursive: true });
    mkdirSync(userRoot);
    const resolveCandidate = (candidateCodexHome: string) => resolveMcpRuntimePaths({
      userRoot,
      homeDirectory,
      env: {
        [MCP_CANDIDATE_RECONCILIATION_ENV]: "1",
        [MCP_CANDIDATE_CODEX_HOME_ENV]: candidateCodexHome,
      },
    });

    const realAlias = join(userRoot, "real-codex-alias");
    symlinkSync(realCodexHome, realAlias);
    assert.throws(() => resolveCandidate(realAlias), /symbolic-link/);

    const hardLinkHome = join(userRoot, "hard-link-home");
    mkdirSync(hardLinkHome);
    const realConfigPath = join(realCodexHome, "config.toml");
    writeFileSync(realConfigPath, "# real config\n");
    linkSync(realConfigPath, join(hardLinkHome, "config.toml"));
    assert.throws(() => resolveCandidate(hardLinkHome), /Candidate Codex config.*hard-linked/);

    const configLinkHome = join(userRoot, "config-link-home");
    mkdirSync(configLinkHome);
    const configTarget = join(userRoot, "config-target.toml");
    writeFileSync(configTarget, "");
    symlinkSync(configTarget, join(configLinkHome, "config.toml"));
    assert.throws(() => resolveCandidate(configLinkHome), /Candidate Codex config.*symbolic-link/);

    rmSync(join(configLinkHome, "config.toml"));
    const receiptTarget = join(userRoot, "receipt-target.json");
    writeFileSync(receiptTarget, "{}\n");
    symlinkSync(receiptTarget, join(userRoot, "mcp-sync-state.json"));
    assert.throws(() => resolveCandidate(configLinkHome), /Candidate MCP receipt.*symbolic-link/);
  });
});

test("main routes startup, enable, reload, config-watch, manual repair, and close through one reconciler", () => {
  assert.match(MAIN_SOURCE, /const MCP_RUNTIME_PATHS = resolveMcpRuntimePaths\(\{/);
  assert.match(MAIN_SOURCE, /configPath: CODEX_CONFIG_FILE/);
  assert.match(MAIN_SOURCE, /statePath: MCP_SYNC_STATE_FILE/);
  assert.match(MAIN_SOURCE, /getTweaks: \(\) => mcpSyncTweaks\(true\)/);
  assert.match(MAIN_SOURCE, /dataDir: join\(userRoot!, "tweak-data", tweak\.manifest\.id\)/);
  assert.match(MAIN_SOURCE, /initialMcpReconciliationPending[\s\S]*?\? "startup"[\s\S]*?: nextReloadMcpTrigger/);
  assert.match(MAIN_SOURCE, /reloading tweaks \(enabled-toggle\)[\s\S]*?"enabled-state"/);
  assert.match(MAIN_SOURCE, /nextReloadMcpTrigger = "tweak-reload"/);
  assert.match(MAIN_SOURCE, /reconcileNow\(mcpTrigger\)/);
  assert.match(MAIN_SOURCE, /reconcileNow\("manual-repair"\)/);
  assert.match(MAIN_SOURCE, /const mcpReconciler = healthCheckOnly \? null : createMcpReconciler/);
  assert.match(MAIN_SOURCE, /mcpReconciler\?\.close\(\)/);
  assert.doesNotMatch(MAIN_SOURCE, /syncManagedMcpServers\(/);
});

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withTempDir(run: (root: string) => void): void {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-mcp-candidate-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
