import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpaqueAccountId } from "../../src/account-router/types";
import { NativeLegacyProjectsV1 } from "../../src/account-router/native-legacy-projects";

const metadataAccountId = `ar_${"a".repeat(43)}` as OpaqueAccountId;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-legacy-projects-")));
  const home = join(root, "source"); const broker = join(root, "broker");
  mkdirSync(home, { mode: 0o755 }); mkdirSync(broker, { mode: 0o700 });
  const path = join(home, ".codex-global-state.json");
  const data: Record<string, any> = {
    "thread-project-assignments": { "thread-a": { projectKind: "local", projectId: "legacy-a" }, "thread-b": { projectKind: "local", projectId: "legacy-a" }, "thread-c": { projectKind: "local", projectId: "legacy-b" }, "remote-thread": { projectKind: "remote", projectId: "elsewhere" } },
    "app-server-project-id-by-legacy-project-id-by-host": { [`local:${home}`]: { "legacy-a": "project-a", "legacy-b": "project-b" } },
    "sidebar-project-thread-orders": { "legacy-a": { threadIds: ["thread-b", "thread-a", "stale-thread"] } },
    credentials: "must-never-be-persisted", "browser-profile": { secret: "never" },
  };
  const write = () => writeFileSync(path, JSON.stringify(data), { mode: 0o644 }); write();
  return { root, home, broker, path, data, write, helper: new NativeLegacyProjectsV1(broker, home, metadataAccountId) };
}

test("legacy memberships read through in sidebar order with no metadata or transcript copies", () => {
  const f = fixture();
  assert.equal(f.helper.refresh(["project-a", "project-b"]), true);
  assert.deepEqual(f.helper.legacyNativeThreadIdsForProject("project-a"), ["thread-b", "thread-a"]);
  assert.equal(f.helper.legacyPublicProjectIdForThread("thread-c"), "project-b");
  assert.equal(f.helper.legacyPublicProjectIdForThread("remote-thread"), null);
  assert.deepEqual(readdirSync(f.broker), []);
  f.data["thread-project-assignments"]["thread-c"].projectId = "legacy-a"; f.write();
  assert.equal(f.helper.refresh(["project-a", "project-b"]), true);
  assert.deepEqual(f.helper.legacyNativeThreadIdsForProject("project-a"), ["thread-b", "thread-a", "thread-c"]);
});

test("only an explicit removal persists a bounded tombstone that survives refresh and reconnect", () => {
  const f = fixture(); assert.equal(f.helper.refresh(["project-a", "project-b"]), true);
  assert.equal(f.helper.removeThreadFromProject("project-a", "thread-a"), true);
  const reopened = new NativeLegacyProjectsV1(f.broker, f.home, metadataAccountId);
  assert.equal(reopened.refresh(["project-a", "project-b"]), true);
  assert.equal(reopened.isRemoved("project-a", "thread-a"), true);
  assert.equal(reopened.legacyPublicProjectIdForThread("thread-a"), null);
  assert.deepEqual(reopened.legacyNativeThreadIdsForProject("project-a"), ["thread-b"]);
  assert.equal(reopened.removeThreadFromProject("project-b", "thread-a"), true, "a later removal from B cannot resurrect legacy A");
  assert.equal(reopened.refresh(["project-a", "project-b"]), true);
  assert.equal(reopened.legacyPublicProjectIdForThread("thread-a"), null);
  const bytes = readFileSync(join(f.broker, "native-legacy-project-removals.v1.json"), "utf8");
  assert.equal(bytes.includes(f.home), false);
  assert.ok(bytes.length < 1024); assert.doesNotMatch(bytes, /credentials|browser-profile|must-never/);
});

test("conflicting hosts, malformed orders, and oversized assignment sets refuse overlays", () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.data["app-server-project-id-by-legacy-project-id-by-host"].other = { "legacy-a": "conflicting-project" }; },
    (f: ReturnType<typeof fixture>) => { f.data["sidebar-project-thread-orders"]["legacy-a"].threadIds = ["thread-a", "thread-a"]; },
    (f: ReturnType<typeof fixture>) => { f.data["thread-project-assignments"] = Object.fromEntries(Array.from({ length: 16385 }, (_, i) => [`t-${i}`, { projectKind: "local", projectId: "legacy-a" }])); },
  ]) {
    const f = fixture(); assert.equal(f.helper.refresh(["project-a", "project-b"]), true); mutation(f); f.write();
    assert.equal(f.helper.refresh(["project-a", "project-b"]), false);
    assert.equal(f.helper.legacyNativeThreadIdsForProject("project-a"), null);
    assert.equal(f.helper.legacyPublicProjectIdForThread("thread-a"), null);
  }
  const f = fixture(); assert.equal(f.helper.refresh(["project-a"]), true);
  assert.equal(f.helper.legacyPublicProjectIdForThread("thread-c"), null, "a removed or unverified project is never assigned");
  assert.equal(f.helper.unresolvedMembershipCount(), 1);
  assert.deepEqual(f.helper.legacyNativeThreadIdsForProject("project-a"), ["thread-b", "thread-a"], "stale memberships do not hide valid projects");
});

