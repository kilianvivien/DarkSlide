// Test helper: builds the binary payload decode_raw_binary returns
// (see src-tauri/src/lib.rs). 8-bit fixtures are scaled to 16-bit, the only
// depth the native decoder produces.
export function rawIpcPayload({
  width,
  height,
  data,
  bitDepth,
  orientation,
}: {
  width: number;
  height: number;
  data: ArrayLike<number>;
  bitDepth?: number;
  orientation?: number | null;
  [key: string]: unknown;
}): ArrayBuffer {
  const header = 32;
  const buffer = new ArrayBuffer(header + data.length * 2);
  const bytes = new Uint8Array(buffer);
  bytes.set(Array.from('DSRIPC01', (char) => char.charCodeAt(0)), 0);
  const view = new DataView(buffer);
  view.setUint16(8, 1, true);
  view.setUint16(10, 16, true);
  view.setUint32(12, width, true);
  view.setUint32(16, height, true);
  view.setUint16(20, orientation ?? 0, true);
  view.setBigUint64(24, BigInt(data.length), true);
  const scale = bitDepth === 16 ? 1 : 257;
  for (let index = 0; index < data.length; index += 1) {
    view.setUint16(header + index * 2, Math.min(65535, Math.round(data[index] * scale)), true);
  }
  return buffer;
}
