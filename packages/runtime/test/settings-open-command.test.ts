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
  assert.match(helper, /if \(unique\.length !== 1\) return false/);
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
  assert.match(retry, /runtimeReadySettingsOpenAttemptCount >= RUNTIME_READY_SETTINGS_OPEN_MAX_ATTEMPTS/);
  assert.match(retry, /runtimeReadySettingsOpenAttemptOperationId !== expectation\.operationId/);
  assert.match(retry, /runtimeReadySettingsOpenTerminalOperationId === expectation\.operationId/);
  assert.doesNotMatch(retry, /let attempts = 0/);
  assert.doesNotMatch(retry, /getFocusedWindow|getPrimaryCodexWindow/);
  assert.doesNotMatch(retry, /runtimeReadySettingsOpenTriggered/);
  assert.match(source, /isReady: \(\) => runtimeReadyInitializedTweakIds\(\) !== null/);
  assert.match(source, /runtimeReadySettingsMounted = true;\n  stopRuntimeReadySettingsMountAttempts\(\);/);
  assert.match(source, /publishIndependentTweakersRuntimeReadyReceipt\(RUNTIME_READY_FILE, receipt\);\n    stopRuntimeReadySettingsMountAttempts\(\);/);
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
  let active: { start(): void; stop(): void } | null = null;
  const arm = (): boolean => {
    if (terminalOperationId === operationId || attemptCount >= 30) return false;
    active = createController(controllerOptions(clock, {
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
    }));
    active.start();
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
  active?.stop();
});
