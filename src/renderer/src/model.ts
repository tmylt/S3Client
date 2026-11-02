import type { Entry } from '../../shared/types';
import type { SearchMatch } from '../../shared/types';

export interface Location { connectionId: string; prefix: string }
export interface History { entries: Location[]; index: number }
export const initialHistory: History = { entries: [], index: -1 };
export const nodeKey = (id: string, prefix: string) => JSON.stringify([id, prefix]);

export function navigateHistory(history: History, location: Location): History {
  const current = history.entries[history.index];
  if (current?.connectionId === location.connectionId && current.prefix === location.prefix) return history;
  const entries = [...history.entries.slice(0, history.index + 1), location];
  return { entries, index: entries.length - 1 };
}

export function moveHistory(history: History, direction: number): History {
  const index = history.index + direction;
  return index < 0 || index >= history.entries.length ? history : { ...history, index };
}

export function breadcrumbs(root: string, prefix: string): { name: string; prefix: string }[] {
  if (!prefix.startsWith(root) || prefix === root) return [];
  const segments = prefix.slice(root.length).split('/');
  segments.pop();
  let path = root;
  return segments.map(name => ({ name: name || '(empty name)', prefix: (path += `${name}/`) }));
}

export function parentPrefix(root: string, prefix: string): string | null {
  if (prefix === root || !prefix.startsWith(root)) return null;
  const index = prefix.slice(0, -1).lastIndexOf('/');
  return index < root.length ? root : prefix.slice(0, index + 1);
}

export type SortColumn = 'name' | 'size' | 'kind' | 'modified';
export type SortDirection = 'asc' | 'desc';
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function getVisibleEntries(entries: Entry[], query: string, column: SortColumn, direction: SortDirection, match: SearchMatch = 'contains'): Entry[] {
  const filter = query.toLocaleLowerCase();
  return entries.filter(entry => !query || (match === 'exact' ? entry.name === query : match === 'prefix' ? entry.name.startsWith(query) : entry.name.toLocaleLowerCase().includes(filter))).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    let order = 0;
    if (column === 'size') order = (a.stats?.totalSize ?? a.size ?? -1) - (b.stats?.totalSize ?? b.size ?? -1);
    else if (column === 'modified') order = (a.modified ?? '').localeCompare(b.modified ?? '');
    else if (column === 'kind') order = collator.compare(fileKind(a), fileKind(b));
    return (order || collator.compare(a.name, b.name)) * (direction === 'asc' ? 1 : -1);
  });
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes === 0) return '0 B';
  const index = Math.min(5, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${Number((bytes / 1024 ** index).toFixed(1))} ${['B', 'KB', 'MB', 'GB', 'TB', 'PB'][index]}`;
}

export function fileKind(entry: Entry): string {
  if (entry.kind === 'folder') return 'Folder';
  const extension = entry.name.includes('.') ? entry.name.split('.').pop()?.toLowerCase() : '';
  const kinds: Record<string, string> = { json: 'JSON document', csv: 'CSV document', txt: 'Text document', md: 'Markdown', parquet: 'Parquet file', pdf: 'PDF document', png: 'PNG image', jpg: 'JPEG image', jpeg: 'JPEG image', webp: 'WebP image', svg: 'SVG image', zip: 'ZIP archive', gz: 'Gzip archive', tar: 'TAR archive', mp4: 'MP4 video', mov: 'QuickTime video', py: 'Python script', js: 'JavaScript', html: 'HTML document' };
  return extension ? kinds[extension] || `${extension.toUpperCase()} file` : 'File';
}

export function formatDate(date: string | null, full = false): string {
  if (!date) return '—';
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return '—';
  return full ? value.toLocaleString() : value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
