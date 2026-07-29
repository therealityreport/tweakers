import { fiberForNode } from "./react-hook";
import type {
  HostMcpDeliveryAcknowledgement,
  HostMcpFormAttachResult,
  HostMcpFormController,
  HostMcpFormIdentity,
  HostProjectContext,
  HostSurfaceKind,
  HostSurfaceMatch,
  HostSurfaceSnapshot,
  HostUiApi,
  ReactFiberNode,
} from "@therealityreport/tweakers-sdk";

const MAX_MATCHES = 100;
// Current desktop builds can place a standard MCP form beneath substantially
// more provider/suspense wrappers than the shallow synthetic fixtures used
// during the original implementation. Keep the walk bounded, but leave enough
// headroom to reach the identity-bearing form component in the real host.
const MAX_MCP_FIBER_DEPTH = 128;
const MAX_MCP_SCHEMA_PROPERTIES = 128;
const MAX_MCP_IDENTITY_LENGTH = 512;
const MAX_MCP_VISIBILITY_ANCESTORS = 128;
const MCP_CARRIER_IDENTITY_KEYS = ["elicitation", "requestId", "conversationId", "hostId"] as const;
export const MCP_CARRIER_NONCE_PREFIX = "__tweakers_carrier_nonce_";
const listeners = new Set<{ kinds: HostSurfaceKind[]; listener: (snapshots: HostSurfaceSnapshot[]) => void }>();
let sharedObserver: MutationObserver | null = null;
let pendingFrame: number | null = null;

const SELECTORS: Record<Exclude<HostSurfaceKind, "projects" | "thread-context" | "usage">, string> = {
  "assistant-turns": '[data-testid="conversation-turn"], [data-testid*="assistant-message" i], [data-message-author-role="assistant"], [data-role="assistant"]',
  composer: '#prompt-textarea, [data-testid="composer"] textarea, [data-testid="composer"] [contenteditable="true"], form textarea:not([disabled]), form [contenteditable="true"]',
  "command-menu": '[data-command-menu], [data-slash-menu], [role="listbox"]',
  "account-menu": '[role="menu"], [role="dialog"]',
  "settings-rows": '[data-settings-row], [role="listitem"], section > div',
  "titlebar-controls": '[data-titlebar-control], [aria-label="Hide sidebar"], [aria-label="Show sidebar"], [aria-label="Back"], [aria-label="Forward"], [title="Back"], [title="Forward"]',
};

export const hostUiApi: HostUiApi = {
  query: queryHostSurfaces,
  snapshot,
  observe,
  getActiveProject,
  attachFiles,
  attachMcpFormCarrier,
};

type CarrierFiber = ReactFiberNode & { key?: null | string | number };

type CarrierIdentityInternal = {
  requestId: string;
  conversationId: string;
  hostId: string;
  schemaProperties: Record<string, Record<string, unknown>>;
};

type CarrierInspection =
  | { status: "attached"; identity: CarrierIdentityInternal; identityShape: string }
  | { status: "declined"; reason: Exclude<HostMcpFormAttachResult, { status: "attached" }>["reason"] };

/**
 * Find the one standard MCP form carrying this nonce. Discovery uses schema
 * property keys only; visible prompt, label, option, and answer text are never
 * inspected.
 */
export function attachMcpFormCarrier(nonce: string): HostMcpFormAttachResult {
  if (!validCarrierNonce(nonce)) return { status: "declined", reason: "invalid_nonce" };
  if (typeof document === "undefined") return { status: "declined", reason: "carrier_not_found" };
  const attached: Extract<HostMcpFormAttachResult, { status: "attached" }>[] = [];
  for (const form of Array.from(document.querySelectorAll("form"))) {
    const result = attachMcpFormElement(form as HTMLFormElement, nonce);
    if (result.status === "attached") attached.push(result);
  }
  if (attached.length === 0) return { status: "declined", reason: "carrier_not_found" };
  if (attached.length > 1) return { status: "declined", reason: "multiple_carriers" };
  return attached[0];
}

