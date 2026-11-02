import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, LoaderCircle, Trash2, X } from 'lucide-react';
import type { TransferAction, TransferDirection, TransferPreparation, TransferSnapshot, TransferTask } from '../../../shared/transfers';
import { formatBytes } from '../model';
import { formatTransferSpeed } from '../../../shared/transfer-speed';
import { storageUri } from '../../../shared/storage-uri';

interface Props {
  direction: TransferDirection;
  snapshot: TransferSnapshot;
  uriSchemes: Record<string, string>;
  error: string;
  onClose(): void;
  onControl(id: string, action: TransferAction): Promise<void>;
  onControlAll(direction: TransferDirection, action: TransferAction): Promise<void>;
  onRemove(id: string): Promise<void>;
  onClear(direction: TransferDirection): Promise<void>;
  onConcurrency(direction: TransferDirection, concurrency: number): Promise<void>;
}
const PAGE_SIZE = 50;
const statusLabels = { queued: 'Queued', running: 'Transferring', paused: 'Stopped', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' };

export function TransferPanel({ direction, snapshot, uriSchemes, error, onClose, onControl, onControlAll, onRemove, onClear, onConcurrency }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [removing, setRemoving] = useState(new Set<string>());
  const removingRef = useRef(new Set<string>());
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const title = direction === 'download' ? 'Downloads' : 'Uploads';
  const preparations = snapshot.preparations.filter(item => item.direction === direction);
  const tasks = snapshot.tasks.filter(item => item.direction === direction);
  const rows: (TransferTask | TransferPreparation)[] = [...preparations, ...tasks];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  useEffect(() => { setPage(current => Math.min(current, pages - 1)); }, [pages]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); }
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const elements = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]') || []);
      const first = elements[0]; const last = elements[elements.length - 1];
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previous?.focus();
      // The app removes inert in its own effect when this panel closes.
      queueMicrotask(() => { if (previous?.isConnected && !document.querySelector('[aria-modal="true"]')) previous.focus(); });
    };
  }, [onClose]);

  const control = (id: string, action: TransferAction) => { void onControl(id, action); };
  const remove = async (id: string) => {
    if (clearingRef.current || removingRef.current.has(id)) return;
    removingRef.current.add(id); setRemoving(new Set(removingRef.current));
    try { await onRemove(id); }
    finally { removingRef.current.delete(id); setRemoving(new Set(removingRef.current)); }
  };
  const clear = async () => {
    if (clearingRef.current || removingRef.current.size) return;
    clearingRef.current = true; setClearing(true);
    try { await onClear(direction); }
    finally { clearingRef.current = false; setClearing(false); }
  };
  const removeButton = (id: string, name: string) => <button className="icon-button transfer-remove" aria-label={`Remove ${name} from list`} title="Remove from list" disabled={clearing || removing.has(id)} onClick={() => void remove(id)}>{removing.has(id) ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button>;
  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="transfer-panel" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
      <header className="transfer-heading"><div className="transfer-title">{direction === 'download' ? <ArrowDownToLine size={21} /> : <ArrowUpFromLine size={21} />}<h2 id="transfer-title">{title}</h2><span>{rows.length.toLocaleString()} items</span></div><button className="icon-button" aria-label="Close transfer panel" onClick={onClose}><X size={18} /></button></header>
      <div className="transfer-controls"><div className="transfer-batch-actions">{(['start', 'stop', 'cancel'] as const).map(action => <button key={action} className="button secondary" disabled={clearing} onClick={() => void onControlAll(direction, action)}>{action[0].toUpperCase() + action.slice(1)} all</button>)}<button className="button secondary transfer-clear" disabled={!rows.length || clearing || removing.size > 0} onClick={() => void clear()}><Trash2 size={12} />{clearing ? 'Clearing…' : 'Clear all'}</button></div><label>Concurrent {title.toLowerCase()}<select aria-label={`Concurrent ${title.toLowerCase()}`} disabled={clearing} value={snapshot.concurrency[direction]} onChange={event => void onConcurrency(direction, Number(event.target.value))}>{Array.from({ length: 8 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label></div>
      <p className="transfer-hint">{snapshot.paused[direction] ? 'Queue stopped. ' : ''}Stop pauses a file. Starting it again transfers that file from the beginning. Removing a row cancels its transfer. Clear all lets you keep unfinished tasks or cancel them. Completed files are kept.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="transfer-list" aria-label={`${title} tasks`}>
        {!rows.length && <div className="transfer-empty">No {title.toLowerCase()} yet.</div>}
        {rows.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(item => {
          if (!('relativePath' in item)) return <article className="transfer-item" key={item.id} aria-label={item.name}>
            <div className="transfer-item-heading"><strong>{item.name}</strong><div className="transfer-item-tools"><span className={`transfer-status ${item.status}`}>{item.status === 'preparing' ? <><LoaderCircle size={12} className="spin" />Scanning…</> : statusLabels[item.status]}</span>{removeButton(item.id, item.name)}</div></div>
            {item.error && <p className="transfer-error">{item.error}</p>}
            {item.status === 'preparing' && <div className="transfer-item-actions"><button className="button secondary" disabled={clearing || removing.has(item.id)} aria-label={`Cancel ${item.name}`} onClick={() => control(item.id, 'cancel')}>Cancel</button></div>}
          </article>;
          const percent = item.size > 0 ? Math.min(100, Math.max(0, Math.floor(item.transferred / item.size * 100))) : item.status === 'completed' ? 100 : 0;
          const resumable = item.status === 'paused' || item.status === 'failed';
          const active = item.status === 'running' || item.status === 'queued';
          return <article className="transfer-item" key={item.id} aria-label={item.relativePath}>
            <div className="transfer-item-heading"><strong title={item.relativePath}>{item.relativePath}</strong><div className="transfer-item-tools"><span className={`transfer-status ${item.status}`}>{statusLabels[item.status]}</span>{removeButton(item.id, item.relativePath)}</div></div>
            <p className="transfer-connection">{item.connectionName} · {storageUri({ bucket: item.bucket, uriScheme: uriSchemes[item.connectionId] }, item.key)}</p>
            <p className="transfer-local-path"><span>{direction === 'download' ? 'Destination' : 'Source'}</span> {item.localPath}</p>
            <div className="transfer-progress"><div className="transfer-progress-track" role="progressbar" aria-label={`Progress for ${item.relativePath}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><div style={{ width: `${percent}%` }} /></div><span>{formatBytes(item.transferred)} / {formatBytes(item.size)} · {percent}%</span>{item.status === 'running' && !item.isDirectory && <span className="transfer-speed" title="Average speed for the current transfer attempt">{formatTransferSpeed(item.bytesPerSecond ?? 0)}</span>}</div>
            {item.error && <p className="transfer-error">{item.error}</p>}
            {(active || resumable) && <div className="transfer-item-actions"><button className="button secondary" disabled={clearing || removing.has(item.id)} aria-label={`${resumable ? 'Start' : 'Stop'} ${item.relativePath}`} onClick={() => control(item.id, resumable ? 'start' : 'stop')}>{resumable ? 'Start' : 'Stop'}</button><button className="button secondary" disabled={clearing || removing.has(item.id)} aria-label={`Cancel ${item.relativePath}`} onClick={() => control(item.id, 'cancel')}>Cancel</button></div>}
          </article>;
        })}
      </div>
      {pages > 1 && <footer className="transfer-pagination"><button className="button secondary" aria-label="Previous page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {pages}</span><button className="button secondary" aria-label="Next page" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next</button></footer>}
    </div>
  </div>;
}
