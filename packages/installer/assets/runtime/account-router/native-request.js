"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES = exports.NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES = exports.NATIVE_REQUEST_MAX_RESULT_BYTES = void 0;
exports.parseNativeRequestV1 = parseNativeRequestV1;
exports.parseNativeBrowserChildRequestV1 = parseNativeBrowserChildRequestV1;
exports.isNativeRequestSurfaceV1 = isNativeRequestSurfaceV1;
exports.isBoundedNativeResultV1 = isBoundedNativeResultV1;
exports.requestNativeUsageCreditsV1 = requestNativeUsageCreditsV1;
exports.requestNativeHttpV1 = requestNativeHttpV1;
const types_1 = require("./types");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.NATIVE_REQUEST_MAX_RESULT_BYTES = 4 * 1024 * 1024;
exports.NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES = 2 * 1024 * 1024;
// A complete native marketplace catalog can exceed 8 MiB. Keep that allowance
// on the authenticated Plugins surface; other native projections retain their
// smaller bounds, and native HTTP responses remain separately bounded below.
exports.NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES = 16 * 1024 * 1024;
/** Exact scoped methods ported from upstream internal/mux/scoped_request.go. */
const METHOD_SURFACES = Object.freeze({
    "app/installed": ["apps"], "app/list": ["apps"], "app/read": ["apps"],
    "plugin/list": ["plugins"], "plugin/read": ["plugins"], "plugin/install": ["plugins"], "plugin/uninstall": ["plugins"],
    "mcpServer/oauth/login": ["mcp"], "mcpServerStatus/list": ["mcp"],
    "config/read": ["apps", "plugins", "mcp"], "config/value/write": ["apps", "plugins", "mcp"], "config/batchWrite": ["apps", "plugins", "mcp"],
    "http.request": ["apps", "plugins"],
    "skills/list": ["plugins"],
    "browser.sync": ["plugins"], "browser.install": ["plugins"], "browser.uninstall": ["plugins"],
    "usage.credits.read": ["usage"], "usage.credits.consume": ["usage"],
});
function parseNativeRequestV1(value) {
    if (!(0, types_1.isPlainRecord)(value) || Object.keys(value).sort().join("\0") !== "method\0params\0surface"
        || !isNativeRequestSurfaceV1(value.surface) || typeof value.method !== "string"
        || !METHOD_SURFACES[value.method]?.includes(value.surface) || !(0, types_1.isPlainRecord)(value.params))
        return null;
    const params = validateMethodParams(value.surface, value.method, value.params);
    return params ? { surface: value.surface, method: value.method, params } : null;
}
const NATIVE_BROWSER_CONFIG_KEYS = new Set([
    "mcp_servers.node_repl", "mcp_servers.computer-use", "mcp_servers.cua_repl",
    "shell_environment_policy.set.BROWSER_USE_AVAILABLE_BACKENDS",
    "shell_environment_policy.set.NODE_REPL_TRUSTED_CODE_PATHS",
]);
/** Exact main-owned child RPCs used after a selected-account browser action. */
function parseNativeBrowserChildRequestV1(method, params) {
    if (method === "plugin/list") {
        return (0, types_1.isPlainRecord)(params) && Object.keys(params).sort().join("\0") === "marketplaceKinds"
            && Array.isArray(params.marketplaceKinds) && params.marketplaceKinds.length === 1 && params.marketplaceKinds[0] === "local"
            ? { method, params: { marketplaceKinds: ["local"] } } : null;
    }
    if (method !== "config/batchWrite" || !(0, types_1.isPlainRecord)(params)
        || Object.keys(params).sort().join("\0") !== "edits\0expectedVersion\0filePath\0reloadUserConfig"
        || params.expectedVersion !== null || params.filePath !== null || params.reloadUserConfig !== false
        || !Array.isArray(params.edits) || params.edits.length !== NATIVE_BROWSER_CONFIG_KEYS.size)
        return null;
    const seen = new Set();
    const edits = [];
    for (const edit of params.edits) {
        if (!(0, types_1.isPlainRecord)(edit) || Object.keys(edit).sort().join("\0") !== "keyPath\0mergeStrategy\0value"
            || typeof edit.keyPath !== "string" || !NATIVE_BROWSER_CONFIG_KEYS.has(edit.keyPath) || seen.has(edit.keyPath)
            || edit.mergeStrategy !== "replace" || (edit.keyPath.startsWith("shell_environment_policy.") ? edit.value !== null : !boundedJson(edit.value)))
            return null;
        seen.add(edit.keyPath);
        edits.push({ keyPath: edit.keyPath, value: edit.value, mergeStrategy: "replace" });
    }
    return { method, params: { edits, expectedVersion: null, filePath: null, reloadUserConfig: false } };
}
function isNativeRequestSurfaceV1(value) {
    return value === "profile" || value === "apps" || value === "plugins" || value === "mcp" || value === "usage";
}
function isBoundedNativeResultV1(value, surface) {
    try {
        const encoded = JSON.stringify(value);
        const maximum = surface === "usage" ? exports.NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES
            : surface === "plugins" ? exports.NATIVE_REQUEST_PLUGINS_MAX_RESULT_BYTES : exports.NATIVE_REQUEST_MAX_RESULT_BYTES;
        return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= maximum;
    }
    catch {
        return false;
    }
}
async function requestNativeUsageCreditsV1(codexHome, method, params) {
    const credentials = readChatGptCredentials((0, node_path_1.join)(codexHome, "auth.json"));
    if (!credentials)
        throw new Error("native usage credentials unavailable");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref();
    try {
        const consume = method === "usage.credits.consume";
        const endpoint = `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits${consume ? "/consume" : ""}`;
        const body = consume ? JSON.stringify({
            credit_id: params.creditId ?? null,
            redeem_request_id: params.redeemRequestId,
        }) : undefined;
        const response = await fetch(endpoint, {
            method: consume ? "POST" : "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${credentials.accessToken}`,
                ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
                accept: "application/json",
                ...(consume ? { "content-type": "application/json" } : {}),
            },
            body,
        });
        if (response.status !== 200 || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
            throw new Error(`native usage request failed (${response.status})`);
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > exports.NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES)
            throw new Error("native usage response too large");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > exports.NATIVE_REQUEST_USAGE_MAX_RESULT_BYTES)
            throw new Error("native usage response too large");
        const value = JSON.parse(new TextDecoder().decode(bytes));
        if (!isBoundedNativeResultV1(value, "usage"))
            throw new Error("invalid native usage response");
        return value;
    }
    finally {
        clearTimeout(timer);
        credentials.accessToken = "";
        credentials.accountId = "";
    }
}
async function requestNativeHttpV1(codexHome, surface, params) {
    const credentials = readChatGptCredentials((0, node_path_1.join)(codexHome, "auth.json"));
    if (!credentials)
        throw new Error("native HTTP credentials unavailable");
    const parsed = nativeHttpTarget(surface, params);
    if (!parsed)
        throw new Error("invalid native HTTP request");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref();
    try {
        const url = new URL(`https://chatgpt.com/backend-api${parsed.path}`);
        for (const [key, value] of Object.entries(parsed.query))
            url.searchParams.set(key, String(value));
        const response = await fetch(url, {
            method: parsed.verb,
            redirect: "manual",
            signal: controller.signal,
            headers: {
                authorization: `Bearer ${credentials.accessToken}`,
                ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
                ...(parsed.path === "/aip/connectors/links/oauth/callback" ? {} : { "OAI-Product-Sku": "CODEX" }),
                accept: "application/json",
                ...(parsed.body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: parsed.body === undefined ? undefined : JSON.stringify(parsed.body),
        });
        if (response.status < 200 || response.status >= 300 || response.type === "opaqueredirect") {
            throw new Error(`native HTTP request failed (${response.status})`);
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > exports.NATIVE_REQUEST_MAX_RESULT_BYTES)
            throw new Error("native HTTP response too large");
        const bytes = await readBoundedHttpResponse(response, exports.NATIVE_REQUEST_MAX_RESULT_BYTES);
        const value = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder().decode(bytes));
        if (!isBoundedNativeResultV1(value, surface))
            throw new Error("invalid native HTTP response");
        return value;
    }
    finally {
        clearTimeout(timer);
        credentials.accessToken = "";
        credentials.accountId = "";
    }
}
function readChatGptCredentials(path) {
    let descriptor;
    let bytes;
    try {
        descriptor = (0, node_fs_1.openSync)(path, node_fs_1.constants.O_RDONLY | node_fs_1.constants.O_NOFOLLOW);
        const stat = (0, node_fs_1.fstatSync)(descriptor);
        const owner = process.getuid?.();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 1024 * 1024
            || (owner !== undefined && stat.uid !== owner) || (stat.mode & 0o077) !== 0)
            return null;
        bytes = Buffer.alloc(stat.size);
        if ((0, node_fs_1.readSync)(descriptor, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength)
            return null;
        const value = JSON.parse(bytes.toString("utf8"));
        if (!(0, types_1.isPlainRecord)(value) || !(0, types_1.isPlainRecord)(value.tokens) || typeof value.tokens.access_token !== "string"
            || value.tokens.access_token.length < 1 || value.tokens.access_token.length > 16_384)
            return null;
        const accountId = typeof value.tokens.account_id === "string" && value.tokens.account_id.length <= 512 ? value.tokens.account_id : "";
        return { accessToken: value.tokens.access_token, accountId };
    }
    catch {
        return null;
    }
    finally {
        bytes?.fill(0);
        if (descriptor !== undefined)
            try {
                (0, node_fs_1.closeSync)(descriptor);
            }
            catch { }
    }
}
function validateMethodParams(surface, method, value) {
    const keys = Object.keys(value).sort();
    if (method === "http.request")
        return nativeHttpTarget(surface, value) ? structuredClone(value) : null;
    if (method === "skills/list") {
        if (keys.some((key) => key !== "cwds" && key !== "forceReload")
            || (value.forceReload !== undefined && typeof value.forceReload !== "boolean")
            || (value.cwds !== undefined && (!Array.isArray(value.cwds) || value.cwds.length > 64
                || value.cwds.some((cwd) => !canonicalExistingDirectory(cwd)))))
            return null;
        return {
            ...(value.cwds === undefined ? {} : { cwds: [...value.cwds] }),
            ...(value.forceReload === undefined ? {} : { forceReload: value.forceReload }),
        };
    }
    if (method === "browser.sync")
        return keys.length === 0 ? {} : null;
    if (method === "browser.install") {
        return keys.join("\0") === "hostId\0marketplacePath\0pluginName" && value.hostId === "local"
            && (value.marketplacePath === null || safeIdentifier(value.marketplacePath, 4096)) && safeName(value.pluginName)
            ? { hostId: "local", marketplacePath: value.marketplacePath, pluginName: value.pluginName } : null;
    }
    if (method === "browser.uninstall") {
        return keys.join("\0") === "hostId\0marketplaceName\0pluginName" && value.hostId === "local"
            && safeName(value.marketplaceName) && safeName(value.pluginName)
            ? { hostId: "local", marketplaceName: value.marketplaceName, pluginName: value.pluginName } : null;
    }
    if (method === "config/read") {
        return keys.join("\0") === "cwd\0includeLayers" && (value.cwd === null || canonicalExistingDirectory(value.cwd)) && typeof value.includeLayers === "boolean"
            ? { cwd: value.cwd, includeLayers: value.includeLayers } : null;
    }
    if (method === "config/value/write") {
        if (keys.some((key) => !["expectedVersion", "filePath", "keyPath", "mergeStrategy", "value"].includes(key))
            || !configKeyForSurface(surface, value.keyPath) || !configWriteTarget(value.filePath, value.expectedVersion)
            || !mergeStrategy(value.mergeStrategy) || !boundedJson(value.value))
            return null;
        return { keyPath: value.keyPath, value: value.value, mergeStrategy: value.mergeStrategy,
            filePath: value.filePath, expectedVersion: value.expectedVersion };
    }
    if (method === "config/batchWrite") {
        if (keys.some((key) => !["edits", "expectedVersion", "filePath", "reloadUserConfig"].includes(key))
            || !Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > 64
            || !configWriteTarget(value.filePath, value.expectedVersion)
            || (value.reloadUserConfig !== undefined && value.reloadUserConfig !== true))
            return null;
        const edits = [];
        for (const edit of value.edits) {
            if (!(0, types_1.isPlainRecord)(edit) || Object.keys(edit).sort().join("\0") !== "keyPath\0mergeStrategy\0value"
                || !configKeyForSurface(surface, edit.keyPath) || !mergeStrategy(edit.mergeStrategy) || !boundedJson(edit.value))
                return null;
            edits.push({ keyPath: edit.keyPath, value: edit.value, mergeStrategy: edit.mergeStrategy });
        }
        return { edits, filePath: value.filePath, expectedVersion: value.expectedVersion,
            ...(value.reloadUserConfig === true ? { reloadUserConfig: true } : {}) };
    }
    if (method === "app/read") {
        if (keys.some((key) => key !== "appIds" && key !== "includeTools") || !safeNameList(value.appIds, 100) || value.appIds.length === 0
            || (value.includeTools !== undefined && value.includeTools !== true))
            return null;
        return { appIds: [...value.appIds], ...(value.includeTools === true ? { includeTools: true } : {}) };
    }
    if (method === "mcpServer/oauth/login") {
        if (keys.some((key) => key !== "name" && key !== "threadId" && key !== "scopes") || !safeName(value.name)
            || (value.threadId !== undefined && !safeIdentifier(value.threadId, 512))
            || (value.scopes !== undefined && !safeNameList(value.scopes, 64)))
            return null;
        return { name: value.name, ...(value.threadId !== undefined ? { threadId: value.threadId } : {}),
            ...(value.scopes !== undefined ? { scopes: [...value.scopes] } : {}) };
    }
    if (method === "usage.credits.consume") {
        if (keys.some((key) => key !== "creditId" && key !== "redeemRequestId") || !safeRedeemRequestId(value.redeemRequestId)
            || (value.creditId !== undefined && value.creditId !== null && !safeCreditId(value.creditId)))
            return null;
        return { ...(value.creditId !== undefined ? { creditId: value.creditId } : {}), redeemRequestId: value.redeemRequestId };
    }
    if (method === "app/list") {
        if (keys.some((key) => key !== "cursor" && key !== "limit" && key !== "forceRefetch" && key !== "threadId"))
            return null;
        if (value.cursor !== undefined && value.cursor !== null && !safeCursor(value.cursor))
            return null;
        if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100))
            return null;
        if (value.forceRefetch !== undefined && typeof value.forceRefetch !== "boolean")
            return null;
        if (value.threadId !== undefined && !safeIdentifier(value.threadId, 512))
            return null;
        return { ...(value.cursor !== undefined ? { cursor: value.cursor } : {}), ...(value.limit !== undefined ? { limit: value.limit } : {}),
            ...(value.forceRefetch !== undefined ? { forceRefetch: value.forceRefetch } : {}),
            ...(value.threadId !== undefined ? { threadId: value.threadId } : {}) };
    }
    if (method === "app/installed") {
        return keys.length === 0 ? {} : keys.join("\0") === "forceRefresh" && value.forceRefresh === true ? { forceRefresh: true } : null;
    }
    if (method === "plugin/list") {
        if (keys.some((key) => key !== "cwds" && key !== "marketplaceKinds" && key !== "forceRefetch")
            || (value.cwds !== undefined && !safeStringList(value.cwds, 64, 4096))
            || (value.marketplaceKinds !== undefined && !safeNameList(value.marketplaceKinds, 32))
            || (value.forceRefetch !== undefined && typeof value.forceRefetch !== "boolean"))
            return null;
        return { ...(value.cwds !== undefined ? { cwds: [...value.cwds] } : {}),
            ...(value.marketplaceKinds !== undefined ? { marketplaceKinds: [...value.marketplaceKinds] } : {}),
            ...(value.forceRefetch !== undefined ? { forceRefetch: value.forceRefetch } : {}) };
    }
    if (method === "mcpServerStatus/list") {
        if (keys.some((key) => key !== "cursor" && key !== "detail" && key !== "limit" && key !== "threadId")
            || (value.cursor !== undefined && value.cursor !== null && !safeCursor(value.cursor))
            || !safeName(value.detail) || value.limit !== 100
            || (value.threadId !== undefined && !safeIdentifier(value.threadId, 512)))
            return null;
        return { ...(value.cursor !== undefined ? { cursor: value.cursor } : {}), detail: value.detail, limit: 100,
            ...(value.threadId !== undefined ? { threadId: value.threadId } : {}) };
    }
    if (method === "plugin/read" || method === "plugin/install") {
        const allowed = method === "plugin/install" ? ["installAttemptId", "marketplacePath", "pluginName", "remoteMarketplaceName"] : ["marketplacePath", "pluginName", "remoteMarketplaceName"];
        if (keys.some((key) => !allowed.includes(key)) || !safeName(value.pluginName)
            || (method === "plugin/install" && !safeIdentifier(value.installAttemptId, 256)))
            return null;
        const marketplace = pluginMarketplace(value);
        return marketplace ? { ...marketplace, pluginName: value.pluginName,
            ...(method === "plugin/install" ? { installAttemptId: value.installAttemptId } : {}) } : null;
    }
    if (method === "plugin/uninstall") {
        return keys.join("\0") === "pluginId" && safeIdentifier(value.pluginId, 512) ? { pluginId: value.pluginId } : null;
    }
    return keys.length === 0 ? {} : null;
}
function nativeHttpTarget(surface, value) {
    if (Object.keys(value).sort().join("\0") !== "options\0path\0verb"
        || (value.verb !== "GET" && value.verb !== "POST") || typeof value.path !== "string"
        || !(0, types_1.isPlainRecord)(value.options) || Object.keys(value.options).some((key) => key !== "parameters" && key !== "requestBody"))
        return null;
    const options = value.options;
    const parameters = options.parameters === undefined ? {} : options.parameters;
    if (!(0, types_1.isPlainRecord)(parameters) || Object.keys(parameters).some((key) => key !== "path" && key !== "query"))
        return null;
    const path = parameters.path === undefined ? {} : parameters.path;
    const query = parameters.query === undefined ? {} : parameters.query;
    if (!(0, types_1.isPlainRecord)(path) || !(0, types_1.isPlainRecord)(query))
        return null;
    const body = options.requestBody;
    if (surface === "plugins") {
        if (value.verb === "POST" && value.path === "/apps/availability" && Object.keys(path).length === 0
            && exactKeys(query, ["locale", "platform"]) && safeName(query.locale) && query.platform === "chat"
            && (0, types_1.isPlainRecord)(body) && exactKeys(body, ["app_ids"]) && safeNameList(body.app_ids, 100)) {
            return { verb: "POST", path: value.path, query: query, body };
        }
        if (value.verb === "POST" && ["/apps/content", "/apps/workspace/content"].includes(value.path)
            && Object.keys(path).length === 0 && exactKeys(query, ["detail", "locale", "platform"])
            && query.detail === "full" && safeName(query.locale) && query.platform === "chat"
            && (0, types_1.isPlainRecord)(body) && exactKeys(body, ["app_ids"]) && safeNameList(body.app_ids, 100)) {
            return { verb: "POST", path: value.path, query: query, body };
        }
        if (value.verb === "GET" && value.path === "/ps/plugins/installed" && Object.keys(path).length === 0
            && exactKeys(query, Object.prototype.hasOwnProperty.call(query, "pageToken") ? ["pageToken"] : [])
            && (query.pageToken === undefined || safeIdentifier(query.pageToken, 1024)) && body === undefined) {
            return { verb: "GET", path: value.path, query: query };
        }
        const pluginId = exactPathId(path, "plugin_id");
        if (!pluginId)
            return null;
        const expanded = value.path.replace("{plugin_id}", encodeURIComponent(pluginId));
        if (value.verb === "GET" && value.path === "/ps/plugins/{plugin_id}" && Object.keys(query).length === 0 && body === undefined) {
            return { verb: "GET", path: expanded, query: {} };
        }
        if (value.verb === "POST" && value.path === "/ps/plugins/{plugin_id}/install"
            && exactKeys(query, ["includeAppsNeedingAuth"]) && query.includeAppsNeedingAuth === true
            && (0, types_1.isPlainRecord)(body) && exactKeys(body, ["install_attempt_id"]) && safeIdentifier(body.install_attempt_id, 256)) {
            return { verb: "POST", path: expanded, query: { includeAppsNeedingAuth: true }, body };
        }
        if (value.verb === "POST" && ["uninstall", "enable", "disable"].some((action) => value.path === `/ps/plugins/{plugin_id}/${action}`)
            && Object.keys(query).length === 0 && body === undefined)
            return { verb: "POST", path: expanded, query: {} };
        return null;
    }
    if (surface !== "apps")
        return null;
    if (value.verb === "POST" && value.path === "/aip/connectors/github/has_installations"
        && Object.keys(path).length === 0 && Object.keys(query).length === 0 && (0, types_1.isPlainRecord)(body)
        && exactKeys(body, ["link_id"]) && safeIdentifier(body.link_id, 512))
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.verb === "GET" && value.path === "/wham/github/installations/v2"
        && Object.keys(path).length === 0 && exactKeys(query, ["connector_id"]) && safeIdentifier(query.connector_id, 512)
        && body === undefined)
        return { verb: "GET", path: value.path, query: { connector_id: query.connector_id } };
    if (value.verb === "GET" && value.path === "/aip/connectors/{connector_id}") {
        const connectorId = exactPathId(path, "connector_id");
        if (!connectorId || !exactKeys(query, ["include_actions"]) || typeof query.include_actions !== "boolean" || body !== undefined)
            return null;
        return { verb: "GET", path: value.path.replace("{connector_id}", encodeURIComponent(connectorId)), query: { include_actions: query.include_actions } };
    }
    if (value.verb === "GET" && value.path === "/aip/connectors/{connector_id}/link") {
        const connectorId = exactPathId(path, "connector_id");
        return connectorId && Object.keys(query).length === 0 && body === undefined
            ? { verb: "GET", path: value.path.replace("{connector_id}", encodeURIComponent(connectorId)), query: {} } : null;
    }
    if (value.verb !== "POST" || Object.keys(path).length !== 0 || Object.keys(query).length !== 0 || !(0, types_1.isPlainRecord)(body))
        return null;
    if (value.path === "/aip/connectors/links/list_accessible"
        && exactKeys(body, ["link_refresh_strategy", "principals"]) && Array.isArray(body.principals) && body.principals.length === 0
        && body.link_refresh_strategy === "BLOCKING")
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.path === "/aip/connectors/links/noauth" && exactKeysOptional(body, ["action_names", "connector_id", "name"], ["install_attempt_id"])
        && safeIdentifier(body.connector_id, 512) && safeName(body.name) && safeNameList(body.action_names, 256)
        && (body.install_attempt_id === undefined || safeIdentifier(body.install_attempt_id, 256)))
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.path === "/aip/connectors/links/oauth" && exactKeysOptional(body, ["action_names", "callback_url", "connector_id", "name", "post_auth_url"], ["install_attempt_id", "requested_companion_connector_ids"])
        && body.action_names === null && safeIdentifier(body.connector_id, 512) && safeName(body.name)
        && safeIdentifier(body.callback_url, 4096) && safeIdentifier(body.post_auth_url, 4096)
        && (body.install_attempt_id === undefined || safeIdentifier(body.install_attempt_id, 256))
        && (body.requested_companion_connector_ids === undefined || safeNameList(body.requested_companion_connector_ids, 256)))
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.path === "/aip/connectors/links/oauth/complete" && exactKeys(body, ["connection_consent", "connector_id"])
        && safeIdentifier(body.connector_id, 512) && (0, types_1.isPlainRecord)(body.connection_consent)
        && exactKeys(body.connection_consent, ["connection_id", "granted_scopes"])
        && safeIdentifier(body.connection_consent.connection_id, 512) && safeNameList(body.connection_consent.granted_scopes, 256))
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.path === "/aip/connectors/links/oauth/reauth" && exactKeysOptional(body, ["callback_url", "link_id", "post_auth_url"], ["requested_scopes"])
        && safeIdentifier(body.callback_url, 4096) && safeIdentifier(body.link_id, 512) && safeIdentifier(body.post_auth_url, 4096)
        && (body.requested_scopes === undefined || safeNameList(body.requested_scopes, 256)))
        return { verb: "POST", path: value.path, query: {}, body };
    if (value.path === "/aip/connectors/links/oauth/callback" && exactKeys(body, ["full_redirect_url"])
        && safeIdentifier(body.full_redirect_url, 4096))
        return { verb: "POST", path: value.path, query: {}, body };
    return null;
}
function exactPathId(value, key) {
    return exactKeys(value, [key]) && safeIdentifier(value[key], 512) ? value[key] : null;
}
function exactKeys(value, keys) {
    return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function exactKeysOptional(value, required, optional) {
    const keys = Object.keys(value);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every((key) => required.includes(key) || optional.includes(key));
}
function canonicalExistingDirectory(value) {
    if (!safeIdentifier(value, 4096) || !(0, node_path_1.isAbsolute)(value) || (0, node_path_1.normalize)(value) !== value)
        return false;
    try {
        return (0, node_fs_1.statSync)(value).isDirectory() && (0, node_fs_1.realpathSync)(value) === value;
    }
    catch {
        return false;
    }
}
async function readBoundedHttpResponse(response, maximum) {
    if (!response.body)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done)
                break;
            total += next.value.byteLength;
            if (total > maximum)
                throw new Error("native HTTP response too large");
            chunks.push(next.value);
        }
    }
    catch (error) {
        try {
            await reader.cancel();
        }
        catch { }
        throw error;
    }
    finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
