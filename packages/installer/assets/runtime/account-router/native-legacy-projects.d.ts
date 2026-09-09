import { type OpaqueAccountId } from "./types";
export interface NativeDesktopProjectsProjectionV1 {
    version: 1;
    values: {
        "local-projects": Record<string, {
            id: string;
            name: string;
            rootPaths: string[];
            createdAt: number;
            updatedAt: number;
        }>;
        "thread-project-assignments": Record<string, {
            projectKind: "local";
            projectId: string;
        }>;
        "project-order": string[];
        "pinned-project-ids": string[];
        "sidebar-project-thread-orders": Record<string, {
            threadIds: string[];
        }>;
        "electron-saved-workspace-roots": string[];
        "electron-workspace-root-labels": Record<string, string>;
        "project-appearances": Record<string, unknown>;
    };
    projectIdMap: Record<string, string>;
}
/** Read-only legacy membership overlay; native non-null project IDs always take precedence. */
export declare class NativeLegacyProjectsV1 {
    private readonly root;
    private readonly sourceCodexHome;
    private readonly metadataAccountId;
    private assignments;
    private ordered;
    private removals;
    private ready;
    private failed;
    private unresolved;
    constructor(root: string, sourceCodexHome: string, metadataAccountId: OpaqueAccountId);
    /** Caller supplies IDs from a complete native project/list on the signed metadata account. */
    refresh(validNativeProjectIds: readonly string[]): boolean;
    legacyNativeThreadIdsForProject(publicProjectId: string): readonly string[] | null;
    legacyPublicProjectIdForThread(nativeThreadId: string): string | null;
    unresolvedMembershipCount(): number | null;
    /** Read a bounded, data-only snapshot for the native desktop project UI. */
    desktopProjection(nativeProjects: readonly unknown[]): NativeDesktopProjectsProjectionV1 | null;
    isRemoved(publicProjectId: string, nativeThreadId: string): boolean;
    /** Call after a successful native user-driven removal/reassignment, under the broker writer guard. */
    removeThreadFromProject(publicProjectId: string, nativeThreadId: string): boolean;
}
