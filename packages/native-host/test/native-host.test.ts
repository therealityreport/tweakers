import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const hostPath = join(process.cwd(), "packages/native-host/dist/tweaker_native_host.node");

test("native host reports AppKit and Metal capabilities", { skip: process.platform !== "darwin" }, () => {
  assert.equal(existsSync(hostPath), true, "native host must be built before tests");
  const host = require(hostPath) as {
    getCapabilities(): Record<string, unknown>;
  };
  const capabilities = host.getCapabilities();
  assert.equal(capabilities.available, true);
  assert.equal(capabilities.appKitEmbedding, true);
  assert.equal(capabilities.childWindowOverlay, true);
  assert.equal(capabilities.directViewAttach, false);
  assert.equal(typeof capabilities.metalViews, "boolean");
});


test("Doctor attaches changelog rows before constraining them to the section", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  const attach = source.indexOf("[content addArrangedSubview:row];");
  const constrain = source.indexOf("[row.widthAnchor constraintEqualToAnchor:content.widthAnchor constant:-32].active = YES;");
  assert.notEqual(attach, -1);
  assert.notEqual(constrain, -1);
  assert.ok(attach < constrain, "a changelog row must share content's hierarchy before its cross-view width constraint activates");
});

test("Doctor keeps changelog-entry detail compact before the technical-group branch", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  const compactBranch = source.indexOf("if (!technicalGroup) {");
  const technicalGroups = source.indexOf("@\"TECHNICAL GROUPS\"");
  assert.notEqual(compactBranch, -1);
  assert.notEqual(technicalGroups, -1);
  assert.ok(source.indexOf("@\"COUPLED SCOPE\"", compactBranch) < technicalGroups);
  assert.ok(source.indexOf("return;", compactBranch) < technicalGroups, "changelog entries must return before technical-group detail");
});

test("Doctor reveals selected detail and keeps overview pending areas concise", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  assert.match(source, /revealSelectedChangeDetail[\s\S]*scrollRectToVisible/);
  assert.match(source, /selectChangelogEntry:[\s\S]*dispatch_async[\s\S]*revealSelectedChangeDetail/);
  assert.match(source, /technical area%@ still pending\. Open Inspect analysis groups and review decisions/);
  assert.doesNotMatch(source, /technical area%@ still pending: %@/);
});

test("Manager polls visible status, pauses on close, and preserves the current presentation", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  assert.match(source, /shouldRefreshRunningReview[\s\S]*execution.*running[\s\S]*state.*checking/);
  assert.match(source, /if \(!\[self shouldRefreshRunningReview\]\) return/);
  assert.match(source, /if \(!self.preserveStatusPresentation\) self.activityLabel.stringValue/);
  assert.match(source, /scheduledTimerWithTimeInterval:interval repeats:NO/);
  assert.match(source, /preserveStatusPresentation = YES[\s\S]*runCommand:@"doctor-status"/);
  assert.match(source, /preservedDetailScrollOrigin[\s\S]*restoreScrollView:detailScroll/);
  assert.match(source, /preservedTableScrollOrigin[\s\S]*restoreScrollView:tableScroll/);
  assert.match(source, /preservedTechnicalScrollOrigin[\s\S]*restoreScrollView:self\.technicalReportScroll/);
  assert.match(source, /restoreScrollView:[\s\S]*MAX\(0, MIN\(/);
  assert.match(source, /windowShouldClose[\s\S]*statusRefreshTimer invalidate[\s\S]*orderOut/);
});

test("Manager stacks evidence review on compact widths and restores nested scroll", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  assert.match(source, /configureReviewLayoutForPaneWidth:[\s\S]*paneWidth < 700/);
  assert.match(source, /reviewLayout\.orientation = vertical \? NSUserInterfaceLayoutOrientationVertical : NSUserInterfaceLayoutOrientationHorizontal/);
  assert.match(source, /reviewVerticalTableWidth[\s\S]*reviewVerticalDetailWidth[\s\S]*reviewVerticalDetailHeight/);
  assert.match(source, /sizeScrollableContent[\s\S]*configureReviewLayoutForPaneWidth:MAX\(0, width - 72\)[\s\S]*restoreScrollView:self\.reviewTableScroll[\s\S]*restoreScrollView:self\.reviewDetailScroll/);
});

