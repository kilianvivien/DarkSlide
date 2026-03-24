import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coreState = vi.hoisted(() => ({
  isTauri: vi.fn(() => false),
  invoke: vi.fn(),
}));

const dialogState = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  ask: vi.fn(),
}));

const fsState = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

const pathState = vi.hoisted(() => ({
  downloadDir: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: coreState.isTauri,
  invoke: coreState.invoke,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogState.open,
  save: dialogState.save,
  ask: dialogState.ask,
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: fsState.readFile,
  stat: fsState.stat,
  writeFile: fsState.writeFile,
  readTextFile: fsState.readTextFile,
  writeTextFile: fsState.writeTextFile,
}));

vi.mock('@tauri-apps/api/path', () => ({
  downloadDir: pathState.downloadDir,
}));

import { confirmDeletePreset, confirmReplacePresetLibrary, getDesktopDownloadsDirectory, isDesktopShell, openDirectory, openImageFile, openInExternalEditor, openPresetBackupFile, openPresetFile, saveExportBlob, savePresetBackupFile, savePresetFile, saveToDirectory } from './fileBridge';

describe('fileBridge', () => {
  beforeEach(() => {
    coreState.isTauri.mockReturnValue(false);
    dialogState.open.mockReset();
    dialogState.save.mockReset();
    dialogState.ask.mockReset();
    fsState.readFile.mockReset();
    fsState.stat.mockReset();
    fsState.writeFile.mockReset();
    fsState.readTextFile.mockReset();
    fsState.writeTextFile.mockReset();
    pathState.downloadDir.mockReset();
    coreState.invoke.mockReset();
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

    const result = await openImageFile();

    expect(dialogState.open).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Open Scan',
      multiple: false,
      filters: [expect.objectContaining({
        name: 'All Supported Images',
        extensions: expect.arrayContaining(['tif', 'tiff', 'png', 'jpg', 'jpeg', 'webp', 'dng', 'cr3', 'nef', 'arw', 'raf', 'rw2']),
      })],
    }));
    expect(fsState.readFile).toHaveBeenCalledWith('/Users/tester/Desktop/scan.tiff');
    expect(result?.file).toBeInstanceOf(File);
    expect(result?.file.name).toBe('scan.tiff');
    expect(result?.file.type).toBe('image/tiff');
    expect(result?.path).toBe('/Users/tester/Desktop/scan.tiff');
    expect(result?.size).toBe(4);
  });

  it('opens RAW files through the desktop dialog without reading them into JS first', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.open.mockResolvedValue('/Users/tester/Desktop/scan.nef');
    fsState.stat.mockResolvedValue({ size: 30_955_119 });

    const result = await openImageFile();

    expect(fsState.readFile).not.toHaveBeenCalled();
    expect(fsState.stat).toHaveBeenCalledWith('/Users/tester/Desktop/scan.nef');
    expect(result?.file.name).toBe('scan.nef');
    expect(result?.file.size).toBe(0);
    expect(result?.size).toBe(30_955_119);
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

  it('opens a browser directory picker when available', async () => {
    const showDirectoryPicker = vi.fn().mockResolvedValue({ name: 'DarkSlide Exports' });
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);

    await expect(openDirectory()).resolves.toBe('[browser-dir] DarkSlide Exports');
    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
  });

  it('returns null for the desktop Downloads directory outside Tauri', async () => {
    await expect(getDesktopDownloadsDirectory()).resolves.toBeNull();
    expect(pathState.downloadDir).not.toHaveBeenCalled();
  });

  it('returns the desktop Downloads directory in Tauri', async () => {
    coreState.isTauri.mockReturnValue(true);
    pathState.downloadDir.mockResolvedValue('/Users/tester/Downloads');

    await expect(getDesktopDownloadsDirectory()).resolves.toBe('/Users/tester/Downloads');
    expect(pathState.downloadDir).toHaveBeenCalledTimes(1);
  });

  it('reuses the selected browser directory handle for batch saves', async () => {
    const write = vi.fn();
    const close = vi.fn();
    const createWritable = vi.fn().mockResolvedValue({ write, close });
    const getFileHandle = vi.fn()
      .mockRejectedValueOnce(new Error('missing'))
      .mockResolvedValueOnce({ createWritable });
    const directoryHandle = {
      name: 'DarkSlide Exports',
      getFileHandle,
    };
    const showDirectoryPicker = vi.fn().mockResolvedValue(directoryHandle);
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);

    await openDirectory();
    const savedPath = await saveToDirectory(new Blob(['hello'], { type: 'image/png' }), 'scan.png', '[browser-dir] DarkSlide Exports');

    expect(showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(getFileHandle).toHaveBeenCalledWith('scan.png');
    expect(getFileHandle).toHaveBeenCalledWith('scan.png', { create: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(savedPath).toBe('[browser-dir] DarkSlide Exports/scan.png');
  });

  it('opens preset files through the desktop dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.open.mockResolvedValue('/Users/tester/Desktop/preset.darkslide');
    fsState.readTextFile.mockResolvedValue('{"darkslideVersion":"1.0.0"}');

    const result = await openPresetFile();

    expect(fsState.readTextFile).toHaveBeenCalledWith('/Users/tester/Desktop/preset.darkslide');
    expect(result).toEqual({
      content: '{"darkslideVersion":"1.0.0"}',
      fileName: 'preset.darkslide',
    });
  });

  it('writes preset backups through the desktop save dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.save.mockResolvedValue('/Users/tester/Desktop/library.darkslide-library');

    const result = await savePresetBackupFile('{"kind":"preset-backup"}', 'library.darkslide-library');

    expect(result).toBe('saved');
    expect(dialogState.save).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Export Preset Backup',
      defaultPath: 'library.darkslide-library',
      filters: [expect.objectContaining({
        name: 'DarkSlide Preset Backup',
        extensions: ['darkslide-library'],
      })],
    }));
    expect(fsState.writeTextFile).toHaveBeenCalledWith('/Users/tester/Desktop/library.darkslide-library', '{"kind":"preset-backup"}');
  });

  it('opens preset backup files through the desktop dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.open.mockResolvedValue('/Users/tester/Desktop/library.darkslide-library');
    fsState.readTextFile.mockResolvedValue('{"kind":"preset-backup"}');

    const result = await openPresetBackupFile();

    expect(fsState.readTextFile).toHaveBeenCalledWith('/Users/tester/Desktop/library.darkslide-library');
    expect(result).toEqual({
      content: '{"kind":"preset-backup"}',
      fileName: 'library.darkslide-library',
    });
  });

  it('confirms preset library replacement through the desktop dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.ask.mockResolvedValue(true);

    const result = await confirmReplacePresetLibrary();

    expect(result).toBe(true);
    expect(dialogState.ask).toHaveBeenCalledWith(
      'Importing a preset backup will replace all existing custom presets and folders. Continue?',
      expect.objectContaining({
        title: 'Replace Preset Library',
        okLabel: 'Replace',
      }),
    );
  });

  it('uses Downloads when no custom open-in-editor destination is configured', async () => {
    coreState.isTauri.mockReturnValue(true);
    pathState.downloadDir.mockResolvedValue('/Users/tester/Downloads');
    coreState.invoke
      .mockResolvedValueOnce({ savedPath: '/Users/tester/Downloads/scan.jpg' })
      .mockResolvedValueOnce(undefined);

    const result = await openInExternalEditor(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'scan.jpg',
      null,
      null,
    );

    expect(result).toEqual({
      savedPath: '/Users/tester/Downloads/scan.jpg',
      destinationDirectory: '/Users/tester/Downloads',
    });
    expect(coreState.invoke).toHaveBeenNthCalledWith(1, 'save_blob_to_directory', {
      bytes: [1, 2, 3],
      filename: 'scan.jpg',
      destinationDirectory: '/Users/tester/Downloads',
    });
    expect(coreState.invoke).toHaveBeenNthCalledWith(2, 'open_saved_file_in_editor', {
      path: '/Users/tester/Downloads/scan.jpg',
      editorPath: null,
    });
  });

  it('uses the configured destination folder and editor for open in editor', async () => {
    coreState.isTauri.mockReturnValue(true);
    coreState.invoke
      .mockResolvedValueOnce({ savedPath: '/Users/tester/Pictures/DarkSlide/scan.jpg' })
      .mockResolvedValueOnce(undefined);

    const result = await openInExternalEditor(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'scan.jpg',
      '/Applications/Pixelmator Pro.app',
      '/Users/tester/Pictures/DarkSlide',
    );

    expect(result).toEqual({
      savedPath: '/Users/tester/Pictures/DarkSlide/scan.jpg',
      destinationDirectory: '/Users/tester/Pictures/DarkSlide',
    });
    expect(coreState.invoke).toHaveBeenNthCalledWith(1, 'save_blob_to_directory', {
      bytes: [1, 2, 3],
      filename: 'scan.jpg',
      destinationDirectory: '/Users/tester/Pictures/DarkSlide',
    });
    expect(coreState.invoke).toHaveBeenNthCalledWith(2, 'open_saved_file_in_editor', {
      path: '/Users/tester/Pictures/DarkSlide/scan.jpg',
      editorPath: '/Applications/Pixelmator Pro.app',
    });
  });

  it('returns the native saved path when saving to a directory on desktop', async () => {
    coreState.isTauri.mockReturnValue(true);
    coreState.invoke.mockResolvedValue({ savedPath: '/Users/tester/Downloads/scan-2.jpg' });

    const savedPath = await saveToDirectory(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'scan.jpg',
      '/Users/tester/Downloads',
    );

    expect(savedPath).toBe('/Users/tester/Downloads/scan-2.jpg');
    expect(coreState.invoke).toHaveBeenCalledWith('save_blob_to_directory', {
      bytes: [1, 2, 3],
      filename: 'scan.jpg',
      destinationDirectory: '/Users/tester/Downloads',
    });
  });

  it('preserves the invoke failure reason and saved path when opening fails', async () => {
    coreState.isTauri.mockReturnValue(true);
    pathState.downloadDir.mockResolvedValue('/Users/tester/Downloads');
    coreState.invoke
      .mockResolvedValueOnce({ savedPath: '/Users/tester/Downloads/scan.jpg' })
      .mockRejectedValueOnce(new Error('Application could not be opened.'));

    await expect(openInExternalEditor(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
      'scan.jpg',
      '/Applications/Pixelmator Pro.app',
      null,
    )).rejects.toMatchObject({
      message: 'Failed to save and open exported file at /Users/tester/Downloads/scan.jpg with editor /Applications/Pixelmator Pro.app: Application could not be opened.',
      savedPath: '/Users/tester/Downloads/scan.jpg',
      destinationDirectory: '/Users/tester/Downloads',
      editorPath: '/Applications/Pixelmator Pro.app',
    });
  });

  it('downloads preset files in the browser build', async () => {
    const createObjectURL = vi.fn(() => 'blob:preset');
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    const anchor = { click } as unknown as HTMLAnchorElement;

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    const result = await savePresetFile('{"darkslideVersion":"1.0.0"}', 'preset.darkslide');

    expect(result).toBe('saved');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('writes preset files through the desktop save dialog', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.save.mockResolvedValue('/Users/tester/Desktop/preset.darkslide');

    const result = await savePresetFile('{"darkslideVersion":"1.0.0"}', 'preset.darkslide');

    expect(result).toBe('saved');
    expect(fsState.writeTextFile).toHaveBeenCalledWith(
      '/Users/tester/Desktop/preset.darkslide',
      '{"darkslideVersion":"1.0.0"}',
    );
  });

  it('uses browser confirm when not in the desktop shell', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    await expect(confirmDeletePreset('Portra 400 Push')).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('Delete preset "Portra 400 Push"?');
  });

  it('uses the native desktop confirmation dialog when in Tauri', async () => {
    coreState.isTauri.mockReturnValue(true);
    dialogState.ask.mockResolvedValue(false);

    await expect(confirmDeletePreset('Portra 400 Push')).resolves.toBe(false);
    expect(dialogState.ask).toHaveBeenCalledWith('Delete preset "Portra 400 Push"?', expect.objectContaining({
      title: 'Delete Preset',
      kind: 'warning',
      okLabel: 'Delete',
      cancelLabel: 'Cancel',
    }));
  });
});
