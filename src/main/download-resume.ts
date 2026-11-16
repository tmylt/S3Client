import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { descriptorPath, openDirectoryAnchor } from './transfer-paths';

export interface ResumeIdentity { endpoint: string; bucket: string; key: string }
export interface ResumeRecord extends ResumeIdentity { etag: string; total: number }
export interface ResumeState { record: ResumeRecord; bytes: number; device: number; inode: number }

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function resumeNames(id: string): { part: string; metadata: string } {
  if (!idPattern.test(id)) throw new Error('Invalid download task ID.');
  return { part: `.s3client-${id}.part`, metadata: `.s3client-${id}.resume` };
}

export async function discardResume(anchor: FileHandle, id: string): Promise<void> {
  const names = resumeNames(id);
  for (const name of [names.metadata, names.part]) {
    try { await unlink(descriptorPath(anchor, name)); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
  }
}

export async function discardDownloadPartial(rootPath: string, localPath: string, id: string): Promise<void> {
  let anchor: FileHandle;
  try { anchor = await openDirectoryAnchor(rootPath, dirname(localPath)); }
  catch { return; } // A removed or unsafe destination cannot be traversed.
  try { await discardResume(anchor, id); }
  finally { await anchor.close(); }
}

export async function readResume(anchor: FileHandle, id: string, identity: ResumeIdentity): Promise<ResumeState | null> {
  const names = resumeNames(id);
  let metadata: FileHandle | undefined;
  let part: FileHandle | undefined;
  try {
    metadata = await open(descriptorPath(anchor, names.metadata), constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadataStat = await metadata.stat();
    if (!metadataStat.isFile() || metadataStat.size > 4096) throw new Error('Invalid resume metadata.');
    const value: unknown = JSON.parse(await metadata.readFile('utf8'));
    if (!value || typeof value !== 'object') throw new Error('Invalid resume metadata.');
    const raw = value as Partial<ResumeRecord> & { version?: unknown };
    if (raw.version !== 1 || raw.endpoint !== identity.endpoint || raw.bucket !== identity.bucket || raw.key !== identity.key || typeof raw.etag !== 'string' || !raw.etag || raw.etag.length > 1024 || !safeCount(raw.total)) throw new Error('Invalid resume metadata.');
    part = await open(descriptorPath(anchor, names.part), constants.O_RDONLY | constants.O_NOFOLLOW);
    const partStat = await part.stat();
    if (!partStat.isFile() || !safeCount(partStat.size) || partStat.size > raw.total) throw new Error('Invalid partial download.');
    return { record: { endpoint: raw.endpoint, bucket: raw.bucket, key: raw.key, etag: raw.etag, total: raw.total }, bytes: partStat.size, device: partStat.dev, inode: partStat.ino };
  } catch {
    await discardResume(anchor, id);
    return null;
  } finally {
    await metadata?.close();
    await part?.close();
  }
}

export async function writeResume(anchor: FileHandle, id: string, record: ResumeRecord): Promise<void> {
  const { metadata } = resumeNames(id);
  const temporary = `.s3client-${id}.${randomUUID()}.tmp`;
  const path = descriptorPath(anchor, temporary);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify({ version: 1, ...record }));
    await handle.sync();
    await handle.close(); handle = undefined;
    await rename(path, descriptorPath(anchor, metadata));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}
