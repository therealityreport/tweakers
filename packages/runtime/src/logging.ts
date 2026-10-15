import { appendFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function appendCappedLog(path: string, line: string, maxBytes = MAX_LOG_BYTES, retainedArchives = 1): void {
  const incoming = Buffer.from(line);
  const rotate = (): void => {
    for (let index = retainedArchives; index > 1; index -= 1) {
      try { renameSync(`${path}.${index - 1}`, `${path}.${index}`); } catch { /* absent archive */ }
    }
    renameSync(path, `${path}.1`);
  };
  if (incoming.byteLength >= maxBytes) {
    try {
      statSync(path);
      rotate();
    } catch {
      // If rotation fails, overwrite the primary log below.
    }
    writeFileSync(path, incoming.subarray(incoming.byteLength - maxBytes));
    return;
  }

  try {
    const size = statSync(path).size;
    if (size + incoming.byteLength > maxBytes) {
      rotate();
    }
  } catch {
    // If stat or rotation fails, still try to append below; logging must be best-effort.
  }

  appendFileSync(path, incoming);
}
