import { ownEntrypoint } from './owned-entrypoint.mjs';
import { register } from 'tsx/esm/api';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireSafe = (condition, reason) => { if (!condition) throw new Error('Runtime repair verification: ' + reason); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameBytes = (a, b) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function assertNoVerifierArguments(argv) {
  requireSafe(argv.length === 2, 'accepts no arguments');
}

/** Actual child results, including successful stderr; never a caller success flag. */
export function captureRuntimeRepairCheck(command, argv, cwd) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, argv, {cwd, encoding: 'buffer', timeout: 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  return {command, argv: [...argv], cwd, startedAt, completedAt: new Date().toISOString(),
    exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null,
    stdout: Buffer.from(result.stdout ?? ''), stderr: Buffer.from(result.stderr ?? '')};
}

function assertRealAncestors(path) {
  requireSafe(isAbsolute(path) && resolve(path) === path, 'noncanonical evidence path');
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split('/').filter(Boolean)) {
    cursor = join(cursor, component);
    const status = lstatSync(cursor);
    requireSafe(status.isDirectory() && !status.isSymbolicLink(), 'linked evidence ancestor');
  }
  requireSafe(realpathSync(path) === path, 'linked evidence path');
}

/** Kernel-anchored cwd keeps synchronous leaf operations in the pinned directory
 * even if an ancestor is replaced. No await/child execution inside within(). */
function pinEvidenceDirectory(path, privateRequired) {
  assertRealAncestors(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const status = fstatSync(fd);
  try {
    requireSafe(status.isDirectory() && (privateRequired
      ? status.uid === process.getuid() && (status.mode & 0o777) === 0o700
      : (status.uid === process.getuid() || status.uid === 0) && !(status.mode & 0o022))
      && sameFile(status, lstatSync(path)), 'evidence directory is not private');
  } catch (error) { closeSync(fd); throw error; }
  const assertCurrent = () => {
    assertRealAncestors(path);
    const current = lstatSync(path), pinned = fstatSync(fd);
    requireSafe(sameFile(status, current) && sameFile(status, pinned)
      && current.uid === status.uid && (current.mode & 0o777) === (status.mode & 0o777), 'evidence directory changed');
  };
  const within = operation => {
    assertCurrent();
    const previous = realpathSync(process.cwd()), previousStatus = lstatSync(previous);
    process.chdir(path);
    try {
      requireSafe(sameFile(status, lstatSync('.')), 'evidence directory changed before operation');
      const result = operation();
      requireSafe(!(result && typeof result.then === 'function'), 'asynchronous anchored operation');
      assertCurrent();
      return result;
    } finally {
      process.chdir(previous);
      requireSafe(sameFile(previousStatus, lstatSync('.')), 'working directory changed');
    }
  };
  return {path, assertCurrent, within, close: () => closeSync(fd)};
}

export function pinPrivateEvidenceDirectory(path) {
  return pinEvidenceDirectory(path, true);
}

function leafName(name) {
  requireSafe(typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name)
    && name !== '.' && name !== '..', 'unsafe evidence leaf');
  return name;
}

// '.' is already kernel-anchored by within(); no authority fd is exposed.
function syncDirectory(directory) {
  const fd = openSync('.', constants.O_RDONLY | constants.O_NOFOLLOW);
  try { directory.assertCurrent(); fsyncSync(fd); } finally { closeSync(fd); }
}

export function writePrivateEvidence(directory, name, bytes) {
  leafName(name);
  return directory.within(() => {
    const fd = openSync(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = fstatSync(fd);
      requireSafe(before.isFile() && before.uid === process.getuid() && before.nlink === 1
        && (before.mode & 0o777) === 0o600, 'unsafe evidence file');
      writeFileSync(fd, bytes); fsyncSync(fd);
      requireSafe(sameFile(before, lstatSync(name)) && sameFile(before, fstatSync(fd)), 'evidence leaf replaced');
      syncDirectory(directory);
    } finally { closeSync(fd); }
    return {sha256: hash(bytes)};
  });
}

export function readPrivateEvidence(directory, name) {
  leafName(name);
  return directory.within(() => {
    const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      requireSafe(before.isFile() && before.uid === process.getuid() && before.nlink === 1
        && (before.mode & 0o777) === 0o600 && before.size <= 64 * 1024 * 1024, 'unsafe evidence file');
      const bytes = readFileSync(fd);
      requireSafe(sameBytes(before, fstatSync(fd)) && sameBytes(before, lstatSync(name)), 'evidence changed during read');
      return bytes;
    } finally { closeSync(fd); }
  });
}

