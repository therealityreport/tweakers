import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";

export interface RawAsarFileSystem {
  lstatSync: typeof nodeFs.lstatSync;
  openSync: typeof nodeFs.openSync;
  readSync: typeof nodeFs.readSync;
  closeSync: typeof nodeFs.closeSync;
}

function readExactly(
  fileSystem: RawAsarFileSystem,
  descriptor: number,
  buffer: Buffer,
  position: number,
  truncatedMessage: string,
): void {
  let offset = 0;
  while (offset < buffer.length) {
    const remaining = buffer.length - offset;
    const bytesRead = fileSystem.readSync(
      descriptor,
      buffer,
      offset,
      remaining,
      position + offset,
    );
    if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > remaining) {
      throw new Error("promotion ASAR read result is invalid");
    }
    if (bytesRead === 0) throw new Error(truncatedMessage);
    offset += bytesRead;
  }
}

/** Hash the decoded ASAR header JSON using an explicitly raw filesystem. */
export function hashRawAsarHeader(
  archivePath: string,
  fileSystem: RawAsarFileSystem = nodeFs,
): string {
  const stat = fileSystem.lstatSync(archivePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16) {
    throw new Error("promotion app surface is not a regular ASAR archive");
  }
  const descriptor = fileSystem.openSync(archivePath, "r");
  try {
    const sizeBuffer = Buffer.alloc(8);
    readExactly(fileSystem, descriptor, sizeBuffer, 0, "promotion ASAR size pickle is truncated");
    if (sizeBuffer.readUInt32LE(0) !== 4) throw new Error("promotion ASAR size pickle is invalid");
    const headerSize = sizeBuffer.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || headerSize + 8 > stat.size) {
      throw new Error("promotion ASAR header size is invalid");
    }
    const headerBuffer = Buffer.alloc(headerSize);
    readExactly(fileSystem, descriptor, headerBuffer, 8, "promotion ASAR header is truncated");
    const payloadSize = headerBuffer.readUInt32LE(0);
    const stringSize = headerBuffer.readInt32LE(4);
    if (payloadSize < 4 || payloadSize > headerSize - 4 || stringSize <= 0 || stringSize > payloadSize - 4) {
      throw new Error("promotion ASAR header pickle is invalid");
    }
    const headerString = headerBuffer.subarray(8, 8 + stringSize).toString("utf8");
    JSON.parse(headerString);
    return createHash("sha256").update(headerString).digest("hex");
  } finally {
    fileSystem.closeSync(descriptor);
  }
}
