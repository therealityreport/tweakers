import { isPlainRecord, type OpaqueAccountId } from "./types";

export const MODEL_CATALOG_TTL_MS = 10 * 60_000;
export const MODEL_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
export const MODEL_CATALOG_MAX_CONCURRENCY = 4;

export interface AccountModelSupportV1 {
  native: boolean;
  eligible: Set<OpaqueAccountId>;
  unsupported: Set<OpaqueAccountId>;
}

interface CachedCatalog {
  expiresAt: number;
  names: Set<string> | null;
}

export class AccountModelCatalogsV1 {
  private readonly cache = new Map<OpaqueAccountId, CachedCatalog>();
  private readonly inFlight = new Map<OpaqueAccountId, Promise<Set<string> | null>>();

  constructor(
    private readonly fetchCatalog: (account: OpaqueAccountId) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async support(model: string, accounts: readonly OpaqueAccountId[]): Promise<AccountModelSupportV1> {
    if (model.length === 0) return { native: false, eligible: new Set(accounts), unsupported: new Set() };
    const catalogs = new Map<OpaqueAccountId, Set<string> | null>();
    for (let offset = 0; offset < accounts.length; offset += MODEL_CATALOG_MAX_CONCURRENCY) {
      const batch = accounts.slice(offset, offset + MODEL_CATALOG_MAX_CONCURRENCY);
      const values = await Promise.all(batch.map((account) => this.catalog(account)));
      batch.forEach((account, index) => catalogs.set(account, values[index] ?? null));
    }
    const native = [...catalogs.values()].some((names) => names?.has(model) === true);
    if (!native) return { native: false, eligible: new Set(accounts), unsupported: new Set() };
    const eligible = new Set<OpaqueAccountId>();
    const unsupported = new Set<OpaqueAccountId>();
    for (const account of accounts) {
      const names = catalogs.get(account) ?? null;
      if (names === null || names.has(model)) eligible.add(account); else unsupported.add(account);
    }
    return { native: true, eligible, unsupported };
  }

  private catalog(account: OpaqueAccountId): Promise<Set<string> | null> {
    const cached = this.cache.get(account);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.names ? new Set(cached.names) : null);
    const active = this.inFlight.get(account);
    if (active) return active;
    const request = this.fetchCatalog(account).then(parseModelCatalogV1, () => null).then((names) => {
      this.cache.set(account, { expiresAt: this.now() + MODEL_CATALOG_TTL_MS, names: names ? new Set(names) : null });
      return names;
    }).finally(() => this.inFlight.delete(account));
    this.inFlight.set(account, request);
    return request;
  }
}

export function requestedModelFromParamsV1(params: unknown): string | null {
  if (!isPlainRecord(params) || !Object.prototype.hasOwnProperty.call(params, "model")) return null;
  return typeof params.model === "string" && params.model.length > 0 && params.model.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(params.model) ? params.model : null;
}

export function parseModelCatalogV1(value: unknown): Set<string> | null {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { return null; }
  if (Buffer.byteLength(encoded, "utf8") > MODEL_CATALOG_MAX_BYTES || !isPlainRecord(value)) return null;
  const models = Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : null;
  if (!models || models.length > 10_000) return null;
  const names = new Set<string>();
  for (const model of models) {
    if (!isPlainRecord(model)) return null;
    const slug = typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : null;
    if (!slug || slug.length > 256 || /[\u0000-\u001f\u007f]/.test(slug)) return null;
    names.add(slug);
  }
  return names;
}
