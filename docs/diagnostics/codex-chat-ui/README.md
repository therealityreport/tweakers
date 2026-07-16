# Codex Chat UI diagnostic and current fix

This is the repo-owned, normalized copy of the July 10 workspace diagnosis at
`diagnostics/codex-chat-ui`. The original investigation found that the old
standalone `co.tweakers.codex-chat-ui` tweak was a document-wide DOM
compatibility bridge: it parsed fenced JSON after render, observed only
`childList`, appended foreign panels into React-owned message roots, and could
delay streamed text reconciliation until its 30-second fallback scan.

The old standalone source is intentionally not part of the nine-tweak catalog.
The behavior now belongs to
`tweaks/co.tweakers.shadcn-codex-ui`, whose bounded contract is:

- observe scoped `childList` and `characterData` updates with `subtree: true`;
- reconcile at most one owned mount per message ID;
- preserve native markdown, message, tool, and composer content;
- fail closed for unknown payload versions or oversized payloads;
- remove only owned mounts, observers, timers, listeners, and styles on stop.

## Reproduction and regression commands

The original red reproduction remains archived outside this repo at
`diagnostics/codex-chat-ui/streaming-observer-repro.cjs`. It demonstrates why a
text-node-only streaming completion was invisible to the old observer.

Run the current green ownership/streaming contract:

```sh
node --test tweaks/co.tweakers.shadcn-codex-ui/test/rich-block-lifecycle.test.cjs
```

Run the catalog exclusion proof (the old standalone code is unallowlisted):

```sh
npm run check:tweak-catalog
```

## Current fix mapping

| Diagnosed gap | Current owner/proof |
|---|---|
| Text mutations were not observed | `rich-block-lifecycle.test.cjs` requires `characterData: true` and `subtree: true`. |
| DOM parsing/mounting was document-wide | `collectRichBlockRoots` accepts message roots only. |
| Native content could be hidden or replaced | `reconcileRichBlock` preserves `nativeChildren`. |
| Cleanup was global and lifecycle-ambiguous | `disposeRichBlockMount` removes only its owned mount and is idempotent. |
| Old source ownership was split/missing | The exact packaged source is copied from the canonical Shadcn Codex UI directory and checked by `check:tweak-catalog`. |

Live packaged-app DOM inspection remains a release validation step; these
fixtures prove the bounded source contract and packaged-source parity.
