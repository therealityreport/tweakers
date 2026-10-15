import { Worker } from "node:worker_threads";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BackendHookOptions } from "@therealityreport/tweakers-sdk";

const BOOTSTRAP = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
(async () => {
  const module = await import(pathToFileURL(workerData.entry).href);
  const fn = module[workerData.exportName] ?? module.default?.[workerData.exportName];
  if (typeof fn !== 'function') throw Error('Hook export is not a function');
  parentPort.on('message', async ({id, value}) => {
    try { parentPort.postMessage({id, value: await fn(value)}); }
    catch { parentPort.postMessage({id, error: true}); }
  });
  parentPort.postMessage({ready: true});
})().catch(() => parentPort.postMessage({startupError: true}));
`;

class HookWorker {
  private worker: Worker;
  private sequence = 0;
  private requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  failed = false;
  private disposed: Promise<void> | null = null;
  readonly ready: Promise<void>;
  constructor(readonly id: string, readonly kind: BackendHookOptions["kind"], entry: string, exportName: string) {
    this.worker = new Worker(BOOTSTRAP, { eval: true, workerData: { entry, exportName }, resourceLimits: { maxOldGenerationSizeMb: 64 }, stdout: true, stderr: true });
    // User hooks must not dump prompts or secrets into the desktop log.
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => { rejectReady(this.error()); void this.dispose(); }, 5_000);
      this.worker.on("message", message => {
        if (message?.ready) { clearTimeout(timer); resolveReady(); return; }
        if (message?.startupError) { clearTimeout(timer); rejectReady(this.error()); void this.dispose(); return; }
        const request = this.requests.get(message?.id);
        if (!request) return;
        this.requests.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(this.error()); else request.resolve(message.value);
      });
      const failed = () => { clearTimeout(timer); this.failed = true; rejectReady(this.error()); this.rejectPending(); };
      this.worker.on("error", failed);
      this.worker.on("exit", failed);
    });
  }
  get pending(): number { return this.requests.size; }
  private error(): Error { return new Error(`Backend hook ${this.id} failed or timed out`); }
  private rejectPending(): void {
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(this.error()); }
    this.requests.clear();
  }
  run(value: unknown): Promise<unknown> {
    if (this.failed || this.disposed || this.pending >= 16) return Promise.reject(this.error());
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.failed = true; void this.dispose(); }, 1_000);
      this.requests.set(id, { resolve: resolveResult, reject, timer });
      try { this.worker.postMessage({ id, value }); }
      catch { clearTimeout(timer); this.requests.delete(id); reject(this.error()); }
    });
  }
  dispose(): Promise<void> {
    if (!this.disposed) { this.rejectPending(); this.disposed = this.worker.terminate().then(() => {}); }
    return this.disposed;
  }
}

export class BackendMods {
  private hooks = new Map<string, HookWorker>();
  private sequence = 0;
  async register(tweakId: string, directory: string, options: BackendHookOptions): Promise<{ dispose(): Promise<void> }> {
    if (!options || !["observe", "transform"].includes(options.kind) || typeof options.entry !== "string"
      || isAbsolute(options.entry) || options.entry.includes("\\") || options.entry.split("/").includes("..")
      || !/^[$A-Za-z_][$\w]*$/.test(options.exportName)) throw new Error("Invalid backend hook declaration");
    if ([...this.hooks.keys()].filter(id => id.startsWith(`${tweakId}:`)).length >= 8) throw new Error("Too many backend hooks for this tweak");
    const root = realpathSync(directory);
    const entry = realpathSync(resolve(root, options.entry));
    const inside = relative(root, entry);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !statSync(entry).isFile()) throw new Error("Backend hook must be a file inside its tweak directory");
    const id = `${tweakId}:${String(++this.sequence).padStart(8, "0")}`;
    const worker = new HookWorker(id, options.kind, entry, options.exportName);
    this.hooks.set(id, worker);
    const dispose = async () => { this.hooks.delete(id); await worker.dispose(); };
    try { await worker.ready; } catch (error) { await dispose(); throw error; }
    return { dispose };
  }
  diagnostics() { return [...this.hooks.values()].map(hook => ({ id: hook.id, kind: hook.kind, pending: hook.pending, failed: hook.failed })); }
  private ordered(kind: BackendHookOptions["kind"]) { return [...this.hooks.values()].filter(hook => hook.kind === kind).sort((a, b) => a.id.localeCompare(b.id)); }
  get hasObservers(): boolean { return this.ordered("observe").length > 0; }
  get hasTransforms(): boolean { return this.ordered("transform").length > 0; }
  observe(value: unknown): void {
    if (!record(value) || typeof value.method !== "string" || !/^(?:turn\/(?:started|completed)|item\/(?:started|completed))$/.test(value.method)) return;
    const event = { method: value.method, params: value.params };
    for (const hook of this.ordered("observe")) void hook.run(event).catch(() => {});
  }
  async transform(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.hasTransforms || (request.method !== "turn/start" && request.method !== "turn/steer")) return request;
    if (!record(request.params) || !Array.isArray(request.params.input)) throw new Error("Native turn input is incompatible with backend transforms");
    let params = structuredClone(request.params);
    for (const hook of this.ordered("transform")) {
      const visible: Record<string, unknown> = { input: params.input };
      if (request.method === "turn/start") for (const key of ["model", "effort", "summary"]) if (key in params) visible[key] = params[key];
      const patch = await hook.run({ method: request.method, params: visible });
      if (patch === undefined || patch === null) continue;
      if (!record(patch)) throw new Error(`Backend hook ${hook.id} returned an invalid request update`);
      for (const key of Object.keys(patch)) {
        if (key === "input") validateInput(params.input as unknown[], patch.input);
        else if (request.method !== "turn/start" || !["model", "effort", "summary"].includes(key) || (patch[key] !== null && typeof patch[key] !== "string")) {
          throw new Error(`Backend hook ${hook.id} cannot change request field ${key}`);
        }
      }
      params = { ...params, ...patch };
      if (JSON.stringify(params).length > 4 * 1024 * 1024) throw new Error("Backend transform result exceeds its size limit");
    }
    return { ...request, params };
  }
}

function validateInput(original: unknown[], updated: unknown): void {
  if (!Array.isArray(updated) || updated.length !== original.length) throw new Error("Transforms may edit existing text inputs only");
  for (let index = 0; index < original.length; index++) {
    const before = original[index], after = updated[index];
    if (!record(before) || before.type !== "text") {
      if (!isDeepStrictEqual(before, after)) throw new Error("Transforms cannot replace non-text inputs");
    } else {
      if (!record(after) || typeof after.text !== "string" || !isDeepStrictEqual({ ...before, text: "" }, { ...after, text: "" })) throw new Error("Transforms may change input text only");
    }
  }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
