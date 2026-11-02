import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { emptyTransferSnapshot, type NewTransferTask, type TransferAction, type TransferDirection, type TransferSnapshot, type TransferTask } from '../shared/transfers';

export type TransferExecutor = (task: TransferTask, progress: (value: { transferred: number; total: number }) => void, signal: AbortSignal) => Promise<{ bytes: number }>;
const maxBytes = 32 * 1024 * 1024;
const maxTasks = 100_000;
const pending = (task: TransferTask) => ['queued', 'running', 'paused'].includes(task.status);
const validDirection = (value: unknown): value is TransferDirection => value === 'download' || value === 'upload';
const validAction = (value: unknown): value is TransferAction => value === 'start' || value === 'stop' || value === 'cancel';
const concurrencyValue = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 8) throw new Error('Concurrency must be a whole number from 1 to 8.');
  return value as number;
};

function cleanTask(value: unknown): TransferTask {
  if (!value || typeof value !== 'object') throw new Error('Invalid transfer task.');
  const raw = value as TransferTask;
  const output = {} as TransferTask;
  for (const key of ['id', 'groupId', 'connectionId', 'connectionName', 'bucket', 'key', 'relativePath', 'localPath', 'rootPath', 'createdAt'] as const) {
    if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 32768 || raw[key].includes('\0')) throw new Error('Invalid transfer task.');
    output[key] = raw[key];
  }
  if (!validDirection(raw.direction) || !['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'].includes(raw.status) || typeof raw.isDirectory !== 'boolean') throw new Error('Invalid transfer task.');
  if (![raw.size, raw.transferred].every(number => Number.isSafeInteger(number) && number >= 0) || raw.transferred > raw.size) throw new Error('Invalid transfer size.');
  const child = relative(raw.rootPath, raw.localPath);
  if (!isAbsolute(raw.rootPath) || !isAbsolute(raw.localPath) || isAbsolute(child) || child === '..' || child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Invalid transfer path.');
  if (!Number.isFinite(Date.parse(raw.createdAt))) throw new Error('Invalid transfer date.');
  return { ...output, direction: raw.direction, isDirectory: raw.isDirectory, status: raw.status, size: raw.size, transferred: raw.transferred,
    ...(typeof raw.error === 'string' ? { error: raw.error.slice(0, 1000) } : {}),
    ...(typeof raw.finishedAt === 'string' && Number.isFinite(Date.parse(raw.finishedAt)) ? { finishedAt: raw.finishedAt } : {}),
  };
}

/** Owns scheduling and metadata; it never stores or resolves credentials. */
export class TransferQueue {
  private state = emptyTransferSnapshot();
  private readonly active = new Map<string, { controller: AbortController; startedAt: number; done?: Promise<void> }>();
  private readonly removing = new Set<string>();
  private readonly ready: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private speedTimer?: ReturnType<typeof setInterval>;
  private readonly file: string;

  constructor(private readonly directory: string, private readonly execute: TransferExecutor, private readonly changed: (snapshot: TransferSnapshot, reason?: 'history') => void = () => {}) {
    this.file = join(directory, 'transfer-queue.json');
    this.ready = this.load();
  }

  initialize(): Promise<void> { return this.ready; }
  snapshot(): TransferSnapshot {
    const now = performance.now();
    return {
      tasks: this.state.tasks.map(task => {
        const active = this.active.get(task.id);
        const elapsed = active ? now - active.startedAt : 0;
        const bytesPerSecond = task.status === 'running' && !task.isDirectory && elapsed > 0 ? Math.round(task.transferred * 1000 / elapsed) : 0;
        return { ...task, bytesPerSecond };
      }),
      preparations: [], paused: { ...this.state.paused }, concurrency: { ...this.state.concurrency },
    };
  }

