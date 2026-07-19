import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parsePsOutput, type ProcessInfo } from "./commands/debug.js";

export interface RegularChatGptMcpRuntimeProof {
  ok: boolean;
  mainStartedAt: string | null;
  configModifiedAt: string | null;
  ownedProcessPids: number[];
  error: string | null;
}

export interface RegularChatGptMcpRuntimeProofInput {
  mainPid: number;
  configPath: string;
  tweaksRoot: string;
  configurationChanged: boolean;
}

export interface RegularChatGptMcpRuntimeProofDependencies {
  listProcesses?(): ProcessInfo[];
  configMtimeMs?(path: string): number | null;
}

/**
 * Prove that the running ChatGPT process loaded the already-reconciled MCP
 * configuration. Removing a table does not update an existing app-server's
 * in-memory task registry, so a process that predates the config write must
 * restart before regular ChatGPT mode can be considered fully applied.
 */
export function proveRegularChatGptMcpRuntime(
  input: RegularChatGptMcpRuntimeProofInput,
  dependencies: RegularChatGptMcpRuntimeProofDependencies = {},
): RegularChatGptMcpRuntimeProof {
  const processes = (dependencies.listProcesses ?? listProcessesStrict)();
  const main = processes.find((candidate) => candidate.pid === input.mainPid) ?? null;
  const configMtimeMs = (dependencies.configMtimeMs ?? readConfigMtimeMs)(input.configPath);
  const mainStartedMs = main?.startedAt === null || main?.startedAt === undefined
    ? null
    : Date.parse(main.startedAt);
  const configModifiedAt = configMtimeMs === null ? null : new Date(configMtimeMs).toISOString();
  const mainStartedAt = mainStartedMs === null || !Number.isFinite(mainStartedMs)
    ? null
    : new Date(mainStartedMs).toISOString();

  if (main === null || mainStartedMs === null || !Number.isFinite(mainStartedMs)) {
    return {
      ok: false,
      mainStartedAt,
      configModifiedAt,
      ownedProcessPids: [],
      error: `Could not prove the start time of ChatGPT PID ${input.mainPid}`,
    };
  }

  const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
  const tweaksPrefix = `${resolve(input.tweaksRoot)}${sep}`;
  const ownedProcessPids = processes
    .filter((candidate) => (
      candidate.pid !== input.mainPid
      && candidate.command.includes(tweaksPrefix)
      && processDescendsFrom(candidate, input.mainPid, byPid)
    ))
    .map((candidate) => candidate.pid)
    .sort((left, right) => left - right);

  if (input.configurationChanged) {
    return {
      ok: false,
      mainStartedAt,
      configModifiedAt,
      ownedProcessPids,
      error: "Tweakers MCP configuration changed after ChatGPT started; restart ChatGPT to apply regular mode",
    };
  }
  // `ps lstart` has one-second precision while stat has sub-second precision.
  // A one-second tolerance accepts a config written immediately before launch,
  // but never a write from a later wall-clock second.
  if (configMtimeMs !== null && mainStartedMs + 1_000 < configMtimeMs) {
    return {
      ok: false,
      mainStartedAt,
      configModifiedAt,
      ownedProcessPids,
      error: "ChatGPT started before its current MCP configuration; restart ChatGPT to apply regular mode",
    };
  }
  if (ownedProcessPids.length > 0) {
    return {
      ok: false,
      mainStartedAt,
      configModifiedAt,
      ownedProcessPids,
      error: `Tweakers-owned processes are still active under ChatGPT (${ownedProcessPids.join(", ")})`,
    };
  }
  return {
    ok: true,
    mainStartedAt,
    configModifiedAt,
    ownedProcessPids: [],
    error: null,
  };
}

function processDescendsFrom(
  candidate: ProcessInfo,
  ancestorPid: number,
  byPid: ReadonlyMap<number, ProcessInfo>,
): boolean {
  const visited = new Set<number>([candidate.pid]);
  let parent = candidate.ppid;
  while (parent !== null && parent > 0 && !visited.has(parent)) {
    if (parent === ancestorPid) return true;
    visited.add(parent);
    parent = byPid.get(parent)?.ppid ?? null;
  }
  return false;
}

function listProcessesStrict(): ProcessInfo[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,lstart=,args="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return parsePsOutput(output);
}

function readConfigMtimeMs(path: string): number | null {
  return existsSync(path) ? statSync(path).mtimeMs : null;
}
