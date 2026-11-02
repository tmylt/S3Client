import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronLeft, ChevronRight, Cloud, Copy, Folder, Info, LoaderCircle, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react';
import type { ConfirmationAnswer, ConfirmationRequest, Connection, ConnectionDetails, ConnectionInput, Entry, SearchMatch, SearchRange } from '../../shared/types';
import { breadcrumbs, formatBytes, getVisibleEntries, nodeKey, parentPrefix, type SortColumn, type SortDirection } from './model';
import { useBrowser } from './useBrowser';
import { useFileSearch } from './useFileSearch';
import { useTransfers } from './useTransfers';
import { connectionPermissions } from '../../shared/permissions';
import type { TransferDirection } from '../../shared/transfers';
import { TransferPanel } from './components/TransferPanel';
import { Sidebar } from './components/Sidebar';
import { ConnectionDialog } from './components/ConnectionDialog';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { UploadDialog } from './components/UploadDialog';
import { CopyDialog } from './components/CopyDialog';
import { RenameDialog } from './components/RenameDialog';
import { FileList } from './components/FileList';
import { FilePagination } from './components/FilePagination';
import { Inspector } from './components/Inspector';
import { VideoPlayer } from './components/VideoPlayer';
import { resetFileColumnWidths } from './useColumnWidths';
import { defaultSidebarWidth, loadSidebarWidth, resetSidebarWidth, resetVideoPaneSize, saveSidebarWidth } from './view-sizes';
import { defaultPageSize } from '../../shared/page-size';
import { storageUri, uriLabel } from '../../shared/storage-uri';
import { matchConnectionUri, parseConnectionUri } from '../../shared/connection-uri-search';