/** Preserve the old pointer's bytes before retiring it; its raw logs stay put. */
export function retireRuntimeRepairReceipt(cache, run) {
  let bytes;
  try { bytes = readPrivateEvidence(cache, 'checks.json'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  writePrivateEvidence(run, 'prior-checks.json', bytes);
  cache.within(() => {
    requireSafe(hash(readPrivateEvidence(cache, 'checks.json')) === hash(bytes), 'prior check receipt changed');
    unlinkSync('checks.json'); syncDirectory(cache);
  });
}

export function assertRuntimeRepairInputsUnchanged(before, after) {
  requireSafe(JSON.stringify(before) === JSON.stringify(after), 'inputs changed; checks not published');
}

function prepareCache(cache) {
  let nearest = cache;
  const absent = [];
  for (;;) {
    try { lstatSync(nearest); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; absent.push(nearest); nearest = dirname(nearest); }
  }
  assertRealAncestors(nearest);
  // Do not adopt or chmod established paths. Readable existing ancestors must
  // still be owned and unwritable by other accounts.
  let ancestor = nearest;
  while (ancestor !== parse(ancestor).root) {
    const status = lstatSync(ancestor);
    requireSafe((status.uid === process.getuid() || status.uid === 0) && !(status.mode & 0o022), 'unsafe cache ancestry');
    ancestor = dirname(ancestor);
  }
  let parent = pinEvidenceDirectory(nearest, false);
  try {
    for (const path of absent.reverse()) {
      const child = childDirectory(parent, path.slice(dirname(path).length + 1));
      parent.close(); parent = child;
    }
  } finally { parent.close(); }
  return pinPrivateEvidenceDirectory(cache);
}

function childDirectory(parent, name) {
  const expected = parent.within(() => {
    try { mkdirSync(leafName(name), {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return lstatSync(name);
  });
  const pinned = pinPrivateEvidenceDirectory(join(parent.path, name));
  try { requireSafe(sameFile(expected, lstatSync(pinned.path)), 'new evidence directory replaced'); }
  catch (error) { pinned.close(); throw error; }
  return pinned;
}

function nodeIdentity() {
  const path = realpathSync(process.execPath), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    requireSafe(before.isFile() && !(before.mode & 0o022), 'unsafe Node executable');
    const sha256 = hash(readFileSync(fd));
    requireSafe(sameBytes(before, fstatSync(fd)) && sameBytes(before, lstatSync(path)), 'Node changed during read');
    return {path, sha256, version: process.version};
  } finally { closeSync(fd); }
}

export function snapshotRuntimeRepairInputs(custody, root) {
  const sourceFiles = custody.collectRuntimeRepairSourceInputs(root);
  return {sourceFiles, inputIdentity: custody.runtimeRepairSourceInputIdentity(sourceFiles),
    dependencyIdentity: custody.runtimeRepairDependencyIdentity(root),
    environmentIdentity: custody.runtimeRepairSourceEnvironmentIdentity(), node: nodeIdentity()};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const TYPECHECK_PACKAGES = [['installer', 'sdk'], ['runtime', 'sdk'], ['sdk']];

/** Each fixed compiler consumes its own production tree and the SDK contract.
 * Test fixtures and this verifier are not inputs to these src-only tsconfigs. */
export function runtimeRepairTypecheckIdentity(custody, snapshot, index) {
  requireSafe(Number.isInteger(index) && index >= 0 && index <= 2, 'unknown fixed compiler');
  const packages = TYPECHECK_PACKAGES[index];
  const requiredFiles = ['package.json', 'package-lock.json', 'tsconfig.base.json',
    ...packages.flatMap(name => ['packages/' + name + '/package.json', 'packages/' + name + '/tsconfig.json']),
    'packages/sdk/dist/index.js', 'packages/sdk/dist/index.d.ts'];
  requireSafe(exactKeys(snapshot, ['sourceFiles', 'inputIdentity', 'dependencyIdentity', 'environmentIdentity', 'node'])
    && Array.isArray(snapshot.sourceFiles) && SHA256.test(snapshot.dependencyIdentity)
    && SHA256.test(snapshot.environmentIdentity) && exactKeys(snapshot.node, ['path', 'sha256', 'version'])
    && isAbsolute(snapshot.node.path) && SHA256.test(snapshot.node.sha256) && typeof snapshot.node.version === 'string',
  'invalid prior input snapshot');
  const paths = new Set();
  for (const file of snapshot.sourceFiles) {
    requireSafe(exactKeys(file, ['relativePath', 'mode', 'sha256']) && typeof file.relativePath === 'string'
      && !isAbsolute(file.relativePath) && file.relativePath.split('/').every(part => part && part !== '.' && part !== '..')
      && !paths.has(file.relativePath) && Number.isInteger(file.mode) && SHA256.test(file.sha256), 'invalid prior source inventory');
    paths.add(file.relativePath);
  }
  requireSafe(snapshot.inputIdentity === custody.runtimeRepairSourceInputIdentity(snapshot.sourceFiles)
    && requiredFiles.every(path => paths.has(path)), 'incomplete prior compiler inputs');
  const sourceFiles = snapshot.sourceFiles.filter(file => requiredFiles.includes(file.relativePath)
    || packages.some(name => file.relativePath.startsWith('packages/' + name + '/src/'))
    || file.relativePath.startsWith('packages/sdk/dist/')).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return hash(JSON.stringify({sourceFiles, dependencyIdentity: snapshot.dependencyIdentity,
    environmentIdentity: snapshot.environmentIdentity, node: snapshot.node}));
}

/** Only our fixed private run logs are candidates; a failed behavioral run can
 * still contain genuine passing compiler evidence. Invalid evidence is unused. */
export function findReusableRuntimeRepairTypecheck(custody, logs, currentRunId, index, root, current) {
  if (!Number.isInteger(index) || index < 0 || index > 2) return null;
  const identity = runtimeRepairTypecheckIdentity(custody, current, index);
  const candidates = logs.within(() => readdirSync('.').filter(name => UUID.test(name) && name !== currentRunId)
    .map(name => ({name, status: lstatSync(name)})).filter(item => item.status.isDirectory() && !item.status.isSymbolicLink())
    .sort((a, b) => b.status.mtimeMs - a.status.mtimeMs || a.name.localeCompare(b.name)).slice(0, 16));
  for (const {name} of candidates) {
    let prior;
    try {
      prior = pinPrivateEvidenceDirectory(join(logs.path, name));
      const beforeBytes = readPrivateEvidence(prior, 'inputs-before.json'), afterBytes = readPrivateEvidence(prior, 'inputs-after.json');
      const before = JSON.parse(beforeBytes), after = JSON.parse(afterBytes);
      requireSafe(runtimeRepairTypecheckIdentity(custody, before, index) === identity
        && runtimeRepairTypecheckIdentity(custody, after, index) === identity, 'prior compiler inputs changed');
      const resultBytes = readPrivateEvidence(prior, index + '.result.json'), result = JSON.parse(resultBytes);
      requireSafe(exactKeys(result, ['command', 'argv', 'cwd', 'startedAt', 'completedAt', 'exitCode', 'signal', 'errorCode', 'stdout', 'stderr'])
        && result.command === current.node.path && result.cwd === root
        && JSON.stringify(result.argv) === JSON.stringify(custody.RUNTIME_REPAIR_FIXED_CHECKS[index])
        && result.exitCode === 0 && result.signal === null && result.errorCode === null
        && typeof result.startedAt === 'string' && typeof result.completedAt === 'string'
        && Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.completedAt) >= Date.parse(result.startedAt),
      'prior compiler result is not a fixed successful command');
      const streams = {};
      for (const stream of ['stdout', 'stderr']) {
        const leaf = index + '.' + stream + '.log', ref = result[stream];
        requireSafe(exactKeys(ref, ['relativePath', 'sha256']) && ref.relativePath === 'logs/' + name + '/' + leaf
          && SHA256.test(ref.sha256), 'invalid prior stream reference');
        streams[stream] = readPrivateEvidence(prior, leaf);
        requireSafe(hash(streams[stream]) === ref.sha256, 'prior stream bytes changed');
      }
      logs.assertCurrent(); prior.assertCurrent();
      return {captured: {...result, ...streams}, provenance: {version: 1, kind: 'tweakers-runtime-repair-typecheck-reuse',
        index, relevantInputIdentity: identity, originalRunId: name,
        originalResult: {relativePath: 'logs/' + name + '/' + index + '.result.json', sha256: hash(resultBytes)},
        originalInputSnapshots: {
          before: {relativePath: 'logs/' + name + '/inputs-before.json', sha256: hash(beforeBytes)},
          after: {relativePath: 'logs/' + name + '/inputs-after.json', sha256: hash(afterBytes)}},
        originalStreams: {stdout: result.stdout, stderr: result.stderr}}};
    } catch { logs.assertCurrent(); }
    finally { prior?.close(); }
  }
  return null;
}

/** Use the same complete collectors at publication as at check execution.
 * Namespace checks alone cannot detect a late source, dependency or tool edit. */
export function createRuntimeRepairPublicationValidator(custody, root, before, assertAuthority) {
  return () => {
    assertAuthority();
    assertRuntimeRepairInputsUnchanged(before, snapshotRuntimeRepairInputs(custody, root));
    assertAuthority();
  };
}

export function publishRuntimeRepairReceipt(cache, runId, bytes, validate) {
  const temp = 'checks-' + runId + '.json';
  writePrivateEvidence(cache, temp, bytes);
  let published = false;
  try {
    validate();
    cache.within(() => {
      try { lstatSync('checks.json'); throw new Error('Accepted check pointer unexpectedly exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      renameSync(temp, 'checks.json'); published = true; syncDirectory(cache);
    });
    requireSafe(hash(readPrivateEvidence(cache, 'checks.json')) === hash(bytes), 'published receipt changed');
    validate();
  } catch (error) {
    // A rejected publication must not leave its pointer usable. The immutable
    // run copy and pending temp are retained; never clean an unbound namespace.
    if (published) {
      try {
        cache.within(() => {
          requireSafe(hash(readPrivateEvidence(cache, 'checks.json')) === hash(bytes), 'rejected receipt replaced');
          unlinkSync('checks.json'); syncDirectory(cache);
        });
      } catch (cleanupError) { error.message += '; rejected pointer isolation: ' + cleanupError.message; }
    }
    throw error;
  }
}

async function main() {
  assertNoVerifierArguments(process.argv);
  await ownEntrypoint(import.meta.url);
  register();
  const root = realpathSync(resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), '..'));
  requireSafe(lstatSync(root).uid === process.getuid(), 'unowned source checkout');
  const rootStatus = lstatSync(root);
  const assertRoot = () => requireSafe(realpathSync(root) === root && sameFile(rootStatus, lstatSync(root))
    && realpathSync(process.cwd()) === root, 'source checkout or cwd changed');
  // ownEntrypoint preserves the caller cwd; checks always use canonical root.
  process.chdir(root);
  assertRoot();
  const custody = await import('../packages/installer/src/runtime-repair-source-custody.ts');
  const cache = prepareCache(custody.runtimeRepairSourceCheckCache(root));
  const logs = childDirectory(cache, 'logs'), runId = randomUUID(), run = childDirectory(logs, runId);
  try {
    retireRuntimeRepairReceipt(cache, run);
    const before = snapshotRuntimeRepairInputs(custody, root), checks = [], inputSnapshots = {};
    inputSnapshots.before = {relativePath: 'logs/' + runId + '/inputs-before.json',
      ...writePrivateEvidence(run, 'inputs-before.json', JSON.stringify(before) + '\n')};
    let failure;
    try {
      for (const [index, argv] of custody.RUNTIME_REPAIR_FIXED_CHECKS.entries()) {
        assertRoot(); cache.assertCurrent(); logs.assertCurrent(); run.assertCurrent();
        const reuse = findReusableRuntimeRepairTypecheck(custody, logs, runId, index, root, before);
        const captured = reuse?.captured ?? captureRuntimeRepairCheck(before.node.path, argv, root), refs = {};
        if (reuse) writePrivateEvidence(run, index + '.reuse.json', JSON.stringify(reuse.provenance) + '\n');
        for (const stream of ['stdout', 'stderr']) refs[stream] = {relativePath: 'logs/' + runId + '/' + index + '.' + stream + '.log',
          ...writePrivateEvidence(run, index + '.' + stream + '.log', captured[stream])};
        const {stdout, stderr, ...result} = captured;
        writePrivateEvidence(run, index + '.result.json', JSON.stringify({...result, ...refs}) + '\n');
        requireSafe(captured.exitCode === 0 && captured.signal === null && captured.errorCode === null,
          'fixed check ' + index + ' failed; raw evidence retained at ' + run.path);
        checks.push({command: captured.command, argv: captured.argv, cwd: captured.cwd, startedAt: captured.startedAt,
          completedAt: captured.completedAt, exitCode: 0, ...refs});
      }
    } catch (error) { failure = error; }
    const after = snapshotRuntimeRepairInputs(custody, root);
    inputSnapshots.after = {relativePath: 'logs/' + runId + '/inputs-after.json',
      ...writePrivateEvidence(run, 'inputs-after.json', JSON.stringify(after) + '\n')};
    if (failure) throw failure;
    assertRuntimeRepairInputsUnchanged(before, after);
    const receipt = {version: 1, kind: 'tweakers-runtime-repair-source-checks', checkoutRoot: root,
      ...before, checks, inputSnapshots};
    custody.assertRuntimeRepairSourceCheckReceipt(receipt);
    const assertPublicationAuthority = () => { assertRoot(); cache.assertCurrent(); logs.assertCurrent(); run.assertCurrent(); };
    const validatePublication = createRuntimeRepairPublicationValidator(custody, root, before, assertPublicationAuthority);
    assertPublicationAuthority();
    writePrivateEvidence(run, 'checks.json', JSON.stringify(receipt) + '\n');
    publishRuntimeRepairReceipt(cache, runId, JSON.stringify(receipt) + '\n', validatePublication);
    console.log('Fixed runtime repair source checks retained at ' + cache.path);
  } finally { run.close(); logs.close(); cache.close(); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
