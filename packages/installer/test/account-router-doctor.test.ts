import assert from "node:assert/strict";
import test from "node:test";
import { accountRouterDoctorChecks } from "../src/commands/doctor";
import type { AccountRouterEvidence } from "../src/account-router-status";

const balanced: AccountRouterEvidence = {
  source: { state: "present", version: "0.2.0" },
  candidate: { state: "present", version: "0.2.0" },
  installed: { state: "present", version: "0.2.0" },
  configuration: {
    state: "balanced",
    pending: { schemaVersion: 1, mode: "balanced", policy: null, generation: null, fingerprint: null },
  },
  historyAdoption: { state: "not_applicable" },
  live: {
    state: "active",
    status: {
      schemaVersion: 1,
      active: { mode: "balanced", policy: null, generation: null, fingerprint: null, fairnessPrecision: "projected" },
      pending: null,
      protocolState: "supported",
      accounts: [{
        label: "Account A", eligibility: "eligible", plan: null, identifierMasked: null,
        weekly: null, shortWindowPressure: null, normalizedSpend: 1, assignedThreadCount: 1,
      }],
      restartRequired: false,
      poolRemainingPercent: null,
      degradedReason: null,
    },
  },
};

const quotaAware: AccountRouterEvidence = {
  ...balanced,
  configuration: {
    state: "quota_aware",
    pending: {
      schemaVersion: 2,
      mode: "quota_aware",
      policy: "quota_aware_v1",
      generation: 7,
      fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
  },
  historyAdoption: { state: "adopted" },
  live: {
    state: "active",
    status: {
      schemaVersion: 2,
      active: {
        mode: "quota_aware",
        policy: "quota_aware_v1",
        generation: 7,
        fingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      pending: null,
      protocolState: "supported",
      accounts: [
        {
          label: "Alpha", eligibility: "eligible", plan: "Plus", identifierMasked: "••••••••",
          weekly: { remainingPercent: 70, resetAt: "2026-09-01T12:00:00Z", freshness: "fresh" },
          shortWindowPressure: 15, normalizedSpend: 0, assignedThreadCount: 1,
        },
        {
          label: "Beta", eligibility: "eligible", plan: null, identifierMasked: "••••••••",
          weekly: { remainingPercent: 60, resetAt: "2026-09-01T12:00:00Z", freshness: "fresh" },
          shortWindowPressure: 20, normalizedSpend: 0, assignedThreadCount: 1,
        },
      ],
      restartRequired: false,
      poolRemainingPercent: 130,
      degradedReason: null,
    },
  },
};

test("doctor reports pending and authenticated active evidence without leaking account identity", () => {
  const checks = accountRouterDoctorChecks(balanced);
  assert.deepEqual(checks.map((check) => check.name), [
    "account router pending configuration",
    "account router source",
    "account router candidate",
    "account router installed",
    "account router live",
  ]);
  assert.equal(checks.every((check) => check.ok === true), true);
  assert.match(checks.at(-1)!.detail, /authenticated balanced; projected/);
  assert.doesNotMatch(JSON.stringify(checks), /ar_[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(JSON.stringify(checks), /secret|token|auth\.json/i);
});

test("doctor makes manual pending and active runtime disagreement visible", () => {
  const manual = {
    ...balanced,
    configuration: { state: "manual" as const, pending: { schemaVersion: 1 as const, mode: "manual" as const, policy: null, generation: null, fingerprint: null } },
  };
  const manualCheck = accountRouterDoctorChecks(manual).at(0)!;
  assert.equal(manualCheck.ok, "warn");
  assert.match(manualCheck.detail, /pending manual; legacy v1; authenticated active balanced/);
  const unavailable = { ...balanced, live: { state: "not_running" as const, status: null } };
  const live = accountRouterDoctorChecks(unavailable).at(-1)!;
  assert.equal(live.name, "account router live");
  assert.equal(live.ok, "warn");
  assert.match(live.detail, /not running/);
});

test("doctor keeps direct mode healthy and names unavailable source provenance safely", () => {
  const notStaged = {
    ...balanced,
    source: { state: "unavailable" as const, version: null, unavailableReason: "not_registered" as const },
    configuration: { state: "not_staged" as const, pending: null },
    live: { state: "not_running" as const, status: null },
  };
  assert.deepEqual(accountRouterDoctorChecks(notStaged), []);

  const staleSource = {
    ...balanced,
    source: { state: "unavailable" as const, version: null, unavailableReason: "registration_stale" as const },
  };
  const source = accountRouterDoctorChecks(staleSource).find((check) => check.name === "account router source")!;
  assert.equal(source.name, "account router source");
  assert.equal(source.ok, "warn");
  assert.equal(source.detail, "registered development checkout is stale");
  assert.doesNotMatch(JSON.stringify(source), /\/Users\/|auth\.json|secret|token/i);
});

test("doctor never marks degraded, drifted, paused, or restart-pending quota routing healthy", () => {
  for (const degradedReason of ["quota_unknown", "quota_stale", "account_unauthenticated", "account_unhealthy"] as const) {
    const evidence = {
      ...quotaAware,
      live: { ...quotaAware.live, status: { ...quotaAware.live.status!, degradedReason } },
    };
    const live = accountRouterDoctorChecks(evidence).at(-1)!;
    assert.equal(live.ok, false, degradedReason);
    assert.match(live.detail, new RegExp(degradedReason.replaceAll("_", " ")));
    assert.match(live.detail, /routing paused/);
  }

  const drifted = {
    ...quotaAware,
    live: { ...quotaAware.live, status: { ...quotaAware.live.status!, protocolState: "drifted" as const } },
  };
  const drift = accountRouterDoctorChecks(drifted).at(-1)!;
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /protocol drifted; routing paused/);

  const restartPending = {
    ...quotaAware,
    live: { ...quotaAware.live, status: { ...quotaAware.live.status!, restartRequired: true } },
  };
  const restart = accountRouterDoctorChecks(restartPending).at(-1)!;
  assert.equal(restart.ok, "warn");
  assert.match(restart.detail, /restart required/);

  const paused = {
    ...quotaAware,
    live: {
      ...quotaAware.live,
      status: { ...quotaAware.live.status!, active: { ...quotaAware.live.status!.active, mode: "manual" as const, policy: null } },
    },
  };
  const pausedCheck = accountRouterDoctorChecks(paused).at(-1)!;
  assert.equal(pausedCheck.ok, "warn");
  assert.match(pausedCheck.detail, /quota-aware routing is paused/);
});

test("doctor blocks quota-aware candidates until signed offline adoption is adopted", () => {
  for (const state of ["required", "pending_offline_adoption", "invalid", "mismatch"] as const) {
    const evidence = { ...quotaAware, historyAdoption: { state } };
    const adoption = accountRouterDoctorChecks(evidence).find((check) => check.name === "account history adoption")!;
    assert.equal(adoption.ok, false, state);
    assert.match(adoption.detail, new RegExp(state.replaceAll("_", " ")));
  }
  const adopted = accountRouterDoctorChecks(quotaAware).find((check) => check.name === "account history adoption")!;
  assert.equal(adopted.ok, true);
  assert.match(adopted.detail, /valid/);
});

test("doctor treats adopted v2 Manual as a healthy mux-backed configuration", () => {
  const manual: AccountRouterEvidence = {
    ...quotaAware,
    configuration: {
      state: "manual",
      pending: {
        ...quotaAware.configuration.pending!,
        mode: "manual",
        policy: null,
        generation: 8,
        fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
    },
    live: {
      ...quotaAware.live,
      status: {
        ...quotaAware.live.status!,
        active: {
          mode: "manual",
          policy: null,
          generation: 8,
          fingerprint: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      },
    },
  };
  const checks = accountRouterDoctorChecks(manual);
  assert.equal(checks.every((check) => check.ok === true), true);
  assert.match(checks.find((check) => check.name === "account history adoption")!.detail, /valid; v2 Manual remains mux-backed for history and assigns new threads to the primary account/);
  assert.match(checks.at(-1)!.detail, /authenticated manual/);
});
