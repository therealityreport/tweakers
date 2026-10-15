export interface ProcessIdentityV1 {
    pid: number;
    ppid: number;
    started: string;
}
export interface ProcessTreeAccessV1 {
    read(pid?: number, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null>;
    signal(pid: number, signal: NodeJS.Signals): boolean;
}
/** A failed or partial census is unknown, never an empty process tree. */
export declare function readProcessIdentitiesV1(pid?: number, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null>;
export declare const systemProcessTreeAccessV1: ProcessTreeAccessV1;
/** The direct child must be observed while still parented to this owner. */
export declare function captureOwnedRootV1(pid: number | undefined, access: ProcessTreeAccessV1, deadlineAt?: number): Promise<ProcessIdentityV1 | null>;
/** Transitive descendants are proven from one complete table while the root identity is still present. */
export declare function captureOwnedTreeV1(root: ProcessIdentityV1, access: ProcessTreeAccessV1, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null>;
/** A reparented descendant may still be signalled, but only with its captured start identity. */
export declare function verifiedSurvivorsV1(tree: readonly ProcessIdentityV1[], access: ProcessTreeAccessV1, deadlineAt?: number): Promise<readonly ProcessIdentityV1[] | null>;
/** Signal deepest verified descendants first; unknown or reused identities are left alone. */
export declare function signalVerifiedTreeV1(tree: readonly ProcessIdentityV1[], access: ProcessTreeAccessV1, signal: NodeJS.Signals, deadlineAt?: number): Promise<boolean>;
