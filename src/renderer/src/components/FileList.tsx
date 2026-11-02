import { ArrowDown, ArrowDownToLine, ArrowUp, ChevronRight, FileSearch, FolderOpen, LoaderCircle, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionPermissions, Entry } from '../../../shared/types';
import { fileKind, formatBytes, formatDate, type SortColumn, type SortDirection } from '../model';
import { EntryIcon } from './EntryIcon';
import type { FolderStatsState, NodeState } from '../useBrowser';
import { formatDuration } from '../../../shared/folder-stats';
import { fileColumns, useColumnWidths } from '../useColumnWidths';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { RowCopyMenu } from './RowCopyMenu';

interface Props {
  entries: Entry[];
  state?: NodeState;
  query: string;
  selected?: Entry;
  column: SortColumn;
  direction: SortDirection;
  onSort(column: SortColumn): void;
  onSelect(entry: Entry): void;
  onOpen(entry: Entry): void;
  onRefresh(): void;
  onEdit(): void;
  onUp(): void;
  onCopy(entry: Entry): void;
  onCopyKey(entry: Entry): void;
  onCopyName(entry: Entry): void;
  onCopyTo(entry: Entry): void;
  onRename(entry: Entry): void;
  onStats(entry: Entry): void;
  getStatsState(prefix: string): FolderStatsState | undefined;
  permissions: ConnectionPermissions;
  allowStats?: boolean;
  onDownload(entry: Entry): void;
  onDelete(entry: Entry): void;
  busyEntries: ReadonlySet<string>;
  checkedKeys: ReadonlySet<string>;
  selectionDisabled: boolean;
  onToggleChecked(entry: Entry): void;
  onToggleAll(): void;
}

