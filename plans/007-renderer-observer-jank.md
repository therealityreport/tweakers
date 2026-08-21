# Plan 007: Cut renderer jank from document-wide observers without breaking text-sensitive surfaces

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Baseline capture (run first)** — the working tree is intentionally dirty
> (73 pre-existing changed paths at planning time), and the projects tweak is
> among the pre-modified paths:
>
> ```sh
> mkdir -p plans/artifacts
> git status --porcelain > plans/artifacts/007-baseline-status.txt
> git diff -- packages/runtime/src/preload/host-surfaces.ts tweaks/co.tweakers.projects > plans/artifacts/007-before.diff
> ```
>
> **Drift check**: compare the "Current state" excerpts below against the live
> files. The excerpts are the authority (HEAD is `46a2fcc` and the working tree
> is ahead of it, so commit-range diffs prove nothing). On a mismatch, STOP.
> Additionally run `node tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs --check`
> before starting — if the generated `index.js` is stale relative to `lib/`, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED (behavioral perf change in DOM-injection code that must keep finding its targets)
- **Depends on**: none (no other plan touches these files)
- **Category**: perf
- **Planned at**: commit `46a2fcc`, 2026-08-19 (dirty working tree); rewritten 2026-08-19 after external audit

## Why this matters

While Codex streams an assistant response, the DOM mutates continuously. Two Tweaker observers do document-wide work on every mutation batch, on the renderer main thread, for the life of the window:

1. **host-surfaces shared observer** (`packages/runtime/src/preload/host-surfaces.ts`): observes `document.documentElement` with `characterData: true, subtree: true`. Streaming text is character data, so every streamed token wakes it; the rAF-coalesced tick then runs `entry.kinds.map(snapshot)` for **every** listener — document-wide `querySelectorAll` over all `button, a, [role="button"]` (projects kind) and heavy text-matching scans, per frame, for as long as text streams.
2. **projects tweak gear-button observer** (canonical source `tweaks/co.tweakers.projects/lib/settings.js` ~728): a persistent `MutationObserver(inject)` on `document.body { childList: true, subtree: true }` with **no coalescing** — `inject` runs synchronously on every mutation batch, and its dialog-candidate scan does document-wide `querySelectorAll('[role="dialog"]…')` plus a heading walk with per-heading ancestor `querySelectorAll("button")` and full-subtree `textContent` serialization.

**Two constraints that shape the fix (both verified in the live code — an earlier draft got them wrong):**

- `characterData` cannot simply be dropped: the shipped `usage-limit-resets-tracker` tweak subscribes to the text-sensitive kind — `tweaks/usage-limit-resets-tracker/index.js:701`: `api.react?.host?.observe?.(["usage"], () => { ... })` — and `usageSurfaces()` matches elements by `textContent` regex. The fix is a **per-kind observer configuration**: pay for `characterData` only while a text-sensitive kind has a subscriber.
- `tweaks/co.tweakers.projects/index.js` is **generated**: `tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs` deterministically bundles `lib/*.js` into it ("Projects keeps its feature modules as readable CommonJS sources … This deterministic builder embeds the module graph…"). Edit `lib/settings.js`, then regenerate — never edit `index.js` by hand.

## Current state

**`packages/runtime/src/preload/host-surfaces.ts`** — `ensureObserver` (~lines 508–524):

```ts
function ensureObserver(): void {
  if (sharedObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  sharedObserver = new MutationObserver(() => {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      for (const entry of listeners) safelyNotify(entry, entry.kinds.map(snapshot));
    });
  });
  sharedObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-label", "aria-current", "role", "data-testid", "data-project-id", "data-project-name", "data-workspace-path", "data-usage-limit-key", "data-usage-limit", "disabled"],
    childList: true,
    characterData: true,
    subtree: true,
  });
}
```

`observe()` (~lines 492–506) adds a listener entry `{ kinds, listener }` to a module-level `listeners` set, calls `ensureObserver()`, delivers an initial synchronous notify, and returns an unsubscribe closure that disconnects the shared observer when the last listener leaves.

Snapshot producers in the same file: `snapshot(kind)` → `queryHostSurfaces(kind)` → per-kind scanners. `projectRows()` (~531): all `button, a, [role="button"]` + per-element `querySelector("svg")` + fiber walk; `threadContexts()` (~569); `usageSurfaces()` (~578): two document-wide `querySelectorAll` plus `/(?:usage|limit).*(?:remaining|reset|used)…/i.test(compact(element.textContent))` over all `section, article, [role='listitem']` — **text-sensitive**. Matches carry `{ kind, element, confidence, label }`.

