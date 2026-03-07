import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreState = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
}));

const dialogState = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const fsState = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: coreState.isTauri,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogState.open,
  save: dialogState.save,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: fsState.readFile,
  writeFile: fsState.writeFile,
}));

import { isDesktopShell, openImageFile, saveExportBlob } from './fileBridge';

describe('fileBridge', () => {
  beforeEach(() => {
    coreState.isTauri.mockReturnValue(false);
    dialogState.open.mockReset();
    dialogState.save.mockReset();
    fsState.readFile.mockReset();
    fsState.writeFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reports whether the native desktop shell is active', () => {
    expect(isDesktopShell()).toBe(false);
    coreState.isTauri.mockReturnValue(true);
    expect(isDesktopShell()).toBe(true);
  });

  it('opens an image file through the desktop dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.open.mockResolvedValue('/Users/tester/Desktop/scan.tiff');
    fsState.readFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const file = await openImageFile();

    expect(dialogState.open).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Open Scan',
      multiple: false,
    }));
    expect(fsState.readFile).toHaveBeenCalledWith('/Users/tester/Desktop/scan.tiff');
    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe('scan.tiff');
    expect(file?.type).toBe('image/tiff');
  });

  it('downloads blobs in the browser build', async () => {
    const createObjectURL = vi.fn(() => 'blob:darkslide');
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const anchor = { click } as unknown as HTMLAnchorElement;

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    const result = await saveExportBlob(new Blob(['hello'], { type: 'image/png' }), 'scan.png', 'image/png');

    expect(result).toBe('saved');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('writes exported blobs through the desktop save dialog and handles cancellation', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.save
      .mockResolvedValueOnce('/Users/tester/Desktop/export.webp')
      .mockResolvedValueOnce(null);

    const first = await saveExportBlob(new Blob([new Uint8Array([9, 8, 7])], { type: 'image/webp' }), 'export.webp', 'image/webp');
    const second = await saveExportBlob(new Blob(['ignored'], { type: 'image/jpeg' }), 'ignored.jpg', 'image/jpeg');

    expect(first).toBe('saved');
    expect(fsState.writeFile).toHaveBeenCalledWith(
      '/Users/tester/Desktop/export.webp',
      expect.any(Uint8Array),
    );
    expect(second).toBe('cancelled');
    expect(fsState.writeFile).toHaveBeenCalledTimes(1);
  });
});
