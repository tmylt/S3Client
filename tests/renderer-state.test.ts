// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/renderer/src/App';
import { VideoPlayer } from '../src/renderer/src/components/VideoPlayer';
import { useBrowser } from '../src/renderer/src/useBrowser';
import { formatDate, nodeKey } from '../src/renderer/src/model';
import type { CachedListing, Connection, Entry, Listing, S3API } from '../src/shared/types';
import { emptyTransferSnapshot } from '../src/shared/transfers';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const connection = (id: string, prefix = ''): Connection => ({ id, name: id.toUpperCase(), endpoint: 'https://s3.example.com', bucket: 'bucket', prefix, region: 'us-east-1', hasCredentials: false });
const file = (size: number, modified = '2026-01-01T00:00:00Z', storageClass = 'STANDARD'): Entry => ({ key: 'report.txt', name: 'report.txt', kind: 'file', size, modified, storageClass });

function api(connections: Connection[], cachedListings: CachedListing[] = []) {
  const value = {
    connections: vi.fn<S3API['connections']>().mockResolvedValue({ connections, secureStorage: false, cachedListings }),
    connectionDetails: vi.fn<S3API['connectionDetails']>().mockImplementation(async id => ({ ...connections.find(item => item.id === id)!, accessKey: 'CONFIGURED_AK', secretKey: 'CONFIGURED_SK' })),
    list: vi.fn<S3API['list']>().mockResolvedValue({ entries: [] }),
    search: vi.fn<S3API['search']>().mockResolvedValue({ entries: [], nextToken: null }),
    searchUri: vi.fn<S3API['searchUri']>().mockResolvedValue({ entries: [], nextToken: null }),
    stats: vi.fn<S3API['stats']>(),
    saveConnection: vi.fn<S3API['saveConnection']>(),
    copyConnection: vi.fn<S3API['copyConnection']>(),
    reorderConnections: vi.fn<S3API['reorderConnections']>().mockResolvedValue(undefined),
    removeConnection: vi.fn<S3API['removeConnection']>().mockResolvedValue(true),
    copyText: vi.fn<S3API['copyText']>().mockResolvedValue(undefined),
    download: vi.fn<S3API['download']>().mockResolvedValue(null),
    downloadEntries: vi.fn<S3API['downloadEntries']>().mockResolvedValue(null),
    upload: vi.fn<S3API['upload']>().mockResolvedValue(null),
    openVideo: vi.fn<S3API['openVideo']>().mockResolvedValue({ id: 'video-1', mode: 'stream', total: 10, url: 'http://127.0.0.1:12345/v/abcdefghijklmnopqrstuvwx12345678' }),
    startVideo: vi.fn<S3API['startVideo']>().mockResolvedValue(undefined),
    closeVideo: vi.fn<S3API['closeVideo']>().mockResolvedValue(undefined),
    onVideoEvent: vi.fn<S3API['onVideoEvent']>().mockReturnValue(() => {}),
    uploadSources: vi.fn<S3API['uploadSources']>().mockResolvedValue({ directory: '/local', parent: '/', entries: [] }),
    deleteEntry: vi.fn<S3API['deleteEntry']>().mockResolvedValue(false),
    copyEntry: vi.fn<S3API['copyEntry']>().mockResolvedValue(1),
    renameEntry: vi.fn<S3API['renameEntry']>().mockResolvedValue(1),
    deleteEntries: vi.fn<S3API['deleteEntries']>().mockResolvedValue(null),
    transfers: vi.fn<S3API['transfers']>().mockResolvedValue(emptyTransferSnapshot()),
    controlTransfer: vi.fn<S3API['controlTransfer']>().mockResolvedValue(undefined),
    controlTransfers: vi.fn<S3API['controlTransfers']>().mockResolvedValue(undefined),
    setTransferConcurrency: vi.fn<S3API['setTransferConcurrency']>().mockResolvedValue(undefined),
    onTransfers: vi.fn<S3API['onTransfers']>().mockReturnValue(() => {}),
    onStorageChanged: vi.fn<S3API['onStorageChanged']>().mockReturnValue(() => {}),
    onConfirmation: vi.fn<S3API['onConfirmation']>().mockReturnValue(() => {}),
    onResetViewSizes: vi.fn<S3API['onResetViewSizes']>().mockReturnValue(() => {}),
    answerConfirmation: vi.fn<S3API['answerConfirmation']>().mockResolvedValue(undefined),
    removeTransfer: vi.fn<S3API['removeTransfer']>().mockResolvedValue(undefined),
    clearTransfers: vi.fn<S3API['clearTransfers']>().mockResolvedValue(undefined),
  };
  window.s3 = value;
  return value;
}

afterEach(cleanup);

