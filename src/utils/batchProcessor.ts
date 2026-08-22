import { BatchProgressEvent, ColorManagementSettings, ColorProfileId, ConversionSettings, DensityBalance, ExportOptions, FilmBaseEstimate, FilmBaseSample, FilmProfile, HistogramData, InputProfileSpec, LabStyleProfile, SourceMetadata } from '../types';
import { ImageWorkerClient, isImageExportCancelledError } from './imageWorkerClient';
import { computeHighlightDensity, getExtensionFromFormat, getFileExtension, sanitizeFilenameBase } from './imagePipeline';
import { usesColorChannelPipeline } from './pipelineIntent';
import { decodeDesktopRawForWorker, isRawExtension } from './rawImport';
import { isDesktopShell, openImageFileByPath, saveExportBlob, saveToDirectory } from './fileBridge';
import type { AutoAnalyzeResult } from '../types';
import { getAutoFrameCrop } from './frameDetection';
import { createAutoAdjustmentPatch, createAutoAnalysisSettings } from './autoAnalysis';

export interface BatchJobEntry {
  id: string;
  kind: 'open-tab' | 'file';
  file?: File;
  nativePath?: string;
  documentId?: string;
  sequence?: number;
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
  estimatedFilmBaseSample?: FilmBaseSample | null;
  estimatedFilmBase?: FilmBaseEstimate | null;
  estimatedDensityBalance?: DensityBalance | null;
  geometry?: Pick<ConversionSettings, 'rotation' | 'levelAngle' | 'crop'>;
}

export interface BatchRunOptions {
  autoCrop?: boolean;
  autoDustRemoval?: boolean;
  flareMode?: 'per-image' | 'first-frame';
  autoMode?: 'off' | 'per-image' | 'first-frame';
}

const ANALYSIS_TARGET_DIMENSION = 1024;
const HIGHLIGHT_DENSITY_FOLLOW_UP_THRESHOLD = 0.01;

class BatchCancelledError extends Error {
  constructor() {
    super('The batch export was cancelled.');
    this.name = 'BatchCancelledError';
  }
}

