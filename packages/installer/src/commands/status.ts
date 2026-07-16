import kleur from "kleur";
import { join } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { readState, resolveMode, type InstallerState } from "../state.js";
import { locateCodex } from "../platform.js";
import { readHeaderHash } from "../asar.js";
import { getIntegrity } from "../integrity.js";
import { readFuses, FuseV1 } from "../fuses.js";
import { existsSync, readFileSync } from "node:fs";
import { hasCodexPlusPlusAsarMarker, readCodexVersion } from "./install.js";
import { describeUpdateMode, readUpdateMode } from "../update-mode.js";
import { parkedPayloadApp, payloadMetadataFile, readPayloadMetadata } from "../mode-transition.js";

export async function status(): Promise<void> {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);

  console.log(kleur.bold("codex-plusplus status"));
  console.log(`  user dir:     ${paths.root}`);
  console.log(`  tweaks dir:   ${paths.tweaks}`);
  console.log(`  log dir:      ${paths.logDir}`);
  console.log(`  safe mode:    ${readSafeMode(paths.configFile) ? kleur.yellow("enabled") : kleur.green("disabled")}`);
  console.log();

  if (!state) {
    console.log(kleur.yellow("Not installed. Run `tweakers install`."));
    return;
  }

  console.log(kleur.bold("install"));
  console.log(`  installed:    ${state.installedAt}`);
  console.log(`  version:      ${state.version}`);
  console.log(`  app root:     ${state.appRoot}`);
  console.log(`  codex ver:    ${state.codexVersion ?? "(unknown)"}`);
  if (state.codexChannel) console.log(`  channel:      ${state.codexChannel}`);
  if (state.codexBundleId) console.log(`  bundle id:    ${state.codexBundleId}`);
  console.log(`  fuse flipped: ${state.fuseFlipped}`);
  console.log(`  resigned:     ${state.resigned}`);
  if (state.signingMode) console.log(`  sign mode:    ${state.signingMode}`);
  if (state.signingIdentity) console.log(`  sign identity: ${state.signingIdentity}`);
  console.log(`  watcher:      ${state.watcher}`);
  console.log();

  let codex;
  try {
    codex = locateCodex(state.appRoot);
  } catch (e) {
    console.log(kleur.red(`Codex not found at recorded path: ${(e as Error).message}`));
    return;
  }

  const currentCodexVersion = readCodexVersion(codex.metaPath);
  console.log(kleur.bold("current app"));
  console.log(`  codex ver:    ${currentCodexVersion ?? "(unknown)"}`);
  console.log(`  channel:      ${codex.channel}`);
  if (codex.bundleId) console.log(`  bundle id:    ${codex.bundleId}`);
  const updateMode = readUpdateMode(paths.updateModeFile);
  if (updateMode) {
    console.log(`  update mode:  ${kleur.yellow(describeUpdateMode(updateMode))}`);
  }
  console.log();

  console.log(kleur.bold("integrity"));
  if (existsSync(codex.asarPath)) {
    const { headerHash } = readHeaderHash(codex.asarPath);
    const markerPresent = hasCodexPlusPlusAsarMarker(codex.asarPath);
    const mode = resolveMode(state, markerPresent);
    console.log(`  mode:         ${mode}${state.mode ? "" : kleur.dim(" (inferred)")}`);
    if (mode === "chatgpt") {
      const payloadMeta = readPayloadMetadata(payloadMetadataFile(paths.root));
      const parkedVersion = payloadMeta?.baseVersion
        ?? readCodexVersion(join(parkedPayloadApp(paths.root), "Contents", "Info.plist"));
      const report = describeChatgptModeAsar({
        headerHash,
        state,
        markerPresent,
        parkedPayloadVersion: parkedVersion,
        payloadPatchedAsarHash: payloadMeta?.patchedAsarHash ?? null,
      });
      const paint = report.tone === "green" ? kleur.green : report.tone === "yellow" ? kleur.yellow : kleur.red;
      console.log(`  current asar: ${headerHash.slice(0, 16)}…  ${paint(`(${report.label})`)}`);
    } else {
      const intact = headerHash === state.patchedAsarHash;
      console.log(
        `  current asar: ${headerHash.slice(0, 16)}…  ${
          intact ? kleur.green("(matches patched)") : kleur.red("(drift!)")
        }`,
      );
    }
    if (codex.metaPath && mode !== "chatgpt") {
      const plistEntry = getIntegrity(codex);
      console.log(
        `  plist hash:   ${plistEntry?.hash.slice(0, 16) ?? "(none)"}…  ${
          plistEntry?.hash === headerHash ? kleur.green("OK") : kleur.red("mismatch")
        }`,
      );
    }
  }
  if (existsSync(codex.electronBinary)) {
    try {
      const fuses = readFuses(codex.electronBinary);
      const v = fuses.fuses[FuseV1.EnableEmbeddedAsarIntegrityValidation];
      console.log(`  asar fuse:    ${v}`);
    } catch (e) {
      console.log(kleur.dim(`  fuses:        unreadable (${(e as Error).message})`));
    }
  }
}

export interface ChatgptModeAsarReport {
  label: string;
  tone: "green" | "yellow" | "red";
}

/**
 * ChatGPT-mode integrity verdict for the live asar, shared by status + doctor.
 * Pristine (matches the recorded original) is green; "drift!" is reserved for
 * a hash matching NEITHER the original nor the parked patched payload.
 */
export function describeChatgptModeAsar(input: {
  headerHash: string;
  state: Pick<InstallerState, "originalAsarHash" | "patchedAsarHash">;
  markerPresent: boolean;
  parkedPayloadVersion: string | null;
  payloadPatchedAsarHash: string | null;
}): ChatgptModeAsarReport {
  const parked = input.parkedPayloadVersion ?? "none";
  if (input.headerHash === input.state.originalAsarHash) {
    return { label: `pristine (ChatGPT mode; parked payload: ${parked})`, tone: "green" };
  }
  const matchesPatched =
    input.headerHash === input.state.patchedAsarHash ||
    (input.payloadPatchedAsarHash !== null && input.headerHash === input.payloadPatchedAsarHash);
  if (matchesPatched || input.markerPresent) {
    return {
      label: "patched while ChatGPT mode is recorded — run `tweakers mode status`",
      tone: "red",
    };
  }
  return {
    label: `differs from the recorded original — likely an official update; still unpatched (ChatGPT mode; parked payload: ${parked})`,
    tone: "yellow",
  };
}

function readSafeMode(configFile: string): boolean {
  if (!existsSync(configFile)) return false;
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as {
      codexPlusPlus?: { safeMode?: boolean };
    };
    return config.codexPlusPlus?.safeMode === true;
  } catch {
    return false;
  }
}
