/**
 * App-mode switching: ChatGPT ⇄ Tweakers bundle swap, renderer-triggered.
 *
 * `/Applications/ChatGPT.app` alternates between two payloads: the pristine
 * OpenAI Developer-ID bundle ("chatgpt" mode) and the patched,
 * contained-signed bundle ("tweakers" mode). The switch itself — quitting the
 * app, swapping bundles, relaunching — is owned entirely by the installer CLI
 * (`tweakers mode <target> --yes`). The runtime's only job is to validate the
 * renderer's request and hand off to that CLI.
 *
 * Two invariants callers must uphold:
 * - The renderer shows its own confirmation BEFORE invoking this; nothing on
 *   this path prompts the user.
 * - The CLI must be started through the launchd-submit seam
 *   (`startInstalledCliWithLaunchd` in main.ts), never a plain child spawn:
 *   the helper has to survive this app quitting and the live bundle being
 *   swapped out from under it mid-flight.
 */
export type AppModeTarget = "chatgpt" | "tweakers";
export interface SwitchAppModeResult {
    ok: boolean;
    message?: string;
}
export interface SwitchAppModeDeps {
    /**
     * Mode of the live bundle hosting this runtime. In practice always
     * "tweakers" — the injected runtime does not exist inside the pristine
     * bundle — but the seam keeps the target validation honest and testable.
     */
    currentMode: AppModeTarget;
    /** Installer CLI path (same resolution as `codexpp:start-local-refresh`). */
    resolveCli: () => string;
    cliExists: (cli: string) => boolean;
    /**
     * launchd-submit seam (`startInstalledCliWithLaunchd`). Returns false when
     * the launchd submission fails.
     */
    startCliWithLaunchd: (cli: string, args: string[]) => boolean;
}
/** Strict payload shape: exactly `{ target: "chatgpt" | "tweakers" }`. */
export declare function parseSwitchAppModePayload(payload: unknown): AppModeTarget | null;
export declare function appModeLabel(mode: AppModeTarget): string;
export declare function switchAppMode(payload: unknown, deps: SwitchAppModeDeps): SwitchAppModeResult;
