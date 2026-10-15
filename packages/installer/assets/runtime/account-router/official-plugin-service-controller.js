"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hydrateOfficialSharedPluginLedgerV1 = hydrateOfficialSharedPluginLedgerV1;
exports.prepareOfficialPluginAccountServiceV1 = prepareOfficialPluginAccountServiceV1;
exports.officialPluginEffectiveConfigMatchesV1 = officialPluginEffectiveConfigMatchesV1;
const node_path_1 = require("node:path");
const account_continuity_1 = require("./account-continuity");
const official_bundled_adapter_1 = require("./official-bundled-adapter");
const official_plugin_service_facade_1 = require("./official-plugin-service-facade");
const shared_plugin_ledger_1 = require("./shared-plugin-ledger");
const types_1 = require("./types");
const REMOTE = new Set(["openai-curated-remote", "created-by-me-remote", "workspace-directory", "workspace-shared-with-me", "workspace-shared-with-me-private", "workspace-shared-with-me-unlisted"]);
const MAX_REPLY = 16 * 1024 * 1024;
const jsonReply = (status, value) => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(value) });
const unavailable = () => jsonReply(503, { error: { code: "shared_plugins_unavailable", message: "The selected account's shared plugin snapshot is unavailable. Refresh its connection and shared definitions." } });
const sessionEqual = (a, b) => !!a && a.actor === b.actor && a.authIdentity === b.authIdentity && a.stamp === b.stamp;
function realPlugin(value) {
    return (0, types_1.isPlainRecord)(value) && (0, types_1.isPlainRecord)(value.plugin) ? value.plugin : (0, types_1.isPlainRecord)(value) ? value : null;
}
function bounded(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value)) <= MAX_REPLY;
    }
    catch {
        return false;
    }
}
/** Read-only native inventory and genuine version-matched provider descriptors. */
async function hydrateOfficialSharedPluginLedgerV1(input) {
    const session = input.session(), prior = input.ledger.read();
    if (!session || !input.authorize())
        throw new Error("Shared plugin source authority unavailable");
    const signal = input.signal ?? new AbortController().signal;
    const assertSession = () => {
        if (signal.aborted || !sessionEqual(input.session(), session) || !input.authorize())
            throw new Error("Shared plugin source session changed");
    };
    assertSession();
    const snapshot = await input.ledger.readNativeSnapshot();
    assertSession();
    if (prior?.sourceSnapshotFingerprint === snapshot.fingerprint && prior.definitionPolicyFingerprint === account_continuity_1.OFFICIAL_PLUGIN_DEFINITION_POLICY_FINGERPRINT_V1) {
        // Source notifications invalidate resident services even when the bytes did
        // not change. Renew their existing generation instead of leaving it held.
        await input.ledger.validateSourceLease(prior);
        assertSession();
        return prior;
    }
    const packages = [];
    const withheldPlugins = {};
    for (const plugin of snapshot.plugins) {
        if (signal.aborted || !sessionEqual(input.session(), session) || !input.authorize())
            throw new Error("Shared plugin source session changed");
        // Saved policy for an absent package is preserved at its source, but it
        // cannot be reported as an installed definition or copied into a child.
        if (!plugin.version)
            continue;
        const [name, market] = plugin.id.split("@"), source = (0, node_path_1.join)(input.sourceHome, "plugins", "cache", market, name, plugin.version);
        try {
            (0, account_continuity_1.captureOfficialPluginPackageV1)(source);
        }
        catch (error) {
            const reason = (0, shared_plugin_ledger_1.sharedPluginWithheldReasonV1)(error);
            if (!reason)
                throw error;
            withheldPlugins[plugin.id] = reason;
            continue;
        }
        const candidate = { id: plugin.id, version: plugin.version, source };
        if (!input.localLibrary && REMOTE.has(market)) {
            const remoteId = (0, shared_plugin_ledger_1.readSharedPluginRemoteIdentityV1)(source);
            const reply = await input.readProvider(`/ps/plugins/${encodeURIComponent(remoteId)}`, new URLSearchParams(), signal);
            const response = realPlugin(reply.value);
            if (reply.status !== 200 || !response || !bounded(response) || !sessionEqual(input.session(), session))
                throw new Error(`Native remote package metadata is unavailable: ${plugin.id}`);
            candidate.remote = (0, shared_plugin_ledger_1.parseSharedPluginRemoteDescriptorV1)(plugin.id, plugin.version, remoteId, response, {
                kind: "selected-account-detail", actor: session.actor, authIdentity: session.authIdentity,
                sessionStamp: session.stamp, responseDigest: (0, shared_plugin_ledger_1.sharedPluginDescriptorResponseDigestV1)(response),
            });
        }
        packages.push(candidate);
    }
    return input.ledger.publish({ expected: prior?.fingerprint ?? null, sourceSnapshotFingerprint: snapshot.fingerprint, packages, withheldPlugins,
        authorize: () => !signal.aborted && sessionEqual(input.session(), session) && input.authorize() });
}
/** Keep native Skills/hooks and recommendations on their canonical IDs. */
async function prepareOfficialPluginAccountServiceV1(input) {
    const session = input.session(), ledger = input.ledger.read();
    if (!session || !ledger)
        throw new Error("Shared plugin account preparation unavailable");
    await input.ledger.validateSourceLease(ledger);
    let closed = false;
    const verify = () => {
        if (closed || !sessionEqual(input.session(), session))
            return false;
        return input.ledger.verifyGeneration(ledger.fingerprint);
    };
    const verifyPreparation = () => !closed && sessionEqual(input.preparationSession ? input.preparationSession() : input.session(), session)
        && input.ledger.verifyGeneration(ledger.fingerprint);
    const intercept = async (request, signal) => {
        if (!verify() || signal.aborted)
            return unavailable();
        const path = request.path.startsWith("/backend-api/") ? request.path.slice("/backend-api".length) : request.path;
        if (!/^\/(?:ps\/)?plugins(?:\/|$)/.test(path))
            return null;
        if (request.method !== "GET")
            return jsonReply(409, { error: { code: "plugins_follow_native", message: official_bundled_adapter_1.OFFICIAL_FOLLOW_NATIVE_PLUGIN_MUTATION_HOLD_V1 } });
        if (request.body.length)
            return jsonReply(400, { error: { code: "invalid_plugin_request" } });
        try {
            if (!verify())
                return unavailable();
            if (path === "/ps/plugins/installed") {
                if ([...request.query.keys()].some(k => !["scope", "limit", "pageToken", "includeDownloadUrls"].includes(k)) || request.query.has("pageToken"))
                    return jsonReply(400, { error: { code: "invalid_shared_plugin_page" } });
                if (ledger.projectionMode === "local-library-v1")
                    return jsonReply(200, input.ledger.installedSnapshot(ledger.fingerprint, input.policy, () => null, true));
                const available = new Map();
                for (const entry of ledger.entries) {
                    if (!entry.remote)
                        continue;
                    const reply = await input.readProvider(`/ps/plugins/${encodeURIComponent(entry.remote.remoteId)}`, new URLSearchParams(), signal);
                    const plugin = realPlugin(reply.value);
                    if (!verify() || signal.aborted || reply.status !== 200 || !plugin || plugin.id !== entry.remote.remoteId
                        || typeof plugin.status !== "string" || !["ENABLED", "AVAILABLE", "DISABLED_BY_ADMIN"].includes(plugin.status))
                        return unavailable();
                    available.set(entry.remote.remoteId, { status: plugin.status, ...(plugin.disabled_reason !== undefined ? { disabled_reason: plugin.disabled_reason } : {}) });
                }
                const snapshot = input.ledger.installedSnapshot(ledger.fingerprint, input.policy, id => available.get(id) ?? null, true);
                if (!verify() || signal.aborted)
                    return unavailable();
                return jsonReply(200, snapshot);
            }
            // The genuine account catalog owns discovery and provider restrictions.
            // Installation remains a separate, denied mutation in follow-native mode.
            if (![/^\/ps\/plugins\/(?:list|workspace\/shared|suggested\/codex)$/, /^\/ps\/plugins\/[^/]+(?:\/skills\/[^/]+)?$/, /^\/plugins\/featured$/].some(pattern => pattern.test(path)))
                return jsonReply(404, { error: { code: "unsupported_plugin_read" } });
            const reply = await input.readProvider(path, request.query, signal);
            if (!verify() || signal.aborted || !Number.isInteger(reply.status) || reply.status < 100 || reply.status > 599 || !bounded(reply.value))
                return unavailable();
            // Never relay a redirect to a second origin or an upstream error payload.
            if (reply.status < 200 || reply.status >= 300)
                return jsonReply(reply.status, { error: { code: "plugin_provider_unavailable" } });
            let value = reply.value;
            if ((0, types_1.isPlainRecord)(value) && Array.isArray(value.plugins) && ["/ps/plugins/suggested/codex", "/ps/plugins/list", "/ps/plugins/workspace/shared"].includes(path)) {
                const installed = new Set([...ledger.entries.map(entry => entry.id), ...Object.keys(ledger.withheldPlugins ?? {})]);
                value = { ...value, plugins: value.plugins.filter(plugin => {
                        if (!(0, types_1.isPlainRecord)(plugin) || typeof plugin.name !== "string")
                            return true;
                        const market = path === "/ps/plugins/suggested/codex" || plugin.scope === "GLOBAL" ? "openai-curated-remote"
                            : plugin.scope === "USER" ? "created-by-me-remote" : plugin.scope === "WORKSPACE" ? plugin.discoverability === "LISTED" ? "workspace-directory" : "workspace-shared-with-me" : null;
                        return !market || !installed.has(`${plugin.name}@${market}`);
                    }) };
            }
            return jsonReply(reply.status, value);
        }
        catch {
            return unavailable();
        }
    };
    const facade = await (0, official_plugin_service_facade_1.startOfficialPluginServiceFacade)({ root: input.root, upstreamBaseUrl: input.upstreamBaseUrl,
        sessionStamp: () => sessionEqual(input.session(), session) && !closed ? session.stamp : null,
        authorize: input.authorizeHeaders, intercept, caEnvironment: input.caEnvironment });
    return { baseUrl: facade.baseUrl, childEnvironment: facade.childEnvironment, ledgerFingerprint: ledger.fingerprint, verify, verifyPreparation,
        interceptHttp: async (method, path, query, body, signal = new AbortController().signal) => {
            const result = await intercept({ method, path, query, body }, signal);
            if (!result)
                throw new Error("Unsupported shared plugin HTTP surface");
            return { status: result.status, value: JSON.parse(result.body) };
        }, close: async () => { closed = true; return facade.close(); } };
}
/** Managed config must permit the adapter before any external login is submitted. */
function officialPluginEffectiveConfigMatchesV1(value, baseUrl) {
    const config = (0, types_1.isPlainRecord)(value) && (0, types_1.isPlainRecord)(value.config) ? value.config : null;
    if (!config || config.chatgpt_base_url !== baseUrl)
        return false;
    const features = (0, types_1.isPlainRecord)(config.features) ? config.features : {};
    return [features.plugins, features.codex_hooks, features.hooks, features.remote_plugin].every(flag => flag === undefined || typeof flag === "boolean");
}
//# sourceMappingURL=official-plugin-service-controller.js.map