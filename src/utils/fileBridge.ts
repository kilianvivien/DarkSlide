import { invoke, isTauri } from '@tauri-apps/api/core';
import { RAW_EXTENSIONS, SUPPORTED_EXTENSIONS } from '../constants';
import type { ExportFormat } from '../types';
import { getFileExtension } from './imagePipeline';
import { trackCreateObjectURL, trackRevokeObjectURL } from './blobUrlTracker';
import { isRawExtension } from './rawImport';

const SUPPORTED_DIALOG_EXTENSIONS = SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1));
const ALL_DIALOG_EXTENSIONS = [...SUPPORTED_DIALOG_EXTENSIONS, ...RAW_EXTENSIONS.map((extension) => extension.slice(1))];

const MIME_BY_EXTENSION: Record<typeof SUPPORTED_EXTENSIONS[number], string> = {
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const EXPORT_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }> = {
  'image/jpeg': { name: 'JPEG Image', extensions: ['jpg', 'jpeg'] },
  'image/png': { name: 'PNG Image', extensions: ['png'] },
  'image/webp': { name: 'WebP Image', extensions: ['webp'] },
};

const PRESET_FILTER = {
  name: 'DarkSlide Preset',
  extensions: ['darkslide'],
};

const BROWSER_DIRECTORY_PREFIX = '[browser-dir] ';

let selectedBrowserDirectoryHandle: FileSystemDirectoryHandle | null = null;

function getMimeTypeForFile(fileName: string) {
  const extension = getFileExtension(fileName) as typeof SUPPORTED_EXTENSIONS[number];
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() ?? 'darkslide-import';
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const url = trackCreateObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => trackRevokeObjectURL(url), 1000);
}

export function isDesktopShell() {
  return isTauri();
}

export function registerBeforeUnloadGuard(hasUnsavedChanges: () => boolean) {
  const handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!hasUnsavedChanges()) {
      return;
    }

    event.preventDefault();
    event.returnValue = '';
  };

  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
  };
}

export interface NativeOpenFileResult {
  file: File;
  path: string;
  size: number;
}

export interface OpenInExternalEditorResult {
  savedPath: string;
  destinationDirectory: string;
}

interface SaveBlobToDirectoryResult {
  savedPath: string;
}

async function openDesktopFile(path: string): Promise<NativeOpenFileResult> {
  const { readFile, stat } = await import('@tauri-apps/plugin-fs');
  const fileName = getFileName(path);
  const extension = getFileExtension(fileName);

  if (isRawExtension(extension)) {
    const metadata = await stat(path);
    return {
      file: new File([], fileName, { type: 'application/octet-stream' }),
      path,
      size: typeof metadata.size === 'number' ? metadata.size : 0,
    };
  }

  const bytes = await readFile(path);
  return {
    file: new File([bytes], fileName, { type: getMimeTypeForFile(fileName) }),
    path,
    size: bytes.byteLength,
  };
}

export async function openImageFile(): Promise<NativeOpenFileResult | null> {
  if (!isDesktopShell()) {
    return null;
  }

  const [{ open }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
  ]);

  const selected = await open({
    title: 'Open Scan',
    directory: false,
    multiple: false,
    filters: [
      {
        name: 'All Supported Images',
        extensions: isDesktopShell() ? ALL_DIALOG_EXTENSIONS : SUPPORTED_DIALOG_EXTENSIONS,
      },
    ],
  });

  if (!selected || Array.isArray(selected)) {
    return null;
  }

  return openDesktopFile(selected);
}

export async function openMultipleImageFiles(): Promise<NativeOpenFileResult[]> {
  if (!isDesktopShell()) {
    return [];
  }

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: 'Open Scans',
    directory: false,
    multiple: true,
    filters: [
      {
        name: 'All Supported Images',
        extensions: isDesktopShell() ? ALL_DIALOG_EXTENSIONS : SUPPORTED_DIALOG_EXTENSIONS,
      },
    ],
  });

  if (!selected || !Array.isArray(selected)) {
    return [];
  }

  return Promise.all(selected.map((path) => openDesktopFile(path)));
}

export async function openImageFileByPath(path: string): Promise<NativeOpenFileResult | null> {
  if (!isDesktopShell()) return null;

  // Use Rust commands directly instead of the FS plugin so that files
  // opened in a previous session (stored in recent files) remain accessible
  // even though the dialog-granted FS scope has expired.
  const fileName = getFileName(path);
  const extension = getFileExtension(fileName);

  if (isRawExtension(extension)) {
    const size = await invoke<number>('file_size_by_path', { path });
    return {
      file: new File([], fileName, { type: 'application/octet-stream' }),
      path,
      size,
    };
  }

  const bytes = await invoke<ArrayBuffer>('read_file_by_path', { path });
  return {
    file: new File([new Uint8Array(bytes)], fileName, { type: getMimeTypeForFile(fileName) }),
    path,
    size: bytes.byteLength,
  };
}

