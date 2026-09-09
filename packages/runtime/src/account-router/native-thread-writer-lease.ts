import { lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface NativeThreadWriterLease {
  readonly dev: string;
  readonly ino: string;
  isHeld(): boolean;
  release(): void;
}

export type NativeThreadWriterLeaseResult =
  | { state: "ready"; lease: NativeThreadWriterLease }
  | { state: "busy" | "unavailable" };

/** Only the reviewed native host can acquire the shared native writer lock. */
export function acquireNativeThreadWriterLease(lockDirectory: string, threadId: string): NativeThreadWriterLeaseResult {
  if (process.platform !== "darwin" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(threadId)) return { state: "unavailable" };
  try {
    const directory = realpathSync(lockDirectory);
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o022n) !== 0n) return { state: "unavailable" };
    // The broker uses the runtime-local packaged host, never a development
    // checkout, global module path, or caller-selected native executable.
    const host = require(join(__dirname, "..", "native", "tweaker_native_host.node")) as {
      acquireNativeThreadWriterLease?: (directory: string, name: string, dev: string, ino: string) => NativeThreadWriterLease | null;
    };
    if (typeof host.acquireNativeThreadWriterLease !== "function") return { state: "unavailable" };
    const lease = host.acquireNativeThreadWriterLease(directory, `${threadId}.lock`, String(stat.dev), String(stat.ino));
    return lease ? { state: "ready", lease } : { state: "busy" };
  } catch { return { state: "unavailable" }; }
}

/** Prove the fresh target is the sole process holding the prepared lock inode. */
export function proveNativeThreadWriterLease(
  lockDirectory: string,
  threadId: string,
  identity: { dev: string; ino: string },
  targetPid: number,
): boolean {
  if (!Number.isSafeInteger(targetPid) || targetPid <= 0 || !/^\d+$/.test(identity.dev) || !/^\d+$/.test(identity.ino)) return false;
  try {
    const directory = realpathSync(lockDirectory);
    const file = join(directory, `${threadId}.lock`);
    const sameFile = () => {
      const stat = lstatSync(file, { bigint: true });
      return stat.isFile() && !stat.isSymbolicLink() && stat.uid === BigInt(process.getuid!())
        && (stat.mode & 0o022n) === 0n && stat.size === 0n
        && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
    };
    const occupied = () => {
      const result = acquireNativeThreadWriterLease(directory, threadId);
      if (result.state === "ready") result.lease.release();
      return result.state === "busy";
    };
    if (!sameFile() || !occupied()) return false;
    // macOS lsof does not expose flock ownership. Require the target to be
    // the only process with this private inode open, in addition to actual
    // nonblocking flock contention. Merely finding the target FD is weaker.
    const result = spawnSync("/usr/sbin/lsof", ["-nP", "-F", "pfinD", "--", file], {
      encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.stderr.trim()) return false;
    let pid = 0;
    type OpenDescriptor = { pid: number; dev?: string; ino?: string; name?: string };
    let descriptor: OpenDescriptor | null = null;
    const descriptors: OpenDescriptor[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line[0] === "p") { pid = Number(line.slice(1)); if (pid !== targetPid) return false; }
      if (line[0] === "f") { descriptor = { pid }; descriptors.push(descriptor); }
      if (descriptor && line[0] === "D") descriptor.dev = BigInt(line.slice(1)).toString();
      if (descriptor && line[0] === "i") descriptor.ino = line.slice(1);
      if (descriptor && line[0] === "n") descriptor.name = line.slice(1);
    }
    return descriptors.length > 0 && descriptors.every((entry) => entry.pid === targetPid
      && entry.dev === identity.dev && entry.ino === identity.ino && entry.name === file)
      && sameFile() && occupied() && sameFile();
  } catch { return false; }
}
