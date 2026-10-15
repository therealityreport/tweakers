import { createHmac, timingSafeEqual } from "node:crypto";
import { desktopAppToolsFingerprint, type DesktopAppToolsContextV1 } from "./desktop-app-tools";
import { isPlainRecord } from "./types";

export const NATIVE_DESKTOP_CONFIG_PROOF_V1 = "__tweakers_native_desktop_config_v1";
const unavailable = () => new Error("Native desktop tool configuration unavailable");
const maxBytes = 2 * 1024 * 1024;
function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw unavailable();
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (!isPlainRecord(value) || Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key))) throw unavailable();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
function signature(secret: Buffer, context: DesktopAppToolsContextV1, config: Record<string, unknown>): string {
  const serialized = canonical(config);
  if (Buffer.byteLength(serialized) > maxBytes) throw unavailable();
  return createHmac("sha256", secret).update("tweakers/native-main-builtins/v1\0").update(desktopAppToolsFingerprint(context)).update("\0").update(serialized).digest("hex");
}
/** Called only by the reviewed native main builder, before renderer composition. */
export function attestNativeDesktopConfigV1(secret: Buffer, context: DesktopAppToolsContextV1, config: unknown): Record<string, unknown> {
  if (!isPlainRecord(config) || Object.hasOwn(config, NATIVE_DESKTOP_CONFIG_PROOF_V1)) throw unavailable();
  // Native optional fields use undefined; sign their actual JSON wire shape.
  const serialized = JSON.stringify(config);
  if (Buffer.byteLength(serialized) > maxBytes) throw unavailable();
  const wire = JSON.parse(serialized) as Record<string, unknown>;
  if (!isPlainRecord(wire)) throw unavailable();
  const keys = Object.keys(wire).sort();
  if (keys.length > 128) throw unavailable();
  return { ...wire, [NATIVE_DESKTOP_CONFIG_PROOF_V1]: { version: 1, keys, mac: signature(secret, context, wire) } };
}
/** Detach only exact signed entries; every other override keeps normal policy checks. */
export function detachNativeDesktopConfigV1(secret: Buffer, context: DesktopAppToolsContextV1 | null, value: unknown): { config: Record<string, unknown>; native: Record<string, unknown> } {
  if (value === undefined || value === null) return { config: {}, native: {} };
  if (!isPlainRecord(value)) throw unavailable();
  const config = { ...value }, proof = config[NATIVE_DESKTOP_CONFIG_PROOF_V1];
  if (proof === undefined) return { config, native: {} };
  if (!context || !isPlainRecord(proof) || Object.keys(proof).sort().join() !== "keys,mac,version" || proof.version !== 1
    || !Array.isArray(proof.keys) || proof.keys.length > 128 || proof.keys.some(key => typeof key !== "string" || key === NATIVE_DESKTOP_CONFIG_PROOF_V1 || !Object.hasOwn(config, key))
    || new Set(proof.keys).size !== proof.keys.length || typeof proof.mac !== "string" || !/^[a-f0-9]{64}$/.test(proof.mac)) throw unavailable();
  const native = Object.fromEntries(proof.keys.map(key => [key, config[key]]));
  const expected = signature(secret, context, native);
  if (!timingSafeEqual(Buffer.from(proof.mac, "hex"), Buffer.from(expected, "hex"))) throw unavailable();
  for (const key of proof.keys) delete config[key];
  delete config[NATIVE_DESKTOP_CONFIG_PROOF_V1];
  // Snapshot the verified values so later request mutation cannot change them.
  return { config, native: JSON.parse(canonical(native)) as Record<string, unknown> };
}
