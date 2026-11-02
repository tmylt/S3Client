import { Copy, X } from 'lucide-react';
import type { Connection, Entry } from '../../../shared/types';
import { fileKind, formatBytes, formatDate } from '../model';
import { EntryIcon } from './EntryIcon';
import { uriLabel } from '../../../shared/storage-uri';

export function Inspector({ entry, connection, onClose, onCopy }: { entry?: Entry; connection: Connection; onClose(): void; onCopy(): void }) {
  return <aside className="inspector" aria-label="Item information"><div className="inspector-heading">Information<button className="icon-button" aria-label="Close information" onClick={onClose}><X size={15} /></button></div>
    {entry ? <><div className="inspector-preview"><EntryIcon entry={entry} size={68} /></div><h2 className="inspector-name">{entry.name || '(empty name)'}</h2><p className="inspector-kind">{fileKind(entry)}{entry.kind === 'file' && ` · ${formatBytes(entry.size)}`}</p><dl><dt>Bucket</dt><dd>{connection.bucket}</dd><dt>Object key</dt><dd className="object-key">{entry.key}</dd><dt>Modified</dt><dd>{formatDate(entry.modified, true)}</dd>{entry.storageClass && <><dt>Storage class</dt><dd>{entry.storageClass}</dd></>}<dt>Connection</dt><dd>{connection.name}</dd></dl><button className="button secondary copy-uri" onClick={onCopy}><Copy size={14} />Copy {uriLabel(connection)}</button></> : <div className="inspector-placeholder"><EntryIcon entry={{ kind: 'file', name: '' }} size={42} /><p>Select an item to see its details.</p></div>}
  </aside>;
}
