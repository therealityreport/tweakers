import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import {
  userQuestionsBrokerSelfTest,
  userQuestionsMainLifecycleSelfTest,
  userQuestionsSchemaSelfTest,
  type UserQuestionsBrokerModule,
  type UserQuestionsLifecycleModule,
  type UserQuestionsSchemaModule,
} from "../src/user-questions-promotion-selftest";

const require = createRequire(import.meta.url);
const canonicalTweakRoot = join(process.cwd(), "tweaks", "user-questions");

/**
 * The candidate promotion probe runs EXACTLY these predicates against the
 * shipped tweak. Pinning the canonical sources here means an
 * enhancement-protocol migration that only lands on one side (broker vs
 * probe) fails `npm test` immediately instead of surfacing as a live
 * "candidate health: promotion proof fail" reload refusal
 * (candidate refusal 2026-08-25: the broker moved to session-model claim
 * responses while the probe still demanded the retired claim-id echo).
 */
test("canonical User Questions sources satisfy the exact promotion self-tests the candidate probe runs", () => {
  const lifecycle = require(join(canonicalTweakRoot, "index.js")) as UserQuestionsLifecycleModule;
  assert.equal(userQuestionsMainLifecycleSelfTest(lifecycle), true, "main lifecycle self-test");

  const broker = require(join(canonicalTweakRoot, "main-broker.js")) as UserQuestionsBrokerModule;
  assert.equal(userQuestionsBrokerSelfTest(broker), true, "broker claim self-test");

  const schema = require(join(canonicalTweakRoot, "core.js")) as UserQuestionsSchemaModule;
  assert.equal(userQuestionsSchemaSelfTest(schema), true, "schema self-test");
});
