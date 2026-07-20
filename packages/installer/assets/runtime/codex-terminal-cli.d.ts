export interface ResolveTerminalCodexBinaryOptions {
    home: string;
    pathValue?: string | null;
    preferredPath?: string | null;
    excludedPaths?: readonly string[];
    isExecutable: (path: string) => boolean;
}
/**
 * Resolve the independently installed Terminal CLI without confusing it with
 * the Codex binary embedded in the desktop app. The standalone installer owns
 * ~/.local/bin/codex, so that stable user-facing shim takes precedence over
 * app-process PATH drift.
 */
export declare function resolveTerminalCodexBinary(options: ResolveTerminalCodexBinaryOptions): string | null;
