import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MCP_LIFECYCLE_GUARD_LABEL,
  MCP_LIFECYCLE_LABELS,
  MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES,
  MCP_LIFECYCLE_REAPER_LABEL,
  assertMcpLifecycleLabelStates,
  defaultMcpLifecycleSourceRoot,
  expectedMcpLifecycleLabelStates,
  verifyMcpLifecyclePackage,
  type McpLifecycleLabelState,
  type McpLifecycleManifest,
  type McpLifecycleResolvedAsset,
} from "./mcp-lifecycle-install.js";

export type McpLifecycleCheckStatus = "ok" | "warn" | "error";

export interface McpLifecycleHealthCheck {
  id: string;
  name: string;
  status: McpLifecycleCheckStatus;
  detail: string;
  recommendedAction: string | null;
}

export interface McpLifecycleRepairPreview {
  sourceRoot: string;
  targetHome: string;
  changedAssets: Array<{
    id: string;
    destination: string;
    backup: string;
    kind: string;
  }>;
  labels: readonly string[];
  labelStates: readonly McpLifecycleLabelState[] | null;
  labelTransitions: Array<{
    label: string;
    before: McpLifecycleLabelState | null;
    intended: McpLifecycleLabelState | null;
    operation: "preserve-disabled-unloaded" | "preserve-enabled-loaded" | "reload-reaper" | "blocked";
  }>;
  preservedRuntimeFiles: readonly string[];
  reloadEligible: boolean;
  reloadDeferredReason: string | null;
  reloadPlan: string[];
  rollbackPlan: string[];
}

export interface McpLifecycleHealthReport {
  schemaVersion: 1;
  checkedAt: string;
  status: McpLifecycleCheckStatus;
  title: string;
  checks: McpLifecycleHealthCheck[];
  preview: McpLifecycleRepairPreview;
}

export interface McpLifecycleHealthDependencies {
  now?: () => Date;
  pathExists?: (path: string) => boolean;
  readFile?: (path: string) => Buffer;
  mode?: (path: string) => number;
  labelInstances?: (label: string) => number | undefined;
  /** Exact injected launchd state for hermetic repair and candidate tests. */
  labelStates?: (expected: readonly McpLifecycleLabelState[]) => readonly McpLifecycleLabelState[] | undefined;
}

export interface McpLifecycleHealthOptions {
  targetHome: string;
  backupRoot: string;
  managedReceiptPath?: string;
  sourceRoot?: string;
  deep?: boolean;
}

