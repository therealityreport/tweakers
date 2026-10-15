import assert from "node:assert/strict";
import test from "node:test";
import { AccountModelCatalogsV1, parseModelCatalogV1 } from "../../src/account-router/models";
import { AccountsBrokerOwnerV1 } from "../../src/account-router/broker-host";
import type { OpaqueAccountId } from "../../src/account-router/types";

const a = "ar_catalog_a" as OpaqueAccountId;
const b = "ar_catalog_b" as OpaqueAccountId;
const catalog = (id: string) => ({ data: [{ id }] });

test("catalog invalidation refreshes the affected account while preserving other account caches", async () => {
  const calls = new Map<OpaqueAccountId, number>();
  let current = "upstream-old";
  const catalogs = new AccountModelCatalogsV1(async account => {
    calls.set(account, (calls.get(account) ?? 0) + 1);
    return catalog(account === a ? current : "upstream-other");
  });
  assert.deepEqual([...(await catalogs.support(current, [a, b])).eligible], [a]);
  current = "upstream-new";
  catalogs.invalidate(a);
  const fresh = await catalogs.support(current, [a, b]);
  assert.deepEqual([...fresh.eligible], [a]);
  assert.deepEqual([...fresh.unsupported], [b]);
  assert.deepEqual([...calls.values()], [2, 1]);
  catalogs.invalidate();
  await catalogs.support(current, [a, b]);
  assert.deepEqual([...calls.values()], [3, 2]);
});

test("revoked catalog reads cannot repopulate the cache or remove a replacement in-flight read", async () => {
  const pending: Array<(value: unknown) => void> = [];
  const catalogs = new AccountModelCatalogsV1(() => new Promise(resolve => pending.push(resolve)));
  const stale = catalogs.support("old", [a]);
  await Promise.resolve();
  catalogs.invalidate(a);
  const fresh = catalogs.support("new", [a]);
  await Promise.resolve();
  pending[0]!(catalog("old"));
  assert.equal((await stale).native, false);
  const shared = catalogs.support("new", [a]);
  await Promise.resolve();
  assert.equal(pending.length, 2, "old finally must not delete the new flight");
  pending[1]!(catalog("new"));
  assert.equal((await fresh).native, true);
  assert.equal((await shared).native, true);
  assert.equal((await catalogs.support("old", [a])).native, false);
  assert.equal(pending.length, 2, "old response must not replace the fresh cache");
});

test("catalog parsing preserves upstream model identifiers and rejects unavailable payloads", () => {
  assert.deepEqual([...parseModelCatalogV1(catalog("provider/custom:exact-id"))!], ["provider/custom:exact-id"]);
  assert.equal(parseModelCatalogV1(undefined), null);
  assert.equal(parseModelCatalogV1({ data: [{ id: "bad\nmodel" }] }), null);
});

test("broker catalog pages use one authenticated child and reject policy or backend drift", async () => {
  for (const drift of ["none", "authentication", "backend", "policy"]) {
    const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
    const child = { ready: true };
    const calls: Array<{ method: string; params: unknown }> = [];
    Object.assign(host, {
      children: new Map([[a, child]]), broker: { acquireChild: () => child }, initializeChild: async () => true,
      modelCatalogs: new AccountModelCatalogsV1(async () => catalog("unused")),
      requestBrokerChild: async (account: string, selected: unknown, method: string, params: any) => {
        assert.equal(account, a); assert.equal(selected, child); calls.push({ method, params });
        if (method === "account/read") return { result: { account: { authenticated: drift !== "authentication" } } };
        if (drift === "backend") host.children.set(a, { ready: true });
        if (drift === "policy") host.modelCatalogs.invalidate();
        return { result: params.cursor ? { data: [{ id: "second-native" }], nextCursor: null }
          : { data: [{ id: "first-native" }], nextCursor: "page-two" } };
      },
    });
    if (drift === "none") {
      assert.deepEqual(await host.readAccountModels(a), { data: [{ id: "first-native" }, { id: "second-native" }], nextCursor: null });
      assert.deepEqual(calls, [{ method: "account/read", params: { refreshToken: false } },
        { method: "model/list", params: { includeHidden: true, cursor: null, limit: 100 } },
        { method: "model/list", params: { includeHidden: true, cursor: "page-two", limit: 100 } }]);
    } else {
      await assert.rejects(host.readAccountModels(a));
      if (drift === "authentication") assert.equal(calls.length, 1, "signed-out catalogs are never read");
    }
  }
});

