// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../src/renderer/src/App';
import { useBrowser } from '../src/renderer/src/useBrowser';
import { nodeKey } from '../src/renderer/src/model';
import { emptyTransferSnapshot, type TransferSnapshot, type TransferTask } from '../src/shared/transfers';
import type { ConfirmationRequest, Connection, Entry, S3API } from '../src/shared/types';

const file: Entry = { key: 'report.txt', name: 'report.txt', kind: 'file', size: 100, modified: '2026-01-01T00:00:00Z' };
const folder: Entry = { key: 'folder/', name: 'folder', kind: 'folder', size: null, modified: null };
const connection: Connection = { id: 'a', name: 'Storage', endpoint: 'https://s3.example.com', bucket: 'bucket', prefix: '', region: null, hasCredentials: false };
const task = (overrides: Partial<TransferTask> = {}): TransferTask => ({ id: 'job', groupId: 'group', direction: 'download', connectionId: 'a', connectionName: 'Storage', bucket: 'bucket', key: file.key, relativePath: file.name, localPath: '/chosen/report.txt', rootPath: '/chosen', size: 100, transferred: 40, isDirectory: false, status: 'running', createdAt: '2026-01-01T00:00:00Z', ...overrides });
function api(client = connection, snapshot = emptyTransferSnapshot()) {
  let transferListener: ((snapshot: TransferSnapshot) => void) | undefined;
  let storageListener: ((id: string) => void) | undefined;
  let confirmationListener: ((request: ConfirmationRequest) => void) | undefined;
  const unsubscribeTransfers = vi.fn();
  const unsubscribeStorage = vi.fn();
  const unsubscribeConfirmation = vi.fn();
  const bridge = {
    connections: vi.fn<S3API['connections']>().mockResolvedValue({ connections: [client], secureStorage: false, cachedListings: [{ connectionId: client.id, prefix: client.prefix, entries: [file, folder], updatedAt: '2026-01-01T00:00:00Z' }] }),
    connectionDetails: vi.fn<S3API['connectionDetails']>(), saveConnection: vi.fn<S3API['saveConnection']>(), copyConnection: vi.fn<S3API['copyConnection']>(), reorderConnections: vi.fn<S3API['reorderConnections']>(), removeConnection: vi.fn<S3API['removeConnection']>(),
    openVideo: vi.fn<S3API['openVideo']>(), startVideo: vi.fn<S3API['startVideo']>(), closeVideo: vi.fn<S3API['closeVideo']>(), onVideoEvent: vi.fn<S3API['onVideoEvent']>().mockReturnValue(() => {}),
    list: vi.fn<S3API['list']>().mockResolvedValue({ entries: [file, folder] }), search: vi.fn<S3API['search']>(), searchUri: vi.fn<S3API['searchUri']>(), stats: vi.fn<S3API['stats']>(), copyText: vi.fn<S3API['copyText']>(),
    download: vi.fn<S3API['download']>().mockResolvedValue('group'), downloadEntries: vi.fn<S3API['downloadEntries']>().mockResolvedValue({ succeeded: 2, failed: [] }), upload: vi.fn<S3API['upload']>().mockResolvedValue('group'), deleteEntry: vi.fn<S3API['deleteEntry']>().mockResolvedValue(true), copyEntry: vi.fn<S3API['copyEntry']>().mockResolvedValue(1), renameEntry: vi.fn<S3API['renameEntry']>().mockResolvedValue(1), deleteEntries: vi.fn<S3API['deleteEntries']>().mockResolvedValue({ succeeded: 2, failed: [] }),
    uploadSources: vi.fn<S3API['uploadSources']>().mockResolvedValue({ directory: '/local', parent: '/', entries: [{ name: file.name, path: '/local/report.txt', kind: 'file' }, { name: folder.name, path: '/local/folder', kind: 'folder' }] }),
    transfers: vi.fn<S3API['transfers']>().mockResolvedValue(snapshot), controlTransfer: vi.fn<S3API['controlTransfer']>().mockResolvedValue(undefined), controlTransfers: vi.fn<S3API['controlTransfers']>().mockResolvedValue(undefined), setTransferConcurrency: vi.fn<S3API['setTransferConcurrency']>().mockResolvedValue(undefined),
    onTransfers: vi.fn<S3API['onTransfers']>().mockImplementation(listener => { transferListener = listener; return unsubscribeTransfers; }),
    onStorageChanged: vi.fn<S3API['onStorageChanged']>().mockImplementation(listener => { storageListener = listener; return unsubscribeStorage; }),
    onConfirmation: vi.fn<S3API['onConfirmation']>().mockImplementation(listener => { confirmationListener = listener; return unsubscribeConfirmation; }),
    onResetViewSizes: vi.fn<S3API['onResetViewSizes']>().mockReturnValue(() => {}),
    answerConfirmation: vi.fn<S3API['answerConfirmation']>().mockResolvedValue(undefined),
    removeTransfer: vi.fn<S3API['removeTransfer']>().mockResolvedValue(undefined),
    clearTransfers: vi.fn<S3API['clearTransfers']>().mockResolvedValue(undefined),
  };
  window.s3 = bridge;
  return { bridge, emit: (snapshot: TransferSnapshot) => act(() => transferListener?.(snapshot)), changed: (id: string) => act(() => storageListener?.(id)), confirm: (request: ConfirmationRequest) => act(() => confirmationListener?.(request)), unsubscribeTransfers, unsubscribeStorage, unsubscribeConfirmation };
}
afterEach(cleanup);

