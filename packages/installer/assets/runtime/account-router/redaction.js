"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactedRouterError = redactedRouterError;
exports.assertRedacted = assertRedacted;
exports.redactionFindings = redactionFindings;
exports.serializeRedactedStatus = serializeRedactedStatus;
const FORBIDDEN_KEY = /(?:access|refresh|id)_?token|authorization|cookie|secret|email|credential|providerAccountId|chatgptAccountId/i;
const FORBIDDEN_VALUE = /(?:bearer\s+|sk-[A-Za-z0-9]|@|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i;
function redactedRouterError(id, code) {
    return {
        jsonrpc: "2.0",
        id,
        error: { code: -32080, message: code === "balanced_mode_auth_mutation" ? "Use Accounts to reconnect the original account or switch to another saved account. Direct login and logout cannot replace a registered account." : code === "authentication_recovery_required" ? "An account needs to reconnect. Open Tweakers Doctor to restore its login without changing account history." : code === "account_history_busy" ? "This account is busy in another app or remote session. Let that work finish or close its session, then Retry." : "Account router request could not be completed", data: { code } },
    };
}
/** Reject output that could expose auth, provider identity, configuration paths, or request content. */
function assertRedacted(value) {
    const findings = redactionFindings(value);
    if (findings.length > 0)
        throw new Error("account-router redaction violation");
}
function redactionFindings(value, location = "$") {
    if (Array.isArray(value))
        return value.flatMap((item, index) => redactionFindings(item, `${location}[${index}]`));
    if (value && typeof value === "object") {
        return Object.entries(value).flatMap(([key, item]) => [
            ...(FORBIDDEN_KEY.test(key) ? [`${location}.${key}`] : []),
            ...redactionFindings(item, `${location}.${key}`),
        ]);
    }
    return typeof value === "string" && FORBIDDEN_VALUE.test(value) ? [location] : [];
}
function serializeRedactedStatus(status) {
    assertRedacted(status);
    return JSON.stringify(status);
}
//# sourceMappingURL=redaction.js.map