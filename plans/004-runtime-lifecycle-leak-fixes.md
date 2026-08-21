# Plan 004: Fix four runtime lifecycle leaks (waitForElement hang, AppShots hotkey, native-bridge dispose race, storage corruption)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Baseline capture (run first)** — the working tree is intentionally dirty
> (73 pre-existing changed paths at planning time):
>
> ```sh
> mkdir -p plans/artifacts
> git status --porcelain > plans/artifacts/004-baseline-status.txt
> git diff -- packages/runtime/src/preload/tweak-host.ts tweaks/co.tweakers.appshots packages/runtime/src/main.ts packages/runtime/src/tweak-lifecycle.ts packages/runtime/src/native-bridge.ts packages/runtime/src/storage.ts > plans/artifacts/004-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M (four S-sized fixes)
- **Risk**: LOW
- **Depends on**: plan 003 (both edit `packages/runtime/src/main.ts` and `tweak-lifecycle.ts` — land 003 first)
- **Category**: bug
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); revised 2026-08-19 after external audit

## Why this matters

Four confirmed lifecycle defects, all small, all in the "runs inside the user's live Codex app" tier where leaks persist for the renderer/app lifetime:

- **A.** `api.react.waitForElement(sel, timeoutMs)` never times out if the DOM goes idle: the deadline is only checked inside the MutationObserver callback. The promise hangs forever and a document-wide observer leaks — per call. A shipped tweak (`usage-limit-resets-tracker`) calls it with a selector that legitimately may never match.
- **B.** AppShots registers its global hotkey asynchronously; disabling the tweak before registration resolves leaves the just-registered shortcut orphaned (blocks that key combo system-wide, suppresses the native AppShots shortcut). Compounding it, `stopAllMainTweaks` calls async `stop()` without awaiting, so a hot reload can re-register before the old registration is released → "Could not register AppShots shortcut" startup error. **The dispose-path fix must chain the unregister into the tracked promise** — a fire-and-forget unregister leaves the same race open.
- **C.** `NativeBridge.disposeTweak` deletes the instance-map entry in an async `.finally` keyed only by map key; a reloaded tweak that re-creates an instance with the same stable native id gets its **new** instance deleted by the old disposal.
- **D.** `createDiskStorage` treats any valid-JSON value as an object; a storage file containing `null` (external corruption/truncation survivable as valid JSON) makes every `get`/`set` throw with no self-heal — the corrupt-file quarantine only triggers on parse errors.

## Current state

**A. `packages/runtime/src/preload/tweak-host.ts` (~lines 274–290):**

```ts
      waitForElement: (sel, timeoutMs = 5000) =>
        new Promise((resolve, reject) => {
          const existing = document.querySelector(sel);
          if (existing) return resolve(existing);
          const deadline = Date.now() + timeoutMs;
          const obs = new MutationObserver(() => {
            const el = document.querySelector(sel);
            if (el) {
              obs.disconnect();
              resolve(el);
            } else if (Date.now() > deadline) {
              obs.disconnect();
              reject(new Error(`timeout waiting for ${sel}`));
            }
          });
          obs.observe(document.documentElement, { childList: true, subtree: true });
        }),
```

Shipped caller: `tweaks/usage-limit-resets-tracker/index.js:710` — `api.react?.waitForElement?.("[data-usage-limit-key], [data-testid*='usage' i]", 5000).then(scan).catch(() => {});`

**B1. `tweaks/co.tweakers.appshots/index.js` (registration, ~lines 49–60; dispose, ~lines 91–98):**

```js
  api.codex.hotkeys.registerCaptureHotkey({
    preferred: "DoubleCommand",
    fallbackAccelerator: DEFAULT_SETTINGS.fallbackAccelerator,
    suppressNativeAppshots: true,
  }, () => {
    void runCapture(state, "shortcut");
  }).then((registration) => {
    state.hotkey = registration;
    setStatus(state, "ready", `Shortcut active: ...`);
  }).catch((error) => { setStatus(state, "error", `Shortcut unavailable: ${messageFor(error)}`); });
