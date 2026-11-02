import { useEffect, useRef, useState } from 'react';
import { maximumColumnWidth, type FileColumn, type FileColumnId } from '../useColumnWidths';

interface Props {
  column: FileColumn;
  width: number;
  onResize(id: FileColumnId, width: number, save?: boolean): void;
  onCommit(): void;
}

export function ColumnResizeHandle({ column, width, onResize, onCommit }: Props) {
  const drag = useRef<{ id: number; x: number; width: number; target: HTMLSpanElement } | null>(null);
  const [active, setActive] = useState(false);
  useEffect(() => () => {
    if (drag.current) {
      drag.current = null;
      document.documentElement.classList.remove('resizing-columns');
      onCommit();
    }
  }, [onCommit]);

  const finish = (cancel = false, pointerId?: number) => {
    const previous = drag.current;
    if (!previous || (pointerId !== undefined && pointerId !== previous.id)) return;
    drag.current = null;
    if (cancel) onResize(column.id, previous.width, false);
    document.documentElement.classList.remove('resizing-columns');
    if (previous.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
    setActive(false);
    onCommit();
  };

  return <span className={`column-resizer${active ? ' resizing' : ''}`} role="separator" tabIndex={0} aria-label={`Resize ${column.label} column`} aria-orientation="vertical" aria-valuemin={column.min} aria-valuemax={maximumColumnWidth} aria-valuenow={width} title="Drag to resize · Double-click to reset · Arrow keys to adjust"
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      drag.current = { id: event.pointerId, x: event.clientX, width, target: event.currentTarget };
      document.documentElement.classList.add('resizing-columns');
      setActive(true);
    }}
    onPointerMove={event => {
      const previous = drag.current;
      if (!previous || previous.id !== event.pointerId) return;
      event.preventDefault();
      onResize(column.id, previous.width + event.clientX - previous.x, false);
    }}
    onPointerUp={event => finish(false, event.pointerId)} onPointerCancel={event => finish(false, event.pointerId)} onLostPointerCapture={event => finish(false, event.pointerId)}
    onClick={event => event.stopPropagation()}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onResize(column.id, column.width); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && drag.current) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 50 : 10;
      onResize(column.id, event.key === 'Home' ? column.min : event.key === 'End' ? maximumColumnWidth : width + (event.key === 'ArrowRight' ? step : -step));
    }} />;
}
