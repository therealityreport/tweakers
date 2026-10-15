import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { extractFile } from "@electron/asar";
import { patchReviewedStartupPolicySource as patchImplementation, REVIEWED_STARTUP_POLICY_20398_PATH as REVIEWED_STARTUP_POLICY_PATH } from "../src/codex-startup-policy";

const patchReviewedStartupPolicySource = (source: string) => patchImplementation(source, REVIEWED_STARTUP_POLICY_PATH);
const asar = process.env.TWEAKERS_TEST_20398_ASAR ?? "/Users/thomashulihan/Library/Application Support/Tweakers/official-source/baselines/6142fb65-40d4-4092-96dc-439d0ef161e0/resources/app.asar";
const publicSource = process.env.TWEAKERS_TEST_STARTUP_POLICY_SOURCE;
const carrierAvailable = publicSource ? existsSync(publicSource) : existsSync(asar);
if (process.env.TWEAKERS_TEST_20398_REQUIRE_FIXTURE === "1") assert.ok(carrierAvailable, "Required 20398 startup fixture unavailable");
const readCarrier = () => publicSource ? readFileSync(publicSource, "utf8") : extractFile(asar, REVIEWED_STARTUP_POLICY_PATH).toString("utf8");
const originalEnv = "Object.assign(process.env,l.userEnv)";
const originalCall = "await i.a(a,c.app.getVersion(),{signOut:e,timeoutMs:Math.max(1,Math.min(3e4,s-performance.now()))})";
const originalWarning = "o.n().warning(`Desktop startup policy read failed`,{safe:{reason:n,phase:f,attempt:a,retrying:p}})";

test("reviewed 20398 startup policy carrier binds its complete hash, deadlines, legacy compatibility and idempotence", { skip: !carrierAvailable }, () => {
  const source = readCarrier();
  assert.equal(createHash("sha256").update(source).digest("hex"), "ec6518de6f43d8247ae39bae82a348e345674e979b8990c40b8dbf7b1e908cd4");
  const result = patchReviewedStartupPolicySource(source);
  assert.equal(result.changed, true);
  const env = `(${originalEnv},globalThis.__tweakersVerifiedBackendPathV1&&(process.env.CODEX_CLI_PATH=globalThis.__tweakersVerifiedBackendPathV1))`;
  const call = `await (globalThis.__tweakersStartupPolicyV1?globalThis.__tweakersStartupPolicyV1.run(()=>${originalCall.slice(6)}):${originalCall.slice(6)})`;
  const warning = `(${originalWarning},globalThis.__tweakersStartupPolicyV1?.diagnostic({reason:n,phase:f,attempt:a,retrying:p}))`;
  const legacy = source.replace(originalEnv, () => env).replace(originalCall, () => call).replace(originalWarning, () => warning);
  assert.deepEqual(patchReviewedStartupPolicySource(legacy), result);
  assert.ok(result.source.includes(env)); assert.ok(result.source.includes(warning));
  assert.ok(result.source.includes("preparationTimeoutMs?.()"));
  assert.ok(result.source.includes("s??=__tweakersStartupDeadlineV1??performance.now()+6e4"));
  assert.deepEqual(patchReviewedStartupPolicySource(result.source), { source: result.source, changed: false });
  for (const [before, after] of [[originalEnv, env], [originalCall, call], [originalWarning, warning]]) {
    assert.throws(() => patchReviewedStartupPolicySource(source.replace(before!, () => after!)), /not reviewed/);
    assert.throws(() => patchReviewedStartupPolicySource(legacy.replace(after!, () => before!)), /not reviewed/);
  }
  for (const [before, after] of [
    ["let a=await fa(l);", "let a=await fa(l,__tweakersStartupBudgetV1==null?void 0:(__tweakersStartupDeadlineV1??=performance.now()+__tweakersStartupBudgetV1));"],
    ["s??=performance.now()+6e4", "s??=__tweakersStartupDeadlineV1??performance.now()+6e4"],
    ["e=!0,a=0,s=null;continue", "e=!0,a=0,s=null,__tweakersStartupDeadlineV1=null;continue"],
  ]) assert.throws(() => patchReviewedStartupPolicySource(result.source.replace(after!, () => before!)), /not reviewed/);
  assert.throws(() => patchReviewedStartupPolicySource(`${legacy}\n// unreviewed legacy change`), /not reviewed/);
  assert.throws(() => patchReviewedStartupPolicySource(`${source}\n// unreviewed change`), /not reviewed/);
  assert.throws(() => patchReviewedStartupPolicySource(`${result.source}${env}`), /Ambiguous/);
});

