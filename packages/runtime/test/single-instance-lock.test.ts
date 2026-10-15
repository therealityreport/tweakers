import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const mainSource = readFileSync(resolve("packages/runtime/src/main.ts"), "utf8");

test("runtime requests a single instance and focuses the primary window", () => {
  assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
  assert.match(mainSource, /app\.on\("second-instance"/);
});

test("derived Tweakers health probes share the user-wide desktop lock before broker startup", () => {
  const start = mainSource.indexOf('const desktopLockPath =');
  const end = mainSource.indexOf('const accountsBrokerRootResolution =');
  assert.ok(start > 0 && end > start);
  const locking = mainSource.slice(start, end);
  assert.match(locking, /userInfo\(\)\.homedir/);
  assert.match(locking, /acquireProcessLock\(desktopLockPath/);
  assert.match(locking, /identity\.startedAt === processStart\(owner\)/);
  assert.match(locking, /app\.exit\(healthCheckOnly \? 1 : 0\)/);
  assert.match(locking, /if \(!verifiedOwner\) throw new Error/);
  assert.ok(locking.indexOf('acquireProcessLock') < locking.indexOf('if (!healthCheckOnly'));
});

test("native Electron single-instance behavior remains separate from derived Tweakers ownership", () => {
  assert.match(mainSource, /if \(!derivedVariant && !healthCheckOnly\) \{[\s\S]*?app\.requestSingleInstanceLock\(\)/);
});
