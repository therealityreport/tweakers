import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, existsSync, lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readRouterLaunchSelection } from "./config";
import { readAccountsBrokerSecret, reserveAccountsBrokerSocket } from "./broker-socket";
import { readAndPreflightNativeHistorySourceStaticV1 } from "./native-history";
import { readSharedNativeModeV1 } from "./shared-native-mode";
import { writePrivateJsonAtomicBounded } from "./state-store";
import { readNativeAuthPrivateFileV1 } from "./native-auth-binding";
import { PERSISTENT_IDENTITIES_FILE, PERSISTENT_IDENTITIES_JOURNAL, preparePersistentIdentityGeneration,
  publishPersistentIdentityGeneration, restorePriorPersistentIdentityGeneration, readPersistentIdentityGeneration, validatePersistentIdentityProposal, type PreparedPersistentIdentities } from "./persistent-directory-identity";

export interface DoctorStorageInspection {
  state: "ready" | "repairable" | "blocked" | "not_applicable";
  reason: string;
  fingerprint: string;
  legacyVolumeUnproven: boolean;
}
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function pendingRecovery(root: string): boolean {
  if (["enrollment-materialization.v1.json", "shared-native-mode-transition.v1.json", "shared-native-resolver-transition.v1.json",
    "shared-account-config/shared-source-rebase-intent.v1.json"].some(name => existsSync(join(root, name)))) return true;
  const accounts = join(root, "accounts");
  if (!existsSync(accounts)) return false;
  if (!lstatSync(accounts).isDirectory() || lstatSync(accounts).isSymbolicLink()) return true;
  return readdirSync(accounts).some(name => ["config-materialization-intent.v1.json", "plugin-projection-intent.v1.json", "native-initial-capture-intent.v1.json"]
    .some(file => existsSync(join(accounts, name, file))));
}
function inspectWithSecret(root: string, secret: Buffer): { report: DoctorStorageInspection; proposal?: PreparedPersistentIdentities } {
  const files = ["account-router-config.json", "native-history-source.v1.json", "native-auth-binding.v1.json", "shared-native-mode.v1.json", "native-history-extensions.v1.json", PERSISTENT_IDENTITIES_FILE, PERSISTENT_IDENTITIES_JOURNAL];
  const input = files.map(name => ({ name, fingerprint: existsSync(join(root, name)) ? hash(readNativeAuthPrivateFileV1(join(root, name)).toString("base64")) : null }));
  const base = { fingerprint: hash(input), legacyVolumeUnproven: false };
  const config = readRouterLaunchSelection(join(root, "account-router-config.json")).config;
  if (!config || config.schemaVersion !== 3) return { report: { ...base, state: "blocked", reason: "invalid_config" } };
  if (!existsSync(join(root, "native-history-source.v1.json"))) return { report: { ...base, state: "not_applicable", reason: "legacy_storage" } };
  if (pendingRecovery(root)) return { report: { ...base, state: "blocked", reason: "pending_metadata_recovery" } };
  const existing = readPersistentIdentityGeneration(root, secret);
  let failureReason = "storage_identity_invalid";
  const verify = () => {
    const native = readAndPreflightNativeHistorySourceStaticV1(root, config, secret);
    if (native.state !== "ready") { failureReason = native.state === "invalid" ? native.reason : "storage_identity_invalid"; return false; }
    return readSharedNativeModeV1({ stateRoot: root, secret, binding: native.binding }).state !== "blocked";
  };
  let proposal: PreparedPersistentIdentities;
  try { proposal = preparePersistentIdentityGeneration({ stateRoot: root, secret, verify, allowLegacyDeviceChange: true }); }
  catch { return { report: { ...base, state: "blocked", reason: failureReason } }; }
  const fingerprint = hash({ input, anchors: proposal.next.anchors });
  if (existsSync(join(root, PERSISTENT_IDENTITIES_JOURNAL))) {
    try { proposal = validatePersistentIdentityProposal(root, secret, JSON.parse(readNativeAuthPrivateFileV1(join(root, PERSISTENT_IDENTITIES_JOURNAL)).toString("utf8"))); }
    catch { return { report: { fingerprint, state: "blocked", reason: "identity_repair_journal_invalid", legacyVolumeUnproven: false } }; }
    return { report: { fingerprint, state: "repairable", reason: "identity_repair_incomplete", legacyVolumeUnproven: existing === null }, proposal };
  }
  if (existing && JSON.stringify(existing.document.anchors) === JSON.stringify(proposal.next.anchors) && verify()) return { report: { fingerprint, state: "ready", reason: "persistent_identity_valid", legacyVolumeUnproven: false } };
  return { report: { fingerprint, state: "repairable", reason: verify() ? "legacy_identity_upgrade" : "device_number_changed", legacyVolumeUnproven: true }, proposal };
}