/** Exported for a repository-local drift harness; tweaks use hostUiApi. */
export function attachMcpFormElement(
  form: HTMLFormElement,
  nonce: string,
  resolveFiber: (element: Element) => ReactFiberNode | null = (element) =>
    fiberForNode(element) as ReactFiberNode | null,
): HostMcpFormAttachResult {
  if (!validCarrierNonce(nonce)) return { status: "declined", reason: "invalid_nonce" };
  if (String(form?.tagName).toUpperCase() !== "FORM") {
    return { status: "declined", reason: "not_semantic_form" };
  }
  if (!form.isConnected) return { status: "declined", reason: "disconnected_form" };
  const inspected = inspectCarrierForm(form, nonce, resolveFiber);
  if (inspected.status === "declined") return inspected;
  const identity = publicCarrierIdentity(inspected.identity);
  const controller = new SemanticMcpFormController(
    form,
    nonce,
    identity,
    inspected.identityShape,
    resolveFiber,
  );
  return {
    status: "attached",
    identity,
    controller,
    acknowledgement: deliveryAcknowledgement("carrier_attach"),
  };
}

class SemanticMcpFormController implements HostMcpFormController {
  readonly taskCardAnchor: HTMLElement;
  private continueDispatched = false;

  constructor(
    readonly form: HTMLFormElement,
    private readonly nonce: string,
    readonly identity: Readonly<HostMcpFormIdentity>,
    private readonly identityShape: string,
    private readonly resolveFiber: (element: Element) => ReactFiberNode | null,
  ) {
    // The semantic form itself is the only anchor proven to belong to the
    // carrier. Callers may mount adjacent to it, but may not guess a task card
    // from text, focus, URL, or the primary window.
    this.taskCardAnchor = form;
  }

  isCurrent(): boolean {
    if (!this.form.isConnected) return false;
    const current = inspectCarrierForm(this.form, this.nonce, this.resolveFiber);
    return current.status === "attached" && current.identityShape === this.identityShape;
  }

  setRadio(propertyKey: string, optionKey: string): void {
    this.exactChoice("radio", propertyKey, optionKey).click();
  }

  setCheckbox(propertyKey: string, optionKey: string, checked: boolean): void {
    const button = this.exactChoice("checkbox", propertyKey, optionKey);
    const selected = button.getAttribute("aria-checked") === "true";
    if (selected !== checked) button.click();
  }

  setText(propertyKey: string, value: string): void {
    this.assertCurrent();
    if (!this.identity.schemaPropertyNames.includes(propertyKey)) {
      throw new Error("MCP form control drift: unknown property");
    }
    const matches = Array.from(
      this.form.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], textarea'),
    ).filter((element) => controlMatchesProperty(
      element,
      propertyKey,
      this.identity.schemaPropertyNames,
      this.resolveFiber,
    ));
    if (matches.length !== 1) throw new Error("MCP form control drift: text control is not unique");
    setControlledText(matches[0] as HTMLInputElement | HTMLTextAreaElement, value);
  }

  continueNormally(): void {
    if (this.continueDispatched) return;
    this.assertCurrent();
    const controls = Array.from(this.form.querySelectorAll('button[type="submit"], input[type="submit"]'));
    if (controls.length !== 1) throw new Error("MCP form control drift: submit control is not unique");
    // Mark the handoff before invoking host code. A host callback can remove the
    // form or throw after accepting the click, so an uncertain renderer retry
    // must never dispatch a second Continue for the same claimed carrier.
    this.continueDispatched = true;
    (controls[0] as HTMLElement).click();
  }

  cancelNormally(): void {
    this.assertCurrent();
    const controls = Array.from(this.form.querySelectorAll(
      'button[type="button"]:not([role="radio"]):not([role="checkbox"])',
    ));
    if (controls.length !== 1) throw new Error("MCP form control drift: cancel control is not unique");
    (controls[0] as HTMLElement).click();
  }

  mountAcknowledgement(owner: "owned" | "generic"): HostMcpDeliveryAcknowledgement {
    this.assertCurrent();
    if (owner === "generic") this.assertVisibleGenericForm();
    return deliveryAcknowledgement(owner === "owned" ? "owned_mount" : "generic_mount");
  }

  private exactChoice(
    role: "radio" | "checkbox",
    propertyKey: string,
    optionKey: string,
  ): HTMLButtonElement {
    this.assertCurrent();
    if (!this.identity.schemaPropertyNames.includes(propertyKey)) {
      throw new Error("MCP form control drift: unknown property");
    }
    const matches = Array.from(this.form.querySelectorAll(`button[role="${role}"]`)).filter(
      (element) => controlMatchesProperty(
        element,
        propertyKey,
        this.identity.schemaPropertyNames,
        this.resolveFiber,
      ) && controlMatchesOption(element, optionKey, this.resolveFiber),
    );
    if (matches.length !== 1) throw new Error("MCP form control drift: choice control is not unique");
    return matches[0] as HTMLButtonElement;
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) throw new Error("MCP form carrier is no longer current");
  }

  private assertVisibleGenericForm(): void {
    const form = this.form;
    const ownerDocument = form.ownerDocument;
    const documentElement = ownerDocument?.documentElement;
    const view = form.ownerDocument?.defaultView;
    if (!ownerDocument || !documentElement || !view || typeof view.getComputedStyle !== "function") {
      throw new Error("MCP generic form visibility could not be measured");
    }

    const seen = new Set<Element>();
    let element: Element | null = form;
    let reachedDocumentElement = false;
    for (let depth = 0; element && depth < MAX_MCP_VISIBILITY_ANCESTORS; depth += 1) {
      if (seen.has(element)) {
        throw new Error("MCP generic form visibility chain is cyclic");
      }
      seen.add(element);
      if (element.ownerDocument !== ownerDocument || !element.isConnected) {
        throw new Error("MCP generic form visibility chain is disconnected");
      }

      const visibilityElement = element as Element & { hidden?: boolean; inert?: boolean };
      if (
        visibilityElement.hidden === true
        || visibilityElement.inert === true
        || element.getAttribute("aria-hidden")?.trim().toLowerCase() === "true"
      ) {
        throw new Error("MCP generic form is hidden or suppressed");
      }

      const style = view.getComputedStyle(element);
      const opacity = Number.parseFloat(style.opacity);
      if (
        style.display === "none"
        || style.visibility === "hidden"
        || style.visibility === "collapse"
        || (Number.isFinite(opacity) && opacity <= 0)
        || style.contentVisibility === "hidden"
      ) {
        throw new Error("MCP generic form is not visibly painted");
      }

      if (element === documentElement) {
        reachedDocumentElement = true;
        break;
      }
      element = element.parentElement;
    }
    if (!reachedDocumentElement) {
      throw new Error("MCP generic form visibility chain did not reach the document boundary");
    }

    const rects = Array.from(form.getClientRects());
    const painted = rects.some((rect) => (
      Number.isFinite(rect.width)
      && Number.isFinite(rect.height)
      && rect.width > 0
      && rect.height > 0
    ));
    if (!painted) throw new Error("MCP generic form has no painted geometry");
    if (!form.isConnected || form.ownerDocument !== ownerDocument) {
      throw new Error("MCP generic form visibility chain is disconnected");
    }
    this.assertCurrent();
  }
}

