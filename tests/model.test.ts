import { describe, expect, it } from 'vitest';
import { breadcrumbs, formatBytes, getVisibleEntries, initialHistory, moveHistory, navigateHistory, nodeKey, parentPrefix } from '../src/renderer/src/model';
import type { Entry } from '../src/shared/types';

const file = (name: string, size = 0): Entry => ({ key: name, name, kind: 'file', size, modified: null });

describe('S3 navigation', () => {
  it('keeps the configured root and unusual key segments intact', () => {
    expect(breadcrumbs('base/', 'base/a//../')).toEqual([
      { name: 'a', prefix: 'base/a/' },
      { name: '(empty name)', prefix: 'base/a//' },
      { name: '..', prefix: 'base/a//../' },
    ]);
    expect(parentPrefix('base/', 'base/a//../')).toBe('base/a//');
    expect(parentPrefix('base/', 'base/')).toBeNull();
    expect(parentPrefix('', 'a/')).toBe('');
    expect(breadcrumbs('base/', 'baseball/')).toEqual([]);
  });

  it('branches history after navigating back', () => {
    const a = { connectionId: 'a', prefix: '' };
    const b = { connectionId: 'a', prefix: 'b/' };
    const c = { connectionId: 'a', prefix: 'c/' };
    let history = navigateHistory(initialHistory, a);
    history = navigateHistory(history, b);
    history = moveHistory(history, -1);
    history = navigateHistory(history, c);
    expect(history).toEqual({ entries: [a, c], index: 1 });
    expect(navigateHistory(history, c)).toBe(history);
    expect(moveHistory(history, 1)).toBe(history);
  });

  it('uses unambiguous cache keys', () => {
    expect(nodeKey('a:b', 'c')).not.toBe(nodeKey('a', 'b:c'));
  });
});

describe('file list', () => {
  it('sorts names and kinds across files and folders, and puts folders last for size and date', () => {
    const entries: Entry[] = [
      { ...file('z-folder'), kind: 'folder', stats: { totalSize: 1, fileCount: 1, updatedAt: '2026-01-03T00:00:00Z', durationMs: 1 } },
      { ...file('b.txt', 20), modified: '2026-01-01T00:00:00Z' },
      { ...file('a-folder'), kind: 'folder', stats: { totalSize: 100, fileCount: 1, updatedAt: '2026-01-01T00:00:00Z', durationMs: 1 } },
      { ...file('a.txt', 10), modified: '2026-01-02T00:00:00Z' },
    ];
    expect(getVisibleEntries(entries, '', 'name', 'asc').map(item => item.name)).toEqual(['a-folder', 'a.txt', 'b.txt', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'name', 'desc').map(item => item.name)).toEqual(['z-folder', 'b.txt', 'a.txt', 'a-folder']);
    expect(getVisibleEntries(entries, '', 'size', 'asc').map(item => item.name)).toEqual(['a.txt', 'b.txt', 'a-folder', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'size', 'desc').map(item => item.name)).toEqual(['b.txt', 'a.txt', 'a-folder', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'modified', 'asc').map(item => item.name)).toEqual(['b.txt', 'a.txt', 'a-folder', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'modified', 'desc').map(item => item.name)).toEqual(['a.txt', 'b.txt', 'a-folder', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'kind', 'asc').map(item => item.name)).toEqual(['a-folder', 'z-folder', 'a.txt', 'b.txt']);
    expect(getVisibleEntries(entries, '', 'kind', 'desc').map(item => item.name)).toEqual(['b.txt', 'a.txt', 'z-folder', 'a-folder']);
  });

  it('sorts names naturally, places folders last for size, and filters by name', () => {
    const entries: Entry[] = [file('file10.txt', 10), file('file2.txt', 2), { ...file('z-folder'), kind: 'folder' }];
    expect(getVisibleEntries(entries, '', 'name', 'asc').map(x => x.name)).toEqual(['file2.txt', 'file10.txt', 'z-folder']);
    expect(getVisibleEntries(entries, '', 'size', 'desc').map(x => x.name)).toEqual(['file10.txt', 'file2.txt', 'z-folder']);
    expect(getVisibleEntries(entries, 'FILE2', 'name', 'asc').map(x => x.name)).toEqual(['file2.txt']);
    expect(getVisibleEntries(entries, 'file', 'name', 'asc', 'prefix').map(x => x.name)).toEqual(['file2.txt', 'file10.txt']);
    expect(getVisibleEntries(entries, 'file2.txt', 'name', 'asc', 'exact').map(x => x.name)).toEqual(['file2.txt']);
    expect(getVisibleEntries(entries, 'FILE2', 'name', 'asc', 'exact')).toEqual([]);
    expect(entries[0].name).toBe('file10.txt');
  });
  it('sorts scanned folders by their latest file modification and leaves unscanned folders last', () => {
    const entries: Entry[] = [
      { ...file('unscanned/'), kind: 'folder', modified: null },
      { ...file('scanned/'), kind: 'folder', modified: null, stats: { fileCount: 1, totalSize: 1, updatedAt: '2026-01-10T00:00:00Z', durationMs: 1, latestModified: '2026-01-02T00:00:00Z' } },
      { ...file('older.txt'), modified: '2026-01-01T00:00:00Z' },
      { ...file('newer.txt'), modified: '2026-01-03T00:00:00Z' },
    ];
    expect(getVisibleEntries(entries, '', 'modified', 'asc').map(item => item.name)).toEqual(['older.txt', 'scanned/', 'newer.txt', 'unscanned/']);
    expect(getVisibleEntries(entries, '', 'modified', 'desc').map(item => item.name)).toEqual(['newer.txt', 'scanned/', 'older.txt', 'unscanned/']);
  });

  it('matches JavaScript regex patterns against names on the loaded page', () => {
    const entries = [file('report-1.csv'), file('report-2.CSV'), file('report-10.csv'), file('notes.csv')];
    expect(getVisibleEntries(entries, '^report-[0-9]+\\.csv$', 'name', 'asc', 'regex').map(item => item.name)).toEqual(['report-1.csv', 'report-10.csv']);
    expect(getVisibleEntries(entries, '[', 'name', 'asc', 'regex')).toEqual([]);
  });

  it('formats zero-byte files separately from folders and supports large sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 5)).toBe('1 PB');
  });
});
