import type { CachedListing, Connection, FolderStats, Listing, RemoteSearchRange, SearchMatch } from '../shared/types';
import { mergeEntryStats } from '../shared/folder-stats';
import { createHash } from 'node:crypto';
import { serializeExtraConfig } from '../shared/extra-config';
import { defaultPageSize } from '../shared/page-size';
import { ConnectionStore, type WorkerConnection } from './connections';
import { ListingCache, type CacheScope } from './listing-cache';

interface Worker {
  list(connection: WorkerConnection, prefix: string, pageSize: number, continuationToken: string | null): Promise<Listing>;
  search(connection: WorkerConnection, prefix: string, range: RemoteSearchRange, match: SearchMatch, name: string, pageSize: number, continuationToken: string | null): Promise<Listing>;
  stats(connection: WorkerConnection, prefix: string): Promise<FolderStats>;
}

function cacheScope(connection: Pick<Connection, 'id' | 'endpoint' | 'bucket' | 'prefix' | 'extraConfig'>): CacheScope {
  const config = serializeExtraConfig(connection.extraConfig);
  return {
    id: connection.id, endpoint: connection.endpoint, bucket: connection.bucket, prefix: connection.prefix,
    ...(config === '{}' ? {} : { configHash: createHash('sha256').update(config).digest('hex') }),
  };
}

/** Persistent metadata is separate from credentials and never triggers S3 on restore. */
export class ListingService {
  private sequence = 0;
  private readonly requests = new Map<string, number>();
  constructor(private readonly store: ConnectionStore, private readonly cache: ListingCache, private readonly worker: Worker) {}

  async connections(): Promise<{ connections: Connection[]; secureStorage: boolean; cachedListings: CachedListing[] }> {
    const settings = await this.store.connections();
    const cached = await this.cache.all(settings.connections.map(cacheScope)).catch(() => []);
    const sizes = new Map(settings.connections.map(connection => [connection.id, connection.defaultPageSize ?? defaultPageSize]));
    const firstPages = new Map<string, CachedListing>();
    for (const item of cached) if (!item.pageIndex && (item.pageSize ?? defaultPageSize) === sizes.get(item.connectionId)) firstPages.set(JSON.stringify([item.connectionId, item.prefix]), item);
    return { ...settings, cachedListings: [...firstPages.values()] };
  }

  async list(id: unknown, prefix: unknown, pageSize: unknown = 1000, continuationToken: unknown = null, pageIndex: unknown = 0): Promise<Listing> {
    if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 1_000_000 ||
      (continuationToken !== null && (typeof continuationToken !== 'string' || !continuationToken || continuationToken.length > 8192)) ||
      (pageIndex === 0) !== (continuationToken === null)) throw new Error('Invalid listing page.');
    const generation = typeof id === 'string' ? this.cache.version(id) : 0;
    const request = await this.store.forListing(id, prefix);
    const key = JSON.stringify([id, request.prefix]);
    const ticket = ++this.sequence;
    this.requests.set(key, ticket);
    try {
      const listing = await this.worker.list(request.connection, request.prefix, pageSize, continuationToken);
      const scope = cacheScope({ id: id as string, ...request.connection });
      const previous = await this.cache.all([scope]).catch(() => []);
      const result = { entries: mergeEntryStats(listing.entries, previous.flatMap(item => item.entries)), ...(listing.nextToken === undefined ? {} : { nextToken: listing.nextToken }) };
      if (this.requests.get(key) === ticket) {
        await this.cache.put(scope, request.prefix, result, generation, pageSize, pageIndex).catch(() => undefined);
      }
      return result;
    } finally {
      if (this.requests.get(key) === ticket) this.requests.delete(key);
    }
  }

  async stats(id: unknown, prefix: unknown): Promise<FolderStats> {
    const generation = typeof id === 'string' ? this.cache.version(id) : 0;
    const request = await this.store.forListing(id, prefix);
    const key = JSON.stringify([id, request.prefix, 'stats']);
    const ticket = ++this.sequence;
    this.requests.set(key, ticket);
    try {
      const result = await this.worker.stats(request.connection, request.prefix);
      if (this.requests.get(key) === ticket) await this.cache.putStats(cacheScope({ id: id as string, ...request.connection }), request.prefix, result, generation).catch(() => undefined);
      return result;
    } finally {
      if (this.requests.get(key) === ticket) this.requests.delete(key);
    }
  }

  async search(id: unknown, prefix: unknown, range: unknown, match: unknown, name: unknown, pageSize: unknown = 1000, continuationToken: unknown = null): Promise<Listing> {
    if (range !== 'folder' && range !== 'recursive' && range !== 'key' || match !== 'exact' && match !== 'prefix' && match !== 'contains' || typeof name !== 'string' || !name || (range !== 'key' && name.includes('/')) || name.includes('\0') || (range === 'key' && match !== 'exact') ||
      typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000 ||
      continuationToken !== null && (range !== 'folder' || match !== 'prefix' || typeof continuationToken !== 'string' || !continuationToken || continuationToken.length > 8192 || continuationToken.includes('\0'))) {
      throw new Error('Invalid search request.');
    }
    const request = await this.store.forListing(id, prefix);
    if (range === 'key' && !name.startsWith(request.connection.prefix)) throw new Error('The S3 key is outside this connection’s prefix.');
    if (Buffer.byteLength(range === 'key' ? name : request.prefix + name, 'utf8') > 1024) throw new Error('The S3 key exceeds 1,024 bytes.');
    return this.worker.search(request.connection, request.prefix, range, match, name, pageSize, continuationToken);
  }

  async searchUri(id: unknown, key: unknown): Promise<Listing> {
    if (typeof key !== 'string' || !key || key.includes('\0') || Buffer.byteLength(key, 'utf8') > 1024) throw new Error('Enter a valid S3 key of at most 1,024 bytes.');
    const { connections } = await this.store.connections();
    const selected = connections.find(connection => connection.id === id);
    if (!selected) throw new Error('This connection no longer exists.');
    const request = await this.store.forListing(id, selected.prefix);
    return this.worker.search({ ...request.connection, prefix: '' }, '', 'key', 'exact', key, 1000, null);
  }

  async save(input: unknown): Promise<Connection> {
    const connection = await this.store.save(input);
    await this.cache.invalidate(connection.id).catch(() => undefined);
    return connection;
  }

  async remove(id: unknown): Promise<void> {
    await this.store.remove(id);
    if (typeof id === 'string') await this.cache.invalidate(id).catch(() => undefined);
  }
}
