import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CopyObjectCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, UploadPartCommand, UploadPartCopyCommand, type S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { WorkerConnection } from './connections';
import { descriptorPath, openDirectoryAnchor, safeLocalIOMessage } from './transfer-paths';
import { assertPrefix, connectionRoot, createS3Client, decodeKey, safeS3Error, S3Failure } from './s3-client';

export type OperationName = 'manifest' | 'download' | 'upload' | 'delete' | 'copy' | 'rename';
export interface ManifestObject { key: string; size: number; isDirectory: boolean }
export interface OperationProgress { transferred: number; total: number }
export interface OperationParams { connection: WorkerConnection; key?: string; destinationKey?: string; prefix?: string; kind?: 'file' | 'folder'; localPath?: string; rootPath?: string }
export interface OperationResultMap { manifest: { objects: ManifestObject[] }; download: { bytes: number }; upload: { bytes: number }; delete: { deleted: number }; copy: { copied: number }; rename: { renamed: number } }
export interface OperationHandle<T> { promise: Promise<T>; cancel(): void }
export class OperationError extends Error { constructor(readonly code: string, message: string) { super(message); } }

const scanTimeoutMs = 600_000;
const multipartBytes = 8 * 1024 * 1024;
const maxManifestBytes = 32 * 1024 * 1024;
const message = {
  invalid: 'The S3 operation request is invalid.',
  partialDelete: 'Deletion failed. Some objects may have been deleted. Refresh the folder before retrying.',
  partialCopy: 'Copying stopped after some objects were copied. Refresh the destination before retrying.',
  renameCopy: 'Renaming stopped while copying. The original remains; the new name may contain copied objects. Refresh the folder before retrying.',
  renameDelete: 'The copy succeeded, but removing the original failed. Both names may remain. Refresh the folder before retrying.',
};
const error = (code: string, text: string) => new OperationError(code, text);
const safeCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validate(method: OperationName, params: OperationParams): string {
  const { connection, kind = 'file' } = params;
  if (!connection || !connection.bucket || !connection.endpoint || !connection.accessKey || !connection.secretKey) throw error('INVALID_REQUEST', message.invalid);
  const root = connectionRoot(connection);
  if (method === 'manifest') {
    const prefix = params.prefix ?? params.key;
    if (typeof prefix !== 'string') throw error('INVALID_REQUEST', message.invalid);
    assertPrefix(connection, prefix); return prefix;
  }
  const key = params.key;
  if (typeof key !== 'string' || !key || !key.startsWith(root) || !['file', 'folder'].includes(kind) || key.endsWith('/') !== (kind === 'folder')) throw error('INVALID_PREFIX', 'The object is outside the configured connection prefix or has an invalid scope.');
  if (method === 'download' && kind === 'folder') throw error('INVALID_REQUEST', message.invalid);
  if (method === 'download' || method === 'upload' && kind === 'file') {
    if (typeof params.localPath !== 'string' || !isAbsolute(params.localPath)) throw error('INVALID_REQUEST', 'An absolute local file path is required.');
  }
  if (method === 'copy' || method === 'rename') {
    const destination = params.destinationKey;
    if (typeof destination !== 'string' || !destination || !destination.startsWith(root) || destination.endsWith('/') !== (kind === 'folder')) throw error('INVALID_PREFIX', 'The copy destination is outside the configured connection prefix.');
    if (destination === key || kind === 'folder' && destination.startsWith(key)) throw error('INVALID_REQUEST', 'Choose a destination outside the source folder and with a different name.');
    if (method === 'rename') {
      if (key === root) throw error('INVALID_REQUEST', 'The configured connection root cannot be renamed.');
      const parent = (value: string) => value.replace(/\/$/, '').split('/').slice(0, -1).join('/');
      if (parent(key) !== parent(destination)) throw error('INVALID_REQUEST', 'A rename must stay in the same folder.');
    }
  }
  return key;
}

