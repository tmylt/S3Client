import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ConnectionStore } from './connections';
import { OperationError, type OperationHandle, type OperationRunner } from './operation-runner';
import { validateUploadSelection } from './upload-sources';
import { TransferQueue, type TransferExecutor } from './transfer-queue';
import { allocateDownloadRoot, downloadPlan, ensureDownloadPath, safeSegments, uploadPlan, validateUploadPath, type PlannedPath } from './transfer-paths';
import type { NewTransferTask, TransferAction, TransferDirection, TransferPreparation, TransferSnapshot, TransferTask } from '../shared/transfers';
import type { BatchEntryResult, EntryTarget } from '../shared/types';

export interface Admission { connectionId: string; epoch: number; direction?: TransferDirection; generation?: number }
interface Preparation {
  value: TransferPreparation;
  key: string;
  controller: AbortController;
  handle?: OperationHandle<unknown>;
  done?: Promise<void>;
  admission: Admission;
  downloadRoot?: string;
}
interface Callbacks { changed?(snapshot: TransferSnapshot): void; storageChanged?(connectionId: string): void | Promise<void> }
const unfinished = (task: TransferTask) => ['queued', 'running', 'paused'].includes(task.status);

/** Chooser-granted roots and S3 permissions are resolved here, outside the renderer. */
export class TransferService {
  private readonly queue: TransferQueue;
  private readonly preparations = new Map<string, Preparation>();
  private readonly epochs = new Map<string, number>();
  private readonly notifiedGroups = new Map<string, string>();
  private readonly blockedConnections = new Set<string>();
  private readonly generations = { download: 0, upload: 0 };
  private readonly clears = new Map<TransferDirection, Promise<void>>();
  private readonly deletions = new Set<{ connectionId: string; handle: OperationHandle<{ deleted: number }>; done: Promise<number> }>();
  private readonly copies = new Set<{ connectionId: string; handle: OperationHandle<{ copied: number }>; done: Promise<number> }>();
  private readonly renames = new Set<{ connectionId: string; handle: OperationHandle<{ renamed: number }>; done: Promise<number> }>();
  private readonly reservations = new Set<string>();
  private readonly ready: Promise<void>;
  private disposed = false;

  constructor(private readonly store: ConnectionStore, private readonly runner: Pick<OperationRunner, 'run'>, directory: string, private readonly callbacks: Callbacks = {}) {
    this.queue = new TransferQueue(directory, this.execute, (snapshot, reason) => { this.emit(snapshot); this.notifyCompletedGroups(snapshot, reason !== 'history'); });
    this.ready = this.queue.initialize().then(() => {
      const snapshot = this.queue.snapshot();
      for (const task of snapshot.tasks) if (unfinished(task) && task.direction === 'download') this.reservations.add(join(task.rootPath, task.relativePath.split('/')[0]));
      for (const task of snapshot.tasks) if (task.direction === 'upload' && !snapshot.tasks.some(other => other.groupId === task.groupId && unfinished(other))) this.notifiedGroups.set(task.groupId, this.groupSignature(snapshot.tasks.filter(other => other.groupId === task.groupId)));
    });
  }

  initialize(): Promise<void> { return this.ready; }
  async snapshot(): Promise<TransferSnapshot> { await this.ready; return this.compose(this.queue.snapshot()); }
  private compose(snapshot: TransferSnapshot): TransferSnapshot { return { ...snapshot, preparations: [...this.preparations.values()].map(item => ({ ...item.value })) }; }
  private emit(snapshot = this.queue.snapshot()): void { try { this.callbacks.changed?.(this.compose(snapshot)); } catch { /* The queue is independent of window lifetime. */ } }

  private groupSignature(group: TransferTask[]): string { return JSON.stringify(group.filter(task => task.status === 'completed').map(task => [task.id, task.finishedAt])); }

  private notifyCompletedGroups(snapshot: TransferSnapshot, notify = true): void {
    const groups = new Map<string, TransferTask[]>();
    for (const task of snapshot.tasks) if (task.direction === 'upload') {
      const group = groups.get(task.groupId) ?? []; group.push(task); groups.set(task.groupId, group);
    }
    for (const id of this.notifiedGroups.keys()) if (!groups.has(id)) this.notifiedGroups.delete(id);
    for (const [id, group] of groups) if (!group.some(unfinished) && group.some(task => task.status === 'completed')) {
      const signature = this.groupSignature(group);
      if (this.notifiedGroups.get(id) === signature) continue;
      this.notifiedGroups.set(id, signature);
      if (notify) void Promise.resolve(this.callbacks.storageChanged?.(group[0].connectionId)).catch(() => undefined);
    }
  }

