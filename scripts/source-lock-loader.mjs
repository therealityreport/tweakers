// Source build ownership must work before SDK dist exists. Published installer
// code retains its normal SDK dist import; only checkout build scripts install
// this narrow loader, after tsx has registered TypeScript transformation.
const sourceLock = new URL('../packages/sdk/src/process-lock.ts', import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@therealityreport/tweakers-sdk/dist/process-lock.js'
    && context.parentURL === new URL('../packages/installer/src/process-lock.ts', import.meta.url).href) {
    return { url: sourceLock, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
