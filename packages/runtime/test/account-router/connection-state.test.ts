import assert from "node:assert/strict";
import test from "node:test";
import { AccountsBrokerOwnerV1 } from "../../src/account-router/broker-host";
import { AccountModelCatalogsV1 } from "../../src/account-router/models";

function fixture() {
  const host = Object.create(AccountsBrokerOwnerV1.prototype) as any;
  const account = "ar_connections", child = { ready: true };
  const calls: Array<{ method: string; params: any }> = [];
  let result: any = { data: [{ id: "installed-app", enabled: true }] };
  Object.assign(host, {
    closed: false, children: new Map([[account, child]]), secret: Buffer.alloc(32, 7),
    connectionTargets: new Map(), modelCatalogs: new AccountModelCatalogsV1(async () => null),
    requestBrokerChild: async (_account: string, selected: unknown, method: string, params: any) => {
      assert.equal(selected, child); calls.push({ method, params }); return { result };
    },
  });
  return { host, account, child, calls, setResult: (value: unknown) => { result = value; } };
}

test("account app status requests fresh provider state and explicit blockers win over Connected", async () => {
  const f = fixture();
  f.setResult({ data: [{ id: "disabled-app", status: "connected", isEnabled: false },
    { id: "inaccessible-app", enabled: true, isAccessible: false }] });
  const rows = await f.host.readProviderConnections(f.account, "app", f.child);
  assert.deepEqual(f.calls, [{ method: "app/installed", params: { forceRefresh: true } }]);
  assert.deepEqual(rows.map((row: any) => row.status), ["blocked", "blocked"]);
  f.setResult({ data: [{ name: "signed-out", status: "connected", authStatus: "notLoggedIn" }] });
  assert.equal((await f.host.readProviderConnections(f.account, "mcp", f.child))[0].status, "blocked");
});

test("late connection reads cannot publish handles after child or auth generation changes", async () => {
  for (const drift of ["child", "authentication"]) {
    const f = fixture();
    f.host.requestBrokerChild = async () => {
      if (drift === "child") f.host.children.set(f.account, { ready: true });
      else f.host.modelCatalogs.invalidate(f.account);
      return { result: { data: [{ id: "previous-account-app", enabled: true }] } };
    };
    assert.equal(await f.host.readProviderConnections(f.account, "app", f.child), null);
    assert.equal(f.host.connectionTargets.size, 0);
  }
});

test("stock MCP runtime state wins over credentials and stale Connected labels", async () => {
  const f = fixture();
  const states = ["connected", "starting", "failed", "unavailable", "cancelled", "disabled", "authenticationRequired", "notStarted", "futureState"];
  f.setResult({ data: states.map(runtimeStatus => ({ name: runtimeStatus, runtimeStatus,
    authStatus: "oAuth", enabled: true, status: "connected" })) });
  const rows = await f.host.readProviderConnections(f.account, "mcp", f.child);
  assert.deepEqual(rows.map((row: any) => row.status), ["connected", "connecting", "unavailable", "unavailable",
    "unavailable", "blocked", "blocked", "unknown", "unknown"]);
});

test("saved MCP auth and enablement cannot prove a connection without runtime evidence", async () => {
  const f = fixture();
  f.setResult({ data: [
    { name: "oauth", authStatus: "oAuth", enabled: true },
    { name: "bearer", authStatus: "bearerToken", callable: true },
    { name: "null-runtime", runtimeStatus: null, authStatus: "oAuth", enabled: true },
    { name: "legacy-explicit-status", status: "connected" },
  ] });
  const rows = await f.host.readProviderConnections(f.account, "mcp", f.child);
  assert.deepEqual(rows.map((row: any) => row.status), ["unknown", "unknown", "unknown", "connected"]);
});

test("a current empty connection list removes only the selected account and kind handles", async () => {
  const f = fixture();
  await f.host.readProviderConnections(f.account, "app", f.child);
  f.host.connectionTargets.set("ar_other\0app\0bd_other", { name: "other-account" });
  f.host.connectionTargets.set(`${f.account}\0mcp\0bd_mcp`, { name: "other-kind" });
  f.setResult({ data: [] });
  assert.deepEqual(await f.host.readProviderConnections(f.account, "app", f.child), []);
  assert.deepEqual([...f.host.connectionTargets.keys()], ["ar_other\0app\0bd_other", `${f.account}\0mcp\0bd_mcp`]);
});

test("authorization rejects a removed MCP definition before calling OAuth", async () => {
  const f = fixture();
  f.setResult({ data: [{ name: "removed-server", authStatus: "notLoggedIn" }] });
  const [row] = await f.host.readProviderConnections(f.account, "mcp", f.child);
  Object.assign(f.host, { remoteBlocksDesktop: () => false,
    broker: { acquireChild: () => f.child }, nativeHistory: null });
  f.setResult({ data: [] });
  assert.deepEqual(await f.host.dispatchDeviceAction({ kind: "connection.authorize", opaqueAccountId: f.account,
    connectionKind: "mcp", definitionRef: row.definitionRef }), { outcome: "rejected" });
  assert.equal(f.calls.some(call => call.method === "mcpServer/oauth/login"), false);
});

test("stock plugin connection definitions are shared while account handles and live app state remain separate", async () => {
  const f = fixture();
  f.setResult({ marketplaces: [{ name: "test", plugins: [{ id: "shared@test", installed: true, enabled: false }] }], marketplaceLoadErrors: [] });
  const first = await f.host.readProviderConnections(f.account, "plugin", f.child);
  const other = "ar_second", otherChild = { ready: true };
  f.host.children.set(other, otherChild);
  f.host.requestBrokerChild = async (account: string, selected: unknown, method: string) => {
    assert.equal(account, other); assert.equal(selected, otherChild); assert.equal(method, "plugin/installed");
    return { result: { marketplaces: [{ name: "test", plugins: [{ id: "shared@test", installed: true, enabled: true }] }], marketplaceLoadErrors: [] } };
  };
  const second = await f.host.readProviderConnections(other, "plugin", otherChild);
  assert.equal(first[0].status, "blocked");
  assert.equal(second[0].status, "connected");
  assert.notEqual(first[0].definitionRef, second[0].definitionRef);
  assert.equal(f.host.connectionTargets.size, 2);
});
