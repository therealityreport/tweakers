import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { register } from 'tsx/esm/api';
import { assertNoVerifierArguments, assertRuntimeRepairInputsUnchanged, captureRuntimeRepairCheck,
  createRuntimeRepairPublicationValidator, pinPrivateEvidenceDirectory, publishRuntimeRepairReceipt,
  findReusableRuntimeRepairTypecheck, readPrivateEvidence, retireRuntimeRepairReceipt,
  snapshotRuntimeRepairInputs, writePrivateEvidence } from './verify-runtime-repair-source.mjs';

register();
const custody = await import('../packages/installer/src/runtime-repair-source-custody.ts');

function fixture(callback) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tweakers-repair-verifier-')));
  chmodSync(root, 0o700);
  const cachePath = join(root, 'cache'), runPath = join(root, 'run'), outside = join(root, 'outside');
  for (const path of [cachePath, runPath, outside]) mkdirSync(path, {mode: 0o700});
  const cache = pinPrivateEvidenceDirectory(cachePath), run = pinPrivateEvidenceDirectory(runPath);
  try { callback({root, cachePath, runPath, outside, cache, run}); }
  finally { cache.close(); run.close(); rmSync(root, {recursive: true, force: true}); }
}

test('runtime repair verifier rejects every caller argument before execution', () => {
  assertNoVerifierArguments(['node', 'verifier']);
  for (const arg of ['--root=/elsewhere', '--passed', '--scope=all', '--command=true', '--help']) {
    assert.throws(() => assertNoVerifierArguments(['node', 'verifier', arg]), /accepts no arguments/);
  }
  const entry = join(dirname(fileURLToPath(import.meta.url)), 'verify-runtime-repair-source.mjs');
  const rejected = captureRuntimeRepairCheck(realpathSync(process.execPath), [entry, '--passed'], realpathSync(process.cwd()));
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.stderr.toString(), /accepts no arguments/);
});

test('runtime repair verifier captures successful raw stdout and stderr with actual command and cwd', () => {
  const cwd = realpathSync(process.cwd());
  const argv = ['-e', 'process.stdout.write(Buffer.from([0,255,10])); process.stderr.write("warning\\n")'];
  const actual = captureRuntimeRepairCheck(realpathSync(process.execPath), argv, cwd);
  assert.equal(actual.exitCode, 0);
  assert.equal(actual.signal, null);
  assert.equal(actual.errorCode, null);
  assert.deepEqual(actual.stdout, Buffer.from([0, 255, 10]));
  assert.equal(actual.stderr.toString(), 'warning\n');
  assert.deepEqual(actual.argv, argv);
  assert.equal(actual.cwd, cwd);
  assert.ok(Date.parse(actual.completedAt) >= Date.parse(actual.startedAt));
});

test('runtime repair verifier retains actual failing exit and both output streams', () => {
  const actual = captureRuntimeRepairCheck(realpathSync(process.execPath),
    ['-e', 'process.stdout.write("partial"); process.stderr.write("failure"); process.exit(7)'], realpathSync(process.cwd()));
  assert.equal(actual.exitCode, 7);
  assert.equal(actual.stdout.toString(), 'partial');
  assert.equal(actual.stderr.toString(), 'failure');
  const missing = captureRuntimeRepairCheck('/nonexistent/tweakers-node', [], realpathSync(process.cwd()));
  assert.equal(missing.exitCode, null);
  assert.equal(missing.errorCode, 'ENOENT');
});

