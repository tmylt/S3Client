import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CachedListing, Entry, FolderStats, Listing } from '../shared/types';
import { mergeEntryStats, parseFolderStats } from '../shared/folder-stats';

export interface CacheScope { id: string; endpoint: string; bucket: string; prefix: string; configHash?: string }
export interface ListingCacheOptions { maxNodes?: number; maxBytes?: number }

interface StoredListing extends Listing { connection: CacheScope; prefix: string; updatedAt: string; pageSize: number; pageIndex: number; nextToken: string | null }
const MAX_NODES = 200;
const MAX_BYTES = 32 * 1024 * 1024;
const serialize = (listings: StoredListing[]) => JSON.stringify({ version: 3, listings });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache metadata.');
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid cache metadata.');
  return value;
}

function directory(value: unknown): string {
  const prefix = text(value);
  if (prefix && !prefix.endsWith('/')) throw new Error('Invalid cache folder prefix.');
  return prefix;
}

function scope(value: unknown): CacheScope {
  const item = object(value);
  const id = text(item.id, 200);
  const endpoint = text(item.endpoint, 4096);
  const bucket = text(item.bucket, 255);
  const configHash = item.configHash === undefined ? undefined : text(item.configHash, 64);
  if (configHash !== undefined && !/^[a-f0-9]{64}$/.test(configHash)) throw new Error('Invalid cache config digest.');
  if (!id || !endpoint || !bucket) throw new Error('Invalid cache connection.');
  return { id, endpoint, bucket, prefix: directory(item.prefix), ...(configHash ? { configHash } : {}) };
}

function timestamp(value: unknown): string {
  const result = text(value, 200);
  if (!Number.isFinite(Date.parse(result))) throw new Error('Invalid cache timestamp.');
  return result;
}

function entries(value: unknown, prefix: string): Entry[] {
  if (!Array.isArray(value)) throw new Error('Invalid cache entries.');
  const keys = new Set<string>();
  return value.map(value => {
    const item = object(value);
    const key = text(item.key);
    const name = text(item.name);
    const kind = item.kind;
    if (!key.startsWith(prefix) || key === prefix || keys.has(key) || (kind !== 'file' && kind !== 'folder')) throw new Error('Invalid cache entry.');
    const relative = key.slice(prefix.length);
    const child = kind === 'folder' ? relative.slice(0, -1) : relative;
    if ((kind === 'folder' && !relative.endsWith('/')) || child.includes('/') || name !== child) throw new Error('Invalid cache entry containment.');
    const size = item.size;
    if (size !== null && (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)) throw new Error('Invalid cache entry size.');
    const modified = item.modified === null ? null : timestamp(item.modified);
    if (kind === 'folder' && (size !== null || modified !== null)) throw new Error('Invalid cache folder metadata.');
    const storageClass = item.storageClass === undefined ? undefined : text(item.storageClass, 1024);
    if (item.stats !== undefined && kind !== 'folder') throw new Error('Invalid cached folder statistics.');
    const stats = item.stats === undefined ? undefined : parseFolderStats(item.stats);
    keys.add(key);
    return { key, name, kind, size, modified, ...(storageClass === undefined ? {} : { storageClass }), ...(stats ? { stats } : {}) };
  });
}

function record(value: unknown, version = 3): StoredListing {
  const item = object(value);
  const connection = scope(item.connection);
  const prefix = directory(item.prefix);
  if (!prefix.startsWith(connection.prefix)) throw new Error('Invalid cache prefix containment.');
  const listed = entries(item.entries, prefix);
  // Legacy records contain the entire folder. Their continuation token cannot
  // be reconstructed, so large records need a fresh first-page request.
  if (version < 3 && listed.length >= 1000) throw new Error('Legacy listing needs pagination.');
  const pageSize = version < 3 ? 1000 : item.pageSize ?? 1000;
  const pageIndex = version < 3 ? 0 : item.pageIndex ?? 0;
  const nextToken = version < 3 ? null : item.nextToken ?? null;
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
    typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 1_000_000 ||
    (nextToken !== null && (typeof nextToken !== 'string' || !nextToken || nextToken.length > 8192 || nextToken.includes('\0')))) throw new Error('Invalid cache page metadata.');
  return { connection, prefix, updatedAt: timestamp(item.updatedAt), entries: listed, pageSize: pageSize as number, pageIndex: pageIndex as number, nextToken: nextToken as string | null };
}

const scopeKey = (connection: CacheScope) => JSON.stringify([connection.id, connection.endpoint, connection.bucket, connection.prefix, connection.configHash ?? '']);

