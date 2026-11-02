import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { ConnectionStore } from '../src/main/connections';
import { VideoService } from '../src/main/video-service';

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

it('requires MP4 type, connection scope, and download permission before starting a video worker', async () => {
  const path = await mkdtemp(join(tmpdir(), 's3-video-'));
  directories.push(path);
  const store = new ConnectionStore(path, {
    isAvailable: async () => true,
    encrypt: async value => Buffer.from(value),
    decrypt: async value => value.toString(),
  });
  const saved = await store.save({ name: 'Private', endpoint: 'https://s3.example.com', bucket: 'bucket', prefix: 'allowed/', region: null, accessKey: 'ak', secretKey: 'sk', permissions: { download: false, upload: false, delete: false } });
  const service = new VideoService(store, {}, () => {});
  await expect(service.open(saved.id, 'allowed/video.txt')).rejects.toThrow(/MP4/);
  await expect(service.open(saved.id, 'allowed/video.mp4')).rejects.toThrow(/not allowed/);
  await store.save({ id: saved.id, name: saved.name, endpoint: saved.endpoint, bucket: saved.bucket, prefix: saved.prefix, region: saved.region, accessKey: '', secretKey: '', permissions: { download: true, upload: false, delete: false } });
  await expect(service.open(saved.id, 'elsewhere/video.mp4')).rejects.toThrow(/outside/);
  service.dispose();
});

it('streams an MP4 through a private range proxy using the native SDK', async () => {
  const server = createServer((request, response) => {
    const range = request.headers.range;
    response.statusCode = range ? 206 : 200;
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('Content-Range', range === 'bytes=0-0' ? 'bytes 0-0/6' : 'bytes 2-4/6');
    response.setHeader('Content-Length', range === 'bytes=0-0' ? '1' : range ? '3' : '6');
    response.end(range === 'bytes=0-0' ? 'a' : range ? 'cde' : 'abcdef');
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const path = await mkdtemp(join(tmpdir(), 's3-video-')); directories.push(path);
  const store = new ConnectionStore(path, { isAvailable: async () => true, encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() });
  const saved = await store.save({ name: 'Video', endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'ak', secretKey: 'sk', permissions: { download: true, upload: false, delete: false } });
  const service = new VideoService(store, {}, () => {});
  try {
    const opened = await service.open(saved.id, 'video.mp4');
    expect(opened.mode).toBe('stream');
    const response = await fetch(opened.url!, { headers: { Range: 'bytes=2-4' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('cde');
    service.close(opened.id);
  } finally { service.dispose(); }
});

it('downloads once before playback when the endpoint ignores Range', async () => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Length', '6');
    response.end('abcdef');
  });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const path = await mkdtemp(join(tmpdir(), 's3-video-')); directories.push(path);
  const store = new ConnectionStore(path, { isAvailable: async () => true, encrypt: async value => Buffer.from(value), decrypt: async value => value.toString() });
  const saved = await store.save({ name: 'Video', endpoint: `http://127.0.0.1:${address.port}`, bucket: 'bucket', prefix: '', region: 'us-east-1', accessKey: 'ak', secretKey: 'sk', permissions: { download: true, upload: false, delete: false } });
  let ready!: (url: string) => void;
  const readyURL = new Promise<string>(resolve => { ready = resolve; });
  const service = new VideoService(store, {}, event => { if (event.event === 'ready') ready(event.url); });
  try {
    const opened = await service.open(saved.id, 'video.mp4');
    expect(opened.mode).toBe('download');
    service.start(opened.id);
    const url = await readyURL;
    const response = await fetch(url, { headers: { Range: 'bytes=1-3' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('bcd');
  } finally { service.dispose(); }
});
