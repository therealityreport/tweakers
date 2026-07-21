export interface StorageLike {
    readonly length: number;
    getItem(key: string): string | null;
    key(index: number): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export type RendererStorageMigrationStatus = "not_applicable" | "absent" | "canonical" | "prepared" | "ambiguous" | "conflict" | "invalid_canonical" | "invalid_legacy" | "write_failed";
export interface RendererStorageMigrationReceipt {
    schemaVersion: 1;
    transactionId: string;
    currentKey: string;
    legacyKeys: string[];
    selectedLegacyKey: string | null;
    status: RendererStorageMigrationStatus;
    holdPromotion: boolean;
    createdCanonical: boolean;
    canonicalBeforeHash: string;
    canonicalAfterHash: string;
    selectedLegacyHash: string;
    archiveKey: string | null;
    phase: "planned" | "prepared" | "committed" | "rolled_back";
}
export declare function planRendererStorageMigration(id: string, storage: StorageLike, transactionId?: string): RendererStorageMigrationReceipt;
export declare function prepareRendererStorageMigration(id: string, storage: StorageLike, transactionId?: string): RendererStorageMigrationReceipt;
export declare function commitRendererStorageMigration(receipt: RendererStorageMigrationReceipt, storage: StorageLike): RendererStorageMigrationReceipt;
export declare function rollbackRendererStorageMigration(receipt: RendererStorageMigrationReceipt, storage: StorageLike): RendererStorageMigrationReceipt;
export declare function createRendererStorage(id: string, storage: StorageLike): {
    readonly migration: RendererStorageMigrationReceipt;
    commitMigration: () => RendererStorageMigrationReceipt;
    rollbackMigration: () => RendererStorageMigrationReceipt;
    get: <T>(name: string, fallback?: T) => T;
    set: (name: string, value: unknown) => void;
    delete: (name: string) => void;
    all: () => Record<string, unknown>;
};
