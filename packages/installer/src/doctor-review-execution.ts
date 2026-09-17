import { Codex, type CodexOptions, type ModelReasoningEffort, type ThreadEvent } from "@openai/codex-sdk";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DoctorSourceReviewDependencies, ReviewerRunResult } from "./doctor-review.js";
import { readDoctorPrivateJson, writeDoctorPrivateJson } from "./doctor-store.js";

/** A missing safeguard denies SDK dispatch. These facts describe the pinned 0.154.0 SDK. */
export const DOCTOR_SDK_CAPABILITIES = Object.freeze({
  exactBinary: true, explicitEnvironment: true, structuredOutput: true, readOnly: true,
  modelAndEffort: true, webDisabled: true, projectDocsDisabled: true,
  ephemeral: false, ignoreUserConfig: false, shellDisabled: false,
  boundedOutput: false, boundedTime: true,
});
export type DoctorSdkCapabilities = { [K in keyof typeof DOCTOR_SDK_CAPABILITIES]: boolean };
export type DoctorSdkClient = Pick<Codex, "startThread">;
export const DOCTOR_MODEL_EXECUTION_PAUSED = "Doctor model execution is disabled until token policy is agreed. Inspect the concrete failed check; no model request was sent.";

export function assertDoctorModelExecutionAllowed(dependencies: { simulationOnly?: boolean }): void {
  if (!(dependencies.simulationOnly === true && process.env.NODE_TEST_CONTEXT)) throw new Error(DOCTOR_MODEL_EXECUTION_PAUSED);
}

export interface DoctorExecutionDependencies {
  /** Existing injected test runners only; never set by production callers. */
  simulationOnly?: boolean;
  run: DoctorSourceReviewDependencies["run"];
  /** Only the existing test injection path may supply a simulated capability set/client. */
  sdkCapabilitiesForTest?: DoctorSdkCapabilities;
  sdkClientForTest?: (options: CodexOptions) => DoctorSdkClient;
}
export interface DoctorExecutionInput {
  reviewerBinary: string; model: string; effort: string | undefined; outputRoot: string;
  schemaPath: string; outputPath: string; prompt: string; codexHome?: string;
}
export interface DoctorExecutionAdapter {
  readonly identity: "cli-v1" | "sdk-0.154.0";
  execute(input: DoctorExecutionInput): Promise<ReviewerRunResult>;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20 * 60 * 1000;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);

export function selectDoctorExecutionAdapter(dependencies: DoctorExecutionDependencies): DoctorExecutionAdapter {
  const capabilities = dependencies.sdkCapabilitiesForTest ?? DOCTOR_SDK_CAPABILITIES;
  if (Object.values(capabilities).every(value => value === true)) {
    return { identity: "sdk-0.154.0", execute: input => { assertDoctorModelExecutionAllowed(dependencies); return executeSdk(input, dependencies.sdkClientForTest ?? (options => new Codex(options))); } };
  }
  return { identity: "cli-v1", execute: async input => { assertDoctorModelExecutionAllowed(dependencies); return executeCli(input, dependencies.run); } };
}

function executionEnv(input: DoctorExecutionInput): Record<string, string> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { ...inherited, HOME: process.env.HOME ?? homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/usr/bin",
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}) };
}

function executeCli(input: DoctorExecutionInput, run: DoctorSourceReviewDependencies["run"]): ReviewerRunResult {
  const previousUmask = process.umask(0o077);
  try {
    return run(input.reviewerBinary, ["exec", "--ephemeral", "--ignore-user-config", ...(input.codexHome ? ["-c", 'cli_auth_credentials_store="file"'] : []),
      "--disable", "shell_tool", "--disable", "unified_exec", "-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0",
      "--sandbox", "read-only", "--json", "--output-schema", input.schemaPath, "--output-last-message", input.outputPath,
      "--skip-git-repo-check", "--cd", input.outputRoot, "--model", input.model,
      "-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`, "-"], {
      cwd: input.outputRoot, env: executionEnv(input), input: input.prompt, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
  } finally { process.umask(previousUmask); }
}

async function executeSdk(input: DoctorExecutionInput, factory: (options: CodexOptions) => DoctorSdkClient): Promise<ReviewerRunResult> {
  if (!isAbsolute(input.reviewerBinary) || resolve(input.reviewerBinary) !== input.reviewerBinary
    || realpathSync(input.reviewerBinary) !== input.reviewerBinary || !lstatSync(input.reviewerBinary).isFile()) {
    throw new Error("The SDK reviewer binary is not an exact regular file");
  }
  if (!EFFORTS.has(input.effort ?? "")) throw new Error("The configured review effort is unsupported by the pinned SDK");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const previousUmask = process.umask(0o077);
  let bytes = 0;
  const events: string[] = [];
  let finalResponse: string | null = null;
  let completed = false;
  try {
    const client = factory({ codexPathOverride: input.reviewerBinary, env: executionEnv(input),
      config: { cli_auth_credentials_store: "file", project_doc_max_bytes: 0, features: { shell_tool: false, unified_exec: false } } });
    const thread = client.startThread({ model: input.model, modelReasoningEffort: input.effort as ModelReasoningEffort,
      sandboxMode: "read-only", approvalPolicy: "never", webSearchMode: "disabled", workingDirectory: input.outputRoot,
      skipGitRepoCheck: true });
    const schema = readDoctorPrivateJson(input.schemaPath);
    const stream = await thread.runStreamed(input.prompt, { outputSchema: schema, signal: controller.signal });
    for await (const event of stream.events) {
      const line = JSON.stringify(event as ThreadEvent);
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > MAX_OUTPUT_BYTES) { controller.abort(); throw new Error("The SDK review exceeded its retained event limit"); }
      events.push(line);
      if (event.type === "item.completed" && event.item.type === "agent_message") finalResponse = event.item.text;
      if (event.type === "turn.completed") completed = true;
    }
    if (!completed) throw new Error("The SDK review did not report a completed turn");
    if (finalResponse === null || Buffer.byteLength(finalResponse) > MAX_MESSAGE_BYTES) throw new Error("The SDK review has no bounded final response");
    writeDoctorPrivateJson(input.outputPath, JSON.parse(finalResponse));
    return { status: 0, stdout: events.join("\n") };
  } catch (error) {
    // Retain any usage observed before a failed stream; the caller never switches runners.
    return { status: 1, stdout: events.join("\n"), stderr: String(error).slice(0, 4_096) };
  } finally {
    clearTimeout(timer);
    process.umask(previousUmask);
  }
}
