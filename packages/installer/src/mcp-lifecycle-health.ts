import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  MCP_LIFECYCLE_LABELS,
  MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES,
  defaultMcpLifecycleSourceRoot,
  verifyMcpLifecyclePackage,
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
  let sourceRoot = options.sourceRoot ?? defaultMcpLifecycleSourceRoot();

  try {
    const verified = verifyMcpLifecyclePackage({
      sourceRoot,
      targetHome: options.targetHome,
    });
    sourceRoot = verified.sourceRoot;
    assets = verified.assets;
    manifest = verified.manifest;
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

  for (const label of MCP_LIFECYCLE_LABELS) {
    const instances = labelInstances(label);
    checks.push(check(
      `job:${label}`,
      label,
      instances === 1 ? "ok" : instances === undefined ? "warn" : "error",
      instances === undefined
        ? "launchd state unavailable"
        : `${instances} loaded instance${instances === 1 ? "" : "s"}`,
      instances === 1 ? null : "Reload only after lifecycle status is current and idle.",
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
  const guardState = statusHealth(guardStatus, checkedAt, new Set([1]));
  checks.push(check(
    "status:guard",
    "Guard heartbeat",
    guardState.status,
    guardState.detail,
    guardState.status === "ok" ? null : "Repair the notification-only guard heartbeat.",
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
    checkedAt,
    pathExists,
    readFile,
    mode,
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
    const compatible = receipt.schemaVersion === 1
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
      && receipt.compatibility === "current labels and paths preserved; rename deferred";
    return check(
      "managed-proof",
      "Managed artifact proof",
      compatible ? "ok" : "error",
      compatible
        ? `v${manifest.package.version}; ${manifest.assets.length} artifact digests; current labels and paths preserved; rename deferred`
        : "Managed-adoption receipt does not match the canonical package, labels, or compatibility contract.",
      compatible ? null : "Stop repair and re-run verified managed adoption.",
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
  checkedAt: Date;
  pathExists: (path: string) => boolean;
  readFile: (path: string) => Buffer;
  mode: (path: string) => number;
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
  const reloadDeferredReason = state.status !== "ok"
    ? state.detail
    : terminating
      ? "lifecycle status reports a terminating tree"
      : null;
  return {
    sourceRoot: input.sourceRoot,
    targetHome: input.targetHome,
    changedAssets,
    labels: MCP_LIFECYCLE_LABELS,
    preservedRuntimeFiles: MCP_LIFECYCLE_PRESERVED_RUNTIME_FILES,
    reloadEligible: reloadDeferredReason === null,
    reloadDeferredReason,
    reloadPlan: MCP_LIFECYCLE_LABELS.flatMap((label) => [
      `bootout gui/<uid>/${label}`,
      `bootstrap gui/<uid> ${label}.plist`,
      `verify exactly one gui/<uid>/${label}`,
    ]),
    rollbackPlan: [
      "Restore every replaced asset from the transaction backup.",
      "Restore the prior plist definitions.",
      "Reload the prior exact labels only when lifecycle status is current and idle.",
      "Verify state, status, guard heartbeat, and action receipts were preserved.",
    ],
  };
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
