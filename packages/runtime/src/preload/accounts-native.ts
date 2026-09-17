import type {
  AccountsNativeAdapter,
  AccountsNativeApi,
  AccountsNativeRequestSurface,
  AccountsNativeSelection,
  AccountsNativeSlotSurface,
  AccountsNativeStatus,
} from "@therealityreport/tweakers-sdk";

const ACCOUNT_ID = /^account_[A-Za-z0-9_-]{43}$/;
const METHOD = /^[A-Za-z][A-Za-z0-9/_.:-]{0,127}$/;
const REQUEST_SURFACES = new Set<AccountsNativeRequestSurface>(["profile", "apps", "plugins", "mcp", "usage"]);
const SLOT_SURFACES = new Set<AccountsNativeSlotSurface>([
  "account-menu", "profile", "apps", "plugins", "mcp", "usage", "thread-summary",
]);
const OAUTH_BINDING_TTL_MS = 30 * 60 * 1_000;
const MAX_OAUTH_BINDINGS = 256;

export interface AccountsNativeTransport {
  initialize(value: { version: 1; hookSetSha256: string }): boolean;
  status(): AccountsNativeStatus;
  snapshot(surface: AccountsNativeSlotSurface): AccountsNativeSelection;
  subscribe(handler: (event: { surface: AccountsNativeSlotSurface | null; generation: number }) => void): () => void;
  project(surface: AccountsNativeRequestSurface, kind: string, input: unknown): unknown;
  request(
    surface: AccountsNativeRequestSurface,
    method: string,
    params: Readonly<Record<string, unknown>>,
    selection: AccountsNativeSelection,
  ): Promise<unknown>;
}

export interface AccountsNativeBridgeController {
  api: AccountsNativeApi;
  transport: AccountsNativeTransport;
  setCompatibility(status: { compatible: boolean; reason?: string; hookSetSha256?: string | null }): void;
  waitForInitialization(timeoutMs: number): Promise<AccountsNativeStatus>;
  dispose(): void;
}

/**
 * Creates the isolated-world half of the Accounts native bridge. The exposed
 * transport accepts and returns data only; the parent main-world wrapper owns
 * native React elements and falls back before calling this bridge when its
 * compatibility receipt is not current.
 */