export function FileList(props: Props) {
  const table = useRef<HTMLTableElement>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  const menuTrigger = useRef<HTMLTableRowElement | null>(null);
  const [copyMenu, setCopyMenu] = useState<{ entry: Entry; x: number; y: number } | null>(null);
  const closeCopyMenu = useCallback((restoreFocus: boolean) => { setCopyMenu(null); if (restoreFocus) menuTrigger.current?.focus(); }, []);
  const { widths, resize, persist } = useColumnWidths();
  const checkedCount = props.entries.filter(entry => props.checkedKeys.has(entry.key)).length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = checkedCount > 0 && checkedCount < props.entries.length; }, [checkedCount, props.entries.length]);
  const keyDown = (event: React.KeyboardEvent, entry: Entry, index: number) => {
    if (event.key === 'Enter') { event.preventDefault(); props.onOpen(entry); }
    if (event.key === 'Backspace') { event.preventDefault(); props.onUp(); }
    if ((event.metaKey || event.ctrlKey) && event.key === 'c') { event.preventDefault(); props.onCopy(entry); }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? props.entries.length - 1 : Math.max(0, Math.min(props.entries.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      props.onSelect(props.entries[nextIndex]);
      table.current?.querySelectorAll<HTMLTableRowElement>('tbody tr')[nextIndex]?.focus();
    }
  };

  if (!props.state) return <div className="content-state"><div className="state-icon"><FolderOpen size={34} strokeWidth={1.3} /></div><h2>Folder not loaded</h2><p>No saved listing for this folder yet. List it when you’re ready.</p><button className="button primary" onClick={props.onRefresh}><RefreshCw size={14} />List folder</button></div>;
  if (props.state.error && !props.state.loaded) return <div className="content-state" role="alert"><div className="state-icon error-icon"><TriangleAlert size={29} strokeWidth={1.4} /></div><h2>Couldn’t open this folder</h2><p>{props.state.error}</p><div className="state-actions"><button className="button secondary" onClick={props.onEdit}>Edit connection</button><button className="button primary" onClick={props.onRefresh}><RefreshCw size={14} />Try again</button></div></div>;
  if (props.state.loading && !props.state.loaded) return <div className="content-state" role="status"><LoaderCircle size={29} className="spin loading-icon" /><h2>Opening your storage…</h2><p>Listing this folder with S3.</p></div>;
  if (!props.entries.length) return <div className="content-state"><div className="state-icon">{props.query ? <FileSearch size={32} strokeWidth={1.4} /> : <FolderOpen size={34} strokeWidth={1.3} />}</div><h2>{props.query ? 'No matching items' : props.state.nextToken || props.state.pageIndex ? 'No items on this page' : 'This folder is empty'}</h2><p>{props.query ? `No names match “${props.query}” on this page.` : props.state.nextToken ? 'Continue to the next page to see more items.' : props.state.pageIndex ? 'Try the previous page.' : 'Files and folders will appear here when they’re added to S3.'}</p>{!props.query && !props.state.nextToken && !props.state.pageIndex && <button className="button secondary" onClick={props.onRefresh}><RefreshCw size={14} />Refresh folder</button>}</div>;

  return <><div className={`file-table-scroll ${props.state.loading ? 'refreshing' : ''}`} aria-busy={props.state.loading}>
    <table className="file-table" ref={table} aria-label="Folder contents" style={{ width: 44 + Object.values(widths).reduce((sum, width) => sum + width, 0) }}>
      <colgroup><col className="select-column" style={{ width: 44 }} />{fileColumns.map(column => <col key={column.id} className={`${column.id}-column`} style={{ width: widths[column.id] }} />)}<col /></colgroup>
      <thead><tr><th className="select-cell" scope="col"><input ref={selectAll} type="checkbox" aria-label="Select all on this page" checked={props.entries.length > 0 && checkedCount === props.entries.length} disabled={props.selectionDisabled} onChange={props.onToggleAll} /></th>{fileColumns.map(column => {
        const sort = 'sort' in column ? column.sort : undefined;
        return <th key={column.id} scope="col" aria-label={column.label} aria-sort={sort && props.column === sort ? props.direction === 'asc' ? 'ascending' : 'descending' : undefined}>
          {sort ? <button onClick={() => props.onSort(sort)}>{column.label}{props.column === sort && (props.direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button> : column.id !== 'actions' ? column.label : null}
          <ColumnResizeHandle column={column} width={widths[column.id]} onResize={resize} onCommit={persist} />
        </th>;
      })}<th className="column-spacer" aria-hidden="true" /></tr></thead>
      <tbody>{props.entries.map((entry, index) => {
        const scan = props.getStatsState(entry.key);
        return <tr key={entry.key} tabIndex={props.selected?.key === entry.key || (!props.selected && index === 0) ? 0 : -1} aria-selected={props.selected?.key === entry.key || props.checkedKeys.has(entry.key)} className={`${props.selected?.key === entry.key ? 'selected' : ''} ${props.checkedKeys.has(entry.key) ? 'checked' : ''} ${entry.stats ? 'has-stats' : ''}`} onClick={() => props.onSelect(entry)} onFocus={event => { if (event.target === event.currentTarget) props.onSelect(entry); }} onContextMenu={event => { event.preventDefault(); menuTrigger.current = event.currentTarget; props.onSelect(entry); setCopyMenu({ entry, x: event.clientX, y: event.clientY }); }} onDoubleClick={() => props.onOpen(entry)} onKeyDown={event => keyDown(event, entry, index)}>
          <td className="select-cell" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${entry.name || '(empty name)'}`} checked={props.checkedKeys.has(entry.key)} disabled={props.selectionDisabled} onChange={() => props.onToggleChecked(entry)} /></td>
          <td><div className="filename"><EntryIcon entry={entry} /><span title={entry.name}>{entry.name || '(empty name)'}</span>{entry.kind === 'folder' && <ChevronRight size={13} className="row-chevron" />}</div></td>
          <td className="muted modified-cell" title={formatDate(entry.modified, true)}>{formatDate(entry.modified, true)}</td>
          <td className="muted size-cell" title={entry.stats ? `${entry.stats.totalSize.toLocaleString()} bytes` : undefined}>{formatBytes(entry.stats?.totalSize ?? entry.size)}</td>
          <td className="muted size-cell">{entry.stats ? entry.stats.fileCount.toLocaleString() : '—'}</td>
          <td className="muted">{fileKind(entry)}</td>
          <td><div className="stats-updated">{entry.stats && <><time dateTime={entry.stats.updatedAt} title={formatDate(entry.stats.updatedAt, true)}>{formatDate(entry.stats.updatedAt, true)}</time><small>in {formatDuration(entry.stats.durationMs)}</small></>}{scan?.loading && <small>Calculating…</small>}{scan?.error && <small className="stats-error" title={scan.error}>Stats failed</small>}{!entry.stats && !scan?.loading && !scan?.error && '—'}</div></td>
          <td className="stats-action"><div className="row-actions" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => { if (!((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase()))) event.stopPropagation(); }}>
            {entry.kind === 'folder' && props.allowStats !== false && <button className="icon-button" aria-label={`Refresh statistics for ${entry.name || '(empty name)'}`} title={scan?.error || 'Count all files and sum sizes recursively'} disabled={scan?.loading} onClick={() => props.onStats(entry)}>{scan?.loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={13} />}</button>}
            {props.permissions.download && <button className="icon-button" aria-label={`Download ${entry.name || '(empty name)'}`} title="Download to a folder on your computer" disabled={props.busyEntries.has(entry.key)} onClick={() => props.onDownload(entry)}>{props.busyEntries.has(entry.key) ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}</button>}
            {props.permissions.delete && <button className="icon-button danger" aria-label={`Delete ${entry.name || '(empty name)'}`} title="Delete from storage" disabled={props.busyEntries.has(entry.key)} onClick={() => props.onDelete(entry)}>{props.busyEntries.has(entry.key) ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}</button>}
          </div></td>
          <td className="column-spacer" aria-hidden="true" />
        </tr>;
      })}</tbody>
    </table>
  </div>{copyMenu && <RowCopyMenu entry={copyMenu.entry} x={copyMenu.x} y={copyMenu.y} onCopyUri={() => props.onCopy(copyMenu.entry)} onCopyKey={() => props.onCopyKey(copyMenu.entry)} onCopyName={() => props.onCopyName(copyMenu.entry)} onCopyTo={() => props.onCopyTo(copyMenu.entry)} canCopyTo={props.permissions.upload && !props.busyEntries.has(copyMenu.entry.key)} onRename={() => props.onRename(copyMenu.entry)} canRename={props.permissions.upload && props.permissions.delete && !props.busyEntries.has(copyMenu.entry.key)} onClose={closeCopyMenu} />}</>;
}
