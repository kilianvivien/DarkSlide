import { BatchProgressEvent, ColorManagementSettings, ColorProfileId, ConversionSettings, ExportOptions, FilmProfile, HistogramData, LabStyleProfile, SourceMetadata } from '../types';
import { ImageWorkerClient } from './imageWorkerClient';
import { computeHighlightDensity, getExtensionFromFormat, getFileExtension, sanitizeFilenameBase } from './imagePipeline';
import { decodeDesktopRawForWorker, isRawExtension } from './rawImport';
import { isDesktopShell, saveExportBlob, saveToDirectory } from './fileBridge';
import type { AutoAnalyzeResult } from '../types';

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
  histogram?: HistogramData | null;
  detectedFrame?: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    angle: number;
    confidence: number;
  } | null;
  estimatedFlare?: [number, number, number] | null;
}

export interface BatchRunOptions {
  autoCrop?: boolean;
  autoDustRemoval?: boolean;
  flareMode?: 'per-image' | 'first-frame';
  autoMode?: 'off' | 'per-image' | 'first-frame';
}

const ANALYSIS_TARGET_DIMENSION = 1024;
const HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD = 0.01;

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

async function analyzeBatchHighlightDensity(
  workerClient: ImageWorkerClient,
  params: {
    documentId: string;
    settings: ConversionSettings;
    isColor: boolean;
    filmType: FilmProfile['filmType'];
    inputProfileId: ColorProfileId;
    outputProfileId: ColorProfileId;
    maskTuning: FilmProfile['maskTuning'];
    colorMatrix: FilmProfile['colorMatrix'];
    tonalCharacter: FilmProfile['tonalCharacter'];
    labStyleToneCurve: LabStyleProfile['toneCurve'] | undefined;
    labStyleChannelCurves: LabStyleProfile['channelCurves'] | undefined;
    labTonalCharacterOverride: LabStyleProfile['tonalCharacterOverride'] | undefined;
    labSaturationBias: number;
    labTemperatureBias: number;
    flareFloor: [number, number, number] | null;
    lightSourceBias: [number, number, number];
    initialEstimate?: number;
  },
) {
  if (typeof workerClient.render !== 'function') {
    return {
      histogram: null,
      highlightDensityEstimate: params.initialEstimate ?? 0,
    };
  }

  let highlightDensityEstimate = params.initialEstimate;
  let histogram: HistogramData | null = null;

  for (let pass = 0; pass < 2; pass += 1) {
    const result = await workerClient.render({
      documentId: params.documentId,
      settings: params.settings,
      isColor: params.isColor,
      filmType: params.filmType,
      inputProfileId: params.inputProfileId,
      outputProfileId: params.outputProfileId,
      revision: pass + 1,
      targetMaxDimension: ANALYSIS_TARGET_DIMENSION,
      comparisonMode: 'processed',
      previewMode: 'settled',
      interactionQuality: null,
      histogramMode: 'full',
      maskTuning: params.maskTuning,
      colorMatrix: params.colorMatrix,
      tonalCharacter: params.tonalCharacter,
      labStyleToneCurve: params.labStyleToneCurve,
      labStyleChannelCurves: params.labStyleChannelCurves,
      labTonalCharacterOverride: params.labTonalCharacterOverride,
      labSaturationBias: params.labSaturationBias,
      labTemperatureBias: params.labTemperatureBias,
      highlightDensityEstimate,
      flareFloor: params.flareFloor,
      lightSourceBias: params.lightSourceBias,
    });

    histogram = result.histogram;
    const nextEstimate = result.highlightDensity;
    if (
      highlightDensityEstimate !== undefined
      && Math.abs(nextEstimate - highlightDensityEstimate) <= HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD
    ) {
      highlightDensityEstimate = nextEstimate;
      break;
    }

    highlightDensityEstimate = nextEstimate;
  }

  return {
    histogram,
    highlightDensityEstimate: highlightDensityEstimate ?? 0,
  };
}

