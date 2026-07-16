# Codex Chat UI root-cause evidence

## Diagnosed source

The old renderer is the generated ShadGPT asset at:

`../shadgpt-source/packages/installer/assets/default-tweaks/co.tweakers.codex-chat-ui/index.js`

Its SHA-256 during the 2026-07-10 diagnosis was
`ba716f24575c5b2987f34df44e4a8926adb72086aafcc7ae82871d06d50d88ea`.
This is source evidence for the old implementation, not proof that the same
file was installed and enabled in the running app.

## Demonstrated failure

The old implementation selects assistant roots through the minified class
`div.group.flex.min-w-0.flex-col`, parses fenced JSON from rendered `pre` and
`code` nodes, and falls back to a full scan every 30 seconds. Its observer
subscribes to `childList` but not `characterData`, even though streamed response
completion can update an existing text node without inserting an element.

The diagnostic reproduction proves both sides of the gap:

- its helper can resolve a `characterData` record back to the correct message;
- the browser cannot deliver that record because the production observer did
  not subscribe to text mutations.

From the enclosing `revi` directory, reproduce the old failure with:

```sh
node diagnostics/codex-chat-ui/streaming-observer-repro.cjs
```

The final assertion is expected to fail against the old source with
`immediateScanScheduled: false`. The bounded ownership model remains green:

```sh
node --test diagnostics/codex-chat-ui/bounded-mount-contract.test.cjs
```

## Runtime evidence and limits

Read-only inspection recorded that `/Applications/ChatGPT.app` version
`26.707.41301` still contained the assistant-root class and a current hashed
markdown class, but no installed `co.tweakers.codex-chat-ui/index.js` was
found under the Codex++ Application Support directory. CDP was not exposed on
the common local ports. Therefore the selector compatibility was observed in
the packaged app, while deployment and live-renderer behavior remained
unverified.

## Mapping to the fixed contract

The replacement is `tweaks/co.tweakers.shadcn-codex-ui/index.js`.
`test/rich-block-lifecycle.test.cjs` now locks the relevant fixes:

- `characterData: true`, deep observation, coalescing, and disconnect cleanup;
- bounded message-root collection;
- one owned mount that preserves native message children;
- fail-closed version parsing and a 100-block payload bound;
- idempotent disposal of only the owned mount.

Run the current regression suite from this repository:

```sh
node --test tweaks/co.tweakers.shadcn-codex-ui/test/rich-block-lifecycle.test.cjs
```

