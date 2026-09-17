/** Navigation only; opening a section never authorizes a maintenance action. */
export type TweakersManagerSection = "overview" | "updates" | "doctor";
export function isTweakersManagerSection(value: unknown): value is TweakersManagerSection {
  return value === "overview" || value === "updates" || value === "doctor";
}

export interface DoctorReviewProgressV1 {
  version: 1;
  policy: "finish_automatically";
  stage: "preparing" | "explaining" | "ready" | "action_required" | "deferred" | "superseded";
  files: { total: number; accounted: number };
  questions: { total: number; completed: number; reused: number };
  entries: number;
  limitations: number;
  pause?: { code: "source_unavailable" | "provider_unavailable" | "usage_unavailable" | "no_progress" | "compatibility_required"; message: string; action: "retry" | "sign_in" | "inspect_evidence" | "repair" };
}
export interface DoctorReviewWorkV1 {
  version: 1;
  kind: "behavior" | "internal" | "evidence_needed" | "observation_limit";
  reasonCode: "changed_behavior" | "packaging" | "identical_content" | "opaque_binary" | "source_unavailable" | "unsupported_syntax" | "unclassified_change";
  question: string;
}
/** Independent Doctor contract. Deliberately separate from manager protocol 1. */
export type DoctorActionV1 = "reconnect" | "scan" | "repair" | "retry" | "update" | "decide" | "observe" | "preview_before" | "preview_after";
export interface DoctorFindingV1 {
  id: string;
  stage: "installation" | "storage" | "broker" | "compatibility" | "candidate";
  severity: "info" | "warning" | "error";
  reason: string;
  title: string;
  detail: string;
  evidence: string[];
}
export interface DoctorReportV1 {
  schemaVersion: 1;
  /** Additive capabilities; legacy reports never imply these guarantees. */
  workflowVersion?: 2;
  kind: "tweakers-independent-doctor";
  generatedAt: string;
  fingerprint: string;
  target: {
    kind: "independent";
    appPath: string;
    version: string | null;
    build: string | null;
    runtimeRoot: string | null;
    brokerRoot: string | null;
    nativeAppPath: string;
    nativeVersion: string | null;
    nativeBuild: string | null;
  };
  health: { state: "healthy" | "attention" | "blocked"; broker: string };
  update: {
    compatibility?: DoctorCompatibilityV1;
    review?: DoctorReviewProgressV1;
    execution?: { version: 2; trigger: "manual" | "available_update"; status: "running" | "ready" | "action_required" | "failed" | "superseded"; recoverable: boolean };
    state: "not_checked" | "checking" | "compatible" | "fixes_required" | "review_required";
    phase: string;
    candidateId: string | null;
    sourceFingerprint: string | null;
    tweakersFingerprint: string | null;
    candidateFingerprint: string | null;
    reviewFingerprint: string | null;
    progress: string;
    usage: { inputTokens: number | null; outputTokens: number | null } | null;
    usageDetails?: { version: 1; allowances: number; requests: Array<{ id: string; reservedAt?: string; settledAt?: string | null; inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; model: string | null; effort: string | null; configuredModel: string | null; configuredEffort: string | null; stage: string | null }> };
    handoff: string | null;
  };
  adoption?: DoctorAdoptionReviewV1 | null;
  findings: DoctorFindingV1[];
  actions: { id: DoctorActionV1; label: string; enabled: boolean; blockers: string[] }[];
}

export interface DoctorActionRequestV1 {
  schemaVersion: 1;
  action: DoctorActionV1;
  scanTrigger?: "available_update";
  availableUpdateBuild?: string;
  /** Latest report fingerprint; the manager rechecks immediately before acting. */
  fingerprint: string;
  decision?: { reportFingerprint: string; changeId: string; choice: "accept" | "acknowledge_unknown" | "preserve" | "override" | "defer" | "resume" | "accept_explained" | "extend_budget"; overrideId?: string };
  observation?: { reportFingerprint: string; changeId: string; before: string; after: string; conditions: string; outcome: "matches" | "differs" | "unavailable" };
}

export function isDoctorReportV1(value: unknown): value is DoctorReportV1 {
  if (!value || typeof value !== "object") return false;
  const v = value as DoctorReportV1;
  return v.schemaVersion === 1 && v.kind === "tweakers-independent-doctor"
    && typeof v.fingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(v.fingerprint)
    && v.target?.kind === "independent" && typeof v.target.appPath === "string"
    && ["healthy", "attention", "blocked"].includes(v.health?.state)
    && ["not_checked", "checking", "compatible", "fixes_required", "review_required"].includes(v.update?.state)
    && Array.isArray(v.findings) && v.findings.every(f => typeof f.id === "string" && typeof f.title === "string" && typeof f.detail === "string" && Array.isArray(f.evidence))
    && Array.isArray(v.actions) && v.actions.length >= 4 && v.actions.length <= 9
    && v.actions.every(a => ["reconnect", "scan", "repair", "retry", "update", "decide", "observe", "preview_before", "preview_after"].includes(a.id) && typeof a.enabled === "boolean" && typeof a.label === "string" && Array.isArray(a.blockers))
    && new Set(v.actions.map(a => a.id)).size === v.actions.length
    && ["scan", "repair", "retry", "update"].every(id => v.actions.filter(a => a.id === id && typeof a.enabled === "boolean" && typeof a.label === "string" && Array.isArray(a.blockers)).length === 1);
}

