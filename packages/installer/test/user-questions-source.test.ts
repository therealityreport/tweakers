import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintPath, inspectUserQuestionsSource, userQuestionsSourceMatches } from "../src/user-questions-source";

function sourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "user-questions-source-"));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({
    id: "co.tweakers.user-questions",
    version: "0.5.0",
    scope: "both",
    mcp: { command: "node", args: ["mcp-server.js"] },
  }));
  for (const file of ["index.js", "mcp-server.js", "broker-protocol.js", "core.js"]) {
    writeFileSync(join(root, file), `module.exports = ${JSON.stringify(file)};\n`);
  }
  return root;
}

test("source proof binds canonical ID, version, payload, lifecycle, broker, and schema", () => {
  const root = sourceFixture();
  try {
    const proof = inspectUserQuestionsSource(root);
    assert.equal(proof.id, "co.tweakers.user-questions");
    assert.equal(proof.version, "0.5.0");
    assert.match(proof.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(userQuestionsSourceMatches(proof, proof), true);
    assert.equal(userQuestionsSourceMatches(proof, { ...proof, version: "0.5.1" }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("path fingerprints include modes and file bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "user-questions-hash-"));
  try {
    const file = join(root, "entry.js");
    writeFileSync(file, "one\n", { mode: 0o600 });
    const first = fingerprintPath(root).hash;
    chmodSync(file, 0o644);
    const modeChanged = fingerprintPath(root).hash;
    writeFileSync(file, "two\n");
    assert.notEqual(first, modeChanged);
    assert.notEqual(modeChanged, fingerprintPath(root).hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("source proof rejects symlinked payload entries", () => {
  const root = sourceFixture();
  try {
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(root, "linked"));
    assert.throws(() => inspectUserQuestionsSource(root), /symbolic links are not allowed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
