import { isAbsolute, normalize, resolve } from "node:path";
import {
  canonicalJson,
  canonicalSha256Fingerprint,
  isSha256Fingerprint,
  type Sha256Fingerprint,
} from "./account-history-adoption.js";

/**
 * The decoder is deliberately bound to the bundle that was inspected for the
 * v1 desktop state contract.  A JSON document which happens to parse is not
 * enough evidence that a newer desktop still uses these fields and shapes.
 */
export const PORTABLE_CONTINUITY_SCHEMA_VERSION = 1 as const;
export const PORTABLE_CONTINUITY_LEDGER_VERSION = 2 as const;
export const CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1 =
  "sha256:37d3a1db5d81134384885c067120f666d25a5a8c185df56eff85b7fde94de160" as const;
export const SUPPORTED_PORTABLE_DESKTOP_SCHEMA_FINGERPRINT_V1 =
  CURRENT_OFFICIAL_DESKTOP_BUNDLE_FINGERPRINT_V1;

const MAX_GLOBAL_STATE_BYTES = 8 * 1024 * 1024;
const MAX_PROJECTS = 500;
const MAX_ROOT_PATHS = 16;
const MAX_THREAD_IDS = 10_000;
const MAX_TWEAKS = 1_024;
const MAX_TEXT = 512;
const MAX_NATIVE_ID_BYTES = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const COLOR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const ICONIFY = /^[a-z0-9-]{1,40}:[a-z0-9-]{1,80}$/;
const EMOJI = /^\p{Extended_Pictographic}(?:\uFE0F)?$/u;
const APPEARANCE_THEME = new Set(["system", "light", "dark"]);
const PROJECT_COLOR_MODE = new Set(["auto", "manual"]);
const PROJECT_OVERLAY = new Set(["off", "subtle", "medium", "strong"]);
const PROJECT_SORT = new Set(["created-desc", "created-asc", "updated-desc", "updated-asc"]);

export type Sha256 = Sha256Fingerprint;
/** Endpoint keys are opaque SHA-256 handles; physical paths never appear in status output. */
export type EndpointKey = Sha256;

export interface NativeThreadInventoryV1 {
  version: 1;
  /** A deterministic fingerprint over the exact, sorted native-id set. */
  fingerprint: Sha256;
  /** IDs are native IDs and must be copied verbatim. */
  threadIds: readonly string[];
}

export interface PortableEndpointStateV1 {
  endpointKey: EndpointKey;
  bundleSchemaFingerprint: Sha256;
  /** Parsed .codex-global-state.json; never includes filesystem paths in results. */
  globalState: unknown;
  /** Parsed tweak-data/co.tweakers.projects/projects-v1.json, or null when absent. */
  projects: unknown | null;
  /** Parsed Tweakers config.json, or null when absent. */
  config: unknown | null;
}

export interface PortableProjectionOptionsV1 {
  nativeThreadInventory: NativeThreadInventoryV1;
  /** Only these bundled tweak IDs can contribute an enabled flag. */
  knownTweakIds: readonly string[];
}

export interface PortableFieldTargetV1 {
  artifact: "global-state" | "projects" | "config";
  field:
    | "local-project"
    | "workspace-label"
    | "selected-project"
    | "project-appearance"
    | "pinned-thread-ids"
    | "pinned-project-ids"
    | "sidebar-project-thread-order"
    | "sidebar-thread-metadata"
    | "thread-project-assignment"
    | "thread-workspace-root-hint"
    | "projectless-thread-ids"
    | "project-order"
    | "appearance-theme"
    | "appearance-light-chrome-theme"
    | "appearance-dark-chrome-theme"
    | "locale-override"
    | "projects-node"
    | "projects-relationship"
    | "projects-pinned-task-ids"
    | "tweak-enabled";
  /** Private identity retained only in the owner-only ledger/intent. */
  identity?: string;
}

export type PortableValueOrTombstone =
  | { kind: "value"; target: PortableFieldTargetV1; value: unknown }
  | { kind: "tombstone"; target: PortableFieldTargetV1 };

export interface PortableProjectionV1 {
  version: 1;
  endpointKey: EndpointKey;
  bundleSchemaFingerprint: Sha256;
  /** Each key is a non-reversible field handle suitable for redacted status. */
  fields: Readonly<Record<string, PortableValueOrTombstone>>;
  /** A field that cannot prove native ID membership is never selected for copy. */
  invalidFieldIds: readonly string[];
  excludedFieldIds: readonly string[];
  fingerprint: Sha256;
}

export interface PortableFieldLedgerEndpointV2 {
  baseline: PortableValueOrTombstone;
  appliedGeneration: number;
  artifactFingerprint: Sha256;
}

export interface PortableFieldLedgerV2 {
  canonical: PortableValueOrTombstone;
  canonicalGeneration: number;
  endpoints: Readonly<Record<EndpointKey, PortableFieldLedgerEndpointV2>>;
  conflict: null | {
    observedAt: string;
    source: PortableValueOrTombstone;
    destination: PortableValueOrTombstone;
  };
}

export interface PortableContinuityLedgerV2 {
  version: 2;
  kind: "portable-desktop-continuity-ledger";
  generation: number;
  fields: Readonly<Record<string, PortableFieldLedgerV2>>;
}

export interface PortableProjectionMergeInputV1 {
  source: PortableEndpointStateV1;
  destination: PortableEndpointStateV1;
  options: PortableProjectionOptionsV1;
  ledger: PortableContinuityLedgerV2 | null;
  observedAt: string;
}

export interface PortableFieldConflictV1 {
  fieldId: string;
  reason:
    | "dual-edit"
    | "unproven-native-id"
    | "dependent-project-conflict";
}

export interface PortableSelectedFieldV1 {
  fieldId: string;
  /** False means the selected canonical value already equals the destination. */
  writesDestination: boolean;
}

export interface PortableProjectionMergeResultV1 {
  version: 1;
  source: PortableProjectionV1;
  destination: PortableProjectionV1;
  candidate: PortableEndpointStateV1;
  candidateFingerprint: Sha256;
  intentFingerprint: Sha256;
  conflicts: readonly PortableFieldConflictV1[];
  selectedFields: readonly PortableSelectedFieldV1[];
  nextLedger: PortableContinuityLedgerV2;
}

export class PortableContinuityProjectionError extends Error {
  constructor(readonly code: string) {
    super(`Portable desktop continuity stopped safely: ${code}`);
    this.name = "PortableContinuityProjectionError";
  }
}

/** Deterministic native proof binding used by the offline catalog provider. */
export function nativeThreadInventoryFingerprint(threadIds: readonly string[]): Sha256 {
  const canonical = unique(threadIds.map((entry) => nativeThreadId(entry))).sort(compareCodeUnits);
  if (canonical.length !== threadIds.length) fail("native-thread-inventory-duplicate");
  return canonicalSha256Fingerprint({ version: 1, threadIds: canonical });
}

export function assertSupportedPortableDesktopSchema(fingerprint: Sha256): void {
  if (fingerprint !== SUPPORTED_PORTABLE_DESKTOP_SCHEMA_FINGERPRINT_V1) {
    fail("unsupported-schema");
  }
}

/**
 * Decode only registered portable fields. Unknown root and atom members are
 * intentionally absent from the projection and therefore remain endpoint-local.
 */
