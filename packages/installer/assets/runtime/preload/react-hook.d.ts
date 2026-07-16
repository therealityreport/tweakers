/**
 * Install a minimal __REACT_DEVTOOLS_GLOBAL_HOOK__. React calls
 * `hook.inject(rendererInternals)` during `createRoot`/`hydrateRoot`. The
 * "internals" object exposes findFiberByHostInstance, which lets us turn a
 * DOM node into a React fiber — necessary for our Settings injector.
 *
 * We don't want to break real React DevTools if the user opens it; we install
 * only if no hook exists yet, and we forward calls to a downstream hook if
 * one is later assigned.
 */
declare global {
    interface Window {
        __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevtoolsHook;
        __codexpp__?: {
            hook: ReactDevtoolsHook;
            renderers: Map<number, RendererInternals>;
        };
    }
}
interface RendererInternals {
    findFiberByHostInstance?: (n: Node) => unknown;
    version?: string;
    bundleType?: number;
    rendererPackageName?: string;
}
interface ReactDevtoolsHook {
    supportsFiber: true;
    renderers: Map<number, RendererInternals>;
    on(event: string, fn: (...a: unknown[]) => void): void;
    off(event: string, fn: (...a: unknown[]) => void): void;
    emit(event: string, ...a: unknown[]): void;
    inject(renderer: RendererInternals): number;
    onScheduleFiberRoot?(): void;
    onCommitFiberRoot?(): void;
    onCommitFiberUnmount?(): void;
    checkDCE?(): void;
}
export declare function installReactHook(): void;
/** Resolve the React fiber for a DOM node, if any renderer has one. */
export declare function fiberForNode(node: Node): unknown | null;
export {};
