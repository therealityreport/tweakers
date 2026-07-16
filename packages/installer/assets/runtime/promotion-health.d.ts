type HealthValue = "pass" | "fail" | "unknown";
export interface RuntimePromotionProbes {
    authenticatedSession(): HealthValue | Promise<HealthValue>;
    declaredPermission(permission: string): HealthValue | Promise<HealthValue>;
}
export interface SessionCookieObservation {
    name: string;
    domain?: string;
    value?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expirationDate?: number;
}
export declare function hasAuthenticatedSessionCookie(cookies: SessionCookieObservation[], now?: number): boolean;
export interface CodexAuthObservation {
    auth_mode?: string;
    OPENAI_API_KEY?: string | null;
    tokens?: {
        access_token?: string;
        refresh_token?: string;
        id_token?: string;
        account_id?: string;
    } | null;
}
/**
 * The Codex / ChatGPT desktop app does NOT authenticate with a web
 * next-auth.session-token cookie. It signs in with a Codex account token stored
 * in `~/.codex/auth.json` (auth_mode "chatgpt") or an API key. The id_token is
 * short-lived and refreshed roughly hourly, so a durable session is proven by a
 * refresh token / account id (or an API key) — never by the id_token's expiry.
 */
export declare function hasAuthenticatedCodexToken(auth: CodexAuthObservation | null | undefined): boolean;
export declare function readCodexAuth(codexHome?: string): CodexAuthObservation | null;
export declare function answerPromotionHealthRequest(userRoot: string, probes: RuntimePromotionProbes, options?: {
    now?: Date;
    maxAgeMs?: number;
}): Promise<boolean>;
export {};
