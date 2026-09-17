import assert from "node:assert/strict";
import test from "node:test";
import { installIndependentStartupRecovery } from "../src/independent-startup-recovery";

test("independent startup opens Doctor and returns the original Quit action", async () => {
  let opened = 0, inherited = 0;
  const dialog = { showMessageBox: async (..._args: unknown[]) => { inherited++; return { response: 0, checkboxChecked: false }; } };
  const restore = installIndependentStartupRecovery(dialog, () => { opened++; });
  const result = await dialog.showMessageBox({ message: "ChatGPT failed to start.", buttons: ["Update", "Check", "Quit"], cancelId: 2 });
  assert.equal(opened, 1); assert.equal(inherited, 0); assert.equal(result.response, 2);
  restore(); await dialog.showMessageBox({ message: "ChatGPT failed to start." }); assert.equal(inherited, 1);
});

test("fallback Quit preserves the inherited Quit index when the manager is unavailable", async () => {
  const shown: unknown[] = [];
  const dialog = { showMessageBox: async (...args: unknown[]) => { shown.push(args.at(-1)); return { response: 0, checkboxChecked: false }; } };
  installIndependentStartupRecovery(dialog, () => { throw new Error("manager missing"); });
  assert.equal((await dialog.showMessageBox({ message: "Codex failed to start.", buttons: ["Update", "Quit"], cancelId: 1 })).response, 1);
  assert.deepEqual((shown[0] as { buttons: string[] }).buttons, ["Quit"]);
});

test("ordinary dialogs and their arguments remain unchanged", async () => {
  const args = [{ message: "An ordinary prompt", buttons: ["OK"] }];
  let received: unknown[] = [];
  const dialog = { showMessageBox: async (...values: unknown[]) => { received = values; return { response: 4, checkboxChecked: true }; } };
  installIndependentStartupRecovery(dialog, () => { throw new Error("not called"); });
  assert.deepEqual(await dialog.showMessageBox(...args), { response: 4, checkboxChecked: true }); assert.deepEqual(received, args);
});
