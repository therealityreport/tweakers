import { secureRendererUuid, sha256HexUtf8 } from "./renderer-crypto";

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
const ARCHIVE_STORAGE_PREFIX = "tweaker:storage-archive:";

export type RendererStorageMigrationStatus =
  | "not_applicable"
  | "absent"
  | "canonical"
  | "prepared"
  | "ambiguous"
  | "conflict"
  | "invalid_canonical"
  | "invalid_legacy"
  | "write_failed";

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

interface StorageMigrationPlan {
  receipt: RendererStorageMigrationReceipt;
  canonicalRaw: string | null;
  selectedLegacyRaw: string | null;
}

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

function fingerprint(raw: string | null): string {
  return raw === null ? "missing" : sha256HexUtf8(raw);
}

function discoverLegacyPublisherKeys(id: string, storage: StorageLike): string[] {
  if (!id.startsWith(CURRENT_ID_PREFIX)) return [];
  const suffix = id.slice(CURRENT_ID_PREFIX.length);
  if (!suffix) return [];

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
  return [...candidates].sort();
}

function legacyKeysFor(id: string, storage: StorageLike): string[] {
  const exactLegacyKey = `${LEGACY_STORAGE_PREFIX}${id}`;
  const keys = new Set(discoverLegacyPublisherKeys(id, storage));
  if (storage.getItem(exactLegacyKey) !== null) keys.add(exactLegacyKey);
  return [...keys].sort();
}

