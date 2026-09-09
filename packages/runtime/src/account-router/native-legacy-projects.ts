import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { isPlainRecord, isOpaqueAccountId, type OpaqueAccountId } from "./types";
import { writePrivateJsonAtomicBounded } from "./state-store";

const FILE = "native-legacy-project-removals.v1.json";
const MAX_ENTRIES = 16_384;
const MAX_PROJECTS = 512;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_REMOVAL_BYTES = 1024 * 1024;

export interface NativeDesktopProjectsProjectionV1 {
  version: 1;
  values: {
    "local-projects": Record<string, { id: string; name: string; rootPaths: string[]; createdAt: number; updatedAt: number }>;
    "thread-project-assignments": Record<string, { projectKind: "local"; projectId: string }>;
    "project-order": string[];
    "pinned-project-ids": string[];
    "sidebar-project-thread-orders": Record<string, { threadIds: string[] }>;
    "electron-saved-workspace-roots": string[];
    "electron-workspace-root-labels": Record<string, string>;
    "project-appearances": Record<string, unknown>;
  };
  projectIdMap: Record<string, string>;
}

/** Read-only legacy membership overlay; native non-null project IDs always take precedence. */
export class NativeLegacyProjectsV1 {
  private assignments = new Map<string, string>();
  private ordered = new Map<string, readonly string[]>();
  private removals = new Map<string, string>();
  private ready = false;
  private failed = false;
  private unresolved = 0;

  constructor(private readonly root: string, private readonly sourceCodexHome: string, private readonly metadataAccountId: OpaqueAccountId) {
    if (!isOpaqueAccountId(metadataAccountId)) { this.failed = true; return; }
    const path = join(root, FILE);
    if (!existsSync(path)) return;
    try {
      const data = readObject(path, MAX_REMOVAL_BYTES, true);
      if (!isPlainRecord(data) || Object.keys(data).sort().join() !== "metadataAccountId,removals,version" || data.version !== 1
        || data.metadataAccountId !== metadataAccountId || !isPlainRecord(data.removals) || Object.keys(data.removals).length > MAX_ENTRIES) throw new Error("invalid removals");
      for (const [threadId, projectId] of Object.entries(data.removals)) {
        if (!id(threadId) || !id(projectId)) throw new Error("invalid removal");
        this.removals.set(threadId, projectId);
      }
    } catch { this.failed = true; }
  }

  /** Caller supplies IDs from a complete native project/list on the signed metadata account. */
  refresh(validNativeProjectIds: readonly string[]): boolean {
    this.ready = false; this.unresolved = 0; this.assignments.clear(); this.ordered.clear();
    if (this.failed || validNativeProjectIds.length > MAX_PROJECTS || !validNativeProjectIds.every(id)) return false;
    try {
      const valid = new Set(validNativeProjectIds);
      if (valid.size !== validNativeProjectIds.length) return false;
      const path = join(this.sourceCodexHome, ".codex-global-state.json");
      if (!existsSync(path)) { this.ready = true; return true; }
      const data = readObject(path, MAX_BYTES, false);
      if (!isPlainRecord(data)) return false;
      const maps = objectField(data, "app-server-project-id-by-legacy-project-id-by-host", 32);
      const assignments = objectField(data, "thread-project-assignments", MAX_ENTRIES);
      const orders = objectField(data, "sidebar-project-thread-orders", MAX_PROJECTS);
      const host = `local:${this.sourceCodexHome}`;
      const mapping = maps[host] === undefined ? {} : maps[host];
      if (!isPlainRecord(mapping) || Object.keys(mapping).length > MAX_PROJECTS) return false;
      const legacy = new Map<string, string>();
      for (const [legacyId, nativeId] of Object.entries(mapping)) {
        if (!id(legacyId) || !id(nativeId)) return false;
        if (valid.has(nativeId)) legacy.set(legacyId, nativeId);
      }
      for (const [otherHost, otherMap] of Object.entries(maps)) {
        if (otherHost === host) continue;
        if (otherHost.length > 4096 || !isPlainRecord(otherMap) || Object.keys(otherMap).length > MAX_PROJECTS) return false;
        for (const [legacyId, nativeId] of Object.entries(otherMap)) {
          if (!id(legacyId) || !id(nativeId) || (legacy.has(legacyId) && legacy.get(legacyId) !== nativeId)) return false;
        }
      }
      const grouped = new Map<string, string[]>();
      for (const [threadId, assignment] of Object.entries(assignments)) {
        if (!id(threadId) || !isPlainRecord(assignment)) return false;
        if (assignment.projectKind !== "local") continue;
        if (!id(assignment.projectId)) return false;
        const projectId = legacy.get(assignment.projectId) ?? (valid.has(assignment.projectId) ? assignment.projectId : null);
        if (!projectId) { this.unresolved += 1; continue; }
        if (this.removals.has(threadId)) continue;
        this.assignments.set(threadId, projectId);
        const rows = grouped.get(projectId) ?? []; rows.push(threadId); grouped.set(projectId, rows);
      }
      const explicit = new Map<string, string[]>();
      let orderEntries = 0;
      for (const [legacyId, order] of Object.entries(orders)) {
        const projectId = legacy.get(legacyId) ?? (valid.has(legacyId) ? legacyId : null);
        if (!isPlainRecord(order) || !Array.isArray(order.threadIds) || order.threadIds.length > MAX_ENTRIES) return false;
        orderEntries += order.threadIds.length;
        if (orderEntries > MAX_ENTRIES || !order.threadIds.every(id) || new Set(order.threadIds).size !== order.threadIds.length) return false;
        if (!projectId) continue;
        const rows = explicit.get(projectId) ?? [];
        for (const threadId of order.threadIds) if (this.assignments.get(threadId) === projectId && !rows.includes(threadId)) rows.push(threadId);
        explicit.set(projectId, rows);
      }
      for (const [projectId, rows] of grouped) {
        const first = explicit.get(projectId) ?? []; const seen = new Set(first);
        this.ordered.set(projectId, Object.freeze([...first, ...rows.filter((threadId) => !seen.has(threadId)).sort()]));
      }
      this.ready = true; return true;
    } catch { return false; }
    finally { if (!this.ready) { this.assignments.clear(); this.ordered.clear(); } }
  }

