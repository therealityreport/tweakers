import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildManagedMcpBlock,
  MCP_MANAGED_END,
  MCP_MANAGED_START,
  mcpServerNameFromTweakId,
  planManagedMcpReconciliation,
  syncManagedMcpServers,
  RESERVED_MANAGED_MCP_ENV_KEYS,
} from "../src/mcp-sync";

const MALFORMED_TOML_FIXTURE = [
  'model = "gpt-5.6"',
  "",
  "[unrelated.manual.settings]",
  'label = "unterminated',
  "",
].join("\n");

test("mcpServerNameFromTweakId preserves the full publisher namespace", () => {
  assert.equal(mcpServerNameFromTweakId("co.tweakers.user-questions"), "co-tweakers-user-questions");
  assert.equal(mcpServerNameFromTweakId("co.bennett.project-home"), "co-bennett-project-home");
  assert.equal(mcpServerNameFromTweakId("com.example.my-widget"), "com-example-my-widget");
});

test("buildManagedMcpBlock creates TOML entries and resolves local server scripts", () => {
  withTempDir((root) => {
    const tweakDir = join(root, "co.bennett.native-widgets");
    mkdirSync(tweakDir, { recursive: true });
    writeFileSync(join(tweakDir, "mcp-server.js"), "");

    const built = buildManagedMcpBlock([
      {
        dir: tweakDir,
        manifest: {
          id: "co.bennett.native-widgets",
          mcp: {
            command: "node",
            args: ["mcp-server.js"],
            env: { WIDGETS: "1" },
          },
        },
      },
    ]);

    assert.deepEqual(built.serverNames, ["co-bennett-native-widgets"]);
    assert.equal(built.skippedServerNames.length, 0);
    assert.match(built.block, /\[mcp_servers\.co-bennett-native-widgets\]/);
    assert.match(built.block, /command = "node"/);
    assert.match(built.block, new RegExp(`args = \\["${escapeRegExp(join(tweakDir, "mcp-server.js"))}"\\]`));
    assert.match(built.block, /env = \{ WIDGETS = "1", TWEAKER_TWEAK_DATA_DIR = .*TWEAKER_TWEAK_ID = "co\.bennett\.native-widgets" \}/);
  });
});

test("managed MCP formatting injects reserved tweak identity and data directory without mutating manifests", () => {
  withTempDir((root) => {
    const tweakDir = join(root, "tweaks", "co.tweakers.example");
    mkdirSync(tweakDir, { recursive: true });
    const mcp = { command: "node", env: { DECLARED: "kept" } };
    const built = buildManagedMcpBlock([{
      dir: tweakDir,
      manifest: { id: "co.tweakers.example", mcp },
    }]);
    const expectedDataDir = resolve(tweakDir, "..", "..", "tweak-data", "co.tweakers.example");
    assert.match(built.block, /DECLARED = "kept"/);
    assert.match(built.block, new RegExp(`TWEAKER_TWEAK_DATA_DIR = "${escapeRegExp(expectedDataDir)}"`));
    assert.match(built.block, /TWEAKER_TWEAK_ID = "co\.tweakers\.example"/);
    assert.deepEqual(mcp.env, { DECLARED: "kept" });
    assert.deepEqual(RESERVED_MANAGED_MCP_ENV_KEYS, ["TWEAKER_TWEAK_DATA_DIR", "TWEAKER_TWEAK_ID"]);
  });
});

test("managed MCP formatting rejects manifest overrides of reserved environment variables", () => {
  for (const reserved of RESERVED_MANAGED_MCP_ENV_KEYS) {
    assert.throws(() => buildManagedMcpBlock([{
      dir: "/tmp/tweaks/co.tweakers.example",
      manifest: {
        id: "co.tweakers.example",
        mcp: { command: "node", env: { [reserved]: "override" } },
      },
    }]), new RegExp(`${reserved}.*reserved`, "i"));
  }
});

