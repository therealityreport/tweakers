import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";

const source = readFileSync(resolve(process.cwd(), "packages/runtime/src/main.ts"), "utf8");

test("Settings open requests use one visible application-menu command", () => {
  const helperStart = source.indexOf("function openNativeSettingsFromApplicationMenu");
  const helperEnd = source.indexOf("// 3. IPC", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /Menu\.getApplicationMenu\(\)/);
  assert.match(helper, /item\.enabled === false \|\| item\.visible === false/);
  assert.match(helper, /if \(unique\.length !== 1\) \{ onRejected\?\.\("candidate-count", unique\.length\); return false; \}/);
  assert.doesNotMatch(helper, /globalShortcut|sendInputEvent/);
  assert.match(source, /ipcMain\.handle\("tweaker:open-settings"/);
});

test("runtime-ready Settings retries an accepted command until exact-primary mount acknowledgement", () => {
  const start = source.indexOf("function stopRuntimeReadySettingsMountAttempts");
  const end = source.indexOf("function readManagedRuntimeSourceHash", start);
  assert.ok(start >= 0 && end > start);
  const retry = source.slice(start, end);
  assert.match(source, /const RUNTIME_READY_SETTINGS_OPEN_INTERVAL_MS = 2_000/);
  assert.match(source, /const RUNTIME_READY_SETTINGS_OPEN_ACK_GRACE_MS = 6_000/);
  assert.match(source, /const RUNTIME_READY_SETTINGS_OPEN_DEADLINE_MS = 45_000/);
  assert.match(source, /const RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS = 30/);
  assert.match(source, /let runtimeReadySettingsOpenAttemptCount = 0/);
  assert.match(source, /let runtimeReadySettingsOpenAttemptOperationId: string \| null = null/);
  assert.match(source, /let runtimeReadySettingsOpenTerminalOperationId: string \| null = null/);
  assert.match(retry, /const expectation = readRuntimeReadyExpectation\(\)/);
  assert.match(source, /if \(options\.isMounted\(\)\)/);
  assert.match(source, /if \(options\.isPublished\(\)\)/);
  assert.match(source, /if \(!expectation\)/);
  assert.match(source, /const owner = options\.getExactPrimary\(\)/);
  assert.match(source, /const accepted = owner !== null && options\.open\(owner\)/);
  assert.match(source, /schedule\(attempt, options\.intervalMs\)/);
  assert.match(source, /schedule\(attempt, accepted \? options\.acknowledgementGraceMs : options\.intervalMs\)/);
  assert.match(source, /if \(now >= deadlineAt\)/);
  assert.match(source, /Math\.min\(delayMs, remaining\)/);
  assert.match(retry, /runtimeReadySettingsOpenAttemptCount >= maxAttempts/);
  assert.match(retry, /runtimeReadySettingsOpenAttemptOperationId !== expectation\.operationId/);
  assert.match(retry, /runtimeReadySettingsOpenTerminalOperationId === expectation\.operationId/);
  assert.doesNotMatch(retry, /let attempts = 0/);
  assert.doesNotMatch(retry, /getFocusedWindow|getPrimaryCodexWindow/);
  assert.doesNotMatch(retry, /runtimeReadySettingsOpenTriggered/);
  assert.match(retry, /const ready = runtimeReadyInitializedTweakIds\(\) !== null/);
  assert.match(source, /runtimeReadySettingsMounted = true;\n  stopRuntimeReadySettingsMountAttempts\(\);/);
  assert.match(source, /runRuntimeDiagnosticDiskOperation\(acceptanceConfig, \(\) => publishIndependentTweakersRuntimeReadyReceipt\(RUNTIME_READY_FILE, receipt\)\);\n    stopRuntimeReadySettingsMountAttempts\(\);/);
});

type SettingsRejection = "missing-menu" | "candidate-count" | "click-failed";
type FixtureMenuItem = { label: string; enabled?: boolean; visible?: boolean; click?: (...args: unknown[]) => void };

function loadSettingsOpener(menu: { items: FixtureMenuItem[] } | null, logs: unknown[][] = []) {
  const start = source.indexOf("function openNativeSettingsFromApplicationMenu");
  const body = source.slice(start, source.indexOf("// 3. IPC", start));
  const compiled = transpileModule(`${body}\nreturn openNativeSettingsFromApplicationMenu;`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function("Menu", "log", compiled)(
    { getApplicationMenu: () => menu }, (...args: unknown[]) => logs.push(args),
  ) as (owner?: unknown, onRejected?: (reason: SettingsRejection, count?: number) => void) => boolean;
}

test("Settings opener reports missing, absent and ambiguous menu candidates", () => {
  const cases: Array<[{ items: FixtureMenuItem[] } | null, [SettingsRejection, number?]]> = [
    [null, ["missing-menu"]],
    [{ items: [{ label: "Other", click() {} }, { label: "Settings", enabled: false, click() {} }, { label: "Preferences", visible: false, click() {} }] }, ["candidate-count", 0]],
    [{ items: [{ label: "Settings", click() {} }, { label: "Preferences", click() {} }] }, ["candidate-count", 2]],
  ];
  for (const [menu, expected] of cases) {
    const rejected: unknown[][] = [];
    const open = loadSettingsOpener(menu);
    assert.equal(open({ id: 1 }, (...args) => rejected.push(args)), false);
    assert.deepEqual(rejected, [expected]);
  }
});

test("Settings opener invokes the unique candidate with its exact owner", () => {
  const owner = { id: 1 };
  const calls: unknown[][] = [];
  const item = { label: "Settings", click(this: unknown, ...args: unknown[]) { calls.push([this, ...args]); } };
  const rejected: unknown[][] = [];
  assert.equal(loadSettingsOpener({ items: [item, item] })(owner, (...args) => rejected.push(args)), true);
  assert.deepEqual(calls, [[item, item, owner, undefined]]);
  assert.deepEqual(rejected, []);
});

test("Settings opener reports click failure without exposing thrown content", () => {
  const logs: unknown[][] = [];
  const open = loadSettingsOpener({ items: [{ label: "Settings", click() { throw new Error("private menu content"); } }] }, logs);
  const rejected: unknown[][] = [];
  assert.equal(open({ id: 1 }, (...args) => rejected.push(args)), false);
  assert.deepEqual(rejected, [["click-failed"]]);
  assert.deepEqual(logs, []);
  assert.equal(open(), false);
  assert.deepEqual(logs, [["warn", "open settings application-menu action failed", { reason: "click-failed" }]]);
});

test("Settings mount blocker diagnostics deduplicate and reset after acceptance or operation change", () => {
  const start = source.indexOf("function requestRuntimeReadySettingsMount");
  const body = source.slice(start, source.indexOf("function readManagedRuntimeSourceHash", start));
  const capture: { options: Record<string, (...args: any[]) => any> | null } = { options: null };
  let ready = false;
  let owner: { id: number } | null = null;
  let rejection: [SettingsRejection, number?] | null = ["candidate-count", 0];
  const logs: unknown[][] = [];
  const compiled = transpileModule(`
    let runtimeReadySettingsMounted = false, runtimeReadyPublished = false;
    let runtimeReadySettingsOpenController = null, runtimeReadySettingsOpenTimer = null;
    let runtimeReadySettingsOpenAttemptOperationId = null, runtimeReadySettingsOpenTerminalOperationId = null;
    let runtimeReadySettingsOpenAttemptCount = 0;
    const RUNTIME_READY_SETTINGS_OPEN_INTERVAL_MS = 2000, RUNTIME_READY_SETTINGS_OPEN_ACK_GRACE_MS = 6000;
    const RUNTIME_READY_SETTINGS_OPEN_DEADLINE_MS = 45000, RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS = 30;
    ${body}\nrequestRuntimeReadySettingsMount();`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  new Function("readRuntimeReadyExpectation", "createRuntimeReadySettingsMountRetryController", "runtimeReadyInitializedTweakIds", "exactIndependentTweakersPrimaryWindow", "openNativeSettingsFromApplicationMenu", "log", "nativeStartupPreparationTimeoutMs", compiled)(
    () => ({ operationId: "operation-a" }),
    (value: NonNullable<typeof capture.options>) => { capture.options = value; return { start() {} }; },
    () => ready ? [] : null,
    () => owner,
    (_owner: unknown, callback: (reason: SettingsRejection, count?: number) => void) => { if (rejection) callback(...rejection); return rejection === null; },
    (...args: unknown[]) => logs.push(args),
    () => 0,
  );
  assert.ok(capture.options);
  const options = capture.options;
  options.isReady(); options.isReady();
  ready = true;
  options.isReady(); options.getExactPrimary(); options.getExactPrimary();
  owner = { id: 1 };
  options.open(owner); options.open(owner);
  options.onRequest(1, true);
  options.open(owner);
  options.onAttemptStateChange("operation-b", 0);
  options.open(owner);
  rejection = ["candidate-count", 2];
  options.open(owner);
  assert.deepEqual(logs.filter((entry) => entry[1] === "runtime-ready Settings mount blocked").map((entry) => entry[2]), [
    { operationId: "operation-a", reason: "not-ready" },
    { operationId: "operation-a", reason: "primary-missing" },
    { operationId: "operation-a", reason: "candidate-count", count: 0 },
    { operationId: "operation-a", reason: "candidate-count", count: 0 },
    { operationId: "operation-b", reason: "candidate-count", count: 0 },
    { operationId: "operation-b", reason: "candidate-count", count: 2 },
  ]);
});

function loadRetryController(): (options: Record<string, unknown>) => {
  start(): void;
  stop(): void;
} {
  const bodyStart = source.indexOf("function createRuntimeReadySettingsMountRetryController");
  const body = source.slice(bodyStart, source.indexOf("\n}\n\nlet runtimeReadySettingsOpenController", bodyStart) + 2);
  const compiled = transpileModule(`${body}\nreturn createRuntimeReadySettingsMountRetryController;`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  return new Function(compiled)() as (options: Record<string, unknown>) => {
    start(): void;
    stop(): void;
  };
}

class FakeClock {
  nowMs = 0;
  nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();

  now = (): number => this.nowMs;

  schedule = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delayMs, callback });
    return id;
  };

  cancel = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  advance = (durationMs: number): void => {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.nowMs = next[1].at;
      next[1].callback();
    }
    this.nowMs = target;
  };
}

