import assert from "node:assert/strict";
import test from "node:test";
import {
  captureTweakReloadFocus,
  restoreTweakReloadFocus,
} from "../src/preload/reload-focus";

class FakeElement {
  isConnected = true;
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  selectionDirection: "forward" | "backward" | "none" | null = null;
  focusCount = 0;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  focus(): void {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }

  setSelectionRange(
    start: number,
    end: number,
    direction?: "forward" | "backward" | "none",
  ): void {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction ?? "none";
  }
}

class FakeDocument {
  readonly body = new FakeElement(this, "BODY");
  readonly documentElement = new FakeElement(this, "HTML");
  activeElement: FakeElement | null = this.body;
}

test("tweak reload restores the focused text control and its selection", () => {
  const document = new FakeDocument();
  const input = new FakeElement(document, "TEXTAREA");
  input.selectionStart = 4;
  input.selectionEnd = 9;
  input.selectionDirection = "backward";
  document.activeElement = input;

  const snapshot = captureTweakReloadFocus(document as unknown as Document);
  document.activeElement = document.body;
  assert.equal(restoreTweakReloadFocus(snapshot), true);

  assert.equal(document.activeElement, input);
  assert.equal(input.focusCount, 1);
  assert.equal(input.selectionStart, 4);
  assert.equal(input.selectionEnd, 9);
  assert.equal(input.selectionDirection, "backward");
});

test("tweak reload never steals focus back after the user focuses something else", () => {
  const document = new FakeDocument();
  const input = new FakeElement(document, "TEXTAREA");
  const other = new FakeElement(document, "BUTTON");
  document.activeElement = input;

  const snapshot = captureTweakReloadFocus(document as unknown as Document);
  document.activeElement = other;

  assert.equal(restoreTweakReloadFocus(snapshot), false);
  assert.equal(document.activeElement, other);
  assert.equal(input.focusCount, 0);
});

test("tweak reload does not focus a control that was removed during reload", () => {
  const document = new FakeDocument();
  const input = new FakeElement(document, "INPUT");
  document.activeElement = input;

  const snapshot = captureTweakReloadFocus(document as unknown as Document);
  input.isConnected = false;
  document.activeElement = document.body;

  assert.equal(restoreTweakReloadFocus(snapshot), false);
  assert.equal(document.activeElement, document.body);
  assert.equal(input.focusCount, 0);
});
