import { spawn } from 'node:child_process';
export async function runOwnedCommand(cmd, args, cwd = process.cwd()) {
  const {recordLocalOperationChild,localOperationProcessGroupAlive}=await import("../packages/installer/src/local-operation.ts");
  await new Promise((resolvePromise, reject) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', detached: grouped,
      env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', CARGO_BUILD_JOBS: '2', CMAKE_BUILD_PARALLEL_LEVEL: '2' } });
    let ownershipError;
    let cancelled = false;
    const signalGroup = signal => {
      try { grouped && child.pid ? process.kill(-child.pid, signal) : child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const int = () => { cancelled = true; signalGroup('SIGINT'); };
    const term = () => { cancelled = true; signalGroup('SIGTERM'); };
    process.on('SIGINT', int); process.on('SIGTERM', term); process.on('SIGHUP', term);
    const clean = () => { process.off('SIGINT', int); process.off('SIGTERM', term); process.off('SIGHUP', term); };
    child.once('error', error => { clean(); reject(error); });
    child.once('exit', async (code, signal) => {
      try {
      // npm exiting is not proof that its compiler descendants have stopped.
      const groupAlive = () => {
        if (!grouped || !child.pid) return false;
        return localOperationProcessGroupAlive(child.pid);
      };
      if (groupAlive()) signalGroup('SIGTERM');
      const deadline = Date.now() + 10_000;
      while (groupAlive() && Date.now() < deadline) await new Promise(done => setTimeout(done, 100));
      clean();
      if (groupAlive()) {
        const error = new Error('Operation descendants remain alive; reconcile before starting another build');
        error.requiresReconciliation = true; reject(error);
      } else {
        if(child.pid)recordLocalOperationChild(child.pid,cmd,true);
        if (ownershipError) reject(ownershipError);
        else if (code === 0 && !cancelled) resolvePromise();
        else reject(new Error(`${cmd} failed (${signal ?? code})`));
      }
      } catch (error) {
        clean();
        error.requiresReconciliation = true;
        reject(error);
      }
    });
    try {
      if (child.pid) recordLocalOperationChild(child.pid, cmd);
    } catch (error) {
      ownershipError = error;
      error.requiresReconciliation = true;
      try { signalGroup('SIGTERM'); } catch { /* Exit handler retains reconciliation requirement. */ }
    }
  });
}
