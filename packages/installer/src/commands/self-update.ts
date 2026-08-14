import { createHash } from "node:crypto";
import kleur from "kleur";
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { extract as extractTar } from "tar";
import { ensureUserPaths } from "../paths.js";
import { TWEAKER_VERSION, compareSemver } from "../version.js";
import { describeInstallationSource, findSourceRoot } from "../source-root.js";
import { ensureManagedRuntime, hasReleaseProvenance, managedSourceRoot, writeReleaseProvenance } from "../managed-runtime.js";
import {
  readSelfUpdateState,
  type SelfUpdateChannel,
  type SelfUpdateState,
  writeSelfUpdateState,
} from "../self-update-state.js";
import { readConfigFile } from "../config.js";
import { LEGACY_REF_ENV, LEGACY_REPO_ENV } from "../legacy-compat.js";
import { assertInstallerUpdateQuarantineClear } from "../protected-update-quarantine.js";

interface Opts {
  repo?: string;
  ref?: string;
  repair?: boolean;
  quiet?: boolean;
  watcher?: boolean;
  force?: boolean;
}

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface ParsedPrereleaseSemver {
  core: readonly [bigint, bigint, bigint];
  prerelease: string[];
}

interface RuntimeConfig {
  tweaker?: {
    autoUpdate?: boolean;
    updateChannel?: SelfUpdateChannel;
    updateRepo?: string;
    updateRef?: string;
  };
}

interface UpdateTarget {
  ref: string;
  version: string | null;
  releaseUrl: string | null;
  source: "explicit-ref" | "latest-release" | "git-fast-forward";
  channel: SelfUpdateChannel;
}

const here = dirname(fileURLToPath(import.meta.url));
const WATCHER_SELF_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const COMMAND_OUTPUT_TAIL_CHARS = 8_000;
const NO_PUBLISHED_STABLE_RELEASE_PREFIX = "No published GitHub release found for ";
const NO_PUBLISHED_CHANNEL_RELEASE_PREFIX = "No published releases found for ";

interface RunOptions {
  quiet?: boolean;
}