  legacyNativeThreadIdsForProject(publicProjectId: string): readonly string[] | null {
    return this.ready && !this.failed && id(publicProjectId) ? this.ordered.get(publicProjectId) ?? Object.freeze([]) : null;
  }

  legacyPublicProjectIdForThread(nativeThreadId: string): string | null {
    return this.ready && !this.failed ? this.assignments.get(nativeThreadId) ?? null : null;
  }

  unresolvedMembershipCount(): number | null { return this.ready && !this.failed ? this.unresolved : null; }

  /** Read a bounded, data-only snapshot for the native desktop project UI. */
  desktopProjection(nativeProjects: readonly unknown[]): NativeDesktopProjectsProjectionV1 | null {
    this.ready = false; this.unresolved = 0; this.assignments.clear(); this.ordered.clear();
    if (this.failed || nativeProjects.length > MAX_PROJECTS) return null;
    try {
      const current = nativeProjects.map(currentNativeProject);
      if (current.some((project) => project === null)) return null;
      const currentProjects = current as CurrentNativeProject[];
      const valid = new Set(currentProjects.map((project) => project.id));
      if (valid.size !== currentProjects.length) return null;
      const sourcePath = join(this.sourceCodexHome, ".codex-global-state.json");
      const data = existsSync(sourcePath) ? readObject(sourcePath, MAX_BYTES, false) : {};
      if (!isPlainRecord(data)) return null;
      const maps = objectField(data, "app-server-project-id-by-legacy-project-id-by-host", 32);
      const mapping = maps[`local:${this.sourceCodexHome}`] ?? {};
      if (!isPlainRecord(mapping) || Object.keys(mapping).length > MAX_PROJECTS) return null;
      const mappedLegacyByNative = new Map<string, string>();
      for (const [legacyId, nativeId] of Object.entries(mapping)) {
        if (!id(legacyId) || !id(nativeId)) return null;
        if (!valid.has(nativeId)) continue;
        if (mappedLegacyByNative.has(nativeId)) return null;
        mappedLegacyByNative.set(nativeId, legacyId);
      }

      const rawProjects = objectField(data, "local-projects", MAX_PROJECTS);
      const savedProjects = new Map<string, SavedLegacyProject>();
      for (const [legacyId, value] of Object.entries(rawProjects)) {
        const saved = savedLegacyProject(legacyId, value);
        if (saved) savedProjects.set(legacyId, saved);
      }
      const publicIds = reconcileProjectIds(currentProjects, savedProjects, mappedLegacyByNative);
      if (!publicIds) return null;
      const projectIdMap: Record<string, string> = {};
      const projects: NativeDesktopProjectsProjectionV1["values"]["local-projects"] = {};
      const appearances: Record<string, unknown> = {};
      for (const project of currentProjects) {
        const publicId = publicIds.get(project.id)!;
        const saved = savedProjects.get(publicId);
        projectIdMap[publicId] = project.id;
        projects[publicId] = { id: publicId, name: project.name, rootPaths: [...project.rootPaths], createdAt: saved?.createdAt ?? 0, updatedAt: saved?.updatedAt ?? 0 };
        if (project.appearance !== undefined) appearances[publicId] = structuredClone(project.appearance);
      }

      const rawAssignments = objectField(data, "thread-project-assignments", MAX_ENTRIES);
      const assignments: NativeDesktopProjectsProjectionV1["values"]["thread-project-assignments"] = {};
      for (const [threadId, value] of Object.entries(rawAssignments)) {
        if (!id(threadId) || !isPlainRecord(value)) return null;
        if (value.projectKind !== "local") continue;
        if (!id(value.projectId)) return null;
        const publicProjectId = publicProjectIdFor(value.projectId, projectIdMap);
        if (!publicProjectId) { this.unresolved += 1; continue; }
        if (!this.removals.has(threadId)) assignments[threadId] = { projectKind: "local", projectId: publicProjectId };
      }

      const projectOrder = reconciledProjectIdList(data["project-order"] ?? [], projects, projectIdMap, [...publicIds.values()]);
      const pinnedProjectIds = reconciledProjectIdList(data["pinned-project-ids"] ?? [], projects, projectIdMap);
      if (!projectOrder || !pinnedProjectIds) return null;
      const rawOrders = objectField(data, "sidebar-project-thread-orders", MAX_PROJECTS);
      const orders: NativeDesktopProjectsProjectionV1["values"]["sidebar-project-thread-orders"] = {};
      let orderEntries = 0;
      for (const [savedProjectId, value] of Object.entries(rawOrders)) {
        if (!id(savedProjectId) || !isPlainRecord(value) || !Array.isArray(value.threadIds)) return null;
        orderEntries += value.threadIds.length;
        if (orderEntries > MAX_ENTRIES || !value.threadIds.every(id) || new Set(value.threadIds).size !== value.threadIds.length) return null;
        const projectId = publicProjectIdFor(savedProjectId, projectIdMap);
        if (!projectId) continue;
        const rows = orders[projectId]?.threadIds ?? [];
        for (const threadId of value.threadIds) if (assignments[threadId]?.projectId === projectId && !rows.includes(threadId)) rows.push(threadId);
        orders[projectId] = { threadIds: rows };
      }

      const roots = data["electron-saved-workspace-roots"] ?? [];
      if (!pathList(roots, MAX_PROJECTS) || new Set(roots).size !== roots.length) return null;
      const rawLabels = objectField(data, "electron-workspace-root-labels", MAX_PROJECTS);
      const labels: Record<string, string> = {};
      const rootSet = new Set(roots);
      for (const [root, label] of Object.entries(rawLabels)) {
        if (typeof label !== "string" || label.length > 4096) return null;
        if (rootSet.has(root)) labels[root] = label;
      }
      const rawAppearances = objectField(data, "project-appearances", MAX_PROJECTS);
      for (const [savedProjectId, value] of Object.entries(rawAppearances)) {
        if (!id(savedProjectId)) return null;
        const projectId = publicProjectIdFor(savedProjectId, projectIdMap);
        if (!projectId || appearances[projectId] !== undefined) continue;
        if (!jsonData(value, 0)) return null;
        appearances[projectId] = structuredClone(value);
      }
      const grouped = new Map<string, string[]>();
      for (const [threadId, assignment] of Object.entries(assignments)) {
        const nativeProjectId = projectIdMap[assignment.projectId];
        if (!nativeProjectId) return null;
        this.assignments.set(threadId, nativeProjectId);
        const rows = grouped.get(nativeProjectId) ?? []; rows.push(threadId); grouped.set(nativeProjectId, rows);
      }
      for (const [legacyProjectId, rows] of Object.entries(orders)) {
        const nativeProjectId = projectIdMap[legacyProjectId];
        if (!nativeProjectId) return null;
        const explicit = rows.threadIds;
        const seen = new Set(explicit);
        this.ordered.set(nativeProjectId, Object.freeze([...explicit, ...(grouped.get(nativeProjectId) ?? []).filter((threadId) => !seen.has(threadId)).sort()]));
      }
      for (const [nativeProjectId, rows] of grouped) if (!this.ordered.has(nativeProjectId)) this.ordered.set(nativeProjectId, Object.freeze([...rows].sort()));
      this.ready = true;
      return {
        version: 1,
        values: {
          "local-projects": projects,
          "thread-project-assignments": assignments,
          "project-order": projectOrder,
          "pinned-project-ids": pinnedProjectIds,
          "sidebar-project-thread-orders": orders,
          "electron-saved-workspace-roots": [...roots],
          "electron-workspace-root-labels": labels,
          "project-appearances": appearances,
        },
        projectIdMap,
      };
    } catch { return null; }
    finally { if (!this.ready) { this.assignments.clear(); this.ordered.clear(); } }
  }

