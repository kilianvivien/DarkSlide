import { DEFAULT_EXPORT_OPTIONS } from '../constants';
import { ColorProfileId } from '../types';

export type ContactSheetCellSize = 256 | 512 | 1024;

/** How the sheet is laid out and written. Shared by the panel and the canvas preview. */
export interface ContactSheetLayout {
  columns: number;
  cellMaxDimension: ContactSheetCellSize;
  margin: number;
  background: string;
  showCaptions: boolean;
  captionFontSize: number;
  format: 'image/jpeg' | 'image/png';
  quality: number;
  filenameBase: string;
  embedMetadata: boolean;
  outputProfileId: ColorProfileId;
  embedOutputProfile: boolean;
}

export const CONTACT_SHEET_MAX_COLUMNS = 8;

export const DEFAULT_CONTACT_SHEET_LAYOUT: ContactSheetLayout = {
  columns: 4,
  cellMaxDimension: 512,
  margin: 16,
  background: '#111111',
  showCaptions: true,
  captionFontSize: 14,
  format: 'image/jpeg',
  quality: 0.92,
  filenameBase: 'contact_sheet',
  embedMetadata: DEFAULT_EXPORT_OPTIONS.embedMetadata,
  outputProfileId: DEFAULT_EXPORT_OPTIONS.outputProfileId,
  embedOutputProfile: DEFAULT_EXPORT_OPTIONS.embedOutputProfile,
};

/** A roughly square grid, capped at four columns. */
export function suggestContactSheetColumns(cellCount: number) {
  return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(Math.max(cellCount, 1)))));
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '').trim();
  const safeHex = normalized.length === 3
    ? normalized.split('').map((char) => `${char}${char}`).join('')
    : normalized.padEnd(6, '0').slice(0, 6);

  return [
    parseInt(safeHex.slice(0, 2), 16),
    parseInt(safeHex.slice(2, 4), 16),
    parseInt(safeHex.slice(4, 6), 16),
  ];
}

/**
 * Pixel geometry of the sheet, matching the worker's compositor so the
 * preview shows exactly what gets written.
 */
export function getContactSheetGeometry(layout: Pick<ContactSheetLayout, 'columns' | 'cellMaxDimension' | 'margin' | 'showCaptions' | 'captionFontSize'>, cellCount: number) {
  const columns = Math.min(CONTACT_SHEET_MAX_COLUMNS, Math.max(1, Math.round(layout.columns)));
  const rows = Math.max(1, Math.ceil(cellCount / columns));
  const captionHeight = layout.showCaptions ? layout.captionFontSize + 8 : 0;
  const width = columns * layout.cellMaxDimension + (columns + 1) * layout.margin;
  const height = rows * (layout.cellMaxDimension + captionHeight) + (rows + 1) * layout.margin;
  const cellOrigin = (index: number) => ({
    x: layout.margin + (index % columns) * (layout.cellMaxDimension + layout.margin),
    y: layout.margin + Math.floor(index / columns) * (layout.cellMaxDimension + captionHeight + layout.margin),
  });
  return { columns, rows, captionHeight, width, height, cellOrigin };
}

/** Caption color the worker picks for a background. */
export function getContactSheetCaptionColor(background: string) {
  const [r, g, b] = hexToRgb(background);
  return r + g + b > 382 ? '#111111' : '#f4f4f5';
}
