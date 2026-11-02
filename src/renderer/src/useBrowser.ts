import { useCallback, useEffect, useRef, useState } from 'react';
import type { Connection, ConnectionInput, Entry } from '../../shared/types';
import { breadcrumbs, initialHistory, moveHistory, navigateHistory, nodeKey, type Location } from './model';
import { mergeEntryStats } from '../../shared/folder-stats';
import { defaultPageSize, isPageSize } from '../../shared/page-size';

export interface FolderStatsState { loading: boolean; error?: string }

export interface NodeState {
  entries: Entry[];
  folders?: Entry[];
  loading: boolean;
  error?: string;
  loaded: boolean;
  updatedAt?: Date;
  cached?: boolean;
  pageSize?: number;
  pageIndex?: number;
  nextToken?: string | null;
  tokens?: (string | null)[];
}

export function useBrowser() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [secureStorage, setSecureStorage] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [startupError, setStartupError] = useState('');
  const [history, setHistory] = useState(initialHistory);
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [expanded, setExpanded] = useState(new Set<string>());
  const [statistics, setStatistics] = useState<Record<string, FolderStatsState>>({});
  const [sessionPageSizes, setSessionPageSizes] = useState<Record<string, number>>({});
  const sessionPageSizesRef = useRef(sessionPageSizes);
  const connectionsRef = useRef(connections);
  const nodesRef = useRef(nodes);
  const requests = useRef(new Map<string, number>());
  const statsRequests = useRef(new Map<string, number>());
  const sequence = useRef(0);
  const skipStartupList = useRef(true);
  const connectionIds = useRef(new Set<string>());
  const location = history.entries[history.index];
  const locationRef = useRef(location);
  locationRef.current = location;
  const connection = connections.find(item => item.id === location?.connectionId);

  // Coordinate IPC completions before React commits their state updates.
  const updateConnections = useCallback((update: (current: Connection[]) => Connection[]) => {
    const next = update(connectionsRef.current);
    connectionsRef.current = next;
    setConnections(next);
    return next;
  }, []);

  const updateNodes = useCallback((update: (current: typeof nodes) => typeof nodes) => {
    const next = update(nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
  }, []);

  const getPageSize = useCallback((id: string) => sessionPageSizesRef.current[id] ?? connectionsRef.current.find(item => item.id === id)?.defaultPageSize ?? defaultPageSize, []);
  const changePageSize = useCallback((id: string, size: number) => {
    if (!isPageSize(size) || !connectionIds.current.has(id)) return;
    const next = { ...sessionPageSizesRef.current, [id]: size };
    sessionPageSizesRef.current = next;
    setSessionPageSizes(next);
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!window.s3) throw new Error('Open S3 Client as an Electron desktop app. Run npm run dev from the project folder.');
        const result = await window.s3.connections();
        if (!active) return;
        connectionIds.current = new Set(result.connections.map(item => item.id));
        updateNodes(() => Object.fromEntries((result.cachedListings || []).map(item => [nodeKey(item.connectionId, item.prefix), {
          entries: item.entries, folders: item.entries.filter(entry => entry.kind === 'folder'), loaded: true, loading: false, cached: true,
          updatedAt: new Date(item.updatedAt), pageSize: item.pageSize ?? 1000, pageIndex: 0, nextToken: item.nextToken ?? null, tokens: [null],
        }])));
        updateConnections(() => result.connections);
        setSecureStorage(result.secureStorage);
        if (result.connections.length) {
          const first = result.connections[0];
          setHistory(navigateHistory(initialHistory, { connectionId: first.id, prefix: first.prefix }));
          setExpanded(new Set([nodeKey(first.id, first.prefix)]));
        }
      } catch (error) { if (active) setStartupError(error instanceof Error ? error.message : 'Unable to load connections.'); }
      finally { if (active) setInitializing(false); }
    })();
    return () => { active = false; };
  }, [updateConnections, updateNodes]);

  const fetchPage = useCallback(async (connectionId: string, prefix: string, pageSize: number, pageIndex: number, token: string | null, resetFolders = false) => {
    if (!connectionIds.current.has(connectionId)) return;
    const key = nodeKey(connectionId, prefix);
    const request = ++sequence.current;
    requests.current.set(key, request);
    updateNodes(current => ({ ...current, [key]: { ...current[key], entries: current[key]?.entries || [], loaded: current[key]?.loaded || false, loading: true, error: undefined } }));
    try {
      const result = await window.s3.list(connectionId, prefix, pageSize, token, pageIndex);
      if (requests.current.get(key) !== request || !connectionIds.current.has(connectionId)) return;
      updateNodes(current => {
        const previous = current[key];
        const entries = mergeEntryStats(result.entries, previous?.entries || []);
        const folders = new Map<string, Entry>((resetFolders ? [] : previous?.folders || []).map(entry => [entry.key, entry]));
        for (const entry of entries) if (entry.kind === 'folder') folders.set(entry.key, entry);
        return { ...current, [key]: {
          entries, folders: [...folders.values()], loaded: true, loading: false, cached: false, updatedAt: new Date(),
          pageSize, pageIndex, nextToken: result.nextToken ?? null,
          tokens: pageIndex === 0 ? [null] : [...(previous?.tokens || [null]).slice(0, pageIndex), token],
        } };
      });
    } catch (error) {
      if (requests.current.get(key) !== request || !connectionIds.current.has(connectionId)) return;
      updateNodes(current => ({ ...current, [key]: { ...current[key], loading: false, cached: current[key].loaded, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to list this folder.' } }));
    }
  }, [updateNodes]);

  const load = useCallback(async (connectionId: string, prefix: string, force = false) => {
    const previous = nodesRef.current[nodeKey(connectionId, prefix)];
    const size = getPageSize(connectionId);
    if (!force && (previous?.loading || previous?.loaded && previous.pageSize === size)) return;
    await fetchPage(connectionId, prefix, size, 0, null, true);
  }, [fetchPage, getPageSize]);

  const nextPage = useCallback(async (connectionId: string, prefix: string) => {
    const current = nodesRef.current[nodeKey(connectionId, prefix)];
    if (!current?.loaded || current.loading) return;
    const size = getPageSize(connectionId);
    if (current.pageSize !== size) { await fetchPage(connectionId, prefix, size, 0, null, true); return; }
    if (!current.nextToken) return;
    await fetchPage(connectionId, prefix, size, (current.pageIndex ?? 0) + 1, current.nextToken);
  }, [fetchPage, getPageSize]);

  const previousPage = useCallback(async (connectionId: string, prefix: string) => {
    const current = nodesRef.current[nodeKey(connectionId, prefix)];
    const index = current?.pageIndex ?? 0;
    if (!current?.loaded || current.loading) return;
    const size = getPageSize(connectionId);
    if (current.pageSize !== size) { await fetchPage(connectionId, prefix, size, 0, null, true); return; }
    if (index < 1) return;
    await fetchPage(connectionId, prefix, size, index - 1, current.tokens?.[index - 1] ?? null);
  }, [fetchPage, getPageSize]);

  const setPageSize = useCallback(async (connectionId: string, prefix: string, pageSize: number) => {
    const current = nodesRef.current[nodeKey(connectionId, prefix)];
    if (!current?.loaded || current.loading || !isPageSize(pageSize) || current.pageSize === pageSize && getPageSize(connectionId) === pageSize) return;
    changePageSize(connectionId, pageSize);
    await fetchPage(connectionId, prefix, pageSize, 0, null, true);
  }, [changePageSize, fetchPage, getPageSize]);

  const scanStats = useCallback(async (id: string, prefix: string) => {
    const key = nodeKey(id, prefix);
    if (!connectionIds.current.has(id) || statsRequests.current.has(key)) return;
    const ticket = ++sequence.current;
    statsRequests.current.set(key, ticket);
    setStatistics(current => ({ ...current, [key]: { loading: true } }));
    try {
      const result = await window.s3.stats(id, prefix);
      if (statsRequests.current.get(key) !== ticket || !connectionIds.current.has(id)) return;
      updateNodes(current => Object.fromEntries(Object.entries(current).map(([cacheKey, node]) => [cacheKey, JSON.parse(cacheKey)[0] !== id ? node : {
        ...node, entries: node.entries.map(entry => entry.kind === 'folder' && entry.key === prefix ? { ...entry, stats: result } : entry),
      }])));
      setStatistics(current => ({ ...current, [key]: { loading: false } }));
      return result;
    } catch (error) {
      if (statsRequests.current.get(key) !== ticket || !connectionIds.current.has(id)) return;
      setStatistics(current => ({ ...current, [key]: { loading: false, error: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Unable to calculate folder statistics.' } }));
    } finally {
      if (statsRequests.current.get(key) === ticket) statsRequests.current.delete(key);
    }
  }, [updateNodes]);

  useEffect(() => {
    if (!location) return;
    if (skipStartupList.current) { skipStartupList.current = false; return; }
    void load(location.connectionId, location.prefix);
  }, [location?.connectionId, location?.prefix, load]);

  const navigate = useCallback((target: Location) => {
    const client = connections.find(item => item.id === target.connectionId);
    if (!client || !target.prefix.startsWith(client.prefix)) return;
    setHistory(current => navigateHistory(current, target));
    setExpanded(current => new Set([...current, nodeKey(client.id, client.prefix), ...breadcrumbs(client.prefix, target.prefix).map(item => nodeKey(client.id, item.prefix))]));
    void load(target.connectionId, target.prefix);
  }, [connections, load]);

  const toggle = useCallback((id: string, prefix: string) => {
    const key = nodeKey(id, prefix);
    if (expanded.has(key)) setExpanded(current => { const next = new Set(current); next.delete(key); return next; });
    else { setExpanded(current => new Set([...current, key])); void load(id, prefix, true); }
  }, [expanded, load]);

  const invalidate = useCallback((id: string) => {
    for (const key of requests.current.keys()) if (JSON.parse(key)[0] === id) requests.current.delete(key);
    for (const key of statsRequests.current.keys()) if (JSON.parse(key)[0] === id) statsRequests.current.delete(key);
    setStatistics(current => Object.fromEntries(Object.entries(current).filter(([key]) => JSON.parse(key)[0] !== id)));
    updateNodes(current => Object.fromEntries(Object.entries(current).filter(([key]) => JSON.parse(key)[0] !== id)));
    setExpanded(current => new Set([...current].filter(key => JSON.parse(key)[0] !== id)));
  }, [updateNodes]);

  useEffect(() => {
    return window.s3?.onStorageChanged?.(id => {
      if (!connectionIds.current.has(id)) return;
      invalidate(id);
      const selected = locationRef.current;
      if (selected?.connectionId === id) void load(id, selected.prefix, true);
    });
  }, [invalidate, load]);

  const activateConnection = useCallback((saved: Connection) => {
    const previous = connectionsRef.current.find(item => item.id === saved.id);
    if (previous && previous.defaultPageSize !== saved.defaultPageSize) {
      const next = { ...sessionPageSizesRef.current };
      delete next[saved.id];
      sessionPageSizesRef.current = next;
      setSessionPageSizes(next);
    }
    invalidate(saved.id);
    connectionIds.current.add(saved.id);
    updateConnections(current => current.some(item => item.id === saved.id) ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved]);
    setHistory(current => {
      const entries = current.entries.slice(0, current.index + 1).filter(item => item.connectionId !== saved.id);
      return navigateHistory({ entries, index: entries.length - 1 }, { connectionId: saved.id, prefix: saved.prefix });
    });
    setExpanded(current => new Set([...current, nodeKey(saved.id, saved.prefix)]));
    void load(saved.id, saved.prefix, true);
  }, [invalidate, load, updateConnections]);

  const save = useCallback(async (input: ConnectionInput) => {
    activateConnection(await window.s3.saveConnection(input));
  }, [activateConnection]);

  const copy = useCallback(async (id: string) => {
    activateConnection(await window.s3.copyConnection(id));
  }, [activateConnection]);

  const reorder = useCallback(async (ids: string[]) => {
    await window.s3.reorderConnections(ids);
    updateConnections(current => {
      const byId = new Map(current.map(item => [item.id, item]));
      return [...ids.map(id => byId.get(id)).filter((item): item is Connection => Boolean(item)), ...current.filter(item => !ids.includes(item.id))];
    });
  }, [updateConnections]);

  const remove = useCallback(async (id: string) => {
    if (!await window.s3.removeConnection(id)) return false;
    const nextSizes = { ...sessionPageSizesRef.current };
    delete nextSizes[id];
    sessionPageSizesRef.current = nextSizes;
    setSessionPageSizes(nextSizes);
    connectionIds.current.delete(id);
    invalidate(id);
    const remaining = updateConnections(current => current.filter(item => item.id !== id));
    setHistory(current => {
      const selected = current.entries[current.index];
      const entries = current.entries.filter(item => item.connectionId !== id);
      const index = entries.indexOf(selected);
      if (index >= 0) return { entries, index };
      const first = remaining[0];
      return first ? navigateHistory(initialHistory, { connectionId: first.id, prefix: first.prefix }) : initialHistory;
    });
    return true;
  }, [invalidate, updateConnections]);

  return { connections, secureStorage, initializing, startupError, history, location, connection, nodes, expanded, statistics, sessionPageSizes, changePageSize, scanStats, load, nextPage, previousPage, setPageSize, navigate, toggle, save, copy, reorder, remove, back: () => setHistory(current => moveHistory(current, -1)), forward: () => setHistory(current => moveHistory(current, 1)) };
}
