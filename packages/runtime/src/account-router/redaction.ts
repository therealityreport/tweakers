import type { RedactedControlStatus } from "./types";

const FORBIDDEN_KEY = /(?:access|refresh|id)_?token|authorization|cookie|secret|email|credential|providerAccountId|chatgptAccountId/i;
const FORBIDDEN_VALUE = /(?:bearer\s+|sk-[A-Za-z0-9]|@|\/auth\.json|BEGIN [A-Z ]+PRIVATE KEY)/i;

export type RedactedErrorCode =
  | "invalid_request"
  | "unknown_method"
  | "unknown_thread_owner"
  | "pool_depleted"
  | "balanced_mode_auth_mutation"
  | "protocol_drift"
  | "post_start_failure"
  | "ambiguous_dispatch"
  | "invalid_correlation"
  | "capability_mismatch"
  | "router_stopping";

export function redactedRouterError(id: string | number | null, code: RedactedErrorCode): {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data: { code: RedactedErrorCode } };
} {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32080, message: "Account router request could not be completed", data: { code } },
  };
}

/** Reject output that could expose auth, provider identity, configuration paths, or request content. */
export function assertRedacted(value: unknown): void {
  const findings = redactionFindings(value);
  if (findings.length > 0) throw new Error("account-router redaction violation");
}

export function redactionFindings(value: unknown, location = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => redactionFindings(item, `${location}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
      ...(FORBIDDEN_KEY.test(key) ? [`${location}.${key}`] : []),
      ...redactionFindings(item, `${location}.${key}`),
    ]);
  }
  return typeof value === "string" && FORBIDDEN_VALUE.test(value) ? [location] : [];
}

export function serializeRedactedStatus(status: RedactedControlStatus): string {
  assertRedacted(status);
  return JSON.stringify(status);
}
