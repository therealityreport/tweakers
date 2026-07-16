import { lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

/**
 * True when `path` is a symlink whose readlink target resolves inside `root`
 * (or is `root` itself). readlink-based on purpose — safe for dangling links
 * and loops because the target is never realpath'd or followed.
 */
export function isSymlinkInto(path: string, root: string): boolean {
  let target: string;
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    target = readlinkSync(path);
  } catch {
    return false;
  }
  const resolved = resolve(dirname(path), target);
  const canonicalRoot = resolve(root);
  return resolved === canonicalRoot || resolved.startsWith(canonicalRoot + sep);
}
