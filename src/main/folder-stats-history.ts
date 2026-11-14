import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFolderStats } from '../shared/folder-stats';
import type { FolderStats } from '../shared/types';
import type { CacheScope } from './listing-cache';

interface StoredHistory { connection: CacheScope; prefix: string; points: FolderStats[]; touchedAt: string }
const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxBytes = 16 * 1024 * 1024;
const maxFolders = 1000;
const maxPointsPerFolder = 1000;
const serialize = (histories: StoredHistory[]) => JSON.stringify({ version: 1, histories });

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid statistics history.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('Invalid statistics history.');
  return value;
}
function directory(value: unknown): string {
  const prefix = text(value, 8192);
  if (prefix && !prefix.endsWith('/')) throw new Error('Invalid statistics folder prefix.');
  return prefix;
}
function scope(value: unknown): CacheScope {
  const input = object(value);
  const id = text(input.id, 200), endpoint = text(input.endpoint, 4096), bucket = text(input.bucket, 255);
  const prefix = directory(input.prefix);
  const configHash = input.configHash === undefined ? undefined : text(input.configHash, 64);
  if (!id || !endpoint || !bucket || configHash !== undefined && !/^[a-f0-9]{64}$/.test(configHash)) throw new Error('Invalid statistics connection.');
  return { id, endpoint, bucket, prefix, ...(configHash ? { configHash } : {}) };
}
const scopeKey = (connection: CacheScope) => JSON.stringify([connection.id, connection.endpoint, connection.bucket, connection.prefix, connection.configHash ?? '']);
const recordKey = (connection: CacheScope, prefix: string) => JSON.stringify([scopeKey(connection), prefix]);
const stamp = (value: FolderStats) => Date.parse(value.updatedAt);
const samePoint = (left: FolderStats, right: FolderStats) => left.updatedAt === right.updatedAt && left.fileCount === right.fileCount && left.totalSize === right.totalSize && left.durationMs === right.durationMs;
function record(value: unknown): StoredHistory {
  const input = object(value);
  const connection = scope(input.connection), prefix = directory(input.prefix);
  if (!prefix.startsWith(connection.prefix) || !Array.isArray(input.points) || input.points.length > maxPointsPerFolder) throw new Error('Invalid statistics history record.');
  const points = input.points.map(parseFolderStats).sort((a, b) => stamp(a) - stamp(b));
  const touchedAt = input.touchedAt === undefined ? points.at(-1)?.updatedAt : text(input.touchedAt, 200);
  if (!touchedAt || !Number.isFinite(Date.parse(touchedAt))) throw new Error('Invalid statistics history timestamp.');
  return { connection, prefix, points, touchedAt };
}

/** A separate metadata file keeps scan history after listing cache invalidation. */
export class FolderStatsHistoryStore {
  private readonly file: string;
  private loaded = false;
  private records: StoredHistory[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly baseDirectory: string, private readonly now: () => number = Date.now) {
    this.file = join(baseDirectory, 'folder-stats-history.json');
  }

