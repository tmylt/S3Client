import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListingCache, type CacheScope } from '../src/main/listing-cache';
import type { Entry, Listing } from '../src/shared/types';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 's3-listing-cache-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const scope: CacheScope = { id: 'one', endpoint: 'https://objects.example.com', bucket: 'logs', prefix: 'team/' };
const file = (key = 'team/a.txt'): Entry => ({ key, name: key.slice(key.lastIndexOf('/') + 1), kind: 'file', size: 12, modified: '2026-01-02T00:00:00+00:00', storageClass: 'STANDARD' });
const listing: Listing = { entries: [file()] };
const cachePath = (path: string) => join(path, 'listing-cache.json');

describe('ListingCache', () => {
  it('persists folder statistics, retains them on listing refresh and isolates restored nested values', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const folder: Entry = { key: 'team/folder/', name: 'folder', kind: 'folder', size: null, modified: null };
    const stats = { fileCount: 2, totalSize: 4096, updatedAt: '2026-10-29T10:00:00Z', durationMs: 1200 };
    await cache.put(scope, scope.prefix, { entries: [folder] }, 0);
    await cache.putStats(scope, folder.key, stats, 0);
    await cache.put(scope, scope.prefix, { entries: [folder] }, 0);
    const restored = await new ListingCache(path).all([scope]);
    expect(restored[0].entries[0].stats).toEqual(stats);
    const returned = await cache.all([scope]); returned[0].entries[0].stats!.totalSize = 1;
    expect((await cache.all([scope]))[0].entries[0].stats!.totalSize).toBe(4096);
    await cache.invalidate(scope.id);
    await cache.putStats(scope, folder.key, stats, 0);
    expect(await cache.all([scope])).toEqual([]);
  });
  it('restores successful and empty listings after restart', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    await cache.put(scope, scope.prefix, listing, cache.version(scope.id));
    await cache.put(scope, 'team/empty/', { entries: [] }, cache.version(scope.id));
    const restored = await new ListingCache(path).all([scope]);
    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual({ connectionId: scope.id, prefix: scope.prefix, entries: listing.entries, updatedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(restored[0].updatedAt))).toBe(true);
    expect(restored[1]).toMatchObject({ prefix: 'team/empty/', entries: [] });
  });

  it('discards ambiguous legacy plus keys without changing literal plus in new snapshots', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    await cache.put(scope, scope.prefix, { entries: [file('team/report+(6).db')] }, 0);
    await cache.put(scope, 'team/safe/', { entries: [file('team/safe/keep.txt')] }, 0);
    const snapshot = JSON.parse(await readFile(cachePath(path), 'utf8'));
    expect(snapshot.version).toBe(3);
    expect((await new ListingCache(path).all([scope]))[0].entries[0].key).toBe('team/report+(6).db');
    await writeFile(cachePath(path), JSON.stringify({ ...snapshot, version: 1 }));
    expect(await new ListingCache(path).all([scope])).toEqual([expect.objectContaining({ prefix: 'team/safe/' })]);
  });

  it('restores small legacy folders but discards a full legacy listing without a continuation token', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    await cache.put(scope, 'team/large/', { entries: Array.from({ length: 1000 }, (_, index) => file(`team/large/item${index}.txt`)) }, 0);
    await cache.put(scope, 'team/small/', { entries: [file('team/small/keep.txt')] }, 0);
    const snapshot = JSON.parse(await readFile(cachePath(path), 'utf8'));
    await writeFile(cachePath(path), JSON.stringify({ ...snapshot, version: 2 }));
    expect(await new ListingCache(path).all([scope])).toEqual([expect.objectContaining({ prefix: 'team/small/' })]);
  });

  it('matches identity, endpoint, bucket and raw configured root, independently of other connection fields', async () => {
    const cache = new ListingCache(await directory());
    await cache.put(scope, scope.prefix, listing, 0);
    for (const changed of [{ id: 'copy' }, { endpoint: 'https://other.example.com' }, { bucket: 'other' }, { prefix: 'team/a/' }, { prefix: 'team//' }]) {
      expect(await cache.all([{ ...scope, ...changed }])).toEqual([]);
    }
    expect(await cache.all([])).toEqual([]);
    const decorated = { ...scope, region: null, name: 'Renamed', hasCredentials: false };
    expect(await cache.all([decorated])).toHaveLength(1);
  });

  it('preserves raw key syntax and empty folder names without path normalization or URL decoding', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const raw = { ...scope, prefix: '/team//../%2F\\?x#z/' };
    const entries: Entry[] = [file(`${raw.prefix}a%2Fb\\c`), { key: `${raw.prefix}/`, name: '', kind: 'folder', size: null, modified: null }, { key: `${raw.prefix}../`, name: '..', kind: 'folder', size: null, modified: null }];
    await cache.put(raw, raw.prefix, { entries }, 0);
    expect((await new ListingCache(path).all([raw]))[0].entries).toEqual(entries);
  });

  it('rejects outside, non-directory prefixes and entries that are not immediate children', async () => {
    const cache = new ListingCache(await directory());
    for (const prefix of ['teammate/', 'team', '', 'team/child']) {
      await expect(cache.put(scope, prefix, { entries: [] }, 0)).rejects.toThrow(/invalid|prefix/i);
    }
    const invalid: Entry[] = [file('teammate/a.txt'), file('team/a/b.txt'), file('team/'), { ...file(), name: 'wrong' }, { ...file(), key: 'team/a/', kind: 'file' }, { ...file(), kind: 'folder' }, { ...file(), size: -1 }, { ...file(), size: Number.NaN }, { ...file(), modified: 'not a date' }];
    for (const entry of invalid) await expect(cache.put(scope, scope.prefix, { entries: [entry] }, 0)).rejects.toThrow(/invalid|entry/i);
    expect(await cache.all([scope])).toEqual([]);
  });

  it('falls back to empty for absent, corrupt, unsupported and malformed snapshots', async () => {
    const path = await directory();
    expect(await new ListingCache(path).all([scope])).toEqual([]);
    for (const raw of ['broken JSON', 'null', '[]', '{"version":3,"listings":[]}', '{"version":1,"listings":{}}', '{"version":1,"listings":[null]}']) {
      await writeFile(cachePath(path), raw);
      expect(await new ListingCache(path).all([scope])).toEqual([]);
    }
  });

  it('validates persisted entry containment and record timestamps before restoration', async () => {
    const path = await directory();
    await new ListingCache(path).put(scope, scope.prefix, listing, 0);
    const original = JSON.parse(await readFile(cachePath(path), 'utf8'));
    for (const change of [(value: typeof original) => { value.listings[0].entries[0].key = 'other/secret.txt'; }, (value: typeof original) => { value.listings[0].updatedAt = 'invalid'; }, (value: typeof original) => { value.listings[0].prefix = 'teammate/'; }]) {
      const value = structuredClone(original);
      change(value);
      await writeFile(cachePath(path), JSON.stringify(value));
      expect(await new ListingCache(path).all([scope])).toEqual([]);
    }
  });

  it('persists only explicit metadata fields and returns independent clean copies', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const decoratedScope = { ...scope, accessKey: 'SECRET_AK', secretKey: 'SECRET_SK', sessionToken: 'SECRET_TOKEN' };
    const decoratedListing = { entries: [{ ...file(), body: 'PRIVATE_BODY', secretKey: 'ENTRY_SECRET' }], credentials: 'LISTING_SECRET' };
    await cache.put(decoratedScope, scope.prefix, decoratedListing, 0);
    const disk = await readFile(cachePath(path), 'utf8');
    for (const secret of ['SECRET_AK', 'SECRET_SK', 'SECRET_TOKEN', 'PRIVATE_BODY', 'ENTRY_SECRET', 'LISTING_SECRET']) expect(disk).not.toContain(secret);
    const restored = await cache.all([scope]);
    restored[0].entries[0].name = 'poisoned';
    restored[0].entries.push(file('team/injected'));
    restored[0].prefix = 'other/';
    expect((await cache.all([scope]))[0]).toMatchObject({ prefix: scope.prefix, entries: listing.entries });
    const persisted = JSON.parse(disk);
    persisted.listings[0].entries[0].extra = 'PRIVATE_PERSISTED_FIELD';
    persisted.listings[0].extra = 'PRIVATE_RECORD_FIELD';
    await writeFile(cachePath(path), JSON.stringify(persisted));
    const clean = (await new ListingCache(path).all([scope]))[0];
    expect(JSON.stringify(clean)).not.toContain('PRIVATE_');
  });

  it('uses private permissions and leaves no temporary snapshots', async () => {
    const path = await directory();
    await chmod(path, 0o755);
    await new ListingCache(path).put(scope, scope.prefix, listing, 0);
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(cachePath(path))).mode & 0o777).toBe(0o600);
    expect(await readdir(path)).toEqual(['listing-cache.json']);
  });

  it('serializes concurrent folder updates into complete atomic snapshots', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const prefixes = Array.from({ length: 30 }, (_, index) => `team/${index}/`);
    await Promise.all(prefixes.map(prefix => cache.put(scope, prefix, { entries: [] }, 0)));
    expect((await new ListingCache(path).all([scope])).map(item => item.prefix)).toEqual(prefixes);
    expect(JSON.parse(await readFile(cachePath(path), 'utf8')).listings).toHaveLength(prefixes.length);
    expect(await readdir(path)).toEqual(['listing-cache.json']);
  });

  it('increments mutation generations synchronously and drops stale writes queued before invalidation', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const old = cache.version(scope.id);
    // This was current when enqueued, but must be skipped before validation once invalidated.
    const pending = cache.put(scope, 'teammate/', listing, old);
    const invalidated = cache.invalidate(scope.id);
    expect(cache.version(scope.id)).toBe(old + 1);
    await Promise.all([pending, invalidated]);
    await cache.put(scope, 'team/stale/', { entries: [] }, old);
    expect(await new ListingCache(path).all([scope])).toEqual([]);
    await cache.put(scope, 'team/current/', { entries: [] }, cache.version(scope.id));
    expect((await cache.all([scope])).map(item => item.prefix)).toEqual(['team/current/']);
  });

  it('invalidates only the selected connection and persists removal across restarts', async () => {
    const path = await directory();
    const cache = new ListingCache(path);
    const other = { ...scope, id: 'two' };
    await cache.put(scope, scope.prefix, listing, 0);
    await cache.put(other, scope.prefix, listing, 0);
    await cache.invalidate(scope.id);
    expect(cache.version(other.id)).toBe(0);
    expect((await new ListingCache(path).all([scope, other])).map(item => item.connectionId)).toEqual([other.id]);
  });

  it('evicts the oldest folders when the node budget is exceeded', async () => {
    const path = await directory();
    const cache = new ListingCache(path, { maxNodes: 2 });
    for (const prefix of ['team/old/', 'team/middle/', 'team/new/']) await cache.put(scope, prefix, { entries: [] }, 0);
    expect((await new ListingCache(path).all([scope])).map(item => item.prefix)).toEqual(['team/middle/', 'team/new/']);
  });

  it('bounds serialized bytes and safely skips a listing larger than the entire budget', async () => {
    const path = await directory();
    const cache = new ListingCache(path, { maxBytes: 600 });
    for (const prefix of ['team/old/', 'team/new/']) await cache.put(scope, prefix, { entries: [file(`${prefix}a.txt`)] }, 0);
    expect((await stat(cachePath(path))).size).toBeLessThanOrEqual(600);
    expect((await cache.all([scope])).map(item => item.prefix)).toEqual(['team/new/']);
    await cache.put(scope, 'team/large/', { entries: [file(`team/large/${'x'.repeat(1000)}`)] }, 0);
    expect((await stat(cachePath(path))).size).toBeLessThanOrEqual(600);
  });

  it('reads an oversized disk cache as empty and recovers on the next successful write', async () => {
    const path = await directory();
    await writeFile(cachePath(path), ' '.repeat(1025));
    const cache = new ListingCache(path, { maxBytes: 1024 });
    expect(await cache.all([scope])).toEqual([]);
    await cache.put(scope, scope.prefix, listing, 0);
    expect(await new ListingCache(path).all([scope])).toHaveLength(1);
  });
});
