import { useEffect, useRef } from 'react';
import { Copy, FileText, Link, MapPin } from 'lucide-react';

interface Props {
  x: number;
  y: number;
  onCopyLocalPath(): void;
  onCopyUri(): void;
  onCopyLocalName(): void;
  onCopyKey(): void;
  onClose(restoreFocus: boolean): void;
}

export function TransferCopyMenu({ x, y, onCopyLocalPath, onCopyUri, onCopyLocalName, onCopyKey, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(false); };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(true); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || []);
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
  return <div ref={menu} className="row-copy-menu" role="menu" aria-label="Transfer copy actions" style={{ left: Math.max(8, Math.min(x, window.innerWidth - 196)), top: Math.max(8, Math.min(y, window.innerHeight - 158)) }}>
    <button role="menuitem" onClick={() => choose(onCopyLocalPath)}><MapPin size={14} />Copy local file path</button>
    <button role="menuitem" onClick={() => choose(onCopyUri)}><Link size={14} />Copy S3 URI</button>
    <button role="menuitem" onClick={() => choose(onCopyLocalName)}><FileText size={14} />Copy local file name</button>
    <button role="menuitem" onClick={() => choose(onCopyKey)}><Copy size={14} />Copy S3 key</button>
  </div>;
}
