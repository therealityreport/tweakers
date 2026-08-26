import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MAIN_SOURCE = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("User Questions starts independently of MCP reconciliation while other MCP tweaks still reconcile first", () => {
  const start = MAIN_SOURCE.indexOf("async function loadAllMainTweaks");
  const end = MAIN_SOURCE.indexOf("\nfunction stopAllMainTweaks", start);
  const body = MAIN_SOURCE.slice(start, end);
  const reconciliation = body.indexOf("await mcpReconciler.reconcileNow");
  const lifecycleLoop = body.indexOf("for (const t of tweakState.discovered)");

  assert.ok(start >= 0 && end > start);
  assert.ok(reconciliation >= 0);
  assert.ok(lifecycleLoop > reconciliation);
  assert.doesNotMatch(body, /userQuestionsMcpReady/);
  assert.doesNotMatch(body, /userQuestionsMcpReceiptMatchesEnabledState/);
  assert.doesNotMatch(body, /canonical User Questions MCP reconciliation/);
});
