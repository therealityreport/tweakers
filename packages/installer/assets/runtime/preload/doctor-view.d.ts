export type DoctorActionV1 = "reconnect" | "scan" | "repair" | "retry" | "update" | "decide" | "observe" | "preview_before" | "preview_after";
export interface DoctorActionRequestV1 {
    schemaVersion: 1;
    action: DoctorActionV1;
    fingerprint: string;
    decision?: {
        reportFingerprint: string;
        changeId: string;
        choice: "accept" | "acknowledge_unknown" | "preserve" | "override" | "defer" | "resume" | "accept_explained" | "extend_budget";
        overrideId?: string;
    };
    observation?: {
        reportFingerprint: string;
        changeId: string;
        before: string;
        after: string;
        conditions: string;
        outcome: "matches" | "differs" | "unavailable";
    };
}
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
    health: {
        state: "healthy" | "attention" | "blocked";
        broker: string;
    };
    update: {
        compatibility?: DoctorCompatibilityV1;
        review?: DoctorReviewProgressV1;
        execution?: {
            version: 2;
            trigger: "manual" | "available_update";
            status: "running" | "ready" | "action_required" | "failed" | "superseded";
            recoverable: boolean;
        };
        state: "not_checked" | "checking" | "compatible" | "fixes_required" | "review_required";
        phase: string;
        candidateId: string | null;
        sourceFingerprint: string | null;
        tweakersFingerprint: string | null;
        candidateFingerprint: string | null;
        reviewFingerprint: string | null;
        progress: string;
        usage: {
            inputTokens: number | null;
            outputTokens: number | null;
        } | null;
        usageDetails?: {
            version: 1;
            allowances: number;
            requests: Array<{
                id: string;
                reservedAt?: string;
                settledAt?: string | null;
                inputTokens: number | null;
                cachedInputTokens: number | null;
                outputTokens: number | null;
                model: string | null;
                effort: string | null;
                configuredModel: string | null;
                configuredEffort: string | null;
                stage: string | null;
            }>;
        };
        handoff: string | null;
    };
    adoption?: {
        schemaVersion: 1;
        state: "review_required" | "ready" | "deferred" | "preservation_required" | "superseded";
        report: {
            updaterEvidence?: {
                schemaVersion: 1;
                protocolFingerprint: string;
                interfaces: Array<{
                    method: string;
                    owner: string;
                    status: string;
                    reasons: string[];
                }>;
                checks?: Array<{
                    id: string;
                    state: string;
                    summary: string;
                    scope: string;
                }>;
                upstream: {
                    status: string;
                    summary: string;
                    url?: string;
                    digest?: string;
                };
            };
            changes: DoctorChangeV1[];
            changelog?: DoctorChangelogV1;
            sourceVersions?: {
                before: {
                    version: string | null;
                    build: string | null;
                };
                after: {
                    version: string | null;
                    build: string | null;
                };
            };
            limitations: string[];
            coverage: {
                total: number;
                classified: number;
                unresolved: number;
            };
            fingerprint: string;
        };
        decisions: Array<{
            changeId: string;
            choice: "accept" | "acknowledge_unknown" | "preserve" | "override";
            overrideId?: string;
        }>;
        observations: Array<{
            changeId: string;
            before: string;
            after: string;
            conditions: string;
            outcome: "matches" | "differs" | "unavailable";
            recordedAt: string;
            source: "user_manual";
        }>;
        blockers: string[];
        fingerprint: string;
    } | null;
    findings: DoctorFindingV1[];
    actions: Array<{
        id: DoctorActionV1;
        label: string;
        enabled: boolean;
        blockers: string[];
    }>;
}
/** Mirrors the SDK contract so a malformed compatibility result never reaches the UI. */
export interface DoctorCompatibilityV1 {
    version: 1;
    policyVersion: 1;
    status: "passed" | "conflict" | "verification_unavailable";
    fingerprint: string;
    binding: {
        beforeFingerprint: string;
        afterFingerprint: string;
        comparisonFingerprint: string;
        tweakersFingerprint: string;
        configurationFingerprint: string;
        candidateFingerprint: string | null;
        validationFingerprint: string;
    };
    checks: Array<{
        id: string;
        owner: string;
        outcome: "passed" | "conflict" | "verification_unavailable";
        expected: string;
        observed: string;
        evidence: string[];
        nextAction: string;
    }>;
    repairs: Array<{
        conflictId: string;
        attempt: number;
        status: "reserved" | "completed" | "rejected" | "interrupted";
        evidence: string;
        summary: string;
    }>;
    postInstallChecks: string[];
}
export interface DoctorChangeV1 {
    reviewWork?: DoctorReviewWorkV1;
    id: string;
    area: string;
    title: string;
    before: string;
    after: string;
    status: "observed" | "inferred_from_code" | "documented_upstream" | "unknown";
    explanation?: {
        summary: string;
        evidenceReferences: Array<{
            id: string;
            sha256: string;
        }>;
        sourceReferences: Array<{
            path: string;
            sha256: string;
        }>;
    };
    unknownPolicy?: "acknowledgment" | "blocking";
    technicalOnly: boolean;
    evidence: Array<{
        kind?: "static" | "native_interaction" | "upstream_documentation";
        artifact: string;
        path: string;
        beforeSha256: string | null;
        afterSha256: string | null;
        detail: string;
    }>;
    dependencies: string[];
    compatibility: string[];
    overrides: Array<{
        id: string;
        label: string;
        verificationFingerprint: string;
    }>;
}
export interface DoctorReviewProgressV1 {
    version: 1;
    policy: "finish_automatically";
    stage: "preparing" | "explaining" | "ready" | "action_required" | "deferred" | "superseded";
    files: {
        total: number;
        accounted: number;
    };
    questions: {
        total: number;
        completed: number;
        reused: number;
    };
    entries: number;
    limitations: number;
    pause?: {
        code: "source_unavailable" | "provider_unavailable" | "usage_unavailable" | "no_progress" | "compatibility_required";
        message: string;
        action: "retry" | "sign_in" | "inspect_evidence" | "repair";
    };
}
export interface DoctorReviewWorkV1 {
    version: 1;
    kind: "behavior" | "internal" | "evidence_needed" | "observation_limit";
    reasonCode: "changed_behavior" | "packaging" | "identical_content" | "opaque_binary" | "source_unavailable" | "unsupported_syntax" | "unclassified_change";
    question: string;
}
export interface DoctorChangelogEntryV1 {
    id: string;
    category: "Added" | "Changed" | "Fixed" | "Removed" | "Deprecated" | "Security";
    title: string;
    workflow: string;
    before: string;
    after: string;
    status: "inferred_from_code" | "observed" | "documented_upstream";
    origin: "upstream" | "tweakers";
    evidenceReferences: Array<{
        id: string;
        sha256: string;
    }>;
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
    unresolved: Array<{
        groupId: string;
        reason: string;
    }>;
}
export interface DoctorViewSnapshot {
    report: DoctorReportV1 | null;
    loading: boolean;
    busyAction: DoctorActionV1 | null;
    error: string | null;
    copied: boolean;
}
export interface DoctorController {
    readonly snapshot: DoctorViewSnapshot;
    refresh(): Promise<void>;
    perform(action: DoctorActionV1, details?: Pick<DoctorActionRequestV1, "decision" | "observation">): Promise<boolean>;
    markCopied(): void;
    dispose(): void;
}
export interface DoctorControllerOptions {
    status(): Promise<unknown>;
    action(request: DoctorActionRequestV1): Promise<unknown>;
    onChange(snapshot: DoctorViewSnapshot): void;
    isMounted(): boolean;
}
export interface DoctorPresentation {
    healthLabel: string;
    healthTone: "ok" | "warn" | "error";
    updateLabel: string;
    installationFindings: DoctorFindingV1[];
    compatibilityFindings: DoctorFindingV1[];
    actionBlockers: Array<{
        action: DoctorActionV1;
        blockers: string[];
    }>;
}
export interface DoctorCompatibilityPresentation {
    label: string;
    summary: string;
    passedChecks: number;
    totalChecks: number;
    actionableChecks: DoctorCompatibilityV1["checks"];
}
export interface DoctorViewOptions {
    invoke(channel: "tweaker:doctor-status" | "tweaker:doctor-action", request?: DoctorActionRequestV1): Promise<unknown>;
    copyText(text: string): Promise<unknown>;
}
export declare function doctorPresentation(report: DoctorReportV1): DoctorPresentation;
export declare function createDoctorController(options: DoctorControllerOptions): DoctorController;
export declare function mountDoctorView(root: HTMLElement, options: DoctorViewOptions): () => void;
export declare function isCompatibilityWorkflowInProgress(update: DoctorReportV1["update"]): boolean;
export declare function compatibilityPresentation(update: DoctorReportV1["update"]): DoctorCompatibilityPresentation;
export declare function changelogDecisionGroups(report: Pick<NonNullable<DoctorReportV1["adoption"]>["report"], "changes" | "changelog">, id: string): string[];
