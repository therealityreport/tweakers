export interface StorageLike {
    readonly length: number;
    getItem(key: string): string | null;
    key(index: number): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
export declare function createRendererStorage(id: string, storage: StorageLike): {
    get: <T>(name: string, fallback?: T) => T;
    set: (name: string, value: unknown) => void;
    delete: (name: string) => void;
    all: () => Record<string, unknown>;
};
