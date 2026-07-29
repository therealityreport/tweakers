/** Synchronous SHA-256 for the sandboxed renderer, which cannot import Node built-ins. */
export declare function sha256HexUtf8(value: string): string;
/** Generates a UUID without relying on sandbox-unavailable Node crypto. */
export declare function secureRendererUuid(): string;
