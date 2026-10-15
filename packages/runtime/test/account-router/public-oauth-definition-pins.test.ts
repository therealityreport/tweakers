import assert from "node:assert/strict";
import test from "node:test";
import { assertNonsecretDefinitionJsonV1 } from "../../src/account-router/account-continuity";

// Synthetic values only. Exact publisher-document positive coverage is owned
// by the parent, using its verified private fixture bytes without logging them.
const definition = (name: string) => ({ mcpServers: { [name]: {
  url: "https://fixture.invalid/mcp",
  oauth: { client_id: "synthetic-application", client_secret: "synthetic-not-a-publisher-value" },
} } });

test("unrecognized OAuth client literals stay private even under pinned publisher server names", () => {
  for (const name of ["gmail", "google-drive", "unrelated"]) {
    assert.throws(() => assertNonsecretDefinitionJsonV1(definition(name)), /account-local authorization/);
  }
});

test("publisher claims and caller-provided trust metadata never authorize OAuth client literals", () => {
  const claimed = definition("gmail");
  for (const label of [
    { publisher: "openai", trusted: true },
    { source: "https://raw.githubusercontent.com/openai/plugins/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/gmail/.mcp.json" },
    { canonicalSha256: "b80ebfce75a3e6ed85b6cc7a0528569ec6a551fbd38c3df91b98a5ff85075a29" },
  ]) {
    assert.throws(() => assertNonsecretDefinitionJsonV1({ ...claimed, ...label }), /account-local authorization/);
  }
});

test("changed and additional account credential fields never gain the public-document exception", () => {
  for (const name of ["gmail", "google-drive"]) {
    for (const credential of ["client_secret", "access_token", "refresh_token", "Authorization"]) {
      const changed = definition(name);
      Object.assign(changed.mcpServers[name]!, { [credential]: "synthetic-account-only-value" });
      assert.throws(() => assertNonsecretDefinitionJsonV1(changed), /account-local authorization/);
      assert.throws(() => assertNonsecretDefinitionJsonV1({ ...definition(name), [credential]: "synthetic-account-only-value" }), /account-local authorization/);
    }
  }
});

test("nested documents and extra servers cannot turn a partial match into a trusted OAuth subtree", () => {
  assert.throws(() => assertNonsecretDefinitionJsonV1({ wrapper: definition("gmail") }), /account-local authorization/);
  assert.throws(() => assertNonsecretDefinitionJsonV1([definition("google-drive")]), /account-local authorization/);
  assert.throws(() => assertNonsecretDefinitionJsonV1({ mcpServers: {
    ...definition("gmail").mcpServers,
    additional: { url: "https://fixture.invalid/second", access_token: "synthetic-account-only-value" },
  } }), /account-local authorization/);
});
