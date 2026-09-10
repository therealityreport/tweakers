/**
 * Build the fixed-protocol manager as one deployable ESM file. The immutable
 * launcher never executes a source checkout or a node_modules tree, so every
 * non-Node dependency must be bundled here before publication.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const FORBIDDEN_MANAGER_INPUT = /(?:^|\/)(?:cli\.ts$)/;
const RUNTIME_FINGERPRINT = /^[a-f0-9]{64}$/;
export const MANAGER_RUNTIME_FINGERPRINT_MARKER = "TWEAKERS_MANAGER_RUNTIME_FINGERPRINT_V1";
export const MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER = "TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT_V1";
const MANAGER_MANAGED_RUNTIME_COPY_ALLOWLIST = [
  "package.json",
  "package-lock.json",
  "bin",
  "node_modules",
  "packages/installer/package.json",
  "packages/installer/dist",
  "packages/installer/assets",
  "packages/sdk/package.json",
  "packages/sdk/dist",
];

export async function buildTweakersManagerBundle(options = {}) {
  const entryPoint = resolve(options.entryPoint ?? resolve(packageRoot, "src", "manager-cli.ts"));
  const outfile = resolve(options.outfile ?? resolve(packageRoot, "dist", "manager.mjs"));
  const bootstrap = options.bootstrap === true;
  const runtimeFingerprint = options.runtimeFingerprint
    ?? readPackagedRuntimeFingerprint(resolve(packageRoot, "assets", "runtime", "runtime-fingerprint.json"));
  let managedRuntimeFingerprint;
  if (bootstrap) {
    if (options.managedRuntimeFingerprint !== undefined) {
      throw new Error("Bootstrap manager build cannot accept a managed-runtime fingerprint");
    }
  } else {
    managedRuntimeFingerprint = options.managedRuntimeFingerprint
      ?? readPackagedManagedRuntimeFingerprint(
        resolve(packageRoot, "assets", "managed-runtime", "managed-runtime-fingerprint.json"),
      );
  }
  if (typeof runtimeFingerprint !== "string" || !RUNTIME_FINGERPRINT.test(runtimeFingerprint)) {
    throw new Error("Tweakers manager build requires one valid packaged runtime fingerprint");
  }
  if (managedRuntimeFingerprint !== undefined
    && (typeof managedRuntimeFingerprint !== "string" || !RUNTIME_FINGERPRINT.test(managedRuntimeFingerprint))) {
    throw new Error("Tweakers manager build requires one valid packaged managed-runtime fingerprint");
  }
  if (!existsSync(entryPoint)) throw new Error(`Tweakers manager entrypoint is missing: ${entryPoint}`);
  mkdirSync(dirname(outfile), { recursive: true });
  rmSync(outfile, { force: true });
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    outfile,
    platform: "node",
    target: "node20",
    format: "esm",
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __tweakersCreateRequire } from "node:module"; const require = __tweakersCreateRequire(import.meta.url);',
    },
    minify: false,
    sourcemap: false,
    define: {
      __TWEAKERS_MANAGER_RUNTIME_FINGERPRINT__: JSON.stringify(runtimeFingerprint),
      ...(managedRuntimeFingerprint === undefined ? {} : {
        __TWEAKERS_MANAGER_MANAGED_RUNTIME_FINGERPRINT__: JSON.stringify(managedRuntimeFingerprint),
      }),
    },
    metafile: true,
    plugins: [nodeOriginalFsPlugin()],
    logLevel: options.logLevel ?? "info",
  });
  assertTweakersManagerBundleMetafile(result.metafile, outfile);
  if (!existsSync(outfile)) throw new Error(`Tweakers manager bundle was not written: ${outfile}`);
  const generated = readFileSync(outfile, "utf8");
  const normalized = generated.replace(/[\t ]+$/gm, "").replace(/\n*$/, "");
  const managedSeal = managedRuntimeFingerprint === undefined
    ? ""
    : `//# ${MANAGER_MANAGED_RUNTIME_FINGERPRINT_MARKER}=${managedRuntimeFingerprint}\n`;
  const sealed = `${normalized}\n//# ${MANAGER_RUNTIME_FINGERPRINT_MARKER}=${runtimeFingerprint}\n${managedSeal}`;
  if (sealed !== generated) writeFileSync(outfile, sealed);
  return { outfile, metafile: result.metafile };
}

function readPackagedRuntimeFingerprint(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Tweakers manager could not read the packaged runtime fingerprint at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value?.schemaVersion !== 1
    || typeof value.fingerprint !== "string"
    || !RUNTIME_FINGERPRINT.test(value.fingerprint)
    || !Number.isInteger(value.fileCount)
    || value.fileCount < 0) {
    throw new Error(`Tweakers manager packaged runtime fingerprint is malformed: ${path}`);
  }
  return value.fingerprint;
}

export function readPackagedManagedRuntimeFingerprint(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Tweakers manager could not read the packaged managed-runtime fingerprint at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value?.schemaVersion !== 1
    || typeof value.fingerprint !== "string"
    || !RUNTIME_FINGERPRINT.test(value.fingerprint)
    || !Number.isInteger(value.fileCount)
    || value.fileCount < 0) {
    throw new Error(`Tweakers manager packaged managed-runtime fingerprint is malformed: ${path}`);
  }
  const actual = fingerprintManagedRuntimeSource(dirname(path));
  if (actual.fingerprint !== value.fingerprint || actual.fileCount !== value.fileCount) {
    throw new Error(`Tweakers manager packaged managed-runtime fingerprint is stale: ${path}`);
  }
  return value.fingerprint;
}

function fingerprintManagedRuntimeSource(root) {
  const hash = createHash("sha256");
  let fileCount = 0;
  const add = (type, relativePath, mode, payload) => {
    hash.update(`${type}\0${relativePath.replaceAll("\\", "/")}\0${(mode & 0o7777).toString(8)}\0${payload.length}\0`);
    hash.update(payload);
  };
  const visit = (path) => {
    const stat = lstatSync(path);
    const relativePath = relative(root, path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      add("directory", relativePath, stat.mode, Buffer.alloc(0));
      for (const entry of readdirSync(path).sort((left, right) => left.localeCompare(right))) {
        if (entry === ".DS_Store") continue;
        visit(join(path, entry));
      }
    } else if (stat.isFile()) {
      fileCount += 1;
      add("file", relativePath, stat.mode, readFileSync(path));
    } else if (stat.isSymbolicLink()) {
      add("symlink", relativePath, stat.mode, Buffer.from(readlinkSync(path), "utf8"));
    } else {
      throw new Error(`Managed-runtime source contains unsupported special entry ${path}`);
    }
  };
  for (const relativePath of MANAGER_MANAGED_RUNTIME_COPY_ALLOWLIST) {
    const path = join(root, relativePath);
    if (!existsSync(path)) {
      hash.update(`missing\0${relativePath.replaceAll("\\", "/")}\0`);
      continue;
    }
    visit(path);
  }
  return { fingerprint: hash.digest("hex"), fileCount };
}

function nodeOriginalFsPlugin() {
  return {
    name: "tweakers-manager-node-original-fs",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^original-fs$/ }, () => ({ path: "node:fs", external: true }));
    },
  };
}

/** Exported for fixtures: no npm/package/non-Node external may survive. */
export function assertTweakersManagerBundleMetafile(metafile, outfile) {
  if (!metafile || typeof metafile !== "object" || !metafile.outputs || typeof metafile.outputs !== "object") {
    throw new Error("Tweakers manager esbuild metafile is missing outputs");
  }
  const normalized = resolve(outfile);
  const entry = Object.entries(metafile.outputs).find(([candidate]) => resolve(candidate) === normalized);
  if (!entry) throw new Error(`Tweakers manager esbuild metafile has no output entry for ${normalized}`);
  const [, output] = entry;
  if (!output || typeof output !== "object" || !Array.isArray(output.imports)) {
    throw new Error("Tweakers manager esbuild metafile has no output imports list");
  }
  for (const imported of output.imports) {
    if (!imported || typeof imported !== "object" || imported.external !== true || typeof imported.path !== "string") {
      throw new Error("Tweakers manager esbuild metafile contains an invalid external import record");
    }
    if (!imported.path.startsWith("node:") && !builtinModules.includes(imported.path)) {
      throw new Error(`Tweakers manager bundle has forbidden non-Node external: ${imported.path}`);
    }
  }
  for (const input of Object.keys(metafile.inputs ?? {})) {
    if (FORBIDDEN_MANAGER_INPUT.test(input)) {
      throw new Error(`Tweakers manager bundle contains forbidden broad input: ${input}`);
    }
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--bootstrap")) {
    throw new Error("Usage: node packages/installer/scripts/build-manager.mjs [--bootstrap]");
  }
  const bootstrap = args[0] === "--bootstrap";
  await buildTweakersManagerBundle({ bootstrap });
  console.log(`[build-manager] bundled the ${bootstrap ? "bootstrap" : "final runtime-bound"} fixed-action Tweakers manager with Node-only externals`);
}
