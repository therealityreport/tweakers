import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER,
  patchCodexModelSelectionInExtractedApp,
  patchCodexModelSelectionSource,
} from "../src/codex-model-selection";

function selectorFixture(): string {
  return [
    "function zM(n,i,o,r,a,h){",
    "let s=n==null&&i,c=s&&o.hasManagedNewThreadSettings,l=s&&o.isUsingCopilotApi;",
    "let u=r.modelSettings!=null&&(c||l&&r.modelSettings.reasoningEffort===`ultra`);",
    "let d=async(e,t)=>{c||l&&t===`ultra`?a(n=>({...n,isManuallyChanged:!0,modelSettings:{model:e,profile:o.modelSettings.profile,reasoningEffort:t}})):l&&r.modelSettings?.reasoningEffort===`ultra`&&a(n=>({...n,modelSettings:null}));let n=o.setModelAndReasoningEffort(e,t);c&&await h.invoke(`clear-prewarmed-threads-for-host`);await n};",
    "let p=u?{...o.modelSettings,...r.modelSettings}:o.modelSettings;",
    "return {isNewDraft:s,pinsExplicitSelection:c,isUsingCopilotApi:l,modelSettings:p,setModelAndReasoningEffort:d}}",
  ].join("");
}

interface ModelSettings {
  model: string;
  profile: string;
  reasoningEffort: string;
}

interface DraftSettings {
  isManuallyChanged?: boolean;
  modelSettings: ModelSettings | null;
}

interface SelectorSettings {
  hasManagedNewThreadSettings: boolean;
  isUsingCopilotApi: boolean;
  modelSettings: ModelSettings;
  setModelAndReasoningEffort(model: string, effort: string): Promise<void>;
}

interface SelectorState {
  isNewDraft: boolean;
  pinsExplicitSelection: boolean;
  isUsingCopilotApi: boolean;
  modelSettings: ModelSettings;
  setModelAndReasoningEffort(model: string, effort: string): Promise<void>;
}

type Selector = (
  threadId: string | null,
  isNewThreadDraft: boolean,
  settings: SelectorSettings,
  draft: DraftSettings,
  updateDraft: (updater: (draft: DraftSettings) => DraftSettings) => void,
  host: { invoke(command: string): Promise<void> },
) => SelectorState;

function compilePatchedSelector(): { patchSource: string; selector: Selector } {
  const patched = patchCodexModelSelectionSource(selectorFixture());
  assert.ok(patched);
  assert.equal(patched.changed, true);
  assert.equal(patched.strategy, "new-draft-explicit-selection");
  assert.match(patched.source, new RegExp(CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER));
  assert.doesNotMatch(patched.source, /c=s&&o\.hasManagedNewThreadSettings/);
  return {
    patchSource: patched.source,
    selector: Function(`${patched.source};return zM;`)() as Selector,
  };
}

function baseModelSettings(): ModelSettings {
  return { model: "project-default", profile: "default", reasoningEffort: "high" };
}

test("model selector patch persists and displays an explicit unmanaged draft choice", async () => {
  const { selector } = compilePatchedSelector();
  let draft: DraftSettings = { modelSettings: null };
  const globalWrites: Array<[string, string]> = [];
  const hostCalls: string[] = [];
  const settings: SelectorSettings = {
    hasManagedNewThreadSettings: false,
    isUsingCopilotApi: false,
    modelSettings: baseModelSettings(),
    setModelAndReasoningEffort: async (model, effort) => {
      globalWrites.push([model, effort]);
    },
  };
  const updateDraft = (updater: (value: DraftSettings) => DraftSettings) => {
    draft = updater(draft);
  };
  const host = {
    invoke: async (command: string) => {
      hostCalls.push(command);
    },
  };

  const beforeSelection = selector(null, true, settings, draft, updateDraft, host);
  assert.equal(beforeSelection.pinsExplicitSelection, true);
  assert.deepEqual(beforeSelection.modelSettings, baseModelSettings());

  await beforeSelection.setModelAndReasoningEffort("chosen-model", "xhigh");
  assert.deepEqual(draft, {
    isManuallyChanged: true,
    modelSettings: {
      model: "chosen-model",
      profile: "default",
      reasoningEffort: "xhigh",
    },
  });
  assert.deepEqual(globalWrites, [["chosen-model", "xhigh"]]);
  assert.deepEqual(hostCalls, ["clear-prewarmed-threads-for-host"]);

  settings.modelSettings = {
    model: "refreshed-project-default",
    profile: "default",
    reasoningEffort: "high",
  };
  const afterProjectRefresh = selector(null, true, settings, draft, updateDraft, host);
  assert.deepEqual(afterProjectRefresh.modelSettings, draft.modelSettings);
});

test("model selector patch leaves existing threads on the original update path", async () => {
  const { selector } = compilePatchedSelector();
  let draft: DraftSettings = { modelSettings: null };
  const globalWrites: Array<[string, string]> = [];
  const hostCalls: string[] = [];
  const settings: SelectorSettings = {
    hasManagedNewThreadSettings: false,
    isUsingCopilotApi: false,
    modelSettings: baseModelSettings(),
    setModelAndReasoningEffort: async (model, effort) => {
      globalWrites.push([model, effort]);
    },
  };
  const state = selector(
    "existing-thread",
    false,
    settings,
    draft,
    (updater) => {
      draft = updater(draft);
    },
    { invoke: async (command) => { hostCalls.push(command); } },
  );

  await state.setModelAndReasoningEffort("chosen-model", "xhigh");
  assert.deepEqual(draft, { modelSettings: null });
  assert.deepEqual(state.modelSettings, baseModelSettings());
  assert.deepEqual(globalWrites, [["chosen-model", "xhigh"]]);
  assert.deepEqual(hostCalls, []);
});

