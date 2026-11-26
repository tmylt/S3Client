import type { Entry, EntryTarget } from './types';

/** A deleted folder also removes its descendants from a recursive search result. */
export function withoutDeletedEntries(entries: readonly Entry[], deleted: readonly EntryTarget[]): Entry[] {
  return entries.filter(entry => !deleted.some(target => target.kind === 'folder' ? entry.key.startsWith(target.key) : entry.key === target.key));
}
