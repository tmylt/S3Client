import { useEffect, useRef } from 'react';
import { Copy, FileText, FolderInput, Link, Pencil } from 'lucide-react';
import type { Entry } from '../../../shared/types';

interface Props {
  entry: Entry;
  x: number;
  y: number;
  onCopyUri(): void;
  onCopyKey(): void;
  onCopyName(): void;
  onCopyTo(): void;
  canCopyTo: boolean;
  onRename(): void;
  canRename: boolean;
  onClose(restoreFocus: boolean): void;
}

export function RowCopyMenu({ entry, x, y, onCopyUri, onCopyKey, onCopyName, onCopyTo, canCopyTo, onRename, canRename, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(false); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        event.preventDefault();
      }
    };
    const close = () => onClose(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  const choose = (action: () => void) => { onClose(true); action(); };
  return <div ref={menu} className="row-copy-menu" role="menu" aria-label={`${entry.kind === 'folder' ? 'Folder' : 'File'} actions`} style={{ left: Math.max(8, Math.min(x, window.innerWidth - 196)), top: Math.max(8, Math.min(y, window.innerHeight - 208)) }}>
    <button role="menuitem" onClick={() => choose(onCopyUri)}><Link size={14} />Copy URI</button>
    <button role="menuitem" onClick={() => choose(onCopyKey)}><Copy size={14} />Copy S3 key</button>
    <button role="menuitem" onClick={() => choose(onCopyName)}><FileText size={14} />Copy {entry.kind === 'folder' ? 'folder' : 'file'} name</button>
    <button role="menuitem" disabled={!canCopyTo} title={!canCopyTo ? 'Enable uploads for this connection to copy objects' : undefined} onClick={() => choose(onCopyTo)}><FolderInput size={14} />Copy to…</button>
    <button role="menuitem" disabled={!canRename} title={!canRename ? 'Enable uploads and deletes for this connection to rename objects' : undefined} onClick={() => choose(onRename)}><Pencil size={14} />Rename…</button>
  </div>;
}
