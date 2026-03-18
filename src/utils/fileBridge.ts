import { isTauri } from '@tauri-apps/api/core';
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

function joinPath(directory: string, fileName: string) {
  if (directory.endsWith('/') || directory.endsWith('\\')) {
    return `${directory}${fileName}`;
  }

  return `${directory}${directory.includes('\\') ? '\\' : '/'}${fileName}`;
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

export interface NativeOpenFileResult {
  file: File;
  path: string;
  size: number;
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
        name: 'Supported Images',
        extensions: SUPPORTED_DIALOG_EXTENSIONS,
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
  return openDesktopFile(path);
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

export async function saveToDirectory(blob: Blob, filename: string, dirPath: string): Promise<void> {
  if (isDesktopShell()) {
    const { writeFile, stat } = await import('@tauri-apps/plugin-fs');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const extensionIndex = filename.lastIndexOf('.');
    const baseName = extensionIndex >= 0 ? filename.slice(0, extensionIndex) : filename;
    const extension = extensionIndex >= 0 ? filename.slice(extensionIndex) : '';

    let attempt = 0;
    while (attempt < 1000) {
      const candidateName = attempt === 0 ? filename : `${baseName}-${attempt + 1}${extension}`;
      const candidatePath = joinPath(dirPath, candidateName);

      try {
        await stat(candidatePath);
        attempt += 1;
      } catch {
        await writeFile(candidatePath, bytes);
        return;
      }
    }

    throw new Error('Could not determine a unique filename for the batch export.');
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
        return;
      }
    }

    throw new Error('Could not determine a unique filename for the batch export.');
  }

  triggerBrowserDownload(blob, filename);
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
