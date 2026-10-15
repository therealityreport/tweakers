import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export interface VariantGenerationFingerprint { kind: "file" | "directory"; mode: number; sha256: string; }
type VariantGenerationKind = VariantGenerationFingerprint["kind"];

/** A deterministic no-follow hash for the staged immutable variant generations. */
export function fingerprintVariantGeneration(path: string, replacements: ReadonlyMap<string, string> = new Map()): VariantGenerationFingerprint {
  const root = existsSync(path) ? lstatSync(path) : null;
  if (!root || root.isSymbolicLink()) {
    throw new Error(`Variant generation root must be present and non-symlinked: ${path}`);
  }
  const kind: VariantGenerationKind = root.isFile() ? "file" : root.isDirectory() ? "directory" : (() => {
    throw new Error(`Variant generation root has an unsupported type: ${path}`);
  })();
  const hash = createHash("sha256");
  hash.update("tweakers-variant-generation-v2\0");
  const visit = (entryPath: string, name: string): void => {
    const sourcePath = replacements.get(name) ?? entryPath;
    const stat = lstatSync(sourcePath);
    if (replacements.has(name) && (!stat.isFile() || stat.isSymbolicLink() || !lstatSync(entryPath).isFile())) throw new Error("Variant replacement must be a regular file");
    const mode = stat.mode & 0o777;
    hash.update(name).update("\0").update(String(mode)).update("\0");
    if (stat.isDirectory()) {
      hash.update("directory\0");
      for (const entry of readdirSync(entryPath, { withFileTypes: true }).sort((left, right) => (
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ))) {
        visit(join(entryPath, entry.name), name ? `${name}/${entry.name}` : entry.name);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update("file\0").update(readFileSync(sourcePath));
      return;
    }
    if (stat.isSymbolicLink()) {
      hash.update("symlink\0").update(readlinkSync(entryPath));
      return;
    }
    throw new Error(`Variant generation contains an unsupported entry: ${entryPath}`);
  };
  visit(path, "");
  return { kind, mode: root.mode & 0o777, sha256: hash.digest("hex") };
}

