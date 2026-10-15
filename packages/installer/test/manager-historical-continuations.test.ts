import assert from "node:assert/strict";
import test from "node:test";
import type { TweakersManagerPreparedOperationV1 } from "../src/manager-contract.js";
import { historicalContinuationMatches, historicalLoadedJobCommand, parseHistoricalLaunchServices, assertHistoricalPromotionAdmissionRecord } from "../src/manager-historical-continuations.js";
import type { HistoricalManagerObservedOperation } from "../src/manager-historical-reconciliation.js";

const root = "/Users/test/Library/Application Support/Tweakers";
const operationId = "11111111-1111-4111-8111-111111111111";
const moduleParent = `${root}/managers/com.thomashulihan.tweakers/generations/${"a".repeat(64)}`;
const record: TweakersManagerPreparedOperationV1 = {
  schemaVersion: 1, kind: "tweakers-manager-operation", managerId: "com.thomashulihan.tweakers", protocolVersion: 1,
  operationId, preparedRequestId: operationId, actionId: "refresh.independent",
  moduleIdentity: { state: "resolved", path: `${moduleParent}/Tweakers Manager Launcher`, sha256: "b".repeat(64) },
  boundStateToken: `sha256:${"c".repeat(64)}`, parameters: {}, parametersSha256: `sha256:${"d".repeat(64)}`, impact: "restart-app",
  createdAt: "2026-09-03T00:00:00.000Z", expiresAt: "2026-09-03T00:05:00.000Z", phase: "recovery-required",
  consumedAt: "2026-09-03T00:00:01.000Z", cancelledAt: null, completedAt: null, failedAt: null,
  recoveryRequiredAt: "2026-09-03T00:00:02.000Z", stateTokenInputsSha256: `sha256:${"e".repeat(64)}`,
  receiptChronologyRevision: `sha256:${"f".repeat(64)}`, receiptSnapshot: [], receiptRefs: ["independent-tweakers-patch:1.0.0"],
  outcome: null, error: "Historical outcome unknown",
};
const operations: HistoricalManagerObservedOperation[] = [{ record, rawText: JSON.stringify(record) }];

test("accepted runtime repair historical admission requires authenticated committed settled child and retains unrelated holds",()=>{
  const journal={id:operationId,phase:"app:promoted",acceptedBackendTransition:{operationId}};
  let calls=0;
  assert.doesNotThrow(()=>assertHistoricalPromotionAdmissionRecord(journal,`${operationId}.json`,undefined,(promotion,operation)=>{
    calls++;assert.equal(promotion,operationId);assert.equal(operation,operationId);return true;
  }));
  assert.equal(calls,1);
  assert.throws(()=>assertHistoricalPromotionAdmissionRecord(journal,`${operationId}.json`,undefined,()=>false),/blocks historical/);
  assert.throws(()=>assertHistoricalPromotionAdmissionRecord(journal,`${operationId}.json`,undefined,()=>{throw new Error("immutable child signature changed");}),/signature changed/);
  for(const changed of [{...journal,phase:"runtime:promoted"},{...journal,acceptedBackendTransition:null},{...journal,acceptedBackendTransition:{operationId:4}}])
    assert.throws(()=>assertHistoricalPromotionAdmissionRecord(changed,`${operationId}.json`,undefined,()=>{throw new Error("must not authenticate unrelated journal");}),/blocks historical/);
  assert.throws(()=>assertHistoricalPromotionAdmissionRecord(journal,"foreign.json",operationId,()=>true),/blocks historical/);
  assert.throws(()=>assertHistoricalPromotionAdmissionRecord({...journal,phase:"prepared"},`${operationId}.json`,undefined,()=>true),/blocks historical/);
  assert.doesNotThrow(()=>assertHistoricalPromotionAdmissionRecord({...journal,phase:"prepared"},`${operationId}.json`,operationId,()=>{throw new Error("ordinary allowed preparation changed");}));
});
const matches = (kind: "process" | "job", command: string) => historicalContinuationMatches(root, operations, { kind, identity: "generic-service", command });
const domain = "gui/501";
function census(rows: string[], selectedDomain = domain): string {
  return `${selectedDomain} = {\n\ttype = login\n\tservices = {\n${rows.map(row => `\t\t${row}`).join("\n")}\n\t}\n}\n`;
}

test("old operation UUID identifies a continuation despite a generic executable or job label", () => {
  assert.equal(matches("process", `/usr/bin/node /unrelated/worker.mjs --operation ${operationId}`), true);
  assert.equal(matches("job", `gui/501/generic-service = {\n arguments = { /usr/bin/node --operation ${operationId} }\n}`), true);
  assert.equal(matches("process", "/usr/bin/node /unrelated/worker.mjs --operation 22222222-2222-4222-8222-222222222222"), false);
});

