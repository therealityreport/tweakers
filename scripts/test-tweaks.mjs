#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_PATTERN = /\.test\.(?:cjs|js|mjs)$/;

export function discoverTweakTests(root, options = {}) {
  const repositoryRoot = resolve(root);
  const tweaksRoot = join(repositoryRoot, "tweaks");
  if (!existsSync(tweaksRoot) || !lstatSync(tweaksRoot).isDirectory()) {
    throw new Error(`Tweaks directory not found: ${tweaksRoot}`);
  }

  const manifestFolders = readdirSync(tweaksRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(tweaksRoot, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort();
  const selectedFolders = options.tweak
    ? manifestFolders.filter((folder) => folder === options.tweak)
    : manifestFolders;
  if (options.tweak && selectedFolders.length === 0) {
    throw new Error(`Unknown manifest-bearing tweak folder: ${options.tweak}`);
  }

  const discovered = [];
  for (const folder of selectedFolders) {
    const tweakRoot = join(tweaksRoot, folder);
    const tests = ["test", "tests"].flatMap((directory) => (
      collectTestFiles(join(tweakRoot, directory), repositoryRoot)
    ));
    if (tests.length === 0) throw new Error(`Manifest-bearing tweak has no tests: ${folder}`);
    discovered.push(...tests);
  }
  return discovered.sort();
}

function collectTestFiles(directory, repositoryRoot) {
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Tweak test directory must be a real directory: ${relative(repositoryRoot, directory)}`);
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Tweak tests must not contain symlinks: ${relative(repositoryRoot, path)}`);
    if (entry.isDirectory()) files.push(...collectTestFiles(path, repositoryRoot));
    else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) files.push(relative(repositoryRoot, path));
  }
  return files;
}

export function parseArguments(argv) {
  const options = { list: false, tweak: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--list") options.list = true;
    else if (argument === "--tweak" && argv[index + 1]) options.tweak = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return options;
}

export function runTweakTests(root, options = {}) {
  const tests = discoverTweakTests(root, options);
  if (options.list) {
    process.stdout.write(`${tests.join("\n")}\n`);
    return 0;
  }
  const preload = new URL("./test-root-preload.mjs", import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", preload, "--test", ...tests], {
    cwd: resolve(root),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTweakTests(process.cwd(), parseArguments(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