export function inspectMcpLifecycleHealth(
  options: McpLifecycleHealthOptions,
  dependencies: McpLifecycleHealthDependencies = {},
): McpLifecycleHealthReport {
  const now = dependencies.now ?? (() => new Date());
  const pathExists = dependencies.pathExists ?? existsSync;
  const readFile = dependencies.readFile ?? ((path: string) => readFileSync(path));
  const mode = dependencies.mode ?? ((path: string) => statSync(path).mode & 0o777);
  const labelInstances = dependencies.labelInstances ?? launchdLabelInstances;
  const checkedAt = now();
  const checks: McpLifecycleHealthCheck[] = [];
  let assets: McpLifecycleResolvedAsset[] = [];
  let manifest: McpLifecycleManifest | null = null;
  let expectedLabelStates: readonly McpLifecycleLabelState[] = [];
  let sourceRoot = options.sourceRoot ?? defaultMcpLifecycleSourceRoot();

  try {
    const verified = verifyMcpLifecyclePackage({
      sourceRoot,
      targetHome: options.targetHome,
    });
    sourceRoot = verified.sourceRoot;
    assets = verified.assets;
    manifest = verified.manifest;
    expectedLabelStates = expectedMcpLifecycleLabelStates(verified);
    checks.push(check(
      "package",
      "Canonical package",
      "ok",
      `v${verified.manifest.package.version}; lifecycle schema v${verified.manifest.lifecycle_schema_version}`,
    ));
    checks.push(check(
      "policy",
      "Cleanup authority",
      verified.manifest.policy.automatic_signal_owner === "reaper"
        && verified.manifest.policy.guard_mode === "notification-only"
        && verified.manifest.policy.lane_modes.detached_wrapper === "automatic"
        && verified.manifest.policy.lane_modes.exact_standalone_app_server === "automatic"
        && verified.manifest.policy.lane_modes.standalone_orphan === "observation_only"
        && verified.manifest.policy.lane_modes.claude_idle === "observation_only"
        ? "ok"
        : "error",
      "Reaper is the sole automatic signal owner for verified detached wrappers and exact standalone app-server trees; generic legacy findings remain observation-only.",
    ));
  } catch (error) {
    checks.push(check(
      "package",
      "Canonical package",
      "error",
      errorMessage(error),
      "Restore the bundled lifecycle package before repair.",
    ));
  }

  if (options.managedReceiptPath && manifest) {
    checks.push(managedArtifactProof(
      options.managedReceiptPath,
      manifest,
      expectedLabelStates,
      pathExists,
      readFile,
    ));
  }

  for (const asset of assets) {
    const present = pathExists(asset.destinationPath);
    const matches = present
      && (!options.deep || (
        mode(asset.destinationPath) === asset.mode
        && readFile(asset.destinationPath).equals(asset.content)
      ));
    checks.push(check(
      `asset:${asset.asset.id}`,
      asset.asset.id,
      matches ? "ok" : "error",
      !present
        ? `missing: ${asset.destinationPath}`
        : matches
          ? options.deep ? "installed bytes and mode match" : "installed"
          : `drifted bytes or mode: ${asset.destinationPath}`,
      matches ? null : "Preview lifecycle repair; state and receipts will be preserved.",
    ));
  }

  const labelObservation = observeLabelStates(expectedLabelStates, dependencies, labelInstances);
  const labelStates = labelObservation.states;
  const labelStateError = labelObservation.error;
  const statesByLabel = new Map(labelStates?.map((state) => [state.label, state]));
  for (const label of MCP_LIFECYCLE_LABELS) {
    const state = statesByLabel.get(label);
    const disposition = state ? labelDisposition(state) : null;
    checks.push(check(
      `job:${label}`,
      label,
      disposition?.status ?? "error",
      disposition?.detail ?? `launchd state unavailable or inconsistent: ${labelStateError ?? "unknown state"}`,
      disposition?.status === "ok" ? null : "Stop repair until this label has an exact disabled/loaded state.",
    ));
  }

  const lifecycleStatusPath = join(options.targetHome, ".codex", "tmp", "codex-mcp-lifecycle-status.json");
  const lifecycleStatus = readStatus(lifecycleStatusPath, pathExists, readFile);
  const lifecycleState = statusHealth(lifecycleStatus, checkedAt, new Set([1, 2]));
  checks.push(check(
    "status:reaper",
    "Reaper status",
    lifecycleState.status,
    lifecycleState.detail,
    lifecycleState.status === "ok" ? null : "Do not reload jobs until a current idle status is available.",
  ));

  const guardStatusPath = join(options.targetHome, ".codex", "tmp", "codex-mcp-guard-status.json");
  const guardStatus = readStatus(guardStatusPath, pathExists, readFile);
  const guardLifecycle = statesByLabel.get(MCP_LIFECYCLE_GUARD_LABEL);
  const guardState = guardLifecycle?.disabled === true && guardLifecycle.loadedInstances === 0
    ? { status: "ok" as const, detail: "intentionally disabled and unloaded" }
    : guardHeartbeatHealth(guardStatus, lifecycleStatus, checkedAt, manifest);
  checks.push(check(
    "status:guard",
    "Guard heartbeat",
    guardState.status,
    guardState.detail,
    guardState.status === "ok" ? null : "Do not repair or activate Guard automatically; require an exact lifecycle state.",
  ));

  if (options.deep) {
    const receipt = inspectLastReceipt(
      join(options.targetHome, ".codex", "tmp", "codex-mcp-lifecycle-actions.jsonl"),
      pathExists,
      readFile,
    );
    checks.push(check(
      "receipt",
      "Action receipt",
      receipt.status,
      receipt.detail,
      receipt.status === "error" ? "Inspect the corrupt receipt before managed adoption." : null,
    ));
  }

  checks.push(check(
    "compatibility-labels",
    "Compatibility labels",
    "ok",
    "Current launchd labels and installed paths are preserved; rename deferred.",
  ));

  const preview = buildRepairPreview({
    sourceRoot,
    targetHome: options.targetHome,
    backupRoot: options.backupRoot,
    assets,
    lifecycleStatus,
    guardState,
    checkedAt,
    pathExists,
    readFile,
    mode,
    labelStates,
    expectedLabelStates,
    labelStateError,
  });
  const status = aggregate(checks);
  return {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    status,
    title: status === "ok"
      ? "MCP lifecycle is healthy"
      : status === "warn"
        ? "MCP lifecycle needs review"
        : "MCP lifecycle needs repair",
    checks,
    preview,
  };
}