test("model selector patch preserves the Copilot ultra draft path", async () => {
  const { selector } = compilePatchedSelector();
  let draft: DraftSettings = { modelSettings: null };
  const settings: SelectorSettings = {
    hasManagedNewThreadSettings: false,
    isUsingCopilotApi: true,
    modelSettings: baseModelSettings(),
    setModelAndReasoningEffort: async () => {},
  };

  const state = selector(
    null,
    true,
    settings,
    draft,
    (updater) => {
      draft = updater(draft);
    },
    { invoke: async () => {} },
  );
  await state.setModelAndReasoningEffort("copilot-model", "ultra");

  assert.equal(state.isUsingCopilotApi, true);
  assert.equal(draft.isManuallyChanged, true);
  assert.equal(draft.modelSettings?.reasoningEffort, "ultra");
});

test("model selector patch is idempotent", () => {
  const first = patchCodexModelSelectionSource(selectorFixture());
  assert.ok(first);

  const second = patchCodexModelSelectionSource(first.source);
  assert.ok(second);
  assert.equal(second.changed, false);
  assert.equal(second.strategy, "already-patched");
  assert.equal(second.source, first.source);
});

test("model selector patch rejects a decoy marker outside the selector initializer", () => {
  const source = `/*${CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER}*/${selectorFixture()}`;

  assert.throws(
    () => patchCodexModelSelectionSource(source),
    /marker is not attached to exactly one verified selector initializer/,
  );
});

test("model selector patch ignores unrelated renderer code", () => {
  assert.equal(
    patchCodexModelSelectionSource("let s=n==null&&i,c=s&&o.someOtherSetting,l=s&&o.isUsingCopilotApi"),
    null,
  );
});

test("model selector patch fails closed when the fingerprint is ambiguous", () => {
  const source = `${selectorFixture()};${selectorFixture().replaceAll("zM", "qM")}`;

  assert.throws(
    () => patchCodexModelSelectionSource(source),
    /matched 2 selector initializers/,
  );
});

test("extracted-app patch discovers a selector in a renderer dependency", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-model-selector-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(appDir, "webview", "index.html"),
      '<!doctype html><script type="module" src="./assets/index.js"></script>',
    );
    writeFileSync(join(assetsDir, "index.js"), 'import "./app.js";');
    writeFileSync(join(assetsDir, "app.js"), selectorFixture());
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(assetsDir, `unrelated-${index}.js`), `export const value${index}=${index};`);
    }

    const first = patchCodexModelSelectionInExtractedApp(appDir);
    assert.equal(first.status, "patched");
    assert.equal(first.relativePath, join("webview", "assets", "app.js"));
    assert.equal(first.scannedFiles, 2);
    assert.match(
      readFileSync(join(assetsDir, "app.js"), "utf8"),
      new RegExp(CODEX_MODEL_SELECTION_DRAFT_OVERRIDE_MARKER),
    );

    const second = patchCodexModelSelectionInExtractedApp(appDir);
    assert.equal(second.status, "already-patched");
    assert.equal(second.relativePath, first.relativePath);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("extracted-app patch follows an mjs renderer bootstrap", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-model-selector-mjs-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(appDir, "webview", "index.html"),
      '<!doctype html><script type="module" src="./assets/app.mjs"></script>',
    );
    writeFileSync(join(assetsDir, "app.mjs"), selectorFixture());

    const result = patchCodexModelSelectionInExtractedApp(appDir);
    assert.equal(result.status, "patched");
    assert.equal(result.relativePath, join("webview", "assets", "app.mjs"));
    assert.equal(result.scannedFiles, 1);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("extracted-app patch fails closed on an unsupported direct module extension", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-model-selector-extension-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(appDir, "webview", "index.html"),
      '<!doctype html><script type="module" src="./assets/app.jsx"></script>',
    );
    writeFileSync(join(assetsDir, "app.jsx"), selectorFixture());

    assert.throws(
      () => patchCodexModelSelectionInExtractedApp(appDir),
      /unsupported JavaScript extension/,
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("extracted-app patch fails closed when the known selector layout drifts", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-model-selector-drift-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(assetsDir, "app.js"),
      selectorFixture().replace(
        "c=s&&o.hasManagedNewThreadSettings",
        "c=Boolean(s&&o.hasManagedNewThreadSettings)",
      ),
    );

    assert.throws(
      () => patchCodexModelSelectionInExtractedApp(appDir),
      /initializer layout changed/,
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});

test("extracted-app patch does not hide drift behind another marked asset", () => {
  const appDir = mkdtempSync(join(tmpdir(), "tweakers-model-selector-marked-drift-"));
  try {
    const assetsDir = join(appDir, "webview", "assets");
    mkdirSync(assetsDir, { recursive: true });
    const marked = patchCodexModelSelectionSource(selectorFixture());
    assert.ok(marked);
    writeFileSync(join(assetsDir, "marked.js"), marked.source);
    writeFileSync(
      join(assetsDir, "drifted.js"),
      selectorFixture().replace(
        "c=s&&o.hasManagedNewThreadSettings",
        "c=Boolean(s&&o.hasManagedNewThreadSettings)",
      ),
    );

    assert.throws(
      () => patchCodexModelSelectionInExtractedApp(appDir),
      /initializer layout changed/,
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
  }
});
