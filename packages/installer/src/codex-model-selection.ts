import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { RendererPatchDeclined, type RendererPatchApplication } from "./renderer-patch-outcome.js";

export const CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER =
  "__tweaker_model_selection_draft_override__";

export interface CodexModelSelectionPatch {
  source: string;
  changed: boolean;
  strategy: "already-patched" | "new-draft-explicit-selection";
}

export interface CodexModelSelectionAppPatch extends RendererPatchApplication {
  strategy?: CodexModelSelectionPatch["strategy"];
}

const IDENTIFIER = "([$A-Za-z_][$A-Za-z0-9_]*)";
const SELECTOR_INITIALIZER = new RegExp(
  `${IDENTIFIER}=${IDENTIFIER}==null&&${IDENTIFIER},` +
    `${IDENTIFIER}=\\1&&${IDENTIFIER}\\.hasManagedNewThreadSettings,` +
    `${IDENTIFIER}=\\1&&\\5\\.isUsingCopilotApi`,
  "g",
);
const MARKED_SELECTOR_INITIALIZER = new RegExp(
  `${IDENTIFIER}=${IDENTIFIER}==null&&${IDENTIFIER},` +
    `${IDENTIFIER}=\\1/\\*${CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER}\\*/,` +
    `${IDENTIFIER}=\\1&&${IDENTIFIER}\\.isUsingCopilotApi`,
  "g",
);

const REQUIRED_NEARBY_FINGERPRINTS = [
  "isManuallyChanged:!0",
  "clear-prewarmed-threads-for-host",
  "setModelAndReasoningEffort",
];