  private execute: TransferExecutor = async (task, progress, signal) => {
    const admission = this.captureAdmission(task.connectionId);
    if (signal.aborted) throw new Error('Transfer cancelled.');
    const request = await this.store.forOperation(task.connectionId, task.key, task.direction, task.isDirectory ? 'folder' : 'file');
    this.checkAdmission(admission);
    if (request.connection.bucket !== task.bucket) throw new Error('The connection bucket changed. Create a new transfer.');
    if (signal.aborted) throw new Error('Transfer cancelled.');
    if (task.direction === 'download') {
      await ensureDownloadPath(task.rootPath, task.localPath, task.isDirectory);
      if (signal.aborted) throw new Error('Transfer cancelled.');
      if (task.isDirectory) return { bytes: 0 };
    } else await validateUploadPath(task.rootPath, task.localPath, task.isDirectory);
    if (signal.aborted) throw new Error('Transfer cancelled.');
    this.checkAdmission(admission);
    const operation = this.runner.run(task.direction, { connection: request.connection, key: request.key, kind: task.isDirectory ? 'folder' : 'file', localPath: task.localPath, rootPath: task.rootPath }, progress);
    const abort = () => operation.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { return await operation.promise; }
    finally { signal.removeEventListener('abort', abort); }
  };

  captureAdmission(id: unknown, direction?: TransferDirection): Admission {
    if (typeof id !== 'string') throw new Error('Invalid connection.');
    const admission = { connectionId: id, epoch: this.epochs.get(id) ?? 0, direction, generation: direction ? this.generations[direction] : undefined };
    this.checkAdmission(admission); return admission;
  }
  private checkAdmission(admission: Admission): void {
    if (admission.direction && this.clears.has(admission.direction)) throw new Error('This transfer list is being cleared. Try again when it finishes.');
    if (this.blockedConnections.has(admission.connectionId)) throw new Error('The connection is changing. Try again when the update finishes.');
    if (this.disposed || (this.epochs.get(admission.connectionId) ?? 0) !== admission.epoch || admission.direction && this.generations[admission.direction] !== admission.generation) throw new Error('Transfer preparation cancelled.');
  }
  async withConnectionMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.blockedConnections.has(id)) throw new Error('The connection is changing. Try again when the update finishes.');
    this.blockedConnections.add(id);
    try { await this.cancelConnection(id); return await operation(); }
    finally { this.blockedConnections.delete(id); }
  }
  private begin(connectionId: string, key: string, direction: TransferDirection, name: string, admission: Admission): Preparation {
    this.checkAdmission(admission);
    const job: Preparation = { value: { id: randomUUID(), connectionId, name, direction, status: 'preparing' }, key, controller: new AbortController(), admission };
    this.preparations.set(job.value.id, job); this.emit(); return job;
  }
  private check(job: Preparation, _epoch: number): void {
    this.checkAdmission(job.admission);
    if (job.controller.signal.aborted) throw new Error('Transfer preparation cancelled.');
  }
  private prepare(job: Preparation, epoch: number, plan: () => Promise<NewTransferTask[]>): void {
    job.done = (async () => {
      try {
        const tasks = await plan(); this.check(job, epoch);
        await this.queue.enqueue(tasks, job.controller.signal);
        this.preparations.delete(job.value.id);
      } catch (error) {
        if (!job.controller.signal.aborted) { job.value.status = 'failed'; job.value.error = error instanceof Error ? error.message : 'Could not prepare the transfer.'; }
      } finally { job.handle = undefined; this.emit(); }
    })();
  }

  async startDownload(id: unknown, key: unknown, kind: 'file' | 'folder', destination: string, admission = this.captureAdmission(id, 'download')): Promise<string> {
    await this.ready; this.checkAdmission(admission);
    const epoch = admission.epoch;
    const request = await this.store.forOperation(id, key, 'download', kind);
    this.checkAdmission(admission);
    const remoteName = kind === 'folder' ? request.key.slice(0, -1).split('/').pop() || request.connection.bucket : request.key.split('/').pop()!;
    safeSegments(remoteName);
    const root = await allocateDownloadRoot(destination, remoteName, kind === 'folder', this.reservations);
    try { this.checkAdmission(admission); }
    catch (error) { this.reservations.delete(root.path); throw error; }
    const job = this.begin(id as string, request.key, 'download', remoteName, admission);
    job.downloadRoot = root.path;
    this.prepare(job, epoch, async () => {
      let plans: PlannedPath[];
      if (kind === 'folder') {
        this.check(job, epoch);
        const operation = this.runner.run('manifest', { connection: request.connection, prefix: request.key }); job.handle = operation;
        if (job.controller.signal.aborted) operation.cancel();
        const result = await operation.promise; this.check(job, epoch);
        if (!result.objects.length) throw new Error('The S3 folder no longer exists. It may have been deleted. Refresh the folder before retrying this download.');
        plans = downloadPlan(request.key, root, result.objects);
      } else plans = [{ key: request.key, size: 0, isDirectory: false, localPath: root.path, rootPath: dirname(root.path), relativePath: root.name }];
      return plans.map(plan => ({ ...plan, groupId: job.value.id, direction: 'download', connectionId: id as string, connectionName: request.connectionName, bucket: request.connection.bucket }));
    });
    return job.value.id;
  }

  async startUpload(id: unknown, prefix: unknown, paths: string[], admission = this.captureAdmission(id, 'upload')): Promise<string> {
    await this.ready; this.checkAdmission(admission);
    const epoch = admission.epoch;
    const request = await this.store.forOperation(id, prefix, 'upload', 'folder');
    this.checkAdmission(admission);
    validateUploadSelection(paths);
    const job = this.begin(id as string, request.key, 'upload', paths.length === 1 ? basename(paths[0]) : `${paths.length} items`, admission);
    this.prepare(job, epoch, async () => {
      const plans = await uploadPlan(request.key, paths, job.controller.signal); this.check(job, epoch);
      return plans.map(plan => ({ ...plan, groupId: job.value.id, direction: 'upload', connectionId: id as string, connectionName: request.connectionName, bucket: request.connection.bucket }));
    });
    return job.value.id;
  }

  async control(id: unknown, action: unknown): Promise<void> {
    await this.ready;
    const job = typeof id === 'string' ? this.preparations.get(id) : undefined;
    if (job) { if (action !== 'cancel') throw new Error('Only cancellation is available while preparing.'); this.cancelPreparation(job); return; }
    await this.queue.control(id, action);
  }

  private releaseReservations(tasks: TransferTask[], jobs: Preparation[] = []): void {
    const remaining = new Set(this.queue.snapshot().tasks.map(task => task.groupId));
    for (const task of tasks) if (task.direction === 'download' && !remaining.has(task.groupId)) this.reservations.delete(join(task.rootPath, task.relativePath.split('/')[0]));
    for (const job of jobs) if (job.downloadRoot && !remaining.has(job.value.id)) this.reservations.delete(job.downloadRoot);
  }

  async remove(id: unknown): Promise<void> {
    await this.ready;
    if (typeof id !== 'string') throw new Error('Invalid transfer.');
    const job = this.preparations.get(id);
    const before = this.queue.snapshot().tasks;
    const isTask = before.some(task => task.id === id);
    if (job) { this.cancelPreparation(job); await job.done; this.preparations.delete(id); }
    await this.queue.removeMatching(task => isTask ? task.id === id : task.groupId === id);
    this.releaseReservations(before.filter(task => isTask ? task.id === id : task.groupId === id), job ? [job] : []);
    this.emit();
  }

  async clear(direction: unknown): Promise<void> {
    await this.ready;
    if (direction !== 'download' && direction !== 'upload') throw new Error('Invalid transfer direction.');
    const existing = this.clears.get(direction);
    if (existing) return existing;
    this.generations[direction]++;
    const clearing = Promise.resolve().then(async () => {
      const jobs = [...this.preparations.values()].filter(job => job.value.direction === direction);
      const before = this.queue.snapshot().tasks.filter(task => task.direction === direction);
      jobs.forEach(job => this.cancelPreparation(job));
      const queueRemoval = this.queue.clear(direction);
      const results = await Promise.allSettled([queueRemoval, ...jobs.map(job => job.done)]);
      for (const job of jobs) this.preparations.delete(job.value.id);
      // A preparation already inside enqueue may have added cancelled rows.
      await this.queue.clear(direction);
      this.releaseReservations(before, jobs); this.emit();
      if (results[0].status === 'rejected') throw results[0].reason;
    });
    this.clears.set(direction, clearing);
    try { await clearing; }
    finally { if (this.clears.get(direction) === clearing) this.clears.delete(direction); }
  }
  async clearFinished(direction: unknown): Promise<void> {
    await this.ready;
    if (direction !== 'download' && direction !== 'upload') throw new Error('Invalid transfer direction.');
    const jobs = [...this.preparations.values()].filter(job => job.value.direction === direction && job.value.status !== 'preparing');
    await Promise.allSettled(jobs.map(job => job.done));
    const finished = this.queue.snapshot().tasks.filter(task => task.direction === direction && !unfinished(task));
    await this.queue.clearFinished(direction);
    for (const job of jobs) this.preparations.delete(job.value.id);
    this.releaseReservations(finished, jobs);
    this.emit();
  }
  private cancelPreparation(job: Preparation): void {
    if (job.value.status !== 'preparing') return;
    job.value.status = 'cancelled'; job.controller.abort(); job.handle?.cancel(); this.emit();
  }
  async controlAll(direction: unknown, action: unknown): Promise<void> {
    if ((direction !== 'download' && direction !== 'upload') || !['start', 'stop', 'cancel'].includes(action as string)) throw new Error('Invalid transfer control.');
    if (action === 'cancel') this.generations[direction]++;
    if (action === 'cancel') for (const job of this.preparations.values()) if (job.value.direction === direction) this.cancelPreparation(job);
    await this.queue.controlAll(direction, action);
  }
  setConcurrency(direction: unknown, value: unknown): Promise<void> { return this.queue.setConcurrency(direction, value); }

  async cancelConnection(id: string): Promise<void> {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    const jobs = [...this.preparations.values()].filter(job => job.value.connectionId === id);
    jobs.forEach(job => this.cancelPreparation(job));
    const deletions = [...this.deletions].filter(item => item.connectionId === id);
    deletions.forEach(item => item.handle.cancel());
    const copies = [...this.copies].filter(item => item.connectionId === id);
    copies.forEach(item => item.handle.cancel());
    const renames = [...this.renames].filter(item => item.connectionId === id);
    renames.forEach(item => item.handle.cancel());
    await this.queue.cancelMatching(task => task.connectionId === id);
    await Promise.allSettled([...jobs.map(job => job.done), ...deletions.map(item => item.done), ...copies.map(item => item.done), ...renames.map(item => item.done)]);
  }

  async copyEntry(id: unknown, key: unknown, kind: 'file' | 'folder', destinationFolder: unknown, name: unknown, admission = this.captureAdmission(id)): Promise<number> {
    await this.ready; this.checkAdmission(admission);
    if (typeof name !== 'string' || !name || name.length > 8192 || name.includes('/') || name.includes('\0')) throw new Error('Enter a file or folder name without slashes.');
    const source = await this.store.forOperation(id, key, 'upload', kind);
    this.checkAdmission(admission);
    const folder = await this.store.forOperation(id, destinationFolder, 'upload', 'folder');
    this.checkAdmission(admission);
    const destinationKey = `${folder.key}${name}${kind === 'folder' ? '/' : ''}`;
    if (destinationKey === source.key || kind === 'folder' && destinationKey.startsWith(source.key)) throw new Error('Choose a different name or a destination outside the source folder.');
    if (destinationKey.length > 8192) throw new Error('The destination key is too long.');
    // Resolve the destination as an object too, so scope and kind are checked before copying.
    await this.store.forOperation(id, destinationKey, 'upload', kind);
    this.checkAdmission(admission);
    const handle = this.runner.run('copy', { connection: source.connection, key: source.key, destinationKey, kind });
    const item = { connectionId: id as string, handle, done: Promise.resolve(0) };
    item.done = (async () => {
      try { return (await handle.promise).copied; }
      finally {
        await Promise.resolve().then(() => this.callbacks.storageChanged?.(id as string)).catch(() => undefined);
        this.copies.delete(item);
      }
    })();
    this.copies.add(item);
    return item.done;
  }

  async renameEntry(id: unknown, key: unknown, kind: 'file' | 'folder', name: unknown, admission = this.captureAdmission(id)): Promise<number> {
    await this.ready; this.checkAdmission(admission);
    if (typeof name !== 'string' || !name || name.length > 8192 || name.includes('/') || name.includes('\0')) throw new Error('Enter a file or folder name without slashes.');
    const source = await this.store.forOperation(id, key, 'delete', kind);
    this.checkAdmission(admission);
    await this.store.forOperation(id, key, 'upload', kind);
    this.checkAdmission(admission);
    const sourcePath = kind === 'folder' ? source.key.slice(0, -1) : source.key;
    const parent = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
    const destinationKey = `${parent}${name}${kind === 'folder' ? '/' : ''}`;
    if (destinationKey === source.key) throw new Error('Choose a different name.');
    if (destinationKey.length > 8192) throw new Error('The destination key is too long.');
    await this.store.forOperation(id, destinationKey, 'upload', kind);
    this.checkAdmission(admission);
    const affected = (candidate: string) => kind === 'folder' ? candidate.startsWith(source.key) : candidate === source.key;
    const jobs = [...this.preparations.values()].filter(job => job.value.connectionId === id && (affected(job.key) || source.key.startsWith(job.key)));
    jobs.forEach(job => this.cancelPreparation(job));
    await this.queue.cancelMatching(task => task.connectionId === id && affected(task.key));
    await Promise.allSettled(jobs.map(job => job.done));
    this.checkAdmission(admission);
    const latest = await this.store.forOperation(id, key, 'delete', kind);
    await this.store.forOperation(id, key, 'upload', kind);
    await this.store.forOperation(id, destinationKey, 'upload', kind);
    this.checkAdmission(admission);
    const handle = this.runner.run('rename', { connection: latest.connection, key: latest.key, destinationKey, kind });
    const item = { connectionId: id as string, handle, done: Promise.resolve(0) };
    item.done = (async () => {
      try { return (await handle.promise).renamed; }
      finally {
        await Promise.resolve().then(() => this.callbacks.storageChanged?.(id as string)).catch(() => undefined);
        this.renames.delete(item);
      }
    })();
    this.renames.add(item);
    return item.done;
  }

  async deleteEntry(id: unknown, key: unknown, kind: 'file' | 'folder', admission = this.captureAdmission(id), notifyStorage = true): Promise<number> {
    await this.ready; this.checkAdmission(admission);
    const request = await this.store.forOperation(id, key, 'delete', kind);
    this.checkAdmission(admission);
    const affected = (candidate: string) => kind === 'folder' ? candidate.startsWith(request.key) : candidate === request.key;
    const jobs = [...this.preparations.values()].filter(job => job.value.connectionId === id && (affected(job.key) || request.key.startsWith(job.key)));
    jobs.forEach(job => this.cancelPreparation(job));
    await this.queue.cancelMatching(task => task.connectionId === id && affected(task.key));
    await Promise.allSettled(jobs.map(job => job.done));
    // Resolve permissions/config again after waiting for active transfers to stop.
    this.checkAdmission(admission);
    const latest = await this.store.forOperation(id, key, 'delete', kind);
    this.checkAdmission(admission);
    let handle: OperationHandle<{ deleted: number }>;
    try { handle = this.runner.run('delete', { connection: latest.connection, key: latest.key, kind }); }
    catch { if (notifyStorage) await Promise.resolve().then(() => this.callbacks.storageChanged?.(id as string)).catch(() => undefined); throw new Error('Deletion failed. Some objects may have been deleted. Refresh the folder before retrying.'); }
    const item = { connectionId: id as string, handle, done: Promise.resolve(0) };
    item.done = (async () => {
      try { return (await handle.promise).deleted; }
      catch (error) {
        if (error instanceof OperationError && error.code === 'DELETE_NOT_REMOVED') throw error;
        throw new Error('Deletion failed. Some objects may have been deleted. Refresh the folder before retrying.');
      }
      finally {
        if (notifyStorage) await Promise.resolve().then(() => this.callbacks.storageChanged?.(id as string)).catch(() => undefined);
        this.deletions.delete(item);
      }
    })();
    this.deletions.add(item); return item.done;
  }

  async deleteEntries(id: unknown, entries: EntryTarget[], admission = this.captureAdmission(id)): Promise<BatchEntryResult> {
    const summary: BatchEntryResult = { succeeded: 0, failed: [] };
    try {
      for (const entry of entries) {
        try { await this.deleteEntry(id, entry.key, entry.kind, admission, false); summary.succeeded++; }
        catch (error) { summary.failed.push({ key: entry.key, message: error instanceof Error ? error.message : 'Deletion failed.' }); }
      }
    } finally {
      if (entries.length) await Promise.resolve().then(() => this.callbacks.storageChanged?.(id as string)).catch(() => undefined);
    }
    return summary;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const deletions = [...this.deletions]; deletions.forEach(item => item.handle.cancel());
    const copies = [...this.copies]; copies.forEach(item => item.handle.cancel());
    const renames = [...this.renames]; renames.forEach(item => item.handle.cancel());
    await this.ready;
    const jobs = [...this.preparations.values()]; jobs.forEach(job => this.cancelPreparation(job));
    await this.queue.dispose(); await Promise.allSettled([...jobs.map(job => job.done), ...deletions.map(item => item.done), ...copies.map(item => item.done), ...renames.map(item => item.done)]);
  }
}
