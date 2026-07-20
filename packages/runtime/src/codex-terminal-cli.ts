import { delimiter, join } from "node:path";

export interface ResolveTerminalCodexBinaryOptions {
  home: string;
  pathValue?: string | null;
  preferredPath?: string | null;
  excludedPaths?: readonly string[];
  isExecutable: (path: string) => boolean;
}

/**
 * Resolve the independently installed Terminal CLI without confusing it with
 * the Codex binary embedded in the desktop app. PATH order is authoritative:
 * it mirrors the `codex` command a Terminal shell actually selects. The
 * standalone-installer shim is only a fallback when PATH has no usable Codex.
 */
export function resolveTerminalCodexBinary(
  options: ResolveTerminalCodexBinaryOptions,
): string | null {
  const excluded = new Set(options.excludedPaths ?? []);
  const candidates = [
    options.preferredPath,
    ...(options.pathValue ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "codex")),
    join(options.home, ".local", "bin", "codex"),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || excluded.has(candidate)) continue;
    seen.add(candidate);
    if (options.isExecutable(candidate)) return candidate;
  }
  return null;
}
