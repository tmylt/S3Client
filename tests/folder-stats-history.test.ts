import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FolderStatsHistoryStore } from '../src/main/folder-stats-history';
import type { CacheScope } from '../src/main/listing-cache';
import type { FolderStats } from '../src/shared/types';

const directories: string[] = [];
const scope: CacheScope = { id: 'one', endpoint: 'https://objects.example.com', bucket: 'logs', prefix: 'team/' };
const snapshot = (updatedAt: string, fileCount: number, totalSize: number): FolderStats => ({ updatedAt, fileCount, totalSize, durationMs: 1200 });
const now = Date.parse('2026-11-13T12:00:00Z');
async function directory() { const path = await mkdtemp(join(tmpdir(), 's3-stats-history-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('folder statistics history', () => {
  it('deletes one scan and keeps a cleared folder distinct from a folder never recorded', async () => {
    const path = await directory();
    const history = new FolderStatsHistoryStore(path, () => now);
    const first = snapshot('2026-11-12T10:00:00Z', 2, 100);
    const latest = snapshot('2026-11-13T10:00:00Z', 3, 150);
    expect(await history.read(scope, 'team/folder/')).toBeNull();
    await history.append(scope, 'team/folder/', first);
    await history.append(scope, 'team/folder/', latest);
    await history.append(scope, 'team/other/', first);
    expect(await history.deletePoint(scope, 'team/folder/', latest)).toEqual([first]);
    await expect(history.deletePoint(scope, 'team/folder/', latest)).rejects.toThrow(/no longer exists/i);
    expect(await history.clearFolder(scope, 'team/folder/')).toEqual([]);
    expect(await history.seedIfMissing(scope, 'team/folder/', first)).toEqual([]);
    const restored = new FolderStatsHistoryStore(path, () => now);
    expect(await restored.read(scope, 'team/folder/')).toEqual([]);
    expect(await restored.list(scope, 'team/other/')).toEqual([first]);
    expect(await restored.seedIfMissing(scope, 'team/new/', first)).toEqual([first]);
    await restored.append(scope, 'team/folder/', latest);
    expect(await restored.read(scope, 'team/folder/')).toEqual([latest]);
  });

  it('does not return expired scans after deleting the newest point', async () => {
    let clock = now;
    const history = new FolderStatsHistoryStore(await directory(), () => clock);
    const expired = snapshot(new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString(), 1, 10);
    const recent = snapshot(new Date(now - 24 * 60 * 60 * 1000).toISOString(), 2, 20);
    await history.append(scope, 'team/folder/', expired);
    await history.append(scope, 'team/folder/', recent);
    clock += 2 * 24 * 60 * 60 * 1000;
    expect(await history.deletePoint(scope, 'team/folder/', recent)).toEqual([]);
    expect(await history.list(scope, 'team/folder/')).toEqual([]);
  });

  it('persists each completed scan and isolates returned values', async () => {
    const path = await directory();
    const history = new FolderStatsHistoryStore(path, () => now);
    const first = snapshot('2026-11-12T10:00:00Z', 2, 100);
    const second = snapshot('2026-11-13T10:00:00Z', 3, 150);
    await history.append(scope, 'team/folder/', first);
    await history.append(scope, 'team/folder/', second);
    await history.append(scope, 'team/folder/', second);
    expect(await new FolderStatsHistoryStore(path, () => now).list(scope, 'team/folder/')).toEqual([first, second]);
    const returned = await history.list(scope, 'team/folder/');
    returned[0].totalSize = 0;
    expect(await history.list(scope, 'team/folder/')).toEqual([first, second]);
  });

  it('reads history files saved before scan deletion was available', async () => {
    const path = await directory();
    const point = snapshot('2026-11-12T10:00:00Z', 2, 100);
    await writeFile(join(path, 'folder-stats-history.json'), JSON.stringify({ version: 1, histories: [{ connection: scope, prefix: 'team/folder/', points: [point] }] }));
    const history = new FolderStatsHistoryStore(path, () => now);
    expect(await history.list(scope, 'team/folder/')).toEqual([point]);
    expect(await history.deletePoint(scope, 'team/folder/', point)).toEqual([]);
  });

  it('keeps only the last 30 days and separates folders and connection settings', async () => {
    const path = await directory();
    let clock = now;
    const history = new FolderStatsHistoryStore(path, () => clock);
    const old = snapshot('2026-10-13T11:59:59Z', 1, 1);
    const recent = snapshot('2026-10-15T12:00:00Z', 2, 2);
    await history.append(scope, 'team/folder/', old);
    await history.append(scope, 'team/folder/', recent);
    expect(await history.list(scope, 'team/folder/')).toEqual([recent]);
    expect(await history.list(scope, 'team/other/')).toEqual([]);
    expect(await history.list({ ...scope, bucket: 'other' }, 'team/folder/')).toEqual([]);
    expect(await history.list({ ...scope, endpoint: 'https://new.example.com' }, 'team/folder/')).toEqual([]);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(await history.list(scope, 'team/folder/')).toEqual([]);
  });

  it('removes history for a deleted connection and rejects a path outside its root', async () => {
    const history = new FolderStatsHistoryStore(await directory(), () => now);
    await expect(history.append(scope, 'teammate/folder/', snapshot('2026-11-12T10:00:00Z', 1, 1))).rejects.toThrow(/prefix|folder/i);
    await history.append(scope, 'team/folder/', snapshot('2026-11-12T10:00:00Z', 1, 1));
    await history.removeConnection(scope.id);
    expect(await history.list(scope, 'team/folder/')).toEqual([]);
  });
});
