import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpFromLine, ChevronRight, LoaderCircle, X } from 'lucide-react';
import type { UploadSources } from '../../../shared/types';
import { EntryIcon } from './EntryIcon';

interface Props {
  connectionId: string;
  prefix: string;
  destination: string;
  onUpload(paths: string[]): Promise<void>;
  onClose(): void;
}

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to open upload sources.';

export function UploadDialog({ connectionId, prefix, destination, onUpload, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const pathInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const [listing, setListing] = useState<UploadSources>();
  const [path, setPath] = useState('');
  const [selected, setSelected] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const open = useCallback(async (directory?: string) => {
    const request = ++sequence.current;
    setLoading(true); setError(''); setSelected(new Set()); setListing(undefined);
    try {
      const result = await window.s3.uploadSources(connectionId, prefix, directory);
      if (sequence.current !== request) return;
      setListing(result); setPath(result.directory);
    } catch (error) { if (sequence.current === request) setError(message(error)); }
    finally { if (sequence.current === request) setLoading(false); }
  }, [connectionId, prefix]);

  useEffect(() => { void open(); return () => { sequence.current++; }; }, [open]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    pathInput.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) event.preventDefault();
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onClose(); }
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

  const upload = async () => {
    if (busyRef.current || loading || !selected.size) return;
    busyRef.current = true; setBusy(true); setError('');
    try { await onUpload([...selected]); }
    catch (error) { setError(message(error)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const toggle = (path: string) => setSelected(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; });

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialog} className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header className="upload-heading"><div className="dialog-icon"><ArrowUpFromLine size={24} strokeWidth={1.6} /></div><div><h2 id="upload-title">Upload</h2><p>Choose files or folders. Folder structure will be preserved.</p></div><button className="icon-button" aria-label="Close upload chooser" onClick={onClose} disabled={busy}><X size={18} /></button></header>
      <p className="upload-destination" title={destination}><span>To</span>{destination}</p>
      <form className="upload-location" onSubmit={event => { event.preventDefault(); if (!busy) void open(path); }}>
        <button className="icon-button" type="button" aria-label="Open parent directory" title="Open parent directory" disabled={busy || loading || !listing?.parent} onClick={() => listing?.parent && void open(listing.parent)}><ArrowUp size={17} /></button>
        <label><span className="visually-hidden">Local folder</span><input ref={pathInput} value={path} onChange={event => setPath(event.target.value)} disabled={busy} spellCheck={false} autoComplete="off" /></label>
        <button className="button secondary" type="submit" disabled={busy || !path}>Go</button>
      </form>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="upload-source-list" aria-label="Local files and folders" aria-busy={loading}>
        {loading ? <div className="upload-source-empty"><LoaderCircle size={23} className="spin" />Opening folder…</div> : !listing ? <div className="upload-source-empty">Choose a local folder to browse.</div> : !listing.entries.length ? <div className="upload-source-empty">This folder is empty.</div> : listing.entries.map(entry => <div key={entry.path} className={`upload-source-row${selected.has(entry.path) ? ' selected' : ''}`} onDoubleClick={() => { if (!busy && entry.kind === 'folder') void open(entry.path); }}>
          <label><input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.path)} disabled={busy} onChange={() => toggle(entry.path)} /><EntryIcon entry={entry} size={20} /><span title={entry.name}>{entry.name}</span><small>{entry.kind === 'folder' ? 'Folder' : 'File'}</small></label>
          {entry.kind === 'folder' ? <button className="icon-button" aria-label={`Open ${entry.name}`} title="Open folder" disabled={busy} onClick={() => void open(entry.path)}><ChevronRight size={16} /></button> : <span className="upload-source-spacer" aria-hidden="true" />}
        </div>)}
      </div>
      <footer className="upload-footer"><span>{selected.size ? `${selected.size} selected` : 'Select files or folders to upload'}</span><button className="button secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" onClick={() => void upload()} disabled={busy || loading || !selected.size}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? 'Preparing…' : 'Upload'}</button></footer>
    </div>
  </div>;
}