describe('file row copy menu', () => {
  beforeEach(() => localStorage.clear());

  it('copies the URI, exact S3 key, or basename from a searched file row', async () => {
    const item: Entry = { key: 'root/deep/report (6).db', name: 'deep/report (6).db', kind: 'file', size: 12, modified: null };
    const bridge = api([{ ...connection('a', 'root/'), uriScheme: 'oss' }], [{ connectionId: 'a', prefix: 'root/', entries: [item], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    const row = within(table).getByText(item.name).closest('tr')!;
    const open = () => fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });

    open();
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map(button => button.textContent)).toEqual(['Copy URI', 'Copy S3 key', 'Copy file name', 'Copy to…', 'Rename…']);
    expect(screen.getByRole('menuitem', { name: 'Copy to…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Rename…' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy URI' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('oss://bucket/root/deep/report (6).db'));
    expect(screen.queryByRole('menu')).toBeNull();

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy S3 key' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('root/deep/report (6).db'));

    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy file name' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('report (6).db'));
  });

  it('copies folder keys with their slash and folder names without it', async () => {
    const item: Entry = { key: 'root/deep/folder/', name: 'deep/folder', kind: 'folder', size: null, modified: null };
    const bridge = api([connection('a', 'root/')], [{ connectionId: 'a', prefix: 'root/', entries: [item], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    const row = (await screen.findByRole('table', { name: 'Folder contents' })).querySelector('tbody tr')!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy S3 key' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('root/deep/folder/'));
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy folder name' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('folder'));
  });

  it('copies a file to a chosen folder and name in the same connection', async () => {
    const item: Entry = { key: 'root/deep/report (6).db', name: 'report (6).db', kind: 'file', size: 12, modified: null };
    const client = { ...connection('a', 'root/'), permissions: { download: true, upload: true, delete: false } };
    const bridge = api([client], [{ connectionId: 'a', prefix: 'root/', entries: [item], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    const row = (await screen.findByRole('table', { name: 'Folder contents' })).querySelector('tbody tr')!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy file' });
    expect(within(dialog).getByRole('textbox', { name: 'Destination S3 folder key' }).getAttribute('value')).toBe('root/deep/');
    expect(within(dialog).getByRole('textbox', { name: 'New name' }).getAttribute('value')).toBe('report (6).db');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Destination S3 folder key' }), { target: { value: 'root/archive/' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New name' }), { target: { value: 'renamed.db' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(bridge.copyEntry).toHaveBeenCalledExactlyOnceWith('a', item.key, 'file', 'root/archive/', 'renamed.db'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy file' })).toBeNull());
  });

  it('browses destination folders without changing the connection', async () => {
    const item: Entry = { key: 'root/report.txt', name: 'report.txt', kind: 'file', size: 12, modified: null };
    const folder: Entry = { key: 'root/archive/', name: 'archive', kind: 'folder', size: null, modified: null };
    const bridge = api([{ ...connection('a', 'root/'), permissions: { download: true, upload: true, delete: false } }], [{ connectionId: 'a', prefix: 'root/', entries: [item], updatedAt: '2026-01-01T00:00:00Z' }]);
    bridge.list.mockImplementation(async (_id, prefix) => ({ entries: prefix === 'root/' ? [folder] : [], nextToken: null }));
    render(createElement(App));
    const row = (await screen.findByRole('table', { name: 'Folder contents' })).querySelector('tbody tr')!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy to…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy file' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'archive' }));
    await waitFor(() => expect(within(dialog).getByRole('textbox', { name: 'Destination S3 folder key' }).getAttribute('value')).toBe('root/archive/'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(bridge.copyEntry).toHaveBeenCalledExactlyOnceWith('a', item.key, 'file', 'root/archive/', 'report.txt'));
  });

  it('renames an item in its current folder after both write permissions are enabled', async () => {
    const item: Entry = { key: 'root/deep/report (6).db', name: 'report (6).db', kind: 'file', size: 12, modified: null };
    const client = { ...connection('a', 'root/'), permissions: { download: true, upload: true, delete: true } };
    const bridge = api([client], [{ connectionId: 'a', prefix: 'root/', entries: [item], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    const row = (await screen.findByRole('table', { name: 'Folder contents' })).querySelector('tbody tr')!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' });
    expect(within(dialog).getByRole('textbox', { name: 'New name' }).getAttribute('value')).toBe('report (6).db');
    expect(within(dialog).getByRole('button', { name: 'Rename' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'New name' }), { target: { value: 'renamed.db' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(bridge.renameEntry).toHaveBeenCalledExactlyOnceWith('a', item.key, 'file', 'renamed.db'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull());
  });

  it('closes the menu with Escape and an outside click', async () => {
    api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(4)], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    const row = (await screen.findByRole('table', { name: 'Folder contents' })).querySelector('tbody tr')!;
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(row, { clientX: 120, clientY: 150 });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('cross-connection URI search', () => {
  beforeEach(() => localStorage.clear());

  it('reports when no connection has the URI scheme and bucket', async () => {
    const client = { ...connection('one'), uriScheme: 's3' };
    const service = api([client]);
    render(createElement(App));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search URI across connections' }), { target: { value: 'obs://bucket/a.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to URI' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No connection for obs://bucket');
    expect(service.searchUri).not.toHaveBeenCalled();
  });

  it('uses the highest-priority connection and shows an exact file result', async () => {
    const partial = connection('partial', 'ap/bsfa/other/');
    const ancestor = connection('ancestor', 'ap/');
    const service = api([partial, ancestor]);
    service.searchUri.mockResolvedValue({ entries: [{ key: 'ap/bsfa/cds/file.txt', name: 'ap/bsfa/cds/file.txt', kind: 'file', size: 4, modified: null }] });
    render(createElement(App));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search URI across connections' }), { target: { value: 's3://bucket/ap/bsfa/cds/file.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to URI' }));
    await waitFor(() => expect(service.searchUri).toHaveBeenCalledWith('ancestor', 'ap/bsfa/cds/file.txt'));
    expect(await screen.findByText('ap/bsfa/cds/file.txt', { selector: '.filename span' })).toBeTruthy();
    expect(screen.getByText('Using ANCESTOR')).toBeTruthy();
  });

  it('shows an outside-prefix folder through the closest matching connection without allowing file operations', async () => {
    const service = api([connection('less', 'ap/other/'), connection('closest', 'ap/bsfa/other/')]);
    service.searchUri.mockResolvedValue({ entries: [{ key: 'ap/bsfa/cds/', name: 'ap/bsfa/cds/', kind: 'folder', size: null, modified: null }] });
    render(createElement(App));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search URI across connections' }), { target: { value: 's3://bucket/ap/bsfa/cds/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go to URI' }));
    await waitFor(() => expect(service.searchUri).toHaveBeenCalledWith('closest', 'ap/bsfa/cds/'));
    expect(await screen.findByText('ap/bsfa/cds/', { selector: '.filename span' })).toBeTruthy();
    expect(screen.getByText(/outside this connection’s browsing prefix/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Download ap\/bsfa\/cds/ })).toBeNull();
  });
});

describe('resizable file columns', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  async function open() {
    api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(42)], updatedAt: '2026-01-01T00:00:00Z' }]);
    const view = render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    return { view, table, name: within(table).getByRole('separator', { name: 'Resize Name column' }) };
  }

  it('resizes independently with keyboard controls, persists on remount, and leaves sorting unchanged', async () => {
    const { view, table, name } = await open();
    expect(within(table).getAllByRole('separator')).toHaveLength(7);
    const initial = Number(name.getAttribute('aria-valuenow'));
    const modified = within(table).getByRole('separator', { name: 'Resize Date modified column' });
    const dateWidth = modified.getAttribute('aria-valuenow');
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(name.getAttribute('aria-valuenow')).toBe(String(initial + 10));
    fireEvent.keyDown(name, { key: 'ArrowRight', shiftKey: true });
    expect(name.getAttribute('aria-valuenow')).toBe(String(initial + 60));
    expect(modified.getAttribute('aria-valuenow')).toBe(dateWidth);
    expect(within(table).getByRole('columnheader', { name: 'Name' }).getAttribute('aria-sort')).toBe('ascending');
    expect((table.querySelector('col.name-column') as HTMLElement).style.width).toBe(`${initial + 60}px`);
    view.unmount();
    const next = await open();
    expect(next.name.getAttribute('aria-valuenow')).toBe(String(initial + 60));
  });

  it('restores the sidebar width after remounting and resets the sidebar and columns from View', async () => {
    const first = await open();
    const sidebar = screen.getByRole('separator', { name: 'Resize sidebar' });
    fireEvent.keyDown(sidebar, { key: 'ArrowRight' });
    fireEvent.keyDown(first.name, { key: 'ArrowRight' });
    expect(sidebar.getAttribute('aria-valuenow')).toBe('260');
    expect(first.name.getAttribute('aria-valuenow')).toBe('250');
    first.view.unmount();

    const second = await open();
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('260');
    expect(second.name.getAttribute('aria-valuenow')).toBe('250');
    // The View menu event arrives over preload; the mock captures its listener.
    const reset = vi.mocked(window.s3.onResetViewSizes).mock.calls.at(-1)?.[0];
    expect(reset).toBeDefined();
    act(() => reset!());
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('250');
    expect(second.name.getAttribute('aria-valuenow')).toBe('240');
    second.view.unmount();
    const third = await open();
    expect(screen.getByRole('separator', { name: 'Resize sidebar' }).getAttribute('aria-valuenow')).toBe('250');
    expect(third.name.getAttribute('aria-valuenow')).toBe('240');
  });

  it('clamps resizing and restores only the chosen column on double-click', async () => {
    const { table, name } = await open();
    const initial = name.getAttribute('aria-valuenow');
    const size = within(table).getByRole('separator', { name: 'Resize Size column' });
    fireEvent.keyDown(size, { key: 'ArrowRight' });
    const sizeWidth = size.getAttribute('aria-valuenow');
    fireEvent.keyDown(name, { key: 'Home' });
    fireEvent.keyDown(name, { key: 'ArrowLeft' });
    expect(name.getAttribute('aria-valuenow')).toBe(name.getAttribute('aria-valuemin'));
    fireEvent.keyDown(name, { key: 'End' });
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(name.getAttribute('aria-valuenow')).toBe(name.getAttribute('aria-valuemax'));
    fireEvent.doubleClick(name);
    expect(name.getAttribute('aria-valuenow')).toBe(initial);
    expect(size.getAttribute('aria-valuenow')).toBe(sizeWidth);
  });

  it('keeps resizing usable when saved preferences are corrupt or cannot be written', async () => {
    localStorage.setItem('s3-client.file-column-widths.v1', 'broken JSON');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
    const { name } = await open();
    const initial = Number(name.getAttribute('aria-valuenow'));
    fireEvent.keyDown(name, { key: 'ArrowRight' });
    expect(name.getAttribute('aria-valuenow')).toBe(String(initial + 10));
  });
});

describe('MP4 preview', () => {
  beforeEach(() => localStorage.clear());

  it('lets the player grow with the resize handle and remembers its size', () => {
    api([]);
    const props = { connectionId: 'a', objectKey: 'sample.mp4', name: 'sample.mp4', onClose: vi.fn() };
    const first = render(createElement(VideoPlayer, props));
    const dialog = screen.getByRole('dialog', { name: 'Play sample.mp4' });
    const handle = within(dialog).getByRole('button', { name: 'Resize video player' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(dialog.style.width).toBe('880px');
    expect(dialog.style.height).toBe('500px');
    first.unmount();
    render(createElement(VideoPlayer, props));
    const reopened = screen.getByRole('dialog', { name: 'Play sample.mp4' });
    expect(reopened.style.width).toBe('880px');
    expect(reopened.style.height).toBe('500px');
  });

  it('uses the Fullscreen API and keeps Escape from closing the player while fullscreen', async () => {
    api([]);
    const onClose = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn().mockResolvedValue(undefined);
    const originalRequest = HTMLElement.prototype.requestFullscreen;
    const originalExit = document.exitFullscreen;
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request });
    Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit });
    try {
      render(createElement(VideoPlayer, { connectionId: 'a', objectKey: 'sample.mp4', name: 'sample.mp4', onClose }));
      const dialog = screen.getByRole('dialog', { name: 'Play sample.mp4' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enter fullscreen' }));
      await waitFor(() => expect(request).toHaveBeenCalledOnce());
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: dialog });
      fireEvent(document, new Event('fullscreenchange'));
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(exit).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: originalRequest });
      Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: originalExit });
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    }
  });

  it('opens a player on double click and closes its private video session', async () => {
    const movie: Entry = { key: 'sample.MP4', name: 'sample.MP4', kind: 'file', size: 10, modified: null };
    const bridge = api([{ ...connection('a'), permissions: { download: true, upload: false, delete: false } }], [{ connectionId: 'a', prefix: '', entries: [movie], updatedAt: '2026-11-01T00:00:00Z' }]);
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.doubleClick(within(table).getByText('sample.MP4'));
    const player = await screen.findByRole('dialog', { name: 'Play sample.MP4' });
    await waitFor(() => expect(bridge.openVideo).toHaveBeenCalledWith('a', 'sample.MP4'));
    expect(player.querySelector('video')?.getAttribute('src')).toContain('127.0.0.1');
    fireEvent.click(within(player).getByRole('button', { name: 'Close video' }));
    await waitFor(() => expect(bridge.closeVideo).toHaveBeenCalledWith('video-1'));
  });
});

describe('connection URI scheme', () => {
  it('copies object and folder URIs using the selected connection scheme', async () => {
    const client = { ...connection('a'), uriScheme: 'obs' };
    const bridge = api([client], [{ connectionId: 'a', prefix: '', entries: [file(5)], updatedAt: '2026-11-01T00:00:00Z' }]);
    render(createElement(App));
    fireEvent.click(await screen.findByRole('row', { name: /report.txt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle item information' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy OBS URI' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenCalledWith('obs://bucket/report.txt'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy folder OBS URI' }));
    await waitFor(() => expect(bridge.copyText).toHaveBeenLastCalledWith('obs://bucket/'));
  });
});

describe('folder row statistics', () => {
  it('calculates recursively on demand, displays size/count/time, and retains results during a list refresh', async () => {
    const folder: Entry = { key: 'directory/', name: 'directory', kind: 'folder', size: null, modified: null };
    const stats = { fileCount: 3, totalSize: 4096, updatedAt: '2026-10-29T10:00:00Z', durationMs: 1250 };
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [folder], updatedAt: stats.updatedAt }]);
    const pending = deferred<typeof stats>(); bridge.stats.mockReturnValue(pending.promise);
    bridge.list.mockResolvedValue({ entries: [folder] });
    render(createElement(App));
    const button = await screen.findByRole('button', { name: 'Refresh statistics for directory' });
    expect(bridge.stats).not.toHaveBeenCalled();
    button.focus(); fireEvent.keyDown(button, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search file name' }));
    fireEvent.click(button);
    expect(bridge.stats).toHaveBeenCalledWith('a', 'directory/');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(bridge.list).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(stats); await pending.promise; });
    const row = screen.getByRole('row', { name: /directory/ });
    expect(within(row).getByText('4 KB')).toBeTruthy();
    expect(within(row).getByText('3')).toBeTruthy();
    expect(within(row).getByText(formatDate(stats.updatedAt, true))).toBeTruthy();
    expect(within(row).getByText(/1.3 s/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    await waitFor(() => expect(screen.getByRole('row', { name: /directory/ }).textContent).toContain('4 KB'));
  });
  it('keeps previous totals and timestamp when a row scan fails', async () => {
    const stats = { fileCount: 2, totalSize: 2048, updatedAt: '2026-10-29T10:00:00Z', durationMs: 500 };
    const folder: Entry = { key: 'directory/', name: 'directory', kind: 'folder', size: null, modified: null, stats };
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [folder], updatedAt: stats.updatedAt }]);
    bridge.stats.mockRejectedValue(new Error('Offline'));
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh statistics for directory' }));
    await screen.findByText('Stats failed');
    expect(screen.getByRole('row', { name: /directory/ }).textContent).toContain('2 KB');
    expect(screen.getByRole('row', { name: /directory/ }).textContent).toContain(formatDate(stats.updatedAt, true));
  });
  it.each(['save', 'remove'] as const)('ignores a pending row scan after connection %s', async mutation => {
    const folder: Entry = { key: 'directory/', name: 'directory', kind: 'folder', size: null, modified: null };
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [folder], updatedAt: '2026-10-29T10:00:00Z' }]);
    const pending = deferred<{ fileCount: number; totalSize: number; updatedAt: string; durationMs: number }>();
    bridge.stats.mockReturnValue(pending.promise);
    bridge.list.mockResolvedValue({ entries: [folder] });
    bridge.saveConnection.mockResolvedValue(connection('a'));
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    let scan!: Promise<unknown>;
    act(() => { scan = result.current.scanStats('a', folder.key); });
    await act(async () => { if (mutation === 'save') await result.current.save(connection('a')); else await result.current.remove('a'); });
    await act(async () => { pending.resolve({ fileCount: 3, totalSize: 4096, updatedAt: '2026-10-29T11:00:00Z', durationMs: 1 }); await scan; });
    expect(result.current.statistics).toEqual({});
    expect(result.current.nodes[nodeKey('a', '')]?.entries[0].stats).toBeUndefined();
  });
});

describe('cached startup', () => {
  it('uses each connection’s session page size for every folder and resets it on remount', async () => {
    const bridge = api([{ ...connection('a'), defaultPageSize: 500 }, { ...connection('b'), defaultPageSize: 100 }]);
    const first = renderHook(useBrowser);
    await waitFor(() => expect(first.result.current.initializing).toBe(false));
    await act(async () => { await first.result.current.load('a', ''); });
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 500, null, 0);
    await act(async () => { await first.result.current.setPageSize('a', '', 250); });
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 250, null, 0);
    act(() => first.result.current.navigate({ connectionId: 'a', prefix: 'nested/' }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith('a', 'nested/', 250, null, 0));
    act(() => first.result.current.navigate({ connectionId: 'b', prefix: '' }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith('b', '', 100, null, 0));
    first.unmount();
    const reopened = renderHook(useBrowser);
    await waitFor(() => expect(reopened.result.current.initializing).toBe(false));
    await act(async () => { await reopened.result.current.load('a', ''); });
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 500, null, 0);
  });
  it('fetches only the selected S3 page, keeps visited folders in the tree and resets when page size changes', async () => {
    const later: Entry = { key: 'later/', name: 'later', kind: 'folder', size: null, modified: null };
    const resized: Entry = { key: 'new.txt', name: 'new.txt', kind: 'file', size: 2, modified: null };
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(1)], nextToken: 'opaque-page-two', updatedAt: '2026-10-30T01:00:00Z' }]);
    bridge.list.mockResolvedValueOnce({ entries: [later], nextToken: null }).mockResolvedValueOnce({ entries: [file(1)], nextToken: 'opaque-page-two' }).mockResolvedValueOnce({ entries: [resized], nextToken: null });
    render(createElement(App));
    const table = await screen.findByRole('table', { name: 'Folder contents' });
    expect(bridge.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(table).getByText('later')).toBeTruthy());
    expect(within(table).queryByText('report.txt')).toBeNull();
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 1000, 'opaque-page-two', 1);
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'later' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(within(table).getByText('report.txt')).toBeTruthy());
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 1000, null, 0);
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: 'later' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: '250' } });
    await waitFor(() => expect(within(table).getByText('new.txt')).toBeTruthy());
    expect(bridge.list).toHaveBeenLastCalledWith('a', '', 250, null, 0);
    expect(screen.getByText('Page 1')).toBeTruthy();
  });
  it('keeps connection, cached files, expansion and history when removal is cancelled', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(123)], updatedAt: '2026-10-30T01:00:00Z' }]);
    bridge.removeConnection.mockResolvedValue(false);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    const before = result.current;
    await act(async () => { expect(await result.current.remove('a')).toBe(false); });
    expect(result.current.connections).toBe(before.connections);
    expect(result.current.nodes).toBe(before.nodes);
    expect(result.current.expanded).toBe(before.expanded);
    expect(result.current.history).toBe(before.history);
    expect(bridge.list).not.toHaveBeenCalled();
  });
  it('restores a saved listing without making a list request', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(123)], updatedAt: '2026-10-29T01:00:00Z' }]);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    expect(result.current.location).toEqual({ connectionId: 'a', prefix: '' });
    expect(result.current.nodes[nodeKey('a', '')]).toMatchObject({ entries: [file(123)], loaded: true, loading: false, cached: true });
    expect(bridge.list).not.toHaveBeenCalled();
  });
  it('makes no startup request when no listing has been cached and waits for List folder', async () => {
    const bridge = api([connection('a')]);
    bridge.list.mockResolvedValue({ entries: [file(10)] });
    render(createElement(App));
    await screen.findByRole('heading', { name: 'Folder not loaded' });
    expect(bridge.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'List folder' }));
    await screen.findByText('report.txt', { exact: true });
    expect(bridge.list).toHaveBeenCalledTimes(1);
  });
  it('uses cached results until explicit refresh and keeps them visible if the refresh fails', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(123)], updatedAt: '2026-10-29T01:00:00Z' }]);
    bridge.list.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ entries: [file(456)] });
    render(createElement(App));
    await screen.findByRole('row', { name: /report.txt/ });
    expect(bridge.list).not.toHaveBeenCalled();
    expect(screen.getByText('· Cached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    await screen.findByText(/Refresh failed.*Offline/);
    expect(screen.getByRole('row', { name: /report.txt/ }).textContent).toContain('123 B');
    fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }));
    await waitFor(() => expect(screen.getByRole('row', { name: /report.txt/ }).textContent).toContain('456 B'));
    expect(screen.queryByText('· Cached')).toBeNull();
  });
});

