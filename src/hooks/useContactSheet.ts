import { decodeDesktopRawForWorker } from '../utils/desktopRaw';
import { MutableRefObject, useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_COLOR_MANAGEMENT, LAB_STYLE_PROFILES_MAP, MAX_FILE_SIZE_BYTES } from '../constants';
import { ContactSheetRequest, DocumentTab, FilmProfile, LightSourceProfile, NotificationSettings } from '../types';
import { BatchJobEntry } from '../utils/batchProcessor';
import { getBatchEffectiveSettings } from '../utils/batchSettings';
import {
  ContactSheetLayout,
  DEFAULT_CONTACT_SHEET_LAYOUT,
  hexToRgb,
  suggestContactSheetColumns,
} from '../utils/contactSheetLayout';
import { notifyExportFinished, primeExportNotificationsPermission } from '../utils/exportNotifications';
import { isDesktopShell, openImageFolder, openMultipleImageFiles, saveExportBlob, saveToDirectory } from '../utils/fileBridge';
import { getFileExtension } from '../utils/imagePipeline';
import { ImageWorkerClient } from '../utils/imageWorkerClient';
import { resolveDocumentProfile } from '../utils/presetRecipe';
import { isRawExtension } from '../utils/rawImport';

export type ContactSheetSource = 'frames' | 'files';
export type ContactSheetScope = 'selected' | 'all';

export interface ContactSheetCellPreview {
  id: string;
  label: string;
  /** Thumbnail of a file that is not open; open frames use their filmstrip thumbnail. */
  thumbnailUrl: string | null;
}

interface UseContactSheetOptions {
  workerClientRef: MutableRefObject<ImageWorkerClient | null>;
  tabs: DocumentTab[];
  tabsRef: MutableRefObject<DocumentTab[]>;
  activeTabId: string | null;
  selectedIds: string[];
  profilesById: ReadonlyMap<string, FilmProfile>;
  fallbackProfile: FilmProfile;
  lightSourceProfilesById: ReadonlyMap<string, LightSourceProfile>;
  notificationSettings: NotificationSettings;
  outputPath: string | null;
  onSaved: (message: string) => void;
}

export interface ContactSheetController {
  layout: ContactSheetLayout;
  setLayout: (patch: Partial<ContactSheetLayout>) => void;
  source: ContactSheetSource;
  setSource: (source: ContactSheetSource) => void;
  scope: ContactSheetScope;
  setScope: (scope: ContactSheetScope) => void;
  selectedCount: number;
  frameCount: number;
  files: BatchJobEntry[];
  addFiles: () => Promise<void>;
  addFolder: () => Promise<void>;
  addBrowserFiles: (files: File[]) => void;
  removeFile: (id: string) => void;
  clearFiles: () => void;
  cells: ContactSheetCellPreview[];
  isGenerating: boolean;
  error: string | null;
  generate: () => Promise<void>;
}

/** The look of a frame, resolved into what the contact sheet compositor needs. */
function resolveFrameLook(
  tab: DocumentTab,
  profilesById: ReadonlyMap<string, FilmProfile>,
  fallbackProfile: FilmProfile,
  lightSourceProfilesById: ReadonlyMap<string, LightSourceProfile>,
) {
  const profile = resolveDocumentProfile(tab.document, profilesById, fallbackProfile);
  const labStyle = tab.document.labStyleId ? LAB_STYLE_PROFILES_MAP[tab.document.labStyleId] ?? null : null;
  const lightSourceBias = lightSourceProfilesById.get(tab.document.lightSourceId ?? 'auto')?.spectralBias ?? [1, 1, 1];
  return {
    settings: structuredClone(tab.document.settings),
    profile,
    labStyle,
    colorManagement: tab.document.colorManagement ?? DEFAULT_COLOR_MANAGEMENT,
    lightSourceBias: [...lightSourceBias] as [number, number, number],
    flareFloor: tab.document.estimatedFlare ?? null,
  };
}

type FrameLook = ReturnType<typeof resolveFrameLook>;

