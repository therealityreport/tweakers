import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";

type SchemaProperty = {
  type: string;
  title?: string;
  const?: string;
  enum?: string[];
  items?: { enum?: string[] };
};

type FormElicitation = {
  kind: "formElicitation";
  schema: {
    type: "object";
    properties: Record<string, SchemaProperty>;
    required?: string[];
  };
};

type CarrierIdentity = {
  elicitation: FormElicitation;
  requestId: string;
  conversationId: string;
  hostId: string;
};

type FiberLike = {
  memoizedProps?: unknown;
  return: FiberLike | null;
};

type FixtureAnswer = {
  priority: string | null;
  channels: string[];
  notes: string;
};

type FixtureReply =
  | { action: "submit"; answers: FixtureAnswer }
  | { action: "cancel" };

type FixtureListener = (event: FixtureEvent) => void;

class FixtureEvent {
  defaultPrevented = false;

  constructor(
    readonly type: string,
    readonly detail?: unknown,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FixtureElement {
  readonly listeners = new Map<string, FixtureListener[]>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FixtureListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: FixtureEvent): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }
}

class FixtureButton extends FixtureElement {
  ariaChecked: "true" | "false" | undefined;

  constructor(
    readonly type: "button" | "submit",
    readonly role: "radio" | "checkbox" | undefined,
    readonly propertyKey: string | undefined,
    readonly reactElementKey: string | undefined,
    private readonly form: SemanticCarrierForm,
  ) {
    super("BUTTON");
  }

  click(): void {
    if (!this.form.isConnected) throw new Error("disconnected form control");
    const shouldContinue = this.dispatchEvent(new FixtureEvent("click"));
    if (shouldContinue && this.type === "submit") this.form.requestSubmit();
  }
}

class FixtureTextInput extends FixtureElement {
  value = "";

  constructor(
    readonly propertyKey: string,
    private readonly form: SemanticCarrierForm,
  ) {
    super("INPUT");
  }

  dispatchControlledInput(nextValue: string): void {
    if (!this.form.isConnected) throw new Error("disconnected form control");
    this.dispatchEvent(new FixtureEvent("input", { value: nextValue }));
  }
}

class SemanticCarrierForm extends FixtureElement {
  readonly tagName = "FORM";
  readonly submitButton: FixtureButton;
  readonly cancelButton: FixtureButton;
  readonly choiceButtons: FixtureButton[];
  readonly textInputs: FixtureTextInput[];
  readonly replies: FixtureReply[] = [];
  readonly fiber: FiberLike;
  isConnected = true;
  textContentReadCount = 0;
  submitDispatchCount = 0;
  cancelDispatchCount = 0;

  private priority: string | null = null;
  private readonly channels = new Set<string>();
  private notes = "";