/** No mkdir, chmod, reservation, agent work, or credential/history writes. */
export function inspectNativeStorageIdentitiesAtRoot(root: string): DoctorStorageInspection {
  let secret: Buffer | null = null;
  try {
    secret = readAccountsBrokerSecret(root);
    if (!secret) return { state: "blocked", reason: "authentication_binding_unavailable", fingerprint: hash({ root, missing: true }), legacyVolumeUnproven: false };
    return inspectWithSecret(root, secret).report;
  } catch { return { state: "blocked", reason: "storage_metadata_invalid", fingerprint: hash({ root, invalid: true }), legacyVolumeUnproven: false }; }
  finally { secret?.fill(0); }
}

/** Explicit metadata-only repair; an active broker retains its owner-election socket. */
export async function repairNativeStorageIdentitiesAtRoot(root: string, expectedFingerprint: string): Promise<DoctorStorageInspection> {
  const secret = readAccountsBrokerSecret(root);
  if (!secret) throw new Error("Authentication binding unavailable");
  let reservation: Awaited<ReturnType<typeof reserveAccountsBrokerSocket>> | undefined;
  try {
    reservation = await reserveAccountsBrokerSocket({ root, secret });
    const inspected = inspectWithSecret(root, secret);
    if (inspected.report.fingerprint !== expectedFingerprint || inspected.report.state !== "repairable" || !inspected.proposal) throw new Error("Doctor storage repair evidence changed");
    const journalPath = join(root, PERSISTENT_IDENTITIES_JOURNAL);
    const proposal = inspected.proposal;
    if (!existsSync(journalPath)) writePrivateJsonAtomicBounded(root, PERSISTENT_IDENTITIES_JOURNAL, proposal, 256 * 1024);
    const fingerprints = ["native-history-source.v1.json", "native-auth-binding.v1.json", "shared-native-mode.v1.json", "native-history-extensions.v1.json"]
      .filter(name => existsSync(join(root, name))).map(name => [name, hash(readFileSync(join(root, name)).toString("base64"))] as const);
    publishPersistentIdentityGeneration(root, secret, proposal);
    const config = readRouterLaunchSelection(join(root, "account-router-config.json")).config;
    if (!config) throw new Error("Doctor repair config changed");
    const native = readAndPreflightNativeHistorySourceStaticV1(root, config, secret);
    if (native.state !== "ready" || readSharedNativeModeV1({ stateRoot: root, secret, binding: native.binding }).state === "blocked"
      || fingerprints.some(([name, fingerprint]) => fingerprint !== hash(readFileSync(join(root, name)).toString("base64")))) {
      restorePriorPersistentIdentityGeneration(root, secret, proposal);
      throw new Error("Doctor repair postcondition failed; prior generation restored and recovery journal retained");
    }
    unlinkSync(journalPath);
    const directory = openSync(root, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
    return inspectWithSecret(root, secret).report;
  } finally { await reservation?.close(); secret.fill(0); }
}
