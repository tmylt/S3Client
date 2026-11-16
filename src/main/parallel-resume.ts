import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { descriptorPath } from './transfer-paths';
import { discardResume, resumeNames, type ResumeIdentity } from './download-resume';

export const parallelChunkBytes = 8 * 1024 * 1024;
export const parallelThresholdBytes = 32 * 1024 * 1024;
const maxMetadataBytes = 128 * 1024;
const maxChunks = 655_360; // A 5 TiB object in 8 MiB chunks.

export interface ParallelRecord extends ResumeIdentity { etag: string; total: number; chunkSize: number; completed: Buffer }
export interface ParallelState { record: ParallelRecord; device: number; inode: number }
export type ParallelProbe = ParallelState | 'legacy' | null;

const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const chunkCount = (record: ParallelRecord): number => Math.ceil(record.total / record.chunkSize);
export const chunkLength = (record: ParallelRecord, index: number): number => Math.min(record.chunkSize, record.total - index * record.chunkSize);
export const hasChunk = (record: ParallelRecord, index: number): boolean => Boolean(record.completed[index >> 3] & (1 << (index & 7)));
export const setChunk = (record: ParallelRecord, index: number): void => { record.completed[index >> 3] |= 1 << (index & 7); };
export function completedBytes(record: ParallelRecord): number {
  let bytes = 0;
  for (let index = 0; index < chunkCount(record); index++) if (hasChunk(record, index)) bytes += chunkLength(record, index);
  return bytes;
}

export async function probeParallelResume(anchor: FileHandle, id: string, identity: ResumeIdentity): Promise<ParallelProbe> {
  const names = resumeNames(id);
  let metadata: FileHandle | undefined;
  let part: FileHandle | undefined;
  try {
    try { metadata = await open(descriptorPath(anchor, names.metadata), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') { await discardResume(anchor, id); return null; } throw cause; }
    const stat = await metadata.stat();
    if (!stat.isFile() || stat.size > maxMetadataBytes) throw new Error('Invalid parallel resume metadata.');
    const raw: unknown = JSON.parse(await metadata.readFile('utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('Invalid parallel resume metadata.');
    const value = raw as Record<string, unknown>;
    if (value.version === 1) return 'legacy';
    if (value.version !== 2 || value.endpoint !== identity.endpoint || value.bucket !== identity.bucket || value.key !== identity.key || typeof value.etag !== 'string' || !value.etag || value.etag.length > 1024 || !safeCount(value.total) || value.total < parallelThresholdBytes || value.total > 5 * 1024 ** 4 || value.chunkSize !== parallelChunkBytes || typeof value.completed !== 'string') throw new Error('Invalid parallel resume metadata.');
    const count = Math.ceil(value.total / parallelChunkBytes);
    if (count > maxChunks || value.completed.length > 110_000) throw new Error('Invalid parallel resume bitmap.');
    const bitmap = Buffer.from(value.completed, 'base64');
    if (bitmap.length !== Math.ceil(count / 8) || bitmap.toString('base64') !== value.completed) throw new Error('Invalid parallel resume bitmap.');
    for (let index = count; index < bitmap.length * 8; index++) if (bitmap[index >> 3] & (1 << (index & 7))) throw new Error('Invalid parallel resume bitmap.');
    part = await open(descriptorPath(anchor, names.part), constants.O_RDONLY | constants.O_NOFOLLOW);
    const partStat = await part.stat();
    if (!partStat.isFile() || !safeCount(partStat.size) || partStat.size > value.total) throw new Error('Invalid parallel partial.');
    const record: ParallelRecord = { endpoint: value.endpoint as string, bucket: value.bucket as string, key: value.key as string, etag: value.etag, total: value.total, chunkSize: parallelChunkBytes, completed: bitmap };
    for (let index = 0; index < count; index++) if (hasChunk(record, index) && partStat.size < index * parallelChunkBytes + chunkLength(record, index)) throw new Error('Incomplete parallel partial.');
    return { record, device: partStat.dev, inode: partStat.ino };
  } catch {
    await discardResume(anchor, id);
    return null;
  } finally {
    await metadata?.close();
    await part?.close();
  }
}

export async function writeParallelResume(anchor: FileHandle, id: string, record: ParallelRecord): Promise<void> {
  const { metadata } = resumeNames(id);
  const temporary = `.s3client-${id}.${randomUUID()}.tmp`;
  const path = descriptorPath(anchor, temporary);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({ version: 2, endpoint: record.endpoint, bucket: record.bucket, key: record.key, etag: record.etag, total: record.total, chunkSize: record.chunkSize, completed: record.completed.toString('base64') }));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(path, descriptorPath(anchor, metadata));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}
