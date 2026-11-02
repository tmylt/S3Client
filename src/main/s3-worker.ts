import { HeadObjectCommand, ListObjectsV2Command, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import type { Entry, FolderStats, Listing, RemoteSearchRange, SearchMatch } from '../shared/types';
import type { WorkerConnection } from './connections';
import { assertPrefix, connectionRoot, createS3Client, decodeKey, safeS3Error } from './s3-client';

const maxActiveStats = 4;
const statsBusyMessage = 'Four folder statistics scans are already running. Wait for one to finish, then refresh this row.';
const validPage = (value: number) => Number.isInteger(value) && value >= 1 && value <= 1000;
const validToken = (value: string | null) => value === null || !!value && value.length <= 8192 && !value.includes('\0');
const matches = (candidate: string, name: string, match: SearchMatch) => match === 'exact' ? candidate === name : match === 'prefix' ? candidate.startsWith(name) : candidate.includes(name);

function listingPage(page: ListObjectsV2CommandOutput, prefix: string): Listing {
  const entries = new Map<string, Entry>();
  for (const item of page.CommonPrefixes ?? []) {
    if (!item.Prefix) continue;
    const key = decodeKey(item.Prefix);
    const relative = key.slice(prefix.length);
    if (key.startsWith(prefix) && relative.endsWith('/') && relative && !relative.slice(0, -1).includes('/'))
      entries.set(key, { key, name: relative.slice(0, -1), kind: 'folder', size: null, modified: null });
  }
  for (const item of page.Contents ?? []) {
    if (!item.Key) continue;
    const key = decodeKey(item.Key);
    if (!key.startsWith(prefix) || key === prefix) continue;
    const relative = key.slice(prefix.length);
    if (relative.endsWith('/') && !relative.slice(0, -1).includes('/')) entries.set(key, { key, name: relative.slice(0, -1), kind: 'folder', size: null, modified: null });
    else if (!relative.includes('/')) entries.set(key, { key, name: relative, kind: 'file', size: item.Size ?? 0, modified: item.LastModified?.toISOString() ?? null, ...(item.StorageClass ? { storageClass: item.StorageClass } : {}) });
  }
  const nextToken = page.IsTruncated ? page.NextContinuationToken : null;
  if (page.IsTruncated && !nextToken || nextToken && !validToken(nextToken)) throw new Error('The storage service returned an invalid continuation token.');
  return { entries: [...entries.values()], nextToken };
}

/** S3 calls are async; recursive scans do not block browsing. */
export class S3Worker {
  private activeStats = 0;
  private disposed = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly options: { requestTimeoutMs?: number; statsTimeoutMs?: number } = {}) {}

  private client(connection: WorkerConnection) {
    if (this.disposed) throw new Error('The S3 worker has stopped.');
    return createS3Client(connection);
  }

  private request(deadlineMs: number): { controller: AbortController; timer: NodeJS.Timeout } {
    if (this.disposed) throw new Error('The S3 worker has stopped.');
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    return { controller, timer };
  }

  private finish(request: { controller: AbortController; timer: NodeJS.Timeout }): void {
    clearTimeout(request.timer);
    this.active.delete(request.controller);
  }

  async list(connection: WorkerConnection, prefix: string, pageSize = 1000, continuationToken: string | null = null): Promise<Listing> {
    assertPrefix(connection, prefix);
    if (!validPage(pageSize) || !validToken(continuationToken)) throw new Error('Invalid listing page.');
    const request = this.request(this.options.requestTimeoutMs ?? 90_000);
    const client = this.client(connection);
    try {
      const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: prefix, Delimiter: '/', EncodingType: 'url', MaxKeys: pageSize, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }), { abortSignal: request.controller.signal });
      return listingPage(page, prefix);
    } catch (error) { throw this.disposed ? new Error('The S3 worker has stopped.') : safeS3Error(error); }
    finally { client.destroy(); this.finish(request); }
  }

  async stats(connection: WorkerConnection, prefix: string): Promise<FolderStats> {
    assertPrefix(connection, prefix);
    if (this.activeStats >= maxActiveStats) throw new Error(statsBusyMessage);
    this.activeStats++;
    const started = performance.now();
    const request = this.request(this.options.statsTimeoutMs ?? 600_000);
    try {
      const client = this.client(connection);
      try {
        let token: string | undefined;
        let fileCount = 0, totalSize = 0;
        do {
          if (performance.now() - started > 600_000) throw new Error('Folder statistics timed out.');
          const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: prefix, EncodingType: 'url', ContinuationToken: token }), { abortSignal: request.controller.signal });
          for (const item of page.Contents ?? []) {
            if (!item.Key) continue;
            const key = decodeKey(item.Key);
            if (!key.startsWith(prefix) || key.endsWith('/')) continue;
            const size = item.Size ?? 0;
            if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(totalSize + size)) throw new Error('Folder statistics contain invalid object sizes.');
            totalSize += size; fileCount++;
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && !token) throw new Error('The storage service returned an invalid continuation token.');
        } while (token);
        return { fileCount, totalSize, updatedAt: new Date().toISOString(), durationMs: Math.max(0, Math.floor(performance.now() - started)) };
      } finally { client.destroy(); }
    } catch (error) { throw this.disposed ? new Error('The S3 worker has stopped.') : safeS3Error(error); }
    finally { this.activeStats--; this.finish(request); }
  }

  async search(connection: WorkerConnection, prefix: string, range: RemoteSearchRange, match: SearchMatch, name: string, pageSize = 1000, continuationToken: string | null = null): Promise<Listing> {
    assertPrefix(connection, prefix);
    if (!['folder', 'recursive', 'key'].includes(range) || !['exact', 'prefix', 'contains'].includes(match) || !name || name.includes('\0') ||
      range === 'key' && (match !== 'exact' || !name.startsWith(connectionRoot(connection))) || range !== 'key' && name.includes('/') ||
      !validPage(pageSize) || !validToken(continuationToken) || continuationToken && (range !== 'folder' || match !== 'prefix')) throw new Error('Invalid S3 search.');
    if (Buffer.byteLength(range === 'key' ? name : prefix + name) > 1024) throw new Error('The S3 key exceeds 1,024 bytes.');
    const request = this.request(range === 'recursive' || match === 'contains' ? this.options.statsTimeoutMs ?? 600_000 : this.options.requestTimeoutMs ?? 120_000);
    const client = this.client(connection);
    const bucket = connection.bucket;
    const foundFolder = async (key: string): Promise<Listing> => {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, EncodingType: 'url', MaxKeys: 1 }), { abortSignal: request.controller.signal });
      const found = (page.Contents ?? []).some(item => item.Key && decodeKey(item.Key).startsWith(key));
      return { entries: found ? [{ key, name: key, kind: 'folder', size: null, modified: null }] : [], nextToken: null };
    };
    try {
      if (match === 'exact' && (range === 'key' || range === 'folder')) {
        const key = range === 'key' ? name : prefix + name;
        if (range === 'key' && key.endsWith('/')) return foundFolder(key);
        try {
          const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: request.controller.signal });
          return { entries: [{ key, name: range === 'key' ? key : name, kind: 'file', size: head.ContentLength ?? 0, modified: head.LastModified?.toISOString() ?? null, ...(head.StorageClass ? { storageClass: head.StorageClass } : {}) }], nextToken: null };
        } catch (error) {
          if (safeS3Error(error).code === 'OBJECT_MISSING') return range === 'key' ? foundFolder(`${key}/`) : { entries: [], nextToken: null };
          throw error;
        }
      }
      if (range === 'folder' && match === 'prefix') {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + name, Delimiter: '/', EncodingType: 'url', MaxKeys: pageSize, ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }), { abortSignal: request.controller.signal });
        return listingPage(page, prefix);
      }
      const entries: Entry[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, EncodingType: 'url', ...(range === 'folder' ? { Delimiter: '/' } : {}), ContinuationToken: token }), { abortSignal: request.controller.signal });
        if (range === 'folder') entries.push(...listingPage(page, prefix).entries.filter(entry => matches(entry.name, name, match)));
        else for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          const key = decodeKey(item.Key);
          if (!key.startsWith(prefix) || key.endsWith('/') || !matches(key.split('/').at(-1) ?? '', name, match)) continue;
          entries.push({ key, name: key.slice(prefix.length), kind: 'file', size: item.Size ?? 0, modified: item.LastModified?.toISOString() ?? null, ...(item.StorageClass ? { storageClass: item.StorageClass } : {}) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new Error('The storage service returned an invalid continuation token.');
      } while (token);
      return { entries, nextToken: null };
    } catch (error) { throw this.disposed ? new Error('The S3 worker has stopped.') : safeS3Error(error); }
    finally { client.destroy(); this.finish(request); }
  }

  dispose(): void { this.disposed = true; for (const controller of this.active) controller.abort(); }
}