const RENDERER_INDEX = "webview/index.html";
const JAVASCRIPT_MODULE_EXTENSION = /\.[cm]?js$/i;
const RELATIVE_JAVASCRIPT_MODULE_REFERENCE =
  /(?:\bimport\s*(?:\(\s*)?|\b(?:import|export)\s+[^"'`;\n]*?\bfrom\s+|\brequire\s*\(\s*)["'`]((?:\.{1,2}\/)[^"'`?#]+?\.[cm]?js)(?:[?#][^"'`]*)?["'`]/gi;

/**
 * Keep a user's explicit model/effort selection attached to a new, unsent
 * draft. Codex already uses this draft-owned path for managed defaults; the
 * project-config path otherwise writes a lower-precedence global default and
 * is immediately overwritten when project settings refresh.
 */
export function patchCodexModelSelectionSource(
  source: string,
): CodexModelSelectionPatch | null {
  if (source.includes(CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER)) {
    const markedMatches = verifiedSelectorMatches(source, MARKED_SELECTOR_INITIALIZER);
    const markerCount = source.split(CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER).length - 1;
    if (markerCount !== 1 || markedMatches.length !== 1) {
      throw new Error(
        "Codex model selector patch marker is not attached to exactly one verified selector initializer",
      );
    }
    return { source, changed: false, strategy: "already-patched" };
  }

  const matches = verifiedSelectorMatches(source, SELECTOR_INITIALIZER);

  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(
      `Codex model selector patch matched ${matches.length} selector initializers; refusing an ambiguous renderer change`,
    );
  }

  const match = matches[0];
  const matchIndex = match.index ?? -1;
  const [matched, isNewDraft, threadId, newDraftFlag, pinSelection, settings, copilot] = match;
  if (
    matchIndex < 0 ||
    !matched ||
    !isNewDraft ||
    !threadId ||
    !newDraftFlag ||
    !pinSelection ||
    !settings ||
    !copilot
  ) {
    throw new Error("Codex model selector patch could not resolve its captured identifiers");
  }

  const replacement =
    `${isNewDraft}=${threadId}==null&&${newDraftFlag},` +
    `${pinSelection}=${isNewDraft}/*${CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER}*/,` +
    `${copilot}=${isNewDraft}&&${settings}.isUsingCopilotApi`;

  return {
    source: source.slice(0, matchIndex) + replacement + source.slice(matchIndex + matched.length),
    changed: true,
    strategy: "new-draft-explicit-selection",
  };
}

/** Patch the recognized selector bundle inside an extracted app.asar tree. */
export function patchCodexModelSelectionInExtractedApp(
  appDir: string,
): CodexModelSelectionAppPatch {
  const rendererRoot = resolve(appDir, "webview");
  const visited = new Set<string>();
  let scannedFiles = 0;
  let frontier = initialRendererModuleCandidates(appDir, rendererRoot);

  while (frontier.length > 0) {
    const phase = [...new Set(frontier)].filter((candidate) => !visited.has(candidate)).sort();
    if (phase.length === 0) break;
    phase.forEach((candidate) => visited.add(candidate));
    const inspection = inspectCandidatePhase(appDir, phase);
    scannedFiles += inspection.sources.length;
    const selected = selectCandidatePatch(appDir, inspection);
    if (selected) return applySelectedPatch(appDir, selected, scannedFiles);

    frontier = inspection.sources.flatMap(({ path, source }) =>
      javascriptModuleReferences(path, source, rendererRoot),
    );
  }

  const fallback = collectJavaScriptFiles(resolve(rendererRoot, "assets"))
    .filter((candidate) => !visited.has(candidate));
  if (fallback.length > 0) {
    const inspection = inspectCandidatePhase(appDir, fallback);
    scannedFiles += inspection.sources.length;
    const selected = selectCandidatePatch(appDir, inspection);
    if (selected) return applySelectedPatch(appDir, selected, scannedFiles);
  }

  return { status: "not-applicable", scannedFiles };
}

export function findCodexModelSelectionCandidates(appDir: string): string[] {
  const rendererRoot = resolve(appDir, "webview");
  const candidates = initialRendererModuleCandidates(appDir, rendererRoot);
  candidates.push(...collectJavaScriptFiles(resolve(rendererRoot, "assets")));
  return [...new Set(candidates)].sort((left, right) => left.localeCompare(right));
}

interface InspectedCandidate {
  path: string;
  source: string;
  patch: CodexModelSelectionPatch | null;
  incompatible: boolean;
}

interface CandidatePhaseInspection {
  sources: InspectedCandidate[];
}

function inspectCandidatePhase(appDir: string, candidates: string[]): CandidatePhaseInspection {
  const sources = candidates.map((path): InspectedCandidate => {
    const source = readFileSync(path, "utf8");
    try {
      const patch = patchCodexModelSelectionSource(source);
      return { path, source, patch, incompatible: !patch && looksLikeIncompatibleSelector(source) };
    } catch (error) {
      const relativePath = relative(appDir, path);
      const message = `Codex model selector patch rejected ${relativePath}: ${errorMessage(error)}`;
      if (error instanceof RendererPatchDeclined) {
        throw new RendererPatchDeclined({ message, reasonCode: error.reasonCode, relativePath });
      }
      throw new Error(message);
    }
  });
  return { sources };
}

function selectCandidatePatch(
  appDir: string,
  inspection: CandidatePhaseInspection,
): InspectedCandidate | null {
  const patches = inspection.sources.filter((candidate) => candidate.patch);
  const incompatibleCandidates = inspection.sources
    .filter((candidate) => candidate.incompatible)
    .map((candidate) => relative(appDir, candidate.path));

  if (incompatibleCandidates.length > 0) {
    // Upstream moved the site we key on. Declining records a skip and lets the
    // rest of the payload build; every other refusal below still fails it.
    throw new RendererPatchDeclined({
      reasonCode: "layout-drift",
      relativePath: incompatibleCandidates[0],
      message:
        "Codex model selector was recognized but its initializer layout changed in " +
        `${incompatibleCandidates.join(", ")}; refusing an unverified renderer change`,
    });
  }
  if (patches.length > 1) {
    throw new Error(
      `Codex model selector patch matched ${patches.length} renderer files; refusing an ambiguous renderer change`,
    );
  }
  return patches[0] ?? null;
}

function applySelectedPatch(
  appDir: string,
  selected: InspectedCandidate,
  scannedFiles: number,
): CodexModelSelectionAppPatch {
  const patch = selected.patch;
  if (!patch) throw new Error("Codex model selector patch lost its selected renderer candidate");
  if (patch.changed) writeFileSync(selected.path, patch.source);
  return {
    status: patch.changed ? "patched" : "already-patched",
    relativePath: relative(appDir, selected.path),
    scannedFiles,
    strategy: patch.strategy,
  };
}

function initialRendererModuleCandidates(appDir: string, rendererRoot: string): string[] {
  const rendererIndex = resolve(appDir, RENDERER_INDEX);
  if (!existsSync(rendererIndex)) return [];

  const html = readFileSync(rendererIndex, "utf8");
  return moduleScriptSources(html).map((source) =>
    resolveContainedModule(dirname(rendererIndex), source, rendererRoot, "renderer module source"),
  );
}

function javascriptModuleReferences(path: string, source: string, rendererRoot: string): string[] {
  RELATIVE_JAVASCRIPT_MODULE_REFERENCE.lastIndex = 0;
  return [...source.matchAll(RELATIVE_JAVASCRIPT_MODULE_REFERENCE)].map((match) =>
    resolveContainedModule(dirname(path), match[1] ?? "", rendererRoot, "renderer module reference"),
  );
}

function resolveContainedModule(
  baseDir: string,
  source: string,
  rendererRoot: string,
  label: string,
): string {
  const withoutQuery = source.split(/[?#]/, 1)[0] ?? "";
  if (!withoutQuery || withoutQuery.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(withoutQuery)) {
    throw new Error(`Codex ${label} is not contained in app.asar: ${source}`);
  }
  const candidate = resolve(baseDir, withoutQuery);
  if (!isSameOrInside(candidate, rendererRoot)) {
    throw new Error(`Codex ${label} escapes its ASAR root: ${source}`);
  }
  if (!JAVASCRIPT_MODULE_EXTENSION.test(candidate)) {
    throw new Error(`Codex ${label} has an unsupported JavaScript extension: ${source}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`Codex ${label} does not exist inside app.asar: ${source}`);
  }
  return candidate;
}

function verifiedSelectorMatches(source: string, pattern: RegExp): RegExpMatchArray[] {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].filter((match) =>
    hasRequiredNearbyFingerprints(source, match.index ?? -1),
  );
}

function hasRequiredNearbyFingerprints(source: string, matchIndex: number): boolean {
  if (matchIndex < 0) return false;
  const componentTail = source.slice(matchIndex, matchIndex + 5_000);
  return REQUIRED_NEARBY_FINGERPRINTS.every((fingerprint) => componentTail.includes(fingerprint));
}

function looksLikeIncompatibleSelector(source: string): boolean {
  return source.includes("hasManagedNewThreadSettings") &&
    source.includes("isUsingCopilotApi") &&
    REQUIRED_NEARBY_FINGERPRINTS.every((fingerprint) => source.includes(fingerprint));
}

function moduleScriptSources(html: string): string[] {
  const sources: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) continue;
    const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (source) sources.push(source);
  }
  return sources;
}

function collectJavaScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScriptFiles(target));
    else if (entry.isFile() && JAVASCRIPT_MODULE_EXTENSION.test(entry.name)) files.push(target);
  }
  return files;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}
