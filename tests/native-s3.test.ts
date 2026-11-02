import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { S3Worker } from '../src/main/s3-worker';
import type { WorkerConnection } from '../src/main/connections';

const servers: Server[] = [];
const workers: S3Worker[] = [];
afterEach(async () => {
  workers.splice(0).forEach(worker => worker.dispose());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function fixture() {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url);
    const prefix = url.searchParams.get('prefix') ?? '';
    if (prefix === 'root/slow/') return;
    const delimiter = url.searchParams.get('delimiter');
    const token = url.searchParams.get('continuation-token');
    response.setHeader('Content-Type', 'application/xml');
    if (request.method === 'HEAD') {
      response.statusCode = prefix === 'root/exact.txt' ? 200 : 404;
      response.setHeader('Content-Length', prefix === 'root/exact.txt' ? '7' : '0');
      response.end();
      return;
    }
    const objects = [
      { key: 'root/a%2Bb.txt', size: 2 },
      { key: 'root/sub%20dir/file.txt', size: 5 },
      { key: 'root/sub%20dir/', size: 0 },
    ].filter(item => decodeURIComponent(item.key).startsWith(prefix));
    const content = delimiter ? objects.filter(item => !decodeURIComponent(item.key).slice(prefix.length).includes('/')) : objects;
    const prefixes = token && delimiter && objects.some(item => decodeURIComponent(item.key).startsWith(`${prefix}sub dir/`))
      ? '<CommonPrefixes><Prefix>root/sub%20dir/</Prefix></CommonPrefixes>' : '';
    const page = token ? content.slice(1) : content.slice(0, 1);
    const truncated = !token && objects.length > 1;
    response.end(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${truncated ? '<NextContinuationToken>next</NextContinuationToken>' : ''}${prefixes}${page.map(item => `<Contents><Key>${item.key}</Key><Size>${item.size}</Size><LastModified>2026-01-02T03:04:05.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const connection: WorkerConnection = {
    endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: 'root/', region: 'us-east-1',
    accessKey: 'test', secretKey: 'test', extraConfig: { s3: { addressing_style: 'path' } },
  };
  return { connection, requests };
}

describe('native S3 listing', () => {
  it('uses one paginated ListObjectsV2 request and decodes keys', async () => {
    const { connection, requests } = await fixture();
    const worker = new S3Worker({}); workers.push(worker);
    const first = await worker.list(connection, 'root/', 1);
    expect(first.entries[0]?.key).toBe('root/a+b.txt');
    expect(first.nextToken).toBe('next');
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get('max-keys')).toBe('1');
    expect(requests[0].searchParams.get('delimiter')).toBe('/');
  });

  it('calculates recursive statistics without fetching objects', async () => {
    const { connection, requests } = await fixture();
    const worker = new S3Worker({}); workers.push(worker);
    const stats = await worker.stats(connection, 'root/');
    expect(stats.fileCount).toBe(2);
    expect(stats.totalSize).toBe(7);
    expect(requests.every(request => request.searchParams.get('list-type') === '2')).toBe(true);
  });

  it('searches descendant file names using S3 keys', async () => {
    const { connection } = await fixture();
    const worker = new S3Worker({}); workers.push(worker);
    const result = await worker.search(connection, 'root/', 'recursive', 'exact', 'file.txt');
    expect(result.entries.map(entry => entry.key)).toEqual(['root/sub dir/file.txt']);
  });

  it('aborts an active request when the worker is disposed', async () => {
    const { connection, requests } = await fixture();
    const worker = new S3Worker({}); workers.push(worker);
    const pending = worker.list(connection, 'root/slow/');
    for (let attempt = 0; attempt < 100 && !requests.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(requests).toHaveLength(1);
    worker.dispose();
    await expect(pending).rejects.toThrow(/stopped/);
  });
});
