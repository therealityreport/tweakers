import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Existence-only liveness: kill(pid, 0), with EPERM counting as alive. A
 * recycled PID (or another user's process via EPERM) reports alive for an
 * owner that actually died — the conservative direction for every gate that
 * uses this (a false "alive" defers work; it never triggers recovery or
 * mutation). Do not add start-time heuristics here; callers that need
 * stronger identity must record their own token beside the PID.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLockOwner(lockFile: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Unknown identity is never evidence that a live owner can be reclaimed. */
export function processStartedAt(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export function processIdentityAlive(pid: number, startedAt?: string | null): boolean {
  if (!processAlive(pid)) return false;
  if (!startedAt) return true;
  const observed = processStartedAt(pid);
  return observed === null || observed === startedAt;
}

function fileOwnerAlive(file: string, pid: number): boolean {
  try {
    const metadata = readFileSync(file, "utf8").split("\n")[1];
    const startedAt = metadata ? JSON.parse(metadata).startedAt : null;
    return processIdentityAlive(pid, typeof startedAt === "string" ? startedAt : null);
  } catch { return processAlive(pid); }
}

interface ChoosingClaim {
  file: string;
  pid: number;
  token: string;
}

interface TicketClaim extends ChoosingClaim {
  ticket: number;
}

interface ClaimSnapshot {
  choosing: ChoosingClaim[];
  tickets: TicketClaim[];
  malformed: boolean;
}

const CHOOSING_PATTERN = /^choosing-(\d+)-([0-9a-f-]+)$/i;
const TICKET_PATTERN = /^ticket-(\d+)-(\d+)-([0-9a-f-]+)$/i;

function claimDirectory(lockFile: string): string {
  return `${lockFile}.claims`;
}

function removeClaim(file: string): void {
  try { unlinkSync(file); } catch { /* already removed */ }
}

function createClaim(file: string, value: string, close: typeof closeSync): void {
  const fd = openSync(file, "wx", 0o600);
  let failure: unknown = null;
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } catch (error) {
    failure = error;
  }
  try {
    close(fd);
  } catch (error) {
    // A successfully-created claim remains live until its descriptor is
    // closed.  Never let a close failure strand that claim and block every
    // subsequent contender indefinitely.
    failure ??= error;
  }
  if (failure !== null) {
    removeClaim(file);
    throw failure;
  }
}

function inspectClaims(lockFile: string, cleanupDead: boolean): ClaimSnapshot {
  const directory = claimDirectory(lockFile);
  if (!existsSync(directory)) return { choosing: [], tickets: [], malformed: false };
  const choosing: ChoosingClaim[] = [];
  const tickets: TicketClaim[] = [];
  let malformed = false;
  for (const name of readdirSync(directory)) {
    if (name.startsWith(".")) continue;
    const file = join(directory, name);
    const choosingMatch = CHOOSING_PATTERN.exec(name);
    if (choosingMatch) {
      const pid = Number.parseInt(choosingMatch[1]!, 10);
      if (!fileOwnerAlive(file, pid)) {
        if (cleanupDead) removeClaim(file);
        continue;
      }
      choosing.push({ file, pid, token: choosingMatch[2]! });
      continue;
    }
    const ticketMatch = TICKET_PATTERN.exec(name);
    if (ticketMatch) {
      const ticket = Number.parseInt(ticketMatch[1]!, 10);
      const pid = Number.parseInt(ticketMatch[2]!, 10);
      if (!Number.isSafeInteger(ticket) || ticket < 1 || !fileOwnerAlive(file, pid)) {
        if (cleanupDead) removeClaim(file);
        continue;
      }
      tickets.push({ file, ticket, pid, token: ticketMatch[3]! });
      continue;
    }
    malformed = true;
  }
  return { choosing, tickets, malformed };
}

function compareTickets(left: TicketClaim, right: TicketClaim): number {
  if (left.ticket !== right.ticket) return left.ticket - right.ticket;
  if (left.pid !== right.pid) return left.pid - right.pid;
  return left.token.localeCompare(right.token);
}

export function isLockHeldByLiveOwner(lockFile: string): boolean {
  const claims = inspectClaims(lockFile, false);
  if (claims.malformed || claims.choosing.length > 0 || claims.tickets.length > 0) return true;
  const owner = readLockOwner(lockFile);
  // A second acquisition in the same Node process is still concurrent work.
  return owner !== null && fileOwnerAlive(lockFile, owner);
}

export interface ProcessLock {
  release(): void;
}

export interface ProcessLockOptions {
  onContended?: (owner: number | null) => Error;
  /** Deterministic test seam after this contender wins, before legacy-file reclamation. */
  afterClaimed?: () => void;
  /** Deterministic test seam immediately before the settled (second) claim inspection. */
  beforeSettledInspection?: () => void;
  /** Injectable descriptor close used by claim creation and release tests. */
  close?: typeof closeSync;
}

/**
 * Acquire a synchronous cross-process lease.
 *
 * Unique bakery claims are authoritative. A dead legacy PID file is reclaimed
 * only after one contender has won that election, so two contenders can never
 * unlink each other's newly-created live lock.
 */
export function acquireProcessLock(
  lockFile: string,
  opts: ProcessLockOptions = {},
): ProcessLock {
  mkdirSync(dirname(lockFile), { recursive: true });
  const claimsDir = claimDirectory(lockFile);
  mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const claimBody = `${process.pid}\n${JSON.stringify({ version: 2, token, startedAt: processStartedAt(process.pid) })}\n`;
  const choosingFile = join(claimsDir, `choosing-${process.pid}-${token}`);
  const contended = (owner: number | null): Error =>
    opts.onContended?.(owner) ?? new Error(
      owner === null
        ? "Another process already holds this lock"
        : `Another process already holds this lock (PID ${owner})`,
    );
  const close = opts.close ?? closeSync;

  createClaim(choosingFile, claimBody, close);
  let ticketFile: string | null = null;
  let ticket = 1;
  try {
    const initial = inspectClaims(lockFile, true);
    if (initial.malformed) throw contended(null);
    ticket = initial.tickets.reduce((maximum, claim) => Math.max(maximum, claim.ticket), 0) + 1;
    ticketFile = join(
      claimsDir,
      `ticket-${String(ticket).padStart(16, "0")}-${process.pid}-${token}`,
    );
    createClaim(ticketFile, claimBody, close);
  } finally {
    removeClaim(choosingFile);
  }

  const abandon = (error: Error): never => {
    if (ticketFile) removeClaim(ticketFile);
    throw error;
  };
  const abandonContended = (owner: number | null): never => {
    let error: unknown;
    try {
      error = contended(owner);
    } catch (callbackError) {
      error = callbackError;
    }
    return abandon(error as Error);
  };
  try {
    opts.beforeSettledInspection?.();
    let settled = inspectClaims(lockFile, true);
    const deadline = Date.now() + 100;
    while (settled.choosing.some(claim => claim.token !== token && claim.pid !== process.pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      settled = inspectClaims(lockFile, true);
    }
    if (settled.malformed) return abandonContended(null);
    const otherChooser = settled.choosing.find((claim) => claim.token !== token);
    if (otherChooser) return abandonContended(otherChooser.pid);
    const winner = [...settled.tickets].sort(compareTickets)[0];
    if (!winner || winner.token !== token) return abandonContended(winner?.pid ?? null);

    opts.afterClaimed?.();
  } catch (error) {
    return abandon(error as Error);
  }

  const createLegacyProjection = (): number => {
    const fd = openSync(lockFile, "wx", 0o600);
    try {
      writeFileSync(fd, claimBody);
      fsyncSync(fd);
      return fd;
    } catch (error) {
      try { close(fd); } catch { /* descriptor already closed */ }
      try { unlinkSync(lockFile); } catch { /* projection already removed */ }
      throw error;
    }
  };

  let fd: number;
  try {
    fd = createLegacyProjection();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return abandon(error as Error);
    const owner = readLockOwner(lockFile);
    if (owner !== null && fileOwnerAlive(lockFile, owner)) return abandonContended(owner);
    // Only the elected live claim reaches this point. Other current-version
    // contenders remain behind its ticket while the stale projection is moved.
    try { unlinkSync(lockFile); } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return abandon(unlinkError as Error);
    }
    try {
      fd = createLegacyProjection();
    } catch {
      return abandonContended(readLockOwner(lockFile));
    }
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      try {
        const descriptor = fstatSync(fd);
        const projection = statSync(lockFile);
        if (descriptor.dev === projection.dev && descriptor.ino === projection.ino) unlinkSync(lockFile);
      } catch { /* projection already removed or replaced */ }
      try { close(fd); } catch { /* already closed */ }
      if (ticketFile) removeClaim(ticketFile);
    },
  };
}
