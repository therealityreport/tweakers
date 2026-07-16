import { appendFileSync, renameSync, statSync, writeFileSync } from "node:fs";

export const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function appendCappedLog(path: string, line: string, maxBytes = MAX_LOG_BYTES): void {
  const incoming = Buffer.from(line);
  if (incoming.byteLength >= maxBytes) {
    try {
      statSync(path);
      renameSync(path, `${path}.1`);
    } catch {
      // If rotation fails, overwrite the primary log below.
    }
    writeFileSync(path, incoming.subarray(incoming.byteLength - maxBytes));
    return;
  }

  try {
    const size = statSync(path).size;
    if (size + incoming.byteLength > maxBytes) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    // If stat or rotation fails, still try to append below; logging must be best-effort.
  }

  appendFileSync(path, incoming);
}
