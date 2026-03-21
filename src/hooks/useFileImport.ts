import { MutableRefObject, useCallback, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ColorManagementSettings,
  ConversionSettings,
  DecodedImage,
  DocumentTab,
  FilmProfile,
  WorkspaceDocument,
} from '../types';
import {
  DEFAULT_COLOR_MANAGEMENT,
  DEFAULT_EXPORT_OPTIONS,
  FILM_PROFILES,
  MAX_FILE_SIZE_BYTES,
} from '../constants';
import { appendDiagnostic } from '../utils/diagnostics';
import { addRecentFile } from '../utils/recentFilesStore';
import { getFileExtension, sanitizeFilenameBase } from '../utils/imagePipeline';
import { loadPreferences } from '../utils/preferenceStore';
import {
  buildRawInitialSettings,
  createRawImportProfile,
  decodeDesktopRawForWorker,
  estimateFilmBaseSample,
  isRawExtension,
  rotationFromExifOrientation,
} from '../utils/rawImport';
import { isDesktopShell } from '../utils/fileBridge';
import { ImageWorkerClient } from '../utils/imageWorkerClient';

type BlockingOverlayState = {
  title: string;
  detail: string;
} | null;

type TransientNoticeState = {
  message: string;
  tone?: 'warning' | 'success';
} | null;

