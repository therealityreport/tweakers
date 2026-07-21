"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH = void 0;
exports.applyHealthProbeKeychainIsolation = applyHealthProbeKeychainIsolation;
exports.HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";
/**
 * Keep a disposable macOS health process off the user's Keychain.
 *
 * Chromium's macOS build guidance prescribes --use-mock-keychain to avoid
 * Keychain access and its blocking dialogs. Electron requires Chromium
 * switches appended from the main script to be installed before app ready:
 * https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md#avoiding-system-permissions-dialogs-after-each-build
 * https://www.electronjs.org/docs/latest/api/command-line-switches
 */
function applyHealthProbeKeychainIsolation(input) {
    if (!input.healthCheckOnly || input.platform !== "darwin")
        return false;
    if (!input.commandLine.hasSwitch(exports.HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH)) {
        input.commandLine.appendSwitch(exports.HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH);
    }
    if (!input.commandLine.hasSwitch(exports.HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH)) {
        throw new Error("health-only Electron process could not enable mock Keychain isolation");
    }
    return true;
}
//# sourceMappingURL=health-probe-keychain.js.map