/** Read-only observation of processes whose executable command starts in the exact app tree. */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function observeExactTargetProcesses(target: string): Array<{ pid: number; ppid: number; command: string }> {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("Unable to inspect the exact Tweakers target process before promotion.");
  }
  const exactRoot = `${resolve(target)}/`;
  return `${result.stdout ?? ""}`.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && match[3]!.startsWith(exactRoot) ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : [];
  });
}

