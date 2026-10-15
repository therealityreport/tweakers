import assert from "node:assert/strict";
import test from "node:test";
import { nativeAccountsDesktopProjects } from "../src/codex-accounts-native-main";

test("explicit project write renews authority without its notification invalidating preparation", async () => {
  const values: Record<string, any> = {};
  const requests: unknown[] = [];
  let notify: (message: unknown) => void = () => {}, authenticated = true, updates = 0;
  const projection = { version: 1, source: "app_server", access: "read_only", authorityGeneration: 1,
    values: { "local-projects": { project: { id: "project", name: "Project", rootPaths: ["/fixture"], createdAt: 0, updatedAt: 0 } }, "project-appearances": {} },
    projectIdMap: { project: "native-project" } };
  const store = { get: (key: string) => values[key], getStored: (key: string) => values[key], set: (key: string, value: unknown) => { values[key] = value; } };
  const connection = { codexHome: async () => "/bound", registerInternalNotificationHandler: (fn: typeof notify) => { notify = fn; return () => {}; },
    sendAppServerRequest: async (_method: string, params: any) => {
      requests.push(params);
      // A real broker response arrives asynchronously; renewal broadcasts first.
      await Promise.resolve();
      if (params.prepareWrite) {
        projection.access = authenticated ? "read_write" : "read_only";
        projection.authorityGeneration++;
        notify({ method: "tweakers/desktopProjects/changed", params: { version: 1, access: projection.access, authorityGeneration: projection.authorityGeneration } });
      }
      return structuredClone(projection);
    } };
  const projects = nativeAccountsDesktopProjects({ enabled: () => true, onFocus: () => {} });
  const backend = { cache: { hostId: "local" }, globalState: store, connection, connected: false,
    legacyProjectIdsByServerId: new Map(), serverProjectsByLegacyId: new Map() };
  await projects.ensureBackend(backend, "/bound");
  assert.deepEqual(requests, [{}], "ordinary reads do not renew write authority");
  const save = async () => { await projects.ensureWrite(backend); updates++; store.set("project-appearances", { project: { color: "blue" } }); };
  await save();
  assert.deepEqual(requests, [{}, { prepareWrite: true }], "renewal notification coalesces with its in-flight preparation");
  assert.equal(updates, 1);
  assert.equal(store.get("project-appearances").project.color, "blue");
  const before = JSON.stringify(values);
  authenticated = false;
  await assert.rejects(save(), /read-only/);
  assert.equal(updates, 1);
  assert.equal(JSON.stringify(values), before, "failed auth cannot update appearance overrides");
});

for (const drift of ["revocation", "connection", "home"] as const) test(`project write rejects pending ${drift} drift`, async () => {
  const values: Record<string, any> = {};
  let notify: (message: any) => void = () => {}, resolveRead: (value: any) => void = () => {}, home = "/bound";
  let prepared: () => void = () => {};
  const started = new Promise<void>((resolve) => { prepared = resolve; });
  const projection = { version: 1, source: "app_server", access: "read_write", authorityGeneration: 2,
    values: { "local-projects": {}, "project-appearances": {} }, projectIdMap: {} };
  const store = { get: (key: string) => values[key], getStored: (key: string) => values[key], set: (key: string, value: unknown) => { values[key] = value; } };
  const connection = { codexHome: async () => home, registerInternalNotificationHandler: (fn: typeof notify) => { notify = fn; return () => {}; },
    sendAppServerRequest: async (_method: string, params: any) => {
      if (!params.prepareWrite) return structuredClone(projection);
      const pending = new Promise((resolve) => { resolveRead = resolve; });
      prepared(); return pending;
    } };
  const projects = nativeAccountsDesktopProjects({ enabled: () => true, onFocus: () => {} });
  const backend = { cache: { hostId: "local" }, globalState: store, connection, connected: false,
    legacyProjectIdsByServerId: new Map(), serverProjectsByLegacyId: new Map() };
  await projects.ensureBackend(backend, "/bound");
  const writing = projects.ensureWrite(backend);
  await started;
  if (drift === "revocation") {
    notify({ method: "tweakers/desktopProjects/changed", params: { version: 1, access: "read_write", authorityGeneration: 2 } });
    notify({ method: "tweakers/desktopProjects/changed", params: { version: 1, access: "read_only", authorityGeneration: 3 } });
  } else {
    if (drift === "connection") backend.connection = { ...connection, sendAppServerRequest: async () => structuredClone(projection) };
    else home = "/rebound";
    await projects.ensureBackend(backend, home);
  }
  resolveRead(structuredClone(projection));
  await assert.rejects(writing, /unavailable|changed|read-only/);
});