describe('loading a connection for editing', () => {
  it('loads the configured AK and null region before opening the edit pane', async () => {
    const bridge = api([{ ...connection('a'), region: null, defaultPageSize: 500, hasCredentials: true }]);
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage A' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit connection' }));
    await screen.findByRole('dialog');
    expect(bridge.connectionDetails).toHaveBeenCalledWith('a');
    expect((screen.getByLabelText('Access key (AK)') as HTMLInputElement).value).toBe('CONFIGURED_AK');
    expect((screen.getByLabelText('Secret key (SK)') as HTMLInputElement).value).toBe('CONFIGURED_SK');
    expect((screen.getByLabelText('Secret key (SK)') as HTMLInputElement).type).toBe('password');
    expect((screen.getByLabelText(/Region/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/Default page size/) as HTMLSelectElement).value).toBe('500');
  });
  it('saves the configured default page size from the edit pane', async () => {
    const client = { ...connection('a'), defaultPageSize: 250, hasCredentials: true };
    const bridge = api([client]);
    bridge.saveConnection.mockResolvedValue({ ...client, defaultPageSize: 500 });
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage A' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit connection' }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/Default page size/), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(bridge.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ defaultPageSize: 500 })));
  });
});

describe('connection page size while searching', () => {
  it('shares the session size with search and reloads the folder at that size when search clears', async () => {
    const folder: Entry = { key: 'nested/', name: 'nested', kind: 'folder', size: null, modified: null };
    const bridge = api([{ ...connection('a'), defaultPageSize: 500 }], [{ connectionId: 'a', prefix: '', entries: [folder], pageSize: 500, updatedAt: '2026-10-30T01:00:00Z' }]);
    bridge.list.mockImplementation(async (_id, prefix) => ({ entries: prefix ? [] : [folder] }));
    bridge.search.mockResolvedValue({ entries: [file(1)], nextToken: 'next' });
    render(createElement(App));
    await screen.findByRole('table', { name: 'Folder contents' });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'prefix' } });
    fireEvent.change(screen.getByLabelText('Search file name'), { target: { value: 'report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(bridge.search).toHaveBeenLastCalledWith('a', '', 'folder', 'prefix', 'report', 500, null));
    fireEvent.change(screen.getByLabelText('Page size'), { target: { value: '250' } });
    await waitFor(() => expect(bridge.search).toHaveBeenLastCalledWith('a', '', 'folder', 'prefix', 'report', 250, null));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith('a', '', 250, null, 0));
    fireEvent.doubleClick(await within(screen.getByRole('table', { name: 'Folder contents' })).findByText('nested', { exact: true }));
    await waitFor(() => expect(bridge.list).toHaveBeenLastCalledWith('a', 'nested/', 250, null, 0));
  });
});

