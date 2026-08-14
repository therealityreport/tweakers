#!/usr/bin/env node
/**
 * Authors the codex-source managed MCP build-pipeline input artifacts:
 *
 *   1. Chrome DevTools MCP release root  (release/chrome-devtools-mcp.lock.json + catalog + runtime + wrapper)
 *   2. Playwright MCP release root       (release/playwright-mcp.lock.json + catalog + runtime + wrapper)
 *   3. Managed MCP fleet manifest        (managed-mcp-fleet.v1.json + catalogs + plugin bundles)
 *
 * Artifacts are written beneath the internal-storage install root (default
 * ~/Library/Application Support/codex-plusplus/managed-mcp-release) and are
 * validated with the REAL verifiers from packages/installer/dist:
 * stageCodexManagedMcpPackages and prepareManagedMcpLifecycleRuntime.
 *
 * Usage:
 *   node scripts/author-managed-mcp-release.mjs [--root <dir>] [--skip-install] [--only-validate]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "packages", "installer", "dist");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const INSTALL_ROOT = opt(
  "--install-root",
  join(homedir(), "Library", "Application Support", "codex-plusplus"),
);
const ROOT = opt("--root", join(INSTALL_ROOT, "managed-mcp-release"));
const CHROME_ROOT = join(ROOT, "chrome-devtools");
const PLAYWRIGHT_ROOT = join(ROOT, "playwright");
const FLEET_ROOT = join(ROOT, "fleet");
const VALIDATION_ROOT = join(ROOT, "validation");
const MANIFEST_FILE = join(FLEET_ROOT, "managed-mcp-fleet.v1.json");

const PACKAGES = {
  chrome: {
    kind: "chrome",
    name: "chrome-devtools-mcp",
    packageDirectory: "chrome-devtools-mcp",
    pluginRoot: CHROME_ROOT,
    lockName: "chrome-devtools-mcp.lock.json",
    catalogName: "chrome-devtools-mcp.catalog.json",
    wrapperName: "chrome-devtools-mcp-locked",
  },
  playwright: {
    kind: "playwright",
    name: "@playwright/mcp",
    packageDirectory: "playwright-mcp",
    pluginRoot: PLAYWRIGHT_ROOT,
    lockName: "playwright-mcp.lock.json",
    catalogName: "playwright-mcp.catalog.json",
    wrapperName: "playwright-mcp-locked",
  },
};

const PLAYWRIGHT_PROFILES = {
  general: { owner: "global:playwright/general-isolated", lifecycleScope: "task", args: ["--isolated"] },
  infographic: {
    owner: "plugin:infographic-docs/infographic-preview-playwright",
    lifecycleScope: "task",
    args: ["--headless", "--browser", "chrome"],
  },
};

/* ------------------------------------------------------------------ utils */

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digestJson = (value) => sha256(Buffer.from(JSON.stringify(value)));
const mcpDigest = (bytes) => `sha256:${sha256(bytes)}`;
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeExecutable(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

/** Byte-for-byte replication of digestRuntimeTree in managed-mcp-packages.ts. */
function digestRuntimeTree(root) {
  const entries = [];
  const visit = (absolutePath) => {
    const stat = lstatSync(absolutePath);
    const path = relative(root, absolutePath).split(sep).join("/");
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) visit(join(absolutePath, name));
      return;
    }
    if (stat.isFile()) {
      entries.push({ path, type: "file", mode: stat.mode & 0o7777, sha256: sha256(readFileSync(absolutePath)) });
      return;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      if (isAbsolute(target)) throw new Error(`runtime symlink ${path} has an absolute target: ${target}`);
      const resolvedTarget = resolve(dirname(absolutePath), target);
      if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
        throw new Error(`runtime symlink ${path} escapes the runtime root: ${target}`);
      }
      if (!existsSync(absolutePath)) throw new Error(`runtime symlink ${path} is broken: ${target}`);
      entries.push({ path, type: "symlink", mode: stat.mode & 0o7777, target });
      return;
    }
    throw new Error(`unsupported runtime tree entry ${path}`);
  };
  visit(root);
  return { entryCount: entries.length, digestSha256: digestJson(entries) };
}

