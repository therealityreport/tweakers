import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  beginWatcherPromotion,
  finishWatcherPromotion,
  readWatcherPromotionReceipt,
  recoverWatcherPromotion,
  writeWatcherPromotionReceipt,
  type WatcherPromotionReceipt,
} from "../src/watcher-promotion.js";
import type { WatcherPromotionSnapshot } from "../src/watcher.js";

const snapshot: WatcherPromotionSnapshot = {
  schemaVersion: 1,
  kind: "watcher-promotion-snapshot",
  watcherKind: "launchd",
  configured: true,
  loaded: true,
  enabled: true,
  definitionPath: "/tmp/com.therealityreport.tweakers.watcher.plist",
  definitionDigest: "definition-sha256",
  capturedAt: "2026-07-19T20:00:00.000Z",
};

test("watcher promotion durably pauses before cutover and resumes only for exact target evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-watcher-promotion-"));
  const file = join(root, "environment-watcher.json");
  const events: string[] = [];
  try {
    const paused = beginWatcherPromotion(file, {
      transactionId: "environment-1",
      sourceAppRoot: "/Applications/ChatGPT.app",
      requestedAppRoot: "/Applications/ChatGPT (Beta).app",
      sourceExpectedFingerprint: "source-sha256",
    }, {
      now: () => "2026-07-19T20:00:01.000Z",
      capture: () => snapshot,
      pause: () => {
        events.push("pause");
        assert.equal(readWatcherPromotionReceipt(file)?.phase, "pausing");
      },
    });
    assert.equal(paused.phase, "paused");
    assert.equal(paused.snapshot.definitionDigest, "definition-sha256");

    const resumed = finishWatcherPromotion(file, {
      transactionId: "environment-1",
      targetAppRoot: "/Applications/ChatGPT (Beta).app",
      targetExpectedFingerprint: "candidate-sha256",
    }, {
      now: () => "2026-07-19T20:00:02.000Z",
      resume: (appRoot) => {
        events.push(`resume:${appRoot}`);
        const inFlight = readWatcherPromotionReceipt(file);
        assert.equal(inFlight?.phase, "resuming");
        assert.equal(inFlight?.targetExpectedFingerprint, "candidate-sha256");
      },
    });
    assert.equal(resumed.phase, "resumed");
    assert.deepEqual(events, ["pause", "resume:/Applications/ChatGPT (Beta).app"]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).phase, "resumed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted watcher pausing is recovered idempotently from its durable snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-watcher-recovery-"));
  const file = join(root, "environment-watcher.json");
  const pausing: WatcherPromotionReceipt = {
    schemaVersion: 1,
    kind: "watcher-promotion",
    transactionId: "environment-recovery",
    phase: "pausing",
    sourceAppRoot: "/Applications/ChatGPT.app",
    requestedAppRoot: "/Applications/ChatGPT.app",
    activeTargetAppRoot: null,
    sourceExpectedFingerprint: "source-sha256",
    targetExpectedFingerprint: null,
    snapshot,
    createdAt: "2026-07-19T20:00:00.000Z",
    updatedAt: "2026-07-19T20:00:00.000Z",
    pausedAt: null,
    resumedAt: null,
    error: null,
  };
  let pauses = 0;
  try {
    writeWatcherPromotionReceipt(file, pausing);
    const recovered = recoverWatcherPromotion(file, {
      now: () => "2026-07-19T20:00:01.000Z",
      pause: () => { pauses += 1; },
    });
    assert.equal(recovered?.phase, "paused");
    assert.equal(pauses, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed watcher pause is durable and fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-watcher-pause-fail-"));
  const file = join(root, "environment-watcher.json");
  try {
    assert.throws(() => beginWatcherPromotion(file, {
      transactionId: "environment-fail",
      sourceAppRoot: "/Applications/ChatGPT.app",
      requestedAppRoot: "/Applications/ChatGPT.app",
      sourceExpectedFingerprint: "source-sha256",
    }, {
      capture: () => snapshot,
      pause: () => { throw new Error("launchd still loaded"); },
    }), /Could not pause watcher for promotion: launchd still loaded/);
    const failed = readWatcherPromotionReceipt(file);
    assert.equal(failed?.phase, "failed");
    assert.equal(failed?.error, "launchd still loaded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed resume can be quiesced again for exact rollback", () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-watcher-resume-rollback-"));
  const file = join(root, "environment-watcher.json");
  let pauses = 0;
  try {
    beginWatcherPromotion(file, {
      transactionId: "environment-resume-fail",
      sourceAppRoot: "/Applications/ChatGPT.app",
      requestedAppRoot: "/Applications/ChatGPT (Beta).app",
      sourceExpectedFingerprint: "source-sha256",
    }, { capture: () => snapshot, pause: () => { pauses += 1; } });
    assert.throws(() => finishWatcherPromotion(file, {
      transactionId: "environment-resume-fail",
      targetAppRoot: "/Applications/ChatGPT (Beta).app",
      targetExpectedFingerprint: "candidate-sha256",
    }, { resume: () => { throw new Error("bootstrap failed"); } }), /bootstrap failed/);
    assert.equal(readWatcherPromotionReceipt(file)?.phase, "failed");

    const repaused = beginWatcherPromotion(file, {
      transactionId: "environment-resume-fail",
      sourceAppRoot: "/Applications/ChatGPT.app",
      requestedAppRoot: "/Applications/ChatGPT (Beta).app",
      sourceExpectedFingerprint: "source-sha256",
    }, { pause: () => { pauses += 1; } });
    assert.equal(repaused.phase, "paused");
    assert.equal(pauses, 2);

    const rolledBack = finishWatcherPromotion(file, {
      transactionId: "environment-resume-fail",
      targetAppRoot: "/Applications/ChatGPT.app",
      targetExpectedFingerprint: "source-sha256",
    }, { resume: () => {} });
    assert.equal(rolledBack.phase, "resumed");
    assert.equal(rolledBack.activeTargetAppRoot, "/Applications/ChatGPT.app");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
