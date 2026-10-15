import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** Resolve the installed production graph without invoking npm or copying dev tools. */
export function productionDependencyPaths(root, entryPackages) {
  root = realpathSync(root);
  const selected = new Set();
  const visited = new Set();
  const visit = directory => {
    const canonical = realpathSync(directory);
    if (visited.has(canonical)) return;
    if (!canonical.startsWith(root + '/')) throw new Error(`Dependency escapes checkout: ${directory}`);
    visited.add(canonical);
    const manifest = JSON.parse(readFileSync(join(canonical, 'package.json'), 'utf8'));
    const optional = manifest.optionalDependencies ?? {};
    const dependencies = { ...manifest.dependencies, ...optional };
    for (const name of Object.keys(dependencies).sort()) {
      // Doctor always supplies its verified reviewerBinary as codexPathOverride.
      // The SDK's fallback CLI is not an executable dependency of this runtime.
      if (manifest.name === '@openai/codex-sdk' && name === '@openai/codex') continue;
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Unsafe dependency name: ${name}`);
      let current = canonical, found;
      while (current === root || current.startsWith(root + '/')) {
        const candidate = join(current, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) { found = candidate; break; }
        if (current === root) break;
        current = dirname(current);
      }
      if (!found) {
        if (Object.hasOwn(optional, name)) continue;
        throw new Error(`Missing production dependency ${name} required by ${manifest.name}`);
      }
      selected.add(relative(root, found));
      visit(found);
    }
  };
  for (const entry of entryPackages) visit(resolve(root, entry));
  return [...selected].sort();
}
