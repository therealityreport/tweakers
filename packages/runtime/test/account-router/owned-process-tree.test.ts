import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import test from "node:test";
import { BrokerProcessChild } from "../../src/account-router/broker-host";
import type { OpaqueAccountId } from "../../src/account-router/types";
import { captureOwnedRootV1, captureOwnedTreeV1, signalVerifiedTreeV1, verifiedSurvivorsV1, type ProcessIdentityV1, type ProcessTreeAccessV1 } from "../../src/account-router/owned-process-tree";

function controlledTree() {
  const root = { pid: 41, ppid: process.pid, started: "Thu Sep 24 12:00:00 2026" };
  const child = { pid: 42, ppid: 41, started: "Thu Sep 24 12:00:01 2026" };
  const grandchild = { pid: 43, ppid: 42, started: "Thu Sep 24 12:00:02 2026" };
  const foreign = { pid: 44, ppid: 1, started: "Thu Sep 24 12:00:03 2026" };
  let rows: ProcessIdentityV1[] | null = [root, child, grandchild, foreign];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const access: ProcessTreeAccessV1 = {
    read: async () => rows,
    signal(pid, signal) { signals.push({ pid, signal }); rows = rows?.filter(row => row.pid !== pid) ?? null; return true; },
  };
  return { root, child, grandchild, foreign, access, signals, setRows: (value: ProcessIdentityV1[] | null) => { rows = value; } };
}

test("owned session teardown selects verified descendants deepest first and leaves foreign processes", async () => {
  const fixture = controlledTree();
  const root = await captureOwnedRootV1(fixture.root.pid, fixture.access);
  assert.deepEqual(root, fixture.root);
  const tree = await captureOwnedTreeV1(root!, fixture.access);
  assert.deepEqual(tree, [fixture.root, fixture.child, fixture.grandchild]);
  assert.equal(await signalVerifiedTreeV1(tree!, fixture.access, "SIGTERM"), true);
  assert.deepEqual(fixture.signals.map(row => row.pid), [43, 42, 41]);
  assert.deepEqual(await verifiedSurvivorsV1(tree!, fixture.access), []);
});

test("unknown census and a reused descendant PID never authorize a signal", async () => {
  const fixture = controlledTree();
  const root = (await captureOwnedRootV1(fixture.root.pid, fixture.access))!;
  const tree = (await captureOwnedTreeV1(root, fixture.access))!;
    fixture.setRows(null);
    assert.equal(await signalVerifiedTreeV1(tree, fixture.access, "SIGTERM"), false);
    assert.equal(fixture.signals.length, 0);
  fixture.setRows([fixture.root, { ...fixture.child, started: "Thu Sep 24 12:01:00 2026" }, fixture.foreign]);
  assert.equal(await signalVerifiedTreeV1(tree, fixture.access, "SIGKILL"), true);
  assert.deepEqual(fixture.signals.map(row => row.pid), [41]);
  assert.ok(!fixture.signals.some(row => row.pid === fixture.child.pid || row.pid === fixture.foreign.pid));
});

test("root must be the exact Tweakers child before descendants are selected", async () => {
  const fixture = controlledTree();
  assert.equal(await captureOwnedRootV1(fixture.foreign.pid, fixture.access), null);
  fixture.setRows([{ ...fixture.root, started: "Thu Sep 24 12:01:00 2026" }, fixture.child]);
  assert.equal(await captureOwnedTreeV1(fixture.root, fixture.access), null);
  assert.deepEqual(fixture.signals, []);
});

test("a descendant PID replaced between signals is preserved", async () => {
  const fixture = controlledTree();
  const tree = (await captureOwnedTreeV1(fixture.root, fixture.access))!;
  const access: ProcessTreeAccessV1 = {
    read: fixture.access.read,
    signal(pid, signal) {
      const sent = fixture.access.signal(pid, signal);
      if (pid === fixture.grandchild.pid) fixture.setRows([
        fixture.root, { ...fixture.child, started: "Thu Sep 24 12:01:00 2026" }, fixture.foreign,
      ]);
      return sent;
    },
  };
  assert.equal(await signalVerifiedTreeV1(tree, access, "SIGTERM"), true);
  assert.deepEqual(fixture.signals.map(row => row.pid), [43, 41]);
});

test("broker child closes ownership only after its controlled descendant tree exits", async () => {
  const fixture = controlledTree();
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unexpected direct ChildProcess signal"); },
  });
  const access: ProcessTreeAccessV1 = {
    read: fixture.access.read,
    signal(pid, signal) {
      const sent = fixture.access.signal(pid, signal);
      if (pid === fixture.root.pid) queueMicrotask(() => {
        processChild.exitCode = 0;
        processChild.emit("exit", 0, signal);
      });
      return sent;
    },
  };
  const closed: boolean[] = [];
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, expected => { closed.push(expected); }, undefined, undefined, access);
  try {
    assert.equal(await child.terminateAndWait(), true);
    await child.whenClosed();
    assert.deepEqual(fixture.signals.map(row => row.pid), [43, 42, 41]);
    assert.deepEqual(closed, [true]);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});

