/**
 * App-mode switching: ChatGPT ⇄ Tweakers bundle swap, renderer-triggered.
 *
 * `/Applications/ChatGPT.app` alternates between two payloads: the pristine
 * OpenAI Developer-ID bundle ("chatgpt" mode) and the patched,
 * contained-signed bundle ("tweakers" mode). The switch itself — quitting the
 * app, swapping bundles, relaunching — is owned entirely by the installer CLI
 * (`tweaker mode <target> --yes`). The runtime's only job is to validate the
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
  /** Installer CLI path (same resolution as `tweaker:start-local-refresh`). */
  resolveCli: () => string;
  cliExists: (cli: string) => boolean;
  /**
   * launchd-submit seam (`startInstalledCliWithLaunchd`). Returns false when
   * the launchd submission fails.
   */
  startCliWithLaunchd: (cli: string, args: string[]) => boolean;
}

/** Strict payload shape: exactly `{ target: "chatgpt" | "tweakers" }`. */
export function parseSwitchAppModePayload(payload: unknown): AppModeTarget | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = Object.keys(payload as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "target") return null;
  const target = (payload as { target: unknown }).target;
  return target === "chatgpt" || target === "tweakers" ? target : null;
}

export function appModeLabel(mode: AppModeTarget): string {
  return mode === "chatgpt" ? "ChatGPT App" : "Tweakers";
}

export function switchAppMode(payload: unknown, deps: SwitchAppModeDeps): SwitchAppModeResult {
  const target = parseSwitchAppModePayload(payload);
  if (!target) {
    return { ok: false, message: 'Invalid app mode request; expected { target: "chatgpt" | "tweakers" }.' };
  }
  if (target === deps.currentMode) {
    return { ok: false, message: `The app is already in ${appModeLabel(target)} mode.` };
  }
  const cli = deps.resolveCli();
  if (!deps.cliExists(cli)) {
    return { ok: false, message: "Tweakers installer CLI is unavailable. Run the installer once, then try again." };
  }
  if (!deps.startCliWithLaunchd(cli, ["mode", target, "--yes"])) {
    return { ok: false, message: "Could not start the mode-switch helper. Check the Tweakers log for details." };
  }
  return { ok: true, message: `Switching to ${appModeLabel(target)}; the app will quit and relaunch.` };
}
