import kleur from "kleur";
import { join } from "node:path";
import { ensureUserPaths } from "../paths.js";
import { readState, resolveMode, type InstallerState } from "../state.js";
import { locateCodex } from "../platform.js";
import { readHeaderHash } from "../asar.js";
import { getIntegrity } from "../integrity.js";
import { readFuses, FuseV1 } from "../fuses.js";
import { existsSync, readFileSync } from "node:fs";
import { readAsarMarker, readCodexVersion } from "./install.js";
import { describeUpdateMode, readUpdateMode } from "../update-mode.js";
import { parkedPayloadApp, payloadMetadataFile, readPayloadMetadata } from "../mode-transition.js";
import { readConfigFile } from "../config.js";
import { collectDesktopUpdateDiagnostics } from "../desktop-update-diagnostics.js";
import { readRendererPatchRecord, type RendererPatchRecord } from "../renderer-patch-outcome.js";

export async function status(): Promise<void> {
  const paths = ensureUserPaths();
  const state = readState(paths.stateFile);

  console.log(kleur.bold("tweaker status"));
  console.log(`  user dir:     ${paths.root}`);
  console.log(`  tweaks dir:   ${paths.tweaks}`);
  console.log(`  log dir:      ${paths.logDir}`);
  console.log(`  safe mode:    ${readSafeMode(paths.configFile) ? kleur.yellow("enabled") : kleur.green("disabled")}`);
  console.log();

  const desktopUpdate = collectDesktopUpdateDiagnostics(paths);
  console.log(kleur.bold("desktop update"));
  console.log(`  phase:        ${desktopUpdate.receiptError ? "invalid" : desktopUpdate.receipt?.phase ?? "idle"}`);
  console.log(`  safe official:${desktopUpdate.receipt === null ? " (n/a)" : ` ${desktopUpdate.receipt.safeOfficialMode}`}`);
  console.log(`  resumable:    ${desktopUpdate.receipt?.resumable ?? false}`);
  console.log(`  blocking:     ${desktopUpdate.blocking}${desktopUpdate.stale ? " (stale)" : ""}`);
  console.log(`  receipt:      ${desktopUpdate.receiptPath}`);
  console.log(`  log:          ${desktopUpdate.logPath}`);
  if (desktopUpdate.receiptError) console.log(`  error:        ${kleur.red(desktopUpdate.receiptError)}`);
  console.log();

  if (!state) {
    console.log(kleur.yellow("Not installed. Run `tweaker install`."));
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
    const marker = readAsarMarker(codex.asarPath);
    const markerPresent = marker === "present";
    const mode = marker === "present"
      ? "tweakers"
      : marker === "absent"
        ? "chatgpt"
        : resolveMode(state, false);
    console.log(`  mode:         ${mode}${marker === "unreadable" ? kleur.dim(" (state fallback)") : kleur.dim(" (live)")}`);
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

  const coverage = describeRendererPatchCoverage(
    readRendererPatchRecord(patchedPayloadAsarPath(paths.root, codex.asarPath)),
    readCodexVersion(codex.metaPath ?? "") ?? null,
  );
  if (coverage) {
    const paint = coverage.tone === "green" ? kleur.green : kleur.yellow;
    console.log(`  renderer tweaks: ${paint(coverage.label)}`);
  }
}

/**
 * The archive that carries the patched payload's self-report: the live asar in
 * Tweakers mode, the parked payload in ChatGPT mode (where the live app is
 * pristine and has nothing to say about our patches).
 */
export function patchedPayloadAsarPath(userRoot: string, liveAsarPath: string): string {
  if (readAsarMarker(liveAsarPath) === "present") return liveAsarPath;
  return join(parkedPayloadApp(userRoot), "Contents", "Resources", "app.asar");
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
      label: "patched while ChatGPT mode is recorded — run `tweaker mode status`",
      tone: "red",
    };
  }
  return {
    label: `differs from the recorded original — likely an official update; still unpatched (ChatGPT mode; parked payload: ${parked})`,
    tone: "yellow",
  };
}

export interface RendererPatchCoverageReport {
  label: string;
  tone: "green" | "yellow";
}

/**
 * Optional-renderer-tweak verdict, shared by status + doctor + mode status.
 *
 * Returns null when the payload carries no record — a build that predates this
 * accounting never claimed anything, and warning about it would be a false
 * alarm rather than news.
 *
 * Deliberately two-toned. `not-applicable` is painted yellow alongside an
 * outright skip because from inside the bundle "upstream removed this feature"
 * and "we lost the ability to find it" are the same observation; only a human
 * can tell them apart, and they can only do that if we say something.
 */
export function describeRendererPatchCoverage(
  record: RendererPatchRecord | null,
  builtAgainstVersion: string | null,
): RendererPatchCoverageReport | null {
  if (!record || record.patches.length === 0) return null;
  const total = record.patches.length;
  const active = record.patches.filter(
    (patch) => patch.status === "patched" || patch.status === "already-patched",
  ).length;
  if (active === total) {
    return { label: `${total} of ${total} optional tweaks active`, tone: "green" };
  }

  const against = builtAgainstVersion ? ` on ${builtAgainstVersion}` : "";
  const inactive = record.patches
    .filter((patch) => patch.status !== "patched" && patch.status !== "already-patched")
    .map((patch) => `${shortRendererPatchName(patch.id)} (${patch.status}${against})`);
  return {
    label: `${active} of ${total} optional tweaks active — ${inactive.join(", ")}`,
    tone: "yellow",
  };
}

function shortRendererPatchName(id: string): string {
  return id.startsWith("renderer.") ? id.slice("renderer.".length) : id;
}

function readSafeMode(configFile: string): boolean {
  const config = readConfigFile(configFile) as { tweaker?: { safeMode?: boolean } };
  return config.tweaker?.safeMode === true;
}
