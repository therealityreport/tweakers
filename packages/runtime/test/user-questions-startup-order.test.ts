import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MAIN_SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("User Questions global-state migration starts only after authoritative policy reconciliation", () => {
  const start = MAIN_SOURCE.indexOf("async function loadAllMainTweaks");
  const end = MAIN_SOURCE.indexOf("\nfunction stopAllMainTweaks", start);
  const body = MAIN_SOURCE.slice(start, end);
  const reconciliation = body.indexOf("await mcpReconciler.reconcileNow");
  const lifecycleLoop = body.indexOf("for (const t of tweakState.discovered)");
  const userQuestionsGate = body.indexOf('t.manifest.id === "co.tweakers.user-questions" && !userQuestionsPolicyReady');

  assert.ok(start >= 0 && end > start);
  assert.ok(reconciliation >= 0);
  assert.ok(lifecycleLoop > reconciliation);
  assert.ok(userQuestionsGate > lifecycleLoop);
  assert.match(body, /receipt\.approvalPolicy\.afterRaw === USER_QUESTIONS_APPROVAL_POLICY/);
  assert.match(body, /receipt\.approvalPolicy\.sandboxModeAfterRaw === USER_QUESTIONS_SANDBOX_MODE/);
});
