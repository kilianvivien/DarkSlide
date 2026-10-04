// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as UTIF from 'utif';
import { detectFrame, getAutoFrameCrop } from '../src/utils/frameDetection';

function readTiff(path: string) {
  const bytes = readFileSync(path);
  const ifds = UTIF.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  UTIF.decodeImage(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ifds[0]);
  return {
    pixels: new Uint8ClampedArray(UTIF.toRGBA8(ifds[0])),
    width: ifds[0].width,
    height: ifds[0].height,
  };
}

describe('open online film-format samples', () => {
  it('detects the approximately square gate in a 126-film frame', () => {
    const sample = readTiff(fileURLToPath(new URL('./online-samples/126-square-frame.tiff', import.meta.url)));
    const frame = detectFrame(sample.pixels, sample.width, sample.height);

    expect(frame).not.toBeNull();
    if (!frame) return;
    const aspect = ((frame.right - frame.left) * sample.width)
      / ((frame.bottom - frame.top) * sample.height);
    expect(aspect).toBeGreaterThan(0.9);
    expect(aspect).toBeLessThan(1.1);
    expect(frame.left).toBeLessThan(0.08);
    expect(frame.right).toBeGreaterThan(0.9);
    expect(frame.top).toBeLessThan(0.1);
    expect(frame.bottom).toBeGreaterThan(0.82);
  });

  it('maps the detected 126 gate through every quarter turn without losing area', () => {
    const sample = readTiff(fileURLToPath(new URL('./online-samples/126-square-frame.tiff', import.meta.url)));
    const frame = detectFrame(sample.pixels, sample.width, sample.height);
    expect(frame).not.toBeNull();
    if (!frame) return;
    const area = (frame.right - frame.left) * (frame.bottom - frame.top);
    for (const rotation of [0, 90, 180, 270]) {
      const crop = getAutoFrameCrop(frame, rotation);
      expect(crop.width * crop.height).toBeCloseTo(area, 8);
    }
  });
});
