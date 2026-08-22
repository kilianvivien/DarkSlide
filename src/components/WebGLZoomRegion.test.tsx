import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebGLZoomRegion, ZoomRegionPreview } from './WebGLZoomRegion';

const mocks = vi.hoisted(() => ({
  createRegionRenderer: vi.fn(),
  draw: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../utils/webglRegionRenderer', () => ({
  createRegionRenderer: mocks.createRegionRenderer,
}));

function makePreview(requestKey: string): ZoomRegionPreview {
  return {
    requestKey,
    imageData: new ImageData(new Uint8ClampedArray(16), 2, 2),
    rect: { x: 0, y: 0, width: 1, height: 1 },
  };
}

describe('WebGLZoomRegion', () => {
  it('keeps one renderer across preview updates', () => {
    mocks.createRegionRenderer.mockReturnValue({
      draw: mocks.draw,
      dispose: mocks.dispose,
    });

    const { rerender, unmount } = render(<WebGLZoomRegion preview={makePreview('first')} />);
    rerender(<WebGLZoomRegion preview={makePreview('second')} />);

    expect(mocks.createRegionRenderer).toHaveBeenCalledTimes(1);
    expect(mocks.draw).toHaveBeenCalledTimes(2);
    expect(mocks.dispose).not.toHaveBeenCalled();

    unmount();
    expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
});
