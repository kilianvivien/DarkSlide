import { BatchProgressEvent, ConversionSettings, ExportOptions, FilmProfile } from '../types';
import { ImageWorkerClient } from './imageWorkerClient';
import { getExtensionFromFormat, sanitizeFilenameBase } from './imagePipeline';
import { saveExportBlob, saveToDirectory } from './fileBridge';

export interface BatchJobEntry {
  id: string;
  kind: 'open-tab' | 'file';
  file?: File;
  documentId?: string;
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

export async function* runBatch(
  workerClient: ImageWorkerClient,
  entries: BatchJobEntry[],
  sharedSettings: ConversionSettings,
  sharedProfile: FilmProfile,
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

      if (entry.kind === 'file') {
        if (!entry.file) {
          throw new Error(`Missing file for batch entry "${entry.filename}".`);
        }

        const buffer = await entry.file.arrayBuffer();
        yield { type: 'progress', entryId: entry.id, progress: 0.25 };

        await workerClient.decode({
          documentId,
          buffer,
          fileName: entry.filename,
          mime: entry.file.type || 'application/octet-stream',
          size: entry.file.size,
        });
      } else {
        yield { type: 'progress', entryId: entry.id, progress: 0.35 };
      }

      yield { type: 'progress', entryId: entry.id, progress: 0.55 };

      const result = await workerClient.export({
        documentId,
        settings: sharedSettings,
        isColor: sharedProfile.type === 'color' && !sharedSettings.blackAndWhite.enabled,
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
