import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolveRuntimeNativeHostPath } from "../src/native-host-path";

test("packaged runtime resolves only the native host staged inside app resources", () => {
  const resourcesPath = "/Applications/ChatGPT.app/Contents/Resources";
  const runtimeDir = "/Users/example/runtime";
  const staged = join(resourcesPath, "tweakers", "native", "tweaker_native_host.node");
  assert.equal(resolveRuntimeNativeHostPath({
    resourcesPath,
    runtimeDir,
    packaged: true,
    allowExternalDevelopmentFallback: true,
    exists: () => false,
  }), staged);
});

test("unpackaged explicit development process may use the external runtime fallback", () => {
  const resourcesPath = "/tmp/Electron.app/Contents/Resources";
  const runtimeDir = "/repo/packages/runtime/dist";
  assert.equal(resolveRuntimeNativeHostPath({
    resourcesPath,
    runtimeDir,
    packaged: false,
    allowExternalDevelopmentFallback: true,
    exists: () => false,
  }), join(runtimeDir, "native", "tweaker_native_host.node"));
});

test("staged host always wins over an allowed development fallback", () => {
  const resourcesPath = "/tmp/Electron.app/Contents/Resources";
  const staged = join(resourcesPath, "tweakers", "native", "tweaker_native_host.node");
  assert.equal(resolveRuntimeNativeHostPath({
    resourcesPath,
    runtimeDir: "/repo/runtime",
    packaged: false,
    allowExternalDevelopmentFallback: true,
    exists: (path) => path === staged,
  }), staged);
});