export interface CommandResult {
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export const DEFAULT_UPDATE_REPO = "therealityreport/tweakers";
const REPO_ALLOWLIST = /^[\w.-]+\/[\w.-]+$/;

/**
 * Resolve the GitHub repo to self-update from.
 * - Interactive `--repo <x>` may override, but only when it passes the allowlist.
 * - The unattended watcher is pinned to the compiled default and ignores env/config.
 * - Interactive updates without `--repo` may fall back to allowlisted env/config values.
 */
export function resolveUpdateRepo(
  opts: { repo?: string; watcher?: boolean },
  config: { updateRepo?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (opts.repo) {
    if (!REPO_ALLOWLIST.test(opts.repo)) {
      throw new Error(`Refusing self-update repo "${opts.repo}": not an owner/name slug`);
    }
    return opts.repo;
  }
  if (opts.watcher) return DEFAULT_UPDATE_REPO;
  const candidate = env.TWEAKER_REPO ?? env[LEGACY_REPO_ENV] ?? config.updateRepo;
  if (candidate && REPO_ALLOWLIST.test(candidate)) return candidate;
  return DEFAULT_UPDATE_REPO;
}

export async function selfUpdate(opts: Opts = {}): Promise<void> {
  const paths = ensureUserPaths();
  assertInstallerUpdateQuarantineClear(paths.root, "self-update");
  const config = readRuntimeConfig(paths.configFile);
  const repo = resolveUpdateRepo(opts, config);
  const developmentSourceRoot = findSourceRoot(here);
  const sourceRoot = managedSourceRoot(paths.root);
  ensureManagedRuntime(developmentSourceRoot, paths.root);
  const parent = dirname(sourceRoot);
  const work = mkdtempSync(join(tmpdir(), "tweaker-update-"));
  const archive = join(work, "source.tar.gz");
  const next = join(work, "source");
  const previous = `${sourceRoot}.previous`;
  let target: UpdateTarget | null = null;

  try {
    try {
      if (opts.watcher && config.autoUpdate === false) {
        writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
          status: "disabled",
          repo,
          channel: config.updateChannel ?? "stable",
          sourceRoot,
        }));
        log(opts, "Tweakers auto-update is disabled; running repair only.");
        runRepairIfRequested(opts, sourceRoot, parent);
        return;
      }

      if (opts.watcher && !opts.force && !shouldRunWatcherSelfUpdate(paths.selfUpdateStateFile)) {
        log(opts, "Tweakers release check skipped; running repair only.");
        runRepairIfRequested(opts, sourceRoot, parent);
        return;
      }

      writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
        status: "checking",
        repo,
        channel: config.updateChannel ?? "stable",
        sourceRoot,
      }));

      try {
        target = await resolveUpdateTarget(repo, opts, config);
      } catch (error) {
        if (!isNoPublishedReleaseError(error)) throw error;
        writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
          status: "up-to-date",
          repo,
          channel: config.updateChannel ?? "stable",
          sourceRoot,
        }));
        log(opts, "No published Tweakers release yet; keeping the installed managed runtime.");
        runRepairIfRequested(opts, sourceRoot, parent);
        return;
      }
      const releaseAlreadyInstalled = hasReleaseProvenance(sourceRoot, target.ref);
      if (!shouldDownloadSelfUpdate(TWEAKER_VERSION, target.ref, opts.force === true || !releaseAlreadyInstalled)) {
        writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
          status: "up-to-date",
          repo,
          channel: target.channel,
          sourceRoot,
          target,
        }));
        log(opts, `Tweakers is already up to date (${TWEAKER_VERSION}).`);
        runRepairIfRequested(opts, sourceRoot, parent);
        return;
      }

      const assetBase = `https://github.com/${repo}/releases/download/${encodeURIComponent(target.ref)}`;
      const sumsText = await fetchReleaseText(`${assetBase}/SHA256SUMS`);
      if (sumsText) {
        const assetName = `tweakers-${target.ref}.tar.gz`;
        log(opts, `Downloading verified release asset ${assetName} from ${assetBase}...`);
        await download(`${assetBase}/${encodeURIComponent(assetName)}`, archive);
        verifyChecksum(await sha256File(archive), parseSha256Sums(sumsText), assetName);
        mkdirSync(next, { recursive: true });
        await extractTar({ file: archive, cwd: next, strip: 1 });
      } else {
        log(opts, `No SHA256SUMS asset for ${target.ref}; falling back to source tarball (unverified).`);
        await download(`https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(target.ref)}`, archive);
        mkdirSync(next, { recursive: true });
        await extractTar({ file: archive, cwd: next, strip: 1 });
      }

      verifyDownloadedVersion(next, target);
      installDependencies(next, opts);
      run(npmCommand(), ["run", "build"], next, opts);

      rmSync(previous, { recursive: true, force: true });
      if (existsSync(sourceRoot)) renameSync(sourceRoot, previous);
      renameSync(next, sourceRoot);
      ensureCliExecutable(sourceRoot);
      refreshMovedWorkspaceLinks(sourceRoot);
      writeReleaseProvenance(sourceRoot, target.ref);
      writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
        status: "updated",
        repo,
        channel: target.channel,
        sourceRoot,
        target,
      }));
      log(opts, kleur.green(`Updated tweaker source at ${sourceRoot}`));

      try {
        runRepairIfRequested(opts, sourceRoot, parent);
      } catch (e) {
        rollbackSource(sourceRoot, previous);
        throw e;
      }
    } catch (e) {
      writeSelfUpdateState(paths.selfUpdateStateFile, selfUpdateState({
        status: "failed",
        repo,
        channel: (target as UpdateTarget | null)?.channel ?? config.updateChannel ?? "stable",
        sourceRoot,
        target,
        error: e instanceof Error ? e.message : String(e),
      }));
      throw e;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function resolveUpdateTarget(
  repo: string,
  opts: Opts,
  config: NonNullable<RuntimeConfig["tweaker"]>,
): Promise<UpdateTarget> {
  const explicitRef = opts.watcher
    ? opts.ref
    : (opts.ref ?? process.env.TWEAKER_REF ?? process.env[LEGACY_REF_ENV] ?? (config.updateChannel === "custom" ? config.updateRef : undefined));
  if (explicitRef) {
    return {
      ref: explicitRef,
      version: releaseVersionFromTag(explicitRef),
      releaseUrl: null,
      source: "explicit-ref",
      channel: "custom",
    };
  }

  const channel = config.updateChannel === "prerelease" ? "prerelease" : "stable";
  const latest = channel === "prerelease"
    ? await fetchLatestAnyRelease(repo)
    : await fetchLatestRelease(repo);
  if (!latest.tag_name) throw new Error(`Latest release for ${repo} did not include a tag`);
  return {
    ref: latest.tag_name,
    version: releaseVersionFromTag(latest.tag_name),
    releaseUrl: latest.html_url ?? null,
    source: "latest-release",
    channel,
  };
}

async function fetchLatestRelease(repo: string): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: githubRequestHeaders(githubToken()),
  });
  if (res.status === 404) throw new Error(`${NO_PUBLISHED_STABLE_RELEASE_PREFIX}${repo}`);
  if (!res.ok) throw new Error(`Release check failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as GitHubRelease;
}

async function fetchLatestAnyRelease(repo: string): Promise<GitHubRelease> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
    headers: githubRequestHeaders(githubToken()),
  });
  if (!res.ok) throw new Error(`Release check failed: ${res.status} ${res.statusText}`);
  const releases = (await res.json()) as GitHubRelease[];
  const release = selectHighestPrereleaseRelease(releases);
  if (!release) throw new Error(`${NO_PUBLISHED_CHANNEL_RELEASE_PREFIX}${repo}`);
  return release;
}

export function selectHighestPrereleaseRelease(
  releases: readonly GitHubRelease[],
): GitHubRelease | null {
  let selected: GitHubRelease | null = null;
  let selectedVersion: ParsedPrereleaseSemver | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease !== true || !release.tag_name) continue;
    const version = parsePrereleaseSemver(release.tag_name);
    if (!version) continue;
    if (!selectedVersion || comparePrereleaseSemver(version, selectedVersion) > 0) {
      selected = release;
      selectedVersion = version;
    }
  }
  return selected;
}

function parsePrereleaseSemver(tag: string): ParsedPrereleaseSemver | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag);
  if (!match) return null;
  const prerelease = match[4]!.split(".");
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && !/^(?:0|[1-9]\d*)$/.test(identifier))) {
    return null;
  }
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease,
  };
}

function comparePrereleaseSemver(
  left: ParsedPrereleaseSemver,
  right: ParsedPrereleaseSemver,
): number {
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index]! > right.core[index]!) return 1;
    if (left.core[index]! < right.core[index]!) return -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) > BigInt(rightIdentifier) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier > rightIdentifier ? 1 : -1;
  }
  return 0;
}

async function download(url: string, target: string): Promise<void> {
  const res = await fetch(url, {
    headers: githubRequestHeaders(githubToken()),
  });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(target));
}

async function fetchReleaseText(url: string): Promise<string | null> {
  const res = await fetch(url, { headers: githubRequestHeaders(githubToken()) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

export function githubRequestHeaders(token: string | null): Record<string, string> {
  if (!token) return { "User-Agent": "tweakers-self-update" };
  return {
    "User-Agent": "tweakers-self-update",
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

function githubToken(): string | null {
  const fromEnvironment = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnvironment?.trim()) return fromEnvironment.trim();
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export function isNoPublishedReleaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(NO_PUBLISHED_STABLE_RELEASE_PREFIX)
    || message.startsWith(NO_PUBLISHED_CHANNEL_RELEASE_PREFIX);
}

export function shouldDownloadSelfUpdate(
  currentVersion: string,
  targetRef: string,
  force = false,
): boolean {
  if (force) return true;
  const targetVersion = releaseVersionFromTag(targetRef);
  if (!targetVersion) return true;
  return compareSemver(targetVersion, currentVersion) > 0;
}

export function shouldRunWatcherSelfUpdate(stateFile: string, now = Date.now()): boolean {
  const state = readSelfUpdateState(stateFile);
  if (!state) return true;
  const checkedAt = Date.parse(state.checkedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt >= WATCHER_SELF_UPDATE_INTERVAL_MS;
}

export function ensureCliExecutable(sourceRoot: string): void {
  if (process.platform === "win32") return;
  chmodSync(join(sourceRoot, "packages", "installer", "dist", "cli.js"), 0o755);
}

export function releaseVersionFromTag(ref: string): string | null {
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(ref) ? ref.replace(/^v/, "") : null;
}

export function parseSha256Sums(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64})[ *]+(.+)$/);
    if (match) map.set(match[2].trim(), match[1].toLowerCase());
  }
  return map;
}

export function verifyChecksum(actualHex: string, sums: Map<string, string>, assetName: string): void {
  const expected = sums.get(assetName);
  if (!expected) throw new Error(`SHA256SUMS has no entry for ${assetName}`);
  if (actualHex.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${assetName}; refusing to build downloaded source`);
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

