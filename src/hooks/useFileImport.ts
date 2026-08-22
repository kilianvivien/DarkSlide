import { MutableRefObject, useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ColorManagementSettings,
  ConversionSettings,
  DecodedImage,
  DensityBalance,
  DocumentTab,
  FilmProfile,
  Roll,
  WorkspaceDocument,
} from '../types';
import {
  createDefaultSettings,
  DEFAULT_COLOR_MANAGEMENT,
  DEFAULT_EXPORT_OPTIONS,
  FILM_STOCK_DENSITY_PRESETS,
  FILM_PROFILES,
  LIGHT_SOURCE_PROFILES,
  MAX_FILE_SIZE_BYTES,
  RAW_EDITOR_PREVIEW_MAX_DIMENSION,
  resolveLightSourceIdForProfile,
} from '../constants';
import { createAutoAdjustmentPatch, createAutoAnalysisSettings } from '../utils/autoAnalysis';
import { appendDiagnostic } from '../utils/diagnostics';
import { pushToast } from '../utils/toastStore';
import { addRecentFile } from '../utils/recentFilesStore';
import { getFileExtension, sanitizeFilenameBase } from '../utils/imagePipeline';
import { AUTO_APPLY_NONE_PRESET_ID, loadPreferences } from '../utils/preferenceStore';
import { confirmRestoreSidecar, isDesktopShell, readTextFileByPath } from '../utils/fileBridge';
import {
  buildRawInitialSettings,
  createRawImportProfile,
  decodeDesktopRawForWorker,
  rotationFromExifOrientation,
} from '../utils/rawImport';
import { shouldUseDirectRawFilmBase, usesColorChannelPipeline } from '../utils/pipelineIntent';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { getSidecarCandidatePaths, parseSidecar } from '../utils/sidecarSettings';
import { getResolvedInputProfileId, waitForNextPaint } from '../utils/appHelpers';

type BlockingOverlayState = {
  title: string;
  detail: string;
} | null;

type TransientNoticeState = {
  message: string;
  tone?: 'info' | 'warning' | 'success';
} | null;

type TabsApi = {
  openDocument: (document: WorkspaceDocument, options?: { activate?: boolean }) => void;
  replaceDocument: (documentId: string, document: WorkspaceDocument) => void;
  activateDocument: (documentId: string) => void;
  findDocumentBySourcePath: (nativePath: string) => DocumentTab | null;
  hasDocument: (documentId: string) => boolean;
  removeDocument: (documentId: string) => {
    removedTab: DocumentTab | null;
    remainingTabs: DocumentTab[];
    nextActiveTabId: string | null;
  };
  evictOldestCleanTab: (maxTabs: number) => DocumentTab | null | 'all-dirty';
};

type UseFileImportOptions = {
  workerClientRef: MutableRefObject<ImageWorkerClient | null>;
  activeDocumentIdRef: MutableRefObject<string | null>;
  persistedProfilesRef: MutableRefObject<FilmProfile[]>;
  fallbackProfile: FilmProfile;
  displayScaleFactor: number;
  tabsApi: TabsApi;
  maxTabs: number;
  createDocumentColorManagement: (
    source: Pick<WorkspaceDocument['source'], 'decoderColorProfileId' | 'embeddedColorProfileId'>,
    exportOptions?: WorkspaceDocument['exportOptions'],
  ) => ColorManagementSettings;
  formatError: (error: unknown, options?: { preservePrefix?: boolean }) => string;
  getErrorCode: (error: unknown) => string | null;
  isSupportedFile: (file: File) => boolean;
  isRawFile: (file: File) => boolean;
  disposeDocument: (documentId: string | null | undefined) => Promise<void>;
  resetUiForImport: () => void;
  setBlockingOverlay: (state: BlockingOverlayState) => void;
  setError: (message: string | null) => void;
  setTransientNotice: (notice: TransientNoticeState) => void;
  resolveRollId?: (nativePath: string | null | undefined, fileName: string) => string | null;
  getRollById?: (rollId: string | null) => Roll | null;
};