function managedArtifactProof(
  path: string,
  manifest: McpLifecycleManifest,
  expectedLabelStates: readonly McpLifecycleLabelState[],
  pathExists: (path: string) => boolean,
  readFile: (path: string) => Buffer,
): McpLifecycleHealthCheck {
  if (!pathExists(path)) {
    return check(
      "managed-proof",
      "Managed artifact proof",
      "warn",
      "No managed-adoption receipt exists yet.",
      "Use the confirmed managed-adoption flow after candidate validation.",
    );
  }
  try {
    const receipt = JSON.parse(readFile(path).toString("utf8")) as Record<string, unknown>;
    const expectedDigests = Object.fromEntries(
      manifest.assets.map((asset) => [asset.id, asset.source_sha256]),
    );
    const labels = receipt.labels;
    const digests = receipt.assetDigests;
    const compatibleV2 = receipt.schemaVersion === 2
      && receipt.packageVersion === manifest.package.version
      && receipt.lifecycleSchemaVersion === manifest.lifecycle_schema_version
      && receipt.policyVersion === manifest.policy_version
      && receipt.matcherRegistryVersion === manifest.matcher_registry_version
      && Array.isArray(labels)
      && labels.length === MCP_LIFECYCLE_LABELS.length
      && labels.every((label, index) => label === MCP_LIFECYCLE_LABELS[index])
      && digests !== null
      && typeof digests === "object"
      && !Array.isArray(digests)
      && JSON.stringify(sortedRecord(digests as Record<string, unknown>))
        === JSON.stringify(sortedRecord(expectedDigests))
      && receipt.compatibility === "current labels and paths preserved; rename deferred"
      && receiptTransitionsMatch(receipt.labelTransitions, expectedLabelStates);
    return check(
      "managed-proof",
      "Managed artifact proof",
      compatibleV2 ? "ok" : receipt.schemaVersion === 1 ? "warn" : "error",
      compatibleV2
        ? `v${manifest.package.version}; ${manifest.assets.length} artifact digests; current labels and paths preserved; rename deferred`
        : receipt.schemaVersion === 1
          ? "Managed-adoption receipt uses schema v1; only explicit `mcp-lifecycle adopt --apply` may upgrade a recognized predecessor."
          : "Managed-adoption receipt does not match the canonical package, labels, or compatibility contract.",
      compatibleV2 ? null : "Stop ordinary repair and use the explicit verified adoption gate when applicable.",
    );
  } catch {
    return check(
      "managed-proof",
      "Managed artifact proof",
      "error",
      "Managed-adoption receipt is unreadable.",
      "Stop repair and inspect the receipt before adoption.",
    );
  }
}

function sortedRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function buildRepairPreview(input: {
  sourceRoot: string;
  targetHome: string;
  backupRoot: string;
  assets: McpLifecycleResolvedAsset[];
  lifecycleStatus: Record<string, unknown> | null;
  guardState: { status: McpLifecycleCheckStatus; detail: string };
  checkedAt: Date;
  pathExists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  mode: (path: string) => number;
  labelStates: readonly McpLifecycleLabelState[] | undefined;
  expectedLabelStates: readonly McpLifecycleLabelState[];
  labelStateError: string | null;
}): McpLifecycleRepairPreview {
  const changedAssets = input.assets
    .filter((asset) => (
      !input.pathExists(asset.destinationPath)
      || input.mode(asset.destinationPath) !== asset.mode
      || !input.readFile(asset.destinationPath).equals(asset.content)
    ))
    .map((asset) => ({
      id: asset.asset.id,
      destination: asset.destinationPath,
      backup: join(input.backupRoot, relative(input.targetHome, asset.destinationPath)),
      kind: asset.asset.kind,
    }));
  const state = statusHealth(input.lifecycleStatus, input.checkedAt, new Set([1, 2]));
  const terminating = lifecycleHasTerminatingTree(input.lifecycleStatus);
  const labelError = input.labelStateError ?? labelTransitionError(input.labelStates);
  const reloadDeferredReason = input.guardState.status !== "ok"
    ? `Guard heartbeat problem: ${input.guardState.detail}`
    : labelError
    ? labelError
    : state.status !== "ok"
    ? state.detail
    : terminating
      ? "lifecycle status reports a terminating tree"
      : null;
  return {
    sourceRoot: input.sourceRoot,
    targetHome: input.targetHome,
    changedAssets,
    labels: MCP_LIFECYCLE_LABELS,
    labelStates: input.labelStates ?? null,
    labelTransitions: MCP_LIFECYCLE_LABELS.map((label) => {
      const before = input.labelStates?.find((state) => state.label === label) ?? null;
      const candidate = input.expectedLabelStates.find((state) => state.label === label) ?? null;
      return {
        label,
        before,
        intended: before && candidate ? { ...before, plistSha256: candidate.plistSha256 } : null,
        operation: !before || !candidate ? "blocked" : label === MCP_LIFECYCLE_GUARD_LABEL
          ? before.disabled ? "preserve-disabled-unloaded" : "preserve-enabled-loaded"
          : "reload-reaper",
      };
    }),
    preservedRuntimeFiles: MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES,
    reloadEligible: reloadDeferredReason === null,
    reloadDeferredReason,
    reloadPlan: [
      "Preserve Guard disabled/unloaded without bootout, bootstrap, enable, or kickstart.",
      "Preserve an already enabled/loaded Guard without changing its policy state.",
      `Reload only the enabled ${MCP_LIFECYCLE_REAPER_LABEL} and verify exactly one registration.`,
    ],
    rollbackPlan: [
      "Restore every replaced asset from the transaction backup.",
      "Restore each label's frozen disabled/loaded pair independently.",
      "Never bootstrap, enable, kickstart, or treat a disabled Guard as missing.",
      "Verify reaper status and Guard disposition independently before committing the receipt.",
    ],
  };
}