function check(signal: AbortSignal): void { if (signal.aborted) throw error('CANCELLED', 'The operation was cancelled.'); }
function sdk(errorValue: unknown, method: OperationName, operation?: string): OperationError {
  if (errorValue instanceof OperationError) return errorValue;
  const safe = safeS3Error(errorValue);
  if (method === 'upload' && operation) {
    const details = [safe.serviceCode, safe.httpStatus ? `HTTP ${safe.httpStatus}` : undefined].filter(Boolean).join(', ');
    let hint = safe.message;
    if (safe.httpStatus === 413) hint = 'The server or proxy rejected the request size. Check its upload body-size limit.';
    else if (['BadDigest', 'InvalidDigest', 'InvalidChecksum', 'InvalidChecksumAlgorithm', 'XAmzContentSHA256Mismatch'].includes(safe.serviceCode ?? '')) hint = 'The service rejected the upload checksum. Check compatibility and the connection’s extra config.';
    else if (['NotImplemented', 'NotSupported', 'MethodNotAllowed'].includes(safe.serviceCode ?? '') || safe.httpStatus === 405 || safe.httpStatus === 501) hint = 'The endpoint does not support this upload operation. Check its S3 multipart compatibility.';
    return new OperationError(safe.code, `${operation} failed${details ? ` (${details})` : ''}. ${hint}`);
  }
  return new OperationError(safe.code, safe.message);
}

function progress(callback: ((value: OperationProgress) => void) | undefined, total: number) {
  let last = -Infinity;
  return (transferred: number, final = false) => {
    const now = performance.now();
    if (callback && (final || now - last >= 250)) { last = now; try { callback({ transferred, total }); } catch { /* UI observers do not change operation outcome. */ } }
  };
}

async function scan(client: S3Client, connection: WorkerConnection, prefix: string, signal: AbortSignal): Promise<ManifestObject[]> {
  const objects: ManifestObject[] = [];
  let token: string | undefined;
  let resultBytes = 64;
  do {
    check(signal);
    const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: prefix, EncodingType: 'url', ContinuationToken: token }), { abortSignal: signal });
    for (const item of page.Contents ?? []) {
      if (typeof item.Key !== 'string' || !safeCount(item.Size)) throw error('INVALID_RESPONSE', 'The S3 service returned invalid object metadata.');
      const key = decodeKey(item.Key);
      if (!key.startsWith(prefix)) continue;
      const object = { key, size: item.Size, isDirectory: key.endsWith('/') };
      resultBytes += Buffer.byteLength(JSON.stringify(object)) + 1;
      if (resultBytes > maxManifestBytes) throw error('RESULT_TOO_LARGE', 'The folder contains too many objects. Choose a narrower folder.');
      objects.push(object);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !token) throw error('INVALID_RESPONSE', 'The S3 service returned an invalid continuation token.');
  } while (token);
  return objects;
}

async function missingOnProbe(client: S3Client, connection: WorkerConnection, key: string, signal: AbortSignal): Promise<boolean> {
  try { await client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: key }), { abortSignal: signal }); return false; }
  catch (cause) { return safeS3Error(cause).code === 'OBJECT_MISSING'; }
}

