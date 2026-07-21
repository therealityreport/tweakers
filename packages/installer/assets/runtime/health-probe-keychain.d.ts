export declare const HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH = "use-mock-keychain";
export interface HealthProbeCommandLine {
    appendSwitch(name: string): void;
    hasSwitch(name: string): boolean;
}
/**
 * Keep a disposable macOS health process off the user's Keychain.
 *
 * Chromium's macOS build guidance prescribes --use-mock-keychain to avoid
 * Keychain access and its blocking dialogs. Electron requires Chromium
 * switches appended from the main script to be installed before app ready:
 * https://chromium.googlesource.com/chromium/src/+/main/docs/mac_build_instructions.md#avoiding-system-permissions-dialogs-after-each-build
 * https://www.electronjs.org/docs/latest/api/command-line-switches
 */
export declare function applyHealthProbeKeychainIsolation(input: {
    commandLine: HealthProbeCommandLine;
    healthCheckOnly: boolean;
    platform: NodeJS.Platform;
}): boolean;
