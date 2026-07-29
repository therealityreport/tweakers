import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CARRIER_NONCE_PREFIX,
  attachMcpFormElement,
} from "../src/preload/host-surfaces";
import type { ReactFiberNode } from "@therealityreport/tweakers-sdk";

type Fiber = ReactFiberNode & { key?: string | null };

class FakeButton {
  readonly tagName = "BUTTON";
  clicks = 0;
  checked = false;

  constructor(
    readonly type: "button" | "submit",
    readonly role: "radio" | "checkbox" | null,
    readonly onClick?: () => void,
  ) {}

  click(): void {
    this.clicks += 1;
    this.onClick?.();
  }

  getAttribute(name: string): string | null {
    if (name === "aria-checked" && this.role) return String(this.checked);
    return null;
  }
}

class FakeInput {
  readonly tagName = "INPUT";
  private currentValue = "";
  readonly events: string[] = [];

  get value(): string { return this.currentValue; }
  set value(value: string) { this.currentValue = value; }
  dispatchEvent(event: Event): boolean {
    this.events.push(event.type);
    return true;
  }
}

type FakeComputedStyle = {
  display: string;
  visibility: string;
  opacity: string;
  contentVisibility: string;
};

class FakeVisibilityElement {
  isConnected = true;
  hidden = false;
  inert = false;
  ariaHidden: string | null = null;
  parentElement: FakeVisibilityElement | null = null;
  ownerDocument!: FakeDocument;
  computedStyle: FakeComputedStyle = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    contentVisibility: "visible",
  };

  constructor(readonly tagName: string) {}

  getAttribute(name: string): string | null {
    return name === "aria-hidden" ? this.ariaHidden : null;
  }
}

class FakeDocument {
  readonly defaultView = {
    getComputedStyle: (element: FakeVisibilityElement) => element.computedStyle,
  };

  constructor(readonly documentElement: FakeVisibilityElement) {
    documentElement.ownerDocument = this;
  }
}

class FakeForm extends FakeVisibilityElement {
  visibleTextReads = 0;
  rectWidth = 640;
  rectHeight = 320;

  constructor(
    readonly choices: FakeButton[],
    readonly textInputs: FakeInput[],
    readonly submit: FakeButton,
    readonly cancel: FakeButton,
  ) {
    super("FORM");
    const documentElement = new FakeVisibilityElement("HTML");
    this.ownerDocument = new FakeDocument(documentElement);
    this.parentElement = documentElement;
  }

  get textContent(): string {
    this.visibleTextReads += 1;
    throw new Error("visible text must not be inspected");
  }

  getClientRects(): Array<{ width: number; height: number }> {
    return this.rectWidth > 0 && this.rectHeight > 0
      ? [{ width: this.rectWidth, height: this.rectHeight }]
      : [];
  }

  querySelectorAll(selector: string): unknown[] {
    if (selector === "button[role=\"radio\"]") return this.choices.filter((choice) => choice.role === "radio");
    if (selector === "button[role=\"checkbox\"]") return this.choices.filter((choice) => choice.role === "checkbox");
    if (selector.startsWith("input:not")) return this.textInputs;
    if (selector.startsWith("button[type=\"submit\"]")) return [this.submit];
    if (selector.startsWith("button[type=\"button\"]")) return [this.cancel];
    return [];
  }
}

function insertVisibilityAncestor(form: FakeForm): FakeVisibilityElement {
  const ancestor = new FakeVisibilityElement("DIV");
  ancestor.ownerDocument = form.ownerDocument;
  ancestor.parentElement = form.parentElement;
  form.parentElement = ancestor;
  return ancestor;
}

function fiber(props: unknown, parent: Fiber | null = null, key: string | null = null): Fiber {
  return {
    key,
    memoizedProps: props as Record<string, unknown>,
    return: parent,
    type: null,
    stateNode: null,
    memoizedState: null,
    child: null,
    sibling: null,
  };
}