export function decodePortableEndpointProjection(
  endpoint: PortableEndpointStateV1,
  options: PortableProjectionOptionsV1,
): PortableProjectionV1 {
  assertEndpoint(endpoint);
  const inventory = assertNativeThreadInventory(options.nativeThreadInventory);
  const knownTweaks = assertKnownTweaks(options.knownTweakIds);
  const fields: Record<string, PortableValueOrTombstone> = {};
  const invalid = new Set<string>();
  const excluded = new Set<string>();
  const root = record(endpoint.globalState, "global-state-invalid");
  assertBoundedJson(root, "global-state-oversize");

  const localProjects = decodeLocalProjects(root["local-projects"], fields);
  decodeWorkspaceLabels(root["electron-workspace-root-labels"], localProjects, fields);

  const atoms = root["electron-persisted-atom-state"];
  const atomState = atoms === undefined ? {} : record(atoms, "atom-state-invalid");
  decodeAtomState(atomState, localProjects, inventory, fields, invalid, excluded);
  decodeProjects(endpoint.projects, inventory, fields, invalid, excluded);
  decodeTweakConfig(endpoint.config, knownTweaks, fields);

  const fingerprint = canonicalSha256Fingerprint({
    version: 1,
    endpointKey: endpoint.endpointKey,
    bundleSchemaFingerprint: endpoint.bundleSchemaFingerprint,
    fields,
    invalidFieldIds: [...invalid].sort(compareCodeUnits),
    excludedFieldIds: [...excluded].sort(compareCodeUnits),
  });
  return {
    version: 1,
    endpointKey: endpoint.endpointKey,
    bundleSchemaFingerprint: endpoint.bundleSchemaFingerprint,
    fields,
    invalidFieldIds: [...invalid].sort(compareCodeUnits),
    excludedFieldIds: [...excluded].sort(compareCodeUnits),
    fingerprint,
  };
}

/**
 * Tombstone-aware three-way merge. It never writes: callers receive a cloned
 * candidate and a private next-ledger which can be placed in an intent.
 */
