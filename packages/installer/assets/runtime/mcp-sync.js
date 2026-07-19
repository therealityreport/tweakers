"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USER_QUESTIONS_SANDBOX_MODE = exports.USER_QUESTIONS_APPROVAL_POLICY = exports.USER_QUESTIONS_MCP_SERVER_NAME = exports.MCP_MANAGED_END = exports.MCP_MANAGED_START = void 0;
exports.withMcpConfigMutationLock = withMcpConfigMutationLock;
exports.syncManagedMcpServers = syncManagedMcpServers;
exports.buildManagedMcpBlock = buildManagedMcpBlock;
exports.planManagedMcpReconciliation = planManagedMcpReconciliation;
exports.planUserQuestionsApprovalPolicy = planUserQuestionsApprovalPolicy;
exports.sanitizePreservedApprovalPolicy = sanitizePreservedApprovalPolicy;
exports.sanitizePreservedMcpOptions = sanitizePreservedMcpOptions;
exports.mergeManagedMcpBlock = mergeManagedMcpBlock;
exports.stripManagedMcpBlock = stripManagedMcpBlock;
exports.mcpServerNameFromTweakId = mcpServerNameFromTweakId;
exports.assertValidTomlDocument = assertValidTomlDocument;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.MCP_MANAGED_START = "# BEGIN TWEAKER MANAGED MCP SERVERS";
exports.MCP_MANAGED_END = "# END TWEAKER MANAGED MCP SERVERS";
exports.USER_QUESTIONS_MCP_SERVER_NAME = "co-tweakers-user-questions";
exports.USER_QUESTIONS_APPROVAL_POLICY = "approval_policy = { granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }";
exports.USER_QUESTIONS_SANDBOX_MODE = 'sandbox_mode = "danger-full-access"';
const LEGACY_MCP_MANAGED_START = ["# BEGIN CODEX", "++ MANAGED MCP SERVERS"].join("");
const LEGACY_MCP_MANAGED_END = ["# END CODEX", "++ MANAGED MCP SERVERS"].join("");
const activeMcpConfigMutations = new Set();
function withMcpConfigMutationLock(configPath, mutate) {
    const mutationKey = (0, node_path_1.resolve)(configPath);
    if (activeMcpConfigMutations.has(mutationKey)) {
        throw new Error(`MCP config mutation is already in progress for ${mutationKey}`);
    }
    activeMcpConfigMutations.add(mutationKey);
    try {
        return mutate();
    }
    finally {
        activeMcpConfigMutations.delete(mutationKey);
    }
}
function syncManagedMcpServers({ configPath, tweaks, }) {
    return withMcpConfigMutationLock(configPath, () => {
        const current = (0, node_fs_1.existsSync)(configPath) ? (0, node_fs_1.readFileSync)(configPath, "utf8") : "";
        assertValidTomlDocument(current);
        const built = buildManagedMcpBlock(tweaks, current);
        const next = mergeManagedMcpBlock(current, built.block);
        if (next !== current) {
            (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(configPath), { recursive: true });
            (0, node_fs_1.writeFileSync)(configPath, next, "utf8");
        }
        return { ...built, changed: next !== current };
    });
}
function buildManagedMcpBlock(tweaks, existingToml = "") {
    const manualToml = stripManagedMcpBlock(existingToml);
    const manualNames = findMcpServerNames(manualToml);
    const usedNames = new Set(manualNames);
    const serverNames = [];
    const skippedServerNames = [];
    const entries = [];
    for (const tweak of tweaks) {
        const mcp = normalizeMcpServer(tweak.manifest.mcp);
        if (!mcp)
            continue;
        const baseName = mcpServerNameFromTweakId(tweak.manifest.id);
        if (manualNames.has(baseName)) {
            skippedServerNames.push(baseName);
            continue;
        }
        const serverName = reserveUniqueName(baseName, usedNames);
        serverNames.push(serverName);
        entries.push(formatMcpServer(serverName, tweak.dir, mcp));
    }
    if (entries.length === 0) {
        return { block: "", serverNames, skippedServerNames };
    }
    return {
        block: [exports.MCP_MANAGED_START, ...entries, exports.MCP_MANAGED_END].join("\n"),
        serverNames,
        skippedServerNames,
    };
}
function planManagedMcpReconciliation(tweaks, currentToml = "", options = {}) {
    assertValidTomlDocument(currentToml);
    const ownedTweaks = options.ownedTweaks ?? tweaks;
    const ownedByName = indexOwnedMcpTweaks(ownedTweaks);
    const desiredByName = indexDesiredMcpTweaks(tweaks, ownedByName);
    const preservedOptions = sanitizePreservedMcpOptions(options.preservedOptions, ownedByName.keys());
    const allTables = findMcpServerTables(currentToml);
    let manualToml = stripManagedMcpBlock(currentToml);
    const tables = findMcpServerTables(manualToml);
    const desiredNames = [];
    const appliedNames = [];
    const migrations = [];
    const conflicts = [];
    const entries = [];
    const rangesToRemove = [];
    for (const [canonicalName, tweak] of ownedByName) {
        const mcp = normalizeMcpServer(tweak.manifest.mcp);
        if (!mcp)
            throw new Error(`Owned MCP tweak ${tweak.manifest.id} has an invalid MCP declaration`);
        const desired = desiredByName.has(canonicalName);
        if (desired)
            desiredNames.push(canonicalName);
        const canonicalTables = tables.filter((table) => table.name === canonicalName);
        const nestedCanonicalTables = tables.filter((table) => table.name.startsWith(`${canonicalName}.`));
        const legacyName = legacyMcpServerName(tweak.manifest.id);
        const legacyTables = legacyName
            ? tables.filter((table) => table.name === legacyName)
            : [];
        const nestedLegacyTables = legacyName
            ? tables.filter((table) => table.name.startsWith(`${legacyName}.`))
            : [];
        const ownedLegacySpec = legacyTables.length === 1
            && nestedLegacyTables.length === 0
            ? matchingMcpTableSpec(legacyTables[0], tweak.dir, mcp)
            : null;
        const exactlyOwnedLegacy = ownedLegacySpec !== null;
        // Canonical entries inside the old managed block are stripped before
        // collision detection. Retain their supported policy fields so a later
        // reconciliation does not silently erase a policy preserved during the
        // legacy-name migration.
        const priorManagedCanonicalTables = canonicalTables.length === 0
            ? allTables.filter((table) => table.name === canonicalName)
            : [];
        const priorManagedCanonicalSpec = priorManagedCanonicalTables.length === 1
            ? matchingMcpTableSpec(priorManagedCanonicalTables[0], tweak.dir, mcp)
            : null;
        const ownedCanonicalSpec = canonicalTables.length === 1
            && nestedCanonicalTables.length === 0
            ? matchingMcpTableSpec(canonicalTables[0], tweak.dir, mcp)
            : null;
        const exactlyOwnedCanonical = ownedCanonicalSpec !== null;
        const observedOptions = ownedLegacySpec ?? ownedCanonicalSpec ?? priorManagedCanonicalSpec;
        if (observedOptions) {
            const nextOptions = pickPreservedOptions(observedOptions);
            if (Object.keys(nextOptions).length > 0)
                preservedOptions[canonicalName] = nextOptions;
            else
                delete preservedOptions[canonicalName];
        }
        if (legacyName && exactlyOwnedLegacy) {
            rangesToRemove.push(legacyTables[0]);
            if (desired)
                migrations.push({ from: legacyName, to: canonicalName });
        }
        if (canonicalTables.length > 0) {
            if (canonicalTables.length === 1 && nestedCanonicalTables.length === 0 && exactlyOwnedCanonical) {
                rangesToRemove.push(canonicalTables[0]);
            }
            else {
                conflicts.push({
                    observedName: canonicalName,
                    canonicalName,
                    reason: "canonical-collision",
                });
                continue;
            }
        }
        else if (nestedCanonicalTables.length > 0) {
            conflicts.push({
                observedName: canonicalName,
                canonicalName,
                reason: "canonical-collision",
            });
            continue;
        }
        if (legacyName) {
            if (legacyTables.length > 1) {
                conflicts.push({
                    observedName: legacyName,
                    canonicalName,
                    reason: "ambiguous-legacy",
                });
                continue;
            }
            if (nestedLegacyTables.length > 0) {
                conflicts.push({
                    observedName: legacyName,
                    canonicalName,
                    reason: "legacy-shape-mismatch",
                });
                continue;
            }
            if (legacyTables.length === 1 && !exactlyOwnedLegacy) {
                conflicts.push({
                    observedName: legacyName,
                    canonicalName,
                    reason: "legacy-shape-mismatch",
                });
                continue;
            }
        }
        if (!desired)
            continue;
        appliedNames.push(canonicalName);
        entries.push(formatMcpServer(canonicalName, tweak.dir, mcp, preservedOptions[canonicalName]));
    }
    for (const range of [...rangesToRemove].sort((left, right) => right.start - left.start)) {
        manualToml = `${manualToml.slice(0, range.start)}${manualToml.slice(range.end)}`;
    }
    const block = entries.length > 0
        ? [exports.MCP_MANAGED_START, ...entries, exports.MCP_MANAGED_END].join("\n")
        : "";
    const removedManagedBlock = manualToml !== currentToml;
    const nextToml = !block && removedManagedBlock
        ? manualToml.trimEnd() ? `${manualToml.trimEnd()}\n` : ""
        : mergeManagedMcpBlock(manualToml, block);
    const changed = nextToml !== currentToml;
    return {
        nextToml,
        desiredNames,
        appliedNames,
        migrations,
        conflicts,
        preservedOptions,
        approvalPolicy: unchangedApprovalPolicy(findTopLevelApprovalPolicies(currentToml)[0]?.raw ?? null, null),
        preservedApprovalPolicy: null,
        changed,
        restartRequired: changed,
    };
}
const TOP_LEVEL_APPROVAL_POLICY_ASSIGNMENT = /^\s*(?:approval_policy|"approval_policy"|'approval_policy')\s*=/;
const TOP_LEVEL_SANDBOX_MODE_ASSIGNMENT = /^\s*(?:sandbox_mode|"sandbox_mode"|'sandbox_mode')\s*=/;
function planUserQuestionsApprovalPolicy({ currentToml, candidateToml, owned, enabled, preserved, }) {
    const currentAssignments = findTopLevelApprovalPolicies(currentToml);
    const currentSandboxAssignments = findTopLevelSandboxModes(currentToml);
    const beforeRaw = currentAssignments[0]?.raw ?? null;
    const beforeSandboxModeRaw = currentSandboxAssignments[0]?.raw ?? null;
    if (!owned) {
        return {
            nextToml: candidateToml,
            preserved: null,
            receipt: unchangedApprovalPolicy(beforeRaw, null, beforeSandboxModeRaw),
        };
    }
    if (currentAssignments.length > 1 || (enabled && currentSandboxAssignments.length > 1)) {
        return {
            nextToml: currentToml,
            preserved,
            receipt: {
                ...unchangedApprovalPolicy(beforeRaw, preserved, beforeSandboxModeRaw),
                status: "conflict",
                error: currentAssignments.length > 1
                    ? "Duplicate top-level approval_policy assignments"
                    : "Duplicate top-level sandbox_mode assignments",
            },
        };
    }
    if (enabled) {
        const captured = preserved ?? {
            present: currentAssignments.length === 1,
            rawAssignment: beforeRaw,
        };
        const withApprovalPolicy = replaceTopLevelApprovalPolicy(candidateToml, exports.USER_QUESTIONS_APPROVAL_POLICY);
        const nextToml = replaceTopLevelSandboxMode(withApprovalPolicy, exports.USER_QUESTIONS_SANDBOX_MODE);
        const afterRaw = findTopLevelApprovalPolicies(nextToml)[0]?.raw ?? null;
        const afterSandboxModeRaw = findTopLevelSandboxModes(nextToml)[0]?.raw ?? null;
        return {
            nextToml,
            preserved: captured,
            receipt: {
                status: nextToml === candidateToml ? "unchanged" : "managed",
                beforeRaw,
                afterRaw,
                preservedOriginalRaw: captured.rawAssignment,
                preservedOriginalPresent: captured.present,
                sandboxModeBeforeRaw: beforeSandboxModeRaw,
                sandboxModeAfterRaw: afterSandboxModeRaw,
                restartRequired: nextToml !== candidateToml,
            },
        };
    }
    if (!preserved) {
        return {
            nextToml: candidateToml,
            preserved: null,
            receipt: unchangedApprovalPolicy(beforeRaw, null, beforeSandboxModeRaw),
        };
    }
    const nextToml = preserved.present && preserved.rawAssignment !== null
        ? replaceTopLevelApprovalPolicy(candidateToml, preserved.rawAssignment)
        : removeTopLevelApprovalPolicy(candidateToml);
    const afterRaw = findTopLevelApprovalPolicies(nextToml)[0]?.raw ?? null;
    const afterSandboxModeRaw = findTopLevelSandboxModes(nextToml)[0]?.raw ?? null;
    return {
        nextToml,
        preserved: null,
        receipt: {
            status: nextToml === candidateToml ? "unchanged" : "restored",
            beforeRaw,
            afterRaw,
            preservedOriginalRaw: preserved.rawAssignment,
            preservedOriginalPresent: preserved.present,
            sandboxModeBeforeRaw: beforeSandboxModeRaw,
            sandboxModeAfterRaw: afterSandboxModeRaw,
            restartRequired: nextToml !== candidateToml,
        },
    };
}
function unchangedApprovalPolicy(raw, preserved, sandboxModeRaw = null) {
    return {
        status: "unchanged",
        beforeRaw: raw,
        afterRaw: raw,
        preservedOriginalRaw: preserved?.rawAssignment ?? null,
        preservedOriginalPresent: preserved?.present ?? false,
        sandboxModeBeforeRaw: sandboxModeRaw,
        sandboxModeAfterRaw: sandboxModeRaw,
        restartRequired: false,
    };
}
function sanitizePreservedApprovalPolicy(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    if (typeof record.present !== "boolean")
        return null;
    if (record.rawAssignment !== null && typeof record.rawAssignment !== "string")
        return null;
    if (record.present !== (record.rawAssignment !== null))
        return null;
    if (typeof record.rawAssignment === "string") {
        if (/[\r\n]/.test(record.rawAssignment))
            return null;
        if (!TOP_LEVEL_APPROVAL_POLICY_ASSIGNMENT.test(record.rawAssignment))
            return null;
        try {
            assertValidTomlDocument(`${record.rawAssignment}\n`);
        }
        catch {
            return null;
        }
        const assignments = findTopLevelApprovalPolicies(`${record.rawAssignment}\n`);
        if (assignments.length !== 1 || assignments[0]?.raw !== record.rawAssignment)
            return null;
    }
    return { present: record.present, rawAssignment: record.rawAssignment };
}
function findTopLevelApprovalPolicies(toml) {
    return findTopLevelAssignments(toml, TOP_LEVEL_APPROVAL_POLICY_ASSIGNMENT);
}
function findTopLevelSandboxModes(toml) {
    return findTopLevelAssignments(toml, TOP_LEVEL_SANDBOX_MODE_ASSIGNMENT);
}
function findTopLevelAssignments(toml, assignmentPattern) {
    const assignments = [];
    for (const line of classifyTomlLines(toml)) {
        if (!line.structural)
            continue;
        if (/^\s*\[/.test(line.text))
            break;
        if (!assignmentPattern.test(line.text))
            continue;
        assignments.push({
            start: line.start,
            end: line.end,
            raw: line.text,
            lineEnding: toml.slice(line.start + line.text.length, line.end),
        });
    }
    return assignments;
}
function replaceTopLevelApprovalPolicy(toml, raw) {
    return replaceTopLevelAssignment(toml, raw, findTopLevelApprovalPolicies(toml));
}
function replaceTopLevelSandboxMode(toml, raw) {
    return replaceTopLevelAssignment(toml, raw, findTopLevelSandboxModes(toml));
}
function replaceTopLevelAssignment(toml, raw, assignments) {
    if (assignments.length > 1)
        return toml;
    const existing = assignments[0];
    if (existing) {
        return `${toml.slice(0, existing.start)}${raw}${existing.lineEnding}${toml.slice(existing.end)}`;
    }
    const firstTableOrManagedBlock = classifyTomlLines(toml)
        .find((line) => line.structural && (/^\s*\[/.test(line.text)
        || line.text.trim() === exports.MCP_MANAGED_START
        || line.text.trim() === LEGACY_MCP_MANAGED_START));
    // Top-level assignments must remain outside the managed MCP block. Inserting
    // immediately before its first table places the assignment between the
    // markers, so the next reconciliation strips it and reports a false change.
    const insertion = firstTableOrManagedBlock?.start ?? toml.length;
    const prefix = toml.slice(0, insertion);
    const separator = prefix && !/[\r\n]$/.test(prefix) ? "\n" : "";
    const beforeManagedBlock = firstTableOrManagedBlock !== undefined
        && [exports.MCP_MANAGED_START, LEGACY_MCP_MANAGED_START].includes(firstTableOrManagedBlock.text.trim());
    return `${prefix}${separator}${raw}\n${beforeManagedBlock ? "\n" : ""}${toml.slice(insertion)}`;
}
function removeTopLevelApprovalPolicy(toml) {
    const assignments = findTopLevelApprovalPolicies(toml);
    if (assignments.length !== 1)
        return toml;
    const existing = assignments[0];
    return `${toml.slice(0, existing.start)}${toml.slice(existing.end)}`;
}
function indexOwnedMcpTweaks(tweaks) {
    const indexed = new Map();
    for (const tweak of tweaks) {
        if (!normalizeMcpServer(tweak.manifest.mcp))
            continue;
        const canonicalName = mcpServerNameFromTweakId(tweak.manifest.id);
        if (indexed.has(canonicalName)) {
            throw new Error(`Ambiguous owned MCP declaration for ${canonicalName}`);
        }
        indexed.set(canonicalName, tweak);
    }
    return indexed;
}
function indexDesiredMcpTweaks(tweaks, ownedByName) {
    const indexed = new Map();
    for (const tweak of tweaks) {
        if (!normalizeMcpServer(tweak.manifest.mcp))
            continue;
        const canonicalName = mcpServerNameFromTweakId(tweak.manifest.id);
        const owned = ownedByName.get(canonicalName);
        if (!owned || owned.manifest.id !== tweak.manifest.id) {
            throw new Error(`Desired MCP tweak ${tweak.manifest.id} is not in the owned MCP registry`);
        }
        if (indexed.has(canonicalName)) {
            throw new Error(`Ambiguous desired MCP declaration for ${canonicalName}`);
        }
        indexed.set(canonicalName, tweak);
    }
    return indexed;
}
function sanitizePreservedMcpOptions(value, allowedServerNames) {
    const allowed = new Set(allowedServerNames);
    const sanitized = {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        return sanitized;
    for (const [serverName, rawOptions] of Object.entries(value)) {
        if (!allowed.has(serverName) || !rawOptions || typeof rawOptions !== "object" || Array.isArray(rawOptions)) {
            continue;
        }
        const entries = Object.entries(rawOptions);
        if (entries.some(([key]) => key !== "defaultToolsApprovalMode"))
            continue;
        const approval = rawOptions.defaultToolsApprovalMode;
        if (approval === "approve")
            sanitized[serverName] = { defaultToolsApprovalMode: "approve" };
        else if (approval !== undefined)
            continue;
    }
    return sanitized;
}
function pickPreservedOptions(spec) {
    return spec.defaultToolsApprovalMode === "approve"
        ? { defaultToolsApprovalMode: "approve" }
        : {};
}
function mergeManagedMcpBlock(currentToml, managedBlock) {
    const stripped = stripManagedMcpBlock(currentToml).trimEnd();
    if (!managedBlock && stripped === currentToml.trimEnd())
        return currentToml;
    if (!managedBlock)
        return stripped ? `${stripped}\n` : "";
    return `${stripped ? `${stripped}\n\n` : ""}${managedBlock}\n`;
}
function stripManagedMcpBlock(toml) {
    const markers = new Map([
        [exports.MCP_MANAGED_START, exports.MCP_MANAGED_END],
        [LEGACY_MCP_MANAGED_START, LEGACY_MCP_MANAGED_END],
    ]);
    const ranges = [];
    let open = null;
    for (const line of classifyTomlLines(toml)) {
        if (!line.structural)
            continue;
        const marker = line.text.trim();
        const startMarker = markers.get(marker);
        const endMarker = [...markers.entries()].find(([, value]) => value === marker)?.[0] ?? null;
        if (startMarker) {
            if (open)
                throw malformedToml("managed MCP marker block is nested or missing its end marker");
            open = { start: line.start, end: startMarker };
            continue;
        }
        if (!endMarker)
            continue;
        if (!open || open.end !== marker) {
            throw malformedToml("managed MCP marker block has an unmatched end marker");
        }
        let rangeStart = open.start;
        if (rangeStart > 0) {
            if (toml[rangeStart - 1] === "\n")
                rangeStart -= 1;
            else if (toml[rangeStart - 1] === "\r") {
                rangeStart -= 1;
                if (rangeStart > 0 && toml[rangeStart - 1] === "\n")
                    rangeStart -= 1;
            }
        }
        ranges.push({ start: rangeStart, end: line.end });
        open = null;
    }
    if (open)
        throw malformedToml("managed MCP marker block is missing its end marker");
    let stripped = toml;
    for (const range of ranges.sort((left, right) => right.start - left.start)) {
        stripped = `${stripped.slice(0, range.start)}\n${stripped.slice(range.end)}`;
    }
    return stripped;
}
function mcpServerNameFromTweakId(id) {
    const slug = id
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    return slug || "tweak-mcp";
}
/**
 * Validate the complete document before MCP code inspects or rewrites any
 * section. This intentionally validates syntax without normalizing the parsed
 * representation so manual configuration can still be preserved byte-for-byte.
 */
function assertValidTomlDocument(toml) {
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(toml)) {
        throw malformedToml("contains a disallowed control character");
    }
    const statements = scanTomlStatements(toml);
    for (const { value, line } of statements) {
        const statement = value.trim();
        if (!statement)
            continue;
        if (statement.startsWith("[")) {
            const arrayTable = statement.startsWith("[[");
            const openLength = arrayTable ? 2 : 1;
            const close = arrayTable ? "]]" : "]";
            if (!statement.endsWith(close)) {
                throw malformedToml(`invalid table header at line ${line}`);
            }
            const key = statement.slice(openLength, -openLength).trim();
            if (!isValidTomlKeyPath(key)) {
                throw malformedToml(`invalid table name at line ${line}`);
            }
            continue;
        }
        const assignment = findTopLevelCharacter(statement, "=");
        if (assignment <= 0) {
            throw malformedToml(`expected a key/value assignment at line ${line}`);
        }
        const key = statement.slice(0, assignment).trim();
        const assignedValue = statement.slice(assignment + 1).trim();
        if (!isValidTomlKeyPath(key)) {
            throw malformedToml(`invalid key at line ${line}`);
        }
        if (!isValidTomlValue(assignedValue)) {
            throw malformedToml(`invalid value for ${key} at line ${line}`);
        }
    }
}
function scanTomlStatements(toml) {
    const statements = [];
    let buffer = "";
    let line = 1;
    let statementLine = 1;
    let squareDepth = 0;
    let curlyDepth = 0;
    let quote = null;
    let escaped = false;
    let comment = false;
    const flush = () => {
        if (buffer.trim())
            statements.push({ value: buffer, line: statementLine });
        buffer = "";
        statementLine = line + 1;
    };
    for (let index = 0; index < toml.length; index += 1) {
        const character = toml[index];
        const triple = toml.slice(index, index + 3);
        if (comment) {
            if (character !== "\n" && character !== "\r")
                continue;
            comment = false;
        }
        if (quote === "multiline-basic" || quote === "multiline-literal") {
            const delimiter = quote === "multiline-basic" ? '\"\"\"' : "'''";
            if (!escaped && triple === delimiter) {
                buffer += triple;
                index += 2;
                quote = null;
                continue;
            }
            buffer += character;
            if (character === "\n")
                line += 1;
            if (quote === "multiline-basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
            }
            continue;
        }
        if (quote === "basic" || quote === "literal") {
            buffer += character;
            if (character === "\n" || character === "\r") {
                throw malformedToml(`unterminated string at line ${line}`);
            }
            if (quote === "basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
                else if (character === '\"')
                    quote = null;
            }
            else if (character === "'") {
                quote = null;
            }
            continue;
        }
        if (triple === '\"\"\"' || triple === "'''") {
            quote = triple === '\"\"\"' ? "multiline-basic" : "multiline-literal";
            buffer += triple;
            index += 2;
            continue;
        }
        if (character === '\"' || character === "'") {
            quote = character === '\"' ? "basic" : "literal";
            buffer += character;
            continue;
        }
        if (character === "#") {
            comment = true;
            continue;
        }
        if (character === "[")
            squareDepth += 1;
        if (character === "]")
            squareDepth -= 1;
        if (character === "{")
            curlyDepth += 1;
        if (character === "}")
            curlyDepth -= 1;
        if (squareDepth < 0 || curlyDepth < 0) {
            throw malformedToml(`unexpected closing delimiter at line ${line}`);
        }
        if (character === "\n" || character === "\r") {
            if (character === "\n")
                line += 1;
            if (squareDepth === 0 && curlyDepth === 0)
                flush();
            else
                buffer += "\n";
            continue;
        }
        buffer += character;
    }
    if (quote)
        throw malformedToml(`unterminated string at line ${line}`);
    if (squareDepth !== 0 || curlyDepth !== 0) {
        throw malformedToml(`unterminated delimiter at line ${line}`);
    }
    flush();
    return statements;
}
function isValidTomlKeyPath(value) {
    const bareOrQuoted = String.raw `(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
    return new RegExp(`^${bareOrQuoted}(?:\\s*\\.\\s*${bareOrQuoted})*$`).test(value);
}
function isValidTomlValue(value) {
    if (!value)
        return false;
    if ((value.startsWith('\"\"\"') && value.endsWith('\"\"\"'))
        || (value.startsWith("'''") && value.endsWith("'''")))
        return true;
    if (value.startsWith('\"') && value.endsWith('\"'))
        return isValidBasicTomlString(value);
    if (value.startsWith("'") && value.endsWith("'"))
        return !/[\r\n]/.test(value.slice(1, -1));
    if (value.startsWith("[") && value.endsWith("]")) {
        const parts = splitTopLevel(value.slice(1, -1), ",");
        return parts.every((part, index) => (part.trim()
            ? isValidTomlValue(part.trim())
            : index === parts.length - 1));
    }
    if (value.startsWith("{") && value.endsWith("}")) {
        const body = value.slice(1, -1);
        if (!body.trim())
            return true;
        return splitTopLevel(body, ",").every((part) => {
            if (!part.trim())
                return false;
            const assignment = findTopLevelCharacter(part, "=");
            return assignment > 0
                && isValidTomlKeyPath(part.slice(0, assignment).trim())
                && isValidTomlValue(part.slice(assignment + 1).trim());
        });
    }
    if (/^(?:true|false|[-+]?inf|[-+]?nan)$/.test(value))
        return true;
    if (/^[-+]?(?:0|[1-9](?:_?\d)*|0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$/.test(value))
        return true;
    if (/^[-+]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][-+]?\d(?:_?\d)*)?|\d(?:_?\d)*(?:[eE][-+]?\d(?:_?\d)*))$/.test(value))
        return true;
    return /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[-+]\d{2}:\d{2})?)?$/.test(value)
        || /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
}
function isValidBasicTomlString(value) {
    const body = value.slice(1, -1);
    for (let index = 0; index < body.length; index += 1) {
        if (body[index] !== "\\")
            continue;
        const escape = body[index + 1];
        if (!escape || !'btnfr"\\'.includes(escape)) {
            const width = escape === "u" ? 4 : escape === "U" ? 8 : 0;
            if (width === 0 || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(body.slice(index + 2, index + 2 + width))) {
                return false;
            }
            index += width + 1;
            continue;
        }
        index += 1;
    }
    return !/[\r\n]/.test(body);
}
function findTopLevelCharacter(value, target) {
    const parts = splitTopLevelWithOffsets(value, target);
    return parts.length > 1 ? parts[0].end : -1;
}
function splitTopLevel(value, separator) {
    return splitTopLevelWithOffsets(value, separator).map((part) => part.value);
}
function splitTopLevelWithOffsets(value, separator) {
    const parts = [];
    let start = 0;
    let squareDepth = 0;
    let curlyDepth = 0;
    let quote = null;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index];
        if (quote) {
            if (quote === '"') {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
                else if (character === quote)
                    quote = null;
            }
            else if (character === quote)
                quote = null;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            continue;
        }
        if (character === "[")
            squareDepth += 1;
        else if (character === "]")
            squareDepth -= 1;
        else if (character === "{")
            curlyDepth += 1;
        else if (character === "}")
            curlyDepth -= 1;
        else if (character === separator && squareDepth === 0 && curlyDepth === 0) {
            parts.push({ value: value.slice(start, index), end: index });
            start = index + 1;
        }
    }
    parts.push({ value: value.slice(start), end: value.length });
    return parts;
}
function malformedToml(detail) {
    return new Error(`Malformed TOML: ${detail}`);
}
/**
 * Classify physical lines without mistaking text inside TOML multiline strings
 * for tables or managed markers. The full TOML validator still owns syntax
 * validation; this scanner only supplies safe structural boundaries.
 */
function classifyTomlLines(toml) {
    const lines = [];
    let lineStart = 0;
    let multiline = null;
    let escaped = false;
    let quote = null;
    let comment = false;
    const pushLine = (end) => {
        lines.push({
            start: lineStart,
            end,
            text: toml.slice(lineStart, end).replace(/[\r\n]+$/, ""),
            structural: multiline === null,
        });
        lineStart = end;
    };
    for (let index = 0; index < toml.length; index += 1) {
        const character = toml[index];
        const triple = toml.slice(index, index + 3);
        if (multiline) {
            const delimiter = multiline === "basic" ? '\"\"\"' : "'''";
            if (!escaped && triple === delimiter) {
                multiline = null;
                index += 2;
                continue;
            }
            if (character === "\n" || character === "\r") {
                if (character === "\r" && toml[index + 1] === "\n")
                    index += 1;
                pushLine(index + 1);
            }
            if (multiline === "basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
            }
            continue;
        }
        if (comment) {
            if (character === "\n" || character === "\r") {
                if (character === "\r" && toml[index + 1] === "\n")
                    index += 1;
                pushLine(index + 1);
                comment = false;
            }
            continue;
        }
        if (quote) {
            if (character === "\n" || character === "\r") {
                if (character === "\r" && toml[index + 1] === "\n")
                    index += 1;
                pushLine(index + 1);
                quote = null;
                escaped = false;
                continue;
            }
            if (quote === "basic") {
                if (escaped)
                    escaped = false;
                else if (character === "\\")
                    escaped = true;
                else if (character === '"')
                    quote = null;
            }
            else if (character === "'")
                quote = null;
            continue;
        }
        if (character === "#") {
            comment = true;
            continue;
        }
        if (triple === '\"\"\"' || triple === "'''") {
            multiline = triple === '\"\"\"' ? "basic" : "literal";
            escaped = false;
            index += 2;
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character === '"' ? "basic" : "literal";
            escaped = false;
            continue;
        }
        if (character === "\n" || character === "\r") {
            if (character === "\r" && toml[index + 1] === "\n")
                index += 1;
            pushLine(index + 1);
        }
    }
    if (lineStart < toml.length || toml.length === 0)
        pushLine(toml.length);
    return lines;
}
function findMcpServerNames(toml) {
    const names = new Set();
    const tablePattern = /^\s*\[mcp_servers\.([^\]\s]+)\]\s*$/m;
    for (const line of classifyTomlLines(toml)) {
        if (!line.structural)
            continue;
        const match = tablePattern.exec(line.text);
        if (match)
            names.add(unquoteTomlKey(match[1] ?? ""));
    }
    return names;
}
function findMcpServerTables(toml) {
    const allHeaders = classifyTomlLines(toml)
        .filter((line) => line.structural)
        .map((line) => ({ line, match: /^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/.exec(line.text) }))
        .filter((entry) => entry.match !== null);
    const tables = [];
    for (let index = 0; index < allHeaders.length; index += 1) {
        const { line, match } = allHeaders[index];
        const header = match[1] ?? "";
        if (!header.startsWith("mcp_servers."))
            continue;
        const rawName = header.slice("mcp_servers.".length).trim();
        const start = line.start;
        const headerEnd = line.end;
        const tableEnd = allHeaders[index + 1]?.line.start ?? toml.length;
        tables.push({
            name: unquoteTomlKey(rawName),
            start,
            // Comments and blank lines immediately before the next table are user
            // formatting, not proof that the legacy table owns them. Keep that
            // trailing trivia in place when the exactly matched table is migrated.
            end: mcpTableContentEnd(toml, headerEnd, tableEnd),
            body: toml.slice(headerEnd, tableEnd),
        });
    }
    return tables;
}
function mcpTableContentEnd(toml, headerEnd, tableEnd) {
    const body = toml.slice(headerEnd, tableEnd);
    let lastContentEnd = 0;
    const lines = body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g);
    for (const line of lines) {
        const value = line[0];
        if (!value)
            continue;
        const withoutEnding = value.replace(/[\r\n]+$/, "");
        const trimmed = withoutEnding.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            lastContentEnd = (line.index ?? 0) + value.length;
        }
    }
    return headerEnd + lastContentEnd;
}
function legacyMcpServerName(tweakId) {
    const match = /^co\.tweakers\.(.+)$/.exec(tweakId);
    if (!match?.[1])
        return null;
    const suffix = match[1]
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    return suffix ? `co-thomashulihan-${suffix}` : null;
}
function matchingMcpTableSpec(table, tweakDir, mcp) {
    const observed = parseMcpTableBody(table.body);
    if (!observed)
        return null;
    const expected = {
        command: resolveCommand(tweakDir, mcp.command),
        args: (mcp.args ?? []).map((arg) => resolveArg(tweakDir, arg)),
        env: mcp.env ?? {},
    };
    return observed.command === expected.command
        && arraysEqual(observed.args, expected.args)
        && recordsEqual(observed.env, expected.env)
        ? observed
        : null;
}
function parseMcpTableBody(body) {
    const fields = new Map();
    for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const match = /^([a-zA-Z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(trimmed);
        if (!match || fields.has(match[1]))
            return null;
        fields.set(match[1], match[2]);
    }
    if ([...fields.keys()].some((key) => ![
        "command",
        "args",
        "env",
        "enabled",
        "default_tools_approval_mode",
    ].includes(key)))
        return null;
    try {
        const command = JSON.parse(fields.get("command") ?? "");
        const args = fields.has("args") ? JSON.parse(fields.get("args") ?? "") : [];
        const env = fields.has("env") ? parseTomlInlineStringTable(fields.get("env") ?? "") : {};
        // Codex persists `enabled = true` for active manual MCP entries. Treat
        // that exact default as ownership-neutral so the legacy Tweakers entry can
        // migrate; false or any non-boolean spelling remains user-owned and fails
        // closed.
        if (fields.has("enabled") && fields.get("enabled") !== "true")
            return null;
        // This is the exact policy Codex persisted for the Tweakers-owned User
        // Questions server. Preserve it through the namespace migration, but do
        // not claim differently configured legacy entries as Tweakers-owned.
        const defaultToolsApprovalMode = fields.has("default_tools_approval_mode")
            ? JSON.parse(fields.get("default_tools_approval_mode") ?? "")
            : undefined;
        if (defaultToolsApprovalMode !== undefined && defaultToolsApprovalMode !== "approve")
            return null;
        if (typeof command !== "string"
            || !Array.isArray(args)
            || args.some((arg) => typeof arg !== "string")
            || !env)
            return null;
        return {
            command,
            args: args,
            env,
            ...(defaultToolsApprovalMode === "approve" ? { defaultToolsApprovalMode } : {}),
        };
    }
    catch {
        return null;
    }
}
function parseTomlInlineStringTable(value) {
    const match = /^\{\s*(.*?)\s*\}$/.exec(value);
    if (!match)
        return null;
    const body = match[1] ?? "";
    if (!body)
        return {};
    const result = {};
    for (const part of body.split(",")) {
        const field = /^\s*([a-zA-Z0-9_-]+|"(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(part);
        if (!field)
            return null;
        const key = unquoteTomlKey(field[1]);
        const parsed = JSON.parse(field[2]);
        if (typeof parsed !== "string" || Object.hasOwn(result, key))
            return null;
        result[key] = parsed;
    }
    return result;
}
function arraysEqual(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
function recordsEqual(left, right) {
    const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
    const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
    return leftEntries.length === rightEntries.length
        && leftEntries.every(([key, value], index) => (key === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]));
}
function reserveUniqueName(baseName, usedNames) {
    if (!usedNames.has(baseName)) {
        usedNames.add(baseName);
        return baseName;
    }
    for (let i = 2;; i += 1) {
        const candidate = `${baseName}-${i}`;
        if (!usedNames.has(candidate)) {
            usedNames.add(candidate);
            return candidate;
        }
    }
}
function normalizeMcpServer(value) {
    if (!value || typeof value.command !== "string" || value.command.length === 0)
        return null;
    if (value.args !== undefined && !Array.isArray(value.args))
        return null;
    if (value.args?.some((arg) => typeof arg !== "string"))
        return null;
    if (value.env !== undefined) {
        if (!value.env || typeof value.env !== "object" || Array.isArray(value.env))
            return null;
        if (Object.values(value.env).some((envValue) => typeof envValue !== "string"))
            return null;
    }
    return value;
}
function formatMcpServer(serverName, tweakDir, mcp, preserved = {}) {
    const lines = [
        `[mcp_servers.${formatTomlKey(serverName)}]`,
        `command = ${formatTomlString(resolveCommand(tweakDir, mcp.command))}`,
    ];
    if (mcp.args && mcp.args.length > 0) {
        lines.push(`args = ${formatTomlStringArray(mcp.args.map((arg) => resolveArg(tweakDir, arg)))}`);
    }
    if (mcp.env && Object.keys(mcp.env).length > 0) {
        lines.push(`env = ${formatTomlInlineTable(mcp.env)}`);
    }
    if (preserved.defaultToolsApprovalMode === "approve") {
        lines.push('default_tools_approval_mode = "approve"');
    }
    return lines.join("\n");
}
function resolveCommand(tweakDir, command) {
    if ((0, node_path_1.isAbsolute)(command) || !looksLikeRelativePath(command))
        return command;
    return (0, node_path_1.resolve)(tweakDir, command);
}
function resolveArg(tweakDir, arg) {
    if ((0, node_path_1.isAbsolute)(arg) || arg.startsWith("-"))
        return arg;
    const candidate = (0, node_path_1.resolve)(tweakDir, arg);
    return (0, node_fs_1.existsSync)(candidate) ? candidate : arg;
}
function looksLikeRelativePath(value) {
    return value.startsWith("./") || value.startsWith("../") || value.includes("/");
}
function formatTomlString(value) {
    return JSON.stringify(value);
}
function formatTomlStringArray(values) {
    return `[${values.map(formatTomlString).join(", ")}]`;
}
function formatTomlInlineTable(record) {
    return `{ ${Object.entries(record)
        .map(([key, value]) => `${formatTomlKey(key)} = ${formatTomlString(value)}`)
        .join(", ")} }`;
}
function formatTomlKey(key) {
    return /^[a-zA-Z0-9_-]+$/.test(key) ? key : formatTomlString(key);
}
function unquoteTomlKey(key) {
    if (key.startsWith("'") && key.endsWith("'"))
        return key.slice(1, -1);
    if (!key.startsWith('"') || !key.endsWith('"'))
        return key;
    try {
        return JSON.parse(key);
    }
    catch {
        return key;
    }
}
//# sourceMappingURL=mcp-sync.js.map