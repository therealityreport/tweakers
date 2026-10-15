import { spawnSync } from 'node:child_process';
import { register } from 'tsx/esm/api';
import { register as registerLoader } from 'node:module';
import { createHash } from 'node:crypto';
import { runOwnedCommand } from './owned-command.mjs';
import { createOperationDependencyIdentity } from './operation-dependency-identity.mjs';
const command = (cmd,args,cwd=root) => runOwnedCommand(cmd,args,cwd);
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, realpathSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
register();
registerLoader('./source-lock-loader.mjs', import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { withLocalOperation,userLocalOperationRoot,readLocalOperation } = await import('../packages/installer/src/local-operation.ts');
const cache = join(homedir(), 'Library', 'Caches', 'Tweakers', 'verification', createHash('sha256').update(root).digest('hex'));
const [mode, ...extra] = process.argv.slice(2);
// Source recovery bypasses build/dependency bootstrap and the generic writer
// lease. Its own implementation owns apply locks; preview performs no writes.
if (mode === 'recover-missing-artifact') {
  const [reservationId, ...flags] = extra;
  let apply = false, transactionId;
  for (let index=0;index<flags.length;index++) {
    if(flags[index]==='--apply'&&!apply)apply=true;
    else if(flags[index]==='--transaction'&&!transactionId&&flags[index+1])transactionId=flags[++index];
    else throw new Error('Use recover-missing-artifact <reservation-id> [--apply] [--transaction <UUID>]');
  }
  const { recoverMissingArtifact } = await import('../packages/installer/src/missing-artifact-recovery.ts');
  const { canonicalTweakersManagerRoot } = await import('../packages/installer/src/manager-descriptor.ts');
  console.log(JSON.stringify(await recoverMissingArtifact(canonicalTweakersManagerRoot(),reservationId,{apply,transactionId})));
  process.exit(0);
}
const fileDigests = new Map();
function fileDigest(path, st = lstatSync(path)) {
  const identity = [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs, st.mode].join(":");
  const saved = fileDigests.get(path);
  if (saved?.identity === identity) return saved.hash;
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  fileDigests.set(path, { identity, hash });
  return hash;
}
function digest(paths, excluded = new Set(), includeIdentity = false) {
  const hash = createHash('sha256');
  function walk(path) {
    hash.update(relative(root, path));
    let st;
    try { st = lstatSync(path); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing'); return;
    }
    hash.update(String(st.mode & 0o777));
    if (includeIdentity && !st.isDirectory()) hash.update(JSON.stringify([st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs]));
    if (st.isSymbolicLink()) {
      const link = readlinkSync(path), lexicalTarget = resolve(dirname(path),link);
      // npm creates workspace executable links before the first compilation.
      // Their missing target is an output, not a missing external dependency.
      if (relative(root,path).startsWith('node_modules/.bin/')
        && lexicalTarget.startsWith(join(root,'packages')+'/')
        && relative(join(root,'packages'),lexicalTarget).split('/')[1] === 'dist') {
        const packageRoot = join(root,'packages',relative(join(root,'packages'),lexicalTarget).split('/')[0]);
        if (realpathSync(packageRoot) !== packageRoot) throw new Error(`External workspace executable ${path}`);
        hash.update(link); return;
      }
      const actual = realpathSync(path);
      if (lstatSync(actual).isDirectory() && relative(root,path).startsWith('node_modules/@therealityreport/')) {
        if(!actual.startsWith(join(root,'packages')+'/'))throw new Error(`External workspace dependency ${path}`);
        hash.update(readlinkSync(path));return; // Workspace sources/outputs are explicit inputs below.
      }
      // npm also links workspace executables into .bin. Their compiled bytes
      // are outputs, not external dependencies of the build producing them.
      // Keep the link binding; workspace sources and prerequisites are explicit.
      if (relative(root,path).startsWith('node_modules/.bin/')
        && actual.startsWith(join(root,'packages')+'/')
        && relative(join(root,'packages'),actual).split('/')[1]==='dist'
        && lstatSync(actual).isFile()) {
        hash.update(readlinkSync(path));return;
      }
      if (!actual.startsWith(`${root}/`) || lstatSync(actual).isDirectory()) throw new Error(`Unsupported symlink input ${path}`);
      hash.update(relative(root, actual)); hash.update(fileDigest(actual)); return;
    }
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) {
      const next = join(path, name);
      if (!excluded.has(name) && !excluded.has(relative(root, next)) && !(excluded.has("**/*.test.*") && /\.test\.[cm]?[jt]s$/.test(name))) walk(next);
    }
    else if (st.isFile()) hash.update(fileDigest(path, st));
  }
  paths.forEach(walk);
  return hash.digest('hex');
}
function inputs(name) {
  const dependencies={sdk:[],"native-host":[],switcher:[],runtime:["sdk","native-host"],loader:[],installer:["sdk","native-host","switcher","runtime","loader","mcp-lifecycle"]};
  const packages=[name,...(dependencies[name]??[])].map(n=>`packages/${n}`);
  return digest([...packages, 'scripts', 'bin', ...(name==='installer'?['tweaks','store']:[]), 'package.json', 'package-lock.json', 'tsconfig.base.json', ...(name==='native-host'?['packages/installer/assets/tweakers.icns']:[])].map(p => join(root,p)), new Set(['store/index.json', 'tweaks/co.tweakers.projects/index.js', '**/*.test.*', 'test', 'tests', 'tsconfig.tests.json', 'node_modules', 'dist', '.git', '.DS_Store', 'packages/installer/assets/runtime', 'packages/installer/assets/managed-runtime', 'packages/installer/assets/manager-launcher/manager.mjs', 'packages/installer/assets/native-host', 'packages/installer/assets/loader.cjs', 'packages/installer/assets/mcp-lifecycle', 'packages/installer/assets/swap-helper', 'packages/installer/assets/app-launcher', 'packages/installer/assets/manager-launcher']));
}