function observeLabelStates(
  expected: readonly McpLifecycleLabelState[],
  dependencies: McpLifecycleHealthDependencies,
  legacyInstances: (label: string) => number | undefined,
): { states: readonly McpLifecycleLabelState[] | undefined; error: string | null } {
  if (expected.length !== MCP_LIFECYCLE_LABELS.length) {
    return { states: undefined, error: "verified package did not provide both label plists" };
  }
  try {
    const states = dependencies.labelStates
      ? dependencies.labelStates(expected)
      : dependencies.labelInstances
        ? expected.map((candidate) => {
          const instances = legacyInstances(candidate.label);
          if (instances !== 0 && instances !== 1) throw new Error(`legacy loaded count is ${String(instances)}`);
          return {
            ...candidate,
            disabled: candidate.label === MCP_LIFECYCLE_GUARD_LABEL ? instances === 0 : false,
            loadedInstances: instances as 0 | 1,
          };
        })
        : readLaunchdLabelStates(expected);
    assertMcpLifecycleLabelStates(states, expected);
    return { states, error: null };
  } catch (error) {
    return { states: undefined, error: errorMessage(error) };
  }
}

function readLaunchdLabelStates(
  expected: readonly McpLifecycleLabelState[],
): readonly McpLifecycleLabelState[] | undefined {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return undefined;
  const uid = process.getuid();
  const disabled = spawnSync("launchctl", ["print-disabled", `gui/${uid}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  if (disabled.status !== 0) return undefined;
  const output = `${String(disabled.stdout ?? "")}\n${String(disabled.stderr ?? "")}`;
  return expected.map((candidate) => {
    const isDisabled = parseLaunchdDisabledState(output, candidate.label);
    if (isDisabled === null) throw new Error(`print-disabled did not contain ${candidate.label}`);
    const loaded = spawnSync("launchctl", ["print", `gui/${uid}/${candidate.label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    if (loaded.status !== 0 && loaded.status !== 113) {
      throw new Error(`launchctl print failed for ${candidate.label}`);
    }
    return {
      ...candidate,
      disabled: isDisabled,
      loadedInstances: loaded.status === 0 ? 1 : 0,
      // Health observes the actual installed plist before a transaction. It
      // must never copy the candidate hash into a frozen-before record.
      plistSha256: safeInstalledPlistSha256(candidate.plistPath),
    };
  });
}

function safeInstalledPlistSha256(path: string): string {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || Number(before.nlink) !== 1 || Number(before.size) > 1024 * 1024) {
      throw new Error("installed plist is not a safe regular file");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      Number(before.dev) !== Number(after.dev)
      || Number(before.ino) !== Number(after.ino)
      || Number(before.nlink) !== Number(after.nlink)
      || Number(before.size) !== Number(after.size)
      || bytes.length !== Number(after.size)
    ) {
      throw new Error("installed plist changed while it was being read");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseLaunchdDisabledState(output: string, label: string): boolean | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`(?:\\"|')?${escaped}(?:\\"|')?\\s*=>\\s*(true|false|disabled|enabled)(?=\\s|$|[,}])`, "i"));
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === "true" || match[1].toLowerCase() === "disabled";
}

