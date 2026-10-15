import { register } from 'tsx/esm/api';
import { register as registerLoader } from 'node:module';
import { runOwnedCommand } from './owned-command.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
let operationModule;
async function operations() {
  if (!operationModule) {
    register();
    registerLoader('./source-lock-loader.mjs', import.meta.url);
    operationModule = import('../packages/installer/src/local-operation.ts');
  }
  return operationModule;
}

/** Direct script invocations use the same ancestor-verified lease as npm. */
export async function ownEntrypoint(url) {
  if (!process.argv[1] || realpathSync(process.argv[1]) !== realpathSync(fileURLToPath(url))) return;
  const { withLocalOperation, hasInheritedLocalOperation,userLocalOperationRoot } = await operations();
  if (hasInheritedLocalOperation(userLocalOperationRoot())) return;
  const file = fileURLToPath(url);
  await withLocalOperation(`script:${file}`, async () => {
    await runOwnedCommand(process.execPath, [...process.execArgv,file,...process.argv.slice(2)]);
  }, userLocalOperationRoot(), undefined, {onWaiting: owner => console.log(`[wait] ${owner?.kind} (${owner?.id})`)});
  process.exit(0);
}

if(process.argv[2]==="--verify-parent" && process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){ const {hasInheritedLocalOperation,userLocalOperationRoot}=await operations(); process.exit(hasInheritedLocalOperation(userLocalOperationRoot())?0:3); }
