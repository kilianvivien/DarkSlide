import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from './constants';

describe('createDefaultSettings', () => {
  it('starts with a full-frame crop so imports are not auto-cropped', () => {
    expect(createDefaultSettings().crop).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      aspectRatio: null,
    });
  });
});