Subscribers (verified by grep): `tweaks/co.tweakers.projects` (`["projects"]`, via its own source), `tweaks/co.tweakers.thread-summary-profiles/index.js:48` (`["thread-context","projects"]`), `tweaks/usage-limit-resets-tracker/index.js:701` (`["usage"]`).

**`tweaks/co.tweakers.projects/lib/settings.js`** — observer wiring (~lines 728–737; the generated copy of this code also appears in `index.js` ~3565 — ignore it, it regenerates):

```js
  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("tweaker:projects-state-ready", inject);
  inject();
  return () => {
    observer.disconnect();
    window.removeEventListener("tweaker:projects-state-ready", inject);
    document.querySelectorAll?.("[data-tweaker-project-dialog-appearance], [data-tweaker-project-settings-button]").forEach((node) => node.remove?.());
  };
```

The scan it triggers, `editProjectDialogCandidates` (in the same module family): `doc.querySelectorAll('[role="dialog"], [data-radix-dialog-content], [data-state="open"]')`, then all `h1, h2, h3, [role="heading"]` filtered by `/^Edit project$/i`, then an 8-level ancestor walk collecting `querySelectorAll("button")` looking for a Save button. Note the Save-button dependency: **a dialog can mount empty and receive its Save button in a later mutation batch** — the gate in step 3 must catch that case.

