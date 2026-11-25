import { expect, it } from 'vitest';
import { availableSearchRanges, isSearchAllowed, resolveSearchMode } from '../src/shared/search-options';

it('removes Full S3 key when Exact is disabled and chooses an allowed mode', () => {
  const options = { ranges: ['folder', 'key'] as const, matches: ['regex'] as const };
  expect(availableSearchRanges(options)).toEqual(['folder']);
  expect(isSearchAllowed(options, 'key', 'exact')).toBe(false);
  expect(resolveSearchMode(options, 'key', 'exact')).toEqual({ range: 'folder', match: 'regex' });
});

it('keeps the current mode when allowed and reports no mode when search is disabled', () => {
  const options = { ranges: ['page', 'folder'] as const, matches: ['prefix', 'exact'] as const };
  expect(resolveSearchMode(options, 'page', 'prefix')).toEqual({ range: 'page', match: 'prefix' });
  expect(resolveSearchMode(options, 'recursive', 'contains')).toEqual({ range: 'folder', match: 'exact' });
  expect(resolveSearchMode({ ranges: ['key'] as const, matches: ['regex'] as const }, 'key', 'exact')).toBeNull();
  expect(resolveSearchMode({ ranges: [] as const, matches: ['exact'] as const }, 'folder', 'exact')).toBeNull();
});
