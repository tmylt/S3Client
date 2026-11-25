import type { SearchMatch, SearchOptions, SearchRange } from './types';

export const searchRanges: SearchRange[] = ['page', 'folder', 'recursive', 'key'];
export const searchMatches: SearchMatch[] = ['prefix', 'contains', 'exact', 'regex'];

function normalizeList<T extends string>(value: unknown, allowed: readonly T[], label: string): T[] {
  if (value === undefined) return [...allowed];
  if (!Array.isArray(value) || value.length > allowed.length || value.some(item => !allowed.includes(item)) || new Set(value).size !== value.length) {
    throw new Error(`Invalid connection search ${label}.`);
  }
  return allowed.filter(item => value.includes(item));
}

export function normalizeSearchOptions(value: unknown): SearchOptions {
  if (value === undefined) return { ranges: [...searchRanges], matches: [...searchMatches] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection search options.');
  const input = value as Partial<SearchOptions>;
  return { ranges: normalizeList(input.ranges, searchRanges, 'ranges'), matches: normalizeList(input.matches, searchMatches, 'match types') };
}

type SearchOptionsLike = { readonly ranges: readonly SearchRange[]; readonly matches: readonly SearchMatch[] };

export function availableSearchRanges(options: SearchOptionsLike): SearchRange[] {
  return options.ranges.filter(range => range !== 'key' || options.matches.includes('exact'));
}

export function isSearchAllowed(options: SearchOptionsLike, range: SearchRange, match: SearchMatch): boolean {
  return options.ranges.includes(range) && options.matches.includes(match) && (range !== 'key' || match === 'exact');
}

export function resolveSearchMode(options: SearchOptionsLike, currentRange: SearchRange, currentMatch: SearchMatch): { range: SearchRange; match: SearchMatch } | null {
  const ranges = availableSearchRanges(options);
  if (!ranges.length || !options.matches.length) return null;
  const range = ranges.includes(currentRange) ? currentRange : ranges.includes('folder') ? 'folder' : ranges[0];
  if (range === 'key') return { range, match: 'exact' };
  const match = options.matches.includes(currentMatch) ? currentMatch : options.matches.includes('exact') ? 'exact' : options.matches[0];
  return { range, match };
}
