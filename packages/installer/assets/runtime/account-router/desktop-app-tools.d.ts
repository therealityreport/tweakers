export declare const DESKTOP_APP_TOOLS_CONTEXT_ENV = "TWEAKERS_DESKTOP_APP_TOOLS_CONTEXT_V1";
export declare const MAX_DESKTOP_APP_TOOLS_CONTEXT_BYTES: number;
type JsonValue = string | number | boolean | null | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface DesktopAppToolsDefinition {
    [key: string]: JsonValue;
    command: string;
    args: string[];
    cwd: string;
    enabled: true;
    env_vars: string[];
    env: Record<string, string>;
}
/** Main-owned native configuration; never accept a renderer-supplied definition. */
export interface DesktopAppToolsContextV1 {
    schemaVersion: 1;
    resourcesPath: string;
    definition: DesktopAppToolsDefinition;
}
export declare function isDesktopAppToolsContext(value: unknown): value is DesktopAppToolsContextV1;
export declare function parseDesktopAppToolsContext(serialized: string): DesktopAppToolsContextV1;
/** Called by the main spawn interceptor after native has assigned its own pipe. */
export declare function captureDesktopAppToolsContext(resourcesPath: string, environment: NodeJS.ProcessEnv, readFile?: (path: string, encoding: BufferEncoding) => string, backendCommand?: string): DesktopAppToolsContextV1 | null;
export declare function desktopAppToolsFingerprint(context: DesktopAppToolsContextV1): string;
/** The global broker backend must never freeze its first desktop's MCP. */
export declare function stripDesktopAppToolsCliOverrides(args: readonly string[]): string[];
/** Thread-local only: renderer config cannot replace the main-bound native MCP. */
export declare function injectDesktopAppToolsRequestConfig(config: unknown, context: DesktopAppToolsContextV1 | null): Record<string, unknown>;
export {};
