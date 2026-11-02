import type { Entry, FolderStats } from './types';

export function parseFolderStats(value: unknown): FolderStats {
  const invalid = () => new Error('The S3 worker returned invalid folder statistics.');
  if (!value || typeof value !== 'object') throw invalid();
  const stats = value as FolderStats;
  for (const number of [stats.fileCount, stats.totalSize, stats.durationMs]) if (!Number.isSafeInteger(number) || number < 0) throw invalid();
  if (typeof stats.updatedAt !== 'string' || stats.updatedAt.length > 200 || !Number.isFinite(Date.parse(stats.updatedAt))) throw invalid();
  return { fileCount: stats.fileCount, totalSize: stats.totalSize, updatedAt: stats.updatedAt, durationMs: stats.durationMs };
}

export function mergeEntryStats(entries: Entry[], previous: Entry[]): Entry[] {
  const known = new Map<string, FolderStats>();
  for (const entry of previous) if (entry.kind === 'folder' && entry.stats) {
    const current = known.get(entry.key);
    if (!current || Date.parse(current.updatedAt) <= Date.parse(entry.stats.updatedAt)) known.set(entry.key, entry.stats);
  }
  return entries.map(entry => {
    if (entry.kind !== 'folder') return { ...entry };
    const saved = known.get(entry.key);
    const stats = !entry.stats || saved && Date.parse(saved.updatedAt) > Date.parse(entry.stats.updatedAt) ? saved : entry.stats;
    return { ...entry, ...(stats ? { stats: { ...stats } } : {}) };
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}
