import { type RouterConfig, type RouterState } from "./types";
export declare function createInitialRouterState(config: RouterConfig): RouterState;
/** Durable owner/ledger state with strict shape checking and private atomic writes. */
export declare class RouterStateStore {
    readonly root: string;
    readonly config: RouterConfig;
    readonly fileName: string;
    private state;
    constructor(root: string, config: RouterConfig, fileName?: string);
    get path(): string;
    snapshot(): RouterState;
    update(mutator: (state: RouterState) => void): RouterState;
    private load;
}
/**
 * v3 may enroll or disable accounts without discarding the existing ledger or
 * sticky task owners. Migration is deliberately limited to a terminal, idle
 * state: ambiguous requests, correlations, pending owners, or active children
 * continue to fail closed.
 */
export declare function migrateIdleRouterStateV3(value: unknown, config: RouterConfig): RouterState | null;
export declare function validateRouterState(value: unknown, config: RouterConfig): value is RouterState;
export declare function ensurePrivateDirectory(path: string): void;
export declare function assertPrivateRegularFile(path: string, maxBytes: number): void;
export declare function writePrivateJsonAtomic(root: string, fileName: string, value: unknown): void;
/**
 * Atomic private JSON writer with a caller-owned byte ceiling.  The ordinary
 * router state retains its smaller default bound; canonical history has a
 * separately validated 16 MiB format and must not be routed through that
 * unrelated 2 MiB policy.
 */
export declare function writePrivateJsonAtomicBounded(root: string, fileName: string, value: unknown, maxBytes: number): void;
