# Ask User Questions Tweaker audit recon

- Audit date: 2026-08-11
- Repository: `/Users/thomashulihan/Projects/tweakers`
- Baseline commit: `ce4021eb25a5b887ac86d455e8a86fb904474390`
- Scope: canonical `tweaks/user-questions/` source; the synchronized catalog and generated runtime copy; direct runtime, installer, MCP-lifecycle, and promotion integration; focused tests; public documentation; and read-only installed-state evidence.
- Excluded: unrelated tweaks and unrelated runtime/installer behavior except direct callers, shared contracts, or evidence needed to judge User Questions.

## Stack and deployment shape

- Node.js 20+ ESM monorepo with npm workspaces.
- Canonical tweak code is CommonJS JavaScript under `tweaks/user-questions/`; TypeScript runtime and installer packages integrate it into Codex/ChatGPT Desktop.
- `store/index.json` is synchronized catalog data and `packages/installer/assets/runtime/` is generated output. Neither is independent source authority.
- The tweak spans renderer and main processes, exposes a local MCP server, persists private drafts and policy transactions, and has separate source, generated, installed, and live-process acceptance layers.

## Repository conventions and exemplars

- Preserve canonical/generated ownership and regenerate only through `npm run sync:tweaks`; exemplar: `AGENTS.md`.
- Tweak lifecycle must undo DOM, IPC, observer, and listener state; exemplar: `tweaks/AGENTS.md` and `tweaks/user-questions/index.js`.
- Public protocol validation and terminal states live in pure core/reducer modules; exemplars: `tweaks/user-questions/core.js` and `tweaks/user-questions/round-state.js`.
- Private persistent state uses bounded formats, fail-closed permissions, and atomic/CAS-style transitions; exemplars: `tweaks/user-questions/draft-store.js` and `tweaks/user-questions/policy-state.js`.
- Tests are Node's built-in test runner with temporary directories and semantic DOM harnesses; exemplars: `tweaks/user-questions/test/mcp-server.test.js`, `policy-state.test.js`, and `semantic-dom.js`.

## Verification commands and current results

- `npm run test:user-questions` — verified PASS: 139 tests, 0 failures.
- `npm run typecheck` — verified PASS.
- `npm run lint` — verified exit 0 with 135 repository-wide warnings and 0 errors; the script does not lint canonical tweak JavaScript.
- `npm run sync:tweaks -- --check` — verified PASS: 11 synchronized tweaks.
- `npm run check:tweak-catalog` — verified PASS.
- `npm audit --workspaces --include-workspace-root --json` — verified nonzero: one direct high-severity Electron dependency finding plus moderate/high advisories in the affected range; reachability and User Questions relevance require vetting.
- Full `npm test` and `npm run build` are intentionally not run during this read-only advisor audit because they generate build output. This is a verification gap, not a failure.

## Intent and documented decisions

- `README.md` and `tweaks/user-questions/README.md` define task-scoped decisions, explicit submitted/cancelled/display-failed ownership, bounded drafts, generic fallback, policy Preview/Apply/Restore, privacy, and separate live-restart acceptance.
- `AGENTS.md` prohibits mid-plan restarts and distinguishes source, generated, installed, visible, and promoted proof.
- No User Questions-specific ADR, PRD, `CONTEXT.md`, `DESIGN.md`, or `PRODUCT.md` was found in the recon glob.

## Current state and preservation boundary

- Branch is `main`, tracking `origin/main`.
- Pre-existing modified generated/native files are `packages/installer/assets/runtime/native/tweaker_native_host.node`, `packages/installer/assets/runtime/runtime-fingerprint.json`, and `packages/installer/assets/swap-helper/Tweakers Swap Helper.app/Contents/MacOS/Tweakers Swap Helper`; this audit does not touch or attribute them.
- `.full-review/state.json` records an older in-progress repository-wide review at phase 3. It is not resumed, archived, or modified.
- Existing `plans/` files belong to an unrelated effort, so this audit uses `advisor-plans/`.

## Considered and rejected

- None yet. Final vetting will record material false positives or by-design behaviors in the audit report.
