import type { RouterConfig } from "./types";
/** Executable entry point run under ChatGPT's bundled signed Node parent. */
export declare function runAccountRouterMuxCli(argv?: string[]): Promise<void>;
export declare function preflightRouterHomes(config: RouterConfig, stateRoot: string): boolean;
export declare function sanitizedChildEnvironment(codexHome: string, sqliteHome: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function defaultMuxPaths(userRoot?: string | undefined): {
    configPath: string;
    stateRoot: string;
} | null;