async function virtualStartup(options: { hint?: unknown; throwingGetter?: boolean; preparationMs?: number; policyMs?: number; failFirstMs?: number }) {
  const source = patchReviewedStartupPolicySource(readCarrier()).source;
  const start = source.indexOf("async function da(){"), end = source.indexOf("Object.defineProperty(exports", start);
  assert.ok(start >= 0 && end > start);
  let now = 0, nextId = 1, completed = false, value: unknown, failure: unknown, validations = 0, policyReads = 0, runs = 0;
  const timers = new Map<number, { at: number; callback: () => void }>(), policyTimeouts: number[] = [], scheduled: number[] = [];
  const setTimeout = (callback: () => void, ms: number) => { const id = nextId++; scheduled.push(ms); timers.set(id, { at: now + ms, callback }); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };
  class PolicyError extends Error { reason = "timeout"; retryable = true; }
  class ConfigError extends Error {}
  const hook: Record<string, unknown> = { run: (call: () => Promise<unknown>) => { runs++; return call(); }, diagnostic: () => {} };
  if (options.throwingGetter) Object.defineProperty(hook, "preparationTimeoutMs", { get() { throw new Error("fixture invalid getter"); } });
  else hook.preparationTimeoutMs = () => options.hint;
  const context = {
    performance: { now: () => now }, setTimeout, clearTimeout, Promise,
    __tweakersStartupPolicyV1: options.hint === undefined && !options.throwingGetter ? undefined : hook,
    la: null, Gi: async () => {}, process: { env: {}, platform: "darwin", resourcesPath: "/fixture/resources" },
    d: { join: (...parts: string[]) => parts.join("/") }, u: { mkdir: async () => {} }, $r: {}, oe: () => "/fixture/resources",
    i: { ot: () => "/fixture/home", n: PolicyError, t: ConfigError,
      i: () => new Promise(resolve => { setTimeout(() => resolve({ prepared: true }), options.preparationMs ?? 0); }),
      a: (_prepared: unknown, _version: string, params: { signOut: boolean; timeoutMs: number }) => {
        assert.equal(params.signOut, false); policyTimeouts.push(params.timeoutMs); policyReads++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { clearTimeout(reply); reject(new PolicyError()); }, params.timeoutMs);
          const firstFailure = policyReads === 1 && options.failFirstMs !== undefined;
          const reply = setTimeout(() => { clearTimeout(timeout); firstFailure ? reject(new PolicyError()) : resolve({ appServerVersion: "fixture", response: {} }); }, firstFailure ? options.failFirstMs! : options.policyMs ?? 176_000);
        });
      } },
    c: { app: { isPackaged: true, getAppPath: () => "/fixture/app", getVersion: () => "fixture", whenReady: async () => {}, exit: () => {} },
      dialog: { showMessageBox: async () => ({ response: 2 }) } },
    Ri: () => false, o: { n: () => ({ warning: () => {} }) }, ni: async () => {}, ri: () => ({ formatMessage: () => "fixture" }),
    $: { retry: {}, signOut: {}, quit: {}, detail: {}, title: {} },
    oa: () => { validations++; return { kind: "unrestricted" }; }, ta: () => true,
  };
  const initialize = runInNewContext(`${source.slice(start, end)};da`, context) as () => Promise<boolean>;
  initialize().then(result => { completed = true; value = result; }, error => { completed = true; failure = error; });
  const drain = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
  for (let steps = 0; !completed && steps < 30; steps++) {
    await drain(); if (completed) break;
    const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
    assert.ok(next, "virtual startup has pending work without a timer");
    timers.delete(next[0]); now = next[1].at; next[1].callback();
  }
  await drain(); assert.equal(completed, true); assert.equal(failure, undefined);
  return { value, now, validations, policyTimeouts, scheduled, runs };
}

test("signed 600s startup accepts a policy reply after 176s and budgets preparation against the same deadline", { skip: !carrierAvailable }, async () => {
  const delayedPolicy = await virtualStartup({ hint: 600_000 });
  assert.equal(delayedPolicy.value, true); assert.equal(delayedPolicy.now, 176_000); assert.equal(delayedPolicy.validations, 1);
  assert.deepEqual(delayedPolicy.policyTimeouts, [600_000]); assert.equal(delayedPolicy.runs, 1);
  const delayedPreparation = await virtualStartup({ hint: 600_000, preparationMs: 176_000, policyMs: 10_000 });
  assert.equal(delayedPreparation.value, true); assert.equal(delayedPreparation.now, 186_000);
  assert.deepEqual(delayedPreparation.policyTimeouts, [424_000]);
});

test("official retries share one 600s total instead of receiving two independent 600s reads", { skip: !carrierAvailable }, async () => {
  const result = await virtualStartup({ hint: 600_000, failFirstMs: 50_000, policyMs: 126_000 });
  assert.equal(result.value, true); assert.equal(result.now, 177_000);
  assert.deepEqual(result.policyTimeouts, [600_000, 549_000]);
  const exhausted = await virtualStartup({ hint: 600_000, preparationMs: 400_000, policyMs: 250_000 });
  assert.equal(exhausted.value, false); assert.equal(exhausted.now, 600_000); assert.equal(exhausted.validations, 0);
  assert.deepEqual(exhausted.policyTimeouts, [200_000]);
});

test("no hook, normal 30s and invalid or throwing hints retain all original native windows", { skip: !carrierAvailable }, async () => {
  for (const options of [{}, { hint: 30_000 }, { hint: 180_000 }, { hint: 600_001 }, { hint: Infinity }, { hint: NaN }, { hint: "600000" }, { hint: 600_000.5 }, { throwingGetter: true }]) {
    const result = await virtualStartup(options);
    assert.equal(result.value, false); assert.equal(result.now, 60_000); assert.equal(result.validations, 0);
    assert.deepEqual(result.policyTimeouts, [30_000, 29_000]);
    assert.ok(result.scheduled.includes(120_000));
  }
});

test("startup policy transform refuses unknown carriers and synthetic anchor-only inputs", () => {
  for (const source of ["", "export default {}", `${originalEnv};${originalCall};${originalWarning}`]) {
    assert.throws(() => patchReviewedStartupPolicySource(source), /not reviewed/);
  }
});
