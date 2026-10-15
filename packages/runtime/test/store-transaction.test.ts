import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hashStoreTree, installStoreTransaction, reconcileStoreTransactions, StoreTransactionError,
  type StoreTransactionOptions,
} from "../src/store-transaction";

function fixture(t: TestContext, installed = true) {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "tweakers-store-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const tweaksDir = join(base, "tweaks"); mkdirSync(tweaksDir);
  const id = "co.example.tweak", target = join(tweaksDir, id), calls: string[] = [];
  if (installed) { mkdirSync(target); writeFileSync(join(target, "index.js"), "previous"); }
  const options: StoreTransactionOptions = {
    tweaksDir, id,
    prepare: staging => { writeFileSync(join(staging, "index.js"), "replacement"); },
    assertUnchanged: () => { calls.push("assert"); },
    shutdown: () => { calls.push("shutdown"); },
    activate: () => { calls.push("activate"); },
    shutdownReplacement: () => { calls.push("shutdown-replacement"); },
    reactivatePrevious: () => { calls.push("reactivate-previous"); },
  };
  return { base, tweaksDir, id, target, calls, options, text: () => readFileSync(join(target, "index.js"), "utf8") };
}

async function failure(options: StoreTransactionOptions): Promise<StoreTransactionError> {
  try { await installStoreTransaction(options); } catch (error) {
    assert.ok(error instanceof StoreTransactionError); return error;
  }
  assert.fail("expected a failed store transaction");
}

test("publication commits only after activation and retains a verified previous tree outside discovery", async t => {
  const f = fixture(t), prior = hashStoreTree(f.target);
  const result = await installStoreTransaction({ ...f.options, activate: operationId => {
    assert.match(operationId, /^[0-9a-f-]+$/);
    assert.equal(f.text(), "replacement"); f.calls.push("activate");
  } });
  assert.equal(result.status, "committed");
  assert.equal(hashStoreTree(result.backupDir!), prior);
  assert.deepEqual(readdirSync(f.tweaksDir), [f.id]);
  assert.deepEqual(f.calls, ["assert", "shutdown", "assert", "activate"]);
  assert.equal(JSON.parse(readFileSync(join(result.transactionDir, "journal.json"), "utf8")).state, "committed");
  // A second update can retain its own backup without overwriting the first.
  const again = await installStoreTransaction(f.options);
  assert.notEqual(result.transactionDir, again.transactionDir);
  assert.equal(hashStoreTree(result.backupDir!), prior);
});

test("new installation and disabled no-op lifecycle ports are supported", async t => {
  const f = fixture(t, false);
  const result = await installStoreTransaction({ ...f.options, shutdown() {}, activate() {}, shutdownReplacement() {}, reactivatePrevious() {} });
  assert.equal(result.backupDir, null); assert.equal(f.text(), "replacement");
});

test("unknown approval metadata fails before shutdown or publication", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, assertUnchanged: () => { throw new Error("unknown metadata"); } });
  assert.equal(error.blocked, false); assert.equal(f.text(), "previous"); assert.deepEqual(f.calls, []);
});

test("uncertain shutdown never renames either tree and retains the journal", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, shutdown: () => { throw new Error("timed out"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "previous");
  assert.equal(readFileSync(join(error.transactionDir, "staging/index.js"), "utf8"), "replacement");
  assert.equal(existsSync(join(error.transactionDir, "backup")), false);
  assert.equal(existsSync(join(error.transactionDir, "journal.json")), true);
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir), { blockedIds: [], blockedAll: false, recoveredIds: [f.id] });
});

test("failed activation proves replacement shutdown before rollback and prior reactivation", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, activate: () => { f.calls.push("activate"); throw new Error("start failed"); },
    shutdownReplacement: () => { assert.equal(f.text(), "replacement"); f.calls.push("shutdown-replacement"); },
    reactivatePrevious: () => { assert.equal(f.text(), "previous"); f.calls.push("reactivate-previous"); } });
  assert.equal(error.blocked, false); assert.equal(f.text(), "previous");
  assert.deepEqual(f.calls, ["assert", "shutdown", "assert", "activate", "shutdown-replacement", "reactivate-previous"]);
  assert.equal(readFileSync(join(error.transactionDir, "rejected/index.js"), "utf8"), "replacement");
});

test("failed first installation restores absence and resumes the unaffected runtime", async t => {
  const f = fixture(t, false);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); } });
  assert.equal(error.blocked, false); assert.equal(existsSync(f.target), false);
  assert.equal(f.calls.includes("reactivate-previous"), true);
});

test("uncertain replacement shutdown preserves published target and backup until fresh recovery", async t => {
  const f = fixture(t), prior = hashStoreTree(f.target);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); },
    shutdownReplacement: () => { throw new Error("still running"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "replacement");
  assert.equal(hashStoreTree(join(error.transactionDir, "backup")), prior);
  assert.equal(f.calls.includes("reactivate-previous"), false);
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir), { blockedIds: [], blockedAll: false, recoveredIds: [f.id] });
  assert.equal(f.text(), "previous");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir), { blockedIds: [], blockedAll: false, recoveredIds: [] });
});

