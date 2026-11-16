import { GetObjectCommand, HeadObjectCommand, type GetObjectCommandOutput, type S3Client } from '@aws-sdk/client-s3';
import { constants } from 'node:fs';
import { link, open, type FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { OperationParams, OperationProgress } from './operation-runner';
import { discardResume, resumeNames } from './download-resume';
import { chunkCount, chunkLength, completedBytes, hasChunk, parallelChunkBytes, parallelThresholdBytes, probeParallelResume, setChunk, writeParallelResume, type ParallelRecord } from './parallel-resume';
import { descriptorPath, openDirectoryAnchor, safeLocalIOMessage } from './transfer-paths';
import { S3Failure } from './s3-client';

class ParallelFallback extends Error { constructor(readonly note: string) { super(note); } }
const changed = () => new ParallelFallback('The S3 object changed; this download restarted from the beginning.');
const unsupported = () => new ParallelFallback('Range requests are not supported by this service; this download restarted from the beginning.');
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function rangeFailure(cause: unknown): ParallelFallback | null {
  const status = (cause as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  if (status === 412) return changed();
  if ([400, 405, 416, 501].includes(status ?? 0)) return unsupported();
  return null;
}

export async function tryParallelDownload(client: S3Client, params: OperationParams, key: string, signal: AbortSignal, onProgress?: (value: OperationProgress) => void): Promise<{ bytes: number } | { fallbackNote: string } | null> {
  const id = params.resumeId;
  if (!id) return null;
  let anchor: FileHandle;
  try { anchor = await openDirectoryAnchor(params.rootPath ?? dirname(params.localPath!), dirname(params.localPath!)); }
  catch { throw new S3Failure('LOCAL_PATH_UNSAFE', safeLocalIOMessage); }
  const identity = { endpoint: params.connection.endpoint, bucket: params.connection.bucket, key };
  const partPath = descriptorPath(anchor, resumeNames(id).part);
  const destination = descriptorPath(anchor, basename(params.localPath!));
  let output: FileHandle | undefined;
  let created = false;
  let checkpointReady = false;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    const previous = await probeParallelResume(anchor, id, identity);
    if (previous === 'legacy') return null;
    if (!previous && safeCount(params.sizeHint) && params.sizeHint > 0 && params.sizeHint < parallelThresholdBytes) return null;
    let head;
    try { head = await client.send(new HeadObjectCommand({ Bucket: identity.bucket, Key: key, ...(previous ? { IfMatch: previous.record.etag } : {}) }), { abortSignal: controller.signal }); }
    catch (cause) {
      if (signal.aborted) throw cause;
      if (previous) { const fallback = rangeFailure(cause); if (fallback) throw fallback; throw cause; }
      return null; // Some compatible services permit GET but reject HEAD.
    }
    if (!safeCount(head.ContentLength) || head.ContentLength < parallelThresholdBytes || typeof head.ETag !== 'string' || !head.ETag) {
      if (previous) throw changed();
      return null;
    }
    if (previous && (previous.record.total !== head.ContentLength || previous.record.etag !== head.ETag)) throw changed();
    const record: ParallelRecord = previous?.record ?? { ...identity, etag: head.ETag, total: head.ContentLength, chunkSize: parallelChunkBytes, completed: Buffer.alloc(Math.ceil(Math.ceil(head.ContentLength / parallelChunkBytes) / 8)) };
    try { output = await open(partPath, previous ? constants.O_RDWR | constants.O_NOFOLLOW : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw new S3Failure('LOCAL_PATH_UNSAFE', 'Could not open the partial download safely.'); }
    created = !previous;
    if (previous) {
      const current = await output.stat();
      if (!current.isFile() || current.dev !== previous.device || current.ino !== previous.inode) throw new S3Failure('LOCAL_PATH_UNSAFE', 'The partial download changed on disk. Remove the task and download it again.');
    } else await writeParallelResume(anchor, id, record);
    checkpointReady = true;
    let committed = completedBytes(record);
    try { onProgress?.({ transferred: committed, total: record.total, resumeOffset: committed }); } catch { /* Progress listeners cannot affect the transfer. */ }
    let firstIndex: number | undefined;
    for (let index = 0; index < chunkCount(record); index++) if (!hasChunk(record, index)) { firstIndex = index; break; }
    if (firstIndex !== undefined) {
      const requestRange = async (index: number): Promise<GetObjectCommandOutput> => {
        const start = index * record.chunkSize;
        const end = start + chunkLength(record, index) - 1;
        let response: GetObjectCommandOutput;
        try { response = await client.send(new GetObjectCommand({ Bucket: identity.bucket, Key: key, Range: `bytes=${start}-${end}`, IfMatch: record.etag }), { abortSignal: controller.signal }); }
        catch (cause) { throw rangeFailure(cause) ?? cause; }
        if (response.$metadata.httpStatusCode !== 206 || response.ContentRange !== `bytes ${start}-${end}/${record.total}` || response.ContentLength !== end - start + 1 || response.ETag !== record.etag || !response.Body) {
          (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
          throw response.ETag && response.ETag !== record.etag ? changed() : unsupported();
        }
        return response;
      };
      // Validate one response before opening more requests to an incompatible endpoint.
      const first = await requestRange(firstIndex);
      let checkpoint = Promise.resolve();
      const saveChunk = async (index: number) => {
        checkpoint = checkpoint.then(async () => {
          await output!.sync();
          setChunk(record, index);
          await writeParallelResume(anchor, id, record);
          committed += chunkLength(record, index);
          try { onProgress?.({ transferred: committed, total: record.total }); } catch { /* Progress listeners cannot affect the transfer. */ }
        });
        await checkpoint;
      };
      const consume = async (index: number, response: GetObjectCommandOutput) => {
        const start = index * record.chunkSize;
        const length = chunkLength(record, index);
        let received = 0;
        const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
        try {
          for await (const part of body) {
            if (controller.signal.aborted) throw new S3Failure('CANCELLED', 'The operation was cancelled.');
            const chunk = Buffer.from(part);
            if (received + chunk.length > length) throw new S3Failure('INVALID_RESPONSE', 'The S3 service returned more bytes than the requested range.');
            let offset = 0;
            while (offset < chunk.length) {
              const written = await output!.write(chunk, offset, chunk.length - offset, start + received + offset);
              if (!written.bytesWritten) throw new S3Failure('LOCAL_IO', 'Could not write the partial download.');
              offset += written.bytesWritten;
            }
            received += chunk.length;
          }
          if (received !== length) throw new S3Failure('INCOMPLETE_DOWNLOAD', 'The download was incomplete. Retry the file.');
          await saveChunk(index);
        } finally { body.destroy?.(); }
      };
      let nextIndex = 0;
      const take = (): number | undefined => {
        while (nextIndex < chunkCount(record)) {
          const index = nextIndex++;
          if (index !== firstIndex && !hasChunk(record, index)) return index;
        }
        return undefined;
      };
      const worker = async () => { let index: number | undefined; while (!controller.signal.aborted && (index = take()) !== undefined) await consume(index, await requestRange(index)); };
      let firstFailure: unknown;
      const guarded = (job: Promise<void>) => job.catch(cause => { if (firstFailure === undefined) firstFailure = cause; controller.abort(); throw cause; });
      const results = await Promise.allSettled([guarded(consume(firstIndex, first)), ...Array.from({ length: 3 }, () => guarded(worker()))]);
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw firstFailure ?? failure.reason;
    }
    if (committed !== record.total) throw new S3Failure('INCOMPLETE_DOWNLOAD', 'The download was incomplete. Retry the file.');
    await output.sync(); await output.close(); output = undefined;
    if (signal.aborted) throw new S3Failure('CANCELLED', 'The operation was cancelled.');
    try { await link(partPath, destination); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new S3Failure('LOCAL_PATH_UNSAFE', 'A file already exists at the download destination. Choose a new destination.');
      throw new S3Failure('LOCAL_PATH_UNSAFE', 'Could not save the download in the selected directory.');
    }
    await discardResume(anchor, id);
    try { onProgress?.({ transferred: record.total, total: record.total }); } catch { /* Progress listeners cannot affect the transfer. */ }
    return { bytes: record.total };
  } catch (cause) {
    if (cause instanceof ParallelFallback && !signal.aborted) {
      await output?.close(); output = undefined;
      await discardResume(anchor, id);
      return { fallbackNote: cause.note };
    }
    if (created && !checkpointReady) await discardResume(anchor, id).catch(() => undefined);
    throw cause;
  } finally {
    controller.abort();
    signal.removeEventListener('abort', abort);
    await output?.close().catch(() => undefined);
    await anchor.close();
  }
}
