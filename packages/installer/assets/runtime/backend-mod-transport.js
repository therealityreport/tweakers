"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createModInputStream = createModInputStream;
exports.createModOutputStream = createModOutputStream;
exports.attachBackendMods = attachBackendMods;
const node_stream_1 = require("node:stream");
const node_string_decoder_1 = require("node:string_decoder");
/** Keep native framing/backpressure; only failed transformed turns get local errors. */
function createModInputStream(mods, reply) {
    let pending = "";
    let bypassPartial = false;
    const decoder = new node_string_decoder_1.StringDecoder("utf8");
    let resume;
    return new node_stream_1.Transform({
        read(size) {
            const pendingResume = resume;
            resume = undefined;
            pendingResume?.();
            node_stream_1.Transform.prototype._read.call(this, size);
        },
        destroy(error, callback) { const pendingResume = resume; resume = undefined; pendingResume?.(); callback(error); },
        transform(chunk, _encoding, callback) {
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
                if (newline < 0) {
                    this.push(chunk);
                    callback();
                    return;
                }
                this.push(chunk.subarray(0, newline + 1));
                chunk = chunk.subarray(newline + 1);
                bypassPartial = false;
            }
            pending += decoder.write(chunk);
            if (pending.length > 16 * 1024 * 1024) {
                callback(new Error("Backend mod request exceeds its framing limit"));
                return;
            }
            const pushFrame = async (frame) => {
                if (this.destroyed)
                    throw new Error("Backend mod input was closed");
                if (!this.push(frame))
                    await new Promise(resolve => { resume = resolve; });
            };
            const run = async () => {
                let newline;
                while ((newline = pending.indexOf("\n")) >= 0) {
                    if (this.destroyed)
                        return;
                    const raw = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    let request;
                    try {
                        request = JSON.parse(raw);
                    }
                    catch {
                        await pushFrame(`${raw}\n`);
                        continue;
                    }
                    if (!request || typeof request !== "object" || Array.isArray(request)) {
                        await pushFrame(`${raw}\n`);
                        continue;
                    }
                    try {
                        const transformed = await mods.transform(request);
                        await pushFrame(transformed === request ? `${raw}\n` : `${JSON.stringify(transformed)}\n`);
                    }
                    catch (error) {
                        reply({ id: request.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : "Backend transform failed", data: { code: "tweakers_transform_failed" } } });
                    }
                }
            };
            void run().then(() => callback(), callback);
        },
        flush(callback) {
            // A partial JSON-RPC frame is never dispatched after a transform was selected.
            if (pending)
                callback(new Error("Incomplete backend mod request"));
            else
                callback();
        },
    });
}
/** Insert local responses only between complete native newline-delimited frames. */
function createModOutputStream() {
    let atBoundary = true;
    const replies = [];
    const drain = () => { for (const reply of replies.splice(0))
        stream.push(reply); };
    const stream = new node_stream_1.Transform({
        transform(chunk, _encoding, callback) {
            const newline = chunk.lastIndexOf(10);
            if (newline >= 0) {
                this.push(chunk.subarray(0, newline + 1));
                drain();
                if (newline + 1 < chunk.length)
                    this.push(chunk.subarray(newline + 1));
                atBoundary = newline === chunk.length - 1;
            }
            else {
                this.push(chunk);
                if (chunk.length)
                    atBoundary = false;
            }
            callback();
        },
        flush(callback) {
            if (atBoundary)
                drain();
            callback(replies.length ? new Error("Native backend ended during a partial response") : undefined);
        },
    });
    return { stream, reply(value) {
            if (stream.destroyed)
                return;
            if (replies.length >= 256) {
                stream.destroy(new Error("Backend mod response queue exceeded its limit"));
                return;
            }
            replies.push(`${JSON.stringify(value)}\n`);
            if (atBoundary)
                drain();
        } };
}
function attachBackendMods(child, mods) {
    if (!child.stdin || !child.stdout)
        return;
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
    let decoder = new node_string_decoder_1.StringDecoder("utf8");
    let dropping = false;
    const observe = (chunk) => {
        if (!mods.hasObservers) {
            output = "";
            decoder = new node_string_decoder_1.StringDecoder("utf8");
            if (chunk.length)
                dropping = chunk[chunk.length - 1] !== 10;
            return;
        }
        let text = decoder.write(chunk);
        if (dropping) {
            const newline = text.indexOf("\n");
            if (newline < 0)
                return;
            text = text.slice(newline + 1);
            dropping = false;
        }
        output += text;
        let newline;
        while ((newline = output.indexOf("\n")) >= 0) {
            const raw = output.slice(0, newline);
            output = output.slice(newline + 1);
            if (raw.length <= 1024 * 1024)
                try {
                    mods.observe(JSON.parse(raw));
                }
                catch { /* Observers never affect native output. */ }
        }
        if (output.length > 1024 * 1024) {
            output = "";
            dropping = true;
        }
    };
    outputStream.on("data", observe);
    outputStream.on("error", () => { nativeOutput.destroy(); });
    nativeOutput.on("error", error => outputStream.destroy(error));
    // Start forwarding after the spawn caller has attached its response listeners.
    queueMicrotask(() => { if (!outputStream.destroyed)
        nativeOutput.pipe(outputStream); });
    const dispose = () => { outputStream.removeListener("data", observe); input.unpipe(nativeInput); input.destroy(); output = ""; };
    child.once("close", dispose);
    child.once("error", dispose);
}
//# sourceMappingURL=backend-mod-transport.js.map