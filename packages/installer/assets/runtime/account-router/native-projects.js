"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeProjectLinksV1 = void 0;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const state_store_1 = require("./state-store");
const types_1 = require("./types");
const FILE = "native-project-links.v1.json";
const MAX_BYTES = 1024 * 1024;
const MAX_LINKS = 512;
/** A small native project-ID mapping; never contains transcripts, thread IDs, or profile data. */
class NativeProjectLinksV1 {
    root;
    metadataAccountId;
    secret;
    request;
    links;
    failed = false;
    inFlight = new Map();
    constructor(root, metadataAccountId, secret, request) {
        this.root = root;
        this.metadataAccountId = metadataAccountId;
        this.secret = secret;
        this.request = request;
        if (!(0, types_1.isOpaqueAccountId)(metadataAccountId) || secret.length !== 32)
            throw new Error("invalid native project registry identity");
        const path = (0, node_path_1.join)(root, FILE);
        if (!(0, node_fs_1.existsSync)(path)) {
            this.links = [];
            return;
        }
        (0, state_store_1.assertPrivateRegularFile)(path, MAX_BYTES);
        const value = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
        if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join() !== "links,metadataAccountId,version" || value.version !== 1 || value.metadataAccountId !== metadataAccountId || !Array.isArray(value.links) || value.links.length > MAX_LINKS)
            throw new Error("invalid native project registry");
        this.links = value.links.map((entry) => {
            if (!(0, types_1.isPlainRecord)(entry) || Object.keys(entry).sort().join() !== "account,digest,imported,sourceProjectId,targetProjectId" || !validId(entry.sourceProjectId) || !(0, types_1.isOpaqueAccountId)(entry.account) || entry.account === metadataAccountId || !(entry.targetProjectId === null || validId(entry.targetProjectId)) || !(entry.digest === null || (typeof entry.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(entry.digest))))
                throw new Error("invalid native project link");
            const imported = content(entry.imported);
            if (!imported)
                throw new Error("invalid native project content");
            return { sourceProjectId: entry.sourceProjectId, account: entry.account, targetProjectId: entry.targetProjectId, digest: entry.digest, imported };
        });
        if (new Set(this.links.map((l) => `${l.account}\0${l.sourceProjectId}`)).size !== this.links.length)
            throw new Error("duplicate native project link");
        const targets = this.links.filter((l) => l.targetProjectId !== null).map((l) => `${l.account}\0${l.targetProjectId}`);
        if (new Set(targets).size !== targets.length)
            throw new Error("ambiguous native project link");
    }
    projectForAccount(sourceProjectId, account) {
        if (this.failed || !validId(sourceProjectId))
            return null;
        return account === this.metadataAccountId ? sourceProjectId : this.links.find((l) => l.account === account && l.sourceProjectId === sourceProjectId)?.targetProjectId ?? null;
    }
    publicProjectId(account, nativeProjectId) {
        if (this.failed || !validId(nativeProjectId))
            return null;
        return account === this.metadataAccountId ? nativeProjectId : this.links.find((l) => l.account === account && l.targetProjectId === nativeProjectId)?.sourceProjectId ?? null;
    }
    ensureProjectForAccount(sourceProjectId, account) {
        if (this.failed || !validId(sourceProjectId) || !(0, types_1.isOpaqueAccountId)(account))
            return Promise.resolve(null);
        const key = `${account}\0${sourceProjectId}`;
        const running = this.inFlight.get(key);
        if (running)
            return running;
        const work = this.ensure(sourceProjectId, account).catch(() => null).finally(() => this.inFlight.delete(key));
        this.inFlight.set(key, work);
        return work;
    }
    async ensure(sourceProjectId, account) {
        const original = project(await this.request(this.metadataAccountId, "project/read", { projectId: sourceProjectId }), sourceProjectId);
        if (!original)
            return null;
        if (account === this.metadataAccountId)
            return sourceProjectId;
        let link = this.links.find((l) => l.sourceProjectId === sourceProjectId && l.account === account);
        if (!link) {
            if (this.links.length >= MAX_LINKS)
                return null;
            link = { sourceProjectId, account, targetProjectId: null, imported: original.content, digest: null };
            this.links.push(link);
            this.persist();
        }
        if (!link.targetProjectId) {
            // Preserve the first request exactly across ambiguous responses/restarts.
            const idempotencyKey = (0, node_crypto_1.createHmac)("sha256", this.secret).update(`native-project:v1\0${this.metadataAccountId}\0${account}\0${sourceProjectId}`).digest("hex");
            const result = project(await this.request(account, "project/import", { ...link.imported, metadata: {}, threads: null, idempotencyKey }));
            if (!result || digest(result.content) !== digest(link.imported))
                return null;
            if (this.links.some((other) => other !== link && other.account === account && other.targetProjectId === result.id))
                return null;
            link.targetProjectId = result.id;
            link.digest = digest(result.content);
            this.persist();
        }
        // Re-read target so external deletion/edits cannot leave a stale proven mapping.
        const current = project(await this.request(account, "project/read", { projectId: link.targetProjectId }), link.targetProjectId);
        if (!current)
            return null;
        const expected = digest(original.content);
        if (digest(current.content) !== expected) {
            const updated = project(await this.request(account, "project/update", { projectId: link.targetProjectId, ...original.content, metadata: {} }), link.targetProjectId);
            if (!updated || digest(updated.content) !== expected)
                return null;
        }
        if (link.digest !== expected) {
            link.digest = expected;
            this.persist();
        }
        return link.targetProjectId;
    }
    persist() {
        try {
            (0, state_store_1.writePrivateJsonAtomicBounded)(this.root, FILE, { version: 1, metadataAccountId: this.metadataAccountId, links: this.links }, MAX_BYTES);
        }
        catch (error) {
            this.failed = true;
            throw error;
        }
    }
}
exports.NativeProjectLinksV1 = NativeProjectLinksV1;
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value); }
function content(value) {
    if (!(0, types_1.isPlainRecord)(value) || typeof value.name !== "string" || value.name.length < 1 || value.name.length > 512 || /[\u0000-\u001f\u007f]/.test(value.name) || !Array.isArray(value.roots) || value.roots.length > 32)
        return null;
    const roots = [];
    for (const root of value.roots) {
        if (!(0, types_1.isPlainRecord)(root) || Object.keys(root).join() !== "path" || typeof root.path !== "string" || root.path.length > 4096 || !(0, node_path_1.isAbsolute)(root.path) || (0, node_path_1.normalize)(root.path) !== root.path || /[\u0000-\u001f\u007f]/.test(root.path))
            return null;
        roots.push({ path: root.path });
    }
    if (new Set(roots.map((r) => r.path)).size !== roots.length)
        return null;
    const result = { name: value.name, roots };
    return Buffer.byteLength(JSON.stringify(result)) <= 16 * 1024 ? result : null;
}
function project(value, expectedId) {
    if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.project) || !validId(value.project.id) || (expectedId !== undefined && value.project.id !== expectedId))
        return null;
    const parsed = content(value.project);
    return parsed ? { id: value.project.id, content: parsed } : null;
}
function digest(value) { return `sha256:${(0, node_crypto_1.createHash)("sha256").update(JSON.stringify(value)).digest("hex")}`; }
//# sourceMappingURL=native-projects.js.map