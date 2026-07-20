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
export declare function resolveTerminalCodexBinary(options: ResolveTerminalCodexBinaryOptions): string | null;
