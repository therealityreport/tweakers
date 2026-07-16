import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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

export function isLockHeldByLiveOwner(lockFile: string): boolean {
  const owner = readLockOwner(lockFile);
  return owner !== null && owner !== process.pid && processAlive(owner);
}

export interface ProcessLock {
  release(): void;
}

export function acquireProcessLock(
  lockFile: string,
  opts: { onContended?: (owner: number | null) => Error } = {},
): ProcessLock {
  mkdirSync(dirname(lockFile), { recursive: true });
  const create = (): number => {
    const fd = openSync(lockFile, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    return fd;
  };
  const contended = (owner: number | null): Error =>
    opts.onContended?.(owner) ?? new Error(
      owner === null
        ? "Another process already holds this lock"
        : `Another process already holds this lock (PID ${owner})`,
    );

  let fd: number;
  try {
    fd = create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = readLockOwner(lockFile);
    if (isLockHeldByLiveOwner(lockFile)) throw contended(owner);
    unlinkSync(lockFile);
    try {
      fd = create();
    } catch {
      throw contended(readLockOwner(lockFile));
    }
  }

  return {
    release: () => {
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lockFile); } catch { /* already removed */ }
    },
  };
}