test("Manager resolves sidebar layer color in its effective appearance", () => {
  const source = readFileSync(join(process.cwd(), "packages/native-host/src/tweakers_doctor.mm"), "utf8");
  assert.match(source, /updateSidebarBackground[\s\S]*effectiveAppearance performAsCurrentDrawingAppearance:[\s\S]*controlBackgroundColor\.CGColor/);
  assert.match(source, /viewDidChangeEffectiveAppearance[\s\S]*updateSidebarBackground/);
  assert.match(source, /viewDidMoveToWindow[\s\S]*updateSidebarBackground/);
  assert.match(source, /\[\(ManagerSidebarView \*\)self\.sidebar updateSidebarBackground\]/);
});

test("native host atomically exchanges two directory entries", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "tweakers-native-swap-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "value"), "first");
    writeFileSync(join(second, "value"), "second");
    const host = require(hostPath) as { swapDirectories(first: string, second: string): void };

    host.swapDirectories(first, second);

    assert.equal(readFileSync(join(first, "value"), "utf8"), "second");
    assert.equal(readFileSync(join(second, "value"), "utf8"), "first");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native thread lease excludes writers, preserves its inode, and releases idempotently", { skip: process.platform !== "darwin" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-native-lease-")));
  const name = "00000000-0000-4000-8000-000000000001.lock";
  const host = require(hostPath);
  const stat = lstatSync(root, { bigint: true });
  const lease = host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino));
  try {
    assert.equal(lease.isHeld(), true);
    assert.equal(host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino)), null);
    const blocked = spawnSync("python3", ["-c", "import sys,fcntl; f=open(sys.argv[1],'r+');\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(23)", join(root, name)]);
    assert.equal(blocked.status, 23, blocked.stderr.toString());
    assert.equal(String(lstatSync(join(root, name), { bigint: true }).ino), lease.ino);
    lease.release();
    lease.release();
    assert.equal(lease.isHeld(), false);
    assert.equal(existsSync(join(root, name)), true);
    const next = host.acquireNativeThreadWriterLease(root, name, String(stat.dev), String(stat.ino));
    assert.equal(next.ino, lease.ino);
    next.release();
  } finally { lease.release(); rmSync(root, { recursive: true, force: true }); }
});

test("native thread lease rejects unsafe bindings and detects replacement", { skip: process.platform !== "darwin" }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tweakers-native-lease-safety-")));
  const directory = join(root, "locks");
  mkdirSync(directory, { mode: 0o700 });
  const name = "00000000-0000-4000-8000-000000000001.lock";
  const host = require(hostPath);
  const stat = lstatSync(directory, { bigint: true });
  let lease: { release(): void; isHeld(): boolean } | null = null;
  try {
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), "0"));
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, "l".repeat(36) + ".lock", String(stat.dev), String(stat.ino)));
    writeFileSync(join(root, "target"), "");
    symlinkSync(join(root, "target"), join(directory, name));
    assert.throws(() => host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino)));
    rmSync(join(directory, name));
    lease = host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino));
    assert.equal(lease!.isHeld(), true);
    chmodSync(directory, 0o777);
    assert.equal(lease!.isHeld(), false);
    chmodSync(directory, 0o700);
    assert.equal(lease!.isHeld(), true);
    renameSync(join(directory, name), join(directory, "old.lock"));
    writeFileSync(join(directory, name), "", { mode: 0o600 });
    assert.equal(lease!.isHeld(), false);
    lease!.release();
    lease = host.acquireNativeThreadWriterLease(directory, name, String(stat.dev), String(stat.ino));
    renameSync(directory, join(root, "old-directory"));
    mkdirSync(directory, { mode: 0o700 });
    assert.equal(lease!.isHeld(), false);
  } finally { lease?.release(); rmSync(root, { recursive: true, force: true }); }
});
