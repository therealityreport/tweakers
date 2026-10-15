export const digestSentinel = Buffer.from("AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A");
export const slotOffset = 256;

export function integrityMachO(options: { used?: number; version?: number; digest?: Buffer; little?: boolean; wide?: boolean; slot?: boolean } = {}): Buffer {
  const little = options.little ?? true, wide = options.wide ?? true;
  const binary = Buffer.alloc(384);
  const u32 = (value: number, at: number) => little ? binary.writeUInt32LE(value, at) : binary.writeUInt32BE(value, at);
  const u64 = (value: number, at: number) => little ? binary.writeBigUInt64LE(BigInt(value), at) : binary.writeBigUInt64BE(BigInt(value), at);
  u32(wide ? 0xfeedfacf : 0xfeedface, 0);
  u32(wide ? 0x0100000c : 7, 4);
  u32(6, 12); // MH_DYLIB
  if (options.slot === false) return binary;
  u32(1, 16);
  const command = wide ? 32 : 28, segmentHeader = wide ? 72 : 56, sectionSize = wide ? 80 : 68;
  u32(segmentHeader + sectionSize, 20);
  u32(wide ? 0x19 : 1, command);
  u32(segmentHeader + sectionSize, command + 4);
  binary.write("__DATA_CONST", command + 8);
  if (wide) u64(slotOffset, command + 24); else u32(slotOffset, command + 24);
  if (wide) { u64(slotOffset, command + 40); u64(66, command + 48); }
  else { u32(slotOffset, command + 32); u32(66, command + 36); }
  u32(1, command + (wide ? 64 : 48));
  const section = command + segmentHeader;
  binary.write("__asar_integrity", section);
  binary.write("__DATA_CONST", section + 16);
  if (wide) u64(slotOffset, section + 32); else u32(slotOffset, section + 32);
  if (wide) u64(66, section + 40); else u32(66, section + 36);
  u32(slotOffset, section + (wide ? 48 : 40));
  digestSentinel.copy(binary, slotOffset);
  binary[slotOffset + 32] = options.used ?? 1;
  binary[slotOffset + 33] = options.version ?? 1;
  (options.digest ?? Buffer.alloc(32)).copy(binary, slotOffset + 34);
  return binary;
}

export function universalMachO(slices: Buffer[], little = false, wide = false): Buffer {
  const stride = wide ? 32 : 20, header = 8 + slices.length * stride;
  const binary = Buffer.alloc(header + slices.reduce((sum, slice) => sum + slice.length, 0));
  const u32 = (value: number, at: number) => little ? binary.writeUInt32LE(value, at) : binary.writeUInt32BE(value, at);
  const u64 = (value: number, at: number) => little ? binary.writeBigUInt64LE(BigInt(value), at) : binary.writeBigUInt64BE(BigInt(value), at);
  u32(wide ? 0xcafebabf : 0xcafebabe, 0); u32(slices.length, 4);
  let offset = header;
  slices.forEach((slice, i) => {
    const at = 8 + i * stride;
    u32(i ? 0x01000007 : 0x0100000c, at);
    if (wide) { u64(offset, at + 8); u64(slice.length, at + 16); }
    else { u32(offset, at + 8); u32(slice.length, at + 12); }
    slice.copy(binary, offset); offset += slice.length;
  });
  return binary;
}
