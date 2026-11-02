import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConnectionStore, type SecretStorage } from './connections';
import { S3Worker } from './s3-worker';
import { ListingCache } from './listing-cache';
import { ListingService } from './listings';
import { OperationRunner } from './operation-runner';
import { TransferService } from './transfer-service';
import { Confirmations } from './confirmations';
import { listUploadSources } from './upload-sources';
import { validateEntryTargets } from './batch-entries';
import { defaultWindowSize, WindowSizeStore } from './window-size-store';
import { VideoService } from './video-service';
import { storageUri } from '../shared/storage-uri';

if (process.env.S3_CLIENT_DATA_DIR) app.setPath('userData', process.env.S3_CLIENT_DATA_DIR);

let window: BrowserWindow | undefined;
let worker: S3Worker | undefined;
let operations: OperationRunner | undefined;
let transfers: TransferService | undefined;
let videos: VideoService | undefined;
let windowSizes: WindowSizeStore;
let quitting = false;
const rendererFile = join(__dirname, '../renderer/index.html');
const rendererURL = process.env.ELECTRON_RENDERER_URL;
const expectedURL = rendererURL ?? pathToFileURL(rendererFile).href;
const confirmations = new Confirmations(request => {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('Window closed.');
  window.webContents.send('s3:confirmation', request);
});

function trustedURL(value: string): boolean {
  try {
    const url = new URL(value);
    const expected = new URL(expectedURL);
    url.hash = ''; expected.hash = '';
    return url.href === expected.href;
  } catch { return false; }
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame || !trustedURL(event.senderFrame.url)) {
    throw new Error('Untrusted IPC sender.');
  }
}

