import { existsSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { dirname, resolve, sep } from "node:path";

/**
 * Proves that an existing path, or the nearest existing parent of a future
 * path, lives on the macOS internal Data filesystem. Prefix checks alone are
 * insufficient because an external mount can also be reached through paths
 * such as /System/Volumes/Data/Volumes/<name> or an internal symlink.
 */
export function assertInternalStoragePath(path: string, label = "Artifact"): void {
  const exact = resolve(path);
  rejectVolumesNamespace(exact, label);

  let ancestor = exact;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (!existsSync(ancestor)) {
    throw new Error(`${label} has no existing filesystem ancestor: ${exact}`);
  }

  const canonicalAncestor = realpathSync(ancestor);
  rejectVolumesNamespace(canonicalAncestor, label);
  if (platform() !== "darwin") return;

  const internalDataRoot = "/System/Volumes/Data";
  if (!existsSync(internalDataRoot)) {
    throw new Error(`${label} cannot prove the macOS internal Data filesystem`);
  }
  if (statSync(canonicalAncestor).dev !== statSync(internalDataRoot).dev) {
    throw new Error(`${label} must remain on the internal Data filesystem: ${exact}`);
  }
}

function rejectVolumesNamespace(path: string, label: string): void {
  if (path === "/Volumes" || path.startsWith(`/Volumes${sep}`)) {
    throw new Error(`${label} must remain on internal storage; /Volumes paths are prohibited`);
  }
}