function inspectCarrierForm(
  form: HTMLFormElement,
  nonce: string,
  resolveFiber: (element: Element) => ReactFiberNode | null,
): CarrierInspection {
  const first = resolveFiber(form) as CarrierFiber | null;
  if (!first) return { status: "declined", reason: "missing_fiber" };
  const identities: CarrierIdentityInternal[] = [];
  const seen = new Set<CarrierFiber>();
  let fiber: CarrierFiber | null = first;
  let depth = 0;
  let malformedCarrierProps = false;
  while (fiber && depth < MAX_MCP_FIBER_DEPTH) {
    if (seen.has(fiber)) return { status: "declined", reason: "ancestor_cycle" };
    seen.add(fiber);
    const props = asRecord(fiber.memoizedProps);
    if (props && completeCarrierIdentityCandidate(props)) {
      const identity = parseCarrierIdentity(props);
      if (identity) identities.push(identity);
      else malformedCarrierProps = true;
    }
    fiber = fiber.return as CarrierFiber | null;
    depth += 1;
  }
  if (fiber) return { status: "declined", reason: "ancestor_bound_exceeded" };
  if (malformedCarrierProps || identities.length === 0) {
    return { status: "declined", reason: "missing_or_invalid_props" };
  }
  if (identities.length > 1) {
    const shapes = new Set(identities.map(stableCarrierIdentityShape));
    return { status: "declined", reason: shapes.size === 1 ? "duplicate_props" : "conflicting_props" };
  }
  const identity = identities[0];
  if (!Object.hasOwn(identity.schemaProperties, `${MCP_CARRIER_NONCE_PREFIX}${nonce}`)) {
    return { status: "declined", reason: "nonce_not_in_schema" };
  }
  return { status: "attached", identity, identityShape: stableCarrierIdentityShape(identity) };
}

function completeCarrierIdentityCandidate(props: Record<string, unknown>): boolean {
  return MCP_CARRIER_IDENTITY_KEYS.every((key) => Object.hasOwn(props, key));
}