  isRemoved(publicProjectId: string, nativeThreadId: string): boolean {
    return id(publicProjectId) && this.removals.has(nativeThreadId);
  }

  /** Call after a successful native user-driven removal/reassignment, under the broker writer guard. */
  removeThreadFromProject(publicProjectId: string, nativeThreadId: string): boolean {
    if (this.failed || !id(publicProjectId) || !id(nativeThreadId) || (!this.removals.has(nativeThreadId) && this.removals.size >= MAX_ENTRIES)) return false;
    // Any explicit native reassignment retires the legacy assignment for this
    // task permanently. A later B -> unassigned must not resurrect old A.
    const next = new Map(this.removals); if (!next.has(nativeThreadId)) next.set(nativeThreadId, publicProjectId);
    try {
      writePrivateJsonAtomicBounded(this.root, FILE, { version: 1, metadataAccountId: this.metadataAccountId, removals: Object.fromEntries(next) }, MAX_REMOVAL_BYTES);
      this.removals = next;
      this.assignments.delete(nativeThreadId);
      for (const [projectId, rows] of this.ordered) if (rows.includes(nativeThreadId)) this.ordered.set(projectId, Object.freeze(rows.filter((row) => row !== nativeThreadId)));
      return true;
    } catch { this.failed = true; this.ready = false; return false; }
  }
}

