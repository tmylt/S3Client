import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoEvent, VideoOpen } from '../shared/types';
import type { ConnectionStore, WorkerConnection } from './connections';
import { createS3Client, safeS3Error } from './s3-client';

interface Session {
  id: string;
  connectionId: string;
  connection: WorkerConnection;
  key: string;
  client: S3Client;
  server: Server;
  controller: AbortController;
  mode: 'stream' | 'download';
  total: number;
  url: string;
  directory?: string;
  ready: boolean;
  started: boolean;
}

const genericError = 'Could not prepare this video. Check download permission and the S3 connection.';
const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/;
const requestedRange = /^bytes=(\d*)-(\d*)$/;

function parseRange(value: string | undefined, size: number): { status: number; start: number; end: number } | null {
  if (!value) return { status: 200, start: 0, end: size - 1 };
  const match = requestedRange.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  if (!match[1]) {
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    return { status: 206, start: Math.max(0, size - count), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < size && end >= start ? { status: 206, start, end } : null;
}

function closeBody(body: unknown): void { if (body && typeof body === 'object' && 'destroy' in body && typeof body.destroy === 'function') body.destroy(); }

/** The renderer receives only a private loopback URL, never S3 credentials. */
export class VideoService {
  private readonly sessions = new Map<string, Session>();
  private disposed = false;

  constructor(private readonly store: ConnectionStore, _options: object, private readonly emit: (event: VideoEvent) => void) {}

  async open(connectionId: unknown, key: unknown): Promise<VideoOpen> {
    if (this.disposed) throw new Error('The video player has stopped.');
    if (typeof key !== 'string' || !/\.mp4$/i.test(key)) throw new Error('Only MP4 files can be played here.');
    const authorized = await this.store.forOperation(connectionId, key, 'download', 'file');
    const client = createS3Client(authorized.connection);
    let mode: 'stream' | 'download';
    let total: number;
    try {
      let probe;
      try { probe = await client.send(new GetObjectCommand({ Bucket: authorized.connection.bucket, Key: authorized.key, Range: 'bytes=0-0' })); }
      catch (cause) {
        const safe = safeS3Error(cause);
        if (![400, 405, 416, 501].includes(safe.httpStatus ?? 0) && !['InvalidRange', 'NotImplemented', 'UnsupportedOperation'].includes(safe.serviceCode ?? '')) throw cause;
        probe = await client.send(new GetObjectCommand({ Bucket: authorized.connection.bucket, Key: authorized.key }));
      }
      const found = contentRange.exec(probe.ContentRange ?? '');
      const rangeTotal = found ? Number(found[3]) : 0;
      if (probe.$metadata.httpStatusCode === 206 && found && found[1] === '0' && found[2] === '0' && probe.ContentLength === 1 && Number.isSafeInteger(rangeTotal) && rangeTotal > 0) {
        mode = 'stream'; total = rangeTotal;
      } else if (probe.$metadata.httpStatusCode === 200 && Number.isSafeInteger(probe.ContentLength) && (probe.ContentLength ?? 0) > 0) {
        mode = 'download'; total = probe.ContentLength!;
      } else throw new Error(genericError);
      closeBody(probe.Body);
    } catch { client.destroy(); throw new Error(genericError); }
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => { void this.respond(id, token, request, response); });
    const session: Session = { id, connectionId: connectionId as string, connection: authorized.connection, key: authorized.key, client, server, controller: new AbortController(), mode, total, url: '', ready: false, started: false };
    this.sessions.set(id, session);
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error(genericError);
      session.url = `http://127.0.0.1:${address.port}/v/${token}`;
      return { id, mode, total, ...(mode === 'stream' ? { url: session.url } : {}) };
    } catch { this.close(id); throw new Error(genericError); }
  }

  private async respond(id: string, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || request.headers.host !== new URL(session.url).host || request.url !== `/v/${token}` || !['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(404, { 'Content-Length': '0', 'Cache-Control': 'no-store' }); response.end(); return;
    }
    if (session.mode === 'download' && !session.ready) { response.writeHead(503, { 'Content-Length': '0' }); response.end(); return; }
    const range = parseRange(request.headers.range, session.total);
    if (!range) { response.writeHead(416, { 'Content-Length': '0', 'Content-Range': `bytes */${session.total}` }); response.end(); return; }
    const length = range.end - range.start + 1;
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': String(length), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${session.total}` } : {}) };
    if (request.method === 'HEAD') { response.writeHead(range.status, headers); response.end(); return; }
    if (session.mode === 'download') {
      const { createReadStream } = await import('node:fs');
      const stream = createReadStream(join(session.directory!, 'video.mp4'), { start: range.start, end: range.end });
      stream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.writeHead(range.status, headers); stream.pipe(response); return;
    }
    const controller = new AbortController();
    const closed = () => controller.abort();
    response.once('close', closed);
    try {
      const remote = await session.client.send(new GetObjectCommand({ Bucket: session.connection.bucket, Key: session.key, ...(range.status === 206 ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: controller.signal });
      if (remote.$metadata.httpStatusCode !== range.status || remote.ContentLength !== length || range.status === 206 && remote.ContentRange !== `bytes ${range.start}-${range.end}/${session.total}` || !remote.Body) {
        closeBody(remote.Body); response.writeHead(502, { 'Content-Length': '0' }); response.end(); return;
      }
      response.writeHead(range.status, headers);
      try {
        for await (const chunk of remote.Body as AsyncIterable<Uint8Array>) {
          if (controller.signal.aborted) break;
          if (!response.write(chunk)) await Promise.race([once(response, 'drain'), once(response, 'close')]);
        }
        response.end();
      } finally { closeBody(remote.Body); }
    } catch { if (!response.headersSent) response.writeHead(502, { 'Content-Length': '0' }); response.end(); }
    finally { response.off('close', closed); }
  }

  start(id: unknown): void {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session || session.mode !== 'download' || session.started) throw new Error('This video preparation is no longer available.');
    session.started = true;
    void this.downloadFull(session);
  }

  private async downloadFull(session: Session): Promise<void> {
    let temporary = '';
    try {
      session.directory = await mkdtemp(join(tmpdir(), 's3-client-video-'));
      temporary = join(session.directory, 'video.mp4.part');
      const remote = await session.client.send(new GetObjectCommand({ Bucket: session.connection.bucket, Key: session.key }), { abortSignal: session.controller.signal });
      if (!remote.Body || remote.ContentLength !== session.total) throw new Error(genericError);
      const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      let received = 0, last = -Infinity;
      try {
        for await (const chunk of remote.Body as AsyncIterable<Uint8Array>) {
          if (session.controller.signal.aborted) return;
          received += chunk.length;
          if (!output.write(chunk)) await once(output, 'drain');
          const now = performance.now();
          if (now - last >= 200) { this.emit({ id: session.id, event: 'progress', received, total: session.total }); last = now; }
        }
        output.end(); await once(output, 'finish');
      } finally { closeBody(remote.Body); output.destroy(); }
      if (received !== session.total) throw new Error(genericError);
      await rename(temporary, join(session.directory, 'video.mp4'));
      session.ready = true;
      this.emit({ id: session.id, event: 'ready', url: session.url, total: session.total });
    } catch { if (!session.controller.signal.aborted) this.emit({ id: session.id, event: 'error', message: genericError }); }
    finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      if (!this.sessions.has(session.id) && session.directory) await rm(session.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  close(id: unknown): void {
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session) return;
    this.sessions.delete(session.id);
    session.controller.abort();
    session.server.close();
    session.client.destroy();
    if (session.directory) void rm(session.directory, { recursive: true, force: true });
  }

  closeConnection(id: string): void { for (const session of this.sessions.values()) if (session.connectionId === id) this.close(session.id); }
  closeAll(): void { for (const id of this.sessions.keys()) this.close(id); }
  dispose(): void { this.disposed = true; this.closeAll(); }
}