test("old module parent identifies sibling manager helpers as well as the original launcher", () => {
  assert.equal(matches("process", `${record.moduleIdentity.path} refresh.independent`), true);
  assert.equal(matches("process", `/usr/bin/node '${moduleParent}/helper.mjs'`), true);
  assert.equal(matches("job", `gui/501/generic-service = { working directory = ${moduleParent} }`), true);
  const oldParent = "/retired/independent-manager-generation";
  const oldRecord = { ...record, moduleIdentity: { ...record.moduleIdentity, path: `${oldParent}/Tweakers Manager Launcher` } };
  const ownOperations = [{ record: oldRecord, rawText: JSON.stringify(oldRecord) }];
  for (const kind of ["process", "job"] as const) {
    assert.equal(historicalContinuationMatches(root, ownOperations, { kind, identity: "generic-service", command: `/usr/bin/node ${oldParent}/sibling-helper.mjs` }), true,
      "module-parent matching also works independently of generic managed-root matching");
  }
});

test("generic transaction and manager/runtime helper paths identify continuations without old UUIDs", () => {
  for (const path of [
    `${root}/transactions/unlabelled-task.json`,
    `${root}/managers/helper/worker.mjs`,
    `${root}/runtime/dist/cli.js`,
  ]) {
    assert.equal(matches("process", `/usr/bin/node '${path}'`), true, path);
    assert.equal(matches("job", `generic-service = { program arguments = { /usr/bin/node ${path} } }`), true, path);
  }
  assert.equal(matches("job", `generic-service = { environment = { SUPPORT_ROOT = ${root} } }`), true,
    "a job can preserve the support root in its environment or working directory");
});

test("legacy support roots identify processes and generic loaded or persisted jobs", () => {
  for (const legacy of ["codex-plusplus", "Codex++"]) {
    const path = `/Users/test/Library/Application Support/${legacy}/runtime/worker.mjs`;
    assert.equal(matches("process", `/usr/bin/node '${path}'`), true, legacy);
    assert.equal(matches("job", JSON.stringify({ Label: "generic-service", ProgramArguments: ["/usr/bin/node", path] })), true, legacy);
  }
});

test("unrelated native Codex and ChatGPT process and launch-job observations remain unaffected", () => {
  for (const command of [
    "/Applications/Codex.app/Contents/MacOS/Codex --profile default",
    "/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper",
    "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
    JSON.stringify({ Label: "com.openai.codex", ProgramArguments: ["/Applications/Codex.app/Contents/MacOS/Codex"], EnvironmentVariables: { CODEX_HOME: "/Users/test/.codex" } }),
  ]) {
    assert.equal(matches("process", command), false, command);
    assert.equal(matches("job", command), false, command);
  }
});

test("launch service census accepts current macOS pe, jt, dash and integer markers", () => {
  const rows = ["0 (pe) com.example.one", "4321 (jt) com.example.two", "0 - com.example.three",
    "1234 0 com.example.four", "0 -15 com.example.five", "0 12 application.example.123.456"];
  assert.deepEqual(parseHistoricalLaunchServices(census(rows), domain), [
    "com.example.one", "com.example.two", "com.example.three", "com.example.four", "com.example.five", "application.example.123.456",
  ]);
  for (const selectedDomain of ["user/501", "system"]) {
    assert.deepEqual(parseHistoricalLaunchServices(census(["0 (pe) com.example.one"], selectedDomain), selectedDomain), ["com.example.one"]);
  }
});

test("missing, wrong-domain and malformed launch census evidence rejects rather than reporting no jobs", () => {
  for (const text of ["", "not a census", `${domain} = {\n\ttype = login\n}\n`, census(["0 - com.example.one"], "gui/502")]) {
    assert.throws(() => parseHistoricalLaunchServices(text, domain), /domain|missing|malformed/);
  }
  for (const row of ["not-a-pid - com.example.one", "0 unexpected com.example.one", "0 (PE) com.example.one",
    "0 -", "0 - com.example.one extra", "0 - com.example.one\ninvalid-row"]) {
    assert.throws(() => parseHistoricalLaunchServices(census([row]), domain), /malformed/, row);
  }
});

test("truncated outer launch domain document is not a complete service census", () => {
  const complete = census(["0 (pe) com.example.one"]);
  assert.throws(() => parseHistoricalLaunchServices(complete.slice(0, -2), domain), /malformed|incomplete|domain/);
});