test('runtime repair verifier writes exclusive private immutable evidence and exact byte hashes', () => {
  fixture(({cache}) => {
    const bytes = Buffer.from([0, 255, 10]);
    const ref = writePrivateEvidence(cache, '0.stderr.log', bytes);
    assert.equal(ref.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(readPrivateEvidence(cache, '0.stderr.log'), bytes);
    assert.equal(lstatSync(join(cache.path, '0.stderr.log')).mode & 0o777, 0o600);
    assert.throws(() => writePrivateEvidence(cache, '0.stderr.log', 'overwrite'), /EEXIST/);
    assert.throws(() => writePrivateEvidence(cache, '../escaped.log', 'overwrite'), /unsafe evidence leaf/);
  });
});

test('runtime repair verifier rejects linked and hardlinked receipt leaves without touching targets', () => {
  fixture(({cache, cachePath, outside}) => {
    const protectedFile = join(outside, 'canonical.json');
    writeFileSync(protectedFile, 'canonical', {mode: 0o600});
    symlinkSync(protectedFile, join(cachePath, 'checks.json'));
    assert.throws(() => readPrivateEvidence(cache, 'checks.json'), /ELOOP|unsafe evidence file/);
    assert.throws(() => writePrivateEvidence(cache, 'checks.json', 'damage'), /EEXIST|ELOOP/);
    linkSync(protectedFile, join(cachePath, 'hardlink.json'));
    assert.throws(() => readPrivateEvidence(cache, 'hardlink.json'), /unsafe evidence file/);
    assert.equal(readFileSync(protectedFile, 'utf8'), 'canonical');
  });
});

test('runtime repair verifier rejects replaced cache ancestors before any leaf write', () => {
  fixture(({cache, cachePath, outside}) => {
    writeFileSync(join(outside, 'proof.json'), 'canonical proof', {mode: 0o600});
    renameSync(cachePath, cachePath + '-retained');
    symlinkSync(outside, cachePath);
    assert.throws(() => writePrivateEvidence(cache, 'proof.json', 'damage'), /linked evidence ancestor|directory changed/);
    assert.equal(readFileSync(join(outside, 'proof.json'), 'utf8'), 'canonical proof');
    assert.equal(existsSync(join(cachePath + '-retained', 'proof.json')), false);
  });
});

test('runtime repair verifier anchors in-flight relative sink writes despite replaced parent namespace', () => {
  fixture(({root, cache, cachePath, outside}) => {
    writeFileSync(join(outside, 'proof.json'), 'canonical proof', {mode: 0o600});
    const previous = process.cwd();
    assert.throws(() => cache.within(() => {
      renameSync(cachePath, cachePath + '-retained');
      symlinkSync(outside, cachePath);
      writeFileSync('proof.json', 'isolated evidence', {flag: 'wx', mode: 0o600});
    }), /linked evidence ancestor|directory changed/);
    assert.equal(process.cwd(), previous);
    assert.equal(readFileSync(join(outside, 'proof.json'), 'utf8'), 'canonical proof');
    assert.equal(readFileSync(join(root, 'cache-retained', 'proof.json'), 'utf8'), 'isolated evidence');
  });
});

test('runtime repair verifier preserves prior evidence and removes accepted pointer before failed rerun', () => {
  fixture(({cache, run, cachePath, runPath}) => {
    const old = Buffer.from('{"prior":"successful"}\n');
    writePrivateEvidence(cache, 'checks.json', old);
    writePrivateEvidence(cache, 'old.stdout.log', 'prior output');
    retireRuntimeRepairReceipt(cache, run);
    assert.equal(existsSync(join(cachePath, 'checks.json')), false);
    assert.deepEqual(readFileSync(join(runPath, 'prior-checks.json')), old);
    assert.equal(readPrivateEvidence(cache, 'old.stdout.log').toString(), 'prior output');
    const actual = captureRuntimeRepairCheck(realpathSync(process.execPath), ['-e', 'process.exit(7)'], realpathSync(process.cwd()));
    assert.equal(actual.exitCode, 7);
    assert.equal(existsSync(join(cachePath, 'checks.json')), false);
    retireRuntimeRepairReceipt(cache, run); // Missing pointer is not invented success.
  });
});

test('runtime repair verifier refuses nonprivate directories and exact source dependency tool drift', () => {
  fixture(({cachePath}) => {
    chmodSync(cachePath, 0o755);
    assert.throws(() => pinPrivateEvidenceDirectory(cachePath), /not private/);
  });
  const before = {sourceFiles: [{relativePath: 'source.ts', mode: 0o644, sha256: 'a'}], inputIdentity: 'a',
    dependencyIdentity: 'b', environmentIdentity: 'c', node: {path: '/node', version: 'v22', sha256: 'd'}};
  assertRuntimeRepairInputsUnchanged(before, structuredClone(before));
  for (const key of ['sourceFiles', 'inputIdentity', 'dependencyIdentity', 'environmentIdentity', 'node']) {
    const after = structuredClone(before); after[key] = 'changed';
    assert.throws(() => assertRuntimeRepairInputsUnchanged(before, after), /inputs changed; checks not published/);
  }
});

function runtimeRepairSourceFixture(root) {
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot, {mode: 0o700});
  for (const path of ['packages/installer/src', 'packages/installer/test', 'packages/installer/scripts',
    'packages/runtime/src', 'packages/runtime/test', 'packages/runtime/scripts', 'packages/sdk/src', 'packages/sdk/test', 'packages/sdk/dist',
    'scripts', 'bin', 'tweaks', 'store', 'node_modules/@therealityreport']) mkdirSync(join(sourceRoot, path), {recursive: true, mode: 0o700});
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.tests.json',
    ...['installer', 'runtime', 'sdk'].flatMap(name => ['packages/' + name + '/package.json', 'packages/' + name + '/tsconfig.json'])]) {
    writeFileSync(join(sourceRoot, path), '{}\n', {mode: 0o600});
  }
  writeFileSync(join(sourceRoot, 'packages/sdk/package.json'), JSON.stringify({
    name: '@therealityreport/tweakers-sdk', type: 'module', main: 'dist/index.js', types: 'dist/index.d.ts',
  }) + '\n', {mode: 0o600});
  symlinkSync('../../packages/sdk', join(sourceRoot, 'node_modules/@therealityreport/tweakers-sdk'), 'dir');
  writeFileSync(join(sourceRoot, 'packages/runtime/src/main.ts'), 'export const original = true;\n', {mode: 0o600});
  writeFileSync(join(sourceRoot, 'packages/sdk/dist/index.js'), 'export const emitted = true;\n', {mode: 0o600});
  writeFileSync(join(sourceRoot, 'packages/sdk/dist/index.d.ts'), 'export declare const emitted: boolean;\n', {mode: 0o600});
  writeFileSync(join(sourceRoot, 'node_modules/compiler.js'), 'export const compiler = true;\n', {mode: 0o600});
  return sourceRoot;
}