describe('browser asynchronous state', () => {
  it('adds and opens a copied connection while retaining the original and its navigation history', async () => {
    const source = connection('a', 'root/');
    const copied = { ...source, id: 'copied', name: 'A (copy)' };
    const bridge = api([source]);
    bridge.copyConnection.mockResolvedValue(copied);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    await act(async () => { await result.current.copy(source.id); });
    expect(bridge.copyConnection).toHaveBeenCalledWith(source.id);
    expect(result.current.connections).toEqual([source, copied]);
    expect(result.current.location).toEqual({ connectionId: copied.id, prefix: copied.prefix });
    expect(bridge.list).toHaveBeenCalledWith(copied.id, copied.prefix, 1000, null, 0);
    act(() => result.current.back());
    expect(result.current.location).toEqual({ connectionId: source.id, prefix: source.prefix });
  });
  it('copies through the connection menu and displays the new root', async () => {
    const bridge = api([connection('a')]);
    bridge.copyConnection.mockResolvedValue({ ...connection('copied'), name: 'A (copy)' });
    render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage A' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy connection' }));
    expect(await screen.findByRole('button', { name: 'Manage A (copy)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage A' })).toBeTruthy();
    expect(bridge.copyConnection).toHaveBeenCalledWith('a');
    expect(bridge.connectionDetails).not.toHaveBeenCalled();
  });
  it('branches from the current folder when copying after navigating back', async () => {
    const source = connection('a', 'root/');
    const bridge = api([source]);
    bridge.copyConnection.mockResolvedValue({ ...source, id: 'copied', name: 'A (copy)' });
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    act(() => result.current.navigate({ connectionId: source.id, prefix: 'root/deep/' }));
    act(() => result.current.back());
    await act(async () => { await result.current.copy(source.id); });
    act(() => result.current.back());
    expect(result.current.location).toEqual({ connectionId: source.id, prefix: 'root/' });
    expect(result.current.history.entries.some(item => item.prefix === 'root/deep/')).toBe(false);
  });
  it('removes both roots and their history when removal responses overlap', async () => {
    const bridge = api([connection('a'), connection('b')]);
    const a = deferred<boolean>();
    const b = deferred<boolean>();
    bridge.removeConnection.mockImplementation(id => id === 'a' ? a.promise : b.promise);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    act(() => result.current.navigate({ connectionId: 'b', prefix: '' }));
    let removeA!: Promise<boolean>;
    let removeB!: Promise<boolean>;
    act(() => { removeA = result.current.remove('a'); removeB = result.current.remove('b'); });

    await act(async () => { a.resolve(true); await removeA; });
    expect(result.current.connections.map(item => item.id)).toEqual(['b']);
    await act(async () => { b.resolve(true); await removeB; });

    expect(result.current.connections).toEqual([]);
    expect(result.current.history).toEqual({ entries: [], index: -1 });
    expect(result.current.location).toBeUndefined();
    act(() => result.current.back());
    expect(result.current.location).toBeUndefined();
  });

  it('keeps a connection saved during removal and uses it as the navigation fallback', async () => {
    const bridge = api([connection('a')]);
    const removal = deferred<boolean>();
    bridge.removeConnection.mockReturnValue(removal.promise);
    bridge.saveConnection.mockResolvedValue(connection('b', 'saved/'));
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.remove('a'); });
    await act(async () => { await result.current.save(connection('b', 'saved/')); });
    act(() => result.current.navigate({ connectionId: 'a', prefix: '' }));
    await act(async () => { removal.resolve(true); await pending; });

    expect(result.current.connections.map(item => item.id)).toEqual(['b']);
    expect(result.current.location).toEqual({ connectionId: 'b', prefix: 'saved/' });
    expect(result.current.history.entries.every(item => item.connectionId === 'b')).toBe(true);
  });

  it('ignores a stale listing that resolves after a newer refresh', async () => {
    const bridge = api([connection('a')]);
    const old = deferred<Listing>();
    const fresh = deferred<Listing>();
    bridge.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    act(() => { void result.current.load("a", ""); });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.load('a', '', true); });
    await act(async () => { fresh.resolve({ entries: [file(2048)] }); await refresh; });
    await act(async () => { old.resolve({ entries: [file(1)] }); await old.promise; });

    expect(result.current.nodes[nodeKey('a', '')].entries).toEqual([file(2048)]);
    expect(result.current.nodes[nodeKey('a', '')].loading).toBe(false);
  });

  it('ignores pending listings after editing the connection', async () => {
    const bridge = api([connection('a')]);
    const old = deferred<Listing>();
    bridge.list.mockReturnValueOnce(old.promise).mockResolvedValue({ entries: [file(2048)] });
    bridge.saveConnection.mockResolvedValue(connection('a', 'new/'));
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    act(() => { void result.current.load("a", ""); });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.save(connection('a', 'new/')); });
    await act(async () => { old.resolve({ entries: [file(1)] }); await old.promise; });

    expect(result.current.nodes[nodeKey('a', '')]).toBeUndefined();
    expect(result.current.nodes[nodeKey('a', 'new/')].entries).toEqual([file(2048)]);
    expect(result.current.location).toEqual({ connectionId: 'a', prefix: 'new/' });
  });

  it('ignores pending listings after removing the connection', async () => {
    const bridge = api([connection('a')]);
    const old = deferred<Listing>();
    bridge.list.mockReturnValue(old.promise);
    const { result } = renderHook(useBrowser);
    await waitFor(() => expect(result.current.initializing).toBe(false));
    act(() => { void result.current.load("a", ""); });
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.remove('a'); });
    await act(async () => { old.resolve({ entries: [file(1)] }); await old.promise; });

    expect(result.current.nodes).toEqual({});
    expect(result.current.connections).toEqual([]);
    expect(result.current.location).toBeUndefined();
  });
});

