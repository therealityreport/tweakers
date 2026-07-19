import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { LEGACY_DATA_DIR } from "./legacy-compat.js";

export function findSourceRoot(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {}
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "..", "..", "..", "..");
}

export type InstallationSourceKind = "managed-runtime" | "github-source" | "homebrew" | "local-dev" | "source-archive" | "unknown";

export interface InstallationSource {
  kind: InstallationSourceKind;
  label: string;
  detail: string;
}

export function describeInstallationSource(sourceRoot: string | null | undefined): InstallationSource {
  if (!sourceRoot) {
    return {
      kind: "unknown",
      label: "Unknown",
      detail: "Tweakers source location is not recorded yet. Run tweaker install or repair.",
    };
  }

  const normalized = sourceRoot.replace(/\\/g, "/");
  if (normalized.includes("/Tweakers/managed-runtime/current")
    || normalized.includes("/tweaker/managed-runtime/current")
    || normalized.includes(`/${LEGACY_DATA_DIR}/managed-runtime/current`)) {
    return { kind: "managed-runtime", label: "Managed stable runtime", detail: sourceRoot };
  }
  if (/\/(?:Homebrew|homebrew)\/Cellar\/tweaker\//.test(normalized)
    || normalized.includes(`/${LEGACY_DATA_DIR.replace("-", "")}/`)) {
    return { kind: "homebrew", label: "Homebrew", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, ".git"))) {
    return { kind: "local-dev", label: "Local development checkout", detail: sourceRoot };
  }
  if (normalized.endsWith("/.tweaker/source")
    || normalized.includes("/.tweaker/source/")
    || normalized.endsWith(`/.${LEGACY_DATA_DIR}/source`)
    || normalized.includes(`/.${LEGACY_DATA_DIR}/source/`)) {
    return { kind: "github-source", label: "GitHub source installer", detail: sourceRoot };
  }
  if (existsSync(join(sourceRoot, "package.json"))) {
    return { kind: "source-archive", label: "Source archive", detail: sourceRoot };
  }
  return { kind: "unknown", label: "Unknown", detail: sourceRoot };
}
