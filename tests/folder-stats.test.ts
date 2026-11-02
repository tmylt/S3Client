import { describe, expect, it } from 'vitest';
import { mergeEntryStats, parseFolderStats, formatDuration } from '../src/shared/folder-stats';
import type { Entry, FolderStats } from '../src/shared/types';

const stats: FolderStats = { fileCount: 12, totalSize: 4096, updatedAt: '2026-10-29T09:00:00Z', durationMs: 1250 };
const folder: Entry = { key: 'folder/', name: 'folder', kind: 'folder', size: null, modified: null };

describe('folder statistics metadata', () => {
  it('accepts complete and empty scan results and strips extras', () => {
    expect(parseFolderStats({ ...stats, ignored: 'private' })).toEqual(stats);
    expect(parseFolderStats({ ...stats, fileCount: 0, totalSize: 0, durationMs: 0 })).toMatchObject({ fileCount: 0, totalSize: 0 });
  });
  it('rejects invalid and imprecise counts or timestamps', () => {
    for (const invalid of [{ fileCount: -1 }, { totalSize: Infinity }, { fileCount: 1.2 }, { totalSize: Number.MAX_SAFE_INTEGER + 1 }, { updatedAt: 'invalid' }, { durationMs: -1 }]) {
      expect(() => parseFolderStats({ ...stats, ...invalid })).toThrow(/statistics/i);
    }
  });
  it('retains the most recent folder result during ordinary listing refresh without mutating input', () => {
    const old = { ...stats, updatedAt: '2026-10-28T09:00:00Z', totalSize: 1 };
    const previous = [{ ...folder, stats }];
    expect(mergeEntryStats([{ ...folder, stats: old }], previous)[0].stats).toEqual(stats);
    expect(mergeEntryStats([folder], previous)[0].stats).toEqual(stats);
    expect(folder).not.toHaveProperty('stats');
    expect(formatDuration(1250)).toBe('1.3 s');
  });
});
