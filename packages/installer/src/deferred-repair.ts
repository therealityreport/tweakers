import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { chownForTargetUser } from "./ownership.js";

export interface DeferredRepair {
  reason: "signing-unavailable";
  codexVersion: string | null;
  at: string;
}

export function readDeferredRepair(path: string): DeferredRepair | null {
  if (!existsSync(path)) return null;
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as Partial<DeferredRepair>;
    if (
      marker.reason !== "signing-unavailable" ||
      (typeof marker.codexVersion !== "string" && marker.codexVersion !== null) ||
      typeof marker.at !== "string"
    ) {
      return null;
    }
    return marker as DeferredRepair;
  } catch {
    return null;
  }
}

export function writeDeferredRepair(path: string, marker: DeferredRepair): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  chownForTargetUser(path);
}

export function clearDeferredRepair(path: string): void {
  rmSync(path, { force: true });
}
