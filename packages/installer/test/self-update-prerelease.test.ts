import assert from "node:assert/strict";
import test from "node:test";
import { selectHighestPrereleaseRelease } from "../src/commands/self-update.ts";

test("prerelease selection uses semver order and ignores drafts and invalid tags", () => {
  const selected = selectHighestPrereleaseRelease([
    { tag_name: "v1.4.0-alpha.2", prerelease: true },
    { tag_name: "v1.4.0-alpha.10", prerelease: true, html_url: "https://example.test/alpha.10" },
    { tag_name: "v99.0.0-alpha.1", prerelease: true, draft: true },
    { tag_name: "v2.0.0-alpha.01", prerelease: true },
    { tag_name: "nightly", prerelease: true },
    { tag_name: "v9.0.0", prerelease: false },
  ]);

  assert.deepEqual(selected, {
    tag_name: "v1.4.0-alpha.10",
    prerelease: true,
    html_url: "https://example.test/alpha.10",
  });
});