test("normal teardown captures a descendant added after child readiness", async () => {
  const fixture = controlledTree();
  fixture.setRows([fixture.root, fixture.foreign]);
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unexpected direct ChildProcess signal"); },
  });
  const access: ProcessTreeAccessV1 = {
    read: fixture.access.read,
    signal(pid, signal) {
      const sent = fixture.access.signal(pid, signal);
      if (pid === fixture.root.pid) queueMicrotask(() => {
        processChild.exitCode = 0;
        processChild.emit("exit", 0, signal);
      });
      return sent;
    },
  };
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, () => {}, undefined, undefined, access);
  try {
    const ready = child.initialize({ clientInfo: { name: "fixture", version: "1" } }, {} as never);
    const request = JSON.parse(processChild.stdin.read().toString()) as { id: string };
    processChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { userAgent: "fixture/1" } }) + "\n");
    assert.equal(await ready, true);
    fixture.setRows([fixture.root, fixture.child, fixture.grandchild, fixture.foreign]);
    assert.equal(await child.terminateAndWait(), true);
    assert.deepEqual(fixture.signals.map(row => row.pid), [43, 42, 41], "late descendants must be included in the teardown census");
    assert.equal(fixture.signals.some(row => row.pid === fixture.foreign.pid), false);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});

test("an unexpected root exit before teardown releases ownership without signalling orphaned descendants", async () => {
  const fixture = controlledTree();
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unexpected direct ChildProcess signal"); },
  });
  const closeEvents: Array<[boolean, boolean | undefined]> = [];
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, (expected, retained) => closeEvents.push([expected, retained]), undefined, undefined, fixture.access);
  try {
    const ready = child.initialize({ clientInfo: { name: "fixture", version: "1" } }, {} as never);
    const request = JSON.parse(processChild.stdin.read().toString()) as { id: string };
    processChild.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { userAgent: "fixture/1" } }) + "\n");
    assert.equal(await ready, true);
    fixture.setRows([{ ...fixture.child, ppid: 1 }, { ...fixture.grandchild, ppid: 1 }, fixture.foreign]);
    processChild.exitCode = 17;
    processChild.emit("exit", 17, null);
    // Nothing is provable after the root exits, so nothing is signalled, but
    // ownership must still release or every broker shutdown wedges forever.
    assert.equal(await child.terminateAndWait(), true);
    assert.deepEqual(fixture.signals, []);
    assert.deepEqual(closeEvents.slice(0, 1), [[false, true]]);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});

test("unknown ownership never signals and retains broker recovery", async () => {
  const fixture = controlledTree();
  let reads = 0;
  const access: ProcessTreeAccessV1 = {
    read: async () => ++reads === 1 ? [fixture.root] : null,
    signal() { throw new Error("unknown identity was signalled"); },
  };
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unverified direct child was signalled"); },
  });
  const closeEvents: Array<[boolean, boolean | undefined]> = [];
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, (expected, retained) => closeEvents.push([expected, retained]), undefined, undefined, access);
  try {
    assert.equal(await child.terminateAndWait(), false);
    assert.deepEqual(closeEvents, [[false, true]]);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});

test("failed descendant stop retries after root exit using captured identities", async () => {
  const fixture = controlledTree();
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unexpected direct ChildProcess signal"); },
  });
  let descendantsCanStop = false;
  const access: ProcessTreeAccessV1 = {
    read: fixture.access.read,
    signal(pid, signal) {
      if (pid !== fixture.root.pid && !descendantsCanStop) return false;
      const sent = fixture.access.signal(pid, signal);
      if (pid === fixture.root.pid) queueMicrotask(() => {
        processChild.exitCode = 0;
        processChild.emit("exit", 0, signal);
      });
      return sent;
    },
  };
  const closeEvents: Array<[boolean, boolean | undefined]> = [];
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, (expected, retained) => closeEvents.push([expected, retained]), undefined, undefined, access);
  try {
    assert.equal(await child.terminateAndWait(), false);
    assert.deepEqual(closeEvents, [[false, true]]);
    descendantsCanStop = true;
    assert.equal(await child.terminateAndWait(), true);
    assert.deepEqual(fixture.signals.map(row => row.pid), [41, 43, 42]);
    assert.deepEqual(closeEvents, [[false, true], [true, undefined]]);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});

test("retry preserves previously owned descendants reparented while the root remains alive", async () => {
  const fixture = controlledTree();
  const processChild = Object.assign(new EventEmitter(), {
    pid: fixture.root.pid, stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null as number | null, signalCode: null,
    kill() { throw new Error("unexpected direct ChildProcess signal"); },
  });
  let retry = false;
  const access: ProcessTreeAccessV1 = {
    read: fixture.access.read,
    signal(pid, signal) {
      if (!retry) return false;
      const sent = fixture.access.signal(pid, signal);
      if (pid === fixture.root.pid) queueMicrotask(() => {
        processChild.exitCode = 0;
        processChild.emit("exit", 0, signal);
      });
      return sent;
    },
  };
  const child = new BrokerProcessChild("ar_fixture" as OpaqueAccountId, processChild as unknown as ChildProcess,
    () => {}, () => {}, undefined, undefined, access);
  try {
    assert.equal(await child.terminateAndWait(), false);
    fixture.setRows([fixture.root, { ...fixture.child, ppid: 1 }, { ...fixture.grandchild, ppid: 1 }, fixture.foreign]);
    retry = true;
    assert.equal(await child.terminateAndWait(), true);
    assert.deepEqual(fixture.signals.map(row => row.pid), [43, 42, 41]);
  } finally { processChild.stdin.destroy(); processChild.stdout.destroy(); }
});
