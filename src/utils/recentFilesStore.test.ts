import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addRecentFile, clearRecentFiles, loadRecentFiles } from './recentFilesStore';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('loadRecentFiles', () => {
  it('returns [] when localStorage is empty', () => {
    expect(loadRecentFiles()).toEqual([]);
  });

  it('returns [] for corrupt JSON', () => {
    localStorage.setItem('darkslide_recent_files_v1', 'not-json{{{');
    expect(loadRecentFiles()).toEqual([]);
  });

  it('returns [] for wrong version', () => {
    localStorage.setItem('darkslide_recent_files_v1', JSON.stringify({ version: 2, entries: [] }));
    expect(loadRecentFiles()).toEqual([]);
  });

  it('filters out entries missing required fields', () => {
    localStorage.setItem('darkslide_recent_files_v1', JSON.stringify({
      version: 1,
      entries: [
        { name: 'good.tif', path: null, size: 100, timestamp: 1000 },
        { path: null, size: 100, timestamp: 1000 },  // missing name
        { name: 'bad.tif' },                          // missing size + timestamp
      ],
    }));
    const loaded = loadRecentFiles();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('good.tif');
  });

  it('limits loaded entries to the latest 5', () => {
    localStorage.setItem('darkslide_recent_files_v1', JSON.stringify({
      version: 1,
      entries: Array.from({ length: 7 }, (_, index) => ({
        name: `file-${index}.tif`,
        path: null,
        size: 1000,
        timestamp: 1000 - index,
      })),
    }));

    const loaded = loadRecentFiles();
    expect(loaded).toHaveLength(5);
    expect(loaded.map((entry) => entry.name)).toEqual([
      'file-0.tif',
      'file-1.tif',
      'file-2.tif',
      'file-3.tif',
      'file-4.tif',
    ]);
  });
});

describe('addRecentFile', () => {
  it('adds an entry with the current timestamp', () => {
    const before = Date.now();
    addRecentFile({ name: 'photo.tif', path: null, size: 5_000_000 });
    const after = Date.now();

    const entries = loadRecentFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('photo.tif');
    expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(entries[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('prepends new entries (newest first)', () => {
    addRecentFile({ name: 'first.tif', path: null, size: 1000 });
    addRecentFile({ name: 'second.tif', path: null, size: 2000 });

    const entries = loadRecentFiles();
    expect(entries[0].name).toBe('second.tif');
    expect(entries[1].name).toBe('first.tif');
  });

  it('deduplicates by path when path is non-null', () => {
    addRecentFile({ name: 'photo.tif', path: '/photos/photo.tif', size: 1000 });
    addRecentFile({ name: 'photo.tif', path: '/photos/photo.tif', size: 1000 });

    expect(loadRecentFiles()).toHaveLength(1);
  });

  it('deduplicates by name when path is null', () => {
    addRecentFile({ name: 'photo.tif', path: null, size: 1000 });
    addRecentFile({ name: 'photo.tif', path: null, size: 1000 });

    expect(loadRecentFiles()).toHaveLength(1);
  });

  it('does not deduplicate when both path and name differ', () => {
    addRecentFile({ name: 'a.tif', path: '/a.tif', size: 1000 });
    addRecentFile({ name: 'b.tif', path: '/b.tif', size: 1000 });

    expect(loadRecentFiles()).toHaveLength(2);
  });

  it('caps at 5 entries', () => {
    for (let i = 0; i < 15; i++) {
      addRecentFile({ name: `file-${i}.tif`, path: null, size: 1000 });
    }
    expect(loadRecentFiles()).toHaveLength(5);
  });

  it('keeps the most recent entry when deduplicating', () => {
    addRecentFile({ name: 'old.tif', path: null, size: 1000 });
    const before = Date.now();
    addRecentFile({ name: 'old.tif', path: null, size: 2000 }); // same name, different size
    const after = Date.now();

    const entries = loadRecentFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(2000);
    expect(entries[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(entries[0].timestamp).toBeLessThanOrEqual(after);
  });
});

describe('clearRecentFiles', () => {
  it('removes all entries', () => {
    addRecentFile({ name: 'photo.tif', path: null, size: 1000 });
    addRecentFile({ name: 'photo2.tif', path: null, size: 2000 });

    clearRecentFiles();
    expect(loadRecentFiles()).toEqual([]);
  });

  it('is safe to call when already empty', () => {
    expect(() => clearRecentFiles()).not.toThrow();
    expect(loadRecentFiles()).toEqual([]);
  });
});
