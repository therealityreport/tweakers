import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  commandExecutesInsideBundle,
  findStaleHelperProcesses,
  parseExecutablePathFromCommand,
  terminateStaleHelperProcesses,
} from "../src/orphans";
import type { ProcessInfo } from "../src/commands/debug";

const APP = "/Applications/ChatGPT.app";
const MAIN_EXE = `${APP}/Contents/MacOS/ChatGPT`;
const CRASHPAD = `${APP}/Contents/Frameworks/Codex Framework.framework/Versions/1.0/Helpers/browser_crashpad_handler`;
const MONITOR = `${APP}/Contents/Resources/native/bare-modifier-monitor`;

const KNOWN_FILES = new Set([MAIN_EXE, CRASHPAD, MONITOR, "/usr/bin/true"]);
const fileExists = (path: string) => KNOWN_FILES.has(path);

function proc(partial: Partial<ProcessInfo> & { pid: number; command: string }): ProcessInfo {
  return {
    ppid: 1,
    startedAtRaw: "Sat Jul 12 00:00:00 2026",
    startedAt: "2026-07-12T00:00:00.000Z",
    ...partial,
  };
}

// --- parseExecutablePathFromCommand ---

test("parses unquoted bundle path with spaces plus flags", () => {
  assert.equal(
    parseExecutablePathFromCommand(`${CRASHPAD} --monitor-self --database=/x`, fileExists),
    CRASHPAD,
  );
});

test("parses double- and single-quoted executables", () => {
  assert.equal(parseExecutablePathFromCommand(`"${CRASHPAD}" --flag`, fileExists), CRASHPAD);
  assert.equal(parseExecutablePathFromCommand(`'${CRASHPAD}' --flag`, fileExists), CRASHPAD);
});

test("parses backslash-escaped spaces", () => {
  const escaped = CRASHPAD.replace(/ /g, "\\ ");
  assert.equal(parseExecutablePathFromCommand(`${escaped} --flag`, fileExists), CRASHPAD);
});

test("deleted or replaced executable fails closed to null", () => {
  assert.equal(
    parseExecutablePathFromCommand(`${APP}/Contents/Gone Helper/deleted-exe --flag`, fileExists),
    null,
  );
  const escapedGone = `${APP}/Contents/Gone\\ Helper/deleted-exe --flag`;
  assert.equal(parseExecutablePathFromCommand(escapedGone, fileExists), null);
});

test("empty and unresolvable commands fail closed", () => {
  assert.equal(parseExecutablePathFromCommand("", fileExists), null);
  assert.equal(parseExecutablePathFromCommand("   ", fileExists), null);
  assert.equal(parseExecutablePathFromCommand("some random words here", fileExists), null);
});

test("single token without spaces parses exactly without a disk probe", () => {
  assert.equal(parseExecutablePathFromCommand("/tmp/crashpad_handler", fileExists), "/tmp/crashpad_handler");
});

// --- commandExecutesInsideBundle ---

test("inside-bundle executable matches; sibling-prefix app does not", () => {
  assert.equal(commandExecutesInsideBundle(`${CRASHPAD} --flag`, APP, fileExists), true);
  const sibling = "/Applications/ChatGPT Helper.app/Contents/MacOS/x";
  const siblingExists = (p: string) => p === sibling;
  assert.equal(commandExecutesInsideBundle(`${sibling} --flag`, APP, siblingExists), false);
});

test("bundle path appearing only as an argument does not match", () => {
  assert.equal(
    commandExecutesInsideBundle(`/usr/bin/true --app ${APP}/Contents/Resources/app.asar`, APP, fileExists),
    false,
  );
});

test("name-only match outside the bundle does not match", () => {
  assert.equal(commandExecutesInsideBundle("/tmp/crashpad_handler --db=/x", APP, fileExists), false);
});

// --- findStaleHelperProcesses ---

const base = {
  canonicalAppRoot: APP,
  mainStartedAt: null as string | null,
};

test("no main process: all bundle-owned ppid-1 helpers qualify", () => {
  const helpers = [
    proc({ pid: 10, command: `${CRASHPAD} --a` }),
    proc({ pid: 11, command: `${MONITOR} --key X` }),
  ];
  const found = findStaleHelperProcesses({ ...base, processes: helpers }, fileExists);
  assert.deepEqual(found.map((p) => p.pid), [10, 11]);
});

test("main executable is never selected, even orphaned", () => {
  const processes = [proc({ pid: 20, command: MAIN_EXE })];
  const found = findStaleHelperProcesses({ ...base, processes }, fileExists);
  assert.deepEqual(found, []);
});

test("ppid !== 1 is excluded even when older than main", () => {
  const processes = [
    proc({ pid: 30, ppid: 500, command: `${CRASHPAD} --a`, startedAt: "2026-07-11T00:00:00.000Z" }),
  ];
  const found = findStaleHelperProcesses(
    { ...base, processes, mainStartedAt: "2026-07-12T00:00:00.000Z" },
    fileExists,
  );
  assert.deepEqual(found, []);
});

test("generation boundary: only helpers strictly older than main die", () => {
  const mainStartedAt = "2026-07-12T12:00:00.000Z";
  const processes = [
    proc({ pid: 40, command: `${CRASHPAD} --old`, startedAt: "2026-07-12T11:00:00.000Z" }),
    proc({ pid: 41, command: `${CRASHPAD} --current`, startedAt: "2026-07-12T12:00:01.000Z" }),
    proc({ pid: 42, command: `${CRASHPAD} --same-instant`, startedAt: mainStartedAt }),
    proc({ pid: 43, command: `${MONITOR} --undated`, startedAt: null }),
  ];
  const found = findStaleHelperProcesses({ ...base, processes, mainStartedAt }, fileExists);
  assert.deepEqual(found.map((p) => p.pid), [40]);
});

test("unparseable mainStartedAt selects nothing (fail safe)", () => {
  const processes = [proc({ pid: 50, command: `${CRASHPAD} --a` })];
  const found = findStaleHelperProcesses(
    { ...base, processes, mainStartedAt: "not a date" },
    fileExists,
  );
  assert.deepEqual(found, []);
});

test("excludePids are never returned", () => {
  const processes = [proc({ pid: 60, command: `${CRASHPAD} --a` })];
  const found = findStaleHelperProcesses({ ...base, processes, excludePids: [60] }, fileExists);
  assert.deepEqual(found, []);
});

test("unparseable executables are skipped", () => {
  const processes = [proc({ pid: 70, command: `${APP}/Contents/Deleted Helper/x --a` })];
  const found = findStaleHelperProcesses({ ...base, processes }, fileExists);
  assert.deepEqual(found, []);
});

// --- terminateStaleHelperProcesses ---

test("terminateStaleHelperProcesses is a no-op off darwin, else scans safely", () => {
  const result = terminateStaleHelperProcesses("/nonexistent/App.app");
  // Either platform: a nonexistent root must never signal anything.
  assert.deepEqual(result.terminated, []);
  assert.equal(result.scanned, 0);
});

test("the compatibility observer contains no process-signal path", () => {
  const source = readFileSync(new URL("../src/orphans.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.kill\s*\(/);
  assert.doesNotMatch(source, /os\.kill\s*\(/);
});
