export interface LocalCliRuntimeInput {
    cli: string;
    args: string[];
    userRoot: string;
    resourcesPath: string;
    execPath: string;
    env: NodeJS.ProcessEnv;
}
export interface LocalCliRuntimeResult {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
}
/** Read the exact Node executable captured when Tweakers installed its shim. */
export declare function nodeExecutableFromCliShim(source: string): string | null;
export declare function resolveLocalCliRuntime(input: LocalCliRuntimeInput): LocalCliRuntimeResult;
