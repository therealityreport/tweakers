import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MAIN_SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("User Questions starts only after canonical MCP registration is proven without a policy gate", () => {
  const start = MAIN_SOURCE.indexOf("async function loadAllMainTweaks");
  const end = MAIN_SOURCE.indexOf("\nfunction stopAllMainTweaks", start);
  const body = MAIN_SOURCE.slice(start, end);
  const reconciliation = body.indexOf("await mcpReconciler.reconcileNow");
  const lifecycleLoop = body.indexOf("for (const t of tweakState.discovered)");
  const userQuestionsGate = body.indexOf('t.manifest.id === "co.tweakers.user-questions" && !userQuestionsMcpReady');

  assert.ok(start >= 0 && end > start);
  assert.ok(reconciliation >= 0);
  assert.ok(lifecycleLoop > reconciliation);
  assert.ok(userQuestionsGate > lifecycleLoop);
  assert.match(body, /userQuestionsMcpReceiptMatchesEnabledState\(receipt, true\)/);
  assert.doesNotMatch(body, /approvalPolicy\.afterRaw/);
  assert.doesNotMatch(body, /sandboxModeAfterRaw/);
});
