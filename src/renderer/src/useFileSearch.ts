import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Entry, EntryTarget, FolderStats, RemoteSearchRange, SearchMatch, SearchOptions, SearchRange } from '../../shared/types';
import { getVisibleEntries, type SortColumn, type SortDirection } from './model';
import { defaultPageSize, isPageSize } from '../../shared/page-size';
import { compileSearchRegex } from '../../shared/search-regex';
import { availableSearchRanges, isSearchAllowed, normalizeSearchOptions, resolveSearchMode } from '../../shared/search-options';
import { withoutDeletedEntries } from '../../shared/deleted-entries';

interface Result {
  connectionId: string;
  prefix: string;
  range: RemoteSearchRange;
  match: SearchMatch;
  name: string;
  entries: Entry[];
  nextToken: string | null;
  pageIndex: number;
  tokens: (string | null)[];
}

export function useFileSearch(connectionId?: string, prefix?: string, pageSize = defaultPageSize, onPageSizeChange?: (size: number) => void, searchOptions?: SearchOptions) {
  const policyKey = JSON.stringify(searchOptions ?? null);
  const allowed = useMemo(() => normalizeSearchOptions(searchOptions), [policyKey]);
  const [rangeState, setRangeState] = useState<SearchRange>('folder');
  const [matchState, setMatchState] = useState<SearchMatch>('exact');
  const mode = resolveSearchMode(allowed, rangeState, matchState);
  const range = mode?.range ?? 'folder';
  const match = mode?.match ?? 'exact';
  const available = mode !== null;
  const availableRanges = availableSearchRanges(allowed);
  const availableMatches = range === 'key' ? allowed.matches.filter(value => value === 'exact') : allowed.matches;
  const [query, setQueryState] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recursivePage, setRecursivePage] = useState(0);
  const sequence = useRef(0);
  const patternError = useMemo(() => {
    if (match !== 'regex' || !query) return '';
    try { compileSearchRegex(query); return ''; }
    catch (cause) { return cause instanceof Error ? cause.message : 'Invalid regex pattern.'; }
  }, [match, query]);

  const invalidate = useCallback(() => {
    sequence.current++;
    setResult(null);
    setError('');
    setLoading(false);
    setRecursivePage(0);
  }, []);

  useEffect(() => { setQueryState(''); invalidate(); }, [connectionId, prefix, policyKey, invalidate]);
  const setRange = useCallback((value: SearchRange) => { if (!availableSearchRanges(allowed).includes(value)) return; setRangeState(value); if (value === 'key') setMatchState('exact'); invalidate(); }, [allowed, invalidate]);
  const setMatch = useCallback((value: SearchMatch) => { if (!allowed.matches.includes(value) || (range === 'key' && value !== 'exact')) return; setMatchState(value); invalidate(); }, [allowed, range, invalidate]);
  const setQuery = useCallback((value: string) => { setQueryState(value); invalidate(); }, [invalidate]);
  const activeResult = result?.connectionId === connectionId && result?.prefix === prefix && result?.range === range && result?.match === match && result?.name === query ? result : null;

  const fetch = useCallback(async (searchRange: RemoteSearchRange, searchMatch: SearchMatch, name: string, size: number, index: number, token: string | null, tokens: (string | null)[]) => {
    if (!connectionId || prefix === undefined || !isSearchAllowed(allowed, searchRange, searchMatch)) return;
    const ticket = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const listing = await window.s3.search(connectionId, prefix, searchRange, searchMatch, name, size, token);
      if (sequence.current !== ticket) return;
      setResult({ connectionId, prefix, range: searchRange, match: searchMatch, name, entries: listing.entries, nextToken: listing.nextToken ?? null, pageIndex: index, tokens });
    } catch (cause) {
      if (sequence.current !== ticket) return;
      setResult(null);
      setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to search this folder.');
    } finally { if (sequence.current === ticket) setLoading(false); }
  }, [connectionId, prefix, allowed]);

  const submit = useCallback(() => {
    if (!available || range === 'page' || !query || patternError) return;
    if ((range !== 'key' && match !== 'regex' && query.includes('/')) || query.includes('\0')) { invalidate(); setError(range === 'key' ? 'Enter a valid S3 key.' : 'Enter a file name without a slash.'); return; }
    setResult(null);
    setRecursivePage(0);
    void fetch(range, match, query, pageSize, 0, null, [null]);
  }, [available, range, match, query, patternError, pageSize, fetch, invalidate]);

  const next = useCallback(() => {
    if (!activeResult || loading) return;
    if (range === 'recursive' || match === 'contains' || match === 'regex') { setRecursivePage(page => page + 1); return; }
    if (range === 'folder' && match === 'prefix' && activeResult.nextToken) void fetch(range, match, query, pageSize, activeResult.pageIndex + 1, activeResult.nextToken, [...activeResult.tokens, activeResult.nextToken]);
  }, [activeResult, loading, range, match, fetch, query, pageSize]);

  const previous = useCallback(() => {
    if (!activeResult || loading) return;
    if (range === 'recursive' || match === 'contains' || match === 'regex') { setRecursivePage(page => Math.max(0, page - 1)); return; }
    if (range === 'folder' && match === 'prefix' && activeResult.pageIndex > 0) void fetch(range, match, query, pageSize, activeResult.pageIndex - 1, activeResult.tokens[activeResult.pageIndex - 1] ?? null, activeResult.tokens.slice(0, activeResult.pageIndex));
  }, [activeResult, loading, range, match, fetch, query, pageSize]);

  const setPageSize = useCallback((size: number) => {
    if (!isPageSize(size) || size === pageSize) return;
    onPageSizeChange?.(size);
    if (activeResult?.range === 'folder' && activeResult.match === 'prefix') void fetch('folder', 'prefix', query, size, 0, null, [null]);
    else setRecursivePage(0);
  }, [activeResult, fetch, onPageSizeChange, pageSize, query]);

  const setEntryStats = useCallback((id: string, key: string, stats: FolderStats) => {
    setResult(current => current?.connectionId === id ? { ...current, entries: current.entries.map(entry => entry.kind === 'folder' && entry.key === key ? { ...entry, stats } : entry) } : current);
  }, []);

  const removeEntries = useCallback((id: string, folder: string, deleted: EntryTarget[]) => {
    setResult(current => {
      if (!current || current.connectionId !== id || current.prefix !== folder || !deleted.length) return current;
      const entries = withoutDeletedEntries(current.entries, deleted);
      return entries.length === current.entries.length ? current : { ...current, entries };
    });
  }, []);

  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil((activeResult?.entries.length ?? 0) / pageSize) - 1);
    setRecursivePage(current => current > lastPage ? lastPage : current);
  }, [activeResult?.entries.length, pageSize]);

  const sorted = useCallback((column: SortColumn, direction: SortDirection) => getVisibleEntries(activeResult?.entries || [], '', column, direction), [activeResult]);
  const displayEntries = useCallback((column: SortColumn, direction: SortDirection) => {
    const entries = sorted(column, direction);
    return range === 'recursive' || match === 'contains' || match === 'regex' ? entries.slice(recursivePage * pageSize, (recursivePage + 1) * pageSize) : entries;
  }, [sorted, range, match, recursivePage, pageSize]);
  const locallyPaged = range === 'recursive' || match === 'contains' || match === 'regex';
  const hasNext = locallyPaged ? (recursivePage + 1) * pageSize < (activeResult?.entries.length || 0) : Boolean(activeResult?.nextToken);
  const pageIndex = locallyPaged ? recursivePage : activeResult?.pageIndex ?? 0;
  const active = available && range !== 'page' && Boolean(query) && (Boolean(activeResult) || loading || Boolean(error));

  return { range, match, available, availableRanges, availableMatches, query, patternError, setRange, setMatch, setQuery, submit, active, result: activeResult, error, loading, pageSize, pageIndex, hasNext, next, previous, setPageSize, displayEntries, invalidate, setEntryStats, removeEntries };
}
