import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Electron's package-time dictionary seal is independent of the ASAR header
// hash. Keep it enabled when rewriting the signed plist, before re-signing.
// https://github.com/electron/electron/blob/main/shell/common/asar/integrity_digest.mm
const SENTINEL = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A", "ascii");
const SLOT_SIZE = 66;

export function integrityDictionaryDigest(value: unknown): Buffer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Electron ASAR integrity dictionary is malformed");
  }
  const entries = value as Record<string, unknown>;
  const digest = createHash("sha256");
  for (const key of Object.keys(entries).sort()) {
    const entry = entries[key];
    if (!key || key.includes("\0") || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Electron ASAR integrity dictionary entry is malformed");
    }
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, "algorithm") || !Object.hasOwn(fields, "hash")
      || fields.algorithm !== "SHA256" || typeof fields.hash !== "string" || !/^[a-f0-9]{64}$/i.test(fields.hash)) {
      throw new Error(`Electron ASAR integrity dictionary entry is unsupported: ${key}`);
    }
    // NSString's literal ordering uses UTF-16 code units, as does JS sort.
    // Hash exact UTF-8 values; case normalization would change Electron's seal.
    digest.update(key).update(fields.algorithm).update(fields.hash);
  }
  if (!Object.keys(entries).length) throw new Error("Electron ASAR integrity dictionary is empty");
  return digest.digest();
}

interface Slice { offset: number; size: number }

function dictionarySlots(binary: Buffer): number[] {
  const fail = (): never => { throw new Error("Malformed Electron Mach-O integrity digest layout"); };
  const bounded = (offset: number, size: number, start = 0, end = binary.length): void => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 0 || offset < start || offset > end - size) fail();
  };
  bounded(0, 4);
  const magic = binary.readUInt32BE(0);
  let slices: Slice[];
  if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
    const u32 = (at: number) => little ? binary.readUInt32LE(at) : binary.readUInt32BE(at);
    const u64 = (at: number) => Number(little ? binary.readBigUInt64LE(at) : binary.readBigUInt64BE(at));
    bounded(0, 8);
    const count = u32(4), stride = wide ? 32 : 20;
    if (!count || count > 32) fail();
    bounded(8, count * stride);
    slices = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + i * stride;
      const offset = wide ? u64(at + 8) : u32(at + 8);
      const size = wide ? u64(at + 16) : u32(at + 12);
      bounded(offset, size, 8 + count * stride);
      if (!size || slices.some(s => offset < s.offset + s.size && s.offset < offset + size)) fail();
      slices.push({ offset, size });
    }
  } else slices = [{ offset: 0, size: binary.length }];
  const slots: number[] = [];
  const name = (at: number) => binary.subarray(at, at + 16).toString("ascii").replace(/\0.*$/, "");
  for (const slice of slices) {
    const end = slice.offset + slice.size;
    bounded(slice.offset, 28, slice.offset, end);
    const m = binary.readUInt32BE(slice.offset);
    const little = m === 0xcefaedfe || m === 0xcffaedfe;
    const wide = m === 0xfeedfacf || m === 0xcffaedfe;
    if (![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(m)) fail();
    const u32 = (at: number) => little ? binary.readUInt32LE(at) : binary.readUInt32BE(at);
    const u64 = (at: number) => Number(little ? binary.readBigUInt64LE(at) : binary.readBigUInt64BE(at));
    const header = wide ? 32 : 28, count = u32(slice.offset + 16), bytes = u32(slice.offset + 20);
    bounded(slice.offset + header, bytes, slice.offset, end);
    if (count > bytes / 8) fail();
    let command = slice.offset + header, found = false;
    const commandsEnd = command + bytes;
    for (let i = 0; i < count; i++) {
      bounded(command, 8, slice.offset, commandsEnd);
      const kind = u32(command), size = u32(command + 4);
      if (size < 8) fail();
      bounded(command, size, slice.offset, commandsEnd);
      if (kind === (wide ? 0x19 : 0x1)) {
        const segmentHeader = wide ? 72 : 56, sectionSize = wide ? 80 : 68;
        bounded(command, segmentHeader, slice.offset, command + size);
        const sections = u32(command + (wide ? 64 : 48));
        if (size !== segmentHeader + sections * sectionSize) fail();
        const segmentOffset = wide ? u64(command + 40) : u32(command + 32);
        const segmentBytes = wide ? u64(command + 48) : u32(command + 36);
        bounded(slice.offset + segmentOffset, segmentBytes, slice.offset, end);
        for (let j = 0; j < sections; j++) {
          const section = command + segmentHeader + j * sectionSize;
          if (name(section) !== "__asar_integrity") continue;
          if (found || name(command + 8) !== "__DATA_CONST" || name(section + 16) !== "__DATA_CONST") fail();
          const length = wide ? u64(section + 40) : u32(section + 36);
          const offset = slice.offset + u32(section + (wide ? 48 : 40));
          const segmentAddress = wide ? u64(command + 24) : u32(command + 24);
          const sectionAddress = wide ? u64(section + 32) : u32(section + 32);
          const flags = u32(section + (wide ? 64 : 56));
          if (length !== SLOT_SIZE || offset < commandsEnd || (flags & 0xff) !== 0
            || !Number.isSafeInteger(segmentAddress) || !Number.isSafeInteger(sectionAddress)
            || sectionAddress - segmentAddress !== offset - slice.offset - segmentOffset) fail();
          bounded(offset, length, slice.offset + segmentOffset, slice.offset + segmentOffset + segmentBytes);
          if (!binary.subarray(offset, offset + 32).equals(SENTINEL)) fail();
          const used = binary[offset + 32], version = binary[offset + 33];
          if (!((used === 1 && version === 1) || (used === 0 && version === 0))) {
            throw new Error("Unsupported Electron ASAR integrity digest slot version");
          }
          slots.push(offset); found = true;
        }
      }
      command += size;
    }
    if (command !== commandsEnd) fail();
  }
  // A sentinel outside a validated section is ambiguous, not permission to
  // patch arbitrary bytes. Each supported architecture has its own slot.
  let hit = -1, hits = 0;
  while ((hit = binary.indexOf(SENTINEL, hit + 1)) >= 0) {
    if (!slots.includes(hit)) fail();
    hits++;
  }
  if (hits !== slots.length || (slots.length && slots.length !== slices.length)) fail();
  return slots;
}

