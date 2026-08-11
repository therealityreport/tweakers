/**
 * Outcome plumbing for the optional renderer patches.
 *
 * A renderer patch keys on the shape of someone else's minified bundle, so a
 * desktop update can legitimately move a patch site out from under us. When
 * that happens to an *optional* tweak, refusing to build the whole patched
 * payload takes every other tweak down with it — that is what happened on
 * 2026-08-10, when a renamed minified binding made the entire mode switch
 * impossible.
 *
 * The rule this module encodes: a patcher that recognizes its feature but no
 * longer recognizes its layout may decline, and the build records the skip and
 * carries on. Everything else — ambiguity, a failed re-verification, a bug in
 * our own code — still fails the build, because those are evidence about state
 * we do not understand rather than about upstream moving on.
 *
 * Criticality is expressed by which call sites route through
 * {@link runOptionalRendererPatch}. The window-services hook does not, so it
 * stays fatal by construction rather than by a flag someone can flip.
 */
import { readFileInAsar } from "./asar.js";

/**
 * Bump by hand whenever any renderer matcher changes. `repair` compares this
 * against the generation recorded in a payload to decide whether a previously
 * degraded patch deserves another attempt.
 */
export const RENDERER_PATCH_SET_GENERATION = 1;

export type RendererPatchId =
  | "renderer.model-selection"
  | "renderer.inactive-thread-retention";

/** Every reason code means ZERO bytes were written. */
export type RendererPatchReasonCode = "layout-drift";

/**
 * The only error {@link runOptionalRendererPatch} is permitted to convert into
 * a recorded skip. Throw it exclusively from a branch that has already decided
 * not to write anything.
 */
export class RendererPatchDeclined extends Error {
  readonly reasonCode: RendererPatchReasonCode;
  readonly relativePath?: string;

  constructor(init: { message: string; reasonCode: RendererPatchReasonCode; relativePath?: string }) {
    super(init.message);
    this.name = "RendererPatchDeclined";
    this.reasonCode = init.reasonCode;
    if (init.relativePath !== undefined) this.relativePath = init.relativePath;
  }
}

export type RendererPatchStatus =
  | "patched"
  | "already-patched"
  | "not-applicable"
  | "skipped-drift";

export interface RendererPatchOutcome {
  id: RendererPatchId;
  status: RendererPatchStatus;
  scannedFiles: number;
  /** asar-relative; never absolute. */
  relativePath?: string;
  strategy?: string;
  reasonCode?: RendererPatchReasonCode;
  detail?: string;
}

export interface RendererPatchApplication {
  status: "patched" | "already-patched" | "not-applicable";
  scannedFiles: number;
  relativePath?: string;
  strategy?: string;
  detail?: string;
}

export interface RendererPatchRecord {
  schemaVersion: 1;
  generation: number;
  /** Sorted by id so two builds of the same input serialize identically. */
  patches: RendererPatchOutcome[];
}

/**
 * Run one OPTIONAL renderer patcher.
 *
 * Catches {@link RendererPatchDeclined} and nothing else — a TypeError in our
 * own matcher, an EACCES, a corrupt extract, or a failed re-verification all
 * propagate unchanged and still fail the transaction.
 */
export function runOptionalRendererPatch(
  id: RendererPatchId,
  apply: () => RendererPatchApplication,
): RendererPatchOutcome {
  try {
    const applied = apply();
    return {
      id,
      status: applied.status,
      scannedFiles: applied.scannedFiles,
      ...(applied.relativePath ? { relativePath: applied.relativePath } : {}),
      ...(applied.strategy ? { strategy: applied.strategy } : {}),
      ...(applied.detail ? { detail: applied.detail } : {}),
    };
  } catch (error) {
    if (!(error instanceof RendererPatchDeclined)) throw error;
    return {
      id,
      status: "skipped-drift",
      scannedFiles: 0,
      ...(error.relativePath ? { relativePath: error.relativePath } : {}),
      reasonCode: error.reasonCode,
      detail: error.message,
    };
  }
}

export function summarizeRendererPatches(outcomes: RendererPatchOutcome[]): RendererPatchRecord {
  return {
    schemaVersion: 1,
    generation: RENDERER_PATCH_SET_GENERATION,
    patches: [...outcomes].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

/**
 * Read the record a patched payload carries about itself.
 *
 * Returns null when the payload predates this record, is unreadable, or
 * declares a schema we do not know — callers render nothing in that case
 * rather than warning about a payload that never claimed anything.
 */
export function readRendererPatchRecord(asarPath: string): RendererPatchRecord | null {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileInAsar(asarPath, "package.json").toString("utf8"));
  } catch {
    return null;
  }
  if (!pkg || typeof pkg !== "object") return null;
  const meta = (pkg as Record<string, unknown>)["__tweaker"];
  if (!meta || typeof meta !== "object") return null;
  const record = (meta as Record<string, unknown>)["rendererPatches"];
  if (!record || typeof record !== "object") return null;
  const candidate = record as Partial<RendererPatchRecord>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.patches)) return null;
  return {
    schemaVersion: 1,
    generation: typeof candidate.generation === "number" ? candidate.generation : 0,
    patches: candidate.patches,
  };
}

/**
 * True when a payload records an optional patch that did not apply and was
 * produced by an older matcher generation — i.e. a newer Tweakers might now
 * succeed where the recorded build gave up.
 */
export function rendererPatchRetryWarranted(record: RendererPatchRecord | null): boolean {
  if (!record) return false;
  if (record.generation >= RENDERER_PATCH_SET_GENERATION) return false;
  return record.patches.some(
    (patch) => patch.status === "skipped-drift" || patch.status === "not-applicable",
  );
}