function typecheckEvidenceFixture(context, callback) {
  const sourceRoot = runtimeRepairSourceFixture(context.root);
  writeFileSync(join(sourceRoot, 'packages/installer/src/main.ts'), 'export const installer = true;\n', {mode: 0o600});
  mkdirSync(join(sourceRoot, 'node_modules/typescript/bin'), {recursive: true, mode: 0o700});
  writeFileSync(join(sourceRoot, 'node_modules/typescript/bin/tsc'),
    'process.stdout.write(Buffer.from([0,255,10])); process.stderr.write("compiler warning\\n");\n', {mode: 0o600});
  const logsPath = join(context.cachePath, 'logs'), priorId = '11111111-1111-4111-8111-111111111111';
  mkdirSync(logsPath, {mode: 0o700});
  mkdirSync(join(logsPath, priorId), {mode: 0o700});
  const logs = pinPrivateEvidenceDirectory(logsPath), prior = pinPrivateEvidenceDirectory(join(logsPath, priorId));
  const before = snapshotRuntimeRepairInputs(custody, sourceRoot), results = [];
  try {
    writePrivateEvidence(prior, 'inputs-before.json', JSON.stringify(before) + '\n');
    for (let index = 0; index < 3; index++) {
      const actual = captureRuntimeRepairCheck(before.node.path, custody.RUNTIME_REPAIR_FIXED_CHECKS[index], sourceRoot);
      assert.equal(actual.exitCode, 0);
      const {stdout, stderr, ...result} = actual;
      for (const stream of ['stdout', 'stderr']) result[stream] = {relativePath: 'logs/' + priorId + '/' + index + '.' + stream + '.log',
        ...writePrivateEvidence(prior, index + '.' + stream + '.log', actual[stream])};
      writePrivateEvidence(prior, index + '.result.json', JSON.stringify(result) + '\n');
      results.push({...actual, refs: {stdout: result.stdout, stderr: result.stderr}});
    }
    const after = snapshotRuntimeRepairInputs(custody, sourceRoot);
    assertRuntimeRepairInputsUnchanged(before, after);
    writePrivateEvidence(prior, 'inputs-after.json', JSON.stringify(after) + '\n');
    // There is deliberately no accepted checks.json: later behavioral failure
    // must not discard the actual successful typecheck evidence.
    callback({sourceRoot, logs, prior, priorId, before, results});
  } finally { prior.close(); logs.close(); }
}

