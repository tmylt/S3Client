import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationRunner } from '../src/main/operation-runner';
import type { WorkerConnection } from '../src/main/connections';
import { probeParallelResume } from '../src/main/parallel-resume';
import { openDirectoryAnchor } from '../src/main/transfer-paths';

const servers: Server[] = [];
const runners: OperationRunner[] = [];
const directories: string[] = [];
afterEach(async () => {
  runners.splice(0).forEach(runner => runner.dispose());
  servers.splice(0).forEach(server => { server.closeAllConnections(); server.close(); });
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('removes an orphan partial left before its checkpoint was created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const id = randomUUID();
  await writeFile(join(directory, `.s3client-${id}.part`), Buffer.from('orphan'));
  const anchor = await openDirectoryAnchor(directory, directory);
  try { expect(await probeParallelResume(anchor, id, { endpoint: 'http://example.test', bucket: 'bucket', key: 'file.bin' })).toBeNull(); }
  finally { await anchor.close(); }
  expect(await readdir(directory)).toEqual([]);
});

it('skips parallel negotiation for a known small file', async () => {
  let headRequests = 0;
  const body = Buffer.from('small direct download');
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') { headRequests++; response.writeHead(200, { 'Content-Length': body.length, ETag: '"small"' }); response.end(); return; }
    response.writeHead(200, { 'Content-Length': body.length, ETag: '"small"' }); response.end(body);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const destination = join(directory, 'output.bin');
  const runner = new OperationRunner(); runners.push(runner);
  expect(await runner.run('download', { connection, key: 'small.bin', localPath: destination, rootPath: directory, resumeId: randomUUID(), sizeHint: body.length }).promise).toEqual({ bytes: body.length });
  expect(headRequests).toBe(0);
  expect(await readFile(destination)).toEqual(body);
});

it('downloads a large object with four disjoint concurrent ranges', async () => {
  const size = 32 * 1024 * 1024;
  const original = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) original[index] = index % 251;
  const ranges: string[] = [];
  const pending: Array<{ response: ServerResponse; start: number; end: number }> = [];
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Length': size, ETag: '"parallel-v1"' }); response.end(); return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) { response.writeHead(400, { 'Content-Type': 'application/xml' }); response.end('<Error><Code>RangeRequired</Code></Error>'); return; }
    const start = Number(range[1]); const end = Number(range[2]);
    ranges.push(request.headers.range!);
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"parallel-v1"' });
    response.flushHeaders();
    if (start === 0) { response.end(original.subarray(start, end + 1)); return; }
    pending.push({ response, start, end });
    if (pending.length === 3) for (const item of pending) item.response.end(original.subarray(item.start, item.end + 1));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const destination = join(directory, 'output.bin');
  const runner = new OperationRunner(); runners.push(runner);
  const operation = runner.run('download', { connection, key: 'large.bin', localPath: destination, rootPath: directory, resumeId: randomUUID() });
  expect(await operation.promise).toEqual({ bytes: size });
  expect((await readFile(destination)).equals(original)).toBe(true);
  expect(ranges.sort()).toEqual(Array.from({ length: 4 }, (_, index) => `bytes=${index * 8 * 1024 * 1024}-${(index + 1) * 8 * 1024 * 1024 - 1}`).sort());
});

it('resumes only completed chunks when the sparse partial already has the full file size', async () => {
  const chunk = 8 * 1024 * 1024;
  const size = 4 * chunk;
  const original = Buffer.alloc(size, 91);
  const ranges: string[] = [];
  let resumed = false;
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Length': size, ETag: '"sparse-v1"' }); response.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) { response.writeHead(400); response.end(); return; }
    const start = Number(range[1]); const end = Number(range[2]);
    ranges.push(request.headers.range!);
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"sparse-v1"' });
    response.flushHeaders();
    if (resumed || start === 3 * chunk) response.end(original.subarray(start, end + 1));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const id = randomUUID();
  const params = { connection, key: 'large.bin', localPath: join(directory, 'output.bin'), rootPath: directory, resumeId: id };
  const progress: number[] = [];
  const runner = new OperationRunner(); runners.push(runner);
  const first = runner.run('download', params, value => progress.push(value.transferred));
  await vi.waitFor(() => expect(progress).toContain(chunk), { timeout: 5000 });
  first.cancel();
  await expect(first.promise).rejects.toMatchObject({ code: 'CANCELLED' });
  expect((await stat(join(directory, `.s3client-${id}.part`))).size).toBe(size);
  const checkpoint = JSON.parse(await readFile(join(directory, `.s3client-${id}.resume`), 'utf8'));
  expect(checkpoint.version).toBe(2);
  expect(checkpoint.completed).toBe('CA==');
  const beforeResume = ranges.length;
  resumed = true;
  runner.dispose();
  const restarted = new OperationRunner(); runners.push(restarted);
  expect(await restarted.run('download', params).promise).toEqual({ bytes: size });
  expect(ranges.slice(beforeResume).sort()).toEqual([0, 1, 2].map(index => `bytes=${index * chunk}-${(index + 1) * chunk - 1}`).sort());
  expect((await readFile(params.localPath)).equals(original)).toBe(true);
  expect(await readdir(directory)).toEqual(['output.bin']);
});