describe('main-process confirmation requests', () => {
  it('blocks the background and shortcuts, answers only on confirmation, and cleans up its listener', async () => {
    const { bridge, confirm, unsubscribeConfirmation } = api();
    const view = render(createElement(App));
    await screen.findByRole('button', { name: 'Download report.txt' });
    confirm({ id: 'delete-request', kind: 'file', name: file.name, path: 's3://bucket/report.txt' });
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete file?' });
    expect(view.container.querySelector<HTMLElement>('.desktop-app')?.inert).toBe(true);
    expect(bridge.answerConfirmation).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'r', ctrlKey: true }); expect(bridge.list).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    expect(bridge.answerConfirmation).toHaveBeenCalledExactlyOnceWith('delete-request', true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(view.container.querySelector<HTMLElement>('.desktop-app')?.inert).toBe(false);
    confirm({ id: 'remove-request', kind: 'connection', name: 'Storage', path: 's3://bucket/' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bridge.answerConfirmation).toHaveBeenLastCalledWith('remove-request', false);
    expect(bridge.onConfirmation).toHaveBeenCalledTimes(1);
    view.unmount(); expect(unsubscribeConfirmation).toHaveBeenCalledOnce();
  });
});

describe('permission-controlled file actions', () => {
  it('opens one Upload chooser for files and folders and starts nothing on cancellation', async () => {
    const { bridge } = api({ ...connection, permissions: { download: true, upload: true, delete: false } });
    const { container } = render(createElement(App));
    const button = await screen.findByRole('button', { name: 'Upload' });
    const searchRow = container.querySelector('.search-strip');
    expect(searchRow?.firstElementChild).toBe(button);
    expect(searchRow?.querySelector('[aria-label="Search range"]')).toBeTruthy();
    expect(container.querySelector('.upload-bar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload folder' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    fireEvent.click(button);
    const chooser = await screen.findByRole('dialog', { name: 'Upload' });
    expect(bridge.search).not.toHaveBeenCalled();
    expect(within(chooser).getByRole('button', { name: 'Upload' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(chooser).getByRole('button', { name: 'Cancel' }));
    expect(bridge.upload).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('defaults to download on every file and folder and opens the native chooser without navigating', async () => {
    const { bridge } = api(); render(createElement(App));
    const button = await screen.findByRole('button', { name: 'Download folder' });
    expect(screen.getByRole('button', { name: 'Download report.txt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete report.txt' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(bridge.list).not.toHaveBeenCalled();
    fireEvent.click(button);
    await screen.findByRole('dialog', { name: 'Downloads' });
    expect(bridge.download).toHaveBeenCalledWith('a', 'folder/', 'folder');
    expect(bridge.list).not.toHaveBeenCalled();
    expect(bridge.transfers).toHaveBeenCalledTimes(1);
  });
  it('supports permitted uploads and deletes with per-row busy state and errors', async () => {
    const { bridge } = api({ ...connection, permissions: { download: false, upload: true, delete: true } });
    let reject!: (reason: Error) => void;
    bridge.deleteEntry.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    render(createElement(App));
    const remove = await screen.findByRole('button', { name: 'Delete report.txt' });
    expect(screen.queryByRole('button', { name: 'Download report.txt' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete folder' })).toBeTruthy();
    fireEvent.click(remove);
    expect(remove.hasAttribute('disabled')).toBe(true);
    expect(bridge.deleteEntry).toHaveBeenCalledWith('a', 'report.txt', 'file');
    await act(async () => reject(new Error('Access denied')));
    expect(await screen.findByText(/Access denied/)).toBeTruthy();
    expect(remove.hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const chooser = await screen.findByRole('dialog', { name: 'Upload' });
    fireEvent.click(await within(chooser).findByRole('checkbox', { name: 'Select report.txt' }));
    fireEvent.click(within(chooser).getByRole('checkbox', { name: 'Select folder' }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Upload' }));
    await screen.findByRole('dialog', { name: 'Uploads' });
    expect(bridge.upload).toHaveBeenCalledWith('a', '', ['/local/report.txt', '/local/folder']);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const again = await screen.findByRole('dialog', { name: 'Upload' });
    fireEvent.click(await within(again).findByRole('checkbox', { name: 'Select folder' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(bridge.upload).toHaveBeenLastCalledWith('a', '', ['/local/folder']));
  });
  it('keeps the browser open when the chooser is cancelled and handles chooser errors', async () => {
    const { bridge } = api(); bridge.download.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Destination unavailable'));
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Download report.txt' }));
    await waitFor(() => expect(bridge.download).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download report.txt' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Download report.txt' }));
    expect(await screen.findByText(/Destination unavailable/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('browses folders and keeps a failed upload selection open for retry', async () => {
    const { bridge } = api({ ...connection, permissions: { download: true, upload: true, delete: false } });
    bridge.upload.mockRejectedValueOnce(new Error('Upload permission changed'));
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload' }));
    const chooser = await screen.findByRole('dialog', { name: 'Upload' });
    fireEvent.click(await within(chooser).findByRole('button', { name: 'Open folder' }));
    await waitFor(() => expect(bridge.uploadSources).toHaveBeenLastCalledWith('a', '', '/local/folder'));
    fireEvent.click(await within(chooser).findByRole('checkbox', { name: 'Select report.txt' }));
    fireEvent.click(within(chooser).getByRole('button', { name: 'Upload' }));
    expect(await within(chooser).findByRole('alert')).toHaveProperty('textContent', 'Upload permission changed');
    expect((within(chooser).getByRole('checkbox', { name: 'Select report.txt' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(chooser).getByRole('button', { name: 'Upload' }));
    await screen.findByRole('dialog', { name: 'Uploads' });
  });
});

describe('bulk file actions', () => {
  const allowed = { ...connection, permissions: { download: true, upload: false, delete: true } };

  it('selects files and folders with checkboxes and opens one download job picker', async () => {
    const { bridge } = api(allowed);
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    const fileBox = within(table).getByRole('checkbox', { name: 'Select report.txt' });
    const folderBox = within(table).getByRole('checkbox', { name: 'Select folder' });
    expect(fileBox.closest('td')?.cellIndex).toBe(0);
    fireEvent.click(fileBox);
    fireEvent.click(folderBox);
    expect(within(table).getByRole('checkbox', { name: 'Select all on this page' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Download 2 selected' }));
    await screen.findByRole('dialog', { name: 'Downloads' });
    expect(bridge.downloadEntries).toHaveBeenCalledExactlyOnceWith('a', [{ key: 'folder/', kind: 'folder' }, { key: 'report.txt', kind: 'file' }]);
    expect(bridge.download).not.toHaveBeenCalled();
  });

  it('deletes a checked group once, then clears selection', async () => {
    const { bridge } = api(allowed);
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all on this page' }));
    expect(within(table).getByRole('checkbox', { name: 'Select report.txt' })).toHaveProperty('checked', true);
    expect(within(table).getByRole('checkbox', { name: 'Select folder' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 selected' }));
    await waitFor(() => expect(bridge.deleteEntries).toHaveBeenCalledExactlyOnceWith('a', [{ key: 'folder/', kind: 'folder' }, { key: 'report.txt', kind: 'file' }]));
    expect(bridge.deleteEntry).not.toHaveBeenCalled();
    expect(within(table).getByRole('checkbox', { name: 'Select report.txt' })).toHaveProperty('checked', false);
  });

  it('keeps checkmarks after cancellation and retains only failed rows after a partial delete', async () => {
    const { bridge } = api(allowed);
    bridge.deleteEntries.mockResolvedValueOnce(null).mockResolvedValueOnce({ succeeded: 1, failed: [{ key: 'folder/', message: 'Access denied' }] });
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 selected' }));
    await waitFor(() => expect(bridge.deleteEntries).toHaveBeenCalledTimes(1));
    expect(within(table).getByRole('checkbox', { name: 'Select folder' })).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 selected' }));
    await waitFor(() => expect(within(table).getByRole('checkbox', { name: 'Select report.txt' })).toHaveProperty('checked', false));
    expect(within(table).getByRole('checkbox', { name: 'Select folder' })).toHaveProperty('checked', true);
    expect(screen.getByText(/1 deleted, 1 failed/)).toBeTruthy();
  });

  it('keeps a failed checked row through the post-delete folder refresh', async () => {
    const { bridge, changed } = api(allowed);
    bridge.deleteEntries.mockResolvedValue({ succeeded: 1, failed: [{ key: 'folder/', message: 'Access denied' }] });
    bridge.list.mockResolvedValue({ entries: [folder] });
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select all on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 selected' }));
    await waitFor(() => expect(within(table).getByRole('checkbox', { name: 'Select folder' })).toHaveProperty('checked', true));
    changed('a');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Select folder' })).toHaveProperty('checked', true));
  });

  it('clears checkmarks when the search changes even if the same row remains visible', async () => {
    api(allowed); render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select report.txt' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    expect(within(table).getByRole('checkbox', { name: 'Select report.txt' })).toHaveProperty('checked', false);
  });

  it('drops checked items on a folder change and hides bulk actions without permission', async () => {
    const { bridge } = api({ ...connection, permissions: { download: false, upload: false, delete: false } });
    bridge.list.mockImplementation(async (_id, prefix) => ({ entries: prefix === 'folder/' ? [] : [file, folder] }));
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Select report.txt' }));
    expect(screen.queryByRole('button', { name: /Download .* selected/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete .* selected/ })).toBeNull();
    fireEvent.doubleClick(within(table).getByRole('row', { name: /folder/ }));
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Selected items' })).toBeNull());
    fireEvent.click(document.querySelector('.breadcrumb button')!);
    expect(await screen.findByRole('checkbox', { name: 'Select report.txt' })).toHaveProperty('checked', false);
  });
});

describe('transfer panel', () => {
  it.each(['download', 'upload'] as const)('removes every kind of %s row and clears only the current list', async direction => {
    const statuses = ['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
    const snapshot: TransferSnapshot = { ...emptyTransferSnapshot(), tasks: statuses.map((status, index) => task({ direction, status, id: `row-${index}`, relativePath: `file-${index}.txt` })), preparations: ['preparing', 'failed', 'cancelled'].map((status, index) => ({ id: `scan-${index}`, direction, connectionId: 'a', name: `folder-${index}`, status: status as 'preparing' | 'failed' | 'cancelled' })) };
    const { bridge, emit } = api(connection, snapshot);
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: direction === 'download' ? /Downloads/ : /Uploads/ }));
    const dialog = await screen.findByRole('dialog', { name: direction === 'download' ? 'Downloads' : 'Uploads' });
    expect(within(dialog).getAllByRole('button', { name: /^Remove .* from list$/ })).toHaveLength(9);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove file-3.txt from list' }));
    await waitFor(() => expect(bridge.removeTransfer).toHaveBeenCalledWith('row-3'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(bridge.clearTransfers).toHaveBeenCalledWith(direction));
    emit(emptyTransferSnapshot());
    expect(within(dialog).queryByRole('article')).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Clear all' }).hasAttribute('disabled')).toBe(true);
  });
  it.each(['download', 'upload'] as const)('shows and updates speed for active %s files only', async direction => {
    const snapshot = { ...emptyTransferSnapshot(), tasks: [task({ direction, bytesPerSecond: 110_000 })] };
    const { emit } = api(connection, snapshot);
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: direction === 'download' ? /Downloads/ : /Uploads/ }));
    const dialog = await screen.findByRole('dialog', { name: direction === 'download' ? 'Downloads' : 'Uploads' });
    expect(within(dialog).getByText('110kB/s')).toBeTruthy();
    emit({ ...snapshot, tasks: [task({ direction, bytesPerSecond: 1_200_000 })] });
    expect(within(dialog).getByText('1.2MB/s')).toBeTruthy();
    emit({ ...snapshot, tasks: [task({ direction, status: 'paused', bytesPerSecond: 1_200_000 })] });
    expect(within(dialog).queryByText(/B\/s/)).toBeNull();
    emit({ ...snapshot, tasks: [task({ direction, status: 'completed', bytesPerSecond: 1_200_000 })] });
    expect(within(dialog).queryByText(/B\/s/)).toBeNull();
  });
  it('shows progress and preparation, supports controls, traps focus, and restores the opener', async () => {
    const snapshot = { ...emptyTransferSnapshot(), tasks: [task(), task({ id: 'paused', relativePath: 'paused.txt', status: 'paused', transferred: 0 }), task({ id: 'done', relativePath: 'done.txt', status: 'completed', transferred: 100 })], preparations: [{ id: 'scan', direction: 'download' as const, connectionId: 'a', name: 'folder', status: 'preparing' as const }] };
    const { bridge, emit } = api(connection, snapshot); const { container } = render(createElement(App));
    const opener = await screen.findByRole('button', { name: /Downloads/ }); opener.focus(); fireEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: 'Downloads' });
    expect(container.querySelector<HTMLElement>('.desktop-app')?.inert).toBe(true);
    expect(within(dialog).getByRole('progressbar', { name: 'Progress for report.txt' }).getAttribute('aria-valuenow')).toBe('40');
    expect(within(within(dialog).getByRole('article', { name: 'report.txt' })).getByText('/chosen/report.txt')).toBeTruthy();
    expect(within(dialog).getByText('40 B / 100 B · 40%')).toBeTruthy();
    expect(within(dialog).getByText('Scanning…')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop report.txt' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start paused.txt' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel folder' }));
    expect(bridge.controlTransfer.mock.calls).toEqual([['job', 'stop'], ['paused', 'start'], ['scan', 'cancel']]);
    for (const action of ['Start', 'Stop', 'Cancel']) fireEvent.click(within(dialog).getByRole('button', { name: `${action} all` }));
    expect(bridge.controlTransfers.mock.calls).toEqual([['download', 'start'], ['download', 'stop'], ['download', 'cancel']]);
    fireEvent.change(within(dialog).getByLabelText('Concurrent downloads'), { target: { value: '3' } });
    expect(bridge.setTransferConcurrency).toHaveBeenCalledWith('download', 3);
    emit({ ...snapshot, tasks: [task({ transferred: 75 })] });
    expect(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
    const buttons = within(dialog).getAllByRole('button'); const first = buttons[0]; const last = buttons[buttons.length - 1];
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' }); expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'r', ctrlKey: true }); expect(bridge.list).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(container.querySelector<HTMLElement>('.desktop-app')?.inert).toBe(false);
  });
  it('keeps all jobs reachable and reports control failures without closing', async () => {
    const snapshot = { ...emptyTransferSnapshot(), tasks: Array.from({ length: 51 }, (_, index) => task({ id: String(index), relativePath: `file-${index}.txt` })) };
    const { bridge } = api(connection, snapshot); bridge.controlTransfers.mockRejectedValue(new Error('Queue unavailable'));
    render(createElement(App)); fireEvent.click(await screen.findByRole('button', { name: /Downloads/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Downloads' });
    await within(dialog).findByText('file-0.txt');
    expect(within(dialog).queryByText('file-50.txt')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next page' }));
    expect(within(dialog).getByText('file-50.txt')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop all' }));
    expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Queue unavailable');
  });
  it('subscribes once and cleans up listeners, preserving a push newer than bootstrap', async () => {
    const { bridge, emit, unsubscribeTransfers, unsubscribeStorage } = api();
    let resolve!: (snapshot: TransferSnapshot) => void;
    bridge.transfers.mockReturnValue(new Promise(done => { resolve = done; }));
    const view = render(createElement(App));
    await screen.findByRole('button', { name: /Downloads/ });
    emit({ ...emptyTransferSnapshot(), tasks: [task()] });
    await act(async () => resolve(emptyTransferSnapshot()));
    fireEvent.click(screen.getByRole('button', { name: /Downloads/ }));
    expect(await screen.findByText('/chosen/report.txt')).toBeTruthy();
    expect(bridge.onTransfers).toHaveBeenCalledTimes(1); expect(bridge.onStorageChanged).toHaveBeenCalledTimes(1);
    view.unmount(); expect(unsubscribeTransfers).toHaveBeenCalledOnce(); expect(unsubscribeStorage).toHaveBeenCalledOnce();
  });
  it('returns focus to the dialog when an update removes the focused task action', async () => {
    const { emit } = api(connection, { ...emptyTransferSnapshot(), tasks: [task()] });
    render(createElement(App)); fireEvent.click(await screen.findByRole('button', { name: /Downloads/ }));
    const cancel = await screen.findByRole('button', { name: 'Cancel report.txt' }); cancel.focus();
    emit({ ...emptyTransferSnapshot(), tasks: [task({ status: 'cancelled' })] });
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close transfer panel' }));
  });
});

describe('storage changes', () => {
  it('invalidates cached listings and statistics then reloads the current location', async () => {
    const { bridge, changed } = api(); const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    bridge.stats.mockResolvedValue({ fileCount: 1, totalSize: 100, updatedAt: '2026-01-01T00:00:00Z', durationMs: 1 });
    await act(async () => result.current.scanStats('a', 'folder/'));
    bridge.list.mockResolvedValue({ entries: [] }); changed('a');
    await waitFor(() => expect(bridge.list).toHaveBeenCalledWith('a', '', 1000, null, 0));
    await waitFor(() => expect(result.current.nodes[nodeKey('a', '')]?.entries).toEqual([]));
    expect(result.current.statistics).toEqual({}); expect(result.current.location).toEqual({ connectionId: 'a', prefix: '' });
  });
});
