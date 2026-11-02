import { useCallback, useEffect, useRef, useState } from 'react';
import type { Entry, FolderStats, RemoteSearchRange, SearchMatch, SearchRange } from '../../shared/types';
import { getVisibleEntries, type SortColumn, type SortDirection } from './model';
import { defaultPageSize, isPageSize } from '../../shared/page-size';

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

export function useFileSearch(connectionId?: string, prefix?: string, pageSize = defaultPageSize, onPageSizeChange?: (size: number) => void) {
  const [range, setRangeState] = useState<SearchRange>('folder');
  const [match, setMatchState] = useState<SearchMatch>('exact');
  const [query, setQueryState] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [recursivePage, setRecursivePage] = useState(0);
  const sequence = useRef(0);

  const invalidate = useCallback(() => {
    sequence.current++;
    setResult(null);
    setError('');
    setLoading(false);
    setRecursivePage(0);
  }, []);

  useEffect(() => { setQueryState(''); invalidate(); }, [connectionId, prefix, invalidate]);
  const setRange = useCallback((value: SearchRange) => { setRangeState(value); if (value === 'key') setMatchState('exact'); invalidate(); }, [invalidate]);
  const setMatch = useCallback((value: SearchMatch) => { setMatchState(value); invalidate(); }, [invalidate]);
  const setQuery = useCallback((value: string) => { setQueryState(value); invalidate(); }, [invalidate]);
  const activeResult = result?.connectionId === connectionId && result?.prefix === prefix && result?.range === range && result?.match === match && result?.name === query ? result : null;

  const fetch = useCallback(async (searchRange: RemoteSearchRange, searchMatch: SearchMatch, name: string, size: number, index: number, token: string | null, tokens: (string | null)[]) => {
    if (!connectionId || prefix === undefined) return;
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
  }, [connectionId, prefix]);

  const submit = useCallback(() => {
    if (range === 'page' || !query) return;
    if ((range !== 'key' && query.includes('/')) || query.includes('\0')) { invalidate(); setError(range === 'key' ? 'Enter a valid S3 key.' : 'Enter a file name without a slash.'); return; }
    setResult(null);
    setRecursivePage(0);
    void fetch(range, match, query, pageSize, 0, null, [null]);
  }, [range, match, query, pageSize, fetch, invalidate]);

  const next = useCallback(() => {
    if (!activeResult || loading) return;
    if (range === 'recursive' || match === 'contains') { setRecursivePage(page => page + 1); return; }
    if (range === 'folder' && match === 'prefix' && activeResult.nextToken) void fetch(range, match, query, pageSize, activeResult.pageIndex + 1, activeResult.nextToken, [...activeResult.tokens, activeResult.nextToken]);
  }, [activeResult, loading, range, match, fetch, query, pageSize]);

  const previous = useCallback(() => {
    if (!activeResult || loading) return;
    if (range === 'recursive' || match === 'contains') { setRecursivePage(page => Math.max(0, page - 1)); return; }
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

  const sorted = useCallback((column: SortColumn, direction: SortDirection) => getVisibleEntries(activeResult?.entries || [], '', column, direction), [activeResult]);
  const displayEntries = useCallback((column: SortColumn, direction: SortDirection) => {
    const entries = sorted(column, direction);
    return range === 'recursive' || match === 'contains' ? entries.slice(recursivePage * pageSize, (recursivePage + 1) * pageSize) : entries;
  }, [sorted, range, match, recursivePage, pageSize]);
  const locallyPaged = range === 'recursive' || match === 'contains';
  const hasNext = locallyPaged ? (recursivePage + 1) * pageSize < (activeResult?.entries.length || 0) : Boolean(activeResult?.nextToken);
  const pageIndex = locallyPaged ? recursivePage : activeResult?.pageIndex ?? 0;
  const active = range !== 'page' && Boolean(query) && (Boolean(activeResult) || loading || Boolean(error));

  return { range, match, query, setRange, setMatch, setQuery, submit, active, result: activeResult, error, loading, pageSize, pageIndex, hasNext, next, previous, setPageSize, displayEntries, invalidate, setEntryStats };
}
