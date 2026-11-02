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
  it('sorts naturally with folders first in both directions and filters by name', () => {
    const entries: Entry[] = [file('file10.txt', 10), file('file2.txt', 2), { ...file('z-folder'), kind: 'folder' }];
    expect(getVisibleEntries(entries, '', 'name', 'asc').map(x => x.name)).toEqual(['z-folder', 'file2.txt', 'file10.txt']);
    expect(getVisibleEntries(entries, '', 'size', 'desc').map(x => x.name)).toEqual(['z-folder', 'file10.txt', 'file2.txt']);
    expect(getVisibleEntries(entries, 'FILE2', 'name', 'asc').map(x => x.name)).toEqual(['file2.txt']);
    expect(getVisibleEntries(entries, 'file', 'name', 'asc', 'prefix').map(x => x.name)).toEqual(['file2.txt', 'file10.txt']);
    expect(getVisibleEntries(entries, 'file2.txt', 'name', 'asc', 'exact').map(x => x.name)).toEqual(['file2.txt']);
    expect(getVisibleEntries(entries, 'FILE2', 'name', 'asc', 'exact')).toEqual([]);
    expect(entries[0].name).toBe('file10.txt');
  });

  it('formats zero-byte files separately from folders and supports large sizes', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 5)).toBe('1 PB');
  });
});