  constructor(
    private readonly visibleText: string,
    fiber: FiberLike,
  ) {
    super("FORM");
    this.fiber = fiber;

    this.choiceButtons = [
      this.choice("radio", "priority", "routine"),
      this.choice("radio", "priority", "urgent"),
      this.choice("checkbox", "channels", "email"),
      this.choice("checkbox", "channels", "sms"),
    ];
    this.textInputs = [this.textInput("notes")];
    this.submitButton = new FixtureButton("submit", undefined, undefined, undefined, this);
    this.cancelButton = new FixtureButton("button", undefined, undefined, undefined, this);

    this.addEventListener("submit", (event) => {
      event.preventDefault();
      this.submitDispatchCount += 1;
      this.replies.push({ action: "submit", answers: this.answerSnapshot() });
    });
    this.cancelButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.cancelDispatchCount += 1;
      this.replies.push({ action: "cancel" });
    });
    this.renderControlledValues();
  }

  get textContent(): string {
    this.textContentReadCount += 1;
    return this.visibleText;
  }

  peekVisibleText(): string {
    return this.visibleText;
  }

  requestSubmit(): void {
    if (!this.isConnected) throw new Error("cannot submit a disconnected form");
    this.dispatchEvent(new FixtureEvent("submit"));
  }

  answerSnapshot(): FixtureAnswer {
    return {
      priority: this.priority,
      channels: [...this.channels].sort(),
      notes: this.notes,
    };
  }

  behaviorSnapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      isConnected: this.isConnected,
      fiber: this.fiber,
      submitButton: this.submitButton,
      cancelButton: this.cancelButton,
      choiceButtons: this.choiceButtons,
      textInputs: this.textInputs,
      listenerCounts: [...this.listeners.entries()].map(([name, listeners]) => [name, listeners.length]),
    });
  }

  private choice(
    role: "radio" | "checkbox",
    propertyKey: string,
    reactElementKey: string,
  ): FixtureButton {
    const button = new FixtureButton("button", role, propertyKey, reactElementKey, this);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      if (role === "radio") {
        this.priority = reactElementKey;
      } else if (this.channels.has(reactElementKey)) {
        this.channels.delete(reactElementKey);
      } else {
        this.channels.add(reactElementKey);
      }
      this.renderControlledValues();
    });
    return button;
  }

  private textInput(propertyKey: string): FixtureTextInput {
    const input = new FixtureTextInput(propertyKey, this);
    input.addEventListener("input", (event) => {
      const detail = asRecord(event.detail);
      if (typeof detail?.value !== "string") throw new Error("invalid controlled input event");
      this.notes = detail.value;
      this.renderControlledValues();
    });
    return input;
  }

  private renderControlledValues(): void {
    for (const button of this.choiceButtons ?? []) {
      if (button.role === "radio") {
        button.ariaChecked = this.priority === button.reactElementKey ? "true" : "false";
      } else {
        button.ariaChecked = this.channels.has(button.reactElementKey ?? "") ? "true" : "false";
      }
    }
    for (const input of this.textInputs ?? []) input.value = this.notes;
  }
}

const NONCE_PREFIX = "__tweakers_carrier_nonce_";
const MAX_FIBER_DEPTH = 12;
const CARRIER_IDENTITY_KEYS = ["elicitation", "requestId", "conversationId", "hostId"] as const;

