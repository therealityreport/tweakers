import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Optimistic read snapshot. A concurrent generation invalidates the result. */
export function guardStableInputs(paths) {
  const inventory = () => {
    const rows = [];
    const walk = path => {
      let st;
      try { st = lstatSync(path); }
      catch (error) { if (error.code === 'ENOENT') { rows.push([path, 'missing']); return; } throw error; }
      rows.push([path, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs]);
      if (st.isDirectory()) for (const name of readdirSync(path).sort()) {
        if (!['.git', 'node_modules', '.DS_Store'].includes(name)) walk(join(path,name));
      }
      if (st.isSymbolicLink()) {
        const target = statSync(path);
        rows.push([path, readlinkSync(path), realpathSync(path), target.dev, target.ino, target.size, target.mtimeMs, target.ctimeMs]);
      }
    };
    paths.forEach(walk);
    return JSON.stringify(rows);
  };
  const before = inventory();
  return () => {
    if (inventory() !== before) throw new Error('Read-only inputs changed during verification; rerun after generation settles');
  };
}