function parseCarrierIdentity(props: Record<string, unknown>): CarrierIdentityInternal | null {
  const elicitation = asRecord(props.elicitation);
  const schema = asRecord(elicitation?.schema);
  const properties = asRecord(schema?.properties);
  const requestId = boundedIdentity(props.requestId);
  const conversationId = boundedIdentity(props.conversationId);
  const hostId = boundedIdentity(props.hostId);
  if (
    elicitation?.kind !== "formElicitation" ||
    schema?.type !== "object" ||
    !properties ||
    !requestId ||
    !conversationId ||
    !hostId
  ) return null;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_MCP_SCHEMA_PROPERTIES) return null;
  const schemaProperties: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of entries) {
    const property = asRecord(value);
    if (!key || key.length > MAX_MCP_IDENTITY_LENGTH || !property || typeof property.type !== "string") return null;
    schemaProperties[key] = property;
  }
  return { requestId, conversationId, hostId, schemaProperties };
}

function stableCarrierIdentityShape(identity: CarrierIdentityInternal): string {
  return JSON.stringify({
    requestId: identity.requestId,
    conversationId: identity.conversationId,
    hostId: identity.hostId,
    propertyShape: Object.entries(identity.schemaProperties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, property]) => [
        key,
        property.type,
        property.const ?? null,
        property.enum ?? null,
        asRecord(property.items)?.enum ?? null,
      ]),
  });
}

function publicCarrierIdentity(identity: CarrierIdentityInternal): Readonly<HostMcpFormIdentity> {
  return Object.freeze({
    requestId: identity.requestId,
    conversationId: identity.conversationId,
    hostId: identity.hostId,
    schemaPropertyNames: Object.freeze(Object.keys(identity.schemaProperties)),
  });
}

function controlMatchesProperty(
  element: Element,
  expected: string,
  schemaPropertyNames: readonly string[],
  resolveFiber: (element: Element) => ReactFiberNode | null,
): boolean {
  const known = new Set(schemaPropertyNames);
  const matches = new Set<string>();
  const bounded = walkControlFibers(element, resolveFiber, (fiber) => {
    const props = asRecord(fiber.memoizedProps);
    if (!props) return;
    const queue: unknown[] = [props];
    const seen = new Set<unknown>();
    for (let visited = 0; queue.length && visited < 32; visited += 1) {
      const value = queue.shift();
      const record = asRecord(value);
      if (!record || seen.has(record)) continue;
      seen.add(record);
      for (const [key, item] of Object.entries(record)) {
        if (["name", "propertyKey", "fieldName"].includes(key) && typeof item === "string" && known.has(item)) {
          matches.add(item);
        } else if (item && typeof item === "object") {
          queue.push(item);
        }
      }
    }
  });
  return bounded && matches.size === 1 && matches.has(expected);
}

function controlMatchesOption(
  element: Element,
  expected: string,
  resolveFiber: (element: Element) => ReactFiberNode | null,
): boolean {
  const candidates = new Set<string>();
  const bounded = walkControlFibers(element, resolveFiber, (fiber) => {
    if (typeof fiber.key === "string" || typeof fiber.key === "number") {
      const key = String(fiber.key);
      candidates.add(key);
      if (key.startsWith(".$")) candidates.add(key.slice(2));
    }
    const props = asRecord(fiber.memoizedProps);
    for (const key of ["value", "optionKey"]) {
      if (typeof props?.[key] === "string") candidates.add(props[key] as string);
    }
    const option = asRecord(props?.option);
    if (typeof option?.value === "string") candidates.add(option.value);
  });
  return bounded && candidates.has(expected);
}

function walkControlFibers(
  element: Element,
  resolveFiber: (element: Element) => ReactFiberNode | null,
  visitor: (fiber: CarrierFiber) => void,
): boolean {
  let fiber = resolveFiber(element) as CarrierFiber | null;
  const seen = new Set<CarrierFiber>();
  for (let depth = 0; fiber && depth < MAX_MCP_FIBER_DEPTH; depth += 1) {
    if (seen.has(fiber)) return false;
    seen.add(fiber);
    visitor(fiber);
    fiber = fiber.return as CarrierFiber | null;
  }
  return fiber === null;
}

