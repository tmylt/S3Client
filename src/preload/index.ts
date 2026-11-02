import { contextBridge, ipcRenderer } from 'electron';
import type { S3API } from '../shared/types';

// Every call has a fixed channel. Saved AK/SK are returned only for connection editing.
const api = Object.freeze<S3API>({
  connections: () => ipcRenderer.invoke('s3:connections'),
  connectionDetails: id => ipcRenderer.invoke('s3:connection-details', id),
  saveConnection: input => ipcRenderer.invoke('s3:save-connection', input),
  copyConnection: id => ipcRenderer.invoke('s3:copy-connection', id),
  reorderConnections: ids => ipcRenderer.invoke('s3:reorder-connections', ids),
  removeConnection: id => ipcRenderer.invoke('s3:remove-connection', id),
  list: (connectionId, prefix, pageSize, continuationToken, pageIndex) => ipcRenderer.invoke('s3:list', connectionId, prefix, pageSize, continuationToken, pageIndex),
  search: (connectionId, prefix, range, match, name, pageSize, continuationToken) => ipcRenderer.invoke('s3:search', connectionId, prefix, range, match, name, pageSize, continuationToken),
  searchUri: (connectionId, key) => ipcRenderer.invoke('s3:search-uri', connectionId, key),
  stats: (connectionId, prefix) => ipcRenderer.invoke('s3:stats', connectionId, prefix),
  copyText: text => ipcRenderer.invoke('s3:copy-text', text),
  download: (id, key, kind) => ipcRenderer.invoke('s3:download', id, key, kind),
  downloadEntries: (id, entries) => ipcRenderer.invoke('s3:download-entries', id, entries),
  uploadSources: (id, prefix, directory) => ipcRenderer.invoke('s3:upload-sources', id, prefix, directory),
  upload: (id, prefix, paths) => ipcRenderer.invoke('s3:upload', id, prefix, paths),
  openVideo: (id, key) => ipcRenderer.invoke('s3:open-video', id, key),
  startVideo: id => ipcRenderer.invoke('s3:start-video', id),
  closeVideo: id => ipcRenderer.invoke('s3:close-video', id),
  onVideoEvent: listener => {
    const handle = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value);
    ipcRenderer.on('s3:video-event', handle);
    return () => ipcRenderer.removeListener('s3:video-event', handle);
  },
  deleteEntry: (id, key, kind) => ipcRenderer.invoke('s3:delete-entry', id, key, kind),
  copyEntry: (id, key, kind, destinationFolder, name) => ipcRenderer.invoke('s3:copy-entry', id, key, kind, destinationFolder, name),
  renameEntry: (id, key, kind, name) => ipcRenderer.invoke('s3:rename-entry', id, key, kind, name),
  deleteEntries: (id, entries) => ipcRenderer.invoke('s3:delete-entries', id, entries),
  answerConfirmation: (id, confirmed) => ipcRenderer.invoke('s3:answer-confirmation', id, confirmed),
  onConfirmation: listener => {
    const handle = (_event: Electron.IpcRendererEvent, request: Parameters<typeof listener>[0]) => listener(request);
    ipcRenderer.on('s3:confirmation', handle);
    return () => { ipcRenderer.removeListener('s3:confirmation', handle); };
  },
  onResetViewSizes: listener => {
    ipcRenderer.on('s3:reset-view-sizes', listener);
    return () => ipcRenderer.removeListener('s3:reset-view-sizes', listener);
  },
  transfers: () => ipcRenderer.invoke('s3:transfers'),
  controlTransfer: (id, action) => ipcRenderer.invoke('s3:control-transfer', id, action),
  controlTransfers: (direction, action) => ipcRenderer.invoke('s3:control-transfers', direction, action),
  removeTransfer: id => ipcRenderer.invoke('s3:remove-transfer', id),
  clearTransfers: direction => ipcRenderer.invoke('s3:clear-transfers', direction),
  setTransferConcurrency: (direction, value) => ipcRenderer.invoke('s3:transfer-concurrency', direction, value),
  onTransfers: listener => {
    const handle = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof listener>[0]) => listener(snapshot);
    ipcRenderer.on('s3:transfers-changed', handle);
    return () => { ipcRenderer.removeListener('s3:transfers-changed', handle); };
  },
  onStorageChanged: listener => {
    const handle = (_event: Electron.IpcRendererEvent, id: string) => listener(id);
    ipcRenderer.on('s3:storage-changed', handle);
    return () => { ipcRenderer.removeListener('s3:storage-changed', handle); };
  },
});

contextBridge.exposeInMainWorld('s3', api);
