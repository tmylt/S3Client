import { Archive, Braces, File, FileImage, FileText, Film, Folder, Table2 } from 'lucide-react';
import type { Entry } from '../../../shared/types';

export function EntryIcon({ entry, size = 19 }: { entry: Pick<Entry, 'kind' | 'name'>; size?: number }) {
  if (entry.kind === 'folder') return <Folder size={size} className="folder-icon" strokeWidth={1.5} fill="currentColor" />;
  const ext = entry.name.split('.').pop()?.toLowerCase() || '';
  const Icon = /^(png|jpg|jpeg|webp|gif|svg)$/.test(ext) ? FileImage : /^(mp4|mov|webm|mkv)$/.test(ext) ? Film : /^(zip|gz|tar|7z)$/.test(ext) ? Archive : /^(json|js|ts|py|yaml|yml)$/.test(ext) ? Braces : /^(csv|parquet|xlsx)$/.test(ext) ? Table2 : /^(txt|md|pdf|docx)$/.test(ext) ? FileText : File;
  return <Icon size={size} className={`file-icon ${/^(json|js|ts|py|yaml|yml)$/.test(ext) ? 'code-icon' : ''}`} strokeWidth={1.5} />;
}
