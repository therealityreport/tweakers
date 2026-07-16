/**
 * Renderer-side tweak host. We:
 *   1. Ask main for the tweak list (with resolved entry path).
 *   2. For each renderer-scoped (or "both") tweak, fetch its source via IPC
 *      and execute it as a CommonJS-shaped function.
 *   3. Provide it the renderer half of the API.
 *
 * Codex runs the renderer with sandbox: true, so Node's `require()` is
 * restricted to a tiny whitelist (electron + a few polyfills). That means we
 * cannot `require()` arbitrary tweak files from disk. Instead we pull the
 * source string from main and evaluate it with `new Function` inside the
 * preload context. Tweak authors who need npm deps must bundle them in.
 */
export declare function startTweakHost(): Promise<void>;
/**
 * Stop every renderer-scope tweak so a subsequent `startTweakHost()` will
 * re-evaluate fresh source. Module cache isn't relevant since we eval
 * source strings directly — each load creates a fresh scope.
 */
export declare function teardownTweakHost(): void;
