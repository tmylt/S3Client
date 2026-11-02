import { useEffect, useRef } from 'react';
import { Cloud, File, Folder, List, Trash2, Unplug, X } from 'lucide-react';
import type { ConfirmationAnswer, ConfirmationRequest } from '../../../shared/types';

interface Props {
  request: ConfirmationRequest;
  onAnswer(answer: ConfirmationAnswer): void;
}

export function ConfirmationDialog({ request, onAnswer }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const removing = request.kind === 'connection';
  const clearing = request.kind === 'transfer-list';
  const batch = request.kind === 'entry-batch';
  const history = clearing || request.kind === 'transfer';
  const batchCount = Number.parseInt(request.name, 10);
  const action = clearing ? 'Cancel tasks and clear all' : history ? 'Remove row' : removing ? 'Remove connection' : batch ? `Delete ${batchCount} ${batchCount === 1 ? 'item' : 'items'}` : `Delete ${request.kind}`;
  const title = clearing ? `Clear ${request.name.toLowerCase()}?` : history ? 'Remove transfer?' : batch ? 'Delete selected items?' : `${action}?`;
  const ItemIcon = history || batch ? List : removing ? Cloud : request.kind === 'folder' ? Folder : File;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); onAnswer(false); return;
      }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []);
      const first = buttons[0]; const last = buttons.at(-1);
      if (!dialog.current?.contains(document.activeElement)) {
        event.preventDefault(); cancel.current?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onAnswer]);

  return <div className="modal-overlay confirmation-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onAnswer(false); }}>
    <div ref={dialog} className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description confirmation-consequence">
      <button className="icon-button dialog-close" aria-label="Close confirmation" onClick={() => onAnswer(false)}><X size={18} /></button>
      <div className="dialog-icon confirmation-icon">{removing ? <Unplug size={24} strokeWidth={1.7} /> : <Trash2 size={24} strokeWidth={1.7} />}</div>
      <h2 id="confirmation-title">{title}</h2>
      <p id="confirmation-description" className="confirmation-description">{clearing ? 'Choose what to clear from this transfer list, including rows on other pages.' : history ? 'Remove this row from the transfer list?' : removing ? 'Remove this connection from your workspace?' : batch ? 'This will delete all selected files and folders, including the contents of selected folders.' : request.kind === 'folder' ? 'This will delete this folder and all files and subfolders inside it.' : 'This will delete this file from your S3 storage.'}</p>
      <div className="confirmation-target">
        <div className={`confirmation-item-icon ${request.kind}`}><ItemIcon size={22} strokeWidth={1.5} /></div>
        <div className="confirmation-target-details"><strong>{request.name}</strong>{request.path && <span>{request.path}</span>}</div>
      </div>
      <div id="confirmation-consequence" className="confirmation-consequence">
        <strong>{history ? 'Completed files and S3 objects will be kept.' : removing ? 'Your files in S3 will be kept.' : 'This action cannot be undone.'}</strong>
        <p>{clearing ? 'Keep unfinished transfers (running, queued, stopped, or scanning) and remove only finished rows. Or cancel those tasks and remove every row. Transfer settings will be kept.' : history ? 'Active transfers will be cancelled before their rows are removed. Transfer settings will be kept.' : removing ? 'Saved settings and cached listings will be removed. Unfinished operations for this connection will be cancelled.' : 'Related uploads and downloads will be cancelled.'}</p>
      </div>
      <div className={`dialog-footer confirmation-footer${clearing ? ' transfer-list' : ''}`}>
        <button ref={cancel} type="button" className="button secondary" onClick={() => onAnswer(false)}>Cancel</button>
        {clearing && <button type="button" className="button secondary" onClick={() => onAnswer('keep-active')}>Keep tasks and clear finished</button>}
        <button type="button" className="button destructive" onClick={() => onAnswer(true)}>{action}</button>
      </div>
    </div>
  </div>;
}