function configKeyForSurface(surface, value) {
    const prefix = surface === "apps" ? "apps." : surface === "plugins" ? "plugins." : surface === "mcp" ? "mcp_servers." : null;
    return prefix !== null && safeIdentifier(value, 512) && value.startsWith(prefix) && value.length > prefix.length;
}
function configWriteTarget(filePath, expectedVersion) {
    return (filePath === null || safeIdentifier(filePath, 4096))
        && (expectedVersion === null || safeIdentifier(expectedVersion, 256) || Number.isSafeInteger(expectedVersion) && expectedVersion >= 0);
}
function mergeStrategy(value) {
    return value === "upsert" || value === "replace";
}
function boundedJson(value) {
    try {
        const encoded = JSON.stringify(value);
        return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= 256 * 1024;
    }
    catch {
        return false;
    }
}
function pluginMarketplace(value) {
    const hasPath = Object.prototype.hasOwnProperty.call(value, "marketplacePath");
    const hasRemote = Object.prototype.hasOwnProperty.call(value, "remoteMarketplaceName");
    if (hasPath === hasRemote)
        return null;
    if (hasPath)
        return safeIdentifier(value.marketplacePath, 4096) ? { marketplacePath: value.marketplacePath } : null;
    return safeName(value.remoteMarketplaceName) ? { remoteMarketplaceName: value.remoteMarketplaceName } : null;
}
function safeNameList(value, maximum) {
    return safeStringList(value, maximum, 256);
}
function safeStringList(value, maximum, maximumLength) {
    return Array.isArray(value) && value.length <= maximum
        && value.every((item) => safeIdentifier(item, maximumLength));
}
function safeIdentifier(value, maximumLength) {
    return typeof value === "string" && value.length > 0 && value.length <= maximumLength && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeName(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeCursor(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeRedeemRequestId(value) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
function safeCreditId(value) {
    return typeof value === "string" && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}
//# sourceMappingURL=native-request.js.map