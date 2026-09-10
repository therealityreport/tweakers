"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountModelCatalogsV1 = exports.MODEL_CATALOG_MAX_CONCURRENCY = exports.MODEL_CATALOG_MAX_BYTES = exports.MODEL_CATALOG_TTL_MS = void 0;
exports.requestedModelFromParamsV1 = requestedModelFromParamsV1;
exports.parseModelCatalogV1 = parseModelCatalogV1;
const types_1 = require("./types");
exports.MODEL_CATALOG_TTL_MS = 10 * 60_000;
exports.MODEL_CATALOG_MAX_BYTES = 4 * 1024 * 1024;
exports.MODEL_CATALOG_MAX_CONCURRENCY = 4;
class AccountModelCatalogsV1 {
    fetchCatalog;
    now;
    cache = new Map();
    inFlight = new Map();
    constructor(fetchCatalog, now = Date.now) {
        this.fetchCatalog = fetchCatalog;
        this.now = now;
    }
    async support(model, accounts) {
        if (model.length === 0)
            return { native: false, eligible: new Set(accounts), unsupported: new Set() };
        const catalogs = new Map();
        for (let offset = 0; offset < accounts.length; offset += exports.MODEL_CATALOG_MAX_CONCURRENCY) {
            const batch = accounts.slice(offset, offset + exports.MODEL_CATALOG_MAX_CONCURRENCY);
            const values = await Promise.all(batch.map((account) => this.catalog(account)));
            batch.forEach((account, index) => catalogs.set(account, values[index] ?? null));
        }
        const native = [...catalogs.values()].some((names) => names?.has(model) === true);
        if (!native)
            return { native: false, eligible: new Set(accounts), unsupported: new Set() };
        const eligible = new Set();
        const unsupported = new Set();
        for (const account of accounts) {
            const names = catalogs.get(account) ?? null;
            if (names === null || names.has(model))
                eligible.add(account);
            else
                unsupported.add(account);
        }
        return { native: true, eligible, unsupported };
    }
    catalog(account) {
        const cached = this.cache.get(account);
        if (cached && cached.expiresAt > this.now())
            return Promise.resolve(cached.names ? new Set(cached.names) : null);
        const active = this.inFlight.get(account);
        if (active)
            return active;
        const request = this.fetchCatalog(account).then(parseModelCatalogV1, () => null).then((names) => {
            this.cache.set(account, { expiresAt: this.now() + exports.MODEL_CATALOG_TTL_MS, names: names ? new Set(names) : null });
            return names;
        }).finally(() => this.inFlight.delete(account));
        this.inFlight.set(account, request);
        return request;
    }
}
exports.AccountModelCatalogsV1 = AccountModelCatalogsV1;
function requestedModelFromParamsV1(params) {
    if (!(0, types_1.isPlainRecord)(params) || !Object.prototype.hasOwnProperty.call(params, "model"))
        return null;
    return typeof params.model === "string" && params.model.length > 0 && params.model.length <= 256
        && !/[\u0000-\u001f\u007f]/.test(params.model) ? params.model : null;
}
function parseModelCatalogV1(value) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        return null;
    }
    if (Buffer.byteLength(encoded, "utf8") > exports.MODEL_CATALOG_MAX_BYTES || !(0, types_1.isPlainRecord)(value))
        return null;
    const models = Array.isArray(value.models) ? value.models : Array.isArray(value.data) ? value.data : null;
    if (!models || models.length > 10_000)
        return null;
    const names = new Set();
    for (const model of models) {
        if (!(0, types_1.isPlainRecord)(model))
            return null;
        const slug = typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : null;
        if (!slug || slug.length > 256 || /[\u0000-\u001f\u007f]/.test(slug))
            return null;
        names.add(slug);
    }
    return names;
}
//# sourceMappingURL=models.js.map