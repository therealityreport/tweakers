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
export declare function validateRouterState(value: unknown, config: RouterConfig): value is RouterState;
export declare function ensurePrivateDirectory(path: string): void;
export declare function assertPrivateRegularFile(path: string, maxBytes: number): void;
export declare function writePrivateJsonAtomic(root: string, fileName: string, value: unknown): void;
