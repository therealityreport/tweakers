import kleur from "kleur";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { locateCodex } from "../platform.js";
import { readState, resolveMode } from "../state.js";
import { hasCodexPlusPlusAsarMarker } from "./install.js";

interface Opts {
  app?: string;
}

const PARKED_PATCHED_RE = /^Codex\.app\.patched-/;

export function pruneParkedPatchedApps(
  backupDir: string,
  keep = 1,
  deps: { readdir?: (dir: string) => string[]; removeDir?: (path: string) => void } = {},
): string[] {
  const readdir = deps.readdir ?? ((dir: string) => readdirSync(dir));
  const removeDir = deps.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  let names: string[];
  try { names = readdir(backupDir); } catch { return []; }
  const parked = names.filter((n) => PARKED_PATCHED_RE.test(n)).sort(); // ascending by timestamp
  const doomed = parked.slice(0, Math.max(0, parked.length - keep)); // remove all but the newest `keep`
  const removed: string[] = [];
  for (const name of doomed) {
    const full = join(backupDir, name);
    try { removeDir(full); removed.push(full); } catch { /* best-effort */ }
  }
  return removed;
}

/**
 * The legacy restore-then-let-Sparkle-run flow is superseded by the mode
 * toggle: its `Codex.app.patched-<ts>` parking is replaced by the payload
 * store under `<root>/mode/patched-payload`. In ChatGPT mode the official
 * Sparkle updater already runs natively (nothing to do); in Tweakers mode the
 * supported path is `tweakers mode chatgpt`.
 */
export async function updateCodex(opts: Opts = {}): Promise<void> {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);
  const codex = locateCodex(opts.app ?? state?.appRoot);
  if (codex.platform !== "darwin") {
    throw new Error("codex-plusplus update-codex is only needed on macOS/Sparkle installs.");
  }

  if (resolveMode(state, hasCodexPlusPlusAsarMarker(codex.asarPath)) === "chatgpt") {
    console.log(kleur.green("ChatGPT mode is active; the official updater manages updates natively."));
    console.log(kleur.dim("Nothing to restore — the live app is already the pristine official app."));
    return;
  }

  throw new Error(
    "Refusing to run update-chatgpt in Tweakers mode.\n" +
      "This flow is superseded by the mode toggle:\n" +
      `  1. Run ${kleur.cyan("tweakers mode chatgpt")} (parks the patched payload, restores the official app).\n` +
      "  2. Let the official ChatGPT updater run.\n" +
      `  3. Run ${kleur.cyan("tweakers mode tweakers")} to come back.`,
  );
}
