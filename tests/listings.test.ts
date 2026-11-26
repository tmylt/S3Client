import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore, type SecretStorage } from '../src/main/connections';
import { ListingCache } from '../src/main/listing-cache';
import { FolderStatsHistoryStore } from '../src/main/folder-stats-history';
import { ListingService } from '../src/main/listings';
import type { ConnectionInput, Listing } from '../src/shared/types';

const directories: string[] = [];
const settings: ConnectionInput = { name: 'S3', endpoint: 'http://localhost:9000', bucket: 'bucket', prefix: 'root/', region: null, accessKey: 'TEST_AK', secretKey: 'TEST_SK' };
const listing: Listing = { entries: [{ key: 'root/file.txt', name: 'file.txt', kind: 'file', size: 12, modified: null }] };
const crypto = (): SecretStorage => ({ isAvailable: async () => true, encrypt: async value => Buffer.from(value).reverse(), decrypt: vi.fn(async value => Buffer.from(value).reverse().toString()) });
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 's3-listings-')); directories.push(directory);
  const storage = crypto();
  const store = new ConnectionStore(directory, storage);
  const saved = await store.save(settings);
  const cache = new ListingCache(directory);
  const history = new FolderStatsHistoryStore(directory);
  const worker = { list: vi.fn().mockResolvedValue(listing), stats: vi.fn(), search: vi.fn().mockResolvedValue(listing) };
  return { directory, storage, store, saved, cache, history, worker, service: new ListingService(store, cache, worker, history) };
}

