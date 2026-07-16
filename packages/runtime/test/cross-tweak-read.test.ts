import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCrossTweakRead } from "../src/cross-tweak-read";

const requester = "co.tweakers.thread-summary-profiles";
const target = "co.tweakers.projects";
const request = { action: "profiles.read", version: 1, project: { id: "project" } };
const response = { ok: true, version: 1, revision: "0123456789abcdef0123456789abcdef", project: { id: "project", name: "Project" }, profiles: [{ type: "environment", label: "Environment", status: "configured", value: "environment:production" }] };

test("allows only the versioned Profiles to Projects read", async () => {
  const result = await dispatchCrossTweakRead(requester, target, "profiles.read", request, () => () => response);
  assert.deepEqual(result, response);
});

test("rejects writes and other targets", async () => {
  const lookup = () => () => response;
  assert.equal((await dispatchCrossTweakRead(requester, target, "save", { action: "save" }, lookup) as any).error.code, "not-allowed");
  assert.equal((await dispatchCrossTweakRead(requester, "co.example.other", "profiles.read", request, lookup) as any).error.code, "not-allowed");
  assert.equal((await dispatchCrossTweakRead("co.example.other", target, "profiles.read", request, lookup) as any).error.code, "not-allowed");
});

test("fails closed when a target response contains a secret-shaped value", async () => {
  const leaked = structuredClone(response);
  leaked.profiles[0].value = "environment:sk-proj-leaked";
  const result = await dispatchCrossTweakRead(requester, target, "profiles.read", request, () => () => leaked) as any;
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("sk-proj"), false);
});
