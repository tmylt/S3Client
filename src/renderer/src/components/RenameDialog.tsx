import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pencil, X } from 'lucide-react';
import type { Connection, Entry } from '../../../shared/types';
import { storageUri } from '../../../shared/storage-uri';

interface Props {
  connection: Connection;
  entry: Entry;
  onRename(name: string): Promise<void>;
  onClose(): void;
}

const message = (error: unknown) => error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'The rename failed.';

export function RenameDialog({ connection, entry, onRename, onClose }: Props) {
  const sourcePath = entry.kind === 'folder' ? entry.key.slice(0, -1) : entry.key;
  const parent = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
  const originalName = sourcePath.slice(parent.length);
  const [name, setName] = useState(originalName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLFormElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const invalid = !name || name.includes('/') || name.includes('\0') || name === originalName || `${parent}${name}`.length > 8192;
  const target = `${parent}${name}${entry.kind === 'folder' ? '/' : ''}`;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    nameInput.current?.focus();
    nameInput.current?.select();
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

  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true); setError('');
    try { await onRename(name); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form ref={dialog} className="upload-dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <header className="upload-heading"><div className="dialog-icon"><Pencil size={23} strokeWidth={1.6} /></div><div><h2 id="rename-title">Rename {entry.kind}</h2><p>The new name must be in the same folder. S3 copies the item before removing the old name.</p></div><button type="button" className="icon-button" aria-label="Close rename dialog" onClick={onClose}><X size={18} /></button></header>
      <p className="upload-destination" title={storageUri(connection, entry.key)}><span>From</span>{storageUri(connection, entry.key)}</p>
      <label className="copy-name-field"><span>New name</span><input ref={nameInput} aria-label="New name" value={name} onChange={event => setName(event.target.value)} spellCheck={false} autoComplete="off" maxLength={8192} /></label>
      <p className="upload-destination rename-target" title={storageUri(connection, target)}><span>To</span>{storageUri(connection, target)}</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <footer className="upload-footer"><span>Existing names will not be replaced.</span><button type="button" className="button secondary" onClick={onClose}>Close</button><button type="submit" className="button primary" disabled={busy || invalid}>{busy && <LoaderCircle size={14} className="spin" />}{busy ? 'Renaming…' : 'Rename'}</button></footer>
    </form>
  </div>;
}