function labelDisposition(state: McpLifecycleLabelState): { status: McpLifecycleCheckStatus; detail: string } {
  if (state.label === MCP_LIFECYCLE_GUARD_LABEL && state.disabled && state.loadedInstances === 0) {
    return { status: "ok", detail: "intentionally disabled and unloaded; no auto-fix" };
  }
  if (state.label === MCP_LIFECYCLE_GUARD_LABEL && !state.disabled && state.loadedInstances === 1) {
    return { status: "ok", detail: "enabled and loaded from a previously deliberate activation; policy preserved" };
  }
  if (state.label === MCP_LIFECYCLE_REAPER_LABEL && !state.disabled && state.loadedInstances === 1) {
    return { status: "ok", detail: "enabled and registered exactly once" };
  }
  return { status: "error", detail: "disabled/loaded pair is inconsistent" };
}

function labelTransitionError(states: readonly McpLifecycleLabelState[] | undefined): string | null {
  if (!states) return "MCP lifecycle label state is unavailable";
  for (const state of states) {
    if (labelDisposition(state).status !== "ok") return `${state.label} has an inconsistent disabled/loaded pair`;
  }
  return null;
}

function receiptTransitionsMatch(
  raw: unknown,
  expectedLabelStates: readonly McpLifecycleLabelState[],
): boolean {
  if (!Array.isArray(raw) || raw.length !== MCP_LIFECYCLE_LABELS.length) return false;
  // The package verifier binds actual absolute paths during repair. Health
  // only validates receipt shape and exact labels here; candidate identity is
  // still proven by package/version/digest fields above.
  const seen = new Set<string>();
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const transition = value as Record<string, unknown>;
    const before = transition.before;
    const intended = transition.intended;
    const observed = transition.observed;
    if (typeof transition.label !== "string" || !MCP_LIFECYCLE_LABELS.includes(transition.label as typeof MCP_LIFECYCLE_LABELS[number]) || seen.has(transition.label)
      || !validReceiptLabelState(before, transition.label, expectedLabelStates)
      || !validReceiptLabelState(intended, transition.label, expectedLabelStates, true)
      || !validReceiptLabelState(observed, transition.label, expectedLabelStates, true)
      || !sameReceiptPolicyAndPath(before as McpLifecycleLabelState, intended as McpLifecycleLabelState)
      || !sameReceiptLabelState(intended as McpLifecycleLabelState, observed as McpLifecycleLabelState)
      || !validReceiptOperations(transition.operationsAttempted, before as McpLifecycleLabelState)) return false;
    seen.add(transition.label);
  }
  return seen.size === MCP_LIFECYCLE_LABELS.length;
}

function validReceiptLabelState(
  value: unknown,
  label: string,
  expectedLabelStates: readonly McpLifecycleLabelState[],
  requireCandidateHash = false,
): value is McpLifecycleLabelState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const expected = expectedLabelStates.find((candidate) => candidate.label === label);
  if (!expected || state.label !== label || typeof state.disabled !== "boolean"
    || (state.loadedInstances !== 0 && state.loadedInstances !== 1)
    || state.plistPath !== expected.plistPath
    || !/^[a-f0-9]{64}$/.test(String(state.plistSha256))
    || (requireCandidateHash && state.plistSha256 !== expected.plistSha256)) return false;
  return label === MCP_LIFECYCLE_GUARD_LABEL
    ? (state.disabled === true && state.loadedInstances === 0) || (state.disabled === false && state.loadedInstances === 1)
    : state.disabled === false && state.loadedInstances === 1;
}

function sameReceiptPolicyAndPath(left: McpLifecycleLabelState, right: McpLifecycleLabelState): boolean {
  return left.label === right.label
    && left.disabled === right.disabled
    && left.loadedInstances === right.loadedInstances
    && left.plistPath === right.plistPath;
}

function validReceiptOperations(value: unknown, before: McpLifecycleLabelState): boolean {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") return false;
  if (before.label === MCP_LIFECYCLE_GUARD_LABEL) {
    return value[0] === (before.disabled ? "preserve-disabled-unloaded" : "preserve-enabled-loaded");
  }
  return value[0] === "preserve-enabled-loaded" || value[0] === "bootout-bootstrap-verify";
}

function sameReceiptLabelState(left: McpLifecycleLabelState, right: McpLifecycleLabelState): boolean {
  return left.label === right.label
    && left.disabled === right.disabled
    && left.loadedInstances === right.loadedInstances
    && left.plistPath === right.plistPath
    && left.plistSha256 === right.plistSha256;
}