it.each(['ignored', 'rejected', 'changed'] as const)('restarts with a whole-object GET when Range is %s', async mode => {
  const size = 32 * 1024 * 1024;
  const original = Buffer.alloc(size, 17);
  const replacement = Buffer.alloc(size, 29);
  const requests: Array<string | null> = [];
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Length': size, ETag: '"first"' }); response.end(); return; }
    const range = typeof request.headers.range === 'string' ? request.headers.range : null;
    requests.push(range);
    if (range && mode === 'ignored') { response.writeHead(200, { 'Content-Length': size, ETag: '"first"' }); response.end(original); return; }
    if (range) { response.writeHead(mode === 'changed' ? 412 : 416, { 'Content-Type': 'application/xml' }); response.end(`<Error><Code>${mode === 'changed' ? 'PreconditionFailed' : 'InvalidRange'}</Code></Error>`); return; }
    response.writeHead(200, { 'Content-Length': size, ETag: mode === 'changed' ? '"second"' : '"first"' });
    response.end(mode === 'changed' ? replacement : original);
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const destination = join(directory, 'output.bin');
  const notices: string[] = [];
  const runner = new OperationRunner(); runners.push(runner);
  expect(await runner.run('download', { connection, key: 'large.bin', localPath: destination, rootPath: directory, resumeId: randomUUID() }, value => { if (value.resumeNote) notices.push(value.resumeNote); }).promise).toEqual({ bytes: size });
  expect(requests).toEqual([`bytes=0-${8 * 1024 * 1024 - 1}`, null]);
  expect((await readFile(destination)).equals(mode === 'changed' ? replacement : original)).toBe(true);
  expect(notices.join(' ')).toMatch(mode === 'changed' ? /object changed/i : /range.*not supported/i);
  expect(await readdir(directory)).toEqual(['output.bin']);
});

it('keeps completed chunks after a transient ranged request failure', async () => {
  const chunk = 8 * 1024 * 1024;
  const size = 4 * chunk;
  const original = Buffer.alloc(size, 53);
  const requests: string[] = [];
  let failOnce = true;
  let firstCommitted = false;
  let pendingFailure: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Length': size, ETag: '"stable"' }); response.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!range) { response.writeHead(400); response.end(); return; }
    const start = Number(range[1]); const end = Number(range[2]);
    requests.push(request.headers.range!);
    if (start === chunk && failOnce) {
      failOnce = false;
      pendingFailure = response;
      if (firstCommitted) { response.writeHead(403, { 'Content-Type': 'application/xml' }); response.end('<Error><Code>AccessDenied</Code></Error>'); }
      return;
    }
    response.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"stable"' });
    response.end(original.subarray(start, end + 1));
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const id = randomUUID();
  const params = { connection, key: 'large.bin', localPath: join(directory, 'output.bin'), rootPath: directory, resumeId: id };
  const runner = new OperationRunner(); runners.push(runner);
  await expect(runner.run('download', params, value => {
    if (value.transferred >= chunk && !firstCommitted) {
      firstCommitted = true;
      if (pendingFailure) { pendingFailure.writeHead(403, { 'Content-Type': 'application/xml' }); pendingFailure.end('<Error><Code>AccessDenied</Code></Error>'); }
    }
  }).promise).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
  const checkpoint = JSON.parse(await readFile(join(directory, `.s3client-${id}.resume`), 'utf8'));
  expect(checkpoint.version).toBe(2);
  expect(Buffer.from(checkpoint.completed, 'base64')[0] & 1).toBe(1);
  const beforeRetry = requests.length;
  expect(await runner.run('download', params).promise).toEqual({ bytes: size });
  expect(requests.slice(beforeRetry)).not.toContain(`bytes=0-${chunk - 1}`);
  expect((await readFile(params.localPath)).equals(original)).toBe(true);
  expect(await readdir(directory)).toEqual(['output.bin']);
});

it('reports the first ranged error when other requests are aborted', async () => {
  const chunk = 8 * 1024 * 1024;
  const size = 4 * chunk;
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Length': size, ETag: '"stable"' }); response.end(); return; }
    const start = Number(/^bytes=(\d+)-/.exec(request.headers.range ?? '')?.[1]);
    if (start === chunk) { response.writeHead(403, { 'Content-Type': 'application/xml' }); response.end('<Error><Code>AccessDenied</Code></Error>'); return; }
    response.writeHead(206, { 'Content-Length': chunk, 'Content-Range': `bytes ${start}-${start + chunk - 1}/${size}`, ETag: '"stable"' });
    response.flushHeaders();
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-parallel-')); directories.push(directory);
  const runner = new OperationRunner(); runners.push(runner);
  await expect(runner.run('download', { connection, key: 'large.bin', localPath: join(directory, 'output.bin'), rootPath: directory, resumeId: randomUUID() }).promise).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
});