export type FileImportSource = {
  file: File;
  nativePath?: string | null;
  nativeFileSize?: number;
};

export type FileImportSourceLoader = () => Promise<FileImportSource | null>;

type ImportFileOptions = {
  activate?: boolean;
  background?: boolean;
  importSession?: number;
};

const RAW_GENERIC_PROFILE_ID = 'generic-color';

function normalizeProfileLookupValue(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveRawStartupProfile(
  roll: Roll | null,
  persistedProfiles: FilmProfile[],
  fallbackProfile: FilmProfile,
) {
  const genericProfile = FILM_PROFILES.find((profile) => profile.id === RAW_GENERIC_PROFILE_ID) ?? fallbackProfile;
  const availableProfiles = [...persistedProfiles, ...FILM_PROFILES];

  const rollStockKey = normalizeProfileLookupValue(roll?.filmStock);
  if (!rollStockKey) {
    if (roll?.profileId && roll.profileId !== RAW_GENERIC_PROFILE_ID) {
      const exactProfile = availableProfiles.find((profile) => profile.id === roll.profileId);
      if (exactProfile) {
        return exactProfile;
      }
    }
    return genericProfile;
  }

  const stockMatchedProfile = availableProfiles.find((profile) => (
    normalizeProfileLookupValue(profile.filmStock) === rollStockKey
    || normalizeProfileLookupValue(profile.name) === rollStockKey
    || normalizeProfileLookupValue(profile.id) === rollStockKey
  ));

  if (stockMatchedProfile) {
    return stockMatchedProfile;
  }

  if (roll?.profileId && roll.profileId !== RAW_GENERIC_PROFILE_ID) {
    const exactProfile = availableProfiles.find((profile) => profile.id === roll.profileId);
    if (exactProfile) {
      return exactProfile;
    }
  }

  return genericProfile;
}

export function useFileImport({
  workerClientRef,
  activeDocumentIdRef,
  persistedProfilesRef,
  fallbackProfile,
  displayScaleFactor,
  tabsApi,
  maxTabs,
  createDocumentColorManagement,
  formatError,
  getErrorCode,
  isSupportedFile,
  isRawFile,
  disposeDocument,
  resetUiForImport,
  setBlockingOverlay,
  setError,
  setTransientNotice,
  resolveRollId,
  getRollById,
}: UseFileImportOptions) {
  const importSessionRef = useRef(0);
  const backgroundQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoredSidecarsRef = useRef(new Set<string>());
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const importFile = useCallback(async (
    file: File,
    nativePath?: string | null,
    nativeFileSize?: number,
    options: ImportFileOptions = {},
  ) => {
    const worker = workerClientRef.current;
    if (!worker) return null;
    const activate = options.activate ?? true;
    const background = options.background ?? false;
    const reportError = (message: string, notifyBackground = true) => {
      if (background) {
        if (notifyBackground) {
          pushToast({ level: 'error', title: `Couldn't import ${file.name}`, message });
        }
        return;
      }
      setError(message);
      setImportError(message);
    };
    const sourceFileSize = nativeFileSize ?? file.size;
    const rawImport = isRawFile(file);

    if (rawImport) {
      if (!isDesktopShell()) {
        const message = 'RAW files (.dng, .cr3, .nef, .arw, .raf, .rw2) require the DarkSlide desktop app. Convert to TIFF for browser use, or download DarkSlide for desktop.';
        reportError(message);
        appendDiagnostic({ level: 'error', code: 'RAW_UNSUPPORTED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return null;
      }

      if (!nativePath) {
        const message = 'RAW import requires a file path. Please use File > Open.';
        reportError(message);
        appendDiagnostic({ level: 'error', code: 'RAW_PATH_REQUIRED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return null;
      }
    }

    if (!isSupportedFile(file) && !rawImport) {
      const message = 'Unsupported file type. Import TIFF, JPEG, PNG, or WebP for now.';
      reportError(message);
      appendDiagnostic({ level: 'error', code: 'UNSUPPORTED_FILE', message: file.name });
      return null;
    }

    if (!rawImport && sourceFileSize > MAX_FILE_SIZE_BYTES) {
      const message = `File is too large (${Math.round(sourceFileSize / 1024 / 1024)} MB). Maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`;
      reportError(message);
      appendDiagnostic({
        level: 'error',
        code: 'FILE_TOO_LARGE',
        message: file.name,
        context: {
          limitBytes: MAX_FILE_SIZE_BYTES,
          size: sourceFileSize,
        },
      });
      return null;
    }

    setIsImporting(true);
    if (!background) {
      setError(null);
      setImportError(null);
    }
    if (activate) {
      resetUiForImport();
    }

    if (nativePath) {
      const existingTab = tabsApi.findDocumentBySourcePath(nativePath);
      if (existingTab) {
        if (activate) {
          tabsApi.activateDocument(existingTab.id);
        }
        if (!background) {
          setBlockingOverlay(null);
        }
        setIsImporting(false);
        return existingTab.id;
      }
    }

    const evictedTab = tabsApi.evictOldestCleanTab(maxTabs);
    if (evictedTab === 'all-dirty') {
      const message = `You already have ${maxTabs} tabs open. Close a dirty tab before importing another image.`;
      reportError(message);
      setIsImporting(false);
      return null;
    }

    if (evictedTab) {
      void disposeDocument(evictedTab.id);
    }

    const importSession = options.importSession ?? (importSessionRef.current + 1);
    if (options.importSession === undefined) {
      importSessionRef.current = importSession;
    } else if (importSession !== importSessionRef.current) {
      setIsImporting(false);
      return null;
    }

    const documentId = crypto.randomUUID();
    const rollId = resolveRollId?.(nativePath, file.name) ?? null;
    const roll = getRollById?.(rollId) ?? null;
    const rawDefaultProfile = resolveRawStartupProfile(roll, persistedProfilesRef.current, fallbackProfile);
    const parsedPrefs = loadPreferences();
    const autoApplyPresetId = parsedPrefs?.autoApplyPresetId ?? null;
    const disableAutoApplyPreset = autoApplyPresetId === AUTO_APPLY_NONE_PRESET_ID;
    const lastUsedProfile = parsedPrefs?.lastProfileId
      ? (persistedProfilesRef.current.find((profile) => profile.id === parsedPrefs.lastProfileId) ?? fallbackProfile)
      : null;
    const autoApplyProfile = autoApplyPresetId && !disableAutoApplyPreset
      ? (persistedProfilesRef.current.find((profile) => profile.id === autoApplyPresetId) ?? null)
      : null;
    const preferredImportProfile = disableAutoApplyPreset
      ? null
      : (autoApplyProfile ?? lastUsedProfile);
    const rawStartupProfile = rawDefaultProfile;
    const activeImportProfile = rawImport
      ? (preferredImportProfile ?? rawStartupProfile)
      : (preferredImportProfile ?? fallbackProfile);
    if (activate) {
      activeDocumentIdRef.current = documentId;
    }

    const importIsStale = () => (
      importSession !== importSessionRef.current
      || !tabsApi.hasDocument(documentId)
      || (activate && activeDocumentIdRef.current !== documentId)
    );

    const discardStaleImport = async (stage: string) => {
      await disposeDocument(documentId);
      tabsApi.removeDocument(documentId);
      appendDiagnostic({
        level: 'info',
        code: 'IMPORT_STALE_IGNORED',
        message: file.name,
        context: {
          documentId,
          importSession,
          stage,
        },
      });
    };

    appendDiagnostic({
      level: 'info',
      code: 'IMPORT_STARTED',
      message: file.name,
      context: {
        documentId,
        extension: getFileExtension(file.name),
        importSession,
        size: sourceFileSize,
      },
    });

    const loadingDocument: WorkspaceDocument = {
      id: documentId,
      source: {
        id: documentId,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        extension: getFileExtension(file.name),
        size: sourceFileSize,
        width: 0,
        height: 0,
        nativePath: nativePath ?? null,
      },
      previewLevels: [],
      settings: {
        ...createDefaultSettings(structuredClone(activeImportProfile.defaultSettings)),
        filmBaseSample: rawImport
          ? null
          : (roll?.filmBaseSample ? structuredClone(roll.filmBaseSample) : activeImportProfile.defaultSettings.filmBaseSample),
        ...(!rawImport && roll?.filmBaseSample ? { filmBaseSampleSource: 'roll' as const } : {}),
      },
      colorManagement: DEFAULT_COLOR_MANAGEMENT,
      estimatedFlare: null,
      estimatedFilmBaseSample: null,
      estimatedFilmBase: null,
      estimatedDensityBalance: null,
      lightSourceId: null,
      cropSource: null,
      profileId: activeImportProfile.id,
      labStyleId: null,
      rollId,
      exportOptions: {
        ...DEFAULT_EXPORT_OPTIONS,
        filenameBase: sanitizeFilenameBase(file.name),
      },
      histogram: null,
      renderRevision: 0,
      status: 'loading',
      dirty: false,
    };

    flushSync(() => {
      if (!background) {
        setBlockingOverlay(rawImport ? {
          title: 'RAW import underway',
          detail: 'Decoding the RAW file and preparing the first preview.',
        } : {
          title: 'Import underway',
          detail: 'Loading the image and preparing preview levels.',
        });
      }
      tabsApi.openDocument(loadingDocument, { activate });
    });

    try {
      let decoded: DecodedImage;
      let initialSettings: ConversionSettings = {
        ...createDefaultSettings(structuredClone(activeImportProfile.defaultSettings)),
        filmBaseSample: rawImport
          ? null
          : (roll?.filmBaseSample ? structuredClone(roll.filmBaseSample) : activeImportProfile.defaultSettings.filmBaseSample),
      };
      let rawImportProfile: FilmProfile | null = null;

      if (rawImport) {
        try {
          const { rawResult, decodeRequest } = await decodeDesktopRawForWorker({
            documentId,
            fileName: file.name,
            path: nativePath!,
            size: sourceFileSize,
            maxDimension: RAW_EDITOR_PREVIEW_MAX_DIMENSION,
            includeHighDepth: false,
          });
          const estimatedFilmBaseEstimate = decodeRequest.precomputedFilmBase ?? null;
          const estimatedFilmBase = estimatedFilmBaseEstimate?.sample
            ?? decodeRequest.precomputedFilmBaseSample
            ?? null;
          const rawStartupSettings = createDefaultSettings(buildRawInitialSettings(
            rawStartupProfile.defaultSettings,
            rawResult.data,
            rawResult.width,
            rawResult.height,
            rawResult.orientation,
            estimatedFilmBaseEstimate ?? estimatedFilmBase,
          ));
          if (preferredImportProfile) {
            const preferredSettings = createDefaultSettings(structuredClone(activeImportProfile.defaultSettings));
            const shouldUseDirectBase = shouldUseDirectRawFilmBase(true, activeImportProfile, preferredSettings);
            initialSettings = {
              ...preferredSettings,
              // Keep automatic estimates in the document calibration path.
              // Promoting one to a settings sample makes it look manual and
              // disables the measured density balance that removes the mask.
              filmBaseSample: shouldUseDirectBase && preferredSettings.filmBaseSample
                ? structuredClone(preferredSettings.filmBaseSample)
                : null,
            };
          } else {
            initialSettings = rawStartupSettings;
          }
          rawImportProfile = createRawImportProfile(rawStartupProfile, rawStartupSettings);

          if (estimatedFilmBase) {
            appendDiagnostic({
              level: 'info',
              code: 'RAW_FILM_BASE_ESTIMATED',
              message: `${estimatedFilmBase.r}/${estimatedFilmBase.g}/${estimatedFilmBase.b}`,
              context: {
                documentId,
                fileName: file.name,
              },
            });
          } else {
            appendDiagnostic({
              level: 'info',
              code: 'RAW_FILM_BASE_ESTIMATION_FAILED',
              message: file.name,
              context: {
                documentId,
                fileName: file.name,
              },
            });
          }

          appendDiagnostic({
            level: 'info',
            code: 'RAW_DECODED',
            message: `RAW preview ready: ${file.name} (${rawResult.width}×${rawResult.height}, ${rawResult.color_space})`,
            context: {
              colorSpace: rawResult.color_space,
              documentId,
              fileName: file.name,
              height: rawResult.height,
              previewHeight: rawResult.height,
              previewWidth: rawResult.width,
              sourceHeight: rawResult.sourceHeight ?? rawResult.height,
              sourceWidth: rawResult.sourceWidth ?? rawResult.width,
              orientation: rawResult.orientation ?? null,
              width: rawResult.width,
              cacheHit: rawResult.cacheHit ?? false,
              cacheReadMs: rawResult.cacheReadMs ?? 0,
              decodeMs: rawResult.decodeMs ?? 0,
              queueWaitMs: rawResult.queueWaitMs ?? 0,
            },
          });

          worker.registerDocumentReloaders(documentId, {
            preview: async () => {
              const result = await decodeDesktopRawForWorker({
                documentId,
                fileName: file.name,
                path: nativePath!,
                size: sourceFileSize,
                maxDimension: RAW_EDITOR_PREVIEW_MAX_DIMENSION,
                includeHighDepth: false,
              });
              return { ...result.decodeRequest, displayScaleFactor };
            },
            full: async () => {
              const result = await decodeDesktopRawForWorker({
                documentId,
                fileName: file.name,
                path: nativePath!,
                size: sourceFileSize,
                includeHighDepth: true,
              });
              return { ...result.decodeRequest, displayScaleFactor };
            },
          });
          decoded = await worker.decode({
            ...decodeRequest,
            displayScaleFactor,
          }, { retainRecoveryCache: false });
          if (rawResult.orientation) {
            decoded.metadata.exif = { orientation: rawResult.orientation };
          }
        } catch (rawError) {
          const message = formatError(rawError);
          appendDiagnostic({
            level: 'error',
            code: 'RAW_DECODE_FAILED',
            message,
            context: {
              documentId,
              fileName: file.name,
              nativePath: nativePath ?? null,
            },
          });
          throw rawError;
        }
      } else {
        const buffer = await file.arrayBuffer();
        if (importIsStale()) {
          await discardStaleImport('array-buffer');
          return null;
        }

        decoded = await worker.decode({
          documentId,
          buffer,
          fileName: file.name,
          mime: file.type || 'application/octet-stream',
          size: sourceFileSize,
          displayScaleFactor,
        });

        const rotationFromMetadata = rotationFromExifOrientation(decoded.metadata.exif?.orientation);
        if (rotationFromMetadata !== 0) {
          initialSettings = {
            ...initialSettings,
            rotation: rotationFromMetadata,
          };
        }
      }

      if (importIsStale()) {
        await discardStaleImport('decode');
        return null;
      }

      if (!rawImport && !initialSettings.filmBaseSample && decoded.estimatedFilmBaseSample) {
        initialSettings = {
          ...initialSettings,
          filmBaseSample: structuredClone(decoded.estimatedFilmBaseSample),
        };
      }

      const savedExportOptions = parsedPrefs?.exportOptions;
      const savedLightSourceId = typeof window !== 'undefined'
        ? window.localStorage.getItem('darkslide_default_light_source')
        : null;
      const savedLabStyleId = typeof window !== 'undefined'
        ? window.localStorage.getItem('darkslide_default_lab_style')
        : null;
      let resolvedProfile = rawImport && preferredImportProfile
        ? activeImportProfile
        : (rawImportProfile ?? activeImportProfile);
      let restoredSidecar = null;

      if (nativePath && isDesktopShell() && !ignoredSidecarsRef.current.has(nativePath)) {
        for (const candidatePath of getSidecarCandidatePaths(nativePath)) {
          try {
            const content = await readTextFileByPath(candidatePath);
            const parsed = parseSidecar(content);
            if (parsed) {
              restoredSidecar = parsed;
              break;
            }
          } catch {
            // Ignore missing sidecar candidates.
          }
        }
      }

      const shouldRestoreSidecar = restoredSidecar
        ? await confirmRestoreSidecar(file.name)
        : false;
      const activeSidecar = shouldRestoreSidecar ? restoredSidecar : null;

      if (restoredSidecar && !shouldRestoreSidecar && nativePath) {
        ignoredSidecarsRef.current.add(nativePath);
      }

      if (importIsStale()) {
        await discardStaleImport('sidecar');
        return null;
      }

      const documentColorManagement = createDocumentColorManagement(decoded.metadata, {
        ...DEFAULT_EXPORT_OPTIONS,
        ...(activeSidecar?.exportOptions ?? savedExportOptions),
      });
      let resolvedEstimatedDensityBalance = decoded.estimatedDensityBalance ?? null;

      // A RAW negative should open as a usable positive. Run the same
      // frame-aware Auto pass as the editor button after decode has pinned the
      // base estimate and density balance. Sidecars remain exact and bypass it.
      if (rawImport && !activeSidecar) {
        const autoProfile = preferredImportProfile ? activeImportProfile : rawStartupProfile;
        const stockDensity = FILM_STOCK_DENSITY_PRESETS[autoProfile.id];
        const stableDensityBalance: DensityBalance = stockDensity
          ? { ...stockDensity, source: 'film-stock-preset' as const }
          : {
            scaleR: 1,
            scaleG: 1,
            scaleB: 1,
            source: 'neutral-fallback' as const,
          };
        resolvedEstimatedDensityBalance = stableDensityBalance;

        // The decoder may produce a whole-scene histogram estimate before it
        // knows which profile will process the negative. Replace it with the
        // stable profile calibration before Auto and pin it for later reloads.
        if (decoded.estimatedFilmBase) {
          try {
            await worker.applyFilmBaseEstimate({
              documentId,
              estimatedFilmBase: decoded.estimatedFilmBase,
              estimatedDensityBalance: stableDensityBalance,
            });
          } catch (calibrationError) {
            appendDiagnostic({
              level: 'error',
              code: 'RAW_DENSITY_CALIBRATION_FAILED',
              message: formatError(calibrationError),
              context: { documentId, fileName: file.name },
            });
          }
        }

        const autoLightSourceId = resolveLightSourceIdForProfile(
          autoProfile,
          autoProfile.lightSourceId ?? savedLightSourceId,
          { blackAndWhiteEnabled: initialSettings.blackAndWhite.enabled },
        );
        const lightSourceBias = LIGHT_SOURCE_PROFILES.find((profile) => profile.id === (autoLightSourceId ?? 'auto'))
          ?.spectralBias ?? [1, 1, 1];

        try {
          const autoResult = await worker.autoAnalyze({
            documentId,
            settings: createAutoAnalysisSettings(initialSettings, initialSettings),
            isColor: usesColorChannelPipeline(autoProfile),
            profileId: autoProfile.id,
            filmType: autoProfile.filmType,
            inputProfileId: getResolvedInputProfileId(decoded.metadata, documentColorManagement),
            outputProfileId: documentColorManagement.outputProfileId,
            targetMaxDimension: 1024,
            maskTuning: autoProfile.maskTuning,
            colorMatrix: autoProfile.colorMatrix,
            tonalCharacter: autoProfile.tonalCharacter,
            cubeLut: autoProfile.lut ?? null,
            highlightDensityEstimate: 0,
            flareFloor: decoded.estimatedFlare ?? null,
            lightSourceBias,
          });
          if (autoResult) {
            initialSettings = {
              ...initialSettings,
              ...createAutoAdjustmentPatch(initialSettings, autoResult),
            };
            appendDiagnostic({
              level: 'info',
              code: 'RAW_AUTO_DEVELOPED',
              message: file.name,
              context: {
                documentId,
                exposure: autoResult.exposure,
                blackPoint: autoResult.blackPoint,
                whitePoint: autoResult.whitePoint,
                temperature: autoResult.temperature,
                tint: autoResult.tint,
                whiteBalanceRed: autoResult.whiteBalanceGains?.red ?? null,
                whiteBalanceGreen: autoResult.whiteBalanceGains?.green ?? null,
                whiteBalanceBlue: autoResult.whiteBalanceGains?.blue ?? null,
              },
            });
          }
        } catch (autoError) {
          appendDiagnostic({
            level: 'error',
            code: 'RAW_AUTO_DEVELOP_FAILED',
            message: formatError(autoError),
            context: { documentId, fileName: file.name },
          });
        }

        // This immutable transient profile is the true import origin. Global
        // Reset can restore it even after the user selects another preset.
        rawImportProfile = createRawImportProfile(autoProfile, initialSettings);
        if (!preferredImportProfile) {
          resolvedProfile = rawImportProfile;
        }
      }

      const nextDocument: WorkspaceDocument = {
        id: documentId,
        source: {
          ...decoded.metadata,
          size: sourceFileSize,
          nativePath: nativePath ?? null,
        },
        previewLevels: decoded.previewLevels,
        settings: activeSidecar
          ? createDefaultSettings(structuredClone(activeSidecar.settings))
          : initialSettings,
        colorManagement: documentColorManagement,
        estimatedFlare: decoded.estimatedFlare,
        estimatedFilmBaseSample: decoded.estimatedFilmBaseSample ?? null,
        estimatedFilmBase: decoded.estimatedFilmBase ?? null,
        estimatedDensityBalance: resolvedEstimatedDensityBalance,
        lightSourceId: resolveLightSourceIdForProfile(
          resolvedProfile,
          activeSidecar?.lightSourceProfileId ?? resolvedProfile.lightSourceId ?? savedLightSourceId,
          { blackAndWhiteEnabled: initialSettings.blackAndWhite.enabled },
        ),
        cropSource: null,
        rawImportProfile,
        profileId: activeSidecar?.profileId ?? resolvedProfile.id,
        labStyleId: activeSidecar?.labStyleId ?? resolvedProfile.labStyleId ?? savedLabStyleId ?? null,
        rollId,
        exportOptions: {
          ...DEFAULT_EXPORT_OPTIONS,
          ...(activeSidecar?.exportOptions ?? savedExportOptions),
          filenameBase: sanitizeFilenameBase(file.name),
        },
        histogram: null,
        renderRevision: 0,
        status: 'ready',
        dirty: false,
      };

      if (activeSidecar) {
        nextDocument.colorManagement = {
          ...nextDocument.colorManagement,
          ...activeSidecar.colorManagement,
        };
        if (roll?.filmBaseSample && !nextDocument.settings.filmBaseSample) {
          nextDocument.settings.filmBaseSample = structuredClone(roll.filmBaseSample);
        }
      }

      tabsApi.replaceDocument(documentId, nextDocument);

      if (decoded.metadata.unsupportedColorProfileName) {
        const message = `Unsupported source profile "${decoded.metadata.unsupportedColorProfileName}". DarkSlide is using sRGB until you override it.`;
        if (background) {
          pushToast({ level: 'warning', title: file.name, message });
        } else {
          setTransientNotice({ message });
        }
      }

      addRecentFile({
        name: file.name,
        path: isDesktopShell() ? (nativePath ?? null) : null,
        size: sourceFileSize,
      });
      appendDiagnostic({
        level: 'info',
        code: 'FILE_IMPORTED',
        message: file.name,
        context: {
          documentId,
          height: decoded.metadata.height,
          importSession,
          previewLevels: decoded.previewLevels.length,
          size: decoded.metadata.size,
          width: decoded.metadata.width,
        },
      });

      if (!background) {
        setBlockingOverlay(null);
      }
      return documentId;
    } catch (importErr) {
      if (importIsStale()) {
        await discardStaleImport('error');
        return null;
      }

      const message = formatError(importErr);
      const errorCode = getErrorCode(importErr);
      if (activate) {
        activeDocumentIdRef.current = null;
      }
      const diagnostic = appendDiagnostic({
        level: 'error',
        code: 'IMPORT_FAILED',
        message,
        context: {
          documentId,
          fileName: file.name,
          importSession,
        },
      });
      const nextError = errorCode === 'OUT_OF_MEMORY' ? message : `Import failed. ${message}`;
      reportError(nextError, false);
      pushToast({
        level: 'error',
        title: 'Couldn’t import file',
        message: `${file.name}: ${message}`,
        diagnosticId: diagnostic?.id,
      });
      await disposeDocument(documentId);
      tabsApi.removeDocument(documentId);
      if (!background) {
        setBlockingOverlay(null);
      }
      return null;
    } finally {
      setIsImporting(false);
    }
  }, [
    activeDocumentIdRef,
    createDocumentColorManagement,
    displayScaleFactor,
    disposeDocument,
    fallbackProfile,
    formatError,
    getErrorCode,
    isRawFile,
    isSupportedFile,
    maxTabs,
    persistedProfilesRef,
    resetUiForImport,
    setBlockingOverlay,
    setError,
    setTransientNotice,
    tabsApi,
    workerClientRef,
    getRollById,
    resolveRollId,
  ]);

  const importFiles = useCallback(async (sources: Array<FileImportSource | FileImportSourceLoader>) => {
    if (sources.length === 0) return null;

    const importSession = importSessionRef.current + 1;
    importSessionRef.current = importSession;
    let foregroundDocumentId: string | null = null;
    let nextSourceIndex = 0;
    const loadSource = async (
      source: FileImportSource | FileImportSourceLoader,
      background: boolean,
    ) => {
      try {
        return typeof source === 'function' ? await source() : source;
      } catch (sourceError) {
        const message = formatError(sourceError);
        const diagnostic = appendDiagnostic({
          level: 'error',
          code: 'IMPORT_SOURCE_LOAD_FAILED',
          message,
        });
        if (background) {
          pushToast({
            level: 'error',
            title: "Couldn't open file",
            message,
            diagnosticId: diagnostic?.id,
          });
        } else {
          setError(`Could not open file. ${message}`);
          setImportError(`Could not open file. ${message}`);
        }
        return null;
      }
    };

    while (nextSourceIndex < sources.length && !foregroundDocumentId) {
      const source = await loadSource(sources[nextSourceIndex], false);
      nextSourceIndex += 1;
      if (!source) continue;
      foregroundDocumentId = await importFile(
        source.file,
        source.nativePath,
        source.nativeFileSize,
        { activate: true, importSession },
      );
      if (importSession !== importSessionRef.current) {
        return null;
      }
    }

    if (!foregroundDocumentId || nextSourceIndex >= sources.length) {
      return foregroundDocumentId;
    }

    const backgroundSources = sources.slice(nextSourceIndex);
    await waitForNextPaint();

    backgroundQueueRef.current = backgroundQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        for (const source of backgroundSources) {
          if (importSession !== importSessionRef.current) {
            break;
          }
          const loadedSource = await loadSource(source, true);
          if (!loadedSource) continue;
          await importFile(
            loadedSource.file,
            loadedSource.nativePath,
            loadedSource.nativeFileSize,
            { activate: false, background: true, importSession },
          );
        }
      })
      .catch((backgroundError) => {
        appendDiagnostic({
          level: 'error',
          code: 'BACKGROUND_IMPORT_FAILED',
          message: formatError(backgroundError),
        });
      });

    void backgroundQueueRef.current;
    return foregroundDocumentId;
  }, [formatError, importFile, setError]);

  return {
    importFile,
    importFiles,
    isImporting,
    importError,
    importSessionRef,
  };
}
