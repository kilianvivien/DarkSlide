import { describe, expect, it } from 'vitest';
import { resolveBatchConcurrency } from './batchConcurrency';

describe('resolveBatchConcurrency', () => {
  it('uses three workers on a typical 16 GB machine', () => {
    expect(resolveBatchConcurrency('auto', { hardwareConcurrency: 8, deviceMemoryGb: 16 })).toBe(3);
  });

  it('allows five workers only when CPU and memory both support it', () => {
    expect(resolveBatchConcurrency('auto', { hardwareConcurrency: 12, deviceMemoryGb: 32 })).toBe(5);
    expect(resolveBatchConcurrency('auto', { hardwareConcurrency: 8, deviceMemoryGb: 32 })).toBe(4);
    expect(resolveBatchConcurrency('auto', { hardwareConcurrency: 12, deviceMemoryGb: 4 })).toBe(2);
  });

  it('uses a conservative default when memory information is unavailable', () => {
    expect(resolveBatchConcurrency('auto', { hardwareConcurrency: 12 })).toBe(3);
  });

  it('respects a manual override', () => {
    expect(resolveBatchConcurrency(5, { hardwareConcurrency: 2, deviceMemoryGb: 4 })).toBe(5);
  });
});