function setControlledText(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = Object.getPrototypeOf(input) as object | null;
  const setter = prototype ? Object.getOwnPropertyDescriptor(prototype, "value")?.set : undefined;
  if (setter) setter.call(input, value);
  else input.value = value;
  const inputEvent = typeof InputEvent === "function"
    ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: null })
    : new Event("input", { bubbles: true });
  input.dispatchEvent(inputEvent);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function validCarrierNonce(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{8,128}$/.test(value);
}

function boundedIdentity(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_MCP_IDENTITY_LENGTH
    ? value
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function deliveryAcknowledgement(
  stage: HostMcpDeliveryAcknowledgement["stage"],
): HostMcpDeliveryAcknowledgement {
  return Object.freeze({ version: 1, stage, contentRedacted: true });
}

export function queryHostSurfaces(kind: HostSurfaceKind): HostSurfaceMatch[] {
  if (typeof document === "undefined") return [];
  if (kind === "projects") return projectRows();
  if (kind === "thread-context") return threadContexts();
  if (kind === "usage") return usageSurfaces();
  const selector = SELECTORS[kind];
  return uniqueElements(document.querySelectorAll(selector))
    .filter((element) => semanticFilter(kind, element))
    .slice(0, MAX_MATCHES)
    .map((element) => ({ kind, element, confidence: confidenceFor(kind, element), label: accessibleLabel(element) }));
}

function snapshot(kind: HostSurfaceKind): HostSurfaceSnapshot {
  const matches = queryHostSurfaces(kind).slice(0, MAX_MATCHES);
  return { kind, count: matches.length, matches };
}

function observe(kinds: HostSurfaceKind[], listener: (snapshots: HostSurfaceSnapshot[]) => void): () => void {
  const entry = { kinds: [...new Set(kinds)], listener };
  listeners.add(entry);
  ensureObserver();
  safelyNotify(entry, entry.kinds.map(snapshot));
  return () => {
    listeners.delete(entry);
    if (!listeners.size) {
      sharedObserver?.disconnect();
      sharedObserver = null;
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
    }
  };
}

function ensureObserver(): void {
  if (sharedObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  sharedObserver = new MutationObserver(() => {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      for (const entry of listeners) safelyNotify(entry, entry.kinds.map(snapshot));
    });
  });
  sharedObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["aria-label", "aria-current", "role", "data-testid", "data-project-id", "data-project-name", "data-workspace-path", "data-usage-limit-key", "data-usage-limit", "disabled"],
    childList: true,
    characterData: true,
    subtree: true,
  });
}

function safelyNotify(entry: { listener: (snapshots: HostSurfaceSnapshot[]) => void }, snapshots: HostSurfaceSnapshot[]): void {
  try { entry.listener(snapshots); }
  catch (error) { console.warn("[tweaker] host surface observer failed", error); }
}

function projectRows(): HostSurfaceMatch[] {
  const controls = uniqueElements(document.querySelectorAll('button, a, [role="button"]'));
  return controls.filter((element) => {
    const label = compact(element.textContent);
    if (!label || label.length > 120 || !element.querySelector("svg")) return false;
    return Boolean(directProjectIdentity(element));
  }).slice(0, MAX_MATCHES).map((element) => ({
    kind: "projects",
    element,
    confidence: "high",
    label: compact(element.textContent),
  }));
}

/**
 * A project row must own project identity itself. Walking ancestor fibers made
 * every control rendered inside a project route inherit project context: task
 * rows and even the titlebar model picker then looked like project rows. Keep
 * this seam fail-closed so consumers never decorate unrelated host controls.
 */
function directProjectIdentity(element: Element): string | null {
  for (const attribute of [
    "data-app-action-sidebar-project-id",
    "data-project-id",
    "data-project-name",
    "data-workspace-path",
    "data-project-path",
  ]) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }
  const props = (fiberForNode(element) as ReactFiberNode | null)?.memoizedProps;
  return props && typeof props === "object"
    ? firstString(props as Record<string, unknown>, ["projectId", "projectName", "workspacePath", "projectPath"]) ?? null
    : null;
}

function threadContexts(): HostSurfaceMatch[] {
  const candidates = uniqueElements(document.querySelectorAll('[data-project-id], [data-workspace-path], main, [role="main"]'));
  return candidates.filter((element) => {
    if (element.hasAttribute("data-project-id") || element.hasAttribute("data-workspace-path")) return true;
    const props = fiberProps(element);
    return Boolean(firstString(props, ["projectId", "workspacePath", "projectName"]));
  }).slice(0, MAX_MATCHES).map((element) => ({ kind: "thread-context", element, confidence: element.hasAttribute("data-project-id") ? "high" : "medium", label: accessibleLabel(element) }));
}