test('runtime repair verifier reuses actual fixed typechecks after test-only edits with original raw evidence and provenance', () => {
  fixture(context => typecheckEvidenceFixture(context, ({sourceRoot, logs, prior, priorId, before, results}) => {
    writeFileSync(join(sourceRoot, 'packages/runtime/test/changed.test.ts'), 'export const testOnly = true;\n', {mode: 0o600});
    writeFileSync(join(sourceRoot, 'scripts/verify-runtime-repair-source.mjs'), '// verifier-only edit\n', {mode: 0o600});
    const current = snapshotRuntimeRepairInputs(custody, sourceRoot);
    assert.notEqual(current.inputIdentity, before.inputIdentity);
    for (let index = 0; index < 3; index++) {
      const reused = findReusableRuntimeRepairTypecheck(custody, logs, '22222222-2222-4222-8222-222222222222', index, sourceRoot, current);
      assert.ok(reused);
      const {refs, ...actual} = results[index];
      assert.deepEqual(reused.captured, actual);
      assert.equal(reused.provenance.originalRunId, priorId);
      assert.deepEqual(reused.provenance.originalStreams, refs);
      for (const phase of ['before', 'after']) {
        assert.equal(reused.provenance.originalInputSnapshots[phase].relativePath, 'logs/' + priorId + '/inputs-' + phase + '.json');
        assert.equal(reused.provenance.originalInputSnapshots[phase].sha256,
          createHash('sha256').update(readPrivateEvidence(prior, 'inputs-' + phase + '.json')).digest('hex'));
      }
      assert.equal(reused.provenance.originalResult.sha256,
        createHash('sha256').update(readPrivateEvidence(prior, index + '.result.json')).digest('hex'));
    }
    for (const index of [3, 4]) assert.equal(findReusableRuntimeRepairTypecheck(custody, logs, '', index, sourceRoot, current), null);
  }));
});

