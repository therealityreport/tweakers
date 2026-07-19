export interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const CURRENT_ID_PREFIX = "co.tweakers.";
const LEGACY_STORAGE_PREFIX = `${["codex", "pp"].join("")}:storage:`;
const CURRENT_STORAGE_PREFIX = "tweaker:storage:";

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function discoverLegacyPublisherKey(id: string, storage: StorageLike): string | null {
  if (!id.startsWith(CURRENT_ID_PREFIX)) return null;
  const suffix = id.slice(CURRENT_ID_PREFIX.length);
  if (!suffix) return null;

  const suffixMarker = `.${suffix}`;
  const candidates = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(LEGACY_STORAGE_PREFIX)) continue;
    const legacyId = key.slice(LEGACY_STORAGE_PREFIX.length);
    if (
      legacyId !== id
      && legacyId.startsWith("co.")
      && legacyId.endsWith(suffixMarker)
      && legacyId.slice(3, -suffixMarker.length).length > 0
    ) {
      candidates.add(key);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function createRendererStorage(id: string, storage: StorageLike) {
  const key = `${CURRENT_STORAGE_PREFIX}${id}`;
  const legacyCurrentIdKey = `${LEGACY_STORAGE_PREFIX}${id}`;
  const read = (): Record<string, unknown> => {
    const current = parseRecord(storage.getItem(key));
    const legacyCurrentId = parseRecord(storage.getItem(legacyCurrentIdKey));
    const legacyPublisherKey = discoverLegacyPublisherKey(id, storage);
    const legacyPublisher = legacyPublisherKey === null
      ? null
      : parseRecord(storage.getItem(legacyPublisherKey));

    const legacyKeys = [
      legacyCurrentId === null ? null : legacyCurrentIdKey,
      legacyPublisher === null ? null : legacyPublisherKey,
    ].filter((candidate): candidate is string => candidate !== null);

    if (legacyKeys.length === 0) return current ?? {};

    const merged = {
      ...(legacyPublisher ?? {}),
      ...(legacyCurrentId ?? {}),
      ...(current ?? {}),
    };
    try {
      storage.setItem(key, JSON.stringify(merged));
    } catch {
      return merged;
    }
    for (const legacyKey of legacyKeys) storage.removeItem(legacyKey);
    return merged;
  };
  const write = (value: Record<string, unknown>) => storage.setItem(key, JSON.stringify(value));
  return {
    get: <T>(name: string, fallback?: T) => {
      const current = read();
      return name in current ? (current[name] as T) : (fallback as T);
    },
    set: (name: string, value: unknown) => {
      const current = read();
      current[name] = value;
      write(current);
    },
    delete: (name: string) => {
      const current = read();
      delete current[name];
      write(current);
    },
    all: () => read(),
  };
}
