/**
 * Observation-only stale-helper (orphan) compatibility scan.
 *
 * When the Codex main process dies abnormally, helper processes (crashpad
 * handlers, bare-modifier-monitor, …) are reparented to launchd (PPID 1) and
 * keep sleeping. They previously made getOpenReport() report "background"
 * forever, deadlocking the watcher's promote-on-close wait.
 *
 * Selection remains pure and fail-closed so legacy diagnostics can report
 * exact app-bundle descendants. This module intentionally performs no signal
 * or termination action; the managed MCP lifecycle reaper is the sole signal
 * owner.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { sep } from "node:path";
import { execFileSync } from "node:child_process";
import { listProcesses, type ProcessInfo } from "./commands/debug.js";

/** Stable process-start token used to reject PID reuse across transactions. */
export function readProcessStartToken(pid: number): string | null {
  try {
    const output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "pid=,ppid=,lstart=,args="],
      { encoding: "utf8" },
    );
    const line = output.split("\n").find((value) => value.trim().length > 0);
    if (!line) return null;
    const match = /^\s*(\d+)\s+\d+\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+/.exec(line);
    return match && Number(match[1]) === pid ? match[2] ?? null : null;
  } catch {
    return null;
  }
}

export interface OrphanScanInput {
  /** Canonical (realpath) app root, e.g. /Applications/ChatGPT.app */
  canonicalAppRoot: string;
  processes: ProcessInfo[];
  /** startedAt (ISO) of the current main process, or null when no main process exists. */
  mainStartedAt: string | null;
  /** Exclude these pids unconditionally (self, parent). */
  excludePids?: number[];
}

export interface TerminateOrphansResult {
  scanned: number;
  terminated: number[];
  skipped: Array<{ pid: number; reason: "observation-only" }>;
}

/**
 * Extract the executable path from a ps `args=` command line, or null when it
 * cannot be determined EXACTLY. Null means the process must be skipped
 * (fail closed) — never guess.
 *
 * Handles, in order:
 *  1. double- or single-quoted leading token;
 *  2. backslash-escaped spaces;
 *  3. unquoted paths containing literal spaces — resolved by testing
 *     space-split prefixes longest-first against the filesystem; ambiguity or
 *     a deleted/replaced executable yields null.
 */
export function parseExecutablePathFromCommand(
  command: string,
  fileExists: (path: string) => boolean = defaultFileExists,
): string | null {
  const trimmed = command.trimStart();
  if (trimmed.length === 0) return null;

  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end <= 1) return null;
    return trimmed.slice(1, end);
  }

  if (trimmed.includes("\\ ")) {
    // Backslash-escaped spaces: the executable token ends at the first
    // unescaped space.
    const match = /^((?:\\ |[^ ])+)/.exec(trimmed);
    if (match) {
      const candidate = match[1].replace(/\\ /g, " ");
      if (fileExists(candidate)) return candidate;
    }
    return null;
  }

  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return trimmed;

  // Unquoted path that may itself contain spaces: try prefixes longest-first
  // so `/A/B C/exe --flag` resolves to `/A/B C/exe`, not `/A/B`.
  const parts = trimmed.split(" ");
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join(" ");
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function defaultFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * True when the parsed executable path of `command` lies inside the canonical
 * app bundle. The bundle path appearing only as an ARGUMENT never matches —
 * containment is tested on the parsed executable, not the raw command line.
 */
export function commandExecutesInsideBundle(
  command: string,
  canonicalAppRoot: string,
  fileExists?: (path: string) => boolean,
): boolean {
  const executable = parseExecutablePathFromCommand(command, fileExists);
  if (executable === null) return false;
  return executable === canonicalAppRoot || executable.startsWith(canonicalAppRoot + sep);
}

/**
 * PURE. A process is a stale bundle-owned helper when ALL hold:
 *  - its executable parses exactly and resolves inside the canonical bundle;
 *  - it is NOT the main app executable (anything under Contents/MacOS/ is
 *    treated as main and never selected);
 *  - ppid === 1 (reparented to launchd — orphaned);
 *  - with a main process present: startedAt parses and is strictly earlier
 *    than mainStartedAt (stale generation); unparseable startedAt → skipped
 *    (fail-safe: never kill what we cannot date). With no main process, all
 *    bundle-owned ppid-1 helpers qualify.
 */
export function findStaleHelperProcesses(
  input: OrphanScanInput,
  fileExists?: (path: string) => boolean,
): ProcessInfo[] {
  const exclude = new Set(input.excludePids ?? []);
  const mainPrefix = input.canonicalAppRoot + sep + "Contents" + sep + "MacOS" + sep;
  const mainStarted = input.mainStartedAt === null ? null : Date.parse(input.mainStartedAt);
  if (mainStarted !== null && Number.isNaN(mainStarted)) return [];

  return input.processes.filter((proc) => {
    if (exclude.has(proc.pid)) return false;
    if (proc.ppid !== 1) return false;

    const executable = parseExecutablePathFromCommand(proc.command, fileExists);
    if (executable === null) return false;
    if (executable !== input.canonicalAppRoot && !executable.startsWith(input.canonicalAppRoot + sep)) {
      return false;
    }
    // Never select a main-process executable, even when orphaned — quitting
    // the main app is quitCodex's job, with its graceful shutdown window.
    if (executable.startsWith(mainPrefix)) return false;

    if (mainStarted === null) return true;
    if (proc.startedAt === null) return false;
    const started = Date.parse(proc.startedAt);
    if (Number.isNaN(started)) return false;
    return started < mainStarted;
  });
}

/**
 * Compatibility observation entrypoint.
 *
 * This function intentionally sends no signals. The MCP lifecycle reaper is
 * the sole automatic process-signal owner; installer/watcher hygiene may
 * report stale bundle-owned helpers but cannot terminate them.
 */
export function terminateStaleHelperProcesses(
  appRoot: string,
  opts: { mainStartedAt?: string | null; excludePids?: number[]; log?: (msg: string) => void } = {},
): TerminateOrphansResult {
  const result: TerminateOrphansResult = { scanned: 0, terminated: [], skipped: [] };
  if (platform() !== "darwin") return result;

  let canonicalAppRoot: string;
  try {
    canonicalAppRoot = realpathSync(appRoot);
  } catch {
    // Bundle mid-update or missing: never guess, do nothing.
    return result;
  }

  const excludePids = [...(opts.excludePids ?? []), process.pid, process.ppid ?? -1];
  const candidates = findStaleHelperProcesses({
    canonicalAppRoot,
    processes: listProcesses(),
    mainStartedAt: opts.mainStartedAt ?? null,
    excludePids,
  });
  result.scanned = candidates.length;
  result.skipped = candidates.map((proc) => ({ pid: proc.pid, reason: "observation-only" }));
  if (candidates.length > 0) {
    opts.log?.(`Observed ${candidates.length} stale bundle helper(s); lifecycle policy is observation-only.`);
  }
  return result;
}
