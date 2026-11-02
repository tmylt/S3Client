import { useCallback, useEffect, useRef, useState } from 'react';
import type { SortColumn } from './model';

export const fileColumns = [
  { id: 'name', label: 'Name', width: 240, min: 140, sort: 'name' },
  { id: 'modified', label: 'Date modified', width: 160, min: 130, sort: 'modified' },
  { id: 'size', label: 'Size', width: 90, min: 65, sort: 'size' },
  { id: 'files', label: 'Files', width: 60, min: 55 },
  { id: 'kind', label: 'Kind', width: 100, min: 80, sort: 'kind' },
  { id: 'stats', label: 'Stats updated', width: 160, min: 130 },
  { id: 'actions', label: 'Item actions', width: 110, min: 110 },
] as const satisfies readonly { id: string; label: string; width: number; min: number; sort?: SortColumn }[];

export type FileColumn = typeof fileColumns[number];
export type FileColumnId = FileColumn['id'];
type Widths = Record<FileColumnId, number>;
export const maximumColumnWidth = 2000;
const storageKey = 's3-client.file-column-widths.v1';
const resetEvent = 's3-client:reset-column-widths';
const clamp = (column: FileColumn, width: number) => Math.round(Math.max(column.min, Math.min(maximumColumnWidth, width)));
const defaults = (): Widths => Object.fromEntries(fileColumns.map(column => [column.id, column.width])) as Widths;

export function resetFileColumnWidths(): void {
  try { localStorage.removeItem(storageKey); }
  catch { /* The current table can still be reset. */ }
  window.dispatchEvent(new Event(resetEvent));
}

function load(): Widths {
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value as Record<string, unknown>;
  } catch { /* Preferences are optional; corrupt/unavailable storage uses defaults. */ }
  return Object.fromEntries(fileColumns.map(column => {
    const value = saved[column.id];
    return [column.id, typeof value === 'number' && Number.isFinite(value) ? clamp(column, value) : column.width];
  })) as Widths;
}

export function useColumnWidths() {
  const [widths, setWidths] = useState(load);
  const current = useRef(widths);
  useEffect(() => {
    const reset = () => { current.current = defaults(); setWidths(current.current); };
    window.addEventListener(resetEvent, reset);
    return () => window.removeEventListener(resetEvent, reset);
  }, []);
  const persist = useCallback(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(current.current)); }
    catch { /* Resizing remains usable when local preferences cannot be saved. */ }
  }, []);
  const resize = useCallback((id: FileColumnId, width: number, save = true) => {
    const column = fileColumns.find(column => column.id === id)!;
    if (!Number.isFinite(width)) return;
    current.current = { ...current.current, [id]: clamp(column, width) };
    setWidths(current.current);
    if (save) persist();
  }, [persist]);
  return { widths, resize, persist };
}
