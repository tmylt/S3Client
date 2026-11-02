import type { EntryTarget } from '../shared/types';

/** Renderer selections are untrusted; keep bulk operations bounded and unambiguous. */
export function validateEntryTargets(value: unknown): EntryTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new Error('Invalid entry selection. Select 1 to 1,000 items.');
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' ||
      typeof item.key !== 'string' || !item.key || item.key.length > 8192 || item.key.includes('\0') ||
      (item.kind !== 'file' && item.kind !== 'folder') || seen.has(item.key)) throw new Error('Invalid entry selection.');
    seen.add(item.key);
    return { key: item.key, kind: item.kind };
  });
}
