import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transferPaths from '../src/main/transfer-paths';
import { ConnectionStore } from '../src/main/connections';
import { TransferService } from '../src/main/transfer-service';
import { OperationError, type OperationRunner } from '../src/main/operation-runner';

const paths: string[] = []; const services: TransferService[] = [];
const settings = { name: 'Storage', endpoint: 'https://synthetic.invalid', bucket: 'bucket', prefix: 'root/', region: null, accessKey: 'dummy', secretKey: 'dummy', permissions: { download: true, upload: true, delete: true } };
async function setup(run: (...args: any[]) => any) {
  const path = await mkdtemp(join(tmpdir(), 's3-transfer-service-')); paths.push(path);
  const store = new ConnectionStore(join(path, 'settings'), { isAvailable: async () => false, encrypt: async () => Buffer.alloc(0), decrypt: async () => '' });
  const saved = await store.save(settings); const changed = vi.fn();
  const service = new TransferService(store, { run } as Pick<OperationRunner, 'run'>, join(path, 'settings'), { storageChanged: changed });
  services.push(service); await service.initialize(); const destination = join(path, 'save'); await mkdir(destination);
  return { service, store, saved, destination, changed };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(services.splice(0).map(service => service.dispose())); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('transfer service', () => {
  it('shows a deleted S3 object as a failed download task', async () => {
    const missing = new OperationError('OBJECT_MISSING', 'The S3 object no longer exists. It may have been deleted. Refresh the folder before retrying this download.');
    const { service, saved, destination } = await setup(() => ({ cancel: vi.fn(), promise: Promise.reject(missing) }));
    await service.startDownload(saved.id, 'root/deleted.txt', 'file', destination);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks[0]?.status).toBe('failed'));
    expect((await service.snapshot()).tasks[0].error).toBe(missing.message);
  });

  it('marks a folder download preparation failed if the folder disappeared before scanning', async () => {
    const { service, saved, destination } = await setup(() => ({ cancel: vi.fn(), promise: Promise.resolve({ objects: [] }) }));
    await service.startDownload(saved.id, 'root/deleted/', 'folder', destination);
    await vi.waitFor(async () => expect((await service.snapshot()).preparations[0]?.status).toBe('failed'));
    expect((await service.snapshot()).preparations[0].error).toMatch(/folder no longer exists|deleted/i);
  });
  it('renames within the current folder only after checking upload and delete permissions', async () => {
    const run = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve({ renamed: 1 }) }));
    const { service, saved, changed } = await setup(run);
    await expect(service.renameEntry(saved.id, 'root/a (6).db', 'file', 'renamed.db')).resolves.toBe(1);
    expect(run).toHaveBeenCalledWith('rename', expect.objectContaining({ key: 'root/a (6).db', destinationKey: 'root/renamed.db', kind: 'file' }));
    expect(changed).toHaveBeenCalledWith(saved.id);
    await expect(service.renameEntry(saved.id, 'root/a (6).db', 'file', 'sub/name')).rejects.toThrow(/name|slash/i);
    await expect(service.renameEntry(saved.id, 'root/a (6).db', 'file', 'a (6).db')).rejects.toThrow(/different|same/i);
    await expect(service.renameEntry(saved.id, 'root/', 'folder', 'new-root')).rejects.toThrow(/root/i);
    expect(run).toHaveBeenCalledOnce();
  });

  it('refuses rename when either upload or delete is disabled', async () => {
    const run = vi.fn(); const { service, store, saved } = await setup(run);
    await store.save({ ...settings, id: saved.id, permissions: { download: true, upload: false, delete: true } });
    await expect(service.renameEntry(saved.id, 'root/file', 'file', 'other')).rejects.toThrow(/upload|allow/i);
    await store.save({ ...settings, id: saved.id, permissions: { download: true, upload: true, delete: false } });
    await expect(service.renameEntry(saved.id, 'root/file', 'file', 'other')).rejects.toThrow(/delete|allow/i);
    expect(run).not.toHaveBeenCalled();
  });
  it('copies only within its connection, preserves the requested name, and refreshes storage', async () => {
    const run = vi.fn(() => ({ cancel: vi.fn(), promise: Promise.resolve({ copied: 1 }) }));
    const { service, saved, changed } = await setup(run);
    await expect(service.copyEntry(saved.id, 'root/a (6).db', 'file', 'root/archive/', 'renamed.db')).resolves.toBe(1);
    expect(run).toHaveBeenCalledWith('copy', expect.objectContaining({ key: 'root/a (6).db', destinationKey: 'root/archive/renamed.db', kind: 'file' }));
    expect(changed).toHaveBeenCalledWith(saved.id);
    await expect(service.copyEntry(saved.id, 'root/a (6).db', 'file', 'other/', 'x')).rejects.toThrow(/prefix|outside/i);
    await expect(service.copyEntry(saved.id, 'root/a (6).db', 'file', 'root/', 'bad/name')).rejects.toThrow(/name/i);
    expect(run).toHaveBeenCalledOnce();
  });

  it('requires upload permission and prevents a folder from copying into itself', async () => {
    const run = vi.fn(); const { service, store, saved } = await setup(run);
    await expect(service.copyEntry(saved.id, 'root/source/', 'folder', 'root/source/child/', 'copy')).rejects.toThrow(/source|destination/i);
    await store.save({ ...settings, id: saved.id, permissions: { download: true, upload: false, delete: true } });
    await expect(service.copyEntry(saved.id, 'root/source/file', 'file', 'root/', 'copy')).rejects.toThrow(/upload|allow/i);
    expect(run).not.toHaveBeenCalled();
  });
  it('creates only the selected download root before queued files and lazily creates nested parents', async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const { service, saved, destination } = await setup((method, params, progress) => ({ cancel: () => release(), promise: (async () => {
      if (method === 'manifest') return { objects: [{ key: 'root/adir/dfile', size: 4, isDirectory: false }, { key: 'root/adir/bdir/cfile', size: 5, isDirectory: false }] };
      calls.push(params.key); if (params.key.endsWith('/dfile')) await blocked;
      await writeFile(params.localPath, params.key.endsWith('/dfile') ? 'data' : 'child'); progress({ transferred: params.key.endsWith('/dfile') ? 4 : 5, total: params.key.endsWith('/dfile') ? 4 : 5 }); return { bytes: params.key.endsWith('/dfile') ? 4 : 5 };
    })() }));
    await service.startDownload(saved.id, 'root/adir/', 'folder', destination);
    await vi.waitFor(() => expect(calls).toEqual(['root/adir/dfile']));
    expect(await readdir(join(destination, 'adir'))).toEqual([]);
    release();
    await vi.waitFor(async () => expect((await service.snapshot()).tasks.map(task => task.status)).toEqual(['completed', 'completed']));
    expect((await readdir(join(destination, 'adir'))).sort()).toEqual(['bdir', 'dfile']);
  });

  it('blocks disallowed planning before making directories or contacting the backend', async () => {
    const run = vi.fn(); const { service, store, saved, destination, changed } = await setup(run);
    await store.save({ ...settings, id: saved.id, permissions: { download: false, upload: false, delete: false } });
    await expect(service.startDownload(saved.id, 'root/adir/', 'folder', destination)).rejects.toThrow(/download|disabled|allow/i);
    expect(run).not.toHaveBeenCalled(); expect(await readdir(destination)).toEqual([]);
    await expect(service.deleteEntry(saved.id, 'root/', 'folder')).rejects.toThrow();
    expect(run).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  });

  it('cancel all stops recursive preparation and discards its late manifest', async () => {
    let resolve!: (value: unknown) => void; const manifest = new Promise(done => { resolve = done; }); const cancelled = vi.fn();
    const { service, saved, destination } = await setup(() => ({ promise: manifest, cancel: cancelled }));
    await service.startDownload(saved.id, 'root/adir/', 'folder', destination);
    await service.controlAll('download', 'cancel');
    expect(cancelled).toHaveBeenCalled(); resolve({ objects: [{ key: 'root/adir/file', size: 4, isDirectory: false }] });
    await vi.waitFor(async () => expect((await service.snapshot()).preparations[0].status).toBe('cancelled'));
    expect((await service.snapshot()).tasks).toEqual([]);
  });
});

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('transfer lifecycle regressions', () => {
  it('deletes selected entries with one storage refresh and reports individual failures', async () => {
    const run = vi.fn((_method, params) => ({
      cancel: vi.fn(),
      promise: params.key === 'root/bad' ? Promise.reject(new Error('provider detail')) : Promise.resolve({ deleted: 1 }),
    }));
    const { service, saved, changed } = await setup(run);
    const result = await service.deleteEntries(saved.id, [{ key: 'root/good', kind: 'file' }, { key: 'root/bad', kind: 'file' }]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toEqual([{ key: 'root/bad', message: 'Deletion failed. Some objects may have been deleted. Refresh the folder before retrying.' }]);
    expect(run.mock.calls.map(([, params]) => params.key)).toEqual(['root/good', 'root/bad']);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('clears finished upload rows without cancelling a running upload', async () => {
    const running = deferred<{ bytes: number }>(); const cancel = vi.fn();
    const { service, saved, destination } = await setup((_method, params) => ({
      cancel,
      promise: params.key.endsWith('/active') ? running.promise : Promise.resolve({ bytes: 1 }),
    }));
    await writeFile(join(destination, 'finished'), 'f'); await writeFile(join(destination, 'active'), 'a');
    await service.startUpload(saved.id, 'root/', [join(destination, 'finished')]);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks[0]?.status).toBe('completed'));
    await service.startUpload(saved.id, 'root/', [join(destination, 'active')]);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks.at(-1)?.status).toBe('running'));
    await service.clearFinished('upload');
    expect((await service.snapshot()).tasks.map(task => [task.relativePath, task.status])).toEqual([['active', 'running']]);
    expect(cancel).not.toHaveBeenCalled();
    running.resolve({ bytes: 1 });
    await vi.waitFor(async () => expect((await service.snapshot()).tasks[0]?.status).toBe('completed'));
  });

  it.each(['download', 'upload'] as const)('clearing %s invalidates admissions still awaiting permission', async direction => {
    const run = vi.fn(); const { service, store, saved, destination } = await setup(run);
    const permission = deferred<Awaited<ReturnType<ConnectionStore['forOperation']>>>();
    const request = await store.forOperation(saved.id, 'root/file', direction, 'file');
    const authorize = vi.spyOn(store, 'forOperation').mockReturnValueOnce(permission.promise);
    const started = direction === 'download' ? service.startDownload(saved.id, 'root/file', 'file', destination) : service.startUpload(saved.id, 'root/', [join(destination, 'source')]);
    const rejected = expect(started).rejects.toThrow(/cancelled|cleared/i);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await service.clear(direction); permission.resolve(request); await rejected;
    expect(run).not.toHaveBeenCalled(); expect((await service.snapshot()).tasks).toEqual([]);
  });

  it('clearing blocks new admissions until a cancelled manifest is drained', async () => {
    const manifest = deferred<{ objects: unknown[] }>(); const cancel = vi.fn();
    const { service, saved, destination } = await setup(() => ({ promise: manifest.promise, cancel }));
    await service.startDownload(saved.id, 'root/folder/', 'folder', destination);
    const clearing = service.clear('download');
    try {
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await expect(service.startDownload(saved.id, 'root/file', 'file', destination)).rejects.toThrow(/being cleared/i);
    } finally { manifest.resolve({ objects: [{ key: 'root/folder/late', size: 1, isDirectory: false }] }); }
    await clearing;
    expect((await service.snapshot()).tasks).toEqual([]);
    expect((await service.snapshot()).preparations).toEqual([]);
  });

  it('releases a removed queued file download name without deleting completed data', async () => {
    const { service, saved, destination } = await setup(vi.fn());
    await service.controlAll('download', 'stop');
    await service.startDownload(saved.id, 'root/file', 'file', destination);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks).toHaveLength(1));
    const first = (await service.snapshot()).tasks[0];
    await service.remove(first.id);
    await service.startDownload(saved.id, 'root/file', 'file', destination);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks).toHaveLength(1));
    expect((await service.snapshot()).tasks[0].localPath).toBe(first.localPath);
  });
  it('removes a preparing folder and drains its cancelled manifest without recreating tasks', async () => {
    const manifest = deferred<{ objects: unknown[] }>(); const cancel = vi.fn();
    const { service, saved, destination } = await setup(() => ({ promise: manifest.promise, cancel }));
    const group = await service.startDownload(saved.id, 'root/folder/', 'folder', destination);
    let removal: Promise<void> | undefined;
    try {
      removal = service.remove(group);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    } finally { manifest.resolve({ objects: [{ key: 'root/folder/file', size: 10, isDirectory: false }] }); }
    await removal;
    expect((await service.snapshot()).preparations).toEqual([]);
    expect((await service.snapshot()).tasks).toEqual([]);
  });

  it('removes a preparation group that has already become queued files', async () => {
    const { service, saved, destination } = await setup(vi.fn());
    await service.controlAll('upload', 'stop');
    await writeFile(join(destination, 'a'), 'a'); await writeFile(join(destination, 'b'), 'b');
    const group = await service.startUpload(saved.id, 'root/', [join(destination, 'a'), join(destination, 'b')]);
    await vi.waitFor(async () => expect((await service.snapshot()).tasks).toHaveLength(2));
    await service.remove(group);
    expect((await service.snapshot()).tasks).toEqual([]);
  });

  it('removes completed upload history without extra storage refreshes', async () => {
    const { service, saved, destination, changed } = await setup(() => ({ cancel() {}, promise: Promise.resolve({ bytes: 1 }) }));
    await writeFile(join(destination, 'a'), 'a'); await writeFile(join(destination, 'b'), 'b');
    await service.startUpload(saved.id, 'root/', [join(destination, 'a'), join(destination, 'b')]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await service.remove((await service.snapshot()).tasks[0].id);
    await service.controlAll('upload', 'stop');
    expect(changed).toHaveBeenCalledOnce();
    await service.clear('upload');
    expect((await service.snapshot()).tasks).toEqual([]);
    expect(changed).toHaveBeenCalledOnce();
  });
  it.each(['download', 'upload'] as const)('cancel all invalidates %s admission while authorization is pending', async direction => {
    const run = vi.fn(); const { service, store, saved, destination } = await setup(run);
    const permission = deferred<Awaited<ReturnType<ConnectionStore['forOperation']>>>();
    const request = await store.forOperation(saved.id, 'root/file', direction, 'file');
    const authorize = vi.spyOn(store, 'forOperation').mockReturnValueOnce(permission.promise);
    const started = direction === 'download' ? service.startDownload(saved.id, 'root/file', 'file', destination) : service.startUpload(saved.id, 'root/', [join(destination, 'source')]);
    const rejected = expect(started).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    await service.controlAll(direction, 'cancel'); permission.resolve(request); await rejected;
    expect(run).not.toHaveBeenCalled(); expect((await service.snapshot()).tasks).toEqual([]); expect(await readdir(destination)).toEqual([]);
  });

  it('cancel all invalidates admission while download allocation is pending', async () => {
    const run = vi.fn(); const { service, saved, destination } = await setup(run);
    const allocation = deferred<{ path: string; name: string }>();
    const allocate = vi.spyOn(transferPaths, 'allocateDownloadRoot').mockReturnValueOnce(allocation.promise);
    const started = service.startDownload(saved.id, 'root/dir/', 'folder', destination); const rejected = expect(started).rejects.toThrow(/cancelled/i);
    await vi.waitFor(() => expect(allocate).toHaveBeenCalled());
    await service.controlAll('download', 'cancel'); allocation.resolve({ path: join(destination, 'dir'), name: 'dir' }); await rejected;
    expect(run).not.toHaveBeenCalled(); expect((await service.snapshot()).tasks).toEqual([]); allocate.mockRestore();
  });

  it.each(['connection', 'dispose'])('cancels and drains active deletion on %s with a fixed partial deletion warning', async mode => {
    const deletion = deferred<{ deleted: number }>(); const cancel = vi.fn();
    const run = vi.fn(() => ({ promise: deletion.promise, cancel }));
    const { service, saved, changed } = await setup(run);
    const deleting = service.deleteEntry(saved.id, 'root/dir/', 'folder'); const rejected = expect(deleting).rejects.toThrow(/Some objects may have been deleted.*Refresh/i);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    let drained = false; const drain = (mode === 'dispose' ? service.dispose() : service.cancelConnection(saved.id)).then(() => { drained = true; });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(drained).toBe(false);
    deletion.reject(new Error('DUMMY_SECRET child exit')); await rejected; await drain;
    expect(changed).toHaveBeenCalledOnce(); expect(drained).toBe(true);
  });

  it('normalizes every attempted deletion error and refreshes storage', async () => {
    const { service, saved, changed } = await setup(() => ({ promise: Promise.reject(new Error('DUMMY_SECRET protocol failure')), cancel() {} }));
    await expect(service.deleteEntry(saved.id, 'root/file', 'file')).rejects.toThrow('Deletion failed. Some objects may have been deleted. Refresh the folder before retrying.');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('reports unverified deletion as failure and still refreshes the real listing', async () => {
    const error = new OperationError('DELETE_NOT_REMOVED', 'The delete request completed, but the item is still listed by the storage service. Refresh the folder before retrying.');
    const { service, saved, changed } = await setup(() => ({ promise: Promise.reject(error), cancel() {} }));
    await expect(service.deleteEntry(saved.id, 'root/file', 'file')).rejects.toBe(error);
    expect(changed).toHaveBeenCalledExactlyOnceWith(saved.id);
  });

  it('blocks new requests during connection mutation and invalidates requests already awaiting permission', async () => {
    const run = vi.fn(); const { service, store, saved, destination } = await setup(run);
    const permission = deferred<Awaited<ReturnType<ConnectionStore['forOperation']>>>();
    const request = await store.forOperation(saved.id, 'root/file', 'download', 'file');
    const authorize = vi.spyOn(store, 'forOperation').mockReturnValueOnce(permission.promise);
    const earlier = service.startDownload(saved.id, 'root/file', 'file', destination); const rejected = expect(earlier).rejects.toThrow(/cancelled|changing/i);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    const mutation = deferred<void>();
    const changing = service.withConnectionMutation(saved.id, () => mutation.promise);
    await expect(service.startDownload(saved.id, 'root/dir/', 'folder', destination)).rejects.toThrow(/changing|cancelled/i);
    await expect(service.startUpload(saved.id, 'root/', [join(destination, 'source')])).rejects.toThrow(/changing|cancelled/i);
    await expect(service.deleteEntry(saved.id, 'root/file', 'file')).rejects.toThrow(/changing|cancelled/i);
    permission.resolve(request); await rejected; mutation.resolve(); await changing;
    expect(run).not.toHaveBeenCalled(); expect(await readdir(destination)).toEqual([]); expect((await service.snapshot()).tasks).toEqual([]);
  });

  it('invalidates native chooser admission and releases mutation barrier after errors', async () => {
    const { service, saved, destination } = await setup(vi.fn());
    const admission = service.captureAdmission(saved.id, 'download');
    await expect(service.withConnectionMutation(saved.id, async () => { throw new Error('save failed'); })).rejects.toThrow('save failed');
    await expect(service.startDownload(saved.id, 'root/file', 'file', destination, admission)).rejects.toThrow(/cancelled/i);
    expect(() => service.captureAdmission(saved.id, 'download')).not.toThrow();
  });

  it('refreshes again after failed upload retries complete without duplicate idle notifications', async () => {
    let failed = false;
    const { service, saved, destination, changed } = await setup((_method, params) => ({ cancel() {}, promise: params.key.endsWith('b') && !failed ? (failed = true, Promise.reject(new Error('failed'))) : Promise.resolve({ bytes: 1 }) }));
    await writeFile(join(destination, 'a'), 'a'); await writeFile(join(destination, 'b'), 'b');
    await service.startUpload(saved.id, 'root/', [join(destination, 'a'), join(destination, 'b')]);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const task = (await service.snapshot()).tasks.find(task => task.status === 'failed')!;
    await service.control(task.id, 'start'); await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    await service.controlAll('upload', 'stop'); await service.controlAll('upload', 'start'); expect(changed).toHaveBeenCalledTimes(2);
  });

  it('passes the chooser root to the transfer worker', async () => {
    const run = vi.fn(() => ({ promise: Promise.resolve({ bytes: 1 }), cancel() {} })); const { service, saved, destination } = await setup(run);
    await service.startDownload(saved.id, 'root/file', 'file', destination);
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('download', expect.objectContaining({ rootPath: destination }), expect.any(Function)));
  });
  it('blocks admission throughout an active-delete drain before mutating the connection', async () => {
    const deletion = deferred<{ deleted: number }>(); const cancel = vi.fn(); const mutate = vi.fn(async () => undefined);
    const run = vi.fn(() => ({ promise: deletion.promise, cancel })); const { service, saved, destination } = await setup(run);
    const deleting = service.deleteEntry(saved.id, 'root/file', 'file'); const rejected = expect(deleting).rejects.toThrow(/may have been deleted/i);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce()); const mutation = service.withConnectionMutation(saved.id, mutate);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()); expect(mutate).not.toHaveBeenCalled();
    await expect(service.startDownload(saved.id, 'root/dir/', 'folder', destination)).rejects.toThrow(/changing/i);
    await expect(service.startUpload(saved.id, 'root/', [join(destination, 'file')])).rejects.toThrow(/changing/i);
    await expect(service.deleteEntry(saved.id, 'root/other', 'file')).rejects.toThrow(/changing/i);
    deletion.reject(new Error('cancelled')); await rejected; await mutation; expect(mutate).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledOnce(); expect(await readdir(destination)).toEqual([]);
  });

  it('invalidates delete admission already awaiting authorization when a connection mutation begins', async () => {
    const run = vi.fn(); const { service, store, saved } = await setup(run);
    const permission = deferred<Awaited<ReturnType<ConnectionStore['forOperation']>>>(); const request = await store.forOperation(saved.id, 'root/file', 'delete', 'file');
    const authorize = vi.spyOn(store, 'forOperation').mockReturnValueOnce(permission.promise);
    const deleting = service.deleteEntry(saved.id, 'root/file', 'file'); const rejected = expect(deleting).rejects.toThrow(/cancelled|changing/i);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce()); await service.withConnectionMutation(saved.id, async () => undefined);
    permission.resolve(request); await rejected; expect(run).not.toHaveBeenCalled();
  });

  it('stop all lets enumeration finish with its discovered tasks paused', async () => {
    const manifest = deferred<{ objects: { key: string; size: number; isDirectory: boolean }[] }>();
    const run = vi.fn(() => ({ promise: manifest.promise, cancel: vi.fn() })); const { service, saved, destination } = await setup(run);
    await service.startDownload(saved.id, 'root/dir/', 'folder', destination); await service.controlAll('download', 'stop');
    manifest.resolve({ objects: [{ key: 'root/dir/file', size: 1, isDirectory: false }] });
    await vi.waitFor(async () => expect((await service.snapshot()).tasks.map(task => task.status)).toEqual(['paused'])); expect(run).toHaveBeenCalledOnce();
  });

  it('restoring terminal upload history triggers neither backend work nor a storage refresh', async () => {
    const run = vi.fn(() => ({ promise: Promise.resolve({ bytes: 1 }), cancel() {} })); const { service, store, saved, destination, changed } = await setup(run);
    await writeFile(join(destination, 'file'), 'a'); await service.startUpload(saved.id, 'root/', [join(destination, 'file')]); await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce()); await service.dispose();
    const refresh = vi.fn(); const backend = vi.fn(); const restored = new TransferService(store, { run: backend }, join(destination, '..', 'settings'), { storageChanged: refresh }); services.push(restored);
    await restored.initialize(); await restored.controlAll('upload', 'stop'); await restored.controlAll('upload', 'start'); expect(refresh).not.toHaveBeenCalled(); expect(backend).not.toHaveBeenCalled();
  });

  it('does not refresh a terminal mixed upload group when cancelling its failed row', async () => {
    const { service, saved, destination, changed } = await setup((_method, params) => ({ cancel() {}, promise: params.key.endsWith('b') ? Promise.reject(new Error('failed')) : Promise.resolve({ bytes: 1 }) }));
    await writeFile(join(destination, 'a'), 'a'); await writeFile(join(destination, 'b'), 'b');
    await service.startUpload(saved.id, 'root/', [join(destination, 'a'), join(destination, 'b')]); await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    const failed = (await service.snapshot()).tasks.find(task => task.status === 'failed')!; await service.control(failed.id, 'cancel');
    expect(changed).toHaveBeenCalledOnce();
  });

});