export function mergePortableEndpointProjections(input: PortableProjectionMergeInputV1): PortableProjectionMergeResultV1 {
  if (!isRecord(input) || !isCanonicalTimestamp(input.observedAt)) fail("merge-input-invalid");
  if (input.source.endpointKey === input.destination.endpointKey) fail("endpoint-not-distinct");
  const source = decodePortableEndpointProjection(input.source, input.options);
  const destination = decodePortableEndpointProjection(input.destination, input.options);
  const prior = input.ledger === null ? emptyLedger() : parseLedger(input.ledger);
  const allFieldIds = new Set([
    ...Object.keys(source.fields),
    ...Object.keys(destination.fields),
    ...Object.keys(prior.fields),
  ]);
  const selections = new Map<string, PortableValueOrTombstone>();
  const conflicts: PortableFieldConflictV1[] = [];
  const nextFields: Record<string, PortableFieldLedgerV2> = cloneJson(prior.fields);

  for (const fieldId of [...allFieldIds].sort(compareCodeUnits)) {
    const priorField = prior.fields[fieldId];
    const sourceValue = source.fields[fieldId] ?? baselineTombstone(priorField, destination.fields[fieldId]);
    const destinationValue = destination.fields[fieldId] ?? baselineTombstone(priorField, source.fields[fieldId]);
    assertSameTarget(fieldId, sourceValue, destinationValue);

    if (source.invalidFieldIds.includes(fieldId) || destination.invalidFieldIds.includes(fieldId)) {
      conflicts.push({ fieldId, reason: "unproven-native-id" });
      nextFields[fieldId] = conflictLedger(priorField, sourceValue, destinationValue, input.observedAt);
      continue;
    }
    const selection = selectThreeWayValue(
      priorField,
      sourceValue,
      destinationValue,
      source.endpointKey,
      destination.endpointKey,
    );
    if (selection === null) {
      conflicts.push({ fieldId, reason: "dual-edit" });
      nextFields[fieldId] = conflictLedger(priorField, sourceValue, destinationValue, input.observedAt);
      continue;
    }
    // A brand-new all-tombstone field represents no portable state at either
    // endpoint, so it does not create a forever ledger entry.
    if (priorField === undefined && selection.kind === "tombstone"
      && sourceValue.kind === "tombstone" && destinationValue.kind === "tombstone") continue;
    selections.set(fieldId, selection);
    nextFields[fieldId] = selectedLedger(
      priorField,
      selection,
      source.endpointKey,
      sourceValue,
      source.fingerprint,
      destination.endpointKey,
      destinationValue,
      destination.fingerprint,
    );
  }

  // A hierarchy/order conflict makes individual node changes unsafe because
  // applying a subset could orphan a node or silently change its ownership.
  const structuralPrefixes = structuralConflictPrefixes(conflicts);
  if (structuralPrefixes.length > 0) {
    for (const [fieldId, selection] of [...selections]) {
      if (!structuralPrefixes.some((prefix) => fieldId.startsWith(prefix))) continue;
      selections.delete(fieldId);
      delete nextFields[fieldId];
      conflicts.push({ fieldId, reason: "dependent-project-conflict" });
      void selection;
    }
  }

  const candidate = renderPortableSelection(input.destination, selections);
  const candidateProjection = decodePortableEndpointProjection(candidate, input.options);
  assertProjectionInvariants(candidateProjection, input.options.nativeThreadInventory);
  const nextLedger: PortableContinuityLedgerV2 = {
    version: 2,
    kind: "portable-desktop-continuity-ledger",
    generation: prior.generation + (selections.size > 0 ? 1 : 0),
    fields: sortRecord(nextFields),
  };
  const selectedFields = [...selections.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([fieldId, value]) => ({
      fieldId,
      // A missing observed field is a tombstone, not the selected value. This
      // matters for a first one-sided addition during conservative bootstrap.
      writesDestination: !portableValueEqual(
        destination.fields[fieldId] ?? { kind: "tombstone", target: value.target },
        value,
      ),
    }));
  const candidateFingerprint = canonicalSha256Fingerprint({
    globalState: candidate.globalState,
    projects: candidate.projects,
    config: candidate.config,
  });
  const intentFingerprint = canonicalSha256Fingerprint({
    version: 1,
    sourceProjection: source.fingerprint,
    destinationProjection: destination.fingerprint,
    candidateFingerprint,
    sourceSchema: source.bundleSchemaFingerprint,
    destinationSchema: destination.bundleSchemaFingerprint,
    nativeThreadInventory: input.options.nativeThreadInventory.fingerprint,
    priorLedgerGeneration: prior.generation,
    selected: [...selections.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
    conflicts: conflicts.map((entry) => ({ fieldId: entry.fieldId, reason: entry.reason })),
  });
  return {
    version: 1,
    source,
    destination,
    candidate,
    candidateFingerprint,
    intentFingerprint,
    conflicts: uniqueConflicts(conflicts),
    selectedFields,
    nextLedger,
  };
}

/** Use this only on a candidate already decoded by the strict registry. */
export function renderPortableSelection(
  destination: PortableEndpointStateV1,
  selections: ReadonlyMap<string, PortableValueOrTombstone>,
): PortableEndpointStateV1 {
  const globalState = cloneRecord(record(destination.globalState, "destination-global-state-invalid"));
  let projects = destination.projects === null ? null : cloneJson(destination.projects);
  let config = destination.config === null ? null : cloneJson(destination.config);
  const ordered = [...selections.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  const relationships: PortableValueOrTombstone[] = [];
  for (const [, value] of ordered) {
    if (value.target.artifact === "global-state") applyGlobalValue(globalState, value);
    else if (value.target.artifact === "projects" && value.target.field === "projects-relationship") relationships.push(value);
    else if (value.target.artifact === "projects") projects = applyProjectsValue(projects, value);
    else if (value.target.artifact === "config") config = applyConfigValue(config, value);
  }
  for (const value of relationships) projects = applyProjectsValue(projects, value);
  return {
    endpointKey: destination.endpointKey,
    bundleSchemaFingerprint: destination.bundleSchemaFingerprint,
    globalState,
    projects,
    config,
  };
}

export function portableProjectionFingerprint(value: PortableProjectionV1): Sha256 {
  return canonicalSha256Fingerprint({
    version: value.version,
    endpointKey: value.endpointKey,
    bundleSchemaFingerprint: value.bundleSchemaFingerprint,
    fields: value.fields,
    invalidFieldIds: value.invalidFieldIds,
    excludedFieldIds: value.excludedFieldIds,
  });
}

function decodeLocalProjects(
  value: unknown,
  fields: Record<string, PortableValueOrTombstone>,
): Map<string, Record<string, unknown>> {
  if (value === undefined) return new Map();
  const raw = record(value, "local-projects-invalid");
  if (Object.keys(raw).length > MAX_PROJECTS) fail("local-projects-capacity-exceeded");
  const result = new Map<string, Record<string, unknown>>();
  for (const [id, rawProject] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    safeId(id, "local-project-id-invalid");
    const project = record(rawProject, "local-project-invalid");
    if (project.id !== id) fail("local-project-id-mismatch");
    const name = text(project.name, 160, "local-project-name-invalid");
    if (!Array.isArray(project.rootPaths) || project.rootPaths.length === 0 || project.rootPaths.length > MAX_ROOT_PATHS) {
      fail("local-project-roots-invalid");
    }
    const rootPaths = project.rootPaths.map((entry) => absolutePath(entry, "local-project-root-invalid"));
    if (new Set(rootPaths).size !== rootPaths.length) fail("local-project-roots-duplicate");
    const portable = { id, name, rootPaths };
    result.set(id, portable);
    setValue(fields, target("global-state", "local-project", id), portable);
  }
  return result;
}

function decodeWorkspaceLabels(
  value: unknown,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  fields: Record<string, PortableValueOrTombstone>,
): void {
  if (value === undefined) return;
  const raw = record(value, "workspace-labels-invalid");
  if (Object.keys(raw).length > MAX_PROJECTS * MAX_ROOT_PATHS) fail("workspace-labels-capacity-exceeded");
  const projectRoots = new Set<string>();
  for (const project of projects.values()) for (const root of project.rootPaths as string[]) projectRoots.add(root);
  for (const [path, label] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    const root = absolutePath(path, "workspace-label-path-invalid");
    if (!projectRoots.has(root)) continue;
    setValue(fields, target("global-state", "workspace-label", root), { path: root, label: text(label, 160, "workspace-label-invalid") });
  }
}

function decodeAtomState(
  atoms: Record<string, unknown>,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
  excluded: Set<string>,
): void {
  decodeScalarAtom(atoms, "selected-project", target("global-state", "selected-project"), fields, (value) => selectedProject(value, projects));
  decodeProjectAppearances(atoms["project-appearances"], projects, fields, excluded);
  decodeThreadListAtom(atoms, "pinned-thread-ids", target("global-state", "pinned-thread-ids"), inventory, fields, invalid);
  decodeProjectListAtom(atoms, "pinned-project-ids", target("global-state", "pinned-project-ids"), projects, fields);
  decodeSidebarOrders(atoms["sidebar-project-thread-orders"], projects, inventory, fields, invalid);
  decodeThreadMetadata(atoms["sidebar-thread-metadata"], inventory, fields, invalid, excluded);
  decodeThreadAssignments(atoms["thread-project-assignments"], projects, inventory, fields, invalid);
  decodeWorkspaceHints(atoms["thread-workspace-root-hints"], inventory, fields, invalid);
  decodeThreadListAtom(atoms, "projectless-thread-ids", target("global-state", "projectless-thread-ids"), inventory, fields, invalid);
  decodeProjectListAtom(atoms, "project-order", target("global-state", "project-order"), projects, fields);
  decodeScalarAtom(atoms, "appearanceTheme", target("global-state", "appearance-theme"), fields, appearanceTheme);
  decodeScalarAtom(atoms, "appearanceLightChromeTheme", target("global-state", "appearance-light-chrome-theme"), fields, chromeTheme);
  decodeScalarAtom(atoms, "appearanceDarkChromeTheme", target("global-state", "appearance-dark-chrome-theme"), fields, chromeTheme);
  decodeScalarAtom(atoms, "localeOverride", target("global-state", "locale-override"), fields, localeOverride);
}

function decodeScalarAtom(
  atoms: Record<string, unknown>,
  key: string,
  fieldTarget: PortableFieldTargetV1,
  fields: Record<string, PortableValueOrTombstone>,
  validator: (value: unknown) => unknown,
): void {
  if (atoms[key] === undefined) {
    setTombstone(fields, fieldTarget);
    return;
  }
  setValue(fields, fieldTarget, validator(atoms[key]));
}

function decodeProjectAppearances(
  value: unknown,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  fields: Record<string, PortableValueOrTombstone>,
  excluded: Set<string>,
): void {
  if (value === undefined) return;
  const raw = record(value, "project-appearances-invalid");
  if (Object.keys(raw).length > MAX_PROJECTS) fail("project-appearances-capacity-exceeded");
  for (const [id, appearance] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    safeId(id, "project-appearance-id-invalid");
    if (!projects.has(id)) fail("project-appearance-orphan");
    const decoded = safeAppearance(appearance);
    const fieldTarget = target("global-state", "project-appearance", id);
    if (decoded === null) {
      excluded.add(fieldId(fieldTarget));
      continue;
    }
    setValue(fields, fieldTarget, { projectId: id, appearance: decoded });
  }
}

function decodeThreadListAtom(
  atoms: Record<string, unknown>,
  key: "pinned-thread-ids" | "projectless-thread-ids",
  fieldTarget: PortableFieldTargetV1,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
): void {
  if (atoms[key] === undefined) {
    setTombstone(fields, fieldTarget);
    return;
  }
  const ids = nativeIdList(atoms[key], `${key}-invalid`);
  if (ids.some((id) => !inventory.has(id))) {
    setTombstone(fields, fieldTarget);
    invalid.add(fieldId(fieldTarget));
    return;
  }
  setValue(fields, fieldTarget, ids);
}

function decodeProjectListAtom(
  atoms: Record<string, unknown>,
  key: "pinned-project-ids" | "project-order",
  fieldTarget: PortableFieldTargetV1,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  fields: Record<string, PortableValueOrTombstone>,
): void {
  if (atoms[key] === undefined) {
    setTombstone(fields, fieldTarget);
    return;
  }
  if (!Array.isArray(atoms[key]) || atoms[key].length > MAX_PROJECTS) fail(`${key}-invalid`);
  const ids = atoms[key].map((entry) => safeId(entry, `${key}-id-invalid`));
  if (new Set(ids).size !== ids.length || ids.some((id) => !projects.has(id))) fail(`${key}-invalid`);
  setValue(fields, fieldTarget, ids);
}

function decodeSidebarOrders(
  value: unknown,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
): void {
  if (value === undefined) return;
  const raw = record(value, "sidebar-orders-invalid");
  if (Object.keys(raw).length > MAX_PROJECTS) fail("sidebar-orders-capacity-exceeded");
  for (const [projectId, order] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    safeId(projectId, "sidebar-order-project-invalid");
    if (!projects.has(projectId)) fail("sidebar-order-project-orphan");
    const entry = record(order, "sidebar-order-invalid");
    if (!Array.isArray(entry.threadIds) || entry.threadIds.length > MAX_THREAD_IDS) fail("sidebar-order-threads-invalid");
    const ids = nativeIdList(entry.threadIds, "sidebar-order-thread-invalid");
    const fieldTarget = target("global-state", "sidebar-project-thread-order", projectId);
    if (ids.some((id) => !inventory.has(id))) {
      setTombstone(fields, fieldTarget);
      invalid.add(fieldId(fieldTarget));
      continue;
    }
    const portable: Record<string, unknown> = { projectId, threadIds: ids };
    if (entry.sortKey !== undefined) portable.sortKey = text(entry.sortKey, 160, "sidebar-order-sort-key-invalid");
    if (Object.keys(entry).some((key) => key !== "threadIds" && key !== "sortKey")) fail("sidebar-order-extra-member");
    setValue(fields, fieldTarget, portable);
  }
}

function decodeThreadMetadata(
  value: unknown,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
  excluded: Set<string>,
): void {
  if (value === undefined) return;
  const raw = record(value, "sidebar-thread-metadata-invalid");
  if (Object.keys(raw).length > MAX_THREAD_IDS) fail("sidebar-thread-metadata-capacity-exceeded");
  for (const [threadId, metadata] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    nativeThreadId(threadId);
    const fieldTarget = target("global-state", "sidebar-thread-metadata", threadId);
    if (!inventory.has(threadId)) {
      setTombstone(fields, fieldTarget);
      invalid.add(fieldId(fieldTarget));
      continue;
    }
    const decoded = safeThreadMetadata(metadata);
    if (decoded === null) {
      excluded.add(fieldId(fieldTarget));
      continue;
    }
    setValue(fields, fieldTarget, { threadId, metadata: decoded });
  }
}

function decodeThreadAssignments(
  value: unknown,
  projects: ReadonlyMap<string, Record<string, unknown>>,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
): void {
  if (value === undefined) return;
  const raw = record(value, "thread-assignments-invalid");
  if (Object.keys(raw).length > MAX_THREAD_IDS) fail("thread-assignments-capacity-exceeded");
  for (const [threadId, assignment] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    nativeThreadId(threadId);
    const fieldTarget = target("global-state", "thread-project-assignment", threadId);
    if (!inventory.has(threadId)) {
      setTombstone(fields, fieldTarget);
      invalid.add(fieldId(fieldTarget));
      continue;
    }
    const rawAssignment = record(assignment, "thread-assignment-invalid");
    let portable: Record<string, unknown>;
    if (rawAssignment.projectKind === "local") {
      const projectId = safeId(rawAssignment.projectId, "thread-assignment-project-invalid");
      if (!projects.has(projectId) || Object.keys(rawAssignment).some((key) => key !== "projectKind" && key !== "projectId")) {
        fail("thread-assignment-project-invalid");
      }
      portable = { projectKind: "local", projectId };
    } else if (rawAssignment.projectKind === "projectless" && Object.keys(rawAssignment).length === 1) {
      portable = { projectKind: "projectless" };
    } else {
      fail("thread-assignment-invalid");
    }
    setValue(fields, fieldTarget, { threadId, assignment: portable });
  }
}

function decodeWorkspaceHints(
  value: unknown,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
): void {
  if (value === undefined) return;
  const raw = record(value, "workspace-hints-invalid");
  if (Object.keys(raw).length > MAX_THREAD_IDS) fail("workspace-hints-capacity-exceeded");
  for (const [threadId, root] of Object.entries(raw).sort(([left], [right]) => compareCodeUnits(left, right))) {
    nativeThreadId(threadId);
    const fieldTarget = target("global-state", "thread-workspace-root-hint", threadId);
    if (!inventory.has(threadId)) {
      setTombstone(fields, fieldTarget);
      invalid.add(fieldId(fieldTarget));
      continue;
    }
    setValue(fields, fieldTarget, { threadId, root: absolutePath(root, "workspace-hint-invalid") });
  }
}

function decodeProjects(
  value: unknown | null,
  inventory: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
  invalid: Set<string>,
  excluded: Set<string>,
): void {
  const relationshipTarget = target("projects", "projects-relationship");
  if (value === null || value === undefined) {
    setTombstone(fields, relationshipTarget);
    return;
  }
  const state = record(value, "projects-state-invalid");
  if (state.schemaVersion !== 1 || !Array.isArray(state.nodes) || state.nodes.length > MAX_PROJECTS) fail("projects-state-invalid");
  const nodes = state.nodes.map((entry) => decodeProjectNode(entry, inventory, invalid, excluded));
  validateProjectNodes(nodes);
  for (const node of nodes) {
    const { parentId: _parentId, pinnedTaskIds: _pinnedTaskIds, ...portableNode } = node;
    setValue(fields, target("projects", "projects-node", node.id), portableNode);
    if (node.type === "project" && node.pinnedTaskIds !== undefined) {
      const pinTarget = target("projects", "projects-pinned-task-ids", node.id);
      if (node.pinnedTaskIds.some((id) => !inventory.has(id))) {
        setTombstone(fields, pinTarget);
        invalid.add(fieldId(pinTarget));
      }
      else setValue(fields, pinTarget, { projectId: node.id, threadIds: node.pinnedTaskIds });
    }
  }
  setValue(fields, relationshipTarget, nodes.map((node) => ({ id: node.id, parentId: node.parentId })));
}

function decodeProjectNode(
  value: unknown,
  inventory: ReadonlySet<string>,
  invalid: Set<string>,
  excluded: Set<string>,
): Record<string, unknown> & { id: string; type: "group" | "project"; parentId: string | null; pinnedTaskIds?: string[] } {
  const raw = record(value, "projects-node-invalid");
  const id = safeId(raw.id, "projects-node-id-invalid");
  const type = raw.type === "group" || raw.type === "project" ? raw.type : fail("projects-node-type-invalid");
  const parentId = raw.parentId === null || raw.parentId === undefined ? null : safeId(raw.parentId, "projects-node-parent-invalid");
  const node: Record<string, unknown> & { id: string; type: "group" | "project"; parentId: string | null; pinnedTaskIds?: string[] } = {
    id,
    type,
    parentId,
    name: text(raw.name, 160, "projects-node-name-invalid"),
    icon: projectIcon(raw.icon),
    color: projectColor(raw.color),
  };
  if (type === "project") {
    if (raw.colorMode !== undefined) {
      if (typeof raw.colorMode !== "string" || !PROJECT_COLOR_MODE.has(raw.colorMode)) fail("projects-node-color-mode-invalid");
      node.colorMode = raw.colorMode;
    }
    if (raw.overlayIntensity !== undefined) {
      if (typeof raw.overlayIntensity !== "string" || !PROJECT_OVERLAY.has(raw.overlayIntensity)) fail("projects-node-overlay-invalid");
      node.overlayIntensity = raw.overlayIntensity;
    }
    if (raw.taskSort !== undefined) {
      if (typeof raw.taskSort !== "string" || !PROJECT_SORT.has(raw.taskSort)) fail("projects-node-sort-invalid");
      node.taskSort = raw.taskSort;
    }
    if (raw.projectPath !== undefined) node.projectPath = absolutePath(raw.projectPath, "projects-node-path-invalid");
    if (raw.appearance !== undefined) {
      const appearance = safeAppearance(raw.appearance);
      if (appearance === null) excluded.add(fieldId(target("projects", "projects-node", id)));
      else node.appearance = appearance;
    }
    if (raw.pinnedTaskIds !== undefined) {
      const ids = nativeIdList(raw.pinnedTaskIds, "projects-node-pins-invalid");
      node.pinnedTaskIds = ids;
      if (ids.some((threadId) => !inventory.has(threadId))) invalid.add(fieldId(target("projects", "projects-pinned-task-ids", id)));
    }
  }
  return node;
}

function decodeTweakConfig(
  value: unknown | null,
  knownTweakIds: ReadonlySet<string>,
  fields: Record<string, PortableValueOrTombstone>,
): void {
  if (value === null || value === undefined) {
    for (const id of knownTweakIds) setTombstone(fields, target("config", "tweak-enabled", id));
    return;
  }
  const config = record(value, "config-invalid");
  if (config.tweaks === undefined) {
    for (const id of knownTweakIds) setTombstone(fields, target("config", "tweak-enabled", id));
    return;
  }
  const tweaks = record(config.tweaks, "config-tweaks-invalid");
  if (Object.keys(tweaks).length > MAX_TWEAKS) fail("config-tweaks-capacity-exceeded");
  for (const id of knownTweakIds) {
    const raw = tweaks[id];
    const fieldTarget = target("config", "tweak-enabled", id);
    if (raw === undefined) {
      setTombstone(fields, fieldTarget);
      continue;
    }
    const entry = record(raw, "config-tweak-invalid");
    if (entry.enabled === undefined) {
      // Other fields remain endpoint-local. Absence of the one registered
      // boolean is the portable tombstone even when such local fields exist.
      setTombstone(fields, fieldTarget);
      continue;
    }
    if (typeof entry.enabled !== "boolean") fail("config-tweak-enabled-invalid");
    setValue(fields, fieldTarget, { tweakId: id, enabled: entry.enabled });
  }
}

function selectThreeWayValue(
  prior: PortableFieldLedgerV2 | undefined,
  source: PortableValueOrTombstone,
  destination: PortableValueOrTombstone,
  sourceEndpointKey: EndpointKey,
  destinationEndpointKey: EndpointKey,
): PortableValueOrTombstone | null {
  if (prior === undefined) {
    if (portableValueEqual(source, destination)) return source;
    if (source.kind === "tombstone") return destination;
    if (destination.kind === "tombstone") return source;
    return null;
  }
  const sourceBaseline = prior.endpoints[sourceEndpointKey]?.baseline ?? prior.canonical;
  const destinationBaseline = prior.endpoints[destinationEndpointKey]?.baseline ?? prior.canonical;
  const sourceChanged = !portableValueEqual(source, sourceBaseline);
  const destinationChanged = !portableValueEqual(destination, destinationBaseline);
  if (sourceChanged && destinationChanged) return portableValueEqual(source, destination) ? source : null;
  if (sourceChanged) return source;
  if (destinationChanged) return destination;
  return prior.canonical;
}

function selectedLedger(
  prior: PortableFieldLedgerV2 | undefined,
  selected: PortableValueOrTombstone,
  sourceEndpointKey: EndpointKey,
  sourceObserved: PortableValueOrTombstone,
  sourceFingerprint: Sha256,
  destinationEndpointKey: EndpointKey,
  destinationObserved: PortableValueOrTombstone,
  destinationFingerprint: Sha256,
): PortableFieldLedgerV2 {
  const generation = (prior?.canonicalGeneration ?? 0) + 1;
  const endpoints = cloneJson(prior?.endpoints ?? {}) as Record<EndpointKey, PortableFieldLedgerEndpointV2>;
  endpoints[sourceEndpointKey] = {
    baseline: sourceObserved,
    appliedGeneration: generation,
    artifactFingerprint: sourceFingerprint,
  };
  endpoints[destinationEndpointKey] = {
    baseline: selected,
    appliedGeneration: generation,
    artifactFingerprint: destinationFingerprint,
  };
  void destinationObserved;
  return { canonical: selected, canonicalGeneration: generation, endpoints: sortRecord(endpoints), conflict: null };
}

function conflictLedger(
  prior: PortableFieldLedgerV2 | undefined,
  source: PortableValueOrTombstone,
  destination: PortableValueOrTombstone,
  observedAt: string,
): PortableFieldLedgerV2 {
  return {
    canonical: prior?.canonical ?? source,
    canonicalGeneration: prior?.canonicalGeneration ?? 0,
    endpoints: prior?.endpoints ?? {},
    conflict: { observedAt, source, destination },
  };
}

function structuralConflictPrefixes(conflicts: readonly PortableFieldConflictV1[]): string[] {
  const prefixes = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.reason !== "dual-edit" && conflict.reason !== "unproven-native-id") continue;
    if (conflict.fieldId.startsWith("projects.projects-node.") || conflict.fieldId === fieldId(target("projects", "projects-relationship"))) {
      prefixes.add("projects.");
    }
    if (conflict.fieldId.startsWith("global-state.local-project.")) {
      prefixes.add("global-state.workspace-label.");
      prefixes.add("global-state.selected-project");
      prefixes.add("global-state.project-appearance.");
      prefixes.add("global-state.pinned-project-ids");
      prefixes.add("global-state.sidebar-project-thread-order.");
      prefixes.add("global-state.thread-project-assignment.");
      prefixes.add("global-state.project-order");
    }
  }
  return [...prefixes];
}

