import { BatchProgressEvent, ColorManagementSettings, ColorProfileId, ConversionSettings, ExportOptions, FilmProfile, SourceMetadata } from '../types';
import { ImageWorkerClient } from './imageWorkerClient';
import { getExtensionFromFormat, getFileExtension, sanitizeFilenameBase } from './imagePipeline';
import { decodeDesktopRawForWorker, isRawExtension } from './rawImport';
import { isDesktopShell, saveExportBlob, saveToDirectory } from './fileBridge';

export interface BatchJobEntry {
  id: string;
  kind: 'open-tab' | 'file';
  file?: File;
  nativePath?: string;
  documentId?: string;
  sourceMetadata?: SourceMetadata;
  filename: string;
  size: number;
  status: 'pending' | 'processing' | 'done' | 'error';
  errorMessage?: string;
  progress?: number;
}

function applyNamingTemplate(filename: string, template: string, sequence: number, format: ExportOptions['format']) {
  const originalBase = filename.replace(/\.[^.]+$/, '');
  const renderedBase = sanitizeFilenameBase(
    template
      .replaceAll('{original}', originalBase)
      .replaceAll('{n}', String(sequence)),
  );

  return `${renderedBase}.${getExtensionFromFormat(format)}`;
}

async function saveBatchExport(blob: Blob, filename: string, format: ExportOptions['format'], outputPath: string | null) {
  if (outputPath) {
    await saveToDirectory(blob, filename, outputPath);
    return 'saved' as const;
  }

  return saveExportBlob(blob, filename, format);
}

function resolveBatchInputProfileId(sourceMetadata: SourceMetadata | undefined, colorManagement: ColorManagementSettings): ColorProfileId {
  if (colorManagement.inputMode === 'override') {
    return colorManagement.inputProfileId;
  }

  return sourceMetadata?.decoderColorProfileId ?? sourceMetadata?.embeddedColorProfileId ?? 'srgb';
}

export async function* runBatch(
  workerClient: ImageWorkerClient,
  entries: BatchJobEntry[],
  sharedSettings: ConversionSettings,
  sharedProfile: FilmProfile,
  sharedColorManagement: ColorManagementSettings,
  exportOptions: ExportOptions,
  outputPath: string | null,
  cancelToken: { cancelled: boolean },
): AsyncGenerator<BatchProgressEvent> {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (cancelToken.cancelled) {
      break;
    }

    yield { type: 'start', entryId: entry.id };
    yield { type: 'progress', entryId: entry.id, progress: 0.1 };

    try {
      const documentId = entry.kind === 'open-tab' ? (entry.documentId ?? entry.id) : entry.id;
      let sourceMetadata = entry.sourceMetadata;

      if (entry.kind === 'file') {
        const extension = getFileExtension(entry.filename);
        const isRaw = isRawExtension(extension);

        if (isRaw) {
          if (!isDesktopShell() || !entry.nativePath) {
            throw new Error(`RAW files require the desktop app. Missing native path for "${entry.filename}".`);
          }

          const { decodeRequest } = await decodeDesktopRawForWorker({
            documentId,
            fileName: entry.filename,
            path: entry.nativePath,
            size: entry.size,
          });
          yield { type: 'progress', entryId: entry.id, progress: 0.25 };

          const decoded = await workerClient.decode(decodeRequest);
          sourceMetadata = decoded.metadata;
        } else {
          if (!entry.file) {
            throw new Error(`Missing file for batch entry "${entry.filename}".`);
          }

          const buffer = await entry.file.arrayBuffer();
          yield { type: 'progress', entryId: entry.id, progress: 0.25 };

          const decoded = await workerClient.decode({
            documentId,
            buffer,
            fileName: entry.filename,
            mime: entry.file.type || 'application/octet-stream',
            size: entry.file.size,
          });
          sourceMetadata = decoded.metadata;
        }
      } else {
        yield { type: 'progress', entryId: entry.id, progress: 0.35 };
      }

      yield { type: 'progress', entryId: entry.id, progress: 0.55 };

      const result = await workerClient.export({
        documentId,
        settings: sharedSettings,
        isColor: sharedProfile.type === 'color' && !sharedSettings.blackAndWhite.enabled,
        inputProfileId: resolveBatchInputProfileId(sourceMetadata, sharedColorManagement),
        outputProfileId: exportOptions.outputProfileId,
        options: exportOptions,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
      });
      yield { type: 'progress', entryId: entry.id, progress: 0.85 };

      const outputFilename = applyNamingTemplate(entry.filename, exportOptions.filenameBase, index + 1, exportOptions.format);
      await saveBatchExport(result.blob, outputFilename, exportOptions.format, outputPath);
      yield { type: 'done', entryId: entry.id };
    } catch (error) {
      yield {
        type: 'error',
        entryId: entry.id,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (entry.kind === 'file') {
        try {
          await workerClient.disposeDocument(entry.id);
        } catch {
          // Ignore cleanup races.
        }
      }
    }
  }

  yield { type: 'complete' };
}
