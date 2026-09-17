"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.doctorPresentation = doctorPresentation;
exports.createDoctorController = createDoctorController;
exports.mountDoctorView = mountDoctorView;
exports.isCompatibilityWorkflowInProgress = isCompatibilityWorkflowInProgress;
exports.compatibilityPresentation = compatibilityPresentation;
exports.changelogDecisionGroups = changelogDecisionGroups;
function doctorPresentation(report) {
    const health = report.health.state;
    return {
        healthLabel: health === "healthy" ? "Healthy" : health === "attention" ? "Needs attention" : "Blocked",
        healthTone: health === "healthy" ? "ok" : health === "attention" ? "warn" : "error",
        updateLabel: updateStateLabel(report.update),
        installationFindings: report.findings.filter((finding) => finding.stage === "installation" || finding.stage === "storage" || finding.stage === "broker"),
        compatibilityFindings: report.findings.filter((finding) => finding.stage === "compatibility" || finding.stage === "candidate"),
        actionBlockers: report.actions
            .filter((action) => !action.enabled && action.blockers.length > 0)
            .map((action) => ({ action: action.id, blockers: [...action.blockers] })),
    };
}
function createDoctorController(options) {
    let disposed = false;
    let revision = 0;
    let snapshot = {
        report: null,
        loading: true,
        busyAction: null,
        error: null,
        copied: false,
    };
    const publish = () => {
        if (!disposed)
            options.onChange(copySnapshot(snapshot));
    };
    const acceptReport = (value) => {
        if (!isDoctorReport(value))
            throw new Error("invalid-doctor-report");
        return value;
    };
    async function refresh() {
        if (disposed || !options.isMounted())
            return;
        const requestRevision = ++revision;
        snapshot = { ...snapshot, loading: snapshot.report === null, error: null, copied: false };
        publish();
        try {
            const report = acceptReport(await options.status());
            if (disposed || requestRevision !== revision || !options.isMounted())
                return;
            snapshot = { ...snapshot, report, loading: false, error: null };
        }
        catch {
            if (disposed || requestRevision !== revision || !options.isMounted())
                return;
            snapshot = {
                ...snapshot,
                loading: false,
                error: "Doctor status could not be loaded. Try scanning again.",
            };
        }
        publish();
    }
    async function perform(action, details = {}) {
        if (disposed || !options.isMounted() || snapshot.busyAction !== null)
            return false;
        const report = snapshot.report;
        const declaredAction = report?.actions.find((candidate) => candidate.id === action);
        if (!report || !declaredAction?.enabled)
            return false;
        const requestRevision = ++revision;
        snapshot = { ...snapshot, busyAction: action, error: null, copied: false };
        publish();
        try {
            const nextReport = acceptReport(await options.action({
                schemaVersion: 1,
                action,
                fingerprint: report.fingerprint,
                ...details,
            }));
            if (disposed || requestRevision !== revision || !options.isMounted())
                return false;
            snapshot = { ...snapshot, report: nextReport, busyAction: null, error: null };
            publish();
            return true;
        }
        catch {
            if (disposed || requestRevision !== revision || !options.isMounted())
                return false;
            snapshot = {
                ...snapshot,
                busyAction: null,
                error: "The Doctor action did not complete. Refresh the report before trying again.",
            };
            publish();
            return false;
        }
    }
    return {
        get snapshot() {
            return copySnapshot(snapshot);
        },
        refresh,
        perform,
        markCopied() {
            if (disposed || !options.isMounted())
                return;
            snapshot = { ...snapshot, copied: true };
            publish();
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            revision += 1;
        },
    };
}
function mountDoctorView(root, options) {
    const section = document.createElement("section");
    section.className = "flex flex-col gap-2";
    section.dataset.tweakerDoctor = "true";
    section.appendChild(doctorSectionTitle("Doctor"));
    const content = document.createElement("div");
    content.className = "flex flex-col gap-[var(--padding-panel)]";
    section.appendChild(content);
    root.appendChild(section);
    const render = (snapshot) => {
        if (!section.isConnected)
            return;
        content.textContent = "";
        if (snapshot.loading && !snapshot.report) {
            content.appendChild(doctorCard([doctorRow("Checking Tweakers", "Reading the independent installation and update state.")]));
            return;
        }
        if (snapshot.report)
            renderReport(content, snapshot, controller, options);
        if (snapshot.error) {
            content.appendChild(doctorCard([doctorRow("Doctor needs attention", snapshot.error, doctorBadge("error", "Unavailable"))]));
        }
    };
    const controller = createDoctorController({
        status: () => options.invoke("tweaker:doctor-status"),
        action: (request) => options.invoke("tweaker:doctor-action", request),
        onChange: render,
        isMounted: () => section.isConnected,
    });
    render(controller.snapshot);
    void controller.refresh();
    return () => controller.dispose();
}
function renderReport(content, snapshot, controller, options) {
    const report = snapshot.report;
    if (!report)
        return;
    const presentation = doctorPresentation(report);
    const compatibility = report.update.compatibility;
    const compatibilityWorkflow = compatibility || isCompatibilityWorkflowInProgress(report.update);
    if (compatibilityWorkflow) {
        if (compatibility)
            renderCompatibility(content, report.update);
        else
            renderCompatibilityPending(content);
        if (report.adoption) {
            const secondary = document.createElement("details");
            secondary.className = "p-3 text-sm";
            const summary = document.createElement("summary");
            summary.className = "cursor-interaction text-token-text-primary";
            summary.textContent = "Optional changelog and preservation choices";
            const body = document.createElement("div");
            body.className = "mt-3 flex flex-col gap-3";
            renderBehavioralChangelog(body, report, snapshot, controller);
            secondary.append(summary, body);
            content.appendChild(doctorGroup("Additional update context", [secondary]));
        }
    }
    else if (report.adoption)
        renderBehavioralChangelog(content, report, snapshot, controller);
    const attentionRows = [
        ...presentation.installationFindings.map(findingRow),
        ...presentation.compatibilityFindings.map(findingRow),
        ...presentation.actionBlockers.flatMap((entry) => entry.blockers.map((blocker) => doctorRow(`${actionName(entry.action)} blocked`, blocker))),
    ];
    if (!compatibilityWorkflow && report.update.review?.pause)
        attentionRows.push(doctorRow("Review paused", `${report.update.review.pause.message}\nNext: ${pauseActionLabel(report.update.review.pause.action)}.`, doctorBadge("warn", "Action needed")));
    if (attentionRows.length)
        content.appendChild(doctorGroup("What needs attention", attentionRows));
    const advanced = document.createElement("details");
    advanced.className = "p-3 text-sm";
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Show technical report";
    const advancedText = document.createElement("pre");
    advancedText.className = "mt-2 whitespace-pre-wrap break-words text-token-text-secondary";
    advancedText.textContent = technicalReportSummary(report);
    advanced.append(advancedSummary, advancedText);
    content.appendChild(doctorGroup("Advanced", [advanced]));
    if (report.update.handoff && report.update.execution?.status !== "running") {
        const handoff = document.createElement("div");
        handoff.className = "flex flex-col gap-3 p-3";
        const disclosure = document.createElement("details");
        const summary = document.createElement("summary");
        summary.className = "cursor-interaction text-sm text-token-text-primary";
        summary.textContent = "Show review handoff";
        const text = document.createElement("pre");
        text.className = "m-0 whitespace-pre-wrap break-words text-sm text-token-text-secondary";
        text.textContent = report.update.handoff;
        const copy = doctorButton(snapshot.copied ? "Copied" : "Copy Handoff", () => {
            if (!report.update.handoff)
                return;
            void options.copyText(report.update.handoff).then(() => controller.markCopied()).catch(() => undefined);
        });
        copy.disabled = snapshot.copied;
        disclosure.append(summary, text);
        handoff.append(disclosure, copy);
        content.appendChild(doctorGroup("Handoff", [handoff]));
    }
    const actionRow = document.createElement("div");
    actionRow.className = "flex flex-wrap items-center gap-2 p-3";
    for (const action of report.actions.filter(action => ["reconnect", "scan", "repair", "retry", "update"].includes(action.id))) {
        const button = doctorButton(snapshot.busyAction === action.id ? `${action.label}…` : action.label, () => {
            void controller.perform(action.id);
        });
        button.dataset.doctorAction = action.id;
        button.disabled = snapshot.busyAction !== null || !action.enabled;
        if (!action.enabled && action.blockers.length > 0)
            button.title = action.blockers.join("\n");
        actionRow.appendChild(button);
    }
    content.appendChild(doctorGroup("Actions", [actionRow]));
}
function renderCompatibilityPending(content) {
    content.appendChild(doctorGroup("Compatibility", [doctorRow("Candidate compatibility", "Checking compatibility evidence for this candidate. Installation remains unavailable until verification publishes a result.", doctorBadge("warn", "Checking compatibility"))]));
}
function isCompatibilityWorkflowInProgress(update) {
    return update.state === "checking" && ["preparing", "resuming", "comparing", "applying_patches", "checking", "repairing"].includes(update.phase);
}
function renderCompatibility(content, update) {
    const compatibility = update.compatibility;
    const presentation = compatibilityPresentation(update);
    const tone = compatibility.status === "passed" ? "ok" : compatibility.status === "conflict" ? "error" : "warn";
    const rows = [
        doctorRow("Candidate compatibility", presentation.summary, doctorBadge(tone, presentation.label)),
        doctorRow("Required checks", `${presentation.passedChecks}/${presentation.totalChecks} passed.`),
        ...presentation.actionableChecks.map((check) => doctorRow(check.id, `${check.owner}\nExpected: ${check.expected}\nObserved: ${check.observed}\nNext: ${check.nextAction}${evidencePreview(check.evidence)}`, doctorBadge(check.outcome === "conflict" ? "error" : "warn", check.outcome === "conflict" ? "Conflict" : "Unavailable"))),
        ...compatibility.repairs.filter((repair) => repair.status !== "completed").map((repair) => doctorRow(`Repair ${repair.attempt}: ${repair.conflictId}`, `${repair.summary}\nEvidence: ${repair.evidence}`, doctorBadge(repair.status === "rejected" || repair.status === "interrupted" ? "error" : "warn", repair.status))),
    ];
    if (compatibility.postInstallChecks.length)
        rows.push(doctorRow("After installation", compatibility.postInstallChecks.join("\n")));
    content.appendChild(doctorGroup("Compatibility", rows));
}
function compatibilityPresentation(update) {
    const compatibility = update.compatibility;
    if (!compatibility)
        throw new Error("missing-compatibility");
    const verifyingCandidate = update.state === "checking" && compatibility.binding.candidateFingerprint === null;
    const installationPending = compatibility.status === "passed" && (update.state !== "compatible" || update.phase !== "candidate_verified");
    return {
        label: installationPending ? "Compatibility passed" : verifyingCandidate ? "Verification in progress" : compatibility.status === "passed" ? "Ready to install" : compatibility.status === "conflict" ? "Needs attention" : "Verification unavailable",
        summary: installationPending ? "Candidate compatibility checks passed. See the current installation status and blockers." : verifyingCandidate ? "Candidate verification is still running." : compatibility.status === "passed" ? "All required compatibility checks passed." : compatibility.status === "conflict" ? "A compatibility conflict needs repair before installation." : "Required compatibility verification is unavailable.",
        passedChecks: compatibility.checks.filter((check) => check.outcome === "passed").length,
        totalChecks: compatibility.checks.length,
        actionableChecks: compatibility.checks.filter((check) => check.outcome !== "passed"),
    };
}
function evidencePreview(evidence) {
    if (!evidence.length)
        return "\nEvidence: None supplied";
    const preview = evidence.slice(0, 3).join("; ");
    return `\nEvidence: ${preview}${evidence.length > 3 ? `; and ${evidence.length - 3} more. Full evidence is retained in the technical report.` : ""}`;
}
function changelogDecisionGroups(report, id) {
    const entry = report.changelog?.entries.find((candidate) => candidate.id === id);
    const ids = new Set(entry ? [...entry.analysisGroupIds, ...(entry.decisionDependencies ?? [])] : report.changes.some((change) => change.id === id) ? [id] : []);
    if (!ids.size)
        return [];
    let changed = true;
    while (changed) {
        const size = ids.size;
        for (const sibling of report.changelog?.entries ?? []) {
            if ([...sibling.analysisGroupIds, ...(sibling.decisionDependencies ?? [])].some((groupId) => ids.has(groupId))) {
                for (const groupId of [...sibling.analysisGroupIds, ...(sibling.decisionDependencies ?? [])])
                    ids.add(groupId);
            }
        }
        changed = size !== ids.size;
    }
    return [...ids].sort();
}
function renderBehavioralChangelog(content, report, snapshot, controller) {
    const review = report.adoption;
    const evidence = review.report.updaterEvidence;
    if (evidence) {
        content.appendChild(doctorGroup("App Server compatibility", [
            doctorRow("Schema contracts", evidence.interfaces.map(item => `${item.owner} · ${item.method}: ${item.status}${item.reasons.length ? ` — ${item.reasons.join("; ")}` : ""}`).join("\n"), doctorBadge("warn", "Schema evidence")),
            ...(evidence.checks ?? []).map(item => doctorRow(item.id, `${item.summary}\nScope: ${item.scope}`, doctorBadge(item.state === "passed" ? "ok" : "warn", item.state))),
            doctorRow("Official Codex source context", `${evidence.upstream.summary}${evidence.upstream.url ? `\n${evidence.upstream.url}` : ""}`, doctorBadge("warn", "Supplementary")),
        ]));
    }
    const log = review.report.changelog;
    if (!log) {
        content.appendChild(doctorGroup("What’s new", [doctorRow("Behavioral changelog incomplete", "This historical report has technical analysis, but no validated behavioral changelog. It cannot clear the update for installation.", doctorBadge("warn", "Incomplete"))]));
    }
    else {
        for (const category of ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"]) {
            const entries = log.entries.filter((entry) => entry.category === category);
            if (entries.length)
                content.appendChild(doctorGroup(category, entries.map((entry) => changelogEntryRow(entry, review, report, snapshot, controller))));
        }
        if (log.unresolved.length) {
            const supportedEntries = log.entries.length;
            const pendingAreas = log.unresolved.map((unresolved) => pendingAnalysisArea(review.report, unresolved));
            const areaSummary = pendingAreaSummary(pendingAreas);
            const details = document.createElement("details");
            details.className = "p-3 text-sm";
            const summary = document.createElement("summary");
            summary.textContent = "Show pending areas and next actions";
            const reasons = document.createElement("div");
            reasons.className = "mt-2 whitespace-pre-wrap break-words text-token-text-secondary";
            reasons.textContent = pendingAreas.map(({ title, reason, nextAction }) => `${title}\nReason: ${reason}\nNext: ${nextAction}`).join("\n\n");
            details.append(summary, reasons);
            content.appendChild(doctorGroup("Behavioral changelog gaps", [doctorRow("Behavioral review remains incomplete", `${supportedEntries} supported changelog entr${supportedEntries === 1 ? "y is" : "ies are"} ready. ${pendingAreas.length} technical area${pendingAreas.length === 1 ? " is" : "s are"} still pending: ${areaSummary}. Open the details to see each reason and its next action.`, doctorBadge("warn", "Incomplete")), details]));
        }
        if (log.entries.length === 0 && review.state === "review_required")
            content.appendChild(doctorGroup("What’s new", [doctorRow("No behavioral entries are ready", "The review is required because its behavioral explanation is incomplete. Open Behavioral changelog gaps or Technical review, then resolve the listed evidence before continuing.", doctorBadge("warn", "Review required"))]));
    }
    const technical = document.createElement("details");
    technical.className = "p-3 text-sm";
    const summary = document.createElement("summary");
    summary.className = "cursor-interaction text-token-text-primary";
    summary.textContent = "Inspect technical analysis groups and review decisions";
    const body = document.createElement("div");
    body.className = "mt-2 flex flex-col gap-3 whitespace-pre-wrap break-words text-token-text-secondary";
    const technicalText = document.createElement("pre");
    technicalText.className = "m-0 whitespace-pre-wrap break-words";
    technicalText.textContent = review.report.changes.map((group) => `${group.id}\n${group.title}\nBefore: ${group.before}\nAfter: ${group.after}\n${group.compatibility.join("\n")}`).join("\n\n");
    body.appendChild(technicalText);
    for (const unresolved of review.report.changelog?.unresolved ?? []) {
        const group = review.report.changes.find((candidate) => candidate.id === unresolved.groupId);
        if (!group || group.status !== "unknown" || group.unknownPolicy !== "acknowledgment")
            continue;
        const scope = changelogDecisionGroups(review.report, group.id);
        const acknowledge = doctorButton("Acknowledge unknown behavior", () => void controller.perform("decide", { decision: { reportFingerprint: review.report.fingerprint, changeId: group.id, choice: "acknowledge_unknown" } }));
        acknowledge.disabled = snapshot.busyAction !== null || !report.actions.some((action) => action.id === "decide" && action.enabled);
        acknowledge.title = `Applies to analysis groups: ${scope.join(", ")}.`;
        body.append(doctorRow(`Unknown behavior: ${group.title}`, `${unresolved.reason}\nDecision scope: ${scope.join(", ")}`, acknowledge));
    }
    technical.append(summary, body);
    content.appendChild(doctorGroup("Technical review", [technical]));
}
function pendingAnalysisArea(report, unresolved) {
    const group = report.changes.find((candidate) => candidate.id === unresolved.groupId);
    if (!group)
        return {
            title: unresolved.groupId,
            reason: unresolved.reason,
            nextAction: "Open Technical review and refresh the report if this area is no longer present.",
        };
    const reportedAction = group.compatibility.find((item) => item.trim().length > 0);
    return {
        title: group.title || group.id,
        reason: unresolved.reason,
        nextAction: group.reviewWork?.question || (group.status === "unknown" && group.unknownPolicy === "acknowledgment"
            ? "Review its evidence, then acknowledge the unknown behavior if that remains appropriate."
            : reportedAction && readableNextAction(reportedAction) || "Open Technical review and resolve the evidence named above."),
    };
}
function pendingAreaSummary(areas) {
    const distinct = [...new Set(areas.map((area) => area.title).filter(Boolean))];
    const shown = distinct.slice(0, 6);
    return `${shown.join(", ")}${distinct.length > shown.length ? `, and ${distinct.length - shown.length} more` : ""}`;
}
function readableNextAction(value) {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(value.trim()))
        return null;
    return value;
}
function changelogEntryRow(entry, review, report, snapshot, controller) {
    const scope = changelogDecisionGroups(review.report, entry.id);
    const groups = review.report.changes.filter((group) => scope.includes(group.id));
    const requiredUnknown = groups.some((group) => group.status === "unknown" && group.unknownPolicy !== "acknowledgment");
    const eligibleUnknown = groups.filter((group) => group.status === "unknown" && group.unknownPolicy === "acknowledgment");
    const unacknowledgedEligible = eligibleUnknown.some((group) => review.decisions.find((decision) => decision.changeId === group.id)?.choice !== "acknowledge_unknown");
    const siblings = (review.report.changelog?.entries ?? []).filter((candidate) => candidate.id !== entry.id && changelogDecisionGroups(review.report, candidate.id).some((groupId) => scope.includes(groupId))).map((candidate) => candidate.title);
    const decision = review.decisions.find((candidate) => scope.includes(candidate.changeId));
    const row = document.createElement("div");
    row.className = "flex min-w-0 flex-col gap-3 p-3";
    row.appendChild(doctorRow(entry.title, `${entry.workflow}\n\nBefore\n${entry.before}\n\nAfter\n${entry.after}\n\nEvidence: ${evidenceLabel(entry.status)}\nOrigin: ${entry.origin === "upstream" ? "Upstream" : "Tweakers"}${entry.limitations.length ? `\nLimitations: ${entry.limitations.join("; ")}` : ""}`, doctorBadge(entry.status === "observed" ? "ok" : "warn", entry.status === "observed" ? "Observed in app" : entry.status === "documented_upstream" ? "Documented upstream" : "Inferred from code")));
    const scopeDisclosure = document.createElement("details");
    scopeDisclosure.className = "text-sm text-token-text-secondary";
    const scopeSummary = document.createElement("summary");
    scopeSummary.className = "cursor-interaction text-token-text-primary";
    scopeSummary.textContent = "Review decision scope";
    const scopeText = document.createElement("div");
    scopeText.className = "mt-2 whitespace-pre-wrap break-words";
    scopeText.textContent = [`Groups affected: ${scope.join(", ") || "none"}`, siblings.length ? `Coupled entries: ${siblings.join("; ")}` : "No coupled changelog entries.", `Decision: ${decision?.choice ?? "not decided"}`, `Evidence references: ${entry.evidenceReferences.map((reference) => reference.id).join(", ")}`].join("\n");
    scopeDisclosure.append(scopeSummary, scopeText);
    row.appendChild(scopeDisclosure);
    const actions = document.createElement("div");
    actions.className = "flex flex-wrap items-center gap-2";
    const canDecide = report.actions.some((action) => action.id === "decide" && action.enabled) && snapshot.busyAction === null;
    const action = (label, choice, overrideId) => {
        const button = doctorButton(label, () => void controller.perform("decide", { decision: { reportFingerprint: review.report.fingerprint, changeId: entry.id, choice, ...(overrideId ? { overrideId } : {}) } }));
        button.disabled = !canDecide || (choice === "accept" && (requiredUnknown || unacknowledgedEligible));
        actions.appendChild(button);
    };
    action("Accept", "accept");
    action("Request preservation", "preserve");
    if (unacknowledgedEligible) {
        const acknowledge = doctorButton("Acknowledge eligible unknown behavior", () => void controller.perform("decide", { decision: { reportFingerprint: review.report.fingerprint, changeId: entry.id, choice: "acknowledge_unknown" } }));
        acknowledge.disabled = !canDecide;
        actions.appendChild(acknowledge);
    }
    if (scope.length === 1 && groups[0]?.overrides.length === 1)
        action(`Use override: ${groups[0].overrides[0].label}`, "override", groups[0].overrides[0].id);
    const canObserve = report.actions.some((action) => action.id === "observe" && action.enabled) && scope.length === 1 && snapshot.busyAction === null;
    const observe = doctorButton("Record manual observation", () => {
        const before = window.prompt("What did you observe before?");
        if (before === null)
            return;
        const after = window.prompt("What did you observe after?");
        if (after === null)
            return;
        const conditions = window.prompt("Conditions for this observation:");
        if (conditions === null)
            return;
        void controller.perform("observe", { observation: { reportFingerprint: review.report.fingerprint, changeId: scope[0], before, after, conditions, outcome: "matches" } });
    });
    observe.disabled = !canObserve;
    observe.title = canObserve ? "Records user-supplied evidence for this one analysis group." : "Observation requires exactly one underlying analysis group.";
    actions.appendChild(observe);
    row.appendChild(actions);
    return row;
}
function evidenceLabel(status) {
    if (status === "observed")
        return "Observed in app";
    if (status === "documented_upstream")
        return "Documented upstream";
    return "Inferred from code";
}
function evidenceMeaning(kind) {
    if (kind === "native_interaction")
        return "Observed through native interaction.";
    if (kind === "upstream_documentation")
        return "Upstream documentation; not observed in the native app.";
    return "Static source evidence; not an observation of the native app.";
}
function findingRow(finding) {
    const tone = finding.severity === "error" ? "error" : finding.severity === "warning" ? "warn" : "ok";
    const detail = finding.evidence.length > 0
        ? `${finding.detail}\n\nEvidence\n${finding.evidence.map((item) => `• ${item}`).join("\n")}`
        : finding.detail;
    const stage = finding.stage === "candidate" ? "Candidate" : finding.stage === "compatibility" ? "Compatibility" : "Installation";
    if (detail.length <= 280 && finding.evidence.length <= 1) {
        return doctorRow(finding.title, detail, doctorBadge(tone, stage));
    }
    const disclosure = document.createElement("details");
    disclosure.className = "min-w-0 flex-1 p-3";
    const summary = document.createElement("summary");
    summary.className = "cursor-interaction text-sm text-token-text-primary";
    summary.textContent = finding.title;
    const description = document.createElement("div");
    description.className = "mt-2 whitespace-pre-wrap break-words text-sm text-token-text-secondary";
    description.textContent = detail;
    disclosure.append(summary, description);
    const row = document.createElement("div");
    row.className = "flex items-start justify-between gap-4";
    row.append(disclosure, doctorBadge(tone, stage));
    return row;
}
function compatibilityEmptyRow(report) {
    if (report.update.state === "compatible") {
        return doctorRow("No compatibility or candidate findings", "The completed compatibility review cleared this update.", doctorBadge("ok", "Clear"));
    }
    if (report.update.state === "not_checked") {
        return doctorRow("Compatibility not checked", "Current installation health does not clear an update. Run the compatibility review before updating.", doctorBadge("warn", "Not checked"));
    }
    if (report.update.state === "checking") {
        return doctorRow("Compatibility review in progress", "Current installation health does not clear the candidate while review is running.", doctorBadge("warn", "Checking"));
    }
    return doctorRow("Compatibility unresolved", "Current installation health does not clear this update. Review the update blockers before continuing.", doctorBadge(updateTone(report.update.state), updateStateLabel(report.update)));
}
function doctorGroup(title, rows) {
    const group = document.createElement("div");
    group.className = "flex flex-col gap-2";
    group.appendChild(doctorSectionTitle(title));
    group.appendChild(doctorCard(rows));
    return group;
}
function doctorSectionTitle(text) {
    const title = document.createElement("div");
    title.className = "flex h-toolbar items-center text-base font-medium text-token-text-primary";
    title.textContent = text;
    return title;
}
function doctorCard(rows) {
    const card = document.createElement("div");
    card.className = "border-token-border flex flex-col divide-y-[0.5px] divide-token-border rounded-lg border";
    card.style.backgroundColor = "var(--color-background-panel, var(--color-token-bg-fog))";
    card.append(...rows);
    return card;
}
function doctorRow(titleText, detail, trailing) {
    const row = document.createElement("div");
    row.className = "flex min-w-0 items-start justify-between gap-4 p-3";
    const copy = document.createElement("div");
    copy.className = "flex min-w-0 flex-1 flex-col gap-1";
    const title = document.createElement("div");
    title.className = "min-w-0 text-sm text-token-text-primary";
    title.textContent = titleText;
    const description = document.createElement("div");
    description.className = "min-w-0 whitespace-pre-wrap break-words text-sm text-token-text-secondary";
    description.textContent = detail;
    copy.append(title, description);
    row.appendChild(copy);
    if (trailing)
        row.appendChild(trailing);
    return row;
}
function doctorBadge(tone, label) {
    const badge = document.createElement("span");
    const color = tone === "ok"
        ? "border-token-charts-green text-token-charts-green"
        : tone === "warn"
            ? "border-token-charts-yellow text-token-charts-yellow"
            : "border-token-charts-red text-token-charts-red";
    badge.className = `inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium ${color}`;
    badge.textContent = label;
    return badge;
}
function doctorButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "border-token-border user-select-none no-drag cursor-interaction inline-flex h-8 items-center whitespace-nowrap rounded-lg border px-2 text-sm text-token-text-primary enabled:hover:bg-token-list-hover-background disabled:cursor-not-allowed disabled:opacity-40";
    button.textContent = label;
    button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!button.disabled)
            onClick();
    });
    return button;
}
function copySnapshot(snapshot) {
    return { ...snapshot };
}
function updateStateLabel(update) {
    if (update.phase === "promotion_failed" || update.phase === "stale")
        return "Needs attention";
    if (update.phase === "updating")
        return "Installing update";
    if (update.phase === "installed")
        return "Update installed";
    if (update.state === "compatible" && update.phase === "candidate_verified" && update.compatibility?.status === "passed")
        return "Ready to install";
    const phaseLabel = {
        preparing: "Preparing candidate",
        resuming: "Checking compatibility",
        comparing: "Checking compatibility",
        applying_patches: "Applying compatibility patches",
        checking: "Checking compatibility",
        repairing: "Repairing compatibility",
        candidate_verified: "Ready to install",
        needs_attention: "Needs attention",
    };
    if (phaseLabel[update.phase])
        return phaseLabel[update.phase];
    if (update.phase === "review_complete" && update.state === "review_required") {
        return "Review finished—compatibility unresolved";
    }
    const state = update.state;
    if (state === "not_checked")
        return "Not checked";
    if (state === "checking")
        return "Checking";
    if (state === "compatible")
        return "Compatible";
    if (state === "fixes_required")
        return "Fixes required";
    return "Review required";
}
function updateTone(state) {
    if (state === "compatible")
        return "ok";
    if (state === "fixes_required")
        return "error";
    return "warn";
}
function pauseActionLabel(action) {
    return ({ retry: "Retry the review", sign_in: "Sign in, then retry", inspect_evidence: "Inspect the evidence", repair: "Repair the installation" })[action];
}
function technicalReportSummary(report) {
    const compatibility = report.update.compatibility;
    const review = report.update.review;
    const reviewSummary = review
        ? `Review: ${review.stage} (${review.policy})\nFiles: ${review.files.accounted}/${review.files.total}\nQuestions: ${review.questions.completed}/${review.questions.total} (${review.questions.reused} reused)\nEntries: ${review.entries}\nLimitations: ${review.limitations}${review.pause ? `\nPause: ${review.pause.code} — ${review.pause.message}` : ""}`
        : "Review progress is not available for this legacy report.";
    return [
        `Tweakers: ${versionAndBuild(report.target.version, report.target.build)}`,
        `Health: ${report.health.state} (${report.health.broker})`,
        `Update: ${updateStateLabel(report.update)} — ${report.update.progress || "No update work is running."}`,
        compatibility ? `Compatibility: ${compatibility.status}\nChecks: ${compatibility.checks.length}\nRepair attempts: ${compatibility.repairs.length}` : reviewSummary,
        `Paths: ${report.target.appPath}\nRuntime: ${report.target.runtimeRoot ?? "Not available"}\nBroker: ${report.target.brokerRoot ?? "Not available"}`,
        report.update.usageDetails ? `Usage trace:\n${JSON.stringify(report.update.usageDetails, null, 2)}` : "Usage trace unavailable.",
        report.update.handoff ? `Handoff:\n${report.update.handoff}` : "No handoff.",
    ].join("\n\n");
}
function actionName(action) {
    return action.charAt(0).toUpperCase() + action.slice(1);
}
function readableDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString();
}
function versionAndBuild(version, build) {
    if (!version && !build)
        return "Not available";
    if (version && build)
        return `${version} (${build})`;
    return version ?? `Build ${build}`;
}
function isDoctorReport(value) {
    if (!value || typeof value !== "object")
        return false;
    const report = value;
    const usageDetails = report.update?.usageDetails;
    const review = report.update?.review;
    const validReview = review === undefined || (review.version === 1 && review.policy === "finish_automatically"
        && ["preparing", "explaining", "ready", "action_required", "deferred", "superseded"].includes(review.stage)
        && [review.files?.total, review.files?.accounted, review.questions?.total, review.questions?.completed, review.questions?.reused, review.entries, review.limitations].every((value) => Number.isSafeInteger(value) && value >= 0)
        && (review.pause === undefined || ["source_unavailable", "provider_unavailable", "usage_unavailable", "no_progress", "compatibility_required"].includes(review.pause.code)
            && typeof review.pause.message === "string" && ["retry", "sign_in", "inspect_evidence", "repair"].includes(review.pause.action)));
    const validUsageDetails = usageDetails === undefined || (usageDetails.version === 1
        && Number.isSafeInteger(usageDetails.allowances) && usageDetails.allowances >= 1
        && Array.isArray(usageDetails.requests)
        && usageDetails.requests.every((request) => typeof request.id === "string"
            && [request.inputTokens, request.cachedInputTokens, request.outputTokens].every((tokens) => tokens === null || (typeof tokens === "number" && tokens >= 0))
            && [request.model, request.effort, request.configuredModel, request.configuredEffort, request.stage].every((item) => item === null || typeof item === "string")));
    const compatibility = report.update?.compatibility;
    const validCompatibility = compatibility === undefined || (compatibility.version === 1 && compatibility.policyVersion === 1
        && ["passed", "conflict", "verification_unavailable"].includes(compatibility.status)
        && typeof compatibility.fingerprint === "string" && /^sha256:[a-f0-9]{64}$/.test(compatibility.fingerprint)
        && !!compatibility.binding && [compatibility.binding.beforeFingerprint, compatibility.binding.afterFingerprint, compatibility.binding.comparisonFingerprint, compatibility.binding.tweakersFingerprint, compatibility.binding.configurationFingerprint, compatibility.binding.validationFingerprint].every((value) => typeof value === "string")
        && (compatibility.binding.candidateFingerprint === null || typeof compatibility.binding.candidateFingerprint === "string")
        && Array.isArray(compatibility.checks) && compatibility.checks.every((check) => typeof check.id === "string" && typeof check.owner === "string" && ["passed", "conflict", "verification_unavailable"].includes(check.outcome) && typeof check.expected === "string" && typeof check.observed === "string" && Array.isArray(check.evidence) && check.evidence.every((item) => typeof item === "string") && typeof check.nextAction === "string")
        && Array.isArray(compatibility.repairs) && compatibility.repairs.every((repair) => typeof repair.conflictId === "string" && Number.isSafeInteger(repair.attempt) && repair.attempt >= 1 && ["reserved", "completed", "rejected", "interrupted"].includes(repair.status) && typeof repair.evidence === "string" && typeof repair.summary === "string")
        && Array.isArray(compatibility.postInstallChecks) && compatibility.postInstallChecks.every((item) => typeof item === "string"));
    const adoption = report.adoption;
    const validAdoption = adoption === undefined || adoption === null || (adoption.schemaVersion === 1
        && Array.isArray(adoption.report?.changes) && adoption.report.changes.every(isDoctorChange)
        && validUpdaterEvidence(adoption.report.updaterEvidence)
        && (adoption.report.changelog === undefined || isDoctorChangelog(adoption.report.changelog))
        && Array.isArray(adoption.blockers));
    return report.schemaVersion === 1
        && report.kind === "tweakers-independent-doctor"
        && typeof report.fingerprint === "string"
        && /^sha256:[a-f0-9]{64}$/.test(report.fingerprint)
        && report.target?.kind === "independent"
        && typeof report.target.appPath === "string"
        && typeof report.target.nativeAppPath === "string"
        && ["healthy", "attention", "blocked"].includes(report.health?.state ?? "")
        && typeof report.health?.broker === "string"
        && ["not_checked", "checking", "compatible", "fixes_required", "review_required"].includes(report.update?.state ?? "")
        && Array.isArray(report.findings)
        && Array.isArray(report.actions)
        && (report.workflowVersion === undefined || report.workflowVersion === 2)
        && validUsageDetails && validReview && validCompatibility
        && validAdoption
        && report.actions.length >= 4 && report.actions.length <= 9
        && ["scan", "repair", "retry", "update"].every((id) => report.actions?.filter((action) => action.id === id
            && typeof action.enabled === "boolean"
            && typeof action.label === "string"
            && Array.isArray(action.blockers)).length === 1);
}
function isDoctorChangelog(value) {
    if (!value || typeof value !== "object")
        return false;
    const log = value;
    return log.schemaVersion === 1 && Array.isArray(log.entries) && Array.isArray(log.unresolved)
        && log.entries.every((entry) => typeof entry.id === "string"
            && ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"].includes(entry.category)
            && [entry.title, entry.workflow, entry.before, entry.after].every((item) => typeof item === "string" && item.trim().length > 0)
            && entry.before !== entry.after
            && ["inferred_from_code", "observed", "documented_upstream"].includes(entry.status)
            && ["upstream", "tweakers"].includes(entry.origin)
            && Array.isArray(entry.analysisGroupIds) && entry.analysisGroupIds.every((item) => typeof item === "string")
            && Array.isArray(entry.dependencies) && entry.dependencies.every((item) => typeof item === "string")
            && (entry.decisionDependencies === undefined || Array.isArray(entry.decisionDependencies) && entry.decisionDependencies.every((item) => typeof item === "string"))
            && Array.isArray(entry.limitations) && entry.limitations.every((item) => typeof item === "string")
            && Array.isArray(entry.evidenceReferences) && entry.evidenceReferences.every((reference) => typeof reference.id === "string" && /^sha256:[a-f0-9]{64}$/.test(reference.sha256)))
        && log.unresolved.every((item) => typeof item.groupId === "string" && typeof item.reason === "string" && item.reason.trim().length > 0);
}
function isDoctorChange(value) {
    if (!value || typeof value !== "object")
        return false;
    const change = value;
    const explanation = change.explanation;
    const validExplanation = explanation === undefined || (typeof explanation.summary === "string"
        && Array.isArray(explanation.evidenceReferences)
        && explanation.evidenceReferences.every((reference) => typeof reference.id === "string" && /^sha256:[a-f0-9]{64}$/.test(reference.sha256))
        && Array.isArray(explanation.sourceReferences)
        && explanation.sourceReferences.every((reference) => typeof reference.path === "string" && /^sha256:[a-f0-9]{64}$/.test(reference.sha256)));
    const reviewWork = change.reviewWork;
    const validReviewWork = reviewWork === undefined || (reviewWork.version === 1
        && ["behavior", "internal", "evidence_needed", "observation_limit"].includes(reviewWork.kind)
        && ["changed_behavior", "packaging", "identical_content", "opaque_binary", "source_unavailable", "unsupported_syntax", "unclassified_change"].includes(reviewWork.reasonCode)
        && typeof reviewWork.question === "string");
    return typeof change.id === "string" && typeof change.title === "string"
        && typeof change.before === "string" && typeof change.after === "string"
        && Array.isArray(change.evidence) && Array.isArray(change.compatibility)
        && Array.isArray(change.overrides) && validExplanation && validReviewWork;
}
function validUpdaterEvidence(value) {
    if (value === undefined)
        return true;
    if (!value || typeof value !== "object")
        return false;
    const evidence = value;
    return evidence.schemaVersion === 1 && typeof evidence.protocolFingerprint === "string"
        && /^sha256:[a-f0-9]{64}$/.test(evidence.protocolFingerprint)
        && Array.isArray(evidence.interfaces) && evidence.interfaces.every(item => item && typeof item.method === "string" && typeof item.owner === "string"
        && ["compatible", "incompatible", "unresolved"].includes(item.status) && Array.isArray(item.reasons) && item.reasons.every(reason => typeof reason === "string"))
        && !!evidence.upstream && ["not_attempted", "unavailable", "verified"].includes(evidence.upstream.status) && typeof evidence.upstream.summary === "string"
        && (evidence.upstream.url === undefined || typeof evidence.upstream.url === "string" && /^https:\/\/(?:api\.)?github\.com\//.test(evidence.upstream.url))
        && (evidence.checks === undefined || Array.isArray(evidence.checks) && evidence.checks.every(item => item && typeof item.id === "string"
            && ["passed", "failed", "unsupported"].includes(item.state) && typeof item.summary === "string" && typeof item.scope === "string"));
}
//# sourceMappingURL=doctor-view.js.map