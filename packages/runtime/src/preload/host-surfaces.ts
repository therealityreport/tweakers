import { fiberForNode } from "./react-hook";
import type {
  HostProjectContext,
  HostSurfaceKind,
  HostSurfaceMatch,
  HostSurfaceSnapshot,
  HostUiApi,
  ReactFiberNode,
} from "@therealityreport/tweakers-sdk";

const MAX_MATCHES = 100;
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
};

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
