import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { productionDependencyPaths } from './production-dependencies.mjs';

test('production closure includes nested runtime dependencies and excludes development tooling', () => {
  const root = mkdtempSync(join(tmpdir(), 'tweakers-production-deps-'));
  const pkg = (path, value) => { mkdirSync(join(root, path), { recursive: true }); writeFileSync(join(root, path, 'package.json'), JSON.stringify(value)); };
  try {
    pkg('packages/installer', { name: 'installer', dependencies: { alpha: '1' }, devDependencies: { typescript: '1' } });
    pkg('node_modules/alpha', { name: 'alpha', dependencies: { beta: '1' }, optionalDependencies: { absent: '1' } });
    pkg('node_modules/alpha/node_modules/beta', { name: 'beta' });
    pkg('node_modules/typescript', { name: 'typescript' });
    assert.deepEqual(productionDependencyPaths(root, ['packages/installer']), ['node_modules/alpha', 'node_modules/alpha/node_modules/beta']);
    pkg('node_modules/alpha/node_modules/beta', { name: 'beta', dependencies: { missing: '1' } });
    assert.throws(() => productionDependencyPaths(root, ['packages/installer']), /Missing production dependency missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