test('runtime repair verifier invalidates typecheck reuse for production delivery dependency tool and actual-result drift', () => {
  fixture(context => typecheckEvidenceFixture(context, ({sourceRoot, logs, prior, before}) => {
    const find = (current = before) => findReusableRuntimeRepairTypecheck(custody, logs,
      '22222222-2222-4222-8222-222222222222', 0, sourceRoot, current);
    assert.ok(find());
    for (const path of ['packages/installer/src/main.ts', 'packages/installer/tsconfig.json', 'packages/installer/package.json',
      'package-lock.json', 'tsconfig.base.json', 'packages/sdk/dist/index.js', 'packages/sdk/dist/index.d.ts', 'node_modules/compiler.js']) {
      const absolute = join(sourceRoot, path), original = readFileSync(absolute);
      try {
        writeFileSync(absolute, Buffer.concat([original, Buffer.from('\nchanged\n')]));
        assert.equal(find(snapshotRuntimeRepairInputs(custody, sourceRoot)), null, path);
      } finally { writeFileSync(absolute, original); }
    }
    for (const field of ['dependencyIdentity', 'environmentIdentity', 'node']) {
      const changed = structuredClone(before);
      if (field === 'node') changed.node.sha256 = '0'.repeat(64); else changed[field] = '0'.repeat(64);
      assert.equal(find(changed), null, field);
    }
    const resultPath = join(prior.path, '0.result.json'), originalResult = readPrivateEvidence(prior, '0.result.json');
    for (const [field, value] of [['exitCode', 7], ['signal', 'SIGTERM'], ['errorCode', 'ENOENT'],
      ['cwd', context.root], ['command', '/wrong/node'], ['argv', ['--caller-command']]]) {
      const altered = JSON.parse(originalResult); altered[field] = value;
      writeFileSync(resultPath, JSON.stringify(altered) + '\n');
      assert.equal(find(), null, field);
    }
    writeFileSync(resultPath, originalResult);
    const afterPath = join(prior.path, 'inputs-after.json'), after = structuredClone(before);
    after.environmentIdentity = '0'.repeat(64);
    writeFileSync(afterPath, JSON.stringify(after) + '\n');
    assert.equal(find(), null, 'original after snapshot must also match');
    writeFileSync(afterPath, JSON.stringify(before) + '\n');
    writeFileSync(join(prior.path, '0.stderr.log'), 'changed raw warning');
    assert.equal(find(), null, 'original stream bytes must match');
  }));
});

test('runtime repair verifier invalidates only the dependent package typecheck and retains unchanged SDK evidence', () => {
  fixture(context => typecheckEvidenceFixture(context, ({sourceRoot, logs}) => {
    const paths = ['packages/installer/src/packaging.ts', 'packages/runtime/src/main.ts'];
    for (const [affectedIndex, path] of paths.entries()) {
      const absolute = join(sourceRoot, path), original = existsSync(absolute) ? readFileSync(absolute) : null;
      try {
        writeFileSync(absolute, 'export const packagingCorrection = true;\n', {mode: 0o600});
        const current = snapshotRuntimeRepairInputs(custody, sourceRoot);
        for (let index = 0; index < 3; index++) {
          const reused = findReusableRuntimeRepairTypecheck(custody, logs,
            '22222222-2222-4222-8222-222222222222', index, sourceRoot, current);
          assert.equal(Boolean(reused), index !== affectedIndex, path + ' compiler ' + index);
        }
      } finally {
        if (original === null) rmSync(absolute); else writeFileSync(absolute, original);
      }
    }
  }));
});