async function download(client: S3Client, params: OperationParams, key: string, signal: AbortSignal, callback?: (value: OperationProgress) => void): Promise<{ bytes: number }> {
  const localPath = params.localPath!;
  let parent: FileHandle;
  try { parent = await openDirectoryAnchor(params.rootPath ?? dirname(localPath), dirname(localPath)); }
  catch { throw error('LOCAL_PATH_UNSAFE', safeLocalIOMessage); }
  const temp = `.s3client-${randomUUID()}.part`;
  const tempPath = descriptorPath(parent, temp);
  const destPath = descriptorPath(parent, basename(localPath));
  let output: FileHandle | undefined;
  let body: { destroy?: () => void } | undefined;
  try {
    check(signal);
    let response;
    try { response = await client.send(new GetObjectCommand({ Bucket: params.connection.bucket, Key: key }), { abortSignal: signal }); }
    catch (cause) { throw sdk(cause, 'download'); }
    const total = response.ContentLength;
    if (!safeCount(total) || !response.Body) throw error('INVALID_RESPONSE', 'The S3 service returned an invalid download response.');
    body = response.Body as typeof body;
    const emit = progress(callback, total);
    try { output = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { throw error('LOCAL_PATH_UNSAFE', 'Could not create a temporary file in the selected download directory.'); }
    emit(0);
    let transferred = 0;
    try {
      for await (const part of response.Body as AsyncIterable<Uint8Array>) {
        check(signal);
        const chunk = Buffer.from(part);
        let offset = 0;
        while (offset < chunk.length) { const write = await output.write(chunk, offset, chunk.length - offset); offset += write.bytesWritten; }
        transferred += chunk.length;
        if (transferred > total) throw error('INCOMPLETE_DOWNLOAD', 'The download was incomplete. Retry the file.');
        emit(transferred);
      }
    } catch (cause) {
      if (signal.aborted) check(signal);
      if (cause instanceof OperationError) throw cause;
      if (await missingOnProbe(client, params.connection, key, signal)) throw sdk(new S3Failure('OBJECT_MISSING', 'The S3 object no longer exists. It may have been deleted. Refresh the folder before retrying this download.'), 'download');
      throw cause;
    }
    if (transferred !== total) {
      if (await missingOnProbe(client, params.connection, key, signal)) throw error('OBJECT_MISSING', 'The S3 object no longer exists. It may have been deleted. Refresh the folder before retrying this download.');
      throw error('INCOMPLETE_DOWNLOAD', 'The download was incomplete. Retry the file.');
    }
    await output.sync(); await output.close(); output = undefined;
    check(signal);
    try { await link(tempPath, destPath); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw error('LOCAL_PATH_UNSAFE', 'A file already exists at the download destination. Choose a new destination.');
      throw error('LOCAL_PATH_UNSAFE', 'Could not save the download in the selected directory.');
    }
    await unlink(tempPath);
    emit(transferred, true);
    return { bytes: transferred };
  } finally {
    body?.destroy?.();
    await output?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    await parent.close();
  }
}

async function upload(client: S3Client, params: OperationParams, key: string, signal: AbortSignal, callback?: (value: OperationProgress) => void): Promise<{ bytes: number }> {
  const bucket = params.connection.bucket;
  if (params.kind === 'folder') {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.alloc(0) }), { abortSignal: signal });
    progress(callback, 0)(0, true);
    return { bytes: 0 };
  }
  const localPath = params.localPath!;
  let parent: FileHandle;
  try { parent = await openDirectoryAnchor(params.rootPath ?? dirname(localPath), dirname(localPath)); }
  catch { throw error('LOCAL_PATH_UNSAFE', safeLocalIOMessage); }
  let source: FileHandle | undefined;
  try {
    try { source = await open(descriptorPath(parent, basename(localPath)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch { throw error('LOCAL_PATH_UNSAFE', 'The upload source file is unsafe or unavailable.'); }
    const info = await source.stat();
    if (!info.isFile() || !safeCount(info.size)) throw error('LOCAL_PATH_UNSAFE', 'Only regular files can be uploaded.');
    const total = info.size;
    const emit = progress(callback, total); emit(0);
    const partSize = Math.max(multipartBytes, Math.ceil(total / 10000));
    const readPart = async (length: number) => {
      const data = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) { check(signal); const read = await source!.read(data, offset, length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
      if (offset !== length) throw error('SOURCE_CHANGED', 'The source file changed during upload. Retry the file.');
      return data;
    };
    if (total <= multipartBytes) {
      const data = await readPart(total);
      try { await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentLength: total }), { abortSignal: signal }); }
      catch (cause) { throw sdk(cause, 'upload', 'PutObject'); }
      emit(total, true); return { bytes: total };
    }
    let uploadId: string | undefined;
    let complete = false;
    try {
      try { uploadId = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })).UploadId; }
      catch (cause) { throw sdk(cause, 'upload', 'CreateMultipartUpload'); }
      if (!uploadId) throw error('INVALID_RESPONSE', 'The service returned an incomplete multipart response.');
      const parts: { ETag: string; PartNumber: number }[] = [];
      let transferred = 0;
      while (transferred < total) {
        const data = await readPart(Math.min(partSize, total - transferred));
        const number = parts.length + 1;
        let tag: string | undefined;
        try { tag = (await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: data, ContentLength: data.length }), { abortSignal: signal })).ETag; }
        catch (cause) { throw sdk(cause, 'upload', 'UploadPart'); }
        if (!tag) throw error('INVALID_RESPONSE', 'The service returned an incomplete multipart response.');
        parts.push({ ETag: tag, PartNumber: number });
        transferred += data.length; emit(transferred);
      }
      try { await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }), { abortSignal: signal }); }
      catch (cause) { throw sdk(cause, 'upload', 'CompleteMultipartUpload'); }
      complete = true; emit(total, true); return { bytes: total };
    } finally {
      if (uploadId && !complete) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
    }
  } finally { await source?.close().catch(() => undefined); await parent.close(); }
}