/** Versioned adoption evidence; compatibility is always checked independently. */
export interface DoctorChangeEvidenceV1 {
  /** Exact UTF-8 byte ranges within the full hash-bound source; absent for legacy whole-file evidence. */
  beforeFocus?: { offset: number; bytes: number } | null;
  afterFocus?: { offset: number; bytes: number } | null;
  beforeSourceBytes?: number | null;
  afterSourceBytes?: number | null;
  beforeRange?: { offset: number; bytes: number } | null;
  afterRange?: { offset: number; bytes: number } | null;
  kind?: "static" | "native_interaction" | "upstream_documentation";
  artifact: string;
  path: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  detail: string;
}
export interface DoctorChangeV1 {
  reviewWork?: DoctorReviewWorkV1;
  explanation?: { summary: string; evidenceReferences: { id: string; sha256: string }[]; sourceReferences: { path: string; sha256: string }[] };
  /** Missing on historical reports: unknown behavior is blocking by default. */
  unknownPolicy?: "acknowledgment" | "blocking";
  id: string;
  area: string;
  title: string;
  before: string;
  after: string;
  status: "observed" | "inferred_from_code" | "documented_upstream" | "unknown";
  technicalOnly: boolean;
  evidence: DoctorChangeEvidenceV1[];
  dependencies: string[];
  compatibility: string[];
  overrides: { id: string; label: string; verificationFingerprint: string }[];
}
/** Human-facing claims are separate from the exhaustive technical inventory. */
export interface DoctorChangelogEntryV1 {
  id: string;
  method?: "deterministic_text" | "model";
  category: "Added" | "Changed" | "Fixed" | "Removed" | "Deprecated" | "Security";
  title: string;
  workflow: string;
  before: string;
  after: string;
  status: "inferred_from_code" | "observed" | "documented_upstream";
  origin: "upstream" | "tweakers";
  evidenceReferences: { id: string; sha256: string }[];
  limitations: string[];
  /** Informational source dependencies; not automatic joint adoption choices. */
  dependencies: string[];
  /** Explicitly demonstrated inseparable decision groups. */
  decisionDependencies?: string[];
  analysisGroupIds: string[];
}
export interface DoctorChangelogV1 {
  schemaVersion: 1;
  entries: DoctorChangelogEntryV1[];
  unresolved: { groupId: string; reason: string }[];
}
export interface DoctorUpdaterEvidenceV1 {
  schemaVersion: 1;
  protocolFingerprint: string;
  checks?: Array<{id: string; state: "passed" | "failed" | "unsupported"; summary: string; scope: string}>;
  interfaces: Array<{method: string; owner: string; status: "compatible" | "incompatible" | "unresolved"; reasons: string[]}>;
  upstream: {status: "not_attempted" | "unavailable" | "verified"; summary: string; url?: string; digest?: string};
}
export interface DoctorChangeReportV1 {
  updaterEvidence?: DoctorUpdaterEvidenceV1;
  schemaVersion: 1;
  analysisVersion?: 2;
  analysisImplementationVersion?: number;
  reviewProgress?: DoctorReviewProgressV1;
  /** Absent on legacy reports; those cannot authorize installation. */
  changelog?: DoctorChangelogV1;
  sourceVersions?: { before: { version: string | null; build: string | null }; after: { version: string | null; build: string | null } };
  jobId: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  comparisonFingerprint: string;
  implementationFingerprint: string;
  candidateFingerprint: string | null;
  changes: DoctorChangeV1[];
  coverage: { total: number; classified: number; unresolved: number };
  limitations: string[];
  fingerprint: string;
}
export interface DoctorAdoptionReviewV1 {
  schemaVersion: 1;
  state: "review_required" | "ready" | "deferred" | "preservation_required" | "superseded";
  report: DoctorChangeReportV1;
  decisions: { changeId: string; choice: "accept" | "acknowledge_unknown" | "preserve" | "override"; overrideId?: string }[];
  observations: { changeId: string; before: string; after: string; conditions: string; outcome: "matches" | "differs" | "unavailable"; recordedAt: string; source: "user_manual" }[];
  blockers: string[];
  fingerprint: string;
}

/** Compatibility evidence is separate from optional upstream explanations. */
export interface DoctorCompatibilityV1 {
  implementationScopes?: { version: 1; construction: string; verification: string; promotion: string; payload: string };
  version: 1;
  policyVersion: 1;
  status: "passed" | "conflict" | "verification_unavailable";
  fingerprint: string;
  binding: { beforeFingerprint: string; afterFingerprint: string; comparisonFingerprint: string; tweakersFingerprint: string; configurationFingerprint: string; candidateFingerprint: string | null; validationFingerprint: string };
  checks: Array<{ id: string; owner: string; outcome: "passed" | "conflict" | "verification_unavailable"; expected: string; observed: string; evidence: string[]; nextAction: string }>;
  repairs: Array<{ conflictId: string; attempt: number; status: "reserved" | "completed" | "rejected" | "interrupted"; evidence: string; summary: string }>;
  postInstallChecks: string[];
}