test("exact legacy ownership comparison ignores only correct runtime-reserved injection", () => {
  withTempDir((root) => {
    const tweakDir = join(root, "tweaks", "co.tweakers.user-questions");
    mkdirSync(tweakDir, { recursive: true });
    writeFileSync(join(tweakDir, "mcp-server.js"), "");
    const dataDir = resolve(tweakDir, "..", "..", "tweak-data", "co.tweakers.user-questions");
    const exactLegacy = [
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(join(tweakDir, "mcp-server.js"))}]`,
      `env = { TWEAKER_TWEAK_DATA_DIR = ${JSON.stringify(dataDir)}, TWEAKER_TWEAK_ID = "co.tweakers.user-questions" }`,
      "",
    ].join("\n");
    const tweak = {
      dir: tweakDir,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    };
    const migrated = planManagedMcpReconciliation([tweak], exactLegacy);
    assert.deepEqual(migrated.conflicts, []);
    assert.deepEqual(migrated.migrations, [{
      from: "co-thomashulihan-user-questions",
      to: "co-tweakers-user-questions",
    }]);

    const tampered = exactLegacy.replace(dataDir, `${dataDir}-tampered`);
    const rejected = planManagedMcpReconciliation([tweak], tampered);
    assert.deepEqual(rejected.conflicts, [{
      observedName: "co-thomashulihan-user-questions",
      canonicalName: "co-tweakers-user-questions",
      reason: "legacy-shape-mismatch",
    }]);
  });
});

test("buildManagedMcpBlock skips user-managed server names", () => {
  withTempDir((root) => {
    const built = buildManagedMcpBlock(
      [
        {
          dir: root,
          manifest: {
            id: "co.bennett.project-home",
            mcp: { command: "node", args: ["server.js"] },
          },
        },
      ],
      `[mcp_servers.co-bennett-project-home]\ncommand = "node"\n`,
    );

    assert.equal(built.block, "");
    assert.deepEqual(built.serverNames, []);
    assert.deepEqual(built.skippedServerNames, ["co-bennett-project-home"]);
  });
});

test("planManagedMcpReconciliation migrates an exactly owned legacy server", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const current = [
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "",
    ].join("\n");

    const plan = planManagedMcpReconciliation([
      {
        dir: root,
        manifest: {
          id: "co.tweakers.user-questions",
          mcp: { command: "node", args: ["mcp-server.js"] },
        },
      },
    ], current);

    assert.equal(plan.changed, true);
    assert.equal(plan.restartRequired, true);
    assert.deepEqual(plan.migrations, [{
      from: "co-thomashulihan-user-questions",
      to: "co-tweakers-user-questions",
    }]);
    assert.deepEqual(plan.conflicts, []);
    assert.doesNotMatch(plan.nextToml, /co-thomashulihan-user-questions/);
    assert.equal(plan.nextToml.match(/\[mcp_servers\.co-tweakers-user-questions\]/g)?.length, 1);
  });
});

test("planManagedMcpReconciliation applies the legacy rule generically", () => {
  withTempDir((root) => {
    const serverPath = join(root, "example-server.js");
    writeFileSync(serverPath, "");
    const current = [
      "[mcp_servers.co-thomashulihan-example]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "",
    ].join("\n");

    const plan = planManagedMcpReconciliation([{
      dir: root,
      manifest: {
        id: "co.tweakers.example",
        mcp: { command: "node", args: ["example-server.js"] },
      },
    }], current);

    assert.deepEqual(plan.migrations, [{
      from: "co-thomashulihan-example",
      to: "co-tweakers-example",
    }]);
    assert.match(plan.nextToml, /\[mcp_servers\.co-tweakers-example\]/);
  });
});

test("planManagedMcpReconciliation preserves unrelated manual MCP entries byte-for-byte", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const unrelated = [
      "# personal account routing",
      "",
      "",
      "[mcp_servers.co-thomashulihan-github-accounts]",
      'command = "/opt/homebrew/bin/github-accounts"',
      'args = ["--keep-this-formatting"]',
      "",
    ].join("\n");
    const current = `${unrelated}[mcp_servers.co-thomashulihan-user-questions]\ncommand = "node"\nargs = [${JSON.stringify(serverPath)}]\n`;

    const plan = planManagedMcpReconciliation([{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }], current);

    assert.equal(plan.nextToml.startsWith(unrelated), true);
    assert.equal(plan.nextToml.includes("co-thomashulihan-github-accounts"), true);
  });
});

test("planManagedMcpReconciliation preserves trailing comments before a manual MCP table", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const personalComment = "# personal server below — keep this note";
    const current = [
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "",
      personalComment,
      "[mcp_servers.personal]",
      'command = "manual"',
      "",
    ].join("\n");

    const plan = planManagedMcpReconciliation([{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }], current);

    assert.match(plan.nextToml, new RegExp(`${escapeRegExp(personalComment)}\\n\\[mcp_servers\\.personal\\]`));
    assert.match(plan.nextToml, /\[mcp_servers\.co-tweakers-user-questions\]/);
    assert.doesNotMatch(plan.nextToml, /mcp_servers\.co-thomashulihan-user-questions/);
  });
});

test("planManagedMcpReconciliation suppresses canonical insertion for mismatched legacy ownership", () => {
  const current = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    'args = ["/somewhere/else/mcp-server.js"]',
    "",
  ].join("\n");
  const plan = planManagedMcpReconciliation([{
    dir: "/expected/tweaks/user-questions",
    manifest: {
      id: "co.tweakers.user-questions",
      mcp: { command: "node", args: ["./mcp-server.js"] },
    },
  }], current);

  assert.equal(plan.nextToml, current);
  assert.deepEqual(plan.appliedNames, []);
  assert.deepEqual(plan.conflicts, [{
    observedName: "co-thomashulihan-user-questions",
    canonicalName: "co-tweakers-user-questions",
    reason: "legacy-shape-mismatch",
  }]);
  assert.doesNotMatch(plan.nextToml, /mcp_servers\.co-tweakers-user-questions/);
});

test("planManagedMcpReconciliation adopts an exact manual canonical entry idempotently", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const current = [
      "[mcp_servers.co-tweakers-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      `env = { TWEAKER_TWEAK_DATA_DIR = ${JSON.stringify(resolve(root, "..", "..", "tweak-data", "co.tweakers.user-questions"))}, TWEAKER_TWEAK_ID = "co.tweakers.user-questions" }`,
      "",
    ].join("\n");
    const tweaks = [{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }];

    const adopted = planManagedMcpReconciliation(tweaks, current);

    assert.equal(adopted.changed, true);
    assert.deepEqual(adopted.appliedNames, ["co-tweakers-user-questions"]);
    assert.deepEqual(adopted.conflicts, []);
    assert.equal(adopted.nextToml.match(/\[mcp_servers\.co-tweakers-user-questions\]/g)?.length, 1);
    assert.match(adopted.nextToml, new RegExp(escapeRegExp(MCP_MANAGED_START)));

    const repeated = planManagedMcpReconciliation(tweaks, adopted.nextToml);

    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.appliedNames, ["co-tweakers-user-questions"]);
    assert.deepEqual(repeated.conflicts, []);
    assert.equal(repeated.nextToml, adopted.nextToml);
  });
});

test("exact canonical adoption keeps the user's approval policy byte-stable and idempotent", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const current = [
      'approval_policy = "never" # user-owned exact bytes',
      "",
      "[mcp_servers.co-tweakers-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      `env = { TWEAKER_TWEAK_DATA_DIR = ${JSON.stringify(resolve(root, "..", "..", "tweak-data", "co.tweakers.user-questions"))}, TWEAKER_TWEAK_ID = "co.tweakers.user-questions" }`,
      "",
    ].join("\n");
    const tweaks = [{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }];

    const adopted = planManagedMcpReconciliation(tweaks, current);
    assert.ok(adopted.nextToml.indexOf('approval_policy = "never" # user-owned exact bytes') >= 0);
    assert.ok(adopted.nextToml.indexOf('approval_policy = "never" # user-owned exact bytes') < adopted.nextToml.indexOf(MCP_MANAGED_START));

    const repeatedMcp = planManagedMcpReconciliation(tweaks, adopted.nextToml);

    assert.equal(repeatedMcp.changed, false);
    assert.equal(repeatedMcp.nextToml, adopted.nextToml);
  });
});

test("planManagedMcpReconciliation preserves a manual canonical collision without duplicating it", () => {
  const current = '[mcp_servers.co-tweakers-user-questions]\ncommand = "manual"\n';
  const plan = planManagedMcpReconciliation([{
    dir: "/expected/tweaks/user-questions",
    manifest: {
      id: "co.tweakers.user-questions",
      mcp: { command: "node" },
    },
  }], current);

  assert.equal(plan.nextToml, current);
  assert.deepEqual(plan.conflicts, [{
    observedName: "co-tweakers-user-questions",
    canonicalName: "co-tweakers-user-questions",
    reason: "canonical-collision",
  }]);
  assert.equal(plan.nextToml.match(/\[mcp_servers\.co-tweakers-user-questions\]/g)?.length, 1);
});

test("planManagedMcpReconciliation recognizes a single-quoted canonical collision", () => {
  const current = "[mcp_servers.'co-tweakers-user-questions']\ncommand = \"manual\"\n";
  const plan = planManagedMcpReconciliation([{
    dir: "/expected/tweaks/user-questions",
    manifest: {
      id: "co.tweakers.user-questions",
      mcp: { command: "node" },
    },
  }], current);

  assert.equal(plan.nextToml, current);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.conflicts, [{
    observedName: "co-tweakers-user-questions",
    canonicalName: "co-tweakers-user-questions",
    reason: "canonical-collision",
  }]);
  assert.doesNotMatch(plan.nextToml, /\[mcp_servers\.co-tweakers-user-questions\]/);
});

test("planManagedMcpReconciliation cleans an exactly owned legacy table despite a canonical collision", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const canonical = '[mcp_servers.co-tweakers-user-questions]\ncommand = "manual"\n';
    const current = [
      canonical.trimEnd(),
      "",
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "",
    ].join("\n");

    const plan = planManagedMcpReconciliation([{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }], current);

    assert.equal(plan.changed, true);
    assert.equal(plan.restartRequired, true);
    assert.deepEqual(plan.appliedNames, []);
    assert.deepEqual(plan.migrations, [{
      from: "co-thomashulihan-user-questions",
      to: "co-tweakers-user-questions",
    }]);
    assert.deepEqual(plan.conflicts, [{
      observedName: "co-tweakers-user-questions",
      canonicalName: "co-tweakers-user-questions",
      reason: "canonical-collision",
    }]);
    assert.equal(plan.nextToml, canonical);
    assert.doesNotMatch(plan.nextToml, /co-thomashulihan/);
  });
});

test("planManagedMcpReconciliation migrates the exact live legacy shape and preserves approval policy", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const current = [
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n");
    const tweaks = [{
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    }];

    const plan = planManagedMcpReconciliation(tweaks, current);

    assert.equal(plan.changed, true);
    assert.deepEqual(plan.migrations, [{
      from: "co-thomashulihan-user-questions",
      to: "co-tweakers-user-questions",
    }]);
    assert.match(plan.nextToml, /\[mcp_servers\.co-tweakers-user-questions\]/);
    assert.match(plan.nextToml, /default_tools_approval_mode = "approve"/);
    assert.doesNotMatch(plan.nextToml, /co-thomashulihan/);

    const repeated = planManagedMcpReconciliation(tweaks, plan.nextToml);
    assert.equal(repeated.changed, false);
    assert.deepEqual(repeated.conflicts, []);
    assert.equal(repeated.nextToml, plan.nextToml);
    assert.equal(repeated.nextToml.match(/default_tools_approval_mode = "approve"/g)?.length, 1);
  });
});

test("planManagedMcpReconciliation fails closed for ambiguous or extended legacy tables", () => {
  const tweak = {
    dir: "/expected/tweaks/user-questions",
    manifest: {
      id: "co.tweakers.user-questions",
      mcp: { command: "node" },
    },
  };
  const ambiguous = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    "",
  ].join("\n");
  const disabled = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    "enabled = false",
    "",
  ].join("\n");
  const extended = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    'metadata = "external"',
    "",
  ].join("\n");
  const unsupportedApproval = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    'default_tools_approval_mode = "prompt"',
    "",
  ].join("\n");
  const nested = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "node"',
    "[mcp_servers.co-thomashulihan-user-questions.env]",
    'TOKEN = "external"',
    "",
  ].join("\n");

  const ambiguousPlan = planManagedMcpReconciliation([tweak], ambiguous);
  const disabledPlan = planManagedMcpReconciliation([tweak], disabled);
  const extendedPlan = planManagedMcpReconciliation([tweak], extended);
  const unsupportedApprovalPlan = planManagedMcpReconciliation([tweak], unsupportedApproval);
  const nestedPlan = planManagedMcpReconciliation([tweak], nested);

  assert.equal(ambiguousPlan.nextToml, ambiguous);
  assert.equal(ambiguousPlan.conflicts[0]?.reason, "ambiguous-legacy");
  assert.equal(disabledPlan.nextToml, disabled);
  assert.equal(disabledPlan.conflicts[0]?.reason, "legacy-shape-mismatch");
  assert.equal(extendedPlan.nextToml, extended);
  assert.equal(extendedPlan.conflicts[0]?.reason, "legacy-shape-mismatch");
  assert.equal(unsupportedApprovalPlan.nextToml, unsupportedApproval);
  assert.equal(unsupportedApprovalPlan.conflicts[0]?.reason, "legacy-shape-mismatch");
  assert.equal(nestedPlan.nextToml, nested);
  assert.equal(nestedPlan.conflicts[0]?.reason, "legacy-shape-mismatch");
});

test("planManagedMcpReconciliation removes only the owned managed block when disabled", () => {
  const manual = '[mcp_servers.co-thomashulihan-github-accounts]\ncommand = "manual"\n';
  const managed = [
    MCP_MANAGED_START,
    "[mcp_servers.co-tweakers-user-questions]",
    'command = "node"',
    MCP_MANAGED_END,
    "",
  ].join("\n");

  const plan = planManagedMcpReconciliation([], `${manual}\n${managed}`);

  assert.equal(plan.changed, true);
  assert.equal(plan.restartRequired, true);
  assert.equal(plan.nextToml, manual);
});

test("owned and desired MCP sets suspend and restore an exact legacy server with policy", () => {
  withTempDir((root) => {
    const serverPath = join(root, "mcp-server.js");
    writeFileSync(serverPath, "");
    const tweak = {
      dir: root,
      manifest: {
        id: "co.tweakers.user-questions",
        mcp: { command: "node", args: ["mcp-server.js"] },
      },
    };
    const unrelated = '[mcp_servers.external]\ncommand = "external"\n';
    const current = [
      unrelated.trimEnd(),
      "",
      "[mcp_servers.co-thomashulihan-user-questions]",
      'command = "node"',
      `args = [${JSON.stringify(serverPath)}]`,
      "enabled = true",
      'default_tools_approval_mode = "approve"',
      "",
    ].join("\n");

    const suspended = planManagedMcpReconciliation([], current, { ownedTweaks: [tweak] });

    assert.equal(suspended.changed, true);
    assert.deepEqual(suspended.desiredNames, []);
    assert.deepEqual(suspended.appliedNames, []);
    assert.equal(suspended.nextToml, unrelated);
    assert.deepEqual(suspended.preservedOptions, {
      "co-tweakers-user-questions": { defaultToolsApprovalMode: "approve" },
    });

    const restored = planManagedMcpReconciliation([tweak], suspended.nextToml, {
      ownedTweaks: [tweak],
      preservedOptions: suspended.preservedOptions,
    });

    assert.deepEqual(restored.conflicts, []);
    assert.deepEqual(restored.appliedNames, ["co-tweakers-user-questions"]);
    assert.match(restored.nextToml, /\[mcp_servers\.co-tweakers-user-questions\]/);
    assert.match(restored.nextToml, /default_tools_approval_mode = "approve"/);
    assert.match(restored.nextToml, /\[mcp_servers\.external\]/);
  });
});

test("off-mode ownership proof fails closed for a mismatched legacy server", () => {
  const current = [
    "[mcp_servers.co-thomashulihan-user-questions]",
    'command = "user-owned-command"',
    "",
  ].join("\n");
  const ownedTweaks = [{
    dir: "/expected/tweaks/user-questions",
    manifest: {
      id: "co.tweakers.user-questions",
      mcp: { command: "node" },
    },
  }];

  const plan = planManagedMcpReconciliation([], current, { ownedTweaks });

  assert.equal(plan.nextToml, current);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.conflicts, [{
    observedName: "co-thomashulihan-user-questions",
    canonicalName: "co-tweakers-user-questions",
    reason: "legacy-shape-mismatch",
  }]);
});

test("MCP markers inside multiline strings remain ordinary user content", () => {
  const current = [
    'description = """',
    MCP_MANAGED_START,
    "keep this text",
    MCP_MANAGED_END,
    '\"\"\"',
    "",
  ].join("\n");

  const plan = planManagedMcpReconciliation([], current);
  assert.equal(plan.changed, false);
  assert.equal(plan.nextToml, current);
});

test("MCP table-looking text inside multiline strings does not win import precedence", () => {
  const current = [
    'description = """',
    "[mcp_servers.co-tweakers-example]",
    'command = "manual text"',
    '\"\"\"',
    "",
  ].join("\n");
  const plan = planManagedMcpReconciliation([{
    dir: "/expected/tweaks/example",
    manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
  }], current);

  assert.deepEqual(plan.conflicts, []);
  assert.match(plan.nextToml, /\[mcp_servers\.co-tweakers-example\]\ncommand = "node"/);
  assert.match(plan.nextToml, /description = """\n\[mcp_servers\.co-tweakers-example\]/);
});

test("orphan managed markers fail closed instead of consuming manual content on a later run", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const original = [
      MCP_MANAGED_START,
      'manual_key = "keep"',
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const tweak = {
      dir: root,
      manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
    };

    assert.throws(() => planManagedMcpReconciliation([tweak], original), /managed MCP marker/i);
    assert.throws(() => syncManagedMcpServers({ configPath, tweaks: [tweak] }), /managed MCP marker/i);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });
});

test("malformed managed marker pairs fail closed", () => {
  const legacyStart = "# BEGIN CODEX++ MANAGED MCP SERVERS";
  const legacyEnd = "# END CODEX++ MANAGED MCP SERVERS";
  const malformed = [
    `\n${MCP_MANAGED_END}\n`,
    `${MCP_MANAGED_START}\nmanual_key = "keep"\n`,
    `${MCP_MANAGED_START}\n${legacyEnd}\n`,
    `${MCP_MANAGED_START}\n${MCP_MANAGED_START}\n${MCP_MANAGED_END}\n`,
    `${legacyStart}\n${MCP_MANAGED_END}\n`,
  ];
  for (const current of malformed) {
    assert.throws(
      () => planManagedMcpReconciliation([], current),
      /managed MCP marker/i,
    );
  }
});

test("MCP planning rejects malformed TOML outside the managed section", () => {
  assert.throws(() => planManagedMcpReconciliation([{
    dir: "/expected/tweaks/example",
    manifest: {
      id: "co.tweakers.example",
      mcp: { command: "node" },
    },
  }], MALFORMED_TOML_FIXTURE), /Malformed TOML/);
});

test("MCP planning accepts common Codex TOML syntax without normalizing manual config", () => {
  const validToml = [
    'model = "gpt-5.6"',
    "features = [",
    '  "apps",',
    '  "skills", # keep this comment',
    "]",
    'instructions = """first line',
    'second line"""',
    "",
    '[projects."/Users/example/My Project"]',
    'trust_level = "trusted"',
    "options = {}",
    "",
    "[mcp_servers.manual]",
    'command = "node"',
    'args = ["server.js", "--safe"]',
    'env = { TOKEN = "manual", EMPTY = "" }',
    "",
  ].join("\n");

  const plan = planManagedMcpReconciliation([], validToml);

  assert.equal(plan.changed, false);
  assert.equal(plan.nextToml, validToml);
});

test("legacy MCP sync preserves malformed config bytes instead of repairing around them", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, MALFORMED_TOML_FIXTURE, "utf8");

    assert.throws(() => syncManagedMcpServers({
      configPath,
      tweaks: [{
        dir: root,
        manifest: { id: "co.tweakers.example", mcp: { command: "node" } },
      }],
    }), /Malformed TOML/);

    assert.equal(readFileSync(configPath, "utf8"), MALFORMED_TOML_FIXTURE);
  });
});

test("syncManagedMcpServers updates only the managed config block", () => {
  withTempDir((root) => {
    const configPath = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    writeFileSync(configPath, `[mcp_servers.project-home]\ncommand = "node"\n`);

    const first = syncManagedMcpServers({
      configPath,
      tweaks: [
        {
          dir: root,
          manifest: {
            id: "co.bennett.native-widgets",
            mcp: { command: "node", args: ["mcp-server.js"] },
          },
        },
      ],
    });
    const afterFirst = readFileSync(configPath, "utf8");

    assert.equal(first.changed, true);
    assert.match(afterFirst, /\[mcp_servers\.project-home\]/);
    assert.match(afterFirst, /# BEGIN TWEAKER MANAGED MCP SERVERS/);
    assert.match(afterFirst, /\[mcp_servers\.co-bennett-native-widgets\]/);

    const second = syncManagedMcpServers({ configPath, tweaks: [] });
    const afterSecond = readFileSync(configPath, "utf8");

    assert.equal(second.changed, true);
    assert.match(afterSecond, /\[mcp_servers\.project-home\]/);
    assert.doesNotMatch(afterSecond, /co-bennett-native-widgets/);
    assert.doesNotMatch(afterSecond, /TWEAKER MANAGED/);
  });
});

test("syncManagedMcpServers replaces the legacy managed block without duplicates", () => {
  withTempDir((root) => {
    const configPath = join(root, "config.toml");
    const oldStart = ["# BEGIN CODEX", "++ MANAGED MCP SERVERS"].join("");
    const oldEnd = ["# END CODEX", "++ MANAGED MCP SERVERS"].join("");
    writeFileSync(configPath, `${oldStart}\n[mcp_servers.old-managed]\ncommand = "old"\n${oldEnd}\n`);
    syncManagedMcpServers({
      configPath,
      tweaks: [{ dir: root, manifest: { id: "co.example.current", mcp: { command: "node" } } }],
    });
    const value = readFileSync(configPath, "utf8");
    assert.doesNotMatch(value, /old-managed/);
    assert.equal(value.match(/BEGIN TWEAKER MANAGED/g)?.length, 1);
    assert.match(value, /mcp_servers\.co-example-current/);
  });
});

test("syncManagedMcpServers leaves user config untouched when there are no MCP tweaks", () => {
  withTempDir((root) => {
    const configPath = join(root, ".codex", "config.toml");
    mkdirSync(join(root, ".codex"), { recursive: true });
    const original = `[mcp_servers.project-home]\ncommand = "node"\n\n`;
    writeFileSync(configPath, original);

    const result = syncManagedMcpServers({ configPath, tweaks: [] });

    assert.equal(result.changed, false);
    assert.equal(readFileSync(configPath, "utf8"), original);
  });
});

test("syncManagedMcpServers creates the Codex config directory", () => {
  withTempDir((root) => {
    const configPath = join(root, ".codex", "config.toml");

    syncManagedMcpServers({
      configPath,
      tweaks: [
        {
          dir: root,
          manifest: { id: "co.bennett.native-widgets", mcp: { command: "node" } },
        },
      ],
    });

    assert.equal(existsSync(configPath), true);
  });
});

function withTempDir(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "tweaker-mcp-sync-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
