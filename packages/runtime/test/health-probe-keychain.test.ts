import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyHealthProbeKeychainIsolation,
  HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH,
} from "../src/health-probe-keychain";

function commandLineFixture(initial: string[] = []) {
  const switches = new Set(initial);
  const appended: string[] = [];
  return {
    switches,
    appended,
    commandLine: {
      appendSwitch(name: string) {
        appended.push(name);
        switches.add(name);
      },
      hasSwitch(name: string) {
        return switches.has(name);
      },
    },
  };
}

test("darwin health-only mode installs the mock Keychain switch idempotently", () => {
  const fixture = commandLineFixture();
  assert.equal(applyHealthProbeKeychainIsolation({
    commandLine: fixture.commandLine,
    healthCheckOnly: true,
    platform: "darwin",
  }), true);
  assert.equal(applyHealthProbeKeychainIsolation({
    commandLine: fixture.commandLine,
    healthCheckOnly: true,
    platform: "darwin",
  }), true);
  assert.deepEqual(fixture.appended, [HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH]);
});

test("normal mode and non-macOS health mode never install the mock Keychain switch", () => {
  for (const input of [
    { healthCheckOnly: false, platform: "darwin" as const },
    { healthCheckOnly: true, platform: "linux" as const },
  ]) {
    const fixture = commandLineFixture();
    assert.equal(applyHealthProbeKeychainIsolation({
      commandLine: fixture.commandLine,
      ...input,
    }), false);
    assert.deepEqual(fixture.appended, []);
    assert.equal(fixture.switches.has(HEALTH_PROBE_MOCK_KEYCHAIN_SWITCH), false);
  }
});

test("health-only mode fails closed when Electron does not retain the switch", () => {
  assert.throws(() => applyHealthProbeKeychainIsolation({
    commandLine: {
      appendSwitch() {},
      hasSwitch() { return false; },
    },
    healthCheckOnly: true,
    platform: "darwin",
  }), /could not enable mock Keychain isolation/);
});

test("main installs Keychain isolation before app ready", () => {
  const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "main.ts"), "utf8");
  const healthMode = source.indexOf("const healthCheckOnly =");
  const isolation = source.indexOf("applyHealthProbeKeychainIsolation({", healthMode);
  const ready = source.indexOf("app.whenReady().then", isolation);
  assert.ok(healthMode >= 0, "health-only mode declaration is missing");
  assert.ok(isolation > healthMode, "mock Keychain isolation is missing");
  assert.ok(ready > isolation, "mock Keychain isolation must run before app ready");
});