type TabsApi = {
  openDocument: (document: WorkspaceDocument, options?: { activate?: boolean }) => void;
  replaceDocument: (documentId: string, document: WorkspaceDocument) => void;
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
};

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
}: UseFileImportOptions) {
  const importSessionRef = useRef(0);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const importFile = useCallback(async (file: File, nativePath?: string | null, nativeFileSize?: number) => {
    const worker = workerClientRef.current;
    if (!worker) return null;
    const sourceFileSize = nativeFileSize ?? file.size;
    const rawImport = isRawFile(file);

    if (rawImport) {
      if (!isDesktopShell()) {
        const message = 'RAW files (.dng, .cr3, .nef, .arw, .raf, .rw2) require the DarkSlide desktop app. Convert to TIFF for browser use, or download DarkSlide for desktop.';
        setError(message);
        setImportError(message);
        appendDiagnostic({ level: 'error', code: 'RAW_UNSUPPORTED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return null;
      }

      if (!nativePath) {
        const message = 'RAW import requires a file path. Please use File > Open.';
        setError(message);
        setImportError(message);
        appendDiagnostic({ level: 'error', code: 'RAW_PATH_REQUIRED', message: file.name, context: { extension: getFileExtension(file.name) } });
        return null;
      }
    }

    if (!isSupportedFile(file) && !rawImport) {
      const message = 'Unsupported file type. Import TIFF, JPEG, PNG, or WebP for now.';
      setError(message);
      setImportError(message);
      appendDiagnostic({ level: 'error', code: 'UNSUPPORTED_FILE', message: file.name });
      return null;
    }

    if (!rawImport && sourceFileSize > MAX_FILE_SIZE_BYTES) {
      const message = `File is too large (${Math.round(sourceFileSize / 1024 / 1024)} MB). Maximum supported size is ${Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB.`;
      setError(message);
      setImportError(message);
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
    setError(null);
    setImportError(null);
    resetUiForImport();

    const evictedTab = tabsApi.evictOldestCleanTab(maxTabs);
    if (evictedTab === 'all-dirty') {
      const message = `You already have ${maxTabs} tabs open. Close a dirty tab before importing another image.`;
      setError(message);
      setImportError(message);
      setIsImporting(false);
      return null;
    }

    if (evictedTab) {
      void disposeDocument(evictedTab.id);
    }

    const importSession = importSessionRef.current + 1;
    importSessionRef.current = importSession;

    const documentId = crypto.randomUUID();
    const rawDefaultProfile = FILM_PROFILES.find((profile) => profile.id === 'generic-color') ?? fallbackProfile;
    const parsedPrefs = loadPreferences();
    const initialProfile = rawImport
      ? rawDefaultProfile
      : (
        parsedPrefs?.lastProfileId
          ? (persistedProfilesRef.current.find((profile) => profile.id === parsedPrefs.lastProfileId) ?? fallbackProfile)
          : fallbackProfile
      );
    activeDocumentIdRef.current = documentId;

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
      },
      previewLevels: [],
      settings: structuredClone(initialProfile.defaultSettings),
      colorManagement: DEFAULT_COLOR_MANAGEMENT,
      profileId: initialProfile.id,
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
      setBlockingOverlay(rawImport ? {
        title: 'RAW import underway',
        detail: 'Decoding the RAW file and preparing the first preview.',
      } : {
        title: 'Import underway',
        detail: 'Loading the image and preparing preview levels.',
      });
      tabsApi.openDocument(loadingDocument, { activate: true });
    });

    try {
      let decoded: DecodedImage;
      let initialSettings = structuredClone(initialProfile.defaultSettings);
      let rawImportProfile: FilmProfile | null = null;

      if (rawImport) {
        try {
          const { rawResult, decodeRequest } = await decodeDesktopRawForWorker({
            documentId,
            fileName: file.name,
            path: nativePath!,
            size: sourceFileSize,
          });
          const estimatedFilmBase = estimateFilmBaseSample(rawResult.data, rawResult.width, rawResult.height);
          initialSettings = buildRawInitialSettings(
            initialProfile.defaultSettings,
            rawResult.data,
            rawResult.width,
            rawResult.height,
            rawResult.orientation,
          );
          rawImportProfile = createRawImportProfile(initialProfile, initialSettings);

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
          }

          appendDiagnostic({
            level: 'info',
            code: 'RAW_DECODED',
            message: `RAW decoded via Tauri: ${file.name} (${rawResult.width}×${rawResult.height}, ${rawResult.color_space})`,
            context: {
              colorSpace: rawResult.color_space,
              documentId,
              fileName: file.name,
              height: rawResult.height,
              orientation: rawResult.orientation ?? null,
              width: rawResult.width,
            },
          });

          decoded = await worker.decode({
            ...decodeRequest,
            displayScaleFactor,
          });
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
        if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) {
          appendDiagnostic({
            level: 'info',
            code: 'IMPORT_STALE_IGNORED',
            message: file.name,
            context: {
              documentId,
              importSession,
              stage: 'array-buffer',
            },
          });
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

      if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) {
        await disposeDocument(documentId);
        appendDiagnostic({
          level: 'info',
          code: 'IMPORT_STALE_IGNORED',
          message: file.name,
          context: {
            documentId,
            importSession,
            stage: 'decode',
          },
        });
        return null;
      }

      const savedExportOptions = parsedPrefs?.exportOptions;
      const nextDocument: WorkspaceDocument = {
        id: documentId,
        source: {
          ...decoded.metadata,
          size: sourceFileSize,
        },
        previewLevels: decoded.previewLevels,
        settings: initialSettings,
        colorManagement: createDocumentColorManagement(decoded.metadata, {
          ...DEFAULT_EXPORT_OPTIONS,
          ...(savedExportOptions ? {
            format: savedExportOptions.format,
            quality: savedExportOptions.quality,
            embedMetadata: savedExportOptions.embedMetadata,
            outputProfileId: savedExportOptions.outputProfileId,
            embedOutputProfile: savedExportOptions.embedOutputProfile,
          } : {}),
        }),
        rawImportProfile,
        profileId: rawImportProfile?.id ?? initialProfile.id,
        exportOptions: {
          ...DEFAULT_EXPORT_OPTIONS,
          ...(savedExportOptions ? {
            format: savedExportOptions.format,
            quality: savedExportOptions.quality,
            embedMetadata: savedExportOptions.embedMetadata,
            outputProfileId: savedExportOptions.outputProfileId,
            embedOutputProfile: savedExportOptions.embedOutputProfile,
          } : {}),
          filenameBase: sanitizeFilenameBase(file.name),
        },
        histogram: null,
        renderRevision: 0,
        status: 'ready',
        dirty: false,
      };

      tabsApi.replaceDocument(documentId, nextDocument);

      if (decoded.metadata.unsupportedColorProfileName) {
        setTransientNotice({
          message: `Unsupported source profile "${decoded.metadata.unsupportedColorProfileName}". DarkSlide is using sRGB until you override it.`,
        });
      } else {
        setTransientNotice(null);
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

      setBlockingOverlay(null);
      return documentId;
    } catch (importErr) {
      if (importSession !== importSessionRef.current || activeDocumentIdRef.current !== documentId) {
        return null;
      }

      const message = formatError(importErr);
      const errorCode = getErrorCode(importErr);
      activeDocumentIdRef.current = null;
      appendDiagnostic({
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
      setError(nextError);
      setImportError(nextError);
      tabsApi.removeDocument(documentId);
      setBlockingOverlay(null);
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
  ]);

  return {
    importFile,
    isImporting,
    importError,
    importSessionRef,
  };
}
