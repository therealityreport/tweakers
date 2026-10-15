import { ownEntrypoint } from "../../../scripts/owned-entrypoint.mjs";
await ownEntrypoint(import.meta.url);
/**
 * Bundles both the renderer-side preload AND the main-process entry into
 * single files. Both run inside Codex.app's runtime — we don't want to ship
 * a node_modules tree, so we bundle deps in. `electron` and Node built-ins
 * stay external because they're provided by the host.
 */
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

await build({
  entryPoints: [resolve(root, "src/preload/index.ts")],
  bundle: true,
  outfile: resolve(root, "dist/preload.js"),
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["electron"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

await build({
  entryPoints: [resolve(root, "src/promotion-health-preload.ts")],
  bundle: true,
  outfile: resolve(root, "dist/promotion-health-preload.js"),
  platform: "browser",
  target: "es2022",
  format: "cjs",
  external: ["electron"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
});

await build({
  entryPoints: [resolve(root, "src/main.ts")],
  bundle: true,
  outfile: resolve(root, "dist/main.js"),
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["electron", "original-fs"],
  sourcemap: "inline",
  minify: false,
  logLevel: "info",
  // chokidar uses dynamic native fsevents on macOS via optional dep; let
  // esbuild treat any failure to resolve as an empty module so we degrade
  // gracefully to polling on platforms without it. (chokidar v4 already
  // handles missing fsevents internally — this is just future-proofing.)
});

// The standalone broker and installer load this module outside main.js.
// Include its TOML parser so sealed runtimes need no ambient node_modules.
for (const entry of ["account-continuity", "desktop-app-tools"]) {
  await build({
    entryPoints: [resolve(root, `src/account-router/${entry}.ts`)],
    bundle: true,
    outfile: resolve(root, `dist/account-router/${entry}.js`),
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: true,
    minify: false,
    logLevel: "info",
  });
}

// The sealed Manager imports this entry directly, outside bundled main.js.
// Keep runtime-local modules shared while embedding the SDK lock implementation.
await build({
  entryPoints: [resolve(root, "src/account-router/broker-socket.ts")],
  bundle: true,
  outfile: resolve(root, "dist/account-router/broker-socket.js"),
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["./*", "../*"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

console.log("[bundle] preload + promotion health preload + main + account continuity + desktop app tools + broker socket bundled");
