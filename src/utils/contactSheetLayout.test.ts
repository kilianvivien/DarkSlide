import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTACT_SHEET_LAYOUT, getContactSheetCaptionColor, getContactSheetGeometry, hexToRgb, suggestContactSheetColumns } from './contactSheetLayout';

describe('contact sheet layout', () => {
  it('matches the worker compositor geometry', () => {
    const geometry = getContactSheetGeometry({ ...DEFAULT_CONTACT_SHEET_LAYOUT, columns: 3, cellMaxDimension: 256, margin: 10, captionFontSize: 12 }, 7);
    expect(geometry.rows).toBe(3);
    expect(geometry.captionHeight).toBe(20);
    expect(geometry.width).toBe(3 * 256 + 4 * 10);
    expect(geometry.height).toBe(3 * (256 + 20) + 4 * 10);
    expect(geometry.cellOrigin(4)).toEqual({ x: 10 + 266, y: 10 + 286 });
  });

  it('drops the caption band when captions are off and clamps columns', () => {
    const geometry = getContactSheetGeometry({ ...DEFAULT_CONTACT_SHEET_LAYOUT, columns: 12, showCaptions: false }, 4);
    expect(geometry.columns).toBe(8);
    expect(geometry.captionHeight).toBe(0);
  });

  it('suggests a roughly square grid up to four columns', () => {
    expect(suggestContactSheetColumns(1)).toBe(1);
    expect(suggestContactSheetColumns(4)).toBe(2);
    expect(suggestContactSheetColumns(36)).toBe(4);
  });

  it('picks a readable caption color for the background', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(getContactSheetCaptionColor('#ffffff')).toBe('#111111');
    expect(getContactSheetCaptionColor('#111111')).toBe('#f4f4f5');
  });
});
