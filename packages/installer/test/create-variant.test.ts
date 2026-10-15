import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertRegisteredSharedNativeBackend, captureRegisteredSharedNativeBackend } from "../src/commands/create-variant.ts";
import { NATIVE_CODEX_BACKEND } from "../src/native-bundled-backend.ts";
import { readSharedNativeModeAtRootV1 } from "../../runtime/src/account-router/shared-native-mode.ts";

function fixture(action: (root: string, candidate: string, broker: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "variant-signed-resolver-"));
  const candidate = join(root, "Candidate.app"), broker = join(root, "broker"); mkdirSync(broker, {mode: 0o700});
  try {action(root, candidate, broker);} finally {rmSync(root, {recursive: true, force: true});}
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function backend(candidate: string, relative: string, bytes: string) {const path = join(candidate, relative); mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, bytes);}
function authenticatedPort(broker: string, protocol: string, bytes: string) {
  let fingerprint = `sha256:${"a".repeat(64)}`;
  return {changeGeneration() {fingerprint = `sha256:${"b".repeat(64)}`;},
    readSharedNativeModeAtRootV1(input: {stateRoot: string}) {
      assert.equal(input.stateRoot, broker);
      return {state: "ready", fingerprint, document: {resolverProtocol: protocol, resolverBinarySha256: sha(bytes)}};
    }};
}

test("ordinary official update keeps the same signed registration and exact nested backend", () => fixture((_root, candidate, broker) => {
  backend(candidate, NATIVE_CODEX_BACKEND, "unchanged official native bytes");
  backend(candidate, "Contents/Resources/codex", "stale flat backend");
  const path = join(broker, "shared-native-mode.v1.json");
  const bytes = "private fixture authority; authenticated runtime port supplies its verified projection";
  writeFileSync(path, bytes, {mode: 0o600});
  const port = authenticatedPort(broker, "official-bundled-v1", "unchanged official native bytes");
  assertRegisteredSharedNativeBackend(candidate, broker, {port}); assert.equal(readFileSync(path, "utf8"), bytes);
  writeFileSync(join(candidate, NATIVE_CODEX_BACKEND), "changed official bytes");
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port}), /compatible backend transition/);
}));

test("official protocol never accepts the shell entrypoint or historical flat backend as resolver", () => fixture((_root, candidate, broker) => {
  backend(candidate, "Contents/Resources/codex", "matching but flat");
  backend(candidate, "Contents/Resources/codex-cli/bin/codex", "matching but flat");
  writeFileSync(join(broker, "shared-native-mode.v1.json"), JSON.stringify({resolverProtocol: "official-bundled-v1", resolverBinarySha256: sha("matching but flat")}), {mode: 0o600});
  const port = authenticatedPort(broker, "official-bundled-v1", "matching but flat");
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port}), /compatible backend transition/);
}));

test("historical shared-overlay protocol retains its exact flat resolver hash guard", () => fixture((_root, candidate, broker) => {
  backend(candidate, "Contents/Resources/codex", "legacy registered bytes");
  backend(candidate, NATIVE_CODEX_BACKEND, "unrelated official bytes");
  writeFileSync(join(broker, "shared-native-mode.v1.json"), JSON.stringify({resolverProtocol: "shared-native-overlay-v1", resolverBinarySha256: sha("legacy registered bytes")}), {mode: 0o600});
  const port = authenticatedPort(broker, "shared-native-overlay-v1", "legacy registered bytes");
  assertRegisteredSharedNativeBackend(candidate, broker, {port});
  writeFileSync(join(candidate, "Contents/Resources/codex"), "changed legacy bytes");
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port}), /compatible backend transition/);
}));

test("ordinary refresh rejects unauthenticated metadata even when its backend hash matches", () => fixture((_root, candidate, broker) => {
  backend(candidate, NATIVE_CODEX_BACKEND, "native bytes");
  writeFileSync(join(broker, "shared-native-mode.v1.json"), JSON.stringify({resolverProtocol: "official-bundled-v1",
    resolverBinarySha256: sha("native bytes"), signature: "fabricated"}), {mode: 0o600});
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port: {readSharedNativeModeAtRootV1}}), /could not be authenticated/);
  for (const reason of ["invalid signature", "source account changed", "root identity changed"]) {
    const port = {readSharedNativeModeAtRootV1() {return {state: "blocked", reason};}};
    assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port}), /could not be authenticated/);
  }
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker,
    {port: authenticatedPort(broker, "unknown-protocol", "native bytes")}), /could not be authenticated/);
}));

test("reviewed ordinary authority rejects a new signed generation with unchanged backend bytes", () => fixture((_root, candidate, broker) => {
  backend(candidate, NATIVE_CODEX_BACKEND, "native bytes");
  writeFileSync(join(broker, "shared-native-mode.v1.json"), "private fixture", {mode: 0o600});
  const port = authenticatedPort(broker, "official-bundled-v1", "native bytes");
  const expected = captureRegisteredSharedNativeBackend(broker, port);
  assertRegisteredSharedNativeBackend(candidate, broker, {port, expected});
  port.changeGeneration();
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port, expected}), /registration changed before promotion/);
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker, {port, expected: null}), /registration changed before promotion/);
}));

test("an unfinished resolver transition holds every ordinary refresh", () => fixture((_root, candidate, broker) => {
  writeFileSync(join(broker, "shared-native-mode-transition.v1.json"), "pending", {mode: 0o600});
  assert.throws(() => assertRegisteredSharedNativeBackend(candidate, broker), /recovery must finish/);
}));
