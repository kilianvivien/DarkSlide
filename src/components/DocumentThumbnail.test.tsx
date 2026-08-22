import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultSettings, DEFAULT_COLOR_MANAGEMENT, DEFAULT_EXPORT_OPTIONS, FILM_PROFILES } from '../constants';
import { WorkspaceDocument } from '../types';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { DocumentThumbnail } from './DocumentThumbnail';

function createDocument(status: WorkspaceDocument['status'], exposure = 0, renderRevision = 1): WorkspaceDocument {
  return {
    id: 'doc-1',
    source: {
      id: 'doc-1',
      name: 'frame.tiff',
      mime: 'image/tiff',
      extension: '.tiff',
      size: 1024,
      width: 1200,
      height: 800,
    },
    settings: createDefaultSettings({ exposure }),
    exportOptions: DEFAULT_EXPORT_OPTIONS,
    colorManagement: DEFAULT_COLOR_MANAGEMENT,
    profileId: FILM_PROFILES[0].id,
    labStyleId: null,
    lightSourceId: 'auto',
    previewLevels: [{ id: 'preview-1024', width: 1024, height: 683, maxDimension: 1024 }],
    histogram: null,
    renderRevision,
    status,
    dirty: false,
  } as WorkspaceDocument;
}

describe('DocumentThumbnail', () => {
  it('queues a first inactive thumbnail without an extra delay', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);
    const renderThumbnail = vi.fn(async (payload: { documentId: string; revision: number }) => ({
      documentId: payload.documentId,
      revision: payload.revision,
      width: 1,
      height: 1,
      previewLevelId: 'preview-512',
      imageData: new ImageData(new Uint8ClampedArray(4), 1, 1),
      histogram: { r: [], g: [], b: [], l: [] },
      highlightDensity: 0,
    }));

    render(
      <DocumentThumbnail
        workerClient={{ renderThumbnail } as unknown as ImageWorkerClient}
        document={createDocument('ready')}
        profile={FILM_PROFILES[0]}
        lightSource={null}
      />,
    );

    expect(renderThumbnail).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(renderThumbnail).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('waits for a ready document and debounces active-frame thumbnail work', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      putImageData: vi.fn(),
    }) as unknown as CanvasRenderingContext2D);

    const renderThumbnail = vi.fn(async (payload: { documentId: string; revision: number }) => ({
      documentId: payload.documentId,
      revision: payload.revision,
      width: 1,
      height: 1,
      previewLevelId: 'preview-1024',
      imageData: new ImageData(new Uint8ClampedArray(4), 1, 1),
      histogram: { r: [], g: [], b: [], l: [] },
      highlightDensity: 0,
    }));
    const workerClient = { renderThumbnail } as unknown as ImageWorkerClient;
    const profile = FILM_PROFILES[0];

    const { rerender } = render(
      <DocumentThumbnail
        workerClient={workerClient}
        document={createDocument('processing')}
        profile={profile}
        lightSource={null}
        isActive
      />,
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(renderThumbnail).not.toHaveBeenCalled();

    rerender(
      <DocumentThumbnail
        workerClient={workerClient}
        document={createDocument('ready')}
        profile={profile}
        lightSource={null}
        isActive
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(renderThumbnail).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(renderThumbnail).toHaveBeenCalledTimes(1);
    expect(renderThumbnail).toHaveBeenLastCalledWith(expect.objectContaining({
      previewMode: 'settled',
    }));

    rerender(
      <DocumentThumbnail
        workerClient={workerClient}
        document={createDocument('ready', 1)}
        profile={profile}
        lightSource={null}
        isActive
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(renderThumbnail).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(renderThumbnail).toHaveBeenCalledTimes(2);

    rerender(
      <DocumentThumbnail
        workerClient={workerClient}
        document={createDocument('ready', 1, 2)}
        profile={profile}
        lightSource={null}
        isActive
      />,
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(renderThumbnail).toHaveBeenCalledTimes(3);
    expect(renderThumbnail).toHaveBeenLastCalledWith(expect.objectContaining({
      revision: 2,
      previewMode: 'settled',
    }));
    vi.useRealTimers();
  });
});