async function verifyDeleted(client: S3Client, connection: WorkerConnection, key: string, kind: 'file' | 'folder', signal: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    check(signal);
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    let token: string | undefined;
    let remaining = false;
    do {
      check(signal);
      const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: key, EncodingType: 'url', ContinuationToken: token }), { abortSignal: signal });
      remaining = (page.Contents ?? []).some(item => item.Key && (decodeKey(item.Key) === key || kind === 'folder' && decodeKey(item.Key).startsWith(key)));
      if (remaining) break;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw error('INVALID_RESPONSE', 'The S3 service returned an invalid continuation token.');
    } while (token);
    if (!remaining) return;
  }
  throw error('DELETE_NOT_REMOVED', 'The delete request completed, but the item is still listed by the storage service. Refresh the folder before retrying.');
}

async function remove(client: S3Client, connection: WorkerConnection, key: string, kind: 'file' | 'folder', signal: AbortSignal, objects?: ManifestObject[]): Promise<{ deleted: number }> {
  const keys = kind === 'folder' ? [...new Set((objects ?? await scan(client, connection, key, signal)).map(item => item.key))] : [key];
  let attempted = false, deleted = 0;
  try {
    for (let offset = 0; offset < keys.length; offset += 1000) {
      check(signal); attempted = true;
      const batch = keys.slice(offset, offset + 1000);
      if (kind === 'file') await client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key }), { abortSignal: signal });
      else {
        const response = await client.send(new DeleteObjectsCommand({ Bucket: connection.bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }), { abortSignal: signal });
        if (response.Errors?.length) throw error('DELETE_PARTIAL', message.partialDelete);
      }
      deleted += batch.length;
    }
    await verifyDeleted(client, connection, key, kind, signal);
    return { deleted };
  } catch (cause) {
    if (signal.aborted) check(signal);
    if (cause instanceof OperationError && cause.code === 'DELETE_NOT_REMOVED') throw cause;
    if (attempted) throw error('DELETE_PARTIAL', message.partialDelete);
    throw cause;
  }
}

const copySource = (bucket: string, key: string) => `${bucket}/${encodeURIComponent(key).replace(/%2F/gi, '/')}`;
async function copyObject(client: S3Client, connection: WorkerConnection, source: ManifestObject, target: string, signal: AbortSignal): Promise<void> {
  const bucket = connection.bucket;
  if (source.size <= 5 * 1024 ** 3) {
    await client.send(new CopyObjectCommand({ Bucket: bucket, Key: target, CopySource: copySource(bucket, source.key) }), { abortSignal: signal });
    return;
  }
  const uploadId = (await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: target }), { abortSignal: signal })).UploadId;
  if (!uploadId) throw error('INVALID_RESPONSE', 'The service returned an incomplete multipart response.');
  let complete = false;
  try {
    const size = Math.max(64 * 1024 * 1024, Math.ceil(source.size / 10000));
    const parts: { ETag: string; PartNumber: number }[] = [];
    for (let start = 0; start < source.size; start += size) {
      check(signal);
      const end = Math.min(source.size - 1, start + size - 1);
      const number = parts.length + 1;
      const response = await client.send(new UploadPartCopyCommand({ Bucket: bucket, Key: target, UploadId: uploadId, PartNumber: number, CopySource: copySource(bucket, source.key), CopySourceRange: `bytes=${start}-${end}` }), { abortSignal: signal });
      const tag = response.CopyPartResult?.ETag;
      if (!tag) throw error('INVALID_RESPONSE', 'The service returned an incomplete multipart copy response.');
      parts.push({ ETag: tag, PartNumber: number });
    }
    await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: target, UploadId: uploadId, MultipartUpload: { Parts: parts } }), { abortSignal: signal });
    complete = true;
  } finally { if (!complete) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: target, UploadId: uploadId })).catch(() => undefined); }
}

async function copy(client: S3Client, params: OperationParams, key: string, signal: AbortSignal, callback?: (value: OperationProgress) => void, sourceObjects?: ManifestObject[]): Promise<{ copied: number }> {
  const connection = params.connection;
  const destination = params.destinationKey!;
  const kind = params.kind ?? 'file';
  const objects = sourceObjects ?? (kind === 'folder' ? await scan(client, connection, key, signal) : [await (async () => {
    const head = await client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: key }), { abortSignal: signal });
    return { key, size: head.ContentLength ?? 0, isDirectory: false };
  })()]);
  if (!objects.length) throw error('INVALID_REQUEST', 'The source folder has no objects to copy.');
  if (kind === 'folder') {
    const page = await client.send(new ListObjectsV2Command({ Bucket: connection.bucket, Prefix: destination, MaxKeys: 1 }), { abortSignal: signal });
    if (page.Contents?.length) throw error('COPY_CONFLICT', 'The destination already exists. Choose another folder or name.');
  } else if (!await missingOnProbe(client, connection, destination, signal)) throw error('COPY_CONFLICT', 'The destination already exists. Choose another folder or name.');
  const emit = progress(callback, objects.length); emit(0);
  let copied = 0;
  try {
    for (const object of objects) {
      check(signal);
      await copyObject(client, connection, object, kind === 'folder' ? destination + object.key.slice(key.length) : destination, signal);
      copied++; emit(copied);
    }
  } catch (cause) { if (signal.aborted) check(signal); if (copied) throw error('COPY_PARTIAL', message.partialCopy); throw cause; }
  emit(copied, true);
  return { copied };
}

