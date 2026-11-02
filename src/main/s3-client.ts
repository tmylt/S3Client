import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { WorkerConnection } from './connections';

export class S3Failure extends Error {
  constructor(readonly code: string, message: string, readonly serviceCode?: string, readonly httpStatus?: number) { super(message); }
}

const messages: Record<string, string> = {
  ACCESS_DENIED: 'Permission denied. Check this connection’s S3 permissions.',
  AUTHENTICATION_FAILED: 'Authentication failed. Check the connection credentials.',
  BUCKET_NOT_FOUND: 'The bucket was not found. Check its name and endpoint.',
  ENDPOINT_ERROR: 'Cannot reach the S3 endpoint. Check the URL and network connection.',
  TLS_ERROR: 'The endpoint TLS certificate could not be verified.',
  THROTTLED: 'The S3 service is limiting requests. Wait briefly and retry.',
  SERVICE_UNAVAILABLE: 'The S3 service is temporarily unavailable. Retry later.',
  TIMEOUT: 'The S3 request timed out. Retry the operation.',
  INVALID_CONFIG: 'Invalid extra config. Supported options are s3.addressing_style, retries, connect_timeout, and read_timeout.',
  OBJECT_MISSING: 'The S3 object no longer exists. It may have been deleted. Refresh the folder before retrying this download.',
};

export function failure(code: string): S3Failure { return new S3Failure(code, messages[code] ?? 'The S3 request failed. Check the connection settings and retry.'); }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function seconds(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 600) throw failure('INVALID_CONFIG');
  return value * 1000;
}

/** Botocore settings used by existing connections are translated explicitly. */
export function createS3Client(connection: WorkerConnection): S3Client {
  const extra = connection.extraConfig ?? {};
  if (!record(extra) || Object.keys(extra).some(key => !['s3', 'retries', 'connect_timeout', 'read_timeout', 'signature_version'].includes(key))) throw failure('INVALID_CONFIG');
  const s3 = extra.s3 ?? {};
  const retries = extra.retries ?? {};
  if (!record(s3) || Object.keys(s3).some(key => key !== 'addressing_style') || !record(retries) || Object.keys(retries).some(key => !['mode', 'total_max_attempts', 'max_attempts'].includes(key))) throw failure('INVALID_CONFIG');
  const addressing = s3.addressing_style ?? 'path';
  if (addressing !== 'path' && addressing !== 'virtual' && addressing !== 'auto') throw failure('INVALID_CONFIG');
  if (extra.signature_version !== undefined && extra.signature_version !== 's3v4') throw failure('INVALID_CONFIG');
  if (retries.mode !== undefined && !['standard', 'adaptive', 'legacy'].includes(String(retries.mode))) throw failure('INVALID_CONFIG');
  const attempts = retries.total_max_attempts ?? (typeof retries.max_attempts === 'number' ? retries.max_attempts + 1 : 2);
  if (!Number.isInteger(attempts) || (attempts as number) < 1 || (attempts as number) > 10) throw failure('INVALID_CONFIG');
  const config: S3ClientConfig = {
    endpoint: connection.endpoint,
    region: connection.region,
    credentials: { accessKeyId: connection.accessKey, secretAccessKey: connection.secretKey, ...(connection.sessionToken ? { sessionToken: connection.sessionToken } : {}) },
    forcePathStyle: addressing === 'path',
    maxAttempts: attempts as number,
    requestHandler: new NodeHttpHandler({ connectionTimeout: seconds(extra.connect_timeout, 5000), requestTimeout: seconds(extra.read_timeout, 20000) }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  return new S3Client(config);
}

/** SDK and server messages may include signed URLs or credentials. Never forward them. */
export function safeS3Error(error: unknown): S3Failure {
  if (error instanceof S3Failure) return error;
  const value = record(error) ? error : {};
  const name = typeof value.name === 'string' ? value.name : '';
  const metadata = record(value.$metadata) ? value.$metadata : {};
  const status = typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
  let code = 'ENDPOINT_ERROR';
  if (['AccessDenied', 'AllAccessDisabled', 'Forbidden'].includes(name) || status === 403) code = 'ACCESS_DENIED';
  else if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'].includes(name)) code = 'AUTHENTICATION_FAILED';
  else if (name === 'NoSuchBucket') code = 'BUCKET_NOT_FOUND';
  else if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) code = 'OBJECT_MISSING';
  else if (['SlowDown', 'Throttling', 'TooManyRequestsException'].includes(name) || status === 429) code = 'THROTTLED';
  else if (status === 500 || status === 503) code = 'SERVICE_UNAVAILABLE';
  else if (['TimeoutError', 'RequestTimeout', 'AbortError'].includes(name) || value.code === 'ETIMEDOUT') code = 'TIMEOUT';
  else if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(String(value.code))) code = 'TLS_ERROR';
  return new S3Failure(code, messages[code], name || undefined, status);
}

export function decodeKey(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
  catch { throw failure('ENDPOINT_ERROR'); }
}

export function connectionRoot(connection: WorkerConnection): string {
  const root = connection.prefix ?? '';
  return root && !root.endsWith('/') ? `${root}/` : root;
}

export function assertPrefix(connection: WorkerConnection, prefix: string): void {
  if (typeof prefix !== 'string' || prefix && !prefix.endsWith('/') || !prefix.startsWith(connectionRoot(connection))) throw new S3Failure('INVALID_PREFIX', 'This folder is outside the configured connection prefix.');
}
