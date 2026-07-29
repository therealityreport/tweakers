import type { HostMcpFormAttachResult, HostSurfaceKind, HostSurfaceMatch, HostUiApi, ReactFiberNode } from "@therealityreport/tweakers-sdk";
export declare const MCP_CARRIER_NONCE_PREFIX = "__tweakers_carrier_nonce_";
export declare const hostUiApi: HostUiApi;
/**
 * Find the one standard MCP form carrying this nonce. Discovery uses schema
 * property keys only; visible prompt, label, option, and answer text are never
 * inspected.
 */
export declare function attachMcpFormCarrier(nonce: string): HostMcpFormAttachResult;
/** Exported for a repository-local drift harness; tweaks use hostUiApi. */
export declare function attachMcpFormElement(form: HTMLFormElement, nonce: string, resolveFiber?: (element: Element) => ReactFiberNode | null): HostMcpFormAttachResult;
export declare function queryHostSurfaces(kind: HostSurfaceKind): HostSurfaceMatch[];