async function decodeFileEntry(worker: ImageWorkerClient, entry: BatchJobEntry, documentId: string) {
  if (!entry.file) {
    throw new Error(`Missing file for "${entry.filename}".`);
  }
  const isRaw = isRawExtension(getFileExtension(entry.filename));
  if (isRaw) {
    if (!isDesktopShell() || !entry.nativePath) {
      throw new Error(`RAW files need the desktop app ("${entry.filename}").`);
    }
    const { decodeRequest } = await decodeDesktopRawForWorker({
      documentId,
      fileName: entry.filename,
      path: entry.nativePath,
      size: entry.size,
    });
    await worker.decode(decodeRequest);
    return;
  }
  if (!entry.nativePath && entry.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`"${entry.filename}" exceeds the supported file size limit.`);
  }
  await worker.decode({
    documentId,
    buffer: await entry.file.arrayBuffer(),
    fileName: entry.filename,
    mime: entry.file.type || 'application/octet-stream',
    size: entry.file.size,
  });
}

/**
 * State and actions of the Contact sheet tool. Open frames keep their own
 * look; files that are not open take the look of the frame being edited,
 * without its crop, rotation or dust marks.
 */
export function useContactSheet({
  workerClientRef,
  tabs,
  tabsRef,
  activeTabId,
  selectedIds,
  profilesById,
  fallbackProfile,
  lightSourceProfilesById,
  notificationSettings,
  outputPath,
  onSaved,
}: UseContactSheetOptions): ContactSheetController {
  const [layout, setLayoutState] = useState<ContactSheetLayout>(DEFAULT_CONTACT_SHEET_LAYOUT);
  const [columnsTouched, setColumnsTouched] = useState(false);
  const [source, setSource] = useState<ContactSheetSource>('frames');
  const [scope, setScope] = useState<ContactSheetScope>(selectedIds.length > 1 ? 'selected' : 'all');
  const [files, setFiles] = useState<BatchJobEntry[]>([]);
  const [fileThumbnails, setFileThumbnails] = useState<Map<string, string>>(new Map());
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = selectedIds.length;

  // Follow the filmstrip, like the Export panel: a multi-selection becomes
  // the natural scope and an empty one falls back to every frame.
  useEffect(() => {
    setScope(selectedCount > 1 ? 'selected' : 'all');
  }, [selectedCount]);

  const frameIds = useMemo(() => {
    if (scope === 'selected' && selectedCount > 1) {
      const selected = new Set(selectedIds);
      return tabs.filter((tab) => selected.has(tab.id)).map((tab) => tab.id);
    }
    return tabs.map((tab) => tab.id);
  }, [scope, selectedCount, selectedIds, tabs]);

  const cells = useMemo<ContactSheetCellPreview[]>(() => {
    if (source === 'files') {
      return files.map((entry) => ({ id: entry.id, label: entry.filename, thumbnailUrl: fileThumbnails.get(entry.id) ?? null }));
    }
    return frameIds.flatMap((id) => {
      const tab = tabs.find((candidate) => candidate.id === id);
      return tab ? [{ id, label: tab.document.source.name, thumbnailUrl: null }] : [];
    });
  }, [fileThumbnails, files, frameIds, source, tabs]);

  // Until the user picks a column count, keep the grid roughly square.
  useEffect(() => {
    if (columnsTouched) return;
    const columns = suggestContactSheetColumns(cells.length);
    setLayoutState((current) => (current.columns === columns ? current : { ...current, columns }));
  }, [cells.length, columnsTouched]);

  const setLayout = useCallback((patch: Partial<ContactSheetLayout>) => {
    if (patch.columns !== undefined) setColumnsTouched(true);
    setLayoutState((current) => ({ ...current, ...patch }));
  }, []);

  const activeLook = useCallback((): FrameLook | null => {
    const activeTab = tabsRef.current.find((tab) => tab.id === activeTabId) ?? null;
    return activeTab ? resolveFrameLook(activeTab, profilesById, fallbackProfile, lightSourceProfilesById) : null;
  }, [activeTabId, fallbackProfile, lightSourceProfilesById, profilesById, tabsRef]);

  const appendFiles = useCallback((added: Array<{ file: File; nativePath?: string; nativeSize?: number }>) => {
    if (added.length === 0) return;
    setFiles((current) => [
      ...current,
      ...added.map(({ file, nativePath, nativeSize }) => ({
        id: crypto.randomUUID(),
        kind: 'file' as const,
        file,
        nativePath,
        filename: file.name,
        size: nativeSize ?? file.size,
        status: 'pending' as const,
      })),
    ]);
    setSource('files');
    setError(null);
  }, []);

  const addFiles = useCallback(async () => {
    try {
      const picked = await openMultipleImageFiles();
      appendFiles(picked.map((entry) => ({ file: entry.file, nativePath: entry.path, nativeSize: entry.size })));
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  }, [appendFiles]);

  const addFolder = useCallback(async () => {
    try {
      const picked = await openImageFolder();
      appendFiles(picked.map((entry) => ({ file: entry.file, nativePath: entry.path, nativeSize: entry.size })));
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    }
  }, [appendFiles]);

  const addBrowserFiles = useCallback((picked: File[]) => {
    appendFiles(picked.map((file) => ({ file })));
  }, [appendFiles]);

  const removeFile = useCallback((id: string) => {
    setFiles((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const clearFiles = useCallback(() => setFiles([]), []);

  // Thumbnails for files that are not open, rendered small with the look of
  // the frame being edited. Re-rendered when files are added or the edited
  // frame changes, not on every slider move.
  useEffect(() => {
    const worker = workerClientRef.current;
    const look = activeLook();
    if (!worker || !look || files.length === 0) {
      return;
    }

    const token = { cancelled: false };
    const tempIds: string[] = [];

    const run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      for (const entry of files) {
        if (token.cancelled) break;
        const documentId = `cs-thumb-${entry.id}`;
        try {
          await decodeFileEntry(worker, entry, documentId);
          tempIds.push(documentId);
          if (token.cancelled) break;
          const result = await worker.render({
            documentId,
            settings: getBatchEffectiveSettings(look.settings, true),
            isColor: look.profile.type === 'color',
            filmType: look.profile.filmType,
            inputProfileId: look.colorManagement.inputMode === 'override' ? look.colorManagement.inputProfileId : undefined,
            outputProfileId: 'srgb',
            labStyleToneCurve: look.labStyle?.toneCurve,
            labStyleChannelCurves: look.labStyle?.channelCurves,
            labTonalCharacterOverride: look.labStyle?.tonalCharacterOverride,
            labSaturationBias: look.labStyle?.saturationBias ?? 0,
            labTemperatureBias: look.labStyle?.temperatureBias ?? 0,
            lightSourceBias: look.lightSourceBias,
            revision: 0,
            targetMaxDimension: 256,
            comparisonMode: 'processed',
          });
          if (token.cancelled) break;
          const canvas = document.createElement('canvas');
          canvas.width = result.width;
          canvas.height = result.height;
          const context = canvas.getContext('2d');
          if (context) {
            context.putImageData(result.imageData, 0, 0);
            const url = canvas.toDataURL('image/jpeg', 0.7);
            setFileThumbnails((current) => new Map(current).set(entry.id, url));
          }
        } catch {
          // The cell keeps its placeholder.
        }
      }
      await Promise.allSettled(tempIds.splice(0).map((id) => worker.disposeDocument(id)));
    };

    void run();
    return () => {
      token.cancelled = true;
      tempIds.forEach((id) => void worker.disposeDocument(id));
    };
  // activeLook is keyed on the edited frame through activeTabId.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, files, workerClientRef]);

  const generate = useCallback(async () => {
    const worker = workerClientRef.current;
    if (!worker || isGenerating) return;
    if (cells.length === 0) {
      setError(source === 'files' ? 'Add files to lay out first.' : 'Open frames to lay out first.');
      return;
    }

    const look = activeLook();
    if (source === 'files' && !look) {
      setError('Open a frame first: files take its look.');
      return;
    }

    setIsGenerating(true);
    setError(null);
    const tempIds: string[] = [];
    try {
      if (notificationSettings.enabled && notificationSettings.contactSheetComplete) {
        await primeExportNotificationsPermission();
      }

      const sheetCells: ContactSheetRequest['cells'] = [];
      const looks: FrameLook[] = [];
      if (source === 'frames') {
        for (const id of frameIds) {
          const tab = tabsRef.current.find((candidate) => candidate.id === id);
          if (!tab) continue;
          sheetCells.push({ documentId: tab.id, label: tab.document.source.name });
          looks.push(resolveFrameLook(tab, profilesById, fallbackProfile, lightSourceProfilesById));
        }
      } else if (look) {
        const fileLook: FrameLook = { ...look, settings: getBatchEffectiveSettings(look.settings, true), flareFloor: null };
        for (const entry of files) {
          const documentId = `contact-sheet-${entry.id}`;
          await decodeFileEntry(worker, entry, documentId);
          tempIds.push(documentId);
          sheetCells.push({ documentId, label: entry.filename });
          looks.push(fileLook);
        }
      }

      const result = await worker.contactSheet({
        cells: sheetCells,
        columns: layout.columns,
        cellMaxDimension: layout.cellMaxDimension,
        margin: layout.margin,
        backgroundColor: hexToRgb(layout.background),
        showCaptions: layout.showCaptions,
        captionFontSize: layout.captionFontSize,
        exportOptions: {
          format: layout.format,
          bitDepth: 8,
          quality: layout.quality,
          filenameBase: layout.filenameBase.trim() || 'contact_sheet',
          embedMetadata: layout.embedMetadata,
          outputProfileId: layout.outputProfileId,
          embedOutputProfile: layout.embedOutputProfile,
          saveSidecar: false,
          targetMaxDimension: null,
        },
        settingsPerCell: looks.map((cellLook) => structuredClone(cellLook.settings)),
        profilePerCell: looks.map((cellLook) => cellLook.profile),
        colorManagementPerCell: looks.map((cellLook) => ({
          ...cellLook.colorManagement,
          outputProfileId: layout.outputProfileId,
          embedOutputProfile: layout.embedOutputProfile,
        })),
        labStyleToneCurvePerCell: looks.map((cellLook) => cellLook.labStyle?.toneCurve),
        labStyleChannelCurvesPerCell: looks.map((cellLook) => cellLook.labStyle?.channelCurves),
        labTonalCharacterOverridePerCell: looks.map((cellLook) => cellLook.labStyle?.tonalCharacterOverride),
        labSaturationBiasPerCell: looks.map((cellLook) => cellLook.labStyle?.saturationBias ?? 0),
        labTemperatureBiasPerCell: looks.map((cellLook) => cellLook.labStyle?.temperatureBias ?? 0),
        flareFloorPerCell: looks.map((cellLook) => cellLook.flareFloor),
        lightSourceBiasPerCell: looks.map((cellLook) => cellLook.lightSourceBias),
      });

      let saved: 'saved' | 'cancelled';
      if (outputPath) {
        await saveToDirectory(result.blob, result.filename, outputPath);
        saved = 'saved';
      } else {
        saved = await saveExportBlob(result.blob, result.filename, layout.format);
      }
      if (saved === 'saved') {
        if (notificationSettings.enabled && notificationSettings.contactSheetComplete) {
          await notifyExportFinished({ kind: 'contact-sheet', filename: result.filename });
        }
        onSaved(`Saved ${result.filename}${outputPath ? ` to ${outputPath}` : ''}.`);
      }
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : String(generateError));
    } finally {
      await Promise.allSettled(tempIds.map((id) => worker.disposeDocument(id)));
      setIsGenerating(false);
    }
  }, [
    activeLook,
    cells.length,
    fallbackProfile,
    files,
    frameIds,
    isGenerating,
    layout,
    lightSourceProfilesById,
    notificationSettings.contactSheetComplete,
    notificationSettings.enabled,
    onSaved,
    outputPath,
    profilesById,
    source,
    tabsRef,
    workerClientRef,
  ]);

  return {
    layout,
    setLayout,
    source,
    setSource,
    scope,
    setScope,
    selectedCount,
    frameCount: tabs.length,
    files,
    addFiles,
    addFolder,
    addBrowserFiles,
    removeFile,
    clearFiles,
    cells,
    isGenerating,
    error,
    generate,
  };
}