const dependencies = createOperationDependencyIdentity(() =>
  digest([join(root,'node_modules'),join(root,'package-lock.json')],new Set(['.cache','.DS_Store','node_modules/electron/dist']),true));
function dependencyIdentity() { return dependencies.get(); }
const pendingReceipts = new Map();
function stageReceipt(file, value) { pendingReceipts.set(file, JSON.stringify(value)); }
function publishReceipts() {
  dependencies.assertUnchanged();
  if (!pendingReceipts.size) return;
  mkdirSync(cache,{recursive:true});
  for (const [file, value] of pendingReceipts) {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp,value); renameSync(temp,file);
  }
}
async function deterministicCheck(key,args,sourcePaths) {
  const identity=()=>({source:digest(sourcePaths, key.startsWith("typecheck-") ? new Set(["**/*.test.*"]) : new Set()),dependencies:dependencyIdentity(),node:process.version,executable:realpathSync(process.execPath),command:args,environment:createHash('sha256').update(JSON.stringify(Object.fromEntries(['PATH','NODE_OPTIONS','NODE_PATH','LANG','LC_ALL','TZ','TS_NODE_PROJECT'].map(k=>[k,process.env[k]??null])))).digest('hex')});
  const before=identity(),file=join(cache,`check-${key}.json`);
  let saved;try{saved=JSON.parse(readFileSync(file,'utf8'));}catch{}
  if(saved?.passed===true&&JSON.stringify(saved.identity)===JSON.stringify(before)){console.log(`[reuse] ${key}: deterministic verification inputs unchanged`);return;}
  await command(process.execPath,args);
  if(JSON.stringify(identity())!==JSON.stringify(before))throw new Error('Verification inputs changed; passing result was not saved');
  stageReceipt(file,{passed:true,identity:before,completedAt:new Date().toISOString()});
}