export function setElectronIntegrityDictionaryDigest(binaryPath: string, dictionary: unknown): void {
  const binary = readFileSync(binaryPath), slots = dictionarySlots(binary);
  if (!slots.length) return; // Older Electron frameworks have no dictionary seal.
  const digest = integrityDictionaryDigest(dictionary);
  for (const offset of slots) {
    binary[offset + 32] = 1;
    binary[offset + 33] = 1;
    digest.copy(binary, offset + 34);
  }
  writeFileSync(binaryPath, binary);
}

export function assertElectronIntegrityDictionaryDigest(binaryPath: string, dictionary: unknown, options: { allowLegacyUnusedSlot?: boolean } = {}): void {
  const binary = readFileSync(binaryPath), slots = dictionarySlots(binary);
  if (!slots.length) return;
  const digest = integrityDictionaryDigest(dictionary);
  for (const offset of slots) {
    // A receipt-bound existing installation may predate package-time sealing.
    // New construction remains strict; never waive a used or nonzero slot.
    if (options.allowLegacyUnusedSlot && binary[offset + 32] === 0
      && binary.subarray(offset + 34, offset + SLOT_SIZE).equals(Buffer.alloc(32))) continue;
    if (binary[offset + 32] !== 1 || !binary.subarray(offset + 34, offset + SLOT_SIZE).equals(digest)) {
      throw new Error("Electron embedded ASAR integrity dictionary digest does not match Info.plist");
    }
  }
}