test("shell-escaped and JSON-encoded old paths cannot hide a continuation", () => {
  const escaped = moduleParent.replaceAll(" ", "\\ ");
  assert.equal(matches("process", `/bin/sh -c node ${escaped}/helper.mjs`), true);
  assert.equal(matches("job", JSON.stringify({ ProgramArguments: ["/bin/sh", "-c", `node ${escaped}/helper.mjs`] })), true);
  assert.equal(matches("process", `/usr/bin/node '${root}/managed-runtime/current/packages/installer/dist/cli.js' refresh`), true);
});

test("empty launch service inventory is a valid complete observation", () => {
  assert.deepEqual(parseHistoricalLaunchServices(`${domain} = {\n\tservices = {\n\t}\n}\n`, domain), []);
});

test("supported watcher loaded arguments do not excuse a generic worker in its environment", async () => {
  const { loadedHistoricalWatcherMatches } = await import("../src/manager-historical-continuations.js");
  const path = "/Users/test/Library/LaunchAgents/com.therealityreport.tweakers.watcher.plist";
  const args = ["/bin/sh", "-c", `node '${root}/managed-runtime/current/cli.js' watcher-run`];
  const detail = `gui/501/com.therealityreport.tweakers.watcher = {\n\tpath = ${path}\n\tprogram = /bin/sh\n\targuments = {\n${args.map(arg => `\t\t${arg}`).join("\n")}\n\t}\n}\n`;
  assert.equal(loadedHistoricalWatcherMatches(root, operations, detail, path, { ProgramArguments: args }), true);
  const malicious = detail.replace(/\n}\n$/, `\n\tenvironment = {\n\t\tNODE_OPTIONS => --require ${root}/transactions/unlabelled-worker.cjs\n\t}\n}\n`);
  assert.equal(loadedHistoricalWatcherMatches(root, operations, malicious, path, { ProgramArguments: args }), false);
  assert.equal(loadedHistoricalWatcherMatches(root, operations, detail.replace("watcher-run", "refresh"), path, { ProgramArguments: args }), false);
});

test("scope exclusion requires an unreadable non-user-writable root-owned system daemon", async () => {
  const { historicalDaemonOutsidePublicationScope } = await import("../src/manager-historical-continuations.js");
  const boundary = { directory: "/Library/LaunchDaemons", regular: true, canonical: true, uid: 0, mode: 0o700,
    parentRootOwned: true, readable: false, writable: false, parentWritable: false };
  assert.equal(historicalDaemonOutsidePublicationScope(boundary), true);
  for (const change of [{ directory: "/Library/LaunchAgents" }, { directory: "/Users/test/Library/LaunchAgents" },
    { uid: 501 }, { mode: 0o722 }, { regular: false }, { canonical: false }, { parentRootOwned: false },
    { readable: true }, { writable: true }, { parentWritable: true }]) {
    assert.equal(historicalDaemonOutsidePublicationScope({ ...boundary, ...change }), false);
  }
  // The boundary never exempts a loaded job from the normal matching census.
  assert.equal(matches("job", `system/vendor-job = { arguments = { --operation ${operationId} } }`), true);
});


test("System Events inert fixture inheritance cannot hide executable or historical references", () => {
  const name = "gui/501/application.com.apple.systemevents.123.456";
  const executable = "/System/Library/CoreServices/System Events.app/Contents/MacOS/System Events";
  const detail = `${name} = {\n\tprogram = ${executable}\n\targuments = {\n\t\t${executable}\n\t}\n\tenvironment = {\n\t\tTWEAKERS_TEST_20156_ASAR => ${root}/official-source/baselines/22222222-2222-4222-8222-222222222222/resources/app.asar\n\t}\n}`;
  assert.equal(matches("job", historicalLoadedJobCommand(root, operations, name, detail)), false);
  for (const [job, text] of [
    ["gui/501/generic", detail],
    [name, detail.replace(`program = ${executable}`, "program = /usr/bin/node")],
    [name, detail.replace(`${executable}\n\t}`, `${executable}\n\t\t${root}/worker.js\n\t}`)],
    [name, detail.replace("\tenvironment = {", `\tworking directory = ${root}\n\tenvironment = {`)],
    [name, detail.replace("\tenvironment = {", `\toperation = ${operationId}\n\tenvironment = {`)],
    [name, detail.replace("TWEAKERS_TEST_20156_ASAR", "NODE_OPTIONS")],
    [name, detail.replace("/official-source/baselines/", "/transactions/")],
  ]) assert.equal(matches("job", historicalLoadedJobCommand(root, operations, job!, text!)), true);
});
