import { type TweakStoreEntry } from "./tweak-store";
export declare function acquireStoreTweak(entry: TweakStoreEntry, options: {
    runtimeDir: string;
    runtimeVersion: string;
    storeIndexUrl: string;
    work: string;
    stagedTarget: string;
    log(message: string): void;
}): Promise<void>;
export declare function validateStoreTweakSource(entry: TweakStoreEntry, source: string): void;
export declare function assertStoreTweakCleanForAutoUpdate(entry: TweakStoreEntry, target: string, work: string, runtimeVersion: string): Promise<void>;