**Builder**: `tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs` — `node <script>` regenerates `index.js`; `node <script> --check` verifies it (the script's `checkRendererEntry` rejects stale output).

Repo conventions:

- `tweaks/` canonical; regenerate the projects entry with the builder, then `npm run sync:tweaks`; bump `tweaks/co.tweakers.projects/manifest.json` version (patch).
- `AGENTS.md` gates: runtime work → focused tests, typecheck/build, full suite; tweak work → sync, catalog check, build, full suite, then one operator-gated `tweaker dev-sync` snapshot (step 7). No app restarts ever.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Builder check | `node tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs --check` | exit 0 |
| Rebuild entry | `node tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs` | exit 0; `index.js` regenerated |
| Typecheck | `npm run typecheck` | exit 0 |
| Projects tweak tests | `node --import ./scripts/test-root-preload.mjs scripts/test-tweaks.mjs --tweak co.tweakers.projects` | all pass |
| Runtime focused tests | `node --import ./scripts/test-root-preload.mjs --import tsx --test packages/runtime/test/host-surfaces*.test.ts` (confirm filename with `ls packages/runtime/test \| grep -i host`) | all pass |
| Sync + catalog | `npm run sync:tweaks && npm run check:tweak-catalog` | exit 0 |
| Regenerate assets | `npm run build` | exit 0 |
| Full suite | `npm test` | all pass (unrelated pre-existing failures → STOP) |

## Scope

**In scope**:

- `packages/runtime/src/preload/host-surfaces.ts`
- `tweaks/co.tweakers.projects/lib/settings.js` (the canonical source)
- `tweaks/co.tweakers.projects/index.js` — **only** as regenerated output of the builder
- `tweaks/co.tweakers.projects/manifest.json` (version bump)
- Test files for both (extend existing)
- `plans/README.md` (status row), `plans/artifacts/` (evidence)
- Regenerated output (`store/index.json`, `packages/installer/assets/runtime/**`) via builder/sync/build only

**Out of scope**:

- `settings-injector.ts` (separately owned; its observer is already acceptably scheduled).
- `tweaks/usage-limit-resets-tracker` — consumer whose behavior must be preserved exactly.
- `tweaks/co.tweakers.thread-summary-profiles` — consumer only; must keep working unchanged.
- Any change to which elements the scanners ultimately match (selectors and filters stay identical).
- Every pre-existing dirty path in the baseline manifest not listed in scope.

## Version control protocol

- **No branches, no commits, no stash, no reset.** All work stays in the working tree; the operator decides commits later (`AGENTS.md`: preserve unrelated staged, modified, and untracked work).
- Final evidence: `git diff -- <in-scope paths> > plans/artifacts/007-after.diff`.

## Steps

### Step 1: Per-kind observer configuration in `host-surfaces.ts`

Introduce a text-sensitivity map and derive observer options from the union of active listeners' kinds:

```ts
const TEXT_SENSITIVE_KINDS: ReadonlySet<HostSurfaceKind> = new Set(["usage"]);

function activeKinds(): Set<HostSurfaceKind> {
  const kinds = new Set<HostSurfaceKind>();
  for (const entry of listeners) for (const kind of entry.kinds) kinds.add(kind);
  return kinds;
}

function observerOptionsForActiveKinds(): MutationObserverInit {
  const needsCharacterData = [...activeKinds()].some((kind) => TEXT_SENSITIVE_KINDS.has(kind));
  return {
    attributes: true,
    attributeFilter: [/* keep the existing list verbatim */],
    childList: true,
    ...(needsCharacterData ? { characterData: true } : {}),
    subtree: true,
  };
}
```

Rework `ensureObserver()` to observe with `observerOptionsForActiveKinds()`, and add a `reconfigureObserver()` that, when the needed options change (track the last-applied `needsCharacterData` in a module variable), disconnects and re-observes with the new options. Call `reconfigureObserver()` from `observe()` after adding a listener and from the unsubscribe closure after removing one (the existing "last listener leaves → disconnect entirely" behavior stays). Comment the design: `characterData` is paid only while a text-sensitive kind (`usage`) has a subscriber, because streaming tokens otherwise wake the observer every frame; a future text-sensitive kind is added to `TEXT_SENSITIVE_KINDS`, never by re-adding blanket `characterData`.

**Verify**: `npm run typecheck` → exit 0; runtime host-surfaces tests pass (update any test pinning the old static options).

### Step 2: Suppress no-op notifies with semantic snapshot comparison

Extract an exported pure helper and use it in the rAF tick:

```ts
export function snapshotsEqual(a: HostSurfaceSnapshot[], b: HostSurfaceSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((snap, i) => {
    const other = b[i];
    return snap.kind === other.kind
      && snap.count === other.count
      && snap.matches.length === other.matches.length
      && snap.matches.every((m, j) => {
        const o = other.matches[j];
        return m.element === o.element && m.label === o.label && m.confidence === o.confidence;
      });
  });
}
```

In the tick, compute each entry's snapshots, compare against `entry.lastDelivered` (a new field on the listener entry), skip `safelyNotify` when equal, store when delivered. The comparison is **semantic** — element identity alone is not enough, because a surface can keep its element but change `label`/`confidence` (e.g. usage text updated in place). Keep the initial synchronous notify in `observe()` unchanged (it also seeds `lastDelivered`).

**Verify**: `snapshotsEqual` table tests pass (Test plan); runtime host-surfaces tests pass.

### Step 3: Coalesce + gate the projects dialog observer in `lib/settings.js`

Replace the direct `MutationObserver(inject)` with a rAF-coalesced scheduler and a mutation gate that catches **all three** dialog-relevant cases:

```js
  const DIALOGISH = '[role="dialog"], [data-radix-dialog-content], [data-state="open"]';
  let pendingInjectFrame = null;
  const scheduleInject = () => {
    if (pendingInjectFrame !== null) return;
    pendingInjectFrame = requestAnimationFrame(() => {
      pendingInjectFrame = null;
      inject();
    });
  };
  const mutationTouchesDialog = (mutations) => mutations.some((mutation) => {
    // (b) mutation happened INSIDE an already-mounted dialog (e.g. the Save
    // button arriving after the dialog shell) — check the target's ancestry.
    const target = mutation.target;
    const targetElement = target && target.nodeType === 1 ? target : target?.parentElement;
    if (targetElement?.closest?.(DIALOGISH)) return true;
    // (a) an added node IS or CONTAINS a dialog-ish node or heading.
    return [...(mutation.addedNodes || [])].some((node) =>
      node.nodeType === 1 && (
        node.matches?.(`${DIALOGISH}, h1, h2, h3, [role="heading"]`) ||
        node.querySelector?.(DIALOGISH)
      ));
  });
  const observer = new MutationObserver((mutations) => {
    if (mutationTouchesDialog(mutations)) scheduleInject();
  });
  // (c) dialogs that open by attribute flip alone (data-state toggling on an
  // existing node) are caught by observing that attribute.
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-state"],
  });
```

Keep `window.addEventListener("tweaker:projects-state-ready", inject)` and the initial `inject()` direct (rare events). In the teardown closure, `if (pendingInjectFrame !== null) cancelAnimationFrame(pendingInjectFrame);` before the existing cleanup. Adapt naming to the file's style; the selectors must remain byte-identical to `editProjectDialogCandidates`'s — define `DIALOGISH` once and reuse it in both if the module structure allows.

Bump `tweaks/co.tweakers.projects/manifest.json` version (patch).

**Verify**: projects tweak tests pass, including the three new gate tests (Test plan).

### Step 4: Regenerate the projects entry

`node tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs`, then `node ... --check`.

**Verify**: `--check` exit 0; `git diff --stat -- tweaks/co.tweakers.projects/index.js` shows the regeneration.

### Step 5: Sync, build, full gates

`npm run sync:tweaks` → `npm run build` → `npm run sync:tweaks -- --check` → `npm run check:tweak-catalog` → full `npm test`.

**Verify**: all exit 0; unrelated suite failures documented in `plans/artifacts/007-suite-failures.txt`.

### Step 6 (operator-gated): dev-sync snapshot

Per `AGENTS.md`'s tweak workflow, finish with one safe `tweaker dev-sync` snapshot and live verification. **STOP and request operator confirmation before running it.** Never restart or promote the live app. If declined/unavailable, mark DONE-pending-dev-sync in `plans/README.md`.

## Test plan

- **`snapshotsEqual` table tests** (runtime test file, behavioral): equal snapshots → true; changed element list → false; same elements but changed `label` → false; same elements but changed `confidence` → false; count mismatch → false.
- **Per-kind options**: wherever the existing host-surfaces test seam allows, assert: with only structure-kind listeners the observe options lack `characterData`; adding a `usage` listener reconfigures to include it; removing it reconfigures back. If the module's observer wiring is not reachable from tests without a DOM shim, test `observerOptionsForActiveKinds`/`TEXT_SENSITIVE_KINDS` as exported units and note the integration gap (do not add jsdom in this plan).
- **Projects gate tests** (`tweaks/co.tweakers.projects/test/`, following the existing fake-DOM harness patterns): (1) a mutation batch of unrelated nodes does **not** invoke the scan; (2) a batch adding a `[role="dialog"]` node schedules exactly one coalesced scan across multiple rapid batches; (3) **late Save button**: dialog shell present, then a mutation whose target sits inside the dialog adds a button → scan IS scheduled (the audit's missed case); (4) teardown cancels a pending frame. Stub `requestAnimationFrame` in the harness as manual-flush if absent.
- Full gates as in step 5.

## Done criteria

- [ ] `grep -n "characterData" packages/runtime/src/preload/host-surfaces.ts` shows it only inside the conditional options builder (no static `characterData: true` in an observe literal).
- [ ] `grep -n "TEXT_SENSITIVE_KINDS\|snapshotsEqual" packages/runtime/src/preload/host-surfaces.ts` → both present; `snapshotsEqual` exported.
- [ ] `grep -n "requestAnimationFrame" tweaks/co.tweakers.projects/lib/settings.js` shows the coalesced scheduler; `grep -n "closest" tweaks/co.tweakers.projects/lib/settings.js` shows the ancestry check.
- [ ] `node tweaks/co.tweakers.projects/scripts/build-renderer-entry.cjs --check` exits 0 (entry regenerated, not hand-edited).
- [ ] Projects tweak tests pass including the late-Save-button case; runtime host-surfaces tests pass; `snapshotsEqual` table tests pass.
- [ ] `co.tweakers.projects` manifest version bumped; `npm run sync:tweaks -- --check`, `npm run check:tweak-catalog`, `npm run typecheck` exit 0; `npm run build` exit 0; full `npm test` passes or unrelated failures documented.
- [ ] `git status --porcelain > plans/artifacts/007-after-status.txt`; diff vs baseline shows only in-scope paths, regenerated output, `plans/artifacts/*`, and `plans/README.md`.
- [ ] `plans/README.md` status row updated (including dev-sync-pending state if step 6 was deferred).

## STOP conditions

Stop and report back (do not improvise) if:

- Excerpts don't match the live code (both files are pre-modified on this dirty tree — verify first), or the builder `--check` fails before you start (stale generated entry — not yours to fix).
- You find a **fourth** `host.observe` subscriber or a new text-sensitive kind beyond `usage` — re-derive `TEXT_SENSITIVE_KINDS` and report the addition.
- Reconfiguring the observer (disconnect + re-observe) would drop mutations in a way an existing test detects (a gap between disconnect and observe is theoretically lossy; if a test proves it matters, report rather than papering over).
- The projects test harness can't express the observer-level tests without substantial new infrastructure (>~50 lines) — implement the fix, note the coverage gap, and stop short of building a new harness.
- Step 6 always stops for operator confirmation — by design.

## Maintenance notes

- Reviewer focus: any user report of "gear button missing until I click elsewhere" after this lands points at the step-3 gate — the ancestry check (b) and attribute branch (c) are the dials to widen. Any report of usage-tracker staleness points at `TEXT_SENSITIVE_KINDS` or the reconfigure path.
- When Codex ships a renderer redesign, `editProjectDialogCandidates`'s selectors are the fragile part (unchanged by this plan); the gate reuses the same `DIALOGISH` selector set — update both together.
- The larger companion findings (jsdom-based DOM fixtures, behavioral tests for preload modules) would make this class of change testable end-to-end; see `plans/README.md` deferred items.
