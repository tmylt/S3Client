import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewTransferTask, TransferSnapshot } from '../src/shared/transfers';
import { TransferQueue, type TransferExecutor } from '../src/main/transfer-queue';

const directories: string[] = [];
const queues: TransferQueue[] = [];
const task = (key: string, direction: 'download' | 'upload' = 'download'): NewTransferTask => ({ groupId: 'group', direction, connectionId: 'connection', connectionName: 'Storage', bucket: 'bucket', key, relativePath: key, localPath: `/tmp/destination/${key}`, rootPath: '/tmp/destination', size: 10, isDirectory: false });
function deferred<T = void>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function make(execute: TransferExecutor, changed?: (snapshot: TransferSnapshot) => void) {
  const directory = await mkdtemp(join(tmpdir(), 's3-transfer-queue-')); directories.push(directory);
  const queue = new TransferQueue(directory, execute, changed); queues.push(queue); await queue.initialize(); return { queue, directory };
}
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.dispose())); await Promise.all(directories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))); vi.restoreAllMocks(); });

describe('transfer queue', () => {
  it('removes an active row only after cleanup and prevents restarting it while removal is pending', async () => {
    const cleanup = deferred(); const aborted = deferred();
    const { queue } = await make(async (item, progress, signal) => {
      if (item.key === 'one') { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await aborted.promise; await cleanup.promise; progress({ transferred: 10, total: 10 }); }
      return { bytes: 10 };
    });
    await queue.enqueue([task('one'), task('two')]);
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].status).toBe('running'));
    const id = queue.snapshot().tasks[0].id;
    let removal: Promise<void> | undefined;
    try {
      removal = queue.remove(id);
      await aborted.promise;
      expect(queue.snapshot().tasks.some(task => task.id === id)).toBe(true);
      await expect(queue.control(id, 'start')).rejects.toThrow(/removed/i);
    } finally { cleanup.resolve(); }
    await removal;
    expect(queue.snapshot().tasks.map(task => task.key)).toEqual(['two']);
  });

  it('clears only one direction durably and keeps completed files and queue settings', async () => {
    const { queue, directory } = await make(async () => ({ bytes: 10 }));
    await writeFile(join(directory, 'keep.txt'), 'keep completed data');
    await queue.enqueue([task('down'), task('up', 'upload')]);
    await vi.waitFor(() => expect(queue.snapshot().tasks.every(task => task.status === 'completed')).toBe(true));
    await queue.setConcurrency('download', 3);
    await queue.clear('download');
    expect(queue.snapshot().tasks.map(task => task.key)).toEqual(['up']);
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep completed data');
    const restored = new TransferQueue(directory, vi.fn()); queues.push(restored); await restored.initialize();
    expect(restored.snapshot().tasks.map(task => task.key)).toEqual(['up']);
    expect(restored.snapshot().concurrency.download).toBe(3);
  });

  it('clears finished history while a transfer continues and queued work stays queued', async () => {
    const stopped = deferred(); const cancel = vi.fn();
    const { queue, directory } = await make(async (item, progress, signal) => {
      if (item.key === 'active') {
        signal.addEventListener('abort', () => { cancel(); stopped.resolve(); }, { once: true });
        progress({ transferred: 5, total: 10 }); await stopped.promise;
      }
      return { bytes: 10 };
    });
    await queue.enqueue([task('finished')]);
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].status).toBe('completed'));
    await queue.enqueue([task('active'), task('queued')]);
    await vi.waitFor(() => expect(queue.snapshot().tasks.map(item => item.status)).toEqual(['completed', 'running', 'queued']));
    await queue.clearFinished('download');
    expect(queue.snapshot().tasks.map(item => [item.key, item.status, item.transferred])).toEqual([['active', 'running', 5], ['queued', 'queued', 0]]);
    expect(cancel).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, 'transfer-queue.json'), 'utf8')).tasks.map((item: { key: string }) => item.key)).toEqual(['active', 'queued']);
  });

  it('clears active and queued rows together without starting queued work or interrupting the other direction', async () => {
    const cleanup = deferred(); const aborted = deferred(); const starts: string[] = [];
    const { queue } = await make(async (item, _progress, signal) => {
      starts.push(item.key);
      if (item.key === 'down1') { signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await aborted.promise; await cleanup.promise; }
      return { bytes: 10 };
    });
    await queue.enqueue([task('down1'), task('down2'), task('up', 'upload')]);
    const clearing = queue.clear('download');
    try {
      await aborted.promise;
      await queue.controlAll('download', 'start');
      expect(starts).toEqual(['down1', 'up']);
    } finally { cleanup.resolve(); }
    await clearing;
    expect(queue.snapshot().tasks.map(task => task.key)).toEqual(['up']);
  });
  it('measures both directions, publishes rates without new progress and resets restarted attempts', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const changed = vi.fn<(snapshot: TransferSnapshot) => void>();
    const progress = new Map<string, (value: { transferred: number; total: number }) => void>();
    const { queue, directory } = await make(async (item, report, signal) => {
      progress.set(item.key, report);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { bytes: item.size };
    }, changed);
    await queue.enqueue([task('down'), task('up', 'upload')]);
    now = 1000;
    progress.get('down')!({ transferred: 110_000, total: 1_000_000 });
    progress.get('up')!({ transferred: 1_200_000, total: 2_000_000 });
    expect(queue.snapshot().tasks.map(item => item.bytesPerSecond)).toEqual([110_000, 1_200_000]);
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0].tasks[0].bytesPerSecond).toBe(110_000));
    now = 2000;
    await vi.waitFor(() => expect(changed.mock.calls.at(-1)?.[0].tasks.map(item => item.bytesPerSecond)).toEqual([55_000, 600_000]), { timeout: 1500 });
    await queue.controlAll('download', 'stop');
    expect(queue.snapshot().tasks[0].bytesPerSecond).toBe(0);
    now = 100_000;
    await queue.control(queue.snapshot().tasks[0].id, 'start');
    now = 101_000;
    progress.get('down')!({ transferred: 200_000, total: 1_000_000 });
    expect(queue.snapshot().tasks[0].bytesPerSecond).toBe(200_000);
    await queue.controlAll('download', 'cancel');
    expect(queue.snapshot().tasks[0].bytesPerSecond).toBe(0);
    await queue.dispose();
    expect(await readFile(join(directory, 'transfer-queue.json'), 'utf8')).not.toContain('bytesPerSecond');
  });
  it('runs FIFO with default concurrency one and reports byte progress', async () => {
    const first = deferred<{ bytes: number }>();
    const started: string[] = [];
    const { queue } = await make(async (item, progress) => { started.push(item.key); progress({ transferred: 4, total: 10 }); return item.key === 'one' ? first.promise : { bytes: 10 }; });
    await queue.enqueue([task('one'), task('two')]);
    await vi.waitFor(() => expect(started).toEqual(['one']));
    expect(queue.snapshot().concurrency.download).toBe(1);
    expect(queue.snapshot().tasks[0]).toMatchObject({ status: 'running', transferred: 4 });
    first.resolve({ bytes: 10 });
    await vi.waitFor(() => expect(queue.snapshot().tasks.map(item => item.status)).toEqual(['completed', 'completed']));
    expect(started).toEqual(['one', 'two']);
  });

  it('does not release a cancelled slot until execution cleanup finishes, and ignores late completion', async () => {
    const cleanup = deferred(); const aborted = deferred();
    const started: string[] = [];
    const { queue } = await make(async (item, progress, signal) => {
      started.push(item.key);
      if (item.key === 'one') { signal.addEventListener('abort', () => aborted.resolve()); await aborted.promise; await cleanup.promise; progress({ transferred: 10, total: 10 }); return { bytes: 10 }; }
      return { bytes: 10 };
    });
    await queue.enqueue([task('one'), task('two')]);
    await vi.waitFor(() => expect(started).toEqual(['one']));
    const cancellation = queue.control(queue.snapshot().tasks[0].id, 'cancel');
    await aborted.promise;
    expect(queue.snapshot().tasks[0].status).toBe('cancelled');
    expect(started).toEqual(['one']);
    cleanup.resolve(); await cancellation;
    await vi.waitFor(() => expect(started).toEqual(['one', 'two']));
    expect(queue.snapshot().tasks[0]).toMatchObject({ status: 'cancelled', transferred: 0 });
  });

  it('stops all, restarts paused files from zero, and leaves completed files when cancelling all', async () => {
    const starts = new Map<string, number>();
    const { queue } = await make(async (item, progress, signal) => {
      starts.set(item.key, (starts.get(item.key) ?? 0) + 1); progress({ transferred: 5, total: 10 });
      if (starts.get(item.key) === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { bytes: 10 };
    });
    await queue.enqueue([task('one'), task('two')]);
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].status).toBe('running'));
    await queue.controlAll('download', 'stop');
    expect(queue.snapshot().tasks.map(item => item.status)).toEqual(['paused', 'paused']);
    await queue.control(queue.snapshot().tasks[0].id, 'start');
    await vi.waitFor(() => expect(queue.snapshot().tasks[0].status).toBe('completed'));
    expect(starts.get('two')).toBeUndefined();
    await queue.controlAll('download', 'cancel');
    expect(queue.snapshot().tasks.map(item => item.status)).toEqual(['completed', 'cancelled']);
  });

  it('keeps direction limits independent and accepts concurrency changes', async () => {
    const releases: Array<ReturnType<typeof deferred<{ bytes: number }>>> = [];
    const started: string[] = [];
    const { queue } = await make(async item => { started.push(item.key); const release = deferred<{ bytes: number }>(); releases.push(release); return release.promise; });
    await queue.enqueue([task('down1'), task('down2'), task('up1', 'upload'), task('up2', 'upload')]);
    await vi.waitFor(() => expect(started).toEqual(['down1', 'up1']));
    await queue.setConcurrency('download', 2);
    await vi.waitFor(() => expect(started).toEqual(['down1', 'up1', 'down2']));
    await expect(queue.setConcurrency('download', 0)).rejects.toThrow(/concurrency/i);
    const cancellation = queue.controlAll('download', 'cancel');
    releases.forEach(release => release.resolve({ bytes: 10 })); await cancellation;
    const uploadCancellation = queue.controlAll('upload', 'cancel');
    releases.forEach(release => release.resolve({ bytes: 10 })); await uploadCancellation;
  });

  it('restores unfinished work paused without executing and persists no unrecognized fields', async () => {
    const execute = vi.fn<TransferExecutor>().mockImplementation(async (_task, _progress, signal) => { await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { bytes: 10 }; });
    const { queue, directory } = await make(execute);
    await queue.enqueue([{ ...task('one'), secretKey: 'SHOULD_NOT_PERSIST' } as NewTransferTask, task('two')]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1)); await queue.dispose();
    const restoredExecute = vi.fn<TransferExecutor>();
    const restored = new TransferQueue(directory, restoredExecute); queues.push(restored); await restored.initialize();
    expect(restored.snapshot().tasks.map(item => item.status)).toEqual(['paused', 'paused']);
    expect(restoredExecute).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'transfer-queue.json'), 'utf8')).not.toContain('SHOULD_NOT_PERSIST');
    expect(restored.snapshot().paused.download).toBe(true);
  });
});
