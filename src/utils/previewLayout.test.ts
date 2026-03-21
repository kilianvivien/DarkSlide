import { describe, expect, it } from 'vitest';
import { computeViewportFitScale, isFullFrameFreeCrop, resolveRenderTargetSelection } from './previewLayout';

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

describe('resolveRenderTargetSelection', () => {
  const previewLevels = [
    { id: 'preview-1024', width: 1024, height: 768, maxDimension: 1024 },
    { id: 'preview-2048', width: 2048, height: 1536, maxDimension: 2048 },
    { id: 'preview-4096', width: 4096, height: 3072, maxDimension: 4096 },
    { id: 'preview-source', width: 6048, height: 4032, maxDimension: 6048 },
  ];

  it('holds the previous level until the zoom meaningfully crosses the next boundary', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      1100,
      { previewLevelId: 'preview-1024', targetDimension: 1024 },
      false,
    )).toEqual({
      previewLevelId: 'preview-1024',
      targetDimension: 1024,
    });
  });

  it('allows the level to change once the hysteresis margin is exceeded', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      1200,
      { previewLevelId: 'preview-1024', targetDimension: 1024 },
      false,
    )).toEqual({
      previewLevelId: 'preview-2048',
      targetDimension: 1200,
    });
  });

  it('commits the live target when the interaction ends even within the same level', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      1500,
      { previewLevelId: 'preview-2048', targetDimension: 1300 },
      true,
    )).toEqual({
      previewLevelId: 'preview-2048',
      targetDimension: 1500,
    });
  });

  it('prefers the 4096 preview tier until the request is close to source resolution', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      5400,
      { previewLevelId: 'preview-4096', targetDimension: 4096 },
      true,
    )).toEqual({
      previewLevelId: 'preview-4096',
      targetDimension: 4096,
    });
  });

  it('allows a settled source render once the request is meaningfully close to native size', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      5700,
      { previewLevelId: 'preview-4096', targetDimension: 4096 },
      true,
    )).toEqual({
      previewLevelId: 'preview-source',
      targetDimension: 5700,
    });
  });

  it('drops back to the 4096 tier when a source render falls far enough below native size', () => {
    expect(resolveRenderTargetSelection(
      previewLevels,
      5000,
      { previewLevelId: 'preview-source', targetDimension: 6048 },
      true,
    )).toEqual({
      previewLevelId: 'preview-4096',
      targetDimension: 4096,
    });
  });
});
