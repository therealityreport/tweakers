/**
 * Build the fixed-protocol manager as one deployable ESM file. The immutable
 * launcher never executes a source checkout or a node_modules tree, so every
 * non-Node dependency must be bundled here before publication.
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const FORBIDDEN_MANAGER_INPUT = /(?:^|\/)(?:node_modules\/@electron\/asar|asar\.ts$|cli\.ts$|commands\/|environment-transaction\.ts$|desktop-update-transaction\.ts$|transaction\.ts$|manager-action-[^/]+\.ts$|manager-operation-store\.ts$|manager-environment-action\.ts$|lifecycle-lock(?:-core)?\.ts$)/;

export async function buildTweakersManagerBundle(options = {}) {
  const entryPoint = resolve(options.entryPoint ?? resolve(packageRoot, "src", "manager-status-cli.ts"));
  const outfile = resolve(options.outfile ?? resolve(packageRoot, "dist", "manager.mjs"));
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
    minify: false,
    sourcemap: false,
    metafile: true,
    plugins: [statusOnlyBoundaryPlugin()],
    logLevel: options.logLevel ?? "info",
  });
  assertTweakersManagerBundleMetafile(result.metafile, outfile);
  if (!existsSync(outfile)) throw new Error(`Tweakers manager bundle was not written: ${outfile}`);
  return { outfile, metafile: result.metafile };
}

/**
 * The shared source status collector retains dormant operation projections for
 * action-scaffolding tests. The production entrypoint never calls them; this
 * sealed replacement makes that boundary explicit before tree shaking so the
 * deployable graph cannot load the mutating operation-store module.
 */
function statusOnlyBoundaryPlugin() {
  return {
    name: "tweakers-manager-status-only-boundary",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^\.\/manager-operation-store\.js$/ }, () => ({
        path: "manager-operation-store",
        namespace: "tweakers-manager-status-only",
      }));
      buildContext.onLoad({ filter: /.*/, namespace: "tweakers-manager-status-only" }, () => ({
        contents: `
          export function isManagerOperationId() { throw new Error("operation store is unavailable in the status-only manager"); }
          export function parsePreparedOperation() { throw new Error("operation store is unavailable in the status-only manager"); }
        `,
        loader: "js",
      }));
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
    if (!imported.path.startsWith("node:")) {
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
  await buildTweakersManagerBundle();
  console.log("[build-manager] bundled status-only Tweakers manager with Node-only externals");
}