describe('selected object metadata', () => {
  it('shows fresh metadata in the inspector and status when the selected key is refreshed', async () => {
    const bridge = api([connection('a')]);
    const fresh = deferred<Listing>();
    const updated = file(4096, '2026-10-29T08:00:00Z', 'GLACIER');
    bridge.list.mockResolvedValueOnce({ entries: [file(1)] }).mockReturnValueOnce(fresh.promise);
    const { container } = render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'List folder' }));
    fireEvent.click(await screen.findByRole('row', { name: /report.txt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle item information' }));
    expect(container.querySelector('.status-bar')?.textContent).toContain('1 selected, 1 B');
    expect(within(screen.getByRole('complementary', { name: 'Item information' })).getByText('STANDARD')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    await act(async () => { fresh.resolve({ entries: [updated] }); await fresh.promise; });

    const inspector = within(screen.getByRole('complementary', { name: 'Item information' }));
    expect(inspector.getByText('Text document · 4 KB')).toBeTruthy();
    expect(inspector.getByText('GLACIER')).toBeTruthy();
    expect(inspector.getByText(formatDate(updated.modified, true))).toBeTruthy();
    expect(container.querySelector('.status-bar')?.textContent).toContain('1 selected, 4 KB');
    expect(screen.getByRole('row', { name: /report.txt/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('clears selection when a refresh removes the key', async () => {
    const bridge = api([connection('a')]);
    bridge.list.mockResolvedValueOnce({ entries: [file(1)] }).mockResolvedValueOnce({ entries: [] });
    const { container } = render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'List folder' }));
    fireEvent.click(await screen.findByRole('row', { name: /report.txt/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle item information' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh folder' }));
    await screen.findByText('This folder is empty');

    expect(await screen.findByText('Select an item to see its details.')).toBeTruthy();
    expect(container.querySelector('.status-bar')?.textContent).not.toContain('selected');
  });

  it('does not restore a filtered-out selection when the filter is cleared', async () => {
    const bridge = api([connection('a')]);
    bridge.list.mockResolvedValue({ entries: [file(1)] });
    const { container } = render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'List folder' }));
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'page' } });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'contains' } });
    fireEvent.click(await screen.findByRole('row', { name: /report.txt/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'missing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(screen.getByRole('row', { name: /report.txt/ }).getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('.status-bar')?.textContent).not.toContain('selected');
  });

  it('clears selection and search when navigating to another connection with the same object key', async () => {
    const bridge = api([connection('a'), connection('b')]);
    bridge.list.mockResolvedValue({ entries: [file(1)] });
    const { container } = render(createElement(App));
    fireEvent.click(await screen.findByRole('button', { name: 'List folder' }));
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'page' } });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'contains' } });
    fireEvent.click(await screen.findByRole('row', { name: /report.txt/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Storage connections' })).getByRole('button', { name: 'B' }));
    await screen.findByRole('row', { name: /report.txt/ });

    expect((screen.getByRole('textbox', { name: 'Search file name' }) as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('row', { name: /report.txt/ }).getAttribute('aria-selected')).toBe('false');
    expect(container.querySelector('.status-bar')?.textContent).not.toContain('selected');
  });

  it('defaults to exact folder search and submits only when requested', async () => {
    const bridge = api([connection('a')]);
    bridge.search.mockResolvedValue({ entries: [file(5)], nextToken: null });
    render(createElement(App));
    await screen.findByRole('button', { name: 'List folder' });
    expect((screen.getByLabelText('Search range') as HTMLSelectElement).value).toBe('folder');
    expect((screen.getByLabelText('Name match') as HTMLSelectElement).value).toBe('exact');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    expect(bridge.search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /report.txt/ });
    expect(bridge.search).toHaveBeenCalledWith('a', '', 'folder', 'exact', 'report.txt', 1000, null);
    expect(bridge.list).not.toHaveBeenCalled();
  });

  it('submits a full S3 key from the current connection without a folder scan', async () => {
    const bridge = api([connection('a', 'root/')]);
    const key = 'root/elsewhere/a (6)+.db';
    bridge.search.mockResolvedValue({ entries: [{ key, name: key, kind: 'file', size: 23, modified: null }], nextToken: null });
    render(createElement(App));
    await screen.findByRole('button', { name: 'List folder' });
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'key' } });
    expect((screen.getByLabelText('Name match') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Full S3 key' }), { target: { value: key } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /root\/elsewhere\/a \(6\)\+\.db/ });
    expect(bridge.search).toHaveBeenCalledWith('a', 'root/', 'key', 'exact', key, 1000, null);
    expect(bridge.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('uses the current page locally and searches recursively by exact name', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(5)], updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    await screen.findByRole('row', { name: /report.txt/ });
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'page' } });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'contains' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'missing' } });
    expect(screen.getByRole('heading', { name: 'No matching items' })).toBeTruthy();
    expect(bridge.search).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'recursive' } });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'exact' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    bridge.search.mockResolvedValue({ entries: [{ ...file(5), key: 'sub/report.txt', name: 'sub/report.txt' }], nextToken: null });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /sub\/report.txt/ });
    expect(bridge.search).toHaveBeenCalledWith('a', '', 'recursive', 'exact', 'report.txt', 1000, null);
  });

  it('supports exact, prefix, and contains matching on the loaded page without S3 calls', async () => {
    const rows: Entry[] = [file(1), { ...file(2), key: 'report-old.txt', name: 'report-old.txt' }, { ...file(3), key: 'archive-report.txt', name: 'archive-report.txt' }];
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: rows, updatedAt: '2026-01-01T00:00:00Z' }]);
    render(createElement(App));
    await screen.findByText('report.txt', { exact: true });
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'page' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'prefix' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report' } });
    expect(screen.getAllByRole('row')).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'contains' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'REPORT' } });
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(bridge.search).not.toHaveBeenCalled();
  });

  it('submits folder contains and recursive prefix with independent selectors', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [], updatedAt: '2026-01-01T00:00:00Z' }]);
    bridge.search.mockResolvedValueOnce({ entries: [file(1)] }).mockResolvedValueOnce({ entries: [{ ...file(2), key: 'sub/report.txt', name: 'sub/report.txt' }] });
    render(createElement(App));
    await screen.findByRole('heading', { name: 'This folder is empty' });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'contains' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'port' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /report.txt/ });
    expect(bridge.search).toHaveBeenCalledWith('a', '', 'folder', 'contains', 'port', 1000, null);
    fireEvent.change(screen.getByLabelText('Search range'), { target: { value: 'recursive' } });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'prefix' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /sub\/report.txt/ });
    expect(bridge.search).toHaveBeenLastCalledWith('a', '', 'recursive', 'prefix', 'report', 1000, null);
  });

  it('pages prefix search with S3 continuation tokens and discards stale results', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [file(5)], updatedAt: '2026-01-01T00:00:00Z' }]);
    const pending = deferred<Listing>();
    bridge.search.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ entries: [{ ...file(2), key: 'report-2.txt', name: 'report-2.txt' }], nextToken: 'next' }).mockResolvedValueOnce({ entries: [{ ...file(3), key: 'report-3.txt', name: 'report-3.txt' }], nextToken: null });
    render(createElement(App));
    await screen.findByRole('row', { name: /report.txt/ });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'old.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'prefix' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('row', { name: /report-2.txt/ });
    await act(async () => { pending.resolve({ entries: [{ ...file(1), key: 'old.txt', name: 'old.txt' }] }); await pending.promise; });
    expect(screen.queryByText('old.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('row', { name: /report-3.txt/ });
    expect(bridge.search).toHaveBeenLastCalledWith('a', '', 'folder', 'prefix', 'report', 1000, 'next');
  });

  it('updates a searched folder row after its statistics scan', async () => {
    const bridge = api([connection('a')], [{ connectionId: 'a', prefix: '', entries: [], updatedAt: '2026-01-01T00:00:00Z' }]);
    bridge.search.mockResolvedValue({ entries: [{ key: 'reports/', name: 'reports', kind: 'folder', size: null, modified: null }], nextToken: null });
    bridge.stats.mockResolvedValue({ fileCount: 3, totalSize: 42, updatedAt: '2026-01-01T00:00:00Z', durationMs: 100 });
    render(createElement(App));
    await screen.findByRole('heading', { name: 'This folder is empty' });
    fireEvent.change(screen.getByLabelText('Name match'), { target: { value: 'prefix' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const row = await screen.findByRole('row', { name: /reports/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh statistics for reports' }));
    await waitFor(() => expect(within(row).getByText('3')).toBeTruthy());
    expect(within(row).getByTitle('42 bytes')).toBeTruthy();
  });

  it('clears a successful deleted file from exact search results', async () => {
    const client = { ...connection('a'), permissions: { download: true, upload: false, delete: true } };
    const bridge = api([client], [{ connectionId: 'a', prefix: '', entries: [], updatedAt: '2026-01-01T00:00:00Z' }]);
    bridge.search.mockResolvedValue({ entries: [file(5)], nextToken: null });
    bridge.deleteEntry.mockResolvedValue(true);
    render(createElement(App));
    await screen.findByRole('heading', { name: 'This folder is empty' });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search file name' }), { target: { value: 'report.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete report.txt' }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Search file name' }) as HTMLInputElement).value).toBe(''));
    expect(screen.queryByRole('row', { name: /report.txt/ })).toBeNull();
  });
});