function verifyDownloadedVersion(sourceDir: string, target: UpdateTarget): void {
  if (!target.version) return;
  const packageVersion = readPackageVersion(sourceDir);
  if (!packageVersion) throw new Error("Downloaded source is missing package.json version");
  if (compareSemver(packageVersion, target.version) !== 0) {
    throw new Error(
      `Downloaded source version ${packageVersion} does not match ${target.ref}`,
    );
  }
}

function readPackageVersion(sourceDir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function readRuntimeConfig(configFile: string): NonNullable<RuntimeConfig["tweaker"]> {
  const config = readConfigFile(configFile) as RuntimeConfig;
  return config.tweaker ?? {};
}

function selfUpdateState(opts: {
  status: SelfUpdateState["status"];
  repo: string;
  channel: SelfUpdateChannel;
  sourceRoot: string;
  target?: UpdateTarget | null;
  error?: string;
}): SelfUpdateState {
  const now = new Date().toISOString();
  return {
    checkedAt: now,
    completedAt: opts.status === "checking" ? undefined : now,
    status: opts.status,
    currentVersion: TWEAKER_VERSION,
    latestVersion: opts.target?.version ?? null,
    targetRef: opts.target?.ref ?? null,
    releaseUrl: opts.target?.releaseUrl ?? null,
    repo: opts.repo,
    channel: opts.channel,
    sourceRoot: opts.sourceRoot,
    installationSource: describeInstallationSource(opts.sourceRoot),
    ...(opts.error ? { error: opts.error } : {}),
  };
}

function installDependencies(cwd: string, opts: RunOptions = {}): void {
  if (existsSync(join(cwd, "package-lock.json"))) {
    const ci = runMaybe(npmCommand(), ["ci", "--workspaces", "--include-workspace-root", "--ignore-scripts"], cwd, opts);
    if (ci.status === 0) return;
    if (!opts.quiet) console.warn(kleur.yellow("npm ci failed; regenerating lockfile for downloaded source."));
    rmSync(join(cwd, "package-lock.json"), { force: true });
  }
  run(npmCommand(), ["install", "--workspaces", "--include-workspace-root", "--ignore-scripts"], cwd, opts);
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function refreshMovedWorkspaceLinks(sourceRoot: string): void {
  if (process.platform !== "win32") return;
  installDependencies(sourceRoot);
}

function runRepairIfRequested(opts: Opts, sourceRoot: string, cwd: string): void {
  if (opts.repair === false) return;
  const cli = join(sourceRoot, "packages", "installer", "dist", "cli.js");
  const args = [cli, "repair"];
  if (opts.watcher) args.push("--watcher");
  if (opts.quiet) args.push("--quiet");
  run(process.execPath, args, cwd, opts);
}

function run(command: string, args: string[], cwd: string, opts: RunOptions = {}): void {
  const result = runMaybe(command, args, cwd, opts);
  if (result.status !== 0) throw new Error(formatCommandFailure(command, args, result));
}

function runMaybe(command: string, args: string[], cwd: string, opts: RunOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (!opts.quiet) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }
  return {
    status: result.status ?? 1,
    signal: result.signal,
    stdout,
    stderr,
    error: result.error,
  };
}

export function formatCommandFailure(command: string, args: string[], result: CommandResult): string {
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
  const details = result.error ? ` (${result.error.message})` : "";
  const output = commandOutputTail(result);
  return [
    `${formatCommand(command, args)} failed with ${status}${details}`,
    output ? `Command output:\n${output}` : null,
  ].filter(Boolean).join("\n\n");
}

function commandOutputTail(result: CommandResult): string {
  const parts = [
    ["stderr", result.stderr] as const,
    ["stdout", result.stdout] as const,
  ].flatMap(([name, value]) => {
    const text = value.trim();
    if (!text) return [];
    return [`${name}:\n${tail(text, COMMAND_OUTPUT_TAIL_CHARS)}`];
  });
  return parts.join("\n\n");
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[last ${maxChars} chars]\n${text.slice(-maxChars)}`;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuoteArg).join(" ");
}

function shellQuoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function rollbackSource(sourceRoot: string, previous: string): void {
  if (!existsSync(previous)) return;
  const failed = `${sourceRoot}.failed`;
  rmSync(failed, { recursive: true, force: true });
  if (existsSync(sourceRoot)) renameSync(sourceRoot, failed);
  renameSync(previous, sourceRoot);
}

function isAutoUpdateEnabled(configFile: string): boolean {
  const config = readConfigFile(configFile) as RuntimeConfig;
  return config.tweaker?.autoUpdate !== false;
}

function log(opts: Opts, message: string): void {
  if (!opts.quiet) console.log(message);
}
