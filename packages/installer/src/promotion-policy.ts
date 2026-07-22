import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  canonicalPromotionPolicyText,
  PROMOTION_POLICY_FILE_MAX_BYTES,
  PROMOTION_POLICY_HASH_DOMAIN,
} from "@therealityreport/tweakers-sdk";
import { targetUserOwnership } from "./ownership.js";

/** Semantic, bounded and no-follow policy proof used by installer expectations. */
export function fingerprintPromotionPolicyPath(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    const owner = targetUserOwnership();
    if (
      !before.isFile()
      || before.size <= 0
      || before.size > PROMOTION_POLICY_FILE_MAX_BYTES
      || (before.mode & 0o777) !== 0o600
      || (owner !== null && before.uid !== owner.uid)
    ) {
      throw new Error("Promotion policy state must be an owner-only bounded regular file");
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Promotion policy state changed while being read");
    }
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("Promotion policy state must be valid UTF-8");
    }
    const canonical = canonicalPromotionPolicyText(raw);
    return createHash("sha256").update(PROMOTION_POLICY_HASH_DOMAIN).update(canonical).digest("hex");
  } finally {
    closeSync(fd);
  }
}
