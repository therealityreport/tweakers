export interface DiskStorage {
    get<T>(key: string, defaultValue?: T): T;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    all(): Record<string, unknown>;
    flush(): void;
}
export declare function createDiskStorage(rootDir: string, id: string): DiskStorage;
/**
 * One-time migration (2026-07): the retired `mode-switcher` tweak persisted a
 * soft app mode under the `modeState` key, where `"vanilla"` suppressed
 * loading every other tweak. Real mode switching is now a bundle swap owned
 * by the installer (`tweaker mode <chatgpt|tweakers>`), and this injected
 * runtime only ever executes inside the patched (Tweakers) bundle — so a
 * stale persisted "vanilla" must never gate tweak loading again. Dropping the
 * key is the entire migration: nothing reads it anymore, and absence always
 * meant "tweakers". The storage file is removed once it holds nothing else.
 */
export declare function removeLegacyModeSwitcherState(rootDir: string): void;