function noncePropertyKey(nonce: string): string {
  return `${NONCE_PREFIX}${nonce}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completeCarrierIdentityCandidate(props: Record<string, unknown>): boolean {
  return CARRIER_IDENTITY_KEYS.every((key) => hasOwn(props, key));
}

function parseIdentity(props: Record<string, unknown>): CarrierIdentity | null {
  const elicitation = asRecord(props.elicitation);
  const schema = asRecord(elicitation?.schema);
  const properties = asRecord(schema?.properties);
  if (
    elicitation?.kind !== "formElicitation" ||
    schema?.type !== "object" ||
    properties === null ||
    !nonEmptyString(props.requestId) ||
    !nonEmptyString(props.conversationId) ||
    !nonEmptyString(props.hostId)
  ) {
    return null;
  }
  return props as unknown as CarrierIdentity;
}

function stableIdentityShape(identity: CarrierIdentity): string {
  const propertyShape = Object.entries(identity.elicitation.schema.properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, property]) => [key, property.type, property.const ?? null, property.enum ?? null]);
  return JSON.stringify({
    requestId: identity.requestId,
    conversationId: identity.conversationId,
    hostId: identity.hostId,
    propertyShape,
  });
}

type CarrierDeclineReason =
  | "not_semantic_form"
  | "disconnected_form"
  | "missing_fiber"
  | "ancestor_cycle"
  | "ancestor_bound_exceeded"
  | "missing_or_invalid_props"
  | "duplicate_props"
  | "conflicting_props"
  | "nonce_not_in_schema";

type AttachResult =
  | { status: "attached"; identity: CarrierIdentity; controller: CarrierController }
  | { status: "declined"; reason: CarrierDeclineReason };

class CarrierController {
  constructor(readonly originalForm: SemanticCarrierForm) {}

  setRadio(propertyKey: string, optionKey: string): void {
    this.exactChoice("radio", propertyKey, optionKey).click();
  }

  setCheckbox(propertyKey: string, optionKey: string, checked: boolean): void {
    const button = this.exactChoice("checkbox", propertyKey, optionKey);
    if ((button.ariaChecked === "true") !== checked) button.click();
  }

  setText(propertyKey: string, value: string): void {
    const matches = this.originalForm.textInputs.filter((input) => input.propertyKey === propertyKey);
    if (matches.length !== 1) throw new Error(`text control drift:${propertyKey}:${matches.length}`);
    matches[0].dispatchControlledInput(value);
  }

  continueNormally(): void {
    this.originalForm.submitButton.click();
  }

  cancelNormally(): void {
    this.originalForm.cancelButton.click();
  }

  private exactChoice(
    role: "radio" | "checkbox",
    propertyKey: string,
    optionKey: string,
  ): FixtureButton {
    const matches = this.originalForm.choiceButtons.filter(
      (button) =>
        button.role === role &&
        button.propertyKey === propertyKey &&
        button.reactElementKey === optionKey,
    );
    if (matches.length !== 1) {
      throw new Error(`choice control drift:${role}:${propertyKey}:${optionKey}:${matches.length}`);
    }
    return matches[0];
  }
}

class CarrierAdapter {
  attach(form: SemanticCarrierForm, nonce: string): AttachResult {
    if (form.tagName !== "FORM") return { status: "declined", reason: "not_semantic_form" };
    if (!form.isConnected) return { status: "declined", reason: "disconnected_form" };
    if (!form.fiber) return { status: "declined", reason: "missing_fiber" };

    const identities: CarrierIdentity[] = [];
    const seen = new Set<FiberLike>();
    let fiber: FiberLike | null = form.fiber;
    let depth = 0;
    let malformedCarrierProps = false;

    while (fiber !== null && depth < MAX_FIBER_DEPTH) {
      if (seen.has(fiber)) return { status: "declined", reason: "ancestor_cycle" };
      seen.add(fiber);
      const props = asRecord(fiber.memoizedProps);
      if (props && completeCarrierIdentityCandidate(props)) {
        const identity = parseIdentity(props);
        if (identity) identities.push(identity);
        else malformedCarrierProps = true;
      }
      fiber = fiber.return;
      depth += 1;
    }

    if (fiber !== null) return { status: "declined", reason: "ancestor_bound_exceeded" };
    if (malformedCarrierProps || identities.length === 0) {
      return { status: "declined", reason: "missing_or_invalid_props" };
    }
    if (identities.length > 1) {
      const shapes = new Set(identities.map(stableIdentityShape));
      return {
        status: "declined",
        reason: shapes.size === 1 ? "duplicate_props" : "conflicting_props",
      };
    }

    const identity = identities[0];
    if (!hasOwn(identity.elicitation.schema.properties, noncePropertyKey(nonce))) {
      return { status: "declined", reason: "nonce_not_in_schema" };
    }
    return { status: "attached", identity, controller: new CarrierController(form) };
  }
}

type IpcContext = { senderWebContentsId: number };
type RouteContext = { webContentsId: number; hostId: string; conversationId: string };
type ActiveClaim = {
  token: string;
  requestId: string;
  routeHash: string;
  active: boolean;
};

type ClaimResult =
  | { status: "claimed"; claim: ActiveClaim; controller: CarrierController }
  | { status: "rejected"; reason: "invalid_ipc_context" | "nonce_replayed" | CarrierDeclineReason };

function normalizeRoutePart(value: string): string {
  return value.normalize("NFC").trim();
}

function routeHash(secret: string, route: RouteContext): string {
  const material = JSON.stringify([
    route.webContentsId,
    normalizeRoutePart(route.hostId),
    normalizeRoutePart(route.conversationId),
  ]);
  return createHmac("sha256", secret).update(material).digest("hex");
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

class AtomicCarrierClaims {
  private readonly pendingNonces = new Set<string>();
  private readonly consumedNonces = new Set<string>();
  private readonly claims = new Map<string, ActiveClaim>();

  constructor(
    private readonly adapter: CarrierAdapter,
    private readonly routeSecret: string,
  ) {}

  registerToolDiscovery(nonce: string): void {
    if (!nonEmptyString(nonce) || this.pendingNonces.has(nonce) || this.consumedNonces.has(nonce)) {
      throw new Error("nonce must be unique and one-use");
    }
    this.pendingNonces.add(nonce);
  }

  claim(form: SemanticCarrierForm, nonce: string, ipc: IpcContext): ClaimResult {
    if (!Number.isSafeInteger(ipc.senderWebContentsId) || ipc.senderWebContentsId <= 0) {
      return { status: "rejected", reason: "invalid_ipc_context" };
    }
    if (!this.pendingNonces.has(nonce)) return { status: "rejected", reason: "nonce_replayed" };

    const attached = this.adapter.attach(form, nonce);
    if (attached.status === "declined") return { status: "rejected", reason: attached.reason };

    // This compare-and-delete is synchronous: the nonce is consumed before the
    // winning claim can yield, so a second microtask cannot observe it pending.
    if (!this.pendingNonces.delete(nonce)) return { status: "rejected", reason: "nonce_replayed" };
    this.consumedNonces.add(nonce);

    const currentRoute: RouteContext = {
      webContentsId: ipc.senderWebContentsId,
      hostId: attached.identity.hostId,
      conversationId: attached.identity.conversationId,
    };
    const hash = routeHash(this.routeSecret, currentRoute);
    const token = createHash("sha256")
      .update(`${nonce}\0${attached.identity.requestId}\0${hash}`)
      .digest("hex");
    const claim: ActiveClaim = {
      token,
      requestId: attached.identity.requestId,
      routeHash: hash,
      active: true,
    };
    this.claims.set(token, claim);
    return { status: "claimed", claim, controller: attached.controller };
  }

  observeRoute(token: string, route: RouteContext): boolean {
    const claim = this.claims.get(token);
    if (!claim || !claim.active) return false;
    if (!equalHash(claim.routeHash, routeHash(this.routeSecret, route))) claim.active = false;
    return claim.active;
  }
}

type FixtureOptions = {
  nonce: string;
  visibleNonce?: string;
  requestId?: string;
  conversationId?: string;
  hostId?: string;
  identityMutator?: (props: Record<string, unknown>) => void;
  extraIdentity?: CarrierIdentity;
  ancestorTailLength?: number;
  cycle?: boolean;
};

function schemaFor(nonce: string): FormElicitation["schema"] {
  return {
    type: "object",
    properties: {
      [noncePropertyKey(nonce)]: { type: "string", const: "claim", title: "Internal request marker" },
      priority: { type: "string", title: "Priority", enum: ["routine", "urgent"] },
      channels: { type: "array", title: "Channels", items: { enum: ["email", "sms"] } },
      notes: { type: "string", title: "Notes" },
    },
    required: ["priority"],
  };
}

function identityFor(options: FixtureOptions): CarrierIdentity {
  return {
    elicitation: { kind: "formElicitation", schema: schemaFor(options.nonce) },
    requestId: options.requestId ?? "request-17",
    conversationId: options.conversationId ?? "conversation-29",
    hostId: options.hostId ?? "host-41",
  };
}

function makeCarrierFixture(options: FixtureOptions): SemanticCarrierForm {
  const identity = identityFor(options);
  const carrierProps = identity as unknown as Record<string, unknown>;
  options.identityMutator?.(carrierProps);
  let ancestor: FiberLike = { memoizedProps: carrierProps, return: null };

  if (options.extraIdentity) {
    ancestor = { memoizedProps: options.extraIdentity, return: ancestor };
  }
  for (let index = 0; index < (options.ancestorTailLength ?? 0); index += 1) {
    ancestor = { memoizedProps: { layoutDepth: index }, return: ancestor };
  }
  const intermediary: FiberLike = { memoizedProps: { fieldCount: 4 }, return: ancestor };
  const formFiber: FiberLike = { memoizedProps: { onSubmit: "host callback" }, return: intermediary };
  if (options.cycle) ancestor.return = formFiber;

  const visibleNonce = options.visibleNonce ?? "decoy-visible-nonce";
  return new SemanticCarrierForm(
    `Visible question text names ${noncePropertyKey(visibleNonce)} and never reveals the real schema key.`,
    formFiber,
  );
}

type DeliveryClassification =
  | "tool_discovery"
  | "carrier_attach"
  | "owned_mount"
  | "generic_mount"
  | "explicit_cancel"
  | "host_empty_response";

type DeliverySignal =
  | { kind: "tool_discovered"; content?: unknown }
  | { kind: "carrier_attached"; content?: unknown }
  | { kind: "mount"; owner: "owned" | "generic"; content?: unknown }
  | { kind: "host_finished"; explicitlyCancelled: boolean; responsePresent: false; content?: unknown };

type RedactedDeliveryRecord = Readonly<{
  classification: DeliveryClassification;
  contentRedacted: true;
}>;

function classifyDelivery(signal: DeliverySignal): DeliveryClassification {
  switch (signal.kind) {
    case "tool_discovered":
      return "tool_discovery";
    case "carrier_attached":
      return "carrier_attach";
    case "mount":
      return signal.owner === "owned" ? "owned_mount" : "generic_mount";
    case "host_finished":
      return signal.explicitlyCancelled ? "explicit_cancel" : "host_empty_response";
  }
}

function recordDelivery(signal: DeliverySignal): RedactedDeliveryRecord {
  // Deliberately whitelist only non-content state. Prompts, schemas, visible
  // labels, options, and answers supplied on the input are never copied.
  return Object.freeze({ classification: classifyDelivery(signal), contentRedacted: true });
}

test("1. discovers a one-use nonce only in schema keys and fails closed on fiber host drift", () => {
  const nonce = "n-2f8c19";
  const form = makeCarrierFixture({ nonce, visibleNonce: "n-misleading" });
  const adapter = new CarrierAdapter();

  assert.match(form.peekVisibleText(), new RegExp(noncePropertyKey("n-misleading")));
  assert.doesNotMatch(form.peekVisibleText(), new RegExp(noncePropertyKey(nonce)));
  const attached = adapter.attach(form, nonce);
  assert.equal(attached.status, "attached");
  assert.equal(form.textContentReadCount, 0, "carrier discovery must never inspect visible text");
  if (attached.status === "attached") {
    assert.equal(attached.identity.requestId, "request-17");
    assert.equal(attached.identity.conversationId, "conversation-29");
    assert.equal(attached.identity.hostId, "host-41");
    assert.equal(hasOwn(attached.identity as unknown as Record<string, unknown>, "webContentsId"), false);
  }

  const wrongNonce = adapter.attach(form, "n-from-visible-text");
  assert.deepEqual(wrongNonce, { status: "declined", reason: "nonce_not_in_schema" });

  const nested = makeCarrierFixture({ nonce });
  const partialIdentity = identityFor({ nonce });
  nested.fiber.return!.memoizedProps = {
    elicitation: partialIdentity.elicitation,
    requestId: partialIdentity.requestId,
    conversationId: partialIdentity.conversationId,
  };
  assert.equal(
    adapter.attach(nested, nonce).status,
    "attached",
    "partial child props must not poison the complete parent identity",
  );

  const missing = makeCarrierFixture({
    nonce,
    identityMutator: (props) => {
      delete props.hostId;
    },
  });
  assert.deepEqual(adapter.attach(missing, nonce), {
    status: "declined",
    reason: "missing_or_invalid_props",
  });

  const duplicateIdentity = identityFor({ nonce });
  const duplicate = makeCarrierFixture({ nonce, extraIdentity: duplicateIdentity });
  assert.deepEqual(adapter.attach(duplicate, nonce), {
    status: "declined",
    reason: "duplicate_props",
  });

  const conflicting = makeCarrierFixture({
    nonce,
    extraIdentity: identityFor({ nonce, hostId: "host-drifted" }),
  });
  assert.deepEqual(adapter.attach(conflicting, nonce), {
    status: "declined",
    reason: "conflicting_props",
  });

  const wrongKind = makeCarrierFixture({
    nonce,
    identityMutator: (props) => {
      props.elicitation = { kind: "messageElicitation", schema: schemaFor(nonce) };
    },
  });
  assert.deepEqual(adapter.attach(wrongKind, nonce), {
    status: "declined",
    reason: "missing_or_invalid_props",
  });

  const tooDeep = makeCarrierFixture({ nonce, ancestorTailLength: MAX_FIBER_DEPTH });
  assert.deepEqual(adapter.attach(tooDeep, nonce), {
    status: "declined",
    reason: "ancestor_bound_exceeded",
  });

  const cycle = makeCarrierFixture({ nonce, cycle: true });
  assert.deepEqual(adapter.attach(cycle, nonce), { status: "declined", reason: "ancestor_cycle" });
});

test("2. atomically claims once, rejects replay, and invalidates an HMAC-SHA256 route on host drift", async () => {
  const nonce = "n-atomic-4be6";
  const secret = "test-only-route-secret";
  const form = makeCarrierFixture({ nonce });
  const claims = new AtomicCarrierClaims(new CarrierAdapter(), secret);
  claims.registerToolDiscovery(nonce);

  const [left, right] = await Promise.all([
    Promise.resolve().then(() => claims.claim(form, nonce, { senderWebContentsId: 73 })),
    Promise.resolve().then(() => claims.claim(form, nonce, { senderWebContentsId: 73 })),
  ]);
  const winners = [left, right].filter((result) => result.status === "claimed");
  const losers = [left, right].filter((result) => result.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].status === "rejected" ? losers[0].reason : null, "nonce_replayed");
  const winner = winners[0];
  assert.equal(winner.status, "claimed");
  if (winner.status !== "claimed") return;

  assert.match(winner.claim.routeHash, /^[a-f0-9]{64}$/);
  const canonicalRoute = { webContentsId: 73, hostId: "host-41", conversationId: "conversation-29" };
  assert.equal(winner.claim.routeHash, routeHash(secret, canonicalRoute));
  assert.equal(
    routeHash(secret, canonicalRoute),
    routeHash(secret, { webContentsId: 73, hostId: " host-41 ", conversationId: "conversation-29" }),
    "normalization must make the same route stable",
  );
  assert.notEqual(
    winner.claim.routeHash,
    routeHash(secret, { ...canonicalRoute, webContentsId: 74 }),
    "IPC sender webContents is part of the route",
  );
  assert.notEqual(
    winner.claim.routeHash,
    routeHash(secret, { ...canonicalRoute, hostId: "host-drifted" }),
    "host drift changes the route",
  );
  assert.notEqual(
    winner.claim.routeHash,
    routeHash(secret, { ...canonicalRoute, conversationId: "conversation-drifted" }),
    "conversation drift changes the route",
  );
  assert.equal(claims.observeRoute(winner.claim.token, canonicalRoute), true);
  assert.equal(
    claims.observeRoute(winner.claim.token, { ...canonicalRoute, hostId: "host-drifted" }),
    false,
    "a route change invalidates immediately",
  );
  assert.equal(
    claims.observeRoute(winner.claim.token, canonicalRoute),
    false,
    "an invalidated claim cannot revive if navigation returns",
  );

  assert.deepEqual(claims.claim(form, nonce, { senderWebContentsId: 73 }), {
    status: "rejected",
    reason: "nonce_replayed",
  });

  const invalidContextNonce = "n-invalid-ipc";
  claims.registerToolDiscovery(invalidContextNonce);
  assert.deepEqual(
    claims.claim(makeCarrierFixture({ nonce: invalidContextNonce }), invalidContextNonce, {
      senderWebContentsId: 0,
    }),
    { status: "rejected", reason: "invalid_ipc_context" },
  );
});

test("3. drives controlled radio, checkbox, and text values through the original connected form's submit and cancel paths", () => {
  const nonce = "n-controls-cf72";
  const adapter = new CarrierAdapter();
  const submitForm = makeCarrierFixture({ nonce });
  const submitOriginal = submitForm;
  const attached = adapter.attach(submitForm, nonce);
  assert.equal(attached.status, "attached");
  if (attached.status !== "attached") return;

  attached.controller.setRadio("priority", "urgent");
  attached.controller.setCheckbox("channels", "email", true);
  attached.controller.setCheckbox("channels", "sms", true);
  attached.controller.setCheckbox("channels", "sms", false);
  attached.controller.setText("notes", "Controlled answer from the owned UI");

  assert.deepEqual(submitForm.answerSnapshot(), {
    priority: "urgent",
    channels: ["email"],
    notes: "Controlled answer from the owned UI",
  });
  assert.equal(
    submitForm.choiceButtons.find(
      (button) => button.propertyKey === "priority" && button.reactElementKey === "urgent",
    )?.ariaChecked,
    "true",
  );
  assert.equal(submitForm.textInputs[0].value, "Controlled answer from the owned UI");
  attached.controller.continueNormally();
  assert.strictEqual(attached.controller.originalForm, submitOriginal);
  assert.equal(submitForm.isConnected, true);
  assert.equal(submitForm.submitDispatchCount, 1);
  assert.equal(submitForm.cancelDispatchCount, 0);
  assert.deepEqual(submitForm.replies, [{ action: "submit", answers: submitForm.answerSnapshot() }]);

  const cancelForm = makeCarrierFixture({ nonce });
  const cancelOriginal = cancelForm;
  const cancelAttached = adapter.attach(cancelForm, nonce);
  assert.equal(cancelAttached.status, "attached");
  if (cancelAttached.status !== "attached") return;
  cancelAttached.controller.cancelNormally();
  assert.strictEqual(cancelAttached.controller.originalForm, cancelOriginal);
  assert.equal(cancelForm.isConnected, true);
  assert.equal(cancelForm.submitDispatchCount, 0);
  assert.equal(cancelForm.cancelDispatchCount, 1);
  assert.deepEqual(cancelForm.replies, [{ action: "cancel" }]);
});

test("4. adapter decline does not alter or suppress the usable generic form", () => {
  const nonce = "n-fallback-d881";
  const form = makeCarrierFixture({
    nonce,
    identityMutator: (props) => {
      delete props.conversationId;
    },
  });
  const before = form.behaviorSnapshot();
  const result = new CarrierAdapter().attach(form, nonce);
  const after = form.behaviorSnapshot();

  assert.deepEqual(result, { status: "declined", reason: "missing_or_invalid_props" });
  assert.strictEqual(after.fiber, before.fiber);
  assert.strictEqual(after.submitButton, before.submitButton);
  assert.strictEqual(after.cancelButton, before.cancelButton);
  assert.strictEqual(after.choiceButtons, before.choiceButtons);
  assert.strictEqual(after.textInputs, before.textInputs);
  assert.equal(form.isConnected, true);

  const genericUrgent = form.choiceButtons.find(
    (button) => button.role === "radio" && button.reactElementKey === "urgent",
  );
  assert.ok(genericUrgent);
  genericUrgent.click();
  form.textInputs[0].dispatchControlledInput("Generic form remains usable");
  form.submitButton.click();
  form.cancelButton.click();
  assert.deepEqual(form.answerSnapshot(), {
    priority: "urgent",
    channels: [],
    notes: "Generic form remains usable",
  });
  assert.equal(form.submitDispatchCount, 1);
  assert.equal(form.cancelDispatchCount, 1);
  assert.deepEqual(form.replies, [
    { action: "submit", answers: form.answerSnapshot() },
    { action: "cancel" },
  ]);
  assert.equal(form.isConnected, true);
});

test("5. delivery audit distinguishes mount and empty-result outcomes while redacting all content", () => {
  const secretPrompt = "PROMPT_DO_NOT_LOG_9f4c";
  const secretAnswer = "ANSWER_DO_NOT_LOG_b120";
  const secretSchema = "SCHEMA_DO_NOT_LOG_55e1";
  const signals: DeliverySignal[] = [
    { kind: "tool_discovered", content: { prompt: secretPrompt, schema: secretSchema } },
    { kind: "carrier_attached", content: { visibleText: secretPrompt } },
    { kind: "mount", owner: "owned", content: { answers: [secretAnswer] } },
    { kind: "mount", owner: "generic", content: { options: [secretSchema] } },
    {
      kind: "host_finished",
      explicitlyCancelled: true,
      responsePresent: false,
      content: { answer: secretAnswer },
    },
    {
      kind: "host_finished",
      explicitlyCancelled: false,
      responsePresent: false,
      content: { prompt: secretPrompt },
    },
  ];
  const records = signals.map(recordDelivery);

  assert.deepEqual(
    records.map((record) => record.classification),
    [
      "tool_discovery",
      "carrier_attach",
      "owned_mount",
      "generic_mount",
      "explicit_cancel",
      "host_empty_response",
    ],
  );
  assert.equal(new Set(records.map((record) => record.classification)).size, 6);
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, new RegExp(secretPrompt));
  assert.doesNotMatch(serialized, new RegExp(secretAnswer));
  assert.doesNotMatch(serialized, new RegExp(secretSchema));
  assert.equal(records.every((record) => record.contentRedacted), true);
});
