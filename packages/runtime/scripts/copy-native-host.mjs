import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownEntrypoint } from "../../../scripts/owned-entrypoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const repoRoot = resolve(runtimeRoot, "..", "..");
const require = createRequire(import.meta.url);

/** Publish only after a complete copy and signature check; keep the old bundle on failure. */
export function publishNativeManager({
  source,
  destination,
  platform = process.platform,
  copy = cpSync,
  verify = (candidate) => {
    const checked = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate], { encoding: "utf8" });
    if (checked.status !== 0) throw new Error(`Copied Tweakers Manager signature did not verify: ${checked.error?.message ?? checked.stderr}`);
  },
  swap = (candidate, current) => require(resolve(dirname(source), "tweaker_native_host.node")).swapDirectories(candidate, current),
  remove = rmSync,
}) {
  if (platform !== "darwin") return { skipped: true, published: false, retainedArtifacts: [] };
  if (!existsSync(source)) return { skipped: true, published: false, retainedArtifacts: [] };
  mkdirSync(dirname(destination), { recursive: true });
  const candidate = resolve(dirname(destination), `.Tweakers Manager.app.candidate-${randomUUID()}`);
  let published = false;
  try {
    copy(source, candidate, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    verify(candidate);
    if (existsSync(destination)) swap(candidate, destination);
    else renameSync(candidate, destination);
    published = true;
  } catch (error) {
    if (!published && existsSync(candidate)) {
      try { remove(candidate, { recursive: true, force: true }); }
      catch (cleanupError) {
        throw new Error(`${error.message}; candidate retained at ${candidate}: ${cleanupError.message}`, { cause: error });
      }
    }
    throw error;
  }

  const retainedArtifacts = [];
  for (const path of [candidate, resolve(dirname(destination), "Tweakers Doctor.app"), resolve(dirname(destination), "Tweakers Doctor")]) {
    if (!existsSync(path)) continue;
    try { remove(path, { recursive: true, force: true }); }
    catch (error) {
      if (existsSync(path)) {
        retainedArtifacts.push(path);
        console.warn(`[runtime] published Tweakers Manager; retained ${path}: ${error.message}`);
      }
    }
  }
  return { skipped: false, published: true, retainedArtifacts };
}

export function copyNativeHost() {
  if (process.platform !== "darwin") {
    console.log("[runtime] skipping macOS native host copy on non-darwin platform");
    return;
  }
  const src = resolve(repoRoot, "packages/native-host/dist/tweaker_native_host.node");
  const outDir = resolve(runtimeRoot, "dist/native");
  const out = resolve(outDir, "tweaker_native_host.node");
  if (!existsSync(src)) {
    console.warn("[runtime] native host not found; native AppKit/Metal host will be unavailable");
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (entry.endsWith(".node") && entry !== basename(out)) rmSync(resolve(outDir, entry), { force: true });
  }
  cpSync(src, out);
  publishNativeManager({
    source: resolve(repoRoot, "packages/native-host/dist/Tweakers Manager.app"),
    destination: resolve(outDir, "Tweakers Manager.app"),
  });
  console.log(`[runtime] native host -> ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ownEntrypoint(import.meta.url);
  copyNativeHost();
}
