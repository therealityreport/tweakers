/**
 * Stale-helper (orphan) cleanup for the Codex app bundle.
 *
 * When the Codex main process dies abnormally, helper processes (crashpad
 * handlers, bare-modifier-monitor, …) are reparented to launchd (PPID 1) and
 * keep sleeping. They previously made getOpenReport() report "background"
 * forever, deadlocking the watcher's promote-on-close wait.
 *
 * Selection is pure and fail-closed: a process is only ever a cleanup
 * candidate when its executable path can be parsed EXACTLY and resolves
 * inside the canonical app bundle. Never kill by process name alone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { sep } from "node:path";
import { listProcesses, type ProcessInfo } from "./commands/debug.js";

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
  skipped: Array<{ pid: number; reason: "recheck-mismatch" | "gone" | "signal-failed" }>;
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

interface PsSnapshot {
  ppid: number | null;
  startedAtRaw: string | null;
  command: string;
}

/** Stable process-identity token used to reject PID reuse across transactions. */
export function readProcessStartToken(pid: number): string | null {
  const snapshot = readProcessSnapshot(pid);
  return snapshot?.startedAtRaw ?? null;
}

/** Re-read one PID via ps. Returns null when the process is gone. */
function readProcessSnapshot(pid: number): PsSnapshot | null {
  let output: string;
  try {
    output = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,lstart=,args="], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const line = output.split("\n").find((l) => l.trim().length > 0);
  if (!line) return null;
  // pid ppid lstart(5 tokens: Day Mon DD HH:MM:SS YYYY) args...
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
  if (!match) return null;
  if (Number(match[1]) !== pid) return null;
  return { ppid: Number(match[2]), startedAtRaw: match[3], command: match[4] };
}

/** Snapshot matches the originally-scanned process (PID-reuse guard). */
function snapshotMatches(proc: ProcessInfo, snapshot: PsSnapshot): boolean {
  if (snapshot.ppid !== 1) return false;
  if (snapshot.command !== proc.command) return false;
  if (proc.startedAtRaw !== null && snapshot.startedAtRaw !== proc.startedAtRaw) return false;
  return true;
}

/**
 * SIDE EFFECTS. Darwin-only (no-op elsewhere). Finds stale bundle-owned
 * helpers, then for each candidate re-verifies pid/ppid/command/start-time via
 * a fresh `ps -p` IMMEDIATELY before signaling (PID-reuse guard). SIGTERM
 * first; after a 3s grace period, survivors that still pass the identical
 * re-check are SIGKILLed.
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
  if (candidates.length === 0) return result;

  const signaled: ProcessInfo[] = [];
  for (const proc of candidates) {
    const snapshot = readProcessSnapshot(proc.pid);
    if (snapshot === null) {
      result.skipped.push({ pid: proc.pid, reason: "gone" });
      continue;
    }
    if (!snapshotMatches(proc, snapshot)) {
      result.skipped.push({ pid: proc.pid, reason: "recheck-mismatch" });
      continue;
    }
    try {
      process.kill(proc.pid, "SIGTERM");
      signaled.push(proc);
      opts.log?.(`Terminated stale Codex helper ${proc.pid} (${snapshot.command.slice(0, 120)})`);
    } catch {
      result.skipped.push({ pid: proc.pid, reason: "signal-failed" });
    }
  }

  if (signaled.length > 0) {
    try {
      execFileSync("sleep", ["3"], { stdio: "ignore" });
    } catch {}
    for (const proc of signaled) {
      const snapshot = readProcessSnapshot(proc.pid);
      if (snapshot !== null && snapshotMatches(proc, snapshot)) {
        try {
          process.kill(proc.pid, "SIGKILL");
          opts.log?.(`Stale Codex helper ${proc.pid} ignored SIGTERM; sent SIGKILL.`);
        } catch {}
      }
      result.terminated.push(proc.pid);
    }
  }

  return result;
}
