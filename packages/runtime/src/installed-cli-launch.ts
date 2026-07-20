export type InstalledCliCommandKind = "start" | "resume" | "reconcile" | "cancel" | "other";

export interface InstalledCliCommandClassification {
  commandKind: InstalledCliCommandKind;
  cutover: boolean;
}

export const MAX_LAUNCHCTL_OUTPUT_BYTES = 64 * 1024;
const MAX_LAUNCHCTL_EVIDENCE_CHARS = 4_096;

export interface LaunchdSubmitResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}

export interface LaunchdSubmitOptions {
  encoding: "utf8";
  maxBuffer: number;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface InstalledCliLaunchEvent {
  event: "desktop-update-launch";
  commandKind: InstalledCliCommandKind;
  jobLabel: string;
  submitResult: "submitted" | "failed";
  status: number | null;
  error?: string;
}

export interface InstalledCliLaunchdInput {
  classification: InstalledCliCommandClassification;
  label: string;
  cwd: string;
  command: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export interface InstalledCliLaunchdDependencies {
  submit(
    command: string,
    args: readonly string[],
    options: LaunchdSubmitOptions,
  ): LaunchdSubmitResult;
  onEvent?(event: InstalledCliLaunchEvent): void;
}

export class DesktopUpdateLaunchSubmissionError extends Error {
  readonly code = "TWEAKERS_DESKTOP_UPDATE_LAUNCH_SUBMISSION_FAILED";

  constructor(
    readonly commandKind: InstalledCliCommandKind,
    readonly jobLabel: string,
    detail: string,
  ) {
    super(`launchctl submit failed for desktop-update ${commandKind}: ${detail}`);
    this.name = "DesktopUpdateLaunchSubmissionError";
  }
}

export function classifyInstalledCliCommand(args: readonly string[]): InstalledCliCommandClassification {
  switch (args[0]) {
    case "update-chatgpt":
      return { commandKind: "start", cutover: true };
    case "update-chatgpt-resume":
      return { commandKind: "resume", cutover: true };
    case "update-chatgpt-reconcile":
      return { commandKind: "reconcile", cutover: true };
    case "update-chatgpt-cancel":
      return { commandKind: "cancel", cutover: false };
    default:
      return { commandKind: "other", cutover: false };
  }
}

export function submitInstalledCliWithLaunchd(
  input: InstalledCliLaunchdInput,
  dependencies: InstalledCliLaunchdDependencies,
): boolean {
  const shellCommand = buildInstalledCliShell(input);
  let result: LaunchdSubmitResult;
  try {
    result = dependencies.submit(
      "launchctl",
      ["submit", "-l", input.label, "--", "/bin/sh", "-c", shellCommand],
      {
        encoding: "utf8",
        maxBuffer: MAX_LAUNCHCTL_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    result = {
      status: null,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
  if (result.status === 0) {
    dependencies.onEvent?.({
      event: "desktop-update-launch",
      commandKind: input.classification.commandKind,
      jobLabel: input.label,
      submitResult: "submitted",
      status: 0,
    });
    return true;
  }

  const detail = launchctlFailureDetail(result);
  dependencies.onEvent?.({
    event: "desktop-update-launch",
    commandKind: input.classification.commandKind,
    jobLabel: input.label,
    submitResult: "failed",
    status: result.status,
    error: detail,
  });
  if (input.classification.cutover) {
    throw new DesktopUpdateLaunchSubmissionError(
      input.classification.commandKind,
      input.label,
      detail,
    );
  }
  return false;
}

export function buildTransientLaunchdExitTrap(label: string): string {
  const quotedLabel = shellQuote(label);
  return [
    "cleanup_transient_launchd_job() {",
    "  status=$?",
    "  trap - EXIT HUP INT TERM",
    `  launchctl remove ${quotedLabel} >/dev/null 2>&1 || launchctl bootout gui/$(id -u)/${quotedLabel} >/dev/null 2>&1`,
    '  exit "$status"',
    "}",
    "trap cleanup_transient_launchd_job EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
  ].join("\n");
}

function buildInstalledCliShell(input: InstalledCliLaunchdInput): string {
  const assignments = Object.entries(input.environment).map(([name, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid launch environment variable name: ${name}`);
    }
    return `${name}=${shellQuote(value)}`;
  });
  return [
    buildTransientLaunchdExitTrap(input.label),
    `cd ${shellQuote(input.cwd)} || exit $?`,
    ["env", ...assignments, input.command, ...input.args].map(shellQuoteWord).join(" "),
  ].join("\n");
}

function launchctlFailureDetail(result: LaunchdSubmitResult): string {
  const raw = result.error?.message
    ?? cleanOutput(result.stderr)
    ?? cleanOutput(result.stdout)
    ?? (result.signal ? `signal ${result.signal}` : `status ${result.status ?? "unknown"}`);
  return raw.length <= MAX_LAUNCHCTL_EVIDENCE_CHARS
    ? raw
    : `${raw.slice(0, MAX_LAUNCHCTL_EVIDENCE_CHARS - 1)}…`;
}

function cleanOutput(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function shellQuoteWord(value: string): string {
  const assignment = /^([A-Z_][A-Z0-9_]*)=(.*)$/s.exec(value);
  return assignment ? `${assignment[1]}=${assignment[2]}` : shellQuote(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
