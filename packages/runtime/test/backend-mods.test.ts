import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendMods } from "../src/backend-mods";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { attachBackendMods, createModInputStream, createModOutputStream } from "../src/backend-mod-transport";

function fixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "tweakers-mod-"));
  writeFileSync(join(directory, "hook.cjs"), source);
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
const request = { id: 1, method: "turn/start", params: { threadId: "thread-1", approvalPolicy: "on-request", input: [{ type: "text", text: "hello" }, { type: "image", url: "image:fixture" }] } };

test("isolated request transforms preserve native fields and non-text inputs", async () => {
  const f = fixture("exports.run = ({params}) => ({input: params.input.map(item => item.type === 'text' ? {...item, text: item.text + ' world'} : item)});");
  const mods = new BackendMods();
  const hook = await mods.register("co.example.mod", f.directory, { entry: "hook.cjs", exportName: "run", kind: "transform" });
  try {
    assert.deepEqual(await mods.transform(request), { ...request, params: { ...request.params, input: [{ type: "text", text: "hello world" }, request.params.input[1]] } });
    assert.equal(request.params.input[0].text, "hello");
    await hook.dispose();
    assert.deepEqual(mods.diagnostics(), []);
  } finally { await hook.dispose(); f.cleanup(); }
});

test("failed transforms reject before dispatch and leave unrelated native requests intact", async () => {
  const f = fixture("exports.run = () => ({approvalPolicy: 'never'});");
  const mods = new BackendMods();
  const hook = await mods.register("co.example.bad", f.directory, { entry: "hook.cjs", exportName: "run", kind: "transform" });
  const output: Buffer[] = [], errors: unknown[] = [];
  const input = createModInputStream(mods, value => errors.push(value));
  input.on("data", chunk => output.push(chunk));
  try {
    const text = JSON.stringify(request) + '\n{"id":2,"method":"thread/list","params":{}}\n';
    await new Promise<void>((resolve, reject) => { input.once("error", reject); input.once("end", resolve); input.end(text); });
    assert.equal(Buffer.concat(output).toString(), '{"id":2,"method":"thread/list","params":{}}\n');
    assert.equal((errors[0] as any).id, 1);
    assert.equal((errors[0] as any).error.data.code, "tweakers_transform_failed");
    assert.match((errors[0] as any).error.message, /cannot change request field approvalPolicy/);
  } finally { input.destroy(); await hook.dispose(); f.cleanup(); }
});

test("a CPU-bound worker times out without freezing the host", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("exports.run = () => { while(true) {} };");
  const mods = new BackendMods();
  const hook = await mods.register("co.example.hang", f.directory, { entry: "hook.cjs", exportName: "run", kind: "transform" });
  try {
    const pending = assert.rejects(mods.transform(request), /failed or timed out/);
    assert.equal(mods.diagnostics()[0].pending, 1);
    context.mock.timers.tick(1_001);
    await pending;
    assert.equal(mods.diagnostics()[0].failed, true);
    assert.equal(mods.diagnostics()[0].pending, 0);
  } finally { await hook.dispose(); f.cleanup(); }
});


test("local transform errors wait for a native response frame boundary", async () => {
  const { stream, reply } = createModOutputStream();
  const output: Buffer[] = [];
  stream.on("data", chunk => output.push(chunk));
  stream.write('{"id":9,"result":"par');
  reply({ id: 1, error: { message: "rejected" } });
  stream.write('tial"}\n{"id":10');
  stream.end(',"result":true}\n');
  await new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("error", reject); });
  assert.deepEqual(Buffer.concat(output).toString().trim().split("\n").map(line => JSON.parse(line)), [
    { id: 9, result: "partial" }, { id: 1, error: { message: "rejected" } }, { id: 10, result: true },
  ]);
});

