import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  assertManagedMcpCanaryEvidence,
  type ManagedMcpCanaryEvidence,
  type ManagedMcpCanaryRunInput,
} from "./managed-mcp-canary-runner.js";

/**
 * A receipt emitted by the canonical managed-MCP runner must carry this
 * revision before it can be a terminal lifecycle result.  Revision one is
 * deliberately retained as parseable historical evidence, but cannot be
 * promoted by this adjudicator: it has no identity-bound lifecycle event
 * stream or root-preservation observations.
 */
export const MANAGED_MCP_CANARY_REQUIRED_SCHEMA_VERSION = 2 as const;
export const MANAGED_MCP_CANARY_ADJUDICATION_SCHEMA_VERSION = 1 as const;
export const MANAGED_MCP_LIFECYCLE_POLICY_ID = "managed-turn-idle-v3" as const;

export type ManagedMcpCanaryAdjudicationVerdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export type ManagedMcpCanaryAdjudicationReason =
  | "MISSING_EVIDENCE"
  | "CANARY_SCHEMA_V2_REQUIRED"
  | "INVALID_CANARY_EVIDENCE"
  | "CANDIDATE_BINDING_MISMATCH"
  | "MISSING_LIFECYCLE_EVENT_STREAM"
  | "MISSING_PROCESS_IDENTITY"
  | "MISSING_ROOT_PRESERVATION"
  | "MISSING_CLOSE_EVENT"
  | "MISSING_DEADLINE_EVIDENCE"
  | "MISSING_REPARENT_RECHECK"
  | "LIFECYCLE_POLICY_FAILURE"
  | "ADJUDICATION_INPUT_INVALID";

export interface ManagedMcpCanaryAdjudicationInput {
  /** Raw canonical runner receipt, not a screen scrape or a monitor log. */
  evidence: unknown;
  /**
   * Optional prepared-candidate binding.  When supplied, the runner's strict
   * source validator is also run; a mismatch is FAIL rather than a heuristic
   * inference.
   */
  expected?: ManagedMcpCanaryRunInput;
  adjudicatedAt?: string;
}

export interface ManagedMcpCanaryAdjudication {
  schemaVersion: typeof MANAGED_MCP_CANARY_ADJUDICATION_SCHEMA_VERSION;
  kind: "managed-mcp-canary-adjudication";
  policyId: typeof MANAGED_MCP_LIFECYCLE_POLICY_ID;
  verdict: ManagedMcpCanaryAdjudicationVerdict;
  reasons: readonly ManagedMcpCanaryAdjudicationReason[];
  evidence: {
    sha256: string | null;
    schemaVersion: number | null;
    transactionId: string | null;
    candidateSha256: string | null;
  };
  adjudicatedAt: string;
}

/**
 * Canonically classify a runner receipt.  It intentionally has no ability to
 * inspect a live app, a renderer, or a process table: those facts must already
 * be receipt-bound by the runner/adapter.  Missing v2 evidence is
 * INCONCLUSIVE, never a permissive pass.
 */
export function adjudicateManagedMcpCanary(
  input: ManagedMcpCanaryAdjudicationInput,
): ManagedMcpCanaryAdjudication {
  const evidence = input.evidence;
  const summary = summarizeEvidence(evidence);
  const at = input.adjudicatedAt ?? new Date().toISOString();
  if (!validTimestamp(at)) throw new Error("Managed MCP adjudication timestamp is invalid");

  if (!isRecord(evidence)) {
    return decision("INCONCLUSIVE", ["MISSING_EVIDENCE"], summary, at);
  }

  if (input.expected) {
    try {
      assertManagedMcpCanaryEvidence(evidence, input.expected);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = /bound|candidate|digest|transaction|version|receipt/i.test(message)
        ? "CANDIDATE_BINDING_MISMATCH"
        : "INVALID_CANARY_EVIDENCE";
      return decision("FAIL", [reason], summary, at);
    }
  }

  // Schema v1 lacked the receipt-bound event and retention predicates required
  // by the frozen v2 policy.  Treat it as historical diagnostics only.
  if (evidence.schemaVersion !== MANAGED_MCP_CANARY_REQUIRED_SCHEMA_VERSION) {
    return decision("INCONCLUSIVE", ["CANARY_SCHEMA_V2_REQUIRED"], summary, at);
  }

  const v2Reasons = requiredV2EvidenceReasons(evidence);
  if (v2Reasons.length > 0) return decision("INCONCLUSIVE", v2Reasons, summary, at);

  if (evidence.status !== "passed" || evidence.lifecycleVerdict !== "PASS") {
    return decision("FAIL", ["LIFECYCLE_POLICY_FAILURE"], summary, at);
  }
  return decision("PASS", [], summary, at);
}

