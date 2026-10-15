import { spawnSync } from "node:child_process";

/** A timeout or truncated observation must never grant history-write permission. */
export function boundedOpenFileCensus(path: string): ReturnType<typeof spawnSync> {
  return spawnSync("/usr/sbin/lsof", ["-nP", "-F", "p", "+D", path], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000, maxBuffer: 8 * 1024 * 1024,
  });
}
