import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ProcessIdentityV1 { pid: number; ppid: number; started: string }

export interface ProcessTreeAccessV1 {
  read(pid?: number, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null>;
  signal(pid: number, signal: NodeJS.Signals): boolean;
}

const STARTED = /^(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/;
const execFileAsync = promisify(execFile);
const MAX_OWNED_TREE_PROCESSES = 128;

/** A failed or partial census is unknown, never an empty process tree. */
export async function readProcessIdentitiesV1(pid?: number, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null> {
  if (process.platform !== "darwin") return null;
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) return null;
  const remainingMs = deadlineAt === undefined ? 2_000 : deadlineAt - Date.now();
  if (remainingMs <= 0) return null;
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync("/bin/ps", pid === undefined
      ? ["-axo", "pid=,ppid=,lstart="] : ["-p", String(pid), "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8", timeout: Math.max(1, Math.floor(Math.min(2_000, remainingMs))), maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }));
  } catch (error) {
    // ps exits 1 when an exact PID has disappeared. Other failures mean an
    // unknown census and must retain broker recovery ownership.
    const failed = error as { code?: number | string; stdout?: string; stderr?: string };
    if (pid !== undefined && (failed.code === 1 || failed.code === "1") && !failed.stdout?.trim() && !failed.stderr?.trim()) return [];
    return null;
  }
  try {
    const rows: ProcessIdentityV1[] = [];
    const seen = new Set<number>();
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const match = STARTED.exec(line.trim());
      if (!match) return null;
      const pid = Number(match[1]); const ppid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || seen.has(pid)) return null;
      seen.add(pid); rows.push({ pid, ppid, started: match[3]! });
    }
    return rows.length > 0 || pid !== undefined ? rows : null;
  } catch { return null; }
}

export const systemProcessTreeAccessV1: ProcessTreeAccessV1 = {
  read: readProcessIdentitiesV1,
  signal(pid, signal) { try { process.kill(pid, signal); return true; } catch { return false; } },
};

function sameIdentity(a: ProcessIdentityV1, b: ProcessIdentityV1): boolean {
  return a.pid === b.pid && a.started === b.started;
}

/** The direct child must be observed while still parented to this owner. */
export async function captureOwnedRootV1(pid: number | undefined, access: ProcessTreeAccessV1, deadlineAt?: number): Promise<ProcessIdentityV1 | null> {
  if (!pid) return null;
  const rows = await access.read(pid, deadlineAt);
  return rows?.find(row => row.pid === pid && row.ppid === process.pid) ?? null;
}

/** Transitive descendants are proven from one complete table while the root identity is still present. */
export async function captureOwnedTreeV1(root: ProcessIdentityV1, access: ProcessTreeAccessV1, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null> {
  const rows = await access.read(undefined, deadlineAt);
  if (!rows) return null;
  const current = rows.find(row => row.pid === root.pid);
  if (!current || !sameIdentity(current, root) || current.ppid !== process.pid) return null;
  const owned = [current];
  const seen = new Set([current.pid]);
  for (let index = 0; index < owned.length; index++) {
    for (const row of rows) if (row.ppid === owned[index]!.pid && !seen.has(row.pid)) {
      seen.add(row.pid); owned.push(row);
      if (owned.length > MAX_OWNED_TREE_PROCESSES) return null;
    }
  }
  return owned;
}

/** A reparented descendant may still be signalled, but only with its captured start identity. */
export async function verifiedSurvivorsV1(tree: readonly ProcessIdentityV1[], access: ProcessTreeAccessV1, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null> {
  const rows = await access.read(undefined, deadlineAt);
  if (!rows) return null;
  const byPid = new Map(rows.map(row => [row.pid, row]));
  return tree.filter(row => {
    const current = byPid.get(row.pid);
    return current && sameIdentity(current, row);
  });
}

/** Signal deepest verified descendants first; unknown or reused identities are left alone. */
export async function signalVerifiedTreeV1(tree: readonly ProcessIdentityV1[], access: ProcessTreeAccessV1, signal: NodeJS.Signals, deadlineAt = Date.now() + 5_000): Promise<boolean> {
  let signalled = true;
  for (const row of tree.slice().reverse()) {
    if (Date.now() >= deadlineAt) return false;
    // Re-read the exact PID immediately before signalling. A table captured
    // before signalling its siblings is insufficient under PID reuse.
    const current = await access.read(row.pid, deadlineAt);
    if (!current) return false;
    if (current.some(candidate => sameIdentity(candidate, row)) && !access.signal(row.pid, signal)) signalled = false;
  }
  return signalled;
}