async function build(name) {
  const pkg = join(root, 'packages', name);
  const script = JSON.parse(readFileSync(join(pkg,'package.json'),'utf8')).tweakersBuildCommand;
  if (typeof script !== 'string' || !script) throw new Error('Missing owned build command');
  const identify=()=>{
  const tools = Object.fromEntries([
    ['npm',['--version']],
    ...(process.platform === 'darwin' && ['native-host','switcher'].includes(name) ? [['xcrun',['--show-sdk-path']],['xcrun',['--show-sdk-version']],['xcrun',['clang','--version']],['xcrun',['clang++','--version']],['xcrun',['swiftc','--version']]] : []),
  ].map(([tool,args])=>{
    const result=spawnSync(tool,args,{encoding:'utf8',timeout:10000});
    if(result.status!==0)throw new Error(`Cannot establish tool identity: ${tool} ${args.join(' ')}`);
    return [`${tool} ${args.join(' ')}`,result.stdout+result.stderr];
  }));
  const environment=Object.fromEntries(['PATH','NODE_OPTIONS','CC','CXX','CFLAGS','CXXFLAGS','CPPFLAGS','LDFLAGS','SDKROOT','MACOSX_DEPLOYMENT_TARGET','DEVELOPER_DIR','SWIFT_EXEC'].map(k=>[k,process.env[k]??null]));
  return { source: inputs(name), node: process.version, executable: realpathSync(process.execPath), platform: process.platform, arch: process.arch, command:script, tools, environmentDigest:createHash('sha256').update(JSON.stringify(environment)).digest('hex'), dependencies:dependencyIdentity(), prerequisites: ['runtime','installer'].includes(name)?digest((name==='runtime'?['sdk','native-host']:['sdk','native-host','switcher','runtime']).map(n=>join(root,'packages',n,'dist'))):null };
  };
  const identity=identify();
  // Reuse only when all package outputs (including sealed installer assets) match.
  const outputs = [join(pkg, 'dist'), ...(name==='installer'?[join(pkg,'assets')]:[]),...(name==='native-host'?[join(pkg,'assets/Tweakers Manager Launcher')]:[])];
  const cacheable = true;
  const receipt = join(cache, `${name}.json`);
  let previous; try { previous = JSON.parse(readFileSync(receipt,'utf8')); } catch {}
  if (cacheable && outputs.every(existsSync) && JSON.stringify(previous?.identity) === JSON.stringify(identity) && previous.output === digest(outputs)) {
    console.log(`[reuse] ${name}: source and outputs unchanged`); return;
  }
  await command('/bin/sh',['-c',script],pkg);
  if (JSON.stringify(identify())!==JSON.stringify(identity)) throw new Error('Build inputs changed during compilation; evidence was not saved');
  // Only publish evidence for observable outputs; missing outputs never count as a hit.
  if (cacheable && outputs.every(existsSync)) {
    stageReceipt(receipt,{identity,output:digest(outputs)});
  }
}
function testWorkers() {
  const value = Number(process.env.TWEAKERS_TEST_WORKERS ?? 2);
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('TWEAKERS_TEST_WORKERS must be between 1 and 8');
  return value;
}
function packageTests(path, depth = 0) {
  if (depth > 4) return [];
  return readdirSync(path,{withFileTypes:true}).flatMap(e => e.isDirectory() && !['node_modules','dist','assets'].includes(e.name) ? packageTests(join(path,e.name),depth+1) : e.isFile() && e.name.endsWith('.test.ts') ? [join(path,e.name)] : []);
}
if (mode === 'recover') {
  if (extra.length !== 1) throw new Error('Supply the exact interrupted operation ID');
  const { recoverInterruptedTweakersOperation } = await import('../packages/installer/src/local-operation.ts');
  await recoverInterruptedTweakersOperation(extra[0]);
  console.log('Interrupted ownership reconciled; retained candidates were not retried');
  process.exit(0);
}
// Check-only synchronization never generates output. Validate a stable snapshot
// and reject a concurrent writer instead of acquiring the global writer lease.
if (mode === 'sync' && extra.length === 1 && extra[0] === '--check') {
  const operationRoot = userLocalOperationRoot();
  const owner = readLocalOperation(operationRoot);
  if (owner?.state === 'running') throw new Error(`Generated-output check must wait for ${owner.kind} (${owner.id})`);
  const paths = ['tweaks', 'store', 'packages/installer/assets/runtime'].map(p=>join(root,p));
  const before = digest(paths);
  await command(process.execPath, ['scripts/sync-tweaks.mjs', '--check']);
  const afterOwner = readLocalOperation(operationRoot);
  if (digest(paths) !== before || afterOwner?.id !== owner?.id || afterOwner?.state === 'running') {
    throw new Error('Generated inputs changed during read-only check; rerun after generation settles');
  }
  process.exit(0);
}
const requestKey=JSON.stringify({root,mode,extra});
// Source-only request identity is safe before admission: generated outputs are
// excluded and are fingerprinted only after ownership has been acquired.
const requestInputs = () => mode === 'test'
  ? digest(['packages','scripts','tweaks','package.json','package-lock.json'].map(p=>join(root,p)),new Set(['node_modules','dist','assets','.git','.DS_Store']))
  : inputs(mode === 'build-sdk' ? 'sdk' : mode === 'workspace-build' ? extra[0] : 'installer');
