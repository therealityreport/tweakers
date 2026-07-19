# tweaker

Installer CLI for tweaker, a local tweak system for the Codex desktop app.

The installed repair watcher executes from
`<user-data-dir>/managed-runtime/current/packages/installer/dist/cli.js`, so a
dirty development checkout cannot block repairs or stable release checks.

For development, `tweaker dev-sync --watch` watches the checkout, validates and
builds changes, then transactionally publishes a live snapshot. Failed builds do
not replace the last working snapshot and the command never changes Git state.

```sh
curl -fsSL https://raw.githubusercontent.com/therealityreport/tweakers/main/install.sh | bash
```

See the repository README for architecture, tweak authoring, security policy, and release notes:

https://github.com/therealityreport/tweakers
