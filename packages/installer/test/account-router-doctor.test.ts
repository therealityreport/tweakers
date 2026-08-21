import assert from "node:assert/strict";
import test from "node:test";
import { accountRouterDoctorChecks } from "../src/commands/doctor";
import type { AccountRouterEvidence } from "../src/account-router-status";

const balanced: AccountRouterEvidence = {
  source: { state: "present", version: "0.2.0" },
  candidate: { state: "present", version: "0.2.0" },
  installed: { state: "present", version: "0.2.0" },
  configuration: { state: "balanced" },
  live: {
    state: "active",
    status: {
      mode: "balanced",
      protocolState: "supported",
      fairnessPrecision: "projected",
      accounts: [{ label: "Account A", eligibility: "eligible", normalizedSpend: 1, assignedThreadCount: 1 }],
      restartRequired: false,
      degradedReason: null,
    },
  },
};

test("doctor reports the four router evidence layers without leaking account identity", () => {
  const checks = accountRouterDoctorChecks(balanced);
  assert.deepEqual(checks.map((check) => check.name), [
    "account router source",
    "account router candidate",
    "account router installed",
    "account router live",
  ]);
  assert.equal(checks.every((check) => check.ok === true), true);
  assert.match(checks.at(-1)!.detail, /balanced; projected/);
  assert.doesNotMatch(JSON.stringify(checks), /ar_[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(JSON.stringify(checks), /secret|token|auth\.json/i);
});

test("doctor leaves manual mode healthy while flagging a staged balanced router without a live mux", () => {
  const manual = { ...balanced, configuration: { state: "manual" as const }, live: { state: "not_applicable" as const, status: null } };
  assert.deepEqual(accountRouterDoctorChecks(manual), []);
  const unavailable = { ...balanced, live: { state: "not_running" as const, status: null } };
  const live = accountRouterDoctorChecks(unavailable).at(-1)!;
  assert.equal(live.name, "account router live");
  assert.equal(live.ok, "warn");
  assert.match(live.detail, /not running/);
});
