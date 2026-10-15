import { type StorageLike } from "./renderer-storage";
export interface TopicTweak {
    manifest: {
        id: string;
        version: string;
    };
    enabled: boolean;
}
/** Main may accept delegation only for these versioned, enabled owners. */
export declare function topicMigrationOwner(id: string, tweaks: readonly TopicTweak[]): string | null;
/** Suppression follows successful persistence. Failed migrations leave legacy behavior available. */
export declare function consolidateTweakTopics(tweaks: readonly TopicTweak[], storage: StorageLike): Set<string>;
