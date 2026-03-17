import { describe, expect, it } from 'vitest';
import { hashFloat32Array } from './WebGPUPipeline';

describe('hashFloat32Array', () => {
  it('returns the same hash for identical payloads', () => {
    expect(hashFloat32Array(new Float32Array([1, 2, 3, 4]))).toBe(
      hashFloat32Array(new Float32Array([1, 2, 3, 4])),
    );
  });

  it('returns a different hash for different payloads', () => {
    expect(hashFloat32Array(new Float32Array([1, 2, 3, 4]))).not.toBe(
      hashFloat32Array(new Float32Array([1, 2, 3, 5])),
    );
  });
});
