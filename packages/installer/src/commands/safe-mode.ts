import kleur from "kleur";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { readConfigFile, updateConfigFile } from "../config.js";

interface SafeModeOpts {
  on?: boolean;
  off?: boolean;
  status?: boolean;
}

interface TweakerConfig {
  tweaker?: {
    autoUpdate?: boolean;
    safeMode?: boolean;
    updateCheck?: unknown;
  };
  tweaks?: Record<string, { enabled?: boolean }>;
  tweakUpdateChecks?: Record<string, unknown>;
}

export function safeMode(opts: SafeModeOpts = {}): void {
  const paths = ensureUserPaths();
  const config = readConfigFile(paths.configFile) as TweakerConfig;
  const explicitActions = [opts.on === true, opts.off === true, opts.status === true].filter(Boolean).length;

  if (explicitActions > 1) {
    throw new Error("Choose only one of --on, --off, or --status");
  }

  if (opts.status === true) {
    printStatus(config.tweaker?.safeMode === true);
    return;
  }

  const enabled = opts.off === true ? false : true;
  updateConfigFile(paths.configFile, (current) => {
    const section = (current.tweaker ??= {}) as Record<string, unknown>;
    section.safeMode = enabled;
  });
  touchRuntimeReload(paths.tweaks);

  printStatus(enabled);
  if (enabled) {
    console.log(kleur.dim("All tweaks are disabled until safe mode is turned off."));
  } else {
    console.log(kleur.dim("Existing per-tweak enabled flags are preserved."));
  }
  console.log(kleur.dim("If Codex is already running, use Force Reload or restart if changes do not apply immediately."));
}

function touchRuntimeReload(tweaksDir: string): void {
  mkdirSync(tweaksDir, { recursive: true });
  writeFileSync(join(tweaksDir, ".tweaker-safe-mode-reload"), String(Date.now()), "utf8");
}

function printStatus(enabled: boolean): void {
  const label = enabled ? kleur.yellow("enabled") : kleur.green("disabled");
  console.log(`Tweakers safe mode: ${label}`);
}
