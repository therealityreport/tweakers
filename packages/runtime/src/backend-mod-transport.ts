import type { ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { BackendMods } from "./backend-mods";

/** Keep native framing/backpressure; only failed transformed turns get local errors. */
export function createModInputStream(mods: BackendMods, reply: (value: unknown) => void): Transform {
  let pending = "";
  let bypassPartial = false;
  const decoder = new StringDecoder("utf8");
  let resume: (() => void) | undefined;
  return new Transform({
    read(size) {
      const pendingResume = resume; resume = undefined;
      pendingResume?.();
      Transform.prototype._read.call(this, size);
    },
    destroy(error, callback) { const pendingResume = resume; resume = undefined; pendingResume?.(); callback(error); },
    transform(chunk: Buffer, _encoding, callback) {
      if (!mods.hasTransforms && !pending) {
        const newline = chunk.lastIndexOf(10);
        bypassPartial = newline !== chunk.length - 1;
        this.push(chunk);
        callback();
        return;
      }
      // Finish a bypassed frame as bytes: its preceding chunk may split UTF-8.
      if (bypassPartial) {
        const newline = chunk.indexOf(10);
        if (newline < 0) { this.push(chunk); callback(); return; }
        this.push(chunk.subarray(0, newline + 1));
        chunk = chunk.subarray(newline + 1);
        bypassPartial = false;
      }
      pending += decoder.write(chunk);
      if (pending.length > 16 * 1024 * 1024) { callback(new Error("Backend mod request exceeds its framing limit")); return; }
      const pushFrame = async (frame: string) => {
        if (this.destroyed) throw new Error("Backend mod input was closed");
        if (!this.push(frame)) await new Promise<void>(resolve => { resume = resolve; });
      };
      const run = async () => {
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (this.destroyed) return;
          const raw = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          let request: Record<string, unknown>;
          try { request = JSON.parse(raw); }
          catch { await pushFrame(`${raw}\n`); continue; }
          if (!request || typeof request !== "object" || Array.isArray(request)) { await pushFrame(`${raw}\n`); continue; }
          try {
            const transformed = await mods.transform(request);
            await pushFrame(transformed === request ? `${raw}\n` : `${JSON.stringify(transformed)}\n`);
          } catch (error) {
            reply({ id: request.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : "Backend transform failed", data: { code: "tweakers_transform_failed" } } });
          }
        }
      };
      void run().then(() => callback(), callback);
    },
    flush(callback) {
      // A partial JSON-RPC frame is never dispatched after a transform was selected.
      if (pending) callback(new Error("Incomplete backend mod request")); else callback();
    },
  });
}

/** Insert local responses only between complete native newline-delimited frames. */
export function createModOutputStream(): { stream: Transform; reply(value: unknown): void } {
  let atBoundary = true;
  const replies: string[] = [];
  const drain = () => { for (const reply of replies.splice(0)) stream.push(reply); };
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const newline = chunk.lastIndexOf(10);
      if (newline >= 0) {
        this.push(chunk.subarray(0, newline + 1));
        drain();
        if (newline + 1 < chunk.length) this.push(chunk.subarray(newline + 1));
        atBoundary = newline === chunk.length - 1;
      } else { this.push(chunk); if (chunk.length) atBoundary = false; }
      callback();
    },
    flush(callback) {
      if (atBoundary) drain();
      callback(replies.length ? new Error("Native backend ended during a partial response") : undefined);
    },
  });
  return { stream, reply(value) {
    if (stream.destroyed) return;
    if (replies.length >= 256) { stream.destroy(new Error("Backend mod response queue exceeded its limit")); return; }
    replies.push(`${JSON.stringify(value)}\n`);
    if (atBoundary) drain();
  } };
}

export function attachBackendMods(child: ChildProcess, mods: BackendMods): void {
  if (!child.stdin || !child.stdout) return;
  const nativeInput = child.stdin;
  const nativeOutput = child.stdout;
  const { stream: outputStream, reply } = createModOutputStream();
  const input = createModInputStream(mods, reply);
  input.on("error", () => { nativeInput.destroy(); });
  nativeInput.on("error", () => { input.destroy(); });
  input.pipe(nativeInput);
  child.stdin = input;
  child.stdout = outputStream;
  let output = "";
  let decoder = new StringDecoder("utf8");
  let dropping = false;
  const observe = (chunk: Buffer) => {
    if (!mods.hasObservers) { output = ""; decoder = new StringDecoder("utf8"); if (chunk.length) dropping = chunk[chunk.length - 1] !== 10; return; }
    let text = decoder.write(chunk);
    if (dropping) {
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      text = text.slice(newline + 1); dropping = false;
    }
    output += text;
    let newline: number;
    while ((newline = output.indexOf("\n")) >= 0) {
      const raw = output.slice(0, newline); output = output.slice(newline + 1);
      if (raw.length <= 1024 * 1024) try { mods.observe(JSON.parse(raw)); } catch { /* Observers never affect native output. */ }
    }
    if (output.length > 1024 * 1024) { output = ""; dropping = true; }
  };
  outputStream.on("data", observe);
  outputStream.on("error", () => { nativeOutput.destroy(); });
  nativeOutput.on("error", error => outputStream.destroy(error));
  // Start forwarding after the spawn caller has attached its response listeners.
  queueMicrotask(() => { if (!outputStream.destroyed) nativeOutput.pipe(outputStream); });
  const dispose = () => { outputStream.removeListener("data", observe); input.unpipe(nativeInput); input.destroy(); output = ""; };
  child.once("close", dispose);
  child.once("error", dispose);
}