const requestIdentity=requestInputs();
try {
  await withLocalOperation(`npm:${mode}`,async () => {
    if (mode === 'recover-source') {
      const { reconcilePreparedSourceConsumption } = await import('../packages/installer/src/official-source-registration.ts');
      reconcilePreparedSourceConsumption(resolve(userLocalOperationRoot(),'..'),true);
    }
    else if (mode === 'dependencies') await command('npm',['ci',...extra]);
    else if (mode === 'command') {if(!extra.length)throw new Error('Missing owned command');await command(extra[0],extra.slice(1));}
    else if (mode === 'workspace-build') {
      const name = extra[0];
      if (!['sdk','native-host','switcher','runtime','loader','installer'].includes(name)) throw new Error('Unknown build workspace');
      await build(name);
    }
    else if (mode === 'clean') {
      for (const name of readdirSync(join(root,'packages'))) rmSync(join(root,'packages',name,'dist'),{recursive:true,force:true});
      rmSync(join(root,'packages/installer/assets/runtime'),{recursive:true,force:true});
    }
    else if (mode === 'build-sdk') await build('sdk');
    else if (mode === 'build') for (const name of ['sdk','native-host','switcher','runtime','loader','installer']) await build(name);
    else if (mode === 'test') {
      for (const name of ['sdk','native-host','switcher']) await build(name);
      // shared-native-backend-transition-recovery.test.ts swaps fixture seams with mock.module().
      const args = ['--import','./scripts/test-root-preload.mjs','--import','tsx','--experimental-test-module-mocks','--test',`--test-concurrency=${testWorkers()}`];
      const pure=join(root,'packages/sdk/test/manifest-validation.test.ts');
      // Only this bounded pure-data suite is eligible. Process, filesystem,
      // and live acceptance suites always run freshly.
      await deterministicCheck('manifest-validation',[...args,...extra,pure],[join(root,'packages/sdk/src'),pure,join(root,'scripts/test-root-preload.mjs'),join(root,'scripts/local-work.mjs')]);
      await command(process.execPath,[...args,...extra,...packageTests(join(root,'packages')).filter(p=>p!==pure)]);
      await command(process.execPath,[...args,...readdirSync(join(root,'scripts')).filter(n=>n.endsWith('.test.mjs')).map(n=>`scripts/${n}`)]);
      await command('npm',['run','test:tweaks']);
      await command('npm',['test','--workspace','@therealityreport/tweakers-mcp-lifecycle']);
    } else if (mode === 'typecheck') {
      await build('sdk');
      for (const name of ['installer','runtime','sdk']) await deterministicCheck(`typecheck-${name}`,['node_modules/typescript/bin/tsc','--noEmit','-p',`packages/${name}/tsconfig.json`],[join(root,'packages',name,'src'),join(root,'packages',name,'tsconfig.json'),join(root,'packages/sdk/dist'),join(root,'tsconfig.base.json'),join(root,'scripts/local-work.mjs')]);
    } else if (mode === 'sync') await command(process.execPath,['scripts/sync-tweaks.mjs',...extra]);
    else throw new Error(`Unknown work mode ${mode}`);
    if(mode!=="sync"&&requestInputs()!==requestIdentity)throw new Error("Requested source inputs changed during work; result cannot be reused");
    publishReceipts();
  }, userLocalOperationRoot(), undefined, {requestKey,inputIdentity:requestIdentity,onWaiting: owner => console.log(`[wait] ${owner?.kind} (${owner?.id})`)});
} catch (error) { console.error(error.message); process.exitCode = 1; }