function makeFixture(nonce: string) {
  let submitted = 0;
  let cancelled = 0;
  const urgent = new FakeButton("button", "radio", () => { urgent.checked = true; });
  const email = new FakeButton("button", "checkbox", () => { email.checked = !email.checked; });
  const notes = new FakeInput();
  const submit = new FakeButton("submit", null, () => { submitted += 1; });
  const cancel = new FakeButton("button", null, () => { cancelled += 1; });
  const form = new FakeForm([urgent, email], [notes], submit, cancel);
  const identity = {
    elicitation: {
      kind: "formElicitation",
      schema: {
        type: "object",
        properties: {
          [`${MCP_CARRIER_NONCE_PREFIX}${nonce}`]: { type: "string", const: "claim" },
          priority: { type: "string", enum: ["urgent"] },
          channels: { type: "array", items: { enum: ["email"] } },
          notes: { type: "string" },
        },
      },
    },
    requestId: "request-17",
    conversationId: "conversation-29",
    hostId: "host-41",
  };
  const formFiber = fiber({ onSubmit: true }, fiber({ fieldCount: 4 }, fiber(identity)));
  const fibers = new Map<unknown, Fiber>([
    [form, formFiber],
    [urgent, fiber({ value: "urgent" }, fiber({ name: "priority" }), "urgent")],
    [email, fiber({ value: "email" }, fiber({ name: "channels" }), "email")],
    [notes, fiber({ name: "notes" })],
  ]);
  return {
    form,
    identity,
    fibers,
    urgent,
    email,
    notes,
    submit,
    cancel,
    counts: () => ({ submitted, cancelled }),
    resolveFiber: (element: Element) => fibers.get(element) ?? null,
  };
}

function insertFiberAncestors(
  fixture: ReturnType<typeof makeFixture>,
  count: number,
): void {
  const formFiber = fixture.fibers.get(fixture.form)!;
  let parent = formFiber.return as Fiber;
  for (let index = 0; index < count; index += 1) {
    parent = fiber({ wrapper: index }, parent);
  }
  formFiber.return = parent;
}

test("semantic adapter joins only a schema-key nonce and exposes content-free identity and acknowledgements", () => {
  const fixture = makeFixture("nonce-schema-123");
  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    "nonce-schema-123",
    fixture.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  assert.equal(fixture.form.visibleTextReads, 0);
  if (attached.status !== "attached") return;
  assert.strictEqual(attached.controller.form, fixture.form);
  assert.strictEqual(attached.controller.taskCardAnchor, fixture.form);
  assert.deepEqual(attached.identity, {
    requestId: "request-17",
    conversationId: "conversation-29",
    hostId: "host-41",
    schemaPropertyNames: [
      `${MCP_CARRIER_NONCE_PREFIX}nonce-schema-123`,
      "priority",
      "channels",
      "notes",
    ],
  });
  assert.deepEqual(attached.acknowledgement, {
    version: 1,
    stage: "carrier_attach",
    contentRedacted: true,
  });
  assert.deepEqual(attached.controller.mountAcknowledgement("owned"), {
    version: 1,
    stage: "owned_mount",
    contentRedacted: true,
  });
});

test("semantic adapter ignores partial child carrier props beneath one complete parent identity", () => {
  const nonce = "nonce-partial-child-124";
  const fixture = makeFixture(nonce);
  const formFiber = fixture.fibers.get(fixture.form)!;
  formFiber.return!.memoizedProps = {
    elicitation: fixture.identity.elicitation,
    requestId: fixture.identity.requestId,
    conversationId: fixture.identity.conversationId,
  };

  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    nonce,
    fixture.resolveFiber,
  );

  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;
  assert.deepEqual(attached.identity, {
    requestId: "request-17",
    conversationId: "conversation-29",
    hostId: "host-41",
    schemaPropertyNames: [
      `${MCP_CARRIER_NONCE_PREFIX}${nonce}`,
      "priority",
      "channels",
      "notes",
    ],
  });
});

test("semantic adapter reaches a carrier identity through realistic deep host ancestry", () => {
  const nonce = "nonce-deep-host-902";
  const fixture = makeFixture(nonce);
  insertFiberAncestors(fixture, 48);

  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    nonce,
    fixture.resolveFiber,
  );

  assert.equal(attached.status, "attached");
  if (attached.status === "attached") assert.equal(attached.controller.isCurrent(), true);
  assert.equal(fixture.form.visibleTextReads, 0);
});