export default function App() {
  const browser = useBrowser();
  const transfers = useTransfers();
  const [transferDirection, setTransferDirection] = useState<TransferDirection | null>(null);
  const [busyEntries, setBusyEntries] = useState<Set<string>>(new Set());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [copyTarget, setCopyTarget] = useState<{ connection: Connection; entry: Entry } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ connection: Connection; entry: Entry } | null>(null);
  const [video, setVideo] = useState<{ connectionId: string; key: string; name: string } | null>(null);
  const operations = useRef(new Set<string>());
  const { connection, location } = browser;
  const [dialog, setDialog] = useState<{ connection?: ConnectionDetails } | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const confirmationRef = useRef<ConfirmationRequest | null>(null);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<'download' | 'delete' | null>(null);
  const pageSize = location ? browser.sessionPageSizes[location.connectionId] ?? connection?.defaultPageSize ?? defaultPageSize : defaultPageSize;
  const search = useFileSearch(location?.connectionId, location?.prefix, pageSize, size => { if (location) browser.changePageSize(location.connectionId, size); });
  const [column, setColumn] = useState<SortColumn>('name');
  const [direction, setDirection] = useState<SortDirection>('asc');
  const [info, setInfo] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [toast, setToast] = useState('');
  const [uriQuery, setUriQuery] = useState('');
  const [uriError, setUriError] = useState('');
  const [uriSearching, setUriSearching] = useState(false);
  const [uriResult, setUriResult] = useState<{ uri: string; connectionId: string; prefix: string; entries: Entry[] } | null>(null);
  const uriRequest = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogOpen = dialog !== null || transferDirection !== null || confirmation !== null || uploadOpen || copyTarget !== null || renameTarget !== null || video !== null;
  const permissions = connectionPermissions(connection?.permissions);
  const closeTransfers = useCallback(() => setTransferDirection(null), []);
  const ongoingTransfers = (direction: TransferDirection) => transfers.snapshot.tasks.filter(item => item.direction === direction && ['queued', 'running', 'paused'].includes(item.status)).length + transfers.snapshot.preparations.filter(item => item.direction === direction && item.status === 'preparing').length;
  const appRef = useRef<HTMLDivElement>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeUpload = useCallback(() => setUploadOpen(false), []);
  const state = location ? browser.nodes[nodeKey(location.connectionId, location.prefix)] : undefined;
  const uriView = uriResult?.connectionId === location?.connectionId && uriResult?.prefix === location?.prefix ? uriResult : null;
  const uriOutsidePrefix = Boolean(uriView?.entries.some(entry => connection && !entry.key.startsWith(connection.prefix)));
  const resultPermissions = uriOutsidePrefix ? { download: false, upload: false, delete: false } : permissions;
  const visible = useMemo(() => uriView ? getVisibleEntries(uriView.entries, '', column, direction) : search.active && search.result ? search.displayEntries(column, direction) : getVisibleEntries(state?.entries || [], search.range === 'page' ? search.query : '', column, direction, search.match), [uriView, state?.entries, search.active, search.result, search.displayEntries, search.range, search.match, search.query, column, direction]);
  const selected = visible.find(entry => entry.key === selectedKey);
  const checkedEntries = visible.filter(entry => checkedKeys.has(entry.key));
  const selectionScope = JSON.stringify([location?.connectionId, location?.prefix, uriView?.uri, search.active, search.query, search.range, search.match, search.pageIndex, state?.pageIndex ?? 0, pageSize]);
  const selectionScopeRef = useRef(selectionScope);
  selectionScopeRef.current = selectionScope;
  const selectedStatus = checkedEntries.length ? `${checkedEntries.length.toLocaleString()} checked` : selected ? `1 selected${selected.kind === 'file' ? `, ${formatBytes(selected.size)}` : ''}` : '';
  const path = connection && location ? breadcrumbs(connection.prefix, location.prefix) : [];
  const currentName = path.length ? path[path.length - 1].name : connection?.name || 'S3 Client';
  const parent = connection && location ? parentPrefix(connection.prefix, location.prefix) : null;

  useEffect(() => { setSelectedKey(undefined); }, [location?.connectionId, location?.prefix]);
  useEffect(() => { setUriResult(current => current && (current.connectionId !== location?.connectionId || current.prefix !== location?.prefix) ? null : current); }, [location?.connectionId, location?.prefix]);
  useEffect(() => { if (selectedKey !== undefined && !selected) setSelectedKey(undefined); }, [selectedKey, selected]);
  useEffect(() => { setCheckedKeys(new Set()); }, [location?.connectionId, location?.prefix, uriView?.uri, search.active, search.query, search.range, search.match, search.pageIndex, state?.pageIndex ?? 0, pageSize]);
  useEffect(() => {
    if (location && !search.active && state?.loaded && !state.loading && state.pageSize !== pageSize) void browser.load(location.connectionId, location.prefix);
  }, [browser.load, location?.connectionId, location?.prefix, pageSize, search.active, state?.loaded, state?.loading, state?.pageSize]);
  useEffect(() => {
    if (!state?.loaded && !search.result) return;
    const keys = new Set(visible.map(entry => entry.key));
    setCheckedKeys(current => [...current].some(key => !keys.has(key)) ? new Set([...current].filter(key => keys.has(key))) : current);
  }, [visible, state?.loaded, search.result]);
  useEffect(() => { if (appRef.current) appRef.current.inert = dialogOpen; }, [dialogOpen]);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => { saveSidebarWidth(sidebarWidth); }, [sidebarWidth]);
  useEffect(() => window.s3.onResetViewSizes(() => {
    resetSidebarWidth();
    setSidebarWidth(defaultSidebarWidth);
    resetFileColumnWidths();
    resetVideoPaneSize();
  }), []);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3000);
  }, []);
  useEffect(() => {
    const unsubscribe = window.s3.onConfirmation(request => {
      confirmationRef.current = request;
      setConfirmation(request);
    });
    return () => {
      unsubscribe();
      const pending = confirmationRef.current;
      confirmationRef.current = null;
      if (pending) void window.s3.answerConfirmation(pending.id, false).catch(() => undefined);
    };
  }, []);
  const answerConfirmation = useCallback((answer: ConfirmationAnswer) => {
    const pending = confirmationRef.current;
    if (!pending) return;
    confirmationRef.current = null;
    setConfirmation(null);
    void window.s3.answerConfirmation(pending.id, answer).catch(() => notify('Unable to answer confirmation. Please try again.'));
  }, [notify]);
  const copy = useCallback(async (text: string, label = 'URI') => {
    try { await window.s3.copyText(text); notify(`${label} copied to clipboard`); }
    catch { notify('Unable to copy to clipboard'); }
  }, [notify]);
  const refresh = useCallback(() => { setUriResult(null); if (location) void browser.load(location.connectionId, location.prefix, true); }, [location, browser.load]);
  const up = () => { if (parent !== null && location) browser.navigate({ ...location, prefix: parent }); };

  const submitUri = async () => {
    const ticket = ++uriRequest.current;
    setUriSearching(false);
    setUriResult(null);
    setSelectedKey(undefined);
    setCheckedKeys(new Set());
    const value = uriQuery;
    const uri = parseConnectionUri(value);
    if (!uri) { setUriError('Enter a URI such as s3://bucket/path/to/file.'); return; }
    const match = matchConnectionUri(value, browser.connections);
    if (!match) { setUriError(`No connection for ${uri.uriScheme}://${uri.bucket}`); return; }
    setUriSearching(true);
    setUriError('');
    try {
      const entries = match.key ? (await window.s3.searchUri(match.connection.id, match.key)).entries : [];
      if (ticket !== uriRequest.current) return;
      search.setQuery('');
      browser.navigate({ connectionId: match.connection.id, prefix: match.connection.prefix });
      setUriResult(match.key ? { uri: value, connectionId: match.connection.id, prefix: match.connection.prefix, entries } : null);
    } catch (cause) {
      if (ticket === uriRequest.current) setUriError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to search this URI.');
    } finally { if (ticket === uriRequest.current) setUriSearching(false); }
  };

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (dialogOpen) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchRef.current?.focus(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); refresh(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => document.removeEventListener('keydown', keyDown);
  }, [dialogOpen, refresh]);

  const entryAction = async (entry: Entry, action: 'download' | 'delete') => {
    if (!connection || !location) return;
    const operationKey = nodeKey(connection.id, entry.key);
    if (operations.current.has(operationKey)) return;
    operations.current.add(operationKey);
    setBusyEntries(current => new Set([...current, operationKey]));
    try {
      if (action === 'download') {
        const groupId = await window.s3.download(connection.id, entry.key, entry.kind);
        if (groupId !== null) setTransferDirection('download');
      } else if (await window.s3.deleteEntry(connection.id, entry.key, entry.kind)) {
        notify(`${entry.name || 'Item'} deleted`);
        if (search.active) search.setQuery('');
      }
    } catch (error) { notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : `Unable to ${action} this item`); }
    finally {
      operations.current.delete(operationKey);
      setBusyEntries(current => { const next = new Set(current); next.delete(operationKey); return next; });
    }
  };
  const toggleChecked = (entry: Entry) => setCheckedKeys(current => {
    const next = new Set(current);
    if (next.has(entry.key)) next.delete(entry.key); else next.add(entry.key);
    return next;
  });
  const toggleAllChecked = () => setCheckedKeys(checkedEntries.length === visible.length ? new Set() : new Set(visible.map(entry => entry.key)));
  const bulkAction = async (action: 'download' | 'delete') => {
    if (!connection || !checkedEntries.length || bulkBusy) return;
    const targets = checkedEntries.map(entry => ({ key: entry.key, kind: entry.kind }));
    const operationKeys = targets.map(entry => nodeKey(connection.id, entry.key));
    if (operationKeys.some(key => operations.current.has(key))) return;
    operationKeys.forEach(key => operations.current.add(key));
    setBusyEntries(current => new Set([...current, ...operationKeys]));
    setBulkBusy(action);
    try {
      const result = action === 'download' ? await window.s3.downloadEntries(connection.id, targets) : await window.s3.deleteEntries(connection.id, targets);
      if (!result) return;
      if (action === 'download' && result.succeeded) setTransferDirection('download');
      if (action === 'delete' && result.succeeded && search.active) search.setQuery('');
      if (selectionScopeRef.current === selectionScope) setCheckedKeys(result.failed.length ? new Set(result.failed.map(item => item.key)) : new Set());
      if (result.failed.length) notify(`${result.succeeded} ${action === 'download' ? 'started' : 'deleted'}, ${result.failed.length} failed: ${result.failed[0].message}`);
      else notify(action === 'download' ? `${result.succeeded} downloads started` : `${result.succeeded} items deleted`);
    } catch (error) { notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : `Unable to ${action} selected items`); }
    finally {
      operationKeys.forEach(key => operations.current.delete(key));
      setBusyEntries(current => { const next = new Set(current); operationKeys.forEach(key => next.delete(key)); return next; });
      setBulkBusy(null);
    }
  };
  const upload = async (paths: string[]) => {
    if (!connection || !location) return;
    const groupId = await window.s3.upload(connection.id, location.prefix, paths);
    setUploadOpen(false);
    if (groupId !== null) setTransferDirection('upload');
  };
  const copyEntry = async (destinationFolder: string, name: string) => {
    if (!copyTarget) return;
    const target = copyTarget;
    const operationKey = nodeKey(target.connection.id, target.entry.key);
    if (operations.current.has(operationKey)) throw new Error('This item already has an operation in progress.');
    operations.current.add(operationKey);
    setBusyEntries(current => new Set([...current, operationKey]));
    try {
      const count = await window.s3.copyEntry(target.connection.id, target.entry.key, target.entry.kind, destinationFolder, name);
      notify(`${target.entry.kind === 'folder' ? `${count} object${count === 1 ? '' : 's'}` : 'File'} copied`);
      setCopyTarget(current => current === target ? null : current);
    } finally {
      operations.current.delete(operationKey);
      setBusyEntries(current => { const next = new Set(current); next.delete(operationKey); return next; });
    }
  };
  const renameEntry = async (name: string) => {
    if (!renameTarget) return;
    const target = renameTarget;
    const operationKey = nodeKey(target.connection.id, target.entry.key);
    if (operations.current.has(operationKey)) throw new Error('This item already has an operation in progress.');
    operations.current.add(operationKey);
    setBusyEntries(current => new Set([...current, operationKey]));
    try {
      const count = await window.s3.renameEntry(target.connection.id, target.entry.key, target.entry.kind, name);
      notify(`${target.entry.kind === 'folder' ? `${count} object${count === 1 ? '' : 's'}` : 'File'} renamed`);
      if (search.active) search.setQuery('');
      setUriResult(null);
      setRenameTarget(current => current === target ? null : current);
    } catch (error) {
      notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'The rename failed.');
      throw error;
    } finally {
      operations.current.delete(operationKey);
      setBusyEntries(current => { const next = new Set(current); next.delete(operationKey); return next; });
    }
  };
  const save = async (input: ConnectionInput) => { await browser.save(input); setDialog(null); };
  const edit = async (client: Connection) => {
    try { setDialog({ connection: await window.s3.connectionDetails(client.id) }); }
    catch (error) { notify(error instanceof Error ? error.message : 'Unable to load connection settings'); }
  };
  const copyConnection = async (client: Connection) => {
    try { await browser.copy(client.id); notify('Connection copied'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Unable to copy connection'); }
  };
  const reorderConnections = async (ids: string[]) => {
    try { await browser.reorder(ids); }
    catch (error) { notify(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to save connection order'); }
  };
  const remove = async (client: Connection) => {
    try { if (await browser.remove(client.id)) notify('Connection removed'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Unable to remove connection'); }
  };
  const sort = (next: SortColumn) => { setDirection(next === column && direction === 'asc' ? 'desc' : 'asc'); setColumn(next); };
  const scanStats = async (entry: Entry) => {
    if (!connection) return;
    const result = await browser.scanStats(connection.id, entry.key);
    if (result) search.setEntryStats(connection.id, entry.key, result);
  };
  const onOpen = (entry: Entry) => {
    if (uriOutsidePrefix) { setInfo(true); return; }
    if (entry.kind === 'folder' && location) browser.navigate({ ...location, prefix: entry.key });
    else if (entry.kind === 'file' && /\.mp4$/i.test(entry.name) && connection && permissions.download) setVideo({ connectionId: connection.id, key: entry.key, name: entry.name });
    else setInfo(true);
  };
  const resize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const width = sidebarWidth;
    const target = event.currentTarget;
    const move = (pointer: PointerEvent) => setSidebarWidth(Math.min(420, Math.max(200, width + pointer.clientX - start)));
    const stop = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', stop); target.removeEventListener('pointercancel', stop); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', stop); target.addEventListener('pointercancel', stop);
  };

  return <>
    <div className="desktop-app" ref={appRef} inert={dialogOpen} style={{ '--sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}>
      <aside className="sidebar"><Sidebar connections={browser.connections} nodes={browser.nodes} expanded={browser.expanded} location={location} onSelect={browser.navigate} onToggle={browser.toggle} onRefresh={(id, prefix) => void browser.load(id, prefix, true)} onAdd={() => setDialog({})} onEdit={client => void edit(client)} onCopy={client => void copyConnection(client)} onReorder={reorderConnections} onRemove={client => void remove(client)} /></aside>
      <div className="sidebar-resizer" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical" aria-valuenow={sidebarWidth} aria-valuemin={200} aria-valuemax={420} onPointerDown={resize} onKeyDown={event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setSidebarWidth(width => Math.max(200, Math.min(420, width + (event.key === 'ArrowRight' ? 10 : -10)))); } }} />
      <main className="main-pane">
        <header className="toolbar">
          <div className="navigation-controls"><button className="icon-button" aria-label="Back" title="Back" onClick={browser.back} disabled={browser.history.index <= 0}><ChevronLeft size={20} /></button><button className="icon-button" aria-label="Forward" title="Forward" onClick={browser.forward} disabled={browser.history.index >= browser.history.entries.length - 1}><ChevronRight size={20} /></button></div>
          <div className="toolbar-title"><span>{currentName}</span>{connection && <small>{connection.bucket}</small>}</div>
          <div className="toolbar-actions">{(['download', 'upload'] as const).map(direction => <button key={direction} className="icon-button transfer-list-button" aria-label={`${direction === 'download' ? 'Downloads' : 'Uploads'}${ongoingTransfers(direction) ? ` (${ongoingTransfers(direction)} ongoing)` : ''}`} title={direction === 'download' ? 'Downloads' : 'Uploads'} onClick={() => setTransferDirection(direction)}>{direction === 'download' ? <ArrowDownToLine size={17} /> : <ArrowUpFromLine size={17} />}{ongoingTransfers(direction) > 0 && <span className="transfer-badge" aria-hidden="true">{ongoingTransfers(direction)}</span>}</button>)}<span className="toolbar-divider" /><button className="icon-button" title="Refresh folder (⌘/Ctrl R)" aria-label="Refresh folder" onClick={refresh} disabled={!location || state?.loading}>{state?.loading ? <LoaderCircle size={17} className="spin" /> : <RefreshCw size={16} />}</button><span className="toolbar-divider" /><button className={`icon-button ${info ? 'active' : ''}`} title="Item information" aria-label="Toggle item information" aria-pressed={info} onClick={() => setInfo(!info)} disabled={!connection}><Info size={17} /></button></div>
          <form className="uri-search" role="search" onSubmit={event => { event.preventDefault(); void submitUri(); }}><Search size={14} /><input aria-label="Search URI across connections" placeholder="s3://bucket/key" value={uriQuery} onChange={event => { uriRequest.current++; setUriSearching(false); setUriQuery(event.target.value); setUriError(''); }} /><button type="submit" className="icon-button" aria-label="Go to URI" title="Search URI across connections" disabled={uriSearching || !uriQuery.trim()}>{uriSearching ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={16} />}</button></form>
        </header>
        {uriError && <div className="uri-search-feedback" role="alert">{uriError}</div>}
        {connection && location && <div className="location-bar"><div className="breadcrumb" aria-label="Folder path"><Cloud size={15} /><button onClick={() => browser.navigate({ connectionId: connection.id, prefix: connection.prefix })} title={storageUri(connection, connection.prefix)}>{connection.name}</button>{path.map(item => <span key={item.prefix} className="breadcrumb-segment"><ChevronRight size={12} /><button onClick={() => browser.navigate({ connectionId: connection.id, prefix: item.prefix })}>{item.name}</button></span>)}</div><button className="icon-button copy-path" aria-label={`Copy folder ${uriLabel(connection)}`} title={`Copy folder ${uriLabel(connection)}`} onClick={() => void copy(storageUri(connection, location.prefix))}><Copy size={13} /></button></div>}
        {connection && location && <form className="search-strip" onSubmit={event => { event.preventDefault(); setUriResult(null); search.submit(); }}>
          {permissions.upload && <button type="button" className="button secondary search-upload" onClick={() => setUploadOpen(true)}><ArrowUpFromLine size={13} />Upload</button>}
          <label className="search-mode-label">Range <select aria-label="Search range" value={search.range} onChange={event => search.setRange(event.target.value as SearchRange)}>
            <option value="page">This page</option><option value="folder">This folder</option><option value="recursive">All subfolders</option><option value="key">Full S3 key</option>
          </select></label>
          <label className="search-mode-label">Match <select aria-label="Name match" value={search.match} disabled={search.range === 'key'} onChange={event => search.setMatch(event.target.value as SearchMatch)}>
            <option value="prefix">Prefix</option><option value="contains">Contains</option><option value="exact">{search.range === 'key' ? 'Exact S3 key' : 'Exact file name'}</option>
          </select></label>
          <label className="search-field"><Search size={15} /><input ref={searchRef} aria-label={search.range === 'key' ? 'Full S3 key' : 'Search file name'} placeholder={search.range === 'key' ? 'Full file key or folder path' : search.match === 'exact' ? 'Exact file name' : search.match === 'prefix' ? 'File name prefix' : 'Part of a name'} value={search.query} onChange={event => search.setQuery(event.target.value)} />{search.query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => search.setQuery('')}><X size={13} /></button>}</label>
          {search.range !== 'page' && <button type="submit" className="button secondary search-submit" disabled={!search.query || search.loading}>{search.loading ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />}Search</button>}
          <span className="search-scope-hint">{search.range === 'page' ? 'Filters loaded items only' : search.range === 'key' ? 'Checks an exact file or folder path in this connection' : search.range === 'recursive' ? 'Scans all keys below this folder' : search.match === 'exact' ? 'Checks one S3 key' : search.match === 'prefix' ? 'Lists matching names across pages' : 'Scans this folder’s listing'}</span>
        </form>}
        <div className="content-area">
          <section className="file-pane" aria-label="File browser">
            {uriView && connection && <div className="uri-result-banner"><span>Using {connection.name}</span><span title={uriView.uri}>{uriView.uri}</span>{uriOutsidePrefix && <small>This key is outside this connection’s browsing prefix. File operations are unavailable.</small>}<button className="icon-button" aria-label="Close URI result" title="Return to folder" onClick={() => setUriResult(null)}><X size={14} /></button></div>}
            {connection && checkedEntries.length > 0 && !uriOutsidePrefix && <div className="bulk-actions" role="toolbar" aria-label="Selected items"><strong>{checkedEntries.length.toLocaleString()} selected</strong>{permissions.download && <button className="button secondary" disabled={bulkBusy !== null || checkedEntries.some(entry => busyEntries.has(nodeKey(connection.id, entry.key)))} onClick={() => void bulkAction('download')}><ArrowDownToLine size={13} />Download {checkedEntries.length} selected</button>}{permissions.delete && <button className="button secondary danger" disabled={bulkBusy !== null || checkedEntries.some(entry => busyEntries.has(nodeKey(connection.id, entry.key)))} onClick={() => void bulkAction('delete')}><Trash2 size={13} />Delete {checkedEntries.length} selected</button>}<button className="button secondary clear-selection" disabled={bulkBusy !== null} onClick={() => setCheckedKeys(new Set())}>Clear selection</button></div>}
            {!search.active && state?.error && state.loaded && <div className="cache-warning" role="status"><span>Refresh failed. {state.error} Showing the previous listing.</span><button onClick={refresh}>Retry refresh</button></div>}
            {browser.initializing ? <div className="content-state"><LoaderCircle size={28} className="spin loading-icon" /><p>Loading your connections…</p></div> : browser.startupError ? <div className="content-state" role="alert"><Server size={36} /><h2>Unable to start S3 Client</h2><p>{browser.startupError}</p></div> : connection && location ? (
              uriView && !uriView.entries.length ? <div className="content-state"><h2>No matching items</h2><p>No file or folder exists at “{uriView.uri}”.</p></div> :
              search.active && search.loading && !search.result && !uriView ? <div className="content-state" role="status"><LoaderCircle size={29} className="spin loading-icon" /><h2>Searching S3…</h2><p>{search.range === 'key' ? 'Checking this exact S3 key.' : search.range === 'recursive' ? 'Scanning every key below this folder.' : search.match === 'contains' ? 'Scanning this folder’s listing.' : 'Checking this folder.'}</p></div> :
              !uriView && search.active && search.error ? <div className="content-state" role="alert"><h2>Search failed</h2><p>{search.error}</p><button className="button secondary" onClick={search.submit}>Try again</button></div> :
              !uriView && search.active && search.result && !search.result.entries.length ? <div className="content-state"><h2>No matching items</h2><p>No results for “{search.query}” in this search scope.</p></div> :
              <FileList permissions={resultPermissions} allowStats={!uriOutsidePrefix} busyEntries={new Set([...busyEntries].filter(key => JSON.parse(key)[0] === connection.id).map(key => JSON.parse(key)[1] as string))} checkedKeys={checkedKeys} selectionDisabled={bulkBusy !== null || uriOutsidePrefix} onToggleChecked={toggleChecked} onToggleAll={toggleAllChecked} onDownload={entry => void entryAction(entry, 'download')} onDelete={entry => void entryAction(entry, 'delete')} entries={visible} state={uriView ? { entries: uriView.entries, loaded: true, loading: false } : search.active && search.result ? { entries: search.result.entries, loaded: true, loading: search.loading, pageIndex: search.pageIndex, nextToken: search.result.nextToken } : state} query={uriView ? '' : search.range === 'page' ? search.query : ''} selected={selected} column={column} direction={direction} onSort={sort} onSelect={entry => setSelectedKey(entry.key)} onOpen={onOpen} onRefresh={refresh} onEdit={() => void edit(connection)} onStats={entry => void scanStats(entry)} getStatsState={prefix => browser.statistics[nodeKey(connection.id, prefix)]} onUp={up} onCopy={entry => void copy(storageUri(connection, entry.key))} onCopyKey={entry => void copy(entry.key, 'S3 key')} onCopyName={entry => { const path = entry.kind === 'folder' && entry.key.endsWith('/') ? entry.key.slice(0, -1) : entry.key; void copy(path.slice(path.lastIndexOf('/') + 1), entry.kind === 'folder' ? 'Folder name' : 'File name'); }} onCopyTo={entry => setCopyTarget({ connection, entry })} onRename={entry => setRenameTarget({ connection, entry })} />
            ) : <div className="welcome-state"><div className="welcome-illustration"><div className="illustration-orbit" /><div className="illustration-folder back"><Folder size={112} strokeWidth={0.8} fill="currentColor" /></div><div className="illustration-folder front"><Folder size={112} strokeWidth={0.8} fill="currentColor" /></div><div className="illustration-cloud"><Cloud size={28} strokeWidth={1.4} /></div></div><span className="eyebrow">A FAMILIAR PLACE FOR YOUR FILES</span><h1>Your cloud.<br />A little closer.</h1><p>All your S3 storage, in one simple workspace.<br />Connect a bucket and make yourself at home.</p><button className="button primary welcome-button" onClick={() => setDialog({})}><Plus size={16} />Add your first connection</button><div className="compatible"><span>Works with</span><b>Amazon S3</b><span>·</span><b>MinIO</b><span>·</span><b>Any S3-compatible service</b></div></div>}
            {!uriView && connection && location && search.active && search.result && search.range !== 'key' && (search.range !== 'folder' || search.match !== 'exact') ? <FilePagination page={search.pageIndex} pageSize={pageSize} hasNext={search.hasNext} loading={search.loading} onPrevious={search.previous} onNext={search.next} onPageSize={search.setPageSize} hint={search.range === 'recursive' ? 'Matching file names across all subfolders.' : 'Matching names in this folder.'} /> : !uriView && connection && location && !search.active && state?.loaded && <FilePagination page={state.pageIndex ?? 0} pageSize={pageSize} hasNext={Boolean(state.nextToken)} loading={state.loading} onPrevious={() => void browser.previousPage(connection.id, location.prefix)} onNext={() => void browser.nextPage(connection.id, location.prefix)} onPageSize={size => void browser.setPageSize(connection.id, location.prefix, size)} />}
          </section>
          {info && connection && <Inspector entry={selected} connection={connection} onClose={() => setInfo(false)} onCopy={() => selected && void copy(storageUri(connection, selected.key))} />}
        </div>
        <footer className="status-bar"><div>{connection ? uriView ? <>{visible.length.toLocaleString()} URI result{visible.length === 1 ? '' : 's'}{selectedStatus && <><span className="status-separator">·</span>{selectedStatus}</>}</> : search.active ? search.loading ? <><LoaderCircle size={11} className="spin" />Searching S3…</> : search.error ? 'Search failed' : <>{visible.length.toLocaleString()} search results{selectedStatus && <><span className="status-separator">·</span>{selectedStatus}</>}</> : state?.loading ? <><LoaderCircle size={11} className="spin" />Updating folder…</> : state?.error && !state.loaded ? 'Unable to load folder' : <>{visible.length.toLocaleString()}{search.range === 'page' && search.query ? ` of ${(state?.entries.length || 0).toLocaleString()}` : ''} items{state?.cached && <span className="cache-label" title={"Saved listing from " + state.updatedAt?.toLocaleString() + ". Refresh to update."}>· Cached</span>}{selectedStatus && <><span className="status-separator">·</span>{selectedStatus}</>}</> : <><Cloud size={12} />Ready to connect</>}</div><span className="status-right">{connection ? <><span className={`status-dot ${state?.error ? 'error' : ''}`} />{connection.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')}</> : 'S3 Client'}</span></footer>
      </main>
    </div>
    {toast && <div className="toast" role="status"><Check size={14} />{toast}</div>}
    <div inert={confirmation !== null}>
      {transferDirection && <TransferPanel key={transferDirection} direction={transferDirection} snapshot={transfers.snapshot} uriSchemes={Object.fromEntries(browser.connections.map(item => [item.id, item.uriScheme || 's3']))} error={transfers.error} onClose={closeTransfers} onControl={transfers.control} onControlAll={transfers.controlAll} onRemove={transfers.remove} onClear={transfers.clear} onConcurrency={transfers.setConcurrency} />}
      {video && <VideoPlayer key={`${video.connectionId}:${video.key}`} connectionId={video.connectionId} objectKey={video.key} name={video.name} onClose={() => setVideo(null)} />}
      {dialog && <ConnectionDialog connection={dialog.connection} secureStorage={browser.secureStorage} onSave={save} onClose={closeDialog} />}
      {uploadOpen && connection && location && <UploadDialog connectionId={connection.id} prefix={location.prefix} destination={storageUri(connection, location.prefix)} onUpload={upload} onClose={closeUpload} />}
      {copyTarget && <CopyDialog key={`${copyTarget.connection.id}:${copyTarget.entry.key}`} connection={copyTarget.connection} entry={copyTarget.entry} onCopy={copyEntry} onClose={() => setCopyTarget(null)} />}
      {renameTarget && <RenameDialog key={`${renameTarget.connection.id}:${renameTarget.entry.key}`} connection={renameTarget.connection} entry={renameTarget.entry} onRename={renameEntry} onClose={() => setRenameTarget(null)} />}
    </div>
    {confirmation && <ConfirmationDialog key={confirmation.id} request={confirmation} onAnswer={answerConfirmation} />}
  </>;
}