function throwIfBatchCancelled(cancelToken: { cancelled: boolean }) {
  if (cancelToken.cancelled) throw new BatchCancelledError();
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

function resolveBatchInputProfileId(sourceMetadata: SourceMetadata | undefined, colorManagement: ColorManagementSettings): InputProfileSpec {
  if (colorManagement.inputMode === 'override') {
    return colorManagement.inputProfileId;
  }

  return sourceMetadata?.decoderColorProfileId ?? sourceMetadata?.embeddedColorProfileId ?? sourceMetadata?.embeddedParsedProfile ?? 'srgb';
}

async function analyzeBatchHighlightDensity(
  workerClient: ImageWorkerClient,
  params: {
    documentId: string;
    settings: ConversionSettings;
    isColor: boolean;
    profileId: string;
    filmType: FilmProfile['filmType'];
    estimatedDensityBalance: DensityBalance | null;
    inputProfileId: InputProfileSpec;
    outputProfileId: ColorProfileId;
    maskTuning: FilmProfile['maskTuning'];
    colorMatrix: FilmProfile['colorMatrix'];
    tonalCharacter: FilmProfile['tonalCharacter'];
    cubeLut: FilmProfile['lut'];
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
      profileId: params.profileId,
      filmType: params.filmType,
      estimatedDensityBalance: params.estimatedDensityBalance,
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
      cubeLut: params.cubeLut ?? null,
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
          if (entry.estimatedFilmBase !== undefined) {
            decodeRequest.precomputedFilmBase = entry.estimatedFilmBase
              ? structuredClone(entry.estimatedFilmBase)
              : null;
          }
          if (entry.estimatedFilmBaseSample !== undefined) {
            decodeRequest.precomputedFilmBaseSample = entry.estimatedFilmBaseSample
              ? structuredClone(entry.estimatedFilmBaseSample)
              : null;
          }
          if (entry.estimatedDensityBalance !== undefined) {
            decodeRequest.precomputedDensityBalance = entry.estimatedDensityBalance
              ? structuredClone(entry.estimatedDensityBalance)
              : null;
          }
          yield { type: 'progress', entryId: entry.id, progress: 0.25 };

          const decoded = await workerClient.decode(decodeRequest);
          throwIfBatchCancelled(cancelToken);
          sourceMetadata = decoded.metadata;
          if (entry.estimatedFlare === undefined) {
            entry.estimatedFlare = decoded.estimatedFlare ?? null;
          }
          entry.estimatedFilmBaseSample = decoded.estimatedFilmBaseSample ?? null;
          entry.estimatedFilmBase = decoded.estimatedFilmBase ?? null;
          entry.estimatedDensityBalance = decoded.estimatedDensityBalance ?? null;
        } else {
          const sourceFile = entry.file ?? (entry.nativePath
            ? (await openImageFileByPath(entry.nativePath))?.file
            : undefined);
          if (!sourceFile) {
            throw new Error(`Missing file for batch entry "${entry.filename}".`);
          }

          const buffer = await sourceFile.arrayBuffer();
          yield { type: 'progress', entryId: entry.id, progress: 0.25 };

          const decoded = await workerClient.decode({
            documentId,
            buffer,
            fileName: entry.filename,
            mime: sourceFile.type || 'application/octet-stream',
            size: sourceFile.size,
          });
          throwIfBatchCancelled(cancelToken);
          sourceMetadata = decoded.metadata;
          if (entry.estimatedFlare === undefined) {
            entry.estimatedFlare = decoded.estimatedFlare ?? null;
          }
        }
      } else {
        yield { type: 'progress', entryId: entry.id, progress: 0.35 };
      }

      if (options.autoCrop !== false) {
        entry.detectedFrame = typeof workerClient.detectFrame === 'function'
          ? await workerClient.detectFrame(documentId, sharedSettings).catch(() => null)
          : null;
      }
      throwIfBatchCancelled(cancelToken);

      if (entry.estimatedFlare === undefined) {
        entry.estimatedFlare = typeof workerClient.computeFlare === 'function'
          ? await workerClient.computeFlare(documentId).catch(() => null)
          : null;
      }
      throwIfBatchCancelled(cancelToken);

      yield { type: 'progress', entryId: entry.id, progress: 0.55 };

      const entrySettings = structuredClone(sharedSettings);
      if (entry.geometry) {
        entrySettings.rotation = entry.geometry.rotation;
        entrySettings.levelAngle = entry.geometry.levelAngle;
        entrySettings.crop = structuredClone(entry.geometry.crop);
      }
      if (entrySettings.dustRemoval) {
        entrySettings.dustRemoval = {
          ...entrySettings.dustRemoval,
          autoEnabled: options.autoDustRemoval ?? entrySettings.dustRemoval.autoEnabled,
          marks: [],
        };
      }
      if (entry.detectedFrame && options.autoCrop !== false) {
        entrySettings.crop = getAutoFrameCrop(entry.detectedFrame, entrySettings.rotation);
      }

      if ((options.autoDustRemoval ?? entrySettings.dustRemoval?.autoEnabled) && entrySettings.dustRemoval?.autoEnabled) {
        const autoDustMarks = await workerClient.detectDust({
          documentId,
          settings: entrySettings,
          isColor: usesColorChannelPipeline(sharedProfile),
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
      throwIfBatchCancelled(cancelToken);

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
        isColor: usesColorChannelPipeline(sharedProfile),
        profileId: sharedProfile.id,
        filmType: sharedProfile.filmType,
        estimatedDensityBalance: entry.estimatedDensityBalance ?? null,
        inputProfileId,
        outputProfileId: exportOptions.outputProfileId,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
        cubeLut: sharedProfile.lut ?? null,
        labStyleToneCurve: sharedLabStyle?.toneCurve,
        labStyleChannelCurves: sharedLabStyle?.channelCurves,
        labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
        labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
        labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
        flareFloor,
        lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
        initialEstimate: entry.histogram ? computeHighlightDensity(entry.histogram) : undefined,
      });
      throwIfBatchCancelled(cancelToken);
      entry.histogram = baseHighlightAnalysis.histogram ?? entry.histogram ?? null;
      let highlightDensityEstimate = baseHighlightAnalysis.highlightDensityEstimate;

      if ((options.autoMode ?? 'off') !== 'off') {
        const autoResult: Awaited<ReturnType<typeof workerClient.autoAnalyze>> = (options.autoMode === 'first-frame' && rollAutoAnalysis)
          ? rollAutoAnalysis
          : await workerClient.autoAnalyze({
            documentId,
            settings: createAutoAnalysisSettings(entrySettings, sharedProfile.defaultSettings),
            isColor: usesColorChannelPipeline(sharedProfile),
            profileId: sharedProfile.id,
            filmType: sharedProfile.filmType,
            inputProfileId,
            outputProfileId: exportOptions.outputProfileId,
            targetMaxDimension: 1024,
            maskTuning: sharedProfile.maskTuning,
            colorMatrix: sharedProfile.colorMatrix,
            tonalCharacter: sharedProfile.tonalCharacter,
            cubeLut: sharedProfile.lut ?? null,
            labStyleToneCurve: sharedLabStyle?.toneCurve,
            labStyleChannelCurves: sharedLabStyle?.channelCurves,
            labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
            labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
            labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
            highlightDensityEstimate,
            flareFloor,
            lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
          });
        throwIfBatchCancelled(cancelToken);

        if (options.autoMode === 'first-frame' && !rollAutoAnalysis) {
          rollAutoAnalysis = autoResult;
        }

        Object.assign(entrySettings, createAutoAdjustmentPatch(sharedProfile.defaultSettings, autoResult));

        const postAutoHighlightAnalysis = await analyzeBatchHighlightDensity(workerClient, {
          documentId,
          settings: entrySettings,
          isColor: usesColorChannelPipeline(sharedProfile),
          profileId: sharedProfile.id,
          filmType: sharedProfile.filmType,
          estimatedDensityBalance: entry.estimatedDensityBalance ?? null,
          inputProfileId,
          outputProfileId: exportOptions.outputProfileId,
          maskTuning: sharedProfile.maskTuning,
          colorMatrix: sharedProfile.colorMatrix,
          tonalCharacter: sharedProfile.tonalCharacter,
          cubeLut: sharedProfile.lut ?? null,
          labStyleToneCurve: sharedLabStyle?.toneCurve,
          labStyleChannelCurves: sharedLabStyle?.channelCurves,
          labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
          labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
          labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
          flareFloor,
          lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
          initialEstimate: highlightDensityEstimate,
        });
        throwIfBatchCancelled(cancelToken);
        entry.histogram = postAutoHighlightAnalysis.histogram ?? entry.histogram ?? null;
        highlightDensityEstimate = postAutoHighlightAnalysis.highlightDensityEstimate;
      }

      const result = await workerClient.export({
        documentId,
        settings: entrySettings,
        isColor: usesColorChannelPipeline(sharedProfile),
        profileId: sharedProfile.id,
        filmType: sharedProfile.filmType,
        estimatedDensityBalance: entry.estimatedDensityBalance ?? null,
        inputProfileId,
        outputProfileId: exportOptions.outputProfileId,
        options: exportOptions,
        flareFloor,
        maskTuning: sharedProfile.maskTuning,
        colorMatrix: sharedProfile.colorMatrix,
        tonalCharacter: sharedProfile.tonalCharacter,
        cubeLut: sharedProfile.lut ?? null,
        labStyleToneCurve: sharedLabStyle?.toneCurve,
        labStyleChannelCurves: sharedLabStyle?.channelCurves,
        labTonalCharacterOverride: sharedLabStyle?.tonalCharacterOverride,
        labSaturationBias: sharedLabStyle?.saturationBias ?? 0,
        labTemperatureBias: sharedLabStyle?.temperatureBias ?? 0,
        highlightDensityEstimate,
        lightSourceBias: sharedLightSourceBias ?? [1, 1, 1],
      });
      throwIfBatchCancelled(cancelToken);
      yield { type: 'progress', entryId: entry.id, progress: 0.85 };

      const outputFilename = applyNamingTemplate(
        entry.filename,
        exportOptions.filenameBase,
        entry.sequence ?? index + 1,
        exportOptions.format,
      );
      throwIfBatchCancelled(cancelToken);
      await saveBatchExport(result.blob, outputFilename, exportOptions.format, outputPath);
      await workerClient.evictPreviews(documentId).catch(() => {
        // Ignore cache eviction failures after a successful export.
      });
      yield { type: 'done', entryId: entry.id };
    } catch (error) {
      if (cancelToken.cancelled && (error instanceof BatchCancelledError || isImageExportCancelledError(error))) {
        break;
      }
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

async function* mergeBatchStreams(streams: AsyncGenerator<BatchProgressEvent>[]) {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<{ index: number; result: IteratorResult<BatchProgressEvent> }>>();
  const schedule = (index: number) => {
    pending.set(index, iterators[index].next().then((result) => ({ index, result })));
  };

  iterators.forEach((_, index) => schedule(index));
  while (pending.size > 0) {
    const { index, result } = await Promise.race(pending.values());
    if (result.done) {
      pending.delete(index);
      continue;
    }

    if (result.value.type !== 'complete') {
      yield result.value;
    }
    schedule(index);
  }
}

/**
 * Runs independent entries across dedicated clients. Modes that copy analysis
 * from the first frame stay serial because later entries depend on that result.
 */
export async function* runBatchConcurrent(
  workerClients: ImageWorkerClient[],
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
  const requiresFirstFrame = options.flareMode === 'first-frame' || options.autoMode === 'first-frame';
  const clients = requiresFirstFrame ? workerClients.slice(0, 1) : workerClients;
  if (clients.length === 0) {
    throw new Error('Batch export needs at least one image worker.');
  }
  if (clients.length === 1) {
    yield* runBatch(
      clients[0],
      entries,
      sharedSettings,
      sharedProfile,
      sharedLabStyle,
      sharedColorManagement,
      sharedLightSourceBias,
      exportOptions,
      outputPath,
      cancelToken,
      options,
    );
    return;
  }

  let nextEntryIndex = 0;
  const createWorkerStream = async function* (workerClient: ImageWorkerClient) {
    while (!cancelToken.cancelled) {
      const entryIndex = nextEntryIndex;
      nextEntryIndex += 1;
      if (entryIndex >= entries.length) break;
      const entry = entries[entryIndex];
      entry.sequence = entryIndex + 1;
      yield* runBatch(
        workerClient,
        [entry],
        sharedSettings,
        sharedProfile,
        sharedLabStyle,
        sharedColorManagement,
        sharedLightSourceBias,
        exportOptions,
        outputPath,
        cancelToken,
        options,
      );
    }
  };

  yield* mergeBatchStreams(clients.map((client) => createWorkerStream(client)));
  yield { type: 'complete' };
}