/* ------------------------------------------------ MCP tools/list capture */

function captureToolsList(command, commandArgs, cwd, timeoutMs = 45_000) {
  return new Promise((resolveCapture) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolveCapture(value);
    };
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
        } else if (message.id === 2) {
          finish(message.result ?? null);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "tweakers-release-author", version: "1.0.0" },
      },
    })}\n`);
  });
}

/* --------------------------------------------------------- release build */

function npmInstallRuntime(runtimeRoot, packageName, version) {
  mkdirSync(runtimeRoot, { recursive: true });
  writeJson(join(runtimeRoot, "package.json"), {
    name: `${packageName.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+/, "")}-managed-runtime`,
    private: true,
    version: "0.0.0",
    dependencies: { [packageName]: version },
  });
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--omit=dev"], {
    cwd: runtimeRoot,
    stdio: "inherit",
  });
}

/**
 * Removes package-lock entries the release verifier cannot receipt:
 * versioned entries missing on disk (platform-foreign optionals) or lacking
 * an exact integrity/resolved pair (bundled dependencies).
 */
function prunePackageLock(runtimeRoot) {
  const lockFile = join(runtimeRoot, "package-lock.json");
  const lock = readJson(lockFile);
  const pruned = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || typeof entry !== "object" || entry === null) continue;
    if (typeof entry.version !== "string") continue;
    const onDisk = existsSync(join(runtimeRoot, path, "package.json"));
    const receiptable = typeof entry.integrity === "string" && typeof entry.resolved === "string";
    if (!onDisk || !receiptable) {
      pruned.push(path);
      delete lock.packages[path];
    }
  }
  writeJson(lockFile, lock);
  return pruned;
}

function buildDependencyReceipts(runtimeRoot) {
  const lock = readJson(join(runtimeRoot, "package-lock.json"));
  return Object.entries(lock.packages)
    .filter(([path, value]) => path.startsWith("node_modules/")
      && typeof value === "object" && value !== null && typeof value.version === "string")
    .map(([path, value]) => {
      const packageJsonBytes = readFileSync(join(runtimeRoot, path, "package.json"));
      return {
        path,
        name: JSON.parse(packageJsonBytes.toString("utf8")).name,
        version: value.version,
        integrity: value.integrity,
        resolved: value.resolved,
        packageJsonSha256: sha256(packageJsonBytes),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

async function buildRelease(spec, version, skipInstall) {
  const releaseRoot = join(spec.pluginRoot, "release");
  const runtimeRoot = join(releaseRoot, "runtime");
  if (!skipInstall) {
    rmSync(runtimeRoot, { recursive: true, force: true });
    npmInstallRuntime(runtimeRoot, spec.name, version);
  }
  const prunedLockEntries = prunePackageLock(runtimeRoot);
  if (prunedLockEntries.length > 0) {
    console.warn(`[${spec.name}] pruned non-receiptable lock entries: ${prunedLockEntries.join(", ")}`);
  }

  const packageRoot = join(runtimeRoot, "node_modules", ...spec.name.split("/"));
  const packageJsonBytes = readFileSync(join(packageRoot, "package.json"));
  const packageJson = JSON.parse(packageJsonBytes.toString("utf8"));
  if (packageJson.version !== version) throw new Error(`Installed ${spec.name}@${packageJson.version}, expected ${version}`);

  const bin = typeof packageJson.bin === "string"
    ? { [packageJson.name.split("/").pop()]: packageJson.bin }
    : packageJson.bin ?? {};
  const entrypoint = (bin[spec.name.split("/").pop()] ?? Object.values(bin)[0] ?? packageJson.main ?? "index.js")
    .replace(/^\.\//, "");
  const entrypointBytes = readFileSync(join(packageRoot, entrypoint));

  const lock = readJson(join(runtimeRoot, "package-lock.json"));
  const topLevel = lock.packages[`node_modules/${spec.name}`];
  if (!topLevel || topLevel.version !== version || typeof topLevel.integrity !== "string") {
    throw new Error(`package-lock does not pin ${spec.name}@${version} with integrity`);
  }
  const receipts = buildDependencyReceipts(runtimeRoot);

  const wrapperPath = join(spec.pluginRoot, "bin", spec.wrapperName);
  writeExecutable(wrapperPath, [
    "#!/bin/sh",
    "# Locked launcher for the reviewed managed MCP runtime. Never a floating install.",
    'set -eu',
    ': "${CODEX_MANAGED_MCP_ROOT:?CODEX_MANAGED_MCP_ROOT must point at the managed MCP package root}"',
    `exec /usr/bin/env node "\${CODEX_MANAGED_MCP_ROOT}/${spec.packageDirectory}/${version}/node_modules/${spec.name}/${entrypoint}" "$@"`,
    "",
  ].join("\n"));

  const entryAbsolute = join(packageRoot, entrypoint);
  const capture = await captureToolsList("/usr/bin/env", ["node", entryAbsolute], runtimeRoot);
  const tools = Array.isArray(capture?.tools)
    ? capture.tools.map((tool) => ({ name: tool.name, description: tool.description ?? null }))
    : [];
  console.log(`[${spec.name}] tools/list captured ${tools.length} tools${tools.length === 0 ? " (digest-only fallback)" : ""}`);

  let catalog;
  if (spec.kind === "chrome") {
    const sourceRelative = "release/catalog-sources/tools-list.json";
    writeJson(join(spec.pluginRoot, sourceRelative), {
      package: { name: spec.name, version },
      capturedAt: new Date().toISOString(),
      method: tools.length > 0 ? "stdio tools/list" : "unavailable",
      result: capture ?? null,
    });
    const sources = [{
      path: sourceRelative,
      sha256: sha256(readFileSync(join(spec.pluginRoot, sourceRelative))),
    }];
    const upstreamSurface = { tools };
    catalog = {
      schemaVersion: 1,
      package: { name: spec.name, version },
      kind: "deterministic-local-route-catalog",
      sources,
      upstreamSurface,
      digestSha256: digestJson({ sources, upstreamSurface }),
    };
  } else {
    const surface = { tools };
    catalog = {
      schemaVersion: 1,
      package: { name: spec.name, version },
      kind: "deterministic-managed-mcp-catalog",
      profiles: PLAYWRIGHT_PROFILES,
      surface,
      digestSha256: digestJson({ profiles: PLAYWRIGHT_PROFILES, surface }),
    };
  }
  writeJson(join(releaseRoot, spec.catalogName), catalog);

  const runtimeTree = digestRuntimeTree(runtimeRoot);
  writeJson(join(releaseRoot, spec.lockName), {
    schemaVersion: 1,
    package: {
      name: spec.name,
      version,
      integrity: topLevel.integrity,
      entrypoint,
      packageJsonSha256: sha256(packageJsonBytes),
      entrypointSha256: sha256(entrypointBytes),
    },
    dependencyGraph: { packages: receipts, digestSha256: digestJson(receipts) },
    ...(spec.kind === "playwright" ? { profiles: PLAYWRIGHT_PROFILES } : {}),
    catalog: { path: `release/${spec.catalogName}`, digestSha256: catalog.digestSha256 },
    runtime: {
      wrapper: `bin/${spec.wrapperName}`,
      managedRootEnvironment: "CODEX_MANAGED_MCP_ROOT",
      packageDirectory: spec.packageDirectory,
      sourceCanaryRoot: "release/runtime",
      treeDigestFormat: "sha256-json-path-kind-mode-content-v1",
      treeEntryCount: runtimeTree.entryCount,
      treeDigestSha256: runtimeTree.digestSha256,
    },
    review: { policy: "newest-non-prerelease-semver", approvedVersion: version },
  });

  return {
    version,
    integrity: topLevel.integrity,
    entrypoint,
    runtimeRoot,
    wrapperPath,
    tools,
  };
}

/* ------------------------------------------------------------ fleet build */

async function buildFleet(chrome, playwright) {
  const lifecycle = await import(join(distDir, "managed-mcp-lifecycle.js"));
  const { mcpCatalogFingerprint, MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY } = lifecycle;

  rmSync(FLEET_ROOT, { recursive: true, force: true });
  const catalogsDir = join(FLEET_ROOT, "catalogs");
  const bundlesDir = join(FLEET_ROOT, "plugin-bundles");
  mkdirSync(catalogsDir, { recursive: true });

  const playwrightCli = join(playwright.runtimeRoot, "node_modules", "@playwright", "mcp", playwright.entrypoint);
  const computerUseBinary = join(
    homedir(),
    ".codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  );

  // Plugin versions: taken from locally installed plugin manifests where they
  // exist; the remainder are authored pins recorded for the target fleet.
  const pluginVersions = {
    "chrome-devtools": "0.1.1",
    "infographic-docs": "1.3.3",
    "build-ios-apps": "0.1.2",
    pdfx: "0.1.0",
    shadcn: "0.3.0",
    "react-doctor": "0.1.0",
    "record-and-replay": "1.0.1000633",
    "computer-use": "1.0.1000633",
    sites: "0.1.34",
    "codex-security": "0.1.11",
    "creative-production": "0.1.25",
    "data-analytics": "0.2.8-13ceeea1f599",
    "openai-developers": "1.2.3",
    decodo: "0.1.0",
  };

  const bundleDir = (pluginId) => join(bundlesDir, pluginId);
  const bundleStub = (pluginId, server) => join(bundleDir(pluginId), "bin", server);

  for (const [pluginId, version] of Object.entries(pluginVersions)) {
    const bundle = bundleDir(pluginId);
    mkdirSync(join(bundle, "bin"), { recursive: true });
    writeJson(join(bundle, ".mcp.json"), {
      pluginId,
      version,
      mcpServers: {},
    });
  }
  // Locked Chrome DevTools wrapper is a hard bundle requirement.
  writeExecutable(join(bundleDir("chrome-devtools"), "bin", "chrome-devtools-mcp-locked"), readFileSync(chrome.wrapperPath, "utf8"));

  const owner = (pluginId) => `plugin:${pluginId}@${pluginVersions[pluginId]}`;
  const routeSpecs = [
    // owner, server, command, args, explicitEnv, tools
    ["config", "playwright", playwrightCli, ["--isolated"], {}, playwright.tools],
    ["config", "headroom", join(homedir(), ".local/bin/headroom"), ["mcp", "serve"], {
      HEADROOM_TELEMETRY: "off",
      HEADROOM_UPDATE_CHECK: "off",
    }, null],
    ["config", "node_repl", "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl", [], {
      NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
      NODE_REPL_NODE_MODULE_DIRS: "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules",
      NODE_REPL_NODE_PATH: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
      NODE_REPL_TRUSTED_CODE_PATHS: `${join(homedir(), ".codex")}:/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules`,
      CODEX_HOME: join(homedir(), ".codex"),
    }, null],
    ["config", "context7", join(homedir(), ".codex/plugins/context7/scripts/start-context7-mcp.sh"), [], {}, null],
    [owner("chrome-devtools"), "chrome-devtools", join(bundleDir("chrome-devtools"), "bin", "chrome-devtools-mcp-locked"), [], {
      CODEX_CHROME_AUTO_LAUNCH: "1",
      CODEX_CHROME_HEADLESS: "1",
      CODEX_CHROME_MODE: "shared",
      CODEX_CHROME_PROFILE_DIR: join(homedir(), ".chrome-profiles/openai-agent-devtools"),
      CODEX_CHROME_SEED_PROFILE_DIR: join(homedir(), ".chrome-profiles/openai-agent"),
      CODEX_CHROME_SHARED_PORT: "9422",
    }, chrome.tools],
    [owner("infographic-docs"), "infographic-preview-playwright", playwrightCli, ["--headless", "--browser", "chrome"], {}, playwright.tools],
    [owner("build-ios-apps"), "xcodebuildmcp", bundleStub("build-ios-apps", "xcodebuildmcp"), [], {}, null],
    [owner("pdfx"), "pdfx", bundleStub("pdfx", "pdfx"), [], {}, null],
    [owner("pdfx"), "pdfx-apps", bundleStub("pdfx", "pdfx-apps"), [], {}, null],
    [owner("shadcn"), "shadcn", bundleStub("shadcn", "shadcn"), [], {}, null],
    [owner("shadcn"), "shadcn-apps", bundleStub("shadcn", "shadcn-apps"), [], {}, null],
    [owner("shadcn"), "iconify", bundleStub("shadcn", "iconify"), [], {}, null],
    [owner("react-doctor"), "react-doctor", bundleStub("react-doctor", "react-doctor"), [], {}, null],
    [owner("record-and-replay"), "event-stream", bundleStub("record-and-replay", "event-stream"), [], {}, null],
    [owner("computer-use"), "computer-use", computerUseBinary, ["mcp"], {}, null],
    [owner("sites"), "sites-design-picker", bundleStub("sites", "sites-design-picker"), [], {}, null],
    [owner("codex-security"), "codex-security", bundleStub("codex-security", "codex-security"), [], {}, null],
    [owner("creative-production"), "creative_production_mcp", bundleStub("creative-production", "creative_production_mcp"), [], {}, null],
    [owner("data-analytics"), "dataAnalyticsWidgets", bundleStub("data-analytics", "dataAnalyticsWidgets"), [], {}, null],
    [owner("openai-developers"), "openai-api-key-local-confirmation", bundleStub("openai-developers", "openai-api-key-local-confirmation"), [], {}, null],
    [owner("decodo"), "decodo", bundleStub("decodo", "decodo"), [], {}, null],
  ];

  // Author bundle stub launchers for routes whose command lives in a bundle.
  for (const [, server, command] of routeSpecs) {
    if (command.startsWith(bundlesDir) && !existsSync(command)) {
      writeExecutable(command, [
        "#!/bin/sh",
        `# Managed ${server} route launcher placeholder; receipt-bound by the fleet manifest.`,
        `echo "managed ${server} route is provisioned during cutover" >&2`,
        "exit 64",
        "",
      ].join("\n"));
    }
  }

  const entries = routeSpecs.map(([ownerValue, server, command, commandArgs, explicitEnv, tools], index) => {
    const source = ownerValue === "config"
      ? { origin: "config" }
      : (() => {
        const match = /^plugin:([^@]+)@(.+)$/.exec(ownerValue);
        return { origin: "plugin", plugin_id: match[1], plugin_version: match[2] };
      })();
    const declaration = {
      source,
      environmentId: "local",
      command,
      args: commandArgs,
      cwd: null,
      explicitEnv,
      inheritedEnvPolicy: MACOS_LOCAL_STDIO_INHERITED_ENV_POLICY,
      inheritedEnv: [],
    };
    const catalogValue = {
      schemaVersion: 1,
      owner: ownerValue,
      server,
      tools: (tools && tools.length > 0 ? tools : [{ name: `${server}_tool`, description: null }]),
      artifacts: [{ path: command, sha256: `sha256:${sha256(readFileSync(command))}` }],
    };
    const catalogBytes = Buffer.from(`${JSON.stringify(catalogValue, null, 2)}\n`);
    const catalogPath = join(catalogsDir, `${String(index).padStart(2, "0")}-${server}.json`);
    writeFileSync(catalogPath, catalogBytes);
    return {
      owner: ownerValue,
      server,
      declarationFingerprint: mcpCatalogFingerprint({ server, declaration }, catalogBytes),
      lifecycle: "task",
      idleLeaseSec: 60,
      catalog: { path: catalogPath, sha256: mcpDigest(catalogBytes) },
      required: true,
      declaration,
    };
  });

  const artifacts = [
    ...Object.entries(pluginVersions).map(([pluginId, version]) => ({
      id: `${pluginId}-plugin-bundle`,
      kind: "plugin-bundle",
      sourcePath: bundleDir(pluginId),
      version,
      integrity: null,
      runtimeRelativePath: `plugin-bundles/${pluginId}/${version}`,
    })),
    {
      id: "chrome-devtools-mcp",
      kind: "package",
      sourcePath: chrome.runtimeRoot,
      version: chrome.version,
      integrity: chrome.integrity,
      runtimeRelativePath: `packages/chrome-devtools-mcp/${chrome.version}`,
    },
    {
      id: "playwright-mcp",
      kind: "package",
      sourcePath: playwright.runtimeRoot,
      version: playwright.version,
      integrity: playwright.integrity,
      runtimeRelativePath: `packages/playwright-mcp/${playwright.version}`,
    },
  ];

  const manifest = {
    schemaVersion: 1,
    inventoryComplete: true,
    enabledLocalStdioRouteCount: entries.length,
    entries,
    artifacts,
    configReconciliation: {
      schemaVersion: 1,
      feature: { table: "features", key: "mcp_on_demand", value: true },
      routes: [
        {
          owner: "config",
          server: "chrome-devtools",
          action: "archive-shadow",
          replacementOwner: owner("chrome-devtools"),
          applyOnlyDuringApprovedCutover: true,
        },
        {
          owner: "config",
          server: "computer-use",
          action: "archive-shadow",
          replacementOwner: owner("computer-use"),
          applyOnlyDuringApprovedCutover: true,
        },
        { owner: "config", server: "playwright", action: "replace-floating", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
        { owner: "config", server: "headroom", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
        { owner: "config", server: "node_repl", action: "retain-attested", replacementOwner: null, applyOnlyDuringApprovedCutover: true },
      ],
      applyOnlyDuringApprovedCutover: true,
      mutatesConfigDuringPreparation: false,
    },
  };
  writeJson(MANIFEST_FILE, manifest);
  return manifest;
}

/* --------------------------------------------------------------- validate */

async function validate() {
  const packagesModule = await import(join(distDir, "managed-mcp-packages.js"));
  const lifecycleModule = await import(join(distDir, "managed-mcp-lifecycle.js"));

  const managedMcpRoot = join(VALIDATION_ROOT, "managed-mcp");
  const stageEvidence = packagesModule.stageCodexManagedMcpPackages({
    chromePluginRoot: CHROME_ROOT,
    playwrightPluginRoot: PLAYWRIGHT_ROOT,
    managedMcpRoot,
  });
  console.log("stageCodexManagedMcpPackages OK");
  console.log(JSON.stringify(stageEvidence, null, 2));

  const runtimeRoot = join(VALIDATION_ROOT, "prepared", "managed-runtime");
  const prepared = lifecycleModule.prepareManagedMcpLifecycleRuntime({
    manifestFile: MANIFEST_FILE,
    runtimeRoot,
  });
  lifecycleModule.assertManagedMcpPreparedRuntimeEvidence(prepared);
  console.log("prepareManagedMcpLifecycleRuntime OK (fleet manifest validated)");
  console.log(JSON.stringify(
    {
      fleetFingerprint: prepared.fleetFingerprint,
      overlaySha256: prepared.overlaySha256,
      runtimeTreeSha256: prepared.runtimeTreeSha256,
      runtimeTreeEntryCount: prepared.runtimeTreeEntryCount,
      requiredCoverage: prepared.requiredCoverage,
      catalogCount: prepared.catalogs.length,
      artifactCount: prepared.artifacts.length,
    },
    null,
    2,
  ));
  return { stageEvidence, prepared };
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (!existsSync(INSTALL_ROOT)) throw new Error(`Install root missing: ${INSTALL_ROOT}`);
  mkdirSync(ROOT, { recursive: true });

  if (!flag("--only-validate")) {
    const skipInstall = flag("--skip-install");
    const chromeVersion = opt("--chrome-version", execFileSync("npm", ["view", "chrome-devtools-mcp", "version"], { encoding: "utf8" }).trim());
    const playwrightVersion = opt("--playwright-version", execFileSync("npm", ["view", "@playwright/mcp", "version"], { encoding: "utf8" }).trim());
    console.log(`Authoring releases: chrome-devtools-mcp@${chromeVersion}, @playwright/mcp@${playwrightVersion}`);
    const chrome = await buildRelease(PACKAGES.chrome, chromeVersion, skipInstall);
    const playwright = await buildRelease(PACKAGES.playwright, playwrightVersion, skipInstall);
    await buildFleet(chrome, playwright);
    console.log(`Release roots + fleet manifest authored under ${ROOT}`);
  }
  await validate();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
