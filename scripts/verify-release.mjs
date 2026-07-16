import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const tag = process.env.GITHUB_REF_NAME ?? args.find((a) => !a.startsWith("--")) ?? "";
  if (args.includes("--assets")) {
    verifyReleaseAssets(process.cwd(), tag);
    console.log("release assets verified");
  } else {
    verifyRelease(resolve(process.cwd()), tag);
    console.log("release metadata verified");
  }
}
