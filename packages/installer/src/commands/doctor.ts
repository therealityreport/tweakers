import kleur from "kleur";
import { join } from "node:path";
import { userPaths } from "../paths.js";
import { readState, resolveMode } from "../state.js";
import { locateCodex } from "../platform.js";
import { readHeaderHash } from "../asar.js";
import { verifySignature } from "../codesign.js";
import { existsSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { inspectChromeBridge } from "../chrome-bridge-health.js";
import { readAsarMarker, readCodexVersion } from "./install.js";
import { describeChatgptModeAsar, describeRendererPatchCoverage, patchedPayloadAsarPath } from "./status.js";
import { readRendererPatchRecord } from "../renderer-patch-outcome.js";
import { parkedPayloadApp, payloadMetadataFile, readPayloadMetadata } from "../mode-transition.js";
import { targetUserHome } from "../ownership.js";
import {
  inspectMcpLifecycleHealth,
  type McpLifecycleHealthReport,
} from "../mcp-lifecycle-health.js";
import { loadEnvironmentState } from "../environment-profile.js";
import { environmentModeCachePaths, observeEnvironmentModeCache } from "../environment-mode-cache.js";
import {
  inspectAccountRouter,
  type AccountRouterArtifactEvidence,
  type AccountRouterEvidence,
} from "../account-router-status.js";

interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

export interface DoctorOptions {
  deep?: boolean;
  json?: boolean;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  const checks: Check[] = [];
  // Doctor is read-only: unlike install/repair it must never create user dirs.
  const paths = userPaths();
  const state = readState(paths.stateFile);
  const lifecycle = inspectMcpLifecycleHealth({
    targetHome: targetUserHome(),
    backupRoot: join(paths.backup, "mcp-lifecycle"),
    managedReceiptPath: join(paths.root, "mcp-lifecycle-managed.json"),
    deep: options.deep === true,
  });
  const accountRouter = await inspectAccountRouter({
    userRoot: paths.root,
    sourceRoot: state?.sourceRoot ?? null,
    installedRuntimeRoot: paths.runtime,
  });

  checks.push({
    name: "user dir writable",
    ok: tryWrite(paths.root),
    detail: paths.root,
  });
  checks.push(...lifecycle.checks.map((item) => ({
    name: `MCP ${item.name}`,
    ok: item.status === "ok" ? true : item.status === "warn" ? "warn" as const : false,
    detail: item.detail,
  })));
  checks.push(...accountRouterDoctorChecks(accountRouter));

  // This is a presentation-only read. In particular it must not create the
  // default-off cache directory while doctor is checking an ordinary install.
  const cacheV2 = observeEnvironmentModeCache(environmentModeCachePaths(paths.root));
  checks.push({
    name: "environment mode cache",
    ok: environmentModeCacheDoctorStatus(cacheV2),
    detail: describeEnvironmentModeCache(cacheV2),
  });

  if (!state) {
    checks.push({
      name: "installed",
      ok: false,
      detail: "no state file — run `tweaker install`",
    });
    print(checks, options, lifecycle, cacheV2);
    return;
  }

  // Selection/registry drift breaks every environment command while leaving
  // the app itself healthy, so doctor must surface it explicitly.
  try {
    loadEnvironmentState({
      legacyStateFile: paths.stateFile,
      registryFile: paths.environmentRegistryFile,
      selectionFile: paths.environmentSelectionFile,
      environmentRoot: paths.root,
    }, { recoverCommit: false });
    checks.push({
      name: "environment consistency",
      ok: true,
      detail: "selection matches the profile registry",
    });
  } catch (e) {
    checks.push({
      name: "environment consistency",
      ok: false,
      detail: `${(e as Error).message} — run \`tweaker environment status\``,
    });
  }

  let codex;
  try {
    codex = locateCodex(state.appRoot);
    checks.push({ name: "Codex.app present", ok: true, detail: codex.appRoot });
  } catch (e) {
    checks.push({
      name: "Codex.app present",
      ok: false,
      detail: (e as Error).message,
    });
    print(checks, options, lifecycle, cacheV2);
    return;
  }

  if (existsSync(codex.asarPath)) {
    const { headerHash } = readHeaderHash(codex.asarPath);
    const marker = readAsarMarker(codex.asarPath);
    const markerPresent = marker === "present";
    const observedMode = marker === "present"
      ? "tweakers"
      : marker === "absent"
        ? "chatgpt"
        : resolveMode(state, false);
    if (observedMode === "chatgpt") {
      const payloadMeta = readPayloadMetadata(payloadMetadataFile(paths.root));
      const report = describeChatgptModeAsar({
        headerHash,
        state,
        markerPresent,
        parkedPayloadVersion: payloadMeta?.baseVersion
          ?? readCodexVersion(join(parkedPayloadApp(paths.root), "Contents", "Info.plist")),
        payloadPatchedAsarHash: payloadMeta?.patchedAsarHash ?? null,
      });
      checks.push({
        name: "asar header hash",
        ok: report.tone === "green" ? true : "warn",
        detail: report.label,
      });
    } else {
      checks.push({
        name: "asar header hash",
        ok: headerHash === state.patchedAsarHash || "warn",
        detail:
          headerHash === state.patchedAsarHash
            ? "matches patched"
            : headerHash === state.originalAsarHash
              ? "matches ORIGINAL — Codex updated; run `tweaker repair`"
              : "drift from both original and patched",
      });
    }

    // Absent record ⇒ no check at all: a payload built before this accounting
    // never claimed anything, so warning about it would be a false alarm.
    const coverage = describeRendererPatchCoverage(
      readRendererPatchRecord(patchedPayloadAsarPath(paths.root, codex.asarPath)),
      readCodexVersion(codex.metaPath ?? "") ?? null,
    );
    if (coverage) {
      checks.push({
        name: "renderer tweaks",
        ok: coverage.tone === "green" ? true : "warn",
        detail: coverage.label,
      });
    }
  }

  if (codex.platform === "darwin") {
    const sig = verifySignature(codex.appRoot);
    checks.push({
      name: "code signature",
      ok: sig.ok,
      detail: sig.ok ? "valid (ad-hoc)" : sig.output.split("\n")[0],
    });

    // A locally re-signed app no longer matches the ACL on the safeStorage
    // keychain item the original OpenAI-signed app created, so macOS prompts
    // on every access until the user clicks "Always Allow" once.
    if (state.signingMode === "local-identity" && hasCodexStorageKeychainItem()) {
      checks.push({
        name: "keychain safeStorage",
        ok: "warn",
        detail:
          '"Codex Storage Key" exists; if macOS keeps prompting, click "Always Allow" once — see docs/TROUBLESHOOTING.md',
      });
    }

    const chromeBridge = inspectChromeBridge({ appRoot: codex.appRoot });
    if (chromeBridge) {
      checks.push({
        name: "Chrome bridge cache",
        ok: chromeBridge.cache.ok,
        detail: chromeBridge.cache.detail,
      });
      checks.push({
        name: "Chrome native host",
        ok: chromeBridge.nativeHost.ok,
        detail: chromeBridge.nativeHost.detail,
      });
    }
  }

  for (const dir of [paths.runtime, paths.tweaks, paths.logDir]) {
    checks.push({
      name: `${dir.split("/").slice(-1)} dir`,
      ok: existsSync(dir),
      detail: dir,
    });
  }

  print(checks, options, lifecycle, cacheV2);
}

function describeEnvironmentModeCache(cache: ReturnType<typeof observeEnvironmentModeCache>): string {
  const generation = cache.generationId ? `generation ${cache.generationId}` : "no generation";
  const reason = cache.invalidationReasons[0];
  return `${cache.state}; ${generation}${reason ? `; ${reason}` : ""}`;
}

function environmentModeCacheDoctorStatus(
  cache: ReturnType<typeof observeEnvironmentModeCache>,
): Check["ok"] {
  // The sealed pair is default-off. A clean install that has never prepared
  // one is healthy, not a warning. Only evidence of an attempted pair that
  // became stale/unreadable needs operator attention.
  if (cache.state === "ready") return true;
  if (cache.state === "unavailable"
    && cache.invalidationReasons.length === 1
    && cache.invalidationReasons[0] === "no environment mode cache has been published") return true;
  return "warn";
}

/** Operator checks distinguish recorded source, packaged candidate, installed runtime, and live mux facts. */
export function accountRouterDoctorChecks(evidence: AccountRouterEvidence): Check[] {
  if (evidence.configuration.state === "not_staged" || evidence.configuration.state === "manual") return [];
  if (evidence.configuration.state === "invalid" || evidence.configuration.state === "unsafe") {
    return [{
      name: "account router configuration",
      ok: false,
      detail: `staged configuration is ${evidence.configuration.state}; manual/direct fallback is required`,
    }];
  }
  const source = artifactCheck("account router source", evidence.source, null);
  const candidate = artifactCheck("account router candidate", evidence.candidate, evidence.source.version);
  const installed = artifactCheck("account router installed", evidence.installed, evidence.candidate.version);
  const live: Check = evidence.live.state === "active" && evidence.live.status
    ? {
      name: "account router live",
      ok: true,
      detail: `${evidence.live.status.mode}; ${evidence.live.status.fairnessPrecision}`,
    }
    : {
      name: "account router live",
      ok: evidence.live.state === "unavailable" ? false : "warn",
      detail: evidence.live.state.replaceAll("_", " "),
    };
  return [source, candidate, installed, live];
}

function artifactCheck(name: string, artifact: AccountRouterArtifactEvidence, expectedVersion: string | null): Check {
  if (artifact.state === "present") {
    const matchesExpected = expectedVersion === null || artifact.version === expectedVersion;
    return {
      name,
      ok: matchesExpected ? true : "warn",
      detail: matchesExpected
        ? `present${artifact.version ? ` (${artifact.version})` : ""}`
        : `version ${artifact.version ?? "unknown"} differs from preceding evidence ${expectedVersion}`,
    };
  }
  return {
    name,
    ok: artifact.state === "invalid" ? false : "warn",
    detail: artifact.state.replaceAll("_", " "),
  };
}

function hasCodexStorageKeychainItem(): boolean {
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", "Codex", "-l", "Codex Storage Key"],
    { stdio: "ignore", timeout: 5_000 },
  );
  return result.status === 0;
}