```

```js
async function disposeMain(state) {
  state.disposed = true;
  for (const dispose of state.disposers.splice(0)) {
    try { dispose?.(); } catch {}
  }
  try { await state.hotkey?.unregister?.(); } catch {}
  state.hotkey = null;
}
```

The tweak's `stop()` is async: `async stop() { await this._appshots?.dispose?.(); this._appshots = null; }` (lines ~22–25).

**B2. `packages/runtime/src/main.ts` (~lines 4185–4199):**

```ts
function stopAllMainTweaks(): void {
  for (const [id, t] of tweakState.loadedMain) {
    try {
      t.stop?.();
      t.storage.flush();
      log("info", `stopped main tweak: ${id}`);
    } catch (e) {
      log("warn", `stop failed for ${id}:`, e);
    } finally {
      nativeBridge.disposeTweak(id);
      disposeOwlViewsForTweak(id);
    }
  }
  tweakState.loadedMain.clear();
}
```

Reload sequencing (`packages/runtime/src/tweak-lifecycle.ts`, ~lines 203–214) calls `deps.stopAllMainTweaks()` synchronously, then `await deps.loadAllMainTweaks()` — so an unawaited async `stop` overlaps the next load. `reloadTweaks` and its `ReloadTweaksDeps` interface type `stopAllMainTweaks` as returning `void`.

**C. `packages/runtime/src/native-bridge.ts` (~lines 190–194 and 344–356):**

```ts
  disposeTweak(tweakId: string): void {
    for (const [key, instance] of [...this.instances]) {
      if (instance.tweakId !== tweakId) continue;
      void this.disposeInstance(instance).finally(() => this.instances.delete(key));
    }
```

Create path reuses stable ids: `const id = typeof asRecord(value)?.id === "string" ? String(asRecord(value)?.id) : randomUUID();` then `instance.key = instanceKey(ctx.id, id); ... this.instances.set(instance.key, instance);`

The repo's own exemplar for this fix — the generation-guard pattern in `main.ts` (~line 5530, IPC handler dispose):

```ts
      return () => {
        if (mainIpcHandlerRegistrations.get(channel) !== registration) return;
        mainIpcHandlerRegistrations.delete(channel);
```

**D. `packages/runtime/src/storage.ts` (~lines 33–45):**

```ts
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      // Corrupt file — start fresh ... (moves file aside)
      try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
      data = {};
    }
  }
