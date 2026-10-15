export interface StoreTransactionOptions {
    tweaksDir: string;
    id: string;
    prepare(stagingDir: string): void | Promise<void>;
    /** Owns catalog/manifest/approval metadata policy; reject unknown or changed metadata. */
    assertUnchanged(target: string): void | Promise<void>;
    /** A fulfilled lifecycle port is positive proof; uncertainty must reject. */
    shutdown(operationId: string): void | Promise<void>;
    activate(operationId: string): void | Promise<void>;
    shutdownReplacement(operationId: string): void | Promise<void>;
    reactivatePrevious(operationId: string): void | Promise<void>;
}
export interface StoreTransactionResult {
    operationId: string;
    status: "committed";
    transactionDir: string;
    backupDir: string | null;
}
export interface StoreTransactionReconciliation {
    blockedIds: string[];
    /** A malformed/unattributable record requires holding all store discovery. */
    blockedAll: boolean;
    recoveredIds: string[];
}
export declare class StoreTransactionError extends Error {
    readonly operationId: string;
    readonly transactionDir: string;
    readonly blocked: boolean;
    constructor(message: string, operationId: string, transactionDir: string, blocked: boolean, options?: ErrorOptions);
}
/** Hash file names, contents and permissions; reject links, special files and mount crossings. */
export declare function hashStoreTree(path: string, durable?: boolean): string | null;
/** Ports must resolve only after the requested runtime state is positively known. */
export declare function installStoreTransaction(options: StoreTransactionOptions): Promise<StoreTransactionResult>;
/** Invoke once in a fresh process, before discovery or any tweak runtime starts. */
export declare function reconcileStoreTransactions(tweaksDir: string): StoreTransactionReconciliation;
