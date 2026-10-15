import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readConfigFile } from "./config.js";
import { readDoctorIndependentInputs, inspectIndependentDoctor, type DoctorIndependentInputs } from "./doctor-independent.js";
import { verifiedDoctorManagerLauncher } from "./doctor-actions.js";
import type { RepairOutcome } from "./commands/repair.js";

interface NativeUpdateWatcherPort {
  enabled(root: string): boolean;
  inputs(root: string): DoctorIndependentInputs;
  settle(): Promise<void>;
  submit(root: string, build: string): Promise<void>;
}
const production: NativeUpdateWatcherPort = {
  enabled: root => (readConfigFile(join(root, "config.json")) as {tweaker?: {autoUpdate?: boolean}}).tweaker?.autoUpdate !== false,
  inputs: readDoctorIndependentInputs,
  settle: () => delay(1500),
  async submit(root, build) {
    const report = await inspectIndependentDoctor(root);
    const launcher = verifiedDoctorManagerLauncher(root);
    execFileSync(launcher, ["doctor-action", "--request-id", randomUUID(), "--json"], {
      encoding: "utf8", env: {}, timeout: 120_000, maxBuffer: 32 * 1024 * 1024,
      input: JSON.stringify({schemaVersion: 1, action: "scan", scanTrigger: "available_update",
        availableUpdateBuild: build, fingerprint: report.fingerprint}),
    });
  },
};

/** Reuse the existing watcher and sealed Doctor scan. Never quit or open a desktop.
 * Doctor coalesces this exact build signal and retains failed/recovery work.
 * Replacement remains behind the existing candidate approval and closed-admission gates.
 */
export async function scanIndependentNativeUpdateFromWatcher(root: string,
  port: NativeUpdateWatcherPort = production): Promise<RepairOutcome> {
  if (!port.enabled(root)) return {status: "skipped", reason: "automatic-updates-disabled"};
  const before = port.inputs(root);
  if (!before.nativeIdentity || !/^[0-9]+$/.test(before.nativeBuild ?? "") || !/^[0-9]+$/.test(before.build)) {
    return {status: "deferred", reason: "native-update-source-unavailable"};
  }
  if (BigInt(before.nativeBuild!) <= BigInt(before.build)) return {status: "skipped", reason: "native-update-current"};
  await port.settle();
  const after = port.inputs(root);
  if (after.nativeIdentity !== before.nativeIdentity || after.nativeBuild !== before.nativeBuild
    || after.nativeVersion !== before.nativeVersion || after.installedIdentity !== before.installedIdentity) {
    return {status: "deferred", reason: "native-update-still-changing"};
  }
  await port.submit(root, before.nativeBuild!);
  return {status: "deferred", reason: "independent-doctor-review"};
}
