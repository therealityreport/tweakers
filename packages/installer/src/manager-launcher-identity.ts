import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ManagerExecutableIdentityV1 } from "./manager-contract.js";

export const MANAGER_LAUNCHER_NAME = "Tweakers Manager Launcher";

/**
 * Resolve the fixed sibling launcher without creating or repairing anything.
 * The native launcher verifies stronger ownership, mode, and seal conditions
 * before Node starts; direct bundle execution reports an unresolved identity.
 */
export function resolveManagerExecutableIdentity(entrypoint = process.argv[1]): ManagerExecutableIdentityV1 {
  try {
    if (!entrypoint) throw new Error("manager bundle entrypoint is unavailable");
    const bundle = realpathSync(requireExactAbsolutePath(entrypoint, "manager bundle entrypoint"));
    const launcher = join(dirname(bundle), MANAGER_LAUNCHER_NAME);
    const stat = lstatSync(launcher);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("fixed sibling launcher is not a regular single-link file");
    }
    const canonicalLauncher = realpathSync(launcher);
    if (canonicalLauncher !== launcher) throw new Error("fixed sibling launcher resolves through a link");
    return {
      state: "resolved",
      path: canonicalLauncher,
      sha256: createHash("sha256").update(readFileSync(canonicalLauncher)).digest("hex"),
    };
  } catch (error) {
    return { state: "unresolved", reason: errorMessage(error) };
  }
}

function requireExactAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error(`${label} must be an exact absolute path`);
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
