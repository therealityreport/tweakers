import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  chmodSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { LEGACY_DATA_DIR } from "./legacy-compat.js";

export const CANONICAL_TWEAK_DIRS = Object.freeze([
  "co.tweakers.account-switcher",
  "co.tweakers.appshots",
  "co.tweakers.developer-tools",
  "co.tweakers.shadcn-codex-ui",
  "followup",
  // "mode-switcher" retired by the app-mode toggle (soft "vanilla" mode removed).
  "co.tweakers.projects",
  "co.tweakers.thread-summary-profiles",
  "titlebar-controls",
  "ui-improvements",
  "user-questions",
  "usage-limit-resets-tracker",
]);

const PROJECTS_ID = "co.tweakers.projects";
const GITHUB_ID = "co.tweakers.github-accounts";
const MAX_JSON_BYTES = 512 * 1024;

export interface LegacyMigrationOptions {
  legacyRoot?: string;
  legacyRoots?: string[];
  targetRoot: string;
  canonicalTweaksRoot: string;
  apply?: boolean;
}

export interface LegacyMigrationReport {
  mode: "dry-run" | "apply";
  counts: {
    catalogEntries: number;
    codeCopies: number;
    stateMerges: number;
    excludedLegacyRoots: number;
    targetQuarantines: number;
    unchanged: number;
  };
  excludedLegacyRoots: string[];
  targetTweakDirs: string[];
}

/**
 * Selectively migrates the old Projects and GitHub Accounts data into the
 * canonical Projects store. Legacy roots are read-only inputs. Executable code
 * always comes from this release's exact canonical bundle, never from a legacy root.
 */
export function migrateLegacyProjects(options: LegacyMigrationOptions): LegacyMigrationReport {
  const legacyRoots = (options.legacyRoots ?? (options.legacyRoot ? [options.legacyRoot] : [])).map((root) => resolve(root));
  if (legacyRoots.length === 0) throw new Error("At least one legacy root is required.");
  const targetRoot = resolve(options.targetRoot);
  const canonicalRoot = resolve(options.canonicalTweaksRoot);
  for (const legacyRoot of legacyRoots) assertDistinctRoots(legacyRoot, targetRoot);
  validateCanonicalRoot(canonicalRoot);

  const allowed = new Set(CANONICAL_TWEAK_DIRS);
  const excluded = [...new Set(legacyRoots.flatMap((legacyRoot) =>
    safeEntryNames(join(legacyRoot, "tweaks")).filter((name) => !allowed.has(name)),
  ))].sort();
  const targetTweaksRoot = join(targetRoot, "tweaks");
  const unsafeTargetRoot = existsSync(targetTweaksRoot) && !isPrivateDirectory(targetTweaksRoot);
  const existingTargetNames = unsafeTargetRoot ? [] : safeEntryNames(targetTweaksRoot);
  const extraTargets = existingTargetNames.filter((name) => !allowed.has(name));
  const codeCopies = CANONICAL_TWEAK_DIRS.filter((name) => !sameTree(join(canonicalRoot, name), join(targetRoot, "tweaks", name))).length;

  const current = readTargetProjects(targetRoot);
  let merged = current;
  for (const legacyRoot of legacyRoots) {
    merged = mergeProjects(merged, readFirstJson(legacyProjectCandidates(legacyRoot)), readFirstJson(legacyGithubCandidates(legacyRoot)));
  }
  const stateChanged = JSON.stringify(current) !== JSON.stringify(merged);
  const report: LegacyMigrationReport = {
    mode: options.apply ? "apply" : "dry-run",
    counts: {
      catalogEntries: CANONICAL_TWEAK_DIRS.length,
      codeCopies,
      stateMerges: stateChanged ? 1 : 0,
      excludedLegacyRoots: excluded.length,
      targetQuarantines: (unsafeTargetRoot ? 1 : 0) + extraTargets.length + (unsafeTargetRoot ? [] : CANONICAL_TWEAK_DIRS).filter((name) =>
        existsSync(join(targetRoot, "tweaks", name)) && !sameTree(join(canonicalRoot, name), join(targetRoot, "tweaks", name)),
      ).length,
      unchanged: CANONICAL_TWEAK_DIRS.length - codeCopies + (stateChanged ? 0 : 1),
    },
    excludedLegacyRoots: excluded,
    targetTweakDirs: [...CANONICAL_TWEAK_DIRS],
  };
  if (!options.apply) return report;

  const quarantineRoot = join(targetRoot, "migration-backup", `${Date.now()}-${process.pid}`);
  if (unsafeTargetRoot) quarantineTarget(targetTweaksRoot, join(quarantineRoot, "unsafe-tweaks-root"));
  mkdirPrivate(targetTweaksRoot);
  for (const name of extraTargets) quarantineTarget(join(targetRoot, "tweaks", name), join(quarantineRoot, name));
  for (const name of CANONICAL_TWEAK_DIRS) {
    const source = join(canonicalRoot, name);
    const target = join(targetRoot, "tweaks", name);
    if (!sameTree(source, target)) {
      if (existsSync(target)) quarantineTarget(target, join(quarantineRoot, name));
      copyCanonicalTree(source, target);
    }
  }
  if (stateChanged) {
    const dataDir = join(targetRoot, "tweak-data", PROJECTS_ID);
    mkdirPrivate(dataDir);
    atomicPrivateJson(join(dataDir, "projects-v1.json"), merged);
  }
  return report;
}

