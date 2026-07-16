import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function managedSourceRoot(userRoot: string): string {
  return join(userRoot, "managed-runtime", "current");
}

export function managedCliPath(userRoot: string): string {
  return join(managedSourceRoot(userRoot), "packages", "installer", "dist", "cli.js");
}

export function installManagedRuntime(sourceRoot: string, userRoot: string): string {
  const destination = managedSourceRoot(userRoot);
  if (resolve(sourceRoot) === resolve(destination)) return destination;
  const parent = dirname(destination);
  const next = join(parent, `.next-${process.pid}`);
  const previous = join(parent, `.previous-${process.pid}`);
  mkdirSync(parent, { recursive: true });
  rmSync(next, { recursive: true, force: true });
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  for (const relative of [
    "package.json",
    "package-lock.json",
    "bin",
    "node_modules",
    join("packages", "installer", "package.json"),
    join("packages", "installer", "dist"),
    join("packages", "installer", "assets"),
    join("packages", "sdk", "package.json"),
    join("packages", "sdk", "dist"),
  ]) {
    const source = join(sourceRoot, relative);
    if (!existsSync(source)) continue;
    const target = join(next, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  }
  writeFileSync(join(next, ".tweakers-provenance.json"), JSON.stringify({
    kind: "development-bootstrap",
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
  if (existsSync(destination)) renameSync(destination, previous);
  try {
    renameSync(next, destination);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    if (existsSync(previous)) renameSync(previous, destination);
    throw error;
  }
  return destination;
}

export function ensureManagedRuntime(sourceRoot: string, userRoot: string): string {
  return existsSync(managedCliPath(userRoot))
    ? managedSourceRoot(userRoot)
    : installManagedRuntime(sourceRoot, userRoot);
}

export function hasReleaseProvenance(sourceRoot: string, ref: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(sourceRoot, ".tweakers-provenance.json"), "utf8")) as {
      kind?: unknown;
      ref?: unknown;
    };
    return value.kind === "github-release" && value.ref === ref;
  } catch { return false; }
}

export function writeReleaseProvenance(sourceRoot: string, ref: string): void {
  writeFileSync(join(sourceRoot, ".tweakers-provenance.json"), JSON.stringify({
    kind: "github-release",
    ref,
    installedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

export function writeDevelopmentProvenanceHash(sourceRoot: string, sourceRuntimeHash: string): void {
  const path = join(sourceRoot, ".tweakers-provenance.json");
  let value: Record<string, unknown> = {};
  try { value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch {}
  writeFileSync(path, JSON.stringify({ ...value, kind: "development-bootstrap", sourceRuntimeHash }, null, 2) + "\n", "utf8");
}
