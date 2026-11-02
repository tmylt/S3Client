import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Cloud, Copy, Folder, FolderOpen, GripVertical, HardDrive, LoaderCircle, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Connection } from '../../../shared/types';
import { storageUri } from '../../../shared/storage-uri';
import type { NodeState } from '../useBrowser';
import { nodeKey, type Location } from '../model';

interface Props {
  connections: Connection[];
  nodes: Record<string, NodeState>;
  expanded: Set<string>;
  location?: Location;
  onSelect(location: Location): void;
  onToggle(id: string, prefix: string): void;
  onRefresh(id: string, prefix: string): void;
  onAdd(): void;
  onEdit(connection: Connection): void;
  onCopy(connection: Connection): void;
  onReorder(ids: string[]): Promise<void>;
  onRemove(connection: Connection): void;
}

export function Sidebar(props: Props) {
  const [menu, setMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [reordering, setReordering] = useState(false);
  const draggedId = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenu(null); menuTrigger.current?.focus(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        event.preventDefault();
      }
    };
    document.addEventListener('click', close); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', key); };
  }, [menu]);

  const clearDrag = () => { draggedId.current = null; setDragging(null); setDropTarget(null); };
  const dropConnection = (sourceId: string, targetId: string, after: boolean) => {
    const ids = props.connections.map(item => item.id);
    const sourceIndex = ids.indexOf(sourceId);
    if (sourceIndex < 0 || sourceId === targetId) return;
    ids.splice(sourceIndex, 1);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(targetIndex + (after ? 1 : 0), 0, sourceId);
    if (ids.every((id, index) => id === props.connections[index].id)) return;
    setReordering(true);
    void props.onReorder(ids).finally(() => setReordering(false));
  };

  const renderNode = (connection: Connection, prefix: string, name: string, depth: number, root: boolean): React.ReactNode => {
    const key = nodeKey(connection.id, prefix);
    const state = props.nodes[key];
    const open = props.expanded.has(key);
    const selected = props.location?.connectionId === connection.id && props.location.prefix === prefix;
    const Icon = root ? HardDrive : open ? FolderOpen : Folder;
    return <div key={key}>
      <div className={`tree-row ${selected ? 'selected' : ''} ${root ? 'root-node' : ''} ${dragging === connection.id && root ? 'dragging' : ''} ${root && dropTarget?.id === connection.id ? dropTarget.after ? 'drop-after' : 'drop-before' : ''}`} style={{ paddingLeft: 9 + depth * 17 }} draggable={root && !reordering}
        onDragStart={root ? event => { draggedId.current = connection.id; setDragging(connection.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', connection.name); } : undefined}
        onDragOver={root ? event => { if (!draggedId.current || draggedId.current === connection.id || reordering) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const after = event.clientY >= event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2; setDropTarget(current => current?.id === connection.id && current.after === after ? current : { id: connection.id, after }); } : undefined}
        onDrop={root ? event => { const sourceId = draggedId.current; if (!sourceId || sourceId === connection.id || reordering) return; event.preventDefault(); const after = event.clientY >= event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2; clearDrag(); dropConnection(sourceId, connection.id, after); } : undefined}
        onDragEnd={root ? clearDrag : undefined}>
        {root && <GripVertical size={12} className="tree-drag-handle" aria-hidden="true" />}
        <button className="tree-toggle" onClick={() => props.onToggle(connection.id, prefix)} aria-label={`${open ? 'Collapse' : 'Expand'} ${name}`} aria-expanded={open}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
        <button className="tree-select" onClick={() => props.onSelect({ connectionId: connection.id, prefix })} aria-current={selected ? 'location' : undefined} title={root ? `${connection.endpoint}\n${storageUri(connection, prefix)}` : storageUri(connection, prefix)}><Icon size={17} className={root ? 'drive-icon' : 'folder-icon'} fill={root ? 'none' : 'currentColor'} strokeWidth={1.5} /><span>{name || '(empty name)'}</span>{root && !connection.hasCredentials && <span className="credential-dot" title="Re-enter credentials to connect" />}</button>
        <button className={`icon-button tree-refresh ${state?.loading ? 'busy' : ''}`} aria-label={`Refresh ${name}`} title="Refresh from S3" onClick={() => props.onRefresh(connection.id, prefix)} disabled={state?.loading}>{state?.loading ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={12} />}</button>
        {root && <button className="icon-button tree-more" aria-label={`Manage ${name}`} aria-haspopup="menu" aria-expanded={menu === connection.id} onClick={event => { event.stopPropagation(); menuTrigger.current = event.currentTarget; setMenu(menu === connection.id ? null : connection.id); }}><MoreHorizontal size={15} /></button>}
      </div>
      {root && menu === connection.id && <div className="connection-menu" role="menu" ref={menuRef}>
        <button role="menuitem" onClick={() => { setMenu(null); props.onEdit(connection); }}><Pencil size={14} />Edit connection</button>
        <button role="menuitem" onClick={() => { setMenu(null); props.onCopy(connection); }}><Copy size={14} />Copy connection</button>
        <button role="menuitem" className="danger" onClick={() => { setMenu(null); props.onRemove(connection); }}><Trash2 size={14} />Remove connection</button>
      </div>}
      {open && <div className="tree-children">
        {(state?.folders ?? state?.entries.filter(entry => entry.kind === 'folder') ?? []).map(entry => renderNode(connection, entry.key, entry.name, depth + 1, false))}
        {state?.error && <div className="tree-notice error" style={{ paddingLeft: 31 + depth * 17 }} title={state.error}>Couldn’t load folders <button onClick={() => props.onRefresh(connection.id, prefix)}>Retry</button></div>}
        {!state?.error && state?.loaded && !state.loading && !state.nextToken && !(state.folders ?? state.entries.filter(entry => entry.kind === 'folder')).length && <div className="tree-notice" style={{ paddingLeft: 31 + depth * 17 }}>No subfolders</div>}
      </div>}
    </div>;
  };

  return <>
    <div className="brand"><div className="brand-icon"><Cloud size={22} strokeWidth={1.7} /></div><span>S3 Client<span className="brand-caption">Your storage, organized.</span></span></div>
    <div className="sidebar-heading"><span>CONNECTIONS</span><button className="icon-button" onClick={props.onAdd} aria-label="Add connection" title="Add connection"><Plus size={15} /></button></div>
    <nav className="tree" aria-label="Storage connections">{props.connections.map(connection => renderNode(connection, connection.prefix, connection.name, 0, true))}{props.connections.length === 0 && <div className="sidebar-empty">Your S3 connections<br />will appear here.</div>}</nav>
    <div className="sidebar-bottom"><button className="add-connection" onClick={props.onAdd}><Plus size={16} />Add connection</button><div className="sidebar-footnote"><span className="status-dot" />S3-compatible storage<span>{props.connections.length}</span></div></div>
  </>;
}
