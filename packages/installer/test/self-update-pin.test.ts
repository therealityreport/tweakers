import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UPDATE_REPO, resolveUpdateRepo } from "../src/commands/self-update.ts";

test("watcher refuses a non-pinned repo", () => {
  assert.equal(
    resolveUpdateRepo(
      { watcher: true },
      { updateRepo: "evil/repo" },
      { CODEX_PLUSPLUS_REPO: "attacker/x" },
    ),
    DEFAULT_UPDATE_REPO,
  );
});

test("interactive --repo overrides", () => {
  assert.equal(resolveUpdateRepo({ repo: "someone/fork" }, {}), "someone/fork");
});

test("interactive --repo rejects a bad slug", () => {
  assert.throws(() => resolveUpdateRepo({ repo: "../etc/passwd" }, {}));
});

test("interactive without --repo honors an allowlisted config repo", () => {
  assert.equal(resolveUpdateRepo({}, { updateRepo: "org/repo" }, {}), "org/repo");
});

test("interactive without --repo falls back to default for a bad config repo", () => {
  assert.equal(resolveUpdateRepo({}, { updateRepo: "not a slug" }, {}), DEFAULT_UPDATE_REPO);
});