function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s/\\\u0000-\u001f\u007f]/.test(value) && !["__proto__", "constructor", "prototype"].includes(value); }
function safeTime(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function pathList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4096 && isAbsolute(entry));
}
interface CurrentNativeProject { id: string; name: string; rootPaths: string[]; appearance?: unknown }
interface SavedLegacyProject { id: string; name: string; rootPaths: string[]; createdAt: number; updatedAt: number }
function currentNativeProject(value: unknown): CurrentNativeProject | null {
  if (!isPlainRecord(value) || !id(value.id) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 4096
    || /[\u0000-\u001f\u007f]/.test(value.name) || !Array.isArray(value.roots) || value.roots.length > MAX_PROJECTS) return null;
  const rootPaths: string[] = [];
  for (const root of value.roots) {
    if (!isPlainRecord(root) || typeof root.path !== "string" || root.path.length > 4096 || !isAbsolute(root.path)
      || normalize(root.path) !== root.path || /[\u0000-\u001f\u007f]/.test(root.path)) return null;
    rootPaths.push(root.path);
  }
  if (new Set(rootPaths).size !== rootPaths.length) return null;
  let appearance: unknown;
  if (value.metadata !== undefined) {
    if (!isPlainRecord(value.metadata) || !jsonData(value.metadata, 0) || Buffer.byteLength(JSON.stringify(value.metadata), "utf8") > 1024 * 1024) return null;
    const color = value.metadata["appearance.color"], marker = value.metadata["appearance.marker"], parsed: Record<string, unknown> = {};
    if (color !== undefined) { if (typeof color !== "string" || color.length > 4096) return null; parsed.color = color; }
    if (marker !== undefined) {
      if (typeof marker !== "string" || marker.length > 64 * 1024) return null;
      try { parsed.marker = JSON.parse(marker); } catch { return null; }
    }
    if (Object.keys(parsed).length > 0) { if (!jsonData(parsed, 0)) return null; appearance = parsed; }
  }
  return appearance === undefined ? { id: value.id, name: value.name, rootPaths } : { id: value.id, name: value.name, rootPaths, appearance };
}
function savedLegacyProject(legacyId: string, value: unknown): SavedLegacyProject | null {
  return id(legacyId) && isPlainRecord(value) && value.id === legacyId && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(value.name) && pathList(value.rootPaths, MAX_PROJECTS) && new Set(value.rootPaths).size === value.rootPaths.length
    && safeTime(value.createdAt) && safeTime(value.updatedAt)
    ? { id: legacyId, name: value.name, rootPaths: [...value.rootPaths], createdAt: value.createdAt, updatedAt: value.updatedAt } : null;
}
function reconcileProjectIds(current: readonly CurrentNativeProject[], saved: ReadonlyMap<string, SavedLegacyProject>, mapped: ReadonlyMap<string, string>): Map<string, string> | null {
  const result = new Map<string, string>(); const used = new Set<string>();
  const choose = (project: CurrentNativeProject, candidates: readonly string[]): boolean => {
    const ids = [...new Set(candidates)].filter((candidate) => !used.has(candidate));
    if (ids.length !== 1) return false;
    result.set(project.id, ids[0]!); used.add(ids[0]!); return true;
  };
  for (const project of current) {
    const mappedId = mapped.get(project.id);
    if (mappedId && !choose(project, [mappedId])) return null;
  }
  for (const project of current) if (!result.has(project.id) && saved.has(project.id)) choose(project, [project.id]);
  for (const project of current) if (!result.has(project.id) && project.rootPaths.length > 0) {
    const roots = project.rootPaths.slice().sort().join("\0");
    choose(project, [...saved.values()].filter((entry) => entry.rootPaths.length > 0 && entry.rootPaths.slice().sort().join("\0") === roots).map((entry) => entry.id));
  }
  for (const project of current) if (!result.has(project.id)) {
    const name = projectNameIdentity(project.name);
    choose(project, [...saved.values()].filter((entry) => projectNameIdentity(entry.name) === name).map((entry) => entry.id));
  }
  for (const project of current) if (!result.has(project.id)) {
    let publicId = project.id;
    for (let suffix = 0; used.has(publicId); suffix++) publicId = `app-server:${suffix === 0 ? "" : `${suffix}:`}${project.id}`;
    if (!id(publicId)) return null;
    result.set(project.id, publicId); used.add(publicId);
  }
  return result;
}
function projectNameIdentity(name: string): string {
  const normalized = name.trim().replace(/[ _-]+/g, " ").toUpperCase();
  if (normalized === "PROJECT MANAGER" || normalized === "SKILLS MANAGER") return "PROJECT MANAGER";
  if (normalized === "PLUGINS" || normalized === "PLUGINS REPO") return "PLUGINS";
  return normalized;
}
function publicProjectIdFor(value: string, projectIdMap: Record<string, string>): string | null {
  if (Object.hasOwn(projectIdMap, value)) return value;
  const matches = Object.entries(projectIdMap).filter(([, nativeId]) => nativeId === value);
  return matches.length === 1 ? matches[0]![0] : null;
}
function reconciledProjectIdList(value: unknown, projects: Record<string, unknown>, projectIdMap: Record<string, string>, append: readonly string[] = []): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PROJECTS || !value.every(id)) return null;
  const result: string[] = [];
  for (const entry of value) {
    const projectId = publicProjectIdFor(entry, projectIdMap);
    if (projectId && Object.hasOwn(projects, projectId) && !result.includes(projectId)) result.push(projectId);
  }
  for (const projectId of append) if (Object.hasOwn(projects, projectId) && !result.includes(projectId)) result.push(projectId);
  return result;
}
function jsonData(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  if (depth >= 8) return false;
  if (Array.isArray(value)) return value.length <= 512 && value.every((entry) => jsonData(entry, depth + 1));
  if (!isPlainRecord(value) || Object.keys(value).length > 512) return false;
  return Object.entries(value).every(([key, entry]) => id(key) && jsonData(entry, depth + 1));
}
function objectField(data: Record<string, unknown>, key: string, max: number): Record<string, unknown> {
  const field = data[key] ?? {};
  if (!isPlainRecord(field) || Object.keys(field).length > max) throw new Error("invalid legacy project metadata");
  return field;
}
function readObject(path: string, max: number, privateOnly: boolean): unknown {
  if (realpathSync(path) !== path) throw new Error("unsafe project metadata");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & (privateOnly ? 0o077 : 0o022)) || before.size > max) throw new Error("unsafe project metadata");
    bytes = readFileSync(fd); const after = fstatSync(fd); const current = lstatSync(path);
    if (bytes.length !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error("project metadata changed");
    return JSON.parse(bytes.toString("utf8"));
  } finally { bytes?.fill(0); closeSync(fd); }
}
