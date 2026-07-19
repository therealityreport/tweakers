import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalCliRuntimeInput {
  cli: string;
  args: string[];
  userRoot: string;
  resourcesPath: string;
  execPath: string;
  env: NodeJS.ProcessEnv;
}

export interface LocalCliRuntimeResult {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** Read the exact Node executable captured when Tweakers installed its shim. */
export function nodeExecutableFromCliShim(source: string): string | null {
  const match = source.match(/^exec\s+"([^"]+)"\s+"[^"]+"\s+"\$@"\s*$/m);
  return match?.[1]?.trim() || null;
}

export function resolveLocalCliRuntime(input: LocalCliRuntimeInput): LocalCliRuntimeResult {
  const shim = join(input.userRoot, "bin", "tweaker");
  try {
    const shimNode = nodeExecutableFromCliShim(readFileSync(shim, "utf8"));
    if (shimNode && existsSync(shimNode)) {
      return { command: shimNode, args: [input.cli, ...input.args], env: input.env };
    }
  } catch {
    // A missing/legacy shim falls through to the bundled runtime below.
  }

  const bundledNode = join(input.resourcesPath, "cua_node", "bin", "node");
  if (existsSync(bundledNode)) {
    return { command: bundledNode, args: [input.cli, ...input.args], env: input.env };
  }
  return {
    command: input.execPath,
    args: [input.cli, ...input.args],
    env: { ...input.env, ELECTRON_RUN_AS_NODE: "1" },
  };
}
