import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeProjectLinksV1 } from "../../src/account-router/native-projects";
import type { OpaqueAccountId } from "../../src/account-router/types";

const owner = `ar_${"a".repeat(43)}` as OpaqueAccountId;
const other = `ar_${"b".repeat(43)}` as OpaqueAccountId;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-project-links-"))); const secret = randomBytes(32);
  const source = { id: "source-project", name: "Existing Project", roots: [{ path: "/workspace/project" }], metadata: { secret: "must not copy" } };
  let target: Record<string, unknown> | null = null;
  let ambiguous = false;
  const calls: Array<{ account: string; method: string; params: Record<string, unknown> }> = [];
  const request = async (account: OpaqueAccountId, method: string, params: Record<string, unknown>): Promise<unknown> => {
    calls.push({ account, method, params: structuredClone(params) });
    if (method === "project/read") return { project: account === owner ? structuredClone(source) : target ? structuredClone(target) : null };
    assert.equal(account, other);
    if (method === "project/import") {
      target ??= { id: "target-project", name: params.name, roots: params.roots, metadata: {} };
      if (ambiguous) { ambiguous = false; return null; }
      return { project: structuredClone(target) };
    }
    if (method === "project/update") { target = { ...target, name: params.name, roots: params.roots }; return { project: structuredClone(target) }; }
    throw new Error("unexpected method");
  };
  return { root, secret, source, calls, request, make: () => new NativeProjectLinksV1(root, owner, secret, request), ambiguous: () => { ambiguous = true; } };
}

test("native project sharing imports metadata only and preserves public source IDs", async () => {
  const f = fixture(); const links = f.make();
  assert.equal(await links.ensureProjectForAccount("source-project", other), "target-project");
  assert.equal(links.publicProjectId(other, "target-project"), "source-project");
  assert.equal(links.projectForAccount("source-project", owner), "source-project");
  const imported = f.calls.find((c) => c.method === "project/import")!;
  assert.deepEqual(imported.params.metadata, {}); assert.equal(imported.params.threads, null);
  assert.equal(JSON.stringify(imported).includes("must not copy"), false);
  const persisted = readFileSync(join(f.root, "native-project-links.v1.json"), "utf8");
  assert.equal(persisted.includes("must not copy"), false); assert.ok(persisted.length < 2048);
  assert.equal(f.make().publicProjectId(other, "target-project"), "source-project");
});

test("ambiguous import retries the identical durable request after restart", async () => {
  const f = fixture(); f.ambiguous();
  assert.equal(await f.make().ensureProjectForAccount("source-project", other), null);
  f.source.name = "Renamed while import was uncertain";
  assert.equal(await f.make().ensureProjectForAccount("source-project", other), "target-project");
  const imports = f.calls.filter((c) => c.method === "project/import");
  assert.equal(imports.length, 2); assert.deepEqual(imports[0]!.params, imports[1]!.params);
  assert.equal(f.calls.some((c) => c.method === "project/update" && c.params.name === f.source.name), true);
});

test("concurrent requests share one import and source changes update the target in place", async () => {
  const f = fixture(); const links = f.make();
  assert.deepEqual(await Promise.all([links.ensureProjectForAccount("source-project", other), links.ensureProjectForAccount("source-project", other)]), ["target-project", "target-project"]);
  assert.equal(f.calls.filter((c) => c.method === "project/import").length, 1);
  f.source.roots = [{ path: "/workspace/new-root" }];
  assert.equal(await links.ensureProjectForAccount("source-project", other), "target-project");
  assert.equal(f.calls.filter((c) => c.method === "project/update").length, 1);
});

test("unknown source ID and malformed source roots cannot create a project", async () => {
  const f = fixture(); const links = f.make();
  assert.equal(await links.ensureProjectForAccount("unknown", other), null);
  f.source.roots = [{ path: "relative/path" }];
  assert.equal(await links.ensureProjectForAccount("source-project", other), null);
  assert.equal(f.calls.some((c) => c.method === "project/import"), false);
});
