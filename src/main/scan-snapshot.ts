import { randomUUID } from 'node:crypto';
import type { Entry, FolderStats, Listing } from '../shared/types';

export interface ScannedObject { key: string; size: number; modified: string | null; storageClass?: string }

/** The recursive scan already has every object. Group it into delimiter-style pages. */
export class ScanSnapshot {
  readonly token = randomUUID();
  private readonly directories = new Map<string, Entry[]>();

  constructor(readonly root: string, objects: ScannedObject[], scanned: FolderStats) {
    this.directories.set(root, []);
    const seen = new Map<string, Set<string>>();
    const totals = new Map<string, { fileCount: number; totalSize: number; latestModified: string | null }>();
    const add = (parent: string, entry: Entry) => {
      const keys = seen.get(parent) ?? new Set<string>();
      if (!keys.has(entry.key)) {
        this.directories.get(parent)!.push(entry);
        keys.add(entry.key);
        seen.set(parent, keys);
      }
    };
    for (const object of objects) {
      if (!object.key.startsWith(root) || object.key === root) continue;
      const relative = object.key.slice(root.length);
      let parent = root;
      let index = 0;
      while (true) {
        const slash = relative.indexOf('/', index);
        if (slash < 0) break;
        const key = root + relative.slice(0, slash + 1);
        add(parent, { key, name: relative.slice(index, slash), kind: 'folder', size: null, modified: null });
        if (!this.directories.has(key)) this.directories.set(key, []);
        if (!object.key.endsWith('/')) {
          const total = totals.get(key) ?? { fileCount: 0, totalSize: 0, latestModified: null };
          total.fileCount++;
          total.totalSize += object.size;
          if (object.modified && (!total.latestModified || Date.parse(object.modified) > Date.parse(total.latestModified))) total.latestModified = object.modified;
          totals.set(key, total);
        }
        parent = key;
        index = slash + 1;
      }
      if (!object.key.endsWith('/')) add(parent, {
        key: object.key, name: relative.slice(index), kind: 'file', size: object.size,
        modified: object.modified, ...(object.storageClass ? { storageClass: object.storageClass } : {}),
      });
    }
    for (const entries of this.directories.values()) {
      for (const entry of entries) if (entry.kind === 'folder') entry.stats = { ...scanned, ...(totals.get(entry.key) ?? { fileCount: 0, totalSize: 0, latestModified: null }) };
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
    }
  }

  has(prefix: string): boolean { return this.directories.has(prefix); }

  page(prefix: string, pageSize: number, pageIndex: number, token: string | null): Listing {
    const offset = pageIndex * pageSize;
    if (pageIndex === 0 ? token !== null : token !== `scan:${this.token}:${offset}`) throw new Error('The scanned listing page has expired. Refresh this folder.');
    const entries = this.directories.get(prefix);
    if (!entries) throw new Error('The scanned folder is unavailable. Refresh this folder.');
    return { entries: entries.slice(offset, offset + pageSize), nextToken: offset + pageSize < entries.length ? `scan:${this.token}:${offset + pageSize}` : null };
  }
}
