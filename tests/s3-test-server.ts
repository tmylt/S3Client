import S3rver from 's3rver';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    if (entity === '&amp;') return '&';
    if (entity === '&lt;') return '<';
    if (entity === '&gt;') return '>';
    if (entity === '&quot;') return '"';
    if (entity === '&apos;') return "'";
    const numeric = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff ? String.fromCodePoint(numeric) : entity;
  });
}

/** s3rver leaves EncodingType=url unimplemented; adapt only listing key fields. */
export function encodeListingXML(xml: string, formEncoded = false): Buffer {
  return Buffer.from(xml.replace(/(<(?:Key|Prefix)>)([^<]*)(<\/(?:Key|Prefix)>)/g, (_whole, open: string, key: string, close: string) => {
    const encoded = encodeURIComponent(decodeXml(key)).replace(/%2F/gi, '/');
    return `${open}${formEncoded ? encoded.replace(/%20/g, '+') : encoded}${close}`;
  }));
}

/** s3rver uses decodeURI for this header; preserve reserved key characters through that decoder. */
export function adaptCopySourceForFixture(value: string): string {
  return encodeURI(decodeURIComponent(value));
}

/** s3rver ignores a zero end offset in bytes=0-0; trim its full response to one byte. */
export function fixZeroRangeForFixture(headers: IncomingHttpHeaders, body: Buffer): { headers: IncomingHttpHeaders; body: Buffer } {
  const range = /^bytes 0-\d+\/(\d+)$/.exec(String(headers['content-range'] ?? ''));
  if (!range || body.length === 0) throw new Error('The fixture server returned an invalid zero-range response.');
  const { 'transfer-encoding': _transferEncoding, ...remaining } = headers;
  return { headers: { ...remaining, 'content-range': `bytes 0-0/${range[1]}`, 'content-length': '1' }, body: body.subarray(0, 1) };
}

/** Disposable loopback S3 service and direct JavaScript SDK client for fixtures.
 * s3rver's pagination tokens use DES, so test commands enable Node's OpenSSL legacy provider.
 */
export class LocalS3 {
  private constructor(
    readonly bucket: string,
    readonly endpoint: string,
    readonly client: S3Client,
    private readonly server: S3rver,
    private readonly directory: string,
  ) {}

  static async start(bucket: string): Promise<LocalS3> {
    const directory = await mkdtemp(join(tmpdir(), 's3-client-fixture-'));
    const server = new S3rver({ address: '127.0.0.1', port: 0, directory, silent: true, configureBuckets: [{ name: bucket, configs: [] }] });
    try {
      const address = await server.run();
      const endpoint = `http://127.0.0.1:${address.port}`;
      const client = new S3Client({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' }, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
      return new LocalS3(bucket, endpoint, client, server, directory);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async put(key: string, body: Buffer | string, contentType?: string): Promise<void> {
    const bytes = typeof body === 'string' ? Buffer.from(body) : body;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentLength: bytes.length, ...(contentType ? { ContentType: contentType } : {}) }));
  }

  async putAll(objects: Iterable<readonly [string, Buffer | string]>, concurrency = 16): Promise<void> {
    const entries = [...objects];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= entries.length) return;
        await this.put(entries[index][0], entries[index][1]);
      }
    }));
  }

  async keys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      keys.push(...(page.Contents ?? []).flatMap(item => item.Key ? [item.Key] : []));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !token) throw new Error('The fixture returned no continuation token.');
    } while (token);
    return keys.sort();
  }

  async bytes(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body) throw new Error('The fixture object has no body.');
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async size(key: string): Promise<number> {
    const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    if (typeof result.ContentLength !== 'number') throw new Error('The fixture object has no size.');
    return result.ContentLength;
  }

  async digest(key: string): Promise<{ size: number; sha256: string }> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || typeof result.ContentLength !== 'number') throw new Error('The fixture object is incomplete.');
    const hash = createHash('sha256');
    for await (const chunk of result.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    return { size: result.ContentLength, sha256: hash.digest('hex') };
  }

  async delete(key: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })); }

  async close(): Promise<void> {
    this.client.destroy();
    await this.server.close();
    await rm(this.directory, { recursive: true, force: true });
  }
}