async function rename(client: S3Client, params: OperationParams, key: string, signal: AbortSignal, callback?: (value: OperationProgress) => void): Promise<{ renamed: number }> {
  const kind = params.kind ?? 'file';
  const source = kind === 'folder' ? await scan(client, params.connection, key, signal) : [await (async () => {
    const head = await client.send(new HeadObjectCommand({ Bucket: params.connection.bucket, Key: key }), { abortSignal: signal });
    return { key, size: head.ContentLength ?? 0, isDirectory: false };
  })()];
  let copied: number;
  try {
    copied = (await copy(client, params, key, signal, callback, source)).copied;
    if (kind === 'folder') {
      const expected = new Map(source.map(item => [params.destinationKey! + item.key.slice(key.length), item.size]));
      const actual = await scan(client, params.connection, params.destinationKey!, signal);
      if (actual.length !== expected.size || actual.some(item => expected.get(item.key) !== item.size)) throw error('RENAME_COPY_FAILED', message.renameCopy);
    } else {
      const head = await client.send(new HeadObjectCommand({ Bucket: params.connection.bucket, Key: params.destinationKey! }), { abortSignal: signal });
      if (head.ContentLength !== source[0].size) throw error('RENAME_COPY_FAILED', message.renameCopy);
    }
  } catch (cause) {
    if (cause instanceof OperationError && ['COPY_CONFLICT', 'INVALID_REQUEST', 'INVALID_PREFIX', 'RENAME_COPY_FAILED'].includes(cause.code)) throw cause;
    throw error('RENAME_COPY_FAILED', message.renameCopy);
  }
  try { await remove(client, params.connection, key, kind, signal, source); }
  catch { throw error('RENAME_DELETE_FAILED', message.renameDelete); }
  return { renamed: copied };
}

/** Each operation owns an AbortController; cancelling one does not affect other jobs. */
export class OperationRunner {
  private readonly active = new Set<AbortController>();
  private disposed = false;
  constructor(private readonly options: { requestTimeoutMs?: number } = {}) {}

  run<M extends OperationName>(method: M, params: OperationParams, onProgress?: (value: OperationProgress) => void): OperationHandle<OperationResultMap[M]> {
    const controller = new AbortController();
    this.active.add(controller);
    const cancel = () => controller.abort();
    const promise = (async () => {
      let client: S3Client | undefined;
      let timeout: NodeJS.Timeout | undefined;
      try {
        if (this.disposed) throw error('CANCELLED', 'The operation runner has stopped.');
        const key = validate(method, params);
        client = createS3Client(params.connection);
        timeout = ['manifest', 'delete', 'copy', 'rename'].includes(method) ? setTimeout(cancel, Math.min(this.options.requestTimeoutMs ?? scanTimeoutMs, scanTimeoutMs)) : undefined;
        let result: OperationResultMap[OperationName];
        switch (method) {
          case 'manifest': result = { objects: await scan(client, params.connection, key, controller.signal) }; break;
          case 'download': result = await download(client, params, key, controller.signal, onProgress); break;
          case 'upload': result = await upload(client, params, key, controller.signal, onProgress); break;
          case 'delete': result = await remove(client, params.connection, key, params.kind ?? 'file', controller.signal); break;
          case 'copy': result = await copy(client, params, key, controller.signal, onProgress); break;
          case 'rename': result = await rename(client, params, key, controller.signal, onProgress); break;
        }
        check(controller.signal);
        return result as OperationResultMap[M];
      } catch (cause) {
        if (controller.signal.aborted) throw error('CANCELLED', 'The operation was cancelled.');
        throw sdk(cause, method);
      } finally { if (timeout) clearTimeout(timeout); client?.destroy(); this.active.delete(controller); }
    })();
    return { promise, cancel };
  }

  dispose(): void { this.disposed = true; for (const controller of this.active) controller.abort(); }
}
