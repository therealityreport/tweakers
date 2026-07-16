"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const tweak = require("../index.js");

test("safeFilePart strips path separators and control characters", () => {
  assert.equal(tweak._test.safeFilePart("My App:/Window\nName"), "My-App-Window-Name");
});

test("filesForCapture creates a png and context text file", () => {
  const files = tweak._test.filesForCapture(sampleCapture(), { includeText: true });
  assert.equal(files.length, 2);
  assert.match(files[0].name, /^AppShot-Safari-/);
  assert.equal(files[0].mimeType, "image/png");
  assert.equal(files[1].name, "AppShot-Safari-Context.txt");
  assert.equal(files[1].mimeType, "text/plain");
  assert.match(Buffer.from(files[1].dataBase64, "base64").toString("utf8"), /Hello from AX/);
});

test("filesForCapture degrades to image-only without text", () => {
  const capture = sampleCapture();
  capture.accessibility.text = null;
  const files = tweak._test.filesForCapture(capture, { includeText: true });
  assert.equal(files.length, 1);
});

test("contextFileText includes source metadata", () => {
  const text = tweak._test.contextFileText(sampleCapture());
  assert.match(text, /App: Safari/);
  assert.match(text, /Bundle ID: com.apple.Safari/);
  assert.match(text, /Window: Example/);
  assert.match(text, /Accessibility: captured/);
});

function sampleCapture() {
  return {
    captureId: "capture-1",
    capturedAt: "2026-07-13T12:00:00.000Z",
    app: { name: "Safari", bundleIdentifier: "com.apple.Safari", pid: 123 },
    window: { id: 42, title: "Example", bounds: { x: 0, y: 0, width: 800, height: 600 } },
    image: { mimeType: "image/png", dataBase64: "aW1hZ2U=", width: 800, height: 600, byteLength: 5 },
    accessibility: { status: "captured", text: "Hello from AX", characterCount: 13 },
  };
}
