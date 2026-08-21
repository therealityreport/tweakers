# Plan 003: Serialize in-process runtime config-state writes so concurrent updates stop losing data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Baseline capture (run first)** — the working tree is intentionally dirty
> (73 pre-existing changed paths at planning time), and `packages/runtime/src/main.ts`
> is one of the pre-modified files, so this capture is what separates your work
> from the in-flight work:
>
> ```sh
> mkdir -p plans/artifacts
> git status --porcelain > plans/artifacts/003-baseline-status.txt
> git diff -- packages/runtime/src/main.ts packages/runtime/src/tweak-lifecycle.ts packages/runtime/test > plans/artifacts/003-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but run before plan 004 — both edit `packages/runtime/src/main.ts` and `tweak-lifecycle.ts`; do not execute them in parallel)
- **Category**: bug
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); rewritten 2026-08-19 after external audit

## Why this matters — and the explicit objective boundary

The runtime's persisted state (`config.json` in the Tweaker user-data dir) is mutated by a read-modify-write pattern with no serialization: read the whole file, mutate an in-memory snapshot, write the whole file back. Several writers hold their snapshot **across an `await` on the network**. The `tweaker:list-tweaks` IPC handler fires one `ensureTweakUpdateCheck` per discovered tweak via `Promise.all`; each reads state, awaits a GitHub release fetch (seconds), then writes its stale snapshot. The last writer wins:

- Only one tweak's update-check result survives; the others are silently discarded and re-fetched on every listing (wasted GitHub calls, rate-limit exposure).
- Worse, a user toggling a tweak (`setTweakEnabled`) or a health/quarantine record (`recordTweakHealth`) written during the fetch window is **silently reverted** when the stale snapshot lands.

**Objective boundary (read this before designing anything):** this plan fixes the confirmed **in-process** lost-update race inside the runtime's Electron main process. It does **not** attempt cross-process write safety. `config.json` is co-owned — `packages/installer/src/config.ts:4` documents:

```ts
/**
 * Shared config.json access. The file is co-owned by the runtime (tweak
 * enabled flags, update-check caches) and the installer, so every write MUST
 * round-trip unknown keys — read, mutate in place, write back.
 */
