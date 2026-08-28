/**
 * Production entrypoint for the first stable Tweakers Manager milestone.
 *
 * This file deliberately links only the read-only status collector. Future
 * action scaffolding lives in separate modules and is not reachable from the
 * shipped bundle or signed launcher.
 */
import { realpathSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_PROTOCOL_VERSION,
  TWEAKERS_MANAGER_ID,
  type ManagerExecutableIdentityV1,
} from "./manager-contract.js";
import { createTweakersManagerReadOnlyStatusSnapshot } from "./manager-status.js";
import { resolveManagerExecutableIdentity } from "./manager-launcher-identity.js";

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface TweakersManagerStatusResponseV1 {
  protocolVersion: typeof MANAGER_PROTOCOL_VERSION;
  managerId: typeof TWEAKERS_MANAGER_ID;
  requestId: string;
  generatedAt: string;
  stateToken: `sha256:${string}`;
  status: ReturnType<typeof createTweakersManagerReadOnlyStatusSnapshot>["status"];
  actions: readonly [];
}

export interface RunTweakersManagerStatusCliDependencies {
  status?: typeof createTweakersManagerReadOnlyStatusSnapshot;
  executable?: () => ManagerExecutableIdentityV1;
  now?: () => string;
  write?: (line: string) => void;
}

export function parseTweakersManagerStatusArguments(argv: readonly string[]): { requestId: string } {
  if (argv.length !== 4 || argv[0] !== "status" || argv[1] !== "--request-id" || argv[3] !== "--json") {
    throw new Error("Expected: status --request-id <lowercase-uuid> --json");
  }
  const requestId = argv[2] ?? "";
  if (!LOWERCASE_UUID.test(requestId)) throw new Error("request-id must be a lowercase RFC4122 UUID");
  return { requestId };
}

export function runTweakersManagerStatusCli(
  argv: readonly string[],
  dependencies: RunTweakersManagerStatusCliDependencies = {},
): number {
  const write = dependencies.write ?? ((line: string) => writeSync(1, line));
  const now = dependencies.now ?? (() => new Date().toISOString());
  let requestId: string | null = maybeRequestId(argv);
  try {
    const parsed = parseTweakersManagerStatusArguments(argv);
    requestId = parsed.requestId;
    const executable = (dependencies.executable ?? resolveManagerExecutableIdentity)();
    const snapshot = (dependencies.status ?? createTweakersManagerReadOnlyStatusSnapshot)({ executable });
    const response: TweakersManagerStatusResponseV1 = {
      protocolVersion: snapshot.protocolVersion,
      managerId: snapshot.managerId,
      requestId: parsed.requestId,
      generatedAt: snapshot.generatedAt,
      stateToken: snapshot.stateToken,
      status: snapshot.status,
      actions: [],
    };
    write(`${JSON.stringify(response)}\n`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({
      protocolVersion: MANAGER_PROTOCOL_VERSION,
      managerId: TWEAKERS_MANAGER_ID,
      requestId,
      generatedAt: safeNow(now),
      error: {
        code: argv[0] && argv[0] !== "status" ? "unsupported_action" : "invalid_request",
        message: errorMessage(error),
        retryable: false,
      },
    })}\n`);
    return 64;
  }
}

export { resolveManagerExecutableIdentity } from "./manager-launcher-identity.js";

function maybeRequestId(argv: readonly string[]): string | null {
  const index = argv.indexOf("--request-id");
  const candidate = index >= 0 ? argv[index + 1] ?? "" : "";
  return LOWERCASE_UUID.test(candidate) ? candidate : null;
}

function safeNow(now: () => string): string {
  try {
    const value = now();
    return RFC3339.test(value) && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint || !isAbsolute(entrypoint)) return false;
  try {
    return realpathSync(entrypoint) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectExecution()) process.exitCode = runTweakersManagerStatusCli(process.argv.slice(2));