function applyGlobalValue(root: Record<string, unknown>, value: PortableValueOrTombstone): void {
  const { field, identity } = value.target;
  if (field === "local-project") {
    const id = requiredIdentity(identity, "render-local-project-id-invalid");
    const projects = ensureRecordMember(root, "local-projects");
    if (value.kind === "tombstone") delete projects[id];
    else projects[id] = mergeKnownRecord(projects[id], record(value.value, "render-local-project-invalid"));
    return;
  }
  if (field === "workspace-label") {
    const path = requiredIdentity(identity, "render-workspace-label-path-invalid");
    const labels = ensureRecordMember(root, "electron-workspace-root-labels");
    if (value.kind === "tombstone") delete labels[path];
    else labels[path] = record(value.value, "render-workspace-label-invalid").label;
    return;
  }
  const atoms = ensureRecordMember(root, "electron-persisted-atom-state");
  const atomKey = atomKeyFor(field);
  if (atomKey === null) fail("render-global-field-invalid");
  if (field === "project-appearance" || field === "sidebar-project-thread-order" || field === "sidebar-thread-metadata"
    || field === "thread-project-assignment" || field === "thread-workspace-root-hint") {
    const id = requiredIdentity(identity, "render-global-map-id-invalid");
    const mapKey = atomKey;
    const map = ensureRecordMember(atoms, mapKey);
    if (value.kind === "tombstone") delete map[id];
    else map[id] = mapValueForGlobalField(field, value.value);
    return;
  }
  if (value.kind === "tombstone") delete atoms[atomKey];
  else atoms[atomKey] = cloneJson(value.value);
}