export async function saveExportBlob(blob: Blob, filename: string, format: ExportFormat) {
  if (isDesktopShell()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const selected = await save({
      title: 'Export Image',
      defaultPath: filename,
      filters: [EXPORT_FILTERS[format]],
    });

    if (!selected) {
      return 'cancelled' as const;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    await writeFile(selected, bytes);
    return 'saved' as const;
  }

  triggerBrowserDownload(blob, filename);
  return 'saved' as const;
}

export async function openDirectory(): Promise<string | null> {
  if (!isDesktopShell()) {
    const picker = (window as Window & {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;

    if (!picker) {
      return null;
    }

    const directory = await picker();
    selectedBrowserDirectoryHandle = directory;
    return `${BROWSER_DIRECTORY_PREFIX}${directory.name}`;
  }

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: 'Choose Output Folder',
    directory: true,
    multiple: false,
  });

  return typeof selected === 'string' ? selected : null;
}

export async function getDesktopDownloadsDirectory(): Promise<string | null> {
  if (!isDesktopShell()) {
    return null;
  }

  const { downloadDir } = await import('@tauri-apps/api/path');
  return downloadDir();
}

export async function saveToDirectory(blob: Blob, filename: string, dirPath: string): Promise<string> {
  if (isDesktopShell()) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await invoke<SaveBlobToDirectoryResult>('save_blob_to_directory', {
      bytes: Array.from(bytes),
      filename,
      destinationDirectory: dirPath,
    });
    return result.savedPath;
  }

  const picker = (window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  const directory = selectedBrowserDirectoryHandle
    ?? (picker ? await picker() : null);

  if (directory) {
    selectedBrowserDirectoryHandle = directory;
    const extensionIndex = filename.lastIndexOf('.');
    const baseName = extensionIndex >= 0 ? filename.slice(0, extensionIndex) : filename;
    const extension = extensionIndex >= 0 ? filename.slice(extensionIndex) : '';

    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const candidateName = attempt === 0 ? filename : `${baseName}-${attempt + 1}${extension}`;

      try {
        await directory.getFileHandle(candidateName);
        continue;
      } catch {
        const handle = await directory.getFileHandle(candidateName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return `${BROWSER_DIRECTORY_PREFIX}${directory.name}/${candidateName}`;
      }
    }

    throw new Error('Could not determine a unique filename for the batch export.');
  }

  triggerBrowserDownload(blob, filename);
  return filename;
}

export async function savePresetFile(json: string, filename: string): Promise<'saved' | 'cancelled'> {
  if (isDesktopShell()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const selected = await save({
      title: 'Export Preset',
      defaultPath: filename,
      filters: [PRESET_FILTER],
    });

    if (!selected) {
      return 'cancelled';
    }

    await writeTextFile(selected, json);
    return 'saved';
  }

  triggerBrowserDownload(new Blob([json], { type: 'application/json' }), filename);
  return 'saved';
}

export async function openPresetFile(): Promise<{ content: string; fileName: string } | null> {
  if (!isDesktopShell()) {
    return null;
  }

  const [{ open }, { readTextFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);

  const selected = await open({
    title: 'Import Preset',
    directory: false,
    multiple: false,
    filters: [PRESET_FILTER],
  });

  if (!selected || Array.isArray(selected)) {
    return null;
  }

  return {
    content: await readTextFile(selected),
    fileName: getFileName(selected),
  };
}

export async function openInExternalEditor(
  blob: Blob,
  filename: string,
  editorPath: string | null,
  outputDirectoryPath: string | null,
): Promise<OpenInExternalEditorResult> {
  if (!isDesktopShell()) {
    throw new Error('Open in Editor requires the desktop app.');
  }

  const destinationDirectory = outputDirectoryPath ?? await getDesktopDownloadsDirectory();
  if (!destinationDirectory) {
    throw new Error('Could not determine the desktop Downloads directory.');
  }
  let savedPath: string | null = null;

  try {
    savedPath = await saveToDirectory(blob, filename, destinationDirectory);
    await invoke('open_saved_file_in_editor', { path: savedPath, editorPath });
    return {
      savedPath,
      destinationDirectory,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const wrappedError = new Error(
      `Failed to save and open exported file${savedPath ? ` at ${savedPath}` : ''}${editorPath ? ` with editor ${editorPath}` : ''}: ${reason}`,
    );
    Object.assign(wrappedError, {
      savedPath,
      destinationDirectory,
      editorPath,
    });
    throw wrappedError;
  }
}

export async function chooseApplicationPath(): Promise<{ path: string; name: string } | null> {
  if (!isDesktopShell()) return null;

  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    title: 'Choose Application',
    directory: false,
    multiple: false,
    filters: [{ name: 'Applications', extensions: ['app'] }],
  });

  if (!selected || Array.isArray(selected)) return null;

  const name = selected.split('/').pop()?.replace(/\.app$/, '') ?? selected;
  return { path: selected, name };
}

export async function confirmDiscard(): Promise<boolean> {
  const message = 'Discard unsaved changes?';

  if (isDesktopShell()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, {
      title: 'DarkSlide',
      kind: 'warning',
      okLabel: 'OK',
      cancelLabel: 'Cancel',
    });
  }

  return window.confirm(message);
}

export async function confirmDeletePreset(name: string): Promise<boolean> {
  const message = `Delete preset "${name}"?`;

  if (isDesktopShell()) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return ask(message, {
      title: 'Delete Preset',
      kind: 'warning',
      okLabel: 'Delete',
      cancelLabel: 'Cancel',
    });
  }

  return window.confirm(message);
}