  private recent(points: FolderStats[]): FolderStats[] {
    const clock = this.now(), cutoff = clock - retentionMs;
    return points.filter(point => stamp(point) >= cutoff && stamp(point) <= clock).slice(-maxPointsPerFolder);
  }
  private bounded(records: StoredHistory[]): StoredHistory[] {
    const result = records.map(item => ({ ...item, points: this.recent(item.points) })).filter(item => item.points.length || Date.parse(item.touchedAt) >= this.now() - retentionMs);
    result.sort((a, b) => Date.parse(a.touchedAt) - Date.parse(b.touchedAt));
    if (result.length > maxFolders) result.splice(0, result.length - maxFolders);
    while (result.length && Buffer.byteLength(serialize(result)) > maxBytes) result.shift();
    return result;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.file, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) return;
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const part = await handle.read(bytes, count, bytes.length - count, count);
        if (!part.bytesRead) break;
        count += part.bytesRead;
      }
      if (count > info.size || (await handle.stat()).size > maxBytes) return;
      const parsed = object(JSON.parse(bytes.subarray(0, count).toString('utf8')));
      if (parsed.version !== 1 || !Array.isArray(parsed.histories)) return;
      const unique = new Map<string, StoredHistory>();
      for (const value of parsed.histories) {
        try { const item = record(value); unique.set(recordKey(item.connection, item.prefix), item); }
        catch { /* One damaged folder must not hide other histories. */ }
      }
      this.records = this.bounded([...unique.values()]);
    } catch { /* Missing or damaged history starts empty. */ }
    finally { await handle?.close().catch(() => undefined); }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return operation(); });
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async persist(records: StoredHistory[]): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.baseDirectory, 0o700);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialize(records), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  async append(connection: CacheScope, prefix: string, value: FolderStats): Promise<void> {
    const validScope = scope(connection), target = directory(prefix);
    if (!target.startsWith(validScope.prefix)) throw new Error('Invalid statistics folder prefix.');
    const point = parseFolderStats(value);
    return this.serial(async () => {
      const key = recordKey(validScope, target);
      const current = this.records.find(item => recordKey(item.connection, item.prefix) === key);
      const points = [...(current?.points ?? [])];
      if (!points.some(item => samePoint(item, point))) points.push(point);
      points.sort((a, b) => stamp(a) - stamp(b));
      const next = this.bounded([...this.records.filter(item => recordKey(item.connection, item.prefix) !== key), { connection: validScope, prefix: target, points, touchedAt: new Date(this.now()).toISOString() }]);
      await this.persist(next);
      this.records = next;
    });
  }
  async seedIfMissing(connection: CacheScope, prefix: string, value: FolderStats): Promise<FolderStats[]> {
    const validScope = scope(connection), target = directory(prefix), point = parseFolderStats(value);
    if (!target.startsWith(validScope.prefix)) throw new Error('Invalid statistics folder prefix.');
    return this.serial(async () => {
      const key = recordKey(validScope, target);
      const current = this.records.find(item => recordKey(item.connection, item.prefix) === key);
      if (current) return this.recent(current.points).map(item => ({ ...item }));
      const next = this.bounded([...this.records, { connection: validScope, prefix: target, points: [point], touchedAt: new Date(this.now()).toISOString() }]);
      await this.persist(next);
      this.records = next;
      return this.recent(next.find(item => recordKey(item.connection, item.prefix) === key)?.points ?? []).map(item => ({ ...item }));
    });
  }
  async read(connection: CacheScope, prefix: string): Promise<FolderStats[] | null> {
    const validScope = scope(connection), target = directory(prefix);
    if (!target.startsWith(validScope.prefix)) throw new Error('Invalid statistics folder prefix.');
    return this.serial(async () => {
      const record = this.records.find(item => recordKey(item.connection, item.prefix) === recordKey(validScope, target));
      return record ? this.recent(record.points).map(item => ({ ...item })) : null;
    });
  }
  async list(connection: CacheScope, prefix: string): Promise<FolderStats[]> {
    return await this.read(connection, prefix) ?? [];
  }
  async deletePoint(connection: CacheScope, prefix: string, value: FolderStats): Promise<FolderStats[]> {
    const validScope = scope(connection), target = directory(prefix), point = parseFolderStats(value);
    if (!target.startsWith(validScope.prefix)) throw new Error('Invalid statistics folder prefix.');
    return this.serial(async () => {
      const key = recordKey(validScope, target);
      const current = this.records.find(item => recordKey(item.connection, item.prefix) === key);
      if (!current?.points.some(item => samePoint(item, point))) throw new Error('This scan result no longer exists.');
      const points = current.points.filter(item => !samePoint(item, point));
      const next = this.bounded([...this.records.filter(item => recordKey(item.connection, item.prefix) !== key), { connection: validScope, prefix: target, points, touchedAt: new Date(this.now()).toISOString() }]);
      await this.persist(next);
      this.records = next;
      return this.recent(next.find(item => recordKey(item.connection, item.prefix) === key)?.points ?? []).map(item => ({ ...item }));
    });
  }
  async clearFolder(connection: CacheScope, prefix: string): Promise<FolderStats[]> {
    const validScope = scope(connection), target = directory(prefix);
    if (!target.startsWith(validScope.prefix)) throw new Error('Invalid statistics folder prefix.');
    return this.serial(async () => {
      const key = recordKey(validScope, target);
      const next = this.bounded([...this.records.filter(item => recordKey(item.connection, item.prefix) !== key), { connection: validScope, prefix: target, points: [], touchedAt: new Date(this.now()).toISOString() }]);
      await this.persist(next);
      this.records = next;
      return [];
    });
  }
  async removeConnection(id: string): Promise<void> {
    if (typeof id !== 'string' || !id) throw new Error('Invalid connection.');
    return this.serial(async () => {
      const next = this.records.filter(item => item.connection.id !== id);
      await this.persist(next);
      this.records = next;
    });
  }
}