function readStatus(
  path: string,
  pathExists: (path: string) => boolean,
  readFile: (path: string) => Buffer,
): Record<string, unknown> | null {
  if (!pathExists(path)) return null;
  try {
    const value = JSON.parse(readFile(path).toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function statusHealth(
  value: Record<string, unknown> | null,
  now: Date,
  supportedSchemas: Set<number>,
): { status: McpLifecycleCheckStatus; detail: string } {
  if (!value) return { status: "error", detail: "missing or unreadable status" };
  const schema = value.schema_version;
  if (typeof schema !== "number" || !supportedSchemas.has(schema)) {
    return { status: "error", detail: `unsupported schema ${String(schema)}` };
  }
  const generated = value.generated_at;
  const generatedMs = typeof generated === "number"
    ? generated * 1_000
    : typeof generated === "string"
      ? Date.parse(generated)
      : Number.NaN;
  const ageMs = now.getTime() - generatedMs;
  if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > 180_000) {
    return { status: "error", detail: "status is stale or has an invalid timestamp" };
  }
  const job = value.job;
  if (!job || typeof job !== "object" || Array.isArray(job) || (job as Record<string, unknown>).ok !== true) {
    return { status: "error", detail: "last job did not report success" };
  }
  return { status: "ok", detail: `schema v${schema}; ${Math.max(0, Math.floor(ageMs / 1_000))} seconds old` };
}

/**
 * An enabled Guard is an independent observer with a deliberately strict v3
 * contract.  Do not treat the generic reaper heartbeat schema as sufficient:
 * the installer must fail closed before it can stage files or reload the
 * reaper when the already-enabled Guard cannot prove its no-mutation role.
 */
function guardHeartbeatHealth(
  value: Record<string, unknown> | null,
  lifecycleStatus: Record<string, unknown> | null,
  now: Date,
  manifest: McpLifecycleManifest | null,
): { status: McpLifecycleCheckStatus; detail: string } {
  const heartbeat = statusHealth(value, now, new Set([3]));
  if (heartbeat.status !== "ok") return heartbeat;
  const contractError = guardV3ContractError(value!, lifecycleStatus, manifest);
  return contractError
    ? { status: "error", detail: `Guard v3 heartbeat contract is invalid: ${contractError}` }
    : heartbeat;
}

function guardV3ContractError(
  value: Record<string, unknown>,
  lifecycleStatus: Record<string, unknown> | null,
  manifest: McpLifecycleManifest | null,
): string | null {
  if (!manifest) return "canonical package identity is unavailable";
  if (!hasExactKeys(value, [
    "schema", "schema_version", "generated_at", "producer_version", "authority", "mutationCapabilities",
    "taskDataAccess", "state", "selected_producer", "unavailable_reasons", "alerts", "explanations",
    "sample_count", "reset_reason", "schema_versions", "matcher", "ownership", "counts", "cpu_window",
    "system_memory", "job",
  ])) return "document fields are missing, malformed, or not Guard v3 fields";
  if (value.schema !== "mcp-guard-status.v3") return "schema identity is missing or invalid";
  if (!isFiniteNumber(value.generated_at)) return "generated timestamp is missing or invalid";
  if (value.producer_version !== manifest.package.version) return "producer version does not match the canonical package";
  if (value.authority !== "observation-and-notification-only") return "authority is missing or invalid";
  if (value.taskDataAccess !== "none") return "task-data access declaration is missing or invalid";
  if (!Array.isArray(value.mutationCapabilities) || value.mutationCapabilities.length !== 0) {
    return "mutation capabilities declaration is missing or invalid";
  }

  const state = value.state;
  if (state !== "unavailable" && state !== "warning" && state !== "expected_fanout" && state !== "healthy") {
    return "state is missing or invalid";
  }
  if (value.selected_producer !== state) return "selected producer does not match state";

  const unavailableReasons = value.unavailable_reasons;
  if (!Array.isArray(unavailableReasons) || !unavailableReasons.every(isGuardReason)) {
    return "unavailable reasons are missing or invalid";
  }
  if ((state === "unavailable") !== (unavailableReasons.length > 0)) {
    return "state and unavailable reasons disagree";
  }

  const alerts = value.alerts;
  if (!Array.isArray(alerts) || !alerts.every(isGuardAlert)
    || new Set(alerts.map((alert) => (alert as Record<string, unknown>).id)).size !== alerts.length) {
    return "alerts are missing or invalid";
  }
  if ((state === "warning") !== (alerts.length > 0)) return "state and alerts disagree";

  const explanations = value.explanations;
  if (!Array.isArray(explanations)
    || explanations.length !== 1
    || explanations[0] !== "Guard observes process health and may notify; it does not control processes or access task data.") {
    return "explanations are missing or invalid";
  }
  if (!isNonnegativeInteger(value.sample_count) || value.sample_count > 5) return "sample count is missing or invalid";
  if (value.reset_reason !== null && !isNonemptyString(value.reset_reason)) return "reset reason is missing or invalid";

  const lifecycleSchemaVersion = lifecycleStatus?.schema_version;
  const lifecycleJob = lifecycleStatus ? record(lifecycleStatus.job) : null;
  if (!lifecycleStatus
    || lifecycleSchemaVersion !== 2
    || lifecycleStatus.matcher_registry_version !== manifest.matcher_registry_version
    || lifecycleJob?.ok !== true
    || record(lifecycleStatus.counts) === null
    || !Array.isArray(lifecycleStatus.trees)) {
    return "companion lifecycle schema, matcher, counts, or trees are missing or invalid";
  }
  const schemaVersions = record(value.schema_versions);
  if (!schemaVersions
    || !hasExactKeys(schemaVersions, ["guard", "lifecycle"])
    || schemaVersions.guard !== 3
    || schemaVersions.lifecycle !== lifecycleSchemaVersion) {
    return "schema versions are missing or invalid";
  }

  const lifecycleGeneratedAt = lifecycleStatus?.generated_at;
  const matcher = record(value.matcher);
  if (!matcher
    || !hasExactKeys(matcher, ["expected", "observed", "freshness", "lifecycle_generated_at"])
    || matcher.expected !== manifest.matcher_registry_version
    || matcher.observed !== manifest.matcher_registry_version
    || matcher.freshness !== "fresh"
    || !isFiniteNumber(matcher.lifecycle_generated_at)
    || matcher.lifecycle_generated_at !== lifecycleGeneratedAt) {
    return "matcher identity or lifecycle freshness is missing or invalid";
  }

  if (!isCountRecord(value.ownership)) return "ownership context is missing or invalid";
  const counts = record(value.counts);
  if (!counts
    || !hasExactKeys(counts, ["loaded_task_stacks", "logical_instances", "raw_processes", "rss_mib", "app_servers"])
    || !isNonnegativeInteger(counts.loaded_task_stacks)
    || !isCountRecord(counts.logical_instances)
    || !isNonnegativeInteger(counts.raw_processes)
    || !isNonnegativeInteger(counts.rss_mib)
    || !isNonnegativeInteger(counts.app_servers)) {
    return "count context is missing or invalid";
  }

  const cpuWindow = record(value.cpu_window);
  const cpuWindowError = !cpuWindow
    || !isNonnegativeInteger(cpuWindow.samples)
    || cpuWindow.samples !== value.sample_count
    || typeof cpuWindow.available !== "boolean"
    || (cpuWindow.available === false && !hasExactKeys(cpuWindow, ["samples", "available"]))
    || (cpuWindow.available === true && (!hasExactKeys(cpuWindow, ["samples", "available", "core_fractions", "minimum_core_fraction"])
      || !Array.isArray(cpuWindow.core_fractions)
      || cpuWindow.samples < 2
      || cpuWindow.core_fractions.length !== cpuWindow.samples - 1
      || !cpuWindow.core_fractions.every(isFiniteNumber)
      || !isFiniteNumber(cpuWindow.minimum_core_fraction)
      || cpuWindow.minimum_core_fraction !== Math.min(...cpuWindow.core_fractions)));
  if (cpuWindowError) return "CPU-window context is missing or invalid";

  const systemMemory = record(value.system_memory);
  const swap = systemMemory ? record(systemMemory.swap) : null;
  const systemMemoryError = !systemMemory
    || typeof systemMemory.available !== "boolean"
    || !swap
    || typeof swap.available !== "boolean"
    || (systemMemory.available === false && !hasExactKeys(systemMemory, ["available", "swap"]))
    || (systemMemory.available === true && (!hasExactKeys(systemMemory, ["available", "physical_ram_mib", "available_mib", "available_pct", "swap"])
      || !isNonnegativeInteger(systemMemory.physical_ram_mib)
      || !isNonnegativeInteger(systemMemory.available_mib)
      || !isFiniteNumber(systemMemory.available_pct)
      || systemMemory.available_pct < 0
      || systemMemory.available_pct > 100))
    || (swap.available === false && !hasExactKeys(swap, ["available"]))
    || (swap.available === true && (!hasOneOfExactKeys(swap, [
      ["available", "total_mib"],
      ["available", "used_mib"],
      ["available", "total_mib", "used_mib"],
    ])
      || (swap.total_mib !== undefined && !isNonnegativeInteger(swap.total_mib))
      || (swap.used_mib !== undefined && !isNonnegativeInteger(swap.used_mib))));
  if (systemMemoryError) {
    return "system-memory context is missing or invalid";
  }

  const job = record(value.job);
  if (!job || !hasExactKeys(job, ["ok", "mode", "error"])
    || job.ok !== true || job.mode !== "observation" || job.error !== null) {
    return "job result is missing or invalid";
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(value: Record<string, unknown> | null, expected: readonly string[]): boolean {
  return value !== null
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasOneOfExactKeys(value: Record<string, unknown>, expected: readonly (readonly string[])[]): boolean {
  return expected.some((keys) => hasExactKeys(value, keys));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCountRecord(value: unknown): boolean {
  const candidate = record(value);
  return candidate !== null && Object.values(candidate).every(isNonnegativeInteger);
}

function isGuardReason(value: unknown): boolean {
  const reason = record(value);
  return reason !== null
    && hasExactKeys(reason, ["code", "detail"])
    && isNonemptyString(reason.code)
    && isNonemptyString(reason.detail);
}

function isGuardAlert(value: unknown): boolean {
  const alert = record(value);
  return alert !== null
    && hasExactKeys(alert, ["id", "kind", "message", "evidence"])
    && isNonemptyString(alert.id)
    && isNonemptyString(alert.kind)
    && isNonemptyString(alert.message)
    && alert.kind === alert.id.split(":", 1)[0]
    && record(alert.evidence) !== null;
}

function lifecycleHasTerminatingTree(value: Record<string, unknown> | null): boolean {
  const trees = value?.trees;
  return Array.isArray(trees) && trees.some((tree) => (
    tree && typeof tree === "object" && !Array.isArray(tree)
    && (tree as Record<string, unknown>).state === "terminating"
  ));
}

function inspectLastReceipt(
  path: string,
  pathExists: (path: string) => boolean,
  readFile: (path: string) => Buffer,
): { status: McpLifecycleCheckStatus; detail: string } {
  if (!pathExists(path)) return { status: "warn", detail: "no action receipt exists yet" };
  try {
    const lines = readFile(path).toString("utf8").trim().split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return { status: "warn", detail: "action receipt is empty" };
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    const containsUnredactedCommand = [
      "raw_argv",
      "argv",
      "command",
      "commandLine",
      "command_line",
    ].some((field) => field in last);
    if (
      typeof last.tree_key !== "string"
      || typeof last.state !== "string"
      || containsUnredactedCommand
    ) {
      return { status: "error", detail: "last action receipt is invalid or unredacted" };
    }
    if (typeof last.action_id !== "string") {
      const pids = last.pids;
      const legacyFields = new Set(["timestamp", "tree_key", "state", "pids", "error"]);
      const isPrivacySafeLegacyReceipt = typeof last.timestamp === "number"
        && Number.isFinite(last.timestamp)
        && Array.isArray(pids)
        && pids.every((pid) => Number.isInteger(pid) && pid > 0)
        && last.error === null
        && Object.keys(last).every((field) => legacyFields.has(field));
      return isPrivacySafeLegacyReceipt
        ? { status: "warn", detail: "last receipt uses the privacy-safe legacy schema without action_id" }
        : { status: "error", detail: "last action receipt is invalid or unredacted" };
    }
    return { status: "ok", detail: `last verified receipt ${last.action_id}; state ${last.state}` };
  } catch {
    return { status: "error", detail: "action receipt JSONL is corrupt" };
  }
}

function launchdLabelInstances(label: string): number | undefined {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return undefined;
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  return result.status === 0 ? 1 : 0;
}

function check(
  id: string,
  name: string,
  status: McpLifecycleCheckStatus,
  detail: string,
  recommendedAction: string | null = null,
): McpLifecycleHealthCheck {
  return { id, name, status, detail, recommendedAction };
}

function aggregate(checks: McpLifecycleHealthCheck[]): McpLifecycleCheckStatus {
  if (checks.some((item) => item.status === "error")) return "error";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "ok";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