export function createAccountsNativeBridge(): AccountsNativeBridgeController {
  let compatible = false;
  let reason = "native-hooks-unverified";
  let trustedHookSetSha256 = "";
  let initializationAttempted = false;
  let initialized = false;
  let initializedHookSetSha256 = "";
  let revoked = false;
  let generation = 0;
  let adapter: AccountsNativeAdapter | null = null;
  let disposed = false;
  const selections = new Map<AccountsNativeSlotSurface, string | null>();
  const oauthBindings = new Map<string, {
    selection: AccountsNativeSelection;
    adapter: AccountsNativeAdapter;
    expiresAt: number;
  }>();
  const surfaceGenerations = new Map<AccountsNativeSlotSurface, number>(
    [...SLOT_SURFACES].map((surface) => [surface, 0]),
  );
  const subscribers = new Set<(event: { surface: AccountsNativeSlotSurface | null; generation: number }) => void>();

  const clearOauthBindings = (): void => { oauthBindings.clear(); };

  const pruneOauthBindings = (now = Date.now()): void => {
    for (const [state, binding] of oauthBindings) {
      if (binding.expiresAt <= now || binding.adapter !== adapter) oauthBindings.delete(state);
    }
  };

  const bindOauthState = (state: string, selection: AccountsNativeSelection, activeAdapter: AccountsNativeAdapter): void => {
    pruneOauthBindings();
    // A provider state collision makes both continuations ambiguous. Retain
    // neither instead of silently changing which account owns the callback.
    if (oauthBindings.has(state)) {
      oauthBindings.delete(state);
      return;
    }
    while (oauthBindings.size >= MAX_OAUTH_BINDINGS) oauthBindings.delete(oauthBindings.keys().next().value as string);
    oauthBindings.set(state, { selection, adapter: activeAdapter, expiresAt: Date.now() + OAUTH_BINDING_TTL_MS });
  };

  const consumeOauthBinding = (
    state: string,
    selection: AccountsNativeSelection,
    activeAdapter: AccountsNativeAdapter,
  ): boolean => {
    pruneOauthBindings();
    const binding = oauthBindings.get(state);
    if (!binding) return false;
    oauthBindings.delete(state);
    return binding.adapter === activeAdapter
      && binding.selection.accountId !== null
      && binding.selection.accountId === selection.accountId
      && binding.selection.generation === selection.generation;
  };

  const advance = (surface: AccountsNativeSlotSurface | null): void => {
    generation = generation >= Number.MAX_SAFE_INTEGER ? 1 : generation + 1;
    const affected = surface === null ? SLOT_SURFACES : [surface];
    for (const target of affected) {
      const current = surfaceGenerations.get(target) ?? 0;
      surfaceGenerations.set(target, current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1);
    }
    const event = Object.freeze({ surface, generation });
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* one main-world listener cannot break the bridge */ }
    }
  };

  const status = (): AccountsNativeStatus => Object.freeze({
    compatible: compatible && initialized && !revoked && !disposed,
    enabled: compatible && initialized && !revoked && !disposed && adapter !== null,
    generation,
    ...(!compatible || !initialized || disposed ? {
      reason: disposed ? "disposed" : revoked ? "native-wrapper-changed" : compatible && !initialized ? initializationAttempted ? "native-wrapper-initialization-rejected" : "native-wrapper-uninitialized" : reason,
    } : {}),
  });

  const snapshot = (surface: AccountsNativeSlotSurface): AccountsNativeSelection => {
    requireSlotSurface(surface);
    return Object.freeze({ accountId: selections.get(surface) ?? null, generation: surfaceGenerations.get(surface) ?? 0 });
  };

  const transport: AccountsNativeTransport = Object.freeze({
    initialize(value: { version: 1; hookSetSha256: string }): boolean {
      if (disposed || initializationAttempted) return false;
      initializationAttempted = true;
      initialized = compatible
        && !revoked
        && value?.version === 1
        && /^[a-f0-9]{64}$/.test(value.hookSetSha256)
        && value.hookSetSha256 === trustedHookSetSha256;
      if (initialized) initializedHookSetSha256 = value.hookSetSha256;
      else clearOauthBindings();
      advance(null);
      return initialized;
    },
    status,
    snapshot,
    subscribe(handler: (event: { surface: AccountsNativeSlotSurface | null; generation: number }) => void): () => void {
      if (typeof handler !== "function" || disposed) return () => {};
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    project(surface: AccountsNativeRequestSurface, kind: string, input: unknown): unknown {
      requireRequestSurface(surface);
      if (typeof kind !== "string" || !METHOD.test(kind) || !compatible || !initialized || revoked || disposed || adapter === null
        || typeof adapter.project !== "function") return input;
      try { return adapter.project(surface, kind, input); } catch { return input; }
    },
    async request(
      surface: AccountsNativeRequestSurface,
      method: string,
      params: Readonly<Record<string, unknown>>,
      selection: AccountsNativeSelection,
    ): Promise<unknown> {
      requireRequestSurface(surface);
      if (!METHOD.test(method) || !isPlainRecord(params)) throw bridgeError("invalid-native-request");
      const captured = requireSelection(selection);
      const current = snapshot(surface);
      if (!compatible || !initialized || revoked || disposed || adapter === null) throw bridgeError("native-bridge-disabled");
      const activeAdapter = adapter;
      const oauthCallback = isOauthCallbackRequest(surface, method, params);
      const callbackState = oauthCallback ? oauthCallbackState(params) : null;
      const oauthContinuation = callbackState
        ? consumeOauthBinding(callbackState, captured, activeAdapter)
        : false;
      if (oauthCallback && !oauthContinuation) throw bridgeError("stale-native-selection");
      if (!oauthCallback && (captured.generation !== current.generation || captured.accountId !== current.accountId)) {
        throw bridgeError("stale-native-selection");
      }
      const result = await activeAdapter.request(surface, method, Object.freeze({ ...params }), captured);
      const latest = snapshot(surface);
      if (!compatible || !initialized || revoked || disposed || adapter !== activeAdapter
        || (!oauthContinuation && (latest.generation !== captured.generation || latest.accountId !== captured.accountId))) {
        throw bridgeError("stale-native-selection");
      }
      const oauthState = oauthResponseState(surface, method, params, result);
      if (oauthState) bindOauthState(oauthState, captured, activeAdapter);
      return result;
    },
  });

  const api: AccountsNativeApi = Object.freeze({
    status,
    register(next: AccountsNativeAdapter): () => void {
      if (!next || typeof next.request !== "function" || disposed) return () => {};
      if (adapter !== next) clearOauthBindings();
      adapter = next;
      advance(null);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        if (adapter === next) {
          clearOauthBindings();
          adapter = null;
          advance(null);
        }
      };
    },
    select(surface: AccountsNativeSlotSurface, accountId: string | null): void {
      requireSlotSurface(surface);
      if (accountId !== null && !ACCOUNT_ID.test(accountId)) throw bridgeError("invalid-native-selection");
      if (selections.get(surface) === accountId) return;
      selections.set(surface, accountId);
      advance(surface);
    },
  });

  return {
    api,
    transport,
    setCompatibility(next) {
      if (disposed || typeof next?.compatible !== "boolean") return;
      const nextHash = typeof next.hookSetSha256 === "string" && /^[a-f0-9]{64}$/.test(next.hookSetSha256)
        ? next.hookSetSha256 : "";
      if (next.compatible && !nextHash) return;
      const nextReason = typeof next.reason === "string" && next.reason.length <= 120
        ? next.reason : next.compatible ? "" : "native-hooks-unverified";
      if (initializationAttempted && initialized && nextHash && nextHash !== initializedHookSetSha256) {
        if (revoked && !compatible && reason === "native-wrapper-changed") return;
        revoked = true;
        compatible = false;
        reason = "native-wrapper-changed";
        clearOauthBindings();
        advance(null);
        return;
      }
      if (revoked) return;
      if (compatible === next.compatible && reason === nextReason
        && (!nextHash || trustedHookSetSha256 === nextHash)) return;
      compatible = next.compatible;
      reason = nextReason;
      if (!compatible) clearOauthBindings();
      if (nextHash) trustedHookSetSha256 = nextHash;
      advance(null);
    },
    waitForInitialization(timeoutMs) {
      // DOMContentLoaded does not wait for the desktop's asynchronous module
      // graph. Only its receipt-bound wrapper may complete this handshake.
      const current = status();
      if (current.reason !== "native-wrapper-uninitialized") return Promise.resolve(current);
      return new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (next: AccountsNativeStatus) => {
          subscribers.delete(onChange);
          if (timer !== undefined) clearTimeout(timer);
          resolve(next);
        };
        const onChange = () => {
          const next = status();
          if (next.reason !== "native-wrapper-uninitialized") finish(next);
        };
        subscribers.add(onChange);
        timer = setTimeout(() => finish(status()), Math.max(0, Math.min(timeoutMs, 30_000)));
        onChange();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      adapter = null;
      selections.clear();
      clearOauthBindings();
      advance(null);
      subscribers.clear();
    },
  };
}