function usageSurfaces(): HostSurfaceMatch[] {
  const direct = uniqueElements(document.querySelectorAll('[data-usage-limit-key], [data-usage-limit], [data-testid*="usage" i], [aria-label*="usage" i], [class*="usage" i]'));
  const textual = uniqueElements(document.querySelectorAll("section, article, [role='listitem']")).filter((element) => /(?:usage|limit).*(?:remaining|reset|used)|(?:remaining|reset|used).*(?:usage|limit)/i.test(compact(element.textContent)));
  return uniqueElements([...direct, ...textual]).slice(0, MAX_MATCHES).map((element) => ({ kind: "usage", element, confidence: direct.includes(element) ? "high" : "medium", label: accessibleLabel(element) }));
}

function getActiveProject(): HostProjectContext | null {
  for (const match of queryHostSurfaces("thread-context")) {
    const element = match.element;
    const props = fiberProps(element);
    const context = {
      id: element.getAttribute("data-project-id") || firstString(props, ["projectId", "id"]),
      name: element.getAttribute("data-project-name") || firstString(props, ["projectName", "name"]),
      workspacePath: element.getAttribute("data-workspace-path") || firstString(props, ["workspacePath", "projectPath", "cwd"]),
    };
    if (context.id || context.name || context.workspacePath) return context;
  }
  return null;
}

async function attachFiles(files: Array<{ name: string; mimeType: string; dataBase64: string }>): Promise<{ accepted: boolean; reason: "accepted" | "composer-missing" | "paste-rejected" | "attachment-timeout" }> {
  const target = queryHostSurfaces("composer")[0]?.element ?? null;
  if (!target) return { accepted: false, reason: "composer-missing" };
  const prepared = files.map((file) => {
    const bytes = Uint8Array.from(atob(file.dataBase64), (char) => char.charCodeAt(0));
    return new File([bytes], safeFileName(file.name), { type: file.mimeType || "application/octet-stream" });
  });
  const transfer = new DataTransfer();
  for (const file of prepared) transfer.items.add(file);
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer });
  const accepted = target.dispatchEvent(paste);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  (target as HTMLElement).focus?.();
  return { accepted: accepted !== false, reason: accepted === false ? "paste-rejected" : "accepted" };
}

function safeFileName(value: string): string {
  const cleaned = String(value || "AppShot").replace(/[/:\\\0\r\n]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 160) || "AppShot";
}

function semanticFilter(kind: HostSurfaceKind, element: Element): boolean {
  const text = compact(element.textContent);
  if (kind === "assistant-turns") {
    const role = element.getAttribute("data-message-author-role") || element.getAttribute("data-role");
    return role ? role.toLowerCase() === "assistant" : /assistant-message/i.test(element.getAttribute("data-testid") || "");
  }
  if (kind === "account-menu") return /account|settings|log\s*out/i.test(text);
  if (kind === "settings-rows") return text.length > 0;
  return true;
}

function confidenceFor(kind: HostSurfaceKind, element: Element): HostSurfaceMatch["confidence"] {
  if (element.hasAttribute("data-testid") || element.hasAttribute("aria-label") || element.hasAttribute("role")) return "high";
  return kind === "composer" || kind === "titlebar-controls" ? "medium" : "low";
}

function fiberProps(element: Element): Record<string, unknown> | null {
  let fiber = fiberForNode(element) as ReactFiberNode | null;
  const merged: Record<string, unknown> = {};
  for (let depth = 0; fiber && depth < 20; depth += 1, fiber = fiber.return) {
    if (fiber.memoizedProps && typeof fiber.memoizedProps === "object") Object.assign(merged, fiber.memoizedProps);
  }
  return Object.keys(merged).length ? merged : null;
}

function firstString(props: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!props) return undefined;
  const queue: unknown[] = [props];
  const seen = new Set<unknown>();
  for (let visited = 0; queue.length && visited < 80; visited += 1) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(key) && typeof item === "string" && item.trim()) return item;
      if (item && typeof item === "object") queue.push(item);
    }
  }
  return undefined;
}

function uniqueElements(input: Iterable<Element> | ArrayLike<Element>): Element[] {
  return [...new Set(Array.from(input))];
}

function accessibleLabel(element: Element): string | undefined {
  return element.getAttribute("aria-label") || element.getAttribute("title") || compact(element.textContent) || undefined;
}

function compact(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}