describe('persistent listing service', () => {
  it('forwards scoped searches without listing or changing the folder cache', async () => {
    const { service, saved, worker } = await setup();
    expect(await service.search(saved.id, 'root/nested/', 'folder', 'exact', 'file.txt')).toEqual(listing);
    expect(worker.search).toHaveBeenCalledWith(expect.objectContaining({ bucket: saved.bucket }), 'root/nested/', 'folder', 'exact', 'file.txt', 1000, null);
    expect(worker.list).not.toHaveBeenCalled();
    expect((await service.connections()).cachedListings).toEqual([]);
  });
  it('rejects search ranges and match types disabled on the connection', async () => {
    const { service, saved, store, worker } = await setup();
    await store.save({ ...settings, id: saved.id, secretKey: '', searchOptions: { ranges: ['folder'], matches: ['regex'] } });
    await expect(service.search(saved.id, saved.prefix, 'folder', 'regex', '^file')).resolves.toEqual(listing);
    await expect(service.search(saved.id, saved.prefix, 'folder', 'exact', 'file.txt')).rejects.toThrow(/not allowed|disabled/i);
    await expect(service.search(saved.id, saved.prefix, 'recursive', 'regex', '^file')).rejects.toThrow(/not allowed|disabled/i);
    await expect(service.searchUri(saved.id, 'root/file.txt')).rejects.toThrow(/not allowed|disabled/i);
    expect(worker.search).toHaveBeenCalledTimes(1);
  });
  it('validates regex patterns before passing them to the S3 worker', async () => {
    const { service, saved, worker } = await setup();
    await expect(service.search(saved.id, saved.prefix, 'folder', 'regex', '^report-[0-9]+\\.csv$')).resolves.toEqual(listing);
    expect(worker.search).toHaveBeenCalledWith(expect.anything(), saved.prefix, 'folder', 'regex', '^report-[0-9]+\\.csv$', 1000, null);
    await expect(service.search(saved.id, saved.prefix, 'recursive', 'regex', '[')).rejects.toThrow(/regex|regular expression/i);
    expect(worker.search).toHaveBeenCalledTimes(1);
  });
  it('searches an exact full key anywhere inside the connection prefix', async () => {
    const { service, saved, worker } = await setup();
    const key = 'root/elsewhere/a (6)+.db';
    expect(await service.search(saved.id, 'root/nested/', 'key', 'exact', key)).toEqual(listing);
    expect(worker.search).toHaveBeenCalledWith(expect.objectContaining({ prefix: 'root/' }), 'root/nested/', 'key', 'exact', key, 1000, null);
    expect(worker.list).not.toHaveBeenCalled();
    await expect(service.search(saved.id, 'root/nested/', 'key', 'exact', 'outside/a.db')).rejects.toThrow();
    await expect(service.search(saved.id, 'root/nested/', 'key', 'prefix', key)).rejects.toThrow();
    expect(worker.search).toHaveBeenCalledTimes(1);
  });
  it('searches an exact URI key outside the selected connection prefix without listing or changing the cache', async () => {
    const { service, saved, worker } = await setup();
    const key = 'elsewhere/a (6)+.db';
    expect(await service.searchUri(saved.id, key)).toEqual(listing);
    expect(worker.search).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'bucket', prefix: '' }), '', 'key', 'exact', key, 1000, null);
    expect(worker.list).not.toHaveBeenCalled();
    expect((await service.connections()).cachedListings).toEqual([]);
    await expect(service.searchUri(saved.id, 'bad\0key')).rejects.toThrow();
    await expect(service.searchUri(saved.id, 'x'.repeat(1025))).rejects.toThrow();
    expect(worker.search).toHaveBeenCalledTimes(1);
  });
  it('keeps an existing cached scan and each new scan in folder history', async () => {
    const { service, saved, cache, worker } = await setup();
    const old = { fileCount: 2, totalSize: 100, latestModified: '2026-10-28T10:00:00.000Z', updatedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 50 };
    const latest = { fileCount: 3, totalSize: 150, latestModified: '2026-10-27T10:00:00.000Z', updatedAt: new Date().toISOString(), durationMs: 60 };
    const folder = { key: 'root/folder/', name: 'folder', kind: 'folder' as const, size: null, modified: null, stats: old };
    await cache.put(saved, saved.prefix, { entries: [folder] }, cache.version(saved.id));
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([old]);
    expect(worker.stats).not.toHaveBeenCalled();
    worker.stats.mockResolvedValue(latest);
    expect(await service.stats(saved.id, folder.key)).toEqual(latest);
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([old, latest]);
    expect((await service.connections()).cachedListings[0].entries[0].stats).toEqual(latest);
  });
  it('does not restore deleted history points from the cached latest result', async () => {
    const { service, saved, cache, worker } = await setup();
    const latest = { fileCount: 3, totalSize: 150, updatedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 60 };
    const next = { fileCount: 4, totalSize: 200, updatedAt: new Date().toISOString(), durationMs: 70 };
    const folder = { key: 'root/folder/', name: 'folder', kind: 'folder' as const, size: null, modified: null, stats: latest };
    await cache.put(saved, saved.prefix, { entries: [folder] }, cache.version(saved.id));
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([latest]);
    expect(await service.deleteStatsHistoryPoint(saved.id, folder.key, latest)).toEqual([]);
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([]);
    worker.stats.mockResolvedValue(next);
    await service.stats(saved.id, folder.key);
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([next]);
    expect(await service.clearStatsHistory(saved.id, folder.key)).toEqual([]);
    expect(await service.statsHistory(saved.id, folder.key)).toEqual([]);
    expect((await service.connections()).cachedListings[0].entries[0].stats).toEqual(next);
  });
  it('reads saved history without unlocking S3 credentials', async () => {
    const { directory, saved, history, worker } = await setup();
    const point = { fileCount: 2, totalSize: 100, updatedAt: new Date().toISOString(), durationMs: 50 };
    await history.append(saved, 'root/folder/', point);
    const unavailable: SecretStorage = { isAvailable: async () => false, encrypt: async () => { throw new Error('Locked'); }, decrypt: async () => { throw new Error('Locked'); } };
    const locked = new ListingService(new ConnectionStore(directory, unavailable), new ListingCache(directory), worker, new FolderStatsHistoryStore(directory));
    expect(await locked.statsHistory(saved.id, 'root/folder/')).toEqual([point]);
    await expect(locked.statsHistory(saved.id, 'outside/folder/')).rejects.toThrow(/prefix|outside/i);
    expect(worker.stats).not.toHaveBeenCalled();
  });
  it('rejects unsafe search input before sending credentials to the worker', async () => {
    const { service, saved, worker } = await setup();
    await expect(service.search(saved.id, saved.prefix, 'folder', 'exact', 'child/file.txt')).rejects.toThrow();
    await expect(service.search(saved.id, 'other/', 'folder', 'exact', 'file.txt')).rejects.toThrow();
    await expect(service.search(saved.id, saved.prefix, 'folder', 'prefix', 'file', 1001)).rejects.toThrow();
    await expect(service.search(saved.id, saved.prefix, 'page', 'exact', 'file')).rejects.toThrow();
    await expect(service.search(saved.id, saved.prefix, 'folder', 'contains', 'file', 1000, 'next')).rejects.toThrow();
    expect(worker.search).not.toHaveBeenCalled();
  });
  it('requests only the selected page and restores only page one while retaining later-page statistics', async () => {
    const { service, saved, store, worker, cache } = await setup();
    await store.save({ ...settings, id: saved.id, defaultPageSize: 250 });
    const first = { key: 'root/a.txt', name: 'a.txt', kind: 'file' as const, size: 1, modified: null };
    const second = { key: 'root/later/', name: 'later', kind: 'folder' as const, size: null, modified: null };
    worker.list.mockResolvedValueOnce({ entries: [first], nextToken: 'opaque-second' }).mockResolvedValueOnce({ entries: [second], nextToken: null });
    expect(await service.list(saved.id, saved.prefix, 250)).toMatchObject({ entries: [first], nextToken: 'opaque-second' });
    expect(await service.list(saved.id, saved.prefix, 250, 'opaque-second', 1)).toMatchObject({ entries: [second], nextToken: null });
    expect(worker.list.mock.calls).toEqual([
      [expect.objectContaining({ bucket: saved.bucket }), saved.prefix, 250, null],
      [expect.objectContaining({ bucket: saved.bucket }), saved.prefix, 250, 'opaque-second'],
    ]);
    const stats = { fileCount: 4, totalSize: 50, updatedAt: '2026-10-30T12:00:00Z', durationMs: 100 };
    worker.stats.mockResolvedValue(stats);
    await service.stats(saved.id, second.key);
    expect((await cache.all([saved])).find(item => item.pageIndex === 1)?.entries[0].stats).toEqual(stats);
    expect((await service.connections()).cachedListings).toHaveLength(1);
    expect((await service.connections()).cachedListings[0]).toMatchObject({ entries: [first], pageSize: 250, nextToken: 'opaque-second' });
  });
  it('restores only cached first pages matching the configured default size', async () => {
    const { service, saved, worker } = await setup();
    await service.list(saved.id, saved.prefix, 250);
    expect((await service.connections()).cachedListings).toEqual([]);
    expect(worker.list).toHaveBeenCalledTimes(1);
    await service.list(saved.id, saved.prefix, 1000);
    expect((await service.connections()).cachedListings.map(item => item.pageSize ?? 1000)).toEqual([1000]);
    expect(worker.list).toHaveBeenCalledTimes(2);
  });
  it('scans a folder and retains its totals through disk restoration and a normal listing refresh', async () => {
    const { service, saved, worker } = await setup();
    const folder = { key: 'root/folder/', name: 'folder', kind: 'folder', size: null, modified: null };
    const stats = { fileCount: 5, totalSize: 8192, updatedAt: '2026-10-29T10:00:00Z', durationMs: 1500 };
    worker.list.mockResolvedValue({ entries: [folder] });
    worker.stats.mockResolvedValue(stats);
    await service.list(saved.id, saved.prefix);
    expect(await service.stats(saved.id, folder.key)).toEqual(stats);
    expect(worker.stats).toHaveBeenCalledWith(expect.objectContaining({ bucket: saved.bucket }), folder.key);
    expect((await service.connections()).cachedListings[0].entries[0].stats).toEqual(stats);
    expect((await service.list(saved.id, saved.prefix)).entries[0].stats).toEqual(stats);
  });
  it('serves scanned descendant metadata in pages and discards stale saved pages', async () => {
    const { service, saved, worker, cache } = await setup();
    const target = 'root/folder/';
    const old = { key: `${target}old.txt`, name: 'old.txt', kind: 'file' as const, size: 1, modified: null };
    await cache.put(saved, target, { entries: [old] }, cache.version(saved.id));
    await cache.put(saved, `${target}nested/`, { entries: [{ ...old, key: `${target}nested/old.txt` }] }, cache.version(saved.id));
    const stats = { fileCount: 3, totalSize: 12, updatedAt: new Date().toISOString(), durationMs: 1 };
    const objects = [
      { key: `${target}a.txt`, name: 'a.txt', kind: 'file' as const, size: 2, modified: '2026-11-26T01:02:03.000Z' },
      { key: `${target}nested/deep.txt`, name: 'deep.txt', kind: 'file' as const, size: 4, modified: '2026-11-26T01:02:04.000Z' },
      { key: `${target}z.txt`, name: 'z.txt', kind: 'file' as const, size: 6, modified: '2026-11-26T01:02:05.000Z' },
    ];
    worker.stats.mockResolvedValue({ ...stats, objects });
    expect(await service.stats(saved.id, target)).toEqual(stats);
    const first = await service.list(saved.id, target, 2);
    expect(first.entries.map(item => item.key)).toEqual([objects[0].key, `${target}nested/`]);
    expect(first.nextToken).toEqual(expect.any(String));
    const second = await service.list(saved.id, target, 2, first.nextToken, 1);
    expect(second.entries.map(item => item.key)).toEqual([objects[2].key]);
    expect((await service.list(saved.id, `${target}nested/`)).entries).toEqual([objects[1]]);
    expect(worker.list).not.toHaveBeenCalled();
    expect((await cache.all([saved])).filter(item => item.prefix.startsWith(target))).toEqual([]);
  });
  it('calculates current counts and sizes for every subfolder from the parent scan', async () => {
    const { service, saved, worker } = await setup();
    const target = 'root/folder/';
    const stats = { fileCount: 3, totalSize: 9, latestModified: '2026-11-25T15:00:00.000Z', updatedAt: '2026-11-26T01:02:03.000Z', durationMs: 25 };
    worker.stats.mockResolvedValue({ ...stats, objects: [
      { key: `${target}sub/a.txt`, size: 3, modified: '2026-11-25T03:00:00.000Z' },
      { key: `${target}sub/deep/b.txt`, size: 4, modified: '2026-11-25T12:00:00.000Z' },
      { key: `${target}new.txt`, size: 2, modified: stats.latestModified },
      { key: `${target}empty/`, size: 0, modified: null },
    ] });
    await service.stats(saved.id, target);
    const folders = (await service.list(saved.id, target)).entries.filter(item => item.kind === 'folder');
    expect(folders).toEqual([
      { key: `${target}empty/`, name: 'empty', kind: 'folder', size: null, modified: null, stats: { ...stats, fileCount: 0, totalSize: 0, latestModified: null } },
      { key: `${target}sub/`, name: 'sub', kind: 'folder', size: null, modified: null, stats: { ...stats, fileCount: 2, totalSize: 7, latestModified: '2026-11-25T12:00:00.000Z' } },
    ]);
    const deep = (await service.list(saved.id, `${target}sub/`)).entries.find(item => item.key === `${target}sub/deep/`);
    expect(deep?.stats).toEqual({ ...stats, fileCount: 1, totalSize: 4, latestModified: '2026-11-25T12:00:00.000Z' });
    expect(worker.list).not.toHaveBeenCalled();
  });
  it('falls back to a fresh S3 page when a newer subtree scan cannot retain its metadata', async () => {
    const { service, saved, worker } = await setup();
    const stats = { fileCount: 1, totalSize: 2, updatedAt: new Date().toISOString(), durationMs: 1 };
    worker.stats.mockResolvedValueOnce({ ...stats, objects: [{ key: 'root/folder/old.txt', size: 2, modified: null }] })
      .mockResolvedValueOnce({ ...stats, objects: null });
    await service.stats(saved.id, 'root/');
    expect((await service.list(saved.id, 'root/folder/')).entries.map(item => item.name)).toEqual(['old.txt']);
    await service.stats(saved.id, 'root/folder/');
    worker.list.mockResolvedValue({ entries: [{ key: 'root/folder/new.txt', name: 'new.txt', kind: 'file', size: 3, modified: null }] });
    expect((await service.list(saved.id, 'root/folder/')).entries.map(item => item.name)).toEqual(['new.txt']);
    expect(worker.list).toHaveBeenCalledTimes(1);
  });
  it('uses S3 for an explicit refresh after a scan snapshot', async () => {
    const { service, saved, worker } = await setup();
    const stats = { fileCount: 1, totalSize: 2, updatedAt: new Date().toISOString(), durationMs: 1 };
    worker.stats.mockResolvedValue({ ...stats, objects: [{ key: 'root/old.txt', size: 2, modified: null }] });
    await service.stats(saved.id, 'root/');
    worker.list.mockResolvedValue({ entries: [{ key: 'root/new.txt', name: 'new.txt', kind: 'file', size: 3, modified: null }] });
    expect((await service.list(saved.id, 'root/', 1000, null, 0, true)).entries[0].name).toBe('new.txt');
    expect(worker.list).toHaveBeenCalledTimes(1);
  });
  it('does not cache a scan that completes after its connection is edited', async () => {
    const { service, saved, worker } = await setup();
    let resolve!: (value: unknown) => void;
    worker.stats.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = service.stats(saved.id, 'root/folder/');
    await vi.waitFor(() => expect(worker.stats).toHaveBeenCalled());
    await service.save({ ...settings, id: saved.id, name: 'Edited' });
    resolve({ fileCount: 1, totalSize: 1, updatedAt: '2026-10-29T10:00:00Z', durationMs: 1 });
    await pending;
    expect((await service.connections()).cachedListings).toEqual([]);
  });
  it.each(['save', 'remove'] as const)('does not record a scan if %s invalidates the connection while loading older history', async mutation => {
    const { service, saved, worker, history } = await setup();
    const result = { fileCount: 1, totalSize: 1, updatedAt: new Date().toISOString(), durationMs: 1 };
    worker.stats.mockResolvedValue(result);
    let release!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    const seed = vi.spyOn(service, 'statsHistory').mockImplementation(async () => { await waiting; return []; });
    const pending = service.stats(saved.id, 'root/folder/');
    await vi.waitFor(() => expect(seed).toHaveBeenCalledTimes(1));
    if (mutation === 'save') await service.save({ ...settings, id: saved.id, name: 'Edited' });
    else await service.remove(saved.id);
    release();
    await pending;
    expect(await history.list(saved, 'root/folder/')).toEqual([]);
  });
  it('scopes caches to extra Config options using a stable digest without storing option values', async () => {
    const { service, directory, saved, store, worker } = await setup();
    const extraConfig = { s3: { addressing_style: 'virtual' }, user_agent_extra: 'PRIVATE_OPTION_VALUE' };
    await store.save({ ...settings, id: saved.id, extraConfig });
    await service.list(saved.id, saved.prefix);
    expect(worker.list).toHaveBeenCalledWith(expect.objectContaining({ extraConfig }), saved.prefix, 1000, null);
    const disk = await readFile(join(directory, 'listing-cache.json'), 'utf8');
    expect(disk).not.toContain('PRIVATE_OPTION_VALUE');
    expect(JSON.parse(disk).listings[0].connection.configHash).toMatch(/^[a-f0-9]{64}$/);
    await store.save({ ...settings, id: saved.id, extraConfig: { user_agent_extra: 'PRIVATE_OPTION_VALUE', s3: { addressing_style: 'virtual' } } });
    expect((await service.connections()).cachedListings).toHaveLength(1);
    await store.save({ ...settings, id: saved.id, extraConfig: { s3: { addressing_style: 'path' } } });
    expect((await service.connections()).cachedListings).toEqual([]);
  });
  it('restores listings at startup without contacting S3 or decrypting credentials', async () => {
    const { directory, storage, saved, cache, worker } = await setup();
    await cache.put(saved, saved.prefix, listing, cache.version(saved.id));
    const store = new ConnectionStore(directory, storage);
    const getCredentials = vi.spyOn(store, 'forListing');
    const snapshot = await new ListingService(store, new ListingCache(directory), worker, new FolderStatsHistoryStore(directory)).connections();
    expect(snapshot.cachedListings).toEqual([expect.objectContaining({ connectionId: saved.id, prefix: saved.prefix, entries: listing.entries })]);
    expect(worker.list).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
    expect(storage.decrypt).not.toHaveBeenCalled();
  });
  it('persists a successful listing and retains it after a failed refresh', async () => {
    const { service, saved, worker } = await setup();
    expect(await service.list(saved.id, saved.prefix)).toEqual(listing);
    worker.list.mockRejectedValueOnce(new Error('Endpoint unavailable'));
    await expect(service.list(saved.id, saved.prefix)).rejects.toThrow('Endpoint unavailable');
    expect((await service.connections()).cachedListings).toEqual([expect.objectContaining({ entries: listing.entries })]);
  });
  it.each(['save', 'remove'] as const)('discards an in-flight listing after %s invalidates the connection', async mutation => {
    const { service, saved, cache, worker } = await setup();
    let resolve!: (value: Listing) => void;
    worker.list.mockReturnValue(new Promise<Listing>(done => { resolve = done; }));
    const pending = service.list(saved.id, saved.prefix);
    await vi.waitFor(() => expect(worker.list).toHaveBeenCalledTimes(1));
    if (mutation === 'save') await service.save({ ...settings, id: saved.id, name: 'Edited' });
    else await service.remove(saved.id);
    resolve(listing); await pending;
    expect(await cache.all([saved])).toEqual([]);
  });
  it('keeps S3 browsing and startup available if cache disk operations fail', async () => {
    const { service, cache, saved } = await setup();
    vi.spyOn(cache, 'put').mockRejectedValue(new Error('Disk full'));
    vi.spyOn(cache, 'all').mockRejectedValue(new Error('Unreadable cache'));
    expect(await service.list(saved.id, saved.prefix)).toEqual(listing);
    expect((await service.connections()).cachedListings).toEqual([]);
  });
  it('keeps the newest refresh on disk when an older request finishes afterward', async () => {
    const { service, saved, worker } = await setup();
    let old!: (value: Listing) => void;
    let fresh!: (value: Listing) => void;
    worker.list.mockReturnValueOnce(new Promise<Listing>(done => { old = done; })).mockReturnValueOnce(new Promise<Listing>(done => { fresh = done; }));
    const oldRequest = service.list(saved.id, saved.prefix);
    await vi.waitFor(() => expect(worker.list).toHaveBeenCalledTimes(1));
    const newRequest = service.list(saved.id, saved.prefix);
    await vi.waitFor(() => expect(worker.list).toHaveBeenCalledTimes(2));
    const newest: Listing = { entries: [{ ...listing.entries[0], size: 456 }] };
    fresh(newest); await newRequest;
    old(listing); await oldRequest;
    expect((await service.connections()).cachedListings[0].entries).toEqual(newest.entries);
  });
  it('caches independent folder listings concurrently without superseding each other', async () => {
    const { service, saved, worker } = await setup();
    worker.list.mockImplementation(async (_connection, prefix: string) => ({ entries: [{ ...listing.entries[0], key: `${prefix}file.txt` }] }));
    await Promise.all([service.list(saved.id, saved.prefix), service.list(saved.id, 'root/nested/')]);
    expect((await service.connections()).cachedListings.map(item => item.prefix).sort()).toEqual(['root/', 'root/nested/']);
  });
});
