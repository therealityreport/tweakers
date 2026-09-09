import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function verifyRelease(root, tag) {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const workspaces = ["sdk", "runtime", "installer", "loader", "native-host"].map((name) => JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8")));
  const expected = `v${pkg.version}`;
  if (tag !== expected) throw new Error(`release tag ${tag} must match package version ${expected}`);
  for (const workspace of workspaces) if (workspace.version !== pkg.version) throw new Error(`${workspace.name} version ${workspace.version} must match ${pkg.version}`);
  const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## (?:\\[)?${pkg.version.replaceAll(".", "\\.")}(?:\\])?$`, "m").test(changelog)) throw new Error(`CHANGELOG.md is missing ${pkg.version}`);
  return { version: pkg.version, tag };
}

export function verifyReleaseAssets(dir, tag) {
  const tarball = `tweakers-${tag}.tar.gz`;
  if (!existsSync(resolve(dir, tarball))) throw new Error(`missing release asset ${tarball}`);
  const sumsPath = resolve(dir, "SHA256SUMS");
  if (!existsSync(sumsPath)) throw new Error("missing release asset SHA256SUMS");
  const sums = readFileSync(sumsPath, "utf8");
  if (!sums.includes(tarball)) throw new Error(`SHA256SUMS does not reference ${tarball}`);
  return { tarball, sums: "SHA256SUMS" };
}

/** The release CLI's stricter tagged-archive check; it remains unsigned. */
export function verifyReleaseArchiveAssets(dir, tag) {
  const { tarball, sums } = verifyReleaseAssets(dir, tag);
  const tarballPath = resolve(dir, tarball);
  const sumsPath = resolve(dir, sums);
  const contents = readFileSync(sumsPath, "utf8");
  const expected = parseSha256Sums(contents, tarball);
  const actual = sha256File(tarballPath);
  if (actual !== expected) throw new Error(`SHA256SUMS digest does not match ${tarball}`);

  // This is deliberately an unsigned integrity check. The archive is built
  // from the pushed tag and SHA256SUMS is the required release anchor.
  const listing = run("tar", ["-tzf", tarballPath]);
  const prefix = `tweakers-${tag}/`;
  if (!listing.split(/\r?\n/).some((entry) => entry === `${prefix}package.json`)) {
    throw new Error(`${tarball} is not a tagged Tweakers archive`);
  }
  for (const relativePath of [
    "packages/native-host/manager-signing-policy.json",
    "packages/native-host/assets/Tweakers Manager Launcher",
    "packages/installer/assets/manager-launcher/Tweakers Manager Launcher",
    "packages/installer/assets/manager-launcher/manager.mjs",
    "packages/installer/assets/manager-launcher/signing-policy.json",
  ]) {
    const archived = runBytes("tar", ["-xOzf", tarballPath, `${prefix}${relativePath}`]);
    const archivedSha256 = createHash("sha256").update(archived).digest("hex");
    const committedSha256 = sha256File(resolve(dir, relativePath));
    if (archivedSha256 !== committedSha256) {
      throw new Error(`${tarball} contains stale manager artifact bytes: ${relativePath}`);
    }
  }
  return { tarball, sums, sha256: actual };
}

/**
 * Checks the committed release inputs without creating or signing anything.
 * The canonical launcher is publisher-signed before it is committed; CI only
 * proves its pinned identity and that the installer ships those exact bytes.
 */
export function verifyManagerReleaseArtifacts(root) {
  const policy = JSON.parse(readFileSync(resolve(root, "packages/native-host/manager-signing-policy.json"), "utf8"));
  const name = policy.executableName;
  const canonicalLauncher = resolve(root, "packages/native-host/assets", name);
  const installerLauncher = resolve(root, "packages/installer/assets/manager-launcher", name);
  const managerBundle = resolve(root, "packages/installer/assets/manager-launcher/manager.mjs");
  const packagedPolicy = resolve(root, "packages/installer/assets/manager-launcher/signing-policy.json");
  const canonicalPolicy = resolve(root, "packages/native-host/manager-signing-policy.json");
  for (const path of [canonicalLauncher, installerLauncher, managerBundle, packagedPolicy]) {
    if (!existsSync(path)) throw new Error(`missing committed manager release artifact: ${path}`);
  }
  if (sha256File(canonicalPolicy) !== sha256File(packagedPolicy)) {
    throw new Error("installer manager signing policy differs from the committed canonical policy");
  }

  run("codesign", ["--verify", "--strict", canonicalLauncher]);
  const architectures = run("lipo", ["-archs", canonicalLauncher]).trim();
  if (architectures !== policy.architecture) {
    throw new Error(`canonical manager launcher must contain only ${policy.architecture}; found ${architectures}`);
  }
  const signing = run("codesign", ["-d", "-r-", "--verbose=4", canonicalLauncher], { includeStderr: true });
  const policyIdentifier = requireNonEmptyString(policy.identifier, "manager signing policy identifier");
  const policyAuthority = requireNonEmptyString(policy.certificateCommonName, "manager signing policy certificateCommonName");
  const policyDesignatedRequirement = requireNonEmptyString(policy.designatedRequirement, "manager signing policy designatedRequirement");
  const identifier = requireNonEmptyString(signingOutputValue(signing, "Identifier="), "canonical manager launcher identifier");
  if (identifier !== policyIdentifier) {
    throw new Error("canonical manager launcher identifier does not match signing policy");
  }
  const authority = requireNonEmptyString(signingOutputValue(signing, "Authority="), "canonical manager launcher leaf authority");
  if (authority !== policyAuthority) {
    throw new Error("canonical manager launcher leaf authority does not match signing policy");
  }
  const designatedRequirement = requireNonEmptyString(signingOutputValue(signing, "designated => "), "canonical manager launcher designated requirement");
  if (designatedRequirement !== policyDesignatedRequirement) {
    throw new Error("canonical manager launcher designated requirement does not match signing policy");
  }

  const canonicalSha256 = sha256File(canonicalLauncher);
  const installerSha256 = sha256File(installerLauncher);
  if (canonicalSha256 !== installerSha256) {
    throw new Error("installer manager launcher bytes differ from the committed canonical launcher");
  }
  const bundle = readFileSync(managerBundle, "utf8");
  for (const required of ["environment.cancel", "refresh.injected", "refresh.independent", "official-source.register", "createSealedTweakersManagerActionAdapter"]) {
    if (!bundle.includes(required)) throw new Error(`fixed-action manager bundle is missing sealed action marker: ${required}`);
  }
  if (bundle.includes("refresh.full")) {
    throw new Error("fixed-action manager bundle contains the retired generic refresh action");
  }
  return { canonicalLauncher, managerBundle, launcherSha256: canonicalSha256 };
}

function parseSha256Sums(sums, tarball) {
  const entry = sums.split(/\r?\n/).map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line))
    .find((match) => match?.[2] === tarball);
  if (!entry) throw new Error(`SHA256SUMS does not reference ${tarball}`);
  return entry[1].toLowerCase();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function signingOutputValue(output, prefix) {
  const line = output.split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}

function run(command, args, { includeStderr = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? `${result.stdout ?? ""}${result.stderr ?? ""}`}`);
  }
  return `${result.stdout ?? ""}${includeStderr ? result.stderr ?? "" : ""}`;
}

function runBytes(command, args) {
  const result = spawnSync(command, args, { encoding: null, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0 || result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error?.message ?? String(result.stderr ?? "")}`);
  }
  return result.stdout;
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  const args = process.argv.slice(2);
  const tag = process.env.GITHUB_REF_NAME ?? args.find((a) => !a.startsWith("--")) ?? "";
  if (args.includes("--manager-artifacts")) {
    verifyManagerReleaseArtifacts(resolve(process.cwd()));
    console.log("manager release artifacts verified");
  } else if (args.includes("--assets")) {
    verifyReleaseArchiveAssets(process.cwd(), tag);
    console.log("release assets verified");
  } else {
    verifyRelease(resolve(process.cwd()), tag);
    console.log("release metadata verified");
  }
}
