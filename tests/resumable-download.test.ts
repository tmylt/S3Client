import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
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
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(mode: 'range' | 'ignored' | 'changed' | 'rejected' | 'denied', failFirst = false) {
  const original = Buffer.alloc(256 * 1024, 42);
  const changed = Buffer.alloc(256 * 1024, 77);
  const requests: { range?: string; ifMatch?: string }[] = [];
  let first = true;
  let denied = false;
  const server = createServer((request, response) => {
    if (request.method === 'HEAD') {
      response.setHeader('Content-Length', String(original.length));
      response.setHeader('ETag', '"first"'); response.end(); return;
    }
    if (request.method !== 'GET') { response.statusCode = 400; response.end(); return; }
    const range = request.headers.range;
    const ifMatch = request.headers['if-match'];
    requests.push({ ...(typeof range === 'string' ? { range } : {}), ...(typeof ifMatch === 'string' ? { ifMatch } : {}) });
    if (first) {
      first = false;
      response.setHeader('Content-Length', String(original.length));
      response.setHeader('ETag', '"first"');
      response.write(original.subarray(0, 32 * 1024));
      if (failFirst) setTimeout(() => response.destroy(), 100);
      return;
    }
    if (range && (mode === 'changed' || mode === 'rejected')) {
      response.statusCode = mode === 'changed' ? 412 : 416;
      response.end(`<Error><Code>${mode === 'changed' ? 'PreconditionFailed' : 'InvalidRange'}</Code></Error>`); return;
    }
    if (range && mode === 'denied' && !denied) {
      denied = true;
      response.statusCode = 403;
      response.end('<Error><Code>AccessDenied</Code></Error>'); return;
    }
    if (range && (mode === 'range' || mode === 'denied')) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1]);
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${original.length - 1}/${original.length}`);
      response.setHeader('Content-Length', String(original.length - start));
      response.setHeader('ETag', '"first"');
      response.end(original.subarray(start)); return;
    }
    const body = mode === 'changed' ? changed : original;
    response.setHeader('Content-Length', String(body.length));
    response.setHeader('ETag', mode === 'changed' ? '"second"' : '"first"');
    response.end(body);
  });
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection: WorkerConnection = { endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'test', secretKey: 'test' };
  const directory = await mkdtemp(join(tmpdir(), 's3-resume-')); directories.push(directory);
  const id = randomUUID();
  const output = join(directory, 'output.bin');
  const params = { connection, key: 'file.bin', localPath: output, rootPath: directory, resumeId: id };
  const runner = new OperationRunner(); runners.push(runner);
  const firstAttempt = runner.run('download', params);
  const settled = firstAttempt.promise.catch(() => undefined);
  const part = join(directory, `.s3client-${id}.part`);
  try { await vi.waitFor(async () => expect((await stat(part)).size).toBeGreaterThan(0), { timeout: 2000 }); }
  catch (cause) { firstAttempt.cancel(); await settled; throw cause; }
  if (!failFirst) firstAttempt.cancel();
  if (failFirst) await expect(firstAttempt.promise).rejects.toThrow();
  else await expect(firstAttempt.promise).rejects.toMatchObject({ code: 'CANCELLED' });
  return { runner, params, part, output, original, changed, requests, directory };
}

it.each([{ reason: 'stop', failFirst: false }, { reason: 'failure', failFirst: true }])('retains partial bytes after $reason and resumes only the remaining range', async ({ failFirst }) => {
  const { runner, params, part, output, original, requests, directory } = await fixture('range', failFirst);
  const offset = (await stat(part)).size;
  expect(offset).toBeGreaterThan(0);
  expect(await readdir(directory)).toContain(`.s3client-${params.resumeId}.resume`);
  const progress: number[] = [];
  runner.dispose();
  const restarted = new OperationRunner(); runners.push(restarted);
  expect(await restarted.run('download', params, value => progress.push(value.transferred)).promise).toEqual({ bytes: original.length });
  expect(await readFile(output)).toEqual(original);
  expect(requests[1]).toEqual({ range: `bytes=${offset}-`, ifMatch: '"first"' });
  expect(progress[0]).toBe(offset);
  expect(await readdir(directory)).toEqual(['output.bin']);
});

it('keeps a partial download when a ranged retry fails and resumes on the next attempt', async () => {
  const { runner, params, part, output, original, requests } = await fixture('denied');
  const offset = (await stat(part)).size;
  await expect(runner.run('download', params).promise).rejects.toThrow(/permission denied/i);
  expect((await stat(part)).size).toBe(offset);
  expect(await runner.run('download', params).promise).toEqual({ bytes: original.length });
  expect(await readFile(output)).toEqual(original);
  expect(requests.slice(1).map(item => item.range)).toEqual([`bytes=${offset}-`, `bytes=${offset}-`]);
});

it.each(['ignored', 'changed', 'rejected'] as const)('restarts cleanly when the endpoint %s the requested range', async mode => {
  const { runner, params, output, original, changed, requests, directory } = await fixture(mode);
  const notices: string[] = [];
  expect(await runner.run('download', params, value => { if (value.resumeNote) notices.push(value.resumeNote); }).promise).toEqual({ bytes: original.length });
  expect(await readFile(output)).toEqual(mode === 'changed' ? changed : original);
  expect(requests[1].range).toMatch(/^bytes=\d+-$/);
  if (mode !== 'ignored') expect(requests[2]).toEqual({});
  expect(notices.join(' ')).toMatch(mode === 'changed' ? /object changed/i : /range.*not supported/i);
  expect(await readdir(directory)).toEqual(['output.bin']);
});
