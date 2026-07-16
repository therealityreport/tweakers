const PROFILES_TWEAK = "co.tweakers.thread-summary-profiles";
const PROJECTS_TWEAK = "co.tweakers.projects";
const PROJECTS_CHANNEL = "projects";
const PROFILE_ACTION = "profiles.read";
const FOLLOWUP_TWEAK = "co.tweakers.followup";
const FOLLOWUP_ACTION = "followup.policy.read";
const PROFILE_VERSION = 1;
const PROFILE_TYPES = new Set(["github", "modal", "google", "chrome", "google-workspace", "supabase", "environment"]);

type Handler = (...args: unknown[]) => unknown;

function failure(code: string) {
  return { ok: false, error: { code, message: "The cross-tweak read could not be completed safely." } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);
}

function safeReference(type: string, value: unknown): value is string {
  if (!validText(value, 160)) return false;
  const patterns: Record<string, RegExp> = {
    github: /^gh:[a-f0-9]{24}$/,
    modal: /^modal:[a-zA-Z0-9._-]{1,80}$/,
    google: /^google:[a-zA-Z0-9._-]{1,80}$/,
    chrome: /^chrome:[a-zA-Z0-9._-]{1,80}$/,
    "google-workspace": /^google-workspace:[a-zA-Z0-9._-]{1,80}$/,
    supabase: /^supabase:[a-zA-Z0-9._-]{1,80}$/,
    environment: /^environment:[a-zA-Z0-9._-]{1,80}$/,
  };
  const opaque = value.slice(value.indexOf(":") + 1);
  return Boolean(patterns[type]?.test(value))
    && !/^(?:sk-proj-|sk-[A-Za-z0-9]|gh[opsu]_|xox[baprs]-)/i.test(opaque)
    && !/^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/.test(opaque);
}

function validateRequest(message: unknown): Record<string, unknown> | null {
  if (!record(message) || message.action !== PROFILE_ACTION || message.version !== PROFILE_VERSION || !record(message.project)) return null;
  const project = message.project;
  const id = project.id;
  const workspacePath = project.workspacePath;
  if (id !== undefined && !validText(id, 128)) return null;
  if (workspacePath !== undefined && (!validText(workspacePath, 4096) || !workspacePath.startsWith("/"))) return null;
  if (id === undefined && workspacePath === undefined) return null;
  return { action: PROFILE_ACTION, version: PROFILE_VERSION, project: { ...(id === undefined ? {} : { id }), ...(workspacePath === undefined ? {} : { workspacePath }) } };
}

export function sanitizeProfilesReadResponse(value: unknown): unknown {
  if (!record(value) || value.ok !== true || value.version !== PROFILE_VERSION || typeof value.revision !== "string"
    || !/^[a-f0-9]{32}$/.test(value.revision) || !record(value.project) || !Array.isArray(value.profiles)) {
    return failure("invalid-response");
  }
  if (!validText(value.project.id, 128) || !validText(value.project.name, 80) || value.profiles.length > PROFILE_TYPES.size) return failure("invalid-response");
  const profiles = [];
  for (const item of value.profiles) {
    if (!record(item) || typeof item.type !== "string" || !PROFILE_TYPES.has(item.type) || item.status !== "configured"
      || !validText(item.label, 80) || !safeReference(item.type, item.value)) return failure("invalid-response");
    profiles.push({ type: item.type, label: item.label, status: "configured", value: item.value });
  }
  return { ok: true, version: PROFILE_VERSION, revision: value.revision, project: { id: value.project.id, name: value.project.name }, profiles };
}

export async function dispatchCrossTweakRead(
  requester: unknown,
  target: unknown,
  action: unknown,
  message: unknown,
  lookup: (tweakId: string, channel: string) => Handler | undefined,
): Promise<unknown> {
  if (requester === FOLLOWUP_TWEAK && target === PROJECTS_TWEAK && action === FOLLOWUP_ACTION) {
    if (!record(message) || message.action !== "get" || !record(message.project)
      || !validText(message.project.workspacePath, 4096) || !message.project.workspacePath.startsWith("/")
      || (message.project.id !== undefined && !validText(message.project.id, 128))) return failure("invalid-request");
    const handler = lookup(PROJECTS_TWEAK, PROJECTS_CHANNEL);
    if (!handler) return failure("unavailable");
    try {
      const value = await handler({ action: "followup.policy.read", project: {
        workspacePath: message.project.workspacePath,
        ...(message.project.id === undefined ? {} : { id: message.project.id }),
      } });
      if (!record(value) || value.schemaVersion !== 1 || value.exactItems !== 5 || typeof value.enabled !== "boolean") return failure("invalid-response");
      if (value.enabled) return { schemaVersion: 1, enabled: true, exactItems: 5, exception: null };
      if (value.exception !== "disabled-by-applicable-agents") return failure("invalid-response");
      return { schemaVersion: 1, enabled: false, exactItems: 5, exception: value.exception };
    } catch { return failure("unavailable"); }
  }
  if (requester !== PROFILES_TWEAK || target !== PROJECTS_TWEAK || action !== PROFILE_ACTION) return failure("not-allowed");
  const request = validateRequest(message);
  if (!request) return failure("invalid-request");
  const handler = lookup(PROJECTS_TWEAK, PROJECTS_CHANNEL);
  if (!handler) return failure("unavailable");
  try { return sanitizeProfilesReadResponse(await handler(request)); }
  catch { return failure("unavailable"); }
}

export const crossTweakReadPolicy = { profilesTweak: PROFILES_TWEAK, followupTweak: FOLLOWUP_TWEAK, projectsTweak: PROJECTS_TWEAK, action: PROFILE_ACTION, followupAction: FOLLOWUP_ACTION } as const;