function applyProjectsValue(projects: unknown | null, value: PortableValueOrTombstone): unknown {
  const state = projects === null ? { schemaVersion: 1, nodes: [] as unknown[] } : record(projects, "render-projects-invalid");
  if (state.schemaVersion !== 1 || !Array.isArray(state.nodes)) fail("render-projects-invalid");
  if (value.target.field === "projects-node") {
    const id = requiredIdentity(value.target.identity, "render-project-node-id-invalid");
    const index = state.nodes.findIndex((entry) => isRecord(entry) && entry.id === id);
    if (value.kind === "tombstone") {
      if (index >= 0) state.nodes.splice(index, 1);
      return state;
    }
    const node = record(value.value, "render-project-node-invalid");
    if (index < 0) state.nodes.push(cloneJson(node));
    else state.nodes[index] = mergeKnownRecord(state.nodes[index], node);
    return state;
  }
  if (value.target.field === "projects-pinned-task-ids") {
    const id = requiredIdentity(value.target.identity, "render-project-pin-id-invalid");
    const index = state.nodes.findIndex((entry) => isRecord(entry) && entry.id === id);
    // A node tombstone is rendered before its pin tombstone. Once the node is
    // gone there is no pin surface left to clear, so this is already applied.
    if (index < 0 && value.kind === "tombstone") return state;
    if (index < 0) fail("render-project-pin-orphan");
    const node = record(state.nodes[index], "render-project-pin-node-invalid");
    if (value.kind === "tombstone") delete node.pinnedTaskIds;
    else node.pinnedTaskIds = cloneJson(record(value.value, "render-project-pin-invalid").threadIds);
    state.nodes[index] = node;
    return state;
  }
  if (value.target.field === "projects-relationship") {
    if (value.kind === "tombstone") return state;
    const relationships = value.value;
    if (!Array.isArray(relationships)) fail("render-project-relationships-invalid");
    const order = new Map<string, { parentId: string | null; index: number }>();
    relationships.forEach((entry, index) => {
      const recordEntry = record(entry, "render-project-relationship-invalid");
      const id = safeId(recordEntry.id, "render-project-relationship-id-invalid");
      const parentId = recordEntry.parentId === null ? null : safeId(recordEntry.parentId, "render-project-relationship-parent-invalid");
      if (order.has(id)) fail("render-project-relationship-duplicate");
      order.set(id, { parentId, index });
    });
    const known: unknown[] = [];
    const unknown: unknown[] = [];
    for (const entry of state.nodes) {
      if (!isRecord(entry) || typeof entry.id !== "string" || !order.has(entry.id)) {
        unknown.push(entry);
        continue;
      }
      const relation = order.get(entry.id)!;
      known.push({ ...entry, parentId: relation.parentId, __portableOrder: relation.index });
    }
    known.sort((left, right) => (record(left, "render-project-order-invalid").__portableOrder as number)
      - (record(right, "render-project-order-invalid").__portableOrder as number));
    state.nodes = [...known.map((entry) => {
      const node = record(entry, "render-project-order-invalid");
      delete node.__portableOrder;
      return node;
    }), ...unknown];
    return state;
  }
  fail("render-project-field-invalid");
}

