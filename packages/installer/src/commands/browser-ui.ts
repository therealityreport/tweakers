import kleur from "kleur";
import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import { locateCodex } from "../platform.js";
import { isCodexRunning, quitCodex } from "../alerts.js";

interface BrowserUiOpts {
  app?: string;
  port?: string | number;
  open?: boolean;
  keepWindow?: boolean;
  "keep-window"?: boolean;
}

const DEFAULT_PORT = 8765;
const DEFAULT_BUNDLE_ID = "com.openai.codex";
const PORTLESS_NAME = "tweakers";
const PORTLESS_URL = "https://tweakers.localhost/";

type CommandRunner = (command: string, args: string[], captureOutput?: boolean) => string;

export async function browserUi(opts: BrowserUiOpts = {}): Promise<void> {
  if (platform() !== "darwin") {
    throw new Error("tweaker browser is currently macOS-only.");
  }

  const codex = locateCodex(opts.app);
  const port = parsePort(opts.port, DEFAULT_PORT);
  const loopbackUrl = `http://127.0.0.1:${port}/`;
  const hideMainWindow = opts.keepWindow !== true && opts["keep-window"] !== true;
  const shouldOpen = opts.open !== false;

  console.log(`${kleur.dim("[1]")} Codex: ${kleur.cyan(codex.appRoot)}`);
  console.log(`${kleur.dim("[2]")} Portless: ${kleur.cyan(PORTLESS_URL)}`);
  preparePortlessBrowserUiRoute(port);

  if (isCodexRunning(codex.appRoot)) {
    console.log(`${kleur.dim("[3]")} Restarting Codex with browser UI enabled`);
    quitCodex(codex.appRoot);
  } else {
    console.log(`${kleur.dim("[3]")} Launching Codex with browser UI enabled`);
  }

  launchCodexBrowserHost(codex.bundleId ?? DEFAULT_BUNDLE_ID, port, hideMainWindow);
  await waitForBrowserUi(loopbackUrl);
  console.log(`${kleur.dim("[4]")} Browser UI: ${kleur.cyan(PORTLESS_URL)}`);

  if (shouldOpen) {
    execFileSync("open", [PORTLESS_URL], { stdio: "ignore" });
  }
}

/**
 * Keep the app-owned browser host on loopback while exposing its stable
 * operator URL through a static Portless alias. The alias intentionally does
 * not use --force: a conflicting live route must fail before Codex is
 * restarted rather than terminating or replacing another process.
 */
export function preparePortlessBrowserUiRoute(
  port: number,
  runCommand: CommandRunner = runBrowserUiCommand,
): string {
  try {
    runCommand("portless", ["proxy", "start", "--https", "-p", "443", "--tld", "localhost"]);

    const configuredUrl = new URL(
      runCommand("portless", ["get", PORTLESS_NAME, "--no-worktree"], true).trim(),
    ).toString();
    if (configuredUrl !== PORTLESS_URL) {
      throw new Error(
        `Portless is configured for ${configuredUrl}, but Tweakers requires ${PORTLESS_URL}. ` +
          "Stop the existing proxy and restart it with HTTPS on port 443 using the localhost TLD.",
      );
    }

    runCommand("portless", ["alias", PORTLESS_NAME, String(port)]);
    return PORTLESS_URL;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not prepare ${PORTLESS_URL} before launching browser host mode. ` +
        `Codex was not restarted. Ensure the global Portless CLI is installed and healthy. ${detail}`,
      { cause: error },
    );
  }
}

function runBrowserUiCommand(command: string, args: string[], captureOutput = false): string {
  if (captureOutput) {
    return execFileSync(command, args, { encoding: "utf8" });
  }
  execFileSync(command, args, { stdio: "inherit" });
  return "";
}

function launchCodexBrowserHost(bundleId: string, port: number, hideMainWindow: boolean): void {
  const args = [
    "--env",
    "TWEAKER_BROWSER_UI=1",
    "--env",
    `${[["CODEX", "PP"].join(""), "BROWSER_UI"].join("_")}=1`,
    "--env",
    `TWEAKER_BROWSER_UI_PORT=${port}`,
    "--env",
    `${[["CODEX", "PP"].join(""), "BROWSER_UI_PORT"].join("_")}=${port}`,
  ];
  if (hideMainWindow) {
    args.push("--env", "TWEAKER_BROWSER_UI_HIDE_MAIN=1");
    args.push("--env", `${[["CODEX", "PP"].join(""), "BROWSER_UI_HIDE_MAIN"].join("_")}=1`);
  }
  args.push("-b", bundleId);
  execFileSync("open", args, { stdio: "ignore" });
}

async function waitForBrowserUi(url: string): Promise<void> {
  const healthUrl = new URL("/tweaker/browser-ui/health", url).toString();
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < 20_000) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 750);
      try {
        const response = await fetch(healthUrl, { signal: controller.signal });
        if (response.ok) return;
        lastError = new Error(`HTTP ${response.status}`);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Tweakers browser UI at ${healthUrl}: ${String(lastError)}`);
}

function parsePort(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
