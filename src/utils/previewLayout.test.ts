import { describe, expect, it } from 'vitest';
import { computeViewportFitScale, isFullFrameFreeCrop } from './previewLayout';

describe('computeViewportFitScale', () => {
  it('reserves overlay padding so crop handles stay inside the viewport', () => {
    expect(computeViewportFitScale({
      viewportWidth: 1000,
      viewportHeight: 800,
      previewWidth: 1000,
      previewHeight: 800,
      overlayPadding: 56,
    })).toBeCloseTo(0.86, 5);
  });

  it('never upscales beyond 100 percent', () => {
    expect(computeViewportFitScale({
      viewportWidth: 1600,
      viewportHeight: 1200,
      previewWidth: 800,
      previewHeight: 600,
      overlayPadding: 56,
    })).toBe(1);
  });
});

describe('isFullFrameFreeCrop', () => {
  it('recognizes the default free crop rectangle', () => {
    expect(isFullFrameFreeCrop({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: null,
    })).toBe(true);
  });

  it('rejects locked or already-adjusted crops', () => {
    expect(isFullFrameFreeCrop({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: 4 / 5,
    })).toBe(false);

    expect(isFullFrameFreeCrop({
      x: 0.05,
      y: 0,
      width: 0.95,
      height: 1,
      aspectRatio: null,
    })).toBe(false);
  });
});