function applyConfigValue(config: unknown | null, value: PortableValueOrTombstone): unknown {
  if (value.target.field !== "tweak-enabled") fail("render-config-field-invalid");
  const state = config === null ? {} : record(config, "render-config-invalid");
  const id = requiredIdentity(value.target.identity, "render-config-id-invalid");
  const tweaks = ensureRecordMember(state, "tweaks");
  const existing = tweaks[id] === undefined ? {} : record(tweaks[id], "render-config-tweak-invalid");
  if (value.kind === "tombstone") delete existing.enabled;
  else existing.enabled = record(value.value, "render-config-enabled-invalid").enabled;
  tweaks[id] = existing;
  return state;
}

function assertProjectionInvariants(projection: PortableProjectionV1, inventory: NativeThreadInventoryV1): void {
  if (projection.invalidFieldIds.length > 0) fail("candidate-native-id-unproven");
  const fields = projection.fields;
  const projects = new Map<string, Record<string, unknown>>();
  const projectRoots = new Set<string>();
  for (const value of Object.values(fields)) {
    if (value.kind !== "value" || value.target.field !== "local-project") continue;
    const project = record(value.value, "candidate-local-project-invalid");
    const id = safeId(project.id, "candidate-local-project-id-invalid");
    projects.set(id, project);
    for (const root of project.rootPaths as unknown[]) projectRoots.add(absolutePath(root, "candidate-local-project-root-invalid"));
  }
  for (const value of Object.values(fields)) {
    if (value.kind !== "value") continue;
    const { field } = value.target;
    if (field === "selected-project") selectedProject(value.value, projects);
    if (field === "pinned-project-ids" || field === "project-order") {
      const ids = value.value;
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== "string" || !projects.has(id))) {
        fail("candidate-project-order-invalid");
      }
    }
    if (field === "workspace-label") {
      const label = record(value.value, "candidate-workspace-label-invalid");
      if (!projectRoots.has(absolutePath(label.path, "candidate-workspace-label-path-invalid"))) fail("candidate-workspace-label-orphan");
    }
    if (field === "project-appearance") {
      const appearance = record(value.value, "candidate-project-appearance-invalid");
      if (typeof appearance.projectId !== "string" || !projects.has(appearance.projectId)) fail("candidate-project-appearance-orphan");
    }
    if (field === "sidebar-project-thread-order") {
      const order = record(value.value, "candidate-sidebar-order-invalid");
      if (typeof order.projectId !== "string" || !projects.has(order.projectId)) fail("candidate-sidebar-order-orphan");
      assertAllNativeIds(order.threadIds, inventory, "candidate-sidebar-thread-unproven");
    }
    if (field === "thread-project-assignment") {
      const assignment = record(value.value, "candidate-thread-assignment-invalid");
      assertNativeId(assignment.threadId, inventory, "candidate-assignment-thread-unproven");
      const targetAssignment = record(assignment.assignment, "candidate-thread-assignment-invalid");
      if (targetAssignment.projectKind === "local") {
        if (typeof targetAssignment.projectId !== "string" || !projects.has(targetAssignment.projectId)) fail("candidate-assignment-project-orphan");
      } else if (targetAssignment.projectKind !== "projectless") fail("candidate-thread-assignment-invalid");
    }
    if (field === "thread-workspace-root-hint") {
      const hint = record(value.value, "candidate-workspace-hint-invalid");
      assertNativeId(hint.threadId, inventory, "candidate-workspace-thread-unproven");
      absolutePath(hint.root, "candidate-workspace-hint-invalid");
    }
    if (field === "pinned-thread-ids" || field === "projectless-thread-ids") {
      assertAllNativeIds(value.value, inventory, "candidate-thread-list-unproven");
    }
    if (field === "projects-pinned-task-ids") {
      const pins = record(value.value, "candidate-project-pins-invalid");
      assertAllNativeIds(pins.threadIds, inventory, "candidate-project-pin-unproven");
    }
  }
}

function assertEndpoint(value: PortableEndpointStateV1): void {
  if (!isRecord(value) || !isSha256Fingerprint(value.endpointKey) || !isSha256Fingerprint(value.bundleSchemaFingerprint)) {
    fail("endpoint-invalid");
  }
  assertSupportedPortableDesktopSchema(value.bundleSchemaFingerprint);
}

function assertNativeThreadInventory(value: NativeThreadInventoryV1): ReadonlySet<string> {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.threadIds) || !isSha256Fingerprint(value.fingerprint)) {
    fail("native-thread-inventory-invalid");
  }
  const ids = value.threadIds.map((entry) => nativeThreadId(entry));
  if (new Set(ids).size !== ids.length || nativeThreadInventoryFingerprint(ids) !== value.fingerprint) fail("native-thread-inventory-invalid");
  return new Set(ids);
}