test("semantic adapter declines cyclic and over-bound carrier ancestry without reading visible content", () => {
  const nonce = "nonce-invalid-ancestry-903";
  const cyclic = makeFixture(nonce);
  const cyclicFormFiber = cyclic.fibers.get(cyclic.form)!;
  cyclicFormFiber.return = cyclicFormFiber;
  assert.deepEqual(
    attachMcpFormElement(cyclic.form as unknown as HTMLFormElement, nonce, cyclic.resolveFiber),
    { status: "declined", reason: "ancestor_cycle" },
  );
  assert.equal(cyclic.form.visibleTextReads, 0);

  const bounded = makeFixture(nonce);
  insertFiberAncestors(bounded, 128);
  assert.deepEqual(
    attachMcpFormElement(bounded.form as unknown as HTMLFormElement, nonce, bounded.resolveFiber),
    { status: "declined", reason: "ancestor_bound_exceeded" },
  );
  assert.equal(bounded.form.visibleTextReads, 0);
});

test("semantic controller drives original controlled fields and ordinary Continue and Cancel", () => {
  const fixture = makeFixture("nonce-controls-456");
  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    "nonce-controls-456",
    fixture.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;

  attached.controller.setRadio("priority", "urgent");
  attached.controller.setCheckbox("channels", "email", true);
  attached.controller.setCheckbox("channels", "email", true);
  attached.controller.setText("notes", "controlled answer");
  attached.controller.continueNormally();
  attached.controller.continueNormally();
  attached.controller.cancelNormally();

  assert.equal(fixture.urgent.checked, true);
  assert.equal(fixture.urgent.clicks, 1);
  assert.equal(fixture.email.checked, true);
  assert.equal(fixture.email.clicks, 1);
  assert.equal(fixture.notes.value, "controlled answer");
  assert.deepEqual(fixture.notes.events, ["input", "change"]);
  assert.deepEqual(fixture.counts(), { submitted: 1, cancelled: 1 });
  assert.equal(fixture.form.isConnected, true);
});

test("generic mount acknowledgement accepts a visible ancestor chain with painted form geometry", () => {
  const visible = makeFixture("nonce-visible-901");
  insertVisibilityAncestor(visible.form);
  insertVisibilityAncestor(visible.form);
  const attached = attachMcpFormElement(
    visible.form as unknown as HTMLFormElement,
    "nonce-visible-901",
    visible.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;
  assert.deepEqual(attached.controller.mountAcknowledgement("generic"), {
    version: 1,
    stage: "generic_mount",
    contentRedacted: true,
  });
  assert.equal(visible.form.visibleTextReads, 0);
});

test("generic mount acknowledgement rejects every ancestor suppression class", () => {
  const cases: Array<{
    name: string;
    suppress: (ancestor: FakeVisibilityElement) => void;
    error: RegExp;
  }> = [
    { name: "hidden", suppress: (ancestor) => { ancestor.hidden = true; }, error: /hidden or suppressed/ },
    { name: "inert", suppress: (ancestor) => { ancestor.inert = true; }, error: /hidden or suppressed/ },
    { name: "aria-hidden", suppress: (ancestor) => { ancestor.ariaHidden = " TRUE "; }, error: /hidden or suppressed/ },
    { name: "display none", suppress: (ancestor) => { ancestor.computedStyle.display = "none"; }, error: /not visibly painted/ },
    { name: "visibility hidden", suppress: (ancestor) => { ancestor.computedStyle.visibility = "hidden"; }, error: /not visibly painted/ },
    { name: "visibility collapse", suppress: (ancestor) => { ancestor.computedStyle.visibility = "collapse"; }, error: /not visibly painted/ },
    { name: "opacity zero", suppress: (ancestor) => { ancestor.computedStyle.opacity = "0.00"; }, error: /not visibly painted/ },
    { name: "content visibility hidden", suppress: (ancestor) => { ancestor.computedStyle.contentVisibility = "hidden"; }, error: /not visibly painted/ },
  ];

  for (const [index, entry] of cases.entries()) {
    const nonce = `nonce-ancestor-${index + 1000}`;
    const fixture = makeFixture(nonce);
    const ancestor = insertVisibilityAncestor(fixture.form);
    entry.suppress(ancestor);
    const attached = attachMcpFormElement(
      fixture.form as unknown as HTMLFormElement,
      nonce,
      fixture.resolveFiber,
    );
    assert.equal(attached.status, "attached", entry.name);
    if (attached.status === "attached") {
      assert.throws(
        () => attached.controller.mountAcknowledgement("generic"),
        entry.error,
        entry.name,
      );
    }
    assert.equal(fixture.form.visibleTextReads, 0, entry.name);
  }
});

test("generic mount acknowledgement rejects suppression nested above a visible parent", () => {
  const fixture = makeFixture("nonce-nested-1902");
  const suppressedOuter = insertVisibilityAncestor(fixture.form);
  insertVisibilityAncestor(fixture.form);
  suppressedOuter.inert = true;
  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    "nonce-nested-1902",
    fixture.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status === "attached") {
    assert.throws(() => attached.controller.mountAcknowledgement("generic"), /hidden or suppressed/);
  }
  assert.equal(fixture.form.visibleTextReads, 0);
});