/** A bounded metadata snapshot. No credentials or worker response extras cross this boundary. */
export class ListingCache {
  private readonly file: string;
  private readonly maxNodes: number;
  private readonly maxBytes: number;
  private loaded = false;
  private records: StoredListing[] = [];
  private readonly generations = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string, options: ListingCacheOptions = {}) {
    this.file = join(directory, 'listing-cache.json');
    this.maxNodes = Math.min(MAX_NODES, options.maxNodes ?? MAX_NODES);
    this.maxBytes = Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES);
    if (!Number.isSafeInteger(this.maxNodes) || this.maxNodes < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < Buffer.byteLength(serialize([]))) {
      throw new Error('Invalid listing cache limits.');
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return operation(); });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private bounded(values: StoredListing[]): StoredListing[] {
    // Stable sorting also makes equal timestamps evict in insertion order.
    const next = [...values].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    if (next.length > this.maxNodes) next.splice(0, next.length - this.maxNodes);
    while (Buffer.byteLength(serialize(next)) > this.maxBytes) next.shift();
    return next;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > this.maxBytes) return;
      // One extra byte detects growth while keeping allocation and reads bounded.
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > info.size || (await handle.stat()).size > this.maxBytes) return;
      const data = object(JSON.parse(bytes.subarray(0, count).toString('utf8')));
      if ((data.version !== 1 && data.version !== 2 && data.version !== 3) || !Array.isArray(data.listings)) return;
      const unique = new Map<string, StoredListing>();
      for (const value of data.listings) {
        try {
          const item = record(value, data.version as number);
          // Old decoding could turn spaces into plus signs. Refresh ambiguous
          // folders instead of guessing whether each cached plus was literal.
          if (data.version === 1 && (item.prefix.includes('+') || item.entries.some(entry => entry.key.includes('+')))) continue;
          unique.set(JSON.stringify([item.connection.id, item.prefix, item.pageSize, item.pageIndex]), item);
        } catch { /* A damaged folder must not prevent restoring other valid folders. */ }
      }
      this.records = this.bounded([...unique.values()]);
    } catch { /* Missing, unreadable and corrupt caches all behave as a cache miss. */ }
    finally { await handle?.close().catch(() => undefined); }
  }

  private async persist(records: StoredListing[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(records), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  all(connections: readonly CacheScope[]): Promise<CachedListing[]> {
    return this.serial(async () => {
      const scopes = new Set(connections.map(connection => scopeKey(scope(connection))));
      return this.records.filter(item => scopes.has(scopeKey(item.connection))).map(item => ({
        connectionId: item.connection.id, prefix: item.prefix, updatedAt: item.updatedAt,
        entries: item.entries.map(entry => ({ ...entry, ...(entry.stats ? { stats: { ...entry.stats } } : {}) })),
        ...(item.pageSize === 1000 ? {} : { pageSize: item.pageSize }),
        ...(item.pageIndex === 0 ? {} : { pageIndex: item.pageIndex }),
        ...(item.nextToken === null ? {} : { nextToken: item.nextToken }),
      }));
    });
  }

  version(connectionId: string): number { return this.generations.get(connectionId) ?? 0; }

  put(connection: CacheScope, prefix: string, listing: Listing, version: number, pageSize = 1000, pageIndex = 0): Promise<void> {
    return this.serial(async () => {
      // The check belongs inside the queue: invalidation may happen after enqueueing.
      if (this.version(connection.id) !== version) return;
      const incoming = record({ connection, prefix, entries: object(listing).entries, nextToken: listing.nextToken, pageSize, pageIndex, updatedAt: new Date().toISOString() });
      const previous = this.records.filter(item => scopeKey(item.connection) === scopeKey(incoming.connection)).flatMap(item => item.entries);
      const item = { ...incoming, entries: mergeEntryStats(incoming.entries, previous) };
      const next = this.bounded([
        ...this.records.filter(previous => previous.connection.id !== connection.id || scopeKey(previous.connection) === scopeKey(item.connection) &&
          (previous.prefix !== prefix || previous.pageSize !== pageSize || previous.pageIndex !== pageIndex)),
        item,
      ]);
      await this.persist(next);
      this.records = next;
    });
  }

  putStats(connection: CacheScope, prefix: string, value: FolderStats, version: number): Promise<void> {
    return this.serial(async () => {
      if (this.version(connection.id) !== version) return;
      const currentScope = scope(connection);
      const target = directory(prefix);
      if (!target.startsWith(currentScope.prefix)) throw new Error('Invalid statistics prefix containment.');
      const stats = parseFolderStats(value);
      const next = this.bounded(this.records.map(item => scopeKey(item.connection) !== scopeKey(currentScope) ? item : {
        ...item, entries: item.entries.map(entry => entry.kind === 'folder' && entry.key === target ? mergeEntryStats([{ ...entry, stats }], [entry])[0] : entry),
      }));
      await this.persist(next);
      this.records = next;
    });
  }

  invalidate(connectionId: string): Promise<void> {
    this.generations.set(connectionId, this.version(connectionId) + 1);
    return this.serial(async () => {
      this.records = this.records.filter(item => item.connection.id !== connectionId);
      await this.persist(this.records);
    });
  }
}
