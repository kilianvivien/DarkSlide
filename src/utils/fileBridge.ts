import { isTauri } from '@tauri-apps/api/core';
import { SUPPORTED_EXTENSIONS } from '../constants';
import type { ExportFormat } from '../types';
import { getFileExtension } from './imagePipeline';

const SUPPORTED_DIALOG_EXTENSIONS = SUPPORTED_EXTENSIONS.map((extension) => extension.slice(1));

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

export async function openImageFile() {
  if (!isDesktopShell()) {
    return null;
  }

  const [{ open }, { readFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);

  const selected = await open({
    title: 'Open Scan',
    directory: false,
    multiple: false,
    filters: [
      {
        name: 'Supported scans',
        extensions: SUPPORTED_DIALOG_EXTENSIONS,
      },
    ],
  });

  if (!selected || Array.isArray(selected)) {
    return null;
  }

  const fileName = getFileName(selected);
  const bytes = await readFile(selected);
  return { file: new File([bytes], fileName, { type: getMimeTypeForFile(fileName) }), path: selected };
}

export async function openImageFileByPath(path: string): Promise<File | null> {
  if (!isDesktopShell()) return null;
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const fileName = getFileName(path);
  const bytes = await readFile(path);
  return new File([bytes], fileName, { type: getMimeTypeForFile(fileName) });
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
