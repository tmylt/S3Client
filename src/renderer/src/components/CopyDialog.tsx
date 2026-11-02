import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, FolderInput, LoaderCircle, X } from 'lucide-react';
import type { Connection, Entry } from '../../../shared/types';
import { storageUri } from '../../../shared/storage-uri';
import { EntryIcon } from './EntryIcon';

interface Props {
  connection: Connection;
  entry: Entry;
  onCopy(destinationFolder: string, name: string): Promise<void>;
  onClose(): void;
}

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'The copy failed.';
const folderPath = (value: string) => value && !value.endsWith('/') ? `${value}/` : value;
const entryName = (entry: Entry) => (entry.kind === 'folder' ? entry.key.replace(/\/$/, '') : entry.key).split('/').at(-1) || entry.name;

export function CopyDialog({ connection, entry, onCopy, onClose }: Props) {
  const root = connection.prefix;
  const sourcePath = entry.kind === 'folder' ? entry.key.slice(0, -1) : entry.key;
  const parent = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const initial = parent.startsWith(root) ? parent : root;
  const [path, setPath] = useState(initial);
  const [current, setCurrent] = useState(initial);
  const [name, setName] = useState(entryName(entry));
  const [folders, setFolders] = useState<Entry[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);

  const open = useCallback(async (prefix: string, continuationToken?: string | null) => {
    const destination = folderPath(prefix);
    if (!destination.startsWith(root)) { setError('Choose a folder inside this connection.'); return; }
    const request = ++sequence.current;
    setLoading(true); setError('');
    if (!continuationToken) { setFolders([]); setNextToken(null); setCurrent(destination); setPath(destination); }
    try {
      const listing = await window.s3.list(connection.id, destination, connection.defaultPageSize ?? 1000, continuationToken);
      if (sequence.current !== request) return;
      setFolders(previous => continuationToken ? [...previous, ...listing.entries.filter(item => item.kind === 'folder')] : listing.entries.filter(item => item.kind === 'folder'));
      setNextToken(listing.nextToken ?? null);
    } catch (failure) { if (sequence.current === request) setError(message(failure)); }
    finally { if (sequence.current === request) setLoading(false); }
  }, [connection.id, connection.defaultPageSize, root]);

  useEffect(() => { void open(initial); return () => { sequence.current++; }; }, [open, initial]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pathInput.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) event.preventDefault();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])') || []);
      const first = elements[0]; const last = elements.at(-1);
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      queueMicrotask(() => { if (previous?.isConnected && !document.querySelector('[aria-modal="true"]')) previous.focus(); });
    };
  }, [onClose]);

  const destination = folderPath(path);
  const invalidName = !name || name.includes('/') || name.includes('\0');
  const invalidFolder = !destination.startsWith(root);
  const target = `${destination}${name}${entry.kind === 'folder' ? '/' : ''}`;
  const recursive = entry.kind === 'folder' && target.startsWith(entry.key);
  const same = target === entry.key;
  const submit = async () => {
    if (busy) return;
    if (invalidName || invalidFolder || recursive || same) {
      setError(invalidName ? 'Enter a name without slashes.' : invalidFolder ? 'Choose a folder inside this connection.' : 'Choose a different name or a destination outside the source folder.');
      return;
    }
    setBusy(true); setError('');
    try { await onCopy(destination, name); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  const parentFolder = current === root ? null : current.slice(0, -1).split('/').slice(0, -1).join('/') + '/';

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="upload-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-title">
      <header className="upload-heading"><div className="dialog-icon"><FolderInput size={24} strokeWidth={1.6} /></div><div><h2 id="copy-title">Copy {entry.kind}</h2><p>Copy within {connection.name}. Existing destinations are checked before copying.</p></div><button className="icon-button" aria-label="Close copy dialog" onClick={onClose}><X size={18} /></button></header>
      <p className="upload-destination" title={storageUri(connection, entry.key)}><span>From</span>{storageUri(connection, entry.key)}</p>
      <form className="upload-location" onSubmit={event => { event.preventDefault(); void open(path); }}>
        <button className="icon-button" type="button" aria-label="Open parent S3 folder" title="Open parent S3 folder" disabled={loading || !parentFolder} onClick={() => parentFolder && void open(parentFolder)}><ArrowUp size={17} /></button>
        <label><span className="visually-hidden">Destination S3 folder key</span><input ref={pathInput} aria-label="Destination S3 folder key" value={path} onChange={event => setPath(event.target.value)} spellCheck={false} autoComplete="off" /></label>
        <button className="button secondary" type="submit" disabled={loading || !path}>Go</button>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="upload-source-list" aria-label="Destination S3 folders" aria-busy={loading}>
        {loading && !nextToken ? <div className="upload-source-empty"><LoaderCircle size={23} className="spin" />Opening folder…</div> : !folders.length ? <div className="upload-source-empty">No subfolders on this page. You can copy into this folder or enter a folder key above.</div> : folders.map(folder => <div key={folder.key} className="upload-source-row"><button className="copy-folder-button" onClick={() => void open(folder.key)}><EntryIcon entry={folder} size={20} /><span title={folder.name}>{folder.name}</span><ChevronRight size={16} /></button></div>)}
        {nextToken && <button className="button secondary copy-more" disabled={loading} onClick={() => void open(current, nextToken)}>Load more folders</button>}
      </div>
      <label className="copy-name-field"><span>New {entry.kind} name</span><input aria-label="New name" value={name} onChange={event => setName(event.target.value)} spellCheck={false} autoComplete="off" /></label>
      <footer className="upload-footer"><span title={storageUri(connection, target)}>{storageUri(connection, target)}</span><button className="button secondary" onClick={onClose}>Close</button><button className="button primary" disabled={busy || invalidName || invalidFolder || recursive || same} onClick={() => void submit()}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? 'Copying…' : 'Copy'}</button></footer>
    </div>
  </div>;
}