function assertKnownTweaks(value: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(value) || value.length > MAX_TWEAKS) fail("known-tweak-ids-invalid");
  const ids = value.map((entry) => safeId(entry, "known-tweak-id-invalid"));
  if (new Set(ids).size !== ids.length) fail("known-tweak-ids-duplicate");
  return new Set(ids);
}

function parseLedger(value: PortableContinuityLedgerV2): PortableContinuityLedgerV2 {
  if (!isRecord(value) || value.version !== 2 || value.kind !== "portable-desktop-continuity-ledger"
    || !Number.isSafeInteger(value.generation) || value.generation < 0 || !isRecord(value.fields)) fail("ledger-invalid");
  const fields: Record<string, PortableFieldLedgerV2> = {};
  for (const [fieldIdValue, raw] of Object.entries(value.fields)) {
    const fieldName = fieldIdValue;
    if (!safeFieldId(fieldName) || !isRecord(raw)) fail("ledger-field-invalid");
    const canonical = parsePortableValue(raw.canonical);
    if (!Number.isSafeInteger(raw.canonicalGeneration) || raw.canonicalGeneration < 0 || !isRecord(raw.endpoints)) fail("ledger-field-invalid");
    const endpoints: Record<EndpointKey, PortableFieldLedgerEndpointV2> = {};
    for (const [endpointKey, entry] of Object.entries(raw.endpoints)) {
      if (!isSha256Fingerprint(endpointKey) || !isRecord(entry) || !isSha256Fingerprint(entry.artifactFingerprint)
        || !Number.isSafeInteger(entry.appliedGeneration) || entry.appliedGeneration < 0) fail("ledger-endpoint-invalid");
      const baseline = parsePortableValue(entry.baseline);
      assertSameTarget(fieldName, canonical, baseline);
      endpoints[endpointKey as EndpointKey] = { baseline, appliedGeneration: entry.appliedGeneration, artifactFingerprint: entry.artifactFingerprint };
    }
    let conflict: PortableFieldLedgerV2["conflict"] = null;
    if (raw.conflict !== null) {
      if (!isRecord(raw.conflict) || !isCanonicalTimestamp(raw.conflict.observedAt)) fail("ledger-conflict-invalid");
      const source = parsePortableValue(raw.conflict.source);
      const destination = parsePortableValue(raw.conflict.destination);
      assertSameTarget(fieldName, source, destination);
      conflict = { observedAt: raw.conflict.observedAt, source, destination };
    }
    fields[fieldName] = { canonical, canonicalGeneration: raw.canonicalGeneration, endpoints: sortRecord(endpoints), conflict };
  }
  return { version: 2, kind: "portable-desktop-continuity-ledger", generation: value.generation, fields: sortRecord(fields) };
}

function parsePortableValue(value: unknown): PortableValueOrTombstone {
  if (!isRecord(value) || (value.kind !== "value" && value.kind !== "tombstone")) fail("ledger-value-invalid");
  const targetValue = parseTarget(value.target);
  if (value.kind === "tombstone") {
    if (Object.keys(value).some((key) => key !== "kind" && key !== "target")) fail("ledger-tombstone-invalid");
    return { kind: "tombstone", target: targetValue };
  }
  if (!Object.hasOwn(value, "value") || Object.keys(value).some((key) => key !== "kind" && key !== "target" && key !== "value")) {
    fail("ledger-value-invalid");
  }
  assertBoundedJson(value.value, "ledger-value-oversize");
  return { kind: "value", target: targetValue, value: cloneJson(value.value) };
}

function parseTarget(value: unknown): PortableFieldTargetV1 {
  if (!isRecord(value) || (value.artifact !== "global-state" && value.artifact !== "projects" && value.artifact !== "config")
    || typeof value.field !== "string" || (value.identity !== undefined && typeof value.identity !== "string")) fail("ledger-target-invalid");
  const fields: readonly PortableFieldTargetV1["field"][] = [
    "local-project", "workspace-label", "selected-project", "project-appearance", "pinned-thread-ids", "pinned-project-ids",
    "sidebar-project-thread-order", "sidebar-thread-metadata", "thread-project-assignment", "thread-workspace-root-hint",
    "projectless-thread-ids", "project-order", "appearance-theme", "appearance-light-chrome-theme", "appearance-dark-chrome-theme",
    "locale-override", "projects-node", "projects-relationship", "projects-pinned-task-ids", "tweak-enabled",
  ];
  if (!fields.includes(value.field as PortableFieldTargetV1["field"])) fail("ledger-target-invalid");
  return { artifact: value.artifact, field: value.field as PortableFieldTargetV1["field"], ...(value.identity === undefined ? {} : { identity: value.identity }) };
}

function emptyLedger(): PortableContinuityLedgerV2 {
  return { version: 2, kind: "portable-desktop-continuity-ledger", generation: 0, fields: {} };
}

function target(artifact: PortableFieldTargetV1["artifact"], field: PortableFieldTargetV1["field"], identity?: string): PortableFieldTargetV1 {
  return identity === undefined ? { artifact, field } : { artifact, field, identity };
}

function fieldId(targetValue: PortableFieldTargetV1): string {
  const suffix = targetValue.identity === undefined ? "" : `.${canonicalSha256Fingerprint(targetValue.identity).slice(7, 23)}`;
  return `${targetValue.artifact}.${targetValue.field}${suffix}`;
}

function setValue(fields: Record<string, PortableValueOrTombstone>, fieldTarget: PortableFieldTargetV1, value: unknown): void {
  const id = fieldId(fieldTarget);
  if (fields[id] !== undefined) fail("projection-field-duplicate");
  assertBoundedJson(value, "projection-value-oversize");
  fields[id] = { kind: "value", target: fieldTarget, value: cloneJson(value) };
}

function setTombstone(fields: Record<string, PortableValueOrTombstone>, fieldTarget: PortableFieldTargetV1): void {
  const id = fieldId(fieldTarget);
  if (fields[id] !== undefined) fail("projection-field-duplicate");
  fields[id] = { kind: "tombstone", target: fieldTarget };
}

function baselineTombstone(prior: PortableFieldLedgerV2 | undefined, fallback: PortableValueOrTombstone | undefined): PortableValueOrTombstone {
  if (prior !== undefined) return { kind: "tombstone", target: prior.canonical.target };
  if (fallback !== undefined) return { kind: "tombstone", target: fallback.target };
  fail("projection-field-target-missing");
}

function assertSameTarget(fieldIdValue: string, left: PortableValueOrTombstone, right: PortableValueOrTombstone): void {
  if (canonicalJson(left.target) !== canonicalJson(right.target)) fail(`projection-target-mismatch-${fieldIdValue}`);
}

function portableValueEqual(left: PortableValueOrTombstone, right: PortableValueOrTombstone): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function mapValueForGlobalField(field: PortableFieldTargetV1["field"], value: unknown): unknown {
  const raw = record(value, "render-global-map-value-invalid");
  if (field === "project-appearance") return cloneJson(raw.appearance);
  if (field === "sidebar-project-thread-order") {
    const { projectId: _projectId, ...order } = raw;
    return cloneJson(order);
  }
  if (field === "sidebar-thread-metadata") return cloneJson(raw.metadata);
  if (field === "thread-project-assignment") return cloneJson(raw.assignment);
  if (field === "thread-workspace-root-hint") return raw.root;
  fail("render-global-map-value-invalid");
}