```

`get` uses `Object.prototype.hasOwnProperty.call(data, k)` — throws `TypeError` when `data === null`.

Repo conventions:

- Tweak sources under `tweaks/` are canonical CommonJS; after changing them run `npm run sync:tweaks` (regenerates `store/index.json` + packaged copies) — never hand-edit generated copies under `packages/installer/assets/runtime/`.
- Tweak lifecycle rule (`tweaks/AGENTS.md`): stop/dispose must undo everything start did. Bump the tweak's `version` in `tweaks/co.tweakers.appshots/manifest.json` (patch bump).
- `AGENTS.md` change workflow, quoted: "**Runtime/installer:** run focused tests, typecheck/build, and full suite." And for tweak work: "validate manifest, entry, lifecycle cleanup, permissions, and tests; apply a semantic-version bump; run `npm run sync:tweaks`; run focused tests, catalog check, build, and full suite; then run one safe `tweaker dev-sync` snapshot and verify the live app." The dev-sync step is **operator-gated** — see step 7.
- Do not restart/repair the live app ("No mid-plan app restarts", `AGENTS.md`).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused runtime test | `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/runtime/test/<file>.test.ts` | all pass |
| AppShots tweak tests | `node --import ./scripts/test-root-preload.mjs scripts/test-tweaks.mjs --tweak co.tweakers.appshots` | all pass |
| Tweak sync | `npm run sync:tweaks` | "tweak synchronization updated" |
| Catalog check | `npm run check:tweak-catalog` | exit 0 |
| Regenerate assets | `npm run build` | exit 0 |
| Full suite | `npm test` | all pass (unrelated pre-existing failures → STOP conditions) |

(If `--tweak co.tweakers.appshots` is not how `scripts/test-tweaks.mjs` names it, read its header; the root `package.json` shows the pattern `test:user-questions` → `--tweak user-questions`, i.e. it may accept the folder name.)

## Scope

**In scope** (the only files you should modify):

- `packages/runtime/src/preload/tweak-host.ts` (fix A)
- `tweaks/co.tweakers.appshots/index.js` + `tweaks/co.tweakers.appshots/manifest.json` (fix B1, version bump)
- `packages/runtime/src/main.ts` — `stopAllMainTweaks` only (fix B2)
- `packages/runtime/src/tweak-lifecycle.ts` — `ReloadTweaksDeps` type + the await (fix B2)
- `packages/runtime/src/native-bridge.ts` (fix C)
- `packages/runtime/src/storage.ts` (fix D)
- New/extended test files listed in Test plan
- `plans/README.md` (status row), `plans/artifacts/` (evidence)
- Regenerated output (`store/index.json`, `packages/installer/assets/runtime/**`) via `npm run sync:tweaks` / `npm run build` only

**Out of scope** (do NOT touch):

- Plan 003's territory in `main.ts` (`readState`/`writeState`/state-store, update checks) — 003 must already be DONE per the dependency.
- Other tweaks' lifecycle code, `host-surfaces.ts` (plan 007), `settings-injector.ts`.
- `registerCaptureHotkey` in `main.ts` (the host-side API) — the fix belongs in the tweak and the stop sequencing, not the API.
- Every pre-existing dirty path in the baseline manifest not listed in scope.

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides commits later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work).
- Final evidence: `git diff -- <in-scope paths> > plans/artifacts/004-after.diff`.

## Steps

### Step 1 (A): Add a real timeout to `waitForElement`

Add a `setTimeout` fallback that disconnects and rejects at the deadline, cleared on resolve/reject; keep the observer as the fast path. Target shape:

```ts
      waitForElement: (sel, timeoutMs = 5000) =>
        new Promise((resolve, reject) => {
          const existing = document.querySelector(sel);
          if (existing) return resolve(existing);
          let timer: ReturnType<typeof setTimeout>;
          const obs = new MutationObserver(() => {
            const el = document.querySelector(sel);
            if (el) settle(() => resolve(el));
          });
          const settle = (finish: () => void) => {
            clearTimeout(timer);
            obs.disconnect();
            finish();
          };
          timer = setTimeout(() => settle(() => reject(new Error(`timeout waiting for ${sel}`))), timeoutMs);
          obs.observe(document.documentElement, { childList: true, subtree: true });
        }),
```

**Verify**: `npm run typecheck` → exit 0.

### Step 2 (B1): Make AppShots dispose-safe — chain the unregister into the tracked promise

In `tweaks/co.tweakers.appshots/index.js`:

1. In `startMain`, keep the **whole registration chain** on state: `state.hotkeyRegistration = api.codex.hotkeys.registerCaptureHotkey({...}, listener).then(...).catch(...);` (initialize `hotkeyRegistration: null` in the state object).
2. The disposed branch **returns** the unregister promise so the chain settles only after cleanup completes — do NOT use `void`:

```js
  }).then((registration) => {
    if (state.disposed) {
      return registration.unregister?.();
    }
    state.hotkey = registration;
    setStatus(state, "ready", `Shortcut active: ...`);  // existing message unchanged
  }).catch((error) => { setStatus(state, "error", `Shortcut unavailable: ${messageFor(error)}`); });
```

3. In `disposeMain`, before the existing hotkey unregister, await the chain: `try { await state.hotkeyRegistration; } catch {}` — because the disposed branch chains the unregister, this await now settles only after the orphaned registration is fully released.

Bump `manifest.json` version (patch).

**Verify**: AppShots tweak tests pass (command above), including the new regression test from the Test plan.

### Step 3 (B2): Await async tweak `stop()` in `stopAllMainTweaks`

Change `stopAllMainTweaks` to async: for each tweak, `await` its `stop()` result (per-tweak try/catch preserved) **before** `nativeBridge.disposeTweak`/`disposeOwlViewsForTweak` run for that tweak, and before `loadedMain.clear()`. Update `ReloadTweaksDeps.stopAllMainTweaks` to `() => void | Promise<void>` and `await deps.stopAllMainTweaks()` inside `reloadTweaks`'s chained `run` (the `reloadSequence` chaining is what serializes reloads — the await must live inside it). Check all other callers: `grep -n "stopAllMainTweaks" packages/runtime/src/*.ts` — update each call site to await, or `void` with a justifying comment where the context is genuinely fire-and-forget (e.g. app-quit teardown with no subsequent load).

**Verify**: `npm run typecheck` → exit 0; `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/runtime/test/tweak-lifecycle.test.ts` → all pass.

### Step 4 (C): Identity-guard the native-bridge instance delete

```ts
      void this.disposeInstance(instance).finally(() => {
        if (this.instances.get(key) === instance) this.instances.delete(key);
      });
```

(Mirrors the `main.ts:5530` generation-guard exemplar quoted above.)

**Verify**: `npm run typecheck` → exit 0.

### Step 5 (D): Coerce non-object storage JSON to a fresh object

After the `JSON.parse`, validate the shape; on failure treat it exactly like the parse-error branch (move aside + start fresh):

```ts
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
        data = {};
      }
    } catch {
      ...existing branch unchanged...
```

(Deduplicate the move-aside into a tiny local helper if the file's style favors it.)

**Verify**: focused storage test (Test plan) passes.

### Step 6: Regenerate and run full gates

`npm run sync:tweaks` (AppShots changed) → `npm run build` → `npm run check:tweak-catalog` → full `npm test`.

**Verify**: sync check reports current afterwards (`npm run sync:tweaks -- --check`); catalog check exit 0; full suite passes or unrelated failures documented in `plans/artifacts/004-suite-failures.txt`.

### Step 7 (operator-gated): dev-sync snapshot

Per `AGENTS.md` the tweak workflow ends with "one safe `tweaker dev-sync` snapshot and verify the live app". **STOP here and request operator confirmation before running `tweaker dev-sync`.** Never restart, quit, or promote the live app yourself. If the operator declines or is unavailable, mark the plan DONE-pending-dev-sync in `plans/README.md` and say so in your report.

## Test plan

- **A**: no jsdom exists in this repo; cover A via a pure extraction only if trivially possible, otherwise rely on typecheck + code review and note it. (Do not add a jsdom dependency in this plan — that's a separate testing-infrastructure decision.)
- **B1 (the audit's required regression test)**: in `tweaks/co.tweakers.appshots/test/` (follow existing files; the tweak exposes `_test` helpers and takes an injected `api`). Build a fake `api.codex.hotkeys.registerCaptureHotkey` returning a controllable promise whose registration's `unregister` is also a controllable promise, and an ordered event log. Assert: dispose before registration resolves → (1) `state.hotkey` stays null; (2) the unregister is invoked; (3) `disposeMain`'s completion (and therefore any subsequent re-registration attempt in the log) occurs **only after** the unregister promise resolved — i.e. the log reads `register-resolved → unregister-started → unregister-resolved → dispose-completed`, never `dispose-completed` before `unregister-resolved`.
- **B2**: extend `packages/runtime/test/tweak-lifecycle.test.ts`: deps whose `stopAllMainTweaks` returns a delayed promise; assert `loadAllMainTweaks` is not invoked until it resolves.
- **C**: check for an existing native-bridge test seam (`ls packages/runtime/test | grep -i native`); if the bridge requires the native addon and no seam exists, implement the guard anyway and state the coverage gap explicitly in your report.
- **D**: storage test with a temp dir: write the literal `null` into the file, create storage, assert `get("k", "d") === "d"`, `set` works, and a `.corrupt-*` sibling file exists. Model on existing temp-dir tests (e.g. `packages/runtime/test/tweak-discovery.test.ts` style).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "setTimeout" packages/runtime/src/preload/tweak-host.ts` shows the new timer in `waitForElement`.
- [ ] `grep -n "return registration.unregister" tweaks/co.tweakers.appshots/index.js` → 1 match (the chained, not fire-and-forget, cleanup).
- [ ] The B1 regression test exists and passes (ordered-log assertion).
- [ ] AppShots `manifest.json` version bumped; `npm run sync:tweaks -- --check` reports current after sync.
- [ ] `grep -n "instances.get(key) === instance" packages/runtime/src/native-bridge.ts` → 1 match.
- [ ] Storage test with a `null` file passes.
- [ ] `npm run typecheck`, `npm run lint`, `npm run check:tweak-catalog` exit 0; `npm run build` exit 0; full `npm test` passes or unrelated failures documented.
- [ ] `git status --porcelain > plans/artifacts/004-after-status.txt`; diff vs baseline shows only in-scope paths, regenerated assets, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated (including dev-sync-pending state if step 7 was deferred).

## STOP conditions

Stop and report back (do not improvise) if:

- Any excerpt above no longer matches the live code (drift — several of these files are pre-modified on this tree).
- Plan 003 is not yet DONE in `plans/README.md` (dependency).
- Making `stopAllMainTweaks` async cascades into more than ~5 call sites or forces changes in files outside Scope.
- `scripts/test-tweaks.mjs` cannot target AppShots individually and the full tweak suite fails for unrelated reasons on the baseline (report the failure verbatim).
- Step 7 always stops for operator confirmation — that one is by design.

## Maintenance notes

- Reviewer focus: the B2 async conversion — confirm no code path runs `loadAllMainTweaks` concurrently with an in-flight stop, and the B1 chain — confirm nothing else assigns `state.hotkeyRegistration` after dispose.
- If the SDK ever documents `waitForElement`, the timeout-on-idle behavior is now the contract; keep the rejection message stable (`timeout waiting for <sel>`) since tweaks may match on it.
- Fix C's guard pattern should be used for any future async-dispose + keyed-map pairing in the bridge (helpers/modules maps have synchronous disposal today, so they don't need it).