  private async load(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return;
      const bytes = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < bytes.length) { const result = await handle.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
      if (count > stat.size) return;
      const raw = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      if (raw.version !== 1 || !Array.isArray(raw.tasks) || raw.tasks.length > maxTasks) return;
      const ids = new Set<string>();
      const tasks: TransferTask[] = [];
      for (const value of raw.tasks) {
        try {
          const task = cleanTask(value);
          if (ids.has(task.id)) continue;
          ids.add(task.id);
          if (pending(task)) { task.status = 'paused'; task.transferred = 0; delete task.error; }
          tasks.push(task);
        } catch { /* A damaged row must not prevent restoring other tasks. */ }
      }
      for (const direction of ['download', 'upload'] as const) {
        try { this.state.concurrency[direction] = concurrencyValue(raw.concurrency?.[direction]); } catch { /* Default one. */ }
        this.state.paused[direction] = tasks.some(task => task.direction === direction && pending(task)) || raw.paused?.[direction] === true;
      }
      this.state.tasks = tasks;
    } catch { /* Missing or damaged history is an empty, idle queue. */ }
    finally { await handle?.close().catch(() => undefined); }
  }

  private persist(): Promise<void> {
    const result = this.writes.then(async () => {
      const data = JSON.stringify({ version: 1, tasks: this.state.tasks, concurrency: this.state.concurrency, paused: this.state.paused });
      if (Buffer.byteLength(data) > maxBytes) throw new Error('Transfer history is full.');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(() => undefined); }
    });
    this.writes = result.catch(() => undefined);
    return result;
  }

  private emit(reason?: 'history'): void { try { if (reason) this.changed(this.snapshot(), reason); else this.changed(this.snapshot()); } catch { /* An observer cannot interrupt transfer cleanup. */ } }
  private checkpoint(): void { this.emit(); void this.persist().catch(() => undefined); }

  async enqueue(values: NewTransferTask[], signal?: AbortSignal): Promise<TransferTask[]> {
    await this.ready;
    if (signal?.aborted) throw new Error('Transfer preparation cancelled.');
    if (this.disposed) throw new Error('The transfer queue has stopped.');
    if (!values.length) return [];
    if (this.state.tasks.length + values.length > maxTasks) throw new Error('Transfer history is full.');
    const added = values.map(value => cleanTask({ ...value, id: randomUUID(), transferred: 0, status: this.state.paused[value.direction] ? 'paused' : 'queued', createdAt: new Date().toISOString() }));
    const size = Buffer.byteLength(JSON.stringify({ version: 1, ...this.snapshot(), tasks: [...this.state.tasks, ...added] }));
    if (size > maxBytes) throw new Error('Transfer history is full.');
    this.state.tasks.push(...added);
    try { await this.persist(); }
    catch { const ids = new Set(added.map(task => task.id)); this.state.tasks = this.state.tasks.filter(task => !ids.has(task.id)); throw new Error('Could not save the transfer queue. Check the application data directory.'); }
    if (signal?.aborted) { this.change(added, 'cancel'); await this.persist().catch(() => undefined); }
    this.emit(); this.pump();
    return added.map(task => ({ ...task }));
  }

  private pump(): void {
    if (this.disposed) return;
    for (const direction of ['download', 'upload'] as const) {
      if (this.state.paused[direction]) continue;
      let running = [...this.active.keys()].filter(id => this.state.tasks.find(task => task.id === id)?.direction === direction).length;
      for (const task of this.state.tasks) {
        if (running >= this.state.concurrency[direction]) break;
        if (task.direction !== direction || task.status !== 'queued' || this.active.has(task.id)) continue;
        task.status = 'running'; task.transferred = 0; delete task.error; delete task.finishedAt;
        const entry = { controller: new AbortController(), startedAt: performance.now(), done: undefined as Promise<void> | undefined };
        this.active.set(task.id, entry); running++;
        entry.done = this.run(task, entry.controller);
      }
    }
  }

  private async run(task: TransferTask, controller: AbortController): Promise<void> {
    if (!task.isDirectory && !this.speedTimer) {
      // Rates keep updating through network waits without writing extra history.
      this.speedTimer = setInterval(() => this.emit(), 1000);
      this.speedTimer.unref();
    }
    this.checkpoint();
    try {
      const result = await this.execute({ ...task }, progress => {
        if (controller.signal.aborted || task.status !== 'running') return;
        if (![progress.transferred, progress.total].every(number => Number.isSafeInteger(number) && number >= 0) || progress.transferred > progress.total) return;
        task.size = progress.total; task.transferred = progress.transferred;
        if (!this.progressTimer) this.progressTimer = setTimeout(() => { this.progressTimer = undefined; this.checkpoint(); }, 250);
      }, controller.signal);
      if (controller.signal.aborted || task.status !== 'running') return;
      task.status = 'completed'; task.size = result.bytes; task.transferred = result.bytes; task.finishedAt = new Date().toISOString();
    } catch (error) {
      if (!controller.signal.aborted && task.status === 'running') { task.status = 'failed'; task.error = error instanceof Error ? error.message.slice(0, 1000) : 'The transfer failed. Try starting the task again.'; task.finishedAt = new Date().toISOString(); }
    } finally {
      this.active.delete(task.id);
      if (!this.active.size && this.speedTimer) { clearInterval(this.speedTimer); this.speedTimer = undefined; }
      this.checkpoint(); this.pump();
    }
  }

  private change(tasks: TransferTask[], action: TransferAction): Promise<unknown>[] {
    const cleanup: Promise<unknown>[] = [];
    for (const task of tasks) {
      if (action === 'start') {
        if (task.status === 'paused' || task.status === 'failed') { task.status = 'queued'; task.transferred = 0; delete task.error; delete task.finishedAt; }
      } else if (pending(task) || (action === 'cancel' && task.status === 'failed')) {
        task.status = action === 'stop' ? 'paused' : 'cancelled'; task.transferred = 0; delete task.error;
        if (action === 'cancel') task.finishedAt = new Date().toISOString();
        const entry = this.active.get(task.id); entry?.controller.abort();
        if (entry?.done) cleanup.push(entry.done);
      }
    }
    return cleanup;
  }

  async control(id: unknown, action: unknown): Promise<void> {
    await this.ready;
    if (typeof id !== 'string' || !validAction(action)) throw new Error('Invalid transfer control.');
    const task = this.state.tasks.find(task => task.id === id);
    if (!task) throw new Error('This transfer no longer exists.');
    if (this.removing.has(id)) throw new Error('This transfer is being removed.');
    if (action === 'start') this.state.paused[task.direction] = false;
    const cleanup = this.change([task], action); this.checkpoint(); this.pump();
    await Promise.allSettled(cleanup);
  }

  async controlAll(direction: unknown, action: unknown): Promise<void> {
    await this.ready;
    if (!validDirection(direction) || !validAction(action)) throw new Error('Invalid transfer control.');
    this.state.paused[direction] = action === 'stop';
    const cleanup = this.change(this.state.tasks.filter(task => task.direction === direction && !this.removing.has(task.id)), action); this.checkpoint(); this.pump();
    await Promise.allSettled(cleanup);
  }

  async cancelMatching(predicate: (task: TransferTask) => boolean): Promise<void> {
    await this.ready;
    const cleanup = this.change(this.state.tasks.filter(predicate), 'cancel'); this.checkpoint(); this.pump();
    await Promise.allSettled(cleanup);
  }

  async remove(id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('Invalid transfer.');
    await this.removeMatching(task => task.id === id);
  }

  async clear(direction: unknown): Promise<void> {
    if (!validDirection(direction)) throw new Error('Invalid transfer direction.');
    await this.removeMatching(task => task.direction === direction);
  }

  async clearFinished(direction: unknown): Promise<void> {
    if (!validDirection(direction)) throw new Error('Invalid transfer direction.');
    await this.removeMatching(task => task.direction === direction && !pending(task));
  }

  async removeMatching(predicate: (task: TransferTask) => boolean): Promise<void> {
    await this.ready;
    const tasks = this.state.tasks.filter(predicate);
    if (!tasks.length) return;
    const ids = new Set(tasks.map(task => task.id));
    for (const id of ids) this.removing.add(id);
    // A previous cancellation may have changed status while cleanup is running.
    const cleanup = tasks.map(task => this.active.get(task.id)?.done).filter((done): done is Promise<void> => Boolean(done));
    this.change(tasks, 'cancel'); this.checkpoint(); this.pump();
    try {
      await Promise.allSettled(cleanup);
      this.state.tasks = this.state.tasks.filter(task => !ids.has(task.id));
      await this.persist();
    } finally {
      for (const id of ids) this.removing.delete(id);
      this.emit('history');
    }
  }

  async setConcurrency(direction: unknown, value: unknown): Promise<void> {
    await this.ready;
    if (!validDirection(direction)) throw new Error('Invalid transfer direction.');
    this.state.concurrency[direction] = concurrencyValue(value); await this.persist(); this.emit(); this.pump();
  }

  async dispose(): Promise<void> {
    await this.ready;
    if (this.disposed) { await this.writes; return; }
    this.disposed = true;
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = undefined; }
    if (this.speedTimer) { clearInterval(this.speedTimer); this.speedTimer = undefined; }
    const cleanup = this.change(this.state.tasks.filter(pending), 'stop');
    await Promise.allSettled(cleanup); await this.persist().catch(() => undefined);
  }
}