export function defaultLegacyMigrationRoots(home: string): string[] {
  return [
    join(home, "Library", "Application Support", LEGACY_DATA_DIR),
    join(home, "Library", "Application Support", "ShadGPT", "TweakerLibrary"),
  ];
}

function legacyProjectCandidates(root: string): string[] {
  return [
    join(root, "tweak-data", PROJECTS_ID, "projects-v1.json"),
    join(root, "data", PROJECTS_ID, "projects-v1.json"),
    join(root, "state", `${PROJECTS_ID}.json`),
    join(root, "projects.json"),
  ];
}

function legacyGithubCandidates(root: string): string[] {
  return [
    join(root, "tweak-data", GITHUB_ID, "github-accounts-v1.json"),
    join(root, "data", GITHUB_ID, "github-accounts-v1.json"),
    join(root, "state", `${GITHUB_ID}.json`),
    join(root, "github-accounts.json"),
  ];
}

function mergeProjects(currentRaw: unknown, projectsRaw: unknown, githubRaw: unknown): Record<string, unknown> {
  const current = normalizeProjects(currentRaw);
  const legacy = normalizeProjects(projectsRaw);
  const nodesById = new Map<string, Record<string, unknown>>();
  for (const node of [...legacy.nodes, ...current.nodes]) nodesById.set(String(node.id), structuredClone(node));
  const assignments = recordValue(recordValue(githubRaw).assignments);
  const legacyAccounts = Array.isArray(recordValue(githubRaw).accounts) ? recordValue(githubRaw).accounts : [];
  for (const node of nodesById.values()) {
    const id = String(node.id);
    const connections = recordValue(node.connections);
    if (!connections.github && typeof assignments[id] === "string") {
      const account = legacyAccounts.find((item: unknown) => recordValue(item).id === assignments[id]);
      connections.github = opaqueGithubReference(account ?? assignments[id]);
    }
    node.connections = connections;
  }
  return { schemaVersion: 1, nodes: [...nodesById.values()] };
}

function normalizeProjects(value: unknown): { nodes: Record<string, unknown>[] } {
  const record = recordValue(value);
  const nodes = Array.isArray(record.nodes)
    ? record.nodes
      .map(normalizeNode)
    : [];
  validateGraph(nodes);
  return { nodes };
}

const CONNECTION_PATTERNS: Record<string, RegExp> = {
  github: /^gh:[a-f0-9]{24}$/,
  modal: /^modal:[a-zA-Z0-9._-]{1,80}$/,
  google: /^google:[a-zA-Z0-9._-]{1,80}$/,
  chrome: /^chrome:[a-zA-Z0-9._-]{1,80}$/,
  "google-workspace": /^google-workspace:[a-zA-Z0-9._-]{1,80}$/,
  supabase: /^supabase:[a-zA-Z0-9._-]{1,80}$/,
  environment: /^environment:[a-zA-Z0-9._-]{1,80}$/,
};

function normalizeNode(value: unknown): Record<string, unknown> {
  const node = recordValue(value);
  const id = boundedId(node.id);
  const type = node.type === "group" ? "group" : "project";
  const name = typeof node.name === "string" && node.name.trim() ? node.name.trim() : id;
  if (name.length > 80 || /[\0\r\n]/.test(name)) throw new Error(`Invalid legacy project name: ${id}`);
  const parentId = node.parentId === null || node.parentId === undefined ? null : boundedId(node.parentId);
  const icon = safeIcon(node.icon);
  const connections: Record<string, string> = {};
  for (const [kind, pattern] of Object.entries(CONNECTION_PATTERNS)) {
    const candidate = recordValue(node.connections)[kind];
    if (typeof candidate === "string" && pattern.test(candidate) && !looksSensitive(candidate)) connections[kind] = candidate;
  }
  const out: Record<string, unknown> = { id, type, parentId, name, icon, connections };
  if (type === "project" && typeof node.projectPath === "string") {
    if (!isAbsolute(node.projectPath) || node.projectPath.length > 4096 || /[\0\r\n]/.test(node.projectPath)) {
      throw new Error(`Invalid legacy project path: ${id}`);
    }
    out.projectPath = node.projectPath;
  }
  if (type === "project" && typeof node.githubRepo === "string") {
    if (!/^[a-zA-Z0-9._-]{1,80}\/[a-zA-Z0-9._-]{1,100}$/.test(node.githubRepo)) throw new Error(`Invalid GitHub repository: ${id}`);
    out.githubRepo = node.githubRepo;
  }
  return out;
}

function boundedId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error("Invalid legacy project id.");
  return value;
}

