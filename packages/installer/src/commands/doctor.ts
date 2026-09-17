import kleur from "kleur";
import { join } from "node:path";
import { userPaths } from "../paths.js";
import { readState, resolveMode } from "../state.js";
import { locateCodex } from "../platform.js";
import { readHeaderHash } from "../asar.js";
import { signatureInfo, verifySignature, type SignatureInfo } from "../codesign.js";
import { existsSync, accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { inspectChromeBridge } from "../chrome-bridge-health.js";
import { readAsarMarker, readCodexVersion } from "./install.js";
import { describeChatgptModeAsar, describeRendererPatchCoverage, patchedPayloadAsarPath } from "./status.js";
import { readRendererPatchRecord } from "../renderer-patch-outcome.js";
import { parkedPayloadApp, payloadMetadataFile, readPayloadMetadata } from "../mode-transition.js";
import { targetUserHome } from "../ownership.js";
import { defaultTweakersAccountsBrokerRoot } from "../macos-variant.js";
import {
  inspectMcpLifecycleHealth,
  type McpLifecycleHealthReport,
} from "../mcp-lifecycle-health.js";
import { loadEnvironmentState } from "../environment-profile.js";
import { environmentModeCachePaths, observeEnvironmentModeCache } from "../environment-mode-cache.js";
import { readConfigFile } from "../config.js";
import {
  inspectAccountRouter,
  inspectIndependentTweakersLiveHealth,
  canonicalIndependentTweakersVariantRoot,
  readRegisteredDevelopmentSourceRoot,
  type AccountRouterArtifactEvidence,
  type AccountRouterEvidence,
  type AccountRouterSourceEvidence,
} from "../account-router-status.js";

interface Check {
  name: string;
  ok: boolean | "warn";
  detail: string;
}

export interface DoctorOptions {
  target?: string;
  ui?: boolean;
  "scan-updates"?: boolean;
  deep?: boolean;
  json?: boolean;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (options.target && !["legacy", "independent"].includes(options.target)) throw new Error("Doctor target must be legacy or independent");
  if (options.target === "independent") {
    const { runIndependentDoctorCli } = await import("../doctor-actions.js");
    await runIndependentDoctorCli(options);
    return;
  }
  if (options.ui || options["scan-updates"]) throw new Error("Doctor UI and update scan require --target independent");
  if (!options.json) console.log("Doctor target: legacy injected installation");
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
    brokerRoot: defaultTweakersAccountsBrokerRoot(targetUserHome()),
    registeredDevelopmentSourceRoot: readRegisteredDevelopmentSourceRoot(readConfigFile(paths.configFile)),
    installedRuntimeRoot: paths.runtime,
  });
  const independentVariantRoot = canonicalIndependentTweakersVariantRoot(targetUserHome());
  const independentLiveHealth = inspectIndependentTweakersLiveHealth(independentVariantRoot, {
    expectedAccountsBrokerRoot: defaultTweakersAccountsBrokerRoot(targetUserHome()),
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
  checks.push(...independentTweakersLiveHealthDoctorChecks(independentLiveHealth));

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
    const verification = verifySignature(codex.appRoot);
    const identity = signatureInfo(codex.appRoot);
    checks.push({
      name: "code signature",
      ok: verification.ok && identity.ok,
      detail: codeSignatureDoctorDetail(verification, identity),
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

export function codeSignatureDoctorDetail(
  verification: Readonly<{ ok: boolean; output: string }>,
  identity: SignatureInfo,
): string {
  if (!verification.ok) return verification.output.split("\n")[0] || "invalid signature";
  if (!identity.ok) return identity.output.split("\n")[0] || "signature identity unreadable";
  if (identity.adHoc) return "valid (ad-hoc)";
  const authority = identity.authority[0];
  return authority ? `valid (${authority})` : "valid (certificate identity unavailable)";
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

/**
 * A current independent-app health record is useful only while its exact
 * process is still alive.  Do not downgrade stale/PID-reused evidence to a
 * warning: that would make an old good-looking receipt look live.
 */
export function independentTweakersLiveHealthDoctorChecks(
  evidence: ReturnType<typeof inspectIndependentTweakersLiveHealth>,
): Check[] {
  if (evidence.state === "missing") return [];
  if (evidence.state !== "current") {
    return [{
      name: "independent Tweakers live health",
      ok: false,
      detail: `rejected ${evidence.state.replaceAll("_", " ")} evidence`,
    }];
  }
  const health = evidence.health;
  const concerns: string[] = [];
  if (health.lifecycleFailures.length > 0) {
    concerns.push(`${health.lifecycleFailures.length} lifecycle failure${health.lifecycleFailures.length === 1 ? "" : "s"}`);
  }
  if (health.appearance.status !== "normal" || !health.appearance.normalized) {
    concerns.push(`appearance ${health.appearance.status.replaceAll("_", " ")}${health.appearance.normalized ? "" : "; not normalized"}`);
  }
  if (concerns.length > 0) {
    return [{
      name: "independent Tweakers live health",
      ok: false,
      detail: `current PID ${health.pid} rejected: ${concerns.join("; ")}`,
    }];
  }
  return [{
    name: "independent Tweakers live health",
    ok: true,
    detail: `current PID ${health.pid}; ${health.initializedTweakIds.length} initialized tweaks; broker ${health.sharedHistoryBrokerState}; appearance normalized`,
  }];
}

/** Operator checks distinguish recorded source, packaged candidate, installed runtime, and live mux facts. */
export function accountRouterDoctorChecks(evidence: AccountRouterEvidence): Check[] {
  const checks: Check[] = [];
  if (evidence.configuration.state === "invalid" || evidence.configuration.state === "unsafe") {
    checks.push({
      name: "account router configuration",
      ok: false,
      detail: `staged configuration is ${evidence.configuration.state}; manual/direct fallback is required`,
    });
  } else if (evidence.configuration.pending) {
    const pending = evidence.configuration.pending;
    const active = evidence.live.state === "active" && evidence.live.status ? evidence.live.status.active : null;
    const matchesActive = active !== null
      && active.generation === pending.generation
      && active.fingerprint === pending.fingerprint
      && active.mode === pending.mode
      && active.policy === pending.policy;
    checks.push({
      name: "account router pending configuration",
      ok: matchesActive || (pending.mode === "manual" && active === null) ? true : "warn",
      detail: matchesActive
        ? `pending ${describePending(pending)} matches authenticated active runtime`
        : active
          ? `pending ${describePending(pending)}; authenticated active ${describeActive(active)}; restart required`
          : `pending ${describePending(pending)}; no authenticated mux is running`,
    });
  }

  const muxBacked = evidence.configuration.pending?.schemaVersion === 2 || evidence.configuration.pending?.schemaVersion === 3;
  if (evidence.configuration.state === "not_staged" || (evidence.configuration.state === "manual" && !muxBacked)) {
    appendAccountRouterLiveCheck(checks, evidence, false);
    return appendAccountBrokerCheck(checks, evidence, false);
  }

  if (muxBacked) {
    checks.push({
      name: "account history adoption",
      ok: evidence.historyAdoption.state === "adopted" ? true : false,
      detail: evidence.historyAdoption.state === "adopted"
        ? evidence.configuration.pending?.mode === "manual"
          ? "adopted offline history evidence is valid; Manual remains mux-backed for history and assigns new threads to the primary account"
          : "adopted offline history evidence is valid"
        : `mux candidate is blocked: history adoption is ${evidence.historyAdoption.state.replaceAll("_", " ")}`,
    });
  }

  const source = artifactCheck("account router source", evidence.source, null);
  const candidate = artifactCheck("account router candidate", evidence.candidate, evidence.source.version);
  const installed = artifactCheck("account router installed", evidence.installed, evidence.candidate.version);
  checks.push(source, candidate, installed);
  appendAccountRouterLiveCheck(checks, evidence, true, evidence.configuration.pending?.mode === "manual");
  return appendAccountBrokerCheck(checks, evidence, evidence.configuration.pending?.schemaVersion === 3);
}

function appendAccountRouterLiveCheck(
  checks: Check[],
  evidence: AccountRouterEvidence,
  expected: boolean,
  manualIsExpected = false,
): Check[] {
  if (!expected && evidence.live.state === "not_running") return checks;
  const live: Check = evidence.live.state === "active" && evidence.live.status
    ? describeLiveHealth(evidence.live.status, manualIsExpected)
    : {
      name: "account router live",
      ok: evidence.live.state === "unavailable" ? expected ? false : "warn" : expected ? "warn" : true,
      detail: expected
        ? evidence.live.state.replaceAll("_", " ")
        : `${evidence.live.state.replaceAll("_", " ")}; direct/manual has no mux`,
    };
  checks.push(live);
  return checks;
}

/**
 * Broker evidence is independent of the legacy mux socket. Only a v3 staged
 * configuration requires it; older staged formats retain their legacy doctor
 * verdicts until they are explicitly migrated.
 */
function appendAccountBrokerCheck(
  checks: Check[],
  evidence: AccountRouterEvidence,
  expected: boolean,
): Check[] {
  if (!expected && evidence.broker.state === "not_running") return checks;
  if (evidence.broker.state !== "active" || !evidence.broker.status) {
    checks.push({
      name: "account broker live",
      ok: expected ? (evidence.broker.state === "unavailable" ? false : "warn") : "warn",
      detail: expected
        ? `shared broker ${evidence.broker.state.replaceAll("_", " ")}`
        : `${evidence.broker.state.replaceAll("_", " ")}; no v3 broker is staged`,
    });
    return checks;
  }
  const broker = evidence.broker.status;
  const concerns: string[] = [];
  let ok: Check["ok"] = true;
  if (broker.state !== "available") {
    ok = false;
    concerns.push(`broker ${broker.state}`);
  }
  if (broker.pendingHandoffs.ambiguousCount > 0) {
    ok = false;
    concerns.push(`${broker.pendingHandoffs.ambiguousCount} ambiguous handoff${broker.pendingHandoffs.ambiguousCount === 1 ? "" : "s"}`);
  }
  if (broker.registeredClients.total === 0 || !broker.browserEvidence.observed || broker.pendingHandoffs.pendingCount > 0) {
    if (ok === true) ok = "warn";
    if (broker.registeredClients.total === 0) concerns.push("no registered desktop clients");
    if (!broker.browserEvidence.observed) concerns.push("browser evidence not observed");
    if (broker.pendingHandoffs.pendingCount > 0) concerns.push(`${broker.pendingHandoffs.pendingCount} pending handoff${broker.pendingHandoffs.pendingCount === 1 ? "" : "s"}`);
  }
  checks.push({
    name: "account broker live",
    ok,
    detail: `authenticated shared broker; ${broker.registeredClients.total} registered desktop ${broker.registeredClients.total === 1 ? "client" : "clients"}; ${broker.residentChildren}/${broker.maxResidentChildren} resident children; held work ${broker.heldWorkCount}${concerns.length ? `; ${concerns.join("; ")}` : ""}`,
  });
  return checks;
}

function describeLiveHealth(
  status: NonNullable<AccountRouterEvidence["live"]["status"]>,
  manualIsExpected: boolean,
): Check {
  const concerns: string[] = [];
  let ok: Check["ok"] = true;
  if (status.protocolState !== "supported") {
    ok = false;
    concerns.push(`protocol ${status.protocolState}; routing paused`);
  }
  if (status.degradedReason) {
    ok = false;
    concerns.push(`degraded ${status.degradedReason.replaceAll("_", " ")}; routing paused`);
  }
  if ((status.active.mode === "manual" && !manualIsExpected) || status.active.mode === "direct_fallback") {
    if (ok === true) ok = "warn";
    concerns.push(`${status.active.mode.replaceAll("_", " ")} is active; quota-aware routing is paused`);
  }
  if (status.restartRequired) {
    if (ok === true) ok = "warn";
    concerns.push("restart required before pending intent can apply");
  }
  return {
    name: "account router live",
    ok,
    detail: `authenticated ${describeActive(status.active)}${concerns.length ? `; ${concerns.join("; ")}` : ""}`,
  };
}

function describePending(pending: NonNullable<AccountRouterEvidence["configuration"]["pending"]>): string {
  return `${pending.mode.replaceAll("_", " ")}${pending.policy ? ` (${pending.policy})` : ""}; ${pending.generation === null ? "legacy v1" : `generation ${pending.generation}; ${pending.fingerprint?.slice(0, 15)}…`}`;
}

function describeActive(active: NonNullable<AccountRouterEvidence["live"]["status"]>["active"]): string {
  return `${active.mode.replaceAll("_", " ")}${active.policy ? ` (${active.policy})` : ""}; ${active.generation === null ? active.fairnessPrecision ?? "legacy v1" : `generation ${active.generation}; ${active.fingerprint?.slice(0, 15)}…`}`;
}

function artifactCheck(
  name: string,
  artifact: AccountRouterArtifactEvidence | AccountRouterSourceEvidence,
  expectedVersion: string | null,
): Check {
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
  if (artifact.state === "unavailable") {
    return {
      name,
      ok: "warn",
      detail: artifact.unavailableReason === "registration_stale"
        ? "registered development checkout is stale"
        : "no registered development checkout",
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
