import { type NativeHistorySourceBindingV1 } from "./native-history";
import { type OpaqueAccountId } from "./types";
export declare const NATIVE_PROJECT_SNAPSHOT_MAX_BYTES: number;
export declare const NATIVE_PROJECT_SNAPSHOT_MAX_PROJECTS = 512;
export interface NativeSavedProjectV1 {
    id: string;
    name: string;
    metadata: Record<string, unknown>;
    roots: Array<{
        path: string;
    }>;
    createdAt: number;
    updatedAt: number;
}
export interface NativeProjectSnapshotV1 {
    account: OpaqueAccountId;
    fingerprint: string;
    projects: readonly unknown[];
    source: "saved_local" | "app_server";
}
/** Native Project RPC timestamps are integer seconds; SQLite/desktop rows keep milliseconds. */
export declare function nativeProjectRpcRowV1(value: unknown, source: NativeProjectSnapshotV1["source"]): unknown;
/** Uses only the signed metadata-account homes; this reader never creates an auth child. */
export declare class NativeProjectSnapshotReaderV1 {
    private readonly binding;
    constructor(binding: NativeHistorySourceBindingV1);
    fingerprint(requireDatabase?: boolean): string | null;
    read(): Promise<NativeProjectSnapshotV1 | null>;
    readThreadOrder(ids: readonly string[], sortKey: string, direction: string): Promise<string[] | null>;
}
/** Exported pure schema seam for fixtures; unsupported migrations/schema fail closed. */
export declare function parseSavedNativeProjectsV1(value: unknown): NativeSavedProjectV1[] | null;
/** Opaque cursors seal an immutable, bounded, account/source/authority-specific snapshot. */
export declare class NativeProjectSnapshotPagesV1 {
    private readonly snapshots;
    private readonly cursors;
    clear(): void;
    page(snapshot: NativeProjectSnapshotV1 | null, account: OpaqueAccountId, fingerprint: string, generation: number, params: unknown): {
        data: unknown[];
        nextCursor: string | null;
    } | null;
}
