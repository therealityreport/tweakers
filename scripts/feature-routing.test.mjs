import assert from "node:assert/strict";
import test from "node:test";
import { classifyFeatureRoute } from "./feature-routing.mjs";

test("routes a cohesive capability to its existing tweak", () => {
  assert.equal(classifyFeatureRoute({ cohesiveWithExistingOwner: true }), "add-to-existing");
});

test("routes replacement or repair to revision", () => {
  assert.equal(classifyFeatureRoute({ changesOwnedBehavior: true, cohesiveWithExistingOwner: true }), "revise-existing");
});

test("routes an independently toggleable capability to a new tweak", () => {
  assert.equal(classifyFeatureRoute({ independentlyToggleable: true }), "create-new");
});

test("requires user input when ownership remains ambiguous", () => {
  assert.equal(classifyFeatureRoute({}), "ask-user");
});