function tryWrite(p: string): boolean {
  try {
    accessSync(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function print(
  checks: Check[],
  options: DoctorOptions,
  lifecycle: McpLifecycleHealthReport,
  cacheV2: ReturnType<typeof observeEnvironmentModeCache>,
): void {
  const failed = checks.filter((c) => c.ok === false).length;
  if (options.json) {
    console.log(JSON.stringify({
      schemaVersion: 1,
      status: failed > 0 ? "error" : checks.some((check) => check.ok === "warn") ? "warn" : "ok",
      checks: checks.map((item) => ({
        name: item.name,
        status: item.ok === true ? "ok" : item.ok === "warn" ? "warn" : "error",
        detail: item.detail,
      })),
      mcpLifecycle: lifecycle,
      cacheV2,
    }));
    if (failed > 0) process.exitCode = 1;
    return;
  }
  console.log(kleur.bold("tweaker doctor\n"));
  for (const c of checks) {
    const mark =
      c.ok === true
        ? kleur.green("✓")
        : c.ok === "warn"
          ? kleur.yellow("!")
          : kleur.red("✗");
    console.log(`  ${mark} ${c.name.padEnd(24)} ${kleur.dim(c.detail)}`);
  }
  console.log();
  if (failed === 0) {
    console.log(kleur.green("All checks passed."));
  } else {
    console.log(kleur.red(`${failed} check(s) failed.`));
    process.exitCode = 1;
  }
}