test("only current backend authentication notifications invalidate eligibility", async () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const child = {};
  const catalogs = new AccountModelCatalogsV1(async () => catalog("native"));
  Object.assign(host, { children: new Map([[a, child]]), nativeHistory: null, modelCatalogs: catalogs,
    appToolsRebindObservations: new WeakMap(), taskRefsByThread: new Map(), clients: new Map() });
  const notification = { jsonrpc: "2.0", method: "account/updated", params: { account: null } };
  host.routeChildNotification(a, notification, {});
  assert.equal(catalogs.revision, 0);
  host.routeChildNotification(a, notification, child);
  assert.equal(catalogs.revision, 1);
});

test("invalidating account A during account B pagination cannot cache B as unknown", async () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const child = { ready: true };
  let pages = 0, reads = 0;
  let releasePage!: (value: unknown) => void;
  let enteredPage!: () => void;
  const pageEntered = new Promise<void>(resolve => { enteredPage = resolve; });
  const delayedPage = new Promise(resolve => { releasePage = resolve; });
  const catalogs = new AccountModelCatalogsV1(async account => {
    if (account === a) return catalog("selected-native");
    reads++; return host.readAccountModels(b);
  });
  Object.assign(host, {
    children: new Map([[b, child]]), broker: { acquireChild: () => child }, initializeChild: async () => true,
    modelCatalogs: catalogs,
    requestBrokerChild: async (_account: string, _child: unknown, method: string, params: any) => {
      if (method === "account/read") return { result: { account: { authenticated: true } } };
      pages++;
      if (pages === 2) { enteredPage(); return delayedPage; }
      return { result: params.cursor ? { data: [{ id: "other-second" }], nextCursor: null }
        : { data: [{ id: "other-first" }], nextCursor: "page-two" } };
    },
  });
  const obsolete = catalogs.support("selected-native", [a, b]);
  await pageEntered;
  catalogs.invalidate(a);
  releasePage({ result: { data: [{ id: "other-second" }], nextCursor: null } });
  assert.equal((await obsolete).native, false);
  const fresh = await catalogs.support("selected-native", [a, b]);
  assert.deepEqual([...fresh.eligible], [a]);
  assert.deepEqual([...fresh.unsupported], [b], "B must be read again rather than cached as eligible unknown");
  assert.equal(reads, 2); assert.equal(pages, 4);
});

test("a native model hidden in A and visible in B remains eligible in both authoritative catalogs", async () => {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const children = new Map([[a, { ready: true }], [b, { ready: true }]]);
  const pages: Array<{ account: OpaqueAccountId; params: any }> = [];
  const catalogs = new AccountModelCatalogsV1(account => host.readAccountModels(account));
  Object.assign(host, {
    children, broker: { acquireChild: (account: OpaqueAccountId) => children.get(account) },
    initializeChild: async () => true, modelCatalogs: catalogs,
    requestBrokerChild: async (account: OpaqueAccountId, child: unknown, method: string, params: any) => {
      assert.equal(child, children.get(account), "every page stays on the requested authenticated account");
      if (method === "account/read") return { result: { account: { authenticated: true } } };
      pages.push({ account, params });
      if (params.cursor === null) return { result: { data: [{ id: "other-native", hidden: false }], nextCursor: "page-two" } };
      const hidden = account === a;
      return { result: { data: hidden && !params.includeHidden ? [] : [{ id: "selected-native", hidden }], nextCursor: null } };
    },
  });
  const support = await catalogs.support("selected-native", [a, b]);
  assert.equal(support.native, true);
  assert.deepEqual([...support.eligible], [a, b]);
  assert.equal(support.unsupported.size, 0, "picker visibility cannot deny legitimate account support");
  assert.equal(pages.length, 4);
  for (const account of [a, b]) assert.deepEqual(pages.filter(page => page.account === account).map(page => page.params), [
    { includeHidden: true, cursor: null, limit: 100 },
    { includeHidden: true, cursor: "page-two", limit: 100 },
  ]);
});