function controllerOptions(clock: FakeClock, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    intervalMs: 2_000,
    acknowledgementGraceMs: 6_000,
    deadlineMs: 45_000,
    maxAttempts: 30,
    initialOperationId: "operation-a",
    initialAttemptCount: 0,
    readExpectation: () => ({ operationId: "operation-a" }),
    isMounted: () => false,
    isPublished: () => false,
    isReady: () => true,
    getExactPrimary: () => ({ id: "primary" }),
    open: () => true,
    onAttemptStateChange: () => {},
    onRequest: () => {},
    onStopped: () => {},
    ...overrides,
  };
}

test("Settings mount waits for signed native preparation, then sends one acknowledged request", () => {
  const clock = new FakeClock();
  let mounted = false, requests = 0;
  const reasons: string[] = [];
  const controller = loadRetryController()(controllerOptions(clock, {
    deadlineMs: 645_000,
    isReady: () => clock.nowMs >= 176_000,
    isMounted: () => mounted,
    open: () => { requests++; mounted = true; return true; },
    onStopped: (reason: string) => reasons.push(reason),
  }));
  controller.start();
  clock.advance(175_000);
  assert.equal(requests, 0);
  assert.deepEqual(reasons, []);
  clock.advance(8_000);
  assert.equal(requests, 1);
  assert.deepEqual(reasons, ["mounted"]);
  clock.advance(645_000);
  assert.equal(requests, 1, "acknowledgement must cancel all later requests");
});

