import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationRunner } from '../src/main/operation-runner';
import type { WorkerConnection } from '../src/main/connections';

const servers: Server[] = [];
const runners: OperationRunner[] = [];
const directories: string[] = [];
afterEach(async () => {
  runners.splice(0).forEach(runner => runner.dispose());
  servers.splice(0).forEach(server => { server.closeAllConnections(); server.close(); });
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(ignoredDeleteKey?: string) {
  const objects = new Map<string, Buffer>();
  const multipart = new Map<number, Buffer>();
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
    const body: Buffer[] = [];
    if (request.method === 'PUT' || request.method === 'POST' && url.searchParams.has('uploadId')) for await (const chunk of request) body.push(Buffer.from(chunk));
    else request.resume();
    const data = Buffer.concat(body);
    if (url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const contents = [...objects].filter(([name]) => name.startsWith(prefix)).map(([name, value]) => `<Contents><Key>${encodeURIComponent(name).replaceAll('%2F', '/')}</Key><Size>${value.length}</Size></Contents>`).join('');
      response.setHeader('Content-Type', 'application/xml');
      response.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
    } else if (request.method === 'POST' && url.searchParams.has('uploads')) {
      response.setHeader('Content-Type', 'application/xml');
      response.end('<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>');
    } else if (request.method === 'PUT' && url.searchParams.has('partNumber')) {
      multipart.set(Number(url.searchParams.get('partNumber')), data);
      response.setHeader('ETag', `"part-${url.searchParams.get('partNumber')}"`); response.end();
    } else if (request.method === 'POST' && url.searchParams.has('uploadId')) {
      objects.set(key, Buffer.concat([...multipart].sort(([a], [b]) => a - b).map(([, value]) => value)));
      const xml = '<CompleteMultipartUploadResult><Location>http://localhost/bucket/root/large.bin</Location><Bucket>bucket</Bucket><Key>root/large.bin</Key><ETag>"complete"</ETag></CompleteMultipartUploadResult>';
      response.setHeader('Content-Type', 'application/xml');
      response.setHeader('Content-Length', String(Buffer.byteLength(xml)));
      response.end(xml);
    } else if (request.method === 'PUT') {
      if (request.headers['x-amz-copy-source']) {
        const source = decodeURIComponent(String(request.headers['x-amz-copy-source'])).replace(/^\/?bucket\//, '');
        const value = objects.get(source);
        if (!value) { response.statusCode = 404; response.end(); return; }
        objects.set(key, value);
        response.setHeader('Content-Type', 'application/xml');
        response.end('<CopyObjectResult><ETag>"copy"</ETag></CopyObjectResult>');
      } else { objects.set(key, data); response.setHeader('ETag', '"put"'); response.end(); }
    } else if (request.method === 'GET') {
      if (key === 'root/slow.bin') { response.setHeader('Content-Length', '100'); response.write(Buffer.from('first chunk')); return; }
      const value = objects.get(key);
      if (!value) { response.statusCode = 404; response.end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      response.setHeader('Content-Length', String(value.length)); response.end(value);
    } else if (request.method === 'HEAD') {
      const value = objects.get(key);
      response.statusCode = value ? 200 : 404;
      if (value) response.setHeader('Content-Length', String(value.length));
      response.end();
    } else if (request.method === 'DELETE') { if (key !== ignoredDeleteKey) objects.delete(key); response.end(); }
    else { response.statusCode = 400; response.end(); }
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: 'root/', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-native-')); directories.push(directory);
  return { connection, objects, requests, directory };
}

describe('native S3 operations', () => {
  it('uploads and downloads without a Python process', async () => {
    const { connection, objects, directory } = await fixture();
    const input = join(directory, 'input.txt');
    const output = join(directory, 'output.txt');
    await writeFile(input, 'hello from typescript');
    const runner = new OperationRunner({}); runners.push(runner);
    expect(await runner.run('upload', { connection, key: 'root/input.txt', localPath: input, rootPath: directory }).promise).toEqual({ bytes: 21 });
    expect(objects.get('root/input.txt')?.toString()).toBe('hello from typescript');
    expect(await runner.run('download', { connection, key: 'root/input.txt', localPath: output, rootPath: directory }).promise).toEqual({ bytes: 21 });
    expect(await readFile(output, 'utf8')).toBe('hello from typescript');
  });

  it('reports a deleted object and leaves no destination file', async () => {
    const { connection, directory } = await fixture();
    const runner = new OperationRunner({}); runners.push(runner);
    const output = join(directory, 'missing.txt');
    await expect(runner.run('download', { connection, key: 'root/missing.txt', localPath: output, rootPath: directory }).promise).rejects.toThrow(/no longer exists/i);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies that a reported delete removed the object', async () => {
    const { connection, objects } = await fixture();
    objects.set('root/delete.txt', Buffer.from('x'));
    const runner = new OperationRunner({}); runners.push(runner);
    expect(await runner.run('delete', { connection, key: 'root/delete.txt', kind: 'file' }).promise).toEqual({ deleted: 1 });
    expect(objects.has('root/delete.txt')).toBe(false);
  });

  it('does not report success when the service ignores a delete', async () => {
    const { connection, objects } = await fixture('root/stubborn.txt');
    objects.set('root/stubborn.txt', Buffer.from('x'));
    const runner = new OperationRunner({}); runners.push(runner);
    await expect(runner.run('delete', { connection, key: 'root/stubborn.txt', kind: 'file' }).promise).rejects.toMatchObject({ code: 'DELETE_NOT_REMOVED' });
    expect(objects.has('root/stubborn.txt')).toBe(true);
  });

  it('uploads a multipart file without optional checksum headers', async () => {
    const { connection, objects, requests, directory } = await fixture();
    const data = Buffer.alloc(9 * 1024 * 1024, 13);
    const input = join(directory, 'large.bin'); await writeFile(input, data);
    const runner = new OperationRunner({}); runners.push(runner);
    const updates: number[] = [];
    const upload = runner.run('upload', { connection, key: 'root/large.bin', localPath: input, rootPath: directory }, progress => updates.push(progress.transferred));
    const result = await upload.promise;
    expect(result).toEqual({ bytes: data.length });
    expect(objects.get('root/large.bin')?.equals(data)).toBe(true);
    expect(requests.some(request => request.includes('partNumber=2'))).toBe(true);
    expect(updates.at(-1)).toBe(data.length);
  }, 60_000);

  it('copies and renames a file within the same connection', async () => {
    const { connection, objects } = await fixture();
    objects.set('root/source.txt', Buffer.from('source'));
    const runner = new OperationRunner({}); runners.push(runner);
    expect(await runner.run('copy', { connection, key: 'root/source.txt', destinationKey: 'root/copy.txt' }).promise).toEqual({ copied: 1 });
    expect(objects.get('root/copy.txt')?.toString()).toBe('source');
    expect(await runner.run('rename', { connection, key: 'root/copy.txt', destinationKey: 'root/renamed.txt' }).promise).toEqual({ renamed: 1 });
    expect(objects.has('root/copy.txt')).toBe(false);
    expect(objects.get('root/renamed.txt')?.toString()).toBe('source');
  });

  it('cancels a stalled download and removes its temporary file', async () => {
    const { connection, requests, directory } = await fixture();
    const runner = new OperationRunner({}); runners.push(runner);
    const handle = runner.run('download', { connection, key: 'root/slow.bin', localPath: join(directory, 'slow.bin'), rootPath: directory });
    for (let attempt = 0; attempt < 100 && !requests.some(request => request.includes('/root/slow.bin')); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(requests.some(request => request.includes('/root/slow.bin'))).toBe(true);
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readdir(directory)).toEqual([]);
  });
});
