import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardStableInputs } from './read-only-inputs.mjs';

test('read-only snapshots reject replacement and new generated files', () => {
  const root = mkdtempSync(join(tmpdir(),'tweakers-read-only-'));
  try {
    const file = join(root,'output');
    writeFileSync(file,'first');
    const unchanged = guardStableInputs([root]);
    unchanged();
    const replaced = guardStableInputs([root]);
    writeFileSync(join(root,'next'),'second');
    renameSync(join(root,'next'),file);
    assert.throws(replaced,/changed during verification/);
    const added = guardStableInputs([root]);
    writeFileSync(join(root,'new'),'new');
    assert.throws(added,/changed during verification/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