function planMigration(
  id: string,
  storage: StorageLike,
  transactionId: string = secureRendererUuid(),
): StorageMigrationPlan {
  const currentKey = `${CURRENT_STORAGE_PREFIX}${id}`;
  const canonicalRaw = storage.getItem(currentKey);
  const legacyKeys = legacyKeysFor(id, storage);
  const selectedLegacyKey = legacyKeys.length === 1 ? legacyKeys[0]! : null;
  const selectedLegacyRaw = selectedLegacyKey === null ? null : storage.getItem(selectedLegacyKey);
  const base = {
    schemaVersion: 1 as const,
    transactionId,
    currentKey,
    legacyKeys,
    selectedLegacyKey,
    createdCanonical: false,
    canonicalBeforeHash: fingerprint(canonicalRaw),
    canonicalAfterHash: fingerprint(canonicalRaw),
    selectedLegacyHash: fingerprint(selectedLegacyRaw),
    archiveKey: null,
    phase: "planned" as const,
  };

  if (!id.startsWith(CURRENT_ID_PREFIX)) {
    return { receipt: { ...base, status: "not_applicable", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  if (legacyKeys.length > 1) {
    return { receipt: { ...base, status: "ambiguous", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null && parseRecord(canonicalRaw) === null) {
    return { receipt: { ...base, status: "invalid_canonical", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (selectedLegacyRaw !== null && parseRecord(selectedLegacyRaw) === null) {
    return { receipt: { ...base, status: "invalid_legacy", holdPromotion: true }, canonicalRaw, selectedLegacyRaw };
  }
  if (canonicalRaw !== null) {
    const mismatch = selectedLegacyRaw !== null && selectedLegacyRaw !== canonicalRaw;
    return {
      receipt: { ...base, status: mismatch ? "conflict" : "canonical", holdPromotion: mismatch },
      canonicalRaw,
      selectedLegacyRaw,
    };
  }
  if (selectedLegacyRaw === null) {
    return { receipt: { ...base, status: "absent", holdPromotion: false }, canonicalRaw, selectedLegacyRaw };
  }
  return {
    receipt: {
      ...base,
      status: "prepared",
      holdPromotion: false,
      createdCanonical: true,
      canonicalAfterHash: fingerprint(selectedLegacyRaw),
    },
    canonicalRaw,
    selectedLegacyRaw,
  };
}

export function planRendererStorageMigration(
  id: string,
  storage: StorageLike,
  transactionId?: string,
): RendererStorageMigrationReceipt {
  return planMigration(id, storage, transactionId).receipt;
}

export function prepareRendererStorageMigration(
  id: string,
  storage: StorageLike,
  transactionId?: string,
): RendererStorageMigrationReceipt {
  const plan = planMigration(id, storage, transactionId);
  if (!plan.receipt.createdCanonical || plan.selectedLegacyRaw === null) {
    return { ...plan.receipt, phase: "prepared" };
  }
  try {
    if (storage.getItem(plan.receipt.currentKey) !== null) {
      return { ...plan.receipt, status: "conflict", holdPromotion: true, createdCanonical: false, phase: "prepared" };
    }
    storage.setItem(plan.receipt.currentKey, plan.selectedLegacyRaw);
    if (fingerprint(storage.getItem(plan.receipt.currentKey)) !== plan.receipt.canonicalAfterHash) {
      throw new Error("renderer storage verification failed");
    }
    return { ...plan.receipt, phase: "prepared" };
  } catch {
    return {
      ...plan.receipt,
      status: "write_failed",
      holdPromotion: true,
      createdCanonical: false,
      canonicalAfterHash: fingerprint(storage.getItem(plan.receipt.currentKey)),
      phase: "prepared",
    };
  }
}

export function commitRendererStorageMigration(
  receipt: RendererStorageMigrationReceipt,
  storage: StorageLike,
): RendererStorageMigrationReceipt {
  if (receipt.phase === "committed") return receipt;
  if (receipt.holdPromotion) throw new Error("renderer storage migration is on hold");
  if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
    throw new Error("renderer storage canonical value changed before commit");
  }
  if (receipt.selectedLegacyKey === null) return { ...receipt, phase: "committed" };
  const legacyRaw = storage.getItem(receipt.selectedLegacyKey);
  if (fingerprint(legacyRaw) !== receipt.selectedLegacyHash || legacyRaw === null) {
    throw new Error("renderer storage legacy value changed before commit");
  }
  const archiveKey = `${ARCHIVE_STORAGE_PREFIX}${receipt.transactionId}:${encodeURIComponent(receipt.selectedLegacyKey)}`;
  const archived = storage.getItem(archiveKey);
  if (archived !== null && archived !== legacyRaw) {
    throw new Error("renderer storage archive collision");
  }
  storage.setItem(archiveKey, legacyRaw);
  if (storage.getItem(archiveKey) !== legacyRaw) throw new Error("renderer storage archive verification failed");
  storage.removeItem(receipt.selectedLegacyKey);
  return { ...receipt, archiveKey, phase: "committed" };
}

export function rollbackRendererStorageMigration(
  receipt: RendererStorageMigrationReceipt,
  storage: StorageLike,
): RendererStorageMigrationReceipt {
  if (receipt.phase === "rolled_back") return receipt;
  if (receipt.archiveKey !== null && receipt.selectedLegacyKey !== null) {
    const archived = storage.getItem(receipt.archiveKey);
    if (fingerprint(archived) !== receipt.selectedLegacyHash || archived === null) {
      throw new Error("renderer storage archive changed before rollback");
    }
    const currentLegacy = storage.getItem(receipt.selectedLegacyKey);
    if (currentLegacy !== null && fingerprint(currentLegacy) !== receipt.selectedLegacyHash) {
      throw new Error("renderer storage legacy value changed before rollback");
    }
    if (currentLegacy === null) storage.setItem(receipt.selectedLegacyKey, archived);
    storage.removeItem(receipt.archiveKey);
  }
  if (receipt.createdCanonical) {
    if (fingerprint(storage.getItem(receipt.currentKey)) !== receipt.canonicalAfterHash) {
      throw new Error("renderer storage canonical value changed before rollback");
    }
    storage.removeItem(receipt.currentKey);
  }
  return { ...receipt, phase: "rolled_back" };
}

export function createRendererStorage(id: string, storage: StorageLike) {
  let migration = prepareRendererStorageMigration(id, storage);
  const key = `${CURRENT_STORAGE_PREFIX}${id}`;
  const read = (): Record<string, unknown> => parseRecord(storage.getItem(key)) ?? {};
  const write = (value: Record<string, unknown>) => storage.setItem(key, JSON.stringify(value));
  return {
    get migration() { return migration; },
    commitMigration: () => {
      migration = commitRendererStorageMigration(migration, storage);
      return migration;
    },
    rollbackMigration: () => {
      migration = rollbackRendererStorageMigration(migration, storage);
      return migration;
    },
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

/**
 * Exercise the exact prepare/commit/rollback path used by a promotion probe.
 * Every synthetic key is removed and verified before success is returned;
 * cleanup failure is a failed health result, never a silent residue.
 */
export function verifyRendererStorageRollback(
  storage: StorageLike,
  nonce: string,
): "pass" | "fail" {
  const suffix = `promotion-health-original-${nonce}`;
  const currentId = `co.tweakers.${suffix}`;
  const currentKey = `${CURRENT_STORAGE_PREFIX}${currentId}`;
  const legacyKey = `${LEGACY_STORAGE_PREFIX}co.promotion-probe.${suffix}`;
  const expectedArchiveKey = `${ARCHIVE_STORAGE_PREFIX}${nonce}:${encodeURIComponent(legacyKey)}`;
  const raw = JSON.stringify({ retained: true, nonce });
  let ownsProbeKeys = false;
  let result: "pass" | "fail" = "fail";
  let cleanupSucceeded = true;

  try {
    if (storage.getItem(currentKey) !== null || storage.getItem(legacyKey) !== null) {
      result = "fail";
    } else {
      ownsProbeKeys = true;
      storage.setItem(legacyKey, raw);
      const prepared = prepareRendererStorageMigration(currentId, storage, nonce);
      if (prepared.status !== "prepared" || prepared.holdPromotion || storage.getItem(currentKey) !== raw) {
        result = "fail";
      } else {
        const committed = commitRendererStorageMigration(prepared, storage);
        if (
          committed.phase !== "committed"
          || committed.archiveKey !== expectedArchiveKey
          || storage.getItem(legacyKey) !== null
        ) {
          result = "fail";
        } else {
          const rolledBack = rollbackRendererStorageMigration(committed, storage);
          result = rolledBack.phase === "rolled_back"
            && storage.getItem(legacyKey) === raw
            && storage.getItem(currentKey) === null
            && storage.getItem(expectedArchiveKey) === null
            ? "pass"
            : "fail";
        }
      }
    }
  } catch {
    result = "fail";
  } finally {
    if (ownsProbeKeys) {
      const removeAndVerify = (key: string): boolean => {
        try {
          storage.removeItem(key);
          return storage.getItem(key) === null;
        } catch {
          return false;
        }
      };
      cleanupSucceeded = removeAndVerify(currentKey) && cleanupSucceeded;
      cleanupSucceeded = removeAndVerify(legacyKey) && cleanupSucceeded;
      cleanupSucceeded = removeAndVerify(expectedArchiveKey) && cleanupSucceeded;
    }
  }

  return result === "pass" && cleanupSucceeded ? "pass" : "fail";
}