function safeIcon(value: unknown): { kind: string; value: string } {
  const icon = recordValue(value);
  if (icon.kind === "emoji" && typeof icon.value === "string" && /^\p{Extended_Pictographic}(?:\uFE0F)?$/u.test(icon.value)) return { kind: "emoji", value: icon.value };
  if (icon.kind === "iconify" && typeof icon.value === "string" && /^[a-z0-9-]{1,40}:[a-z0-9-]{1,80}$/.test(icon.value)) return { kind: "iconify", value: icon.value };
  return { kind: "emoji", value: "📁" };
}

function looksSensitive(value: string): boolean {
  return /(?:token|cookie|secret|password|authorization)=|gh[opsu]_[A-Za-z0-9_]+|Bearer\s+\S+/i.test(value);
}

function validateGraph(nodes: Record<string, unknown>[]): void {
  if (nodes.length > 200) throw new Error("Legacy project state exceeds 200 nodes.");
  const byId = new Map<string, Record<string, unknown>>();
  for (const node of nodes) {
    const id = String(node.id);
    if (byId.has(id)) throw new Error(`Duplicate legacy project id: ${id}`);
    byId.set(id, node);
  }
  for (const node of nodes) {
    let parentId = node.parentId as string | null;
    const seen = new Set([String(node.id)]);
    let depth = 0;
    while (parentId !== null) {
      if (seen.has(parentId)) throw new Error("Cyclic legacy project hierarchy.");
      const parent = byId.get(parentId);
      if (!parent || parent.type !== "group") throw new Error(`Invalid legacy project parent: ${parentId}`);
      if (++depth > 8) throw new Error("Legacy project hierarchy exceeds eight levels.");
      seen.add(parentId);
      parentId = parent.parentId as string | null;
    }
  }
}

function opaqueGithubReference(value: unknown): string {
  const record = recordValue(value);
  const identity = `${String(record.host ?? "github.com")}\0${String(record.login ?? record.id ?? value)}`;
  return `gh:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function readTargetProjects(root: string): unknown {
  return readFirstJson([join(root, "tweak-data", PROJECTS_ID, "projects-v1.json")]);
}

function readFirstJson(candidates: string[]): unknown {
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) throw new Error(`Unsafe migration input: ${file}`);
    return JSON.parse(readFileSync(file, "utf8"));
  }
  return {};
}

function validateCanonicalRoot(root: string): void {
  const names = safeDirectoryNames(root).sort();
  const expected = [...CANONICAL_TWEAK_DIRS].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Canonical bundle must contain exactly the ${CANONICAL_TWEAK_DIRS.length} approved tweak directories.`);
  for (const name of expected) {
    const full = join(root, name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`Canonical tweak cannot be a symlink: ${name}`);
  }
}

function copyCanonicalTree(source: string, target: string): void {
  mkdirPrivate(target);
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`Canonical bundle contains a symlink: ${from}`);
    if (stat.isDirectory()) copyCanonicalTree(from, to);
    else if (stat.isFile()) {
      copyFileSync(from, to);
      try { /* executable entries remain executable; all others become private */
        const mode = stat.mode & 0o111 ? 0o700 : 0o600;
        chmodSync(to, mode);
      } catch {}
    }
  }
}

function sameTree(source: string, target: string): boolean {
  if (!existsSync(target)) return false;
  const sourceStat = lstatSync(source);
  const targetStat = lstatSync(target);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || !targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
  if ((targetStat.mode & 0o777) !== 0o700) return false;
  const sourceNames = readdirSync(source).sort();
  const targetNames = readdirSync(target).sort();
  if (JSON.stringify(sourceNames) !== JSON.stringify(targetNames)) return false;
  return sourceNames.every((name) => {
    const from = join(source, name);
    const to = join(target, name);
    const a = lstatSync(from);
    const b = lstatSync(to);
    if (a.isSymbolicLink() || b.isSymbolicLink()) return false;
    if (a.isDirectory()) return b.isDirectory() && sameTree(from, to);
    if (!a.isFile() || !b.isFile() || b.nlink !== 1) return false;
    const expectedMode = a.mode & 0o111 ? 0o700 : 0o600;
    return (b.mode & 0o777) === expectedMode && readFileSync(from).equals(readFileSync(to));
  });
}

function safeDirectoryNames(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => lstatSync(join(root, name)).isDirectory());
}

function safeEntryNames(root: string): string[] {
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function isPrivateDirectory(path: string): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700;
}

function quarantineTarget(source: string, target: string): void {
  mkdirPrivate(dirname(target));
  renameSync(source, target);
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function atomicPrivateJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); } finally { closeSync(fd); }
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

function assertDistinctRoots(legacyRoot: string, targetRoot: string): void {
  if (legacyRoot === targetRoot || targetRoot.startsWith(`${legacyRoot}${sep}`)) {
    throw new Error("Migration target must be separate from the read-only legacy root.");
  }
}

function recordValue(value: unknown): Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : {};
}
