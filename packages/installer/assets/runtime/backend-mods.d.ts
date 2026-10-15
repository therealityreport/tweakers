import type { BackendHookOptions } from "@therealityreport/tweakers-sdk";
export declare class BackendMods {
    private hooks;
    private sequence;
    register(tweakId: string, directory: string, options: BackendHookOptions): Promise<{
        dispose(): Promise<void>;
    }>;
    diagnostics(): {
        id: string;
        kind: "observe" | "transform";
        pending: number;
        failed: boolean;
    }[];
    private ordered;
    get hasObservers(): boolean;
    get hasTransforms(): boolean;
    observe(value: unknown): void;
    transform(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}
