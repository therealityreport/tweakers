import assert from "node:assert/strict";
import test from "node:test";
import { operationErrorMessage, OPERATION_ERROR_MAX_LENGTH } from "../src/operation-error.js";

test("operation errors retain nested aggregate causes and redact credentials", () => {
  const error = new AggregateError([
    new Error("copy failed", { cause: new Error("password=hunter2 token unavailable") }),
    new Error("authorization=Bearer abcsecret; api_key=supersecret"),
  ], "rollback incomplete", { cause: new Error("https://user:password@example.test failed") });
  const text = operationErrorMessage(error);
  assert.match(text, /rollback incomplete/);
  assert.match(text, /Cause: copy failed/);
  assert.match(text, /Cause: password=\[redacted\]/);
  for (const secret of ["hunter2", "abcsecret", "supersecret", "user:password"]) assert.equal(text.includes(secret), false);
});

test("operation diagnostics bound cyclic, deep and oversized causes", () => {
  const cyclic = new Error("outer"); cyclic.cause = cyclic;
  assert.match(operationErrorMessage(cyclic), /circular cause/);
  let deep = new Error("leaf");
  for (let i = 0; i < 20; i++) deep = new Error(`cause ${i}`, { cause: deep });
  assert.match(operationErrorMessage(deep), /causes truncated/);
  assert.ok(operationErrorMessage(new Error("x".repeat(10000))).length <= OPERATION_ERROR_MAX_LENGTH);
});

test("plain legacy diagnostics preserve exact matching semantics", () => {
  assert.equal(operationErrorMessage(new Error("Copied candidate artifact changed: runtime")), "Copied candidate artifact changed: runtime");
});
