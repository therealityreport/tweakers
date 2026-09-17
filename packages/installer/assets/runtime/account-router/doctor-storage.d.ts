export interface DoctorStorageInspection {
    state: "ready" | "repairable" | "blocked" | "not_applicable";
    reason: string;
    fingerprint: string;
    legacyVolumeUnproven: boolean;
}
/** No mkdir, chmod, reservation, agent work, or credential/history writes. */
export declare function inspectNativeStorageIdentitiesAtRoot(root: string): DoctorStorageInspection;
/** Explicit metadata-only repair; an active broker retains its owner-election socket. */
export declare function repairNativeStorageIdentitiesAtRoot(root: string, expectedFingerprint: string): Promise<DoctorStorageInspection>;
