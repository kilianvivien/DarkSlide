import { isTauri } from '@tauri-apps/api/core';
import { RAW_EXTENSIONS, SUPPORTED_EXTENSIONS } from '../constants';
import type { ExportFormat } from '../types';
import { getFileExtension } from './imagePipeline';
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

function getMimeTypeForFile(fileName: string) {
  const extension = getFileExtension(fileName) as typeof SUPPORTED_EXTENSIONS[number];
  return MIME_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() ?? 'darkslide-import';
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

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'saved' as const;
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

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