function atomKeyFor(field: PortableFieldTargetV1["field"]): string | null {
  const keys: Partial<Record<PortableFieldTargetV1["field"], string>> = {
    "selected-project": "selected-project",
    "project-appearance": "project-appearances",
    "pinned-thread-ids": "pinned-thread-ids",
    "pinned-project-ids": "pinned-project-ids",
    "sidebar-project-thread-order": "sidebar-project-thread-orders",
    "sidebar-thread-metadata": "sidebar-thread-metadata",
    "thread-project-assignment": "thread-project-assignments",
    "thread-workspace-root-hint": "thread-workspace-root-hints",
    "projectless-thread-ids": "projectless-thread-ids",
    "project-order": "project-order",
    "appearance-theme": "appearanceTheme",
    "appearance-light-chrome-theme": "appearanceLightChromeTheme",
    "appearance-dark-chrome-theme": "appearanceDarkChromeTheme",
    "locale-override": "localeOverride",
  };
  return keys[field] ?? null;
}

function ensureRecordMember(root: Record<string, unknown>, key: string): Record<string, unknown> {
  if (root[key] === undefined) {
    const result: Record<string, unknown> = {};
    root[key] = result;
    return result;
  }
  return record(root[key], "destination-known-field-invalid");
}

function mergeKnownRecord(existing: unknown, portable: Record<string, unknown>): Record<string, unknown> {
  if (existing === undefined) return cloneJson(portable);
  return { ...record(existing, "destination-known-object-invalid"), ...cloneJson(portable) };
}

function selectedProject(value: unknown, projects: ReadonlyMap<string, Record<string, unknown>>): Record<string, unknown> {
  const raw = record(value, "selected-project-invalid");
  if (raw.type === "projectless" && Object.keys(raw).length === 1) return { type: "projectless" };
  if (raw.type !== "local" || Object.keys(raw).some((key) => key !== "type" && key !== "projectId")) fail("selected-project-invalid");
  const projectId = safeId(raw.projectId, "selected-project-invalid");
  if (!projects.has(projectId)) fail("selected-project-orphan");
  return { type: "local", projectId };
}

function appearanceTheme(value: unknown): string {
  if (typeof value !== "string" || !APPEARANCE_THEME.has(value)) fail("appearance-theme-invalid");
  return value;
}

function chromeTheme(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === "string" && (value === "default" || COLOR.test(value))) return value.toLowerCase();
  fail("chrome-theme-invalid");
}

function localeOverride(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !LOCALE.test(value)) fail("locale-override-invalid");
  return value;
}

function safeAppearance(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["theme", "color", "colorMode", "overlayIntensity"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const result: Record<string, unknown> = {};
  if (value.theme !== undefined) result.theme = appearanceTheme(value.theme);
  if (value.color !== undefined) result.color = projectColor(value.color);
  if (value.colorMode !== undefined) {
    if (typeof value.colorMode !== "string" || !PROJECT_COLOR_MODE.has(value.colorMode)) return null;
    result.colorMode = value.colorMode;
  }
  if (value.overlayIntensity !== undefined) {
    if (typeof value.overlayIntensity !== "string" || !PROJECT_OVERLAY.has(value.overlayIntensity)) return null;
    result.overlayIntensity = value.overlayIntensity;
  }
  return result;
}

function safeThreadMetadata(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const allowed = new Set(["title", "createdAt", "updatedAt", "isArchived"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const result: Record<string, unknown> = {};
  if (value.title !== undefined) result.title = text(value.title, 512, "thread-metadata-title-invalid");
  if (value.createdAt !== undefined) result.createdAt = timestampNumber(value.createdAt, "thread-metadata-created-at-invalid");
  if (value.updatedAt !== undefined) result.updatedAt = timestampNumber(value.updatedAt, "thread-metadata-updated-at-invalid");
  if (value.isArchived !== undefined) {
    if (typeof value.isArchived !== "boolean") return null;
    result.isArchived = value.isArchived;
  }
  return result;
}

function projectIcon(value: unknown): Record<string, string> {
  const raw = record(value, "projects-node-icon-invalid");
  if (raw.kind === "emoji" && typeof raw.value === "string" && EMOJI.test(raw.value) && Object.keys(raw).length === 2) {
    return { kind: "emoji", value: raw.value };
  }
  if (raw.kind === "iconify" && typeof raw.value === "string" && ICONIFY.test(raw.value) && Object.keys(raw).length === 2) {
    return { kind: "iconify", value: raw.value };
  }
  fail("projects-node-icon-invalid");
}

function projectColor(value: unknown): string {
  if (typeof value !== "string" || !COLOR.test(value)) fail("projects-node-color-invalid");
  return value.toLowerCase();
}

function validateProjectNodes(nodes: readonly (Record<string, unknown> & { id: string; type: "group" | "project"; parentId: string | null })[]): void {
  const byId = new Map<string, Record<string, unknown> & { id: string; type: "group" | "project"; parentId: string | null }>();
  for (const node of nodes) {
    if (byId.has(node.id)) fail("projects-node-duplicate");
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    let current = node;
    const seen = new Set([node.id]);
    let depth = 0;
    while (current.parentId !== null) {
      if (seen.has(current.parentId)) fail("projects-node-cycle");
      seen.add(current.parentId);
      const parent = byId.get(current.parentId);
      if (!parent || parent.type !== "group" || ++depth > 16) fail("projects-node-parent-invalid");
      current = parent;
    }
  }
}

function nativeIdList(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_THREAD_IDS) fail(code);
  const ids = value.map((entry) => nativeThreadId(entry));
  if (new Set(ids).size !== ids.length) fail(code);
  return ids;
}

function assertAllNativeIds(value: unknown, inventory: NativeThreadInventoryV1, code: string): void {
  const ids = nativeIdList(value, code);
  const set = assertNativeThreadInventory(inventory);
  if (ids.some((id) => !set.has(id))) fail(code);
}

function assertNativeId(value: unknown, inventory: NativeThreadInventoryV1, code: string): void {
  const id = nativeThreadId(value);
  if (!assertNativeThreadInventory(inventory).has(id)) fail(code);
}

function nativeThreadId(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_NATIVE_ID_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)) fail("native-thread-id-invalid");
  return value;
}

function absolutePath(value: unknown, code: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > 4096 || !isAbsolute(value)) fail(code);
  if (normalize(value) !== value || resolve(value) !== value || value === "/") fail(code);
  return value;
}

function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > max || /[\u0000-\u001f\u007f]/.test(value)) fail(code);
  return value;
}

function safeId(value: unknown, code: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(code);
  return value;
}

function timestampNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 9_999_999_999_999) fail(code);
  return value;
}

function requiredIdentity(value: string | undefined, code: string): string {
  if (value === undefined || value.length === 0) fail(code);
  return value;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJson(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertBoundedJson(value: unknown, code: string): void {
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_GLOBAL_STATE_BYTES) fail(code);
  } catch (error) {
    if (error instanceof PortableContinuityProjectionError) throw error;
    fail(code);
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sortRecord<T>(value: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right)));
}

function unique<T>(value: readonly T[]): T[] {
  return [...new Set(value)];
}

function uniqueConflicts(value: readonly PortableFieldConflictV1[]): PortableFieldConflictV1[] {
  const seen = new Set<string>();
  return [...value]
    .sort((left, right) => compareCodeUnits(`${left.fieldId}:${left.reason}`, `${right.fieldId}:${right.reason}`))
    .filter((entry) => {
      const key = `${entry.fieldId}:${entry.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function safeFieldId(value: string): boolean {
  return /^(?:global-state|projects|config)\.[a-z-]+(?:\.[a-f0-9]{16})?$/.test(value);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string): never {
  throw new PortableContinuityProjectionError(code);
}
