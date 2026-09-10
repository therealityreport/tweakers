export interface NativeThreadWriterLease {
    readonly dev: string;
    readonly ino: string;
    isHeld(): boolean;
    release(): void;
}
export type NativeThreadWriterLeaseResult = {
    state: "ready";
    lease: NativeThreadWriterLease;
} | {
    state: "busy" | "unavailable";
};
/** Only the reviewed native host can acquire the shared native writer lock. */
export declare function acquireNativeThreadWriterLease(lockDirectory: string, threadId: string): NativeThreadWriterLeaseResult;
/** Prove the fresh target is the sole process holding the prepared lock inode. */
export declare function proveNativeThreadWriterLease(lockDirectory: string, threadId: string, identity: {
    dev: string;
    ino: string;
}, targetPid: number): boolean;