test("local edits during shutdown block publication and startup recovery", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, shutdown: () => { writeFileSync(join(f.target, "index.js"), "local edit"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "local edit");
  assert.equal(existsSync(join(error.transactionDir, "backup")), false);
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir), { blockedIds: [f.id], blockedAll: false, recoveredIds: [] });
  assert.equal(f.text(), "local edit");
});

test("replacement edits after failed activation prevent destructive rollback", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, activate: () => { writeFileSync(join(f.target, "index.js"), "replacement edit"); throw new Error("start failed"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "replacement edit");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).blockedIds, [f.id]);
  assert.equal(readFileSync(join(error.transactionDir, "backup/index.js"), "utf8"), "previous");
});

test("prior reactivation failure retains the restored tree and blocks admission", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); },
    reactivatePrevious: () => { throw new Error("prior runtime uncertain"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "previous");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).recoveredIds, [f.id]);
});

test("startup recovers a crash after the old-to-backup rename and before staged publication", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, shutdown: () => { throw new Error("crash simulation"); } });
  const journalFile = join(error.transactionDir, "journal.json"), journal = JSON.parse(readFileSync(journalFile, "utf8"));
  journal.state = "publishing"; writeFileSync(journalFile, JSON.stringify(journal));
  renameSync(f.target, join(error.transactionDir, "backup"));
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).recoveredIds, [f.id]);
  assert.equal(f.text(), "previous");
});

test("startup can finish rollback interrupted after moving the replacement aside", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); },
    shutdownReplacement: () => { throw new Error("uncertain"); } });
  renameSync(f.target, join(error.transactionDir, "rejected"));
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).recoveredIds, [f.id]);
  assert.equal(f.text(), "previous");
});

test("startup holds a corrupted backup without moving the replacement", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); },
    shutdownReplacement: () => { throw new Error("uncertain"); } });
  writeFileSync(join(error.transactionDir, "backup/index.js"), "backup edit");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).blockedIds, [f.id]);
  assert.equal(f.text(), "replacement");
  assert.equal(existsSync(join(error.transactionDir, "rejected")), false);
});

test("startup restores absence for an interrupted new install after runtime uncertainty", async t => {
  const f = fixture(t, false);
  const error = await failure({ ...f.options, activate: () => { throw new Error("start failed"); },
    shutdownReplacement: () => { throw new Error("uncertain"); } });
  assert.equal(error.blocked, true); assert.equal(f.text(), "replacement");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).recoveredIds, [f.id]);
  assert.equal(existsSync(f.target), false);
});

test("committed history never overwrites subsequent local edits", async t => {
  const f = fixture(t); await installStoreTransaction(f.options);
  writeFileSync(join(f.target, "index.js"), "local edit");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir), { blockedIds: [], blockedAll: false, recoveredIds: [] });
  assert.equal(f.text(), "local edit");
});

test("fresh startup without tweaks or transaction storage has no recovery work", t => {
  const f = fixture(t);
  assert.deepEqual(reconcileStoreTransactions(join(f.base, "not-created")), { blockedIds: [], blockedAll: false, recoveredIds: [] });
});

test("unsafe IDs and symlink targets or staged entries are rejected", async t => {
  const f = fixture(t);
  for (const id of ["../outside", ".", "..", "co..example", "a/b", "a\\b"]) await assert.rejects(installStoreTransaction({ ...f.options, id }), /Unsafe/);
  const linked = fixture(t, false), outside = join(linked.base, "outside"); mkdirSync(outside);
  symlinkSync(outside, linked.target);
  await assert.rejects(installStoreTransaction(linked.options), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
  const staged = fixture(t);
  const error = await failure({ ...staged.options, prepare: directory => { symlinkSync(join(staged.target, "index.js"), join(directory, "index.js")); } });
  assert.equal(error.blocked, false); assert.equal(staged.text(), "previous");
});

test("malformed journals and symlink transaction paths block without external writes", async t => {
  const f = fixture(t);
  const error = await failure({ ...f.options, shutdown: () => { throw new Error("uncertain"); } });
  writeFileSync(join(error.transactionDir, "journal.json"), "{}");
  assert.deepEqual(reconcileStoreTransactions(f.tweaksDir).blockedIds, [f.id]);
  const root = dirname(error.transactionDir), external = join(f.base, "external"); mkdirSync(external);
  symlinkSync(external, join(root, "unknown"));
  assert.equal(reconcileStoreTransactions(f.tweaksDir).blockedAll, true);
  assert.deepEqual(readdirSync(external), []);
});

test("exclusive per-ID lock rejects overlapping installs", async t => {
  const f = fixture(t);
  let resume!: () => void;
  const pending = new Promise<void>(resolve => { resume = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = installStoreTransaction({ ...f.options, shutdown: async () => { entered(); await pending; } });
  await started;
  await assert.rejects(installStoreTransaction(f.options), /EEXIST/);
  resume(); await first; assert.equal(f.text(), "replacement");
});
