export declare function startTweakHost(requiredId?: string): Promise<void>;
export declare function teardownTweakHost(): Promise<void>;
export declare const rendererStorage: (id: string, storage?: Storage) => {
    readonly migration: import("../renderer-storage").RendererStorageMigrationReceipt;
    commitMigration: () => import("../renderer-storage").RendererStorageMigrationReceipt;
    rollbackMigration: () => import("../renderer-storage").RendererStorageMigrationReceipt;
    get: <T>(name: string, fallback?: T) => T;
    set: (name: string, value: unknown) => void;
    delete: (name: string) => void;
    all: () => Record<string, unknown>;
};
