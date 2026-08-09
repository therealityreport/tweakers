import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHealthProbeDialogSuppression,
  type HealthProbeDialogRecord,
} from "../src/health-probe-dialog";

function target() {
  const showMessageBox = async (): Promise<{ response: number; checkboxChecked: boolean }> => {
    throw new Error("real showMessageBox was reached");
  };
  const showMessageBoxSync = (): number => {
    throw new Error("real showMessageBoxSync was reached");
  };
  const showErrorBox = (): void => {
    throw new Error("real showErrorBox was reached");
  };
  return { showMessageBox, showMessageBoxSync, showErrorBox };
}

function suppressed(dialog: ReturnType<typeof target>) {
  const records: HealthProbeDialogRecord[] = [];
  const applied = applyHealthProbeDialogSuppression({
    dialog,
    healthCheckOnly: true,
    onSuppressed: (record) => records.push(record),
  });
  assert.equal(applied, true);
  return records;
}

// The observed hang: OpenAI's supervisor reacts to the promotion proof killing
// its app-server by opening an app-modal NSAlert inside our hidden probe. It has
// no parent window, so activation policy and dock hiding do not touch it, and it
// blocks the probe's main thread until the installer's 170s spawnSync timeout.
test("a health process answers OpenAI's modal dialogs instead of painting them", async () => {
  const dialog = target();
  const records = suppressed(dialog);

  const chosen = await (dialog.showMessageBox as unknown as (options: unknown) => Promise<{ response: number }>)({
    type: "error",
    message: "ChatGPT failed to start.",
    detail: "  (code=null, signal=SIGTERM).\nMost recent error: Codex app-server websocket closed (code=unknown)",
    buttons: ["Check for Updates", "Quit"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  // Answered, so the awaiting caller proceeds — and answered with cancel, never
  // the default, which in this very dialog is "Check for Updates".
  assert.equal(chosen.response, 1);
  assert.deepEqual(records, [{
    api: "showMessageBox",
    message: "ChatGPT failed to start.",
    detail: "  (code=null, signal=SIGTERM).\nMost recent error: Codex app-server websocket closed (code=unknown)",
  }]);
});

test("suppression covers the sync and error-box entry points and the window-parented arity", () => {
  const dialog = target();
  const records = suppressed(dialog);

  const sync = (dialog.showMessageBoxSync as unknown as (window: unknown, options: unknown) => number)(
    { id: "browser-window" },
    { message: "sync", detail: "d", buttons: ["a", "b", "c"] },
  );
  // No cancelId given: the last button is the cancel button.
  assert.equal(sync, 2);

  (dialog.showErrorBox as unknown as (title: string, content: string) => void)("boom", "details");

  assert.deepEqual(records.map((record) => record.api), ["showMessageBoxSync", "showErrorBox"]);
  assert.equal(records[0]!.message, "sync");
  assert.equal(records[1]!.detail, "details");
});

test("an ordinary launch keeps every real dialog", () => {
  const dialog = target();
  const originals = { ...dialog };
  const applied = applyHealthProbeDialogSuppression({
    dialog,
    healthCheckOnly: false,
    onSuppressed: () => assert.fail("an ordinary launch must not suppress dialogs"),
  });

  assert.equal(applied, false);
  assert.equal(dialog.showMessageBox, originals.showMessageBox);
  assert.equal(dialog.showMessageBoxSync, originals.showMessageBoxSync);
  assert.equal(dialog.showErrorBox, originals.showErrorBox);
});

test("suppression fails closed when a dialog entry point cannot be replaced", () => {
  const dialog = target();
  Object.defineProperty(dialog, "showErrorBox", { value: dialog.showErrorBox, writable: false });

  assert.throws(
    () => applyHealthProbeDialogSuppression({ dialog, healthCheckOnly: true, onSuppressed: () => {} }),
    /could not suppress dialog\.showErrorBox/,
  );
});

test("an absent dialog entry point is not treated as a failure to suppress", () => {
  const dialog: { showMessageBox?: unknown; showErrorBox?: unknown } = { showMessageBox: () => {} };
  assert.equal(
    applyHealthProbeDialogSuppression({ dialog, healthCheckOnly: true, onSuppressed: () => {} }),
    true,
  );
});