test("generic mount acknowledgement rejects direct form suppression and missing painted geometry", () => {
  const hidden = makeFixture("nonce-hidden-1903");
  hidden.form.computedStyle.visibility = "hidden";
  const hiddenAttached = attachMcpFormElement(
    hidden.form as unknown as HTMLFormElement,
    "nonce-hidden-1903",
    hidden.resolveFiber,
  );
  assert.equal(hiddenAttached.status, "attached");
  if (hiddenAttached.status === "attached") {
    assert.throws(() => hiddenAttached.controller.mountAcknowledgement("generic"), /not visibly painted/);
  }
  assert.equal(hidden.form.visibleTextReads, 0);

  const unpainted = makeFixture("nonce-geometry-1904");
  unpainted.form.rectHeight = 0;
  const unpaintedAttached = attachMcpFormElement(
    unpainted.form as unknown as HTMLFormElement,
    "nonce-geometry-1904",
    unpainted.resolveFiber,
  );
  assert.equal(unpaintedAttached.status, "attached");
  if (unpaintedAttached.status === "attached") {
    assert.throws(() => unpaintedAttached.controller.mountAcknowledgement("generic"), /painted geometry/);
  }
});

test("generic mount acknowledgement rejects a disconnected ancestor chain", () => {
  const fixture = makeFixture("nonce-disconnected-1905");
  const ancestor = insertVisibilityAncestor(fixture.form);
  ancestor.isConnected = false;
  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    "nonce-disconnected-1905",
    fixture.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status === "attached") {
    assert.throws(() => attached.controller.mountAcknowledgement("generic"), /chain is disconnected/);
  }
});

test("generic mount acknowledgement fails closed when the ancestor proof exceeds its bound", () => {
  const fixture = makeFixture("nonce-bounded-1906");
  for (let index = 0; index < 128; index += 1) insertVisibilityAncestor(fixture.form);
  const attached = attachMcpFormElement(
    fixture.form as unknown as HTMLFormElement,
    "nonce-bounded-1906",
    fixture.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status === "attached") {
    assert.throws(() => attached.controller.mountAcknowledgement("generic"), /document boundary/);
  }
});

test("adapter and currentness checks fail closed on missing, duplicate, conflicting, and drifted carrier identity", () => {
  const nonce = "nonce-drift-789";
  const missing = makeFixture(nonce);
  delete (missing.identity as { hostId?: string }).hostId;
  assert.deepEqual(
    attachMcpFormElement(missing.form as unknown as HTMLFormElement, nonce, missing.resolveFiber),
    { status: "declined", reason: "missing_or_invalid_props" },
  );

  const malformed = makeFixture(nonce);
  malformed.identity.hostId = "";
  assert.deepEqual(
    attachMcpFormElement(malformed.form as unknown as HTMLFormElement, nonce, malformed.resolveFiber),
    { status: "declined", reason: "missing_or_invalid_props" },
  );

  const duplicate = makeFixture(nonce);
  const formFiber = duplicate.fibers.get(duplicate.form)!;
  const identityFiber = formFiber.return!.return! as Fiber;
  identityFiber.return = fiber(duplicate.identity);
  assert.deepEqual(
    attachMcpFormElement(duplicate.form as unknown as HTMLFormElement, nonce, duplicate.resolveFiber),
    { status: "declined", reason: "duplicate_props" },
  );

  const drift = makeFixture(nonce);
  const attached = attachMcpFormElement(
    drift.form as unknown as HTMLFormElement,
    nonce,
    drift.resolveFiber,
  );
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;
  drift.identity.hostId = "host-drifted";
  assert.equal(attached.controller.isCurrent(), false);
  assert.throws(() => attached.controller.continueNormally(), /no longer current/);
  assert.deepEqual(drift.counts(), { submitted: 0, cancelled: 0 });
});
