"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SharedPluginLedgerStoreV1 = exports.sharedPluginDescriptorResponseDigestV1 = exports.SharedPreparationErrorV1 = exports.SHARED_PREPARATION_STAGES_V1 = void 0;
exports.sharedPreparationStageV1 = sharedPreparationStageV1;
exports.sharedPluginWithheldReasonV1 = sharedPluginWithheldReasonV1;
exports.readSharedPluginRemoteIdentityV1 = readSharedPluginRemoteIdentityV1;
exports.parseSharedPluginRemoteDescriptorV1 = parseSharedPluginRemoteDescriptorV1;
exports.runSharedPluginProjectionWorkerV1 = runSharedPluginProjectionWorkerV1;
/** Local definition custody. Nothing in this ledger proves cloud installation or login. */
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_worker_threads_1 = require("node:worker_threads");
const account_continuity_1 = require("./account-continuity");
const types_1 = require("./types");
exports.SHARED_PREPARATION_STAGES_V1 = ["parent-authority", "generation-lease", "worker-runtime", "sealed-generation", "native-source", "execution-layout", "account-receipt", "account-payload", "account-catalogue", "publication", "cancelled", "prior-auth", "parent-admission", "post-projection", "resolver-binary", "spawn", "child-session", "client-session", "handoff", "ledger-service", "service-invalid", "home-auth", "helper-busy", "account-excluded"];
function sharedPreparationStageV1(value) {
    return typeof value === "string" && exports.SHARED_PREPARATION_STAGES_V1.includes(value) ? value : undefined;
}
class SharedPreparationErrorV1 extends Error {
    preparationStage;
    constructor(preparationStage) {
        super("shared plugin projection failed");
        this.preparationStage = preparationStage;
    }
}
exports.SharedPreparationErrorV1 = SharedPreparationErrorV1;
const REMOTE_MARKETS = new Set(["openai-curated-remote", "created-by-me-remote", "workspace-directory", "workspace-shared-with-me", "workspace-shared-with-me-private", "workspace-shared-with-me-unlisted"]);
const segment = (s) => typeof s === "string" && /^[A-Za-z0-9_.+-]{1,255}$/.test(s) && s !== "." && s !== "..";
const pluginId = (s) => typeof s === "string" && s.length <= 512 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*@[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(s) && s.split("@").every(segment);
const hash = (s) => (0, node_crypto_1.createHash)("sha256").update(s).digest("hex");
const sharedPluginDescriptorResponseDigestV1 = (response) => hash(canonical(response));
exports.sharedPluginDescriptorResponseDigestV1 = sharedPluginDescriptorResponseDigestV1;
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if ((0, types_1.isPlainRecord)(value))
        return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    if (value === null || ["string", "boolean", "number"].includes(typeof value))
        return JSON.stringify(value);
    throw new Error("invalid local plugin ledger value");
}
function safeDirectory(path, create = false, ownerPrivate = true) {
    const absolute = (0, node_path_1.resolve)(path), parts = absolute.split(node_path_1.sep).filter(Boolean);
    let current = node_path_1.sep;
    for (const part of parts) {
        current = (0, node_path_1.join)(current, part);
        try {
            const s = (0, node_fs_1.lstatSync)(current);
            if (!s.isDirectory() || s.isSymbolicLink())
                throw new Error("unsafe ledger directory");
        }
        catch (error) {
            if (error.code !== "ENOENT" || !create)
                throw error;
            (0, node_fs_1.mkdirSync)(current, { mode: 0o700 });
        }
    }
    const s = (0, node_fs_1.lstatSync)(absolute);
    if (s.uid !== process.getuid?.() || (s.mode & (ownerPrivate ? 0o077 : 0o022)))
        throw new Error("ledger directory has unsafe ownership or permissions");
}
function readJson(path, ownerPrivate = true) {
    let fd;
    try {
        fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
    try {
        const s = (0, node_fs_1.fstatSync)(fd);
        if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & (ownerPrivate ? 0o077 : 0o022)) || s.size > 4 * 1024 * 1024)
            throw new Error("unsafe ledger document");
        return JSON.parse((0, node_fs_1.readFileSync)(fd, "utf8"));
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
}
function writeJson(path, value) {
    safeDirectory((0, node_path_1.dirname)(path));
    const temporary = `${path}.${(0, node_crypto_1.randomUUID)()}.tmp`, bytes = canonical(value);
    const fd = (0, node_fs_1.openSync)(temporary, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, 0o600);
    try {
        (0, node_fs_1.writeFileSync)(fd, bytes);
        (0, node_fs_1.fsyncSync)(fd);
    }
    finally {
        (0, node_fs_1.closeSync)(fd);
    }
    (0, node_fs_1.renameSync)(temporary, path);
    const dir = (0, node_fs_1.openSync)((0, node_path_1.dirname)(path), node_fs_1.constants.O_RDONLY);
    try {
        (0, node_fs_1.fsyncSync)(dir);
    }
    finally {
        (0, node_fs_1.closeSync)(dir);
    }
}
function privateIdentity(home) {
    safeDirectory(home);
    const s = (0, node_fs_1.lstatSync)(home);
    return `${s.dev}:${s.ino}:${s.uid}`;
}
function disjoint(a, b) { return a !== b && !a.startsWith(b + node_path_1.sep) && !b.startsWith(a + node_path_1.sep); }
const WITHHELD_REASON = "Plugin definition is unsafe to share; its native installation remains unchanged.";
function sharedPluginWithheldReasonV1(error) {
    return (0, account_continuity_1.officialPluginDefinitionWithheldReasonV1)(error);
}
/** Real upstream marker has only these two fields; no ID can be inferred from names. */
function readSharedPluginRemoteIdentityV1(packageRoot) {
    safeDirectory(packageRoot, false, false);
    const value = readJson((0, node_path_1.join)(packageRoot, ".codex-remote-plugin-install.json"), false);
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join() !== "remote_plugin_id,schema_version" || value.schema_version !== 1
        || typeof value.remote_plugin_id !== "string" || !/^[A-Za-z0-9_~\-]{1,512}$/.test(value.remote_plugin_id))
        throw new Error("shared remote plugin is missing validated installation identity");
    return value.remote_plugin_id;
}
/** Keep only real nonsecret descriptor fields; provider availability/auth state is not stored. */
function parseSharedPluginRemoteDescriptorV1(id, version, remoteId, response, provenance) {
    if (!pluginId(id) || !segment(version) || !/^[A-Za-z0-9_~\-]{1,512}$/.test(remoteId) || !(0, types_1.isPlainRecord)(response)
        || response.id !== remoteId || response.name !== id.split("@")[0] || !(0, types_1.isPlainRecord)(response.release)
        || response.release.version !== version || !(0, types_1.isPlainRecord)(response.release.interface))
        throw new Error("remote descriptor does not match canonical installed package");
    const r = response.release, releaseInterface = r.interface;
    const scope = response.scope;
    const marketplace = scope === "GLOBAL" ? "openai-curated-remote" : scope === "USER" ? "created-by-me-remote"
        : scope === "WORKSPACE" ? response.discoverability === "LISTED" ? "workspace-directory" : ["PRIVATE", "UNLISTED"].includes(String(response.discoverability)) ? "workspace-shared-with-me" : null : null;
    if (marketplace !== id.split("@")[1] || !["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(String(response.installation_policy))
        || !["ON_INSTALL", "ON_USE"].includes(String(response.authentication_policy)) || typeof r.display_name !== "string" || typeof r.description !== "string"
        || provenance.kind !== "selected-account-detail" || ![provenance.actor, provenance.authIdentity, provenance.sessionStamp].every(s => typeof s === "string" && s.length > 0)
        || provenance.responseDigest !== hash(canonical(response)))
        throw new Error("remote descriptor provenance or scope is incomplete");
    // Text-only declaration fields. Presigned URLs, account names, principals and arbitrary metadata stay out.
    const text = (v) => { if (typeof v !== "string" || v.length > 32_768 || /(?:Bearer\s+|-----BEGIN .*PRIVATE KEY|[?&](?:token|signature|key)=)/i.test(v))
        throw new Error("unsafe remote declaration text"); return v; };
    const list = (v) => { if (v === undefined)
        return []; if (!Array.isArray(v) || v.length > 2048)
        throw new Error("invalid remote declaration list"); return v; };
    const descriptor = {
        remoteId, scope: scope,
        ...(scope === "WORKSPACE" ? { discoverability: response.discoverability } : {}),
        installationPolicy: response.installation_policy,
        authenticationPolicy: response.authentication_policy,
        ...(typeof response.must_show_installation_interstitial === "boolean" ? { mustShowInstallationInterstitial: response.must_show_installation_interstitial } : {}),
        release: { version, display_name: text(r.display_name), description: text(r.description), interface: {},
            app_ids: list(r.app_ids).map(text),
            mcp_servers: list(r.mcp_servers).map(v => { if (!(0, types_1.isPlainRecord)(v))
                throw new Error("invalid remote MCP declaration"); return { key: text(v.key) }; }),
            skills: list(r.skills).map(v => { if (!(0, types_1.isPlainRecord)(v))
                throw new Error("invalid remote skill declaration"); return { name: text(v.name), description: text(v.description), interface: v.interface ?? null }; }) },
        provenance: { kind: provenance.kind, actor: provenance.actor, authIdentity: provenance.authIdentity, sessionStamp: provenance.sessionStamp, responseDigest: provenance.responseDigest },
    };
    for (const key of ["short_description", "long_description", "developer_name", "category", "brand_color", "default_prompt"]) {
        const v = releaseInterface[key];
        if (v !== undefined && v !== null)
            descriptor.release.interface[key] = text(v);
    }
    for (const key of ["capabilities", "default_prompts"])
        if (releaseInterface[key] !== undefined && releaseInterface[key] !== null)
            descriptor.release.interface[key] = list(releaseInterface[key]).map(text);
    for (const key of ["website_url", "privacy_policy_url", "terms_of_service_url", "composer_icon_url", "logo_url", "logo_url_dark", "screenshot_urls"]) {
        if (releaseInterface[key] !== undefined)
            descriptor.release.interface[key] = structuredClone(releaseInterface[key]);
    }
    for (const key of ["app_manifest", "keywords", "onboarding_skill_name"])
        if (r[key] !== undefined)
            descriptor.release[key] = structuredClone(r[key]);
    if (r.app_templates !== undefined)
        descriptor.release.app_templates = list(r.app_templates).map(template => {
            if (!(0, types_1.isPlainRecord)(template))
                throw new Error("invalid remote App template declaration");
            return Object.fromEntries(["template_id", "name", "description", "category", "canonical_connector_id", "logo_url", "logo_url_dark"]
                .filter(key => template[key] !== undefined).map(key => [key, structuredClone(template[key])]));
        });
    (0, account_continuity_1.assertNonsecretDefinitionJsonV1)(descriptor.release);
    return descriptor;
}
function validateDescriptor(entry) {
    const d = entry.remote;
    if (!d)
        return;
    if (!(0, types_1.isPlainRecord)(d) || Object.keys(d).some(k => !["remoteId", "scope", "discoverability", "installationPolicy", "authenticationPolicy", "mustShowInstallationInterstitial", "release", "provenance"].includes(k))
        || !(0, types_1.isPlainRecord)(d.release) || !(0, types_1.isPlainRecord)(d.provenance)
        || Object.keys(d.provenance).sort().join() !== "actor,authIdentity,kind,responseDigest,sessionStamp"
        || Object.keys(d.release).some(k => !["version", "display_name", "description", "interface", "app_ids", "mcp_servers", "skills", "app_manifest", "app_templates", "keywords", "onboarding_skill_name"].includes(k)))
        throw new Error("shared remote descriptor contains unowned fields");
    if (!/^[A-Za-z0-9_~\-]{1,512}$/.test(d.remoteId) || d.release.version !== entry.version
        || !["GLOBAL", "USER", "WORKSPACE"].includes(d.scope) || !["AVAILABLE", "NOT_AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(d.installationPolicy)
        || !["ON_INSTALL", "ON_USE"].includes(d.authenticationPolicy) || d.provenance.kind !== "selected-account-detail"
        || !/^[a-f0-9]{64}$/.test(d.provenance.responseDigest))
        throw new Error("invalid shared remote descriptor");
    const market = d.scope === "GLOBAL" ? "openai-curated-remote" : d.scope === "USER" ? "created-by-me-remote" : d.discoverability === "LISTED" ? "workspace-directory" : ["PRIVATE", "UNLISTED"].includes(String(d.discoverability)) ? "workspace-shared-with-me" : null;
    if (market !== entry.id.split("@")[1])
        throw new Error("shared remote descriptor canonical scope changed");
    (0, account_continuity_1.assertNonsecretDefinitionJsonV1)(d.release);
}
class SharedPluginLedgerStoreV1 {
    input;
    root;
    tickets = new Map();
    sourceWatchers = [];
    sourceVersionRoots = new Set();
    sourceRevision = 0;
    sourceWatchFailed = false;
    closed = false;
    sourceLease = null;
    pendingSourceProof = null;
    projectionTail = Promise.resolve();
    activeProjection = null;
    constructor(input) {
        this.input = input;
        this.root = (0, node_path_1.resolve)(input.root);
        if (!disjoint(this.root, (0, node_path_1.resolve)(input.sourceHome)) || ![input.authority.sourceAccountId, input.authority.sourceRootIdentity, input.authority.modeFingerprint].every(s => typeof s === "string" && s.length))
            throw new Error("invalid shared plugin ledger authority");
        safeDirectory(this.root, true);
        // One owner, established before any source validation. These never retain
        // the process and are explicitly released by the broker's store owner.
        const invalidate = () => { this.sourceRevision++; this.sourceLease = null; this.pendingSourceProof = null; };
        const addWatch = (path, recursive, relevant) => {
            try {
                const watcher = (0, node_fs_1.watch)(path, { recursive }, (_event, filename) => {
                    if (filename === null || relevant(filename.toString()))
                        invalidate();
                });
                watcher.on("error", () => { this.sourceWatchFailed = true; invalidate(); });
                watcher.unref();
                this.sourceWatchers.push(watcher);
            }
            catch {
                this.sourceWatchFailed = true;
                invalidate();
            }
        };
        addWatch((0, node_path_1.join)((0, node_path_1.resolve)(input.sourceHome), "plugins", "cache"), true, name => this.sourceChangeRelevant(name));
        addWatch((0, node_path_1.resolve)(input.sourceHome), false, name => name === "config.toml" || name === "plugins");
    }
    close() {
        this.closed = true;
        this.sourceLease = null;
        this.pendingSourceProof = null;
        this.tickets.clear();
        for (const watcher of this.sourceWatchers.splice(0))
            watcher.close();
    }
    sourceChangeRelevant(name) {
        if (!(0, account_continuity_1.officialPluginSourceChangeRelevantV1)(name))
            return false;
        if (!this.input.localLibrary)
            return true;
        const parts = name.replace(/\\/g, "/").split("/");
        // Local-library custody excludes native account installation markers.
        // Native refresh may replace one atomically using a plugin-root temp file.
        if (parts.includes(".codex-remote-plugin-install.json"))
            return false;
        if (parts.length !== 3 || !parts.every(segment))
            return true;
        const relativePath = parts.join("/");
        if (this.sourceVersionRoots.has(relativePath))
            return true;
        try {
            const stat = (0, node_fs_1.lstatSync)((0, node_path_1.join)(this.input.sourceHome, "plugins", "cache", ...parts));
            if (stat.isDirectory())
                this.sourceVersionRoots.add(relativePath);
            // A file at market/plugin/file is outside every package version.
            // Unknown symlinks and other filesystem types still revoke authority.
            return !stat.isFile();
        }
        catch (error) {
            return error.code !== "ENOENT";
        }
    }
    sourceIdentity() {
        return [(0, node_path_1.resolve)(this.input.sourceHome), (0, node_path_1.join)((0, node_path_1.resolve)(this.input.sourceHome), "plugins", "cache"), (0, node_path_1.join)((0, node_path_1.resolve)(this.input.sourceHome), "config.toml")].map(path => {
            const s = (0, node_fs_1.lstatSync)(path);
            if (s.isSymbolicLink() || s.uid !== process.getuid?.() || s.mode & 0o022)
                throw new Error("native plugin source identity changed");
            return `${s.dev}:${s.ino}:${s.mode}:${path.endsWith("config.toml") ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}` : ""}`;
        }).join("|");
    }
    /** Full source proof; one queued-change race may require one fresh proof. */
    async readNativeSnapshot() {
        if (this.closed)
            throw new Error("shared plugin store is closed");
        // Fresh source initialization can enqueue watch notifications after the
        // first immediate callback. Let the poll loop settle before the full proof.
        await new Promise(resolve => setTimeout(resolve, 50));
        const pending = this.pendingSourceProof;
        if (!this.closed && !this.sourceWatchFailed && pending && pending.revision === this.sourceRevision
            && pending.identity === this.sourceIdentity())
            return structuredClone(pending.snapshot);
        this.pendingSourceProof = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            if (this.closed)
                throw new Error("shared plugin store is closed");
            if (this.sourceWatchFailed)
                throw new Error("native installed plugin revision changed during validation");
            const revision = this.sourceRevision, identity = this.sourceIdentity();
            const snapshot = (0, account_continuity_1.readOfficialInstalledPluginSnapshotV1)(this.input.sourceHome);
            for (const plugin of snapshot.plugins)
                if (plugin.version) {
                    const [name, market] = plugin.id.split("@");
                    this.sourceVersionRoots.add(`${market}/${name}/${plugin.version}`);
                }
            await new Promise(resolve => setImmediate(resolve));
            if (this.closed)
                throw new Error("shared plugin store is closed");
            if (!this.sourceWatchFailed && revision === this.sourceRevision && identity === this.sourceIdentity()) {
                this.pendingSourceProof = { snapshot: structuredClone(snapshot), revision, identity };
                return snapshot;
            }
            // A fresh native write or a delayed initial notification invalidates the
            // first result. Read current bytes once more; continued drift stays held.
        }
        throw new Error("native installed plugin revision changed during validation");
    }
    async validateSourceLease(ledger) {
        this.assertDefinitionPolicy(ledger);
        await new Promise(resolve => setImmediate(resolve));
        this.assertNativeRemoteIdentities(ledger);
        if (this.verifyGeneration(ledger.fingerprint))
            return;
        this.sourceLease = null;
        const snapshot = await this.readNativeSnapshot();
        if (this.sourceWatchFailed || this.closed || snapshot.fingerprint !== ledger.sourceSnapshotFingerprint)
            throw new Error("native installed plugin revision changed; refresh the shared ledger before execution");
        const revision = this.sourceRevision, identity = this.sourceIdentity();
        // Preparation already performs the default full sealed-package read.
        // Recheck durable generation here without repeating that unchanged proof.
        if (this.readSignedGeneration(false)?.fingerprint !== ledger.fingerprint)
            throw new Error("shared plugin generation changed during validation");
        await new Promise(resolve => setImmediate(resolve));
        if (this.sourceWatchFailed || this.closed || revision !== this.sourceRevision || identity !== this.sourceIdentity())
            throw new Error("native installed plugin revision changed during validation");
        this.assertNativeRemoteIdentities(ledger);
        this.pendingSourceProof = null;
        this.sourceLease = { fingerprint: ledger.fingerprint, revision, identity };
    }
    /** Signed/durable generation fence, never hashes source or sealed trees. */
    verifyGeneration(fingerprint) {
        if (this.closed || this.sourceWatchFailed || !this.sourceLease || this.sourceLease.fingerprint !== fingerprint
            || this.sourceLease.revision !== this.sourceRevision)
            return false;
        try {
            const ledger = this.readSignedGeneration(false);
            // A caller that retained canonical descriptors still needs their exact
            // remote identity, even when the store otherwise projects a local library.
            if (ledger)
                this.assertNativeRemoteIdentities(ledger);
            return this.sourceLease.identity === this.sourceIdentity() && ledger?.fingerprint === fingerprint
                && ledger.definitionPolicyFingerprint === account_continuity_1.OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1;
        }
        catch {
            return false;
        }
    }
    sign(value) { return { value, hmac: (0, node_crypto_1.createHmac)("sha256", this.input.secret).update("shared-plugin-ledger:v1\0" + canonical(value)).digest("hex") }; }
    verify(value) {
        if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join() !== "hmac,value" || typeof value.hmac !== "string" || !/^[a-f0-9]{64}$/.test(value.hmac))
            throw new Error("invalid shared plugin ledger signature");
        const expected = this.sign(value.value).hmac;
        if (!(0, node_crypto_1.timingSafeEqual)(Buffer.from(expected, "hex"), Buffer.from(value.hmac, "hex")))
            throw new Error("invalid shared plugin ledger signature");
        return value.value;
    }
    read() {
        return this.readSignedGeneration(true);
    }
    readSignedGeneration(verifyPackages) {
        if (this.closed)
            throw new Error("shared plugin store is closed");
        if (readJson((0, node_path_1.join)(this.root, "publication-intent.v1.json")) !== null)
            throw new Error("shared plugin publication is uncertain; inspect signed journal before retry");
        const raw = readJson((0, node_path_1.join)(this.root, "head.v1.json"));
        if (raw === null)
            return null;
        const value = this.verify(raw);
        if (!(0, types_1.isPlainRecord)(value) || value.version !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1
            || value.projectionMode !== (this.input.localLibrary ? "local-library-v1" : "canonical-v1") || canonical(value.authority) !== canonical(this.input.authority) || !Array.isArray(value.entries) || value.entries.length > 4096
            || !(value.prior === null || typeof value.prior === "string") || typeof value.sourceSnapshotFingerprint !== "string" || typeof value.fingerprint !== "string")
            throw new Error("invalid shared plugin ledger head");
        if (value.definitionPolicyFingerprint !== undefined && (typeof value.definitionPolicyFingerprint !== "string"
            || !/^sha256:[a-f0-9]{64}$/.test(value.definitionPolicyFingerprint)))
            throw new Error("invalid shared plugin definition policy fingerprint");
        const { fingerprint, ...unsigned } = value;
        if (fingerprint !== hash(canonical(unsigned)))
            throw new Error("shared plugin ledger generation digest changed");
        const ledger = value, ids = new Set(), remoteIds = new Set();
        if (ledger.withheldPlugins !== undefined && (!(0, types_1.isPlainRecord)(ledger.withheldPlugins)
            || Object.entries(ledger.withheldPlugins).some(([id, reason]) => !pluginId(id) || reason !== WITHHELD_REASON)))
            throw new Error("invalid shared plugin withheld definitions");
        for (const entry of ledger.entries) {
            if (!pluginId(entry.id) || ids.has(entry.id) || !segment(entry.version) || !/^sha256:[a-f0-9]{64}$/.test(entry.packageDigest))
                throw new Error("invalid shared plugin ledger entry");
            if (Object.prototype.hasOwnProperty.call(ledger.withheldPlugins ?? {}, entry.id))
                throw new Error("shared plugin definition is both safe and withheld");
            ids.add(entry.id);
            if (!this.input.localLibrary && REMOTE_MARKETS.has(entry.id.split("@")[1]) !== Boolean(entry.remote))
                throw new Error("shared plugin remote identity is incomplete");
            validateDescriptor(entry);
            if (entry.remote) {
                if (remoteIds.has(entry.remote.remoteId))
                    throw new Error("shared plugin remote identity is ambiguous");
                remoteIds.add(entry.remote.remoteId);
            }
            if (verifyPackages && (0, account_continuity_1.captureOfficialPluginPackageV1)(this.packagePath(entry)).digest !== entry.packageDigest)
                throw new Error("sealed shared plugin package changed");
        }
        const generation = readJson((0, node_path_1.join)(this.root, "generations", `${ledger.generation}.json`));
        if (canonical(this.verify(generation)) !== canonical(ledger))
            throw new Error("shared plugin head lacks durable generation custody");
        return ledger;
    }
    packagePath(entry) {
        if (!/^sha256:[a-f0-9]{64}$/.test(entry.packageDigest))
            throw new Error("invalid shared package digest");
        return (0, node_path_1.join)(this.root, "packages", entry.packageDigest.slice(7));
    }
    /** Caller proves current actor and absence of package writers immediately before every publication. */
    publish(input) {
        this.sourceLease = null;
        const lock = (0, node_path_1.join)(this.root, "publication-lock.v1.json");
        const fd = (0, node_fs_1.openSync)(lock, node_fs_1.constants.O_WRONLY | node_fs_1.constants.O_CREAT | node_fs_1.constants.O_EXCL | node_fs_1.constants.O_NOFOLLOW, 0o600);
        try {
            (0, node_fs_1.writeFileSync)(fd, canonical(this.sign({ version: 1, nonce: (0, node_crypto_1.randomUUID)(), expected: input.expected })));
            (0, node_fs_1.fsyncSync)(fd);
        }
        finally {
            (0, node_fs_1.closeSync)(fd);
        }
        try {
            const result = this.publishLocked(input);
            (0, node_fs_1.unlinkSync)(lock);
            return result;
        }
        catch (error) {
            // A retained intent is recovery evidence. A process death retains the exclusive lock too.
            if (readJson((0, node_path_1.join)(this.root, "publication-intent.v1.json")) === null)
                (0, node_fs_1.unlinkSync)(lock);
            throw error;
        }
    }
    publishLocked(input) {
        const prior = this.read();
        if ((prior?.fingerprint ?? null) !== input.expected || !input.authorize())
            throw new Error("stale shared plugin publication authority");
        const sourceIdentity = this.sourceIdentity(), sourceRevision = this.sourceRevision;
        const sourceSnapshot = (0, account_continuity_1.readOfficialInstalledPluginSnapshotV1)(this.input.sourceHome);
        if (input.sourceSnapshotFingerprint !== undefined && input.sourceSnapshotFingerprint !== sourceSnapshot.fingerprint)
            throw new Error("native installed plugin revision changed before publication");
        const installed = sourceSnapshot.plugins.filter(plugin => plugin.version !== null);
        const withheldPlugins = Object.fromEntries(Object.entries(input.withheldPlugins ?? {}).sort(([a], [b]) => a.localeCompare(b)));
        const safeIds = new Set(input.packages.map(candidate => candidate.id));
        if (Object.entries(withheldPlugins).some(([id, reason]) => !pluginId(id) || reason !== WITHHELD_REASON || safeIds.has(id))
            || safeIds.size !== input.packages.length || input.packages.length + Object.keys(withheldPlugins).length !== installed.length
            || installed.some(plugin => !(Object.prototype.hasOwnProperty.call(withheldPlugins, plugin.id)
                || input.packages.some(candidate => candidate.id === plugin.id && candidate.version === plugin.version))))
            throw new Error("follow-native shared list cannot install or remove definitions in Tweakers");
        for (const id of Object.keys(withheldPlugins)) {
            const native = installed.find(plugin => plugin.id === id);
            const [name, market] = id.split("@");
            let reason = null;
            try {
                (0, account_continuity_1.captureOfficialPluginPackageV1)((0, node_path_1.join)((0, node_path_1.resolve)(this.input.sourceHome), "plugins", "cache", market, name, native.version));
            }
            catch (error) {
                reason = sharedPluginWithheldReasonV1(error);
                if (!reason)
                    throw error;
            }
            if (reason !== withheldPlugins[id])
                throw new Error("shared withheld plugin no longer matches its native definition");
        }
        safeDirectory((0, node_path_1.join)(this.root, "packages"), true);
        safeDirectory((0, node_path_1.join)(this.root, "generations"), true);
        const entries = [], ids = new Set(), remoteIds = new Set();
        for (const candidate of input.packages) {
            if (!pluginId(candidate.id) || !segment(candidate.version) || ids.has(candidate.id))
                throw new Error("invalid shared plugin candidate");
            const [name, market] = candidate.id.split("@");
            if ((0, node_path_1.resolve)(candidate.source) !== (0, node_path_1.join)((0, node_path_1.resolve)(this.input.sourceHome), "plugins", "cache", market, name, candidate.version))
                throw new Error("follow-native ledger accepts only exact source package custody");
            ids.add(candidate.id);
            const remoteMarket = REMOTE_MARKETS.has(candidate.id.split("@")[1]);
            if ((!this.input.localLibrary && remoteMarket && !candidate.remote) || candidate.remote && (readSharedPluginRemoteIdentityV1(candidate.source) !== candidate.remote.remoteId || candidate.remote.release.version !== candidate.version))
                throw new Error("shared plugin requires real matching remote descriptor");
            if (!remoteMarket && candidate.remote)
                throw new Error("local plugin cannot acquire a guessed remote identity");
            validateDescriptor(candidate);
            if (candidate.remote) {
                if (remoteIds.has(candidate.remote.remoteId))
                    throw new Error("shared plugin remote identity is ambiguous");
                remoteIds.add(candidate.remote.remoteId);
            }
            const snapshot = (0, account_continuity_1.captureOfficialPluginPackageV1)(candidate.source);
            const entry = { id: candidate.id, version: candidate.version, packageDigest: snapshot.digest, ...(candidate.remote ? { remote: structuredClone(candidate.remote) } : {}) };
            const destination = this.packagePath(entry);
            try {
                (0, node_fs_1.lstatSync)(destination);
                if ((0, account_continuity_1.captureOfficialPluginPackageV1)(destination).digest !== snapshot.digest)
                    throw new Error("existing shared package custody changed");
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                (0, account_continuity_1.copyOfficialPluginPackageV1)(candidate.source, destination, snapshot.digest);
            }
            const seal = (path) => { const s = (0, node_fs_1.lstatSync)(path); if (s.isSymbolicLink())
                return; if (s.isDirectory()) {
                for (const name of (0, node_fs_1.readdirSync)(path))
                    seal((0, node_path_1.join)(path, name));
                (0, node_fs_1.chmodSync)(path, 0o500);
            }
            else
                (0, node_fs_1.chmodSync)(path, s.mode & 0o111 ? 0o500 : 0o400); };
            seal(destination);
            entries.push(entry);
        }
        entries.sort((a, b) => a.id.localeCompare(b.id));
        const value = { version: 1, projectionMode: this.input.localLibrary ? "local-library-v1" : "canonical-v1", authority: this.input.authority, generation: (prior?.generation ?? 0) + 1, prior: prior?.fingerprint ?? null, sourceSnapshotFingerprint: sourceSnapshot.fingerprint, definitionPolicyFingerprint: account_continuity_1.OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1, withheldPlugins, entries };
        const ledger = { ...value, fingerprint: hash(canonical(value)) };
        if (!input.authorize() || this.read()?.fingerprint !== prior?.fingerprint || sourceIdentity !== this.sourceIdentity()
            || sourceRevision !== this.sourceRevision)
            throw new Error("shared plugin publication authority changed during custody");
        const intent = this.sign({ version: 1, prior: input.expected, proposed: ledger.fingerprint, generation: ledger.generation });
        writeJson((0, node_path_1.join)(this.root, "publication-intent.v1.json"), intent);
        writeJson((0, node_path_1.join)(this.root, "generations", `${ledger.generation}.json`), this.sign(ledger));
        if (!input.authorize())
            throw new Error("shared plugin publication is uncertain after authority changed");
        this.assertNativeRevision(ledger);
        writeJson((0, node_path_1.join)(this.root, "head.v1.json"), this.sign(ledger));
        (0, node_fs_1.unlinkSync)((0, node_path_1.join)(this.root, "publication-intent.v1.json"));
        return this.read();
    }
    issueTicket(input) {
        const ledger = this.read();
        if (!ledger || !pluginId(input.pluginId) || ![input.actor, input.childStamp, input.authIdentity, input.sessionStamp, input.rendererRef, input.approvalId, input.installAttemptId].every(s => typeof s === "string" && s.length)
            || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 15 * 60_000)
            throw new Error("invalid shared plugin installation ticket");
        this.assertDefinitionPolicy(ledger);
        for (const [nonce, ticket] of this.tickets)
            if (ticket.expiresAt <= Date.now())
                this.tickets.delete(nonce);
        if (this.tickets.size >= 4096)
            throw new Error("shared plugin installation ticket capacity exceeded");
        const ticket = { ...input, nonce: (0, node_crypto_1.randomUUID)(), generation: ledger.generation, ledgerFingerprint: ledger.fingerprint };
        this.tickets.set(ticket.nonce, ticket);
        return structuredClone(ticket);
    }
    cancelTicket(nonce) { this.tickets.delete(nonce); }
    validateTicket(ticket, current) {
        const stored = this.tickets.get(ticket.nonce), ledger = this.read();
        return Boolean(Object.keys(current).sort().join() === "actor,approvalId,authIdentity,childStamp,installAttemptId,pluginId,rendererRef,sessionStamp"
            && stored && canonical(stored) === canonical(ticket) && ticket.expiresAt > Date.now() && ledger?.fingerprint === ticket.ledgerFingerprint
            && ledger.definitionPolicyFingerprint === account_continuity_1.OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1
            && Object.entries(current).every(([key, value]) => ticket[key] === value));
    }
    /** Read-only proof for a bounded native-owned library; never repairs or projects. */
    verifyAccountProjection(input) {
        const ledger = this.readSignedGeneration(false), home = (0, node_path_1.resolve)(input.home), root = (0, node_path_1.join)((0, node_path_1.resolve)(input.stateRoot), "accounts", input.account);
        if (!/^ar_[A-Za-z0-9_-]{43}$/.test(input.account) || !this.input.localLibrary || !ledger || !this.verifyGeneration(ledger.fingerprint) || home !== (0, node_path_1.join)(root, "execution-home")
            || !disjoint(home, (0, node_path_1.resolve)(this.input.sourceHome)) || input.ids.length === 0 || input.ids.length > 64
            || new Set(input.ids).size !== input.ids.length || !input.ids.every(pluginId))
            throw new Error("Native-owned plugin proof unavailable");
        safeDirectory(root);
        const identity = privateIdentity(home), receiptPath = (0, node_path_1.join)(root, "shared-plugin-projection.v1.json");
        const original = readJson(receiptPath), receipt = this.verify(original);
        const current = () => this.verifyGeneration(ledger.fingerprint) && privateIdentity(home) === identity
            && canonical(readJson(receiptPath)) === canonical(original)
            && readJson((0, node_path_1.join)(root, "shared-plugin-projection-intent.v1.json")) === null
            && readJson((0, node_path_1.join)(root, "plugin-projection-intent.v1.json")) === null;
        if (!current() || !(0, types_1.isPlainRecord)(receipt) || receipt.version !== 1 || receipt.account !== input.account
            || receipt.home !== home || receipt.identity !== identity || receipt.generation !== ledger.generation
            || receipt.ledgerFingerprint !== ledger.fingerprint || receipt.layoutPolicy !== "native-manifest-version-v1"
            || !Array.isArray(receipt.packages) || !Array.isArray(receipt.catalogues))
            throw new Error("Native-owned plugin receipt unavailable");
        const markets = new Set();
        const packages = receipt.packages;
        const result = input.ids.map(id => {
            const entry = ledger.entries.find(entry => entry.id === id);
            if (!entry || ledger.withheldPlugins?.[id])
                throw new Error("Native-owned plugin is unavailable");
            const executionId = (0, account_continuity_1.officialLocalPluginIdV1)(id), version = (0, account_continuity_1.officialLocalPluginExecutionVersionV1)(this.packagePath(entry), entry.version);
            const matches = packages.filter((item) => (0, types_1.isPlainRecord)(item) && item.id === executionId);
            const proof = matches[0];
            if (matches.length !== 1 || !(0, types_1.isPlainRecord)(proof) || proof.version !== version || proof.digest !== entry.packageDigest
                || proof.remoteId !== (entry.remote?.remoteId ?? null))
                throw new Error("Native-owned plugin custody changed");
            const [name, market] = executionId.split("@"), packageRoot = (0, node_path_1.join)(home, "plugins", "cache", market, name, version);
            if ((0, account_continuity_1.captureOfficialPluginPackageV1)(packageRoot).digest !== entry.packageDigest
                || (entry.remote && readSharedPluginRemoteIdentityV1(packageRoot) !== entry.remote.remoteId))
                throw new Error("Native-owned plugin payload changed");
            markets.add(market);
            return { id, version: entry.version };
        });
        for (const market of markets) {
            const matches = receipt.catalogues.filter((item) => (0, types_1.isPlainRecord)(item) && item.market === market);
            const proof = matches[0], value = readJson((0, node_path_1.join)(home, "plugins", "cache", market, ".agents", "plugins", "marketplace.json"));
            if (matches.length !== 1 || !(0, types_1.isPlainRecord)(proof) || value === null || hash(canonical(value)) !== proof.digest)
                throw new Error("Native-owned plugin catalogue changed");
        }
        if (!current())
            throw new Error("Native-owned plugin authority changed");
        return result;
    }
    /** A process-local worker lease, never a durable recovery or HTTP authority. */
    ownsPendingProjection(stateRoot, account) {
        const active = this.activeProjection;
        if (!active || this.closed || active.stateRoot !== (0, node_path_1.resolve)(stateRoot) || active.account !== account
            || Atomics.load(active.cancellation, 0) !== 0 || !this.verifyGeneration(active.fingerprint))
            return false;
        try {
            const root = (0, node_path_1.join)(active.stateRoot, "accounts", account);
            safeDirectory(root);
            if (privateIdentity(active.home) !== active.identity)
                return false;
            const intent = this.verify(readJson((0, node_path_1.join)(root, "shared-plugin-projection-intent.v1.json")));
            const prior = readJson((0, node_path_1.join)(root, "shared-plugin-projection.v1.json"));
            if (!(0, types_1.isPlainRecord)(intent) || intent.version !== 1 || intent.account !== account || intent.home !== active.home || intent.identity !== active.identity
                || intent.generation !== active.generation || intent.ledgerFingerprint !== active.fingerprint || intent.projectionOwner !== active.nonce
                || intent.priorReceiptDigest !== (prior === null ? null : hash(canonical(prior))))
                return false;
            if (canonical(prior) !== canonical(active.prior)) {
                // The existing signed layout migration may normalize the prior receipt
                // before publication. It must retain this exact captured prior custody.
                const value = this.verify(prior);
                if (!(0, types_1.isPlainRecord)(value) || typeof value.layoutMigration !== "string" || value.layoutMigration !== hash(canonical(active.prior)))
                    return false;
                const migration = this.verify(readJson((0, node_path_1.join)(root, "shared-plugin-layout-migrations", value.layoutMigration + ".json")));
                if (!(0, types_1.isPlainRecord)(migration) || !(0, types_1.isPlainRecord)(migration.context) || canonical(migration.context.priorReceipt) !== canonical(active.prior)
                    || migration.context.account !== account || migration.context.home !== active.home || migration.context.identity !== active.identity
                    || migration.context.ledgerFingerprint !== active.fingerprint || migration.context.generation !== active.generation)
                    return false;
            }
            const generic = readJson((0, node_path_1.join)(root, "plugin-projection-intent.v1.json"));
            if (!(0, types_1.isPlainRecord)(generic) || Object.keys(generic).sort().join() !== "after,before,id,projectionOwner,transaction"
                || typeof generic.id !== "string" || generic.projectionOwner !== active.nonce || !(0, types_1.isPlainRecord)(generic.after)
                || Object.keys(generic.after).sort().join() !== "fingerprint,version" || generic.after.version !== active.versions.get(generic.id)
                || typeof generic.after.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(generic.after.fingerprint)
                || typeof generic.transaction !== "string" || !/^\.tweakers-plugins-[a-f0-9]{16}$/.test(generic.transaction))
                return false;
            if (generic.before !== null && (!(0, types_1.isPlainRecord)(generic.before) || Object.keys(generic.before).sort().join() !== "fingerprint,version"
                || !segment(generic.before.version) || typeof generic.before.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(generic.before.fingerprint)))
                return false;
            const transaction = (0, node_path_1.join)(active.home, generic.transaction);
            // Cleanup removes the transaction directory before retiring its marker.
            // The active signed nonce still owns that final publication interval.
            if ((0, node_fs_1.lstatSync)(transaction, { throwIfNoEntry: false }))
                safeDirectory(transaction);
            return true;
        }
        catch {
            return false;
        }
    }
    /** Keep full package proofs and durable copies off the broker's RPC event loop. */
    projectAsync(input) {
        const operation = this.projectionTail.then(async () => {
            if (this.closed || !input.authorize())
                throw new SharedPreparationErrorV1("parent-authority");
            const ledger = this.readSignedGeneration(false);
            if (!ledger || !this.verifyGeneration(ledger.fingerprint))
                throw new SharedPreparationErrorV1("generation-lease");
            const cancellation = new Int32Array(new SharedArrayBuffer(4));
            const stateRoot = (0, node_path_1.resolve)(input.stateRoot), account = input.account.opaqueAccountId, home = (0, node_path_1.resolve)(input.account.codexHome), root = (0, node_path_1.join)(stateRoot, "accounts", account);
            if (home !== (0, node_path_1.join)(root, "execution-home") || readJson((0, node_path_1.join)(root, "plugin-projection-intent.v1.json")) !== null)
                throw new SharedPreparationErrorV1("account-receipt");
            const prior = readJson((0, node_path_1.join)(root, "shared-plugin-projection.v1.json"));
            if (prior !== null)
                this.verify(prior);
            const active = { stateRoot, account, home, identity: privateIdentity(home), generation: ledger.generation, fingerprint: ledger.fingerprint,
                nonce: (0, node_crypto_1.randomUUID)(), prior, cancellation, versions: new Map(ledger.entries.map(entry => [this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginIdV1)(entry.id) : entry.id,
                    this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginExecutionVersionV1)(this.packagePath(entry), entry.version) : entry.version])) };
            this.activeProjection = active;
            const current = () => {
                try {
                    return !this.closed && input.authorize() && this.verifyGeneration(ledger.fingerprint);
                }
                catch {
                    return false;
                }
            };
            // Cancellation is cooperative: never terminate a worker during a durable write.
            const monitor = setInterval(() => { if (!current())
                Atomics.store(cancellation, 0, 1); }, 25);
            monitor.unref();
            try {
                await new Promise((resolvePromise, reject) => {
                    const worker = new node_worker_threads_1.Worker(`
            const { workerData, parentPort } = require('node:worker_threads');
            if (workerData.loader) require(workerData.loader);
            require(workerData.entry).runSharedPluginProjectionWorkerV1(workerData).then(
              () => parentPort.postMessage({ ok: true }),
              error => parentPort.postMessage({ ok: false, preparationStage: require(workerData.entry).sharedPreparationStageV1(error?.preparationStage) ?? "worker-runtime" })
            );
          `, { eval: true, stdout: true, stderr: true, workerData: {
                            entry: __filename, loader: __filename.endsWith(".ts") ? require.resolve("tsx/cjs") : null,
                            store: this.input, stateRoot: input.stateRoot, account: input.account,
                            writeEvidence: { ...input.writeEvidence, pluginProjectionOwner: active.nonce }, fingerprint: ledger.fingerprint, cancellation,
                        } });
                    let succeeded = false, failed = false, failureStage = "worker-runtime";
                    worker.stdout.resume();
                    worker.stderr.resume();
                    worker.on("message", value => {
                        succeeded = (0, types_1.isPlainRecord)(value) && value.ok === true && Object.keys(value).length === 1;
                        if ((0, types_1.isPlainRecord)(value) && value.ok === false && Object.keys(value).sort().join() === "ok,preparationStage")
                            failureStage = sharedPreparationStageV1(value.preparationStage) ?? "worker-runtime";
                    });
                    worker.on("error", () => { failed = true; });
                    worker.on("exit", code => code === 0 && succeeded && !failed ? resolvePromise() : reject(new SharedPreparationErrorV1(failureStage)));
                });
                if (this.activeProjection === active)
                    this.activeProjection = null;
                if (Atomics.load(cancellation, 0) !== 0 || !current())
                    throw new SharedPreparationErrorV1("parent-authority");
            }
            finally {
                clearInterval(monitor);
                if (this.activeProjection === active)
                    this.activeProjection = null;
            }
        });
        this.projectionTail = operation.catch(() => undefined);
        return operation;
    }
    /** Signed receipt reconciliation for native local-cache version normalization; never modifies package bytes. */
    reconcileLocalProjectionLayout(input, ledger, prior, receiptPath) {
        if (!this.input.localLibrary || prior === null)
            return prior;
        const p = this.verify(prior), home = (0, node_path_1.resolve)(input.account.codexHome), identity = privateIdentity(home);
        if (!(0, types_1.isPlainRecord)(p) || p.account !== input.account.opaqueAccountId || p.home !== home || p.identity !== identity || !Array.isArray(p.packages) || !Array.isArray(p.catalogues))
            throw new Error("shared layout receipt identity differs");
        const changes = [];
        for (const entry of p.packages) {
            if (!(0, types_1.isPlainRecord)(entry) || !pluginId(entry.id) || !segment(entry.version) || typeof entry.digest !== "string")
                throw new Error("invalid shared layout package");
            const [name, market] = entry.id.split("@"), oldPath = (0, node_path_1.join)(home, "plugins/cache", market, name, entry.version);
            try {
                (0, node_fs_1.lstatSync)(oldPath);
                continue;
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            const sealed = this.packagePath({ packageDigest: entry.digest });
            if ((0, account_continuity_1.captureOfficialPluginPackageV1)(sealed).digest !== entry.digest)
                throw new Error("shared layout source custody differs");
            const version = (0, account_continuity_1.officialLocalPluginExecutionVersionV1)(sealed, entry.version);
            if (version === entry.version || !market.startsWith("tweakers-shared-") || entry.remoteId !== null)
                throw new Error("shared layout is not an exact local normalization");
            changes.push({ id: entry.id, beforeVersion: entry.version, afterVersion: version, digest: entry.digest });
        }
        if (!changes.length)
            return prior;
        // Validate every old package/catalogue before any metadata write, including unaffected entries.
        for (const entry of p.packages) {
            if (!(0, types_1.isPlainRecord)(entry) || !pluginId(entry.id) || !segment(entry.version))
                throw new Error("invalid shared layout package");
            const [name, market] = entry.id.split("@"), version = changes.find(change => change.id === entry.id)?.afterVersion ?? entry.version;
            if ((0, account_continuity_1.captureOfficialPluginPackageV1)((0, node_path_1.join)(home, "plugins/cache", market, name, version)).digest !== entry.digest)
                throw new Error("shared layout account payload differs");
        }
        for (const catalogue of p.catalogues) {
            if (!(0, types_1.isPlainRecord)(catalogue) || !segment(catalogue.market) || typeof catalogue.digest !== "string")
                throw new Error("invalid shared layout catalogue");
            const actual = readJson((0, node_path_1.join)(home, "plugins/cache", catalogue.market, ".agents/plugins/marketplace.json"));
            if (actual === null || hash(canonical(actual)) !== catalogue.digest)
                throw new Error("shared layout catalogue differs");
        }
        const unchanged = p.packages.filter(entry => (0, types_1.isPlainRecord)(entry) && !changes.some(change => change.id === entry.id)).map(entry => {
            if (!(0, types_1.isPlainRecord)(entry) || !pluginId(entry.id) || !segment(entry.version) || typeof entry.digest !== "string")
                throw new Error("invalid unchanged layout package");
            return { id: entry.id, version: entry.version, digest: entry.digest };
        });
        const migrationId = hash(canonical(prior)), directory = (0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "shared-plugin-layout-migrations"), path = (0, node_path_1.join)(directory, migrationId + ".json");
        const existing = readJson(path), saved = existing === null ? null : this.verify(existing);
        const context = { version: 1, policy: "native-manifest-version-v1", account: input.account.opaqueAccountId, home, identity,
            ledgerFingerprint: ledger.fingerprint, generation: ledger.generation, priorReceipt: prior, changes };
        if (saved !== null && (!(0, types_1.isPlainRecord)(saved) || canonical(saved.context) !== canonical(context)))
            throw new Error("shared layout recovery context differs");
        const plan = (0, account_continuity_1.reconcileOfficialPluginLayoutReceiptV1)({ ...input, changes, unchanged, apply: false, ...(saved === null ? {} : { before: saved.genericBefore }) });
        const record = { context, genericBefore: plan.before, genericAfter: plan.after };
        if (saved !== null && canonical(saved) !== canonical(record))
            throw new Error("shared layout recovery receipt differs");
        const current = () => input.authorize() && privateIdentity(home) === identity && this.readSignedGeneration(false)?.fingerprint === ledger.fingerprint;
        if (!current() || canonical(readJson(receiptPath)) !== canonical(prior))
            throw new Error("shared layout authority changed");
        if (existing === null) {
            safeDirectory(directory, true);
            writeJson(path, this.sign(record));
        }
        (0, account_continuity_1.reconcileOfficialPluginLayoutReceiptV1)({ ...input, changes, unchanged, apply: true, before: plan.before, authorize: current });
        // Repeat the exact payload/receipt checks at the second publication boundary.
        (0, account_continuity_1.reconcileOfficialPluginLayoutReceiptV1)({ ...input, changes, unchanged, apply: false, before: plan.before });
        if (!current() || canonical(readJson(receiptPath)) !== canonical(prior))
            throw new Error("shared layout authority changed before receipt publication");
        const next = this.sign({ ...p, layoutMigration: migrationId, packages: p.packages.map(entry => {
                if (!(0, types_1.isPlainRecord)(entry))
                    throw new Error("invalid shared layout package");
                const change = changes.find(change => change.id === entry.id);
                return change ? { ...entry, version: change.afterVersion } : entry;
            }) });
        writeJson(receiptPath, next);
        return next;
    }
    project(input) {
        input.onPreparationStage?.("sealed-generation");
        const ledger = this.read();
        if (!ledger || !input.authorize())
            throw new Error("shared plugin projection authority unavailable");
        if (input.expectedFingerprint !== undefined && ledger.fingerprint !== input.expectedFingerprint)
            throw new Error("shared plugin projection generation changed");
        if (!input.writeEvidence.accountChildAbsent)
            throw new Error("shared plugin projection requires absent account child lease");
        input.onPreparationStage?.("native-source");
        this.assertNativeRevision(ledger);
        input.onPreparationStage?.("account-receipt");
        const home = (0, node_path_1.resolve)(input.account.codexHome), identity = privateIdentity(home);
        if (!disjoint(home, (0, node_path_1.resolve)(this.input.sourceHome)))
            throw new Error("native source cannot receive shared plugin projection");
        const receiptPath = (0, node_path_1.join)(input.stateRoot, "accounts", input.account.opaqueAccountId, "shared-plugin-projection.v1.json");
        const intentPath = (0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "shared-plugin-projection-intent.v1.json");
        const pending = readJson(intentPath);
        const originalPrior = readJson(receiptPath);
        const genericPath = (0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "plugin-projections.v1.json");
        const generic = pending === null ? null : readJson(genericPath);
        const intentStat = pending === null ? null : (0, node_fs_1.lstatSync)(intentPath);
        const intentBytes = pending === null ? null : (0, node_fs_1.readFileSync)(intentPath);
        const priorBytes = pending === null ? null : (0, node_fs_1.readFileSync)(receiptPath);
        const executionEntries = ledger.entries.map(entry => ({ ...entry, version: this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginExecutionVersionV1)(this.packagePath(entry), entry.version) : entry.version }));
        const layoutPolicy = this.input.localLibrary ? "native-manifest-version-v1" : "canonical-v1";
        input.onPreparationStage?.("execution-layout");
        // An interrupted worker may have written only its outer intent. Never adopt
        // partial payloads or a generic copy transaction. Prove the complete prior
        // state below, under the new worker's absent-child write lease.
        if (pending !== null) {
            const intent = this.verify(pending), p = this.verify(originalPrior);
            if (home !== (0, node_path_1.join)((0, node_path_1.resolve)(input.stateRoot), "accounts", input.account.opaqueAccountId, "execution-home")
                || !input.writeEvidence.pluginProjectionOwner || !(0, types_1.isPlainRecord)(intent)
                || Object.keys(intent).sort().join() !== "account,generation,home,identity,ledgerFingerprint,priorReceiptDigest,projectionOwner,version"
                || intent.version !== 1 || intent.account !== input.account.opaqueAccountId || intent.home !== home || intent.identity !== identity
                || intent.generation !== ledger.generation || intent.ledgerFingerprint !== ledger.fingerprint
                || typeof intent.projectionOwner !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(intent.projectionOwner)
                || originalPrior === null || intent.priorReceiptDigest !== hash(canonical(originalPrior))
                || !(0, types_1.isPlainRecord)(p) || p.version !== 1 || p.layoutPolicy !== layoutPolicy || !Array.isArray(p.packages)
                || !(0, types_1.isPlainRecord)(generic) || generic.version !== 1 || generic.opaqueAccountId !== input.account.opaqueAccountId || !(0, types_1.isPlainRecord)(generic.entries)
                || canonical(Object.keys(generic.entries).sort()) !== canonical(p.packages.map(entry => (0, types_1.isPlainRecord)(entry) ? entry.id : null).sort())
                || readJson((0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "plugin-projection-intent.v1.json")) !== null
                || (0, node_fs_1.readdirSync)(home).some(name => name.startsWith(".tweakers-plugins-")))
                throw new Error("shared pending projection is not an unchanged prior state");
        }
        const prior = pending === null ? this.reconcileLocalProjectionLayout(input, ledger, originalPrior, receiptPath) : originalPrior;
        const priorCatalogues = new Map();
        if (prior !== null) {
            input.onPreparationStage?.("account-receipt");
            const p = this.verify(prior);
            if (!(0, types_1.isPlainRecord)(p) || p.account !== input.account.opaqueAccountId || p.home !== home || p.identity !== identity || !Array.isArray(p.packages))
                throw new Error("shared projection account or home identity changed");
            input.onPreparationStage?.("account-payload");
            for (const packageReceipt of p.packages) {
                if (!(0, types_1.isPlainRecord)(packageReceipt) || !pluginId(packageReceipt.id) || !segment(packageReceipt.version))
                    throw new Error("invalid signed account package receipt");
                const [name, market] = packageReceipt.id.split("@"), packageRoot = (0, node_path_1.join)(home, "plugins", "cache", market, name, packageReceipt.version);
                const snapshot = (0, account_continuity_1.captureOfficialPluginPackageV1)(packageRoot);
                if (snapshot.digest !== packageReceipt.digest
                    || (packageReceipt.remoteId !== null && readSharedPluginRemoteIdentityV1(packageRoot) !== packageReceipt.remoteId))
                    throw new Error("signed account package projection changed");
                if (pending !== null) {
                    const parent = (0, node_path_1.dirname)(packageRoot);
                    safeDirectory(parent, false, false);
                    const names = (0, node_fs_1.readdirSync)(parent).filter(name => name !== ".DS_Store" || !(0, node_fs_1.lstatSync)((0, node_path_1.join)(parent, name)).isFile());
                    const entry = generic.entries[packageReceipt.id];
                    if (names.length !== 1 || names[0] !== packageReceipt.version || !(0, types_1.isPlainRecord)(entry)
                        || Object.keys(entry).sort().join() !== "fingerprint,version" || entry.version !== packageReceipt.version
                        || entry.fingerprint !== "sha256:" + hash(canonical({ id: packageReceipt.id, version: packageReceipt.version, files: snapshot.files })))
                        throw new Error("pending projection generic custody changed");
                }
            }
            input.onPreparationStage?.("account-catalogue");
            if (!Array.isArray(p.catalogues))
                throw new Error("signed account projection lacks local catalogue custody");
            for (const catalogue of p.catalogues) {
                if (!(0, types_1.isPlainRecord)(catalogue) || !segment(catalogue.market) || typeof catalogue.digest !== "string")
                    throw new Error("invalid signed local catalogue receipt");
                const value = readJson((0, node_path_1.join)(home, "plugins", "cache", catalogue.market, ".agents", "plugins", "marketplace.json"));
                if (value === null || hash(canonical(value)) !== catalogue.digest)
                    throw new Error("signed account local catalogue changed");
                priorCatalogues.set(catalogue.market, catalogue.digest);
            }
            if (pending !== null) {
                const recoveryRoot = (0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "shared-plugin-projection-recovery"), digest = hash(intentBytes);
                const recordPath = (0, node_path_1.join)(recoveryRoot, digest + ".json"), archivePath = (0, node_path_1.join)(recoveryRoot, digest + ".intent.json");
                const record = { version: 1, decision: "prior-unchanged", intent: pending, priorReceipt: prior, generic,
                    home, identity, intentDigest: digest, priorBytesDigest: hash(priorBytes), intentDevice: intentStat.dev, intentInode: intentStat.ino };
                const current = () => {
                    const stat = (0, node_fs_1.lstatSync)(intentPath);
                    return input.authorize() && privateIdentity(home) === identity && this.readSignedGeneration(false)?.fingerprint === ledger.fingerprint
                        && stat.dev === intentStat.dev && stat.ino === intentStat.ino && (0, node_fs_1.readFileSync)(intentPath).equals(intentBytes)
                        && (0, node_fs_1.readFileSync)(receiptPath).equals(priorBytes) && canonical(readJson(genericPath)) === canonical(generic)
                        && readJson((0, node_path_1.join)((0, node_path_1.dirname)(receiptPath), "plugin-projection-intent.v1.json")) === null
                        && !(0, node_fs_1.readdirSync)(home).some(name => name.startsWith(".tweakers-plugins-"));
                };
                if (!current())
                    throw new Error("pending projection recovery authority changed");
                safeDirectory(recoveryRoot, true);
                // Persist the recovery directory's parent link before relying on the
                // fsynced decision inside it to retain the original intent.
                const parentFd = (0, node_fs_1.openSync)((0, node_path_1.dirname)(receiptPath), node_fs_1.constants.O_RDONLY);
                try {
                    (0, node_fs_1.fsyncSync)(parentFd);
                }
                finally {
                    (0, node_fs_1.closeSync)(parentFd);
                }
                const saved = readJson(recordPath);
                if (saved === null)
                    writeJson(recordPath, this.sign(record));
                else if (canonical(this.verify(saved)) !== canonical(record))
                    throw new Error("pending projection recovery evidence differs");
                if (!current() || (0, node_fs_1.lstatSync)(archivePath, { throwIfNoEntry: false }))
                    throw new Error("pending projection recovery changed before archival");
                (0, node_fs_1.renameSync)(intentPath, archivePath);
                for (const path of [recoveryRoot, (0, node_path_1.dirname)(receiptPath)]) {
                    const fd = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY);
                    try {
                        (0, node_fs_1.fsyncSync)(fd);
                    }
                    finally {
                        (0, node_fs_1.closeSync)(fd);
                    }
                }
            }
            if (p.ledgerFingerprint === ledger.fingerprint && (!this.input.localLibrary || p.layoutPolicy === layoutPolicy))
                return;
        }
        input.onPreparationStage?.("publication");
        writeJson(intentPath, this.sign({ version: 1, account: input.account.opaqueAccountId, home, identity, generation: ledger.generation,
            ledgerFingerprint: ledger.fingerprint, priorReceiptDigest: prior === null ? null : hash(canonical(prior)),
            ...(input.writeEvidence.pluginProjectionOwner ? { projectionOwner: input.writeEvidence.pluginProjectionOwner } : {}) }));
        (0, account_continuity_1.projectOfficialPluginPackagesV1)({ stateRoot: input.stateRoot, sourceHome: this.root, account: input.account,
            plugins: executionEntries, canonical: !this.input.localLibrary, generation: ledger.generation, writeEvidence: input.writeEvidence,
            custody: executionEntries.map(entry => ({ ...entry, path: this.packagePath(entry), digest: entry.packageDigest })) });
        for (const entry of executionEntries) {
            if (!entry.remote)
                continue;
            const [name, market] = (this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginIdV1)(entry.id) : entry.id).split("@"), path = (0, node_path_1.join)(home, "plugins", "cache", market, name, entry.version, ".codex-remote-plugin-install.json");
            const existing = readJson(path), expected = { schema_version: 1, remote_plugin_id: entry.remote.remoteId };
            if (existing !== null && canonical(existing) !== canonical(expected))
                throw new Error("account remote installation identity changed");
            if (existing === null)
                writeJson(path, expected);
        }
        const catalogues = [];
        const localEntries = executionEntries.filter(entry => this.input.localLibrary || !entry.remote).map(entry => ({ ...entry, executionId: this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginIdV1)(entry.id) : entry.id }));
        const markets = [...new Set(localEntries.map(entry => entry.executionId.split("@")[1]))].sort();
        for (const market of markets) {
            const manifestRoot = (0, node_path_1.join)(home, "plugins", "cache", market, ".agents", "plugins"), path = (0, node_path_1.join)(manifestRoot, "marketplace.json");
            safeDirectory(manifestRoot, true);
            const value = { name: market, plugins: localEntries.filter(entry => entry.executionId.split("@")[1] === market).map(entry => ({ name: entry.executionId.split("@")[0], source: { source: "local", path: `./${entry.executionId.split("@")[0]}/${entry.version}` } })) };
            const existing = readJson(path);
            if (existing !== null && !priorCatalogues.has(market))
                throw new Error("stock local catalogue is unowned");
            writeJson(path, value);
            catalogues.push({ market, digest: hash(canonical(value)) });
        }
        if (!input.authorize() || privateIdentity(home) !== identity || this.read()?.fingerprint !== ledger.fingerprint)
            throw new Error("shared plugin projection authority changed");
        this.assertNativeRevision(ledger);
        writeJson(receiptPath, this.sign({ version: 1, account: input.account.opaqueAccountId, home, identity, generation: ledger.generation,
            ledgerFingerprint: ledger.fingerprint, layoutPolicy, catalogues, packages: executionEntries.map(entry => ({ id: this.input.localLibrary ? (0, account_continuity_1.officialLocalPluginIdV1)(entry.id) : entry.id, version: entry.version, digest: entry.packageDigest, remoteId: entry.remote?.remoteId ?? null })) }));
        (0, node_fs_1.unlinkSync)(intentPath);
    }
    /** Definition snapshot only; account provider availability must be supplied from that account. */
    installedSnapshot(ledgerFingerprint, policy, provider, verifiedGenerationOnly = false) {
        if (verifiedGenerationOnly && !this.verifyGeneration(ledgerFingerprint))
            throw new Error("stale shared plugin installed snapshot");
        const ledger = this.readSignedGeneration(!verifiedGenerationOnly);
        if (!ledger || ledger.fingerprint !== ledgerFingerprint)
            throw new Error("stale shared plugin installed snapshot");
        if (!verifiedGenerationOnly)
            this.assertNativeRevision(ledger);
        // These definitions are installed through the native LOCAL plugin store.
        // A remote snapshot cannot prune their separate, signed local namespaces.
        if (this.input.localLibrary)
            return { plugins: [], pagination: { next_page_token: null } };
        const plugins = ledger.entries.filter(entry => entry.remote).map(entry => {
            const d = entry.remote, availability = provider(d.remoteId);
            if (!availability || !["ENABLED", "AVAILABLE", "DISABLED_BY_ADMIN"].includes(availability.status))
                throw new Error(`selected-account provider availability is unavailable for ${entry.id}`);
            return { id: d.remoteId, name: entry.id.split("@")[0], scope: d.scope, ...(d.discoverability ? { discoverability: d.discoverability } : {}),
                installation_policy: d.installationPolicy, authentication_policy: d.authenticationPolicy,
                ...(d.mustShowInstallationInterstitial !== undefined ? { must_show_installation_interstitial: d.mustShowInstallationInterstitial } : {}),
                status: availability.status, ...(availability.disabled_reason !== undefined ? { disabled_reason: availability.disabled_reason } : {}),
                release: { ...d.release, bundle_download_url: null, scheduled_tasks: null }, enabled: policy(entry.id) && availability.status !== "DISABLED_BY_ADMIN", disabled_skill_names: [] };
        });
        return { plugins, pagination: { next_page_token: null } };
    }
    assertNativeRevision(ledger) {
        this.assertDefinitionPolicy(ledger);
        if ((0, account_continuity_1.readOfficialInstalledPluginSnapshotV1)(this.input.sourceHome).fingerprint !== ledger.sourceSnapshotFingerprint)
            throw new Error("native installed plugin revision changed; refresh the shared ledger before execution");
        this.assertNativeRemoteIdentities(ledger);
    }
    assertNativeRemoteIdentities(ledger) {
        for (const entry of ledger.entries)
            if (entry.remote) {
                const [name, market] = entry.id.split("@");
                if (readSharedPluginRemoteIdentityV1((0, node_path_1.join)(this.input.sourceHome, "plugins", "cache", market, name, entry.version)) !== entry.remote.remoteId)
                    throw new Error("native installed remote identity changed");
            }
    }
    assertDefinitionPolicy(ledger) {
        if (ledger.definitionPolicyFingerprint !== account_continuity_1.OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1)
            throw new Error("shared plugin definition policy changed; reclassify the native source before execution");
    }
}
exports.SharedPluginLedgerStoreV1 = SharedPluginLedgerStoreV1;
/** Internal worker entry; no account process is launched here. */
async function runSharedPluginProjectionWorkerV1(input) {
    const secret = Buffer.from(input.store.secret);
    const store = new SharedPluginLedgerStoreV1({ ...input.store, secret });
    let stage = "sealed-generation";
    try {
        const current = () => Atomics.load(input.cancellation, 0) === 0;
        if (!current())
            throw new Error("shared plugin projection cancelled");
        // project already proves the complete sealed packages and current source;
        // bind that same proof to the parent's generation without repeating it.
        store.project({ stateRoot: input.stateRoot, account: input.account, writeEvidence: input.writeEvidence,
            authorize: current, expectedFingerprint: input.fingerprint, onPreparationStage: value => { stage = value; } });
        if (!current())
            throw new Error("shared plugin projection cancelled");
    }
    catch {
        throw new SharedPreparationErrorV1(Atomics.load(input.cancellation, 0) !== 0 ? "cancelled" : stage);
    }
    finally {
        store.close();
        secret.fill(0);
    }
}
//# sourceMappingURL=shared-plugin-ledger.js.map