test('runtime repair verifier production publication validator recollects real source dependency environment and Node inputs', () => {
  fixture(({root, cache, run, cachePath}) => {
    const sourceRoot = runtimeRepairSourceFixture(root), before = snapshotRuntimeRepairInputs(custody, sourceRoot);
    const validate = createRuntimeRepairPublicationValidator(custody, sourceRoot, before, () => {
      cache.assertCurrent(); run.assertCurrent();
    });
    writePrivateEvidence(run, 'checks.json', 'immutable successful run');
    publishRuntimeRepairReceipt(cache, 'first', 'accepted receipt', validate);
    assert.equal(readPrivateEvidence(cache, 'checks.json').toString(), 'accepted receipt');
    retireRuntimeRepairReceipt(cache, run);
    // The actual helper collector, not a test-only failure callback, detects
    // source drift after the after-snapshot was already captured.
    writeFileSync(join(sourceRoot, 'packages/runtime/src/main.ts'), 'export const changed = true;\n');
    assert.throws(() => publishRuntimeRepairReceipt(cache, 'source-drift', 'rejected receipt', validate), /inputs changed/);
    assert.equal(existsSync(join(cachePath, 'checks.json')), false);
    assert.equal(readPrivateEvidence(run, 'checks.json').toString(), 'immutable successful run');
    const current = snapshotRuntimeRepairInputs(custody, sourceRoot);
    const validateCurrent = createRuntimeRepairPublicationValidator(custody, sourceRoot, current, () => cache.assertCurrent());
    writeFileSync(join(sourceRoot, 'node_modules/compiler.js'), 'export const changedCompiler = true;\n');
    assert.throws(validateCurrent, /inputs changed/);
    const sdkBaseline = snapshotRuntimeRepairInputs(custody, sourceRoot);
    const validateSDK = createRuntimeRepairPublicationValidator(custody, sourceRoot, sdkBaseline, () => cache.assertCurrent());
    writeFileSync(join(sourceRoot, 'packages/sdk/dist/index.js'), 'export const changedEmitted = true;\n');
    assert.throws(validateSDK, /inputs changed/);
    const originalTZ = process.env.TZ;
    try {
      const environmentBaseline = snapshotRuntimeRepairInputs(custody, sourceRoot);
      const validateEnvironment = createRuntimeRepairPublicationValidator(custody, sourceRoot, environmentBaseline, () => cache.assertCurrent());
      process.env.TZ = originalTZ === 'Etc/GMT+11' ? 'Etc/GMT+12' : 'Etc/GMT+11';
      assert.throws(validateEnvironment, /inputs changed/);
    } finally {
      if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    }
    const staleNode = snapshotRuntimeRepairInputs(custody, sourceRoot);
    staleNode.node.sha256 = '0'.repeat(64);
    assert.throws(createRuntimeRepairPublicationValidator(custody, sourceRoot, staleNode, () => cache.assertCurrent()), /inputs changed/);
  });
});

test('runtime repair verifier production validator revokes pointer for real input drift during publication', () => {
  fixture(({root, cache, run, cachePath}) => {
    const sourceRoot = runtimeRepairSourceFixture(root), before = snapshotRuntimeRepairInputs(custody, sourceRoot);
    const validate = createRuntimeRepairPublicationValidator(custody, sourceRoot, before, () => {
      cache.assertCurrent(); run.assertCurrent();
    });
    writePrivateEvidence(run, 'checks.json', 'immutable failed-run evidence');
    // Interpose only at the actual rename boundary: validation still uses the
    // unmodified production factory and the genuine helper collectors.
    const anchored = cache.within;
    let drifted = false;
    cache.within = operation => anchored(() => {
      const result = operation();
      if (!drifted && existsSync('checks.json')) {
        drifted = true;
        writeFileSync(join(sourceRoot, 'package-lock.json'), '{"changed":true}\n');
      }
      return result;
    });
    assert.throws(() => publishRuntimeRepairReceipt(cache, 'mid-publication', 'rejected receipt', validate), /inputs changed/);
    assert.equal(drifted, true);
    assert.equal(existsSync(join(cachePath, 'checks.json')), false);
    assert.equal(readPrivateEvidence(run, 'checks.json').toString(), 'immutable failed-run evidence');
  });
});

test('runtime repair verifier publication rejects redirected parent without overwriting canonical proof', () => {
  fixture(({cache, cachePath, outside}) => {
    const proof = join(outside, 'checks.json');
    writeFileSync(proof, 'canonical proof', {mode: 0o600});
    assert.throws(() => publishRuntimeRepairReceipt(cache, 'redirected', 'new receipt', () => {
      renameSync(cachePath, cachePath + '-retained');
      symlinkSync(outside, cachePath);
    }), /linked evidence ancestor|directory changed/);
    assert.equal(readFileSync(proof, 'utf8'), 'canonical proof');
    assert.equal(existsSync(join(cachePath + '-retained', 'checks.json')), false);
    assert.equal(readFileSync(join(cachePath + '-retained', 'checks-redirected.json'), 'utf8'), 'new receipt');
  });
});