function isOauthCallbackRequest(
  surface: AccountsNativeRequestSurface,
  method: string,
  params: Readonly<Record<string, unknown>>,
): boolean {
  return surface === "apps" && method === "http.request"
    && params.verb === "POST"
    && params.path === "/aip/connectors/links/oauth/callback";
}

function oauthCallbackState(params: Readonly<Record<string, unknown>>): string | null {
  const options = isPlainRecord(params.options) ? params.options : null;
  const requestBody = isPlainRecord(options?.requestBody) ? options.requestBody : null;
  return oauthStateFromUrl(requestBody?.full_redirect_url);
}

function oauthResponseState(
  surface: AccountsNativeRequestSurface,
  method: string,
  params: Readonly<Record<string, unknown>>,
  result: unknown,
): string | null {
  if (surface !== "apps" || method !== "http.request" || params.verb !== "POST"
    || !["/aip/connectors/links/oauth", "/aip/connectors/links/oauth/reauth"].includes(String(params.path))) return null;
  return oauthStateFromUrl(isPlainRecord(result) ? result.redirect_url : null);
}

function oauthStateFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) return null;
  try {
    const state = new URL(value).searchParams.get("state");
    return state && state.length <= 4_096 && !/[\u0000-\u001f\u007f]/.test(state) ? state : null;
  } catch {
    return null;
  }
}

function requireRequestSurface(value: unknown): asserts value is AccountsNativeRequestSurface {
  if (!REQUEST_SURFACES.has(value as AccountsNativeRequestSurface)) throw bridgeError("invalid-native-surface");
}

function requireSlotSurface(value: unknown): asserts value is AccountsNativeSlotSurface {
  if (!SLOT_SURFACES.has(value as AccountsNativeSlotSurface)) throw bridgeError("invalid-native-surface");
}

function requireSelection(value: unknown): AccountsNativeSelection {
  if (!isPlainRecord(value) || !Number.isSafeInteger(value.generation) || (value.accountId !== null && !ACCOUNT_ID.test(String(value.accountId)))) {
    throw bridgeError("invalid-native-selection");
  }
  return Object.freeze({ accountId: value.accountId as string | null, generation: value.generation as number });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function bridgeError(code: string): Error {
  const error = new Error(code);
  error.name = "AccountsNativeBridgeError";
  return error;
}

export const accountsNativeBridge = createAccountsNativeBridge();
export const accountsNativeApi = accountsNativeBridge.api;
export const accountsNativeTransport = accountsNativeBridge.transport;
