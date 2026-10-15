import type { ChildProcess } from "node:child_process";
import { Transform } from "node:stream";
import type { BackendMods } from "./backend-mods";
/** Keep native framing/backpressure; only failed transformed turns get local errors. */
export declare function createModInputStream(mods: BackendMods, reply: (value: unknown) => void): Transform;
/** Insert local responses only between complete native newline-delimited frames. */
export declare function createModOutputStream(): {
    stream: Transform;
    reply(value: unknown): void;
};
export declare function attachBackendMods(child: ChildProcess, mods: BackendMods): void;
