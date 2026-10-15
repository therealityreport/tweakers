"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_DESKTOP_CONFIG_PROOF_V1 = void 0;
exports.attestNativeDesktopConfigV1 = attestNativeDesktopConfigV1;
exports.detachNativeDesktopConfigV1 = detachNativeDesktopConfigV1;
const node_crypto_1 = require("node:crypto");
const desktop_app_tools_1 = require("./desktop-app-tools");
const types_1 = require("./types");
exports.NATIVE_DESKTOP_CONFIG_PROOF_V1 = "__tweakers_native_desktop_config_v1";
const unavailable = () => new Error("Native desktop tool configuration unavailable");
const maxBytes = 2 * 1024 * 1024;
function canonical(value, depth = 0) {
    if (depth > 32)
        throw unavailable();
    if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number" && Number.isFinite(value))
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).some(key => ["__proto__", "constructor", "prototype"].includes(key)))
        throw unavailable();
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
function signature(secret, context, config) {
    const serialized = canonical(config);
    if (Buffer.byteLength(serialized) > maxBytes)
        throw unavailable();
    return (0, node_crypto_1.createHmac)("sha256", secret).update("tweakers/native-main-builtins/v1\0").update((0, desktop_app_tools_1.desktopAppToolsFingerprint)(context)).update("\0").update(serialized).digest("hex");
}
/** Called only by the reviewed native main builder, before renderer composition. */
function attestNativeDesktopConfigV1(secret, context, config) {
    if (!(0, types_1.isPlainRecord)(config) || Object.hasOwn(config, exports.NATIVE_DESKTOP_CONFIG_PROOF_V1))
        throw unavailable();
    // Native optional fields use undefined; sign their actual JSON wire shape.
    const serialized = JSON.stringify(config);
    if (Buffer.byteLength(serialized) > maxBytes)
        throw unavailable();
    const wire = JSON.parse(serialized);
    if (!(0, types_1.isPlainRecord)(wire))
        throw unavailable();
    const keys = Object.keys(wire).sort();
    if (keys.length > 128)
        throw unavailable();
    return { ...wire, [exports.NATIVE_DESKTOP_CONFIG_PROOF_V1]: { version: 1, keys, mac: signature(secret, context, wire) } };
}
/** Detach only exact signed entries; every other override keeps normal policy checks. */
function detachNativeDesktopConfigV1(secret, context, value) {
    if (value === undefined || value === null)
        return { config: {}, native: {} };
    if (!(0, types_1.isPlainRecord)(value))
        throw unavailable();
    const config = { ...value }, proof = config[exports.NATIVE_DESKTOP_CONFIG_PROOF_V1];
    if (proof === undefined)
        return { config, native: {} };
    if (!context || !(0, types_1.isPlainRecord)(proof) || Object.keys(proof).sort().join() !== "keys,mac,version" || proof.version !== 1
        || !Array.isArray(proof.keys) || proof.keys.length > 128 || proof.keys.some(key => typeof key !== "string" || key === exports.NATIVE_DESKTOP_CONFIG_PROOF_V1 || !Object.hasOwn(config, key))
        || new Set(proof.keys).size !== proof.keys.length || typeof proof.mac !== "string" || !/^[a-f0-9]{64}$/.test(proof.mac))
        throw unavailable();
    const native = Object.fromEntries(proof.keys.map(key => [key, config[key]]));
    const expected = signature(secret, context, native);
    if (!(0, node_crypto_1.timingSafeEqual)(Buffer.from(proof.mac, "hex"), Buffer.from(expected, "hex")))
        throw unavailable();
    for (const key of proof.keys)
        delete config[key];
    delete config[exports.NATIVE_DESKTOP_CONFIG_PROOF_V1];
    // Snapshot the verified values so later request mutation cannot change them.
    return { config, native: JSON.parse(canonical(native)) };
}
//# sourceMappingURL=native-desktop-config.js.map