/** Read a receipt from a caller-owned JSON file without treating its path as proof. */
export function adjudicateManagedMcpCanaryFile(
  evidenceFile: string,
  expected?: ManagedMcpCanaryRunInput,
): ManagedMcpCanaryAdjudication {
  if (!isAbsolute(evidenceFile) || resolve(evidenceFile) !== evidenceFile) {
    throw new Error("Managed MCP adjudicator requires an absolute evidence file path");
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return decision(
      "INCONCLUSIVE",
      ["MISSING_EVIDENCE"],
      { sha256: null, schemaVersion: null, transactionId: null, candidateSha256: null },
      new Date().toISOString(),
    );
  }
  return adjudicateManagedMcpCanary({ evidence, expected });
}

export function formatManagedMcpCanaryAdjudication(
  adjudication: ManagedMcpCanaryAdjudication,
): string {
  return `${JSON.stringify(adjudication)}\n`;
}

function requiredV2EvidenceReasons(value: Record<string, unknown>): ManagedMcpCanaryAdjudicationReason[] {
  const reasons: ManagedMcpCanaryAdjudicationReason[] = [];
  const events = value.lifecycleEvents;
  if (!Array.isArray(events) || events.length === 0) reasons.push("MISSING_LIFECYCLE_EVENT_STREAM");
  const identities = value.processIdentities;
  if (!Array.isArray(identities) || identities.length === 0) reasons.push("MISSING_PROCESS_IDENTITY");
  const predicates = isRecord(value.lifecyclePredicates) ? value.lifecyclePredicates : null;
  if (!predicates || predicates.rootCompletionSurvives !== true || predicates.busyMailboxPreserved !== true) {
    reasons.push("MISSING_ROOT_PRESERVATION");
  }
  if (!predicates || predicates.interruptEligible !== true || predicates.archiveOrFinalUnsubscribeEligible !== true) {
    reasons.push("MISSING_CLOSE_EVENT");
  }
  if (!predicates || predicates.deadlineObserved !== true) reasons.push("MISSING_DEADLINE_EVIDENCE");
  if (!predicates || predicates.priorIdentitiesAbsentAfterShutdown !== true || predicates.noReparentOrRespawn !== true) {
    reasons.push("MISSING_REPARENT_RECHECK");
  }
  return reasons;
}

function decision(
  verdict: ManagedMcpCanaryAdjudicationVerdict,
  reasons: readonly ManagedMcpCanaryAdjudicationReason[],
  evidence: ManagedMcpCanaryAdjudication["evidence"],
  adjudicatedAt: string,
): ManagedMcpCanaryAdjudication {
  return {
    schemaVersion: MANAGED_MCP_CANARY_ADJUDICATION_SCHEMA_VERSION,
    kind: "managed-mcp-canary-adjudication",
    policyId: MANAGED_MCP_LIFECYCLE_POLICY_ID,
    verdict,
    reasons: [...new Set(reasons)],
    evidence,
    adjudicatedAt,
  };
}

function summarizeEvidence(value: unknown): ManagedMcpCanaryAdjudication["evidence"] {
  if (!isRecord(value)) {
    return { sha256: null, schemaVersion: null, transactionId: null, candidateSha256: null };
  }
  return {
    sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    schemaVersion: typeof value.schemaVersion === "number" ? value.schemaVersion : null,
    transactionId: typeof value.transactionId === "string" ? value.transactionId : null,
    candidateSha256: isRecord(value.candidate) && typeof value.candidate.sha256 === "string"
      ? value.candidate.sha256
      : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function runCli(argv: readonly string[]): number {
  const [evidenceFile] = argv;
  if (!evidenceFile || argv.length !== 1) {
    process.stderr.write("usage: managed-mcp-canary-adjudicator.ts <absolute-evidence.json>\n");
    return 64;
  }
  let adjudication: ManagedMcpCanaryAdjudication;
  try {
    adjudication = adjudicateManagedMcpCanaryFile(evidenceFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`adjudicator error: ${message}\n`);
    return 64;
  }
  process.stdout.write(formatManagedMcpCanaryAdjudication(adjudication));
  return adjudication.verdict === "PASS" ? 0 : adjudication.verdict === "FAIL" ? 1 : 2;
}

if (process.argv[1] && /managed-mcp-canary-adjudicator\.(?:ts|js)$/.test(process.argv[1])) {
  process.exitCode = runCli(process.argv.slice(2));
}