```

An in-process promise queue cannot prevent a concurrent installer CLI write from being clobbered; installer writes are rare, user-initiated CLI events, and cross-process locking is a separate, larger design (recorded in Maintenance notes). What this plan **must** preserve from that contract: every write round-trips unknown keys — the funnel reads the full file, mutates in place, writes the full object back, and a test proves unknown top-level keys survive.

## Current state

All excerpts from `packages/runtime/src/main.ts` (~6,500 lines; this plan touches only the state helpers and their callers) and `packages/runtime/src/tweak-lifecycle.ts`.

Read/write primitives (`main.ts` ~516–539):

```ts
function readState(): PersistedState {
  try {
    const state = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as PersistedState;
    // ... legacy-key migration elided ...
    return state;
  } catch {
    return {};
  }
}
function writeState(s: PersistedState): void {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log("warn", "writeState failed:", String((e as Error).message));
  }
}
```

A synchronous writer whose caller depends on completion ordering (`main.ts` ~938–943):

```ts
function setTweakEnabled(id: string, enabled: boolean): void {
  const s = readState();
  s.tweaks ??= {};
  s.tweaks[id] = { ...s.tweaks[id], enabled };
  writeState(s);
}
```

That ordering dependency (`packages/runtime/src/tweak-lifecycle.ts:216–225`) — `setTweakEnabled` must be **complete** before the reload reads enabled flags back from disk:

```ts
export async function setTweakEnabledAndReload(
  id: string,
  enabled: unknown,
  deps: SetTweakEnabledAndReloadDeps,
): Promise<true> {
  const normalizedEnabled = !!enabled;
  deps.setTweakEnabled(id, normalizedEnabled);
  deps.logInfo(`tweak ${id} enabled=${normalizedEnabled}`);
  await reloadTweaks("enabled-toggle", deps);
  return true;
}
```

Its call sites construct a shared deps object: `main.ts:976` and `main.ts:3023` both pass `tweakLifecycleDeps` (grep `tweakLifecycleDeps` in `main.ts` for its definition).

The racing async writer (`main.ts` ~4266–4298, abbreviated):

```ts
async function ensureTweakUpdateCheck(t: DiscoveredTweak): Promise<void> {
  const state = readState();
  const cached = state.tweakUpdateChecks?.[id];
  if (cached && /* fresh */) return;
  const next = await fetchLatestRelease(repo, t.manifest.version);   // <-- seconds pass; state is now stale
  // ... build `check` ...
  state.tweakUpdateChecks ??= {};
  state.tweakUpdateChecks[id] = check;
  writeState(state);                                                  // <-- clobbers everything written meanwhile
}
```

`ensureTweakerUpdateCheck` (`main.ts` ~4233–4264, the Tweaker-self check) has the same shape and **returns** the built check object.

The concurrent trigger (`main.ts` ~2960–2961):

```ts
ipcMain.handle("tweaker:list-tweaks", async () => {
  await Promise.all(tweakState.discovered.map((t) => ensureTweakUpdateCheck(t)));
```

Full inventory of `writeState(` call sites (line numbers at planning time — re-grep to confirm): 564, 583, 797, 914, 926, 942, 958, 967, 3223, 3245, 4262, 4296. All follow read→mutate→write. Only the two `ensure*UpdateCheck` functions hold the snapshot across an `await`; the rest are synchronous — but they are the writes that get clobbered by the async ones.

There is also a module-load-time read (`const bootstrapTweakerState = readState().tweaker;` ~line 545) — read-only, not a writer, leave it alone.

Repo conventions that apply:

- `packages/runtime` is TypeScript compiled for the Electron main process, `"type": "commonjs"` package.
- Tests use Node's built-in runner via tsx; many existing runtime tests assert against source text — do NOT follow that pattern; write behavioral tests (see Test plan).
- `AGENTS.md` change workflow, quoted: "**Runtime/installer:** run focused tests, typecheck/build, and full suite." Full `npm test` is a required gate (prereqs: Xcode CLT + python3).
- Do not restart or repair the live Codex app (`AGENTS.md`, "No mid-plan app restarts"). Source-only work.
- `packages/installer/assets/runtime/` is generated from this package by `npm run build`; regenerate, never hand-edit.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused tests | `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/runtime/test/state-store.test.ts packages/runtime/test/tweak-lifecycle.test.ts` | all pass |
| Lint | `npm run lint` | exit 0 |
| Regenerate assets | `npm run build` | exit 0 |
| Full suite | `npm test` | all pass (unrelated pre-existing failures → STOP conditions) |

## Scope

**In scope** (the only files you should modify):

- `packages/runtime/src/state-store.ts` (create — primary approach)
- `packages/runtime/src/main.ts` (state helpers + writers repointed)
- `packages/runtime/src/tweak-lifecycle.ts` (`SetTweakEnabledAndReloadDeps` type + the `await`)
- `packages/runtime/test/state-store.test.ts` (create)
- `packages/runtime/test/tweak-lifecycle.test.ts` (extend)
- `plans/README.md` (status row), `plans/artifacts/` (evidence)
- `packages/installer/assets/runtime/**` and `store/index.json` — **only** as regenerated output of `npm run build`

**Out of scope** (do NOT touch):

- `packages/installer/src/config.ts` and any cross-process locking — see the objective boundary.
- `packages/runtime/src/storage.ts` — per-tweak storage has its own flush mechanism.
- Splitting `main.ts` into modules beyond the state-store extraction.
- `fetchLatestRelease` and the update-check caching policy — behavior unchanged.
- Plan 004's targets (`stopAllMainTweaks`, tweak-host, native-bridge, AppShots).

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides commits later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work).
- `main.ts` already carries pre-existing uncommitted modifications — your `003-before.diff` capture is the boundary line. Final evidence: `git diff -- <in-scope paths> > plans/artifacts/003-after.diff`.

## Steps

### Step 1: Create `packages/runtime/src/state-store.ts`

A small module exporting a factory, so the queue logic is testable without booting Electron:

```ts
export interface StateStore<T extends Record<string, unknown>> {
  read(): T;
  /**
   * Apply a mutation to the freshest persisted state. The mutator receives the
   * just-read state and either mutates it in place (return void) or returns a
   * replacement. Mutations are serialized: the read→mutate→write triple runs
   * synchronously within one queue turn, so a snapshot can never span an await.
   * Unknown keys always round-trip (config.json is co-owned by the installer —
   * see packages/installer/src/config.ts).
   */
  mutate(mutator: (state: T) => T | void): Promise<void>;
}

export function createStateStore<T extends Record<string, unknown>>(deps: {
  read: () => T;
  write: (state: T) => void;
}): StateStore<T> {
  let queue: Promise<void> = Promise.resolve();
  const mutate = (mutator: (state: T) => T | void): Promise<void> => {
    const operation = queue.then(() => {
      const state = deps.read();
      const result = mutator(state);
      deps.write(result ?? state);
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return { read: deps.read, mutate };
}
```

Adapt naming/formatting to the file conventions of neighboring runtime modules (e.g. `tweak-lifecycle.ts`). The `read`/`write` deps are `main.ts`'s existing `readState`/`writeState` — unknown-key round-tripping is inherited because `readState` parses the full file and `writeState` serializes the full object.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Instantiate the store in `main.ts` and convert the two async writers

Below `writeState`, create `const stateStore = createStateStore({ read: readState, write: writeState });`

In `ensureTweakUpdateCheck`: keep the freshness pre-check as-is (an early `readState()` for the cache test is fine — worst case a redundant fetch). Move the write into the funnel:

```ts
  const next = await fetchLatestRelease(repo, t.manifest.version);
  // ... build `check` exactly as today ...
  await stateStore.mutate((state) => {
    state.tweakUpdateChecks ??= {};
    state.tweakUpdateChecks[id] = check;
  });
```

Same for `ensureTweakerUpdateCheck` (writes `state.tweaker.updateCheck`; keep returning the locally built `check`). Delete the stale-snapshot mutations and the trailing `writeState(state)` calls.

**Verify**: `npm run typecheck` → exit 0; `grep -c "writeState(state)" packages/runtime/src/main.ts` no longer counts the two update-check sites.

### Step 3: Convert the synchronous writers — ordering-sensitive ones return promises

Convert each remaining read→mutate→`writeState` site (re-grep `writeState(` to enumerate against the inventory above) to `stateStore.mutate(...)`, keeping each mutation body byte-for-byte identical. The completion-semantics rule:

- **Ordering-sensitive setters return the promise.** `setTweakEnabled` becomes `function setTweakEnabled(id, enabled): Promise<void> { return stateStore.mutate((s) => { ... }); }`. Any setter whose caller reads state back immediately afterward (audit each caller as you convert) also returns its promise.
- `recordTweakHealth` builds the record first, `await`s (or returns) the mutation, and still returns the record — check each of its callers: if a caller is synchronous and cannot await, that caller relies on the *record object*, not the persisted file, which is fine; note any exception you find.
- **Fire-and-forget (`void stateStore.mutate(...)`) is allowed ONLY for update-check cache writes** (the two `ensure*` functions already `await`; any other cache-ish writer you make fire-and-forget needs a one-line code comment justifying why no reader depends on its completion).

**Verify**: `grep -n "writeState(" packages/runtime/src/main.ts` → exactly 2 matches: the `writeState` definition and the single reference passed into `createStateStore`.

### Step 4: Fix the toggle→reload ordering in `tweak-lifecycle.ts`

Update the deps type and the call:

```ts
// SetTweakEnabledAndReloadDeps:
setTweakEnabled: (id: string, enabled: boolean) => void | Promise<void>;

// setTweakEnabledAndReload:
await deps.setTweakEnabled(id, normalizedEnabled);
```

Then check every construction site of the deps object (`grep -n "tweakLifecycleDeps\|setTweakEnabled" packages/runtime/src/main.ts`) so the promise-returning `setTweakEnabled` flows through. This guarantees the toggle is persisted before `reloadTweaks` re-reads enabled flags from disk.

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Tests, then regenerate

Write the tests in the Test plan, run focused tests, then `npm run build` and full `npm test`. Commit nothing; regenerated `packages/installer/assets/runtime/**` output stays in the working tree with everything else.

**Verify**: focused tests pass (≥5 new); `npm run build` exit 0; full suite passes or unrelated failures documented in `plans/artifacts/003-suite-failures.txt`.

## Test plan

`packages/runtime/test/state-store.test.ts` (create; behavioral, temp-dir based — model on `packages/runtime/test/tweak-lifecycle.test.ts` structure, using `fs.mkdtempSync`):

1. **Interleaved async writers don't clobber**: enqueue mutation A behind a delay, run mutation B immediately; final file contains both keys.
2. **Toggle-during-fetch survives (the headline bug)**: write `{tweaks:{x:{enabled:false}}}` via one mutation while another mutation (simulating the update-check) was built from earlier state; final file contains **both** the toggle and the check.
3. **Throwing mutator doesn't wedge the queue**: a throwing mutator rejects its promise; a subsequent mutation still lands.
4. **Unknown-key round-trip (the co-ownership contract)**: seed the file with `{"installerOwnedKey": {"a": 1}}`, run a mutation touching an unrelated key, assert `installerOwnedKey` survives byte-for-byte.

`packages/runtime/test/tweak-lifecycle.test.ts` (extend):

5. **Toggle persists before reload**: deps whose `setTweakEnabled` returns a delayed promise that sets a flag on resolve; deps' `loadAllMainTweaks` asserts the flag is already set when it runs.

None of these may read `.ts` source text with `readFileSync` — behavioral assertions only.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `packages/runtime/src/state-store.ts` exists; `grep -c "writeState(" packages/runtime/src/main.ts` → exactly 2.
- [ ] `grep -n "await deps.setTweakEnabled" packages/runtime/src/tweak-lifecycle.ts` → 1 match.
- [ ] Focused tests pass with ≥5 new behavioral tests, including the unknown-key round-trip case.
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` exit 0; full `npm test` passes or unrelated pre-existing failures are documented in `plans/artifacts/`.
- [ ] `git status --porcelain > plans/artifacts/003-after-status.txt`; diff vs baseline shows only in-scope paths, regenerated assets, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The `readState`/`writeState`/`ensureTweakUpdateCheck`/`setTweakEnabledAndReload` code no longer matches the excerpts (main.ts is pre-modified on this tree — verify carefully before starting).
- A writer's mutation semantics cannot be expressed as a pure function of the fresh state (it depends on the stale snapshot by design). Report it; do not guess.
- Converting `setTweakEnabled` to promise-returning cascades into callers outside the in-scope files.
- `npm run build` or full `npm test` fails for reasons unrelated to your change (the dirty baseline may have pre-existing issues — capture output, report, don't fix).

## Maintenance notes

- Every future runtime state write must go through `stateStore.mutate`. A reviewer seeing a new bare `writeState`/`writeFileSync(CONFIG_FILE …)` call should reject it.
- The module-load bootstrap read (`bootstrapTweakerState`) intentionally bypasses the funnel (synchronous, before any writer exists) — do not "fix" it.
- **Known, accepted limitation**: cross-process races with the installer remain possible (`config.ts` co-ownership). If they ever show up in practice, the fix is file-level locking or CAS shared between `config.ts` and `state-store.ts` — a separate plan; the unknown-key round-trip test added here is the invariant both sides already rely on.
- Follow-up (out of scope): `readState` is called from ~29 sites and re-parses the file each time; an in-memory cache invalidated by the funnel would remove that cost.
