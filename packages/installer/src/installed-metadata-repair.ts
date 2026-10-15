import { createHash } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fingerprintVariantGeneration, type VariantGenerationFingerprint } from "./variant-generation.js";

const FILES = ["Contents/Info.plist", "Contents/MacOS/ChatGPT", "Contents/_CodeSignature/CodeResources"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface InstalledMetadataRepairBinding {
  root: string; variantRoot: string; target: string; promotionId: string;
  original: VariantGenerationFingerprint; inode: number;
}
interface MetadataRepairReceipt {
  version: 1; promotionId: string; target: string; repairRoot: string;
  promotionSha256: string; activeReceiptSha256: string;
  manifestSha256: string; repairReceiptSha256: string;
  inode: number; before: VariantGenerationFingerprint; after: VariantGenerationFingerprint;
  files: Array<{ name: string; before: string; after: string }>;
}

function bytes(path: string): Buffer {
  if (realpathSync(path) !== resolve(path)) throw new Error("Metadata repair evidence must be canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd);
    if (!a.isFile() || a.nlink !== 1 || a.uid !== process.getuid?.() || (a.mode & 0o022)) throw new Error("Unsafe metadata repair evidence");
    const value = readFileSync(fd), b = fstatSync(fd), c = lstatSync(path);
    if (a.dev !== b.dev || a.ino !== b.ino || a.ctimeMs !== b.ctimeMs || a.size !== b.size
      || a.dev !== c.dev || a.ino !== c.ino) throw new Error("Metadata repair evidence changed during inspection");
    return value;
  } finally { closeSync(fd); }
}

export function installedMetadataRepairPath(binding: InstalledMetadataRepairBinding): string {
  if (!/^[a-f0-9-]{36}$/.test(binding.promotionId)) throw new Error("Invalid metadata repair promotion");
  return join(binding.variantRoot, "transactions/installed-metadata-repair", `${binding.promotionId}.json`);
}

/** Reconstruct the original complete seal using exactly the documented backups. */
export function prepareInstalledMetadataRepair(binding: InstalledMetadataRepairBinding, repairRoot: string): MetadataRepairReceipt {
  if (dirname(repairRoot) !== join(binding.root, "repairs") || !/^\d{8}T\d{6}Z-codex-alias$/.test(repairRoot.split("/").at(-1)!)) throw new Error("Metadata repair backup is outside the documented repair root");
  const activeBytes = bytes(join(binding.variantRoot, "transactions/variant-promotion/active.json"));
  const promotionBytes = bytes(join(binding.variantRoot, "transactions/variant-promotion", `${binding.promotionId}.json`));
  const active = JSON.parse(activeBytes.toString()), promotion = JSON.parse(promotionBytes.toString());
  const app = active.entries?.find((row: { name: string }) => row.name === "app");
  const promotedApp = promotion.entries?.find((row: { name: string }) => row.name === "app");
  if (active.id !== binding.promotionId || active.userRoot !== binding.variantRoot || active.target !== binding.target
    || promotion.id !== binding.promotionId || promotion.userRoot !== binding.variantRoot || promotion.target !== binding.target
    || promotion.phase !== "committed" || app?.path !== binding.target || promotedApp?.destination !== binding.target
    || !same(app.fingerprint, binding.original) || !same(promotedApp.desired, binding.original)
    || !same(promotion.activeReceipt?.expected, active)) throw new Error("Metadata repair is not bound to the committed promotion");
  const manifestBytes = bytes(join(repairRoot, "manifest-before.json")), repairBytes = bytes(join(repairRoot, "receipt.json"));
  const manifest = JSON.parse(manifestBytes.toString()), repair = JSON.parse(repairBytes.toString());
  if (!same(Object.keys(manifest.files ?? {}).sort(), [...FILES].sort()) || repair.app !== binding.target
    || repair.backup !== join(repairRoot, "before") || !same(repair.removedAlternateNames, ["Codex"])
    || !Number.isFinite(Date.parse(repair.completedAt)) || repair.signatureVerified !== true || repair.sameCertificate !== true
    || repair.sameSigningRequirementsAndEntitlements !== true || repair.officialAppUnchanged !== true) throw new Error("The documented alias repair does not verify");
  const replacements = new Map<string, string>();
  const files = FILES.map(name => {
    const backup = join(repairRoot, "before", name), before = digest(bytes(backup)), after = digest(bytes(join(binding.target, name)));
    if (manifest.files[name] !== before) throw new Error("Metadata repair backup changed");
    replacements.set(name, backup);
    return { name, before, after };
  });
  const identity = lstatSync(binding.target);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.ino !== binding.inode) throw new Error("Metadata repair app inode changed");
  if (!same(fingerprintVariantGeneration(binding.target, replacements), binding.original)) throw new Error("Metadata repair has unrelated app changes");
  const after = fingerprintVariantGeneration(binding.target), settled = lstatSync(binding.target);
  if (identity.dev !== settled.dev || identity.ino !== settled.ino || identity.ctimeMs !== settled.ctimeMs) throw new Error("Metadata repair app changed during inspection");
  return { version: 1, promotionId: binding.promotionId, target: binding.target, repairRoot,
    promotionSha256: digest(promotionBytes), activeReceiptSha256: digest(activeBytes),
    manifestSha256: digest(manifestBytes), repairReceiptSha256: digest(repairBytes), inode: identity.ino,
    before: binding.original, after, files };
}

/** Read-only recovery validates backups, immutable parent receipts, content and inode. */
export function verifyInstalledMetadataRepair(binding: InstalledMetadataRepairBinding): VariantGenerationFingerprint {
  const path = installedMetadataRepairPath(binding), recorded = JSON.parse(bytes(path).toString()) as MetadataRepairReceipt;
  const current = prepareInstalledMetadataRepair(binding, recorded.repairRoot);
  if (!same(recorded, current)) throw new Error("Installed metadata repair chain changed");
  return current.after;
}

/** Caller holds the promotion lease. Publish only after the full fallback checks pass. */
export function recordInstalledMetadataRepair(binding: InstalledMetadataRepairBinding, repairRoot: string, verifyInstallation: () => void): VariantGenerationFingerprint {
  const path = installedMetadataRepairPath(binding);
  if (existsSync(path)) { verifyInstallation(); return verifyInstalledMetadataRepair(binding); }
  const prepared = prepareInstalledMetadataRepair(binding, repairRoot);
  verifyInstallation();
  if (!same(prepared, prepareInstalledMetadataRepair(binding, repairRoot))) throw new Error("Metadata repair changed before publication");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const directory=lstatSync(dirname(path));
  if (realpathSync(dirname(path)) !== dirname(path) || directory.uid !== process.getuid?.() || (directory.mode & 0o077)) throw new Error("Metadata repair journal directory is not owner-private");
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(prepared)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  // A hard-link publishes atomically without replacing an existing receipt.
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
  const parent = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return verifyInstalledMetadataRepair(binding);
}