export async function* runBatch(
  workerClient: ImageWorkerClient,
  entries: BatchJobEntry[],
  sharedSettings: ConversionSettings,
  sharedProfile: FilmProfile,
  sharedLabStyle: LabStyleProfile | null,
  sharedColorManagement: ColorManagementSettings,
  sharedLightSourceBias: [number, number, number] | null,
  exportOptions: ExportOptions,
  outputPath: string | null,
  cancelToken: { cancelled: boolean },
  options: BatchRunOptions = {},
): AsyncGenerator<BatchProgressEvent> {
  let rollFlare: [number, number, number] | null = null;
  let rollAutoAnalysis: AutoAnalyzeResult | null = null;

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
          entry.estimatedFlare = decoded.estimatedFlare;
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
          entry.estimatedFlare = decoded.estimatedFlare;
        }
      } else {
        yield { type: 'progress', entryId: entry.id, progress: 0.35 };
      }

      if (options.autoCrop !== false) {
        entry.detectedFrame = typeof workerClient.detectFrame === 'function'
          ? await workerClient.detectFrame(documentId).catch(() => null)
          : null;
      }

      if (!entry.estimatedFlare) {
        entry.estimatedFlare = typeof workerClient.computeFlare === 'function'
          ? await workerClient.computeFlare(documentId).catch(() => null)
          : null;
      }

      yield { type: 'progress', entryId: entry.id, progress: 0.55 };

      const entrySettings = structuredClone(sharedSettings);
      if (entrySettings.dustRemoval) {
        entrySettings.dustRemoval = {
          ...entrySettings.dustRemoval,
          autoEnabled: options.autoDustRemoval ?? entrySettings.dustRemoval.autoEnabled,
          marks: [],
        };
      }
      if (entry.detectedFrame && options.autoCrop !== false) {
        entrySettings.crop = {
          x: entry.detectedFrame.left,
          y: entry.detectedFrame.top,
          width: entry.detectedFrame.right - entry.detectedFrame.left,
          height: entry.detectedFrame.bottom - entry.detectedFrame.top,
          aspectRatio: null,
        };
        entrySettings.levelAngle = entry.detectedFrame.angle;
      }

      if ((options.autoDustRemoval ?? entrySettings.dustRemoval?.autoEnabled) && entrySettings.dustRemoval?.autoEnabled) {
        const autoDustMarks = await workerClient.detectDust({
          documentId,
          settings: entrySettings,
          isColor: sharedProfile.type === 'color' && !entrySettings.blackAndWhite.enabled,
          profileId: sharedProfile.id,
          filmType: sharedProfile.filmType,
          flareFloor: entry.estimatedFlare ?? null,
          lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
          sensitivity: entrySettings.dustRemoval.autoSensitivity,
          maxRadius: entrySettings.dustRemoval.autoMaxRadius,
          mode: entrySettings.dustRemoval.autoDetectMode,
        }).catch(() => []);
        entrySettings.dustRemoval = {
          ...entrySettings.dustRemoval,
          marks: autoDustMarks,
        };
      }

      const flareFloor: [number, number, number] | null = options.flareMode === 'first-frame'
        ? (rollFlare ?? entry.estimatedFlare ?? null)
        : (entry.estimatedFlare ?? null);
      if (options.flareMode === 'first-frame' && !rollFlare && flareFloor) {
        rollFlare = flareFloor;
      }

      const inputProfileId = resolveBatchInputProfileId(sourceMetadata, sharedColorManagement);
      const baseHighlightAnalysis = await analyzeBatchHighlightDensity(workerClient, {
        documentId,
        settings: entrySettings,
        isColor: sharedProfile.type === 'color' && !entrySettings.blackAndWhite.enabled,
        filmType: sharedProfile.filmType,
        inputProfileId,
        outputProfileId: exportOptions.outputProfileId,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
        labStyleToneCurve: sharedLabStyle?.toneCurve,
        labStyleChannelCurves: sharedLabStyle?.channelCurves,
        labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
        labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
        labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
        flareFloor,
        lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
        initialEstimate: entry.histogram ? computeHighlightDensity(entry.histogram) : undefined,
      });
      entry.histogram = baseHighlightAnalysis.histogram ?? entry.histogram ?? null;
      let highlightDensityEstimate = baseHighlightAnalysis.highlightDensityEstimate;

      if ((options.autoMode ?? 'off') !== 'off') {
        const autoResult: Awaited<ReturnType<typeof workerClient.autoAnalyze>> = (options.autoMode === 'first-frame' && rollAutoAnalysis)
          ? rollAutoAnalysis
          : await workerClient.autoAnalyze({
            documentId,
            settings: entrySettings,
            isColor: sharedProfile.type === 'color' && !entrySettings.blackAndWhite.enabled,
            filmType: sharedProfile.filmType,
            inputProfileId,
            outputProfileId: exportOptions.outputProfileId,
            targetMaxDimension: 1024,
            maskTuning: sharedProfile.maskTuning,
            colorMatrix: sharedProfile.colorMatrix,
            tonalCharacter: sharedProfile.tonalCharacter,
            labStyleToneCurve: sharedLabStyle?.toneCurve,
            labStyleChannelCurves: sharedLabStyle?.channelCurves,
            labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
            labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
            labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
            highlightDensityEstimate,
            flareFloor,
            lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
          });

        if (options.autoMode === 'first-frame' && !rollAutoAnalysis) {
          rollAutoAnalysis = autoResult;
        }

        entrySettings.exposure = autoResult.exposure;
        entrySettings.blackPoint = autoResult.blackPoint;
        entrySettings.whitePoint = autoResult.whitePoint;
        if (autoResult.temperature !== null && autoResult.tint !== null) {
          entrySettings.temperature = autoResult.temperature;
          entrySettings.tint = autoResult.tint;
        }

        const postAutoHighlightAnalysis = await analyzeBatchHighlightDensity(workerClient, {
          documentId,
          settings: entrySettings,
          isColor: sharedProfile.type === 'color' && !entrySettings.blackAndWhite.enabled,
          filmType: sharedProfile.filmType,
          inputProfileId,
          outputProfileId: exportOptions.outputProfileId,
          maskTuning: sharedProfile.maskTuning,
          colorMatrix: sharedProfile.colorMatrix,
          tonalCharacter: sharedProfile.tonalCharacter,
          labStyleToneCurve: sharedLabStyle?.toneCurve,
          labStyleChannelCurves: sharedLabStyle?.channelCurves,
          labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
          labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
          labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
          flareFloor,
          lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
          initialEstimate: highlightDensityEstimate,
        });
        entry.histogram = postAutoHighlightAnalysis.histogram ?? entry.histogram ?? null;
        highlightDensityEstimate = postAutoHighlightAnalysis.highlightDensityEstimate;
      }

      const result = await workerClient.export({
        documentId,
        settings: entrySettings,
        isColor: sharedProfile.type === 'color' && !sharedSettings.blackAndWhite.enabled,
        filmType: sharedProfile.filmType,
        inputProfileId,
        outputProfileId: exportOptions.outputProfileId,
        options: exportOptions,
        flareFloor,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
        labStyleToneCurve: sharedLabStyle?.toneCurve,
        labStyleChannelCurves: sharedLabStyle?.channelCurves,
        labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
        labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
        labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
        highlightDensityEstimate,
        lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
      });
      yield { type: 'progress', entryId: entry.id, progress: 0.85 };

      const outputFilename = applyNamingTemplate(entry.filename, exportOptions.filenameBase, index + 1, exportOptions.format);
      await saveBatchExport(result.blob, outputFilename, exportOptions.format, outputPath);
      await workerClient.evictPreviews(documentId).catch(() => {
        // Ignore cache eviction failures after a successful export.
      });
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