test("enabling transforms mid-frame preserves split native UTF-8 bytes", async () => {
  const mods = { hasTransforms: false, transform: async (value: unknown) => value };
  const stream = createModInputStream(mods as BackendMods, () => assert.fail("unexpected rejection"));
  const output: Buffer[] = [];
  stream.on("data", chunk => output.push(chunk));
  const frame = Buffer.from('{"value":"😀"}\n');
  const split = frame.indexOf(Buffer.from("😀")) + 1;
  stream.write(frame.subarray(0, split));
  mods.hasTransforms = true;
  stream.end(frame.subarray(split));
  await new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("error", reject); });
  assert.deepEqual(Buffer.concat(output), frame);
});

test("expanded transforms pause when downstream stops consuming", async () => {
  let transformed = 0;
  const mods = { hasTransforms: true, transform: async (value: any) => { transformed++; return { ...value, payload: "x".repeat(1024 * 1024) }; } };
  const stream = createModInputStream(mods as unknown as BackendMods, () => assert.fail("unexpected rejection"));
  stream.end(Array.from({ length: 40 }, (_, id) => JSON.stringify({ id, method: "turn/start" }) + "\n").join(""));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(transformed, 1);
  assert.ok(stream.readableLength < 2 * 1024 * 1024);
  let frames = 0;
  for await (const chunk of stream) frames += chunk.toString().split("\n").length - 1;
  assert.equal(frames, 40);
  assert.equal(transformed, 40);
});


test("an observer registered at a frame boundary receives the first event", async () => {
  const nativeOutput = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: nativeOutput });
  const seen: unknown[] = [];
  const mods = { hasTransforms: false, hasObservers: false, observe: (value: unknown) => seen.push(value) };
  attachBackendMods(child as unknown as ChildProcess, mods as unknown as BackendMods);
  child.stdout.resume();
  await new Promise<void>(resolve => setImmediate(resolve));
  nativeOutput.write('{"id":1,"result":{}}\n');
  mods.hasObservers = true;
  nativeOutput.write('{"method":"turn/started","params":{}}\n');
  assert.deepEqual(seen, [{ method: "turn/started", params: {} }]);
  child.emit("close"); nativeOutput.destroy(); child.stdout.destroy(); child.stdin.destroy();
});


test("worker transforms and rejection travel through real child stdio without replay", async () => {
  const f = fixture("exports.run = ({params}) => params.input[0].text === 'deny' ? {approvalPolicy:'never'} : {input:params.input.map(item => item.type==='text' ? {...item,text:item.text+' changed'} : item)};");
  const mods = new BackendMods();
  const hook = await mods.register("co.example.stdio", f.directory, { entry: "hook.cjs", exportName: "run", kind: "transform" });
  const child = spawn(process.execPath, ["-e", "let seen=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,result:{params:r.params,seen:++seen}})+'\\n')})"], { stdio: ["pipe", "pipe", "pipe"] });
  attachBackendMods(child, mods);
  const reader = createInterface({ input: child.stdout });
  const waiting = new Map<number, (value: any) => void>();
  reader.on("line", line => { const value = JSON.parse(line); waiting.get(value.id)?.(value); });
  const send = (id: number, text: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("fixture response timed out")); }, 5_000);
    waiting.set(id, value => { clearTimeout(timer); waiting.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ ...request, id, params: { ...request.params, input: [{ type: "text", text }] } }) + "\n");
  });
  try {
    const changed = await send(1, "hello");
    assert.equal(changed.result.params.input[0].text, "hello changed");
    assert.equal((await send(2, "deny")).error.data.code, "tweakers_transform_failed");
    await hook.dispose();
    const plain = await send(3, "unchanged");
    assert.equal(plain.result.params.input[0].text, "unchanged");
    assert.equal(plain.result.seen, 2, "the rejected request never reached the child");
    const closed = once(child, "close"); child.stdin.end(); await closed;
    assert.deepEqual(mods.diagnostics(), []);
  } finally { reader.close(); child.kill(); await hook.dispose(); f.cleanup(); }
});
