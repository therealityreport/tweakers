import { readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Remove only obsolete compiler outputs for tests excluded from the production build.
function prune(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) prune(path);
    else if (entry.isFile() && /\.test\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/.test(entry.name)) unlinkSync(path);
  }
}
prune(resolve(process.argv[2] ?? 'dist'));
