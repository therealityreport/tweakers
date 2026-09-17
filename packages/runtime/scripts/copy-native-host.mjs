import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(here, "..");
const repoRoot = resolve(runtimeRoot, "..", "..");
const src = resolve(repoRoot, "packages/native-host/dist/tweaker_native_host.node");
const outDir = resolve(runtimeRoot, "dist/native");
const out = resolve(outDir, "tweaker_native_host.node");

if (!existsSync(src)) {
  console.warn("[runtime] native host not found; native AppKit/Metal host will be unavailable");
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
for (const entry of readdirSync(outDir)) {
  if (entry.endsWith(".node") && entry !== basename(out)) {
    rmSync(resolve(outDir, entry), { force: true });
  }
}
cpSync(src, out);
const doctor = resolve(repoRoot, "packages/native-host/dist/Tweakers Doctor.app");
if (existsSync(doctor)) {
  const destination = resolve(outDir, "Tweakers Doctor.app");
  const candidate = resolve(outDir, `.Tweakers Doctor.app.candidate-${process.pid}`);
  rmSync(candidate, { recursive: true, force: true });
  cpSync(doctor, candidate, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (process.platform === "darwin") {
    const verified = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate], { encoding: "utf8" });
    if (verified.status !== 0) throw new Error(`Copied Tweakers Doctor signature did not verify: ${verified.stderr}`);
  }
  rmSync(destination, { recursive: true, force: true });
  renameSync(candidate, destination);
  rmSync(resolve(outDir, "Tweakers Doctor"), { force: true });
}
console.log(`[runtime] native host -> ${out}`);