test("Settings mount retains an absolute bound when signed native preparation never finishes", () => {
  const clock = new FakeClock();
  const reasons: string[] = [];
  const controller = loadRetryController()(controllerOptions(clock, {
    deadlineMs: 645_000,
    isReady: () => false,
    open: () => { throw Error("Settings must not open before preparation"); },
    onStopped: (reason: string) => reasons.push(reason),
  }));
  controller.start();
  clock.advance(645_000);
  assert.deepEqual(reasons, ["deadline"]);
  assert.equal(clock.timers.size, 0);
});

test("Settings retries outlast native critical initialization within the existing startup deadline", () => {
  const start = source.indexOf("function requestRuntimeReadySettingsMount");
  const body = source.slice(start, source.indexOf("function readManagedRuntimeSourceHash", start));
  const compiled = transpileModule(`
    let runtimeReadySettingsMounted = false, runtimeReadySettingsOpenController = null;
    let runtimeReadySettingsOpenAttemptOperationId = null, runtimeReadySettingsOpenTerminalOperationId = null;
    let runtimeReadySettingsOpenAttemptCount = 0;
    const RUNTIME_READY_SETTINGS_OPEN_INTERVAL_MS = 2000, RUNTIME_READY_SETTINGS_OPEN_ACK_GRACE_MS = 6000;
    const RUNTIME_READY_SETTINGS_OPEN_DEADLINE_MS = 45000, RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS = 30;
    ${body}\nrequestRuntimeReadySettingsMount();`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  let captured: Record<string, unknown> = {};
  new Function("readRuntimeReadyExpectation", "createRuntimeReadySettingsMountRetryController", "nativeStartupPreparationTimeoutMs", compiled)(
    () => ({ operationId: "operation-a" }),
    (options: Record<string, unknown>) => { captured = options; return { start() {} }; },
    () => 600_000,
  );
  const clock = new FakeClock(), reasons: string[] = [];
  let mounted = false, requests = 0;
  const controller = loadRetryController()(controllerOptions(clock, {
    deadlineMs: captured.deadlineMs, maxAttempts: captured.maxAttempts,
    isMounted: () => mounted,
    // Electron's menu wrapper accepts invocation while native ensureWindow
    // still returns null. Startup becomes ready after the former 30-call cap.
    open: () => { requests++; if (clock.nowMs >= 192_000) mounted = true; return true; },
    onStopped: (reason: string) => reasons.push(reason),
  }));
  controller.start(); clock.advance(210_000);
  assert.equal(mounted, true); assert.ok(requests > 30);
  assert.deepEqual(reasons, ["mounted"]); assert.equal(clock.timers.size, 0);
  assert.equal(captured.deadlineMs, 645_000, "the startup deadline is not extended");
});

test("Settings retry controller terminates never-ready startup at its absolute deadline", () => {
  const clock = new FakeClock();
  const createController = loadRetryController();
  let requests = 0;
  const reasons: string[] = [];
  const controller = createController(controllerOptions(clock, {
    isReady: () => false,
    open: () => {
      requests += 1;
      return true;
    },
    onStopped: (reason: string) => reasons.push(reason),
  }));
  controller.start();
  clock.advance(45_000);
  assert.equal(requests, 0);
  assert.deepEqual(reasons, ["deadline"]);
  clock.advance(10_000);
  assert.equal(requests, 0, "a deadline must prevent all later Settings requests");

  const lateClock = new FakeClock();
  let lateRequests = 0;
  const lateController = createController(controllerOptions(lateClock, {
    isReady: () => {
      lateClock.nowMs = 45_000;
      return true;
    },
    open: () => {
      lateRequests += 1;
      return true;
    },
  }));
  lateController.start();
  assert.equal(lateRequests, 0, "a readiness callback crossing the deadline cannot issue a late request");
});

test("Settings retry controller keeps delayed exact-primary discovery eligible", () => {
  const clock = new FakeClock();
  const createController = loadRetryController();
  let primary: { id: string } | null = null;
  let requests = 0;
  const controller = createController(controllerOptions(clock, {
    getExactPrimary: () => primary,
    open: () => {
      requests += 1;
      return false;
    },
  }));
  controller.start();
  clock.advance(1_999);
  assert.equal(requests, 0);
  primary = { id: "primary" };
  clock.advance(1);
  assert.equal(requests, 1);
});

test("accepted Settings requests use acknowledgement grace, and all terminal states stop", () => {
  const createController = loadRetryController();
  const terminalStates = [
    { name: "mounted", isMounted: () => true },
    { name: "published", isPublished: () => true },
    { name: "expectation-removed", readExpectation: () => null },
  ];
  for (const state of terminalStates) {
    const clock = new FakeClock();
    let requests = 0;
    const reasons: string[] = [];
    const controller = createController(controllerOptions(clock, {
      ...state,
      open: () => {
        requests += 1;
        return true;
      },
      onStopped: (reason: string) => reasons.push(reason),
    }));
    controller.start();
    assert.equal(requests, state.name === "expectation-removed" || state.name === "mounted" || state.name === "published" ? 0 : 1);
    clock.advance(45_000);
    assert.equal(reasons.length, 1);
    assert.equal(requests, 0);
    assert.equal(reasons[0], state.name);
  }

  const clock = new FakeClock();
  let requests = 0;
  const controller = createController(controllerOptions(clock, {
    open: () => {
      requests += 1;
      return true;
    },
  }));
  controller.start();
  assert.equal(requests, 1);
  clock.advance(5_999);
  assert.equal(requests, 1, "4–5 second mounts fit inside acknowledgement grace");
  clock.advance(1);
  assert.equal(requests, 2, "accepted-but-unacknowledged requests retry after grace");
});

test("Settings wrapper refuses same-operation rearm after deadline but allows a new operation", () => {
  const clock = new FakeClock();
  const createController = loadRetryController();
  let operationId = "operation-a";
  let terminalOperationId: string | null = null;
  let attemptCount = 0;
  let requests = 0;
  const activeControllers: Array<{ start(): void; stop(): void }> = [];
  const arm = (): boolean => {
    if (terminalOperationId === operationId || attemptCount >= 30) return false;
    activeControllers.push(createController(controllerOptions(clock, {
      initialOperationId: operationId,
      initialAttemptCount: attemptCount,
      readExpectation: () => ({ operationId }),
      isReady: () => false,
      open: () => {
        requests += 1;
        return true;
      },
      onAttemptStateChange: (nextOperationId: string, nextAttemptCount: number) => {
        if (operationId !== nextOperationId) terminalOperationId = null;
        operationId = nextOperationId;
        attemptCount = nextAttemptCount;
      },
      onStopped: (reason: string, stoppedOperationId: string) => {
        if (reason === "deadline" || reason === "exhausted") terminalOperationId = stoppedOperationId;
      },
    })));
    activeControllers.at(-1)!.start();
    return true;
  };

  assert.equal(arm(), true);
  clock.advance(45_000);
  assert.equal(terminalOperationId, "operation-a");
  assert.equal(clock.timers.size, 0);
  assert.equal(arm(), false, "same expectation cannot rearm a fresh deadline");
  assert.equal(requests, 0);

  operationId = "operation-b";
  assert.equal(arm(), true, "a new expectation operation gets a fresh bounded run");
  assert.equal(clock.timers.size, 1);
  clock.advance(1_000);
  assert.equal(requests, 0);
  activeControllers.at(-1)?.stop();
});