test("symlinked or writable source metadata and damaged removal state fail closed", () => {
  const f = fixture(); chmodSync(f.path, 0o666);
  assert.equal(f.helper.refresh(["project-a", "project-b"]), false);
  const otherHome = join(f.root, "linked-home"); mkdirSync(otherHome);
  symlinkSync(f.path, join(otherHome, ".codex-global-state.json"));
  assert.equal(new NativeLegacyProjectsV1(f.broker, otherHome, metadataAccountId).refresh(["project-a", "project-b"]), false);
  writeFileSync(join(f.broker, "native-legacy-project-removals.v1.json"), "invalid", { mode: 0o600 });
  assert.equal(new NativeLegacyProjectsV1(f.broker, f.home, metadataAccountId).refresh(["project-a", "project-b"]), false);
});

test("desktop projection creates current rows from native records even when legacy project rows are absent", () => {
  const f = fixture();
  const projection = f.helper.desktopProjection([
    { id: "project-a", name: "Source", roots: [] },
    { id: "project-b", name: "Second", roots: [{ path: "/workspace/second" }], metadata: {} },
  ]);
  assert.ok(projection);
  assert.deepEqual(projection.projectIdMap, { "legacy-a": "project-a", "legacy-b": "project-b" });
  assert.deepEqual(projection.values["local-projects"], {
    "legacy-a": { id: "legacy-a", name: "Source", rootPaths: [], createdAt: 0, updatedAt: 0 },
    "legacy-b": { id: "legacy-b", name: "Second", rootPaths: ["/workspace/second"], createdAt: 0, updatedAt: 0 },
  });
  assert.deepEqual(projection.values["project-order"], ["legacy-a", "legacy-b"]);
});

test("desktop projection accepts an absent legacy state file and partial native appearance metadata", () => {
  const f = fixture(); unlinkSync(f.path);
  const projection = f.helper.desktopProjection([{ id: "native-only", name: "Native Only", roots: [], metadata: { "appearance.color": "green" } }]);
  assert.ok(projection);
  assert.deepEqual(projection.projectIdMap, { "native-only": "native-only" });
  assert.deepEqual(projection.values["project-appearances"], { "native-only": { color: "green" } });
});

test("desktop projection reconciles renamed IDs and filters deleted project state without hiding new projects", () => {
  const f = fixture();
  f.data["local-projects"] = {
    "legacy-a": { id: "legacy-a", name: "SKILLS MANAGER", rootPaths: ["/workspace/manager"], createdAt: 10, updatedAt: 20 },
    "legacy-b": { id: "legacy-b", name: "Deleted", rootPaths: ["/workspace/deleted"], createdAt: 30, updatedAt: 40 },
    stale: { id: "stale", name: "Stale", rootPaths: ["/workspace/stale"], createdAt: 50, updatedAt: 60 },
  };
  f.data["app-server-project-id-by-legacy-project-id-by-host"][`local:${f.home}`] = { "legacy-a": "old-a", "legacy-b": "deleted-b" };
  f.data["project-order"] = ["legacy-b", "stale", "legacy-a"];
  f.data["pinned-project-ids"] = ["legacy-b", "legacy-a"];
  f.data["sidebar-project-thread-orders"].stale = { threadIds: ["thread-c"] };
  f.data["electron-saved-workspace-roots"] = ["/workspace/manager", "/workspace/kept"];
  f.data["electron-workspace-root-labels"] = { "/workspace/manager": "Manager", "/workspace/deleted": "Deleted" };
  f.data["project-appearances"] = { "legacy-a": { color: "old", marker: "old" }, "legacy-b": { color: "deleted" } };
  f.write();
  const projection = f.helper.desktopProjection([
    { id: "new-a", name: "PROJECT MANAGER", roots: [{ path: "/workspace/manager" }], metadata: { "appearance.color": "blue", "appearance.marker": JSON.stringify({ symbol: "star" }) } },
    { id: "project-new", name: "New Project", roots: [{ path: "/workspace/new" }], metadata: {} },
  ]);
  assert.ok(projection);
  assert.deepEqual(projection.projectIdMap, { "legacy-a": "new-a", "project-new": "project-new" });
  assert.deepEqual(projection.values["project-order"], ["legacy-a", "project-new"]);
  assert.deepEqual(projection.values["pinned-project-ids"], ["legacy-a"]);
  assert.deepEqual(Object.keys(projection.values["local-projects"]), ["legacy-a", "project-new"]);
  assert.deepEqual(projection.values["local-projects"]["legacy-a"], { id: "legacy-a", name: "PROJECT MANAGER", rootPaths: ["/workspace/manager"], createdAt: 10, updatedAt: 20 });
  assert.equal(projection.values["thread-project-assignments"]["thread-c"], undefined);
  assert.deepEqual(projection.values["electron-workspace-root-labels"], { "/workspace/manager": "Manager" });
  assert.deepEqual(projection.values["project-appearances"]["legacy-a"], { color: "blue", marker: { symbol: "star" } });
  assert.equal(projection.values["project-appearances"]["legacy-b"], undefined);
  assert.equal(f.helper.unresolvedMembershipCount(), 1);
});

test("desktop projection rejects malformed or ambiguous current native records", () => {
  for (const projects of [
    [{ id: "project-a", name: "A", roots: [{ path: "relative" }] }],
    [{ id: "project-a", name: "A", roots: [] }, { id: "project-a", name: "B", roots: [] }],
    [{ id: "project-a", name: "A", roots: [], metadata: { "appearance.color": "blue", "appearance.marker": "{" } }],
  ]) {
    const f = fixture();
    assert.equal(f.helper.desktopProjection(projects), null);
  }
});
