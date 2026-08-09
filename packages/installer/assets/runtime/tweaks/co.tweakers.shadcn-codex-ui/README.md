# Shadcn Codex UI

This renderer tweak appends an owned section to eligible assistant messages. It
does not replace native message content, and it has no main-process behavior.

## Rich Blocks v1

The accepted payload is `{ "version": 1, "blocks": [...] }`. Version 1 is
explicitly extensible: the built-in kinds receive specialized renderers, while
an otherwise valid unknown kind receives a safe text fallback. The built-ins
are `heading`, `text`, `paragraph`, `code`, `list`, `badge`, `divider`,
`keyValue`, and `callout`.

`keyValue` is normalized to `{ "kind": "keyValue", "pairs": [{ "key":
"Status", "value": "Ready" }] }`. The legacy single `key`/`value` form is
accepted only as input and normalized to that canonical pair list.

The parser accepts at most 64 KiB of serialized input, 48 KiB of normalized
output, 50 blocks, 20 fields per block, 20 array or key/value items, and three
nested container levels. Invalid or oversized input is not rendered. Parsing
occurs once per discovered candidate before reconciliation.

## Verification boundary

The focused suite uses a fake DOM and semantic-host fake to cover mount,
update, invalidation, newest-candidate selection, and cleanup. It does not
prove live Codex rendering, accessibility, or a large-payload host profile.