function registerIPC(store: ConnectionStore, worker: S3Worker, operations: OperationRunner, video: VideoService): void {
  const cache = new ListingCache(app.getPath('userData'));
  const listings = new ListingService(store, cache, worker);
  const service = new TransferService(store, operations, app.getPath('userData'), {
    changed: snapshot => { if (window && !window.isDestroyed()) window.webContents.send('s3:transfers-changed', snapshot); },
    storageChanged: async id => {
      await cache.invalidate(id).catch(() => undefined);
      if (window && !window.isDestroyed()) window.webContents.send('s3:storage-changed', id);
    },
  });
  transfers = service;
  const handle = (channel: string, action: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => { validateSender(event); return action(...args); });
  };
  handle('s3:connections', () => listings.connections());
  handle('s3:connection-details', id => store.connectionDetails(id));
  handle('s3:save-connection', async input => {
    const id = input && typeof input === 'object' && 'id' in input ? input.id : undefined;
    const saved = typeof id === 'string' ? await service.withConnectionMutation(id, () => listings.save(input)) : await listings.save(input);
    if (typeof id === 'string') video.closeConnection(id);
    return saved;
  });
  handle('s3:copy-connection', id => store.copy(id));
  handle('s3:reorder-connections', ids => store.reorder(ids));
  handle('s3:answer-confirmation', (id, confirmed) => confirmations.respond(id, confirmed));
  handle('s3:remove-connection', async id => {
    if (typeof id !== 'string') throw new Error('Invalid connection.');
    const { connections } = await store.connections();
    const connection = connections.find(connection => connection.id === id);
    if (!connection) throw new Error('This connection no longer exists.');
    if (!await confirmations.ask({ kind: 'connection', name: connection.name, path: storageUri(connection, connection.prefix) })) return false;
    await service.withConnectionMutation(id, () => listings.remove(id));
    video.closeConnection(id);
    return true;
  });
  handle('s3:list', (id, prefix, pageSize, continuationToken, pageIndex) => listings.list(id, prefix, pageSize, continuationToken, pageIndex));
  handle('s3:search', (id, prefix, range, match, name, pageSize, continuationToken) => listings.search(id, prefix, range, match, name, pageSize, continuationToken));
  handle('s3:search-uri', (id, key) => listings.searchUri(id, key));
  handle('s3:stats', (id, prefix) => listings.stats(id, prefix));
  const entryKind = (kind: unknown): 'file' | 'folder' => { if (kind !== 'file' && kind !== 'folder') throw new Error('Invalid entry type.'); return kind; };
  handle('s3:download', async (id, key, value) => {
    const kind = entryKind(value);
    const admission = service.captureAdmission(id, 'download');
    await store.forOperation(id, key, 'download', kind);
    const result = await dialog.showOpenDialog(window!, { title: 'Choose download destination', buttonLabel: 'Save here', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    return service.startDownload(id, key, kind, result.filePaths[0], admission);
  });
  handle('s3:download-entries', async (id, value) => {
    const entries = validateEntryTargets(value);
    const admission = service.captureAdmission(id, 'download');
    for (const entry of entries) await store.forOperation(id, entry.key, 'download', entry.kind);
    const result = await dialog.showOpenDialog(window!, { title: `Choose destination for ${entries.length} items`, buttonLabel: 'Save here', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths.length) return null;
    const summary = { succeeded: 0, failed: [] as { key: string; message: string }[] };
    for (const entry of entries) {
      try { await service.startDownload(id, entry.key, entry.kind, result.filePaths[0], admission); summary.succeeded++; }
      catch (error) { summary.failed.push({ key: entry.key, message: error instanceof Error ? error.message : 'Could not queue this download.' }); }
    }
    return summary;
  });
  let lastUploadDirectory: string | undefined;
  handle('s3:upload-sources', async (id, prefix, directory) => {
    const admission = service.captureAdmission(id, 'upload');
    await store.forOperation(id, prefix, 'upload', 'folder');
    const listing = await listUploadSources(directory === undefined ? lastUploadDirectory ?? app.getPath('home') : directory);
    if (service.captureAdmission(id, 'upload').epoch !== admission.epoch) throw new Error('The connection changed. Open Upload again.');
    lastUploadDirectory = listing.directory;
    return listing;
  });
  handle('s3:upload', async (id, prefix, paths) => {
    const admission = service.captureAdmission(id, 'upload');
    return service.startUpload(id, prefix, paths as string[], admission);
  });
  handle('s3:open-video', (id, key) => video.open(id, key));
  handle('s3:start-video', id => video.start(id));
  handle('s3:close-video', id => video.close(id));
  handle('s3:delete-entry', async (id, key, value) => {
    const kind = entryKind(value);
    const admission = service.captureAdmission(id);
    const request = await store.forOperation(id, key, 'delete', kind);
    if (!await confirmations.ask({ kind, name: request.key.replace(/\/$/, '').split('/').at(-1) || request.connection.bucket, path: storageUri(request.connection, request.key) })) return false;
    await service.deleteEntry(id, key, kind, admission); return true;
  });
  handle('s3:copy-entry', (id, key, value, destinationFolder, name) => service.copyEntry(id, key, entryKind(value), destinationFolder, name));
  handle('s3:rename-entry', (id, key, value, name) => service.renameEntry(id, key, entryKind(value), name));
  handle('s3:delete-entries', async (id, value) => {
    const entries = validateEntryTargets(value);
    const admission = service.captureAdmission(id);
    let address = { bucket: '', uriScheme: 's3' };
    for (const entry of entries) {
      const { connection } = await store.forOperation(id, entry.key, 'delete', entry.kind);
      address = { bucket: connection.bucket, uriScheme: connection.uriScheme || 's3' };
    }
    const shown = entries.slice(0, 3).map(entry => storageUri(address, entry.key)).join('\n');
    const path = entries.length > 3 ? `${shown}\n…and ${entries.length - 3} more` : shown;
    if (!await confirmations.ask({ kind: 'entry-batch', name: `${entries.length} selected item${entries.length === 1 ? '' : 's'}`, path })) return null;
    return service.deleteEntries(id, entries, admission);
  });
  handle('s3:transfers', () => service.snapshot());
  handle('s3:control-transfer', (id, action) => service.control(id, action));
  handle('s3:control-transfers', (direction, action) => service.controlAll(direction, action));
  handle('s3:remove-transfer', async id => {
    if (typeof id !== 'string') throw new Error('Invalid transfer.');
    const snapshot = await service.snapshot();
    const item = snapshot.tasks.find(task => task.id === id) ?? snapshot.preparations.find(job => job.id === id);
    if (!item) return;
    const task = 'relativePath' in item;
    const uriScheme = task ? (await store.connections()).connections.find(connection => connection.id === item.connectionId)?.uriScheme : undefined;
    if (!await confirmations.ask({ kind: 'transfer', name: task ? item.relativePath : item.name, path: task ? storageUri({ bucket: item.bucket, uriScheme }, item.key) : '' })) return;
    await service.remove(id);
  });
  handle('s3:clear-transfers', async direction => {
    if (direction !== 'download' && direction !== 'upload') throw new Error('Invalid transfer direction.');
    const answer = await confirmations.ask({ kind: 'transfer-list', name: direction === 'download' ? 'Downloads' : 'Uploads', path: '' });
    if (answer === 'keep-active') await service.clearFinished(direction);
    else if (answer === true) await service.clear(direction);
  });
  handle('s3:transfer-concurrency', (direction, value) => service.setConcurrency(direction, value));
  handle('s3:copy-text', value => {
    if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error('Invalid clipboard text.');
    clipboard.writeText(value);
  });
}

function resetViewSizes(): void {
  const current = window;
  if (!current || current.isDestroyed()) return;
  if (current.isFullScreen()) current.setFullScreen(false);
  if (current.isMaximized()) current.unmaximize();
  current.setSize(defaultWindowSize.width, defaultWindowSize.height);
  current.center();
  try { windowSizes.reset(); } catch { /* The current window can still be reset. */ }
  if (!current.webContents.isDestroyed()) current.webContents.send('s3:reset-view-sizes');
}

function zoomWindow(): void {
  const current = window;
  if (!current || current.isDestroyed()) return;
  if (current.isMaximized()) current.unmaximize();
  else current.maximize();
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { label: 'View', submenu: [
      { id: 'reset-view-sizes', label: 'Reset Sizes to Default', click: resetViewSizes },
      { type: 'separator' },
      { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    process.platform === 'darwin' ? { role: 'windowMenu' } : { label: 'Window', submenu: [
      { role: 'minimize' },
      { id: 'window-zoom', label: 'Zoom', click: zoomWindow },
      { type: 'separator' },
      { role: 'close' },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  const savedSize = windowSizes.load();
  window = new BrowserWindow({
    title: 'S3 Client',
    width: savedSize.width,
    height: savedSize.height,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      ...(process.env.S3_CLIENT_E2E_HIDDEN === '1' ? { backgroundThrottling: false } : {}),
    },
  });
  const created = window;
  let htmlFullscreen = false;
  created.on('enter-html-full-screen', () => { htmlFullscreen = true; });
  created.on('leave-html-full-screen', () => { htmlFullscreen = false; });
  created.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || htmlFullscreen || created.isDestroyed() || !created.isFullScreen()) return;
    event.preventDefault();
    created.setFullScreen(false);
  });
  created.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) confirmations.cancel();
  });
  created.webContents.on('render-process-gone', () => confirmations.cancel());
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  created.webContents.on('will-navigate', (event, url) => { if (!trustedURL(url)) event.preventDefault(); });
  created.webContents.on('will-redirect', event => event.preventDefault());
  created.webContents.on('will-attach-webview', event => event.preventDefault());
  created.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === created.webContents && permission === 'fullscreen' && details.isMainFrame && trustedURL(details.requestingUrl));
  });
  created.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
    contents === created.webContents && permission === 'fullscreen' && details.isMainFrame &&
    trustedURL(details.requestingUrl || '') && trustedURL(contents.getURL()));
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  const saveSize = () => {
    if (created.isDestroyed()) return;
    const { width, height } = created.getNormalBounds();
    try { windowSizes.save({ width, height, maximized: created.isMaximized() }); }
    catch { /* Geometry is a preference; a write error must not close the app. */ }
  };
  const scheduleSize = () => {
    if (sizeTimer) clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => { sizeTimer = undefined; saveSize(); }, 300);
  };
  created.on('resize', scheduleSize);
  created.on('maximize', scheduleSize);
  created.on('unmaximize', scheduleSize);
  created.on('close', () => { if (sizeTimer) clearTimeout(sizeTimer); saveSize(); });
  // Playwright can drive the renderer while this window stays hidden, so desktop tests do not steal focus.
  if (process.env.S3_CLIENT_E2E_HIDDEN !== '1') created.once('ready-to-show', () => { if (savedSize.maximized) created.maximize(); created.show(); });
  created.on('closed', () => { if (window === created) { confirmations.cancel(); videos?.closeAll(); window = undefined; } });
  const loading = rendererURL ? created.loadURL(rendererURL) : created.loadFile(rendererFile);
  void loading.catch(() => {
    dialog.showErrorBox('S3 Client could not start', 'The application interface could not be loaded. Rebuild or reinstall S3 Client.');
    app.quit();
  });
}

void app.whenReady().then(() => {
  windowSizes = new WindowSizeStore(app.getPath('userData'));
  installMenu();
  const storage: SecretStorage = {
    isAvailable: async () => {
      const available = await safeStorage.isAsyncEncryptionAvailable();
      return available && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()));
    },
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: async value => (await safeStorage.decryptStringAsync(value)).result,
  };
  const store = new ConnectionStore(app.getPath('userData'), storage);
  worker = new S3Worker();
  operations = new OperationRunner();
  videos = new VideoService(store, {}, event => { if (window && !window.isDestroyed()) window.webContents.send('s3:video-event', event); });
  registerIPC(store, worker, operations, videos);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', event => {
  confirmations.cancel();
  videos?.dispose();
  worker?.dispose();
  if (!quitting && transfers) {
    event.preventDefault(); quitting = true;
    void transfers.dispose().finally(() => { operations?.dispose(); app.quit(); });
  } else operations?.dispose();
});
app.on('will-quit', () => { worker?.dispose(); operations?.dispose(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
